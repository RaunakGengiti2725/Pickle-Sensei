import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';

/**
 * Trusted time for lease expiry.
 *
 * The device wall clock is user-editable, so an offline lease measured
 * against it could be extended for free by winding the clock back. This
 * module derives "now" from three sources that the user cannot cheaply move:
 *
 *  - server time taken ONLY from authenticated API responses (`Date` header),
 *    which becomes the anchor;
 *  - the process monotonic clock (`performance.now()`), which only counts
 *    forward from that anchor while the process lives;
 *  - a high-water mark persisted in its own THIS_DEVICE_ONLY Keychain service,
 *    the floor below which "now" cannot fall after a relaunch.
 *
 * Every estimate is conservative: the reported `nowMs` is the LARGEST of the
 * trustworthy candidates, so any error shortens a lease and never lengthens
 * it. A wall clock that has moved backwards relative to the anchor is
 * reported as `rollbackDetected`, and `evaluateLease` then requires online
 * reconciliation rather than granting the remaining time. Native elapsed
 * time across reboots is not available here: without an in-process anchor
 * the wall clock is used only when it is consistent with the persisted floor.
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

const MIN_PLAUSIBLE_SERVER_MS = Date.UTC(2025, 0, 1);
const MAX_PLAUSIBLE_SERVER_MS = Date.UTC(2100, 0, 1);
const MAX_RECORD_BYTES = 512;

export type TrustedTimeKeychain = Pick<
  typeof Keychain,
  'ACCESSIBLE' | 'getGenericPassword' | 'setGenericPassword'
>;

export type TrustedTimeAuthority = 'anchored' | 'floor' | 'none';
export type TrustedTimeStorage = 'loaded' | 'empty' | 'invalid' | 'unavailable';

export interface TrustedTimeReading {
  readonly authority: TrustedTimeAuthority;
  /** Conservative estimate of server time now, in epoch milliseconds. */
  readonly nowMs: number;
  readonly wallClockMs: number;
  /** The wall clock moved backwards relative to the anchor or the floor. */
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
        | 'invalid_lease'
        | 'lease_ahead_of_clock';
    };

export interface TrustedTimeDependencies {
  readonly keychain?: TrustedTimeKeychain;
  readonly monotonicNowMs?: () => number;
  readonly wallClockNowMs?: () => number;
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
  readonly serverEpochMs: number;
  readonly highWaterMs: number;
  readonly wallOffsetMs: number;
}

interface Anchor {
  readonly serverEpochMs: number;
  readonly monotonicAtAnchorMs: number;
  readonly wallOffsetMs: number;
}

interface Floor {
  readonly highWaterMs: number;
  readonly wallOffsetMs: number;
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
  const parsed = Date.parse(header);
  return Number.isFinite(parsed) ? Math.floor(parsed) : null;
}

function finiteClock(read: () => number): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
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

