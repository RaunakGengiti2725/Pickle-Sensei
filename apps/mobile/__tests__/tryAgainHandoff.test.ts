import {
  armTryAgain,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  techniqueIntentFromHandoff,
  tryAgainFromResult,
} from '../src/screens/tryAgainHandoff';

/**
 * W8 — TRY AGAIN loop (MOBBIN brief §2): the handoff preserves the ORIGINAL
 * run's technique intent and capture mode, AUTO re-arms AUTO (a prediction
 * is never re-declared as the user's statement), and the module is
 * single-shot so a stale intent can never leak into a later, unrelated
 * capture.
 */

describe('tryAgainFromResult', () => {
  it('declared run → same declaration and canonical profile', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: 'forehand_drive',
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: 'FOREHAND_DRIVE',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
    });
  });

  it('AUTO run re-arms AUTO even when the classifier predicted a stroke', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: {
            taxonomyVersion: 'pickleball-stroke-taxonomy-v3',
            classifierVersion: 'stroke-heuristic-1 (uncalibrated)',
            label: 'OVERHEAD',
            leaf: 'OVERHEAD',
            taxonomyDepth: 1,
            confidence: 0.7,
            evidence: [],
            limitingFactors: [],
          },
          resolutionBasis: 'predicted_l3',
          resolvedProfileId: 'OVERHEAD',
          resolvedProfileVersion: 'technique-profile-v1',
          disagreement: null,
        },
      },
      { shotType: 'overhead' },
    );
    // The prediction is NOT converted into a declaration.
    expect(handoff.auto).toBe(true);
    expect(handoff.declaredStroke).toBeNull();
  });

  it('abstained AUTO run re-arms AUTO', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: null,
          predictedStroke: null,
          resolutionBasis: 'abstained',
          resolvedProfileId: null,
          resolvedProfileVersion: null,
          disagreement: null,
        },
      },
      null,
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
    });
  });

  it('legacy record without an envelope re-declares its analyzed shot (pre-AUTO records were declared runs)', () => {
    const handoff = tryAgainFromResult(null, { shotType: 'dink' });
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: 'dink',
      declaredCanonical: null,
      auto: false,
    });
  });

  it('never invents a canonical that is not in the selectable registry', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: 'dink',
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: null, // ambiguous dink was never disambiguated
          resolvedProfileVersion: null,
          disagreement: null,
        },
      },
      { shotType: 'dink' },
    );
    expect(handoff.declaredCanonical).toBeNull();
  });
});

describe('techniqueIntentFromHandoff', () => {
  it('AUTO handoff yields the canonical auto intent', () => {
    const intent = techniqueIntentFromHandoff({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
    });
    expect(intent).toEqual({
      version: 'technique-intent-v1',
      source: 'auto',
      canonical: null,
      legacySlug: null,
      confidence: null,
    });
  });

  it('declared handoff seeds the picker with the same technique', () => {
    const intent = techniqueIntentFromHandoff({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: 'FOREHAND_DRIVE',
      auto: false,
    });
    expect(intent?.source).toBe('tap');
    expect(intent?.canonical).toBe('FOREHAND_DRIVE');
    expect(intent?.legacySlug).toBe('forehand_drive');
  });

  it('an ambiguous slug never guesses a canonical (dink stays side-less)', () => {
    const intent = techniqueIntentFromHandoff({
      source: 'camera',
      declaredStroke: 'dink',
      declaredCanonical: null,
      auto: false,
    });
    expect(intent?.canonical).toBeNull();
    expect(intent?.legacySlug).toBe('dink');
  });

  it('unknown declaration seeds nothing — the picker shows honestly unselected', () => {
    const intent = techniqueIntentFromHandoff({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: false,
    });
    expect(intent).toBeNull();
  });
});

describe('handoff lifecycle', () => {
  it('is single-shot: consumed once, then empty', () => {
    armTryAgain({
      source: 'camera',
      declaredStroke: 'serve',
      declaredCanonical: 'SERVE',
      auto: false,
    });
    expect(peekTryAgainHandoff()?.declaredStroke).toBe('serve');
    expect(consumeTryAgainHandoff()?.declaredStroke).toBe('serve');
    expect(peekTryAgainHandoff()).toBeNull();
    expect(consumeTryAgainHandoff()).toBeNull();
  });

  it('re-arming replaces any stale pending handoff', () => {
    armTryAgain({
      source: 'camera',
      declaredStroke: 'serve',
      declaredCanonical: 'SERVE',
      auto: false,
    });
    armTryAgain({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
    });
    expect(consumeTryAgainHandoff()?.auto).toBe(true);
    expect(consumeTryAgainHandoff()).toBeNull();
  });
});
