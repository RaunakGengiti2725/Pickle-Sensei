// Failure injection against the REAL edge handler: Supabase Auth down,
// PostgREST/RPC errors, Upstash Redis down/slow/malformed, RevenueCat
// down/slow/malformed, Apple token endpoints failing. Every scenario is
// seeded and replayable (see failure_injection/fiRunner.ts header).
//
// Default tier is "smoke" (cheap modes only, ~80s — most of it is the
// upstream clients' own retry backoff); `FI_TIER=full` runs every mode plus
// per-call sweeps and 25s hang probes. Artifacts land in
// artifacts/failure-injection/<seed>-<tier>/ unless FI_NO_ARTIFACTS=1.
//
// Invariants asserted here (a failure is a real defect, not a flaky stub):
//   1. No response ever contains upstream detail (sentinel or 5xx patterns).
//   2. No unexpected HTTP 500 under any injected upstream failure.
//   3. Redis failures never change a route's status (memory fallback).
//   4. A faulted upstream never yields an undocumented false 2xx.
//   5. Auth outages surface as retryable 503, never as a sign-out 401.
//
// Reproduced defects are PINNED below (KNOWN_DEFECTS, matched on scenario
// identity — route/dependency/mode/tier — never on the outcome). Each pin has
// a "REPRO (defect)" test that asserts the CURRENT wrong behaviour, so the
// suite is green today and the pin FAILS the day the production fix lands —
// remove the entry then. Pinned scenarios are excluded from the generic
// invariants; nothing else is.

import { assert, assertEquals } from "@std/assert";
import {
  optionsFromEnv,
  runMatrix,
  type RunResult,
} from "./failure_injection/fiRunner.ts";
import type {
  ScenarioRecord,
  Verdict,
} from "./failure_injection/fiScenarios.ts";

interface DefectPin {
  /** Finding id used in the audit report. */
  finding: string;
  title: string;
  /** Scenario identity (never the outcome). */
  match: (r: ScenarioRecord) => boolean;
  /** Current behaviour being pinned. */
  statuses: Array<number | null>;
  verdicts: Verdict[];
  /** Tiers in which at least one matching scenario must exist. */
  presentIn: Array<ScenarioRecord["tier"]>;
  /** False when the pin is about latency only and the status/verdict must
   * still satisfy the generic invariants. */
  excludesFromInvariants?: boolean;
}

const AUTH_OUTAGE_MODES = [
  "down_503",
  "error_500",
  "gateway_502_html",
  "network_error",
];
const AUTH_BODY_MODES = ["malformed_json", "wrong_shape", "empty_body"];
const REST_FAILURE_MODES = [
  "error_500",
  "down_503",
  "gateway_502_html",
  "network_error",
  "malformed_json",
];
const REST_WRONG_SHAPE_500_ROUTES = [
  "shots_sync",
  "analyses_feedback",
  "evaluation_trials",
  "progress",
  "rank",
  "consent_status",
  "consent_grant",
  "consent_withdraw",
  "saved_drills_list",
  "catalog_drills_list",
];

