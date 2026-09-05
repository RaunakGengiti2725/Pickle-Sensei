/**
 * stress / fuzz-boundary — `POST /v1/account/bootstrap` (edge route).
 *
 * Seeded, generated requests (body / query / headers / path / method / body
 * size) against the REAL handler in-process with every upstream stubbed
 * (stress_bootstrap_fuzz_harness.ts). Each iteration is judged against an
 * oracle that predicts status, error code, and writes from the generated case
 * alone; the invariants checked on every response:
 *
 *   - bad input → one of 400/401/403/404/405/413/415/429; a 5xx only when a
 *     fault was injected into an upstream, and then exactly 503 with a
 *     generic body (no stack, no upstream detail, no keys, no internal URLs);
 *   - no PostgREST write on any rejected request beyond the identity-
 *     correcting `profiles.provider` PATCH (recorded as a note, see below);
 *   - `x-request-id` on every response, echoed only when well-formed,
 *     and matched by exactly one access-log line;
 *   - a 200 has exactly the bootstrap shape for the authenticated user;
 *   - writes are scoped (PATCH under the user's own session and id filter;
 *     credential upsert under service role, `on_conflict=user_id`, ciphertext
 *     only — never the plaintext Apple refresh token).
 *
 *   deno test -A --no-check --config deno.json stress_route_post_v1_account_bootstrap_fuzz_boundary.test.ts
 *
 *   STRESS_ITER=3200 STRESS_SEED=20260905 STRESS_OUT_DIR=/tmp/fuzz \
 *     deno test -A --no-check --config deno.json stress_route_post_v1_account_bootstrap_fuzz_boundary.test.ts
 *
 *   STRESS_REPLAY_SEED=<seed> deno test -A --no-check --config deno.json \
 *     --filter "replay one seed" stress_route_post_v1_account_bootstrap_fuzz_boundary.test.ts
 *
 * Defaults are small (STRESS_ITER=150) so the file lives in the suite; the
 * 3000+ campaign, the 1200-request per-IP budget walk and the memory-limiter
 * eviction probe (STRESS_PROBE_LIMITER_EVICTION=1) are opt-in.
 */
import { assert, assertEquals } from "@std/assert";
import {
  APPLE_CODE_MAX_LENGTH,
  awayFromWindowEdges,
  type BootedHandler,
  bootHandler,
  caseSeed,
  envInt,
  executeCase,
  fuzzUserId,
  generateCase,
  LimiterModel,
  MAX_JSON_BODY_BYTES,
  mintIdToken,
  runCampaign,
  validAppleCode,
} from "./stress_bootstrap_fuzz_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 150);
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ?? "";
const REPLAY_SEED = Deno.env.get("STRESS_REPLAY_SEED");
const PROBE_EVICTION = Deno.env.get("STRESS_PROBE_LIMITER_EVICTION") === "1";

const BOOTSTRAP_URL =
  "https://edge.fuzz.test/functions/v1/api/v1/account/bootstrap";

// Subjects 20+ are outside the campaign's pool (0..11), so the fixed budget
// walks below never share a per-user window with the seeded run. Profile
// providers by subject: n % 4 === 2 → apple, otherwise google/unknown.
const GOOGLE_USER = 21;
const APPLE_USER = 22;
const FAILURE_USER = 25;
const BUDGET_USER = 27;
const OTHER_USER = 29;

async function outDir(): Promise<string> {
  if (OUT_DIR) {
    await Deno.mkdir(OUT_DIR, { recursive: true });
    return OUT_DIR;
  }
  return await Deno.makeTempDir({ prefix: "stress-bootstrap-" });
}

async function writeJson(
  dir: string,
  name: string,
  value: unknown,
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);
let jti = 0;
const validToken = (provider: "google" | "apple", user: number): string =>
  mintIdToken(provider, {
    sub: `fz-user-${user}`,
    exp: nowSeconds() + 3600,
    iat: nowSeconds(),
    jti: `fixed-${++jti}`,
  });

interface Fired {
  response: Response;
  body: string;
  json: unknown;
}

