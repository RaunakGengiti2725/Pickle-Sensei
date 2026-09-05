/**
 * STRESS (lens: concurrency) — sessionKeeper + sessionLifecycle refresh
 * rotation driven by a SEEDED SCHEDULER of interleavings.
 *
 * Nothing between the keeper and the fake server is mocked: the real
 * `startSessionKeeper` / `stopSessionKeeper` / `refreshSessionNow` and the
 * real `refreshApiSession` (timeout, classification) run against a scripted
 * `fetchFn` whose responses are held back and released by the scheduler, so
 * every "during" window exists for real:
 *
 *   • duplicate calls      — Promise.all bursts of refreshSessionNow /
 *                            foreground events (1…500 per burst)
 *   • call-during-call     — bursts fired while a request is in flight or
 *                            while onRotated has not resolved yet
 *   • cancel-during-call   — stopSessionKeeper() between the server's answer
 *                            and the keeper's continuation
 *   • two actors, same id  — a second account's keeper started while the
 *                            first account's request is still pending
 *   • rotation/logout      — restart with the persisted (vault) token, or
 *                            logout, while a rotation is mid-air
 *   • clock skew           — device `now()` ahead/behind the server by up to
 *                            2 h, plus server `expiresAt` in the past
 *   • reentrancy           — onRotated / onRevoked that synchronously call
 *                            back into the keeper (refresh-now, restart)
 *   • callback latency     — onRotated / onRevoked promises settled (or
 *                            rejected) later by the scheduler
 *
 * Invariants (any violation = FAIL with the seed; replay via STRESS_SEED=<n>):
 *   K1  ≤ 1 refresh request in flight per keeper generation.
 *   K2  A stopped or superseded generation never sends a request.
 *   K3  No callback (onRotated/onRevoked/onDeferred) BEGINS for a generation
 *       the harness already stopped/superseded — a late answer is dropped.
 *   K4  onRevoked ≤ 1 per generation, only after a DELIVERED 401/403, and no
 *       onRotated / request for that generation afterwards.
 *   K5  Token continuity / no double spend: every request carries the
 *       generation's current refresh token, and a token the server already
 *       rotated for this generation is never re-sent by it.
 *   K6  onRotated delivers exactly the tokens the server issued to a request
 *       of THAT generation, each rotation adopted at most once, and no
 *       server-issued rotation that the live generation received is lost.
 *   K7  Bursts are idempotent: N simultaneous triggers produce ≤ 1 request.
 *   K8  ≤ 1 AppState listener at any time; 0 listeners and 0 timers after
 *       the final stop.
 *   K9  No deadlock: a live, non-revoked keeper sends again within the drain
 *       window; every seed completes under a real wall-clock bound.
 *   K10 Timer-driven successful rotations are ≥ 30 s apart (no storm).
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/stress/sessionKeeperConcurrency.stress.test.ts
 *   STRESS_ITER=1000 npx jest --ci __tests__/stress/sessionKeeperConcurrency.stress.test.ts
 *   STRESS_SEED=1234 npx jest --ci __tests__/stress/sessionKeeperConcurrency.stress.test.ts
 * Artifacts: artifacts/stress/mod-session-keeper/concurrency-*.json (STRESS_OUT overrides the directory).
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import type { RefreshedTokens } from '../../src/account/sessionLifecycle';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const REAL_NOW: () => number = Date.now.bind(Date);

// ─── Seeded PRNG ─────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: () => number, items: readonly T[]): T =>
  items[Math.floor(rng() * items.length)]!;
const chance = (rng: () => number, p: number) => rng() < p;

// ─── Server model ────────────────────────────────────────────────────────────

type Outcome =
  | 'ok'
  | 'ok_short_life' // bearer valid for 20 s → exercises the 30 s rotation floor
  | 'ok_expires_in_past' // server clock ahead of the device
  | 'refused_401'
  | 'refused_403'
  | 'http_429'
  | 'http_500'
  | 'http_503'
  | 'malformed_body'
  | 'malformed_expires'
  | 'net_error'
  | 'hang_until_timeout';

const OUTCOME_POOL: readonly Outcome[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'ok',
  'ok_short_life',
  'ok_expires_in_past',
  'http_429',
  'http_500',
  'http_503',
  'malformed_body',
  'malformed_expires',
  'net_error',
  'hang_until_timeout',
  // refusals are rare so most seeds live long enough to race
  'refused_401',
  'refused_403',
];
const isRefusal = (o: Outcome) => o === 'refused_401' || o === 'refused_403';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

interface Issued {
  access: string;
  refresh: string;
  expiresAt: number;
}

// ─── Harness bookkeeping ─────────────────────────────────────────────────────

type Actor = 'A' | 'B';
type Reentry = 'none' | 'refresh_now' | 'restart_same';
type CallbackMode = 'sync' | 'async_scheduled';

interface Gen {
  id: number;
  actor: Actor;
  startedAtOp: number;
  skewMs: number;
  reentry: Reentry;
  rotatedMode: CallbackMode;
  revokedMode: CallbackMode;
  rejectRotated: boolean;
  /** Token this generation must send next (initial, then last adopted). */
  expectedToken: string;
  /** Tokens the server already rotated for THIS generation (spent). */
  spent: Set<string>;
  /** Rotations the server issued to this generation, awaiting adoption. */
  issued: Map<string, Issued>;
  /** Rotations adopted (onRotated began) by this generation. */
  adopted: Set<string>;
  inflight: number;
  requests: number;
  rotatedCalls: number;
  revokedCalls: number;
  deferredCalls: number;
  refusalDelivered: boolean;
  /** Harness-side liveness: false once stop()/start() superseded it. */
  live: boolean;
  /** Every request: when, whether a timer fired it, and whether the
   * rotation it carried succeeded (HTTP 2xx with valid tokens AND onRotated
   * did not fail) — for the 30 s rotation-floor check (K10). */
  timeline: Array<{ t: number; viaTimer: boolean; ok: boolean | null }>;
}

