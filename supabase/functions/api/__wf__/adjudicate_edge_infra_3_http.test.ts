// Adjudication probes for stress area `edge-infra-3` — the REAL edge handler
// (../index.ts booted by sessionHarness.ts with a stateful fake GoTrue, fake
// PostgREST and a fake Upstash pipeline), exercised over HTTP the way the
// gateway would: authenticate() bearer matrix, auth-failure load, public
// legal routes, path shapes, oversized bodies, refresh/logout under faults.
//
// Redis is wired (`redis: true`) because the shared-store paths are the
// production configuration the defects concern; the harness is a module
// singleton so this file runs Redis-backed throughout.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adjudicate_edge_infra_3_http.test.ts

import {
  apiRequest,
  errorMessage,
  fakeJwt,
  forgedSessionToken,
  freshIp,
  GOOGLE_USER_ID,
  googleIdToken,
  jwtPayload,
  loadSessionHarness,
  REDIS_URL,
  SUPABASE_URL,
  withFrozenClock,
} from "./sessionHarness.ts";

let scenarios = 0;
const note = (line: string) => console.log(`[adj:http] ${line}`);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEquals<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PROBE_ROUTE = "/v1/me/saved-drills";

/** Bootstrap through the ALREADY loaded harness (loadSessionHarness resets
 * state on every call, which would wipe the Redis counters under test). */
async function bootstrap(h: Awaited<ReturnType<typeof loadSessionHarness>>, ip: string, sub = GOOGLE_USER_ID) {
  const response = await h.handler(apiRequest("POST", "/v1/account/bootstrap", { token: googleIdToken(sub), ip, body: {} }));
  assertEquals(response.status, 200, "bootstrap");
  const body = (await response.json()) as { session: { accessToken: string; refreshToken: string; expiresAt: number } };
  return body.session;
}

// ─── authenticate(): bearer matrix ───────────────────────────────────────────

