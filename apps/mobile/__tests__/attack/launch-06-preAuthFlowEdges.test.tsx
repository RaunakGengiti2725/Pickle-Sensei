import React from 'react';
import { AppState, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS (mobile-launch-onboarding, tester #2, pass 3) — extras
 * on the REAL App / Gate / Welcome / Onboarding path (real appStore and
 * notificationStore over a map-backed kv):
 *
 *   - permission denial / thrown permission prompt on "Turn on reminders"
 *   - stash write failure on the final step (disk full)
 *   - rapid double-tap on "Not now"
 *   - sign-out while the first canonical GET is still in flight
 *   - background → foreground while in the retry state
 *   - unicode / whitespace / over-long first names through the real input
 *
 * Clock skew: nothing in the scope paths reads Date.now()/Date (VERIFIED by
 * grep at 4d812e1a), so there is no skew-sensitive branch to attack here.
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
const mockKvWrites: Array<{ key: string; value: string }> = [];
let mockSetKvFault: (key: string, value: string) => Error | null = () => null;
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        const key = String(params[0]);
        const value = String(params[1]);
        const fault = mockSetKvFault(key, value);
        if (fault) throw fault;
        mockKvWrites.push({ key, value });
        mockKv.set(key, value);
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

interface MockSession {
  provider: 'guest' | 'apple';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
}
interface MockAuthState {
  hydrated: boolean;
  session: MockSession | null;
  hydrate: () => Promise<void>;
  continueAsGuest: () => Promise<void>;
  signInCanonical: (id: string) => Promise<void>;
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
    continueAsGuest: async () => {
      scope.setActiveDataOwner(scope.GUEST_DATA_OWNER);
      set({
        session: {
          provider: 'guest',
          subject: 'local-only',
          canonicalAppUserId: null,
          localOnly: true,
          displayName: null,
          email: null,
        },
      });
    },
    signInCanonical: async id => {
      scope.setActiveDataOwner(scope.canonicalDataOwner(id));
      set({
        session: {
          provider: 'apple',
          subject: 'apple-subject',
          canonicalAppUserId: id,
          localOnly: false,
          displayName: null,
          email: null,
        },
      });
    },
    signOut: async () => {
      scope.setActiveDataOwner(scope.SIGNED_OUT_DATA_OWNER);
      set({ session: null });
    },
  }));
  return { useAuthStore };
});

let mockApiSession: {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple';
} | null = null;
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockApiSession,
}));

let mockRequestPermission: () => Promise<
  'granted' | 'denied' | 'undetermined'