async function fire(
  booted: BootedHandler,
  init: {
    headers: Record<string, string>;
    body?: BodyInit | null;
    method?: string;
    url?: string;
  },
): Promise<Fired> {
  booted.upstream.reset("none");
  booted.drainAccessLog();
  booted.drainConsole();
  const response = await booted.handler(
    new Request(init.url ?? BOOTSTRAP_URL, {
      method: init.method ?? "POST",
      headers: init.headers,
      body: init.body ?? null,
    }),
  );
  const body = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { response, body, json };
}

const errorCode = (fired: Fired): string | null => {
  const j = fired.json;
  if (j && typeof j === "object" && "error" in j) {
    const e = (j as { error: unknown }).error;
    if (
      e && typeof e === "object" &&
      typeof (e as { code?: unknown }).code === "string"
    ) {
      return (e as { code: string }).code;
    }
  }
  return null;
};

function streamOf(
  prefix: string,
  fill: number,
  suffix: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunk = new Uint8Array(64 * 1024).fill(0x78);
  let sent = 0;
  let phase = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (phase === 0) {
        phase = 1;
        controller.enqueue(encoder.encode(prefix));
      } else if (sent < fill) {
        const remaining = fill - sent;
        const piece = remaining >= chunk.length
          ? chunk
          : chunk.subarray(0, remaining);
        controller.enqueue(piece);
        sent += piece.length;
      } else if (phase === 1) {
        phase = 2;
        controller.enqueue(encoder.encode(suffix));
        controller.close();
      }
    },
  });
}

// ── The seeded campaign ──────────────────────────────────────────────────────

Deno.test(`stress fuzz-boundary: ${STRESS_ITER} seeded requests against POST /v1/account/bootstrap`, async () => {
  const booted = await bootHandler();
  const dir = await outDir();
  const { summary, outcomes } = await runCampaign(
    booted,
    STRESS_SEED,
    STRESS_ITER,
  );
  const table = outcomes.map((o) => ({
    i: o.iteration,
    seed: o.seed,
    labels: o.labels,
    fault: o.fault,
    constructed: o.constructed,
    constructError: o.constructError,
    expected: o.expected,
    status: o.status,
    code: o.code,
    requestId: o.requestId,
    writes: o.writes,
    sessionsMinted: o.sessionsMinted,
    appleExchanges: o.appleExchanges,
    durationMs: o.durationMs,
    notes: o.notes,
    violations: o.violations,
    replay: o.replay,
  }));
  const failures = outcomes.filter((o) => o.violations.length > 0);
  const paths = {
    summary: await writeJson(dir, "summary.json", summary),
    table: await writeJson(dir, "results.json", table),
    failures: await writeJson(dir, "failures.json", failures),
  };
  console.log(
    `[stress bootstrap fuzz] seed=${STRESS_SEED} iterations=${STRESS_ITER} executed=${summary.executed} ` +
      `unconstructible=${summary.unconstructible} violations=${summary.violations} 5xx=${summary.fiveXxSeeds.length} ` +
      `${summary.durationMs}ms → ${paths.summary}`,
  );
  console.log(
    `[stress bootstrap fuzz] status histogram ${
      JSON.stringify(summary.statusHistogram)
    }`,
  );
  console.log(
    `[stress bootstrap fuzz] notes ${JSON.stringify(summary.noteHistogram)}`,
  );
  assertEquals(summary.executed + summary.unconstructible, STRESS_ITER);
  assert(
    summary.executed >= Math.floor(STRESS_ITER * 0.9),
    `only ${summary.executed} of ${STRESS_ITER} cases were constructible`,
  );
  for (const f of failures.slice(0, 20)) {
    console.error(
      `[stress bootstrap fuzz] seed ${f.seed} ${
        f.labels.join(" ")
      } → ${f.status}: ${JSON.stringify(f.violations)}\n  ${f.replay}`,
    );
  }
  assertEquals(
    summary.violations,
    0,
    `${failures.length} seed(s) violated an invariant — see ${paths.failures}`,
  );
  // Every 5xx must be traceable to an injected upstream fault.
  for (const entry of summary.fiveXxSeeds) {
    assert(
      entry.fault !== "none",
      `seed ${entry.seed} produced ${entry.status} with no fault injected`,
    );
    assertEquals(
      entry.status,
      503,
      `seed ${entry.seed}: only 503 is an acceptable 5xx`,
    );
  }
});

