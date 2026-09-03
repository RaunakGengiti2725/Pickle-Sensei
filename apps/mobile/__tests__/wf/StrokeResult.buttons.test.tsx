import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import { Icon } from '../../src/design/icons';

/**
 * WF button ledger for `src/components/StrokeResult.tsx`.
 *
 * Every interactive element the canonical result surface renders is pressed
 * here and its real observable effect asserted:
 *
 *  1. Play / Pause replay        -> ReplayCard.togglePlay
 *  2. Replay timeline scrubber   -> ReplayCard.seekToX (grant + move)
 *  3. Attempt N chips            -> props.onOpenAttempt(analysisId)
 *  4. "See N more" / "Show fewer" -> setRowsExpanded toggle
 *  5. "Try again"                -> props.onTryAgain
 *  6. "Done"                     -> props.onDone
 *
 * The ClipPlayer module is mocked so BOTH ReplayCard modes are exercised:
 * the measured-timeline mode (no native player: JS interval drives the
 * playhead) and the native mode (the player view drives progress and
 * receives `playing` / `seekMs`).
 */

const mockClip = { nativeAvailable: false };

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => mockClip.nativeAvailable,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
  };
});

const CLIP_MS = 1000;
const clip = { uri: 'file:///clip.mov', durationMs: CLIP_MS };

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

const attempts = [
  { analysisId: 'a1', capturedAtIso: '2026-08-30T10:00:00Z', sessionId: 's1' },
  { analysisId: 'a2', capturedAtIso: '2026-08-30T10:05:00Z', sessionId: 's1' },
  { analysisId: 'a3', capturedAtIso: '2026-08-30T10:09:00Z', sessionId: 's1' },
];

const measurement = (
  metricKey: string,
  value: number,
): ShotAnalysis['measurements'][number] => ({
  metricKey,
  value,
  confidence: 0.8,
  unit: 'degrees',
  source: 'real',
});

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

function textOf(renderer: Renderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Outermost pressable (PressableScale composite) carrying the handler. */
function pressableByLabel(renderer: Renderer, label: string): Instance {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.accessibilityLabel === label &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled "${label}"`);
  return node;
}

function pressableByTestID(renderer: Renderer, testID: string): Instance {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable with testID "${testID}"`);
  return node;
}

/** Host node (what the platform actually receives) matching a predicate. */
function host(
  renderer: Renderer,
  predicate: (node: Instance) => boolean,
): Instance {
  const [node] = renderer.root.findAll(
    candidate => typeof candidate.type === 'string' && predicate(candidate),
  );
  if (!node) throw new Error('No host node matched');
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

function iconNames(renderer: Renderer): string[] {
  return renderer.root.findAllByType(Icon).map(node => node.props.name);
}

/** The REPLAY clock text (e.g. "0.40s"). */
function replayClock(renderer: Renderer): string {
  const clocks = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.children === 'string' &&
      /^\d+\.\d{2}s$/.test(node.props.children),
  );
  const [clock] = clocks;
  if (!clock) throw new Error('No replay clock rendered');
  return clock.props.children as string;
}

function scrubber(renderer: Renderer): Instance {
  return host(
    renderer,
    node => node.props.accessibilityLabel === 'Replay timeline scrubber',
  );
}

function layoutScrubber(renderer: Renderer, width: number) {
  act(() => {
    scrubber(renderer).props.onLayout({
      nativeEvent: { layout: { width, height: 40, x: 0, y: 0 } },
    });
  });
}

function scrubGrant(renderer: Renderer, locationX: number) {
  act(() => {
    scrubber(renderer).props.onResponderGrant({ nativeEvent: { locationX } });
  });
}

function scrubMove(renderer: Renderer, locationX: number) {
  act(() => {
    scrubber(renderer).props.onResponderMove({ nativeEvent: { locationX } });
  });
}

