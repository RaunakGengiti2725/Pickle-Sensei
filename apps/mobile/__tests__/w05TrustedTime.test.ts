/**
 * W05-02 — trusted time for offline lease expiry.
 *
 * Pins the behaviour of `src/data/trustedTime.ts`:
 *  - server time is taken ONLY from authenticated API responses and anchored
 *    to the monotonic clock; a backwards wall-clock jump never extends a
 *    lease (the monotonic path keeps counting and the jump is reported so the
 *    caller requires online reconciliation);
 *  - the anchor / high-water mark persists in a distinct THIS_DEVICE_ONLY
 *    Keychain service (never the session vault) so a relaunch with no
 *    monotonic continuity still has a floor below which "now" cannot fall;
 *  - after a relaunch that floor is only a LOWER bound: every reading is
 *    pinned to the monotonic clock and checkpointed, a wall clock that then
 *    reads lower is a rollback, and `floor` authority can prove a lease
 *    expired but never report it active — a device whose clock was wound
 *    back while the app was not running cannot revive an expired lease, no
 *    matter how many times it relaunches;
 *  - corrupt, missing or unavailable storage never becomes authorization —
 *    lease evaluation reports that reconciliation is required;
 *  - Pro leases are capped at OFFLINE_PRO_LEASE_MAX_SECONDS;
 *  - the process monotonic clock stops while the device sleeps, and a device
 *    only sleeps once the app is in the background: an anchor is `measured`
 *    (authority `anchored`) only while the app has stayed in the foreground
 *    since it was taken, or while a sleep-inclusive clock is available. Once
 *    the app has been backgrounded the elapsed time is a lower bound, so a
 *    wall clock wound back WHILE the app was suspended — where the frozen
 *    process clock cannot tell six sleeping days from one awake minute — is
 *    never mistaken for continuity: the lease requires reconciliation;
 *  - `src/data/api.ts` feeds every authenticated `Date` header into the module,
 *    and from then on every return to the foreground checkpoints the high-
 *    water mark, so a wall clock seen ahead while the app was open is held
 *    against a later rollback even though the monotonic clock slept.
 */

import { AppState, type AppStateStatus } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { api, createAnalysisPermitClient } from '../src/data/api';
import {
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  createTrustedTime,
  evaluateLease,
  responseDateHeader,
  trustedTime,
  type TrustedTimeKeychain,
  type TrustedTimeLifecycle,
} from '../src/data/trustedTime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LEASE_MAX_MS = OFFLINE_PRO_LEASE_MAX_SECONDS * 1000;
/** Server time on the authenticated response that issued the lease. */
const SERVER_MS = Date.UTC(2026, 8, 8, 12, 0, 0);

function serverHeader(ms: number): string {
  return new Date(ms).toUTCString();
}

interface Clocks {
  /** The process monotonic clock: frozen while the device sleeps. */
  monotonicMs: number;
  wallMs: number;
  /**
   * A sleep-inclusive monotonic clock (a native continuous clock); absent
   * when the app has no such source, `null` when the bridge answers nothing.
   */
  continuousMs?: number | null;
}

/**
 * By default the clock under test sees an app that is in the foreground and
 * never leaves it; suites about suspension pass their own lifecycle.
 */
