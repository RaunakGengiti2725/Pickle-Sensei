/**
 * STRESS SUITE — unit `mod-bootstrap-api-session`, lens `boundary-malformed`.
 *
 * Targets (real modules, nothing mocked but `fetch`):
 *   - `src/account/bootstrap.ts`  normalizeApiBaseUrl / bootstrapCanonicalAccount
 *   - `src/account/apiSession.ts` establish / clear / bearerTokenFor /
 *                                 reportApiUnauthorized / subscribe
 *
 * Five seeded campaigns (`Rng(campaignSalt ^ i)`), each iteration replayable:
 *   A  normalizeApiBaseUrl over generated URL spellings + wrong runtime types
 *   B  /v1/account/bootstrap JSON payload mutations × HTTP status codes
 *   C  bootstrapCanonicalAccount input shapes × fetch behaviours
 *   D  apiSession op sequences checked against a reference model
 *   E  byte-level corruption of real JSON bodies through a REAL `Response`
 *
 * Invariants asserted on every iteration (BROKEN → the campaign fails):
 *   - never a throw that is not `AccountBootstrapError` out of bootstrap for
 *     in-contract input types; never a success the reference oracle rejects
 *     (and vice versa); error `code`/`retryable` follow the documented map;
 *     the request goes out exactly once with the documented shape; the store
 *     never disagrees with the model; `Object.prototype` is never polluted.
 *
 * Known boundary weaknesses are counted as OBSERVATION rows (they do not fail
 * the campaign) and pinned by the `it.failing` reproductions at the bottom,
 * which turn red the moment the behaviour is fixed — flip them to `it` then.
 *
 * Knobs:
 *   STRESS_ITER=<n>   iterations per campaign (default 200 → ~1 s; the
 *                     reported campaign used 2500)
 *   STRESS_SEED=<i>   replay only iteration i of every campaign
 *   STRESS_OUT=<path> write the seed → outcome JSON table there
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
  normalizeApiBaseUrl,
  type AccountBootstrapInput,
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
  Rng,
  alnum,
  corruptText,
  describeError,
  hostileString,
  hostileValue,
  hugeString,
  isTypeError,
  mutatePayload,
  NORMALIZATION_PAIRS,
  oracleAccount,
  oracleBaseUrl,
  oracleSession,
  PAYLOAD_STRATEGIES,
  randomJson,
  render,
  summarize,
  TEXT_CORRUPTIONS,
  urlVariant,
  validPayload,
  validUuidV4,
  type CampaignSummary,
  type Row,
} from '../../test-support/stress/boundaryMalformed';

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 200));
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT = process.env.STRESS_OUT;

const SALT = {
  A: 0x0a11_0001,
  B: 0x0b11_0002,
  C: 0x0c11_0003,
  D: 0x0d11_0004,
  E: 0x0e11_0005,
} as const;

const BASE_URL = 'https://api.pickle.example';
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

const allRows: Row[] = [];
const summaries: CampaignSummary[] = [];

function iterations(): number[] {
  if (ONLY_SEED !== null) return [ONLY_SEED];
  return Array.from({ length: ITER }, (_v, i) => i);
}

function finish(campaign: string, rows: Row[]): CampaignSummary {
  const summary = summarize(rows, campaign);
  allRows.push(...rows);
  summaries.push(summary);
  return summary;
}

function expectNoBroken(summary: CampaignSummary): void {
  // Print the minimized replay for any BROKEN class before failing.
  const broken = Object.keys(summary.broken);
  expect(broken.map(kind => ({ kind, ...summary.minimized[kind] }))).toEqual(
    [],
  );
  expect(summary.iterations).toBe(iterations().length);
}

function mockResponse(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const CONTROL_OR_FORMAT =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/;

function prototypeClean(): boolean {
  const probe = {} as { polluted?: unknown };
  return (
    probe.polluted === undefined &&
    !('polluted' in Object.prototype) &&
    !('polluted' in Array.prototype)
  );
}

afterAll(() => {
  if (!OUT) return;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        unit: 'mod-bootstrap-api-session',
        lens: 'boundary-malformed',
        iterationsPerCampaign: ITER,
        onlySeed: ONLY_SEED,
        totalIterations: allRows.length,
        summaries,
        rows: allRows,
      },
      null,
      1,
    ),
  );
});

// ─── A: normalizeApiBaseUrl ──────────────────────────────────────────────────

describe('A · normalizeApiBaseUrl over generated URL spellings', () => {
  it('accepts exactly what the documented rule accepts and never throws untyped for in-contract input', () => {
    const rows: Row[] = [];
    for (const i of iterations()) {
      const rng = new Rng(SALT.A ^ i);
      const input = urlVariant(rng);
      const oracle = oracleBaseUrl(input);
      const detail = render(input);
      let row: Row = { campaign: 'A', seed: i, outcome: 'HELD', kind: 'ok' };
      try {
        const first = normalizeApiBaseUrl(input as string);
        const second = normalizeApiBaseUrl(input as string);
        if (!oracle.accepted) {
          row = {
            ...row,
            outcome: 'BROKEN',
            kind: 'accepted-but-oracle-rejects',
            detail,
          };
        } else if (first !== second) {
          row = { ...row, outcome: 'BROKEN', kind: 'nondeterministic', detail };
        } else if (/\/$/.test(first)) {
          row = {
            ...row,
            outcome: 'BROKEN',
            kind: 'trailing-slash-kept',
            detail,
          };
        } else {
          // The base is accepted; does the request the module will build make sense?
          let request: URL | null = null;
          try {
            request = new URL(`${first}/v1/account/bootstrap`);
          } catch {
            request = null;
          }
          if (request === null) {
            row = {
              ...row,
              outcome: 'OBSERVATION',
              kind: 'accepted-base-yields-unparseable-request-url',
              detail,
            };
          } else if (
            request.origin !== oracle.origin ||
            request.pathname !== '/v1/account/bootstrap' ||
            request.search !== '' ||
            request.hash !== '' ||
            /[\t\n\r ]/.test(first) ||
            request.username !== '' ||
            request.password !== ''
          ) {
            row = {
              ...row,
              outcome: 'OBSERVATION',
              kind: 'uncanonical-base-url-accepted',
              detail: `${detail} → request ${render(request.href, 160)}`,
            };
          }
        }
      } catch (error) {
        if (error instanceof AccountBootstrapError) {
          if (oracle.accepted) {
            row = {
              ...row,
              outcome: 'BROKEN',
              kind: 'rejected-but-oracle-accepts',
              detail: `${detail} → ${describeError(error)}`,
            };
          } else if (
            error.code !== 'account.not_configured' ||
            error.retryable
          ) {
            row = {
              ...row,
              outcome: 'BROKEN',
              kind: 'wrong-error-shape',
              detail: `${detail} → ${describeError(error)}`,
            };
          } else {
            row.kind = 'typed-reject';
          }
        } else if (
          typeof input !== 'string' &&
          input !== null &&
          input !== undefined &&
          isTypeError(error)
        ) {
          row = {
            ...row,
            outcome: 'OBSERVATION',
            kind: 'raw-typeerror-on-non-string-input',
            detail: `${detail} → ${describeError(error)}`,
          };
        } else {
          row = {
            ...row,
            outcome: 'BROKEN',
            kind: 'raw-throw',
            detail: `${detail} → ${describeError(error)}`,
          };
        }
      }
      rows.push(row);
    }
    expectNoBroken(finish('A', rows));
  });
});

// ─── B: response payload mutations × status codes ────────────────────────────

const STATUS_POOL = [
  200, 200, 200, 200, 200, 200, 201, 202, 204, 206, 299, 0, 100, 101, 199, 300,
  301, 302, 304, 399, 400, 401, 401, 403, 403, 404, 405, 408, 409, 410, 412,
  413, 415, 418, 422, 425, 429, 429, 431, 451, 499, 500, 500, 501, 502, 503,
  504, 507, 511, 599, 600, 999,
];

function serverMessageOracle(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const root = payload as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(root, 'error')) return null;
  const error = root['error'];
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const message = (error as Record<string, unknown>)['message'];
  return typeof message === 'string' && message.trim() ? message : null;
}

async function runBootstrap(
  fetchFn: AccountBootstrapInput['fetchFn'],
  overrides: Partial<AccountBootstrapInput> = {},
): Promise<
  | {
      kind: 'resolved';
      value: Awaited<ReturnType<typeof bootstrapCanonicalAccount>>;
    }
  | { kind: 'rejected'; error: unknown }
> {
  try {
    const value = await bootstrapCanonicalAccount({
      apiBaseUrl: BASE_URL,
      bearerToken: 'provider-issued-jwt',
      provider: 'apple',
      environment: ENVIRONMENT,
      fetchFn,
      ...overrides,
    });
    return { kind: 'resolved', value };
  } catch (error) {
    return { kind: 'rejected', error };
  }
}

/**
 * Shared verdict for campaigns B and E: given the payload the body decodes to
 * (or `parseFailed`), the status, and what the module did.
 */
