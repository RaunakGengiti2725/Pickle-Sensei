/**
 * Adjudication reproduction (mobile-settings-account, base 4d812e1a).
 *
 * Candidate: consentStore has no same-session response ordering guard —
 * `hydrate()` and `setModelTrainingConsent()` only check that the ACCOUNT is
 * unchanged (`isCurrentSession`), so a slow status GET that lands after a
 * later grant/withdraw (or after a newer hydrate) overwrites the newer truth.
 *
 * Every test asserts the EXPECTED behaviour; a failure = defect reproduced.
 */
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

function statusBody(active: boolean) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

interface Deferred {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
}

/** A fetch whose every call is parked until the test releases it. */
function controlledFetch() {
  const calls: Array<{ url: string; method: string; deferred: Deferred }> = [];
  const fetchFn: ConsentFetch = (input, init) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? 'GET'),
        deferred: { resolve, reject },
      });
    });
  return { calls, fetchFn };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

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

afterEach(() => clearApiSession());

describe('consentStore same-session response ordering (repro)', () => {
  it('a status GET started before a grant must not undo the grant', async () => {
    const { calls, fetchFn } = controlledFetch();
    // Settings mount: hydrate (slow GET, parked).
    const hydrate = useConsentStore.getState().hydrate(fetchFn);
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/me/consent/status');

    // Simulate a store that is already ready (a previous fast hydrate) so
    // the toggle is enabled, then the user grants consent.
    useConsentStore.setState({ availability: 'ready' });
    const grant = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url).toContain('/v1/me/consent/grant');
    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await grant;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    // The slow GET (pre-grant snapshot) lands last.
    calls[0]!.deferred.resolve(jsonResponse(statusBody(false)));
    await hydrate;

    // EXPECTED: the newer, authoritative grant result stays.
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('two overlapping hydrates: the newer response wins', async () => {
    const { calls, fetchFn } = controlledFetch();
    const first = useConsentStore.getState().hydrate(fetchFn);
    await flush();
    const second = useConsentStore.getState().hydrate(fetchFn);
    await flush();
    expect(calls).toHaveLength(2);

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await second;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    calls[0]!.deferred.resolve(jsonResponse(statusBody(false)));
    await first;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('a stale hydrate failure landing after a newer success must not flip the store to unavailable', async () => {
    const { calls, fetchFn } = controlledFetch();
    const first = useConsentStore.getState().hydrate(fetchFn);
    await flush();
    const second = useConsentStore.getState().hydrate(fetchFn);
    await flush();

    calls[1]!.deferred.resolve(jsonResponse(statusBody(true)));
    await second;
    expect(useConsentStore.getState().availability).toBe('ready');

    calls[0]!.deferred.reject(new TypeError('Network request failed'));
    await first;
    expect(useConsentStore.getState().availability).toBe('ready');
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });
});
