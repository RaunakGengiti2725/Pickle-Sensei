/**
 * W05-02 ADVERSARIAL SUITE — trusted time for offline lease expiry.
 *
 * Every test asserts the behaviour the work package REQUIRES ("a backwards
 * wall-clock jump cannot extend a lease"; conservative estimates; corrupt or
 * uncertain state never becomes authorization). A FAILING test here is a
 * confirmed break of the candidate at `8e62e2c0`; a passing test is an attack
 * the candidate survives. Nothing in the candidate's own tests or production
 * code is modified.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';
import { API_REQUEST_TIMEOUT_MS } from '../src/data/api';
import {
  TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  createTrustedTime,
  evaluateLease,
  type TrustedTimeKeychain,
} from '../src/data/trustedTime';

type KeychainMock = typeof Keychain & {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};
const { __keychainStore } = Keychain as unknown as KeychainMock;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE_MAX_MS = OFFLINE_PRO_LEASE_MAX_SECONDS * 1000;
/** Server time on the authenticated response that issued the lease. */
const S = Date.UTC(2026, 8, 8, 12, 0, 0);
const lease = { issuedAtMs: S, expiresAtMs: S + LEASE_MAX_MS };

function serverHeader(ms: number): string {
  return new Date(ms).toUTCString();
}

interface Clocks {
  monotonicMs: number;
  wallMs: number;
}

function harness(clocks: Clocks, keychain: TrustedTimeKeychain = Keychain) {
  return createTrustedTime({
    keychain,
    monotonicNowMs: () => clocks.monotonicMs,
    wallClockNowMs: () => clocks.wallMs,
  });
}

function storedRecord(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no trusted-time record persisted');
  return JSON.parse(item.password) as Record<string, unknown>;
}

function seedRecord(record: unknown, username = TRUSTED_TIME_KEYCHAIN_ACCOUNT) {
  __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
    username,
    password: typeof record === 'string' ? record : JSON.stringify(record),
  });
}

/** Anchor at S with honest clocks, run offline for `offlineDays`, checkpoint,
 * then "kill" the process (drop the instance). */
async function anchoredThenKilled(offlineDays: number): Promise<void> {
  const clocks: Clocks = { monotonicMs: 0, wallMs: S };
  const alive = harness(clocks);
  const observed = await alive.observeServerTime({
    dateHeader: serverHeader(S),
    authenticated: true,
  });
  expect(observed).toEqual({ accepted: true, serverEpochMs: S });
  clocks.monotonicMs += offlineDays * DAY;
  clocks.wallMs += offlineDays * DAY;
  await alive.checkpoint();
  expect(storedRecord().highWaterMs).toBe(S + offlineDays * DAY);
}

beforeEach(() => {
  __keychainStore.clear();
});

describe('ATTACK 1 — backwards wall-clock jump across a process restart', () => {
  it('a lease that has really expired must not come back as active after a relaunch with the clock set to just above the persisted floor', async () => {
    await anchoredThenKilled(1);

    // Real time is now S + 10 days: the 7-day lease expired 3 days ago. The
    // user kills the app, sets the wall clock to one minute after the last
    // persisted high-water mark, and relaunches (no monotonic continuity).
    const relaunch: Clocks = { monotonicMs: 5, wallMs: S + DAY + MINUTE };
    const reading = await harness(relaunch).read();
    expect(reading.authority).toBe('floor');
    expect(reading.storage).toBe('loaded');
    // REQUIRED: the backwards jump (S+10d -> S+1d+1min) must not extend the
    // lease. Any verdict other than `active` satisfies the objective.
    expect(evaluateLease(lease, reading)).not.toMatchObject({ kind: 'active' });
  });

  it('the extension is repeatable indefinitely: every relaunch with the clock reset to the floor yields a fresh multi-day lease', async () => {
    await anchoredThenKilled(1);
    const grants: number[] = [];
    // Real time: S+10d, S+20d, S+30d. Each time the user resets the clock to
    // one minute past the floor and relaunches. The floor never advances in
    // `floor` authority (nothing re-persists without an anchor).
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const relaunch: Clocks = { monotonicMs: 5, wallMs: S + DAY + MINUTE };
      const verdict = evaluateLease(lease, await harness(relaunch).read());
      if (verdict.kind === 'active') grants.push(verdict.remainingMs);
      expect(storedRecord().highWaterMs).toBe(S + DAY);
    }
    // REQUIRED: zero cycles may grant time; a 7-day lease cannot be worth
    // 3 x ~6 days of Pro.
    expect(grants).toEqual([]);
  });
});

