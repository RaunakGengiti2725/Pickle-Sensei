// STRESS — public reads + router fallthrough, FAILURE INJECTION + LOAD
// (memory-mode: Upstash unconfigured, so rate limits and the auth cache run
// on their per-isolate L1 fallbacks).
//
// Unit under stress: the pre-route pipeline of handleRequest() in ../index.ts
// for GET|HEAD /healthz, /privacy, /terms (+ /support) and for every request
// the router does not know (unknown paths, unsupported methods), which runs
// body-cap → per-IP budget → auth-failure peek → authenticate() → per-user
// budget → `404 Unknown endpoint`.
//
//   deno test -A --no-check --config deno.json stress_public_fallthrough_faults.test.ts
//
// Campaign size is env-tunable (defaults are suite-friendly):
//   STRESS_ITER    randomized fault iterations          (default 150)
//   STRESS_LOAD_N  requests per route in the load run   (default 200)
//   STRESS_USERS   distinct users/IPs in the memory run (default 2000)
//   STRESS_SEED    campaign seed (every iteration seed derives from it)
//   STRESS_OUT_DIR where the JSON tables go
//
// Findings pinned here as REPRO (defect) — the test asserts the CURRENT
// behaviour so the suite stays green and the report classifies them BROKEN:
//   F1 provider-ID-token bearer + Supabase Auth OUTAGE → 401 "could not be
//      verified" (charged to the auth-failure budget) instead of a 503.
//   F2 the provider-ID-token exchange has no deadline: a hung Supabase Auth
//      holds the request for as long as the socket lives (the session-token
//      path answers 503 at AUTH_UPSTREAM_TIMEOUT_MS).
//   F3 clientIp() trusts a client-supplied `cf-connecting-ip`: distinct
//      spoofed values evade the per-IP and auth-failure budgets in-process
//      (whether the hosted gateway strips the header is an external check).

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import {
  apiRequest,
  envInt,
  fakeJwt,
  type Fault,
  freshIp,
  heapSnapshot,
  iterationSeed,
  latencySummary,
  loadStressHarness,
  NO_FAULT,
  observe,
  type Observed,
  Rng,
  type StressHarness,
  type Upstream,
  UPSTREAMS,
  userOf,
  withClockOffset,
  writeArtifact,
} from "./stress_fallthrough_harness.ts";

const STRESS_ITER = envInt("STRESS_ITER", 150);
const STRESS_LOAD_N = envInt("STRESS_LOAD_N", 200);
const STRESS_USERS = envInt("STRESS_USERS", 2_000);
const CAMPAIGN_SEED = envInt("STRESS_SEED", 20260904);
const AUTH_TIMEOUT_MS = 300;
const MEMORY_WINDOW_MAX = 20_000;
const AUTH_FAILURE_LIMIT = 30;
const PUBLIC_PAGE_LIMIT = 60;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PUBLIC_SUFFIXES = ["/healthz", "/support", "/privacy", "/terms"] as const;

type BearerKind =
  | "none"
  | "garbage"
  | "unknown_iss"
  | "expired_session"
  | "expired_provider"
  | "session"
  | "session_unknown"
  | "provider"
  | "provider_unknown";

const BEARER_KINDS: readonly BearerKind[] = [
  "none",
  "garbage",
  "unknown_iss",
  "expired_session",
  "expired_provider",
  "session",
  "session_unknown",
  "provider",
  "provider_unknown",
];

/** Weighted towards the public reads (GET/HEAD) this unit is about. */
const METHODS = [
  "GET",
  "GET",
  "GET",
  "HEAD",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "PROPFIND",
] as const;

/** Path variants: public-suffix matches (any prefix), near-misses that fall
 * through, and plain unknown routes. */
const PATHS = [
  "/healthz",
  "/privacy",
  "/terms",
  "/support",
  "/v1/healthz",
  "/v1/me/privacy",
  "/nested/deep/terms",
  "//healthz",
  "/v1/../healthz",
  "/%2e%2e/terms",
  "/healthz/",
  "/HEALTHZ",
  "/health%7A",
  "/healthzz",
  "/privacy.txt",
  "/terms-of-use",
  "/v1/nope",
  "/v1/me/nope",
  "/v1/",
  "/",
  "",
  "/v1/shots/../../privacy",
  "/v1/analysis-permits/x/finalize/extra",
  "/v1/" + "a".repeat(2_048),
  "/v1/%00/healthz",
  "/v1/nope/" + encodeURIComponent("é✓"),
] as const;

const QUERIES = ["", "?probe=1", "?healthz", "?a=%00&b=/terms"] as const;

interface Scenario {
  seed: number;
  method: string;
  path: string;
  query: string;
  bare: boolean;
  bearer: BearerKind;
  faults: Record<Upstream, Fault>;
}

interface Expectation {
  status: number;
  /** Substring the error message (or body) must contain. */
  message?: string;
  contentType: "json" | "text";
  retryAfter?: string;
  maxAuthUserCalls: number;
  maxAuthTokenCalls: number;
  /** Known-defect id when the CONTRACT expectation differs from behaviour. */
  finding?: "F1" | "F2";
  /** What the code does today for a finding (asserted so the pin is exact). */
  observedToday?: { status: number; message: string };
}

interface Row {
  id: string;
  seed: number;
  scenario: Omit<Scenario, "seed" | "faults"> & {
    faults: Partial<Record<Upstream, Fault>>;
  };
  expected: Expectation;
  observed: Observed & { calls: Record<Upstream, number> };
  outcome: "HELD" | "BROKEN:F1" | "BROKEN:F2" | "MISMATCH";
  detail?: string;
}

const isOutage = (fault: Fault): boolean => {
  switch (fault.kind) {
    case "none":
    case "slow_ok":
      return false;
    case "http":
      return ![400, 401, 403].includes(fault.status ?? 500);
    default:
      return true;
  }
};
const isRefusal = (fault: Fault): boolean =>
  fault.kind === "http" && [400, 401, 403].includes(fault.status ?? 500);

