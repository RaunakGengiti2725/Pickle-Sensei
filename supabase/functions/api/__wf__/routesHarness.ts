// Black-box harness for the edge function: imports ../index.ts with Deno.serve
// captured (so no port is opened), Supabase (PostgREST + Auth) and RevenueCat
// stubbed at the fetch layer, and env populated. Every request goes through
// the REAL handler (auth → rate limits → routing → billing/webhook/drills).

import { deletionChallengeHash, type AppleDeletionOutcome } from "../accountDeletionOperations.ts";
import { isPagedSelect, postgrestSelect } from "./postgrestStandIn.ts";
import { activeReleasePolicyRow } from "./releasePolicyFixture.ts";

interface StubDeletionOperation {
  id: string;
  ownerId: string;
  challengeHash: string;
  statusHash: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  statusExpiresAtMs: number;
  confirmedAtMs: number | null;
  superseded: boolean;
  appleRequired: boolean;
  appleOutcome: AppleDeletionOutcome | null;
  revenueCatCompleted: boolean;
  externalComplete: boolean;
  authIntent: boolean;
  authAbsent: boolean;
  completedAt: string | null;
  leaseToken: string | null;
  leaseUntilMs: number;
  attempts: number;
}

/** Stateful transport fixture only. The real SQL suite independently proves
 * ACLs, CAS/locking, credential fences, cascades and transactional receipts. */
export class AccountDeletionStub {
  operations = new Map<string, StubDeletionOperation>();
  missingOwners = new Set<string>();
  appleOwners = new Set<string>();

  constructor(private readonly tables: () => Record<string, unknown[]>) {}

  reset(): void {
    this.operations.clear();
    this.missingOwners.clear();
    this.appleOwners.clear();
  }

  age(operationId: string, milliseconds = 4_000): void {
    const operation = this.operations.get(operationId)!;
    operation.createdAtMs -= milliseconds;
    operation.expiresAtMs -= milliseconds;
    operation.statusExpiresAtMs -= milliseconds;
  }

  private rows(table: string): Record<string, unknown>[] {
    return (this.tables()[table] ??= []) as Record<string, unknown>[];
  }

  private external(ownerId: string): Record<string, unknown> | undefined {
    return this.rows("account_external_credentials").find(
      (row) => row.user_id === ownerId || row.user_id === undefined,
    );
  }

  private credentialRow(ownerId: string): Record<string, unknown> {
    const existing = this.external(ownerId);
    if (existing) return existing;
    const row = { user_id: ownerId };
    this.rows("account_external_credentials").push(row);
    return row;
  }

  private create(args: Record<string, unknown>, createdAtMs = Date.now()): StubDeletionOperation {
    const operation: StubDeletionOperation = {
      id: String(args.p_operation_id),
      ownerId: String(args.p_owner_id),
      challengeHash: String(args.p_challenge_hash),
      statusHash:
        typeof args.p_status_capability_hash === "string" ? args.p_status_capability_hash : null,
      createdAtMs,
      expiresAtMs: createdAtMs + 900_000,
      statusExpiresAtMs: createdAtMs + 86_400_000,
      confirmedAtMs: null,
      superseded: false,
      appleRequired: false,
      appleOutcome: null,
      revenueCatCompleted: false,
      externalComplete: false,
      authIntent: false,
      authAbsent: false,
      completedAt: null,
      leaseToken: null,
      leaseUntilMs: 0,
      attempts: 0,
    };
    this.operations.set(operation.id, operation);
    return operation;
  }

  private view(operation: StubDeletionOperation): Record<string, unknown> {
    return {
      state: operation.completedAt
        ? "completed"
        : operation.superseded
          ? "superseded"
          : operation.authAbsent
            ? "blocked"
            : operation.confirmedAtMs === null
              ? operation.expiresAtMs <= Date.now()
                ? "expired"
                : "pending"
              : operation.attempts >= 8 && operation.leaseUntilMs <= Date.now()
                ? "blocked"
                : "in_progress",
      completionReceipt: operation.completedAt ? { completedAt: operation.completedAt } : null,
      appleAuthorizationRevocation: operation.completedAt ? operation.appleOutcome : null,
    };
  }

