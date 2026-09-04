import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type {
  EnvelopeVerdict,
  PhaseKey,
  PhaseSpan,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
// formReviewModel imports CHECKPOINT_NAMES/humanizeToken from this module;
// both sides only touch the other's exports inside function bodies, so the
// cycle is evaluation-order safe (no module-level reads either way).
import { fixList, strengthList } from '../review/formReviewModel';

/**
 * STROKE RESULT view model — pure selectors for the canonical Result surface
 * (MOBBIN brief §1 hierarchy, §2 try-again loop, §4 uncertainty rules).
 *
 * HONESTY CONTRACT (hard rule): every derived element traces to a record
 * field that exists — strokeIntent, contact, temporalPhasesV2, uncertainty,
 * result-or-null — or to a field the on-device ShotAnalysis always carries
 * (measured `phases`, `timestamps.contactMs`, scored `checkpoints`). A
 * missing field renders as an explicit "not established" statement, never as
 * an invented marker, score, label or drill.
 *
 * All functions are pure (no React, no IO) so jest pins them directly.
 */

// ─── Evidence record shape ──────────────────────────────────────────────────

/**
 * Structural mirror of swing-lab's TemporalPhaseOutcome
 * (packages/swing-lab/src/phaseTemporal.ts — @pickle/swing-lab is node-only
 * and cannot be imported by the app, same constraint W6 hit). Field-for-field
 * with the persisted JSON:
 *  - `anchorBasis === "event_peak"` is W5's anchor-free mode: NO contact
 *    boundary exists; `contactMs` is Number.NaN in-process and serializes to
 *    null in JSON, so this reader types it `number | null` and gates every
 *    use on Number.isFinite.
 */
export interface TemporalPhaseBoundariesV2 {
  version: string;
  source: 'paddle' | 'wrist';
  anchor: 'contact_estimate' | 'speed_peak';
  anchorBasis?: 'contact_estimate' | 'event_peak';
  confidence: number;
  preparationStartMs: number | null;
  accelerationStartMs: number;
  contactMs: number | null;
  motionPeakMs?: number;
  followThroughEndMs: number;
  recoveryEndMs: number | null;
}

export type TemporalPhasesV2 =
  | { status: 'segmented'; boundaries: TemporalPhaseBoundariesV2 }
  | { status: 'abstained'; reason: string };

/**
 * The evidence a Stroke Result can consume. Structurally satisfied by a
 * persisted CaptureAnalysisRecord; every evidence field is OPTIONAL because
 * stored records are heterogeneous:
 *  - records written before the D-031 pipeline change lack `strokeIntent`
 *    (W4 risk note: stored-record readers must treat it as optional);
 *  - today's on-device fusion records carry NO `contact`/`temporalPhasesV2`
 *    (those are produced by the offline/lab evidence chain); when a future
 *    record carries them, the replay card prefers them. Until then the
 *    replay strip reads the analysis' own measured `phases`
 *    (effectivePhaseTimeline), and the exact-contact marker stays honest:
 *    the wrist-speed peak is drawn as a phase tick, never as a confirmed
 *    strike marker.
 */
export interface StrokeResultEvidenceRecord {
  id: string;
  captureId?: string;
  createdAtIso?: string;
  strokeIntent?: StrokeIntentEnvelope | null;
  result?: ShotAnalysis | null;
  uncertainty?: {
    analysisConfidence?: number;
    presentation?: string;
    limitingFactors?: string[];
  } | null;
  contact?: ContactEstimate | null;
  temporalPhasesV2?: TemporalPhasesV2 | null;
  /**
   * Capture-envelope verdict measured for this attempt (canonical
   * shared-types contract). Optional: records written before the envelope
   * integration lack it, and its absence never invents a quality claim.
   */
  captureEnvelope?: EnvelopeVerdict | null;
}

// ─── Stored-record validation ───────────────────────────────────────────────

type UnknownRecord = Record<string, unknown>;

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

/** Absent (`undefined`) fields pass; present ones must satisfy the guard. */
function optional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

function nullable(guard: (value: unknown) => boolean) {
  return (value: unknown): boolean => value === null || guard(value);
}

function isStrokeIntentShape(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value['resolutionBasis'])) {
    return false;
  }
  const predicted = value['predictedStroke'];
  if (
    !optional(
      predicted,
      nullable(
        candidate =>
          isPlainObject(candidate) &&
          isString(candidate['label']) &&
          optional(candidate['leaf'], nullable(isString)),
      ),
    )
  ) {
    return false;
  }
  return (
    optional(value['declaredStroke'], nullable(isString)) &&
    optional(value['resolvedProfileId'], nullable(isString)) &&
    optional(value['resolvedProfileVersion'], nullable(isString)) &&
    optional(
      value['disagreement'],
      nullable(
        candidate =>
          isPlainObject(candidate) &&
          isString(candidate['declared']) &&
          isString(candidate['predictedLabel']),
      ),
    )
  );
}

/**
 * The ShotAnalysis fields the Result surface reads from a stored
 * `record.result`. The stroke window and shot type are dereferenced
 * unconditionally, so they must be present; every other field is checked
 * only when the row carries it (older rows may lack later additions).
 */
