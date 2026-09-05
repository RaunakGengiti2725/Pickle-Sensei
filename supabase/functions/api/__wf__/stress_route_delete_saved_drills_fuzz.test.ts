// FUZZ/BOUNDARY campaign — DELETE /v1/me/saved-drills/:slug through the REAL
// handler (../index.ts via routesHarness.ts: Deno.serve captured, Supabase
// Auth + PostgREST + RevenueCat stubbed at the fetch layer; no network).
//
// Every iteration is generated from its own seed (derived from STRESS_SEED),
// fuzzing path params / query / method / headers / body / bearer, plus
// injected upstream faults, and is held to:
//   - bad input → only 400/401/403/404/405/413/415/429
//   - 5xx only when an upstream fault was injected, and then the generic body
//   - no stack traces / internals in any error body
//   - no PostgREST write on any rejection; exactly ONE tenant-scoped DELETE
//     (user_id=eq.<caller>&slug=eq.<decoded slug>, the caller's own bearer,
//     never the service key) on every accepted request
//   - x-request-id present and well-formed on every response
//
//   STRESS_ITER=3000 STRESS_SEED=20260905 deno test -A --no-check --config deno.json \
//     stress_route_delete_saved_drills_fuzz.test.ts
//   STRESS_REPLAY=<seed> …                        # one iteration, verbose
//
// Default STRESS_ITER is small so the file lives in the normal suite. The
// seed → outcome table lands in STRESS_OUT_DIR (default
// artifacts/stress/route-delete-saved-drills/fuzz_<seed>.json).

import { assertEquals } from "@std/assert";
import { captureAccessLog } from "../http.ts";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";
import {
  b64url,
  buildRequest,
  checkInvariants,
  envInt,
  expectation,
  type FuzzCase,
  generateCase,
  isRecord,
  type IterationRow,
  iterationSeed,
  type Observed,
  type OracleContext,
  outDir,
  type PoolUser,
  Prng,
  providerIdToken,
  STRESS_REPLAY,
  STRESS_SEED,
  summarize,
  truncateHeaders,
  truncateUrl,
  writeJson,
} from "./stress_saved_drills_shared.ts";

const STRESS_ITER = envInt("STRESS_ITER", 150);
const USER_POOL = 24;
const IP_POOL = Array.from({ length: 16 }, (_, i) => `203.0.113.${100 + i}`);

function buildUsers(seed: number): PoolUser[] {
  const rng = new Prng(seed ^ 0x9e3779b9);
  const exp = Math.floor(Date.now() / 1000) + 7200;
  return Array.from({ length: USER_POOL }, () => {
    const id = rng.uuid();
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: id,
        aud: "authenticated",
        role: "authenticated",
        exp,
        session_id: rng.uuid(),
      }),
    );
    return {
      id,
      googleToken: providerIdToken("https://accounts.google.com", id, exp),
      appleToken: providerIdToken("https://appleid.apple.com", id, exp),
      sessionToken: `${header}.${payload}.${rng.chars("abcdefghijklmnopqrstuvwxyz0123456789", 43)}`,
      accessTokenForProvider: `session-for-${id}`,
    };
  });
}

interface UpstreamCall {
  method: string;
  url: string;
  authorization: string | null;
  apikey: string | null;
}

/** Wraps the harness stub: answers GET /auth/v1/user (the session-bearer
 * verification the static harness does not model), injects the iteration's
 * upstream fault, and records every PostgREST write. */
