/**
 * Failure-injection support for the `mod-bootstrap-api-session` stress unit
 * (`src/account/bootstrap.ts` + `src/account/apiSession.ts`).
 *
 * The unit has exactly these dependencies, and every one of them is injected
 * here from a seeded plan so a failing iteration replays from its seed:
 *
 *   - the configured API base URL (`normalizeApiBaseUrl`)
 *   - the provider bearer / Apple authorization code
 *   - `fetch` (sync throw, rejection, abort, never-resolves, slow, not a
 *     Response, resolves after the abort deadline)
 *   - the response body reader (`json()` throws / rejects / stalls / slow)
 *   - the response status and payload shape (canonical account + session)
 *   - the clock (jest fake timers; the unit's only timer is its 15 s abort)
 *
 * `expectedOutcome` is the ORACLE: it encodes the module contract from the
 * doc-comments and AGENTS.md "Auth sessions" independently of the
 * implementation, so a mismatch is a reproduced defect, never a harness
 * tautology. The oracle deliberately covers only realistic server behaviour;
 * the defect probes in the suite hold the cases where the implementation and
 * the contract disagree.
 */
import type { AccountBootstrapEnvironment } from '../../src/account/deviceContext';
import type { AccountProvider } from '../../src/account/bootstrap';
import { randomInt, seededRandom } from '../xcBehavioral/evidence';

export { randomInt, seededRandom };

// Node built-ins for the evidence sink. The mobile tsconfig excludes node
// typings (same convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage(): { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[randomInt(random, 0, items.length - 1)]!;
}

// ─── Evidence sink ───────────────────────────────────────────────────────────

export type Verdict = 'HELD' | 'BROKEN' | 'DEPENDENCY_LIMIT';

export interface StressRow {
  id: string;
  family: string;
  seed: number;
  inputs: Record<string, unknown>;
  expected: Record<string, unknown> | string;
  observed: Record<string, unknown>;
  verdict: Verdict;
  error: string | null;
  durationMs: number;
}

export const STRESS_ITER = Number(process.env['STRESS_ITER'] ?? '40');
export const STRESS_SEED = process.env['STRESS_SEED'];
const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function stressSeeds(family: string, count = STRESS_ITER): number[] {
  if (STRESS_SEED !== undefined && STRESS_SEED !== '') {
    return [Number(STRESS_SEED)];
  }
  let hash = 2166136261;
  for (const ch of family) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < count; i += 1) seeds.push((hash + i * 7919) >>> 0);
  return seeds;
}

export function stressArtifactDir(): string {
  // apps/mobile/testing/stress → repo root
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(repoRoot, 'artifacts', 'stress', RUN_ID);
}

export function writeStressTable(
  fileName: string,
  meta: Record<string, unknown>,
  rows: readonly StressRow[],
): string {
  const dir = stressArtifactDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, fileName);
  const mem = process.memoryUsage();
  const summary = {
    rows: rows.length,
    held: rows.filter(r => r.verdict === 'HELD').length,
    broken: rows.filter(r => r.verdict === 'BROKEN').length,
    dependencyLimit: rows.filter(r => r.verdict === 'DEPENDENCY_LIMIT').length,
    brokenSeeds: rows
      .filter(r => r.verdict === 'BROKEN')
      .map(r => ({ id: r.id, seed: r.seed, error: r.error })),
    byFamily: Object.fromEntries(
      [...new Set(rows.map(r => r.family))].map(family => [
        family,
        {
          rows: rows.filter(r => r.family === family).length,
          broken: rows.filter(
            r => r.family === family && r.verdict === 'BROKEN',
          ).length,
        },
      ]),
    ),
  };
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        node: process.version,
        runId: RUN_ID,
        stressIter: STRESS_ITER,
        pinnedSeed: STRESS_SEED ?? null,
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 100) / 100,
        rssMb: Math.round((mem.rss / 1024 / 1024) * 100) / 100,
        ...meta,
        summary,
        rows,
      },
      null,
      2,
    ),
  );
  return file;
}

// ─── Fault space ─────────────────────────────────────────────────────────────