function isShotAnalysisShape(value: unknown): boolean {
  if (!isPlainObject(value) || !isString(value['shotType'])) return false;
  const timestamps = value['timestamps'];
  if (
    !isPlainObject(timestamps) ||
    !isFiniteNumber(timestamps['startMs']) ||
    !isFiniteNumber(timestamps['endMs']) ||
    !optional(timestamps['contactMs'], nullable(isFiniteNumber))
  ) {
    return false;
  }
  return (
    optional(value['id'], isString) &&
    optional(value['sessionId'], nullable(isString)) &&
    optional(value['capturedAtIso'], isString) &&
    optional(value['phases'], Array.isArray) &&
    optional(value['checkpoints'], Array.isArray) &&
    optional(
      value['measurements'],
      candidate =>
        Array.isArray(candidate) &&
        candidate.every(
          measurement =>
            isPlainObject(measurement) &&
            isString(measurement['metricKey']) &&
            isFiniteNumber(measurement['value']) &&
            isString(measurement['unit']),
        ),
    ) &&
    optional(value['overallScore'], nullable(isFiniteNumber)) &&
    optional(value['analysisConfidence'], isFiniteNumber) &&
    optional(value['resultKind'], isString) &&
    optional(value['guidance'], nullable(isString)) &&
    optional(
      value['priorityFix'],
      nullable(
        candidate =>
          isPlainObject(candidate) && isString(candidate['checkpoint']),
      ),
    )
  );
}

function isUncertaintyShape(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    optional(value['analysisConfidence'], isFiniteNumber) &&
    optional(value['presentation'], isString) &&
    optional(value['limitingFactors'], isStringArray)
  );
}

function isContactEstimateShape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  switch (value['status']) {
    case 'estimated':
      return (
        isFiniteNumber(value['estimatedContactMs']) &&
        isFiniteNumber(value['confidence']) &&
        isBoolean(value['ballConfirmed']) &&
        isBoolean(value['paddleConfirmed'])
      );
    case 'abstained':
      return isString(value['reason']);
    default:
      return false;
  }
}

function isTemporalPhasesV2Shape(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  switch (value['status']) {
    case 'abstained':
      return isString(value['reason']);
    case 'segmented': {
      const b = value['boundaries'];
      return (
        isPlainObject(b) &&
        (b['source'] === 'paddle' || b['source'] === 'wrist') &&
        optional(
          b['anchorBasis'],
          basis => basis === 'contact_estimate' || basis === 'event_peak',
        ) &&
        optional(b['confidence'], isFiniteNumber) &&
        nullable(isFiniteNumber)(b['preparationStartMs']) &&
        isFiniteNumber(b['accelerationStartMs']) &&
        nullable(isFiniteNumber)(b['contactMs']) &&
        optional(b['motionPeakMs'], isFiniteNumber) &&
        isFiniteNumber(b['followThroughEndMs']) &&
        nullable(isFiniteNumber)(b['recoveryEndMs'])
      );
    }
    default:
      return false;
  }
}

function isEnvelopeVerdictShape(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    isString(value['overall']) &&
    optional(value['thresholdsVersion'], isString) &&
    optional(value['provisional'], isBoolean) &&
    optional(value['dimensions'], Array.isArray) &&
    optional(value['overallWithCoverage'], isString) &&
    optional(value['notMeasured'], Array.isArray)
  );
}

/**
 * Structural check for a parsed `local_analysis_record` row. Rows are
 * heterogeneous (pre-strokeIntent rows exist and later engines add fields),
 * so every envelope field is optional — but a field that IS present must
 * hold its declared type, and the parsed value must be a record object at
 * all. Anything else is a corrupt row: the caller skips it (null) so the
 * surface shows its honest "not established" fallbacks. Nothing is coerced,
 * defaulted or repaired — the same object comes back, merely proven to be
 * what the type says it is.
 */
export function asStrokeResultEvidenceRecord(
  value: unknown,
): StrokeResultEvidenceRecord | null {
  if (!isPlainObject(value) || !isString(value['id'])) return null;
  const wellTyped =
    optional(value['captureId'], isString) &&
    optional(value['createdAtIso'], isString) &&
    optional(value['strokeIntent'], nullable(isStrokeIntentShape)) &&
    optional(value['result'], nullable(isShotAnalysisShape)) &&
    optional(value['uncertainty'], nullable(isUncertaintyShape)) &&
    optional(value['contact'], nullable(isContactEstimateShape)) &&
    optional(value['temporalPhasesV2'], nullable(isTemporalPhasesV2Shape)) &&
    optional(value['captureEnvelope'], nullable(isEnvelopeVerdictShape));
  return wellTyped ? (value as unknown as StrokeResultEvidenceRecord) : null;
}

export function humanizeToken(value: string): string {
  return value.replace(/_/g, ' ').trim();
}

