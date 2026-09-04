import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3) — S6.
 *
 * The Gate calls `void hydrateApp()` from an effect and waits for the store
 * to flip `hydrated`. Two ways that call can misbehave are attacked with a
 * stand-in store (the real store's `hydrate` is an async function whose body
 * is wrapped in try/catch, so these are contract attacks on the Gate, not
 * reproductions against the real store — see launch-03 for the real-store
 * variant):
 *
 *   (a) hydrateApp throws SYNCHRONOUSLY before its first await
 *   (b) hydrateApp returns a promise that REJECTS without touching the store
 *
 * Also: the splash's own `ready` handshake when hydration fails.
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
const mockSplash = { mounted: false, readySeen: [] as boolean[] };
jest.mock('../../src/screens/SplashScreen', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const R = jest.requireActual<typeof import('react')>('react');
  return {
    SplashScreen: (props: { ready: boolean; onFinished: () => void }) => {
      mockSplash.readySeen.push(props.ready);
      R.useEffect(() => {
        mockSplash.mounted = true;
        return () => {
          mockSplash.mounted = false;
        };
      }, []);
      R.useEffect(() => {
        if (props.ready) props.onFinished();
      }, [props.ready, props.onFinished]);
      return R.createElement(RN.Text, null, 'SPLASH');
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
let mockHydrateImpl: () => Promise<void> = async () => {};
const mockHydrateCalls: number[] = [];
const mockUseAppStore = create<MockAppState>(() => ({
  hydrated: false,
  ownerKey: null,
  profile: null,
  hydrateError: null,
  hydrate: () => {
    mockHydrateCalls.push(Date.now());
    return mockHydrateImpl();
  },
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

import App from '../../App';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import { Button } from '../../src/design/components';

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join('\n');
}

function tryAgain(renderer: TestRenderer.ReactTestRenderer) {
  const buttons = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Try again');
  expect(buttons).toHaveLength(1);
  return buttons[0]!;
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
async function settle() {
  await act(async () => {});
  await act(async () => {});
}

let consoleError: jest.SpyInstance;
beforeEach(() => {
  mockHydrateCalls.length = 0;
  mockHydrateImpl = async () => {};
  mockSplash.mounted = false;
  mockSplash.readySeen = [];
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: CANONICAL_OWNER },
  });
  mockUseAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
  });
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  consoleError.mockRestore();
  for (const renderer of mounted.splice(0)) {
    act(() => renderer.unmount());
  }
});

describe('S6 (a) — hydrateApp throws synchronously before its first await', () => {
  it('OBSERVED: the throw escapes the Gate effect into RootErrorBoundary ("Something went wrong") — the splash is torn down, so no hang, but the state is the generic boundary rather than the typed hydrateError retry', () => {
    const recordSpy = jest.spyOn(stabilitySlo, 'record');
    mockHydrateImpl = () => {
      throw new Error('kv table missing (sync)');
    };
    const renderer = renderApp();
    const text = allText(renderer);
    expect(text).toContain('Something went wrong');
    expect(text).not.toContain('SPLASH');
    expect(text).not.toContain('Loading your account');
    expect(text).not.toContain('Your coaching profile couldn’t load');
    expect(mockSplash.mounted).toBe(false);
    expect(recordSpy).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'crash', fatal: false }),
    );
    expect(mockHydrateCalls).toHaveLength(1);
    recordSpy.mockRestore();
  });

  it('OBSERVED: boundary "Try again" remounts the Gate and re-runs hydrateApp; a persistent sync throw loops back into the boundary each time, a healed one reaches the app', async () => {
    let throws = 2;
    mockHydrateImpl = () => {
      if (throws > 0) {
        throws -= 1;
        throw new Error('kv table missing (sync)');
      }
      mockUseAppStore.setState({
        hydrated: true,
        ownerKey: CANONICAL_OWNER,
        profile: { skillLevel: '3.5' },
      });
      return Promise.resolve();
    };
    const renderer = renderApp();
    expect(allText(renderer)).toContain('Something went wrong');
    act(() => tryAgain(renderer).props.onPress());
    expect(allText(renderer)).toContain('Something went wrong');
    act(() => tryAgain(renderer).props.onPress());
    await settle();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(mockHydrateCalls).toHaveLength(3);
  });
});

describe('S6 (b) — hydrateApp returns a rejecting promise without touching the store', () => {
  it('FINDING (contract): `void hydrateApp()` drops the rejection — the Gate stays on the loading affordance forever (splash handshake never fires) with no retry control', async () => {
    let rejectionSeen = 0;
    mockHydrateImpl = () => {
      const rejected = Promise.reject(new Error('rejected before set()'));
      // Observe the rejection here so jest does not fail the test for the
      // unhandled rejection the Gate itself leaves behind.
      rejected.catch(() => {
        rejectionSeen += 1;
      });
      return rejected;
    };
    const renderer = renderApp();
    await settle();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 20));
    await settle();
    expect(rejectionSeen).toBe(1);

    const text = allText(renderer);
    expect(text).toContain('SPLASH');
    expect(text).toContain('Loading your account');
    expect(text).not.toContain('ROOT_NAVIGATOR');
    expect(text).not.toContain('Something went wrong');
    expect(text).not.toContain('Your coaching profile couldn’t load');
    expect(mockSplash.readySeen.every(ready => ready === false)).toBe(true);
    expect(
      renderer.root
        .findAllByType(Button)
        .filter(node => node.props.label === 'Try again'),
    ).toHaveLength(0);
    expect(mockHydrateCalls).toHaveLength(1);
  });
});

describe('splash handshake', () => {
  it('HELD: with hydrateError set by the store the splash sees ready=true and hands off to the typed retry state', async () => {
    mockHydrateImpl = async () => {
      mockUseAppStore.setState({
        hydrated: true,
        ownerKey: CANONICAL_OWNER,
        profile: null,
        hydrateError: 'typed copy',
      });
    };
    const renderer = renderApp();
    await settle();
    expect(allText(renderer)).not.toContain('SPLASH');
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(allText(renderer)).toContain('typed copy');
    expect(mockSplash.readySeen.at(-1)).toBe(true);
  });

  it("HELD: a hydrate that reports the WRONG owner key keeps the Gate on loading (never renders the previous owner's app) until the matching owner hydrates", async () => {
    mockHydrateImpl = async () => {
      mockUseAppStore.setState({
        hydrated: true,
        ownerKey: 'device-guest',
        profile: { skillLevel: '2.0' },
      });
    };
    const renderer = renderApp();
    await settle();
    expect(allText(renderer)).toContain('Loading your account');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    act(() => {
      mockUseAppStore.setState({ ownerKey: CANONICAL_OWNER });
    });
    await settle();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });
});
