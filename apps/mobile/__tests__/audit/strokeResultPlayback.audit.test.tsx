/**
 * AUDIT — StrokeResult ReplayCard fallback playback (StrokeResult.tsx:243-253)
 * and ClipPlayer.sanitizeRate / native error fallback (ClipPlayer.tsx:55-75,
 * :121-123).
 *
 * The fallback setInterval closes over `base`. If the time base changes while
 * the interval is running (clip/analysis prop swap mid-play), the playhead is
 * driven against the OLD end bound. ResultScreen keys the surface by
 * analysisId, so the PROBE exercises the component contract, not a reachable
 * host path — see the report for that caveat.
 */
import React from 'react';
import { AccessibilityInfo, Image } from 'react-native';
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

const mounted: TestRenderer.ReactTestRenderer[] = [];

function create(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

function surface(
  clip: { uri: string; durationMs: number } | null,
  analysis: ShotAnalysis | null,
) {
  return (
    <StrokeResult
      analysis={analysis}
      record={null}
      clip={clip}
      currentAnalysisId="analysis-1"
      onTryAgain={jest.fn()}
      onDone={jest.fn()}
    />
  );
}

function hostByTestID(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.find(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
}

function playButton(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.accessibilityLabel === 'string' &&
      /^(Play|Pause) replay$/.test(n.props.accessibilityLabel) &&
      typeof n.props.onClick === 'function',
  );
}

function press(node: TestRenderer.ReactTestInstance) {
  act(() => {
    node.props.onClick({
      currentTarget: node,
      target: node,
      nativeEvent: {},
      stopPropagation: () => {},
    });
  });
}

function scrubberNow(renderer: TestRenderer.ReactTestRenderer): number {
  return hostByTestID(renderer, 'stroke-result-scrubber').props
    .accessibilityValue.now;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(false);
});