function titleCase(value: string): string {
  const clean = humanizeToken(value).toLowerCase();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

/** Canonical display names for scoring checkpoints (shared by the Result
 * screen's stroke map and the limiting-factor copy below). */
export const CHECKPOINT_NAMES: Record<string, string> = {
  ready_position: 'Ready position',
  athletic_base: 'Athletic base',
  preparation: 'Preparation',
  paddle_set: 'Paddle set',
  swing_length: 'Swing length',
  sequencing: 'Sequencing',
  paddle_path: 'Paddle path',
  contact_position: 'Contact position',
  face_wrist_stability: 'Face / wrist stability',
  follow_through: 'Follow-through',
  recovery: 'Recovery',
};

function checkpointName(key: string): string {
  return CHECKPOINT_NAMES[key] ?? humanizeToken(key);
}

/**
 * Human copy for one uncertainty limiting-factor token. The pipeline emits
 * machine tokens (`paddle_track_unavailable`,
 * `checkpoint_unobserved:<key>`, …); rendering them raw produced broken
 * sentences ("We couldn’t establish paddle track unavailable",
 * "Checkpoint unobserved:face wrist stability"). Each known token maps to:
 *  - `noun` — the object of "We couldn’t establish …";
 *  - `reason` — the object of "the read was limited by …";
 *  - `ledger` — a full line for the WHAT WE COULDN’T ESTABLISH list, or
 *    null when the ledger already states it (never duplicated).
 * Unknown tokens fall back to plain humanization — never dropped.
 */
export interface LimitingFactorCopy {
  noun: string;
  reason: string;
  ledger: string | null;
}

export function limitingFactorCopy(factor: string): LimitingFactorCopy {
  if (factor.startsWith('checkpoint_unobserved:')) {
    const name = checkpointName(factor.slice('checkpoint_unobserved:'.length));
    return {
      noun: `a read on the ${name.toLowerCase()} checkpoint`,
      reason: `an unobserved ${name.toLowerCase()} checkpoint`,
      ledger: `The ${name.toLowerCase()} checkpoint — not observed in this clip.`,
    };
  }
  switch (factor) {
    case 'paddle_track_unavailable':
      return {
        noun: 'a paddle track',
        reason: 'a missing paddle track',
        ledger: 'A paddle track for this swing.',
      };
    case 'ball_track_unavailable':
      return {
        noun: 'a ball track',
        reason: 'a missing ball track',
        ledger: 'A ball track for this swing.',
      };
    case 'court_geometry_unavailable':
      return {
        noun: 'court geometry',
        reason: 'missing court geometry',
        ledger: 'Court geometry for this camera view.',
      };
    case 'analysis_confidence_below_threshold':
      return {
        noun: 'enough confidence to score this stroke',
        reason: 'analysis confidence below the scoring threshold',
        ledger: 'Enough analysis confidence to clear the scoring threshold.',
      };
    case 'auto_stroke_resolved_at_side_depth_no_leaf_for_scoring':
      return {
        noun: 'the exact stroke inside that family',
        reason: 'a family-level read without the exact stroke',
        // The ledger already reports the family-depth gap as its own line.
        ledger: null,
      };
    default:
      return {
        noun: humanizeToken(factor),
        reason: humanizeToken(factor),
        ledger: `${titleCase(factor.replace(/:/g, ' — '))}.`,
      };
  }
}

/** True when a limiting-factor token has dedicated human copy (unknown
 * tokens read acceptably only in the "limited by" form). */
function knownLimitingFactor(factor: string): boolean {
  return (
    factor.startsWith('checkpoint_unobserved:') ||
    [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
      'analysis_confidence_below_threshold',
      'auto_stroke_resolved_at_side_depth_no_leaf_for_scoring',
    ].includes(factor)
  );
}

/**
 * Structural modality tokens. This version of the engine tracks 13 body
 * joints and NO paddle, ball or court lines (packages/scoring config/v1
 * measures the paddle-side checkpoints at the hitting wrist), so EVERY
 * record carries these three tokens. They describe the engine's scope, not
 * a per-analysis gap: the surface never phrases them as something this
 * capture failed to establish, and never picks one as the ONE insight.
 */
export const MODALITY_SCOPE_FACTORS = [
  'paddle_track_unavailable',
  'ball_track_unavailable',
  'court_geometry_unavailable',
] as const;

export function isModalityScopeFactor(token: string): boolean {
  return (MODALITY_SCOPE_FACTORS as readonly string[]).includes(token);
}

/** Calm scope footnote shown once, in place of per-token modality lines. */
export const MEASUREMENT_SCOPE_NOTE =
  'Measured from 13 tracked body joints. Paddle-side checkpoints use your ' +
  'hitting wrist; the paddle, ball and court lines are not tracked in this ' +
  'version.';

// ─── §1.1 WHAT WAS THE STROKE — title + honest source subtitle ─────────────

export interface StrokeResultHeader {
  eyebrow: string;
  title: string;
  /** Honest source line: declared / auto-family / disagreement / abstention. */
  subtitle: string;
  /** Calm emphasis only — a disagreement is a first-class line, not an error. */
  tone: 'neutral' | 'attention';
}

function savedAnalysisHeader(analyzedShot: string | null): StrokeResultHeader {
  return {
    eyebrow: 'STROKE',
    title: analyzedShot ? titleCase(analyzedShot) : 'Saved stroke',
    subtitle: 'From your saved analysis on this device.',
    tone: 'neutral',
  };
}

function familyHeader(side: string): StrokeResultHeader {
  return {
    eyebrow: 'AUTO-DETECTED · FAMILY-LEVEL',
    title: `${titleCase(side)} swing`,
    subtitle:
      'Auto-detected at family level — the exact stroke was not claimed ' +
      'because this build cannot verify it.',
    tone: 'neutral',
  };
}

export function strokeResultHeader(
  record: StrokeResultEvidenceRecord | null,
  analysis: ShotAnalysis | null,
): StrokeResultHeader {
  const intent = record?.strokeIntent ?? null;
  const analyzedShot = analysis?.shotType ?? record?.result?.shotType ?? null;

  if (!intent) {
    // Record predates the strokeIntent envelope (or only the product rating
    // row survived). No provenance is claimed that was not recorded.
    return savedAnalysisHeader(analyzedShot);
  }

  switch (intent.resolutionBasis) {
    case 'declared': {
      const declared = intent.declaredStroke;
      if (intent.disagreement) {
        return {
          eyebrow: 'DECLARED · CAMERA READ DIFFERS',
          title: titleCase(intent.disagreement.declared),
          subtitle:
            `Predicted ${intent.disagreement.predictedLabel} — differs from ` +
            `your declared ${humanizeToken(intent.disagreement.declared)}. ` +
            'Both records are kept; neither overwrites the other.',
          tone: 'attention',
        };
      }
      // A "declared" basis without a recorded declaration carries no
      // declaration evidence — no provenance is claimed for it.
      if (!declared) return savedAnalysisHeader(analyzedShot);
      return {
        eyebrow: 'STROKE',
        title: titleCase(declared),
        subtitle: 'You chose this technique.',
        tone: 'neutral',
      };
    }
    case 'predicted_l3': {
      const leaf = intent.predictedStroke?.leaf ?? null;
      if (!leaf) {
        // No committed leaf exists: a classifier claim would be unbacked.
        // A recorded family label supports the family framing; otherwise
        // no auto-detection provenance is claimed at all.
        const side = intent.predictedStroke?.label ?? null;
        return side && side !== 'UNKNOWN'
          ? familyHeader(side)
          : savedAnalysisHeader(analyzedShot);
      }
      return {
        eyebrow: 'AUTO-DETECTED',
        title: titleCase(leaf),
        subtitle:
          'Auto-detected by the on-device classifier — stored as a ' +
          'prediction, separate from anything you declare.',
        tone: 'neutral',
      };
    }
    case 'predicted_family':
      return familyHeader(intent.predictedStroke?.label ?? 'UNKNOWN');
    case 'abstained':
      return {
        eyebrow: 'STROKE NOT IDENTIFIED',
        title: 'Stroke not identified',
        subtitle:
          'The classifier read the motion but would not commit to a stroke, ' +
          'so no label was invented.',
        tone: 'attention',
      };
    default:
      // Stored records are unvalidated JSON: an unknown basis claims nothing.
      return savedAnalysisHeader(analyzedShot);
  }
}

// ─── §1.2 REPLAY — contact marker (usable-result-v1 gate) ───────────────────

export const CONTACT_MARKER_MIN_UNCONFIRMED_CONFIDENCE = 0.6;

/**
 * Uncertainty halo half-width in ms, scaled by contact confidence — §4:
 * confidence is shown as visual weight, never as a raw decimal. Bounds echo
 * the usable-result-v1 frame conventions (±33ms ≈ 1 frame @30fps floor,
 * ±165ms ceiling for a barely-admitted estimate).
 */
export function contactHaloHalfWidthMs(confidence: number): number {
  const clamped = Math.min(1, Math.max(0, confidence));
  return Math.round(33 + (1 - clamped) * 132);
}

export type ContactMarkerPresentation =
  | {
      kind: 'marker';
      contactMs: number;
      haloHalfWidthMs: number;
      confirmation: 'ball_and_paddle' | 'ball' | 'paddle' | 'motion';
      /** Qualitative evidence label (no raw decimals — brief §4). */
      caption: string;
    }
  | {
      kind: 'not_established';
      /** The honest line shown instead of a marker. */
      caption: string;
    };

/**
 * usable-result-v1 marker gate: a contact marker is drawn ONLY when
 * `contact.status === "estimated"` AND
 * (ballConfirmed || paddleConfirmed || confidence ≥ 0.6).
 * Abstention — or an unconfirmed low-confidence estimate — draws NO marker;
 * a misleading marker is worse than none (contract clause 5).
 */
export function contactMarkerPresentation(
  contact: ContactEstimate | null | undefined,
): ContactMarkerPresentation {
  if (!contact) {
    return {
      kind: 'not_established',
      caption:
        'Exact contact not established — no contact estimate was recorded ' +
        'for this stroke.',
    };
  }
  if (contact.status === 'abstained') {
    return {
      kind: 'not_established',
      caption: `Exact contact not established — ${humanizeToken(
        contact.reason,
      )}.`,
    };
  }
  const defensible =
    contact.ballConfirmed ||
    contact.paddleConfirmed ||
    contact.confidence >= CONTACT_MARKER_MIN_UNCONFIRMED_CONFIDENCE;
  if (!defensible || !Number.isFinite(contact.estimatedContactMs)) {
    return {
      kind: 'not_established',
      caption:
        'Exact contact not established — the estimate lacked confirming ' +
        'evidence, so no marker is drawn.',
    };
  }
  const confirmation =
    contact.ballConfirmed && contact.paddleConfirmed
      ? 'ball_and_paddle'
      : contact.ballConfirmed
        ? 'ball'
        : contact.paddleConfirmed
          ? 'paddle'
          : 'motion';
  const caption = {
    ball_and_paddle: 'Ball + paddle confirmed',
    ball: 'Ball-confirmed',
    paddle: 'Paddle-confirmed',
    motion: 'Motion evidence only',
  }[confirmation];
  return {
    kind: 'marker',
    contactMs: contact.estimatedContactMs,
    haloHalfWidthMs: contactHaloHalfWidthMs(contact.confidence),
    confirmation,
    caption,
  };
}

// ─── §1.2 REPLAY — phase-colored segments (record OR measured analysis) ─────

export type PhaseSegmentKey =
  'preparation' | 'acceleration' | 'follow_through' | 'recovery' | 'swing';

export interface PhaseSegmentView {
  key: PhaseSegmentKey;
  startMs: number;
  endMs: number;
}

export const ANCHOR_FREE_CAPTION =
  'Timeline from motion evidence — exact contact not established.';

/** Caption for a timeline read from the analysis' own measured phases. */
export const ANALYSIS_TIMELINE_CAPTION =
  'Timeline from measured wrist motion — contact marks the wrist-speed peak.';

export type PhaseTimelinePresentation =
  | {
      kind: 'segments';
      segments: PhaseSegmentView[];
      /** Contact tick position; null in anchor-free mode (never drawn). */
      contactTickMs: number | null;
      anchorFree: boolean;
      source: 'paddle' | 'wrist';
      /**
       * Which evidence the strip was read from: the lab-chain
       * `temporalPhasesV2` record or the on-device analysis' `phases`. The
       * legend names the analysis tick "contact (wrist peak)".
       */
      origin: 'record' | 'analysis';
      /** Motion-evidence caption, required in anchor-free mode. */
      caption: string | null;
    }
  | { kind: 'none'; reason: string | null };

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Phase strip renders ONLY when temporalPhasesV2.status === "segmented" with
 * valid boundary ordering. Anchor-free mode (W5, anchorBasis "event_peak")
 * renders WITHOUT a contact tick and with the motion-evidence caption;
 * contactMs may be null (JSON) or NaN (in-process) and is never used for
 * arithmetic in that mode.
 */
export function phaseTimelinePresentation(
  phases: TemporalPhasesV2 | null | undefined,
): PhaseTimelinePresentation {
  if (!phases) return { kind: 'none', reason: null };
  if (phases.status === 'abstained') {
    return { kind: 'none', reason: humanizeToken(phases.reason) };
  }
  const b = phases.boundaries;
  const anchorFree = b.anchorBasis === 'event_peak';
  if (!anchorFree && !finite(b.contactMs)) {
    // An anchored timeline without a finite contact boundary is malformed;
    // showing it would fabricate structure the record does not carry.
    return { kind: 'none', reason: 'phase boundaries incomplete' };
  }

  const mid = anchorFree
    ? finite(b.motionPeakMs)
      ? b.motionPeakMs
      : null
    : (b.contactMs as number);
  const ordered: number[] = [
    ...(finite(b.preparationStartMs) ? [b.preparationStartMs] : []),
    b.accelerationStartMs,
    ...(mid !== null ? [mid] : []),
    b.followThroughEndMs,
    ...(finite(b.recoveryEndMs) ? [b.recoveryEndMs] : []),
  ];
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1];
    const current = ordered[i];
    if (previous === undefined || current === undefined || current < previous) {
      return { kind: 'none', reason: 'phase boundaries out of order' };
    }
  }

  const segments: PhaseSegmentView[] = [];
  const push = (key: PhaseSegmentKey, startMs: number, endMs: number) => {
    if (endMs > startMs) segments.push({ key, startMs, endMs });
  };
  if (finite(b.preparationStartMs)) {
    push('preparation', b.preparationStartMs, b.accelerationStartMs);
  }
  if (mid !== null) {
    push('acceleration', b.accelerationStartMs, mid);
    push('follow_through', mid, b.followThroughEndMs);
  } else {
    push('swing', b.accelerationStartMs, b.followThroughEndMs);
  }
  if (finite(b.recoveryEndMs)) {
    push('recovery', b.followThroughEndMs, b.recoveryEndMs);
  }
  if (segments.length === 0) {
    return { kind: 'none', reason: 'phase boundaries incomplete' };
  }
  return {
    kind: 'segments',
    segments,
    contactTickMs: anchorFree ? null : (b.contactMs as number),
    anchorFree,
    source: b.source,
    origin: 'record',
    caption: anchorFree ? ANCHOR_FREE_CAPTION : null,
  };
}

