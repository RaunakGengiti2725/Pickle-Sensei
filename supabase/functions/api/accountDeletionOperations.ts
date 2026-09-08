import { JSON_SECURITY_HEADERS } from "./http.ts";
import { isPermanentExternalAccountError } from "./externalAccounts.ts";

export const ACCOUNT_DELETION_POLICY_DRAFT = Object.freeze({
  confirmationMinimumAgeSeconds: 3,
  confirmationLifetimeSeconds: 900,
  statusCapabilityLifetimeSeconds: 86_400,
  operationRetentionSeconds: 604_800,
  workerLeaseSeconds: 120,
  maximumWorkerAttempts: 8,
  legallyApproved: false,
});

export type AppleDeletionOutcome = "revoked" | "not_applicable" | "manual_action_required";
export type DeletionOperationState =
  "pending" | "in_progress" | "completed" | "superseded" | "expired" | "blocked";
export interface DeletionCompletionReceipt {
  completedAt: string;
}
export interface DeletionOperationStatus {
  state: DeletionOperationState;
  completionReceipt: DeletionCompletionReceipt | null;
  appleAuthorizationRevocation: AppleDeletionOutcome | null;
}
export type DeletionOperationRpc = (
  name: string,
  parameters: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error?: unknown; status?: number }>;

export interface AccountDeletionWorkerDependencies {
  revokeAppleCredential(encryptedToken: string, ownerId: string): Promise<void>;
  deleteRevenueCatCustomer(ownerId: string): Promise<void>;
  deleteAuthUser(ownerId: string): Promise<{ error?: unknown }>;
  onFailure?(code: DeletionFailureCode, status: number | null): void;
}
export interface AccountDeletionConfirmDependencies extends AccountDeletionWorkerDependencies {
  verifyLiveSession(ownerId: string): Promise<boolean>;
}

export type DeletionFailureCode =
  | "apple_cleanup_unavailable"
  | "revenuecat_cleanup_unavailable"
  | "checkpoint_unavailable"
  | "auth_delete_unavailable"
  | "completion_unverified";
export type DeletionConfirmationResult =
  | {
      outcome: "completed";
      operationId: string;
      deleted: true;
      completionReceipt: DeletionCompletionReceipt;
      appleAuthorizationRevocation: AppleDeletionOutcome;
    }
  | { outcome: "in_progress"; operationId: string }
  | {
      outcome: "rejected";
      code: "invalid" | "expired" | "too_fast" | "blocked" | "session_invalid";
    }
  | { outcome: "unavailable"; code: DeletionFailureCode | "session_unavailable" };
export type DeletionRequestResult =
  | {
      outcome: "requested";
      challenge: string;
      expiresAt: string;
      operationId: string;
      statusCapability: string;
      statusExpiresAt: string;
    }
  | { outcome: "confirmation_in_progress" | "user_missing" | "unavailable" };

interface DeletionLease {
  operationId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  confirmedAt: string;
  appleCompleted: boolean;
  appleAction: AppleDeletionOutcome | "revoke";
  appleRefreshTokenEncrypted: string | null;
  revenueCatCompleted: boolean;
  revenueCatAlreadyDeleted: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATUS_CAPABILITY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const STATUS_STATES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "superseded",
  "expired",
  "blocked",
]);

export function isAccountDeletionStatusCapability(value: unknown): value is string {
  return typeof value === "string" && STATUS_CAPABILITY.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}
function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function isAppleOutcome(value: unknown): value is AppleDeletionOutcome {
  return value === "revoked" || value === "not_applicable" || value === "manual_action_required";
}
function canonicalOwner(ownerId: string): string {
  if (!isUuid(ownerId)) throw new Error("Invalid deletion owner.");
  return ownerId.toLowerCase();
}

