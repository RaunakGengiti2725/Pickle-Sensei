import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { create } from 'zustand';
import type { Profile } from '../src/state/profile';
import type { AuthError } from '../src/auth/authStore';

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
});
const mockNavigatorMount = jest.fn();
const mockNavigatorUnmount = jest.fn();
const mockNavigate = jest.fn();
const mockCancelRecording = jest.fn();
jest.mock('../src/navigation/RootNavigator', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    RootNavigator: () => {
      const [route, setRoute] = R.useState('Home');
      const recording = R.useRef(false);
      R.useEffect(() => {
        mockNavigatorMount();
        return () => {
          mockNavigatorUnmount();
          if (recording.current) mockCancelRecording();
        };
      }, []);
      return R.createElement(
        RN.View,
        null,
        R.createElement(RN.Text, null, 'ROOT_NAVIGATOR'),
        R.createElement(RN.Text, null, `CURRENT_ROUTE:${route}`),
        R.createElement(
          RN.Pressable,
          {
            testID: 'start-recording',
            onPress: () => {
              mockNavigate('Recording');
              recording.current = true;
              setRoute('Recording');
            },
          },
          R.createElement(RN.Text, null, 'Record'),
        ),
      );
    },
  };
});
jest.mock('../src/screens/OnboardingScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    OnboardingScreen: () =>
      R.createElement(RN.Text, null, 'REQUIRED_ONBOARDING'),
  };
});
jest.mock('../src/screens/WelcomeScreen', () => {
  const R = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { WelcomeScreen: () => R.createElement(RN.Text, null, 'WELCOME') };
});
jest.mock('../src/screens/SignInScreen', () => ({ SignInScreen: () => null }));
jest.mock('../src/screens/SplashScreen', () => {
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
jest.mock('../src/components/RankUpCelebration', () => ({
  RankUpCelebration: () => null,
}));
jest.mock('../src/consistency/StreakCelebration', () => ({
  StreakCelebration: () => null,
}));
jest.mock('../src/walkthrough/FirstRunWalkthrough', () => ({
  FirstRunWalkthrough: () => null,
}));
jest.mock('../src/design/BrandNotice', () => ({ BrandNoticeHost: () => null }));
jest.mock('../src/walkthrough/walkthroughStore', () => {
  const state = { maybeShowFirstRun: async () => {} };
  return {
    useWalkthroughStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../src/notifications/useNotificationBootstrap', () => ({
  useNotificationBootstrap: () => {},
}));
jest.mock('../src/consistency/useConsistencyBootstrap', () => ({
  useConsistencyBootstrap: () => {},
}));

interface MockAuthState {
  hydrated: boolean;
  session: { provider: 'apple'; canonicalAppUserId: string } | null;
  error: AuthError | null;
  hydrate: () => Promise<void>;
  clearError: () => void;
}
const mockHydrateAuth = jest.fn<Promise<void>, []>(async () => {});
const mockUseAuthStore = create<MockAuthState>(set => ({
  hydrated: true,
  session: null,
  error: null,
  hydrate: () => mockHydrateAuth(),
  clearError: () => set({ error: null }),
}));
jest.mock('../src/auth/authStore', () => ({
  useAuthStore: (selector: (s: MockAuthState) => unknown) =>
    mockUseAuthStore(selector),
}));

const mockKv = new Map<string, string>();
const mockBeforeKvRead = jest.fn<Promise<void>, [string]>(async () => {});
jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        await mockBeforeKvRead(String(params[0]));
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    close() {},
  }),
}));
const mockFetchCanonical = jest.fn<Promise<Profile | null>, [unknown]>();
const mockSaveCanonical = jest.fn<Promise<Profile>, [unknown, Profile]>();
jest.mock('../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: (session: unknown) =>
    mockFetchCanonical(session),
  saveCanonicalOnboardingProfile: (session: unknown, profile: Profile) =>
    mockSaveCanonical(session, profile),
}));

