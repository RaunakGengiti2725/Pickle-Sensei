import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import type { ConsentFetch } from '../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../src/account/consentApi';
import { useConsentStore } from '../src/state/consentStore';

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
    resetStore();
    clearApiSession();
  });

  it('defaults model training consent to off', () => {
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
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