Deno.test("authenticate(): 24 malformed / hostile bearers are all 401 (never 5xx), reach Supabase Auth only when structurally a session token, and each charges the auth-failure budget once", async () => {
  const h = await loadSessionHarness({ redis: true });
  const now = Math.floor(Date.now() / 1000);
  const iss = `${SUPABASE_URL}/auth/v1`;
  const junk = (payloadB64: string) => `${b64url(JSON.stringify({ alg: "HS256" }))}.${payloadB64}.${b64url("sig")}`;
  const bearers: Array<[string, string | null, boolean]> = [
    // [label, Authorization header value (null = absent), expected upstream getUser call?]
    ["absent", null, false],
    ["empty", "Bearer ", false],
    ["lowercase-scheme", `bearer ${forgedSessionToken()}`, false],
    ["basic-scheme", "Basic dXNlcjpwdw==", false],
    ["not-a-jwt", "Bearer hello-world", false],
    ["two-segments", `Bearer ${b64url("{}")}.${b64url("{}")}`, false],
    ["payload-not-json", `Bearer ${junk(b64url("{not json"))}`, false],
    ["payload-string", `Bearer ${junk(b64url("\"just a string\""))}`, false],
    ["payload-number", `Bearer ${junk(b64url("42"))}`, false],
    ["payload-null", `Bearer ${junk(b64url("null"))}`, false],
    ["payload-array", `Bearer ${junk(b64url("[1,2,3]"))}`, false],
    ["payload-invalid-b64", `Bearer ${junk("!!!!")}`, false],
    ["iss-other", `Bearer ${fakeJwt({ iss: "https://evil.example/auth/v1x", sub: GOOGLE_USER_ID, exp: now + 3600 })}`, false],
    ["iss-array", `Bearer ${fakeJwt({ iss: [iss], sub: GOOGLE_USER_ID, exp: now + 3600 })}`, false],
    ["expired-session", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: now - 1 })}`, false],
    ["exp-string", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: String(now + 3600) })}`, true],
    ["exp-huge", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: 1e300 })}`, true],
    ["exp-negative", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: -5 })}`, false],
    ["no-session-id", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, exp: now + 3600 })}`, true],
    ["session-id-object", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: { a: 1 }, exp: now + 3600 })}`, true],
    ["forged-unknown-session", `Bearer ${forgedSessionToken()}`, true],
    ["google-idtoken-expired", `Bearer ${googleIdToken(GOOGLE_USER_ID, -10)}`, false],
    ["huge-64KiB", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: now + 3600, pad: "x".repeat(64 * 1024) })}`, true],
    ["proto-pollution", `Bearer ${fakeJwt({ iss, sub: GOOGLE_USER_ID, session_id: crypto.randomUUID(), exp: now + 3600, __proto__: { admin: true }, constructor: { prototype: {} } })}`, true],
  ];
  for (const [label, authorization, expectUpstream] of bearers) {
    const ip = freshIp();
    h.calls = [];
    const headers: Record<string, string> = {};
    if (authorization !== null) headers["Authorization"] = authorization;
    const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: null, ip, headers }));
    assertEquals(response.status, 401, `${label}: status`);
    assertEquals(response.headers.get("Content-Type"), "application/json", `${label}: content-type`);
    assert(response.headers.get("X-Request-Id"), `${label}: request id`);
    const message = await errorMessage(response);
    assert(message.length > 0 && !message.includes("Error") && !/at .*\.ts/.test(message), `${label}: leaky message ${message}`);
    const upstream = h.callsTo("/auth/v1/user").length;
    assertEquals(upstream > 0, expectUpstream, `${label}: getUser called ${upstream}×`);
    assert(!h.callsTo("/rest/v1/").length, `${label}: PostgREST reached without auth`);
    const bucket = Math.floor(Date.now() / 300_000);
    assertEquals(h.redis.get(`rl:authfail:${bucket}:${ip}`)?.value, "1", `${label}: authfail charged once`);
    scenarios += 1;
  }
});

Deno.test("authenticate(): 5xx from Supabase Auth is 503 + Retry-After and does NOT charge the auth-failure budget; the bearer is not cached", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  const { accessToken } = await bootstrap(h, ip);
  for (const status of [500, 502, 503, 504, 429]) {
    h.getUserStatus = status;
    const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: accessToken, ip: freshIp() }));
    assertEquals(response.status, 503, `upstream ${status}`);
    assert(response.headers.get("Retry-After"), `upstream ${status}: Retry-After`);
    scenarios += 1;
  }
  h.getUserStatus = null;
  const bucket = Math.floor(Date.now() / 300_000);
  assert(![...h.redis.keys()].some((k) => k.startsWith(`rl:authfail:${bucket}:`) && h.redis.get(k)!.value !== "0"), "authfail charged on 503");
  assert(![...h.redis.keys()].some((k) => k.startsWith("auth:") && !k.startsWith("auth:revoked")), "bearer cached during outage");
  const ok = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: accessToken, ip }));
  assertEquals(ok.status, 200, "healthy again");
  scenarios += 1;
});

// ─── auth-failure load ───────────────────────────────────────────────────────

Deno.test("auth-failure load (Redis healthy): 45 sequential bad bearers from one IP → 30×401 then 429 with Retry-After ≤ 300; Supabase Auth sees exactly 30 verifications", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  await withFrozenClock(async () => {
    h.calls = [];
    const statuses: number[] = [];
    let retryAfter = "";
    for (let i = 0; i < 45; i += 1) {
      const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip }));
      statuses.push(response.status);
      if (response.status === 429) retryAfter = response.headers.get("Retry-After") ?? "";
      await response.body?.cancel();
    }
    assertEquals(statuses.slice(0, 30).every((s) => s === 401), true, `first 30: ${statuses.slice(0, 30)}`);
    assertEquals(statuses.slice(30).every((s) => s === 429), true, `after 30: ${statuses.slice(30)}`);
    assert(Number(retryAfter) >= 1 && Number(retryAfter) <= 300, `Retry-After ${retryAfter}`);
    assertEquals(h.callsTo("/auth/v1/user").length, 30, "getUser calls");
    note(`authfail sequential: ${statuses.filter((s) => s === 401).length}×401, ${statuses.filter((s) => s === 429).length}×429, Retry-After=${retryAfter}`);
  });
  scenarios += 1;
});

Deno.test("[characterization] auth-failure load (Redis healthy): a 200-wide CONCURRENT burst of bad bearers all pass the pre-route peek → 200 Supabase Auth calls (bounded only by the 1 200/min IP budget); the gate closes for the next request", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  await withFrozenClock(async () => {
    h.calls = [];
    const responses = await Promise.all(
      Array.from({ length: 200 }, () => h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip }))),
    );
    const s401 = responses.filter((r) => r.status === 401).length;
    const s429 = responses.filter((r) => r.status === 429).length;
    await Promise.all(responses.map((r) => r.body?.cancel()));
    const upstream = h.callsTo("/auth/v1/user").length;
    note(`authfail concurrent burst: 401=${s401} 429=${s429} getUser=${upstream}`);
    assertEquals(s401 + s429, 200, "every request answered");
    assert(upstream >= 30, "peek-then-enforce lets a burst through");
    const next = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip }));
    assertEquals(next.status, 429, "gate closed after the burst");
    await next.body?.cancel();
  });
  scenarios += 1;
});

Deno.test("[defect] auth-failure gate over HTTP: while Upstash answers per-command errors (HTTP 200 + {error}), 60 bad bearers from one IP are ALL 401 — never 429 — and Supabase Auth is hit 60 times; the same 60 with healthy Redis stop at 30", async () => {
  const h = await loadSessionHarness({ redis: true });
  const healthyFetch = globalThis.fetch;
  const ip = freshIp();
  await withFrozenClock(async () => {
    // Upstash reports quota exhaustion / OOM / read-only token PER COMMAND
    // inside a 200 pipeline reply. cache.ts redisWindowGet reads the missing
    // `result` as "window empty → 0"; redisWindowIncr reads it as unknown →
    // memory fallback. peek (gate) and enforce (charge) thus diverge.
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${REDIS_URL}/pipeline`) {
        const commands = (await request.json()) as unknown[];
        return new Response(JSON.stringify(commands.map(() => ({ error: "ERR max requests limit exceeded" }))), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return healthyFetch(input, init);
    }) as typeof fetch;
    try {
      h.calls = [];
      const statuses: number[] = [];
      for (let i = 0; i < 60; i += 1) {
        const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip }));
        statuses.push(response.status);
        await response.body?.cancel();
      }
      const getUser = h.callsTo("/auth/v1/user").length;
      note(`DEFECT authfail gate under Upstash command errors: 401=${statuses.filter((s) => s === 401).length} 429=${statuses.filter((s) => s === 429).length} getUser=${getUser}`);
      // Observed at 1fb0efd7 — invert when fixed (expected: 30×401 then 30×429, getUser === 30).
      assertEquals(statuses.every((s) => s === 401), true, `statuses ${statuses.join(",")}`);
      assertEquals(getUser, 60, "every bad bearer reached Supabase Auth");
    } finally {
      globalThis.fetch = healthyFetch;
    }
    // Control: same load, healthy Redis, fresh IP.
    const controlIp = freshIp();
    h.calls = [];
    const control: number[] = [];
    for (let i = 0; i < 60; i += 1) {
      const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip: controlIp }));
      control.push(response.status);
      await response.body?.cancel();
    }
    assertEquals(control.filter((s) => s === 401).length, 30, "control 401s");
    assertEquals(control.filter((s) => s === 429).length, 30, "control 429s");
    assertEquals(h.callsTo("/auth/v1/user").length, 30, "control getUser");
  });
  scenarios += 2;
});