import App from '../App';
import { Button } from '../src/design/components';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../src/state/appStore';

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';
const session = {
  apiBaseUrl: 'https://api.example.test',
  canonicalAppUserId: owner,
  bearerToken: 'restored-token',
  provider: 'apple' as const,
};
const serverProfile: Profile = {
  firstName: 'Returning player',
  skillLevel: '4.0',
  handedness: 'left',
  goal: 'drives',
  biggestProblem: 'contact',
  focusCheckpoint: 'preparation',
};
const answers: Profile = {
  ...serverProfile,
  firstName: 'New answers',
  handedness: 'right',
  goal: 'drops',
};
const hydrateApp = useAppStore.getState().hydrate;
const mockHydrateApp = jest.fn((...args: Parameters<typeof hydrateApp>) =>
  hydrateApp(...args),
);
let mounted: TestRenderer.ReactTestRenderer | null = null;

function allText(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .join('\n');
}

async function launch() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<App />);
  });
  mounted = renderer;
  return renderer;
}

beforeEach(() => {
  mockKv.clear();
  mockBeforeKvRead.mockReset().mockResolvedValue(undefined);
  mockNavigatorMount.mockClear();
  mockNavigatorUnmount.mockClear();
  mockNavigate.mockClear();
  mockCancelRecording.mockClear();
  clearApiSession();
  setActiveDataOwner(owner);
  mockHydrateAuth.mockReset().mockResolvedValue(undefined);
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: owner },
    error: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    hydrate: mockHydrateApp,
  });
  mockHydrateApp.mockClear();
  mockFetchCanonical.mockReset().mockResolvedValue(serverProfile);
  mockSaveCanonical
    .mockReset()
    .mockImplementation(async (_session, profile) => profile);
});

