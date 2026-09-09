/**
 * W05-02 adversary (r4) — attacks against `src/data/trustedTime.ts` at
 * candidate 473ae596.
 *
 * Every `it` is one attack. A failing test is a reported break; a passing
 * test is an attack the candidate survived. The candidate's own tests and
 * production code are not modified.
 *
 * Adversary model: the device owner wants Pro beyond the 7-day offline lease.
 * They can set the wall clock, kill/relaunch the app, background it, and —
 * because the `Date` header is neither signed nor pinned (no ATS pinning in
 * the app, and iOS trusts a user-installed root CA for NSURLSession) — put a
 * TLS-terminating proxy of their own in front of the API and rewrite the
 * `Date` header of otherwise genuine, bearer-authenticated responses.
 */

import * as Keychain from 'react-native-keychain';
import { AppState, type AppStateStatus } from 'react-native';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';
import { api } from '../src/data/api';
import {
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  createTrustedTime,
  evaluateLease,
  trustedTime,
  type TrustedTimeKeychain,
  type TrustedTimeLease,
  type TrustedTimeLifecycle,
  type TrustedTimeReading,
  type TrustedTimeRequest,
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
/** Server time of the authenticated response that issued the lease. */
const T0 = Date.UTC(2026, 8, 8, 12, 0, 0);
const lease: TrustedTimeLease = {
  issuedAtMs: T0,
  expiresAtMs: T0 + LEASE_MAX_MS,
};

function header(ms: number): string {
  return new Date(ms).toUTCString();
}

interface Clocks {
  /** Process monotonic clock: frozen while the device sleeps. */
  monotonicMs: number;
  wallMs: number;
  /** Sleep-inclusive clock; absent in the shipping configuration. */
  continuousMs?: number | null;
}

function fakeLifecycle(initialState: AppStateStatus = 'active') {
  const listeners = new Set<(state: AppStateStatus) => void>();
  const lifecycle: TrustedTimeLifecycle = {
    currentState: initialState,
    addEventListener(type, listener) {
      expect(type).toBe('change');
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

/** Device awake: every clock advances. */
function awake(clocks: Clocks, ms: number): void {
  clocks.monotonicMs += ms;
  clocks.wallMs += ms;
  if (typeof clocks.continuousMs === 'number') clocks.continuousMs += ms;
}

/** Device asleep: the process clock is frozen. */
function asleep(clocks: Clocks, ms: number): void {
  clocks.wallMs += ms;
  if (typeof clocks.continuousMs === 'number') clocks.continuousMs += ms;
}

function storedRecord(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no trusted-time record persisted');
  return JSON.parse(item.password) as Record<string, unknown>;
}

function seedRecord(record: Record<string, unknown>): void {
  __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
    username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
    password: JSON.stringify(record),
    accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

function validRecord(
  overrides: Partial<{
    serverEpochMs: number;
    highWaterMs: number;
    wallOffsetMs: number;
  }> = {},
): Record<string, unknown> {
  return {
    schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
    serverEpochMs: T0,
    highWaterMs: T0,
    wallOffsetMs: 0,
    ...overrides,
  };
}

/** An honest, measured round trip: mark, one second of network, observe. */
async function honestResponse(
  time: ReturnType<typeof harness>,
  clocks: Clocks,
  serverMs: number,
) {
  const request = time.beginRequest();
  awake(clocks, SECOND);
  return time.observeServerTime({
    dateHeader: header(serverMs),
    authenticated: true,
    request,
  });
}

beforeEach(() => {
  __keychainStore.clear();
});

// ---------------------------------------------------------------------------
// ATTACK 1 — the Date header is the sole root of trust and is unsigned. A
// response whose Date lies BEHIND the module's own server-derived history is
// still accepted as `measured`, discards the floor and the high-water mark,
// and rewinds trusted time.
//
// VERDICT (1a, 1b FAIL on 473ae596): confirmed behaviour, classified P3.
// It needs a server (or a TLS-terminating proxy the owner installed a root
// CA for) to answer an authenticated request with a Date behind an earlier
// authenticated Date — outside the W05-02 objective ("a backwards WALL-CLOCK
// jump cannot extend a lease"), and an adversary who can rewrite response
// headers can rewrite the entitlement body too. Within one process the
// implementation already clamps such a response to the carried-forward
// anchor (`carriedMs`); across a relaunch the same server-derived knowledge
// (the persisted `serverEpochMs`) is discarded. That asymmetry is the
// finding. The flip side is deliberate and desirable: ATTACK 2b shows the
// relaunch path is the only recovery from a far-future poison.
// ---------------------------------------------------------------------------
describe('ATTACK 1 — a measured response with a Date behind server-derived history rewinds trusted time', () => {
  it('1a. relaunch: a Date behind the persisted server-derived anchor is accepted as measured, drops the floor and revives an expired lease', async () => {
    // A previous process received an honest measured response at T0 + 6d
    // and persisted it (serverEpochMs is server-derived, not wall-derived).
    const previous: Clocks = { monotonicMs: 0, wallMs: T0 };
    const earlier = harness(previous);
    await honestResponse(earlier, previous, T0);
    awake(previous, MINUTE);
    await earlier.checkpoint();
    // ... six days later, still honest, the same process re-anchors.
    asleep(previous, 6 * DAY);
    await honestResponse(earlier, previous, T0 + 6 * DAY + MINUTE);
    expect(storedRecord().serverEpochMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);

    // Relaunch. Before any response the floor proves a 5-day lease expired.
    const relaunch: Clocks = { monotonicMs: 0, wallMs: T0 + 6 * DAY + HOUR };
    const time = harness(relaunch);
    const fiveDay = { issuedAtMs: T0, expiresAtMs: T0 + 5 * DAY };
    expect(evaluateLease(fiveDay, await time.read()).kind).toBe('expired');

    // The first authenticated response after relaunch carries a Date of T0
    // (rewritten by the owner's proxy, or a server node six days behind).
    const observation = await honestResponse(time, relaunch, T0);
    expect(observation).toEqual({
      accepted: true,
      serverEpochMs: T0,
      measured: true,
    });
    awake(relaunch, SECOND);
    const after = await time.read();

    // The module already knew, from a server, that now >= T0 + 6d. A later
    // server time BEHIND that is at most a lower bound (exactly what the
    // in-process path does with `carriedMs`) — it must not rewind the
    // estimate below the persisted server-derived anchor nor revive a lease
    // the floor had already proven expired.
    expect(after.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().serverEpochMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(fiveDay, after).kind).not.toBe('active');
  });

  it('1b. in-process: after a six-day sleep the foreground checkpoint knows now >= T0 + 6d, yet one measured response dated T0 clears it and revives the 7-day lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle();
    const time = harness(clocks, app.lifecycle);
    await honestResponse(time, clocks, T0);
    awake(clocks, MINUTE);

    // Honest device, honest wall clock: the app sleeps six days.
    await app.transition('inactive');
    await app.transition('background');
    asleep(clocks, 6 * DAY);
    await app.transition('active');
    awake(clocks, SECOND);
    const resumed = await time.read();
    expect(resumed.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(lease, resumed).kind).not.toBe('active');

    // One response, marked and answered in the foreground, dated T0 + 2m.
    const observation = await honestResponse(time, clocks, T0 + 2 * MINUTE);
    expect(observation).toMatchObject({ accepted: true, measured: true });
    awake(clocks, SECOND);
    const after = await time.read();

    // Six days of persisted high-water mark are gone and the lease is back.
    expect(after.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 6 * DAY);
    expect(evaluateLease(lease, after).kind).not.toBe('active');
  });

  it('1c. control: with an honest Date the same relaunch re-anchors forward and the expired lease stays expired', async () => {
    seedRecord(
      validRecord({ serverEpochMs: T0 + 6 * DAY, highWaterMs: T0 + 6 * DAY }),
    );
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + 6 * DAY + HOUR };
    const time = harness(clocks);
    await honestResponse(time, clocks, T0 + 6 * DAY + HOUR);
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0 + 6 * DAY + HOUR);
    expect(
      evaluateLease({ issuedAtMs: T0, expiresAtMs: T0 + 5 * DAY }, reading),
    ).toEqual({
      kind: 'expired',
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 2 — a single far-future Date (anything before 2100 is "plausible")
// poisons the process: every later honest response is "behind the carried
// anchor" and can never bring trusted time back until relaunch.
//
// VERDICT (2a FAILS, 2b passes on 473ae596): confirmed, classified P3.
// Fail-closed (the lease is reported expired, never extended), requires a
// server Date a year ahead, and a relaunch recovers (2b). Availability only.
// ---------------------------------------------------------------------------
describe('ATTACK 2 — one far-future Date header permanently expires every lease', () => {
  it('2a. a Date one year ahead is accepted; honest responses afterwards cannot recover, and the poison survives relaunch', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await honestResponse(time, clocks, T0);
    expect(evaluateLease(lease, await time.read()).kind).toBe('active');

    // One response — a misconfigured edge node, or a hostile proxy — dated a
    // year ahead. Plausibility accepts anything up to 2100.
    const poison = await honestResponse(time, clocks, T0 + 365 * DAY);
    expect(poison).toMatchObject({ accepted: true, measured: true });
    expect(evaluateLease(lease, await time.read()).kind).toBe('expired');

    // Ten honest responses over the next ten minutes, all dated correctly.
    for (let i = 1; i <= 10; i += 1) {
      awake(clocks, MINUTE);
      await honestResponse(time, clocks, clocks.wallMs);
    }
    const recovered = await time.read();
    // Ten consecutive authenticated servers agreeing on a time a year behind
    // the anchor are stronger evidence than the one outlier; a trusted clock
    // needs SOME recovery path or the device's Pro leases are dead forever.
    expect(recovered.nowMs).toBeLessThan(T0 + 30 * DAY);
    expect(evaluateLease(lease, recovered).kind).toBe('active');
  });

  it('2b. the poison is persisted and outlives the process: a relaunch with honest server time stays expired', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await honestResponse(time, clocks, T0 + 365 * DAY);
    expect(storedRecord().highWaterMs).toBeGreaterThanOrEqual(T0 + 365 * DAY);

    const relaunch: Clocks = { monotonicMs: 0, wallMs: T0 + HOUR };
    const fresh = harness(relaunch);
    await honestResponse(fresh, relaunch, T0 + HOUR);
    const reading = await fresh.read();
    // This one PASSES on the candidate: a measured response after relaunch
    // discards the floor — which is precisely the behaviour ATTACK 1a
    // exploits in the other direction. The two attacks together show the
    // floor is either too weak (1a) or too strong (2a) depending on which
    // process the outlier lands in.
    expect(reading.authority).toBe('anchored');
    expect(evaluateLease(lease, reading).kind).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 3 — a sleep-inclusive clock that is wired but broken (returns a
// constant) is trusted as having "measured" every interval: a rollback
// during sleep becomes invisible.
//
// VERDICT (3a FAILS, 3b passes on 473ae596): confirmed, classified P3.
// Nothing in the shipping app supplies `continuousNowMs` (grep: the only
// references are inside trustedTime.ts), so the path is latent. If a native
// sleep-inclusive clock is ever wired, `elapsedOn` must reject a continuous
// clock that advanced LESS than the process clock over the same interval.
// ---------------------------------------------------------------------------
describe('ATTACK 3 — a stuck sleep-inclusive clock launders a rollback during sleep', () => {
  it('3a. continuous clock frozen at a constant while the process clock advances: the lease is reported active after a six-day sleep and rollback', async () => {
    const clocks: Clocks = {
      monotonicMs: 0,
      wallMs: T0,
      continuousMs: 500_000,
    };
    const app = fakeLifecycle();
    const time = harness(clocks, app.lifecycle);
    await honestResponse(time, clocks, T0);
    // From here the bridge answers the same value forever.
    const stuck = clocks.continuousMs as number;
    awake(clocks, MINUTE);
    clocks.continuousMs = stuck;

    await app.transition('inactive');
    await app.transition('background');
    asleep(clocks, 6 * DAY);
    clocks.continuousMs = stuck;
    // The owner winds the wall clock back to a minute after the anchor.
    clocks.wallMs = T0 + MINUTE + SECOND;
    await app.transition('active');
    awake(clocks, SECOND);
    clocks.continuousMs = stuck;

    const reading = await time.read();
    // A continuous clock that reports zero elapsed while the process clock
    // reports a minute has not measured anything; the interval is
    // unmeasured and the lease must require reconciliation, as it does in
    // the shipping configuration without a continuous clock.
    expect(reading.authority).not.toBe('anchored');
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });

  it('3b. control: without the continuous clock the same sequence is caught', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle();
    const time = harness(clocks, app.lifecycle);
    await honestResponse(time, clocks, T0);
    awake(clocks, MINUTE);
    await app.transition('inactive');
    await app.transition('background');
    asleep(clocks, 6 * DAY);
    clocks.wallMs = T0 + MINUTE + SECOND;
    await app.transition('active');
    awake(clocks, SECOND);
    const reading = await time.read();
    expect(reading.authority).not.toBe('anchored');
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 4 — randomized model check with an HONEST server: the owner may set
// the wall clock to anything at any time, background/sleep/relaunch at will;
// the server's Date is always the truth at the moment it answered. Safety:
// `active` is never reported with more remaining time than truly remains
// (plus the largest round trip), and trusted now never runs behind the truth
// by more than a round trip while `anchored`.
// ---------------------------------------------------------------------------
describe('ATTACK 4 — randomized honest-server model: the owner controls the wall clock and the lifecycle', () => {
  function rng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const MAX_RTT = 30 * SECOND;

  interface World {
    trueMs: number;
    clocks: Clocks;
    app: ReturnType<typeof fakeLifecycle>;
    time: ReturnType<typeof harness>;
    foreground: boolean;
    inFlight: { request: TrustedTimeRequest; serverMs: number } | null;
    trace: string[];
  }

  function checkSafety(world: World, reading: TrustedTimeReading): void {
    const verdict = evaluateLease(lease, reading);
    const trulyRemaining = lease.expiresAtMs - world.trueMs;
    if (verdict.kind === 'active') {
      if (verdict.remainingMs > trulyRemaining + MAX_RTT + SECOND) {
        throw new Error(
          `lease extended by ${verdict.remainingMs - trulyRemaining}ms\n${world.trace.join('\n')}`,
        );
      }
    }
    if (reading.authority === 'anchored') {
      if (reading.nowMs < world.trueMs - MAX_RTT - SECOND) {
        throw new Error(
          `anchored now ${world.trueMs - reading.nowMs}ms behind truth\n${world.trace.join('\n')}`,
        );
      }
    }
  }

  async function step(world: World, random: () => number): Promise<void> {
    const roll = random();
    const { clocks } = world;
    if (roll < 0.25) {
      const ms = Math.floor(random() * 2 * HOUR);
      world.trueMs += ms;
      awake(clocks, ms);
      world.trace.push(`awake ${ms}`);
    } else if (roll < 0.35) {
      if (world.foreground) {
        await world.app.transition('inactive');
        await world.app.transition('background');
        world.foreground = false;
        world.trace.push('background');
      } else {
        await world.app.transition('active');
        world.foreground = true;
        world.trace.push('active');
      }
    } else if (roll < 0.45) {
      if (!world.foreground) {
        const ms = Math.floor(random() * 3 * DAY);
        world.trueMs += ms;
        asleep(clocks, ms);
        world.trace.push(`sleep ${ms}`);
      }
    } else if (roll < 0.6) {
      // The owner sets the wall clock anywhere within ±30 days of the truth.
      clocks.wallMs = world.trueMs + Math.floor((random() - 0.5) * 60 * DAY);
      world.trace.push(`wall := truth ${clocks.wallMs - world.trueMs}`);
    } else if (roll < 0.75) {
      // Send a request; the server stamps the truth when it answers, which
      // may be delivered later (possibly after a suspension).
      if (!world.inFlight) {
        const request = world.time.beginRequest();
        const network = Math.floor(random() * MAX_RTT);
        world.trueMs += network;
        awake(clocks, network);
        world.inFlight = { request, serverMs: world.trueMs };
        world.trace.push(`send (server will stamp ${world.trueMs - T0})`);
      }
    } else if (roll < 0.9) {
      if (world.inFlight) {
        const { request, serverMs } = world.inFlight;
        world.inFlight = null;
        await world.time.observeServerTime({
          dateHeader: header(serverMs),
          authenticated: true,
          request,
        });
        world.trace.push(`receive ${serverMs - T0}`);
      }
    } else {
      // Relaunch: the process clock restarts, the Keychain survives.
      const app = fakeLifecycle();
      clocks.monotonicMs = Math.floor(random() * 1000);
      world.app = app;
      world.time = harness(clocks, app.lifecycle);
      world.foreground = true;
      world.inFlight = null;
      world.trace.push('relaunch');
    }
    checkSafety(world, await world.time.read());
  }

  it('4a. 400 random worlds × 40 steps never extend a lease nor let anchored time lag the truth', async () => {
    for (let seed = 1; seed <= 400; seed += 1) {
      __keychainStore.clear();
      const random = rng(seed);
      const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
      const app = fakeLifecycle();
      const world: World = {
        trueMs: T0,
        clocks,
        app,
        time: harness(clocks, app.lifecycle),
        foreground: true,
        inFlight: null,
        trace: [`seed ${seed}`],
      };
      // The lease is issued by an honest response at T0.
      await honestResponse(world.time, clocks, T0);
      world.trueMs += SECOND;
      for (let i = 0; i < 40; i += 1) await step(world, random);
    }
  });
});

// ---------------------------------------------------------------------------
// ATTACK 5 — hung Keychain: reads must stay bounded, and never authorize.
// ---------------------------------------------------------------------------
describe('ATTACK 5 — hung Keychain', () => {
  const hung: TrustedTimeKeychain = {
    ACCESSIBLE: Keychain.ACCESSIBLE,
    getGenericPassword: () => new Promise(() => {}),
    setGenericPassword: () => new Promise(() => {}),
  };

  it('5a. a burst of ten measured responses then a read costs one timeout, not eleven, and reports storage unavailable', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks, fakeLifecycle().lifecycle, hung);
    const started = Date.now();
    for (let i = 0; i < 10; i += 1) {
      void honestResponse(time, clocks, T0 + i * SECOND);
    }
    const reading = await time.read();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS);
    expect(reading.storage).toBe('unavailable');
    expect(reading.authority).toBe('anchored');
    expect(evaluateLease(lease, reading).kind).toBe('active');
  });

  it('5b. with nothing but a hung Keychain and a persisted-looking wall clock, nothing is authorized', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + HOUR };
    const time = harness(clocks, fakeLifecycle().lifecycle, hung);
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(reading.storage).toBe('unavailable');
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'no_trusted_time',
    });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 6 — reentrancy: the observation is queued behind a slow Keychain
// while the app is suspended, the device sleeps and the clock is wound back.
// ---------------------------------------------------------------------------
describe('ATTACK 6 — suspension between observeServerTime() being called and executed', () => {
  it('6a. the queued measured observation must not report a measured anchor after the sleep it did not see', async () => {
    let releaseRead: (() => void) | null = null;
    const slow: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: () =>
        new Promise(resolve => {
          releaseRead = () => resolve(false);
        }),
      setGenericPassword: Keychain.setGenericPassword,
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle();
    const time = harness(clocks, app.lifecycle, slow);

    const request = time.beginRequest();
    awake(clocks, SECOND);
    const pending = time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
      request,
    });
    // Hydration is waiting on the Keychain; meanwhile the app is suspended,
    // sleeps six days and the owner winds the clock back.
    await app.transition('inactive');
    await app.transition('background');
    asleep(clocks, 6 * DAY);
    clocks.wallMs = T0 + 2 * SECOND;
    await app.transition('active');
    awake(clocks, SECOND);
    expect(releaseRead).not.toBeNull();
    (releaseRead as unknown as () => void)();
    await pending;

    const reading = await time.read();
    expect(reading.authority).not.toBe('anchored');
    expect(evaluateLease(lease, reading).kind).not.toBe('active');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 7 — request-mark replay: a mark is never consumed.
// ---------------------------------------------------------------------------
describe('ATTACK 7 — request mark replay', () => {
  it('7a. reusing one mark for a later, older-dated response can only push the anchor forward', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const request = time.beginRequest();
    awake(clocks, SECOND);
    await time.observeServerTime({
      dateHeader: header(T0 + HOUR),
      authenticated: true,
      request,
    });
    awake(clocks, HOUR);
    const replay = await time.observeServerTime({
      dateHeader: header(T0),
      authenticated: true,
      request,
    });
    expect(replay).toMatchObject({ accepted: true });
    const reading = await time.read();
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0 + 2 * HOUR + SECOND);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 2 * HOUR - SECOND,
    });
  });

  it('7b. two in-flight requests answered out of order: the older Date arriving second cannot rewind', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    const first = time.beginRequest();
    awake(clocks, SECOND);
    const second = time.beginRequest();
    awake(clocks, SECOND);
    // The second request is answered first, stamped T0 + 2s.
    await time.observeServerTime({
      dateHeader: header(T0 + 2 * SECOND),
      authenticated: true,
      request: second,
    });
    awake(clocks, SECOND);
    // The first request's response, stamped T0 + 1s, lands a second later.
    await time.observeServerTime({
      dateHeader: header(T0 + SECOND),
      authenticated: true,
      request: first,
    });
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0 + 3 * SECOND);
  });

  it('7c. a request marked in the background (background fetch) and answered after resume is never measured evidence', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const app = fakeLifecycle();
    const time = harness(clocks, app.lifecycle);
    await honestResponse(time, clocks, T0);
    await app.transition('inactive');
    await app.transition('background');
    const request = time.beginRequest();
    asleep(clocks, 6 * DAY);
    clocks.wallMs = T0 + 10 * SECOND;
    await app.transition('active');
    awake(clocks, SECOND);
    const observation = await time.observeServerTime({
      dateHeader: header(T0 + 5 * SECOND),
      authenticated: true,
      request,
    });
    expect(observation).toMatchObject({ accepted: true, measured: false });
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(evaluateLease(lease, reading).kind).toBe('reconcile_required');
  });
});

// ---------------------------------------------------------------------------
// ATTACK 8 — boundary values in persisted records and clocks.
// ---------------------------------------------------------------------------
describe('ATTACK 8 — boundary values', () => {
  it('8a. extreme but well-formed persisted records never authorize and never crash', async () => {
    const MAX_SAFE = Number.MAX_SAFE_INTEGER;
    const records = [
      validRecord({
        serverEpochMs: Date.UTC(2025, 0, 1),
        highWaterMs: Date.UTC(2100, 0, 1) - 1,
      }),
      validRecord({ wallOffsetMs: MAX_SAFE }),
      validRecord({ wallOffsetMs: -MAX_SAFE }),
      validRecord({ highWaterMs: T0 + LEASE_MAX_MS - 1 }),
    ];
    for (const record of records) {
      seedRecord(record);
      const clocks: Clocks = { monotonicMs: 0, wallMs: T0 + MINUTE };
      const time = harness(clocks);
      const reading = await time.read();
      expect(Number.isFinite(reading.nowMs)).toBe(true);
      expect(reading.authority).toBe('floor');
      expect(evaluateLease(lease, reading).kind).not.toBe('active');
      await expect(time.checkpoint()).resolves.toBeUndefined();
    }
  });

  it('8e. a well-formed record stored under the right service but another account name is not a floor', async () => {
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: 'session-vault',
      password: JSON.stringify(validRecord({ highWaterMs: T0 + 8 * DAY })),
    });
    const reading = await harness({
      monotonicMs: 0,
      wallMs: T0 + MINUTE,
    }).read();
    expect(reading.storage).toBe('invalid');
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'storage_invalid',
    });
  });

  it('8f. in-process wall clock wound forward then back: the ratchet keeps the forward time and flags the rollback', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await honestResponse(time, clocks, T0);
    clocks.wallMs = T0 + 10 * DAY;
    const forward = await time.read();
    expect(forward.nowMs).toBeGreaterThanOrEqual(T0 + 10 * DAY);
    expect(evaluateLease(lease, forward)).toEqual({ kind: 'expired' });
    clocks.wallMs = T0 + 2 * SECOND;
    const back = await time.read();
    expect(back.nowMs).toBeGreaterThanOrEqual(T0 + 10 * DAY);
    expect(back.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, back).kind).not.toBe('active');
  });

  it('8b. a record at exactly the size cap is read; one byte over is invalid', async () => {
    const base = validRecord();
    const pad = (target: number) => {
      const bare = JSON.stringify(base);
      const filler = 'x'.repeat(
        Math.max(0, target - bare.length - '"pad":"",'.length),
      );
      return JSON.stringify({ pad: filler, ...base });
    };
    for (const [length, storage] of [
      [512, 'loaded'],
      [513, 'invalid'],
    ] as const) {
      const password = pad(length);
      expect(password.length).toBe(length);
      __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
        username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
        password,
      });
      const reading = await harness({
        monotonicMs: 0,
        wallMs: T0 + MINUTE,
      }).read();
      expect(reading.storage).toBe(storage);
      expect(evaluateLease(lease, reading).kind).not.toBe('active');
    }
  });

  it('8c. NaN / Infinity / negative wall clocks and a throwing monotonic clock never crash and never authorize without a server', async () => {
    for (const wallMs of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
    ]) {
      const time = createTrustedTime({
        keychain: Keychain,
        monotonicNowMs: () => {
          throw new Error('no clock');
        },
        wallClockNowMs: () => wallMs,
        lifecycle: fakeLifecycle().lifecycle,
      });
      const reading = await time.read();
      expect(Number.isFinite(reading.nowMs)).toBe(true);
      expect(evaluateLease(lease, reading).kind).toBe('reconcile_required');
      await honestResponse(time, { monotonicMs: 0, wallMs }, T0);
      const after = await time.read();
      expect(Number.isFinite(after.nowMs)).toBe(true);
      // Without a working monotonic clock nothing is measured.
      expect(evaluateLease(lease, after).kind).not.toBe('active');
    }
  });

  it('8d. lease boundaries: issued TOL ahead accepted, TOL+1 rejected; a 1ms lease; max-length lease at the last millisecond', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: T0 };
    const time = harness(clocks);
    await honestResponse(time, clocks, T0);
    const reading = await time.read();
    expect(reading.nowMs).toBe(T0 + SECOND);
    expect(
      evaluateLease(
        {
          issuedAtMs: reading.nowMs + TOL,
          expiresAtMs: reading.nowMs + TOL + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: TOL + DAY });
    expect(
      evaluateLease(
        {
          issuedAtMs: reading.nowMs + TOL + 1,
          expiresAtMs: reading.nowMs + TOL + 1 + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'reconcile_required', reason: 'lease_ahead_of_clock' });
    expect(
      evaluateLease(
        { issuedAtMs: reading.nowMs, expiresAtMs: reading.nowMs + 1 },
        reading,
      ),
    ).toEqual({
      kind: 'active',
      remainingMs: 1,
    });
    expect(
      evaluateLease(
        {
          issuedAtMs: reading.nowMs - LEASE_MAX_MS,
          expiresAtMs: reading.nowMs + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'expired' });
    expect(
      evaluateLease(
        {
          issuedAtMs: reading.nowMs - LEASE_MAX_MS + 1,
          expiresAtMs: reading.nowMs + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: 1 });
  });
});

