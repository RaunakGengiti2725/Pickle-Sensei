import type { ApiSession } from './apiSession';

/**
 * Client for the backend's two-step account deletion
 * (App Review 5.1.1(v): apps with account creation must offer in-app
 * account deletion):
 *
 *   POST /v1/me/delete-request → { challenge, expiresAt }
 *   POST /v1/me/delete-confirm { challenge } → { deleted: true }
 *
 * The confirm call must present the challenge minted by a separate prior
 * request, so no single tap — accidental or scripted — can destroy an
 * account. Local sign-out and data-owner reset stay the caller's job
 * (authStore.signOut) after the server confirms deletion.
 */

export type AccountDeletionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class AccountDeletionError extends Error {
  constructor(
    readonly code:
      | 'deletion.not_configured'
      | 'deletion.session_expired'
      | 'deletion.rejected'
      | 'deletion.unavailable',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export interface AccountDeletionChallenge {
  challenge: string;
  expiresAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function post(
  session: ApiSession,
  fetchFn: AccountDeletionFetch,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetchFn(`${session.apiBaseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new AccountDeletionError(
      'deletion.unavailable',
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error bodies fall through to the status checks below.
  }
  if (response.status === 401) {
    throw new AccountDeletionError(
      'deletion.session_expired',
      'Your sign-in has expired. Sign in again, then delete your account.',
      false,
    );
  }
  if (!response.ok) {
    const error =
      isRecord(payload) && isRecord(payload['error']) ? payload['error'] : null;
    const message =
      error && typeof error['message'] === 'string'
        ? error['message']
        : 'The deletion request could not be completed. Nothing was deleted.';
    throw new AccountDeletionError(
      'deletion.rejected',
      message,
      response.status === 429 || response.status >= 500,
    );
  }
  if (!isRecord(payload)) {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server returned an invalid deletion response.',
      false,
    );
  }
  return payload;
}

/** Step 1 — mint the deletion challenge. Destroys nothing by itself. */
export async function requestAccountDeletion(
  session: ApiSession | null,
  fetchFn: AccountDeletionFetch = globalThis.fetch,
): Promise<AccountDeletionChallenge> {
  if (!session) {
    throw new AccountDeletionError(
      'deletion.not_configured',
      'Sign in to a synced account before deleting it.',
      false,
    );
  }
  const payload = await post(session, fetchFn, '/v1/me/delete-request');
  const challenge = payload['challenge'];
  const expiresAt = payload['expiresAt'];
  if (typeof challenge !== 'string' || typeof expiresAt !== 'string') {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server returned an invalid deletion challenge.',
      false,
    );
  }
  return { challenge, expiresAt };
}

/** Step 2 — irreversibly delete the account named by the challenge. */
export async function confirmAccountDeletion(
  session: ApiSession | null,
  challenge: string,
  fetchFn: AccountDeletionFetch = globalThis.fetch,
): Promise<void> {
  if (!session) {
    throw new AccountDeletionError(
      'deletion.not_configured',
      'Sign in to a synced account before deleting it.',
      false,
    );
  }
  const payload = await post(session, fetchFn, '/v1/me/delete-confirm', {
    challenge,
  });
  if (payload['deleted'] !== true) {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server did not confirm the deletion.',
      false,
    );
  }
}