function judgeBootstrapOutcome(
  row: Row,
  args: {
    payload: unknown;
    parseFailed: boolean;
    status: number;
    bearer: string;
    calls: number;
    outcome: Awaited<ReturnType<typeof runBootstrap>>;
    detail: string;
  },
): Row {
  const { payload, parseFailed, status, bearer, calls, outcome, detail } = args;
  const ok = status >= 200 && status < 300;
  if (!prototypeClean()) {
    return { ...row, outcome: 'BROKEN', kind: 'prototype-polluted', detail };
  }
  if (calls !== 1) {
    return {
      ...row,
      outcome: 'BROKEN',
      kind: `fetch-called-${calls}x`,
      detail,
    };
  }
  if (outcome.kind === 'rejected') {
    const error = outcome.error;
    if (!(error instanceof AccountBootstrapError)) {
      return {
        ...row,
        outcome: 'BROKEN',
        kind: 'raw-throw',
        detail: `${detail} → ${describeError(error)}`,
      };
    }
    let expectedCode: AccountBootstrapError['code'];
    let expectedRetryable: boolean;
    let expectedMessage: string | null = null;
    if (parseFailed) {
      expectedCode = 'account.invalid_response';
      expectedRetryable = true;
    } else if (!ok) {
      expectedMessage = serverMessageOracle(payload);
      if (status === 401 || status === 403) {
        expectedCode = 'account.rejected';
        expectedRetryable = false;
      } else {
        expectedCode = 'account.unavailable';
        expectedRetryable = status >= 500 || status === 429;
      }
    } else if (oracleAccount(payload) === null) {
      expectedCode = 'account.invalid_response';
      expectedRetryable = true;
    } else {
      return {
        ...row,
        outcome: 'BROKEN',
        kind: 'rejected-but-oracle-accepts',
        detail: `${detail} → ${describeError(error)}`,
      };
    }
    if (error.code !== expectedCode || error.retryable !== expectedRetryable) {
      return {
        ...row,
        outcome: 'BROKEN',
        kind: 'wrong-error-map',
        detail: `${detail} → ${describeError(error)} expected ${expectedCode}/${expectedRetryable}`,
      };
    }
    if (typeof error.message !== 'string' || error.message.trim() === '') {
      return { ...row, outcome: 'BROKEN', kind: 'empty-message', detail };
    }
    if (expectedMessage !== null && error.message !== expectedMessage) {
      return {
        ...row,
        outcome: 'BROKEN',
        kind: 'server-message-not-surfaced',
        detail,
      };
    }
    if (
      expectedMessage !== null &&
      (expectedMessage.length > 1024 || CONTROL_OR_FORMAT.test(expectedMessage))
    ) {
      return {
        ...row,
        outcome: 'OBSERVATION',
        kind: 'unbounded-server-message-surfaced',
        detail: `${detail} → message ${expectedMessage.length} chars`,
      };
    }
    return { ...row, kind: `typed-${error.code}` };
  }

  // Resolved.
  const value = outcome.value;
  if (parseFailed || !ok) {
    return {
      ...row,
      outcome: 'BROKEN',
      kind: 'resolved-on-failure',
      detail,
    };
  }
  const account = oracleAccount(payload);
  if (!account) {
    return {
      ...row,
      outcome: 'BROKEN',
      kind: 'accepted-but-oracle-rejects',
      detail: `${detail} → ${render(value.account)}`,
    };
  }
  const session = oracleSession(payload);
  const expectedApiSession: ApiSession = {
    apiBaseUrl: BASE_URL,
    bearerToken: session ? session.accessToken : bearer,
    canonicalAppUserId: account.id,
    provider: 'apple',
    refreshToken: session ? session.refreshToken : null,
    bearerExpiresAtMs: session ? session.expiresAt * 1000 : null,
  };
  const accountMatches =
    value.account.id === account.id &&
    value.account.email === account.email &&
    value.account.onboardingState === account.onboardingState &&
    Object.keys(value.account).length === 3;
  const sessionMatches =
    value.apiSession.apiBaseUrl === expectedApiSession.apiBaseUrl &&
    value.apiSession.bearerToken === expectedApiSession.bearerToken &&
    value.apiSession.canonicalAppUserId ===
      expectedApiSession.canonicalAppUserId &&
    value.apiSession.provider === expectedApiSession.provider &&
    value.apiSession.refreshToken === expectedApiSession.refreshToken &&
    Object.is(
      value.apiSession.bearerExpiresAtMs,
      expectedApiSession.bearerExpiresAtMs,
    );
  if (!accountMatches || !sessionMatches) {
    return {
      ...row,
      outcome: 'BROKEN',
      kind: 'result-mismatch',
      detail: `${detail} → got ${render(value)} expected ${render({ account, apiSession: expectedApiSession })}`,
    };
  }
  if (
    value.apiSession.bearerExpiresAtMs !== null &&
    value.apiSession.bearerExpiresAtMs !== undefined &&
    !Number.isFinite(value.apiSession.bearerExpiresAtMs)
  ) {
    return {
      ...row,
      outcome: 'OBSERVATION',
      kind: 'bearerExpiresAtMs-nonfinite',
      detail: `${detail} → bearerExpiresAtMs=${String(value.apiSession.bearerExpiresAtMs)}`,
    };
  }
  return {
    ...row,
    kind: session ? 'accepted-with-session' : 'accepted-legacy',
  };
}

