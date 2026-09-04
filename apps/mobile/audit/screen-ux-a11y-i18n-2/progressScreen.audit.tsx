/**
 * ProgressScreen UX / a11y / i18n audit (screen-ux-a11y-i18n-2).
 *
 * States: loading · load error (+retry) · empty technique · empty practice ·
 * populated technique (device only) · populated + canonical series · canonical
 * 502 (stale/local fallback) · practice populated (automatic + imported +
 * excluded legacy/corrupt captures) · huge counters · adversarial shot-type
 * strings · every range tab · seeded fuzz. Every state renders across
 * FONT_SCALES × WIDTHS (+ RTL cells).
 *
 * Run:  cd apps/mobile && npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js progressScreen
 * Out:  artifacts/screen-ux-a11y-i18n-2/ProgressScreen.{json,summary.json,matrix.tsv}
 */
import React from 'react';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import type {
  CaptureHistoryEntry,
  RealAnalysisFact,
} from '../../src/data/repository';
import type { CanonicalProgress } from '../../src/progress/api';
import {
  ADVERSARIAL_KEYS,
  ADVERSARIAL_STRINGS,
  FIXED_NOW,
  Rng,
  isoDaysAgo,
  makeCanonicalProgress,
  makeFact,
  makePendingCapture,
  makeVerifiedCapture,
  writeArtifacts,
  type ScenarioResult,
} from './harness/fixtures';
import { CELLS, type Cell } from './harness/treeAudit';
import {
  findByProp,
  press,
  runMatrix,
  runScenario,
  type ScenarioSpec,
} from './harness/runner';

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => require('./harness/runner').getWindow(),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

const mockNever = () => new Promise<never>(() => {});

const mockRepo = {
  facts: [] as RealAnalysisFact[],
  captures: [] as CaptureHistoryEntry[],
  mode: 'ok' as 'ok' | 'hang' | 'reject' | 'capturesReject',
};
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: jest.fn(async () => {
    if (mockRepo.mode === 'hang') return mockNever();
    if (mockRepo.mode === 'reject')
      throw new Error('SQLITE_CORRUPT: database disk image is malformed');
    return mockRepo.facts;
  }),
  listCaptureHistory: jest.fn(async () => {
    if (mockRepo.mode === 'hang') return mockNever();
    if (mockRepo.mode === 'capturesReject')
      throw new Error('SQLITE_IOERR: local_capture unreadable');
    return mockRepo.captures;
  }),
}));

const mockSession = { current: null as null | { canonicalAppUserId: string } };
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockSession.current,
}));

const mockCanonical = {
  value: null as CanonicalProgress | null,
  mode: 'ok' as 'ok' | 'reject' | 'hang',
};
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: jest.fn(async () => {
    if (mockCanonical.mode === 'hang') return mockNever();
    if (mockCanonical.mode === 'reject') throw new Error('502 Bad Gateway');
    return mockCanonical.value;
  }),
}));

jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

const mockAppState = {
  profile: null as null | { skillLevel: string; focusCheckpoint: string },
};
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: typeof mockAppState) => unknown) =>
    selector(mockAppState),
}));

const mockConsistencyState = {
  snapshot: null as unknown,
  loadError: false,
  refresh: jest.fn(async () => {}),
};
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: (
    selector: (s: typeof mockConsistencyState) => unknown,
  ) => selector(mockConsistencyState),
}));

