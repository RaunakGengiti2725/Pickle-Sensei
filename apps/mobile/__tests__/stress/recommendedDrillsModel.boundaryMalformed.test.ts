import { CHECKPOINTS } from '@pickle/shared-types';
import {
  FAMILY_LABELS,
  type LibraryFocus,
} from '../../src/library/libraryFocus';
import {
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../../src/review/recommendedDrillsModel';
import {
  ALL_SHOT_TYPES,
  PROTO_KEYS,
  ResultTable,
  Rng,
  TRAVERSAL_STRINGS,
  brokenSummary,
  campaignPlan,
  invariant,
  jsonRoundTrip,
  mutateAnalysis,
  prototypeFingerprint,
  runCase,
  safeString,
  validAnalysis,
  weirdNumber,
  weirdString,
} from '../../test-support/stress/reviewMalformed';

/**
 * STRESS · boundary/malformed input · recommendedDrillsModel.
 *
 * Contract (file header): the focus is the analysis' OWN worst measured
 * fault — else the engine's priorityFix when it carries an applicable,
 * finite score — else null; the family is the shot's family or 'global';
 * `pickRecommendedDrills` returns a subset of the catalog, family matches
 * first, never more than `limit`. Fed seeded malformed analyses (unvalidated
 * persisted JSON) and catalogs with prototype-named / traversal slugs.
 */

const table = new ResultTable('recommendedDrillsModel');
const plan = campaignPlan(60);
const KNOWN_FAMILIES = new Set<string>([
  ...Object.keys(FAMILY_LABELS),
  'global',
]);

afterAll(() => {
  table.flush();
});

interface CatalogDrill {
  slug: string;
  families: readonly string[];
}

function catalog(rng: Rng, log: string[]): CatalogDrill[] {
  const size = rng.pick([0, 1, 3, 8, 40]);
  log.push(`catalog=${size}`);
  const out: CatalogDrill[] = [];
  for (let i = 0; i < size; i += 1) {
    const roll = rng.int(0, 5);
    const slug =
      roll === 0
        ? rng.pick(PROTO_KEYS)
        : roll === 1
          ? rng.pick(TRAVERSAL_STRINGS)
          : roll === 2
            ? weirdString(rng)
            : `drill-${i}`;
    const familyRoll = rng.int(0, 5);
    const families: string[] =
      familyRoll === 0
        ? []
        : familyRoll === 1
          ? [rng.pick(PROTO_KEYS)]
          : familyRoll === 2
            ? ['global']
            : [
                rng.pick([
                  ...Object.keys(FAMILY_LABELS),
                  'global',
                  weirdString(rng),
                ]),
              ];
    out.push({ slug, families });
  }
  return out;
}

describe('recommendedDrillsModel · boundary/malformed campaigns', () => {
  const fingerprint = prototypeFingerprint();

  it('drillFocusFromAnalysis yields null or a focus grounded in the analysis', () => {
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'drillFocus', plan.seedAt(i), (rng, log) => {
        const count = rng.int(1, 6);
        log.push(`analysisMutations×${count}`);
        let analysis = mutateAnalysis(rng, validAnalysis(rng), count, log);
        if (rng.chance(0.4)) {
          log.push('jsonRoundTrip');
          analysis = jsonRoundTrip(analysis);
        }
        const focus = drillFocusFromAnalysis(analysis);
        if (focus !== null) {
          invariant(
            typeof focus.checkpoint === 'string' &&
              (CHECKPOINTS as readonly string[]).includes(focus.checkpoint),
            `focus.checkpoint is a canonical checkpoint (got ${safeString(focus.checkpoint)})`,
          );
          invariant(
            Number.isInteger(focus.averageScore) &&
              focus.averageScore >= 0 &&
              focus.averageScore <= 100,
            `focus.averageScore integer in [0,100] (got ${String(focus.averageScore)})`,
          );
          invariant(focus.sampleCount === 1, 'sampleCount 1');
          invariant(
            KNOWN_FAMILIES.has(focus.family),
            `focus.family known (got ${safeString(focus.family)})`,
          );
          invariant(
            (ALL_SHOT_TYPES as readonly unknown[]).includes(analysis.shotType)
              ? focus.family !== 'global' || analysis.shotType === 'overhead'
              : focus.family === 'global',
            `unknown shotType maps to global (shotType=${safeString(analysis.shotType)}, family=${focus.family})`,
          );
          const raw = Array.isArray(analysis.checkpoints)
            ? analysis.checkpoints
            : [];
          const source = raw.find(
            cp =>
              cp &&
              typeof cp === 'object' &&
              cp.key === focus.checkpoint &&
              cp.applicable !== false &&
              typeof cp.score === 'number' &&
              Number.isFinite(cp.score),
          );
          invariant(
            source !== undefined &&
              typeof source.score === 'number' &&
              Math.round(source.score) === focus.averageScore,
            'focus traces to an applicable, finite checkpoint of the analysis',
          );
        }
        invariant(
          prototypeFingerprint() === fingerprint,
          'no prototype pollution',
        );
      });
    }
    expect(brokenSummary(table)).toBe(`0 broken of ${table.records.length}`);
  });

  it('pickRecommendedDrills returns a bounded, family-first subset for any limit and slug vocabulary', () => {
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'pickDrills', plan.seedAt(i, 0xd211), (rng, log) => {
        const drills = catalog(rng, log);
        const focus: LibraryFocus = {
          shotType: rng.chance(0.8)
            ? rng.pick(ALL_SHOT_TYPES)
            : (weirdString(rng) as never),
          checkpoint: rng.chance(0.8)
            ? rng.pick(CHECKPOINTS)
            : weirdString(rng),
          averageScore: rng.chance(0.8) ? rng.int(0, 100) : weirdNumber(rng),
          sampleCount: 1,
          family: rng.chance(0.7)
            ? (rng.pick([
                ...Object.keys(FAMILY_LABELS),
                'global',
              ]) as LibraryFocus['family'])
            : ((rng.chance(0.5)
                ? rng.pick(PROTO_KEYS)
                : weirdString(rng)) as never),
        };
        const limit = rng.pick([
          undefined,
          0,
          1,
          3,
          5,
          -1,
          NaN,
          Infinity,
          -Infinity,
          2.5,
          1e9,
        ]);
        log.push(
          `family=${safeString(focus.family)}`,
          `limit=${String(limit)}`,
        );
        const picked =
          limit === undefined
            ? pickRecommendedDrills(drills, focus)
            : pickRecommendedDrills(drills, focus, limit);
        // Array.prototype.slice truncates a fractional end toward zero.
        const cap =
          limit === undefined
            ? 3
            : Number.isNaN(limit)
              ? 0
              : Math.max(0, Math.trunc(limit));
        invariant(
          picked.length <= cap,
          `respects limit ${String(limit)} (got ${picked.length})`,
        );
        invariant(
          picked.every(d => drills.includes(d)),
          'every pick is a catalog entry (no fabricated drill)',
        );
        invariant(new Set(picked).size === picked.length, 'no duplicate picks');
        const matching = drills.filter(d => d.families.includes(focus.family));
        const globals = drills.filter(d => d.families.includes('global'));
        let seenGlobalOnly = false;
        for (const drill of picked) {
          const isMatch = matching.includes(drill);
          invariant(
            isMatch || globals.includes(drill),
            `pick ${safeString(drill.slug)} matches family or global`,
          );
          if (!isMatch) seenGlobalOnly = true;
          else
            invariant(
              !seenGlobalOnly,
              'family matches come before global fill',
            );
        }
        const expected = Math.min(cap, new Set([...matching, ...globals]).size);
        invariant(
          picked.length === expected,
          `fills to min(limit, matching∪global) (got ${picked.length}, want ${expected})`,
        );
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });

  it('drillFocusFromAnalysis → pickRecommendedDrills composes for every persisted shotType vocabulary', () => {
    // Catalog entries are validated at the API seam (training/api.ts
    // parseCatalogDrill: `families` must be a string array), so the catalog
    // is well-formed here; the untrusted side is the persisted analysis.
    const before = table.records.length;
    for (let i = 0; i < plan.iterations; i += 1) {
      runCase(table, 'focusThenPick', plan.seedAt(i, 0xbad), (rng, log) => {
        const analysis = validAnalysis(rng);
        const shotType = rng.chance(0.5)
          ? rng.pick(ALL_SHOT_TYPES)
          : rng.chance(0.5)
            ? rng.pick(PROTO_KEYS)
            : weirdString(rng);
        log.push(`shotType=${safeString(shotType)}`);
        const focus = drillFocusFromAnalysis({
          ...analysis,
          shotType: shotType as never,
          checkpoints: analysis.checkpoints.map(cp => ({
            ...cp,
            applicable: true,
            band: 'red' as const,
            score: rng.int(0, 59),
          })),
        });
        invariant(focus !== null, 'all-red analysis always has a focus');
        invariant(
          typeof focus!.family === 'string',
          `focus.family is a string (got ${safeString(focus!.family)})`,
        );
        invariant(
          KNOWN_FAMILIES.has(focus!.family),
          `focus.family known (got ${safeString(focus!.family)})`,
        );
        const drills = catalog(rng, log);
        const picked = pickRecommendedDrills(drills, focus!, 3);
        invariant(
          picked.length <= 3 && picked.every(d => drills.includes(d)),
          'bounded subset of the catalog',
        );
      });
    }
    expect(brokenSummary(table.since(before))).toBe(
      `0 broken of ${table.records.length - before}`,
    );
  });
});

