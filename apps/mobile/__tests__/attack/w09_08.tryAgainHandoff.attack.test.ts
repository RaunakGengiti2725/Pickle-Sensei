import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  isDataOwnerContextCurrent,
  getDataOwnerSnapshot,
  setActiveDataOwner,
} from '../../src/data/accountScope';
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
  type TryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';

/**
 * W09-08 adversarial suite — attacks against the bounded Try Again hop stack
 * at its failure boundaries. Each test asserts the behaviour the objective /
 * product invariants demand; a failing test is a confirmed break of the
 * candidate (315fb2ef), not of this suite.
 */

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

function declaredHandoff(
  stroke: 'backhand_drive' | 'forehand_drive',
  sessionId: string | null = null,
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

describe('ATTACK 1 — wall-clock rollback', () => {
  it('a handoff armed before the device clock is set back does not outlive its TTL', () => {
    // The TTL exists so that a re-arm whose navigation never landed cannot
    // seed a later, unrelated capture (h27). `Date.now()` is the wall clock:
    // if the device clock is set back (NTP correction, time-zone fix,
    // manual change) right after the tap, `now - armedAt` goes negative and
    // the handoff stays live for the rollback amount PLUS the TTL.
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    jest.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
    armTryAgain(declaredHandoff('backhand_drive'));

    // Clock goes back one hour, then a full TTL and more elapses on it.
    jest.setSystemTime(
      new Date('2026-09-08T11:00:00.000Z').getTime() +
        TRY_AGAIN_HANDOFF_TTL_MS +
        1,
    );

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
  });

  it('a clock rollback while a consumed chain exists does not revive the consumed hop', () => {
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    jest.setSystemTime(new Date('2026-09-08T12:00:00.000Z'));
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    jest.setSystemTime(new Date('2026-09-08T11:00:00.000Z'));

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(rearmedCount()).toBe(1);
  });
});

describe('ATTACK 2 — signed-out owner is not a consumable owner', () => {
  it('a handoff armed under the signed-out owner is not consumed (mirrors isDataOwnerContextCurrent)', () => {
    // accountScope's canonical predicate refuses SIGNED_OUT contexts: "a
    // signed-out process has no readable/writable product bucket". The
    // handoff module re-implements the owner check and drops that clause.
    expect(getDataOwnerSnapshot().ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(isDataOwnerContextCurrent(getDataOwnerSnapshot())).toBe(false);

    armTryAgain(declaredHandoff('backhand_drive'));

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(rearmedCount()).toBe(0);
  });
});

describe('ATTACK 3 — owner change after the top hop was consumed', () => {
  it('a dead chain does not linger: depth is 0 and origin is null once the owner changed', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive', 'set-a'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    armTryAgain(declaredHandoff('backhand_drive', 'set-a'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    expect(tryAgainStackDepth()).toBe(2);

    setActiveDataOwner(OWNER_B);

    expect(peekTryAgainOrigin()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    // The chain belongs to a previous owner generation: it must be gone,
    // exactly as it is when the top hop was still pending (candidate test
    // "a handoff armed under one account is never consumed under another"
    // pins depth 0 for that case).
    expect(tryAgainStackDepth()).toBe(0);
  });

  it('A → B → A after a consumed chain: the old chain is not reported as depth for the new generation', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    setActiveDataOwner(OWNER_B);
    setActiveDataOwner(OWNER_A);

    expect(peekTryAgainOrigin()).toBeNull();
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(tryAgainStackDepth()).toBe(0);
  });
});

describe('ATTACK 4 — aliasing: the consumer can rewrite the original clip entry', () => {
  it('mutating the handoff returned by consume does not alter the preserved origin', () => {
    setActiveDataOwner(OWNER_A);
    const original = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(original);
    const consumed = consumeTryAgainHandoff();
    expect(consumed).toEqual(original);

    // A consumer (or the arming screen, which still holds its reference)
    // writes to the object it was handed.
    (consumed as { declaredStroke: string | null }).declaredStroke =
      'forehand_drive';
    (consumed as { sessionId: string | null }).sessionId = 'set-999';

    expect(peekTryAgainOrigin()).toEqual({
      source: 'camera',
      declaredStroke: 'backhand_drive',
      declaredCanonical: 'BACKHAND_DRIVE',
      auto: false,
      sessionId: 'set-1',
    });
  });

  it('mutating the object passed to armTryAgain after the tap does not alter the pending hop', () => {
    setActiveDataOwner(OWNER_A);
    const handoff = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(handoff);
    (handoff as { auto: boolean }).auto = true;
    (handoff as { declaredStroke: string | null }).declaredStroke = null;

    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'backhand_drive',
      declaredCanonical: 'BACKHAND_DRIVE',
      auto: false,
      sessionId: 'set-1',
    });
  });
});

describe('ATTACK 5 — chain identity vs. the clip it started from', () => {
  it('a Try Again from a different practice set starts a new chain with its own origin', () => {
    // Result(clip 1, set-1) → TRY AGAIN → Analyze → Result → … is one chain.
    // Leaving that loop, opening a different saved clip (set-2) from the
    // Library and tapping TRY AGAIN there is a NEW original clip, not hop 3
    // of the set-1 chain.
    setActiveDataOwner(OWNER_A);
    const originalSet1 = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(originalSet1);
    expect(consumeTryAgainHandoff()).toEqual(originalSet1);

    const originalSet2 = declaredHandoff('forehand_drive', 'set-2');
    armTryAgain(originalSet2);
    expect(consumeTryAgainHandoff()).toEqual(originalSet2);

    expect(peekTryAgainOrigin()).toEqual(originalSet2);
  });
});

