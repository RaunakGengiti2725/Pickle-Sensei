/**
 * Seeded CONCURRENCY stress harness for the `mod-bootstrap-api-session` unit:
 *   src/account/bootstrap.ts   (bootstrapCanonicalAccount — provider token →
 *                               canonical account + Supabase session, 15 s
 *                               own AbortController timeout)
 *   src/account/apiSession.ts  (in-memory bearer store: establish / clear /
 *                               bearerTokenFor per request / reportApiUnauthorized)
 *
 * The real modules run unmodified. Everything around them is a seeded model:
 *   - a fetch double that honours AbortSignal, with a virtual network (arrival
 *     delay → server decision → return delay) driven by jest fake timers;
 *   - a server model that spends a provider ID token / Apple authorization
 *     code exactly once (`signInWithIdToken` semantics) and mints per-account
 *     access tokens whose owner is recoverable from the token text;
 *   - a shadow model of the ApiSession store that is updated in the SAME
 *     callback as the real store call, so every observation has an oracle.
 *
 * Every iteration is replayable from (family, seed). A failure is a concrete
 * invariant violation with the seed, the generated plan and the observation.
 */
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
  type AccountBootstrapResult,
  type AccountProvider,
} from '../../src/account/bootstrap';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
  subscribeToApiSession,
  type ApiSession,
} from '../../src/account/apiSession';

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
}

export const FAMILIES = [
  'duplicate-bootstrap',
  'multi-actor-establish',
  'rotation-during-request',
  'timeout-boundary',
  'clock-skew',
  'subscriber-churn',
] as const;
export type Family = (typeof FAMILIES)[number];

/** Distinct per-family seed stream so (a, s) and (b, s) differ. */
export function familySeed(family: Family, seed: number): number {
  let h = 2166136261 ^ seed;
  for (const ch of family) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0 || 1;
}

// ─── Constants mirrored from the unit under test ────────────────────────────

/** bootstrap.ts: `setTimeout(() => controller.abort(), 15_000)`. */
export const BOOTSTRAP_TIMEOUT_MS = 15_000;
export const API_BASE = 'https://api.pickle.example';

const ENVIRONMENT = {
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  device: {
    platform: 'ios' as const,
    osVersion: '18.5',
    appVersion: '1.0',
    model: 'iOS phone',
  },
};

const ACCOUNT_POOL = [
  '7fc2c743-028f-4ec6-942c-a84508f3be38',
  '0f1d2c3b-4a59-4687-9a2b-1c3d4e5f6a7b',
  '9b8a7c6d-5e4f-4321-8765-4321fedcba98',
  'c0ffee00-1234-4abc-9def-0123456789ab',
  '5d6e7f80-9a0b-4c1d-8e2f-3a4b5c6d7e8f',
  'e1f2a3b4-c5d6-4e7f-a8b9-c0d1e2f3a4b5',
];

// ─── Server model ───────────────────────────────────────────────────────────

type ExpiresAtShape =
  | 'normal'
  | 'past'
  | 'far-future'
  | 'zero'
  | 'negative'
  | 'fractional'
  | 'huge-finite'
  | 'nan'
  | 'infinity'
  | 'string'
  | 'missing';

interface MintedToken {
  accountId: string;
  seq: number;
}

/** Owner recoverable from the token text — minted access tokens are
 * `acc:<accountId>:tok<seq>`, provider ID tokens `idtok:<accountId>:<n>`. */
export function ownerOfToken(token: string): string | null {
  const m = /^(?:acc|idtok):([0-9a-f-]{36}):/i.exec(token);
  return m?.[1] ?? null;
}

class ServerModel {
  private spent = new Set<string>();
  private seq = 0;
  readonly minted = new Map<string, MintedToken>();
  readonly accountOfProviderToken = new Map<string, string>();
  spentOnArrival = 0;
  reuseRejections = 0;

  registerProviderToken(token: string, accountId: string): void {
    this.accountOfProviderToken.set(token, accountId);
  }

  mint(accountId: string): string {
    this.seq += 1;
    const token = `acc:${accountId}:tok${this.seq}`;
    this.minted.set(token, { accountId, seq: this.seq });
    return token;
  }

  /** Decision at ARRIVAL: a provider token (and an Apple code) is one-use. */
  bootstrap(
    providerToken: string,
    appleCode: string | null,
    outcome: ResponsePlan,
  ): {
    status: number;
    body: unknown;
    jsonThrows: boolean;
    sessionToken: string | null;
  } {
    if (outcome.kind === 'server-error') {
      return {
        status: outcome.status,
        body: { error: { message: 'down' } },
        jsonThrows: false,
        sessionToken: null,
      };
    }
    if (outcome.kind === 'unreadable') {
      return { status: 200, body: null, jsonThrows: true, sessionToken: null };
    }
    const accountId = this.accountOfProviderToken.get(providerToken);
    if (!accountId) {
      return {
        status: 401,
        body: { error: { message: 'Unknown token' } },
        jsonThrows: false,
        sessionToken: null,
      };
    }
    const codeKey = appleCode ? `code:${appleCode}` : null;
    if (this.spent.has(providerToken) || (codeKey && this.spent.has(codeKey))) {
      this.reuseRejections += 1;
      return {
        status: 401,
        body: { error: { message: 'Token already used' } },
        jsonThrows: false,
        sessionToken: null,
      };
    }
    this.spent.add(providerToken);
    if (codeKey) this.spent.add(codeKey);
    this.spentOnArrival += 1;
    const accessToken = this.mint(accountId);
    const body: Record<string, unknown> = {
      user: { id: accountId, email: `${accountId.slice(0, 8)}@example.com` },
      onboardingState: 'complete',
    };
    if (outcome.kind === 'ok') {
      body['session'] = {
        accessToken,
        refreshToken: `refresh:${accessToken}`,
        expiresAt: expiresAtValue(outcome.expiresAt, outcome.nowSec),
      };
    }
    // 'legacy' → no session block: the app bears the provider token.
    return { status: 200, body, jsonThrows: false, sessionToken: accessToken };
  }
}