/** Analysis phase → strip segment. `ready` and `contact` are not segments:
 * ready is the pre-swing stance, contact is the tick drawn over the strip. */
const ANALYSIS_SEGMENT_KEY: Partial<Record<PhaseKey, PhaseSegmentKey>> = {
  prepare: 'preparation',
  accelerate: 'acceleration',
  follow_through: 'follow_through',
  recover: 'recovery',
};

/** Phase spans with finite bounds, first occurrence per key, in record order. */
function measuredPhaseSpans(
  analysis: ShotAnalysis | null | undefined,
): PhaseSpan[] {
  const raw = Array.isArray(analysis?.phases) ? analysis.phases : [];
  const seen = new Set<string>();
  const spans: PhaseSpan[] = [];
  for (const span of raw) {
    if (!span || typeof span.key !== 'string' || seen.has(span.key)) continue;
    if (!finite(span.startMs) || !finite(span.endMs)) continue;
    if (span.endMs < span.startMs) continue;
    seen.add(span.key);
    spans.push(span);
  }
  return spans;
}

/**
 * The analysis' own contact estimate, in clip-relative ms: the measured
 * contact span's representative frame (the wrist-speed peak the on-device
 * segmenter cuts phases around), else `timestamps.contactMs` (the same peak
 * as recorded by the stroke trigger), else null. Never interpolated.
 */
