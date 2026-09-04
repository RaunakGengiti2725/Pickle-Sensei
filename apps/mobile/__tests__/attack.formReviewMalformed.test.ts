import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import {
  buildFormReviewScript,
  fixList,
  jointHeatAt,
  strengthList,
} from '../src/review';

/**
 * Adversarial pass 3 — form review script versus malformed analyses.
 *
 * The review model is a pure selector over one persisted ShotAnalysis. Rows
 * written by older engines, partially-migrated rows or rows whose JSON was
 * edited must never yield NaN/Infinity on the replay timeline, duplicated
 * fixes, or a heat spread that collapses to a single frame.
 *
 * Seeded randomness (mulberry32) is used for the fuzz cases; the seed is
 * printed in the test name so a failure is reproducible.
 */

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-attack',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 5.5,
    analysisConfidence: 0.8,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

/** Deterministic PRNG so fuzz cases replay exactly. */
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

const FUZZ_SEED = 0x5eed_2026;

function keysOf(items: ReadonlyArray<{ key: CheckpointKey }>): CheckpointKey[] {
  return items.map(item => item.key);
}

// ─── Scenario 4: duplicate checkpoint keys ──────────────────────────────────

describe('attack — checkpoints repeating the same key with different scores', () => {
  const analysis = analysisFixture({
    checkpoints: [
      checkpoint('contact_position', 48, 'red', 'late'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      // Duplicates arrive with different (better AND worse) scores/bands.
      checkpoint('contact_position', 12, 'red', 'early'),
      checkpoint('contact_position', 95, 'green', 'none'),
      checkpoint('paddle_path', 5, 'red', 'high'),
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('ready_position', 20, 'red', 'none'),
    ],
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
  });

  it('only the FIRST occurrence of each key participates in the script', () => {
    const script = buildFormReviewScript(analysis, null);
    const [stop] = script.stops;
    expect(script.stops).toHaveLength(1);
    expect(keysOf(stop!.checkpoints)).toEqual([
      'contact_position',
      'paddle_path',
      'ready_position',
    ]);
    // Scores are the first occurrence's — not the min, max or last.
    expect(stop!.checkpoints.map(cp => cp.score)).toEqual([48, 61, 85]);
    expect(script.weakest?.score).toBe(48);
    expect(script.strongest?.score).toBe(85);
    // The stop's verdict comes from the first occurrences only (48/61 red).
    expect(stop!.verdict).toBe('fix');
    // Heat is derived from the surviving occurrence's score (1 − 48/100).
    expect(script.jointHeat.right_wrist).toBeCloseTo(0.52, 10);
  });

  it('fixList names each duplicated key once, with the first score, priority first', () => {
    const fixes = fixList(analysis);
    expect(keysOf(fixes)).toEqual(['contact_position', 'paddle_path']);
    expect(fixes.map(fix => fix.score)).toEqual([48, 61]);
    expect(fixes[0]!.isPriority).toBe(true);
    // A generous limit does not resurrect the discarded duplicates.
    expect(keysOf(fixList(analysis, 100))).toEqual([
      'contact_position',
      'paddle_path',
    ]);
    // strengthList sees the same single occurrence.
    expect(keysOf(strengthList(analysis, 100))).toEqual(['ready_position']);
  });

  it('a discarded first occurrence (inapplicable / null score) lets the next valid one participate — never both', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        checkpoints: [
          checkpoint('contact_position', 30, 'red', 'late', {
            applicable: false,
          }),
          checkpoint('contact_position', null, 'unscored', 'none'),
          checkpoint('contact_position', Number.NaN, 'red', 'late'),
          checkpoint('contact_position', 70, 'yellow', 'late'),
          checkpoint('contact_position', 10, 'red', 'late'),
        ],
      }),
      null,
    );
    expect(keysOf(script.stops[0]!.checkpoints)).toEqual(['contact_position']);
    expect(script.stops[0]!.checkpoints[0]!.score).toBe(70);
  });

  it(`a huge randomly-ordered duplicate flood (seed ${FUZZ_SEED.toString(16)}) still yields ≤ 11 participants and no repeated fix`, () => {
    const rand = mulberry32(FUZZ_SEED);
    const keys: CheckpointKey[] = [
      'ready_position',
      'athletic_base',
      'preparation',
      'paddle_set',
      'swing_length',
      'sequencing',
      'paddle_path',
      'contact_position',
      'face_wrist_stability',
      'follow_through',
      'recovery',
    ];
    const bands: ScoreBand[] = ['red', 'yellow', 'green'];
    const flood: CheckpointScore[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const key = keys[Math.floor(rand() * keys.length)]!;
      const band = bands[Math.floor(rand() * bands.length)]!;
      flood.push(checkpoint(key, Math.floor(rand() * 101), band, 'none'));
    }
    const analysisFlood = analysisFixture({ checkpoints: flood });
    const startedAt = Date.now();
    const script = buildFormReviewScript(analysisFlood, null);
    const fixes = fixList(analysisFlood, 100);
    const elapsedMs = Date.now() - startedAt;

    const participating = script.stops.flatMap(stop => stop.checkpoints);
    expect(new Set(keysOf(participating)).size).toBe(participating.length);
    expect(participating.length).toBeLessThanOrEqual(11);
    expect(new Set(keysOf(fixes)).size).toBe(fixes.length);
    // First occurrence wins: check against a linear scan of the flood.
    const firstByKey = new Map<CheckpointKey, number>();
    for (const cp of flood) {
      if (!firstByKey.has(cp.key) && cp.score !== null) {
        firstByKey.set(cp.key, cp.score);
      }
    }
    for (const cp of participating) {
      expect(cp.score).toBe(firstByKey.get(cp.key));
    }
    // Linear-time dedupe: 20k rows must not take seconds on device.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

// ─── Scenario 5: reversed phase bounds ──────────────────────────────────────

describe('attack — phases=[{key:"contact", startMs:800, endMs:200}]', () => {
  const reversedContact: PhaseSpan = {
    key: 'contact',
    startMs: 800,
    endMs: 200,
    // A representative that is NOT finite forces the midpoint fallback so
    // the clamp is what positions the stop.
    representativeMs: Number.NaN,
    confidence: 0.8,
  };
  const analysis = analysisFixture({
    phases: [reversedContact],
    checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
  });

  it('clamps endMs to startMs and places the stop on the clamped midpoint', () => {
    const script = buildFormReviewScript(analysis, null);
    expect(script.stops).toHaveLength(1);
    const [stop] = script.stops;
    expect(stop).toMatchObject({
      phase: 'contact',
      startMs: 800,
      endMs: 800,
      atMs: 800,
      verdict: 'fix',
    });
    expect(stop!.endMs).toBeGreaterThanOrEqual(stop!.startMs);
  });

  it('jointHeatAt spreads with σ = max(180, half span) = 180 for the zero-width stop', () => {
    const script = buildFormReviewScript(analysis, null);
    const [stop] = script.stops;
    const heatFor = (tMs: number) => jointHeatAt(script, tMs).right_wrist ?? 0;
    const peak = 1 - 40 / 100; // 0.6
    const floor = 0.35 * peak; // static heat floor

    // At the stop the pulse is full strength.
    expect(heatFor(stop!.atMs)).toBeCloseTo(peak, 10);
    // Exactly one σ (180 ms) away the pulse is e^(-1/2) of the peak — which
    // is above the floor, so it is what is read back. A σ of half the span
    // (0 ms) would divide by zero and yield NaN → the pulse would be skipped
    // and only the floor would remain.
    const oneSigma = peak * Math.exp(-0.5);
    expect(oneSigma).toBeGreaterThan(floor);
    expect(heatFor(stop!.atMs + 180)).toBeCloseTo(oneSigma, 10);
    expect(heatFor(stop!.atMs - 180)).toBeCloseTo(oneSigma, 10);
    // Two σ: e^(-2) × 0.6 ≈ 0.081, below the floor, so the floor holds.
    expect(heatFor(stop!.atMs + 360)).toBeCloseTo(floor, 10);
    // Far away: still the floor, never cold, never NaN.
    expect(heatFor(stop!.atMs + 100_000)).toBeCloseTo(floor, 10);
    expect(Number.isNaN(heatFor(Number.NaN))).toBe(false);
    expect(heatFor(Number.NaN)).toBeCloseTo(floor, 10);
  });

  it('a wide span uses half its width instead of the 180 ms minimum', () => {
    const wide = buildFormReviewScript(
      analysisFixture({
        phases: [phase('contact', 0, 2000, 1000)],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    // σ = 1000: one σ away is e^(-1/2) × 0.6.
    expect(jointHeatAt(wide, 2000).right_wrist).toBeCloseTo(
      0.6 * Math.exp(-0.5),
      10,
    );
    // With σ = 180 this would have been the floor (e^(-15.4) × 0.6 ≈ 0).
    expect(jointHeatAt(wide, 2000).right_wrist).toBeGreaterThan(0.35 * 0.6);
  });

  it('a finite representative that sat inside the ORIGINAL reversed bounds is kept even though it now lies outside the clamped span', () => {
    // Characterisation: representativeMs is trusted when finite, and the
    // clamp is applied to endMs only. The stop is at 500 while its span is
    // [800, 800] — the timeline marker and the pause point disagree with the
    // span the stop claims to cover.
    const script = buildFormReviewScript(
      analysisFixture({
        phases: [{ ...reversedContact, representativeMs: 500 }],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    const [stop] = script.stops;
    expect(stop).toMatchObject({ startMs: 800, endMs: 800, atMs: 500 });
    expect(stop!.atMs < stop!.startMs).toBe(true);
  });

  it('the contact stop survives a phase list where every OTHER phase is reversed and clamped', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        phases: [
          phase('ready', 900, 0),
          phase('prepare', 1500, 900),
          phase('accelerate', 1900, 1500),
          reversedContact,
          phase('follow_through', 2400, 1920),
          phase('recover', 3200, 2400),
        ],
        checkpoints: [
          checkpoint('ready_position', 30, 'red', 'none'),
          checkpoint('paddle_path', 61, 'red', 'low'),
          checkpoint('contact_position', 40, 'red', 'late'),
          checkpoint('recovery', 92, 'green', 'none'),
        ],
      }),
      null,
    );
    for (const stop of script.stops) {
      expect(stop.endMs).toBe(stop.startMs);
      expect(Number.isFinite(stop.atMs)).toBe(true);
    }
    // Sorted by atMs: reversed phases' default representatives are their
    // (pre-clamp) midpoints, so ordering follows those.
    const atMs = script.stops.map(stop => stop.atMs);
    expect([...atMs].sort((a, b) => a - b)).toEqual(atMs);
  });
});

// ─── Scenario 6: contactMs = Infinity, no phases ────────────────────────────

describe('attack — timestamps.contactMs = Infinity with no phases', () => {
  it('the fallback contact stop sits at the window midpoint with finite atMs', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        timestamps: {
          startMs: 400,
          contactMs: Number.POSITIVE_INFINITY,
          endMs: 3600,
        },
        phases: [],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    expect(script.stops).toHaveLength(1);
    expect(script.stops[0]).toMatchObject({
      phase: 'contact',
      startMs: 400,
      endMs: 3600,
      atMs: 2000,
    });
    expect(Number.isFinite(script.stops[0]!.atMs)).toBe(true);
    // Heat at the midpoint is the peak; σ = 1600 here.
    expect(jointHeatAt(script, 2000).right_wrist).toBeCloseTo(0.6, 10);
    expect(jointHeatAt(script, 3600).right_wrist).toBeCloseTo(
      0.6 * Math.exp(-0.5),
      10,
    );
  });

  it.each([
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['NaN', Number.NaN],
    ['undefined', undefined],
    ['string', '1900' as unknown as number],
  ])('contactMs = %s also falls to the midpoint', (_label, contactMs) => {
    const script = buildFormReviewScript(
      analysisFixture({
        timestamps: { startMs: 0, contactMs, endMs: 3000 } as never,
        phases: [],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    expect(script.stops[0]!.atMs).toBe(1500);
  });

  it('every timestamp non-finite yields a zero-width stop at 0, never NaN, and heat still has σ = 180', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        timestamps: {
          startMs: Number.NaN,
          contactMs: Number.POSITIVE_INFINITY,
          endMs: Number.NEGATIVE_INFINITY,
        },
        phases: [],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    expect(script.stops[0]).toMatchObject({ startMs: 0, endMs: 0, atMs: 0 });
    expect(jointHeatAt(script, 180).right_wrist).toBeCloseTo(
      0.6 * Math.exp(-0.5),
      10,
    );
  });

  it('a reversed window (endMs < startMs) with Infinity contact clamps and lands on startMs', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        timestamps: {
          startMs: 3000,
          contactMs: Number.POSITIVE_INFINITY,
          endMs: 100,
        },
        phases: [],
        checkpoints: [],
      }),
      null,
    );
    expect(script.stops[0]).toMatchObject({
      startMs: 3000,
      endMs: 3000,
      atMs: 3000,
    });
    // Nothing scored at contact: the stop still exists with the honest copy.
    expect(script.stops[0]!.checkpoints).toEqual([]);
    expect(script.stops[0]!.verdict).toBe('strong');
  });

  it('phases that are ALL unknown or non-finite count as "no phases" and take the fallback too', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        timestamps: {
          startMs: 0,
          contactMs: Number.POSITIVE_INFINITY,
          endMs: 2000,
        },
        phases: [
          {
            key: 'contact',
            startMs: Number.NaN,
            endMs: 5,
            representativeMs: 3,
            confidence: 1,
          },
          {
            key: 'contact',
            startMs: 5,
            endMs: Number.POSITIVE_INFINITY,
            representativeMs: 3,
            confidence: 1,
          },
          {
            key: 'kontakt' as PhaseKey,
            startMs: 0,
            endMs: 5,
            representativeMs: 3,
            confidence: 1,
          },
          {
            key: '接触' as PhaseKey,
            startMs: 0,
            endMs: 5,
            representativeMs: 3,
            confidence: 1,
          },
          null as unknown as PhaseSpan,
        ],
        checkpoints: [checkpoint('contact_position', 40, 'red', 'late')],
      }),
      null,
    );
    expect(script.stops).toHaveLength(1);
    expect(script.stops[0]).toMatchObject({
      startMs: 0,
      endMs: 2000,
      atMs: 1000,
    });
  });
});

