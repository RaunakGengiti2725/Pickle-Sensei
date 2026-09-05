/**
 * xc-matrix-network-auth-2 — MOBILE plane, seeded adversarial fuzz of the
 * session keeper (sessionKeeper.ts + sessionLifecycle.ts, nothing mocked in
 * between) under NETWORK × AUTH cell 2:
 *
 *   NETWORK ∈ { offline, intermittent, reconnect }
 *   AUTH    ∈ { revoked (401/403), malformed token/payload, refresh 5xx/4xx }
 *
 * Every seed builds a deterministic schedule (mulberry32 PRNG): a network
 * state machine decides whether each refresh attempt reaches the server
 * (offline → never; intermittent → coin flip; reconnect → offline for the
 * first R attempts, then online), and a seeded auth outcome is served for the
 * attempts that get through. App events (foreground, an API 401 report via
 * refreshSessionNow, time jumps up to hours) are interleaved. Timers are
 * jest fake timers, so hours of retry backoff run in milliseconds.
 *
 * Invariants checked per seed (any violation = FAIL, recorded with the seed
 * and the full attempt log so it is replayable via XC_SEED=<n>):
 *   I1  onRevoked fires iff a 401/403 refresh response was DELIVERED, and
 *       at most once. Network trouble, timeouts, 5xx, 4xx other than
 *       401/403, and malformed payloads never revoke.
 *   I2  After onRevoked no further refresh request is ever sent.
 *   I3  Every delivered transient failure and every network failure is
 *       reported via onDeferred, and the keeper stays alive: advancing past
 *       the maximum backoff always produces another attempt.
 *   I4  Refresh-token continuity: every request carries the most recently
 *       rotated refresh token — a spent token is never re-sent after a
 *       successful rotation.
 *   I5  At most one refresh request is in flight at any time.
 *   I6  onRotated reports exactly the tokens the server returned.
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts
 *   XC_SEEDS=5000 npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts
 *   XC_SEED=1234  npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts   (replay one)
 * Artifacts: artifacts/xc-matrix-network-auth-2/mobile/keeper-fuzz-*.json (XC_OUT overrides).
 */
