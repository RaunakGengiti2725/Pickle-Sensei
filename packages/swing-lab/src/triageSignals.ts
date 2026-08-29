import type { EvaluationTrialRecord } from "@pickle/shared-types";

/**
 * PRODUCTION TRIAGE SIGNALS — triage-signal-v1.
 *
 * Machine-detectable inconsistency patterns over uploaded evaluation-trial
 * records that suggest a POSSIBLE silent failure worth human triage. A
 * TriageSignal is a routing hint for the labeling queue and NOTHING ELSE:
 *
 *   - A signal is NEVER a verdict. Correct/wrong is decided off-device by
 *     humans labeling against gold (freshUserTrials.ts / silentFailure.ts).
 *   - A signal is NEVER auto-converted into a TrialLabel, a gold label, or a
 *     silent-failure event count. The types here are deliberately disjoint
 *     from TrialLabel/TrialClaimLabel so no code path can coerce one into
 *     the other.
 *   - Absence of signals is NOT evidence of correctness — these detectors
 *     only see what the device recorded.
 *
 * Detectors are pure functions over trial records; session-scoped detectors
 * group by dims.sessionId and skip trials with a null sessionId (an unknown
 * session is never merged into a pseudo-session).
 */

export const TRIAGE_SIGNAL_CONTRACT_VERSION = "triage-signal-v1";

export const TRIAGE_SIGNAL_KINDS = [
  "HIGH_CONFIDENCE_CONTRADICTORY_MODALITIES",
  "DECLARED_PREDICTED_MISMATCH",
  "TARGET_IDENTITY_INSTABILITY",
  "CONTACT_OUTSIDE_EVENT_BOUNDS",
  "CONTACT_WITHOUT_PADDLE_EVIDENCE",
  "IMPOSSIBLE_PHASE_ORDERING",
  "CLASSIFIER_OSCILLATION",
  "DEGRADED_CAPTURE_CONFIDENT_ANALYSIS",
  "IMPOSSIBLE_SESSION_EVENT_DENSITY",
  "RAPID_REPEATED_RETRIES",
] as const;
export type TriageSignalKind = (typeof TRIAGE_SIGNAL_KINDS)[number];

export interface TriageSignal {
  kind: TriageSignalKind;
  /** Every trial implicated by the signal (one for per-trial detectors). */
  trialIds: string[];
  /** Session scope for session-level detectors; null for per-trial ones. */
  sessionId: string | null;
  detail: string;
  detectorVersion: typeof TRIAGE_SIGNAL_CONTRACT_VERSION;
}

/** Thresholds are named constants so changes are visible diffs, not magic. */
export const TRIAGE_THRESHOLDS = {
  /** analysisConfidence at or above this counts as "very confident". */
  highConfidence: 0.8,
  /** Cross-modality contact disagreement beyond the silent-failure-v1
   * fabricated-marker bound (132ms) is contradictory, not just noisy. */
  modalityContactDisagreementMs: 132,
  /** Minimum status flips of the target lock within a session. */
  targetInstabilityMinFlips: 2,
  /** Minimum consecutive label changes to call oscillation (A→B→A). */
  oscillationMinAlternations: 2,
  /** More scored trials than this inside the density window is implausible
   * for a single human hitting strokes (one stroke ≥ ~2s of play). */
  densityWindowMs: 60_000,
  densityMaxTrialsPerWindow: 30,
  /** Same capture retried this many times within the retry window. */
  retryMinCount: 3,
  retryWindowMs: 60_000,
} as const;

const signal = (
  kind: TriageSignalKind,
  trialIds: string[],
  sessionId: string | null,
  detail: string,
): TriageSignal => ({
  kind,
  trialIds,
  sessionId,
  detail,
  detectorVersion: TRIAGE_SIGNAL_CONTRACT_VERSION,
});

const l1Side = (label: string): string =>
  label.includes("BACKHAND") ? "BACKHAND" : label.includes("FOREHAND") ? "FOREHAND" : label;

const capturedMs = (trial: EvaluationTrialRecord): number => Date.parse(trial.capturedAtIso);

/** Trials sorted by capture time; non-parseable timestamps sort last and are
 * excluded from time-window detectors rather than guessed. */
function bySession(trials: EvaluationTrialRecord[]): Map<string, EvaluationTrialRecord[]> {
  const groups = new Map<string, EvaluationTrialRecord[]>();
  for (const trial of trials) {
    const sessionId = trial.dims.sessionId;
    if (sessionId === null) continue;
    const group = groups.get(sessionId) ?? [];
    group.push(trial);
    groups.set(sessionId, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => capturedMs(a) - capturedMs(b));
  }
  return groups;
}

