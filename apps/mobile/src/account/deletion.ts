import { getApiSession, type ApiSession } from './apiSession';
import {
  canonicalDataOwner,
  getDataOwnerSnapshot,
  type DataOwnerContext,
} from '../data/accountScope';
import type { LocalDb } from '../data/db';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { deviceKeychainForVault } from './sessionVault';
import { makeUuid } from '../util/uuid';
import {
  createDeletionOperationFoundation,
  type DeletionJournalRowStub,
  type DeletionOperationHandle,
  type DeletionOperationResult,
} from './deletionOperation';
import type {
  DeletionHttpRequest,
  DeletionIssue,
  DeletionJournalEntry,
  DeletionReceipt,
  DeletionRuntimePort,
} from './deletionOperationContracts';

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
      | 'deletion.in_progress'
      | 'deletion.rejected'
      | 'deletion.unknown'
      | 'deletion.unavailable',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AccountDeletionError';
  }
}

export interface AccountDeletionContext extends DataOwnerContext {
  readonly provider: 'apple' | 'google';
}

export const ACCOUNT_DELETION_UNKNOWN_MESSAGE =
  'We could not confirm whether your account was deleted. The request may have completed. Check your connection and retry, or contact support if you still cannot confirm.';

/** The server refused a request because a confirmed deletion of this
 * account is already being carried out (HTTP 409
 * `account.deletion_in_progress`). Nothing new was requested. */
export const ACCOUNT_DELETION_ALREADY_IN_PROGRESS_MESSAGE =
  'A deletion of this account was already confirmed and is being carried out by the server. This attempt requested nothing new — close this dialog and check back later.';

/** The journal that would say whether a confirmation was ever sent cannot
 * be read. Without it the account is not known to be present, so no new
 * request is minted over the unreadable record. */
export const ACCOUNT_DELETION_RECORD_UNREADABLE_MESSAGE =
  "This phone's record of an earlier deletion attempt could not be read, so we cannot tell whether a deletion was confirmed. Nothing new was requested — contact support if you still want the account removed.";

export interface AccountDeletionChallenge {
  challenge: string;
  expiresAt: string;
  /** The server-side operation the challenge belongs to; a confirmation
   * bound to it is only trusted when the reply names the same operation. */
  operationId?: string;
}

