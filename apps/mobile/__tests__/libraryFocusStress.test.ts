import { CHECKPOINTS, RANK_FORM_WINDOW } from '@pickle/shared-types';
import {
  MIN_FOCUS_SAMPLES,
  SHOT_FAMILY,
  computeLibraryFocus,
  recommendDrills,
  type LibraryFocus,
  type ScoredCheckpointFact,
} from '../src/library/libraryFocus';

/**
 * STRESS SUITE for the drill library's personalization math.
 *
 * The pure engine must never throw, never emit a non-finite or fabricated
 * result, and must stay deterministic under any input ordering — including
 * hostile inputs a corrupt local database could theoretically produce
 * (NaN/Infinity scores, unknown techniques and checkpoints, duplicate ids,
 * identical timestamps, malformed date strings, empty everything).
 *
 * A deliberately independent reference implementation cross-checks the
 * production result on hundreds of seeded-random cases, so a regression in
 * either windowing, weighting, evidence gating, or tie-breaking cannot slip
 * through unnoticed.
 */

// ─── Seeded PRNG (mulberry32): reproducible fuzzing, no flaky reruns ───────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ─── Random fact generator (valid + hostile shapes) ────────────────────────

const TECHNIQUES = [
  'dink',
  'volley',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'return',
  'third_shot_drop',
  'overhead',
  'mystery_shot',
  '',
] as const;

const CHECKPOINT_KEYS = [
  ...CHECKPOINTS,
  'contact_height',
  'weird key!!',
] as const;

const HOSTILE_SCORES = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -50,
  250,
] as const;