jest.mock('../../src/progress/rankCelebration', () => {
  const state = { maybeCelebrate: jest.fn(async () => {}) };
  return {
    useRankCelebrationStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});

import { ProgressScreen } from '../../src/screens/ProgressScreen';

const SCREEN = 'ProgressScreen';
const CONTENT_INSET = 40; // styles.content paddingHorizontal space.lg ×2

function snapshotFor(streakDays: number, seed = 1) {
  const rng = new Rng(seed);
  const activities: Array<{
    kind: 'stroke';
    atIso: string;
    shotType: string;
    overallScore: number;
    resultKind: 'scored';
  }> = [];
  for (let d = 0; d < streakDays; d += 1) {
    activities.push({
      kind: 'stroke',
      atIso: isoDaysAgo(d, 9),
      shotType: rng.pick(['dink', 'serve', 'forehand_drive']),
      overallScore: rng.pick([5, 7.2, 9]),
      resultKind: 'scored',
    });
  }
  return buildConsistencySnapshot(activities, {
    asOfIso: FIXED_NOW.toISOString(),
    timeZone: 'UTC',
  });
}

function reset(): void {
  mockRepo.facts = [];
  mockRepo.captures = [];
  mockRepo.mode = 'ok';
  mockSession.current = null;
  mockCanonical.value = null;
  mockCanonical.mode = 'ok';
  mockAppState.profile = null;
  mockConsistencyState.snapshot = null;
  mockNavigate.mockClear();
}

/** Scored facts spread over the last `spanDays` so every range tab has data,
 * with a comparable (same model/config) series per shot type. */
function scoredFacts(
  seed: number,
  count: number,
  spanDays: number,
): RealAnalysisFact[] {
  const rng = new Rng(seed);
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < count; i += 1) {
    facts.push(
      makeFact(rng, i, {
        capturedAt: isoDaysAgo(rng.int(0, spanDays), rng.int(6, 20)),
        resultKind: 'scored',
        overallScore: rng.pick([2.4, 5, 6.66666, 7.2, 9.9, 10]),
        scoringModelVersion: 'model-2',
        shotConfigVersion: 'config-1',
      }),
    );
  }
  facts.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  return facts;
}

function verifiedCaptures(
  seed: number,
  count: number,
  spanDays: number,
): CaptureHistoryEntry[] {
  const rng = new Rng(seed);
  const rows: CaptureHistoryEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      makeVerifiedCapture(
        rng,
        i,
        rng.bool(0.6) ? 'automatic' : 'imported',
        rng.int(0, spanDays),
      ),
    );
  }
  rows.sort((a, b) => (a.capturedAtIso < b.capturedAtIso ? 1 : -1));
  return rows;
}

const base = (
  id: string,
  state: string,
  seed: number | null,
  inputs: Record<string, unknown>,
  arrange: () => void,
  rest: Partial<ScenarioSpec> = {},
): ScenarioSpec => ({
  id,
  screen: SCREEN,
  state,
  seed,
  inputs,
  arrange: () => {
    reset();
    arrange();
  },
  element: () => <ProgressScreen />,
  contentInset: CONTENT_INSET,
  ...rest,
});

async function pressTab(
  renderer: Parameters<NonNullable<ScenarioSpec['interact']>>[0],
  label: string,
) {
  const tab = findByProp(
    renderer,
    p => p.accessibilityRole === 'tab' && p.accessibilityLabel === label,
  )[0];
  if (!tab) throw new Error(`tab "${label}" not found`);
  await press(tab);
}

const results: ScenarioResult[] = [];
const extraNotes: Record<string, unknown> = {};

beforeAll(() => {
  jest.useFakeTimers({
    now: FIXED_NOW.getTime(),
    doNotFake: [
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'nextTick',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'performance',
      'hrtime',
    ],
  });
});

afterAll(() => {
  jest.useRealTimers();
  const summary = writeArtifacts(SCREEN, results, extraNotes);
  expect(summary.threw).toEqual([]);
});