export function analysisContactMs(
  analysis: ShotAnalysis | null | undefined,
): number | null {
  if (!analysis) return null;
  const contact = measuredPhaseSpans(analysis).find(
    span => span.key === 'contact',
  );
  if (contact && finite(contact.representativeMs)) {
    return contact.representativeMs;
  }
  const recorded = analysis.timestamps?.contactMs;
  return finite(recorded) ? recorded : null;
}

/**
 * Phase strip from the on-device analysis' MEASURED phases (every scored
 * ShotAnalysis carries them — packages/vision-geometry phaseSegmenter cuts
 * them at wrist-speed landmarks). Renders only when at least two spans have
 * finite, non-overlapping times in order; a missing prepare/recover simply
 * yields fewer segments. The contact tick is the wrist-speed peak, so the
 * caption names it as such — the paddle is not tracked, and nothing here
 * claims a paddle- or ball-confirmed strike.
 */
export function phaseTimelineFromAnalysis(
  analysis: ShotAnalysis | null | undefined,
): PhaseTimelinePresentation {
  const spans = measuredPhaseSpans(analysis);
  if (spans.length < 2) return { kind: 'none', reason: null };
  for (let i = 1; i < spans.length; i += 1) {
    const previous = spans[i - 1];
    const current = spans[i];
    if (!previous || !current || current.startMs < previous.endMs) {
      return { kind: 'none', reason: 'phase spans out of order' };
    }
  }

  const segments: PhaseSegmentView[] = [];
  for (const span of spans) {
    const key = ANALYSIS_SEGMENT_KEY[span.key];
    if (key && span.endMs > span.startMs) {
      segments.push({ key, startMs: span.startMs, endMs: span.endMs });
    }
  }
  if (segments.length === 0) return { kind: 'none', reason: null };

  const contactTickMs = analysisContactMs(analysis);
  return {
    kind: 'segments',
    segments,
    contactTickMs,
    anchorFree: contactTickMs === null,
    source: 'wrist',
    origin: 'analysis',
    caption:
      contactTickMs === null ? ANCHOR_FREE_CAPTION : ANALYSIS_TIMELINE_CAPTION,
  };
}

