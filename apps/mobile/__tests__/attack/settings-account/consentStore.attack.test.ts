import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../../src/account/apiSession';
import type { ConsentFetch } from '../../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../../src/account/consentApi';
import { useConsentStore } from '../../../src/state/consentStore';

/**
 * Adversarial pass (mobile-settings-account, pass 3): consentStore under
 * hostile server responses and mid-flight session changes.
 *
 * Every test performs the attack against the real store + real consentApi
 * (only `fetch` is injected). Each `it` states the invariant being probed;
 * a failing assertion here is a reproduced finding, not a flaky test.
 */

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

const otherSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-2',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000002',
  provider: 'google' as const,
};

function scopeRow(
  scope: string,
  active: boolean,
  lastActionAt: string | null = '2026-08-29T00:00:00.000Z',
) {
  return {
    scope,
    active,
    consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
    lastAction: active ? 'granted' : 'withdrawn',
    lastActionAt,
  };
}

function statusBody(scopes: unknown[]) {
  return { subjectPseudonym: 'b0000000-0000-0000-0000-000000000002', scopes };
}

function jsonResponse(body: unknown, ok = true, status = ok ? 200 : 500) {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function resetStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('consentStore — adversarial', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
    setApiUnauthorizedListener(null);
  });

  afterEach(() => {
    setApiUnauthorizedListener(null);
  });

  describe('S1: consent GET returns 401 mid-session', () => {
    it('surfaces the unavailable copy and never flips the toggle on', async () => {
      establishApiSession(session);
      const fetchFn = jest.fn(() =>
        Promise.resolve(
          jsonResponse(
            { error: { code: 'auth.unauthorized', message: 'nope' } },
            false,
            401,
          ),
        ),
      );
      await useConsentStore.getState().hydrate(fetchFn as ConsentFetch);
      const state = useConsentStore.getState();
      expect(state.availability).toBe('unavailable');
      expect(state.modelTrainingActive).toBe(false);
      expect(state.error).toBe('Consent settings are temporarily unavailable.');
    });

    it('CHARACTERIZATION: the apiSession unauthorized listener is NOT notified (0 calls, expected exactly 1)', async () => {
      // data/api.ts, billing/accessApi.ts and training/api.ts all call
      // reportApiUnauthorized(token) on a 401 so authStore can refresh or
      // end the session. consentApi.ts does not. This test pins the current
      // (defective) behaviour so the finding has an executable repro; when
      // the client is fixed, flip the expectation to 1.
      establishApiSession(session);
      const unauthorized = jest.fn();
      setApiUnauthorizedListener(unauthorized);
      const fetchFn = jest.fn(() =>
        Promise.resolve(jsonResponse({ error: {} }, false, 401)),
      );
      await useConsentStore.getState().hydrate(fetchFn as ConsentFetch);
      expect(useConsentStore.getState().availability).toBe('unavailable');
      // FINDING: expected 1, observed 0.
      expect(unauthorized).toHaveBeenCalledTimes(0);
    });

    it('a 401 on grant also leaves the listener silent and the toggle off', async () => {
      establishApiSession(session);
      const unauthorized = jest.fn();
      setApiUnauthorizedListener(unauthorized);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve(jsonResponse(null, false, 401)),
      );
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      const state = useConsentStore.getState();
      expect(state.modelTrainingActive).toBe(false);
      expect(state.busy).toBe(false);
      expect(state.error).toBe('Consent settings are temporarily unavailable.');
      expect(unauthorized).toHaveBeenCalledTimes(0);
    });

    it('repeated Try again after 401 never double-fires and never leaks a grant', async () => {
      establishApiSession(session);
      const unauthorized = jest.fn();
      setApiUnauthorizedListener(unauthorized);
      const fetchFn = jest.fn(() =>
        Promise.resolve(jsonResponse(null, false, 401)),
      );
      await Promise.all([
        useConsentStore.getState().hydrate(fetchFn as ConsentFetch),
        useConsentStore.getState().hydrate(fetchFn as ConsentFetch),
        useConsentStore.getState().hydrate(fetchFn as ConsentFetch),
      ]);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(useConsentStore.getState().availability).toBe('unavailable');
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
      expect(unauthorized.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe('S2: grant returns 200 but the wrong scope', () => {
    it('200 with status granted on video_analysis only → no flip of modelTrainingActive', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve(
          jsonResponse(statusBody([scopeRow('video_analysis', true)])),
        ),
      );
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      const state = useConsentStore.getState();
      // The response is schema-valid, so no ConsentApiError is raised; the
      // store must still derive "off" because model_training is absent.
      expect(state.modelTrainingActive).toBe(false);
      expect(state.lastActionAt).toBeNull();
      expect(state.busy).toBe(false);
      expect(state.availability).toBe('ready');
    });

    it('200 with an unknown scope name → ConsentApiError, optimistic state discarded', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve(
          jsonResponse(
            statusBody([
              { ...scopeRow('model_training', true), scope: 'Model_Training' },
            ]),
          ),
        ),
      );
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      const state = useConsentStore.getState();
      expect(state.modelTrainingActive).toBe(false);
      expect(state.error).toBe(
        'The consent server returned an invalid response.',
      );
      expect(state.busy).toBe(false);
    });

    it('200 with active as a truthy string is rejected, not coerced', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve(
          jsonResponse(
            statusBody([
              { ...scopeRow('model_training', true), active: 'true' },
            ]),
          ),
        ),
      );
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
      expect(useConsentStore.getState().error).toBe(
        'The consent server returned an invalid response.',
      );
    });

    it('200 with prototype-polluted scopes payload cannot smuggle a grant', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const polluted = JSON.parse(
        '{"subjectPseudonym":null,"scopes":[{"__proto__":{"scope":"model_training","active":true},"scope":"video_analysis","active":false,"consentVersion":null,"lastAction":null,"lastActionAt":null}]}',
      ) as unknown;
      const fetchFn = jest.fn(() => Promise.resolve(jsonResponse(polluted)));
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
      expect(useConsentStore.getState().busy).toBe(false);
    });

    it('200 whose body is not JSON → ConsentApiError, no flip', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('bad json')),
        } as unknown as Response),
      );
      await useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
      expect(useConsentStore.getState().error).toBe(
        'The consent server returned an invalid response.',
      );
    });

    it('a duplicate model_training row: first row wins (documented tie-break)', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const fetchFn = jest.fn(() =>
        Promise.resolve(
          jsonResponse(
            statusBody([
              scopeRow('model_training', false, null),
              scopeRow('model_training', true),
            ]),
          ),
        ),
      );
      await useConsentStore.getState().hydrate(fetchFn as ConsentFetch);
      // Array.find → first match. Pinned so a server that ever emits two
      // rows cannot silently switch the derivation order.
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    });
  });

  describe('interleavings and mid-flight session changes', () => {
    it('sign-out while grant is in flight → response dropped, signed_out state', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const gate = deferred<Response>();
      const fetchFn = jest.fn(() => gate.promise);
      const pending = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      expect(useConsentStore.getState().busy).toBe(true);
      clearApiSession();
      gate.resolve(
        jsonResponse(statusBody([scopeRow('model_training', true)])),
      );
      await pending;
      const state = useConsentStore.getState();
      expect(state.availability).toBe('signed_out');
      expect(state.modelTrainingActive).toBe(false);
      expect(state.busy).toBe(false);
    });

    it('account switch while grant is in flight → late grant never lands on the new account', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const gate = deferred<Response>();
      const fetchFn = jest.fn(() => gate.promise);
      const pending = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      establishApiSession(otherSession);
      gate.resolve(
        jsonResponse(statusBody([scopeRow('model_training', true)])),
      );
      await pending;
      const state = useConsentStore.getState();
      expect(state.modelTrainingActive).toBe(false);
      expect(state.busy).toBe(false);
    });

    it('rapid double toggle: the second tap is ignored while busy (exactly one POST)', async () => {
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const gate = deferred<Response>();
      const fetchFn = jest.fn(() => gate.promise);
      const first = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      const second = useConsentStore
        .getState()
        .setModelTrainingConsent(false, fetchFn as ConsentFetch);
      gate.resolve(
        jsonResponse(statusBody([scopeRow('model_training', true)])),
      );
      await Promise.all([first, second]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);
      expect(useConsentStore.getState().busy).toBe(false);
    });

    it('hydrate racing a slow grant: a stale GET(off) landing after POST(on) overwrites the grant (ordering pin)', async () => {
      // Two concurrent requests for the same account: GET returns "off"
      // AFTER the grant returned "on". Last-writer-wins is the current
      // contract; pin it so any change is deliberate.
      establishApiSession(session);
      useConsentStore.setState({ availability: 'ready' });
      const getGate = deferred<Response>();
      const postGate = deferred<Response>();
      const fetchFn = jest.fn((_url: string, init?: RequestInit) =>
        init?.method === 'POST' ? postGate.promise : getGate.promise,
      );
      const hydrating = useConsentStore
        .getState()
        .hydrate(fetchFn as ConsentFetch);
      const granting = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn as ConsentFetch);
      postGate.resolve(
        jsonResponse(statusBody([scopeRow('model_training', true)])),
      );
      await granting;
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);
      getGate.resolve(
        jsonResponse(statusBody([scopeRow('model_training', false, null)])),
      );
      await hydrating;
      expect(useConsentStore.getState().modelTrainingActive).toBe(false);
      expect(useConsentStore.getState().availability).toBe('ready');
    });

    it('the request always carries the bearer of the session it was issued for', async () => {
      establishApiSession(session);
      let seenAuth: string | null = null;
      const fetchFn = jest.fn((_url: string, init?: RequestInit) => {
        seenAuth =
          (init?.headers as Record<string, string>)['Authorization'] ?? null;
        return Promise.resolve(
          jsonResponse(statusBody([scopeRow('model_training', false, null)])),
        );
      });
      await useConsentStore.getState().hydrate(fetchFn as ConsentFetch);
      expect(seenAuth).toBe('Bearer token-1');
      expect(String(fetchFn.mock.calls[0]![0])).toBe(
        'https://api.test/v1/me/consent/status',
      );
    });
  });
});
