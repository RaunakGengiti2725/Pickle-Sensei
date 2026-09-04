// stress-route-get-v1-me-access / lens failure-load — FAILURE INJECTION.
//
// Each upstream GET /v1/me/access can reach (Supabase Auth, PostgREST,
// Upstash Redis, RevenueCat) is made to fail / time out / answer malformed in
// turn, against the REAL handler (stress_access_harness.ts, Redis ENABLED so
// the L2 paths run too). For every case the harness records the user-visible
// error class (status, error.code/message, Retry-After, x-request-id), the
// Supabase round trips the request cost, whether the generic 5xx leaked any
// internal detail, and RECOVERABILITY: the fault is lifted and the SAME
// bearer retried — it must be served (200) without the user re-signing in.
//
// Seeded: every case derives its user / token / IP / counters from
// caseSeed(STRESS_SEED, caseId). Replay one case:
//   STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
//     stress_v1_me_access_faults.test.ts --filter "D07"
// Results table (seed → outcome) is written to
//   <STRESS_OUT_DIR|artifacts/stress-route-get-v1-me-access/latest/>faults.json

import { assert, assertEquals } from "@std/assert";
import {
  accessInvariantViolations,
  accessRequest,
  AUTH_TIMEOUT_MS,
  caseSeed,
  type Fault,
  histogram,
  ipFor,
  leakedDetail,
  loadStressHarness,
  observe,
  type Observed,
  Prng,
  sleep,
  STRESS_SEED,
  type StressHarness,
  type Upstream,
  writeJson,
} from "./stress_access_harness.ts";

/** User-visible error class: what the app does differs only by class —
 * served, sign-in-again (refused), slow down (limited), retry later
 * (unavailable). The exact status is recorded; the CLASS is asserted. */
type ErrorClass = "served" | "refused" | "limited" | "unavailable" | "other";

function classOf(status: number): ErrorClass {
  if (status >= 200 && status < 300) return "served";
  if (status === 401 || status === 403) return "refused";
  if (status === 429) return "limited";
  if (status >= 500) return "unavailable";
  return "other";
}

type Expect = { status: 200 } | { status: 401 } | { status: 503 } | { status: 429 };

interface FaultCase {
  id: string;
  upstream: Upstream;
  title: string;
  fault: Fault;
  /** Which bearer kind the request carries. */
  bearer?: "session" | "provider";
  /** Warm the auth cache with a successful request BEFORE injecting. */
  warm?: boolean;
  expect: Expect;
  /** Extra assertions on the observed answer (push violation strings). */
  also?: (o: Observed, h: StressHarness, ctx: CaseContext) => string[];
  /** Set when the expectation is a HARDENING position the code does not
   * document (inputs the real upstream cannot produce, or a path the code
   * explicitly treats differently on purpose). The case still runs and is
   * classified BROKEN/HELD in faults.json, but the Deno test does not fail
   * on it — the finding is reported, the suite stays green. */
  observeOnly?: string;
}

interface CaseContext {
  seed: number;
  userId: string;
  token: string;
  ip: string;
  scored: number;
  reserved: number;
  premium: boolean;
}

interface CaseRecord {
  id: string;
  seed: number;
  upstream: Upstream;
  fault: Fault;
  title: string;
  inputs: { userId: string; ip: string; scored: number; reserved: number; premium: boolean };
  expected: Expect;
  observeOnly?: string;
  observed: {
    status: number;
    code?: string;
    message?: string;
    retryAfter: string | null;
    requestId: string | null;
    durationMs: number;
    roundTrips: number;
    authCalls: number;
    dbCalls: number;
    redisPipelines: number;
    leaked: string[];
    serverErrorLines: number;
  };
  recovery: { status: number; roundTrips: number; durationMs: number } | null;
  violations: string[];
  outcome: "HELD" | "BROKEN";
  replay: string;
}

const html502 = "<html><body><h1>502 Bad Gateway</h1></body></html>";

const generic503Message = (o: Observed): string[] => {
  const message = String(o.body.error?.message ?? "");
  return /temporarily unavailable\. Please try again\.$/.test(message)
    ? []
    : [`503 message not the generic one: ${JSON.stringify(message)}`];
};

const noDetailLeak = (o: Observed): string[] => {
  const leaked = leakedDetail(o.raw);
  return leaked.length ? [`5xx body leaks internal detail: ${leaked.join(",")}`] : [];
};

const authRetryAfter =
  (expected: string) =>
  (o: Observed): string[] =>
    o.retryAfter === expected ? [] : [`Retry-After=${String(o.retryAfter)} ≠ ${expected}`];

const noSupabaseCalls = (o: Observed): string[] =>
  o.roundTrips === 0 ? [] : [`${o.roundTrips} Supabase round trips for a request refused locally`];

