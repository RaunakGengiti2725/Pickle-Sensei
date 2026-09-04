import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

/**
 * MSA-P2-4 — response ordering within ONE signed-in session. The store used
 * to guard only the account identity, so a status GET that started before a
 * grant could land afterwards and undo it, and a stale hydrate rejection
 * could flip a freshly hydrated screen to "unavailable".
 */

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

const GRANTED_AT = '2026-08-29T00:00:00.000Z';
const WITHDRAWN_AT = '2026-08-28T00:00:00.000Z';

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
        lastActionAt: modelTrainingActive ? GRANTED_AT : WITHDRAWN_AT,
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

function deferredFetch(body: unknown) {
  let resolve: (response: Response) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const fetchFn: ConsentFetch = jest.fn(
    () =>
      new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return {
    fetchFn,
    resolve: () => resolve(jsonResponse(body)),
    reject: (error: Error) => reject(error),
  };
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

describe('consentStore response ordering (MSA-P2-4)', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
    establishApiSession(session);
  });

  it('a status GET started before a grant must not undo the grant', async () => {
    const staleStatus = deferredFetch(statusBody(false));
    const inFlightStatus = useConsentStore
      .getState()
      .hydrate(staleStatus.fetchFn);
    expect(useConsentStore.getState().availability).toBe('loading');

    const grantFetch = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().setModelTrainingConsent(true, grantFetch);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().lastActionAt).toBe(GRANTED_AT);

    staleStatus.resolve();
    await inFlightStatus;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe(GRANTED_AT);
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });

  it('two overlapping hydrates: the newer response wins', async () => {
    // Older request lands LAST.
    const first = deferredFetch(statusBody(false));
    const second = deferredFetch(statusBody(true));
    const inFlightFirst = useConsentStore.getState().hydrate(first.fetchFn);
    const inFlightSecond = useConsentStore.getState().hydrate(second.fetchFn);

    second.resolve();
    await inFlightSecond;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    first.resolve();
    await inFlightFirst;

    let state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe(GRANTED_AT);

    // Older request lands FIRST — same outcome.
    resetStore();
    const third = deferredFetch(statusBody(false));
    const fourth = deferredFetch(statusBody(true));
    const inFlightThird = useConsentStore.getState().hydrate(third.fetchFn);
    const inFlightFourth = useConsentStore.getState().hydrate(fourth.fetchFn);

    third.resolve();
    await inFlightThird;
    fourth.resolve();
    await inFlightFourth;

    state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe(GRANTED_AT);
  });

  it('a stale hydrate failure landing after a newer success must not flip the store to unavailable', async () => {
    const stale = deferredFetch(null);
    const inFlightStale = useConsentStore.getState().hydrate(stale.fetchFn);

    const grantFetch = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().setModelTrainingConsent(true, grantFetch);
    expect(useConsentStore.getState().availability).toBe('ready');

    stale.reject(new Error('network down'));
    await inFlightStale;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.lastActionAt).toBe(GRANTED_AT);
    expect(state.error).toBeNull();
    expect(state.busy).toBe(false);
  });

  it('a stale hydrate failure landing after a newer hydrate success keeps the newer ledger', async () => {
    const stale = deferredFetch(null);
    const inFlightStale = useConsentStore.getState().hydrate(stale.fetchFn);

    const fresh = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().hydrate(fresh);
    expect(useConsentStore.getState().availability).toBe('ready');

    stale.reject(new Error('network down'));
    await inFlightStale;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(state.error).toBeNull();
  });

  it('a grant response landing after a newer status response releases busy without rewriting the ledger', async () => {
    useConsentStore.setState({ availability: 'ready' });
    const grant = deferredFetch(statusBody(true));
    const inFlightGrant = useConsentStore
      .getState()
      .setModelTrainingConsent(true, grant.fetchFn);
    expect(useConsentStore.getState().busy).toBe(true);

    const fresh = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(false))),
    );
    await useConsentStore.getState().hydrate(fresh);
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    grant.resolve();
    await inFlightGrant;

    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.lastActionAt).toBe(WITHDRAWN_AT);
  });

  it('a grant failure landing after a newer status response still surfaces the failure', async () => {
    useConsentStore.setState({ availability: 'ready' });
    const grant = deferredFetch(null);
    const inFlightGrant = useConsentStore
      .getState()
      .setModelTrainingConsent(true, grant.fetchFn);

    const fresh = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(false))),
    );
    await useConsentStore.getState().hydrate(fresh);

    grant.reject(new Error('network down'));
    await inFlightGrant;

    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toEqual(expect.any(String));
  });
});