function installUpstream(
  harnessFetch: typeof fetch,
  ctx: OracleContext,
  state: { current: FuzzCase | null; calls: UpstreamCall[] },
): void {
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });
  globalThis.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Response | Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const fault = state.current?.fault ?? null;
    state.calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      apikey: request.headers.get("apikey"),
    });

    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      if (fault === "auth-user-503") {
        return json(503, { code: 503, msg: "service unavailable" }, { "Retry-After": "7" });
      }
      if (fault === "auth-user-502-html") {
        return new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        });
      }
      if (fault === "auth-user-200-garbage") return new Response("{not json", { status: 200 });
      const bearer = request.headers.get("authorization") ?? "";
      const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
      const session = ctx.sessionUsers.get(token);
      if (!session) {
        return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      return json(200, {
        id: session.id,
        aud: "authenticated",
        role: "authenticated",
        email: "user@example.com",
        app_metadata: session.provider
          ? { provider: session.provider, providers: [session.provider] }
          : {},
      });
    }
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/auth/v1/token" &&
      fault === "auth-token-500"
    ) {
      return new Response("<html>500</html>", {
        status: 500,
        headers: { "Content-Type": "text/html" },
      });
    }
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/user_saved_drills" &&
      request.method === "DELETE" &&
      fault?.startsWith("pgrst-")
    ) {
      switch (fault) {
        case "pgrst-400":
          return json(400, {
            code: "PGRST100",
            message: 'unexpected "x" expecting "."',
            details: "…",
            hint: null,
          });
        case "pgrst-401":
          return json(401, {
            code: "PGRST301",
            message: "JWSError JWSInvalidSignature",
            details: null,
            hint: null,
          });
        case "pgrst-403":
          return json(403, {
            code: "42501",
            message: "permission denied for table user_saved_drills",
            details: null,
            hint: null,
          });
        case "pgrst-404":
          return json(404, {
            code: "PGRST205",
            message: "Could not find the table 'public.user_saved_drills' in the schema cache",
            details: null,
            hint: null,
          });
        case "pgrst-409":
          return json(409, {
            code: "23503",
            message: "violates foreign key constraint",
            details: "Key is not present",
            hint: null,
          });
        case "pgrst-500-html":
          return new Response(
            "<html><body><pre>Internal Server Error\n    at file:///x.ts:1:1</pre></body></html>",
            { status: 500, headers: { "Content-Type": "text/html" } },
          );
        case "pgrst-502-empty":
          return new Response(null, { status: 502 });
        case "pgrst-503-retry":
          return json(503, { message: "upstream connect error" }, { "Retry-After": "3" });
        case "pgrst-200-garbage":
          return new Response("<<<not json>>>", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        case "pgrst-network":
          return Promise.reject(
            new TypeError("error sending request: connection refused (os error 111)"),
          );
      }
    }
    return harnessFetch(input, init);
  }) as typeof fetch;
}

async function observe(response: Response, calls: UpstreamCall[]): Promise<Observed> {
  const bodyText = await response.text();
  let bodyJson: unknown = null;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    bodyJson = null;
  }
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    bodyText,
    bodyJson,
    retryAfter: response.headers.get("retry-after"),
    dbWrites: calls.filter(
      (c) => c.url.includes("/rest/v1/") && !["GET", "HEAD"].includes(c.method),
    ),
  };
}