Deno.test({
  name: "stress fuzz-boundary: replay one seed",
  ignore: !REPLAY_SEED,
  async fn() {
    const booted = await bootHandler();
    const seed = Number(REPLAY_SEED) >>> 0;
    const c = generateCase(seed);
    const model = new LimiterModel();
    const { outcome, responseBody } = await executeCase(booted, c, 0, model);
    console.log(
      JSON.stringify(
        {
          case: {
            ...c,
            body: c.body.kind === "text"
              ? { ...c.body, text: c.body.text.slice(0, 500) }
              : c.body.kind,
          },
          outcome,
          responseBody: responseBody.slice(0, 1000),
        },
        null,
        2,
      ),
    );
    assertEquals(outcome.violations, [], `seed ${seed} still violates`);
  },
});

// ── Deterministic boundaries the fuzzer only samples ─────────────────────────

Deno.test("stress fuzz-boundary: declared Content-Length at and past the 5,000,000-byte cap", async (t) => {
  const booted = await bootHandler();
  await t.step(
    "5,000,000 declared passes the pre-check (google → 200)",
    async () => {
      const fired = await fire(booted, {
        headers: {
          Authorization: `Bearer ${validToken("google", GOOGLE_USER)}`,
          "content-length": String(MAX_JSON_BODY_BYTES),
          "x-forwarded-for": "10.99.0.1",
        },
        body: "{}",
      });
      assertEquals(fired.response.status, 200);
    },
  );
  await t.step(
    "5,000,001 declared → 413 before auth, no upstream call, request id present",
    async () => {
      const fired = await fire(booted, {
        headers: {
          Authorization: `Bearer ${validToken("google", GOOGLE_USER)}`,
          "content-length": String(MAX_JSON_BODY_BYTES + 1),
          "x-forwarded-for": "10.99.0.1",
          "x-request-id": "declared-413",
        },
        body: "{}",
      });
      assertEquals(fired.response.status, 413);
      assertEquals(fired.response.headers.get("x-request-id"), "declared-413");
      assertEquals(booted.upstream.calls.length, 0);
      assertEquals(
        fired.body,
        JSON.stringify({ error: { message: "Request body is too large." } }),
      );
    },
  );
});

Deno.test("stress fuzz-boundary: streamed Apple body at and past the cap", async (t) => {
  const booted = await bootHandler();
  // APPLE_USER carries provider=apple already → no identity PATCH clouds the write count.
  const prefix = `{"appleAuthorizationCode":"${
    validAppleCode(APPLE_USER)
  }","pad":"`;
  const suffix = `"}`;
  await t.step(
    "exactly 5,000,000 streamed bytes → 200 and one credential upsert",
    async () => {
      const fired = await fire(booted, {
        headers: {
          Authorization: `Bearer ${validToken("apple", APPLE_USER)}`,
          "X-Apple-Revocation-Protocol": "1",
          "x-forwarded-for": "10.99.0.2",
        },
        body: streamOf(
          prefix,
          MAX_JSON_BODY_BYTES - prefix.length - suffix.length,
          suffix,
        ),
      });
      assertEquals(fired.response.status, 200, fired.body);
      assertEquals(
        booted.upstream.writes().map((w) => `${w.method} ${w.table}`),
        ["POST account_external_credentials"],
      );
    },
  );
  await t.step("5,000,001 streamed bytes → 413, zero writes", async () => {
    const fired = await fire(booted, {
      headers: {
        Authorization: `Bearer ${validToken("apple", APPLE_USER)}`,
        "X-Apple-Revocation-Protocol": "1",
        "x-forwarded-for": "10.99.0.2",
      },
      body: streamOf(
        prefix,
        MAX_JSON_BODY_BYTES - prefix.length - suffix.length + 1,
        suffix,
      ),
    });
    assertEquals(fired.response.status, 413, fired.body);
    assertEquals(booted.upstream.writes(), []);
    assertEquals(booted.upstream.appleExchanges, 0);
    assert(fired.response.headers.get("x-request-id"));
  });
});

