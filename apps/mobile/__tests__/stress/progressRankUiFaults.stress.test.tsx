/**
 * STRESS / failure-injection — the two rank surfaces (PlayerRankCard,
 * PlayerRankBanner) under a faulting rank API and hostile local history.
 *
 * Per seed: one component, a signed-in or signed-out session, one fetch
 * fault (resolve null / valid / hostile-but-parse-accepted payload, reject
 * with an Error / a non-Error, resolve after 30 s, reject after 30 s, never
 * settle) and a small hostile local history. The tree is rendered with fake
 * timers, driven 60 s forward, then optionally unmounted mid-flight and the
 * pending fetch settled afterwards.
 *
 * Oracle:
 *   U1 nothing throws during render, effects, timer advance or unmount; no
 *      console.error from React (leaked state updates, duplicate keys…).
 *   U2 no spinner/loading affordance remains after 60 s.
 *   U3 no leaked internals (NaN / Infinity / undefined / null / [object) in
 *      any rendered text or accessibility label.
 *   U4 the shown rank equals resolvePlayerRank(localFacts, settledServerRank)
 *      — a failed / pending fetch falls back to the device rank or Unranked,
 *      never to an invented rank, and the Card's provenance line matches the
 *      source; a rank that is shown is internally coherent (tier band, non-
 *      negative next-tier distance, sane counts).
 *   U5 the celebration store only ever receives summaries that were actually
 *      resolved, and the last report equals the shown rank.
 *   U6 settling the fetch after unmount produces no React error.
 *   U7 (recorded, not asserted) whether a retry control exists after a fetch
 *      failure — the surfaces fall back silently by design.
 */
import React from 'react';
import { ActivityIndicator, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';
import type { RealAnalysisFact } from '../../src/data/repository';
import type { ServerPlayerRank } from '../../src/progress/playerRank';
import {
  chance,
  fail,
  int,
  leakedMarkers,
  mulberry32,
  pick,
  planCampaign,
  StressTable,
  type Rng,
} from '../../test-support/stress/seededStress';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchPlayerRank = jest.fn<
  Promise<ServerPlayerRank | null>,
  unknown[]
>();
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (...args: unknown[]) => mockFetchPlayerRank(...args),
  };
});

