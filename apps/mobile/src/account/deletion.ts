import type { ApiSession } from './apiSession';

/**
 * Client for the backend's two-step account deletion
 * (App Review 5.1.1(v): apps with account creation must offer in-app
 * account deletion):
 *
 *   POST /v1/me/delete-request { survey? } → { challenge, expiresAt }
 *   POST /v1/me/delete-confirm { challenge } →
 *     { deleted: true, appleAuthorizationRevocation }
 *
 * The confirm call must present the challenge minted by a separate prior
 * request, so no single tap — accidental or scripted — can destroy an
 * account. Local sign-out and data-owner reset stay the caller's job
 * (authStore.completeAccountDeletion) after the server confirms deletion.
 *
 * Only step 2 destroys anything, so only step 2 can end in an UNKNOWN
 * outcome: when the confirm request leaves the device but its response never
 * arrives, the server may have deleted the account. That challenge is
 * remembered as unresolved; the bearer being refused (401) on its retry is
 * then the deletion completing — the account the bearer named is gone — and
 * resolves like a confirmation (with an unknown Apple-revocation outcome)
 * instead of dead-ending at "sign in again".
 *
 * The optional exit survey rides along with step 1 so it is stored BEFORE
 * the account (and the bearer) cease to exist; the server keeps it
 * anonymized after deletion. It is always skippable — the survey must never
 * stand between a player and deleting their account.
 */

export type AccountDeletionFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Exit-survey vocabularies. Each mirrors its server set in
 * supabase/functions/api/index.ts (DELETION_SURVEY_REASONS /
 * DELETION_SURVEY_WANTED) verbatim — the server drops a value it does not
 * know (never the deletion), so add to BOTH lists together. */

/** Question 1 — "What's making you leave?" */
export const ACCOUNT_DELETION_REASONS = [
  'not_using',
  'not_helpful',
  'scores_inaccurate',
  'technical_issues',
  'too_expensive',
  'privacy',
  'other',
] as const;

export type AccountDeletionReason = (typeof ACCOUNT_DELETION_REASONS)[number];

/** Question 2 — "What would have kept you?" */
export const ACCOUNT_DELETION_WANTED = [
  'accuracy',
  'price',
  'content',
  'stability',
  'switched',
  'nothing',
] as const;

export type AccountDeletionWanted = (typeof ACCOUNT_DELETION_WANTED)[number];

/** Free-text cap shared with the server's sanitizer (DELETION_SURVEY_DETAILS_MAX). */
export const ACCOUNT_DELETION_DETAILS_MAX = 500;

export interface AccountDeletionSurvey {
  reason: AccountDeletionReason;
  /** Question 2; null when it was skipped. */
  wanted: AccountDeletionWanted | null;
  /** Optional comment; the caller passes null (not "") when nothing was typed. */
  details: string | null;
  platform: 'ios' | 'android' | null;
  appVersion: string | null;
}

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

export interface AccountDeletionResult {
  /** `unknown` when the deletion was inferred from the bearer being refused
   * after a lost confirm response: the server ran its revocation step, but
   * its verdict never reached the device. */
  appleAuthorizationRevocation:
    'revoked' | 'not_applicable' | 'manual_action_required' | 'unknown';
}

export const DELETE_REQUEST_OFFLINE_MESSAGE =
  'Account deletion is temporarily offline. Nothing was deleted — please try again.';

export const DELETE_CONFIRM_OUTCOME_UNKNOWN_MESSAGE =
  'The connection dropped before the server answered, so we can’t tell yet whether your account was deleted. Tap Permanently delete again — if the account is already gone, we’ll finish signing you out.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Thrown by `send` when no response arrived (network error or timeout). */
class TransportFailure {
  constructor(readonly cause: unknown) {}
}

async function send(
  session: ApiSession,
  fetchFn: AccountDeletionFetch,
  path: string,
  body?: unknown,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    return await fetchFn(`${session.apiBaseUrl}${path}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (cause) {
    throw new TransportFailure(cause);
  } finally {
    clearTimeout(timeout);
  }
}

async function readPayload(
  response: Response,
  rejectedFallback: string,
): Promise<Record<string, unknown>> {
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
        : rejectedFallback;
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

/** Challenges whose confirm request left the device without a response: the
 * deletion may have executed. Cleared by the next definitive answer. */
const unresolvedConfirmations = new Set<string>();

/** Step 1 — mint the deletion challenge. Destroys nothing by itself. A
 * skipped survey sends no body at all (the pre-survey wire shape). */
export async function requestAccountDeletion(
  session: ApiSession | null,
  survey: AccountDeletionSurvey | null = null,
  fetchFn: AccountDeletionFetch = globalThis.fetch,
): Promise<AccountDeletionChallenge> {
  if (!session) {
    throw new AccountDeletionError(
      'deletion.not_configured',
      'Sign in to a synced account before deleting it.',
      false,
    );
  }
  let response: Response;
  try {
    response = await send(
      session,
      fetchFn,
      '/v1/me/delete-request',
      survey ? { survey } : undefined,
    );
  } catch (failure) {
    if (!(failure instanceof TransportFailure)) throw failure;
    throw new AccountDeletionError(
      'deletion.unavailable',
      DELETE_REQUEST_OFFLINE_MESSAGE,
      true,
    );
  }
  const payload = await readPayload(
    response,
    'The deletion request could not be completed. Nothing was deleted.',
  );
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
): Promise<AccountDeletionResult> {
  if (!session) {
    throw new AccountDeletionError(
      'deletion.not_configured',
      'Sign in to a synced account before deleting it.',
      false,
    );
  }
  const previouslyUnresolved = unresolvedConfirmations.has(challenge);
  unresolvedConfirmations.add(challenge);
  let response: Response;
  try {
    response = await send(session, fetchFn, '/v1/me/delete-confirm', {
      challenge,
    });
  } catch (failure) {
    if (!(failure instanceof TransportFailure)) throw failure;
    throw new AccountDeletionError(
      'deletion.unavailable',
      DELETE_CONFIRM_OUTCOME_UNKNOWN_MESSAGE,
      true,
    );
  }
  // A response — any response — is a definitive answer for this challenge.
  unresolvedConfirmations.delete(challenge);
  if (response.status === 401 && previouslyUnresolved) {
    // The bearer named an account that no longer exists: the earlier confirm
    // executed and this retry found nothing left to delete.
    return { appleAuthorizationRevocation: 'unknown' };
  }
  const payload = await readPayload(
    response,
    'The deletion could not be completed — please try again.',
  );
  if (payload['deleted'] !== true) {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server did not confirm the deletion.',
      false,
    );
  }
  const appleAuthorizationRevocation = payload['appleAuthorizationRevocation'];
  if (
    appleAuthorizationRevocation !== 'revoked' &&
    appleAuthorizationRevocation !== 'not_applicable' &&
    appleAuthorizationRevocation !== 'manual_action_required'
  ) {
    // Compatibility with a briefly deployed pre-revocation backend. New
    // servers always return the explicit outcome.
    return { appleAuthorizationRevocation: 'not_applicable' };
  }
  return { appleAuthorizationRevocation };
}
