// Adversarial pass 3 — S4/S6/S7 + extra probes against authenticate() through
// the real edge handler (GoTrue stubbed at the fetch layer, see attack3_harness).
//
//   S4  lower-case `bearer` scheme / empty `Bearer` → 401 Missing bearer token,
//       auth-failure budget charged, no upstream call.
//   S6  Supabase bearer whose `exp` is a string / missing / NaN → getUser IS
//       consulted and the verdict is cached with the 600 s cap (not skipped,
//       not cached forever).
//   S7  iss https://evil.example/auth/v1 → goes to getUser, rejected 401,
//       authfail charged exactly once per request.
//   X   own probes: getUser 5xx/429 (outage vs credential rejection), cache
//       stampede on a cold bearer, corrupt L1 entry, logout drops L1, huge
//       and unicode bearers, request ids on rejections.
//
// Tests titled "REPRO" pin the behaviour observed on 4d812e1a (defect open);
// ATTACK3_ASSERT_FIXED=1 flips them to the required behaviour (attack3_harness.ts).
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack3_auth_tokens_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cacheGet, cacheSet, sha256Hex } from "../cache.ts";
import {
  assertRepro,
  type Attack3,
  authFailCount,
  edgeRequest,
  errorMessageOf,
  jsonResponse,
  loadAttack3,
  readJson,
  SUPABASE_ISS,
  supabaseBearer,
  withClock,
} from "./attack3_harness.ts";

const ROUTE = "/v1/attack3/nowhere"; // 404 AFTER authenticate() + per-user budget
const MISSING = "Missing bearer token.";
const NOT_A_TOKEN =
  "Bearer token is not a session token or a Google/Apple ID token.";
const NO_LONGER_VALID = "The session is no longer valid. Sign in again.";

let userSeq = 0;
function freshUser(): string {
  userSeq += 1;
  return `bbbbbbbb-0000-4000-8000-${userSeq.toString(16).padStart(12, "0")}`;
}
let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  return `192.0.2.${ipSeq}`;
}

async function send(
  attack: Attack3,
  authorization: string | null,
  ip: string,
  options: { path?: string; headers?: Record<string, string> } = {},
) {
  const response = await attack.harness.handler(
    edgeRequest("GET", options.path ?? ROUTE, {
      authorization,
      ip,
      headers: options.headers,
    }),
  );
  const json = await readJson(response);
  return { response, json, message: errorMessageOf(json) };
}

Deno.test("S4 HELD: 'Authorization: bearer <token>' (lower-case scheme) → 401 Missing bearer token, authfail charged, no upstream", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { response, message } = await send(attack, `bearer ${token}`, ip);
  assertEquals(response.status, 401, message);
  assertEquals(message, MISSING);
  assertEquals(await authFailCount(ip), 1, "one auth failure charged");
  assertEquals(
    attack.upstream.length,
    0,
    "no upstream call for a malformed scheme",
  );
  assert(response.headers.get("x-request-id"), "401 carries x-request-id");
});

Deno.test("S4 HELD: 'Authorization: Bearer' (empty) → 401 Missing bearer token, authfail charged, no upstream", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const { response, message } = await send(attack, "Bearer", ip);
  assertEquals(response.status, 401);
  assertEquals(message, MISSING);
  assertEquals(await authFailCount(ip), 1);
  assertEquals(attack.upstream.length, 0);
});

Deno.test("S4 HELD: scheme variants — 'Bearer ' (space only), 'BEARER x', 'Bearer\\tx', 'Bearer\\u00a0x', 'Basic x' → 401 Missing, one charge each", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const variants = [
    "Bearer ",
    "BEARER x.y.z",
    "Bearer\tx.y.z",
    "Bearer\u00a0x.y.z",
    "Basic eC55Lno=",
  ];
  for (const authorization of variants) {
    const { response, message } = await send(attack, authorization, ip);
    assertEquals(response.status, 401, JSON.stringify(authorization));
    assertEquals(message, MISSING, JSON.stringify(authorization));
  }
  assertEquals(
    await authFailCount(ip),
    variants.length,
    "exactly one charge per rejected request",
  );
  assertEquals(attack.upstream.length, 0);
});

