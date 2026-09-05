/**
 * STRESS · failure-injection · unit `mod-bootstrap-api-session`
 * (`src/account/bootstrap.ts` + `src/account/apiSession.ts`).
 *
 * Every dependency the unit reaches — API base URL config, provider bearer /
 * Apple authorization code, `fetch` (throw, reject, abort, never-resolves,
 * slow, not-a-Response, resolves past the deadline), the body reader
 * (`json()` throws / rejects / stalls / slow), the response status + payload
 * shape, and the clock (jest fake timers) — is injected from a seeded plan.
 * The unit itself touches no SQLite, Keychain, camera, Vision, TTS,
 * RevenueCat, permission or navigation dependency; the `jest.mock` guards at
 * the top prove the first two are never loaded by it.
 *
 * Invariants asserted per iteration (the "recoverable state" contract for a
 * pure module: the UI's retry/back control is driven by the thrown error):
 *   - settles exactly when the oracle says (never earlier than the 15 s
 *     deadline, never later; no unbounded pending work: fake time advanced
 *     60 s+) or, for a dependency that ignores its abort signal, stays
 *     pending WITH the abort already signalled;
 *   - never a silent failure: rejection is an `AccountBootstrapError` with
 *     the oracle's code + retryability, a non-empty message that leaks no
 *     bearer / Apple code / server token;
 *   - never a fake success: resolves only for a valid canonical UUID account
 *     and bears exactly the server access token or (legacy server) the
 *     provider token, with the refresh token / expiry only from a complete
 *     server session;
 *   - the wire request is exactly the contract (URL, method, headers, body,
 *     Apple one-use code only for Apple, abort signal attached);
 *   - no timer left behind, the in-memory ApiSession store untouched, and no
 *     persistence module loaded.
 *
 * Replay:  STRESS_SEED=<seed> npx jest __tests__/stress/bootstrapApiSessionFailureInjection.stress.test.ts
 * Scale:   STRESS_ITER=<n> (default 40 per random family)
 * Table:   artifacts/stress/<STRESS_RUN_ID|local>/mod-bootstrap-api-session-failure-injection.json
 *          (the afterAll guard requires ≥ 60 injected rows, so a `-t` filter
 *          that skips the catalogue fails the suite by design)
 */
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
  normalizeApiBaseUrl,
  type AccountBootstrapResult,
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
import {
  BASE_URL_CASES,
  ENVIRONMENT,
  REALISTIC_FETCH_FAULTS,
  STATUS_POOL,
  STRESS_ITER,
  appleCodeCases,
  bearerCases,
  buildPayload,
  errorPayload,
  expectedOutcome,
  injectFetch,
  pick,
  randomBodyBehaviour,
  randomFetchBehaviour,
  randomInt,
  randomPayloadPlan,
  seededRandom,
  stressSeeds,
  writeStressTable,
  type BaseUrlCase,
  type BodyBehaviour,
  type BootstrapPlan,
  type ErrorPayloadKind,
  type ExpectedOutcome,
  type FetchBehaviour,
  type PayloadPlan,
  type StressRow,
  type Verdict,
} from '../../testing/stress/bootstrapFaultInjection';

// The unit must never load a persistence dependency. The factories flip a
// flag the moment anything requires them.
let mockKeychainLoaded = false;
let mockSqliteLoaded = false;
jest.mock('react-native-keychain', () => {
  mockKeychainLoaded = true;
  return {};
});
jest.mock('../../src/data/db', () => {
  mockSqliteLoaded = true;
  return {};
});

declare const process: { env: Record<string, string | undefined> };

const ROWS: StressRow[] = [];
const FAMILY_COUNTS: Record<string, number> = {};
// Captured before any fake-timer install so durations are wall-clock.
const wallClockNow = Date.now.bind(Date);

afterAll(() => {
  writeStressTable(
    'mod-bootstrap-api-session-failure-injection.json',
    {
      unit: 'mod-bootstrap-api-session',
      lens: 'failure-injection',
      paths: [
        'apps/mobile/src/account/bootstrap.ts',
        'apps/mobile/src/account/apiSession.ts',
      ],
      persistenceLoaded: {
        keychain: mockKeychainLoaded,
        sqlite: mockSqliteLoaded,
      },
      families: FAMILY_COUNTS,
    },
    ROWS,
  );
  const injected = ROWS.filter(r => !r.family.startsWith('defect.')).length;
  // The lens demands ≥ 60 injected faults; the catalogue alone exceeds it.
  if (injected < 60) {
    throw new Error(
      `only ${injected} injected-fault rows executed (need ≥ 60)`,
    );
  }
  if (process.env['STRESS_DEBUG']) {
    console.log(JSON.stringify({ rows: ROWS.length, families: FAMILY_COUNTS }));
  }
});

function record(row: StressRow): void {
  ROWS.push(row);
  FAMILY_COUNTS[row.family] = (FAMILY_COUNTS[row.family] ?? 0) + 1;
}

