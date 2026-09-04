// Executes the failure-injection matrix against the REAL edge handler and
// writes replayable evidence (JSON matrix, CSV, summary, findings, heap
// numbers, captured server log).
//
//   Smoke tier (default, runs inside `deno task test`):
//     deno test -A --no-check --config deno.json failure_injection.test.ts
//   Full tier (every mode × every applicable route + per-call sweeps):
//     FI_TIER=full deno run -A --no-check --config deno.json failure_injection/fiRunner.ts
//   Replay one scenario:
//     FI_ONLY=<scenario id> FI_TIER=full deno run -A --no-check --config deno.json failure_injection/fiRunner.ts
//   Re-evaluate the test assertions against archived evidence (no execution):
//     FI_REPLAY_DIR=<dir with matrix.json+summary.json+heap.json> deno test -A --no-check --config deno.json failure_injection.test.ts
//
// Seeds: every scenario id is deterministic (`${FI_SEED}:${route}:${dependency}:${mode}[:k]`);
// the user id, IP, bearer, fixture ids and the leak sentinel all derive from it.

import {
  buildScenarioContext,
  type Dependency,
  type FaultRule,
  type Harness,
  httpFault,
  loadFailureInjectionHarness,
  type OutboundCall,
  type ScenarioContext,
} from "./fiHarness.ts";
import {
  buildRouteRequest,
  classifyBody,
  detectLeak,
  type Expectation,
  expectationFor,
  MODES,
  type ModeSpec,
  perItemAllRejectedRetryable,
  recoverabilityOf,
  ROUTES,
  type RouteSpec,
  type ScenarioRecord,
  SMOKE_MODE_IDS,
  type Verdict,
} from "./fiScenarios.ts";

export type Tier = "smoke" | "full";

export interface RunOptions {
  tier: Tier;
  runSeed: string;
  outDir: string | null;
  only: string[] | null;
  defaultBudgetMs: number;
  log: (line: string) => void;
  /** Load records from a previous run's artifacts instead of executing. */
  replayDir: string | null;
}

export interface RunResult {
  runSeed: string;
  tier: Tier;
  startedAt: string;
  finishedAt: string;
  denoVersion: string;
  records: ScenarioRecord[];
  anomalies: ScenarioRecord[];
  heap: HeapSample[];
  summary: Record<string, unknown>;
  outDir: string | null;
}

export interface HeapSample {
  label: string;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  redisKeys: number;
  at: string;
}

const OK_VERDICTS = new Set<Verdict>([
  "pass",
  "degraded_ok",
  "per_item_retryable_ok",
]);

export function optionsFromEnv(): RunOptions {
  const tier: Tier = Deno.env.get("FI_TIER") === "full" ? "full" : "smoke";
  const runSeed = Deno.env.get("FI_SEED") ?? "fi-v1";
  const only =
    Deno.env.get("FI_ONLY")?.split(",").map((s) => s.trim()).filter(Boolean) ??
      null;
  const outDir = Deno.env.get("FI_OUT_DIR") ??
    new URL(
      `../../../../../artifacts/failure-injection/${runSeed}-${tier}/`,
      import.meta.url,
    )
      .pathname;
  return {
    tier,
    runSeed,
    outDir: Deno.env.get("FI_NO_ARTIFACTS") === "1" ? null : outDir,
    only,
    defaultBudgetMs: Number(Deno.env.get("FI_BUDGET_MS") ?? 60_000),
    log: (line) => console.error(line),
    replayDir: Deno.env.get("FI_REPLAY_DIR") ?? null,
  };
}

async function replayMatrix(dir: string): Promise<RunResult> {
  const read = async <T>(name: string): Promise<T> =>
    JSON.parse(await Deno.readTextFile(`${dir}/${name}`)) as T;
  const records = await read<ScenarioRecord[]>("matrix.json");
  const summary = await read<Record<string, unknown>>("summary.json");
  const heap = await read<HeapSample[]>("heap.json");
  return {
    runSeed: String(summary.runSeed),
    tier: summary.tier === "full" ? "full" : "smoke",
    startedAt: String(summary.startedAt),
    finishedAt: String(summary.finishedAt),
    denoVersion: String(summary.denoVersion ?? ""),
    records,
    anomalies: records.filter((r) => !OK_VERDICTS.has(r.verdict)),
    heap,
    summary,
    outDir: dir,
  };
}

function heapSample(h: Harness, label: string): HeapSample {
  const usage = Deno.memoryUsage();
  return {
    label,
    heapUsedBytes: usage.heapUsed,
    heapTotalBytes: usage.heapTotal,
    rssBytes: usage.rss,
    externalBytes: usage.external,
    redisKeys: h.redisKeys(),
    at: new Date().toISOString(),
  };
}

interface ExecOutcome {
  status: number | null;
  headers: Record<string, string>;
  bodyText: string;
  durationMs: number;
  timedOut: boolean;
  serverLog: string[];
  releasedHangs: number;
}

