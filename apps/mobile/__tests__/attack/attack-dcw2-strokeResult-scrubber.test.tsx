/**
 * ADVERSARIAL PASS 3 (tester #2) — mobile-design-components-walkthrough — S2.
 *
 * The StrokeResult replay scrubber is an `adjustable` accessibility element:
 * VoiceOver swipe up/down fires `increment` / `decrement` and each step moves
 * the playhead by span/20. Attacks:
 *   - 50× increment from the very end and 50× decrement from the very start
 *     (clamping, no NaN, a11y `now` stays within [min, max], `text` is the
 *     "%.2fs" format);
 *   - seeded random interleaving of both actions (never leaves the clip);
 *   - an unknown action name is a no-op;
 *   - the native progress callback with hostile positions (NaN, > duration,
 *     negative) — the clock and a11y value must stay finite and in range.
 *
 * ClipPlayer is mocked as a passthrough View so the exact `onProgress`
 * callback ReplayCard hands the native view can be invoked directly;
 * `clipPlaybackAvailable` reports true so ReplayCard takes its native path
 * (the JS interval path is covered by other suites).
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import { StrokeResult } from '../../src/components/StrokeResult';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';

jest.mock('../../src/components/ClipPlayer', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    clipPlaybackAvailable: () => true,
    ClipPlayer: (props: Record<string, unknown>) =>
      ReactActual.createElement(RN.View, { testID: 'clip-player', ...props }),
  };
});

const SEED = 0x5eed2;

/** Deterministic xorshift32 — seed recorded above and in the log line. */
function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
}

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

interface A11yValue {
  min: number;
  max: number;
  now: number;
  text: string;
}

function renderResult(durationMs: number): Renderer {
  let renderer!: Renderer;
  act(() => {
    renderer = TestRenderer.create(
      <StrokeResult
        analysis={analysisFixture()}
        record={declaredRecord}
        clip={{ uri: 'file:///clips/a2.mov', durationMs }}
        currentAnalysisId="a2"
        onTryAgain={() => {}}
        onDone={() => {}}
      />,
    );
  });
  return renderer;
}

function scrubber(renderer: Renderer): Instance {
  return renderer.root.find(n => n.props.testID === 'stroke-result-scrubber');
}

function clipPlayer(renderer: Renderer): Instance {
  return renderer.root.find(n => n.props.testID === 'clip-player');
}

function a11y(renderer: Renderer): A11yValue {
  return scrubber(renderer).props.accessibilityValue as A11yValue;
}

function fire(renderer: Renderer, actionName: string) {
  act(() => {
    scrubber(renderer).props.onAccessibilityAction({
      nativeEvent: { actionName },
    });
  });
}

function clockText(renderer: Renderer): string {
  // The REPLAY header clock is the Text whose content matches the "%.2fs" /
  // hostile-number format; find every Text and return the ones ending in 's'.
  return renderer.root
    .findAll(n => String(n.type) === 'Text')
    .map(n => React.Children.toArray(n.props.children).join(''))
    .filter(t => /^[-0-9.NaInfinty]+s$/.test(t))
    .join('|');
}

const SECONDS_FORMAT = /^\d+\.\d{2}s$/;

function expectWellFormed(value: A11yValue, span: number) {
  expect(Number.isFinite(value.now)).toBe(true);
  expect(Number.isNaN(value.now)).toBe(false);
  expect(value.min).toBe(0);
  expect(value.max).toBe(span);
  expect(value.now).toBeGreaterThanOrEqual(value.min);
  expect(value.now).toBeLessThanOrEqual(value.max);
  expect(value.text).toMatch(SECONDS_FORMAT);
}

