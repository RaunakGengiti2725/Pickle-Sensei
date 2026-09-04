import React, { useState } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  techniqueIntentFromHandoff,
  tryAgainFromResult,
  type TryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

/**
 * Structural audit #2 (mobile-results-review) — TRY AGAIN handoff probes.
 *
 * Every test here is a probe for a suspected timing / lifecycle defect in
 * `tryAgainHandoff.ts` and its consumer in AnalyzeScreen's lazy `useState`
 * initializer. A failing probe is a finding; a passing probe is a verified
 * invariant. No production code is touched.
 */

function declared(
  stroke: 'forehand_drive' | 'backhand_drive',
): TryAgainHandoff {
  return tryAgainFromResult(
    {
      strokeIntent: {
        declaredStroke: stroke,
        predictedStroke: null,
        resolutionBasis: 'declared',
        resolvedProfileId: stroke.toUpperCase(),
        resolvedProfileVersion: 'technique-profile-v1',
        disagreement: null,
      },
    },
    { shotType: stroke },
  );
}

afterEach(() => {
  jest.useRealTimers();
  clearTryAgainHandoff();
});

describe('TTL vs wall clock', () => {
  it('a wall clock that moves BACKWARDS after arming does not expire the handoff', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    armTryAgain(declared('forehand_drive'));
    // NTP correction / manual clock change of -1h between the tap and the
    // camera mount.
    jest.setSystemTime(new Date('2026-09-04T11:00:00.000Z'));
    expect(peekTryAgainHandoff()).not.toBeNull();
    expect(consumeTryAgainHandoff()).toEqual(declared('forehand_drive'));
  });

  it('a wall clock that jumps FORWARD past the TTL expires it and records try_again_failed{handoff_expired} once', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    const spy = jest.spyOn(stabilitySlo, 'record');
    armTryAgain(declared('backhand_drive'));
    jest.setSystemTime(
      new Date('2026-09-04T12:00:00.000Z').getTime() +
        TRY_AGAIN_HANDOFF_TTL_MS +
        1,
    );
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      kind: 'try_again_failed',
      reason: 'handoff_expired',
    });
    // A second consume of an already-dropped handoff does not double-count.
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('exactly at the TTL boundary the handoff is still honoured (>= TTL, not >)', () => {
    jest.useFakeTimers();
    const t0 = new Date('2026-09-04T12:00:00.000Z').getTime();
    jest.setSystemTime(t0);
    armTryAgain(declared('forehand_drive'));
    jest.setSystemTime(t0 + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(peekTryAgainHandoff()).not.toBeNull();
  });
});

describe('consumer lifecycle (AnalyzeScreen lazy useState initializer)', () => {
  /** Mirrors AnalyzeScreen.tsx: `useState(() => consumeTryAgainHandoff())`. */
  function Consumer(props: { onValue: (v: TryAgainHandoff | null) => void }) {
    const [rearm] = useState(() => consumeTryAgainHandoff());
    props.onValue(rearm);
    return null;
  }

  it('React.StrictMode double-invokes the initializer yet the committed state still holds the handoff', () => {
    armTryAgain(declared('forehand_drive'));
    const seen: Array<TryAgainHandoff | null> = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <React.StrictMode>
          <Consumer onValue={v => seen.push(v)} />
        </React.StrictMode>,
      );
    });
    // Whatever StrictMode did with the double render, the LAST committed
    // value must be the handoff — otherwise the declaration is lost.
    expect(seen[seen.length - 1]).toEqual(declared('forehand_drive'));
    // And the module is now empty (single-shot).
    expect(peekTryAgainHandoff()).toBeNull();
    act(() => renderer.unmount());
  });

  it('a REMOUNT of the consumer (not a re-render) gets null: the handoff is single-shot by design', () => {
    armTryAgain(declared('forehand_drive'));
    const seen: Array<TryAgainHandoff | null> = [];
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<Consumer onValue={v => seen.push(v)} />);
    });
    expect(seen[0]).toEqual(declared('forehand_drive'));
    act(() => renderer.unmount());
    seen.length = 0;
    act(() => {
      renderer = TestRenderer.create(<Consumer onValue={v => seen.push(v)} />);
    });
    expect(seen[0]).toBeNull();
    act(() => renderer.unmount());
  });
});

describe('intent derivation edge cases', () => {
  it('a handoff whose slug does not match its canonical profile drops the canonical (never re-declares another profile)', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: 'forehand_drive',
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: 'BACKHAND_DRIVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(handoff.declaredStroke).toBe('forehand_drive');
    expect(handoff.declaredCanonical).toBeNull();
    const intent = techniqueIntentFromHandoff(handoff);
    expect(intent).not.toBeNull();
    expect(intent!.source).toBe('tap');
    expect(intent!.legacySlug).toBe('forehand_drive');
    expect(intent!.canonical).not.toBe('BACKHAND_DRIVE');
  });

  it('AUTO handoff re-arms AUTO even when a legacy analysis carries a shotType', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'FOREHAND_DRIVE',
            leaf: 'FOREHAND_DRIVE',
            taxonomyDepth: 1,
            confidence: 0.7,
            evidence: [],
            limitingFactors: [],
          },
          resolutionBasis: 'predicted_l3',
          resolvedProfileId: 'FOREHAND_DRIVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(handoff.auto).toBe(true);
    expect(handoff.declaredStroke).toBeNull();
    expect(techniqueIntentFromHandoff(handoff)?.source).toBe('auto');
  });
});
