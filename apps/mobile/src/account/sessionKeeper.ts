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
 * The server's expiry is a hint, not an order. Before it drives a timer it
 * is classified by `rotationLeadMs`: a finite expiry no further out than
 * MAX_TRUSTED_LIFE_MS with room for the refresh lead is TRUSTED and the
 * bearer is rotated exactly REFRESH_LEAD_MS before it. Anything else — a
 * value that is not a number, an epoch-millisecond `expiresAt` that
 * `refreshApiSession` scaled again, a far-future clock, an expiry already in
 * the past or inside the lead — gives the keeper nothing to schedule from:
 * at launch it exchanges the refresh token right away (as it does for null),
 * and after a successful rotation it re-checks on the PACED schedule
 * (`pacedRotationDelayMs`: 30 s, doubling to 5 min for as long as the
 * server keeps answering that way) instead of once a second or once a
 * millisecond. Every delay still passes through `clampDelayMs`, so no
 * timer is ever armed outside [MIN_DELAY_MS, MAX_DELAY_MS]. An expiry the
 * keeper cannot trust is never a reason to sign the user out.
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
/**
 * Floor between two successful rotations, and the first paced re-check after
 * a rotation whose expiry gave nothing to schedule from. A bearer whose
 * reported expiry is already inside the refresh lead (or in the past, when
 * the phone clock lags the server's) would otherwise re-arm at MIN_DELAY_MS
 * and hammer the refresh route once a second; the server still honours the
 * bearer by its own clock, and a route that does reject it calls
 * `refreshSessionNow()`.
 */
export const MIN_ROTATION_GAP_MS = 30_000;
/**
 * Longest life the server can have meant for a bearer: Supabase caps a JWT
 * at 7 days (auth.jwt_expiry ≤ 604 800 s); the extra day absorbs a phone
 * clock behind the server's. An expiry further out than this is not one the
 * server issued — an epoch-millisecond `expiresAt` scaled to milliseconds
 * again lands ~50 000 years out — so it is not trusted to drive a timer.
 */
export const MAX_TRUSTED_LIFE_MS = 8 * 24 * 60 * 60_000;
/**
 * Ceiling on any delay the keeper arms. A trusted bearer that lives longer
 * than a day is re-checked daily rather than parking the timer, and every
 * delay stays inside setTimeout's signed 32-bit range (2**31-1 ms, ~24.8
 * days) — past it Node collapses the delay to 1 ms, which would turn one bad
 * expiry into a refresh exchange + Keychain write every millisecond.
 */
export const MAX_DELAY_MS = 24 * 60 * 60_000;
const MIN_DELAY_MS = 1_000;
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

/**
 * Pace of re-checks while the server keeps answering with an expiry the
 * keeper cannot schedule from (`streak` = consecutive such rotations, ≥ 1):
 * 30 s, 1 min, 2 min, 4 min, then 5 min. Bounds a stale, skewed or
 * millisecond-scaled expiry to a handful of exchanges per hour without ever
 * parking a bearer whose real life is unknown for a day.
 */
export function pacedRotationDelayMs(streak: number): number {
  return Math.min(
    RETRY_MAX_MS,
    MIN_ROTATION_GAP_MS * 2 ** Math.max(0, streak - 1),
  );
}

/** Every timer the keeper arms lands in [MIN_DELAY_MS, MAX_DELAY_MS]. */
export function clampDelayMs(delayMs: number): number {
  return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, delayMs));
}

/**
 * Life left in a bearer whose expiry the keeper can trust, or null when the
 * expiry is unknown, not a finite number, or further out than
 * MAX_TRUSTED_LIFE_MS. A trusted expiry may lie in the past (the phone clock
 * is ahead of the server's): the bearer is then due, not implausible.
 */
export function trustedLifeMs(
  expiresAtMs: number | null,
  nowMs: number,
): number | null {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return null;
  const life = expiresAtMs - nowMs;
  return life > MAX_TRUSTED_LIFE_MS ? null : life;
}

/**
 * Delay until the bearer should be rotated (REFRESH_LEAD_MS before a trusted
 * expiry), or null when the expiry gives nothing to schedule from: untrusted,
 * or already inside the lead / in the past.
 */
export function rotationLeadMs(
  expiresAtMs: number | null,
  nowMs: number,
): number | null {
  const life = trustedLifeMs(expiresAtMs, nowMs);
  if (life === null) return null;
  const lead = life - REFRESH_LEAD_MS;
  return lead > 0 ? lead : null;
}

export function startSessionKeeper(input: SessionKeeperInput): void {
  stopSessionKeeper();
  const myGeneration = generation;
  const now = input.now ?? Date.now;
  let refreshToken = input.refreshToken;
  let bearerExpiresAtMs = input.bearerExpiresAtMs;
  let failedAttempts = 0;
  /** Consecutive rotations whose expiry could not be scheduled from. */
  let unscheduledRotations = 0;
  let inflight = false;

  const live = () => myGeneration === generation;

  const schedule = (delayMs: number) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void refresh();
    }, clampDelayMs(delayMs));
  };

  const scheduleAfterRotation = () => {
    const lead = rotationLeadMs(bearerExpiresAtMs, now());
    if (lead === null) {
      unscheduledRotations += 1;
      schedule(pacedRotationDelayMs(unscheduledRotations));
      return;
    }
    unscheduledRotations = 0;
    schedule(Math.max(lead, MIN_ROTATION_GAP_MS));
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
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = tokens.bearerExpiresAtMs;
      failedAttempts = 0;
      await input.onRotated(tokens);
      if (live()) scheduleAfterRotation();
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
    // Only a bearer KNOWN to have life left is left alone; an unknown or
    // untrusted expiry is re-checked now that the user is back.
    const life = trustedLifeMs(bearerExpiresAtMs, now());
    if (life === null || life < FOREGROUND_LEAD_MS) {
      void refresh();
    }
  });
  removeAppStateListener = () => subscription.remove();
  // A completed refresh reschedules itself (success → ahead of the new
  // expiry, transient failure → backoff), so the pending timer is left to
  // `schedule` to replace.
  refreshNow = () => void refresh();

  const launchLead = rotationLeadMs(bearerExpiresAtMs, now());
  if (launchLead === null) {
    void refresh();
  } else {
    schedule(launchLead);
  }
}
