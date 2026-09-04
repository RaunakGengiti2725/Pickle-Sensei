/**
 * StreakCalendarScreen UX / a11y / i18n audit (screen-ux-a11y-i18n-2).
 *
 * States: hydrating (no snapshot, no error) · load error (+retry recovers
 * through a reactive store mock) · empty snapshot · populated with today's
 * log auto-selected · at-risk (trained yesterday only) · shield-bridged run ·
 * long streak (Century Club earned) · month navigation to the earliest month
 * and back · select / deselect a trained day · device locales for the day
 * heading and activity times · adversarial drill labels · seeded fuzz.
 * Every state renders across FONT_SCALES × WIDTHS (+ RTL cells).
 *
 * Run:  cd apps/mobile && npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js streakCalendar
 * Out:  artifacts/screen-ux-a11y-i18n-2/StreakCalendarScreen.{json,summary.json,matrix.tsv}
 */
import React from 'react';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  ADVERSARIAL_KEYS,
  ADVERSARIAL_STRINGS,
  FIXED_NOW,
  Rng,
  isoDaysAgo,
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

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

/** Reactive store mock: `set()` notifies subscribers so retry → refresh →
 * snapshot transitions re-render exactly like the zustand store would. */
type MockStoreState = {
  snapshot: ConsistencySnapshot | null;
  loadError: boolean;
  refresh: jest.Mock<Promise<void>, []>;
};
const mockStore = {
  state: {
    snapshot: null,
    loadError: false,
    refresh: jest.fn(async () => {}),
  } as MockStoreState,
  listeners: new Set<() => void>(),
  set(partial: Partial<MockStoreState>) {
    mockStore.state = { ...mockStore.state, ...partial };
    for (const l of mockStore.listeners) l();
  },
  subscribe(l: () => void) {
    mockStore.listeners.add(l);
    return () => mockStore.listeners.delete(l);
  },
};
jest.mock('../../src/consistency/store', () => {
  const ReactModule = require('react') as typeof import('react');
  return {
    useConsistencyStore: (selector: (s: MockStoreState) => unknown) =>
      ReactModule.useSyncExternalStore(mockStore.subscribe, () =>
        selector(mockStore.state),
      ),
  };
});

import { StreakCalendarScreen } from '../../src/screens/StreakCalendarScreen';

const SCREEN = 'StreakCalendarScreen';
const CONTENT_INSET = 40; // styles.content paddingHorizontal space.lg ×2
const AS_OF = FIXED_NOW.toISOString();

function snapshotOf(activities: TrainingActivityInput[]): ConsistencySnapshot {
  return buildConsistencySnapshot(activities, {
    asOfIso: AS_OF,
    timeZone: 'UTC',
  });
}

function stroke(daysAgo: number, hour = 9, score = 7.2): TrainingActivityInput {
  return {
    kind: 'stroke',
    atIso: isoDaysAgo(daysAgo, hour),
    shotType: 'dink',
    overallScore: score,
    resultKind: 'scored',
  };
}

/** `days` consecutive trained days ending today (daysAgo 0). */
function streakActivities(days: number, seed = 1): TrainingActivityInput[] {
  const rng = new Rng(seed);
  const out: TrainingActivityInput[] = [];
  for (let d = 0; d < days; d += 1) {
    out.push(stroke(d, rng.int(6, 21), rng.pick([4.1, 6.5, 7.2, 9.9])));
    if (rng.bool(0.3)) {
      out.push({
        kind: 'drill',
        atIso: isoDaysAgo(d, rng.int(6, 21)),
        label: rng.pick(['Dink ladder', 'Third shot drop reps', 'Reset drill']),
      });
    }
    if (rng.bool(0.2)) {
      out.push({
        kind: 'session_stroke',
        atIso: isoDaysAgo(d, rng.int(6, 21)),
        shotType: rng.pick(['serve', 'forehand_drive', 'backhand_volley']),
        overallScore: rng.pick([5, 8.3]),
        resultKind: 'scored',
      });
    }
  }
  return out;
}

function reset(): void {
  mockStore.state = {
    snapshot: null,
    loadError: false,
    refresh: jest.fn(async () => {}),
  };
  mockGoBack.mockClear();
  mockNavigate.mockClear();
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
  element: () => <StreakCalendarScreen />,
  contentInset: CONTENT_INSET,
  ...rest,
});

type Renderer = Parameters<NonNullable<ScenarioSpec['interact']>>[0];

