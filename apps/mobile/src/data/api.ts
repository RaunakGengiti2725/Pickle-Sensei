import type {
  AnalysisFeedbackCategory,
  AnalysisFeedbackRating,
} from '@pickle/shared-types';
import {
  validateOfflineSignedGrantShape,
  type OfflineFreeTicketReference,
  type OfflineReconciliationStatus,
  type OfflineSignedExecutionGrant,
} from '@pickle/shared-types';
import type { SyncTransport } from './sync';
import { reportApiUnauthorized } from '../account/apiSession';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { responseDateHeader, trustedTime } from './trustedTime';

/**
 * API client. Base URL/token come from app state; in development the API's
 * dev-token issuer is used (the API refuses dev tokens outside dev/test).
 */

export interface ApiConfigState {
  baseUrl: string;
  token: string | null;
}

export type ReleasableAnalysisOutcome =
  | 'low_confidence'
  | 'cancelled'
  | 'failed'
  | 'unsupported'
  | 'incorrect_recognition';

export interface ReservedAnalysisPermit {
  id: string;
  accessSource: 'free' | 'premium';
  status: 'reserved';
  expiresAt: string;
}

/** Post-reservation access snapshot returned beside every reserved permit. */
export interface ReserveAccessSnapshot {
  premium: boolean;
  freeRatings: {
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
}

export interface ReservedAnalysisPermitWithAccess {
  permit: ReservedAnalysisPermit;
  /** Absent when the server predates the access snapshot in this response. */
  access: ReserveAccessSnapshot | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function syncRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function syncIds(values: readonly unknown[], key: 'id' | 'trialId'): string[] {
  return values.map(value => {
    if (
      !syncRecord(value) ||
      typeof value[key] !== 'string' ||
      !value[key].trim() ||
      value[key].length > 128
    ) {
      throw new ApiError(
        400,
        'sync.invalid_id',
        'The saved item has an invalid identifier.',
      );
    }
    return value[key];
  });
}

/** Validate the whole batch before any acknowledgement can delete local work. */
function decodeSyncVerdicts(
  value: unknown,
  submittedIds: readonly string[],
  acceptedKey: 'acceptedIds' | 'acceptedTrialIds',
  idKey: 'id' | 'trialId',
) {
  const invalid = () =>
    new ApiError(
      502,
      'sync.invalid_acknowledgement',
      'The server could not confirm which items were saved. Your work remains on this device and will be retried.',
    );
  const expected = new Set(submittedIds);
  if (expected.size !== submittedIds.length) throw invalid();
  if (!syncRecord(value)) throw invalid();
  const accepted = value[acceptedKey];
  const rejected = value.rejected;
  if (
    !Array.isArray(accepted) ||
    !Array.isArray(rejected) ||
    accepted.length + rejected.length !== expected.size
  )
    throw invalid();
  const observed = new Set<string>();
  const acceptId = (id: unknown): string => {
    if (typeof id !== 'string' || !expected.has(id) || observed.has(id))
      throw invalid();
    observed.add(id);
    return id;
  };
  const acceptedIds = accepted.map(acceptId);
  const rejections = rejected.map(item => {
    if (
      !syncRecord(item) ||
      typeof item.code !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,127}$/.test(item.code) ||
      typeof item.message !== 'string' ||
      item.message.length > 2000
    )
      throw invalid();
    return {
      id: acceptId(item[idKey]),
      code: item.code,
      message: item.message,
    };
  });
  return { acceptedIds, rejected: rejections };
}

export function parseShotSyncAcknowledgement(
  value: unknown,
  ids: readonly string[],
) {
  return decodeSyncVerdicts(value, ids, 'acceptedIds', 'id');
}

export function parseTrialSyncAcknowledgement(
  value: unknown,
  ids: readonly string[],
) {
  const response = decodeSyncVerdicts(
    value,
    ids,
    'acceptedTrialIds',
    'trialId',
  );
  return {
    acceptedTrialIds: response.acceptedIds,
    rejected: response.rejected.map(({ id, ...verdict }) => ({
      trialId: id,
      ...verdict,
    })),
  };
}

/** Every request is bounded: a backend that stops responding must surface as
 * a typed timeout the caller can retry, never an indefinitely pending await
 * (which the capture flow would render as an unbounded spinner). */
export const API_REQUEST_TIMEOUT_MS = 20_000;

/** A redirect is never an API verdict. The request asks the runtime not to
 * follow (`redirect: 'manual'`), so a compliant fetch hands back the 3xx (or
 * an opaque redirect) itself; a runtime that follows anyway (React Native's
 * XHR-backed fetch) reports it through `redirected` / a final URL that is
 * not the one requested. Either way the answer came from wherever the
 * redirect pointed (a captive portal, an intercepting proxy, a route the API
 * does not have), never from the API origin: a transport artifact. */
function answeredByAnotherUrl(response: Response, requestUrl: string): boolean {
  if (response.type === 'opaqueredirect') return true;
  if (response.status >= 300 && response.status < 400) return true;
  if (response.redirected) return true;
  const finalUrl: unknown = response.url;
  if (typeof finalUrl !== 'string' || finalUrl === '') return false;
  const canonical = (value: string): string | null => {
    try {
      return new URL(value).href;
    } catch {
      return null;
    }
  };
  const answeredBy = canonical(finalUrl);
  return answeredBy !== null && answeredBy !== canonical(requestUrl);
}

/** Every API route answers 2xx with a JSON object; anything else (an empty
 * 204, a text/html page, a bare literal) was written by something that never
 * reached the route and acknowledges nothing. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every API error is a JSON envelope `{ error: { code, message } }`. A 4xx
 * WITHOUT a coded envelope (a captive portal's 403 page, a gateway's 404
 * HTML, a proxy's plain-text 400) was written by an intermediary, not by the
 * route: it is no verdict on the request and must not be recorded as one.
 * 401, 408 and 429 keep their status — every caller already treats them as
 * "sign in / try again later" rather than as a verdict, and a 401 must still
 * reach the session keeper. */
function isUnreadableClientError(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 408 &&
    status !== 429
  );
}

