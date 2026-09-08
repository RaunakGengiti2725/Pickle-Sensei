/**
 * INT-networking-recovery adversarial probe — transport bounds.
 *
 * Attacks the HTTP clients the shipping app actually calls with two hostile
 * servers a real network produces:
 *
 *   1. A redirecting origin (the API gateway itself, or a TLS-intercepting
 *      corporate proxy — plain captive portals cannot forge the HTTPS origin).
 *      React Native 0.87 ships whatwg-fetch 3.6.20 as `global.fetch`, an
 *      XMLHttpRequest polyfill: it ignores `RequestInit.redirect` (the native
 *      stack follows the 30x), its Response has NO `redirected` property, and
 *      `response.url` is the XHR `responseURL` — i.e. the FINAL url. Whether
 *      the native stack re-sends the Authorization header / JSON body to a
 *      cross-origin target is a device-level question this Jest run cannot
 *      settle. What it CAN verify: (a) the runtime fact above, (b) whether
 *      each bearer-carrying client even asks for `redirect: 'error'` (fetch-
 *      standard hygiene; the repo's own deletion transport does), and (c) the
 *      one defence that works on this runtime — whether a body whose
 *      `response.url` is off the API origin is nevertheless trusted as a sync
 *      acknowledgement / token grant.
 *
 *   2. A server that answers the status line + headers promptly but then
 *      never finishes the body, or never answers at all. Every client must
 *      settle within its own documented deadline — an unbounded `await` is a
 *      spinner the user cannot dismiss, and for the session keeper it is a
 *      wedge that silently ends bearer rotation. Caveat recorded per test:
 *      under whatwg-fetch the promise resolves only in `xhr.onload`, i.e.
 *      after the WHOLE body, so "headers now, body never" cannot split a
 *      request on the shipping runtime; it is reachable only under a
 *      streaming fetch. "Never answers at all" is reachable on every runtime.
 *
 * Each `it` is one attack; a failing `it` is a break on HEAD whose severity
 * the report classifies with the runtime caveats above. Runs fully on
 * Linux/Jest: no simulator, no provider, no production Supabase.
 */
import { readFileSync } from 'fs';
import { AppState } from 'react-native';
import {
  API_REQUEST_TIMEOUT_MS,
  createAnalysisPermitClient,
  createTransport,
} from '../../src/data/api';
import {
  refreshApiSession,
  revokeApiSession,
} from '../../src/account/sessionLifecycle';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import type { ApiSession } from '../../src/account/apiSession';
import { fetchCanonicalProgress } from '../../src/progress/api';
import { fetchPlayerRank } from '../../src/progress/playerRank';
import { createTrainingApi } from '../../src/training/api';
import { fetchConsentStatus } from '../../src/account/consentApi';
import { fetchCanonicalOnboardingProfile } from '../../src/account/onboarding';
import {
  BILLING_REQUEST_TIMEOUT_MS,
  createCanonicalAccessClient,
} from '../../src/billing/accessApi';

const API_ORIGIN = 'https://api.test';
const ATTACKER_ORIGIN = 'https://attacker.example';

const session: ApiSession = {
  apiBaseUrl: API_ORIGIN,
  bearerToken: 'bearer-secret',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
  refreshToken: 'refresh-secret',
  bearerExpiresAtMs: null,
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface RecordedRequest {
  url: string;
  redirect: RequestInit['redirect'];
  authorization: string | null;
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  if (Array.isArray(headers)) {
    const hit = headers.find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    );
    return hit ? hit[1] : null;
  }
  const record = headers as Record<string, string>;
  const key = Object.keys(record).find(
    k => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? record[key]! : null;
}

/** A 200 JSON response that fetch reports as having been redirected off the
 * API origin — exactly what RN's fetch yields after following a 30x. */
function redirectedJson(body: unknown): Response {
  const response = new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  Object.defineProperty(response, 'redirected', { value: true });
  Object.defineProperty(response, 'url', {
    value: `${ATTACKER_ORIGIN}/collect`,
  });
  return response;
}

/** Status + headers now, body never — unless the caller aborts its own
 * request signal, in which case the body stream errors exactly like a real
 * fetch body does. A client that keeps its deadline alive across the body
 * read therefore settles; one that clears it after the headers hangs. */
function stalledBody(init?: RequestInit): Response {
  const signal = init?.signal;
  // Jest runs on Node's WHATWG fetch, whose Response accepts a stream body;
  // React Native's Response typings predate that, hence the cast.
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const fail = () =>
        controller.error(new DOMException('Aborted', 'AbortError'));
      if (signal?.aborted) fail();
      else signal?.addEventListener('abort', fail);
    },
  }) as unknown as ConstructorParameters<typeof Response>[0];
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Neither status nor body — rejects only if the caller aborts. */
function hungHeaders(init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')));
  });
}

