import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import {
  SELECTABLE_TECHNIQUES_V1,
  SHOT_TYPES,
  type ShotTypeSlug,
} from '@pickle/shared-types';
import {
  TRY_AGAIN_HANDOFF_TTL_MS,
  armTryAgain,
  consumeTryAgainHandoff,
  peekTryAgainHandoff,
  techniqueIntentFromHandoff,
  tryAgainFromResult,
} from '../../src/screens/tryAgainHandoff';

/**
 * Adversarial pass (mobile-results-review, tester #2) against
 * `tryAgainFromResult`. Attack surface: the Result screen's "Try it again"
 * must re-arm the SAME declared intent the user picked — never the stroke the
 * classifier predicted — and must never smuggle a canonical profile whose
 * legacy slug disagrees with the declared slug.
 *
 * Seeded randomness: mulberry32(0x5eed0002) — fixed so every run explores the
 * same fuzz corpus.
 */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed0002;

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function prediction(
  slug: ShotTypeSlug | null,
): StrokeIntentEnvelope['predictedStroke'] {
  if (slug === null) return null;
  const leaf = slug.toUpperCase();
  return {
    taxonomyVersion: 'taxonomy-attack-1',
    classifierVersion: 'attack-classifier-1',
    label: leaf,
    leaf,
    taxonomyDepth: 3,
    confidence: 0.9,
    evidence: [`attack:${slug}`],
    limitingFactors: [],
  };
}

function autoEnvelope(
  predicted: ShotTypeSlug | null,
  basis: StrokeIntentEnvelope['resolutionBasis'],
  profileId: string | null,
): StrokeIntentEnvelope {
  return {
    declaredStroke: null,
    predictedStroke: prediction(predicted),
    resolutionBasis: basis,
    resolvedProfileId: profileId,
    resolvedProfileVersion: profileId ? 'technique-profile-v1' : null,
    disagreement: null,
  };
}

function declaredEnvelope(
  declared: ShotTypeSlug,
  profileId: string | null,
  overrides: Partial<StrokeIntentEnvelope> = {},
): StrokeIntentEnvelope {
  return {
    declaredStroke: declared,
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: profileId,
    resolvedProfileVersion: profileId ? 'technique-profile-v1' : null,
    disagreement: null,
    ...overrides,
  };
}

afterEach(() => {
  consumeTryAgainHandoff();
});

// ─── Scenario 1: AUTO run must not adopt the predicted slug ─────────────────

describe('ATTACK S1 — AUTO intent + predicted forehand_drive', () => {
  it('declaredStroke=null + shotType=forehand_drive → auto=true, declaredStroke=null', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: autoEnvelope(
          'forehand_drive',
          'predicted_l3',
          'FOREHAND_DRIVE',
        ),
      },
      { shotType: 'forehand_drive', sessionId: 's-auto' },
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId: 's-auto',
    });
    expect(handoff.declaredStroke).not.toBe('forehand_drive');
  });

  it('never adopts the predicted slug for ANY analysis.shotType / resolutionBasis / profile combination', () => {
    const bases: StrokeIntentEnvelope['resolutionBasis'][] = [
      'predicted_l3',
      'predicted_family',
      'abstained',
      'declared',
    ];
    const profiles = [
      null,
      ...SELECTABLE_TECHNIQUES_V1.map(technique => technique.canonical),
      'NOT_A_PROFILE',
      '',
    ];
    let tried = 0;
    for (const shotType of SHOT_TYPES) {
      for (const basis of bases) {
        for (const profileId of profiles) {
          tried += 1;
          const handoff = tryAgainFromResult(
            { strokeIntent: autoEnvelope(shotType, basis, profileId) },
            { shotType },
          );
          expect(handoff.auto).toBe(true);
          expect(handoff.declaredStroke).toBeNull();
          expect(handoff.declaredCanonical).toBeNull();
        }
      }
    }
    expect(tried).toBe(SHOT_TYPES.length * bases.length * profiles.length);
  });

  it('armed AUTO handoff round-trips through peek/consume without picking up the predicted slug', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: autoEnvelope(
          'forehand_drive',
          'predicted_l3',
          'FOREHAND_DRIVE',
        ),
      },
      { shotType: 'forehand_drive' },
    );
    armTryAgain(handoff);
    expect(peekTryAgainHandoff()?.declaredStroke).toBeNull();
    expect(consumeTryAgainHandoff()?.auto).toBe(true);
    expect(consumeTryAgainHandoff()).toBeNull();
  });
});

