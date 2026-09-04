import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

/**
 * MSA-C1: within ONE signed-in session, consent responses may land out of
 * order (a status GET that was in flight when the user tapped the toggle,
 * two hydrates racing from Settings + Data & consent, a slow request that
 * eventually fails). The store must apply only the newest request's result
 * and discard everything older — the session-identity guard alone cannot
 * tell those apart.
 */

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
        lastActionAt: modelTrainingActive
          ? '2026-09-04T00:00:00.000Z'
          : '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Deferred {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

interface RecordedCall {
  url: string;
  method: string | undefined;
  deferred: Deferred;
}

/** One fetch mock whose every call stays pending until the test settles it. */
function manualFetch() {
  const calls: RecordedCall[] = [];
  const fetchFn: ConsentFetch = jest.fn((url: string, init?: RequestInit) => {
    return new Promise<Response>((resolve, reject) => {
      calls.push({ url, method: init?.method, deferred: { resolve, reject } });
    });
  });
  return { fetchFn, calls };
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

describe('consentStore same-session response ordering (repro)', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
    establishApiSession(session);
  });

  it('a status GET started before a grant must not undo the grant', async () => {
    const { fetchFn, calls } = manualFetch();
    useConsentStore.setState({ availability: 'ready' });

    const hydrating = useConsentStore.getState().hydrate(fetchFn);
    const granting = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://api.test/v1/me/consent/status');
    expect(calls[1]?.url).toBe('https://api.test/v1/me/consent/grant');

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await granting;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().busy).toBe(false);

    calls[0]!.deferred.resolve(jsonResponse(statusBody(false)));
    await hydrating;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe('2026-09-04T00:00:00.000Z');
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });

  it('two overlapping hydrates: the newer response wins', async () => {
    const { fetchFn, calls } = manualFetch();

    const first = useConsentStore.getState().hydrate(fetchFn);
    const second = useConsentStore.getState().hydrate(fetchFn);
    expect(calls).toHaveLength(2);

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await second;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    calls[0]!.deferred.resolve(jsonResponse(statusBody(false)));
    await first;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe('2026-09-04T00:00:00.000Z');
  });

  it('a stale hydrate failure landing after a newer success must not flip the store to unavailable', async () => {
    const { fetchFn, calls } = manualFetch();

    const first = useConsentStore.getState().hydrate(fetchFn);
    const second = useConsentStore.getState().hydrate(fetchFn);
    expect(calls).toHaveLength(2);

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await second;
    expect(useConsentStore.getState().availability).toBe('ready');

    calls[0]!.deferred.reject(new TypeError('Network request failed'));
    await first;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.error).toBeNull();
  });

  it('a stale grant failure landing after a newer hydrate keeps the hydrated ledger and clears busy', async () => {
    const { fetchFn, calls } = manualFetch();
    useConsentStore.setState({ availability: 'ready' });

    const granting = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    const hydrating = useConsentStore.getState().hydrate(fetchFn);
    expect(calls).toHaveLength(2);
    expect(useConsentStore.getState().busy).toBe(true);

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await hydrating;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    calls[0]!.deferred.reject(new TypeError('Network request failed'));
    await granting;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });
});
