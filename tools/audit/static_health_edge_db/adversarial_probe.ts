// Adversarial black-box probe of the REAL edge handler (supabase/functions/api
// /index.ts) via the existing routes harness. Every authenticated/public route
// is driven under a matrix of upstream faults injected at the fetch layer
// (PostgREST 5xx with a canary marker, permission-denied, HTML gateway pages,
// malformed JSON, wrong shapes, thrown fetch, hung upstream, endless pages,
// Auth outage, RevenueCat outage) plus a seeded body/path fuzz corpus.
//
// For every cell we record status, body, headers, console output and the
// number of upstream calls, and evaluate:
//   leak        canary MARKER or upstream internals appear in the response
//   threw       the handler rejected (Deno.serve would emit its default 500)
//   bad_5xx     5xx other than 500/502/503, or a 5xx body that is not the
//               generic {error:{message}} shape
//   hang        no response within HANG_BUDGET_MS (no upstream timeout)
//   swallowed   fault reached the DB, response is 2xx and nothing was logged
//   no_reqid    x-request-id header missing
//
// Usage: deno run -A --no-check --config deno.json adversarial_probe.ts --out <file.json> [--seed N] [--fuzz N]

import {
  activeSubscriber,
  fakeGoogleIdToken,
  loadHarness,
  RC_URL,
  SUPABASE_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "../../../supabase/functions/api/__wf__/routesHarness.ts";
import { print } from "./lib/print.ts";

const MARKER = "CANARY_LEAK_9f3b1c";
const HANG_BUDGET_MS = 3_000;
const SETTLE_BUDGET_MS = 35_000;
const args = [...Deno.args];
const argValue = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const OUT = argValue("--out") ?? "";
const SEED = Number(argValue("--seed") ?? "1337");
const FUZZ_PER_ROUTE = Number(argValue("--fuzz") ?? "40");

const UUID = "33333333-3333-4333-8333-333333333333";
const PERMIT = "44444444-4444-4444-8444-444444444444";
const SESSION = "55555555-5555-4555-8555-555555555555";
const CHALLENGE = "66666666-6666-4666-8666-666666666666";
const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "score-1",
  shotConfigVersion: "cfg-1",
};
const ACCESS_STATE_ROW = [{ premium: false, scored_count: 0, reserved_count: 0 }];
const validShot = (id = UUID) => ({
  id,
  source: "real",
  analysisPermitId: PERMIT,
  sessionId: null,
  shotType: "dink",
  cameraView: "side",
  capturedAt: "2026-09-01T10:00:00.000Z",
  timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
  overallScore: 7,
  confidence: 0.9,
  resultKind: "scored",
  phases: [],
  checkpoints: [],
  versionVector: VERSION_VECTOR,
});

interface RouteSpec {
  name: string;
  method: string;
  path: string;
  body?: unknown;
  /** user = transitional provider ID-token bearer; session = Supabase access
   * token issued by bootstrap/refresh (the contract path, verified via
   * auth.getUser). */
  kind: "user" | "session" | "webhook" | "public";
  /** Rows PostgREST should return so the happy path proceeds to the write. */
  tables?: Record<string, unknown[]>;
  rpcs?: Record<string, unknown>;
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A syntactically valid Supabase access token (issuer routing only — the
 * fake Auth's GET /auth/v1/user answers for it). */
const fakeSessionToken = (sub: string): string => {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
};
const jwtSub = (token: string): string | null => {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))) as {
      sub?: unknown;
      iss?: unknown;
    };
    return typeof parsed.iss === "string" &&
      parsed.iss.endsWith("/auth/v1") &&
      typeof parsed.sub === "string"
      ? parsed.sub
      : null;
  } catch {
    return null;
  }
};

const profileRow = {
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
  skill_level: "intermediate",
  handedness: "right",
  first_name: "Pat",
  gender: null,
  created_at: "2026-08-01T00:00:00.000Z",
};

