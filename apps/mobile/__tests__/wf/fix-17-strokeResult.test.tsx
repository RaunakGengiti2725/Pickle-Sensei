import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';

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

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

function hostNode(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      typeof candidate.type === 'string' && candidate.props.testID === testID,
  );
  expect(node).toBeDefined();
  return node!;
}

async function fireAccessibilityAction(
  node: TestRenderer.ReactTestInstance,
  actionName: string,
) {
  await act(async () => {
    node.props.onAccessibilityAction({ nativeEvent: { actionName } });
  });
}

describe('StrokeResult attempt chips — 44pt hit target', () => {
  it('extends every chip with hitSlop so the 40pt pill meets the 44pt minimum', async () => {
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
    ];
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture({ id: 'a2', sessionId: 's1' })}
        record={null}
        clip={null}
        attempts={attempts}
        currentAnalysisId="a2"
        onOpenAttempt={jest.fn()}
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const chips = renderer.root.findAll(
      node =>
        typeof node.type === 'string' && node.props.accessibilityRole === 'tab',
    );
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      const slop = chip.props.hitSlop;
      const vertical =
        typeof slop === 'number'
          ? slop * 2
          : (slop?.top ?? 0) + (slop?.bottom ?? 0);
      expect(40 + vertical).toBeGreaterThanOrEqual(44);
    }
    await unmount(renderer);
  });
});

describe('StrokeResult replay scrubber — assistive-technology operability', () => {
  const clip = { uri: 'file:///clip.mov', durationMs: 4200 };

  it('is exposed as an accessible adjustable element with increment/decrement actions and a real value', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={null}
        clip={clip}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const scrubber = hostNode(renderer, 'stroke-result-scrubber');
    expect(scrubber.props.accessible).toBe(true);
    expect(scrubber.props.accessibilityRole).toBe('adjustable');
    expect(scrubber.props.accessibilityLabel).toBe('Replay timeline scrubber');
    expect(scrubber.props.accessibilityHint).toMatch(/swipe up and down/);
    expect(typeof scrubber.props.onAccessibilityAction).toBe('function');
    const actionNames = scrubber.props.accessibilityActions.map(
      (action: { name: string }) => action.name,
    );
    expect(actionNames).toEqual(
      expect.arrayContaining(['increment', 'decrement']),
    );
    expect(scrubber.props.accessibilityValue).toEqual({
      min: 0,
      max: 4200,
      now: 0,
      text: '0.00s',
    });
    await unmount(renderer);
  });

  it('steps the playhead on increment/decrement and clamps at the clip bounds', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={null}
        clip={clip}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const scrubber = () => hostNode(renderer, 'stroke-result-scrubber');

    await fireAccessibilityAction(scrubber(), 'increment');
    expect(scrubber().props.accessibilityValue.now).toBe(210);
    expect(scrubber().props.accessibilityValue.text).toBe('0.21s');
    expect(JSON.stringify(renderer.toJSON())).toContain('0.21s');

    await fireAccessibilityAction(scrubber(), 'increment');
    expect(scrubber().props.accessibilityValue.now).toBe(420);

    await fireAccessibilityAction(scrubber(), 'decrement');
    await fireAccessibilityAction(scrubber(), 'decrement');
    await fireAccessibilityAction(scrubber(), 'decrement');
    expect(scrubber().props.accessibilityValue.now).toBe(0);

    for (let step = 0; step < 25; step += 1) {
      await fireAccessibilityAction(scrubber(), 'increment');
    }
    expect(scrubber().props.accessibilityValue.now).toBe(4200);
    expect(scrubber().props.accessibilityValue.text).toBe('4.20s');

    await fireAccessibilityAction(scrubber(), 'activate');
    expect(scrubber().props.accessibilityValue.now).toBe(4200);
    await unmount(renderer);
  });

  it('keeps the value honest when the time base is the analyzed stroke window (no clip)', async () => {
    const renderer = await render(
      <StrokeResult
        analysis={analysisFixture()}
        record={null}
        clip={null}
        currentAnalysisId="analysis-1"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    const scrubber = () => hostNode(renderer, 'stroke-result-scrubber');
    expect(scrubber().props.accessibilityValue).toEqual({
      min: 0,
      max: 1200,
      now: 0,
      text: '0.00s',
    });
    await fireAccessibilityAction(scrubber(), 'increment');
    expect(scrubber().props.accessibilityValue.now).toBe(60);
    expect(scrubber().props.accessibilityValue.text).toBe('0.06s');
    await unmount(renderer);
  });
});
