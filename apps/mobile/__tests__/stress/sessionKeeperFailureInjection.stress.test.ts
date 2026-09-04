/**
 * mod-session-keeper — FAILURE INJECTION stress harness for
 * `src/account/sessionKeeper.ts` + `src/account/sessionLifecycle.ts`
 * (the real modules, nothing mocked in between; `fetchFn`, `now`, the
 * keeper callbacks and `AppState.addEventListener` are the injection points).
 *
 * Every dependency the unit has is faulted in every way the lens asks for:
 *
 *   fetch / transport  throw (sync), reject (Error / TypeError / non-Error /
 *                      null), timeout (hang honouring the 15 s abort), hang
 *                      that IGNORES the abort signal, slow (14 s / 16 s),
 *                      resolves with a non-Response (undefined, null, plain
 *                      object, string)
 *   HTTP status        401 403 | 400 402 404 405 408 409 410 418 422 425 429 |
 *                      500 501 502 503 504 507 511 | 301 with a valid body |
 *                      201 valid | 204 empty | 200 whose `ok` is false
 *   body / payload     non-JSON, empty, `null`, array, string, no `session`,
 *                      `session: null`, `session: []`, missing / empty /
 *                      whitespace / wrong-typed accessToken, refreshToken,
 *                      expiresAt (string, NaN, ±Infinity, negative, 0, float,
 *                      ms-instead-of-s, in the past, inside the 60 s lead,
 *                      exactly at the lead), `json()` throws synchronously,
 *                      `json()` never resolves, `json()` slow, `session`
 *                      getter throws, 1 MB junk beside valid tokens, 256 KB
 *                      tokens, extra fields, the same refresh token back
 *   callbacks          onRotated throws / rejects / hangs / slow / stops the
 *                      keeper / restarts it / calls refreshSessionNow;
 *                      onRevoked throws / rejects / hangs / restarts the
 *                      keeper; onDeferred throws / calls refreshSessionNow /
 *                      stops the keeper
 *   clock (`now`)      NaN, negative constant, frozen, 1 h backward jump
 *                      after a rotation, 2 h forward jump, far future, sub-ms
 *                      jitter
 *   AppState           addEventListener throws, subscription.remove throws,
 *                      non-active states, 1000 'active' events in one tick,
 *                      'active' while a refresh is in flight, 'active' after
 *                      stop
 *   control            refreshSessionNow ×1000 in one tick, after stop, stop
 *                      twice, start twice in one tick, restart while the
 *                      previous generation's refresh is in flight
 *   input              bearerExpiresAtMs NaN / negative / huge / past /
 *                      inside lead / exactly at lead
 *
 * Invariants (a headless module's version of "recoverable state with a
 * visible retry control, no infinite spinner, no silent failure, no fake
 * success, no corrupted persisted state"):
 *   NO_FAKE_SUCCESS    onRotated fires only for a 2xx body that validated,
 *                      and reports EXACTLY the tokens the server issued.
 *   NO_SILENT_FAILURE  every settled non-refusal failure → onDeferred once;
 *                      every delivered 401/403 → onRevoked once.
 *   NO_STALL           after ANY fault, advancing fake timers by the 15 s
 *                      request timeout + the 5 min max backoff + a bearer
 *                      lifetime yields another refresh attempt (or the
 *                      session was revoked). A keeper that never asks again
 *                      is the module's infinite spinner.
 *   RESPONSIVE         after the drain an API-401 report (refreshSessionNow)
 *                      produces a request at once — the "retry control".
 *   NO_STORM           ≤ 30 requests in any 60 s window (edge per-IP budget)
 *                      and ≥ 30 s between two successful rotations.
 *   ONE_INFLIGHT       never two concurrent requests from one keeper
 *                      generation.
 *   REVOKE_ONLY_ON_REFUSAL
 *                      onRevoked ⇔ a 401/403 was delivered, at most once,
 *                      and no request is sent after it.
 *   TOKEN_CONTINUITY   every request carries the latest rotated refresh
 *                      token; a spent token is never re-sent.
 *   RECOVERY           once the fault window closes the very next delivered
 *                      healthy response rotates the bearer.
 *   NO_UNHANDLED       no promise rejection escapes the keeper (enforced by
 *                      jest itself: an escaping rejection fails the test;
 *                      the three faults that DO escape are gated behind
 *                      STRESS_ESCAPES=1 and documented as FI-4).
 *
 * Known-broken faults (findings FI-1..FI-7 in the session report) are pinned
 * in their CURRENT failure mode under `describe('KNOWN BROKEN …')` so the
 * suite stays green and the day they are fixed the pin fails loudly and must
 * be flipped to the healthy expectation.
 *
 * Run (apps/mobile):
 *   npx jest --ci __tests__/stress/sessionKeeperFailureInjection.stress.test.ts
 *   STRESS_ITER=5000 npx jest --ci __tests__/stress/sessionKeeperFailureInjection.stress.test.ts
 *   STRESS_SEED=1234 npx jest --ci __tests__/stress/sessionKeeperFailureInjection.stress.test.ts   (replay one)
 * Artifacts: artifacts/stress/mod-session-keeper/failure-injection-*.json
 * (STRESS_OUT overrides the directory).
 */
