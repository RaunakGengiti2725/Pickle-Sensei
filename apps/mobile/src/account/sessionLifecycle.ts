import type { ApiSession } from './apiSession';

/**
 * Rotation + revocation for the Supabase session.
 *
 * `refreshApiSession` turns a refresh token into a fresh access/refresh pair
 * (at launch, to restore the persisted session; before expiry, to keep the
 * bearer alive); `revokeApiSession` asks the server to kill this device's
 * session on explicit sign-out. Tokens never touch storage or logs here —
 * the caller decides what to persist (see sessionVault.ts).
 */

const REQUEST_TIMEOUT_MS = 15_000;

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
  /** The server's absolute expiry, as issued (the server's wall clock). */
  bearerExpiresAtMs: number;
  /** How long the bearer lives from the moment it was received. Measured on
   * the server's clock when the response carries a `Date` header, otherwise
   * on the device's — a device clock far ahead of the server makes this
   * negative, which is the caller's cue that the absolute expiry cannot be
   * trusted for scheduling. */
  bearerLifetimeMs: number;
}

/** The server's clock at the time of the response (`Date` header), or null
 * when it sent none (or one that does not parse). */
function serverClockMs(response: Response): number | null {
  const headers: Headers | undefined = response.headers;
  const date = typeof headers?.get === 'function' ? headers.get('date') : null;
  if (!date) return null;
  const parsed = Date.parse(date);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Exchanges a refresh token for a fresh access/refresh pair. Throws
 * SessionRefreshError — retryable for network/server trouble, non-retryable
 * only when the server answers 401/403 (the refresh token is dead).
 */
export async function refreshApiSession(
  input: { apiBaseUrl: string; refreshToken: string },
  options: { fetchFn?: SessionFetch; timeoutMs?: number } = {},
): Promise<RefreshedTokens> {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
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
  const bearerExpiresAtMs = tokens.expiresAt * 1000;
  return {
    bearerToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    bearerExpiresAtMs,
    bearerLifetimeMs:
      bearerExpiresAtMs - (serverClockMs(response) ?? Date.now()),
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
