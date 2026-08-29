import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../src/components/StrokeResult';
import {
  strokeResultHeader,
  techniqueScoreSectionVisible,
  type StrokeResultEvidenceRecord,
} from '../src/components/strokeResultModel';

/**
 * F26 — Result surface evidence-backing audit regressions.
 *
 * Every visible Result element must trace to a record field that exists.
 * These tests pin the defects found by the claim-by-claim audit
 * (datasets/experiments/wave-f/f26-result-evidence-audit.md): each one is a
 * code path that previously rendered a provenance claim WITHOUT backing
 * evidence. Stored records are unvalidated JSON, so malformed shapes are
 * reachable at runtime even where the TypeScript types say otherwise.
 */

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a1',
    sessionId: 's1',
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

function recordWith(
  strokeIntent: StrokeIntentEnvelope | null,
): StrokeResultEvidenceRecord {
  return {
    id: 'a1',
    strokeIntent,
    result: null,
    uncertainty: {
      analysisConfidence: 0.82,
      presentation: 'normal',
      limitingFactors: [],
    },
  };
}

describe('F26 — stroke identity claims require the backing envelope field', () => {
  it('declared basis WITHOUT a recorded declaration claims no declaration', () => {
    const header = strokeResultHeader(
      recordWith(envelope({ declaredStroke: null })),
      analysisFixture(),
    );
    expect(header.subtitle).not.toContain('You chose this technique');
    expect(header.subtitle).toBe('From your saved analysis on this device.');
    // The title falls back to the analyzed shot, never an invented one.
    expect(header.title).toBe('Forehand drive');
  });

  it('declared basis with neither declaration nor analysis invents no stroke name', () => {
    const header = strokeResultHeader(
      recordWith(envelope({ declaredStroke: null })),
      null,
    );
    expect(header.title).toBe('Saved stroke');
    expect(header.subtitle).not.toContain('You chose this technique');
  });

  it('predicted_l3 WITHOUT a committed leaf never claims a leaf-level auto-detection', () => {
    const header = strokeResultHeader(
      recordWith(
        envelope({
          declaredStroke: null,
          resolutionBasis: 'predicted_l3',
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-2',
            label: 'BACKHAND',
            leaf: null,
            taxonomyDepth: 2,
            confidence: 0.7,
            evidence: [],
            limitingFactors: [],
          },
        }),
      ),
      analysisFixture(),
    );
    // The recorded family label supports exactly the family framing.
    expect(header.eyebrow).toBe('AUTO-DETECTED · FAMILY-LEVEL');
    expect(header.title).toBe('Backhand swing');
    expect(header.subtitle).toContain('the exact stroke was not claimed');
  });

  it('predicted_l3 WITHOUT any prediction record claims no auto-detection at all', () => {
    const header = strokeResultHeader(
      recordWith(
        envelope({
          declaredStroke: null,
          resolutionBasis: 'predicted_l3',
          predictedStroke: null,
        }),
      ),
      analysisFixture(),
    );
    expect(header.eyebrow).toBe('STROKE');
    expect(header.subtitle).toBe('From your saved analysis on this device.');
  });

  it('an unknown resolutionBasis from a corrupt stored row claims no provenance', () => {
    const corrupt = envelope();
    (corrupt as { resolutionBasis: string }).resolutionBasis = 'mystery_v9';
    const header = strokeResultHeader(recordWith(corrupt), analysisFixture());
    expect(header.eyebrow).toBe('STROKE');
    expect(header.subtitle).toBe('From your saved analysis on this device.');
  });
});

describe('F26 — technique-score section requires a real score', () => {
  it('visible only for scored results with a non-null overallScore', () => {
    expect(techniqueScoreSectionVisible(analysisFixture())).toBe(true);
    expect(
      techniqueScoreSectionVisible(analysisFixture({ overallScore: null })),
    ).toBe(false);
    expect(
      techniqueScoreSectionVisible(
        analysisFixture({ resultKind: 'low_confidence', overallScore: null }),
      ),
    ).toBe(false);
    expect(techniqueScoreSectionVisible(null)).toBe(false);
  });
});

describe('F26 — surface never renders an unbacked declaration claim', () => {
  it('a corrupt declared-basis record renders the honest saved-analysis line', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrokeResult
          analysis={analysisFixture()}
          record={recordWith(envelope({ declaredStroke: null }))}
          clip={null}
          currentAnalysisId="a1"
          onTryAgain={jest.fn()}
          onDone={jest.fn()}
        />,
      );
    });
    const rendered = JSON.stringify(renderer.toJSON());
    expect(rendered).not.toContain('You chose this technique.');
    expect(rendered).toContain('From your saved analysis on this device.');
    await act(async () => {
      renderer.unmount();
    });
  });
});