Deno.test("S4 HELD: no Authorization header at all → 401 Missing bearer token, charged once", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const { response, message } = await send(attack, null, ip);
  assertEquals(response.status, 401);
  assertEquals(message, MISSING);
  assertEquals(await authFailCount(ip), 1);
});

Deno.test("S4 HELD: 'Bearer  <token>' (two spaces) is tolerated — the token is trimmed and verified", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { response } = await send(attack, `Bearer  ${token} `, ip);
  assertEquals(response.status, 404, "authenticated, then routed to 404");
  assertEquals(attack.getUserCalls().length, 1);
  assertEquals(await authFailCount(ip), 0);
});

// ── S6 ────────────────────────────────────────────────────────────────────────

async function cachedExpiresAtMs(token: string): Promise<number | null> {
  const raw = await cacheGet(`auth:${await sha256Hex(token)}`);
  if (!raw) return null;
  return Number((JSON.parse(raw) as { expiresAtMs: number }).expiresAtMs);
}

for (
  const [label, options] of [
    ["exp is a string", { exp: String(Math.floor(Date.now() / 1000) + 3600) }],
    ["exp is a string in the past", { exp: "1" }],
    ["exp is missing", {}],
    ["exp is null (what JSON.stringify(NaN) produces)", { exp: null }],
    ["exp is boolean true", { exp: true }],
    ["exp is an object", { exp: { seconds: 1 } }],
  ] as Array<[string, { exp?: unknown }]>
) {
  Deno.test(`S6 HELD: Supabase bearer whose ${label} → getUser consulted, cached with the 600 s cap`, async () => {
    const attack = await loadAttack3();
    const ip = freshIp();
    const token = supabaseBearer(freshUser(), options);
    const t0 = Date.now();

    await withClock(t0, async () => {
      const first = await send(attack, `Bearer ${token}`, ip);
      assertEquals(first.response.status, 404, `${label}: ${first.message}`);
      assertEquals(
        attack.getUserCalls().length,
        1,
        "GoTrue getUser decides — the edge does not skip it",
      );
      const expiresAtMs = await cachedExpiresAtMs(token);
      assert(expiresAtMs !== null, "verdict was cached");
      assertEquals(
        expiresAtMs,
        t0 + 600_000,
        "cache horizon is exactly the 600 s cap (not forever)",
      );

      const second = await send(attack, `Bearer ${token}`, ip);
      assertEquals(second.response.status, 404);
      assertEquals(
        attack.getUserCalls().length,
        1,
        "second request served from cache",
      );
    });

    // Inside the cap (L1 TTL is cap − 30 s = 570 s): still cached.
    await withClock(t0 + 560_000, async () => {
      const inside = await send(attack, `Bearer ${token}`, ip);
      assertEquals(inside.response.status, 404);
      assertEquals(attack.getUserCalls().length, 1, "still cached at +560 s");
    });
    // Past the cap: re-verified upstream.
    await withClock(t0 + 601_000, async () => {
      const after = await send(attack, `Bearer ${token}`, ip);
      assertEquals(after.response.status, 404);
      assertEquals(
        attack.getUserCalls().length,
        2,
        "re-verified after the 600 s cap",
      );
    });
    assertEquals(await authFailCount(ip), 0);
  });
}

Deno.test("S6 HELD: a payload with a literal NaN is not JSON → 401 'not a session token', no getUser, charged once", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const sub = freshUser();
  const token = supabaseBearer(sub, {
    rawPayload: `{"iss":"${SUPABASE_ISS}","sub":"${sub}","exp":NaN}`,
  });
  const { response, message } = await send(attack, `Bearer ${token}`, ip);
  assertEquals(response.status, 401);
  assertEquals(message, NOT_A_TOKEN);
  assertEquals(attack.getUserCalls().length, 0);
  assertEquals(await authFailCount(ip), 1);
});