export const ENVIRONMENT: AccountBootstrapEnvironment = {
  locale: 'en-US',
  timezone: 'America/Los_Angeles',
  device: {
    platform: 'ios',
    osVersion: '18.5',
    appVersion: '1.0',
    model: 'iOS phone',
  },
};

export const BOOTSTRAP_TIMEOUT_MS = 15_000;

export interface BaseUrlCase {
  id: string;
  value: string | null | undefined;
  /** `ok` ⇒ accepted and normalized to `normalized`. */
  expect: 'ok' | 'not_configured';
  normalized?: string;
}

/** Every base URL the oracle understands. Cases the implementation accepts
 * but that cannot form a valid request URL live in the defect probes, not
 * here. */
export const BASE_URL_CASES: readonly BaseUrlCase[] = [
  {
    id: 'url.https',
    value: 'https://api.pickle.example',
    expect: 'ok',
    normalized: 'https://api.pickle.example',
  },
  {
    id: 'url.https.trailing-slashes',
    value: 'https://api.pickle.example///',
    expect: 'ok',
    normalized: 'https://api.pickle.example',
  },
  {
    id: 'url.https.padded',
    value: '  https://api.pickle.example/  ',
    expect: 'ok',
    normalized: 'https://api.pickle.example',
  },
  {
    id: 'url.https.path',
    value: 'https://ucq.supabase.example/functions/v1/api/',
    expect: 'ok',
    normalized: 'https://ucq.supabase.example/functions/v1/api',
  },
  {
    id: 'url.https.port',
    value: 'https://api.pickle.example:8443',
    expect: 'ok',
    normalized: 'https://api.pickle.example:8443',
  },
  {
    id: 'url.https.upper-scheme',
    value: 'HTTPS://api.pickle.example',
    expect: 'ok',
    normalized: 'HTTPS://api.pickle.example',
  },
  {
    id: 'url.localhost.http',
    value: 'http://localhost:54321/functions/v1/api',
    expect: 'ok',
    normalized: 'http://localhost:54321/functions/v1/api',
  },
  {
    id: 'url.loopback.http',
    value: 'http://127.0.0.1:3001',
    expect: 'ok',
    normalized: 'http://127.0.0.1:3001',
  },
  {
    id: 'url.android-emulator.http',
    value: 'http://10.0.2.2:3001/',
    expect: 'ok',
    normalized: 'http://10.0.2.2:3001',
  },
  { id: 'url.null', value: null, expect: 'not_configured' },
  { id: 'url.undefined', value: undefined, expect: 'not_configured' },
  { id: 'url.empty', value: '', expect: 'not_configured' },
  { id: 'url.blank', value: '   ', expect: 'not_configured' },
  { id: 'url.slashes-only', value: '///', expect: 'not_configured' },
  {
    id: 'url.http.public',
    value: 'http://api.pickle.example',
    expect: 'not_configured',
  },
  {
    id: 'url.http.lan',
    value: 'http://192.168.1.10:3001',
    expect: 'not_configured',
  },
  {
    id: 'url.http.localhost-lookalike',
    value: 'http://localhost.evil.example',
    expect: 'not_configured',
  },
  {
    id: 'url.ftp',
    value: 'ftp://api.pickle.example',
    expect: 'not_configured',
  },
  {
    id: 'url.wss',
    value: 'wss://api.pickle.example',
    expect: 'not_configured',
  },
  {
    id: 'url.scheme-only',
    value: 'https://',
    expect: 'not_configured',
  },
  { id: 'url.unparseable', value: 'not a url', expect: 'not_configured' },
  {
    id: 'url.relative',
    value: '/functions/v1/api',
    expect: 'not_configured',
  },
  {
    id: 'url.javascript',
    value: 'javascript:alert(1)',
    expect: 'not_configured',
  },
  {
    id: 'url.file',
    value: 'file:///etc/hosts',
    expect: 'not_configured',
  },
];

export interface BearerCase {
  id: string;
  value: string | null | undefined;
  /** The header value the server must receive, or null when refused. */
  sent: string | null;
}

