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
 * Refresh tokens are single-use: once a request is on the wire the server
 * may already have spent the token, so its outcome can never be dropped.
 * A rotation that lands after `stopSessionKeeper()` is still delivered
 * (`onRotated` with `live: false` — persist it, nothing more), and a keeper
 * started for a token whose exchange is still in flight joins that exchange
 * instead of presenting the spent token a second time.
 */

export interface RotationDelivery {
  /** false ⇒ the keeper was stopped while this exchange was in flight: the
   * caller must still store the rotated token, but the keeper schedules
   * nothing further. */
  live: boolean;
}

export interface SessionKeeperInput {
  apiBaseUrl: string;
  refreshToken: string;
  /** null ⇒ no valid bearer yet: refresh right away. */
  bearerExpiresAtMs: number | null;
  onRotated: (
    tokens: RefreshedTokens,
    delivery: RotationDelivery,
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
const MIN_DELAY_MS = 1_000;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let refreshNow: (() => void) | null = null;

/** The refresh exchange currently on the wire. Cleared when it settles. */
interface RefreshExchange {
  spentToken: string;
  result: Promise<RefreshedTokens>;
  /** The keeper generation that delivers the outcome; a keeper started for
   * the same token while the exchange is in flight takes this over. null ⇒
   * abandoned, nobody delivers it. */
  ownerGeneration: number | null;
}
let inflightExchange: RefreshExchange | null = null;

/** Stops all future work synchronously (timers, foreground checks, new
 * refreshes). An exchange already in flight still delivers its outcome: a
 * rotation is reported through `onRotated` with `live: false`, a refusal or
 * transient failure is dropped. */
export function stopSessionKeeper(): void {
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  removeAppStateListener?.();
  removeAppStateListener = null;
  refreshNow = null;
}

/** `stopSessionKeeper()` for an account whose tokens no longer matter here
 * (sign-out, deletion, revocation): an exchange still in flight is abandoned
 * — its outcome is dropped and no later keeper joins it. */
export function discardSessionKeeper(): void {
  stopSessionKeeper();
  if (inflightExchange) inflightExchange.ownerGeneration = null;
  inflightExchange = null;
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

  const scheduleAheadOfExpiry = () => {
    schedule((bearerExpiresAtMs ?? now()) - now() - REFRESH_LEAD_MS);
  };

  const refresh = async () => {
    if (!live() || inflight) return;
    inflight = true;
    const exchange: RefreshExchange =
      inflightExchange?.spentToken === refreshToken
        ? inflightExchange
        : {
            spentToken: refreshToken,
            result: refreshApiSession(
              { apiBaseUrl: input.apiBaseUrl, refreshToken },
              { fetchFn: input.fetchFn },
            ),
            ownerGeneration: myGeneration,
          };
    exchange.ownerGeneration = myGeneration;
    inflightExchange = exchange;
    const owner = () => exchange.ownerGeneration === myGeneration;
    try {
      const tokens = await exchange.result;
      if (!owner()) return;
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = tokens.bearerExpiresAtMs;
      failedAttempts = 0;
      // The server has already spent the old token: the rotation is delivered
      // even if this keeper was stopped while it was on the wire.
      await input.onRotated(tokens, { live: live() });
      if (live()) scheduleAheadOfExpiry();
    } catch (error) {
      if (!owner() || !live()) return;
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
      if (inflightExchange === exchange) inflightExchange = null;
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