const ROUTES: RouteSpec[] = [
  { name: "healthz", method: "GET", path: "/healthz", kind: "public" },
  { name: "privacy", method: "GET", path: "/privacy", kind: "public" },
  { name: "terms", method: "GET", path: "/terms", kind: "public" },
  { name: "support", method: "GET", path: "/support", kind: "public" },
  {
    name: "bootstrap",
    method: "POST",
    path: "/v1/account/bootstrap",
    kind: "user",
    body: {},
    tables: { profiles: [profileRow] },
  },
  {
    name: "auth_refresh",
    method: "POST",
    path: "/v1/auth/refresh",
    kind: "user",
    body: { refreshToken: "refresh-token-xyz" },
  },
  { name: "auth_logout", method: "POST", path: "/v1/auth/logout", kind: "user" },
  { name: "me", method: "GET", path: "/v1/me", kind: "user", tables: { profiles: [profileRow] } },
  {
    name: "me_session_bearer",
    method: "GET",
    path: "/v1/me",
    kind: "session",
    tables: { profiles: [profileRow] },
  },
  {
    name: "me_onboarding",
    method: "PUT",
    path: "/v1/me/onboarding",
    kind: "user",
    body: {
      handedness: "right",
      skillLevel: "beginner",
      goal: "consistency",
      biggestProblem: "dinks",
      firstName: "Pat",
    },
    tables: { profiles: [profileRow] },
  },
  {
    name: "me_access",
    method: "GET",
    path: "/v1/me/access",
    kind: "user",
    rpcs: { access_state: ACCESS_STATE_ROW },
  },
  {
    name: "billing_sync",
    method: "POST",
    path: "/v1/billing/sync",
    kind: "user",
    body: {},
    rpcs: { access_state: ACCESS_STATE_ROW },
  },
  {
    name: "permits_reserve",
    method: "POST",
    path: "/v1/analysis-permits",
    kind: "user",
    body: { idempotencyKey: "idem-key-0001" },
    rpcs: {
      access_state: ACCESS_STATE_ROW,
      reserve_analysis_permit: [
        {
          result: "accepted",
          permit_id: PERMIT,
          permit_status: "reserved",
          permit_outcome: null,
          permit_created_at: "2026-09-01T10:00:00.000Z",
        },
      ],
    },
  },
  {
    name: "permits_finalize",
    method: "POST",
    path: `/v1/analysis-permits/${PERMIT}/finalize`,
    kind: "user",
    body: { outcome: "cancelled" },
    tables: {
      analysis_permits: [
        {
          id: PERMIT,
          status: "reserved",
          outcome: null,
          idempotency_key: "idem-key-0001",
          created_at: "2026-09-01T10:00:00.000Z",
          expires_at: "2099-01-01T00:00:00.000Z",
        },
      ],
    },
    rpcs: { access_state: ACCESS_STATE_ROW },
  },
  {
    name: "shots_sync",
    method: "POST",
    path: "/v1/shots:sync",
    kind: "user",
    body: { shots: [validShot()] },
    rpcs: { apply_synced_shot: "applied" },
  },
  {
    name: "sessions_create",
    method: "POST",
    path: "/v1/sessions",
    kind: "user",
    body: { id: SESSION, startedAt: "2026-09-01T10:00:00.000Z" },
    tables: { sessions: [{ id: SESSION, ended_at: null }] },
  },
  {
    name: "sessions_finalize",
    method: "POST",
    path: `/v1/sessions/${SESSION}/finalize`,
    kind: "user",
    body: {},
    tables: { sessions: [{ id: SESSION, ended_at: null }] },
  },
  {
    name: "evaluation_trials",
    method: "POST",
    path: "/v1/me/evaluation/trials",
    kind: "user",
    body: { trials: [{ trialId: UUID, kind: "x" }] },
    tables: {
      consent_records: [
        {
          scope: "evaluation_telemetry",
          action: "grant",
          consent_version: "2026-08",
          created_at: "2026-09-01T00:00:00.000Z",
        },
      ],
      evaluation_trials: [{ id: UUID }],
    },
  },
  {
    name: "analysis_feedback",
    method: "POST",
    path: `/v1/analyses/${UUID}/feedback`,
    kind: "user",
    body: { rating: "accurate" },
    tables: { shots: [{ id: UUID }] },
  },
  { name: "progress", method: "GET", path: "/v1/progress", kind: "user" },
  { name: "rank", method: "GET", path: "/v1/rank", kind: "user" },
  { name: "consent_status", method: "GET", path: "/v1/me/consent/status", kind: "user" },
  {
    name: "consent_grant",
    method: "POST",
    path: "/v1/me/consent/grant",
    kind: "user",
    body: {
      scope: "video_analysis",
      consentVersion: "2026-08",
      source: "onboarding",
      device: "iPhone",
    },
  },
  {
    name: "consent_withdraw",
    method: "POST",
    path: "/v1/me/consent/withdraw",
    kind: "user",
    body: { scope: "video_analysis", source: "settings", device: "iPhone" },
  },
  { name: "saved_drills_list", method: "GET", path: "/v1/me/saved-drills", kind: "user" },
  {
    name: "saved_drills_put",
    method: "PUT",
    path: "/v1/me/saved-drills/wall-dink-rally",
    kind: "user",
    tables: {
      user_saved_drills: [{ slug: "wall-dink-rally", saved_at: "2026-09-01T10:00:00.000Z" }],
    },
  },
  {
    name: "saved_drills_delete",
    method: "DELETE",
    path: "/v1/me/saved-drills/wall-dink-rally",
    kind: "user",
  },
  { name: "catalog_list", method: "GET", path: "/v1/catalog/drills?q=dink", kind: "user" },
  { name: "catalog_get", method: "GET", path: "/v1/catalog/drills/wall-dink-rally", kind: "user" },
  {
    name: "delete_request",
    method: "POST",
    path: "/v1/me/delete-request",
    kind: "user",
    body: { survey: { reason: "other" } },
    rpcs: { access_state: ACCESS_STATE_ROW },
    tables: { profiles: [profileRow] },
  },
  {
    name: "delete_confirm",
    method: "POST",
    path: "/v1/me/delete-confirm",
    kind: "user",
    body: { challenge: CHALLENGE },
    tables: {
      account_deletion_requests: [
        {
          challenge: CHALLENGE,
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        },
      ],
      profiles: [profileRow],
    },
  },
  { name: "training_current", method: "GET", path: "/v1/training-plans/current", kind: "user" },
  { name: "training_create", method: "POST", path: "/v1/training-plans", kind: "user", body: {} },
  { name: "unknown_route", method: "GET", path: "/v1/nope", kind: "user" },
  {
    name: "webhook_rc",
    method: "POST",
    path: "/webhooks/revenuecat",
    kind: "webhook",
    body: {
      type: "INITIAL_PURCHASE",
      app_user_id: TEST_USER_ID,
      id: "evt-1",
      event_timestamp_ms: Date.now(),
    },
  },
];

