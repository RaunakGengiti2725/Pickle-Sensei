import { AppState, type AppStateStatus } from 'react-native';
import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';

/**
 * Trusted time for lease expiry.
 *
 * The device wall clock is user-editable, so an offline lease measured
 * against it could be extended for free by winding the clock back. This
 * module derives "now" from sources that the user cannot cheaply move:
 *
 *  - server time taken ONLY from authenticated API responses (`Date` header),
 *    which becomes the anchor;
 *  - the process monotonic clock (`performance.now()`), which only counts
 *    forward from the anchor — or from the persisted floor after a relaunch —
 *    while the process lives and the device is awake;
 *  - optionally a sleep-inclusive monotonic clock (a native continuous clock,
 *    `continuousNowMs`), which also counts while the device sleeps;
 *  - a high-water mark persisted in its own THIS_DEVICE_ONLY Keychain service,
 *    the floor below which "now" cannot fall after a relaunch.
 *
 * Every estimate is conservative: the reported `nowMs` is the LARGEST of the
 * trustworthy candidates, so any error shortens a lease and never lengthens
 * it. Within a process the estimate never decreases: every reading is pinned
 * to the monotonic clocks, so a wall clock that later reads lower than the
 * estimate is reported as `rollbackDetected` and `evaluateLease` requires
 * online reconciliation rather than granting the remaining time. The high-
 * water mark is checkpointed to the Keychain in every authority state — on
 * reads, and whenever the app returns to the foreground — so a relaunch never
 * starts below where the previous process got to, and a wall clock seen
 * ahead while the app was open is remembered against a later rollback.
 *
 * The process monotonic clock does not count while the device sleeps, and a
 * frozen interval is indistinguishable from "no time passed": a wall clock
 * wound back while the app was suspended would otherwise look consistent
 * with it. A device only sleeps once the app has left the foreground, so the
 * anchor is `measured` — and `nowMs` trusted (`anchored`) — only while the
 * app has stayed in the foreground (`active`/`inactive`) since the anchor
 * was taken, or while a sleep-inclusive clock has counted since it. Once the
 * app has been in the background (or the lifecycle cannot be observed, or
 * the anchor was taken outside the foreground) the elapsed time is only a
 * lower bound: the anchor keeps counting, checkpointing and catching
 * rollbacks, but the lease requires an authenticated response to re-anchor.
 *
 * Native elapsed time across process death is not available here. After a
 * relaunch the persisted floor is only a LOWER bound on the true time: the
 * wall clock may have been wound back while the app was not running, and
 * nothing can tell that apart from an honest clock. `floor` authority is
 * therefore never enough to report a lease `active` — it can prove a lease
 * expired, and otherwise requires an authenticated response to re-anchor.
 */

export const TRUSTED_TIME_KEYCHAIN_SERVICE =
  'com.picklesensei.offline.trusted-time';
export const TRUSTED_TIME_KEYCHAIN_ACCOUNT = 'trusted-time-anchor';
export const TRUSTED_TIME_ANCHOR_SCHEMA_VERSION = 'trusted-time-anchor-v1';
/** Device clocks drift by seconds, not minutes: a wall clock further behind
 * the trusted estimate than this is a rollback. */
export const TRUSTED_TIME_ROLLBACK_TOLERANCE_MS = 5 * 60_000;
/** How much trusted time must pass before a read re-persists the high-water
 * mark, bounding how stale the floor can be after the process dies. */
export const TRUSTED_TIME_CHECKPOINT_INTERVAL_MS = 60_000;
/** Longest a lease may run from issue regardless of what it claims. */
export const TRUSTED_TIME_LEASE_MAX_MS = OFFLINE_PRO_LEASE_MAX_SECONDS * 1000;
/** A Keychain call that has not answered by then is treated as unavailable
 * so a stuck store cannot block every reader. */
export const TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS = 2_000;

const MIN_PLAUSIBLE_SERVER_MS = Date.UTC(2025, 0, 1);
const MAX_PLAUSIBLE_SERVER_MS = Date.UTC(2100, 0, 1);
const MAX_RECORD_BYTES = 512;
/** RFC 7231 IMF-fixdate — the only `Date` header form a server emits. */
const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