  observeAuthDeletion(ownerId: string): void {
    this.missingOwners.add(ownerId);
    for (const operation of this.operations.values()) {
      if (operation.ownerId !== ownerId) continue;
      operation.authAbsent = true;
      operation.leaseToken = null;
      operation.leaseUntilMs = 0;
      if (operation.confirmedAtMs && operation.externalComplete && operation.authIntent) {
        operation.completedAt = new Date().toISOString();
      }
    }
  }

  private claim(operation: StubDeletionOperation | undefined): unknown {
    if (!operation?.confirmedAtMs) return { outcome: "invalid" };
    if (operation.completedAt)
      return { outcome: "completed", operationId: operation.id, status: this.view(operation) };
    if (this.missingOwners.has(operation.ownerId)) return { outcome: "blocked" };
    if (operation.leaseUntilMs > Date.now()) return { outcome: "busy", operationId: operation.id };
    if (operation.attempts >= 8 || operation.statusExpiresAtMs <= Date.now()) {
      return { outcome: "blocked" };
    }
    operation.leaseToken = crypto.randomUUID();
    operation.leaseUntilMs = Date.now() + 120_000;
    operation.attempts++;
    const external = this.external(operation.ownerId);
    const appleAction =
      operation.appleOutcome ??
      (external?.apple_revoked_at
        ? "revoked"
        : external?.apple_refresh_token_encrypted
          ? "revoke"
          : operation.appleRequired
            ? "manual_action_required"
            : "not_applicable");
    return {
      outcome: "claimed",
      operationId: operation.id,
      leaseToken: operation.leaseToken,
      leaseExpiresAt: new Date(operation.leaseUntilMs).toISOString(),
      confirmedAt: new Date(operation.confirmedAtMs).toISOString(),
      appleCompleted: operation.appleOutcome !== null,
      appleAction,
      appleRefreshTokenEncrypted:
        appleAction === "revoke" ? external?.apple_refresh_token_encrypted : null,
      revenueCatCompleted: operation.revenueCatCompleted,
      revenueCatAlreadyDeleted: Boolean(external?.revenuecat_deleted_at),
    };
  }