// ---------------------------------------------------------------------------
// ATTACK 9 — api.ts wiring at network failure boundaries.
// ---------------------------------------------------------------------------
describe('ATTACK 9 — api.ts feeds trusted time only from successful authenticated JSON responses', () => {
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

  it('9a. 429 + Retry-After, 500, 503 and a 200 array body with a valid Date never feed the clock', async () => {
    (AppState as { currentState: AppStateStatus }).currentState = 'active';
    expect((await trustedTime.read()).authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
    const cases: Array<[number, unknown, Record<string, string>]> = [
      [
        429,
        { error: { code: 'rate_limited', message: 'slow down' } },
        { date: header(T0), 'retry-after': '30' },
      ],
      [
        500,
        { error: { code: 'internal', message: 'boom' } },
        { date: header(T0) },
      ],
      [503, {}, { date: header(T0) }],
      [200, [1, 2, 3], { date: header(T0) }],
    ];
    for (const [status, body, headers] of cases) {
      (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
        response(status, body, headers),
      );
      await expect(
        api.request(
          { baseUrl: 'https://api.test', token: 'access-token' },
          'GET',
          '/v1/me/access',
        ),
      ).rejects.toBeDefined();
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const reading = await trustedTime.read();
      expect(reading.authority).toBe('none');
      expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);
    }
  });

  it('9b. a 200 object body with a Date behind the wall clock feeds the shared clock as measured', async () => {
    (AppState as { currentState: AppStateStatus }).currentState = 'active';
    (globalThis as { fetch?: unknown }).fetch = jest.fn(async () =>
      response(200, { ok: true }, { date: header(T0) }),
    );
    await api.request(
      { baseUrl: 'https://api.test', token: 'access-token' },
      'GET',
      '/v1/me/access',
    );
    const reading = await trustedTime.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.continuity).toBe('measured');
    expect(reading.nowMs).toBeGreaterThanOrEqual(T0);
    expect(reading.nowMs).toBeLessThan(T0 + MINUTE);
    expect(storedRecord().serverEpochMs).toBeGreaterThanOrEqual(T0);
  });
});
