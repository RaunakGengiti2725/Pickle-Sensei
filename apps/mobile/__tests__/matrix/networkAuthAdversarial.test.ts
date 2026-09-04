/**
 * Adversarial probes for the NETWORK × AUTH cell — targeted interleavings the
 * seeded matrix (networkAuthMatrix.test.ts) reaches only by chance. Each
 * probe drives the real api.ts / sync.ts / sessionKeeper.ts / apiSession.ts
 * over a scripted, abort-aware fetch under fake timers, and appends a
 * machine-readable record to artifacts/matrix/network-auth-adversarial.json
 * whether it passes or fails.
 *
 * A failing probe here is a reproduced defect, not a harness problem: the
 * assertion text states the contract (AGENTS.md "Auth sessions", the module
 * doc-comments) and the observed numbers are in the JSON record.
 */
import { AppState } from 'react-native';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createTransport,
} from '../../src/data/api';
import { drainOutbox } from '../../src/data/sync';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  API_BASE,
  CANONICAL_ID,
  REFRESH_REQUEST_TIMEOUT_MS,
  fakeDb,
  liveTransportConfig,
  rowPayload,
} from '../../test-support/matrix/networkAuthHarness';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings (see be-mobile-sync-outbox.test.ts), so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const OUT_DIR =
  process.env.MATRIX_OUT ?? join(__dirname, '..', '..', 'artifacts', 'matrix');

interface ProbeRecord {
  probe: string;
  passed: boolean;
  observed: Record<string, unknown>;
  expected: string;
  error: string | null;
}
const records: ProbeRecord[] = [];

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    join(OUT_DIR, 'network-auth-adversarial.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        probes: records.length,
        passed: records.filter(r => r.passed).length,
        failed: records.filter(r => !r.passed).length,
        records,
      },
      null,
      2,
    ),
  );
});

// ─── Scripted fetch ──────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: unknown;
  latencyMs: number;
}
interface Seen {
  n: number;
  atMs: number;
  url: string;
  bearer: string | null;
  body: unknown;
  outcome: 'ok' | 'aborted';
}

function scriptedFetch(
  startMs: number,
  handler: (seen: Seen) => Reply,
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['authorization'] ?? headers['Authorization'];
    const entry: Seen = {
      n: seen.length + 1,
      atMs: Date.now() - startMs,
      url,
      bearer: auth ? auth.replace(/^Bearer /, '') : null,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      outcome: 'ok',
    };
    seen.push(entry);
    const reply = handler(entry);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          statusText: String(reply.status),
          json: async () => reply.body,
          text: async () => JSON.stringify(reply.body),
        } as unknown as Response);
      }, reply.latencyMs);
      init?.signal?.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        entry.outcome = 'aborted';
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  return { fetch: impl as unknown as typeof fetch, seen };
}

const unauthorized = (message: string) => ({
  error: { code: 'unauthorized', message },
});
const sessionBody = (access: string, refresh: string, expiresAtMs: number) => ({
  session: {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: Math.floor(expiresAtMs / 1000),
  },
});

// ─── Probe scaffolding ───────────────────────────────────────────────────────

interface Keeper {
  rotated: Array<{ atMs: number; bearer: string; refreshToken: string }>;
  revoked: number[];
  deferred: Array<{ atMs: number; message: string }>;
  foreground: (() => void) | null;
}

let realFetch: typeof fetch;

function startProbe(startMs: number) {
  realFetch = globalThis.fetch;
  jest.useFakeTimers();
  jest.setSystemTime(startMs);
  setActiveDataOwner(CANONICAL_ID);
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: 'B0',
    canonicalAppUserId: CANONICAL_ID,
    provider: 'apple',
    refreshToken: 'R0',
    bearerExpiresAtMs: startMs + 3_600_000,
  });
  setApiUnauthorizedListener(expired => {
    if (expired.refreshToken) refreshSessionNow();
  });
}

