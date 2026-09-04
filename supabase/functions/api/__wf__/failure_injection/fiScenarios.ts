// Route inventory + failure matrix + response classification for the
// failure-injection harness. Pure data/logic — no I/O beyond building
// Requests. See fiRunner.ts for execution and artifact writing.

import {
  canonicalShot,
  type Dependency,
  edgeRequest,
  type FaultMode,
  type FaultRule,
  httpFault,
  providerIdToken,
  type ScenarioContext,
  WEBHOOK_SECRET,
} from "./fiHarness.ts";

export type AuthKind = "none" | "webhook" | "provider_token" | "session";

export interface RouteSpec {
  id: string;
  method: string;
  path: (ctx: ScenarioContext) => string;
  auth: AuthKind;
  provider?: "google" | "apple";
  body?: (ctx: ScenarioContext) => unknown;
  headers?: (ctx: ScenarioContext) => Record<string, string>;
  /** Upstream dependencies this route can reach on its healthy path. */
  deps: Dependency[];
  /** Context tweaks (fixtures) for the healthy path. */
  context?: (ctx: ScenarioContext) => ScenarioContext;
  /** A 200 whose body reports per-item retryable rejections is honest. */
  perItemEnvelope?: "shots" | "trials";
  /** Upstream calls the route treats as best-effort BY DESIGN (logged,
   * response unchanged) — a single-call sweep on them is expected to keep
   * the healthy status. The design intent is cited in the note. */
  bestEffortCalls?: (call: { method: string; path: string }) => string | null;
  /** Upstream calls judged by status only (body not part of the contract),
   * so a 2xx with a malformed body is a genuine success. */
  statusOnlyCalls?: (call: { method: string; path: string }) => boolean;
}

const rc = (ctx: ScenarioContext) => ctx; // identity helper for readability