import { AppState } from 'react-native';
import {
  MIN_ROTATION_GAP_MS,
  refreshSessionNow,
  retryDelayMs,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';
import type {
  RefreshedTokens,
  SessionFetch,
} from '../../src/account/sessionLifecycle';

/** Node globals the RN tsconfig does not declare (same pattern as
 * __tests__/xc/xcMatrixNetworkAuth2.keeper.test.ts). */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  version: string;
  memoryUsage: () => { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
};

const REAL_NOW: () => number = Date.now.bind(Date);

const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_LEAD_MS = 60_000;
const FOREGROUND_LEAD_MS = 5 * 60_000;
const RETRY_MAX_MS = retryDelayMs(99);
const HEALTHY_LIFE_S = 3600;
const HEALTHY_LIFE_MS = HEALTHY_LIFE_S * 1000;
/** Long enough for the request timeout, the maximum backoff, a whole healthy
 * bearer lifetime and slack: whatever the keeper is waiting on, it fires. */
const DRAIN_MS = REQUEST_TIMEOUT_MS + RETRY_MAX_MS + HEALTHY_LIFE_MS + 5_000;

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
const int = (rng: () => number, lo: number, hi: number): number =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ─── Fault catalogue ─────────────────────────────────────────────────────────

/** What the fault must produce on the attempt it is injected into. */
type Expect =
  | 'success' // onRotated with the exact issued tokens
  | 'transient' // onDeferred, retry after backoff, later recovery
  | 'refuse' // onRevoked once, silence afterwards
  | 'stall' // KNOWN BROKEN: keeper never asks again
  | 'storm'; // KNOWN BROKEN: > 30 requests / min

type Category =
  | 'fetch'
  | 'http'
  | 'body'
  | 'callback'
  | 'clock'
  | 'appstate'
  | 'control'
  | 'input';

interface Fault {
  id: string;
  category: Category;
  expect: Expect;
  /** Finding this fault reproduces (documented in the session report). */
  finding?: string;
}

const F = (
  id: string,
  category: Category,
  expect: Expect,
  finding?: string,
): Fault =>
  finding ? { id, category, expect, finding } : { id, category, expect };

/** Faults served by the fake transport on ONE attempt. */
const ATTEMPT_FAULTS: readonly Fault[] = [
  // fetch / transport
  F('fetch_throws_sync', 'fetch', 'transient'),
  F('fetch_rejects_error', 'fetch', 'transient'),
  F('fetch_rejects_typeerror', 'fetch', 'transient'),
  F('fetch_rejects_string', 'fetch', 'transient'),
  F('fetch_rejects_null', 'fetch', 'transient'),
  F('fetch_hang_honours_abort', 'fetch', 'transient'),
  F('fetch_hang_ignores_abort', 'fetch', 'stall', 'FI-1'),
  F('fetch_slow_14s_ok', 'fetch', 'success'),
  F('fetch_slow_16s_ok_honours_abort', 'fetch', 'transient'),
  F('fetch_resolves_undefined', 'fetch', 'transient'),
  F('fetch_resolves_null', 'fetch', 'transient'),
  F('fetch_resolves_plain_object', 'fetch', 'transient'),
  F('fetch_resolves_string', 'fetch', 'transient'),
  // HTTP status
  F('http_401', 'http', 'refuse'),
  F('http_403', 'http', 'refuse'),
  F('http_401_with_valid_body', 'http', 'refuse'),
  F('http_400', 'http', 'transient'),
  F('http_402', 'http', 'transient'),
  F('http_404', 'http', 'transient'),
  F('http_405', 'http', 'transient'),
  F('http_408', 'http', 'transient'),
  F('http_409', 'http', 'transient'),
  F('http_410', 'http', 'transient'),
  F('http_418', 'http', 'transient'),
  F('http_422', 'http', 'transient'),
  F('http_425', 'http', 'transient'),
  F('http_429', 'http', 'transient'),
  F('http_500', 'http', 'transient'),
  F('http_501', 'http', 'transient'),
  F('http_502', 'http', 'transient'),
  F('http_503', 'http', 'transient'),
  F('http_504', 'http', 'transient'),
  F('http_507', 'http', 'transient'),
  F('http_511', 'http', 'transient'),
  F('http_301_valid_body', 'http', 'transient'),
  F('http_201_valid_body', 'http', 'success'),
  F('http_204_empty', 'http', 'transient'),
  F('http_200_ok_false_fake_response', 'http', 'transient'),
  // body / payload
  F('body_non_json', 'body', 'transient'),
  F('body_empty', 'body', 'transient'),
  F('body_null', 'body', 'transient'),
  F('body_array', 'body', 'transient'),
  F('body_string', 'body', 'transient'),
  F('body_no_session', 'body', 'transient'),
  F('body_session_null', 'body', 'transient'),
  F('body_session_array', 'body', 'transient'),
  F('body_missing_access', 'body', 'transient'),
  F('body_missing_refresh', 'body', 'transient'),
  F('body_missing_expires', 'body', 'transient'),
  F('body_empty_access', 'body', 'transient'),
  F('body_whitespace_refresh', 'body', 'transient'),
  F('body_access_number', 'body', 'transient'),
  F('body_refresh_object', 'body', 'transient'),
  F('body_expires_string', 'body', 'transient'),
  F('body_expires_nan', 'body', 'transient'),
  F('body_expires_infinity', 'body', 'transient'),
  F('body_expires_neg_infinity', 'body', 'transient'),
  F('body_expires_negative', 'body', 'success'),
  F('body_expires_zero', 'body', 'success'),
  F('body_expires_float', 'body', 'success'),
  F('body_expires_in_past_5s', 'body', 'success'),
  F('body_expires_inside_lead_30s', 'body', 'success'),
  F('body_expires_exactly_lead_60s', 'body', 'success'),
  F('body_expires_ms_units', 'body', 'storm', 'FI-5'),
  F('body_json_throws_sync', 'body', 'transient'),
  F('body_json_never_resolves', 'body', 'stall', 'FI-2'),
  F('body_json_slow_20s_valid', 'body', 'success'),
  F('body_session_getter_throws', 'body', 'transient'),
  F('body_1mb_junk_beside_valid', 'body', 'success'),
  F('body_huge_tokens_256k', 'body', 'success'),
  F('body_extra_fields', 'body', 'success'),
  F('body_same_refresh_token_back', 'body', 'success'),
];

/** Faults in the keeper's callbacks, applied on the callback's FIRST call. */
const CALLBACK_FAULTS: readonly Fault[] = [
  F('cb_rotated_throws_sync', 'callback', 'success', 'FI-3'),
  F('cb_rotated_rejects', 'callback', 'success', 'FI-3'),
  F('cb_rotated_hangs_forever', 'callback', 'stall', 'FI-4'),
  F('cb_rotated_slow_20s', 'callback', 'success'),
  F('cb_rotated_calls_stop', 'callback', 'success'),
  F('cb_rotated_restarts_keeper', 'callback', 'success'),
  F('cb_rotated_calls_refresh_now', 'callback', 'success'),
  F('cb_revoked_throws_sync', 'callback', 'refuse', 'FI-4'),
  F('cb_revoked_rejects', 'callback', 'refuse', 'FI-4'),
  F('cb_revoked_hangs_forever', 'callback', 'refuse'),
  F('cb_revoked_restarts_keeper', 'callback', 'refuse'),
  F('cb_deferred_throws', 'callback', 'stall', 'FI-4'),
  F('cb_deferred_calls_refresh_now', 'callback', 'transient'),
  F('cb_deferred_calls_stop', 'callback', 'transient'),
];

const CLOCK_FAULTS: readonly Fault[] = [
  F('clock_nan', 'clock', 'storm', 'FI-7'),
  F('clock_negative', 'clock', 'storm', 'FI-7'),
  F('clock_frozen', 'clock', 'success'),
  F('clock_backward_1h_after_rotation', 'clock', 'success'),
  F('clock_forward_2h_after_rotation', 'clock', 'success'),
  F('clock_far_future', 'clock', 'success'),
  F('clock_sub_ms_jitter', 'clock', 'success'),
];

const APPSTATE_FAULTS: readonly Fault[] = [
  F('appstate_add_listener_throws', 'appstate', 'stall', 'FI-6'),
  F('appstate_remove_throws', 'appstate', 'success', 'FI-6'),
  F('appstate_non_active_states', 'appstate', 'success'),
  F('appstate_active_burst_1000', 'appstate', 'success'),
  F('appstate_active_during_inflight', 'appstate', 'success'),
  F('appstate_active_after_stop', 'appstate', 'success'),
];

const CONTROL_FAULTS: readonly Fault[] = [
  F('control_refresh_now_burst_1000', 'control', 'success'),
  F('control_refresh_now_after_stop', 'control', 'success'),
  F('control_stop_twice', 'control', 'success'),
  F('control_start_twice_same_tick', 'control', 'success'),
  F('control_restart_during_inflight', 'control', 'success'),
];

const INPUT_FAULTS: readonly Fault[] = [
  F('input_expiry_nan', 'input', 'success'),
  F('input_expiry_negative', 'input', 'success'),
  F('input_expiry_huge', 'input', 'success'),
  F('input_expiry_past', 'input', 'success'),
  F('input_expiry_inside_lead', 'input', 'success'),
  F('input_expiry_exactly_lead', 'input', 'success'),
];

const ALL_FAULTS: readonly Fault[] = [
  ...ATTEMPT_FAULTS,
  ...CALLBACK_FAULTS,
  ...CLOCK_FAULTS,
  ...APPSTATE_FAULTS,
  ...CONTROL_FAULTS,
  ...INPUT_FAULTS,
];

const byId = (id: string): Fault => {
  const fault = ALL_FAULTS.find(f => f.id === id);
  if (!fault) throw new Error(`no fault ${id}`);
  return fault;
};

// ─── Fake transport ──────────────────────────────────────────────────────────

interface Issued {
  access: string;
  refresh: string;
  expiresAt: number;
}

interface Attempt {
  n: number;
  t: number;
  fault: string | null;
  refreshTokenSent: string | null;
  settled: boolean;
  settledAt: number | null;
  /** Set when a body with tokens was sent (even under a non-2xx). */
  issued: Issued | null;
  /** Started by refreshSessionNow (an API 401 report) or a foreground
   * event rather than by the keeper's own expiry timer — or the backoff
   * retry of such a request. Caller-driven, so the 30 s rotation floor does
   * not apply to it by design (the caller asked; the floor guards the
   * expiry schedule against short-lived / skewed `expiresAt`). */
  viaCaller: boolean;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

function never(): Promise<never> {
  return new Promise<never>(() => {});
}

function delayed<T>(ms: number, make: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    setTimeout(() => resolve(make()), ms);
  });
}

function hangUntilAbort(
  signal: AbortSignal | null | undefined,
): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    signal.addEventListener('abort', () => reject(abortError()), {
      once: true,
    });
  });
}