describe('ATTACK 2 — monotonic clock that does not cover the interval (device sleep, process alive)', () => {
  it('INFERRED iOS: performance.now() is mach_absolute_time (frozen while the device sleeps); a rollback to just above the under-counted estimate must still be refused', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });

    // 10 real days pass; the device was asleep for 9 of them, so the process
    // monotonic clock advanced only 1 day. No read() happened meanwhile (the
    // shipping app never calls read()).
    clocks.monotonicMs += DAY;
    clocks.wallMs += 10 * DAY;
    // The user now sets the wall clock BACK from S+10d to S+1d+1min.
    clocks.wallMs = S + DAY + MINUTE;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    // REQUIRED: the wall clock moved back ~9 days; the lease expired 3 days
    // ago. It must not be reported active.
    expect(evaluateLease(lease, reading)).not.toMatchObject({ kind: 'active' });
  });
});

describe('ATTACK 3 — the shipping app never advances the floor or evaluates a lease', () => {
  const srcRoot = path.join(__dirname, '..', 'src');
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
        ? [full]
        : [];
    });
  }
  const consumers = sourceFiles(srcRoot).filter(file => {
    if (file.endsWith(path.join('data', 'trustedTime.ts'))) return false;
    if (file.includes(`${path.sep}__tests__${path.sep}`)) return false;
    const text = fs.readFileSync(file, 'utf8');
    return /trustedTime\.(read|checkpoint)\(|evaluateLease\(/.test(text);
  });

  it('some shipping module must evaluate a lease against trusted time (otherwise the objective is a module nothing calls)', () => {
    // REQUIRED by the objective phrased as behaviour: "a backwards wall-clock
    // jump cannot extend a lease" needs a lease that is evaluated somewhere.
    expect(consumers.length).toBeGreaterThan(0);
  });

  it('checkpoint interval logic is reachable from app code (the floor otherwise equals the last server contact)', () => {
    const readers = sourceFiles(srcRoot).filter(file => {
      if (file.endsWith(path.join('data', 'trustedTime.ts'))) return false;
      return /trustedTime\.(read|checkpoint)\(/.test(
        fs.readFileSync(file, 'utf8'),
      );
    });
    expect(readers.length).toBeGreaterThan(0);
  });
});

describe('ATTACK 4 — backwards SERVER time re-anchors without any bound', () => {
  it('an authenticated Date behind the persisted high-water mark by days must not revive an expired lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += 8 * DAY;
    clocks.wallMs += 8 * DAY;
    const expired = await time.read();
    expect(evaluateLease(lease, expired)).toEqual({ kind: 'expired' });
    expect(storedRecord().highWaterMs).toBe(S + 8 * DAY);

    // A stale/replayed/mis-clocked but "authenticated" response says S+1h.
    const stale = await time.observeServerTime({
      dateHeader: serverHeader(S + HOUR),
      authenticated: true,
    });
    expect(stale.accepted).toBe(true);
    const reading = await time.read();
    // REQUIRED by the implementer's own claim ("nowMs never decreases") and
    // by the persisted floor: the clock must not move back ~8 days.
    expect(reading.nowMs).toBeGreaterThanOrEqual(
      S + 8 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
    );
    expect(evaluateLease(lease, reading)).not.toMatchObject({ kind: 'active' });
  });

  it('two in-flight authenticated responses processed out of order move the trusted clock backwards', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    // Response B (generated later) is processed first, then response A.
    await time.observeServerTime({
      dateHeader: serverHeader(S + 15_000),
      authenticated: true,
    });
    const before = (await time.read()).nowMs;
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    const after = (await time.read()).nowMs;
    // REQUIRED: a monotone trusted clock never steps backwards on the same
    // device without new evidence of a later time.
    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('ATTACK 5 — forward wall-clock jump poisons the persisted floor (fail-closed check)', () => {
  it('after an accidental forward jump and correction, the offline user is locked out until online (conservative, never an extension)', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs = S + 30 * DAY; // accidental forward jump
    const jumped = await time.read();
    expect(jumped.nowMs).toBe(S + 30 * DAY);
    expect(evaluateLease(lease, jumped)).toEqual({ kind: 'expired' });
    expect(storedRecord().highWaterMs).toBe(S + 30 * DAY);

    clocks.monotonicMs += HOUR;
    clocks.wallMs = S + 2 * HOUR; // corrected
    const corrected = await time.read();
    expect(corrected.rollbackDetected).toBe(true);
    expect(corrected.nowMs).toBe(S + 30 * DAY);
    expect(evaluateLease(lease, corrected)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    // Relaunch keeps the poisoned floor until a fresh authenticated anchor.
    const relaunch = harness({ monotonicMs: 1, wallMs: S + 3 * HOUR });
    expect(evaluateLease(lease, await relaunch.read()).kind).toBe(
      'reconcile_required',
    );
    await relaunch.observeServerTime({
      dateHeader: serverHeader(S + 3 * HOUR),
      authenticated: true,
    });
    expect(evaluateLease(lease, await relaunch.read())).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 3 * HOUR,
    });
    // Even a wall clock at the plausibility edge cannot escape the range guard.
    clocks.wallMs = Date.UTC(2100, 0, 1);
    clocks.monotonicMs += HOUR;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(S + 3 * HOUR);
  });
});

describe('ATTACK 6 — API wiring: only successful bearer responses may anchor', () => {
  type ApiModule = typeof import('../src/data/api');
  type TrustedTimeModule = typeof import('../src/data/trustedTime');
  interface Fresh {
    api: ApiModule['api'];
    trustedTime: TrustedTimeModule['trustedTime'];
    store: KeychainMock['__keychainStore'];
  }
  /** A fresh module graph so the app singleton starts un-anchored. */
  function fresh(): Fresh {
    let loaded: Fresh | null = null;
    jest.isolateModules(() => {
      const apiModule = jest.requireActual<ApiModule>('../src/data/api');
      const tt = jest.requireActual<TrustedTimeModule>(
        '../src/data/trustedTime',
      );
      const kc = jest.requireMock<KeychainMock>('react-native-keychain');
      loaded = {
        api: apiModule.api,
        trustedTime: tt.trustedTime,
        store: kc.__keychainStore,
      };
    });
    if (!loaded) throw new Error('modules did not load');
    return loaded;
  }
  function response(
    status: number,
    body: unknown,
    headers: Record<string, string>,
  ): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'status',
      json: async () => body,
      headers: new Headers(headers),
    } as unknown as Response;
  }
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
    jest.useRealTimers();
  });

  it('401 / 403 / 429 / 5xx responses carrying a Date never anchor, even with a bearer', async () => {
    const { api, trustedTime, store } = fresh();
    for (const status of [401, 403, 429, 500, 503]) {
      (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
        response(
          status,
          { error: { code: 'x', message: 'y' } },
          { date: serverHeader(S), 'retry-after': '1' },
        ),
      );
      await expect(
        api.request(
          { baseUrl: 'https://api.test', token: 'access-token' },
          'GET',
          '/v1/me/access',
        ),
      ).rejects.toMatchObject({ status });
    }
    const reading = await trustedTime.read();
    expect(reading.authority).toBe('none');
    expect(store.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('a response that arrives after the request timed out never anchors', async () => {
    jest.useFakeTimers();
    const { api, trustedTime, store } = fresh();
    let release: ((value: Response) => void) | null = null;
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          release = resolve;
        }),
    );
    const pending = api.request(
      { baseUrl: 'https://api.test', token: 'access-token' },
      'GET',
      '/v1/me/access',
    );
    const settled = pending.then(
      () => 'resolved',
      (error: { code?: string }) => error.code,
    );
    jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS + 1);
    await expect(settled).resolves.toBe('network.timeout');
    if (!release) throw new Error('fetch was not called');
    (release as (value: Response) => void)(
      response(200, { ok: true }, { date: serverHeader(S + 5 * DAY) }),
    );
    await Promise.resolve();
    await Promise.resolve();
    jest.useRealTimers();
    const reading = await trustedTime.read();
    expect(reading.authority).toBe('none');
    expect(store.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
  });

  it('a 2xx without a bearer never anchors, and a bogus Date on a 2xx with a bearer is rejected', async () => {
    const { api, trustedTime, store } = fresh();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      response(200, { ok: true }, { date: serverHeader(S) }),
    );
    await api.request(
      { baseUrl: 'https://api.test', token: null },
      'GET',
      '/v1/anonymous',
    );
    expect((await trustedTime.read()).authority).toBe('none');

    for (const date of ['', 'never', serverHeader(Date.UTC(2010, 0, 1))]) {
      (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
        response(200, { ok: true }, { date }),
      );
      await api.request(
        { baseUrl: 'https://api.test', token: 'access-token' },
        'GET',
        '/v1/me/access',
      );
    }
    expect((await trustedTime.read()).authority).toBe('none');
    expect(store.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
  });
});