export const ROUTES: RouteSpec[] = [
  {
    id: "healthz",
    method: "GET",
    path: () => "/healthz",
    auth: "none",
    deps: ["redis"],
  },
  {
    id: "support",
    method: "GET",
    path: () => "/support",
    auth: "none",
    deps: ["redis"],
  },
  {
    id: "privacy",
    method: "GET",
    path: () => "/privacy",
    auth: "none",
    deps: ["redis"],
  },
  {
    id: "terms",
    method: "GET",
    path: () => "/terms",
    auth: "none",
    deps: ["redis"],
  },
  {
    id: "webhook_revenuecat",
    method: "POST",
    path: () => "/webhooks/revenuecat",
    auth: "webhook",
    body: (ctx) => ({
      api_version: "1.0",
      event: { id: ctx.ids.eventId, type: "RENEWAL", app_user_id: ctx.userId },
    }),
    deps: ["redis", "rest", "revenuecat"],
    bestEffortCalls: (c) =>
      c.path === "/rest/v1/webhook_events" && c.method === "GET"
        ? "dedupe lookup failure is logged and the event is re-verified (index.ts handleRevenueCatWebhook `seen.error`)"
        : c.path === "/rest/v1/webhook_events" && c.method === "POST"
        ? "audit row is written after the verdict is persisted; failure is logged only (index.ts `logEvent`)"
        : null,
  },
  {
    id: "account_bootstrap_google",
    method: "POST",
    path: () => "/v1/account/bootstrap",
    auth: "provider_token",
    provider: "google",
    body: () => ({}),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "account_bootstrap_apple",
    method: "POST",
    path: () => "/v1/account/bootstrap",
    auth: "provider_token",
    provider: "apple",
    body: () => ({ appleAuthorizationCode: "fi-apple-authorization-code" }),
    headers: () => ({ "X-Apple-Revocation-Protocol": "1" }),
    deps: ["redis", "auth", "rest", "apple"],
  },
  {
    id: "auth_refresh",
    method: "POST",
    path: () => "/v1/auth/refresh",
    auth: "none",
    body: (ctx) => ({ refreshToken: ctx.refreshToken }),
    deps: ["redis", "auth"],
  },
  {
    id: "auth_logout",
    method: "POST",
    path: () => "/v1/auth/logout",
    auth: "session",
    deps: ["redis", "auth"],
    statusOnlyCalls: (c) => c.path === "/auth/v1/logout",
  },
  {
    id: "me",
    method: "GET",
    path: () => "/v1/me",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "me_onboarding",
    method: "PUT",
    path: () => "/v1/me/onboarding",
    auth: "session",
    body: () => ({
      skillLevel: "intermediate",
      handedness: "right",
      goal: "dinks",
      biggestProblem: "Consistency at the kitchen line",
    }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "me_access",
    method: "GET",
    path: () => "/v1/me/access",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "billing_sync",
    method: "POST",
    path: () => "/v1/billing/sync",
    auth: "session",
    body: () => ({}),
    deps: ["redis", "auth", "rest", "revenuecat"],
  },
  {
    id: "analysis_permits_reserve",
    method: "POST",
    path: () => "/v1/analysis-permits",
    auth: "session",
    body: (ctx) => ({ idempotencyKey: `fi-${ctx.ids.permitId}` }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "analysis_permits_finalize",
    method: "POST",
    path: (ctx) => `/v1/analysis-permits/${ctx.ids.permitId}/finalize`,
    auth: "session",
    body: () => ({ outcome: "cancelled", ratingId: null }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "shots_sync",
    method: "POST",
    path: () => "/v1/shots:sync",
    auth: "session",
    body: (ctx) => ({ shots: [canonicalShot(ctx)] }),
    deps: ["redis", "auth", "rest"],
    perItemEnvelope: "shots",
  },
  {
    id: "sessions_create",
    method: "POST",
    path: () => "/v1/sessions",
    auth: "session",
    body: (ctx) => ({
      id: ctx.ids.sessionId,
      startedAt: "2026-09-01T10:00:00.000Z",
    }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "sessions_finalize",
    method: "POST",
    path: (ctx) => `/v1/sessions/${ctx.ids.sessionId}/finalize`,
    auth: "session",
    body: (ctx) => ({ id: ctx.ids.sessionId }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "analyses_feedback",
    method: "POST",
    path: (ctx) => `/v1/analyses/${ctx.ids.analysisId}/feedback`,
    auth: "session",
    body: () => ({ rating: "not_quite", category: "wrong_stroke" }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "evaluation_trials",
    method: "POST",
    path: () => "/v1/me/evaluation/trials",
    auth: "session",
    body: (ctx) => ({ trials: [{ trialId: ctx.ids.trialId, kind: "fi" }] }),
    deps: ["redis", "auth", "rest"],
    perItemEnvelope: "trials",
  },
  {
    id: "progress",
    method: "GET",
    path: () => "/v1/progress",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "rank",
    method: "GET",
    path: () => "/v1/rank",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "consent_status",
    method: "GET",
    path: () => "/v1/me/consent/status",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "consent_grant",
    method: "POST",
    path: () => "/v1/me/consent/grant",
    auth: "session",
    body: () => ({
      scope: "video_analysis",
      consentVersion: "2026-08",
      source: "settings",
    }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "consent_withdraw",
    method: "POST",
    path: () => "/v1/me/consent/withdraw",
    auth: "session",
    body: () => ({ scope: "model_training", source: "settings" }),
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "delete_request",
    method: "POST",
    path: () => "/v1/me/delete-request",
    auth: "session",
    body: () => ({
      survey: { reason: "not_using", wanted: "content", platform: "ios" },
    }),
    deps: ["redis", "auth", "rest"],
    bestEffortCalls: (c) =>
      c.path === "/rest/v1/profiles" || c.path === "/rest/v1/rpc/access_state"
        ? "exit-survey context (profile age / scored count) is best-effort: index.ts 'survey context partial'"
        : c.path === "/rest/v1/account_deletion_feedback"
        ? "exit-survey insert is best-effort: index.ts 'exit survey not recorded'"
        : null,
  },
  {
    id: "delete_confirm_google",
    method: "POST",
    path: () => "/v1/me/delete-confirm",
    auth: "session",
    provider: "google",
    body: (ctx) => ({ challenge: ctx.ids.challenge }),
    deps: ["redis", "auth", "rest", "revenuecat"],
  },
  {
    id: "delete_confirm_apple",
    method: "POST",
    path: () => "/v1/me/delete-confirm",
    auth: "session",
    provider: "apple",
    body: (ctx) => ({ challenge: ctx.ids.challenge }),
    deps: ["redis", "auth", "rest", "revenuecat", "apple"],
    context: (ctx) => ({ ...rc(ctx), appleCredentialStored: true }),
  },
  {
    id: "saved_drills_list",
    method: "GET",
    path: () => "/v1/me/saved-drills",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "saved_drills_save",
    method: "PUT",
    path: (ctx) => `/v1/me/saved-drills/${ctx.ids.drillSlug}`,
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "saved_drills_unsave",
    method: "DELETE",
    path: (ctx) => `/v1/me/saved-drills/${ctx.ids.drillSlug}`,
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "catalog_drills_list",
    method: "GET",
    path: () => "/v1/catalog/drills",
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "catalog_drill_get",
    method: "GET",
    path: (ctx) => `/v1/catalog/drills/${ctx.ids.drillSlug}`,
    auth: "session",
    deps: ["redis", "auth", "rest"],
  },
  {
    id: "training_plans_current",
    method: "GET",
    path: () => "/v1/training-plans/current",
    auth: "session",
    deps: ["redis", "auth"],
  },
  {
    id: "training_plans_create",
    method: "POST",
    path: () => "/v1/training-plans",
    auth: "session",
    body: () => ({}),
    deps: ["redis", "auth"],
  },
];

export function buildRouteRequest(
  route: RouteSpec,
  ctx: ScenarioContext,
): Request {
  const path = route.path(ctx);
  const headers = route.headers?.(ctx) ?? {};
  let bearer: string | null;
  switch (route.auth) {
    case "none":
      bearer = null;
      break;
    case "webhook":
      bearer = null;
      headers["Authorization"] = WEBHOOK_SECRET;
      break;
    case "provider_token":
      bearer = providerIdToken(route.provider ?? "google", ctx.userId);
      break;
    case "session":
      bearer = ctx.bearer;
      break;
  }
  return edgeRequest(ctx, route.method, path, {
    body: route.body?.(ctx),
    bearer,
    headers,
  });
}

// ─── Failure modes per dependency ────────────────────────────────────────────

export interface ModeSpec {
  id: string;
  dependency: Dependency;
  /** How realistic the injected upstream behaviour is (for triage). */
  realism: "high" | "medium" | "low";
  make: (sentinel: string) => FaultMode;
  /** Wall-clock budget the scenario waits before declaring the route hung. */
  responseBudgetMs?: number;
}

/** Longer than every mobile client request timeout (15s in
 * sessionLifecycle/progress/consent, 20s in data/api.ts): a route still
 * silent at this point has no upstream timeout of its own — the app has
 * already given up on it. */
const HANG_BUDGET_MS = 25_000;

export const MODES: ModeSpec[] = [
  // Supabase Auth (GoTrue)
  {
    id: "down_503",
    dependency: "auth",
    realism: "high",
    make: (s) => httpFault("auth", 503, s),
  },
  {
    id: "error_500",
    dependency: "auth",
    realism: "high",
    make: (s) => httpFault("auth", 500, s),
  },
  {
    id: "gateway_502_html",
    dependency: "auth",
    realism: "high",
    make: (s) => httpFault("auth", 502, s),
  },
  {
    id: "network_error",
    dependency: "auth",
    realism: "high",
    make: () => ({ kind: "network_error" }),
  },
  {
    id: "malformed_json",
    dependency: "auth",
    realism: "medium",
    make: () => ({ kind: "malformed_json" }),
  },
  {
    id: "wrong_shape",
    dependency: "auth",
    realism: "low",
    make: () => ({ kind: "wrong_shape" }),
  },
  {
    id: "empty_body",
    dependency: "auth",
    realism: "medium",
    make: () => ({ kind: "empty_body" }),
  },
  {
    id: "slow_1500ms",
    dependency: "auth",
    realism: "high",
    make: () => ({ kind: "slow", delayMs: 1_500 }),
  },
  {
    id: "hang",
    dependency: "auth",
    realism: "high",
    make: () => ({ kind: "hang" }),
    responseBudgetMs: HANG_BUDGET_MS,
  },
  // PostgREST (database)
  {
    id: "error_500",
    dependency: "rest",
    realism: "high",
    make: (s) => httpFault("rest", 500, s),
  },
  {
    id: "down_503",
    dependency: "rest",
    realism: "high",
    make: (s) => httpFault("rest", 503, s),
  },
  {
    id: "gateway_502_html",
    dependency: "rest",
    realism: "high",
    make: (s) => httpFault("rest", 502, s),
  },
  {
    id: "network_error",
    dependency: "rest",
    realism: "high",
    make: () => ({ kind: "network_error" }),
  },
  {
    id: "malformed_json",
    dependency: "rest",
    realism: "medium",
    make: () => ({ kind: "malformed_json" }),
  },
  {
    id: "wrong_shape",
    dependency: "rest",
    realism: "low",
    make: () => ({ kind: "wrong_shape" }),
  },
  {
    id: "empty_body",
    dependency: "rest",
    realism: "medium",
    make: () => ({ kind: "empty_body" }),
  },
  {
    id: "hang",
    dependency: "rest",
    realism: "high",
    make: () => ({ kind: "hang" }),
    responseBudgetMs: HANG_BUDGET_MS,
  },
  // Upstash Redis
  {
    id: "error_500",
    dependency: "redis",
    realism: "high",
    make: (s) => httpFault("redis", 500, s),
  },
  {
    id: "unauthorized_401",
    dependency: "redis",
    realism: "high",
    make: (s) => httpFault("redis", 401, s),
  },
  {
    id: "network_error",
    dependency: "redis",
    realism: "high",
    make: () => ({ kind: "network_error" }),
  },
  {
    id: "malformed_json",
    dependency: "redis",
    realism: "medium",
    make: () => ({ kind: "malformed_json" }),
  },
  {
    id: "wrong_shape",
    dependency: "redis",
    realism: "medium",
    make: () => ({ kind: "wrong_shape" }),
  },
  {
    id: "slow_300ms",
    dependency: "redis",
    realism: "high",
    make: () => ({ kind: "slow", delayMs: 300 }),
  },
  {
    id: "hang",
    dependency: "redis",
    realism: "high",
    make: () => ({ kind: "hang" }),
    responseBudgetMs: 20_000,
  },
  // RevenueCat
  {
    id: "error_500",
    dependency: "revenuecat",
    realism: "high",
    make: (s) => httpFault("revenuecat", 500, s),
  },
  {
    id: "gateway_502_html",
    dependency: "revenuecat",
    realism: "high",
    make: (s) => httpFault("revenuecat", 502, s),
  },
  {
    id: "network_error",
    dependency: "revenuecat",
    realism: "high",
    make: () => ({ kind: "network_error" }),
  },
  {
    id: "malformed_json",
    dependency: "revenuecat",
    realism: "medium",
    make: () => ({ kind: "malformed_json" }),
  },
  {
    id: "wrong_shape",
    dependency: "revenuecat",
    realism: "medium",
    make: () => ({ kind: "wrong_shape" }),
  },
  {
    id: "empty_body",
    dependency: "revenuecat",
    realism: "medium",
    make: () => ({ kind: "empty_body" }),
  },
  {
    id: "slow_2000ms",
    dependency: "revenuecat",
    realism: "high",
    make: () => ({ kind: "slow", delayMs: 2_000 }),
  },
  {
    id: "hang",
    dependency: "revenuecat",
    realism: "high",
    make: () => ({ kind: "hang" }),
    responseBudgetMs: 20_000,
  },
  // Apple (token exchange / revocation)
  {
    id: "error_500",
    dependency: "apple",
    realism: "high",
    make: (s) => httpFault("apple", 500, s),
  },
  {
    id: "network_error",
    dependency: "apple",
    realism: "high",
    make: () => ({ kind: "network_error" }),
  },
  {
    id: "malformed_json",
    dependency: "apple",
    realism: "medium",
    make: () => ({ kind: "malformed_json" }),
  },
  {
    id: "wrong_shape",
    dependency: "apple",
    realism: "medium",
    make: () => ({ kind: "wrong_shape" }),
  },
  {
    id: "invalid_grant_400",
    dependency: "apple",
    realism: "high",
    make: () => ({
      kind: "http",
      status: 400,
      body: JSON.stringify({ error: "invalid_grant" }),
      contentType: "application/json",
    }),
  },
];

/** Modes that are cheap enough for the default (smoke) tier. */
export const SMOKE_MODE_IDS = new Set([
  "auth:down_503",
  "auth:network_error",
  "auth:malformed_json",
  "rest:error_500",
  "rest:malformed_json",
  "redis:network_error",
  "redis:malformed_json",
  "revenuecat:error_500",
  "revenuecat:malformed_json",
  "apple:error_500",
  "apple:invalid_grant_400",
]);

// ─── Scenario records ────────────────────────────────────────────────────────

export type BodyClass =
  | "success_json"
  | "success_text"
  | "no_content"
  | "coded_error"
  | "generic_error"
  | "rate_limited"
  | "non_json"
  | "no_response";

export type Verdict =
  | "pass"
  | "degraded_ok"
  | "per_item_retryable_ok"
  | "retried_ok"
  | "false_success"
  | "misclassified_auth_failure"
  | "misclassified_client_error"
  | "unhandled_500"
  | "leak"
  | "hang_unbounded"
  | "locked_out"
  | "unexpected_status";

export type Recoverability =
  | "retryable"
  | "retry_after"
  | "client_signs_out"
  | "client_shows_error"
  | "success"
  | "per_item_retry"
  | "unknown";

export interface ScenarioRecord {
  id: string;
  seed: string;
  tier: "baseline" | "matrix" | "sweep" | "targeted";
  route: string;
  method: string;
  path: string;
  dependency: Dependency | "none";
  mode: string;
  realism: "high" | "medium" | "low" | "n/a";
  /** For sweeps: which matching upstream call (0-based) was faulted. */
  faultedCallIndex: number | null;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  };
  userId: string;
  ip: string;
  sentinel: string;
  status: number | null;
  bodyClass: BodyClass;
  bodyPreview: string;
  errorCode: string | null;
  errorMessage: string | null;
  headers: Record<string, string>;
  durationMs: number;
  upstreamCalls: number;
  faultedCalls: number;
  faultedDependencyReached: boolean;
  /** Statuses of the prelude requests (sequence scenarios), oldest first. */
  preludeStatuses: Array<number | null>;
  storageCalls: number;
  leak: boolean;
  leakEvidence: string | null;
  baselineStatus: number | null;
  expected: string;
  verdict: Verdict;
  recoverability: Recoverability;
  serverLog: string[];
  heapUsedBytes: number;
  calls: Array<{
    dependency: Dependency;
    method: string;
    path: string;
    query: string;
    faulted: boolean;
    faultKind: string | null;
    durationMs: number;
  }>;
}

const INTERNAL_DETAIL_PATTERNS = [
  /FI_LEAK_[0-9a-f]+/,
  /relation .* does not exist/i,
  /PGRST\d{3}/,
  /pl\/pgsql/i,
  /\bat file:\/\//,
  /TypeError|SyntaxError|ReferenceError/,
  /supabase\.fi\.test|redis\.fi\.test|upstash/i,
  /api\.revenuecat\.com|appleid\.apple\.com/i,
  /WRONGPASS/,
  /Bad Gateway/i,
];

export function detectLeak(
  status: number | null,
  bodyText: string,
  headers: Record<string, string>,
  sentinel: string,
): { leak: boolean; evidence: string | null } {
  const haystack = `${bodyText}\n${Object.values(headers).join("\n")}`;
  if (haystack.includes(sentinel)) {
    return { leak: true, evidence: `sentinel ${sentinel} in response` };
  }
  if (status !== null && status >= 500) {
    for (const pattern of INTERNAL_DETAIL_PATTERNS) {
      const hit = pattern.exec(haystack);
      if (hit) {
        return {
          leak: true,
          evidence: `pattern ${pattern} matched: ${hit[0]}`,
        };
      }
    }
  }
  return { leak: false, evidence: null };
}

export function classifyBody(
  status: number | null,
  contentType: string | null,
  bodyText: string,
): {
  bodyClass: BodyClass;
  errorCode: string | null;
  errorMessage: string | null;
  parsed: unknown;
} {
  if (status === null) {
    return {
      bodyClass: "no_response",
      errorCode: null,
      errorMessage: null,
      parsed: null,
    };
  }
  if (status === 204) {
    return {
      bodyClass: "no_content",
      errorCode: null,
      errorMessage: null,
      parsed: null,
    };
  }
  if (status === 429) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // keep null
    }
    return {
      bodyClass: "rate_limited",
      errorCode: null,
      errorMessage: null,
      parsed,
    };
  }
  if (!(contentType ?? "").includes("application/json")) {
    return {
      bodyClass: status >= 200 && status < 300 ? "success_text" : "non_json",
      errorCode: null,
      errorMessage: null,
      parsed: null,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      bodyClass: "non_json",
      errorCode: null,
      errorMessage: null,
      parsed: null,
    };
  }
  if (status >= 200 && status < 300) {
    return {
      bodyClass: "success_json",
      errorCode: null,
      errorMessage: null,
      parsed,
    };
  }
  const error = parsed && typeof parsed === "object" && "error" in parsed
    ? (parsed as { error: unknown }).error
    : null;
  if (error && typeof error === "object") {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
    const message = typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message
      : null;
    return {
      bodyClass: code ? "coded_error" : "generic_error",
      errorCode: code,
      errorMessage: message,
      parsed,
    };
  }
  return {
    bodyClass: "generic_error",
    errorCode: null,
    errorMessage: null,
    parsed,
  };
}

/** Whether a 2xx body is an honest per-item envelope with every item
 * rejected as retryable (shots:sync / evaluation trials). */
export function perItemAllRejectedRetryable(
  envelope: "shots" | "trials",
  parsed: unknown,
): { honest: boolean; codes: string[] } {
  if (!parsed || typeof parsed !== "object") {
    return { honest: false, codes: [] };
  }
  const record = parsed as Record<string, unknown>;
  const accepted = envelope === "shots"
    ? record.acceptedIds
    : record.acceptedTrialIds;
  const rejected = Array.isArray(record.rejected)
    ? (record.rejected as Array<Record<string, unknown>>)
    : [];
  const codes = rejected.map((r) => String(r.code));
  const retryableCodes = envelope === "shots"
    ? new Set(["shot.write_failed"])
    : new Set(["evaluation.trial_write_failed"]);
  const honest = Array.isArray(accepted) &&
    accepted.length === 0 &&
    rejected.length > 0 &&
    codes.every((c) => retryableCodes.has(c));
  return { honest, codes };
}

export interface Expectation {
  /** Acceptable HTTP statuses. */
  statuses: number[];
  /** Also acceptable: 2xx per-item envelope with all items rejected retryably. */
  allowPerItemEnvelope: boolean;
  /** Also acceptable: the healthy baseline status (dependency is best-effort). */
  allowBaseline: boolean;
  /** Low-realism modes only: any non-5xx, non-leaking answer is recorded as
   * degraded_ok (the upstream lied with a 2xx; the handler cannot know). */
  acceptAnyNon5xx?: boolean;
  note: string;
}

const BODY_SHAPE_MODES = new Set([
  "malformed_json",
  "wrong_shape",
  "empty_body",
]);

/** What a correct implementation should answer when `dependency` fails in
 * `mode` on `route`. Redis is best-effort by design (memory fallback), so
 * its expectation is "same as healthy". Everything else should surface a
 * retryable 5xx (503 generic, or the route's coded 502/503) — never a 401
 * that makes the app sign the user out, never a 500, never a false 2xx. */
export function expectationFor(
  route: RouteSpec,
  dependency: Dependency,
  modeId: string,
): Expectation {
  if (dependency === "redis") {
    return {
      statuses: [],
      allowPerItemEnvelope: false,
      allowBaseline: true,
      note: "Redis is best-effort: response must equal the healthy baseline",
    };
  }
  if (dependency === "auth") {
    if (route.id === "auth_logout") {
      return {
        statuses: [503],
        allowPerItemEnvelope: false,
        allowBaseline: false,
        note: "Auth 5xx on logout → 503",
      };
    }
    return {
      statuses: [503],
      allowPerItemEnvelope: false,
      allowBaseline: false,
      note:
        "Supabase Auth outage is transient → 503 (401 would make the app sign out / drop the ID token)",
    };
  }
  if (
    (dependency === "revenuecat" || dependency === "apple") &&
    route.id.startsWith("delete_confirm") &&
    BODY_SHAPE_MODES.has(modeId)
  ) {
    // RevenueCat DELETE /subscribers and Apple /auth/revoke are judged by
    // status code only (Apple's success body is empty by contract), so a
    // 2xx with a garbage body IS a completed deletion/revocation.
    return {
      statuses: [],
      allowPerItemEnvelope: false,
      allowBaseline: true,
      note:
        "2xx delete/revoke with unparseable body is success by status (body is not part of the contract)",
    };
  }
  if (dependency === "revenuecat") {
    if (route.id === "billing_sync") {
      return {
        statuses: [502],
        allowPerItemEnvelope: false,
        allowBaseline: false,
        note: "billing_unavailable 502",
      };
    }
    return {
      statuses: [503],
      allowPerItemEnvelope: false,
      allowBaseline: false,
      note: "RevenueCat outage → 503",
    };
  }
  if (dependency === "apple") {
    if (
      modeId === "invalid_grant_400" && route.id === "account_bootstrap_apple"
    ) {
      return {
        statuses: [401],
        allowPerItemEnvelope: false,
        allowBaseline: false,
        note:
          "Apple invalid_grant → coded 401 auth.apple_authorization_invalid",
      };
    }
    return {
      statuses: [503],
      allowPerItemEnvelope: false,
      allowBaseline: false,
      note: "Apple outage → 503",
    };
  }
  // rest
  if (modeId === "wrong_shape" || modeId === "empty_body") {
    // A 2xx PostgREST body that is empty or an unexpected object is
    // indistinguishable, at the client, from a legitimate empty/row result
    // (writes with return=minimal ARE empty 2xx). Recorded, not judged.
    return {
      statuses: [503],
      allowPerItemEnvelope: Boolean(route.perItemEnvelope),
      allowBaseline: true,
      acceptAnyNon5xx: true,
      note:
        "low realism: PostgREST 2xx with empty/unexpected body cannot be told from a real (empty) result — any non-5xx accepted, a 500 is still flagged",
    };
  }
  return {
    statuses: [503],
    allowPerItemEnvelope: Boolean(route.perItemEnvelope),
    allowBaseline: false,
    note: route.perItemEnvelope
      ? "DB failure → 503, or 200 with every item rejected as retryable"
      : "DB failure → generic 503",
  };
}

export function recoverabilityOf(
  route: RouteSpec,
  status: number | null,
  errorCode: string | null,
  verdict: Verdict,
): Recoverability {
  if (status === null) return "unknown";
  if (verdict === "per_item_retryable_ok") return "per_item_retry";
  if (status >= 200 && status < 300) return "success";
  if (status === 429) return "retry_after";
  if (status === 502 || status === 503 || status === 504) return "retryable";
  if (status === 500) return "retryable";
  if (status === 401 || status === 403) {
    // Mobile contract: 401/403 on refresh or bootstrap is terminal (sign
    // out / ID token spent); on other routes it triggers a refresh attempt
    // and the session is dropped only if the refresh is refused too.
    if (route.id === "auth_refresh" || route.auth === "provider_token") {
      return "client_signs_out";
    }
    if (errorCode) return "client_shows_error";
    return "client_signs_out";
  }
  return "client_shows_error";
}

export function ruleFor(
  dependency: Dependency,
  mode: FaultMode,
  options: Partial<FaultRule> = {},
): FaultRule {
  return { dependency, mode, ...options };
}

export { type Dependency, type FaultMode, type FaultRule };
