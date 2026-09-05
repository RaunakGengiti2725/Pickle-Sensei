import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

/**
 * Adjacent host of ClipPlayer: StrokeResult's replay card drives the native
 * player purely through the `seekMs` prop. ClipPlayer's contract (see
 * FormReviewPlayer.requestSeek: "Every request must differ numerically or
 * the native view ignores it") is that a repeated seek intent must still
 * produce a prop change — an unchanged prop never reaches the native view.
 *
 * Rapid-interaction sequence this pins (deterministic, found while modelling
 * seek spam for the cmp-players campaign): scrub to X → play → progress →
 * scrub to X again. The second scrub is a real user intent (rewind to the
 * same spot) but StrokeResult.seekTo sets `seekMs` to the value it already
 * holds, so the player never receives a second seek. RED on 1fb0efd7.
 */

const seekHistory: number[] = [];

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => true,
    ClipPlayer: (props: { seekMs: number }) => {
      // Mirrors the reconciler: only a CHANGED prop is delivered to native.
      const last = seekHistory[seekHistory.length - 1];
      if (last === undefined || !Object.is(last, props.seekMs)) {
        seekHistory.push(props.seekMs);
      }
      return ReactActual.createElement(RN.View, {
        testID: 'clip-player',
        ...props,
      });
    },
  };
});

const CLIP_MS = 1000;
const clip = { uri: 'file:///clip.mov', durationMs: CLIP_MS };

const analysis: ShotAnalysis = {
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
};

const record: StrokeResultEvidenceRecord = {
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

function host(
  renderer: Renderer,
  predicate: (n: Instance) => boolean,
): Instance {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && predicate(n),
  );
  if (!node) throw new Error('No host node matched');
  return node;
}

function pressableByLabel(renderer: Renderer, label: string): Instance {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labelled "${label}"`);
  return node;
}

function scrubber(renderer: Renderer): Instance {
  return host(
    renderer,
    n => n.props.accessibilityLabel === 'Replay timeline scrubber',
  );
}

function player(renderer: Renderer): Instance {
  return host(renderer, n => n.props.testID === 'clip-player');
}

function replayClock(renderer: Renderer): string {
  return host(
    renderer,
    n =>
      typeof n.props.children === 'string' &&
      /^\d+\.\d{2}s$/.test(n.props.children),
  ).props.children as string;
}

let mounted: Renderer | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  seekHistory.length = 0;
});

afterEach(() => {
  // Unmount even after a failed expectation so no post-teardown re-render
  // leaks out of a red test.
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => renderer.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('StrokeResult replay — repeated seek intent reaches the native player', () => {
  it('scrub to X, play, progress, scrub to X again → the player receives a SECOND seek', async () => {
    let renderer!: Renderer;
    // Async so the design system's reduced-motion probe settles inside act.
    await act(async () => {
      renderer = TestRenderer.create(
        <StrokeResult
          analysis={analysis}
          record={record}
          clip={clip}
          attempts={[]}
          currentAnalysisId="a2"
          onOpenAttempt={jest.fn()}
          onTryAgain={jest.fn()}
          onDone={jest.fn()}
        />,
      );
    });
    mounted = renderer;
    act(() => {
      scrubber(renderer).props.onLayout({
        nativeEvent: { layout: { width: 200, height: 40, x: 0, y: 0 } },
      });
    });

    // Scrub to the midpoint: one seek request (500ms into the clip).
    act(() => {
      scrubber(renderer).props.onResponderGrant({
        nativeEvent: { locationX: 100 },
      });
    });
    expect(player(renderer).props.seekMs).toBe(500);
    expect(replayClock(renderer)).toBe('0.50s');
    const seeksAfterFirstScrub = seekHistory.filter(v => v >= 0).length;
    expect(seeksAfterFirstScrub).toBe(1);

    // Play on; the native player reports real progress past the mark.
    act(() => {
      pressableByLabel(renderer, 'Play replay').props.onPress();
    });
    act(() => {
      player(renderer).props.onProgress(800);
    });
    expect(replayClock(renderer)).toBe('0.80s');

    // Rewind to the same spot: the clock moves back, playback pauses...
    act(() => {
      scrubber(renderer).props.onResponderGrant({
        nativeEvent: { locationX: 100 },
      });
    });
    expect(replayClock(renderer)).toBe('0.50s');
    expect(player(renderer).props.playing).toBe(false);

    // ...and the native player must be told to seek again.
    expect(seekHistory.filter(v => v >= 0)).toHaveLength(2);
  });
});
