/**
 * Render-cost harness — ProgressScreen.
 *
 * Real ProgressScreen + real Zustand stores (appStore, consistency, rank
 * celebration); SQLite repository, navigation, natives and network mocked.
 * ProgressScreen loads `listRealAnalysisFacts(db, null)` and
 * `listCaptureHistory(db, null)` with NO limit, so the scale here is the
 * unbounded-history case: SEED=20260903, 2000 facts + 2000 capture-history
 * rows. Steps: mount, 20 profile writes, 20 unrelated store writes, 20
 * consistency refreshes, 20 section toggles, 20 range toggles, 10 refocus
 * loads. Replay: `cd apps/mobile && npx jest __tests__/perf/progressRender`.
 * Raw table: artifacts/perf-mobile-render/progress.json.
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

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListActivityShots = jest.fn<Promise<unknown[]>, unknown[]>();
const mockGetKv = jest.fn<Promise<string | null>, unknown[]>(async () => null);
const mockSetKv = jest.fn<Promise<void>, unknown[]>(async () => {});
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
  listActivityShots: (...args: unknown[]) => mockListActivityShots(...args),
  getKv: (...args: unknown[]) => mockGetKv(...args),
  setKv: (...args: unknown[]) => mockSetKv(...args),
}));
const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));
jest.mock('../../src/progress/api', () => ({
  fetchCanonicalProgress: jest.fn(async () => null),
}));
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return { ...actual, fetchPlayerRank: jest.fn(async () => null) };
});

import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { useAppStore, type Profile } from '../../src/state/appStore';
import { useConsistencyStore } from '../../src/consistency/store';
import {
  setActiveDataOwner,
  GUEST_DATA_OWNER,
} from '../../src/data/accountScope';
import { refocus } from '../../perf/focus';
import {
  FIXED_NOW_ISO,
  makeCaptureHistory,
  makeFacts,
  makeShots,
  renderedText,
  writeArtifact,
} from '../../perf/fixtures';

const SEED = 20260903;
const HISTORY_COUNT = 2000;
const STEPS = 20;
const REFOCUS_STEPS = 10;
const RUNAWAY_THRESHOLD = 3;

const facts = makeFacts(SEED, HISTORY_COUNT);
const captures = makeCaptureHistory(SEED, HISTORY_COUNT);
const activity = makeShots(SEED, 250);

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
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

describe('perf: ProgressScreen render cost per store update', () => {
  const steps: StepResult[] = [];
  let renderer: TestRenderer.ReactTestRenderer;

  beforeAll(() => {
    expect(rendererInjected()).toBe(true);
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockListRealAnalysisFacts.mockImplementation(async () => facts);
    mockListCaptureHistory.mockImplementation(async () => captures);
    mockListActivityShots.mockImplementation(async () => activity);
    useAppStore.setState({ profile: profileFor(0) });
    resetCommits();
  });

  afterAll(() => {
    const summary = summarize('ProgressScreen', steps, RUNAWAY_THRESHOLD);
    const file = writeArtifact('progress.json', {
      screen: 'ProgressScreen',
      seed: SEED,
      factCount: facts.length,
      captureHistoryCount: captures.length,
      fixedNowIso: FIXED_NOW_ISO,
      runawayThreshold: RUNAWAY_THRESHOLD,
      commitsObserved: commitCount(),
      summary,
      steps,
    });
    console.log(`[perf] ProgressScreen table -> ${file}`);
    act(() => {
      renderer.unmount();
    });
  });

  function worstScreen(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.maxPerInstance['ProgressScreen'] ?? 0));
  }

  function worstAny(local: readonly StepResult[]): number {
    return Math.max(...local.map(s => s.max?.renders ?? 0));
  }

  async function press(label: string) {
    const pill = findPill(renderer, label);
    expect(pill).toBeDefined();
    await act(async () => {
      (pill!.props['onPress'] as () => void)();
    });
    await settle();
  }

  it('mounts and completes the unbounded-history focus load', async () => {
    const step = await measureStep(
      'mount+focus-load',
      { seed: SEED, facts: facts.length, captures: captures.length },
      async () => {
        await act(async () => {
          renderer = TestRenderer.create(<ProgressScreen />);
        });
        await settle();
      },
    );
    steps.push(step);
    expect(step.maxPerInstance['ProgressScreen']).toBeLessThanOrEqual(
      RUNAWAY_THRESHOLD,
    );
    expect(renderedText(renderer.toJSON())).toContain('TECHNIQUE');
  });

  it('re-renders at most once per appStore.profile write', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const profile = profileFor(i);
      local.push(
        await measureStep(`appStore.profile#${i}`, profile, () => {
          act(() => {
            useAppStore.setState({ profile });
          });
        }),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(1);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('does not render for appStore slices Progress never selects', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      local.push(
        await measureStep(
          `appStore.unselected#${i}`,
          { hydrated: i % 2 === 0 },
          () => {
            act(() => {
              useAppStore.setState({ hydrated: i % 2 === 0 });
            });
          },
        ),
      );
    }
    steps.push(...local);
    expect(Math.max(...local.map(s => s.totalRenders))).toBe(0);
  });

  it('consistency refresh renders bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const rows = activity.slice(0, 10 + i * 5);
      mockListActivityShots.mockImplementation(async () => rows);
      local.push(
        await measureStep(
          `consistency.refresh#${i}`,
          { activityRows: rows.length },
          async () => {
            await act(async () => {
              await useConsistencyStore.getState().refresh();
            });
            await settle();
          },
        ),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('section toggle (technique <-> practice) renders bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= STEPS; i += 1) {
      const label = i % 2 === 1 ? 'practice progress' : 'technique progress';
      local.push(
        await measureStep(`section.toggle#${i}`, { pressed: label }, () =>
          press(label),
        ),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('range toggle (7d / 4 weeks / 90d) renders bounded', async () => {
    const local: StepResult[] = [];
    const labels = ['7 days range', '90 days range', '4 weeks range'];
    for (let i = 1; i <= STEPS; i += 1) {
      const label = labels[i % labels.length]!;
      local.push(
        await measureStep(`range.toggle#${i}`, { pressed: label }, () =>
          press(label),
        ),
      );
    }
    steps.push(...local);
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });

  it('refocus load (return to tab) renders bounded', async () => {
    const local: StepResult[] = [];
    for (let i = 1; i <= REFOCUS_STEPS; i += 1) {
      local.push(
        await measureStep(
          `refocus.load#${i}`,
          { facts: facts.length, captures: captures.length },
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
    expect(worstScreen(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
    expect(worstAny(local)).toBeLessThanOrEqual(RUNAWAY_THRESHOLD);
  });
});
