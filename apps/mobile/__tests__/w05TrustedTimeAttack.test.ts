/**
 * W05-02 adversarial suite (attack branch devin/pp/w05-02/attack-5d02b578).
 *
 * Each `describe` block is one attack against candidate 5d02b578. Attacks that
 * the candidate withstands assert the fail-closed behaviour; attacks that break
 * it assert the behaviour the objective requires ("a backwards wall-clock jump
 * cannot extend a lease") and therefore FAIL on the candidate.
 */
import type { AppStateStatus } from 'react-native';
import type * as KeychainModule from 'react-native-keychain';

import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';

import { api } from '../src/data/api';
import {
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_LEASE_MAX_MS,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  createTrustedTime,
  evaluateLease,
  responseDateHeader,
  trustedTime,
  type TrustedTimeLifecycle,
  type TrustedTimeReading,
} from '../src/data/trustedTime';
import { __keychainStore } from '../__mocks__/react-native-keychain';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const SERVER_MS = Date.UTC(2026, 8, 8, 12, 0, 0);
const WALL_START_MS = SERVER_MS + 90 * SECOND;
const MONO_START_MS = 4_321.5;

function serverHeader(ms: number): string {
  return new Date(ms).toUTCString();
}

class Clocks {
  wall = WALL_START_MS;
  mono = MONO_START_MS;
  wallFn: () => number = () => this.wall;
  monoFn: () => number = () => this.mono;

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  /** Device sleeps: wall clock advances, the process monotonic clock does not. */
  sleep(ms: number): void {
    this.wall += ms;
  }
}

type Lease = { issuedAtMs: number; expiresAtMs: number };

function lease(issuedAtMs: number, durationMs: number): Lease {
  return { issuedAtMs, expiresAtMs: issuedAtMs + durationMs };
}

function fakeLifecycle(): {
  lifecycle: TrustedTimeLifecycle;
  fire(state: AppStateStatus): void;
  listeners(): number;
} {
  const handlers = new Set<(state: AppStateStatus) => void>();
  return {
    lifecycle: {
      addEventListener(_type, handler) {
        handlers.add(handler);
        return { remove: () => handlers.delete(handler) };
      },
    },
    fire(state) {
      for (const handler of [...handlers]) handler(state);
    },
    listeners: () => handlers.size,
  };
}

function build(clocks: Clocks, keychain?: typeof KeychainModule) {
  const lc = fakeLifecycle();
  const time = createTrustedTime({
    wallClockNowMs: () => clocks.wallFn(),
    monotonicNowMs: () => clocks.monoFn(),
    lifecycle: lc.lifecycle,
    ...(keychain ? { keychain } : {}),
  });
  return { time, lc };
}

function storedJson(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no persisted trusted-time record');
  return JSON.parse(item.password) as Record<string, unknown>;
}

function seedRecord(record: unknown, service = TRUSTED_TIME_KEYCHAIN_SERVICE) {
  __keychainStore.set(service, {
    username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
    password: typeof record === 'string' ? record : JSON.stringify(record),
    accessible: 'AccessibleAfterFirstUnlockThisDeviceOnly',
  });
}

function validRecord(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
    serverEpochMs: SERVER_MS,
    highWaterMs: SERVER_MS + HOUR,
    wallOffsetMs: WALL_START_MS - SERVER_MS,
    persistedAtWallMs: WALL_START_MS + HOUR,
    ...overrides,
  };
}

function settles<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms),
    ),
  ]);
}