/** A confirmation bound to the operation its challenge was minted for. */
export interface AccountDeletionConfirmation {
  readonly challenge: string;
  readonly operationId: string;
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
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const confirming = path === '/v1/me/delete-confirm';
  const unavailable = () =>
    new AccountDeletionError(
      confirming ? 'deletion.unknown' : 'deletion.unavailable',
      confirming
        ? ACCOUNT_DELETION_UNKNOWN_MESSAGE
        : 'Account deletion is temporarily offline. Nothing was deleted — please try again.',
      true,
    );
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(unavailable());
    }, 15_000);
  });
  const request = (async () => {
    let response: Response;
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
      throw unavailable();
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
        confirming
          ? 'Your sign-in has expired. This response does not confirm whether your account was deleted. Sign in again before retrying.'
          : 'Your sign-in has expired. Sign in again, then delete your account.',
        false,
      );
    }
    if (!response.ok) {
      if (confirming && (response.status === 408 || response.status >= 500)) {
        throw unavailable();
      }
      const error =
        isRecord(payload) && isRecord(payload['error'])
          ? payload['error']
          : null;
      if (
        !confirming &&
        response.status === 409 &&
        error?.['code'] === 'account.deletion_in_progress'
      ) {
        throw new AccountDeletionError(
          'deletion.in_progress',
          ACCOUNT_DELETION_ALREADY_IN_PROGRESS_MESSAGE,
          false,
        );
      }
      const message =
        error && typeof error['message'] === 'string'
          ? error['message']
          : confirming
            ? 'The server did not confirm the deletion.'
            : 'The deletion request could not be completed. Nothing was deleted.';
      throw new AccountDeletionError(
        'deletion.rejected',
        message,
        response.status === 429 || response.status >= 500,
      );
    }
    if (!isRecord(payload)) {
      if (confirming) throw unavailable();
      throw new AccountDeletionError(
        'deletion.rejected',
        'The server returned an invalid deletion response.',
        false,
      );
    }
    return payload;
  })();
  try {
    return await Promise.race([request, deadline]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Step 1 — mint the deletion challenge. Destroys nothing by itself. A
 * skipped survey sends no body at all (the pre-survey wire shape). */
export async function requestAccountDeletion(
  session: ApiSession | null,
  survey: AccountDeletionSurvey | null = null,
  fetchFn: AccountDeletionFetch = fetchInPlace,
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
  const operationId = payload['operationId'];
  return typeof operationId === 'string' && operationId.length > 0
    ? { challenge, expiresAt, operationId }
    : { challenge, expiresAt };
}

/** Step 2 — irreversibly delete the account named by the challenge. */
export async function confirmAccountDeletion(
  session: ApiSession | null,
  challenge: string | AccountDeletionConfirmation,
  fetchFn: AccountDeletionFetch = fetchInPlace,
): Promise<AccountDeletionResult> {
  if (!session) {
    throw new AccountDeletionError(
      'deletion.not_configured',
      'Sign in to a synced account before deleting it.',
      false,
    );
  }
  const bound = typeof challenge === 'string' ? null : challenge;
  const payload = await post(
    session,
    fetchFn,
    '/v1/me/delete-confirm',
    bound
      ? { challenge: bound.challenge, operationId: bound.operationId }
      : { challenge },
  );
  if (payload['deleted'] !== true) {
    throw new AccountDeletionError(
      'deletion.unknown',
      `The server did not confirm the deletion. ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`,
      true,
    );
  }
  if (bound && payload['operationId'] !== bound.operationId) {
    throw new AccountDeletionError(
      'deletion.unknown',
      `The server's reply did not name this deletion. ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`,
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

/**
 * Durable deletion (W08): the shipping screen runs on the journaled
 * deletion operation (`deletionOperation.ts`) over the redirect-rejecting
 * transport (`deletionOperationTransport.ts`), reached through
 * `fetchNoRedirect` over the app's fetch. The journal lives in the app's
 * transactional SQLite database and the status capability in the Keychain.
 * A database that cannot be opened or cannot host the journal leaves only
 * the two-call client above, which rides the same redirect-rejecting fetch
 * (`fetchInPlace`) and binds its confirmation to the operation the request
 * named, but journals nothing and therefore cannot resume after a restart.
 */

const NO_REDIRECT_INIT = Object.freeze({
  redirect: 'error',
  credentials: 'omit',
  cache: 'no-store',
  referrerPolicy: 'no-referrer',
} as const);

/**
 * `fetch` that never follows a redirect and reports where the reply came
 * from. React Native's Response carries no `redirected` flag and its `url`
 * is the URL the network stack actually answered (empty when unknown), so a
 * reply is marked redirected unless the platform answered in place at the
 * exact requested URL.
 */
export async function fetchNoRedirect(
  input: string,
  init: DeletionHttpRequest,
): Promise<Response> {
  const response = await globalThis.fetch(input, {
    ...init,
    ...NO_REDIRECT_INIT,
  });
  const url = typeof response.url === 'string' ? response.url : '';
  const redirected =
    response.redirected === true || url.length === 0 || url !== input;
  return new Proxy(response, {
    get(target, property) {
      if (property === 'redirected') return redirected;
      if (property === 'url') return url;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** The two-call client's fetch: the same never-follow request options as
 * `fetchNoRedirect`, and a reply the platform reports as answered anywhere
 * but the requested URL is dropped before its body is read — the caller sees
 * a lost reply, never a server answer. A reply that carries no URL at all
 * (iOS always reports one; only bare stand-ins omit it) is not evidence of a
 * redirect; the operation binding in `confirmAccountDeletion` still guards
 * what it may claim. */
async function fetchInPlace(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await globalThis.fetch(input, {
    ...init,
    ...NO_REDIRECT_INIT,
  });
  const url = typeof response.url === 'string' ? response.url : '';
  if (response.redirected === true || (url.length > 0 && url !== input)) {
    throw new TypeError('The deletion reply was answered from another URL.');
  }
  return response;
}

/** The API origin is fixed per build, so its generation never advances. */
const deletionRuntime: DeletionRuntimePort = Object.freeze({
  originSnapshot: () => ({
    apiOrigin: getRuntimePublicConfig().apiBaseUrl,
    generation: 0,
  }),
  ownerSnapshot: getDataOwnerSnapshot,
  bearerFor(owner: DataOwnerContext): string | null {
    const session = getApiSession();
    return session &&
      session.apiBaseUrl === getRuntimePublicConfig().apiBaseUrl &&
      canonicalDataOwner(session.canonicalAppUserId) === owner.ownerKey
      ? session.bearerToken
      : null;
  },
});

type DeletionFoundation = ReturnType<typeof createDeletionOperationFoundation>;

let foundationCache: {
  readonly db: LocalDb;
  readonly foundation: DeletionFoundation;
} | null = null;

function durableDeletionFoundation(
  openDb: () => LocalDb,
): DeletionFoundation | null {
  let db: LocalDb;
  try {
    db = openDb();
    if (db.ownerContext !== undefined || !db.transaction) return null;
  } catch {
    return null;
  }
  if (foundationCache?.db === db) return foundationCache.foundation;
  const keychain = deviceKeychainForVault();
  if (!keychain) return null;
  foundationCache?.foundation.dispose();
  const foundation = createDeletionOperationFoundation({
    db,
    keychain,
    runtime: deletionRuntime,
    http: { fetchNoRedirect },
    newJobId: makeUuid,
  });
  foundationCache = { db, foundation };
  return foundation;
}

/** One deletion attempt as the screen holds it: the durable job handle, or
 * the in-memory challenge of the two-call client (bound to the operation
 * the server named, when it named one). */
export type AccountDeletionAttempt =
  | {
      readonly kind: 'durable';
      readonly jobId: string;
      readonly operationId: string | null;
      /** Null when the journal entry could be listed but not opened. */
      readonly handle: DeletionOperationHandle | null;
    }
  | {
      readonly kind: 'legacy';
      readonly operationId: string | null;
      readonly challenge: string;
    };

/**
 * What the screen may honestly show. Only `completed` carries a receipt the
 * server verified; `confirm_unknown` and `in_progress` mean the account MAY
 * be gone; `failed` ends the attempt (its message says what is known).
 */
export type AccountDeletionState =
  | {
      readonly status: 'ready';
      readonly attempt: AccountDeletionAttempt;
      /** Earliest moment the server (or the retry budget) accepts a confirmation. */
      readonly reviewAfterMs: number;
      readonly message: string | null;
    }
  | {
      readonly status: 'request_unknown';
      readonly attempt: AccountDeletionAttempt;
      /** Earliest moment the retry budget accepts another request. */
      readonly nextAttemptAtMs: number;
      readonly message: string;
    }
  | {
      readonly status: 'confirm_unknown';
      readonly attempt: AccountDeletionAttempt;
      /** Earliest moment the retry budget accepts a status check. */
      readonly nextAttemptAtMs: number;
      readonly message: string;
    }
  | {
      readonly status: 'in_progress';
      readonly attempt: AccountDeletionAttempt;
      readonly nextAttemptAtMs: number;
    }
  /** The server is already carrying out a confirmed deletion of this
   * account that this attempt did not start; the attempt requested nothing
   * and holds no capability to observe it, so it can only be closed. */
  | { readonly status: 'already_in_progress'; readonly message: string }
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly outcome: 'nothing_deleted' | 'unknown';
    }
  | { readonly status: 'completed'; readonly result: AccountDeletionResult };

export interface AccountDeletionFlow {
  /** Whether attempts are journaled and survive a restart. */
  readonly durable: boolean;
  /** The owner's unfinished operation, resumed under its own operation id. */
  resume(context: AccountDeletionContext): Promise<AccountDeletionState | null>;
  request(
    session: ApiSession,
    survey: AccountDeletionSurvey | null,
  ): Promise<AccountDeletionState>;
  retryRequest(
    attempt: AccountDeletionAttempt,
    session: ApiSession,
    survey: AccountDeletionSurvey | null,
  ): Promise<AccountDeletionState>;
  confirm(
    attempt: AccountDeletionAttempt,
    session: ApiSession,
  ): Promise<AccountDeletionState>;
  /** Learn the outcome of a confirmation whose reply was lost. */
  recover(
    attempt: AccountDeletionAttempt,
    session: ApiSession,
  ): Promise<AccountDeletionState>;
  /** Observe a confirmation the server is still carrying out. */
  poll(
    attempt: AccountDeletionAttempt,
    session: ApiSession,
  ): Promise<AccountDeletionState>;
}

const REQUEST_FAILED_MESSAGE =
  'The deletion request could not be completed. Nothing was deleted.';
const REQUEST_UNKNOWN_MESSAGE =
  'We could not confirm that the deletion request reached the server. Nothing has been deleted — retry the request.';
const ACCOUNT_CHANGED_MESSAGE =
  'The signed-in account changed. Close this dialog and start again for the account you want to delete.';
const RECORD_FAILED_MESSAGE =
  'Account deletion could not be recorded on this phone. Nothing was deleted — please try again.';
const JOURNAL_FULL_MESSAGE =
  'This phone still holds too many unfinished deletion attempts to record another. Nothing was deleted — come back after an earlier attempt has expired.';
/** A confirmation this flow cannot carry: the attempt belongs to the other
 * flow, so nothing was sent and the outcome is known — nothing happened. */
const CONFIRMATION_UNSENT_MESSAGE =
  'This deletion attempt could not be confirmed from here, so no confirmation was sent. Nothing was deleted — start again.';

function requestIssueMessage(issue: DeletionIssue | null): string {
  switch (issue) {
    case 'session_required':
      return 'Your sign-in has expired. Sign in again, then delete your account.';
    case 'stale_handler':
    case 'origin_unavailable':
      return ACCOUNT_CHANGED_MESSAGE;
    case 'rate_limited':
    case 'retry_later':
      return 'The server asked us to wait before another attempt. Nothing was deleted.';
    case 'raw_transactional_db_required':
    case 'journal_schema_invalid':
    case 'journal_unavailable':
    case 'journal_invalid':
    case 'journal_unsupported':
    case 'journal_conflict':
    case 'capability_missing':
    case 'capability_unavailable':
    case 'capability_invalid':
    case 'capability_unsupported':
    case 'capability_conflict':
    case 'capability_write_ambiguous':
      return RECORD_FAILED_MESSAGE;
    case 'journal_capacity':
      return JOURNAL_FULL_MESSAGE;
    default:
      return REQUEST_FAILED_MESSAGE;
  }
}

function confirmIssueMessage(issue: DeletionIssue | null): string {
  switch (issue) {
    case 'confirmation_expired':
      return 'The server reported this confirmation as expired. Check the deletion status to be sure before starting again.';
    case 'session_required':
      return 'Your sign-in has expired. This response does not confirm whether your account was deleted. Sign in again before retrying.';
    case 'stale_handler':
    case 'origin_unavailable':
      return `${ACCOUNT_CHANGED_MESSAGE} ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`;
    case 'rate_limited':
    case 'retry_later':
      return `The server asked us to wait before checking again. ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`;
    case 'rejected':
      return `The server did not accept the confirmation. ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`;
    case 'blocked':
      return `The server declined to delete this account right now. ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`;
    case 'status_expired':
      return 'The window for checking this deletion has closed. We could not confirm whether your account was deleted — contact support if you still cannot confirm.';
    default:
      return ACCOUNT_DELETION_UNKNOWN_MESSAGE;
  }
}

function terminalMessage(
  state: 'expired' | 'superseded',
): AccountDeletionState {
  switch (state) {
    case 'expired':
      return {
        status: 'failed',
        outcome: 'nothing_deleted',
        message:
          'The deletion request expired before it was confirmed. Nothing was deleted — start again when you are ready.',
      };
    case 'superseded':
      return {
        status: 'failed',
        outcome: 'unknown',
        message:
          'A newer deletion request replaced this one. Start again to continue.',
      };
  }
}

/** The confirmation left this device: the server may have acted on it, so
 * nothing short of a verified receipt says what became of the account. */
function confirmationSent(entry: DeletionJournalEntry): boolean {
  return (
    entry.operationId !== null &&
    entry.phase !== 'request_pending' &&
    entry.phase !== 'request_unknown' &&
    entry.phase !== 'securing' &&
    entry.phase !== 'ready'
  );
}

/** The server reports `expired`/`superseded` only for an operation it never
 * confirmed, so both prove the account is still present. `blocked` is the
 * opposite: it is answered only for a confirmed operation, so it is never a
 * terminal "nothing happened". */
function isTerminalServerState(
  entry: DeletionJournalEntry,
): entry is DeletionJournalEntry & {
  readonly serverState: 'expired' | 'superseded';
} {
  return (
    entry.receipt === null &&
    (entry.serverState === 'expired' || entry.serverState === 'superseded')
  );
}

/** A sent confirmation whose status capability has lapsed: the server will
 * no longer tell this device the outcome, so polling stops here. */
function statusWindowClosed(
  entry: DeletionJournalEntry,
  nowMs: number,
): boolean {
  if (!confirmationSent(entry) || entry.receipt !== null) return false;
  const closesAt = Date.parse(entry.statusExpiresAt ?? '');
  return Number.isFinite(closesAt) && nowMs >= closesAt;
}

function statusWindowClosedState(): AccountDeletionState {
  return {
    status: 'failed',
    outcome: 'unknown',
    message: confirmIssueMessage('status_expired'),
  };
}

function recordUnreadableState(): AccountDeletionState {
  return {
    status: 'failed',
    outcome: 'unknown',
    message: ACCOUNT_DELETION_RECORD_UNREADABLE_MESSAGE,
  };
}

/** A held result the device cannot get past by asking again: its own
 * journal or Keychain record is the problem, not the network. */
function isLocalRecordIssue(issue: DeletionIssue): boolean {
  switch (issue) {
    case 'raw_transactional_db_required':
    case 'journal_schema_invalid':
    case 'journal_unavailable':
    case 'journal_invalid':
    case 'journal_unsupported':
    case 'journal_capacity':
    case 'journal_conflict':
    case 'invalid_binding':
    case 'capability_missing':
    case 'capability_unavailable':
    case 'capability_invalid':
    case 'capability_unsupported':
    case 'capability_conflict':
    case 'capability_write_ambiguous':
      return true;
    default:
      return false;
  }
}

/** What a sent, unresolved confirmation can honestly say: the server's
 * `blocked` when it answered that, otherwise the last transport issue. */
function unresolvedConfirmationMessage(entry: DeletionJournalEntry): string {
  return entry.serverState === 'blocked'
    ? confirmIssueMessage('blocked')
    : confirmIssueMessage(entry.lastIssue);
}

function durableState(
  entry: DeletionJournalEntry,
  handle: DeletionOperationHandle,
  nowMs: number,
): AccountDeletionState {
  const attempt: AccountDeletionAttempt = {
    kind: 'durable',
    jobId: entry.jobId,
    operationId: entry.operationId,
    handle,
  };
  if (isTerminalServerState(entry)) return terminalMessage(entry.serverState);
  if (statusWindowClosed(entry, nowMs)) return statusWindowClosedState();
  switch (entry.phase) {
    case 'request_pending':
    case 'request_unknown':
      if (entry.lastIssue === 'in_progress') {
        return {
          status: 'already_in_progress',
          message: ACCOUNT_DELETION_ALREADY_IN_PROGRESS_MESSAGE,
        };
      }
      return {
        status: 'request_unknown',
        attempt,
        nextAttemptAtMs: entry.nextAttemptAtMs,
        message:
          entry.lastIssue === null ||
          entry.lastIssue === 'unknown' ||
          entry.lastIssue === 'invalid_response'
            ? REQUEST_UNKNOWN_MESSAGE
            : withNothingDeleted(requestIssueMessage(entry.lastIssue)),
      };
    case 'securing':
      // The status capability never reached the Keychain, so this request
      // cannot be confirmed — and never was.
      return {
        status: 'failed',
        outcome: 'nothing_deleted',
        message: RECORD_FAILED_MESSAGE,
      };
    case 'ready':
      return {
        status: 'ready',
        attempt,
        reviewAfterMs: Math.max(
          entry.reviewAfterMs ?? 0,
          entry.nextAttemptAtMs,
        ),
        message: null,
      };
    case 'receipt_pending':
      // The journal carries the receipt the transport verified against this
      // operation; only the Keychain seal is outstanding, and that seal is
      // for the cleanup continuation, not for whether the server deleted.
      if (entry.receipt !== null) return completedFrom(entry.receipt);
      return {
        status: 'confirm_unknown',
        attempt,
        nextAttemptAtMs: entry.nextAttemptAtMs,
        message: unresolvedConfirmationMessage(entry),
      };
    case 'confirm_pending':
      return {
        status: 'confirm_unknown',
        attempt,
        nextAttemptAtMs: entry.nextAttemptAtMs,
        message: unresolvedConfirmationMessage(entry),
      };
    case 'observing':
      return entry.serverState === 'in_progress'
        ? {
            status: 'in_progress',
            attempt,
            nextAttemptAtMs: entry.nextAttemptAtMs,
          }
        : {
            status: 'confirm_unknown',
            attempt,
            nextAttemptAtMs: entry.nextAttemptAtMs,
            message: unresolvedConfirmationMessage(entry),
          };
    case 'receipt_verified':
    case 'cleanup_pending':
    case 'cleanup_complete':
      if (entry.receipt === null) {
        return {
          status: 'confirm_unknown',
          attempt,
          nextAttemptAtMs: entry.nextAttemptAtMs,
          message: ACCOUNT_DELETION_UNKNOWN_MESSAGE,
        };
      }
      return completedFrom(entry.receipt);
  }
}

function completedFrom(receipt: DeletionReceipt): AccountDeletionState {
  return {
    status: 'completed',
    result: {
      appleAuthorizationRevocation: receipt.appleAuthorizationRevocation,
    },
  };
}

function withNothingDeleted(message: string): string {
  return /Nothing (?:was|has been) deleted/.test(message)
    ? message
    : `${message} Nothing has been deleted.`;
}

/** A Keychain that disagrees with the journal about the receipt: the two
 * records of one operation contradict each other, so neither is proof. */
function contradictsJournal(reason: DeletionIssue): boolean {
  return reason === 'capability_conflict' || reason === 'receipt_conflict';
}

/** An unreadable row of this owner may hold a confirmation that left the
 * device: its last committed phase says whether one ever could have. */
function unreadableRowHolds(
  row: DeletionJournalRowStub,
  context: AccountDeletionContext,
  apiOrigin: string | null,
): boolean {
  return (
    row.ownerId === context.ownerKey &&
    row.apiOrigin === apiOrigin &&
    row.operationId !== null &&
    row.phase !== 'request_pending' &&
    row.phase !== 'request_unknown' &&
    row.phase !== 'securing' &&
    row.phase !== 'ready'
  );
}

function resumable(
  entry: DeletionJournalEntry,
  context: AccountDeletionContext,
  apiOrigin: string | null,
  nowMs: number,
): boolean {
  if (entry.ownerId !== context.ownerKey || entry.apiOrigin !== apiOrigin)
    return false;
  if (isTerminalServerState(entry)) return false;
  if (entry.operationId === null || entry.receipt !== null) return true;
  // A sent confirmation stays unresolved until the server says otherwise;
  // the status window closing does not make the account provably present.
  if (entry.phase !== 'securing' && entry.phase !== 'ready') return true;
  const window =
    // Never confirmed: only a live challenge can still be presented.
    Date.parse(entry.expiresAt ?? '');
  return Number.isFinite(window) && nowMs < window;
}

function durableFlow(foundation: DeletionFoundation): AccountDeletionFlow {
  /** The completion a job's journal row already proves: a receipt the
   * transport verified against the operation, kept even when the Keychain
   * refused the seal. A Keychain that contradicts it proves nothing. */
  async function journaledCompletion(
    jobId: string,
    reason: DeletionIssue,
  ): Promise<AccountDeletionState | null> {
    if (contradictsJournal(reason)) return null;
    const listed = await foundation.list();
    if (listed.kind !== 'entries') return null;
    const entry = listed.entries.find(row => row.jobId === jobId);
    return entry?.receipt ? completedFrom(entry.receipt) : null;
  }

  async function settle(
    result: DeletionOperationResult,
    unresolved: (reason: DeletionIssue | null) => AccountDeletionState,
    reopened = false,
  ): Promise<AccountDeletionState> {
    if (result.kind === 'available')
      return durableState(result.entry, result.handle, Date.now());
    // The device clock says the challenge lapsed before anything was sent.
    if (result.kind === 'held' && result.reason === 'confirmation_expired')
      return terminalMessage('expired');
    if (result.kind === 'held' && result.jobId !== undefined) {
      const completed = await journaledCompletion(result.jobId, result.reason);
      if (completed) return completed;
    }
    // The status capability lapsed over a sent confirmation: reopening the
    // row would only re-arm the poll that just refused to run.
    if (result.kind === 'held' && result.reason === 'status_expired')
      return statusWindowClosedState();
    if (result.kind === 'held' && result.jobId !== undefined && !reopened) {
      const view = await foundation.open(result.jobId);
      if (view.kind === 'available') return settle(view, unresolved, true);
    }
    return unresolved(result.kind === 'held' ? result.reason : null);
  }

  function requestFailed(reason: DeletionIssue | null): AccountDeletionState {
    return {
      status: 'failed',
      outcome: 'nothing_deleted',
      message: requestIssueMessage(reason),
    };
  }

  function confirmUnsent(): AccountDeletionState {
    return {
      status: 'failed',
      outcome: 'nothing_deleted',
      message: CONFIRMATION_UNSENT_MESSAGE,
    };
  }

  function confirmUnresolved(attempt: AccountDeletionAttempt) {
    return (reason: DeletionIssue | null): AccountDeletionState => ({
      status: 'confirm_unknown',
      attempt,
      nextAttemptAtMs: 0,
      message: confirmIssueMessage(reason),
    });
  }

  /** Runs `operate` on the attempt's handle; a handle the foundation no
   * longer recognises (older revision, or none after a resume that could
   * not open the job) is refreshed once through `open(jobId)`. */
  async function operate(
    attempt: AccountDeletionAttempt,
    run: (handle: DeletionOperationHandle) => Promise<DeletionOperationResult>,
    unresolved: (reason: DeletionIssue | null) => AccountDeletionState,
  ): Promise<AccountDeletionState> {
    if (attempt.kind !== 'durable') return unresolved(null);
    let result: DeletionOperationResult | null = attempt.handle
      ? await run(attempt.handle)
      : null;
    if (
      result === null ||
      (result.kind === 'held' &&
        result.reason === 'stale_handler' &&
        result.jobId === undefined)
    ) {
      const reopened = await foundation.open(attempt.jobId);
      if (reopened.kind !== 'available')
        return settle(reopened, unresolved, true);
      result = await run(reopened.handle);
    }
    return settle(result, unresolved);
  }

  function requestBody(
    survey: AccountDeletionSurvey | null,
  ): Readonly<Record<string, unknown>> {
    return survey ? { survey } : {};
  }

  /** A full journal is reclaimed once (inert rows only) before the request
   * is given up on; when nothing could be freed the failure says so. */
  async function request(
    _session: ApiSession,
    survey: AccountDeletionSurvey | null,
  ): Promise<AccountDeletionState> {
    let result = await foundation.request(undefined, requestBody(survey));
    if (result.kind === 'held' && result.reason === 'journal_capacity') {
      const reclaimed = await foundation.reclaim();
      if (reclaimed.kind === 'reclaimed' && reclaimed.jobIds.length > 0)
        result = await foundation.request(undefined, requestBody(survey));
    }
    return settle(result, requestFailed);
  }

  return {
    durable: true,
    async resume(context) {
      const listed = await foundation.list();
      // A journal that cannot be read may hold a sent confirmation; it is
      // never treated as empty.
      if (listed.kind !== 'entries') return recordUnreadableState();
      const apiOrigin = getRuntimePublicConfig().apiBaseUrl;
      const nowMs = Date.now();
      const candidates = listed.entries
        .filter(entry => resumable(entry, context, apiOrigin, nowMs))
        .sort((a, b) => b.createdAtMs - a.createdAtMs);
      for (const candidate of candidates) {
        const opened = await foundation.open(candidate.jobId);
        if (opened.kind === 'available') {
          const state = durableState(opened.entry, opened.handle, nowMs);
          // A request that never became confirmable is nothing to resume.
          if (state.status === 'failed' && state.outcome === 'nothing_deleted')
            continue;
          return state;
        }
        // No operation, or one whose capability never reached the Keychain:
        // no confirmation was ever sent, so there is no outcome to report.
        if (candidate.operationId === null || candidate.phase === 'securing')
          continue;
        if (candidate.phase === 'ready') return null;
        if (
          candidate.receipt !== null &&
          !(opened.kind === 'held' && contradictsJournal(opened.reason))
        )
          return completedFrom(candidate.receipt);
        if (statusWindowClosed(candidate, nowMs))
          return statusWindowClosedState();
        if (opened.kind === 'held' && isLocalRecordIssue(opened.reason))
          return recordUnreadableState();
        return confirmUnresolved({
          kind: 'durable',
          jobId: candidate.jobId,
          operationId: candidate.operationId,
          handle: null,
        })(opened.kind === 'held' ? opened.reason : null);
      }
      // Only this owner's own unreadable row can be hiding a confirmation
      // this owner sent; another owner's row says nothing about this one.
      if (
        listed.unreadable.some(row =>
          unreadableRowHolds(row, context, apiOrigin),
        )
      )
        return recordUnreadableState();
      return null;
    },
    request,
    retryRequest(attempt, session, survey) {
      if (attempt.kind !== 'durable') return request(session, survey);
      return operate(
        attempt,
        handle => foundation.retryRequest(handle, requestBody(survey)),
        requestFailed,
      );
    },
    confirm(attempt) {
      if (attempt.kind !== 'durable') return Promise.resolve(confirmUnsent());
      return operate(
        attempt,
        handle => foundation.confirm(handle),
        confirmUnresolved(attempt),
      );
    },
    recover(attempt) {
      return operate(
        attempt,
        handle => foundation.poll(handle),
        confirmUnresolved(attempt),
      );
    },
    poll(attempt) {
      return operate(
        attempt,
        handle => foundation.poll(handle),
        confirmUnresolved(attempt),
      );
    },
  };
}

/** The two-call client the screen falls back to; injected so the screen's
 * module boundary (not this file's local bindings) decides which
 * implementation runs. */
export interface AccountDeletionLegacyClient {
  requestAccountDeletion(
    session: ApiSession | null,
    survey: AccountDeletionSurvey | null,
  ): Promise<AccountDeletionChallenge>;
  confirmAccountDeletion(
    session: ApiSession | null,
    challenge: string | AccountDeletionConfirmation,
  ): Promise<AccountDeletionResult>;
}

async function legacyRequest(
  client: AccountDeletionLegacyClient,
  session: ApiSession,
  survey: AccountDeletionSurvey | null,
): Promise<AccountDeletionState> {
  try {
    const { challenge, operationId } = await client.requestAccountDeletion(
      session,
      survey,
    );
    return {
      status: 'ready',
      attempt: {
        kind: 'legacy',
        operationId: operationId ?? null,
        challenge,
      },
      reviewAfterMs: Date.now(),
      message: null,
    };
  } catch (e) {
    if (e instanceof AccountDeletionError && e.code === 'deletion.in_progress')
      return { status: 'already_in_progress', message: e.message };
    return {
      status: 'failed',
      outcome: 'nothing_deleted',
      message:
        e instanceof AccountDeletionError ? e.message : REQUEST_FAILED_MESSAGE,
    };
  }
}

/** The legacy client has no status capability: the only way to learn the
 * outcome of a lost confirmation is to present the same challenge again. */
async function legacyConfirm(
  client: AccountDeletionLegacyClient,
  attempt: AccountDeletionAttempt,
  session: ApiSession,
  retrying: boolean,
): Promise<AccountDeletionState> {
  if (attempt.kind !== 'legacy') {
    return retrying
      ? {
          status: 'failed',
          outcome: 'unknown',
          message: ACCOUNT_DELETION_UNKNOWN_MESSAGE,
        }
      : {
          status: 'failed',
          outcome: 'nothing_deleted',
          message: CONFIRMATION_UNSENT_MESSAGE,
        };
  }
  try {
    const result = await client.confirmAccountDeletion(
      session,
      attempt.operationId === null
        ? attempt.challenge
        : { challenge: attempt.challenge, operationId: attempt.operationId },
    );
    return { status: 'completed', result };
  } catch (e) {
    if (!retrying && e instanceof AccountDeletionError) {
      // A first confirmation is known not to have acted only when the
      // client never sent it (unavailable, not configured) or the server
      // refused it before acting (a throttle, an explicit rejection); a
      // dead bearer or a lost reply proves nothing.
      if (
        e.code === 'deletion.unavailable' ||
        (e.code === 'deletion.rejected' && e.retryable)
      ) {
        return {
          status: 'ready',
          attempt,
          reviewAfterMs: Date.now(),
          message: e.message,
        };
      }
      if (
        e.code === 'deletion.not_configured' ||
        e.code === 'deletion.rejected'
      ) {
        return {
          status: 'failed',
          outcome: 'nothing_deleted',
          message: e.message,
        };
      }
    }
    const message = !(e instanceof AccountDeletionError)
      ? ACCOUNT_DELETION_UNKNOWN_MESSAGE
      : e.code === 'deletion.unknown' || e.code === 'deletion.session_expired'
        ? e.message
        : e.code === 'deletion.rejected'
          ? `${e.message} ${ACCOUNT_DELETION_UNKNOWN_MESSAGE}`
          : ACCOUNT_DELETION_UNKNOWN_MESSAGE;
    return { status: 'confirm_unknown', attempt, nextAttemptAtMs: 0, message };
  }
}

export function legacyAccountDeletionFlow(
  client: AccountDeletionLegacyClient,
): AccountDeletionFlow {
  const retry = (attempt: AccountDeletionAttempt, session: ApiSession) =>
    legacyConfirm(client, attempt, session, true);
  return {
    durable: false,
    resume: async () => null,
    request: (session, survey) => legacyRequest(client, session, survey),
    retryRequest: (_attempt, session, survey) =>
      legacyRequest(client, session, survey),
    confirm: (attempt, session) =>
      legacyConfirm(client, attempt, session, false),
    recover: retry,
    poll: retry,
  };
}

/** The journaled deletion flow, or null when the local database cannot be
 * opened or cannot host the journal (the screen then falls back to
 * `legacyAccountDeletionFlow`, which never journals and so cannot resume). */
export function durableAccountDeletionFlow(
  openDb: () => LocalDb,
): AccountDeletionFlow | null {
  const foundation = durableDeletionFoundation(openDb);
  return foundation ? durableFlow(foundation) : null;
}