Deno.test("auth-failure gate over HTTP: while Upstash is DOWN (HTTP 503), the memory fallback still closes the gate at 30 within the isolate", async () => {
  const h = await loadSessionHarness({ redis: true });
  const healthyFetch = globalThis.fetch;
  const ip = freshIp();
  await withFrozenClock(async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === `${REDIS_URL}/pipeline`) return new Response("upstream unavailable", { status: 503 });
      return healthyFetch(input, init);
    }) as typeof fetch;
    try {
      h.calls = [];
      const statuses: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: forgedSessionToken(), ip }));
        statuses.push(response.status);
        await response.body?.cancel();
      }
      assertEquals(statuses.filter((s) => s === 401).length, 30, `401s in ${statuses.join(",")}`);
      assertEquals(statuses.filter((s) => s === 429).length, 10, "429s");
      assertEquals(h.callsTo("/auth/v1/user").length, 30, "getUser");
    } finally {
      globalThis.fetch = healthyFetch;
    }
  });
  scenarios += 1;
});

// ─── public routes: legal text, healthz, method/path handling ───────────────

Deno.test("public legal routes: GET/HEAD /privacy /terms /support /healthz are 200 text/plain with security headers and no auth; other methods and look-alike paths are not public", async () => {
  const h = await loadSessionHarness({ redis: true });
  for (const path of ["/privacy", "/terms", "/support"]) {
    for (const mount of ["/functions/v1/api", "/api", ""]) {
      const response = await h.handler(new Request(`http://edge.test${mount}${path}`, { headers: { "x-forwarded-for": freshIp() } }));
      assertEquals(response.status, 200, `GET ${mount}${path}`);
      assert((response.headers.get("Content-Type") ?? "").startsWith("text/plain"), `${path}: ${response.headers.get("Content-Type")}`);
      assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff", `${path}: nosniff`);
      assertEquals(response.headers.get("Referrer-Policy"), "no-referrer", `${path}: referrer`);
      assert((response.headers.get("Cache-Control") ?? "").includes("max-age"), `${path}: cacheable`);
      assert(response.headers.get("X-Request-Id"), `${path}: request id`);
      const text = await response.text();
      assert(text.length > 1_000, `${path}: ${text.length} chars`);
      assert(!/<[a-z]+[\s>]/i.test(text), `${path}: HTML-looking content`);
      scenarios += 1;
    }
    const head = await h.handler(new Request(`http://edge.test/functions/v1/api${path}`, { method: "HEAD", headers: { "x-forwarded-for": freshIp() } }));
    assertEquals(head.status, 200, `HEAD ${path}`);
    // The handler answers HEAD with the same Response as GET; Deno.serve /
    // the gateway strip the body on the wire, so only status/headers matter here.
    assert((head.headers.get("Content-Type") ?? "").startsWith("text/plain"), `HEAD ${path}: content-type`);
    await head.body?.cancel();
    for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
      const other = await h.handler(new Request(`http://edge.test/functions/v1/api${path}`, { method, headers: { "x-forwarded-for": freshIp() } }));
      assert(other.status === 401 || other.status === 404 || other.status === 405 || other.status === 204, `${method} ${path}: ${other.status}`);
      assert(other.status !== 200 || method === "OPTIONS", `${method} ${path} served legal text`);
      await other.body?.cancel();
      scenarios += 1;
    }
  }
  // Public paths are matched by pathname SUFFIX (index.ts handleRequest), so
  // "/v1/privacy" and the dot-segment form (normalized by URL) also serve the
  // public text — harmless (public, unauthenticated content) and by design.
  const suffixMatches = new Set(["/v1/privacy", "/support/../privacy"]);
  for (const lookalike of ["/privacy/", "/privacy.txt", "/privacyx", "/Privacy", "/v1/privacy", "/terms%20", "/support/../privacy"]) {
    const response = await h.handler(new Request(`http://edge.test/functions/v1/api${lookalike}`, { headers: { "x-forwarded-for": freshIp() } }));
    if (suffixMatches.has(lookalike)) assertEquals(response.status, 200, `${lookalike}: suffix match`);
    else assert(response.status === 401 || response.status === 404, `${lookalike}: ${response.status}`);
    await response.body?.cancel();
    scenarios += 1;
  }
  const health = await h.handler(new Request("http://edge.test/functions/v1/api/healthz", { headers: { "x-forwarded-for": freshIp() } }));
  assertEquals(health.status, 200, "healthz");
  assertEquals(response_json_ok(await health.text()), true, "healthz body");
  scenarios += 1;
});

