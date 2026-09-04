/// <reference types="node" />
/**
 * Seeded randomized long-run harness for `src/data/api.ts` (unit
 * `mod-api-client`).
 *
 * Every sequence is fully determined by its seed: the generator draws the
 * action list AND every server reply (status, body shape, latency, body
 * stall, duplicate/late delivery, network failure) from a mulberry32 stream,
 * then the runner executes it against the REAL `api.ts` under jest modern
 * fake timers with a scripted `fetch`. Invariants (see `Violation`, each
 * anchored to a line of `api.ts`) are checked after every step, and the
 * trace of a run contains no wall-clock data, so `runSequence(seed)` twice
 * must produce byte-identical traces.
 *
 * Nothing in production code is mocked; only `fetch` and the clock are.
 *
 * Invariants modelled from the module contract:
 *  I1  bounded        every call settles ≤ API_REQUEST_TIMEOUT_MS after it
 *                     was issued (`api.ts` 61-64 "Every request is bound to
 *                     one timeout").                     → unbounded_await
 *  I2  timeout_typed  a server that never answers yields exactly
 *                     ApiError{408,'network.timeout'} at t0+20000 and the
 *                     scripted fetch observed the abort (`api.ts` 88-95).
 *                                     → timeout_not_typed / timeout_time_drift
 *  I3  no_false_to    a reply landing before the deadline never yields 408.
 *                                                        → false_timeout
 *  I4  error_map      non-2xx → ApiError carrying the response status;
 *                     `code` is a string (`readonly code: string`, `api.ts`
 *                     49) and `message` is a non-empty string sourced from a
 *                     string (`api.ts` 108-111).
 *        → error_not_api_error / error_status_mismatch / error_code_mismatch
 *          / error_code_not_string / error_message_not_string_source
 *          / error_message_empty
 *  I5  ok_identity    2xx → the resolved value is the parsed body itself
 *                     (`api.ts` 113 `return json as T`); whether that body
 *                     satisfies the consumer contract (`sync.ts` 12-27,
 *                     `api.ts` 260-272) is recorded.
 *                                → ok_result_not_body / unvalidated_2xx_escape
 *  I6  unauthorized   `reportApiUnauthorized(sentToken)` fires iff
 *                     status===401 and a token was sent; the listener fires
 *                     iff that token is still the session bearer when the
 *                     reply is processed (`api.ts` 103-105,
 *                     `apiSession.ts` 87-91).   → unauthorized_report_mismatch
 *  I7  permit_parse   `reserve()` resolves iff the permit passes
 *                     `parseReservedPermit` (`api.ts` 195-216) and is
 *                     'reserved', yielding exactly
 *                     {id,accessSource,status:'reserved',expiresAt} with
 *                     `access` = `parseReserveAccess` (`api.ts` 221-249) or
 *                     null; otherwise ApiError 502 / 409 (`api.ts` 155-169).
 *                                                  → permit_parse_mismatch
 *  I8  signed_out     reserve/release with a null/blank token reject
 *                     ApiError{401,'auth.required'} WITHOUT touching fetch
 *                     (`api.ts` 137-145).            → signed_out_guard_fetch
 *  I9  request_shape  exactly one fetch per call; URL = baseUrl+path (ids
 *                     URL-encoded where the module does so), method,
 *                     content-type, x-client-version, authorization iff a
 *                     token, body = JSON.stringify(arg) or absent
 *                     (`api.ts` 73-84).  → fetch_count_mismatch /
 *                                          request_shape_mismatch
 *  I10 timer_hygiene  the abort timer is cleared once fetch settles
 *                     (`api.ts` 97 `finally { clearTimeout(timer) }`).
 *                                                        → timer_leak
 *  I11 passthrough    a non-abort fetch rejection is rethrown as the SAME
 *                     error, never wrapped (`api.ts` 96).
 *                                                  → network_error_wrapped
 *  I12 late_ignored   a duplicate/late delivery never changes a settled
 *                     outcome and never fires I6.  → late_response_observed
 *  I13 typed_2xx      a 2xx whose body the module reads structurally
 *                     (`api.ts` 155 `response.permit`, 272
 *                     `response.feedback.reviewEligible`) yields either the
 *                     documented value or an ApiError, never a raw TypeError.
 *                                                  → untyped_error_on_2xx
 *  I14 determinism    same seed twice → identical trace (checked by the
 *                     suite through `traceDigest`).
 */
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  api,
  createAnalysisPermitClient,
  createTransport,
  submitAnalysisFeedback,
  type ApiConfigState,
  type ReleasableAnalysisOutcome,
} from '../../src/data/api';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import { Rng } from '../matrix/networkAuthHarness';

/** Captured at module load, before any test installs fake timers, so the
 * runner can drain the microtask queue deterministically. */
const realSetImmediate = setImmediate;

export const BASE_URL = 'https://stress.example.test';
export const APP_USER = 'stress-canonical-app-user';
/** Fake-time budget flushed after each step so late/stalled deliveries and
 * never-settling promises are observable (10× the client timeout). */
export const FLUSH_MS = API_REQUEST_TIMEOUT_MS * 10;

// ─── Generated model ──────────────────────────────────────────────────────

export type Op =
  | 'reserve'
  | 'release'
  | 'syncShots'
  | 'createSession'
  | 'finalizeSession'
  | 'uploadTrials'
  | 'feedback'
  | 'raw';

export const OPS: readonly Op[] = [
  'reserve',
  'release',
  'syncShots',
  'createSession',
  'finalizeSession',
  'uploadTrials',
  'feedback',
  'raw',
];

export type ReplyKind =
  | 'ok_valid'
  | 'ok_mutated'
  | 'ok_non_object'
  | 'ok_unparseable'
  | 'ok_oversized'
  | 'error_json'
  | 'error_nonjson'
  | 'hang'
  | 'late'
  | 'duplicate'
  | 'network_error'
  | 'foreign_abort'
  | 'body_stall'
  | 'slow_body';

export const REPLY_KINDS: readonly ReplyKind[] = [
  'ok_valid',
  'ok_mutated',
  'ok_non_object',
  'ok_unparseable',
  'ok_oversized',
  'error_json',
  'error_nonjson',
  'hang',
  'late',
  'duplicate',
  'network_error',
  'foreign_abort',
  'body_stall',
  'slow_body',
];

export interface Reply {
  kind: ReplyKind;
  /** Fake ms after the call until the scripted fetch settles. null = never. */
  latencyMs: number | null;
  /** Second delivery of the same response (duplicate). null = none. */
  secondDeliveryMs: number | null;
  status: number;
  statusText: string;
  /** Parsed JSON value handed out by `response.json()` (unused when
   * `jsonRejects`). */
  body: unknown;
  jsonRejects: boolean;
  /** Extra delay before `response.json()` settles. null = never. */
  bodyDelayMs: number | null;
  /** Reject `fetch` with this error instead of resolving. */
  fetchError: 'network' | 'foreign_abort' | null;
  /** Whether `body` satisfies the consumer contract for the op. */
  bodyValid: boolean;
}