// ─── Fault layer ───────────────────────────────────────────────────────────
type Respond = (request: Request) => Promise<Response> | Response;
interface Fault {
  name: string;
  /** Which upstream this fault applies to. */
  scope: "rest" | "rest_get" | "rest_rpc" | "auth" | "rc";
  respond: Respond | "throw" | "hang";
  description: string;
}
const json = (status: number, body: unknown, type = "application/json") =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": type } });
const raw = (status: number, text: string, type: string) =>
  new Response(text, { status, headers: { "Content-Type": type } });

const FAULTS: Fault[] = [
  {
    name: "none",
    scope: "rest",
    respond: (r) => r as unknown as Response,
    description: "control: stubs answer normally",
  },
  {
    name: "rest_500_pg_error",
    scope: "rest",
    respond: () =>
      json(500, {
        code: "XX000",
        message: `${MARKER} internal_error`,
        details: `${MARKER} details`,
        hint: `${MARKER} hint`,
      }),
    description: "PostgREST 500 with PG error payload",
  },
  {
    name: "rest_500_statement_timeout",
    scope: "rest",
    respond: () =>
      json(500, {
        code: "57014",
        message: `canceling statement due to statement timeout ${MARKER}`,
        details: null,
        hint: null,
      }),
    description: "PostgREST 500 statement_timeout",
  },
  {
    name: "rest_403_permission_denied",
    scope: "rest",
    respond: () =>
      json(403, {
        code: "42501",
        message: `permission denied for table ${MARKER}`,
        details: null,
        hint: null,
      }),
    description: "grant drift: PostgREST 403 42501",
  },
  {
    name: "rest_401_jwt_expired",
    scope: "rest",
    respond: () => json(401, { code: "PGRST301", message: `JWT expired ${MARKER}` }),
    description: "PostgREST 401 PGRST301",
  },
  {
    name: "rest_502_html",
    scope: "rest",
    respond: () =>
      raw(502, `<html><body><h1>502 Bad Gateway</h1>${MARKER}</body></html>`, "text/html"),
    description: "gateway HTML page instead of JSON",
  },
  {
    name: "rest_200_malformed_json",
    scope: "rest",
    respond: () => raw(200, `{"unterminated": "${MARKER}`, "application/json"),
    description: "200 with truncated JSON",
  },
  {
    name: "rest_200_null",
    scope: "rest",
    respond: () => raw(200, "null", "application/json"),
    description: "200 with JSON null",
  },
  {
    name: "rest_get_wrong_shape",
    scope: "rest_get",
    respond: () =>
      json(200, [{ garbage: MARKER, id: 42, user_id: 7, created_at: "not-a-date", status: 123 }]),
    description: "GET rows with wrong column types",
  },
  {
    name: "rest_rpc_wrong_shape",
    scope: "rest_rpc",
    respond: () => json(200, { garbage: MARKER }),
    description: "RPC returns object where scalar/rows expected",
  },
  {
    name: "rest_rpc_string_marker",
    scope: "rest_rpc",
    respond: () => json(200, MARKER),
    description: "RPC returns an unknown status string",
  },
  {
    name: "rest_throw",
    scope: "rest",
    respond: "throw",
    description: "fetch rejects with TypeError (network)",
  },
  { name: "rest_hang", scope: "rest", respond: "hang", description: "fetch never resolves" },
  {
    name: "rest_get_1000_rows_forever",
    scope: "rest_get",
    respond: () =>
      json(
        200,
        Array.from({ length: 1000 }, (_, i) => ({
          id: `r${i}`,
          user_id: TEST_USER_ID,
          captured_at: "2026-09-01T10:00:00.000Z",
          overall_score: 5,
          shot_type: "dink",
          result_kind: "scored",
          created_at: "2026-09-01T10:00:00.000Z",
        })),
      ),
    description: "every page is full (pagination cap)",
  },
  {
    name: "auth_500",
    scope: "auth",
    respond: () => json(500, { code: 500, msg: `auth down ${MARKER}` }),
    description: "Supabase Auth 500",
  },
  {
    name: "auth_200_html",
    scope: "auth",
    respond: () => raw(200, `<html>${MARKER}</html>`, "text/html"),
    description: "Supabase Auth returns HTML 200",
  },
  {
    name: "auth_429_rate_limited",
    scope: "auth",
    respond: () =>
      json(429, {
        code: 429,
        error_code: "over_request_rate_limit",
        msg: `Request rate limit reached ${MARKER}`,
      }),
    description: "Supabase Auth 429 (edge egress IP rate-limited)",
  },
  {
    name: "auth_502_html",
    scope: "auth",
    respond: () => raw(502, `<html>bad gateway ${MARKER}</html>`, "text/html"),
    description: "Gateway HTML 502 in front of Supabase Auth",
  },
  { name: "auth_throw", scope: "auth", respond: "throw", description: "Auth fetch throws" },
  {
    name: "rc_500",
    scope: "rc",
    respond: () => raw(500, `upstream error ${MARKER}`, "text/plain"),
    description: "RevenueCat 500",
  },
  {
    name: "rc_401_bad_key",
    scope: "rc",
    respond: () => json(401, { code: 7225, message: `Invalid API key ${MARKER}` }),
    description: "RevenueCat 401 (misconfigured secret)",
  },
  {
    name: "rc_200_garbage",
    scope: "rc",
    respond: () => json(200, { subscriber: MARKER }),
    description: "RevenueCat 200 with wrong shape",
  },
  { name: "rc_throw", scope: "rc", respond: "throw", description: "RevenueCat fetch throws" },
];

