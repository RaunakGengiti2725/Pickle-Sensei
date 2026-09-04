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
 *
 * Timers are defensive about the expiry they are given: a wait longer than
 * `setTimeout` can hold is taken in chunks, and a successful rotation never
 * re-arms itself sooner than `ROTATION_SPACING_MS` later — so an expiry the
 * keeper cannot trust costs at most one extra exchange, never a loop.
 */

export interface SessionKeeperInput {
  apiBaseUrl: string;
  refreshToken: string;
  /** null ⇒ no valid bearer yet: refresh right away. */
  bearerExpiresAtMs: number | null;
  onRotated: (tokens: RefreshedTokens) => void | Promise<void>;
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
const MIN_DELAY_MS = 1_000;
/** Two self-scheduled rotations are never closer than this. */
const ROTATION_SPACING_MS = 60_000;
/** Largest delay setTimeout honours (signed 32-bit ms); longer waits are
 * chunked. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let refreshNow: (() => void) | null = null;

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
 * Rotates the bearer right away — for an API route that rejected the current
 * access token ahead of its recorded expiry (clock skew, or a revoked
 * bearer). A refresh already in flight is left alone; the outcome flows
 * through the keeper's own `onRotated` / `onRevoked` exactly as a scheduled
 * rotation would. No-op when no keeper is running.
 */
export function refreshSessionNow(): void {
  refreshNow?.();
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
  let lastRotationAtMs: number | null = null;

  const live = () => myGeneration === generation;

  const arm = (delayMs: number, fire: () => void) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        fire();
      },
      Math.min(
        MAX_TIMER_DELAY_MS,
        Math.max(MIN_DELAY_MS, Number.isFinite(delayMs) ? delayMs : 0),
      ),
    );
  };

  const schedule = (delayMs: number) => arm(delayMs, () => void refresh());

  /** Refreshes at `atMs` on the device clock, however far away that is:
   * a wait beyond the timer range sleeps one full chunk and re-measures. */
  const scheduleAt = (atMs: number) => {
    const delayMs = atMs - now();
    if (delayMs > MAX_TIMER_DELAY_MS) {
      arm(MAX_TIMER_DELAY_MS, () => scheduleAt(atMs));
    } else {
      schedule(delayMs);
    }
  };

  const scheduleAheadOfExpiry = () => {
    const aheadOfExpiryMs = (bearerExpiresAtMs ?? now()) - REFRESH_LEAD_MS;
    scheduleAt(
      lastRotationAtMs === null
        ? aheadOfExpiryMs
        : Math.max(aheadOfExpiryMs, lastRotationAtMs + ROTATION_SPACING_MS),
    );
  };

  const refresh = async () => {
    if (!live() || inflight) return;
    inflight = true;
    try {
      const tokens = await refreshApiSession(
        { apiBaseUrl: input.apiBaseUrl, refreshToken },
        { fetchFn: input.fetchFn, now },
      );
      if (!live()) return;
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = tokens.bearerExpiresAtMs;
      lastRotationAtMs = now();
      failedAttempts = 0;
      await input.onRotated(tokens);
      if (live()) scheduleAheadOfExpiry();
    } catch (error) {
      if (!live()) return;
      if (error instanceof SessionRefreshError && !error.retryable) {
        stopSessionKeeper();
        await input.onRevoked();
        return;
      }
      failedAttempts += 1;
      input.onDeferred?.(error);
      schedule(retryDelayMs(failedAttempts));
    } finally {
      inflight = false;
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
  refreshNow = () => void refresh();

  if (bearerExpiresAtMs === null) {
    void refresh();
  } else {
    scheduleAheadOfExpiry();
  }
}
