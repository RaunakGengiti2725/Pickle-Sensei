/**
 * STRESS / boundary-malformed — `src/billing/accessApi.ts`
 *
 * Feeds the canonical access client hostile transport + body shapes and
 * asserts the contract in src/billing/types.ts holds on every seed:
 *   - only `BillingError` (enumerated code / reason) ever escapes;
 *   - misconfiguration never reaches the network;
 *   - a 401 is reported to the unauthorized listener exactly once, and only
 *     for the bearer that is actually in the session;
 *   - anything accepted is a fresh, exactly-shaped, coherent access object
 *     (no foreign keys, no shared references, no polluted prototype);
 *   - nothing accepted violates the reference coherence predicate, and
 *     nothing coherent is rejected;
 *   - the process prototype chain is untouched afterwards.
 *
 * Replay one seed:  STRESS_ONLY=<seed> npx jest --ci __tests__/stress/billingAccessApiFuzz.stress.test.ts
 * Scale:            STRESS_ITER=3000 npx jest --ci __tests__/stress/billingAccessApiFuzz.stress.test.ts
 */
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import {
  corruptJsonText,
  describeError,
  isCoherentAccess,
  isCoherentBilling,
  isTypedBillingError,
  mutate,
  pollutionProbe,
  replayCommand,
  Rng,
  seedsFor,
  stressConfig,
  summarize,
  TEXT_CORRUPTIONS,
  WEIRD_STRINGS,
  weirdValue,
  writeTable,
  type StressRow,
} from '../../test-support/stress/billingFuzz';

const SUITE_FILE = 'billingAccessApiFuzz.stress.test.ts';
const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function coherentAccess(rng: Rng): { [key: string]: Json } {
  const premium = rng.chance(0.4);
  const used = rng.int(0, 2);
  const remaining = 2 - used;
  const reserved = rng.int(0, remaining);
  const available = remaining - reserved;
  const canStart = premium || available > 0;
  const entitlements: Json[] = premium ? ['premium'] : [];
  if (rng.chance(0.2)) entitlements.push('pickle_sensei_pro');
  return {
    premium,
    entitlements,
    freeRatings: {
      limit: 2,
      used,
      reserved,
      remaining,
      availableToReserve: available,
    },
    canStartRating: canStart,
    paywallRequired: !canStart,
  };
}

function coherentBilling(rng: Rng, premium: boolean): { [key: string]: Json } {
  return {
    premium,
    productKey: premium ? rng.pick(['annual', 'monthly', 'lifetime']) : null,
    expiresAt: premium && rng.chance(0.7) ? '2027-08-27T00:00:00.000Z' : null,
    verifiedAt: '2026-09-04T00:00:00.000Z',
  };
}

type BodyPlan =
  | { kind: 'value'; value: unknown; mutations: string[] }
  | { kind: 'text'; text: string; corruption: string }
  | { kind: 'json_throws'; error: unknown }
  | { kind: 'json_sync_throws'; error: unknown };

type Transport =
  | { mode: 'throw_sync' }
  | { mode: 'reject'; reason: unknown }
  | { mode: 'respond'; status: number; body: BodyPlan }
  | { mode: 'hang_then_respond'; status: number; body: BodyPlan };

interface Scenario {
  op: 'access' | 'sync';
  baseUrl: ConfigValue;
  token: ConfigValue;
  session: 'none' | 'matching' | 'other';
  transport: Transport;
}

const STATUS_POOL = [
  200,
  200,
  200,
  200,
  201,
  204,
  299,
  301,
  304,
  400,
  401,
  401,
  403,
  404,
  409,
  418,
  422,
  429,
  500,
  502,
  503,
  504,
  599,
  0,
  -1,
  1000,
  NaN,
  99,
  100,
];

function pickStatus(rng: Rng): number {
  return rng.chance(0.6) ? 200 : rng.pick(STATUS_POOL);
}

// Config values stay inside the declared `string | null | undefined` contract
// (baseUrl is a build-time constant, token comes from `bearerTokenFor`).
type ConfigValue = string | null | undefined;

