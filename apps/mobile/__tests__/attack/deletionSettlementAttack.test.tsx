/**
 * Adversarial probes of the MSA-P1-1 fix (candidate 96f674c2: the session
 * layer settles an ambiguous delete-confirm). Every test asserts the
 * EXPECTED behaviour; a failure = defect reproduced on the candidate.
 *
 * All three probes drive the REAL auth store + session keeper (hydrated from
 * the Keychain vault the way the app does) behind the real
 * ManageAccountScreen dialog, with a routed fetch so the confirm can be held
 * in flight while other traffic lands.
 *
 * A1  A bearer rotation lands while the confirm is in flight, then the
 *     confirm answers 401. The 401 names the OLD bearer, so apiSession.ts
 *     drops it (no refresh is triggered), and the dialog's settlement effect
 *     reads `pendingDeletion.sessionRenewed` — set by a rotation that
 *     PRECEDED the 401 — as the verdict: "Your account is still here — the
 *     deletion did not go through." No request after the 401 verified that.
 *     The very next refresh is refused (the account IS gone).
 *
 * A2  Another API client's 401 lands while the confirm is in flight (the
 *     server has already deleted the user and fenced the session, its 200
 *     is still travelling): the keeper's refresh is refused → the store ends
 *     the account (completeAccountDeletion #1, purge fails, notice #1). The
 *     confirm's 200 then arrives → onDeleted → completeAccountDeletion #2
 *     runs with no session, records `localPurge: 'not_needed'` over the
 *     earlier `'failed'`, and a second "Account deleted" notice is shown.
 *
 * A3  delete-REQUEST answered 401 → reportApiUnauthorized → the keeper
 *     rotates the bearer (accepted: the account exists, only the bearer was
 *     stale). The user is signed in with a fresh bearer, yet the dialog says
 *     "Your sign-in has expired. Sign in again, then delete your account."
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => insets,
    initialWindowMetrics: null,
  };
});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

const mockShowBrandNotice = jest.fn();
jest.mock('../../src/design/BrandNotice', () => ({
  showBrandNotice: (...args: unknown[]) => mockShowBrandNotice(...args),
}));

jest.mock('../../src/config/runtimeConfig', () => {
  const actual = jest.requireActual<
    typeof import('../../src/config/runtimeConfig')
  >('../../src/config/runtimeConfig');
  return {
    ...actual,
    getRuntimePublicConfig: () => ({
      ...actual.getRuntimePublicConfig(),
      apiBaseUrl: 'https://api.test',
    }),
  };
});

import * as Keychain from 'react-native-keychain';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { Button } from '../../src/design/components';
import { useAuthStore } from '../../src/auth/authStore';
import {
  clearApiSession,
  getApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

const realAuthActions = useAuthStore.getState();
const canonicalAppUserId = '11111111-1111-4111-8111-111111111111';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Deferred {
  resolve: (response: Response) => void;
  promise: Promise<Response>;
}

function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(r => {
    resolve = r;
  });
  return { resolve, promise };
}

interface Routes {
  /** /v1/auth/refresh answers 200 this many times, then 401 forever. */
  refreshAccepted: number;
  request: () => Response;
  confirm: () => Promise<Response>;
}

function installRoutes(routes: Routes) {
  let refreshes = 0;
  const calls: string[] = [];
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/v1/auth/refresh')) {
      refreshes += 1;
      return Promise.resolve(
        refreshes <= routes.refreshAccepted
          ? jsonResponse(200, {
              session: {
                accessToken: `access-${refreshes + 1}`,
                refreshToken: `refresh-${refreshes + 1}`,
                expiresAt: Math.floor(Date.now() / 1000) + 3600,
              },
            })
          : jsonResponse(401, { error: { message: 'Sign in again.' } }),
      );
    }
    if (url.endsWith('/v1/me/delete-request')) {
      return Promise.resolve(routes.request());
    }
    if (url.endsWith('/v1/me/delete-confirm')) {
      return routes.confirm();
    }
    return Promise.reject(new Error(`unexpected fetch ${url}`));
  }) as typeof globalThis.fetch;
  return calls;
}