function wireKeeper(
  startMs: number,
  fetchFn: typeof fetch,
  bearerExpiresAtMs: number | null,
): Keeper {
  const keeper: Keeper = {
    rotated: [],
    revoked: [],
    deferred: [],
    foreground: null,
  };
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      keeper.foreground = () => (handler as (state: string) => void)('active');
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  startSessionKeeper({
    apiBaseUrl: API_BASE,
    refreshToken: 'R0',
    bearerExpiresAtMs,
    fetchFn: fetchFn as unknown as Parameters<
      typeof startSessionKeeper
    >[0]['fetchFn'],
    onRotated: tokens => {
      keeper.rotated.push({
        atMs: Date.now() - startMs,
        bearer: tokens.bearerToken,
        refreshToken: tokens.refreshToken,
      });
      const current = getApiSession();
      if (current?.canonicalAppUserId !== CANONICAL_ID) return;
      establishApiSession({
        ...current,
        bearerToken: tokens.bearerToken,
        refreshToken: tokens.refreshToken,
        bearerExpiresAtMs: tokens.bearerExpiresAtMs,
      });
    },
    onRevoked: () => {
      keeper.revoked.push(Date.now() - startMs);
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    },
    onDeferred: error => {
      keeper.deferred.push({
        atMs: Date.now() - startMs,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  });
  return keeper;
}

function endProbe() {
  globalThis.fetch = realFetch;
  stopSessionKeeper();
  setApiUnauthorizedListener(null);
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  jest.useRealTimers();
}

async function probe(
  name: string,
  expected: string,
  run: () => Promise<Record<string, unknown>>,
  assert: (observed: Record<string, unknown>) => void,
): Promise<void> {
  const record: ProbeRecord = {
    probe: name,
    passed: false,
    observed: {},
    expected,
    error: null,
  };
  records.push(record);
  try {
    record.observed = await run();
    assert(record.observed);
    record.passed = true;
  } catch (error) {
    record.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    endProbe();
  }
}

const START = Date.UTC(2026, 8, 4, 12, 0, 0);

// ─── Probes ──────────────────────────────────────────────────────────────────

describe('NETWORK × AUTH adversarial probes', () => {
  it('A1 expiry skew: a bearer the server issues with < 60s of life (device clock ahead of the server) must not turn the keeper into a 1 Hz refresh loop', async () => {
    await probe(
      'A1.expiry-skew-loop',
      'refresh cadence stays bounded (≤ 5 refreshes in 120 s) even when every refresh succeeds with an already-"expiring" expiresAt',
      async () => {
        startProbe(START);
        let gen = 0;
        // The server's clock is 1 h behind the device's: each rotated bearer
        // carries expiresAt = serverNow + 3600 s, which the device reads as
        // "expires right now".
        const SERVER_SKEW_MS = -3_600_000;
        const { fetch, seen } = scriptedFetch(START, entry => {
          if (!entry.url.endsWith('/v1/auth/refresh')) {
            return { status: 404, body: null, latencyMs: 10 };
          }
          gen += 1;
          return {
            status: 200,
            body: sessionBody(
              `B${gen}`,
              `R${gen}`,
              Date.now() + SERVER_SKEW_MS + 3_600_000,
            ),
            latencyMs: 50,
          };
        });
        const keeper = wireKeeper(START, fetch, null);
        await jest.advanceTimersByTimeAsync(120_000);
        const refreshes = seen.filter(s => s.url.endsWith('/v1/auth/refresh'));
        const gaps = refreshes
          .slice(1)
          .map((s, i) => s.atMs - refreshes[i]!.atMs);
        return {
          refreshRequestsIn120s: refreshes.length,
          rotations: keeper.rotated.length,
          minGapMs: gaps.length ? Math.min(...gaps) : null,
          medianGapMs: gaps.length
            ? gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)]
            : null,
          revoked: keeper.revoked.length,
          finalBearer: bearerTokenFor(CANONICAL_ID),
          note: 'AUTH_REFRESH_LIMIT is 30/min per IP (supabase/functions/api/index.ts) — this cadence exhausts it in 30 s and starves every device behind the same NAT',
        };
      },
      observed => {
        expect(observed.revoked).toBe(0);
        expect(observed.refreshRequestsIn120s as number).toBeLessThanOrEqual(5);
      },
    );
  });

  it('A2 expiry skew under the real per-IP budget: 429s must push the keeper into backoff instead of a refresh/429 sawtooth', async () => {
    await probe(
      'A2.expiry-skew-rate-limited',
      'over 10 virtual minutes the client sends far fewer refreshes than the per-IP budget would allow (i.e. it notices something is wrong), and never signs out',
      async () => {
        startProbe(START);
        let gen = 0;
        const SERVER_SKEW_MS = -3_600_000;
        const window: number[] = [];
        let rateLimited = 0;
        const { fetch, seen } = scriptedFetch(START, entry => {
          if (!entry.url.endsWith('/v1/auth/refresh')) {
            return { status: 404, body: null, latencyMs: 10 };
          }
          const now = Date.now();
          while (window.length && now - window[0]! > 60_000) window.shift();
          if (window.length >= 30) {
            rateLimited += 1;
            return {
              status: 429,
              body: { error: { code: 'rate_limited', message: 'slow down' } },
              latencyMs: 30,
            };
          }
          window.push(now);
          gen += 1;
          return {
            status: 200,
            body: sessionBody(
              `B${gen}`,
              `R${gen}`,
              now + SERVER_SKEW_MS + 3_600_000,
            ),
            latencyMs: 50,
          };
        });
        const keeper = wireKeeper(START, fetch, null);
        await jest.advanceTimersByTimeAsync(10 * 60_000);
        return {
          refreshRequestsIn10min: seen.length,
          successfulRotations: keeper.rotated.length,
          rateLimited429s: rateLimited,
          deferred: keeper.deferred.length,
          revoked: keeper.revoked.length,
          sessionKept: getApiSession()?.canonicalAppUserId === CANONICAL_ID,
        };
      },
      observed => {
        expect(observed.revoked).toBe(0);
        expect(observed.sessionKept).toBe(true);
        // 10 scheduled refreshes (one per minute) would be generous.
        expect(observed.refreshRequestsIn10min as number).toBeLessThanOrEqual(
          20,
        );
      },
    );
  });

  it('B 401 storm: 40 concurrent requests on an expired bearer produce exactly one refresh, no sign-out, and every retry carries the rotated bearer', async () => {
    await probe(
      'B.401-storm',
      'one /v1/auth/refresh for 40 simultaneous 401s; retries all carry B1 and succeed',
      async () => {
        startProbe(START);
        const valid = new Set<string>();
        let gen = 0;
        const { fetch, seen } = scriptedFetch(START, entry => {
          if (entry.url.endsWith('/v1/auth/refresh')) {
            gen += 1;
            valid.add(`B${gen}`);
            return {
              status: 200,
              body: sessionBody(`B${gen}`, `R${gen}`, Date.now() + 3_600_000),
              latencyMs: 300,
            };
          }
          if (!entry.bearer || !valid.has(entry.bearer)) {
            return {
              status: 401,
              body: unauthorized('bad token'),
              latencyMs: 20 + (entry.n % 7) * 10,
            };
          }
          return {
            status: 200,
            body: { session: { id: 'x' } },
            latencyMs: 20,
          };
        });
        globalThis.fetch = fetch;
        const keeper = wireKeeper(START, fetch, START + 3_600_000);
        const transport = createTransport(liveTransportConfig());
        const createSession = (i: number) =>
          transport.createSession({
            id: `s${i}`,
            mode: 'practice',
            startedAt: '2026-08-26T18:00:00.000Z',
          } as never);
        const firstPending = Promise.allSettled(
          Array.from({ length: 40 }, (_, i) => createSession(i)),
        );
        await jest.advanceTimersByTimeAsync(2_000);
        const first = await firstPending;
        const retryPending = Promise.allSettled(
          Array.from({ length: 40 }, (_, i) => createSession(i)),
        );
        await jest.advanceTimersByTimeAsync(2_000);
        const retries = await retryPending;
        const refreshes = seen.filter(s => s.url.endsWith('/v1/auth/refresh'));
        const retryBearers = new Set(seen.slice(41).map(s => s.bearer));
        return {
          first401s: first.filter(
            r =>
              r.status === 'rejected' &&
              r.reason instanceof ApiError &&
              r.reason.status === 401,
          ).length,
          refreshRequests: refreshes.length,
          rotations: keeper.rotated.length,
          revoked: keeper.revoked.length,
          retriesFulfilled: retries.filter(r => r.status === 'fulfilled')
            .length,
          retryBearers: [...retryBearers],
        };
      },
      observed => {
        expect(observed.first401s).toBe(40);
        expect(observed.refreshRequests).toBe(1);
        expect(observed.rotations).toBe(1);
        expect(observed.revoked).toBe(0);
        expect(observed.retriesFulfilled).toBe(40);
        expect(observed.retryBearers).toEqual(['B1']);
      },
    );
  });

  it('C late 401: a slow request that was sent with B0 and answered 401 after the rotation to B1 must not trigger a second rotation', async () => {
    await probe(
      'C.late-401-after-rotation',
      'exactly one refresh; the stale 401 (for B0) is ignored because B1 is current',
      async () => {
        startProbe(START);
        let gen = 0;
        const { fetch, seen } = scriptedFetch(START, entry => {
          if (entry.url.endsWith('/v1/auth/refresh')) {
            gen += 1;
            return {
              status: 200,
              body: sessionBody(`B${gen}`, `R${gen}`, Date.now() + 3_600_000),
              latencyMs: 500,
            };
          }
          // B0 is refused slowly (8 s); anything else is fine.
          return entry.bearer === 'B0'
            ? { status: 401, body: unauthorized('expired'), latencyMs: 8_000 }
            : { status: 200, body: { session: { id: 'x' } }, latencyMs: 20 };
        });
        globalThis.fetch = fetch;
        const keeper = wireKeeper(START, fetch, START + 3_600_000);
        const transport = createTransport(liveTransportConfig());
        const slow = transport
          .createSession({
            id: 's0',
            mode: 'practice',
            startedAt: '2026-08-26T18:00:00.000Z',
          } as never)
          .then(
            () => 'ok',
            (e: unknown) => (e instanceof ApiError ? `${e.status}` : 'err'),
          );
        await jest.advanceTimersByTimeAsync(1_000);
        refreshSessionNow(); // proactive rotation lands at ~1.5 s
        await jest.advanceTimersByTimeAsync(10_000);
        const slowOutcome = await slow;
        await jest.advanceTimersByTimeAsync(5_000);
        return {
          slowOutcome,
          refreshRequests: seen.filter(s => s.url.endsWith('/v1/auth/refresh'))
            .length,
          rotations: keeper.rotated.length,
          finalBearer: bearerTokenFor(CANONICAL_ID),
        };
      },
      observed => {
        expect(observed.slowOutcome).toBe('401');
        expect(observed.refreshRequests).toBe(1);
        expect(observed.rotations).toBe(1);
        expect(observed.finalBearer).toBe('B1');
      },
    );
  });

  it('D keeper restart mid-refresh: the dropped in-flight rotation must be recoverable through the GoTrue parent-token rule, not end in a refused refresh', async () => {
    await probe(
      'D.restart-mid-refresh',
      'the replacement keeper (still holding R0) is served the already-active R1 pair; no 401, no sign-out; the next scheduled rotation R1→R2 succeeds',
      async () => {
        startProbe(START);
        // GoTrue-style server: single use + parent-of-active recovery.
        const tokens = new Map<string, { child: string | null }>([
          ['R0', { child: null }],
        ]);
        let active = 'R0';
        let gen = 0;
        let refusals = 0;
        const { fetch, seen } = scriptedFetch(START, entry => {
          const rt = (entry.body as { refreshToken: string }).refreshToken;
          const record = tokens.get(rt);
          if (!record) {
            refusals += 1;
            return { status: 401, body: unauthorized('dead'), latencyMs: 50 };
          }
          if (record.child) {
            if (record.child === active) {
              return {
                status: 200,
                body: sessionBody(
                  `B${record.child.slice(1)}`,
                  record.child,
                  Date.now() + 3_600_000,
                ),
                latencyMs: 50,
              };
            }
            refusals += 1;
            return { status: 401, body: unauthorized('reused'), latencyMs: 50 };
          }
          gen += 1;
          record.child = `R${gen}`;
          tokens.set(`R${gen}`, { child: null });
          active = `R${gen}`;
          return {
            status: 200,
            body: sessionBody(`B${gen}`, `R${gen}`, Date.now() + 3_600_000),
            latencyMs: 2_000,
          };
        });
        wireKeeper(START, fetch, null); // refresh in flight, lands at 2 s
        await jest.advanceTimersByTimeAsync(1_000);
        jest.restoreAllMocks();
        const keeper = wireKeeper(START, fetch, null); // generation bump
        await jest.advanceTimersByTimeAsync(5_000);
        const afterRestart = {
          bearer: bearerTokenFor(CANONICAL_ID),
          refreshToken: getApiSession()?.refreshToken ?? null,
        };
        // Next scheduled rotation: 3600 s − 60 s ahead.
        await jest.advanceTimersByTimeAsync(3_600_000);
        return {
          afterRestart,
          serverActive: active,
          refreshRequests: seen.length,
          refusals,
          rotations: keeper.rotated.length,
          revoked: keeper.revoked.length,
          finalRefreshToken: getApiSession()?.refreshToken ?? null,
        };
      },
      observed => {
        expect(observed.refusals).toBe(0);
        expect(observed.revoked).toBe(0);
        expect(observed.afterRestart).toEqual({
          bearer: 'B1',
          refreshToken: 'R1',
        });
        expect(observed.finalRefreshToken).toBe(observed.serverActive);
      },
    );
  });

  it('E malformed refresh body: a 200 without a usable session is transient — the keeper keeps the session, backs off and recovers', async () => {
    await probe(
      'E.malformed-refresh-body',
      '3 malformed replies → 3 deferrals with 5/10/20 s backoff, then rotation; never revoked',
      async () => {
        startProbe(START);
        let n = 0;
        const { fetch, seen } = scriptedFetch(START, () => {
          n += 1;
          if (n <= 3) {
            return {
              status: 200,
              body: { session: { accessToken: '', refreshToken: 'R1' } },
              latencyMs: 20,
            };
          }
          return {
            status: 200,
            body: sessionBody('B1', 'R1', Date.now() + 3_600_000),
            latencyMs: 20,
          };
        });
        const keeper = wireKeeper(START, fetch, null);
        await jest.advanceTimersByTimeAsync(60_000);
        const gaps = seen.slice(1).map((s, i) => s.atMs - seen[i]!.atMs);
        return {
          refreshRequests: seen.length,
          deferred: keeper.deferred.length,
          gapsMs: gaps,
          expectedGapsMs: [1, 2, 3].map(a => retryDelayMs(a) + 20),
          rotations: keeper.rotated.length,
          revoked: keeper.revoked.length,
        };
      },
      observed => {
        expect(observed.revoked).toBe(0);
        expect(observed.deferred).toBe(3);
        expect(observed.rotations).toBe(1);
        expect(observed.gapsMs).toEqual(observed.expectedGapsMs);
      },
    );
  });

  it('F refresh timeout at the exact 15 s boundary: the client aborts, the server had rotated, and the retry recovers via the parent rule without a refusal', async () => {
    await probe(
      'F.refresh-timeout-boundary',
      'attempt 1 aborted at exactly REFRESH_REQUEST_TIMEOUT_MS; attempt 2 (5 s later, R0 again) is served R1; no refusal, no sign-out',
      async () => {
        startProbe(START);
        let minted = 0;
        let served = 0;
        let refusals = 0;
        const { fetch, seen } = scriptedFetch(START, entry => {
          const rt = (entry.body as { refreshToken: string }).refreshToken;
          if (rt === 'R0' && minted === 0) {
            minted = 1;
            return {
              status: 200,
              body: sessionBody('B1', 'R1', Date.now() + 3_600_000),
              latencyMs: REFRESH_REQUEST_TIMEOUT_MS,
            };
          }
          if (rt === 'R0' && minted === 1) {
            served += 1;
            return {
              status: 200,
              body: sessionBody('B1', 'R1', Date.now() + 3_600_000),
              latencyMs: 30,
            };
          }
          refusals += 1;
          return { status: 401, body: unauthorized('reused'), latencyMs: 30 };
        });
        const keeper = wireKeeper(START, fetch, null);
        await jest.advanceTimersByTimeAsync(30_000);
        return {
          attempts: seen.map(s => ({ atMs: s.atMs, outcome: s.outcome })),
          parentRuleServed: served,
          refusals,
          deferred: keeper.deferred.length,
          rotations: keeper.rotated.length,
          revoked: keeper.revoked.length,
          finalRefreshToken: getApiSession()?.refreshToken ?? null,
        };
      },
      observed => {
        const attempts = observed.attempts as Array<{ outcome: string }>;
        expect(attempts[0]?.outcome).toBe('aborted');
        expect(observed.refusals).toBe(0);
        expect(observed.revoked).toBe(0);
        expect(observed.rotations).toBe(1);
        expect(observed.finalRefreshToken).toBe('R1');
      },
    );
  });

  it('G refresh family revoked while an outbox drain is running: the ONE implicit sign-out fires once, queued rows are neither lost nor charged, and no further request carries a bearer', async () => {
    await probe(
      'G.revoked-during-drain',
      'exactly one refresh (refused) → onRevoked once; outbox rows keep attempts=0; requests after revocation carry no bearer and never reach reportApiUnauthorized',
      async () => {
        startProbe(START);
        const { fetch, seen } = scriptedFetch(START, entry => {
          if (entry.url.endsWith('/v1/auth/refresh')) {
            return {
              status: 401,
              body: unauthorized('revoked'),
              latencyMs: 40,
            };
          }
          return {
            status: 401,
            body: unauthorized('token revoked'),
            latencyMs: 30,
          };
        });
        globalThis.fetch = fetch;
        const keeper = wireKeeper(START, fetch, START + 3_600_000);
        const { db, push, outbox } = fakeDb();
        const rows = [
          {
            kind: 'session.create' as const,
            entityId: 'sbbb0000-0000-4000-8000-000000000001',
            corrupt: false,
            permanentReject: false,
            transientRejectVisits: 0,
          },
          {
            kind: 'shot.sync' as const,
            entityId: 'aaaa0000-0000-4000-8000-000000000001',
            corrupt: false,
            permanentReject: false,
            transientRejectVisits: 0,
          },
          {
            kind: 'shot.sync' as const,
            entityId: 'aaaa0000-0000-4000-8000-000000000002',
            corrupt: false,
            permanentReject: false,
            transientRejectVisits: 0,
          },
        ];
        for (const row of rows) push(CANONICAL_ID, row.kind, rowPayload(row));
        let result: {
          synced: number;
          failed: number;
          remaining: number;
        } | null = null;
        const drain = drainOutbox(
          db,
          createTransport(liveTransportConfig()),
        ).then(r => {
          result = r;
        });
        await jest.advanceTimersByTimeAsync(5_000);
        await drain;
        return {
          drainResult: result,
          requests: seen.map(s => ({
            url: s.url.slice(API_BASE.length),
            bearer: s.bearer,
            atMs: s.atMs,
          })),
          refreshRequests: seen.filter(s => s.url.endsWith('/v1/auth/refresh'))
            .length,
          revoked: keeper.revoked,
          outbox: outbox.map(r => ({
            kind: r.kind,
            attempts: r.attempts,
            last_error: r.last_error,
          })),
          sessionAfter: getApiSession(),
        };
      },
      observed => {
        expect(observed.refreshRequests).toBe(1);
        expect(observed.revoked).toHaveLength(1);
        expect(observed.sessionAfter).toBeNull();
        const outbox = observed.outbox as Array<{ attempts: number }>;
        expect(outbox).toHaveLength(3);
        expect(outbox.every(r => r.attempts === 0)).toBe(true);
        const requests = observed.requests as Array<{
          url: string;
          bearer: string | null;
          atMs: number;
        }>;
        const revokedAt = (observed.revoked as number[])[0]!;
        for (const r of requests) {
          if (r.url === '/v1/auth/refresh') continue;
          if (r.atMs > revokedAt) expect(r.bearer).toBeNull();
        }
      },
    );
  });

  it('H foreground flood: 50 AppState "active" events in one tick with a near-expiry bearer trigger exactly one refresh', async () => {
    await probe(
      'H.foreground-flood',
      '1 refresh request for 50 simultaneous foreground events; then the rotated bearer is scheduled normally',
      async () => {
        startProbe(START);
        let gen = 0;
        const { fetch, seen } = scriptedFetch(START, () => {
          gen += 1;
          return {
            status: 200,
            body: sessionBody(`B${gen}`, `R${gen}`, Date.now() + 3_600_000),
            latencyMs: 400,
          };
        });
        // Bearer has 2 min left: below FOREGROUND_LEAD_MS, above REFRESH_LEAD_MS.
        const keeper = wireKeeper(START, fetch, START + 120_000);
        for (let i = 0; i < 50; i++) keeper.foreground?.();
        await jest.advanceTimersByTimeAsync(2_000);
        const afterFlood = seen.length;
        // A second flood right after the rotation must be a no-op (fresh bearer).
        for (let i = 0; i < 50; i++) keeper.foreground?.();
        await jest.advanceTimersByTimeAsync(2_000);
        return {
          refreshRequestsAfterFlood: afterFlood,
          refreshRequestsAfterSecondFlood: seen.length,
          rotations: keeper.rotated.length,
          finalBearer: bearerTokenFor(CANONICAL_ID),
        };
      },
      observed => {
        expect(observed.refreshRequestsAfterFlood).toBe(1);
        expect(observed.refreshRequestsAfterSecondFlood).toBe(1);
        expect(observed.rotations).toBe(1);
        expect(observed.finalBearer).toBe('B1');
      },
    );
  });

  it('I shot-sync response lost at the exact 20 s abort boundary: the row stays queued with attempts=0 and the retry is accepted idempotently', async () => {
    await probe(
      'I.sync-abort-boundary',
      'attempt 1 → network.timeout (408) with attempts unchanged; attempt 2 accepted; one receipt; server saw the shot twice',
      async () => {
        startProbe(START);
        let visits = 0;
        const { fetch } = scriptedFetch(START, entry => {
          visits += 1;
          const shots = (entry.body as { shots: Array<{ id: string }> }).shots;
          return {
            status: 200,
            body: { acceptedIds: shots.map(s => s.id), rejected: [] },
            latencyMs: visits === 1 ? API_REQUEST_TIMEOUT_MS : 20,
          };
        });
        globalThis.fetch = fetch;
        const { db, push, outbox, receipts } = fakeDb();
        push(
          CANONICAL_ID,
          'shot.sync',
          rowPayload({
            kind: 'shot.sync',
            entityId: 'aaaa0000-0000-4000-8000-000000000009',
            corrupt: false,
            permanentReject: false,
            transientRejectVisits: 0,
          }),
        );
        const transport = createTransport(liveTransportConfig());
        let first: {
          synced: number;
          failed: number;
          remaining: number;
        } | null = null;
        const d1 = drainOutbox(db, transport).then(r => {
          first = r;
        });
        await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1_000);
        await d1;
        const afterFirst = outbox.map(r => ({
          attempts: r.attempts,
          last_error: r.last_error,
        }));
        let second: {
          synced: number;
          failed: number;
          remaining: number;
        } | null = null;
        const d2 = drainOutbox(db, transport).then(r => {
          second = r;
        });
        await jest.advanceTimersByTimeAsync(1_000);
        await d2;
        return {
          first,
          afterFirst,
          second,
          remaining: outbox.length,
          receipts: receipts.length,
          serverVisits: visits,
        };
      },
      observed => {
        expect(observed.first).toEqual({ synced: 0, failed: 1, remaining: 1 });
        const afterFirst = observed.afterFirst as Array<{
          attempts: number;
          last_error: string;
        }>;
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]!.attempts).toBe(0);
        expect(afterFirst[0]!.last_error).toContain('took too long');
        expect(observed.second).toEqual({ synced: 1, failed: 0, remaining: 0 });
        expect(observed.receipts).toBe(1);
        expect(observed.serverVisits).toBe(2);
      },
    );
  });
});
