/**
 * FAILURE INJECTION — src/progress/api.ts (fetchCanonicalProgress).
 *
 * Every dependency of the module is faulted from a seeded RNG: the transport
 * (throw / reject / abort / slow / timeout / never-resolves), the HTTP status,
 * the body (invalid JSON, wrong shape, seeded field mutations of a valid
 * payload, body-read stall / rejection / sync throw), the session material
 * and the runtime-config read. Under jest fake timers each iteration is
 * driven 60 s forward and the module must:
 *
 *   settles        — resolve or reject within 60 s (no hang behind a spinner)
 *   error_class    — a failure is a ProgressApiError (the caller's contract)
 *   no_fake_success— a resolved value never contains a coerced or non-finite
 *                    number and mirrors the payload's series length
 *   timer_cleanup  — no timer survives the call (deadline cleared)
 *   request_shape  — exactly one GET to `${apiBaseUrl}/v1/progress` with the
 *                    bearer, Accept and X-Client-Version headers
 *   deadline       — a slow transport is aborted at exactly 15 s and the
 *                    rejection is not delayed past it
 *
 * A gated hardening campaign (STRESS_HARDENING=1) drives transports that
 * ignore the abort signal or never deliver the body — not what RN's
 * whatwg-fetch does — and documents that the deadline alone does not settle
 * the promise then.
 *
 * Replay:  STRESS_ONLY=progressApi:<seed>   Scale: STRESS_ITER=<n>
 * Table:   artifacts/stress/progressApi.json
 */
import {
  fetchCanonicalProgress,
  PROGRESS_REQUEST_TIMEOUT_MS,
  ProgressApiError,
} from '../../src/progress/api';
import * as runtimeConfig from '../../src/config/runtimeConfig';
import type { ApiSession } from '../../src/account/apiSession';
import { SeededRng } from '../../test-support/stress/seededRng';
import {
  CampaignTable,
  Checker,
  describeValue,
  planCampaign,
} from '../../test-support/stress/campaign';

const TEST_FILE =
  '__tests__/stress/progressApi.failureInjection.stress.test.ts';
const ADVANCE_MS = 60_000;
// Captured before fake timers are installed so wall-clock timings are real.
const realNow: () => number = Date.now.bind(Date);

// ─── Faults ──────────────────────────────────────────────────────────────────

const FAULTS = [
  'transport_throw_sync',
  'transport_reject',
  'transport_abort_error',
  'transport_pending_honors_abort',
  'transport_slow_ok',
  'transport_slow_past_deadline',
  'http_error_status',
  'body_invalid_json',
  'body_wrong_shape',
  'body_mutated_valid',
  'body_numeric_coercion',
  'body_numeric_strings',
  'body_json_rejects',
  'body_json_throws_sync',
  'transport_non_response',
  'session_malformed',
  'runtime_config_throws',
] as const;
type Fault = (typeof FAULTS)[number];

/** Faults where the dependency ignores the module's abort signal or stalls
 * the body read — not what RN's whatwg-fetch does (XHR aborts on
 * controller.abort() and delivers the whole body at once), so they are kept
 * in their own campaign and documented as a hardening gap. */
const NON_COOPERATIVE_FAULTS = [
  'transport_pending_ignores_abort',
  'body_json_never_resolves',
] as const;
type NonCooperativeFault = (typeof NON_COOPERATIVE_FAULTS)[number];

const ERROR_VALUES = [
  () => new Error('network down'),
  () => new TypeError('Network request failed'),
  () => 'string rejection',
  () => null,
  () => undefined,
  () => ({ code: 'ECONNRESET' }),
  () => 42,
] as const;

const HTTP_ERROR_STATUSES = [
  400, 401, 403, 404, 408, 409, 410, 418, 422, 425, 429, 500, 501, 502, 503,
  504, 507, 599,
] as const;

const INVALID_JSON_BODIES = [
  '',
  'not json',
  '{',
  '{"series": [',
  '<html><body>captive portal</body></html>',
  '\u0000\u0001\u0002',
  'undefined',
  'NaN',
  "{'series': []}",
  '{"series": []} trailing',
] as const;

