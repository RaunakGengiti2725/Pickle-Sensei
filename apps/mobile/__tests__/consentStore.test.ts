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

  describe('same-session response ordering', () => {
    interface PendingCall {
      url: string;
      resolve: (response: Response) => void;
      reject: (error: Error) => void;
    }

    function manualFetch() {
      const calls: PendingCall[] = [];
      const fetchFn: ConsentFetch = jest.fn(
        (url: string) =>
          new Promise<Response>((resolve, reject) => {
            calls.push({ url, resolve, reject });
          }),
      );
      return { fetchFn, calls };
    }

    beforeEach(() => {
      establishApiSession(session);
    });

    it('an older status GET cannot undo a newer grant', async () => {
      useConsentStore.setState({ availability: 'ready' });
      const { fetchFn, calls } = manualFetch();
      const hydrating = useConsentStore.getState().hydrate(fetchFn);
      const granting = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn);
      expect(calls.map(c => c.url)).toEqual([
        'https://api.test/v1/me/consent/status',
        'https://api.test/v1/me/consent/grant',
      ]);

      calls[1]!.resolve(jsonResponse(statusBody(true)));
      await granting;
      calls[0]!.resolve(jsonResponse(statusBody(false)));
      await hydrating;

      const state = useConsentStore.getState();
      expect(state.availability).toBe('ready');
      expect(state.modelTrainingActive).toBe(true);
      expect(state.busy).toBe(false);
      expect(state.error).toBeNull();
    });

    it('the newer of two overlapping hydrates wins regardless of arrival order', async () => {
      const { fetchFn, calls } = manualFetch();
      const first = useConsentStore.getState().hydrate(fetchFn);
      const second = useConsentStore.getState().hydrate(fetchFn);

      calls[1]!.resolve(jsonResponse(statusBody(true)));
      await second;
      calls[0]!.resolve(jsonResponse(statusBody(false)));
      await first;

      expect(useConsentStore.getState().availability).toBe('ready');
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    });

    it('a stale hydrate failure after a newer success leaves the store ready', async () => {
      const { fetchFn, calls } = manualFetch();
      const first = useConsentStore.getState().hydrate(fetchFn);
      const second = useConsentStore.getState().hydrate(fetchFn);

      calls[1]!.resolve(jsonResponse(statusBody(true)));
      await second;
      calls[0]!.reject(new Error('network down'));
      await first;

      const state = useConsentStore.getState();
      expect(state.availability).toBe('ready');
      expect(state.modelTrainingActive).toBe(true);
      expect(state.error).toBeNull();
    });

    it('a stale grant response only releases busy; the newer hydrate owns the ledger', async () => {
      useConsentStore.setState({ availability: 'ready' });
      const { fetchFn, calls } = manualFetch();
      const granting = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn);
      const hydrating = useConsentStore.getState().hydrate(fetchFn);
      expect(useConsentStore.getState().busy).toBe(true);

      calls[1]!.resolve(jsonResponse(statusBody(false)));
      await hydrating;
      expect(useConsentStore.getState().busy).toBe(true);
      calls[0]!.resolve(jsonResponse(statusBody(true)));
      await granting;

      const state = useConsentStore.getState();
      expect(state.availability).toBe('ready');
      expect(state.modelTrainingActive).toBe(false);
      expect(state.busy).toBe(false);
    });

    it('a stale hydrate never releases busy for a set that is still in flight', async () => {
      useConsentStore.setState({ availability: 'ready' });
      const { fetchFn, calls } = manualFetch();
      const hydrating = useConsentStore.getState().hydrate(fetchFn);
      const granting = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn);

      calls[0]!.resolve(jsonResponse(statusBody(false)));
      await hydrating;
      expect(useConsentStore.getState().busy).toBe(true);

      calls[1]!.resolve(jsonResponse(statusBody(true)));
      await granting;
      expect(useConsentStore.getState().busy).toBe(false);
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    });

    it('a failed set that superseded a loading hydrate reports unavailable, not loading forever', async () => {
      const { fetchFn, calls } = manualFetch();
      const hydrating = useConsentStore.getState().hydrate(fetchFn);
      const granting = useConsentStore
        .getState()
        .setModelTrainingConsent(true, fetchFn);
      expect(useConsentStore.getState().availability).toBe('loading');

      calls[1]!.reject(new Error('network down'));
      await granting;
      calls[0]!.resolve(jsonResponse(statusBody(true)));
      await hydrating;

      const state = useConsentStore.getState();
      expect(state.availability).toBe('unavailable');
      expect(state.modelTrainingActive).toBe(false);
      expect(state.busy).toBe(false);
      expect(state.error).not.toBeNull();
    });
  });
});
