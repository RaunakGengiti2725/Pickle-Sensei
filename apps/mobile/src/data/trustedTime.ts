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
 *    forward from the anchor — or from the persisted floor after a relaunch —
 *    while the process lives;
 *  - a high-water mark persisted in its own THIS_DEVICE_ONLY Keychain service,
 *    the floor below which "now" cannot fall after a relaunch.
 *
 * Every estimate is conservative: the reported `nowMs` is the LARGEST of the
 * trustworthy candidates, so any error shortens a lease and never lengthens
 * it. Within a process the estimate never decreases: every reading is pinned
 * to the monotonic clock, so a wall clock that later reads lower than the
 * estimate is reported as `rollbackDetected` and `evaluateLease` requires
 * online reconciliation rather than granting the remaining time. The high-
 * water mark is checkpointed to the Keychain in every authority state, so a
 * relaunch never starts below where the previous process got to.
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
 * the monotonic clock has counted forward from it — `nowMs` is trusted.
 * `floor`: only a persisted (or monotonic-less) high-water mark is known —
 * `nowMs` is a lower bound on the true time, never an authorization.
 * `none`: nothing trustworthy; `nowMs` is the raw wall clock.
 */
export type TrustedTimeAuthority = 'anchored' | 'floor' | 'none';
export type TrustedTimeStorage = 'loaded' | 'empty' | 'invalid' | 'unavailable';

export interface TrustedTimeReading {
  readonly authority: TrustedTimeAuthority;
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
  /** Server-derived anchor epoch (an observation, or that observation
   * carried forward on the monotonic clock). */
  readonly serverEpochMs: number;
  readonly highWaterMs: number;
  readonly wallOffsetMs: number;
}

/** Server time pinned to the monotonic clock; never influenced by the wall
 * clock and never lowered within a process. */
interface Anchor {
  readonly serverEpochMs: number;
  readonly monotonicAtAnchorMs: number | null;
  readonly wallOffsetMs: number;
}

/** In-process high-water mark pinned to the monotonic clock. It ratchets on
 * every reading, so once a (possibly wall-clock-derived) time has been
 * reported, no later reading falls below it plus the monotonic elapsed. */
interface Mark {
  readonly highWaterMs: number;
  readonly monotonicAtMarkMs: number | null;
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

function finiteClock(read: () => number): number | null {
  try {
    const value = read();
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function elapsedSince(
  monotonicAtMs: number | null,
  monotonicNowMs: number | null,
): number {
  if (monotonicAtMs === null || monotonicNowMs === null) return 0;
  return Math.max(0, Math.floor(monotonicNowMs - monotonicAtMs));
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
  let mark: Mark | null = null;
  let floor: PersistedAnchor | null = null;
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
      storage = 'loaded';
      // A server anchor observed in this process supersedes whatever an
      // earlier process left behind; the next checkpoint overwrites it.
      if (anchor) return;
      floor = record;
      lastPersistAttemptMs = record.highWaterMs;
    } catch {
      // Keychain access can fail transiently (e.g. before first unlock); the
      // next call tries again.
      hydrated = false;
      storage = 'unavailable';
    }
  }

  function anchorEstimateMs(monotonic: number | null): number | null {
    if (!anchor) return null;
    return (
      anchor.serverEpochMs + elapsedSince(anchor.monotonicAtAnchorMs, monotonic)
    );
  }

  function trustedNow(): {
    nowMs: number;
    authority: TrustedTimeAuthority;
    rollbackDetected: boolean;
    wallClockMs: number;
  } {
    const wallClockMs = finiteClock(wallClockNowMs) ?? Number.NaN;
    const monotonic = finiteClock(monotonicNowMs);
    let authority: TrustedTimeAuthority = 'none';
    let estimateMs: number | null = null;
    let wallOffsetMs = 0;

    const fromAnchor = anchorEstimateMs(monotonic);
    if (anchor && fromAnchor !== null) {
      estimateMs = fromAnchor;
      wallOffsetMs = anchor.wallOffsetMs;
      // Without a monotonic clock the anchor is only a floor, like after a
      // relaunch.
      authority =
        monotonic === null || anchor.monotonicAtAnchorMs === null
          ? 'floor'
          : 'anchored';
    }
    if (floor) {
      if (estimateMs === null) {
        estimateMs = floor.highWaterMs;
        wallOffsetMs = floor.wallOffsetMs;
        authority = 'floor';
      } else estimateMs = Math.max(estimateMs, floor.highWaterMs);
    }
    if (mark) {
      const fromMark =
        mark.highWaterMs + elapsedSince(mark.monotonicAtMarkMs, monotonic);
      if (estimateMs === null) {
        estimateMs = fromMark;
        authority = 'floor';
      } else estimateMs = Math.max(estimateMs, fromMark);
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
    const nowMs = Math.max(estimateMs, adjustedWallMs);
    // Pin what was just reported to the monotonic clock: a later reading can
    // only be this plus the monotonic elapsed, whatever the wall clock says.
    mark = { highWaterMs: nowMs, monotonicAtMarkMs: monotonic };
    return {
      nowMs,
      authority,
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
        // The authenticated server is the authority over anything the wall
        // clock or an earlier process contributed, so the floor and the
        // in-process mark are replaced. It is not allowed to move the
        // server-derived clock itself backwards: an earlier anchor carried
        // forward on the monotonic clock is equally trustworthy, so the
        // later of the two wins (responses processed out of order, or a
        // server behind an earlier one, never shorten what has elapsed).
        const anchorMs = Math.max(
          serverEpochMs,
          anchorEstimateMs(monotonic) ?? serverEpochMs,
        );
        anchor = {
          serverEpochMs: anchorMs,
          monotonicAtAnchorMs: monotonic,
          wallOffsetMs: wall === null ? 0 : Math.floor(wall) - anchorMs,
        };
        floor = null;
        mark = null;
        await persist(anchorMs);
        return { accepted: true, serverEpochMs };
      });
    },

    read(): Promise<TrustedTimeReading> {
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

    checkpoint(): Promise<void> {
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
 * with the server. A `floor` reading is only a lower bound on the true time,
 * so it can prove the lease expired but never that it is still active.
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
  if (remainingMs <= 0) return { kind: 'expired' };
  if (reading.authority !== 'anchored')
    return { kind: 'reconcile_required', reason: 'floor_only' };
  return { kind: 'active', remainingMs };
}

/** The app-wide trusted clock, anchored by `src/data/api.ts` on every
 * authenticated response. */
export const trustedTime: TrustedTime = createTrustedTime();