function unreadableAnswer(): ApiError {
  return new ApiError(
    502,
    'network.invalid_response',
    'The rating service answered without a readable result. Your work is saved on this device and will be retried.',
  );
}

async function request<T>(
  config: ApiConfigState,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Read the bearer once: it is resolved per request and may rotate while
  // this call is in flight, and a 401 must name the token that was SENT.
  const token = config.token;
  const timeoutError = () =>
    new ApiError(
      408,
      'network.timeout',
      'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
    );
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(timeoutError());
      controller.abort();
    }, API_REQUEST_TIMEOUT_MS);
  });
  const fetchAndRead = async (): Promise<T> => {
    const requestUrl = `${config.baseUrl}${path}`;
    const sentAt = token ? trustedTime.beginRequest() : null;
    const response = await fetch(requestUrl, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'x-client-version': getRuntimePublicConfig().appVersion,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      redirect: 'manual',
      signal: controller.signal,
    });
    if (timedOut) throw timeoutError();
    if (answeredByAnotherUrl(response, requestUrl)) {
      throw new ApiError(
        502,
        'network.redirected',
        'The connection was redirected away from the rating service. Your work is saved on this device and will be retried.',
      );
    }
    const json: unknown = await response.json().catch(() => undefined);
    if (timedOut) throw timeoutError();
    if (!response.ok) {
      if (response.status === 401 && token) {
        reportApiUnauthorized(token);
      }
      const failure = isJsonObject(json) ? json['error'] : undefined;
      const code = isJsonObject(failure) ? failure['code'] : undefined;
      const message = isJsonObject(failure) ? failure['message'] : undefined;
      const verdictCode = typeof code === 'string' && code !== '' ? code : null;
      if (verdictCode === null && isUnreadableClientError(response.status)) {
        throw unreadableAnswer();
      }
      throw new ApiError(
        response.status,
        verdictCode ?? 'unknown',
        typeof message === 'string' ? message : response.statusText,
      );
    }
    if (!isJsonObject(json)) throw unreadableAnswer();
    if (token) {
      void trustedTime.observeServerTime({
        dateHeader: responseDateHeader(response),
        authenticated: true,
        request: sentAt,
      });
    }
    return json as T;
  };
  try {
    return await Promise.race([fetchAndRead(), deadline]);
  } catch (error) {
    if (timedOut) throw timeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function createTransport(config: ApiConfigState): SyncTransport {
  return {
    async syncShots(shots) {
      const ids = syncIds(shots, 'id');
      return parseShotSyncAcknowledgement(
        await request(config, 'POST', '/v1/shots:sync', { shots }),
        ids,
      );
    },
    async createSession(session) {
      await request(config, 'POST', '/v1/sessions', session);
    },
    async finalizeSession(id) {
      await request(config, 'POST', `/v1/sessions/${id}/finalize`);
    },
    async uploadEvaluationTrials(trials) {
      const ids = syncIds(trials, 'trialId');
      return parseTrialSyncAcknowledgement(
        await request(config, 'POST', '/v1/me/evaluation/trials', { trials }),
        ids,
      );
    },
  };
}

/** Reserve before inference. Successful scores are never finalized here: the
 * shot-sync transaction consumes them. Only abstentions and failures use the
 * explicit release path, so a client cannot create an unbound rating UUID. */
export function createAnalysisPermitClient(config: ApiConfigState) {
  const requireSignedIn = () => {
    if (!config.token?.trim()) {
      throw new ApiError(
        401,
        'auth.required',
        'Sign in before reserving an analysis rating.',
      );
    }
  };
  return {
    async reserve(
      idempotencyKey: string,
    ): Promise<ReservedAnalysisPermitWithAccess> {
      requireSignedIn();
      const response = await request<{
        permit?: unknown;
        access?: unknown;
      }>(config, 'POST', '/v1/analysis-permits', { idempotencyKey });
      const permit = parseReservedPermit(response.permit);
      if (permit === null) {
        throw new ApiError(
          502,
          'access.permit_invalid',
          'The rating service returned an invalid analysis permit. Your capture is saved and can be scored later.',
        );
      }
      if (permit.status !== 'reserved') {
        throw new ApiError(
          409,
          'access.permit_not_reserved',
          'The analysis permit is no longer reserved.',
        );
      }
      return {
        permit: { ...permit, status: 'reserved' },
        access: parseReserveAccess(response.access),
      };
    },

    async release(
      permitId: string,
      outcome: ReleasableAnalysisOutcome,
    ): Promise<void> {
      requireSignedIn();
      const acknowledgement = await request<unknown>(
        config,
        'POST',
        `/v1/analysis-permits/${encodeURIComponent(permitId)}/finalize`,
        { outcome, ratingId: null },
      );
      if (!acknowledgesRelease(acknowledgement, permitId, outcome)) {
        throw new ApiError(
          502,
          'access.permit_release_unconfirmed',
          'The rating service did not confirm the analysis permit was released. It stays reserved on this device until it does.',
        );
      }
    },
  };
}

/** The finalize route answers 2xx only with `{ permit, access }` where the
 * permit view names the permit it settled. A body that names no permit
 * (`{}`, `{ ok: true }`, an error envelope, a permit without id/status) was
 * written by something that never reached the route and is no verdict on
 * this permit. The named permit must be this one, no longer `reserved`, and
 * settled as the requested outcome (any other outcome is a 409 verdict, not
 * an acknowledgement). */
function acknowledgesRelease(
  body: unknown,
  permitId: string,
  outcome: ReleasableAnalysisOutcome,
): boolean {
  if (!isJsonObject(body)) return false;
  const permit = body['permit'];
  if (!isJsonObject(permit)) return false;
  return (
    permit['id'] === permitId &&
    typeof permit['status'] === 'string' &&
    permit['status'] !== 'reserved' &&
    permit['outcome'] === outcome
  );
}

/** The permit id gates inference and every durable write, and is the path
 * segment of the later finalize call — a body without a non-empty string id
 * is not a permit the client can ever settle. Status is checked by the
 * caller so a consumed permit keeps its own error code. */
function parseReservedPermit(
  value: unknown,
): (Omit<ReservedAnalysisPermit, 'status'> & { status: unknown }) | null {
  if (typeof value !== 'object' || value === null) return null;
  const permit = value as {
    id?: unknown;
    accessSource?: unknown;
    status?: unknown;
    expiresAt?: unknown;
  };
  if (typeof permit.id !== 'string' || !permit.id.trim()) return null;
  if (permit.accessSource !== 'free' && permit.accessSource !== 'premium') {
    return null;
  }
  if (typeof permit.expiresAt !== 'string') return null;
  return {
    id: permit.id,
    accessSource: permit.accessSource,
    status: permit.status,
    expiresAt: permit.expiresAt,
  };
}

/** Defensive parse of the reserve-time access snapshot: a malformed or
 * missing block degrades to null (no popup heuristics run on it) instead of
 * failing the reservation that gates the user's analysis. */
function parseReserveAccess(value: unknown): ReserveAccessSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const access = value as {
    premium?: unknown;
    freeRatings?: Record<string, unknown>;
  };
  const ratings = access.freeRatings;
  if (typeof access.premium !== 'boolean' || !ratings) return null;
  const numbers = [
    ratings.limit,
    ratings.used,
    ratings.reserved,
    ratings.remaining,
    ratings.availableToReserve,
  ];
  if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    return null;
  }
  return {
    premium: access.premium,
    freeRatings: {
      limit: ratings.limit as number,
      used: ratings.used as number,
      reserved: ratings.reserved as number,
      remaining: ratings.remaining as number,
      availableToReserve: ratings.availableToReserve as number,
    },
  };
}