const celebrated: PlayerRankSummary[] = [];
jest.mock('../../src/progress/rankCelebration', () => {
  const state = {
    maybeCelebrate: async (summary: PlayerRankSummary) => {
      celebrated.push(summary);
    },
  };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import { resolvePlayerRank } from '../../src/progress/playerRank';
import { playerRankTierForRating } from '@pickle/shared-types';

const CAMPAIGN = 'progressRankUiFaults';
const plan = planCampaign(CAMPAIGN, 41_000, 48);
const table = new StressTable(CAMPAIGN, plan);

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'test-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

type Surface = 'card' | 'banner';
type FetchFault =
  | 'ok-null'
  | 'ok-valid'
  | 'ok-hostile'
  | 'reject-error'
  | 'reject-non-error'
  | 'slow-ok'
  | 'slow-reject'
  | 'never';

const FETCH_FAULTS: readonly FetchFault[] = [
  'ok-null',
  'ok-valid',
  'ok-valid',
  'ok-hostile',
  'ok-hostile',
  'reject-error',
  'reject-non-error',
  'slow-ok',
  'slow-reject',
  'never',
];

const SHOT_TYPES = ['dink', 'volley', 'third_shot_drop', 'serve'];
const TIERS = ['bronze', 'silver', 'gold', 'platinum', 'diamond'] as const;

function score1(rng: Rng): number {
  return Math.round(rng() * 100) / 10;
}

function factsFor(rng: Rng): RealAnalysisFact[] {
  const count = pick(rng, [0, 0, 1, 2, 5, 9, 40]);
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < count; i += 1) {
    const hostile = chance(rng, 0.25);
    facts.push({
      id: `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`,
      shotType:
        hostile && chance(rng, 0.3)
          ? pick(rng, ['', 'Dink'])
          : pick(rng, SHOT_TYPES),
      capturedAt:
        hostile && chance(rng, 0.3)
          ? pick(rng, ['', 'garbage', '2027-01-01T00:00:00.000Z'])
          : new Date(
              Date.UTC(2026, 7, 1 + int(rng, 0, 30), int(rng, 0, 23)),
            ).toISOString(),
      overallScore:
        hostile && chance(rng, 0.5)
          ? pick(rng, [Number.NaN, Number.POSITIVE_INFINITY, -1, 11, null])
          : score1(rng),
      confidence: rng(),
      resultKind: hostile && chance(rng, 0.3) ? 'low_confidence' : 'scored',
      scoringModelVersion: 'v2',
      shotConfigVersion: 'c2',
      sessionId: null,
      priorityCheckpoint: null,
      checkpointScores: {},
    });
  }
  return facts;
}

function validServerRank(rng: Rng): ServerPlayerRank {
  const rating = score1(rng);
  const techniques = Array.from({ length: int(rng, 1, 3) }, (_, i) => ({
    shotType: SHOT_TYPES[i]!,
    score: score1(rng),
    capturedAt: '2026-08-20T00:00:00.000Z',
    sampledCount: int(rng, 1, 8),
  }));
  return {
    rating,
    tier: playerRankTierForRating(rating).key,
    techniqueCount: techniques.length,
    scoredShotCount: int(rng, techniques.length, 60),
    updatedAt: '2026-08-20T00:00:00.000Z',
    techniques,
  };
}

/** Everything here passes parsePlayerRank yet strains the presentation. */
function hostileServerRank(rng: Rng, notes: string[]): ServerPlayerRank {
  const base = validServerRank(rng);
  const twist = pick(rng, [
    'rating-0',
    'rating-10',
    'rating-neg-zero',
    'rating-denormal',
    'tier-unknown',
    'tier-mismatch',
    'count-zero',
    'count-negative',
    'count-huge',
    'count-fraction',
    'scored-null',
    'scored-negative',
    'scored-huge',
    'techniques-empty',
    'techniques-many',
    'techniques-dup',
    'technique-empty-shot',
    'technique-score-huge',
    'technique-score-negative',
  ] as const);
  notes.push(`hostile ${twist}`);
  switch (twist) {
    case 'rating-0':
      return { ...base, rating: 0, tier: 'bronze' };
    case 'rating-10':
      return { ...base, rating: 10, tier: 'diamond' };
    case 'rating-neg-zero':
      return { ...base, rating: -0, tier: 'bronze' };
    case 'rating-denormal':
      return { ...base, rating: 5e-324, tier: 'bronze' };
    case 'tier-unknown':
      return { ...base, tier: pick(rng, ['mythic', '', 'Gold']) };
    case 'tier-mismatch':
      return {
        ...base,
        tier: pick(
          rng,
          TIERS.filter(t => t !== base.tier),
        ),
      };
    case 'count-zero':
      return { ...base, techniqueCount: 0 };
    case 'count-negative':
      return { ...base, techniqueCount: -3 };
    case 'count-huge':
      return { ...base, techniqueCount: 1e308 };
    case 'count-fraction':
      return { ...base, techniqueCount: 1.5 };
    case 'scored-null':
      return { ...base, scoredShotCount: null };
    case 'scored-negative':
      return { ...base, scoredShotCount: -7 };
    case 'scored-huge':
      return { ...base, scoredShotCount: 1e15 };
    case 'techniques-empty':
      return { ...base, techniques: [] };
    case 'techniques-many':
      return {
        ...base,
        techniques: Array.from({ length: 40 }, (_, i) => ({
          shotType: `stroke_${i}`,
          score: score1(rng),
          capturedAt: '2026-08-20T00:00:00.000Z',
        })),
      };
    case 'techniques-dup':
      return {
        ...base,
        techniques: [base.techniques[0]!, { ...base.techniques[0]!, score: 1 }],
      };
    case 'technique-empty-shot':
      return {
        ...base,
        techniques: [{ ...base.techniques[0]!, shotType: '' }],
      };
    case 'technique-score-huge':
      return {
        ...base,
        techniques: [{ ...base.techniques[0]!, score: 1e308 }],
      };
    case 'technique-score-negative':
      return {
        ...base,
        techniques: [{ ...base.techniques[0]!, score: -1e308 }],
      };
  }
}

interface FetchPlan {
  fault: FetchFault;
  /** What the component will see once (and if) the promise settles. */
  settled: ServerPlayerRank | null;
  /** Settles within the 60 s window. */
  settlesInWindow: boolean;
  /** Resolves the pending promise (for slow/never faults) on demand. */
  release: () => void;
}

function planFetch(rng: Rng, fault: FetchFault, notes: string[]): FetchPlan {
  const payload =
    fault === 'ok-valid' || fault === 'slow-ok'
      ? validServerRank(rng)
      : fault === 'ok-hostile'
        ? hostileServerRank(rng, notes)
        : null;
  let release: () => void = () => {};
  const rejection =
    fault === 'reject-non-error' ? 'boom' : new Error('offline');
  mockFetchPlayerRank.mockImplementation(() => {
    switch (fault) {
      case 'ok-null':
      case 'ok-valid':
      case 'ok-hostile':
        return Promise.resolve(payload);
      case 'reject-error':
      case 'reject-non-error':
        return Promise.reject(rejection);
      case 'slow-ok':
        return new Promise(resolve => {
          setTimeout(() => resolve(payload), 30_000);
        });
      case 'slow-reject':
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('timeout')), 30_000);
        });
      case 'never':
        return new Promise(resolve => {
          release = () => resolve(payload);
        });
    }
  });
  return {
    fault,
    settled:
      fault === 'ok-null' ||
      fault.startsWith('reject') ||
      fault === 'slow-reject' ||
      fault === 'never'
        ? null
        : payload,
    settlesInWindow: fault !== 'never',
    release: () => release(),
  };
}