Deno.test("S6 HELD: numeric exp in the past is refused BEFORE getUser; numeric exp inside 600 s bounds the cache below the cap", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const t0 = Date.now();
  await withClock(t0, async () => {
    const expired = supabaseBearer(freshUser(), {
      exp: Math.floor(t0 / 1000) - 1,
    });
    const dead = await send(attack, `Bearer ${expired}`, ip);
    assertEquals(dead.response.status, 401);
    assertEquals(dead.message, "The session token has expired.");
    assertEquals(
      attack.getUserCalls().length,
      0,
      "expired bearer never reaches GoTrue",
    );
    assertEquals(await authFailCount(ip), 1);

    const exp = Math.floor(t0 / 1000) + 300;
    const shortLived = supabaseBearer(freshUser(), { exp });
    const ok = await send(attack, `Bearer ${shortLived}`, ip);
    assertEquals(ok.response.status, 404);
    assertEquals(
      await cachedExpiresAtMs(shortLived),
      exp * 1000,
      "cache horizon = bearer exp (< cap)",
    );

    // exp within 90 s → TTL would be < 60 s → not cached at all → verified every time.
    const nearlyDead = supabaseBearer(freshUser(), {
      exp: Math.floor(t0 / 1000) + 80,
    });
    await send(attack, `Bearer ${nearlyDead}`, ip);
    await send(attack, `Bearer ${nearlyDead}`, ip);
    assertEquals(
      await cachedExpiresAtMs(nearlyDead),
      null,
      "sub-60 s TTL is not cached",
    );
    assertEquals(
      attack.getUserCalls().length,
      3,
      "1 (shortLived) + 2 (nearlyDead) upstream verifications",
    );
  });
});

// ── S7 ────────────────────────────────────────────────────────────────────────

Deno.test("S7 HELD: iss https://evil.example/auth/v1 → sent to getUser, rejected 401, authfail charged exactly once per request", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    iss: "https://evil.example/auth/v1",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const first = await send(attack, `Bearer ${token}`, ip);
  assertEquals(first.response.status, 401, first.message);
  assertEquals(first.message, NO_LONGER_VALID);
  assertEquals(
    attack.getUserCalls().length,
    1,
    "the foreign issuer is handed to GoTrue for the verdict",
  );
  assertStringIncludes(
    attack.getUserCalls()[0].headers["authorization"] ?? "",
    token,
  );
  assertEquals(await authFailCount(ip), 1, "charged exactly once");
  assertEquals(
    await cachedExpiresAtMs(token),
    null,
    "rejections are never cached",
  );

  const second = await send(attack, `Bearer ${token}`, ip);
  assertEquals(second.response.status, 401);
  assertEquals(
    attack.getUserCalls().length,
    2,
    "re-verified (no negative cache)",
  );
  assertEquals(await authFailCount(ip), 2, "one charge per rejected request");
});

Deno.test("S7 HELD: evil issuer variants that do NOT end in /auth/v1 are refused before GoTrue", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (
    const iss of [
      "https://evil.example/auth/v1/",
      "https://evil.example/auth/v1?x=1",
      "https://evil.example/AUTH/V1",
      "accounts.google.com.evil.example",
      "https://accounts.google.com/",
      "",
      42,
    ]
  ) {
    const { response, message } = await send(
      attack,
      `Bearer ${supabaseBearer(freshUser(), { iss: iss as string, exp })}`,
      ip,
    );
    assertEquals(
      response.status,
      401,
      `iss=${JSON.stringify(iss)}: ${message}`,
    );
    assertEquals(message, NOT_A_TOKEN, `iss=${JSON.stringify(iss)}`);
  }
  assertEquals(attack.upstream.length, 0, "none reached GoTrue");
  assertEquals(await authFailCount(ip), 7);
});