interface PendingRequest {
  id: number;
  gen: Gen;
  sentToken: string;
  signal: AbortSignal | undefined;
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  t: number;
  trigger: string;
  timeline: { t: number; viaTimer: boolean; ok: boolean | null };
}

interface PendingCallback {
  gen: Gen;
  kind: 'rotated' | 'revoked';
  resolve: () => void;
  reject: (e: unknown) => void;
}

type OpKind =
  | 'advance'
  | 'settle'
  | 'settle_callback'
  | 'refresh_burst'
  | 'foreground_burst'
  | 'mixed_burst'
  | 'stop'
  | 'start_same'
  | 'start_other'
  | 'fetch'
  | 'abort'
  | 'callback'
  | 'drain';

interface OpLog {
  i: number;
  op: OpKind;
  detail: string;
  t: number;
  gen: number | null;
  pending: number;
}

interface SeedResult {
  seed: number;
  verdict: 'PASS' | 'FAIL';
  violations: string[];
  ops: number;
  generations: number;
  requests: number;
  crossGenOverlaps: number;
  rotations: number;
  revocations: number;
  deferred: number;
  refusalsDelivered: number;
  lateAnswersDropped: number;
  burstTriggers: number;
  burstRequests: number;
  staleVaultRestarts: number;
  maxRequestsInAny60s: number;
  simulatedMs: number;
  wallMs: number;
  log: OpLog[];
}

let appStateHandlers = new Set<(state: string) => void>();

const SKEWS = [0, 0, 0, -5 * 60_000, 5 * 60_000, -2 * 3_600_000, 2 * 3_600_000];
const ADVANCES = [
  0,
  1,
  999,
  1_000,
  4_999,
  5_000,
  14_999,
  15_001,
  29_000,
  30_000,
  59_000,
  61_000,
  5 * 60_000,
  59 * 60_000,
  3_600_000,
  3 * 3_600_000,
];
const BURST_SIZES = [1, 2, 3, 5, 10, 50, 500];
const PER_SEED_WALL_BOUND_MS = 8_000;
// A correct keeper sends at most ~2/min over the ~5 h simulated per seed
// (~600, ~3 000 with a 2 h clock skew) plus bursts; past this the keeper is in a request
// storm/livelock and the seed is cut off (K9) instead of exhausting memory.
const MAX_REQUESTS_PER_SEED = 20_000;
const MAX_VIOLATIONS_PER_SEED = 500;
const MAX_LOG_PER_SEED = 20_000;