/** Runs `body`, records one row, and rethrows so jest fails on BROKEN. */
async function scenario(
  family: string,
  id: string,
  seed: number,
  inputs: Record<string, unknown>,
  expected: Record<string, unknown> | string,
  body: () => Promise<{ observed: Record<string, unknown>; verdict?: Verdict }>,
): Promise<void> {
  const started = wallClockNow();
  let observed: Record<string, unknown> = {};
  let verdict: Verdict = 'HELD';
  let error: string | null = null;
  try {
    const result = await body();
    observed = result.observed;
    verdict = result.verdict ?? 'HELD';
  } catch (caught) {
    verdict = 'BROKEN';
    error = caught instanceof Error ? caught.message : String(caught);
    throw caught;
  } finally {
    record({
      id,
      family,
      seed,
      inputs,
      expected,
      observed,
      verdict,
      error,
      durationMs: wallClockNow() - started,
    });
  }
}

// ─── Driving the unit under fake time ────────────────────────────────────────

type Settled =
  | { kind: 'resolved'; value: AccountBootstrapResult; atMs: number }
  | { kind: 'rejected'; error: unknown; atMs: number }
  | { kind: 'pending' };

interface Drive {
  settled: Settled;
  calls: ReturnType<typeof injectFetch>['calls'];
  aborted: boolean;
  timersLeft: number;
  storeTouched: boolean;
}

function planInputs(plan: BootstrapPlan): Record<string, unknown> {
  return {
    baseUrl: plan.baseUrl.id,
    baseUrlValue: plan.baseUrl.value ?? null,
    bearer: plan.bearer.id,
    apple: plan.apple.id,
    fetch: plan.fetch,
    status: plan.status,
    body: plan.body.kind,
    bodyMs: plan.body.kind === 'json-slow' ? plan.body.ms : null,
    errorKind: plan.errorKind,
    payload: plan.built?.payload ?? plan.body,
  };
}

async function drive(
  plan: BootstrapPlan,
  expected: ExpectedOutcome,
): Promise<Drive> {
  const fetch = injectFetch(plan.fetch, {
    status: plan.status,
    body: plan.body,
  });
  let storeTouched = false;
  const unsubscribe = subscribe(() => {
    storeTouched = true;
  });
  const state: { settled: Settled } = { settled: { kind: 'pending' } };
  let now = 0;
  const promise = bootstrapCanonicalAccount({
    apiBaseUrl: plan.baseUrl.value,
    bearerToken: plan.bearer.value,
    provider: plan.apple.provider,
    appleAuthorizationCode: plan.apple.value,
    environment: ENVIRONMENT,
    fetchFn: fetch.fn,
  }).then(
    value => {
      state.settled = { kind: 'resolved', value, atMs: now };
    },
    (error: unknown) => {
      state.settled = { kind: 'rejected', error, atMs: now };
    },
  );

  const advanceTo = async (target: number): Promise<void> => {
    // A 0 ms advance still fires due timers (setTimeout(fn, 0)) and settles
    // the promise chain (async fn → then handlers) without moving the clock.
    await jest.advanceTimersByTimeAsync(Math.max(0, target - now));
    now = Math.max(now, target);
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };
  const describeSettled = (): string => {
    const s = state.settled;
    return s.kind === 'pending' ? 'pending' : `${s.kind} at ${s.atMs}ms`;
  };

  if (expected.kind === 'pending') {
    // No infinite spinner is the CALLER's control; for the unit we prove
    // 60 s of fake time passes with the abort already signalled.
    await advanceTo(60_000);
  } else {
    if (expected.settledByMs > 0) {
      await advanceTo(expected.settledByMs - 1);
      if (state.settled.kind !== 'pending') {
        throw new Error(
          `${describeSettled()}, before the oracle deadline ${expected.settledByMs}ms`,
        );
      }
    }
    await advanceTo(expected.settledByMs);
    if (state.settled.kind === 'pending') {
      // Give the run a generous budget to prove it is a hang, not a race.
      await advanceTo(100_000);
      if (state.settled.kind === 'pending') {
        throw new Error(
          `still pending 100 s in; oracle expected ${expected.kind} by ${expected.settledByMs}ms`,
        );
      }
      throw new Error(
        `${describeSettled()}, later than the oracle deadline ${expected.settledByMs}ms`,
      );
    }
  }
  unsubscribe();
  void promise;
  return {
    settled: state.settled,
    calls: fetch.calls,
    aborted: fetch.aborted(),
    timersLeft: jest.getTimerCount(),
    storeTouched,
  };
}

function assertWire(plan: BootstrapPlan, calls: Drive['calls']): void {
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.url).toBe(`${plan.baseUrl.normalized}/v1/account/bootstrap`);
  expect(call.method).toBe('POST');
  expect(call.headers['Authorization']).toBe(`Bearer ${plan.bearer.sent}`);
  expect(call.headers['Accept']).toBe('application/json');
  expect(call.headers['Content-Type']).toBe('application/json');
  expect(call.headers['X-Client-Version']).toBe(ENVIRONMENT.device.appVersion);
  expect(call.signal).toBeInstanceOf(AbortSignal);
  const body = call.body as Record<string, unknown>;
  expect(body['locale']).toBe(ENVIRONMENT.locale);
  expect(body['timezone']).toBe(ENVIRONMENT.timezone);
  expect(body['device']).toEqual(ENVIRONMENT.device);
  if (plan.apple.sent) {
    expect(call.headers['X-Apple-Revocation-Protocol']).toBe('1');
    expect(body['appleAuthorizationCode']).toBe(plan.apple.sent);
  } else {
    expect(call.headers['X-Apple-Revocation-Protocol']).toBeUndefined();
    expect(body).not.toHaveProperty('appleAuthorizationCode');
  }
  // The provider bearer travels only in the Authorization header.
  expect(JSON.stringify(body)).not.toContain(plan.bearer.sent);
}

