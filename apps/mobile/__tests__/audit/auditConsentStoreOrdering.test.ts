/**
 * Structural audit probe (mobile-settings-account, pass 1).
 *
 * consentStore claims "the server ledger is the only truth". Its stale-
 * response guard is keyed on the SESSION only (fix-11): a response that lands
 * for the still-current session is applied unconditionally, in arrival
 * order. `hydrate` has no in-flight guard and no sequence number, so two
 * hydrates for the same account (SettingsScreen mount + ConsentSettingsScreen
 * mount both call `hydrate()`, and "Try again" is unguarded) resolve in
 * arrival order — a slow first GET can overwrite the result of a later grant
 * or a later GET.
 */
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import {
  MODEL_TRAINING_CONSENT_VERSION,
  fetchConsentStatus,
} from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

function statusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  clearApiSession();
  establishApiSession(session);
});

afterEach(() => {
  setApiUnauthorizedListener(null);
  clearApiSession();
});

describe('audit: consent store same-session response ordering', () => {
  it('a slow status GET started BEFORE a grant must not overwrite the grant result', async () => {
    const slowGet = deferred<Response>();
    const fetchFn: ConsentFetch = jest.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/v1/me/consent/status')) {
        // First hydrate (e.g. SettingsScreen mount on a cold edge function)
        // is slow; the second (ConsentSettingsScreen mount) is fast.
        const calls = (fetchFn as jest.Mock).mock.calls.filter(c =>
          String(c[0]).endsWith('/v1/me/consent/status'),
        ).length;
        return calls === 1 ? slowGet.promise : jsonResponse(statusBody(false));
      }
      if (url.endsWith('/v1/me/consent/grant')) {
        expect(init?.method).toBe('POST');
        return jsonResponse(statusBody(true));
      }
      throw new Error(`unexpected ${url}`);
    });

    const store = useConsentStore.getState();
    const first = store.hydrate(fetchFn); // slow
    await store.hydrate(fetchFn); // fast → ready, active:false
    expect(useConsentStore.getState().availability).toBe('ready');

    // The toggle is enabled now; the player opts in and the ledger says so.
    await store.setModelTrainingConsent(true, fetchFn);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    // The pre-grant GET finally lands with the pre-grant ledger state.
    slowGet.resolve(jsonResponse(statusBody(false)));
    await first;

    // Server truth is active:true (the grant was acknowledged); the UI must
    // not flip back to OFF because an older read arrived late.
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('two same-session hydrates resolving out of order keep the NEWER response', async () => {
    const slowGet = deferred<Response>();
    let calls = 0;
    const fetchFn: ConsentFetch = jest.fn(async () => {
      calls += 1;
      return calls === 1 ? slowGet.promise : jsonResponse(statusBody(true));
    });
    const store = useConsentStore.getState();
    const first = store.hydrate(fetchFn);
    await store.hydrate(fetchFn);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    slowGet.resolve(jsonResponse(statusBody(false)));
    await first;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('a slow hydrate failing after a later success must not flip a ready store to unavailable', async () => {
    const slowGet = deferred<Response>();
    let calls = 0;
    const fetchFn: ConsentFetch = jest.fn(async () => {
      calls += 1;
      return calls === 1 ? slowGet.promise : jsonResponse(statusBody(true));
    });
    const store = useConsentStore.getState();
    const first = store.hydrate(fetchFn);
    await store.hydrate(fetchFn);
    expect(useConsentStore.getState().availability).toBe('ready');
    slowGet.resolve(jsonResponse({ error: 'boom' }, false, 503));
    await first;
    expect(useConsentStore.getState().availability).toBe('ready');
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('control: a stale response for a REPLACED session is ignored (fix-11 holds)', async () => {
    const slowGet = deferred<Response>();
    const fetchFn: ConsentFetch = jest.fn(async () => slowGet.promise);
    const first = useConsentStore.getState().hydrate(fetchFn);
    establishApiSession({
      ...session,
      bearerToken: 'token-2',
      canonicalAppUserId: 'a0000000-0000-0000-0000-000000000009',
    });
    slowGet.resolve(jsonResponse(statusBody(true)));
    await first;
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    expect(useConsentStore.getState().availability).toBe('loading');
  });

  it('a 401 on the consent status route reports the rejected bearer to the auth store', async () => {
    const unauthorized = jest.fn();
    setApiUnauthorizedListener(unauthorized);
    const fetchFn: ConsentFetch = jest.fn(async () =>
      jsonResponse({ error: { code: 'unauthorized' } }, false, 401),
    );
    await expect(fetchConsentStatus(session, fetchFn)).rejects.toMatchObject({
      message: 'Consent settings are temporarily unavailable.',
    });
    expect(unauthorized).toHaveBeenCalledTimes(1);
  });
});