describe('B · bootstrap response payload mutations × status codes', () => {
  it('maps every payload/status pair exactly as the contract says', async () => {
    const rows: Row[] = [];
    for (const i of iterations()) {
      const rng = new Rng(SALT.B ^ i);
      const strategy = rng.pick(PAYLOAD_STRATEGIES);
      const payload = mutatePayload(rng, strategy);
      const status = rng.chance(0.7) ? 200 : rng.pick(STATUS_POOL);
      const bearer = `pt.${alnum(rng, 24)}`;
      let calls = 0;
      const fetchFn = jest.fn(async () => {
        calls += 1;
        return mockResponse(payload, status);
      });
      const outcome = await runBootstrap(fetchFn, { bearerToken: bearer });
      rows.push(
        judgeBootstrapOutcome(
          { campaign: 'B', seed: i, outcome: 'HELD', kind: strategy },
          {
            payload,
            parseFailed: false,
            status,
            bearer,
            calls,
            outcome,
            detail: `[${strategy} status=${status}] ${render(payload)}`,
          },
        ),
      );
    }
    expectNoBroken(finish('B', rows));
  });
});

// ─── C: bootstrap input shapes × fetch behaviours ────────────────────────────

type FetchBehaviour =
  | 'resolve-valid'
  | 'reject-network-typeerror'
  | 'reject-abort'
  | 'reject-string'
  | 'reject-undefined'
  | 'throw-sync'
  | 'resolve-undefined'
  | 'resolve-null'
  | 'resolve-empty-object'
  | 'resolve-json-not-function'
  | 'resolve-json-throws-sync'
  | 'resolve-json-rejects-null'
  | 'strict-request-then-valid';

const FETCH_BEHAVIOURS: readonly FetchBehaviour[] = [
  'resolve-valid',
  'resolve-valid',
  'resolve-valid',
  'reject-network-typeerror',
  'reject-abort',
  'reject-string',
  'reject-undefined',
  'throw-sync',
  'resolve-undefined',
  'resolve-null',
  'resolve-empty-object',
  'resolve-json-not-function',
  'resolve-json-throws-sync',
  'resolve-json-rejects-null',
  'strict-request-then-valid',
  'strict-request-then-valid',
];

function environmentVariant(rng: Rng): unknown {
  switch (rng.int(0, 11)) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return {};
    case 3:
      return { ...ENVIRONMENT, device: {} };
    case 4:
      return {
        ...ENVIRONMENT,
        device: { ...ENVIRONMENT.device, appVersion: hostileValue(rng) },
      };
    case 5: {
      const cyclic: { [k: string]: unknown } = { ...ENVIRONMENT };
      cyclic['self'] = cyclic;
      return cyclic;
    }
    case 6:
      return { ...ENVIRONMENT, big: 10n ** 30n };
    case 7:
      return {
        ...ENVIRONMENT,
        toJSON() {
          throw new Error('toJSON exploded');
        },
      };
    case 8:
      return { ...ENVIRONMENT, locale: hugeString(rng) };
    case 9:
      return JSON.parse(
        `{"__proto__":{"admin":true},"locale":"en","timezone":"UTC","device":${JSON.stringify(ENVIRONMENT.device)}}`,
      );
    case 10:
      return { ...ENVIRONMENT, [alnum(rng, 6)]: randomJson(rng) };
    default:
      return hostileValue(rng);
  }
}