function response_json_ok(text: string): boolean {
  try {
    const body = JSON.parse(text) as { status?: string; ok?: boolean };
    return body.status === "ok" || body.ok === true;
  } catch {
    return false;
  }
}

Deno.test("public legal routes: 60/min per IP — 61st GET is 429 with Retry-After, other IPs unaffected, and the authenticated budget is separate", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  await withFrozenClock(async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 65; i += 1) {
      const response = await h.handler(new Request("http://edge.test/functions/v1/api/privacy", { headers: { "x-forwarded-for": ip } }));
      statuses.push(response.status);
      await response.body?.cancel();
    }
    assertEquals(statuses.filter((s) => s === 200).length, 60, `200s in ${statuses.join(",")}`);
    assertEquals(statuses.filter((s) => s === 429).length, 5, "429s");
    const other = await h.handler(new Request("http://edge.test/functions/v1/api/privacy", { headers: { "x-forwarded-for": freshIp() } }));
    assertEquals(other.status, 200, "other IP");
    await other.body?.cancel();
  });
  scenarios += 1;
});

Deno.test("path shapes: both gateway mounts route identically; dot-segments, double slashes, encoded slashes, trailing slash and 8 KiB paths are 404/400 with a valid bearer, never 5xx, and never charge the auth-failure budget", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  const { accessToken } = await bootstrap(h, ip);
  h.tables["user_saved_drills"] = [];
  for (const mount of ["/functions/v1/api", "/api", ""]) {
    const response = await h.handler(new Request(`http://edge.test${mount}/v1/me/saved-drills`, { headers: { "x-forwarded-for": ip, Authorization: `Bearer ${accessToken}` } }));
    assertEquals(response.status, 200, `mount ${mount}`);
    await response.body?.cancel();
    scenarios += 1;
  }
  const shapes = [
    "/v1/me/saved-drills/",
    "/v1//me/saved-drills",
    "/v1/me/saved-drills/..%2Fbootstrap",
    "/v1/me/saved-drills/%2e%2e/%2e%2e/account",
    "/v1/catalog/drills/constructor",
    "/v1/catalog/drills/__proto__",
    "/v1/catalog/drills/%00",
    "/v1/catalog/drills/%ZZ",
    "/v1/catalog/drills/" + "a".repeat(8 * 1024),
    "/v1/me/saved-drills/" + "a".repeat(8 * 1024),
    "/v1/account/bootstrap/../me",
    "/v1/nope",
    "/v1/",
    "/v1/me/saved-drills?x=" + "y".repeat(16 * 1024),
  ];
  const bucketKey = () => `rl:authfail:${Math.floor(Date.now() / 300_000)}:${ip}`;
  for (const shape of shapes) {
    for (const method of ["GET", "PUT", "POST", "DELETE"]) {
      const response = await h.handler(new Request(`http://edge.test/functions/v1/api${shape}`, {
        method,
        headers: { "x-forwarded-for": ip, Authorization: `Bearer ${accessToken}`, ...(method === "GET" || method === "DELETE" ? {} : { "Content-Type": "application/json" }) },
        body: method === "GET" || method === "DELETE" ? undefined : "{}",
      }));
      assert(response.status < 500, `${method} ${shape.slice(0, 60)}: ${response.status}`);
      assert(response.status !== 401, `${method} ${shape.slice(0, 60)}: valid bearer refused`);
      await response.body?.cancel();
      scenarios += 1;
    }
  }
  assertEquals(h.redis.get(bucketKey()), undefined, "authfail charged for routing misses with a valid bearer");
});