async function execute(
  h: Harness,
  ctx: ScenarioContext,
  rules: FaultRule[],
  request: Request,
  budgetMs: number,
): Promise<ExecOutcome> {
  h.arm(ctx, rules);
  const serverLog: string[] = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    info: console.info,
  };
  const capture = (level: string) => (...args: unknown[]) => {
    const text = args
      .map((
        a,
      ) => (a instanceof Error
        ? `${a.name}: ${a.message}`
        : typeof a === "string"
        ? a
        : safeJson(a))
      )
      .join(" ");
    serverLog.push(`${level} ${text}`.slice(0, 1_000));
  };
  console.error = capture("error");
  console.warn = capture("warn");
  console.log = capture("log");
  console.info = capture("info");
  const startedAt = performance.now();
  let timer: number | undefined;
  let timedOut = false;
  try {
    const response = await Promise.race([
      h.handler(request),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, budgetMs);
      }),
    ]);
    const durationMs = performance.now() - startedAt;
    if (!response) {
      const releasedHangs = h.releaseHangs();
      return {
        status: null,
        headers: {},
        bodyText: "",
        durationMs,
        timedOut: true,
        serverLog,
        releasedHangs,
      };
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const bodyText = await response.text();
    return {
      status: response.status,
      headers,
      bodyText,
      durationMs,
      timedOut,
      serverLog,
      releasedHangs: h.releaseHangs(),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    console.error = original.error;
    console.warn = original.warn;
    console.log = original.log;
    console.info = original.info;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

async function requestSnapshot(
  request: Request,
): Promise<ScenarioRecord["request"]> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = key.toLowerCase() === "authorization"
      ? `${value.slice(0, 12)}…(redacted)`
      : value;
  });
  const text = request.method === "GET" || request.method === "HEAD"
    ? ""
    : await request.clone().text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { method: request.method, url: request.url, headers, body };
}

function callSummary(calls: OutboundCall[]): ScenarioRecord["calls"] {
  return calls.map((c) => ({
    dependency: c.dependency,
    method: c.method,
    path: c.path,
    query: c.query.slice(0, 200),
    faulted: c.faulted,
    faultKind: c.faultKind,
    durationMs: Math.round(c.durationMs * 10) / 10,
  }));
}

interface ScenarioPlan {
  id: string;
  tier: ScenarioRecord["tier"];
  route: RouteSpec;
  dependency: Dependency | "none";
  modeId: string;
  realism: ScenarioRecord["realism"];
  faultedCallIndex: number | null;
  rules: (ctx: ScenarioContext) => FaultRule[];
  expectation: (route: RouteSpec) => Expectation;
  budgetMs: number;
  contextOverride?: (ctx: ScenarioContext) => ScenarioContext;
  /** Requests sent BEFORE the measured one, with the same ctx (same IP /
   * user) under their own fault rules — e.g. "N requests during an Auth
   * outage, then Auth recovers". Their statuses are recorded, not judged. */
  prelude?: {
    count: number;
    rules: (ctx: ScenarioContext) => FaultRule[];
    route?: RouteSpec;
  };
}

function baselineOk(route: RouteSpec, status: number | null): boolean {
  if (status === null) return false;
  if (route.id === "training_plans_create") return status === 409;
  return status >= 200 && status < 300;
}

