import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
import {
  UNCERTAINTY_COPY,
  uncertaintyNotes,
} from '../src/components/UncertaintyNote';
import type {
  StrokeResultEvidenceRecord,
  TemporalPhasesV2,
} from '../src/components/strokeResultModel';

/**
 * C13 — uncertainty microcopy. Each note appears ONLY when the existing
 * evidence gate already withheld the element it explains; the copy states a
 * limit and never implies unearned certainty.
 */

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
    ...overrides,
  };
}

function envelope(
  overrides: Partial<StrokeIntentEnvelope> = {},
): StrokeIntentEnvelope {
  return {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
    ...overrides,
  };
}

const confirmedContact: ContactEstimate = {
  status: 'estimated',
  estimatedContactMs: 2400,
  confidence: 0.7,
  ballConfirmed: true,
  paddleConfirmed: false,
  limitingFactors: [],
  supportingEvidence: [],
};

const segmentedPhases: TemporalPhasesV2 = {
  status: 'segmented',
  boundaries: {
    version: 'phase.paddle-temporal.v2 (heuristic, uncalibrated)',
    source: 'paddle',
    anchor: 'contact_estimate',
    confidence: 0.6,
    preparationStartMs: 2050,
    accelerationStartMs: 2200,
    contactMs: 2400,
    followThroughEndMs: 2600,
    recoveryEndMs: 2680,
  },
};

describe('uncertaintyNotes', () => {
  it('no record means no notes — nothing is asserted about unseen evidence', () => {
    expect(uncertaintyNotes({ record: null, analysis: null })).toEqual([]);
  });

  it('a fully-evidenced scored record renders no uncertainty notes', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope(),
      result: analysisFixture(),
      contact: confirmedContact,
      temporalPhasesV2: segmentedPhases,
    };
    expect(uncertaintyNotes({ record, analysis: analysisFixture() })).toEqual(
      [],
    );
  });

  it('withheld contact marker yields the honest contact line', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope(),
      result: analysisFixture(),
      contact: { status: 'abstained', reason: 'no_temporal_consensus' },
      temporalPhasesV2: segmentedPhases,
    };
    const notes = uncertaintyNotes({ record, analysis: analysisFixture() });
    expect(notes).toEqual([
      { kind: 'contact', text: UNCERTAINTY_COPY.contact },
    ]);
    expect(notes[0]?.text).toContain('Contact wasn’t located on this attempt');
  });

  it('an unconfirmed low-confidence estimate also reads as uncertain contact', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope(),
      result: analysisFixture(),
      contact: {
        ...confirmedContact,
        ballConfirmed: false,
        confidence: 0.3,
      },
      temporalPhasesV2: segmentedPhases,
    };
    expect(
      uncertaintyNotes({ record, analysis: analysisFixture() }).map(
        note => note.kind,
      ),
    ).toEqual(['contact']);
  });

  it('abstained stroke + missing phases + no score stack in fixed order', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope({
        declaredStroke: null,
        resolutionBasis: 'abstained',
        resolvedProfileId: null,
      }),
      result: null,
      contact: null,
      temporalPhasesV2: { status: 'abstained', reason: 'no_paddle_track' },
    };
    expect(
      uncertaintyNotes({ record, analysis: null }).map(note => note.kind),
    ).toEqual([
      'contact',
      'stroke_identity',
      'phase_timing',
      'technique_score',
    ]);
  });

  it('adds a capture-quality note ONLY when something was withheld AND the measured envelope was not SUPPORTED', () => {
    const degradedEnvelope = {
      thresholdsVersion: 'capture-envelope-thresholds-v0.1-provisional',
      provisional: true,
      dimensions: [
        {
          dimension: 'resolution' as const,
          status: 'DEGRADED' as const,
          measured: 640,
          unit: 'px_short_side',
          thresholdId: 'resolution.short_side.v0.1',
        },
      ],
      overall: 'DEGRADED' as const,
      overallWithCoverage: 'DEGRADED' as const,
      notMeasured: [],
    };
    // Score withheld + degraded envelope → quality note explains it.
    const withheld: StrokeResultEvidenceRecord = {
      id: 'r1',
      result: null,
      captureEnvelope: degradedEnvelope,
    };
    expect(
      uncertaintyNotes({ record: withheld, analysis: null }).map(n => n.kind),
    ).toContain('capture_quality');

    // Nothing withheld → no quality hedge on a rendered result.
    const clean: StrokeResultEvidenceRecord = {
      id: 'r2',
      result: analysisFixture(),
      contact: confirmedContact,
      temporalPhasesV2: segmentedPhases,
      captureEnvelope: degradedEnvelope,
    };
    expect(
      uncertaintyNotes({ record: clean, analysis: analysisFixture() }).map(
        n => n.kind,
      ),
    ).toEqual([]);

    // Withheld but NO measured envelope → no quality claim is invented.
    const noEnvelope: StrokeResultEvidenceRecord = { id: 'r3', result: null };
    expect(
      uncertaintyNotes({ record: noEnvelope, analysis: null }).map(n => n.kind),
    ).not.toContain('capture_quality');
  });

  it('never adds a stroke-identity note when the classifier committed', () => {
    const record: StrokeResultEvidenceRecord = {
      id: 'r1',
      strokeIntent: envelope({
        declaredStroke: null,
        resolutionBasis: 'predicted_family',
        predictedStroke: {
          taxonomyVersion: 'stroke-taxonomy-v1',
          classifierVersion: 'stroke-heuristic-2',
          label: 'FOREHAND',
          leaf: null,
          taxonomyDepth: 1,
          confidence: 0.8,
          evidence: [],
          limitingFactors: [],
        },
      }),
      result: null,
      contact: confirmedContact,
      temporalPhasesV2: segmentedPhases,
    };
    const kinds = uncertaintyNotes({ record, analysis: null }).map(
      note => note.kind,
    );
    expect(kinds).not.toContain('stroke_identity');
    expect(kinds).toContain('technique_score');
  });
});