function allText(renderer: TestRenderer.ReactTestRenderer): string[] {
  const texts = renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .map(String);
  const labels = renderer.root
    .findAll(node => typeof node.props.accessibilityLabel === 'string')
    .map(node => String(node.props.accessibilityLabel));
  return [...texts, ...labels];
}

function hasRetryControl(renderer: TestRenderer.ReactTestRenderer): boolean {
  return renderer.root
    .findAll(node => typeof node.props.onPress === 'function')
    .some(node =>
      /retry|try again|reload|refresh/i.test(
        String(node.props.accessibilityLabel ?? ''),
      ),
    );
}

let consoleErrors: string[] = [];
const realConsoleError = console.error;

beforeAll(() => {
  jest.useFakeTimers();
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  };
});

afterAll(() => {
  console.error = realConsoleError;
  jest.useRealTimers();
  const path = table.write();

  console.log(
    `[${CAMPAIGN}] executed=${table.rows.length} broken=${table.broken.length} → ${path}`,
  );
});

beforeEach(() => {
  consoleErrors = [];
  celebrated.length = 0;
  mockGetApiSession.mockReset();
  mockFetchPlayerRank.mockReset();
});

async function runSeed(seed: number) {
  const rng = mulberry32(seed);
  const failures: string[] = [];
  const notes: string[] = [];
  const surface: Surface = pick(rng, ['card', 'banner']);
  const signedIn = chance(rng, 0.8);
  const fault: FetchFault = pick(rng, FETCH_FAULTS);
  const unmountEarly = chance(rng, 0.3);
  const facts = factsFor(rng);
  mockGetApiSession.mockReturnValue(signedIn ? SESSION : null);
  const fetchPlan = planFetch(rng, fault, notes);

  const element =
    surface === 'card' ? (
      <PlayerRankCard facts={facts} />
    ) : (
      <PlayerRankBanner
        shots={facts}
        streakDays={int(rng, 0, 30)}
        onPressStreak={() => {}}
      />
    );

  let renderer!: TestRenderer.ReactTestRenderer;
  let unmounted = false;
  try {
    await act(async () => {
      renderer = TestRenderer.create(element);
    });
    if (unmountEarly) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(5_000);
      });
      act(() => renderer.unmount());
      unmounted = true;
      await act(async () => {
        fetchPlan.release();
        await jest.advanceTimersByTimeAsync(60_000);
      });
    } else {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(60_000);
      });
    }
  } catch (error) {
    failures.push(fail('U1-throws', String(error)));
    return table.record(
      seed,
      `${surface}+${fault}+${signedIn ? 'signed-in' : 'signed-out'}`,
      failures,
      { notes },
    );
  }

  const detail: Record<string, unknown> = {
    surface,
    signedIn,
    fault,
    unmountEarly,
    facts: facts.length,
    fetchCalls: mockFetchPlayerRank.mock.calls.length,
    celebrations: celebrated.length,
  };

  if (!signedIn && mockFetchPlayerRank.mock.calls.length > 0) {
    failures.push(
      fail('U4-fetch-signed-out', 'rank API called without a session'),
    );
  }

  const serverForOracle =
    signedIn && fetchPlan.settlesInWindow ? fetchPlan.settled : null;
  const expected = resolvePlayerRank(facts, serverForOracle);

  if (!unmounted) {
    const spinners = renderer.root.findAllByType(ActivityIndicator).length;
    if (spinners > 0)
      failures.push(
        fail('U2-spinner', `${spinners} ActivityIndicator after 60s`),
      );
    const texts = allText(renderer);
    for (const text of texts) {
      const leaked = leakedMarkers(text);
      if (leaked.length > 0)
        failures.push(
          fail('U3-leak', `${leaked.join(',')} in ${JSON.stringify(text)}`),
        );
    }
    const joined = texts.join('\n');
    if (expected === null) {
      if (!joined.includes('Unranked'))
        failures.push(
          fail(
            'U4-fabricated-rank',
            'no Unranked copy with nothing resolvable',
          ),
        );
      if (/\d\.\d\d\s*\/\s*10|out of 10/.test(joined))
        failures.push(
          fail('U4-fabricated-rating', 'a rating is shown while unranked'),
        );
    } else {
      const { summary, source } = expected;
      if (!joined.includes(summary.tierLabel))
        failures.push(fail('U4-tier-label', `${summary.tierLabel} not shown`));
      if (!joined.includes(summary.rating.toFixed(2)))
        failures.push(
          fail('U4-rating', `${summary.rating.toFixed(2)} not shown`),
        );
      if (surface === 'card') {
        const accountNote = joined.includes('Saved to your account.');
        if (accountNote !== (source === 'account'))
          failures.push(
            fail(
              'U4-source-note',
              `account note ${accountNote} for source ${source}`,
            ),
          );
      }
      if (summary.tier !== playerRankTierForRating(summary.rating).key) {
        failures.push(
          fail(
            'U4-tier-band',
            `${summary.tierLabel} shown for rating ${summary.rating}`,
          ),
        );
      }
      if (summary.nextTier && summary.nextTier.pointsNeeded < 0) {
        failures.push(
          fail(
            'U4-negative-distance',
            `${summary.nextTier.pointsNeeded.toFixed(2)} to ${summary.nextTier.label}`,
          ),
        );
      }
      if (
        !Number.isSafeInteger(summary.techniqueCount) ||
        summary.techniqueCount < 0
      ) {
        failures.push(
          fail('U4-technique-count', String(summary.techniqueCount)),
        );
      }
      if (
        !Number.isSafeInteger(summary.scoredAnalysisCount) ||
        summary.scoredAnalysisCount < 0
      ) {
        failures.push(
          fail('U4-scored-count', String(summary.scoredAnalysisCount)),
        );
      }
      for (const technique of summary.techniques) {
        if (!(technique.score >= 0 && technique.score <= 10)) {
          failures.push(
            fail(
              'U4-technique-score',
              `${technique.shotType || '(empty)'}=${technique.score}`,
            ),
          );
        }
      }
    }
    const fetchFailed =
      signedIn &&
      (fault.startsWith('reject') ||
        fault === 'slow-reject' ||
        fault === 'never');
    if (fetchFailed) {
      detail.retryControl = hasRetryControl(renderer);
      notes.push(
        `U7 retry control after ${fault}: ${detail.retryControl ? 'present' : 'absent (silent fallback)'}`,
      );
    }
  }

  // U5 — every celebration report must be a rank that was actually resolved
  // at some point (local-only, then local+server), and the last one shown.
  const derivable = new Set(
    [
      resolvePlayerRank(facts, null),
      signedIn && fetchPlan.settled
        ? resolvePlayerRank(facts, fetchPlan.settled)
        : null,
    ]
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .map(r => JSON.stringify(r.summary)),
  );
  for (const summary of celebrated) {
    if (!derivable.has(JSON.stringify(summary)))
      failures.push(
        fail('U5-underivable-celebration', `${summary.tier}@${summary.rating}`),
      );
  }
  if (!unmounted && expected && celebrated.length > 0) {
    const last = celebrated.at(-1)!;
    if (JSON.stringify(last) !== JSON.stringify(expected.summary)) {
      failures.push(
        fail(
          'U5-last-celebration',
          `${last.tier}@${last.rating} vs shown ${expected.summary.tier}@${expected.summary.rating}`,
        ),
      );
    }
  }
  if (!unmounted && expected && celebrated.length === 0) {
    failures.push(
      fail(
        'U5-no-report',
        'a rank is shown but the celebration store never heard of it',
      ),
    );
  }
  if (celebrated.length > 2)
    failures.push(
      fail('U5-report-storm', `${celebrated.length} reports for one mount`),
    );

  for (const message of consoleErrors) {
    failures.push(fail('U1-console-error', message.slice(0, 160)));
  }
  if (!unmounted) act(() => renderer.unmount());
  if (notes.length > 0) detail.notes = notes;
  return table.record(
    seed,
    `${surface}+${fault}+${signedIn ? 'signed-in' : 'signed-out'}${unmountEarly ? '+unmount-early' : ''}`,
    failures,
    detail,
  );
}

describe(`${CAMPAIGN}: rank surfaces under a faulting rank API`, () => {
  it.each(plan.seeds)('seed %i', async seed => {
    const row = await runSeed(seed);
    if (row.outcome === 'broken') {
      console.log(
        `[${CAMPAIGN}] seed=${seed} BROKEN ${row.failures.join(' | ')}`,
      );
    }
    expect({ seed, fault: row.fault, failures: row.failures }).toEqual({
      seed,
      fault: row.fault,
      failures: [],
    });
  });
});
