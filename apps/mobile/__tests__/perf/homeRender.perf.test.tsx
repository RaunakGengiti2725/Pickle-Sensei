/**
 * Render-cost harness — HomeScreen.
 *
 * Renders the REAL HomeScreen against the REAL Zustand stores (appStore,
 * consistency, notification, rank celebration, walkthrough) with only the
 * SQLite repository, navigation, natives and network mocked. Every logical
 * store update / focus event is driven one at a time and the per-component
 * render count attributable to it is recorded (perf/renderCounter.ts).
 *
 * Scale: SEED=20260903, 250 shots (HomeScreen's own listShots limit), 250
 * analysis facts, 20 profile writes, 20 consistency refreshes, 20 unrelated
 * store writes, 20 week-chart toggles, 20 notification writes, 10 refocus
 * loads. Replay: `cd apps/mobile && npx jest __tests__/perf/homeRender`.
 * Raw table: artifacts/perf-mobile-render/home.json.
 */
import {
  commitCount,
  measureStep,
  rendererInjected,
  resetCommits,
  summarize,
  type StepResult,
} from '../../perf/renderCounter';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest
      .requireActual<typeof import('../../perf/focus')>('../../perf/focus')
      .useFocusEffectMock(callback),
}));
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));

const mockListShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListActivityShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockGetKv = jest.fn<Promise<string | null>, unknown[]>(async () => null);
const mockSetKv = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('../../src/data/repository', () => ({
  listShots: (...args: unknown[]) => mockListShots(...args),
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listActivityShots: (...args: unknown[]) => mockListActivityShots(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
}));
const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));
const mockFetchCanonicalProgress = jest.fn<Promise<unknown>, unknown[]>(
  async () => null,
);
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: (...args: unknown[]) =>
    mockFetchCanonicalProgress(...args),
}));
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { HomeScreen } from '../../src/screens/HomeScreen';
import { useAppStore, type Profile } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  setActiveDataOwner,
  GUEST_DATA_OWNER,
} from '../../src/data/accountScope';
import { refocus } from '../../perf/focus';
import {
  FIXED_NOW_ISO,
  makeFacts,
  makeShots,
  renderedText,
  writeArtifact,
} from '../../perf/fixtures';

const SEED = 20260903;
const SHOT_COUNT = 250;
const STEPS = 20;
const REFOCUS_STEPS = 10;
const RUNAWAY_THRESHOLD = 3;

const shots = makeShots(SEED, SHOT_COUNT);
const facts = makeFacts(SEED, SHOT_COUNT);

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

function profileFor(i: number): Profile {
  return {
    firstName: `Player${i}`,
    skillLevel: ['beginner', 'intermediate', 'advanced'][i % 3]!,
    handedness: i % 2 === 0 ? 'right' : 'left',
    goal: 'dinks',
    biggestProblem: 'consistency',
    focusCheckpoint: 'contact_position',
  };
}

function findPill(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      typeof node.props['onPress'] === 'function' &&
      node.props['accessibilityLabel'] === label,
  )[0];
}

describe('perf: HomeScreen render cost per store update', () => {
  const steps: StepResult[] = [];
  let renderer: TestRenderer.ReactTestRenderer;

  beforeAll(async () => {
    expect(rendererInjected()).toBe(true);
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockListShots.mockImplementation(async () => shots);
    mockListRealAnalysisFacts.mockImplementation(async () => facts);
    mockListActivityShots.mockImplementation(async () => shots);
    useAppStore.setState({ profile: profileFor(0) });
    resetCommits();
  });

  afterAll(() => {
    const summary = summarize('HomeScreen', steps, RUNAWAY_THRESHOLD);
    const file = writeArtifact('home.json', {
      screen: 'HomeScreen',
      seed: SEED,
      shotCount: SHOT_COUNT,
      factCount: facts.length,
      fixedNowIso: FIXED_NOW_ISO,
      runawayThreshold: RUNAWAY_THRESHOLD,
      commitsObserved: commitCount(),
      summary,
      steps,
    });
    console.log(`[perf] HomeScreen table -> ${file}`);
    act(() => {
      renderer.unmount();
    });
  });

  /** Worst single-instance render count of the screen in a batch of steps. */
  function worstScreen(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.maxPerInstance['HomeScreen'] ?? 0));
  }

  /** Worst single-instance render count of ANY component in the batch. */
  function worstAny(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.max?.renders ?? 0));
  }

  it('mounts and completes the focus load', async () => {
    const step = await measureStep(
      'mount+focus-load',
      { seed: SEED, shots: SHOT_COUNT, facts: facts.length },
      async () => {
        await act(async () => {
          renderer = TestRenderer.create(<HomeScreen />);
        });
        await settle();
      },
    );
    steps.push(step);
    expect(step.renders['HomeScreen']).toBeGreaterThanOrEqual(1);
    expect(step.maxPerInstance['HomeScreen']).toBeLessThanOrEqual(
      RUNAWAY_THRESHOLD,
    );
    expect(renderedText(renderer.toJSON())).toContain('Player0');
  });

  it('re-renders at most once per appStore.profile write', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const profile = profileFor(i);
      const step = await measureStep(`appStore.profile#${i}`, profile, () => {
        act(() => {
          useAppStore.setState({ profile });
        });
      });
      local.push(step);
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('does not render for appStore slices Home never selects', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const step = await measureStep(
        `appStore.unselected#${i}`,
        { hydrated: i % 2 === 0 },
        () => {
          act(() => {
            useAppStore.setState({ hydrated: i % 2 === 0 });
          });
        },
      );
      local.push(step);
    }
    steps.push(...local);
    expect(Math.max(...local.map(s => s.totalRenders))).toBe(0);
  });

  it('re-renders at most 3x per consistency refresh (multi-set store action)', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const activity = shots.slice(0, Math.min(shots.length, 10 + i * 5));
      mockListActivityShots.mockImplementation(async () => activity);
      const step = await measureStep(
        `consistency.refresh#${i}`,
        { activityRows: activity.length },
        async () => {
          await act(async () => {
            await useConsistencyStore.getState().refresh();
          });
          await settle();
        },
      );
      local.push(step);
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('week chart toggle renders bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const label =
        i % 2 === 1
          ? 'Reads chart: scored reads per day'
          : 'Scores chart: every scored read at its score';
      const pill = findPill(renderer, label);
      expect(pill).toBeDefined();
      const step = await measureStep(
        `weekChart.toggle#${i}`,
        { pressed: label },
        async () => {
          if (!pill) return;
          await act(async () => {
            (pill.props['onPress'] as () => void)();
          });
          await settle();
        },
      );
      local.push(step);
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('notification store writes render bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const permission = i % 2 === 0 ? 'granted' : 'denied';
      const step = await measureStep(
        `notification.permission#${i}`,
        { hydrated: true, permission },
        () => {
          act(() => {
            useNotificationStore.setState({ hydrated: true, permission });
          });
        },
      );
      local.push(step);
    }
    steps.push(...local);
    expect(worstScreen(local)).toBe(0);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('refocus load (return to tab) renders bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= REFOCUS_STEPS; i += 1) {
      const step = await measureStep(
        `refocus.load#${i}`,
        { shots: SHOT_COUNT, facts: facts.length },
        async () => {
          await act(async () => {
            refocus();
          });
          await settle();
        },
      );
      local.push(step);
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });
});