async function runPlan(
  h: Harness,
  plan: ScenarioPlan,
  runSeed: string,
  baselineStatus: number | null,
  defaultBudgetMs: number,
): Promise<ScenarioRecord> {
  const seed = `${runSeed}:${plan.id}`;
  let ctx = await buildScenarioContext(seed, plan.route.provider ?? "google");
  if (plan.route.context) ctx = plan.route.context(ctx);
  if (plan.contextOverride) ctx = plan.contextOverride(ctx);
  const preludeStatuses: Array<number | null> = [];
  if (plan.prelude) {
    const preludeRoute = plan.prelude.route ?? plan.route;
    const preludeRules = plan.prelude.rules(ctx);
    for (let i = 0; i < plan.prelude.count; i++) {
      const pre = await execute(
        h,
        ctx,
        preludeRules,
        buildRouteRequest(preludeRoute, ctx),
        plan.budgetMs || defaultBudgetMs,
      );
      preludeStatuses.push(pre.status);
    }
  }
  const request = buildRouteRequest(plan.route, ctx);
  const requestInfo = await requestSnapshot(request);
  const rules = plan.rules(ctx);
  const outcome = await execute(
    h,
    ctx,
    rules,
    request,
    plan.budgetMs || defaultBudgetMs,
  );
  const calls = h.calls();
  const faultedCalls = calls.filter((c) => c.faulted).length;
  const faultedDependencyReached = plan.dependency === "none" ||
    calls.some((c) => c.dependency === plan.dependency);
  const contentType = outcome.headers["content-type"] ?? null;
  const classified = classifyBody(
    outcome.status,
    contentType,
    outcome.bodyText,
  );
  const leak = detectLeak(
    outcome.status,
    outcome.bodyText,
    outcome.headers,
    ctx.sentinel,
  );
  const expectation = plan.expectation(plan.route);

  let verdict: Verdict;
  if (outcome.timedOut) verdict = "hang_unbounded";
  else if (leak.leak) verdict = "leak";
  else if (plan.dependency === "none") {
    verdict = baselineOk(plan.route, outcome.status)
      ? "pass"
      : "unexpected_status";
  } else if (outcome.status === 500) verdict = "unhandled_500";
  else if (
    outcome.status !== null && expectation.statuses.includes(outcome.status)
  ) verdict = "pass";
  else if (expectation.allowBaseline && outcome.status === baselineStatus) {
    verdict = "degraded_ok";
  } else if (
    expectation.acceptAnyNon5xx && outcome.status !== null &&
    outcome.status < 500
  ) verdict = "degraded_ok";
  else if (
    expectation.allowPerItemEnvelope && plan.route.perItemEnvelope &&
    outcome.status !== null &&
    outcome.status >= 200 && outcome.status < 300 &&
    perItemAllRejectedRetryable(plan.route.perItemEnvelope, classified.parsed)
      .honest
  ) verdict = "per_item_retryable_ok";
  else if (
    outcome.status !== null && outcome.status >= 200 && outcome.status < 300
  ) {
    // A 2xx after the upstream client retried the faulted call and got a
    // healthy answer is resilience, not a false success.
    const retried = calls.some((faulted, i) =>
      faulted.faulted &&
      calls.slice(i + 1).some((later) =>
        !later.faulted && later.dependency === faulted.dependency &&
        later.method === faulted.method &&
        later.path === faulted.path
      )
    );
    verdict = retried ? "retried_ok" : "false_success";
  } else if (outcome.status === 401 || outcome.status === 403) {
    verdict = "misclassified_auth_failure";
  } else if (
    outcome.status !== null && outcome.status >= 400 && outcome.status < 500
  ) verdict = "misclassified_client_error";
  else verdict = "unexpected_status";

  // A fault that never reached its dependency cannot claim a pass — unless
  // the fault was injected during the prelude and the measured request is
  // the healthy "after recovery" probe.
  if (
    !faultedDependencyReached && plan.dependency !== "none" && !plan.prelude &&
    verdict === "pass"
  ) {
    verdict = "unexpected_status";
  }
  if (verdict === "misclassified_client_error" && outcome.status === 429) {
    verdict = "locked_out";
  }

  return {
    id: plan.id,
    seed,
    tier: plan.tier,
    route: plan.route.id,
    method: plan.route.method,
    path: plan.route.path(ctx),
    dependency: plan.dependency,
    mode: plan.modeId,
    realism: plan.realism,
    faultedCallIndex: plan.faultedCallIndex,
    request: requestInfo,
    userId: ctx.userId,
    ip: ctx.ip,
    sentinel: ctx.sentinel,
    status: outcome.status,
    bodyClass: classified.bodyClass,
    bodyPreview: outcome.bodyText.slice(0, 400),
    errorCode: classified.errorCode,
    errorMessage: classified.errorMessage,
    headers: outcome.headers,
    durationMs: Math.round(outcome.durationMs * 10) / 10,
    upstreamCalls: calls.length,
    faultedCalls,
    faultedDependencyReached,
    preludeStatuses,
    storageCalls: calls.filter((c) => c.dependency === "storage").length,
    leak: leak.leak,
    leakEvidence: leak.evidence,
    baselineStatus,
    expected: expectation.note +
      (expectation.statuses.length
        ? ` [${expectation.statuses.join("|")}]`
        : ""),
    verdict,
    recoverability: recoverabilityOf(
      plan.route,
      outcome.status,
      classified.errorCode,
      verdict,
    ),
    serverLog: outcome.serverLog,
    heapUsedBytes: Deno.memoryUsage().heapUsed,
    calls: callSummary(calls),
  };
}

function modeExpectation(route: RouteSpec, mode: ModeSpec): Expectation {
  if (mode.id.startsWith("slow_")) {
    return {
      statuses: [],
      allowPerItemEnvelope: false,
      allowBaseline: true,
      note: `slow ${mode.dependency} must still yield the healthy baseline`,
    };
  }
  if (mode.id === "hang" && mode.dependency !== "redis") {
    const base = expectationFor(route, mode.dependency, mode.id);
    return {
      ...base,
      note: `${base.note}; must answer within ${mode.responseBudgetMs}ms`,
    };
  }
  return expectationFor(route, mode.dependency, mode.id);
}

function fixed(
  statuses: number[],
  note: string,
  extra: Partial<Expectation> = {},
): () => Expectation {
  return () => ({
    statuses,
    allowPerItemEnvelope: false,
    allowBaseline: false,
    note,
    ...extra,
  });
}

/** Targeted scenarios: fault ONE specific upstream call that the all-calls
 * matrix cannot isolate (a later call on the same dependency, a
 * best-effort side write, a specific auth sub-path). */
