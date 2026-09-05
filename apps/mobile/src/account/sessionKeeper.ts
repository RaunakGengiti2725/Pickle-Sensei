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
 * The bearer expiry is an INPUT to the timer, never its master. The keeper
 * classifies each expiry into a trust band before it drives anything: a
 * lifetime past the refresh lead and no longer than a real bearer can live is
 * trusted and yields the exact 60 s-before-expiry rotation; anything else —
 * already past, inside the lead, absurdly far out, NaN, or a value that was
 * scaled to milliseconds one time too many — is treated as "no usable
 * expiry": the keeper then paces itself (never closer than
 * MIN_ROTATION_GAP_MS, doubling while the server keeps answering with an
 * untrusted expiry, capped at RETRY_MAX_MS) and the very next trusted answer
 * snaps it back onto the normal schedule. Every rotation the keeper decides
 * on by itself (timer, or a foreground with no trusted expiry to judge by)
 * passes one rate gate keyed on the last successful rotation — only a route
 * that actually saw the bearer refused (`refreshSessionNow`) or a trusted
 * bearer about to run out on foreground goes straight through — and every
 * timer is armed by DEADLINE in chunks that
 * fit a 32-bit signed delay, so no expiry the server or the vault can produce
 * ever turns into a per-second refresh + Keychain write loop. None of this
 * signs the user out: an expiry the keeper cannot trust is a scheduling
 * problem, not a revocation.
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
/**
 * Longest bearer lifetime the keeper will schedule against. Supabase Auth
 * caps a JWT's lifetime at one week; a reported expiry further out than this
 * is not a bearer lifetime (an epoch-millisecond `expiresAt` multiplied by
 * 1000 lands ~56 000 years out) and is treated as untrusted.
 */
export const MAX_TRUSTED_LIFETIME_MS = 7 * 24 * 3600_000;
/**
 * Largest delay a JS timer accepts as-is: Node and Hermes take a 32-bit
 * signed integer, and Node (like @sinonjs/fake-timers) collapses anything
 * over it to 1 ms with a TimeoutOverflowWarning. Timers are armed by
 * deadline in chunks no longer than this.
 */
export const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * Rotation pace while the server keeps answering with an expiry the keeper
 * cannot trust: 30 s, 60 s, 120 s, 240 s, then every RETRY_MAX_MS. The bearer
 * is honoured by the server's own clock in the meantime, and a route that
 * does reject it calls `refreshSessionNow()`.
 */
export function untrustedExpiryGapMs(streak: number): number {
  return Math.min(
    RETRY_MAX_MS,
    MIN_ROTATION_GAP_MS * 2 ** Math.max(0, streak - 1),
  );
}

/**
 * Milliseconds until `expiresAtMs`, or null when the keeper must not let
 * that value drive a timer (see the trust band in the module comment).
 */
export function trustedLifetimeMs(
  expiresAtMs: number | null,
  nowMs: number,
): number | null {
  if (expiresAtMs === null || !Number.isFinite(expiresAtMs)) return null;
  const lifetime = expiresAtMs - nowMs;
  if (!(lifetime > REFRESH_LEAD_MS)) return null;
  if (lifetime > MAX_TRUSTED_LIFETIME_MS) return null;
  return lifetime;
}

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
  let untrustedExpiries = 0;
  let lastRotationAtMs: number | null = null;
  let inflight = false;

  const live = () => myGeneration === generation;

  /**
   * Arms the one pending timer for an absolute deadline. A deadline further
   * out than a timer can hold is approached in MAX_TIMER_DELAY_MS chunks
   * that re-check the clock, so the delay handed to setTimeout is always in
   * range and a suspended-then-resumed app never fires early or never.
   */
  const armAt = (dueAtMs: number) => {
    if (!live()) return;
    if (timer) clearTimeout(timer);
    const remaining = dueAtMs - now();
    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(MIN_DELAY_MS, Number.isFinite(remaining) ? remaining : 0),
    );
    timer = setTimeout(() => {
      timer = null;
      if (!live()) return;
      if (dueAtMs - now() > MIN_DELAY_MS) {
        armAt(dueAtMs);
        return;
      }
      void refresh();
    }, delay);
  };

  const schedule = (delayMs: number) => armAt(now() + delayMs);

  /**
   * The moment the current bearer should be rotated: 60 s before a trusted
   * expiry, or (untrusted expiry) the paced gap after the last rotation.
   */
  const nextRotationDueAtMs = (): number => {
    const t = now();
    const lifetime = trustedLifetimeMs(bearerExpiresAtMs, t);
    const since = lastRotationAtMs ?? t;
    if (lifetime === null)
      return since + untrustedExpiryGapMs(untrustedExpiries);
    return Math.max(
      t + lifetime - REFRESH_LEAD_MS,
      since + MIN_ROTATION_GAP_MS,
    );
  };

  const scheduleAheadOfExpiry = () => armAt(nextRotationDueAtMs());

  /**
   * Rate gate for rotations the keeper decides on by itself (timer, or a
   * foreground with no trusted expiry to judge the bearer by): one that
   * lands inside MIN_ROTATION_GAP_MS of the previous success is coalesced
   * onto a single timer at exactly `lastRotation + MIN_ROTATION_GAP_MS`
   * instead of exchanged. A route that actually saw the bearer refused
   * (`refreshSessionNow`) bypasses it — that is the fact the gate is
   * standing in for.
   */
  const rotationAllowedNow = (): boolean => {
    if (lastRotationAtMs === null) return true;
    const gateOpensAt = lastRotationAtMs + MIN_ROTATION_GAP_MS;
    if (now() >= gateOpensAt) return true;
    armAt(gateOpensAt);
    return false;
  };

  const refresh = async (gated = true) => {
    if (!live() || inflight) return;
    if (gated && !rotationAllowedNow()) return;
    inflight = true;
    try {
      const tokens = await refreshApiSession(
        { apiBaseUrl: input.apiBaseUrl, refreshToken },
        { fetchFn: input.fetchFn },
      );
      if (!live()) return;
      refreshToken = tokens.refreshToken;
      bearerExpiresAtMs = tokens.bearerExpiresAtMs;
      lastRotationAtMs = now();
      failedAttempts = 0;
      untrustedExpiries =
        trustedLifetimeMs(bearerExpiresAtMs, lastRotationAtMs) === null
          ? untrustedExpiries + 1
          : 0;
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
    const lifetime = trustedLifetimeMs(bearerExpiresAtMs, now());
    // A trusted bearer that is about to run out is refreshed at once; with
    // no trusted expiry the bearer is unjudgeable, so the rotation gate
    // decides (a just-rotated bearer is almost certainly still good).
    if (lifetime === null) void refresh(true);
    else if (lifetime < FOREGROUND_LEAD_MS) void refresh(false);
  });
  removeAppStateListener = () => subscription.remove();
  // A completed refresh reschedules itself (success → ahead of the new
  // expiry, transient failure → backoff), so the pending timer is left to
  // `schedule` to replace.
  refreshNow = () => void refresh(false);

  // No bearer, or one whose expiry cannot be trusted (a millisecond-scaled
  // value restored from the vault, say): exchange right away and let the
  // server's answer set the schedule.
  if (trustedLifetimeMs(bearerExpiresAtMs, now()) === null) {
    void refresh();
  } else {
    scheduleAheadOfExpiry();
  }
}