function recordingFetch(
  respond: (init?: RequestInit) => Promise<Response> | Response,
): { fetchFn: FetchLike; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    requests.push({
      url,
      redirect: init?.redirect,
      authorization: headerOf(init, 'authorization'),
    });
    return respond(init);
  };
  return { fetchFn, requests };
}

function settleProbe<T>(promise: Promise<T>) {
  const probe = jest.fn();
  promise.then(
    value => probe('resolved', value),
    error => probe('rejected', error),
  );
  return probe;
}

describe('ADV networking-recovery: redirects on bearer-carrying requests', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  interface RedirectAttack {
    client: string;
    run: (fetchFn: FetchLike) => Promise<unknown>;
  }

  const attacks: RedirectAttack[] = [
    {
      client: 'data/api.ts createTransport().syncShots (outbox bearer)',
      run: async fetchFn => {
        globalThis.fetch = fetchFn as unknown as typeof fetch;
        return createTransport({
          baseUrl: API_ORIGIN,
          token: session.bearerToken,
        }).syncShots([]);
      },
    },
    {
      client: 'data/api.ts createAnalysisPermitClient().reserve',
      run: async fetchFn => {
        globalThis.fetch = fetchFn as unknown as typeof fetch;
        return createAnalysisPermitClient({
          baseUrl: API_ORIGIN,
          token: session.bearerToken,
        }).reserve('idem-redirect');
      },
    },
    {
      client:
        'account/sessionLifecycle.ts refreshApiSession (refresh token in body)',
      run: fetchFn =>
        refreshApiSession(
          { apiBaseUrl: API_ORIGIN, refreshToken: session.refreshToken! },
          { fetchFn },
        ),
    },
    {
      client: 'progress/api.ts fetchCanonicalProgress',
      run: fetchFn => fetchCanonicalProgress(session, fetchFn),
    },
    {
      client: 'progress/playerRank.ts fetchPlayerRank',
      run: fetchFn => fetchPlayerRank(session, fetchFn),
    },
    {
      client: 'training/api.ts createTrainingApi().listCatalogDrills',
      run: fetchFn =>
        createTrainingApi({
          baseUrl: API_ORIGIN,
          token: session.bearerToken,
          fetchFn,
        }).listCatalogDrills({}),
    },
    {
      client: 'account/consentApi.ts fetchConsentStatus',
      run: fetchFn => fetchConsentStatus(session, fetchFn),
    },
    {
      client: 'account/onboarding.ts fetchCanonicalOnboardingProfile',
      run: fetchFn => fetchCanonicalOnboardingProfile(session, fetchFn),
    },
    {
      client: 'billing/accessApi.ts createCanonicalAccessClient().getAccess',
      run: fetchFn =>
        createCanonicalAccessClient({
          baseUrl: API_ORIGIN,
          token: session.bearerToken,
          fetchFn,
        }).getAccess(),
    },
  ];

  it('runtime fact: RN 0.87 global.fetch is whatwg-fetch — `redirect` is ignored and Response has no `redirected` flag', () => {
    const rnFetchSource = readFileSync(
      require.resolve('react-native/Libraries/Network/fetch.js'),
      'utf8',
    );
    expect(rnFetchSource).toContain("require('whatwg-fetch')");
    const whatwg = jest.requireActual<{
      Response: new (body: string, init?: ResponseInit) => Response;
      fetch: { polyfill?: boolean };
    }>('whatwg-fetch');
    const response = new whatwg.Response('{}', { status: 200 });
    // No `redirected` at all: a client that requires `redirected === false`
    // rejects every response, one that requires `=== true` never fires.
    expect('redirected' in response).toBe(false);
    expect(whatwg.fetch.polyfill).toBe(true);
  });

  // The bearer / refresh token leaves the device the moment the stack FOLLOWS
  // the 30x; refusing the body afterwards is too late. Under a spec-compliant
  // fetch the client-side defence is `redirect: 'error'` (or 'manual');
  // whatwg-fetch ignores it, so this probe is hygiene evidence only.
  for (const attack of attacks) {
    it(`${attack.client}: asks fetch not to follow redirects (redirect:'error'|'manual')`, async () => {
      const { fetchFn, requests } = recordingFetch(() =>
        redirectedJson({ acceptedIds: [], rejected: [] }),
      );
      settleProbe(attack.run(fetchFn));
      await new Promise<void>(resolve => setImmediate(resolve));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(requests).toHaveLength(1);
      expect(['error', 'manual']).toContain(requests[0]!.redirect);
    });
  }

  // On whatwg-fetch `response.url` IS the post-redirect URL (xhr.responseURL),
  // so origin-checking the response is the one defence that works there.
  it('data/api.ts syncShots: an acknowledgement that arrived via a cross-origin redirect is not trusted (would delete local rows)', async () => {
    const { fetchFn } = recordingFetch(() =>
      redirectedJson({ acceptedIds: ['shot-1'], rejected: [] }),
    );
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const transport = createTransport({
      baseUrl: API_ORIGIN,
      token: session.bearerToken,
    });
    await expect(
      transport.syncShots([{ id: 'shot-1' }]),
    ).rejects.toBeInstanceOf(Error);
  });

  it('sessionLifecycle.ts refreshApiSession: tokens minted by a cross-origin redirect target are not installed', async () => {
    const { fetchFn } = recordingFetch(() =>
      redirectedJson({
        session: {
          accessToken: 'attacker-access',
          refreshToken: 'attacker-refresh',
          expiresAt: 4102444800,
        },
      }),
    );
    await expect(
      refreshApiSession(
        { apiBaseUrl: API_ORIGIN, refreshToken: 'refresh-secret' },
        { fetchFn },
      ),
    ).rejects.toBeInstanceOf(Error);
  });

  it("account/sessionLifecycle.ts revokeApiSession: the logout bearer is sent with redirect:'error'|'manual'", async () => {
    const { fetchFn, requests } = recordingFetch(
      () => new Response(null, { status: 204 }),
    );
    await revokeApiSession(session, fetchFn);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.authorization).toBe(`Bearer ${session.bearerToken}`);
    expect(['error', 'manual']).toContain(requests[0]!.redirect);
  });
});