function environmentBreaksRequestBuild(environment: unknown): boolean {
  try {
    // Mirrors the two evaluations the module performs while building the request.
    const device = (environment as { device?: { appVersion?: unknown } })
      .device;
    void (device as { appVersion?: unknown }).appVersion;
    JSON.stringify({ ...(environment as object) });
    return false;
  } catch {
    return true;
  }
}

describe('C · bootstrap input shapes × fetch behaviours', () => {
  // Fake timers make the module's 15 s abort timer observable: a leaked one
  // (armed, never cleared) shows up in `jest.getTimerCount()`.
  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
  });
  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('validates configuration and token before any request and maps every fetch failure to a typed error', async () => {
    const rows: Row[] = [];
    for (const i of iterations()) {
      jest.clearAllTimers();
      const rng = new Rng(SALT.C ^ i);
      const apiBaseUrl = rng.chance(0.8) ? BASE_URL : urlVariant(rng);
      const bearerToken: unknown = rng.chance(0.5)
        ? `${alnum(rng, 8)}.${alnum(rng, 40)}.${alnum(rng, 43)}`
        : rng.chance(0.6)
          ? hostileString(rng)
          : rng.chance(0.5)
            ? rng.pick([null, undefined])
            : hostileValue(rng);
      const provider: unknown = rng.chance(0.9)
        ? rng.pick(['apple', 'google'])
        : hostileValue(rng);
      const appleAuthorizationCode: unknown = rng.chance(0.4)
        ? undefined
        : rng.chance(0.3)
          ? null
          : rng.chance(0.6)
            ? rng.chance(0.5)
              ? `  ${alnum(rng, 16)}  `
              : hostileString(rng)
            : hostileValue(rng);
      const environment: unknown = rng.chance(0.7)
        ? ENVIRONMENT
        : environmentVariant(rng);
      const behaviour = rng.pick(FETCH_BEHAVIOURS);
      const payload = validPayload(rng);

      let calls = 0;
      let captured: { url: unknown; init: RequestInit | undefined } | null =
        null;
      let strictThrew: string | null = null;
      const fetchFn = jest.fn((url: string, init?: RequestInit) => {
        calls += 1;
        captured = { url, init };
        switch (behaviour) {
          case 'resolve-valid':
            return Promise.resolve(mockResponse(payload, 200));
          case 'reject-network-typeerror':
            return Promise.reject(new TypeError('Network request failed'));
          case 'reject-abort': {
            const abort = new Error('Aborted');
            abort.name = 'AbortError';
            return Promise.reject(abort);
          }
          case 'reject-string':
            return Promise.reject('offline');
          case 'reject-undefined':
            return Promise.reject(undefined);
          case 'throw-sync':
            throw new RangeError('sync explosion');
          case 'resolve-undefined':
            return Promise.resolve(undefined as unknown as Response);
          case 'resolve-null':
            return Promise.resolve(null as unknown as Response);
          case 'resolve-empty-object':
            return Promise.resolve({} as Response);
          case 'resolve-json-not-function':
            return Promise.resolve({
              ok: true,
              status: 200,
              json: 'nope',
            } as unknown as Response);
          case 'resolve-json-throws-sync':
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => {
                throw new SyntaxError('Unexpected token');
              },
            } as unknown as Response);
          case 'resolve-json-rejects-null':
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.reject(null),
            } as unknown as Response);
          case 'strict-request-then-valid':
            try {
              // WHATWG validation of URL + header names/values, as a spec fetch would do.
              void new Request(url, init);
            } catch (error) {
              strictThrew = describeError(error);
              return Promise.reject(error);
            }
            return Promise.resolve(mockResponse(payload, 200));
          default:
            return Promise.resolve(mockResponse(payload, 200));
        }
      });

      const detail = render({
        apiBaseUrl,
        bearerToken,
        provider,
        appleAuthorizationCode,
        environment: environment === ENVIRONMENT ? '<valid>' : environment,
        behaviour,
      });
      const outcome = await runBootstrap(fetchFn, {
        apiBaseUrl: apiBaseUrl as string,
        bearerToken: bearerToken as string,
        provider: provider as 'apple',
        appleAuthorizationCode: appleAuthorizationCode as string,
        environment: environment as AccountBootstrapInput['environment'],
      });

      let row: Row = {
        campaign: 'C',
        seed: i,
        outcome: 'HELD',
        kind: behaviour,
      };
      const urlOracle = oracleBaseUrl(apiBaseUrl);
      const nonStringUrl =
        typeof apiBaseUrl !== 'string' &&
        apiBaseUrl !== null &&
        apiBaseUrl !== undefined;
      const nonStringBearer =
        typeof bearerToken !== 'string' &&
        bearerToken !== null &&
        bearerToken !== undefined;
      const bearerBlank =
        typeof bearerToken !== 'string' || bearerToken.trim() === '';
      const nonStringCode =
        typeof appleAuthorizationCode !== 'string' &&
        appleAuthorizationCode !== null &&
        appleAuthorizationCode !== undefined;

      const typed =
        outcome.kind === 'rejected' &&
        outcome.error instanceof AccountBootstrapError
          ? outcome.error
          : null;
      const rawError =
        outcome.kind === 'rejected' && !typed ? outcome.error : null;

      const leakedTimers = jest.getTimerCount();
      const rawTypeErrorObservation = (why: string): Row => ({
        ...row,
        outcome: 'OBSERVATION',
        kind: `raw-typeerror-on-non-string-${why}${leakedTimers > 0 ? '+leaked-abort-timer' : ''}`,
        detail: `${detail} → ${describeError(rawError)} (timers left armed: ${leakedTimers})`,
      });
      const broken = (kind: string): Row => ({
        ...row,
        outcome: 'BROKEN',
        kind,
        detail: `${detail} → ${
          outcome.kind === 'rejected'
            ? describeError(outcome.error)
            : render(outcome.value)
        } (fetch calls=${calls}, strict=${strictThrew ?? '-'})`,
      });

      if (!prototypeClean()) {
        row = broken('prototype-polluted');
      } else if (nonStringUrl) {
        row =
          isTypeError(rawError) && calls === 0
            ? rawTypeErrorObservation('apiBaseUrl')
            : typed?.code === 'account.not_configured' && calls === 0
              ? { ...row, kind: 'typed-not_configured' }
              : broken('non-string-apiBaseUrl-unexpected');
      } else if (!urlOracle.accepted) {
        row =
          typed?.code === 'account.not_configured' &&
          !typed.retryable &&
          calls === 0
            ? { ...row, kind: 'typed-not_configured' }
            : broken('bad-url-not-refused-first');
      } else if (nonStringBearer) {
        row =
          isTypeError(rawError) && calls === 0
            ? rawTypeErrorObservation('bearerToken')
            : typed?.code === 'account.invalid_token' && calls === 0
              ? { ...row, kind: 'typed-invalid_token' }
              : broken('non-string-bearer-unexpected');
      } else if (bearerBlank) {
        row =
          typed?.code === 'account.invalid_token' &&
          !typed.retryable &&
          calls === 0
            ? { ...row, kind: 'typed-invalid_token' }
            : broken('blank-bearer-not-refused');
      } else if (nonStringCode) {
        row =
          isTypeError(rawError) && calls === 0
            ? rawTypeErrorObservation('appleAuthorizationCode')
            : typed && calls === 0
              ? { ...row, kind: `typed-${typed.code}` }
              : broken('non-string-code-unexpected');
      } else if (environmentBreaksRequestBuild(environment)) {
        // The request can not even be built: the module must still fail typed.
        row =
          typed?.code === 'account.unavailable' && calls === 0
            ? { ...row, kind: 'typed-unavailable-env-unserializable' }
            : broken('env-break-unexpected');
      } else if (rawError !== null) {
        row = broken('raw-throw');
      } else if (calls !== 1) {
        row = broken(`fetch-called-${calls}x`);
      } else if (leakedTimers > 0) {
        row = broken('abort-timer-leaked-after-request');
      } else {
        // Request shape.
        const init = (captured as { init: RequestInit | undefined } | null)
          ?.init;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const trimmedBearer = (bearerToken as string).trim();
        const trimmedCode =
          typeof appleAuthorizationCode === 'string'
            ? appleAuthorizationCode.trim()
            : '';
        const sendsCode = provider === 'apple' && trimmedCode !== '';
        const expectedBody = JSON.parse(
          JSON.stringify({
            ...(environment as object),
            ...(sendsCode ? { appleAuthorizationCode: trimmedCode } : {}),
          }),
        );
        let bodyMatches = false;
        try {
          expect(JSON.parse(String(init?.body))).toEqual(expectedBody);
          bodyMatches = true;
        } catch {
          bodyMatches = false;
        }
        const requestOk =
          (captured as { url: unknown } | null)?.url ===
            `${normalizeApiBaseUrl(apiBaseUrl as string)}/v1/account/bootstrap` &&
          init?.method === 'POST' &&
          headers['Authorization'] === `Bearer ${trimmedBearer}` &&
          headers['Content-Type'] === 'application/json' &&
          headers['Accept'] === 'application/json' &&
          headers['X-Client-Version'] ===
            (environment as typeof ENVIRONMENT).device.appVersion &&
          (headers['X-Apple-Revocation-Protocol'] === '1') === sendsCode &&
          Boolean(init?.signal) &&
          bodyMatches;
        if (!requestOk) {
          row = broken('request-shape');
        } else if (
          behaviour === 'resolve-valid' ||
          (behaviour === 'strict-request-then-valid' && strictThrew === null)
        ) {
          row =
            outcome.kind === 'resolved' &&
            outcome.value.account.id === payload.user.id &&
            outcome.value.apiSession.bearerToken ===
              (payload.session?.accessToken ?? trimmedBearer)
              ? { ...row, kind: 'accepted' }
              : broken('valid-response-not-accepted');
        } else if (behaviour === 'strict-request-then-valid') {
          // A spec fetch refused the header/URL material → module reports unavailable.
          row =
            typed?.code === 'account.unavailable' && typed.retryable
              ? {
                  ...row,
                  outcome: 'OBSERVATION',
                  kind: 'header-unsafe-bearer-forwarded-as-unavailable',
                  detail: `${detail} → strict fetch: ${strictThrew}`,
                }
              : broken('strict-reject-unexpected');
        } else if (
          behaviour.startsWith('reject') ||
          behaviour === 'throw-sync'
        ) {
          row =
            typed?.code === 'account.unavailable' && typed.retryable
              ? { ...row, kind: 'typed-unavailable' }
              : broken('fetch-failure-map');
        } else {
          row =
            typed?.code === 'account.invalid_response' && typed.retryable
              ? { ...row, kind: 'typed-invalid_response' }
              : broken('unreadable-response-map');
        }
      }
      rows.push(row);
    }
    expectNoBroken(finish('C', rows));
  });
});