function json(status: number, body: unknown): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class Server {
  attempts: Attempt[] = [];
  inflight = 0;
  maxInflight = 0;
  private counter = 0;
  /** Fault to serve on attempt n (1-based); healthy when absent. */
  faultAt = new Map<number, string>();
  /** Served on EVERY attempt without an explicit entry. */
  persistentFault: string | null = null;
  lifeSeconds = HEALTHY_LIFE_S;
  lastIssued: Issued | null = null;
  lastRotatedRefresh: string | null = null;
  continuityViolations: string[] = [];

  issue(overrides: Partial<Issued> = {}): Issued {
    this.counter += 1;
    const issued: Issued = {
      access: `access-${this.counter}`,
      refresh: `refresh-${this.counter}`,
      expiresAt: Math.floor(Date.now() / 1000) + this.lifeSeconds,
      ...overrides,
    };
    this.lastIssued = issued;
    return issued;
  }

  sessionBody(issued: Issued, extra: Record<string, unknown> = {}): unknown {
    return {
      session: {
        accessToken: issued.access,
        refreshToken: issued.refresh,
        expiresAt: issued.expiresAt,
        ...extra,
      },
    };
  }

  readonly fetchFn: SessionFetch = (url, init) => {
    const n = this.attempts.length + 1;
    const fault = this.faultAt.get(n) ?? this.persistentFault;
    let sent: string | null = null;
    try {
      const parsed = JSON.parse(String(init?.body)) as {
        refreshToken?: unknown;
      };
      sent =
        typeof parsed.refreshToken === 'string' ? parsed.refreshToken : null;
    } catch {
      sent = null;
    }
    const previous = this.attempts[this.attempts.length - 1];
    const attempt: Attempt = {
      n,
      t: Date.now(),
      fault,
      refreshTokenSent: sent,
      settled: false,
      settledAt: null,
      issued: null,
      // A backoff retry inherits the provenance of the request it retries.
      viaCaller:
        previous !== undefined &&
        previous.viaCaller &&
        isSettledTransientFailure(previous),
    };
    this.attempts.push(attempt);
    if (!url.endsWith('/v1/auth/refresh')) {
      this.continuityViolations.push(`attempt ${n} hit unexpected url ${url}`);
    }
    if (init?.method !== 'POST') {
      this.continuityViolations.push(`attempt ${n} used ${init?.method}`);
    }
    if (this.lastRotatedRefresh !== null && sent !== this.lastRotatedRefresh) {
      this.continuityViolations.push(
        `attempt ${n} re-sent ${sent ?? '<none>'} after rotation to ${this.lastRotatedRefresh}`,
      );
    }
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const settle = () => {
      this.inflight -= 1;
      attempt.settled = true;
      attempt.settledAt = Date.now();
    };
    let result: Promise<unknown>;
    try {
      result = this.serve(fault, attempt, init?.signal);
    } catch (error) {
      settle();
      throw error;
    }
    return result.then(
      value => {
        settle();
        return value as Response;
      },
      error => {
        settle();
        throw error;
      },
    );
  };

  private serve(
    fault: string | null,
    attempt: Attempt,
    signal: AbortSignal | null | undefined,
  ): Promise<unknown> {
    const healthy = () => {
      const issued = this.issue();
      attempt.issued = issued;
      return json(200, this.sessionBody(issued));
    };
    const withTokens = (
      status: number,
      overrides: Partial<Issued> = {},
      extra: Record<string, unknown> = {},
    ) => {
      const issued = this.issue(overrides);
      attempt.issued = issued;
      return json(status, this.sessionBody(issued, extra));
    };
    const partial = (session: Record<string, unknown>) => {
      const issued = this.issue();
      const body = this.sessionBody(issued) as {
        session: Record<string, unknown>;
      };
      return json(200, { session: { ...body.session, ...session } });
    };
    const raw = (text: string) => new Response(text, { status: 200 });
    switch (fault) {
      case null:
        return Promise.resolve(healthy());
      // fetch
      case 'fetch_throws_sync':
        throw new TypeError('Network request failed (sync)');
      case 'fetch_rejects_error':
        return Promise.reject(new Error('Network request failed'));
      case 'fetch_rejects_typeerror':
        return Promise.reject(new TypeError('Failed to fetch'));
      case 'fetch_rejects_string':
        return Promise.reject('offline');
      case 'fetch_rejects_null':
        return Promise.reject(null);
      case 'fetch_hang_honours_abort':
        return hangUntilAbort(signal);
      case 'fetch_hang_ignores_abort':
        return never();
      case 'fetch_slow_14s_ok':
        return delayed(REQUEST_TIMEOUT_MS - 1_000, healthy);
      case 'fetch_slow_16s_ok_honours_abort':
        return Promise.race([
          hangUntilAbort(signal),
          delayed(REQUEST_TIMEOUT_MS + 1_000, healthy),
        ]);
      case 'fetch_resolves_undefined':
        return Promise.resolve(undefined);
      case 'fetch_resolves_null':
        return Promise.resolve(null);
      case 'fetch_resolves_plain_object':
        return Promise.resolve({ body: 'nope' });
      case 'fetch_resolves_string':
        return Promise.resolve('<html>gateway</html>');
      // http
      case 'http_401':
        return Promise.resolve(json(401, { error: 'invalid_grant' }));
      case 'http_403':
        return Promise.resolve(json(403, { error: 'forbidden' }));
      case 'http_401_with_valid_body':
        return Promise.resolve(withTokens(401));
      case 'http_400':
      case 'http_402':
      case 'http_404':
      case 'http_405':
      case 'http_408':
      case 'http_409':
      case 'http_410':
      case 'http_418':
      case 'http_422':
      case 'http_425':
      case 'http_429':
      case 'http_500':
      case 'http_501':
      case 'http_502':
      case 'http_503':
      case 'http_504':
      case 'http_507':
      case 'http_511':
        return Promise.resolve(
          json(Number(fault.slice('http_'.length)), { error: fault }),
        );
      case 'http_301_valid_body':
        return Promise.resolve(withTokens(301));
      case 'http_201_valid_body':
        return Promise.resolve(withTokens(201));
      case 'http_204_empty':
        return Promise.resolve(new Response(null, { status: 204 }));
      case 'http_200_ok_false_fake_response': {
        const issued = this.issue();
        return Promise.resolve({
          status: 200,
          ok: false,
          json: async () => this.sessionBody(issued),
        });
      }
      // body
      case 'body_non_json':
        return Promise.resolve(
          new Response('<html>502</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
      case 'body_empty':
        return Promise.resolve(raw(''));
      case 'body_null':
        return Promise.resolve(json(200, null));
      case 'body_array':
        return Promise.resolve(json(200, [1, 2, 3]));
      case 'body_string':
        return Promise.resolve(json(200, 'ok'));
      case 'body_no_session':
        return Promise.resolve(json(200, { account: { id: 'x' } }));
      case 'body_session_null':
        return Promise.resolve(json(200, { session: null }));
      case 'body_session_array':
        return Promise.resolve(json(200, { session: ['a', 'b'] }));
      case 'body_missing_access':
        return Promise.resolve(partial({ accessToken: undefined }));
      case 'body_missing_refresh':
        return Promise.resolve(partial({ refreshToken: undefined }));
      case 'body_missing_expires':
        return Promise.resolve(partial({ expiresAt: undefined }));
      case 'body_empty_access':
        return Promise.resolve(partial({ accessToken: '' }));
      case 'body_whitespace_refresh':
        return Promise.resolve(partial({ refreshToken: '   ' }));
      case 'body_access_number':
        return Promise.resolve(partial({ accessToken: 12345 }));
      case 'body_refresh_object':
        return Promise.resolve(partial({ refreshToken: { token: 'x' } }));
      case 'body_expires_string':
        return Promise.resolve(
          partial({ expiresAt: String(Math.floor(Date.now() / 1000) + 3600) }),
        );
      case 'body_expires_nan':
        return Promise.resolve(
          raw(
            '{"session":{"accessToken":"a","refreshToken":"r","expiresAt":NaN}}',
          ),
        );
      case 'body_expires_infinity':
        return Promise.resolve(
          raw(
            '{"session":{"accessToken":"a","refreshToken":"r","expiresAt":1e999}}',
          ),
        );
      case 'body_expires_neg_infinity':
        return Promise.resolve(
          raw(
            '{"session":{"accessToken":"a","refreshToken":"r","expiresAt":-1e999}}',
          ),
        );
      case 'body_expires_negative':
        return Promise.resolve(withTokens(200, { expiresAt: -1 }));
      case 'body_expires_zero':
        return Promise.resolve(withTokens(200, { expiresAt: 0 }));
      case 'body_expires_float':
        return Promise.resolve(
          withTokens(200, { expiresAt: Date.now() / 1000 + 3599.5 }),
        );
      case 'body_expires_in_past_5s':
        return Promise.resolve(
          withTokens(200, { expiresAt: Math.floor(Date.now() / 1000) - 5 }),
        );
      case 'body_expires_inside_lead_30s':
        return Promise.resolve(
          withTokens(200, { expiresAt: Math.floor(Date.now() / 1000) + 30 }),
        );
      case 'body_expires_exactly_lead_60s':
        return Promise.resolve(
          withTokens(200, { expiresAt: Math.floor(Date.now() / 1000) + 60 }),
        );
      case 'body_expires_ms_units':
        return Promise.resolve(
          withTokens(200, { expiresAt: Date.now() + HEALTHY_LIFE_MS }),
        );
      case 'body_json_throws_sync':
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => {
            throw new SyntaxError('Unexpected token');
          },
        });
      case 'body_json_never_resolves':
        return Promise.resolve({ status: 200, ok: true, json: () => never() });
      case 'body_json_slow_20s_valid': {
        const issued = this.issue();
        attempt.issued = issued;
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => delayed(20_000, () => this.sessionBody(issued)),
        });
      }
      case 'body_session_getter_throws':
        return Promise.resolve({
          status: 200,
          ok: true,
          json: async () => ({
            get session(): never {
              throw new Error('poisoned payload');
            },
          }),
        });
      case 'body_1mb_junk_beside_valid':
        return Promise.resolve(
          withTokens(200, {}, { junk: 'x'.repeat(1024 * 1024) }),
        );
      case 'body_huge_tokens_256k':
        return Promise.resolve(
          withTokens(200, {
            access: 'A'.repeat(256 * 1024),
            refresh: 'R'.repeat(256 * 1024),
          }),
        );
      case 'body_extra_fields':
        return Promise.resolve(
          withTokens(
            200,
            {},
            { tokenType: 'bearer', scope: ['x'], nested: { a: 1 } },
          ),
        );
      case 'body_same_refresh_token_back': {
        const previous = attempt.refreshTokenSent ?? 'refresh-0';
        return Promise.resolve(withTokens(200, { refresh: previous }));
      }
      default:
        throw new Error(`unknown attempt fault ${fault}`);
    }
  }
}

