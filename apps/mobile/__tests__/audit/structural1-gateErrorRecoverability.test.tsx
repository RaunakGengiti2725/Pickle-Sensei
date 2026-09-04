import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';

/**
 * AUDIT PROBE (structural pass 1, mobile-launch-onboarding) — App.tsx Gate.
 *
 * (1) The hydrate-failure ErrorState (App.tsx:217-223) exposes only "Try
 *     again". When the failure is permanent for this owner (a corrupt local
 *     profile row is re-thrown on every hydrate — see
 *     structural1-storedRowValidation.test.ts), the signed-in user has no
 *     in-app way out: no sign-out, no "start over". Invariant probed: an
 *     error state that can be permanent must offer a second exit.
 * (2) The Gate mounts RootNavigator on ANY truthy `profile` (App.tsx:224-227)
 *     — the store performs no shape check, so `{}` from a malformed row is
 *     enough to enter the main app with no focusCheckpoint / handedness.
 */

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
});
jest.mock('../../src/navigation/RootNavigator', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    RootNavigator: () => R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
  };
});
jest.mock('../../src/screens/OnboardingScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    OnboardingScreen: () => R.createElement(RN.Text, null, 'ONBOARDING'),
  };
});
jest.mock('../../src/screens/WelcomeScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../../src/screens/SignInScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return { SignInScreen: () => R.createElement(RN.Text, null, 'SIGN_IN') };
});
jest.mock('../../src/screens/SplashScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      R.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return null;
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
jest.mock('../../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

const CANONICAL_OWNER = '55555555-5555-4555-8555-555555555555';

interface MockAppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: Record<string, unknown> | null;
  hydrateError: string | null;
  hydrate: () => Promise<void>;
}
const mockUseAppStore = create<MockAppState>(() => ({
  hydrated: true,
  ownerKey: CANONICAL_OWNER,
  profile: null,
  hydrateError: null,
  hydrate: async () => {},
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: MockAppState) => unknown) =>
    mockUseAppStore(selector),
}));

interface MockAuthState {
  hydrated: boolean;
  session: { provider: 'apple'; canonicalAppUserId: string } | null;
  hydrate: () => Promise<void>;
  signOut: () => Promise<void>;
}
const mockSignOut = jest.fn(async () => {});
const mockUseAuthStore = create<MockAuthState>(() => ({
  hydrated: true,
  session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  hydrate: async () => {},
  signOut: () => mockSignOut(),
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

import App from '../../App';
import { Button } from '../../src/design/components';

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

const mounted: TestRenderer.ReactTestRenderer[] = [];
function renderApp() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<App />);
  });
  mounted.push(renderer);
  return renderer;
}
afterEach(() => {
  for (const renderer of mounted.splice(0)) act(() => renderer.unmount());
});

beforeEach(() => {
  mockSignOut.mockClear();
  mockUseAppStore.setState({
    hydrated: true,
    ownerKey: CANONICAL_OWNER,
    profile: null,
    hydrateError: null,
  });
});

describe('Gate hydrate-failure state', () => {
  it('offers a second exit (sign out) besides "Try again", so a permanent per-owner failure is not a dead end', () => {
    mockUseAppStore.setState({
      hydrateError:
        'Unexpected token \'o\', "not json at all" is not valid JSON',
    });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');

    const labels = renderer.root
      .findAllByType(Button)
      .map(node => String(node.props.label));
    expect(labels).toContain('Try again');
    expect(labels.some(label => /sign out/i.test(label))).toBe(true);
  });
});

describe('Gate profile presence check', () => {
  it('does not mount the main app on a profile that lacks the required fields', () => {
    mockUseAppStore.setState({ profile: {} });
    const renderer = renderApp();
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
  });
});
