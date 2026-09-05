/**
 * Minimized, deterministic replays of the failure modes the seeded campaigns
 * (consentStoreLifecycle / accountClientsInterleaving .stress.test.ts)
 * surface in consentStore and the onboarding client.
 *
 * Each `test.failing` block asserts the EXPECTED behaviour and therefore
 * passes only while the race is still present. When consentStore is fixed
 * the block starts failing — flip it to a plain `it` at that point so the
 * fix stays pinned (same convention as adjudicateXcUxA11yI18nLibrary).
 *
 * Original seeds (STRESS_ITER=500, STRESS_STRICT=1):
 *  - race 1: 1188126889, 1189449362 (stale hydrate clears `busy` → two
 *    mutations of the same account in flight);
 *  - race 2: 1188895032, 1190336290 (older status read lands after a newer
 *    mutation and overwrites it — lost update on screen);
 *  - race 3: 1188491163, 1188546596 (`busy` owned by the previous account
 *    keeps the new account's toggle disabled until that request settles);
 *  - onboarding: any accountClientsInterleaving seed whose plan contains an
 *    `onboarding_fetch` with an `ok_non_json` reply (a 2xx with an
 *    unparseable body reads as "no canonical profile").
 */
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import type { ConsentFetch } from '../../../src/account/consentApi';
import {
  OnboardingSyncError,
  fetchCanonicalOnboardingProfile,
} from '../../../src/account/onboarding';
import { useConsentStore } from '../../../src/state/consentStore';

const API = 'https://api.example.test/functions/v1/api';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Pending {
  bearer: string;
  path: string;
  resolve: (active: boolean) => void;
  fail: () => void;
}

/** A fetch whose replies are released by hand, in any order. */
function manualFetch(): { fetch: ConsentFetch; pending: Pending[] } {
  const pending: Pending[] = [];
  const fetch: ConsentFetch = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const headers = init?.headers as Record<string, string>;
      const entry: Pending = {
        bearer: (headers['Authorization'] ?? '').replace('Bearer ', ''),
        path: url.replace(API, ''),
        resolve: active =>
          resolve(
            new Response(
              JSON.stringify({
                subjectPseudonym: null,
                scopes: [
                  {
                    scope: 'model_training',
                    active,
                    consentVersion: null,
                    lastAction: active ? 'granted' : 'withdrawn',
                    lastActionAt: null,
                  },
                ],
              }),
              { status: 200 },
            ),
          ),
        fail: () => reject(new TypeError('Network request failed')),
      };
      pending.push(entry);
      init?.signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
      );
    });
  return { fetch, pending };
}

/** Let a released reply be parsed (Response.json) and applied by the store. */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await jest.advanceTimersByTimeAsync(1);
};

const signIn = (id: string, bearer: string) =>
  establishApiSession({
    apiBaseUrl: API,
    bearerToken: bearer,
    canonicalAppUserId: id,
    provider: 'apple',
  });

const mutationsOf = (pending: Pending[]) =>
  pending.filter(p => p.path !== '/v1/me/consent/status');