describe('ProgressScreen audit matrix', () => {
  it('loading state (repository never resolves)', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'progress.loading',
          'loading',
          null,
          { repoMode: 'hang' },
          () => {
            mockRepo.mode = 'hang';
          },
          {
            mustContain: [
              'Loading measured progress…',
              'Keep Pickle Sensei open.',
            ],
          },
        ),
        CELLS,
      )),
    );
  });

  it('load error (facts + captures) shows the error and retry recovers', async () => {
    const spec = base(
      'progress.error',
      'error',
      null,
      { repoMode: 'reject' },
      () => {
        mockRepo.mode = 'reject';
      },
      {
        mustContain: ['Progress couldn’t load', 'Try again'],
        mustNotContain: ['SQLITE_CORRUPT'],
      },
    );
    results.push(...(await runMatrix(spec, CELLS)));
    results.push(
      ...(await runMatrix(
        base(
          'progress.error.captures',
          'error-captures-only',
          null,
          { repoMode: 'capturesReject' },
          () => {
            mockRepo.mode = 'capturesReject';
            mockRepo.facts = scoredFacts(3, 5, 10);
          },
          {
            mustContain: ['Progress couldn’t load'],
            mustNotContain: ['SQLITE_IOERR'],
          },
        ),
        [CELLS[1]!, CELLS[8]!],
      )),
    );
    const recovered = await runScenario(
      {
        ...spec,
        id: 'progress.error.retry',
        state: 'error→retry→populated',
        interact: async renderer => {
          const retry = findByProp(
            renderer,
            p => p.accessibilityRole === 'button',
          ).find(
            n => n.findAll(c => c.props.children === 'Try again').length > 0,
          );
          if (!retry) throw new Error('retry button not found');
          mockRepo.mode = 'ok';
          mockRepo.facts = scoredFacts(7, 8, 20);
          await press(retry);
        },
        mustContain: ['KEY STATISTICS'],
        mustNotContain: ['Progress couldn’t load'],
      },
      { cell: CELLS[4]!, verbose: true },
    );
    results.push(recovered);
    expect(recovered.issues.filter(i => i.kind.startsWith('state.'))).toEqual(
      [],
    );
  });

  it('empty technique tab (no facts, no captures, no snapshot, no profile)', async () => {
    results.push(
      ...(await runMatrix(
        base('progress.empty.technique', 'empty', null, {}, () => {}, {
          mustContain: [
            'No scored technique yet',
            'No score is being estimated.',
            'Comparable trends start after scoring',
          ],
        }),
        CELLS,
      )),
    );
  });

  it('empty practice tab', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'progress.empty.practice',
          'empty-practice',
          null,
          { tab: 'practice progress' },
          () => {},
          {
            interact: renderer => pressTab(renderer, 'practice progress'),
            mustContain: [
              'This chart is waiting on you.',
              'No measured captures yet',
            ],
            // `comparisonCopy`'s "Your first verified capture starts this
            // chart." branch is unreachable: it renders only inside the
            // captureCount > 0 branch (ProgressScreen.tsx). Recorded, not asserted.
            mustNotContain: ['Your first verified capture starts this chart.'],
          },
        ),
        CELLS,
      )),
    );
  });

  it('populated technique tab (device only) across every range', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'progress.technique.populated',
          'populated',
          42,
          { facts: 40, span: 80 },
          () => {
            mockRepo.facts = scoredFacts(42, 40, 80);
            mockConsistencyState.snapshot = snapshotFor(4);
            mockAppState.profile = {
              skillLevel: '3.5',
              focusCheckpoint: 'contact_position',
            };
          },
          { mustContain: ['KEY STATISTICS', 'SCORE TREND', 'BY STROKE'] },
        ),
        CELLS,
      )),
    );
    for (const range of ['7 days range', '4 weeks range', '90 days range']) {
      results.push(
        await runScenario(
          base(
            `progress.technique.range.${range.split(' ')[0]}`,
            `populated-range:${range}`,
            42,
            { range },
            () => {
              mockRepo.facts = scoredFacts(42, 40, 400);
              mockConsistencyState.snapshot = snapshotFor(4);
            },
            { interact: renderer => pressTab(renderer, range) },
          ),
          { cell: CELLS[4]!, verbose: true },
        ),
      );
    }
  });

  it('technique + canonical series (signed-in), then canonical 502 → local fallback', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'progress.canonical.ok',
          'populated+canonical',
          77,
          { canonical: 'ok' },
          () => {
            mockRepo.facts = scoredFacts(77, 10, 20);
            mockSession.current = { canonicalAppUserId: 'user-77' };
            mockCanonical.value = makeCanonicalProgress(new Rng(77));
            mockConsistencyState.snapshot = snapshotFor(12);
          },
        ),
        CELLS,
      )),
    );
    results.push(
      ...(await runMatrix(
        base(
          'progress.canonical.reject',
          'populated+canonical-502',
          78,
          { canonical: 'reject' },
          () => {
            mockRepo.facts = scoredFacts(78, 10, 20);
            mockSession.current = { canonicalAppUserId: 'user-78' };
            mockCanonical.mode = 'reject';
          },
          {
            mustContain: ['KEY STATISTICS'],
            mustNotContain: ['502', 'Bad Gateway'],
          },
        ),
        CELLS,
      )),
    );
    // Synced-only headline (no local scored fact) with an adversarial shot type.
    results.push(
      ...(await runMatrix(
        base(
          'progress.canonical.onlySynced',
          'synced-only-headline',
          79,
          { canonical: 'ok', localScored: 0 },
          () => {
            mockSession.current = { canonicalAppUserId: 'user-79' };
            mockCanonical.value = {
              ...makeCanonicalProgress(new Rng(79)),
              series: [1, 2, 3].map(d => ({
                day: isoDaysAgo(d).slice(0, 10),
                shotType: ADVERSARIAL_STRINGS.germanLong,
                scoringModelVersion: '1',
                shotCount: 3,
                avgScore: 6.66666,
                bestScore: 8,
              })),
            };
          },
          { mustContain: ['daily average'] },
        ),
        CELLS,
      )),
    );
  });

  it('populated practice tab: automatic + imported + excluded captures across ranges', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'progress.practice.populated',
          'populated-practice',
          55,
          { verified: 18, excluded: 6 },
          () => {
            const rng = new Rng(55);
            mockRepo.captures = [
              ...verifiedCaptures(55, 18, 60),
              ...Array.from({ length: 6 }, (_, i) => ({
                ...makePendingCapture(rng, 100 + i, {
                  evidenceStatus: rng.pick([
                    'legacy',
                    'corrupt',
                    'metadata_mismatch',
                  ]),
                }),
                status: 'analyzed' as const,
              })),
            ];
            mockConsistencyState.snapshot = snapshotFor(6);
          },
          {
            interact: renderer => pressTab(renderer, 'practice progress'),
            mustContain: ['VERIFIED PRACTICE', 'captured', 'RECENT CAPTURES'],
          },
        ),
        CELLS,
      )),
    );
    for (const range of ['7 days range', '4 weeks range', '90 days range']) {
      results.push(
        await runScenario(
          base(
            `progress.practice.range.${range.split(' ')[0]}`,
            `populated-practice-range:${range}`,
            55,
            { range },
            () => {
              mockRepo.captures = verifiedCaptures(55, 30, 400);
              mockConsistencyState.snapshot = snapshotFor(6);
            },
            {
              interact: async renderer => {
                await pressTab(renderer, 'practice progress');
                await pressTab(renderer, range);
              },
            },
          ),
          { cell: CELLS[4]!, verbose: true },
        ),
      );
    }
    // Imported-only practice: no camera evidence → "—" not a fabricated 0.0s.
    results.push(
      await runScenario(
        base(
          'progress.practice.importedOnly',
          'practice-imported-only',
          56,
          { imported: 5 },
          () => {
            const rng = new Rng(56);
            mockRepo.captures = Array.from({ length: 5 }, (_, i) =>
              makeVerifiedCapture(rng, i, 'imported', i),
            );
          },
          {
            interact: renderer => pressTab(renderer, 'practice progress'),
            mustContain: ['—', 'imported'],
          },
        ),
        { cell: CELLS[4]!, verbose: true },
      ),
    );
  });

  it('huge counters and extreme scores (99999 reps, 10.0 best, 0.0 avg)', async () => {
    results.push(
      ...(await runMatrix(
        base('progress.huge', 'populated-extremes', 91, { facts: 400 }, () => {
          const rng = new Rng(91);
          mockRepo.facts = Array.from({ length: 400 }, (_, i) =>
            makeFact(rng, i, {
              shotType: 'dink',
              capturedAt: isoDaysAgo(i % 27, 12),
              resultKind: 'scored',
              overallScore: i % 2 === 0 ? 0 : 10,
              scoringModelVersion: 'model-2',
              shotConfigVersion: 'config-1',
            }),
          );
          mockConsistencyState.snapshot = {
            ...(snapshotFor(1) as object),
            currentStreak: 10_000,
            longestStreak: 99_999,
          };
        }),
        [CELLS[0]!, CELLS[6]!, CELLS[8]!],
      )),
    );
  });

  it('adversarial shot-type strings in technique cards and capture titles', async () => {
    for (const key of ADVERSARIAL_KEYS) {
      const value = ADVERSARIAL_STRINGS[key];
      results.push(
        ...(await runMatrix(
          base(
            `progress.shotType.${key}`,
            'adversarial-shot-type',
            500,
            { key, value },
            () => {
              const rng = new Rng(500);
              mockRepo.facts = [0, 1, 2, 3].map(i =>
                makeFact(rng, i, {
                  shotType: value,
                  capturedAt: isoDaysAgo(i, 12),
                  resultKind: 'scored',
                  overallScore: 6 + i * 0.5,
                  scoringModelVersion: 'model-2',
                  shotConfigVersion: 'config-1',
                }),
              );
              mockRepo.captures = [0, 1].map(i =>
                makeVerifiedCapture(rng, i, 'imported', i, {
                  shotType: value,
                  declaredStroke: null,
                }),
              );
            },
          ),
          [CELLS[0]!, CELLS[4]!, CELLS[6]!, CELLS[9]!],
        )),
      );
      results.push(
        await runScenario(
          base(
            `progress.captureTitle.${key}`,
            'adversarial-capture-title',
            501,
            { key, value },
            () => {
              const rng = new Rng(501);
              mockRepo.captures = [0, 1].map(i =>
                makeVerifiedCapture(rng, i, 'imported', i, {
                  shotType: value,
                  declaredStroke: null,
                }),
              );
            },
            { interact: renderer => pressTab(renderer, 'practice progress') },
          ),
          { cell: CELLS[6]!, verbose: false },
        ),
      );
    }
  });

  it('seeded fuzz: 100 seeds × 2 cells × both tabs', async () => {
    const fuzzCells: Cell[] = [CELLS[1]!, CELLS[3]!];
    for (let seed = 2000; seed < 2100; seed += 1) {
      const rng = new Rng(seed);
      const factCount = rng.int(0, 60);
      const captureCount = rng.int(0, 25);
      const arrange = () => {
        const r = new Rng(seed);
        mockRepo.facts = Array.from({ length: factCount }, (_, i) =>
          makeFact(r, i),
        );
        mockRepo.facts.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
        mockRepo.captures = Array.from({ length: captureCount }, (_, i) =>
          r.bool(0.5)
            ? makeVerifiedCapture(
                r,
                i,
                r.bool(0.5) ? 'automatic' : 'imported',
                r.int(0, 45),
              )
            : {
                ...makePendingCapture(r, i),
                status: r.bool()
                  ? ('analyzed' as const)
                  : ('awaiting_model' as const),
              },
        );
        if (r.bool(0.5)) {
          mockSession.current = { canonicalAppUserId: `user-${seed}` };
          mockCanonical.value = makeCanonicalProgress(r);
        }
        if (r.bool(0.6))
          mockConsistencyState.snapshot = snapshotFor(r.int(0, 40), seed);
      };
      for (const cell of fuzzCells) {
        results.push(
          await runScenario(
            base(
              `progress.fuzz.${seed}`,
              'fuzz-technique',
              seed,
              { factCount, captureCount },
              arrange,
            ),
            { cell, verbose: false },
          ),
        );
      }
      results.push(
        await runScenario(
          base(
            `progress.fuzz.${seed}.practice`,
            'fuzz-practice',
            seed,
            { factCount, captureCount },
            arrange,
            {
              interact: renderer => pressTab(renderer, 'practice progress'),
            },
          ),
          { cell: fuzzCells[seed % 2]!, verbose: false },
        ),
      );
    }
    extraNotes.fuzz = { seeds: '2000..2099', cells: fuzzCells };
  });

  it('consistency card navigates to the streak calendar', async () => {
    const r = await runScenario(
      base(
        'progress.nav.calendar',
        'practice→calendar',
        55,
        {},
        () => {
          mockRepo.captures = verifiedCaptures(55, 4, 10);
          mockConsistencyState.snapshot = snapshotFor(6);
        },
        {
          interact: async renderer => {
            await pressTab(renderer, 'practice progress');
            const card = findByProp(
              renderer,
              p =>
                typeof p.accessibilityLabel === 'string' &&
                /consistency|streak/i.test(p.accessibilityLabel) &&
                p.accessibilityRole === 'button',
            )[0];
            if (!card) throw new Error('consistency card button not found');
            await press(card);
          },
        },
      ),
      { cell: CELLS[4]!, verbose: false },
    );
    results.push(r);
    extraNotes.navigation = { calls: mockNavigate.mock.calls };
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
  });
});