export interface FeedbackArgs {
  analysisId: string;
  rating: 'accurate' | 'not_quite';
  category:
    | 'wrong_stroke'
    | 'wrong_player'
    | 'contact_looks_wrong'
    | 'feedback_mismatch'
    | 'other'
    | null;
}

export interface ReleaseArgs {
  permitId: string;
  outcome: ReleasableAnalysisOutcome;
}

export interface RawArgs {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  body: unknown;
}

export interface Call {
  id: number;
  op: Op;
  /** Serializable argument; interpretation depends on `op`. */
  arg: unknown;
  reply: Reply;
}

export type RotationScope = 'both' | 'session' | 'config';

export interface Rotation {
  token: string | null;
  /** `both`: config token and session bearer move together (the
   * `bearerTokenFor` wiring); `session`: only the session rotates (a stale
   * transport config); `config`: only the transport's token changes. */
  scope: RotationScope;
}

export type Step =
  | { kind: 'call'; call: Call }
  | {
      kind: 'batch';
      calls: Call[];
      rotateAtMs: number | null;
      rotation: Rotation | null;
    }
  | { kind: 'rotate'; rotation: Rotation };

export interface Sequence {
  seed: number;
  initialToken: string | null;
  steps: Step[];
}

// ─── Generators ───────────────────────────────────────────────────────────

const ERROR_STATUSES = [
  400, 401, 402, 403, 404, 405, 409, 410, 413, 422, 429, 500, 502, 503, 504,
];
const ERROR_CODES = [
  'auth.required',
  'auth.invalid_token',
  'access.paywall_required',
  'access.permit_not_found',
  'analysis.feedback_exists',
  'rate_limited',
  'shot.write_failed',
  'internal',
];
const PERMIT_IDS = [
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  'p/with/slashes',
  'p?q=1&r=2',
  'ünïcödé-permit',
  'p with spaces',
  '../../auth/logout',
  '#fragment',
];
const RELEASE_OUTCOMES: readonly ReleasableAnalysisOutcome[] = [
  'low_confidence',
  'cancelled',
  'failed',
  'unsupported',
  'incorrect_recognition',
];

function bigString(rng: Rng, minLen: number, maxLen: number): string {
  return 'x'.repeat(rng.int(minLen, maxLen));
}

function wrongType(rng: Rng): unknown {
  return rng.pick<unknown>([
    123,
    0,
    -1,
    1e308,
    0.5,
    true,
    false,
    null,
    {},
    [],
    '',
    '   ',
    'FREE',
    ['free'],
    { nested: 'object' },
  ]);
}

function validPermit(rng: Rng): Record<string, unknown> {
  return {
    id: rng.pick(PERMIT_IDS),
    accessSource: rng.pick(['free', 'premium']),
    status: 'reserved',
    expiresAt: '2026-09-04T22:00:00.000Z',
  };
}

function validAccess(rng: Rng): Record<string, unknown> {
  return {
    premium: rng.chance(0.3),
    freeRatings: {
      limit: rng.int(0, 5),
      used: rng.int(0, 5),
      reserved: rng.int(0, 2),
      remaining: rng.int(0, 5),
      availableToReserve: rng.int(0, 5),
    },
  };
}

function mutateObject(
  rng: Rng,
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  const keys = Object.keys(out);
  const mutations = rng.int(1, 3);
  for (let i = 0; i < mutations; i += 1) {
    const which = rng.int(0, 3);
    const key = keys.length ? rng.pick(keys) : 'k';
    if (which === 0) {
      delete out[key];
    } else if (which === 1) {
      out[key] = wrongType(rng);
    } else if (which === 2) {
      out[`extra_${rng.int(0, 99)}`] = wrongType(rng);
    } else {
      const inner = out[key];
      if (isObj(inner)) out[key] = mutateObject(rng, inner);
      else out[key] = wrongType(rng);
    }
  }
  return out;
}

function validBodyFor(op: Op, rng: Rng): unknown {
  switch (op) {
    case 'reserve': {
      const body: Record<string, unknown> = { permit: validPermit(rng) };
      const accessRoll = rng.int(0, 3);
      if (accessRoll === 1) body.access = validAccess(rng);
      if (accessRoll === 2) body.access = null;
      return body;
    }
    case 'release':
      return rng.chance(0.5)
        ? {}
        : { permit: { ...validPermit(rng), status: 'released' } };
    case 'syncShots':
      return {
        acceptedIds: Array.from({ length: rng.int(0, 4) }, (_, i) => `s${i}`),
        rejected: rng.chance(0.3)
          ? [{ id: 'sX', code: 'shot.write_failed', message: 'retry' }]
          : [],
      };
    case 'createSession':
      return { session: { id: 'sess-1' } };
    case 'finalizeSession':
      return { ok: true };
    case 'uploadTrials':
      return {
        acceptedTrialIds: Array.from(
          { length: rng.int(0, 4) },
          (_, i) => `t${i}`,
        ),
        rejected: [],
      };
    case 'feedback':
      return { feedback: { reviewEligible: rng.chance(0.5) } };
    case 'raw':
      return { ok: true, echo: rng.int(0, 1000) };
  }
}

export function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Consumer contract for the parsed 2xx body (`sync.ts` 12-27, `api.ts`
 * 147-173, 260-272). `createSession`/`finalizeSession`/`release`/`raw`
 * ignore the body, so any value is valid for them. */
export function bodyValidFor(op: Op, body: unknown): boolean {
  const strArr = (v: unknown): boolean =>
    Array.isArray(v) && v.every(x => typeof x === 'string');
  switch (op) {
    case 'reserve': {
      if (!isObj(body)) return false;
      const p = body.permit;
      return (
        isObj(p) &&
        typeof p.id === 'string' &&
        p.id.trim().length > 0 &&
        (p.accessSource === 'free' || p.accessSource === 'premium') &&
        p.status === 'reserved' &&
        typeof p.expiresAt === 'string'
      );
    }
    case 'syncShots':
      return (
        isObj(body) && strArr(body.acceptedIds) && Array.isArray(body.rejected)
      );
    case 'uploadTrials':
      return (
        isObj(body) &&
        strArr(body.acceptedTrialIds) &&
        Array.isArray(body.rejected)
      );
    case 'feedback':
      return (
        isObj(body) &&
        isObj(body.feedback) &&
        typeof body.feedback.reviewEligible === 'boolean'
      );
    case 'release':
    case 'createSession':
    case 'finalizeSession':
    case 'raw':
      return true;
  }
}

function genLatency(rng: Rng): number {
  const roll = rng.next();
  if (roll < 0.05) return 0;
  if (roll < 0.65) return rng.int(1, 500);
  if (roll < 0.9) return rng.int(501, 5000);
  return rng.int(5001, API_REQUEST_TIMEOUT_MS - 1);
}