Deno.test("stress fuzz-boundary: appleAuthorizationCode length 4095 / 4096 / 4097 and blank", async (t) => {
  const booted = await bootHandler();
  const send = (code: string, protocol: string | null) =>
    fire(booted, {
      headers: {
        Authorization: `Bearer ${validToken("apple", APPLE_USER)}`,
        "content-type": "application/json",
        "x-forwarded-for": "10.99.0.3",
        ...(protocol === null
          ? {}
          : { "X-Apple-Revocation-Protocol": protocol }),
      },
      body: JSON.stringify({ appleAuthorizationCode: code }),
    });
  await t.step(
    "4095 and 4096 chars → 200 with one credential upsert each",
    async () => {
      for (const length of [APPLE_CODE_MAX_LENGTH - 1, APPLE_CODE_MAX_LENGTH]) {
        const fired = await send(validAppleCode(APPLE_USER, length), "1");
        assertEquals(fired.response.status, 200, `${length}: ${fired.body}`);
        assertEquals(booted.upstream.writes().length, 1, `${length}`);
      }
    },
  );
  await t.step(
    "4097 chars + protocol → 400 auth.apple_authorization_code_required, no exchange, no write",
    async () => {
      const fired = await send(
        validAppleCode(APPLE_USER, APPLE_CODE_MAX_LENGTH + 1),
        "1",
      );
      assertEquals(fired.response.status, 400, fired.body);
      assertEquals(errorCode(fired), "auth.apple_authorization_code_required");
      assertEquals(booted.upstream.appleExchanges, 0);
      assertEquals(booted.upstream.writes(), []);
    },
  );
  await t.step(
    "4097 chars, legacy client (no protocol header) → 200 without a credential",
    async () => {
      const fired = await send(
        validAppleCode(APPLE_USER, APPLE_CODE_MAX_LENGTH + 1),
        null,
      );
      assertEquals(fired.response.status, 200, fired.body);
      assertEquals(booted.upstream.appleExchanges, 0);
      assertEquals(booted.upstream.writes(), []);
    },
  );
  await t.step(
    "blank / whitespace-only code + protocol → 400; protocol header values other than '1' (after header trimming) are legacy",
    async () => {
      for (const code of ["", " ", "\t\n"]) {
        const fired = await send(code, "1");
        assertEquals(fired.response.status, 400, JSON.stringify(code));
        assertEquals(
          errorCode(fired),
          "auth.apple_authorization_code_required",
        );
      }
      for (const protocol of ["1 ", " 1"]) {
        const fired = await send("", protocol);
        assertEquals(
          fired.response.status,
          400,
          `protocol ${JSON.stringify(protocol)} is trimmed by Headers`,
        );
      }
      for (const protocol of ["0", "true", "01", "1,1", "2", "yes", ""]) {
        const fired = await send("", protocol);
        assertEquals(
          fired.response.status,
          200,
          `protocol ${JSON.stringify(protocol)}: ${fired.body}`,
        );
        assertEquals(booted.upstream.writes(), []);
      }
    },
  );
  await t.step(
    "4096 non-ASCII chars (2048 emoji = 4096 UTF-16 units) reach the exchange and are refused as an unknown code",
    async () => {
      const fired = await send("😀".repeat(2048), "1");
      assertEquals(fired.response.status, 401, fired.body);
      assertEquals(errorCode(fired), "auth.apple_authorization_invalid");
      assertEquals(booted.upstream.appleExchanges, 1);
      assertEquals(booted.upstream.writes(), []);
    },
  );
});

