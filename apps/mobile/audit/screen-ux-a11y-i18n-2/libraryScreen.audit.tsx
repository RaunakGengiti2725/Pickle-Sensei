/**
 * LibraryScreen UX / a11y / i18n audit (screen-ux-a11y-i18n-2).
 *
 * Reads tab: opening (repository promise never settles) · empty · repository
 * error (both reads swallowed → what does the user see?) · populated with
 * scored / low-confidence / null-score rows · pending clips of every evidence
 * status (incl. >3 clips, the visible cap) · adversarial shot types and
 * declared strokes · device locales for the month/date/time strings.
 * Saved tab (reactive training-store mock): idle → loading · unconfigured
 * (signed-in and local-only → "Connect account") · error + retry recovers ·
 * empty · all entries held (details missing) · ready with media / without
 * media / mixed held · current plan card (0 %, partial, 100 %, 0 items) ·
 * mutation error banner + dismiss · server error messages passed verbatim ·
 * adversarial drill titles/descriptions/coach names · seeded fuzz over both
 * tabs. Every state renders across FONT_SCALES × WIDTHS (+ RTL cells).
 *
 * Run:  cd apps/mobile && npx jest --ci -c audit/screen-ux-a11y-i18n-2/jest.config.js libraryScreen
 * Out:  artifacts/screen-ux-a11y-i18n-2/LibraryScreen.{json,summary.json,matrix.tsv}
 */
import React from 'react';
import type { LocalShotRow, PendingCapture } from '../../src/data/repository';
import type {
  DrillDetail,
  InstructionalMedia,
  SavedDrill,
  TrainingErrorState,
  TrainingLoadStatus,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';
import {
  ADVERSARIAL_KEYS,
  ADVERSARIAL_STRINGS,
  FIXED_NOW,
  Rng,
  isoDaysAgo,
  makePendingCapture,
  makeShot,
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

const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useFocusEffect: (callback: () => void | (() => void)) => {
    const ReactModule = require('react') as typeof import('react');
    ReactModule.useEffect(() => callback(), [callback]);
  },
}));

jest.mock('../../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));

/** Repository behaviour per scenario. */
const mockRepo = {
  shots: [] as LocalShotRow[],
  captures: [] as PendingCapture[],
  mode: 'resolve' as 'resolve' | 'reject' | 'hang',
};
jest.mock('../../src/data/repository', () => ({
  listShots: jest.fn(() => {
    if (mockRepo.mode === 'hang') return new Promise(() => {});
    if (mockRepo.mode === 'reject')
      return Promise.reject(new Error('SQLITE_IOERR: disk I/O error'));
    return Promise.resolve(mockRepo.shots);
  }),
  listPendingCaptures: jest.fn(() => {
    if (mockRepo.mode === 'hang') return new Promise(() => {});
    if (mockRepo.mode === 'reject')
      return Promise.reject(new Error('SQLITE_IOERR: disk I/O error'));
    return Promise.resolve(mockRepo.captures);
  }),
}));

const mockAuth = { localOnly: false };
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (
    selector: (state: { session: { localOnly: boolean } | null }) => unknown,
  ) => selector({ session: { localOnly: mockAuth.localOnly } }),
}));

const mockNotices: Array<Record<string, unknown>> = [];
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (notice: Record<string, unknown>) => {
    mockNotices.push(notice);
  },
  BrandNoticeHost: () => null,
}));

const mockLinking = { canOpen: true, opened: [] as string[] };
jest.mock('react-native/Libraries/Linking/Linking', () => ({
  __esModule: true,
  default: {
    canOpenURL: jest.fn(async () => mockLinking.canOpen),
    openURL: jest.fn(async (url: string) => {
      mockLinking.opened.push(url);
    }),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    getInitialURL: jest.fn(async () => null),
  },
}));

interface TrainingMockState {
  savedStatus: TrainingLoadStatus;
  planStatus: TrainingLoadStatus;
  mutation: string;
  savedDrills: SavedDrill[];
  drillDetails: Record<string, DrillDetail>;
  currentPlan: TrainingPlan | null;
  savedError: TrainingErrorState | null;
  mutationError: TrainingErrorState | null;
  loadSavedDrills: jest.Mock;
  loadCurrentPlan: jest.Mock;
  setDrillSaved: jest.Mock;
  clearMutationError: jest.Mock;
}