function genReplyKind(rng: Rng): ReplyKind {
  const roll = rng.next();
  if (roll < 0.28) return 'ok_valid';
  if (roll < 0.46) return 'ok_mutated';
  if (roll < 0.51) return 'ok_non_object';
  if (roll < 0.56) return 'ok_unparseable';
  if (roll < 0.59) return 'ok_oversized';
  if (roll < 0.74) return 'error_json';
  if (roll < 0.81) return 'error_nonjson';
  if (roll < 0.85) return 'hang';
  if (roll < 0.88) return 'late';
  if (roll < 0.91) return 'duplicate';
  if (roll < 0.94) return 'network_error';
  if (roll < 0.95) return 'foreign_abort';
  if (roll < 0.98) return 'body_stall';
  return 'slow_body';
}

function genErrorEnvelope(rng: Rng): unknown {
  const roll = rng.next();
  if (roll < 0.55) {
    return {
      error: { code: rng.pick(ERROR_CODES), message: 'Server said no.' },
    };
  }
  if (roll < 0.65) return { error: { code: rng.pick(ERROR_CODES) } };
  if (roll < 0.72) return { error: { message: 'no code' } };
  if (roll < 0.8) return { error: { code: wrongType(rng), message: 'typed' } };
  if (roll < 0.88) {
    return { error: { code: rng.pick(ERROR_CODES), message: wrongType(rng) } };
  }
  if (roll < 0.94) {
    return {
      error: {
        code: rng.pick(ERROR_CODES),
        message: bigString(rng, 10_000, 200_000),
      },
    };
  }
  return { error: null };
}

export function genReply(rng: Rng, op: Op): Reply {
  const kind = genReplyKind(rng);
  const base: Reply = {
    kind,
    latencyMs: genLatency(rng),
    secondDeliveryMs: null,
    status: 200,
    statusText: 'OK',
    body: undefined,
    jsonRejects: false,
    bodyDelayMs: 0,
    fetchError: null,
    bodyValid: true,
  };
  const okStatus = (): number => rng.pick([200, 201, 202, 204]);
  const withBody = (status: number, body: unknown): Reply => ({
    ...base,
    status,
    body,
    bodyValid: bodyValidFor(op, body),
  });
  switch (kind) {
    case 'ok_valid':
      return withBody(okStatus(), validBodyFor(op, rng));
    case 'ok_mutated': {
      const valid = validBodyFor(op, rng);
      return withBody(
        okStatus(),
        isObj(valid) ? mutateObject(rng, valid) : wrongType(rng),
      );
    }
    case 'ok_non_object':
      return withBody(
        okStatus(),
        rng.pick<unknown>([null, [], 'ok', 42, true, '', [1, 2]]),
      );
    case 'ok_unparseable':
      return {
        ...base,
        status: okStatus(),
        body: undefined,
        jsonRejects: true,
        bodyValid: bodyValidFor(op, null),
      };
    case 'ok_oversized': {
      const valid = validBodyFor(op, rng);
      const body: Record<string, unknown> = isObj(valid)
        ? { ...valid }
        : { value: valid };
      const shape = rng.int(0, 3);
      if (shape === 0) {
        body.padding = bigString(rng, 200_000, 1_000_000);
      } else if (shape === 1) {
        for (let i = 0; i < 20_000; i += 1) body[`k${i}`] = i;
      } else if (shape === 2) {
        let deep: unknown = 'leaf';
        for (let i = 0; i < 2_000; i += 1) deep = { d: deep };
        body.deep = deep;
      } else if (op === 'reserve' && isObj(body.permit)) {
        body.permit = { ...body.permit, id: bigString(rng, 100_000, 300_000) };
      } else {
        body.list = Array.from({ length: 50_000 }, (_, i) => `id-${i}`);
      }
      return withBody(okStatus(), body);
    }
    case 'error_json':
      return {
        ...base,
        status: rng.pick(ERROR_STATUSES),
        statusText: 'Error',
        body: genErrorEnvelope(rng),
        bodyValid: false,
      };
    case 'error_nonjson':
      return {
        ...base,
        status: rng.pick(ERROR_STATUSES),
        statusText: rng.pick(['', 'Bad Gateway', 'Not Found']),
        body: undefined,
        jsonRejects: true,
        bodyValid: false,
      };
    case 'hang':
      return { ...base, latencyMs: null, bodyValid: false };
    case 'late': {
      const unauthorized = rng.chance(0.3);
      const body = unauthorized
        ? { error: { code: 'auth.invalid_token', message: 'late' } }
        : validBodyFor(op, rng);
      return {
        ...base,
        latencyMs: rng.int(API_REQUEST_TIMEOUT_MS, API_REQUEST_TIMEOUT_MS * 3),
        status: unauthorized ? 401 : okStatus(),
        statusText: unauthorized ? 'Unauthorized' : 'OK',
        body,
        bodyValid: unauthorized ? false : bodyValidFor(op, body),
      };
    }
    case 'duplicate': {
      const latency = genLatency(rng);
      const unauthorized = rng.chance(0.3);
      const body = unauthorized
        ? { error: { code: 'auth.invalid_token', message: 'dup' } }
        : validBodyFor(op, rng);
      return {
        ...base,
        latencyMs: latency,
        secondDeliveryMs: latency + rng.int(1, 30_000),
        status: unauthorized ? 401 : okStatus(),
        statusText: unauthorized ? 'Unauthorized' : 'OK',
        body,
        bodyValid: unauthorized ? false : bodyValidFor(op, body),
      };
    }
    case 'network_error':
      return { ...base, fetchError: 'network', bodyValid: false };
    case 'foreign_abort':
      return { ...base, fetchError: 'foreign_abort', bodyValid: false };
    case 'body_stall': {
      const body = validBodyFor(op, rng);
      const stall = rng.int(0, 2);
      return {
        ...base,
        status: okStatus(),
        body,
        bodyDelayMs:
          stall === 0 ? null : stall === 1 ? 30_000 : API_REQUEST_TIMEOUT_MS,
        bodyValid: bodyValidFor(op, body),
      };
    }
    case 'slow_body': {
      const body = validBodyFor(op, rng);
      const latency = rng.int(0, API_REQUEST_TIMEOUT_MS - 2);
      return {
        ...base,
        latencyMs: latency,
        status: okStatus(),
        body,
        bodyDelayMs: rng.int(1, API_REQUEST_TIMEOUT_MS - 1 - latency),
        bodyValid: bodyValidFor(op, body),
      };
    }
  }
}

function genArg(rng: Rng, op: Op): unknown {
  switch (op) {
    case 'reserve':
      return `idem-${rng.int(0, 1_000_000)}`;
    case 'release': {
      const arg: ReleaseArgs = {
        permitId: rng.pick(PERMIT_IDS),
        outcome: rng.pick(RELEASE_OUTCOMES),
      };
      return arg;
    }
    case 'syncShots':
      return Array.from({ length: rng.int(0, 5) }, (_, i) => ({
        id: `shot-${i}`,
        score: rng.int(0, 100),
      }));
    case 'createSession':
      return { id: `sess-${rng.int(0, 999)}`, startedAt: 1_700_000_000_000 };
    case 'finalizeSession':
      return rng.pick(['sess-1', 'sess/2', 'sess 3', 'ünï']);
    case 'uploadTrials':
      return Array.from({ length: rng.int(0, 3) }, (_, i) => ({
        trialId: `trial-${i}`,
      }));
    case 'feedback': {
      const arg: FeedbackArgs = {
        analysisId: `analysis-${rng.int(0, 999)}`,
        rating: rng.pick(['accurate', 'not_quite']),
        category: rng.pick([
          null,
          'wrong_stroke',
          'wrong_player',
          'contact_looks_wrong',
          'feedback_mismatch',
          'other',
        ]),
      };
      return arg;
    }
    case 'raw': {
      const arg: RawArgs = {
        method: rng.pick(['GET', 'POST', 'DELETE']),
        path: rng.pick(['/v1/me/access', '/v1/me/rank', '/v1/sessions']),
        body: rng.chance(0.5) ? { n: rng.int(0, 9) } : undefined,
      };
      return arg;
    }
  }
}