// ─── Scenario 2: mismatched resolvedProfileId ───────────────────────────────

describe('ATTACK S2 — resolvedProfileId slug disagrees with declaredStroke', () => {
  it('declared forehand_drive + resolvedProfileId=BACKHAND_DRIVE → declaredCanonical=null, auto=false', () => {
    const handoff = tryAgainFromResult(
      { strokeIntent: declaredEnvelope('forehand_drive', 'BACKHAND_DRIVE') },
      { shotType: 'forehand_drive', sessionId: 's1' },
    );
    expect(handoff).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: null,
      auto: false,
      sessionId: 's1',
    });
  });

  it('every (declared slug, canonical) pair: canonical survives IFF its legacySlug === declared', () => {
    const techniques = SELECTABLE_TECHNIQUES_V1;
    let matched = 0;
    let rejected = 0;
    for (const declared of SHOT_TYPES) {
      for (const technique of techniques) {
        const handoff = tryAgainFromResult(
          { strokeIntent: declaredEnvelope(declared, technique.canonical) },
          { shotType: declared },
        );
        expect(handoff.auto).toBe(false);
        expect(handoff.declaredStroke).toBe(declared);
        if (technique.legacySlug === declared) {
          expect(handoff.declaredCanonical).toBe(technique.canonical);
          matched += 1;
        } else {
          expect(handoff.declaredCanonical).toBeNull();
          rejected += 1;
        }
      }
    }
    expect(matched).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(matched);
  });

  it('unicode / case / whitespace variants of a valid canonical are rejected (exact match only)', () => {
    const variants = [
      'forehand_drive',
      'Forehand_Drive',
      'FOREHAND_DRIVE ',
      ' FOREHAND_DRIVE',
      'FOREHAND_DRIVE\u200b',
      'FOREHAND\u2011DRIVE',
      'FOREHAND_DRIVE\0',
      'ＦＯＲＥＨＡＮＤ_ＤＲＩＶＥ',
      '__proto__',
      'constructor',
      'toString',
      '',
    ];
    for (const canonical of variants) {
      const handoff = tryAgainFromResult(
        { strokeIntent: declaredEnvelope('forehand_drive', canonical) },
        { shotType: 'forehand_drive' },
      );
      expect(handoff.declaredCanonical).toBeNull();
      expect(handoff.auto).toBe(false);
      expect(handoff.declaredStroke).toBe('forehand_drive');
    }
  });

  it('a matching canonical is dropped when resolutionBasis is not "declared" (corrupt envelope)', () => {
    const bases: StrokeIntentEnvelope['resolutionBasis'][] = [
      'predicted_l3',
      'predicted_family',
      'abstained',
    ];
    for (const basis of bases) {
      const handoff = tryAgainFromResult(
        {
          strokeIntent: declaredEnvelope('forehand_drive', 'FOREHAND_DRIVE', {
            resolutionBasis: basis,
          }),
        },
        { shotType: 'forehand_drive' },
      );
      expect(handoff.declaredCanonical).toBeNull();
      expect(handoff.auto).toBe(false);
      expect(handoff.declaredStroke).toBe('forehand_drive');
    }
  });

  it('declared slug wins over a disagreeing analysis.shotType (never re-declares the prediction)', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: declaredEnvelope('dink', 'FOREHAND_DINK', {
          predictedStroke: prediction('volley'),
          disagreement: {
            declaredStroke: 'dink',
            predictedStroke: 'volley',
            predictedConfidence: 0.9,
          } as unknown as StrokeIntentEnvelope['disagreement'],
        }),
      },
      { shotType: 'volley' },
    );
    expect(handoff.declaredStroke).toBe('dink');
    expect(handoff.declaredCanonical).toBe('FOREHAND_DINK');
    expect(handoff.auto).toBe(false);
  });
});

// ─── Seeded fuzz: invariants over random envelopes ─────────────────────────

