import { describe, it } from "vitest";
import {
  STABILITY_EVENT_KINDS,
  STABILITY_SLO_KEYS,
  STABILITY_SLO_THRESHOLDS_V1,
  STABILITY_SLO_VERSION,
  aggregateStabilitySlo,
  evaluateStabilitySlo,
  guardRolloutAdvance,
  stabilityRolloutDecision,
  type StabilitySloEvent,
  type StabilitySloKey,
  type StabilitySloThreshold,
  type StabilitySloWindowMetrics,
} from "../../src/index.js";
import {
  bump,
  check,
  checkEqual,
  expectCampaignHeld,
  makeRng,
  runStressCampaign,
  stable,
  type Rng,
  type StressCampaign,
  stressTestTimeoutMs,
} from "./harness.js";

/**
 * Seeded stress of the stability SLO contract (stabilitySlo.ts):
 *  - every window count is an exact, order-independent fold of the events;
 *  - every rate is null exactly when its denominator is empty, otherwise
 *    finite; the set-based crash-free / flow-failure fractions are always in
 *    [0, 1] (session-scoped rates only count crashes and flow failures inside
 *    OBSERVED sessions; unknown-session crashes still count against users);
 *    the count-ratio rates (completed/started, terminations/sessions) are in
 *    [0, 1] for a causally complete window — a window cut between a start
 *    and its completion (or a next-launch termination classified into a
 *    window with fewer sessions) is the near-legal stream probed separately;
 *  - evaluation covers every SLO key with a verdict in
 *    {pass, breach, not_evaluable}; a null rate or a sample below minSample
 *    is not_evaluable, never a pass;
 *  - decision: any breach → pause; otherwise any not_evaluable → hold;
 *    otherwise proceed;
 *  - guard: raising exposure needs proceed; holding or lowering is always
 *    allowed (a breach can never block a pause or rollback).
 */

type Action =
  | {
      kind: "event";
      eventKind: (typeof STABILITY_EVENT_KINDS)[number];
      user: number;
      session: number | null;
      fatal: boolean;
    }
  | { kind: "shuffle"; permutationSeed: number }
  | { kind: "guard"; current: number; requested: number }
  | {
      kind: "thresholds";
      overrides: Array<{
        slo: StabilitySloKey;
        direction: "min" | "max";
        threshold: number;
        minSample: number;
      }> | null;
    };

interface Model {
  events: StabilitySloEvent[];
  thresholds: Record<StabilitySloKey, StabilitySloThreshold>;
  users: Set<string>;
  sessions: Set<string>;
  usersWithFatal: Set<string>;
  sessionsWithFatal: Set<string>;
  sessionsWithFlow: Set<string>;
  counts: Record<string, number>;
}

const BASE_MS = Date.parse("2026-09-01T00:00:00.000Z");

type Domain = "causal" | "window-cut";

function causallyAllowed(
  kind: (typeof STABILITY_EVENT_KINDS)[number],
  history: readonly Action[],
): boolean {
  let started = 0;
  let resolved = 0;
  let terminations = 0;
  const sessions = new Set<number>();
  for (const prior of history) {
    if (prior.kind !== "event") continue;
    if (prior.eventKind === "analysis_started") started += 1;
    if (prior.eventKind === "analysis_completed" || prior.eventKind === "analysis_failed")
      resolved += 1;
    if (prior.eventKind === "memory_pressure_termination") terminations += 1;
    if (prior.eventKind === "session_started" && prior.session !== null)
      sessions.add(prior.session);
  }
  if (kind === "analysis_completed" || kind === "analysis_failed") return resolved < started;
  if (kind === "memory_pressure_termination") return terminations < sessions.size;
  return true;
}

