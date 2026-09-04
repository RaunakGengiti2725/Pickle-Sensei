/**
 * Synchronous JS work on the ProgressScreen render path vs history size.
 *
 * ProgressScreen loads the WHOLE local history (`listRealAnalysisFacts(db,
 * null)`, `listCaptureHistory(db, null)` — no limit) and derives every chart
 * in render/useMemo. This harness mounts a fresh screen at 0 / 250 / 1000 /
 * 4000 / 8000 facts+captures (SEED=20260903) and records, from React's own
 * profiler timings (Fiber `actualDuration`, i.e. JS-thread render work
 * excluding layout/native): the mount+load subtree duration and the
 * ProgressScreen render duration for a single unrelated `appStore.profile`
 * write, which forces a full re-render because nothing below the screen is
 * a React.memo boundary. Jest/Node timings are a Linux proxy for the amount
 * of synchronous JS work, NOT device frame times.
 * Replay: `cd apps/mobile && npx jest __tests__/perf/progressScale`.
 * Raw table: artifacts/perf-mobile-render/progress-scale.json.
 */
import {
  measureStep,
  rendererInjected,
  resetCommits,
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
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useFocusEffect: (callback: () => void | (() => void)) =>
    jest
      .requireActual<typeof import('../../perf/focus')>('../../perf/focus')
      .useFocusEffectMock(callback),
}));
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));

const mockListRealAnalysisFacts = jest.fn<Promise<unknown[]>, unknown[]>();
const mockListCaptureHistory = jest.fn<Promise<unknown[]>, unknown[]>();
jest.mock('../../src/data/repository', () => ({
  listRealAnalysisFacts: (...args: unknown[]) =>
    mockListRealAnalysisFacts(...args),
  listCaptureHistory: (...args: unknown[]) => mockListCaptureHistory(...args),
  listActivityShots: jest.fn(async () => []),
  getKv: jest.fn(async () => null),
  setKv: jest.fn(async () => {}),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
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
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  FIXED_NOW_ISO,
  makeCaptureHistory,
  makeFacts,
  renderedText,
  writeArtifact,
} from '../../perf/fixtures';

const SEED = 20260903;
const SCALES = [0, 250, 1000, 4000, 8000] as const;
const PROFILE_WRITES = 5;

type ScaleRow = {
  historyRows: number;
  mount: StepResult;
  profileWrites: StepResult[];
  mountSubtreeMs: number;
  profileWriteScreenMs: { min: number; max: number; mean: number };
  profileWriteWallMs: { min: number; max: number; mean: number };
  componentsPerProfileWrite: number;
};

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

async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    });
  }
}

function stats(values: number[]) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, mean: Math.round(mean * 100) / 100 };
}

describe('perf: ProgressScreen synchronous render work vs history size', () => {
  const rows: ScaleRow[] = [];

  beforeAll(() => {
    expect(rendererInjected()).toBe(true);
    setActiveDataOwner(GUEST_DATA_OWNER);
  });

  afterAll(() => {
    const file = writeArtifact('progress-scale.json', {
      screen: 'ProgressScreen',
      seed: SEED,
      fixedNowIso: FIXED_NOW_ISO,
      scales: SCALES,
      note: 'Fiber actualDuration under Jest/Node — Linux proxy for JS-thread render work, not device frame time.',
      rows,
    });
    console.log(`[perf] ProgressScreen scale table -> ${file}`);
  });

  for (const historyRows of SCALES) {
    it(`mounts and re-renders with ${historyRows} facts + ${historyRows} captures`, async () => {
      const facts = makeFacts(SEED, historyRows);
      const captures = makeCaptureHistory(SEED, historyRows);
      mockListRealAnalysisFacts.mockImplementation(async () => facts);
      mockListCaptureHistory.mockImplementation(async () => captures);
      useAppStore.setState({ profile: profileFor(0) });
      resetCommits();

      let renderer!: TestRenderer.ReactTestRenderer;
      const mount = await measureStep(
        `mount@${historyRows}`,
        { seed: SEED, facts: facts.length, captures: captures.length },
        async () => {
          await act(async () => {
            renderer = TestRenderer.create(<ProgressScreen />);
          });
          await settle();
        },
      );
      expect(renderedText(renderer.toJSON())).toContain('TECHNIQUE');

      const profileWrites: StepResult[] = [];
      for (let i = 1; i <= PROFILE_WRITES; i += 1) {
        const profile = profileFor(i);
        profileWrites.push(
          await measureStep(
            `appStore.profile@${historyRows}#${i}`,
            profile,
            () => {
              act(() => {
                useAppStore.setState({ profile });
              });
            },
          ),
        );
      }
      await act(async () => {
        renderer.unmount();
      });

      const screenMs = profileWrites.map(
        s => s.durationMs['ProgressScreen'] ?? 0,
      );
      rows.push({
        historyRows,
        mount,
        profileWrites,
        mountSubtreeMs: mount.durationMs['ProgressScreen'] ?? 0,
        profileWriteScreenMs: stats(screenMs),
        profileWriteWallMs: stats(profileWrites.map(s => s.wallMs)),
        componentsPerProfileWrite: Math.max(
          ...profileWrites.map(s => s.totalRenders),
        ),
      });
      expect(
        Math.max(
          ...profileWrites.map(s => s.maxPerInstance['ProgressScreen'] ?? 0),
        ),
      ).toBeLessThanOrEqual(1);
    });
  }
});