Deno.test(
  `stress fuzz-boundary: DELETE /v1/me/saved-drills/:slug × ${STRESS_REPLAY ? "replay" : STRESS_ITER} (seed ${STRESS_SEED})`,
  async () => {
    const h = await loadHarness();
    const harnessFetch = globalThis.fetch;
    const users = buildUsers(STRESS_SEED);
    const ctx: OracleContext = {
      users,
      sessionUsers: new Map(
        users.map((u) => [u.sessionToken, { id: u.id, provider: "google" as const }]),
      ),
      providerAccessToken: (sub) => `session-for-${sub}`,
      defaultProviderSub: TEST_USER_ID,
    };
    const upstream: { current: FuzzCase | null; calls: UpstreamCall[] } = {
      current: null,
      calls: [],
    };
    installUpstream(harnessFetch, ctx, upstream);
    const restoreAccessLog = captureAccessLog(() => undefined);
    const realError = console.error;
    const realWarn = console.warn;
    let upstreamLogLines = 0;
    console.error = () => {
      upstreamLogLines += 1;
    };
    console.warn = () => {
      upstreamLogLines += 1;
    };

    const rows: IterationRow[] = [];
    const iterations = STRESS_REPLAY
      ? [Number(STRESS_REPLAY)]
      : Array.from({ length: STRESS_ITER }, (_, i) => iterationSeed(STRESS_SEED, i));
    const startedAt = performance.now();
    try {
      for (let i = 0; i < iterations.length; i += 1) {
        const seed = iterations[i];
        const fuzz = generateCase(i, seed, { users, ipPool: IP_POOL, faults: true, pgSafe: false });
        if (fuzz.auth.kind === "session-fresh" && fuzz.auth.token) {
          ctx.sessionUsers.set(fuzz.auth.token, {
            id: users[fuzz.auth.userIndex].id,
            provider: "google",
          });
        }
        if (fuzz.auth.kind === "session-no-provider" && fuzz.auth.token) {
          ctx.sessionUsers.set(fuzz.auth.token, {
            id: users[fuzz.auth.userIndex].id,
            provider: null,
          });
        }
        const built = buildRequest(fuzz);
        const base: Omit<
          IterationRow,
          | "status"
          | "requestId"
          | "bodyPreview"
          | "dbWrites"
          | "durationMs"
          | "violations"
          | "expected"
          | "url"
        > = {
          iteration: i,
          seed,
          family: fuzz.family,
          method: fuzz.method,
          headers: truncateHeaders(fuzz.headers),
          bodyKind: fuzz.bodyKind,
          authKind: fuzz.auth.kind,
          fault: fuzz.fault,
        };
        if ("error" in built) {
          rows.push({
            ...base,
            url: truncateUrl(`${fuzz.base}${fuzz.rawPath}`),
            expected: { kind: "n/a", statuses: [], reason: "unconstructible" },
            status: null,
            requestId: null,
            bodyPreview: "",
            dbWrites: 0,
            durationMs: 0,
            violations: [],
            unconstructible: built.error,
          });
          continue;
        }
        const expect = expectation(fuzz, built.url, ctx);
        upstream.current = fuzz;
        upstream.calls = [];
        const t0 = performance.now();
        let seen: Observed;
        try {
          const response = await h.handler(built.request);
          seen = await observe(response, upstream.calls);
        } catch (error) {
          seen = {
            status: -1,
            requestId: null,
            contentType: null,
            bodyText: `HANDLER THREW: ${error instanceof Error ? error.message : String(error)}`,
            bodyJson: null,
            retryAfter: null,
            dbWrites: [],
          };
        }
        const durationMs = performance.now() - t0;
        const violations = checkInvariants(fuzz, expect, seen);
        if (seen.status === -1) violations.unshift(seen.bodyText);
        rows.push({
          ...base,
          url: truncateUrl(built.request.url),
          expected: { kind: expect.kind, statuses: expect.statuses, reason: expect.reason },
          status: seen.status,
          requestId: seen.requestId,
          bodyPreview: seen.bodyText.slice(0, 200),
          dbWrites: seen.dbWrites.length,
          durationMs: Math.round(durationMs * 100) / 100,
          violations,
        });
      }
    } finally {
      upstream.current = null;
      globalThis.fetch = harnessFetch;
      console.error = realError;
      console.warn = realWarn;
      restoreAccessLog();
      h.reset();
    }

    const summary = summarize(rows);
    const report = {
      unit: "route-delete-v1-me-saved-drills-slug",
      lens: "fuzz-boundary",
      mode: "in-process handler, stubbed Supabase Auth + PostgREST",
      campaignSeed: STRESS_SEED,
      requestedIterations: STRESS_REPLAY ? 1 : STRESS_ITER,
      replay: STRESS_REPLAY || null,
      wallMs: Math.round(performance.now() - startedAt),
      upstreamLogLines,
      replayCommand: `STRESS_SEED=${STRESS_SEED} STRESS_REPLAY=<seed> deno test -A --no-check --config deno.json stress_route_delete_saved_drills_fuzz.test.ts`,
      summary,
      rows,
    };
    const file = `${outDir()}/fuzz_${STRESS_SEED}${STRESS_REPLAY ? `_replay_${STRESS_REPLAY}` : ""}.json`;
    await writeJson(file, report);
    const failing = rows.filter((r) => r.violations.length > 0);
    if (STRESS_REPLAY || failing.length > 0) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify(
          { file, summary: { ...summary, byFamily: undefined }, failing: failing.slice(0, 20) },
          null,
          2,
        ),
      );
    }
    assertEquals(
      failing.map(
        (r) =>
          `#${r.iteration} seed=${r.seed} [${r.family}] → ${r.status}: ${r.violations.join(" | ")}`,
      ),
      [],
      `${failing.length}/${summary.executed} iterations violated an invariant; table: ${file}`,
    );
    const executed = summary.executed as number;
    if (executed < (STRESS_REPLAY ? 1 : STRESS_ITER) * 0.97) {
      throw new Error(
        `only ${executed} of ${STRESS_ITER} iterations were constructible; table: ${file}`,
      );
    }
  },
);