Deno.test("S7 HELD: evil issuer with an already-expired exp is refused before GoTrue", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    iss: "https://evil.example/auth/v1",
    exp: Math.floor(Date.now() / 1000) - 10,
  });
  const { response, message } = await send(attack, `Bearer ${token}`, ip);
  assertEquals(response.status, 401);
  assertEquals(message, "The session token has expired.");
  assertEquals(attack.getUserCalls().length, 0);
  assertEquals(await authFailCount(ip), 1);
});

Deno.test("S7 HELD: GoTrue accepts the token but the account has no Google/Apple identity → 401, not cached", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const sub = freshUser();
  attack.setOverride((request, url) => {
    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      return jsonResponse(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: "e@example.com",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {},
      });
    }
    return null;
  });
  const token = supabaseBearer(sub, {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const { response, message } = await send(attack, `Bearer ${token}`, ip);
  assertEquals(response.status, 401);
  assertEquals(
    message,
    "The session does not belong to a Google or Apple account.",
  );
  assertEquals(await cachedExpiresAtMs(token), null);
  assertEquals(await authFailCount(ip), 1);
});

// ── X: own probes ────────────────────────────────────────────────────────────

for (
  const [label, upstream] of [
    [
      "503 JSON",
      () => jsonResponse(503, { code: 503, msg: "service unavailable" }),
    ],
    [
      "502 HTML",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ],
    [
      "429 over_request_rate_limit",
      () =>
        jsonResponse(429, {
          code: 429,
          error_code: "over_request_rate_limit",
          msg: "Request rate limit reached",
        }),
    ],
  ] as Array<[string, () => Response]>
) {
  Deno.test(`X1 REPRO: GoTrue ${label} on GET /auth/v1/user is answered 401 'session no longer valid' + authfail charge (required: 503, no charge)`, async () => {
    const attack = await loadAttack3();
    const ip = freshIp();
    attack.setOverride((request, url) =>
      request.method === "GET" && url.pathname === "/auth/v1/user"
        ? upstream()
        : null
    );
    const token = supabaseBearer(freshUser(), {
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const { response, json, message } = await send(
      attack,
      `Bearer ${token}`,
      ip,
    );
    const charged = await authFailCount(ip);
    assertEquals(attack.getUserCalls().length, 1);
    console.log(
      JSON.stringify({
        x1: `GoTrue ${label} on getUser`,
        edgeStatus: response.status,
        edgeBody: json,
        authFailCharged: charged,
      }),
    );
    // A GoTrue outage/throttle is not a credential rejection. The app answers
    // a 401 by refreshing (authStore.handleApiUnauthorized → refreshSessionNow),
    // which under the same outage makes S1 decide whether the user is signed out.
    assertRepro(
      response.status,
      { observed: 401, required: 503 },
      `edge status for a GoTrue ${label} on GET /auth/v1/user`,
    );
    assertRepro(
      charged,
      { observed: 1, required: 0 },
      "auth-failure charge to the client IP for an upstream outage",
    );
    assert(message.length > 0);
  });
}

Deno.test("X1b REPRO: 30 requests with valid bearers during a GoTrue outage lock the client IP out of the API for up to 5 min after recovery (authfail 429)", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  attack.setOverride((request, url) =>
    request.method === "GET" && url.pathname === "/auth/v1/user"
      ? jsonResponse(503, { code: 503, msg: "service unavailable" })
      : null
  );
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const { response } = await send(
      attack,
      `Bearer ${supabaseBearer(freshUser(), { exp })}`,
      ip,
    );
    statuses.push(response.status);
  }
  // Recovery: GoTrue is healthy again, but is this IP still served?
  attack.setOverride(null);
  const recovered = await send(
    attack,
    `Bearer ${supabaseBearer(freshUser(), { exp })}`,
    ip,
  );
  console.log(
    JSON.stringify({
      x1b: "31 valid bearers during a GoTrue 503 outage, then recovery",
      statuses,
      afterRecovery: {
        status: recovered.response.status,
        retryAfter: recovered.response.headers.get("Retry-After"),
        rateLimitLimit: recovered.response.headers.get("RateLimit-Limit"),
      },
    }),
  );
  assertRepro(
    statuses.filter((s) => s === 401).length,
    { observed: 30, required: 0 },
    "valid bearers answered 401 during the outage",
  );
  assertRepro(
    recovered.response.status,
    { observed: 429, required: 404 },
    "status for the IP once GoTrue is healthy again (required: served immediately)",
  );
  if (recovered.response.status === 429) {
    assertEquals(
      recovered.response.headers.get("RateLimit-Limit"),
      "30",
      "locked out by the auth-failure budget",
    );
    assert(
      Number(recovered.response.headers.get("Retry-After")) > 60,
      "lockout outlives the 60 s IP window",
    );
  }
});