export type TrustedTimeKeychain = Pick<
  typeof Keychain,
  'ACCESSIBLE' | 'getGenericPassword' | 'setGenericPassword'
>;

/**
 * `anchored`: an authenticated server time was observed in this process and
 * a clock has measured every instant since — `nowMs` is trusted.
 * `floor`: only a lower bound is known (a persisted high-water mark, or an
 * anchor whose elapsed time is unmeasured) — never an authorization.
 * `none`: nothing trustworthy; `nowMs` is the raw wall clock.
 */
export type TrustedTimeAuthority = 'anchored' | 'floor' | 'none';
export type TrustedTimeStorage = 'loaded' | 'empty' | 'invalid' | 'unavailable';
/**
 * How the time elapsed since the anchor is known.
 * `measured`: a clock counted every instant since the anchor — the app stayed
 * in the foreground, or a sleep-inclusive clock is in use.
 * `unmeasured`: the app left the foreground since the anchor (or the
 * lifecycle is not observable) and only the process clock is available: the
 * elapsed time is a lower bound.
 * `persisted`: only a high-water mark from an earlier process.
 * `none`: no anchor and no floor.
 */
export type TrustedTimeContinuity =
  'measured' | 'unmeasured' | 'persisted' | 'none';

export interface TrustedTimeReading {
  readonly authority: TrustedTimeAuthority;
  readonly continuity: TrustedTimeContinuity;
  /** Conservative estimate of server time now, in epoch milliseconds. */
  readonly nowMs: number;
  readonly wallClockMs: number;
  /** The wall clock moved backwards relative to the trusted estimate. */
  readonly rollbackDetected: boolean;
  readonly storage: TrustedTimeStorage;
}

export type TrustedTimeObservation =
  | { readonly accepted: true; readonly serverEpochMs: number }
  | {
      readonly accepted: false;
      readonly reason:
        'unauthenticated' | 'missing' | 'malformed' | 'implausible';
    };

export interface TrustedTimeLease {
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}

export type TrustedTimeLeaseVerdict =
  | { readonly kind: 'active'; readonly remainingMs: number }
  | { readonly kind: 'expired' }
  | {
      readonly kind: 'reconcile_required';
      readonly reason:
        | 'no_trusted_time'
        | 'storage_invalid'
        | 'clock_rollback'
        | 'floor_only'
        | 'elapsed_unmeasured'
        | 'invalid_lease'
        | 'lease_ahead_of_clock';
    };

/** The app lifecycle a trusted clock follows (`AppState`): returns to the
 * foreground checkpoint, leaving it ends the anchor's measurement. `null`
 * means the lifecycle cannot be observed, so no anchor is ever measured. */
export interface TrustedTimeLifecycle {
  /** `AppState.currentState`: unset before the first event. */
  readonly currentState: string | null | undefined;
  addEventListener(
    type: 'change',
    listener: (state: AppStateStatus) => void,
  ): { remove(): void };
}

export interface TrustedTimeDependencies {
  readonly keychain?: TrustedTimeKeychain;
  /** Process monotonic clock; does not count while the device sleeps. */
  readonly monotonicNowMs?: () => number;
  /** Sleep-inclusive monotonic clock (e.g. a native continuous clock);
   * `null` when it has no answer. The app has no such source by default. */
  readonly continuousNowMs?: () => number | null;
  readonly wallClockNowMs?: () => number;
  readonly lifecycle?: TrustedTimeLifecycle | null;
}

export interface ServerTimeInput {
  readonly dateHeader: string | null;
  /** Only responses to bearer-authenticated requests are trusted. */
  readonly authenticated: boolean;
}

export interface TrustedTime {
  observeServerTime(input: ServerTimeInput): Promise<TrustedTimeObservation>;
  read(): Promise<TrustedTimeReading>;
  checkpoint(): Promise<void>;
}

interface PersistedAnchor {
  readonly schemaVersion: typeof TRUSTED_TIME_ANCHOR_SCHEMA_VERSION;
  /** Server-derived anchor epoch (an observation, or that observation
   * carried forward on the monotonic clock). */
  readonly serverEpochMs: number;
  readonly highWaterMs: number;
  readonly wallOffsetMs: number;
}