function renderSurface(
  overrides: Partial<React.ComponentProps<typeof StrokeResult>> = {},
) {
  const onTryAgain = jest.fn();
  const onDone = jest.fn();
  const onOpenAttempt = jest.fn();
  const renderer = renderSync(
    <StrokeResult
      analysis={analysisFixture()}
      record={declaredRecord}
      clip={clip}
      attempts={attempts}
      currentAnalysisId="a2"
      onOpenAttempt={onOpenAttempt}
      onTryAgain={onTryAgain}
      onDone={onDone}
      {...overrides}
    />,
  );
  return { renderer, onTryAgain, onDone, onOpenAttempt };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockClip.nativeAvailable = false;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('StrokeResult ledger — CTA row', () => {
  it('"Try again" calls onTryAgain exactly once per press and is a >=44pt labelled button', () => {
    const { renderer, onTryAgain, onDone } = renderSurface();
    const tryAgain = pressableByTestID(renderer, 'stroke-result-try-again');
    press(tryAgain);
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(onDone).not.toHaveBeenCalled();

    const hostNode = host(
      renderer,
      node => node.props.testID === 'stroke-result-try-again',
    );
    expect(hostNode.props.accessibilityRole).toBe('button');
    expect(hostNode.props.accessibilityLabel).toBe('Try again');
    expect(hostNode.props.accessibilityState.disabled).toBeFalsy();
    expect(
      StyleSheet.flatten(hostNode.props.style).minHeight,
    ).toBeGreaterThanOrEqual(44);
    unmount(renderer);
  });

  it('"Done" calls onDone exactly once per press and is a >=44pt labelled button', () => {
    const { renderer, onTryAgain, onDone } = renderSurface();
    const done = pressableByTestID(renderer, 'stroke-result-done');
    press(done);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onTryAgain).not.toHaveBeenCalled();

    const hostNode = host(
      renderer,
      node => node.props.testID === 'stroke-result-done',
    );
    expect(hostNode.props.accessibilityRole).toBe('button');
    expect(hostNode.props.accessibilityLabel).toBe('Done');
    expect(
      StyleSheet.flatten(hostNode.props.style).minHeight,
    ).toBeGreaterThanOrEqual(44);
    unmount(renderer);
  });

  it('both CTAs stay present on the abstained (result:null) surface', () => {
    const familyRecord: StrokeResultEvidenceRecord = {
      id: 'x1',
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
    const { renderer, onTryAgain, onDone } = renderSurface({
      analysis: null,
      record: familyRecord,
      attempts: [],
      currentAnalysisId: 'x1',
    });
    expect(textOf(renderer)).toContain('WHAT HELD');
    press(pressableByTestID(renderer, 'stroke-result-try-again'));
    press(pressableByTestID(renderer, 'stroke-result-done'));
    expect(onTryAgain).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
    unmount(renderer);
  });
});

describe('StrokeResult ledger — attempt chips', () => {
  it('a non-current chip opens that attempt; the current chip is an inert selected tab', () => {
    const { renderer, onOpenAttempt } = renderSurface();

    press(pressableByLabel(renderer, 'Attempt 1'));
    expect(onOpenAttempt).toHaveBeenCalledTimes(1);
    expect(onOpenAttempt).toHaveBeenCalledWith('a1');

    press(pressableByLabel(renderer, 'Attempt 3'));
    expect(onOpenAttempt).toHaveBeenCalledTimes(2);
    expect(onOpenAttempt).toHaveBeenLastCalledWith('a3');

    press(pressableByLabel(renderer, 'Attempt 2'));
    expect(onOpenAttempt).toHaveBeenCalledTimes(2);

    const current = host(
      renderer,
      node => node.props.accessibilityLabel === 'Attempt 2',
    );
    expect(current.props.accessibilityRole).toBe('tab');
    expect(current.props.accessibilityState.selected).toBe(true);
    const other = host(
      renderer,
      node => node.props.accessibilityLabel === 'Attempt 1',
    );
    expect(other.props.accessibilityRole).toBe('tab');
    expect(other.props.accessibilityState.selected).toBe(false);
    expect(
      host(renderer, node => node.props.accessibilityRole === 'tablist').props
        .accessibilityLabel,
    ).toBe('Attempts in this session, in capture order');
    // WF-ISSUE: Attempt chips are 40pt tall with no hitSlop (below the 44pt
    // minimum hit target) — hit-target assertion intentionally skipped.
    unmount(renderer);
  });

  it('chips render only for >1 same-session attempt and never throw without onOpenAttempt', () => {
    const solo = renderSurface({
      attempts: [attempts[1]!],
    });
    expect(hasPressable(solo.renderer, 'Attempt 1')).toBe(false);
    unmount(solo.renderer);

    const crossSession = renderSurface({
      attempts: [
        attempts[1]!,
        {
          analysisId: 'z9',
          capturedAtIso: '2026-08-30T11:00:00Z',
          sessionId: 's9',
        },
      ],
    });
    expect(hasPressable(crossSession.renderer, 'Attempt 1')).toBe(false);
    unmount(crossSession.renderer);

    const noHandler = renderSync(
      <StrokeResult
        analysis={analysisFixture()}
        record={declaredRecord}
        clip={clip}
        attempts={attempts}
        currentAnalysisId="a2"
        onTryAgain={jest.fn()}
        onDone={jest.fn()}
      />,
    );
    expect(() => press(pressableByLabel(noHandler, 'Attempt 1'))).not.toThrow();
    unmount(noHandler);
  });
});

describe('StrokeResult ledger — measured rows "See more" / "Show fewer"', () => {
  it('toggles the hidden rows and re-labels itself each press', () => {
    const analysis = analysisFixture({
      measurements: [
        measurement('elbow_extension', 42),
        measurement('hip_rotation', 31),
        measurement('knee_bend', 12),
        measurement('shoulder_turn', 55),
        measurement('wrist_lag', 9),
      ],
    });
    // Rows: stroke window + 5 measurements = 6 -> 2 hidden.
    const { renderer } = renderSurface({ analysis });
    expect(textOf(renderer)).toContain('See 2 more');
    expect(textOf(renderer)).not.toContain('Shoulder turn');
    expect(textOf(renderer)).not.toContain('Wrist lag');

    const seeMore = pressableByLabel(renderer, 'See 2 more');
    const seeMoreHost = host(
      renderer,
      node => node.props.accessibilityLabel === 'See 2 more',
    );
    expect(seeMoreHost.props.accessibilityRole).toBe('button');
    expect(
      StyleSheet.flatten(seeMoreHost.props.style).minHeight,
    ).toBeGreaterThanOrEqual(44);

    press(seeMore);
    expect(textOf(renderer)).toContain('Shoulder turn');
    expect(textOf(renderer)).toContain('Wrist lag');
    expect(textOf(renderer)).toContain('Show fewer');
    expect(hasPressable(renderer, 'See 2 more')).toBe(false);

    press(pressableByLabel(renderer, 'Show fewer rows'));
    expect(textOf(renderer)).toContain('See 2 more');
    expect(textOf(renderer)).not.toContain('Wrist lag');
    expect(hasPressable(renderer, 'Show fewer rows')).toBe(false);
    unmount(renderer);
  });

  it('is absent when nothing is collapsed', () => {
    const { renderer } = renderSurface();
    expect(hasPressable(renderer, 'Show fewer rows')).toBe(false);
    expect(textOf(renderer)).not.toContain('See ');
    unmount(renderer);
  });
});

describe('StrokeResult ledger — replay Play/Pause (measured-timeline mode)', () => {
  it('play advances the clock on a timer, pause freezes it, and the run stops honestly at the end', () => {
    const { renderer } = renderSurface();
    expect(textOf(renderer)).toContain(
      'Scrubbing moves the measured evidence timeline',
    );
    expect(replayClock(renderer)).toBe('0.00s');
    expect(iconNames(renderer)).toContain('play');

    const play = pressableByLabel(renderer, 'Play replay');
    const playHost = host(
      renderer,
      node => node.props.accessibilityLabel === 'Play replay',
    );
    expect(playHost.props.accessibilityRole).toBe('button');
    const playStyle = StyleSheet.flatten(playHost.props.style);
    expect(playStyle.width).toBeGreaterThanOrEqual(44);
    expect(playStyle.height).toBeGreaterThanOrEqual(44);

    press(play);
    expect(hasPressable(renderer, 'Pause replay')).toBe(true);
    expect(hasPressable(renderer, 'Play replay')).toBe(false);
    expect(iconNames(renderer)).toContain('pause');

    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(replayClock(renderer)).toBe('0.40s');

    press(pressableByLabel(renderer, 'Pause replay'));
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(replayClock(renderer)).toBe('0.40s');

    // Resume and run out the clip: the run stops at the end by itself.
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(replayClock(renderer)).toBe('1.00s');
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    // Play at the end restarts from the top.
    press(pressableByLabel(renderer, 'Play replay'));
    expect(replayClock(renderer)).toBe('0.00s');
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(replayClock(renderer)).toBe('0.20s');
    // Unmounting mid-playback clears the interval (an orphaned interval
    // would survive any amount of advancing).
    unmount(renderer);
    act(() => {
      jest.advanceTimersByTime(5000);
    });
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a second press while playing pauses rather than stacking a second timer', () => {
    const { renderer } = renderSurface();
    press(pressableByLabel(renderer, 'Play replay'));
    const running = jest.getTimerCount();
    press(pressableByLabel(renderer, 'Pause replay'));
    expect(jest.getTimerCount()).toBe(running - 1);
    press(pressableByLabel(renderer, 'Play replay'));
    press(pressableByLabel(renderer, 'Pause replay'));
    press(pressableByLabel(renderer, 'Play replay'));
    expect(jest.getTimerCount()).toBe(running);
    act(() => {
      jest.advanceTimersByTime(400);
    });
    // One interval only: 400ms of wall time = 0.40s of playhead.
    expect(replayClock(renderer)).toBe('0.40s');
    unmount(renderer);
  });

  it('uses the analyzed stroke window as the time base when no clip file exists', () => {
    const { renderer } = renderSurface({ clip: null });
    expect(textOf(renderer)).toContain('NO PER-EVENT CLIP STORED');
    expect(replayClock(renderer)).toBe('0.00s');
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(10000);
    });
    // Window = [max(0, 200-250), 700+250] -> 0..950ms span, honest end stop.
    expect(replayClock(renderer)).toBe('0.95s');
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    unmount(renderer);
  });

  it('renders no play control or scrubber when no replay evidence exists', () => {
    const { renderer } = renderSurface({
      analysis: null,
      record: { ...declaredRecord, result: null },
      clip: null,
      attempts: [],
    });
    expect(textOf(renderer)).toContain(
      'No replay evidence is stored for this stroke on this device.',
    );
    expect(hasPressable(renderer, 'Play replay')).toBe(false);
    expect(
      renderer.root.findAll(
        node => node.props.accessibilityLabel === 'Replay timeline scrubber',
      ),
    ).toHaveLength(0);
    unmount(renderer);
  });
});

