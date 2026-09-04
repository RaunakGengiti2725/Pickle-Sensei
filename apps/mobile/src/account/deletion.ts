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
 * (authStore.signOut) after the server confirms deletion.
 *
 * The optional exit survey rides along with step 1 so it is stored BEFORE
 * the account (and the bearer) cease to exist; the server keeps it
 * anonymized after deletion. It is always skippable — the survey must never
 * stand between a player and deleting their account.
 *
 * Step 2 is the one request whose LOSS is dangerous: once it has left the
 * device the server may already have deleted the account (and with it the
 * bearer's user and the refresh token), even though no answer came back.
 * So a timed-out confirm says the outcome is unknown — never "nothing was
 * deleted" — and the challenge stays recorded here as unconfirmed until
 * the server gives a definitive answer. A 401 is reported through
 * `reportApiUnauthorized`, like every other API client, so the auth store
 * can ask the server the only question that settles it: does the refresh
 * token still rotate? (Refused → the account is gone → finish the
 * deletion locally. Rotated → the bearer merely expired → nothing is
 * purged.) See authStore `settleUnconfirmedDeletion`.
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
  appleAuthorizationRevocation:
    'revoked' | 'not_applicable' | 'manual_action_required';
}

/** A delete-confirm this device sent but never saw answered definitively. */
export interface UnconfirmedAccountDeletion {
  canonicalAppUserId: string;
  challenge: string;
}

let unconfirmed: UnconfirmedAccountDeletion | null = null;

/** The confirm still in limbo for `canonicalAppUserId`, if any. Consulted by
 * the auth store when the server refuses that account's refresh token: with
 * an entry here the refusal means "deleted", not "signed out elsewhere". */
export function unconfirmedAccountDeletionFor(
  canonicalAppUserId: string,
): UnconfirmedAccountDeletion | null {
  return unconfirmed?.canonicalAppUserId === canonicalAppUserId
    ? unconfirmed
    : null;
}

/** Forgets the limbo entry — on a definitive server answer, or when the
 * account's runtime is torn down (sign-out, deletion complete). */
export function clearUnconfirmedAccountDeletion(): void {
  unconfirmed = null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type DeletionStep = 'request' | 'confirm';

/** Copy is per step because only step 2 destroys anything: a lost step-1
 * call truthfully deleted nothing; a lost step-2 call may have. */
const STEP_FAILURES: Record<
  DeletionStep,
  {
    unreachable: () => AccountDeletionError;
    unauthorized: () => AccountDeletionError;
  }
> = {
  request: {
    unreachable: () =>
      new AccountDeletionError(
        'deletion.unavailable',
        'Account deletion is temporarily offline. Nothing was deleted — please try again.',
        true,
      ),
    unauthorized: () =>
      new AccountDeletionError(
        'deletion.session_expired',
        'Your sign-in has expired. Sign in again, then delete your account.',
        false,
      ),
  },
  confirm: {
    unreachable: () =>
      new AccountDeletionError(
        'deletion.unavailable',
        'The server did not answer in time, so we cannot yet tell whether your account was deleted. Tap Permanently delete again to check — if it is already gone, this phone will finish signing it out.',
        true,
      ),
    // Retryable: the auth store is settling whether the bearer merely
    // expired (refresh rotates → this challenge can be presented again).
    unauthorized: () =>
      new AccountDeletionError(
        'deletion.session_expired',
        'The server no longer accepts this sign-in. We are checking whether your account was already deleted.',
        true,
      ),
  },
};

async function post(
  session: ApiSession,
  fetchFn: AccountDeletionFetch,
  step: DeletionStep,
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
    throw STEP_FAILURES[step].unreachable();
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
    reportApiUnauthorized(session.bearerToken);
    throw STEP_FAILURES[step].unauthorized();
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
  const payload = await post(
    session,
    fetchFn,
    'request',
    '/v1/me/delete-request',
    survey ? { survey } : undefined,
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
  unconfirmed = { canonicalAppUserId: session.canonicalAppUserId, challenge };
  let payload: Record<string, unknown>;
  try {
    payload = await post(session, fetchFn, 'confirm', '/v1/me/delete-confirm', {
      challenge,
    });
  } catch (error) {
    const outcomeStillOpen =
      error instanceof AccountDeletionError &&
      (error.code === 'deletion.unavailable' ||
        error.code === 'deletion.session_expired');
    if (!outcomeStillOpen) unconfirmed = null;
    throw error;
  }
  unconfirmed = null;
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
