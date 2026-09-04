/**
 * Render-cost harness — LibraryScreen.
 *
 * Real LibraryScreen + real Zustand training store (configured with a
 * deterministic fake TrainingApi), real authStore; SQLite repository,
 * navigation and natives mocked. Scale: SEED=20260903, 100 shots + 100
 * pending captures (LibraryScreen's own `listShots(db, 100)` limit), 100
 * saved drills with server detail (all render as SavedDrillCard). Steps:
 * mount, 20 training-store `mutation` writes on Reads, 20 unselected-slice
 * writes, 10 Reads<->Saved tab round trips, 20 `mutation` writes on Saved,
 * 10 refocus loads. Also records how many Reads rows the FlatList mounted
 * versus how many Saved cards the ScrollView mounted (virtualization).
 * Replay: `cd apps/mobile && npx jest __tests__/perf/libraryRender`.
 * Raw table: artifacts/perf-mobile-render/library.json.
 */
import {
  commitCount,
  measureStep,
  rendererInjected,
  resetCommits,
  summarize,
  type StepResult,
} from '../../perf/renderCounter';

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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest
      .requireActual<typeof import('../../perf/focus')>('../../perf/focus')
      .useFocusEffectMock(callback),
}));
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: jest.fn(),
}));
const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListPendingCaptures = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listPendingCaptures: (...args: unknown[]) => mockListPendingCaptures(...args),
}));

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { LibraryScreen } from '../../src/screens/LibraryScreen';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
  type TrainingMutation,
} from '../../src/training/store';
import type { TrainingApi, TrainingErrorState } from '../../src/training/types';
import { refocus } from '../../perf/focus';
import {
  FIXED_NOW_ISO,
  countByLabel,
  makePendingCaptures,
  makeSavedDrills,
  makeShots,
  renderedText,
  writeArtifact,
} from '../../perf/fixtures';

const SEED = 20260903;
const SHOT_COUNT = 100;
const SAVED_COUNT = 100;
const STEPS = 20;
const TAB_ROUND_TRIPS = 10;
const REFOCUS_STEPS = 10;
const RUNAWAY_THRESHOLD = 3;
/** One focus load is five distinct store writes landing in separate
 * microtasks: setShots+setCaptures (batched), loadSavedDrills 'loading' and
 * 'ready', loadCurrentPlan 'loading' and 'ready'. */
const FOCUS_LOAD_STORE_WRITES = 5;

const shots = makeShots(SEED, SHOT_COUNT);
const pending = makePendingCaptures(SEED, SHOT_COUNT);
const saved = makeSavedDrills(SEED, SAVED_COUNT);

const api: TrainingApi = {
  listSavedDrills: async () => saved.drills,
  getDrill: async slug => {
    const detail = saved.details[slug];
    if (!detail) throw new Error(`no detail for ${slug}`);
    return detail;
  },
  saveDrill: async () => {},
  unsaveDrill: async () => {},
  getCurrentPlan: async () => null,
  createPlan: async () => {
    throw new Error('not in harness');
  },
  completeDrill: async () => {
    throw new Error('not in harness');
  },
  reassessPlan: async () => {
    throw new Error('not in harness');
  },
};

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

const isReadRow = (label: string) => /^Open .* result$/.test(label);
const isSavedCard = (label: string) => /^Remove .* from saved/i.test(label);

