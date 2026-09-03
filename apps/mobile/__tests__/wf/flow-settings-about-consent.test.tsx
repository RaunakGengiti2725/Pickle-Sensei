import React from 'react';
import { Switch, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * Settings → Data & consent, driven through the REAL consent store against a
 * scripted fetch so the ledger round-trip, the busy/double-tap guard, the
 * failure copy and the signed-out / unavailable states are all exercised as
 * a user would see them.
 */

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

const API_BASE = 'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: '11111111-1111-4111-8111-111111111111',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

function statusPayload(active: boolean) {
  return {
    subjectPseudonym: 'pseudo-1',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? '2026-08-01' : null,
        lastAction: active ? 'granted' : null,
        lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
      },
    ],
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

type FetchCall = { url: string; init: RequestInit | undefined };
let fetchCalls: FetchCall[];
let fetchScript: Array<() => Promise<Response>>;
let realFetch: typeof globalThis.fetch;

function scriptFetch(...steps: Array<() => Promise<Response>>) {
  fetchScript = steps;
}

const mounted: TestRenderer.ReactTestRenderer[] = [];

function renderScreen() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<ConsentSettingsScreen />);
  });
  mounted.push(renderer);
  return renderer;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

/** RN's Pressable is where a11y props and onPress are resolved. */
function isPressable(node: TestRenderer.ReactTestInstance): boolean {
  if (typeof node.type === 'string') return false;
  const component = node.type as { displayName?: string; name?: string };
  return (component.displayName ?? component.name) === 'Pressable';
}

function toggle(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findByType(Switch);
}

beforeEach(() => {
  fetchCalls = [];
  fetchScript = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = ((url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const step = fetchScript.shift();
    if (!step) throw new Error(`unexpected fetch ${url}`);
    return step();
  }) as typeof globalThis.fetch;
  mockGoBack.mockClear();
  act(() => {
    useAuthStore.setState({ session: syncedSession });
    establishApiSession({
      apiBaseUrl: API_BASE,
      bearerToken: 'test-bearer',
      canonicalAppUserId: syncedSession.canonicalAppUserId!,
      provider: 'google',
    });
    useConsentStore.setState({
      availability: 'loading',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
    });
  });
});

afterEach(() => {
  for (const renderer of mounted.splice(0)) {
    if (renderer.toJSON() !== null) act(() => renderer.unmount());
  }
  globalThis.fetch = realFetch;
  clearApiSession();
});