function retryAfterFor(fault: Fault): string {
  const n = Number(fault.retryAfter);
  return fault.kind === "http" && Number.isInteger(n) && n > 0
    ? String(n)
    : "2";
}

function isPublicRead(
  method: string,
  path: string,
  query: string,
  bare: boolean,
): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const url = new URL(
    `http://edge.stress.test${bare ? "" : "/functions/v1/api"}${path}${query}`,
  );
  return PUBLIC_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix));
}

function routeOf(
  method: string,
  path: string,
  query: string,
  bare: boolean,
): string {
  const url = new URL(
    `http://edge.stress.test${bare ? "" : "/functions/v1/api"}${path}${query}`,
  );
  const v1 = url.pathname.lastIndexOf("/v1/");
  return `${method} ${v1 >= 0 ? url.pathname.slice(v1) : url.pathname}`;
}

/** The contract for a scenario, derived from the documented behaviour of the
 * pre-route pipeline (not from the code path that implements it). */
function expectationFor(s: Scenario): Expectation {
  if (isPublicRead(s.method, s.path, s.query, s.bare)) {
    const url = new URL(
      `http://x${s.bare ? "" : "/functions/v1/api"}${s.path}${s.query}`,
    );
    return {
      status: 200,
      contentType: url.pathname.endsWith("/healthz") ? "json" : "text",
      maxAuthUserCalls: 0,
      maxAuthTokenCalls: 0,
    };
  }
  const unauthorized = (message: string): Expectation => ({
    status: 401,
    message,
    contentType: "json",
    maxAuthUserCalls: 0,
    maxAuthTokenCalls: 0,
  });
  switch (s.bearer) {
    case "none":
      return unauthorized("Missing bearer token.");
    case "garbage":
    case "unknown_iss":
      return unauthorized(
        "Bearer token is not a session token or a Google/Apple ID token.",
      );
    case "expired_session":
      return unauthorized("The session token has expired.");
    case "expired_provider":
      return unauthorized("The identity token has expired.");
    case "session":
    case "session_unknown": {
      const fault = s.faults.auth_user;
      if (isOutage(fault)) {
        return {
          status: 503,
          message:
            "Session verification is temporarily unavailable. Please try again.",
          contentType: "json",
          retryAfter: retryAfterFor(fault),
          maxAuthUserCalls: fault.kind === "reject" ? 3 : 1,
          maxAuthTokenCalls: 0,
        };
      }
      if (isRefusal(fault) || s.bearer === "session_unknown") {
        return {
          ...unauthorized("The session is no longer valid. Sign in again."),
          maxAuthUserCalls: 1,
        };
      }
      return {
        status: 404,
        message: `Unknown endpoint: ${
          routeOf(s.method, s.path, s.query, s.bare)
        }.`,
        contentType: "json",
        maxAuthUserCalls: 1,
        maxAuthTokenCalls: 0,
      };
    }
    case "provider":
    case "provider_unknown": {
      const fault = s.faults.auth_token;
      if (isOutage(fault)) {
        // CONTRACT: an outage is never a verdict on the credential (503 +
        // Retry-After, nothing charged to the auth-failure budget) — the
        // session-token branch honours this; the transitional provider-token
        // branch answers 401 today (F1) and, when the upstream hangs, waits
        // for it without a deadline (F2: the late answer is then served as
        // if nothing happened — 404 for a known user, 401 for an unknown one).
        const hang = fault.kind === "hang";
        const lateOk = hang && s.bearer === "provider";
        return {
          status: 503,
          message: "temporarily unavailable",
          contentType: "json",
          maxAuthUserCalls: 0,
          maxAuthTokenCalls: 1,
          finding: hang ? "F2" : "F1",
          observedToday: lateOk
            ? { status: 404, message: "Unknown endpoint: " }
            : {
              status: 401,
              message: "The identity token could not be verified.",
            },
        };
      }
      if (isRefusal(fault) || s.bearer === "provider_unknown") {
        return {
          ...unauthorized("The identity token could not be verified."),
          maxAuthTokenCalls: 1,
        };
      }
      return {
        status: 404,
        message: `Unknown endpoint: ${
          routeOf(s.method, s.path, s.query, s.bare)
        }.`,
        contentType: "json",
        maxAuthUserCalls: 0,
        maxAuthTokenCalls: 1,
      };
    }
  }
}

function bearerFor(
  h: StressHarness,
  kind: BearerKind,
  userIndex: number,
): string | null {
  switch (kind) {
    case "none":
      return null;
    case "garbage":
      return "not-a-jwt-at-all";
    case "unknown_iss":
      return fakeJwt({
        iss: "https://evil.example.test/auth/v2",
        sub: userOf(userIndex).id,
        exp: Math.floor(Date.now() / 1000) + 3600,
      });
    case "expired_session":
      return h.sessionFor(userOf(userIndex), -120);
    case "expired_provider":
      return h.providerTokenFor(userOf(userIndex), -120);
    case "session":
      return h.sessionFor(userOf(userIndex));
    case "session_unknown": {
      const token = h.sessionFor(userOf(userIndex));
      h.sessions.delete(token);
      return token;
    }
    case "provider":
      return h.providerTokenFor(
        userOf(userIndex, userIndex % 2 ? "apple" : "google"),
      );
    case "provider_unknown": {
      const user = userOf(userIndex, "apple");
      const token = h.providerTokenFor(user);
      h.users.delete(user.id);
      return token;
    }
  }
}

function callCounts(h: StressHarness, from: number): Record<Upstream, number> {
  const counts = {
    auth_user: 0,
    auth_token: 0,
    rest: 0,
    redis: 0,
    revenuecat: 0,
  };
  for (const call of h.calls.slice(from)) counts[call.upstream] += 1;
  return counts;
}