function secrets(plan: BootstrapPlan, seed: number): string[] {
  const out = [
    `provider-token-${seed}`,
    `apple-code-${seed}`,
    `access-${seed}`,
    `refresh-${seed}`,
  ];
  if (plan.bearer.sent) out.push(plan.bearer.sent);
  return out;
}

function assertOutcome(
  plan: BootstrapPlan,
  seed: number,
  expected: ExpectedOutcome,
  result: Drive,
): Record<string, unknown> {
  expect(result.timersLeft).toBe(0);
  expect(result.storeTouched).toBe(false);
  expect(getApiSession()).toBeNull();

  if (expected.kind === 'pending') {
    expect(result.settled.kind).toBe('pending');
    if (Number.isFinite(expected.abortSignalledByMs))
      expect(result.aborted).toBe(true);
    return {
      settled: 'pending',
      abortSignalled: result.aborted,
      fetchCalls: result.calls.length,
    };
  }

  if (expected.kind === 'rejects' && !expected.fetchCalled) {
    expect(result.calls).toHaveLength(0);
  } else {
    assertWire(plan, result.calls);
  }

  if (expected.kind === 'rejects') {
    if (result.settled.kind !== 'rejected') {
      throw new Error(
        `expected rejection ${expected.code}, got ${result.settled.kind}`,
      );
    }
    const error = result.settled.error;
    expect(error).toBeInstanceOf(AccountBootstrapError);
    expect(error).toBeInstanceOf(Error);
    const typed = error as AccountBootstrapError;
    expect(typed.name).toBe('AccountBootstrapError');
    expect(typed.code).toBe(expected.code);
    expect(typed.retryable).toBe(expected.retryable);
    expect(typed.message.trim().length).toBeGreaterThan(0);
    if (expected.message !== undefined)
      expect(typed.message).toBe(expected.message);
    for (const secret of secrets(plan, seed))
      expect(typed.message).not.toContain(secret);
    return {
      settled: 'rejected',
      atMs: result.settled.atMs,
      code: typed.code,
      retryable: typed.retryable,
      message: typed.message,
      abortSignalled: result.aborted,
    };
  }

  if (result.settled.kind !== 'resolved') {
    throw new Error(
      `expected success, got ${result.settled.kind}: ${String(
        (result.settled as { error?: unknown }).error,
      )}`,
    );
  }
  const value = result.settled.value;
  expect(value.account).toEqual({
    id: expected.canonicalId,
    email: expected.email,
    onboardingState: expected.onboardingState,
  });
  expect(value.apiSession).toEqual({
    apiBaseUrl: plan.baseUrl.normalized,
    bearerToken: expected.bearerToken,
    canonicalAppUserId: expected.canonicalId,
    provider: plan.apple.provider,
    refreshToken: expected.refreshToken,
    bearerExpiresAtMs: expected.bearerExpiresAtMs,
  });
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain('subject');
  expect(serialized).not.toContain('providerSubject');
  if (expected.refreshToken === null) {
    // Legacy server: nothing durable must be minted client-side.
    expect(value.apiSession.bearerToken).toBe(plan.bearer.sent);
  }
  return {
    settled: 'resolved',
    atMs: result.settled.atMs,
    bearer:
      value.apiSession.bearerToken === plan.bearer.sent ? 'provider' : 'server',
    refreshToken: value.apiSession.refreshToken !== null,
    bearerExpiresAtMs: value.apiSession.bearerExpiresAtMs,
  };
}

async function runPlan(
  family: string,
  id: string,
  seed: number,
  plan: BootstrapPlan,
): Promise<void> {
  const expected = expectedOutcome(plan, seed);
  await scenario(
    family,
    id,
    seed,
    planInputs(plan),
    expected as unknown as Record<string, unknown>,
    async () => {
      const result = await drive(plan, expected);
      const observed = assertOutcome(plan, seed, expected, result);
      return {
        observed,
        verdict: expected.kind === 'pending' ? 'DEPENDENCY_LIMIT' : 'HELD',
      };
    },
  );
}

const OK_URL = BASE_URL_CASES[0]!;
const okBearer = (seed: number) => bearerCases(seed)[0]!;
const googleNoCode = (seed: number) => appleCodeCases(seed)[4]!;

function validBody(seed: number): {
  built: BootstrapPlan['built'];
  body: BodyBehaviour;
} {
  const plan: PayloadPlan = {
    userShape: 'object',
    id: 'valid',
    email: 'string',
    onboardingState: 'complete',
    session: {
      shape: 'object',
      accessToken: 'ok',
      refreshToken: 'ok',
      expiresAt: 'seconds',
    },
    extraKeys: false,
  };
  const built = buildPayload(plan, seededRandom(seed), seed);
  return { built, body: { kind: 'json', value: built.payload } };
}

function basePlan(
  seed: number,
  overrides: Partial<BootstrapPlan> = {},
): BootstrapPlan {
  const { built, body } = validBody(seed);
  return {
    baseUrl: OK_URL,
    bearer: okBearer(seed),
    apple: googleNoCode(seed),
    fetch: { kind: 'resolve-after', ms: 0, honoursAbort: true },
    status: 200,
    body,
    built,
    errorKind: null,
    ...overrides,
  };
}