const KNOWN_DEFECTS: DefectPin[] = [
  {
    finding: "F1",
    title:
      "Supabase Auth outage (5xx/network/malformed) → 401 sign-out class instead of retryable 503",
    match: (r) =>
      r.dependency === "auth" &&
      r.route !== "auth_refresh" &&
      ((r.tier === "matrix" &&
        [...AUTH_OUTAGE_MODES, ...AUTH_BODY_MODES].includes(r.mode)) ||
        (r.tier === "sweep" && r.faultedCallIndex === 0 &&
          ["error_500", "malformed_json"].includes(r.mode)) ||
        (r.tier === "targeted" && r.id === "targeted:me:get_user_wrong_shape")),
    statuses: [401],
    verdicts: ["misclassified_auth_failure"],
    presentIn: ["matrix"],
  },
  {
    finding: "F1b",
    title:
      "POST /v1/auth/refresh: Auth network error / malformed body → 401 (only HTTP 5xx maps to 503)",
    match: (r) =>
      r.dependency === "auth" &&
      r.route === "auth_refresh" &&
      r.tier === "matrix" &&
      ["network_error", ...AUTH_BODY_MODES].includes(r.mode),
    statuses: [401],
    verdicts: ["misclassified_auth_failure"],
    presentIn: ["matrix"],
  },
  {
    finding: "F2",
    title:
      "30 Auth-outage responses from one IP trip the auth-failure lockout: healthy requests get 429",
    match: (r) => r.tier === "targeted" && r.mode === "down_503_then_healthy",
    statuses: [429],
    verdicts: ["locked_out"],
    presentIn: ["targeted"],
  },
  {
    finding: "F3",
    title:
      "POST /v1/auth/logout: Auth network error is uncaught → generic 500 instead of 503",
    match: (r) => r.id === "targeted:auth_logout:logout_call_network_error",
    statuses: [500],
    verdicts: ["unhandled_500"],
    presentIn: ["targeted"],
  },
  {
    finding: "F4",
    title:
      "No upstream timeout on Supabase Auth / PostgREST calls: a hung upstream hangs the route past every client timeout",
    match: (r) =>
      r.tier === "matrix" && r.mode === "hang" &&
      (r.dependency === "auth" || r.dependency === "rest"),
    statuses: [null],
    verdicts: ["hang_unbounded"],
    presentIn: [], // full tier only
  },
  {
    finding: "F5",
    title:
      "RevenueCat webhook: DB failure while persisting the verified verdict is acknowledged with 200 (provider never retries)",
    match: (r) =>
      (r.route === "webhook_revenuecat" && r.dependency === "rest" &&
        ((r.tier === "matrix" && REST_FAILURE_MODES.includes(r.mode)) ||
          // sweep call #1 on this route is the billing_entitlements upsert
          (r.tier === "sweep" && r.faultedCallIndex === 1))) ||
      r.id === "targeted:webhook_revenuecat:entitlement_persist_500",
    statuses: [200],
    verdicts: ["false_success"],
    presentIn: ["matrix", "targeted"],
  },
  {
    finding: "F6",
    title:
      "Array-typed PostgREST reads assume an array: a 2xx object body throws → generic 500 (low realism)",
    match: (r) =>
      r.tier === "matrix" && r.dependency === "rest" &&
      r.mode === "wrong_shape" &&
      REST_WRONG_SHAPE_500_ROUTES.includes(r.route),
    statuses: [500],
    verdicts: ["unhandled_500"],
    presentIn: [], // full tier only
  },
  {
    finding: "F7",
    title:
      "POST /v1/auth/refresh during an Auth outage is held ~25s by auth-js retry backoff — longer than the app's 15s refresh timeout",
    match: (r) =>
      r.tier === "matrix" && r.route === "auth_refresh" &&
      r.dependency === "auth" &&
      ["down_503", "network_error", "malformed_json"].includes(r.mode),
    statuses: [401, 503],
    verdicts: ["pass", "misclassified_auth_failure"],
    presentIn: ["matrix"],
    excludesFromInvariants: false,
  },
  {
    finding: "F8",
    title:
      "Hung Upstash Redis costs every authenticated request 5–7 serial 1.2s timeouts (6–8.4s added latency, no circuit breaker)",
    match: (r) =>
      r.tier === "matrix" && r.dependency === "redis" && r.mode === "hang" &&
      r.calls.filter((c) => c.dependency === "redis").length >= 5,
    statuses: [200, 201, 204, 409],
    verdicts: ["degraded_ok"],
    presentIn: [], // full tier only
    excludesFromInvariants: false,
  },
];

let cached: Promise<RunResult> | null = null;
function results(): Promise<RunResult> {
  if (!cached) cached = runMatrix({ ...optionsFromEnv(), log: () => {} });
  return cached;
}

const isPinned = (r: ScenarioRecord) =>
  KNOWN_DEFECTS.some((d) => d.excludesFromInvariants !== false && d.match(r));
const describe = (r: ScenarioRecord) =>
  `${r.id}=${r.status ?? "TIMEOUT"} ${r.verdict} (expected ${r.expected})`;