describe('ATTACK 7 — corrupt, hostile or oversized persisted records', () => {
  const valid = {
    schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
    serverEpochMs: S,
    highWaterMs: S + DAY,
    wallOffsetMs: 0,
  };
  const hostile: [string, unknown][] = [
    ['string numbers', { ...valid, highWaterMs: String(S + DAY) }],
    ['negative server time', { ...valid, serverEpochMs: -S }],
    [
      'upper plausibility bound',
      { ...valid, highWaterMs: Date.UTC(2100, 0, 1) },
    ],
    ['fractional offset', { ...valid, wallOffsetMs: 1.5 }],
    ['null offset (NaN through JSON)', { ...valid, wallOffsetMs: null }],
    ['unsafe offset', { ...valid, wallOffsetMs: Number.MAX_SAFE_INTEGER + 2 }],
    ['__proto__ smuggling', `{"__proto__":${JSON.stringify(valid)}}`],
    ['nested', { record: valid }],
    ['boolean', 'true'],
    ['null', 'null'],
    ['empty', ''],
    ['oversized but valid JSON', { ...valid, pad: 'x'.repeat(600) }],
  ];

  it.each(hostile)(
    '%s is never authority and never destroyed',
    async (_name, record) => {
      seedRecord(record);
      const before = __keychainStore.get(
        TRUSTED_TIME_KEYCHAIN_SERVICE,
      )?.password;
      const reading = await harness({
        monotonicMs: 0,
        wallMs: S + 2 * DAY,
      }).read();
      expect(reading.authority).toBe('none');
      expect(reading.storage).toBe('invalid');
      expect(evaluateLease(lease, reading)).toEqual({
        kind: 'reconcile_required',
        reason: 'storage_invalid',
      });
      expect(__keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE)?.password).toBe(
        before,
      );
    },
  );

  it('a record with extra keys is loaded (forward compatible) but the floor still binds', async () => {
    seedRecord({ ...valid, future: 'field' });
    const reading = await harness({ monotonicMs: 0, wallMs: S }).read();
    expect(reading.authority).toBe('floor');
    expect(reading.rollbackDetected).toBe(true);
    expect(reading.nowMs).toBe(S + DAY);
  });

  it('a non-string password or foreign service from the Keychain is invalid', async () => {
    const weird: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: async () =>
        ({
          service: TRUSTED_TIME_KEYCHAIN_SERVICE,
          storage: 'x',
          username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
          password: 12345,
        }) as unknown as Awaited<
          ReturnType<TrustedTimeKeychain['getGenericPassword']>
        >,
      setGenericPassword: Keychain.setGenericPassword,
    };
    expect(
      (await harness({ monotonicMs: 0, wallMs: S }, weird).read()).storage,
    ).toBe('invalid');
    const foreign: TrustedTimeKeychain = {
      ...weird,
      getGenericPassword: async () =>
        ({
          service: 'com.picklesensei.session',
          storage: 'x',
          username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
          password: JSON.stringify(valid),
        }) as unknown as Awaited<
          ReturnType<TrustedTimeKeychain['getGenericPassword']>
        >,
    };
    expect(
      (await harness({ monotonicMs: 0, wallMs: S }, foreign).read()).storage,
    ).toBe('invalid');
  });
});