function targetedPlans(byId: Map<string, RouteSpec>): ScenarioPlan[] {
  const route = (id: string): RouteSpec => {
    const r = byId.get(id);
    if (!r) throw new Error(`fi: unknown route ${id}`);
    return r;
  };
  const rest =
    (match: (c: OutboundCall) => boolean, status = 500) =>
    (ctx: ScenarioContext) => [
      {
        dependency: "rest" as Dependency,
        mode: httpFault("rest", status, ctx.sentinel),
        match,
      },
    ];
  const auth = (
    match: (c: OutboundCall) => boolean,
    kind: "http" | "network_error" | "malformed_json",
  ) =>
  (ctx: ScenarioContext) => [
    {
      dependency: "auth" as Dependency,
      mode: kind === "http"
        ? httpFault("auth", 503, ctx.sentinel)
        : kind === "network_error"
        ? { kind: "network_error" as const }
        : { kind: "malformed_json" as const },
      match,
    },
  ];
  const table = (name: string, method?: string) => (c: OutboundCall) =>
    c.path === `/rest/v1/${name}` &&
    (method === undefined || c.method === method);
  const plans: ScenarioPlan[] = [];
  const add = (
    id: string,
    routeId: string,
    dependency: Dependency,
    modeId: string,
    rules: (ctx: ScenarioContext) => FaultRule[],
    expectation: () => Expectation,
    extra: Partial<ScenarioPlan> = {},
  ) => {
    plans.push({
      id: `targeted:${routeId}:${id}`,
      tier: "targeted",
      route: route(routeId),
      dependency,
      modeId,
      realism: "high",
      faultedCallIndex: null,
      rules,
      expectation,
      budgetMs: 0,
      ...extra,
    });
  };

  // Logout: only the GoTrue /logout call fails (session verification is healthy).
  add(
    "logout_call_503",
    "auth_logout",
    "auth",
    "down_503",
    auth((c) => c.path === "/auth/v1/logout", "http"),
    fixed([503], "logout upstream 5xx → 503"),
  );
  add(
    "logout_call_network_error",
    "auth_logout",
    "auth",
    "network_error",
    auth((c) => c.path === "/auth/v1/logout", "network_error"),
    fixed([503], "logout upstream unreachable → 503 (retryable), not 500"),
  );
  add(
    "logout_call_401_already_gone",
    "auth_logout",
    "auth",
    "unauthorized_401",
    (
      ctx,
    ) => [{
      dependency: "auth",
      mode: httpFault("auth", 401, ctx.sentinel),
      match: (c) => c.path === "/auth/v1/logout",
    }],
    fixed([204], "session already revoked upstream → 204 (idempotent logout)"),
  );
  // Refresh: refresh_token grant fails with 5xx / network / malformed.
  add(
    "refresh_grant_400_invalid",
    "auth_refresh",
    "auth",
    "invalid_grant_400",
    (ctx) => [{
      dependency: "auth",
      mode: {
        kind: "http",
        status: 400,
        body: JSON.stringify({
          error: "invalid_grant",
          error_description: `Invalid Refresh Token ${ctx.sentinel}`,
        }),
        contentType: "application/json",
      },
    }],
    fixed([401], "refresh token refused → 401 (client signs out); never 5xx"),
  );
  // Session verification: admin deleteUser fails while getUser is healthy.
  add(
    "admin_delete_user_500",
    "delete_confirm_google",
    "auth",
    "error_500",
    (
      ctx,
    ) => [{
      dependency: "auth",
      mode: httpFault("auth", 500, ctx.sentinel),
      match: (c) => c.path.startsWith("/auth/v1/admin/users/"),
    }],
    fixed([503], "Auth admin deleteUser 5xx → 503"),
  );
  add(
    "admin_delete_user_network_error",
    "delete_confirm_google",
    "auth",
    "network_error",
    auth((c) => c.path.startsWith("/auth/v1/admin/users/"), "network_error"),
    fixed([503], "Auth admin deleteUser unreachable → 503"),
  );
  add(
    "admin_delete_user_404_already_deleted",
    "delete_confirm_google",
    "auth",
    "not_found_404",
    (ctx) => [{
      dependency: "auth",
      mode: {
        kind: "http",
        status: 404,
        body: JSON.stringify({
          code: 404,
          msg: `User not found ${ctx.sentinel}`,
        }),
        contentType: "application/json",
      },
      match: (c) => c.path.startsWith("/auth/v1/admin/users/"),
    }],
    fixed([200], "already deleted upstream → idempotent 200"),
  );
  // Permit finalize: settle PATCH matched nothing, follow-up read fails.
  add(
    "settled_read_500_after_noop_patch",
    "analysis_permits_finalize",
    "rest",
    "error_500",
    (ctx) => [
      {
        dependency: "rest",
        mode: {
          kind: "http",
          status: 200,
          body: "[]",
          contentType: "application/json",
        },
        match: table("analysis_permits", "PATCH"),
      },
      {
        dependency: "rest",
        mode: httpFault("rest", 500, ctx.sentinel),
        match: table("analysis_permits", "GET"),
      },
    ],
    fixed([503], "permit settled-state read failure → 503"),
  );
  // Rank: technique read healthy, rank_state read fails.
  add(
    "rank_state_read_500",
    "rank",
    "rest",
    "error_500",
    rest(table("player_rank_state")),
    fixed([503], "rank state read failure → 503"),
  );
  add(
    "progress_practice_days_500",
    "progress",
    "rest",
    "error_500",
    rest(table("practice_days")),
    fixed([503], "progress secondary read failure → 503"),
  );
  // Webhook: event lookup vs persistence vs audit write.
  add(
    "event_lookup_500",
    "webhook_revenuecat",
    "rest",
    "error_500",
    rest(table("webhook_events", "GET")),
    fixed([503], "webhook dedupe lookup failure → 503 so RevenueCat retries", {
      allowBaseline: true,
    }),
  );
  add(
    "entitlement_persist_500",
    "webhook_revenuecat",
    "rest",
    "error_500",
    rest(table("billing_entitlements")),
    fixed(
      [503],
      "verified verdict could not be persisted → 503 so RevenueCat retries (a 200 drops the entitlement change)",
    ),
  );
  add(
    "audit_write_500",
    "webhook_revenuecat",
    "rest",
    "error_500",
    rest(table("webhook_events", "POST")),
    fixed(
      [200],
      "audit row is best-effort after persisting the verdict → 200",
      { allowBaseline: true },
    ),
  );
  // Billing sync: verdict verified, persistence fails.
  add(
    "entitlement_persist_500",
    "billing_sync",
    "rest",
    "error_500",
    rest(table("billing_entitlements")),
    fixed([503], "billing persistence failure → 503"),
  );
  add(
    "rc_200_without_entitlements_map",
    "billing_sync",
    "revenuecat",
    "subscriber_missing_entitlements",
    () => [],
    fixed(
      [200],
      "RevenueCat 200 whose subscriber lacks `entitlements` is treated as an honest not-premium verdict BY DESIGN (index.ts verifyRevenueCatSubscriber) — recorded for triage",
    ),
    {
      contextOverride: (ctx) => ({
        ...ctx,
        subscriber: { unexpected: ctx.sentinel },
      }),
    },
  );
  // Shots sync: pre-check read fails vs RPC fails vs permit read fails.
  add(
    "replay_read_500",
    "shots_sync",
    "rest",
    "error_500",
    rest(table("shots", "GET")),
    () => ({
      statuses: [503],
      allowPerItemEnvelope: true,
      allowBaseline: false,
      note: "sync replay lookup failure → 503 or per-shot retryable rejection",
    }),
  );
  add(
    "apply_rpc_500",
    "shots_sync",
    "rest",
    "error_500",
    rest((c) => c.path === "/rest/v1/rpc/apply_synced_shot"),
    () => ({
      statuses: [503],
      allowPerItemEnvelope: true,
      allowBaseline: false,
      note:
        "apply_synced_shot failure → per-shot shot.write_failed (retry from outbox)",
    }),
  );
  add(
    "trial_insert_500",
    "evaluation_trials",
    "rest",
    "error_500",
    rest(table("evaluation_trials", "POST")),
    () => ({
      statuses: [503],
      allowPerItemEnvelope: true,
      allowBaseline: false,
      note: "trial insert failure → per-trial retryable rejection or 503",
    }),
  );
  // Delete request: survey insert is best-effort.
  add(
    "survey_insert_500",
    "delete_request",
    "rest",
    "error_500",
    rest(table("account_deletion_feedback")),
    fixed(
      [200],
      "exit-survey write is best-effort → 200 challenge still issued",
      { allowBaseline: true },
    ),
  );
  add(
    "challenge_upsert_500",
    "delete_request",
    "rest",
    "error_500",
    rest(table("account_deletion_requests")),
    fixed([503], "challenge upsert failure → 503"),
  );
  // Delete confirm: external providers.
  add(
    "rc_customer_delete_500",
    "delete_confirm_google",
    "revenuecat",
    "error_500",
    (
      ctx,
    ) => [{
      dependency: "revenuecat",
      mode: httpFault("revenuecat", 500, ctx.sentinel),
    }],
    fixed(
      [503],
      "RevenueCat customer deletion failure → 503, account NOT deleted",
    ),
  );
  add(
    "rc_customer_delete_404",
    "delete_confirm_google",
    "revenuecat",
    "not_found_404",
    (
      ctx,
    ) => [{
      dependency: "revenuecat",
      mode: {
        kind: "http",
        status: 404,
        body: JSON.stringify({
          code: 7259,
          message: `not found ${ctx.sentinel}`,
        }),
        contentType: "application/json",
      },
    }],
    fixed([200], "unknown RevenueCat customer → treated as deleted → 200"),
  );
  add(
    "apple_revoke_500",
    "delete_confirm_apple",
    "apple",
    "error_500",
    (
      ctx,
    ) => [{ dependency: "apple", mode: httpFault("apple", 500, ctx.sentinel) }],
    fixed([503], "Apple revocation failure → 503, account NOT deleted"),
  );
  add(
    "credential_read_500",
    "delete_confirm_apple",
    "rest",
    "error_500",
    rest(table("account_external_credentials", "GET")),
    fixed([503], "external credential read failure → 503"),
  );
  // Apple bootstrap: credential store write fails after Apple exchange succeeded.
  add(
    "credential_store_500",
    "account_bootstrap_apple",
    "rest",
    "error_500",
    rest(table("account_external_credentials")),
    fixed(
      [503],
      "Apple credential store failure → 503 (never 401: the ID token is single-use)",
    ),
  );
  add(
    "profile_read_500",
    "account_bootstrap_google",
    "rest",
    "error_500",
    rest(table("profiles")),
    fixed([503], "profile read failure after sign-in → 503 (never 401)"),
  );
  // Session auth: getUser healthy but returns a user without id (wrong shape 200).
  add(
    "get_user_wrong_shape",
    "me",
    "auth",
    "wrong_shape",
    (ctx) => [{
      dependency: "auth",
      mode: {
        kind: "http",
        status: 200,
        body: JSON.stringify({ unexpected: ctx.sentinel }),
        contentType: "application/json",
      },
      match: (c) => c.path === "/auth/v1/user",
    }],
    fixed(
      [503],
      "malformed Auth 200 → transient 503 (a 401 would sign the user out)",
    ),
  );
  // Auth outage lockout: the same device keeps calling while Supabase Auth
  // is down (AUTH_FAILURE_LIMIT.limit requests), then Auth recovers. A
  // correct implementation does not count an upstream outage as a failed
  // authentication, so the first healthy request must succeed (not 429).
  const authDown = (
    ctx: ScenarioContext,
  ) => [{
    dependency: "auth" as Dependency,
    mode: httpFault("auth", 503, ctx.sentinel),
  }];
  add(
    "recovers_after_30_outage_calls",
    "me",
    "auth",
    "down_503_then_healthy",
    () => [],
    fixed(
      [200],
      "Auth back up after 30 outage responses to one IP → 200 (an outage must not trip the per-IP auth-failure lockout)",
    ),
    { prelude: { count: 30, rules: authDown } },
  );
  add(
    "refresh_after_30_outage_calls",
    "auth_refresh",
    "auth",
    "down_503_then_healthy",
    () => [],
    fixed(
      [200],
      "Auth back up: refresh from the same IP → 200 (lockout would block the app's recovery path)",
    ),
    { prelude: { count: 30, rules: authDown, route: route("me") } },
  );
  add(
    "bootstrap_after_30_outage_calls",
    "account_bootstrap_google",
    "auth",
    "down_503_then_healthy",
    () => [],
    fixed([200], "Auth back up: fresh sign-in from the same IP → 200"),
    { prelude: { count: 30, rules: authDown, route: route("me") } },
  );
  return plans;
}