/** Reactive zustand-shaped mock so retry/dismiss transitions re-render. */
const mockTraining = {
  state: null as unknown as TrainingMockState,
  listeners: new Set<() => void>(),
  set(partial: Partial<TrainingMockState>) {
    mockTraining.state = { ...mockTraining.state, ...partial };
    for (const l of mockTraining.listeners) l();
  },
  subscribe(l: () => void) {
    mockTraining.listeners.add(l);
    return () => mockTraining.listeners.delete(l);
  },
  /** Called by every scenario's arrange(); hooks are stable per scenario. */
  reset(partial: Partial<TrainingMockState> = {}) {
    mockTraining.state = {
      savedStatus: 'idle',
      planStatus: 'idle',
      mutation: 'idle',
      savedDrills: [],
      drillDetails: {},
      currentPlan: null,
      savedError: null,
      mutationError: null,
      loadSavedDrills: jest.fn(async () => true),
      loadCurrentPlan: jest.fn(async () => true),
      setDrillSaved: jest.fn(async () => true),
      clearMutationError: jest.fn(() => {
        mockTraining.set({ mutationError: null });
      }),
      ...partial,
    };
  },
};
jest.mock('../../src/training/store', () => {
  const ReactModule = require('react') as typeof import('react');
  return {
    useTrainingStore: (selector: (s: TrainingMockState) => unknown) =>
      ReactModule.useSyncExternalStore(mockTraining.subscribe, () =>
        selector(mockTraining.state),
      ),
  };
});

import { LibraryScreen } from '../../src/screens/LibraryScreen';

const SCREEN = 'LibraryScreen';
const CONTENT_INSET = 40; // readsContent / savedContent paddingHorizontal space.lg ×2

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function drill(slug: string, over: Partial<SavedDrill> = {}): SavedDrill {
  return {
    id: `d-${slug}`,
    slug,
    title: slug
      .split('-')
      .map(w => w[0]!.toUpperCase() + w.slice(1))
      .join(' '),
    description:
      'Land four consecutive cross-court dinks per kitchen zone, then move up a zone.',
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    savedAt: isoDaysAgo(3),
    ...over,
  };
}

function embed(id: string): InstructionalMedia {
  return {
    kind: 'embed',
    id: `m-${id}`,
    provider: 'youtube',
    videoId: id,
    embedUrl: `https://www.youtube.com/embed/${id}`,
    sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    creatorName: 'Reviewed Coach',
    licenseName: 'YouTube Standard License',
    licenseUrl: 'https://www.youtube.com/t/terms',
    attribution: 'Video by Reviewed Coach on YouTube',
  };
}

function detailOf(d: SavedDrill, over: Partial<DrillDetail> = {}): DrillDetail {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    description: d.description,
    coachName: d.coachName,
    equipment: d.equipment,
    difficultyMin: d.difficultyMin,
    difficultyMax: d.difficultyMax,
    saved: true,
    mappings: [],
    instructionalMedia: [],
    ...over,
  };
}

function planItem(
  id: string,
  done: boolean,
  kind: TrainingPlanItem['kind'] = 'targeted',
): TrainingPlanItem {
  return {
    id,
    position: 1,
    kind,
    drill:
      kind === 'reassessment'
        ? null
        : {
            slug: `drill-${id}`,
            title: `Drill ${id}`,
            description: 'desc',
            coachName: 'Coach',
            equipment: [],
            saved: false,
          },
    cueText: null,
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: 30,
    completion: done
      ? {
          id: `c-${id}`,
          completedAt: isoDaysAgo(1),
          actualRepetitions: 10,
          actualDurationSeconds: null,
          qualifiesForStreak: true,
        }
      : null,
  };
}

function plan(
  doneCount: number,
  total: number,
  over: Partial<TrainingPlan> = {},
): TrainingPlan {
  const items: TrainingPlanItem[] = [];
  for (let i = 0; i < total; i += 1)
    items.push(planItem(`p${i}`, i < doneCount));
  items.push(planItem('re', false, 'reassessment'));
  return {
    id: 'plan-1',
    status: 'active',
    algorithmVersion: 'v3',
    sourceShotId: 'shot-src',
    shotType: 'third_shot_drop',
    priorityCheckpoint: 'paddle_set',
    priorityDirection: 'too_late',
    baselineScore: 6.1,
    baselineCheckpointScore: 4.0,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: isoDaysAgo(5),
    completedAt: null,
    items,
    ...over,
  };
}

const SERVER_MESSAGES: Record<string, string> = {
  // Verbatim api/index.ts bodies that reach the UI through savedError.message
  // (training/api.ts passes error.message straight through for non-ok
  // responses).
  validation: 'Body must be { shots: [1..200 entries] }.',
  enumHint: 'rating must be accurate|not_quite.',
  unknownEndpoint: 'Unknown endpoint: GET /v1/me/saved-drills.',
  malformedPath: 'Malformed path segment.',
  bearer: 'Bearer token is not a Google or Apple ID token.',
  rateLimit: 'Too many requests. Please slow down and try again shortly.',
};

// ---------------------------------------------------------------------------
// scenario plumbing
// ---------------------------------------------------------------------------

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

function resetAll(): void {
  mockRepo.shots = [];
  mockRepo.captures = [];
  mockRepo.mode = 'resolve';
  mockAuth.localOnly = false;
  mockNotices.length = 0;
  mockLinking.canOpen = true;
  mockLinking.opened.length = 0;
  mockNavigate.mockClear();
  mockTraining.reset();
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
    resetAll();
    arrange();
  },
  element: () => <LibraryScreen />,
  contentInset: CONTENT_INSET,
  ...rest,
});

type Renderer = Parameters<NonNullable<ScenarioSpec['interact']>>[0];

