/**
 * W05-02 ADVERSARY (round 3, candidate c735b23d) — attacks at the failure
 * boundaries of `src/data/trustedTime.ts`.
 *
 * Each `describe` is one attack. A failing `expect` is a confirmed break; a
 * passing one records that the boundary held. Nothing here modifies the
 * candidate's production code or its own suite.
 *
 * The harness mirrors the shipping configuration: the process monotonic
 * clock (`performance.now()`) is frozen while the device sleeps and the
 * singleton has NO sleep-inclusive clock (`createTrustedTime()` with no
 * `continuousNowMs`), so `continuousMs` is only supplied where an attack
 * contrasts the two configurations.
 */

import { type AppStateStatus } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';
import { api } from '../src/data/api';
import {
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  createTrustedTime,
  evaluateLease,
  trustedTime,
  type TrustedTimeKeychain,
  type TrustedTimeLifecycle,
  type TrustedTimeReading,
} from '../src/data/trustedTime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE_MAX_MS = OFFLINE_PRO_LEASE_MAX_SECONDS * 1000;
const TOL = TRUSTED_TIME_ROLLBACK_TOLERANCE_MS;
/** Server time on the authenticated response that issued the lease. */
const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const lease = { issuedAtMs: T0, expiresAtMs: T0 + LEASE_MAX_MS };
/** A lease that has provably expired once six days have passed. */
const fiveDayLease = { issuedAtMs: T0, expiresAtMs: T0 + 5 * DAY };

function header(ms: number): string {
  return new Date(ms).toUTCString();
}

interface Clocks {
  monotonicMs: number;
  wallMs: number;
  continuousMs?: number | null;
}