> = async () => 'granted';
const mockApplyPlan = jest.fn(async () => {});
const mockCancelAll = jest.fn(async () => {});
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => ({
    async permissionState() {
      return 'undetermined';
    },
    requestPermission: () => mockRequestPermission(),
    applyPlan: (...args: unknown[]) => mockApplyPlan(...(args as [])),
    cancelAllPlanned: () => mockCancelAll(),
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
  const { Pressable, Text, View } = require('react-native');
  const { useAuthStore } = jest.requireMock<{
    useAuthStore: {
      getState: () => {
        continueAsGuest: () => Promise<void>;
        signInCanonical: (id: string) => Promise<void>;
      };
    };
  }>('../../src/auth/authStore');
  return {
    SignInScreen: () =>
      React.createElement(
        View,
        null,
        React.createElement(Text, null, 'SIGN_IN_SCREEN'),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Continue as guest',
            onPress: () => void useAuthStore.getState().continueAsGuest(),
          },
          React.createElement(Text, null, 'Continue as guest'),
        ),
        React.createElement(
          Pressable,
          {
            accessibilityLabel: 'Sign in with Apple',
            onPress: () =>
              void useAuthStore
                .getState()
                .signInCanonical('66666666-6666-4666-8666-666666666666'),
          },
          React.createElement(Text, null, 'Sign in with Apple'),
        ),
      ),
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
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { DEFAULT_NOTIFICATION_PREFS } from '../../src/notifications/types';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';

type Renderer = TestRenderer.ReactTestRenderer;

const CANONICAL_ID = '66666666-6666-4666-8666-666666666666';
const API = 'https://api.example.test';

interface Call {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}
const calls: Call[] = [];
type Responder = (call: Call) => Promise<Response>;
let responder: Responder = async () => json({}, 500);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      authorization: headers['Authorization'],
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return responder(call);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

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

function press(renderer: Renderer, label: string) {
  const nodes = pressables(renderer, label);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.props.disabled).toBeFalsy();
  act(() => {
    nodes[0]!.props.onPress();
  });
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
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
function unmount() {
  const renderer = mounted;
  mounted = null;
  if (renderer) act(() => renderer.unmount());
}
async function pressAsync(renderer: Renderer, label: string) {
  press(renderer, label);
  await settle();
}

function typeName(renderer: Renderer, value: string) {
  act(() => renderer.root.findByType(TextInput).props.onChangeText(value));
}

async function answerFrom(renderer: Renderer, name: string) {
  typeName(renderer, name);
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Female');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, '3.5');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Right-handed');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Third-shot drops');
  await pressAsync(renderer, 'Continue');
  await pressAsync(renderer, 'Control');
  await pressAsync(renderer, 'Continue');
  expect(allText(renderer)).toContain('YOUR STARTING PLAN');
  await pressAsync(renderer, 'Continue');
  expect(allText(renderer)).toContain('Stay match-ready.');
}

async function reachNotificationStep(name = ' Dana '): Promise<Renderer> {
  const renderer = await launch();
  await pressAsync(renderer, 'Start your first read');
  await answerFrom(renderer, name);
  return renderer;
}

function stash(): { version: number; profile: Record<string, unknown> } {
  return JSON.parse(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)!);
}

beforeEach(() => {
  mockKv.clear();
  mockKvWrites.length = 0;
  mockSetKvFault = () => null;
  calls.length = 0;
  responder = async () => json({}, 500);
  mockApiSession = null;
  mockRequestPermission = async () => 'granted';
  mockApplyPlan.mockClear();
  mockCancelAll.mockClear();
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
  unmount();
});

describe('permission denial on the notification step', () => {
  it('HELD: "Turn on reminders" with the OS prompt DENIED still finishes the questionnaire, stashes the profile and reaches sign-in; the pending notification choice records enabled=false', async () => {
    mockRequestPermission = async () => 'denied';
    const renderer = await reachNotificationStep();
    await pressAsync(renderer, 'Turn on reminders');
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(stash().profile['firstName']).toBe('Dana');
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(
      JSON.parse(mockKv.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) ?? 'null'),
    ).toEqual({ version: 1, enabled: false });
    expect(mockApplyPlan).not.toHaveBeenCalled();
  });

  it('HELD: the OS permission prompt THROWING (e.g. UNUserNotificationCenter unavailable) is swallowed — sign-in is still reached with the stash written', async () => {
    mockRequestPermission = async () => {
      throw new Error('UNUserNotificationCenter unavailable');
    };
    const renderer = await reachNotificationStep();
    await pressAsync(renderer, 'Turn on reminders');
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('Something went wrong');
    expect(stash().profile['firstName']).toBe('Dana');
    expect(useNotificationStore.getState().permission).toBe('unknown');
  });
});