  async rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    const ownerId = String(args.p_owner_id);
    const owned = () =>
      [...this.operations.values()].filter((operation) => operation.ownerId === ownerId);
    const confirmed = () => owned().some((operation) => operation.confirmedAtMs !== null);
    let operation = this.operations.get(String(args.p_operation_id));
    if (name === "read_account_deletion_status") {
      return operation &&
        operation.statusHash === args.p_status_capability_hash &&
        operation.statusExpiresAtMs > Date.now()
        ? this.view(operation)
        : null;
    }
    if (name === "read_account_deletion_receipt") {
      return operation?.ownerId === ownerId ? this.view(operation) : null;
    }
    if (name === "account_deletion_allows_apple_bootstrap")
      return !confirmed() && !this.missingOwners.has(ownerId);
    if (name === "store_account_apple_credential") {
      if (this.missingOwners.has(ownerId)) return { outcome: "user_missing" };
      if (confirmed()) return { outcome: "confirmation_in_progress" };
      Object.assign(this.credentialRow(ownerId), {
        apple_refresh_token_encrypted: args.p_encrypted_token,
        apple_token_captured_at: new Date().toISOString(),
        apple_revoked_at: null,
      });
      this.appleOwners.add(ownerId);
      return { outcome: "stored" };
    }
    if (name === "begin_account_deletion_operation") {
      if (this.missingOwners.has(ownerId)) return { outcome: "user_missing" };
      if (confirmed()) return { outcome: "confirmation_in_progress" };
      for (const previous of owned()) previous.superseded = true;
      operation = this.create(args);
      return {
        outcome: "requested",
        operationId: operation.id,
        expiresAt: new Date(operation.expiresAtMs).toISOString(),
        statusExpiresAt: new Date(operation.statusExpiresAtMs).toISOString(),
      };
    }
    if (name === "confirm_account_deletion_operation") {
      operation = owned().find(
        (row) =>
          row.challengeHash === args.p_challenge_hash &&
          (args.p_operation_id === null || row.id === args.p_operation_id),
      );
      if (!operation && args.p_operation_id === null && !owned().some((row) => !row.superseded)) {
        for (const legacy of this.rows("account_deletion_requests")) {
          if (legacy.user_id !== undefined && legacy.user_id !== ownerId) continue;
          if (
            (await deletionChallengeHash(ownerId, String(legacy.challenge))) !==
            args.p_challenge_hash
          )
            continue;
          // Model the SQL lock/CAS if two legacy adoptions interleave at the hash.
          if (owned().some((row) => !row.superseded)) return this.rpc(name, args);
          const createdAt = Date.parse(String(legacy.created_at));
          const expiresAt = Math.min(createdAt + 900_000, Date.parse(String(legacy.expires_at)));
          if (this.missingOwners.has(ownerId)) return { outcome: "invalid" };
          if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
            return { outcome: "expired" };
          if (createdAt > Date.now() - 3_000) return { outcome: "too_fast" };
          operation = this.create({ ...args, p_operation_id: crypto.randomUUID() }, createdAt);
          operation.expiresAtMs = expiresAt;
          break;
        }
      }
      if (!operation || operation.superseded) return { outcome: "invalid" };
      if (operation.confirmedAtMs === null) {
        if (this.missingOwners.has(ownerId)) return { outcome: "invalid" };
        if (operation.expiresAtMs <= Date.now()) return { outcome: "expired" };
        if (operation.createdAtMs > Date.now() - 3_000) return { outcome: "too_fast" };
        operation.confirmedAtMs = Date.now();
        operation.appleRequired =
          this.appleOwners.has(ownerId) ||
          this.rows("profiles").some((row) => row.id === ownerId && row.provider === "apple");
      }
      return this.claim(operation);
    }
    if (name === "claim_account_deletion_work")
      return this.claim(operation?.ownerId === ownerId ? operation : undefined);
    if (
      !operation ||
      operation.ownerId !== ownerId ||
      operation.leaseToken !== args.p_lease_token ||
      operation.leaseUntilMs <= Date.now() ||
      operation.authAbsent
    )
      return { outcome: "stale_lease" };
    if (name === "fail_account_deletion_operation") {
      operation.leaseToken = null;
      operation.leaseUntilMs = 0;
      return { outcome: "released" };
    }
    if (name === "set_account_deletion_auth_intent") {
      if (!operation.externalComplete) throw new Error("external checkpoints required");
      operation.authIntent = true;
      return { outcome: "intent_recorded" };
    }
    if (name === "checkpoint_account_deletion_operation") {
      if (args.p_checkpoint === "apple_unrevocable") {
        const external = this.external(ownerId);
        if (
          args.p_apple_outcome !== "manual_action_required" ||
          operation.appleOutcome !== null ||
          !external?.apple_refresh_token_encrypted ||
          external.apple_revoked_at
        )
          throw new Error("invalid unrevocable Apple checkpoint");
        external.apple_refresh_token_encrypted = null;
        external.apple_token_captured_at = null;
        operation.appleOutcome = "manual_action_required";
      } else if (args.p_checkpoint === "apple") {
        const external = this.external(ownerId);
        const expected =
          operation.appleOutcome ??
          (external?.apple_revoked_at || external?.apple_refresh_token_encrypted
            ? "revoked"
            : operation.appleRequired
              ? "manual_action_required"
              : "not_applicable");
        if (args.p_apple_outcome !== expected) throw new Error("invalid Apple checkpoint");
        operation.appleOutcome = expected;
        if (operation.appleOutcome === "revoked")
          this.credentialRow(ownerId).apple_revoked_at = new Date().toISOString();
      } else if (args.p_checkpoint === "revenuecat") {
        if (!operation.appleOutcome) throw new Error("Apple checkpoint required");
        operation.revenueCatCompleted = true;
        this.credentialRow(ownerId).revenuecat_deleted_at = new Date().toISOString();
      } else if (args.p_checkpoint === "external_complete") {
        if (!operation.appleOutcome || !operation.revenueCatCompleted)
          throw new Error("external checkpoints required");
        operation.externalComplete = true;
      } else if (args.p_checkpoint !== "lease_check") throw new Error("unexpected checkpoint");
      return { outcome: "checkpointed" };
    }
    throw new Error("unexpected deletion RPC");
  }
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  realFetch: typeof fetch;
  realServe: typeof Deno.serve;
  calls: RecordedCall[];
  respond: (call: RecordedCall) => Response | null | Promise<Response | null>;
  /** Subscriber JSON RevenueCat returns (null → HTTP 500 from RevenueCat). */
  subscriber: Record<string, unknown> | null;
  /** Rows returned for PostgREST GET by table name. */
  tables: Record<string, unknown[]>;
  /** Rows returned for PostgREST RPC POST by function name. */
  rpcs: Record<string, unknown>;
  rpcErrors: Record<string, number>;
  billingOrder: number;
  billingMissingUsers: string[];
  deletion: AccountDeletionStub;
  userStatus: number;
  logoutStatus: number;
  /** Test-only copy of the generated AES key used by the lazy edge config. */
  appleTokenEncryptionKey: string;
  reset(): void;
  callsTo(fragment: string): RecordedCall[];
}

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
export const WEBHOOK_SECRET = "wf-test-webhook-secret";
export const SUPABASE_URL = "http://supabase.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Match jsonb object-key equality in the billing RPC stub; real locking,
// privileges and transaction semantics are exercised by security_regression.sql.
const billingPayloadKey = (value: unknown): string | undefined =>
  JSON.stringify(value, (_key, item) =>
    isRecord(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

export function billingRpcResponse(
  state: Pick<Harness, "tables" | "billingOrder" | "billingMissingUsers">,
  name: string,
  args: Record<string, unknown>,
): Response | null {
  if (
    ![
      "claim_billing_webhook_delivery",
      "release_billing_webhook_delivery",
      "begin_billing_verification",
      "persist_billing_verdict",
      "complete_billing_webhook",
    ].includes(name)
  )
    return null;
  const reply = (value: unknown) => Response.json(value);
  const failure = (message: string, code = "22023") =>
    Response.json({ code, message }, { status: 400 });
  const rows = (table: string) => (state.tables[table] ??= []) as Record<string, unknown>[];
  const claims = rows("billing_webhook_claims");
  const events = rows("webhook_events");
  const tickets = rows("billing_verification_tickets");
  const entitlements = rows("billing_entitlements");
  const now = Date.now();
  const uuid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  const ids = (value: unknown) =>
    Array.isArray(value) ? value.filter(uuid).map((id) => id.toLowerCase()) : [];
  const payload = isRecord(args.p_payload) ? args.p_payload : {};
  const event = isRecord(payload.event) ? payload.event : {};
  const subjects = [
    ...new Set([
      ...(uuid(event.app_user_id)
        ? [event.app_user_id.toLowerCase()]
        : ids(event.aliases).slice(0, 1)),
      ...ids(event.transferred_from),
      ...ids(event.transferred_to),
    ]),
  ];
  let claim = claims.find((row) => row.event_id === args.p_event_id);
  let seen = events.find((row) => row.id === args.p_event_id);
  const liveLease = (token: unknown) =>
    claim && uuid(token) && claim.lease_token === token && Number(claim.lease_expires_at_ms) > now;
  if (
    name === "claim_billing_webhook_delivery" ||
    name === "complete_billing_webhook" ||
    (name === "begin_billing_verification" && args.p_event_id != null)
  ) {
    if (
      typeof args.p_event_id !== "string" ||
      !isRecord(payload.event) ||
      subjects.length > 16 ||
      (typeof event.id === "string" && event.id !== args.p_event_id) ||
      (claim && billingPayloadKey(claim.payload) !== billingPayloadKey(payload)) ||
      (seen &&
        (billingPayloadKey(seen.payload) !== billingPayloadKey(payload) ||
          seen.provider !== "revenuecat"))
    )
      return failure("conflicting webhook binding");
    if (!claim) {
      claim = { event_id: args.p_event_id, payload };
      claims.push(claim);
    }
    if (seen?.processed_at != null) {
      return reply(
        name === "complete_billing_webhook"
          ? { received: true, duplicate: true }
          : { outcome: "duplicate", event_id: args.p_event_id },
      );
    }
  }
  if (name === "claim_billing_webhook_delivery") {
    if (
      Number(claim!.lease_expires_at_ms) > now ||
      (seen && !claim!.lease_token && Date.parse(String(seen.claimed_at)) > now - 300_000)
    )
      return reply({ outcome: "in_progress", event_id: args.p_event_id });
    if (args.p_waiting === true) return reply({ outcome: "released", event_id: args.p_event_id });
    const token = crypto.randomUUID();
    if (!seen) {
      seen = {
        id: args.p_event_id,
        provider: "revenuecat",
        event_type: typeof event.type === "string" ? event.type : "unknown",
        app_user_id: subjects[0] ?? null,
        payload,
        received_at: new Date(now).toISOString(),
        processed_at: null,
      };
      events.push(seen);
    }
    seen.claimed_at = new Date(now).toISOString();
    claim!.lease_token = token;
    claim!.lease_expires_at_ms = now + 300_000;
    return reply({ outcome: "claimed", event_id: args.p_event_id, lease_token: token });
  }
  if (name === "release_billing_webhook_delivery") {
    if (
      !claim ||
      !uuid(args.p_lease_token) ||
      claim.lease_token !== args.p_lease_token ||
      billingPayloadKey(claim.payload) !== billingPayloadKey(payload)
    ) {
      return reply({ outcome: "stale_lease" });
    }
    if (seen && seen.processed_at === null) seen.claimed_at = new Date(now - 300_000).toISOString();
    claim.lease_token = null;
    claim.lease_expires_at_ms = null;
    return reply({ outcome: "released" });
  }
  if (name === "begin_billing_verification") {
    const userIds = args.p_user_ids;
    if (
      !Array.isArray(userIds) ||
      !userIds.every(uuid) ||
      new Set(userIds).size !== userIds.length ||
      userIds.length > 16
    )
      return failure("invalid verification subjects");
    if (args.p_event_id != null) {
      if (!liveLease(args.p_lease_token)) return failure("stale webhook lease", "55000");
      if (billingPayloadKey([...userIds].sort()) !== billingPayloadKey([...subjects].sort())) {
        return failure("webhook subject mismatch");
      }
    } else if (userIds.length !== 1 || args.p_payload != null || args.p_lease_token != null) {
      return failure("invalid sync binding");
    }
    const order = ++state.billingOrder;
    return reply(
      [...userIds].sort().map((userId) => {
        if (state.billingMissingUsers.includes(userId))
          return { outcome: "user_missing", user_id: userId };
        const ticket = {
          id: crypto.randomUUID(),
          user_id: userId,
          verification_order: order,
          issued_at: new Date(now).toISOString(),
          event_id: args.p_event_id ?? null,
          payload: args.p_payload ?? null,
          webhook_lease_token: args.p_lease_token ?? null,
          verdict: null,
        };
        tickets.push(ticket);
        return { outcome: "issued", user_id: userId, ticket_id: ticket.id };
      }),
    );
  }
  if (name === "persist_billing_verdict") {
    const userId = String(args.p_user_id);
    if (state.billingMissingUsers.includes(userId))
      return reply({ outcome: "user_missing", user_id: userId });
    const ticket = tickets.find((row) => row.id === args.p_ticket_id && row.user_id === userId);
    const verdict = args.p_verdict;
    if (
      !ticket ||
      !isRecord(verdict) ||
      Object.keys(verdict).some(
        (key) =>
          !["premium", "productKey", "expiresAt", "activeEntitlements", "verifiedAt"].includes(key),
      ) ||
      typeof verdict.premium !== "boolean" ||
      !(verdict.productKey === null || typeof verdict.productKey === "string") ||
      !(
        verdict.expiresAt === null ||
        (typeof verdict.expiresAt === "string" && Number.isFinite(Date.parse(verdict.expiresAt)))
      ) ||
      !Array.isArray(verdict.activeEntitlements) ||
      !verdict.activeEntitlements.every(
        (value) => value === "pickle_sensei_pro" || value === "premium",
      ) ||
      verdict.premium !== verdict.activeEntitlements.length > 0 ||
      (!verdict.premium && (verdict.productKey !== null || verdict.expiresAt !== null)) ||
      (Object.hasOwn(verdict, "verifiedAt") &&
        (typeof verdict.verifiedAt !== "string" ||
          !Number.isFinite(Date.parse(verdict.verifiedAt)))) ||
      (ticket.verdict !== null && billingPayloadKey(ticket.verdict) !== billingPayloadKey(verdict))
    ) {
      return failure("invalid or conflicting verification ticket");
    }
    if (ticket.event_id !== null) {
      claim = claims.find((row) => row.event_id === ticket.event_id);
      if (!liveLease(ticket.webhook_lease_token)) return failure("stale webhook lease", "55000");
    }
    ticket.verdict = verdict;
    const reportedAt =
      typeof verdict.verifiedAt === "string" ? Date.parse(verdict.verifiedAt) : now;
    const issuedAt = Date.parse(String(ticket.issued_at));
    ticket.verified_at ??= new Date(
      reportedAt < issuedAt - 86_400_000 || reportedAt > issuedAt + 300_000 ? issuedAt : reportedAt,
    ).toISOString();
    const index = entitlements.findIndex((row) => row.user_id === userId);
    const existing = entitlements[index];
    const applied =
      !existing || Number(existing.verification_order ?? 0) < Number(ticket.verification_order);
    if (applied) {
      const row = {
        user_id: userId,
        premium: verdict.premium,
        product_key: verdict.productKey,
        expires_at: verdict.expiresAt,
        active_entitlements: verdict.activeEntitlements,
        verified_at:
          existing &&
          Date.parse(String(existing.verified_at)) > Date.parse(String(ticket.verified_at))
            ? existing.verified_at
            : ticket.verified_at,
        verification_order: ticket.verification_order,
      };
      if (index < 0) entitlements.push(row);
      else entitlements[index] = row;
    }
    const row = entitlements.find((row) => row.user_id === userId)!;
    const premium =
      row.premium === true && (row.expires_at === null || Date.parse(String(row.expires_at)) > now);
    return reply({
      outcome: "persisted",
      user_id: userId,
      applied,
      billing: {
        premium,
        productKey: premium ? row.product_key : null,
        expiresAt: premium ? row.expires_at : null,
        activeEntitlements: premium ? row.active_entitlements : [],
        verifiedAt: row.verified_at,
      },
    });
  }
  if (!liveLease(args.p_lease_token)) return failure("stale webhook lease", "55000");
  const proofs = args.p_tickets;
  if (!isRecord(proofs) || Object.keys(proofs).some((key) => !subjects.includes(key))) {
    return failure("invalid completion binding");
  }
  for (const userId of subjects) {
    if (state.billingMissingUsers.includes(userId)) continue;
    const ticket = tickets.find((row) => row.id === proofs[userId] && row.user_id === userId);
    const row = entitlements.find((row) => row.user_id === userId);
    if (
      !ticket?.verdict ||
      ticket.event_id !== args.p_event_id ||
      ticket.webhook_lease_token !== args.p_lease_token ||
      billingPayloadKey(ticket.payload) !== billingPayloadKey(payload) ||
      !row ||
      Number(row.verification_order) < Number(ticket.verification_order)
    ) {
      return failure("incomplete webhook verification", "55000");
    }
  }
  if (!seen) return failure("webhook reservation missing", "55000");
  seen.processed_at = new Date(now).toISOString();
  claim!.lease_token = null;
  claim!.lease_expires_at_ms = null;
  return reply({
    received: true,
    verified:
      subjects.length > 0 && subjects.every((id) => !state.billingMissingUsers.includes(id)),
  });
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Google ID token (issuer routing only — verification
 * is stubbed in the fake Supabase Auth). */
export function fakeGoogleIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function fakeAppleIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function fakeSupabaseAccessToken(
  sub = TEST_USER_ID,
  sessionId = crypto.randomUUID(),
): string {
  return `${b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )}.sig`;
}

function jwtSubject(token: string): string | null {
  try {
    const segment = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(segment)).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function testApplePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    bytesToBase64(pkcs8)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

let harness: Harness | null = null;

export async function loadHarness(): Promise<Harness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
  const appleTokenEncryptionKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;
  const releasePolicy = await activeReleasePolicyRow();
  const defaultRpcs = () => ({
    is_api_session_active: true,
    read_analysis_release_policy: releasePolicy,
  });
  const state: Harness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    realFetch,
    realServe,
    calls: [],
    respond: () => null,
    subscriber: { entitlements: {} },
    tables: {},
    rpcs: defaultRpcs(),
    rpcErrors: {},
    billingOrder: 0,
    billingMissingUsers: [],
    deletion: new AccountDeletionStub(() => state.tables),
    userStatus: 200,
    logoutStatus: 204,
    appleTokenEncryptionKey,
    reset() {
      state.calls = [];
      state.respond = () => null;
      state.subscriber = { entitlements: {} };
      state.tables = {};
      state.rpcs = defaultRpcs();
      state.rpcErrors = {};
      state.billingOrder = 0;
      state.billingMissingUsers = [];
      state.deletion.reset();
      state.userStatus = 200;
      state.logoutStatus = 204;
    },
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call = { url, method: request.method, headers, body };
    state.calls.push(call);
    const response = await state.respond(call);
    if (response) return response;

    if (url.startsWith(RC_URL)) {
      if (!state.subscriber) {
        return new Response("upstream error", { status: 500 });
      }
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: state.subscriber,
      });
    }
    if (url === "https://appleid.apple.com/auth/token") {
      return jsonResponse(200, {
        refresh_token: "apple-refresh-token-from-grant",
        id_token: fakeAppleIdToken(),
      });
    }
    if (url === "https://appleid.apple.com/auth/revoke") {
      return new Response(null, { status: 200 });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      const payload = isRecord(body) ? body : {};
      const token = typeof payload.id_token === "string" ? payload.id_token : "";
      const segment = token.split(".")[1] ?? "";
      let sub = TEST_USER_ID;
      try {
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        sub = String(JSON.parse(atob(padded)).sub ?? TEST_USER_ID);
      } catch {
        // keep default
      }
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: `session-for-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: "refresh",
        user: {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: "user@example.com",
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
      return state.logoutStatus === 204
        ? new Response(null, { status: 204 })
        : jsonResponse(state.logoutStatus, { error_code: "injected", msg: "upstream down" });
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      if (state.userStatus !== 200) {
        return jsonResponse(state.userStatus, { error_code: "injected", msg: "upstream down" });
      }
      return jsonResponse(200, {
        id: jwtSubject((headers.authorization ?? "").replace(/^Bearer /, "")) ?? TEST_USER_ID,
        email: "user@example.com",
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "google", providers: ["google"] },
      });
    }
    if (request.method === "DELETE" && url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
      state.deletion.observeAuthDeletion(
        decodeURIComponent(new URL(url).pathname.slice("/auth/v1/admin/users/".length)),
      );
      return jsonResponse(200, {});
    }
    if (request.method === "GET" && url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
      if (
        headers.authorization !== "Bearer service-role-test-key" ||
        headers.apikey !== "service-role-test-key"
      ) {
        return jsonResponse(403, { error_code: "not_admin", msg: "server credentials required" });
      }
      return jsonResponse(200, {
        id: decodeURIComponent(new URL(url).pathname.slice("/auth/v1/admin/users/".length)),
        aud: "authenticated",
        role: "authenticated",
      });
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = new URL(url).pathname.slice("/rest/v1/".length);
      if (table.startsWith("rpc/")) {
        const fn = table.slice("rpc/".length);
        if (fn === "get_api_request_key" && !(fn in state.rpcs)) {
          return headers.authorization === "Bearer service-role-test-key"
            ? jsonResponse(200, "a1".repeat(32))
            : jsonResponse(403, { message: "server credentials required" });
        }
        if (fn in state.rpcErrors) {
          return jsonResponse(state.rpcErrors[fn], {
            code: "XX000",
            message: "injected rpc failure",
          });
        }
        if (fn in state.rpcs) return jsonResponse(200, state.rpcs[fn]);
        if (fn.includes("account_deletion") || fn === "store_account_apple_credential") {
          if (
            headers.authorization !== "Bearer service-role-test-key" ||
            headers.apikey !== "service-role-test-key"
          ) {
            return jsonResponse(403, { code: "42501", message: "server credentials required" });
          }
          return jsonResponse(200, await state.deletion.rpc(fn, isRecord(body) ? body : {}));
        }
        if (
          [
            "claim_billing_webhook_delivery",
            "release_billing_webhook_delivery",
            "begin_billing_verification",
            "persist_billing_verdict",
            "complete_billing_webhook",
          ].includes(fn)
        ) {
          if (
            headers.authorization !== "Bearer service-role-test-key" ||
            headers.apikey !== "service-role-test-key"
          ) {
            return jsonResponse(403, { code: "42501", message: "server credentials required" });
          }
          return billingRpcResponse(state, fn, isRecord(body) ? body : {})!;
        }
        return jsonResponse(404, {
          code: "PGRST202",
          message: `rpc ${fn} not stubbed`,
        });
      }
      if (request.method === "GET") {
        let rows = state.tables[table] ?? [];
        if (table === "webhook_events" || table === "billing_entitlements") {
          const key = table === "webhook_events" ? "id" : "user_id";
          const filter = new URL(url).searchParams.get(key);
          if (filter?.startsWith("eq.")) {
            rows = rows.filter((row) => isRecord(row) && row[key] === filter.slice(3));
          }
        }
        if (isPagedSelect(new URL(url))) {
          rows = postgrestSelect(new URL(url), rows.filter(isRecord));
        }
        const accept = headers["accept"] ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) {
            return new Response(
              JSON.stringify({
                code: "PGRST116",
                message: "0 rows",
                details: null,
                hint: null,
              }),
              {
                status: 406,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (table === "account_external_credentials" && request.method !== "GET") {
        return jsonResponse(403, { code: "42501", message: "fenced credential helpers required" });
      }
      if (request.method === "POST" || request.method === "PATCH") {
        if (table === "webhook_events" || table === "billing_entitlements") {
          return jsonResponse(403, { code: "42501", message: "ordered billing helpers required" });
        }
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`unexpected fetch in test: ${request.method} ${url}`, { status: 599 });
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  harness = state;
  return state;
}

export function webhookRequest(
  event: Record<string, unknown> | null,
  options: { authorization?: string | null; ip?: string; rawBody?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization =
    options.authorization === undefined ? WEBHOOK_SECRET : options.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  headers.set("x-forwarded-for", options.ip ?? "203.0.113.10");
  return new Request("http://edge.test/functions/v1/api/webhooks/revenuecat", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(event ? { api_version: "1.0", event } : {}),
  });
}

export function userRequest(
  method: string,
  path: string,
  options: {
    token?: string;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    Authorization: `Bearer ${options.token ?? fakeGoogleIdToken()}`,
    "x-forwarded-for": options.ip ?? "203.0.113.20",
    ...options.headers,
  });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function captureConsole<T>(run: () => Promise<T>): Promise<{
  result: T;
  logs: Array<{ level: string; args: unknown[] }>;
  accessLogs: string[];
  output: string;
}> {
  const target = console;
  const levels = ["error", "warn", "info", "log", "debug"] as const;
  const originals = levels.map((level) => target[level]);
  const logs: Array<{ level: string; args: unknown[] }> = [];
  for (const level of levels) {
    target[level] = (...args: unknown[]) => {
      logs.push({ level, args });
    };
  }
  try {
    const result = await run();
    const isAccessLog = (entry: { level: string; args: unknown[] }) =>
      entry.level === "log" &&
      entry.args.length === 1 &&
      typeof entry.args[0] === "string" &&
      entry.args[0].startsWith('{"evt":"api_request",');
    return {
      result,
      logs: logs.filter((entry) => !isAccessLog(entry)),
      accessLogs: logs.filter(isAccessLog).map((entry) => String(entry.args[0])),
      output: Deno.inspect(logs, { depth: Infinity, strAbbreviateSize: Infinity }),
    };
  } finally {
    levels.forEach((level, index) => {
      target[level] = originals[index];
    });
  }
}

export function activeSubscriber(
  expiresDate: string | null = new Date(Date.now() + 86_400_000).toISOString(),
  productId = "pickle_sensei_pro_monthly",
): Record<string, unknown> {
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: expiresDate,
        product_identifier: productId,
      },
    },
  };
}