function expiresAtValue(shape: ExpiresAtShape, nowSec: number): unknown {
  switch (shape) {
    case 'normal':
      return nowSec + 3600;
    case 'past':
      return nowSec - 3600;
    case 'far-future':
      return nowSec + 10 * 365 * 24 * 3600;
    case 'zero':
      return 0;
    case 'negative':
      return -1;
    case 'fractional':
      return nowSec + 0.5;
    case 'huge-finite':
      return 1e306; // finite, but ×1000 overflows to Infinity
    case 'nan':
      return Number.NaN;
    case 'infinity':
      return Number.POSITIVE_INFINITY;
    case 'string':
      return String(nowSec + 3600);
    case 'missing':
      return undefined;
  }
}

/** What the client must derive from a given expiresAt shape (bootstrap.ts
 * parseSessionTokens: number && finite → ms; anything else → legacy fallback). */
function expectedExpiryMs(
  shape: ExpiresAtShape,
  nowSec: number,
): number | 'legacy' {
  const v = expiresAtValue(shape, nowSec);
  if (typeof v === 'number' && Number.isFinite(v)) return v * 1000;
  return 'legacy';
}

// ─── Network plan ───────────────────────────────────────────────────────────

type ResponsePlan =
  | { kind: 'ok'; expiresAt: ExpiresAtShape; nowSec: number }
  | { kind: 'legacy' }
  | { kind: 'server-error'; status: number }
  | { kind: 'unreadable' };

interface RequestPlan {
  /** Virtual ms until the request reaches the server (token spent here). */
  arrivalMs: number;
  /** Virtual ms after arrival until the response reaches the client. */
  returnMs: number;
  /** Transport failure (rejects) at this virtual time instead of a response. */
  networkErrorAtMs: number | null;
  response: ResponsePlan;
}

interface FetchLogEntry {
  index: number;
  authorization: string | null;
  appleCode: string | null;
  arrivedAtServer: boolean;
  aborted: boolean;
  delivered: boolean;
  sessionToken: string | null;
  status: number | null;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function makeFetch(
  server: ServerModel,
  plans: RequestPlan[],
  log: FetchLogEntry[],
) {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const index = log.length;
    const plan = plans[index];
    if (!plan) throw new Error(`no plan for request #${index}`);
    if (input !== `${API_BASE}/v1/account/bootstrap`) {
      throw new Error(`unexpected url ${input}`);
    }
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? null;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const appleCode =
      typeof body['appleAuthorizationCode'] === 'string'
        ? body['appleAuthorizationCode']
        : null;
    const entry: FetchLogEntry = {
      index,
      authorization,
      appleCode,
      arrivedAtServer: false,
      aborted: false,
      delivered: false,
      sessionToken: null,
      status: null,
    };
    log.push(entry);
    const signal = init?.signal ?? null;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const timers: Array<ReturnType<typeof setTimeout>> = [];
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        for (const t of timers) clearTimeout(t);
        fn();
      };
      if (plan.networkErrorAtMs !== null) {
        timers.push(
          setTimeout(
            () => finish(() => reject(new TypeError('Network request failed'))),
            plan.networkErrorAtMs,
          ),
        );
      } else {
        let decided: ReturnType<ServerModel['bootstrap']> | null = null;
        timers.push(
          setTimeout(() => {
            if (settled) return;
            entry.arrivedAtServer = true;
            const providerToken = authorization?.replace(/^Bearer /, '') ?? '';
            decided = server.bootstrap(providerToken, appleCode, plan.response);
            entry.sessionToken = decided.sessionToken;
            timers.push(
              setTimeout(() => {
                const d = decided!;
                finish(() => {
                  entry.delivered = true;
                  entry.status = d.status;
                  resolve({
                    ok: d.status >= 200 && d.status < 300,
                    status: d.status,
                    json: d.jsonThrows
                      ? () =>
                          Promise.reject(new SyntaxError('Unexpected token <'))
                      : () => Promise.resolve(d.body),
                  } as unknown as Response);
                });
              }, plan.returnMs),
            );
          }, plan.arrivalMs),
        );
      }
      if (signal) {
        if (signal.aborted) {
          finish(() => {
            entry.aborted = true;
            reject(abortError());
          });
          return;
        }
        signal.addEventListener('abort', () =>
          finish(() => {
            entry.aborted = true;
            reject(abortError());
          }),
        );
      }
    });
  };
}

// ─── Results ────────────────────────────────────────────────────────────────

export interface Failure {
  invariant: string;
  detail: string;
}

export interface IterationResult {
  family: Family;
  seed: number;
  rngSeed: number;
  ok: boolean;
  failures: Failure[];
  wallMs: number;
  plan: string;
  stats: Record<string, number>;
}

export interface Clock {
  /** Advance jest fake timers by `ms`, flushing microtasks between timers. */
  advance(ms: number): Promise<void>;
  /** Pending fake timers. */
  timerCount(): number;
  /** Real wall clock (not faked). */
  realNow(): number;
}

interface Ctx {
  rng: Rng;
  failures: Failure[];
  stats: Record<string, number>;
  bump(key: string, by?: number): void;
  fail(invariant: string, detail: string): void;
}

function makeCtx(rng: Rng): Ctx {
  const failures: Failure[] = [];
  const stats: Record<string, number> = {};
  return {
    rng,
    failures,
    stats,
    bump(key, by = 1) {
      stats[key] = (stats[key] ?? 0) + by;
    },
    fail(invariant, detail) {
      failures.push({ invariant, detail });
    },
  };
}

type Settled =
  | { state: 'pending' }
  | { state: 'fulfilled'; value: AccountBootstrapResult }
  | { state: 'rejected'; error: unknown };

function track(promise: Promise<AccountBootstrapResult>): {
  readonly settled: Settled;
} {
  const box: { settled: Settled } = { settled: { state: 'pending' } };
  promise.then(
    value => {
      box.settled = { state: 'fulfilled', value };
    },
    error => {
      box.settled = { state: 'rejected', error };
    },
  );
  return box;
}

