import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../src/components/strokeResultModel';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  techniqueIntentFromHandoff,
  tryAgainFromResult,
} from '../src/screens/tryAgainHandoff';

/**
 * D12 — Result → Try Again → rearm loop hardening.
 *
 * Three consecutive attempts (usable result → honest abstention → usable
 * result) rendered through the same mounted Result surface, exactly as
 * ResultScreen does (`key={analysisId}`): each attempt renders ONLY its own
 * evidence, no marker/phase/insight/ledger/replay state survives an attempt
 * switch, and the TRY AGAIN handoff preserves the TechniqueIntent and
 * capture configuration across every rearm — including through abstention
 * and through a declared-vs-predicted disagreement.
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

function declaredEnvelope(
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

const backhandFamilyPrediction = {
  taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
  classifierVersion: 'stroke-heuristic-2',
  label: 'BACKHAND',
  leaf: null,
  taxonomyDepth: 2 as const,
  confidence: 0.72,
  evidence: [],
  limitingFactors: [],
};

// ─── The three attempts of one session ──────────────────────────────────────

const attempt1 = {
  analysis: analysisFixture({
    id: 'a1',
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
  }),
  record: {
    id: 'a1',
    captureId: 'capture-1',
    strokeIntent: declaredEnvelope(),
    result: null,
    uncertainty: {
      analysisConfidence: 0.82,
      presentation: 'normal',
      limitingFactors: [],
    },
    contact: {
      status: 'estimated',
      estimatedContactMs: 2400,
      confidence: 0.7,
      ballConfirmed: true,
      paddleConfirmed: false,
      limitingFactors: [],
      supportingEvidence: [],
    },
  } as StrokeResultEvidenceRecord,
  clip: { uri: 'file:///clip-1.mov', durationMs: 4200 },
};

const attempt2 = {
  analysis: null,
  record: {
    id: 'a2',
    captureId: 'capture-2',
    strokeIntent: declaredEnvelope({
      declaredStroke: null,
      resolutionBasis: 'abstained',
      resolvedProfileId: null,
      resolvedProfileVersion: null,
    }),
    result: null,
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      limitingFactors: ['paddle_track_missing'],
    },
    contact: {
      status: 'abstained',
      reason: 'insufficient evidence mass',
      limitingFactors: ['insufficient_evidence_mass'],
    },
  } as StrokeResultEvidenceRecord,
  clip: { uri: 'file:///clip-2.mov', durationMs: 3800 },
};

const attempt3 = {
  analysis: analysisFixture({
    id: 'a3',
    capturedAtIso: '2026-08-30T10:09:00.000Z',
    timestamps: { startMs: 5000, contactMs: null, endMs: 5600 },
    measurements: [
      {
        metricKey: 'elbow_extension',
        value: 0.5,
        confidence: 0.8,
        unit: 'ratio',
        source: 'real',
      },
      {
        metricKey: 'swing_duration',
        value: 640,
        confidence: 0.9,
        unit: 'ms',
        source: 'real',
      },
      {
        metricKey: 'hip_rotation',
        value: 28,
        confidence: 0.7,
        unit: 'degrees',
        source: 'real',
      },
      {
        metricKey: 'shoulder_turn',
        value: 40,
        confidence: 0.7,
        unit: 'degrees',
        source: 'real',
      },
    ],
  }),
  record: {
    id: 'a3',
    captureId: 'capture-3',
    strokeIntent: declaredEnvelope(),
    result: null,
    uncertainty: {
      analysisConfidence: 0.8,
      presentation: 'normal',
      limitingFactors: [],
    },
    contact: {
      status: 'estimated',
      estimatedContactMs: 5300,
      confidence: 0.7,
      ballConfirmed: false,
      paddleConfirmed: true,
      limitingFactors: [],
      supportingEvidence: [],
    },
  } as StrokeResultEvidenceRecord,
  clip: { uri: 'file:///clip-3.mov', durationMs: 4100 },
};

const attemptRefs = [
  { analysisId: 'a1', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: 's1' },
  { analysisId: 'a2', capturedAtIso: '2026-08-30T10:05:00Z', sessionId: 's1' },
  { analysisId: 'a3', capturedAtIso: '2026-08-30T10:09:00Z', sessionId: 's1' },
];

function surface(
  attempt: typeof attempt1 | typeof attempt2 | typeof attempt3,
  currentAnalysisId: string,
  attempts = attemptRefs,
) {
  // Mirrors ResultScreen exactly: the surface is keyed by the attempt id, so
  // repointing the mounted Result route to another attempt remounts it.
  return (
    <StrokeResult
      key={currentAnalysisId}
      analysis={attempt.analysis}
      record={attempt.record}
      clip={attempt.clip}
      attempts={attempts}
      currentAnalysisId={currentAnalysisId}
      onOpenAttempt={jest.fn()}
      onTryAgain={jest.fn()}
      onDone={jest.fn()}
    />
  );
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function update(
  renderer: TestRenderer.ReactTestRenderer,
  element: React.ReactElement,
) {
  await act(async () => {
    renderer.update(element);
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function contactMarkers(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Contact marker'),
  );
}

function labelsOf(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
): string[] {
  const labels = renderer.root
    .findAll(node => typeof node.type === 'string' && predicate(node))
    .map(node => node.props.accessibilityLabel as string);
  return [...new Set(labels)];
}

describe('D12 — three consecutive attempts on one mounted Result surface', () => {
  it('usable → abstention → usable: each attempt renders only its own evidence', async () => {
    const renderer = await render(surface(attempt1, 'a1', [attemptRefs[0]!]));

    // Attempt 1: usable result with a ball-confirmed contact marker.
    let rendered = textOf(renderer);
    expect(contactMarkers(renderer)).toHaveLength(1);
    expect(rendered).toContain('Ball-confirmed');
    expect(rendered).toContain('You chose this technique.');
    expect(rendered).not.toContain('WHAT HELD');
    expect(rendered).toContain('2400ms');

    // Attempt 2: honest abstention. NOTHING from attempt 1 may survive.
    await update(renderer, surface(attempt2, 'a2'));
    rendered = textOf(renderer);
    expect(contactMarkers(renderer)).toHaveLength(0);
    expect(rendered).not.toContain('Ball-confirmed');
    expect(rendered).not.toContain('2400ms');
    expect(rendered).not.toContain('You chose this technique.');
    expect(rendered).toContain('Stroke not identified');
    expect(rendered).toContain('WHAT HELD');
    expect(rendered).toContain('WHAT WE COULDN’T ESTABLISH');
    expect(rendered).not.toContain('out of 10');

    // Attempt 3: usable again, paddle-confirmed at a different moment.
    // Nothing from the abstention (or attempt 1) may survive.
    await update(renderer, surface(attempt3, 'a3'));
    rendered = textOf(renderer);
    expect(contactMarkers(renderer)).toHaveLength(1);
    expect(rendered).toContain('Paddle-confirmed');
    expect(rendered).not.toContain('Ball-confirmed');
    expect(rendered).toContain('5300ms');
    expect(rendered).not.toContain('2400ms');
    expect(rendered).not.toContain('Stroke not identified');
    expect(rendered).not.toContain('WHAT HELD');
    expect(rendered).toContain('You chose this technique.');

    await act(async () => {
      renderer.unmount();
    });
  });

  it('attempt chips reflect only capture order and the current attempt', async () => {
    const renderer = await render(surface(attempt2, 'a2'));
    expect(
      labelsOf(
        renderer,
        node => node.props.accessibilityState?.selected === true,
      ),
    ).toEqual(['Attempt 2']);

    await update(renderer, surface(attempt3, 'a3'));
    expect(
      labelsOf(
        renderer,
        node => node.props.accessibilityState?.selected === true,
      ),
    ).toEqual(['Attempt 3']);
    await act(async () => {
      renderer.unmount();
    });
  });

  it('measured-rows expansion does not leak into the next attempt', async () => {
    const renderer = await render(surface(attempt1, 'a1'));
    expect(textOf(renderer)).toContain('See 2 more');
    expect(textOf(renderer)).not.toContain('Knee bend');
    const [seeMore] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'See 2 more' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      seeMore!.props.onPress();
    });
    expect(textOf(renderer)).toContain('Knee bend');

    await update(renderer, surface(attempt3, 'a3'));
    const rendered = textOf(renderer);
    expect(rendered).toContain('See 2 more');
    expect(rendered).not.toContain('Shoulder turn');
    expect(rendered).not.toContain('Knee bend');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('replay playback state (playhead, playing timer) does not leak into the next attempt', async () => {
    jest.useFakeTimers();
    try {
      const renderer = await render(surface(attempt1, 'a1'));
      const [play] = renderer.root.findAll(
        node =>
          node.props.accessibilityLabel === 'Play replay' &&
          typeof node.props.onPress === 'function',
      );
      await act(async () => {
        play!.props.onPress();
      });
      await act(async () => {
        jest.advanceTimersByTime(400);
      });
      expect(textOf(renderer)).not.toContain('0.00s');
      expect(
        labelsOf(
          renderer,
          node => node.props.accessibilityLabel === 'Pause replay',
        ),
      ).toEqual(['Pause replay']);

      await update(renderer, surface(attempt2, 'a2'));
      expect(textOf(renderer)).toContain('0.00s');
      expect(
        labelsOf(
          renderer,
          node => node.props.accessibilityLabel === 'Pause replay',
        ),
      ).toEqual([]);

      // The old attempt's playback interval was cleared on remount: advancing
      // time moves nothing.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(textOf(renderer)).toContain('0.00s');
      await act(async () => {
        renderer.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('D12 — TechniqueIntent + capture configuration survive every rearm', () => {
  function rearm(
    record: Pick<StrokeResultEvidenceRecord, 'strokeIntent'> | null,
    analysis: Pick<ShotAnalysis, 'shotType'> | null,
  ) {
    // Exactly what ResultScreen's TRY AGAIN does, then what AnalyzeScreen
    // consumes on mount.
    armTryAgain(tryAgainFromResult(record, analysis));
    const handoff = consumeTryAgainHandoff();
    expect(consumeTryAgainHandoff()).toBeNull(); // single-shot, never stale
    return handoff!;
  }

  it('declared loop: usable → abstained contact → usable keeps the declaration and camera config', () => {
    for (const attempt of [attempt1, attempt2, attempt3]) {
      const record =
        attempt === attempt2
          ? { ...attempt2.record, strokeIntent: declaredEnvelope() }
          : attempt.record;
      const handoff = rearm(record, attempt.analysis);
      expect(handoff.source).toBe('camera');
      expect(handoff.declaredStroke).toBe('forehand_drive');
      expect(handoff.auto).toBe(false);
      const intent = techniqueIntentFromHandoff(handoff);
      expect(intent).toEqual({
        version: 'technique-intent-v1',
        source: 'tap',
        canonical: 'FOREHAND_DRIVE',
        legacySlug: 'forehand_drive',
        confidence: 1,
      });
    }
  });

  it('AUTO loop: usable → abstention → usable re-arms AUTO every time, never a fabricated declaration', () => {
    const autoUsable = declaredEnvelope({
      declaredStroke: null,
      predictedStroke: {
        ...backhandFamilyPrediction,
        label: 'OVERHEAD',
        leaf: 'OVERHEAD',
        taxonomyDepth: 1 as const,
      },
      resolutionBasis: 'predicted_l3',
      resolvedProfileId: 'OVERHEAD',
    });
    const autoAbstained = declaredEnvelope({
      declaredStroke: null,
      predictedStroke: null,
      resolutionBasis: 'abstained',
      resolvedProfileId: null,
      resolvedProfileVersion: null,
    });
    for (const strokeIntent of [autoUsable, autoAbstained, autoUsable]) {
      const handoff = rearm({ strokeIntent }, null);
      expect(handoff).toEqual({
        source: 'camera',
        declaredStroke: null,
        declaredCanonical: null,
        auto: true,
      });
      expect(techniqueIntentFromHandoff(handoff)).toEqual({
        version: 'technique-intent-v1',
        source: 'auto',
        canonical: null,
        legacySlug: null,
        confidence: null,
      });
    }
  });
});

describe('D12 — declared forehand vs predicted backhand mismatch surface', () => {
  const mismatchRecord: StrokeResultEvidenceRecord = {
    id: 'a4',
    captureId: 'capture-4',
    strokeIntent: declaredEnvelope({
      predictedStroke: backhandFamilyPrediction,
      disagreement: {
        declared: 'forehand_drive',
        predictedLabel: 'BACKHAND',
        basis: 'side_vs_declared',
      },
    }),
    result: null,
    uncertainty: {
      analysisConfidence: 0.8,
      presentation: 'normal',
      limitingFactors: [],
    },
  };

  it('shows the honest mismatch treatment: declaration kept, prediction disclosed, neither overwrites', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture({ id: 'a4' })}
        record={mismatchRecord}
        clip={{ uri: 'file:///clip-4.mov', durationMs: 4000 }}
        currentAnalysisId="a4"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('DECLARED · CAMERA READ DIFFERS');
    expect(rendered).toContain('Forehand drive');
    expect(rendered).toContain('Predicted BACKHAND');
    expect(rendered).toContain('differs from your declared forehand drive');
    expect(rendered).toContain('neither overwrites the other');
    // The ONE insight is the disagreement — both records kept.
    expect(rendered).toContain(
      'You declared forehand drive and the camera read BACKHAND',
    );
    // The prediction stays labeled a prediction in the measured rows.
    expect(rendered).toContain('Classifier read');
    expect(rendered).toContain('PREDICTED');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('rearms the DECLARED forehand — the predicted backhand never becomes the intent', () => {
    armTryAgain(
      tryAgainFromResult(mismatchRecord, analysisFixture({ id: 'a4' })),
    );
    const handoff = consumeTryAgainHandoff()!;
    expect(handoff.declaredStroke).toBe('forehand_drive');
    expect(handoff.auto).toBe(false);
    const intent = techniqueIntentFromHandoff(handoff);
    expect(intent?.canonical).toBe('FOREHAND_DRIVE');
    expect(intent?.legacySlug).toBe('forehand_drive');
  });

  it('the mismatch treatment does not leak into the next attempt', async () => {
    const renderer = await render(
      <StrokeResult
        key="a4"
        analysis={analysisFixture({ id: 'a4' })}
        record={mismatchRecord}
        clip={null}
        currentAnalysisId="a4"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain('DECLARED · CAMERA READ DIFFERS');
    await update(
      renderer,
      <StrokeResult
        key="a5"
        analysis={analysisFixture({ id: 'a5' })}
        record={{ ...attempt1.record, id: 'a5' }}
        clip={null}
        currentAnalysisId="a5"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).not.toContain('DECLARED · CAMERA READ DIFFERS');
    expect(rendered).not.toContain('BACKHAND');
    expect(rendered).toContain('You chose this technique.');
    await act(async () => {
      renderer.unmount();
    });
  });
});
