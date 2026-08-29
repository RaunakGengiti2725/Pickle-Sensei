import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { EnvelopeVerdict, ShotAnalysis } from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';

/**
 * STROKE RESULT view model — pure selectors for the canonical Result surface
 * (MOBBIN brief §1 hierarchy, §2 try-again loop, §4 uncertainty rules).
 *
 * HONESTY CONTRACT (hard rule): every derived element traces to a record
 * field that exists — strokeIntent, contact, temporalPhasesV2, uncertainty,
 * result-or-null. A missing field renders as an explicit "not established"
 * statement, never as an invented marker, score, label or drill.
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
 *    record carries them, the replay card lights up — until then their
 *    absence renders the honest "not established" state, never a marker.
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

export function humanizeToken(value: string): string {
  return value.replace(/_/g, ' ').trim();
}

function titleCase(value: string): string {
  const clean = humanizeToken(value).toLowerCase();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

// ─── §1.1 WHAT WAS THE STROKE — title + honest source subtitle ─────────────

export interface StrokeResultHeader {
  eyebrow: string;
  title: string;
  /** Honest source line: declared / auto-family / disagreement / abstention. */
  subtitle: string;
  /** Calm emphasis only — a disagreement is a first-class line, not an error. */
  tone: 'neutral' | 'attention';
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
    return {
      eyebrow: 'STROKE',
      title: analyzedShot ? titleCase(analyzedShot) : 'Saved stroke',
      subtitle: 'From your saved analysis on this device.',
      tone: 'neutral',
    };
  }

  switch (intent.resolutionBasis) {
    case 'declared': {
      const declared = intent.declaredStroke ?? analyzedShot ?? 'stroke';
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
      return {
        eyebrow: 'STROKE',
        title: titleCase(declared),
        subtitle: 'You chose this technique.',
        tone: 'neutral',
      };
    }
    case 'predicted_l3': {
      const leaf =
        intent.predictedStroke?.leaf ??
        (analyzedShot ? analyzedShot : 'stroke');
      return {
        eyebrow: 'AUTO-DETECTED',
        title: titleCase(leaf),
        subtitle:
          'Auto-detected by the on-device classifier — stored as a ' +
          'prediction, separate from anything you declare.',
        tone: 'neutral',
      };
    }
    case 'predicted_family': {
      const side = intent.predictedStroke?.label ?? 'UNKNOWN';
      return {
        eyebrow: 'AUTO-DETECTED · FAMILY-LEVEL',
        title: `${titleCase(side)} swing`,
        subtitle:
          'Auto-detected at family level — the exact stroke was not claimed ' +
          'because this build cannot verify it.',
        tone: 'neutral',
      };
    }
    case 'abstained':
      return {
        eyebrow: 'STROKE NOT IDENTIFIED',
        title: 'Stroke not identified',
        subtitle:
          'The classifier read the motion but would not commit to a stroke, ' +
          'so no label was invented.',
        tone: 'attention',
      };
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

// ─── §1.2 REPLAY — phase-colored segments (temporalPhasesV2 only) ───────────

export type PhaseSegmentKey =
  'preparation' | 'acceleration' | 'follow_through' | 'recovery' | 'swing';

export interface PhaseSegmentView {
  key: PhaseSegmentKey;
  startMs: number;
  endMs: number;
}

export const ANCHOR_FREE_CAPTION =
  'Timeline from motion evidence — exact contact not established.';

export type PhaseTimelinePresentation =
  | {
      kind: 'segments';
      segments: PhaseSegmentView[];
      /** Contact tick position; null in anchor-free mode (never drawn). */
      contactTickMs: number | null;
      anchorFree: boolean;
      source: 'paddle' | 'wrist';
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
    caption: anchorFree ? ANCHOR_FREE_CAPTION : null,
  };
}

// ─── §1.3 ONE INSIGHT — a single defensible sentence ────────────────────────

export interface InsightInput {
  strokeIntent?: StrokeIntentEnvelope | null;
  contact?: ContactEstimate | null;
  temporalPhasesV2?: TemporalPhasesV2 | null;
  limitingFactors?: readonly string[];
}

export interface StrokeInsight {
  basis:
    'disagreement' | 'contact_confirmation' | 'phase_timeline' | 'abstention';
  sentence: string;
}

/**
 * Exactly ONE plain-language sentence from the strongest DEFENSIBLE evidence.
 * Priority (fixed): disagreement > contact confirmation > phase timeline >
 * abstention explanation. Never a coaching tip, never fabricated.
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

  const factor = (input.limitingFactors ?? [])[0];
  if (input.strokeIntent?.resolutionBasis === 'abstained') {
    return {
      basis: 'abstention',
      sentence:
        'We couldn’t identify this stroke and didn’t guess — ' +
        (factor
          ? `the read was limited by ${humanizeToken(factor)}.`
          : 'the motion didn’t give the classifier enough to commit.'),
    };
  }
  return {
    basis: 'abstention',
    sentence: factor
      ? `We couldn’t establish ${humanizeToken(factor)} — nothing was ` +
        'invented to fill the gap.'
      : 'Nothing beyond what is shown could be established from this ' +
        'capture — nothing was invented.',
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

  const timeline = phaseTimelinePresentation(input.record?.temporalPhasesV2);
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
  const timeline = phaseTimelinePresentation(input.record?.temporalPhasesV2);
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
  for (const factor of input.record?.uncertainty?.limitingFactors ?? []) {
    notEstablished.push(titleCase(factor) + '.');
  }
  return { held, notEstablished };
}
