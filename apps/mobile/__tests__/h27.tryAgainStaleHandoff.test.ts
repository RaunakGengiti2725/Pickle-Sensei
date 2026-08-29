import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  clearTryAgainHandoff,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  tryAgainFromResult,
} from '../src/screens/tryAgainHandoff';

/**
 * Wave H h27 red team — TRY AGAIN contamination.
 *
 * A re-arm that never lands (app backgrounded, user navigates elsewhere, an
 * import run instead of a capture) must not survive: otherwise a later,
 * unrelated capture is seeded with a declaration the player never made for
 * it — and a declared handoff seeds it at full confidence, which selects the
 * scoring profile of the wrong technique.
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

describe('abandoned TRY AGAIN handoff', () => {
  afterEach(() => {
    jest.useRealTimers();
    clearTryAgainHandoff();
  });

  it('expires instead of seeding a later unrelated capture', () => {
    jest.useFakeTimers();
    armTryAgain(declaredHandoff('backhand_drive'));
    jest.setSystemTime(Date.now() + TRY_AGAIN_HANDOFF_TTL_MS + 1);
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
  });

  it('still re-arms the capture that follows the tap immediately', () => {
    jest.useFakeTimers();
    armTryAgain(declaredHandoff('forehand_drive'));
    jest.setSystemTime(Date.now() + 1_000);
    expect(consumeTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
    });
  });

  it('is dropped explicitly when capture starts from another entry point', () => {
    armTryAgain(declaredHandoff('backhand_drive'));
    clearTryAgainHandoff();
    expect(consumeTryAgainHandoff()).toBeNull();
  });
});
