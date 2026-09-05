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
 * Failure honesty differs per step. Step 1 destroys nothing, so every
 * failure can say so. Step 2 is irreversible on the server the moment it
 * runs: once the confirm has left the device, only an answer in which the
 * server says it did NOT act (a 4xx other than 401) rules deletion out. A
 * timeout, a network drop, a 5xx or a 401 (the server fences the deleted
 * account's bearer, so a lost 200 followed by a retry answers 401) leave the
 * outcome open — `AccountDeletionError.mayHaveDeleted` — and the copy never
 * claims otherwise. Either step's 401 is reported through
 * `reportApiUnauthorized` like every other API client's, so the auth store
 * (which knows whether a confirm was sent) can settle what it means.
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
    /** True when a delete-confirm left the device and the failure does not
     * prove the server left the account in place. */
    readonly mayHaveDeleted: boolean = false,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

type AccountDeletionStep = 'request' | 'confirm';

const STEP_PATH: Record<AccountDeletionStep, string> = {
  request: '/v1/me/delete-request',
  confirm: '/v1/me/delete-confirm',
};

const REQUEST_TIMEOUT_MS = 15_000;

const UNREACHABLE_COPY: Record<AccountDeletionStep, string> = {
  request:
    'Account deletion is temporarily offline. Nothing was deleted — please try again.',
  confirm:
    'No answer arrived from the server, so it is not yet known whether your account was deleted. Try again to find out.',
};

const SESSION_EXPIRED_COPY: Record<AccountDeletionStep, string> = {
  request: 'Your sign-in has expired. Sign in again, then delete your account.',
  confirm:
    'The server no longer accepts this sign-in, which can mean the account was already deleted. Checking whether your account was deleted…',
};

const REJECTED_COPY: Record<AccountDeletionStep, string> = {
  request: 'The deletion request could not be completed. Nothing was deleted.',
  confirm: 'The server did not complete the deletion. Nothing was deleted.',
};

const SERVER_FAILED_CONFIRM_COPY =
  'The server ran into a problem, so it is not yet known whether your account was deleted. Try again to find out.';

export interface AccountDeletionChallenge {
  challenge: string;
  expiresAt: string;
}

export interface AccountDeletionResult {
  appleAuthorizationRevocation:
    'revoked' | 'not_applicable' | 'manual_action_required';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function post(
  session: ApiSession,
  fetchFn: AccountDeletionFetch,
  step: AccountDeletionStep,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const confirming = step === 'confirm';
  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    response = await fetchFn(`${session.apiBaseUrl}${STEP_PATH[step]}`, {
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
      UNREACHABLE_COPY[step],
      true,
      confirming,
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
    // Ignored by apiSession for a bearer that is no longer current, so a
    // late answer cannot tear down a successor session.
    reportApiUnauthorized(session.bearerToken);
    throw new AccountDeletionError(
      'deletion.session_expired',
      SESSION_EXPIRED_COPY[step],
      false,
      confirming,
    );
  }
  if (!response.ok) {
    const serverFailed = response.status >= 500;
    const error =
      isRecord(payload) && isRecord(payload['error']) ? payload['error'] : null;
    const message =
      error && typeof error['message'] === 'string'
        ? error['message']
        : confirming && serverFailed
          ? SERVER_FAILED_CONFIRM_COPY
          : REJECTED_COPY[step];
    throw new AccountDeletionError(
      'deletion.rejected',
      message,
      response.status === 429 || serverFailed,
      confirming && serverFailed,
    );
  }
  if (!isRecord(payload)) {
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server returned an invalid deletion response.',
      false,
      confirming,
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
  const payload = await post(session, fetchFn, 'confirm', { challenge });
  if (payload['deleted'] !== true) {
    // A 2xx without the confirmation flag: the server answered, but not
    // with the contract's outcome, so the result stays open.
    throw new AccountDeletionError(
      'deletion.rejected',
      'The server did not confirm the deletion.',
      false,
      true,
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