beforeEach(() => {
  jest.useFakeTimers();
  clearApiSession();
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
});
afterEach(() => {
  clearApiSession();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('known races (minimized from the seeded campaigns)', () => {
  test.failing(
    'race 1: a stale status read from the previous account must not re-open the busy gate while the current account has a mutation in flight',
    async () => {
      const { fetch, pending } = manualFetch();
      const store = useConsentStore.getState();

      signIn(A, 'a1');
      void store.hydrate(fetch); // GET(A) — slow
      await flush();

      // Sign out, sign in as B, B's status lands promptly.
      clearApiSession();
      signIn(B, 'b1');
      void store.hydrate(fetch); // GET(B)
      await flush();
      pending[1]?.resolve(false);
      await flush();
      expect(useConsentStore.getState().availability).toBe('ready');

      // B toggles on → POST grant(B) in flight, gate closed.
      void store.setModelTrainingConsent(true, fetch);
      await flush();
      expect(useConsentStore.getState().busy).toBe(true);
      expect(mutationsOf(pending)).toHaveLength(1);

      // A's slow status read finally lands — it is stale and ignored…
      pending[0]?.resolve(true);
      await flush();

      // …but it must not have re-opened the gate: a second tap while
      // grant(B) is still outstanding must be dropped, not sent.
      void store.setModelTrainingConsent(false, fetch);
      await flush();
      expect(useConsentStore.getState().busy).toBe(true);
      expect(mutationsOf(pending)).toHaveLength(1);
    },
  );

  test.failing(
    'race 2: a status read issued BEFORE a mutation must not overwrite the mutation result when it lands later',
    async () => {
      const { fetch, pending } = manualFetch();
      const store = useConsentStore.getState();

      signIn(A, 'a1');
      void store.hydrate(fetch); // GET #1 (e.g. Settings focus) — slow
      await flush();
      void store.hydrate(fetch); // GET #2 (consent screen mount) — fast
      await flush();
      pending[1]?.resolve(false);
      await flush();
      expect(useConsentStore.getState()).toMatchObject({
        availability: 'ready',
        modelTrainingActive: false,
        busy: false,
      });

      // User grants; the server confirms active=true.
      void store.setModelTrainingConsent(true, fetch);
      await flush();
      pending[2]?.resolve(true);
      await flush();
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);

      // GET #1 (processed before the grant) lands last with the OLD ledger.
      pending[0]?.resolve(false);
      await flush();

      // The newer server truth (granted) must survive the older read.
      expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    },
  );

  test.failing(
    "race 3: after an account switch the new account's toggle must not stay disabled behind the previous account's in-flight mutation",
    async () => {
      const { fetch, pending } = manualFetch();
      const store = useConsentStore.getState();

      signIn(A, 'a1');
      void store.hydrate(fetch);
      await flush();
      pending[0]?.resolve(false);
      await flush();
      void store.setModelTrainingConsent(true, fetch); // POST grant(A) — slow
      await flush();
      expect(useConsentStore.getState().busy).toBe(true);

      // Switch to B; B's status lands and the screen is `ready`.
      clearApiSession();
      signIn(B, 'b1');
      void store.hydrate(fetch);
      await flush();
      pending[2]?.resolve(false);
      await flush();
      expect(useConsentStore.getState().availability).toBe('ready');

      // B is ready and owns no request: the toggle must be enabled.
      expect(useConsentStore.getState().busy).toBe(false);
      void store.setModelTrainingConsent(true, fetch);
      await flush();
      expect(mutationsOf(pending).filter(p => p.bearer === 'b1')).toHaveLength(
        1,
      );
    },
  );

  test.failing(
    'onboarding: a 2xx /v1/me with an unparseable body must be an error, not "no canonical profile"',
    async () => {
      const session = {
        apiBaseUrl: API,
        bearerToken: 'a1',
        canonicalAppUserId: A,
        provider: 'apple' as const,
      };
      const fetch = () =>
        Promise.resolve(
          new Response('<html>maintenance</html>', {
            status: 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        );
      // `null` means "this account has not completed onboarding" to appStore
      // (fresh install → onboarding is shown again → the re-answered profile
      // is PUT over the server row). A malformed 2xx must instead surface as
      // OnboardingSyncError so hydrate keeps the user out of onboarding.
      await expect(
        fetchCanonicalOnboardingProfile(session, fetch),
      ).rejects.toBeInstanceOf(OnboardingSyncError);
    },
  );

  it('control: within one uninterrupted session the busy gate serializes toggles', async () => {
    const { fetch, pending } = manualFetch();
    const store = useConsentStore.getState();
    signIn(A, 'a1');
    void store.hydrate(fetch);
    await flush();
    pending[0]?.resolve(false);
    await flush();

    const first = store.setModelTrainingConsent(true, fetch);
    const second = store.setModelTrainingConsent(false, fetch);
    const third = store.setModelTrainingConsent(true, fetch);
    await flush();
    expect(mutationsOf(pending)).toHaveLength(1);
    pending[1]?.resolve(true);
    await Promise.all([first, second, third]);
    expect(useConsentStore.getState()).toMatchObject({
      modelTrainingActive: true,
      busy: false,
      error: null,
    });
  });
});