// ─── Injection points around the keeper ──────────────────────────────────────

let appStateHandler: ((state: string) => void) | null = null;
let appStateAddThrows = false;
let appStateRemoveThrows = false;

function installAppStateSpy(): void {
  appStateHandler = null;
  appStateAddThrows = false;
  appStateRemoveThrows = false;
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type: string,
    handler: (state: string) => void,
  ) => {
    if (appStateAddThrows) throw new Error('AppState unavailable');
    appStateHandler = handler;
    return {
      remove: () => {
        if (appStateRemoveThrows) throw new Error('subscription gone');
        if (appStateHandler === handler) appStateHandler = null;
      },
    };
  }) as unknown as typeof AppState.addEventListener);
}

/** Runs `fire` (which may start a request synchronously) and marks the
 * request it started as caller-driven. */
function callerDriven(server: Server, fire: () => void): void {
  const before = server.attempts.length;
  fire();
  const started = server.attempts[before];
  if (started) started.viaCaller = true;
}

const foreground = async (server: Server, state = 'active') => {
  callerDriven(server, () => appStateHandler?.(state));
  await jest.advanceTimersByTimeAsync(0);
};

interface Clock {
  offsetMs: number;
  frozenAt: number | null;
  mode: 'normal' | 'nan' | 'negative' | 'far_future' | 'jitter';
  now: () => number;
}

function makeClock(): Clock {
  const clock: Clock = {
    offsetMs: 0,
    frozenAt: null,
    mode: 'normal',
    now: () => {
      switch (clock.mode) {
        case 'nan':
          return Number.NaN;
        case 'negative':
          return -1;
        case 'far_future':
          return 8.64e15; // max Date value
        case 'jitter':
          return Date.now() + clock.offsetMs + (Date.now() % 3) * 0.25;
        default:
          return (clock.frozenAt ?? Date.now()) + clock.offsetMs;
      }
    },
  };
  return clock;
}

interface Hooks {
  onRotatedFault?: string;
  onRevokedFault?: string;
  onDeferredFault?: string;
  /** Apply the callback fault on EVERY call instead of only the first. */
  persistent?: boolean;
}

interface Observations {
  rotated: RefreshedTokens[];
  rotatedAt: number[];
  /** Timestamps of rotations the keeper's own timer produced (caller-driven
   * ones excluded) — the population the 30 s floor governs. */
  timerRotatedAt: number[];
  revokedCalls: number;
  revokedAt: number[];
  deferredCalls: number;
  deferredAt: number[];
  deferredErrors: string[];
  fakeSuccess: string[];
  startThrew: string | null;
}

function emptyObservations(): Observations {
  return {
    rotated: [],
    rotatedAt: [],
    timerRotatedAt: [],
    revokedCalls: 0,
    revokedAt: [],
    deferredCalls: 0,
    deferredAt: [],
    deferredErrors: [],
    fakeSuccess: [],
    startThrew: null,
  };
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

function start(
  server: Server,
  clock: Clock,
  obs: Observations,
  hooks: Hooks,
  input: Partial<SessionKeeperInput> = {},
): void {
  let rotatedCalls = 0;
  let revokedCalls = 0;
  let deferredCalls = 0;
  const applies = (calls: number) => hooks.persistent || calls === 1;
  const restart = () => restartFromCurrent(server, clock, obs);
  const keeperInput: SessionKeeperInput = {
    apiBaseUrl: 'https://api.test',
    refreshToken: 'refresh-0',
    bearerExpiresAtMs: null,
    fetchFn: server.fetchFn,
    now: clock.now,
    onRotated: tokens => {
      rotatedCalls += 1;
      obs.rotated.push(tokens);
      obs.rotatedAt.push(Date.now());
      const source = server.attempts.find(
        a => a.issued?.access === tokens.bearerToken,
      );
      if (!source?.viaCaller) obs.timerRotatedAt.push(Date.now());
      const issued = server.lastIssued;
      if (
        !issued ||
        tokens.bearerToken !== issued.access ||
        tokens.refreshToken !== issued.refresh ||
        tokens.bearerExpiresAtMs !== issued.expiresAt * 1000
      ) {
        obs.fakeSuccess.push(
          `onRotated reported ${tokens.bearerToken.slice(0, 16)}/${tokens.refreshToken.slice(0, 16)}/${tokens.bearerExpiresAtMs} but server issued ${issued?.access.slice(0, 16)}/${issued?.refresh.slice(0, 16)}/${issued ? issued.expiresAt * 1000 : 'nothing'}`,
        );
      }
      server.lastRotatedRefresh = tokens.refreshToken;
      if (!applies(rotatedCalls)) return;
      switch (hooks.onRotatedFault) {
        case 'cb_rotated_throws_sync':
          throw new Error('adoptRotatedTokens exploded');
        case 'cb_rotated_rejects':
          return Promise.reject(new Error('persist rejected'));
        case 'cb_rotated_hangs_forever':
          return never();
        case 'cb_rotated_slow_20s':
          return delayed(20_000, () => undefined);
        case 'cb_rotated_calls_stop':
          stopSessionKeeper();
          return;
        case 'cb_rotated_restarts_keeper':
          restart();
          return;
        case 'cb_rotated_calls_refresh_now':
          refreshSessionNow();
          return;
        default:
          return;
      }
    },
    onRevoked: () => {
      revokedCalls += 1;
      obs.revokedCalls += 1;
      obs.revokedAt.push(Date.now());
      if (!applies(revokedCalls)) return;
      switch (hooks.onRevokedFault) {
        case 'cb_revoked_throws_sync':
          throw new Error('dropRevokedSession exploded');
        case 'cb_revoked_rejects':
          return Promise.reject(new Error('keychain clear rejected'));
        case 'cb_revoked_hangs_forever':
          return never();
        case 'cb_revoked_restarts_keeper':
          restart();
          return;
        default:
          return;
      }
    },
    onDeferred: error => {
      deferredCalls += 1;
      obs.deferredCalls += 1;
      obs.deferredAt.push(Date.now());
      obs.deferredErrors.push(describeError(error));
      if (!applies(deferredCalls)) return;
      switch (hooks.onDeferredFault) {
        case 'cb_deferred_throws':
          throw new Error('onOutcome exploded');
        case 'cb_deferred_calls_refresh_now':
          refreshSessionNow();
          return;
        case 'cb_deferred_calls_stop':
          stopSessionKeeper();
          return;
        default:
          return;
      }
    },
    ...input,
  };
  try {
    startSessionKeeper(keeperInput);
  } catch (error) {
    obs.startThrew = describeError(error);
  }
}

/** What authStore does on a re-sign-in / re-hydrate: a fresh keeper for the
 * CURRENT refresh token and bearer expiry. */
function restartFromCurrent(
  server: Server,
  clock: Clock,
  obs: Observations,
): void {
  start(
    server,
    clock,
    obs,
    {},
    {
      refreshToken: server.lastRotatedRefresh ?? 'refresh-0',
      bearerExpiresAtMs: server.lastIssued
        ? server.lastIssued.expiresAt * 1000
        : null,
    },
  );
}

// ─── Judge ───────────────────────────────────────────────────────────────────

function maxInAnyWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[j] ?? Infinity) < (times[i] ?? 0) - windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

function minGap(times: number[]): number | null {
  let best: number | null = null;
  for (let i = 1; i < times.length; i++) {
    const gap = (times[i] ?? 0) - (times[i - 1] ?? 0);
    best = best === null ? gap : Math.min(best, gap);
  }
  return best;
}

const REFUSALS = new Set(['http_401', 'http_403', 'http_401_with_valid_body']);

const isSettledTransientFailure = (a: Attempt): boolean =>
  a.settled &&
  a.fault !== null &&
  !REFUSALS.has(a.fault) &&
  byId(a.fault).expect !== 'success';

interface JudgeOptions {
  attemptsBeforeDrain: number;
  allowStall: boolean;
  /** A restart from inside onRevoked legitimately sends more requests. */
  allowRequestsAfterRevoke: boolean;
  /** stop() does not abort the previous generation's in-flight request. */
  allowAbandonedInflight: boolean;
  /** Exact onDeferred accounting (false when a callback fault turns a
   * delivered success into a deferred retry — FI-3). */
  exactDeferred: boolean;
}

interface Judgement {
  violations: string[];
  maxRequestsInAny60s: number;
  minRotationGapMs: number | null;
}