const tookAtLeast =
  (ms: number) =>
  (o: Observed): string[] =>
    o.durationMs >= ms ? [] : [`answered in ${o.durationMs}ms, expected ≥ ${ms}ms`];

const tookAtMost =
  (ms: number) =>
  (o: Observed): string[] =>
    o.durationMs <= ms ? [] : [`answered in ${o.durationMs}ms, expected ≤ ${ms}ms`];

const payloadHolds = (o: Observed): string[] => accessInvariantViolations(o.body);

const payloadMatches = (o: Observed, _h: StressHarness, ctx: CaseContext): string[] => {
  const out = payloadHolds(o);
  const used = Math.min(2, ctx.scored);
  const remaining = 2 - used;
  const reserved = Math.min(ctx.reserved, remaining);
  const fr = o.body.freeRatings ?? {};
  if (fr.used !== used) out.push(`used=${String(fr.used)} ≠ min(2,${ctx.scored})`);
  if (fr.reserved !== reserved) out.push(`reserved=${String(fr.reserved)} ≠ ${reserved}`);
  if (fr.remaining !== remaining) out.push(`remaining=${String(fr.remaining)} ≠ ${remaining}`);
  if (o.body.premium !== ctx.premium)
    out.push(`premium=${String(o.body.premium)} ≠ ${ctx.premium}`);
  return out;
};

const all =
  (...fns: Array<(o: Observed, h: StressHarness, ctx: CaseContext) => string[]>) =>
  (o: Observed, h: StressHarness, ctx: CaseContext) =>
    fns.flatMap((fn) => fn(o, h, ctx));

const auth503 = all(generic503Message, noDetailLeak);
const db503 = all(generic503Message, noDetailLeak);

// ── The case table ───────────────────────────────────────────────────────────