// Hand-written boundary probes that the generator reaches only by chance,
// pinned so the suite always covers them.
Deno.test("stress fuzz-boundary: pinned boundary probes", async () => {
  const h = await loadHarness();
  const restore = captureAccessLog(() => undefined);
  const users = buildUsers(STRESS_SEED);
  const [user, other] = users;
  const probe = async (
    path: string,
    init: { method?: string; headers?: Record<string, string> } = {},
  ) => {
    h.calls = [];
    const headers = new Headers({
      Authorization: `Bearer ${user.googleToken}`,
      "x-forwarded-for": "203.0.113.200",
      ...init.headers,
    });
    const response = await h.handler(
      new Request(`http://edge.test/functions/v1/api${path}`, {
        method: init.method ?? "DELETE",
        headers,
      }),
    );
    const text = await response.text();
    const writes = h.calls.filter((c) => c.url.includes("/rest/v1/") && c.method !== "GET");
    return {
      status: response.status,
      text,
      writes,
      requestId: response.headers.get("x-request-id"),
    };
  };
  try {
    // NUL byte, encoded slash, dot segments and the sibling-tenant injection
    // all reach PostgREST as ONE literal eq filter on the caller's own row.
    for (const [raw, decoded] of [
      ["%00", "\u0000"],
      ["a%2Fb", "a/b"],
      [`x%26user_id%3Deq.${other.id}`, `x&user_id=eq.${other.id}`],
      ["in.(a,b)", "in.(a,b)"],
      ["*", "*"],
      ["%2A", "*"],
      ["a".repeat(60_000), "a".repeat(60_000)],
    ] as const) {
      const r = await probe(`/v1/me/saved-drills/${raw}`);
      assertEquals(r.status, 204, `${raw.slice(0, 40)} → ${r.status} ${r.text}`);
      assertEquals(r.writes.length, 1);
      const target = new URL(r.writes[0].url);
      assertEquals(target.searchParams.get("user_id"), `eq.${user.id}`);
      assertEquals(target.searchParams.get("slug"), `eq.${decoded}`);
      assertEquals([...target.searchParams.keys()].sort(), ["slug", "user_id"]);
      assertEquals(r.writes[0].headers["authorization"], `Bearer session-for-${user.id}`);
    }
    // Malformed escapes: 400, nothing written.
    for (const raw of ["%", "%2", "%zz", "%E0%A4%A", "%C0%AF", "%ED%A0%80", "%FF", "a%"]) {
      const r = await probe(`/v1/me/saved-drills/${raw}`);
      assertEquals(r.status, 400, `${raw} → ${r.status}`);
      assertEquals(r.writes.length, 0);
      assertEquals(isRecord(JSON.parse(r.text)?.error), true);
    }
    // Structural misses: 404, nothing written.
    for (const path of [
      "/v1/me/saved-drills",
      "/v1/me/saved-drills/",
      "/v1/me/saved-drills/a/b",
      "/v1/me/saved-drills%2Fa",
      "/v2/me/saved-drills/a",
      "/v1/me/Saved-Drills/a",
    ]) {
      const r = await probe(path);
      assertEquals(r.status, 404, `${path} → ${r.status}`);
      assertEquals(r.writes.length, 0);
    }
    // Method variations on the exact route: never a write.
    for (const method of ["GET", "HEAD", "POST", "PATCH", "OPTIONS", "FOO"]) {
      const r = await probe("/v1/me/saved-drills/dink-basics", { method });
      assertEquals(r.status, 404, `${method} → ${r.status}`);
      assertEquals(r.writes.length, 0);
    }
    // Content-Length boundary: exactly the cap passes, cap+1 is 413 before auth.
    assertEquals(
      (await probe("/v1/me/saved-drills/x", { headers: { "content-length": "5000000" } })).status,
      204,
    );
    const over = await probe("/v1/me/saved-drills/x", {
      headers: { "content-length": "5000001", Authorization: "Bearer nope" },
    });
    assertEquals(over.status, 413);
    assertEquals(over.writes.length, 0);
    // Request id: honoured iff well-formed, never echoed otherwise.
    assertEquals(
      (await probe("/v1/me/saved-drills/x", { headers: { "x-request-id": "trace-abc.123_x" } }))
        .requestId,
      "trace-abc.123_x",
    );
    const minted = await probe("/v1/me/saved-drills/x", {
      headers: { "x-request-id": "<script>alert(1)</script>" },
    });
    assertEquals(minted.requestId?.includes("<"), false);
    assertEquals(/^[A-Za-z0-9._-]{8,64}$/.test(minted.requestId ?? ""), true);
  } finally {
    restore();
    h.reset();
  }
});