export async function runMatrix(options: RunOptions): Promise<RunResult> {
  if (options.replayDir) return await replayMatrix(options.replayDir);
  const startedAt = new Date().toISOString();
  const h = await loadFailureInjectionHarness();
  const byId = new Map(ROUTES.map((r) => [r.id, r]));
  const records: ScenarioRecord[] = [];
  const heap: HeapSample[] = [heapSample(h, "start")];
  const baselines = new Map<string, ScenarioRecord>();
  const wanted = (id: string) =>
    !options.only || options.only.some((needle) => id.includes(needle));

  // 1. Healthy baseline per route (also records the upstream call plan).
  for (const route of ROUTES) {
    const plan: ScenarioPlan = {
      id: `baseline:${route.id}`,
      tier: "baseline",
      route,
      dependency: "none",
      modeId: "healthy",
      realism: "n/a",
      faultedCallIndex: null,
      rules: () => [],
      expectation: fixed([], "healthy baseline"),
      budgetMs: 0,
    };
    h.resetRedis();
    const record = await runPlan(
      h,
      plan,
      options.runSeed,
      null,
      options.defaultBudgetMs,
    );
    baselines.set(route.id, record);
    if (wanted(plan.id)) records.push(record);
    options.log(
      `[fi] ${record.verdict.padEnd(22)} ${
        record.status ?? "-"
      } ${record.id} (${record.durationMs}ms, ${record.upstreamCalls} upstream)`,
    );
  }
  heap.push(heapSample(h, "after-baseline"));

  // 2. Matrix: every mode × every route whose healthy path reaches the dependency.
  const plans: ScenarioPlan[] = [];
  for (const route of ROUTES) {
    for (const mode of MODES) {
      if (!route.deps.includes(mode.dependency)) continue;
      if (
        options.tier === "smoke" &&
        !SMOKE_MODE_IDS.has(`${mode.dependency}:${mode.id}`)
      ) continue;
      plans.push({
        id: `matrix:${route.id}:${mode.dependency}:${mode.id}`,
        tier: "matrix",
        route,
        dependency: mode.dependency,
        modeId: mode.id,
        realism: mode.realism,
        faultedCallIndex: null,
        rules: (
          ctx,
        ) => [{ dependency: mode.dependency, mode: mode.make(ctx.sentinel) }],
        expectation: (r) => modeExpectation(r, mode),
        budgetMs: mode.responseBudgetMs ?? 0,
      });
    }
  }

  // 3. Sweep (full tier): fault exactly ONE upstream call of a dependency,
  //    walking every position observed on the healthy path.
  if (options.tier === "full") {
    for (const route of ROUTES) {
      const base = baselines.get(route.id);
      if (!base) continue;
      for (const dependency of ["rest", "auth"] as Dependency[]) {
        const positions = base.calls.filter((c) => c.dependency === dependency);
        for (let k = 0; k < positions.length; k += 1) {
          const target = positions[k];
          const bestEffort = route.bestEffortCalls?.(target) ?? null;
          const statusOnly = route.statusOnlyCalls?.(target) ?? false;
          for (const modeId of ["error_500", "malformed_json"]) {
            const sweepExpectation = (r: RouteSpec): Expectation => {
              const base = expectationFor(r, dependency, modeId);
              if (bestEffort) {
                return {
                  ...base,
                  allowBaseline: true,
                  note: `best-effort call BY DESIGN — ${bestEffort}`,
                };
              }
              if (statusOnly && modeId === "malformed_json") {
                return {
                  ...base,
                  allowBaseline: true,
                  note:
                    "status-only upstream call: 2xx with malformed body is success",
                };
              }
              return base;
            };
            plans.push({
              id: `sweep:${route.id}:${dependency}:${modeId}:${k}`,
              tier: "sweep",
              route,
              dependency,
              modeId,
              realism: modeId === "error_500" ? "high" : "medium",
              faultedCallIndex: k,
              rules: (ctx) => [{
                dependency,
                mode: modeId === "error_500"
                  ? httpFault(dependency, 500, ctx.sentinel)
                  : { kind: "malformed_json" },
                fromMatchIndex: k,
                maxFaults: 1,
              }],
              expectation: sweepExpectation,
              budgetMs: 0,
            });
          }
        }
      }
    }
  }

  // 4. Targeted single-call scenarios (both tiers — they are cheap).
  plans.push(...targetedPlans(byId));

  for (const plan of plans) {
    if (!wanted(plan.id)) continue;
    h.resetRedis();
    const baselineStatus = baselines.get(plan.route.id)?.status ?? null;
    const record = await runPlan(
      h,
      plan,
      options.runSeed,
      baselineStatus,
      options.defaultBudgetMs,
    );
    records.push(record);
    options.log(
      `[fi] ${record.verdict.padEnd(22)} ${
        record.status ?? "-"
      } ${record.id} (${record.durationMs}ms, ${record.upstreamCalls} upstream, ${record.faultedCalls} faulted)`,
    );
  }
  heap.push(heapSample(h, "after-matrix"));

  // 5. Soak: repeated healthy + faulted requests on one identity to expose
  //    per-isolate growth (auth cache, rate-limit windows, fake Redis keys).
  if (!options.only) {
    const soak = await soakHeap(h, byId, options);
    heap.push(...soak);
  }

  const anomalies = records.filter((r) => !OK_VERDICTS.has(r.verdict));
  const finishedAt = new Date().toISOString();
  const summary = summarize(
    records,
    anomalies,
    heap,
    options,
    startedAt,
    finishedAt,
  );
  const result: RunResult = {
    runSeed: options.runSeed,
    tier: options.tier,
    startedAt,
    finishedAt,
    denoVersion: Deno.version.deno,
    records,
    anomalies,
    heap,
    summary,
    outDir: options.outDir,
  };
  if (options.outDir) await writeArtifacts(result, options.outDir);
  return result;
}