/** Invariants every response must satisfy regardless of scenario. */
function assertUniversal(row: Row): string | null {
  const o = row.observed;
  if (!o.requestId || !UUID.test(o.requestId)) {
    return `x-request-id missing/invalid: ${o.requestId}`;
  }
  if (o.status >= 500) {
    if (
      /stress fault|supabase|gotrue|PGRST|stack|at \w+ \(/i.test(o.bodyText)
    ) {
      return `5xx body leaks upstream detail: ${o.bodyText.slice(0, 120)}`;
    }
  }
  if (
    o.contentType?.includes("application/json") && o.cacheControl !== "no-store"
  ) {
    return `JSON response not no-store: ${o.cacheControl}`;
  }
  if (
    o.contentType?.startsWith("text/plain") &&
    o.cacheControl !== "public, max-age=3600"
  ) {
    return `legal text cache-control: ${o.cacheControl}`;
  }
  if (o.calls.rest !== 0) return `PostgREST touched ${o.calls.rest}×`;
  if (o.calls.revenuecat !== 0) {
    return `RevenueCat touched ${o.calls.revenuecat}×`;
  }
  if (o.calls.redis !== 0) {
    return `Redis touched while unconfigured ${o.calls.redis}×`;
  }
  return null;
}

function judge(row: Row): void {
  const { expected: e, observed: o } = row;
  const universal = assertUniversal(row);
  if (universal) {
    row.outcome = "MISMATCH";
    row.detail = universal;
    return;
  }
  if (
    o.calls.auth_user > e.maxAuthUserCalls ||
    o.calls.auth_token > e.maxAuthTokenCalls
  ) {
    row.outcome = "MISMATCH";
    row.detail =
      `auth round trips user=${o.calls.auth_user} token=${o.calls.auth_token} exceed ${e.maxAuthUserCalls}/${e.maxAuthTokenCalls}`;
    return;
  }
  if (e.finding && e.observedToday) {
    const pinned = o.status === e.observedToday.status &&
      (o.message ?? "").includes(e.observedToday.message);
    if (pinned) {
      row.outcome = `BROKEN:${e.finding}` as Row["outcome"];
      row.detail =
        `contract ${e.status} ${e.message}; today ${o.status} ${o.message}`;
      return;
    }
    row.outcome = "MISMATCH";
    row.detail =
      `known finding ${e.finding} did not reproduce: ${o.status} ${o.message}`;
    return;
  }
  if (o.status !== e.status) {
    row.outcome = "MISMATCH";
    row.detail = `status ${o.status} ≠ ${e.status} (${
      o.message ?? o.bodyText.slice(0, 80)
    })`;
    return;
  }
  if (e.message !== undefined && !(o.message ?? "").includes(e.message)) {
    row.outcome = "MISMATCH";
    row.detail = `message "${o.message}" lacks "${e.message}"`;
    return;
  }
  if (
    e.contentType === "json" && !o.contentType?.includes("application/json")
  ) {
    row.outcome = "MISMATCH";
    row.detail = `content-type ${o.contentType} not JSON`;
    return;
  }
  if (
    e.contentType === "text" && o.contentType !== "text/plain; charset=utf-8"
  ) {
    row.outcome = "MISMATCH";
    row.detail = `content-type ${o.contentType} not text/plain`;
    return;
  }
  if (e.retryAfter !== undefined && o.retryAfter !== e.retryAfter) {
    row.outcome = "MISMATCH";
    row.detail = `Retry-After ${o.retryAfter} ≠ ${e.retryAfter}`;
    return;
  }
  if (
    e.status === 200 && e.contentType === "json" && o.bodyText !== '{"ok":true}'
  ) {
    row.outcome = "MISMATCH";
    row.detail = `healthz body ${o.bodyText}`;
    return;
  }
  if (
    e.status === 200 && e.contentType === "text" &&
    !o.bodyText.startsWith("PICKLE SENSEI")
  ) {
    row.outcome = "MISMATCH";
    row.detail = `legal body head ${o.bodyText.slice(0, 40)}`;
    return;
  }
  row.outcome = "HELD";
}

async function runScenario(
  h: StressHarness,
  id: string,
  s: Scenario,
  userIndex: number,
): Promise<Row> {
  h.faults = { ...s.faults };
  const token = bearerFor(h, s.bearer, userIndex);
  const from = h.calls.length;
  const observed = await observe(
    h,
    apiRequest(s.method, `${s.path}${s.query}`, { token, bare: s.bare }),
  );
  const row: Row = {
    id,
    seed: s.seed,
    scenario: {
      method: s.method,
      path: s.path,
      query: s.query,
      bare: s.bare,
      bearer: s.bearer,
      faults: Object.fromEntries(
        UPSTREAMS.filter((u) => s.faults[u].kind !== "none").map((
          u,
        ) => [u, s.faults[u]]),
      ),
    },
    expected: expectationFor(s),
    observed: {
      ...observed,
      bodyText: observed.bodyText.slice(0, 200),
      calls: callCounts(h, from),
    },
    outcome: "HELD",
  };
  judge(row);
  h.faults = {
    auth_user: NO_FAULT,
    auth_token: NO_FAULT,
    rest: NO_FAULT,
    redis: NO_FAULT,
    revenuecat: NO_FAULT,
  };
  return row;
}

const noFaults = (): Record<Upstream, Fault> => ({
  auth_user: NO_FAULT,
  auth_token: NO_FAULT,
  rest: NO_FAULT,
  redis: NO_FAULT,
  revenuecat: NO_FAULT,
});

// ─── 1. Deterministic fault matrix (every upstream × every fault kind) ───────

const AUTH_FAULTS: Array<[string, Fault]> = [
  ["reject", { kind: "reject" }],
  ["hang", { kind: "hang", hangMs: 900 }],
  ["http500", { kind: "http", status: 500 }],
  ["http502", { kind: "http", status: 502 }],
  ["http503-ra7", { kind: "http", status: 503, retryAfter: "7" }],
  ["http504", { kind: "http", status: 504 }],
  ["http429-ra13", { kind: "http", status: 429, retryAfter: "13" }],
  ["http429-badra", { kind: "http", status: 429, retryAfter: "soon" }],
  ["http404", { kind: "http", status: 404 }],
  ["http400", { kind: "http", status: 400 }],
  ["http401", { kind: "http", status: 401 }],
  ["http403", { kind: "http", status: 403 }],
  ["malformed_body", { kind: "malformed_body" }],
  ["wrong_shape", { kind: "wrong_shape" }],
  ["empty_body", { kind: "empty_body" }],
  ["slow_ok", { kind: "slow_ok", delayMs: 120 }],
];

interface MatrixCase {
  id: string;
  upstream: Upstream;
  fault: Fault;
  method: string;
  path: string;
  bearer: BearerKind;
}

function buildMatrix(): MatrixCase[] {
  const cases: MatrixCase[] = [];
  for (const [name, fault] of AUTH_FAULTS) {
    cases.push({
      id: `auth_user/${name}/POST-healthz/session`,
      upstream: "auth_user",
      fault,
      method: "POST",
      path: "/healthz",
      bearer: "session",
    });
  }
  for (const [name, fault] of AUTH_FAULTS) {
    cases.push({
      id: `auth_token/${name}/DELETE-terms/provider`,
      upstream: "auth_token",
      fault,
      method: "DELETE",
      path: "/terms",
      bearer: "provider",
    });
  }
  const bystanders: Array<[string, string, BearerKind]> = [
    ["GET", "/healthz", "none"],
    ["HEAD", "/privacy", "none"],
    ["GET", "/terms", "none"],
    ["PATCH", "/v1/nope", "none"],
    ["GET", "/v1/nope", "session"],
    ["OPTIONS", "/v1/me", "provider"],
  ];
  for (const upstream of ["rest", "revenuecat", "redis"] as const) {
    for (
      const [name, fault] of [
        ["reject", { kind: "reject" } as Fault],
        ["hang", { kind: "hang", hangMs: 900 } as Fault],
        ["http500", { kind: "http", status: 500 } as Fault],
        ["malformed_body", { kind: "malformed_body" } as Fault],
      ] as Array<[string, Fault]>
    ) {
      for (const [method, path, bearer] of bystanders) {
        cases.push({
          id: `${upstream}/${name}/${method}-${
            path.replace(/\//g, "_")
          }/${bearer}`,
          upstream,
          fault,
          method,
          path,
          bearer,
        });
      }
    }
  }
  return cases;
}

Deno.test("fault matrix: every upstream × fault kind → user-visible class + recovery", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const matrix = buildMatrix();
  assert(matrix.length >= 40, `matrix has ${matrix.length} cases`);
  const rows: Array<Row & { recovery: Row }> = [];
  let userIndex = 100_000;
  for (const c of matrix) {
    userIndex += 1;
    const faults = noFaults();
    faults[c.upstream] = c.fault;
    const scenario: Scenario = {
      seed: 0,
      method: c.method,
      path: c.path,
      query: "",
      bare: false,
      bearer: c.bearer,
      faults,
    };
    const started = performance.now();
    const row = await runScenario(h, c.id, scenario, userIndex);
    const elapsed = performance.now() - started;
    // Recovery: same bearer kind, upstream healthy again → the healthy class.
    const recovery = await runScenario(
      h,
      `${c.id}/recovery`,
      { ...scenario, faults: noFaults() },
      userIndex,
    );
    rows.push({ ...row, recovery });

    assert(
      row.outcome !== "MISMATCH",
      `${c.id}: ${row.detail} (observed ${row.observed.status} ${row.observed.message})`,
    );
    assertEquals(
      recovery.outcome,
      "HELD",
      `${c.id}/recovery: ${recovery.detail}`,
    );

    // Deadline behaviour: the session-token branch is bounded by
    // AUTH_UPSTREAM_TIMEOUT_MS; the provider branch (F2) waits the whole hang.
    if (c.fault.kind === "hang" && c.upstream === "auth_user") {
      assert(
        elapsed < 700,
        `session hang answered in ${elapsed}ms (deadline ${AUTH_TIMEOUT_MS})`,
      );
    }
    if (c.fault.kind === "hang" && c.upstream === "auth_token") {
      assert(
        elapsed >= (c.fault.hangMs ?? 0) - 5,
        `F2 did not reproduce: provider hang answered in ${elapsed}ms`,
      );
    }
    if (
      c.fault.kind === "hang" &&
      (c.upstream === "rest" || c.upstream === "revenuecat")
    ) {
      assert(
        elapsed < 200,
        `${c.id}: bystander hang delayed the response ${elapsed}ms`,
      );
    }
  }
  const held = rows.filter((r) => r.outcome === "HELD").length;
  const broken = rows.filter((r) => r.outcome.startsWith("BROKEN")).length;
  const path = await writeArtifact("fault_matrix_memory.json", {
    mode: "memory",
    authTimeoutMs: AUTH_TIMEOUT_MS,
    cases: rows.length,
    held,
    broken,
    rows,
  });
  console.warn(
    `[stress] fault matrix (memory): ${rows.length} cases, ${held} HELD, ${broken} BROKEN (F1/F2) → ${path}`,
  );
});