function fakeLifecycle(initialState: AppStateStatus = 'active') {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const lifecycle: TrustedTimeLifecycle = {
    currentState: initialState,
    addEventListener(_type, listener) {
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return {
    lifecycle,
    async transition(state: AppStateStatus): Promise<void> {
      (lifecycle as { currentState: AppStateStatus }).currentState = state;
      for (const listener of [...listeners]) listener(state);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  };
}

function harness(
  clocks: Clocks,
  lifecycle: TrustedTimeLifecycle | null = fakeLifecycle().lifecycle,
  keychain: TrustedTimeKeychain = Keychain,
) {
  return createTrustedTime({
    keychain,
    monotonicNowMs: () => clocks.monotonicMs,
    wallClockNowMs: () => clocks.wallMs,
    ...(clocks.continuousMs === undefined
      ? {}
      : { continuousNowMs: () => clocks.continuousMs ?? null }),
    lifecycle,
  });
}

function storedRecord(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no trusted-time record persisted');
  return JSON.parse(item.password) as Record<string, unknown>;
}

function seedRecord(record: unknown): void {
  __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
    username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
    password: typeof record === 'string' ? record : JSON.stringify(record),
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

function validRecord(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
    serverEpochMs: T0,
    highWaterMs: T0 + 6 * DAY,
    wallOffsetMs: 0,
    ...over,
  };
}

/** Advance both awake clocks together (the device is awake and honest). */
function tick(clocks: Clocks, ms: number): void {
  clocks.monotonicMs += ms;
  clocks.wallMs += ms;
  if (typeof clocks.continuousMs === 'number') clocks.continuousMs += ms;
}

/** The device sleeps: the process clock freezes, real time passes. */
function sleep(clocks: Clocks, ms: number): void {
  clocks.wallMs += ms;
  if (typeof clocks.continuousMs === 'number') clocks.continuousMs += ms;
}

beforeEach(() => {
  __keychainStore.clear();
});

// ---------------------------------------------------------------------------
// ATTACK 1 — an authenticated response that was in flight when the app was
// suspended is delivered after the device slept for days. The module has no
// notion of when the REQUEST was sent, so it re-anchors "measured" on a Date
// header that is days stale and moves trusted time backwards.
// ---------------------------------------------------------------------------
describe('ATTACK 1 — stale in-flight response delivered after suspension', () => {
  it('1a. honest wall clock: a delayed response rewinds trusted time by 6 days and revives the lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });

    // One minute of honest foreground use; the lease is active.
    tick(clocks, MINUTE);
    expect(evaluateLease(lease, await time.read()).kind).toBe('active');

    // The user fires a request and immediately locks the phone. The response
    // (Date = T0 + 1m + 2s) reaches the device after the process is suspended.
    const inFlightDate = header(T0 + MINUTE + 2 * SECOND);
    await app.transition('inactive');
    await app.transition('background');

    // Six real days pass; the process clock is frozen. No tampering at all.
    sleep(clocks, 6 * DAY);
    await app.transition('active');

    // The foreground checkpoint sees the honest wall clock: trusted now is
    // at least T0 + 6d and the Keychain high-water mark records it.
    const beforeDelivery = await time.read();
    expect(beforeDelivery.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(lease, beforeDelivery).kind).not.toBe('active');
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    const highWaterBefore = storedRecord().highWaterMs as number;

    // Now the suspended response is processed exactly as api.ts would do it.
    const observation = await time.observeServerTime({
      dateHeader: inFlightDate,
      authenticated: true,
    });
    tick(clocks, SECOND);
    const after = await time.read();

    // Within one process, trusted time must never move backwards, the
    // persisted high-water mark must never regress, and a lease that was
    // provably 6 days old must not become active again.
    expect(observation.accepted).toBe(true);
    expect(after.nowMs).toBeGreaterThanOrEqual(beforeDelivery.nowMs);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(highWaterBefore);
    expect(evaluateLease(lease, after).kind).not.toBe('active');
  });

  it('1b. clock wound back while suspended: the delayed response makes the rollback invisible and the 7-day lease active', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, MINUTE);

    const inFlightDate = header(T0 + MINUTE + 2 * SECOND);
    await app.transition('inactive');
    await app.transition('background');
    sleep(clocks, 6 * DAY);
    // Attacker winds the wall clock back to where it was before sleeping.
    clocks.wallMs = T0 + MINUTE;
    await app.transition('active');

    // Without the stale response the candidate correctly refuses to
    // authorise the lease (elapsed time cannot be measured).
    expect(evaluateLease(lease, await time.read())).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });

    await time.observeServerTime({
      dateHeader: inFlightDate,
      authenticated: true,
    });
    tick(clocks, SECOND);
    const after = await time.read();

    // Six days elapsed and the clock was wound back: the lease must not be
    // reported active with ~7 days remaining.
    expect(evaluateLease(lease, after).kind).not.toBe('active');
  });

  it('1c. control — with a sleep-inclusive clock the same delayed response cannot rewind trusted time', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0, continuousMs: 0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, MINUTE);
    const inFlightDate = header(T0 + MINUTE + 2 * SECOND);
    await app.transition('background');
    sleep(clocks, 6 * DAY);
    clocks.wallMs = T0 + MINUTE;
    await app.transition('active');
    await time.observeServerTime({
      dateHeader: inFlightDate,
      authenticated: true,
    });
    tick(clocks, SECOND);
    const after = await time.read();
    expect(after.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(fiveDayLease, after).kind).toBe('expired');
  });

  it('1d. relaunch: a stale authenticated Date below the persisted high-water mark discards the floor and revives the lease', async () => {
    // A previous run proved (via foreground checkpoints) that now >= T0 + 6d.
    seedRecord(validRecord({ serverEpochMs: T0, highWaterMs: T0 + 6 * DAY }));
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + 6 * DAY };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);

    const floor = await time.read();
    expect(floor.authority).toBe('floor');
    expect(evaluateLease(fiveDayLease, floor).kind).toBe('expired');

    // A replayed / delayed authenticated response from day 0 arrives.
    await time.observeServerTime({
      dateHeader: header(T0 + MINUTE),
      authenticated: true,
    });
    tick(clocks, SECOND);
    const after = await time.read();
    // A high-water mark is a lower bound on now; no later observation may
    // move trusted time below it.
    expect(after.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(fiveDayLease, after).kind).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 2 — the shipping configuration has no sleep-inclusive clock: does an
