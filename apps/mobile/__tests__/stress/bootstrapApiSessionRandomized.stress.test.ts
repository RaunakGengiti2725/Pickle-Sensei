/**
 * STRESS / mod-bootstrap-api-session / randomized-seeded — seeded randomized
 * long-run over the public API of `src/account/bootstrap.ts` and
 * `src/account/apiSession.ts`.
 *
 * Every sequence is generated from a 32-bit seed (mulberry32) into an EXPLICIT
 * action script: in-memory session store calls (establish, clear, subscribe /
 * unsubscribe, setApiUnauthorizedListener, reportApiUnauthorized,
 * bearerTokenFor), `normalizeApiBaseUrl` over legal / near-legal origins, and
 * `bootstrapCanonicalAccount` calls against a scripted fake server whose fetch
 * settles LATER (resolve / reject / hang until the 15 s abort), interleaved in
 * any order with fake-timer advances and adoption of finished bootstraps into
 * the store. The script is executed against the real modules and the
 * invariants below are model-checked after every step. Because the script is
 * explicit and every reference is taken modulo the live pool, any sub-script
 * is valid: a failing seed is delta-minimized (ddmin) and every seed is run
 * twice to prove the trace is identical (determinism).
 *
 * Invariants (AGENTS.md "Auth sessions", REVIEW.md "Auth & session on
 * mobile", and the doc comments in both modules):
 *  S1 state      getApiSession() is exactly the session object most recently
 *                established (reference), or null after clear / at start.
 *  S2 binding    bearerTokenFor(id) is the current bearer iff id is the
 *                current canonicalAppUserId, else null — a request queued for
 *                another owner can never go out under the new bearer.
 *  S3 subscribe  every active subscriber has seen exactly one notification
 *                per establish/clear since it subscribed, each carrying the
 *                then-current session; nothing after unsubscribe.
 *  S4 unauth     reportApiUnauthorized(token) invokes the installed listener
 *                iff a session is current AND its bearer === token (stale or
 *                replaced bearers are ignored); the listener receives the
 *                current session; a removed listener is never invoked; the
 *                listener's own re-entrant establish/clear takes effect.
 *  N1 normalize  normalizeApiBaseUrl is total over the corpus: it returns
 *                trimmed input without trailing slashes when it parses as a
 *                URL and is https or a local-development host, otherwise it
 *                throws AccountBootstrapError account.not_configured
 *                (retryable=false); and it is idempotent.
 *  N2 routable   an origin normalizeApiBaseUrl ACCEPTS ("usable API URL" per
 *                its doc comment) composes into a request whose pathname ends
 *                in `/v1/account/bootstrap` — i.e. the server can route it;
 *                checked both on the normalized origin and on the URL the
 *                real bootstrap handed to fetch. (Origins carrying a `?query`
 *                or `#fragment` violate this: the route is appended after the
 *                query/fragment and silently disappears from the path.)
 *  B1 preflight  bootstrap calls fetch exactly once, synchronously, iff the
 *                origin is configured and the bearer is non-blank; otherwise
 *                it rejects with not_configured / invalid_token and never
 *                touches the network.
 *  B2 request    URL is `${origin}/v1/account/bootstrap`; method POST;
 *                Authorization is the TRIMMED provider token; X-Client-Version
 *                is the environment appVersion; the Apple revocation header and
 *                body field appear iff provider is apple AND a non-blank code
 *                was given (Google never sends the code); the body is the
 *                environment (+ that code) and never contains the bearer.
 *  B3 outcome    the settled result is exactly what the contract prescribes
 *                for the scripted server behaviour: network error / abort →
 *                unavailable (retryable); unreadable body → invalid_response
 *                (retryable); 401/403 → rejected (non-retryable, server
 *                message when present); other non-2xx → unavailable
 *                (retryable iff 5xx or 429); 2xx with an invalid canonical
 *                account → invalid_response; 2xx valid → account + session
 *                bearing the minted access token (falls back to the provider
 *                token with refreshToken/bearerExpiresAtMs null when the
 *                session is absent or malformed), canonicalAppUserId = the
 *                server UUID, provider = input provider, apiBaseUrl normalized.
 *  B4 secrecy    the serialized result never contains the Apple authorization
 *                code, and never a provider subject as canonical id.
 *  B5 timer      the abort signal fires iff the fetch was still pending after
 *                15 s of fake time; a settled bootstrap never aborts later
 *                (clearTimeout ran), and the promise settles within a bounded
 *                number of microtask ticks once its fetch has settled.
 *  X1 adoption   establishing a finished bootstrap's apiSession makes
 *                bearerTokenFor(account.id) that bearer, and
 *                reportApiUnauthorized(providerToken) fires iff the server
 *                minted no session (the provider token IS the bearer then).
 *
 * Knobs: STRESS_ITER (sequences, default 200 — 2000 for a campaign),
 * STRESS_SEED (base seed, default 20260905), STRESS_OUT (write the seed →
 * outcome JSON table to this path), STRESS_REPLAY (run exactly one seed),
 * STRESS_SKIP (comma-separated invariant ids to evaluate but not report, so
 * the remaining invariants are still checked to full length once a class is
 * known).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  AccountBootstrapError,
  bootstrapCanonicalAccount,
  normalizeApiBaseUrl,
  type AccountBootstrapInput,
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
import type { AccountBootstrapEnvironment } from '../../src/account/deviceContext';

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('empty pool');
  const index = Math.floor(rng() * items.length);
  // Pools legitimately contain `undefined`/`null` near-legal inputs.
  return items[index] as T;
}

// ---------------------------------------------------------------------------
// Corpora
// ---------------------------------------------------------------------------

const ACCOUNT_IDS = [
  '7fc2c743-028f-4ec6-942c-a84508f3be38',
  '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  'ffffffff-ffff-8fff-bfff-ffffffffffff',
] as const;
const UNKNOWN_ACCOUNT_ID = '11111111-2222-4333-8444-555555555555';

const BEARERS = [
  'sb-access-A',
  'sb-access-B',
  'sb-access-C',
  'provider-jwt-A',
  'provider-jwt-B',
] as const;

const PROVIDERS: readonly AccountProvider[] = ['apple', 'google'];

/** Provider tokens handed to bootstrap: legal, padded, blank, absent, long. */
const PROVIDER_TOKENS: ReadonlyArray<string | null | undefined> = [
  'provider-jwt-A',
  'provider-jwt-B',
  '  provider-jwt-padded  ',
  '\tprovider-jwt-tab\n',
  '',
  '   ',
  null,
  undefined,
  'x'.repeat(4096),
];

const APPLE_CODES: ReadonlyArray<string | null | undefined> = [
  undefined,
  null,
  '',
  '   ',
  'one-use-apple-code',
  '  one-use-apple-code-padded  ',
];

const APP_VERSIONS = ['1.0', '1.0.3', '2.1', ''] as const;