function judge(
  server: Server,
  obs: Observations,
  options: JudgeOptions,
): Judgement {
  const violations: string[] = [];
  const refusalsDelivered = server.attempts.filter(
    a => a.fault !== null && REFUSALS.has(a.fault),
  ).length;
  // REVOKE_ONLY_ON_REFUSAL
  if (obs.revokedCalls > 1)
    violations.push(`onRevoked fired ${obs.revokedCalls}×`);
  if (refusalsDelivered > 0 && obs.revokedCalls === 0)
    violations.push('401/403 delivered but onRevoked never fired');
  if (refusalsDelivered === 0 && obs.revokedCalls > 0)
    violations.push('onRevoked fired without a delivered 401/403');
  const firstRevokedAt = obs.revokedAt[0];
  if (firstRevokedAt !== undefined && !options.allowRequestsAfterRevoke) {
    const after = server.attempts.filter(a => a.t > firstRevokedAt).length;
    if (after > 0) violations.push(`${after} request(s) sent after onRevoked`);
  }
  // NO_FAKE_SUCCESS
  violations.push(...obs.fakeSuccess);
  // NO_SILENT_FAILURE
  const settledFailures = server.attempts.filter(
    isSettledTransientFailure,
  ).length;
  if (
    obs.deferredCalls < settledFailures ||
    (options.exactDeferred && obs.deferredCalls !== settledFailures)
  ) {
    violations.push(
      `onDeferred fired ${obs.deferredCalls}× for ${settledFailures} settled transient failure(s)`,
    );
  }
  // ONE_INFLIGHT
  if (server.maxInflight > 1 && !options.allowAbandonedInflight)
    violations.push(`${server.maxInflight} concurrent requests`);
  // TOKEN_CONTINUITY
  violations.push(...server.continuityViolations);
  // NO_STORM (the keeper's own timer; caller-driven requests are bounded by
  // the caller — an API 401 report or a foreground event — by design)
  const times = server.attempts.filter(a => !a.viaCaller).map(a => a.t);
  const maxRequestsInAny60s = maxInAnyWindow(times, 60_000);
  if (maxRequestsInAny60s > 30)
    violations.push(`${maxRequestsInAny60s} requests in one 60 s window`);
  const rotationGap = minGap(obs.timerRotatedAt);
  if (rotationGap !== null && rotationGap < MIN_ROTATION_GAP_MS)
    violations.push(`two successful rotations ${rotationGap} ms apart`);
  // NO_STALL
  if (
    !options.allowStall &&
    obs.revokedCalls === 0 &&
    server.attempts.length === options.attemptsBeforeDrain
  ) {
    violations.push('STALL: no refresh attempt during the drain window');
  }
  return { violations, maxRequestsInAny60s, minRotationGapMs: rotationGap };
}

// ─── Single-fault scenarios ──────────────────────────────────────────────────

interface SingleFaultResult {
  fault: string;
  category: Category;
  expect: Expect;
  finding: string | null;
  verdict: 'HELD' | 'BROKEN';
  violations: string[];
  attempts: number;
  rotated: number;
  deferred: number;
  revoked: number;
  firstRetryDelayMs: number | null;
  maxRequestsInAny60s: number;
  minRotationGapMs: number | null;
  startThrew: string | null;
  responsive: boolean | null;
  notes: string[];
}

/** One fault (on the first attempt / the first callback call / the clock /
 * AppState / the input), then a healthy server, then the drain, then an
 * API-401 report to prove the keeper is still responsive. */
async function runSingleFault(fault: Fault): Promise<SingleFaultResult> {
  const server = new Server();
  const clock = makeClock();
  const obs = emptyObservations();
  const hooks: Hooks = {};
  const notes: string[] = [];
  let input: Partial<SessionKeeperInput> = {};
  const id = fault.id;
  const stopsItself = id.endsWith('calls_stop');
  const restarts = id.includes('restarts');
  const abandonsInflight =
    id === 'control_start_twice_same_tick' ||
    id === 'control_restart_during_inflight' ||
    restarts;

  // ── pre-start setup ──
  switch (fault.category) {
    case 'fetch':
    case 'http':
    case 'body':
      server.faultAt.set(1, id);
      break;
    case 'callback':
      if (id.startsWith('cb_rotated')) hooks.onRotatedFault = id;
      if (id.startsWith('cb_revoked')) {
        hooks.onRevokedFault = id;
        server.faultAt.set(1, 'http_401');
      }
      if (id.startsWith('cb_deferred')) {
        hooks.onDeferredFault = id;
        server.faultAt.set(1, 'http_503');
      }
      break;
    case 'clock':
      if (id === 'clock_nan') clock.mode = 'nan';
      if (id === 'clock_negative') clock.mode = 'negative';
      if (id === 'clock_far_future') clock.mode = 'far_future';
      if (id === 'clock_sub_ms_jitter') clock.mode = 'jitter';
      if (id === 'clock_frozen') clock.frozenAt = Date.now();
      break;
    case 'appstate':
      if (id === 'appstate_add_listener_throws') appStateAddThrows = true;
      if (id === 'appstate_remove_throws') appStateRemoveThrows = true;
      if (id === 'appstate_active_during_inflight')
        server.faultAt.set(1, 'fetch_slow_14s_ok');
      break;
    case 'control':
      if (id === 'control_restart_during_inflight')
        server.faultAt.set(1, 'fetch_slow_14s_ok');
      break;
    case 'input':
      if (id === 'input_expiry_nan') input = { bearerExpiresAtMs: Number.NaN };
      if (id === 'input_expiry_negative') input = { bearerExpiresAtMs: -1 };
      if (id === 'input_expiry_huge')
        input = { bearerExpiresAtMs: Date.now() + 2 ** 40 };
      if (id === 'input_expiry_past')
        input = { bearerExpiresAtMs: Date.now() - 5_000 };
      if (id === 'input_expiry_inside_lead')
        input = { bearerExpiresAtMs: Date.now() + 30_000 };
      if (id === 'input_expiry_exactly_lead')
        input = { bearerExpiresAtMs: Date.now() + REFRESH_LEAD_MS };
      break;
  }

  start(server, clock, obs, hooks, input);

  // ── post-start events ──
  switch (id) {
    case 'control_refresh_now_burst_1000':
      for (let i = 0; i < 1000; i++) refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
      notes.push(
        `requests after start + 1000 refreshSessionNow: ${server.attempts.length}`,
      );
      break;
    case 'control_refresh_now_after_stop':
      await jest.advanceTimersByTimeAsync(0);
      stopSessionKeeper();
      for (let i = 0; i < 10; i++) refreshSessionNow();
      await jest.advanceTimersByTimeAsync(DRAIN_MS);
      notes.push(
        `requests after stop + 10 refreshSessionNow: ${server.attempts.length - 1}`,
      );
      if (server.attempts.length !== 1)
        notes.push('BROKEN: refreshSessionNow after stop sent a request');
      restartFromCurrent(server, clock, obs);
      break;
    case 'control_stop_twice':
      await jest.advanceTimersByTimeAsync(0);
      stopSessionKeeper();
      stopSessionKeeper();
      restartFromCurrent(server, clock, obs);
      break;
    case 'control_start_twice_same_tick':
      start(server, clock, obs, {}, {});
      notes.push(
        `in flight after two starts in one tick: ${server.maxInflight}`,
      );
      break;
    case 'control_restart_during_inflight':
      await jest.advanceTimersByTimeAsync(5_000);
      start(server, clock, obs, {}, {});
      notes.push(
        `in flight after restart during a slow refresh: ${server.maxInflight} (stop does not abort the abandoned request)`,
      );
      break;
    case 'appstate_non_active_states':
      await jest.advanceTimersByTimeAsync(0);
      for (const s of ['background', 'inactive', 'unknown', 'extension', '']) {
        await foreground(server, s);
      }
      notes.push(
        `requests after 5 non-active AppState events: ${server.attempts.length}`,
      );
      break;
    case 'appstate_active_burst_1000':
      await jest.advanceTimersByTimeAsync(0);
      // Age the bearer into the foreground lead so 'active' wants a refresh.
      await jest.advanceTimersByTimeAsync(
        HEALTHY_LIFE_MS - FOREGROUND_LEAD_MS + 1_000,
      );
      for (let i = 0; i < 1000; i++)
        callerDriven(server, () => appStateHandler?.('active'));
      await jest.advanceTimersByTimeAsync(0);
      notes.push(
        `requests after 1000 'active' events in one tick: ${server.attempts.length}`,
      );
      break;
    case 'appstate_active_during_inflight':
      await jest.advanceTimersByTimeAsync(1_000);
      for (let i = 0; i < 5; i++) await foreground(server);
      notes.push(
        `requests with one in flight + 5 foregrounds: ${server.attempts.length}`,
      );
      break;
    case 'appstate_active_after_stop':
      await jest.advanceTimersByTimeAsync(0);
      stopSessionKeeper();
      await jest.advanceTimersByTimeAsync(HEALTHY_LIFE_MS);
      await foreground(server);
      notes.push(
        `requests after stop + foreground: ${server.attempts.length - 1}`,
      );
      if (server.attempts.length !== 1)
        notes.push('BROKEN: foreground after stop sent a request');
      restartFromCurrent(server, clock, obs);
      break;
    case 'clock_backward_1h_after_rotation':
      await jest.advanceTimersByTimeAsync(0);
      clock.offsetMs = -3_600_000;
      break;
    case 'clock_forward_2h_after_rotation':
      await jest.advanceTimersByTimeAsync(0);
      clock.offsetMs = 2 * 3_600_000;
      break;
    default:
      break;
  }

  await jest.advanceTimersByTimeAsync(0);
  const first = server.attempts[0];
  let firstRetryDelayMs: number | null = null;
  if (fault.expect === 'transient') {
    // Wait for the fault to settle (hangs take the full timeout), then the
    // retry must land exactly one backoff step later.
    await jest.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1);
    const settledAt = first?.settledAt ?? null;
    await jest.advanceTimersByTimeAsync(RETRY_MAX_MS);
    const second = server.attempts[1];
    if (settledAt !== null && second) firstRetryDelayMs = second.t - settledAt;
  }
  const attemptsBeforeDrain = server.attempts.length;
  // Drain, plus a second bearer lifetime (a 1 h backward clock jump
  // legitimately schedules up to 2 h out) so a keeper that survived proves
  // it by rotating again.
  await jest.advanceTimersByTimeAsync(DRAIN_MS + HEALTHY_LIFE_MS);

  const judgement = judge(server, obs, {
    attemptsBeforeDrain,
    allowStall: fault.expect === 'stall' || stopsItself,
    allowRequestsAfterRevoke: restarts,
    allowAbandonedInflight: abandonsInflight,
    exactDeferred: !id.startsWith('cb_rotated'),
  });
  const violations = [...judgement.violations];

  // ── per-class expectations ──
  switch (fault.expect) {
    case 'refuse':
      if (obs.revokedCalls !== 1)
        violations.push('refusal did not revoke exactly once');
      if (!restarts && obs.rotated.length !== 0)
        violations.push('refusal rotated');
      if (!restarts && server.attempts.length !== 1)
        violations.push(`${server.attempts.length} attempts after a refusal`);
      break;
    case 'transient':
      if (obs.revokedCalls !== 0) violations.push('transient fault revoked');
      if (obs.deferredCalls < 1)
        violations.push('transient fault produced no onDeferred');
      if (
        !stopsItself &&
        firstRetryDelayMs !== null &&
        Math.abs(firstRetryDelayMs - retryDelayMs(1)) > 2
      ) {
        violations.push(
          `first retry after ${firstRetryDelayMs} ms, expected ${retryDelayMs(1)}`,
        );
      }
      if (!stopsItself && firstRetryDelayMs === null)
        violations.push('no retry after the transient fault');
      if (!stopsItself && obs.rotated.length < 1)
        violations.push('RECOVERY: never rotated after the fault cleared');
      break;
    case 'success':
      if (obs.revokedCalls !== 0) violations.push('success path revoked');
      if (obs.rotated.length < 1)
        violations.push('no rotation on a valid response');
      if (
        (fault.category === 'body' ||
          fault.category === 'http' ||
          fault.category === 'fetch') &&
        obs.deferredCalls !== 0
      ) {
        violations.push('valid response reported as deferred');
      }
      break;
    case 'stall':
    case 'storm':
      break;
  }
  if (obs.startThrew)
    violations.push(`startSessionKeeper threw: ${obs.startThrew}`);

  // ── RESPONSIVE: an API 401 report after the drain must produce a request ──
  let responsive: boolean | null = null;
  const stalled =
    obs.revokedCalls === 0 && server.attempts.length === attemptsBeforeDrain;
  if (fault.expect === 'stall') {
    notes.push(
      stalled
        ? `STALL reproduced: ${server.attempts.length} attempt(s), then silence for ${DRAIN_MS + HEALTHY_LIFE_MS} ms`
        : 'no stall observed (fixed?)',
    );
  }
  if (obs.revokedCalls === 0 && !stopsItself && !obs.startThrew) {
    const before = server.attempts.length;
    callerDriven(server, refreshSessionNow);
    await jest.advanceTimersByTimeAsync(0);
    responsive = server.attempts.length === before + 1;
    if (!responsive && fault.expect !== 'stall')
      violations.push(
        'RESPONSIVE: refreshSessionNow after the drain sent nothing',
      );
  }

  try {
    stopSessionKeeper();
  } catch (error) {
    notes.push(`stopSessionKeeper threw: ${describeError(error)}`);
  }
  return {
    fault: id,
    category: fault.category,
    expect: fault.expect,
    finding: fault.finding ?? null,
    verdict: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    attempts: server.attempts.length,
    rotated: obs.rotated.length,
    deferred: obs.deferredCalls,
    revoked: obs.revokedCalls,
    firstRetryDelayMs,
    maxRequestsInAny60s: judgement.maxRequestsInAny60s,
    minRotationGapMs: judgement.minRotationGapMs,
    startThrew: obs.startThrew,
    responsive,
    notes,
  };
}