async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return `\\x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
export async function deletionChallengeHash(ownerId: string, challenge: string): Promise<string> {
  if (!isUuid(challenge)) throw new Error("Invalid deletion challenge.");
  return hash(
    `pickle-sensei/account-deletion/challenge/v1/${canonicalOwner(ownerId)}/${challenge.toLowerCase()}`,
  );
}
export async function deletionStatusCapabilityHash(
  operationId: string,
  capability: string,
): Promise<string> {
  if (!isUuid(operationId) || !STATUS_CAPABILITY.test(capability)) {
    throw new Error("Invalid deletion status authorization.");
  }
  return hash(
    `pickle-sensei/account-deletion/status/v1/${operationId.toLowerCase()}/${capability}`,
  );
}

function boundedFailureStatus(error: unknown): number | null {
  try {
    const status = isRecord(error) ? error.status : null;
    return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  } catch {
    return null;
  }
}

class DeletionStorageUnavailable extends Error {
  constructor(readonly status: number | null) {
    super("Account deletion storage is unavailable.");
  }
}

async function rpcData(
  rpc: DeletionOperationRpc,
  name: string,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  try {
    const result = await rpc(name, parameters);
    if (!result || result.error) {
      throw new DeletionStorageUnavailable(
        boundedFailureStatus(result) ?? boundedFailureStatus(result?.error),
      );
    }
    return result.data;
  } catch (error) {
    throw new DeletionStorageUnavailable(boundedFailureStatus(error));
  }
}

export async function beginAccountDeletionOperation(
  rpc: DeletionOperationRpc,
  ownerId: string,
): Promise<DeletionRequestResult> {
  try {
    const owner = canonicalOwner(ownerId);
    const operationId = crypto.randomUUID();
    const challenge = crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const statusCapability = btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const data = await rpcData(rpc, "begin_account_deletion_operation", {
      p_owner_id: owner,
      p_operation_id: operationId,
      p_challenge_hash: await deletionChallengeHash(owner, challenge),
      p_status_capability_hash: await deletionStatusCapabilityHash(operationId, statusCapability),
    });
    if (isRecord(data)) {
      if (data.outcome === "confirmation_in_progress" || data.outcome === "user_missing") {
        return { outcome: data.outcome };
      }
      if (
        data.outcome === "requested" &&
        data.operationId === operationId &&
        isTimestamp(data.expiresAt) &&
        isTimestamp(data.statusExpiresAt) &&
        Date.parse(data.statusExpiresAt) > Date.parse(data.expiresAt)
      ) {
        return {
          outcome: "requested",
          challenge,
          expiresAt: data.expiresAt,
          operationId,
          statusCapability,
          statusExpiresAt: data.statusExpiresAt,
        };
      }
    }
  } catch {
    return { outcome: "unavailable" };
  }
  return { outcome: "unavailable" };
}

export function parseDeletionOperationStatus(value: unknown): DeletionOperationStatus | null {
  if (!isRecord(value) || typeof value.state !== "string" || !STATUS_STATES.has(value.state)) {
    return null;
  }
  if (value.state === "completed") {
    if (
      !isRecord(value.completionReceipt) ||
      !isTimestamp(value.completionReceipt.completedAt) ||
      !isAppleOutcome(value.appleAuthorizationRevocation)
    ) {
      return null;
    }
    return {
      state: "completed",
      completionReceipt: { completedAt: value.completionReceipt.completedAt },
      appleAuthorizationRevocation: value.appleAuthorizationRevocation,
    };
  }
  if (value.completionReceipt !== null || value.appleAuthorizationRevocation !== null) return null;
  return {
    state: value.state as DeletionOperationState,
    completionReceipt: null,
    appleAuthorizationRevocation: null,
  };
}

function statusJson(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...JSON_SECURITY_HEADERS, Vary: "Authorization" },
  });
}

export function accountDeletionStatusUnavailableResponse(status = 404): Response {
  return statusJson(status, { error: { code: "account.deletion_status_unavailable" } });
}

interface StatusIpWindow {
  requests: number;
  requestResetAt: number;
  failures: number;
  failureResetAt: number;
}

/** Deliberately independent of auth/cache.ts: no capability (even hashed),
 * operation ID or account data enters Redis, a cache key, or a URL. Counters
 * are per-isolate, IP-only, capped at 2,048 entries and fail closed at capacity.
 * A gateway-wide abuse budget remains an operational deployment requirement. */
export class AccountDeletionStatusBudget {
  private readonly windows = new Map<string, StatusIpWindow>();
  constructor(private readonly now: () => number = () => Date.now()) {}

  private limited(resetAt: number): Response {
    const response = statusJson(429, { error: { code: "rate_limited" } });
    response.headers.set(
      "Retry-After",
      String(Math.max(1, Math.ceil((resetAt - this.now()) / 1_000))),
    );
    return response;
  }

  admit(ip: string): Response | null {
    const now = this.now();
    // clientIp is edge-derived; the length bound also caps malformed header keys.
    const key = ip.length <= 64 ? ip : "unknown";
    let window = this.windows.get(key);
    if (!window) {
      if (this.windows.size >= 2_048) {
        for (const [expiredKey, entry] of this.windows) {
          if (entry.requestResetAt <= now && entry.failureResetAt <= now)
            this.windows.delete(expiredKey);
        }
      }
      if (this.windows.size >= 2_048) return this.limited(now + 60_000);
      window = {
        requests: 0,
        requestResetAt: now + 60_000,
        failures: 0,
        failureResetAt: now + 300_000,
      };
      this.windows.set(key, window);
    }
    if (window.requestResetAt <= now) {
      window.requests = 0;
      window.requestResetAt = now + 60_000;
    }
    if (window.failureResetAt <= now) {
      window.failures = 0;
      window.failureResetAt = now + 300_000;
    }
    if (window.failures >= 10) return this.limited(window.failureResetAt);
    if (window.requests >= 30) return this.limited(window.requestResetAt);
    window.requests++;
    return null;
  }

  recordFailure(ip: string): void {
    const window = this.windows.get(ip.length <= 64 ? ip : "unknown");
    if (window) window.failures = Math.min(10, window.failures + 1);
  }
}

/** Small, deadline-bounded provider error bodies only. A missing, oversized,
 * stalled or non-JSON response is unknown, never proof of account absence. */
export async function readAccountDeletionResponseBody(response: Response): Promise<unknown> {
  const limit = 16_384;
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (!response.body) return null;
  if (Number.isFinite(declared) && declared > limit) {
    void response.body.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => undefined);
  }, 5_000);
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (timedOut) return null;
      if (done) break;
      if (size + value.byteLength > limit) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

export function isIntendedRevenueCatCustomerNotFound(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.code === 7225 &&
    Object.keys(value).every((key) => key === "code" || key === "message") &&
    (value.message === undefined || typeof value.message === "string")
  );
}

export async function accountDeletionStatusResponse(
  rpc: DeletionOperationRpc,
  request: Request,
  body: unknown,
): Promise<Response> {
  const unavailable = () => accountDeletionStatusUnavailableResponse();
  const url = new URL(request.url);
  if (request.method !== "POST" || url.search || url.hash) return unavailable();
  const authorization = request.headers.get("Authorization") ?? "";
  const capability = authorization.slice(7);
  if (
    authorization.slice(0, 7).toLowerCase() !== "bearer " ||
    !STATUS_CAPABILITY.test(capability) ||
    !isRecord(body) ||
    Object.keys(body).length !== 1 ||
    !isUuid(body.operationId)
  ) {
    return unavailable();
  }
  try {
    const data = await rpcData(rpc, "read_account_deletion_status", {
      p_operation_id: body.operationId.toLowerCase(),
      p_status_capability_hash: await deletionStatusCapabilityHash(body.operationId, capability),
    });
    if (data === null) return unavailable();
    const status = parseDeletionOperationStatus(data);
    if (status) return statusJson(200, status);
  } catch {
    return statusJson(503, { error: { code: "account.deletion_status_unavailable" } });
  }
  return statusJson(503, { error: { code: "account.deletion_status_unavailable" } });
}

export function isIntendedAuthUserNotFound(error: unknown): boolean {
  try {
    if (!isRecord(error) || error.status !== 404) return false;
    const codes = [error.code, error.error_code].filter((code) => code !== undefined);
    return codes.length > 0 && codes.every((code) => code === "user_not_found");
  } catch {
    return false;
  }
}

function parseLease(value: Record<string, unknown>): DeletionLease | null {
  if (
    !isUuid(value.operationId) ||
    !isUuid(value.leaseToken) ||
    !isTimestamp(value.leaseExpiresAt) ||
    !isTimestamp(value.confirmedAt) ||
    typeof value.appleCompleted !== "boolean" ||
    !(value.appleAction === "revoke" || isAppleOutcome(value.appleAction)) ||
    typeof value.revenueCatCompleted !== "boolean" ||
    typeof value.revenueCatAlreadyDeleted !== "boolean"
  ) {
    return null;
  }
  if (value.appleAction === "revoke") {
    if (
      value.appleCompleted ||
      typeof value.appleRefreshTokenEncrypted !== "string" ||
      value.appleRefreshTokenEncrypted.length < 20 ||
      value.appleRefreshTokenEncrypted.length > 8192
    ) {
      return null;
    }
  } else if (value.appleRefreshTokenEncrypted !== null) {
    return null;
  }
  return {
    operationId: value.operationId.toLowerCase(),
    leaseToken: value.leaseToken.toLowerCase(),
    leaseExpiresAt: value.leaseExpiresAt,
    confirmedAt: value.confirmedAt,
    appleCompleted: value.appleCompleted,
    appleAction: value.appleAction,
    appleRefreshTokenEncrypted: value.appleRefreshTokenEncrypted as string | null,
    revenueCatCompleted: value.revenueCatCompleted,
    revenueCatAlreadyDeleted: value.revenueCatAlreadyDeleted,
  };
}

function completionResult(
  operationId: string,
  value: unknown,
): Extract<DeletionConfirmationResult, { outcome: "completed" }> | null {
  const status = parseDeletionOperationStatus(value);
  if (
    !status ||
    status.state !== "completed" ||
    !status.completionReceipt ||
    !status.appleAuthorizationRevocation
  ) {
    return null;
  }
  return {
    outcome: "completed",
    operationId,
    deleted: true,
    completionReceipt: status.completionReceipt,
    appleAuthorizationRevocation: status.appleAuthorizationRevocation,
  };
}

/** Complete provider-side erasure before removing the Supabase identity. A
 * successful external step is checkpointed in the service-role-only row so a
 * later provider/database failure can be retried safely. */
async function runClaimedDeletion(
  rpc: DeletionOperationRpc,
  dependencies: AccountDeletionWorkerDependencies,
  ownerId: string,
  claim: unknown,
  expectedOperationId?: string,
): Promise<DeletionConfirmationResult> {
  if (!isRecord(claim)) return { outcome: "unavailable", code: "checkpoint_unavailable" };
  if (
    claim.outcome === "invalid" ||
    claim.outcome === "expired" ||
    claim.outcome === "too_fast" ||
    claim.outcome === "blocked"
  ) {
    return { outcome: "rejected", code: claim.outcome };
  }
  if (
    !isUuid(claim.operationId) ||
    (expectedOperationId !== undefined && claim.operationId.toLowerCase() !== expectedOperationId)
  ) {
    return { outcome: "unavailable", code: "checkpoint_unavailable" };
  }
  const operationId = claim.operationId.toLowerCase();
  if (claim.outcome === "busy") return { outcome: "in_progress", operationId };
  if (claim.outcome === "completed") {
    return (
      completionResult(operationId, claim.status) ?? {
        outcome: "unavailable",
        code: "completion_unverified",
      }
    );
  }
  const lease = claim.outcome === "claimed" ? parseLease(claim) : null;
  if (!lease) return { outcome: "unavailable", code: "checkpoint_unavailable" };
  const binding = {
    p_owner_id: ownerId,
    p_operation_id: operationId,
    p_lease_token: lease.leaseToken,
  };
  let failureCode: DeletionFailureCode = "checkpoint_unavailable";
  const checkpoint = async (step: string, appleOutcome: AppleDeletionOutcome | null = null) => {
    failureCode = "checkpoint_unavailable";
    const result = await rpcData(rpc, "checkpoint_account_deletion_operation", {
      ...binding,
      p_checkpoint: step,
      p_apple_outcome: appleOutcome,
    });
    if (!isRecord(result) || result.outcome !== "checkpointed")
      throw new Error("Deletion lease is unavailable.");
  };
  try {
    if (!lease.appleCompleted) {
      await checkpoint("lease_check");
      let appleOutcome: AppleDeletionOutcome =
        lease.appleAction === "revoke" ? "revoked" : lease.appleAction;
      let appleCheckpoint = "apple";
      if (lease.appleAction === "revoke") {
        failureCode = "apple_cleanup_unavailable";
        try {
          await dependencies.revokeAppleCredential(lease.appleRefreshTokenEncrypted!, ownerId);
        } catch (error) {
          // Transport failures, Apple 5xx/429, missing secrets and Apple
          // refusing OUR client secret are retried by the client (fail closed:
          // nothing downstream runs). A credential that can never be revoked —
          // ciphertext under a rotated key, a token Apple refuses with
          // invalid_grant — must not leave the account undeletable:
          // Apple requires deletion to be fulfilled, so it is dropped and the
          // user is directed to Apple's manual authorization controls.
          if (!isPermanentExternalAccountError(error)) throw error;
          appleOutcome = "manual_action_required";
          appleCheckpoint = "apple_unrevocable";
        }
      }
      // Checkpoint before RevenueCat so a later failure retries without a
      // second revoke attempt. The capture pair (token + captured_at) is
      // cleared together — the table constrains them to be null together.
      await checkpoint(appleCheckpoint, appleOutcome);
    }
    if (!lease.revenueCatCompleted) {
      await checkpoint("lease_check");
      if (!lease.revenueCatAlreadyDeleted) {
        failureCode = "revenuecat_cleanup_unavailable";
        await dependencies.deleteRevenueCatCustomer(ownerId);
      }
      await checkpoint("revenuecat");
    }
    await checkpoint("external_complete");
    const intent = await rpcData(rpc, "set_account_deletion_auth_intent", binding);
    if (!isRecord(intent) || intent.outcome !== "intent_recorded")
      throw new Error("Deletion intent is unavailable.");
    failureCode = "auth_delete_unavailable";
    const deleted = await dependencies.deleteAuthUser(ownerId);
    if (deleted.error && !isIntendedAuthUserNotFound(deleted.error))
      throw new Error("Auth deletion is unavailable.");
    failureCode = "completion_unverified";
    const receipt = await rpcData(rpc, "read_account_deletion_receipt", {
      p_owner_id: ownerId,
      p_operation_id: operationId,
    });
    const result = completionResult(operationId, receipt);
    if (result) return result;
    throw new Error("Account deletion completion is unverified.");
  } catch (error) {
    try {
      dependencies.onFailure?.(failureCode, boundedFailureStatus(error));
    } catch {
      // Diagnostics cannot change the worker's outcome or lease release.
    }
    try {
      await rpcData(rpc, "fail_account_deletion_operation", {
        ...binding,
        p_error_code: failureCode,
      });
    } catch {
      return { outcome: "unavailable", code: failureCode };
    }
    return { outcome: "unavailable", code: failureCode };
  }
}

export async function confirmAccountDeletionOperation(
  rpc: DeletionOperationRpc,
  dependencies: AccountDeletionConfirmDependencies,
  ownerId: string,
  body: unknown,
): Promise<DeletionConfirmationResult> {
  if (
    !isUuid(ownerId) ||
    !isRecord(body) ||
    !isUuid(body.challenge) ||
    (Object.hasOwn(body, "operationId") && !isUuid(body.operationId))
  ) {
    return { outcome: "rejected", code: "invalid" };
  }
  const owner = canonicalOwner(ownerId);
  const operationId = isUuid(body.operationId) ? body.operationId.toLowerCase() : undefined;
  try {
    if (!(await dependencies.verifyLiveSession(owner))) {
      return { outcome: "rejected", code: "session_invalid" };
    }
  } catch {
    return { outcome: "unavailable", code: "session_unavailable" };
  }
  try {
    const claim = await rpcData(rpc, "confirm_account_deletion_operation", {
      p_owner_id: owner,
      p_challenge_hash: await deletionChallengeHash(owner, body.challenge),
      p_operation_id: operationId ?? null,
    });
    return await runClaimedDeletion(rpc, dependencies, owner, claim, operationId);
  } catch {
    return { outcome: "unavailable", code: "checkpoint_unavailable" };
  }
}

export async function resumeConfirmedAccountDeletionOperation(
  rpc: DeletionOperationRpc,
  dependencies: AccountDeletionWorkerDependencies,
  ownerId: string,
  operationId: string,
): Promise<DeletionConfirmationResult> {
  if (!isUuid(ownerId) || !isUuid(operationId)) return { outcome: "rejected", code: "invalid" };
  try {
    const owner = canonicalOwner(ownerId);
    const operation = operationId.toLowerCase();
    const claim = await rpcData(rpc, "claim_account_deletion_work", {
      p_owner_id: owner,
      p_operation_id: operation,
    });
    return await runClaimedDeletion(rpc, dependencies, owner, claim, operation);
  } catch {
    return { outcome: "unavailable", code: "checkpoint_unavailable" };
  }
}

export async function accountDeletionAllowsAppleBootstrap(
  rpc: DeletionOperationRpc,
  ownerId: string,
): Promise<boolean> {
  const result = await rpcData(rpc, "account_deletion_allows_apple_bootstrap", {
    p_owner_id: canonicalOwner(ownerId),
  });
  if (typeof result !== "boolean") throw new Error("Apple credential admission is unavailable.");
  return result;
}

export async function storeAccountAppleCredential(
  rpc: DeletionOperationRpc,
  ownerId: string,
  encryptedToken: string,
): Promise<"stored" | "confirmation_in_progress" | "user_missing"> {
  const result = await rpcData(rpc, "store_account_apple_credential", {
    p_owner_id: canonicalOwner(ownerId),
    p_encrypted_token: encryptedToken,
  });
  if (
    isRecord(result) &&
    (result.outcome === "stored" ||
      result.outcome === "confirmation_in_progress" ||
      result.outcome === "user_missing")
  ) {
    return result.outcome;
  }
  throw new Error("Apple credential storage is unavailable.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner inventory pagination
//
// PostgREST truncates unpaged reads at its max_rows (1000 on the hosted
// platform) and clamps every paged read to min(limit, max_rows) — silently,
// with HTTP 200. Every owner-wide read (progress history today; deletion and
// cleanup inventories next) therefore pages, and paging must either PROVE it
// reached the end or say so: a fixed page budget that returns what it has is a
// silent truncation, and so is stopping on "a short page", because under a
// max_rows below the requested page size EVERY page is short. A cleanup that
// treats either as the whole set leaves data behind.
//
// The reader is keyset (cursor) driven: each page is read strictly after the
// last row of the previous one, so a row inserted or deleted mid-read shifts
// nothing. Completion is proven ONLY by an EMPTY page after the last cursor;
// anything else — a page error, a row served twice, more rows than requested,
// a page the source could not describe, a degenerate page size, or a source
// that never ends — is reported INCOMPLETE with the rows read so far exposed
// for diagnostics but never handed out as the inventory.
// ─────────────────────────────────────────────────────────────────────────────

/** Rows requested per page — PostgREST's hosted max_rows. A server that clamps
 * lower is still read completely: page size never decides completion. */
export const INVENTORY_PAGE_ROWS = 1_000;

/** Pages read before a source that never serves an empty page is reported
 * INCOMPLETE instead of being read until the isolate is killed (1_000_000 rows
 * at the shipping page size — far beyond any owner's history). */
export const INVENTORY_MAX_PAGES = 1_000;

export interface InventoryPage<Row> {
  data: Row[] | null;
  error: { message: string; code?: string } | null;
  status?: number;
}

export interface InventoryCursorReader<Row, Cursor> {
  /** Reads at most `limit` rows strictly after `cursor` (`null` = first page). */
  readPage(cursor: Cursor | null, limit: number): PromiseLike<InventoryPage<Row>>;
  /** Cursor positioned after `row`; must throw for a row it cannot describe. */
  cursorAfter(row: Row): Cursor;
  /** Stable identity of a cursor — equal for the same row, never for two rows
   * of one owner's inventory; a repeat means the source re-served a row. */
  cursorKey(cursor: Cursor): string;
  pageRows?: number;
}

export type InventoryIncompleteReason =
  | "page_error"
  | "malformed_page"
  | "page_overflow"
  | "repeated_row"
  | "invalid_page_size"
  | "page_budget";

/** Five-character diagnostic codes (the shape `failureDetail` keeps in logs)
 * for the INCOMPLETE reasons that have no upstream error to carry. */
export const INVENTORY_INCOMPLETE_CODES: Readonly<
  Record<Exclude<InventoryIncompleteReason, "page_error">, string>
> = {
  malformed_page: "INV01",
  page_overflow: "INV02",
  repeated_row: "INV03",
  invalid_page_size: "INV04",
  page_budget: "INV05",
};

export interface CompleteInventory<Row> {
  status: "COMPLETE";
  rows: Row[];
  pages: number;
}

export interface IncompleteInventory<Row> {
  status: "INCOMPLETE";
  /** Rows read before the read stopped — diagnostics only, never the set. */
  rows: Row[];
  pages: number;
  reason: InventoryIncompleteReason;
  error: { message: string; code?: string };
  httpStatus: number | null;
}

export type InventoryReadResult<Row> = CompleteInventory<Row> | IncompleteInventory<Row>;

function thrownDetail(thrown: unknown): { message: string; code?: string } {
  if (thrown instanceof Error) {
    const code = (thrown as Error & { code?: unknown }).code;
    return typeof code === "string"
      ? { message: thrown.message, code }
      : { message: thrown.message };
  }
  return { message: String(thrown) };
}

export async function readOwnerInventory<Row, Cursor>(
  reader: InventoryCursorReader<Row, Cursor>,
): Promise<InventoryReadResult<Row>> {
  const limit = reader.pageRows ?? INVENTORY_PAGE_ROWS;
  const rows: Row[] = [];
  const seenRows = new Set<string>();
  let cursor: Cursor | null = null;
  let pages = 0;
  const incomplete = (
    reason: InventoryIncompleteReason,
    error: { message: string; code?: string } = { message: reason },
    httpStatus: number | null = null,
  ): IncompleteInventory<Row> => ({ status: "INCOMPLETE", rows, pages, reason, error, httpStatus });

  if (!Number.isSafeInteger(limit) || limit <= 0) return incomplete("invalid_page_size");

  while (pages < INVENTORY_MAX_PAGES) {
    pages += 1;
    let page: InventoryPage<Row>;
    try {
      page = await reader.readPage(cursor, limit);
    } catch (thrown) {
      return incomplete("page_error", thrownDetail(thrown));
    }
    if (page.error) {
      return incomplete(
        "page_error",
        page.error,
        typeof page.status === "number" ? page.status : null,
      );
    }
    if (!Array.isArray(page.data)) return incomplete("malformed_page");
    const batch = page.data;
    if (batch.length === 0) return { status: "COMPLETE", rows, pages };
    if (batch.length > limit) return incomplete("page_overflow");

    let next: Cursor | null = null;
    const keys: string[] = [];
    try {
      for (const row of batch) {
        next = reader.cursorAfter(row);
        keys.push(reader.cursorKey(next));
      }
    } catch (thrown) {
      return incomplete("malformed_page", thrownDetail(thrown));
    }
    for (const key of keys) {
      if (seenRows.has(key)) return incomplete("repeated_row");
      seenRows.add(key);
    }
    rows.push(...batch);
    cursor = next;
  }
  return incomplete("page_budget");
}

/** The inventory rows, or `null` when the read did not prove completion —
 * deletion/cleanup consumers must not act on a partial set as if it were whole. */
export function completedInventoryRows<Row>(result: InventoryReadResult<Row>): Row[] | null {
  return result.status === "COMPLETE" ? result.rows : null;
}

export interface KeysetColumn {
  column: string;
  value: string;
}

const POSTGREST_COLUMN = /^[a-z_][a-z0-9_]*$/;

/** A value inside a PostgREST logic tree (`or=(…)`): double-quoted, with the
 * backslash escapes PostgREST's parser unescapes. */
export function postgrestFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** PostgREST `or` filter body selecting the rows strictly BEFORE `key` under a
 * descending order over its columns — the next page of a newest-first read. */
export function postgrestKeysetBefore(key: ReadonlyArray<KeysetColumn>): string {
  if (key.length === 0) throw new Error("keyset cursor needs at least one column");
  for (const { column } of key) {
    if (!POSTGREST_COLUMN.test(column)) throw new Error(`invalid keyset column: ${column}`);
  }
  return keysetBeforeDisjuncts(key).join(",");
}

function keysetBeforeDisjuncts(key: ReadonlyArray<KeysetColumn>): string[] {
  const [head, ...rest] = key;
  const value = postgrestFilterValue(head.value);
  const before = `${head.column}.lt.${value}`;
  if (rest.length === 0) return [before];
  const tail = keysetBeforeDisjuncts(rest);
  const tailExpr = tail.length === 1 ? tail[0] : `or(${tail.join(",")})`;
  return [before, `and(${head.column}.eq.${value},${tailExpr})`];
}

/** The keyset cursor after a PostgREST row: the row's values for `keyColumns`
 * as text. Throws for a row that lacks a key column or holds one that is not a
 * string or finite number — a `null` or object key cannot be filtered on, so
 * the read reports INCOMPLETE rather than paging past the row. */
export function postgrestKeysetAfter(
  row: Record<string, unknown>,
  keyColumns: readonly string[],
): KeysetColumn[] {
  return keyColumns.map((column) => {
    const value = row[column];
    if (typeof value === "string") return { column, value };
    if (typeof value === "number" && Number.isFinite(value))
      return { column, value: String(value) };
    throw new Error(`keyset column ${column} is not a filterable value`);
  });
}