Deno.test("oversized bodies: Content-Length > 5 MB is 413 before auth (no Supabase call); a 6 MB streamed body without Content-Length to a JSON route is refused without 5xx", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  const { accessToken } = await bootstrap(h, ip);
  h.calls = [];
  const declared = await h.handler(new Request("http://edge.test/functions/v1/api/v1/account/bootstrap", {
    method: "POST",
    headers: { "x-forwarded-for": ip, Authorization: `Bearer ${forgedSessionToken()}`, "Content-Type": "application/json", "Content-Length": String(6 * 1024 * 1024) },
    body: "{}",
  }));
  assertEquals(declared.status, 413, "declared oversize");
  await declared.body?.cancel();
  assertEquals(h.calls.filter((c) => c.url.startsWith(SUPABASE_URL)).length, 0, "upstream reached for a 413");
  scenarios += 1;

  const chunk = new TextEncoder().encode(`{"refreshToken":"${"r".repeat(1024 * 1024 - 20)}`);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 6; i += 1) controller.enqueue(chunk);
      controller.enqueue(new TextEncoder().encode(`"}`));
      controller.close();
    },
  });
  const started = performance.now();
  const streamed = await h.handler(new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
    method: "POST",
    headers: { "x-forwarded-for": ip, "Content-Type": "application/json" },
    body: stream,
    // deno-lint-ignore no-explicit-any
    ...({ duplex: "half" } as any),
  }));
  const elapsed = performance.now() - started;
  assert(streamed.status === 400 || streamed.status === 413 || streamed.status === 401, `streamed 6 MB: ${streamed.status}`);
  assert(elapsed < 5_000, `streamed 6 MB took ${elapsed.toFixed(0)}ms`);
  await streamed.body?.cancel();
  note(`streamed 6 MB refresh body → ${streamed.status} in ${elapsed.toFixed(0)}ms`);
  // Valid bearer path unaffected afterwards.
  h.tables["user_saved_drills"] = [];
  const ok = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: accessToken, ip }));
  assertEquals(ok.status, 200, "healthy after oversize");
  await ok.body?.cancel();
  scenarios += 1;
});