function pickBaseUrl(rng: Rng): ConfigValue {
  if (rng.chance(0.7))
    return rng.pick(['https://api.example.test', 'https://api.example.test/']);
  return rng.pick<ConfigValue>([
    'https://api.example.test/',
    'https://api.example.test///',
    ' https://api.example.test ',
    '',
    '   ',
    '\uFEFF',
    '\u200b',
    'https://api.example.test/../..',
    'http://[::1]:8000',
    'not a url',
    WEIRD_STRINGS[8]!, // 64 KB string
    null,
    undefined,
  ]);
}

function pickToken(rng: Rng): ConfigValue {
  if (rng.chance(0.7)) return rng.pick(['tok-valid', ' tok-valid ', 'e\u0301']);
  return rng.pick<ConfigValue>([
    ' tok-valid ',
    '',
    '  ',
    '\u0000',
    '\u200b',
    'tok\r\nX-Injected: 1',
    'tok\u0000null',
    WEIRD_STRINGS[8]!,
    WEIRD_STRINGS[9]!,
    'e\u0301',
    '../../etc/passwd',
    'sk_secret',
    null,
    undefined,
  ]);
}

function planBody(rng: Rng, op: Scenario['op']): BodyPlan {
  const access = coherentAccess(rng);
  const base: Json =
    op === 'access'
      ? access
      : { access, billing: coherentBilling(rng, access['premium'] === true) };
  const roll = rng.int(0, 19);
  if (roll <= 10) {
    const { value, mutations } = mutate(
      rng,
      base,
      rng.pick([0, 1, 1, 1, 2, 2, 3, 5]),
    );
    return {
      kind: 'value',
      value,
      mutations: mutations.map(m => `${m.kind}@${m.path}`),
    };
  }
  if (roll <= 14) {
    const corruption = rng.pick(TEXT_CORRUPTIONS);
    return {
      kind: 'text',
      text: corruptJsonText(rng, base, corruption),
      corruption,
    };
  }
  if (roll <= 17) {
    return {
      kind: 'value',
      value: weirdValue(rng),
      mutations: ['whole_body_weird'],
    };
  }
  if (roll === 18) {
    return {
      kind: 'json_throws',
      error: rng.pick([
        new SyntaxError('Unexpected token'),
        new TypeError('body used already'),
        'string reason',
        null,
      ]),
    };
  }
  return {
    kind: 'json_sync_throws',
    error: new TypeError('json is not a function'),
  };
}

function generate(seed: number): Scenario {
  const rng = new Rng(seed);
  const op = rng.chance(0.5) ? 'access' : 'sync';
  const baseUrl = pickBaseUrl(rng);
  const token = pickToken(rng);
  const session = rng.pick(['none', 'matching', 'matching', 'other'] as const);
  let transport: Transport;
  const transportRoll = rng.int(0, 11);
  if (transportRoll === 0) transport = { mode: 'throw_sync' };
  else if (transportRoll === 1) {
    transport = {
      mode: 'reject',
      reason: rng.pick([
        new TypeError('Network request failed'),
        'AbortError',
        undefined,
        { code: 'ECONNRESET' },
      ]),
    };
  } else if (transportRoll === 2) {
    transport = {
      mode: 'hang_then_respond',
      status: pickStatus(rng),
      body: planBody(rng, op),
    };
  } else {
    transport = {
      mode: 'respond',
      status: pickStatus(rng),
      body: planBody(rng, op),
    };
  }
  return { op, baseUrl, token, session, transport };
}

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface Expectation {
  configured: boolean;
  reason: string | null;
  expectFetch: boolean;
  expectedUrl: string | null;
  expectedAuth: string | null;
  expectUnauthorized: boolean;
}

