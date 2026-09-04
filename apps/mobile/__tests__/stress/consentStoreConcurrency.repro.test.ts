import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  MODEL_TRAINING_CONSENT_VERSION,
} from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

/**
 * Minimized, deterministic reproductions of what the seeded campaign in
 * `consentStoreConcurrency.stress.test.ts` found, plus the bounded-time and
 * same-tick-burst checks that need explicit control of timers.
 *
 * Plain `test` blocks are invariants that HOLD. `test.failing` blocks assert
 * the EXPECTED behaviour for invariants the store currently violates; when
 * the store is fixed they start failing and must be flipped to `test`.
 */

const sessionA = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-00000000000a',
  provider: 'apple' as const,
};

const sessionB = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-b-1',
  canonicalAppUserId: 'b0000000-0000-0000-0000-00000000000b',
  provider: 'google' as const,
};

function statusBody(active: boolean, lastActionAt: string | null = null) {
  return {
    subjectPseudonym: null,
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? MODEL_TRAINING_CONSENT_VERSION : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt,
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

interface Deferred {
  url: string;
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
}

const pendingRequests: Deferred[] = [];

/**
 * `test.failing` bodies stop at the first failed expectation, which can leave
 * requests (and their consentRequest timeout timers) open; drain them so Jest
 * exits cleanly.
 */
afterEach(() => {
  pendingRequests
    .splice(0)
    .forEach(r => r.reject(new Error('drained after test')));
});

/** Records every request and lets the test answer them in any order. */
function controllableFetch() {
  const requests: Deferred[] = [];
  const fetchFn: ConsentFetch = jest.fn(
    (url: string) =>
      new Promise<Response>((resolve, reject) => {
        const deferred = { url, resolve, reject };
        requests.push(deferred);
        pendingRequests.push(deferred);
      }),
  );
  return {
    fetchFn,
    requests,
    posts: () => requests.filter(r => !r.url.endsWith('/status')),
    gets: () => requests.filter(r => r.url.endsWith('/status')),
  };
}

const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
};

function resetStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

const store = () => useConsentStore.getState();

describe('consentStore concurrency — held invariants', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
  });

  test('I9: a same-tick burst of 500 toggles issues exactly one POST and every caller settles', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const burst = Array.from({ length: 500 }, (_, i) =>
      store().setModelTrainingConsent(i % 2 === 0, net.fetchFn),
    );
    expect(net.posts()).toHaveLength(1);
    expect(store().busy).toBe(true);
    net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
    await Promise.all(burst);
    expect(net.requests).toHaveLength(1);
    expect(store().busy).toBe(false);
    expect(store().modelTrainingActive).toBe(true);
  });

  test('I3: 200 same-tick hydrates all settle, none reject, the last delivered snapshot wins', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const burst = Array.from({ length: 200 }, () =>
      store().hydrate(net.fetchFn),
    );
    expect(net.gets()).toHaveLength(200);
    net.gets().forEach((r, i) => {
      if (i % 3 === 0) r.reject(new Error('network down'));
      else if (i % 3 === 1) r.resolve(jsonResponse({ nope: true }));
      else r.resolve(jsonResponse(statusBody(i % 2 === 1)));
    });
    await expect(Promise.all(burst)).resolves.toHaveLength(200);
    // Index 199: 199 % 3 === 1 → malformed; the last VALID response is 197.
    expect(store().availability).toBe('unavailable');
    expect(store().modelTrainingActive).toBe(false);
    expect(store().busy).toBe(false);
  });

  test('I3: a fetch that never answers is abandoned at CONSENT_REQUEST_TIMEOUT_MS and busy is released', async () => {
    jest.useFakeTimers();
    try {
      establishApiSession(sessionA);
      const fetchFn: ConsentFetch = jest.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      );
      const toggle = store().setModelTrainingConsent(true, fetchFn);
      const hydrate = store().hydrate(fetchFn);
      expect(store().busy).toBe(true);
      jest.advanceTimersByTime(CONSENT_REQUEST_TIMEOUT_MS - 1);
      await flush();
      expect(store().busy).toBe(true);
      jest.advanceTimersByTime(1);
      await Promise.all([toggle, hydrate]);
      expect(store().busy).toBe(false);
      expect(store().modelTrainingActive).toBe(false);
      expect(store().availability).toBe('unavailable');
      expect(store().error).toEqual(expect.any(String));
    } finally {
      jest.useRealTimers();
    }
  });

  test('I10: lastActionAt is passed through verbatim under clock skew', async () => {
    establishApiSession(sessionA);
    for (const stamp of [
      '2099-01-01T00:00:00.000Z',
      '1999-12-31T23:59:59.000Z',
      '2026-09-04T22:51:00+14:00',
      '0001-01-01T00:00:00.000Z',
      null,
    ]) {
      const fetchFn = jest.fn(() =>
        Promise.resolve(jsonResponse(statusBody(true, stamp))),
      );
      await store().hydrate(fetchFn);
      expect(store().lastActionAt).toBe(stamp);
    }
  });

  test('rotation: a bearer rotated mid-flight keeps the response for the same account', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const toggle = store().setModelTrainingConsent(true, net.fetchFn);
    establishApiSession({ ...sessionA, bearerToken: 'token-a-2' });
    net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
    await toggle;
    expect(store().availability).toBe('ready');
    expect(store().modelTrainingActive).toBe(true);
    expect(store().busy).toBe(false);
  });

  test('I2: a stale response never turns consent on for the next account', async () => {
    establishApiSession(sessionA);
    const net = controllableFetch();
    const staleGrant = store().setModelTrainingConsent(true, net.fetchFn);
    const staleHydrate = store().hydrate(net.fetchFn);
    clearApiSession();
    establishApiSession(sessionB);
    await store().hydrate(() =>
      Promise.resolve(jsonResponse(statusBody(false))),
    );
    net.requests.forEach(r =>
      r.resolve(jsonResponse(statusBody(true, '2026-01-01T00:00:00.000Z'))),
    );
    await Promise.all([staleGrant, staleHydrate]);
    expect(store().modelTrainingActive).toBe(false);
    expect(store().lastActionAt).toBeNull();
    expect(store().availability).toBe('ready');
  });
});