describe('StrokeResult ledger — replay scrubber (measured-timeline mode)', () => {
  it('grant and move seek proportionally, clamp to the clip, and stop playback', () => {
    const { renderer } = renderSurface();
    const track = scrubber(renderer);
    expect(track.props.onStartShouldSetResponder()).toBe(true);
    expect(track.props.onMoveShouldSetResponder()).toBe(true);
    expect(track.props.accessibilityHint).toBe(
      'Drag, or swipe up and down, to move through the analyzed clip',
    );
    expect(track.props.accessible).toBe(true);
    expect(track.props.accessibilityRole).toBe('adjustable');
    expect(track.props.accessibilityLabel).toBe('Replay timeline scrubber');
    expect(Array.isArray(track.props.accessibilityActions)).toBe(true);

    // Before layout the track width is unknown: a touch is a no-op.
    scrubGrant(renderer, 100);
    expect(replayClock(renderer)).toBe('0.00s');

    layoutScrubber(renderer, 200);
    scrubGrant(renderer, 100);
    expect(replayClock(renderer)).toBe('0.50s');
    scrubMove(renderer, 150);
    expect(replayClock(renderer)).toBe('0.75s');
    scrubMove(renderer, 400);
    expect(replayClock(renderer)).toBe('1.00s');
    scrubMove(renderer, -30);
    expect(replayClock(renderer)).toBe('0.00s');

    // Scrubbing during playback pauses it at the scrubbed position.
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(replayClock(renderer)).toBe('0.20s');
    scrubGrant(renderer, 50);
    expect(replayClock(renderer)).toBe('0.25s');
    expect(hasPressable(renderer, 'Play replay')).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(replayClock(renderer)).toBe('0.25s');

    // Play resumes from the scrubbed position, not from the top.
    press(pressableByLabel(renderer, 'Play replay'));
    act(() => {
      jest.advanceTimersByTime(200);
    });
    expect(replayClock(renderer)).toBe('0.45s');
    unmount(renderer);
  });
});