export function bearerCases(seed: number): readonly BearerCase[] {
  const token = `provider-token-${seed}`;
  return [
    { id: 'bearer.ok', value: token, sent: token },
    { id: 'bearer.padded', value: `  ${token}\n`, sent: token },
    {
      id: 'bearer.jwt-like',
      value: `eyJ.${seed}.sig`,
      sent: `eyJ.${seed}.sig`,
    },
    { id: 'bearer.null', value: null, sent: null },
    { id: 'bearer.undefined', value: undefined, sent: null },
    { id: 'bearer.empty', value: '', sent: null },
    { id: 'bearer.blank', value: ' \t\n ', sent: null },
  ];
}

export interface AppleCodeCase {
  id: string;
  provider: AccountProvider;
  value: string | null | undefined;
  /** Body field + header expected on the wire, null ⇒ absent. */
  sent: string | null;
}

export function appleCodeCases(seed: number): readonly AppleCodeCase[] {
  const code = `apple-code-${seed}`;
  return [
    { id: 'apple.code', provider: 'apple', value: `  ${code} `, sent: code },
    { id: 'apple.no-code', provider: 'apple', value: undefined, sent: null },
    { id: 'apple.null-code', provider: 'apple', value: null, sent: null },
    { id: 'apple.blank-code', provider: 'apple', value: '   ', sent: null },
    { id: 'google.no-code', provider: 'google', value: undefined, sent: null },
    // A code beside a Google token must never reach the wire.
    { id: 'google.stray-code', provider: 'google', value: code, sent: null },
  ];
}

// ─── fetch behaviours ────────────────────────────────────────────────────────

export type FetchBehaviour =
  | { kind: 'throw-sync' }
  | { kind: 'reject'; errorName: 'TypeError' | 'AbortError' | 'Error' }
  | { kind: 'hang-honours-abort' }
  | { kind: 'hang-ignores-abort' }
  | { kind: 'resolve-after'; ms: number; honoursAbort: boolean }
  | {
      kind: 'not-a-response';
      value: 'undefined' | 'null' | 'string' | 'empty-object';
    };

export type BodyBehaviour =
  | { kind: 'json'; value: unknown }
  | { kind: 'json-throws-sync' }
  | { kind: 'json-rejects' }
  | { kind: 'json-slow'; ms: number; value: unknown }
  | { kind: 'json-never' };

export interface ResponseSpec {
  status: number;
  body: BodyBehaviour;
}

export interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

export interface InjectedFetch {
  fn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
  /** Whether the injected fetch observed an abort event. */
  aborted: () => boolean;
}

function fakeResponse(spec: ResponseSpec): Response {
  const { body } = spec;
  const json = (): Promise<unknown> => {
    switch (body.kind) {
      case 'json':
        return Promise.resolve(body.value);
      case 'json-throws-sync':
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      case 'json-rejects':
        return Promise.reject(new SyntaxError('Unexpected end of JSON input'));
      case 'json-slow':
        return new Promise(resolve =>
          setTimeout(() => resolve(body.value), body.ms),
        );
      case 'json-never':
        return new Promise(() => {});
    }
  };
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    json,
  } as unknown as Response;
}

function notAResponse(kind: 'undefined' | 'null' | 'string' | 'empty-object') {
  switch (kind) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'string':
      return 'OK';
    case 'empty-object':
      return {};
  }
}

export function injectFetch(
  behaviour: FetchBehaviour,
  response: ResponseSpec,
): InjectedFetch {
  const calls: FetchCall[] = [];
  let aborted = false;
  const fn = (input: string, init?: RequestInit): Promise<Response> => {
    let parsedBody: unknown = init?.body;
    if (typeof init?.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({
      url: input,
      method: init?.method,
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: parsedBody,
      signal: init?.signal ?? undefined,
    });
    const signal = init?.signal ?? undefined;
    signal?.addEventListener('abort', () => {
      aborted = true;
    });
    switch (behaviour.kind) {
      case 'throw-sync':
        throw new TypeError('Failed to construct Request');
      case 'reject': {
        const error = new Error('Network request failed');
        error.name = behaviour.errorName;
        return Promise.reject(error);
      }
      case 'hang-honours-abort':
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
          });
        });
      case 'hang-ignores-abort':
        return new Promise(() => {});
      case 'resolve-after':
        return new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => resolve(fakeResponse(response)),
            behaviour.ms,
          );
          if (behaviour.honoursAbort) {
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              const error = new Error('Aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }
        });
      case 'not-a-response':
        return Promise.resolve(
          notAResponse(behaviour.value) as unknown as Response,
        );
    }
  };
  return { fn, calls, aborted: () => aborted };
}

