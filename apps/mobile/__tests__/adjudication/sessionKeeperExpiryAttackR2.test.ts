/**
 * MAS-1 r2 adversarial suite for `src/account/sessionKeeper.ts` (candidate
 * devin/close-mobile-auth-session-MAS-1-r2 @ 11d281e0, base f702f0f8).
 *
 * Doubles the scale of the original repros and attacks the classifier the
 * candidate introduced (`trustedLifeMs` / `rotationLeadMs` /
 * `pacedRotationDelayMs` / `clampDelayMs`): trust-boundary values, device
 * clock jumps in both directions mid-session, foreground and
 * `refreshSessionNow()` bursts, malformed and half-written payloads,
 * callback failures, cancellation, restarts, timer leaks and the real wall
 * clock. Every case drives the keeper through its public API only.
 *
 * Contract asserted throughout: no timer outside [1 s, MAX_DELAY_MS]; a
 * successful-but-unschedulable expiry never yields more than 3 exchanges in
 * any minute or more than 15 in any hour; a trusted expiry is rotated exactly
 * REFRESH_LEAD_MS (60 s) before it; an untrusted expiry is NEVER a sign-out.
 */
import { AppState } from 'react-native';
import {
  MAX_DELAY_MS,
  MAX_TRUSTED_LIFE_MS,
  MIN_ROTATION_GAP_MS,
  clampDelayMs,
  pacedRotationDelayMs,
  refreshSessionNow,
  rotationLeadMs,
  startSessionKeeper,
  stopSessionKeeper,
  trustedLifeMs,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';

const API_BASE_URL = 'https://api.example.test';
const T0 = new Date('2026-09-06T12:00:00Z').getTime();
const DAY_MS = 24 * 3600_000;
const HOUR_MS = 3600_000;
const HOUR_S = 3600;
const REFRESH_LEAD_MS = 60_000;
const MAX_SAFE_TIMEOUT_MS = 2 ** 31 - 1;
/** Paced schedule 30 s, 1, 2, 4 min then 5 min: 15 exchanges fit in the
 * first hour (0, 30 s, 90 s, 210 s, 450 s, then every 300 s), 12/h after. */
const MAX_PACED_PER_HOUR = 15;

type Answer =
  | { kind: 'session'; expiresAt: unknown }
  | { kind: 'body'; body: unknown; status?: number }
  | { kind: 'status'; status: number }
  | { kind: 'reject' }
  | { kind: 'hang' }
  | { kind: 'deferred'; response: Promise<Response> };

function sessionResponse(expiresAt: unknown, n: number): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      session: {
        accessToken: `access-${n}`,
        refreshToken: `refresh-${n}`,
        expiresAt,
      },
    }),
  } as unknown as Response;
}

function bodyResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface Harness {
  fetchFn: jest.Mock;
  onRotated: jest.Mock;
  onRevoked: jest.Mock;
  onDeferred: jest.Mock;
  requestedAtMs: number[];
  answer: (next: () => Answer) => void;
}

function keeper(
  answerFor: () => Answer,
  bearerExpiresAtMs: number | null = null,
  extra: Partial<SessionKeeperInput> = {},
): Harness {
  let calls = 0;
  let current = answerFor;
  const requestedAtMs: number[] = [];
  const fetchFn = jest.fn(async () => {
    calls += 1;
    requestedAtMs.push(Date.now());
    const a = current();
    if (a.kind === 'reject') throw new TypeError('Network request failed');
    if (a.kind === 'hang') return new Promise<Response>(() => {});
    if (a.kind === 'deferred') return a.response;
    if (a.kind === 'status') return bodyResponse({}, a.status);
    if (a.kind === 'body') return bodyResponse(a.body, a.status);
    return sessionResponse(a.expiresAt, calls);
  });
  const onRotated = jest.fn();
  const onRevoked = jest.fn();
  const onDeferred = jest.fn();
  startSessionKeeper({
    apiBaseUrl: API_BASE_URL,
    refreshToken: 'refresh-0',
    bearerExpiresAtMs,
    onRotated,
    onRevoked,
    onDeferred,
    fetchFn,
    ...extra,
  });
  return {
    fetchFn,
    onRotated,
    onRevoked,
    onDeferred,
    requestedAtMs,
    answer: next => {
      current = next;
    },
  };
}