/** "Was this analysis accurate?" — a failure-mining signal, never gold.
 * The server derives review eligibility from the consent ledger and copies
 * the version vector from the synced shot row; the client sends only the
 * rating and, for a negative one, a category. */
export async function submitAnalysisFeedback(
  config: ApiConfigState,
  analysisId: string,
  rating: AnalysisFeedbackRating,
  category: AnalysisFeedbackCategory | null,
): Promise<{ reviewEligible: boolean }> {
  const response = await request<{
    feedback: { reviewEligible: boolean };
  }>(
    config,
    'POST',
    `/v1/analyses/${encodeURIComponent(analysisId)}/feedback`,
    {
      rating,
      category,
    },
  );
  return { reviewEligible: response.feedback.reviewEligible };
}

export const api = { request };

export type OfflineAttestationEnvironment = 'production' | 'development';

export interface RegisteredOfflineDevice {
  readonly deviceId: string;
  readonly installationKeyId: string;
  readonly attestationEnvironment: OfflineAttestationEnvironment;
  readonly attestationState: 'unattested' | 'attested';
}

/** `POST /v1/offline/grants` as the server answers it: the signed grant plus
 * the same facts restated in the clear so the wallet can bind the two before
 * it holds anything. `ticketIds` is empty for a Pro lease. */
