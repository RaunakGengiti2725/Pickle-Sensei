import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../src/account/apiSession';
import { fetchCanonicalOnboardingProfile } from '../src/account/onboarding';
import type { ConsentFetch } from '../src/account/consentApi';
import { useConsentStore } from '../src/state/consentStore';

/**
 * Adjudication reproductions for stress area mobile-auth-account-3
 * (canonical /v1/me interpretation and consentStore request ordering),
 * baseline 1fb0efd7f3157060af4c61342f5102e068d2ddc5.
 *
 *   cd apps/mobile && npx jest --ci __tests__/adjudicateStressMobileAuthAccount3Network.test.ts
 *
 * `hazard` blocks pin the defective behaviour observed on the baseline;
 * `test.failing` blocks assert the product contract and are the acceptance
 * tests — a fix promotes them to plain `test` and removes the hazard pin.
 */

const sessionA: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'bearer-a',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};
const sessionB: ApiSession = {
  ...sessionA,
  bearerToken: 'bearer-b',
  canonicalAppUserId: '22222222-2222-4222-8222-222222222222',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('E. GET /v1/me 200 with a non-document body is read as "no profile"', () => {
  const html = () =>
    new Response('<html><body>gateway</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });

  test('hazard: an HTML 200 body resolves to null (the Gate then shows the questionnaire)', async () => {
    await expect(
      fetchCanonicalOnboardingProfile(sessionA, async () => html()),
    ).resolves.toBeNull();
  });

  test('hazard: an array / partial-profile 200 body resolves to null', async () => {
    await expect(
      fetchCanonicalOnboardingProfile(sessionA, async () => jsonResponse([])),
    ).resolves.toBeNull();
    await expect(
      fetchCanonicalOnboardingProfile(sessionA, async () =>
        jsonResponse({
          onboardingState: 'complete',
          profile: { skill_level: '3.5' },
        }),
      ),
    ).resolves.toBeNull();
  });

  test.failing(
    'expected: a 200 that is not a /v1/me document is a sync error, not "not onboarded"',
    async () => {
      await expect(
        fetchCanonicalOnboardingProfile(sessionA, async () => html()),
      ).rejects.toThrow();
    },
  );

  test.failing(
    'expected: a complete account whose profile fails to parse is a sync error, not "not onboarded"',
    async () => {
      await expect(
        fetchCanonicalOnboardingProfile(sessionA, async () =>
          jsonResponse({
            onboardingState: 'complete',
            profile: { skill_level: '3.5' },
          }),
        ),
      ).rejects.toThrow();
    },
  );
});

type Deferred = {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  method: string;
  settled: boolean;
};

/** Every request left in flight by a failed assertion is drained in
 * afterEach so the 15 s consentApi abort timers do not outlive the suite. */
let inFlight: Deferred[] = [];

function controllableFetch() {
  const calls: Deferred[] = [];
  const fetchFn: ConsentFetch = (_url, init) =>
    new Promise<Response>((resolve, reject) => {
      const call: Deferred = {
        method: init?.method ?? 'GET',
        settled: false,
        resolve: r => {
          call.settled = true;
          resolve(r);
        },
        reject: e => {
          call.settled = true;
          reject(e);
        },
      };
      calls.push(call);
      inFlight.push(call);
    });
  return {
    fetchFn,
    gets: () => calls.filter(c => c.method === 'GET'),
    posts: () => calls.filter(c => c.method === 'POST'),
  };
}

const statusBody = (active: boolean) => ({
  subjectPseudonym: 'p',
  scopes: [
    {
      scope: 'model_training',
      active,
      consentVersion: 'model-training-v1',
      lastAction: active ? 'granted' : 'withdrawn',
      lastActionAt: '2026-09-01T00:00:00Z',
    },
  ],
});

const consent = () => useConsentStore.getState();

describe('F. consentStore has no request-generation guard', () => {
  afterEach(async () => {
    inFlight
      .filter(c => !c.settled)
      .forEach(c => c.resolve(jsonResponse(statusBody(false))));
    inFlight = [];
    await new Promise<void>(r => setTimeout(r, 0));
  });

  beforeEach(() => {
    clearApiSession();
    useConsentStore.setState({
      availability: 'loading',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
    });
  });

  test("hazard (I8/I1): the previous account's late hydrate clears busy under the next account's in-flight grant, letting a duplicate POST out", async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const staleHydrate = consent().hydrate(net.fetchFn);
    clearApiSession();
    establishApiSession(sessionB);
    const grant = consent().setModelTrainingConsent(true, net.fetchFn);
    expect(consent().busy).toBe(true);

    net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
    await staleHydrate;
    expect(consent().busy).toBe(false);

    const duplicate = consent().setModelTrainingConsent(false, net.fetchFn);
    expect(net.posts()).toHaveLength(2);
    net.posts().forEach(p => p.resolve(jsonResponse(statusBody(true))));
    await Promise.all([grant, duplicate]);
  });

  test.failing(
    'expected (I8): a stale-account response never clears busy while a current mutation is in flight',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const staleHydrate = consent().hydrate(net.fetchFn);
      clearApiSession();
      establishApiSession(sessionB);
      const grant = consent().setModelTrainingConsent(true, net.fetchFn);
      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await staleHydrate;
      expect(consent().busy).toBe(true);
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
    },
  );

  test('hazard (I5): a GET issued before a grant but answered after it overwrites the grant result', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const hydrate = consent().hydrate(net.fetchFn);
    const grant = consent().setModelTrainingConsent(true, net.fetchFn);
    net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
    await grant;
    expect(consent().modelTrainingActive).toBe(true);
    net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
    await hydrate;
    expect(consent().modelTrainingActive).toBe(false);
  });

  test.failing(
    'expected (I5): an older response never overwrites a newer mutation result',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const hydrate = consent().hydrate(net.fetchFn);
      const grant = consent().setModelTrainingConsent(true, net.fetchFn);
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await hydrate;
      expect(consent().modelTrainingActive).toBe(true);
    },
  );

  test('hazard (I6): a successful grant leaves the error a concurrent failed hydrate wrote', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const grant = consent().setModelTrainingConsent(true, net.fetchFn);
    const hydrate = consent().hydrate(net.fetchFn);
    net.gets()[0]!.reject(new Error('network down'));
    await hydrate;
    net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
    await grant;
    expect(consent().availability).toBe('ready');
    expect(consent().modelTrainingActive).toBe(true);
    expect(consent().error).not.toBeNull();
  });

  test.failing(
    'expected (I6): a ready toggle never sits beside a stale error',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const grant = consent().setModelTrainingConsent(true, net.fetchFn);
      const hydrate = consent().hydrate(net.fetchFn);
      net.gets()[0]!.reject(new Error('network down'));
      await hydrate;
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
      expect(consent().error).toBeNull();
    },
  );
});