const challengeIssued = () =>
  jsonResponse(200, {
    challenge: 'challenge-1',
    expiresAt: '2026-09-05T00:00:00.000Z',
  });

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function pressable(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

function sheetButton(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const matches = renderer.root
    .findAllByType(Button)
    .filter(node => String(node.props.label).startsWith(label));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

async function flush(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** Delete account → skip survey → Continue to delete (fires delete-request). */
async function openAndRequest(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    pressable(renderer, 'Delete account')[0]!.props.onPress();
  });
  await act(async () => {
    pressable(renderer, 'Skip the survey')[0]!.props.onPress();
  });
  await act(async () => {
    sheetButton(renderer, 'Continue to delete').props.onPress();
  });
  await flush();
}

/** …then wait out the 5s arm and return the live confirm button. */
async function armDeletion(renderer: TestRenderer.ReactTestRenderer) {
  await openAndRequest(renderer);
  await act(async () => {
    jest.advanceTimersByTime(5_000);
  });
  const confirm = sheetButton(renderer, 'Permanently delete');
  expect(confirm.props.disabled).toBe(false);
  return confirm;
}

async function hydrateFromVault() {
  __keychainStore.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider: 'apple',
      canonicalAppUserId,
      refreshToken: 'refresh-1',
      email: 'alex@example.com',
      displayName: 'Alex Chen',
    }),
  });
  await act(async () => {
    await useAuthStore.getState().hydrate();
  });
  expect(useAuthStore.getState().session?.canonicalAppUserId).toBe(
    canonicalAppUserId,
  );
  expect(getApiSession()?.bearerToken).toBe('access-2');
}

let mounted: TestRenderer.ReactTestRenderer | null = null;

function mountScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ManageAccountScreen />);
  });
  mounted = renderer;
  return renderer;
}

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
  mockShowBrandNotice.mockReset();
  __keychainStore.clear();
  stopSessionKeeper();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  // The real store, wired the way the app wires it (authStore's own
  // unauthorized listener, real completeAccountDeletion).
  setApiUnauthorizedListener(null);
  useAuthStore.setState({
    ...realAuthActions,
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
    pendingDeletion: null,
  });
});

afterEach(() => {
  if (mounted) {
    const renderer = mounted;
    mounted = null;
    act(() => renderer.unmount());
  }
  stopSessionKeeper();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  __keychainStore.clear();
});

describe('A1 — a rotation that PRECEDED the 401 is taken as the verdict', () => {
  it('confirm in flight → bearer rotated → confirm answers 401: the dialog must not declare "did not go through" without a post-401 verdict', async () => {
    const confirm = deferred();
    const calls = installRoutes({
      refreshAccepted: 2, // launch refresh + the one mid-confirm rotation
      request: challengeIssued,
      confirm: () => confirm.promise,
    });
    const refreshCount = () =>
      calls.filter(url => url.endsWith('/v1/auth/refresh')).length;
    await hydrateFromVault();
    const renderer = mountScreen();
    const confirmButton = await armDeletion(renderer);

    await act(async () => {
      confirmButton.props.onPress();
    });
    await flush();
    expect(useAuthStore.getState().pendingDeletion).toEqual({
      canonicalAppUserId,
      challenge: 'challenge-1',
      sessionRenewed: false,
    });

    // While the confirm is travelling, another client's 401 makes the keeper
    // rotate; the server accepts (the account still existed at that moment).
    reportApiUnauthorized('access-2');
    await flush();
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(useAuthStore.getState().pendingDeletion?.sessionRenewed).toBe(true);

    // The confirm (sent with access-2) now answers 401: the server finished
    // deleting the account after the rotation.
    const refreshesBeforeFourOhOne = refreshCount();
    await act(async () => {
      confirm.resolve(
        jsonResponse(401, {
          error: { message: 'The session is no longer valid. Sign in again.' },
        }),
      );
    });
    await flush();

    const copy = allText(renderer);
    const afterFourOhOne = {
      copyClaimsStillHere: /still here/.test(copy),
      copyClaimsDidNotGoThrough: /did not go through/.test(copy),
      reArmed: !sheetButton(renderer, 'Permanently delete').props.disabled,
      bearer: getApiSession()?.bearerToken ?? null,
      signedIn: useAuthStore.getState().session !== null,
      pendingDeletion: useAuthStore.getState().pendingDeletion,
      refreshesAfterFourOhOne: refreshCount() - refreshesBeforeFourOhOne,
    };

    // Proof the verdict is false: the current bearer's next refresh is
    // refused and the store ends the ACCOUNT.
    reportApiUnauthorized('access-3');
    await flush(40);
    const afterRefusal = {
      signedIn: useAuthStore.getState().session !== null,
      deletionCleanup: useAuthStore.getState().deletionCleanup,
    };
    console.log(JSON.stringify({ afterFourOhOne, afterRefusal }, null, 2));
    expect(afterRefusal).toEqual({
      signedIn: false,
      deletionCleanup: { localPurge: 'failed' },
    });

    // EXPECTED: no definitive "the deletion did not go through" until a
    // refresh AFTER the 401 was accepted. Nothing after the 401 checked the
    // current bearer (the stale-bearer 401 was dropped by apiSession.ts).
    expect(copy).not.toContain('did not go through');
  });
});