describe('ATTACK S2 — StrokeResult scrubber accessibility actions at the clip boundaries', () => {
  const DURATION = 3000; // 3.00s clip → span 3000, step 150ms

  it('precondition: scrubber renders as adjustable with a well-formed a11y value at 0', () => {
    const renderer = renderResult(DURATION);
    const node = scrubber(renderer);
    expect(node.props.accessibilityRole).toBe('adjustable');
    expect(node.props.accessibilityActions).toEqual([
      { name: 'increment' },
      { name: 'decrement' },
    ]);
    expect(a11y(renderer)).toEqual({
      min: 0,
      max: DURATION,
      now: 0,
      text: '0.00s',
    });
    act(() => renderer.unmount());
  });

  it('increment 50× from the start clamps at the end (span) with formatted text and no NaN', () => {
    const renderer = renderResult(DURATION);
    for (let i = 0; i < 50; i++) {
      fire(renderer, 'increment');
      expectWellFormed(a11y(renderer), DURATION);
    }
    expect(a11y(renderer)).toEqual({
      min: 0,
      max: DURATION,
      now: DURATION,
      text: '3.00s',
    });
    // The native player got the clamped seek (clip-relative ms).
    expect(clipPlayer(renderer).props.seekMs).toBe(DURATION);
    expect(clockText(renderer)).toContain('3.00s');
    act(() => renderer.unmount());
  });

  it('increment 50× AT the end (already clamped) stays exactly at the end', () => {
    const renderer = renderResult(DURATION);
    for (let i = 0; i < 20; i++) fire(renderer, 'increment');
    expect(a11y(renderer).now).toBe(DURATION);
    for (let i = 0; i < 50; i++) {
      fire(renderer, 'increment');
      const value = a11y(renderer);
      expectWellFormed(value, DURATION);
      expect(value.now).toBe(DURATION);
      expect(value.text).toBe('3.00s');
    }
    act(() => renderer.unmount());
  });

  it('decrement 50× at the start stays exactly at 0 with "0.00s"', () => {
    const renderer = renderResult(DURATION);
    for (let i = 0; i < 50; i++) {
      fire(renderer, 'decrement');
      const value = a11y(renderer);
      expectWellFormed(value, DURATION);
      expect(value.now).toBe(0);
      expect(value.text).toBe('0.00s');
    }
    expect(clipPlayer(renderer).props.seekMs).toBe(0);
    act(() => renderer.unmount());
  });

  it('decrement 50× from the end walks back to 0 and never below', () => {
    const renderer = renderResult(DURATION);
    for (let i = 0; i < 50; i++) fire(renderer, 'increment');
    expect(a11y(renderer).now).toBe(DURATION);
    for (let i = 0; i < 50; i++) {
      fire(renderer, 'decrement');
      expectWellFormed(a11y(renderer), DURATION);
    }
    expect(a11y(renderer).now).toBe(0);
    expect(a11y(renderer).text).toBe('0.00s');
    act(() => renderer.unmount());
  });

  it(`seeded random interleaving (seed=0x${SEED.toString(16)}, 400 actions) never leaves [0, span]`, () => {
    console.log(`[ATTACK S2] interleave seed=0x${SEED.toString(16)}`);
    const rng = makeRng(SEED);
    const renderer = renderResult(DURATION);
    let expected = 0;
    const step = DURATION / 20;
    for (let i = 0; i < 400; i++) {
      const action = rng() < 0.5 ? 'increment' : 'decrement';
      fire(renderer, action);
      expected = Math.min(
        DURATION,
        Math.max(0, expected + (action === 'increment' ? step : -step)),
      );
      const value = a11y(renderer);
      expectWellFormed(value, DURATION);
      expect(value.now).toBe(Math.round(expected));
    }
    act(() => renderer.unmount());
  });

  it('unknown / hostile action names are ignored (no move, no throw)', () => {
    const renderer = renderResult(DURATION);
    fire(renderer, 'increment');
    const before = a11y(renderer);
    for (const name of ['activate', '', 'INCREMENT', 'increment ', '\u0000']) {
      expect(() => fire(renderer, name)).not.toThrow();
      expect(a11y(renderer)).toEqual(before);
    }
    act(() => renderer.unmount());
  });

  it('odd span (2999ms): fractional steps still round to an integer `now` and clamp cleanly', () => {
    const renderer = renderResult(2999);
    for (let i = 0; i < 50; i++) {
      fire(renderer, 'increment');
      const value = a11y(renderer);
      expectWellFormed(value, 2999);
      expect(Number.isInteger(value.now)).toBe(true);
    }
    expect(a11y(renderer).now).toBe(2999);
    expect(a11y(renderer).text).toBe('3.00s');
    act(() => renderer.unmount());
  });

  it('1ms clip: step is 0.05ms; 50 increments still end exactly at 1', () => {
    const renderer = renderResult(1);
    for (let i = 0; i < 50; i++) fire(renderer, 'increment');
    const value = a11y(renderer);
    expectWellFormed(value, 1);
    expect(value.now).toBe(1);
    act(() => renderer.unmount());
  });
});

describe('ATTACK S2b — native progress events with hostile positions', () => {
  const DURATION = 3000;

  function progress(renderer: Renderer, positionMs: number) {
    act(() => {
      (clipPlayer(renderer).props.onProgress as (ms: number) => void)(
        positionMs,
      );
    });
  }

  it('positionMs beyond the clip duration: a11y `now` must not exceed `max`', () => {
    const renderer = renderResult(DURATION);
    progress(renderer, DURATION + 250);
    const value = a11y(renderer);
    console.log(
      `[ATTACK S2b] progress ${DURATION + 250} → now=${value.now} max=${value.max} text=${value.text} clock=${clockText(renderer)}`,
    );
    expect(value.now).toBeLessThanOrEqual(value.max);
    expect(value.text).toBe('3.00s');
    act(() => renderer.unmount());
  });

  it('positionMs = NaN (corrupt CMTime): clock and a11y value must stay finite', () => {
    const renderer = renderResult(DURATION);
    progress(renderer, 750);
    progress(renderer, Number.NaN);
    const value = a11y(renderer);
    console.log(
      `[ATTACK S2b] progress NaN → now=${value.now} text=${value.text} clock=${clockText(renderer)}`,
    );
    expect(Number.isNaN(value.now)).toBe(false);
    expect(value.text).toMatch(SECONDS_FORMAT);
    expect(clockText(renderer)).not.toContain('NaN');
    act(() => renderer.unmount());
  });

  it('positionMs negative: clamps to 0.00s and `now` >= min', () => {
    const renderer = renderResult(DURATION);
    progress(renderer, -500);
    const value = a11y(renderer);
    console.log(
      `[ATTACK S2b] progress -500 → now=${value.now} text=${value.text}`,
    );
    expect(value.text).toBe('0.00s');
    expect(value.now).toBeGreaterThanOrEqual(0);
    act(() => renderer.unmount());
  });

  it('after a hostile progress event, an increment still lands on a clamped, finite value', () => {
    const renderer = renderResult(DURATION);
    progress(renderer, Number.NaN);
    fire(renderer, 'increment');
    const value = a11y(renderer);
    console.log(
      `[ATTACK S2b] NaN then increment → now=${value.now} text=${value.text}`,
    );
    expect(Number.isFinite(value.now)).toBe(true);
    expect(value.text).toMatch(SECONDS_FORMAT);
    act(() => renderer.unmount());
  });
});
