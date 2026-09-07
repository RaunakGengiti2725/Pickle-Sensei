import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import type { ConsentFetch } from '../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../src/account/consentApi';
import { useConsentStore } from '../src/state/consentStore';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../src/data/accountScope';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

function statusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'video_analysis',
        active: false,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
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

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
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

describe('consentStore', () => {
  beforeEach(() => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    resetStore();
    clearApiSession();
  });

  it('defaults model training consent to off', () => {
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
  });

  it('represents a restored account without a bearer as restoring, not signed out', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    const fetchFn = jest.fn();

    await useConsentStore.getState().hydrate(fetchFn);

    expect(useConsentStore.getState()).toMatchObject({
      availability: 'restoring',
      modelTrainingActive: false,
      busy: false,
    });
    expect(fetchFn).not.toHaveBeenCalled();
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    expect(useConsentStore.getState().availability).toBe('restoring');
    expect(useConsentStore.getState().error).not.toMatch(/sign in/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resumes a restoring consent read on the first bearer without reloading on rotation', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    const fetchFn = jest.fn(async () => jsonResponse(statusBody(true)));
    await useConsentStore.getState().hydrate(fetchFn);

    establishApiSession(session);
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    establishApiSession({ ...session, bearerToken: 'rotated-token' });
    for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('clears a previous owner grant immediately when a different owner becomes live', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(true)));
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    const next = {
      ...session,
      canonicalAppUserId: 'b0000000-0000-4000-8000-000000000002',
    };
    setActiveDataOwner(next.canonicalAppUserId);
    establishApiSession(next);

    expect(useConsentStore.getState()).toMatchObject({
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
    });
  });

  it('ignores a previous A-generation grant without clearing the new generation busy state', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    let resolveOld!: (value: Response) => void;
    const oldRequest = useConsentStore.getState().setModelTrainingConsent(
      true,
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        }),
    );

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    clearApiSession();
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession({ ...session, bearerToken: 'new-generation' });
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(false)));
    let resolveCurrent!: (value: Response) => void;
    const currentRequest = useConsentStore.getState().setModelTrainingConsent(
      true,
      () =>
        new Promise(resolve => {
          resolveCurrent = resolve;
        }),
    );
    const stateBeforeOldResponse = useConsentStore.getState();

    resolveOld(jsonResponse(statusBody(true)));
    await oldRequest;
    expect(useConsentStore.getState()).toBe(stateBeforeOldResponse);
    expect(useConsentStore.getState().busy).toBe(true);
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    resolveCurrent(jsonResponse(statusBody(true)));
    await currentRequest;
    expect(useConsentStore.getState().busy).toBe(false);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('reports signed_out and stays off without a session', async () => {
    const fetchFn = jest.fn<
      ReturnType<ConsentFetch>,
      Parameters<ConsentFetch>
    >();
    await useConsentStore.getState().hydrate(fetchFn);
    expect(useConsentStore.getState().availability).toBe('signed_out');
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('hydrates from the server ledger', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    const fetchFn = jest.fn(() =>
      Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().hydrate(fetchFn);
    const state = useConsentStore.getState();
    expect(state.availability).toBe('ready');
    expect(state.modelTrainingActive).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith(
      'https://api.test/v1/me/consent/status',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('grants only via explicit action and reflects the server response', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    const fetchFn: jest.MockedFunction<ConsentFetch> = jest.fn(
      (_input: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse(statusBody(true))),
    );
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(true);
    expect(state.busy).toBe(false);
    const call = fetchFn.mock.calls[0];
    expect(call?.[0]).toBe('https://api.test/v1/me/consent/grant');
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body['scope']).toBe('model_training');
    expect(body['consentVersion']).toBe(MODEL_TRAINING_CONSENT_VERSION);
  });

  it('withdrawal turns consent off from the server response', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: true,
    });
    const fetchFn: jest.MockedFunction<ConsentFetch> = jest.fn(
      (_input: string, _init?: RequestInit) =>
        Promise.resolve(jsonResponse(statusBody(false))),
    );
    await useConsentStore.getState().setModelTrainingConsent(false, fetchFn);
    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(false);
    expect(fetchFn.mock.calls[0]?.[0]).toBe(
      'https://api.test/v1/me/consent/withdraw',
    );
  });

  it('does not keep an optimistic grant when the request fails', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    useConsentStore.setState({ availability: 'ready' });
    const fetchFn = jest.fn(() => Promise.reject(new Error('network down')));
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).not.toBeNull();
    expect(state.busy).toBe(false);
  });

  it('surfaces an invalid server response instead of guessing state', async () => {
    setActiveDataOwner(session.canonicalAppUserId);
    establishApiSession(session);
    const fetchFn = jest.fn(() =>
      Promise.resolve(jsonResponse({ nonsense: true })),
    );
    await useConsentStore.getState().hydrate(fetchFn);
    const state = useConsentStore.getState();
    expect(state.availability).toBe('unavailable');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).not.toBeNull();
  });
});