export interface IssuedOfflineGrant {
  readonly grantId: string;
  readonly generation: number;
  readonly entitlementSource: 'identity_lifetime_free' | 'verified_store';
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entitlementExpiresAt: number | null;
  readonly ticketIds: readonly string[];
  readonly keyId: string;
  readonly grant: OfflineSignedExecutionGrant;
}

/** One queued consumption receipt as the device presents it to the server:
 * the grant binding, the ticket it spent (null for a Pro lease) and the
 * durably delivered result it paid for. */
export interface OfflineReceiptSubmission {
  readonly receiptId: string;
  readonly ownerId: string;
  readonly installationKeyId: string;
  readonly grantId: string;
  readonly grantJwsSha256: string;
  readonly lifecycleSequence: number;
  readonly ticket: OfflineFreeTicketReference | null;
  readonly operationId: string;
  readonly resultId: string;
  readonly fullOutputSha256: string;
  readonly billingDisposition: 'joint_verification_required';
  readonly queuedAt: string;
}

/** The 1.0 wire entry for one queued receipt — the submission extended, never
 * reshaped: the flat receipt fields stay at the top level for readers of the
 * pre-1.0 entry, beside `receipt` (the device receipt exactly as persisted),
 * `grant` (the exact signed grant it spent from — the server re-verifies the
 * signature; nothing about the grant is restated in the clear) and `output`
 * (the exact shot payload the receipt's `fullOutputSha256` hashes, or null
 * when the device no longer holds it). The server records the result from
 * `output`; it never invents one. */
export interface OfflineReceiptWireEntry extends OfflineReceiptSubmission {
  readonly receipt: OfflineReceiptSubmission;
  readonly grant: OfflineSignedExecutionGrant;
  readonly output: Record<string, unknown> | null;
}

/** The device-side reading of one server verdict on a submitted receipt.
 * `held` mirrors the reconciliation states that keep the financial
 * disposition reserved (pending, reconciliation_required,
 * support_review_required): the receipt stays queued and is re-presented. */
export type OfflineReceiptVerdictKind = 'accepted' | 'held' | 'refused';

export interface OfflineReceiptVerdict {
  readonly receiptId: string;
  readonly verdict: OfflineReceiptVerdictKind;
  /** The server's own status or refusal code, kept for diagnostics. Always
   * code-shaped (`isOfflineReceiptCode`); prose the server sent instead of
   * a code is replaced by `OFFLINE_RECEIPT_REFUSED_CODE`. */
  readonly code: string;
}