function genRotation(rng: Rng, counter: { n: number }): Rotation {
  const roll = rng.next();
  let token: string | null;
  if (roll < 0.7) {
    counter.n += 1;
    token = `token-${counter.n}`;
  } else if (roll < 0.8) token = null;
  else if (roll < 0.88) token = '';
  else if (roll < 0.93) token = '   ';
  else token = `token-${counter.n}`;
  const scopeRoll = rng.next();
  const scope: RotationScope =
    scopeRoll < 0.7 ? 'both' : scopeRoll < 0.85 ? 'session' : 'config';
  return { token, scope };
}

/** Every instant (fake ms after step start) at which a reply or body for one
 * of `calls` is delivered, plus the client deadline. */
function deliveryInstants(calls: readonly Call[]): Set<number> {
  const taken = new Set<number>([API_REQUEST_TIMEOUT_MS]);
  for (const c of calls) {
    const r = c.reply;
    if (r.latencyMs !== null) {
      taken.add(r.latencyMs);
      if (r.bodyDelayMs) taken.add(r.latencyMs + r.bodyDelayMs);
    }
    if (r.secondDeliveryMs !== null) taken.add(r.secondDeliveryMs);
  }
  return taken;
}

export function generateSequence(seed: number): Sequence {
  const rng = new Rng(seed);
  const length = rng.int(5, 60);
  const counter = { n: 0 };
  const initialToken = rng.chance(0.85) ? 'token-0' : null;
  const steps: Step[] = [];
  let nextId = 0;
  const genCall = (): Call => {
    const op = rng.pick(OPS);
    return { id: nextId++, op, arg: genArg(rng, op), reply: genReply(rng, op) };
  };
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.86) {
      steps.push({ kind: 'call', call: genCall() });
    } else if (roll < 0.94) {
      steps.push({ kind: 'rotate', rotation: genRotation(rng, counter) });
    } else {
      const calls = Array.from({ length: rng.int(2, 6) }, genCall);
      const rotation = rng.chance(0.6) ? genRotation(rng, counter) : null;
      let rotateAtMs: number | null = null;
      if (rotation) {
        rotateAtMs = rng.int(1, API_REQUEST_TIMEOUT_MS + 5_000);
        // Same-tick ordering between the rotation timer and a delivery timer
        // would be a harness artefact, not api.ts behaviour: keep distinct.
        const taken = deliveryInstants(calls);
        while (taken.has(rotateAtMs)) rotateAtMs += 1;
      }
      steps.push({ kind: 'batch', calls, rotateAtMs, rotation });
    }
  }
  return { seed, initialToken, steps };
}

// ─── Scripted fetch ───────────────────────────────────────────────────────

interface FetchRecord {
  callId: number;
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
  abortedAtMs: number | null;
  deliveries: number;
}

class ScriptedFetch {
  readonly records: FetchRecord[] = [];
  private queue: Call[] = [];
  private pendingTimers = 0;

  outstandingTimers(): number {
    return this.pendingTimers;
  }

  expect(call: Call): void {
    this.queue.push(call);
  }

  private timer(ms: number, fn: () => void): void {
    this.pendingTimers += 1;
    setTimeout(() => {
      this.pendingTimers -= 1;
      fn();
    }, ms);
  }