function describeError(error: unknown): string {
  if (error instanceof AccountBootstrapError) {
    return `${error.code}(retryable=${error.retryable})`;
  }
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

function pickResponsePlan(
  rng: Rng,
  nowSec: number,
  skewHeavy: boolean,
): ResponsePlan {
  const roll = rng.next();
  if (!skewHeavy) {
    if (roll < 0.78) return { kind: 'ok', expiresAt: 'normal', nowSec };
    if (roll < 0.88) return { kind: 'legacy' };
    if (roll < 0.94)
      return {
        kind: 'server-error',
        status: rng.pick([500, 502, 503, 429, 409, 400]),
      };
    return { kind: 'unreadable' };
  }
  const shapes: ExpiresAtShape[] = [
    'normal',
    'past',
    'far-future',
    'zero',
    'negative',
    'fractional',
    'huge-finite',
    'nan',
    'infinity',
    'string',
    'missing',
  ];
  return { kind: 'ok', expiresAt: rng.pick(shapes), nowSec };
}

function pickDelay(rng: Rng, mode: 'fast' | 'mixed' | 'boundary'): number {
  if (mode === 'fast') return rng.int(0, 2_000);
  if (mode === 'boundary') {
    return rng.pick([
      BOOTSTRAP_TIMEOUT_MS - 2,
      BOOTSTRAP_TIMEOUT_MS - 1,
      BOOTSTRAP_TIMEOUT_MS,
      BOOTSTRAP_TIMEOUT_MS + 1,
      BOOTSTRAP_TIMEOUT_MS + 2,
      rng.int(0, 30_000),
    ]);
  }
  const roll = rng.next();
  if (roll < 0.6) return rng.int(0, 5_000);
  if (roll < 0.8) return rng.int(5_000, BOOTSTRAP_TIMEOUT_MS + 500);
  return rng.int(BOOTSTRAP_TIMEOUT_MS - 50, 40_000);
}

function makeRequestPlan(
  rng: Rng,
  delayMode: 'fast' | 'mixed' | 'boundary',
  nowSec: number,
  skewHeavy: boolean,
): RequestPlan {
  const total = pickDelay(rng, delayMode);
  // Both legs stay ≥ 1 ms: fake timers coerce a 0 ms delay scheduled from
  // inside a timer callback to 1 ms, which would shift the total by one at
  // the exact 15 s boundary.
  const arrivalMs =
    total >= 2
      ? Math.min(total - 1, Math.max(1, Math.floor(total * rng.next())))
      : total;
  const plan: RequestPlan = {
    arrivalMs,
    returnMs: total - arrivalMs,
    networkErrorAtMs: null,
    response: pickResponsePlan(rng, nowSec, skewHeavy),
  };
  if (!skewHeavy && rng.chance(0.06)) {
    plan.networkErrorAtMs = pickDelay(rng, delayMode);
  }
  return plan;
}

/** Oracle for one bootstrap call given the fetch log and its plan. */
function checkBootstrapOutcome(
  ctx: Ctx,
  label: string,
  providerToken: string,
  provider: AccountProvider,
  plan: RequestPlan,
  entry: FetchLogEntry | undefined,
  settled: Settled,
  server: ServerModel,
): void {
  if (!entry) {
    ctx.fail('fetch-called-once', `${label}: bootstrap never called fetch`);
    return;
  }
  if (settled.state === 'pending') {
    ctx.fail(
      'bounded-completion',
      `${label}: bootstrap promise still pending after horizon (deadlock)`,
    );
    return;
  }
  const totalMs = plan.networkErrorAtMs ?? plan.arrivalMs + plan.returnMs;
  const expectAbort = totalMs >= BOOTSTRAP_TIMEOUT_MS;
  if (expectAbort) {
    ctx.bump('expectedAborts');
    if (!entry.aborted) {
      ctx.fail(
        'timeout-aborts-request',
        `${label}: total delay ${totalMs}ms ≥ ${BOOTSTRAP_TIMEOUT_MS} but fetch was not aborted`,
      );
    }
    if (settled.state !== 'rejected') {
      ctx.fail(
        'timeout-rejects',
        `${label}: delay ${totalMs}ms should reject account.unavailable, got fulfilled`,
      );
      return;
    }
    const error = settled.error;
    if (
      !(error instanceof AccountBootstrapError) ||
      error.code !== 'account.unavailable' ||
      !error.retryable
    ) {
      ctx.fail(
        'timeout-rejects',
        `${label}: expected account.unavailable(retryable) after abort, got ${describeError(error)}`,
      );
    }
    return;
  }
  if (entry.aborted) {
    ctx.fail(
      'no-spurious-abort',
      `${label}: delay ${totalMs}ms < ${BOOTSTRAP_TIMEOUT_MS} but the request was aborted`,
    );
  }
  if (plan.networkErrorAtMs !== null) {
    ctx.bump('networkErrors');
    if (
      settled.state !== 'rejected' ||
      !(settled.error instanceof AccountBootstrapError) ||
      settled.error.code !== 'account.unavailable' ||
      !settled.error.retryable
    ) {
      ctx.fail(
        'network-error-classified',
        `${label}: transport failure must be account.unavailable(retryable); got ${settled.state === 'rejected' ? describeError(settled.error) : 'fulfilled'}`,
      );
    }
    return;
  }
  if (!entry.delivered) {
    ctx.fail(
      'delivered',
      `${label}: response was never delivered though delay ${totalMs}ms < timeout`,
    );
    return;
  }
  const status = entry.status ?? 0;
  if (plan.response.kind === 'unreadable') {
    ctx.bump('unreadable');
    if (
      settled.state !== 'rejected' ||
      !(settled.error instanceof AccountBootstrapError) ||
      settled.error.code !== 'account.invalid_response'
    ) {
      ctx.fail(
        'unreadable-classified',
        `${label}: unreadable body must be account.invalid_response; got ${settled.state === 'rejected' ? describeError(settled.error) : 'fulfilled'}`,
      );
    }
    return;
  }
  if (status === 401 || status === 403) {
    ctx.bump('rejected401');
    if (
      settled.state !== 'rejected' ||
      !(settled.error instanceof AccountBootstrapError) ||
      settled.error.code !== 'account.rejected' ||
      settled.error.retryable
    ) {
      ctx.fail(
        'reuse-rejected-non-retryable',
        `${label}: 401 (spent/unknown token) must be account.rejected(non-retryable); got ${settled.state === 'rejected' ? describeError(settled.error) : 'fulfilled'}`,
      );
    }
    return;
  }
  if (status >= 400) {
    ctx.bump('serverErrors');
    const retryable = status >= 500 || status === 429;
    if (
      settled.state !== 'rejected' ||
      !(settled.error instanceof AccountBootstrapError) ||
      settled.error.code !== 'account.unavailable' ||
      settled.error.retryable !== retryable
    ) {
      ctx.fail(
        'server-error-classified',
        `${label}: ${status} must be account.unavailable(retryable=${retryable}); got ${settled.state === 'rejected' ? describeError(settled.error) : 'fulfilled'}`,
      );
    }
    return;
  }
  // 200 with a canonical account.
  if (settled.state !== 'fulfilled') {
    ctx.fail(
      'success-fulfils',
      `${label}: 200 response but bootstrap rejected ${describeError(settled.error)}`,
    );
    return;
  }
  ctx.bump('fulfilled');
  const minted = entry.sessionToken;
  const expectedAccount = server.accountOfProviderToken.get(providerToken);
  const { account, apiSession } = settled.value;
  if (account.id !== expectedAccount) {
    ctx.fail(
      'account-identity',
      `${label}: account ${account.id} ≠ owner ${expectedAccount} of the provider token`,
    );
  }
  if (
    apiSession.canonicalAppUserId !== account.id ||
    apiSession.provider !== provider ||
    apiSession.apiBaseUrl !== API_BASE
  ) {
    ctx.fail(
      'session-shape',
      `${label}: apiSession ${JSON.stringify(apiSession)} inconsistent with account ${account.id}/${provider}`,
    );
  }
  if (plan.response.kind === 'legacy') {
    ctx.bump('legacyFallback');
    if (
      apiSession.bearerToken !== providerToken ||
      apiSession.refreshToken !== null ||
      apiSession.bearerExpiresAtMs !== null
    ) {
      ctx.fail(
        'legacy-fallback',
        `${label}: server sent no session; app must bear the provider token with null refresh/expiry, got ${JSON.stringify(apiSession)}`,
      );
    }
    return;
  }
  if (plan.response.kind !== 'ok') return;
  const expectedExpiry = expectedExpiryMs(
    plan.response.expiresAt,
    plan.response.nowSec,
  );
  if (expectedExpiry === 'legacy') {
    ctx.bump('malformedExpiryFallback');
    if (
      apiSession.bearerToken !== providerToken ||
      apiSession.refreshToken !== null ||
      apiSession.bearerExpiresAtMs !== null
    ) {
      ctx.fail(
        'malformed-session-fallback',
        `${label}: expiresAt shape ${plan.response.expiresAt} must drop the session block (bear provider token); got ${JSON.stringify(apiSession)}`,
      );
    }
    return;
  }
  if (apiSession.bearerToken !== minted) {
    ctx.fail(
      'no-cross-talk',
      `${label}: bearer ${apiSession.bearerToken} ≠ token ${minted} minted for THIS response`,
    );
  }
  if (ownerOfToken(apiSession.bearerToken) !== account.id) {
    ctx.fail(
      'bearer-owner',
      `${label}: bearer ${apiSession.bearerToken} was minted for another account than ${account.id}`,
    );
  }
  if (apiSession.refreshToken !== `refresh:${minted}`) {
    ctx.fail(
      'refresh-pairing',
      `${label}: refresh ${apiSession.refreshToken} does not pair with access ${minted}`,
    );
  }
  if (apiSession.bearerExpiresAtMs !== expectedExpiry) {
    ctx.fail(
      'expiry-ms',
      `${label}: expiresAt shape ${plan.response.expiresAt} → bearerExpiresAtMs ${apiSession.bearerExpiresAtMs}, expected ${expectedExpiry}`,
    );
  }
  if (
    apiSession.bearerExpiresAtMs !== null &&
    apiSession.bearerExpiresAtMs !== undefined &&
    !Number.isFinite(apiSession.bearerExpiresAtMs)
  ) {
    ctx.bump('nonFiniteExpiryMs');
    ctx.fail(
      'expiry-finite',
      `${label}: server expiresAt=${String(expiresAtValue(plan.response.expiresAt, plan.response.nowSec))} passed the finiteness check but bearerExpiresAtMs=${apiSession.bearerExpiresAtMs} is not finite`,
    );
  }
}

// ─── Shadow model of the ApiSession store ───────────────────────────────────

class StoreShadow {
  session: ApiSession | null = null;
  readonly applied: Array<ApiSession | null> = [];
  establish(session: ApiSession): void {
    this.session = session;
    this.applied.push(session);
    establishApiSession(session);
  }
  clear(): void {
    this.session = null;
    this.applied.push(null);
    clearApiSession();
  }
  expectedBearerFor(owner: string): string | null {
    return this.session && this.session.canonicalAppUserId === owner
      ? this.session.bearerToken
      : null;
  }
}

function checkStoreAgainstShadow(
  ctx: Ctx,
  label: string,
  shadow: StoreShadow,
): void {
  const actual = getApiSession();
  if (actual !== shadow.session) {
    ctx.fail(
      'store-last-writer-wins',
      `${label}: store holds ${JSON.stringify(actual)} but the last applied op was ${JSON.stringify(shadow.session)}`,
    );
  }
  for (const owner of ACCOUNT_POOL) {
    const got = bearerTokenFor(owner);
    const want = shadow.expectedBearerFor(owner);
    if (got !== want) {
      ctx.fail(
        'bearer-bound-to-owner',
        `${label}: bearerTokenFor(${owner}) = ${got}, expected ${want}`,
      );
    }
    if (got !== null && ownerOfToken(got) !== owner) {
      ctx.fail(
        'bearer-owner',
        `${label}: bearerTokenFor(${owner}) yielded ${got}, minted for ${ownerOfToken(got)}`,
      );
    }
  }
}

function sessionFor(
  server: ServerModel,
  owner: string,
  provider: AccountProvider,
): ApiSession {
  const token = server.mint(owner);
  return {
    apiBaseUrl: API_BASE,
    bearerToken: token,
    canonicalAppUserId: owner,
    provider,
    refreshToken: `refresh:${token}`,
    bearerExpiresAtMs: Date.now() + 3600_000,
  };
}

// ─── Families ───────────────────────────────────────────────────────────────

interface Actor {
  label: string;
  providerToken: string;
  provider: AccountProvider;
  appleCode: string | null;
  accountId: string;
}

async function settleAll(
  ctx: Ctx,
  clock: Clock,
  horizonMs: number,
): Promise<void> {
  // Advance in a few steps so timers scheduled by timers still fire before
  // the horizon closes.
  const step = Math.max(1, Math.ceil(horizonMs / 4));
  for (let t = 0; t < horizonMs; t += step) {
    await clock.advance(Math.min(step, horizonMs - t));
  }
  await clock.advance(1);
  const leaked = clock.timerCount();
  if (leaked !== 0) {
    ctx.fail(
      'no-timer-leak',
      `${leaked} fake timer(s) still pending after every call settled`,
    );
  }
}

/** A: duplicate concurrent bootstraps with the SAME one-use provider token
 * (double-tap sign-in, retry-while-pending). Exactly one may succeed. */
async function runDuplicateBootstrap(ctx: Ctx, clock: Clock): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const k = rng.int(2, 8);
  const provider: AccountProvider = rng.chance(0.5) ? 'apple' : 'google';
  const accountId = rng.pick(ACCOUNT_POOL);
  const providerToken = `idtok:${accountId}:${rng.int(1, 1e9)}`;
  const appleCode =
    provider === 'apple' && rng.chance(0.7) ? `code-${rng.int(1, 1e9)}` : null;
  server.registerProviderToken(providerToken, accountId);
  const nowSec = Math.floor(Date.now() / 1000);
  const plans = Array.from({ length: k }, () =>
    makeRequestPlan(rng, 'mixed', nowSec, false),
  );
  const log: FetchLogEntry[] = [];
  const fetchFn = makeFetch(server, plans, log);
  const shadow = new StoreShadow();
  const boxes = Array.from({ length: k }, () =>
    track(
      bootstrapCanonicalAccount({
        apiBaseUrl: `${API_BASE}/`,
        bearerToken: providerToken,
        provider,
        appleAuthorizationCode: appleCode,
        environment: ENVIRONMENT,
        fetchFn,
      }).then(result => {
        // authStore.installApiSession happens right after fulfilment.
        shadow.establish(result.apiSession);
        return result;
      }),
    ),
  );
  ctx.bump('bootstraps', k);
  await settleAll(ctx, clock, 45_000);
  if (log.length !== k)
    ctx.fail(
      'fetch-called-once',
      `${k} bootstraps but ${log.length} fetch calls`,
    );
  boxes.forEach((box, i) =>
    checkBootstrapOutcome(
      ctx,
      `call#${i}`,
      providerToken,
      provider,
      plans[i]!,
      log[i],
      box.settled,
      server,
    ),
  );
  const fulfilled = boxes.filter(b => b.settled.state === 'fulfilled').length;
  if (fulfilled > 1)
    ctx.fail(
      'one-use-token',
      `${fulfilled} of ${k} duplicate bootstraps fulfilled; the provider token is one-use`,
    );
  if (server.spentOnArrival > 1)
    ctx.fail(
      'one-use-token',
      `server model spent the token ${server.spentOnArrival} times`,
    );
  ctx.bump('serverReuseRejections', server.reuseRejections);
  // The store must hold the fulfilled session (if any) and nothing else.
  checkStoreAgainstShadow(ctx, 'final', shadow);
  const live = getApiSession();
  if (live && live.canonicalAppUserId !== accountId) {
    ctx.fail(
      'account-identity',
      `store ended bound to ${live.canonicalAppUserId}, expected ${accountId}`,
    );
  }
  if (
    live &&
    live.bearerToken !== providerToken &&
    !server.minted.has(live.bearerToken)
  ) {
    ctx.fail(
      'bearer-minted',
      `store bears ${live.bearerToken} which the server never minted`,
    );
  }
  return `k=${k} provider=${provider} appleCode=${appleCode !== null} delays=${plans
    .map(p =>
      p.networkErrorAtMs !== null
        ? `err@${p.networkErrorAtMs}`
        : `${p.arrivalMs}+${p.returnMs}:${p.response.kind}`,
    )
    .join(',')}`;
}

