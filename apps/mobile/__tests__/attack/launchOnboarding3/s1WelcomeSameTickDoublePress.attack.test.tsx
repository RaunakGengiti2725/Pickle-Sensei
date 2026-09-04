/**
 * ADVERSARIAL PASS 3 — scenario 1 (mobile-launch-onboarding).
 *
 * Attack: on the real App.tsx Gate, fire Welcome's "I already have an
 * account" and "Start your first read" handlers inside the SAME tick (both
 * orders, plus rapid repeated interleavings). The Gate keeps one
 * `preAuthStage` state; two synchronous setState calls must collapse to the
 * LAST one, so exactly one of SignInScreen/OnboardingScreen mounts and the
 * two are never mounted concurrently, nor does the loser mount-then-unmount.
 *
 * SignInScreen / OnboardingScreen are replaced by stand-ins that write every
 * mount/unmount into a ledger so "never both mounted" is asserted on the
 * component lifecycle, not just on the final render tree.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passthrough = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    SafeAreaProvider: Passthrough,
    SafeAreaView: Passthrough,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 390, height: 844 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});

jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
    G: Mock,
    Ellipse: Mock,
  };
});

const mockKv = new Map<string, string>();
jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

jest.mock('../../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../../src/data/accountScope')
  >('../../../src/data/accountScope');
  const useAuthStore = create<{
    hydrated: boolean;
    session: null;
    hydrate: () => Promise<void>;
  }>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ hydrated: true, session: null });
    },
  }));
  return { useAuthStore };
});

jest.mock('../../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));

jest.mock('../../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    async requestPermission() {
      return 'denied';
    },
    async applyPlan() {},
    async cancelAllPlanned() {},
    async openSystemSettings() {},
  }),
}));

// Lifecycle ledger shared with the stand-ins below (jest.mock factories can
// only reach variables prefixed `mock`).
const mockLedger: string[] = [];
const mockMounted = new Set<string>();
let mockOverlapObserved = false;

jest.mock('../../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SignInScreen: () => {
      React.useEffect(() => {
        mockLedger.push('mount:signin');
        mockMounted.add('signin');
        if (mockMounted.size > 1) mockOverlapObserved = true;
        return () => {
          mockLedger.push('unmount:signin');
          mockMounted.delete('signin');
        };
      }, []);
      return React.createElement(Text, null, 'SIGN_IN_SCREEN');
    },
  };
});
jest.mock('../../../src/screens/OnboardingScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    OnboardingScreen: (props: { mode?: string }) => {
      React.useEffect(() => {
        mockLedger.push(`mount:onboarding:${props.mode ?? 'account'}`);
        mockMounted.add('onboarding');
        if (mockMounted.size > 1) mockOverlapObserved = true;
        return () => {
          mockLedger.push('unmount:onboarding');
          mockMounted.delete('onboarding');
        };
      }, [props.mode]);
      return React.createElement(Text, null, 'ONBOARDING_SCREEN');
    },
  };
});
jest.mock('../../../src/screens/SplashScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      React.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return React.createElement(Text, null, 'SPLASH');
    },
  };
});
jest.mock('../../../src/navigation/RootNavigator', () => ({
  RootNavigator: () => null,
}));
jest.mock('../../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../../App';
import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';

type Renderer = TestRenderer.ReactTestRenderer;

const SIGN_IN = 'I already have an account';
const GET_STARTED = 'Start your first read';

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string | number => typeof c !== 'object')
    .join('');
}

function isAncestor(
  ancestor: TestRenderer.ReactTestInstance,
  node: TestRenderer.ReactTestInstance,
): boolean {
  let current = node.parent;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function pressables(renderer: Renderer, label: string) {
  const matches = renderer.root.findAll(
    node =>
      node.props?.accessibilityLabel === label &&
      typeof node.props?.onPress === 'function',
  );
  return matches.filter(
    node => !matches.some(other => other !== node && isAncestor(node, other)),
  );
}

function handler(renderer: Renderer, label: string): () => void {
  const nodes = pressables(renderer, label);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  return nodes[0]!.props.onPress as () => void;
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

let mounted: Renderer | null = null;

async function launchToWelcome(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  const text = allText(renderer);
  expect(text).toContain('See the stroke.');
  expect(text).not.toContain('SPLASH');
  expect(mockLedger).toEqual([]);
  return renderer;
}

/** Deterministic LCG so the interleaving order is reproducible: seed 0x5EED03. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
const SEED = 0x5eed03;

beforeEach(() => {
  mockKv.clear();
  mockLedger.length = 0;
  mockMounted.clear();
  mockOverlapObserved = false;
  useAuthStore.setState({ hydrated: false, session: null });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  useNotificationStore.setState({ hydrated: false, ownerKey: null });
});

afterEach(() => {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
});

describe('S1 — Welcome: sign-in and get-started fired in the same tick', () => {
  it('signin then onboarding in one tick: only onboarding mounts, sign-in never does', async () => {
    const renderer = await launchToWelcome();
    const signIn = handler(renderer, SIGN_IN);
    const getStarted = handler(renderer, GET_STARTED);

    act(() => {
      signIn();
      getStarted();
    });
    await settle();

    const text = allText(renderer);
    expect(text).toContain('ONBOARDING_SCREEN');
    expect(text).not.toContain('SIGN_IN_SCREEN');
    expect(text).not.toContain('See the stroke.');
    expect(mockLedger).toEqual(['mount:onboarding:preauth']);
    expect(mockOverlapObserved).toBe(false);
  });

  it('onboarding then signin in one tick: only sign-in mounts, onboarding never does', async () => {
    const renderer = await launchToWelcome();
    const signIn = handler(renderer, SIGN_IN);
    const getStarted = handler(renderer, GET_STARTED);

    act(() => {
      getStarted();
      signIn();
    });
    await settle();

    const text = allText(renderer);
    expect(text).toContain('SIGN_IN_SCREEN');
    expect(text).not.toContain('ONBOARDING_SCREEN');
    expect(mockLedger).toEqual(['mount:signin']);
    expect(mockOverlapObserved).toBe(false);
  });

  it('stale Welcome handlers fired AFTER Welcome unmounted still never co-mount the two screens', async () => {
    const renderer = await launchToWelcome();
    const signIn = handler(renderer, SIGN_IN);
    const getStarted = handler(renderer, GET_STARTED);

    act(() => {
      signIn();
    });
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(pressables(renderer, GET_STARTED)).toHaveLength(0);

    // A queued touch delivered to the now-unmounted Welcome (the closure is
    // still callable): the Gate must swap screens, never stack them.
    act(() => {
      getStarted();
    });
    await settle();
    const text = allText(renderer);
    expect(text).toContain('ONBOARDING_SCREEN');
    expect(text).not.toContain('SIGN_IN_SCREEN');
    expect(mockLedger).toEqual([
      'mount:signin',
      'unmount:signin',
      'mount:onboarding:preauth',
    ]);
    expect(mockOverlapObserved).toBe(false);
  });

  it(`seeded rapid interleavings (seed ${SEED}): last press wins every round, never both mounted`, async () => {
    const renderer = await launchToWelcome();
    const signIn = handler(renderer, SIGN_IN);
    const getStarted = handler(renderer, GET_STARTED);
    const rand = lcg(SEED);

    for (let round = 0; round < 40; round += 1) {
      const burst = 1 + Math.floor(rand() * 6);
      let last: 'signin' | 'onboarding' = 'signin';
      act(() => {
        for (let i = 0; i < burst; i += 1) {
          if (rand() < 0.5) {
            signIn();
            last = 'signin';
          } else {
            getStarted();
            last = 'onboarding';
          }
        }
      });
      await settle();
      const text = allText(renderer);
      if (last === 'signin') {
        expect(text).toContain('SIGN_IN_SCREEN');
        expect(text).not.toContain('ONBOARDING_SCREEN');
      } else {
        expect(text).toContain('ONBOARDING_SCREEN');
        expect(text).not.toContain('SIGN_IN_SCREEN');
      }
      expect(mockMounted.size).toBe(1);
      expect(mockOverlapObserved).toBe(false);
    }
    // Every mount in the ledger is followed by its unmount before the next
    // mount of the other screen — no interleaved mount/mount pairs.
    for (let i = 1; i < mockLedger.length; i += 1) {
      const prev = mockLedger[i - 1]!;
      const cur = mockLedger[i]!;
      if (cur.startsWith('mount:')) {
        expect(prev.startsWith('unmount:')).toBe(true);
      }
    }
  });
});