beforeEach(() => {
  __keychainStore.clear();
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 1 — wall clock wound back while the app is suspended', () => {
  // On iOS the user must leave the app to open Settings > Date & Time, so a
  // rollback always lands while the process is suspended and performance.now()
  // is frozen. The module must not treat the frozen interval as "no time
  // passed" and must not let the rewound wall clock lower the estimate.
  it('does not report an active lease after 6 days of device sleep hidden by a rollback', async () => {
    const clocks = new Clocks();
    const { time, lc } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const activeLease = lease(SERVER_MS, DAY);
    expect(evaluateLease(activeLease, await time.read()).kind).toBe('active');

    // App used for one minute, then backgrounded.
    clocks.advance(MINUTE);
    lc.fire('background');

    // Device sleeps six days (wall advances, monotonic frozen). Before the app
    // is resumed, the user winds the wall clock back to where it was.
    clocks.sleep(6 * DAY);
    clocks.sleep(-6 * DAY);

    // Resume: the candidate's foreground checkpoint runs against the rewound
    // clock.
    lc.fire('active');
    clocks.advance(SECOND);

    const reading = await time.read();
    const verdict = evaluateLease(activeLease, reading);
    // A one-day lease issued 6+ days ago cannot be active. Either the module
    // detects the rollback or it proves the lease expired; anything else means
    // the backwards jump extended the lease.
    expect(verdict.kind).not.toBe('active');
  });

  it('cannot be re-armed by a rollback before every foreground: repeated sleep+rollback cycles', async () => {
    const clocks = new Clocks();
    const { time, lc } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const weekLease = lease(SERVER_MS, 7 * DAY);
    const seen: number[] = [];
    for (let cycle = 0; cycle < 10; cycle += 1) {
      clocks.advance(30 * SECOND);
      lc.fire('background');
      clocks.sleep(2 * DAY);
      clocks.sleep(-2 * DAY + 30 * SECOND);
      lc.fire('active');
      const reading = await time.read();
      seen.push(evaluateLease(weekLease, reading).kind === 'active' ? 1 : 0);
    }
    // 10 cycles x 2 days = 20 days of real time on a 7-day lease.
    expect(seen.slice(-3)).toEqual([0, 0, 0]);
  });

  it('boundary: the same rollback IS caught when the honest clock was seen at a foreground first', async () => {
    const clocks = new Clocks();
    const { time, lc } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const activeLease = lease(SERVER_MS, DAY);
    clocks.advance(MINUTE);
    lc.fire('background');
    clocks.sleep(6 * DAY);
    lc.fire('active');
    await time.checkpoint();
    lc.fire('background');
    clocks.sleep(-6 * DAY);
    lc.fire('active');
    const reading = await time.read();
    expect(reading.rollbackDetected).toBe(true);
    expect(evaluateLease(activeLease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 1b — forward-jump poisoning and recovery', () => {
  it('a wall clock set years ahead then corrected leaves the device fail-closed until an authenticated response heals it', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const weekLease = lease(SERVER_MS, 7 * DAY);
    // User (or a buggy NTP) pushes the clock 4 years ahead while foregrounded.
    clocks.wall += 4 * 365 * DAY;
    clocks.advance(MINUTE);
    const poisoned = await time.read();
    expect(evaluateLease(weekLease, poisoned).kind).toBe('expired');
    await time.checkpoint();
    expect(storedJson().highWaterMs as number).toBeGreaterThan(
      SERVER_MS + 4 * 365 * DAY,
    );
    // Honest correction: must be fail-closed (rollback), never active.
    clocks.wall -= 4 * 365 * DAY;
    clocks.advance(MINUTE);
    const corrected = await time.read();
    expect(corrected.rollbackDetected).toBe(true);
    expect(evaluateLease(weekLease, corrected).kind).toBe('reconcile_required');

    // Relaunch offline: still fail-closed.
    clocks.mono = 3;
    clocks.advance(MINUTE);
    const relaunched = build(clocks);
    const offline = await relaunched.time.read();
    expect(evaluateLease(weekLease, offline).kind).not.toBe('active');

    // Authenticated server heals the poisoned floor; the lease is usable again.
    await relaunched.time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 5 * MINUTE),
      authenticated: true,
    });
    const healed = await relaunched.time.read();
    expect(healed.authority).toBe('anchored');
    expect(healed.rollbackDetected).toBe(false);
    expect(healed.nowMs).toBeLessThan(SERVER_MS + HOUR);
    expect(evaluateLease(weekLease, healed).kind).toBe('active');
    expect(storedJson().highWaterMs as number).toBeLessThan(SERVER_MS + HOUR);
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 2 — remaining lease exceeds the 7-day cap', () => {
  it('a lease issued exactly at the ahead-of-clock tolerance is capped at 7 days remaining', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const reading = await time.read();
    const issuedAtMs = reading.nowMs + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS;
    const verdict = evaluateLease(lease(issuedAtMs, 30 * DAY), reading);
    expect(verdict.kind).toBe('active');
    if (verdict.kind !== 'active') throw new Error('unreachable');
    // Product invariant: Pro offline leases <= 7 days.
    expect(verdict.remainingMs).toBeLessThanOrEqual(TRUSTED_TIME_LEASE_MAX_MS);
    expect(TRUSTED_TIME_LEASE_MAX_MS).toBe(
      OFFLINE_PRO_LEASE_MAX_SECONDS * 1000,
    );
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 3 — Keychain that never answers', () => {
  function hangingKeychain(hang: 'get' | 'set'): typeof KeychainModule {
    const never = () => new Promise<never>(() => undefined);
    return {
      ACCESSIBLE: {
        AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
          'AccessibleAfterFirstUnlockThisDeviceOnly',
      },
      getGenericPassword: hang === 'get' ? never : async () => false,
      setGenericPassword: hang === 'set' ? never : async () => false,
      resetGenericPassword: async () => true,
    } as unknown as typeof KeychainModule;
  }

  it('read() settles even when Keychain hydration never resolves', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks, hangingKeychain('get'));
    await expect(settles(time.read(), 200)).resolves.toBeDefined();
  });

  it('an in-process anchor stays readable when a Keychain write never resolves', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks, hangingKeychain('set'));
    void time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.advance(SECOND);
    const reading = await settles(time.read(), 200);
    expect(reading.authority).toBe('anchored');
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 4 — lease boundary values', () => {
  const badLeases: Array<[string, Lease]> = [
    ['NaN issuedAt', { issuedAtMs: Number.NaN, expiresAtMs: SERVER_MS + DAY }],
    ['Infinity expiry', { issuedAtMs: SERVER_MS, expiresAtMs: Infinity }],
    ['negative issuedAt', { issuedAtMs: -DAY, expiresAtMs: SERVER_MS + DAY }],
    [
      'float issuedAt',
      { issuedAtMs: SERVER_MS + 0.5, expiresAtMs: SERVER_MS + DAY },
    ],
    ['zero-length', { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS }],
    ['inverted', { issuedAtMs: SERVER_MS + DAY, expiresAtMs: SERVER_MS }],
    [
      'MAX_SAFE_INTEGER expiry',
      { issuedAtMs: SERVER_MS, expiresAtMs: Number.MAX_SAFE_INTEGER },
    ],
    [
      'beyond MAX_SAFE_INTEGER',
      { issuedAtMs: SERVER_MS, expiresAtMs: Number.MAX_SAFE_INTEGER + 2 },
    ],
  ];

  it.each(badLeases)(
    'lease %s never yields more than 7 days and never throws',
    async (_label, bad) => {
      const clocks = new Clocks();
      const { time } = build(clocks);
      await time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS),
        authenticated: true,
      });
      const verdict = evaluateLease(bad, await time.read());
      if (verdict.kind === 'active') {
        expect(verdict.remainingMs).toBeLessThanOrEqual(
          TRUSTED_TIME_LEASE_MAX_MS,
        );
        expect(Number.isFinite(verdict.remainingMs)).toBe(true);
      }
    },
  );

  it('a seconds-based lease is never judged active', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const reading = await time.read();
    const secondsLease = {
      issuedAtMs: Math.floor(SERVER_MS / 1000),
      expiresAtMs: Math.floor(SERVER_MS / 1000) + OFFLINE_PRO_LEASE_MAX_SECONDS,
    };
    // The candidate judges it `expired` rather than `invalid_lease`; either is
    // fail-closed, so only an active verdict would be a break.
    expect(evaluateLease(secondsLease, reading).kind).not.toBe('active');
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 5 — honest offline relaunch (process death, no tampering)', () => {
  it('a valid persisted anchor with an honest wall clock still authorises the remaining lease after relaunch', async () => {
    const clocks = new Clocks();
    const first = build(clocks);
    await first.time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const weekLease = lease(SERVER_MS, 7 * DAY);
    clocks.advance(2 * HOUR);
    await first.time.checkpoint();

    // Process killed; relaunched one hour later with the wall clock honest and
    // no network. The persisted anchor + honest wall clock place "now" firmly
    // inside the lease window.
    clocks.mono = 12.25;
    clocks.advance(HOUR);
    const second = build(clocks);
    const reading = await second.time.read();
    expect(reading.storage).toBe('loaded');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBeGreaterThanOrEqual(SERVER_MS + 3 * HOUR);
    expect(reading.nowMs).toBeLessThan(SERVER_MS + 7 * DAY);
    // Offline Pro lease: the user paid for 7 days offline; a relaunch without
    // network must not strand them.
    expect(evaluateLease(weekLease, reading).kind).toBe('active');
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 6 — corrupt, partial and tampered persisted records', () => {
  const weekLease = lease(SERVER_MS, 7 * DAY);

  async function relaunchWith(record: unknown, clocks = new Clocks()) {
    seedRecord(record);
    clocks.wall = SERVER_MS + 3 * DAY;
    const { time } = build(clocks);
    return time.read();
  }

  const corruptCases: Array<[string, unknown]> = [
    ['empty string', ''],
    ['whitespace', '   '],
    ['not JSON', '{not json'],
    ['JSON null', 'null'],
    ['JSON array', '[]'],
    ['JSON number', '42'],
    ['schema missing', validRecord({ schemaVersion: undefined })],
    ['schema v0', validRecord({ schemaVersion: 'trusted-time-anchor-v0' })],
    ['schema v2', validRecord({ schemaVersion: 'trusted-time-anchor-v2' })],
    ['serverEpochMs string', validRecord({ serverEpochMs: `${SERVER_MS}` })],
    ['serverEpochMs NaN', validRecord({ serverEpochMs: Number.NaN })],
    ['serverEpochMs float', validRecord({ serverEpochMs: SERVER_MS + 0.5 })],
    ['serverEpochMs negative', validRecord({ serverEpochMs: -1 })],
    ['serverEpochMs zero', validRecord({ serverEpochMs: 0 })],
    ['serverEpochMs Infinity', validRecord({ serverEpochMs: Infinity })],
    ['highWaterMs missing', validRecord({ highWaterMs: undefined })],
    ['highWaterMs below server', validRecord({ highWaterMs: SERVER_MS - 1 })],
    ['wallOffsetMs NaN', validRecord({ wallOffsetMs: Number.NaN })],
    ['wallOffsetMs string', validRecord({ wallOffsetMs: '0' })],
    ['wallOffsetMs float', validRecord({ wallOffsetMs: 0.5 })],
    ['oversized', validRecord({ pad: 'x'.repeat(64 * 1024) })],
    ['deep nesting', { a: { b: { c: validRecord() } } }],
  ];

  it.each(corruptCases)(
    'corrupt record (%s) never authorises a lease and does not crash',
    async (_label, record) => {
      const reading = await relaunchWith(record);
      expect(['invalid', 'empty']).toContain(reading.storage);
      expect(reading.authority).toBe('none');
      expect(Number.isFinite(reading.nowMs)).toBe(true);
      const verdict = evaluateLease(weekLease, reading);
      expect(verdict.kind).toBe('reconcile_required');
    },
  );

  it('a well-formed record carrying a __proto__ key neither pollutes Object.prototype nor authorises', async () => {
    const reading = await relaunchWith(
      validRecord({ ['__proto__']: { polluted: true } }),
    );
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(reading.authority).not.toBe('anchored');
    expect(evaluateLease(weekLease, reading).kind).not.toBe('active');
  });

  it('a well-formed record without persistedAtWallMs is treated as floor only', async () => {
    const reading = await relaunchWith(
      validRecord({ persistedAtWallMs: undefined }),
    );
    expect(reading.authority).not.toBe('anchored');
    expect(evaluateLease(weekLease, reading).kind).not.toBe('active');
  });

  it('a record stored under the wrong account is rejected', async () => {
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: 'someone-else',
      password: JSON.stringify(validRecord()),
    });
    const clocks = new Clocks();
    clocks.wall = SERVER_MS + 3 * DAY;
    const reading = await build(clocks).time.read();
    expect(reading.authority).toBe('none');
    expect(evaluateLease(weekLease, reading).kind).toBe('reconcile_required');
  });

  it('a well-formed record with a huge wall offset cannot manufacture an active lease', async () => {
    // Attacker rewrites the offset so the (honest) wall clock maps far into
    // the past, hoping to keep a lease alive; the floor must still win.
    const reading = await relaunchWith(
      validRecord({ wallOffsetMs: 365 * DAY, highWaterMs: SERVER_MS + HOUR }),
    );
    expect(reading.storage).toBe('loaded');
    expect(reading.nowMs).toBeGreaterThanOrEqual(SERVER_MS + HOUR);
    expect(evaluateLease(weekLease, reading).kind).not.toBe('active');
  });

  it('a replayed (older) record cannot be used to shorten the floor below a later checkpoint', async () => {
    const clocks = new Clocks();
    const first = build(clocks);
    await first.time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    await first.time.checkpoint();
    const early = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
    if (!early) throw new Error('expected persisted record');
    clocks.advance(6 * DAY + 23 * HOUR);
    await first.time.checkpoint();
    expect(storedJson().highWaterMs as number).toBeGreaterThanOrEqual(
      SERVER_MS + 6 * DAY,
    );

    // Replay the early record (backup restore) and relaunch with the wall
    // clock also wound back to the early time.
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, early);
    clocks.wall = WALL_START_MS + 2 * MINUTE;
    clocks.mono = 1;
    const second = build(clocks);
    const reading = await second.time.read();
    // Floor-only authority: cannot produce an active lease.
    expect(evaluateLease(weekLease, reading).kind).not.toBe('active');
  });

  it('corrupt storage is left in place for diagnosis and never overwritten by a floor-less checkpoint', async () => {
    seedRecord('{not json');
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.read();
    await time.checkpoint();
    expect(__keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE)?.password).toBe(
      '{not json',
    );
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 7 — concurrency, reentrancy and out-of-order server responses', () => {
  it('interleaved observe/read/checkpoint never lowers the clock and never yields an active lease after rollback', async () => {
    const clocks = new Clocks();
    const { time, lc } = build(clocks);
    const weekLease = lease(SERVER_MS, 7 * DAY);

    const results = await Promise.all([
      time.read(),
      time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS + HOUR),
        authenticated: true,
      }),
      time.read(),
      time.checkpoint(),
      time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS),
        authenticated: true,
      }),
      time.read(),
      time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS + 2 * HOUR),
        authenticated: false,
      }),
      time.read(),
    ]);
    const readings = results.filter(
      (r): r is TrustedTimeReading =>
        typeof r === 'object' && r !== null && 'authority' in r,
    );
    const nowValues = readings.map(r => r.nowMs);
    expect(nowValues).toEqual([...nowValues].sort((a, b) => a - b));
    const last = readings[readings.length - 1];
    if (!last) throw new Error('expected at least one reading');
    // A lower authenticated server time processed later must not shorten
    // what has elapsed; the unauthenticated +2h response must be ignored.
    expect(last.authority).toBe('anchored');
    const persistedEpoch = storedJson().serverEpochMs as number;
    expect(persistedEpoch).toBeGreaterThanOrEqual(SERVER_MS + HOUR);
    expect(persistedEpoch).toBeLessThan(SERVER_MS + 2 * HOUR);
    expect(last.nowMs).toBeLessThan(SERVER_MS + 2 * HOUR);

    // Rollback while requests are still in flight.
    const inflight = [
      time.read(),
      time.checkpoint(),
      time.observeServerTime({ dateHeader: null, authenticated: true }),
    ];
    clocks.wall -= DAY;
    for (let i = 0; i < 20; i += 1) lc.fire('active');
    const afterRollback = await Promise.all([...inflight, time.read()]);
    const finalReading = afterRollback[afterRollback.length - 1];
    if (!finalReading || typeof finalReading !== 'object')
      throw new Error('expected reading');
    expect((finalReading as TrustedTimeReading).rollbackDetected).toBe(true);
    expect(
      evaluateLease(weekLease, finalReading as TrustedTimeReading).kind,
    ).toBe('reconcile_required');
    expect(lc.listeners()).toBe(1);
  });

  it('a stale (older) authenticated response arriving after a newer one does not lower the estimate below elapsed time', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + DAY),
      authenticated: true,
    });
    clocks.advance(HOUR);
    const before = await time.read();
    // Stale response from a request that left before the newer one.
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const after = await time.read();
    // The candidate documents that only the server may lower the clock; the
    // attack checks the lowered anchor is still pinned to real elapsed time.
    expect(after.nowMs).toBeGreaterThanOrEqual(SERVER_MS + HOUR);
    expect(after.nowMs).toBeLessThanOrEqual(before.nowMs);
    const shortLease = lease(SERVER_MS, 30 * MINUTE);
    expect(evaluateLease(shortLease, after).kind).toBe('expired');
  });

  it('a throwing lifecycle subscription does not break read()', async () => {
    const clocks = new Clocks();
    const time = createTrustedTime({
      wallClockNowMs: () => clocks.wall,
      monotonicNowMs: () => clocks.mono,
      lifecycle: {
        addEventListener() {
          throw new Error('AppState unavailable');
        },
      },
    });
    const reading = await settles(time.read(), 500);
    expect(reading.authority).toBe('none');
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 8 — hostile clock sources', () => {
  const weekLease = lease(SERVER_MS, 7 * DAY);

  const badValues: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -1],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
    ['MAX_VALUE', Number.MAX_VALUE],
  ];

  it.each(badValues)(
    'wall clock returning %s at anchor time never authorises and never throws',
    async (_label, value) => {
      const clocks = new Clocks();
      clocks.wallFn = () => value;
      const { time } = build(clocks);
      await time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS),
        authenticated: true,
      });
      const reading = await time.read();
      expect(Number.isFinite(reading.nowMs)).toBe(true);
      expect(reading.nowMs).toBeGreaterThanOrEqual(SERVER_MS);
      const verdict = evaluateLease(weekLease, reading);
      expect(verdict.kind).not.toBe('expired');
      if (verdict.kind === 'active') {
        expect(verdict.remainingMs).toBeLessThanOrEqual(7 * DAY);
      }
    },
  );

  it.each(badValues)(
    'monotonic clock returning %s after anchoring keeps the clock finite, non-decreasing and never throws',
    async (_label, value) => {
      const clocks = new Clocks();
      const { time } = build(clocks);
      await time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS),
        authenticated: true,
      });
      const before = await time.read();
      clocks.monoFn = () => value;
      const reading = await time.read();
      expect(Number.isFinite(reading.nowMs)).toBe(true);
      expect(reading.nowMs).toBeGreaterThanOrEqual(before.nowMs);
      await expect(time.checkpoint()).resolves.toBeUndefined();
      // Whatever was persisted must still hydrate on relaunch without throwing.
      const relaunched = build(new Clocks());
      const after = await relaunched.time.read();
      expect(Number.isFinite(after.nowMs)).toBe(true);
    },
  );

  it('clocks that throw after anchoring degrade without throwing and never authorise', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.wallFn = () => {
      throw new Error('clock unavailable');
    };
    clocks.monoFn = () => {
      throw new Error('clock unavailable');
    };
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(Number.isFinite(reading.nowMs)).toBe(true);
    expect(evaluateLease(weekLease, reading).kind).toBe('reconcile_required');
    await expect(time.checkpoint()).resolves.toBeUndefined();
  });

  it('a monotonic clock that jumps backwards cannot lower the estimate', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.advance(HOUR);
    const before = await time.read();
    clocks.mono -= 2 * HOUR;
    clocks.wall -= 2 * HOUR;
    const after = await time.read();
    expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs);
    expect(after.rollbackDetected).toBe(true);
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 9 — Date header parser boundaries', () => {
  const clocks = new Clocks();
  let time: ReturnType<typeof build>['time'];
  beforeEach(() => {
    time = build(new Clocks()).time;
  });

  const rejected: Array<[string, string | null]> = [
    ['null', null],
    ['empty', ''],
    ['RFC 850', 'Tuesday, 08-Sep-26 12:00:00 GMT'],
    ['asctime', 'Tue Sep  8 12:00:00 2026'],
    ['ISO 8601', '2026-09-08T12:00:00Z'],
    ['epoch seconds', '1788609600'],
    ['lowercase month', 'Tue, 08 sep 2026 12:00:00 GMT'],
    ['+0000 zone', 'Tue, 08 Sep 2026 12:00:00 +0000'],
    ['UTC zone', 'Tue, 08 Sep 2026 12:00:00 UTC'],
    ['no zone', 'Tue, 08 Sep 2026 12:00:00'],
    ['wrong weekday', 'Mon, 08 Sep 2026 12:00:00 GMT'],
    ['hour 24', 'Tue, 08 Sep 2026 24:00:00 GMT'],
    ['minute 60', 'Tue, 08 Sep 2026 12:60:00 GMT'],
    ['second 61', 'Tue, 08 Sep 2026 12:00:61 GMT'],
    ['Feb 30', 'Mon, 30 Feb 2026 12:00:00 GMT'],
    ['day 0', 'Tue, 00 Sep 2026 12:00:00 GMT'],
    ['year 1969', 'Wed, 31 Dec 1969 23:59:59 GMT'],
    ['year 0000', 'Sat, 01 Jan 0000 00:00:00 GMT'],
    ['header injection', 'Tue, 08 Sep 2026 12:00:00 GMT\r\nX: y'],
    ['trailing garbage', 'Tue, 08 Sep 2026 12:00:00 GMT junk'],
    [
      'two dates',
      'Tue, 08 Sep 2026 12:00:00 GMT, Tue, 08 Sep 2026 12:00:00 GMT',
    ],
    ['unicode digits', 'Tue, ０８ Sep 2026 12:00:00 GMT'],
    ['far future year 9999', 'Fri, 31 Dec 9999 23:59:59 GMT'],
  ];

  it.each(rejected)(
    'authenticated header %s does not anchor',
    async (_label, header) => {
      const observation = await time.observeServerTime({
        dateHeader: header,
        authenticated: true,
      });
      expect(observation.accepted).toBe(false);
      expect((await time.read()).authority).toBe('none');
      expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
    },
  );

  it('surrounding whitespace is the only tolerated deviation and yields the exact epoch', async () => {
    const observation = await time.observeServerTime({
      dateHeader: ' Tue, 08 Sep 2026 12:00:00 GMT ',
      authenticated: true,
    });
    expect(observation).toEqual({ accepted: true, serverEpochMs: SERVER_MS });
  });

  it('an unauthenticated response with a valid far-past date does not anchor or lower the clock', async () => {
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + DAY),
      authenticated: true,
    });
    const before = await time.read();
    const observation = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS - 30 * DAY),
      authenticated: false,
    });
    expect(observation.accepted).toBe(false);
    const after = await time.read();
    expect(after.nowMs).toBeGreaterThanOrEqual(before.nowMs);
    expect(clocks.wall).toBe(WALL_START_MS);
  });

  it('the earliest and latest strict IMF-fixdate values are handled without throwing', async () => {
    const first = await time.observeServerTime({
      dateHeader: 'Thu, 01 Jan 1970 00:00:00 GMT',
      authenticated: true,
    });
    const reading = await time.read();
    expect(Number.isFinite(reading.nowMs)).toBe(true);
    if (first.accepted) {
      // An anchor at epoch zero must not make the seven-day cap overflow.
      expect(evaluateLease(lease(0, 7 * DAY), reading).kind).not.toBe('active');
    }
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 10 — API wiring: failure responses and unauthenticated traffic', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  function response(
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: async () => body,
      headers: new Headers(headers),
    } as unknown as Response;
  }

  const futureHeader = serverHeader(Date.UTC(2031, 0, 1));

  const errorResponses: Array<[string, () => Response]> = [
    [
      '429 + Retry-After',
      () =>
        response(
          429,
          { error: 'rate_limited' },
          {
            date: futureHeader,
            'retry-after': '120',
          },
        ),
    ],
    ['500', () => response(500, { error: 'boom' }, { date: futureHeader })],
    ['503', () => response(503, { error: 'down' }, { date: futureHeader })],
    [
      '401',
      () => response(401, { error: 'unauthorized' }, { date: futureHeader }),
    ],
    [
      '403',
      () => response(403, { error: 'forbidden' }, { date: futureHeader }),
    ],
    [
      '302 (non-ok redirect body)',
      () =>
        response(
          302,
          {},
          { date: futureHeader, location: 'https://evil.test' },
        ),
    ],
  ];

  it.each(errorResponses)(
    'an authenticated %s response with a far-future Date header does not anchor',
    async (_label, make) => {
      (globalThis as { fetch?: unknown }).fetch = jest.fn(async () => make());
      await expect(
        api.request(
          { baseUrl: 'https://api.test', token: 'access-token' },
          'GET',
          '/v1/me',
        ),
      ).rejects.toBeDefined();
      await new Promise(r => setTimeout(r, 0));
      const reading = await trustedTime.read();
      expect(reading.nowMs).toBeLessThan(Date.UTC(2031, 0, 1));
      expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
    },
  );

  it('an unauthenticated 200 with a Date header never anchors the shared clock', async () => {
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      response(200, { ok: true }, { date: futureHeader }),
    );
    await api.request(
      { baseUrl: 'https://api.test', token: null },
      'GET',
      '/v1/anonymous',
    );
    await new Promise(r => setTimeout(r, 0));
    expect((await trustedTime.read()).authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('a 200 whose body fails to parse still surfaces its Date header, and a headers getter that throws yields null', async () => {
    const ok = response(200, {}, { date: serverHeader(SERVER_MS) });
    expect(responseDateHeader(ok)).toBe(serverHeader(SERVER_MS));
    expect(
      responseDateHeader({
        get headers(): Headers {
          throw new Error('no headers');
        },
      } as unknown as Response),
    ).toBeNull();
    expect(
      responseDateHeader({ headers: undefined } as unknown as Response),
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------------ */
describe('ATTACK 11 — checkpoint interval and persistence pressure', () => {
  it('a rollback larger than the tolerance is detected even when the last checkpoint is older than the interval', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.advance(TRUSTED_TIME_CHECKPOINT_INTERVAL_MS * 3);
    await time.checkpoint();
    const persisted = storedJson().highWaterMs as number;
    expect(persisted).toBeGreaterThanOrEqual(
      SERVER_MS + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS * 3,
    );
    clocks.wall -= TRUSTED_TIME_ROLLBACK_TOLERANCE_MS + SECOND;
    const reading = await time.read();
    expect(reading.rollbackDetected).toBe(true);
    // Rollback readings must still be persisted at (not below) the high water.
    await time.checkpoint();
    expect(storedJson().highWaterMs as number).toBeGreaterThanOrEqual(
      persisted,
    );
  });

  it('1000 rapid checkpoints never lower the persisted high-water mark', async () => {
    const clocks = new Clocks();
    const { time } = build(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    let last = 0;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 1000; i += 1) {
      clocks.advance(i % 7 === 0 ? -MINUTE : 100);
      pending.push(time.checkpoint());
    }
    await Promise.all(pending);
    const stored = storedJson().highWaterMs as number;
    expect(stored).toBeGreaterThanOrEqual(last);
    last = stored;
    expect(last).toBeGreaterThanOrEqual(SERVER_MS);
  });
});
