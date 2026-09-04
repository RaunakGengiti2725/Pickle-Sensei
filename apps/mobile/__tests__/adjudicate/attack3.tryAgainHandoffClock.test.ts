/**
 * ADVERSARIAL PASS 3 — tryAgainHandoff: clock skew, double consume,
 * telemetry accounting, and hostile strokeIntent envelopes.
 *
 * The TTL is measured on `Date.now()` (wall clock). A wall clock is not
 * monotonic: NTP corrections and manual changes move it in both directions.
 * These probes record exactly what the 30 s contract does under skew.
 */
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

function declared(
  stroke: 'backhand_drive' | 'forehand_drive',
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
    { shotType: stroke, sessionId: 'set-1' },
  );
}

function tryAgainEvents() {
  return stabilitySlo
    .events()
    .filter(event => event.kind.startsWith('try_again'))
    .map(event =>
      event.kind === 'try_again_failed'
        ? `${event.kind}:${event.reason}`
        : event.kind,
    );
}

const T0 = new Date('2026-09-04T12:00:00.000Z').getTime();

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
  clearTryAgainHandoff();
  stabilitySlo.reset();
});

afterEach(() => {
  clearTryAgainHandoff();
  stabilitySlo.reset();
  jest.useRealTimers();
});

describe('TTL boundary', () => {
  it('exactly TTL ms after arming is still valid; TTL+1 is expired', () => {
    armTryAgain(declared('forehand_drive'));
    jest.setSystemTime(T0 + TRY_AGAIN_HANDOFF_TTL_MS);
    expect(peekTryAgainHandoff()).not.toBeNull();
    jest.setSystemTime(T0 + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(tryAgainEvents()).toEqual(['try_again_failed:handoff_expired']);
  });

  it('expired consume clears the slot: a second consume records NOTHING more', () => {
    armTryAgain(declared('forehand_drive'));
    jest.setSystemTime(T0 + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(tryAgainEvents()).toEqual(['try_again_failed:handoff_expired']);
  });

  it('20 consumes after one arm yield exactly one handoff and one rearmed event', () => {
    armTryAgain(declared('backhand_drive'));
    const results = Array.from({ length: 20 }, () => consumeTryAgainHandoff());
    expect(results.filter(r => r !== null)).toHaveLength(1);
    expect(results[0]?.declaredStroke).toBe('backhand_drive');
    expect(tryAgainEvents()).toEqual(['try_again_rearmed']);
  });

  it('re-arming after an expiry replaces the stale slot; only the live one counts', () => {
    armTryAgain(declared('backhand_drive'));
    jest.setSystemTime(T0 + TRY_AGAIN_HANDOFF_TTL_MS + 5_000);
    armTryAgain(declared('forehand_drive'));
    expect(consumeTryAgainHandoff()?.declaredStroke).toBe('forehand_drive');
    expect(tryAgainEvents()).toEqual(['try_again_rearmed']);
  });
});

describe('wall-clock skew (Date.now is not monotonic)', () => {
  it('clock stepped BACK 1 h right after the tap: the abandoned handoff does NOT expire for the next hour', () => {
    // User taps TRY AGAIN, the navigation never lands (backgrounded), and
    // the device clock is corrected backwards by one hour.
    armTryAgain(declared('backhand_drive'));
    jest.setSystemTime(T0 - 60 * 60 * 1000);
    // Five minutes of real time later the user starts an unrelated capture.
    jest.setSystemTime(T0 - 60 * 60 * 1000 + 5 * 60 * 1000);
    const handoff = consumeTryAgainHandoff();
    // Contract (tryAgainHandoff.ts): "An armed handoff whose navigation never
    // landed ... must expire instead of seeding a later, unrelated capture."
    // Under a backwards step it is still handed to the unrelated capture.
    expect(handoff).not.toBeNull();
    expect(handoff?.declaredStroke).toBe('backhand_drive');
    expect(tryAgainEvents()).toEqual(['try_again_rearmed']);
  });

  it('clock stepped FORWARD 31 s during the tap→Analyze navigation: the re-arm the user asked for is dropped', () => {
    armTryAgain(declared('forehand_drive'));
    // ~200 ms of real navigation time, but the wall clock jumps +31 s
    // (NTP correction landing mid-transition).
    jest.setSystemTime(T0 + 200 + TRY_AGAIN_HANDOFF_TTL_MS + 800);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(tryAgainEvents()).toEqual(['try_again_failed:handoff_expired']);
  });

  it('Date.now() returning NaN (broken clock) never throws; the handoff is treated as valid', () => {
    armTryAgain(declared('forehand_drive'));
    const spy = jest.spyOn(Date, 'now').mockReturnValue(Number.NaN);
    try {
      expect(() => peekTryAgainHandoff()).not.toThrow();
      // NaN - n > TTL is false → not expired.
      expect(peekTryAgainHandoff()).not.toBeNull();
      expect(consumeTryAgainHandoff()).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('hostile strokeIntent envelopes', () => {
  const base = {
    predictedStroke: null,
    resolutionBasis: 'declared' as const,
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  };

  it('a canonical from a DIFFERENT technique than the declared slug is dropped, not trusted', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          ...base,
          declaredStroke: 'forehand_drive',
          resolvedProfileId: 'BACKHAND_DINK',
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(handoff.declaredCanonical).toBeNull();
    // ...and the picker intent falls back to the slug's unique canonical.
    expect(techniqueIntentFromHandoff(handoff)?.canonical).toBe(
      'FOREHAND_DRIVE',
    );
  });

  it('unicode / huge / lookalike resolvedProfileId never throws and never becomes a canonical', () => {
    for (const bad of [
      'FOREHAND_DRIVE\u200b',
      'forehand_drive',
      'FOREHAND_DRİVE',
      'F'.repeat(1 << 16),
      '🥒'.repeat(100),
      '',
      ' FOREHAND_DRIVE ',
    ]) {
      const handoff = tryAgainFromResult(
        {
          strokeIntent: {
            ...base,
            declaredStroke: 'forehand_drive',
            resolvedProfileId: bad,
          },
        },
        { shotType: 'forehand_drive' },
      );
      expect(handoff.declaredCanonical).toBeNull();
      expect(handoff.declaredStroke).toBe('forehand_drive');
    }
  });

  it('resolutionBasis ≠ declared drops the canonical even when it matches the slug', () => {
    for (const basis of ['predicted', 'fallback', 'unknown'] as const) {
      const handoff = tryAgainFromResult(
        {
          strokeIntent: {
            ...base,
            resolutionBasis: basis as never,
            declaredStroke: 'forehand_drive',
            resolvedProfileId: 'FOREHAND_DRIVE',
          },
        },
        { shotType: 'forehand_drive' },
      );
      expect(handoff.declaredCanonical).toBeNull();
    }
  });

  it('an intent whose declaration disagrees with the analyzed shotType re-arms the DECLARATION, never the analysis', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          ...base,
          declaredStroke: 'backhand_drive',
          resolvedProfileId: 'BACKHAND_DRIVE',
        },
      },
      { shotType: 'forehand_drive', sessionId: 'set-9' },
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: 'backhand_drive',
      declaredCanonical: 'BACKHAND_DRIVE',
      auto: false,
      sessionId: 'set-9',
    });
  });

  it('sessionId is carried verbatim (unicode / huge) — never trimmed, never invented', () => {
    const weird = ' 「set」\u200b'.repeat(200);
    expect(
      tryAgainFromResult(null, { shotType: 'dink', sessionId: weird })
        .sessionId,
    ).toBe(weird);
    expect(
      tryAgainFromResult(null, { shotType: 'dink', sessionId: '' }).sessionId,
    ).toBe('');
    expect(tryAgainFromResult(null, null).sessionId).toBeNull();
  });
});