// ─── 2. Randomized seeded campaign ───────────────────────────────────────────

const RANDOM_FAULTS: Array<{ weight: number; make: (rng: Rng) => Fault }> = [
  { weight: 30, make: () => NO_FAULT },
  { weight: 8, make: () => ({ kind: "reject" }) },
  {
    weight: 20,
    make: (rng) => {
      const status = rng.pick([
        500,
        502,
        503,
        504,
        429,
        404,
        400,
        401,
        403,
        418,
        520,
      ]);
      const retryAfter = rng.chance(0.4) ? String(1 + rng.int(30)) : undefined;
      return { kind: "http", status, retryAfter };
    },
  },
  { weight: 6, make: () => ({ kind: "malformed_body" }) },
  { weight: 6, make: () => ({ kind: "wrong_shape" }) },
  { weight: 6, make: () => ({ kind: "empty_body" }) },
  { weight: 8, make: (rng) => ({ kind: "slow_ok", delayMs: 1 + rng.int(25) }) },
  { weight: 3, make: () => ({ kind: "hang", hangMs: 600 }) },
];

function drawFault(rng: Rng): Fault {
  const total = RANDOM_FAULTS.reduce((sum, f) => sum + f.weight, 0);
  let roll = rng.int(total);
  for (const entry of RANDOM_FAULTS) {
    if (roll < entry.weight) return entry.make(rng);
    roll -= entry.weight;
  }
  return NO_FAULT;
}