function seedFor(id: string): number {
  return stressSeeds(id, 1)[0]!;
}

/** Every subscription made by a test, so a failing iteration cannot leak a
 * throwing listener into the next one. */
const LIVE_SUBSCRIPTIONS = new Set<() => void>();
function subscribe(listener: Parameters<typeof subscribeToApiSession>[0]) {
  const off = subscribeToApiSession(listener);
  const wrapped = () => {
    LIVE_SUBSCRIPTIONS.delete(wrapped);
    off();
  };
  LIVE_SUBSCRIPTIONS.add(wrapped);
  return wrapped;
}

beforeEach(() => {
  jest.useFakeTimers();
  clearApiSession();
  setApiUnauthorizedListener(null);
});

afterEach(() => {
  for (const off of [...LIVE_SUBSCRIPTIONS]) off();
  setApiUnauthorizedListener(null);
  clearApiSession();
  jest.clearAllTimers();
  jest.useRealTimers();
});

// ─── 1. Deterministic fault catalogue (every fault class, named) ─────────────

describe('failure-injection catalogue: configuration + credential faults', () => {
  it.each(BASE_URL_CASES.map(c => [c.id, c] as const))(
    '%s',
    async (id, baseUrl: BaseUrlCase) => {
      const seed = seedFor(id);
      await runPlan('catalogue.config', id, seed, basePlan(seed, { baseUrl }));
    },
  );

  it.each(bearerCases(1).map((c, i) => [c.id, i] as const))(
    '%s',
    async (id, index) => {
      const seed = seedFor(id);
      await runPlan(
        'catalogue.bearer',
        id,
        seed,
        basePlan(seed, { bearer: bearerCases(seed)[index]! }),
      );
    },
  );

  it.each(appleCodeCases(1).map((c, i) => [c.id, i] as const))(
    '%s',
    async (id, index) => {
      const seed = seedFor(id);
      await runPlan(
        'catalogue.apple',
        id,
        seed,
        basePlan(seed, { apple: appleCodeCases(seed)[index]! }),
      );
    },
  );

  it('fetch missing from the runtime → not_configured, nothing thrown at the caller', async () => {
    const seed = seedFor('fetch.missing');
    const original = globalThis.fetch;
    // @ts-expect-error — simulating a build without a fetch implementation.
    globalThis.fetch = undefined;
    try {
      await scenario(
        'catalogue.config',
        'fetch.missing',
        seed,
        {},
        'not_configured',
        async () => {
          const promise = bootstrapCanonicalAccount({
            apiBaseUrl: OK_URL.value,
            bearerToken: okBearer(seed).value,
            provider: 'google',
            environment: ENVIRONMENT,
          });
          await expect(promise).rejects.toMatchObject({
            name: 'AccountBootstrapError',
            code: 'account.not_configured',
            retryable: false,
          });
          expect(jest.getTimerCount()).toBe(0);
          return { observed: { code: 'account.not_configured' } };
        },
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('failure-injection catalogue: transport faults', () => {
  const transport: Array<[string, FetchBehaviour]> = [
    ...REALISTIC_FETCH_FAULTS.map(
      f =>
        [
          `fetch.${f.kind}${'errorName' in f ? `.${f.errorName}` : ''}${'value' in f ? `.${f.value}` : ''}`,
          f,
        ] as [string, FetchBehaviour],
    ),
    ['fetch.hang-ignores-abort', { kind: 'hang-ignores-abort' }],
    ['fetch.slow.1ms', { kind: 'resolve-after', ms: 1, honoursAbort: true }],
    ['fetch.slow.7s', { kind: 'resolve-after', ms: 7_000, honoursAbort: true }],
    [
      'fetch.slow.14998ms',
      { kind: 'resolve-after', ms: 14_998, honoursAbort: true },
    ],
    [
      'fetch.slow.14999ms',
      { kind: 'resolve-after', ms: 14_999, honoursAbort: true },
    ],
    [
      'fetch.deadline.15000ms',
      { kind: 'resolve-after', ms: 15_000, honoursAbort: true },
    ],
    [
      'fetch.late.15001ms',
      { kind: 'resolve-after', ms: 15_001, honoursAbort: true },
    ],
    [
      'fetch.late.45s',
      { kind: 'resolve-after', ms: 45_000, honoursAbort: true },
    ],
    [
      'fetch.late.ignores-abort.15001ms',
      { kind: 'resolve-after', ms: 15_001, honoursAbort: false },
    ],
    [
      'fetch.late.ignores-abort.59s',
      { kind: 'resolve-after', ms: 59_000, honoursAbort: false },
    ],
  ];
  it.each(transport)('%s', async (id, fetch) => {
    const seed = seedFor(id);
    await runPlan('catalogue.transport', id, seed, basePlan(seed, { fetch }));
  });

  const bodies: Array<[string, (seed: number) => BodyBehaviour]> = [
    ['body.json-throws-sync', () => ({ kind: 'json-throws-sync' })],
    ['body.json-rejects', () => ({ kind: 'json-rejects' })],
    ['body.json-never', () => ({ kind: 'json-never' })],
    [
      'body.json-slow.1ms',
      seed => ({
        kind: 'json-slow',
        ms: 1,
        value: validBody(seed).built!.payload,
      }),
    ],
    [
      'body.json-slow.20s',
      seed => ({
        kind: 'json-slow',
        ms: 20_000,
        value: validBody(seed).built!.payload,
      }),
    ],
    [
      'body.json-slow.after-headers-at-14s',
      seed => ({
        kind: 'json-slow',
        ms: 5_000,
        value: validBody(seed).built!.payload,
      }),
    ],
  ];
  it.each(bodies)('%s', async (id, make) => {
    const seed = seedFor(id);
    const fetch: FetchBehaviour =
      id === 'body.json-slow.after-headers-at-14s'
        ? { kind: 'resolve-after', ms: 14_000, honoursAbort: true }
        : { kind: 'resolve-after', ms: 0, honoursAbort: true };
    await runPlan(
      'catalogue.body',
      id,
      seed,
      basePlan(seed, { fetch, body: make(seed) }),
    );
  });
});

describe('failure-injection catalogue: server status × error payload', () => {
  const statuses = [
    204, 301, 400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504, 599,
  ];
  const errorKinds: ErrorPayloadKind[] = [
    'object-message',
    'string-error',
    'empty-message',
    'blank-message',
    'number-message',
    'no-error',
    'null',
  ];
  const cells: Array<[string, number, ErrorPayloadKind]> = [];
  for (const status of statuses) {
    // Each status meets every error-payload shape at least once across the
    // grid; 401/403/429/5xx meet all of them.
    const kinds =
      status === 401 || status === 403 || status === 429 || status >= 500
        ? errorKinds
        : [errorKinds[status % errorKinds.length]!];
    for (const kind of kinds)
      cells.push([`status.${status}.${kind}`, status, kind]);
  }
  it.each(cells)('%s', async (id, status, errorKind) => {
    const seed = seedFor(id);
    const ok = status >= 200 && status < 300;
    const plan = basePlan(seed, {
      status,
      errorKind: ok ? null : errorKind,
      ...(ok
        ? // 204 with the error-shaped body: no canonical account ⇒ invalid_response
          {
            body: { kind: 'json', value: errorPayload(errorKind, seed) },
            built: null,
          }
        : { body: { kind: 'json', value: errorPayload(errorKind, seed) } }),
    });
    await runPlan('catalogue.status', id, seed, plan);
  });
});

describe('failure-injection catalogue: canonical account + session payload shapes', () => {
  const accountShapes: Array<[string, Partial<PayloadPlan>]> = [
    ['payload.user.null', { userShape: 'null' }],
    ['payload.user.array', { userShape: 'array' }],
    ['payload.user.string', { userShape: 'string' }],
    ['payload.user.missing', { userShape: 'missing' }],
    ['payload.id.version-9', { id: 'version-9' }],
    ['payload.id.variant-c', { id: 'variant-c' }],
    ['payload.id.no-dashes', { id: 'no-dashes' }],
    ['payload.id.short', { id: 'short' }],
    ['payload.id.number', { id: 'number' }],
    ['payload.id.null', { id: 'null' }],
    ['payload.id.provider-subject', { id: 'subject' }],
    ['payload.id.missing', { id: 'missing' }],
    ['payload.email.null', { email: 'null' }],
    ['payload.email.number', { email: 'number' }],
    ['payload.email.missing', { email: 'missing' }],
    ['payload.onboarding.PENDING', { onboardingState: 'PENDING' }],
    ['payload.onboarding.done', { onboardingState: 'done' }],
    ['payload.onboarding.missing', { onboardingState: 'missing' }],
    ['payload.onboarding.number', { onboardingState: 'number' }],
    ['payload.extra-keys', { extraKeys: true }],
  ];
  const sessionShapes: Array<[string, Partial<PayloadPlan['session']>]> = [
    ['session.missing', { shape: 'missing' }],
    ['session.null', { shape: 'null' }],
    ['session.string', { shape: 'string' }],
    ['session.array', { shape: 'array' }],
    ['session.access.padded', { accessToken: 'padded' }],
    ['session.access.empty', { accessToken: 'empty' }],
    ['session.access.blank', { accessToken: 'blank' }],
    ['session.access.number', { accessToken: 'number' }],
    ['session.access.missing', { accessToken: 'missing' }],
    ['session.refresh.empty', { refreshToken: 'empty' }],
    ['session.refresh.blank', { refreshToken: 'blank' }],
    ['session.refresh.number', { refreshToken: 'number' }],
    ['session.refresh.missing', { refreshToken: 'missing' }],
    ['session.expires.zero', { expiresAt: 'zero' }],
    ['session.expires.negative', { expiresAt: 'negative' }],
    ['session.expires.float', { expiresAt: 'float' }],
    ['session.expires.string', { expiresAt: 'string' }],
    ['session.expires.nan', { expiresAt: 'nan' }],
    ['session.expires.infinity', { expiresAt: 'infinity' }],
    ['session.expires.missing', { expiresAt: 'missing' }],
    ['session.expires.null', { expiresAt: 'null' }],
  ];
  const cells: Array<[string, PayloadPlan]> = [
    ...accountShapes.map(
      ([id, partial]) =>
        [
          id,
          {
            userShape: 'object',
            id: 'valid',
            email: 'string',
            onboardingState: 'pending',
            session: {
              shape: 'object',
              accessToken: 'ok',
              refreshToken: 'ok',
              expiresAt: 'seconds',
            },
            extraKeys: false,
            ...partial,
          } as PayloadPlan,
        ] as [string, PayloadPlan],
    ),
    ...sessionShapes.map(
      ([id, partial]) =>
        [
          id,
          {
            userShape: 'object',
            id: 'valid',
            email: 'null',
            onboardingState: 'complete',
            session: {
              shape: 'object',
              accessToken: 'ok',
              refreshToken: 'ok',
              expiresAt: 'seconds',
              ...partial,
            },
            extraKeys: false,
          } as PayloadPlan,
        ] as [string, PayloadPlan],
    ),
  ];
  it.each(cells)('%s', async (id, payloadPlan) => {
    const seed = seedFor(id);
    const built = buildPayload(payloadPlan, seededRandom(seed), seed);
    await runPlan(
      'catalogue.payload',
      id,
      seed,
      basePlan(seed, { built, body: { kind: 'json', value: built.payload } }),
    );
  });
});

// ─── 2. Seeded random campaign over the whole fault space ────────────────────

describe(`failure-injection random campaign (STRESS_ITER=${STRESS_ITER})`, () => {
  it.each(stressSeeds('bootstrap.random').map(seed => [seed] as const))(
    'seed %d',
    async seed => {
      const random = seededRandom(seed);
      const baseUrl =
        random() < 0.8
          ? pick(
              random,
              BASE_URL_CASES.filter(c => c.expect === 'ok'),
            )
          : pick(random, BASE_URL_CASES);
      const bearers = bearerCases(seed);
      const bearer =
        random() < 0.85
          ? pick(
              random,
              bearers.filter(b => b.sent !== null),
            )
          : pick(random, bearers);
      const apple = pick(random, appleCodeCases(seed));
      const fetch = randomFetchBehaviour(random);
      const status = pick(random, STATUS_POOL);
      const ok = status >= 200 && status < 300;
      let built: BootstrapPlan['built'] = null;
      let errorKind: ErrorPayloadKind | null = null;
      let value: unknown;
      if (ok) {
        built = buildPayload(randomPayloadPlan(random), random, seed);
        value = built.payload;
      } else {
        errorKind = pick(random, [
          'object-message',
          'string-error',
          'empty-message',
          'blank-message',
          'number-message',
          'no-error',
          'null',
        ] as const);
        value = errorPayload(errorKind, seed);
      }
      const body = randomBodyBehaviour(random, value);
      await runPlan('campaign.bootstrap', `bootstrap.random.${seed}`, seed, {
        baseUrl,
        bearer,
        apple,
        fetch,
        status,
        body,
        built,
        errorKind,
      });
    },
  );
});

// ─── 3. apiSession under listener faults + interleaved account switches ─────

type SubscriberKind =
  'normal' | 'throws' | 'unsubscribes-self' | 'reentrant-clear';

interface Subscriber {
  kind: SubscriberKind;
  calls: number;
  unsubscribe: () => void;
  active: boolean;
}

function sessionFor(seed: number, who: 'A' | 'A2' | 'B'): ApiSession {
  const id =
    who === 'B'
      ? `b0000000-0000-4000-8000-${String(seed).padStart(12, '0')}`
      : `a0000000-0000-4000-8000-${String(seed).padStart(12, '0')}`;
  return {
    apiBaseUrl: 'https://api.pickle.example',
    bearerToken: `${who}-bearer-${seed}`,
    canonicalAppUserId: id,
    provider: who === 'B' ? 'google' : 'apple',
    refreshToken: who === 'A2' ? `A2-refresh-${seed}` : null,
    bearerExpiresAtMs: who === 'A2' ? 1_700_000_000_000 : null,
  };
}

describe(`apiSession failure-injection sequences (STRESS_ITER=${STRESS_ITER})`, () => {
  it.each(stressSeeds('apiSession.sequence').map(seed => [seed] as const))(
    'seed %d',
    async seed => {
      const random = seededRandom(seed);
      const ops = randomInt(random, 20, 60);
      const trace: string[] = [];
      await scenario(
        'campaign.apiSession',
        `apiSession.sequence.${seed}`,
        seed,
        { ops },
        'reference model agrees after every op',
        async () => {
          let model = null as ApiSession | null;
          let unauthorizedKind: 'none' | 'normal' | 'throws' = 'none';
          let unauthorizedCalls = 0;
          let unauthorizedThrows = 0;
          let subscriberThrows = 0;
          let reentrantClears = 0;
          let redundantNotifies = 0;
          const subscribers: Subscriber[] = [];
          const sessions = {
            A: sessionFor(seed, 'A'),
            A2: sessionFor(seed, 'A2'),
            B: sessionFor(seed, 'B'),
          };

          const addSubscriber = (kind: SubscriberKind) => {
            const sub: Subscriber = {
              kind,
              calls: 0,
              active: true,
              unsubscribe: () => {},
            };
            sub.unsubscribe = subscribe(() => {
              sub.calls += 1;
              switch (kind) {
                case 'normal':
                  return;
                case 'throws':
                  throw new Error(`subscriber ${seed} exploded`);
                case 'unsubscribes-self':
                  sub.active = false;
                  sub.unsubscribe();
                  return;
                case 'reentrant-clear':
                  if (getApiSession() !== null) clearApiSession();
                  return;
              }
            });
            subscribers.push(sub);
          };

          /** Applies a store mutation, mirroring zustand's notify semantics in
           * the model: `set({session})` always produces a new state object, so
           * EVERY establish/clear notifies (even a redundant one); state is set
           * BEFORE listeners run (in subscription order); a throwing listener
           * propagates to the mutating caller and starves the listeners after
           * it; a listener that re-enters the store nests a full notification
           * round. */
          const mutate = (
            label: string,
            next: ApiSession | null,
            run: () => void,
          ) => {
            const prev = model;
            if (Object.is(prev, next)) redundantNotifies += 1;
            const active = subscribers.filter(s => s.active);
            const before = active.map(s => s.calls);
            let threw = false;
            try {
              run();
            } catch (error) {
              threw = true;
              expect((error as Error).message).toBe(
                `subscriber ${seed} exploded`,
              );
              subscriberThrows += 1;
            }
            model = next;
            const calledNow = active.map((s, i) => s.calls > before[i]!);
            const reentered =
              next !== null &&
              active.some(
                (s, i) => s.kind === 'reentrant-clear' && calledNow[i],
              );
            active.forEach((s, i) => {
              if (s.kind === 'unsubscribes-self' && calledNow[i])
                s.active = false;
            });
            if (reentered) {
              // The re-entrant listener cleared the freshly set session from
              // inside the notification round; the exact call multiset is
              // zustand's business, the resulting state is ours.
              model = null;
              reentrantClears += 1;
            } else {
              let starved = false;
              let sawThrower = false;
              active.forEach((s, i) => {
                expect({ label, kind: s.kind, called: calledNow[i] }).toEqual({
                  label,
                  kind: s.kind,
                  called: !starved,
                });
                if (!starved && s.kind === 'throws') {
                  starved = true;
                  sawThrower = true;
                }
              });
              expect(threw).toBe(sawThrower);
            }
            trace.push(`${label}${threw ? '!' : ''}`);
            expect(getApiSession()).toBe(model);
          };

          for (let i = 0; i < ops; i += 1) {
            const roll = random();
            if (roll < 0.22) {
              const who = pick(random, ['A', 'A2', 'B'] as const);
              const next = random() < 0.15 && model ? model : sessions[who];
              mutate(`establish(${who})`, next, () =>
                establishApiSession(next),
              );
            } else if (roll < 0.34) {
              mutate('clear', null, () => clearApiSession());
            } else if (roll < 0.5) {
              const who = pick(random, ['A', 'B', 'X'] as const);
              const id =
                who === 'X' ? `x-${seed}` : sessions[who].canonicalAppUserId;
              const expected =
                model && model.canonicalAppUserId === id
                  ? model.bearerToken
                  : null;
              expect(bearerTokenFor(id)).toBe(expected);
              trace.push(`bearerFor(${who})=${expected ? 'bearer' : 'null'}`);
            } else if (roll < 0.68) {
              const token = pick(random, [
                model?.bearerToken ?? 'none',
                sessions.A.bearerToken,
                sessions.A2.bearerToken,
                sessions.B.bearerToken,
                `stale-${seed}`,
                '',
              ]);
              const matches = model !== null && model.bearerToken === token;
              const before = unauthorizedCalls;
              let threw = false;
              try {
                reportApiUnauthorized(token);
              } catch (error) {
                threw = true;
                expect((error as Error).message).toBe(
                  `unauthorized listener ${seed} exploded`,
                );
              }
              const shouldCall = matches && unauthorizedKind !== 'none';
              expect(unauthorizedCalls - before).toBe(shouldCall ? 1 : 0);
              expect(threw).toBe(shouldCall && unauthorizedKind === 'throws');
              if (threw) unauthorizedThrows += 1;
              expect(getApiSession()).toBe(model);
              trace.push(
                `unauthorized(${matches ? 'current' : 'stale'})${threw ? '!' : ''}`,
              );
            } else if (roll < 0.8) {
              if (subscribers.filter(s => s.active).length < 4) {
                const kind = pick(random, [
                  'normal',
                  'normal',
                  'throws',
                  'unsubscribes-self',
                  'reentrant-clear',
                ] as const);
                addSubscriber(kind);
                trace.push(`subscribe(${kind})`);
              }
            } else if (roll < 0.88) {
              const active = subscribers.filter(s => s.active);
              if (active.length > 0) {
                const victim = pick(random, active);
                victim.unsubscribe();
                victim.active = false;
                // Double unsubscribe must be a no-op.
                victim.unsubscribe();
                trace.push(`unsubscribe(${victim.kind})`);
              }
            } else {
              unauthorizedKind = pick(random, [
                'none',
                'normal',
                'throws',
              ] as const);
              if (unauthorizedKind === 'none') setApiUnauthorizedListener(null);
              else {
                const kind = unauthorizedKind;
                setApiUnauthorizedListener(session => {
                  unauthorizedCalls += 1;
                  expect(session).toBe(getApiSession());
                  if (kind === 'throws')
                    throw new Error(`unauthorized listener ${seed} exploded`);
                });
              }
              trace.push(`setUnauthorized(${unauthorizedKind})`);
            }
          }

          // Recovery: a full sign-out leaves nothing resolvable.
          for (const s of subscribers) if (s.active) s.unsubscribe();
          setApiUnauthorizedListener(null);
          clearApiSession();
          expect(getApiSession()).toBeNull();
          expect(bearerTokenFor(sessions.A.canonicalAppUserId)).toBeNull();
          expect(bearerTokenFor(sessions.B.canonicalAppUserId)).toBeNull();
          const calls = unauthorizedCalls;
          reportApiUnauthorized(sessions.A.bearerToken);
          expect(unauthorizedCalls).toBe(calls);
          return {
            observed: {
              ops,
              subscriberThrows,
              unauthorizedThrows,
              reentrantClears,
              redundantNotifies,
              trace: trace.join(' '),
            },
          };
        },
      );
    },
  );

  it('the unit loads neither the Keychain vault nor SQLite', () => {
    expect(mockKeychainLoaded).toBe(false);
    expect(mockSqliteLoaded).toBe(false);
    expect(normalizeApiBaseUrl('https://api.pickle.example/')).toBe(
      'https://api.pickle.example',
    );
  });
});

// ─── 4. Reproduced defects (`it.failing`: green while the defect exists) ─────
//
// Each probe asserts the CONTRACT the caller would want. On 1fb0efd7 the
// assertion fails, jest's `failing` modifier turns that into a pass, and the
// JSON row is recorded as BROKEN with the observed behaviour. Once the module
// is fixed the probe starts failing loudly — delete it then.

/** Settles a promise under fake time (0 ms timers + microtasks). */
async function settle<T>(
  promise: Promise<T>,
): Promise<{ value: T | null; error: unknown; settled: boolean }> {
  const out = {
    value: null as T | null,
    error: null as unknown,
    settled: false,
  };
  promise.then(
    value => {
      out.value = value;
      out.settled = true;
    },
    (error: unknown) => {
      out.error = error;
      out.settled = true;
    },
  );
  for (let i = 0; i < 5 && !out.settled; i += 1) {
    await jest.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 10; j += 1) await Promise.resolve();
  }
  if (!out.settled) throw new Error('bootstrap did not settle under fake time');
  return out;
}

describe('reproduced defects on 1fb0efd7 (it.failing — BROKEN rows)', () => {
  it.failing.each([
    ['url.https.query', 'https://api.pickle.example?env=prod'],
    ['url.https.fragment', 'https://api.pickle.example#prod'],
  ])(
    'P3 %s: normalizeApiBaseUrl accepts a base with query/fragment, so the request URL loses its path',
    async (id, value) => {
      const seed = seedFor(id);
      await scenario(
        'defect.config',
        id,
        seed,
        { value },
        'not_configured OR a request to /v1/account/bootstrap',
        async () => {
          const fetch = injectFetch(
            { kind: 'resolve-after', ms: 0, honoursAbort: true },
            { status: 404, body: { kind: 'json', value: null } },
          );
          const { error } = await settle(
            bootstrapCanonicalAccount({
              apiBaseUrl: value,
              bearerToken: okBearer(seed).value,
              provider: 'google',
              environment: ENVIRONMENT,
              fetchFn: fetch.fn,
            }),
          );
          const observed = {
            normalized: normalizeApiBaseUrl(value),
            requestUrl: fetch.calls[0]?.url ?? null,
            requestPath: fetch.calls[0]
              ? new URL(fetch.calls[0].url).pathname
              : null,
            code: (error as AccountBootstrapError | null)?.code ?? null,
          };
          // Either the configuration is refused up front (not_configured, no
          // request), or the request reaches the bootstrap route.
          const refused =
            fetch.calls.length === 0 &&
            observed.code === 'account.not_configured';
          const routed = observed.requestPath === '/v1/account/bootstrap';
          if (!refused && !routed) {
            throw new Error(
              `base URL ${JSON.stringify(value)} accepted (normalized ${JSON.stringify(observed.normalized)}) but request went to ${observed.requestUrl} (path ${observed.requestPath}); surfaced as ${observed.code}`,
            );
          }
          return { observed };
        },
      );
    },
  );

  it.failing.each([
    ['status.401.unreadable-body', 401, 'account.rejected', false],
    ['status.403.unreadable-body', 403, 'account.rejected', false],
    ['status.404.unreadable-body', 404, 'account.unavailable', false],
  ] as const)(
    'P3 %s: a non-JSON body on a definitive status is classified by the body, not the status',
    async (id, status, code, retryable) => {
      const seed = seedFor(id);
      await scenario(
        'defect.status-vs-body',
        id,
        seed,
        { status, body: 'json-throws-sync' },
        { code, retryable },
        async () => {
          const plan = basePlan(seed, {
            status,
            body: { kind: 'json-throws-sync' },
            errorKind: null,
            built: null,
          });
          const fetch = injectFetch(plan.fetch, { status, body: plan.body });
          const { error } = await settle(
            bootstrapCanonicalAccount({
              apiBaseUrl: plan.baseUrl.value,
              bearerToken: plan.bearer.value,
              provider: 'google',
              environment: ENVIRONMENT,
              fetchFn: fetch.fn,
            }),
          );
          expect(error).toBeInstanceOf(AccountBootstrapError);
          const typed = error as AccountBootstrapError;
          const observed = {
            code: typed.code,
            retryable: typed.retryable,
            message: typed.message,
          };
          if (observed.code !== code || observed.retryable !== retryable) {
            throw new Error(
              `HTTP ${status} with an unreadable body surfaced as ${observed.code} (retryable=${observed.retryable}); the status alone is definitive: ${code} (retryable=${retryable})`,
            );
          }
          return { observed };
        },
      );
    },
  );
});