afterEach(() => {
  for (const r of mounted.splice(0)) act(() => r.unmount());
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('StrokeResult fallback playhead (no native player under Jest)', () => {
  const clip = { uri: 'file:///clip.mov', durationMs: 1000 };

  it('VERIFIED: play advances the playhead in 40ms steps, stops exactly at the clip end, and replay from the end restarts at 0', () => {
    const renderer = create(surface(clip, analysisFixture()));
    expect(scrubberNow(renderer)).toBe(0);
    press(playButton(renderer));
    act(() => jest.advanceTimersByTime(200));
    expect(scrubberNow(renderer)).toBe(200);
    act(() => jest.advanceTimersByTime(5000));
    expect(scrubberNow(renderer)).toBe(1000);
    expect(playButton(renderer).props.accessibilityLabel).toBe('Play replay');
    // Replay from the end restarts at the top of the clip.
    press(playButton(renderer));
    expect(scrubberNow(renderer)).toBe(0);
    act(() => jest.advanceTimersByTime(80));
    expect(scrubberNow(renderer)).toBe(80);
  });

  it('VERIFIED: the accessibility scrubber clamps at both clip bounds', () => {
    const renderer = create(surface(clip, analysisFixture()));
    const scrubber = hostByTestID(renderer, 'stroke-result-scrubber');
    act(() =>
      scrubber.props.onAccessibilityAction({
        nativeEvent: { actionName: 'decrement' },
      }),
    );
    expect(scrubberNow(renderer)).toBe(0);
    for (let i = 0; i < 25; i++) {
      act(() =>
        scrubber.props.onAccessibilityAction({
          nativeEvent: { actionName: 'increment' },
        }),
      );
    }
    expect(scrubberNow(renderer)).toBe(1000);
  });

  it('VERIFIED: unmount mid-play clears the interval (no late setState)', () => {
    const renderer = create(surface(clip, analysisFixture()));
    press(playButton(renderer));
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    act(() => renderer.unmount());
    mounted.splice(mounted.indexOf(renderer), 1);
    act(() => jest.advanceTimersByTime(2000));
    expect(jest.getTimerCount()).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it('PROBE: swapping the time base mid-play must not leave the playhead outside the new base', () => {
    // No clip: base = analysis window ± 250ms → [1750, 2950].
    const renderer = create(surface(null, analysisFixture()));
    press(playButton(renderer));
    act(() => jest.advanceTimersByTime(400));
    expect(scrubberNow(renderer)).toBe(400);
    // New analysis with a later window: base becomes [7750, 9250].
    act(() =>
      renderer.update(
        surface(
          null,
          analysisFixture({
            id: 'analysis-2',
            timestamps: { startMs: 8000, contactMs: null, endMs: 9000 },
          }),
        ),
      ),
    );
    act(() => jest.advanceTimersByTime(3000));
    const value = hostByTestID(renderer, 'stroke-result-scrubber').props
      .accessibilityValue;
    // The playhead must sit inside [0, max] of the CURRENT base once the
    // interval has had time to run past the old end bound.
    expect(value.now).toBeGreaterThanOrEqual(0);
    expect(value.now).toBeLessThanOrEqual(value.max);
    expect(value.now).toBeGreaterThan(0);
  });
});

describe('ClipPlayer without the native view (Jest default)', () => {
  it('VERIFIED: poster degradation is labelled and no native element renders', () => {
    const { ClipPlayer, clipPlaybackAvailable } =
      require('../../src/components/ClipPlayer') as typeof import('../../src/components/ClipPlayer');
    expect(clipPlaybackAvailable()).toBe(false);
    const renderer = create(
      <ClipPlayer
        uri="file:///c.mov"
        posterUri="file:///c.jpg"
        playing={false}
        seekMs={-1}
        rate={Number.NaN}
      />,
    );
    const poster = renderer.root.findByType(Image);
    expect(poster.props.accessibilityLabel).toBe('Captured clip poster');
  });
});

describe('ClipPlayer with the native view registered — rate sanitising + error fallback', () => {
  let ClipPlayerModule: typeof import('../../src/components/ClipPlayer');

  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock('react-native', () => {
        const actual =
          jest.requireActual<typeof import('react-native')>('react-native');
        const overrides: Record<string, unknown> = {
          UIManager: {
            getViewManagerConfig: (name: string) =>
              name === 'PickleClipPlayerView' ? { Commands: {} } : null,
          },
          requireNativeComponent: (name: string) => name,
        };
        return new Proxy(actual, {
          get: (target, prop: string) =>
            prop in overrides
              ? overrides[prop]
              : (target as unknown as Record<string, unknown>)[prop],
        });
      });
      ClipPlayerModule = require('../../src/components/ClipPlayer');
    });
  });

  afterAll(() => {
    jest.dontMock('react-native');
  });

  it.each([
    [undefined, 1],
    [Number.NaN, 1],
    [0, 1],
    [-1, 1],
    [Number.POSITIVE_INFINITY, 1],
    [Number.NEGATIVE_INFINITY, 1],
    [0.5, 0.5],
    [2, 2],
  ])('VERIFIED: rate %p → native rate %p', (rate, expected) => {
    const { ClipPlayer } = ClipPlayerModule;
    const renderer = create(
      <ClipPlayer
        uri="file:///c.mov"
        playing
        seekMs={0}
        {...(rate !== undefined ? { rate } : {})}
      />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    expect(native.props.rate).toBe(expected);
  });

  it('VERIFIED: a native error without a message reaches onError as "unreadable"', () => {
    const { ClipPlayer } = ClipPlayerModule;
    const onError = jest.fn();
    const renderer = create(
      <ClipPlayer uri="file:///c.mov" playing seekMs={0} onError={onError} />,
    );
    const native = renderer.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    act(() => native.props.onClipError({ nativeEvent: {} }));
    act(() => native.props.onClipError({ nativeEvent: { message: 'codec' } }));
    expect(onError.mock.calls).toEqual([['unreadable'], ['codec']]);
    // Absent onError must not throw.
    const bare = create(<ClipPlayer uri="file:///c.mov" playing seekMs={0} />);
    const bareNative = bare.root.find(
      n => String(n.type) === 'PickleClipPlayerView',
    );
    expect(() =>
      act(() => bareNative.props.onClipError({ nativeEvent: {} })),
    ).not.toThrow();
  });
});