  readonly fetch = (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const call = this.queue.shift();
    if (!call) {
      return Promise.reject(new Error('harness: unexpected fetch'));
    }
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (isObj(rawHeaders)) {
      for (const [k, v] of Object.entries(rawHeaders)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }
    const record: FetchRecord = {
      callId: call.id,
      url: typeof input === 'string' ? input : String(input),
      method: init?.method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
      abortedAtMs: null,
      deliveries: 0,
    };
    this.records.push(record);
    const signal = init?.signal ?? null;
    const reply = call.reply;
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        record.abortedAtMs = Date.now();
        if (settled) return;
        settled = true;
        const err = new Error('Aborted');
        err.name = 'AbortError';
        reject(err);
      };
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort);
      }
      const deliver = (): void => {
        record.deliveries += 1;
        if (settled) return;
        settled = true;
        if (reply.fetchError === 'network') {
          reject(new TypeError('Network request failed'));
          return;
        }
        if (reply.fetchError === 'foreign_abort') {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        resolve(this.makeResponse(reply));
      };
      if (reply.latencyMs === null) return;
      if (reply.latencyMs === 0) deliver();
      else this.timer(reply.latencyMs, deliver);
      if (reply.secondDeliveryMs !== null) {
        this.timer(reply.secondDeliveryMs, deliver);
      }
    });
  };

  private makeResponse(reply: Reply): Response {
    const json = (): Promise<unknown> => {
      if (reply.bodyDelayMs === null) return new Promise<unknown>(() => {});
      if (reply.bodyDelayMs === 0) {
        return reply.jsonRejects
          ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
          : Promise.resolve(reply.body);
      }
      const delay = reply.bodyDelayMs;
      return new Promise<unknown>((resolve, reject) => {
        this.timer(delay, () => {
          if (reply.jsonRejects) reject(new SyntaxError('Unexpected end'));
          else resolve(reply.body);
        });
      });
    };
    const response = {
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      statusText: reply.statusText,
      json,
    };
    return response as unknown as Response;
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────

export type Violation =
  | 'unbounded_await'
  | 'timeout_not_typed'
  | 'timeout_time_drift'
  | 'false_timeout'
  | 'error_not_api_error'
  | 'error_status_mismatch'
  | 'error_code_mismatch'
  | 'error_code_not_string'
  | 'error_message_not_string_source'
  | 'error_message_empty'
  | 'ok_result_not_body'
  | 'unvalidated_2xx_escape'
  | 'untyped_error_on_2xx'
  | 'unauthorized_report_mismatch'
  | 'permit_parse_mismatch'
  | 'signed_out_guard_fetch'
  | 'request_shape_mismatch'
  | 'fetch_count_mismatch'
  | 'timer_leak'
  | 'network_error_wrapped'
  | 'late_response_observed'
  | 'settled_early'
  | 'unexpected_outcome';

export interface ViolationRecord {
  stepIndex: number;
  callId: number | null;
  op: Op | null;
  replyKind: ReplyKind | null;
  violation: Violation;
  detail: string;
}

interface CallOutcome {
  settled: boolean;
  settledAtMs: number | null;
  resolved: boolean;
  value: unknown;
  error: unknown;
}

export interface TraceCall {
  id: number;
  op: Op;
  reply: ReplyKind;
  status: number;
  settledAtMs: number | null;
  outcome: string;
}

export interface TraceEntry {
  step: number;
  kind: Step['kind'];
  calls: TraceCall[];
  listenerCalls: number;
  violations: Violation[];
}

export interface SequenceResult {
  seed: number;
  length: number;
  callCount: number;
  violations: ViolationRecord[];
  trace: TraceEntry[];
  /** FNV-1a digest of the JSON trace for determinism comparison. */
  traceDigest: string;
}

function digest(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
}

function describeOutcome(outcome: CallOutcome): string {
  if (!outcome.settled) return 'pending';
  if (outcome.resolved) {
    const v = outcome.value;
    if (v === undefined) return 'resolved:undefined';
    if (v === null) return 'resolved:null';
    if (typeof v !== 'object') return `resolved:${typeof v}`;
    return `resolved:object(${Object.keys(v).length})`;
  }
  const e = outcome.error;
  if (e instanceof ApiError) return `ApiError:${e.status}:${String(e.code)}`;
  if (e instanceof Error) return `${e.name}:${e.message.slice(0, 40)}`;
  return `thrown:${typeof e}`;
}

type ExpectedKind =
  'resolve' | 'api_error' | 'passthrough_error' | 'untyped_error';

interface Expected {
  /** Fake ms after step start at which the call must settle; null = the
   * module contract is violated by construction (body never arrives) and I1
   * records it. */
  settleAtMs: number | null;
  kind: ExpectedKind;
  status?: number;
  code?: unknown;
  /** Model-side parse of the reserve body. */
  reserved?: { permit: Record<string, unknown>; access: unknown };
  /** Model-side result for feedback. */
  feedback?: { reviewEligible: unknown };
  sentToken: string | null;
  fetchExpected: boolean;
  /** Fake ms (after step start) at which api.ts would call
   * reportApiUnauthorized, or null. */
  unauthorizedReportAtMs: number | null;
}

type ModelReserve =
  | { kind: 'ok'; permit: Record<string, unknown>; access: unknown }
  | { kind: 'invalid' }
  | { kind: 'not_reserved' };

function modelParseReserve(body: Record<string, unknown>): ModelReserve {
  const permit = body.permit;
  if (
    !isObj(permit) ||
    typeof permit.id !== 'string' ||
    permit.id.trim().length === 0 ||
    (permit.accessSource !== 'free' && permit.accessSource !== 'premium') ||
    typeof permit.expiresAt !== 'string'
  ) {
    return { kind: 'invalid' };
  }
  if (permit.status !== 'reserved') return { kind: 'not_reserved' };
  const accessRaw = body.access;
  let access: unknown = null;
  if (isObj(accessRaw) && isObj(accessRaw.freeRatings)) {
    const fr = accessRaw.freeRatings;
    const keys = [
      'limit',
      'used',
      'reserved',
      'remaining',
      'availableToReserve',
    ];
    const allFinite = keys.every(k => {
      const n = fr[k];
      return typeof n === 'number' && Number.isFinite(n);
    });
    if (allFinite && typeof accessRaw.premium === 'boolean') {
      access = {
        premium: accessRaw.premium,
        freeRatings: {
          limit: fr.limit,
          used: fr.used,
          reserved: fr.reserved,
          remaining: fr.remaining,
          availableToReserve: fr.availableToReserve,
        },
      };
    }
  }
  return {
    kind: 'ok',
    permit: {
      id: permit.id,
      accessSource: permit.accessSource,
      status: 'reserved',
      expiresAt: permit.expiresAt,
    },
    access,
  };
}

function expectedFor(call: Call, configToken: string | null): Expected {
  const { op, reply } = call;
  if ((op === 'reserve' || op === 'release') && !(configToken ?? '').trim()) {
    return {
      settleAtMs: 0,
      kind: 'api_error',
      status: 401,
      code: 'auth.required',
      sentToken: null,
      fetchExpected: false,
      unauthorizedReportAtMs: null,
    };
  }
  const base = {
    sentToken: configToken,
    fetchExpected: true,
    unauthorizedReportAtMs: null,
  };
  if (reply.latencyMs === null || reply.latencyMs >= API_REQUEST_TIMEOUT_MS) {
    return {
      ...base,
      settleAtMs: API_REQUEST_TIMEOUT_MS,
      kind: 'api_error',
      status: 408,
      code: 'network.timeout',
    };
  }
  if (reply.fetchError) {
    return { ...base, settleAtMs: reply.latencyMs, kind: 'passthrough_error' };
  }
  const body: unknown = reply.jsonRejects ? null : reply.body;
  const ok = reply.status >= 200 && reply.status < 300;
  const bodySettle =
    reply.bodyDelayMs === null ? null : reply.latencyMs + reply.bodyDelayMs;
  if (!ok) {
    const env = isObj(body) && isObj(body.error) ? body.error : null;
    const code = env && env.code != null ? env.code : 'unknown';
    return {
      ...base,
      settleAtMs: bodySettle,
      kind: 'api_error',
      status: reply.status,
      code,
      unauthorizedReportAtMs:
        reply.status === 401 && configToken ? bodySettle : null,
    };
  }
  if (op === 'reserve') {
    // `api.ts` 155 dereferences `response.permit` on the parsed body.
    if (body === null) {
      return { ...base, settleAtMs: bodySettle, kind: 'untyped_error' };
    }
    const parsed: ModelReserve = isObj(body)
      ? modelParseReserve(body)
      : { kind: 'invalid' };
    if (parsed.kind === 'invalid') {
      return {
        ...base,
        settleAtMs: bodySettle,
        kind: 'api_error',
        status: 502,
        code: 'access.permit_invalid',
      };
    }
    if (parsed.kind === 'not_reserved') {
      return {
        ...base,
        settleAtMs: bodySettle,
        kind: 'api_error',
        status: 409,
        code: 'access.permit_not_reserved',
      };
    }
    return {
      ...base,
      settleAtMs: bodySettle,
      kind: 'resolve',
      reserved: { permit: parsed.permit, access: parsed.access },
    };
  }
  if (op === 'feedback') {
    // `api.ts` 272 dereferences `response.feedback.reviewEligible`.
    if (body === null) {
      return { ...base, settleAtMs: bodySettle, kind: 'untyped_error' };
    }
    const fb = isObj(body) ? body.feedback : undefined;
    if (fb === null || fb === undefined) {
      return { ...base, settleAtMs: bodySettle, kind: 'untyped_error' };
    }
    return {
      ...base,
      settleAtMs: bodySettle,
      kind: 'resolve',
      feedback: { reviewEligible: isObj(fb) ? fb.reviewEligible : undefined },
    };
  }
  return { ...base, settleAtMs: bodySettle, kind: 'resolve' };
}

interface RequestShape {
  url: string;
  method: string;
  body: string | undefined;
}

function expectedRequestShape(call: Call): RequestShape {
  const { op, arg } = call;
  const j = (v: unknown): string => JSON.stringify(v);
  switch (op) {
    case 'reserve':
      return {
        url: `${BASE_URL}/v1/analysis-permits`,
        method: 'POST',
        body: j({ idempotencyKey: arg }),
      };
    case 'release': {
      const a = arg as ReleaseArgs;
      return {
        url: `${BASE_URL}/v1/analysis-permits/${encodeURIComponent(a.permitId)}/finalize`,
        method: 'POST',
        body: j({ outcome: a.outcome, ratingId: null }),
      };
    }
    case 'syncShots':
      return {
        url: `${BASE_URL}/v1/shots:sync`,
        method: 'POST',
        body: j({ shots: arg }),
      };
    case 'createSession':
      return { url: `${BASE_URL}/v1/sessions`, method: 'POST', body: j(arg) };
    case 'finalizeSession':
      return {
        url: `${BASE_URL}/v1/sessions/${String(arg)}/finalize`,
        method: 'POST',
        body: undefined,
      };
    case 'uploadTrials':
      return {
        url: `${BASE_URL}/v1/me/evaluation/trials`,
        method: 'POST',
        body: j({ trials: arg }),
      };
    case 'feedback': {
      const a = arg as FeedbackArgs;
      return {
        url: `${BASE_URL}/v1/analyses/${encodeURIComponent(a.analysisId)}/feedback`,
        method: 'POST',
        body: j({ rating: a.rating, category: a.category }),
      };
    }
    case 'raw': {
      const a = arg as RawArgs;
      return {
        url: `${BASE_URL}${a.path}`,
        method: a.method,
        body: a.body === undefined ? undefined : j(a.body),
      };
    }
  }
}

function invoke(call: Call, config: ApiConfigState): Promise<unknown> {
  const { op, arg } = call;
  switch (op) {
    case 'reserve':
      return createAnalysisPermitClient(config).reserve(String(arg));
    case 'release': {
      const a = arg as ReleaseArgs;
      return createAnalysisPermitClient(config).release(a.permitId, a.outcome);
    }
    case 'syncShots':
      return createTransport(config).syncShots(arg as unknown[]);
    case 'createSession':
      return createTransport(config).createSession(arg);
    case 'finalizeSession':
      return createTransport(config).finalizeSession(String(arg));
    case 'uploadTrials': {
      const transport = createTransport(config);
      if (!transport.uploadEvaluationTrials) {
        return Promise.reject(new Error('harness: transport lacks trials'));
      }
      return transport.uploadEvaluationTrials(arg as unknown[]);
    }
    case 'feedback': {
      const a = arg as FeedbackArgs;
      return submitAnalysisFeedback(config, a.analysisId, a.rating, a.category);
    }
    case 'raw': {
      const a = arg as RawArgs;
      return api.request(config, a.method, a.path, a.body);
    }
  }
}

export interface RunOptions {
  /** Execute these steps instead of the generated ones (minimizer/replay). */
  steps?: Step[];
}

/**
 * Executes one generated sequence against the real module. Must be called
 * inside a jest test with modern fake timers installed.
 */
export async function runSequence(
  seed: number,
  options: RunOptions = {},
): Promise<SequenceResult> {
  const sequence = generateSequence(seed);
  const steps = options.steps ?? sequence.steps;
  const scripted = new ScriptedFetch();
  const violations: ViolationRecord[] = [];
  const trace: TraceEntry[] = [];
  let callCount = 0;

  const realFetch = globalThis.fetch;
  globalThis.fetch = scripted.fetch as typeof fetch;

  let configToken: string | null = sequence.initialToken;
  let sessionBearer: string | null = sequence.initialToken;
  const config: ApiConfigState = {
    baseUrl: BASE_URL,
    get token(): string | null {
      return configToken;
    },
  };
  const listenerBearers: string[] = [];
  setApiUnauthorizedListener(session => {
    listenerBearers.push(session.bearerToken);
  });
  const applySession = (bearer: string | null): void => {
    sessionBearer = bearer;
    if (bearer === null) clearApiSession();
    else {
      establishApiSession({
        apiBaseUrl: BASE_URL,
        bearerToken: bearer,
        canonicalAppUserId: APP_USER,
        provider: 'apple',
      });
    }
  };
  applySession(sessionBearer);
  const applyRotation = (rotation: Rotation): void => {
    if (rotation.scope === 'both' || rotation.scope === 'config') {
      configToken = rotation.token;
    }
    if (rotation.scope === 'both' || rotation.scope === 'session') {
      applySession(rotation.token);
    }
  };

  const drainMicrotasks = (): Promise<void> =>
    new Promise<void>(resolve => {
      realSetImmediate(resolve);
    });
  const advance = async (ms: number): Promise<void> => {
    if (ms > 0) await jest.advanceTimersByTimeAsync(ms);
    await drainMicrotasks();
  };

  const record = (
    stepIndex: number,
    call: Call | null,
    violation: Violation,
    detail: string,
  ): void => {
    violations.push({
      stepIndex,
      callId: call?.id ?? null,
      op: call?.op ?? null,
      replyKind: call?.reply.kind ?? null,
      violation,
      detail,
    });
  };

  try {
    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex]!;
      const entry: TraceEntry = {
        step: stepIndex,
        kind: step.kind,
        calls: [],
        listenerCalls: 0,
        violations: [],
      };
      if (step.kind === 'rotate') {
        applyRotation(step.rotation);
        trace.push(entry);
        continue;
      }
      const calls = step.kind === 'call' ? [step.call] : step.calls;
      const stepStart = Date.now();
      const elapsed = (): number => Date.now() - stepStart;
      const listenerBefore = listenerBearers.length;
      const fetchBefore = scripted.records.length;

      // api.ts reads the token synchronously at call start (`api.ts` 69).
      const tokenAtStart = configToken;
      const expectations = calls.map(c => expectedFor(c, tokenAtStart));
      const outcomes: CallOutcome[] = calls.map(() => ({
        settled: false,
        settledAtMs: null,
        resolved: false,
        value: undefined,
        error: undefined,
      }));

      const rotateAt =
        step.kind === 'batch' && step.rotation ? step.rotateAtMs : null;
      const bearerBefore = sessionBearer;
      const bearerAfterRotation =
        step.kind === 'batch' &&
        step.rotation &&
        step.rotation.scope !== 'config'
          ? step.rotation.token
          : bearerBefore;
      if (step.kind === 'batch' && step.rotation && rotateAt !== null) {
        const rot = step.rotation;
        setTimeout(() => applyRotation(rot), rotateAt);
      }

      calls.forEach((call, i) => {
        // fetch is reached synchronously inside invoke() (api.ts:73), so the
        // scripted replies are consumed in issue order.
        if (expectations[i]!.fetchExpected) scripted.expect(call);
        callCount += 1;
        invoke(call, config).then(
          value => {
            outcomes[i]!.settled = true;
            outcomes[i]!.settledAtMs = elapsed();
            outcomes[i]!.resolved = true;
            outcomes[i]!.value = value;
          },
          (error: unknown) => {
            outcomes[i]!.settled = true;
            outcomes[i]!.settledAtMs = elapsed();
            outcomes[i]!.error = error;
          },
        );
      });

      // Event-driven clock: verify pending state one tick before every
      // expected settlement, then flush far past the deadline so stalls and
      // late/duplicate deliveries become observable.
      const instants = Array.from(
        new Set(
          expectations
            .map(e => e.settleAtMs)
            .filter((t): t is number => t !== null && t > 0),
        ),
      ).sort((a, b) => a - b);
      await advance(0);
      for (const t of instants) {
        if (t - 1 > elapsed()) await advance(t - 1 - elapsed());
        outcomes.forEach((o, i) => {
          const e = expectations[i]!;
          if (e.settleAtMs !== null && e.settleAtMs >= t && o.settled) {
            record(
              stepIndex,
              calls[i]!,
              'settled_early',
              `settled at +${o.settledAtMs}ms, expected +${e.settleAtMs}ms`,
            );
          }
        });
        await advance(1);
      }
      await advance(FLUSH_MS - elapsed());

      // ── Invariant checks ────────────────────────────────────────────────
      const fetchRecords = scripted.records.slice(fetchBefore);
      outcomes.forEach((o, i) => {
        const call = calls[i]!;
        const e = expectations[i]!;
        const recs = fetchRecords.filter(r => r.callId === call.id);
        const rec = recs[0] ?? null;
        entry.calls.push({
          id: call.id,
          op: call.op,
          reply: call.reply.kind,
          status: call.reply.status,
          settledAtMs: o.settledAtMs,
          outcome: describeOutcome(o),
        });

        // I8 / I9
        if (!e.fetchExpected) {
          if (recs.length !== 0) {
            record(
              stepIndex,
              call,
              'signed_out_guard_fetch',
              `fetch ×${recs.length} with token=${JSON.stringify(tokenAtStart)}`,
            );
          }
        } else if (recs.length !== 1) {
          record(
            stepIndex,
            call,
            'fetch_count_mismatch',
            `fetch ×${recs.length}`,
          );
        } else if (rec) {
          const shape = expectedRequestShape(call);
          const authExpected = tokenAtStart
            ? `Bearer ${tokenAtStart}`
            : undefined;
          const problems: string[] = [];
          if (rec.url !== shape.url) problems.push(`url ${rec.url}`);
          if (rec.method !== shape.method)
            problems.push(`method ${rec.method}`);
          if (rec.body !== shape.body) problems.push('body');
          if (rec.headers['content-type'] !== 'application/json') {
            problems.push('content-type');
          }
          if (
            rec.headers['x-client-version'] !==
            getRuntimePublicConfig().appVersion
          ) {
            problems.push('x-client-version');
          }
          if (rec.headers.authorization !== authExpected) {
            problems.push(`authorization ${rec.headers.authorization}`);
          }
          if (problems.length) {
            record(
              stepIndex,
              call,
              'request_shape_mismatch',
              problems.join('; '),
            );
          }
        }

        // I1
        if (!o.settled) {
          record(
            stepIndex,
            call,
            'unbounded_await',
            `still pending after +${FLUSH_MS}ms (latency ${call.reply.latencyMs}ms, body delay ${call.reply.bodyDelayMs}ms)`,
          );
          return;
        }
        const settledAt = o.settledAtMs ?? 0;
        if (settledAt > API_REQUEST_TIMEOUT_MS) {
          record(
            stepIndex,
            call,
            'unbounded_await',
            `settled at +${settledAt}ms > ${API_REQUEST_TIMEOUT_MS}ms (latency ${call.reply.latencyMs}ms, body delay ${call.reply.bodyDelayMs}ms)`,
          );
        }
        if (e.settleAtMs !== null && settledAt !== e.settleAtMs) {
          record(
            stepIndex,
            call,
            e.status === 408 ? 'timeout_time_drift' : 'unexpected_outcome',
            `settled +${settledAt}ms, expected +${e.settleAtMs}ms`,
          );
        }
        // I12: a duplicate delivery must never be the one that settles.
        if (
          call.reply.secondDeliveryMs !== null &&
          settledAt === call.reply.secondDeliveryMs &&
          call.reply.secondDeliveryMs !== e.settleAtMs
        ) {
          record(
            stepIndex,
            call,
            'late_response_observed',
            `settled at the duplicate delivery +${settledAt}ms`,
          );
        }

        const err = o.error;
        if (o.resolved) {
          if (e.kind !== 'resolve') {
            record(
              stepIndex,
              call,
              'unexpected_outcome',
              `resolved (${describeOutcome(o)}) but model expects ${e.kind} ${e.status ?? ''} ${String(e.code ?? '')}`,
            );
            return;
          }
          if (call.op === 'reserve') {
            const got = JSON.stringify(o.value);
            const want = JSON.stringify(e.reserved);
            if (got !== want) {
              record(
                stepIndex,
                call,
                'permit_parse_mismatch',
                `got ${got?.slice(0, 160)} expected ${want?.slice(0, 160)}`,
              );
            }
          } else if (call.op === 'feedback') {
            const v = o.value;
            if (!isObj(v) || v.reviewEligible !== e.feedback?.reviewEligible) {
              record(
                stepIndex,
                call,
                'unexpected_outcome',
                `feedback resolved ${JSON.stringify(v)}`,
              );
            }
            if (typeof e.feedback?.reviewEligible !== 'boolean') {
              record(
                stepIndex,
                call,
                'unvalidated_2xx_escape',
                `submitAnalysisFeedback resolved reviewEligible=${String(e.feedback?.reviewEligible)} (status ${call.reply.status})`,
              );
            }
          } else if (
            call.op === 'release' ||
            call.op === 'createSession' ||
            call.op === 'finalizeSession'
          ) {
            // `await request(...)` with no return (api.ts 122, 125, 181).
            if (o.value !== undefined) {
              record(stepIndex, call, 'unexpected_outcome', describeOutcome(o));
            }
          } else {
            const expectedBody = call.reply.jsonRejects
              ? null
              : call.reply.body;
            if (o.value !== expectedBody) {
              record(stepIndex, call, 'ok_result_not_body', describeOutcome(o));
            }
            if (
              (call.op === 'syncShots' || call.op === 'uploadTrials') &&
              !call.reply.bodyValid
            ) {
              record(
                stepIndex,
                call,
                'unvalidated_2xx_escape',
                `${call.op} resolved ${describeOutcome(o)} for status ${call.reply.status} body ${JSON.stringify(expectedBody)?.slice(0, 80)}`,
              );
            }
          }
          return;
        }

        // Rejected.
        if (e.kind === 'resolve') {
          if (err instanceof ApiError && err.status === 408) {
            record(stepIndex, call, 'false_timeout', describeOutcome(o));
          } else {
            record(
              stepIndex,
              call,
              'unexpected_outcome',
              `rejected ${describeOutcome(o)} but model expects resolve`,
            );
          }
          return;
        }
        if (e.kind === 'untyped_error') {
          if (err instanceof ApiError) {
            record(
              stepIndex,
              call,
              'unexpected_outcome',
              `typed ${describeOutcome(o)} where model predicts TypeError`,
            );
          } else {
            record(
              stepIndex,
              call,
              'untyped_error_on_2xx',
              `${call.op}: ${describeOutcome(o)} for status ${call.reply.status} body ${JSON.stringify(call.reply.jsonRejects ? null : call.reply.body)?.slice(0, 100)}`,
            );
          }
          return;
        }
        if (e.kind === 'passthrough_error') {
          if (err instanceof ApiError) {
            record(
              stepIndex,
              call,
              'network_error_wrapped',
              describeOutcome(o),
            );
          } else if (
            !(err instanceof Error) ||
            (call.reply.fetchError === 'network'
              ? !(err instanceof TypeError)
              : err.name !== 'AbortError')
          ) {
            record(stepIndex, call, 'unexpected_outcome', describeOutcome(o));
          }
          return;
        }
        // api_error
        if (!(err instanceof ApiError)) {
          record(
            stepIndex,
            call,
            e.status === 408 ? 'timeout_not_typed' : 'error_not_api_error',
            describeOutcome(o),
          );
          return;
        }
        if (err.status !== e.status) {
          record(
            stepIndex,
            call,
            'error_status_mismatch',
            `${err.status} ≠ ${e.status}`,
          );
        }
        if (typeof err.code !== 'string') {
          record(
            stepIndex,
            call,
            'error_code_not_string',
            `ApiError.code is ${typeof err.code}: ${JSON.stringify(err.code)?.slice(0, 60)} (status ${call.reply.status})`,
          );
        } else if (err.code !== e.code) {
          record(
            stepIndex,
            call,
            'error_code_mismatch',
            `${err.code} ≠ ${String(e.code)}`,
          );
        }
        if (e.status === 408) {
          if (rec && rec.abortedAtMs === null) {
            record(
              stepIndex,
              call,
              'timeout_not_typed',
              'fetch never saw abort',
            );
          }
        }
        if (call.reply.kind === 'error_json') {
          const env =
            isObj(call.reply.body) && isObj(call.reply.body.error)
              ? call.reply.body.error
              : null;
          if (
            env &&
            'message' in env &&
            env.message != null &&
            typeof env.message !== 'string'
          ) {
            record(
              stepIndex,
              call,
              'error_message_not_string_source',
              `ApiError.message=${JSON.stringify(err.message).slice(0, 60)} from ${typeof env.message} (status ${call.reply.status})`,
            );
          }
          if (env && env.message === '') {
            record(
              stepIndex,
              call,
              'error_message_empty',
              `server message "" reached ApiError.message (status ${call.reply.status})`,
            );
          }
        }
      });

      // I6: model the listener count over the whole step.
      const expectedListener = expectations.reduce((n, e) => {
        const at = e.unauthorizedReportAtMs;
        if (at === null) return n;
        const bearerThen =
          rotateAt !== null && at > rotateAt
            ? bearerAfterRotation
            : bearerBefore;
        return bearerThen !== null && bearerThen === e.sentToken ? n + 1 : n;
      }, 0);
      const observedListener = listenerBearers.length - listenerBefore;
      entry.listenerCalls = observedListener;
      if (observedListener !== expectedListener) {
        record(
          stepIndex,
          null,
          'unauthorized_report_mismatch',
          `listener ×${observedListener}, model ×${expectedListener} (bearer before=${JSON.stringify(bearerBefore)} after=${JSON.stringify(bearerAfterRotation)} rotateAt=${rotateAt})`,
        );
      }

      // I10: every remaining timer must belong to the harness.
      const harnessTimers = scripted.outstandingTimers();
      const jestTimers = jest.getTimerCount();
      if (jestTimers !== harnessTimers) {
        record(
          stepIndex,
          null,
          'timer_leak',
          `jest timers ${jestTimers}, harness timers ${harnessTimers}`,
        );
      }

      entry.violations = violations
        .filter(v => v.stepIndex === stepIndex)
        .map(v => v.violation);
      trace.push(entry);
    }
  } finally {
    globalThis.fetch = realFetch;
    setApiUnauthorizedListener(null);
    clearApiSession();
  }

  return {
    seed,
    length: steps.length,
    callCount,
    violations,
    trace,
    traceDigest: digest(JSON.stringify(trace)),
  };
}