function harness(
  clocks: Clocks,
  keychain: TrustedTimeKeychain = Keychain,
  lifecycle: TrustedTimeLifecycle | null = fakeLifecycle().lifecycle,
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

/** A fake `AppState`: records subscriptions and delivers transitions. */
function fakeLifecycle(initialState: AppStateStatus = 'active') {
  const listeners = new Set<(state: AppStateStatus) => void>();
  let subscriptions = 0;
  const lifecycle: TrustedTimeLifecycle = {
    currentState: initialState,
    addEventListener(type, listener) {
      expect(type).toBe('change');
      subscriptions += 1;
      listeners.add(listener);
      return { remove: () => listeners.delete(listener) };
    },
  };
  return {
    lifecycle,
    get subscriptions() {
      return subscriptions;
    },
    async transition(state: AppStateStatus): Promise<void> {
      // Like RN's AppState, `currentState` is updated before listeners run.
      (lifecycle as { currentState: AppStateStatus }).currentState = state;
      for (const listener of [...listeners]) listener(state);
      // The listener fires and forgets a checkpoint; let it settle.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    },
  };
}

function storedRecord(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no trusted-time record persisted');
  return JSON.parse(item.password) as Record<string, unknown>;
}

const lease = { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + LEASE_MAX_MS };

beforeEach(() => {
  __keychainStore.clear();
});

describe('W05-02 trusted time — anchored on an authenticated server response', () => {
  it('counts lease time on the monotonic clock and persists the anchor', async () => {
    const clocks: Clocks = { monotonicMs: 1_000, wallMs: SERVER_MS + 2_000 };
    const time = harness(clocks);

    const observation = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(observation).toEqual({ accepted: true, serverEpochMs: SERVER_MS });

    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs += 3 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(reading.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 3 * DAY,
    });

    const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
    expect(item?.username).toBe(TRUSTED_TIME_KEYCHAIN_ACCOUNT);
    expect(item?.accessible).toBe(
      Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    );
    expect(TRUSTED_TIME_KEYCHAIN_SERVICE).not.toBe(SESSION_VAULT_SERVICE);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    const record = storedRecord();
    expect(record.schemaVersion).toBe(TRUSTED_TIME_ANCHOR_SCHEMA_VERSION);
    expect(record.serverEpochMs).toBe(SERVER_MS);
    expect(Object.keys(record).sort()).toEqual([
      'highWaterMs',
      'schemaVersion',
      'serverEpochMs',
      'wallOffsetMs',
    ]);
  });

  it('a backwards wall-clock jump cannot extend the lease', async () => {
    const clocks: Clocks = { monotonicMs: 50_000, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs = SERVER_MS - 10 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(reading.wallClockMs).toBe(SERVER_MS - 10 * DAY);
    expect(reading.rollbackDetected).toBe(true);

    const verdict = evaluateLease(lease, reading);
    expect(verdict).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    // Whatever the caller does with the verdict, no remaining time beyond the
    // monotonic truth is ever reported.
    expect(verdict.kind).not.toBe('active');
  });

  it('a forward wall-clock jump only shortens the lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    clocks.monotonicMs += 1 * DAY;
    clocks.wallMs = SERVER_MS + 10 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 10 * DAY);
    expect(reading.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reading)).toEqual({ kind: 'expired' });
  });

  it('an authenticated server time behind the monotonic extrapolation never moves the trusted clock backwards', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += 2 * HOUR;
    clocks.wallMs += 2 * HOUR;
    expect((await time.read()).nowMs).toBe(SERVER_MS + 2 * HOUR);

    // The earlier anchor carried forward on the monotonic clock is as
    // trustworthy as a new observation: responses processed out of order (or
    // a server behind the one that anchored) are accepted but never shorten
    // what has elapsed.
    const behind = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + HOUR),
      authenticated: true,
    });
    expect(behind).toEqual({ accepted: true, serverEpochMs: SERVER_MS + HOUR });
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 2 * HOUR);
    expect(reading.rollbackDetected).toBe(false);
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + 2 * HOUR);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 2 * HOUR);

    // The device wall clock, by contrast, is never an authority: winding it
    // back after the re-anchor changes nothing but the rollback flag.
    clocks.monotonicMs += HOUR;
    clocks.wallMs = SERVER_MS - DAY;
    const later = await time.read();
    expect(later.nowMs).toBe(SERVER_MS + 3 * HOUR);
    expect(later.rollbackDetected).toBe(true);

    // A server time AHEAD of the extrapolation re-anchors forward and clears
    // the rollback once the wall clock is consistent with it again.
    clocks.wallMs = SERVER_MS + 5 * HOUR;
    const ahead = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 5 * HOUR),
      authenticated: true,
    });
    expect(ahead).toEqual({
      accepted: true,
      serverEpochMs: SERVER_MS + 5 * HOUR,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    const forward = await time.read();
    expect(forward.nowMs).toBe(SERVER_MS + 6 * HOUR);
    expect(forward.rollbackDetected).toBe(false);
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + 5 * HOUR);
  });

  it('a wall clock corrected after a forward jump is a rollback until the server re-anchors', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs = SERVER_MS + 30 * DAY;
    const jumped = await time.read();
    expect(jumped.nowMs).toBe(SERVER_MS + 30 * DAY);
    expect(evaluateLease(lease, jumped)).toEqual({ kind: 'expired' });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 30 * DAY);

    // Once reported, a time is pinned to the monotonic clock: the corrected
    // wall clock reads lower than the estimate and is a rollback, never a
    // way back to an active lease.
    clocks.monotonicMs += HOUR;
    clocks.wallMs = SERVER_MS + 2 * HOUR;
    const corrected = await time.read();
    expect(corrected.nowMs).toBe(SERVER_MS + 30 * DAY + HOUR);
    expect(corrected.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, corrected)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    // Only the authenticated server can lower the estimate again.
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 2 * HOUR),
      authenticated: true,
    });
    const reanchored = await time.read();
    expect(reanchored.nowMs).toBe(SERVER_MS + 2 * HOUR);
    expect(reanchored.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reanchored)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 2 * HOUR,
    });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 2 * HOUR);
  });

  it('checkpoints the high-water mark while the process lives', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    clocks.monotonicMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS - 1;
    clocks.wallMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS - 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    clocks.monotonicMs += 1;
    clocks.wallMs += 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(
      SERVER_MS + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
    );

    clocks.monotonicMs += 2 * DAY;
    clocks.wallMs += 2 * DAY;
    await time.checkpoint();
    expect(storedRecord().highWaterMs).toBe(
      SERVER_MS + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + 2 * DAY,
    );
  });

  it('checkpoints on every return to the foreground once the clock is in use, subscribing exactly once', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    // Creating the clock has no side effect; using it arms the hook.
    expect(app.subscriptions).toBe(0);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(app.subscriptions).toBe(1);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    // Background and inactive transitions do not checkpoint.
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    await app.transition('background');
    await app.transition('inactive');
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    // Coming back to the foreground persists the high-water mark without
    // any read() from the rest of the app.
    await app.transition('active');
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + HOUR);

    clocks.monotonicMs += DAY;
    clocks.wallMs += DAY;
    await app.transition('active');
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + HOUR + DAY);

    await time.read();
    await time.checkpoint();
    expect(app.subscriptions).toBe(1);
  });

  it('a wall clock seen ahead while foregrounded is remembered: winding it back afterwards is a rollback even though the process slept', async () => {
    // The process monotonic clock does not count while the device sleeps.
    // Ten real days pass, one of them awake; the wall clock is honest until
    // the user winds it back to just past what the monotonic clock counted.
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    await app.transition('background');
    clocks.monotonicMs += DAY;
    clocks.wallMs += 10 * DAY;
    await app.transition('active');
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 10 * DAY);

    clocks.monotonicMs += 60_000;
    clocks.wallMs = SERVER_MS + DAY + 60_000;
    const reading = await time.read();
    // The suspension left the anchor unmeasured, and the rollback is still
    // caught against the remembered high-water mark.
    expect(reading.authority).toBe('floor');
    expect(reading.continuity).toBe('unmeasured');
    expect(reading.nowMs).toBe(SERVER_MS + 10 * DAY + 60_000);
    expect(reading.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    // And a relaunch starts from the remembered floor: with the wall clock
    // still wound back the rollback is reported; with it restored the lease
    // is simply expired. Neither is ever active.
    const woundBack = harness(
      { monotonicMs: 1, wallMs: SERVER_MS + DAY + 2 * 60_000 },
      Keychain,
      app.lifecycle,
    );
    expect(evaluateLease(lease, await woundBack.read())).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    const restored = harness(
      { monotonicMs: 1, wallMs: SERVER_MS + 10 * DAY + 3 * 60_000 },
      Keychain,
      app.lifecycle,
    );
    expect(evaluateLease(lease, await restored.read())).toEqual({
      kind: 'expired',
    });
  });

  it('the shared clock subscribes to the real AppState, and a lifecycle that cannot subscribe leaves the clock counting as a floor', async () => {
    const addEventListener = AppState.addEventListener as jest.Mock;
    addEventListener.mockClear();
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const defaulted = createTrustedTime({
      keychain: Keychain,
      monotonicNowMs: () => clocks.monotonicMs,
      wallClockNowMs: () => clocks.wallMs,
    });
    await defaulted.read();
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0]?.[0]).toBe('change');

    // Without lifecycle events a suspension can never be noticed, so the
    // process clock cannot vouch for the elapsed time: the anchor still
    // counts, checkpoints and catches rollbacks, but only as a lower bound.
    const throwing: TrustedTimeLifecycle = {
      currentState: 'active',
      addEventListener() {
        throw new Error('no lifecycle events here');
      },
    };
    const time = harness(clocks, Keychain, throwing);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.continuity).toBe('unmeasured');
    expect(reading.nowMs).toBe(SERVER_MS + HOUR);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + HOUR);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });

    clocks.monotonicMs += HOUR;
    clocks.wallMs -= DAY;
    expect(evaluateLease(lease, await time.read())).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    const noLifecycle = harness(clocks, Keychain, null);
    await noLifecycle.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + DAY),
      authenticated: true,
    });
    const unobserved = await noLifecycle.read();
    expect(unobserved.authority).toBe('floor');
    expect(unobserved.continuity).toBe('unmeasured');
    expect(evaluateLease(lease, unobserved)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });
  });
});

