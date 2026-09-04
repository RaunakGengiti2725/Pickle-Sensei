// End-to-end abuse probes against the REAL edge handler (index.ts) with no
// socket and no Supabase project: Deno.serve is captured, exactly like the
// existing __wf__/index_preauth_test.ts does, so every decision below is the
// production request pipeline (clientIp → per-IP budget → auth-failure peek).
//
//   deno run -A --no-check tools/adversarial/rate-limit-dos/handler_abuse.ts
//
// (`--no-check` matches the repo's edge test invocation: index.ts carries the
// documented pre-existing untyped-supabase-client errors.)

const OUT = (() => {
  const i = Deno.args.indexOf("--out");
  return i >= 0
    ? Deno.args[i + 1]
    : "artifacts/xc-rate-limit-dos/handler_abuse.json";
})();

type Handler = (request: Request) => Response | Promise<Response>;

Deno.env.set("SUPABASE_URL", "http://127.0.0.1:1");
Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "webhook-secret-for-tests");
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

let captured: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (
  ...args: unknown[]
): unknown => {
  captured = args.find((a) => typeof a === "function") as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../../../supabase/functions/api/index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;

const BASE = "https://example.test/functions/v1/api";

async function handle(request: Request): Promise<number> {
  if (!captured) throw new Error("index.ts registered no Deno.serve handler");
  const response = await Promise.resolve(captured(request));
  await response.body?.cancel();
  return response.status;
}

async function handleFull(request: Request): Promise<Response> {
  if (!captured) throw new Error("index.ts registered no Deno.serve handler");
  return await Promise.resolve(captured(request));
}

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_")
    .replaceAll("=", "");
}
/** Structurally valid Google ID token with a garbage signature — the exact
 * shape tools/loadtest/auth-abuse.js stuffs. */