const ENV_LOCALES = ['en-US', 'de-DE', 'ja-JP'] as const;

/** Near-legal API origins. Expected verdict is computed by the model. */
const URL_SCHEMES = ['https://', 'http://', 'HTTPS://', 'ftp://', ''] as const;
const URL_HOSTS = [
  'api.pickle.example',
  'API.PICKLE.EXAMPLE',
  'localhost',
  'LOCALHOST',
  '127.0.0.1',
  '10.0.2.2',
  '[::1]',
  '192.168.1.5',
  'ucqnaiwqwjtgvlduiuib.supabase.co',
  'api.pickle.example:8443',
  'localhost:3001',
  'user:pass@api.pickle.example',
] as const;
const URL_PATHS = [
  '',
  '/',
  '///',
  '/functions/v1/api',
  '/functions/v1/api/',
  '/v1',
] as const;
const URL_SUFFIXES = ['', '', '', '?x=1', '#frag', ' ', '\n', '/ '] as const;
const URL_LITERALS: ReadonlyArray<string | null | undefined> = [
  null,
  undefined,
  '',
  '   ',
  '/',
  'https://',
  'https:///',
  'not a url',
  'api.pickle.example',
  ' https://api.pickle.example/ ',
  'https://api.pickle.example//',
  'https://api.pickle.example/v1/account/bootstrap',
];

function generateUrl(rng: () => number): string | null | undefined {
  if (rng() < 0.3) return pick(rng, URL_LITERALS);
  return `${pick(rng, URL_SCHEMES)}${pick(rng, URL_HOSTS)}${pick(rng, URL_PATHS)}${pick(rng, URL_SUFFIXES)}`;
}

// ---------------------------------------------------------------------------
// Scripted server behaviour
// ---------------------------------------------------------------------------

type UserIdSpec =
  | 'valid'
  | 'valid-upper'
  | 'google-subject'
  | 'apple-subject'
  | 'uuid-v0'
  | 'number'
  | 'missing';
type EmailSpec = 'string' | 'empty' | 'null' | 'number' | 'missing';
type OnboardingSpec = 'pending' | 'complete' | 'other' | 'missing';
type SessionSpec =
  | 'absent'
  | 'valid'
  | 'valid-zero-expiry'
  | 'valid-negative-expiry'
  | 'missing-refresh'
  | 'blank-access'
  | 'blank-refresh'
  | 'expiry-string'
  | 'expiry-nan'
  | 'expiry-infinite'
  | 'not-object'
  | 'access-number';
type ErrorSpec =
  | 'message'
  | 'blank-message'
  | 'non-string-message'
  | 'error-string'
  | 'missing';
type BodySpec =
  | { kind: 'unreadable' }
  | { kind: 'array' }
  | { kind: 'string' }
  | { kind: 'null' }
  | { kind: 'user-not-object' }
  | {
      kind: 'account';
      accountIdx: number;
      userId: UserIdSpec;
      email: EmailSpec;
      onboarding: OnboardingSpec;
      session: SessionSpec;
      accessIdx: number;
      error: ErrorSpec;
    };

type ServerSpec =
  | { kind: 'network-error' }
  | { kind: 'hang' }
  | { kind: 'respond'; status: number; body: BodySpec };

const STATUSES = [
  200, 200, 200, 200, 201, 204, 400, 401, 403, 404, 408, 409, 422, 429, 500,
  502, 503, 504,
] as const;

const USER_ID_SPECS: readonly UserIdSpec[] = [
  'valid',
  'valid',
  'valid',
  'valid',
  'valid-upper',
  'google-subject',
  'apple-subject',
  'uuid-v0',
  'number',
  'missing',
];
const EMAIL_SPECS: readonly EmailSpec[] = [
  'string',
  'string',
  'empty',
  'null',
  'number',
  'missing',
];
const ONBOARDING_SPECS: readonly OnboardingSpec[] = [
  'pending',
  'complete',
  'pending',
  'complete',
  'other',
  'missing',
];
const SESSION_SPECS: readonly SessionSpec[] = [
  'absent',
  'valid',
  'valid',
  'valid',
  'valid-zero-expiry',
  'valid-negative-expiry',
  'missing-refresh',
  'blank-access',
  'blank-refresh',
  'expiry-string',
  'expiry-nan',
  'expiry-infinite',
  'not-object',
  'access-number',
];
const ERROR_SPECS: readonly ErrorSpec[] = [
  'message',
  'blank-message',
  'non-string-message',
  'error-string',
  'missing',
  'missing',
];

function generateBody(rng: () => number): BodySpec {
  const roll = rng();
  if (roll < 0.08) return { kind: 'unreadable' };
  if (roll < 0.11) return { kind: 'array' };
  if (roll < 0.14) return { kind: 'string' };
  if (roll < 0.17) return { kind: 'null' };
  if (roll < 0.2) return { kind: 'user-not-object' };
  return {
    kind: 'account',
    accountIdx: Math.floor(rng() * ACCOUNT_IDS.length),
    userId: pick(rng, USER_ID_SPECS),
    email: pick(rng, EMAIL_SPECS),
    onboarding: pick(rng, ONBOARDING_SPECS),
    session: pick(rng, SESSION_SPECS),
    accessIdx: Math.floor(rng() * 3),
    error: pick(rng, ERROR_SPECS),
  };
}

function generateServer(rng: () => number): ServerSpec {
  const roll = rng();
  if (roll < 0.1) return { kind: 'network-error' };
  if (roll < 0.2) return { kind: 'hang' };
  return {
    kind: 'respond',
    status: pick(rng, STATUSES),
    body: generateBody(rng),
  };
}

function accountId(idx: number): string {
  return ACCOUNT_IDS[idx % ACCOUNT_IDS.length] as string;
}

function mintedAccess(idx: number): string {
  return BEARERS[idx % 3] as string;
}