describe('ADV networking-recovery: slow responses settle inside each client deadline', () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function flush(rounds = 4) {
    for (let i = 0; i < rounds; i += 1) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }

  it('fixture control: a stalled body read rejects as soon as the request signal aborts', async () => {
    const controller = new AbortController();
    const response = stalledBody({ signal: controller.signal });
    const probe = settleProbe(response.json());
    await flush();
    expect(probe).not.toHaveBeenCalled();
    controller.abort();
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe.mock.calls[0]![0]).toBe('rejected');
  });

  it('data/api.ts: headers arrive, body stalls → typed 408 network.timeout at exactly the 20s deadline (control)', async () => {
    const { fetchFn } = recordingFetch(init => stalledBody(init));
    globalThis.fetch = fetchFn as unknown as typeof fetch;
    const pending = createTransport({
      baseUrl: API_ORIGIN,
      token: 'tok',
    }).syncShots([]);
    const probe = settleProbe(pending);
    jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS - 1);
    await flush();
    expect(probe).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({
      status: 408,
      code: 'network.timeout',
    });
  });

  it('billing/accessApi.ts: headers arrive, body stalls → settles at the 10s billing deadline (control)', async () => {
    const { fetchFn } = recordingFetch(init => stalledBody(init));
    const pending = createCanonicalAccessClient({
      baseUrl: API_ORIGIN,
      token: 'tok',
      fetchFn,
    }).getAccess();
    const probe = settleProbe(pending);
    jest.advanceTimersByTime(BILLING_REQUEST_TIMEOUT_MS);
    await flush();
    expect(probe).toHaveBeenCalledTimes(1);
    await expect(pending).rejects.toMatchObject({
      code: 'billing.backend_unavailable',
      retryable: true,
    });
  });

  interface StallAttack {
    client: string;
    /** Documented deadline, or the wait after which "no deadline" is proven. */
    deadlineMs: number;
    /** stalled-body: only reachable under a streaming fetch (see header).
     *  hung-headers: reachable on every runtime — the TCP peer never answers. */
    mode: 'stalled-body' | 'hung-headers';
    run: (fetchFn: FetchLike) => Promise<unknown>;
  }

  /** Long enough that any sane client deadline has fired. */
  const NO_DEADLINE_PROOF_MS = 10 * 60_000;

  const stalls: StallAttack[] = [
    {
      client: 'account/sessionLifecycle.ts refreshApiSession',
      deadlineMs: 15_000,
      mode: 'stalled-body',
      run: fetchFn =>
        refreshApiSession(
          { apiBaseUrl: API_ORIGIN, refreshToken: 'refresh-secret' },
          { fetchFn },
        ),
    },
    {
      client: 'progress/api.ts fetchCanonicalProgress',
      deadlineMs: 15_000,
      mode: 'stalled-body',
      run: fetchFn => fetchCanonicalProgress(session, fetchFn),
    },
    {
      client: 'account/consentApi.ts fetchConsentStatus',
      deadlineMs: 15_000,
      mode: 'stalled-body',
      run: fetchFn => fetchConsentStatus(session, fetchFn),
    },
    {
      client: 'account/onboarding.ts fetchCanonicalOnboardingProfile',
      deadlineMs: 15_000,
      mode: 'stalled-body',
      run: fetchFn => fetchCanonicalOnboardingProfile(session, fetchFn),
    },
    {
      client: 'progress/playerRank.ts fetchPlayerRank',
      deadlineMs: NO_DEADLINE_PROOF_MS,
      mode: 'hung-headers',
      run: fetchFn => fetchPlayerRank(session, fetchFn),
    },
    {
      client: 'training/api.ts createTrainingApi().listCatalogDrills',
      deadlineMs: NO_DEADLINE_PROOF_MS,
      mode: 'hung-headers',
      run: fetchFn =>
        createTrainingApi({
          baseUrl: API_ORIGIN,
          token: 'tok',
          fetchFn,
        }).listCatalogDrills({}),
    },
  ];

  for (const stall of stalls) {
    it(`${stall.client}: ${stall.mode} → settles within ${stall.deadlineMs}ms (+1s grace)${
      stall.mode === 'stalled-body' ? ' [streaming-fetch only]' : ''
    }`, async () => {
      const { fetchFn, requests } = recordingFetch(init =>
        stall.mode === 'stalled-body' ? stalledBody(init) : hungHeaders(init),
      );
      const probe = settleProbe(stall.run(fetchFn));
      await flush();
      expect(requests).toHaveLength(1);
      jest.advanceTimersByTime(stall.deadlineMs + 1_000);
      await flush();
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0]![0]).toBe('rejected');
    });
  }

  it('sessionKeeper: one refresh whose body stalls must not wedge every later rotation (timer, foreground, refreshSessionNow) [streaming-fetch only]', async () => {
    const handlers: Array<(state: string) => void> = [];
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        handlers.push(handler as (state: string) => void);
        return { remove: () => {} } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
    let calls = 0;
    const fetchFn: FetchLike = async (_url, init) => {
      calls += 1;
      return stalledBody(init);
    };
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const onDeferred = jest.fn();
    try {
      startSessionKeeper({
        apiBaseUrl: API_ORIGIN,
        refreshToken: 'refresh-secret',
        bearerExpiresAtMs: null,
        onRotated,
        onRevoked,
        onDeferred,
        fetchFn,
      });
      await flush();
      expect(calls).toBe(1);
      // 15s request deadline + the keeper's largest backoff (5 min) — a
      // bounded refresh has failed transiently and been retried by now.
      jest.advanceTimersByTime(15_000 + 5 * 60_000);
      await flush();
      const retriedByTimer = calls >= 2;
      for (const handler of handlers) handler('active');
      await flush();
      const retriedOnForeground = calls >= 2;
      refreshSessionNow();
      await flush();
      const retriedOnDemand = calls >= 2;
      expect(onRevoked).not.toHaveBeenCalled();
      expect({
        retriedByTimer,
        retriedOnForeground,
        retriedOnDemand,
        deferredReports: onDeferred.mock.calls.length,
      }).toEqual({
        retriedByTimer: true,
        retriedOnForeground: true,
        retriedOnDemand: true,
        deferredReports: 1,
      });
    } finally {
      stopSessionKeeper();
    }
  });
});