Deno.test({
  name:
    "failure injection: matrix runs against the real handler and reaches every declared dependency",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    assert(run.records.length > 0);
    const baselines = run.records.filter((r) => r.tier === "baseline");
    assertEquals(
      baselines.filter((r) => r.verdict !== "pass").map((r) =>
        `${r.id}=${r.status}`
      ),
      [],
      "every route must have a healthy baseline before faults are meaningful",
    );
    const unreached = run.records.filter(
      (r) =>
        r.dependency !== "none" && !r.faultedDependencyReached &&
        r.preludeStatuses.length === 0,
    );
    assertEquals(
      unreached.map((r) => r.id),
      [],
      "a faulted dependency must be on the route's path",
    );
  },
});

Deno.test({
  name:
    "failure injection: no response leaks upstream/internal detail (sentinel or 5xx patterns) — pinned defects included",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    assertEquals(
      run.records.filter((r) => r.leak).map((r) =>
        `${r.id}: ${r.leakEvidence}`
      ),
      [],
    );
    assertEquals(
      run.records.filter((r) => r.status === 500).map((r) =>
        `${r.id}: ${r.bodyPreview}`
      ).filter((s) =>
        !s.endsWith(
          '{"error":{"message":"Something went wrong. Please try again."}}',
        )
      ),
      [],
      "every 500 body must be the generic envelope",
    );
    assertEquals(
      run.records.filter((r) => r.storageCalls > 0).map((r) => r.id),
      [],
      "no route reaches Supabase Storage",
    );
  },
});

Deno.test({
  name:
    "failure injection: no unexpected HTTP 500 under any injected upstream failure",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    assertEquals(
      run.records.filter((r) => r.status === 500 && !isPinned(r)).map(describe),
      [],
    );
  },
});

Deno.test({
  name:
    "failure injection: Redis outage/slow/malformed/hang never changes a route's status (memory fallback)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const redis = run.records.filter((r) => r.dependency === "redis");
    assert(redis.length > 0);
    assertEquals(
      redis.filter((r) => r.status !== r.baselineStatus).map((r) =>
        `${r.id}: ${r.status} vs baseline ${r.baselineStatus}`
      ),
      [],
    );
    // A Redis outage must fail OPEN: nobody gets rate-limited or signed out.
    assertEquals(
      redis.filter((r) => r.status === 429 || r.status === 401).map(describe),
      [],
    );
  },
});

Deno.test({
  name:
    "failure injection: Auth outages surface as retryable 503, never as a sign-out 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const outages = run.records.filter(
      (r) =>
        r.dependency === "auth" &&
        (r.tier === "matrix" || r.tier === "sweep") &&
        [...AUTH_OUTAGE_MODES, ...AUTH_BODY_MODES].includes(r.mode) &&
        !isPinned(r),
    );
    assert(
      outages.length > 0,
      "at least the unpinned auth_refresh 5xx scenarios must be present",
    );
    // degraded_ok is only reachable through a documented status-only call
    // (logout: a 2xx with a garbage body IS a successful revocation).
    assertEquals(
      outages.filter((r) =>
        !["pass", "retried_ok", "degraded_ok"].includes(r.verdict)
      ).map(describe),
      [],
    );
  },
});

Deno.test({
  name:
    "failure injection: DB (PostgREST/RPC) failures → 503 or per-item retryable rejection, never a false 2xx",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const db = run.records.filter(
      (r) =>
        r.dependency === "rest" &&
        (r.tier === "matrix" || r.tier === "sweep") && !isPinned(r),
    );
    assert(db.length > 0);
    // degraded_ok is only reachable via a documented best-effort call or a
    // low-realism 2xx-with-garbage-body mode (see expectationFor / RouteSpec).
    const ok: Verdict[] = [
      "pass",
      "per_item_retryable_ok",
      "retried_ok",
      "degraded_ok",
    ];
    assertEquals(db.filter((r) => !ok.includes(r.verdict)).map(describe), []);
    // High-realism DB failures must NEVER be a 2xx that is not an honest per-item envelope.
    const hard = db.filter((r) =>
      REST_FAILURE_MODES.includes(r.mode) && r.faultedCallIndex === null
    );
    assert(hard.length > 0);
    assertEquals(
      hard.filter((r) => !["pass", "per_item_retryable_ok"].includes(r.verdict))
        .map(describe),
      [],
    );
  },
});