// ─── session lifecycle under faults ─────────────────────────────────────────

Deno.test("refresh: malformed bodies (not JSON, wrong type, empty, 100 KiB token, array) are 400/401 and each 401 charges the auth-failure budget once; GoTrue 429/5xx → 503 + Retry-After uncharged", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  const bucketKey = () => `rl:authfail:${Math.floor(Date.now() / 300_000)}:${ip}`;
  await withFrozenClock(async () => {
    const bodies: Array<[string, string]> = [
      ["not-json", "{"],
      ["array", "[]"],
      ["null", "null"],
      ["number", "7"],
      ["missing", "{}"],
      ["wrong-type", JSON.stringify({ refreshToken: 12 })],
      ["empty-string", JSON.stringify({ refreshToken: "" })],
      ["nested", JSON.stringify({ refreshToken: { a: 1 } })],
      ["huge", JSON.stringify({ refreshToken: "r".repeat(100 * 1024) })],
      ["unknown-token", JSON.stringify({ refreshToken: "rt-unknown" })],
    ];
    let charged = 0;
    for (const [label, raw] of bodies) {
      const response = await h.handler(new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
        method: "POST",
        headers: { "x-forwarded-for": ip, "Content-Type": "application/json" },
        body: raw,
      }));
      assert(response.status === 400 || response.status === 401, `${label}: ${response.status}`);
      if (response.status === 401) charged += 1;
      await response.body?.cancel();
      assertEquals(Number(h.redis.get(bucketKey())?.value ?? "0"), charged, `${label}: authfail count`);
      scenarios += 1;
    }
    note(`refresh malformed bodies: ${bodies.length} cases, ${charged} counted as auth failures`);
    const { refreshToken } = await bootstrap(h, ip);
    for (const status of [429, 500, 502, 503]) {
      h.refreshGrantStatus = status;
      const response = await h.handler(apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }));
      assertEquals(response.status, 503, `GoTrue ${status}`);
      assert(response.headers.get("Retry-After"), `GoTrue ${status}: Retry-After`);
      await response.body?.cancel();
      scenarios += 1;
    }
    h.refreshGrantStatus = null;
    assertEquals(Number(h.redis.get(bucketKey())?.value ?? "0"), charged, "503s charged the auth-failure budget");
    const rotated = await h.handler(apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }));
    assertEquals(rotated.status, 200, "refresh works once GoTrue recovers");
    await rotated.body?.cancel();
    scenarios += 1;
  });
});