Deno.test("stress fuzz-boundary: x-request-id accepted only at [A-Za-z0-9._-]{8,64}", async (t) => {
  const booted = await bootHandler();
  const send = (id: string) =>
    fire(booted, {
      headers: { "x-request-id": id, "x-forwarded-for": "10.99.0.4" },
      body: "{}",
    });
  await t.step("8 and 64 chars echoed", async () => {
    for (const id of ["abcd1234", "Z".repeat(64), "._-._-._", "a.b-c_d1"]) {
      const fired = await send(id);
      assertEquals(fired.response.headers.get("x-request-id"), id);
      assertEquals(fired.response.status, 401);
    }
  });
  await t.step(
    "7, 65, 4096 chars, spaces, slashes, unicode, JSON → replaced by a fresh UUID",
    async () => {
      for (
        const id of [
          "abcd123",
          "Z".repeat(65),
          "y".repeat(4096),
          "abcd efgh",
          "a/b/c/d/e/f",
          '{"evt":"x"}12345',
          "\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9\u00e9",
        ]
      ) {
        const fired = await send(id);
        const got = fired.response.headers.get("x-request-id") ?? "";
        assert(got !== id, `echoed malformed id ${JSON.stringify(id)}`);
        assert(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
            .test(got),
          got,
        );
      }
    },
  );
});

Deno.test("stress fuzz-boundary: auth-failure budget (30 / 300 s per IP) trips at the 31st and is per-IP", async () => {
  const booted = await bootHandler();
  await awayFromWindowEdges();
  const ip = "10.99.7.31";
  for (let i = 0; i < 30; i++) {
    const fired = await fire(booted, {
      headers: { Authorization: `Bearer nonsense-${i}`, "x-forwarded-for": ip },
      body: "{}",
    });
    assertEquals(fired.response.status, 401, `failure ${i + 1}`);
  }
  const tripped = await fire(booted, {
    headers: {
      Authorization: `Bearer ${validToken("google", FAILURE_USER)}`,
      "x-forwarded-for": ip,
    },
    body: "{}",
  });
  assertEquals(tripped.response.status, 429, tripped.body);
  assertEquals(errorCode(tripped), "rate_limited");
  assert(Number(tripped.response.headers.get("retry-after")) >= 1);
  assertEquals(
    booted.upstream.calls.length,
    0,
    "a tripped IP must not reach Supabase Auth",
  );
  const other = await fire(booted, {
    headers: {
      Authorization: `Bearer ${validToken("google", FAILURE_USER)}`,
      "x-forwarded-for": "10.99.7.32",
    },
    body: "{}",
  });
  assertEquals(other.response.status, 200, other.body);
});

Deno.test("stress fuzz-boundary: per-user budget (240 / 60 s) trips at the 241st bootstrap", async () => {
  const booted = await bootHandler();
  await awayFromWindowEdges();
  const user = BUDGET_USER;
  for (let i = 0; i < 240; i++) {
    const fired = await fire(booted, {
      headers: {
        Authorization: `Bearer ${validToken("google", user)}`,
        "x-forwarded-for": `10.98.${i % 8}.${(i % 200) + 1}`,
      },
      body: "{}",
    });
    assertEquals(fired.response.status, 200, `request ${i + 1}: ${fired.body}`);
  }
  const tripped = await fire(booted, {
    headers: {
      Authorization: `Bearer ${validToken("google", user)}`,
      "x-forwarded-for": "10.98.9.9",
    },
    body: "{}",
  });
  assertEquals(tripped.response.status, 429, tripped.body);
  assertEquals(errorCode(tripped), "rate_limited");
  // The token was still spent: one Supabase session was minted for a 429.
  assertEquals(booted.upstream.sessionsMinted, 1);
  assertEquals(booted.upstream.writes(), []);
  const other = await fire(booted, {
    headers: {
      Authorization: `Bearer ${validToken("google", OTHER_USER)}`,
      "x-forwarded-for": "10.98.9.9",
    },
    body: "{}",
  });
  assertEquals(other.response.status, 200, other.body);
});