/**
 * The ONE phase timeline a Result surface draws: the lab-chain
 * `temporalPhasesV2` record when it segments (richer provenance), else the
 * analysis' measured phases. When neither yields segments, an explicit
 * record abstention reason wins over the analysis' silence.
 */
export function effectivePhaseTimeline(
  record: StrokeResultEvidenceRecord | null | undefined,
  analysis: ShotAnalysis | null | undefined,
): PhaseTimelinePresentation {
  const recorded = phaseTimelinePresentation(record?.temporalPhasesV2);
  if (recorded.kind === 'segments') return recorded;
  const measured = phaseTimelineFromAnalysis(
    analysis ?? record?.result ?? null,
  );
  if (measured.kind === 'segments') return measured;
  return recorded.reason !== null ? recorded : measured;
}

// ─── §1.3 ONE INSIGHT — a single defensible sentence ────────────────────────

export interface InsightInput {
  strokeIntent?: StrokeIntentEnvelope | null;
  contact?: ContactEstimate | null;
  temporalPhasesV2?: TemporalPhasesV2 | null;
  limitingFactors?: readonly string[];
  /**
   * The scored analysis, when one exists. Its measured checkpoints are the
   * strongest evidence a scored result carries and outrank the lab-chain
   * contact/timeline records (which today's on-device records never hold).
   */
  analysis?: ShotAnalysis | null;
}

export interface StrokeInsight {
  basis:
    | 'disagreement'
    | 'measured_fault'
    | 'measured_clean'
    | 'contact_confirmation'
    | 'phase_timeline'
    | 'abstention';
  sentence: string;
}

/**
 * ONE plain-language insight (two short sentences at most) from the
 * strongest DEFENSIBLE evidence. Priority (fixed): disagreement > scored
 * analysis (measured fault, else every checkpoint clean) > contact
 * confirmation > phase timeline > abstention explanation. The scored branch
 * reads the engine's own checkpoint numbers through the form-review model,
 * so the headline states a measured fact and the cue matches the measured
 * direction — never a guess. Structural modality tokens (no paddle/ball/
 * court tracker in this version) are never chosen as the insight.
 */
