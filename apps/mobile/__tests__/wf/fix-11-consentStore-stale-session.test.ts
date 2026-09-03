import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

const sessionA = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a',
  canonicalAppUserId: 'a0000000-0000-0000-0000-00000000000a',
  provider: 'apple' as const,
};

const sessionB = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-b',
  canonicalAppUserId: 'b0000000-0000-0000-0000-00000000000b',
  provider: 'google' as const,
};

function statusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-00000000000c',
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

describe('consentStore stale-session guard', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
  });

  it('a consent fetch resolving after sign-out keeps the signed-out state', async () => {
    establishApiSession(sessionA);
    const pending = deferredFetch(statusBody(true));
    const inFlight = useConsentStore.getState().hydrate(pending.fetchFn);
    expect(useConsentStore.getState().availability).toBe('loading');

    clearApiSession();
    await useConsentStore.getState().hydrate();
    expect(useConsentStore.getState().availability).toBe('signed_out');

    pending.resolve();
    await inFlight;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('signed_out');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.lastActionAt).toBeNull();
  });

  it('a consent fetch failing after sign-out does not surface the old account error', async () => {
    establishApiSession(sessionA);
    const pending = deferredFetch(null);
    const inFlight = useConsentStore.getState().hydrate(pending.fetchFn);

    clearApiSession();
    await useConsentStore.getState().hydrate();

    pending.reject(new Error('network down'));
    await inFlight;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('signed_out');
    expect(state.error).toBeNull();
  });

  it("a previous account's late response never overwrites the next account's ledger", async () => {
    establishApiSession(sessionA);
    const pendingA = deferredFetch(statusBody(true));
    const inFlightA = useConsentStore.getState().hydrate(pendingA.fetchFn);

    clearApiSession();
    establishApiSession(sessionB);
    const fetchB = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(false))),
    );
    await useConsentStore.getState().hydrate(fetchB);
    expect(useConsentStore.getState().availability).toBe('ready');
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    pendingA.resolve();
    await inFlightA;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
  });

  it('toggling without a session surfaces a signed-out state instead of no-oping', async () => {
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: true,
    });
    const fetchFn = jest.fn<
      ReturnType<ConsentFetch>,
      Parameters<ConsentFetch>
    >();

    await useConsentStore.getState().setModelTrainingConsent(false, fetchFn);

    const state = useConsentStore.getState();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(state.availability).toBe('signed_out');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.error).toEqual(expect.any(String));
  });

  it('a grant that lands after sign-out leaves the store signed out and not busy', async () => {
    establishApiSession(sessionA);
    useConsentStore.setState({ availability: 'ready' });
    const pending = deferredFetch(statusBody(true));
    const inFlight = useConsentStore
      .getState()
      .setModelTrainingConsent(true, pending.fetchFn);
    expect(useConsentStore.getState().busy).toBe(true);

    clearApiSession();
    await useConsentStore.getState().hydrate();

    pending.resolve();
    await inFlight;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('signed_out');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.busy).toBe(false);
    expect(state.error).toBeNull();
  });

  it('a grant that lands after an account switch only clears busy', async () => {
    establishApiSession(sessionA);
    useConsentStore.setState({ availability: 'ready' });
    const pending = deferredFetch(statusBody(true));
    const inFlight = useConsentStore
      .getState()
      .setModelTrainingConsent(true, pending.fetchFn);

    clearApiSession();
    establishApiSession(sessionB);
    const fetchB = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(false))),
    );
    await useConsentStore.getState().hydrate(fetchB);

    pending.resolve();
    await inFlight;

    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.busy).toBe(false);
  });

  it('a response for the still-signed-in account is applied normally', async () => {
    establishApiSession(sessionA);
    const fetchFn = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().hydrate(fetchFn);
    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
  });
});