// ─── Extra: garbage in the checkpoint list ──────────────────────────────────

describe('attack — corrupt checkpoint rows', () => {
  it('null entries, unicode keys, string scores and a non-array list are ignored without throwing', () => {
    const script = buildFormReviewScript(
      analysisFixture({
        checkpoints: [
          null,
          undefined,
          { key: 'контакт', score: 10, band: 'red', direction: 'late' },
          {
            key: 'contact_position',
            score: '48',
            band: 'red',
            direction: 'late',
          },
          {
            key: 'contact_position',
            score: 48,
            band: 'red',
            direction: 'late',
          },
          42,
          'contact_position',
        ] as unknown as CheckpointScore[],
      }),
      null,
    );
    expect(keysOf(script.stops[0]!.checkpoints)).toEqual(['contact_position']);
    expect(script.stops[0]!.checkpoints[0]!.score).toBe(48);

    const noListAnalysis = analysisFixture({
      checkpoints: { length: 3 } as unknown as CheckpointScore[],
      phases: 'none' as unknown as PhaseSpan[],
    });
    const noList = buildFormReviewScript(noListAnalysis, null);
    expect(noList.stops).toHaveLength(1);
    expect(noList.stops[0]!.checkpoints).toEqual([]);
    expect(fixList(noListAnalysis)).toEqual([]);
    expect(strengthList(noListAnalysis)).toEqual([]);
  });
});