describe('ATTACK fuzz — seeded envelope corpus (seed 0x5eed0002)', () => {
  it('holds all handoff invariants over 2000 random envelopes', () => {
    const rng = mulberry32(SEED);
    const slugsOrNull: (ShotTypeSlug | null)[] = [...SHOT_TYPES, null];
    const profileIds: (string | null)[] = [
      null,
      ...SELECTABLE_TECHNIQUES_V1.map(technique => technique.canonical),
      'BOGUS',
    ];
    const bases: StrokeIntentEnvelope['resolutionBasis'][] = [
      'declared',
      'predicted_l3',
      'predicted_family',
      'abstained',
    ];
    const sessionIds = ['s1', '', null, undefined, '🎾', 'x'.repeat(4096)];

    for (let i = 0; i < 2000; i += 1) {
      const declared = pick(rng, slugsOrNull);
      const predicted = pick(rng, slugsOrNull);
      const basis = pick(rng, bases);
      const profileId = pick(rng, profileIds);
      const shotType = pick(rng, SHOT_TYPES);
      const sessionId = pick(rng, sessionIds);
      const envelope: StrokeIntentEnvelope = {
        declaredStroke: declared,
        predictedStroke: prediction(predicted),
        resolutionBasis: basis,
        resolvedProfileId: profileId,
        resolvedProfileVersion: profileId ? 'technique-profile-v1' : null,
        disagreement: null,
      };
      const analysis =
        sessionId === undefined
          ? { shotType }
          : { shotType, sessionId: sessionId as string | null };
      const handoff = tryAgainFromResult({ strokeIntent: envelope }, analysis);

      expect(handoff.source).toBe('camera');
      // Invariant A: declared slug is echoed verbatim, never the prediction.
      expect(handoff.declaredStroke).toBe(declared);
      // Invariant B: auto iff nothing was declared.
      expect(handoff.auto).toBe(declared === null);
      // Invariant C: a canonical survives only when it is declared-basis AND
      // its legacy slug equals the declared slug.
      if (handoff.declaredCanonical !== null) {
        expect(declared).not.toBeNull();
        expect(basis).toBe('declared');
        expect(handoff.declaredCanonical).toBe(profileId);
        const technique = SELECTABLE_TECHNIQUES_V1.find(
          entry => entry.canonical === profileId,
        );
        expect(technique?.legacySlug).toBe(declared);
      } else if (
        declared !== null &&
        basis === 'declared' &&
        profileId !== null
      ) {
        const technique = SELECTABLE_TECHNIQUES_V1.find(
          entry => entry.canonical === profileId,
        );
        expect(technique?.legacySlug ?? null).not.toBe(declared);
      }
      // Invariant D: session id passes through as-is (string) or nulls.
      expect(handoff.sessionId).toBe(
        typeof sessionId === 'string' ? sessionId : null,
      );
    }
  });

  it('records WITHOUT an envelope (pre-AUTO rows) re-declare the analyzed shotType, never AUTO', () => {
    const legacy: unknown[] = [
      null,
      { strokeIntent: null },
      { strokeIntent: undefined },
      {},
    ];
    for (const record of legacy) {
      const handoff = tryAgainFromResult(
        record as Parameters<typeof tryAgainFromResult>[0],
        { shotType: 'forehand_drive', sessionId: 's1' },
      );
      expect(handoff).toEqual({
        source: 'camera',
        declaredStroke: 'forehand_drive',
        declaredCanonical: null,
        auto: false,
        sessionId: 's1',
      });
    }
    // No analysis either: nothing to re-declare, and still not AUTO.
    expect(tryAgainFromResult(null, null)).toEqual({
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: false,
      sessionId: null,
    });
  });

  // FINDING (P3, corrupt state): a stored record whose envelope object EXISTS
  // but lacks `declaredStroke` (JSON row with `{"strokeIntent":{}}` — the
  // loader is `JSON.parse(payload) as StrokeResultEvidenceRecord`, no
  // validation) takes the declared branch because `undefined !== null`, and
  // the handoff leaves its own `ShotTypeSlug | null` contract:
  // declaredStroke === undefined, auto === false. `techniqueIntentFromHandoff`
  // then seeds a 'tap' intent with legacySlug undefined / canonical null.
  // The contract-level expectation is pinned with `it.failing` so the suite
  // flips the day production validates the envelope.
  it.failing(
    'CONTRACT: an envelope object missing declaredStroke must yield null (AUTO) or a valid slug — never undefined',
    () => {
      const handoff = tryAgainFromResult(
        { strokeIntent: {} as unknown as StrokeIntentEnvelope },
        { shotType: 'forehand_drive', sessionId: 's1' },
      );
      expect(
        handoff.declaredStroke === null ||
          (SHOT_TYPES as readonly string[]).includes(handoff.declaredStroke),
      ).toBe(true);
    },
  );

  it('OBSERVED: envelope object missing declaredStroke → declaredStroke undefined, auto=false, tap intent with undefined slug', () => {
    const corrupt: unknown[] = [
      { strokeIntent: {} },
      { strokeIntent: { declaredStroke: undefined } },
      {
        strokeIntent: {
          resolutionBasis: 'declared',
          resolvedProfileId: 'FOREHAND_DRIVE',
        },
      },
    ];
    for (const record of corrupt) {
      const handoff = tryAgainFromResult(
        record as Parameters<typeof tryAgainFromResult>[0],
        { shotType: 'forehand_drive', sessionId: 's1' },
      );
      expect(handoff.declaredStroke).toBeUndefined();
      expect(handoff.auto).toBe(false);
      expect(handoff.declaredCanonical).toBeNull();
      const intent = techniqueIntentFromHandoff(handoff);
      expect(intent).toMatchObject({
        source: 'tap',
        canonical: null,
        legacySlug: undefined,
        confidence: 1,
      });
    }
    // Downstream (INFERRED from AnalyzeScreen.tsx:589-595, 746-751): the
    // declared slug state collapses to null via `?? null`, and
    // canAutoScoreWithoutDeclaration requires source 'auto', so scoring is
    // blocked until the user picks again — degraded, not a crash.
  });

  it('a non-slug declaredStroke string in a corrupt envelope passes straight through (no allow-list)', () => {
    const handoff = tryAgainFromResult(
      {
        strokeIntent: {
          declaredStroke: 'not_a_stroke' as unknown as ShotTypeSlug,
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: null,
          resolvedProfileVersion: null,
          disagreement: null,
        },
      },
      { shotType: 'forehand_drive' },
    );
    expect(handoff.declaredStroke).toBe('not_a_stroke');
    expect(handoff.declaredCanonical).toBeNull();
    expect(techniqueIntentFromHandoff(handoff)?.canonical).toBeNull();
  });

  it('clock skew: an armed handoff expires after the TTL, survives up to it, and a backwards clock never revives it', () => {
    const nowSpy = jest.spyOn(Date, 'now');
    try {
      const handoff = tryAgainFromResult(
        { strokeIntent: declaredEnvelope('serve', 'SERVE') },
        { shotType: 'serve', sessionId: 's-ttl' },
      );
      nowSpy.mockReturnValue(1_000_000);
      armTryAgain(handoff);
      nowSpy.mockReturnValue(1_000_000 + TRY_AGAIN_HANDOFF_TTL_MS);
      expect(peekTryAgainHandoff()).toEqual(handoff);
      nowSpy.mockReturnValue(1_000_000 + TRY_AGAIN_HANDOFF_TTL_MS + 1);
      expect(peekTryAgainHandoff()).toBeNull();
      expect(consumeTryAgainHandoff()).toBeNull();
      // Consume cleared it even though it was expired: a later clock
      // correction backwards cannot resurrect the stale declaration.
      nowSpy.mockReturnValue(1_000_000);
      expect(peekTryAgainHandoff()).toBeNull();
      expect(consumeTryAgainHandoff()).toBeNull();

      // Backwards skew while armed (Date.now smaller than at arm time):
      // elapsed is negative, so the handoff is still valid — the tap was
      // real; only forward drift past the TTL expires it.
      nowSpy.mockReturnValue(2_000_000);
      armTryAgain(handoff);
      nowSpy.mockReturnValue(1_500_000);
      expect(peekTryAgainHandoff()).toEqual(handoff);
      expect(consumeTryAgainHandoff()).toEqual(handoff);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('rapid re-arm interleaving: the last armed handoff wins and consume is single-shot', () => {
    const rng = mulberry32(SEED ^ 0xff);
    let last: ReturnType<typeof tryAgainFromResult> | null = null;
    for (let i = 0; i < 500; i += 1) {
      const declared = pick(rng, [...SHOT_TYPES, null] as const);
      last = tryAgainFromResult(
        {
          strokeIntent:
            declared === null
              ? autoEnvelope('forehand_drive', 'predicted_l3', null)
              : declaredEnvelope(declared, null),
        },
        { shotType: 'forehand_drive', sessionId: `s${i}` },
      );
      armTryAgain(last);
    }
    expect(peekTryAgainHandoff()).toEqual(last);
    expect(consumeTryAgainHandoff()).toEqual(last);
    expect(consumeTryAgainHandoff()).toBeNull();
    expect(peekTryAgainHandoff()).toBeNull();
  });
});