import { AppState } from 'react-native';
import {
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import type { RefreshedTokens } from '../../src/account/sessionLifecycle';

/** Node globals the RN tsconfig does not declare (same pattern as
 * be-mobile-security-secrets.test.ts / liveCourt.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number; rss: number; external: number };
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

/** What the classifier sees when the app-side timeout aborts the fetch. */
function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

/** Captured before fake timers are installed: real wall clock for stamps/durations. */
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

// ─── Matrix axes ─────────────────────────────────────────────────────────────

type Network = 'offline' | 'intermittent' | 'reconnect';
const NETWORKS: readonly Network[] = ['offline', 'intermittent', 'reconnect'];

/** What the server answers when a request gets through. */
type AuthOutcome =
  | 'ok'
  | 'ok_expires_in_past' // clock skew: server says the bearer is already expired
  | 'refused_401'
  | 'refused_403'
  | 'http_400'
  | 'http_404'
  | 'http_408'
  | 'http_418'
  | 'http_429'
  | 'http_500'
  | 'http_502'
  | 'http_503'
  | 'http_504'
  | 'malformed_non_json'
  | 'malformed_null_body'
  | 'malformed_no_session'
  | 'malformed_missing_refresh'
  | 'malformed_empty_access'
  | 'malformed_expires_string'
  | 'malformed_expires_nan'
  | 'malformed_expires_infinity'
  | 'malformed_tokens_numbers'
  | 'malformed_whitespace_tokens'
  | 'malformed_json_throws_sync';

const REFUSALS: readonly AuthOutcome[] = ['refused_401', 'refused_403'];
const TRANSIENT_HTTP: readonly AuthOutcome[] = [
  'http_400',
  'http_404',
  'http_408',
  'http_418',
  'http_429',
  'http_500',
  'http_502',
  'http_503',
  'http_504',
];
const MALFORMED: readonly AuthOutcome[] = [
  'malformed_non_json',
  'malformed_null_body',
  'malformed_no_session',
  'malformed_missing_refresh',
  'malformed_empty_access',
  'malformed_expires_string',
  'malformed_expires_nan',
  'malformed_expires_infinity',
  'malformed_tokens_numbers',
  'malformed_whitespace_tokens',
  'malformed_json_throws_sync',
];

/** How the network treats a request that the keeper sends. */
type Transport = 'delivered' | 'net_error' | 'hang_until_timeout';

const isRefusal = (o: AuthOutcome) => REFUSALS.includes(o);

// ─── Fake server responses ───────────────────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

let rotationCounter = 0;

function serve(
  outcome: AuthOutcome,
  nowMs: number,
): {
  response: Response;
  issued: { access: string; refresh: string; expiresAt: number } | null;
} {
  const n = ++rotationCounter;
  const access = `access-${n}`;
  const refresh = `refresh-${n}`;
  const expiresAt = Math.floor(nowMs / 1000) + 3600;
  const session = (over: Record<string, unknown>) => ({
    session: { accessToken: access, refreshToken: refresh, expiresAt, ...over },
  });
  switch (outcome) {
    case 'ok':
      return {
        response: jsonResponse(200, session({})),
        issued: { access, refresh, expiresAt },
      };
    case 'ok_expires_in_past': {
      const past = Math.floor(nowMs / 1000) - 5;
      return {
        response: jsonResponse(200, session({ expiresAt: past })),
        issued: { access, refresh, expiresAt: past },
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
    case 'http_400':
      return {
        response: jsonResponse(400, { error: { code: 'validation.refresh' } }),
        issued: null,
      };
    case 'http_404':
      return {
        response: jsonResponse(404, { error: { message: 'Not found.' } }),
        issued: null,
      };
    case 'http_408':
      return { response: jsonResponse(408, {}), issued: null };
    case 'http_418':
      return { response: jsonResponse(418, {}), issued: null };
    case 'http_429':
      return {
        response: jsonResponse(429, {
          error: { message: 'Too many requests.' },
        }),
        issued: null,
      };
    case 'http_500':
      return {
        response: jsonResponse(500, { error: { message: 'Internal.' } }),
        issued: null,
      };
    case 'http_502':
      return { response: jsonResponse(502, null), issued: null };
    case 'http_503':
      return {
        response: jsonResponse(503, {
          error: { message: 'Session refresh is unavailable.' },
        }),
        issued: null,
      };
    case 'http_504':
      return { response: jsonResponse(504, null), issued: null };
    case 'malformed_non_json':
      return {
        response: {
          ok: true,
          status: 200,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response,
        issued: null,
      };
    case 'malformed_null_body':
      return { response: jsonResponse(200, null), issued: null };
    case 'malformed_no_session':
      return {
        response: jsonResponse(200, { user: { id: 'x' } }),
        issued: null,
      };
    case 'malformed_missing_refresh':
      return {
        response: jsonResponse(200, session({ refreshToken: undefined })),
        issued: null,
      };
    case 'malformed_empty_access':
      return {
        response: jsonResponse(200, session({ accessToken: '' })),
        issued: null,
      };
    case 'malformed_expires_string':
      return {
        response: jsonResponse(200, session({ expiresAt: String(expiresAt) })),
        issued: null,
      };
    case 'malformed_expires_nan':
      return {
        response: jsonResponse(200, session({ expiresAt: Number.NaN })),
        issued: null,
      };
    case 'malformed_expires_infinity':
      return {
        response: jsonResponse(
          200,
          session({ expiresAt: Number.POSITIVE_INFINITY }),
        ),
        issued: null,
      };
    case 'malformed_tokens_numbers':
      return {
        response: jsonResponse(
          200,
          session({ accessToken: 12345, refreshToken: 67890 }),
        ),
        issued: null,
      };
    case 'malformed_whitespace_tokens':
      return {
        response: jsonResponse(
          200,
          session({ accessToken: '   ', refreshToken: '\t' }),
        ),
        issued: null,
      };
    case 'malformed_json_throws_sync':
      return {
        response: {
          ok: true,
          status: 200,
          json: () => {
            throw new TypeError('body stream already read');
          },
        } as unknown as Response,
        issued: null,
      };
  }
}

// ─── Scenario ────────────────────────────────────────────────────────────────

type AppEvent =
  | { kind: 'advance'; ms: number }
  | { kind: 'foreground' }
  | { kind: 'api_401_report' };

interface Scenario {
  seed: number;
  network: Network;
  /** reconnect: attempts that fail before the network comes back. */
  reconnectAfterAttempts: number;
  /** intermittent: probability a request is dropped. */
  dropProbability: number;
  /** offline: fraction of drops that hang until the 15 s timeout (vs reject). */
  hangProbability: number;
  /** Auth outcomes served to delivered requests, cycled. */
  authScript: AuthOutcome[];
  initialBearerExpiresInMs: number | null;
  events: AppEvent[];
}

interface Attempt {
  t: number;
  refreshTokenSent: string;
  transport: Transport;
  outcome: AuthOutcome | null;
  inflightAtStart: number;
  settled: boolean;
}

interface SeedResult {
  seed: number;
  network: Network;
  verdict: 'PASS' | 'FAIL';
  violations: string[];
  attempts: number;
  delivered: number;
  refusalsDelivered: number;
  revokedCalls: number;
  rotatedCalls: number;
  deferredCalls: number;
  authClasses: Record<
    'ok' | 'refusal' | 'transient_http' | 'malformed',
    number
  >;
  maxRequestsInAny60s: number;
  simulatedMs: number;
  log: Attempt[];
}

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const network = NETWORKS[seed % NETWORKS.length]!;
  const authPool: AuthOutcome[] = [];
  // Weighted pool: healthy rotations, refusals, transient HTTP and malformed
  // payloads all appear; refusals are rare so most seeds exercise the
  // stay-signed-in paths for many attempts before (maybe) a revocation.
  for (let i = 0; i < 6; i++) authPool.push('ok');
  authPool.push('ok_expires_in_past');
  for (const o of TRANSIENT_HTTP) authPool.push(o);
  for (const o of MALFORMED) authPool.push(o);
  authPool.push(pick(rng, REFUSALS));
  const scriptLength = 6 + Math.floor(rng() * 10);
  const authScript: AuthOutcome[] = [];
  for (let i = 0; i < scriptLength; i++) authScript.push(pick(rng, authPool));

  const eventCount = 8 + Math.floor(rng() * 12);
  const events: AppEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    const r = rng();
    if (r < 0.6) {
      events.push({
        kind: 'advance',
        ms: pick(rng, [
          1_000,
          4_999,
          5_000,
          16_000,
          61_000,
          5 * 60_000,
          11 * 60_000,
          3_600_000,
          9 * 3_600_000,
        ]),
      });
    } else if (r < 0.8) {
      events.push({ kind: 'foreground' });
    } else {
      events.push({ kind: 'api_401_report' });
    }
  }
  return {
    seed,
    network,
    reconnectAfterAttempts: 1 + Math.floor(rng() * 6),
    dropProbability: 0.3 + rng() * 0.5,
    hangProbability: rng(),
    authScript,
    initialBearerExpiresInMs:
      rng() < 0.5
        ? null
        : pick(rng, [
            30_000,
            59_000,
            61_000,
            4 * 60_000,
            30 * 60_000,
            3_600_000,
          ]),
    events,
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

let appStateHandler: ((state: string) => void) | null = null;

async function runScenario(scenario: Scenario): Promise<SeedResult> {
  const rng = mulberry32(scenario.seed ^ 0x9e3779b9);
  const log: Attempt[] = [];
  const violations: string[] = [];
  const rotated: RefreshedTokens[] = [];
  let deferredCalls = 0;
  let revokedCalls = 0;
  let inflight = 0;
  let delivered = 0;
  let refusalsDelivered = 0;
  let scriptIndex = 0;
  let currentRefreshToken = `refresh-seed-${scenario.seed}`;
  let lastIssued: {
    access: string;
    refresh: string;
    expiresAt: number;
  } | null = null;
  const authClasses = { ok: 0, refusal: 0, transient_http: 0, malformed: 0 };
  const start = Date.now();

  const transportFor = (attemptIndex: number): Transport => {
    const drop = (): Transport =>
      rng() < scenario.hangProbability ? 'hang_until_timeout' : 'net_error';
    switch (scenario.network) {
      case 'offline':
        return drop();
      case 'intermittent':
        return rng() < scenario.dropProbability ? drop() : 'delivered';
      case 'reconnect':
        return attemptIndex < scenario.reconnectAfterAttempts
          ? drop()
          : 'delivered';
    }
  };

  // A plain function on purpose: jest.fn() would retain every call's
  // arguments (bodies, AbortSignals) for the whole run and swamp the heap
  // numbers that are meant to reflect the keeper, not the harness.
  const fetchFn = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      refreshToken?: string;
    };
    const sent = body.refreshToken ?? '<none>';
    const attempt: Attempt = {
      t: Date.now() - start,
      refreshTokenSent: sent,
      transport: transportFor(log.length),
      outcome: null,
      inflightAtStart: inflight,
      settled: false,
    };
    log.push(attempt);
    if (!url.endsWith('/v1/auth/refresh'))
      violations.push(`unexpected url ${url}`);
    if (inflight > 0)
      violations.push(`I5 concurrent refresh at t=${attempt.t}`);
    if (sent !== currentRefreshToken) {
      violations.push(
        `I4 stale refresh token sent at t=${attempt.t}: ${sent} (current ${currentRefreshToken})`,
      );
    }
    if (revokedCalls > 0)
      violations.push(`I2 request after revocation at t=${attempt.t}`);
    inflight += 1;
    try {
      if (attempt.transport === 'net_error') {
        throw new TypeError('Network request failed');
      }
      if (attempt.transport === 'hang_until_timeout') {
        await new Promise<never>((_, reject) => {
          const signal = init?.signal;
          if (signal?.aborted) reject(abortError());
          signal?.addEventListener('abort', () => reject(abortError()));
        });
      }
      const outcome =
        scenario.authScript[scriptIndex % scenario.authScript.length]!;
      scriptIndex += 1;
      attempt.outcome = outcome;
      delivered += 1;
      if (isRefusal(outcome)) {
        refusalsDelivered += 1;
        authClasses.refusal += 1;
      } else if (outcome === 'ok' || outcome === 'ok_expires_in_past')
        authClasses.ok += 1;
      else if (TRANSIENT_HTTP.includes(outcome))
        authClasses.transient_http += 1;
      else authClasses.malformed += 1;
      const served = serve(outcome, Date.now());
      if (served.issued) {
        lastIssued = served.issued;
        currentRefreshToken = served.issued.refresh;
      }
      return served.response;
    } finally {
      attempt.settled = true;
      inflight -= 1;
    }
  };

  startSessionKeeper({
    apiBaseUrl: 'https://api.example.test',
    refreshToken: currentRefreshToken,
    bearerExpiresAtMs:
      scenario.initialBearerExpiresInMs === null
        ? null
        : Date.now() + scenario.initialBearerExpiresInMs,
    fetchFn,
    onRotated: tokens => {
      rotated.push(tokens);
      if (
        !lastIssued ||
        tokens.bearerToken !== lastIssued.access ||
        tokens.refreshToken !== lastIssued.refresh ||
        tokens.bearerExpiresAtMs !== lastIssued.expiresAt * 1000
      ) {
        violations.push(
          `I6 onRotated tokens differ from what the server issued`,
        );
      }
    },
    onRevoked: () => {
      revokedCalls += 1;
    },
    onDeferred: () => {
      deferredCalls += 1;
    },
  });

  for (const event of scenario.events) {
    if (event.kind === 'advance') {
      await jest.advanceTimersByTimeAsync(event.ms);
    } else if (event.kind === 'foreground') {
      appStateHandler?.('background');
      appStateHandler?.('active');
      await jest.advanceTimersByTimeAsync(0);
    } else {
      refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
    }
  }
  // Drain: past the hang timeout, the max backoff AND a full bearer lifetime
  // (a healthy rotation schedules the next refresh ~59 min out), so every
  // pending attempt settles and (unless revoked) the keeper proves it is
  // still alive by sending at least one more request.
  const attemptsBeforeDrain = log.length;
  await jest.advanceTimersByTimeAsync(
    15_000 + retryDelayMs(99) + 3_600_000 + 1_000,
  );
  const simulatedMs = Date.now() - start;

  // I1
  if (revokedCalls > 1)
    violations.push(`I1 onRevoked called ${revokedCalls} times`);
  if (refusalsDelivered > 0 && revokedCalls === 0)
    violations.push('I1 refusal delivered but onRevoked never fired');
  if (refusalsDelivered === 0 && revokedCalls > 0)
    violations.push('I1 onRevoked fired without a delivered 401/403');
  // I3
  // The last attempt may still be hanging inside its 15 s timeout when the
  // drain window ends; only settled attempts owe an onDeferred.
  const failuresNotRefused = log.filter(
    a =>
      a.settled &&
      (a.outcome === null ||
        (!isRefusal(a.outcome) &&
          a.outcome !== 'ok' &&
          a.outcome !== 'ok_expires_in_past')),
  ).length;
  if (deferredCalls !== failuresNotRefused) {
    violations.push(
      `I3 onDeferred count ${deferredCalls} != settled non-refusal failures ${failuresNotRefused}`,
    );
  }
  if (revokedCalls === 0 && log.length === attemptsBeforeDrain) {
    violations.push(
      'I3 keeper went silent: no attempt after max backoff drain',
    );
  }
  // Request-rate observation (per-IP refresh budget on the edge is 30/min).
  let maxRequestsInAny60s = 0;
  for (let i = 0; i < log.length; i++) {
    let j = i;
    while (j < log.length && log[j]!.t - log[i]!.t < 60_000) j++;
    maxRequestsInAny60s = Math.max(maxRequestsInAny60s, j - i);
  }

  stopSessionKeeper();
  return {
    seed: scenario.seed,
    network: scenario.network,
    verdict: violations.length === 0 ? 'PASS' : 'FAIL',
    violations,
    attempts: log.length,
    delivered,
    refusalsDelivered,
    revokedCalls,
    rotatedCalls: rotated.length,
    deferredCalls,
    authClasses,
    maxRequestsInAny60s,
    simulatedMs,
    log,
  };
}

// ─── Test ────────────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.XC_OUT ??
  path.resolve(
    __dirname,
    '../../../../artifacts/xc-matrix-network-auth-2/mobile',
  );

describe('xc-matrix-network-auth-2 keeper fuzz: {offline, intermittent, reconnect} × {revoked, malformed, 4xx/5xx}', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    appStateHandler = null;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _type: string,
      handler: (state: string) => void,
    ) => {
      appStateHandler = handler;
      return {
        remove: () => {
          if (appStateHandler === handler) appStateHandler = null;
        },
      };
    }) as unknown as typeof AppState.addEventListener);
  });

  afterEach(() => {
    stopSessionKeeper();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('holds the ONE implicit sign-out rule across every seeded schedule', async () => {
    const only = process.env.XC_SEED ? Number(process.env.XC_SEED) : null;
    const seedCount = only !== null ? 1 : Number(process.env.XC_SEEDS ?? 1500);
    const seeds =
      only !== null ? [only] : Array.from({ length: seedCount }, (_, i) => i);

    const heapBefore = process.memoryUsage();
    const wallStart = REAL_NOW();
    const results: SeedResult[] = [];
    const heapSamples: Array<{
      afterSeeds: number;
      heapUsed: number;
      rss: number;
      attemptsLogged: number;
    }> = [];
    for (const seed of seeds) {
      rotationCounter = 0;
      results.push(await runScenario(buildScenario(seed)));
      if (results.length % 250 === 0) {
        const m = process.memoryUsage();
        heapSamples.push({
          afterSeeds: results.length,
          heapUsed: m.heapUsed,
          rss: m.rss,
          attemptsLogged: results.reduce((s, r) => s + r.attempts, 0),
        });
      }
    }
    const wallMs = REAL_NOW() - wallStart;
    const heapAfter = process.memoryUsage();

    const failures = results.filter(r => r.verdict === 'FAIL');
    const matrix: Record<
      Network,
      {
        seeds: number;
        pass: number;
        fail: number;
        revoked: number;
        refusalsDelivered: number;
        rotations: number;
        deferred: number;
      }
    > = {
      offline: {
        seeds: 0,
        pass: 0,
        fail: 0,
        revoked: 0,
        refusalsDelivered: 0,
        rotations: 0,
        deferred: 0,
      },
      intermittent: {
        seeds: 0,
        pass: 0,
        fail: 0,
        revoked: 0,
        refusalsDelivered: 0,
        rotations: 0,
        deferred: 0,
      },
      reconnect: {
        seeds: 0,
        pass: 0,
        fail: 0,
        revoked: 0,
        refusalsDelivered: 0,
        rotations: 0,
        deferred: 0,
      },
    };
    const authTotals = {
      ok: 0,
      refusal: 0,
      transient_http: 0,
      malformed: 0,
      net_error: 0,
      hang_until_timeout: 0,
    };
    let maxRate = 0;
    let skewSeeds = 0;
    for (const r of results) {
      const row = matrix[r.network];
      row.seeds += 1;
      row[r.verdict === 'PASS' ? 'pass' : 'fail'] += 1;
      row.revoked += r.revokedCalls;
      row.refusalsDelivered += r.refusalsDelivered;
      row.rotations += r.rotatedCalls;
      row.deferred += r.deferredCalls;
      authTotals.ok += r.authClasses.ok;
      authTotals.refusal += r.authClasses.refusal;
      authTotals.transient_http += r.authClasses.transient_http;
      authTotals.malformed += r.authClasses.malformed;
      for (const a of r.log) {
        if (a.transport === 'net_error') authTotals.net_error += 1;
        if (a.transport === 'hang_until_timeout')
          authTotals.hang_until_timeout += 1;
      }
      maxRate = Math.max(maxRate, r.maxRequestsInAny60s);
      if (r.log.some(a => a.outcome === 'ok_expires_in_past')) skewSeeds += 1;
    }
    const rateOutliers = results
      .filter(r => r.maxRequestsInAny60s > 30)
      .map(r => ({
        seed: r.seed,
        network: r.network,
        maxRequestsInAny60s: r.maxRequestsInAny60s,
      }))
      .slice(0, 25);

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const stamp = new Date(REAL_NOW()).toISOString().replace(/[:.]/g, '-');
    const report = {
      cell: 'matrix-network-auth-2',
      plane:
        'mobile (jest, real sessionKeeper + sessionLifecycle, scripted fetch, fake timers)',
      commit: process.env.XC_COMMIT ?? null,
      generatedAt: new Date(REAL_NOW()).toISOString(),
      node: process.version,
      seeds: {
        count: results.length,
        first: seeds[0],
        last: seeds[seeds.length - 1],
        replay:
          'XC_SEED=<seed> npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts',
      },
      wallMs,
      heap: {
        before: heapBefore,
        after: heapAfter,
        heapUsedDeltaBytes: heapAfter.heapUsed - heapBefore.heapUsed,
        rssDeltaBytes: heapAfter.rss - heapBefore.rss,
        note: 'the harness retains one Attempt record per request for replay (see attemptsLogged); the keeper itself is stopped and re-created per seed',
        samples: heapSamples,
      },
      totals: {
        attempts: results.reduce((s, r) => s + r.attempts, 0),
        delivered: results.reduce((s, r) => s + r.delivered, 0),
        ...authTotals,
        revoked: results.reduce((s, r) => s + r.revokedCalls, 0),
        pass: results.length - failures.length,
        fail: failures.length,
      },
      matrix,
      requestRate: {
        maxRequestsInAny60s: maxRate,
        edgePerIpRefreshBudgetPerMinute: 30,
        seedsWithClockSkewOutcome: skewSeeds,
        outliers: rateOutliers,
      },
      failures: failures.map(f => ({
        seed: f.seed,
        network: f.network,
        replay: `XC_SEED=${f.seed} npx jest --ci __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts`,
        scenario: buildScenario(f.seed),
        violations: f.violations,
        log: f.log,
      })),
      seedsSummary: results.map(({ log: _log, ...rest }) => rest),
    };
    const file = path.join(OUT_DIR, `keeper-fuzz-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(OUT_DIR, 'keeper-fuzz-latest.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `[xc-matrix-network-auth-2] keeper fuzz: ${results.length} seeds, ${failures.length} failures, ` +
        `${report.totals.attempts} attempts, wall ${wallMs} ms → ${file}`,
    );

    // Every network mode and every auth class must actually have been exercised.
    if (only === null) {
      for (const network of NETWORKS)
        expect(matrix[network].seeds).toBeGreaterThan(0);
      expect(authTotals.refusal).toBeGreaterThan(0);
      expect(authTotals.transient_http).toBeGreaterThan(0);
      expect(authTotals.malformed).toBeGreaterThan(0);
      expect(authTotals.net_error).toBeGreaterThan(0);
      expect(authTotals.hang_until_timeout).toBeGreaterThan(0);
      expect(
        matrix.reconnect.revoked + matrix.intermittent.revoked,
      ).toBeGreaterThan(0);
      // Offline never delivers anything, so it can never revoke.
      expect(matrix.offline.revoked).toBe(0);
    }
    expect(
      failures.map(f => ({ seed: f.seed, violations: f.violations })),
    ).toEqual([]);
  });
});
