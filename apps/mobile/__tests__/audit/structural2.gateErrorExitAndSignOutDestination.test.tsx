import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';

/**
 * Structural audit #2 — App.tsx Gate:
 *  (1) a signed-in account whose profile cannot load (hydrateError) must have
 *      an exit other than "Try again" — otherwise a permanently corrupt local
 *      row (appStore.ts JSON.parse) strands the account with no sign-out;
 *  (2) OnboardingScreen's in-account leave dialog promises "You will be
 *      returned to the sign-in screen" — on a cold launch the Gate's
 *      preAuthStage is still 'welcome', so sign-out must land on SignIn for
 *      that copy to be true.
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
    OnboardingScreen: (props: { mode?: string }) =>
      R.createElement(RN.Text, null, `ONBOARDING:${props.mode ?? 'account'}`),
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

const CANONICAL_OWNER = '77777777-7777-4777-8777-777777777777';

interface MockAppState {
  hydrated: boolean;
  ownerKey: string | null;
  profile: { skillLevel: string } | null;
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
const mockUseAuthStore = create<MockAuthState>(() => ({
  hydrated: true,
  session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  hydrate: async () => {},
  signOut: async () => {},
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

import App from '../../App';

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

function pressableLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.props?.onPress === 'function')
    .map(node =>
      String(
        node.props.label ??
          node.props.accessibilityLabel ??
          node.props.testID ??
          '',
      ),
    )
    .filter(Boolean);
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
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  });
  mockUseAppStore.setState({
    hydrated: true,
    ownerKey: CANONICAL_OWNER,
    profile: null,
    hydrateError: null,
  });
});

describe('Gate — signed-in profile-load failure', () => {
  it('offers an exit besides Try again (sign out) so a permanent local failure cannot strand the account', () => {
    mockUseAppStore.setState({
      hydrateError: "Expected property name or '}' in JSON at position 1",
    });
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    const labels = pressableLabels(renderer);
    expect(labels).toContain('Try again');
    expect(labels.some(label => /sign out/i.test(label))).toBe(true);
  });
});

describe('Gate — sign-out destination from the in-account questionnaire', () => {
  it('cold launch → account questionnaire → sign out lands on the sign-in screen, as the leave dialog states', () => {
    const renderer = renderApp();
    expect(allText(renderer)).toContain('ONBOARDING:account');

    // authStore.signOut(): owner → signed-out, session → null; appStore
    // re-hydrates for the signed-out owner.
    act(() => {
      mockUseAuthStore.setState({ session: null });
      mockUseAppStore.setState({
        hydrated: true,
        ownerKey: 'signed-out',
        profile: null,
      });
    });
    const text = allText(renderer);
    expect(text).not.toContain('ONBOARDING');
    expect(text).toContain('SIGN_IN');
  });
});