function scenarioFromSeed(seed: number): Scenario {
  const rng = new Rng(seed);
  const faults = noFaults();
  // One or two upstreams faulted per iteration (the rest healthy).
  const faultedCount = rng.chance(0.3) ? 2 : 1;
  for (let i = 0; i < faultedCount; i += 1) {
    faults[rng.pick(UPSTREAMS)] = drawFault(rng);
  }
  return {
    seed,
    method: rng.pick(METHODS),
    path: rng.pick(PATHS),
    query: rng.pick(QUERIES),
    bare: rng.chance(0.15),
    bearer: rng.pick(BEARER_KINDS),
    faults,
  };
}

Deno.test(`randomized campaign: ${STRESS_ITER} seeded fault iterations (STRESS_ITER)`, async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const rows: Row[] = [];
  const started = performance.now();
  for (let i = 0; i < STRESS_ITER; i += 1) {
    const seed = iterationSeed(CAMPAIGN_SEED, i);
    rows.push(
      await runScenario(h, `rand/${i}`, scenarioFromSeed(seed), 200_000 + i),
    );
  }
  const elapsedMs = performance.now() - started;

  const mismatches = rows.filter((r) => r.outcome === "MISMATCH");
  // Flake triage: every non-HELD seed (unexplained mismatch OR pinned finding)
  // is replayed 10× and the rate at which it reproduces is recorded. One
  // replay set per distinct (outcome, bearer, fault kind) keeps the hang
  // cases from dominating the default run.
  const replays: Array<{
    seed: number;
    outcome: string;
    reproduced: number;
    of: number;
    details: string[];
  }> = [];
  const replayKeys = new Set<string>();
  for (const r of rows) {
    if (r.outcome === "HELD") continue;
    const faultKinds = Object.values(r.scenario.faults).map((f) => f.kind)
      .sort().join("+");
    const key = r.outcome === "MISMATCH"
      ? `mismatch:${r.seed}`
      : `${r.outcome}:${r.scenario.bearer}:${faultKinds}`;
    if (replayKeys.has(key)) continue;
    replayKeys.add(key);
    const details: string[] = [];
    let reproduced = 0;
    for (let k = 0; k < 10; k += 1) {
      const again = await runScenario(
        h,
        `${r.id}/replay${k}`,
        scenarioFromSeed(r.seed),
        300_000 + k,
      );
      if (again.outcome === r.outcome) reproduced += 1;
      else details.push(`${again.outcome}: ${again.detail ?? ""}`);
    }
    replays.push({
      seed: r.seed,
      outcome: r.outcome,
      reproduced,
      of: 10,
      details: [...new Set(details)],
    });
  }

  const byOutcome: Record<string, number> = {};
  for (const r of rows) byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
  const byBearer: Record<string, number> = {};
  for (const r of rows) {
    byBearer[r.scenario.bearer] = (byBearer[r.scenario.bearer] ?? 0) + 1;
  }
  const publicHits = rows.filter((r) => r.expected.status === 200).length;

  const path = await writeArtifact("random_campaign_memory.json", {
    mode: "memory",
    campaignSeed: CAMPAIGN_SEED,
    iterations: rows.length,
    elapsedMs: Math.round(elapsedMs),
    byOutcome,
    byBearer,
    publicReadIterations: publicHits,
    fallthroughIterations: rows.length - publicHits,
    mismatchSeeds: mismatches.map((m) => m.seed),
    replays,
    rows,
  });
  console.warn(
    `[stress] random campaign (memory): ${rows.length} iterations in ${
      Math.round(elapsedMs)
    }ms → ${JSON.stringify(byOutcome)} → ${path}`,
  );
  assertEquals(
    mismatches.map((m) => `${m.seed}: ${m.detail}`),
    [],
    "unexplained mismatches (replay rates in the artifact)",
  );
});

// ─── 3. Budget semantics under failure ───────────────────────────────────────

Deno.test("auth-failure budget: outage 503s on session bearers are NOT charged; refusals are", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const ip = freshIp();
  const token = h.sessionFor(userOf(400_001));
  h.faults.auth_user = { kind: "http", status: 503 };
  for (let i = 0; i < AUTH_FAILURE_LIMIT + 5; i += 1) {
    const o = await observe(h, apiRequest("GET", "/v1/nope", { token, ip }));
    assertEquals(o.status, 503, `outage request ${i} → ${o.status}`);
  }
  h.faults.auth_user = NO_FAULT;
  const recovered = await observe(
    h,
    apiRequest("GET", "/v1/nope", { token, ip }),
  );
  assertEquals(
    recovered.status,
    404,
    "after recovery the IP is not locked out",
  );

  // Refusals ARE charged: 30 bad session bearers → the 31st request is 429
  // before Supabase Auth is consulted.
  const ip2 = freshIp();
  for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
    const bad = h.sessionFor(userOf(410_000 + i));
    h.sessions.delete(bad);
    const o = await observe(
      h,
      apiRequest("GET", "/v1/nope", { token: bad, ip: ip2 }),
    );
    assertEquals(o.status, 401);
  }
  const from = h.calls.length;
  const good = h.sessionFor(userOf(400_002));
  const locked = await observe(
    h,
    apiRequest("GET", "/v1/nope", { token: good, ip: ip2 }),
  );
  assertEquals(locked.status, 429);
  assertMatch(locked.retryAfter ?? "", /^\d+$/);
  assertEquals(
    h.calls.length - from,
    0,
    "a locked-out IP never reaches Supabase Auth",
  );
  // Recovery: the 5-minute window rolls over.
  const later = await withClockOffset(
    301_000,
    () => observe(h, apiRequest("GET", "/v1/nope", { token: good, ip: ip2 })),
  );
  assertEquals(later.status, 404);
});

