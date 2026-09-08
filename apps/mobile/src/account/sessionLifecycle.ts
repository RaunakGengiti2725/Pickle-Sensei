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

class SessionRequestTimeoutError extends Error {
  constructor() {
    super('The session request timed out.');
    this.name = 'SessionRequestTimeoutError';
  }
}

/**
 * POSTs and consumes the response inside ONE deadline: headers arriving is
 * not completion, so the timer keeps running until `consume` (the body read)
 * settles, and a transport that ignores the abort signal cannot hold the
 * caller past it either. A synchronous `consume` verdict (a status that
 * needs no body) settles in the same tick the headers land.
 */
function post<T>(
  fetchFn: SessionFetch,
  url: string,
  init: Omit<RequestInit, 'method' | 'signal'>,
  timeoutMs: number,
  consume: (response: Response) => T | Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      reject(new SessionRequestTimeoutError());
    }, timeoutMs);
    const succeed = (value: T) => {
      clearTimeout(timeout);
      resolve(value);
    };
    const fail = (error: unknown) => {
      clearTimeout(timeout);
      reject(error);
    };
    const deliver = (response: Response) => {
      try {
        const answer = consume(response);
        if (answer instanceof Promise) answer.then(succeed, fail);
        else succeed(answer);
      } catch (error) {
        fail(error);
      }
    };
    try {
      fetchFn(url, {
        method: 'POST',
        signal: controller.signal,
        ...init,
      }).then(deliver, fail);
    } catch (error) {
      fail(error);
    }
  });
}

export interface RefreshedTokens {
  bearerToken: string;
  refreshToken: string;
  bearerExpiresAtMs: number;
}

type RefreshPayload = {
  session?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
  };
} | null;

type RefreshAnswer =
  { refused: true } | { refused: false; ok: boolean; payload: RefreshPayload };

function readRefreshAnswer(
  response: Response,
): RefreshAnswer | Promise<RefreshAnswer> {
  if (response.status === 401 || response.status === 403) {
    return { refused: true };
  }
  return response
    .json()
    .catch(() => null)
    .then((payload: RefreshPayload) => ({
      refused: false,
      ok: response.ok,
      payload,
    }));
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
  let answer: RefreshAnswer;
  try {
    answer = await post(
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
      readRefreshAnswer,
    );
  } catch {
    throw new SessionRefreshError(
      'The session could not be refreshed right now.',
      true,
    );
  }
  if (answer.refused) {
    throw new SessionRefreshError('The session has been revoked.', false);
  }
  const tokens = answer.payload?.session;
  if (
    !answer.ok ||
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
    bearerExpiresAtMs: tokens.expiresAt * 1000,
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
      () => undefined,
    );
  } catch {
    // Offline sign-out: the caller has already cleared local tokens.
  }
}