/** Neutral refusal code recorded when the server's `code` is not a code. */
export const OFFLINE_RECEIPT_REFUSED_CODE = 'offline.receipt_refused';

const OFFLINE_RECEIPT_CODE_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** A protocol code: short and drawn from the identifier alphabet, so it can
 * be stored, compared and shown without ever echoing server prose. */
export function isOfflineReceiptCode(value: unknown): value is string {
  return typeof value === 'string' && OFFLINE_RECEIPT_CODE_PATTERN.test(value);
}

export interface OfflineGrantClient {
  /** The grant issuer the wallet must find in every signed grant's `iss`. */
  readonly issuer: string;
  registerDevice(input: {
    installationKeyId: string;
    attestationEnvironment: OfflineAttestationEnvironment;
  }): Promise<RegisteredOfflineDevice>;
  issueGrant(input: {
    installationKeyId: string;
    requestedTickets: 0 | 1 | 2;
  }): Promise<IssuedOfflineGrant>;
  /** Present queued receipts. Resolves only with a verdict for EVERY
   * submitted receipt (each exactly once, nothing extra); any other answer
   * is unreadable and settles nothing. */
  submitReceipts(
    receipts: readonly OfflineReceiptSubmission[],
  ): Promise<readonly OfflineReceiptVerdict[]>;
}

function isUnixSecondsValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** The shared validators accept only plain data objects. A parsed response
 * body may carry a foreign prototype, so it is re-materialised as JSON first. */
function plainJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value)) as unknown;
  } catch {
    return undefined;
  }
}

/** Shape-only: a response missing any field, or whose signed grant is not a
 * compact JWS, is not a grant. Binding the clear fields to the signed claims
 * is the wallet's job (`holdOfflineGrant`). */
export function parseIssuedOfflineGrant(
  value: unknown,
): IssuedOfflineGrant | null {
  if (!isJsonObject(value)) return null;
  const {
    grantId,
    generation,
    entitlementSource,
    issuedAt,
    expiresAt,
    entitlementExpiresAt,
    ticketIds,
    keyId,
    grant,
  } = value;
  if (
    !isNonEmptyString(grantId) ||
    typeof generation !== 'number' ||
    !Number.isInteger(generation) ||
    generation < 1 ||
    (entitlementSource !== 'identity_lifetime_free' &&
      entitlementSource !== 'verified_store') ||
    !isUnixSecondsValue(issuedAt) ||
    !isUnixSecondsValue(expiresAt) ||
    expiresAt <= issuedAt ||
    (entitlementExpiresAt !== null &&
      !isUnixSecondsValue(entitlementExpiresAt)) ||
    !Array.isArray(ticketIds) ||
    !ticketIds.every(isNonEmptyString) ||
    !isNonEmptyString(keyId)
  ) {
    return null;
  }
  const signed = validateOfflineSignedGrantShape(plainJson(grant));
  if (!signed.ok) return null;
  return {
    grantId,
    generation,
    entitlementSource,
    issuedAt,
    expiresAt,
    entitlementExpiresAt: entitlementExpiresAt ?? null,
    ticketIds: [...ticketIds],
    keyId,
    grant: signed.value,
  };
}

function parseRegisteredOfflineDevice(
  value: unknown,
): RegisteredOfflineDevice | null {
  if (!isJsonObject(value)) return null;
  const device = value['device'];
  if (!isJsonObject(device)) return null;
  const { deviceId, installationKeyId, attestationEnvironment } = device;
  const attestationState = device['attestationState'];
  if (
    !isNonEmptyString(deviceId) ||
    !isNonEmptyString(installationKeyId) ||
    (attestationEnvironment !== 'production' &&
      attestationEnvironment !== 'development') ||
    (attestationState !== 'unattested' && attestationState !== 'attested')
  ) {
    return null;
  }
  return {
    deviceId,
    installationKeyId,
    attestationEnvironment,
    attestationState,
  };
}

const OFFLINE_RECEIPT_STATUS_VERDICTS: ReadonlyMap<
  string,
  OfflineReceiptVerdictKind
> = new Map<OfflineReconciliationStatus['status'], OfflineReceiptVerdictKind>([
  ['result_recorded', 'accepted'],
  ['unused_ticket_returned', 'refused'],
  ['pending', 'held'],
  ['reconciliation_required', 'held'],
  ['support_review_required', 'held'],
]);

