import { stabilitySlo } from '../src/analysis/stabilityTelemetry';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  peekTryAgainOrigin,
  TRY_AGAIN_HANDOFF_TTL_MS,
  TRY_AGAIN_STACK_LIMIT,
  tryAgainFromResult,
  tryAgainStackDepth,
} from '../src/screens/tryAgainHandoff';

/**
 * W09-08 — Try Again handoff over repeated cycles and across accounts.
 *
 * Result → TRY AGAIN → Analyze → Result → TRY AGAIN … is the one loop a
 * player repeats many times in a sitting. The handoff module keeps that
 * chain as a BOUNDED stack of hops whose bottom entry is always the retry
 * armed from the original clip, and a hop armed under one account owner
 * generation is never consumed under another — including A → B → A, which
 * is a new generation of A, not the old one.
 */

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

function declaredHandoff(
  stroke: 'backhand_drive' | 'forehand_drive',
  sessionId: string | null = null,
) {
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
    { shotType: stroke, sessionId },
  );
}

function failureReasons(): string[] {
  return stabilitySlo
    .events()
    .flatMap(event =>
      event.kind === 'try_again_failed' ? [event.reason] : [],
    );
}

function rearmedCount(): number {
  return stabilitySlo
    .events()
    .filter(event => event.kind === 'try_again_rearmed').length;
}

beforeEach(() => {
  stabilitySlo.reset();
  clearTryAgainHandoff();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  jest.useRealTimers();
  clearTryAgainHandoff();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('W09-08 — stale handoffs across owner generation changes', () => {
  it('a handoff armed under one account is never consumed under another', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    setActiveDataOwner(OWNER_B);

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(rearmedCount()).toBe(0);
    expect(failureReasons()).toEqual(['owner_changed']);
    expect(tryAgainStackDepth()).toBe(0);
  });

  it('A → B → A is a new generation of A: the old handoff is not revived', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('forehand_drive'));
    setActiveDataOwner(OWNER_B);
    setActiveDataOwner(OWNER_A);

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['owner_changed']);
  });

  it('local (guest) → signed-in is an owner change too', () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    armTryAgain(declaredHandoff('backhand_drive'));
    setActiveDataOwner(OWNER_A);

    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['owner_changed']);
  });

  it('the same owner generation still re-arms the capture that follows the tap', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('forehand_drive'));

    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
      sessionId: null,
    });
    expect(rearmedCount()).toBe(1);
    expect(failureReasons()).toEqual([]);
  });

  it("re-arming under the new account starts that account's own chain", () => {
    setActiveDataOwner(OWNER_A);
    const originalA = declaredHandoff('backhand_drive', 'set-a');
    armTryAgain(originalA);
    expect(consumeTryAgainHandoff()).toEqual(originalA);
    armTryAgain(declaredHandoff('backhand_drive', 'set-a'));
    expect(consumeTryAgainHandoff()).toEqual(originalA);
    expect(tryAgainStackDepth()).toBe(2);
    expect(peekTryAgainOrigin()).toEqual(originalA);

    setActiveDataOwner(OWNER_B);
    expect(peekTryAgainOrigin()).toBeNull();
    const originalB = declaredHandoff('forehand_drive', 'set-b');
    armTryAgain(originalB);

    expect(tryAgainStackDepth()).toBe(1);
    expect(peekTryAgainOrigin()).toEqual(originalB);
    expect(consumeTryAgainHandoff()).toEqual(originalB);
    expect(consumeTryAgainHandoff()).toBeNull();
  });
});

describe('W09-08 — bounded Try Again chain', () => {
  it('consecutive cycles never grow past the limit and keep the original clip entry', () => {
    setActiveDataOwner(OWNER_A);
    const original = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(original);
    expect(consumeTryAgainHandoff()).toEqual(original);
    expect(tryAgainStackDepth()).toBe(1);

    for (let cycle = 1; cycle <= TRY_AGAIN_STACK_LIMIT + 3; cycle += 1) {
      const hop = declaredHandoff('backhand_drive', `set-1-hop-${cycle}`);
      armTryAgain(hop);
      expect(peekTryAgainHandoff()).toEqual(hop);
      expect(consumeTryAgainHandoff()).toEqual(hop);
      expect(consumeTryAgainHandoff()).toBeNull();
      expect(tryAgainStackDepth()).toBeLessThanOrEqual(TRY_AGAIN_STACK_LIMIT);
      expect(peekTryAgainOrigin()).toEqual(original);
    }

    expect(tryAgainStackDepth()).toBe(TRY_AGAIN_STACK_LIMIT);
    expect(rearmedCount()).toBe(TRY_AGAIN_STACK_LIMIT + 4);
    expect(failureReasons()).toEqual([]);
  });

  it('a re-arm before the pending hop was consumed replaces it instead of stacking', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    armTryAgain(declaredHandoff('forehand_drive'));

    expect(tryAgainStackDepth()).toBe(1);
    expect(consumeTryAgainHandoff()?.declaredStroke).toBe('forehand_drive');
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(tryAgainStackDepth()).toBe(1);
  });

  it('starting capture from another entry point drops the whole chain', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(tryAgainStackDepth()).toBe(2);

    clearTryAgainHandoff();

    expect(tryAgainStackDepth()).toBe(0);
    expect(peekTryAgainOrigin()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
  });

  it('an expired pending hop ends the chain instead of seeding a later capture', () => {
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
    expect(tryAgainStackDepth()).toBe(0);
    expect(peekTryAgainOrigin()).toBeNull();
  });
});