// ─── Minimization ─────────────────────────────────────────────────────────

export interface FailureClass {
  violation: Violation;
  op?: Op | null;
  replyKind?: ReplyKind | null;
}

export function matchesClass(
  v: ViolationRecord,
  target: FailureClass,
): boolean {
  return (
    v.violation === target.violation &&
    (target.op === undefined || v.op === target.op) &&
    (target.replyKind === undefined || v.replyKind === target.replyKind)
  );
}

export interface MinimizedFailure {
  seed: number;
  violation: Violation;
  originalSteps: number;
  minimizedSteps: number;
  steps: Step[];
  detail: string;
}

/**
 * Greedy delta debugging: drop any step (then any sibling call inside a
 * batch) whose removal keeps the failure class reproducing, until a fixpoint.
 * Steps carry their own arguments and scripted replies, so removing one
 * never changes the meaning of the others.
 */
export async function minimizeFailure(
  seed: number,
  target: Violation | FailureClass,
): Promise<MinimizedFailure> {
  const cls: FailureClass =
    typeof target === 'string' ? { violation: target } : target;
  const violation = cls.violation;
  const full = generateSequence(seed);
  let steps = full.steps.slice();
  const reproduces = async (
    candidate: Step[],
  ): Promise<ViolationRecord | null> => {
    const r = await runSequence(seed, { steps: candidate });
    return r.violations.find(v => matchesClass(v, cls)) ?? null;
  };
  let detail = (await reproduces(steps))?.detail ?? '';
  let changed = true;
  while (changed && steps.length > 1) {
    changed = false;
    for (let i = 0; i < steps.length; i += 1) {
      const candidate = steps.slice(0, i).concat(steps.slice(i + 1));
      const hit = await reproduces(candidate);
      if (hit) {
        steps = candidate;
        detail = hit.detail;
        changed = true;
        i -= 1;
      }
    }
  }
  for (let s = 0; s < steps.length; s += 1) {
    const step = steps[s]!;
    if (step.kind !== 'batch') continue;
    let progressed = true;
    while (progressed && step.calls.length > 1) {
      progressed = false;
      const current = steps[s]!;
      if (current.kind !== 'batch') break;
      for (let i = 0; i < current.calls.length; i += 1) {
        const candidateCalls = current.calls
          .slice(0, i)
          .concat(current.calls.slice(i + 1));
        const candidate = steps.slice();
        candidate[s] = { ...current, calls: candidateCalls };
        const hit = await reproduces(candidate);
        if (hit) {
          steps = candidate;
          detail = hit.detail;
          progressed = true;
          break;
        }
      }
    }
  }
  return {
    seed,
    violation,
    originalSteps: full.steps.length,
    minimizedSteps: steps.length,
    steps,
    detail,
  };
}