function tabNamed(renderer: Renderer, label: string) {
  const tabs = findByProp(renderer, p => p.accessibilityRole === 'tab');
  const tab = tabs.find(
    t => t.findAll(c => c.props.children === label).length > 0,
  );
  if (!tab) throw new Error(`tab "${label}" not found`);
  return tab;
}

async function openSaved(renderer: Renderer): Promise<void> {
  await press(tabNamed(renderer, 'Saved drills'));
}

function buttonLabelled(renderer: Renderer, label: string) {
  const node = findByProp(
    renderer,
    p => p.accessibilityRole === 'button' && p.accessibilityLabel === label,
  )[0];
  if (!node) throw new Error(`button "${label}" not found`);
  return node;
}

function buttonWithText(renderer: Renderer, text: string) {
  const node = findByProp(renderer, p => p.accessibilityRole === 'button').find(
    n => n.findAll(c => c.props.children === text).length > 0,
  );
  if (!node) throw new Error(`button with text "${text}" not found`);
  return node;
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAll(n => String(n.type) === 'Text')
    .map(t => {
      const c = t.props.children as unknown;
      return Array.isArray(c)
        ? c.map(x => String(x)).join('')
        : String(c ?? '');
    })
    .join(' \u241E ');
}

/** Saved-tab spec that also opens the tab before auditing. */
const savedBase = (
  id: string,
  state: string,
  seed: number | null,
  inputs: Record<string, unknown>,
  arrange: () => void,
  rest: Partial<ScenarioSpec> = {},
): ScenarioSpec =>
  base(id, state, seed, inputs, arrange, {
    interact: async renderer => {
      await openSaved(renderer);
      if (rest.interact) await rest.interact(renderer);
    },
    ...Object.fromEntries(
      Object.entries(rest).filter(([k]) => k !== 'interact'),
    ),
  });

const ONE_CELL: Cell[] = [{ fontScale: 1, width: 375, rtl: false }];
const TWO_CELLS: Cell[] = [
  { fontScale: 1, width: 375, rtl: false },
  { fontScale: 3.12, width: 320, rtl: false },
];

// ---------------------------------------------------------------------------
// Reads tab
// ---------------------------------------------------------------------------