/** Very confident analysis whose own modalities contradict each other: the
 * phase timeline and the contact marker disagree on the contact moment by
 * more than the fabricated-marker bound. */
export function detectHighConfidenceContradictoryModalities(
  trial: EvaluationTrialRecord,
): TriageSignal | null {
  const { resultScore, contactMarker, phaseRender } = trial.claims;
  if (resultScore.status !== "presented" || resultScore.presentation !== "normal") return null;
  const confidence = resultScore.analysisConfidence;
  if (confidence === null || confidence < TRIAGE_THRESHOLDS.highConfidence) return null;
  if (contactMarker.status !== "presented" || phaseRender.status !== "presented") return null;
  if (contactMarker.estimatedContactMs === null || phaseRender.contactMs === null) return null;
  const disagreementMs = Math.abs(contactMarker.estimatedContactMs - phaseRender.contactMs);
  if (disagreementMs <= TRIAGE_THRESHOLDS.modalityContactDisagreementMs) return null;
  return signal(
    "HIGH_CONFIDENCE_CONTRADICTORY_MODALITIES",
    [trial.trialId],
    trial.dims.sessionId,
    `analysisConfidence ${confidence.toFixed(2)} presented normal, but contact marker (${contactMarker.estimatedContactMs}ms) and phase timeline contact (${phaseRender.contactMs}ms) disagree by ${Math.round(disagreementMs)}ms > ${TRIAGE_THRESHOLDS.modalityContactDisagreementMs}ms`,
  );
}

/** The user declared one stroke intent, the classifier confidently presented
 * a label on the other L1 side. Either could be wrong — that is triage. */
export function detectDeclaredPredictedMismatch(trial: EvaluationTrialRecord): TriageSignal | null {
  const declared = trial.declaredStroke;
  const { strokeLabel } = trial.claims;
  if (declared === null || strokeLabel.status !== "presented" || strokeLabel.label === null) {
    return null;
  }
  const declaredSide = l1Side(declared.toUpperCase());
  const predictedSide = l1Side(strokeLabel.label.toUpperCase());
  if (declaredSide !== "FOREHAND" && declaredSide !== "BACKHAND") return null;
  if (predictedSide !== "FOREHAND" && predictedSide !== "BACKHAND") return null;
  if (declaredSide === predictedSide) return null;
  return signal(
    "DECLARED_PREDICTED_MISMATCH",
    [trial.trialId],
    trial.dims.sessionId,
    `declared ${declared} (L1 ${declaredSide}) but presented label ${strokeLabel.label} (L1 ${predictedSide})`,
  );
}

/** Within one session the target lock flip-flops between presented and
 * abstained — the identity pipeline cannot hold a stable answer. */
export function detectTargetIdentityInstability(trials: EvaluationTrialRecord[]): TriageSignal[] {
  const signals: TriageSignal[] = [];
  for (const [sessionId, group] of bySession(trials)) {
    const measured = group.filter((trial) => trial.claims.targetLock.status !== "not_measured");
    let flips = 0;
    const flipped: EvaluationTrialRecord[] = [];
    for (let i = 1; i < measured.length; i++) {
      const prev = measured[i - 1]!;
      const curr = measured[i]!;
      if (prev.claims.targetLock.status !== curr.claims.targetLock.status) {
        flips++;
        if (flipped.length === 0) flipped.push(prev);
        flipped.push(curr);
      }
    }
    if (flips >= TRIAGE_THRESHOLDS.targetInstabilityMinFlips) {
      signals.push(
        signal(
          "TARGET_IDENTITY_INSTABILITY",
          flipped.map((trial) => trial.trialId),
          sessionId,
          `target lock status flipped ${flips} times across ${measured.length} measured trials in session ${sessionId}`,
        ),
      );
    }
  }
  return signals;
}

/** A contact marker presented outside the presented event-selection window
 * — the two claims cannot both be right. */
export function detectContactOutsideEventBounds(trial: EvaluationTrialRecord): TriageSignal | null {
  const { contactMarker, eventSelection } = trial.claims;
  if (contactMarker.status !== "presented" || eventSelection.status !== "presented") return null;
  const contactMs = contactMarker.estimatedContactMs;
  const { startMs, endMs } = eventSelection;
  if (contactMs === null || startMs === null || endMs === null) return null;
  if (contactMs >= startMs && contactMs <= endMs) return null;
  return signal(
    "CONTACT_OUTSIDE_EVENT_BOUNDS",
    [trial.trialId],
    trial.dims.sessionId,
    `contact marker ${contactMs}ms lies outside presented event bounds ${startMs}–${endMs}ms`,
  );
}

/** A contact marker presented with no target-owned paddle evidence (and no
 * ball confirmation either) — the marker rests on nothing verifiable. */