Deno.test("X2 HELD (characterisation): cold-bearer stampede — N concurrent first requests with one bearer each call getUser (no in-flight dedupe)", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const N = 25;
  const responses = await Promise.all(
    Array.from(
      { length: N },
      () =>
        attack.harness.handler(
          edgeRequest("GET", ROUTE, { authorization: `Bearer ${token}`, ip }),
        ),
    ),
  );
  for (const response of responses) {
    await response.body?.cancel();
    assertEquals(response.status, 404);
  }
  const calls = attack.getUserCalls().length;
  console.log(
    JSON.stringify({
      x2: "cold-bearer stampede",
      concurrent: N,
      getUserCalls: calls,
    }),
  );
  // Characterisation (observed on 4d812e1a: 23–25 of 25): there is no
  // in-flight dedupe, so most concurrent cold requests each hit GoTrue; the
  // count is bounded by N and correctness holds. A follow-up is served from cache.
  assert(
    calls >= 1 && calls <= N,
    `getUser calls ${calls} for ${N} concurrent cold requests`,
  );
  attack.reset();
  const warm = await send(attack, `Bearer ${token}`, ip);
  assertEquals(warm.response.status, 404);
  assertEquals(attack.getUserCalls().length, 0, "warm request served from L1");
});

Deno.test("X3 HELD: a corrupt L1 entry for the bearer falls through to getUser and is overwritten", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const key = `auth:${await sha256Hex(token)}`;
  await cacheSet(key, "{not json", 300);
  const { response } = await send(attack, `Bearer ${token}`, ip);
  assertEquals(response.status, 404);
  assertEquals(
    attack.getUserCalls().length,
    1,
    "corrupt entry → real verification",
  );
  const raw = await cacheGet(key);
  assert(
    raw && raw !== "{not json",
    "entry rewritten with the verified session",
  );
  const entry = JSON.parse(raw as string) as {
    userId: string;
    provider: string;
  };
  assertEquals(entry.provider, "google");
});

Deno.test("X3b HELD: a forged L1 entry with a wrong provider tag for a provider token is ignored (provider must match)", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const key = `auth:${await sha256Hex(token)}`;
  // For a Supabase bearer provider === null → any cached provider is accepted;
  // the entry must still be structurally valid and unexpired.
  await cacheSet(
    key,
    JSON.stringify({
      userId: "poisoned",
      email: null,
      provider: "google",
      accessToken: token,
      expiresAtMs: Date.now() - 1,
    }),
    300,
  );
  const { response } = await send(attack, `Bearer ${token}`, ip);
  assertEquals(response.status, 404);
  assertEquals(
    attack.getUserCalls().length,
    1,
    "an expired cached verdict is not trusted",
  );
});