Deno.test({
  name:
    "stress fuzz-boundary: per-IP budget (1,200 / 60 s) trips at the 1,201st request",
  ignore: STRESS_ITER < 1000,
  async fn() {
    const booted = await bootHandler();
    await awayFromWindowEdges();
    const ip = "10.97.0.1";
    const model = new LimiterModel();
    let userLimited = 0;
    for (let i = 0; i < 1200; i++) {
      const user = 40 + (i % 12);
      const fired = await fire(booted, {
        headers: {
          Authorization: `Bearer ${validToken("google", user)}`,
          "x-forwarded-for": ip,
        },
        body: "{}",
      });
      // Users 0..11 each see 100 requests here; earlier tests in this file may
      // have spent part of a user's 240 budget in the same minute, so a 429
      // is legitimate only as the USER budget (RateLimit-Limit: 240).
      model.incr("user", fuzzUserId(user), 60);
      if (fired.response.status === 429) {
        userLimited += 1;
        assertEquals(
          fired.response.headers.get("ratelimit-limit"),
          "240",
          `request ${i + 1}: 429 was not the user budget`,
        );
        continue;
      }
      assertEquals(
        fired.response.status,
        200,
        `request ${i + 1}: ${fired.body}`,
      );
    }
    const tripped = await fire(booted, {
      headers: {
        Authorization: `Bearer ${validToken("google", 51)}`,
        "x-forwarded-for": ip,
      },
      body: "{}",
    });
    assertEquals(tripped.response.status, 429, tripped.body);
    assertEquals(tripped.response.headers.get("ratelimit-limit"), "1200");
    assertEquals(
      booted.upstream.calls.length,
      0,
      "a tripped IP must not reach Supabase Auth",
    );
    console.log(
      `[stress bootstrap fuzz] per-IP walk: ${userLimited} of 1200 were already user-limited`,
    );
  },
});

Deno.test({
  name:
    "stress fuzz-boundary: PROBE memory limiter eviction resets a tripped auth-failure budget",
  ignore: !PROBE_EVICTION,
  async fn() {
    const booted = await bootHandler();
    await awayFromWindowEdges();
    const ip = "10.96.0.1";
    for (let i = 0; i < 30; i++) {
      const fired = await fire(booted, {
        headers: { Authorization: "Bearer nonsense", "x-forwarded-for": ip },
        body: "{}",
      });
      assertEquals(fired.response.status, 401);
    }
    const tripped = await fire(booted, {
      headers: { Authorization: "Bearer nonsense", "x-forwarded-for": ip },
      body: "{}",
    });
    assertEquals(tripped.response.status, 429);
    // 20,000 distinct IPs, each one cheap 401 → each creates an ip window and
    // an authfail window (40,000 entries > MEMORY_WINDOW_MAX = 20,000).
    const startedAt = performance.now();
    for (let i = 0; i < 20_000; i++) {
      const fired = await fire(booted, {
        headers: {
          Authorization: "Bearer nonsense",
          "x-forwarded-for": `172.16.${(i >> 8) & 255}.${i & 255}`,
        },
        body: "{}",
      });
      assertEquals(fired.response.status, 401, `flood ${i}`);
    }
    const after = await fire(booted, {
      headers: { Authorization: "Bearer nonsense", "x-forwarded-for": ip },
      body: "{}",
    });
    console.log(
      `[stress bootstrap fuzz] eviction probe: tripped IP answered ${after.response.status} after 20,000 unique-IP failures in ${
        Math.round(performance.now() - startedAt)
      }ms`,
    );
    // Characterisation (opt-in): the memory limiter clears every window at
    // MEMORY_WINDOW_MAX, so the tripped budget is gone. 429 here would mean
    // the limiter now survives the flood.
    assert(after.response.status === 401 || after.response.status === 429);
    await Deno.writeTextFile(
      `${await outDir()}/limiter_eviction_probe.json`,
      JSON.stringify(
        {
          trippedStatus: tripped.response.status,
          afterFloodStatus: after.response.status,
          floodRequests: 20_000,
        },
        null,
        2,
      ),
    );
  },
});

// Keep the seed→case mapping stable: a changed generator silently invalidates
// every recorded seed in the evidence tables.
Deno.test("stress fuzz-boundary: generator is deterministic for a seed", () => {
  const a = generateCase(caseSeed(20260905, 17));
  const b = generateCase(caseSeed(20260905, 17));
  assertEquals(
    JSON.stringify(a, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)),
    JSON.stringify(b, (_k, v) => (v instanceof Uint8Array ? Array.from(v) : v)),
  );
});