function randomFact(rng: () => number, index: number): ScoredCheckpointFact {
  const checkpointCount = Math.floor(rng() * 6);
  const checkpoints = Array.from({ length: checkpointCount }, () => {
    const roll = rng();
    const score =
      roll < 0.15
        ? null
        : roll < 0.25
        ? pick(rng, HOSTILE_SCORES)
        : Math.round(rng() * 100);
    return {
      key: pick(rng, CHECKPOINT_KEYS),
      score,
      applicable: rng() < 0.8,
    };
  });
  const day = 1 + Math.floor(rng() * 28);
  const capturedAt =
    rng() < 0.05
      ? 'not-a-date'
      : `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`;
  return {
    // Occasional duplicate ids on purpose: the sort must stay total anyway.
    id:
      rng() < 0.05
        ? 'duplicate-id'
        : `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    shotType: pick(rng, TECHNIQUES),
    capturedAt,
    checkpoints,
  };
}

// ─── Independent reference implementation ──────────────────────────────────

function referenceFocus(
  facts: readonly ScoredCheckpointFact[],
): LibraryFocus | null {
  const ordered = [...facts].sort((a, b) => {
    if (a.capturedAt !== b.capturedAt) {
      return a.capturedAt < b.capturedAt ? 1 : -1;
    }
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
  const windows = new Map<string, ScoredCheckpointFact[]>();
  for (const fact of ordered) {
    const window = windows.get(fact.shotType) ?? [];
    if (window.length < RANK_FORM_WINDOW) {
      window.push(fact);
      windows.set(fact.shotType, window);
    }
  }
  interface Candidate extends LibraryFocus {
    latest: string;
  }
  const candidates: Candidate[] = [];
  for (const [shotType, window] of windows) {
    const keys = new Set<string>();
    for (const fact of window) {
      for (const checkpoint of fact.checkpoints) keys.add(checkpoint.key);
    }
    for (const key of keys) {
      let weightedSum = 0;
      let weightSum = 0;
      let count = 0;
      let latest: string | null = null;
      window.forEach((fact, index) => {
        const weight = window.length - index;
        for (const checkpoint of fact.checkpoints) {
          if (
            checkpoint.key !== key ||
            !checkpoint.applicable ||
            checkpoint.score === null ||
            !Number.isFinite(checkpoint.score)
          ) {
            continue;
          }
          weightedSum += checkpoint.score * weight;
          weightSum += weight;
          count += 1;
          if (latest === null) latest = fact.capturedAt;
        }
      });
      if (count < MIN_FOCUS_SAMPLES || latest === null) continue;
      candidates.push({
        shotType,
        checkpoint: key,
        averageScore: Math.round(weightedSum / weightSum),
        sampleCount: count,
        family: SHOT_FAMILY[shotType] ?? 'global',
        latest,
      });
    }
  }
  if (candidates.length === 0) return null;
  const order = (key: string) => {
    const index = (CHECKPOINTS as readonly string[]).indexOf(key);
    return index === -1 ? CHECKPOINTS.length : index;
  };
  candidates.sort(
    (a, b) =>
      a.averageScore - b.averageScore ||
      b.sampleCount - a.sampleCount ||
      (a.latest === b.latest ? 0 : a.latest < b.latest ? 1 : -1) ||
      order(a.checkpoint) - order(b.checkpoint) ||
      (a.shotType < b.shotType ? -1 : a.shotType > b.shotType ? 1 : 0),
  );
  const best = candidates[0]!;
  return {
    shotType: best.shotType,
    checkpoint: best.checkpoint,
    averageScore: best.averageScore,
    sampleCount: best.sampleCount,
    family: best.family,
  };
}

// ─── Fuzz: computeLibraryFocus ─────────────────────────────────────────────

describe('computeLibraryFocus under fuzz', () => {
  it('never throws, never emits non-finite output, and matches the reference on 400 seeded cases', () => {
    for (let iteration = 0; iteration < 400; iteration += 1) {
      const rng = mulberry32(1_000 + iteration);
      const factCount = Math.floor(rng() * 60);
      const facts = Array.from({ length: factCount }, (_, i) =>
        randomFact(rng, iteration * 1_000 + i),
      );

      const focus = computeLibraryFocus(facts);

      if (focus !== null) {
        expect(Number.isFinite(focus.averageScore)).toBe(true);
        expect(Number.isInteger(focus.averageScore)).toBe(true);
        expect(focus.sampleCount).toBeGreaterThanOrEqual(MIN_FOCUS_SAMPLES);
        expect(focus.family).toBe(SHOT_FAMILY[focus.shotType] ?? 'global');
        expect(typeof focus.checkpoint).toBe('string');
      }

      // Cross-check against the independent implementation.
      expect(focus).toEqual(referenceFocus(facts));

      // Determinism: input order must never change the answer.
      expect(computeLibraryFocus(shuffled(rng, facts))).toEqual(focus);

      // Purity: the input array and its facts are never mutated.
      const before = JSON.stringify(facts);
      computeLibraryFocus(facts);
      expect(JSON.stringify(facts)).toBe(before);
    }
  });

  it('survives pathological inputs without throwing', () => {
    const pathological: ScoredCheckpointFact[][] = [
      [],
      // Only hostile scores: nothing observable → null, never NaN.
      [
        {
          id: 'a',
          shotType: 'dink',
          capturedAt: '2026-08-02T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: Number.NaN, applicable: true },
            {
              key: 'contact_position',
              score: Number.POSITIVE_INFINITY,
              applicable: true,
            },
          ],
        },
        {
          id: 'b',
          shotType: 'dink',
          capturedAt: '2026-08-01T10:00:00.000Z',
          checkpoints: [
            { key: 'contact_position', score: Number.NaN, applicable: true },
          ],
        },
      ],
      // Identical timestamps AND identical ids: sort must stay total.
      Array.from({ length: 20 }, () => ({
        id: 'same',
        shotType: 'dink',
        capturedAt: '2026-08-01T10:00:00.000Z',
        checkpoints: [{ key: 'contact_position', score: 50, applicable: true }],
      })),
      // Empty strings everywhere.
      [
        { id: '', shotType: '', capturedAt: '', checkpoints: [] },
        {
          id: '',
          shotType: '',
          capturedAt: '',
          checkpoints: [{ key: '', score: 10, applicable: true }],
        },
        {
          id: '',
          shotType: '',
          capturedAt: '',
          checkpoints: [{ key: '', score: 20, applicable: true }],
        },
      ],
    ];
    for (const facts of pathological) {
      expect(() => computeLibraryFocus(facts)).not.toThrow();
      const focus = computeLibraryFocus(facts);
      if (focus !== null) {
        expect(Number.isFinite(focus.averageScore)).toBe(true);
      }
    }
    // The all-hostile-scores case specifically must abstain, not average NaN.
    expect(computeLibraryFocus(pathological[1]!)).toBeNull();
  });

  it('handles a 10,000-analysis history quickly and deterministically', () => {
    const rng = mulberry32(99);
    const facts = Array.from({ length: 10_000 }, (_, i) => randomFact(rng, i));
    const startedAt = Date.now();
    const first = computeLibraryFocus(facts);
    const elapsedMs = Date.now() - startedAt;
    // Generous CI bound — locally this runs in a few milliseconds.
    expect(elapsedMs).toBeLessThan(1_000);
    expect(computeLibraryFocus([...facts].reverse())).toEqual(first);
  });

  it('only ever counts the newest form window per technique', () => {
    // 50 dink reads; the 8 newest all say contact_position=90 and
    // athletic_base=40. The 42 older ones say contact_position=1 — if any
    // of them leaked into the window, contact_position would win.
    const newest: ScoredCheckpointFact[] = Array.from(
      { length: RANK_FORM_WINDOW },
      (_, i) => ({
        id: `new-${i}`,
        shotType: 'dink',
        capturedAt: `2026-08-2${i}T10:00:00.000Z`,
        checkpoints: [
          { key: 'contact_position', score: 90, applicable: true },
          { key: 'athletic_base', score: 40, applicable: true },
        ],
      }),
    );
    const older: ScoredCheckpointFact[] = Array.from(
      { length: 42 },
      (_, i) => ({
        id: `old-${i}`,
        shotType: 'dink',
        capturedAt: `2026-07-${String(1 + (i % 28)).padStart(
          2,
          '0',
        )}T10:00:00.000Z`,
        checkpoints: [{ key: 'contact_position', score: 1, applicable: true }],
      }),
    );
    const focus = computeLibraryFocus([...older, ...newest]);
    expect(focus).not.toBeNull();
    expect(focus!.checkpoint).toBe('athletic_base');
    expect(focus!.averageScore).toBe(40);
  });
});

// ─── Fuzz: recommendDrills ─────────────────────────────────────────────────

const FAMILY_POOL: readonly string[] = [
  'dink',
  'volley',
  'drive',
  'serve',
  'return',
  'drop_reset',
  'global',
  'junk_family',
];

describe('recommendDrills under fuzz', () => {
  it('always returns an in-order, deduplicated, family-honest subset on 300 seeded cases', () => {
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const rng = mulberry32(50_000 + iteration);
      const drills = Array.from(
        { length: Math.floor(rng() * 100) },
        (_, i) => ({
          slug: `drill-${iteration}-${i}`,
          families: Array.from({ length: Math.floor(rng() * 3) }, () =>
            pick(rng, FAMILY_POOL),
          ),
        }),
      );
      const focus: LibraryFocus = {
        shotType: 'dink',
        checkpoint: 'contact_position',
        averageScore: 50,
        sampleCount: 2,
        family: pick(rng, FAMILY_POOL),
      };
      const limit = pick(rng, [-5, 0, 1, 2, 3, 10, 100] as const);

      const result = recommendDrills(drills, focus, limit);

      // Bounded and never fabricated.
      expect(result.length).toBeLessThanOrEqual(Math.max(0, limit));
      const slugs = result.map(drill => drill.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const drill of result) {
        expect(drills).toContain(drill);
        // Family honesty: a recommendation is either the focus family or a
        // whole-game fill (only when the focus family is not global itself).
        const primary = drill.families.includes(focus.family);
        const fill =
          focus.family !== 'global' && drill.families.includes('global');
        expect(primary || fill).toBe(true);
      }
      // Primary matches always precede global fills, both in catalog order.
      const isPrimary = (slug: string) =>
        drills
          .find(drill => drill.slug === slug)!
          .families.includes(focus.family);
      const firstFill = slugs.findIndex(slug => !isPrimary(slug));
      if (firstFill !== -1) {
        for (const slug of slugs.slice(firstFill)) {
          expect(isPrimary(slug)).toBe(false);
        }
      }
      const catalogIndex = (slug: string) =>
        drills.findIndex(drill => drill.slug === slug);
      const primaryOrder = slugs.filter(isPrimary).map(catalogIndex);
      expect(primaryOrder).toEqual([...primaryOrder].sort((a, b) => a - b));
      const fillOrder = slugs
        .filter(slug => !isPrimary(slug))
        .map(catalogIndex);
      expect(fillOrder).toEqual([...fillOrder].sort((a, b) => a - b));

      // Determinism.
      expect(recommendDrills(drills, focus, limit)).toEqual(result);
    }
  });

  it('handles empty catalogs and zero/negative limits without throwing', () => {
    const focus: LibraryFocus = {
      shotType: 'dink',
      checkpoint: 'contact_position',
      averageScore: 50,
      sampleCount: 2,
      family: 'dink',
    };
    expect(recommendDrills([], focus)).toEqual([]);
    const catalog = [{ slug: 'a', families: ['dink'] }];
    expect(recommendDrills(catalog, focus, 0)).toEqual([]);
    expect(recommendDrills(catalog, focus, -3)).toEqual([]);
    expect(recommendDrills(catalog, focus, 100)).toEqual(catalog);
  });
});