// ─── D: apiSession op sequences vs a reference model ─────────────────────────

type Op =
  | { op: 'establish'; session: ApiSession }
  | { op: 'clear' }
  | { op: 'bearerFor'; id: unknown }
  | { op: 'report'; token: unknown }
  | { op: 'subscribe'; throws: boolean }
  | { op: 'unsubscribe'; index: number }
  | { op: 'setListener'; mode: 'record' | 'throw' | 'null' };

function idPool(rng: Rng): unknown[] {
  const u = validUuidV4(rng);
  const pair = rng.pick(NORMALIZATION_PAIRS);
  return [
    u,
    u.toUpperCase(),
    validUuidV4(rng),
    `${pair[0]}-${u}`,
    `${pair[1]}-${u}`,
    '',
    '\u0000',
    `${u}\u0000`,
    ` ${u}`,
    hostileString(rng),
    hostileValue(rng),
  ];
}

function tokenPool(rng: Rng): unknown[] {
  const t = `at.${alnum(rng, 30)}`;
  const pair = rng.pick(NORMALIZATION_PAIRS);
  return [
    t,
    `${t} `,
    `${t}\n`,
    t.toUpperCase(),
    `at.${alnum(rng, 30)}`,
    '',
    pair[0],
    pair[1],
    rng.chance(0.2) ? hugeString(rng) : hostileString(rng),
    hostileValue(rng),
  ];
}

