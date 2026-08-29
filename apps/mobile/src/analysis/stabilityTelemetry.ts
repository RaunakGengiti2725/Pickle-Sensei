import type {
  StabilitySloEvent,
  StabilitySloWindowMetrics,
} from '@pickle/shared-types';
import { aggregateStabilitySlo } from '@pickle/shared-types';

/**
 * Crash/stability SLO instrumentation (`stability-slo-v1` mobile emitter).
 *
 * Companion to `packages/shared-types/src/stabilitySlo.ts`: the recorder
 * collects the typed StabilitySloEvent stream that the shared aggregation
 * and canary pause-rollout logic consume. Everything recorded here is a
 * measurement of something that actually happened in the app — no event is
 * ever inferred, back-filled, or synthesized.
 *
 * The recorder is in-memory and side-effect free: it observes the flows, it
 * never gates them. `record` never throws (a telemetry bug must not break
 * capture, analysis, or a live session).
 */

/** A StabilitySloEvent minus the base fields the recorder fills in. */
type WithoutBase<E> = E extends unknown
  ? Omit<E, 'userKey' | 'sessionKey' | 'at'>
  : never;

export type StabilityEventInput = WithoutBase<StabilitySloEvent>;

/**
 * Context stamped onto every recorded event. `userKey` must be a stable
 * pseudonymous key (the canonical data-owner key) — never an email or a
 * device identifier. Until it is known, events carry the honest
 * 'unassigned' placeholder rather than a fabricated identity.
 */
export interface StabilityContext {
  userKey: string;
  sessionKey: string | null;
}

export const UNASSIGNED_STABILITY_USER_KEY = 'unassigned';

export interface StabilityRecorder {
  setContext(context: StabilityContext): void;
  /** Record with the current context. Never throws. */
  record(input: StabilityEventInput): void;
  /** Record with explicit attribution — used for events that describe a
   * PREVIOUS run (crash / memory-pressure kill classified on the next
   * launch), which must never be stamped with this run's session. */
  recordAttributed(
    input: StabilityEventInput,
    attribution: StabilityContext,
  ): void;
  events(): readonly StabilitySloEvent[];
  metrics(): StabilitySloWindowMetrics;
  reset(): void;
}

export function createStabilityRecorder(
  nowIso: () => string = () => new Date().toISOString(),
): StabilityRecorder {
  let context: StabilityContext = {
    userKey: UNASSIGNED_STABILITY_USER_KEY,
    sessionKey: null,
  };
  let events: StabilitySloEvent[] = [];
  const append = (input: StabilityEventInput, at: StabilityContext): void => {
    try {
      events.push({
        ...input,
        userKey: at.userKey,
        sessionKey: at.sessionKey,
        at: nowIso(),
      });
    } catch {
      // Telemetry must never break the flow it observes.
    }
  };
  return {
    setContext(next) {
      context = next;
    },
    record(input) {
      append(input, context);
    },
    recordAttributed(input, attribution) {
      append(input, attribution);
    },
    events: () => events,
    metrics: () => aggregateStabilitySlo(events),
    reset() {
      events = [];
    },
  };
}

/** Shared app-wide recorder (one stability session per app run for now). */
export const stabilitySlo: StabilityRecorder = createStabilityRecorder();

// ─── Previous-run termination classification ────────────────────────────────

/**
 * What the PREVIOUS app run left behind, read on the next launch. Crashes
 * and memory-pressure kills terminate the process, so they can only ever be
 * observed retroactively from a persisted marker — never live.
 */
export interface PreviousRunMarker {
  /** The previous run's session key, carried so the classified event is
   * attributed to the run it describes. */
  sessionKey: string | null;
  /** The previous run recorded a clean end (background/close) before dying. */
  endedClean: boolean;
  /** The OS delivered a memory warning during the previous run. */
  memoryWarningSeen: boolean;
  /** A crash reporter marker exists for the previous run; the fingerprint is
   * a stable hash of the top frame — never a stack body. */
  crashFingerprint: string | null;
}

export type PreviousRunClassification =
  | 'clean_exit'
  | 'crash'
  | 'memory_pressure_termination'
  /** Dirty exit with no crash marker and no memory warning: honestly
   * unattributable (user swipe-kill, OS update, battery death, …). */
  | 'unknown_termination';

/** Pure classification of one previous run's persisted marker. */
export function classifyPreviousRun(
  marker: PreviousRunMarker,
): PreviousRunClassification {
  if (marker.crashFingerprint !== null) return 'crash';
  if (marker.endedClean) return 'clean_exit';
  if (marker.memoryWarningSeen) return 'memory_pressure_termination';
  return 'unknown_termination';
}

/**
 * Emit the stability events a previous-run marker actually evidences. A
 * clean exit and an unknown termination emit nothing — an unattributable
 * dirty exit is never counted as a crash OR a memory-pressure kill.
 */
export function recordPreviousRunOutcome(
  recorder: StabilityRecorder,
  previousUserKey: string,
  marker: PreviousRunMarker,
): PreviousRunClassification {
  const classification = classifyPreviousRun(marker);
  const attribution: StabilityContext = {
    userKey: previousUserKey,
    sessionKey: marker.sessionKey,
  };
  if (classification === 'crash' && marker.crashFingerprint !== null) {
    recorder.recordAttributed(
      { kind: 'crash', fatal: true, fingerprint: marker.crashFingerprint },
      attribution,
    );
  } else if (classification === 'memory_pressure_termination') {
    recorder.recordAttributed(
      { kind: 'memory_pressure_termination' },
      attribution,
    );
  }
  return classification;
}