describe('perf: LibraryScreen render cost per store update', () => {
  const steps: StepResult[] = [];
  const listFacts: Record<string, unknown> = {};
  let renderer: TestRenderer.ReactTestRenderer;

  beforeAll(() => {
    expect(rendererInjected()).toBe(true);
    mockListShots.mockImplementation(async () => shots);
    mockListPendingCaptures.mockImplementation(async () => pending);
    configureTrainingStore(api);
    resetCommits();
  });

  afterAll(() => {
    const summary = summarize('LibraryScreen', steps, RUNAWAY_THRESHOLD);
    const file = writeArtifact('library.json', {
      screen: 'LibraryScreen',
      seed: SEED,
      shotCount: shots.length,
      pendingCaptureCount: pending.length,
      savedDrillCount: saved.drills.length,
      fixedNowIso: FIXED_NOW_ISO,
      runawayThreshold: RUNAWAY_THRESHOLD,
      commitsObserved: commitCount(),
      lists: listFacts,
      summary,
      steps,
    });
    console.log(`[perf] LibraryScreen table -> ${file}`);
    act(() => {
      renderer.unmount();
    });
    clearTrainingStoreConfiguration();
  });

  function worstScreen(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.maxPerInstance['LibraryScreen'] ?? 0));
  }

  function worstAny(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.max?.renders ?? 0));
  }

  function tab(label: 'Reads' | 'Saved drills') {
    return renderer.root.findAll(
      node =>
        node.props['accessibilityRole'] === 'tab' &&
        typeof node.props['onPress'] === 'function' &&
        node.findAll(child => child.props['children'] === label).length > 0,
    )[0];
  }

  async function pressTab(label: 'Reads' | 'Saved drills') {
    const node = tab(label);
    expect(node).toBeDefined();
    await act(async () => {
      (node!.props['onPress'] as () => void)();
    });
    await settle();
  }

  it('mounts, loads 100 reads, and the FlatList mounts only a window of rows', async () => {
    const step = await measureStep(
      'mount+focus-load',
      { seed: SEED, shots: shots.length, pending: pending.length },
      async () => {
        await act(async () => {
          renderer = TestRenderer.create(<LibraryScreen />);
        });
        await settle();
      },
    );
    steps.push(step);
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
    const mountedRows = countByLabel(renderer.toJSON(), isReadRow);
    listFacts['readsFlatList'] = {
      dataLength: shots.length,
      mountedRows,
      virtualized: mountedRows < shots.length,
    };
    expect(mountedRows).toBeGreaterThan(0);
    expect(mountedRows).toBeLessThan(shots.length);
    // mount = 1 initial render + the FOCUS_LOAD_STORE_WRITES below
    expect(step.maxPerInstance['LibraryScreen']).toBeLessThanOrEqual(
      1 + FOCUS_LOAD_STORE_WRITES,
    );
  });

  it('training.mutation writes on Reads render bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const mutation: TrainingMutation =
        i % 2 === 1 ? `saving:${saved.drills[i % SAVED_COUNT]!.slug}` : 'idle';
      local.push(
        await measureStep(`training.mutation.reads#${i}`, { mutation }, () => {
          act(() => {
            useTrainingStore.setState({ mutation });
          });
        }),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('does not render for training slices Library never selects', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const planError: TrainingErrorState | null =
        i % 2 === 1
          ? { code: 'network', message: `e${i}`, retryable: true, status: null }
          : null;
      local.push(
        await measureStep(
          `training.unselected.planError#${i}`,
          { planError },
          () => {
            act(() => {
              useTrainingStore.setState({ planError });
            });
          },
        ),
      );
    }
    steps.push(...local);
    expect(Math.max(...local.map(s => s.totalRenders))).toBe(0);
  });

  it('Reads <-> Saved drills tab switch renders bounded and mounts every saved card', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= TAB_ROUND_TRIPS; i += 1) {
      local.push(
        await measureStep(`tab.saved#${i}`, { tab: 'saved' }, () =>
          pressTab('Saved drills'),
        ),
      );
      if (i === 1) {
        const mountedCards = countByLabel(renderer.toJSON(), isSavedCard);
        listFacts['savedScrollView'] = {
          dataLength: saved.drills.length,
          mountedCards,
          virtualized: mountedCards < saved.drills.length,
        };
        expect(renderedText(renderer.toJSON())).toMatch(
          new RegExp(`${saved.drills.length}\\s+saved`),
        );
      }
      local.push(
        await measureStep(`tab.reads#${i}`, { tab: 'reads' }, () =>
          pressTab('Reads'),
        ),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('training.mutation writes on Saved drills render bounded', async () => {
    await pressTab('Saved drills');
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      // a real saved slug: the matching SavedDrillCard flips its busy state
      const mutation: TrainingMutation =
        i % 2 === 1 ? `saving:${saved.drills[i % SAVED_COUNT]!.slug}` : 'idle';
      local.push(
        await measureStep(`training.mutation.saved#${i}`, { mutation }, () => {
          act(() => {
            useTrainingStore.setState({ mutation });
          });
        }),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    await pressTab('Reads');
  });

  it('refocus load (return to tab) renders bounded per store write', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= REFOCUS_STEPS; i += 1) {
      local.push(
        await measureStep(
          `refocus.load#${i}`,
          {
            shots: shots.length,
            pending: pending.length,
            saved: saved.drills.length,
          },
          async () => {
            await act(async () => {
              refocus();
            });
            await settle();
          },
        ),
      );
    }
    steps.push(...local);
    listFacts['refocusStoreWrites'] = FOCUS_LOAD_STORE_WRITES;
    expect(worstScreen(local)).toBeLessThanOrEqual(FOCUS_LOAD_STORE_WRITES);
    expect(worstAny(local)).toBeLessThanOrEqual(FOCUS_LOAD_STORE_WRITES);
  });
});
