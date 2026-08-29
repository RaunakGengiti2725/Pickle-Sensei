/**
 * Crash/stability SLO contract (`stability-slo-v1`).
 *
 * Typed telemetry events for the stability signals the release plan gates
 * canary advancement on — crashes, memory-pressure terminations, analysis
 * completion, camera startup failures, TRY AGAIN failures and live-session
 * flow failures — plus the pure aggregation and evaluation that turn one
 * observation window into a rollout decision.
 *
 * Honesty rules:
 *  - Every metric is a measurement over REAL recorded events; a metric whose
 *    denominator is empty (or below the frozen minimum sample size) is
 *    `not_evaluable`, never a synthetic pass.
 *  - A `not_evaluable` SLO can never turn the decision green: the rollout
 *    HOLDS until enough real traffic has been observed.
 *  - The rollout guard only ever blocks ADVANCING exposure. Pausing or
 *    rolling back is always allowed — a breached SLO must never trap
 *    operators at the current percentage.
 */

export const STABILITY_SLO_VERSION = "stability-slo-v1";

/** The stability signals tracked by this contract, as event kinds. */
export const STABILITY_EVENT_KINDS = [
  /** An app session (one foreground app run) began. */
  "session_started",
  /** The session ended by normal means (backgrounded/closed cleanly). */
  "session_ended_clean",
  /** The app crashed. `fatal: true` means the process died. */
  "crash",
  /** The OS killed the app under memory pressure (detected on next launch
   * from a dirty-termination marker preceded by a memory warning). */
  "memory_pressure_termination",
  /** A capture analysis run started. */
  "analysis_started",
  /** The analysis run produced an honest outcome (scored, low-confidence,
   * or a quality-blocked abstention — the surface answered the user). */
  "analysis_completed",
  /** The analysis run could not produce any outcome. */
  "analysis_failed",
  /** The guided camera was asked to start and did. */
  "camera_startup_succeeded",
  /** The guided camera was asked to start and failed (excludes user cancel). */
  "camera_startup_failed",
  /** A TRY AGAIN handoff re-armed the camera with the original intent. */
  "try_again_rearmed",
  /** A TRY AGAIN handoff was armed but never re-armed a capture. */
  "try_again_failed",
  /** The live session flow hit an internal failure (dispatch/subscriber). */
  "session_flow_failed",
] as const;

export type StabilityEventKind = (typeof STABILITY_EVENT_KINDS)[number];

interface StabilityEventBase {
  /** Stable pseudonymous user key — never an email or device identifier. */
  userKey: string;
  /** App session the event belongs to; null when none exists (e.g. a
   * next-launch termination classification for the PREVIOUS run). */
  sessionKey: string | null;
  /** Client event time, ISO-8601. */
  at: string;
}

export type StabilitySloEvent = StabilityEventBase &
  (
    | { kind: "session_started" }
    | { kind: "session_ended_clean" }
    | {
        kind: "crash";
        fatal: boolean;
        /** Stable hash of the symbolicated top frame — never a stack body. */
        fingerprint: string;
      }
    | { kind: "memory_pressure_termination" }
    | { kind: "analysis_started" }
    | { kind: "analysis_completed" }
    | { kind: "analysis_failed"; failureKind: string }
    | { kind: "camera_startup_succeeded" }
    | { kind: "camera_startup_failed"; reason: string }
    | { kind: "try_again_rearmed" }
    | { kind: "try_again_failed"; reason: string }
    | { kind: "session_flow_failed"; reason: string }
  );

/** The SLOs derived from the events above. */
export const STABILITY_SLO_KEYS = [
  "crash_free_users",
  "crash_free_sessions",
  "analysis_completion",
  "camera_startup_failure",
  "try_again_failure",
  "session_flow_failure",
  "memory_pressure_termination",
] as const;

export type StabilitySloKey = (typeof STABILITY_SLO_KEYS)[number];

/**
 * One observation window's aggregated stability metrics. Every rate is
 * `null` exactly when its denominator is zero — an honest "no data", never
 * an implicit 100%.
 */