const CASES: FaultCase[] = [
  // Supabase Auth — GET /auth/v1/user (session bearer, cold cache)
  {
    id: "A01",
    upstream: "auth",
    title: "GoTrue 400 → credential refused",
    fault: { kind: "status", status: 400 },
    expect: { status: 401 },
  },
  {
    id: "A02",
    upstream: "auth",
    title: "GoTrue 401 → credential refused",
    fault: { kind: "status", status: 401 },
    expect: { status: 401 },
  },
  {
    id: "A03",
    upstream: "auth",
    title: "GoTrue 403 session_not_found → credential refused",
    fault: { kind: "status", status: 403 },
    expect: { status: 401 },
  },
  {
    id: "A04",
    upstream: "auth",
    title: "GoTrue 404 → retryable 503",
    fault: { kind: "status", status: 404 },
    expect: { status: 503 },
    also: all(auth503, authRetryAfter("2")),
  },
  {
    id: "A05",
    upstream: "auth",
    title: "GoTrue 429 with Retry-After: 7 → 503 propagating 7",
    fault: { kind: "status", status: 429, headers: { "Retry-After": "7" } },
    expect: { status: 503 },
    also: all(auth503, authRetryAfter("7")),
  },
  {
    id: "A06",
    upstream: "auth",
    title: "GoTrue 429 without Retry-After → 503 with default 2",
    fault: { kind: "status", status: 429 },
    expect: { status: 503 },
    also: all(auth503, authRetryAfter("2")),
  },
  {
    id: "A07",
    upstream: "auth",
    title: "GoTrue 500 → 503",
    fault: { kind: "status", status: 500 },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A08",
    upstream: "auth",
    title: "GoTrue 502 HTML gateway page → 503",
    fault: { kind: "status", status: 502, body: html502, headers: { "Content-Type": "text/html" } },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A09",
    upstream: "auth",
    title: "GoTrue 503 → 503",
    fault: { kind: "status", status: 503 },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A10",
    upstream: "auth",
    title: "GoTrue 504 → 503",
    fault: { kind: "status", status: 504 },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A11",
    upstream: "auth",
    title: "GoTrue socket error → bounded reconnects then 503",
    fault: { kind: "throw" },
    expect: { status: 503 },
    also: all(
      auth503,
      (o) =>
        o.authCalls >= 2 && o.authCalls <= 6
          ? []
          : [`${o.authCalls} auth attempts (expected 2..6)`],
      tookAtMost(AUTH_TIMEOUT_MS + 300),
    ),
  },
  {
    id: "A12",
    upstream: "auth",
    title: "GoTrue hangs past the deadline → 503 at the deadline",
    fault: { kind: "hang", ms: AUTH_TIMEOUT_MS * 5 },
    expect: { status: 503 },
    also: all(auth503, tookAtLeast(AUTH_TIMEOUT_MS - 20), tookAtMost(AUTH_TIMEOUT_MS + 300)),
  },
  {
    id: "A13",
    upstream: "auth",
    title: "GoTrue 200 with HTML body → 503 (not a verdict)",
    fault: { kind: "body", body: html502, contentType: "text/html" },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A14",
    upstream: "auth",
    title: "GoTrue 200 with empty body → 503",
    fault: { kind: "body", body: "" },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A15",
    upstream: "auth",
    title: "GoTrue 200 {} (no id) → 503",
    fault: { kind: "json", value: {} },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A16",
    upstream: "auth",
    title: "GoTrue 200 numeric id → 503",
    fault: { kind: "json", value: { id: 123, email: "x@example.com" } },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A17",
    upstream: "auth",
    title: "GoTrue 200 array body → 503",
    fault: { kind: "json", value: [{ id: "a" }] },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A18",
    upstream: "auth",
    title: "GoTrue 200 null body → 503",
    fault: { kind: "body", body: "null" },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A19",
    upstream: "auth",
    title: "GoTrue 200 truncated JSON → 503",
    fault: { kind: "body", body: '{"id":"abc","email":' },
    expect: { status: 503 },
    also: auth503,
  },
  {
    id: "A20",
    upstream: "auth",
    title: "GoTrue 200 user of provider email → 401 (not Google/Apple)",
    fault: {
      kind: "json",
      value: {
        id: "77777777-7777-4777-8777-777777777777",
        email: "e@example.com",
        app_metadata: { provider: "email", providers: ["email"] },
      },
    },
    expect: { status: 401 },
  },
  {
    id: "A21",
    upstream: "auth",
    title: "GoTrue 200 user without app_metadata → 401",
    fault: { kind: "json", value: { id: "77777777-7777-4777-8777-777777777777" } },
    expect: { status: 401 },
  },
  {
    id: "A22",
    upstream: "auth",
    title: "GoTrue slow but inside the deadline → 200",
    fault: { kind: "delay", ms: Math.floor(AUTH_TIMEOUT_MS / 3) },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(Math.floor(AUTH_TIMEOUT_MS / 3) - 5)),
  },
  {
    id: "A23",
    upstream: "auth",
    title: "GoTrue 500 with a WARM auth cache → served from cache, 200",
    fault: { kind: "status", status: 500 },
    warm: true,
    expect: { status: 200 },
    also: all(payloadMatches, (o) =>
      o.authCalls === 0 ? [] : [`${o.authCalls} auth calls despite warm cache`],
    ),
  },
  {
    id: "A24",
    upstream: "auth",
    title: "GoTrue hang with a WARM auth cache → 200, no Auth round trip",
    fault: { kind: "hang", ms: AUTH_TIMEOUT_MS * 5 },
    warm: true,
    expect: { status: 200 },
    also: all(payloadMatches, tookAtMost(AUTH_TIMEOUT_MS)),
  },

  // Supabase Auth — transitional provider ID token (POST /auth/v1/token?grant_type=id_token via supabase-js)
  {
    id: "P01",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant 400 → 401",
    fault: { kind: "status", status: 400 },
    expect: { status: 401 },
  },
  {
    id: "P02",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant 500 (Auth outage) → user-visible class",
    fault: { kind: "status", status: 500 },
    expect: { status: 503 },
    observeOnly:
      "transitional branch folds every signInWithIdToken error into 401 by design (index.ts authenticate)",
  },
  {
    id: "P03",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant 502 HTML → user-visible class",
    fault: { kind: "status", status: 502, body: html502, headers: { "Content-Type": "text/html" } },
    expect: { status: 503 },
    observeOnly:
      "transitional branch folds every signInWithIdToken error into 401 by design (index.ts authenticate)",
  },
  {
    id: "P04",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant 200 without session → user-visible class",
    fault: { kind: "json", value: { user: { id: "x" } } },
    expect: { status: 503 },
    observeOnly:
      "transitional branch folds every signInWithIdToken error into 401 by design (index.ts authenticate)",
  },
  {
    id: "P05",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant slow 3×deadline → answered (no deadline on this path)",
    fault: { kind: "delay", ms: AUTH_TIMEOUT_MS * 3 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(AUTH_TIMEOUT_MS * 3 - 5), (o) =>
      o.authCalls === 1 && o.dbCalls === 1
        ? []
        : [`grant+rpc expected, saw auth=${o.authCalls} db=${o.dbCalls}`],
    ),
  },
  {
    id: "P06",
    upstream: "auth",
    bearer: "provider",
    title: "id_token grant socket error → user-visible class",
    fault: { kind: "throw" },
    expect: { status: 503 },
    also: tookAtMost(5_000),
    observeOnly:
      "transitional branch folds every signInWithIdToken error into 401 by design (index.ts authenticate)",
  },

  // PostgREST — POST /rest/v1/rpc/access_state (auth answers normally)
  {
    id: "D01",
    upstream: "db",
    title: "PostgREST 400 PGRST → generic 503",
    fault: {
      kind: "status",
      status: 400,
      body: JSON.stringify({
        code: "PGRST100",
        message: "injected parse error",
        details: null,
        hint: null,
      }),
    },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D02",
    upstream: "db",
    title: "PostgREST 401 PGRST301 (JWT refused at DB) → user-visible class",
    fault: {
      kind: "status",
      status: 401,
      body: JSON.stringify({ code: "PGRST301", message: "JWT expired" }),
    },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D03",
    upstream: "db",
    title: "PostgREST 403 42501 permission denied → generic 503",
    fault: {
      kind: "status",
      status: 403,
      body: JSON.stringify({
        code: "42501",
        message: "permission denied for function access_state",
      }),
    },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D04",
    upstream: "db",
    title: "PostgREST 404 PGRST202 function missing → generic 503",
    fault: {
      kind: "status",
      status: 404,
      body: JSON.stringify({
        code: "PGRST202",
        message: "Could not find the function public.access_state",
      }),
    },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D05",
    upstream: "db",
    title: "PostgREST 409 → 503",
    fault: { kind: "status", status: 409 },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D06",
    upstream: "db",
    title: "PostgREST 429 → 503",
    fault: { kind: "status", status: 429, headers: { "Retry-After": "5" } },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D07",
    upstream: "db",
    title: "PostgREST 500 → 503",
    fault: { kind: "status", status: 500 },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D08",
    upstream: "db",
    title: "PostgREST 502 HTML gateway page → 503",
    fault: { kind: "status", status: 502, body: html502, headers: { "Content-Type": "text/html" } },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D09",
    upstream: "db",
    title: "PostgREST 503 → 503",
    fault: { kind: "status", status: 503 },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D10",
    upstream: "db",
    title: "PostgREST 504 → 503",
    fault: { kind: "status", status: 504 },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D11",
    upstream: "db",
    title: "PostgREST socket error → 503",
    fault: { kind: "throw" },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D12",
    upstream: "db",
    title: "PostgREST slow 1.5s then answers → 200 after 1.5s (no deadline on the RPC)",
    fault: { kind: "hang", ms: 1500 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(1490)),
  },
  {
    id: "D13",
    upstream: "db",
    title: "PostgREST 200 HTML body → 503",
    fault: { kind: "body", body: html502, contentType: "text/html" },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D14",
    upstream: "db",
    title: "PostgREST 200 empty body → user-visible class",
    fault: { kind: "body", body: "" },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D15",
    upstream: "db",
    title: "PostgREST 200 [] (no row) → 503",
    fault: { kind: "json", value: [] },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D16",
    upstream: "db",
    title: "PostgREST 200 null → 503",
    fault: { kind: "body", body: "null" },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D17",
    upstream: "db",
    title: "PostgREST 200 {} (object, not rows) → 503",
    fault: { kind: "json", value: {} },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D18",
    upstream: "db",
    title: "PostgREST 200 truncated JSON → 503",
    fault: { kind: "body", body: '[{"premium":false,"scored_count":' },
    expect: { status: 503 },
    also: db503,
  },
  {
    id: "D19",
    upstream: "db",
    title: "PostgREST 200 [{}] (row without columns) → payload invariants",
    fault: { kind: "json", value: [{}] },
    expect: { status: 200 },
    also: payloadHolds,
  },
  {
    id: "D20",
    upstream: "db",
    title: "PostgREST 200 row with null columns → payload invariants",
    fault: { kind: "json", value: [{ premium: null, scored_count: null, reserved_count: null }] },
    expect: { status: 200 },
    also: all(payloadHolds, (o) =>
      o.body.premium === false ? [] : ["null premium granted premium"],
    ),
  },
  {
    id: "D21",
    upstream: "db",
    title: 'PostgREST 200 premium as string "false" → must not grant premium',
    fault: { kind: "json", value: [{ premium: "false", scored_count: 2, reserved_count: 0 }] },
    expect: { status: 200 },
    also: all(payloadHolds, (o) =>
      o.body.premium === false ? [] : [`premium=${String(o.body.premium)} from the string "false"`],
    ),
    observeOnly:
      "access_state() declares premium boolean; a string can only come from a compromised/misrouted PostgREST",
  },
  {
    id: "D22",
    upstream: "db",
    title: "PostgREST 200 counts as numeric strings → payload invariants",
    fault: { kind: "json", value: [{ premium: false, scored_count: "2", reserved_count: "1" }] },
    expect: { status: 200 },
    also: payloadHolds,
  },
  {
    id: "D23",
    upstream: "db",
    title: "PostgREST 200 negative scored_count → payload invariants",
    fault: { kind: "json", value: [{ premium: false, scored_count: -5, reserved_count: 0 }] },
    expect: { status: 200 },
    also: payloadHolds,
    observeOnly: "access_state() counts are count(*)/greatest(...) and cannot be negative",
  },
  {
    id: "D24",
    upstream: "db",
    title: "PostgREST 200 huge scored_count → clamps to 2",
    fault: { kind: "json", value: [{ premium: false, scored_count: 1e12, reserved_count: 0 }] },
    expect: { status: 200 },
    also: all(payloadHolds, (o) =>
      o.body.freeRatings?.used === 2 ? [] : ["used not clamped to 2"],
    ),
  },
  {
    id: "D25",
    upstream: "db",
    title: "PostgREST 200 reserved_count above remaining → clamps",
    fault: { kind: "json", value: [{ premium: false, scored_count: 0, reserved_count: 9 }] },
    expect: { status: 200 },
    also: all(payloadHolds, (o) =>
      o.body.paywallRequired === true ? [] : ["two live permits should paywall"],
    ),
  },
  {
    id: "D26",
    upstream: "db",
    title: "PostgREST 200 fractional counts → payload invariants",
    fault: { kind: "json", value: [{ premium: false, scored_count: 1.5, reserved_count: 0.5 }] },
    expect: { status: 200 },
    also: payloadHolds,
  },
  {
    id: "D27",
    upstream: "db",
    title: "PostgREST 200 two rows → first row wins, invariants hold",
    fault: {
      kind: "json",
      value: [
        { premium: true, scored_count: 0, reserved_count: 0 },
        { premium: false, scored_count: 2, reserved_count: 0 },
      ],
    },
    expect: { status: 200 },
    also: all(payloadHolds, (o) => (o.body.premium === true ? [] : ["first row not used"])),
  },
  {
    id: "D28",
    upstream: "db",
    title: "PostgREST 200 with extra columns → 200",
    fault: {
      kind: "json",
      value: [{ premium: false, scored_count: 1, reserved_count: 0, extra: { deep: [1, 2, 3] } }],
    },
    expect: { status: 200 },
    also: payloadHolds,
  },
  {
    id: "D29",
    upstream: "db",
    title: "PostgREST 200 scored_count as boolean → payload invariants",
    fault: { kind: "json", value: [{ premium: false, scored_count: true, reserved_count: false }] },
    expect: { status: 200 },
    also: payloadHolds,
  },
  {
    id: "D30",
    upstream: "db",
    title: "PostgREST slow 300ms → 200",
    fault: { kind: "delay", ms: 300 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(295)),
  },
  {
    id: "D31",
    upstream: "db",
    title: "PostgREST 500 with WARM auth cache → 503, Auth not consulted",
    fault: { kind: "status", status: 500 },
    warm: true,
    expect: { status: 503 },
    also: all(db503, (o) => (o.authCalls === 0 ? [] : [`${o.authCalls} auth calls`])),
  },
  {
    id: "D32",
    upstream: "db",
    title: "PostgREST 200 with 4xx-shaped error object as a row → invariants",
    fault: { kind: "json", value: [{ code: "PGRST116", message: "0 rows" }] },
    expect: { status: 200 },
    also: payloadHolds,
  },

  // Upstash Redis — /pipeline (L2 cache + shared rate limits)
  {
    id: "X01",
    upstream: "redis",
    title: "Redis 500 → request served (degrades to L1)",
    fault: { kind: "status", status: 500 },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X02",
    upstream: "redis",
    title: "Redis 401 (bad token) → served",
    fault: { kind: "status", status: 401 },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X03",
    upstream: "redis",
    title: "Redis 429 (Upstash throttling) → served",
    fault: { kind: "status", status: 429 },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X04",
    upstream: "redis",
    title: "Redis socket error → served",
    fault: { kind: "throw" },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X05",
    upstream: "redis",
    title: "Redis hangs past its 1.2s timeout → served; latency = pipelines × 1.2s",
    fault: { kind: "hang", ms: 20_000 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(1_150)),
  },
  {
    id: "X06",
    upstream: "redis",
    title: "Redis 200 HTML body → served",
    fault: { kind: "body", body: html502, contentType: "text/html" },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X07",
    upstream: "redis",
    title: "Redis 200 {} (not an array) → served",
    fault: { kind: "json", value: {} },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X08",
    upstream: "redis",
    title: "Redis 200 [] (short reply) → served, re-verified with Auth",
    fault: { kind: "json", value: [] },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X09",
    upstream: "redis",
    title: "Redis per-command errors → served",
    fault: {
      kind: "json",
      value: [{ error: "ERR injected" }, { error: "ERR injected" }, { error: "ERR injected" }],
    },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X10",
    upstream: "redis",
    title: "Redis answers every slot with a corrupt string → served, not trusted",
    fault: {
      kind: "json",
      value: [{ result: "{not json" }, { result: "{not json" }, { result: "{not json" }],
    },
    expect: { status: 200 },
    also: all(payloadMatches, (o) =>
      o.authCalls >= 1 ? [] : ["corrupt cache row was trusted as a session"],
    ),
    observeOnly:
      "any string in the revocation-marker slot IS the marker by contract (cache.ts cacheGetUnlessRevoked); a corrupt L2 is indistinguishable from a logout",
  },
  {
    id: "X11",
    upstream: "redis",
    title: "Redis answers every slot with a number → served (counters from a corrupt store)",
    fault: { kind: "json", value: [{ result: 1 }, { result: 1 }, { result: 1 }] },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X12",
    upstream: "redis",
    title: "Redis answers every slot with a huge number → rate limit fails closed (429)",
    fault: { kind: "json", value: [{ result: 1e9 }, { result: 1e9 }, { result: 1e9 }] },
    expect: { status: 429 },
    also: (o) => (o.roundTrips === 0 ? [] : [`${o.roundTrips} Supabase round trips while limited`]),
  },
  {
    id: "X13",
    upstream: "redis",
    title: "Redis answers null slots → served",
    fault: { kind: "json", value: [null, null, null] },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X14",
    upstream: "redis",
    title: "Redis slow 300ms per pipeline → served, latency = pipelines × 300ms",
    fault: { kind: "delay", ms: 300 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtLeast(295)),
  },
  {
    id: "X15",
    upstream: "redis",
    title: "Redis truncated JSON → served",
    fault: { kind: "body", body: '[{"result":' },
    expect: { status: 200 },
    also: payloadMatches,
  },
  {
    id: "X16",
    upstream: "redis",
    title: "Redis 500 with WARM L1 → served from L1, Auth not consulted",
    fault: { kind: "status", status: 500 },
    warm: true,
    expect: { status: 200 },
    also: all(payloadMatches, (o) =>
      o.authCalls === 0 ? [] : [`${o.authCalls} auth calls despite warm L1`],
    ),
  },
  {
    id: "X17",
    upstream: "redis",
    title: "Redis hang with WARM L1 → served (slow), Auth not consulted",
    fault: { kind: "hang", ms: 20_000 },
    warm: true,
    expect: { status: 200 },
    also: all(payloadMatches, (o) =>
      o.authCalls === 0 ? [] : [`${o.authCalls} auth calls despite warm L1`],
    ),
  },

  // RevenueCat — the route must never depend on it
  {
    id: "C01",
    upstream: "rc",
    title: "RevenueCat 500 → route unaffected (never called)",
    fault: { kind: "status", status: 500 },
    expect: { status: 200 },
    also: all(payloadMatches, (_o, h) =>
      h.callsTo("rc").length === 0 ? [] : ["GET /v1/me/access called RevenueCat"],
    ),
  },
  {
    id: "C02",
    upstream: "rc",
    title: "RevenueCat socket error → route unaffected",
    fault: { kind: "throw" },
    expect: { status: 200 },
    also: all(payloadMatches, (_o, h) =>
      h.callsTo("rc").length === 0 ? [] : ["GET /v1/me/access called RevenueCat"],
    ),
  },
  {
    id: "C03",
    upstream: "rc",
    title: "RevenueCat hang → route unaffected, fast",
    fault: { kind: "hang", ms: 20_000 },
    expect: { status: 200 },
    also: all(payloadMatches, tookAtMost(1_000)),
  },
];