/** The literal JSON body the fake server returns (never for 'unreadable'). */
function materializeBody(body: BodySpec): unknown {
  switch (body.kind) {
    case 'unreadable':
      return undefined;
    case 'array':
      return [{ user: { id: accountId(0) } }];
    case 'string':
      return 'ok';
    case 'null':
      return null;
    case 'user-not-object':
      return { user: 'user', onboardingState: 'pending' };
    case 'account': {
      const user: Record<string, unknown> = {};
      switch (body.userId) {
        case 'valid':
          user['id'] = accountId(body.accountIdx);
          break;
        case 'valid-upper':
          user['id'] = accountId(body.accountIdx).toUpperCase();
          break;
        case 'google-subject':
          user['id'] = '103547991597142817347';
          break;
        case 'apple-subject':
          user['id'] = '001234.abcdef0123456789abcdef0123456789.1234';
          break;
        case 'uuid-v0':
          user['id'] = '7fc2c743-028f-0ec6-942c-a84508f3be38';
          break;
        case 'number':
          user['id'] = 42;
          break;
        case 'missing':
          break;
      }
      switch (body.email) {
        case 'string':
          user['email'] = 'player@example.com';
          break;
        case 'empty':
          user['email'] = '';
          break;
        case 'null':
          user['email'] = null;
          break;
        case 'number':
          user['email'] = 7;
          break;
        case 'missing':
          break;
      }
      const payload: Record<string, unknown> = { user };
      switch (body.onboarding) {
        case 'pending':
        case 'complete':
          payload['onboardingState'] = body.onboarding;
          break;
        case 'other':
          payload['onboardingState'] = 'done';
          break;
        case 'missing':
          break;
      }
      const access = mintedAccess(body.accessIdx);
      const refresh = `refresh-${access}`;
      switch (body.session) {
        case 'absent':
          break;
        case 'valid':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: 1_800_000_000,
          };
          break;
        case 'valid-zero-expiry':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: 0,
          };
          break;
        case 'valid-negative-expiry':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: -1,
          };
          break;
        case 'missing-refresh':
          payload['session'] = {
            accessToken: access,
            expiresAt: 1_800_000_000,
          };
          break;
        case 'blank-access':
          payload['session'] = {
            accessToken: '   ',
            refreshToken: refresh,
            expiresAt: 1_800_000_000,
          };
          break;
        case 'blank-refresh':
          payload['session'] = {
            accessToken: access,
            refreshToken: '',
            expiresAt: 1_800_000_000,
          };
          break;
        case 'expiry-string':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: '1800000000',
          };
          break;
        case 'expiry-nan':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Number.NaN,
          };
          break;
        case 'expiry-infinite':
          payload['session'] = {
            accessToken: access,
            refreshToken: refresh,
            expiresAt: Number.POSITIVE_INFINITY,
          };
          break;
        case 'not-object':
          payload['session'] = 'session';
          break;
        case 'access-number':
          payload['session'] = {
            accessToken: 12345,
            refreshToken: refresh,
            expiresAt: 1_800_000_000,
          };
          break;
      }
      switch (body.error) {
        case 'message':
          payload['error'] = { message: 'Token verification failed.' };
          break;
        case 'blank-message':
          payload['error'] = { message: '   ' };
          break;
        case 'non-string-message':
          payload['error'] = { message: 401 };
          break;
        case 'error-string':
          payload['error'] = 'Token verification failed.';
          break;
        case 'missing':
          break;
      }
      return payload;
    }
  }
}

// ---------------------------------------------------------------------------
// Action script
// ---------------------------------------------------------------------------

type UnauthMode = 'none' | 'record' | 'clear' | 'rotate' | 'switch';
type TokenPick = 'current' | 'previous' | 'provider' | 'foreign';

interface EstablishSpec {
  accountIdx: number;
  bearerIdx: number;
  provider: AccountProvider;
  refresh: 'absent' | 'null' | 'token';
  expires: 'absent' | 'null' | 'future' | 'past';
}

interface BootstrapSpec {
  url: string | null | undefined;
  tokenIdx: number;
  provider: AccountProvider;
  codeIdx: number;
  appVersionIdx: number;
  localeIdx: number;
  server: ServerSpec;
}

type Action =
  | { kind: 'establish'; spec: EstablishSpec }
  | { kind: 'clear' }
  | { kind: 'subscribe' }
  | { kind: 'unsubscribe'; pick: number }
  | { kind: 'setUnauth'; mode: UnauthMode }
  | { kind: 'reportUnauth'; token: TokenPick }
  | { kind: 'bearerFor'; accountPick: number }
  | { kind: 'normalize'; url: string | null | undefined }
  | { kind: 'bootstrap'; spec: BootstrapSpec }
  | { kind: 'settle'; pick: number }
  | { kind: 'adopt'; pick: number }
  | { kind: 'advance'; ms: number }
  | { kind: 'flush' };

const WEIGHTED_KINDS: ReadonlyArray<[Action['kind'], number]> = [
  ['establish', 10],
  ['clear', 5],
  ['subscribe', 4],
  ['unsubscribe', 3],
  ['setUnauth', 5],
  ['reportUnauth', 9],
  ['bearerFor', 6],
  ['normalize', 8],
  ['bootstrap', 14],
  ['settle', 14],
  ['adopt', 6],
  ['advance', 5],
  ['flush', 3],
];
const TOTAL_WEIGHT = WEIGHTED_KINDS.reduce((sum, [, w]) => sum + w, 0);

function pickKind(rng: () => number): Action['kind'] {
  let roll = rng() * TOTAL_WEIGHT;
  for (const [kind, weight] of WEIGHTED_KINDS) {
    roll -= weight;
    if (roll < 0) return kind;
  }
  return 'settle';
}

const UNAUTH_MODES: readonly UnauthMode[] = [
  'none',
  'record',
  'record',
  'clear',
  'rotate',
  'switch',
];
const TOKEN_PICKS: readonly TokenPick[] = [
  'current',
  'current',
  'previous',
  'provider',
  'foreign',
];
const ADVANCES = [1, 100, 5_000, 14_999, 15_000, 15_001, 60_000] as const;

export function generateScript(seed: number): Action[] {
  const rng = mulberry32(seed);
  const length = 5 + Math.floor(rng() * 56); // 5..60
  const script: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = pickKind(rng);
    switch (kind) {
      case 'establish':
        script.push({
          kind,
          spec: {
            accountIdx: Math.floor(rng() * ACCOUNT_IDS.length),
            bearerIdx: Math.floor(rng() * BEARERS.length),
            provider: pick(rng, PROVIDERS),
            refresh: pick(rng, ['absent', 'null', 'token', 'token'] as const),
            expires: pick(rng, [
              'absent',
              'null',
              'future',
              'future',
              'past',
            ] as const),
          },
        });
        break;
      case 'unsubscribe':
        script.push({ kind, pick: Math.floor(rng() * 1000) });
        break;
      case 'setUnauth':
        script.push({ kind, mode: pick(rng, UNAUTH_MODES) });
        break;
      case 'reportUnauth':
        script.push({ kind, token: pick(rng, TOKEN_PICKS) });
        break;
      case 'bearerFor':
        script.push({
          kind,
          accountPick: Math.floor(rng() * (ACCOUNT_IDS.length + 1)),
        });
        break;
      case 'normalize':
        script.push({ kind, url: generateUrl(rng) });
        break;
      case 'bootstrap':
        script.push({
          kind,
          spec: {
            url: rng() < 0.7 ? 'https://api.pickle.example/' : generateUrl(rng),
            tokenIdx: Math.floor(rng() * PROVIDER_TOKENS.length),
            provider: pick(rng, PROVIDERS),
            codeIdx: Math.floor(rng() * APPLE_CODES.length),
            appVersionIdx: Math.floor(rng() * APP_VERSIONS.length),
            localeIdx: Math.floor(rng() * ENV_LOCALES.length),
            server: generateServer(rng),
          },
        });
        break;
      case 'settle':
      case 'adopt':
        script.push({ kind, pick: Math.floor(rng() * 1000) });
        break;
      case 'advance':
        script.push({ kind, ms: pick(rng, ADVANCES) });
        break;
      case 'clear':
      case 'subscribe':
      case 'flush':
        script.push({ kind });
        break;
    }
  }
  return script;
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'establish':
      return `establish(acct${action.spec.accountIdx},${BEARERS[action.spec.bearerIdx]},${action.spec.provider},refresh=${action.spec.refresh},expires=${action.spec.expires})`;
    case 'unsubscribe':
    case 'settle':
    case 'adopt':
      return `${action.kind}(#${action.pick})`;
    case 'setUnauth':
      return `setUnauth(${action.mode})`;
    case 'reportUnauth':
      return `reportUnauth(${action.token})`;
    case 'bearerFor':
      return `bearerFor(${action.accountPick === ACCOUNT_IDS.length ? 'unknown' : `acct${action.accountPick}`})`;
    case 'normalize':
      return `normalize(${JSON.stringify(action.url)})`;
    case 'bootstrap':
      return `bootstrap(${JSON.stringify(action.spec)})`;
    case 'advance':
      return `advance(${action.ms}ms)`;
    default:
      return action.kind;
  }
}