const serverSeconds = (lifeS: number) => (): Answer => ({
  kind: 'session',
  expiresAt: Math.floor(Date.now() / 1000) + lifeS,
});

/** A server whose clock is `skewMs` ahead of the device's. */
const skewedServerSeconds = (lifeS: number, skewMs: number) => (): Answer => ({
  kind: 'session',
  expiresAt: Math.floor((Date.now() + skewMs) / 1000) + lifeS,
});

function captureForeground(): () => void {
  let handler: ((state: string) => void) | null = null;
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, listener) => {
      handler = listener as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  return () => handler?.('active');
}

function timerDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => Number(call[1] ?? 0))
    .filter(delay => Number.isFinite(delay));
}

function maxInAnyWindow(times: number[], windowMs: number): number {
  let best = 0;
  for (let i = 0, j = 0; i < times.length; i++) {
    while ((times[j] ?? Infinity) < (times[i] ?? 0) - windowMs) j += 1;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] ?? 0));
}

function useClock() {
  jest.useFakeTimers();
  jest.setSystemTime(T0);
}

afterEach(() => {
  stopSessionKeeper();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('classifier boundaries (pure helpers)', () => {
  it('clampDelayMs: every input lands in [1 s, MAX_DELAY_MS] ⊂ 32-bit range', () => {
    for (const d of [
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1,
      999,
      1_000,
      1_001,
      MAX_DELAY_MS - 1,
      MAX_DELAY_MS,
      MAX_DELAY_MS + 1,
      MAX_SAFE_TIMEOUT_MS,
      MAX_SAFE_TIMEOUT_MS + 1,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_VALUE,
      Number.POSITIVE_INFINITY,
    ]) {
      const c = clampDelayMs(d);
      expect(c).toBeGreaterThanOrEqual(1_000);
      expect(c).toBeLessThanOrEqual(MAX_DELAY_MS);
      expect(c).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
    }
    // NaN would defeat Math.min/Math.max — the keeper never feeds one (every
    // caller goes through rotationLeadMs / pacedRotationDelayMs /
    // retryDelayMs), but pin what happens so a future caller cannot rely on
    // it silently.
    expect(Number.isNaN(clampDelayMs(Number.NaN))).toBe(true);
  });

  it('trustedLifeMs: exactly MAX_TRUSTED_LIFE_MS is trusted, one ms more is not; the far past is trusted (due), non-finite never is', () => {
    expect(trustedLifeMs(T0 + MAX_TRUSTED_LIFE_MS, T0)).toBe(
      MAX_TRUSTED_LIFE_MS,
    );
    expect(trustedLifeMs(T0 + MAX_TRUSTED_LIFE_MS + 1, T0)).toBeNull();
    expect(trustedLifeMs(0, T0)).toBe(-T0);
    expect(trustedLifeMs(-1e15, T0)).toBe(-1e15 - T0);
    expect(trustedLifeMs(Number.NaN, T0)).toBeNull();
    expect(trustedLifeMs(Number.POSITIVE_INFINITY, T0)).toBeNull();
    expect(trustedLifeMs(Number.NEGATIVE_INFINITY, T0)).toBeNull();
    expect(trustedLifeMs(null, T0)).toBeNull();
  });

  it('rotationLeadMs: lead is strictly positive or null; the 60 s boundary is exclusive', () => {
    expect(rotationLeadMs(T0 + REFRESH_LEAD_MS, T0)).toBeNull();
    expect(rotationLeadMs(T0 + REFRESH_LEAD_MS + 1, T0)).toBe(1);
    expect(rotationLeadMs(T0 + MAX_TRUSTED_LIFE_MS, T0)).toBe(
      MAX_TRUSTED_LIFE_MS - REFRESH_LEAD_MS,
    );
    expect(rotationLeadMs(T0 + MAX_TRUSTED_LIFE_MS + 1, T0)).toBeNull();
    expect(rotationLeadMs(T0 - 1, T0)).toBeNull();
  });

  it('pacedRotationDelayMs: monotone, starts at MIN_ROTATION_GAP_MS, saturates at 5 min, survives absurd streaks', () => {
    expect(pacedRotationDelayMs(0)).toBe(MIN_ROTATION_GAP_MS);
    expect(pacedRotationDelayMs(1)).toBe(MIN_ROTATION_GAP_MS);
    expect(pacedRotationDelayMs(2)).toBe(60_000);
    expect(pacedRotationDelayMs(3)).toBe(120_000);
    expect(pacedRotationDelayMs(4)).toBe(240_000);
    expect(pacedRotationDelayMs(5)).toBe(300_000);
    for (const s of [6, 64, 1_024, 1_100, 1e6, Number.MAX_SAFE_INTEGER]) {
      expect(pacedRotationDelayMs(s)).toBe(300_000);
    }
    let prev = 0;
    for (let s = 1; s <= 40; s++) {
      const d = pacedRotationDelayMs(s);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
  });
});

describe('trust boundary through the keeper', () => {
  it('a bearer at exactly MAX_TRUSTED_LIFE_MS at start arms MAX_DELAY_MS; one ms past it is exchanged at launch instead — both bounded, neither revoked', async () => {
    useClock();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const exact = keeper(serverSeconds(HOUR_S), T0 + MAX_TRUSTED_LIFE_MS);
    await jest.advanceTimersByTimeAsync(0);
    expect(exact.fetchFn).not.toHaveBeenCalled();
    expect(timerDelays(spy)).toEqual([MAX_DELAY_MS]);
    stopSessionKeeper();

    spy.mockClear();
    const over = keeper(serverSeconds(HOUR_S), T0 + MAX_TRUSTED_LIFE_MS + 1);
    await jest.advanceTimersByTimeAsync(0);
    expect(over.fetchFn).toHaveBeenCalledTimes(1);
    // The trusted 1 h answer then arms the 59 min rotation.
    expect(timerDelays(spy).filter(d => d !== 15_000)).toEqual([
      HOUR_MS - REFRESH_LEAD_MS,
    ]);
    expect(exact.onRevoked).not.toHaveBeenCalled();
    expect(over.onRevoked).not.toHaveBeenCalled();
  });

  it('server answers exactly now+60 s (lead == 0) → paced 30 s; now+61 s (lead == 1 ms) → still floored at 30 s after a rotation, 1 s at launch', async () => {
    useClock();
    const atLead = keeper(serverSeconds(60));
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(gaps(atLead.requestedAtMs)).toEqual([
      30_000, 60_000, 120_000, 240_000,
    ]);
    expect(atLead.onRevoked).not.toHaveBeenCalled();
    stopSessionKeeper();

    const justPast = keeper(serverSeconds(61));
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    // Trusted with a 1 s lead: every rotation re-arms at the 30 s floor.
    for (const g of gaps(justPast.requestedAtMs)) expect(g).toBe(30_000);
    expect(justPast.requestedAtMs.length).toBe(21);
    expect(justPast.onRevoked).not.toHaveBeenCalled();
    stopSessionKeeper();

    const spy = jest.spyOn(globalThis, 'setTimeout');
    const launch = keeper(serverSeconds(HOUR_S), Date.now() + 61_000);
    expect(timerDelays(spy)).toEqual([1_000]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(launch.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a 7 d Supabase-cap bearer is re-checked daily, never parked, never stormed: ≤ 8 exchanges across 7 days', async () => {
    useClock();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const h = keeper(serverSeconds(7 * 24 * HOUR_S));
    await jest.advanceTimersByTimeAsync(7 * DAY_MS);
    expect(h.fetchFn.mock.calls.length).toBeLessThanOrEqual(8);
    expect(h.fetchFn.mock.calls.length).toBeGreaterThanOrEqual(7);
    for (const g of gaps(h.requestedAtMs)) expect(g).toBe(MAX_DELAY_MS);
    expect(Math.max(...timerDelays(spy))).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });
});

describe('device clock jumps mid-session (Date.now moves, timers stay monotonic)', () => {
  it('clock set FORWARD one year while a trusted 1 h rotation is pending: the rotation still fires at 59 min; the stale-looking answers are paced ≤ 15/h; the clock coming back restores the 60 s-before schedule', async () => {
    useClock();
    const h = keeper(serverSeconds(HOUR_S), T0 + HOUR_MS);
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    // Server clock is now a year behind the device: every answer is "past".
    const YEAR_MS = 365 * DAY_MS;
    jest.setSystemTime(Date.now() + YEAR_MS);
    h.answer(skewedServerSeconds(HOUR_S, -YEAR_MS));

    await jest.advanceTimersByTimeAsync(29 * 60_000 - 1);
    expect(h.fetchFn).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);

    const before = h.requestedAtMs.length;
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    const inHour = h.requestedAtMs.length - before;
    expect(inHour).toBeLessThanOrEqual(MAX_PACED_PER_HOUR);
    expect(inHour).toBeGreaterThanOrEqual(1);
    expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);

    // NTP corrects the device: the next answer is trusted again and the
    // rotation after it lands exactly 60 s before that answer's expiry.
    jest.setSystemTime(Date.now() - YEAR_MS);
    h.answer(serverSeconds(HOUR_S));
    await jest.advanceTimersByTimeAsync(pacedRotationDelayMs(99));
    const n = h.requestedAtMs.length;
    const trustedAt = h.requestedAtMs[n - 1] ?? Number.NaN;
    const due = trustedAt + HOUR_MS - REFRESH_LEAD_MS;
    await jest.advanceTimersByTimeAsync(due - Date.now() - 1);
    expect(h.requestedAtMs.length).toBe(n);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.requestedAtMs.length).toBe(n + 1);
    expect(h.requestedAtMs[n]).toBe(due);
    expect(h.onRevoked).not.toHaveBeenCalled();
    expect(h.onRotated).toHaveBeenCalledTimes(h.fetchFn.mock.calls.length);
  });

  it('clock set BACK 30 days (beyond MAX_TRUSTED_LIFE_MS): healthy 1 h answers become untrusted; the keeper paces at ≤ 15/h and never parks the bearer for the length of the jump', async () => {
    useClock();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const h = keeper(serverSeconds(HOUR_S));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1);
    const JUMP = 30 * DAY_MS;
    jest.setSystemTime(Date.now() - JUMP);
    h.answer(skewedServerSeconds(HOUR_S, JUMP));

    // The pending 59 min rotation fires; from then on answers are untrusted.
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    const start = h.requestedAtMs.length;
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    const inHour = h.requestedAtMs.length - start;
    expect(inHour).toBeGreaterThanOrEqual(1);
    expect(inHour).toBeLessThanOrEqual(MAX_PACED_PER_HOUR);
    expect(Math.max(...timerDelays(spy))).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('device clock stuck in 1970 (never synced): every answer looks 56 years out; launch exchanges once, then ≤ 15/h, no over-range delay, no sign-out', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
    const spy = jest.spyOn(globalThis, 'setTimeout');
    // The server's real clock is T0.
    const h = keeper(skewedServerSeconds(HOUR_S, T0));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(h.fetchFn.mock.calls.length).toBeLessThanOrEqual(
      1 + MAX_PACED_PER_HOUR,
    );
    expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);
    expect(Math.max(...timerDelays(spy))).toBeLessThanOrEqual(
      MAX_SAFE_TIMEOUT_MS,
    );
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('device clock 3 days behind the server (inside the trust band): the 1 h bearer is over-trusted and armed at ~3 d → clamped to a daily re-check; a route 401 → refreshSessionNow() still rotates immediately', async () => {
    useClock();
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const h = keeper(skewedServerSeconds(HOUR_S, 3 * DAY_MS));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1);
    expect(timerDelays(spy).filter(d => d !== 15_000)).toEqual([MAX_DELAY_MS]);
    // The server rejected the (really expired) bearer 2 h later.
    await jest.advanceTimersByTimeAsync(2 * HOUR_MS);
    expect(h.requestedAtMs).toHaveLength(1);
    refreshSessionNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(2);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });
});

describe('bursts that bypass the timer', () => {
  it('50 foreground events in 10 s with a TRUSTED 1 h bearer cost zero exchanges', async () => {
    useClock();
    const fg = captureForeground();
    const h = keeper(serverSeconds(HOUR_S), T0 + HOUR_MS);
    for (let i = 0; i < 50; i++) {
      fg();
      await jest.advanceTimersByTimeAsync(200);
    }
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it('50 foreground events in 10 s with a PAST expiry: same exchange count as f702f0f8 (one per foreground, serialized by the in-flight guard), never revoked', async () => {
    useClock();
    const fg = captureForeground();
    const h = keeper(serverSeconds(-5));
    await jest.advanceTimersByTimeAsync(0);
    const launch = h.requestedAtMs.length;
    for (let i = 0; i < 50; i++) {
      fg();
      fg(); // a second 'active' in the same tick is dropped by `inflight`
      await jest.advanceTimersByTimeAsync(200);
    }
    // Foreground is user-paced, not timer-paced: exactly one exchange per
    // distinct foreground (the duplicate in the same tick never doubles it).
    expect(h.fetchFn.mock.calls.length - launch).toBe(50);
    expect(h.onRotated).toHaveBeenCalledTimes(h.fetchFn.mock.calls.length);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('refreshSessionNow() called 100× in one tick performs exactly one exchange; called after each answer it is one exchange per call — never a sign-out, timer count never grows', async () => {
    useClock();
    const h = keeper(serverSeconds(-5));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(1);
    let release: (value: Response) => void = () => {};
    const response = new Promise<Response>(resolve => {
      release = resolve;
    });
    h.answer(() => ({ kind: 'deferred', response }));
    for (let i = 0; i < 100; i++) refreshSessionNow();
    await jest.advanceTimersByTimeAsync(0);
    expect(h.requestedAtMs).toHaveLength(2);
    release(sessionResponse(Date.now() / 1000 - 5, 99));
    await jest.advanceTimersByTimeAsync(0);
    expect(h.onRotated).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(1); // the keeper's one paced timer
    h.answer(serverSeconds(-5));
    for (let i = 0; i < 20; i++) {
      refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
    }
    expect(h.requestedAtMs).toHaveLength(22);
    expect(jest.getTimerCount()).toBe(1);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });
});

describe('payload variants (the classifier must never sign out and never storm)', () => {
  it.each<[string, () => number]>([
    ['epoch milliseconds', () => Date.now()],
    ['epoch microseconds', () => Date.now() * 1000],
    ['epoch nanoseconds (float)', () => Date.now() * 1e6],
    ['1e308 (finite but astronomically large)', () => 1e308],
    ['-1e308', () => -1e308],
    ['negative seconds', () => -1],
    ['zero', () => 0],
    ['Number.MAX_SAFE_INTEGER', () => Number.MAX_SAFE_INTEGER],
    ['Number.MIN_VALUE', () => Number.MIN_VALUE],
    ['fractional seconds in the past', () => Date.now() / 1000 - 0.5],
    ['fractional seconds at the lead', () => Date.now() / 1000 + 59.999],
    [
      'now+8 d (server clock 1 s behind → life 8 d − 1 s)',
      () => Math.floor(Date.now() / 1000) + 8 * 24 * 3600 - 1,
    ],
    [
      'now+8 d + 1 s (past the trust band)',
      () => Math.floor(Date.now() / 1000) + 8 * 24 * 3600 + 1,
    ],
    ['now+400 d', () => Math.floor((Date.now() + 400 * DAY_MS) / 1000)],
    ['now+100 y', () => Math.floor((Date.now() + 36_500 * DAY_MS) / 1000)],
  ])(
    'a SUCCESSFUL refresh whose expiresAt is %s: 2 h simulated ⇒ ≤ 3/min, ≤ 16 in any hour, no over-range delay, no sign-out',
    async (_label, valueFor) => {
      useClock();
      const spy = jest.spyOn(globalThis, 'setTimeout');
      const h = keeper(() => ({ kind: 'session', expiresAt: valueFor() }));
      await jest.advanceTimersByTimeAsync(2 * HOUR_MS);
      const delays = timerDelays(spy);
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
      expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_DELAY_MS);
      expect(Math.min(...delays)).toBeGreaterThanOrEqual(1_000);
      expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);
      expect(maxInAnyWindow(h.requestedAtMs, HOUR_MS)).toBeLessThanOrEqual(
        1 + MAX_PACED_PER_HOUR,
      );
      expect(h.onRotated).toHaveBeenCalledTimes(h.fetchFn.mock.calls.length);
      expect(h.onRevoked).not.toHaveBeenCalled();
      expect(h.fetchFn.mock.calls.length).toBeGreaterThanOrEqual(1);
    },
  );

  it.each<[string, Answer]>([
    [
      'expiresAt as a numeric string',
      { kind: 'session', expiresAt: '1788500670' },
    ],
    ['expiresAt null', { kind: 'session', expiresAt: null }],
    ['expiresAt missing', { kind: 'session', expiresAt: undefined }],
    ['expiresAt NaN', { kind: 'session', expiresAt: Number.NaN }],
    [
      'expiresAt Infinity',
      { kind: 'session', expiresAt: Number.POSITIVE_INFINITY },
    ],
    ['expiresAt an object', { kind: 'session', expiresAt: { seconds: 1 } }],
    [
      'expiresAt a unicode string',
      { kind: 'session', expiresAt: '١٧٨٨٥٠٠٦٧٠' },
    ],
    [
      'session missing (old server)',
      { kind: 'body', body: { user: { id: 'u' } } },
    ],
    ['body null', { kind: 'body', body: null }],
    [
      'empty tokens',
      {
        kind: 'body',
        body: {
          session: { accessToken: ' ', refreshToken: ' ', expiresAt: 1 },
        },
      },
    ],
    ['404 (old server has no refresh route)', { kind: 'status', status: 404 }],
    ['429', { kind: 'status', status: 429 }],
    ['500', { kind: 'status', status: 500 }],
    ['network reject', { kind: 'reject' }],
  ])(
    'an UNUSABLE refresh answer (%s) is retried on the 5 s → 5 min backoff, ≤ 18 in the first hour, no rotation, no sign-out',
    async (_label, answer) => {
      useClock();
      const spy = jest.spyOn(globalThis, 'setTimeout');
      const h = keeper(() => answer);
      await jest.advanceTimersByTimeAsync(HOUR_MS);
      expect(h.onRotated).not.toHaveBeenCalled();
      expect(h.onRevoked).not.toHaveBeenCalled();
      expect(h.onDeferred).toHaveBeenCalledTimes(h.fetchFn.mock.calls.length);
      // 0,5,15,35,75,155,315 s then every 300 s: 17 attempts fit in an hour.
      expect(h.fetchFn.mock.calls.length).toBeLessThanOrEqual(18);
      expect(h.fetchFn.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(Math.max(...timerDelays(spy))).toBeLessThanOrEqual(MAX_DELAY_MS);
    },
  );

  it('401 and 403 stay the ONE sign-out even after a run of untrusted expiries; nothing fires afterwards', async () => {
    for (const status of [401, 403]) {
      useClock();
      let n = 0;
      const h = keeper(() => {
        n += 1;
        return n <= 4
          ? { kind: 'session', expiresAt: Date.now() }
          : { kind: 'status', status };
      });
      await jest.advanceTimersByTimeAsync(HOUR_MS);
      expect(h.onRevoked).toHaveBeenCalledTimes(1);
      expect(h.fetchFn).toHaveBeenCalledTimes(5);
      expect(h.onRotated).toHaveBeenCalledTimes(4);
      expect(jest.getTimerCount()).toBe(0);
      stopSessionKeeper();
      jest.useRealTimers();
    }
  });
});

describe('callback and lifecycle faults', () => {
  it('onRotated throws on an untrusted-expiry rotation: the failure is a transient retry (5 s), never a sign-out, and pacing resumes once onRotated heals', async () => {
    useClock();
    let fail = true;
    const h = keeper(() => ({ kind: 'session', expiresAt: Date.now() }), null, {
      onRotated: jest.fn(() => {
        if (fail) throw new Error('Keychain busy');
      }),
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(h.onDeferred).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    fail = false;
    await jest.advanceTimersByTimeAsync(10_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    // Each throw is retried 5 s later (failedAttempts is reset by the
    // successful exchange BEFORE onRotated runs — identical on f702f0f8, so a
    // persistently failing onRotated is a 0.2 Hz loop on both); from the
    // first healthy rotation on, the paced schedule applies.
    expect(gaps(h.requestedAtMs).slice(0, 2)).toEqual([5_000, 5_000]);
    expect(
      maxInAnyWindow(h.requestedAtMs.slice(2), 60_000),
    ).toBeLessThanOrEqual(3);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('onRotated is slow (10 s Keychain write) with an untrusted expiry: the paced timer is armed AFTER the write; no overlapping exchange', async () => {
    useClock();
    const h = keeper(() => ({ kind: 'session', expiresAt: Date.now() }), null, {
      onRotated: jest.fn(
        () =>
          new Promise<void>(resolve => {
            setTimeout(resolve, 10_000);
          }),
      ),
    });
    await jest.advanceTimersByTimeAsync(0);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    // 10 s write + 30 s paced gap → next exchange at 40 s.
    await jest.advanceTimersByTimeAsync(30_000);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    expect(h.onRevoked).not.toHaveBeenCalled();
  });

  it('stopSessionKeeper() from inside onRotated (sign-out during a rotation with an untrusted expiry) leaves no timer and no further exchange', async () => {
    useClock();
    const h = keeper(() => ({ kind: 'session', expiresAt: Date.now() }), null, {
      onRotated: jest.fn(() => stopSessionKeeper()),
    });
    await jest.advanceTimersByTimeAsync(HOUR_MS);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('restart from inside onRotated (account switch) with a past expiry: only the new keeper schedules; ≤ 2 exchanges in the first 30 s', async () => {
    useClock();
    const second = { fetchFn: null as jest.Mock | null };
    const first = keeper(serverSeconds(-5), null, {
      onRotated: jest.fn(() => {
        if (second.fetchFn) return;
        const h = keeper(serverSeconds(-5));
        second.fetchFn = h.fetchFn;
      }),
    });
    await jest.advanceTimersByTimeAsync(29_999);
    expect(first.fetchFn).toHaveBeenCalledTimes(1);
    expect(second.fetchFn).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(second.fetchFn).toHaveBeenCalledTimes(2);
    expect(first.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('timer hygiene: across 6 h of untrusted answers, foregrounds and forced refreshes there is never more than one keeper timer', async () => {
    useClock();
    const fg = captureForeground();
    const h = keeper(() => ({ kind: 'session', expiresAt: Date.now() }));
    for (let i = 0; i < 72; i++) {
      await jest.advanceTimersByTimeAsync(5 * 60_000);
      if (i % 3 === 0) fg();
      if (i % 5 === 0) refreshSessionNow();
      await jest.advanceTimersByTimeAsync(0);
      expect(jest.getTimerCount()).toBeLessThanOrEqual(1);
    }
    expect(h.onRevoked).not.toHaveBeenCalled();
    expect(maxInAnyWindow(h.requestedAtMs, 60_000)).toBeLessThanOrEqual(3);
    stopSessionKeeper();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('REAL wall clock', () => {
  it('200 ms each of ms / µs / far-future / past / 1970-device answers: ≤ 2 exchanges per keeper, every delay inside the 32-bit range (Node only warns past it)', async () => {
    const spy = jest.spyOn(globalThis, 'setTimeout');
    const answers: Array<() => Answer> = [
      () => ({ kind: 'session', expiresAt: Date.now() }),
      () => ({ kind: 'session', expiresAt: Date.now() * 1000 }),
      () => ({
        kind: 'session',
        expiresAt: Math.floor((Date.now() + 400 * DAY_MS) / 1000),
      }),
      serverSeconds(-3600),
      skewedServerSeconds(HOUR_S, Date.now()),
    ];
    const counts: number[] = [];
    for (const a of answers) {
      const h = keeper(a);
      await new Promise<void>(resolve => {
        setTimeout(resolve, 200);
      });
      stopSessionKeeper();
      counts.push(h.fetchFn.mock.calls.length);
      expect(h.onRevoked).not.toHaveBeenCalled();
    }
    const delays = timerDelays(spy);
    spy.mockRestore();
    for (const c of counts) expect(c).toBeLessThanOrEqual(2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
  });
});
