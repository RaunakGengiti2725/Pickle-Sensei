import type { ApiSession } from './apiSession';

/**
 * Rotation + revocation for the Supabase session.
 *
 * `refreshApiSession` turns a refresh token into a fresh access/refresh pair
 * (at launch, to restore the persisted session; before expiry, to keep the
 * bearer alive); `revokeApiSession` asks the server to kill this device's
 * session on explicit sign-out. Tokens never touch storage or logs here —
 * the caller decides what to persist (see sessionVault.ts).
 *
 * The bearer expiry the server reports is normalised HERE, at the HTTP
 * boundary, before anything schedules a timer from it (see
 * `normalizeBearerExpiry`): downstream code may trust `bearerExpiresAtMs`
 * to lie a plausible lifetime ahead of the device clock.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** Shortest bearer lifetime the server may legitimately report. */
export const MIN_BEARER_LIFETIME_MS = 5 * 60_000;
/** Assumed lifetime when the reported expiry cannot be trusted (Supabase's
 * default JWT lifetime). */
export const DEFAULT_BEARER_LIFETIME_MS = 60 * 60_000;
/** Longest bearer lifetime the server may legitimately report. Well below
 * the 2^31-1 ms a timer can wait. */
export const MAX_BEARER_LIFETIME_MS = 24 * 60 * 60_000;
/** An epoch value at or above this can only be milliseconds: as seconds it
 * would be the year 5138, as milliseconds it is March 1973. */
const EPOCH_MILLISECONDS_FROM = 1e11;

/**
 * Turns the `expiresAt` a session response carries into an absolute device
 * time the bearer can be trusted until.
 *
 * The bearer's LIFETIME is what the server actually knows, so it is measured
 * against the server's own clock (`serverNowMs`, from the response `Date`
 * header) when available, and only against the device clock otherwise; the
 * result is then anchored to the device clock, which is the clock every
 * timer runs on. A device clock hours off the server therefore no longer
 * turns a healthy one-hour bearer into an already-expired or three-hour one.
 *
 * `expiresAt` is epoch seconds per the API contract, but an epoch value in
 * milliseconds is recognised rather than multiplied by 1000 again. Any
 * lifetime outside [MIN, MAX] — already past, inside the refresh lead,
 * negative, centuries away — is not a schedule anybody should act on and is
 * replaced by the default lifetime. This never fails: an untrusted expiry
 * is never a reason to drop the session.
 */
export function normalizeBearerExpiry(input: {
  expiresAt: number;
  serverNowMs: number | null;
  clientNowMs: number;
}): number {
  const expiresAtMs =
    Math.abs(input.expiresAt) >= EPOCH_MILLISECONDS_FROM
      ? input.expiresAt
      : input.expiresAt * 1000;
  const lifetimeMs = expiresAtMs - (input.serverNowMs ?? input.clientNowMs);
  const plausible =
    Number.isFinite(lifetimeMs) &&
    lifetimeMs >= MIN_BEARER_LIFETIME_MS &&
    lifetimeMs <= MAX_BEARER_LIFETIME_MS;
  return (
    input.clientNowMs + (plausible ? lifetimeMs : DEFAULT_BEARER_LIFETIME_MS)
  );
}

/** The server's clock at the time of the response, or null when the `Date`
 * header is absent or unparseable. */
function serverNowMsFrom(response: Response): number | null {
  const header = response.headers?.get('date');
  if (!header) return null;
  const parsed = Date.parse(header);
  return Number.isFinite(parsed) ? parsed : null;
}

export class SessionRefreshError extends Error {
  constructor(
    message: string,
    /** false ⇒ the server REFUSED the refresh token (revoked, rotated away,
     * or the account is gone): the session is dead and the user must sign
     * in again. true ⇒ network/server trouble: the session may well still
     * be valid, keep it and retry. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SessionRefreshError';
  }
}

export type SessionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

async function post(
  fetchFn: SessionFetch,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, {
      method: 'POST',
      signal: controller.signal,
      ...init,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export interface RefreshedTokens {
  bearerToken: string;
  refreshToken: string;
  /** Device-clock time the bearer is trusted until; always a plausible
   * lifetime ahead of now (see `normalizeBearerExpiry`). */
  bearerExpiresAtMs: number;
}

/**
 * Exchanges a refresh token for a fresh access/refresh pair. Throws
 * SessionRefreshError — retryable for network/server trouble, non-retryable
 * only when the server answers 401/403 (the refresh token is dead).
 */
export async function refreshApiSession(
  input: { apiBaseUrl: string; refreshToken: string },
  options: {
    fetchFn?: SessionFetch;
    timeoutMs?: number;
    now?: () => number;
  } = {},
): Promise<RefreshedTokens> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await post(
      fetchFn,
      `${input.apiBaseUrl}/v1/auth/refresh`,
      {
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ refreshToken: input.refreshToken }),
      },
      options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    );
  } catch {
    throw new SessionRefreshError(
      'The session could not be refreshed right now.',
      true,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new SessionRefreshError('The session has been revoked.', false);
  }
  const payload = (await response.json().catch(() => null)) as {
    session?: {
      accessToken?: unknown;
      refreshToken?: unknown;
      expiresAt?: unknown;
    };
  } | null;
  const tokens = payload?.session;
  if (
    !response.ok ||
    typeof tokens?.accessToken !== 'string' ||
    !tokens.accessToken.trim() ||
    typeof tokens.refreshToken !== 'string' ||
    !tokens.refreshToken.trim() ||
    typeof tokens.expiresAt !== 'number' ||
    !Number.isFinite(tokens.expiresAt)
  ) {
    throw new SessionRefreshError(
      'The session could not be refreshed right now.',
      true,
    );
  }
  return {
    bearerToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    bearerExpiresAtMs: normalizeBearerExpiry({
      expiresAt: tokens.expiresAt,
      serverNowMs: serverNowMsFrom(response),
      clientNowMs: now(),
    }),
  };
}

/**
 * Best-effort server-side revocation of this device's session. Local
 * material must be cleared by the caller regardless of the outcome; offline,
 * the refresh token still dies at its natural rotation/expiry.
 */
export async function revokeApiSession(
  session: ApiSession,
  fetchFn: SessionFetch = globalThis.fetch,
): Promise<void> {
  try {
    await post(
      fetchFn,
      `${session.apiBaseUrl}/v1/auth/logout`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${session.bearerToken}`,
        },
      },
      REQUEST_TIMEOUT_MS,
    );
  } catch {
    // Offline sign-out: the caller has already cleared local tokens.
  }
}