describe('Data & consent — hydrate on open', () => {
  it('loads the ledger on mount, defaults OFF while loading, and the toggle is disabled until ready', async () => {
    let resolveStatus!: (r: Response) => void;
    scriptFetch(
      () =>
        new Promise<Response>(resolve => {
          resolveStatus = resolve;
        }),
    );
    const renderer = renderScreen();
    // While loading: off, disabled, no error, nothing claims consent.
    expect(toggle(renderer).props.value).toBe(false);
    expect(toggle(renderer).props.disabled).toBe(true);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toBe(`${API_BASE}/v1/me/consent/status`);
    expect(fetchCalls[0]!.init?.method).toBe('GET');
    expect(
      (fetchCalls[0]!.init?.headers as Record<string, string>)['Authorization'],
    ).toBe('Bearer test-bearer');

    await act(async () => {
      resolveStatus(jsonResponse(statusPayload(true)));
    });
    await flush();
    expect(useConsentStore.getState().availability).toBe('ready');
    expect(toggle(renderer).props.value).toBe(true);
    expect(toggle(renderer).props.disabled).toBe(false);
    expect(toggle(renderer).props.accessibilityState).toEqual({
      disabled: false,
    });
    act(() => renderer.unmount());
  });

  it('the back chevron pops the screen', () => {
    scriptFetch(() => Promise.resolve(jsonResponse(statusPayload(false))));
    const renderer = renderScreen();
    const back = renderer.root.findAll(
      node =>
        isPressable(node) &&
        node.props.accessibilityLabel === 'Back' &&
        typeof node.props.onPress === 'function',
    );
    expect(back[0]!.props.accessibilityRole).toBe('button');
    expect(back.length).toBeGreaterThan(0);
    act(() => back[0]!.props.onPress());
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('a failed status fetch shows honest unavailable copy, keeps OFF, and disables the toggle', async () => {
    scriptFetch(() => Promise.reject(new Error('offline')));
    const renderer = renderScreen();
    await flush();
    expect(useConsentStore.getState().availability).toBe('unavailable');
    expect(toggle(renderer).props.value).toBe(false);
    expect(toggle(renderer).props.disabled).toBe(true);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    act(() => renderer.unmount());
  });

  it('an invalid server payload is treated as unavailable, never as consent', async () => {
    scriptFetch(() =>
      Promise.resolve(jsonResponse({ scopes: [{ scope: 'model_training' }] })),
    );
    const renderer = renderScreen();
    await flush();
    expect(useConsentStore.getState().availability).toBe('unavailable');
    expect(toggle(renderer).props.value).toBe(false);
    expect(allText(renderer)).toContain(
      'The consent server returned an invalid response.',
    );
    act(() => renderer.unmount());
  });

  it('signed out: the toggle is disabled and the user is told nothing is shared', async () => {
    act(() => {
      clearApiSession();
      useAuthStore.setState({ session: null });
    });
    const renderer = renderScreen();
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(toggle(renderer).props.disabled).toBe(true);
    expect(toggle(renderer).props.value).toBe(false);
    expect(allText(renderer)).toContain(
      'Sign in to change this. Nothing is shared while signed out.',
    );
    act(() => renderer.unmount());
  });
});

describe('Data & consent — toggling', () => {
  it('turning ON posts a grant with the settings source and reflects the ledger result', async () => {
    scriptFetch(
      () => Promise.resolve(jsonResponse(statusPayload(false))),
      () => Promise.resolve(jsonResponse(statusPayload(true))),
    );
    const renderer = renderScreen();
    await flush();
    await act(async () => {
      toggle(renderer).props.onValueChange(true);
    });
    await flush();
    expect(fetchCalls).toHaveLength(2);
    const grant = fetchCalls[1]!;
    expect(grant.url).toBe(`${API_BASE}/v1/me/consent/grant`);
    expect(grant.init?.method).toBe('POST');
    const body = JSON.parse(String(grant.init?.body)) as Record<
      string,
      unknown
    >;
    expect(body['scope']).toBe('model_training');
    expect(body['source']).toBe('mobile_settings');
    expect(body['captureMode']).toBe('all_captures');
    expect(typeof body['consentVersion']).toBe('string');
    expect(toggle(renderer).props.value).toBe(true);
    expect(useConsentStore.getState().busy).toBe(false);
    expect(useConsentStore.getState().error).toBeNull();
    act(() => renderer.unmount());
  });

  it('turning OFF posts a withdrawal and the switch follows the server, not the optimistic tap', async () => {
    scriptFetch(
      () => Promise.resolve(jsonResponse(statusPayload(true))),
      () => Promise.resolve(jsonResponse(statusPayload(false))),
    );
    const renderer = renderScreen();
    await flush();
    expect(toggle(renderer).props.value).toBe(true);
    await act(async () => {
      toggle(renderer).props.onValueChange(false);
    });
    await flush();
    expect(fetchCalls[1]!.url).toBe(`${API_BASE}/v1/me/consent/withdraw`);
    expect(toggle(renderer).props.value).toBe(false);
    act(() => renderer.unmount());
  });

  it('a failed change shows the failure copy and never pretends it saved', async () => {
    scriptFetch(
      () => Promise.resolve(jsonResponse(statusPayload(false))),
      () => Promise.resolve(jsonResponse({ error: 'nope' }, 503)),
    );
    const renderer = renderScreen();
    await flush();
    await act(async () => {
      toggle(renderer).props.onValueChange(true);
    });
    await flush();
    expect(toggle(renderer).props.value).toBe(false);
    expect(toggle(renderer).props.disabled).toBe(false);
    expect(useConsentStore.getState().busy).toBe(false);
    expect(allText(renderer)).toContain(
      'Consent settings are temporarily unavailable.',
    );
    act(() => renderer.unmount());
  });

  it('a non-API failure uses the generic "nothing was changed" copy', async () => {
    scriptFetch(
      () => Promise.resolve(jsonResponse(statusPayload(false))),
      () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => {
            throw new TypeError('boom');
          },
        } as unknown as Response),
    );
    const renderer = renderScreen();
    await flush();
    await act(async () => {
      toggle(renderer).props.onValueChange(true);
    });
    await flush();
    expect(useConsentStore.getState().busy).toBe(false);
    expect(toggle(renderer).props.value).toBe(false);
    expect(allText(renderer)).toContain(
      'Your consent change could not be saved. Nothing was changed.',
    );
    act(() => renderer.unmount());
  });

  it('double-tap guard: a second flip while the first is in flight is ignored and the switch is disabled', async () => {
    let resolveGrant!: (r: Response) => void;
    scriptFetch(
      () => Promise.resolve(jsonResponse(statusPayload(false))),
      () =>
        new Promise<Response>(resolve => {
          resolveGrant = resolve;
        }),
    );
    const renderer = renderScreen();
    await flush();
    act(() => {
      toggle(renderer).props.onValueChange(true);
    });
    await flush();
    expect(useConsentStore.getState().busy).toBe(true);
    expect(toggle(renderer).props.disabled).toBe(true);
    expect(toggle(renderer).props.accessibilityState).toEqual({
      disabled: true,
    });
    // Second tap (e.g. via assistive tech) while busy must not issue a request.
    await act(async () => {
      await useConsentStore.getState().setModelTrainingConsent(false);
    });
    expect(fetchCalls).toHaveLength(2);
    await act(async () => {
      resolveGrant(jsonResponse(statusPayload(true)));
    });
    await flush();
    expect(useConsentStore.getState().busy).toBe(false);
    expect(toggle(renderer).props.disabled).toBe(false);
    expect(toggle(renderer).props.value).toBe(true);
    act(() => renderer.unmount());
  });

  it('a change attempted without an API session sends no request and explains that nothing changed', async () => {
    act(() => {
      clearApiSession();
      useAuthStore.setState({ session: null });
    });
    const renderer = renderScreen();
    await flush();
    await act(async () => {
      await useConsentStore.getState().setModelTrainingConsent(true);
    });
    expect(fetchCalls).toHaveLength(0);
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'signed_out',
      modelTrainingActive: false,
      error: 'Sign in to change this setting. Nothing was changed.',
    });
    act(() => renderer.unmount());
  });
});
