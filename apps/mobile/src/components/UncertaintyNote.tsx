import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  analysisContactMs,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  type StrokeResultEvidenceRecord,
} from './strokeResultModel';

/**
 * Uncertainty microcopy for Result surfaces — honest, human sentences about
 * what this attempt could NOT establish (MOBBIN brief §4). Copy states the
 * limit of the evidence and never implies a certainty that does not exist:
 * no hedged score, no "approximate" marker, no softened prediction — and,
 * just as strictly, no "couldn't measure" claim about something the
 * analysis DID measure (its phases, its wrist-peak contact estimate).
 *
 * The selectors here are read-only consumers of the existing evidence gates
 * (contactMarkerPresentation, effectivePhaseTimeline, analysisContactMs,
 * strokeIntent); they never change what those gates admit or draw.
 */

export const UNCERTAINTY_KINDS = [
  'contact',
  'contact_estimate',
  'stroke_identity',
  'phase_timing',
  'technique_score',
  'capture_quality',
] as const;
export type UncertaintyKind = (typeof UNCERTAINTY_KINDS)[number];

export const UNCERTAINTY_COPY: Record<UncertaintyKind, string> = {
  contact:
    'Contact wasn’t located on this attempt, so no contact marker is shown.',
  contact_estimate:
    'Contact is estimated from your wrist-speed peak — the paddle and ball ' +
    'are not tracked, so the exact strike frame may differ by a frame or two.',
  stroke_identity:
    'This stroke couldn’t be identified, so no label was applied.',
  phase_timing:
    'We couldn’t measure the phase timing of this swing, so no timeline is ' +
    'shown.',
  technique_score:
    'A technique score wasn’t established for this attempt — scoring stays ' +
    'withheld rather than estimated.',
  capture_quality:
    'The measured capture quality was below the supported range on this ' +
    'attempt, which can limit what the analysis could establish.',
};

export interface UncertaintyNoteView {
  kind: UncertaintyKind;
  text: string;
}

/**
 * The uncertainty notes this record honestly supports, in fixed order. Each
 * note appears ONLY when the corresponding evidence gate already withheld
 * the element it explains — a note about a rendered element would itself be
 * a false statement.
 */
export function uncertaintyNotes(input: {
  record: StrokeResultEvidenceRecord | null;
  analysis: ShotAnalysis | null;
}): UncertaintyNoteView[] {
  const notes: UncertaintyNoteView[] = [];
  const record = input.record;
  if (!record) return notes;
  const analysis = input.analysis ?? record.result ?? null;

  if (contactMarkerPresentation(record.contact).kind === 'not_established') {
    // No defensible (ball/paddle/high-confidence) contact marker. When the
    // record carries no contact estimate at all but the analysis measured a
    // wrist-speed peak, that peak IS the contact estimate on the surface —
    // the note names its limit instead of denying it exists.
    const wristPeak =
      (record.contact ?? null) === null && analysisContactMs(analysis) !== null;
    notes.push(
      wristPeak
        ? { kind: 'contact_estimate', text: UNCERTAINTY_COPY.contact_estimate }
        : { kind: 'contact', text: UNCERTAINTY_COPY.contact },
    );
  }
  if (record.strokeIntent?.resolutionBasis === 'abstained') {
    notes.push({
      kind: 'stroke_identity',
      text: UNCERTAINTY_COPY.stroke_identity,
    });
  }
  // Phase timing is "not measured" ONLY when neither the record nor the
  // analysis yields a timeline — the same gate the replay strip draws by.
  if (effectivePhaseTimeline(record, analysis).kind === 'none') {
    notes.push({ kind: 'phase_timing', text: UNCERTAINTY_COPY.phase_timing });
  }
  const scoreWithheld = !analysis || analysis.overallScore === null;
  if (scoreWithheld) {
    notes.push({
      kind: 'technique_score',
      text: UNCERTAINTY_COPY.technique_score,
    });
  }
  // Quality context appears ONLY when something was withheld: the note
  // explains an abstention, it never hedges a rendered element. It reads
  // the measured envelope verdict — absence of a verdict says nothing.
  const envelopeOverall = record.captureEnvelope?.overall;
  if (
    notes.length > 0 &&
    (envelopeOverall === 'DEGRADED' || envelopeOverall === 'UNSUPPORTED')
  ) {
    notes.push({
      kind: 'capture_quality',
      text: UNCERTAINTY_COPY.capture_quality,
    });
  }
  return notes;
}

/** One honest uncertainty sentence, styled as a calm note (never an error). */
export function UncertaintyNote(props: { text: string }) {
  return (
    <View
      style={styles.note}
      accessibilityRole="text"
      accessibilityLabel="Uncertainty note"
    >
      <Icon name="shield" color={color.inkSoft} size={15} />
      <Text style={[type.caption, styles.text]}>{props.text}</Text>
    </View>
  );
}

/** The full uncertainty block for a Result surface; renders nothing when clean. */
export function UncertaintyNotes(props: {
  record: StrokeResultEvidenceRecord | null;
  analysis: ShotAnalysis | null;
}) {
  const notes = uncertaintyNotes(props);
  if (notes.length === 0) return null;
  return (
    <View style={styles.block}>
      {notes.map(note => (
        <UncertaintyNote key={note.kind} text={note.text} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm, marginTop: space.md },
  note: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
  },
  text: { color: color.inkSoft, flex: 1 },
});
