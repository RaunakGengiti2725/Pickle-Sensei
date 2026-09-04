import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { Profile } from '../../src/state/profile';

/**
 * Mutation pin for the App.tsx Gate (harness:
 * tools/mutation/launch-gate/mutants.mjs): the Welcome primary CTA must route
 * through `stageAfterGetStarted()` and NOTHING in the app store may flip it.
 *
 * Mutant `APP16-getstarted-consults-profile` —
 *   onGetStarted={() => setPreAuthStage(profile ? 'signin' : stageAfterGetStarted())}
 * — survived the full suite on 4d812e1a because every existing flow reaches
 * Welcome with a null store profile. It is reachable in production: the
 * signed-out owner hydrates from kv `profile:signed-out`, and a stale or
 * hand-written row there would make "Start your first read" skip the
 * questionnaire. This file seeds exactly that state (and, separately,
 * injects a profile straight into the store) and requires the CTA to enter
 * the questionnaire anyway.
 */

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
jest.mock('../../src/data/db', () => ({
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

interface MockAuthState {
  hydrated: boolean;
  session: null;
  hydrate: () => Promise<void>;
  signOut: () => Promise<void>;
}
jest.mock('../../src/auth/authStore', () => {
  const { create } = jest.requireActual<typeof import('zustand')>('zustand');
  const scope = jest.requireActual<
    typeof import('../../src/data/accountScope')
  >('../../src/data/accountScope');
  const useAuthStore = create<MockAuthState>(set => ({
    hydrated: false,
    session: null,
    hydrate: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ hydrated: true, session: null });
    },
    signOut: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ session: null });
    },
  }));
  return { useAuthStore };
});

jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => null,
}));
jest.mock('../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => null,
  saveCanonicalOnboardingProfile: async (_s: unknown, profile: Profile) =>
    profile,
}));
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    async requestPermission() {
      return 'granted';
    },
    async applyPlan() {},
    async cancelAllPlanned() {},
    async openSystemSettings() {},
  }),
}));

jest.mock('../../src/navigation/RootNavigator', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    RootNavigator: () => React.createElement(Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    SignInScreen: () => React.createElement(Text, null, 'SIGN_IN_SCREEN'),
  };
});
jest.mock('../../src/screens/SplashScreen', () => {
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
jest.mock('../../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

import App from '../../App';
import { useAuthStore } from '../../src/auth/authStore';
import {
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useAppStore } from '../../src/state/appStore';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';

type Renderer = TestRenderer.ReactTestRenderer;

const staleProfile: Profile = {
  firstName: 'Stale',
  gender: 'male',
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'dinks',
  biggestProblem: 'consistency',
  focusCheckpoint: 'paddle_set',
};

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

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

async function pressAsync(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
  await settle();
}

let mounted: Renderer | null = null;

async function launch(): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  await settle();
  mounted = renderer;
  return renderer;
}

function expectWelcome(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).not.toContain('SPLASH');
  expect(text).toContain('See the stroke.');
  expect(text).not.toContain('SIGN_IN_SCREEN');
  expect(text).not.toContain('PLAYER SETUP');
  expect(text).not.toContain('ROOT_NAVIGATOR');
}

function expectQuestionnaireStepOne(renderer: Renderer) {
  const text = allText(renderer);
  expect(text).toContain('PLAYER SETUP');
  expect(text).toContain('What should we call you?');
  expect(text).not.toContain('SIGN_IN_SCREEN');
  expect(text).not.toContain('ROOT_NAVIGATOR');
  const back = pressables(renderer, 'Back');
  expect(back).toHaveLength(1);
  expect(back[0]!.props.accessibilityHint).toBe('Return to the welcome screen');
}

describe('Gate — the primary CTA never consults the store profile', () => {
  beforeEach(() => {
    mockKv.clear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({ hydrated: false, session: null });
    useAppStore.setState({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
    });
    useNotificationStore.setState({
      hydrated: false,
      ownerKey: null,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: 'unknown',
    });
  });

  afterEach(() => {
    const renderer = mounted;
    mounted = null;
    if (renderer) act(() => renderer.unmount());
  });

  it('a stale profile row under the signed-out owner is hydrated — and "Start your first read" still enters step one', async () => {
    mockKv.set(
      profileKeyForOwner(SIGNED_OUT_DATA_OWNER),
      JSON.stringify(staleProfile),
    );
    const renderer = await launch();
    // Precondition for the pin: the Gate really sees a profile here.
    expect(useAppStore.getState().ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAppStore.getState().profile).toEqual(staleProfile);
    expectWelcome(renderer);

    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);

    // Back to Welcome and again — the answer never drifts.
    await pressAsync(renderer, 'Back');
    expectWelcome(renderer);
    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
  });

  it('a profile injected into the store after Welcome painted does not reroute the primary CTA', async () => {
    const renderer = await launch();
    expectWelcome(renderer);
    expect(useAppStore.getState().profile).toBeNull();

    act(() => {
      useAppStore.setState({ profile: staleProfile });
    });
    await settle();
    expectWelcome(renderer);

    await pressAsync(renderer, 'Start your first read');
    expectQuestionnaireStepOne(renderer);
  });

  it('with a store profile present, sign-in is still reachable only through the explicit link', async () => {
    mockKv.set(
      profileKeyForOwner(SIGNED_OUT_DATA_OWNER),
      JSON.stringify(staleProfile),
    );
    const renderer = await launch();
    expectWelcome(renderer);
    await pressAsync(renderer, 'I already have an account');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('PLAYER SETUP');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
  });
});