function expectationFor(scenario: Scenario): Expectation {
  const base = trimmed(scenario.baseUrl).replace(/\/+$/, '');
  const token = trimmed(scenario.token);
  if (!base) {
    return {
      configured: false,
      reason: 'missing_api_base_url',
      expectFetch: false,
      expectedUrl: null,
      expectedAuth: null,
      expectUnauthorized: false,
    };
  }
  if (!token) {
    return {
      configured: false,
      reason: 'missing_api_token',
      expectFetch: false,
      expectedUrl: null,
      expectedAuth: null,
      expectUnauthorized: false,
    };
  }
  const path = scenario.op === 'access' ? '/v1/me/access' : '/v1/billing/sync';
  const t = scenario.transport;
  const is401 =
    (t.mode === 'respond' || t.mode === 'hang_then_respond') &&
    t.status === 401;
  return {
    configured: true,
    reason: null,
    expectFetch: true,
    expectedUrl: `${base}${path}`,
    expectedAuth: `Bearer ${token}`,
    expectUnauthorized: is401 && scenario.session === 'matching',
  };
}

function makeResponse(status: number, body: BodyPlan): Response {
  const ok = status >= 200 && status <= 299;
  const json = (): Promise<unknown> => {
    switch (body.kind) {
      case 'value':
        return Promise.resolve(body.value);
      case 'text':
        try {
          return Promise.resolve(JSON.parse(body.text) as unknown);
        } catch (error) {
          return Promise.reject(error);
        }
      case 'json_throws':
        return Promise.reject(body.error);
      case 'json_sync_throws':
        throw body.error;
    }
  };
  return { ok, status, json } as unknown as Response;
}

function isCoherentSync(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const v = value as { access?: unknown; billing?: unknown };
  if (!isCoherentAccess(v.access) || !isCoherentBilling(v.billing))
    return false;
  return (v.billing as { premium: boolean }).premium === v.access.premium;
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length &&
    actual.every((k, i) => k === [...keys].sort()[i])
  );
}