Deno.test("REPRO (defect F1): a Supabase Auth outage locks out provider-token IPs via the auth-failure budget", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const ip = freshIp();
  h.faults.auth_token = { kind: "http", status: 503, retryAfter: "5" };
  const statuses: number[] = [];
  for (let i = 0; i < AUTH_FAILURE_LIMIT + 1; i += 1) {
    const token = h.providerTokenFor(userOf(420_000 + i));
    statuses.push(
      (await observe(h, apiRequest("GET", "/v1/nope", { token, ip }))).status,
    );
  }
  // Contract: 31 × 503 (+ Retry-After), never a 401, never a lock-out.
  // Today: 30 × 401 then 429 — an outage spent the whole auth-failure budget.
  assertEquals(
    statuses.slice(0, AUTH_FAILURE_LIMIT).every((s) => s === 401),
    true,
  );
  assertEquals(statuses[AUTH_FAILURE_LIMIT], 429);
  h.faults.auth_token = NO_FAULT;
  const afterRecovery = await observe(
    h,
    apiRequest("GET", "/v1/nope", {
      token: h.providerTokenFor(userOf(420_999)),
      ip,
    }),
  );
  assertEquals(
    afterRecovery.status,
    429,
    "the IP stays locked out after the outage ends",
  );
  const path = await writeArtifact("finding_F1_provider_outage_lockout.json", {
    ip: "one client IP",
    fault: h.faults,
    statuses,
    afterRecoveryStatus: afterRecovery.status,
  });
  console.warn(`[stress] F1 repro → ${path}`);
});

Deno.test("REPRO (defect F3): client-supplied cf-connecting-ip is trusted for every per-IP budget", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const peer = freshIp();
  // Same real peer (last x-forwarded-for hop), a different spoofed edge IP
  // per request → the auth-failure budget never trips.
  const spoofed: number[] = [];
  for (let i = 0; i < AUTH_FAILURE_LIMIT * 2; i += 1) {
    const o = await observe(
      h,
      apiRequest("POST", "/healthz", {
        ip: peer,
        headers: { "cf-connecting-ip": `10.${(i >> 8) & 255}.${i & 255}.7` },
      }),
    );
    spoofed.push(o.status);
  }
  assertEquals(
    spoofed.every((s) => s === 401),
    true,
    "budget evaded with spoofed cf-connecting-ip",
  );
  // Control: the same requests with an honest (single) client IP trip at 31.
  const honest: number[] = [];
  for (let i = 0; i < AUTH_FAILURE_LIMIT + 1; i += 1) {
    honest.push(
      (await observe(h, apiRequest("POST", "/healthz", { ip: peer }))).status,
    );
  }
  assertEquals(honest[AUTH_FAILURE_LIMIT], 429);
  // Public-page budget too: 60/min per IP on /healthz is evaded the same way.
  const peer2 = freshIp();
  const pub: number[] = [];
  for (let i = 0; i < PUBLIC_PAGE_LIMIT + 10; i += 1) {
    pub.push(
      (
        await observe(
          h,
          apiRequest("GET", "/healthz", {
            ip: peer2,
            headers: {
              "cf-connecting-ip": `10.9.${(i >> 8) & 255}.${i & 255}`,
            },
          }),
        )
      ).status,
    );
  }
  assertEquals(pub.every((s) => s === 200), true);
  const path = await writeArtifact("finding_F3_cf_connecting_ip_spoof.json", {
    spoofedAuthFailStatuses: spoofed,
    honestAuthFailStatuses: honest,
    spoofedHealthzStatuses: pub,
  });
  console.warn(`[stress] F3 repro → ${path}`);
});

// ─── 4. Load: latency + round trips per request ──────────────────────────────

interface LoadRoute {
  name: string;
  method: string;
  path: string;
  bearer: BearerKind;
  expectStatus: number;
}

const LOAD_ROUTES: LoadRoute[] = [
  {
    name: "GET /healthz",
    method: "GET",
    path: "/healthz",
    bearer: "none",
    expectStatus: 200,
  },
  {
    name: "HEAD /healthz",
    method: "HEAD",
    path: "/healthz",
    bearer: "none",
    expectStatus: 200,
  },
  {
    name: "GET /privacy",
    method: "GET",
    path: "/privacy",
    bearer: "none",
    expectStatus: 200,
  },
  {
    name: "GET /terms",
    method: "GET",
    path: "/terms",
    bearer: "none",
    expectStatus: 200,
  },
  {
    name: "HEAD /terms",
    method: "HEAD",
    path: "/terms",
    bearer: "none",
    expectStatus: 200,
  },
  {
    name: "POST /healthz (no bearer)",
    method: "POST",
    path: "/healthz",
    bearer: "none",
    expectStatus: 401,
  },
  {
    name: "GET /v1/nope (session bearer)",
    method: "GET",
    path: "/v1/nope",
    bearer: "session",
    expectStatus: 404,
  },
  {
    name: "PUT /terms (provider bearer)",
    method: "PUT",
    path: "/terms",
    bearer: "provider",
    expectStatus: 404,
  },
];

