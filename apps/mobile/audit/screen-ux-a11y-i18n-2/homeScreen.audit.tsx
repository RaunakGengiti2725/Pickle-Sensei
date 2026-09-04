/**
 * HomeScreen UX / a11y / i18n audit (screen-ux-a11y-i18n-2).
 *
 * States: loading · load error (+retry) · first-run empty · quiet week ·
 * populated (device only) · populated + canonical progress · canonical fetch
 * failure (stale fallback) · corrupt week-chart preference · notification
 * priming card visible · huge streak · adversarial profile strings ·
 * seeded fuzz. Every state renders across FONT_SCALES × WIDTHS.
 *
 * Run:  cd apps/mobile && npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js homeScreen
 * Out:  artifacts/screen-ux-a11y-i18n-2/HomeScreen.{json,summary.json,matrix.tsv}
 */
import React from 'react';
import { buildConsistencySnapshot } from '../../src/consistency/engine';
import type { RealAnalysisFact, LocalShotRow } from '../../src/data/repository';
import type { CanonicalProgress } from '../../src/progress/api';
import {
  ADVERSARIAL_STRINGS,
  ADVERSARIAL_KEYS,
  FIXED_NOW,
  Rng,
  isoDaysAgo,
  makeCanonicalProgress,
  makeFact,
  makeShot,
  writeArtifacts,
  type ScenarioResult,
} from './harness/fixtures';
import { CELLS, type Cell } from './harness/treeAudit';
import {
  findByProp,
  getWindow,
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

type Pending = { promise: Promise<never> };
const mockNever = (): Pending => ({ promise: new Promise<never>(() => {}) });

const mockRepo = {
  shots: [] as LocalShotRow[],
  facts: [] as RealAnalysisFact[],
  storedChart: null as string | null,
  mode: 'ok' as 'ok' | 'hang' | 'reject' | 'kvReject',
  setKvCalls: [] as string[],
};
jest.mock('../../src/data/repository', () => ({
  listShots: jest.fn(async () => {
    if (mockRepo.mode === 'hang') return mockNever().promise;
    if (mockRepo.mode === 'reject')
      throw new Error('SQLITE_IOERR: disk I/O error while reading shots');
    return mockRepo.shots;
  }),
  listRealAnalysisFacts: jest.fn(async () => {
    if (mockRepo.mode === 'hang') return mockNever().promise;
    return mockRepo.facts;
  }),
  getKv: jest.fn(async () => {
    if (mockRepo.mode === 'kvReject') throw new Error('kv unreadable');
    return mockRepo.storedChart;
  }),
  setKv: jest.fn(async (_db: unknown, _key: string, value: string) => {
    mockRepo.setKvCalls.push(value);
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
    if (mockCanonical.mode === 'hang') return mockNever().promise;
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
  profile: null as null | {
    firstName?: string;
    skillLevel: string;
    focusCheckpoint: string;
    goal: string;
    biggestProblem: string;
    handedness: string;
  },
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

const mockNotificationState = {
  hydrated: false,
  prefs: { enabled: false, promptDismissed: false },
  permission: 'unknown' as string,
  requestPermissionAndEnable: jest.fn(async () => false),
  dismissPrompt: jest.fn(async () => {}),
};
jest.mock('../../src/notifications/notificationStore', () => ({
  useNotificationStore: (
    selector: (s: typeof mockNotificationState) => unknown,
  ) => selector(mockNotificationState),
}));

import { HomeScreen } from '../../src/screens/HomeScreen';

const SCREEN = 'HomeScreen';
const CONTENT_INSET = 40; // styles.content paddingHorizontal space.lg ×2

function snapshotFor(streakDays: number, seed = 1) {
  const rng = new Rng(seed);
  const activities: Array<
    | {
        kind: 'stroke';
        atIso: string;
        shotType: string;
        overallScore: number;
        resultKind: 'scored';
      }
    | { kind: 'drill'; atIso: string; label: string }
  > = [];
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
  mockRepo.shots = [];
  mockRepo.facts = [];
  mockRepo.storedChart = null;
  mockRepo.mode = 'ok';
  mockRepo.setKvCalls = [];
  mockSession.current = null;
  mockCanonical.value = null;
  mockCanonical.mode = 'ok';
  mockAppState.profile = null;
  mockConsistencyState.snapshot = null;
  mockConsistencyState.loadError = false;
  mockNotificationState.hydrated = false;
  mockNotificationState.prefs = { enabled: false, promptDismissed: false };
  mockNavigate.mockClear();
}

function populate(seed: number, shotCount: number, factCount: number): void {
  const rng = new Rng(seed);
  mockRepo.shots = Array.from({ length: shotCount }, (_, i) =>
    makeShot(rng, i),
  );
  mockRepo.shots.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  mockRepo.facts = Array.from({ length: factCount }, (_, i) =>
    makeFact(rng, i),
  );
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
  element: () => <HomeScreen />,
  contentInset: CONTENT_INSET,
  ...rest,
});

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
  // Hard invariants for the harness itself: nothing may throw or render blank.
  expect(summary.threw).toEqual([]);
});

describe('HomeScreen audit matrix', () => {
  it('loading state (repository never resolves)', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'home.loading',
          'loading',
          null,
          { repoMode: 'hang' },
          () => {
            mockRepo.mode = 'hang';
          },
          { mustContain: ['Loading your court…', 'Keep Pickle Sensei open.'] },
        ),
        CELLS,
      )),
    );
  });

  it('load error state shows the error and a retry control that reloads', async () => {
    const spec = base(
      'home.error',
      'error',
      null,
      { repoMode: 'reject' },
      () => {
        mockRepo.mode = 'reject';
      },
      {
        mustContain: ['Your court couldn’t load', 'Try again'],
      },
    );
    results.push(...(await runMatrix(spec, CELLS)));
    // Retry must actually re-run the load and recover once the DB is healthy.
    const recovered = await runScenario(
      {
        ...spec,
        id: 'home.error.retry',
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
          populate(7, 6, 6);
          await press(retry);
        },
        mustContain: ['THIS WEEK'],
        mustNotContain: ['Your court couldn’t load'],
      },
      { cell: CELLS[4]!, verbose: true },
    );
    results.push(recovered);
    expect(recovered.issues.filter(i => i.kind.startsWith('state.'))).toEqual(
      [],
    );
  });

  it('first-run empty state (no profile, no shots, no consistency snapshot)', async () => {
    results.push(
      ...(await runMatrix(
        base('home.empty.firstRun', 'empty', null, {}, () => {}, {
          mustContain: [
            'Your court is ready.',
            'Your first scored read starts this record.',
          ],
        }),
        CELLS,
      )),
    );
  });

  it('quiet week: history exists but nothing scored in the last 7 days', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'home.quietWeek',
          'empty-week-with-history',
          11,
          { factsDaysAgo: [9, 10, 12] },
          () => {
            const rng = new Rng(11);
            mockRepo.facts = [9, 10, 12].map((d, i) =>
              makeFact(rng, i, {
                shotType: 'dink',
                capturedAt: isoDaysAgo(d),
                overallScore: 6.5,
                resultKind: 'scored',
                scoringModelVersion: '1',
                shotConfigVersion: '1',
              }),
            );
            mockRepo.shots = mockRepo.facts.map((f, i) =>
              makeShot(rng, i, {
                id: f.id,
                shotType: f.shotType,
                capturedAt: f.capturedAt,
                overallScore: f.overallScore,
                resultKind: 'scored',
              }),
            );
            mockConsistencyState.snapshot = snapshotFor(0);
          },
          { mustContain: ['Quiet week so far.'] },
        ),
        CELLS,
      )),
    );
  });

  it('populated device-only state with a training streak', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'home.populated',
          'populated',
          42,
          { shots: 12, facts: 12, streak: 3, profile: 'Alex' },
          () => {
            populate(42, 12, 12);
            mockConsistencyState.snapshot = snapshotFor(3);
            mockAppState.profile = {
              firstName: 'Alex',
              skillLevel: '3.5',
              focusCheckpoint: 'contact_position',
              goal: 'dinks',
              biggestProblem: 'pop-ups',
              handedness: 'right',
            };
          },
          { mustContain: ['THIS WEEK', 'Recent reads'] },
        ),
        CELLS,
      )),
    );
  });

  it('populated + canonical progress (signed-in) and canonical fetch failure (stale fallback)', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'home.canonical.ok',
          'populated+canonical',
          77,
          { canonical: 'ok' },
          () => {
            populate(77, 4, 4);
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
          'home.canonical.reject',
          'populated+canonical-502',
          78,
          { canonical: 'reject' },
          () => {
            populate(78, 4, 4);
            mockSession.current = { canonicalAppUserId: 'user-78' };
            mockCanonical.mode = 'reject';
          },
          { mustNotContain: ['502', 'Bad Gateway'] },
        ),
        CELLS,
      )),
    );
    // Only synced data (no local scored shot): headline falls back to the
    // canonical daily average.
    results.push(
      ...(await runMatrix(
        base(
          'home.canonical.onlySynced',
          'synced-only-headline',
          79,
          { canonical: 'ok', localScored: 0 },
          () => {
            mockSession.current = { canonicalAppUserId: 'user-79' };
            const rng = new Rng(79);
            mockCanonical.value = {
              ...makeCanonicalProgress(rng),
              series: [
                {
                  day: isoDaysAgo(1).slice(0, 10),
                  shotType: ADVERSARIAL_STRINGS.german,
                  scoringModelVersion: '1',
                  shotCount: 3,
                  avgScore: 6.66666,
                  bestScore: 8,
                },
              ],
            };
          },
        ),
        CELLS,
      )),
    );
  });

  it('corrupt / unreadable week-chart preference falls back to scores', async () => {
    for (const stored of ['garbage', '', 'READS', '{"x":1}']) {
      results.push(
        await runScenario(
          base(
            `home.kv.${JSON.stringify(stored)}`,
            'stale-kv',
            5,
            { storedChart: stored },
            () => {
              populate(5, 6, 6);
              mockRepo.storedChart = stored;
            },
          ),
          { cell: CELLS[4]!, verbose: false },
        ),
      );
    }
    results.push(
      await runScenario(
        base(
          'home.kv.reject',
          'stale-kv-reject',
          5,
          { storedChart: 'reject' },
          () => {
            populate(5, 6, 6);
            mockRepo.mode = 'kvReject';
          },
          { mustContain: ['THIS WEEK'] },
        ),
        { cell: CELLS[4]!, verbose: false },
      ),
    );
  });

  it('week chart toggle: tab state flips and the preference is persisted', async () => {
    const r = await runScenario(
      base(
        'home.toggle.reads',
        'populated→reads-tab',
        42,
        { tap: 'home-week-chart-reads' },
        () => {
          populate(42, 12, 12);
          mockConsistencyState.snapshot = snapshotFor(3);
        },
        {
          interact: async renderer => {
            const tab = findByProp(
              renderer,
              p => p.testID === 'home-week-chart-reads',
            )[0];
            if (!tab) throw new Error('reads tab not found');
            await press(tab);
            const after = findByProp(
              renderer,
              p => p.testID === 'home-week-chart-reads',
            )[0];
            const state = after?.props.accessibilityState as
              { selected?: boolean } | undefined;
            if (!state?.selected)
              throw new Error('reads tab not selected after press');
          },
        },
      ),
      { cell: CELLS[4]!, verbose: true },
    );
    results.push(r);
    expect(r.threw).toBeNull();
    expect(mockRepo.setKvCalls).toEqual(['reads']);
    extraNotes.weekChartToggle = {
      setKvCalls: mockRepo.setKvCalls,
      threw: r.threw,
    };
  });

  it('streak badge navigates to the calendar', async () => {
    const r = await runScenario(
      base(
        'home.streakBadge',
        'populated',
        42,
        { tap: 'home-streak-badge' },
        () => {
          populate(42, 3, 3);
          mockConsistencyState.snapshot = snapshotFor(3);
        },
        {
          interact: async renderer => {
            const badge = findByProp(
              renderer,
              p => p.testID === 'home-streak-badge',
            )[0];
            if (!badge) throw new Error('streak badge not found');
            await press(badge);
          },
        },
      ),
      { cell: CELLS[4]!, verbose: false },
    );
    results.push(r);
    expect(mockNavigate).toHaveBeenCalledWith('StreakCalendar');
  });

  it('notification priming card visible + huge streak + no snapshot', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'home.notificationCard',
          'populated+priming-card',
          9,
          { priming: true },
          () => {
            populate(9, 3, 3);
            mockNotificationState.hydrated = true;
            mockConsistencyState.snapshot = snapshotFor(1);
          },
          { mustContain: ['A nudge on practice days?'] },
        ),
        CELLS,
      )),
    );
    results.push(
      ...(await runMatrix(
        base(
          'home.hugeStreak',
          'populated+streak-10000',
          10,
          { streak: 10_000 },
          () => {
            populate(10, 3, 3);
            mockConsistencyState.snapshot = {
              ...(snapshotFor(1) as object),
              currentStreak: 10_000,
            };
          },
        ),
        CELLS,
      )),
    );
  });

  it('adversarial profile strings (firstName / skillLevel / focusCheckpoint)', async () => {
    for (const key of ADVERSARIAL_KEYS) {
      const value = ADVERSARIAL_STRINGS[key];
      results.push(
        ...(await runMatrix(
          base(
            `home.profile.${key}`,
            'populated+adversarial-profile',
            3,
            { firstName: value, skillLevel: value, focusCheckpoint: value },
            () => {
              populate(3, 4, 4);
              mockAppState.profile = {
                firstName: value,
                skillLevel: value,
                focusCheckpoint: value,
                goal: value,
                biggestProblem: value,
                handedness: 'left',
              };
              mockConsistencyState.snapshot = snapshotFor(2);
            },
          ),
          [CELLS[0]!, CELLS[4]!, CELLS[6]!],
        )),
      );
    }
  });

  it('seeded fuzz: 120 seeds × 2 cells with adversarial shot types and scores', async () => {
    const fuzzCells: Cell[] = [
      { fontScale: 1, width: 375, rtl: false },
      { fontScale: 1.35, width: 320, rtl: false },
    ];
    for (let seed = 1000; seed < 1120; seed += 1) {
      const rng = new Rng(seed);
      const shotCount = rng.int(0, 30);
      const factCount = rng.int(0, 30);
      const streak = rng.pick([0, 1, 2, 6, 7, 30, 366]);
      for (const cell of fuzzCells) {
        results.push(
          await runScenario(
            base(
              `home.fuzz.${seed}`,
              'fuzz',
              seed,
              { shotCount, factCount, streak, hasSession: seed % 3 === 0 },
              () => {
                populate(seed, shotCount, factCount);
                mockConsistencyState.snapshot = snapshotFor(streak, seed);
                if (seed % 3 === 0) {
                  mockSession.current = { canonicalAppUserId: `u-${seed}` };
                  mockCanonical.value = makeCanonicalProgress(
                    new Rng(seed + 1),
                  );
                }
                if (seed % 5 === 0) {
                  mockAppState.profile = {
                    firstName: rng.pick(Object.values(ADVERSARIAL_STRINGS)),
                    skillLevel: rng.pick([
                      '2.0',
                      '5.5+',
                      ADVERSARIAL_STRINGS.cjk,
                    ]),
                    focusCheckpoint: rng.pick([
                      'contact_position',
                      ADVERSARIAL_STRINGS.german,
                    ]),
                    goal: 'x',
                    biggestProblem: 'y',
                    handedness: 'right',
                  };
                }
              },
            ),
            { cell, verbose: false },
          ),
        );
      }
    }
    extraNotes.fuzz = {
      seeds: '1000..1119',
      cells: fuzzCells,
      window: getWindow(),
    };
  });
});
