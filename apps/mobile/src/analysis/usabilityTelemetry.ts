/**
 * Zero-handholding usability instrumentation
 * (`zero-handholding-usability-v1`).
 *
 * Companion to `docs/USABILITY_ZERO_HANDHOLDING.md`: the funnel steps here
 * are the protocol's task chain, and the derived confusion events are the
 * protocol's machine-detectable confusion signals. Everything in this module
 * is a measurement of what the user actually did — no step is ever inferred
 * or back-filled, and a missing step is an honest absence.
 *
 * The recorder is in-memory and side-effect free: it observes the flow, it
 * never gates it. `log` never throws (a telemetry bug must not break
 * capture), and derivation is a pure function over the recorded events so
 * live sessions and replayed logs produce identical confusion verdicts.
 */

export const USABILITY_PROTOCOL_VERSION = 'zero-handholding-usability-v1';

/** The protocol task chain, in expected order. */
export const USABILITY_FUNNEL_STEPS = [
  /** T1 — the Stroke Analysis surface is on screen. */
  'analyze_opened',
  /** T2 — a technique or Auto Detect was chosen (each change is logged). */
  'intent_selected',
  /** T3 — the live guided camera was opened. */
  'camera_opened',
  /** T4 — a readiness state was reported (detail = state). */
  'readiness_state',
  /** T5 — the camera reached `ready`. */
  'ready',
  /** T6 — motion was captured. */
  'stroke_captured',
  /** The clip was saved (detail = start-region lock outcome when known). */
  'capture_saved',
  /** Scoring/classification started. */
  'analysis_started',
  /** T7 — an honest strokeIntent outcome surface was shown. */
  'intent_outcome_shown',
  /** T7 — the Result screen was opened. */
  'result_opened',
  /** An error surface was shown (detail = message). */
  'error_shown',
  /** The camera was cancelled before any capture. */
  'attempt_abandoned',
  /** T9 — a TRY AGAIN handoff re-armed the camera. */
  'try_again_rearm',
] as const;

export type UsabilityFunnelStep = (typeof USABILITY_FUNNEL_STEPS)[number];

export interface UsabilityFunnelEvent {
  step: UsabilityFunnelStep;
  /** Recorder-clock milliseconds (monotonic within one session). */
  tMs: number;
  /** Small human-readable payload (readiness state, error message, …). */
  detail?: string;
}

/**
 * Machine-detectable confusion signals, versioned with their thresholds.
 * These are SIGNALS for a human observer to adjudicate — the protocol never
 * treats a fired signal alone as proof the user was confused.
 */
export const CONFUSION_THRESHOLDS_V1 = {
  /** Camera open → first `ready` taking longer than this. */
  preReadyDwellMs: 20_000,
  /** `ready` lost (ready → non-ready) at least this many times. */
  readinessOscillationMin: 2,
  /** Intent re-picked at least this many times before the camera opened. */
  intentReselectionMin: 3,
  /** The same error surface shown consecutively at least this many times. */
  repeatedErrorMin: 2,
} as const;

export type ConfusionKind =
  | 'pre_ready_dwell_exceeded'
  | 'readiness_oscillation'
  | 'intent_reselection_churn'
  | 'repeated_error'
  | 'abandoned_before_capture';

export interface ConfusionEvent {
  kind: ConfusionKind;
  /** When the signal became true (event tMs). */
  tMs: number;
  detail: string;
}

/**
 * Observer-coded confusion taxonomy for live sessions (protocol §5). These
 * are logged by a human observer, never derived — the codes exist here so
 * the app, the protocol document, and session sheets share one vocabulary.
 */
export const OBSERVER_CONFUSION_CODES_V1 = {
  placement_uncertainty:
    'User unsure where/how to place the phone (moves it ≥2 times or asks).',
  intent_choice_stall:
    'User stalls >10s on the technique picker or asks what Auto Detect does.',
  start_tap_missed:
    'User never taps their starting spot, or taps and does not walk to it.',
  readiness_misread:
    'User swings before Ready, or waits >10s after Ready without swinging.',
  walkout_hesitation:
    'User hesitates to leave the phone, checks the screen mid-walkout.',
  result_misread_score:
    'User states a score/verdict the Result surface did not present.',
  uncertainty_misread:
    'User reads a withheld element as a failure of their swing, or invents ' +
    'a certainty the surface withheld.',
  abstention_unexplained:
    'User cannot say in their own words why no score/label was given.',
  try_again_not_found:
    'User cannot find or does not use Try Again to repeat the attempt.',
} as const;

export type ObserverConfusionCode = keyof typeof OBSERVER_CONFUSION_CODES_V1;