const WRONG_SHAPE_BODIES = [
  'null',
  '[]',
  '"progress"',
  '42',
  'true',
  '{}',
  '{"series": {}}',
  '{"series": [], "improving": [], "needsAttention": []}',
  '{"series": [], "improving": [], "needsAttention": [], "streak": []}',
  '{"series": [], "improving": [], "needsAttention": [], "streak": null}',
  '{"series": [null], "improving": [], "needsAttention": [], "streak": {}}',
  '{"series": "[]", "improving": [], "needsAttention": [], "streak": {"currentDays": 1, "longestDays": 1, "practicedToday": true, "lastPracticeDate": null}}',
  '{"series": [], "improving": [], "needsAttention": [], "streak": {"currentDays": 1, "longestDays": 1, "practicedToday": "yes", "lastPracticeDate": null}}',
  '{"series": [], "improving": [], "needsAttention": [], "streak": {"currentDays": 1, "longestDays": 1, "practicedToday": true, "lastPracticeDate": 20260101}}',
] as const;

type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json | undefined };

function validPayload(rng: SeededRng): Record<string, Json> {
  const series: Json[] = [];
  const n = rng.int(0, 6);
  for (let i = 0; i < n; i++) {
    series.push({
      day: `2026-08-${String(rng.int(1, 28)).padStart(2, '0')}`,
      shot_type: rng.pick(['dink', 'forehand_drive', 'serve', 'third_shot']),
      scoring_model_version: rng.pick(['scoring-3', 'scoring-4']),
      shot_count: rng.int(1, 40),
      avg_score: rng.int(0, 1000) / 10,
      best_score: rng.int(0, 1000) / 10,
    });
  }
  const trend = (key: 'delta' | 'avg'): Json[] => {
    const rows: Json[] = [];
    const m = rng.int(0, 3);
    for (let i = 0; i < m; i++) {
      rows.push({
        checkpoint: rng.pick([
          'paddle_prep',
          'contact_point',
          'follow_through',
        ]),
        [key]: rng.int(-200, 1000) / 10,
      });
    }
    return rows;
  };
  return {
    series,
    improving: trend('delta'),
    needsAttention: trend('avg'),
    streak: {
      currentDays: rng.int(0, 60),
      longestDays: rng.int(0, 400),
      practicedToday: rng.chance(0.5),
      lastPracticeDate: rng.chance(0.2) ? null : '2026-08-27',
    },
  };
}

/** Replacement values a mutation may write into a field. `undefined`
 * deletes the key. */
const MUTATION_VALUES: ReadonlyArray<Json | undefined> = [
  null,
  undefined,
  '',
  '   ',
  true,
  false,
  [],
  [7],
  {},
  'NaN',
  'Infinity',
  '-Infinity',
  -1,
  0,
  1e15,
  '76.5',
  '0x10',
  '1e3',
  'abc',
  '2026-08-27',
];

/** Does a strict parser accept `value` where a field of `kind` is expected?
 * Numeric fields take finite numbers and numeric strings (the server
 * historically sent scores as strings, see progressApi.test.ts); anything
 * `Number()` merely coerces (null → 0, true → 1, '' → 0, [7] → 7) is a
 * fabricated figure and must be refused. */
function acceptable(
  kind: Mutation['kind'],
  path: string,
  value: Json | undefined,
): boolean {
  switch (kind) {
    case 'numeric':
      if (typeof value === 'number') return Number.isFinite(value);
      return (
        typeof value === 'string' &&
        value.trim() !== '' &&
        Number.isFinite(Number(value))
      );
    case 'string':
      if (typeof value === 'string') return true;
      return path.endsWith('lastPracticeDate') && value === null;
    case 'boolean':
      return typeof value === 'boolean';
  }
}

const NUMERIC_PATHS = [
  ['series', '*', 'shot_count'],
  ['series', '*', 'avg_score'],
  ['series', '*', 'best_score'],
  ['improving', '*', 'delta'],
  ['needsAttention', '*', 'avg'],
  ['streak', 'currentDays'],
  ['streak', 'longestDays'],
] as const;

