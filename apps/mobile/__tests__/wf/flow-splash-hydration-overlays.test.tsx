import React from 'react';
import { Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PlayerRankSummary } from '@pickle/shared-types';

/**
 * Launch flow workflow: splash (MP4 intro) cross-fade on readiness,
 * hydration failure paths (unreadable SQLite, corrupt kv rows), and the three
 * global overlays that App.tsx mounts (RankUpCelebration, StreakCelebration,
 * FirstRunWalkthrough) driven through every dismiss control — backdrop,
 * primary CTA, and the Modal's onRequestClose (Android back) — including
 * double taps and all three overlays raised at once.
 * react-native-video is auto-mocked from `__mocks__/` (canonical harness:
 * `__tests__/splashScreen.test.tsx`).
 */

type DbMode = 'throw' | 'kv';
let mockDbMode: DbMode = 'kv';
const mockKvTable = new Map<string, string>();
const mockExecuteLog: string[] = [];

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (mockDbMode === 'throw') {
      throw new Error('database disk image is malformed');
    }
    return {
      async execute(sql: string, params: unknown[] = []) {
        mockExecuteLog.push(sql);
        if (sql.startsWith('SELECT value FROM kv')) {
          const value = mockKvTable.get(String(params[0]));
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
          mockKvTable.set(String(params[0]), String(params[1]));
          return { rows: [] };
        }
        return { rows: [] };
      },
      close() {},
    };
  },
}));

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: async (_s: unknown, p: unknown) => p,
}));

import {
  EXIT_MS,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import { useAppStore } from '../../src/state/appStore';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  getKv,
  setKv,
} from '../../src/data/repository';
import { getDb } from '../../src/data/db';
import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import { useConsistencyStore } from '../../src/consistency/store';
import type { ConsistencyCelebration } from '../../src/consistency/store';
import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  WALKTHROUGH_KV_KEY,
  useWalkthroughStore,
} from '../../src/walkthrough/walkthroughStore';
import { registerWalkthroughMeasurer } from '../../src/walkthrough/targets';

const diamondSummary: PlayerRankSummary = {
  rating: 7.62,
  tier: 'diamond',
  tierLabel: 'Diamond',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 3,
  scoredAnalysisCount: 9,
  techniques: [],
  nextTier: null,
};

const thirtyDayClub: ConsistencyCelebration = {
  kind: 'streak',
  achievementId: 'streak.30',
  title: '30 Day Club',
  blurb: 'A month of showing up. Very few do this.',
  reward: 'Exclusive profile frame',
  rarity: 'epic',
  value: 30,
  streakAtCelebration: 30,
};

function raiseRank() {
  useRankCelebrationStore.setState({
    current: {
      fromTier: 'platinum',
      toTier: 'diamond',
      fromRating: 7.1,
      summary: diamondSummary,
    },
  });
}

function raiseStreak() {
  useConsistencyStore.setState({ celebration: thirtyDayClub });
}

function registerAllTargets() {
  const unregister: Array<() => void> = [];
  for (const step of WALKTHROUGH_STEPS) {
    unregister.push(
      registerWalkthroughMeasurer(step.targetKey, () =>
        Promise.resolve({ x: 20, y: 300, width: 200, height: 48 }),
      ),
    );
  }
  return () => unregister.forEach(fn => fn());
}

function hostByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  return renderer.root.findAll(
    node => node.props?.testID === testID && typeof node.type === 'string',
  );
}

function hostPressable(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  // The innermost composite carrying the testID is RN's Pressable, whose
  // props are the ones that reach the host view (role, label, onPress).
  const nodes = renderer.root.findAll(
    node =>
      node.props?.testID === testID &&
      typeof node.type === 'function' &&
      node.type.name === 'Pressable' &&
      !!node.props.onPress,
  );
  expect(nodes.length).toBeGreaterThan(0);
  return nodes[0]!;
}

function pressLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const nodes = renderer.root.findAll(
    node => node.props?.accessibilityLabel === label && !!node.props.onPress,
  );
  expect(nodes.length).toBeGreaterThan(0);
  nodes[0]!.props.onPress();
}

