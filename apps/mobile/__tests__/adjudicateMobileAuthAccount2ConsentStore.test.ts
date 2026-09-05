/**
 * Adjudication replay (stress area mobile-auth-account-2, baseline 1fb0efd7).
 *
 * consentStore has no per-request ordering: a `hydrate()` GET that was issued
 * BEFORE a `setModelTrainingConsent()` mutation but resolves AFTER it writes
 * the older server snapshot over the newer one (single account, no switch).
 * Two GETs are in flight whenever SettingsScreen and ConsentSettingsScreen
 * both mount (each hydrates on [session]); the toggle re-enables as soon as
 * the first one lands.
 *
 * The account-switch variants (a stale response of account A calling
 * `staleSessionState()` → `{busy:false}` while account B has a mutation in
 * flight) are replayed as well for the record; they need the previous
 * account's request to outlive a sign-out + sign-in (≤15 s timeout).
 *
 * Each `it` FAILS on the baseline except the ones labelled control.
 */
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import type { ConsentFetch } from '../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../src/account/consentApi';
import { useConsentStore } from '../src/state/consentStore';

const accountA = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a',
  canonicalAppUserId: 'a0000000-0000-0000-0000-00000000000a',
  provider: 'apple' as const,
};
const accountB = {
  ...accountA,
  bearerToken: 'token-b',
  canonicalAppUserId: 'b0000000-0000-0000-0000-00000000000b',
};

function statusBody(active: boolean) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-00000000000c',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt: '2026-09-01T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Deferred {
  resolve: (r: Response) => void;
  promise: Promise<Response>;
}
function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(r => {
    resolve = r;
  });
  return { resolve, promise };
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

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('adjudication: consentStore request ordering', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
  });

  it('a hydrate GET issued before a grant must not overwrite the granted state when it lands later (single account)', async () => {
    establishApiSession(accountA);
    const slowGet = deferred();
    const fetchFn: ConsentFetch = jest.fn((_url, init) => {
      if (init?.method === 'GET') return slowGet.promise;
      return Promise.resolve(jsonResponse(statusBody(true)));
    });
    // A second (fast) hydrate makes the toggle enabled — as when
    // SettingsScreen and ConsentSettingsScreen both mount.
    const hydrateSlow = useConsentStore.getState().hydrate(fetchFn);
    useConsentStore.setState({ availability: 'ready' });
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    slowGet.resolve(jsonResponse(statusBody(false)));
    await hydrateSlow;
    console.log(
      `[adjudicate] lost update: modelTrainingActive after stale GET landed = ${String(
        useConsentStore.getState().modelTrainingActive,
      )}`,
    );
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
  });

  it('a stale hydrate GET of the previous account must not clear busy while the current account has a mutation in flight', async () => {
    establishApiSession(accountA);
    const slowGetA = deferred();
    const hydrateA = useConsentStore.getState().hydrate(() => slowGetA.promise);

    establishApiSession(accountB);
    useConsentStore.setState({ availability: 'ready', busy: false });
    const slowPutB = deferred();
    const putCalls: string[] = [];
    const fetchB: ConsentFetch = jest.fn((url, init) => {
      putCalls.push(`${init?.method ?? 'GET'} ${url}`);
      return slowPutB.promise;
    });
    const toggleB1 = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchB);
    await flush();
    expect(useConsentStore.getState().busy).toBe(true);

    slowGetA.resolve(jsonResponse(statusBody(false)));
    await hydrateA;
    console.log(
      `[adjudicate] busy after stale GET(A) landed while PUT(B) in flight = ${String(
        useConsentStore.getState().busy,
      )}`,
    );
    expect(useConsentStore.getState().busy).toBe(true);

    // With busy cleared, a second toggle issues a second concurrent mutation.
    const toggleB2 = useConsentStore
      .getState()
      .setModelTrainingConsent(false, fetchB);
    await flush();
    expect(putCalls.filter(c => c.startsWith('POST')).length).toBe(1);

    slowPutB.resolve(jsonResponse(statusBody(true)));
    await Promise.all([toggleB1, toggleB2]);
  });

  it('control: within one account the busy gate serializes toggles (HELD)', async () => {
    establishApiSession(accountA);
    useConsentStore.setState({ availability: 'ready' });
    const slowPut = deferred();
    const fetchFn: ConsentFetch = jest.fn(() => slowPut.promise);
    const first = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    await flush();
    await useConsentStore.getState().setModelTrainingConsent(false, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    slowPut.resolve(jsonResponse(statusBody(true)));
    await first;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().busy).toBe(false);
  });
});