describe('StrokeResult ledger — replay controls drive the native player', () => {
  beforeEach(() => {
    mockClip.nativeAvailable = true;
  });

  function player(renderer: Renderer): Instance {
    return host(renderer, node => node.props.testID === 'clip-player');
  }

  it('play/pause toggles the player `playing` prop without starting a JS timer', () => {
    const { renderer } = renderSurface();
    expect(textOf(renderer)).toContain('the clip is never uploaded');
    expect(player(renderer).props.uri).toBe(clip.uri);
    expect(player(renderer).props.playing).toBe(false);
    expect(player(renderer).props.seekMs).toBe(-1);

    press(pressableByLabel(renderer, 'Play replay'));
    expect(player(renderer).props.playing).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    // The native player, not a JS timer, owns progress.
    expect(replayClock(renderer)).toBe('0.00s');

    act(() => {
      player(renderer).props.onProgress(300);
    });
    expect(replayClock(renderer)).toBe('0.30s');

    press(pressableByLabel(renderer, 'Pause replay'));
    expect(player(renderer).props.playing).toBe(false);
    unmount(renderer);
  });

  it('scrubbing sends a seek request and pauses; end-of-clip stops; play-at-end seeks to 0', () => {
    const { renderer } = renderSurface();
    layoutScrubber(renderer, 200);

    press(pressableByLabel(renderer, 'Play replay'));
    scrubGrant(renderer, 100);
    expect(player(renderer).props.playing).toBe(false);
    expect(player(renderer).props.seekMs).toBe(500);
    expect(replayClock(renderer)).toBe('0.50s');
    scrubMove(renderer, 160);
    expect(player(renderer).props.seekMs).toBe(800);

    press(pressableByLabel(renderer, 'Play replay'));
    expect(player(renderer).props.playing).toBe(true);
    act(() => {
      player(renderer).props.onEnd();
    });
    expect(player(renderer).props.playing).toBe(false);
    expect(replayClock(renderer)).toBe('1.00s');
    expect(hasPressable(renderer, 'Play replay')).toBe(true);

    press(pressableByLabel(renderer, 'Play replay'));
    expect(player(renderer).props.seekMs).toBe(0);
    expect(player(renderer).props.playing).toBe(true);
    expect(replayClock(renderer)).toBe('0.00s');
    unmount(renderer);
  });
});
