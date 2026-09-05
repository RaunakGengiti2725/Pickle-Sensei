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
  onRotated: (
    tokens: RefreshedTokens,
  ) => boolean | void | Promise<boolean | void>;
  pendingTokens?: RefreshedTokens;
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
const MIN_RENEWAL_INTERVAL_MS = 5_000;
const LEGACY_RENEWAL_COOLDOWN_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

let generation = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let refreshNow: (() => void) | null = null;
let currentRefresh: Promise<RefreshedTokens | null> | null = null;

/** Stops all future work synchronously; an in-flight refresh's result is
 * dropped when it lands. */
export function stopSessionKeeper(): Promise<RefreshedTokens | null> | null {
  const stoppedRefresh = currentRefresh;
  currentRefresh = null;
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = null;
  removeAppStateListener?.();
  removeAppStateListener = null;
  refreshNow = null;
  return stoppedRefresh;
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
  const clock = (
    globalThis as typeof globalThis & {
      performance?: { now(): number };
    }
  ).performance;
  const elapsedNow = clock ? () => clock.now() : now;
  let refreshToken = input.refreshToken;
  let pendingTokens = input.pendingTokens ?? null;
  let failedAttempts = 0;
  let inflight = false;
  let persistenceInFlight = false;
  let forceAfterPersistence = false;
  let renewalAt: number | null = null;
  let foregroundAt: number | null = null;
  let networkRetryAt = 0;

  const live = () => myGeneration === generation;

  const setBearerTiming = (expiresAtMs: number | null, fresh: boolean) => {
    if (expiresAtMs === null) {
      renewalAt = null;
      foregroundAt = null;
      return;
    }
    const remaining = expiresAtMs - now();
    const receivedAt = elapsedNow();
    if (remaining > 0 && Number.isFinite(remaining)) {
      const minimum = fresh ? MIN_RENEWAL_INTERVAL_MS : 0;
      renewalAt =
        receivedAt +
        Math.max(minimum, remaining - Math.min(REFRESH_LEAD_MS, remaining / 5));
      foregroundAt =
        receivedAt +
        Math.max(
          minimum,
          remaining - Math.min(FOREGROUND_LEAD_MS, remaining / 5),
        );
    } else {
      renewalAt = receivedAt + (fresh ? LEGACY_RENEWAL_COOLDOWN_MS : 0);
      foregroundAt = renewalAt;
    }
  };

  setBearerTiming(input.bearerExpiresAtMs, pendingTokens !== null);

  const schedule = (delayMs: number) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        timer = null;
        void refresh();
      },
      Math.max(MIN_DELAY_MS, Math.min(MAX_TIMER_DELAY_MS, delayMs)),
    );
  };

  const scheduleAheadOfExpiry = () => {
    schedule(
      Math.max(renewalAt ?? elapsedNow(), networkRetryAt) - elapsedNow(),
    );
  };

  const refresh = async (forceNetwork = false) => {
    if (!live()) return;
    if (inflight) {
      if (forceNetwork && persistenceInFlight) forceAfterPersistence = true;
      return;
    }
    const needsNetwork =
      !pendingTokens ||
      forceNetwork ||
      (renewalAt !== null && elapsedNow() >= renewalAt);
    const canUseNetwork = forceNetwork || elapsedNow() >= networkRetryAt;
    if (needsNetwork && !canUseNetwork && !pendingTokens) {
      schedule(networkRetryAt - elapsedNow());
      return;
    }
    inflight = true;
    let requested = false;
    try {
      if (needsNetwork && canUseNetwork) {
        requested = true;
        const request = refreshApiSession(
          { apiBaseUrl: input.apiBaseUrl, refreshToken },
          { fetchFn: input.fetchFn },
        );
        currentRefresh = request.catch(() => null);
        const tokens = await request;
        if (!live()) return;
        currentRefresh = null;
        pendingTokens = tokens;
        setBearerTiming(tokens.bearerExpiresAtMs, true);
        networkRetryAt = 0;
      }
      if (!live() || !pendingTokens) return;
      refreshToken = pendingTokens.refreshToken;
      persistenceInFlight = true;
      if ((await input.onRotated(pendingTokens)) === false) {
        throw new Error(
          'The refreshed session could not be saved securely yet.',
        );
      }
      if (!live()) return;
      pendingTokens = null;
      failedAttempts = 0;
      scheduleAheadOfExpiry();
    } catch (error) {
      if (!live()) return;
      if (error instanceof SessionRefreshError && !error.retryable) {
        stopSessionKeeper();
        await input.onRevoked();
        return;
      }
      failedAttempts += 1;
      const delay = retryDelayMs(failedAttempts);
      if (requested) networkRetryAt = elapsedNow() + delay;
      input.onDeferred?.(error);
      schedule(delay);
    } finally {
      if (live()) currentRefresh = null;
      persistenceInFlight = false;
      inflight = false;
      if (live() && forceAfterPersistence) {
        forceAfterPersistence = false;
        void refresh(true);
      }
    }
  };

  const subscription = AppState.addEventListener('change', nextState => {
    if (nextState !== 'active' || !live()) return;
    if (
      pendingTokens !== null ||
      foregroundAt === null ||
      elapsedNow() >= foregroundAt
    ) {
      void refresh();
    }
  });
  removeAppStateListener = () => subscription.remove();
  // A completed refresh reschedules itself (success → ahead of the new
  // expiry, transient failure → backoff), so the pending timer is left to
  // `schedule` to replace.
  refreshNow = () => void refresh(true);

  if (pendingTokens) {
    schedule(RETRY_BASE_MS);
  } else if (input.bearerExpiresAtMs === null) {
    void refresh();
  } else {
    scheduleAheadOfExpiry();
  }
}