export function selectInsight(input: InsightInput): StrokeInsight {
  const disagreement = input.strokeIntent?.disagreement ?? null;
  if (disagreement) {
    return {
      basis: 'disagreement',
      sentence:
        `You declared ${humanizeToken(disagreement.declared)} and the ` +
        `camera read ${disagreement.predictedLabel} — both records are ` +
        'kept, and neither overwrote the other.',
    };
  }

  const analysis = input.analysis ?? null;
  if (techniqueScoreSectionVisible(analysis)) {
    const [fault] = fixList(analysis, 1);
    if (fault) {
      return {
        basis: 'measured_fault',
        sentence: `${fault.headline}. ${fault.cue}`,
      };
    }
    const [strongest] = strengthList(analysis, 1);
    if (strongest) {
      return {
        basis: 'measured_clean',
        sentence:
          'Every measured checkpoint held its target — strongest was ' +
          `${strongest.name} at ${Math.round(strongest.score)}.`,
      };
    }
    // A scored result whose checkpoints carry no readable score claims
    // nothing about them; the remaining evidence chain decides.
  }

  const marker = contactMarkerPresentation(input.contact);
  if (marker.kind === 'marker') {
    const sentence = {
      ball_and_paddle:
        'Contact was confirmed by ball and paddle evidence, so the replay ' +
        'marker is trustworthy.',
      ball: 'Contact was confirmed by ball-track evidence on the replay.',
      paddle: 'Contact was confirmed by paddle-track evidence on the replay.',
      motion:
        'Contact was estimated from motion evidence alone — the replay ' +
        'marker carries a wider uncertainty halo.',
    }[marker.confirmation];
    return { basis: 'contact_confirmation', sentence };
  }

  const timeline = phaseTimelinePresentation(input.temporalPhasesV2);
  if (timeline.kind === 'segments') {
    return {
      basis: 'phase_timeline',
      sentence: timeline.anchorFree
        ? 'Your swing timeline was measured from motion evidence, but the ' +
          'exact contact moment was not established.'
        : `Your swing phases were measured from ${timeline.source} motion — ` +
          'see the timeline under the replay.',
    };
  }

  // Modality tokens are the engine's scope, not this capture's failure: the
  // first PER-ANALYSIS limiting factor (if any) explains the abstention.
  const factor = (input.limitingFactors ?? []).find(
    token => !isModalityScopeFactor(token),
  );
  if (input.strokeIntent?.resolutionBasis === 'abstained') {
    return {
      basis: 'abstention',
      sentence:
        'We couldn’t identify this stroke and didn’t guess — ' +
        (factor
          ? `the read was limited by ${limitingFactorCopy(factor).reason}.`
          : 'the motion didn’t give the classifier enough to commit.'),
    };
  }
  if (!factor) {
    return {
      basis: 'abstention',
      sentence:
        'Nothing beyond what is shown could be established from this ' +
        'capture — nothing was invented.',
    };
  }
  return {
    basis: 'abstention',
    sentence: knownLimitingFactor(factor)
      ? `We couldn’t establish ${limitingFactorCopy(factor).noun} — ` +
        'nothing was invented to fill the gap.'
      : 'We couldn’t establish a clean read — this attempt was limited by ' +
        `${humanizeToken(factor)}. Nothing was invented to fill the gap.`,
  };
}

// ─── §1.4 MEASURED ROWS — provenance-labeled, collapse >4 ───────────────────

export type MeasurementProvenance =
  'DETECTED' | 'ESTIMATE' | 'MEASURED' | 'PREDICTED';

export interface MeasuredRowView {
  key: string;
  label: string;
  value: string;
  provenance: MeasurementProvenance;
}

function formatMs(value: number): string {
  return `${Math.round(value)}ms`;
}

export function measuredRows(input: {
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
}): MeasuredRowView[] {
  const rows: MeasuredRowView[] = [];
  const analysis = input.analysis ?? input.record?.result ?? null;

  if (analysis) {
    rows.push({
      key: 'stroke_window',
      label: 'Stroke window',
      value: `${formatMs(analysis.timestamps.startMs)} – ${formatMs(
        analysis.timestamps.endMs,
      )}`,
      provenance: 'DETECTED',
    });
  }

  const marker = contactMarkerPresentation(input.record?.contact);
  if (marker.kind === 'marker') {
    rows.push({
      key: 'contact_estimate',
      label: 'Contact estimate',
      value: `${formatMs(marker.contactMs)} · ${marker.caption.toLowerCase()}`,
      provenance: 'ESTIMATE',
    });
  }

  // ONE phase row, from whichever evidence the replay strip draws (record
  // first, else the analysis' measured phases) — never both.
  const timeline = effectivePhaseTimeline(input.record, analysis);
  if (timeline.kind === 'segments') {
    rows.push({
      key: 'phase_timeline',
      label: 'Swing phases',
      value: `${timeline.segments.length} measured from ${timeline.source} motion`,
      provenance: 'MEASURED',
    });
  }

  const predicted = input.record?.strokeIntent?.predictedStroke ?? null;
  if (predicted && predicted.label !== 'UNKNOWN') {
    rows.push({
      key: 'predicted_stroke',
      label: 'Classifier read',
      value: `${titleCase(predicted.leaf ?? predicted.label)}${
        predicted.leaf ? '' : ' (family)'
      }`,
      provenance: 'PREDICTED',
    });
  }

  for (const measurement of analysis?.measurements ?? []) {
    rows.push({
      key: `measurement:${measurement.metricKey}`,
      label: titleCase(measurement.metricKey),
      value:
        measurement.unit === 'ms'
          ? formatMs(measurement.value)
          : `${Number(measurement.value.toFixed(2))} ${humanizeToken(
              measurement.unit,
            )}`,
      provenance: 'MEASURED',
    });
  }
  return rows;
}

export const MEASURED_ROWS_COLLAPSED_COUNT = 4;

export function visibleMeasuredRows(
  rows: readonly MeasuredRowView[],
  expanded: boolean,
): { visible: MeasuredRowView[]; hiddenCount: number } {
  if (expanded || rows.length <= MEASURED_ROWS_COLLAPSED_COUNT) {
    return { visible: [...rows], hiddenCount: 0 };
  }
  return {
    visible: rows.slice(0, MEASURED_ROWS_COLLAPSED_COUNT),
    hiddenCount: rows.length - MEASURED_ROWS_COLLAPSED_COUNT,
  };
}

// ─── §2 Attempt chips — navigate, NEVER rank ────────────────────────────────