/** B: several actors (distinct tokens, overlapping accounts) bootstrap at
 * once, each installing its session on fulfilment while long-lived clients
 * resolve bearers, rotations land and logouts interleave. */
async function runMultiActorEstablish(ctx: Ctx, clock: Clock): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const m = rng.int(2, 6);
  const nowSec = Math.floor(Date.now() / 1000);
  const actors: Actor[] = Array.from({ length: m }, (_, i) => {
    const provider: AccountProvider = rng.chance(0.5) ? 'apple' : 'google';
    const accountId = rng.pick(ACCOUNT_POOL.slice(0, rng.int(1, 3)));
    const providerToken = `idtok:${accountId}:${i}-${rng.int(1, 1e9)}`;
    server.registerProviderToken(providerToken, accountId);
    return {
      label: `actor#${i}`,
      providerToken,
      provider,
      appleCode: null,
      accountId,
    };
  });
  const plans = actors.map(() => makeRequestPlan(rng, 'mixed', nowSec, false));
  const log: FetchLogEntry[] = [];
  const fetchFn = makeFetch(server, plans, log);
  const shadow = new StoreShadow();
  const seen: Array<ApiSession | null> = [];
  const unsubscribe = subscribeToApiSession(s => seen.push(s));

  const boxes = actors.map(actor =>
    track(
      bootstrapCanonicalAccount({
        apiBaseUrl: API_BASE,
        bearerToken: actor.providerToken,
        provider: actor.provider,
        environment: ENVIRONMENT,
        fetchFn: (url, init) => fetchFn(url, init),
      }).then(result => {
        shadow.establish(result.apiSession);
        checkStoreAgainstShadow(ctx, `${actor.label}-installed`, shadow);
        return result;
      }),
    ),
  );
  ctx.bump('bootstraps', m);

  // Interleaved store traffic on virtual time.
  const ops = rng.int(5, 40);
  const opTimes: number[] = [];
  for (let n = 0; n < ops; n++) {
    const at = rng.int(0, 20_000);
    opTimes.push(at);
    const owner = rng.pick(ACCOUNT_POOL.slice(0, 4));
    const roll = rng.next();
    setTimeout(() => {
      if (roll < 0.45) {
        // client request: resolve bearer per request
        const expected = shadow.expectedBearerFor(owner);
        const got = bearerTokenFor(owner);
        ctx.bump('bearerReads');
        if (got !== expected)
          ctx.fail(
            'bearer-bound-to-owner',
            `t=${at} bearerTokenFor(${owner})=${got}, expected ${expected}`,
          );
        if (got !== null && ownerOfToken(got) !== owner) {
          ctx.fail(
            'bearer-owner',
            `t=${at} bearerTokenFor(${owner}) yielded foreign token ${got}`,
          );
        }
        if (got === null) ctx.bump('nullBearers');
      } else if (roll < 0.7) {
        // rotation for the current owner (or a fresh sign-in for `owner`)
        const current = shadow.session;
        const target =
          current && rng.chance(0.7) ? current.canonicalAppUserId : owner;
        shadow.establish(
          sessionFor(server, target, rng.chance(0.5) ? 'apple' : 'google'),
        );
        ctx.bump('establishes');
        checkStoreAgainstShadow(ctx, `t=${at}-rotate`, shadow);
      } else if (roll < 0.85) {
        shadow.clear();
        ctx.bump('clears');
        checkStoreAgainstShadow(ctx, `t=${at}-clear`, shadow);
      } else {
        // duplicate establish of the very same object (idempotent re-install)
        if (shadow.session) {
          shadow.establish(shadow.session);
          ctx.bump('reEstablishes');
          checkStoreAgainstShadow(ctx, `t=${at}-reinstall`, shadow);
        }
      }
    }, at);
  }

  await settleAll(ctx, clock, 45_000);
  unsubscribe();
  boxes.forEach((box, idx) =>
    checkBootstrapOutcome(
      ctx,
      actors[idx]!.label,
      actors[idx]!.providerToken,
      actors[idx]!.provider,
      plans[idx]!,
      log[idx],
      box.settled,
      server,
    ),
  );
  checkStoreAgainstShadow(ctx, 'final', shadow);
  // No lost update: subscribers saw exactly the applied sequence, in order.
  if (
    seen.length !== shadow.applied.length ||
    seen.some((s, idx) => s !== shadow.applied[idx])
  ) {
    ctx.fail(
      'no-lost-update',
      `subscriber saw ${seen.length} transitions, ${shadow.applied.length} were applied (order/identity mismatch at ${seen.findIndex((s, idx) => s !== shadow.applied[idx])})`,
    );
  }
  ctx.bump('subscriberEvents', seen.length);
  return `m=${m} accounts=${actors.map(a => a.accountId.slice(0, 8)).join('/')} ops=${ops} delays=${plans
    .map(p =>
      p.networkErrorAtMs !== null
        ? `err@${p.networkErrorAtMs}`
        : `${p.arrivalMs}+${p.returnMs}:${p.response.kind}`,
    )
    .join(',')}`;
}