// ── Runner ───────────────────────────────────────────────────────────────────

const records: CaseRecord[] = [];

function replayCommand(id: string): string {
  return `STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_v1_me_access_faults.test.ts --filter "${id}"`;
}

async function runCase(h: StressHarness, c: FaultCase): Promise<CaseRecord> {
  h.reset();
  const seed = caseSeed(c.id);
  const prng = new Prng(seed);
  const userId = prng.uuid();
  const ctx: CaseContext = {
    seed,
    userId,
    token: "",
    ip: ipFor(prng),
    scored: prng.int(0, 3),
    reserved: prng.int(0, 2),
    premium: prng.next() < 0.25,
  };
  h.registerUser({
    id: userId,
    provider: prng.next() < 0.5 ? "google" : "apple",
    premium: ctx.premium,
    scored_count: ctx.scored,
    reserved_count: ctx.reserved,
  });
  ctx.token = c.bearer === "provider" ? h.mintProviderToken(userId) : h.mintSession(userId);

  if (c.warm) {
    const warm = await observe(h, accessRequest(ctx.token, ctx.ip), ctx.token);
    assertEquals(warm.status, 200, `${c.id}: warm-up request`);
  }

  h.faults = { [c.upstream]: c.fault } as Record<Upstream, Fault>;
  const serverErrorsBefore = h.serverErrors.length;
  const observed = await observe(
    h,
    accessRequest(ctx.token, ctx.ip, `stress-${c.id}-${seed}`),
    ctx.token,
  );
  h.faults = {};
  h.release();

  const violations: string[] = [];
  if (classOf(observed.status) !== classOf(c.expect.status)) {
    violations.push(
      `class ${classOf(observed.status)} (${observed.status}) ≠ expected ${classOf(c.expect.status)} (${c.expect.status})`,
    );
  } else if (observed.status !== c.expect.status) {
    violations.push(`status ${observed.status} ≠ expected ${c.expect.status} (same class)`);
  }
  if (observed.requestId !== `stress-${c.id}-${seed}`) {
    violations.push(`x-request-id not echoed: ${String(observed.requestId)}`);
  }
  if (observed.status >= 500) {
    violations.push(...noDetailLeak(observed));
    if (h.serverErrors.length <= serverErrorsBefore) {
      violations.push("5xx without an operator-facing [api] error line");
    }
  }
  if (c.also) violations.push(...c.also(observed, h, ctx));

  // Recoverability: fault lifted, SAME bearer, must be served.
  let recovery: CaseRecord["recovery"] = null;
  if (c.expect.status !== 429) {
    const again = await observe(h, accessRequest(ctx.token, ctx.ip), ctx.token);
    recovery = { status: again.status, roundTrips: again.roundTrips, durationMs: again.durationMs };
    if (again.status !== 200) {
      violations.push(`not recoverable: same bearer after the fault → ${again.status}`);
    } else {
      violations.push(...payloadMatches(again, h, ctx).map((v) => `recovery: ${v}`));
    }
    if (again.roundTrips > 3)
      violations.push(`recovery cost ${again.roundTrips} Supabase round trips`);
  }
  if (observed.roundTrips > 3 && observed.status !== 503) {
    violations.push(`${observed.roundTrips} Supabase round trips (> 3) on a served request`);
  }

  const record: CaseRecord = {
    id: c.id,
    seed,
    upstream: c.upstream,
    fault: c.fault,
    title: c.title,
    inputs: {
      userId,
      ip: ctx.ip,
      scored: ctx.scored,
      reserved: ctx.reserved,
      premium: ctx.premium,
    },
    expected: c.expect,
    observeOnly: c.observeOnly,
    observed: {
      status: observed.status,
      code: typeof observed.body.error?.code === "string" ? observed.body.error.code : undefined,
      message:
        typeof observed.body.error?.message === "string" ? observed.body.error.message : undefined,
      retryAfter: observed.retryAfter,
      requestId: observed.requestId,
      durationMs: observed.durationMs,
      roundTrips: observed.roundTrips,
      authCalls: observed.authCalls,
      dbCalls: observed.dbCalls,
      redisPipelines: observed.redisPipelines,
      leaked: leakedDetail(observed.raw),
      serverErrorLines: h.serverErrors.length - serverErrorsBefore,
    },
    recovery,
    violations,
    outcome: violations.length === 0 ? "HELD" : "BROKEN",
    replay: replayCommand(c.id),
  };
  records.push(record);
  return record;
}