describe('LibraryScreen audit matrix — Reads tab', () => {
  it('opening: repository never settles → LoadingState, no list, tabs still present', async () => {
    const runs = await runMatrix(
      base(
        'library.reads.opening',
        'reads.loading',
        null,
        { repo: 'hang' },
        () => {
          mockRepo.mode = 'hang';
        },
        {
          mustContain: ['Opening your library…'],
          mustNotContain: ['Library', 'Reads', 'Saved drills'],
        },
      ),
      CELLS,
    );
    results.push(...runs);
    // The whole header (title + tablist) is inside the FlatList header, so
    // while the repository is loading the user sees ONLY the spinner copy.
    const verbose = runs.find(r => r.texts !== undefined)!;
    extraNotes.readsLoading = {
      texts: (verbose.texts ?? []).map(t => t.text),
      controls: verbose.controlCount,
    };
    expect(verbose.controlCount).toBe(0);
  });

  it('empty: no reads and no pending clips → EmptyState with primary action → Analyze', async () => {
    const runs = await runMatrix(
      base(
        'library.reads.empty',
        'reads.empty',
        null,
        { shots: 0, captures: 0 },
        () => {},
        {
          mustContain: [
            'Library',
            'Your measured reads, in one place.',
            'Analyze your first stroke',
          ],
          mustNotContain: ['analyzed', 'pending'],
          interact: async renderer => {
            await press(buttonWithText(renderer, 'Analyze your first stroke'));
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
    expect(mockNavigate).toHaveBeenLastCalledWith('Analyze');
  });

  it('repository error: both reads reject → what the user sees', async () => {
    const runs = await runMatrix(
      base(
        'library.reads.repoError',
        'reads.error',
        null,
        { repo: 'reject' },
        () => {
          mockRepo.mode = 'reject';
          mockRepo.shots = [makeShot(new Rng(1), 0)];
        },
        {
          mustContain: ['Library'],
        },
      ),
      CELLS,
    );
    results.push(...runs);
    const verbose = runs.find(r => r.texts !== undefined)!;
    const texts = (verbose.texts ?? []).map(t => t.text);
    const showsEmptyState = texts.includes(
      'Your measured reads, in one place.',
    );
    const mentionsProblem = texts.some(t =>
      /couldn|could not|unable|try again|error|offline|problem/i.test(t),
    );
    const retryControl = (verbose.controls ?? []).some(c =>
      /try again|retry|reload/i.test(`${c.label ?? ''} ${c.innerText}`),
    );
    extraNotes.readsRepositoryError = {
      showsEmptyState,
      mentionsProblem,
      retryControl,
      texts,
    };
    // Recorded as an audit fact (see findings): the catch() in the focus
    // effect maps a repository failure onto the zero-reads EmptyState.
    expect(showsEmptyState).toBe(true);
    expect(mentionsProblem).toBe(false);
    expect(retryControl).toBe(false);
  });

  it('populated: scored, low-confidence, null-score and unknown-kind rows', async () => {
    const rng = new Rng(4100);
    const shots: LocalShotRow[] = [
      makeShot(rng, 0, {
        shotType: 'third_shot_drop',
        resultKind: 'scored',
        overallScore: 7.95,
        capturedAt: isoDaysAgo(0, 9),
      }),
      makeShot(rng, 1, {
        shotType: 'dink',
        resultKind: 'low_confidence',
        overallScore: null,
        capturedAt: isoDaysAgo(1, 21),
      }),
      makeShot(rng, 2, {
        shotType: 'overhead_smash',
        resultKind: 'scored',
        overallScore: null, // scored kind but no number persisted
        capturedAt: isoDaysAgo(2, 0),
      }),
      makeShot(rng, 3, {
        shotType: 'unrecognized',
        resultKind: 'abstained',
        overallScore: 10,
        capturedAt: isoDaysAgo(40, 12),
      }),
      makeShot(rng, 4, {
        shotType: 'serve',
        resultKind: 'scored',
        overallScore: 10.0001,
        capturedAt: '2025-12-31T23:59:59.000Z',
      }),
    ];
    const runs = await runMatrix(
      base(
        'library.reads.populated',
        'reads.populated',
        4100,
        {
          shots: shots.map(s => ({
            shotType: s.shotType,
            resultKind: s.resultKind,
            overallScore: s.overallScore,
          })),
        },
        () => {
          mockRepo.shots = shots;
        },
        {
          mustContain: [
            '5 analyzed reads',
            '0 pending clips',
            'third shot drop',
            'NOT READ',
            '8.0',
            '10.0',
            'ALL STROKES',
            'NEWEST FIRST',
          ],
          interact: async renderer => {
            await press(
              buttonLabelled(renderer, 'Open third shot drop result'),
            );
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
    expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
      analysisId: shots[0]!.id,
    });
    const verbose = runs.find(r => r.texts !== undefined)!;
    // Row 2 is `scored` with a null score: the score slot renders an empty
    // Text (item.overallScore?.toFixed(1) → undefined). Row 3 has a
    // non-low_confidence kind with a number → shows a score for an
    // abstained read. Both recorded for the report.
    const scoreTexts = (verbose.texts ?? []).filter(
      t => t.path.includes('score') || /^\d+\.\d$/.test(t.text),
    );
    extraNotes.readsScoreSlots = {
      scoreTexts: scoreTexts.map(t => t.text),
      emptyTexts: (verbose.texts ?? []).filter(t => t.text.trim() === '')
        .length,
      labels: (verbose.controls ?? []).map(c => c.label),
    };
  });

  it('pending clips: every evidence status, >3 clips (visible cap), 0 s and 1 h durations', async () => {
    const rng = new Rng(4200);
    const captures: PendingCapture[] = [
      makePendingCapture(rng, 0, {
        evidenceStatus: 'valid',
        declaredStroke: 'third_shot_drop',
        durationMs: 0,
      }),
      makePendingCapture(rng, 1, {
        evidenceStatus: 'legacy',
        declaredStroke: null,
        shotType: 'unrecognized',
      }),
      makePendingCapture(rng, 2, {
        evidenceStatus: 'corrupt',
        declaredStroke: null,
        shotType: 'dink',
        durationMs: 3_600_000,
      }),
      makePendingCapture(rng, 3, {
        evidenceStatus: 'metadata_mismatch',
        declaredStroke: 'serve',
      }),
      makePendingCapture(rng, 4, {
        evidenceStatus: 'valid',
        declaredStroke: 'volley',
      }),
    ];
    const runs = await runMatrix(
      base(
        'library.reads.pending',
        'reads.pendingOnly',
        4200,
        {
          captures: captures.map(c => ({
            evidenceStatus: c.evidenceStatus,
            declaredStroke: c.declaredStroke,
            durationMs: c.durationMs,
          })),
        },
        () => {
          mockRepo.captures = captures;
        },
        {
          mustContain: [
            '0 analyzed reads',
            '5 pending clips',
            'SAVED CLIPS · NOT ANALYZED',
            'NOT SCORED',
            'Third Shot Drop · auto capture',
            'Auto capture',
            'Clip saved — analysis has not run yet',
            'Recorded by an older app version — can’t be scored',
            'Saved evidence could not be verified — can’t be scored',
            'Saved clips aren’t scored from the library. Record a new stroke to get a score.',
            '0s clip',
            '3600s clip',
          ],
          // The 4th and 5th clips are beyond the slice(0, 3) cap: the count
          // says 5 but only 3 rows render and nothing says "and 2 more".
          mustNotContain: [
            'Serve · auto capture',
            'Volley · auto capture',
            'more',
          ],
        },
      ),
      CELLS,
    );
    results.push(...runs);
    const verbose = runs.find(r => r.texts !== undefined)!;
    extraNotes.pendingCap = {
      declared: captures.length,
      rowsRendered: (verbose.texts ?? []).filter(t =>
        /auto capture/i.test(t.text),
      ).length,
      // FlatList is empty (0 reads) yet ListEmptyComponent is shown under
      // the pending group: both the pending clips AND the "Your measured
      // reads, in one place." empty state render together.
      emptyStateAlsoShown: (verbose.texts ?? []).some(
        t => t.text === 'Your measured reads, in one place.',
      ),
    };
  });

  it('device locales: month abbreviation, time and pending-clip date follow the device locale', async () => {
    const rng = new Rng(4300);
    const shots = [
      makeShot(rng, 0, {
        shotType: 'dink',
        resultKind: 'scored',
        overallScore: 6.2,
        capturedAt: '2026-03-09T14:05:00.000Z',
      }),
    ];
    const captures = [
      makePendingCapture(rng, 0, {
        evidenceStatus: 'valid',
        declaredStroke: 'dink',
        capturedAtIso: '2026-03-01T08:00:00.000Z',
      }),
    ];
    const samples: Record<string, string[]> = {};
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
          'library.reads.locale',
          'reads.locale',
          4300,
          { locale },
          () => {
            mockRepo.shots = shots;
            mockRepo.captures = captures;
          },
          { locale, mustContain: ['1 analyzed read', '1 pending clip'] },
        ),
        { cell: ONE_CELL[0]!, verbose: true },
      );
      results.push(run);
      samples[locale] = (run.texts ?? [])
        .map(t => t.text)
        .filter(t => /clip ·|Read 01|^[^a-z]{2,5}$/u.test(t));
    }
    extraNotes.readsLocaleSamples = samples;
  });

  it('adversarial shot types & declared strokes (every corpus string)', async () => {
    for (const key of ADVERSARIAL_KEYS) {
      const value = ADVERSARIAL_STRINGS[key];
      const rng = new Rng(4400);
      const shots = [
        makeShot(rng, 0, {
          shotType: value,
          resultKind: 'scored',
          overallScore: 7.1,
        }),
        makeShot(rng, 1, {
          shotType: value,
          resultKind: 'low_confidence',
          overallScore: null,
        }),
      ];
      const captures = [
        makePendingCapture(rng, 0, {
          evidenceStatus: 'valid',
          declaredStroke: value as PendingCapture['declaredStroke'],
        }),
      ];
      const runs = await runMatrix(
        base(
          `library.reads.adversarial.${key}`,
          'reads.adversarial',
          4400,
          { key, value },
          () => {
            mockRepo.shots = shots;
            mockRepo.captures = captures;
          },
          { mustContain: ['2 analyzed reads', '1 pending clip'] },
        ),
        TWO_CELLS,
      );
      results.push(...runs);
    }
  });
});

// ---------------------------------------------------------------------------
// Saved tab
// ---------------------------------------------------------------------------

describe('LibraryScreen audit matrix — Saved tab', () => {
  it('idle and loading both render the LoadingState; loadSavedDrills/loadCurrentPlan called on focus', async () => {
    for (const status of ['idle', 'loading'] as const) {
      const runs = await runMatrix(
        savedBase(
          `library.saved.${status}`,
          `saved.${status}`,
          null,
          { savedStatus: status },
          () => {
            mockTraining.reset({ savedStatus: status, planStatus: status });
          },
          {
            mustContain: ['Loading saved drills…', 'Explore the Drill Library'],
            mustNotContain: ['No saved drills yet.'],
          },
        ),
        CELLS,
      );
      results.push(...runs);
    }
    expect(mockTraining.state.loadSavedDrills).toHaveBeenCalled();
    expect(mockTraining.state.loadCurrentPlan).toHaveBeenCalled();
  });

  it('unconfigured: signed-in account shows the message; local-only adds "Connect account"', async () => {
    for (const localOnly of [false, true]) {
      const runs = await runMatrix(
        savedBase(
          'library.saved.unconfigured',
          'saved.unconfigured',
          null,
          { localOnly },
          () => {
            mockAuth.localOnly = localOnly;
            mockTraining.reset({
              savedStatus: 'unconfigured',
              planStatus: 'unconfigured',
              savedError: {
                code: 'training.unconfigured',
                message:
                  'Sign in to a synced account before loading training plans.',
                retryable: false,
                status: null,
              },
            });
          },
          {
            mustContain: [
              'Saved training needs a synced account.',
              'Sign in to a synced account before loading training plans.',
              ...(localOnly ? ['Connect account'] : []),
            ],
            mustNotContain: localOnly ? [] : ['Connect account'],
            interact: localOnly
              ? async renderer => {
                  await press(buttonWithText(renderer, 'Connect account'));
                }
              : undefined,
          },
        ),
        CELLS,
      );
      results.push(...runs);
    }
    expect(mockNavigate).toHaveBeenLastCalledWith('ConnectAccount');

    // No savedError at all → the built-in fallback sentence (engineering
    // wording surfaced to the user; recorded for the copy review).
    const runs = await runMatrix(
      savedBase(
        'library.saved.unconfigured.fallback',
        'saved.unconfigured',
        null,
        { savedError: null },
        () => {
          mockTraining.reset({ savedStatus: 'unconfigured', savedError: null });
        },
        {
          mustContain: [
            'The app has no authenticated training API connection in this build.',
          ],
        },
      ),
      ONE_CELL,
    );
    results.push(...runs);
  });

  it('error: "Training is offline." + Try again → loadSavedDrills → ready (reactive)', async () => {
    const d = drill('dink-target-ladder');
    const runs = await runMatrix(
      savedBase(
        'library.saved.error.retry',
        'saved.error→ready',
        null,
        {
          message:
            'Training is temporarily offline. Your existing reads are still safe.',
        },
        () => {
          mockTraining.reset({
            savedStatus: 'error',
            savedError: {
              code: 'training.unavailable',
              message:
                'Training is temporarily offline. Your existing reads are still safe.',
              retryable: true,
              status: 503,
            },
            // Focus already re-issues loadSavedDrills(); the first call keeps
            // failing so the error card is what the user retries from.
            loadSavedDrills: jest.fn(async () => {
              if (mockTraining.state.loadSavedDrills.mock.calls.length === 1) {
                return false;
              }
              mockTraining.set({ savedStatus: 'loading', savedError: null });
              await Promise.resolve();
              mockTraining.set({
                savedStatus: 'ready',
                savedDrills: [d],
                drillDetails: { [d.slug]: detailOf(d) },
              });
              return true;
            }),
          });
        },
        {
          mustContain: [
            'Saved drills',
            '1 saved',
            'Dink Target Ladder',
            'Server catalog · Pickle Sensei Training Library',
          ],
          mustNotContain: ['Training is offline.'],
          interact: async renderer => {
            expect(allText(renderer)).toContain('Training is offline.');
            expect(allText(renderer)).toContain(
              'Training is temporarily offline. Your existing reads are still safe.',
            );
            await press(buttonWithText(renderer, 'Try again'));
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
  });

  it('error: server error bodies reach the card verbatim (developer-facing sentences)', async () => {
    for (const [key, message] of Object.entries(SERVER_MESSAGES)) {
      const runs = await runMatrix(
        savedBase(
          `library.saved.error.server.${key}`,
          'saved.error.serverMessage',
          null,
          { key, message },
          () => {
            mockTraining.reset({
              savedStatus: 'error',
              savedError: {
                code: 'validation.saved_drill',
                message,
                retryable: false,
                status: 400,
              },
            });
          },
          { mustContain: ['Training is offline.', message] },
        ),
        TWO_CELLS,
      );
      results.push(...runs);
    }
  });

  it('empty: ready with zero saved drills', async () => {
    const runs = await runMatrix(
      savedBase(
        'library.saved.empty',
        'saved.empty',
        null,
        {},
        () => {
          mockTraining.reset({ savedStatus: 'ready', planStatus: 'ready' });
        },
        {
          mustContain: ['No saved drills yet.', 'Explore the Drill Library'],
          mustNotContain: ['Loading saved drills…', 'CURRENT PLAN'],
          interact: async renderer => {
            await press(buttonLabelled(renderer, 'Explore the Drill Library'));
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
    expect(mockNavigate).toHaveBeenLastCalledWith('DrillLibrary');
  });

  it('held: every saved entry lacks catalog detail (singular and plural copy) + Try again', async () => {
    for (const count of [1, 3]) {
      const drills = Array.from({ length: count }, (_, i) =>
        drill(`held-${i}`),
      );
      const runs = await runMatrix(
        savedBase(
          `library.saved.held.${count}`,
          'saved.allHeld',
          null,
          { count },
          () => {
            mockTraining.reset({
              savedStatus: 'ready',
              savedDrills: drills,
              drillDetails: {},
            });
          },
          {
            mustContain: [
              'Saved entries couldn’t be verified right now.',
              count === 1
                ? '1 saved entry is hidden'
                : `${count} saved entries are hidden`,
              'Try again',
            ],
            mustNotContain: ['Held 0'],
            interact: async renderer => {
              await press(buttonWithText(renderer, 'Try again'));
            },
          },
        ),
        CELLS,
      );
      results.push(...runs);
      expect(mockTraining.state.loadSavedDrills).toHaveBeenCalled();
    }
  });

  it('ready: drills with media / without media / mixed held; unsave + Watch form', async () => {
    const withMedia = drill('dink-target-ladder');
    const noMedia = drill('reset-volley-wall');
    const held = drill('ghost-entry');
    const runs = await runMatrix(
      savedBase(
        'library.saved.ready.mixed',
        'saved.ready',
        null,
        { drills: 3, held: 1 },
        () => {
          mockTraining.reset({
            savedStatus: 'ready',
            planStatus: 'ready',
            savedDrills: [withMedia, noMedia, held],
            drillDetails: {
              [withMedia.slug]: detailOf(withMedia, {
                instructionalMedia: [embed('dQw4w9WgXcQ')],
                mappings: [
                  {
                    checkpoint: 'paddle_set',
                    shotType: 'dink',
                    planRole: 'targeted',
                    faultDirections: ['too_late'],
                    cueText: 'Set early',
                    targetSets: 3,
                    targetRepetitionsPerSet: 10,
                    targetDurationSeconds: null,
                    restSeconds: 30,
                  },
                ],
              }),
              [noMedia.slug]: detailOf(noMedia),
            },
          });
        },
        {
          mustContain: [
            '2 saved',
            'Dink Target Ladder',
            'Reset Volley Wall',
            'Reviewed prescription · Pickle Sensei Training Library',
            'Server catalog · Pickle Sensei Training Library',
            'Watch form',
            'No rights-cleared coaching video is published for this drill yet.',
            '1 additional saved entry is hidden',
          ],
          mustNotContain: ['Ghost Entry'],
          interact: async renderer => {
            await press(
              buttonLabelled(
                renderer,
                'Watch reviewed instruction for Dink Target Ladder',
              ),
            );
            await press(
              buttonLabelled(
                renderer,
                'Remove Reset Volley Wall from saved drills',
              ),
            );
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
    expect(mockLinking.opened).toContain(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
    expect(mockTraining.state.setDrillSaved).toHaveBeenCalledWith(
      'reset-volley-wall',
      false,
    );

    // Media cannot open → brand notice (not a silent failure).
    const run = await runScenario(
      savedBase(
        'library.saved.ready.mediaUnavailable',
        'saved.ready',
        null,
        { canOpenURL: false },
        () => {
          mockLinking.canOpen = false;
          mockTraining.reset({
            savedStatus: 'ready',
            savedDrills: [withMedia],
            drillDetails: {
              [withMedia.slug]: detailOf(withMedia, {
                instructionalMedia: [embed('x')],
              }),
            },
          });
        },
        {
          interact: async renderer => {
            await press(
              buttonLabelled(
                renderer,
                'Watch reviewed instruction for Dink Target Ladder',
              ),
            );
          },
        },
      ),
      { cell: ONE_CELL[0]!, verbose: true },
    );
    results.push(run);
    expect(mockNotices).toEqual([
      expect.objectContaining({ title: 'Video unavailable', tone: 'danger' }),
    ]);

    // Busy mutation disables the unsave control.
    const busy = await runScenario(
      savedBase(
        'library.saved.ready.busy',
        'saved.ready.busy',
        null,
        { mutation: 'saving:x' },
        () => {
          mockTraining.reset({
            savedStatus: 'ready',
            mutation: 'saving:x',
            savedDrills: [noMedia],
            drillDetails: { [noMedia.slug]: detailOf(noMedia) },
          });
        },
      ),
      { cell: ONE_CELL[0]!, verbose: true },
    );
    results.push(busy);
    const unsave = (busy.controls ?? []).find(
      c => c.label === 'Remove Reset Volley Wall from saved drills',
    );
    expect(unsave?.disabled).toBe(true);
  });

  it('current plan card: 0/3, 2/3, 3/3 and a plan with no drills (0/0) → progress width, DONE pill, navigate', async () => {
    const d = drill('dink-target-ladder');
    for (const [done, total] of [
      [0, 3],
      [2, 3],
      [3, 3],
      [0, 0],
    ] as const) {
      const p = plan(done, total);
      const runs = await runMatrix(
        savedBase(
          `library.saved.plan.${done}of${total}`,
          'saved.plan',
          null,
          { done, total },
          () => {
            mockTraining.reset({
              savedStatus: 'ready',
              planStatus: 'ready',
              currentPlan: p,
              savedDrills: [d],
              drillDetails: { [d.slug]: detailOf(d) },
            });
          },
          {
            mustContain: [
              'CURRENT PLAN',
              `${done}/${total} DONE`,
              'third shot drop',
              'Reviewed work for paddle set · too late',
              'Continue plan',
            ],
            interact: async renderer => {
              await press(
                buttonLabelled(renderer, 'Open your current personalized plan'),
              );
            },
          },
        ),
        total === 3 && done === 2 ? CELLS : TWO_CELLS,
      );
      results.push(...runs);
      expect(mockNavigate).toHaveBeenLastCalledWith('Result', {
        analysisId: 'shot-src',
      });
    }
  });

  it('mutation error banner: label = message, hint = dismiss, tap clears it (reactive)', async () => {
    const d = drill('dink-target-ladder');
    const message = 'Could not update your saved drills. Try again.';
    const runs = await runMatrix(
      savedBase(
        'library.saved.mutationError',
        'saved.mutationError',
        null,
        { message },
        () => {
          mockTraining.reset({
            savedStatus: 'ready',
            savedDrills: [d],
            drillDetails: { [d.slug]: detailOf(d) },
            mutationError: {
              code: 'training.request_failed',
              message,
              retryable: true,
              status: 500,
            },
          });
        },
        {
          mustNotContain: [message],
          interact: async renderer => {
            expect(allText(renderer)).toContain(message);
            expect(allText(renderer)).toContain('DISMISS');
            const banner = buttonLabelled(renderer, message);
            expect(banner.props.accessibilityHint).toBe(
              'Dismisses this message',
            );
            await press(banner);
          },
        },
      ),
      CELLS,
    );
    results.push(...runs);
    expect(mockTraining.state.clearMutationError).toHaveBeenCalled();
  });

  it('adversarial drill title / description / coach name / plan shot type (every corpus string)', async () => {
    for (const key of ADVERSARIAL_KEYS) {
      const value = ADVERSARIAL_STRINGS[key];
      const d = drill('adv', {
        title: value,
        description: value,
        coachName: value,
      });
      const runs = await runMatrix(
        savedBase(
          `library.saved.adversarial.${key}`,
          'saved.adversarial',
          null,
          { key, value },
          () => {
            mockTraining.reset({
              savedStatus: 'ready',
              planStatus: 'ready',
              currentPlan: plan(1, 2, {
                shotType: value,
                priorityCheckpoint: value,
                priorityDirection: value,
              }),
              savedDrills: [d],
              drillDetails: {
                [d.slug]: detailOf(d, { instructionalMedia: [embed('adv')] }),
              },
              mutationError: {
                code: 'x',
                message: value,
                retryable: false,
                status: 400,
              },
            });
          },
          { mustContain: ['1 saved', 'CURRENT PLAN'] },
        ),
        TWO_CELLS,
      );
      results.push(...runs);
    }
  });
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

describe('LibraryScreen seeded fuzz', () => {
  it('100 seeds × 2 cells × both tabs: random reads / clips / saved drills / plan / statuses', async () => {
    for (let seed = 4000; seed < 4100; seed += 1) {
      const rng = new Rng(seed);
      const shotCount = rng.pick([0, 1, 3, 12, 100]);
      const captureCount = rng.pick([0, 1, 3, 4, 25]);
      const shots = Array.from({ length: shotCount }, (_, i) =>
        makeShot(rng, i),
      );
      const captures = Array.from({ length: captureCount }, (_, i) =>
        makePendingCapture(rng, i),
      );
      const savedStatus = rng.pick<TrainingLoadStatus>([
        'idle',
        'loading',
        'ready',
        'ready',
        'ready',
        'unconfigured',
        'error',
      ]);
      const planStatus = rng.pick<TrainingLoadStatus>([
        'idle',
        'ready',
        'ready',
        'error',
      ]);
      const drillCount = rng.pick([0, 1, 2, 6]);
      const drills = Array.from({ length: drillCount }, (_, i) =>
        drill(`fz-${seed}-${i}`, {
          title: rng.bool(0.3)
            ? rng.pick(Object.values(ADVERSARIAL_STRINGS))
            : `Fuzz Drill ${i}`,
          description: rng.bool(0.3)
            ? rng.pick(Object.values(ADVERSARIAL_STRINGS))
            : 'Short description.',
        }),
      );
      const drillDetails: Record<string, DrillDetail> = {};
      for (const d of drills) {
        if (rng.bool(0.75)) {
          drillDetails[d.slug] = detailOf(d, {
            instructionalMedia: rng.bool(0.5) ? [embed(d.slug)] : [],
          });
        }
      }
      const total = rng.int(0, 5);
      const currentPlan =
        planStatus === 'ready' && rng.bool(0.7)
          ? plan(rng.int(0, total), total)
          : null;
      const mutationError = rng.bool(0.2)
        ? {
            code: 'x',
            message: rng.pick(Object.values(SERVER_MESSAGES)),
            retryable: false,
            status: 400,
          }
        : null;
      const savedError =
        savedStatus === 'error' || savedStatus === 'unconfigured'
          ? {
              code: 'x',
              message: rng.pick(Object.values(SERVER_MESSAGES)),
              retryable: true,
              status: 500,
            }
          : null;
      const localOnly = rng.bool(0.3);
      const inputs = {
        shotCount,
        captureCount,
        savedStatus,
        planStatus,
        drillCount,
        detailCount: Object.keys(drillDetails).length,
        plan: currentPlan
          ? {
              total,
              done: currentPlan.items.filter(i => i.drill && i.completion)
                .length,
            }
          : null,
        mutationError: mutationError?.message ?? null,
        savedError: savedError?.message ?? null,
        localOnly,
      };
      const arrange = () => {
        mockRepo.shots = shots;
        mockRepo.captures = captures;
        mockAuth.localOnly = localOnly;
        mockTraining.reset({
          savedStatus,
          planStatus,
          savedDrills: drills,
          drillDetails,
          currentPlan,
          mutationError,
          savedError,
        });
      };
      const readsRuns = await runMatrix(
        base(
          `library.fuzz.reads.${seed}`,
          'fuzz.reads',
          seed,
          inputs,
          arrange,
          {
            mustContain:
              shotCount + captureCount === 0
                ? ['Your measured reads, in one place.']
                : [
                    `${shotCount} analyzed ${shotCount === 1 ? 'read' : 'reads'}`,
                  ],
          },
        ),
        TWO_CELLS,
      );
      results.push(...readsRuns);
      const savedRuns = await runMatrix(
        savedBase(
          `library.fuzz.saved.${seed}`,
          'fuzz.saved',
          seed,
          inputs,
          arrange,
          {
            mustContain: ['Explore the Drill Library'],
          },
        ),
        TWO_CELLS,
      );
      results.push(...savedRuns);
    }
  });
});