export function createTrustedTime(
  dependencies: TrustedTimeDependencies = {},
): TrustedTime {
  const keychain: TrustedTimeKeychain = dependencies.keychain ?? Keychain;
  const monotonicNowMs = dependencies.monotonicNowMs ?? defaultMonotonicNowMs;
  const wallClockNowMs = dependencies.wallClockNowMs ?? Date.now;

  let anchor: Anchor | null = null;
  let floor: Floor | null = null;
  let storage: TrustedTimeStorage = 'unavailable';
  let lastPersistAttemptMs: number | null = null;
  let hydrated = false;
  let queue: Promise<void> = Promise.resolve();

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
      const stored = await keychain.getGenericPassword({
        service: TRUSTED_TIME_KEYCHAIN_SERVICE,
        cloudSync: false,
      });
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
      floor = {
        highWaterMs: record.highWaterMs,
        wallOffsetMs: record.wallOffsetMs,
      };
      lastPersistAttemptMs = record.highWaterMs;
      storage = 'loaded';
    } catch {
      // Keychain access can fail transiently (e.g. before first unlock); the
      // next call tries again.
      hydrated = false;
      storage = 'unavailable';
    }
  }

  function trustedNow(): {
    nowMs: number;
    authority: TrustedTimeAuthority;
    rollbackDetected: boolean;
    wallClockMs: number;
  } {
    const wallClockMs = finiteClock(wallClockNowMs) ?? Number.NaN;
    let authority: TrustedTimeAuthority = 'none';
    let estimateMs: number | null = null;
    let wallOffsetMs = 0;

    if (anchor) {
      const monotonic = finiteClock(monotonicNowMs);
      wallOffsetMs = anchor.wallOffsetMs;
      if (monotonic === null) {
        // No monotonic clock: the anchor is only a floor, like after a relaunch.
        estimateMs = anchor.serverEpochMs;
        authority = 'floor';
      } else {
        const elapsedMs = Math.max(
          0,
          Math.floor(monotonic - anchor.monotonicAtAnchorMs),
        );
        estimateMs = anchor.serverEpochMs + elapsedMs;
        authority = 'anchored';
      }
    }
    if (floor) {
      if (estimateMs === null) {
        estimateMs = floor.highWaterMs;
        wallOffsetMs = floor.wallOffsetMs;
        authority = 'floor';
      } else estimateMs = Math.max(estimateMs, floor.highWaterMs);
    }

    if (estimateMs === null) {
      return {
        nowMs: Number.isFinite(wallClockMs) ? Math.floor(wallClockMs) : 0,
        authority,
        rollbackDetected: false,
        wallClockMs,
      };
    }
    const adjustedWallMs = Number.isFinite(wallClockMs)
      ? Math.floor(wallClockMs - wallOffsetMs)
      : estimateMs;
    return {
      nowMs: Math.max(estimateMs, adjustedWallMs),
      authority,
      rollbackDetected:
        adjustedWallMs < estimateMs - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
      wallClockMs,
    };
  }

  async function persist(highWaterMs: number): Promise<void> {
    if (!anchor) return;
    const record: PersistedAnchor = {
      schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
      serverEpochMs: anchor.serverEpochMs,
      highWaterMs: Math.max(anchor.serverEpochMs, highWaterMs),
      wallOffsetMs: anchor.wallOffsetMs,
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
      const result = await keychain.setGenericPassword(
        TRUSTED_TIME_KEYCHAIN_ACCOUNT,
        JSON.stringify(record),
        {
          service: TRUSTED_TIME_KEYCHAIN_SERVICE,
          accessible,
          cloudSync: false,
        },
      );
      if (
        result !== false &&
        result.service === TRUSTED_TIME_KEYCHAIN_SERVICE
      ) {
        floor = {
          highWaterMs: record.highWaterMs,
          wallOffsetMs: record.wallOffsetMs,
        };
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
      nowMs: current.nowMs,
      wallClockMs: current.wallClockMs,
      rollbackDetected: current.rollbackDetected,
      storage,
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
      return serialized(async () => {
        await hydrate();
        const monotonic = finiteClock(monotonicNowMs);
        const wall = finiteClock(wallClockNowMs);
        // The authenticated server is the authority: leases are issued in its
        // time, so a reading behind the local extrapolation re-anchors rather
        // than being ignored.
        anchor = {
          serverEpochMs,
          monotonicAtAnchorMs: monotonic ?? 0,
          wallOffsetMs: wall === null ? 0 : Math.floor(wall) - serverEpochMs,
        };
        floor = null;
        await persist(serverEpochMs);
        return { accepted: true, serverEpochMs };
      });
    },

    read(): Promise<TrustedTimeReading> {
      return serialized(async () => {
        await hydrate();
        const current = reading();
        if (
          current.authority === 'anchored' &&
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

    checkpoint(): Promise<void> {
      return serialized(async () => {
        await hydrate();
        const current = trustedNow();
        if (current.authority !== 'anchored') return;
        if (
          lastPersistAttemptMs !== null &&
          current.nowMs <= lastPersistAttemptMs
        )
          return;
        await persist(current.nowMs);
      });
    },
  });
}

function leaseInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Remaining lease time against a trusted reading. Never grants time on
 * uncertain evidence: no anchor, corrupt storage, a detected clock rollback
 * or a lease issued ahead of the trusted clock all require reconciliation
 * with the server.
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
  const remainingMs = effectiveExpiryMs - reading.nowMs;
  return remainingMs > 0
    ? { kind: 'active', remainingMs }
    : { kind: 'expired' };
}

/** The app-wide trusted clock, anchored by `src/data/api.ts` on every
 * authenticated response. */
export const trustedTime: TrustedTime = createTrustedTime();