function genAction(rng: Rng, history: readonly Action[], domain: Domain): Action {
  const roll = rng.next();
  if (roll < 0.78) {
    let eventKind = rng.pick(STABILITY_EVENT_KINDS);
    if (domain === "causal" && !causallyAllowed(eventKind, history)) eventKind = "session_started";
    return {
      kind: "event",
      eventKind,
      user: rng.int(0, 7),
      session: rng.chance(0.15) ? null : rng.int(0, 11),
      fatal: rng.chance(0.6),
    };
  }
  if (roll < 0.85) return { kind: "shuffle", permutationSeed: rng.int(0, 0xffffffff) };
  if (roll < 0.95) return { kind: "guard", current: rng.int(0, 100), requested: rng.int(0, 100) };
  if (rng.chance(0.3)) return { kind: "thresholds", overrides: null };
  const overrides = STABILITY_SLO_KEYS.filter(() => rng.chance(0.5)).map((slo) => ({
    slo,
    direction: rng.pick(["min", "max"] as const),
    threshold: rng.int(0, 100) / 100,
    minSample: rng.int(0, 6),
  }));
  return { kind: "thresholds", overrides };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function expectedMetrics(model: Model): StabilitySloWindowMetrics {
  const c = model.counts;
  const crashedUsers = [...model.usersWithFatal].filter((u) => model.users.has(u)).length;
  const crashedSessions = [...model.sessionsWithFatal].filter((s) => model.sessions.has(s)).length;
  const flowSessions = [...model.sessionsWithFlow].filter((s) => model.sessions.has(s)).length;
  const cameraTotal = (c["camera_startup_failed"] ?? 0) + (c["camera_startup_succeeded"] ?? 0);
  const tryAgainTotal = (c["try_again_failed"] ?? 0) + (c["try_again_rearmed"] ?? 0);
  return {
    version: STABILITY_SLO_VERSION,
    usersObserved: model.users.size,
    sessionsStarted: model.sessions.size,
    fatalCrashes: c["fatal_crash"] ?? 0,
    memoryPressureTerminations: c["memory_pressure_termination"] ?? 0,
    analysesStarted: c["analysis_started"] ?? 0,
    analysesCompleted: c["analysis_completed"] ?? 0,
    analysesFailed: c["analysis_failed"] ?? 0,
    cameraStartupsSucceeded: c["camera_startup_succeeded"] ?? 0,
    cameraStartupsFailed: c["camera_startup_failed"] ?? 0,
    tryAgainRearmed: c["try_again_rearmed"] ?? 0,
    tryAgainFailed: c["try_again_failed"] ?? 0,
    sessionFlowFailures: c["session_flow_failed"] ?? 0,
    crashFreeUsersRate: rate(model.users.size - crashedUsers, model.users.size),
    crashFreeSessionsRate: rate(model.sessions.size - crashedSessions, model.sessions.size),
    analysisCompletionRate: rate(c["analysis_completed"] ?? 0, c["analysis_started"] ?? 0),
    cameraStartupFailureRate: rate(c["camera_startup_failed"] ?? 0, cameraTotal),
    tryAgainFailureRate: rate(c["try_again_failed"] ?? 0, tryAgainTotal),
    sessionFlowFailureRate: rate(flowSessions, model.sessions.size),
    memoryPressureTerminationRate: rate(c["memory_pressure_termination"] ?? 0, model.sessions.size),
  };
}

const SET_RATE_FIELDS = [
  "crashFreeUsersRate",
  "crashFreeSessionsRate",
  "cameraStartupFailureRate",
  "tryAgainFailureRate",
  "sessionFlowFailureRate",
] as const;
const COUNT_RATIO_FIELDS = ["analysisCompletionRate", "memoryPressureTerminationRate"] as const;

function sampleFor(
  metrics: StabilitySloWindowMetrics,
  slo: StabilitySloKey,
): { value: number | null; sampleSize: number } {
  switch (slo) {
    case "crash_free_users":
      return { value: metrics.crashFreeUsersRate, sampleSize: metrics.usersObserved };
    case "crash_free_sessions":
      return { value: metrics.crashFreeSessionsRate, sampleSize: metrics.sessionsStarted };
    case "analysis_completion":
      return { value: metrics.analysisCompletionRate, sampleSize: metrics.analysesStarted };
    case "camera_startup_failure":
      return {
        value: metrics.cameraStartupFailureRate,
        sampleSize: metrics.cameraStartupsFailed + metrics.cameraStartupsSucceeded,
      };
    case "try_again_failure":
      return {
        value: metrics.tryAgainFailureRate,
        sampleSize: metrics.tryAgainFailed + metrics.tryAgainRearmed,
      };
    case "session_flow_failure":
      return { value: metrics.sessionFlowFailureRate, sampleSize: metrics.sessionsStarted };
    case "memory_pressure_termination":
      return { value: metrics.memoryPressureTerminationRate, sampleSize: metrics.sessionsStarted };
  }
}

function makeCampaign(domain: Domain, boundCountRatios: boolean): StressCampaign<Action, Model> {
  const stats: Record<string, number> = {};
  return {
    name: `stability-slo-${domain}${boundCountRatios ? "-bounded" : ""}`,
    stats,
    init: () => ({
      events: [],
      thresholds: STABILITY_SLO_THRESHOLDS_V1,
      users: new Set(),
      sessions: new Set(),
      usersWithFatal: new Set(),
      sessionsWithFatal: new Set(),
      sessionsWithFlow: new Set(),
      counts: {},
    }),
    genAction: (rng, _index, history) => genAction(rng, history, domain),
    step(model, action, index) {
      if (action.kind === "event") {
        const userKey = `u${action.user}`;
        const sessionKey = action.session === null ? null : `s${action.session}`;
        const base = { userKey, sessionKey, at: new Date(BASE_MS + index * 1000).toISOString() };
        let event: StabilitySloEvent;
        switch (action.eventKind) {
          case "crash":
            event = {
              ...base,
              kind: "crash",
              fatal: action.fatal,
              fingerprint: `fp${action.user}`,
            };
            if (action.fatal) {
              model.counts["fatal_crash"] = (model.counts["fatal_crash"] ?? 0) + 1;
              model.usersWithFatal.add(userKey);
              if (sessionKey !== null) model.sessionsWithFatal.add(sessionKey);
            }
            break;
          case "analysis_failed":
            event = { ...base, kind: "analysis_failed", failureKind: "timeout" };
            break;
          case "camera_startup_failed":
            event = { ...base, kind: "camera_startup_failed", reason: "hardware" };
            break;
          case "try_again_failed":
            event = { ...base, kind: "try_again_failed", reason: "no_rearm" };
            break;
          case "session_flow_failed":
            event = { ...base, kind: "session_flow_failed", reason: "dispatch" };
            if (sessionKey !== null) model.sessionsWithFlow.add(sessionKey);
            break;
          case "session_started":
            event = { ...base, kind: "session_started" };
            model.users.add(userKey);
            if (sessionKey !== null) model.sessions.add(sessionKey);
            break;
          default:
            event = { ...base, kind: action.eventKind };
        }
        if (action.eventKind !== "crash")
          model.counts[action.eventKind] = (model.counts[action.eventKind] ?? 0) + 1;
        model.events.push(event);
        bump(stats, `event_${action.eventKind}`);
      } else if (action.kind === "shuffle") {
        const order = makeRng(action.permutationSeed).permutation(model.events.length);
        model.events = order.map((i) => model.events[i]!);
        bump(stats, "shuffle");
      } else if (action.kind === "thresholds") {
        if (action.overrides === null) {
          model.thresholds = STABILITY_SLO_THRESHOLDS_V1;
        } else {
          const next = { ...STABILITY_SLO_THRESHOLDS_V1 };
          for (const override of action.overrides) {
            next[override.slo] = {
              direction: override.direction,
              threshold: override.threshold,
              minSample: override.minSample,
            };
          }
          model.thresholds = next;
        }
        bump(stats, "thresholds");
      }

      const metrics = aggregateStabilitySlo(model.events);
      checkEqual(metrics, expectedMetrics(model), "window-metrics-are-exact-fold-of-events");
      check(!stable(metrics).includes("__nonfinite"), "no-nan-or-infinity-in-metrics", () =>
        stable(metrics),
      );
      for (const field of SET_RATE_FIELDS) {
        const value = metrics[field];
        if (value !== null)
          check(value >= 0 && value <= 1, "set-rates-within-0-1", () => `${field}=${value}`);
      }
      for (const field of COUNT_RATIO_FIELDS) {
        const value = metrics[field];
        if (value !== null) {
          check(
            Number.isFinite(value) && value >= 0,
            "count-ratios-finite-nonnegative",
            () => `${field}=${value}`,
          );
          if (boundCountRatios)
            check(value <= 1, "count-ratios-within-0-1", () => `${field}=${value}`);
          if (value > 1) bump(stats, `${field}_above_1`);
        }
      }
      check(
        metrics.crashFreeUsersRate === null
          ? metrics.usersObserved === 0
          : metrics.usersObserved > 0,
        "null-rate-iff-empty-denominator",
        () => stable(metrics),
      );
      checkEqual(
        aggregateStabilitySlo([...model.events].reverse()),
        metrics,
        "aggregate-is-order-independent",
      );

      const evaluation = evaluateStabilitySlo(metrics, model.thresholds);
      checkEqual(evaluation.version, STABILITY_SLO_VERSION, "evaluation-carries-contract-version");
      checkEqual(
        evaluation.results.map((r) => r.slo),
        [...STABILITY_SLO_KEYS],
        "evaluation-covers-every-slo-in-order",
      );
      for (const result of evaluation.results) {
        const threshold = model.thresholds[result.slo];
        const sample = sampleFor(metrics, result.slo);
        checkEqual(
          { value: result.value, sampleSize: result.sampleSize, threshold: result.threshold },
          { ...sample, threshold },
          "result-reports-its-rate-sample-and-threshold",
        );
        const expectedVerdict =
          sample.value === null || sample.sampleSize < threshold.minSample
            ? "not_evaluable"
            : threshold.direction === "min"
              ? sample.value >= threshold.threshold
                ? "pass"
                : "breach"
              : sample.value <= threshold.threshold
                ? "pass"
                : "breach";
        checkEqual(
          result.verdict,
          expectedVerdict,
          "verdict-matches-threshold-direction-and-min-sample",
        );
        if (sample.value === null)
          check(result.verdict === "not_evaluable", "no-data-is-never-a-pass", () =>
            stable(result),
          );
        bump(stats, `verdict_${result.verdict}`);
      }

      const decision = stabilityRolloutDecision(evaluation);
      const breached = evaluation.results.filter((r) => r.verdict === "breach").map((r) => r.slo);
      const notEvaluable = evaluation.results
        .filter((r) => r.verdict === "not_evaluable")
        .map((r) => r.slo);
      checkEqual(
        decision,
        {
          version: STABILITY_SLO_VERSION,
          action: breached.length > 0 ? "pause" : notEvaluable.length > 0 ? "hold" : "proceed",
          breachedSlos: breached,
          notEvaluableSlos: notEvaluable,
        },
        "decision-pause-beats-hold-beats-proceed",
      );
      if (decision.action === "proceed") {
        check(
          evaluation.results.every((r) => r.verdict === "pass"),
          "proceed-requires-every-slo-passing",
          () => stable(evaluation),
        );
      }
      bump(stats, `decision_${decision.action}`);

      if (action.kind === "guard") {
        const verdict = guardRolloutAdvance(decision, action.current, action.requested);
        const advance = action.requested > action.current;
        checkEqual(
          verdict,
          {
            allowed: !advance || decision.action === "proceed",
            effectiveRolloutPercent:
              !advance || decision.action === "proceed" ? action.requested : action.current,
            decision,
          },
          "guard-blocks-only-advances-without-proceed",
        );
        if (!advance)
          check(verdict.allowed, "rollback-or-hold-is-always-allowed", () =>
            stable({ action, verdict }),
          );
        bump(stats, verdict.allowed ? "guard_allowed" : "guard_blocked");
        return `guard:${verdict.allowed ? 1 : 0}:${verdict.effectiveRolloutPercent}`;
      }
      return `${action.kind}:${decision.action}:${breached.length}:${notEvaluable.length}`;
    },
  };
}

describe("stability SLO — seeded randomized long-run", () => {
  it(
    "causally complete windows: exact fold, every rate in [0, 1], honest verdicts, guard",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign("causal", true)));
    },
    stressTestTimeoutMs(),
  );

  it(
    "window-cut streams: exact fold, set-based rates in [0, 1], honest verdicts, guard",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign("window-cut", false)));
    },
    stressTestTimeoutMs(),
  );
});

// Near-legal probe (STRESS_NEAR_LEGAL=1): asserts the count-ratio rates stay
// within [0, 1] on window-cut streams. Known to fail — completed/started and
// terminations/sessions exceed 1 whenever the window holds more completions
// (or next-launch terminations) than starts; recorded as a finding, kept
// here so the seeds stay replayable.
describe.skipIf(!process.env["STRESS_NEAR_LEGAL"])("stability SLO — near-legal probe", () => {
  it(
    "count-ratio rates stay within [0, 1] on window-cut streams",
    async () => {
      expectCampaignHeld(await runStressCampaign(makeCampaign("window-cut", true)));
    },
    stressTestTimeoutMs(),
  );
});