/** C: requests capture the bearer at send time; rotations, logouts and
 * account switches land while they are in flight; late 401s must only tear
 * down the session whose bearer is STILL current. */
async function runRotationDuringRequest(
  ctx: Ctx,
  clock: Clock,
): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const shadow = new StoreShadow();
  const listenerCalls: ApiSession[] = [];
  setApiUnauthorizedListener(s => listenerCalls.push(s));
  const owners = ACCOUNT_POOL.slice(0, rng.int(1, 3));
  shadow.establish(sessionFor(server, owners[0]!, 'apple'));

  const requests = rng.int(5, 60);
  const mutations = rng.int(2, 30);
  const horizon = 20_000;
  const inflight: Array<{
    sentAt: number;
    owner: string;
    token: string | null;
    deliverAt: number;
    status: number;
  }> = [];
  let expectedFires = 0;

  for (let n = 0; n < requests; n++) {
    const sentAt = rng.int(0, horizon - 1);
    const owner = rng.pick(owners);
    const latency = rng.int(0, 6_000);
    const status = rng.chance(0.5) ? 401 : 200;
    setTimeout(() => {
      // api.ts request(): `const token = config.token` once per request.
      const token = bearerTokenFor(owner);
      const expected = shadow.expectedBearerFor(owner);
      ctx.bump('requests');
      if (token !== expected)
        ctx.fail(
          'bearer-bound-to-owner',
          `t=${sentAt} bearerTokenFor(${owner})=${token} expected ${expected}`,
        );
      if (token !== null && ownerOfToken(token) !== owner)
        ctx.fail(
          'bearer-owner',
          `t=${sentAt} request for ${owner} would send ${token}`,
        );
      if (token === null) ctx.bump('requestsWithoutBearer');
      const rec = { sentAt, owner, token, deliverAt: sentAt + latency, status };
      inflight.push(rec);
      setTimeout(() => {
        if (rec.status !== 401 || rec.token === null) return;
        ctx.bump('unauthorizedResponses');
        const current = shadow.session;
        const shouldFire =
          current !== null && current.bearerToken === rec.token;
        const before = listenerCalls.length;
        reportApiUnauthorized(rec.token);
        const fired = listenerCalls.length - before;
        if (shouldFire) {
          expectedFires += 1;
          if (fired !== 1)
            ctx.fail(
              'current-bearer-401-fires',
              `t=${rec.deliverAt} 401 for the CURRENT bearer fired the listener ${fired}× (expected 1)`,
            );
          const arg = listenerCalls[listenerCalls.length - 1];
          if (
            fired === 1 &&
            (arg !== current ||
              arg.bearerToken !== rec.token ||
              arg.canonicalAppUserId !== rec.owner)
          ) {
            ctx.fail(
              'listener-receives-rejected-session',
              `t=${rec.deliverAt} listener got ${JSON.stringify(arg)} for token ${rec.token}`,
            );
          }
        } else {
          ctx.bump('stale401Ignored');
          if (fired !== 0)
            ctx.fail(
              'stale-401-ignored',
              `t=${rec.deliverAt} 401 for replaced/cleared bearer ${rec.token} fired the listener (current=${current?.bearerToken ?? 'none'})`,
            );
        }
      }, latency);
    }, sentAt);
  }

  for (let n = 0; n < mutations; n++) {
    const at = rng.int(0, horizon);
    const roll = rng.next();
    setTimeout(() => {
      if (roll < 0.55) {
        const current = shadow.session;
        const target = current ? current.canonicalAppUserId : rng.pick(owners);
        shadow.establish(
          sessionFor(server, target, current?.provider ?? 'google'),
        );
        ctx.bump('rotations');
      } else if (roll < 0.8) {
        shadow.clear();
        ctx.bump('logouts');
      } else {
        shadow.establish(
          sessionFor(
            server,
            rng.pick(owners),
            rng.chance(0.5) ? 'apple' : 'google',
          ),
        );
        ctx.bump('accountSwitches');
      }
      checkStoreAgainstShadow(ctx, `t=${at}-mutation`, shadow);
    }, at);
  }

  await settleAll(ctx, clock, horizon + 7_000);
  setApiUnauthorizedListener(null);
  if (listenerCalls.length !== expectedFires) {
    ctx.fail(
      'listener-fire-count',
      `listener fired ${listenerCalls.length}×, oracle expected ${expectedFires}`,
    );
  }
  ctx.bump('listenerFires', listenerCalls.length);
  for (const call of listenerCalls) {
    if (ownerOfToken(call.bearerToken) !== call.canonicalAppUserId) {
      ctx.fail(
        'listener-owner',
        `listener received session whose bearer ${call.bearerToken} belongs to another account than ${call.canonicalAppUserId}`,
      );
    }
  }
  checkStoreAgainstShadow(ctx, 'final', shadow);
  return `owners=${owners.length} requests=${requests} mutations=${mutations}`;
}