async function runSeed(seed: number): Promise<SeedResult> {
  const rng = mulberry32(seed);
  const violations: string[] = [];
  const log: OpLog[] = [];
  const gens: Gen[] = [];
  const pendingRequests: PendingRequest[] = [];
  const pendingCallbacks: PendingCallback[] = [];
  const requestTimes: number[] = [];
  // Persisted refresh token per actor (what authStore would keep in the vault),
  // and the last bearer expiry that account adopted.
  const vault: Record<Actor, { token: string; expiresAtMs: number | null }> = {
    A: { token: `seed-${seed}-A`, expiresAtMs: null },
    B: { token: `seed-${seed}-B`, expiresAtMs: null },
  };
  // Server-side ledger: the refresh tokens that are currently valid per actor
  // (strict rotation: a spent token is refused with 401).
  const serverValid: Record<Actor, Set<string>> = {
    A: new Set([vault.A.token]),
    B: new Set([vault.B.token]),
  };
  let liveGen: Gen | null = null;
  // Assigned from closures TS cannot see; read through a function so the
  // top-level flow does not narrow it to `null`.
  const current = (): Gen | null => liveGen;
  let nextGenId = 0;
  let nextRequestId = 0;
  let rotationCounter = 0;
  let currentOp = 'init';
  let opIndex = 0;
  let crossGenOverlaps = 0;
  let lateAnswersDropped = 0;
  let burstTriggers = 0;
  let burstRequests = 0;
  let staleVaultRestarts = 0;
  let refusalsDelivered = 0;
  let autoSettle: Outcome | null = null;
  jest.setSystemTime(1_800_000_000_000 + Math.floor(rng() * 1_000_000_000));
  const t0 = Date.now();
  const wallStart = REAL_NOW();
  const t = () => Date.now() - t0;

  let droppedViolations = 0;
  const violate = (msg: string) => {
    if (violations.length >= MAX_VIOLATIONS_PER_SEED) {
      droppedViolations += 1;
      return;
    }
    violations.push(`[op ${opIndex} t=${t()}] ${msg}`);
  };

  const record = (op: OpKind, detail: string) => {
    if (log.length >= MAX_LOG_PER_SEED) return;
    log.push({
      i: opIndex,
      op,
      detail,
      t: t(),
      gen: liveGen?.id ?? null,
      pending: pendingRequests.length,
    });
  };

  const checkListeners = () => {
    if (appStateHandlers.size > 1)
      violate(`K8 ${appStateHandlers.size} AppState listeners registered`);
  };

  const serve = (
    req: PendingRequest,
    outcome: Outcome,
  ): { response: Response; issued: Issued | null } => {
    const nowMs = Date.now();
    const n = ++rotationCounter;
    const access = `access-${req.gen.actor}-${n}`;
    const refresh = `rot-${req.gen.actor}-${n}`;
    const session = (over: Record<string, unknown>) => ({
      session: {
        accessToken: access,
        refreshToken: refresh,
        expiresAt: Math.floor(nowMs / 1000) + 3600,
        ...over,
      },
    });
    switch (outcome) {
      case 'ok': {
        const expiresAt = Math.floor(nowMs / 1000) + 3600;
        return {
          response: jsonResponse(200, session({ expiresAt })),
          issued: { access, refresh, expiresAt },
        };
      }
      case 'ok_short_life': {
        const expiresAt = Math.floor(nowMs / 1000) + 20;
        return {
          response: jsonResponse(200, session({ expiresAt })),
          issued: { access, refresh, expiresAt },
        };
      }
      case 'ok_expires_in_past': {
        const expiresAt = Math.floor(nowMs / 1000) - 5;
        return {
          response: jsonResponse(200, session({ expiresAt })),
          issued: { access, refresh, expiresAt },
        };
      }
      case 'refused_401':
        return {
          response: jsonResponse(401, { error: { message: 'Sign in again.' } }),
          issued: null,
        };
      case 'refused_403':
        return {
          response: jsonResponse(403, { error: { message: 'Forbidden.' } }),
          issued: null,
        };
      case 'http_429':
        return { response: jsonResponse(429, {}), issued: null };
      case 'http_500':
        return { response: jsonResponse(500, {}), issued: null };
      case 'http_503':
        return { response: jsonResponse(503, {}), issued: null };
      case 'malformed_body':
        return { response: jsonResponse(200, { user: {} }), issued: null };
      case 'malformed_expires':
        return {
          response: jsonResponse(200, session({ expiresAt: 'soon' })),
          issued: null,
        };
      case 'net_error':
      case 'hang_until_timeout':
        return { response: jsonResponse(599, null), issued: null };
    }
  };

  /** Release one held request. Does NOT flush: the keeper's continuation
   * runs at the next microtask checkpoint, so anything the scheduler does
   * synchronously afterwards races the answer. */
  const settle = (req: PendingRequest, requested: Outcome) => {
    const idx = pendingRequests.indexOf(req);
    if (idx >= 0) pendingRequests.splice(idx, 1);
    const { gen } = req;
    // Strict server rotation: a token the server already spent is refused.
    let outcome = requested;
    if (
      !serverValid[gen.actor].has(req.sentToken) &&
      outcome !== 'net_error' &&
      outcome !== 'hang_until_timeout'
    ) {
      outcome = 'refused_401';
    }
    if (outcome === 'net_error') {
      req.reject(new TypeError('Network request failed'));
      return;
    }
    if (outcome === 'hang_until_timeout') {
      // Leave it to the keeper's 15 s abort; nothing to do here but keep it
      // pending so the abort path is what settles it.
      pendingRequests.push(req);
      req.trigger += '+hang';
      return;
    }
    if (isRefusal(outcome)) {
      refusalsDelivered += 1;
      gen.refusalDelivered = true;
    }
    const served = serve(req, outcome);
    record(
      'settle',
      `req=${req.id} gen=${gen.id} ${outcome}${outcome !== requested ? ` (requested ${requested})` : ''}`,
    );
    req.timeline.ok = served.issued !== null;
    if (served.issued) {
      serverValid[gen.actor].delete(req.sentToken);
      serverValid[gen.actor].add(served.issued.refresh);
      gen.spent.add(req.sentToken);
      gen.issued.set(served.issued.refresh, served.issued);
      // The keeper adopts the new token before onRotated, but only if it is
      // still live when the answer is processed; a dead generation never
      // sends again, so this is the right expectation either way.
      gen.expectedToken = served.issued.refresh;
    }
    req.resolve(served.response);
  };

  const fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
    const gen = liveGen;
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      refreshToken?: string;
    };
    const sent = body.refreshToken ?? '<none>';
    if (!url.endsWith('/v1/auth/refresh')) violate(`unexpected url ${url}`);
    if (!gen) {
      violate(`K2 request sent while no keeper is live (token ${sent})`);
      return Promise.reject(new TypeError('no live keeper'));
    }
    // Attribute the request to the generation whose token it carries; the
    // keeper only ever sends the live generation's token when correct.
    const owner =
      gens.find(g => g.live && g.expectedToken === sent) ??
      gens.find(g => g.expectedToken === sent) ??
      gen;
    if (!owner.live) violate(`K2 dead generation ${owner.id} sent a request`);
    if (owner !== gen)
      violate(
        `K2/K5 request token ${sent} belongs to gen ${owner.id}, live gen is ${gen.id}`,
      );
    if (owner.inflight > 0)
      violate(`K1 gen ${owner.id} has ${owner.inflight} request(s) in flight`);
    if (pendingRequests.some(p => p.gen !== owner)) crossGenOverlaps += 1;
    if (sent !== owner.expectedToken)
      violate(
        `K5 gen ${owner.id} sent ${sent}, expected ${owner.expectedToken}`,
      );
    if (owner.spent.has(sent))
      violate(`K5 double spend: gen ${owner.id} re-sent rotated token ${sent}`);
    if (owner.revokedCalls > 0)
      violate(`K4 gen ${owner.id} sent a request after onRevoked`);
    if (requestTimes.length >= MAX_REQUESTS_PER_SEED) {
      violate(
        `K9 request storm: ${requestTimes.length} requests in one seed (cap ${MAX_REQUESTS_PER_SEED}); keeper cut off`,
      );
      stopSessionKeeper();
      return Promise.reject(new TypeError('request storm: keeper cut off'));
    }
    if (currentOp.startsWith('burst')) burstRequests += 1;
    const entry = {
      t: t(),
      viaTimer: currentOp === 'advance' || currentOp === 'drain',
      ok: null as boolean | null,
    };
    owner.timeline.push(entry);
    owner.inflight += 1;
    owner.requests += 1;
    requestTimes.push(t());
    return new Promise<Response>((resolve, reject) => {
      const req: PendingRequest = {
        id: nextRequestId++,
        gen: owner,
        sentToken: sent,
        signal: init?.signal ?? undefined,
        resolve: r => {
          owner.inflight -= 1;
          if (entry.ok === null) entry.ok = false;
          resolve(r);
        },
        reject: e => {
          owner.inflight -= 1;
          if (entry.ok === null) entry.ok = false;
          reject(e);
        },
        t: t(),
        trigger: currentOp,
        timeline: entry,
      };
      req.signal?.addEventListener('abort', () => {
        const idx = pendingRequests.indexOf(req);
        if (idx >= 0) {
          pendingRequests.splice(idx, 1);
          record('abort', `req=${req.id} gen=${owner.id}`);
          req.reject(abortError());
        }
      });
      pendingRequests.push(req);
      record(
        'fetch',
        `req=${req.id} gen=${owner.id} token=${sent} via=${currentOp}`,
      );
      if (autoSettle) settle(req, autoSettle);
    });
  };

  /** A failed onRotated (persist error) makes the keeper retry in 5 s with
   * the NEW token — a retry, not a rotation storm — so the request it
   * followed does not count as a success for the K10 spacing check. */
  const markRotationFailed = (gen: Gen) => {
    const last = gen.timeline[gen.timeline.length - 1];
    if (last) last.ok = false;
  };

  const settleCallback = (cb: PendingCallback, reject: boolean) => {
    const idx = pendingCallbacks.indexOf(cb);
    if (idx >= 0) pendingCallbacks.splice(idx, 1);
    // A rejecting onRevoked escapes `void refresh()` as an unhandled promise
    // rejection (see sessionKeeperConcurrencyDirected.stress.test.ts, which
    // pins that as a contract gap); it would abort the whole campaign here,
    // so only onRotated is rejected by the scheduler.
    if (reject && cb.kind === 'rotated') {
      markRotationFailed(cb.gen);
      cb.reject(new Error(`${cb.kind} callback failed`));
    } else cb.resolve();
  };

  const reenter = (gen: Gen) => {
    switch (gen.reentry) {
      case 'none':
        return;
      case 'refresh_now':
        refreshSessionNow();
        return;
      case 'restart_same':
        stop('reentrant');
        start(gen.actor, 'reentrant');
        return;
    }
  };

  const stop = (why: string) => {
    if (liveGen) liveGen.live = false;
    liveGen = null;
    stopSessionKeeper();
    record('stop', why);
    checkListeners();
  };

  const start = (actor: Actor, why: string) => {
    if (liveGen) liveGen.live = false;
    const v = vault[actor];
    if (!serverValid[actor].has(v.token)) staleVaultRestarts += 1;
    const gen: Gen = {
      id: nextGenId++,
      actor,
      startedAtOp: opIndex,
      skewMs: pick(rng, SKEWS),
      reentry: pick<Reentry>(rng, [
        'none',
        'none',
        'none',
        'refresh_now',
        'restart_same',
      ]),
      rotatedMode: pick<CallbackMode>(rng, ['sync', 'async_scheduled']),
      revokedMode: pick<CallbackMode>(rng, ['sync', 'async_scheduled']),
      rejectRotated: chance(rng, 0.1),
      expectedToken: v.token,
      spent: new Set(),
      issued: new Map(),
      adopted: new Set(),
      inflight: 0,
      requests: 0,
      rotatedCalls: 0,
      revokedCalls: 0,
      deferredCalls: 0,
      refusalDelivered: false,
      live: true,
      timeline: [],
    };
    gens.push(gen);
    liveGen = gen;
    const skewedNow = () => Date.now() + gen.skewMs;
    startSessionKeeper({
      apiBaseUrl: 'https://api.example.test',
      refreshToken: v.token,
      bearerExpiresAtMs: v.expiresAtMs,
      fetchFn,
      now: skewedNow,
      onRotated: (tokens: RefreshedTokens) => {
        gen.rotatedCalls += 1;
        record(
          'callback',
          `onRotated gen=${gen.id} token=${tokens.refreshToken}`,
        );
        if (!gen.live) {
          violate(`K3 onRotated began for dead gen ${gen.id}`);
        }
        if (gen.revokedCalls > 0)
          violate(`K4 onRotated after onRevoked for gen ${gen.id}`);
        const issued = gen.issued.get(tokens.refreshToken);
        if (!issued) {
          violate(
            `K6 onRotated token ${tokens.refreshToken} was not issued to gen ${gen.id}`,
          );
        } else if (
          tokens.bearerToken !== issued.access ||
          tokens.bearerExpiresAtMs !== issued.expiresAt * 1000
        ) {
          violate(`K6 onRotated payload differs from what the server issued`);
        }
        if (gen.adopted.has(tokens.refreshToken))
          violate(`K6 rotation ${tokens.refreshToken} adopted twice`);
        gen.adopted.add(tokens.refreshToken);
        if (gen.live) {
          vault[gen.actor] = {
            token: tokens.refreshToken,
            expiresAtMs: tokens.bearerExpiresAtMs,
          };
        }
        reenter(gen);
        if (gen.rotatedMode === 'sync') {
          if (gen.rejectRotated) {
            markRotationFailed(gen);
            throw new Error('persist failed');
          }
          return undefined;
        }
        return new Promise<void>((resolve, reject) => {
          pendingCallbacks.push({ gen, kind: 'rotated', resolve, reject });
        });
      },
      onRevoked: () => {
        gen.revokedCalls += 1;
        record('callback', `onRevoked gen=${gen.id}`);
        if (!gen.live) violate(`K3 onRevoked began for dead gen ${gen.id}`);
        if (gen.revokedCalls > 1)
          violate(`K4 onRevoked called ${gen.revokedCalls}× for gen ${gen.id}`);
        if (!gen.refusalDelivered)
          violate(`K4 onRevoked without a delivered 401/403 for gen ${gen.id}`);
        // The keeper stopped itself; from here on the harness treats the
        // generation as finished. Reentrant "restart" after revocation is a
        // fresh sign-in: the actor gets a brand-new server-valid token.
        if (liveGen === gen) liveGen = null;
        gen.live = false;
        const fresh = `signin-${gen.actor}-${++rotationCounter}`;
        serverValid[gen.actor].add(fresh);
        vault[gen.actor] = { token: fresh, expiresAtMs: null };
        if (gen.reentry === 'restart_same') start(gen.actor, 'reentrant');
        if (gen.revokedMode === 'sync') return undefined;
        return new Promise<void>((resolve, reject) => {
          pendingCallbacks.push({ gen, kind: 'revoked', resolve, reject });
        });
      },
      onDeferred: error => {
        gen.deferredCalls += 1;
        record(
          'callback',
          `onDeferred gen=${gen.id} ${error instanceof Error ? error.message : String(error)}`,
        );
        if (!gen.live) violate(`K3 onDeferred began for dead gen ${gen.id}`);
        if (gen.revokedCalls > 0)
          violate(`K4 onDeferred after onRevoked for gen ${gen.id}`);
      },
    });
    record('start_same', `${why} actor=${actor} gen=${gen.id}`);
    checkListeners();
  };

  const fireAppState = (state: string) => {
    for (const handler of Array.from(appStateHandlers)) handler(state);
  };

  const flush = async () => {
    await jest.advanceTimersByTimeAsync(0);
  };

  /** A burst of N triggers spread over microtasks (Promise.all). */
  const burst = async (kind: 'refresh' | 'foreground' | 'mixed') => {
    const n = pick(rng, BURST_SIZES);
    const gen = liveGen;
    const requestsBefore = gen?.requests ?? 0;
    const inflightBefore = (gen?.inflight ?? 0) > 0;
    currentOp = `burst:${kind}`;
    burstTriggers += n;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        Promise.resolve().then(() => {
          if (kind === 'refresh') {
            refreshSessionNow();
          } else if (kind === 'foreground') {
            if (i % 3 === 1) fireAppState('background');
            else if (i % 3 === 2) fireAppState('inactive');
            else fireAppState('active');
          } else {
            const r = rng();
            if (r < 0.35) refreshSessionNow();
            else if (r < 0.7) fireAppState('active');
            else if (r < 0.8) fireAppState('background');
            else if (r < 0.9 && pendingRequests.length > 0)
              settle(pick(rng, pendingRequests), pick(rng, OUTCOME_POOL));
            else if (pendingCallbacks.length > 0)
              settleCallback(pick(rng, pendingCallbacks), chance(rng, 0.2));
          }
        }),
      ),
    );
    // K7: duplicate triggers on ONE live generation collapse to ≤ 1 request
    // (0 when a request was already in flight). Mixed bursts may settle a
    // request mid-burst, which legitimately re-arms the keeper, so the
    // strict check is for the pure bursts.
    if (kind !== 'mixed' && gen && gen === liveGen) {
      const sent = gen.requests - requestsBefore;
      if (sent > 1)
        violate(`K7 burst of ${n} ${kind} triggers sent ${sent} requests`);
      if (inflightBefore && sent > 0)
        violate(`K7 burst of ${n} ${kind} during in-flight sent ${sent}`);
    }
    record(
      kind === 'refresh'
        ? 'refresh_burst'
        : kind === 'foreground'
          ? 'foreground_burst'
          : 'mixed_burst',
      `n=${n} sent=${(liveGen?.requests ?? 0) - requestsBefore}`,
    );
    currentOp = 'idle';
  };

  // ── Schedule ──────────────────────────────────────────────────────────────
  start(chance(rng, 0.85) ? 'A' : 'B', 'initial');
  if (chance(rng, 0.5)) {
    // Start from a persisted bearer expiry rather than an immediate refresh.
    stop('reseed');
    vault.A.expiresAtMs =
      Date.now() +
      pick(rng, [-10_000, 20_000, 59_000, 61_000, 5 * 60_000, 3_600_000]);
    start('A', 'initial-with-expiry');
  }
  const opCount = 12 + Math.floor(rng() * 28);
  for (opIndex = 1; opIndex <= opCount; opIndex++) {
    const r = rng();
    if (r < 0.24) {
      currentOp = 'advance';
      const ms = pick(rng, ADVANCES);
      await jest.advanceTimersByTimeAsync(ms);
      record('advance', `${ms}ms`);
    } else if (r < 0.46) {
      if (pendingRequests.length > 0) {
        const req = pick(rng, pendingRequests);
        const outcome = pick(rng, OUTCOME_POOL);
        currentOp = 'settle';
        settle(req, outcome);
        // Sometimes race the continuation: act BEFORE flushing.
        const race = rng();
        if (race < 0.15) stop('race-after-settle');
        else if (race < 0.25) start(req.gen.actor, 'race-restart-after-settle');
        else if (race < 0.32)
          start(req.gen.actor === 'A' ? 'B' : 'A', 'race-switch-after-settle');
        else if (race < 0.45) refreshSessionNow();
        else if (race < 0.55) fireAppState('active');
        if (chance(rng, 0.8)) await flush();
      } else if (pendingCallbacks.length > 0) {
        const cb = pick(rng, pendingCallbacks);
        const reject = chance(rng, 0.2);
        currentOp = 'settle_callback';
        settleCallback(cb, reject);
        record(
          'settle_callback',
          `${cb.kind} gen=${cb.gen.id} reject=${reject}`,
        );
        if (chance(rng, 0.5)) refreshSessionNow();
        if (chance(rng, 0.8)) await flush();
      } else {
        currentOp = 'advance';
        await jest.advanceTimersByTimeAsync(1_000);
        record('advance', '1000ms (nothing pending)');
      }
    } else if (r < 0.54) {
      if (pendingCallbacks.length > 0) {
        const cb = pick(rng, pendingCallbacks);
        const reject = chance(rng, 0.25);
        currentOp = 'settle_callback';
        settleCallback(cb, reject);
        record(
          'settle_callback',
          `${cb.kind} gen=${cb.gen.id} reject=${reject}`,
        );
        if (chance(rng, 0.7)) await flush();
      } else {
        await burst('refresh');
      }
    } else if (r < 0.64) {
      await burst('refresh');
    } else if (r < 0.74) {
      await burst('foreground');
    } else if (r < 0.82) {
      await burst('mixed');
    } else if (r < 0.87) {
      currentOp = 'stop';
      stop('logout');
      if (chance(rng, 0.5)) await flush();
    } else if (r < 0.94) {
      currentOp = 'start_same';
      const actor = current()?.actor ?? (chance(rng, 0.5) ? 'A' : 'B');
      start(actor, 'restart');
      if (chance(rng, 0.5)) await flush();
    } else {
      currentOp = 'start_other';
      const actor: Actor = current()?.actor === 'A' ? 'B' : 'A';
      start(actor, 'switch');
      record('start_other', `actor=${actor}`);
      if (chance(rng, 0.5)) await flush();
    }
    checkListeners();
    if (REAL_NOW() - wallStart > PER_SEED_WALL_BOUND_MS) {
      violate(`K9 wall-clock bound exceeded mid-schedule`);
      break;
    }
  }

  // ── Drain ─────────────────────────────────────────────────────────────────
  // Answer everything still held, let callbacks resolve, then run past the
  // hang timeout, the max backoff and a full bearer lifetime PLUS the worst
  // clock skew: a live, non-revoked keeper must prove it is not deadlocked by
  // sending again. Requests sent during the drain are answered 'ok' at once.
  currentOp = 'drain';
  record('drain', 'begin');
  const liveAtDrain = current();
  const requestsBeforeDrain = liveAtDrain?.requests ?? 0;
  const drainRefusal = liveAtDrain !== null && chance(rng, 0.1);
  for (const req of pendingRequests.slice()) {
    settle(req, drainRefusal && req.gen === liveAtDrain ? 'refused_401' : 'ok');
  }
  for (const cb of pendingCallbacks.slice()) settleCallback(cb, false);
  await flush();
  autoSettle = 'ok';
  await jest.advanceTimersByTimeAsync(15_000 + retryDelayMs(99) + 1_000);
  for (const cb of pendingCallbacks.slice()) settleCallback(cb, false);
  await jest.advanceTimersByTimeAsync(3 * 3_600_000 + 3_600_000 + 1_000);
  for (const cb of pendingCallbacks.slice()) settleCallback(cb, false);
  await flush();
  const simulatedMs = t();

  if (
    liveAtDrain &&
    liveAtDrain === current() &&
    liveAtDrain.live &&
    liveAtDrain.revokedCalls === 0 &&
    liveAtDrain.requests === requestsBeforeDrain
  ) {
    violate(
      `K9 live gen ${liveAtDrain.id} went silent through the drain window (deadlock)`,
    );
  }
  for (const gen of gens) {
    if (gen.refusalDelivered && gen.revokedCalls === 0 && gen.live) {
      violate(`K4 gen ${gen.id} received a refusal but never revoked`);
    }
    // K6 lost update: every rotation the server issued to a generation that
    // stayed live through the drain must have been adopted.
    if (gen.live && gen.revokedCalls === 0) {
      for (const refresh of gen.issued.keys()) {
        if (!gen.adopted.has(refresh))
          violate(`K6 lost rotation ${refresh} for live gen ${gen.id}`);
      }
    } else {
      for (const refresh of gen.issued.keys())
        if (!gen.adopted.has(refresh)) lateAnswersDropped += 1;
    }
    // K10: a timer-driven request directly following a successful rotation
    // is at least 30 s later (a foreground / refresh-now trigger in between
    // is the caller's call and resets the spacing).
    for (let i = 1; i < gen.timeline.length; i++) {
      const prev = gen.timeline[i - 1]!;
      const cur = gen.timeline[i]!;
      if (cur.viaTimer && prev.ok === true && cur.t - prev.t < 30_000)
        violate(
          `K10 gen ${gen.id} rotated again ${cur.t - prev.t} ms after a success`,
        );
    }
  }

  // Final stop: no listener, no timer may survive.
  stop('final');
  await flush();
  if (appStateHandlers.size !== 0)
    violate(
      `K8 ${appStateHandlers.size} AppState listener(s) after final stop`,
    );
  if (jest.getTimerCount() !== 0)
    violate(`K8 ${jest.getTimerCount()} timer(s) after final stop`);

  let maxRequestsInAny60s = 0;
  for (let i = 0; i < requestTimes.length; i++) {
    let j = i;
    while (
      j < requestTimes.length &&
      requestTimes[j]! - requestTimes[i]! < 60_000
    )
      j++;
    maxRequestsInAny60s = Math.max(maxRequestsInAny60s, j - i);
  }
  const wallMs = REAL_NOW() - wallStart;
  if (wallMs > PER_SEED_WALL_BOUND_MS)
    violate(
      `K9 seed took ${wallMs} ms of wall clock (bound ${PER_SEED_WALL_BOUND_MS})`,
    );

  if (droppedViolations > 0)
    violations.push(`… ${droppedViolations} further violation(s) not recorded`);

  return {
    seed,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    violations,
    ops: opCount,
    generations: gens.length,
    requests: gens.reduce((s, g) => s + g.requests, 0),
    crossGenOverlaps,
    rotations: gens.reduce((s, g) => s + g.rotatedCalls, 0),
    revocations: gens.reduce((s, g) => s + g.revokedCalls, 0),
    deferred: gens.reduce((s, g) => s + g.deferredCalls, 0),
    refusalsDelivered,
    lateAnswersDropped,
    burstTriggers,
    burstRequests,
    staleVaultRestarts,
    maxRequestsInAny60s,
    simulatedMs,
    wallMs,
    log,
  };
}

