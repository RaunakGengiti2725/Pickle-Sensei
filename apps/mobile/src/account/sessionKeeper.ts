import { AppState } from 'react-native';
import {
  refreshApiSession,
  SessionRefreshError,
  type RefreshedTokens,
  type SessionFetch,
} from './sessionLifecycle';

/**
 * Keeps the signed-in session alive for as long as the account exists.
 *
 * The keeper owns the current refresh token for one account and rotates the
 * access token ahead of its expiry; after a transient failure it retries with
 * backoff, and on every return to the foreground it re-checks the bearer
 * (timers do not fire while iOS suspends the app, so a bearer that expired
 * overnight is refreshed the moment the app is opened). Started without a
 * bearer (a persisted session at launch) it refreshes immediately.
 *
 * The ONE outcome that ends the session is the server refusing the refresh
 * token (`onRevoked`): it was logged out, rotated away, or the account is
 * gone. Being offline, a 5xx, a timeout — none of those ever sign the user
 * out; they just schedule another try.
 */

export interface SessionKeeperInput {
  apiBaseUrl: string;
  refreshToken: string;
  /** null ⇒ no valid bearer yet: refresh right away. */
  bearerExpiresAtMs: number | null;
  /** `refreshSeq` numbers the refresh that produced these tokens; compare it
   * with what `refreshSessionNow()` returned to tell a rotation that began
   * after that call from one that was already under way. */
  onRotated: (
    tokens: RefreshedTokens,
    refreshSeq: number,
  ) => void | Promise<void>;
  onRevoked: () => void | Promise<void>;
  /** A refresh failed for a transient reason and a retry is scheduled. */
  onDeferred?: (error: unknown) => void;
  fetchFn?: SessionFetch;
  now?: () => number;
}

/** Rotate this long before the bearer expires. */
const REFRESH_LEAD_MS = 60_000;
/** On foreground, a bearer with less life than this is refreshed at once. */
const FOREGROUND_LEAD_MS = 5 * 60_000;
/**
 * Floor between two successful rotations. A bearer whose reported expiry is
 * already inside the refresh lead (or in the past, when the phone clock lags
 * the server's) would otherwise re-arm at MIN_DELAY_MS and hammer the refresh
 * route once a second; the server still honours the bearer by its own clock,
 * and a route that does reject it calls `refreshSessionNow()`.
 */
export const MIN_ROTATION_GAP_MS = 30_000;
const MIN_DELAY_MS = 1_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let refreshNow: ((mode: RefreshNowMode) => number) | null = null;
/** Numbers every refresh ever started, across keepers. */
let refreshSeq = 0;

/** Stops all future work synchronously; an in-flight refresh's result is
 * dropped when it lands. */
export function stopSessionKeeper(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  removeAppStateListener?.();
  removeAppStateListener = null;
  refreshNow = null;
}

/**
 * What a refresh already in flight means to `refreshSessionNow()`:
 * - `coalesce`: it will mint the bearer the callers need — a storm of 401s on
 *   one expired bearer costs exactly one refresh.
 * - `after_inflight`: it cannot answer, because it was on its way before the
 *   route said 401; one more refresh runs as soon as it lands.
 */
export type RefreshNowMode = 'coalesce' | 'after_inflight';

/**
 * Rotates the bearer right away — for an API route that rejected the current
 * access token ahead of its recorded expiry (clock skew, or a revoked
 * bearer). The outcome flows through the keeper's own `onRotated` /
 * `onRevoked` exactly as a scheduled rotation would. Returns the sequence
 * number of the refresh that answers this call (see `RefreshNowMode` for
 * which one that is while a refresh is in flight). With no keeper running
 * nothing is started; the returned number is the one the next keeper's
 * first refresh would carry.
 */
export function refreshSessionNow(mode: RefreshNowMode = 'coalesce'): number {
  return refreshNow ? refreshNow(mode) : refreshSeq + 1;
}

export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

export function startSessionKeeper(input: SessionKeeperInput): void {
  stopSessionKeeper();
  const myGeneration = generation;
  const now = input.now ?? Date.now;
  let refreshToken = input.refreshToken;
  let bearerExpiresAtMs = input.bearerExpiresAtMs;
  let failedAttempts = 0;
  let inflight = false;
  // `refreshSessionNow()` arrived while a refresh was in flight: rotate once
  // more as soon as it lands instead of waiting for the next scheduled one.
  let followUp = false;

  const live = () => myGeneration === generation;

  const schedule = (delayMs: number) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void refresh();
      },
      Math.max(MIN_DELAY_MS, delayMs),
    );
  };

  const scheduleAheadOfExpiry = (floorMs: number) => {
    const untilExpiry = (bearerExpiresAtMs ?? now()) - now();
    schedule(Math.max(untilExpiry - REFRESH_LEAD_MS, floorMs));
  };

  const refresh = async () => {
    if (!live() || inflight) return;
    inflight = true;
    refreshSeq += 1;
    const seq = refreshSeq;
    let again = false;
    try {
      const tokens = await refreshApiSession(
        { apiBaseUrl: input.apiBaseUrl, refreshToken },
        { fetchFn: input.fetchFn },
      );
      if (!live()) return;
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = tokens.bearerExpiresAtMs;
      failedAttempts = 0;
      await input.onRotated(tokens, seq);
      if (!live()) return;
      if (followUp) {
        again = true;
      } else {
        scheduleAheadOfExpiry(MIN_ROTATION_GAP_MS);
      }
    } catch (error) {
      if (!live()) return;
      if (error instanceof SessionRefreshError && !error.retryable) {
        stopSessionKeeper();
        await input.onRevoked();
        return;
      }
      failedAttempts += 1;
      input.onDeferred?.(error);
      // The backoff retry is the next refresh to start, so it also answers a
      // follow-up that was queued behind this one.
      followUp = false;
      schedule(retryDelayMs(failedAttempts));
    } finally {
      inflight = false;
    }
    if (again) {
      followUp = false;
      void refresh();
    }
  };

  const subscription = AppState.addEventListener('change', nextState => {
    if (nextState !== 'active' || !live()) return;
    if (
      bearerExpiresAtMs === null ||
      bearerExpiresAtMs - now() < FOREGROUND_LEAD_MS
    ) {
      void refresh();
    }
  });
  removeAppStateListener = () => subscription.remove();
  // A completed refresh reschedules itself (success → ahead of the new
  // expiry, transient failure → backoff), so the pending timer is left to
  // `schedule` to replace.
  refreshNow = mode => {
    if (inflight) {
      if (mode === 'coalesce') return followUp ? refreshSeq + 1 : refreshSeq;
      followUp = true;
      return refreshSeq + 1;
    }
    void refresh();
    return refreshSeq;
  };

  if (bearerExpiresAtMs === null) {
    void refresh();
  } else {
    scheduleAheadOfExpiry(MIN_DELAY_MS);
  }
}