describe('recommendedDrillsModel · pinned boundary probes', () => {
  it('a priorityFix naming a non-canonical checkpoint key does not become the focus', () => {
    const analysis = validAnalysis(new Rng(11));
    const polluted = jsonRoundTrip({
      ...analysis,
      checkpoints: [
        ...analysis.checkpoints.map(cp => ({
          ...cp,
          band: 'green' as const,
          score: 95,
        })),
        {
          key: '__proto__' as never,
          score: 30,
          confidence: 0.8,
          band: 'red' as const,
          direction: 'late' as const,
          severity: 0.7,
          applicable: true,
        },
      ],
      priorityFix: {
        checkpoint: '__proto__' as never,
        reasonKey: 'lowest_score',
        severity: 0.7,
        confidence: 0.8,
      },
    });
    const focus = drillFocusFromAnalysis(polluted);
    expect(
      focus === null ||
        (CHECKPOINTS as readonly string[]).includes(focus.checkpoint),
    ).toBe(true);
  });

  it('an unknown shotType maps to the global family', () => {
    const analysis = validAnalysis(new Rng(12));
    const focus = drillFocusFromAnalysis({
      ...analysis,
      shotType: 'constructor' as never,
      checkpoints: analysis.checkpoints.map(cp => ({
        ...cp,
        applicable: true,
        band: 'red' as const,
        score: 40,
      })),
    });
    expect(focus?.family).toBe('global');
  });
});