describe('stash write failure on the final step', () => {
  it('FINDING (P3 copy) + HELD (recovery): disk-full on the stash write keeps the player on the step with a re-enabled control and retry succeeds — but the RAW SQLite message is rendered as the error copy', async () => {
    const renderer = await reachNotificationStep();
    mockSetKvFault = (key, value) =>
      key === PENDING_ONBOARDING_PROFILE_KV_KEY && value !== ''
        ? new Error('database or disk is full (13)')
        : null;
    await pressAsync(renderer, 'Not now');
    await settle();
    const text = allText(renderer);
    expect(text).toContain('Stay match-ready.');
    expect(text).not.toContain('SIGN_IN_SCREEN');
    expect(useAppStore.getState().onboardingBusy).toBe(false);
    expect(useAppStore.getState().onboardingError).toBeTruthy();
    expect(text).toContain(useAppStore.getState().onboardingError!);
    // Observed: appStore.completePreAuthOnboarding surfaces error.message
    // verbatim, so the driver text reaches the screen.
    expect(text).toContain('database or disk is full (13)');
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeUndefined();
    expect(pressables(renderer, 'Not now')[0]!.props.disabled).toBeFalsy();

    mockSetKvFault = () => null;
    await pressAsync(renderer, 'Not now');
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(stash().profile['firstName']).toBe('Dana');
  });
});

describe('rapid repeats', () => {
  it('OBSERVED: a same-tick double-tap on "Not now" runs finishOnboarding twice (the busy guard is a stale closure) — two identical stash writes, but the flow still lands once on sign-in', async () => {
    const renderer = await reachNotificationStep();
    const notNow = pressables(renderer, 'Not now')[0]!;
    await act(async () => {
      notNow.props.onPress();
      notNow.props.onPress();
    });
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    const stashWrites = mockKvWrites.filter(
      w => w.key === PENDING_ONBOARDING_PROFILE_KV_KEY,
    );
    expect(stashWrites.length).toBeGreaterThanOrEqual(1);
    expect(new Set(stashWrites.map(w => w.value)).size).toBe(1);
    expect(stash().profile['firstName']).toBe('Dana');
    // Record the concrete count for the report.
    expect(stashWrites.length).toBe(2);
  });

  it('HELD: hammering "Continue" on the reveal step cannot skip past the notification step', async () => {
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    typeName(renderer, 'Dana');
    for (const label of [
      'Continue',
      'Female',
      'Continue',
      '3.5',
      'Continue',
      'Right-handed',
      'Continue',
      'Third-shot drops',
      'Continue',
      'Control',
      'Continue',
    ]) {
      await pressAsync(renderer, label);
    }
    expect(allText(renderer)).toContain('YOUR STARTING PLAN');
    const cont = pressables(renderer, 'Continue')[0]!;
    await act(async () => {
      for (let i = 0; i < 5; i += 1) cont.props.onPress();
    });
    await settle();
    expect(allText(renderer)).toContain('Stay match-ready.');
    expect(allText(renderer)).not.toContain('SIGN_IN_SCREEN');
    expect(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)).toBeUndefined();
  });
});

describe('cancellation mid-flight', () => {
  it('HELD: signing out while the first canonical GET is in flight — the late response never adopts the stash for the signed-out owner and the Gate stays on the pre-auth screen', async () => {
    const renderer = await reachNotificationStep();
    await pressAsync(renderer, 'Not now');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

    let releaseGet!: () => void;
    const gate = new Promise<void>(resolve => {
      releaseGet = resolve;
    });
    mockApiSession = {
      apiBaseUrl: API,
      bearerToken: 'bearer-1',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    };
    responder = async call => {
      if (call.method === 'GET') {
        await gate;
        return json({ onboardingState: 'pending', profile: null });
      }
      return json({ recommendedCheckpoint: 'preparation', profile: {} });
    };

    await pressAsync(renderer, 'Sign in with Apple');
    expect(allText(renderer)).toContain('Loading your account');
    expect(calls).toHaveLength(1);

    // Sign out before the GET resolves.
    mockApiSession = null;
    await act(async () => {
      await useAuthStore.getState().signOut();
    });
    await settle();
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');

    // Now the stale GET lands.
    await act(async () => {
      releaseGet();
    });
    await settle();
    await settle();

    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect(allText(renderer)).not.toContain('ROOT_NAVIGATOR');
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAppStore.getState().ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(useAppStore.getState().profile).toBeNull();
    // Whatever the stale hydrate did, it must not have written a profile for
    // the signed-out owner nor cleared the stash.
    expect(mockKv.get(`profile:${SIGNED_OUT_DATA_OWNER}`)).toBeUndefined();
    expect(stash().profile['firstName']).toBe('Dana');
  });
});

