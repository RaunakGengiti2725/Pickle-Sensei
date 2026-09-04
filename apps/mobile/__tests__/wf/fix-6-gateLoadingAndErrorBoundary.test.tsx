import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';

/**
 * App.tsx Gate: after the launch splash is gone, every owner change
 * re-hydrates — that window must paint a real loading affordance, a failed
 * canonical hydrate must offer retry instead of re-asking the questionnaire,
 * and a render throw anywhere below the root must land on a recoverable
 * error state rather than a dead app.
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
  profile: { skillLevel: string } | null;
  hydrateError: string | null;
  preAuthOnboarded: boolean;
  hydrate: () => Promise<void>;
}
const mockHydrateApp = jest.fn<Promise<void>, []>(async () => {});
const mockUseAppStore = create<MockAppState>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  preAuthOnboarded: true,
  hydrate: () => mockHydrateApp(),
}));
jest.mock('../../src/state/appStore', () => ({
  useAppStore: (selector: (s: MockAppState) => unknown) =>
    mockUseAppStore(selector),
}));

interface MockAuthState {
  hydrated: boolean;
  session: {
    provider: 'apple' | 'google' | 'guest';
    canonicalAppUserId?: string;
  } | null;
  hydrate: () => Promise<void>;
}
const mockUseAuthStore = create<MockAuthState>(() => ({
  hydrated: true,
  session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  hydrate: async () => {},
}));
jest.mock('../../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

import App, { RootErrorBoundary } from '../../App';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { Button } from '../../src/design/components';

function tryAgain(renderer: TestRenderer.ReactTestRenderer) {
  const buttons = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Try again');
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

/** Mounts the app and lets the Gate's own auth hydrate settle. */
async function renderApp() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  mounted.push(renderer);
  return renderer;
}

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
});

beforeEach(() => {
  mockHydrateApp.mockClear();
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  });
  mockUseAppStore.setState({
    hydrated: true,
    ownerKey: CANONICAL_OWNER,
    profile: { skillLevel: '3.5' },
    hydrateError: null,
  });
});

describe('Gate loading affordance after the splash', () => {
  it('paints a loading state (never a bare surface) while a signed-in owner re-hydrates', async () => {
    const renderer = await renderApp();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');

    act(() => {
      mockUseAppStore.setState({
        hydrated: false,
        profile: null,
        ownerKey: CANONICAL_OWNER,
      });
    });
    const text = allText(renderer);
    expect(text).not.toContain('ROOT_NAVIGATOR');
    expect(text).toContain('Loading your account');
    expect(text).toContain('Keep Pickle Sensei open.');

    act(() => {
      mockUseAppStore.setState({
        hydrated: true,
        profile: { skillLevel: '3.5' },
      });
    });
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('paints a loading state while the signed-out owner re-hydrates after sign-out', async () => {
    const renderer = await renderApp();
    act(() => {
      mockUseAuthStore.setState({ session: null });
      mockUseAppStore.setState({
        hydrated: false,
        profile: null,
        ownerKey: 'signed-out',
      });
    });
    expect(allText(renderer)).toContain('Getting things ready');

    act(() => {
      mockUseAppStore.setState({ hydrated: true });
    });
    expect(allText(renderer)).toContain('WELCOME');
  });
});

describe('Gate hydrate failure', () => {
  it('shows a retry state instead of the account questionnaire, and retry re-runs hydrate', async () => {
    const renderer = await renderApp();
    act(() => {
      mockUseAppStore.setState({
        hydrated: true,
        profile: null,
        hydrateError: 'Could not reach your account.',
      });
    });
    const text = allText(renderer);
    expect(text).not.toContain('ONBOARDING');
    expect(text).toContain('Your coaching profile couldn’t load');
    expect(text).toContain('Could not reach your account.');

    const callsBeforeRetry = mockHydrateApp.mock.calls.length;
    act(() => {
      tryAgain(renderer).props.onPress();
    });
    expect(mockHydrateApp).toHaveBeenCalledTimes(callsBeforeRetry + 1);
  });

  it('still offers the in-account questionnaire when there is no profile and no error', async () => {
    const renderer = await renderApp();
    act(() => {
      mockUseAppStore.setState({ hydrated: true, profile: null });
    });
    expect(allText(renderer)).toContain('ONBOARDING');
  });
});

describe('RootErrorBoundary', () => {
  let explode = true;
  function Bomb() {
    if (explode) throw new Error('render exploded');
    return <Text>ALIVE</Text>;
  }

  it('catches a render throw, records a non-fatal crash, and recovers on retry', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    stabilitySlo.reset();
    explode = true;
    let renderer!: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <RootErrorBoundary>
          <Bomb />
        </RootErrorBoundary>,
      );
    });
    const text = allText(renderer);
    expect(text).toContain('Something went wrong');
    expect(text).toContain('Try again');

    const crashes = stabilitySlo
      .events()
      .filter(event => event.kind === 'crash');
    expect(crashes).toHaveLength(1);
    expect(crashes[0]).toMatchObject({ kind: 'crash', fatal: false });
    expect((crashes[0] as { fingerprint: string }).fingerprint).toMatch(
      /^[0-9a-f]{8}$/,
    );

    explode = false;
    act(() => {
      tryAgain(renderer).props.onPress();
    });
    expect(allText(renderer)).toContain('ALIVE');
    consoleError.mockRestore();
  });

  it('wraps the Gate so a throwing screen degrades to the error state', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const renderer = await renderApp();
    const rootNavigator = jest.requireMock<{
      RootNavigator: () => React.ReactElement;
    }>('../../src/navigation/RootNavigator');
    const original = rootNavigator.RootNavigator;
    rootNavigator.RootNavigator = () => {
      throw new Error('screen exploded');
    };
    try {
      act(() => {
        mockUseAppStore.setState({ profile: { skillLevel: '4.0' } });
      });
      expect(allText(renderer)).toContain('Something went wrong');
    } finally {
      rootNavigator.RootNavigator = original;
      consoleError.mockRestore();
    }
  });
});