describe('ATTACK 6 — double submit / interleaved consumers', () => {
  it('two Analyze mounts racing for one tap: exactly one re-arm, no second fabricated declaration', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('forehand_drive'));
    const first = consumeTryAgainHandoff();
    const second = consumeTryAgainHandoff();

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(rearmedCount()).toBe(1);
    expect(failureReasons()).toEqual([]);
  });

  it('double-tapping TRY AGAIN before navigating keeps exactly one pending hop and the chain bound', () => {
    setActiveDataOwner(OWNER_A);
    const original = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(original);
    expect(consumeTryAgainHandoff()).toEqual(original);
    for (let cycle = 0; cycle < TRY_AGAIN_STACK_LIMIT * 3; cycle += 1) {
      const hop = declaredHandoff('backhand_drive', `set-1-${cycle}`);
      armTryAgain(hop);
      armTryAgain(hop);
      armTryAgain(hop);
      expect(consumeTryAgainHandoff()).toEqual(hop);
      expect(tryAgainStackDepth()).toBeLessThanOrEqual(TRY_AGAIN_STACK_LIMIT);
      expect(peekTryAgainOrigin()).toEqual(original);
    }
    expect(rearmedCount()).toBe(TRY_AGAIN_STACK_LIMIT * 3 + 1);
  });

  it('owner switch interleaved between two racing consumers gives neither a stale handoff', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('forehand_drive'));
    setActiveDataOwner(OWNER_B);
    expect(consumeTryAgainHandoff()).toBeNull();
    setActiveDataOwner(OWNER_A);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(rearmedCount()).toBe(0);
    expect(failureReasons()).toEqual(['owner_changed']);
  });
});

describe('ATTACK 7 — owner cycles through every owner kind', () => {
  it('guest → signed-out → guest is a new guest generation: nothing revives', () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    armTryAgain(declaredHandoff('backhand_drive'));
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(GUEST_DATA_OWNER);

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['owner_changed']);
  });

  it('signed-in → signed-out (implicit sign-out on refused refresh) drops the pending re-arm', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);

    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['owner_changed']);
    expect(tryAgainStackDepth()).toBe(0);
  });

  it('B arms over A’s dead chain, then A returns: B’s chain is invisible to A and A starts clean', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive', 'set-a'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    setActiveDataOwner(OWNER_B);
    armTryAgain(declaredHandoff('forehand_drive', 'set-b'));
    setActiveDataOwner(OWNER_A);

    expect(peekTryAgainOrigin()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    const fresh = declaredHandoff('backhand_drive', 'set-a2');
    armTryAgain(fresh);
    expect(tryAgainStackDepth()).toBe(1);
    expect(peekTryAgainOrigin()).toEqual(fresh);
    expect(consumeTryAgainHandoff()).toEqual(fresh);
  });
});

describe('ATTACK 8 — TTL boundaries', () => {
  it('exactly TTL ms after the tap the handoff is still live; one ms later it is not', () => {
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    const armedAt = Date.now();
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(armedAt + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(peekTryAgainHandoff()).not.toBeNull();
    jest.setSystemTime(armedAt + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
  });

  it('a far-future clock jump expires the pending hop and never revives consumed hops', () => {
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive'));
    expect(consumeTryAgainHandoff()).not.toBeNull();
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(new Date('2099-01-01T00:00:00.000Z'));

    expect(consumeTryAgainHandoff()).toBeNull();
    expect(failureReasons()).toEqual(['handoff_expired']);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(rearmedCount()).toBe(1);
  });

  it('re-arming over an expired pending hop is a fresh tap: consumable, chain origin kept', () => {
    jest.useFakeTimers();
    setActiveDataOwner(OWNER_A);
    const original = declaredHandoff('backhand_drive', 'set-1');
    armTryAgain(original);
    expect(consumeTryAgainHandoff()).toEqual(original);
    armTryAgain(declaredHandoff('backhand_drive', 'stale'));
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    const fresh = declaredHandoff('forehand_drive', 'fresh');
    armTryAgain(fresh);

    expect(consumeTryAgainHandoff()).toEqual(fresh);
    expect(peekTryAgainOrigin()).toEqual(original);
    expect(tryAgainStackDepth()).toBe(2);
  });
});

describe('ATTACK 9 — eviction order under the limit', () => {
  it('eviction removes the oldest intermediate hop, never the origin nor the newest hop', () => {
    setActiveDataOwner(OWNER_A);
    const original = declaredHandoff('backhand_drive', 'origin');
    armTryAgain(original);
    expect(consumeTryAgainHandoff()).toEqual(original);
    const seen: Array<string | null> = [];
    for (let cycle = 1; cycle <= 10; cycle += 1) {
      const hop = declaredHandoff('backhand_drive', `hop-${cycle}`);
      armTryAgain(hop);
      expect(tryAgainStackDepth()).toBeLessThanOrEqual(TRY_AGAIN_STACK_LIMIT);
      expect(peekTryAgainHandoff()).toEqual(hop);
      expect(peekTryAgainOrigin()).toEqual(original);
      seen.push(consumeTryAgainHandoff()?.sessionId ?? null);
    }
    expect(seen).toEqual(
      Array.from({ length: 10 }, (_, index) => `hop-${index + 1}`),
    );
    expect(tryAgainStackDepth()).toBe(TRY_AGAIN_STACK_LIMIT);
  });

  it('the pending origin itself is replaced by a second tap before navigation (single-shot semantics)', () => {
    setActiveDataOwner(OWNER_A);
    armTryAgain(declaredHandoff('backhand_drive', 'first-tap'));
    const secondTap = declaredHandoff('forehand_drive', 'second-tap');
    armTryAgain(secondTap);
    expect(tryAgainStackDepth()).toBe(1);
    expect(peekTryAgainOrigin()).toEqual(secondTap);
    expect(consumeTryAgainHandoff()).toEqual(secondTap);
  });
});