const STRING_PATHS = [
  ['series', '*', 'day'],
  ['series', '*', 'shot_type'],
  ['series', '*', 'scoring_model_version'],
  ['improving', '*', 'checkpoint'],
  ['needsAttention', '*', 'checkpoint'],
  ['streak', 'lastPracticeDate'],
] as const;

interface Mutation {
  path: string;
  value: Json | undefined | '<deleted>';
  kind: 'numeric' | 'string' | 'boolean';
  acceptable: boolean;
}

function applyMutations(
  payload: Record<string, Json>,
  rng: SeededRng,
): Mutation[] {
  const mutations: Mutation[] = [];
  const count = rng.int(1, 3);
  for (let i = 0; i < count; i++) {
    const roll = rng.next();
    const kind: Mutation['kind'] =
      roll < 0.6 ? 'numeric' : roll < 0.9 ? 'string' : 'boolean';
    const path =
      kind === 'numeric'
        ? rng.pick(NUMERIC_PATHS)
        : kind === 'string'
          ? rng.pick(STRING_PATHS)
          : (['streak', 'practicedToday'] as const);
    const value = rng.pick(MUTATION_VALUES);
    const applied = setPath(payload, path, value, rng);
    if (applied) {
      mutations.push({
        path: applied,
        value: value === undefined ? '<deleted>' : value,
        kind,
        acceptable: acceptable(kind, applied, value),
      });
    }
  }
  return mutations;
}

/** Writes `value` at the path (a `*` picks a random array index); returns the
 * concrete path or null when the array was empty. */
function setPath(
  payload: Record<string, Json>,
  path: readonly string[],
  value: Json | undefined,
  rng: SeededRng,
): string | null {
  let cursor: Json | undefined = payload;
  const concrete: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i]!;
    if (segment === '*') {
      if (!Array.isArray(cursor) || cursor.length === 0) return null;
      const index = rng.int(0, cursor.length - 1);
      cursor = cursor[index];
      concrete.push(String(index));
    } else {
      if (
        cursor === null ||
        typeof cursor !== 'object' ||
        Array.isArray(cursor)
      )
        return null;
      cursor = cursor[segment];
      concrete.push(segment);
    }
  }
  const leaf = path[path.length - 1]!;
  if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor))
    return null;
  if (value === undefined) delete cursor[leaf];
  else cursor[leaf] = value;
  concrete.push(leaf);
  return concrete.join('.');
}

// ─── Transport ───────────────────────────────────────────────────────────────

interface Call {
  input: string;
  init: RequestInit | undefined;
}

interface Injected {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>;
  calls: Call[];
  /** Ms after which the injected transport settles (Infinity = never). */
  settlesAtMs: number;
  /** What a correct module must do given this fault. */
  expectation: 'resolve' | 'reject';
  /** The rejection class contract applies only to faults the module maps. */
  detail: Record<string, unknown>;
}

function delayed<T>(ms: number, run: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
}

/** A transport that honors AbortSignal like RN's whatwg-fetch (XHR abort):
 * settles after `ms` unless aborted first, in which case its own timer is
 * dropped so the only timer that can survive belongs to the module. */
function abortable<T>(
  ms: number,
  run: () => T,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
    }, ms);
    signal?.addEventListener('abort', abort);
  });
}