/** Faults that are unambiguous upstream failures (a 2xx with no operator log
 * under one of these means the failure was swallowed). Wrong-shape/null
 * payloads are tolerance probes and are reported separately. */
const FAILURE_FAULTS = new Set([
  "rest_500_pg_error",
  "rest_500_statement_timeout",
  "rest_403_permission_denied",
  "rest_401_jwt_expired",
  "rest_502_html",
  "rest_200_malformed_json",
  "rest_throw",
  "rest_hang",
  "auth_500",
  "auth_200_html",
  "auth_429_rate_limited",
  "auth_502_html",
  "auth_throw",
  "rc_500",
  "rc_401_bad_key",
  "rc_throw",
]);

interface Cell {
  route: string;
  fault: string;
  status: number | null;
  contentType: string | null;
  body: string;
  bodyTruncated: boolean;
  requestId: string | null;
  upstreamCalls: { rest: number; auth: number; rc: number; other: number };
  logs: string[];
  threw: string | null;
  hung: boolean;
  ms: number;
  flags: string[];
}

function scopeOf(
  url: string,
  method: string,
): "rest_get" | "rest_rpc" | "rest_other" | "auth" | "rc" | "other" {
  if (url.startsWith(RC_URL)) return "rc";
  if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return "auth";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/rpc/`)) return "rest_rpc";
  if (url.startsWith(`${SUPABASE_URL}/rest/v1/`))
    return method === "GET" ? "rest_get" : "rest_other";
  return "other";
}
function faultApplies(fault: Fault, scope: ReturnType<typeof scopeOf>): boolean {
  switch (fault.scope) {
    case "rest":
      return scope.startsWith("rest");
    case "rest_get":
      return scope === "rest_get";
    case "rest_rpc":
      return scope === "rest_rpc";
    case "auth":
      return scope === "auth";
    case "rc":
      return scope === "rc";
  }
}

const INTERNAL_PATTERNS: Array<[string, RegExp]> = [
  ["canary", new RegExp(MARKER)],
  ["upstream_host", /supabase\.test|rest\/v1|auth\/v1|revenuecat\.com/],
  ["stack_trace", /\n\s+at\s+\S+:\d+:\d+/],
  ["pg_sqlstate", /"code"\s*:\s*"(?:XX000|42501|PGRST\d+|2[0-9A-Z]{4}|4[0-9A-Z]{4})"/],
  ["service_key", /service-role-test-key|sk_test_revenuecat|wf-test-webhook-secret/],
];

async function main() {
  const h = await loadHarness();
  const baseFetch = globalThis.fetch;
  let active: Fault = FAULTS[0];
  let counts = { rest: 0, auth: 0, rc: 0, other: 0 };
  const hangers: Array<() => void> = [];
  // Once a cell's hung fetches were released, later hangs in the same cell
  // fail fast (a dropped socket), so the handler can settle and be measured.
  let released = false;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const scope = scopeOf(request.url, request.method);
    if (scope === "rest_get" || scope === "rest_rpc" || scope === "rest_other") counts.rest += 1;
    else if (scope === "auth") counts.auth += 1;
    else if (scope === "rc") counts.rc += 1;
    else counts.other += 1;
    if (active.name !== "none" && faultApplies(active, scope)) {
      if (active.respond === "throw") throw new TypeError(`error sending request: ${MARKER}`);
      if (active.respond === "hang") {
        if (released) throw new TypeError(`error sending request: ${MARKER} (socket closed)`);
        return new Promise<Response>((_, reject) =>
          hangers.push(() => reject(new TypeError("probe released hang"))),
        );
      }
      return (active.respond as Respond)(request);
    }
    // Gaps in the shared harness stub that the happy path needs: Auth logout
    // and PostgREST writes that ask for the representation back.
    if (scope === "auth" && request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      return new Response(null, { status: 204 });
    }
    if (
      scope === "auth" &&
      request.method === "GET" &&
      request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)
    ) {
      const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      const sub = jwtSub(bearer);
      if (!sub) {
        return json(401, { code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
      }
      return json(200, {
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: "user@example.com",
        app_metadata: { provider: "google", providers: ["google"] },
        user_metadata: {},
        created_at: "2026-09-01T00:00:00.000Z",
      });
    }
    if (
      scope === "rest_other" &&
      (request.headers.get("prefer") ?? "").includes("return=representation")
    ) {
      const table = new URL(request.url).pathname.slice("/rest/v1/".length);
      let payload: unknown = null;
      try {
        payload = JSON.parse(await request.clone().text());
      } catch {
        payload = null;
      }
      const existing = (h.tables[table]?.[0] ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(payload)
        ? payload.map((p) => ({ ...existing, ...(p as Record<string, unknown>) }))
        : [{ ...existing, ...((payload ?? {}) as Record<string, unknown>) }];
      const wantsObject = (request.headers.get("accept") ?? "").includes(
        "application/vnd.pgrst.object+json",
      );
      return json(request.method === "POST" ? 201 : 200, wantsObject ? rows[0] : rows);
    }
    return baseFetch(input, init);
  }) as typeof fetch;

  const logs: string[] = [];
  // The handler's own console output is evidence (operator logs), so every
  // level is captured per cell; root eslint forbids naming console.log in
  // *.ts, hence the keyed sink.
  const CAPTURED_LEVELS = ["error", "warn", "log", "info"] as const;
  const consoleSink = console as unknown as Record<
    (typeof CAPTURED_LEVELS)[number],
    (...parts: unknown[]) => void
  >;
  const realConsole = Object.fromEntries(
    CAPTURED_LEVELS.map((level) => [level, consoleSink[level]]),
  );
  const capture =
    (level: string) =>
    (...parts: unknown[]) =>
      logs.push(
        `${level}: ${parts.map((p) => (p instanceof Error ? `${p.name}: ${p.message}` : typeof p === "string" ? p : JSON.stringify(p))).join(" ")}`,
      );
  for (const level of CAPTURED_LEVELS) consoleSink[level] = capture(level);

  const cells: Cell[] = [];
  // Every cell authenticates as a fresh user (deterministic UUIDs) so the
  // per-user rate limits never turn a fault cell into a 429.
  let userCounter = 0;
  const nextUser = (): string => {
    userCounter += 1;
    return `aaaaaaaa-0000-4000-8000-${String(userCounter).padStart(12, "0")}`;
  };
  const buildRequest = (route: RouteSpec): Request => {
    if (route.kind === "webhook") return webhookRequest(route.body as Record<string, unknown>);
    if (route.kind === "public")
      return new Request(`http://edge.test/functions/v1/api${route.path}`, {
        method: route.method,
      });
    if (route.kind === "session")
      return userRequest(route.method, route.path, {
        body: route.body,
        token: fakeSessionToken(nextUser()),
      });
    return userRequest(route.method, route.path, {
      body: route.body,
      token: fakeGoogleIdToken(nextUser()),
    });
  };

  async function runCell(
    route: RouteSpec,
    fault: Fault,
    request: Request,
    ip?: string,
  ): Promise<Cell> {
    h.reset();
    h.subscriber = activeSubscriber();
    if (route.tables) h.tables = { ...route.tables };
    if (route.rpcs) h.rpcs = { ...route.rpcs };
    counts = { rest: 0, auth: 0, rc: 0, other: 0 };
    logs.length = 0;
    active = fault;
    released = false;
    if (ip) request.headers.set("x-forwarded-for", ip);
    const started = performance.now();
    const cell: Cell = {
      route: route.name,
      fault: fault.name,
      status: null,
      contentType: null,
      body: "",
      bodyTruncated: false,
      requestId: null,
      upstreamCalls: counts,
      logs: [],
      threw: null,
      hung: false,
      ms: 0,
      flags: [],
    };
    let timer: number | undefined;
    try {
      const pending = h.handler(request);
      let response = await Promise.race([
        pending,
        new Promise<"hang">((resolve) => {
          timer = setTimeout(() => resolve("hang"), HANG_BUDGET_MS);
        }),
      ]);
      if (response === "hang") {
        // No answer inside the budget: release any hung upstream fetches (they
        // reject like a dropped socket) and wait for the handler to settle so
        // logs/status are attributed to THIS cell, not the next one.
        cell.flags.push(hangers.length > 0 ? "no_upstream_timeout" : "slow_response");
        released = true;
        for (const release of hangers.splice(0)) release();
        clearTimeout(timer);
        response = await Promise.race([
          pending,
          new Promise<"hang">((resolve) => {
            timer = setTimeout(() => resolve("hang"), SETTLE_BUDGET_MS);
          }),
        ]);
      }
      if (response === "hang") {
        cell.hung = true;
        cell.flags.push("hang");
      } else {
        cell.status = response.status;
        cell.contentType = response.headers.get("content-type");
        cell.requestId = response.headers.get("x-request-id");
        const text = await response.text();
        cell.body = text.length > 2_000 ? text.slice(0, 2_000) : text;
        cell.bodyTruncated = text.length > 2_000;
        const headerBlob = [...response.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
        for (const [label, re] of INTERNAL_PATTERNS) {
          if (re.test(text)) cell.flags.push(`leak_body:${label}`);
          if (re.test(headerBlob)) cell.flags.push(`leak_header:${label}`);
        }
        if (!cell.requestId) cell.flags.push("no_reqid");
        if (response.status >= 500) {
          if (![500, 502, 503].includes(response.status)) cell.flags.push("bad_5xx:status");
          try {
            const parsed = JSON.parse(text);
            const msg = parsed?.error?.message;
            const keys = Object.keys(parsed?.error ?? {}).filter(
              (k) => !["code", "message", "retryAfterSeconds"].includes(k),
            );
            if (typeof msg !== "string" || keys.length > 0) cell.flags.push("bad_5xx:shape");
          } catch {
            cell.flags.push("bad_5xx:not_json");
          }
        }
        if (response.status >= 400 && (cell.contentType ?? "").includes("json")) {
          try {
            JSON.parse(text);
          } catch {
            cell.flags.push("error_not_json");
          }
        }
      }
    } catch (error) {
      cell.threw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      cell.flags.push("threw");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    cell.ms = Math.round(performance.now() - started);
    cell.upstreamCalls = { ...counts };
    cell.logs = [...logs];
    const faultHit =
      fault.name !== "none" &&
      ((fault.scope.startsWith("rest") && counts.rest > 0) ||
        (fault.scope === "auth" && counts.auth > 0) ||
        (fault.scope === "rc" && counts.rc > 0));
    if (
      faultHit &&
      cell.status !== null &&
      cell.status < 400 &&
      cell.logs.filter((l) => !l.includes('"evt":"api_request"')).length === 0
    ) {
      cell.flags.push(
        FAILURE_FAULTS.has(fault.name) ? "swallowed_failure" : "tolerated_wrong_shape",
      );
    }
    if (
      faultHit &&
      cell.status !== null &&
      cell.status >= 500 &&
      !cell.logs.some((l) => l.startsWith("error:"))
    ) {
      cell.flags.push("5xx_without_operator_log");
    }
    // The app treats 401/403 from /v1/auth/refresh as "refresh token revoked"
    // and signs the user out (apps/mobile/src/account/sessionLifecycle.ts), so a
    // transient Auth-side fault must never surface as one of those statuses.
    if (
      route.name === "auth_refresh" &&
      faultHit &&
      FAILURE_FAULTS.has(fault.name) &&
      (cell.status === 401 || cell.status === 403)
    ) {
      cell.flags.push("transient_auth_fault_returned_as_revoked");
    }
    // A 401 on a session-bearer route makes the app refresh; under the same
    // Auth fault the refresh then answers 401 too, so this is the same sign-out.
    if (
      route.kind === "session" &&
      fault.scope === "auth" &&
      faultHit &&
      FAILURE_FAULTS.has(fault.name) &&
      cell.status === 401
    ) {
      cell.flags.push("transient_auth_fault_returned_as_unauthorized");
    }
    if (fault.name === "none" && cell.status !== null && cell.status >= 500) {
      cell.flags.push("5xx_on_happy_path");
    }
    return cell;
  }

  // ─── Fault matrix ───
  let ipCounter = 1;
  const nextIp = () => `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const onlyRoutes = argValue("--routes")?.split(",").filter(Boolean);
  const onlyFaults = argValue("--faults")?.split(",").filter(Boolean);
  const selectedRoutes = ROUTES.filter((r) => !onlyRoutes || onlyRoutes.includes(r.name));
  const selectedFaults = FAULTS.filter(
    (f) => !onlyFaults || f.name === "none" || onlyFaults.includes(f.name),
  );
  for (const route of selectedRoutes) {
    for (const fault of selectedFaults) {
      cells.push(await runCell(route, fault, buildRequest(route), nextIp()));
    }
  }

  // ─── Seeded fuzz corpus ───
  let s = SEED >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const junkString = () =>
    pick([
      "",
      " ",
      "\u0000",
      "\ud800",
      "'; drop table shots; --",
      "<script>alert(1)</script>",
      "{{7*7}}",
      "%E0%A4%A",
      "../../etc/passwd",
      "x".repeat(70_000),
      "\u202e\u0000\uffff",
      "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
      "2026-13-45T99:99:99Z",
      "00000000-0000-0000-0000-000000000000",
      "not-a-uuid",
      String(Number.MAX_SAFE_INTEGER),
    ]);
  const junkScalar = (): unknown =>
    pick<unknown>([null, true, false, 0, -1, 1e308, -1e308, 0.1, 2 ** 53, junkString(), [], {}]);
  const junkValue = (depth: number): unknown => {
    if (depth <= 0) return junkScalar();
    const r = rnd();
    if (r < 0.45) return junkScalar();
    if (r < 0.7) return Array.from({ length: Math.floor(rnd() * 4) }, () => junkValue(depth - 1));
    const o: Record<string, unknown> = {};
    for (let i = 0; i < Math.floor(rnd() * 5); i += 1)
      o[
        pick([
          "id",
          "shots",
          "trials",
          "scope",
          "outcome",
          "idempotencyKey",
          "challenge",
          "survey",
          "rating",
          "category",
          "handedness",
          "startedAt",
          "refreshToken",
          "__proto__",
          "constructor",
          junkString(),
        ])
      ] = junkValue(depth - 1);
    return o;
  };
  const mutate = (body: unknown): unknown => {
    if (body === undefined || body === null || typeof body !== "object") return junkValue(3);
    const clone = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
    const keys = Object.keys(clone);
    if (keys.length === 0 || rnd() < 0.3) return junkValue(3);
    const key = pick(keys);
    const r = rnd();
    if (r < 0.4) clone[key] = junkValue(2);
    else if (r < 0.7) delete clone[key];
    else if (Array.isArray(clone[key])) (clone[key] as unknown[]).push(junkValue(2));
    else
      clone[key] = {
        ...(typeof clone[key] === "object" && clone[key] ? (clone[key] as object) : {}),
        [junkString()]: junkValue(1),
      };
    return clone;
  };
  const pathSegment = (value: string): string => {
    try {
      return encodeURIComponent(value).slice(0, 4_000);
    } catch {
      return "%ED%A0%80";
    }
  };
  const rawBodies = [
    "",
    "null",
    "[]",
    '"str"',
    "{",
    '{"a":',
    "\ufeff{}",
    '{"a":1}garbage',
    "[".repeat(50_000),
    JSON.stringify({ a: "x".repeat(4_999_000) }),
  ];

  interface FuzzCase {
    route: string;
    index: number;
    input: { method: string; path: string; body: string; headers?: Record<string, string> };
    cell: Cell;
  }
  const fuzzAnomalies: FuzzCase[] = [];
  let fuzzCount = 0;
  const fuzzRoutes = ROUTES.filter(
    (r) => r.kind === "user" && (r.method === "POST" || r.method === "PUT"),
  );
  for (const route of fuzzRoutes) {
    for (let i = 0; i < FUZZ_PER_ROUTE; i += 1) {
      const useRaw = i < rawBodies.length;
      const bodyText = useRaw ? rawBodies[i] : JSON.stringify(mutate(route.body));
      let path = route.path;
      if (rnd() < 0.3)
        path = path
          .replace(/[0-9a-f-]{36}/i, pathSegment(junkString()))
          .replace("dink-consistency", pathSegment(junkString()));
      const headers = new Headers({
        Authorization: `Bearer ${fakeGoogleIdToken(nextUser())}`,
        "x-forwarded-for": nextIp(),
        "Content-Type": "application/json",
      });
      if (rnd() < 0.15) {
        try {
          headers.set("x-request-id", junkString());
        } catch {
          headers.set("x-request-id", "not-a-uuid");
        }
      }
      const request = new Request(`http://edge.test/functions/v1/api${path}`, {
        method: route.method,
        headers,
        body: bodyText,
      });
      const cell = await runCell(route, FAULTS[0], request);
      fuzzCount += 1;
      const anomaly =
        cell.threw ||
        cell.hung ||
        (cell.status !== null && cell.status >= 500) ||
        cell.flags.some((f) => f.startsWith("leak"));
      if (anomaly)
        fuzzAnomalies.push({
          route: route.name,
          index: i,
          input: {
            method: route.method,
            path,
            body:
              bodyText.length > 5_000
                ? `${bodyText.slice(0, 5_000)}…(${bodyText.length} bytes)`
                : bodyText,
          },
          cell,
        });
    }
  }

  // ─── Oversize body + oversize path ───
  const extra: Cell[] = [];
  {
    const big = JSON.stringify({ shots: ["x".repeat(5_000_001)] });
    const req = userRequest("POST", "/v1/shots:sync", {
      body: undefined,
      ip: nextIp(),
      token: fakeGoogleIdToken(nextUser()),
    });
    const r2 = new Request(req.url, {
      method: "POST",
      headers: { ...Object.fromEntries(req.headers.entries()), "Content-Type": "application/json" },
      body: big,
    });
    const cell = await runCell(
      ROUTES.find((r) => r.name === "shots_sync")!,
      FAULTS[0],
      r2,
    );
    cell.route = "shots_sync[5MB+1 body]";
    extra.push(cell);
  }
  {
    const req = userRequest("GET", `/v1/${"a".repeat(60_000)}`, {
      ip: nextIp(),
      token: fakeGoogleIdToken(nextUser()),
    });
    const cell = await runCell(
      { name: "unknown_route[60k path]", method: "GET", path: "", kind: "user" },
      FAULTS[0],
      req,
    );
    extra.push(cell);
  }
  {
    const req = userRequest("POST", "/v1/analysis-permits/%E0%A4%A/finalize", {
      ip: nextIp(),
      token: fakeGoogleIdToken(nextUser()),
      body: { outcome: "cancelled" },
    });
    extra.push(
      await runCell(
        { name: "permits_finalize[malformed escape]", method: "POST", path: "", kind: "user" },
        FAULTS[0],
        req,
      ),
    );
  }
  {
    const req = userRequest("GET", "/v1/nope/%3Cscript%3E%0d%0aX-Injected:%201", {
      ip: nextIp(),
      token: fakeGoogleIdToken(nextUser()),
    });
    extra.push(
      await runCell(
        { name: "unknown_route[hostile path]", method: "GET", path: "", kind: "user" },
        FAULTS[0],
        req,
      ),
    );
  }
  {
    const req = userRequest("GET", "/v1/me", {
      ip: nextIp(),
      token: fakeGoogleIdToken(nextUser()),
      headers: { "x-request-id": `${MARKER}<script>` },
    });
    const cell = await runCell(
      {
        name: "me[hostile x-request-id]",
        method: "GET",
        path: "",
        kind: "user",
        tables: { profiles: [profileRow] },
      },
      FAULTS[0],
      req,
    );
    extra.push(cell);
  }

  Object.assign(console, realConsole);
  globalThis.fetch = baseFetch;

  const allCells = [...cells, ...extra];
  const flagged = allCells.filter((c) => c.flags.length > 0);
  const byFlag: Record<string, string[]> = {};
  for (const c of flagged)
    for (const f of c.flags) (byFlag[f] ??= []).push(`${c.route}×${c.fault}`);
  const report = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    fuzzPerRoute: FUZZ_PER_ROUTE,
    hangBudgetMs: HANG_BUDGET_MS,
    marker: MARKER,
    routes: ROUTES.map((r) => ({ name: r.name, method: r.method, path: r.path })),
    faults: FAULTS.map((f) => ({ name: f.name, scope: f.scope, description: f.description })),
    matrix: { cells: allCells.length, flagged: flagged.length, byFlag },
    statusMatrix: Object.fromEntries(
      ROUTES.map((r) => [
        r.name,
        Object.fromEntries(
          cells
            .filter((c) => c.route === r.name)
            .map((c) => [c.fault, c.hung ? "HANG" : c.threw ? "THREW" : c.status]),
        ),
      ]),
    ),
    fuzz: { cases: fuzzCount, anomalies: fuzzAnomalies.length, anomalyCases: fuzzAnomalies },
    cells: allCells,
  };
  const out = JSON.stringify(report, null, 2);
  if (OUT) await Deno.writeTextFile(OUT, out);
  else print(out);
  console.error(
    `cells ${allCells.length} flagged ${flagged.length}; fuzz ${fuzzCount} anomalies ${fuzzAnomalies.length}`,
  );
  for (const [flag, where] of Object.entries(byFlag))
    console.error(
      `  ${flag}: ${where.length} → ${where.slice(0, 8).join(", ")}${where.length > 8 ? " …" : ""}`,
    );
  const HARD_FLAGS = new Set([
    "threw",
    "hang",
    "swallowed_failure",
    "5xx_on_happy_path",
    "5xx_without_operator_log",
    "transient_auth_fault_returned_as_revoked",
    "transient_auth_fault_returned_as_unauthorized",
  ]);
  const hard = flagged.filter((c) =>
    c.flags.some((f) => f.startsWith("leak") || f.startsWith("bad_5xx") || HARD_FLAGS.has(f)),
  );
  Deno.exit(hard.length > 0 || fuzzAnomalies.length > 0 ? 1 : 0);
}

await main();