export interface AttemptRef {
  analysisId: string;
  capturedAtIso: string;
  sessionId: string | null;
}

export interface AttemptChipView {
  analysisId: string;
  label: string;
  isCurrent: boolean;
}

/**
 * Attempts of the SAME session, in capture order, labeled Attempt 1…N.
 * Chips navigate between attempts and never rank or compare them —
 * cross-attempt metric comparison is BLOCKED_ON_VALIDATION (brief §2), so no
 * score, delta or ordering-by-quality ever enters this mapping. A null
 * sessionId groups with nothing: no cross-session grouping is invented.
 */
export function attemptChips(
  attempts: readonly AttemptRef[],
  currentAnalysisId: string,
): AttemptChipView[] {
  const current = attempts.find(
    attempt => attempt.analysisId === currentAnalysisId,
  );
  if (!current || current.sessionId === null) return [];
  return attempts
    .filter(attempt => attempt.sessionId === current.sessionId)
    .sort((a, b) =>
      a.capturedAtIso === b.capturedAtIso
        ? a.analysisId.localeCompare(b.analysisId)
        : a.capturedAtIso.localeCompare(b.capturedAtIso),
    )
    .map((attempt, index) => ({
      analysisId: attempt.analysisId,
      label: `Attempt ${index + 1}`,
      isCurrent: attempt.analysisId === currentAnalysisId,
    }));
}

// ─── §4 Abstention ledger — what held / what we couldn't establish ─────────

export interface AbstentionLedger {
  held: string[];
  notEstablished: string[];
  /**
   * MEASUREMENT_SCOPE_NOTE when the record carried any structural modality
   * token (paddle / ball / court not tracked in this version), else null.
   * Rendered once as a calm footnote — never as "couldn't establish" lines.
   */
  scope: string | null;
}

/** True when this record/analysis pair is an honest abstention surface. */
export function isAbstainedResult(
  record: StrokeResultEvidenceRecord | null,
  analysis: ShotAnalysis | null,
): boolean {
  const effective = analysis ?? record?.result ?? null;
  if (record && (record.result ?? null) === null && !analysis) return true;
  if (effective) {
    return effective.resultKind !== 'scored' || effective.overallScore === null;
  }
  return record !== null;
}

/**
 * The technique-score section (score ring, priority fix, stroke map,
 * version trace) renders ONLY when a real score exists:
 * `resultKind === "scored"` with a non-null overallScore. A scored
 * kind whose score is null is an abstention surface (isAbstainedResult) and
 * must not simultaneously present a score stage.
 */
export function techniqueScoreSectionVisible(
  analysis: ShotAnalysis | null,
): analysis is ShotAnalysis & { overallScore: number } {
  return (
    analysis !== null &&
    analysis.resultKind === 'scored' &&
    analysis.overallScore !== null
  );
}

export function abstentionLedger(input: {
  record: StrokeResultEvidenceRecord | null;
  analysis: ShotAnalysis | null;
  clipPresent: boolean;
}): AbstentionLedger {
  const held: string[] = [];
  const notEstablished: string[] = [];
  const analysis = input.analysis ?? input.record?.result ?? null;
  const intent = input.record?.strokeIntent ?? null;

  if (input.clipPresent) {
    held.push('The clip was captured and stays on this device.');
  }
  if (analysis) {
    held.push(
      `A stroke window was detected (${formatMs(
        analysis.timestamps.startMs,
      )} – ${formatMs(analysis.timestamps.endMs)}).`,
    );
  }
  if (intent?.resolutionBasis === 'predicted_family') {
    const side = intent.predictedStroke?.label ?? 'UNKNOWN';
    held.push(
      `The classifier committed to the ${side.toLowerCase()} swing family.`,
    );
  }
  if (intent?.resolutionBasis === 'declared' && intent.declaredStroke) {
    held.push(
      `Your declaration (${humanizeToken(intent.declaredStroke)}) was kept.`,
    );
  }
  const timeline = effectivePhaseTimeline(input.record, analysis);
  if (timeline.kind === 'segments') {
    held.push('Swing phases were measured from real motion.');
  }
  const marker = contactMarkerPresentation(input.record?.contact);
  if (marker.kind === 'marker') {
    held.push('A defensible contact estimate was made.');
  }

  if (intent?.resolutionBasis === 'abstained') {
    notEstablished.push('Which stroke this was.');
  } else if (intent?.resolutionBasis === 'predicted_family') {
    notEstablished.push('The exact stroke inside that family.');
  }
  if (marker.kind === 'not_established') {
    notEstablished.push('The exact contact moment.');
  }
  if (timeline.kind === 'none') {
    notEstablished.push('Phase timing for this swing.');
  }
  const effective = analysis;
  if (!effective || effective.overallScore === null) {
    notEstablished.push(
      'A technique score — scoring stays withheld rather than invented.',
    );
  }
  let scope: string | null = null;
  for (const factor of input.record?.uncertainty?.limitingFactors ?? []) {
    if (isModalityScopeFactor(factor)) {
      // The engine's scope, stated once as a footnote — not a gap this
      // capture could have closed.
      scope = MEASUREMENT_SCOPE_NOTE;
      continue;
    }
    const line = limitingFactorCopy(factor).ledger;
    if (line && !notEstablished.includes(line)) notEstablished.push(line);
  }
  return { held, notEstablished, scope };
}