describe('ATTACK 8 — in-process wall-clock rollback boundaries', () => {
  it('rollback exactly at, and one millisecond beyond, the tolerance; recovery after restoring the clock', async () => {
    const clocks: Clocks = { monotonicMs: 100, wallMs: S + 250 };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += 2 * DAY;
    clocks.wallMs = S + 250 + 2 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS;
    const edge = await time.read();
    expect(edge.rollbackDetected).toBe(false);
    expect(edge.nowMs).toBe(S + 2 * DAY);
    expect(evaluateLease(lease, edge)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 2 * DAY,
    });

    clocks.wallMs -= 1;
    const over = await time.read();
    expect(over.rollbackDetected).toBe(true);
    expect(over.nowMs).toBe(S + 2 * DAY);
    expect(evaluateLease(lease, over).kind).toBe('reconcile_required');

    // Restoring the clock resumes at the monotonic truth, never earlier.
    clocks.monotonicMs += HOUR;
    clocks.wallMs = S + 250 + 2 * DAY + HOUR;
    const restored = await time.read();
    expect(restored.rollbackDetected).toBe(false);
    expect(restored.nowMs).toBe(S + 2 * DAY + HOUR);

    // A monotonic source that itself regresses is clamped, not trusted.
    clocks.monotonicMs -= 5 * DAY;
    const regressed = await time.read();
    expect(regressed.nowMs).toBeGreaterThanOrEqual(S + 2 * DAY + HOUR);
  });

  it('wall clock rolled back to 1970 or NaN never lowers the estimate', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += DAY;
    clocks.wallMs = 0;
    const epoch = await time.read();
    expect(epoch.nowMs).toBe(S + DAY);
    expect(epoch.rollbackDetected).toBe(true);
    clocks.wallMs = Number.NaN;
    const nan = await time.read();
    expect(nan.nowMs).toBe(S + DAY);
    expect(evaluateLease(lease, nan)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - DAY,
    });
  });
});