function pressTestId(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  hostPressable(renderer, testID).props.onPress();
}

function requestClose(
  renderer: TestRenderer.ReactTestRenderer,
  rootTestId: string,
) {
  const modals = renderer.root
    .findAllByType(Modal)
    .filter(
      modal =>
        modal.props.visible &&
        modal.findAll(node => node.props?.testID === rootTestId).length > 0,
    );
  expect(modals).toHaveLength(1);
  expect(typeof modals[0]!.props.onRequestClose).toBe('function');
  modals[0]!.props.onRequestClose();
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockDbMode = 'kv';
  mockKvTable.clear();
  mockExecuteLog.length = 0;
  setActiveDataOwner(GUEST_DATA_OWNER);
});

afterEach(() => {
  useRankCelebrationStore.setState({ current: null });
  useConsistencyStore.setState({ celebration: null });
  useWalkthroughStore.setState({ visible: false });
});

function splashVideo(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      typeof node.type === 'string' && node.props.testID === 'splash-video',
  );
}

describe('SplashScreen fade on readiness', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('holds until the intro is over even when hydration is instant, then cross-fades out exactly once', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    // Ready from the first frame, intro still playing: nothing leaves short
    // of the watchdog.
    act(() => jest.advanceTimersByTime(WATCHDOG_MS - 1));
    expect(onFinished).not.toHaveBeenCalled();
    // The intro ends → the exit cross-fade starts on the next commit.
    act(() => splashVideo(renderer).props.onEnd());
    expect(onFinished).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(EXIT_MS + 50));
    expect(onFinished).toHaveBeenCalledTimes(1);
    // A late watchdog cannot re-run the handoff.
    act(() => jest.advanceTimersByTime(WATCHDOG_MS + 5000));
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('never fades before hydration is ready, then fades once ready flips', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={onFinished} />,
      );
    });
    act(() => splashVideo(renderer).props.onEnd());
    act(() => jest.advanceTimersByTime(WATCHDOG_MS + 10_000));
    expect(onFinished).not.toHaveBeenCalled();
    await act(async () => {
      renderer.update(<SplashScreen ready onFinished={onFinished} />);
    });
    act(() => jest.advanceTimersByTime(EXIT_MS + 50));
    expect(onFinished).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('cleans up its timers on unmount and never reports after it is gone', async () => {
    const onFinished = jest.fn();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready onFinished={onFinished} />,
      );
    });
    act(() => jest.advanceTimersByTime(300));
    act(() => renderer.unmount());
    act(() => jest.advanceTimersByTime(WATCHDOG_MS + EXIT_MS + 10_000));
    expect(onFinished).not.toHaveBeenCalled();
  });

  it('exposes the intro to screen readers as a labelled image — never as a labelled root that would hide Skip', async () => {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <SplashScreen ready={false} onFinished={() => {}} />,
      );
    });
    const announced = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Pickle Sensei intro animation' &&
        node.props.accessibilityRole === 'image' &&
        node.props.accessible === true,
    );
    expect(announced).toHaveLength(1);
    // The former "Pickle Sensei is starting" root label is gone: an
    // accessible root would swallow the Skip control for VoiceOver users.
    const root = renderer.root.find(
      node =>
        typeof node.type === 'string' && node.props.testID === 'splash-screen',
    );
    expect(root.props.accessible).toBeUndefined();
    expect(root.props.accessibilityLabel).toBeUndefined();
    expect(
      renderer.root.findAll(
        node => node.props?.accessibilityLabel === 'Pickle Sensei is starting',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

describe('hydration failure paths keep the launch gate moving', () => {
  it('unreadable SQLite: appStore still reports hydrated for the active owner', async () => {
    mockDbMode = 'throw';
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
    expect(state.profile).toBeNull();
  });

  it('corrupt profile kv row: hydrate lands without a profile instead of hanging', async () => {
    mockKvTable.set(`profile:${GUEST_DATA_OWNER}`, '{not json');
    await useAppStore.getState().hydrate();
    const state = useAppStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(GUEST_DATA_OWNER);
    expect(state.profile).toBeNull();
  });

  it('unreadable SQLite: no celebration or walkthrough overlay is raised', async () => {
    mockDbMode = 'throw';
    await useRankCelebrationStore.getState().maybeCelebrate(diamondSummary);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    await useWalkthroughStore.getState().maybeShowFirstRun();
    expect(useWalkthroughStore.getState().visible).toBe(false);
  });

  it('corrupt rank record: the ceremony is skipped and the record is repaired', async () => {
    mockKvTable.set(rankCelebrationKeyForOwner(GUEST_DATA_OWNER), '<<corrupt');
    await useRankCelebrationStore.getState().maybeCelebrate(diamondSummary);
    // A corrupt row parses to "no record" → placement ceremony, written first.
    expect(
      JSON.parse(
        mockKvTable.get(rankCelebrationKeyForOwner(GUEST_DATA_OWNER))!,
      ),
    ).toEqual({ version: 1, tier: 'diamond', rating: 7.62 });
    expect(useRankCelebrationStore.getState().current?.fromTier).toBeNull();
  });

  it('kv helpers round-trip through the shared LocalDb contract', async () => {
    await setKv(getDb(), 'wf.key', 'value');
    expect(await getKv(getDb(), 'wf.key')).toBe('value');
    expect(await getKv(getDb(), 'wf.missing')).toBeNull();
  });
});

describe('AGENTS.md owner-scoping invariants for overlay state', () => {
  it('rank + consistency records are owner scoped; the walkthrough is device scoped', () => {
    expect(OWNER_SCOPED_KV_NAMESPACES).toEqual([
      'profile',
      'rank.celebrated',
      'notifications',
      'consistency',
      'practice.set',
    ]);
    expect(rankCelebrationKeyForOwner('owner-1')).toBe(
      'rank.celebrated:owner-1',
    );
    expect(WALKTHROUGH_KV_KEY).toBe('walkthrough.device-complete');
    expect(
      OWNER_SCOPED_KV_NAMESPACES.some(ns => WALKTHROUGH_KV_KEY.startsWith(ns)),
    ).toBe(false);
  });

  it('walkthrough writes its device record BEFORE becoming visible', async () => {
    const visibleAtWrite: boolean[] = [];
    const unsubscribe = useWalkthroughStore.subscribe(state => {
      visibleAtWrite.push(state.visible);
    });
    await useWalkthroughStore.getState().maybeShowFirstRun();
    unsubscribe();
    const writeIndex = mockExecuteLog.findIndex(sql =>
      sql.startsWith('INSERT OR REPLACE INTO kv'),
    );
    expect(writeIndex).toBeGreaterThanOrEqual(0);
    expect(mockKvTable.get(WALKTHROUGH_KV_KEY)).toBeDefined();
    expect(useWalkthroughStore.getState().visible).toBe(true);
    expect(visibleAtWrite).toEqual([true]);
  });
});

describe('RankUpCelebration dismiss controls', () => {
  it('backdrop dismisses and is labelled for assistive tech', async () => {
    raiseRank();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(1);
    await act(async () => pressLabel(renderer, 'Dismiss rank celebration'));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('Android back (onRequestClose) dismisses', async () => {
    raiseRank();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    await act(async () => requestClose(renderer, 'rank-up-celebration'));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    act(() => renderer.unmount());
  });

  it('Continue is a labelled button and a double tap is harmless', async () => {
    raiseRank();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    const button = hostPressable(renderer, 'rank-up-continue');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Continue');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('unmounting mid-ceremony does not throw or leave the store dirty', async () => {
    raiseRank();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<RankUpCelebration />);
    });
    expect(() => act(() => renderer.unmount())).not.toThrow();
    useRankCelebrationStore.getState().dismiss();
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });
});

describe('StreakCelebration dismiss controls', () => {
  it('backdrop dismisses and is labelled for assistive tech', async () => {
    raiseStreak();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    expect(hostByTestId(renderer, 'streak-celebration')).toHaveLength(1);
    await act(async () =>
      pressLabel(renderer, 'Dismiss milestone celebration'),
    );
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(hostByTestId(renderer, 'streak-celebration')).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('Android back (onRequestClose) dismisses', async () => {
    raiseStreak();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    await act(async () => requestClose(renderer, 'streak-celebration'));
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });

  it('Keep training is a labelled button and a double tap is harmless', async () => {
    raiseStreak();
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<StreakCelebration />);
    });
    const button = hostPressable(renderer, 'streak-celebration-continue');
    expect(button.props.accessibilityRole).toBe('button');
    expect(button.props.accessibilityLabel).toBe('Keep training');
    await act(async () => {
      button.props.onPress();
      button.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });
});

describe('FirstRunWalkthrough dismiss controls', () => {
  let unregister: () => void = () => {};
  beforeEach(() => {
    unregister = registerAllTargets();
  });
  afterEach(() => unregister());

  it('Android back (onRequestClose) dismisses the tour', async () => {
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    await flush();
    expect(hostByTestId(renderer, 'walkthrough-advance').length).toBe(1);
    await act(async () => requestClose(renderer, 'walkthrough-advance'));
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('Skip and Next carry button roles/labels; double-tapping Skip is harmless', async () => {
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    await flush();
    const skip = hostPressable(renderer, 'walkthrough-skip');
    expect(skip.props.accessibilityRole).toBe('button');
    expect(skip.props.accessibilityLabel).toBe('Skip walkthrough');
    const next = hostPressable(renderer, 'walkthrough-advance');
    expect(next.props.accessibilityRole).toBe('button');
    expect(next.props.accessibilityLabel).toBe('Next');
    await act(async () => {
      skip.props.onPress();
      skip.props.onPress();
    });
    expect(useWalkthroughStore.getState().visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('a replay starts from the first step after a completed tour', async () => {
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    await flush();
    for (let i = 0; i < WALKTHROUGH_STEPS.length; i++) {
      await act(async () => pressTestId(renderer, 'walkthrough-advance'));
      await flush();
    }
    expect(useWalkthroughStore.getState().visible).toBe(false);
    await act(async () => useWalkthroughStore.getState().replay());
    await flush();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(WALKTHROUGH_STEPS[0]!.headline);
    expect(text).not.toContain(WALKTHROUGH_STEPS[1]!.headline);
    expect(
      hostPressable(renderer, 'walkthrough-advance').props.accessibilityLabel,
    ).toBe('Next');
    act(() => renderer.unmount());
  });

  it('unmounting while a step is measuring does not throw', async () => {
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<FirstRunWalkthrough />);
    });
    expect(() => act(() => renderer.unmount())).not.toThrow();
    await flush();
  });
});

describe('all three global overlays raised together (App.tsx mount order)', () => {
  let unregister: () => void = () => {};
  beforeEach(() => {
    unregister = registerAllTargets();
  });
  afterEach(() => unregister());

  it('every overlay stays independently dismissable; none traps the others', async () => {
    raiseRank();
    raiseStreak();
    useWalkthroughStore.setState({ visible: true });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <>
          <RankUpCelebration />
          <StreakCelebration />
          <FirstRunWalkthrough />
        </>,
      );
    });
    await flush();
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(1);
    expect(hostByTestId(renderer, 'streak-celebration')).toHaveLength(1);
    expect(hostByTestId(renderer, 'walkthrough-advance')).toHaveLength(1);

    await act(async () =>
      pressLabel(renderer, 'Dismiss milestone celebration'),
    );
    expect(hostByTestId(renderer, 'streak-celebration')).toHaveLength(0);
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(1);
    expect(hostByTestId(renderer, 'walkthrough-advance')).toHaveLength(1);

    await act(async () => pressTestId(renderer, 'walkthrough-skip'));
    expect(hostByTestId(renderer, 'walkthrough-advance')).toHaveLength(0);
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(1);

    await act(async () => pressTestId(renderer, 'rank-up-continue'));
    expect(hostByTestId(renderer, 'rank-up-celebration')).toHaveLength(0);
    expect(renderer.root.findAllByType(Modal).some(m => m.props.visible)).toBe(
      false,
    );
    act(() => renderer.unmount());
  });
});