for (const c of CASES) {
  Deno.test(`stress faults ${c.id} [${c.upstream}] ${c.title}`, async () => {
    const h = await loadStressHarness({ redis: true });
    const record = await runCase(h, c);
    if (record.outcome === "BROKEN") {
      console.log(`[stress] BROKEN ${c.id} seed=${record.seed}: ${record.violations.join(" | ")}`);
      console.log(`[stress]   replay: ${record.replay}`);
    }
    if (c.observeOnly) {
      console.log(`[stress]   ${c.id} observe-only (${c.observeOnly}); outcome=${record.outcome}`);
      return;
    }
    // The table is the evidence. The user-visible CLASS and recoverability
    // are asserted (a wrong class changes what the app does); every other
    // deviation is recorded as a violation in faults.json so the whole
    // campaign always runs and the coordinator sees the full table.
    assertEquals(
      classOf(record.observed.status),
      classOf(c.expect.status),
      `${c.id} ${c.title}: ${record.violations.join(" | ")}`,
    );
    assert(
      record.recovery === null || record.recovery.status === 200,
      `${c.id}: same bearer not served after the fault was lifted (${record.recovery?.status})`,
    );
  });
}

// Request-level refusals: no upstream may be consulted for a bearer the edge
// can refuse by itself (these are the free part of the failure budget).
Deno.test(
  "stress faults R01-R04: locally refused bearers cost zero Supabase round trips",
  async () => {
    const h = await loadStressHarness({ redis: true });
    h.reset();
    const prng = new Prng(caseSeed("R"));
    const userId = prng.uuid();
    h.registerUser({ id: userId });
    const expired = h.mintSession(userId, -60);
    const cases: Array<[string, string | null, string]> = [
      ["R01", null, "missing bearer"],
      ["R02", "not-a-jwt", "garbage bearer"],
      ["R03", expired, "expired session bearer"],
      [
        "R04",
        `${btoa('{"alg":"none"}')}.${btoa('{"iss":"https://evil.example","sub":"x","exp":9999999999}')}.x`,
        "wrong issuer",
      ],
    ];
    for (const [id, token, title] of cases) {
      const o = await observe(h, accessRequest(token, ipFor(prng)), token ?? "");
      const violations = [...noSupabaseCalls(o)];
      if (o.status !== 401) violations.push(`status ${o.status} ≠ 401`);
      records.push({
        id,
        seed: caseSeed("R"),
        upstream: "auth",
        fault: { kind: "status", status: 0 },
        title: `${title} → 401 locally`,
        inputs: { userId, ip: "", scored: 0, reserved: 0, premium: false },
        expected: { status: 401 },
        observed: {
          status: o.status,
          code: undefined,
          message: typeof o.body.error?.message === "string" ? o.body.error.message : undefined,
          retryAfter: o.retryAfter,
          requestId: o.requestId,
          durationMs: o.durationMs,
          roundTrips: o.roundTrips,
          authCalls: o.authCalls,
          dbCalls: o.dbCalls,
          redisPipelines: o.redisPipelines,
          leaked: [],
          serverErrorLines: 0,
        },
        recovery: null,
        violations,
        outcome: violations.length ? "BROKEN" : "HELD",
        replay: replayCommand("R01-R04"),
      });
      assertEquals(o.status, 401, `${id} ${title}`);
      assertEquals(o.roundTrips, 0, `${id} ${title}: Supabase consulted`);
    }
  },
);

