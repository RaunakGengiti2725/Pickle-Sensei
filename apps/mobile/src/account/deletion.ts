import { reportApiUnauthorized, type ApiSession } from './apiSession';

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
 * delete-confirm is the one call whose failure is ambiguous: the server
 * commits the delete before answering, so a timeout or dropped connection
 * may hide a deletion that already happened — after which the bearer is
 * dead and every later call, including a retry on the same challenge,
 * answers 401. This client remembers each confirm that went out unanswered
 * and resolves that 401 as an inferred deletion (see
 * `AccountDeletionResult`), so the caller finishes the local teardown
 * instead of sending the user to sign in to an account that is gone.
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
  /** `unconfirmed`: the deletion was inferred from a 401 on a challenge
   * whose confirm went out unanswered — the server's revocation outcome was
   * in the lost reply, so an Apple account may still need the manual
   * "Stop Using Apple ID" step. Only Apple accounts get this value. */
  appleAuthorizationRevocation:
    'revoked' | 'not_applicable' | 'manual_action_required' | 'unconfirmed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Confirms that were sent but never answered, keyed per account+challenge.
 * An entry is consumed by the next definitive answer on that challenge. */
const unansweredConfirms = new Set<string>();

function unansweredConfirmKey(session: ApiSession, challenge: string): string {
  return `${session.canonicalAppUserId}\u0000${challenge}`;
}

type PostOutcome =
  | { kind: 'unanswered' }
  | { kind: 'unauthorized' }
  | { kind: 'answered'; status: number; ok: boolean; payload: unknown };

function unavailable(message: string): AccountDeletionError {
  return new AccountDeletionError('deletion.unavailable', message, true);
}

/** The bearer was refused. Every other API client tells the auth store so
 * it can refresh or drop the session; deletion must not be the exception. */
function sessionExpired(session: ApiSession): AccountDeletionError {
  reportApiUnauthorized(session.bearerToken);
  return new AccountDeletionError(
    'deletion.session_expired',
    'Your sign-in has expired. Sign in again, then delete your account.',
    false,
  );
}

function rejected(status: number, payload: unknown): AccountDeletionError {
  const error =
    isRecord(payload) && isRecord(payload['error']) ? payload['error'] : null;
  const message =
    error && typeof error['message'] === 'string'
      ? error['message']
      : 'The deletion request could not be completed. Nothing was deleted.';
  return new AccountDeletionError(
    'deletion.rejected',
    message,
    status === 429 || status >= 500,
  );
}

/** One bounded POST. Transport failures (timeout, dropped connection) and a
 * refused bearer are reported as outcomes, not errors, because their meaning
 * depends on the step: nothing happened for delete-request, while for
 * delete-confirm they may mean the account is already gone. */
async function post(
  session: ApiSession,
  fetchFn: AccountDeletionFetch,
  path: string,
  body?: unknown,
): Promise<PostOutcome> {
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
    return { kind: 'unanswered' };
  } finally {
    clearTimeout(timeout);
  }
  if (response.status === 401) {
    return { kind: 'unauthorized' };
  }
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON error bodies fall through to the status checks below.
  }
  return {
    kind: 'answered',
    status: response.status,
    ok: response.ok,
    payload,
  };
}

function answeredPayload(outcome: {
  status: number;
  ok: boolean;
  payload: unknown;
}): Record<string, unknown> {
  if (!outcome.ok) {
    throw rejected(outcome.status, outcome.payload);
  }
  if (!isRecord(outcome.payload)) {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server returned an invalid deletion response.',
      false,
    );
  }
  return outcome.payload;
}

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
  const outcome = await post(
    session,
    fetchFn,
    '/v1/me/delete-request',
    survey ? { survey } : undefined,
  );
  if (outcome.kind === 'unanswered') {
    // Minting a challenge destroys nothing, so this promise holds.
    throw unavailable(
      'Account deletion is temporarily offline. Nothing was deleted — please try again.',
    );
  }
  if (outcome.kind === 'unauthorized') {
    throw sessionExpired(session);
  }
  const payload = answeredPayload(outcome);
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
  const key = unansweredConfirmKey(session, challenge);
  const outcome = await post(session, fetchFn, '/v1/me/delete-confirm', {
    challenge,
  });
  if (outcome.kind === 'unanswered') {
    // The request may have reached the server and deleted the account; the
    // caller keeps the same challenge armed so the retry can find out.
    unansweredConfirms.add(key);
    throw unavailable(
      'We could not confirm whether your account was deleted. Tap Permanently delete again — if it was already deleted, this phone will finish the cleanup.',
    );
  }
  const wasUnanswered = unansweredConfirms.delete(key);
  if (outcome.kind === 'unauthorized') {
    if (wasUnanswered) {
      // The bearer that minted this challenge moments ago is now refused,
      // right after a confirm the server may have completed: the account
      // is gone. The caller runs completeAccountDeletion (purge + Keychain
      // clear), which supersedes the generic expired-session handling, so
      // the auth store is deliberately not told about this 401.
      return {
        appleAuthorizationRevocation:
          session.provider === 'apple' ? 'unconfirmed' : 'not_applicable',
      };
    }
    throw sessionExpired(session);
  }
  const payload = answeredPayload(outcome);
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