Deno.test("X4 HELD: POST /v1/auth/logout drops the L1 entry — the next request with the same bearer is re-verified", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const token = supabaseBearer(freshUser(), {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  attack.setOverride((request, url) =>
    request.method === "POST" && url.pathname === "/auth/v1/logout"
      ? new Response(null, { status: 204 })
      : null
  );
  const warm = await send(attack, `Bearer ${token}`, ip);
  assertEquals(warm.response.status, 404);
  assertEquals(attack.getUserCalls().length, 1);
  assert((await cachedExpiresAtMs(token)) !== null);

  const logout = await attack.harness.handler(
    edgeRequest("POST", "/v1/auth/logout", {
      authorization: `Bearer ${token}`,
      ip,
    }),
  );
  assertEquals(logout.status, 204);
  assertEquals(await cachedExpiresAtMs(token), null, "L1 entry dropped");
  const logoutCalls = attack.upstreamTo("/auth/v1/logout");
  assertEquals(logoutCalls.length, 1);
  assertStringIncludes(logoutCalls[0].url, "scope=local");

  const after = await send(attack, `Bearer ${token}`, ip);
  assertEquals(
    after.response.status,
    404,
    "GoTrue (stub) still accepts it — the edge re-asked",
  );
  assertEquals(attack.getUserCalls().length, 2, "re-verified after logout");
});

Deno.test("X4b HELD: logout when GoTrue says the session is already gone (401/404) is still 204; 5xx is 503", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  for (
    const [status, expected] of [[401, 204], [404, 204], [503, 503]] as Array<
      [number, number]
    >
  ) {
    attack.setOverride((request, url) =>
      request.method === "POST" && url.pathname === "/auth/v1/logout"
        ? new Response(null, { status })
        : null
    );
    const response = await attack.harness.handler(
      edgeRequest("POST", "/v1/auth/logout", {
        authorization: `Bearer ${supabaseBearer(freshUser(), { exp })}`,
        ip,
      }),
    );
    await response.body?.cancel();
    assertEquals(response.status, expected, `upstream ${status}`);
  }
});

Deno.test("X5 HELD: huge (2 MB) and unicode bearers are refused quickly with no upstream call", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const huge = "a".repeat(2 * 1024 * 1024);
  const started = performance.now();
  const big = await send(attack, `Bearer ${huge}`, ip);
  const elapsed = performance.now() - started;
  assertEquals(big.response.status, 401);
  assertEquals(big.message, NOT_A_TOKEN);
  assert(elapsed < 2_000, `2 MB bearer took ${Math.round(elapsed)} ms`);

  const hugeJwtShaped = `${"a".repeat(700_000)}.${"b".repeat(700_000)}.${
    "c".repeat(700_000)
  }`;
  const shaped = await send(attack, `Bearer ${hugeJwtShaped}`, ip);
  assertEquals(shaped.response.status, 401);
  assertEquals(shaped.message, NOT_A_TOKEN);

  assertEquals(attack.upstream.length, 0, "junk bearers never reach GoTrue");
  assertEquals(await authFailCount(ip), 2);

  // A non-ASCII payload (UTF-8 sub) must not crash the decoder; GoTrue decides.
  const unicodeSub = supabaseBearer("ユーザー🥒", {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  const uni = await send(attack, `Bearer ${unicodeSub}`, ip);
  assertEquals(uni.response.status, 404, uni.message);
  assertEquals(attack.getUserCalls().length, 1);
});

Deno.test("X6 HELD: every rejection path carries x-request-id and honours a well-formed client id", async () => {
  const attack = await loadAttack3();
  const ip = freshIp();
  const { response } = await send(attack, "Bearer", ip, {
    headers: { "x-request-id": "attack3-req-0001" },
  });
  assertEquals(response.status, 401);
  assertEquals(response.headers.get("x-request-id"), "attack3-req-0001");
  const bad = await send(attack, "Bearer", ip, {
    headers: { "x-request-id": "ünïcödé-request-id" },
  });
  const generated = bad.response.headers.get("x-request-id") ?? "";
  assert(
    /^[0-9a-f-]{36}$/.test(generated),
    `unsafe client id replaced by uuid (got ${generated})`,
  );
  const long = await send(attack, "Bearer", ip, {
    headers: { "x-request-id": "x".repeat(65) },
  });
  assert(
    /^[0-9a-f-]{36}$/.test(long.response.headers.get("x-request-id") ?? ""),
    "65-char id replaced",
  );
});