afterEach(() => {
  if (mounted) act(() => mounted?.unmount());
  mounted = null;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('Gate recovery for vault-restored canonical owners', () => {
  it('automatically loads the missing profile once the same owner first gets an API session, not on rotations', async () => {
    const renderer = await launch();
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(allText(renderer)).toContain(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');
    expect(mockHydrateApp).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonical).not.toHaveBeenCalled();

    await act(async () => establishApiSession(session));
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().profile).toEqual(serverProfile);

    await act(async () =>
      establishApiSession({ ...session, bearerToken: 'rotated-token' }),
    );
    await act(async () =>
      establishApiSession({ ...session, bearerToken: 'rotated-again' }),
    );
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('keeps a cached offline profile and pending answers until the matching bearer can save them', async () => {
    mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
    const pending = JSON.stringify({ version: 1, profile: answers });
    mockKv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, pending);
    const renderer = await launch();
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(pending);
    expect(mockSaveCanonical).not.toHaveBeenCalled();

    await act(async () => establishApiSession(session));
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
    expect(mockSaveCanonical).toHaveBeenCalledWith(session, answers);
    expect(useAppStore.getState().profile).toEqual(answers);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    await act(async () =>
      establishApiSession({ ...session, bearerToken: 'rotated-token' }),
    );
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed late fetch retryable without sending the returning player into onboarding', async () => {
    const renderer = await launch();
    mockFetchCanonical.mockRejectedValueOnce(
      new Error('network still offline'),
    );
    await act(async () => establishApiSession(session));
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('Your coaching profile couldn’t load');
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');

    await act(async () =>
      establishApiSession({ ...session, bearerToken: 'rotated-token' }),
    );
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    const retry = renderer.root
      .findAllByType(Button)
      .find(node => node.props.label === 'Try again');
    expect(retry).toBeDefined();
    await act(async () => retry!.props.onPress());
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(mockHydrateApp).toHaveBeenCalledTimes(3);
    expect(mockFetchCanonical).toHaveBeenCalledTimes(2);
  });

  it('still requires account onboarding after the reachable server confirms the profile is absent', async () => {
    mockFetchCanonical.mockResolvedValue(null);
    const renderer = await launch();
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');
    await act(async () => establishApiSession(session));
    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('REQUIRED_ONBOARDING');
    expect(allText(renderer)).not.toContain(
      'Your coaching profile couldn’t load',
    );
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('ignores another owner’s API presence and waits for the restored account', async () => {
    const renderer = await launch();
    await act(async () =>
      establishApiSession({ ...session, canonicalAppUserId: otherOwner }),
    );
    expect(mockHydrateApp).toHaveBeenCalledTimes(1);
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');

    await act(async () => establishApiSession(session));
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expect(mockFetchCanonical).toHaveBeenCalledWith(session);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });
});

const persistenceError: AuthError = {
  code: 'auth.persistence_failed',
  message: 'Secure sign-in storage is temporarily unavailable.',
};
const secureSignInTitle = 'Secure sign-in is unavailable';

function coldPersistenceFailure() {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockUseAuthStore.setState({
    hydrated: true,
    session: null,
    error: persistenceError,
  });
}

function restoreSession(online = true) {
  setActiveDataOwner(owner);
  if (online) establishApiSession(session);
  mockUseAuthStore.setState({
    hydrated: true,
    session: { provider: 'apple', canonicalAppUserId: owner },
  });
}

function secureRetry(renderer: TestRenderer.ReactTestRenderer): () => void {
  const buttons = renderer.root
    .findAllByType(Button)
    .filter(node => node.props.label === 'Retry');
  expect(buttons).toHaveLength(1);
  return buttons[0]!.props.onPress;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(accept => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe('Gate secure sign-in storage recovery', () => {
  it('shows an honest storage error rather than Welcome after a cold persistence failure', async () => {
    coldPersistenceFailure();
    const pending = JSON.stringify({ version: 1, profile: answers });
    mockKv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, pending);

    const renderer = await launch();

    expect(allText(renderer)).toContain(secureSignInTitle);
    expect(allText(renderer)).toContain(
      'secure sign-in storage on this device',
    );
    expect(allText(renderer)).not.toContain('WELCOME');
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).not.toMatch(/nothing.*removed/i);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(pending);
    expect(useAppStore.getState().profile).toBeNull();
    expect(mockFetchCanonical).not.toHaveBeenCalled();
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
    secureRetry(renderer);
  });

  it.each(['online', 'cached-offline'] as const)(
    'shows pending retry feedback, guards double taps and restores the %s account',
    async mode => {
      coldPersistenceFailure();
      if (mode === 'cached-offline') {
        mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
      }
      const renderer = await launch();
      const pending = deferred();
      mockHydrateAuth.mockImplementationOnce(async () => {
        await pending.promise;
        restoreSession(mode === 'online');
      });
      const retry = secureRetry(renderer);

      await act(async () => {
        retry();
        retry();
      });

      expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain('Checking secure sign-in');
      expect(allText(renderer)).not.toContain(secureSignInTitle);
      expect(allText(renderer)).not.toContain('WELCOME');
      expect(allText(renderer)).not.toContain('Retry');
      expect(mockUseAuthStore.getState().error).toBeNull();
      expect(mockHydrateApp).toHaveBeenCalledTimes(1);

      await act(async () => pending.resolve());

      expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
      expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
      expect(allText(renderer)).not.toContain('Checking secure sign-in');
      expect(allText(renderer)).not.toContain(secureSignInTitle);
      expect(useAppStore.getState().profile).toEqual(serverProfile);
      expect(mockFetchCanonical).toHaveBeenCalledTimes(
        mode === 'online' ? 1 : 0,
      );
    },
  );

  it('returns to the recoverable error after another storage failure and permits a later retry', async () => {
    coldPersistenceFailure();
    const renderer = await launch();
    const pending = deferred();
    mockHydrateAuth.mockImplementationOnce(async () => {
      await pending.promise;
      mockUseAuthStore.setState({ error: persistenceError });
    });

    await act(async () => secureRetry(renderer)());
    expect(allText(renderer)).toContain('Checking secure sign-in');
    await act(async () => pending.resolve());

    expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain(secureSignInTitle);
    expect(allText(renderer)).not.toContain('WELCOME');
    expect(allText(renderer)).not.toContain('Checking secure sign-in');

    mockHydrateAuth.mockImplementationOnce(async () => restoreSession());
    await act(async () => secureRetry(renderer)());
    expect(mockHydrateAuth).toHaveBeenCalledTimes(3);
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('keeps an unexpectedly rejected retry recoverable instead of leaving a spinner or showing Welcome', async () => {
    coldPersistenceFailure();
    const renderer = await launch();
    mockHydrateAuth.mockRejectedValueOnce(new Error('secure read interrupted'));

    await act(async () => secureRetry(renderer)());

    expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain(secureSignInTitle);
    expect(allText(renderer)).not.toContain('Checking secure sign-in');
    expect(allText(renderer)).not.toContain('WELCOME');
    mockHydrateAuth.mockImplementationOnce(async () => restoreSession());
    await act(async () => secureRetry(renderer)());
    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
  });

  it('returns to normal Welcome when retry successfully reads an empty sign-in store', async () => {
    coldPersistenceFailure();
    const renderer = await launch();
    const pending = deferred();
    mockHydrateAuth.mockReturnValueOnce(pending.promise);

    await act(async () => secureRetry(renderer)());
    expect(allText(renderer)).not.toContain('WELCOME');
    await act(async () => pending.resolve());

    expect(mockHydrateAuth).toHaveBeenCalledTimes(2);
    expect(mockUseAuthStore.getState().session).toBeNull();
    expect(mockUseAuthStore.getState().error).toBeNull();
    expect(allText(renderer)).toContain('WELCOME');
    expect(allText(renderer)).not.toContain(secureSignInTitle);
    expect(allText(renderer)).not.toContain('REQUIRED_ONBOARDING');
  });

  it('still requires onboarding when retry restores an account with no server profile', async () => {
    coldPersistenceFailure();
    const renderer = await launch();
    mockFetchCanonical.mockResolvedValue(null);
    mockHydrateAuth.mockImplementationOnce(async () => restoreSession());

    await act(async () => secureRetry(renderer)());

    expect(mockFetchCanonical).toHaveBeenCalledTimes(1);
    expect(allText(renderer)).toContain('REQUIRED_ONBOARDING');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).not.toContain(secureSignInTitle);
  });

  it.each([
    null,
    'auth.failed',
    'auth.canceled',
    'auth.session_expired',
  ] as const)(
    'does not replace normal Welcome for auth error %s',
    async code => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      mockUseAuthStore.setState({
        session: null,
        error: code ? { code, message: 'Sign-in issue' } : null,
      });
      const renderer = await launch();

      expect(allText(renderer)).toContain('WELCOME');
      expect(allText(renderer)).not.toContain(secureSignInTitle);
      expect(mockHydrateAuth).toHaveBeenCalledTimes(1);
    },
  );

  it('does not block a known account with a cached offline profile on a persistence warning', async () => {
    mockUseAuthStore.setState({ error: persistenceError });
    mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));

    const renderer = await launch();

    expect(allText(renderer)).toContain('ROOT_NAVIGATOR');
    expect(allText(renderer)).not.toContain(secureSignInTitle);
    expect(useAppStore.getState().profile).toEqual(serverProfile);
    expect(mockFetchCanonical).not.toHaveBeenCalled();
  });
});

function startRecording(renderer: TestRenderer.ReactTestRenderer) {
  const button = renderer.root.findAll(
    node =>
      node.props.testID === 'start-recording' &&
      typeof node.props.onPress === 'function',
  )[0];
  expect(button).toBeDefined();
  act(() => {
    button!.props.onPress();
    useAppStore.getState().setLastShotType('volley');
  });
}

function expectRecordingIntact(renderer: TestRenderer.ReactTestRenderer) {
  expect(allText(renderer)).toContain('CURRENT_ROUTE:Recording');
  expect(mockNavigatorMount).toHaveBeenCalledTimes(1);
  expect(mockNavigatorUnmount).not.toHaveBeenCalled();
  expect(mockCancelRecording).not.toHaveBeenCalled();
  expect(mockNavigate.mock.calls).toEqual([['Recording']]);
  expect(useAppStore.getState()).toMatchObject({
    hydrated: true,
    ownerKey: owner,
    lastShotType: 'volley',
    hydrateError: null,
  });
}

describe('late API availability preserves the running cached-owner navigator', () => {
  it('keeps the navigator mounted, its route and recording active, and the cached profile reference unchanged', async () => {
    mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
    const renderer = await launch();
    startRecording(renderer);
    const cachedProfile = useAppStore.getState().profile;
    const reading = deferred();
    mockBeforeKvRead.mockImplementationOnce(() => reading.promise);

    await act(async () => establishApiSession(session));
    try {
      expectRecordingIntact(renderer);
      expect(useAppStore.getState().profile).toBe(cachedProfile);
      expect(mockFetchCanonical).not.toHaveBeenCalled();
    } finally {
      await act(async () => reading.resolve());
    }

    expectRecordingIntact(renderer);
    expect(useAppStore.getState().profile).toBe(cachedProfile);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    await act(async () =>
      establishApiSession({ ...session, bearerToken: 'rotated-token' }),
    );
    expect(mockHydrateApp).toHaveBeenCalledTimes(2);
    expectRecordingIntact(renderer);
  });

  it.each(['saved', 'failed'] as const)(
    'adopts pending answers without unmounting the navigator when the canonical save is %s',
    async outcome => {
      mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
      const stash = JSON.stringify({ version: 1, profile: answers });
      mockKv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, stash);
      const renderer = await launch();
      startRecording(renderer);
      const cachedProfile = useAppStore.getState().profile;
      const saving = deferred();
      const adopted: Profile = { ...answers, focusCheckpoint: 'sequencing' };
      mockSaveCanonical.mockImplementationOnce(async () => {
        await saving.promise;
        if (outcome === 'failed') throw new Error('connection interrupted');
        return adopted;
      });

      await act(async () => establishApiSession(session));
      try {
        expectRecordingIntact(renderer);
        expect(useAppStore.getState().profile).toBe(cachedProfile);
        expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(stash);
        expect(mockSaveCanonical).toHaveBeenCalledWith(session, answers);
        await act(async () =>
          establishApiSession({ ...session, bearerToken: 'rotated-token' }),
        );
        expect(mockHydrateApp).toHaveBeenCalledTimes(2);
      } finally {
        await act(async () => saving.resolve());
      }

      expectRecordingIntact(renderer);
      expect(mockSaveCanonical).toHaveBeenCalledTimes(1);
      expect(mockFetchCanonical).not.toHaveBeenCalled();
      if (outcome === 'saved') {
        expect(useAppStore.getState().profile).toEqual(adopted);
        expect(JSON.parse(mockKv.get(`profile:${owner}`)!)).toEqual(adopted);
        expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe('');
      } else {
        expect(useAppStore.getState().profile).toBe(cachedProfile);
        expect(JSON.parse(mockKv.get(`profile:${owner}`)!)).toEqual(
          serverProfile,
        );
        expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(stash);
      }
    },
  );

  it('retains the cached profile, recording and pending answers if the background local read fails', async () => {
    mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
    const stash = JSON.stringify({ version: 1, profile: answers });
    mockKv.set(PENDING_ONBOARDING_PROFILE_KV_KEY, stash);
    const renderer = await launch();
    startRecording(renderer);
    const cachedProfile = useAppStore.getState().profile;
    mockBeforeKvRead.mockRejectedValueOnce(new Error('local read unavailable'));

    await act(async () => establishApiSession(session));

    expectRecordingIntact(renderer);
    expect(useAppStore.getState().profile).toBe(cachedProfile);
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(stash);
    expect(mockSaveCanonical).not.toHaveBeenCalled();
  });

  it('still clears immediately on a real owner change and ignores the older background hydrate', async () => {
    mockKv.set(`profile:${owner}`, JSON.stringify(serverProfile));
    const renderer = await launch();
    startRecording(renderer);
    const readingOldOwner = deferred();
    const loadingNewOwner = deferred();
    mockBeforeKvRead.mockImplementationOnce(() => readingOldOwner.promise);
    await act(async () => establishApiSession(session));
    const otherProfile = { ...serverProfile, firstName: 'Other player' };
    mockFetchCanonical.mockImplementationOnce(async () => {
      await loadingNewOwner.promise;
      return otherProfile;
    });

    try {
      await act(async () => {
        setActiveDataOwner(otherOwner);
        establishApiSession({ ...session, canonicalAppUserId: otherOwner });
        mockUseAuthStore.setState({
          session: { provider: 'apple', canonicalAppUserId: otherOwner },
        });
      });
      expect(allText(renderer)).toContain('Loading your account');
      expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
      expect(useAppStore.getState()).toMatchObject({
        ownerKey: otherOwner,
        hydrated: false,
        profile: null,
      });
      expect(mockNavigatorUnmount).toHaveBeenCalledTimes(1);
      expect(mockCancelRecording).toHaveBeenCalledTimes(1);

      await act(async () => readingOldOwner.resolve());
      expect(useAppStore.getState()).toMatchObject({
        ownerKey: otherOwner,
        hydrated: false,
        profile: null,
      });
    } finally {
      await act(async () => {
        readingOldOwner.resolve();
        loadingNewOwner.resolve();
      });
    }

    expect(mockNavigatorMount).toHaveBeenCalledTimes(2);
    expect(allText(renderer)).toContain('CURRENT_ROUTE:Home');
    expect(useAppStore.getState()).toMatchObject({
      ownerKey: otherOwner,
      hydrated: true,
      profile: otherProfile,
      lastShotType: 'forehand_drive',
    });
  });
});