describe('W05-02 trusted time — the device sleeps while the app is suspended', () => {
  const dayLease = { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + DAY };

  it('a wall clock wound back while the app was suspended cannot extend the lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += MINUTE;
    clocks.wallMs += MINUTE;
    const foreground = await time.read();
    expect(foreground.authority).toBe('anchored');
    expect(foreground.continuity).toBe('measured');
    expect(evaluateLease(dayLease, foreground)).toEqual({
      kind: 'active',
      remainingMs: DAY - MINUTE,
    });

    // The user leaves the app, the device sleeps for six days (the process
    // clock is frozen, the wall clock advances) and, before coming back to
    // the app, winds the wall clock back to where it was.
    await app.transition('inactive');
    await app.transition('background');
    clocks.wallMs += 6 * DAY;
    clocks.wallMs = SERVER_MS + MINUTE;
    await app.transition('active');
    clocks.monotonicMs += 30_000;
    clocks.wallMs += 30_000;

    const resumed = await time.read();
    // Nothing distinguishes this from one awake minute, so the elapsed time
    // is a lower bound and cannot authorize the remaining lease.
    expect(resumed.authority).toBe('floor');
    expect(resumed.continuity).toBe('unmeasured');
    expect(resumed.rollbackDetected).toBe(false);
    expect(resumed.nowMs).toBe(SERVER_MS + MINUTE + 30_000);
    expect(evaluateLease(dayLease, resumed)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });
    expect(evaluateLease(lease, resumed)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });

    // A device that honestly stayed awake for the same interval reads the
    // same, and is held to the same standard: reconnect to re-anchor.
    const honest: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const honestApp = fakeLifecycle();
    const honestTime = harness(honest, Keychain, honestApp.lifecycle);
    await honestTime.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    await honestApp.transition('background');
    honest.monotonicMs += HOUR;
    honest.wallMs += HOUR;
    await honestApp.transition('active');
    expect(evaluateLease(dayLease, await honestTime.read())).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });
  });

  it('cannot be re-armed by a rollback before every foreground: repeated sleep-and-rollback cycles never keep the lease active', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    const verdicts: string[] = [];
    for (let cycle = 0; cycle < 10; cycle += 1) {
      clocks.monotonicMs += MINUTE;
      clocks.wallMs += MINUTE;
      await app.transition('background');
      // Two days asleep, then the wall clock is set back to match what the
      // frozen process clock will report.
      clocks.wallMs += 2 * DAY;
      clocks.wallMs = SERVER_MS + (cycle + 1) * MINUTE;
      await app.transition('active');
      verdicts.push(evaluateLease(lease, await time.read()).kind);
    }
    // Twenty real days on a seven-day lease.
    expect(verdicts).toEqual(Array<string>(10).fill('reconcile_required'));
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 10 * MINUTE);

    // A relaunch inherits the floor, not the anchor.
    const relaunch = harness(
      { monotonicMs: 3, wallMs: SERVER_MS + 10 * MINUTE },
      Keychain,
      fakeLifecycle().lifecycle,
    );
    expect(evaluateLease(lease, await relaunch.read())).toEqual({
      kind: 'reconcile_required',
      reason: 'floor_only',
    });
  });

  it('the suspension still counts what the process clock saw, catches rollbacks below it and proves expiry', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    await app.transition('background');
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    await app.transition('active');

    // Awake time after the resume keeps accruing on the frozen-then-resumed
    // process clock; the wall clock cannot push the estimate below it.
    clocks.monotonicMs += HOUR;
    clocks.wallMs = SERVER_MS - HOUR;
    const wound = await time.read();
    expect(wound.authority).toBe('floor');
    expect(wound.nowMs).toBe(SERVER_MS + 2 * HOUR);
    expect(wound.rollbackDetected).toBe(true);
    expect(evaluateLease(dayLease, wound)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    clocks.monotonicMs += DAY;
    clocks.wallMs = SERVER_MS + DAY + 2 * HOUR;
    const expired = await time.read();
    expect(expired.authority).toBe('floor');
    expect(expired.rollbackDetected).toBe(false);
    expect(evaluateLease(dayLease, expired)).toEqual({ kind: 'expired' });
  });

  it('an anchor taken while the app is not in the foreground is a floor until a foreground response re-anchors', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle('background');
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    // The device may have slept between the response and this launch.
    clocks.monotonicMs += MINUTE;
    clocks.wallMs += MINUTE;
    await app.transition('active');
    const background = await time.read();
    expect(background.authority).toBe('floor');
    expect(background.continuity).toBe('unmeasured');
    expect(evaluateLease(dayLease, background)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });

    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 2 * MINUTE),
      authenticated: true,
    });
    clocks.monotonicMs += MINUTE;
    clocks.wallMs += MINUTE;
    const foreground = await time.read();
    expect(foreground.authority).toBe('anchored');
    expect(foreground.continuity).toBe('measured');
    expect(foreground.nowMs).toBe(SERVER_MS + 3 * MINUTE);
    expect(evaluateLease(dayLease, foreground)).toEqual({
      kind: 'active',
      remainingMs: DAY - 3 * MINUTE,
    });
  });

  it('an interruption that keeps the app in the foreground (inactive) does not lose the measurement', async () => {
    // `inactive` is a foreground state: a call banner, Control Center, a
    // system prompt. The device only sleeps after the app is backgrounded.
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    await app.transition('inactive');
    clocks.monotonicMs += MINUTE;
    clocks.wallMs += MINUTE;
    await app.transition('active');
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.continuity).toBe('measured');
    expect(evaluateLease(dayLease, reading)).toEqual({
      kind: 'active',
      remainingMs: DAY - MINUTE,
    });

    // Whereas an unknown state is treated like a suspension.
    await app.transition('unknown');
    await app.transition('active');
    expect((await time.read()).continuity).toBe('unmeasured');
  });

  it('a sleep-inclusive clock measures the suspension: the rollback is caught and the lease expires on time', async () => {
    const clocks: Clocks = {
      monotonicMs: 0,
      wallMs: SERVER_MS,
      continuousMs: 0,
    };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    // Honest: two days asleep, wall clock agrees.
    await app.transition('background');
    clocks.continuousMs = 2 * DAY;
    clocks.wallMs = SERVER_MS + 2 * DAY;
    await app.transition('active');
    const honest = await time.read();
    expect(honest.authority).toBe('anchored');
    expect(honest.continuity).toBe('measured');
    expect(honest.nowMs).toBe(SERVER_MS + 2 * DAY);
    expect(honest.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, honest)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 2 * DAY,
    });

    // Attack: six more days asleep, the wall clock wound back to the anchor
    // before the app is resumed.
    await app.transition('background');
    clocks.continuousMs = 8 * DAY;
    clocks.wallMs = SERVER_MS + MINUTE;
    await app.transition('active');
    const attacked = await time.read();
    expect(attacked.authority).toBe('anchored');
    expect(attacked.nowMs).toBe(SERVER_MS + 8 * DAY);
    expect(attacked.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, attacked)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 8 * DAY);

    // With the wall clock restored the lease is simply expired.
    clocks.wallMs = SERVER_MS + 8 * DAY + MINUTE;
    clocks.continuousMs = 8 * DAY + MINUTE;
    expect(evaluateLease(lease, await time.read())).toEqual({
      kind: 'expired',
    });
  });

  it('a sleep-inclusive clock that stops answering falls back to the process clock and the lifecycle', async () => {
    const clocks: Clocks = {
      monotonicMs: 0,
      wallMs: SERVER_MS,
      continuousMs: 0,
    };
    const app = fakeLifecycle();
    const time = harness(clocks, Keychain, app.lifecycle);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.continuousMs = null;
    clocks.monotonicMs += MINUTE;
    clocks.wallMs += MINUTE;
    const foreground = await time.read();
    expect(foreground.authority).toBe('anchored');
    expect(foreground.nowMs).toBe(SERVER_MS + MINUTE);

    await app.transition('background');
    clocks.wallMs = SERVER_MS + 2 * MINUTE;
    await app.transition('active');
    clocks.monotonicMs += MINUTE;
    const resumed = await time.read();
    expect(resumed.authority).toBe('floor');
    expect(resumed.continuity).toBe('unmeasured');
    expect(evaluateLease(dayLease, resumed)).toEqual({
      kind: 'reconcile_required',
      reason: 'elapsed_unmeasured',
    });
    // The wall clock seen on the foreground checkpoint plus the process
    // clock's minute since.
    expect(resumed.nowMs).toBe(SERVER_MS + 3 * MINUTE);

    // Neither clock is ever allowed to run backwards.
    clocks.continuousMs = -DAY;
    clocks.monotonicMs = -DAY;
    expect((await time.read()).nowMs).toBe(SERVER_MS + 3 * MINUTE);
  });
});