describe('background / foreground', () => {
  it('HELD: backgrounding and foregrounding while in the retry state records a clean session end and leaves the Gate state untouched (no re-hydrate storm)', async () => {
    // react-native's jest setup already replaces AppState.addEventListener
    // with a jest.fn; read the listeners this mount registers from it.
    const appStateListener = AppState.addEventListener as jest.Mock;
    const callsBefore = appStateListener.mock.calls.length;
    const recordSpy = jest.spyOn(stabilitySlo, 'record');
    try {
      const renderer = await reachNotificationStep();
      await pressAsync(renderer, 'Not now');
      mockApiSession = {
        apiBaseUrl: API,
        bearerToken: 'stale',
        canonicalAppUserId: CANONICAL_ID,
        provider: 'apple',
      };
      responder = async () => json({ error: { message: 'expired' } }, 401);
      await pressAsync(renderer, 'Sign in with Apple');
      await settle();
      expect(allText(renderer)).toContain(
        'Your coaching profile couldn’t load',
      );
      const getsBefore = calls.length;
      const listeners = appStateListener.mock.calls
        .slice(callsBefore)
        .filter(([event]) => event === 'change')
        .map(([, handler]) => handler as (state: string) => void);
      expect(listeners.length).toBeGreaterThan(0);

      for (let i = 0; i < 3; i += 1) {
        await act(async () => {
          for (const listener of listeners) listener('background');
        });
        await act(async () => {
          for (const listener of listeners) listener('active');
        });
      }
      await settle();

      expect(allText(renderer)).toContain(
        'Your coaching profile couldn’t load',
      );
      expect(calls.length).toBe(getsBefore);
      expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
        CANONICAL_ID,
      );
      expect(
        recordSpy.mock.calls.filter(
          ([event]) => event.kind === 'session_ended_clean',
        ),
      ).toHaveLength(3);
    } finally {
      recordSpy.mockRestore();
    }
  });
});

describe('first-name input edges', () => {
  it('HELD: a whitespace-only name keeps Continue disabled; NBSP/tab/newline are trimmed too', async () => {
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    for (const value of ['   ', '\u00a0\u00a0', '\t\n', '\u2003']) {
      typeName(renderer, value);
      const cont = pressables(renderer, 'Continue');
      expect(cont).toHaveLength(1);
      expect(cont[0]!.props.disabled).toBe(true);
    }
  });

  it('HELD: RTL + ZWJ emoji + combining marks survive the questionnaire byte-for-byte into the stash and the reveal copy', async () => {
    const name = '\u202Bمها\u202C 👩🏽‍🚀 Zoë\u0301';
    const renderer = await reachNotificationStep(name);
    await pressAsync(renderer, 'Not now');
    expect(stash().profile['firstName']).toBe(name);
  });

  it('OBSERVED: the 40-char maxLength lives only on the TextInput prop — a programmatic 10 000-char value (e.g. paste on a platform that ignores maxLength) is stashed in full', async () => {
    const huge = 'Ä'.repeat(10_000);
    const renderer = await launch();
    await pressAsync(renderer, 'Start your first read');
    expect(renderer.root.findByType(TextInput).props.maxLength).toBe(40);
    await answerFrom(renderer, huge);
    await pressAsync(renderer, 'Not now');
    expect(allText(renderer)).toContain('SIGN_IN_SCREEN');
    expect((stash().profile['firstName'] as string).length).toBe(10_000);
  });

  it('HELD: an invisible-only name (ZWJ/RTL marks) passes the length check but is stored exactly as typed — no crash, no coercion', async () => {
    const invisible = '\u200d\u200f\u200e';
    const renderer = await reachNotificationStep(invisible);
    await pressAsync(renderer, 'Not now');
    expect(stash().profile['firstName']).toBe(invisible);
  });
});