describe('ATTACK 9 — lease boundary values', () => {
  it('zero remaining is expired; issue-time cap and far-future expiry; hostile issuedAt values', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += LEASE_MAX_MS;
    clocks.wallMs += LEASE_MAX_MS;
    const reading = await time.read();
    expect(evaluateLease(lease, reading)).toEqual({ kind: 'expired' });
    expect(
      evaluateLease(
        { issuedAtMs: S, expiresAtMs: Number.MAX_SAFE_INTEGER },
        reading,
      ),
    ).toEqual({ kind: 'expired' });
    expect(
      evaluateLease({ issuedAtMs: 1, expiresAtMs: S + 30 * DAY }, reading),
    ).toEqual({ kind: 'expired' });
    for (const issuedAtMs of [0, -0, -1, Number.MIN_SAFE_INTEGER - 1]) {
      expect(
        evaluateLease({ issuedAtMs, expiresAtMs: S + 30 * DAY }, reading),
      ).toEqual({ kind: 'reconcile_required', reason: 'invalid_lease' });
    }
    expect(
      evaluateLease(
        { issuedAtMs: Date.UTC(2099, 0, 1), expiresAtMs: Date.UTC(2099, 0, 2) },
        reading,
      ),
    ).toEqual({ kind: 'reconcile_required', reason: 'lease_ahead_of_clock' });
  });
});

