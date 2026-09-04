/**
 * ADVERSARIAL PASS 3 — mobile-design-components-walkthrough — scenarios 5 & 9.
 *
 * S5  Fallback (JS interval) playback is running when the `clip` prop is
 *     swapped for a SHORTER clip mid-interval. The playhead must clamp to the
 *     new `endMs` and the old interval (which closed over the OLD `base`)
 *     must be cleared.
 * S9  Reduced motion on: playback steps every 120ms, the scrubber's
 *     accessibilityValue follows, and playback stops EXACTLY at `endMs`.
 *
 * ClipPlayer is mocked with the native view ABSENT so ReplayCard takes its
 * measured-timeline (setInterval) path — the same harness the WF ledger uses.
 * Reduced motion is driven through the `reduceMotionChanged` listener the
 * design module registers on the jest-preset AccessibilityInfo mock.
 */
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => false,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
  };
});

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'a2',
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:05:00.000Z',
    timestamps: { startMs: 200, contactMs: null, endMs: 700 },
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
  id: 'a2',
  captureId: 'capture-2',
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

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function renderSync(element: React.ReactElement): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function unmount(renderer: Renderer) {
  act(() => {
    renderer.unmount();
  });
}

function pressableByLabel(renderer: Renderer, label: string): Instance {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled "${label}"`);
  return node;
}

function hasPressable(renderer: Renderer, label: string): boolean {
  return (
    renderer.root.findAll(
      candidate =>
        candidate.props.accessibilityLabel === label &&
        typeof candidate.props.onPress === 'function',
    ).length > 0
  );
}

function press(node: Instance) {
  act(() => {
    node.props.onPress();
  });
}

function scrubber(renderer: Renderer): Instance {
  const [node] = renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      n.props.accessibilityLabel === 'Replay timeline scrubber',
  );
  if (!node) throw new Error('No scrubber host rendered');
  return node;
}

function a11yValue(renderer: Renderer): {
  min: number;
  max: number;
  now: number;
  text: string;
} {
  return scrubber(renderer).props.accessibilityValue;
}

function replayClock(renderer: Renderer): string {
  const [clock] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.children === 'string' &&
      /^\d+\.\d{2}s$/.test(node.props.children),
  );
  if (!clock) throw new Error('No replay clock rendered');
  return clock.props.children as string;
}

function surface(clip: { uri: string; durationMs: number } | null) {
  return (
    <StrokeResult
      analysis={analysisFixture()}
      record={declaredRecord}
      clip={clip}
      currentAnalysisId="a2"
      onTryAgain={() => undefined}
      onDone={() => undefined}
    />
  );
}

type Listener = (value: boolean) => void;
function reduceMotionListener(): Listener {
  const mocked = AccessibilityInfo.addEventListener as unknown as jest.Mock;
  const call = mocked.mock.calls.find(
    ([event]) => event === 'reduceMotionChanged',
  );
  if (!call) throw new Error('reduceMotionChanged listener never registered');
  return call[1] as Listener;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('ATTACK S5 — clip swapped to a shorter durationMs mid-interval', () => {
  const LONG = { uri: 'file:///clip-long.mov', durationMs: 4000 };
  const SHORT = { uri: 'file:///clip-short.mov', durationMs: 1000 };

  it('playhead clamps to the NEW endMs and the old interval is cleared', () => {
    const renderer = renderSync(surface(LONG));
    expect(a11yValue(renderer).max).toBe(4000);
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(800); // playhead 0.80s on the 4000ms base
    });
    expect(replayClock(renderer)).toBe('0.80s');
    const timersWhilePlaying = jest.getTimerCount();
    expect(timersWhilePlaying).toBeGreaterThanOrEqual(1);

    // Swap the clip mid-interval for one that ends at 1000ms.
    act(() => {
      renderer.update(surface(SHORT));
    });
    expect(a11yValue(renderer).max).toBe(1000);

    // Run the old interval well past the new end.
    act(() => {
      jest.advanceTimersByTime(1000); // old closure would step to 1.80s
    });
    const value = a11yValue(renderer);
    const observed = {
      clock: replayClock(renderer),
      now: value.now,
      max: value.max,
      timers: jest.getTimerCount(),
      playing: hasPressable(renderer, 'Pause replay'),
    };
    unmount(renderer);
    // BREAK PROBE: the interval closed over the OLD base (endMs 4000) and the
    // playhead state is never re-clamped when `base` changes, so the
    // scrubber reports now > max and the stale timer keeps running.
    expect(observed.now).toBeLessThanOrEqual(observed.max);
    expect(observed.clock).toBe('1.00s');
    expect(observed.timers).toBe(0);
    expect(observed.playing).toBe(false);
  });

  it('after the swap, the stale interval must not stop playback at the OLD endMs', () => {
    const renderer = renderSync(surface(LONG));
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(400);
    });
    act(() => {
      renderer.update(surface(SHORT));
    });
    // Advance to just before the OLD end and then past it.
    act(() => {
      jest.advanceTimersByTime(3400); // old closure: 0.4 + 3.4 = 3.8s
    });
    const midway = {
      clock: replayClock(renderer),
      now: a11yValue(renderer).now,
    };
    act(() => {
      jest.advanceTimersByTime(400); // old closure crosses 4000
    });
    const final = {
      clock: replayClock(renderer),
      now: a11yValue(renderer).now,
    };
    unmount(renderer);
    // Nothing on a 1000ms clip may ever read beyond 1000ms.
    expect(midway.now).toBeLessThanOrEqual(1000);
    expect(final.now).toBeLessThanOrEqual(1000);
    expect(final.clock).toBe('1.00s');
  });

  it('extra: swapping to a LONGER clip mid-play keeps the playhead monotonic and finishes at the new end', () => {
    const renderer = renderSync(surface(SHORT));
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(400);
    });
    act(() => {
      renderer.update(surface(LONG));
    });
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    const value = a11yValue(renderer);
    const observed = {
      clock: replayClock(renderer),
      now: value.now,
      max: value.max,
      timers: jest.getTimerCount(),
    };
    unmount(renderer);
    expect(observed.max).toBe(4000);
    expect(observed.timers).toBe(0);
    // BREAK PROBE: the stale closure stops at the OLD end (1000ms) even though
    // the card now advertises a 4000ms timeline.
    expect(observed.clock).toBe('4.00s');
    expect(observed.now).toBe(4000);
  });

  it('extra: swapping clip → null mid-play falls back to the stroke window and never reads past it', () => {
    const renderer = renderSync(surface(LONG));
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(2000); // 2.00s on the clip base
    });
    act(() => {
      renderer.update(surface(null));
    });
    // Window = [max(0, 200-250), 700+250] = 0..950ms
    expect(a11yValue(renderer).max).toBe(950);
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    const value = a11yValue(renderer);
    const observed = {
      now: value.now,
      max: value.max,
      timers: jest.getTimerCount(),
    };
    unmount(renderer);
    expect(observed.now).toBeLessThanOrEqual(observed.max);
    expect(observed.timers).toBe(0);
  });

  it('extra: rapid play/pause/swap interleaving (seed 777) never leaves more than one interval alive', () => {
    let seed = 777;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const clips = [LONG, SHORT, { uri: 'file:///c3.mov', durationMs: 2500 }];
    const renderer = renderSync(surface(LONG));
    let maxTimers = 0;
    for (let i = 0; i < 120; i++) {
      const roll = rand();
      if (roll < 0.35) {
        const label = hasPressable(renderer, 'Pause replay')
          ? 'Pause replay'
          : 'Play replay';
        press(pressableByLabel(renderer, label));
      } else if (roll < 0.6) {
        act(() => {
          renderer.update(surface(clips[Math.floor(rand() * clips.length)]!));
        });
      } else {
        act(() => {
          jest.advanceTimersByTime(Math.floor(rand() * 500));
        });
      }
      maxTimers = Math.max(maxTimers, jest.getTimerCount());
    }
    unmount(renderer);
    // Unmount schedules a few one-shot RN timeouts; run them out, then the
    // playback interval must be gone.
    act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(maxTimers).toBeLessThanOrEqual(1);
  });
});

describe('ATTACK S9 — reduced motion playback: 120ms stepping, a11y value, exact end stop', () => {
  beforeEach(() => {
    act(() => reduceMotionListener()(true));
  });
  afterEach(() => {
    act(() => reduceMotionListener()(false));
  });

  it('steps 120ms per tick, mirrors accessibilityValue.now/text, and stops exactly at endMs=1000', () => {
    const renderer = renderSync(
      surface({ uri: 'file:///clip.mov', durationMs: 1000 }),
    );
    expect(a11yValue(renderer)).toEqual({
      min: 0,
      max: 1000,
      now: 0,
      text: '0.00s',
    });
    press(pressableByLabel(renderer, 'Play replay'));
    expect(jest.getTimerCount()).toBe(1);

    // 119ms: no tick yet.
    act(() => {
      jest.advanceTimersByTime(119);
    });
    expect(a11yValue(renderer).now).toBe(0);
    // 120ms: first step.
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(a11yValue(renderer)).toEqual({
      min: 0,
      max: 1000,
      now: 120,
      text: '0.12s',
    });

    const seen: number[] = [a11yValue(renderer).now];
    for (let tick = 2; tick <= 8; tick++) {
      act(() => {
        jest.advanceTimersByTime(120);
      });
      seen.push(a11yValue(renderer).now);
    }
    expect(seen).toEqual([120, 240, 360, 480, 600, 720, 840, 960]);
    expect(hasPressable(renderer, 'Pause replay')).toBe(true);

    // 9th tick: 960 + 120 = 1080 ≥ 1000 → clamp to exactly 1000 and stop.
    act(() => {
      jest.advanceTimersByTime(120);
    });
    expect(a11yValue(renderer)).toEqual({
      min: 0,
      max: 1000,
      now: 1000,
      text: '1.00s',
    });
    expect(replayClock(renderer)).toBe('1.00s');
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    // Nothing moves after the stop.
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(a11yValue(renderer).now).toBe(1000);
    unmount(renderer);
  });

  it('endMs that is an exact multiple of 120 (1200) still stops at exactly 1200, not 1320', () => {
    const renderer = renderSync(
      surface({ uri: 'file:///clip.mov', durationMs: 1200 }),
    );
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(120 * 9); // 1080
    });
    expect(a11yValue(renderer).now).toBe(1080);
    expect(hasPressable(renderer, 'Pause replay')).toBe(true);
    act(() => {
      jest.advanceTimersByTime(120); // next = 1200 ≥ 1200 → stop at 1200
    });
    expect(a11yValue(renderer).now).toBe(1200);
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    unmount(renderer);
  });

  it('extra: a clip shorter than one step (durationMs=50) stops at 50 on the first tick', () => {
    const renderer = renderSync(
      surface({ uri: 'file:///clip.mov', durationMs: 50 }),
    );
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(120);
    });
    expect(a11yValue(renderer)).toEqual({
      min: 0,
      max: 50,
      now: 50,
      text: '0.05s',
    });
    expect(jest.getTimerCount()).toBe(0);
    unmount(renderer);
  });

  it('extra: reduced motion flipped ON mid-playback keeps the running 40ms interval (step is fixed at play time)', () => {
    act(() => reduceMotionListener()(false));
    const renderer = renderSync(
      surface({ uri: 'file:///clip.mov', durationMs: 1000 }),
    );
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(120);
    });
    expect(a11yValue(renderer).now).toBe(120);
    act(() => reduceMotionListener()(true));
    act(() => {
      jest.advanceTimersByTime(120);
    });
    // Pin the current contract: the interval is created once per play.
    expect(a11yValue(renderer).now).toBe(240);
    expect(jest.getTimerCount()).toBe(1);
    press(pressableByLabel(renderer, 'Pause replay'));
    expect(jest.getTimerCount()).toBe(0);
    // Re-pressing Play now honours the reduced setting: 120ms stepping.
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(119);
    });
    expect(a11yValue(renderer).now).toBe(240);
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(a11yValue(renderer).now).toBe(360);
    unmount(renderer);
  });

  it('extra: replaying from the end with reduced motion restarts at 0 and ends at endMs again', () => {
    const renderer = renderSync(
      surface({ uri: 'file:///clip.mov', durationMs: 1000 }),
    );
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(a11yValue(renderer).now).toBe(1000);
    press(pressableByLabel(renderer, 'Play replay'));
    expect(a11yValue(renderer).now).toBe(0);
    act(() => {
      jest.advanceTimersByTime(2000);
    });
    expect(a11yValue(renderer).now).toBe(1000);
    expect(jest.getTimerCount()).toBe(0);
    unmount(renderer);
  });
});