async function runScenario(
  seed: number,
  scenario: Scenario,
): Promise<StressRow> {
  const start = Date.now();
  const failures: string[] = [];
  const expectation = expectationFor(scenario);
  const unauthorizedCalls: unknown[] = [];
  const fetchCalls: Array<{ url: unknown; method: unknown; auth: unknown }> =
    [];

  clearApiSession();
  setApiUnauthorizedListener(() => {
    unauthorizedCalls.push(true);
  });
  if (scenario.session !== 'none') {
    const bearer =
      scenario.session === 'matching'
        ? trimmed(scenario.token) || 'tok-fallback'
        : 'tok-other';
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: bearer,
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
    });
  }

  const fetchFn = jest.fn((input: unknown, init?: unknown) => {
    const headers = (
      init as
        { headers?: Record<string, unknown>; method?: unknown } | undefined
    )?.headers;
    fetchCalls.push({
      url: input,
      method: (init as { method?: unknown } | undefined)?.method,
      auth: headers?.['Authorization'],
    });
    const t = scenario.transport;
    if (t.mode === 'throw_sync')
      throw new TypeError('fetch exploded synchronously');
    if (t.mode === 'reject') return Promise.reject(t.reason);
    if (t.mode === 'hang_then_respond') {
      return new Promise<Response>(res =>
        setTimeout(() => res(makeResponse(t.status, t.body)), 1),
      );
    }
    return Promise.resolve(makeResponse(t.status, t.body));
  });

  const client = createCanonicalAccessClient({
    baseUrl: scenario.baseUrl,
    token: scenario.token,
    fetchFn: fetchFn as unknown as typeof fetch,
  });

  let outcome: 'resolved' | 'rejected' = 'resolved';
  let result: unknown;
  let error: unknown;
  try {
    result =
      scenario.op === 'access'
        ? await client.getAccess()
        : await client.syncBilling();
  } catch (caught) {
    outcome = 'rejected';
    error = caught;
  }

  // ── transport invariants ─────────────────────────────────────────────────
  if (expectation.expectFetch) {
    if (fetchCalls.length !== 1)
      failures.push(`fetch_count: expected 1 call, saw ${fetchCalls.length}`);
    const call = fetchCalls[0];
    if (call) {
      if (call.url !== expectation.expectedUrl)
        failures.push(`fetch_url: ${String(call.url).slice(0, 80)}`);
      if (call.method !== (scenario.op === 'access' ? 'GET' : 'POST'))
        failures.push(`fetch_method: ${String(call.method)}`);
      if (call.auth !== expectation.expectedAuth)
        failures.push('fetch_auth: bearer header mismatch');
    }
  } else if (fetchCalls.length !== 0) {
    failures.push(
      `fetch_when_unconfigured: ${fetchCalls.length} call(s) despite ${expectation.reason}`,
    );
  }
  if (unauthorizedCalls.length !== (expectation.expectUnauthorized ? 1 : 0)) {
    failures.push(
      `unauthorized_listener: expected ${expectation.expectUnauthorized ? 1 : 0}, saw ${unauthorizedCalls.length}`,
    );
  }

  // ── outcome invariants ───────────────────────────────────────────────────
  if (outcome === 'rejected') {
    if (!isTypedBillingError(error)) {
      failures.push(`untyped_throw: ${describeError(error)}`);
    } else {
      if (!expectation.configured) {
        if (
          error.code !== 'billing.backend_unconfigured' ||
          error.unconfiguredReason !== expectation.reason
        ) {
          failures.push(
            `wrong_unconfigured: ${error.code}/${String(error.unconfiguredReason)} expected ${expectation.reason}`,
          );
        }
      } else {
        const t = scenario.transport;
        const responded =
          t.mode === 'respond' || t.mode === 'hang_then_respond';
        if (!responded) {
          if (
            error.code !== 'billing.backend_unavailable' ||
            error.retryable !== true
          ) {
            failures.push(
              `wrong_network_error: ${error.code} retryable=${error.retryable}`,
            );
          }
        } else {
          const ok = t.status >= 200 && t.status <= 299;
          if (t.status === 401) {
            if (
              error.code !== 'billing.backend_unavailable' ||
              error.retryable !== false
            )
              failures.push(
                `wrong_401: ${error.code} retryable=${error.retryable}`,
              );
          } else if (!ok) {
            const expectRetry = t.status >= 500 || t.status === 429;
            if (
              error.code !== 'billing.backend_unavailable' ||
              error.retryable !== expectRetry
            )
              failures.push(
                `wrong_http_error: status=${t.status} ${error.code} retryable=${error.retryable}`,
              );
          } else if (
            error.code !== 'billing.backend_invalid_response' ||
            error.retryable !== true
          ) {
            failures.push(
              `wrong_body_error: ${error.code} retryable=${error.retryable}`,
            );
          }
        }
        if (
          /\b(at |TypeError|SyntaxError|Unexpected token|stack)\b/.test(
            error.message,
          )
        ) {
          failures.push(
            'leaky_message: internal detail in user-facing message',
          );
        }
      }
    }
  } else {
    // Accepted → must be configured, ok status, and a coherent, exactly-shaped copy.
    const t = scenario.transport;
    const responded = t.mode === 'respond' || t.mode === 'hang_then_respond';
    if (
      !expectation.configured ||
      !responded ||
      !(t.status >= 200 && t.status <= 299)
    ) {
      failures.push('accepted_without_ok_response');
    } else if (t.body.kind !== 'value' && t.body.kind !== 'text') {
      failures.push(`accepted_broken_body: ${t.body.kind}`);
    } else {
      let parsed: unknown;
      let parseable = true;
      if (t.body.kind === 'value') parsed = t.body.value;
      else {
        try {
          parsed = JSON.parse(t.body.text);
        } catch {
          parseable = false;
        }
      }
      if (!parseable) failures.push('accepted_unparseable_text');
      else if (scenario.op === 'access') {
        if (!isCoherentAccess(parsed))
          failures.push(
            `accepted_incoherent_access: ${JSON.stringify(summarize(parsed)).slice(0, 200)}`,
          );
        if (!isCoherentAccess(result))
          failures.push('returned_incoherent_access');
        if (
          !exactKeys(result, [
            'premium',
            'entitlements',
            'freeRatings',
            'canStartRating',
            'paywallRequired',
          ])
        )
          failures.push('access_extra_keys');
        if (
          !exactKeys((result as { freeRatings?: unknown }).freeRatings, [
            'limit',
            'used',
            'reserved',
            'remaining',
            'availableToReserve',
          ])
        )
          failures.push('freeRatings_extra_keys');
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          (result as { entitlements?: unknown }).entitlements ===
            (parsed as { entitlements?: unknown }).entitlements
        )
          failures.push('shared_entitlements_reference');
        if (Object.getPrototypeOf(result) !== Object.prototype)
          failures.push('access_prototype_not_plain');
      } else {
        const p = parsed as { access?: unknown; billing?: unknown } | null;
        const r = result as { access?: unknown; billing?: unknown };
        if (!isCoherentSync(p)) failures.push('accepted_incoherent_sync');
        if (!isCoherentAccess(r.access) || !isCoherentBilling(r.billing))
          failures.push('returned_incoherent_sync');
        if (!exactKeys(result, ['access', 'billing']))
          failures.push('sync_extra_keys');
        if (
          !exactKeys(r.billing, [
            'premium',
            'productKey',
            'expiresAt',
            'verifiedAt',
          ])
        )
          failures.push('billing_extra_keys');
        if (
          Object.getPrototypeOf(result) !== Object.prototype ||
          Object.getPrototypeOf(r.billing) !== Object.prototype
        )
          failures.push('sync_prototype_not_plain');
      }
    }
  }

  // Coherent, parseable, ok payloads must never be rejected as invalid.
  if (
    outcome === 'rejected' &&
    isTypedBillingError(error) &&
    error.code === 'billing.backend_invalid_response'
  ) {
    const t = scenario.transport;
    if (
      (t.mode === 'respond' || t.mode === 'hang_then_respond') &&
      t.body.kind === 'value'
    ) {
      const coherent =
        scenario.op === 'access'
          ? isCoherentAccess(t.body.value)
          : isCoherentSync(t.body.value);
      if (coherent) failures.push('rejected_coherent_payload');
    }
  }

  const pollution = pollutionProbe();
  if (pollution) failures.push(`prototype_pollution: ${pollution}`);
  const wallMs = Date.now() - start;
  if (wallMs > 2000) failures.push(`slow: ${wallMs}ms`);

  clearApiSession();
  setApiUnauthorizedListener(null);

  return {
    seed,
    scenario: `${scenario.op}/${scenario.transport.mode}${'status' in scenario.transport ? `:${String(scenario.transport.status)}` : ''}${'body' in scenario.transport ? `/${scenario.transport.body.kind}` : ''}`,
    outcome: failures.length === 0 ? 'held' : 'broken',
    failures,
    wallMs,
    detail: {
      baseUrl: summarize(scenario.baseUrl),
      token: summarize(scenario.token),
      session: scenario.session,
      transport: summarize(scenario.transport),
      result:
        outcome === 'resolved'
          ? summarize(result)
          : { error: describeError(error) },
      replay: replayCommand(SUITE_FILE, seed),
    },
  };
}

describe('stress/boundary-malformed: backend access client', () => {
  const config = stressConfig(120);
  const seeds = seedsFor(config);

  afterEach(() => {
    clearApiSession();
    setApiUnauthorizedListener(null);
  });

  it(`holds the BillingError contract across ${seeds.length} generated transport/body shapes`, async () => {
    const rows: StressRow[] = [];
    const uniqueScenarios = new Set<string>();
    for (const seed of seeds) {
      const scenario = generate(seed);
      uniqueScenarios.add(JSON.stringify(summarize(scenario)));
      rows.push(await runScenario(seed, scenario));
    }
    const { summaryPath, tablePath } = writeTable(
      config,
      'billingAccessApiFuzz',
      rows,
      {
        uniqueScenarios: uniqueScenarios.size,
      },
    );
    const broken = rows.filter(r => r.outcome === 'broken');
    expect(pollutionProbe()).toBeNull();
    expect({
      executed: rows.length,
      broken: broken.slice(0, 10).map(r => ({
        seed: r.seed,
        failures: r.failures,
        replay: r.detail['replay'],
      })),
      summaryPath,
      tablePath,
    }).toEqual({ executed: seeds.length, broken: [], summaryPath, tablePath });
  }, 600_000);
});