describe('D · apiSession op sequences against a reference model', () => {
  afterEach(() => {
    clearApiSession();
    setApiUnauthorizedListener(null);
  });

  it('never disagrees with the model: exact-match binding, one notification per change, stale 401s ignored', () => {
    const rows: Row[] = [];
    for (const i of iterations()) {
      const rng = new Rng(SALT.D ^ i);
      clearApiSession();
      setApiUnauthorizedListener(null);
      const ids = idPool(rng);
      const tokens = tokenPool(rng);
      const makeSession = (): ApiSession => ({
        apiBaseUrl: rng.chance(0.9) ? BASE_URL : (hostileString(rng) as string),
        bearerToken: rng.pick(tokens) as string,
        canonicalAppUserId: rng.pick(ids) as string,
        provider: rng.chance(0.9)
          ? rng.pick(['apple', 'google'])
          : (hostileValue(rng) as 'apple'),
        ...(rng.chance(0.5)
          ? { refreshToken: rng.pick(tokens) as string }
          : {}),
        ...(rng.chance(0.5)
          ? { bearerExpiresAtMs: hostileValue(rng) as number }
          : {}),
      });

      // Model + instrumentation.
      let model: ApiSession | null = null;
      const currentModel = (): ApiSession | null => model;
      const subs: Array<{
        unsubscribe: () => void;
        active: boolean;
        throws: boolean;
        calls: Array<ApiSession | null>;
      }> = [];
      let listenerMode: 'record' | 'throw' | 'null' = 'null';
      const listenerCalls: ApiSession[] = [];
      const ops: Op[] = [];
      let failure: string | null = null;
      const trace: string[] = [];

      const length = rng.int(1, 40);
      for (let k = 0; k < length && failure === null; k += 1) {
        const roll = rng.int(0, 9);
        const op: Op =
          roll <= 2
            ? { op: 'establish', session: makeSession() }
            : roll === 3
              ? { op: 'clear' }
              : roll <= 5
                ? { op: 'bearerFor', id: rng.pick(ids) }
                : roll <= 7
                  ? {
                      op: 'report',
                      token: rng.pick([...tokens, currentModel()?.bearerToken]),
                    }
                  : roll === 8
                    ? rng.chance(0.5)
                      ? { op: 'subscribe', throws: rng.chance(0.15) }
                      : {
                          op: 'unsubscribe',
                          index: rng.int(0, Math.max(0, subs.length - 1)),
                        }
                    : {
                        op: 'setListener',
                        mode: rng.pick(['record', 'throw', 'null']),
                      };
        ops.push(op);
        trace.push(op.op);

        const before = subs.map(s => s.calls.length);
        try {
          switch (op.op) {
            case 'establish': {
              const activeThrower = subs.some(s => s.active && s.throws);
              let threw = false;
              try {
                establishApiSession(op.session);
              } catch {
                threw = true;
              }
              model = op.session;
              if (threw && !activeThrower)
                failure = 'establish-threw-without-throwing-subscriber';
              if (getApiSession() !== op.session)
                failure = 'state-not-established';
              if (!activeThrower) {
                subs.forEach((s, idx) => {
                  const delta = s.calls.length - (before[idx] ?? 0);
                  if (
                    s.active &&
                    (delta !== 1 || s.calls[s.calls.length - 1] !== op.session)
                  )
                    failure = 'subscriber-not-notified-once';
                  if (!s.active && delta !== 0)
                    failure = 'unsubscribed-listener-called';
                });
              }
              break;
            }
            case 'clear': {
              const activeThrower = subs.some(s => s.active && s.throws);
              try {
                clearApiSession();
              } catch {
                if (!activeThrower) failure = 'clear-threw';
              }
              model = null;
              if (getApiSession() !== null) failure = 'state-not-cleared';
              if (!activeThrower) {
                subs.forEach((s, idx) => {
                  const delta = s.calls.length - (before[idx] ?? 0);
                  if (
                    s.active &&
                    (delta !== 1 || s.calls[s.calls.length - 1] !== null)
                  )
                    failure = 'subscriber-not-notified-once-on-clear';
                  if (!s.active && delta !== 0)
                    failure = 'unsubscribed-listener-called';
                });
              }
              break;
            }
            case 'bearerFor': {
              const got = bearerTokenFor(op.id as string);
              const expected =
                model !== null && model.canonicalAppUserId === op.id
                  ? model.bearerToken
                  : null;
              if (got !== expected) failure = 'bearerTokenFor-mismatch';
              break;
            }
            case 'report': {
              const beforeCalls = listenerCalls.length;
              let threw = false;
              try {
                reportApiUnauthorized(op.token as string);
              } catch {
                threw = true;
              }
              const current = model !== null && model.bearerToken === op.token;
              const shouldInvoke = current && listenerMode !== 'null';
              if (threw !== (shouldInvoke && listenerMode === 'throw'))
                failure = 'report-throw-mismatch';
              const delta = listenerCalls.length - beforeCalls;
              if (shouldInvoke) {
                if (
                  delta !== 1 ||
                  listenerCalls[listenerCalls.length - 1] !== model
                )
                  failure = 'listener-not-invoked-once-with-current-session';
              } else if (delta !== 0) {
                failure = 'listener-invoked-for-stale-or-absent-session';
              }
              if (getApiSession() !== model) failure = 'report-mutated-state';
              break;
            }
            case 'subscribe': {
              const entry = {
                unsubscribe: () => {},
                active: true,
                throws: op.throws,
                calls: [] as Array<ApiSession | null>,
              };
              entry.unsubscribe = subscribeToApiSession(session => {
                entry.calls.push(session);
                if (entry.throws) throw new Error('subscriber exploded');
              });
              subs.push(entry);
              break;
            }
            case 'unsubscribe': {
              const entry = subs[op.index];
              if (entry) {
                entry.unsubscribe();
                entry.active = false;
              }
              break;
            }
            case 'setListener': {
              listenerMode = op.mode;
              setApiUnauthorizedListener(
                op.mode === 'null'
                  ? null
                  : session => {
                      listenerCalls.push(session);
                      if (op.mode === 'throw')
                        throw new Error('listener exploded');
                    },
              );
              break;
            }
            default:
              break;
          }
        } catch (error) {
          failure = `unexpected-throw:${describeError(error)}`;
        }
        if (getApiSession() !== model)
          failure = failure ?? 'state-diverged-from-model';
      }

      subs.forEach(s => s.unsubscribe());
      clearApiSession();
      setApiUnauthorizedListener(null);

      rows.push(
        failure === null
          ? {
              campaign: 'D',
              seed: i,
              outcome: 'HELD',
              kind: `ops=${ops.length}`,
            }
          : {
              campaign: 'D',
              seed: i,
              outcome: 'BROKEN',
              kind: failure,
              detail: `${trace.join('>')} :: ${render(ops[ops.length - 1])}`,
            },
      );
    }
    expectNoBroken(finish('D', rows));
  });
});

