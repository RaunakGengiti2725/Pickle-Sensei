import { stabilitySlo } from '../src/analysis/stabilityTelemetry';
import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  tryAgainFromResult,
  type TryAgainHandoff,
} from '../src/screens/tryAgainHandoff';

/**
 * Adversarial pass 3 — TRY AGAIN handoff versus the wall clock.
 *
 * The handoff is a single-shot, TTL-bounded module register keyed on
 * `Date.now()`. These attacks probe the exact TTL boundary and what happens
 * when the wall clock does not move forward monotonically (NTP correction,
 * user changing the device time, restore from backup): a stale declared
 * handoff that survives seeds a later, unrelated capture with the wrong
 * technique profile.
 */

function declaredHandoff(stroke: 'backhand_drive' | 'forehand_drive') {
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

function kinds(): string[] {
  return stabilitySlo.events().map(event => event.kind);
}

function failureReasons(): string[] {
  return stabilitySlo
    .events()
    .flatMap(event =>
      event.kind === 'try_again_failed' ? [event.reason] : [],
    );
}

const ARMED_AT = new Date('2026-09-04T12:00:00.000Z').getTime();

describe('attack — TRY_AGAIN_HANDOFF_TTL_MS boundary', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(ARMED_AT);
    stabilitySlo.reset();
    clearTryAgainHandoff();
  });

  afterEach(() => {
    clearTryAgainHandoff();
    jest.useRealTimers();
  });

  it('exactly TTL ms after arming is still consumed (boundary is inclusive: `>` not `>=`)', () => {
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(Date.now() - ARMED_AT).toBe(30_000);

    // Documented contract check: the predicate is `elapsed > TTL`, so an
    // elapsed time of exactly TTL is treated as fresh. Whichever way the
    // boundary is meant to go, peek and consume must agree with each other
    // and telemetry must describe what actually happened.
    expect(peekTryAgainHandoff()).not.toBeNull();
    const consumed = consumeTryAgainHandoff();
    expect(consumed).toEqual<TryAgainHandoff>({
      source: 'camera',
      declaredStroke: 'backhand_drive',
      declaredCanonical: 'BACKHAND_DRIVE',
      auto: false,
      sessionId: null,
    });
    expect(kinds()).toEqual(['try_again_rearmed']);
    expect(failureReasons()).toEqual([]);
    // Single-shot: the boundary consume still clears the register.
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual(['try_again_rearmed']);
  });

  it('one millisecond past TTL expires and records try_again_failed{handoff_expired} exactly once', () => {
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS + 1);

    expect(peekTryAgainHandoff()).toBeNull();
    // peek is read-only: it must not emit telemetry nor clear the register.
    expect(kinds()).toEqual([]);

    expect(consumeTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual(['try_again_failed']);
    expect(failureReasons()).toEqual(['handoff_expired']);

    // A second consume of the already-cleared register is a no-op: no
    // duplicate failure event, no resurrected handoff.
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(kinds()).toEqual(['try_again_failed']);
  });

  it('a sweep across the boundary flips exactly at TTL + 1 ms', () => {
    const outcomes: Array<[number, 'fresh' | 'expired']> = [];
    for (const delta of [
      0,
      1,
      TRY_AGAIN_HANDOFF_TTL_MS - 1,
      TRY_AGAIN_HANDOFF_TTL_MS,
      TRY_AGAIN_HANDOFF_TTL_MS + 1,
      TRY_AGAIN_HANDOFF_TTL_MS * 2,
    ]) {
      jest.setSystemTime(ARMED_AT);
      armTryAgain(declaredHandoff('forehand_drive'));
      jest.setSystemTime(ARMED_AT + delta);
      outcomes.push([
        delta,
        consumeTryAgainHandoff() === null ? 'expired' : 'fresh',
      ]);
    }
    expect(outcomes).toEqual([
      [0, 'fresh'],
      [1, 'fresh'],
      [TRY_AGAIN_HANDOFF_TTL_MS - 1, 'fresh'],
      [TRY_AGAIN_HANDOFF_TTL_MS, 'fresh'],
      [TRY_AGAIN_HANDOFF_TTL_MS + 1, 'expired'],
      [TRY_AGAIN_HANDOFF_TTL_MS * 2, 'expired'],
    ]);
  });

  it('re-arming restarts the TTL from the newest arm, never the first', () => {
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS - 1);
    armTryAgain(declaredHandoff('forehand_drive'));
    // 29.999 s + 20 s is past the FIRST arm's TTL but inside the second's.
    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS - 1 + 20_000);
    expect(consumeTryAgainHandoff()?.declaredStroke).toBe('forehand_drive');
    expect(kinds()).toEqual(['try_again_rearmed']);
  });
});

describe('attack — wall clock moving backwards (clock skew)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(ARMED_AT);
    stabilitySlo.reset();
    clearTryAgainHandoff();
  });

  afterEach(() => {
    clearTryAgainHandoff();
    jest.useRealTimers();
  });

  const TEN_MINUTES_MS = 10 * 60_000;

  it('a handoff armed before a 10-minute backwards clock step is NOT fresh for the whole skew window', () => {
    armTryAgain(declaredHandoff('backhand_drive'));

    // The device clock is corrected 10 minutes backwards (NTP / user edit).
    jest.setSystemTime(ARMED_AT - TEN_MINUTES_MS);
    expect(Date.now() - ARMED_AT).toBe(-TEN_MINUTES_MS);

    // Then real time keeps passing on the skewed timeline: well past the TTL
    // of one tap's navigation (2 minutes of wall time since the arm).
    jest.setSystemTime(ARMED_AT - TEN_MINUTES_MS + 2 * 60_000);

    // The handoff is a continuation of one tap and its navigation; two real
    // minutes later it must be expired regardless of what the clock says.
    // Negative elapsed time is not "fresh" — it is an unmeasurable interval.
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
  });

  it('the stale handoff survives for skew + TTL: fresh at 10m29.999s of skewed wall time, gone at 10m30.001s', () => {
    // Characterises the exact size of the window the previous test attacks so
    // the failure is reproducible to the millisecond.
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(ARMED_AT - TEN_MINUTES_MS);

    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(peekTryAgainHandoff()).not.toBeNull();
    jest.setSystemTime(ARMED_AT + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
  });

  it('a clock jump forward past the TTL expires even when the process just armed (forward skew is safe)', () => {
    armTryAgain(declaredHandoff('forehand_drive'));
    jest.setSystemTime(ARMED_AT + 365 * 24 * 60 * 60_000);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
  });

  it('a backwards jump does not leak the handoff into the NEXT arm after it is cleared', () => {
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(ARMED_AT - TEN_MINUTES_MS);
    clearTryAgainHandoff();
    expect(consumeTryAgainHandoff()).toBeNull();
    // Nothing armed, nothing to report: clearing is silent.
    expect(kinds()).toEqual([]);
  });
});
