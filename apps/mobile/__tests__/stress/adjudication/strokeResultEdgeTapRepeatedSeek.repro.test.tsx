import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../../src/components/strokeResultModel';

/**
 * Adjudication repro (components-1, StrokeResult repeated seek).
 *
 * Reachable path on a real device: tapping the far-left of the scrubber
 * clamps `ratio` to 0 (StrokeResult.seekToX), so every "jump to start" tap
 * produces the exact same `seekMs` value. The native view
 * (PickleClipPlayer.swift `seekMs` didSet: `guard seekMs != oldValue`) and
 * the React reconciler both drop an unchanged prop, so the SECOND jump to
 * start after playback has advanced never reaches AVPlayer: the clock reads
 * 0.00s while the frame stays where playback paused.
 *
 * The mock below models the native guard (consecutive equal values are one
 * request). RED on 1fb0efd7.
 */

const nativeSeeks: number[] = [];

jest.mock('../../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => true,
    ClipPlayer: (props: { seekMs: number }) => {
      const last = nativeSeeks[nativeSeeks.length - 1];
      if (props.seekMs >= 0 && !Object.is(last, props.seekMs)) {
        nativeSeeks.push(props.seekMs);
      }
      return ReactActual.createElement(RN.View, {
        testID: 'clip-player',
        ...props,
      });
    },
  };
});

const clip = { uri: 'file:///clip.mov', durationMs: 1000 };

const analysis: ShotAnalysis = {
  id: 'adj-seek',
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
  id: 'adj-seek',
  captureId: 'capture-adj',
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

function host(renderer: Renderer, pred: (n: Instance) => boolean): Instance {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && pred(n),
  );
  if (!node) throw new Error('No host node matched');
  return node;
}

const scrubber = (r: Renderer) =>
  host(r, n => n.props.accessibilityLabel === 'Replay timeline scrubber');
const player = (r: Renderer) => host(r, n => n.props.testID === 'clip-player');
const clock = (r: Renderer) =>
  host(
    r,
    n =>
      typeof n.props.children === 'string' &&
      /^\d+\.\d{2}s$/.test(n.props.children),
  ).props.children as string;
const playButton = (r: Renderer) =>
  r.root.findAll(
    n =>
      n.props.accessibilityLabel === 'Play replay' &&
      typeof n.props.onPress === 'function',
  )[0]!;

let mounted: Renderer | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  nativeSeeks.length = 0;
});

afterEach(() => {
  if (mounted) {
    const r = mounted;
    mounted = null;
    act(() => r.unmount());
  }
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('StrokeResult replay — "jump to start" edge tap repeated after playback', () => {
  it('second far-left tap after progress must reach the native player as a seek', async () => {
    let renderer!: Renderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <StrokeResult
          analysis={analysis}
          record={record}
          clip={clip}
          attempts={[]}
          currentAnalysisId="adj-seek"
          onOpenAttempt={jest.fn()}
          onTryAgain={jest.fn()}
          onDone={jest.fn()}
        />,
      );
    });
    mounted = renderer;
    act(() => {
      scrubber(renderer).props.onLayout({
        nativeEvent: { layout: { width: 327, height: 40, x: 0, y: 0 } },
      });
    });

    // Tap at the left edge (locationX past the track start clamps to 0).
    act(() => {
      scrubber(renderer).props.onResponderGrant({
        nativeEvent: { locationX: -3 },
      });
    });
    expect(player(renderer).props.seekMs).toBe(0);
    expect(nativeSeeks).toEqual([0]);

    act(() => playButton(renderer).props.onPress());
    act(() => player(renderer).props.onProgress(320));
    expect(clock(renderer)).toBe('0.32s');

    // Jump to start again: the clock rewinds and playback pauses...
    act(() => {
      scrubber(renderer).props.onResponderGrant({
        nativeEvent: { locationX: 0 },
      });
    });
    expect(clock(renderer)).toBe('0.00s');
    expect(player(renderer).props.playing).toBe(false);

    // ...but the frame only moves if the native player gets a second request.
    expect(nativeSeeks).toEqual([0, 0]);
  });
});