/** One moment on the in-process clocks; `null` where a clock had no value. */
interface Instant {
  readonly monotonicMs: number | null;
  readonly continuousMs: number | null;
}

/** Server time pinned to the in-process clocks; never influenced by the wall
 * clock and never lowered within a process. */
interface Anchor {
  readonly serverEpochMs: number;
  readonly at: Instant;
  readonly wallOffsetMs: number;
  /** The app has been in the foreground at every instant since `at`, so the
   * process clock — which stops while the device sleeps — missed nothing. */
  readonly foregroundSince: boolean;
}

/** In-process high-water mark pinned to the clocks. It ratchets on every
 * reading, so once a (possibly wall-clock-derived) time has been reported,
 * no later reading falls below it plus the elapsed time. */
interface Mark {
  readonly highWaterMs: number;
  readonly at: Instant;
}

function epochMs(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_PLAUSIBLE_SERVER_MS &&
    value < MAX_PLAUSIBLE_SERVER_MS
  );
}

function parsePersistedAnchor(value: unknown): PersistedAnchor | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return null;
  const record = value as {
    schemaVersion?: unknown;
    serverEpochMs?: unknown;
    highWaterMs?: unknown;
    wallOffsetMs?: unknown;
  };
  if (record.schemaVersion !== TRUSTED_TIME_ANCHOR_SCHEMA_VERSION) return null;
  if (!epochMs(record.serverEpochMs) || !epochMs(record.highWaterMs))
    return null;
  if (record.highWaterMs < record.serverEpochMs) return null;
  if (
    typeof record.wallOffsetMs !== 'number' ||
    !Number.isSafeInteger(record.wallOffsetMs)
  )
    return null;
  return {
    schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
    serverEpochMs: record.serverEpochMs,
    highWaterMs: record.highWaterMs,
    wallOffsetMs: record.wallOffsetMs,
  };
}

function parseServerDate(header: string): number | null {
  if (!IMF_FIXDATE.test(header)) return null;
  const parsed = Date.parse(header);
  if (!Number.isFinite(parsed)) return null;
  // Round-tripping rejects impossible calendar dates that Date.parse
  // silently normalizes (e.g. 31 Feb).
  return new Date(parsed).toUTCString() === header ? parsed : null;
}