Deno.test(`load: ${STRESS_LOAD_N} requests per route — p50/p95 + upstream round trips (STRESS_LOAD_N)`, async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const report: Record<string, unknown> = {};
  let total = 0;
  for (const route of LOAD_ROUTES) {
    const token = bearerFor(
      h,
      route.bearer,
      500_000 + LOAD_ROUTES.indexOf(route),
    );
    const samples: number[] = [];
    const roundTrips: Record<Upstream, number[]> = {
      auth_user: [],
      auth_token: [],
      rest: [],
      redis: [],
      revenuecat: [],
    };
    const statuses: Record<string, number> = {};
    const accessLogFrom = h.accessLog.length;
    // The per-user budget is 240/min: every chunk of 200 requests runs in its
    // own clock minute (the auth cache row outlives ~9 such minutes).
    const CHUNK = 200;
    const chunks = Math.ceil(STRESS_LOAD_N / CHUNK);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      await withClockOffset(chunk * 60_000, async () => {
        const end = Math.min(STRESS_LOAD_N, (chunk + 1) * CHUNK);
        for (let i = chunk * CHUNK; i < end; i += 1) {
          const from = h.calls.length;
          const o = await observe(
            h,
            apiRequest(route.method, route.path, { token }),
          );
          samples.push(o.ms);
          statuses[o.status] = (statuses[o.status] ?? 0) + 1;
          const counts = callCounts(h, from);
          for (const u of UPSTREAMS) roundTrips[u].push(counts[u]);
          total += 1;
        }
      });
    }
    const maxTrips = Object.fromEntries(
      UPSTREAMS.map((u) => [u, Math.max(...roundTrips[u])]),
    );
    const totalTrips = Object.fromEntries(
      UPSTREAMS.map((u) => [u, roundTrips[u].reduce((a, b) => a + b, 0)]),
    );
    // Concurrent burst of the same route: statuses must not change.
    const burstFrom = h.calls.length;
    const burst = await withClockOffset(chunks * 60_000, () =>
      Promise.all(
        Array.from({ length: Math.min(100, STRESS_LOAD_N) }, () =>
          observe(h, apiRequest(route.method, route.path, { token }))),
      ));
    total += burst.length;
    const burstStatuses: Record<string, number> = {};
    for (const o of burst) {
      burstStatuses[o.status] = (burstStatuses[o.status] ?? 0) + 1;
    }
    report[route.name] = {
      latency: latencySummary(samples),
      statuses,
      burst: {
        n: burst.length,
        statuses: burstStatuses,
        upstreamCalls: callCounts(h, burstFrom),
      },
      supabaseRoundTripsPerRequest: {
        max: maxTrips,
        total: totalTrips,
        firstRequest: Object.fromEntries(
          UPSTREAMS.map((u) => [u, roundTrips[u][0]]),
        ),
      },
    };
    assertEquals(
      statuses,
      { [route.expectStatus]: STRESS_LOAD_N },
      `${route.name} statuses`,
    );
    assertEquals(
      burstStatuses,
      { [route.expectStatus]: burst.length },
      `${route.name} burst`,
    );
    assertEquals(
      h.accessLog.length - accessLogFrom,
      STRESS_LOAD_N + burst.length,
      `${route.name}: exactly one access-log line per request`,
    );
    for (const line of h.accessLog.slice(accessLogFrom, accessLogFrom + 50)) {
      assert(
        !line.includes("x-forwarded-for") && !/203\.0\./.test(line),
        "access log carries no IP",
      );
      assert(
        token === null || !line.includes(token.slice(0, 24)),
        "access log carries no bearer",
      );
    }
    // Public reads and bearer-less fallthrough touch NO upstream at all;
    // authenticated fallthrough costs exactly one Supabase Auth round trip per
    // cache window (the first request), then zero.
    const supabaseTotal = totalTrips.auth_user + totalTrips.auth_token +
      totalTrips.rest;
    if (route.bearer === "none") {
      assertEquals(supabaseTotal, 0, `${route.name} upstream calls`);
    } else {
      assert(
        supabaseTotal >= 1,
        `${route.name}: first request must verify with Supabase Auth`,
      );
      assert(
        supabaseTotal <= Math.ceil(chunks / 9),
        `${route.name}: ${supabaseTotal} Supabase round trips over ${STRESS_LOAD_N} requests (cache not effective)`,
      );
    }
    assert(
      Math.max(maxTrips.auth_user, maxTrips.auth_token, maxTrips.rest) <= 3,
      `${route.name}: a request did >3 Supabase round trips`,
    );
  }
  const path = await writeArtifact("load_memory.json", {
    mode: "memory",
    perRoute: STRESS_LOAD_N,
    totalRequests: total,
    routes: report,
  });
  console.warn(`[stress] load (memory): ${total} requests → ${path}`);
});

// ─── 5. Memory of the L1 caches under many distinct users/IPs ────────────────