// A PostgREST that never answers: the request has no deadline of its own.
// Observed (not asserted as a failure): still pending after STRESS_HANG_MS.
Deno.test(
  "stress faults D33: PostgREST never answers → request still pending after the observation window",
  async () => {
    const h = await loadStressHarness({ redis: true });
    h.reset();
    const seed = caseSeed("D33");
    const prng = new Prng(seed);
    const userId = prng.uuid();
    h.registerUser({ id: userId, scored_count: 1 });
    const token = h.mintSession(userId);
    const ip = ipFor(prng);
    const windowMs = Number(Deno.env.get("STRESS_HANG_MS") ?? "2000");
    h.faults = { db: { kind: "hang", ms: 0, then: "release" } };
    let settled: number | null = null;
    const pending = observe(h, accessRequest(token, ip), token).then((o) => {
      settled = o.status;
      return o;
    });
    await sleep(windowMs);
    const stillPending = settled === null;
    h.faults = {};
    h.release();
    const o = await pending;
    const violations = stillPending
      ? [
          `no edge-side deadline on the access_state RPC: request still unanswered after ${windowMs}ms (answered ${o.status} only once PostgREST replied)`,
        ]
      : [];
    records.push({
      id: "D33",
      seed,
      upstream: "db",
      fault: { kind: "hang", ms: windowMs, then: "release" },
      title: "PostgREST never answers → no client-visible answer until it does",
      inputs: { userId, ip, scored: 1, reserved: 0, premium: false },
      expected: { status: 503 },
      observed: {
        status: stillPending ? 0 : o.status,
        message: stillPending ? `pending after ${windowMs}ms` : undefined,
        retryAfter: null,
        requestId: o.requestId,
        durationMs: o.durationMs,
        roundTrips: o.roundTrips,
        authCalls: o.authCalls,
        dbCalls: o.dbCalls,
        redisPipelines: o.redisPipelines,
        leaked: [],
        serverErrorLines: 0,
      },
      recovery: { status: o.status, roundTrips: o.roundTrips, durationMs: o.durationMs },
      violations,
      outcome: violations.length ? "BROKEN" : "HELD",
      replay: replayCommand("D33"),
    });
    if (stillPending) {
      console.log(`[stress] OBSERVED D33 seed=${seed}: ${violations[0]}`);
    }
    assertEquals(o.status, 200, "once PostgREST answers the request is served");
  },
);

Deno.test("stress faults: write faults.json (seed → outcome table)", async () => {
  const outcomes = histogram(records.map((r) => r.outcome));
  const byStatus = histogram(records.map((r) => `${r.id}:${r.observed.status}`));
  const path = await writeJson("faults", {
    unit: "route-get-v1-me-access",
    lens: "failure-load",
    seed: STRESS_SEED,
    authTimeoutMs: AUTH_TIMEOUT_MS,
    redis: true,
    cases: records.length,
    upstreamFaultCases: records.filter((r) => !r.id.startsWith("R")).length,
    outcomes,
    broken: records
      .filter((r) => r.outcome === "BROKEN")
      .map((r) => ({ id: r.id, seed: r.seed, violations: r.violations, replay: r.replay })),
    records,
    byStatus,
  });
  console.log(`[stress] faults: ${records.length} cases ${JSON.stringify(outcomes)} → ${path}`);
  assert(records.length >= 40, `only ${records.length} fault cases ran`);
});

Deno.test(
  "stress faults: teardown (real fetch / timeout env back for the rest of the suite)",
  async () => {
    (await loadStressHarness({ redis: true })).teardown();
  },
);