describe('W05-02 trusted time — relaunch without monotonic continuity', () => {
  async function persistedAfterThreeDays(): Promise<void> {
    const clocks: Clocks = { monotonicMs: 10_000, wallMs: SERVER_MS + 500 };
    const first = harness(clocks);
    await first.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs += 3 * DAY;
    await first.checkpoint();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 3 * DAY);
  }

  it('the persisted floor and a consistent wall clock give a lower bound, never an active lease', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 4 * DAY,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.storage).toBe('loaded');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 4 * DAY);
    // The wall clock may have been wound back while the app was not running;
    // nothing distinguishes that from an honest clock, so the floor cannot
    // authorize the remaining time.
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'floor_only',
    });
  });

  it('a wall clock wound back after a floor-mode reading is a rollback and never lowers the estimate', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 6 * DAY,
    };
    const time = harness(relaunch);
    const first = await time.read();
    expect(first.authority).toBe('floor');
    expect(first.nowMs).toBe(SERVER_MS + 6 * DAY);
    expect(first.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, first)).toEqual({
      kind: 'reconcile_required',
      reason: 'floor_only',
    });
    // The reading is checkpointed in floor mode too.
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 6 * DAY);

    relaunch.monotonicMs += HOUR;
    relaunch.wallMs = SERVER_MS + 500 + 3 * DAY;
    const wound = await time.read();
    expect(wound.authority).toBe('floor');
    expect(wound.nowMs).toBe(SERVER_MS + 6 * DAY + HOUR);
    expect(wound.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, wound)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 6 * DAY + HOUR);

    // Monotonic time keeps counting from the pinned reading: once it carries
    // the estimate past the lease end, the lease is expired even when the
    // wall clock is set back to agree with the estimate again.
    relaunch.monotonicMs += DAY;
    relaunch.wallMs = SERVER_MS + 500 + 7 * DAY + HOUR;
    const expired = await time.read();
    expect(expired.nowMs).toBe(SERVER_MS + 7 * DAY + HOUR);
    expect(expired.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, expired)).toEqual({ kind: 'expired' });
  });

  it('a lease that expired while the app was not running never comes back, however often the device relaunches with the clock reset', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const first = harness(clocks);
    await first.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += DAY;
    clocks.wallMs += DAY;
    await first.checkpoint();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + DAY);

    // Ten real days later (the lease ended three days ago) the user sets the
    // wall clock to just above the persisted floor and relaunches.
    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + DAY + 60_000,
    };
    const reading = await harness(relaunch).read();
    expect(reading.authority).toBe('floor');
    expect(reading.storage).toBe('loaded');
    expect(reading.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'floor_only',
    });

    // Repeating the kill / clock-reset / relaunch cycle grants nothing, and
    // the floor only ever moves forward.
    const grants: number[] = [];
    let floor = storedRecord().highWaterMs as number;
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const again: Clocks = {
        monotonicMs: 5,
        wallMs: SERVER_MS + DAY + 60_000,
      };
      const time = harness(again);
      const verdict = evaluateLease(lease, await time.read());
      if (verdict.kind === 'active') grants.push(verdict.remainingMs);
      again.monotonicMs += HOUR;
      await time.checkpoint();
      const persisted = storedRecord().highWaterMs as number;
      expect(persisted).toBeGreaterThanOrEqual(floor);
      floor = persisted;
    }
    expect(grants).toEqual([]);
    expect(floor).toBeGreaterThanOrEqual(SERVER_MS + DAY + 60_000 + 3 * HOUR);
  });

  it('floor mode checkpoints the high-water mark, and the floor alone proves expiry', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 3 * DAY,
    };
    const time = harness(relaunch);
    expect((await time.read()).nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 3 * DAY);

    // Reads persist on the checkpoint interval with the wall clock frozen:
    // only the monotonic clock is advancing the estimate.
    relaunch.monotonicMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS - 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 3 * DAY);
    relaunch.monotonicMs += 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(
      SERVER_MS + 3 * DAY + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
    );

    relaunch.monotonicMs += 2 * DAY;
    await time.checkpoint();
    expect(storedRecord()).toEqual({
      schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
      serverEpochMs: SERVER_MS,
      highWaterMs: SERVER_MS + 5 * DAY + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
      wallOffsetMs: 500,
    });

    // Another two days in this process end the lease; the next relaunch
    // starts from that floor and reports it expired outright, whatever the
    // wall clock says.
    relaunch.monotonicMs += 2 * DAY;
    await time.checkpoint();
    const next = harness({ monotonicMs: 7, wallMs: SERVER_MS + DAY });
    const reading = await next.read();
    expect(reading.authority).toBe('floor');
    expect(reading.nowMs).toBe(
      SERVER_MS + 7 * DAY + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
    );
    expect(reading.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    const honest = harness({
      monotonicMs: 7,
      wallMs: SERVER_MS + 500 + 8 * DAY,
    });
    expect(evaluateLease(lease, await honest.read())).toEqual({
      kind: 'expired',
    });
  });

  it('a wall clock rolled back below the floor cannot extend the lease', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs:
        SERVER_MS + 500 + 3 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS - 1,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.rollbackDetected).toBe(true);
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    relaunch.wallMs = SERVER_MS - 30 * DAY;
    const deep = await time.read();
    expect(deep.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(deep.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, deep).kind).toBe('reconcile_required');
  });

  it('a wall clock slightly behind the floor is tolerated but never trusted below it', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 3 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'floor_only',
    });
  });

  it('a fresh authenticated response re-anchors after a relaunch', async () => {
    await persistedAfterThreeDays();
    const relaunch: Clocks = { monotonicMs: 5, wallMs: SERVER_MS - 30 * DAY };
    const time = harness(relaunch);
    expect((await time.read()).rollbackDetected).toBe(true);

    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 5 * DAY),
      authenticated: true,
    });
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 5 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 5 * DAY,
    });
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + 5 * DAY);
  });
});