/** Pure confusion derivation over one session's ordered event log. */
export function deriveConfusionEvents(
  events: readonly UsabilityFunnelEvent[],
  thresholds: typeof CONFUSION_THRESHOLDS_V1 = CONFUSION_THRESHOLDS_V1,
): ConfusionEvent[] {
  const confusion: ConfusionEvent[] = [];

  // ── intent_reselection_churn: re-picks before the camera opened ────────
  const cameraOpen = events.find(e => e.step === 'camera_opened');
  const preCameraIntents = events.filter(
    e =>
      e.step === 'intent_selected' &&
      (cameraOpen === undefined || e.tMs <= cameraOpen.tMs),
  );
  if (preCameraIntents.length >= thresholds.intentReselectionMin) {
    const last = preCameraIntents[preCameraIntents.length - 1];
    if (last) {
      confusion.push({
        kind: 'intent_reselection_churn',
        tMs: last.tMs,
        detail: `intent selected ${preCameraIntents.length} times before capture`,
      });
    }
  }

  // ── pre_ready_dwell_exceeded: camera open → first ready too slow ───────
  if (cameraOpen) {
    const firstReady = events.find(
      e => e.step === 'ready' && e.tMs >= cameraOpen.tMs,
    );
    const firstCapture = events.find(
      e => e.step === 'stroke_captured' && e.tMs >= cameraOpen.tMs,
    );
    const horizon = firstReady ?? firstCapture;
    if (horizon && horizon.tMs - cameraOpen.tMs > thresholds.preReadyDwellMs) {
      confusion.push({
        kind: 'pre_ready_dwell_exceeded',
        tMs: horizon.tMs,
        detail: `${horizon.tMs - cameraOpen.tMs}ms from camera open to first ready`,
      });
    }
  }

  // ── readiness_oscillation: ready lost repeatedly ────────────────────────
  let wasReady = false;
  let readyLost = 0;
  let lastLossTMs = 0;
  for (const event of events) {
    if (event.step === 'ready') wasReady = true;
    else if (event.step === 'readiness_state' && event.detail !== 'ready') {
      if (wasReady) {
        readyLost += 1;
        lastLossTMs = event.tMs;
      }
      wasReady = false;
    }
  }
  if (readyLost >= thresholds.readinessOscillationMin) {
    confusion.push({
      kind: 'readiness_oscillation',
      tMs: lastLossTMs,
      detail: `ready lost ${readyLost} times`,
    });
  }

  // ── repeated_error: same error surface shown consecutively ─────────────
  let streak = 0;
  let previousDetail: string | undefined;
  for (const event of events) {
    if (event.step !== 'error_shown') continue;
    streak = event.detail === previousDetail ? streak + 1 : 1;
    previousDetail = event.detail;
    if (streak === thresholds.repeatedErrorMin) {
      confusion.push({
        kind: 'repeated_error',
        tMs: event.tMs,
        detail: `same error shown ${streak} times: ${event.detail ?? ''}`,
      });
    }
  }

  // ── abandoned_before_capture ────────────────────────────────────────────
  for (const event of events) {
    if (event.step !== 'attempt_abandoned') continue;
    const captured = events.some(
      e => e.step === 'stroke_captured' && e.tMs <= event.tMs,
    );
    if (!captured) {
      confusion.push({
        kind: 'abandoned_before_capture',
        tMs: event.tMs,
        detail: 'camera closed before any stroke was captured',
      });
    }
  }

  return confusion.sort((a, b) => a.tMs - b.tMs);
}

/** Per-task completion verdicts for the protocol's funnel (§4). */
export interface UsabilityFunnelSummary {
  protocolVersion: typeof USABILITY_PROTOCOL_VERSION;
  reachedAnalyze: boolean;
  selectedIntent: boolean;
  openedCamera: boolean;
  sawReadiness: boolean;
  reachedReady: boolean;
  capturedStroke: boolean;
  reachedOutcome: boolean;
  usedTryAgain: boolean;
  confusionEvents: ConfusionEvent[];
}

export function summarizeUsabilityFunnel(
  events: readonly UsabilityFunnelEvent[],
  thresholds: typeof CONFUSION_THRESHOLDS_V1 = CONFUSION_THRESHOLDS_V1,
): UsabilityFunnelSummary {
  const has = (step: UsabilityFunnelStep) => events.some(e => e.step === step);
  return {
    protocolVersion: USABILITY_PROTOCOL_VERSION,
    reachedAnalyze: has('analyze_opened'),
    selectedIntent: has('intent_selected'),
    openedCamera: has('camera_opened'),
    sawReadiness: has('readiness_state'),
    reachedReady: has('ready'),
    capturedStroke: has('stroke_captured'),
    reachedOutcome: has('result_opened') || has('intent_outcome_shown'),
    usedTryAgain: has('try_again_rearm'),
    confusionEvents: deriveConfusionEvents(events, thresholds),
  };
}

export interface UsabilityFunnelRecorder {
  log(step: UsabilityFunnelStep, detail?: string): void;
  events(): readonly UsabilityFunnelEvent[];
  summary(): UsabilityFunnelSummary;
  reset(): void;
}

export function createUsabilityFunnelRecorder(
  now: () => number = Date.now,
): UsabilityFunnelRecorder {
  let events: UsabilityFunnelEvent[] = [];
  return {
    log(step, detail) {
      try {
        events.push(
          detail === undefined
            ? { step, tMs: now() }
            : { step, tMs: now(), detail },
        );
      } catch {
        // Telemetry must never break the flow it observes.
      }
    },
    events: () => events,
    summary: () => summarizeUsabilityFunnel(events),
    reset() {
      events = [];
    },
  };
}

/** Shared app-wide recorder (one usability session per app run for now). */
export const usabilityFunnel: UsabilityFunnelRecorder =
  createUsabilityFunnelRecorder();