describe('A2 — the store ends the account while the confirm is in flight, then its 200 lands', () => {
  it('completeAccountDeletion runs once, the purge report is not overwritten, one notice', async () => {
    const confirm = deferred();
    installRoutes({
      refreshAccepted: 1, // only the launch refresh; the next is refused
      request: challengeIssued,
      confirm: () => confirm.promise,
    });
    await hydrateFromVault();
    const completeSpy = jest.spyOn(
      useAuthStore.getState(),
      'completeAccountDeletion',
    );
    useAuthStore.setState({
      completeAccountDeletion:
        completeSpy as unknown as typeof realAuthActions.completeAccountDeletion,
    });
    const cleanupReports: Array<string | null> = [];
    const unsubscribe = useAuthStore.subscribe(state => {
      cleanupReports.push(state.deletionCleanup?.localPurge ?? null);
    });

    const renderer = mountScreen();
    const confirmButton = await armDeletion(renderer);
    await act(async () => {
      confirmButton.props.onPress();
    });
    await flush();

    // Server: deleteUser + fence done, 200 still travelling. Another client
    // (sync, access refresh) gets 401 → keeper refresh → REFUSED → the store
    // ends the account.
    reportApiUnauthorized('access-2');
    await flush(40);
    expect(useAuthStore.getState().session).toBeNull();
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
    const noticesAfterStore = mockShowBrandNotice.mock.calls.length;

    // The confirm's 200 arrives.
    await act(async () => {
      confirm.resolve(
        jsonResponse(200, {
          deleted: true,
          appleAuthorizationRevocation: 'manual_action_required',
        }),
      );
    });
    await flush(40);
    unsubscribe();

    const notices = mockShowBrandNotice.mock.calls.map(
      c => c[0] as { eyebrow: string; detail: string },
    );
    console.log(
      JSON.stringify(
        {
          completeAccountDeletionCalls: completeSpy.mock.calls.length,
          noticesAfterStoreVerdict: noticesAfterStore,
          notices,
          cleanupReports,
          finalCleanup: useAuthStore.getState().deletionCleanup,
        },
        null,
        2,
      ),
    );

    // EXPECTED: the account is ended ONCE, the user is told ONCE, and the
    // recorded cleanup outcome stays the truthful 'failed'.
    expect(completeSpy).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(useAuthStore.getState().deletionCleanup).toEqual({
      localPurge: 'failed',
    });
  });
});

describe('A3 — delete-request 401, sign-in renewed by the keeper', () => {
  it('a signed-in user with a fresh bearer must not be told to "Sign in again"', async () => {
    installRoutes({
      refreshAccepted: 2, // launch refresh + the rotation the 401 triggers
      request: () =>
        jsonResponse(401, {
          error: { message: 'The session is no longer valid. Sign in again.' },
        }),
      confirm: () => Promise.reject(new Error('confirm must not be sent')),
    });
    await hydrateFromVault();
    const renderer = mountScreen();
    await openAndRequest(renderer);
    await flush(40);

    const copy = allText(renderer);
    const state = useAuthStore.getState();
    console.log(
      JSON.stringify(
        {
          bearer: getApiSession()?.bearerToken ?? null,
          signedIn: state.session !== null,
          error: state.error,
          copy:
            copy.match(/Your sign-in has expired[^.]*\.[^.]*\./)?.[0] ?? null,
        },
        null,
        2,
      ),
    );

    // The keeper renewed the sign-in on the spot…
    expect(getApiSession()?.bearerToken).toBe('access-3');
    expect(state.session?.canonicalAppUserId).toBe(canonicalAppUserId);
    // …so the dialog must not instruct the user to sign in again.
    expect(copy).not.toContain('Sign in again');
  });
});