// ---------------------------------------------------------------------------
// Model (the documented contract, written independently of the modules)
// ---------------------------------------------------------------------------

interface ExpectedError {
  code: AccountBootstrapError['code'];
  retryable: boolean;
  message: string | null; // null = not asserted (default copy)
}

type ExpectedOutcome =
  | { kind: 'error'; error: ExpectedError }
  | { kind: 'ok'; result: AccountBootstrapResult };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '10.0.2.2']);

function modelNormalize(
  value: string | null | undefined,
): { ok: true; origin: string } | { ok: false } {
  const trimmed = value?.trim().replace(/\/+$/, '');
  if (!trimmed) return { ok: false };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'https:' && !LOCAL_HOSTS.has(parsed.hostname)) {
    return { ok: false };
  }
  return { ok: true, origin: trimmed };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function modelServerMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload['error'])) return null;
  const message = payload['error']['message'];
  return typeof message === 'string' && message.trim() ? message : null;
}

/** What the contract says a bootstrap whose fetch settled `how` must yield. */
function modelOutcome(
  spec: BootstrapSpec,
  how: 'network-error' | 'aborted' | 'responded',
): ExpectedOutcome {
  const origin = modelNormalize(spec.url);
  if (!origin.ok) {
    return {
      kind: 'error',
      error: {
        code: 'account.not_configured',
        retryable: false,
        message: null,
      },
    };
  }
  const bearer = PROVIDER_TOKENS[spec.tokenIdx]?.trim();
  if (!bearer) {
    return {
      kind: 'error',
      error: { code: 'account.invalid_token', retryable: false, message: null },
    };
  }
  if (how !== 'responded' || spec.server.kind !== 'respond') {
    return {
      kind: 'error',
      error: { code: 'account.unavailable', retryable: true, message: null },
    };
  }
  const { status, body } = spec.server;
  if (body.kind === 'unreadable') {
    return {
      kind: 'error',
      error: {
        code: 'account.invalid_response',
        retryable: true,
        message: null,
      },
    };
  }
  const payload = materializeBody(body);
  const ok = status >= 200 && status < 300;
  if (!ok) {
    if (status === 401 || status === 403) {
      return {
        kind: 'error',
        error: {
          code: 'account.rejected',
          retryable: false,
          message: modelServerMessage(payload),
        },
      };
    }
    return {
      kind: 'error',
      error: {
        code: 'account.unavailable',
        retryable: status >= 500 || status === 429,
        message: modelServerMessage(payload),
      },
    };
  }
  if (!isRecord(payload) || !isRecord(payload['user'])) {
    return {
      kind: 'error',
      error: {
        code: 'account.invalid_response',
        retryable: true,
        message: null,
      },
    };
  }
  const id = payload['user']['id'];
  const email = payload['user']['email'];
  const onboardingState = payload['onboardingState'];
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    !(email === null || typeof email === 'string') ||
    (onboardingState !== 'pending' && onboardingState !== 'complete')
  ) {
    return {
      kind: 'error',
      error: {
        code: 'account.invalid_response',
        retryable: true,
        message: null,
      },
    };
  }
  let tokens: {
    accessToken: string;
    refreshToken: string;
    expiresAtMs: number;
  } | null = null;
  const session = payload['session'];
  if (isRecord(session)) {
    const accessToken = session['accessToken'];
    const refreshToken = session['refreshToken'];
    const expiresAt = session['expiresAt'];
    if (
      typeof accessToken === 'string' &&
      accessToken.trim() &&
      typeof refreshToken === 'string' &&
      refreshToken.trim() &&
      typeof expiresAt === 'number' &&
      Number.isFinite(expiresAt)
    ) {
      tokens = { accessToken, refreshToken, expiresAtMs: expiresAt * 1000 };
    }
  }
  return {
    kind: 'ok',
    result: {
      account: { id, email, onboardingState },
      apiSession: {
        apiBaseUrl: origin.origin,
        bearerToken: tokens?.accessToken ?? bearer,
        canonicalAppUserId: id,
        provider: spec.provider,
        refreshToken: tokens?.refreshToken ?? null,
        bearerExpiresAtMs: tokens?.expiresAtMs ?? null,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime harness
// ---------------------------------------------------------------------------

interface Violation {
  invariant: string;
  step: number;
  action: string;
  detail: string;
}

interface Subscriber {
  id: number;
  seen: Array<ApiSession | null>;
  expectedCount: number;
  unsubscribe: () => void;
  active: boolean;
}

interface PendingBootstrap {
  id: number;
  spec: BootstrapSpec;
  input: AccountBootstrapInput;
  providerToken: string | null;
  fetchCalls: Array<{ url: string; init: RequestInit | undefined }>;
  signal: AbortSignal | null;
  resolveFetch: ((response: Response) => void) | null;
  rejectFetch: ((error: unknown) => void) | null;
  fetchSettled: 'pending' | 'network-error' | 'aborted' | 'responded';
  settledAtStep: number | null;
  /** Fake-clock time the call was issued; the 15 s abort is due from here. */
  startedAt: number;
  /** Model: the fetch was still pending when the fake clock passed +15 s. */
  expectAbort: boolean;
  outcome:
    | { kind: 'pending' }
    | { kind: 'ok'; result: AccountBootstrapResult }
    | { kind: 'error'; error: unknown };
  promise: Promise<void>;
}

interface RunResult {
  violation: Violation | null;
  steps: number;
  trace: string[];
}

class Harness {
  readonly violations: Violation[] = [];
  readonly trace: string[] = [];
  readonly skip: Set<string>;
  step = 0;
  action = '';

  // model state
  modelSession: ApiSession | null = null;
  previousBearer: string | null = null;
  subscribers: Subscriber[] = [];
  nextSubscriberId = 0;
  unauthMode: UnauthMode = 'none';
  unauthCalls: ApiSession[] = [];
  expectedUnauthCalls: ApiSession[] = [];
  bootstraps: PendingBootstrap[] = [];
  nextBootstrapId = 0;
  lastAdoptedProviderToken: string | null = null;

  constructor(skip: Set<string>) {
    this.skip = skip;
  }

  fail(invariant: string, detail: string): void {
    if (this.skip.has(invariant)) return;
    this.violations.push({
      invariant,
      step: this.step,
      action: this.action,
      detail,
    });
  }

  check(invariant: string, condition: boolean, detail: () => string): void {
    if (!condition) this.fail(invariant, detail());
  }

  // ----- store actions -----

  makeSession(spec: EstablishSpec): ApiSession {
    const session: ApiSession = {
      apiBaseUrl: 'https://api.pickle.example',
      bearerToken: BEARERS[spec.bearerIdx % BEARERS.length] as string,
      canonicalAppUserId: accountId(spec.accountIdx),
      provider: spec.provider,
    };
    if (spec.refresh === 'null') session.refreshToken = null;
    if (spec.refresh === 'token')
      session.refreshToken = `refresh-${session.bearerToken}`;
    if (spec.expires === 'null') session.bearerExpiresAtMs = null;
    if (spec.expires === 'future')
      session.bearerExpiresAtMs = 1_800_000_000_000;
    if (spec.expires === 'past') session.bearerExpiresAtMs = 1_000;
    return session;
  }

  /** Applies a store mutation to the model and the real store together. */
  applyEstablish(session: ApiSession): void {
    this.previousBearer = this.modelSession?.bearerToken ?? this.previousBearer;
    this.modelSession = session;
    for (const sub of this.subscribers) if (sub.active) sub.expectedCount += 1;
    establishApiSession(session);
  }

  applyClear(): void {
    this.previousBearer = this.modelSession?.bearerToken ?? this.previousBearer;
    this.modelSession = null;
    for (const sub of this.subscribers) if (sub.active) sub.expectedCount += 1;
    clearApiSession();
  }

  installUnauth(mode: UnauthMode): void {
    this.unauthMode = mode;
    if (mode === 'none') {
      setApiUnauthorizedListener(null);
      return;
    }
    setApiUnauthorizedListener(session => {
      this.unauthCalls.push(session);
      // Re-entrant effects mirror what authStore's handler may do.
      if (mode === 'clear') {
        this.modelSession = null;
        for (const sub of this.subscribers)
          if (sub.active) sub.expectedCount += 1;
        clearApiSession();
      } else if (mode === 'rotate') {
        const next: ApiSession = {
          ...session,
          bearerToken: `${session.bearerToken}-rotated`,
        };
        this.modelSession = next;
        for (const sub of this.subscribers)
          if (sub.active) sub.expectedCount += 1;
        establishApiSession(next);
      } else if (mode === 'switch') {
        const next: ApiSession = {
          apiBaseUrl: session.apiBaseUrl,
          bearerToken: 'sb-access-switched',
          canonicalAppUserId: UNKNOWN_ACCOUNT_ID,
          provider: session.provider,
        };
        this.modelSession = next;
        for (const sub of this.subscribers)
          if (sub.active) sub.expectedCount += 1;
        establishApiSession(next);
      }
    });
  }

  resolveToken(pick: TokenPick): string {
    switch (pick) {
      case 'current':
        return this.modelSession?.bearerToken ?? 'sb-access-none';
      case 'previous':
        return this.previousBearer ?? 'sb-access-none';
      case 'provider':
        return this.lastAdoptedProviderToken ?? 'provider-jwt-A';
      case 'foreign':
        return 'foreign-bearer';
    }
  }

  // ----- bootstrap plumbing -----

  startBootstrap(spec: BootstrapSpec): PendingBootstrap {
    const id = this.nextBootstrapId++;
    const providerToken = PROVIDER_TOKENS[spec.tokenIdx];
    const environment: AccountBootstrapEnvironment = {
      locale: ENV_LOCALES[spec.localeIdx % ENV_LOCALES.length] as string,
      timezone: 'America/Los_Angeles',
      device: {
        platform: 'ios',
        osVersion: '18.5',
        appVersion: APP_VERSIONS[
          spec.appVersionIdx % APP_VERSIONS.length
        ] as string,
        model: 'iOS phone',
      },
    };
    const code = APPLE_CODES[spec.codeIdx % APPLE_CODES.length];
    const input: AccountBootstrapInput = {
      apiBaseUrl: spec.url,
      bearerToken: providerToken,
      provider: spec.provider,
      environment,
    };
    if (code !== undefined) input.appleAuthorizationCode = code;
    const pending: PendingBootstrap = {
      id,
      spec,
      input,
      providerToken: providerToken?.trim() || null,
      fetchCalls: [],
      signal: null,
      resolveFetch: null,
      rejectFetch: null,
      fetchSettled: 'pending',
      settledAtStep: null,
      startedAt: Date.now(),
      expectAbort: false,
      outcome: { kind: 'pending' },
      promise: Promise.resolve(),
    };
    input.fetchFn = (url: string, init?: RequestInit): Promise<Response> => {
      pending.fetchCalls.push({ url, init });
      const signal = init?.signal ?? null;
      pending.signal = signal;
      return new Promise<Response>((resolve, reject) => {
        pending.resolveFetch = resolve;
        pending.rejectFetch = reject;
        signal?.addEventListener('abort', () => {
          if (pending.fetchSettled === 'pending') {
            pending.fetchSettled = 'aborted';
            pending.settledAtStep = this.step;
            reject(
              new DOMException('The operation was aborted.', 'AbortError'),
            );
          }
        });
      });
    };
    pending.promise = bootstrapCanonicalAccount(input).then(
      result => {
        pending.outcome = { kind: 'ok', result };
      },
      (error: unknown) => {
        pending.outcome = { kind: 'error', error };
      },
    );
    this.bootstraps.push(pending);
    return pending;
  }

  settleBootstrap(pending: PendingBootstrap): void {
    if (pending.fetchSettled !== 'pending' || !pending.resolveFetch) return;
    const server = pending.spec.server;
    if (server.kind === 'hang') return;
    pending.settledAtStep = this.step;
    if (server.kind === 'network-error') {
      pending.fetchSettled = 'network-error';
      pending.rejectFetch?.(new TypeError('Network request failed'));
      return;
    }
    pending.fetchSettled = 'responded';
    const body = server.body;
    const response = {
      ok: server.status >= 200 && server.status < 300,
      status: server.status,
      json: () =>
        body.kind === 'unreadable'
          ? Promise.reject(new SyntaxError('Unexpected end of JSON input'))
          : Promise.resolve(materializeBody(body)),
    } as unknown as Response;
    pending.resolveFetch(response);
  }

  async flush(): Promise<void> {
    for (let i = 0; i < 25; i += 1) await Promise.resolve();
  }

  /** Moves the fake clock and records which in-flight fetches are due to
   * abort at the new time (model side of B5). */
  advance(ms: number): void {
    const target = Date.now() + ms;
    for (const p of this.bootstraps) {
      if (
        p.fetchCalls.length > 0 &&
        p.fetchSettled === 'pending' &&
        p.startedAt + 15_000 <= target
      ) {
        p.expectAbort = true;
      }
    }
    jest.advanceTimersByTime(ms);
  }

  // ----- invariant checks -----

  checkStore(): void {
    const actual = getApiSession();
    this.check(
      'S1',
      actual === this.modelSession,
      () =>
        `getApiSession()=${JSON.stringify(actual)} model=${JSON.stringify(this.modelSession)}`,
    );
    for (const id of [...ACCOUNT_IDS, UNKNOWN_ACCOUNT_ID]) {
      const expected =
        this.modelSession && this.modelSession.canonicalAppUserId === id
          ? this.modelSession.bearerToken
          : null;
      const got = bearerTokenFor(id);
      this.check(
        'S2',
        got === expected,
        () => `bearerTokenFor(${id})=${got} expected=${expected}`,
      );
    }
    for (const sub of this.subscribers) {
      this.check(
        'S3',
        sub.seen.length === sub.expectedCount,
        () =>
          `subscriber#${sub.id} notifications=${sub.seen.length} expected=${sub.expectedCount} active=${sub.active}`,
      );
      if (sub.active && sub.expectedCount > 0) {
        const last = sub.seen[sub.seen.length - 1];
        this.check(
          'S3',
          last === this.modelSession,
          () =>
            `subscriber#${sub.id} last=${JSON.stringify(last)} model=${JSON.stringify(this.modelSession)}`,
        );
      }
    }
    this.check(
      'S4',
      this.unauthCalls.length === this.expectedUnauthCalls.length &&
        this.unauthCalls.every((s, i) => s === this.expectedUnauthCalls[i]),
      () =>
        `unauthorized listener calls=${JSON.stringify(this.unauthCalls.map(s => s.bearerToken))} expected=${JSON.stringify(this.expectedUnauthCalls.map(s => s.bearerToken))}`,
    );
  }

  checkBootstraps(): void {
    for (const p of this.bootstraps) {
      const tag = `bootstrap#${p.id}`;
      const preflight = modelOutcome(p.spec, 'network-error');
      const shouldFetch =
        preflight.kind !== 'error' ||
        preflight.error.code === 'account.unavailable';
      this.check(
        'B1',
        p.fetchCalls.length === (shouldFetch ? 1 : 0),
        () =>
          `${tag} fetch calls=${p.fetchCalls.length} expected=${shouldFetch ? 1 : 0} spec=${JSON.stringify(p.spec)}`,
      );
      const call = p.fetchCalls[0];
      if (call && shouldFetch) {
        const origin = modelNormalize(p.spec.url);
        const expectedUrl = origin.ok
          ? `${origin.origin}/v1/account/bootstrap`
          : '<none>';
        this.check(
          'B2',
          call.url === expectedUrl,
          () => `${tag} url=${call.url} expected=${expectedUrl}`,
        );
        let sentPath: string | null = null;
        try {
          sentPath = new URL(call.url).pathname;
        } catch {
          sentPath = null;
        }
        this.check(
          'N2',
          sentPath !== null && sentPath.endsWith('/v1/account/bootstrap'),
          () =>
            `${tag} fetched ${JSON.stringify(call.url)} whose path ${JSON.stringify(sentPath)} is not the bootstrap route`,
        );
        const headers = (call.init?.headers ?? {}) as Record<string, string>;
        this.check(
          'B2',
          call.init?.method === 'POST' &&
            headers['Authorization'] === `Bearer ${p.providerToken}` &&
            headers['X-Client-Version'] ===
              p.input.environment.device.appVersion &&
            headers['Accept'] === 'application/json' &&
            headers['Content-Type'] === 'application/json',
          () =>
            `${tag} method=${call.init?.method} headers=${JSON.stringify(headers)} provider token=${JSON.stringify(p.providerToken)}`,
        );
        const code = p.input.appleAuthorizationCode?.trim();
        const appleCode =
          p.spec.provider === 'apple' && code ? code : undefined;
        this.check(
          'B2',
          (headers['X-Apple-Revocation-Protocol'] === '1') ===
            (appleCode !== undefined),
          () =>
            `${tag} revocation header=${headers['X-Apple-Revocation-Protocol']} provider=${p.spec.provider} code=${JSON.stringify(p.input.appleAuthorizationCode)}`,
        );
        const bodyText = String(call.init?.body);
        let body: unknown = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          this.fail('B2', `${tag} body is not JSON: ${bodyText}`);
        }
        const expectedBody = {
          ...p.input.environment,
          ...(appleCode !== undefined
            ? { appleAuthorizationCode: appleCode }
            : {}),
        };
        this.check(
          'B2',
          JSON.stringify(body) === JSON.stringify(expectedBody),
          () =>
            `${tag} body=${bodyText} expected=${JSON.stringify(expectedBody)}`,
        );
        this.check(
          'B2',
          p.providerToken === null || !bodyText.includes(p.providerToken),
          () => `${tag} body leaks the provider token`,
        );
        this.check(
          'B5',
          p.signal !== null,
          () => `${tag} fetch received no abort signal`,
        );
      }
      // Timer / signal discipline: the abort fires iff the fetch was still
      // pending when the fake clock passed startedAt + 15 s (model-tracked in
      // `advance`), and never after the fetch settled (clearTimeout ran).
      if (p.signal) {
        this.check(
          'B5',
          p.signal.aborted === p.expectAbort &&
            (p.fetchSettled === 'aborted') === p.expectAbort,
          () =>
            `${tag} signal.aborted=${p.signal?.aborted} fetchSettled=${p.fetchSettled} expectAbort=${p.expectAbort} startedAt=${p.startedAt} now=${Date.now()} settledAtStep=${p.settledAtStep}`,
        );
      }
      // Outcome once the promise had a chance to settle (flush ran).
      const fetchDone = p.fetchSettled !== 'pending';
      if (!shouldFetch || fetchDone) {
        this.check(
          'B5',
          p.outcome.kind !== 'pending',
          () =>
            `${tag} promise still pending after flush (fetchSettled=${p.fetchSettled}, settledAtStep=${p.settledAtStep})`,
        );
      } else {
        this.check(
          'B5',
          p.outcome.kind === 'pending',
          () =>
            `${tag} settled before its fetch did: ${describeOutcome(p.outcome)}`,
        );
      }
      if (p.outcome.kind === 'pending') continue;
      const how =
        p.fetchSettled === 'pending' ? 'network-error' : p.fetchSettled;
      const expected = modelOutcome(p.spec, how);
      if (expected.kind === 'error') {
        const err = p.outcome.kind === 'error' ? p.outcome.error : null;
        this.check(
          'B3',
          p.outcome.kind === 'error' &&
            err instanceof AccountBootstrapError &&
            err.code === expected.error.code &&
            err.retryable === expected.error.retryable &&
            (expected.error.message === null ||
              err.message === expected.error.message) &&
            err.name === 'AccountBootstrapError' &&
            typeof err.message === 'string' &&
            err.message.trim().length > 0,
          () =>
            `${tag} outcome=${describeOutcome(p.outcome)} expected error ${JSON.stringify(expected.error)} spec=${JSON.stringify(p.spec)} how=${how}`,
        );
      } else {
        this.check(
          'B3',
          p.outcome.kind === 'ok' &&
            JSON.stringify(p.outcome.result) ===
              JSON.stringify(expected.result),
          () =>
            `${tag} outcome=${describeOutcome(p.outcome)} expected ok ${JSON.stringify(expected.result)} spec=${JSON.stringify(p.spec)}`,
        );
        if (p.outcome.kind === 'ok') {
          const serialized = JSON.stringify(p.outcome.result);
          const code = p.input.appleAuthorizationCode?.trim();
          this.check(
            'B4',
            !code || !serialized.includes(code),
            () => `${tag} result leaks the Apple authorization code`,
          );
          this.check(
            'B4',
            UUID.test(p.outcome.result.apiSession.canonicalAppUserId) &&
              p.outcome.result.apiSession.canonicalAppUserId ===
                p.outcome.result.account.id,
            () =>
              `${tag} canonicalAppUserId=${p.outcome.kind === 'ok' ? p.outcome.result.apiSession.canonicalAppUserId : ''}`,
          );
        }
      }
    }
  }

  checkNormalize(url: string | null | undefined): void {
    const expected = modelNormalize(url);
    let got: { ok: true; origin: string } | { ok: false; error: unknown };
    try {
      got = { ok: true, origin: normalizeApiBaseUrl(url) };
    } catch (error) {
      got = { ok: false, error };
    }
    this.trace.push(
      `normalize ${JSON.stringify(url)} -> ${got.ok ? got.origin : 'throw'}`,
    );
    if (expected.ok) {
      this.check(
        'N1',
        got.ok && got.origin === expected.origin,
        () =>
          `normalize(${JSON.stringify(url)}) = ${got.ok ? got.origin : describeError(got.error)} expected ${expected.origin}`,
      );
      if (got.ok) {
        const origin = got.origin;
        this.check(
          'N1',
          !origin.endsWith('/') && origin === origin.trim(),
          () => `normalize(${JSON.stringify(url)}) not canonical: ${origin}`,
        );
        let idempotent = false;
        try {
          idempotent = normalizeApiBaseUrl(origin) === origin;
        } catch {
          idempotent = false;
        }
        this.check(
          'N1',
          idempotent,
          () => `normalize is not idempotent on ${origin}`,
        );
        let requestPath: string | null = null;
        try {
          requestPath = new URL(`${origin}/v1/account/bootstrap`).pathname;
        } catch {
          requestPath = null;
        }
        this.check(
          'N2',
          requestPath !== null && requestPath.endsWith('/v1/account/bootstrap'),
          () =>
            `origin ${JSON.stringify(origin)} (from ${JSON.stringify(url)}) composes into request path ${JSON.stringify(requestPath)} — the server would not route it to /v1/account/bootstrap`,
        );
      }
    } else {
      this.check(
        'N1',
        !got.ok &&
          got.error instanceof AccountBootstrapError &&
          got.error.code === 'account.not_configured' &&
          got.error.retryable === false,
        () =>
          `normalize(${JSON.stringify(url)}) = ${got.ok ? got.origin : describeError(got.error)} expected not_configured`,
      );
    }
  }

  // ----- step executor -----

  async run(script: Action[]): Promise<RunResult> {
    clearApiSession();
    setApiUnauthorizedListener(null);
    jest.useFakeTimers();
    try {
      for (let i = 0; i < script.length; i += 1) {
        const action = script[i];
        if (!action) continue;
        this.step = i;
        this.action = describeAction(action);
        await this.execute(action);
        await this.flush();
        this.checkStore();
        this.checkBootstraps();
        this.trace.push(
          `${i}:${this.action} => session=${JSON.stringify(getApiSession())} unauth=${this.unauthCalls.length} bootstraps=${this.bootstraps.map(p => `${p.id}:${p.fetchSettled}:${p.outcome.kind}`).join(',')}`,
        );
        if (this.violations.length > 0) break;
      }
      // Drain: everything still hanging must abort after 15 s of fake time.
      if (this.violations.length === 0) {
        this.step = script.length;
        this.action = 'drain';
        this.advance(15_001);
        await this.flush();
        this.checkStore();
        this.checkBootstraps();
        for (const p of this.bootstraps) {
          this.check(
            'B5',
            p.outcome.kind !== 'pending',
            () => `bootstrap#${p.id} never settled after drain`,
          );
        }
      }
    } finally {
      for (const sub of this.subscribers) if (sub.active) sub.unsubscribe();
      setApiUnauthorizedListener(null);
      clearApiSession();
      jest.useRealTimers();
    }
    return {
      violation: this.violations[0] ?? null,
      steps: Math.min(this.step + 1, script.length),
      trace: this.trace,
    };
  }

  async execute(action: Action): Promise<void> {
    switch (action.kind) {
      case 'establish':
        this.applyEstablish(this.makeSession(action.spec));
        return;
      case 'clear':
        this.applyClear();
        return;
      case 'subscribe': {
        const sub: Subscriber = {
          id: this.nextSubscriberId++,
          seen: [],
          expectedCount: 0,
          unsubscribe: () => undefined,
          active: true,
        };
        sub.unsubscribe = subscribeToApiSession(session => {
          sub.seen.push(session);
          // Consumers read the store inside the callback (syncRuntime does).
          this.check(
            'S3',
            getApiSession() === session,
            () => `subscriber#${sub.id} callback session ≠ getApiSession()`,
          );
        });
        this.subscribers.push(sub);
        return;
      }
      case 'unsubscribe': {
        const active = this.subscribers.filter(s => s.active);
        if (active.length === 0) return;
        const sub = active[action.pick % active.length];
        if (!sub) return;
        sub.unsubscribe();
        sub.active = false;
        return;
      }
      case 'setUnauth':
        this.installUnauth(action.mode);
        return;
      case 'reportUnauth': {
        const token = this.resolveToken(action.token);
        const current = this.modelSession;
        if (
          current &&
          current.bearerToken === token &&
          this.unauthMode !== 'none'
        ) {
          this.expectedUnauthCalls.push(current);
        }
        reportApiUnauthorized(token);
        return;
      }
      case 'bearerFor': {
        const id =
          action.accountPick >= ACCOUNT_IDS.length
            ? UNKNOWN_ACCOUNT_ID
            : accountId(action.accountPick);
        const got = bearerTokenFor(id);
        this.trace.push(`bearerFor(${id}) -> ${got}`);
        return; // S2 is asserted in checkStore for every id
      }
      case 'normalize':
        this.checkNormalize(action.url);
        return;
      case 'bootstrap':
        this.startBootstrap(action.spec);
        return;
      case 'settle': {
        const open = this.bootstraps.filter(
          p => p.fetchSettled === 'pending' && p.fetchCalls.length > 0,
        );
        if (open.length === 0) return;
        const target = open[action.pick % open.length];
        if (target) this.settleBootstrap(target);
        return;
      }
      case 'adopt': {
        const done = this.bootstraps.filter(p => p.outcome.kind === 'ok');
        if (done.length === 0) return;
        const target = done[action.pick % done.length];
        if (!target || target.outcome.kind !== 'ok') return;
        const { result } = target.outcome;
        this.applyEstablish(result.apiSession);
        this.lastAdoptedProviderToken = target.providerToken;
        // X1: the adopted bearer resolves for its account, and the provider
        // token is the bearer iff the server minted no session.
        this.check(
          'X1',
          bearerTokenFor(result.account.id) === result.apiSession.bearerToken,
          () =>
            `bearerTokenFor(${result.account.id})=${bearerTokenFor(result.account.id)} adopted bearer=${result.apiSession.bearerToken}`,
        );
        const providerIsBearer =
          result.apiSession.refreshToken === null &&
          result.apiSession.bearerToken === target.providerToken;
        const before = this.unauthCalls.length;
        if (this.unauthMode !== 'none' && providerIsBearer) {
          this.expectedUnauthCalls.push(result.apiSession);
        }
        if (target.providerToken !== null) {
          reportApiUnauthorized(target.providerToken);
        }
        const fired = this.unauthCalls.length > before;
        this.check(
          'X1',
          fired === (this.unauthMode !== 'none' && providerIsBearer),
          () =>
            `reportApiUnauthorized(providerToken) fired=${fired} refreshToken=${result.apiSession.refreshToken} bearer=${result.apiSession.bearerToken} providerToken=${target.providerToken} mode=${this.unauthMode}`,
        );
        return;
      }
      case 'advance':
        this.advance(action.ms);
        return;
      case 'flush':
        return;
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof AccountBootstrapError) {
    return `AccountBootstrapError(${error.code}, retryable=${error.retryable}, ${JSON.stringify(error.message)})`;
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function describeOutcome(outcome: PendingBootstrap['outcome']): string {
  if (outcome.kind === 'pending') return 'pending';
  if (outcome.kind === 'ok') return `ok ${JSON.stringify(outcome.result)}`;
  return `error ${describeError(outcome.error)}`;
}

const SKIP = new Set(
  (process.env.STRESS_SKIP ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
);

async function runScript(script: Action[]): Promise<RunResult> {
  return new Harness(SKIP).run(script);
}

// ---------------------------------------------------------------------------
// ddmin over the action list
// ---------------------------------------------------------------------------

async function minimizeScript(
  script: Action[],
  budget = 400,
): Promise<{ script: Action[]; runs: number }> {
  let current = script;
  let runs = 0;
  const fails = async (candidate: Action[]) => {
    runs += 1;
    return (await runScript(candidate)).violation !== null;
  };
  let n = 2;
  while (current.length >= 2 && runs < budget) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (
      let start = 0;
      start < current.length && runs < budget;
      start += chunk
    ) {
      const complement = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (complement.length > 0 && (await fails(complement))) {
        current = complement;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(n * 2, current.length);
    }
  }
  return { script: current, runs };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

interface SeedRow {
  seed: number;
  length: number;
  steps: number;
  outcome: 'HELD' | 'BROKEN' | 'NONDETERMINISTIC';
  violation: Violation | null;
  minimized: { length: number; runs: number; script: string[] } | null;
}

const ITER = Number(process.env.STRESS_ITER ?? 200);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260905);
const REPLAY =
  process.env.STRESS_REPLAY !== undefined
    ? Number(process.env.STRESS_REPLAY)
    : null;
const OUT = process.env.STRESS_OUT;

function traceKey(result: RunResult): string {
  return JSON.stringify({ v: result.violation, t: result.trace });
}

describe('bootstrap + apiSession randomized seeded long-run', () => {
  jest.setTimeout(20 * 60 * 1000);

  it(`holds every invariant over ${REPLAY === null ? ITER : 1} seeded action sequences, deterministically`, async () => {
    const seeds =
      REPLAY !== null
        ? [REPLAY]
        : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
    const rows: SeedRow[] = [];
    let executedSteps = 0;
    const actionMix: Record<string, number> = {};

    for (const seed of seeds) {
      const script = generateScript(seed);
      for (const a of script) actionMix[a.kind] = (actionMix[a.kind] ?? 0) + 1;
      const first = await runScript(script);
      const second = await runScript(script);
      executedSteps += first.steps + second.steps;
      const deterministic = traceKey(first) === traceKey(second);
      let row: SeedRow = {
        seed,
        length: script.length,
        steps: first.steps,
        outcome: !deterministic
          ? 'NONDETERMINISTIC'
          : first.violation
            ? 'BROKEN'
            : 'HELD',
        violation: first.violation,
        minimized: null,
      };
      if (row.outcome === 'BROKEN') {
        const { script: small, runs } = await minimizeScript(script);
        const replay = await runScript(small);
        row = {
          ...row,
          violation: replay.violation ?? first.violation,
          minimized: {
            length: small.length,
            runs,
            script: small.map(describeAction),
          },
        };
      }
      rows.push(row);
    }

    const summary = {
      unit: [
        'apps/mobile/src/account/bootstrap.ts',
        'apps/mobile/src/account/apiSession.ts',
      ],
      lens: 'randomized-seeded',
      baseSeed: BASE_SEED,
      sequences: rows.length,
      executedSteps,
      actionMix,
      held: rows.filter(r => r.outcome === 'HELD').length,
      broken: rows.filter(r => r.outcome === 'BROKEN').length,
      nondeterministic: rows.filter(r => r.outcome === 'NONDETERMINISTIC')
        .length,
      byInvariant: rows.reduce<Record<string, number>>((acc, r) => {
        if (r.violation)
          acc[r.violation.invariant] = (acc[r.violation.invariant] ?? 0) + 1;
        return acc;
      }, {}),
      rows,
    };
    if (OUT) {
      mkdirSync(dirname(OUT), { recursive: true });
      writeFileSync(OUT, JSON.stringify(summary, null, 2));
    }

    const failures = rows
      .filter(r => r.outcome !== 'HELD')
      .map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        invariant: r.violation?.invariant,
        step: r.violation?.step,
        action: r.violation?.action,
        detail: r.violation?.detail,
        minimized: r.minimized?.script,
      }));
    expect(failures).toEqual([]);
    expect(rows.length).toBe(seeds.length);
  });
});