/** Validate the whole batch before any verdict can settle a receipt: every
 * submitted receipt named exactly once, as a status or a refusal, and no
 * receipt the device did not submit. */
function parseOfflineReceiptVerdicts(
  value: unknown,
  submittedIds: readonly string[],
): readonly OfflineReceiptVerdict[] | null {
  if (!isJsonObject(value)) return null;
  const receipts = value['receipts'];
  const rejected = value['rejected'] ?? [];
  if (!Array.isArray(receipts) || !Array.isArray(rejected)) return null;
  const verdicts = new Map<string, OfflineReceiptVerdict>();
  const record = (verdict: OfflineReceiptVerdict): boolean => {
    if (verdicts.has(verdict.receiptId)) return false;
    verdicts.set(verdict.receiptId, verdict);
    return true;
  };
  for (const entry of receipts) {
    if (!isJsonObject(entry)) return null;
    const { receiptId, status } = entry;
    if (!isNonEmptyString(receiptId) || !isNonEmptyString(status)) return null;
    const verdict = OFFLINE_RECEIPT_STATUS_VERDICTS.get(status);
    if (verdict === undefined) return null;
    if (!record({ receiptId, verdict, code: status })) return null;
  }
  for (const entry of rejected) {
    if (!isJsonObject(entry)) return null;
    const { receiptId, code } = entry;
    if (!isNonEmptyString(receiptId) || !isNonEmptyString(code)) return null;
    if (
      !record({
        receiptId,
        verdict: 'refused',
        code: isOfflineReceiptCode(code) ? code : OFFLINE_RECEIPT_REFUSED_CODE,
      })
    )
      return null;
  }
  if (verdicts.size !== submittedIds.length) return null;
  const ordered: OfflineReceiptVerdict[] = [];
  for (const id of submittedIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) return null;
    ordered.push(verdict);
  }
  return ordered;
}

/** Device registration, offline grant issuance and receipt reconciliation.
 * Every route requires the account bearer; the answer is checked for shape
 * here and bound to the signed claims by the wallet before anything is
 * held or settled. */
export function createOfflineGrantClient(
  config: ApiConfigState,
): OfflineGrantClient {
  const requireSignedIn = () => {
    if (!config.token?.trim()) {
      throw new ApiError(
        401,
        'auth.required',
        'Sign in before requesting offline ratings.',
      );
    }
  };
  return {
    issuer: config.baseUrl,
    async registerDevice(input) {
      requireSignedIn();
      const device = parseRegisteredOfflineDevice(
        await request<unknown>(config, 'POST', '/v1/devices/register', {
          installationKeyId: input.installationKeyId,
          attestationEnvironment: input.attestationEnvironment,
        }),
      );
      if (device === null) throw unreadableAnswer();
      return device;
    },
    async issueGrant(input) {
      requireSignedIn();
      const issued = parseIssuedOfflineGrant(
        await request<unknown>(config, 'POST', '/v1/offline/grants', {
          installationKeyId: input.installationKeyId,
          requestedTickets: input.requestedTickets,
        }),
      );
      if (issued === null) throw unreadableAnswer();
      return issued;
    },
    async submitReceipts(receipts) {
      requireSignedIn();
      const ids = receipts.map(receipt => receipt.receiptId);
      if (new Set(ids).size !== ids.length) {
        throw new ApiError(
          400,
          'offline.receipt_duplicate',
          'The same receipt cannot be presented twice in one batch.',
        );
      }
      const verdicts = parseOfflineReceiptVerdicts(
        await request<unknown>(config, 'POST', '/v1/offline/receipts', {
          receipts,
        }),
        ids,
      );
      if (verdicts === null) throw unreadableAnswer();
      return verdicts;
    },
  };
}

export const ANALYSIS_RELEASE_POLICY_PATH = '/v1/analysis/release-policy';

/** Transport for the release authority. The body is returned unparsed: the
 * canonical-bytes / digest verification that decides whether it is a policy
 * at all lives in `analysis/releasePolicyClient.ts`, never in the client. */
export interface ReleasePolicyClient {
  read(): Promise<unknown>;
}

export function createReleasePolicyClient(
  config: ApiConfigState,
): ReleasePolicyClient {
  return {
    async read() {
      if (!config.token?.trim()) {
        throw new ApiError(
          401,
          'auth.required',
          'Sign in before checking whether validated ratings are available.',
        );
      }
      return request<unknown>(config, 'GET', ANALYSIS_RELEASE_POLICY_PATH);
    },
  };
}