function abortRejection(
  signal: AbortSignal | null | undefined,
): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    signal.addEventListener('abort', () =>
      reject(new DOMException('Aborted', 'AbortError')),
    );
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeInjected(
  fault: Fault | NonCooperativeFault,
  rng: SeededRng,
  session: { current: ApiSession },
): Injected {
  const calls: Call[] = [];
  const detail: Record<string, unknown> = {};
  let handler: (init: RequestInit | undefined) => Promise<Response>;
  let settlesAtMs = 0;
  let expectation: Injected['expectation'] = 'reject';

  switch (fault) {
    case 'transport_throw_sync': {
      const make = rng.pick(ERROR_VALUES);
      detail.thrown = describeValue(make());
      handler = () => {
        throw make();
      };
      break;
    }
    case 'transport_reject': {
      const make = rng.pick(ERROR_VALUES);
      const delay = rng.int(0, PROGRESS_REQUEST_TIMEOUT_MS - 1);
      detail.rejection = describeValue(make());
      detail.delayMs = delay;
      settlesAtMs = delay;
      handler = init =>
        abortable(
          delay,
          () => {
            throw make();
          },
          init?.signal,
        );
      break;
    }
    case 'transport_abort_error': {
      const delay = rng.int(0, 500);
      detail.delayMs = delay;
      settlesAtMs = delay;
      handler = () =>
        delayed(delay, () => {
          throw new DOMException('The operation was aborted.', 'AbortError');
        });
      break;
    }
    case 'transport_pending_honors_abort': {
      settlesAtMs = PROGRESS_REQUEST_TIMEOUT_MS;
      handler = init => abortRejection(init?.signal);
      break;
    }
    case 'transport_pending_ignores_abort': {
      settlesAtMs = Infinity;
      handler = () => new Promise<Response>(() => {});
      break;
    }
    case 'transport_slow_ok': {
      // Boundary-heavy: a quarter of the draws land within 5 ms of the deadline.
      const delay = rng.chance(0.25)
        ? PROGRESS_REQUEST_TIMEOUT_MS - rng.int(1, 5)
        : rng.int(0, PROGRESS_REQUEST_TIMEOUT_MS - 1);
      const body = JSON.stringify(validPayload(rng));
      detail.delayMs = delay;
      detail.seriesLength = (
        JSON.parse(body) as { series: Json[] }
      ).series.length;
      settlesAtMs = delay;
      expectation = 'resolve';
      handler = init =>
        abortable(delay, () => jsonResponse(body), init?.signal);
      break;
    }
    case 'transport_slow_past_deadline': {
      const delay = rng.chance(0.25)
        ? PROGRESS_REQUEST_TIMEOUT_MS + rng.int(0, 5)
        : PROGRESS_REQUEST_TIMEOUT_MS + rng.int(0, 40_000);
      const body = JSON.stringify(validPayload(rng));
      detail.delayMs = delay;
      settlesAtMs = PROGRESS_REQUEST_TIMEOUT_MS;
      handler = init =>
        abortable(delay, () => jsonResponse(body), init?.signal);
      break;
    }
    case 'http_error_status': {
      const status = rng.pick(HTTP_ERROR_STATUSES);
      const body = rng.pick([
        JSON.stringify(validPayload(rng)),
        '{"error":"nope"}',
        'not json',
        '',
      ]);
      const delay = rng.int(0, 2_000);
      detail.status = status;
      detail.body = body.slice(0, 40);
      detail.delayMs = delay;
      settlesAtMs = delay;
      handler = () => delayed(delay, () => jsonResponse(body, status));
      break;
    }
    case 'body_invalid_json': {
      const body = rng.pick(INVALID_JSON_BODIES);
      detail.body = body;
      handler = () => Promise.resolve(jsonResponse(body));
      break;
    }
    case 'body_wrong_shape': {
      const body = rng.pick(WRONG_SHAPE_BODIES);
      detail.body = body;
      handler = () => Promise.resolve(jsonResponse(body));
      break;
    }
    case 'body_mutated_valid': {
      const payload = validPayload(rng);
      const mutations = applyMutations(payload, rng);
      const body = JSON.stringify(payload);
      detail.mutations = mutations;
      detail.body = body;
      // The module may only resolve when every mutation is acceptable input
      // (see `acceptable`); one coerced or ill-typed field must refuse the
      // whole payload — a partial parse would be a fabricated figure.
      expectation = mutations.every(m => m.acceptable) ? 'resolve' : 'reject';
      if (expectation === 'resolve') {
        detail.seriesLength = (payload['series'] as Json[]).length;
      }
      handler = () => Promise.resolve(jsonResponse(body));
      break;
    }
    case 'body_numeric_coercion': {
      // One numeric field replaced by a value `Number()` silently turns into a
      // finite number the server never sent (null → 0, '' → 0, true → 1,
      // [] → 0, [7] → 7). A strict parser refuses the payload.
      const payload = validPayload(rng);
      if ((payload['series'] as Json[]).length === 0) {
        (payload['series'] as Json[]).push({
          day: '2026-08-20',
          shot_type: 'dink',
          scoring_model_version: 'scoring-4',
          shot_count: 3,
          avg_score: 55,
          best_score: 70,
        });
      }
      const coercing: Json[] = [null, '', '   ', true, false, [], [7]];
      const value = rng.pick(coercing);
      const path = rng.pick(
        NUMERIC_PATHS.filter(p => p[0] === 'series' || p[0] === 'streak'),
      );
      const applied = setPath(payload, path, value, rng);
      const body = JSON.stringify(payload);
      detail.path = applied;
      detail.value = describeValue(value);
      detail.coercedTo = Number(value);
      detail.body = body;
      handler = () => Promise.resolve(jsonResponse(body));
      break;
    }
    case 'body_numeric_strings': {
      const payload = validPayload(rng);
      const series = payload['series'] as Array<Record<string, Json>>;
      for (const row of series) {
        row['avg_score'] = String(row['avg_score']);
        row['best_score'] = String(row['best_score']);
        if (rng.chance(0.5)) row['shot_count'] = String(row['shot_count']);
      }
      const body = JSON.stringify(payload);
      detail.body = body;
      detail.seriesLength = series.length;
      expectation = 'resolve';
      handler = () => Promise.resolve(jsonResponse(body));
      break;
    }
    case 'body_json_rejects': {
      const make = rng.pick(ERROR_VALUES);
      detail.rejection = describeValue(make());
      handler = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(make()),
        } as unknown as Response);
      break;
    }
    case 'body_json_throws_sync': {
      const make = rng.pick(ERROR_VALUES);
      detail.thrown = describeValue(make());
      handler = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => {
            throw make();
          },
        } as unknown as Response);
      break;
    }
    case 'body_json_never_resolves': {
      settlesAtMs = Infinity;
      handler = () =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => new Promise(() => {}),
        } as unknown as Response);
      break;
    }
    case 'transport_non_response': {
      const value = rng.pick([undefined, null, {}, { ok: true }, 'body', 0]);
      detail.value = describeValue(value);
      handler = () => Promise.resolve(value as unknown as Response);
      break;
    }
    case 'session_malformed': {
      const variant = rng.pick([
        'empty_base_url',
        'trailing_slash',
        'empty_bearer',
        'whitespace_bearer',
      ] as const);
      detail.variant = variant;
      const base = 'https://api.example.test';
      session.current = {
        ...session.current,
        apiBaseUrl:
          variant === 'empty_base_url'
            ? ''
            : variant === 'trailing_slash'
              ? `${base}/`
              : base,
        bearerToken:
          variant === 'empty_bearer'
            ? ''
            : variant === 'whitespace_bearer'
              ? '   '
              : 'token-abc',
      };
      // The transport itself answers 401 for a missing bearer and a valid
      // payload otherwise; the module must never treat the 401 as data.
      const body = JSON.stringify(validPayload(rng));
      const unauthorized =
        variant === 'empty_bearer' || variant === 'whitespace_bearer';
      expectation = unauthorized ? 'reject' : 'resolve';
      handler = () =>
        Promise.resolve(
          jsonResponse(unauthorized ? '' : body, unauthorized ? 401 : 200),
        );
      break;
    }
    case 'runtime_config_throws': {
      handler = () =>
        Promise.resolve(jsonResponse(JSON.stringify(validPayload(rng))));
      break;
    }
  }

  return {
    calls,
    settlesAtMs,
    expectation,
    detail,
    fetchFn: (input, init) => {
      calls.push({ input, init });
      return handler(init);
    },
  };
}