// ─── E: byte-level corruption through a REAL Response ────────────────────────

describe('E · corrupted JSON bodies through a real Response', () => {
  it('truncated, poisoned or non-JSON bodies always end in a typed error or the oracle-approved account', async () => {
    const rows: Row[] = [];
    const decoder = new TextDecoder();
    for (const i of iterations()) {
      const rng = new Rng(SALT.E ^ i);
      const corruption = rng.pick(TEXT_CORRUPTIONS);
      const source = rng.chance(0.7)
        ? validPayload(rng)
        : mutatePayload(rng, rng.pick(PAYLOAD_STRATEGIES));
      let text: string;
      try {
        text =
          JSON.stringify(source, null, rng.chance(0.3) ? 2 : 0) ?? 'undefined';
      } catch {
        text = 'undefined';
      }
      // Real `Response` only allows 200–599, and 204/205/304 must carry no body.
      const status = rng.chance(0.75) ? 200 : rng.int(200, 599);
      const nullBody = status === 204 || status === 205 || status === 304;
      const bytes = nullBody
        ? new Uint8Array(0)
        : corruptText(rng, text, corruption);
      const bearer = `pt.${alnum(rng, 24)}`;

      let payload: unknown = undefined;
      let parseFailed = false;
      try {
        payload = JSON.parse(decoder.decode(bytes));
      } catch {
        parseFailed = true;
      }

      let calls = 0;
      const fetchFn = jest.fn(async () => {
        calls += 1;
        return new Response(nullBody ? null : bytes, {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });
      const outcome = await runBootstrap(fetchFn, { bearerToken: bearer });
      rows.push(
        judgeBootstrapOutcome(
          { campaign: 'E', seed: i, outcome: 'HELD', kind: corruption },
          {
            payload,
            parseFailed,
            status,
            bearer,
            calls,
            outcome,
            detail: `[${corruption} status=${status} bytes=${bytes.length}] ${render(decoder.decode(bytes.slice(0, 200)))}`,
          },
        ),
      );
    }
    expectNoBroken(finish('E', rows));
  });
});

// ─── Pins: invariants that must keep holding ─────────────────────────────────

describe('pins · boundary behaviour that must keep holding', () => {
  afterEach(clearApiSession);

  it('prototype-pollution keys never satisfy the account contract', async () => {
    const polluted = JSON.parse(
      '{"__proto__":{"user":{"id":"7fc2c743-028f-4ec6-942c-a84508f3be38","email":null},"onboardingState":"complete"},"constructor":{"prototype":{"admin":true}}}',
    );
    const outcome = await runBootstrap(async () => mockResponse(polluted, 200));
    expect(outcome.kind).toBe('rejected');
    expect(outcome.kind === 'rejected' && outcome.error).toMatchObject({
      code: 'account.invalid_response',
    });
    expect(prototypeClean()).toBe(true);
  });

  it('nil, max, wrong-version and wrong-variant UUIDs are refused as canonical ids', async () => {
    for (const id of [
      '00000000-0000-0000-0000-000000000000',
      'ffffffff-ffff-ffff-ffff-ffffffffffff',
      '7fc2c743-028f-0ec6-942c-a84508f3be38',
      '7fc2c743-028f-4ec6-742c-a84508f3be38',
      '7fc2c743-028f-4ec6-942c-a84508f3be38\n',
      ' 7fc2c743-028f-4ec6-942c-a84508f3be38',
      '{7fc2c743-028f-4ec6-942c-a84508f3be38}',
      '7fc2c743-028f-4ec6-942c-a84508f3be38\u0000',
    ]) {
      const outcome = await runBootstrap(async () =>
        mockResponse(
          { user: { id, email: null }, onboardingState: 'complete' },
          200,
        ),
      );
      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' && outcome.error).toMatchObject({
        code: 'account.invalid_response',
        retryable: true,
      });
    }
  });

  it('whitespace-only or empty provider tokens are refused before any request', async () => {
    for (const bearerToken of ['', '   ', '\t\n', '\u00a0\u3000']) {
      const fetchFn = jest.fn();
      const outcome = await runBootstrap(fetchFn, { bearerToken });
      expect(outcome.kind === 'rejected' && outcome.error).toMatchObject({
        code: 'account.invalid_token',
        retryable: false,
      });
      expect(fetchFn).not.toHaveBeenCalled();
    }
  });

  it('a 64 KiB+ provider token is forwarded intact (no silent truncation)', async () => {
    const bearerToken = 'x'.repeat(70_000);
    const fetchFn = jest.fn(async () =>
      mockResponse(
        {
          user: { id: validUuidV4(new Rng(7)), email: null },
          onboardingState: 'pending',
        },
        200,
      ),
    );
    const outcome = await runBootstrap(fetchFn, { bearerToken });
    expect(outcome.kind).toBe('resolved');
    const headers = (
      fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    )[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe(`Bearer ${bearerToken}`);
  });

  it('bearerTokenFor binds by exact string: NFC vs NFD and case variants of an id never match', () => {
    const id = '7fc2c743-028f-4ec6-942c-a84508f3be38';
    establishApiSession({
      apiBaseUrl: BASE_URL,
      bearerToken: 'tok',
      canonicalAppUserId: `${'\u00e9'}-${id}`,
      provider: 'apple',
    });
    expect(bearerTokenFor(`${'\u00e9'}-${id}`)).toBe('tok');
    expect(bearerTokenFor(`${'e\u0301'}-${id}`)).toBeNull();
    expect(bearerTokenFor(`${'\u00e9'}-${id}`.toUpperCase())).toBeNull();
    expect(bearerTokenFor('')).toBeNull();
    expect(bearerTokenFor(`${'\u00e9'}-${id}\u0000`)).toBeNull();
  });

  it('a 401 for a stale, empty, whitespace-padded or huge bearer never reaches the listener', () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    establishApiSession({
      apiBaseUrl: BASE_URL,
      bearerToken: 'current',
      canonicalAppUserId: '7fc2c743-028f-4ec6-942c-a84508f3be38',
      provider: 'google',
    });
    for (const stale of [
      'previous',
      '',
      ' current',
      'current ',
      'CURRENT',
      'x'.repeat(70_000),
      'current\u0000',
    ]) {
      reportApiUnauthorized(stale);
    }
    expect(listener).not.toHaveBeenCalled();
    reportApiUnauthorized('current');
    expect(listener).toHaveBeenCalledTimes(1);
    setApiUnauthorizedListener(null);
  });
});