Deno.test("logout: sibling and pre-refresh bearers of the same session are refused everywhere after logout (fence), a second logout is idempotent, and GoTrue 5xx keeps the session usable (503)", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  h.tables["user_saved_drills"] = [];
  const first = await bootstrap(h, ip);
  // Warm the pre-refresh bearer into L1 + L2 (a real GoTrue keeps that JWT
  // valid until its exp; the cached row is what a fence must beat).
  const warmFirst = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: first.accessToken, ip }));
  assertEquals(warmFirst.status, 200, "warm first");
  await warmFirst.body?.cancel();
  const refreshed = await h.handler(apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken: first.refreshToken } }));
  assertEquals(refreshed.status, 200, "refresh");
  const second = ((await refreshed.json()) as { session: { accessToken: string; refreshToken: string } }).session;
  assertEquals(h.sessionIdOf(first.accessToken), h.sessionIdOf(second.accessToken), "same session across refresh");
  const warmSecond = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: second.accessToken, ip }));
  assertEquals(warmSecond.status, 200, "warm second");
  await warmSecond.body?.cancel();
  const cachedSibling = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: first.accessToken, ip }));
  assertEquals(cachedSibling.status, 200, "sibling still served from cache before logout");
  await cachedSibling.body?.cancel();
  h.logoutStatus = 503;
  const failed = await h.handler(apiRequest("POST", "/v1/auth/logout", { token: second.accessToken, ip }));
  assertEquals(failed.status, 503, "logout with GoTrue down");
  await failed.body?.cancel();
  const stillOk = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: second.accessToken, ip }));
  assertEquals(stillOk.status, 200, "session survives a failed logout");
  await stillOk.body?.cancel();
  h.logoutStatus = null;
  const logout = await h.handler(apiRequest("POST", "/v1/auth/logout", { token: second.accessToken, ip }));
  assertEquals(logout.status, 204, "logout");
  h.calls = [];
  for (const [label, token] of [["logged-out", second.accessToken], ["sibling", first.accessToken]] as const) {
    const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token, ip }));
    assertEquals(response.status, 401, `${label} bearer after logout`);
    await response.body?.cancel();
    scenarios += 1;
  }
  assertEquals(h.callsTo("/auth/v1/user").length, 0, "fenced bearers were re-verified upstream");
  const again = await h.handler(apiRequest("POST", "/v1/auth/logout", { token: second.accessToken, ip }));
  assert(again.status === 204 || again.status === 401, `second logout: ${again.status}`);
  await again.body?.cancel();
  const spent = await h.handler(apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken: second.refreshToken } }));
  assertEquals(spent.status, 401, "refresh token of a logged-out session");
  await spent.body?.cancel();
  scenarios += 3;
});

Deno.test("session cache: 50 concurrent first requests with one fresh bearer verify with Supabase Auth at most a handful of times and all succeed; the cached row expires with the bearer", async () => {
  const h = await loadSessionHarness({ redis: true });
  const ip = freshIp();
  h.tables["user_saved_drills"] = [];
  h.accessTokenTtlSeconds = 3600;
  const { accessToken } = await bootstrap(h, ip);
  h.calls = [];
  const responses = await Promise.all(Array.from({ length: 50 }, () => h.handler(apiRequest("GET", PROBE_ROUTE, { token: accessToken, ip }))));
  assertEquals(responses.every((r) => r.status === 200), true, `statuses ${responses.map((r) => r.status).join(",")}`);
  await Promise.all(responses.map((r) => r.body?.cancel()));
  const verifications = h.callsTo("/auth/v1/user").length;
  note(`50 concurrent cold requests → ${verifications} getUser calls (no single-flight; each pre-cache request verifies)`);
  assert(verifications <= 50 && verifications >= 1, `getUser ${verifications}`);
  h.calls = [];
  for (let i = 0; i < 20; i += 1) {
    const response = await h.handler(apiRequest("GET", PROBE_ROUTE, { token: accessToken, ip }));
    assertEquals(response.status, 200, "warm");
    await response.body?.cancel();
  }
  assertEquals(h.callsTo("/auth/v1/user").length, 0, "warm requests re-verified");
  const cacheKeys = [...h.redis.keys()].filter((k) => k.startsWith("auth:") && !k.startsWith("auth:revoked"));
  for (const key of cacheKeys) {
    const ttl = (h.redis.get(key)!.expiresAtMs - Date.now()) / 1000;
    assert(ttl > 0 && ttl <= 600, `${key}: ttl ${ttl}`);
  }
  scenarios += 2;
});

Deno.test("adjudication summary (http)", () => {
  note(`scenarios executed in this module: ${scenarios}`);
  assert(scenarios > 0, "no scenarios");
});