// ─── Test ────────────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '../../../../artifacts/stress/mod-session-keeper');
const SUITE = '__tests__/stress/sessionKeeperConcurrency.stress.test.ts';

describe('stress/concurrency: sessionKeeper under seeded interleavings', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    appStateHandlers = new Set();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      appStateHandlers.add(handler);
      return {
        remove: () => {
          appStateHandlers.delete(handler);
        },
      };
    }) as unknown as typeof AppState.addEventListener);
  });

  afterEach(() => {
    stopSessionKeeper();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('holds K1–K10 across every seeded interleaving', async () => {
    const only = process.env.STRESS_SEED
      ? Number(process.env.STRESS_SEED)
      : null;
    const iterations =
      only !== null ? 1 : Number(process.env.STRESS_ITER ?? 120);
    const seeds =
      only !== null ? [only] : Array.from({ length: iterations }, (_, i) => i);

    const wallStart = REAL_NOW();
    const results: SeedResult[] = [];
    for (const seed of seeds) {
      results.push(await runSeed(seed));
      // Each seed leaves the module fenced (final stop); make sure nothing
      // leaks into the next one.
      stopSessionKeeper();
      appStateHandlers.clear();
    }
    const wallMs = REAL_NOW() - wallStart;
    const failures = results.filter(r => r.verdict === 'FAIL');

    const sum = (f: (r: SeedResult) => number) =>
      results.reduce((s, r) => s + f(r), 0);
    const report = {
      unit: 'mod-session-keeper',
      lens: 'concurrency',
      plane:
        'mobile (jest, real sessionKeeper + sessionLifecycle, scheduler-held fetch, fake timers)',
      generatedAt: new Date(REAL_NOW()).toISOString(),
      node: process.version,
      seeds: {
        count: results.length,
        first: seeds[0],
        last: seeds[seeds.length - 1],
        replay: `STRESS_SEED=<seed> npx jest --ci ${SUITE}`,
      },
      wallMs,
      totals: {
        pass: results.length - failures.length,
        fail: failures.length,
        ops: sum(r => r.ops),
        generations: sum(r => r.generations),
        requests: sum(r => r.requests),
        crossGenOverlaps: sum(r => r.crossGenOverlaps),
        rotations: sum(r => r.rotations),
        revocations: sum(r => r.revocations),
        deferred: sum(r => r.deferred),
        refusalsDelivered: sum(r => r.refusalsDelivered),
        lateAnswersDropped: sum(r => r.lateAnswersDropped),
        burstTriggers: sum(r => r.burstTriggers),
        burstRequests: sum(r => r.burstRequests),
        staleVaultRestarts: sum(r => r.staleVaultRestarts),
        maxRequestsInAny60s: Math.max(
          0,
          ...results.map(r => r.maxRequestsInAny60s),
        ),
        maxSeedWallMs: Math.max(0, ...results.map(r => r.wallMs)),
      },
      failures: failures.map(f => ({
        seed: f.seed,
        replay: `STRESS_SEED=${f.seed} npx jest --ci ${SUITE}`,
        violations: f.violations,
        log: f.log,
      })),
      // Single-seed replays keep the full op log even when the seed passes.
      replay_log: only !== null ? results[0]!.log : undefined,
      seeds_table: results.map(({ log: _log, violations, ...rest }) => ({
        ...rest,
        violations: violations.slice(0, 5),
      })),
    };
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date(REAL_NOW()).toISOString().replace(/[:.]/g, '-');
    const file = path.join(OUT_DIR, `concurrency-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(OUT_DIR, 'concurrency-latest.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `[stress/mod-session-keeper/concurrency] ${results.length} seeds, ${failures.length} failures, ` +
        `${report.totals.requests} requests, ${report.totals.burstTriggers} burst triggers, wall ${wallMs} ms → ${file}`,
    );

    if (only === null) {
      // The campaign must have actually exercised every window it claims.
      expect(report.totals.crossGenOverlaps).toBeGreaterThan(0);
      expect(report.totals.lateAnswersDropped).toBeGreaterThan(0);
      expect(report.totals.revocations).toBeGreaterThan(0);
      expect(report.totals.rotations).toBeGreaterThan(0);
      expect(report.totals.burstTriggers).toBeGreaterThan(results.length);
    }
    expect(
      failures.map(f => ({
        seed: f.seed,
        violations: f.violations.slice(0, 5),
      })),
    ).toEqual([]);
  });
});