async function soakHeap(
  h: Harness,
  byId: Map<string, RouteSpec>,
  options: RunOptions,
): Promise<HeapSample[]> {
  const samples: HeapSample[] = [];
  const route = byId.get("me_access");
  if (!route) return samples;
  const ctx = await buildScenarioContext(`${options.runSeed}:soak:me_access`);
  const quiet = { error() {}, warn() {}, log() {}, info() {} };
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
    info: console.info,
  };
  Object.assign(console, quiet);
  try {
    samples.push(heapSample(h, "soak-start"));
    const rounds = options.tier === "full" ? 300 : 100;
    for (let i = 0; i < rounds; i += 1) {
      h.arm(ctx, []);
      await (await h.handler(buildRouteRequest(route, ctx))).text();
    }
    samples.push(heapSample(h, `soak-healthy-x${rounds}`));
    for (let i = 0; i < rounds; i += 1) {
      const c = await buildScenarioContext(
        `${options.runSeed}:soak:rest500:${i}`,
      );
      h.arm(c, [{
        dependency: "rest",
        mode: httpFault("rest", 500, c.sentinel),
      }]);
      await (await h.handler(buildRouteRequest(route, c))).text();
    }
    samples.push(heapSample(h, `soak-rest-500-distinct-users-x${rounds}`));
    for (let i = 0; i < rounds; i += 1) {
      const c = await buildScenarioContext(
        `${options.runSeed}:soak:redisdown:${i}`,
      );
      h.arm(c, [{ dependency: "redis", mode: { kind: "network_error" } }]);
      await (await h.handler(buildRouteRequest(route, c))).text();
    }
    samples.push(heapSample(h, `soak-redis-down-distinct-users-x${rounds}`));
  } finally {
    Object.assign(console, original);
  }
  return samples;
}