// ─── Payload shapes ──────────────────────────────────────────────────────────

export function validUuid(random: () => number): string {
  const hex = (n: number) =>
    Array.from({ length: n }, () => randomInt(random, 0, 15).toString(16)).join(
      '',
    );
  const version = randomInt(random, 1, 8).toString(16);
  const variant = pick(random, ['8', '9', 'a', 'b']);
  const id = `${hex(8)}-${hex(4)}-${version}${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
  return random() < 0.2 ? id.toUpperCase() : id;
}

export interface PayloadPlan {
  userShape: 'object' | 'null' | 'array' | 'string' | 'missing';
  id:
    | 'valid'
    | 'version-9'
    | 'variant-c'
    | 'no-dashes'
    | 'short'
    | 'number'
    | 'null'
    | 'subject'
    | 'missing';
  email: 'string' | 'null' | 'number' | 'missing';
  onboardingState:
    'pending' | 'complete' | 'PENDING' | 'done' | 'missing' | 'number';
  session: SessionPlan;
  extraKeys: boolean;
}

export interface SessionPlan {
  shape: 'missing' | 'null' | 'string' | 'array' | 'object';
  accessToken: 'ok' | 'padded' | 'empty' | 'blank' | 'number' | 'missing';
  refreshToken: 'ok' | 'empty' | 'blank' | 'number' | 'missing';
  expiresAt:
    | 'seconds'
    | 'zero'
    | 'negative'
    | 'float'
    | 'string'
    | 'nan'
    | 'infinity'
    | 'missing'
    | 'null';
}

export interface BuiltPayload {
  payload: unknown;
  /** Oracle: the canonical account is valid. */
  accountValid: boolean;
  canonicalId: string | null;
  email: string | null;
  onboardingState: 'pending' | 'complete' | null;
  /** Oracle: the session is complete ⇒ these tokens are borne. */
  sessionValid: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAtMs: number | null;
}

export function randomPayloadPlan(random: () => number): PayloadPlan {
  // Mostly-valid so that the session/token faults get exercised on a valid
  // account; the account faults are covered by the weighted picks below.
  const mostlyValid = <T>(valid: T, faults: readonly T[]): T =>
    random() < 0.65 ? valid : pick(random, faults);
  return {
    userShape: mostlyValid('object', ['null', 'array', 'string', 'missing']),
    id: mostlyValid('valid', [
      'version-9',
      'variant-c',
      'no-dashes',
      'short',
      'number',
      'null',
      'subject',
      'missing',
    ]),
    email: mostlyValid('string', ['null', 'number', 'missing']),
    onboardingState: mostlyValid(pick(random, ['pending', 'complete']), [
      'PENDING',
      'done',
      'missing',
      'number',
    ]),
    session: {
      shape: mostlyValid('object', ['missing', 'null', 'string', 'array']),
      accessToken: mostlyValid('ok', [
        'padded',
        'empty',
        'blank',
        'number',
        'missing',
      ]),
      refreshToken: mostlyValid('ok', ['empty', 'blank', 'number', 'missing']),
      expiresAt: mostlyValid('seconds', [
        'zero',
        'negative',
        'float',
        'string',
        'nan',
        'infinity',
        'missing',
        'null',
      ]),
    },
    extraKeys: random() < 0.3,
  };
}

export function buildPayload(
  plan: PayloadPlan,
  random: () => number,
  seed: number,
): BuiltPayload {
  const id = validUuid(random);
  const emailValue = `player-${seed}@example.com`;
  const idValue: Record<PayloadPlan['id'], unknown> = {
    valid: id,
    'version-9': id.replace(/^(.{14})./, '$19'),
    'variant-c': id.replace(/^(.{19})./, '$1c'),
    'no-dashes': id.replace(/-/g, ''),
    short: id.slice(0, 20),
    number: 42,
    null: null,
    subject: `google-subject-${seed}`,
    missing: undefined,
  };
  const user: Record<string, unknown> = {};
  if (plan.id !== 'missing') user['id'] = idValue[plan.id];
  if (plan.email === 'string') user['email'] = emailValue;
  else if (plan.email === 'null') user['email'] = null;
  else if (plan.email === 'number') user['email'] = 7;

  const onboarding: Record<PayloadPlan['onboardingState'], unknown> = {
    pending: 'pending',
    complete: 'complete',
    PENDING: 'PENDING',
    done: 'done',
    missing: undefined,
    number: 1,
  };

  const accessToken = `access-${seed}`;
  const refreshToken = `refresh-${seed}`;
  const expiresAtSeconds = 1_700_000_000 + randomInt(random, 0, 100_000_000);
  const sessionObject: Record<string, unknown> = {};
  const at: Record<SessionPlan['accessToken'], unknown> = {
    ok: accessToken,
    padded: ` ${accessToken} `,
    empty: '',
    blank: '   ',
    number: 123,
    missing: undefined,
  };
  const rt: Record<SessionPlan['refreshToken'], unknown> = {
    ok: refreshToken,
    empty: '',
    blank: ' ',
    number: 456,
    missing: undefined,
  };
  const ea: Record<SessionPlan['expiresAt'], unknown> = {
    seconds: expiresAtSeconds,
    zero: 0,
    negative: -1,
    float: expiresAtSeconds + 0.5,
    string: String(expiresAtSeconds),
    nan: Number.NaN,
    infinity: Number.POSITIVE_INFINITY,
    missing: undefined,
    null: null,
  };
  if (plan.session.accessToken !== 'missing')
    sessionObject['accessToken'] = at[plan.session.accessToken];
  if (plan.session.refreshToken !== 'missing')
    sessionObject['refreshToken'] = rt[plan.session.refreshToken];
  if (plan.session.expiresAt !== 'missing')
    sessionObject['expiresAt'] = ea[plan.session.expiresAt];

  const payload: Record<string, unknown> = {};
  switch (plan.userShape) {
    case 'object':
      payload['user'] = user;
      break;
    case 'null':
      payload['user'] = null;
      break;
    case 'array':
      payload['user'] = [user];
      break;
    case 'string':
      payload['user'] = id;
      break;
    case 'missing':
      break;
  }
  if (plan.onboardingState !== 'missing')
    payload['onboardingState'] = onboarding[plan.onboardingState];
  switch (plan.session.shape) {
    case 'object':
      payload['session'] = sessionObject;
      break;
    case 'null':
      payload['session'] = null;
      break;
    case 'string':
      payload['session'] = accessToken;
      break;
    case 'array':
      payload['session'] = [sessionObject];
      break;
    case 'missing':
      break;
  }
  if (plan.extraKeys) {
    payload['providerSubject'] = `apple.${seed}`;
    payload['debug'] = { seed };
  }

  const accountValid =
    plan.userShape === 'object' &&
    plan.id === 'valid' &&
    (plan.email === 'string' || plan.email === 'null') &&
    (plan.onboardingState === 'pending' || plan.onboardingState === 'complete');
  const expiresAtNumeric =
    plan.session.expiresAt === 'seconds' ||
    plan.session.expiresAt === 'zero' ||
    plan.session.expiresAt === 'negative' ||
    plan.session.expiresAt === 'float';
  const sessionValid =
    plan.session.shape === 'object' &&
    (plan.session.accessToken === 'ok' ||
      plan.session.accessToken === 'padded') &&
    plan.session.refreshToken === 'ok' &&
    expiresAtNumeric;
  return {
    payload,
    accountValid,
    canonicalId: accountValid ? id : null,
    email: accountValid ? (plan.email === 'string' ? emailValue : null) : null,
    onboardingState: accountValid
      ? (plan.onboardingState as 'pending' | 'complete')
      : null,
    sessionValid,
    accessToken: sessionValid ? (at[plan.session.accessToken] as string) : null,
    refreshToken: sessionValid ? refreshToken : null,
    expiresAtMs: sessionValid
      ? (ea[plan.session.expiresAt] as number) * 1000
      : null,
  };
}

export type ErrorPayloadKind =
  | 'object-message'
  | 'string-error'
  | 'empty-message'
  | 'blank-message'
  | 'number-message'
  | 'no-error'
  | 'null';

export function errorPayload(kind: ErrorPayloadKind, seed: number): unknown {
  switch (kind) {
    case 'object-message':
      return {
        error: { code: 'auth.rejected', message: `Server said ${seed}.` },
      };
    case 'string-error':
      return { error: 'rejected' };
    case 'empty-message':
      return { error: { message: '' } };
    case 'blank-message':
      return { error: { message: '   ' } };
    case 'number-message':
      return { error: { message: 401 } };
    case 'no-error':
      return { ok: false };
    case 'null':
      return null;
  }
}

/** The server message the client must surface, or null when the fallback
 * copy is expected. */
export function expectedServerMessage(
  kind: ErrorPayloadKind,
  seed: number,
): string | null {
  return kind === 'object-message' ? `Server said ${seed}.` : null;
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

export type BootstrapCode =
  | 'account.not_configured'
  | 'account.invalid_token'
  | 'account.unavailable'
  | 'account.rejected'
  | 'account.invalid_response';

export type ExpectedOutcome =
  | {
      kind: 'rejects';
      code: BootstrapCode;
      retryable: boolean;
      fetchCalled: boolean;
      /** When set, the message must equal this exactly. */
      message?: string;
      /** Fake-time at which the rejection must have landed. */
      settledByMs: number;
    }
  | {
      kind: 'resolves';
      bearerToken: string;
      refreshToken: string | null;
      bearerExpiresAtMs: number | null;
      canonicalId: string;
      email: string | null;
      onboardingState: 'pending' | 'complete';
      settledByMs: number;
    }
  | {
      /** Only reachable when the injected dependency ignores the abort
       * signal — a contract the real RN fetch honours. */
      kind: 'pending';
      abortSignalledByMs: number;
    };

export interface BootstrapPlan {
  baseUrl: BaseUrlCase;
  bearer: BearerCase;
  apple: AppleCodeCase;
  fetch: FetchBehaviour;
  status: number;
  body: BodyBehaviour;
  built: BuiltPayload | null;
  errorKind: ErrorPayloadKind | null;
}

export function retryableForStatus(status: number): boolean {
  return status >= 500 || status === 429;
}

export function expectedOutcome(
  plan: BootstrapPlan,
  seed: number,
): ExpectedOutcome {
  if (plan.baseUrl.expect === 'not_configured') {
    return {
      kind: 'rejects',
      code: 'account.not_configured',
      retryable: false,
      fetchCalled: false,
      settledByMs: 0,
    };
  }
  if (plan.bearer.sent === null) {
    return {
      kind: 'rejects',
      code: 'account.invalid_token',
      retryable: false,
      fetchCalled: false,
      settledByMs: 0,
    };
  }
  const f = plan.fetch;
  switch (f.kind) {
    case 'throw-sync':
    case 'reject':
      return {
        kind: 'rejects',
        code: 'account.unavailable',
        retryable: true,
        fetchCalled: true,
        settledByMs: 0,
      };
    case 'hang-honours-abort':
      return {
        kind: 'rejects',
        code: 'account.unavailable',
        retryable: true,
        fetchCalled: true,
        settledByMs: BOOTSTRAP_TIMEOUT_MS,
      };
    case 'hang-ignores-abort':
      return { kind: 'pending', abortSignalledByMs: BOOTSTRAP_TIMEOUT_MS };
    case 'not-a-response':
      return {
        kind: 'rejects',
        code: 'account.invalid_response',
        retryable: true,
        fetchCalled: true,
        settledByMs: 0,
      };
    case 'resolve-after':
      break;
  }
  if (f.ms >= BOOTSTRAP_TIMEOUT_MS && f.honoursAbort) {
    return {
      kind: 'rejects',
      code: 'account.unavailable',
      retryable: true,
      fetchCalled: true,
      settledByMs: BOOTSTRAP_TIMEOUT_MS,
    };
  }
  const headersAt = f.ms;
  const body = plan.body;
  if (body.kind === 'json-never') {
    // No abort covers body reading in the unit; the RN fetch polyfill only
    // resolves after the whole body arrived, so a stalled body is a
    // dependency limit, never reached with the real fetch.
    return { kind: 'pending', abortSignalledByMs: Number.POSITIVE_INFINITY };
  }
  if (body.kind === 'json-throws-sync' || body.kind === 'json-rejects') {
    // Pinned as implemented: an unreadable body is classified before the
    // status is consulted, even on 401/403. The contract disagreement is a
    // P3 held by the "reproduced defects" probes in the suite, not here.
    return {
      kind: 'rejects',
      code: 'account.invalid_response',
      retryable: true,
      fetchCalled: true,
      settledByMs: headersAt,
    };
  }
  const settledByMs =
    body.kind === 'json-slow' ? headersAt + body.ms : headersAt;
  const ok = plan.status >= 200 && plan.status < 300;
  if (!ok) {
    const message =
      plan.errorKind === null
        ? null
        : expectedServerMessage(plan.errorKind, seed);
    if (plan.status === 401 || plan.status === 403) {
      return {
        kind: 'rejects',
        code: 'account.rejected',
        retryable: false,
        fetchCalled: true,
        settledByMs,
        ...(message
          ? { message }
          : {
              message:
                'The account server could not verify this identity provider token.',
            }),
      };
    }
    return {
      kind: 'rejects',
      code: 'account.unavailable',
      retryable: retryableForStatus(plan.status),
      fetchCalled: true,
      settledByMs,
      ...(message
        ? { message }
        : { message: 'Secure account setup could not be completed.' }),
    };
  }
  const built = plan.built;
  if (!built || !built.accountValid || built.canonicalId === null) {
    return {
      kind: 'rejects',
      code: 'account.invalid_response',
      retryable: true,
      fetchCalled: true,
      settledByMs,
    };
  }
  return {
    kind: 'resolves',
    bearerToken: built.sessionValid ? built.accessToken! : plan.bearer.sent,
    refreshToken: built.sessionValid ? built.refreshToken : null,
    bearerExpiresAtMs: built.sessionValid ? built.expiresAtMs : null,
    canonicalId: built.canonicalId,
    email: built.email,
    onboardingState: built.onboardingState!,
    settledByMs,
  };
}

export const STATUS_POOL: readonly number[] = [
  200, 200, 200, 201, 204, 301, 302, 304, 400, 401, 401, 403, 404, 408, 409,
  413, 422, 429, 500, 502, 503, 504, 520, 599,
];

export const REALISTIC_FETCH_FAULTS: readonly FetchBehaviour[] = [
  { kind: 'throw-sync' },
  { kind: 'reject', errorName: 'TypeError' },
  { kind: 'reject', errorName: 'AbortError' },
  { kind: 'reject', errorName: 'Error' },
  { kind: 'hang-honours-abort' },
  { kind: 'not-a-response', value: 'undefined' },
  { kind: 'not-a-response', value: 'null' },
  { kind: 'not-a-response', value: 'string' },
  { kind: 'not-a-response', value: 'empty-object' },
];

export function randomFetchBehaviour(random: () => number): FetchBehaviour {
  const roll = random();
  if (roll < 0.55) {
    // Headers arrive somewhere between "instant" and just past the deadline.
    const ms = pick(random, [
      0,
      0,
      randomInt(random, 1, 500),
      randomInt(random, 500, 14_000),
      14_999,
      15_000,
      15_001,
      randomInt(random, 15_002, 59_000),
    ]);
    return { kind: 'resolve-after', ms, honoursAbort: random() < 0.85 };
  }
  if (roll < 0.95) return pick(random, REALISTIC_FETCH_FAULTS);
  return { kind: 'hang-ignores-abort' };
}

export function randomBodyBehaviour(
  random: () => number,
  value: unknown,
): BodyBehaviour {
  const roll = random();
  if (roll < 0.7) return { kind: 'json', value };
  if (roll < 0.8) return { kind: 'json-throws-sync' };
  if (roll < 0.9) return { kind: 'json-rejects' };
  if (roll < 0.97)
    return { kind: 'json-slow', ms: randomInt(random, 1, 30_000), value };
  return { kind: 'json-never' };
}
