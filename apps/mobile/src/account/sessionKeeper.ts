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
 * The expiry the server reports is sanity-checked before it drives a timer.
 * One that is already past or inside the refresh lead (device clock ahead of
 * the server, a stale server value) or implausibly far out (a value in the
 * wrong unit) tells the keeper nothing about the bearer's life, so the
 * bearer is assumed to live `ASSUMED_BEARER_LIFE_MS` from its rotation and
 * rotated on that schedule instead; an API 401 still forces a rotation via
 * `refreshSessionNow`. A successful rotation never re-arms sooner than
 * `MIN_ROTATION_DELAY_MS`, and no delay ever exceeds the 32-bit timer range.
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
/** A completed rotation never re-arms sooner than this. */
const MIN_ROTATION_DELAY_MS = 60_000;
/** Bearer life assumed when the reported expiry cannot be trusted. */
const ASSUMED_BEARER_LIFE_MS = 15 * 60_000;
/** No server mints a bearer that outlives this; a longer life is a value in
 * the wrong unit (milliseconds read as seconds). */
const MAX_PLAUSIBLE_BEARER_LIFE_MS = 24 * 3600_000;
/** setTimeout's range; beyond it the delay collapses to ~1 ms. */
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

/** Whether a reported expiry says something usable about the bearer's life:
 * finite, with more life left than the refresh lead, and not implausibly
 * far out. */
function isTrustedBearerExpiry(expiresAtMs: number, nowMs: number): boolean {
  const lifeMs = expiresAtMs - nowMs;
  return (
    Number.isFinite(lifeMs) &&
    lifeMs > REFRESH_LEAD_MS &&
    lifeMs <= MAX_PLAUSIBLE_BEARER_LIFE_MS
  );
}

export function startSessionKeeper(input: SessionKeeperInput): void {
  stopSessionKeeper();
  const myGeneration = generation;
  const now = input.now ?? Date.now;
  let refreshToken = input.refreshToken;
  let bearerExpiresAtMs = input.bearerExpiresAtMs;
  let failedAttempts = 0;
  let inflight = false;

  const live = () => myGeneration === generation;

  const schedule = (delayMs: number, floorMs: number = MIN_DELAY_MS) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void refresh();
      },
      Math.min(MAX_TIMER_DELAY_MS, Math.max(floorMs, delayMs)),
    );
  };

  const scheduleAheadOfExpiry = (floorMs?: number) => {
    schedule((bearerExpiresAtMs ?? now()) - now() - REFRESH_LEAD_MS, floorMs);
  };

  const refresh = async () => {
    if (!live() || inflight) return;
    inflight = true;
    try {
      const tokens = await refreshApiSession(
        { apiBaseUrl: input.apiBaseUrl, refreshToken },
        { fetchFn: input.fetchFn },
      );
      if (!live()) return;
      const rotatedAtMs = now();
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = isTrustedBearerExpiry(
        tokens.bearerExpiresAtMs,
        rotatedAtMs,
      )
        ? tokens.bearerExpiresAtMs
        : rotatedAtMs + ASSUMED_BEARER_LIFE_MS;
      failedAttempts = 0;
      await input.onRotated(tokens);
      if (live()) scheduleAheadOfExpiry(MIN_ROTATION_DELAY_MS);
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

  if (
    bearerExpiresAtMs === null ||
    !isTrustedBearerExpiry(bearerExpiresAtMs, now())
  ) {
    void refresh();
  } else {
    scheduleAheadOfExpiry();
  }
}
