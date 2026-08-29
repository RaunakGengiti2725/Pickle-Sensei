import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import {
  SHARED_SIDE_PROFILES_V1,
  TECHNIQUE_ANALYSIS_PROFILES_V1,
  type ShotAnalysis,
} from '@pickle/shared-types';
import { StrokeResult } from '../src/components/StrokeResult';
import {
  isAbstainedResult,
  techniqueScoreSectionVisible,
  type StrokeResultEvidenceRecord,
} from '../src/components/strokeResultModel';

/**
 * H04 — coach-validation lock audit (coach-gates-frozen-v1, gate L1 + user
 * surfaces). Technique scoring, fault diagnosis, and drill recommendation are
 * BLOCKED_ON_VALIDATION until real coach evidence exists. These tests fail if
 * any code path lets a fake score, fault call-out, or drill recommendation
 * leak onto the stroke-result surface — even when the underlying analysis
 * object carries a deterministic sm-v1 score and a machine-ranked priorityFix.
 */

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a1',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: 2400, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: 42,
        confidence: 0.9,
        band: 'red',
        direction: 'late',
        severity: 0.58,
        applicable: true,
      },
    ],
    overallScore: 7.4,
    analysisConfidence: 0.92,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'worst_weighted_checkpoint',
      severity: 0.58,
      confidence: 0.9,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
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

function recordFixture(): StrokeResultEvidenceRecord {
  return {
    id: 'a1',
    strokeIntent: envelope(),
    result: null,
    uncertainty: {
      analysisConfidence: 0.92,
      presentation: 'normal',
      limitingFactors: [],
    },
  };
}

async function renderStrokeResult(
  analysis: ShotAnalysis | null,
): Promise<string> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <StrokeResult
        analysis={analysis}
        record={recordFixture()}
        clip={null}
        currentAnalysisId="a1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
  });
  return JSON.stringify(renderer.toJSON());
}

describe('H04 — production profiles stay locked (gate L1 on the mobile bundle)', () => {
  it('every TechniqueAnalysisProfile keeps score/fault/drill blocked', () => {
    for (const profile of Object.values(TECHNIQUE_ANALYSIS_PROFILES_V1)) {
      expect(profile.techniqueEvaluator).toBe('BLOCKED_ON_VALIDATION');
      expect(profile.faultTaxonomyVersion).toBe('pending-expert-program');
      expect(profile.drillMappingVersion).toBe('none');
      expect(profile.abstentionPolicy).toBe('abstain-over-invent');
    }
  });

  it('every SharedSideProfile keeps score/fault/drill blocked', () => {
    for (const profile of Object.values(SHARED_SIDE_PROFILES_V1)) {
      expect(profile.techniqueEvaluator).toBe('BLOCKED_ON_VALIDATION');
      expect(profile.faultTaxonomyVersion).toBe('pending-expert-program');
      expect(profile.drillMappingVersion).toBe('none');
      expect(profile.abstentionPolicy).toBe('abstain-over-invent');
    }
  });
});

describe('H04 — no drill or coach-style fault leaks onto the stroke-result surface', () => {
  it('a scored analysis with a machine-ranked priorityFix renders NO drill and NO fault call-out', async () => {
    const rendered = await renderStrokeResult(analysisFixture());
    // The reserved focus+drill slot must stay empty until coach validation.
    expect(rendered.toLowerCase()).not.toContain('drill');
    expect(rendered.toLowerCase()).not.toContain('fault');
    expect(rendered).not.toContain('Primary focus');
    // The machine ranking must not surface as a diagnosis on this surface.
    expect(rendered).not.toContain('contact_position');
  });

  it('an abstained analysis renders no score and no invented coaching', async () => {
    const abstained = analysisFixture({
      overallScore: null,
      resultKind: 'low_confidence',
      priorityFix: null,
    });
    const rendered = await renderStrokeResult(abstained);
    expect(rendered).not.toContain('7.4');
    expect(rendered.toLowerCase()).not.toContain('drill');
    expect(techniqueScoreSectionVisible(abstained)).toBe(false);
    expect(isAbstainedResult(null, abstained)).toBe(true);
  });

  it('score visibility requires resultKind=scored AND a non-null score — nothing else unlocks it', () => {
    expect(techniqueScoreSectionVisible(analysisFixture())).toBe(true);
    expect(
      techniqueScoreSectionVisible(analysisFixture({ overallScore: null })),
    ).toBe(false);
    expect(
      techniqueScoreSectionVisible(
        analysisFixture({ resultKind: 'low_confidence' }),
      ),
    ).toBe(false);
    expect(techniqueScoreSectionVisible(null)).toBe(false);
  });
});