function finiteClock(read: () => number | null): number | null {
  try {
    const value = read();
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function elapsedOn(fromMs: number | null, toMs: number | null): number | null {
  if (fromMs === null || toMs === null) return null;
  return Math.max(0, Math.floor(toMs - fromMs));
}

/** The longest elapsed time any clock measured between two instants; a
 * clock that lacks a value at either end contributes nothing. */
function elapsedSince(from: Instant, to: Instant): number {
  return Math.max(
    elapsedOn(from.monotonicMs, to.monotonicMs) ?? 0,
    elapsedOn(from.continuousMs, to.continuousMs) ?? 0,
  );
}

/** `active` and `inactive` are foreground states; a device does not sleep
 * until the foreground app is backgrounded. Anything else — `background`,
 * `extension`, `unknown`, or no state at all — may hide a sleep. */
function isForeground(state: unknown): boolean {
  return state === 'active' || state === 'inactive';
}

class KeychainTimeoutError extends Error {
  constructor() {
    super('trusted-time keychain timeout');
  }
}

function bounded<T>(operation: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new KeychainTimeoutError()),
      TRUSTED_TIME_KEYCHAIN_TIMEOUT_MS,
    );
    operation.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The `Date` header of a response, or null when the transport has none. */
export function responseDateHeader(response: Response): string | null {
  try {
    const value = response.headers.get('date');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

function defaultMonotonicNowMs(): number {
  return performance.now();
}

function noContinuousClock(): null {
  return null;
}

export function createTrustedTime(
  dependencies: TrustedTimeDependencies = {},
): TrustedTime {
  const keychain: TrustedTimeKeychain = dependencies.keychain ?? Keychain;
  const monotonicNowMs = dependencies.monotonicNowMs ?? defaultMonotonicNowMs;
  const continuousNowMs = dependencies.continuousNowMs ?? noContinuousClock;
  const wallClockNowMs = dependencies.wallClockNowMs ?? Date.now;
  const lifecycle: TrustedTimeLifecycle | null =
    dependencies.lifecycle === undefined ? AppState : dependencies.lifecycle;

  let anchor: Anchor | null = null;
  let mark: Mark | null = null;
  let floor: PersistedAnchor | null = null;
  let storage: TrustedTimeStorage = 'unavailable';
  let lastPersistAttemptMs: number | null = null;
  let hydrated = false;
  let lifecycleArmed = false;
  let lifecycleObserved = false;
  /** Times the app has left the foreground since the lifecycle was armed. */
  let foregroundLeaves = 0;
  let queue: Promise<void> = Promise.resolve();

  function instantNow(): Instant {
    return {
      monotonicMs: finiteClock(monotonicNowMs),
      continuousMs: finiteClock(continuousNowMs),
    };
  }

  function leaveForeground(): void {
    foregroundLeaves += 1;
    if (anchor?.foregroundSince) anchor = { ...anchor, foregroundSince: false };
  }

  /** Once the clock is in use it follows the app lifecycle: every return to
   * the foreground reads the clocks and persists the high-water mark, and
   * leaving the foreground ends the anchor's measurement. Subscribing lazily
   * keeps module import free of side effects. */
  function armLifecycle(): void {
    if (lifecycleArmed || !lifecycle) return;
    lifecycleArmed = true;
    try {
      lifecycle.addEventListener('change', state => {
        if (!isForeground(state)) leaveForeground();
        if (state === 'active') void checkpoint();
      });
      lifecycleObserved = true;
    } catch {
      // Without lifecycle events a suspension can never be noticed: the
      // clock still checkpoints on reads, but no anchor is ever measured.
    }
  }

  /** Every state change runs in call order, so a read issued after an
   * observation sees it. */
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation);
    queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  async function hydrate(): Promise<void> {
    if (hydrated) return;
    hydrated = true;
    try {
      const stored = await bounded(
        keychain.getGenericPassword({
          service: TRUSTED_TIME_KEYCHAIN_SERVICE,
          cloudSync: false,
        }),
      );
      if (stored === false) {
        storage = 'empty';
        return;
      }
      if (
        !stored ||
        stored.service !== TRUSTED_TIME_KEYCHAIN_SERVICE ||
        stored.username !== TRUSTED_TIME_KEYCHAIN_ACCOUNT ||
        typeof stored.password !== 'string' ||
        stored.password.length > MAX_RECORD_BYTES
      ) {
        storage = 'invalid';
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(stored.password);
      } catch {
        storage = 'invalid';
        return;
      }
      const record = parsePersistedAnchor(value);
      if (!record) {
        storage = 'invalid';
        return;
      }
      storage = 'loaded';
      // A server anchor observed in this process supersedes whatever an
      // earlier process left behind; the next checkpoint overwrites it.
      if (anchor) return;
      floor = record;
      lastPersistAttemptMs = record.highWaterMs;
    } catch (error) {
      // Keychain access can fail transiently (e.g. before first unlock); the
      // next call tries again. A store that never answered is not asked
      // again in this process, so no later reader waits on it.
      hydrated = error instanceof KeychainTimeoutError;
      storage = 'unavailable';
    }
  }

  function anchorEstimateMs(now: Instant): number | null {
    if (!anchor) return null;
    return anchor.serverEpochMs + elapsedSince(anchor.at, now);
  }

  /** A clock has counted every instant from the anchor to `now`: the
   * sleep-inclusive clock at both ends, or the process clock at both ends
   * with the app in the foreground throughout. */
  function anchorMeasured(now: Instant): boolean {
    if (!anchor) return false;
    if (anchor.at.continuousMs !== null && now.continuousMs !== null)
      return true;
    return (
      anchor.foregroundSince &&
      anchor.at.monotonicMs !== null &&
      now.monotonicMs !== null
    );
  }

  function trustedNow(): {
    nowMs: number;
    authority: TrustedTimeAuthority;
    continuity: TrustedTimeContinuity;
    rollbackDetected: boolean;
    wallClockMs: number;
  } {
    const wallClockMs = finiteClock(wallClockNowMs) ?? Number.NaN;
    const now = instantNow();
    let authority: TrustedTimeAuthority = 'none';
    let continuity: TrustedTimeContinuity = 'none';
    let estimateMs: number | null = null;
    let wallOffsetMs = 0;

    const fromAnchor = anchorEstimateMs(now);
    if (anchor && fromAnchor !== null) {
      estimateMs = fromAnchor;
      wallOffsetMs = anchor.wallOffsetMs;
      if (anchorMeasured(now)) {
        authority = 'anchored';
        continuity = 'measured';
      } else {
        authority = 'floor';
        continuity = 'unmeasured';
      }
    }
    if (floor) {
      if (estimateMs === null) {
        estimateMs = floor.highWaterMs;
        wallOffsetMs = floor.wallOffsetMs;
        authority = 'floor';
        continuity = 'persisted';
      } else estimateMs = Math.max(estimateMs, floor.highWaterMs);
    }
    if (mark) {
      const fromMark = mark.highWaterMs + elapsedSince(mark.at, now);
      if (estimateMs === null) {
        estimateMs = fromMark;
        authority = 'floor';
        continuity = 'persisted';
      } else estimateMs = Math.max(estimateMs, fromMark);
    }

    if (estimateMs === null) {
      return {
        nowMs: Number.isFinite(wallClockMs) ? Math.floor(wallClockMs) : 0,
        authority,
        continuity,
        rollbackDetected: false,
        wallClockMs,
      };
    }
    const adjustedWallMs = Number.isFinite(wallClockMs)
      ? Math.floor(wallClockMs - wallOffsetMs)
      : estimateMs;
    const nowMs = Math.max(estimateMs, adjustedWallMs);
    // Pin what was just reported to the clocks: a later reading can only be
    // this plus the elapsed time, whatever the wall clock says.
    mark = { highWaterMs: nowMs, at: now };
    return {
      nowMs,
      authority,
      continuity,
      rollbackDetected:
        adjustedWallMs < estimateMs - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
      wallClockMs,
    };
  }

  async function persist(highWaterMs: number): Promise<void> {
    const source = anchor ?? floor;
    if (!source) return;
    const record: PersistedAnchor = {
      schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
      serverEpochMs: source.serverEpochMs,
      highWaterMs: Math.max(
        source.serverEpochMs,
        floor?.highWaterMs ?? source.serverEpochMs,
        highWaterMs,
      ),
      wallOffsetMs: source.wallOffsetMs,
    };
    if (!epochMs(record.highWaterMs)) return;
    lastPersistAttemptMs = record.highWaterMs;
    try {
      const accessible =
        keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY;
      if (!accessible) {
        storage = 'unavailable';
        return;
      }
      const result = await bounded(
        keychain.setGenericPassword(
          TRUSTED_TIME_KEYCHAIN_ACCOUNT,
          JSON.stringify(record),
          {
            service: TRUSTED_TIME_KEYCHAIN_SERVICE,
            accessible,
            cloudSync: false,
          },
        ),
      );
      if (
        result !== false &&
        result.service === TRUSTED_TIME_KEYCHAIN_SERVICE
      ) {
        floor = record;
        storage = 'loaded';
      } else storage = 'unavailable';
    } catch {
      storage = 'unavailable';
    }
  }

  function reading(): TrustedTimeReading {
    const current = trustedNow();
    return Object.freeze({
      authority: current.authority,
      continuity: current.continuity,
      nowMs: current.nowMs,
      wallClockMs: current.wallClockMs,
      rollbackDetected: current.rollbackDetected,
      storage,
    });
  }

  function checkpoint(): Promise<void> {
    armLifecycle();
    return serialized(async () => {
      await hydrate();
      const current = trustedNow();
      if (current.authority === 'none') return;
      if (
        lastPersistAttemptMs !== null &&
        current.nowMs <= lastPersistAttemptMs
      )
        return;
      await persist(current.nowMs);
    });
  }

  return Object.freeze({
    async observeServerTime(
      input: ServerTimeInput,
    ): Promise<TrustedTimeObservation> {
      if (!input.authenticated)
        return { accepted: false, reason: 'unauthenticated' };
      const header = input.dateHeader?.trim() ?? '';
      if (!header) return { accepted: false, reason: 'missing' };
      const serverEpochMs = parseServerDate(header);
      if (serverEpochMs === null)
        return { accepted: false, reason: 'malformed' };
      if (!epochMs(serverEpochMs))
        return { accepted: false, reason: 'implausible' };
      armLifecycle();
      // The response is as old as this call, not as old as its turn in the
      // queue: the clocks and the foreground state are captured now, and a
      // departure from the foreground before the anchor is taken counts
      // against it.
      const at = instantNow();
      const wall = finiteClock(wallClockNowMs);
      const inForeground =
        lifecycleObserved && isForeground(lifecycle?.currentState);
      const leavesAtCall = foregroundLeaves;
      return serialized(async () => {
        await hydrate();
        // The authenticated server is the authority over anything the wall
        // clock or an earlier process contributed, so the floor and the
        // in-process mark are replaced. It is not allowed to move the
        // server-derived clock itself backwards: an earlier anchor carried
        // forward on the clocks is at least a lower bound, so the later of
        // the two wins (responses processed out of order, or a server behind
        // an earlier one, never shorten what has elapsed).
        const anchorMs = Math.max(
          serverEpochMs,
          anchorEstimateMs(at) ?? serverEpochMs,
        );
        anchor = {
          serverEpochMs: anchorMs,
          at,
          wallOffsetMs: wall === null ? 0 : Math.floor(wall) - anchorMs,
          foregroundSince: inForeground && foregroundLeaves === leavesAtCall,
        };
        floor = null;
        mark = null;
        await persist(anchorMs);
        return { accepted: true, serverEpochMs };
      });
    },

    read(): Promise<TrustedTimeReading> {
      armLifecycle();
      return serialized(async () => {
        await hydrate();
        const current = reading();
        if (
          current.authority !== 'none' &&
          (lastPersistAttemptMs === null ||
            current.nowMs - lastPersistAttemptMs >=
              TRUSTED_TIME_CHECKPOINT_INTERVAL_MS)
        ) {
          await persist(current.nowMs);
          return reading();
        }
        return current;
      });
    },

    checkpoint,
  });
}

function leaseInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Remaining lease time against a trusted reading. Never grants time on
 * uncertain evidence: no anchor, corrupt storage, a detected clock rollback
 * or a lease issued ahead of the trusted clock all require reconciliation
 * with the server. A `floor` reading is only a lower bound on the true time,
 * so it can prove the lease expired but never that it is still active —
 * `elapsed_unmeasured` names the case where the app left the foreground
 * since the anchor, so the caller can ask for a reconnection.
 */
export function evaluateLease(
  lease: TrustedTimeLease,
  reading: TrustedTimeReading,
): TrustedTimeLeaseVerdict {
  if (
    !leaseInteger(lease.issuedAtMs) ||
    !leaseInteger(lease.expiresAtMs) ||
    lease.expiresAtMs <= lease.issuedAtMs
  )
    return { kind: 'reconcile_required', reason: 'invalid_lease' };
  if (reading.authority === 'none')
    return {
      kind: 'reconcile_required',
      reason:
        reading.storage === 'invalid' ? 'storage_invalid' : 'no_trusted_time',
    };
  if (reading.rollbackDetected)
    return { kind: 'reconcile_required', reason: 'clock_rollback' };
  if (lease.issuedAtMs > reading.nowMs + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS)
    return { kind: 'reconcile_required', reason: 'lease_ahead_of_clock' };
  const effectiveExpiryMs = Math.min(
    lease.expiresAtMs,
    lease.issuedAtMs + TRUSTED_TIME_LEASE_MAX_MS,
  );
  const remainingMs = Math.min(
    effectiveExpiryMs - reading.nowMs,
    TRUSTED_TIME_LEASE_MAX_MS,
  );
  if (remainingMs <= 0) return { kind: 'expired' };
  if (reading.authority !== 'anchored')
    return {
      kind: 'reconcile_required',
      reason:
        reading.continuity === 'unmeasured'
          ? 'elapsed_unmeasured'
          : 'floor_only',
    };
  return { kind: 'active', remainingMs };
}

/** The app's trusted clock: fed by `api.ts` from every authenticated
 * response, checkpointed on every return to the foreground. */
export const trustedTime: TrustedTime = createTrustedTime();