describe('consentStore concurrency — reproduced violations (expected behaviour asserted)', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
  });

  test.failing(
    "I8 (campaign seed 1, fifo): the previous account's late hydrate response clears busy under the next account's in-flight grant",
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const staleHydrate = store().hydrate(net.fetchFn);
      clearApiSession();
      establishApiSession(sessionB);
      const grantB = store().setModelTrainingConsent(true, net.fetchFn);
      expect(store().busy).toBe(true);

      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await staleHydrate;
      // EXPECTED: B's grant is still in flight, the toggle stays busy.
      expect(store().busy).toBe(true);

      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grantB;
    },
  );

  test.failing(
    'I1 (campaign seed 1, fifo): once busy was clobbered, a second grant for the same account goes out while the first is in flight',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const staleHydrate = store().hydrate(net.fetchFn);
      clearApiSession();
      establishApiSession(sessionB);
      const grant1 = store().setModelTrainingConsent(true, net.fetchFn);
      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await staleHydrate;

      const grant2 = store().setModelTrainingConsent(false, net.fetchFn);
      // EXPECTED: the busy guard drops the duplicate; only one POST exists.
      expect(net.posts()).toHaveLength(1);

      net.posts().forEach(r => r.resolve(jsonResponse(statusBody(true))));
      await Promise.all([grant1, grant2]);
    },
  );

  test.failing(
    'I6 (campaign seed 2, fifo): a successful hydrate must clear the error a concurrent failed hydrate left behind',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const first = store().hydrate(net.fetchFn);
      const second = store().hydrate(net.fetchFn);
      net.gets()[0]!.resolve(jsonResponse({ scopes: 'nope' }));
      await first;
      expect(store().availability).toBe('unavailable');
      net.gets()[1]!.resolve(jsonResponse(statusBody(false)));
      await second;
      expect(store().availability).toBe('ready');
      // EXPECTED: no error beside a freshly loaded, healthy toggle.
      expect(store().error).toBeNull();
    },
  );

  test.failing(
    'I6: a successful grant must clear the error a concurrent failed hydrate left behind',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const grant = store().setModelTrainingConsent(true, net.fetchFn);
      const hydrate = store().hydrate(net.fetchFn);
      net.gets()[0]!.reject(new Error('network down'));
      await hydrate;
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
      expect(store().availability).toBe('ready');
      expect(store().modelTrainingActive).toBe(true);
      expect(store().error).toBeNull();
    },
  );

  test.failing(
    'I5 (campaign seed 52, reorder): a GET issued before a grant but answered after it must not overwrite the grant result',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const hydrate = store().hydrate(net.fetchFn); // server snapshot: off
      const grant = store().setModelTrainingConsent(true, net.fetchFn); // ledger → on
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
      expect(store().modelTrainingActive).toBe(true);
      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await hydrate;
      // EXPECTED: the store agrees with the server ledger (on).
      expect(store().modelTrainingActive).toBe(true);
    },
  );

  test.failing(
    'I5 (campaign seed 8, reorder): a hydrate from before sign-out must not overwrite a grant made after signing back in',
    async () => {
      establishApiSession(sessionA);
      const net = controllableFetch();
      const oldHydrate = store().hydrate(net.fetchFn); // snapshot: off
      clearApiSession();
      await store().hydrate();
      establishApiSession({ ...sessionA, bearerToken: 'token-a-2' });
      const grant = store().setModelTrainingConsent(true, net.fetchFn);
      net.posts()[0]!.resolve(jsonResponse(statusBody(true)));
      await grant;
      expect(store().modelTrainingActive).toBe(true);
      net.gets()[0]!.resolve(jsonResponse(statusBody(false)));
      await oldHydrate;
      expect(store().modelTrainingActive).toBe(true);
    },
  );
});