// ─── Result inspection ───────────────────────────────────────────────────────

type Settled =
  | { state: 'pending' }
  | { state: 'resolved'; value: unknown; atMs: number }
  | { state: 'rejected'; error: unknown; atMs: number };

function walkNumbers(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNumbers(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      walkNumbers(inner, `${path}.${key}`, out);
    }
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

async function drive(
  fault: Fault | NonCooperativeFault,
  seed: number,
  checker: Checker,
): Promise<{ settled: Settled; injected: Injected; observed: string }> {
  const rng = new SeededRng(seed);
  const session = {
    current: {
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'token-abc',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    } as ApiSession,
  };
  const injected = makeInjected(fault, rng, session);

  const configSpy = jest.spyOn(runtimeConfig, 'getRuntimePublicConfig');
  if (fault === 'runtime_config_throws') {
    configSpy.mockImplementation(() => {
      throw new Error('runtime config unavailable');
    });
  }

  let settled: Settled = { state: 'pending' };
  // Read through a function: the callbacks below reassign `settled`, which
  // TS control-flow narrowing cannot see.
  const snapshot = (): Settled => settled;
  const startedAt = Date.now(); // fake clock: settle offsets are exact
  const promise = fetchCanonicalProgress(
    session.current,
    injected.fetchFn,
  ).then(
    value => {
      settled = { state: 'resolved', value, atMs: Date.now() - startedAt };
    },
    (error: unknown) => {
      settled = { state: 'rejected', error, atMs: Date.now() - startedAt };
    },
  );

  // Advance timer by timer (each firing is its own macrotask, with a
  // microtask checkpoint after it — as on a device), then run out the rest
  // of the 60 s window so a hang cannot hide behind an idle clock.
  await flushMicrotasks();
  const clockStart = jest.now();
  while (
    snapshot().state === 'pending' &&
    jest.now() - clockStart < ADVANCE_MS &&
    jest.getTimerCount() > 0
  ) {
    jest.advanceTimersToNextTimer();
    await flushMicrotasks();
  }
  const remaining = ADVANCE_MS - (jest.now() - clockStart);
  if (remaining > 0) {
    jest.advanceTimersByTime(remaining);
    await flushMicrotasks();
  }
  configSpy.mockRestore();

  // A settle past the window (a timer beyond 60 s) counts as a hang.
  const final = snapshot();
  const current: Settled =
    final.state !== 'pending' && final.atMs > ADVANCE_MS
      ? { state: 'pending' }
      : final;
  const observed =
    current.state === 'pending'
      ? `pending after ${ADVANCE_MS} ms`
      : current.state === 'resolved'
        ? `resolved at ${current.atMs} ms: ${describeValue(current.value).slice(0, 120)}`
        : `rejected at ${current.atMs} ms: ${describeValue(current.error)}`;

  // settles
  checker.check(
    'settles',
    current.state !== 'pending',
    () =>
      `still pending after advancing ${ADVANCE_MS} ms (fault settles at ${injected.settlesAtMs} ms)`,
  );
  if (current.state === 'pending') {
    // Keep the pending promise from surfacing as an unhandled rejection later.
    void promise.catch(() => {});
    return { settled: current, injected, observed };
  }

  // timer_cleanup
  checker.check(
    'timer_cleanup',
    jest.getTimerCount() === 0,
    () => `${jest.getTimerCount()} timer(s) alive after settle`,
  );

  // request_shape (the config fault legitimately never reaches the transport)
  if (fault !== 'runtime_config_throws') {
    checker.check(
      'request_shape',
      injected.calls.length === 1,
      () => `transport called ${injected.calls.length} times`,
    );
    const call = injected.calls[0];
    if (call) {
      const headers = call.init?.headers as Record<string, string> | undefined;
      checker.check(
        'request_shape',
        call.input === `${session.current.apiBaseUrl}/v1/progress` &&
          call.init?.method === 'GET' &&
          headers?.['Authorization'] ===
            `Bearer ${session.current.bearerToken}` &&
          headers?.['Accept'] === 'application/json' &&
          typeof headers?.['X-Client-Version'] === 'string' &&
          call.init?.signal instanceof AbortSignal,
        () =>
          `request was ${describeValue({ input: call.input, init: call.init })}`,
      );
    }
  } else {
    checker.check(
      'request_shape',
      injected.calls.length === 0,
      () =>
        `transport reached despite config throw (${injected.calls.length} calls)`,
    );
  }

  if (current.state === 'rejected') {
    checker.check(
      'no_fake_failure',
      injected.expectation === 'reject',
      () =>
        `expected a resolved value, got rejection ${describeValue(current.error)}`,
    );
    // Both callers (ProgressScreen, HomeScreen) catch every rejection, so the
    // error class is a contract only for the faults the module maps itself;
    // a non-Response transport value or a synchronously throwing `json()`
    // cannot come out of RN's fetch and is recorded, not asserted.
    if (
      fault !== 'transport_non_response' &&
      fault !== 'body_json_throws_sync'
    ) {
      checker.check(
        'error_class',
        current.error instanceof ProgressApiError,
        () =>
          `rejection is ${describeValue(current.error)}, not ProgressApiError`,
      );
    } else {
      injected.detail.rejectionClass =
        current.error instanceof Error
          ? current.error.name
          : typeof current.error;
    }
    if (
      fault === 'transport_pending_honors_abort' ||
      fault === 'transport_slow_past_deadline'
    ) {
      checker.check(
        'deadline',
        current.atMs === PROGRESS_REQUEST_TIMEOUT_MS,
        () =>
          `rejected at ${current.atMs} ms, deadline is ${PROGRESS_REQUEST_TIMEOUT_MS} ms`,
      );
      const signal = injected.calls[0]?.init?.signal;
      checker.check(
        'deadline',
        signal?.aborted === true,
        () => 'deadline passed but the transport signal was never aborted',
      );
    }
    return { settled: current, injected, observed };
  }

  // resolved
  checker.check(
    'no_fake_success',
    injected.expectation === 'resolve',
    () =>
      `resolved despite fault ${fault} ${describeValue(injected.detail)} → ${describeValue(current.value)}`,
  );
  const nonFinite: string[] = [];
  walkNumbers(current.value, 'progress', nonFinite);
  checker.check(
    'no_fake_success',
    nonFinite.length === 0,
    () => `non-finite numbers in parsed progress: ${nonFinite.join(', ')}`,
  );
  const value = current.value as { series?: unknown[] } | null;
  if (typeof injected.detail.seriesLength === 'number') {
    checker.check(
      'no_fake_success',
      Array.isArray(value?.series) &&
        value.series.length === injected.detail.seriesLength,
      () =>
        `series length ${value?.series?.length} ≠ payload ${injected.detail.seriesLength}`,
    );
  }
  const signal = injected.calls[0]?.init?.signal;
  checker.check(
    'deadline',
    signal?.aborted !== true,
    () => 'resolved although the deadline had already aborted the signal',
  );
  return { settled: current, injected, observed };
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const main = planCampaign('progressApi', 48, TEST_FILE);
const nonCooperative = planCampaign('progressApiNonCooperative', 6, TEST_FILE, {
  hardening: true,
});

const mainTable = new CampaignTable(main, {
  faults: FAULTS,
  advanceMs: ADVANCE_MS,
  deadlineMs: PROGRESS_REQUEST_TIMEOUT_MS,
});
const nonCooperativeTable = new CampaignTable(nonCooperative, {
  faults: NON_COOPERATIVE_FAULTS,
  advanceMs: ADVANCE_MS,
  note: 'dependency ignores AbortSignal / stalls body read — not reachable with RN whatwg-fetch',
});

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

afterAll(() => {
  mainTable.flush();
  nonCooperativeTable.flush();
});

describe('fetchCanonicalProgress under injected dependency faults', () => {
  for (const seed of main.seeds) {
    it(`seed ${seed}`, async () => {
      const rng = new SeededRng(seed);
      const fault = rng.pick(FAULTS);
      const checker = new Checker();
      const started = realNow();
      const { injected, observed } = await drive(fault, seed, checker);
      const result = mainTable.record(
        seed,
        fault,
        injected.detail,
        checker,
        observed,
        realNow() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({ outcome: 'HELD', failures: [], replay: result.replay });
    });
  }
});

describe('fetchCanonicalProgress when the dependency ignores abort / stalls the body (hardening)', () => {
  for (const seed of nonCooperative.seeds) {
    it(`seed ${seed}`, async () => {
      const rng = new SeededRng(seed);
      const fault = rng.pick(NON_COOPERATIVE_FAULTS);
      const checker = new Checker();
      const started = realNow();
      const { injected, observed } = await drive(fault, seed, checker);
      const result = nonCooperativeTable.record(
        seed,
        fault,
        injected.detail,
        checker,
        observed,
        realNow() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({ outcome: 'HELD', failures: [], replay: result.replay });
    });
  }
});