Deno.test({
  name:
    "failure injection: RevenueCat/Apple failures map to their coded 502/503 (or coded 401 for invalid_grant)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const external = run.records.filter(
      (r) =>
        (r.dependency === "revenuecat" || r.dependency === "apple") &&
        r.tier === "matrix" && !isPinned(r),
    );
    assert(external.length > 0);
    assertEquals(
      external.filter((r) =>
        !["pass", "degraded_ok", "retried_ok"].includes(r.verdict)
      ).map(describe),
      [],
    );
  },
});

Deno.test({
  name: "failure injection: targeted single-call faults behave as documented",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const targeted = run.records.filter((r) =>
      r.tier === "targeted" && !isPinned(r)
    );
    assert(targeted.length > 0);
    assertEquals(
      targeted.filter((r) =>
        !["pass", "degraded_ok", "per_item_retryable_ok", "retried_ok"]
          .includes(r.verdict)
      ).map(describe),
      [],
    );
  },
});

Deno.test({
  name:
    "failure injection: bounded-latency dependencies (Redis 1.2s, RevenueCat 10s) answer within budget under a hang",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const run = await results();
    const hangs = run.records.filter((r) =>
      r.mode === "hang" &&
      (r.dependency === "redis" || r.dependency === "revenuecat")
    );
    if (hangs.length === 0) return; // full tier only
    assertEquals(
      hangs.filter((r) => r.status === null).map((r) => r.id),
      [],
      "must not hang",
    );
    // Redis: every call on the path times out at 1.2s and they run serially;
    // RevenueCat: 10s (billing/webhook) or 15s (externalAccounts, deletion).
    const budget = (r: ScenarioRecord) =>
      r.dependency === "redis"
        ? r.calls.filter((c) => c.dependency === "redis").length * 1_200 + 1_000
        : (r.route.startsWith("delete_confirm") ? 15_000 : 10_000) + 1_000;
    assertEquals(
      hangs.filter((r) => r.durationMs > budget(r)).map((r) =>
        `${r.id} took ${r.durationMs}ms (budget ${budget(r)})`
      ),
      [],
    );
    // Whatever the cost, the app (15s/20s client timeouts) must still get an answer.
    assertEquals(
      hangs.filter((r) => r.dependency === "redis" && r.durationMs >= 15_000)
        .map((r) => `${r.id} took ${r.durationMs}ms`),
      [],
    );
  },
});

for (const pin of KNOWN_DEFECTS) {
  Deno.test({
    name: `REPRO (defect ${pin.finding}): ${pin.title}`,
    sanitizeOps: false,
    sanitizeResources: false,
    async fn() {
      const run = await results();
      const matched = run.records.filter(pin.match);
      for (const tier of pin.presentIn) {
        assert(
          matched.some((r) => r.tier === tier),
          `${pin.finding}: no ${tier} scenario matched in tier ${run.tier}`,
        );
      }
      if (matched.length === 0) return; // scenario class only exists in a higher tier
      const off = matched.filter((r) =>
        !pin.statuses.includes(r.status) || !pin.verdicts.includes(r.verdict)
      );
      assertEquals(
        off.map(describe),
        [],
        `${pin.finding} no longer reproduces as pinned — the production fix may have landed; remove the pin`,
      );
      if (pin.finding === "F7") {
        assertEquals(
          matched.filter((r) => r.durationMs < 15_000).map((r) =>
            `${r.id} took ${r.durationMs}ms`
          ),
          [],
          "F7 pins the ~25s auth-js retry hold on refresh (7 backoffs from 200ms)",
        );
      }
      if (pin.finding === "F8") {
        assertEquals(
          matched.filter((r) => r.durationMs < 5 * 1_200).map((r) =>
            `${r.id} took ${r.durationMs}ms`
          ),
          [],
          "F8 pins ≥5 serial Redis timeouts per authenticated request",
        );
      }
    },
  });
}
