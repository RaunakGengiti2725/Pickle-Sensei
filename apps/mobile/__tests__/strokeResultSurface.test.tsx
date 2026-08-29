import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import {
  StrokeResult,
  StrokeResultAnalyzing,
} from '../src/components/StrokeResult';
import {
  ANCHOR_FREE_CAPTION,
  type StrokeResultEvidenceRecord,
} from '../src/components/strokeResultModel';

/**
 * W8 — canonical StrokeResult surface (ONE component, consumed by both the
 * Stroke Analysis result route and Session event cards). These tests pin
 * the honest-evidence gating at the rendered level: no marker without the
 * usable-result-v1 gate, no phase strip without segmented temporalPhasesV2,
 * no invented score, abstention as a designed state with a retry path.
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

const declaredRecord: StrokeResultEvidenceRecord = {
  id: 'analysis-1',
  captureId: 'capture-1',
  strokeIntent: {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  },
  result: null,
  uncertainty: {
    analysisConfidence: 0.82,
    presentation: 'normal',
    limitingFactors: [],
  },
};

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

describe('StrokeResult — scored declared run', () => {
  it('renders the brief §1 hierarchy: title, honest source, replay, ONE insight, rows, CTA', async () => {
    const onTryAgain = jest.fn();
    const onDone = jest.fn();
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={declaredRecord}
        clip={{ uri: 'file:///clip.mov', durationMs: 4200 }}
        currentAnalysisId="analysis-1"
        onTryAgain={onTryAgain}
        onDone={onDone}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('Forehand drive');
    expect(rendered).toContain('You chose this technique.');
    expect(rendered).toContain('MEASURED INSIGHT');
    // Today's on-device records carry no contact estimate: the replay shows
    // the honest line and draws NO marker.
    expect(rendered).toContain('Exact contact not established');
    expect(
      renderer.root.findAll(
        node =>
          typeof node.props.accessibilityLabel === 'string' &&
          node.props.accessibilityLabel.startsWith('Contact marker'),
      ),
    ).toHaveLength(0);
    // Stroke window row with DETECTED provenance.
    expect(rendered).toContain('Stroke window');
    expect(rendered).toContain('DETECTED');
    // The component itself never renders a score — scoring surfaces are the
    // caller's validated sections; nothing here says "out of 10".
    expect(rendered).not.toContain('out of 10');

    const [tryAgain] = renderer.root.findAll(
      node => node.props.testID === 'stroke-result-try-again',
    );
    await act(async () => {
      tryAgain!.props.onPress();
    });
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    const [done] = renderer.root.findAll(
      node => node.props.testID === 'stroke-result-done',
    );
    await act(async () => {
      done!.props.onPress();
    });
    expect(onDone).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('shows a defensible contact marker with its confirmation as visual weight (no raw decimals)', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={{
          ...declaredRecord,
          contact: {
            status: 'estimated',
            estimatedContactMs: 2400,
            confidence: 0.5,
            ballConfirmed: true,
            paddleConfirmed: false,
            limitingFactors: [],
            supportingEvidence: [],
          },
        }}
        clip={{ uri: 'file:///clip.mov', durationMs: 4200 }}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const markers = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Contact marker, Ball-confirmed',
    );
    expect(markers.length).toBe(1);
    // §4: confidence is visual weight (halo width), never a raw number.
    expect(textOf(renderer)).not.toContain('50%');
    expect(textOf(renderer)).not.toContain('confidence 0.5');
    await unmount(renderer);
  });

  it('renders the anchor-free phase strip WITHOUT a contact tick and WITH the motion-evidence caption', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={{
          ...declaredRecord,
          temporalPhasesV2: {
            status: 'segmented',
            boundaries: {
              version:
                'phase.paddle-temporal.v2.1 (anchor-free: timeline from motion evidence — exact contact not established)',
              source: 'wrist',
              anchor: 'speed_peak',
              anchorBasis: 'event_peak',
              confidence: 0.32,
              preparationStartMs: 2050,
              accelerationStartMs: 2200,
              contactMs: null,
              motionPeakMs: 2380,
              followThroughEndMs: 2600,
              recoveryEndMs: 2680,
            },
          },
        }}
        clip={{ uri: 'file:///clip.mov', durationMs: 4200 }}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain(ANCHOR_FREE_CAPTION);
    expect(rendered).toContain('PREP');
    expect(rendered).toContain('ACCEL');
    // No contact legend item and no contact tick in anchor-free mode.
    expect(rendered).not.toContain('"CONTACT"');
    await unmount(renderer);
  });
});

describe('StrokeResult — honest abstention (same layout)', () => {
  it('family-level AUTO read with result:null shows what held / what could not be established, replay and retry stay', async () => {
    const familyRecord: StrokeResultEvidenceRecord = {
      id: 'analysis-2',
      captureId: 'capture-2',
      strokeIntent: {
        declaredStroke: null,
        predictedStroke: {
          taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
          classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
          label: 'FOREHAND',
          leaf: null,
          taxonomyDepth: 2,
          confidence: 0.6,
          evidence: [],
          limitingFactors: [],
        },
        resolutionBasis: 'predicted_family',
        resolvedProfileId: 'SHARED_FOREHAND_SWING',
        resolvedProfileVersion: 'shared-side-profile-v1',
        disagreement: null,
      },
      result: null,
      uncertainty: {
        analysisConfidence: 0,
        presentation: 'abstain',
        limitingFactors: ['paddle_track_missing'],
      },
    };
    const renderer = await render(
      <StrokeResult
        analysis={null}
        record={familyRecord}
        clip={{ uri: 'file:///clip2.mov', durationMs: 3800 }}
        currentAnalysisId="analysis-2"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('Forehand swing');
    expect(rendered).toContain('AUTO-DETECTED · FAMILY-LEVEL');
    expect(rendered).toContain('WHAT HELD');
    expect(rendered).toContain('WHAT WE COULDN’T ESTABLISH');
    expect(rendered).toContain('forehand swing family');
    expect(rendered).toContain('The exact stroke inside that family.');
    // Replay still shown; retry CTA present; nothing scored or invented.
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'stroke-result-replay',
      ).length,
    ).toBe(1);
    expect(
      renderer.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.testID === 'stroke-result-try-again',
      ).length,
    ).toBeGreaterThan(0);
    expect(rendered).not.toContain('out of 10');
    expect(rendered).not.toContain('score of');
    await unmount(renderer);
  });
});

describe('StrokeResult — attempt chips (§2)', () => {
  const attempts = [
    {
      analysisId: 'a1',
      capturedAtIso: '2026-08-30T10:00:00Z',
      sessionId: 's1',
    },
    {
      analysisId: 'a2',
      capturedAtIso: '2026-08-30T10:05:00Z',
      sessionId: 's1',
    },
    {
      analysisId: 'a3',
      capturedAtIso: '2026-08-30T10:09:00Z',
      sessionId: 's1',
    },
  ];

  it('renders chronological chips that navigate — never rank', async () => {
    const onOpenAttempt = jest.fn();
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture({ id: 'a2', sessionId: 's1' })}
        record={null}
        clip={null}
        attempts={attempts}
        currentAnalysisId="a2"
        onOpenAttempt={onOpenAttempt}
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('Attempt 1');
    expect(rendered).toContain('Attempt 2');
    expect(rendered).toContain('Attempt 3');
    // No comparison/ranking language exists on the surface.
    expect(rendered).not.toContain('best');
    expect(rendered).not.toContain('improved');
    expect(rendered).not.toContain('vs.');

    const [firstChip] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Attempt 1' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      firstChip!.props.onPress();
    });
    expect(onOpenAttempt).toHaveBeenCalledWith('a1');
    await unmount(renderer);
  });

  it('renders no chip row for a solo attempt', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={null}
        clip={null}
        attempts={[
          {
            analysisId: 'analysis-1',
            capturedAtIso: '2026-08-30T10:00:00Z',
            sessionId: null,
          },
        ]}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(textOf(renderer)).not.toContain('Attempt 1');
    await unmount(renderer);
  });
});

describe('StrokeResult — measured rows collapse (§1.4)', () => {
  it('collapses beyond 4 rows behind an honest "See more"', async () => {
    const analysis = analysisFixture({
      measurements: [
        {
          metricKey: 'elbow_extension',
          value: 0.42,
          confidence: 0.8,
          unit: 'ratio',
          source: 'real',
        },
        {
          metricKey: 'swing_duration',
          value: 700,
          confidence: 0.9,
          unit: 'ms',
          source: 'real',
        },
        {
          metricKey: 'hip_rotation',
          value: 31,
          confidence: 0.7,
          unit: 'degrees',
          source: 'real',
        },
        {
          metricKey: 'knee_bend',
          value: 12,
          confidence: 0.7,
          unit: 'degrees',
          source: 'real',
        },
      ],
    });
    const renderer = await render(
      <StrokeResult
        analysis={analysis}
        record={declaredRecord}
        clip={null}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain('See 1 more');
    expect(textOf(renderer)).not.toContain('Knee bend');
    const [seeMore] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'See 1 more' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      seeMore!.props.onPress();
    });
    expect(textOf(renderer)).toContain('Knee bend');
    expect(textOf(renderer)).toContain('Show fewer');
    await unmount(renderer);
  });
});

describe('StrokeResultAnalyzing — single-state arc + honest stage captions', () => {
  it('renders the stage caption and the no-invention disclosure', async () => {
    const renderer = await render(
      <StrokeResultAnalyzing caption="Measuring your swing…" dark />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('Measuring your swing…');
    expect(rendered).toContain('nothing is invented');
    await unmount(renderer);
  });
});