function fakeIdToken(): string {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${
    b64url({ iss: "https://accounts.google.com", exp: 4_102_444_800 })
  }.invalid-signature`;
}

const SEED = 0x5eed_1337;
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function req(
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Request {
  return new Request(`${BASE}${path}`, { method, headers });
}

// ── 1. Header-less clients share ONE bucket ─────────────────────────────────
// clientIp() returns "unknown" when the platform sends neither header, so all
// such callers are charged to the same key (public pages: 60/60s).
async function unknownIdentityCollapse() {
  const statuses: number[] = [];
  for (let i = 0; i < 65; i += 1) {
    statuses.push(await handle(req("/healthz", {})));
  }
  const first429 = statuses.indexOf(429) + 1;
  // A second "distinct" caller with no headers inherits the exhausted bucket.
  const otherCaller = await handle(
    req("/healthz", { "user-agent": "another-client/1.0" }),
  );
  // A caller the gateway DID stamp is unaffected.
  const stamped = await handle(
    req("/healthz", { "cf-connecting-ip": "198.51.100.42" }),
  );
  return {
    publicPageLimit: 60,
    requestsSentWithNoIpHeaders: statuses.length,
    firstRequestBlocked: first429 === 0 ? null : first429,
    secondUnrelatedHeaderlessCallerStatus: otherCaller,
    gatewayStampedCallerStatus: stamped,
    note:
      'every caller whose request carries no cf-connecting-ip and no x-forwarded-for shares the id "unknown"',
  };
}

// ── 2. Auth-failure budget: co-tenant lockout on a shared address ────────────
// The authfail budget is PEEKED before authentication for EVERY request from
// the address (index.ts:2894-2900), so 30 bad tokens from one host behind a
// NAT/CGNAT address answer 429 to everyone else on that address.
async function sharedAddressLockout() {
  const ip = "203.0.113.31";
  let failures = 0;
  for (let i = 0; i < 30; i += 1) {
    const status = await handle(
      req("/v1/me", {
        "cf-connecting-ip": ip,
        Authorization: `Bearer ${fakeIdToken()}`,
      }),
    );
    if (status === 401) failures += 1;
  }
  // Co-tenant #1: a well-formed session bearer (would be verified upstream).
  const coTenantBearer = await handleFull(
    req("/v1/me", {
      "cf-connecting-ip": ip,
      Authorization: "Bearer legitimate-looking-session",
    }),
  );
  const retryAfter = coTenantBearer.headers.get("Retry-After");
  const rateLimitLimit = coTenantBearer.headers.get("RateLimit-Limit");
  await coTenantBearer.body?.cancel();
  // Co-tenant #2: a fresh sign-in (bootstrap) from the same address.
  const coTenantBootstrap = await handle(
    req("/v1/account/bootstrap", { "cf-connecting-ip": ip }, "POST"),
  );
  // Co-tenant #3: session rotation from the same address.
  const coTenantRefresh = await handle(
    req("/v1/auth/refresh", { "cf-connecting-ip": ip }, "POST"),
  );
  // Public pages are decided before the budget, so they still answer.
  const publicPage = await handle(req("/healthz", { "cf-connecting-ip": ip }));
  // A different address is untouched.
  const elsewhere = await handle(
    req("/v1/me", { "cf-connecting-ip": "203.0.113.32" }),
  );
  return {
    authFailureLimit: 30,
    authFailureWindowSeconds: 300,
    failuresSpentByAttacker: failures,
    coTenantWithSessionBearerStatus: coTenantBearer.status,
    coTenantRetryAfterHeader: retryAfter === null ? null : Number(retryAfter),
    coTenantRateLimitLimitHeader: rateLimitLimit === null
      ? null
      : Number(rateLimitLimit),
    coTenantBootstrapStatus: coTenantBootstrap,
    coTenantRefreshStatus: coTenantRefresh,
    publicPageStatus: publicPage,
    differentAddressStatus: elsewhere,
    note:
      "429 for every non-public route from the address until the 300 s bucket rolls over",
  };
}

// ── 3. Spoofed-identity flood wipes the in-memory windows ───────────────────
// One host that can set cf-connecting-ip walks 20 000 distinct identities;
// rateLimit.ts:33-37 clears the ENTIRE window map when it is full and nothing
// has expired, which un-blocks the address it just locked out.
async function spoofFloodWipe(floodIdentities: number) {
  const victim = "203.0.113.77";
  let victimFailures = 0;
  for (let i = 0; i < 30; i += 1) {
    const status = await handle(
      req("/v1/me", {
        "cf-connecting-ip": victim,
        Authorization: `Bearer ${fakeIdToken()}`,
      }),
    );
    if (status === 401) victimFailures += 1;
  }
  const lockedOut = await handle(req("/v1/me", { "cf-connecting-ip": victim }));
  const rnd = lcg(SEED);
  const startedAt = performance.now();
  let sent = 0;
  let unblockedAfterRequests: number | null = null;
  let statusWhenUnblocked: number | null = null;
  while (sent < floodIdentities) {
    for (let i = 0; i < 500 && sent < floodIdentities; i += 1) {
      sent += 1;
      await handle(
        req("/v1/me", {
          "cf-connecting-ip": `10.${(rnd() % 255)}.${(rnd() % 255)}.${
            sent % 255
          }-${sent}`,
        }),
      );
    }
    const probe = await handle(req("/v1/me", { "cf-connecting-ip": victim }));
    if (probe !== 429 && unblockedAfterRequests === null) {
      unblockedAfterRequests = sent;
      statusWhenUnblocked = probe;
      break;
    }
  }
  const wallMs = performance.now() - startedAt;
  return {
    floodIdentitiesRequested: floodIdentities,
    floodRequestsSent: sent,
    seed: SEED,
    victimFailuresSpent: victimFailures,
    victimStatusBeforeFlood: lockedOut,
    victimStatusAfterFlood: statusWhenUnblocked,
    victimUnblockedAfterFloodRequests: unblockedAfterRequests,
    floodWallMs: Math.round(wallMs),
    floodRequestsPerSecond: Math.round(sent / (wallMs / 1_000)),
    note:
      "429 → 401 for the victim address means its auth-failure budget was erased mid-window",
  };
}

// ── 4. Retry-After is present and bounded on every 429 shape ────────────────
async function retryAfterHeaders() {
  const rows: Array<Record<string, unknown>> = [];
  // public page bucket (60/60s)
  const publicIp = "198.51.100.61";
  let last: Response | null = null;
  for (let i = 0; i < 62; i += 1) {
    last = await handleFull(req("/healthz", { "cf-connecting-ip": publicIp }));
    if (last.status === 429) break;
    await last.body?.cancel();
    last = null;
  }
  if (last) {
    rows.push({
      shape: "public page (healthz 60/60s)",
      status: last.status,
      retryAfter: Number(last.headers.get("Retry-After")),
      rateLimitLimit: Number(last.headers.get("RateLimit-Limit")),
      rateLimitRemaining: Number(last.headers.get("RateLimit-Remaining")),
      cacheControl: last.headers.get("Cache-Control"),
      windowSeconds: 60,
    });
    await last.body?.cancel();
  }
  // auth-failure bucket (30/300s)
  const failIp = "198.51.100.62";
  for (let i = 0; i < 30; i += 1) {
    await handle(
      req("/v1/me", {
        "cf-connecting-ip": failIp,
        Authorization: `Bearer ${fakeIdToken()}`,
      }),
    );
  }
  const failResponse = await handleFull(
    req("/v1/me", { "cf-connecting-ip": failIp }),
  );
  rows.push({
    shape: "auth-failure budget (30/300s)",
    status: failResponse.status,
    retryAfter: Number(failResponse.headers.get("Retry-After")),
    rateLimitLimit: Number(failResponse.headers.get("RateLimit-Limit")),
    rateLimitRemaining: Number(failResponse.headers.get("RateLimit-Remaining")),
    cacheControl: failResponse.headers.get("Cache-Control"),
    windowSeconds: 300,
  });
  await failResponse.body?.cancel();
  // refresh bucket (30/60s)
  const refreshIp = "198.51.100.63";
  for (let i = 0; i < 30; i += 1) {
    await handle(
      req("/v1/auth/refresh", { "cf-connecting-ip": refreshIp }, "POST"),
    );
  }
  const refreshResponse = await handleFull(
    req("/v1/auth/refresh", { "cf-connecting-ip": refreshIp }, "POST"),
  );
  rows.push({
    shape: "auth refresh budget (30/60s)",
    status: refreshResponse.status,
    retryAfter: Number(refreshResponse.headers.get("Retry-After")),
    rateLimitLimit: Number(refreshResponse.headers.get("RateLimit-Limit")),
    rateLimitRemaining: Number(
      refreshResponse.headers.get("RateLimit-Remaining"),
    ),
    cacheControl: refreshResponse.headers.get("Cache-Control"),
    windowSeconds: 60,
  });
  await refreshResponse.body?.cancel();
  return rows.map((row) => ({
    ...row,
    retryAfterWithinWindow: Number.isInteger(row.retryAfter) &&
      (row.retryAfter as number) >= 1 &&
      (row.retryAfter as number) <= (row.windowSeconds as number),
  }));
}

// ── 5. Oversized identity: how big a key one request can create ─────────────
async function oversizedIdentity() {
  const rows: Array<Record<string, unknown>> = [];
  for (const bytes of [1_024, 8_192, 32_768]) {
    const value = "9".repeat(bytes);
    let status: number | string;
    try {
      status = await handle(req("/v1/me", { "cf-connecting-ip": value }));
    } catch (error) {
      status = `rejected before the handler: ${(error as Error).message}`;
    }
    rows.push({
      identityBytes: bytes,
      status,
      acceptedByHandler: status === 401,
    });
  }
  return rows;
}

const report = {
  harness: "tools/adversarial/rate-limit-dos/handler_abuse.ts",
  target:
    "supabase/functions/api/index.ts (real Deno.serve handler, Redis unconfigured)",
  deno: Deno.version.deno,
  seed: SEED,
  measuredAt: new Date().toISOString(),
  retryAfterHeaders: await retryAfterHeaders(),
  unknownIdentityCollapse: await unknownIdentityCollapse(),
  sharedAddressLockout: await sharedAddressLockout(),
  oversizedIdentity: await oversizedIdentity(),
  spoofFloodWipe: await spoofFloodWipe(60_000),
};

await Deno.mkdir(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
await Deno.writeTextFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${OUT}`);