/** Storm faults re-arm every millisecond under Node timers; bound the window
 * instead of draining hours. */
async function runStormProbe(
  fault: Fault,
  windowMs: number,
): Promise<SingleFaultResult> {
  const server = new Server();
  const clock = makeClock();
  const obs = emptyObservations();
  if (fault.id === 'body_expires_ms_units') server.persistentFault = fault.id;
  if (fault.id === 'clock_nan') clock.mode = 'nan';
  if (fault.id === 'clock_negative') clock.mode = 'negative';
  start(server, clock, obs, {});
  await jest.advanceTimersByTimeAsync(windowMs);
  const judgement = judge(server, obs, {
    attemptsBeforeDrain: 0,
    allowStall: true,
    allowRequestsAfterRevoke: false,
    allowAbandonedInflight: false,
    exactDeferred: true,
  });
  stopSessionKeeper();
  return {
    fault: fault.id,
    category: fault.category,
    expect: fault.expect,
    finding: fault.finding ?? null,
    verdict: judgement.violations.length === 0 ? 'HELD' : 'BROKEN',
    violations: judgement.violations,
    attempts: server.attempts.length,
    rotated: obs.rotated.length,
    deferred: obs.deferredCalls,
    revoked: obs.revokedCalls,
    firstRetryDelayMs: null,
    maxRequestsInAny60s: judgement.maxRequestsInAny60s,
    minRotationGapMs: judgement.minRotationGapMs,
    startThrew: obs.startThrew,
    responsive: null,
    notes: [
      `${server.attempts.length} requests in ${windowMs} ms of fake time`,
    ],
  };
}

// ─── Seeded campaign ─────────────────────────────────────────────────────────

/** Faults safe for the randomized campaign (the known-broken ones are pinned
 * individually; here every seed must recover). */
const CAMPAIGN_ATTEMPT_FAULTS = ATTEMPT_FAULTS.filter(
  f => f.expect !== 'stall' && f.expect !== 'storm' && !f.finding,
);
const CAMPAIGN_CALLBACK_FAULTS = CALLBACK_FAULTS.filter(
  f =>
    f.expect !== 'stall' &&
    !f.finding &&
    !f.id.includes('calls_stop') &&
    !f.id.includes('restarts'),
);

type Event =
  | { kind: 'advance'; ms: number }
  | { kind: 'foreground' }
  | { kind: 'refreshNow' }
  | { kind: 'clockJump'; ms: number };

interface Scenario {
  seed: number;
  initialExpiresInMs: number | null;
  faults: Array<{ attempt: number; fault: string }>;
  callbackFault: string | null;
  events: Event[];
}

const ADVANCES = [
  0, 1, 999, 1_000, 4_999, 5_000, 15_001, 30_000, 61_000, 299_000, 300_001,
  3_540_000, 3_600_000, 7_200_000,
];
const CLOCK_JUMPS = [-3_600_000, -60_000, 60_000, 3_600_000, 86_400_000];
const INITIALS = [null, -5_000, 0, 30_000, 60_000, 299_000, 300_000, 3_600_000];

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const faultCount = int(rng, 3, 12);
  const faults: Array<{ attempt: number; fault: string }> = [];
  let attempt = 1;
  for (let i = 0; i < faultCount; i++) {
    faults.push({ attempt, fault: pick(rng, CAMPAIGN_ATTEMPT_FAULTS).id });
    attempt += int(rng, 1, 3);
  }
  const events: Event[] = [];
  const eventCount = int(rng, 6, 30);
  for (let i = 0; i < eventCount; i++) {
    const r = rng();
    if (r < 0.5) events.push({ kind: 'advance', ms: pick(rng, ADVANCES) });
    else if (r < 0.75) events.push({ kind: 'foreground' });
    else if (r < 0.9) events.push({ kind: 'refreshNow' });
    else events.push({ kind: 'clockJump', ms: pick(rng, CLOCK_JUMPS) });
  }
  const callbackFault =
    rng() < 0.25 ? pick(rng, CAMPAIGN_CALLBACK_FAULTS).id : null;
  return {
    seed,
    initialExpiresInMs: pick(rng, INITIALS),
    faults,
    callbackFault,
    events,
  };
}