function summarize(
  records: ScenarioRecord[],
  anomalies: ScenarioRecord[],
  heap: HeapSample[],
  options: RunOptions,
  startedAt: string,
  finishedAt: string,
): Record<string, unknown> {
  const count = <K extends string>(
    items: ScenarioRecord[],
    key: (r: ScenarioRecord) => K,
  ) => {
    const out: Record<string, number> = {};
    for (const r of items) out[key(r)] = (out[key(r)] ?? 0) + 1;
    return out;
  };
  const latency: Record<string, { n: number; p50Ms: number; maxMs: number }> =
    {};
  const groups = new Map<string, number[]>();
  for (const r of records) {
    const key = `${r.dependency}:${r.mode}`;
    const list = groups.get(key) ?? [];
    list.push(r.durationMs);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => a - b);
    latency[key] = {
      n: sorted.length,
      p50Ms: sorted[Math.floor(sorted.length / 2)],
      maxMs: sorted[sorted.length - 1],
    };
  }
  return {
    runSeed: options.runSeed,
    tier: options.tier,
    startedAt,
    finishedAt,
    scenariosExecuted: records.length,
    byTier: count(records, (r) => r.tier),
    byVerdict: count(records, (r) => r.verdict),
    byDependency: count(records, (r) => r.dependency),
    byStatus: count(records, (r) => String(r.status ?? "timeout")),
    byRecoverability: count(records, (r) => r.recoverability),
    leaks: records.filter((r) => r.leak).map((r) => r.id),
    unhandled500: records.filter((r) => r.status === 500).map((r) => r.id),
    falseSuccess: records.filter((r) => r.verdict === "false_success").map((
      r,
    ) => r.id),
    misclassifiedAuth: records.filter((r) =>
      r.verdict === "misclassified_auth_failure"
    ).map((r) => r.id),
    hangs: records.filter((r) => r.verdict === "hang_unbounded").map((r) =>
      r.id
    ),
    lockedOut: records.filter((r) => r.verdict === "locked_out").map((r) =>
      r.id
    ),
    retriedOk: records.filter((r) => r.verdict === "retried_ok").map((r) =>
      r.id
    ),
    storageCallsObserved: records.reduce((n, r) => n + r.storageCalls, 0),
    anomalies: anomalies.map((r) => ({
      id: r.id,
      route: r.route,
      dependency: r.dependency,
      mode: r.mode,
      status: r.status,
      verdict: r.verdict,
      expected: r.expected,
      bodyPreview: r.bodyPreview,
      realism: r.realism,
      preludeStatuses: r.preludeStatuses,
    })),
    latencyByMode: latency,
    heap,
  };
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function writeArtifacts(
  result: RunResult,
  outDir: string,
): Promise<void> {
  await Deno.mkdir(outDir, { recursive: true });
  const write = (name: string, body: string) =>
    Deno.writeTextFile(`${outDir}/${name}`, body);
  await write("matrix.json", JSON.stringify(result.records, null, 2));
  await write("summary.json", JSON.stringify(result.summary, null, 2));
  await write("anomalies.json", JSON.stringify(result.anomalies, null, 2));
  await write("heap.json", JSON.stringify(result.heap, null, 2));
  const columns = [
    "id",
    "tier",
    "route",
    "method",
    "path",
    "dependency",
    "mode",
    "realism",
    "faultedCallIndex",
    "seed",
    "userId",
    "ip",
    "status",
    "bodyClass",
    "errorCode",
    "errorMessage",
    "durationMs",
    "upstreamCalls",
    "faultedCalls",
    "faultedDependencyReached",
    "leak",
    "baselineStatus",
    "expected",
    "verdict",
    "recoverability",
  ] as const;
  const rows = [[...columns, "preludeStatuses"].join(",")];
  for (const r of result.records) {
    rows.push(
      [
        ...columns.map((c) => csvEscape(r[c])),
        csvEscape(r.preludeStatuses.join("|")),
      ].join(","),
    );
  }
  await write("matrix.csv", rows.join("\n") + "\n");
  await write(
    "seeds.json",
    JSON.stringify(
      result.records.map((r) => ({
        id: r.id,
        seed: r.seed,
        userId: r.userId,
        ip: r.ip,
        sentinel: r.sentinel,
        request: r.request,
        replay:
          `FI_ONLY='${r.id}' FI_TIER=${result.tier} FI_SEED='${result.runSeed}' deno run -A --no-check --config deno.json failure_injection/fiRunner.ts`,
      })),
      null,
      2,
    ),
  );
  const log: string[] = [];
  for (const r of result.records) {
    log.push(`=== ${r.id} → ${r.status ?? "TIMEOUT"} ${r.verdict}`);
    for (const line of r.serverLog) log.push(`  ${line}`);
  }
  await write("server.log", log.join("\n") + "\n");
  await write(
    "routes.json",
    JSON.stringify(
      ROUTES.map((r) => ({
        id: r.id,
        method: r.method,
        auth: r.auth,
        provider: r.provider ?? null,
        deps: r.deps,
        perItemEnvelope: r.perItemEnvelope ?? null,
      })),
      null,
      2,
    ),
  );
}

if (import.meta.main) {
  const options = optionsFromEnv();
  const result = await runMatrix(options);
  console.error(
    JSON.stringify(
      { ...result.summary, heap: undefined, latencyByMode: undefined },
      null,
      2,
    ),
  );
  console.error(`[fi] artifacts: ${result.outDir ?? "(none)"}`);
  Deno.exit(result.anomalies.some((r) => r.leak) ? 2 : 0);
}