export function detectContactWithoutPaddleEvidence(
  trial: EvaluationTrialRecord,
): TriageSignal | null {
  const { contactMarker } = trial.claims;
  if (contactMarker.status !== "presented") return null;
  if (contactMarker.paddleConfirmed || contactMarker.ballConfirmed) return null;
  return signal(
    "CONTACT_WITHOUT_PADDLE_EVIDENCE",
    [trial.trialId],
    trial.dims.sessionId,
    "contact marker presented with paddleConfirmed=false and ballConfirmed=false — no target-owned paddle (or ball) evidence backs the marker",
  );
}

/** A rendered phase timeline whose ordering is physically impossible
 * (followThroughEnd at or before contact). */
export function detectImpossiblePhaseOrdering(trial: EvaluationTrialRecord): TriageSignal | null {
  const { phaseRender } = trial.claims;
  if (phaseRender.status !== "presented") return null;
  const { contactMs, followThroughEndMs } = phaseRender;
  if (contactMs === null || followThroughEndMs === null) return null;
  if (followThroughEndMs > contactMs) return null;
  return signal(
    "IMPOSSIBLE_PHASE_ORDERING",
    [trial.trialId],
    trial.dims.sessionId,
    `phase timeline presented with followThroughEnd ${followThroughEndMs}ms <= contact ${contactMs}ms — physically impossible ordering`,
  );
}

/** Within one session the classifier alternates between L1 sides on
 * consecutive presented labels (A→B→A…) — an unstable classifier, not a
 * player switching styles every single stroke. */
export function detectClassifierOscillation(trials: EvaluationTrialRecord[]): TriageSignal[] {
  const signals: TriageSignal[] = [];
  for (const [sessionId, group] of bySession(trials)) {
    const labeled = group.filter((trial) => {
      const { status, label } = trial.claims.strokeLabel;
      if (status !== "presented" || label === null) return false;
      const side = l1Side(label.toUpperCase());
      return side === "FOREHAND" || side === "BACKHAND";
    });
    let alternations = 0;
    const involved: EvaluationTrialRecord[] = [];
    for (let i = 2; i < labeled.length; i++) {
      const a = l1Side(labeled[i - 2]!.claims.strokeLabel.label!.toUpperCase());
      const b = l1Side(labeled[i - 1]!.claims.strokeLabel.label!.toUpperCase());
      const c = l1Side(labeled[i]!.claims.strokeLabel.label!.toUpperCase());
      if (a !== b && b !== c && a === c) {
        alternations++;
        for (const trial of [labeled[i - 2]!, labeled[i - 1]!, labeled[i]!]) {
          if (!involved.includes(trial)) involved.push(trial);
        }
      }
    }
    if (alternations >= TRIAGE_THRESHOLDS.oscillationMinAlternations) {
      signals.push(
        signal(
          "CLASSIFIER_OSCILLATION",
          involved.map((trial) => trial.trialId),
          sessionId,
          `stroke L1 side alternated A→B→A ${alternations} times across ${labeled.length} labeled trials in session ${sessionId}`,
        ),
      );
    }
  }
  return signals;
}

/** The capture envelope said DEGRADED/UNSUPPORTED yet the analysis presented
 * a normal-confidence Result with very high confidence — confidence that the
 * capture quality cannot support. */
export function detectDegradedCaptureConfidentAnalysis(
  trial: EvaluationTrialRecord,
): TriageSignal | null {
  if (trial.envelopeOverall !== "DEGRADED" && trial.envelopeOverall !== "UNSUPPORTED") return null;
  const { resultScore } = trial.claims;
  if (resultScore.status !== "presented" || resultScore.presentation !== "normal") return null;
  const confidence = resultScore.analysisConfidence;
  if (confidence === null || confidence < TRIAGE_THRESHOLDS.highConfidence) return null;
  return signal(
    "DEGRADED_CAPTURE_CONFIDENT_ANALYSIS",
    [trial.trialId],
    trial.dims.sessionId,
    `capture envelope ${trial.envelopeOverall} but Result presented normal with analysisConfidence ${confidence.toFixed(2)} >= ${TRIAGE_THRESHOLDS.highConfidence}`,
  );
}

/** More trials inside one sliding window of a session than a human can
 * physically produce strokes — duplicated, replayed, or misattributed
 * captures. */