interface SeedResult {
  seed: number;
  verdict: 'HELD' | 'BROKEN';
  violations: string[];
  faults: string[];
  callbackFault: string | null;
  events: number;
  attempts: number;
  rotated: number;
  deferred: number;
  revoked: number;
  refusalsDelivered: number;
  maxRequestsInAny60s: number;
  minRotationGapMs: number | null;
  /** Request-by-request timeline (fake-clock ms since scenario start);
   * always present for a BROKEN seed, for every seed with STRESS_TRACE=1. */
  timeline?: string[];
}

function timelineOf(server: Server, obs: Observations, t0: number): string[] {
  const rotatedAt = new Set(obs.rotatedAt);
  return server.attempts.map(a => {
    const settled =
      a.settledAt === null ? 'unsettled' : `settled@${a.settledAt - t0}`;
    const outcome =
      a.issued && rotatedAt.has(a.settledAt ?? -1) ? ' rotated' : '';
    return `#${a.n} t=${a.t - t0} ${a.fault ?? 'healthy'}${a.viaCaller ? ' (caller)' : ''} sent=${(a.refreshTokenSent ?? '<none>').slice(0, 24)} ${settled}${outcome}`;
  });
}

async function runScenario(scenario: Scenario): Promise<SeedResult> {
  const server = new Server();
  const clock = makeClock();
  const obs = emptyObservations();
  const hooks: Hooks = {};
  for (const f of scenario.faults) server.faultAt.set(f.attempt, f.fault);
  const cb = scenario.callbackFault;
  if (cb) {
    if (cb.startsWith('cb_rotated')) hooks.onRotatedFault = cb;
    if (cb.startsWith('cb_revoked')) hooks.onRevokedFault = cb;
    if (cb.startsWith('cb_deferred')) hooks.onDeferredFault = cb;
  }
  const t0 = Date.now();
  start(server, clock, obs, hooks, {
    bearerExpiresAtMs:
      scenario.initialExpiresInMs === null
        ? null
        : Date.now() + scenario.initialExpiresInMs,
  });
  let backwardMs = 0;
  for (const event of scenario.events) {
    if (event.kind === 'advance') await jest.advanceTimersByTimeAsync(event.ms);
    else if (event.kind === 'foreground') await foreground(server);
    else if (event.kind === 'refreshNow') {
      callerDriven(server, refreshSessionNow);
      await jest.advanceTimersByTimeAsync(0);
    } else {
      clock.offsetMs += event.ms;
      if (event.ms < 0) backwardMs += -event.ms;
    }
  }
  // Every scheduled fault must get its chance: a fault on attempt N only
  // fires once N attempts happened.
  const lastFaultAttempt = Math.max(...scenario.faults.map(f => f.attempt));
  let guard = 0;
  while (
    server.attempts.length < lastFaultAttempt &&
    obs.revokedCalls === 0 &&
    guard < 40
  ) {
    await jest.advanceTimersByTimeAsync(DRAIN_MS);
    guard += 1;
  }
  const attemptsBeforeDrain = server.attempts.length;
  await jest.advanceTimersByTimeAsync(DRAIN_MS + backwardMs);
  const judgement = judge(server, obs, {
    attemptsBeforeDrain,
    allowStall: false,
    allowRequestsAfterRevoke: false,
    allowAbandonedInflight: false,
    exactDeferred: true,
  });
  const violations = [...judgement.violations];
  // RECOVERY: unless revoked, the healthy tail must have rotated.
  if (obs.revokedCalls === 0) {
    const last = server.attempts[server.attempts.length - 1];
    if (!last || last.fault !== null || last.issued === null || !last.settled) {
      violations.push(
        'RECOVERY: last attempt of the healthy tail was not a healthy rotation',
      );
    }
  }
  stopSessionKeeper();
  const refusalsDelivered = server.attempts.filter(
    a => a.fault !== null && REFUSALS.has(a.fault),
  ).length;
  return {
    seed: scenario.seed,
    verdict: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    faults: scenario.faults.map(f => `${f.attempt}:${f.fault}`),
    callbackFault: cb,
    events: scenario.events.length,
    attempts: server.attempts.length,
    rotated: obs.rotated.length,
    deferred: obs.deferredCalls,
    revoked: obs.revokedCalls,
    refusalsDelivered,
    maxRequestsInAny60s: judgement.maxRequestsInAny60s,
    minRotationGapMs: judgement.minRotationGapMs,
    ...(violations.length > 0 || process.env.STRESS_TRACE
      ? { timeline: timelineOf(server, obs, t0) }
      : {}),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const OUT_DIR =
  process.env.STRESS_OUT ??
  path.resolve(__dirname, '../../../../artifacts/stress/mod-session-keeper');

function writeReport(name: string, report: unknown): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date(REAL_NOW()).toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(
    path.resolve(OUT_DIR, `failure-injection-${name}-${stamp}.json`),
    JSON.stringify(report, null, 2),
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-06T12:00:00Z'));
  installAppStateSpy();
});

afterEach(() => {
  appStateRemoveThrows = false;
  stopSessionKeeper();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const HEALTHY_FAULTS = ALL_FAULTS.filter(f => !f.finding);
const KNOWN_BROKEN = ALL_FAULTS.filter(f => f.finding);

const singleResults: SingleFaultResult[] = [];

describe('sessionKeeper failure injection — one fault per dependency, then recovery', () => {
  it(`catalogue covers ≥ 60 injected faults (${ALL_FAULTS.length})`, () => {
    expect(ALL_FAULTS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(ALL_FAULTS.map(f => f.id)).size).toBe(ALL_FAULTS.length);
  });

  it.each(HEALTHY_FAULTS.map(f => [f.id, f] as const))(
    'HELD: %s',
    async (_id, fault) => {
      const result = await runSingleFault(fault);
      singleResults.push(result);
      expect(result.violations).toEqual([]);
      expect(result.verdict).toBe('HELD');
    },
  );
});

describe('KNOWN BROKEN (findings FI-1..FI-7): pins the CURRENT failure mode — flip to the healthy expectation when fixed', () => {
  it('FI-1 a fetch that ignores the abort signal and never settles leaves the keeper in flight forever (no retry, no onDeferred, refreshSessionNow and foreground are no-ops)', async () => {
    const result = await runSingleFault(byId('fetch_hang_ignores_abort'));
    singleResults.push(result);
    expect(result.attempts).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.responsive).toBe(false);
    expect(result.notes[0]).toMatch(/^STALL reproduced/);
  });

  it('FI-2 a response whose body never arrives (json() never resolves) is outside the 15 s timeout and stalls the keeper the same way', async () => {
    const result = await runSingleFault(byId('body_json_never_resolves'));
    singleResults.push(result);
    expect(result.attempts).toBe(1);
    expect(result.rotated).toBe(0);
    expect(result.deferred).toBe(0);
    expect(result.responsive).toBe(false);
    expect(result.notes[0]).toMatch(/^STALL reproduced/);
  });

  it.each([['cb_rotated_throws_sync'], ['cb_rotated_rejects']])(
    'FI-3 %s: a throwing onRotated is classified as a transient network failure — onDeferred fires for a DELIVERED success and the retry re-arms 5 s later, under the 30 s rotation floor',
    async id => {
      const result = await runSingleFault(byId(id));
      singleResults.push(result);
      expect(result.revoked).toBe(0);
      expect(result.rotated).toBeGreaterThanOrEqual(2);
      expect(result.deferred).toBe(1);
      expect(result.violations).toContain(
        `two successful rotations ${retryDelayMs(1)} ms apart`,
      );
    },
  );

  it('FI-3 a persistently throwing onRotated never backs off: failedAttempts is reset BEFORE the callback runs, so the keeper rotates every 5 s (12 refresh-token generations per minute) for as long as it lasts', async () => {
    const server = new Server();
    const clock = makeClock();
    const obs = emptyObservations();
    start(server, clock, obs, {
      onRotatedFault: 'cb_rotated_throws_sync',
      persistent: true,
    });
    await jest.advanceTimersByTimeAsync(5 * 60_000);
    stopSessionKeeper();
    const gaps = new Set<number>();
    for (let i = 1; i < server.attempts.length; i++)
      gaps.add(server.attempts[i]!.t - server.attempts[i - 1]!.t);
    singleResults.push({
      fault: 'cb_rotated_throws_sync (persistent)',
      category: 'callback',
      expect: 'storm',
      finding: 'FI-3',
      verdict: 'BROKEN',
      violations: [
        `${server.attempts.length} rotations in 5 min, every ${[...gaps].join('/')} ms`,
      ],
      attempts: server.attempts.length,
      rotated: obs.rotated.length,
      deferred: obs.deferredCalls,
      revoked: obs.revokedCalls,
      firstRetryDelayMs: retryDelayMs(1),
      maxRequestsInAny60s: maxInAnyWindow(
        server.attempts.map(a => a.t),
        60_000,
      ),
      minRotationGapMs: minGap(obs.rotatedAt),
      startThrew: null,
      responsive: null,
      notes: [],
    });
    expect(obs.revokedCalls).toBe(0);
    expect(server.attempts.length).toBe(1 + 60); // t=0 then every 5 s
    expect([...gaps]).toEqual([retryDelayMs(1)]);
    expect(obs.deferredCalls).toBe(61);
    expect(server.continuityViolations).toEqual([]);
  });

  it('FI-4 an onRotated that never settles keeps `inflight` true forever: foreground, refreshSessionNow and timers are all no-ops', async () => {
    const result = await runSingleFault(byId('cb_rotated_hangs_forever'));
    singleResults.push(result);
    expect(result.rotated).toBe(1);
    expect(result.attempts).toBe(1);
    expect(result.responsive).toBe(false);
    expect(result.notes[0]).toMatch(/^STALL reproduced/);
  });

  /**
   * These three faults make a rejection ESCAPE the module (`void refresh()`
   * in sessionKeeper.ts rejects). Jest attributes that to the test as an
   * uncaught error and no in-test hook can intercept it (the sandboxed
   * `process` never sees `unhandledRejection`), so they cannot live in the
   * default run without failing it by construction. Run them on demand:
   *   STRESS_ESCAPES=1 npx jest --ci __tests__/stress/sessionKeeperFailureInjection.stress.test.ts -t ESCAPES
   * Each fails with the escaping error pointing at sessionKeeper.ts:131 /
   * :135 — that failure IS the evidence. When the module catches callback
   * errors, drop the gate and keep the assertions.
   */
  const escapes = process.env.STRESS_ESCAPES ? it : it.skip;

  escapes(
    'FI-4 ESCAPES cb_deferred_throws: an onDeferred that throws skips the retry schedule — the keeper goes silent (until a foreground/401 report) and the rejection leaves the module',
    async () => {
      const result = await runSingleFault(byId('cb_deferred_throws'));
      singleResults.push(result);
      expect(result.attempts).toBe(2); // the 503, then only the RESPONSIVE probe
      expect(result.deferred).toBe(1);
      expect(result.responsive).toBe(true);
      expect(result.notes[0]).toMatch(/^STALL reproduced/);
    },
  );

  escapes.each([['cb_revoked_throws_sync'], ['cb_revoked_rejects']])(
    'FI-4 ESCAPES %s: an onRevoked that throws leaves the module as an unhandled rejection (the revocation itself is complete)',
    async id => {
      const result = await runSingleFault(byId(id));
      singleResults.push(result);
      expect(result.revoked).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.violations).toEqual([]);
    },
  );

  it('FI-5 a server that reports expiresAt in milliseconds passes validation; the resulting delay exceeds 2^31-1 ms and Node/jest timers fire it at once — a refresh storm (RN JSTimers behaviour is NOT asserted here)', async () => {
    const result = await runStormProbe(byId('body_expires_ms_units'), 10_000);
    singleResults.push(result);
    expect(result.rotated).toBeGreaterThan(30);
    expect(result.maxRequestsInAny60s).toBeGreaterThan(30);
    expect(result.minRotationGapMs).toBeLessThan(MIN_ROTATION_GAP_MS);
  });

  it.each([['clock_nan'], ['clock_negative']])(
    'FI-7 %s: a non-finite / garbage `now` (test seam; production uses Date.now) is not guarded and storms',
    async id => {
      const result = await runStormProbe(byId(id), 10_000);
      singleResults.push(result);
      expect(result.maxRequestsInAny60s).toBeGreaterThan(30);
    },
  );

  it('FI-6 AppState.addEventListener throwing escapes startSessionKeeper before the first refresh: no keeper, no request, caller gets the exception', async () => {
    const result = await runSingleFault(byId('appstate_add_listener_throws'));
    singleResults.push(result);
    expect(result.startThrew).toBe('Error: AppState unavailable');
    expect(result.attempts).toBe(0);
  });

  it('FI-6 subscription.remove throwing poisons stopSessionKeeper mid-way: every later start/stop throws until the subscription behaves', async () => {
    const result = await runSingleFault(byId('appstate_remove_throws'));
    singleResults.push(result);
    // The scenario itself ran healthy …
    expect(result.rotated).toBeGreaterThanOrEqual(1);
    expect(result.notes).toContain(
      'stopSessionKeeper threw: Error: subscription gone',
    );
    // … but the keeper can no longer be stopped or restarted.
    expect(() => stopSessionKeeper()).toThrow('subscription gone');
    expect(() =>
      startSessionKeeper({
        apiBaseUrl: 'https://api.test',
        refreshToken: 'r',
        bearerExpiresAtMs: null,
        onRotated: () => {},
        onRevoked: () => {},
        fetchFn: async () => json(503, {}),
      }),
    ).toThrow('subscription gone');
    appStateRemoveThrows = false;
    stopSessionKeeper();
  });

  it('every known-broken fault is pinned above, exactly once', () => {
    expect(KNOWN_BROKEN.map(f => f.id).sort()).toEqual(
      [
        'fetch_hang_ignores_abort',
        'body_json_never_resolves',
        'body_expires_ms_units',
        'cb_rotated_throws_sync',
        'cb_rotated_rejects',
        'cb_rotated_hangs_forever',
        'cb_revoked_throws_sync',
        'cb_revoked_rejects',
        'cb_deferred_throws',
        'clock_nan',
        'clock_negative',
        'appstate_add_listener_throws',
        'appstate_remove_throws',
      ].sort(),
    );
  });
});

describe('sessionKeeper failure injection — seeded multi-fault campaign', () => {
  it('every seed recovers, never fakes success, never stalls, never storms, never revokes without a refusal', async () => {
    const only = process.env.STRESS_SEED
      ? Number(process.env.STRESS_SEED)
      : null;
    const seedCount =
      only !== null ? 1 : Number(process.env.STRESS_ITER ?? 300);
    const seeds =
      only !== null ? [only] : Array.from({ length: seedCount }, (_, i) => i);
    const wallStart = REAL_NOW();
    const heapBefore = process.memoryUsage();
    const results: SeedResult[] = [];
    for (const seed of seeds) {
      installAppStateSpy();
      results.push(await runScenario(buildScenario(seed)));
      stopSessionKeeper();
    }
    const heapAfter = process.memoryUsage();
    const failures = results.filter(r => r.verdict === 'BROKEN');
    const faultHistogram: Record<string, number> = {};
    for (const r of results) {
      for (const f of r.faults) {
        const fid = f.slice(f.indexOf(':') + 1);
        faultHistogram[fid] = (faultHistogram[fid] ?? 0) + 1;
      }
      if (r.callbackFault)
        faultHistogram[r.callbackFault] =
          (faultHistogram[r.callbackFault] ?? 0) + 1;
    }
    writeReport('campaign', {
      unit: 'mod-session-keeper',
      lens: 'failure-injection',
      node: process.version,
      seeds: results.length,
      held: results.length - failures.length,
      broken: failures.length,
      failingSeeds: failures.map(r => ({
        seed: r.seed,
        violations: r.violations,
        faults: r.faults,
        callbackFault: r.callbackFault,
      })),
      totals: {
        attempts: results.reduce((s, r) => s + r.attempts, 0),
        rotated: results.reduce((s, r) => s + r.rotated, 0),
        deferred: results.reduce((s, r) => s + r.deferred, 0),
        revoked: results.reduce((s, r) => s + r.revoked, 0),
        refusalsDelivered: results.reduce((s, r) => s + r.refusalsDelivered, 0),
        events: results.reduce((s, r) => s + r.events, 0),
        maxRequestsInAny60s: Math.max(
          ...results.map(r => r.maxRequestsInAny60s),
        ),
        minRotationGapMs: Math.min(
          ...results.map(r => r.minRotationGapMs ?? Infinity),
        ),
      },
      faultHistogram,
      excludedKnownBroken: KNOWN_BROKEN.map(f => f.id),
      heap: { before: heapBefore, after: heapAfter },
      wallMs: REAL_NOW() - wallStart,
      results,
    });
    expect(
      failures.map(r => ({ seed: r.seed, violations: r.violations })),
    ).toEqual([]);
  });
});

afterAll(() => {
  if (singleResults.length === 0) return;
  writeReport('single-faults', {
    unit: 'mod-session-keeper',
    lens: 'failure-injection',
    node: process.version,
    faults: ALL_FAULTS.length,
    held: singleResults.filter(r => r.verdict === 'HELD').length,
    broken: singleResults.filter(r => r.verdict === 'BROKEN').length,
    results: singleResults,
  });
});