function buttonLabelled(renderer: Renderer, label: string) {
  const node = findByProp(
    renderer,
    p => p.accessibilityRole === 'button' && p.accessibilityLabel === label,
  )[0];
  if (!node) throw new Error(`button "${label}" not found`);
  return node;
}

function isDisabled(node: ReturnType<typeof buttonLabelled>): boolean {
  const state = node.props.accessibilityState as
    { disabled?: boolean } | undefined;
  return Boolean(state?.disabled) || Boolean(node.props.disabled);
}

const MONTH_HEADING =
  /^(January|February|March|April|May|June|July|August|September|October|November|December) \d{4}$/;

function monthHeading(renderer: Renderer): string {
  const texts = renderer.root.findAll(n => String(n.type) === 'Text');
  for (const t of texts) {
    const children = t.props.children as unknown;
    const joined = Array.isArray(children)
      ? children.map(c => String(c)).join('')
      : String(children ?? '');
    if (MONTH_HEADING.test(joined)) return joined;
  }
  return '';
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

describe('StreakCalendarScreen audit matrix', () => {
  it('hydrating: no snapshot and no error renders the zero-state page (no loading affordance)', async () => {
    const runs = await runMatrix(
      base(
        'streak.hydrating',
        'hydrating',
        null,
        { snapshot: null, loadError: false },
        () => {},
        {
          mustContain: [
            '0',
            'DAY STREAK',
            'Your first analysis lights the flame.',
            'Calendar',
            'Achievements',
          ],
        },
      ),
      CELLS,
    );
    results.push(...runs);
    const verbose = runs.find(r => r.texts !== undefined)!;
    const texts = verbose.texts ?? [];
    // While the store hydrates the page is indistinguishable from a real
    // zero-streak account (no LoadingState, no live region) and the
    // achievements/century rows are simply absent. Recorded for the report.
    extraNotes.hydratingState = {
      cell: verbose.cell,
      loadingIndicatorPresent: texts.some(t =>
        /loading|keep pickle sensei open/i.test(t.text),
      ),
      achievementsRendered: texts.some(t => /earned\./i.test(t.text)),
      centuryAdvertRendered: texts.some(t => /Century Club/.test(t.text)),
      streakShown: texts.some(t => t.text === '0'),
      refreshCalledOnFocus:
        (mockStore.state.refresh as jest.Mock).mock.calls.length > 0,
    };
  });

  it('load error shows the alert card and retry recovers', async () => {
    const spec = base(
      'streak.error',
      'error',
      null,
      { loadError: true },
      () => {
        mockStore.state.loadError = true;
      },
      {
        mustContain: [
          'Couldn’t load your training history',
          'Your streak is not shown until it can be.',
          'Try again',
        ],
        mustNotContain: ['DAY STREAK'],
      },
    );
    results.push(...(await runMatrix(spec, CELLS)));
    const recovered = await runScenario(
      {
        ...spec,
        id: 'streak.error.retry',
        state: 'error→retry→populated',
        interact: async renderer => {
          const retry = findByProp(
            renderer,
            p => p.accessibilityRole === 'button',
          ).find(
            n => n.findAll(c => c.props.children === 'Try again').length > 0,
          );
          if (!retry) throw new Error('retry button not found');
          mockStore.state.refresh = jest.fn(async () => {
            mockStore.set({
              loadError: false,
              snapshot: snapshotOf(streakActivities(3)),
            });
          });
          mockStore.set({});
          await press(retry);
        },
        mustContain: ['3', 'DAY STREAK', 'Day 3 secured.'],
        mustNotContain: ['Couldn’t load your training history'],
      },
      { cell: CELLS[4]!, verbose: true },
    );
    results.push(recovered);
    expect(recovered.issues.filter(i => i.kind.startsWith('state.'))).toEqual(
      [],
    );
  });

  it('empty snapshot (account with zero activities)', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'streak.empty',
          'empty',
          null,
          { activities: 0 },
          () => {
            mockStore.state.snapshot = snapshotOf([]);
          },
          {
            mustContain: [
              'Your first analysis lights the flame.',
              'LONGEST',
              'SHIELDS',
              'DAYS TRAINED',
              'Century Club',
              'TRAINED',
              'SHIELDED',
              'REST',
            ],
          },
        ),
        CELLS,
      )),
    );
  });

  it('populated: 3-day streak, trained today → today auto-selected with the day detail', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'streak.populated',
          'populated',
          7,
          { streakDays: 3 },
          () => {
            mockStore.state.snapshot = snapshotOf(streakActivities(3, 7));
          },
          {
            mustContain: ['Day 3 secured.', 'March 2026', 'Next reward:', 'XP'],
          },
        ),
        CELLS,
      )),
    );
  });

  it('at risk: trained yesterday, not today', async () => {
    results.push(
      ...(await runMatrix(
        base(
          'streak.atRisk',
          'at-risk',
          null,
          { lastTrainedDaysAgo: 1 },
          () => {
            mockStore.state.snapshot = snapshotOf([
              stroke(1),
              stroke(2),
              stroke(3),
            ]);
          },
          {
            mustContain: [
              'No training yet today — one analysis keeps the flame alive.',
            ],
          },
        ),
        CELLS,
      )),
    );
  });

  it('shield-bridged run: a missed day consumed a shield; the shielded day opens its detail', async () => {
    // Chronological: 9 trained days (banks a shield at day 7), one miss, then
    // 4 trained days ending today → 14-day run with one shielded day.
    const activities = [
      ...Array.from({ length: 9 }, (_, i) => stroke(13 - i)),
      ...Array.from({ length: 4 }, (_, i) => stroke(3 - i)),
    ];
    const snap = snapshotOf(activities);
    extraNotes.shieldFixture = {
      currentStreak: snap.currentStreak,
      shieldedDayCount: snap.shieldedDayCount,
      shieldsAvailable: snap.shieldsAvailable,
    };
    expect(snap.shieldedDayCount).toBe(1);
    const shieldedDay = Object.values(snap.days).find(d => d.shielded)!.day;
    results.push(
      ...(await runMatrix(
        base(
          'streak.shielded',
          'shield-bridged',
          null,
          { shieldedDay },
          () => {
            mockStore.state.snapshot = snap;
          },
          {
            interact: async renderer => {
              const cell = buttonLabelled(
                renderer,
                `${shieldedDay}, shield protected`,
              );
              await press(cell);
            },
            mustContain: ['A Streak Shield protected this day.'],
          },
        ),
        CELLS,
      )),
    );
  });

  it('long streak (400 days): Century Club earned, advert hidden, big counters', async () => {
    const snap = snapshotOf(streakActivities(400, 11));
    extraNotes.longStreak = {
      currentStreak: snap.currentStreak,
      earned: snap.earned.map(e => e.id),
    };
    results.push(
      ...(await runMatrix(
        base(
          'streak.long',
          'populated-long',
          11,
          { streakDays: 400 },
          () => {
            mockStore.state.snapshot = snap;
          },
          {
            mustContain: ['400', 'DAY STREAK'],
            mustNotContain: ['DAYS AWAY'],
          },
        ),
        CELLS,
      )),
    );
  });

  it('month navigation: back to the earliest month disables Previous; forward to today disables Next', async () => {
    // Activities span 3 calendar months (Jan 5 → Mar 10 2026).
    const activities = [stroke(64), stroke(40), stroke(0)];
    const snap = snapshotOf(activities);
    const observed: Record<string, unknown> = {};
    results.push(
      await runScenario(
        base(
          'streak.monthNav.earliest',
          'month-nav-earliest',
          null,
          { months: 3 },
          () => {
            mockStore.state.snapshot = snap;
          },
          {
            interact: async renderer => {
              observed.start = monthHeading(renderer);
              observed.nextDisabledAtStart = isDisabled(
                buttonLabelled(renderer, 'Next month'),
              );
              const headings: string[] = [];
              for (let i = 0; i < 6; i += 1) {
                const prev = buttonLabelled(renderer, 'Previous month');
                if (isDisabled(prev)) break;
                await press(prev);
                headings.push(monthHeading(renderer));
              }
              observed.headings = headings;
              observed.prevDisabledAtEnd = isDisabled(
                buttonLabelled(renderer, 'Previous month'),
              );
              observed.nextEnabledAtEnd = !isDisabled(
                buttonLabelled(renderer, 'Next month'),
              );
            },
            mustContain: ['January 2026'],
            mustNotContain: ['March 2026'],
          },
        ),
        { cell: CELLS[4]!, verbose: true },
      ),
    );
    expect(observed.start).toBe('March 2026');
    expect(observed.nextDisabledAtStart).toBe(true);
    expect(observed.headings).toEqual(['February 2026', 'January 2026']);
    expect(observed.prevDisabledAtEnd).toBe(true);
    expect(observed.nextEnabledAtEnd).toBe(true);
    extraNotes.monthNavigation = observed;

    // December → January year boundary while navigating back.
    const yearSnap = snapshotOf([stroke(120), stroke(0)]);
    results.push(
      await runScenario(
        base(
          'streak.monthNav.yearBoundary',
          'month-nav-year-boundary',
          null,
          { months: 5 },
          () => {
            mockStore.state.snapshot = yearSnap;
          },
          {
            interact: async renderer => {
              for (let i = 0; i < 4; i += 1) {
                await press(buttonLabelled(renderer, 'Previous month'));
              }
            },
            mustContain: ['November 2025'],
          },
        ),
        { cell: CELLS[1]!, verbose: false },
      ),
    );
  });

  it('day selection: tap a trained day opens its detail; tapping again deselects', async () => {
    const snap = snapshotOf(streakActivities(5, 3));
    const twoDaysAgo = isoDaysAgo(2).slice(0, 10);
    const log = snap.days[twoDaysAgo]!;
    const label = `${twoDaysAgo}, trained, ${log.activities.length} ${
      log.activities.length === 1 ? 'activity' : 'activities'
    }`;
    results.push(
      ...(await runMatrix(
        base(
          'streak.select',
          'day-selected',
          3,
          { day: twoDaysAgo },
          () => {
            mockStore.state.snapshot = snap;
          },
          {
            interact: async renderer => {
              await press(buttonLabelled(renderer, label));
            },
            mustContain: ['ACTIVIT', 'XP'],
          },
        ),
        CELLS,
      )),
    );
    const deselected = await runScenario(
      base(
        'streak.deselect',
        'day-deselected',
        3,
        { day: twoDaysAgo },
        () => {
          mockStore.state.snapshot = snap;
        },
        {
          interact: async renderer => {
            // Today is auto-selected; deselect it, then select+deselect another.
            await press(buttonLabelled(renderer, label));
            await press(buttonLabelled(renderer, label));
          },
          mustNotContain: ['ACTIVIT'],
        },
      ),
      { cell: CELLS[4]!, verbose: true },
    );
    results.push(deselected);
    expect(deselected.issues.filter(i => i.kind.startsWith('state.'))).toEqual(
      [],
    );

    // Rest days and future days must not be actionable.
    const disabledCheck = await runScenario(
      base(
        'streak.disabledDays',
        'rest-and-future-days',
        3,
        {},
        () => {
          mockStore.state.snapshot = snap;
        },
        {
          interact: async renderer => {
            const buttons = findByProp(
              renderer,
              p => p.accessibilityRole === 'button',
            );
            const rest = buttons.filter(b =>
              String(b.props.accessibilityLabel).endsWith(', not trained'),
            );
            const future = buttons.filter(b =>
              /^\d{4}-\d{2}-\d{2}$/.test(String(b.props.accessibilityLabel)),
            );
            extraNotes.disabledDays = {
              restDays: rest.length,
              restDaysDisabled: rest.filter(isDisabled).length,
              futureDays: future.length,
              futureDaysDisabled: future.filter(isDisabled).length,
              futureDayLabelSample: future[0]?.props.accessibilityLabel ?? null,
            };
          },
        },
      ),
      { cell: CELLS[4]!, verbose: false },
    );
    results.push(disabledCheck);
  });

  it('device locales: the selected-day heading and activity times follow the device locale', async () => {
    const snap = snapshotOf(streakActivities(2, 5));
    const localeSamples: Record<string, string[]> = {};
    for (const locale of [
      'en-US',
      'en-GB',
      'de-DE',
      'fr-FR',
      'ja-JP',
      'ar-EG',
      'hi-IN',
      'th-TH-u-nu-thai',
    ]) {
      const run = await runScenario(
        base(
          `streak.locale.${locale}`,
          `locale:${locale}`,
          5,
          { locale },
          () => {
            mockStore.state.snapshot = snap;
          },
          { locale, mustContain: ['Day 2 secured.'] },
        ),
        { cell: locale === 'ar-EG' ? CELLS[9]! : CELLS[4]!, verbose: true },
      );
      results.push(run);
      localeSamples[locale] = (run.texts ?? [])
        .map(t => t.text)
        .filter(t =>
          /2026|10|March|März|mars|3月|مارس|मार्च|มีนาคม|AM|PM|:\d\d/.test(t),
        )
        .slice(0, 6);
    }
    extraNotes.localeSamples = localeSamples;
  });

  it('adversarial drill labels in the day detail (every corpus string)', async () => {
    for (const key of ADVERSARIAL_KEYS) {
      const value = ADVERSARIAL_STRINGS[key];
      const snap = snapshotOf([
        stroke(0, 8),
        { kind: 'drill', atIso: isoDaysAgo(0, 12), label: value },
        { kind: 'drill', atIso: isoDaysAgo(0, 13), label: '' },
      ]);
      results.push(
        ...(await runMatrix(
          base(
            `streak.drill.${key}`,
            `adversarial-drill:${key}`,
            null,
            { key, value },
            () => {
              mockStore.state.snapshot = snap;
            },
            { mustContain: ['3 ACTIVITIES'] },
          ),
          [CELLS[1]!, CELLS[4]!, CELLS[6]!, CELLS[9]!],
        )),
      );
    }
  });

  it('seeded fuzz: 100 seeds × 2 cells, random spans and gaps, random trained day selected', async () => {
    const fuzzCells: Cell[] = [CELLS[1]!, CELLS[3]!];
    for (let seed = 3000; seed < 3100; seed += 1) {
      const rng = new Rng(seed);
      const span = rng.int(0, 200);
      const activities: TrainingActivityInput[] = [];
      for (let d = 0; d <= span; d += 1) {
        if (!rng.bool(0.7)) continue;
        const n = rng.int(1, 3);
        for (let k = 0; k < n; k += 1) {
          const kind = rng.pick(['stroke', 'drill', 'session_stroke'] as const);
          activities.push(
            kind === 'drill'
              ? {
                  kind,
                  atIso: isoDaysAgo(d, rng.int(0, 23)),
                  label: rng.pick(Object.values(ADVERSARIAL_STRINGS)),
                }
              : {
                  kind,
                  atIso: isoDaysAgo(d, rng.int(0, 23)),
                  shotType: rng.pick(['dink', 'serve', 'x-unknown', '']),
                  overallScore: rng.bool(0.8)
                    ? rng.pick([0, 3.33333, 10])
                    : null,
                  resultKind: rng.pick([
                    'scored',
                    'low_confidence',
                    'no_person',
                  ]),
                },
          );
        }
      }
      const snap = snapshotOf(activities);
      const trainedDays = Object.values(snap.days).filter(d => !d.shielded);
      const target = trainedDays.length > 0 ? rng.pick(trainedDays) : null;
      for (const cell of fuzzCells) {
        results.push(
          await runScenario(
            base(
              `streak.fuzz.${seed}`,
              'fuzz',
              seed,
              {
                activities: activities.length,
                span,
                trainedDays: trainedDays.length,
                streak: snap.currentStreak,
                selected: target?.day ?? null,
              },
              () => {
                mockStore.state.snapshot = snap;
              },
              {
                interact: target
                  ? async renderer => {
                      // Navigate to the target's month first, then tap it.
                      const targetMonth = target.day.slice(0, 7);
                      for (let i = 0; i < 12; i += 1) {
                        const heading = monthHeading(renderer);
                        const asOfMonth = isoDaysAgo(0).slice(0, 7);
                        if (heading === '' || targetMonth === asOfMonth) break;
                        const prev = buttonLabelled(renderer, 'Previous month');
                        const monthButtons = findByProp(
                          renderer,
                          p =>
                            typeof p.accessibilityLabel === 'string' &&
                            (p.accessibilityLabel as string).startsWith(
                              target.day,
                            ),
                        );
                        if (monthButtons.length > 0 || isDisabled(prev)) break;
                        await press(prev);
                      }
                      const dayButton = findByProp(
                        renderer,
                        p =>
                          typeof p.accessibilityLabel === 'string' &&
                          (p.accessibilityLabel as string).startsWith(
                            target.day,
                          ),
                      )[0];
                      if (dayButton) await press(dayButton);
                    }
                  : undefined,
              },
            ),
            { cell, verbose: false },
          ),
        );
      }
    }
  });

  it('header back button calls goBack', async () => {
    reset();
    mockStore.state.snapshot = snapshotOf(streakActivities(1));
    const run = await runScenario(
      base(
        'streak.back',
        'navigation',
        null,
        {},
        () => {
          mockStore.state.snapshot = snapshotOf(streakActivities(1));
        },
        {
          interact: async renderer => {
            const back = findByProp(
              renderer,
              p =>
                p.accessibilityRole === 'button' &&
                /back/i.test(String(p.accessibilityLabel ?? '')),
            )[0];
            if (!back) throw new Error('back button not found');
            await press(back);
          },
        },
      ),
      { cell: CELLS[4]!, verbose: false },
    );
    results.push(run);
    expect(mockGoBack).toHaveBeenCalled();
  });
});