export function detectImpossibleSessionEventDensity(
  trials: EvaluationTrialRecord[],
): TriageSignal[] {
  const signals: TriageSignal[] = [];
  for (const [sessionId, group] of bySession(trials)) {
    const timed = group.filter((trial) => Number.isFinite(capturedMs(trial)));
    for (let start = 0; start < timed.length; start++) {
      const windowEnd = capturedMs(timed[start]!) + TRIAGE_THRESHOLDS.densityWindowMs;
      let end = start;
      while (end + 1 < timed.length && capturedMs(timed[end + 1]!) <= windowEnd) end++;
      const count = end - start + 1;
      if (count > TRIAGE_THRESHOLDS.densityMaxTrialsPerWindow) {
        signals.push(
          signal(
            "IMPOSSIBLE_SESSION_EVENT_DENSITY",
            timed.slice(start, end + 1).map((trial) => trial.trialId),
            sessionId,
            `${count} trials within ${TRIAGE_THRESHOLDS.densityWindowMs / 1000}s in session ${sessionId} exceeds plausible maximum ${TRIAGE_THRESHOLDS.densityMaxTrialsPerWindow}`,
          ),
        );
        break;
      }
    }
  }
  return signals;
}

/** The same capture analyzed again and again in quick succession — the user
 * is fighting the product (or an upload loop is stuck). */
export function detectRapidRepeatedRetries(trials: EvaluationTrialRecord[]): TriageSignal[] {
  const signals: TriageSignal[] = [];
  const byCapture = new Map<string, EvaluationTrialRecord[]>();
  for (const trial of trials) {
    const group = byCapture.get(trial.captureId) ?? [];
    group.push(trial);
    byCapture.set(trial.captureId, group);
  }
  for (const [captureId, group] of byCapture) {
    const timed = group
      .filter((trial) => Number.isFinite(capturedMs(trial)))
      .sort((a, b) => Date.parse(a.recordedAtIso) - Date.parse(b.recordedAtIso));
    for (let start = 0; start + TRIAGE_THRESHOLDS.retryMinCount - 1 < timed.length; start++) {
      const end = start + TRIAGE_THRESHOLDS.retryMinCount - 1;
      const spanMs =
        Date.parse(timed[end]!.recordedAtIso) - Date.parse(timed[start]!.recordedAtIso);
      if (Number.isFinite(spanMs) && spanMs <= TRIAGE_THRESHOLDS.retryWindowMs) {
        signals.push(
          signal(
            "RAPID_REPEATED_RETRIES",
            timed.slice(start, end + 1).map((trial) => trial.trialId),
            timed[start]!.dims.sessionId,
            `capture ${captureId} re-analyzed ${TRIAGE_THRESHOLDS.retryMinCount} times within ${Math.round(spanMs / 1000)}s (<= ${TRIAGE_THRESHOLDS.retryWindowMs / 1000}s window)`,
          ),
        );
        break;
      }
    }
  }
  return signals;
}

const PER_TRIAL_DETECTORS: ReadonlyArray<(trial: EvaluationTrialRecord) => TriageSignal | null> = [
  detectHighConfidenceContradictoryModalities,
  detectDeclaredPredictedMismatch,
  detectContactOutsideEventBounds,
  detectContactWithoutPaddleEvidence,
  detectImpossiblePhaseOrdering,
  detectDegradedCaptureConfidentAnalysis,
];

const CROSS_TRIAL_DETECTORS: ReadonlyArray<(trials: EvaluationTrialRecord[]) => TriageSignal[]> = [
  detectTargetIdentityInstability,
  detectClassifierOscillation,
  detectImpossibleSessionEventDensity,
  detectRapidRepeatedRetries,
];

export interface TriageSignalSummary {
  contractVersion: typeof TRIAGE_SIGNAL_CONTRACT_VERSION;
  /** Explicit reminder carried into every report that consumes this. */
  disposition: "route_to_human_triage_never_labels";
  signals: TriageSignal[];
  countsByKind: Record<TriageSignalKind, number>;
}

/** Run every detector over the trial set. Output routes trials to human
 * triage; it is never a label, a verdict, or a silent-failure count. */
export function detectTriageSignals(trials: EvaluationTrialRecord[]): TriageSignalSummary {
  const signals: TriageSignal[] = [];
  for (const trial of trials) {
    for (const detector of PER_TRIAL_DETECTORS) {
      const result = detector(trial);
      if (result !== null) signals.push(result);
    }
  }
  for (const detector of CROSS_TRIAL_DETECTORS) {
    signals.push(...detector(trials));
  }
  const countsByKind = Object.fromEntries(TRIAGE_SIGNAL_KINDS.map((kind) => [kind, 0])) as Record<
    TriageSignalKind,
    number
  >;
  for (const item of signals) countsByKind[item.kind]++;
  return {
    contractVersion: TRIAGE_SIGNAL_CONTRACT_VERSION,
    disposition: "route_to_human_triage_never_labels",
    signals,
    countsByKind,
  };
}