/** D: bootstraps whose total latency straddles the 15 s client timeout by
 * ±2 ms, plus transport errors at the boundary. */
async function runTimeoutBoundary(ctx: Ctx, clock: Clock): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const k = rng.int(1, 6);
  const nowSec = Math.floor(Date.now() / 1000);
  const actors: Actor[] = Array.from({ length: k }, (_, i) => {
    const accountId = rng.pick(ACCOUNT_POOL);
    const providerToken = `idtok:${accountId}:${i}-${rng.int(1, 1e9)}`;
    server.registerProviderToken(providerToken, accountId);
    return {
      label: `call#${i}`,
      providerToken,
      provider: 'google',
      appleCode: null,
      accountId,
    };
  });
  const plans = actors.map(() => {
    const plan = makeRequestPlan(rng, 'boundary', nowSec, false);
    if (rng.chance(0.2)) plan.networkErrorAtMs = pickDelay(rng, 'boundary');
    return plan;
  });
  const log: FetchLogEntry[] = [];
  const fetchFn = makeFetch(server, plans, log);
  // Stagger starts so the abort timers of different calls are not aligned.
  const starts = actors.map(() => rng.int(0, 3_000));
  const boxes: Array<{ readonly settled: Settled } | null> = actors.map(
    () => null,
  );
  actors.forEach((actor, i) => {
    setTimeout(() => {
      boxes[i] = track(
        bootstrapCanonicalAccount({
          apiBaseUrl: API_BASE,
          bearerToken: actor.providerToken,
          provider: actor.provider,
          environment: ENVIRONMENT,
          fetchFn,
        }),
      );
    }, starts[i]);
  });
  ctx.bump('bootstraps', k);
  await settleAll(ctx, clock, 50_000);
  // fetch log order == start order only if starts are distinct; map by token.
  actors.forEach((actor, i) => {
    const entry = log.find(
      e => e.authorization === `Bearer ${actor.providerToken}`,
    );
    const plan = entry ? plans[entry.index] : undefined;
    const box = boxes[i];
    if (!entry || !plan || !box) {
      ctx.fail(
        'fetch-called-once',
        `${actor.label}: no fetch call / no result box`,
      );
      return;
    }
    checkBootstrapOutcome(
      ctx,
      actor.label,
      actor.providerToken,
      actor.provider,
      plan,
      entry,
      box.settled,
      server,
    );
  });
  return `k=${k} starts=${starts.join(',')} totals=${plans
    .map(p =>
      p.networkErrorAtMs !== null
        ? `err@${p.networkErrorAtMs}`
        : `${p.arrivalMs + p.returnMs}`,
    )
    .join(',')}`;
}