Deno.test(`memory: ${STRESS_USERS} distinct IPs and users through the L1 caches (STRESS_USERS)`, async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  const before = heapSnapshot();

  // Distinct IPs on the public route: one rate-limit window per IP.
  let ok = 0;
  const t0 = performance.now();
  for (let i = 0; i < STRESS_USERS; i += 1) {
    const ip = `198.18.${(i >> 8) & 255}.${i & 255}`;
    const response = await h.handler(
      apiRequest("GET", "/healthz", {
        ip,
        headers: { "cf-connecting-ip": `ip-${i}` },
      }),
    );
    await response.text();
    if (response.status === 200) ok += 1;
  }
  const healthzMs = performance.now() - t0;
  h.accessLog = [];
  const afterIps = heapSnapshot();
  assertEquals(ok, STRESS_USERS);

  // Distinct users on the fallthrough: one auth-cache row + windows per user.
  // The fake's own bookkeeping (users, sessions, recorded calls) is dropped
  // before each heap snapshot so growth is attributable to the production L1s.
  let notFound = 0;
  let authCalls = 0;
  const warmTokens: string[] = [];
  const warmStart = Math.max(0, STRESS_USERS - 1_000);
  const t1 = performance.now();
  for (let i = 0; i < STRESS_USERS; i += 1) {
    const token = h.sessionFor(userOf(600_000 + i));
    if (i >= warmStart) warmTokens.push(token);
    const from = h.calls.length;
    const response = await h.handler(apiRequest("GET", "/v1/nope", { token }));
    await response.text();
    if (response.status === 404) notFound += 1;
    authCalls += h.calls.length - from;
    if (h.calls.length > 5_000) h.calls = [];
    if (h.sessions.size > 5_000) {
      h.sessions.clear();
      h.users.clear();
    }
  }
  const usersMs = performance.now() - t1;
  h.calls = [];
  h.accessLog = [];
  h.sessions.clear();
  h.users.clear();
  const afterUsers = heapSnapshot();
  assertEquals(notFound, STRESS_USERS);
  assertEquals(
    authCalls,
    STRESS_USERS,
    "exactly one Supabase Auth round trip per new user",
  );

  // Warm users are still served from L1 after the campaign (unless evicted by
  // the 5 000-row cap — the last 1 000 users are always inside it).
  const warmFrom = h.calls.length;
  let warmHits = 0;
  for (const token of warmTokens.slice(0, 1_000)) {
    const response = await h.handler(apiRequest("GET", "/v1/nope", { token }));
    await response.text();
    if (response.status === 404) warmHits += 1;
  }
  const warmAuthCalls = h.calls.length - warmFrom;
  h.accessLog = [];
  const afterWarm = heapSnapshot();

  const path = await writeArtifact("memory_l1_caches.json", {
    mode: "memory",
    distinctIps: STRESS_USERS,
    distinctUsers: STRESS_USERS,
    l1Caps: { authCacheEntries: 5_000, rateLimitWindows: MEMORY_WINDOW_MAX },
    heap: {
      before,
      afterDistinctIps: afterIps,
      afterDistinctUsers: afterUsers,
      afterWarmReplay: afterWarm,
    },
    healthz: { ok, ms: Math.round(healthzMs) },
    fallthrough: {
      notFound,
      authRoundTrips: authCalls,
      ms: Math.round(usersMs),
    },
    warmReplay: {
      users: warmTokens.slice(0, 1_000).length,
      hits: warmHits,
      authRoundTrips: warmAuthCalls,
    },
  });
  console.warn(
    `[stress] memory: heap ${before.heapUsed_mb}MB → ${afterIps.heapUsed_mb}MB (IPs) → ${afterUsers.heapUsed_mb}MB (users) → ${afterWarm.heapUsed_mb}MB (warm) → ${path}`,
  );
  assertEquals(warmHits, warmTokens.slice(0, 1_000).length);
  assertEquals(
    warmAuthCalls,
    0,
    "warm users are L1 hits (no Supabase Auth round trip)",
  );
  // Bounded growth: both L1 maps are capped, so heap must not scale with users
  // past the caps (generous ceiling: 64 MB of growth over the run).
  assert(
    afterWarm.heapUsed_mb - before.heapUsed_mb < 64,
    `heap grew ${afterWarm.heapUsed_mb - before.heapUsed_mb}MB`,
  );
});

Deno.test("memory-mode rate-limit map: 20 001 live windows wipe EVERY budget (auth-failure lock-out included)", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  // Frozen clock: no window may expire mid-fill, so the map really fills up.
  await withClockOffset(0, async () => {
    // Lock an IP out via the auth-failure budget.
    const victim = freshIp();
    for (let i = 0; i < AUTH_FAILURE_LIMIT; i += 1) {
      assertEquals(
        (await observe(h, apiRequest("POST", "/healthz", { ip: victim })))
          .status,
        401,
      );
    }
    assertEquals(
      (await observe(h, apiRequest("POST", "/healthz", { ip: victim }))).status,
      429,
    );
    // Fill the per-isolate window map with fresh, unexpired keys.
    const t0 = performance.now();
    for (let i = 0; i <= MEMORY_WINDOW_MAX; i += 1) {
      const response = await h.handler(
        apiRequest("GET", "/healthz", {
          headers: { "cf-connecting-ip": `wipe-${i}` },
        }),
      );
      await response.text();
    }
    const fillMs = performance.now() - t0;
    const after = await observe(
      h,
      apiRequest("POST", "/healthz", { ip: victim }),
    );
    // Documented degraded mode (rateLimit.ts memoryIncr clears the map when it
    // is full of live windows): the lock-out is gone. Pinned as the CURRENT
    // behaviour so a change in either direction is visible.
    assertEquals(
      after.status,
      401,
      "lock-out survived the sweep — memoryIncr changed",
    );
    const path = await writeArtifact("memory_window_sweep.json", {
      victimBeforeSweep: 429,
      liveWindowsInserted: MEMORY_WINDOW_MAX + 1,
      fillMs: Math.round(fillMs),
      victimAfterSweep: after.status,
    });
    console.warn(`[stress] window sweep → ${path}`);
  });
});

// ─── 6. Surface invariants worth pinning for the report ──────────────────────

Deno.test("public reads: HEAD mirrors GET headers; unknown-method on a public path is an ordinary 401", async () => {
  const h = await loadStressHarness({
    redis: false,
    authTimeoutMs: AUTH_TIMEOUT_MS,
  });
  for (const path of ["/healthz", "/privacy", "/terms", "/support"]) {
    const get = await observe(h, apiRequest("GET", path));
    const head = await observe(h, apiRequest("HEAD", path));
    assertEquals(get.status, 200);
    assertEquals(head.status, 200);
    assertEquals(head.contentType, get.contentType);
    assertEquals(head.cacheControl, get.cacheControl);
    for (
      const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "PROPFIND"]
    ) {
      const o = await observe(h, apiRequest(method, path));
      assertEquals(o.status, 401, `${method} ${path}`);
      assertEquals(o.message, "Missing bearer token.");
      assertEquals(o.cacheControl, "no-store");
    }
  }
  // The 404 echoes the normalized route (method + path from the last /v1/),
  // JSON-encoded under application/json + nosniff.
  const token = h.sessionFor(userOf(700_001));
  const hostile = await observe(
    h,
    apiRequest("GET", "/v1/%3Cscript%3Ealert(1)%3C%2Fscript%3E", { token }),
  );
  assertEquals(hostile.status, 404);
  assertStringIncludes(hostile.contentType ?? "", "application/json");
  assertStringIncludes(
    hostile.message ?? "",
    "Unknown endpoint: GET /v1/%3Cscript%3E",
  );
  assert(
    !hostile.bodyText.includes("<script>"),
    "percent-encoding is preserved, never decoded",
  );
});