describe('W05-02 trusted time — storage and input faults', () => {
  it('without any anchor the lease requires reconciliation', async () => {
    const time = harness({ monotonicMs: 0, wallMs: SERVER_MS + DAY });
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(reading.storage).toBe('empty');
    expect(reading.nowMs).toBe(SERVER_MS + DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'no_trusted_time',
    });
  });

  it('a corrupt record is neither trusted nor destroyed, and is replaced by the next anchor', async () => {
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
      password:
        '{"schemaVersion":"trusted-time-anchor-v1","serverEpochMs":"soon"',
    });
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS + DAY };
    const time = harness(clocks);
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(reading.storage).toBe('invalid');
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'storage_invalid',
    });
    expect(
      __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE)?.password,
    ).toContain('"soon"');

    for (const password of [
      JSON.stringify({
        schemaVersion: 'trusted-time-anchor-v0',
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
      JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS - 1,
        wallOffsetMs: 0,
      }),
      JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: 12.5,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
      JSON.stringify([SERVER_MS]),
    ]) {
      __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
        username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
        password,
      });
      const fresh = await harness(clocks).read();
      expect(fresh.authority).toBe('none');
      expect(fresh.storage).toBe('invalid');
    }

    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: 'someone-else',
      password: JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
    });
    expect((await harness(clocks).read()).storage).toBe('invalid');

    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + DAY),
      authenticated: true,
    });
    const anchored = await time.read();
    expect(anchored.authority).toBe('anchored');
    expect(anchored.nowMs).toBe(SERVER_MS + DAY);
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + DAY);
  });

  it('an unavailable Keychain is reported, and an in-process anchor still works', async () => {
    const broken: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
      setGenericPassword: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks, broken);
    const before = await time.read();
    expect(before.authority).toBe('none');
    expect(before.storage).toBe('unavailable');
    expect(evaluateLease(lease, before)).toEqual({
      kind: 'reconcile_required',
      reason: 'no_trusted_time',
    });

    const observation = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(observation.accepted).toBe(true);
    clocks.monotonicMs += DAY;
    clocks.wallMs -= DAY;
    const after = await time.read();
    expect(after.authority).toBe('anchored');
    expect(after.nowMs).toBe(SERVER_MS + DAY);
    expect(after.rollbackDetected).toBe(true);
    expect(__keychainStore.size).toBe(0);
  });

  it('a transient Keychain read failure never lets a stale floor outrank a fresh in-process anchor', async () => {
    // A previous process left a floor far ahead (e.g. a forward wall-clock
    // jump it trusted); the server is the authority over it.
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
      password: JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: SERVER_MS - DAY,
        highWaterMs: SERVER_MS + 30 * DAY,
        wallOffsetMs: 0,
      }),
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
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks, flaky);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += HOUR;
    clocks.wallMs += HOUR;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + HOUR);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - HOUR,
    });
    // The stale record has been replaced by the anchored high-water mark.
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + HOUR);
  });

  it('ignores unauthenticated, missing, malformed and implausible server dates', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    const cases: {
      dateHeader: string | null;
      authenticated: boolean;
      reason: string;
    }[] = [
      {
        dateHeader: serverHeader(SERVER_MS),
        authenticated: false,
        reason: 'unauthenticated',
      },
      { dateHeader: null, authenticated: true, reason: 'missing' },
      { dateHeader: 'yesterday', authenticated: true, reason: 'malformed' },
      { dateHeader: '', authenticated: true, reason: 'missing' },
      // Only an RFC 7231 IMF-fixdate is a server time; every other form
      // Date.parse happens to accept widens the surface through which a
      // non-server value could become the anchor.
      { dateHeader: '2026', authenticated: true, reason: 'malformed' },
      { dateHeader: '9/8/2026', authenticated: true, reason: 'malformed' },
      {
        dateHeader: '2026-09-08T12:00:00Z',
        authenticated: true,
        reason: 'malformed',
      },
      {
        dateHeader: 'Sep 8 2026 12:00 GMT',
        authenticated: true,
        reason: 'malformed',
      },
      {
        dateHeader: `${serverHeader(SERVER_MS)}, ${serverHeader(SERVER_MS)}`,
        authenticated: true,
        reason: 'malformed',
      },
      {
        dateHeader: 'Tue, 31 Feb 2026 12:00:00 GMT',
        authenticated: true,
        reason: 'malformed',
      },
      {
        dateHeader: 'Tue, 08 Sep 2026 12:00:00 PDT',
        authenticated: true,
        reason: 'malformed',
      },
      {
        dateHeader: serverHeader(Date.UTC(2015, 0, 1)),
        authenticated: true,
        reason: 'implausible',
      },
      {
        dateHeader: serverHeader(Date.UTC(2200, 0, 1)),
        authenticated: true,
        reason: 'implausible',
      },
    ];
    for (const input of cases) {
      expect(await time.observeServerTime(input)).toEqual({
        accepted: false,
        reason: input.reason,
      });
    }
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(__keychainStore.size).toBe(0);
  });

  it('rejects malformed leases and leases issued ahead of the trusted clock', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const reading = await time.read();
    for (const bad of [
      { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS },
      { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS - 1 },
      { issuedAtMs: SERVER_MS + 0.5, expiresAtMs: SERVER_MS + DAY },
      { issuedAtMs: Number.NaN, expiresAtMs: SERVER_MS + DAY },
      { issuedAtMs: SERVER_MS, expiresAtMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(evaluateLease(bad, reading)).toEqual({
        kind: 'reconcile_required',
        reason: 'invalid_lease',
      });
    }
    expect(
      evaluateLease(
        {
          issuedAtMs: SERVER_MS + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS + 1,
          expiresAtMs: SERVER_MS + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'reconcile_required', reason: 'lease_ahead_of_clock' });
    expect(
      evaluateLease(
        {
          issuedAtMs: SERVER_MS + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
          expiresAtMs: SERVER_MS + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: DAY });
    // A lease issued within tolerance ahead of the clock never reports more
    // than the cap remaining.
    expect(
      evaluateLease(
        {
          issuedAtMs: SERVER_MS + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
          expiresAtMs: SERVER_MS + 30 * DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: LEASE_MAX_MS });
  });

  it('a Keychain call that never answers is bounded and reported unavailable', async () => {
    jest.useFakeTimers();
    try {
      const hanging: TrustedTimeKeychain = {
        ACCESSIBLE: Keychain.ACCESSIBLE,
        getGenericPassword: () => new Promise(() => {}),
        setGenericPassword: () => new Promise(() => {}),
      };
      const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
      const time = harness(clocks, hanging);
      const pending = time.read();
      await jest.advanceTimersByTimeAsync(TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS - 1);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await jest.advanceTimersByTimeAsync(1);
      const reading = await pending;
      expect(reading.authority).toBe('none');
      expect(reading.storage).toBe('unavailable');
      // A store that never answered is not asked again in this process.
      let again: Awaited<ReturnType<typeof time.read>> | null = null;
      void time.read().then(value => {
        again = value;
      });
      await jest.advanceTimersByTimeAsync(0);
      expect(again).not.toBeNull();

      const observing = time.observeServerTime({
        dateHeader: serverHeader(SERVER_MS),
        authenticated: true,
      });
      await jest.advanceTimersByTimeAsync(2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS);
      expect(await observing).toEqual({
        accepted: true,
        serverEpochMs: SERVER_MS,
      });
      clocks.monotonicMs += HOUR;
      clocks.wallMs += HOUR;
      const anchored = time.read();
      await jest.advanceTimersByTimeAsync(2 * TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS);
      const after = await anchored;
      expect(after.authority).toBe('anchored');
      expect(after.storage).toBe('unavailable');
      expect(after.nowMs).toBe(SERVER_MS + HOUR);
    } finally {
      jest.useRealTimers();
    }
  });

  it('caps a Pro lease at OFFLINE_PRO_LEASE_MAX_SECONDS from issue', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += DAY;
    clocks.wallMs += DAY;
    const reading = await time.read();
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 30 * DAY },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: LEASE_MAX_MS - DAY });
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 2 * DAY },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: DAY });
    clocks.monotonicMs += LEASE_MAX_MS;
    clocks.wallMs += LEASE_MAX_MS;
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 30 * DAY },
        await time.read(),
      ),
    ).toEqual({ kind: 'expired' });
  });
});