export interface StabilitySloWindowMetrics {
  version: typeof STABILITY_SLO_VERSION;
  /** Distinct users with at least one session_started. */
  usersObserved: number;
  /** Distinct sessions started (session_started events with a sessionKey). */
  sessionsStarted: number;
  fatalCrashes: number;
  memoryPressureTerminations: number;
  analysesStarted: number;
  analysesCompleted: number;
  analysesFailed: number;
  cameraStartupsSucceeded: number;
  cameraStartupsFailed: number;
  tryAgainRearmed: number;
  tryAgainFailed: number;
  sessionFlowFailures: number;
  /** Fraction of observed users with zero fatal crashes. */
  crashFreeUsersRate: number | null;
  /** Fraction of started sessions with zero fatal crashes. */
  crashFreeSessionsRate: number | null;
  /** completed / started. */
  analysisCompletionRate: number | null;
  /** failed / (failed + succeeded). */
  cameraStartupFailureRate: number | null;
  /** failed / (failed + rearmed). */
  tryAgainFailureRate: number | null;
  /** sessions with a session_flow_failed / sessions started. */
  sessionFlowFailureRate: number | null;
  /** memory-pressure terminations / sessions started. */
  memoryPressureTerminationRate: number | null;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Pure aggregation over one window's ordered (or unordered) event log. */
export function aggregateStabilitySlo(
  events: readonly StabilitySloEvent[],
): StabilitySloWindowMetrics {
  const users = new Set<string>();
  const sessions = new Set<string>();
  const usersWithFatalCrash = new Set<string>();
  const sessionsWithFatalCrash = new Set<string>();
  const sessionsWithFlowFailure = new Set<string>();
  let fatalCrashes = 0;
  let memoryPressureTerminations = 0;
  let analysesStarted = 0;
  let analysesCompleted = 0;
  let analysesFailed = 0;
  let cameraStartupsSucceeded = 0;
  let cameraStartupsFailed = 0;
  let tryAgainRearmed = 0;
  let tryAgainFailed = 0;
  let sessionFlowFailures = 0;

  for (const event of events) {
    switch (event.kind) {
      case "session_started":
        users.add(event.userKey);
        if (event.sessionKey !== null) sessions.add(event.sessionKey);
        break;
      case "session_ended_clean":
        break;
      case "crash":
        if (event.fatal) {
          fatalCrashes += 1;
          usersWithFatalCrash.add(event.userKey);
          if (event.sessionKey !== null) sessionsWithFatalCrash.add(event.sessionKey);
        }
        break;
      case "memory_pressure_termination":
        memoryPressureTerminations += 1;
        break;
      case "analysis_started":
        analysesStarted += 1;
        break;
      case "analysis_completed":
        analysesCompleted += 1;
        break;
      case "analysis_failed":
        analysesFailed += 1;
        break;
      case "camera_startup_succeeded":
        cameraStartupsSucceeded += 1;
        break;
      case "camera_startup_failed":
        cameraStartupsFailed += 1;
        break;
      case "try_again_rearmed":
        tryAgainRearmed += 1;
        break;
      case "try_again_failed":
        tryAgainFailed += 1;
        break;
      case "session_flow_failed":
        sessionFlowFailures += 1;
        if (event.sessionKey !== null) sessionsWithFlowFailure.add(event.sessionKey);
        break;
    }
  }

  // Only crashes/failures inside OBSERVED sessions count against the
  // session-scoped rates; a crash with an unknown session still counts
  // against the user-scoped rate.
  const crashedObservedSessions = [...sessionsWithFatalCrash].filter((key) =>
    sessions.has(key),
  ).length;
  const failedObservedSessions = [...sessionsWithFlowFailure].filter((key) =>
    sessions.has(key),
  ).length;
  const crashedObservedUsers = [...usersWithFatalCrash].filter((key) => users.has(key)).length;

  return {
    version: STABILITY_SLO_VERSION,
    usersObserved: users.size,
    sessionsStarted: sessions.size,
    fatalCrashes,
    memoryPressureTerminations,
    analysesStarted,
    analysesCompleted,
    analysesFailed,
    cameraStartupsSucceeded,
    cameraStartupsFailed,
    tryAgainRearmed,
    tryAgainFailed,
    sessionFlowFailures,
    crashFreeUsersRate: rate(users.size - crashedObservedUsers, users.size),
    crashFreeSessionsRate: rate(sessions.size - crashedObservedSessions, sessions.size),
    analysisCompletionRate: rate(analysesCompleted, analysesStarted),
    cameraStartupFailureRate: rate(
      cameraStartupsFailed,
      cameraStartupsFailed + cameraStartupsSucceeded,
    ),
    tryAgainFailureRate: rate(tryAgainFailed, tryAgainFailed + tryAgainRearmed),
    sessionFlowFailureRate: rate(failedObservedSessions, sessions.size),
    memoryPressureTerminationRate: rate(memoryPressureTerminations, sessions.size),
  };
}

/**
 * Frozen v1 thresholds. `direction` says which side of the threshold passes;
 * `minSample` is the denominator size below which the SLO is honestly
 * `not_evaluable` (a 1-session window proving nothing must not gate green).
 */
export interface StabilitySloThreshold {
  direction: "min" | "max";
  threshold: number;
  minSample: number;
}

export const STABILITY_SLO_THRESHOLDS_V1: Record<StabilitySloKey, StabilitySloThreshold> = {
  crash_free_users: { direction: "min", threshold: 0.995, minSample: 20 },
  crash_free_sessions: { direction: "min", threshold: 0.998, minSample: 50 },
  analysis_completion: { direction: "min", threshold: 0.9, minSample: 20 },
  camera_startup_failure: { direction: "max", threshold: 0.02, minSample: 20 },
  try_again_failure: { direction: "max", threshold: 0.05, minSample: 10 },
  session_flow_failure: { direction: "max", threshold: 0.02, minSample: 20 },
  memory_pressure_termination: { direction: "max", threshold: 0.01, minSample: 50 },
} as const;

export type StabilitySloVerdict = "pass" | "breach" | "not_evaluable";

export interface StabilitySloResult {
  slo: StabilitySloKey;
  /** The measured rate; null when the denominator was empty. */
  value: number | null;
  /** The denominator the rate was measured over. */
  sampleSize: number;
  threshold: StabilitySloThreshold;
  verdict: StabilitySloVerdict;
}

export interface StabilitySloEvaluation {
  version: typeof STABILITY_SLO_VERSION;
  results: StabilitySloResult[];
}

function verdictFor(
  value: number | null,
  sampleSize: number,
  threshold: StabilitySloThreshold,
): StabilitySloVerdict {
  if (value === null || sampleSize < threshold.minSample) return "not_evaluable";
  if (threshold.direction === "min") return value >= threshold.threshold ? "pass" : "breach";
  return value <= threshold.threshold ? "pass" : "breach";
}

/** Pure evaluation of one window's metrics against the frozen thresholds. */
export function evaluateStabilitySlo(
  metrics: StabilitySloWindowMetrics,
  thresholds: Record<StabilitySloKey, StabilitySloThreshold> = STABILITY_SLO_THRESHOLDS_V1,
): StabilitySloEvaluation {
  const samples: Record<StabilitySloKey, { value: number | null; sampleSize: number }> = {
    crash_free_users: { value: metrics.crashFreeUsersRate, sampleSize: metrics.usersObserved },
    crash_free_sessions: {
      value: metrics.crashFreeSessionsRate,
      sampleSize: metrics.sessionsStarted,
    },
    analysis_completion: {
      value: metrics.analysisCompletionRate,
      sampleSize: metrics.analysesStarted,
    },
    camera_startup_failure: {
      value: metrics.cameraStartupFailureRate,
      sampleSize: metrics.cameraStartupsFailed + metrics.cameraStartupsSucceeded,
    },
    try_again_failure: {
      value: metrics.tryAgainFailureRate,
      sampleSize: metrics.tryAgainFailed + metrics.tryAgainRearmed,
    },
    session_flow_failure: {
      value: metrics.sessionFlowFailureRate,
      sampleSize: metrics.sessionsStarted,
    },
    memory_pressure_termination: {
      value: metrics.memoryPressureTerminationRate,
      sampleSize: metrics.sessionsStarted,
    },
  };
  return {
    version: STABILITY_SLO_VERSION,
    results: STABILITY_SLO_KEYS.map((slo) => {
      const sample = samples[slo];
      const threshold = thresholds[slo];
      return {
        slo,
        value: sample.value,
        sampleSize: sample.sampleSize,
        threshold,
        verdict: verdictFor(sample.value, sample.sampleSize, threshold),
      };
    }),
  };
}

/**
 * The rollout action a stability evaluation demands from the canary
 * machinery (feature_flag / model_bundle percentage rollout):
 *  - `pause`   — at least one SLO breached: exposure must not advance.
 *  - `hold`    — nothing breached, but at least one SLO is not evaluable
 *                yet: exposure must not advance until real data exists.
 *  - `proceed` — every SLO evaluable and passing.
 */
export type StabilityRolloutAction = "proceed" | "hold" | "pause";

export interface StabilityRolloutDecision {
  version: typeof STABILITY_SLO_VERSION;
  action: StabilityRolloutAction;
  breachedSlos: StabilitySloKey[];
  notEvaluableSlos: StabilitySloKey[];
}

export function stabilityRolloutDecision(
  evaluation: StabilitySloEvaluation,
): StabilityRolloutDecision {
  const breachedSlos = evaluation.results
    .filter((result) => result.verdict === "breach")
    .map((result) => result.slo);
  const notEvaluableSlos = evaluation.results
    .filter((result) => result.verdict === "not_evaluable")
    .map((result) => result.slo);
  const action: StabilityRolloutAction =
    breachedSlos.length > 0 ? "pause" : notEvaluableSlos.length > 0 ? "hold" : "proceed";
  return { version: STABILITY_SLO_VERSION, action, breachedSlos, notEvaluableSlos };
}

export interface RolloutAdvanceVerdict {
  /** Whether the requested rollout percentage may be applied. */
  allowed: boolean;
  /** The percentage that may actually be applied (the requested one when
   * allowed; the current one when the advance is blocked). */
  effectiveRolloutPercent: number;
  decision: StabilityRolloutDecision;
}

/**
 * Guard for advancing a percentage rollout (the feature_flag /
 * model_bundle canary machinery). Increasing exposure requires a `proceed`
 * decision; holding at — or reducing below — the current percentage is
 * ALWAYS allowed, so a breach can never block a pause or rollback.
 */
export function guardRolloutAdvance(
  decision: StabilityRolloutDecision,
  currentRolloutPercent: number,
  requestedRolloutPercent: number,
): RolloutAdvanceVerdict {
  const isAdvance = requestedRolloutPercent > currentRolloutPercent;
  const allowed = !isAdvance || decision.action === "proceed";
  return {
    allowed,
    effectiveRolloutPercent: allowed ? requestedRolloutPercent : currentRolloutPercent,
    decision,
  };
}