/** E: concurrent bootstraps whose `expiresAt` values are skewed or malformed;
 * the parsed expiry must be exact or the session block must be dropped. */
async function runClockSkew(ctx: Ctx, clock: Clock): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const k = rng.int(1, 5);
  const nowSec =
    Math.floor(Date.now() / 1000) +
    rng.pick([0, -86_400, 86_400, -3_600_000, 3_600_000]);
  const actors: Actor[] = Array.from({ length: k }, (_, i) => {
    const accountId = rng.pick(ACCOUNT_POOL.slice(0, 2));
    const providerToken = `idtok:${accountId}:${i}-${rng.int(1, 1e9)}`;
    server.registerProviderToken(providerToken, accountId);
    return {
      label: `call#${i}`,
      providerToken,
      provider: rng.chance(0.5) ? 'apple' : 'google',
      appleCode: null,
      accountId,
    };
  });
  const plans = actors.map(() => makeRequestPlan(rng, 'fast', nowSec, true));
  const log: FetchLogEntry[] = [];
  const fetchFn = makeFetch(server, plans, log);
  const shadow = new StoreShadow();
  const boxes = actors.map(actor =>
    track(
      bootstrapCanonicalAccount({
        apiBaseUrl: API_BASE,
        bearerToken: actor.providerToken,
        provider: actor.provider,
        environment: ENVIRONMENT,
        fetchFn,
      }).then(result => {
        shadow.establish(result.apiSession);
        return result;
      }),
    ),
  );
  ctx.bump('bootstraps', k);
  await settleAll(ctx, clock, 10_000);
  actors.forEach((actor, i) =>
    checkBootstrapOutcome(
      ctx,
      actor.label,
      actor.providerToken,
      actor.provider,
      plans[i]!,
      log[i],
      boxes[i]!.settled,
      server,
    ),
  );
  checkStoreAgainstShadow(ctx, 'final', shadow);
  return `k=${k} nowSec=${nowSec} shapes=${plans.map(p => (p.response.kind === 'ok' ? p.response.expiresAt : p.response.kind)).join(',')}`;
}