// honest device that merely backgrounds the app for one minute keep its
// offline lease? (product boundary of the fail-closed design)
// ---------------------------------------------------------------------------
describe('ATTACK 2 — honest one-minute background in the shipping configuration', () => {
  it('2a. one honest minute in the background voids the offline lease until the device is online again', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, MINUTE);
    expect(evaluateLease(lease, await time.read()).kind).toBe('active');

    await app.transition('background');
    tick(clocks, MINUTE); // awake the whole time: mono and wall agree
    await app.transition('active');
    const reading = await time.read();

    expect(reading.wallClockMs - reading.nowMs).toBeLessThanOrEqual(TOL);
    expect(reading.rollbackDetected).toBe(false);
    // Product expectation: an honest device, awake the whole time, with
    // wall and monotonic clocks in agreement, keeps its Pro lease offline.
    expect(evaluateLease(lease, reading).kind).toBe('active');
  });

  it('2b. an "inactive" interruption (notification shade, control centre) keeps the lease active', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, MINUTE);
    await app.transition('inactive');
    tick(clocks, MINUTE);
    await app.transition('active');
    expect(evaluateLease(lease, await time.read())).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 2 * MINUTE,
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 3 — a hung Keychain: every authenticated response enqueues a persist
// that waits the full timeout, and reads are serialised behind them.
// ---------------------------------------------------------------------------
describe('ATTACK 3 — hung Keychain turns the read path into a queue of timeouts', () => {
  const hung: TrustedTimeKeychain = {
    ACCESSIBLE: Keychain.ACCESSIBLE,
    getGenericPassword: () => new Promise(() => undefined),
    setGenericPassword: () => new Promise(() => undefined),
  };

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Fake-time milliseconds until `promise` settles (up to `limitMs`). */
  async function settleTime(
    promise: Promise<unknown>,
    limitMs: number,
  ): Promise<number> {
    let settled = false;
    void promise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let elapsed = 0;
    const step = 100;
    while (!settled && elapsed < limitMs) {
      await jest.advanceTimersByTimeAsync(step);
      elapsed += step;
    }
    return settled ? elapsed : Number.POSITIVE_INFINITY;
  }

  it('3a. ten authenticated responses in a burst delay the next read by ten Keychain timeouts', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks, fakeLifecycle().lifecycle, hung);

    // Hydration itself hangs once (bounded by the module) — let it time out.
    const first = time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    await jest.advanceTimersByTimeAsync(2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS);
    await first;

    for (let i = 1; i <= 10; i += 1) {
      void time.observeServerTime({
        dateHeader: header(T0 + i * SECOND),
        authenticated: true,
      });
    }
    // A read queued behind them should settle within ONE bounded timeout;
    // it must not inherit every queued persist's timeout.
    const waited = await settleTime(
      time.read(),
      12 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
    );
    expect(waited).toBeLessThanOrEqual(TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS + 100);
  });

  it('3b. the checkpoint on every foreground and every checkpoint interval blocks reads for a full timeout', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle('active');
    const time = harness(clocks, app.lifecycle, hung);
    const first = time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    await jest.advanceTimersByTimeAsync(2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS);
    await first;

    tick(clocks, TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + SECOND);
    // A plain read after the checkpoint interval persists (hangs) first,
    // although the store already failed to answer twice in this process.
    const waited = await settleTime(
      time.read(),
      2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
    );
    expect(waited).toBeLessThanOrEqual(200);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 4 — in-process stale / out-of-order responses while the app stays in
// the foreground (the module's own high-water mark must hold them).
// ---------------------------------------------------------------------------
describe('ATTACK 4 — out-of-order responses in the foreground', () => {
  it('4a. a response one hour stale cannot lower the anchored estimate', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, HOUR);
    const before = await time.read();
    expect(before.nowMs).toBe(T0 + HOUR);

    await time.observeServerTime({
      dateHeader: header(T0 + MINUTE),
      authenticated: true,
    });
    const after = await time.read();
    expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs);
    expect(after.authority).toBe('anchored');
    expect(evaluateLease(lease, after)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - HOUR,
    });
  });

  it('4b. interleaved responses: the slowest (oldest) one settling last does not win', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const dates = [T0 + 5 * DAY, T0 + 2 * DAY, T0 + 6 * DAY, T0 + DAY];
    await Promise.all(
      dates.map(d =>
        time.observeServerTime({ dateHeader: header(d), authenticated: true }),
      ),
    );
    const reading = await time.read();
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 5 — rollback tolerance boundary and forward-jump laundering.
// ---------------------------------------------------------------------------
describe('ATTACK 5 — tolerance boundary and forward/backward laundering', () => {
  it.each([TOL - 1, TOL, TOL + 1])(
    '5a. wall wound back by %d ms after 6 days never lowers trusted now',
    async delta => {
      const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
      const time = harness(clocks);
      await time.observeServerTime({
        dateHeader: header(T0),
        authenticated: true,
      });
      tick(clocks, 6 * DAY);
      clocks.wallMs -= delta;
      const reading = await time.read();
      expect(reading.nowMs).toBe(T0 + 6 * DAY);
      expect(reading.rollbackDetected).toBe(delta > TOL);
      const verdict = evaluateLease(lease, reading);
      if (delta > TOL) {
        expect(verdict).toEqual({
          kind: 'reconcile_required',
          reason: 'clock_rollback',
        });
      } else {
        expect(verdict).toEqual({
          kind: 'active',
          remainingMs: LEASE_MAX_MS - 6 * DAY,
        });
      }
    },
  );

  it('5b. 200 alternating +4m/-4m wall jumps never move trusted now backwards nor extend the lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    let last = (await time.read()).nowMs;
    for (let i = 0; i < 200; i += 1) {
      clocks.wallMs += i % 2 === 0 ? 4 * MINUTE : -4 * MINUTE;
      const reading = await time.read();
      expect(reading.nowMs).toBeGreaterThanOrEqual(last);
      expect(reading.rollbackDetected).toBe(false);
      const verdict = evaluateLease(lease, reading);
      expect(verdict.kind).toBe('active');
      if (verdict.kind === 'active')
        expect(verdict.remainingMs).toBeLessThanOrEqual(LEASE_MAX_MS);
      last = reading.nowMs;
    }
    // Trusted now drifted forward by at most the one uncorrected +4m step.
    expect(last).toBeLessThanOrEqual(T0 + 4 * MINUTE);
  });

  it('5c. a far-future wall clock then a correction: the lease shortens, never lengthens, and the high-water mark survives', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    clocks.wallMs = T0 + 30 * DAY;
    tick(clocks, TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + 1);
    const ahead = await time.read();
    expect(evaluateLease(lease, ahead).kind).toBe('expired');
    clocks.wallMs = T0 + 2 * MINUTE;
    const corrected = await time.read();
    expect(corrected.nowMs).toBeGreaterThanOrEqual(ahead.nowMs);
    expect(evaluateLease(lease, corrected).kind).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 6 — corrupt / partial / tampered persisted records after relaunch.
// ---------------------------------------------------------------------------
describe('ATTACK 6 — corrupt, partial and tampered persisted records', () => {
  const cases: Array<[string, unknown]> = [
    ['numeric strings', validRecord({ highWaterMs: String(T0 + 6 * DAY) })],
    ['float millis', validRecord({ highWaterMs: T0 + 0.5 })],
    ['negative high water', validRecord({ highWaterMs: -1 })],
    ['NaN offset', { ...validRecord(), wallOffsetMs: Number.NaN }],
    ['high water below server epoch', validRecord({ highWaterMs: T0 - DAY })],
    ['server epoch far future', validRecord({ serverEpochMs: 2 ** 53 })],
    [
      'missing high water',
      (() => {
        const r: Record<string, unknown> = validRecord();
        delete r.highWaterMs;
        return r;
      })(),
    ],
    ['wrong schema', validRecord({ schemaVersion: 'trusted-time-anchor-v0' })],
    ['array body', [T0, T0 + 6 * DAY]],
    ['truncated JSON', JSON.stringify(validRecord()).slice(0, 40)],
    ['empty string', ''],
    ['null literal', 'null'],
    [
      'prototype pollution',
      '{"__proto__":{"highWaterMs":0},"schemaVersion":"trusted-time-anchor-v1","serverEpochMs":1,"highWaterMs":1,"wallOffsetMs":0}',
    ],
  ];

  it.each(cases)(
    '6a. %s never authorises a lease and never throws',
    async (_name, record) => {
      seedRecord(record);
      const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + MINUTE };
      const time = harness(clocks);
      const reading = await time.read();
      expect(evaluateLease(lease, reading).kind).not.toBe('active');
      expect(['none', 'floor']).toContain(reading.authority);
    },
  );

  it('6b. a tampered record that lowers the high-water mark below a wall clock seen earlier cannot make an expired lease active', async () => {
    seedRecord(validRecord({ highWaterMs: T0 + MINUTE, serverEpochMs: T0 }));
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + MINUTE };
    const time = harness(clocks);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });

  it('6c. a high-water mark at the accepted maximum leaves a record that later checkpoints can still overwrite', async () => {
    seedRecord(validRecord({ highWaterMs: Date.UTC(2100, 0, 1) - 1 }));
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const before = await time.read();
    expect(evaluateLease(lease, before).kind).not.toBe('active');
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + 1);
    await time.read();
    expect(storedRecord().serverEpochMs).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 7 — process death / relaunch with a persisted floor: the floor may
// prove expiry but never authorise; relaunch loops cannot revive a lease.
// ---------------------------------------------------------------------------
describe('ATTACK 7 — relaunch loops', () => {
  it('7a. 20 relaunches with the clock wound back one day each never authorise and never lower the high-water mark', async () => {
    let clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    let time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, 6 * DAY + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS);
    await time.read();
    const hw = storedRecord().highWaterMs as number;
    expect(hw).toBeGreaterThanOrEqual(T0 + 6 * DAY);

    for (let i = 1; i <= 20; i += 1) {
      clocks = { monotonicMs: 0, wallMs: T0 + 6 * DAY - i * DAY };
      time = harness(clocks);
      tick(clocks, TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + 1);
      const reading = await time.read();
      expect(evaluateLease(lease, reading).kind).not.toBe('active');
      expect(reading.nowMs).toBeGreaterThanOrEqual(hw);
      expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(hw);
    }
  });

  it('7b. relaunch while backgrounded then a stale response: never measured', async () => {
    seedRecord(validRecord());
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + 6 * DAY };
    const app = fakeLifecycle('background');
    const time = harness(clocks, app.lifecycle);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    tick(clocks, SECOND);
    const reading = await time.read();
    expect(reading.continuity).not.toBe('measured');
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 8 — hostile clock sources and Date headers.
// ---------------------------------------------------------------------------
describe('ATTACK 8 — hostile clocks and Date headers', () => {
  it.each([
    ['NaN monotonic', Number.NaN],
    ['negative monotonic', -1],
    ['infinite monotonic', Number.POSITIVE_INFINITY],
  ])('8a. %s after anchoring never authorises', async (_n, mono) => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    clocks.monotonicMs = mono;
    clocks.wallMs += DAY;
    const reading = await time.read();
    expect(Number.isFinite(reading.nowMs)).toBe(true);
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });

  it('8b. monotonic clock running backwards is not counted as negative elapsed', async () => {
    const clocks: Clocks = { monotonicMs: HOUR, wallMs: T0 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
    });
    clocks.monotonicMs = 0;
    clocks.wallMs -= 10 * MINUTE;
    const reading = await time.read();
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0);
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });

  it.each([
    ['empty', ''],
    ['two dates', `${header(T0)}, ${header(T0 + DAY)}`],
    ['year 9999', 'Fri, 31 Dec 9999 23:59:59 GMT'],
    ['year 1970', 'Thu, 01 Jan 1970 00:00:00 GMT'],
    ['year 1999', 'Fri, 31 Dec 1999 23:59:59 GMT'],
    ['relative', 'now'],
    ['ms epoch', String(T0)],
    ['unicode digits', 'Tue, ０８ Sep 2026 12:00:00 GMT'],
    ['leap second', 'Tue, 08 Sep 2026 23:59:60 GMT'],
    ['invalid date', new Date(Number.NaN).toString()],
  ])('8c. Date header %s is rejected and leaves no anchor', async (_n, h) => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const observation = await time.observeServerTime({
      dateHeader: h,
      authenticated: true,
    });
    expect(observation.accepted).toBe(false);
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('8d. unauthenticated responses never anchor even with a valid Date', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const observation = await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: false,
    });
    expect(observation.accepted).toBe(false);
    expect((await time.read()).authority).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 9 — api.ts wiring: which responses reach the singleton.
// ---------------------------------------------------------------------------
describe('ATTACK 9 — api.ts wiring at network failure boundaries', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  /** The singleton is frozen, so observe it through its effects. */
  async function fed(): Promise<boolean> {
    const reading = await trustedTime.read();
    return (
      reading.authority !== 'none' ||
      __keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)
    );
  }

  function respond(
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => {
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: 'status',
        json: async () => {
          if (body === undefined) throw new SyntaxError('no body');
          return body;
        },
        headers: new Headers(headers),
      } as unknown as Response;
    });
  }

  const authed = () =>
    api.request(
      { baseUrl: 'https://api.test', token: 'access-token' },
      'GET',
      '/v1/me/access',
    );

  it.each([
    [401, { error: { code: 'unauthorized', message: 'no' } }],
    [403, { error: { code: 'forbidden', message: 'no' } }],
    [429, { error: { code: 'rate_limited', message: 'slow down' } }],
    [500, { error: { code: 'internal', message: 'no' } }],
    [503, { error: { code: 'unavailable', message: 'no' } }],
    [408, undefined],
  ])(
    '9a. a %d with a Date header never feeds the trusted clock',
    async (status, body) => {
      respond(status, body, {
        date: header(T0 + 30 * DAY),
        'retry-after': '1',
      });
      await expect(authed()).rejects.toBeDefined();
      expect(await fed()).toBe(false);
    },
  );

  it.each([
    ['array', [1, 2, 3]],
    ['string', 'ok'],
    ['null', null],
    ['unparseable', undefined],
  ])(
    '9b. a 200 whose body is %s never feeds the trusted clock',
    async (_n, body) => {
      respond(200, body, { date: header(T0 + 30 * DAY) });
      await expect(authed()).rejects.toBeDefined();
      expect(await fed()).toBe(false);
    },
  );

  it('9c. a 200 without a bearer token never feeds the trusted clock', async () => {
    respond(200, { ok: true }, { date: header(T0 + 30 * DAY) });
    await api.request(
      { baseUrl: 'https://api.test', token: null },
      'GET',
      '/healthz',
    );
    expect(await fed()).toBe(false);
  });

  it('9d. a 3xx redirect (manual) never feeds the trusted clock', async () => {
    respond(302, undefined, {
      date: header(T0),
      location: 'https://evil.example/',
    });
    await expect(authed()).rejects.toBeDefined();
    expect(await fed()).toBe(false);
  });

  it('9e. a 200 object body from an authenticated request feeds exactly one observation with the Date header', async () => {
    respond(200, { ok: true }, { date: header(T0) });
    await authed();
    expect(await fed()).toBe(true);
    expect(storedRecord().serverEpochMs).toBe(T0);
  });
});

// ---------------------------------------------------------------------------
// ATTACK 10 — lease boundary values through evaluateLease.
// ---------------------------------------------------------------------------
describe('ATTACK 10 — lease boundary values', () => {
  function anchoredAt(nowMs: number): TrustedTimeReading {
    return {
      nowMs,
      wallClockMs: nowMs,
      authority: 'anchored',
      continuity: 'measured',
      rollbackDetected: false,
      storage: 'loaded',
    };
  }

  it.each([
    ['NaN issuedAt', { issuedAtMs: Number.NaN, expiresAtMs: T0 + DAY }],
    ['NaN expiresAt', { issuedAtMs: T0, expiresAtMs: Number.NaN }],
    ['float expiresAt', { issuedAtMs: T0, expiresAtMs: T0 + 0.5 }],
    [
      'Infinity expiresAt',
      { issuedAtMs: T0, expiresAtMs: Number.POSITIVE_INFINITY },
    ],
    ['negative issuedAt', { issuedAtMs: -1, expiresAtMs: T0 }],
    ['expires == issued', { issuedAtMs: T0, expiresAtMs: T0 }],
    ['expires < issued', { issuedAtMs: T0, expiresAtMs: T0 - 1 }],
    ['MAX_SAFE expires', { issuedAtMs: -(2 ** 53), expiresAtMs: 2 ** 53 }],
  ])('10a. %s never yields active with remaining beyond the cap', (_n, l) => {
    const verdict = evaluateLease(l, anchoredAt(T0 + 1));
    if (verdict.kind === 'active') {
      expect(verdict.remainingMs).toBeLessThanOrEqual(LEASE_MAX_MS);
      expect(verdict.remainingMs).toBeGreaterThan(0);
    } else {
      expect(['reconcile_required', 'expired']).toContain(verdict.kind);
    }
  });

  it('10b. a 30-day lease is capped to 7 days from issue, not from now', () => {
    const long = { issuedAtMs: T0, expiresAtMs: T0 + 30 * DAY };
    expect(evaluateLease(long, anchoredAt(T0 + 7 * DAY))).toEqual({
      kind: 'expired',
    });
    expect(evaluateLease(long, anchoredAt(T0 + 7 * DAY - 1))).toEqual({
      kind: 'active',
      remainingMs: 1,
    });
  });

  it('10c. a lease issued exactly TOL ahead of trusted now is accepted, TOL+1 is not', () => {
    const now = T0;
    const ok = { issuedAtMs: now + TOL, expiresAtMs: now + TOL + DAY };
    const bad = { issuedAtMs: now + TOL + 1, expiresAtMs: now + TOL + 1 + DAY };
    expect(evaluateLease(ok, anchoredAt(now)).kind).toBe('active');
    expect(evaluateLease(bad, anchoredAt(now))).toEqual({
      kind: 'reconcile_required',
      reason: 'lease_ahead_of_clock',
    });
  });
});