// ─── Reproductions of the boundary weaknesses found by the campaigns ─────────
// Each `it.failing` asserts the EXPECTED behaviour; it passes only while the
// weakness is present. When the module is hardened these turn red — flip to `it`.

describe('repro · boundary weaknesses (it.failing = currently broken)', () => {
  beforeAll(() => {
    jest.useFakeTimers({
      doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'],
    });
  });
  afterEach(() => {
    jest.clearAllTimers();
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it.failing(
    'F1a bootstrap.ts:178 — a non-string bearerToken must surface as AccountBootstrapError(account.invalid_token), not a raw TypeError',
    async () => {
      const fetchFn = jest.fn();
      await expect(
        bootstrapCanonicalAccount({
          apiBaseUrl: BASE_URL,
          bearerToken: 42 as unknown as string,
          provider: 'apple',
          environment: ENVIRONMENT,
          fetchFn,
        }),
      ).rejects.toBeInstanceOf(AccountBootstrapError);
    },
  );

  it.failing(
    'F1b bootstrap.ts:198 — a non-string appleAuthorizationCode must surface as AccountBootstrapError, not a raw TypeError',
    async () => {
      const fetchFn = jest.fn();
      await expect(
        bootstrapCanonicalAccount({
          apiBaseUrl: BASE_URL,
          bearerToken: 'provider-issued-jwt',
          provider: 'apple',
          appleAuthorizationCode: {} as unknown as string,
          environment: ENVIRONMENT,
          fetchFn,
        }),
      ).rejects.toBeInstanceOf(AccountBootstrapError);
    },
  );

  it.failing(
    'F1b-leak bootstrap.ts:196-198 — the 15 s abort timer armed before appleAuthorizationCode is read must not stay armed when that read throws',
    async () => {
      await bootstrapCanonicalAccount({
        apiBaseUrl: BASE_URL,
        bearerToken: 'provider-issued-jwt',
        provider: 'apple',
        appleAuthorizationCode: 7 as unknown as string,
        environment: ENVIRONMENT,
        fetchFn: jest.fn(),
      }).catch(() => undefined);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.failing(
    'F1c bootstrap.ts:61 — a non-string apiBaseUrl must surface as AccountBootstrapError(account.not_configured), not a raw TypeError',
    () => {
      expect(() => normalizeApiBaseUrl(42 as unknown as string)).toThrow(
        AccountBootstrapError,
      );
    },
  );

  it.failing(
    'F2 bootstrap.ts:161-166 — a finite expiresAt whose ×1000 overflows must not yield bearerExpiresAtMs=Infinity',
    async () => {
      const outcome = await runBootstrap(async () =>
        mockResponse(
          {
            user: { id: '7fc2c743-028f-4ec6-942c-a84508f3be38', email: null },
            onboardingState: 'complete',
            session: {
              accessToken: 'at',
              refreshToken: 'rt',
              expiresAt: 1e306,
            },
          },
          200,
        ),
      );
      expect(outcome.kind).toBe('resolved');
      const expiresAtMs =
        outcome.kind === 'resolved'
          ? outcome.value.apiSession.bearerExpiresAtMs
          : undefined;
      expect(expiresAtMs === null || Number.isFinite(expiresAtMs)).toBe(true);
    },
  );

  it.failing(
    'F3 bootstrap.ts:60-91,200 — an accepted base URL must produce a request whose path is /v1/account/bootstrap (query/fragment/tab in the base must not survive)',
    async () => {
      for (const apiBaseUrl of [
        'https://api.pickle.example?x=1',
        'https://api.pickle.example#frag',
        'https://api.pickle.exam\tple',
      ]) {
        const fetchFn = jest.fn(async () =>
          mockResponse(
            {
              user: { id: '7fc2c743-028f-4ec6-942c-a84508f3be38', email: null },
              onboardingState: 'complete',
            },
            200,
          ),
        );
        await runBootstrap(fetchFn, { apiBaseUrl });
        const url = String((fetchFn.mock.calls[0] as unknown as [string])[0]);
        expect(url).toBe(new URL(url).href);
        expect(new URL(url).pathname).toBe('/v1/account/bootstrap');
        expect(new URL(url).search).toBe('');
        expect(new URL(url).hash).toBe('');
      }
    },
  );
});