/** F: subscribers attach/detach while establish/clear bursts run; each must
 * see exactly the transitions inside its window; unsubscribe is idempotent. */
async function runSubscriberChurn(ctx: Ctx, clock: Clock): Promise<string> {
  const rng = ctx.rng;
  const server = new ServerModel();
  const shadow = new StoreShadow();
  const subs = rng.int(1, 12);
  const ops = rng.int(5, 80);
  const horizon = 5_000;
  interface Sub {
    from: number;
    to: number;
    seen: Array<ApiSession | null>;
    expected: Array<ApiSession | null>;
    active: boolean;
    unsubscribe: (() => void) | null;
  }
  const subscribers: Sub[] = Array.from({ length: subs }, () => {
    const from = rng.int(0, horizon);
    const to = Math.min(horizon, from + rng.int(0, horizon));
    return {
      from,
      to,
      seen: [],
      expected: [],
      active: false,
      unsubscribe: null,
    };
  });
  for (const sub of subscribers) {
    setTimeout(() => {
      sub.unsubscribe = subscribeToApiSession(s => sub.seen.push(s));
      sub.active = true;
    }, sub.from);
    setTimeout(() => {
      sub.active = false;
      sub.unsubscribe?.();
      sub.unsubscribe?.(); // idempotent
    }, sub.to);
  }
  for (let n = 0; n < ops; n++) {
    const at = rng.int(0, horizon);
    setTimeout(() => {
      if (rng.chance(0.6)) {
        shadow.establish(sessionFor(server, rng.pick(ACCOUNT_POOL), 'apple'));
        ctx.bump('establishes');
      } else {
        shadow.clear();
        ctx.bump('clears');
      }
      for (const sub of subscribers)
        if (sub.active) sub.expected.push(shadow.session);
      checkStoreAgainstShadow(ctx, `t=${at}`, shadow);
    }, at);
  }
  await settleAll(ctx, clock, horizon + 10);
  subscribers.forEach((sub, i) => {
    ctx.bump('subscriberEvents', sub.seen.length);
    if (
      sub.seen.length !== sub.expected.length ||
      sub.seen.some((s, idx) => s !== sub.expected[idx])
    ) {
      ctx.fail(
        'subscriber-window-exact',
        `sub#${i} [${sub.from},${sub.to}] saw ${sub.seen.length} transitions, expected ${sub.expected.length}`,
      );
    }
  });
  checkStoreAgainstShadow(ctx, 'final', shadow);
  return `subs=${subs} ops=${ops}`;
}

// ─── Runner ─────────────────────────────────────────────────────────────────

export async function runIteration(
  family: Family,
  seed: number,
  clock: Clock,
): Promise<IterationResult> {
  const rngSeed = familySeed(family, seed);
  const ctx = makeCtx(new Rng(rngSeed));
  clearApiSession();
  setApiUnauthorizedListener(null);
  const wallStart = clock.realNow();
  let plan = '';
  try {
    switch (family) {
      case 'duplicate-bootstrap':
        plan = await runDuplicateBootstrap(ctx, clock);
        break;
      case 'multi-actor-establish':
        plan = await runMultiActorEstablish(ctx, clock);
        break;
      case 'rotation-during-request':
        plan = await runRotationDuringRequest(ctx, clock);
        break;
      case 'timeout-boundary':
        plan = await runTimeoutBoundary(ctx, clock);
        break;
      case 'clock-skew':
        plan = await runClockSkew(ctx, clock);
        break;
      case 'subscriber-churn':
        plan = await runSubscriberChurn(ctx, clock);
        break;
    }
  } catch (error) {
    ctx.fail('harness-threw', describeError(error));
  } finally {
    clearApiSession();
    setApiUnauthorizedListener(null);
  }
  const wallMs = clock.realNow() - wallStart;
  if (wallMs > 5_000)
    ctx.fail('bounded-wall-time', `iteration took ${wallMs}ms of real time`);
  return {
    family,
    seed,
    rngSeed,
    ok: ctx.failures.length === 0,
    failures: ctx.failures,
    wallMs,
    plan,
    stats: ctx.stats,
  };
}