describe('W05-02 trusted time — wired into the API client', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  function response(body: unknown, headers?: Record<string, string>): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      ...(headers ? { headers: new Headers(headers) } : {}),
    } as unknown as Response;
  }

  it('reads the Date header defensively', () => {
    expect(responseDateHeader(response({}))).toBeNull();
    expect(
      responseDateHeader(response({}, { date: serverHeader(SERVER_MS) })),
    ).toBe(serverHeader(SERVER_MS));
    expect(
      responseDateHeader({
        headers: {
          get() {
            throw new Error('no headers on this transport');
          },
        },
      } as unknown as Response),
    ).toBeNull();
  });

  it('anchors the shared trusted clock from an authenticated permit reservation', async () => {
    const permitServerMs = Date.UTC(2026, 8, 9, 8, 30, 0);
    const permit = {
      id: '22222222-2222-4222-8222-222222222222',
      accessSource: 'premium',
      status: 'reserved',
      expiresAt: new Date(permitServerMs + 10 * 60_000).toISOString(),
    };
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (url.endsWith('/v1/analysis-permits') && headers.authorization)
        return response({ permit }, { date: serverHeader(permitServerMs) });
      if (url.endsWith('/v1/anonymous'))
        return response({ ok: true }, { date: serverHeader(permitServerMs) });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    // The jest AppState mock has no state; the app is in the foreground.
    (AppState as { currentState: AppStateStatus }).currentState = 'active';

    const before = await trustedTime.read();
    expect(before.authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);

    await api.request(
      { baseUrl: 'https://api.test', token: null },
      'GET',
      '/v1/anonymous',
    );
    expect((await trustedTime.read()).authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);

    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
    });
    const reserved = await client.reserve('idem-1');
    expect(reserved.permit.id).toBe(permit.id);

    const reading = await trustedTime.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.continuity).toBe('measured');
    expect(reading.nowMs).toBeGreaterThanOrEqual(permitServerMs);
    expect(reading.nowMs).toBeLessThan(permitServerMs + HOUR);
    expect(storedRecord().serverEpochMs).toBe(permitServerMs);
    expect(
      evaluateLease(
        { issuedAtMs: permitServerMs, expiresAtMs: permitServerMs + DAY },
        reading,
      ).kind,
    ).toBe('active');
  });

  it('a response without headers (legacy transport) leaves the request path untouched', async () => {
    const fetchMock = jest.fn(async () => response({ ok: true }));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    await expect(
      api.request(
        { baseUrl: 'https://api.test', token: 'access-token' },
        'POST',
        '/v1/sessions',
        {},
      ),
    ).resolves.toEqual({ ok: true });
  });
});