describe('ATTACK 10 — Date header leniency', () => {
  it('only an RFC 7231 IMF-fixdate is a server time; bare years, US dates and ISO strings are not HTTP dates', async () => {
    const time = harness({ monotonicMs: 0, wallMs: S });
    const rejected: string[] = [];
    for (const header of [
      '2026',
      '9/8/2026',
      '2026-09-08T12:00:00Z',
      'Sep 8 2026 12:00 GMT',
      `${serverHeader(S)}, ${serverHeader(S)}`,
    ]) {
      const result = await time.observeServerTime({
        dateHeader: header,
        authenticated: true,
      });
      if (!result.accepted) rejected.push(header);
    }
    // REQUIRED: none of these is an HTTP-date; accepting them widens the
    // surface through which a non-server value becomes the anchor.
    expect(rejected).toHaveLength(5);
  });
});

describe('ATTACK 11 — concurrency and a flaky Keychain', () => {
  it('a read issued right after an observation sees the anchor even when the Keychain write is slow', async () => {
    const slow: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: Keychain.getGenericPassword,
      setGenericPassword: async (...args) => {
        await new Promise(resolve => setTimeout(resolve, 30));
        return Keychain.setGenericPassword(...args);
      },
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks, slow);
    const observed = time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    const read = time.read();
    const [, reading] = await Promise.all([observed, read]);
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(S);
  });

  it('a Keychain write that throws leaves the queue usable and the old record intact', async () => {
    seedRecord({
      schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
      serverEpochMs: S - 10 * DAY,
      highWaterMs: S - 9 * DAY,
      wallOffsetMs: 0,
    });
    const writeFails: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: Keychain.getGenericPassword,
      setGenericPassword: async () => {
        throw new Error('errSecIO');
      },
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks, writeFails);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += DAY;
    clocks.wallMs += DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.storage).toBe('unavailable');
    expect(reading.nowMs).toBe(S + DAY);
    expect(storedRecord().highWaterMs).toBe(S - 9 * DAY);
    // Relaunch loads the OLD record: a floor 10 days behind, and the wall
    // clock is trusted forward from it.
    const relaunch = await harness({
      monotonicMs: 1,
      wallMs: S + DAY + 1,
    }).read();
    expect(relaunch.authority).toBe('floor');
    expect(relaunch.nowMs).toBe(S + DAY + 1);
  });

  it('a transient Keychain read failure must not let a stale floor outrank a fresh authenticated anchor', async () => {
    // Poisoned floor from a previous forward jump: highWater = S+30d.
    seedRecord({
      schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
      serverEpochMs: S - DAY,
      highWaterMs: S + 30 * DAY,
      wallOffsetMs: 0,
    });
    let readFailures = 1;
    let writeFailures = 1;
    const flaky: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: async options => {
        if (readFailures > 0) {
          readFailures -= 1;
          throw new Error('errSecInteractionNotAllowed');
        }
        return Keychain.getGenericPassword(options);
      },
      setGenericPassword: async (...args) => {
        if (writeFailures > 0) {
          writeFailures -= 1;
          throw new Error('errSecInteractionNotAllowed');
        }
        return Keychain.setGenericPassword(...args);
      },
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks, flaky);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    // REQUIRED for consistency with the candidate's own "server is the
    // authority" rule (its test re-anchors below the floor when the Keychain
    // works): the verdict must not depend on WHEN the Keychain was readable.
    expect(reading.nowMs).toBe(S + HOUR);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - HOUR,
    });
  });

  it('checkpoint cadence: the floor lags trusted time by at most the checkpoint interval while reads happen', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: S };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(S),
      authenticated: true,
    });
    for (let i = 0; i < 5; i += 1) {
      clocks.monotonicMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS / 2;
      clocks.wallMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS / 2;
      const reading = await time.read();
      const floor = storedRecord().highWaterMs as number;
      expect(reading.nowMs - floor).toBeLessThanOrEqual(
        TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
      );
    }
  });
});
