// W04-04 — POST /v1/offline/receipts: delayed reconciliation of offline
// consumption receipts. A device that rendered ratings under an offline grant
// reports them later, in batches, possibly out of order and more than once.
// Each receipt settles AT MOST ONCE, bound to the exact owner / installation /
// grant (compact-JWS digest) / ticket / operation / result / output digest it
// names; a duplicate delivery replays the durable verdict without a second
// settlement; a receipt whose evidence cannot be verified (unknown signing
// key, foreign owner, digest mismatch, missing output, a second result for the
// same operation) is HELD as `reconciliation_required` with its ticket left
// reserved — never refunded, never re-executed under a new operation id.
//
// Two halves, both black-box:
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer with a durable in-memory receipt store keyed exactly like the
//     RPC): the route verifies the grant against the configured key, binds the
//     receipt to it, computes the output digest itself and calls
//     settle_offline_receipt() as the CALLER with the hold reason it derived;
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with every
//     migration applied (./xc_pg_up.sh, XC_PG_URL): one consumed ledger event
//     per ticket however many times the receipt arrives, a conflicting second
//     receipt for the same operation is held and the ticket stays allocated,
//     the settlement table refuses direct client writes.
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a
// pass (the W04-04-AC2 gate runs with XC_PG_URL set).
//
// Round 2 additionally pins: a ticket re-issued under a refreshed grant
// generation settles once through a receipt bound to that grant (allocation
// LINEAGE, not the literal allocated row); a receipt that arrives before its
// session syncs is answered `pending` (nothing durable) and settles once the
// session exists; a receipt for a grant issued under a previous, still
// approved release policy settles after the authority rotates (the route reads
// that release's lineage as the service role — never from the token) while a
// withdrawn lineage is HELD as grant_revoked; lifecycleSequence beyond int4 is
// a durable verdict.
//
// Runs unchanged against BASE_SHA, where the route answers 404 and the RPC
// does not exist, so every test fails there.
//
// Round 6 pins the 1.0 WIRE CONTRACT the shipping app speaks: each entry's
// `receipt` is the DEVICE receipt exactly as apps/mobile OfflineReceiptSubmission
// persists it (no nativeTime / attestation, with queuedAt) and the answer is
// { receipts: [{ receiptId, status, reasonCode, financialDisposition, resultId,
// delivery }], rejected: [{ receiptId, code, message }] } — what
// parseOfflineReceiptVerdicts reads, every submitted receiptId named exactly
// once. And the ORDERING under a reversible deny-new freeze: durable replay,
// durable HOLD replay and the same-id/other-digest conflict are decided by
// settle_offline_receipt() (the freeze travels to SQL as p_defer_new) BEFORE
// the freeze can answer; only a genuinely new chargeable receipt is pending.
// Against the round-6 BASE_SHA (d446dcdd), where the route demands the
// full-evidence receipt and answers results[], the wire-contract and freeze
// tests fail.

import postgres from "postgres";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  type OfflineDeviceReceipt,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
  type OfflineReleasedArtifacts,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import {
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
  digestOfflineGrantTransport,
} from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
  OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS,
  offlineGrantClaimsFromIssuance,
  type OfflineGrantKey,
  signOfflineExecutionGrant,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const SETTLE_RPC = "/rest/v1/rpc/settle_offline_receipt";
const LINEAGE_RPC = "/rest/v1/rpc/read_analysis_release_policy_lineage";
const SERVICE_BEARER = "Bearer service-role-test-key";
const CONSUME_RPC = "/rest/v1/rpc/consume_offline_ticket";
const RELEASE_RPC = "/rest/v1/rpc/release_offline_ticket";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-test-key";
const FOREIGN_KID = "w04-04-foreign-key";
const OLD_KID = "w04-04-retired-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04";
const GRANT_ID = "64444444-4444-4444-8444-444444444444";
const TICKET_A = "65555555-5555-4555-8555-555555555551";
const TICKET_B = "65555555-5555-4555-8555-555555555552";
const SHA256_RE = /^[0-9a-f]{64}$/;
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const foreignKeyPair = await generateKeyPair("ES256", { extractable: true });
const oldKeyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
const oldPrivateJwk = { ...(await exportJWK(oldKeyPair.privateKey)), kid: OLD_KID };
const oldPublicJwk = { ...(await exportJWK(oldKeyPair.publicKey)), kid: OLD_KID };
/** The key that signed grants BEFORE a routine rotation; the ring keeps its
 * public half with an explicit retirement window. */
const oldSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: OLD_KID,
  key: oldKeyPair.privateKey,
};
const signingKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: keyPair.privateKey,
};
const foreignSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: FOREIGN_KID,
  key: foreignKeyPair.privateKey,
};
// The verification key is imported only to prove the fixture key pair is a
// valid ES256 offline grant key; the route itself reads the env ring.
await importOfflineGrantVerificationKey(KID, await exportJWK(keyPair.publicKey));

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

/** The release authority AFTER a routine rotation: a second, approved,
 * non-withdrawn policy with its own model lineage becomes active while the
 * first stays installed (never withdrawn). */
async function rotatedReleasePolicyRow(): Promise<Record<string, unknown>> {
  const artifact = { version: "harness-2", sha256: "d".repeat(64) };
  const lineage = {
    pipeline: artifact,
    definition: artifact,
    model: artifact,
    preprocessing: artifact,
    calibration: artifact,
    dataset: artifact,
    validationReport: artifact,
    supportedDomain: artifact,
  };
  const issuedAt = Math.floor(Date.now() / 1000) - 3_600;
  const document: AnalysisReleasePolicyDocument = {
    ...HARNESS_RELEASE_POLICY,
    version: "harness-policy-2",
    validFrom: issuedAt,
    validUntil: issuedAt + 365 * 86_400,
    mechanics: { lineage },
    benchmark: { ...HARNESS_RELEASE_POLICY.benchmark, lineage },
  };
  return {
    document,
    canonicalDocument: canonicalizeOfflineJson(document),
    denyNewAuthorizations: false,
    approval: {
      policy: { version: document.version, sha256: await digestCanonicalOfflineJson(document) },
      mechanicsApprovedAt: issuedAt,
      benchmarkApprovedAt: issuedAt,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  };
}

/** What read_analysis_release_policy_lineage(p_policy_sha256) answers for a
 * sha the authority does not know: the same "no policy" row shape the active
 * reader uses, which the edge verifier resolves to null. */
const UNKNOWN_LINEAGE_ROW = {
  document: null,
  canonicalDocument: null,
  denyNewAuthorizations: true,
  approval: null,
};

interface LineageParams {
  p_policy_sha256: string;
}

function lineageParams(call: RecordedCall): LineageParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as LineageParams;
}

/** Serve the installed (never withdrawn) first policy by its sha, exactly as
 * the migration's reader does, on top of the durable settlement stand-in. */
function lineageRespond(
  known: Record<string, Record<string, unknown>>,
): (call: RecordedCall) => Response | null {
  return (call) => {
    if (!call.url.endsWith(LINEAGE_RPC)) return durableRespond(call);
    const row = known[lineageParams(call).p_policy_sha256] ?? UNKNOWN_LINEAGE_ROW;
    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

let userSeq = 0;
/** A fresh account per test so the per-user route budget never leaks across tests. */
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0404-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(
  ownerId: string,
  options: {
    grantId?: string;
    tickets?: string[];
    installationKeyId?: string;
    issuedAt?: number;
  } = {},
): OfflineExecutionGrantClaims {
  const issuedAt = options.issuedAt ?? nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: options.grantId ?? GRANT_ID,
      generation: 3,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 7 * DAY),
      entitlement_expires_at: null,
      ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
    },
    {
      issuer: ISSUER,
      ownerId,
      installationKeyId: options.installationKeyId ?? INSTALLATION_KEY,
      release: RELEASE,
    },
  );
}

function proClaims(ownerId: string): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: GRANT_ID,
      generation: 1,
      entitlement_source: "verified_store",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 3 * DAY),
      entitlement_expires_at: iso(issuedAt + 30 * DAY),
      ticket_ids: [],
    },
    { issuer: ISSUER, ownerId, installationKeyId: INSTALLATION_KEY, release: RELEASE },
  );
}

async function sign(
  claims: OfflineExecutionGrantClaims,
  key: OfflineGrantKey = signingKey,
): Promise<OfflineSignedExecutionGrant> {
  return await signOfflineExecutionGrant(claims, key, {
    binding: {
      issuer: ISSUER,
      allowedKeyIds: [key.kid],
      ownerId: claims.sub,
      installationKeyId: claims.installationKeyId,
    },
    release: RELEASE,
    nowEpochSeconds: claims.iat + 1,
  });
}

/** The flat output the device durably delivered (the consume_offline_ticket()
 * p_shot shape); `id` is the result id the receipt names. */
function output(
  resultId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: resultId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [{ key: "prep", startMs: 0, representativeMs: 50, endMs: 100, confidence: 0.8 }],
    checkpoints: [
      {
        key: "paddle_height",
        score: 70,
        confidence: 0.8,
        band: "green",
        direction: "up",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

interface ReceiptOptions {
  receiptId: string;
  ownerId: string;
  grant: OfflineSignedExecutionGrant;
  claims: OfflineExecutionGrantClaims;
  ticket: OfflineFreeTicketReference | null;
  lifecycleSequence: number;
  operationId: string;
  resultId: string;
  fullOutputSha256: string;
  billingDisposition?: OfflineDeviceReceipt["billingDisposition"];
  installationKeyId?: string;
  grantJwsSha256?: string;
}

/** The DEVICE receipt exactly as apps/mobile/src/data/api.ts
 * OfflineReceiptSubmission persists and posts it — the OfflineConsumptionReceipt
 * minus the server-side `settlement` / `settledAt`, key for key. */
async function receipt(options: ReceiptOptions): Promise<OfflineDeviceReceipt> {
  return {
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: options.grantJwsSha256 ?? (await digestOfflineGrantTransport(options.grant)),
    lifecycleSequence: options.lifecycleSequence,
    ticket: options.ticket,
    operationId: options.operationId,
    resultId: options.resultId,
    fullOutputSha256: options.fullOutputSha256,
    billingDisposition: options.billingDisposition ?? "joint_verification_required",
    queuedAt: "2026-09-08T12:00:00.000Z",
  };
}

/** The same receipt in the FULL-EVIDENCE offline-result-receipt-v1 form (native
 * time + App Attest assertion), which the shared validator still accepts for
 * that form but the wire contract does not carry. */
function fullEvidenceForm(device: OfflineDeviceReceipt): Record<string, unknown> {
  const { queuedAt: _queuedAt, ...rest } = device;
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    ...rest,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04",
      elapsedMs: 120_000 * device.lifecycleSequence,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "QUJDRA",
      clientDataSha256: "c".repeat(64),
    },
  };
}

function ticketRef(
  ticketId: string,
  claims: OfflineExecutionGrantClaims,
): OfflineFreeTicketReference {
  assert(claims.allocation, "free grant expected");
  return {
    allocationId: claims.allocation.allocationId,
    generation: claims.allocation.generation,
    ticketId,
  };
}

/** One settled receipt fixture: grant, receipt and its durably delivered output. */
async function settledFixture(
  ownerId: string,
  ticketId: string,
  n: number,
  options: { key?: OfflineGrantKey; claims?: OfflineExecutionGrantClaims } = {},
): Promise<{
  claims: OfflineExecutionGrantClaims;
  grant: OfflineSignedExecutionGrant;
  receipt: OfflineDeviceReceipt;
  output: Record<string, unknown>;
}> {
  const claims = options.claims ?? freeClaims(ownerId);
  const grant = await sign(claims, options.key);
  const resultId = `7000000${n}-0404-4000-8000-000000000${String(n).padStart(3, "0")}`;
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: ticketRef(ticketId, claims),
    lifecycleSequence: n,
    operationId: `operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { claims, grant, receipt: rec, output: out };
}

// ---------------------------------------------------------------------------
// Durable RPC stand-in: the harness answers settle_offline_receipt() exactly
// like the migration — first delivery settles or holds and is remembered by
// (caller, receiptId, receipt digest); the same receipt again replays the
// remembered verdict; the same receiptId with another digest is a conflict.
// ---------------------------------------------------------------------------

interface SettleRow {
  result: string;
  delivery: string | null;
  status: string | null;
  reason_code: string | null;
  financial_disposition: string | null;
  result_id: string | null;
}

interface SettleParams {
  p_receipt: Record<string, unknown>;
  p_receipt_sha256: string;
  p_output: Record<string, unknown> | null;
  p_hold_reason: string | null;
  /** The reversible deny-new freeze on the release the grant names: a
   * genuinely NEW chargeable receipt is answered pending (nothing durable)
   * — decided by the RPC after the durable lookup, never by the edge. */
  p_defer_new: boolean;
}

const durable = new Map<string, { sha256: string; row: SettleRow }>();
/** Sessions the stand-in database knows (the app's session outbox may sync
 * AFTER the receipt that names one arrives). */
const syncedSessions = new Set<string>();

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  const key = `${call.headers.authorization}|${params.p_receipt.receiptId}`;
  const known = durable.get(key);
  let row: SettleRow;
  if (known) {
    row =
      known.sha256 === params.p_receipt_sha256
        ? { ...known.row, delivery: "replayed" }
        : {
            result: "offline.receipt_conflict",
            delivery: null,
            status: null,
            reason_code: null,
            financial_disposition: null,
            result_id: null,
          };
  } else if (
    params.p_hold_reason !== null ||
    (params.p_receipt.ticket !== null &&
      params.p_receipt.billingDisposition === "not_chargeable" &&
      params.p_output !== null &&
      params.p_output.resultKind === "scored")
  ) {
    // A receipt that says "nothing to charge" beside an output that claims a
    // scored rating is contradictory evidence: the migration HOLDs it.
    row = {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason ?? "evidence_ambiguous",
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "reserved",
      result_id: null,
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  } else if (
    params.p_defer_new === true &&
    params.p_receipt.billingDisposition === "joint_verification_required"
  ) {
    // A genuinely new chargeable receipt under a reversible deny-new freeze:
    // nothing durable, the ticket stays reserved, the redelivery decides.
    row = {
      result: "accepted",
      delivery: "pending",
      status: "pending",
      reason_code: null,
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "reserved",
      result_id: null,
    };
  } else if (
    params.p_receipt.ticket !== null &&
    params.p_output !== null &&
    typeof params.p_output.sessionId === "string" &&
    !syncedSessions.has(params.p_output.sessionId)
  ) {
    // consume_offline_ticket() = shot.session_not_found: a transient
    // condition, answered without a durable verdict so the redelivery decides.
    row = {
      result: "accepted",
      delivery: "pending",
      status: "pending",
      reason_code: null,
      financial_disposition: "reserved",
      result_id: null,
    };
  } else {
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition:
        params.p_receipt.ticket === null
          ? "not_applicable"
          : params.p_receipt.billingDisposition === "joint_verification_required"
            ? "consumed"
            : "reserved",
      result_id: String(params.p_receipt.resultId),
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  }
  return new Response(JSON.stringify([row]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function reset(): void {
  h.reset();
  durable.clear();
  syncedSessions.clear();
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** One `receipts[]` entry of the 1.0 wire contract. */
interface RouteReceipt {
  receiptId: string;
  status: string;
  reasonCode: string | null;
  financialDisposition: string;
  resultId: string | null;
  delivery: "settled" | "replayed" | "held" | "pending";
}

/** One `rejected[]` entry of the 1.0 wire contract. */
interface RouteRejection {
  receiptId: string;
  code: string;
  message: string;
}

interface WireAnswer {
  receipts: RouteReceipt[];
  rejected: RouteRejection[];
}

const RECEIPT_KEYS = [
  "receiptId",
  "status",
  "reasonCode",
  "financialDisposition",
  "resultId",
  "delivery",
];
const REJECTION_KEYS = ["receiptId", "code", "message"];

/** The 200 body, checked key for key against the wire contract. */
function wire(body: Record<string, unknown>): WireAnswer {
  assertEquals(Object.keys(body).sort(), ["receipts", "rejected"], JSON.stringify(body));
  assert(Array.isArray(body.receipts) && Array.isArray(body.rejected), JSON.stringify(body));
  for (const entry of body.receipts) {
    assertEquals(Object.keys(entry).sort(), [...RECEIPT_KEYS].sort(), JSON.stringify(entry));
    assert(typeof entry.receiptId === "string" && entry.receiptId.length > 0);
    assert(typeof entry.status === "string" && entry.status.length > 0);
  }
  for (const entry of body.rejected) {
    assertEquals(Object.keys(entry).sort(), [...REJECTION_KEYS].sort(), JSON.stringify(entry));
    assert(typeof entry.receiptId === "string" && entry.receiptId.length > 0);
    assert(typeof entry.code === "string" && entry.code.length > 0);
  }
  return body as unknown as WireAnswer;
}

/** One entry per submitted receipt, the accepted ones first (in submission
 * order) then the rejected ones (in submission order): the wire answer folded
 * into the per-entry view the assertions below read. */
interface RouteResult {
  receiptId: string;
  delivery: RouteReceipt["delivery"] | "rejected";
  reconciliation: RouteReceipt | null;
  error: { code: string; message: string } | null;
}

function fold(body: Record<string, unknown>): RouteResult[] {
  const answer = wire(body);
  return [
    ...answer.receipts.map((entry) => ({
      receiptId: entry.receiptId,
      delivery: entry.delivery,
      reconciliation: entry,
      error: null,
    })),
    ...answer.rejected.map((entry) => ({
      receiptId: entry.receiptId,
      delivery: "rejected" as const,
      reconciliation: null,
      error: { code: entry.code, message: entry.message },
    })),
  ];
}

async function results(response: Response): Promise<RouteResult[]> {
  const body = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(body));
  return fold(body);
}

/** The verdict apps/mobile/src/data/api.ts OFFLINE_RECEIPT_STATUS_VERDICTS
 * gives each status the route may answer. */
const MOBILE_STATUS_VERDICTS = new Map<string, "accepted" | "refused" | "held">([
  ["result_recorded", "accepted"],
  ["unused_ticket_returned", "refused"],
  ["pending", "held"],
  ["reconciliation_required", "held"],
  ["support_review_required", "held"],
]);

interface MobileVerdict {
  receiptId: string;
  verdict: "accepted" | "refused" | "held";
  code: string;
}

/** A faithful mirror of apps/mobile/src/data/api.ts parseOfflineReceiptVerdicts():
 * what the shipping app makes of the route's answer for the ids it submitted.
 * null is the app's `unreadableAnswer()` — the drain fails and every receipt
 * stays queued. */
function mobileVerdicts(value: unknown, submittedIds: readonly string[]): MobileVerdict[] | null {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!isObject(value)) return null;
  const receipts = value.receipts;
  const rejected = value.rejected ?? [];
  if (!Array.isArray(receipts) || !Array.isArray(rejected)) return null;
  const verdicts = new Map<string, MobileVerdict>();
  const record = (verdict: MobileVerdict): boolean => {
    if (verdicts.has(verdict.receiptId)) return false;
    verdicts.set(verdict.receiptId, verdict);
    return true;
  };
  for (const entry of receipts) {
    if (!isObject(entry)) return null;
    const { receiptId, status } = entry;
    if (!isText(receiptId) || !isText(status)) return null;
    const verdict = MOBILE_STATUS_VERDICTS.get(status);
    if (verdict === undefined) return null;
    if (!record({ receiptId, verdict, code: status })) return null;
  }
  for (const entry of rejected) {
    if (!isObject(entry)) return null;
    const { receiptId, code } = entry;
    if (!isText(receiptId) || !isText(code)) return null;
    if (!record({ receiptId, verdict: "refused", code })) return null;
  }
  if (verdicts.size !== submittedIds.length) return null;
  const ordered: MobileVerdict[] = [];
  for (const id of submittedIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) return null;
    ordered.push(verdict);
  }
  return ordered;
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

const callerBearer = (sub: string): string => `Bearer session-for-${sub}`;

// ---------------------------------------------------------------------------
// Edge route
// ---------------------------------------------------------------------------

Deno.test(
  "POST /v1/offline/receipts settles a batch out of order, binding each receipt to grant/ticket/operation/result/digest, as the caller",
  async () => {
    reset();
    const user = freshUser();
    const first = await settledFixture(user.sub, TICKET_A, 1);
    const second = await settledFixture(user.sub, TICKET_B, 2, { claims: first.claims });
    const entries = [
      { receipt: second.receipt, grant: second.grant, output: second.output },
      { receipt: first.receipt, grant: first.grant, output: first.output },
    ];
    const grantSha256 = await digestOfflineGrantTransport(first.grant);
    assertMatch(grantSha256, SHA256_RE);

    const out = await results(await post({ receipts: entries }, user.token));
    assertEquals(out.length, 2);
    assertEquals(
      out.map((r) => [r.receiptId, r.delivery, r.error]),
      [
        ["receipt-2", "settled", null],
        ["receipt-1", "settled", null],
      ],
    );
    assertEquals(out[1].reconciliation, {
      receiptId: "receipt-1",
      status: "result_recorded",
      reasonCode: null,
      financialDisposition: "consumed",
      resultId: first.receipt.resultId,
      delivery: "settled",
    });

    const calls = h.callsTo(SETTLE_RPC);
    assertEquals(calls.length, 2);
    for (const call of calls) assertEquals(call.headers.authorization, callerBearer(user.sub));
    const params = calls.map(settleParams);
    assertEquals(params[0].p_receipt.receiptId, "receipt-2");
    assertEquals(params[1].p_receipt.receiptId, "receipt-1");
    // No freeze on the active release: nothing is deferred.
    assertEquals(
      params.map((p) => p.p_defer_new),
      [false, false],
    );
    // Every identity the settlement rests on travels to the durable RPC exactly
    // as the device signed it — nothing re-derived, nothing dropped.
    assertEquals(params[1].p_receipt, { ...first.receipt });
    assertEquals(params[1].p_receipt.grantJwsSha256, grantSha256);
    assertEquals(params[1].p_receipt.ticket, {
      allocationId: GRANT_ID,
      generation: 3,
      ticketId: TICKET_A,
    });
    assertEquals(params[1].p_receipt.operationId, "operation-1");
    assertEquals(params[1].p_receipt.resultId, first.receipt.resultId);
    assertEquals(params[1].p_receipt.fullOutputSha256, first.receipt.fullOutputSha256);
    assertEquals(params[1].p_receipt_sha256, await digestCanonicalOfflineJson(first.receipt));
    assertEquals(params[1].p_output, first.output);
    assertEquals(params[1].p_hold_reason, null);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

Deno.test(
  "a duplicate batch (and a duplicate inside a batch) replays the durable verdict — the receipt settles once",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };

    const first = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(first[0].delivery, "settled");

    const again = await results(await post({ receipts: [entry, entry] }, user.token));
    assertEquals(
      again.map((r) => r.delivery),
      ["replayed", "replayed"],
    );
    const replayed = { ...first[0].reconciliation, delivery: "replayed" };
    assertEquals(again[0].reconciliation, replayed);
    assertEquals(again[1].reconciliation, replayed);
    assertEquals(again[0].error, null);

    // Three deliveries, three durable RPC calls with the SAME identity — the
    // RPC (not the edge) is the idempotency point, and it settled exactly once.
    const params = settleCalls();
    assertEquals(params.length, 3);
    assertEquals(new Set(params.map((p) => p.p_receipt_sha256)).size, 1);
    assertEquals(durable.size, 1);
    assertEquals([...durable.values()][0].row.delivery, "settled");
  },
);

Deno.test(
  "a receipt whose grant was signed by an unknown key is HELD as evidence_ambiguous with its ticket reserved — never refunded, never re-run",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1, { key: foreignSigningKey });

    const out = await results(
      await post(
        { receipts: [{ receipt: fixture.receipt, grant: fixture.grant, output: fixture.output }] },
        user.token,
      ),
    );
    assertEquals(out[0].delivery, "held");
    assertEquals(out[0].error, null);
    assertEquals(out[0].reconciliation, {
      receiptId: "receipt-1",
      status: "reconciliation_required",
      reasonCode: "evidence_ambiguous",
      financialDisposition: "reserved",
      resultId: null,
      delivery: "held",
    });

    const params = settleCalls();
    assertEquals(params.length, 1);
    assertEquals(params[0].p_hold_reason, "evidence_ambiguous");
    assertEquals(params[0].p_receipt.operationId, "operation-1");
    assertEquals(params[0].p_receipt.ticket, ticketRef(TICKET_A, fixture.claims));
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);

    // Delivering the held receipt again replays the HOLD: same operation id,
    // same reserved ticket, still no refund.
    const again = await results(
      await post(
        { receipts: [{ receipt: fixture.receipt, grant: fixture.grant, output: fixture.output }] },
        user.token,
      ),
    );
    assertEquals(again[0].delivery, "replayed");
    assertEquals(again[0].reconciliation, { ...out[0].reconciliation, delivery: "replayed" });
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

Deno.test(
  "unverifiable or inconsistent evidence is HELD with the matching reason, each receipt independently, inside one batch",
  async () => {
    reset();
    const user = freshUser();
    const other = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const good = await settledFixture(user.sub, TICKET_A, 1, { claims });

    // (a) owner mismatch: the receipt and grant name another account.
    const foreign = await settledFixture(other.sub, TICKET_A, 2);
    // (b) the output the device delivered does not hash to the receipt's digest.
    const tampered = {
      ...good,
      receipt: await receipt({
        receiptId: "receipt-3",
        ownerId: user.sub,
        grant,
        claims,
        ticket: ticketRef(TICKET_B, claims),
        lifecycleSequence: 3,
        operationId: "operation-3",
        resultId: good.receipt.resultId,
        fullOutputSha256: "a".repeat(64),
      }),
    };
    // (c) a chargeable receipt with no output at all.
    const missing = await receipt({
      receiptId: "receipt-4",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 4,
      operationId: "operation-4",
      resultId: "70000004-0404-4000-8000-000000000004",
      fullOutputSha256: "b".repeat(64),
    });
    // (d) the receipt names a grant digest other than the grant delivered.
    const rebound = await receipt({
      receiptId: "receipt-5",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 5,
      operationId: "operation-5",
      resultId: good.receipt.resultId,
      fullOutputSha256: good.receipt.fullOutputSha256,
      grantJwsSha256: "d".repeat(64),
    });
    // (e) a ticket the grant never allocated.
    const strayTicket = await receipt({
      receiptId: "receipt-6",
      ownerId: user.sub,
      grant,
      claims,
      ticket: {
        allocationId: GRANT_ID,
        generation: 3,
        ticketId: "65555555-5555-4555-8555-555555555559",
      },
      lifecycleSequence: 6,
      operationId: "operation-6",
      resultId: good.receipt.resultId,
      fullOutputSha256: good.receipt.fullOutputSha256,
    });

    const out = await results(
      await post(
        {
          receipts: [
            { receipt: foreign.receipt, grant: foreign.grant, output: foreign.output },
            { receipt: tampered.receipt, grant, output: good.output },
            { receipt: missing, grant, output: null },
            { receipt: rebound, grant, output: good.output },
            { receipt: strayTicket, grant, output: good.output },
            { receipt: good.receipt, grant, output: good.output },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.receiptId, r.delivery, r.reconciliation?.reasonCode ?? null]),
      [
        ["receipt-2", "held", "owner_mismatch"],
        ["receipt-3", "held", "evidence_ambiguous"],
        ["receipt-4", "held", "evidence_missing"],
        ["receipt-5", "held", "evidence_ambiguous"],
        ["receipt-6", "held", "evidence_ambiguous"],
        ["receipt-1", "settled", null],
      ],
    );
    for (const held of out.slice(0, 5)) {
      assertEquals(held.reconciliation?.status, "reconciliation_required");
      assertEquals(held.reconciliation?.financialDisposition, "reserved");
    }
    const params = settleCalls();
    assertEquals(
      params.map((p) => p.p_hold_reason),
      [
        "owner_mismatch",
        "evidence_ambiguous",
        "evidence_missing",
        "evidence_ambiguous",
        "evidence_ambiguous",
        null,
      ],
    );
    // A held receipt still travels with its full identity so the hold is bound.
    assertEquals(params[0].p_receipt.ownerId, other.sub);
    assertEquals(params[2].p_output, null);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

Deno.test(
  "a Pro (no-ticket) receipt records its result with no financial disposition; a not_chargeable receipt never consumes",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const proOutput = output("70000009-0404-4000-8000-000000000009");
    const pro = await receipt({
      receiptId: "receipt-pro",
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: 1,
      operationId: "operation-pro",
      resultId: "70000009-0404-4000-8000-000000000009",
      fullOutputSha256: await digestCanonicalOfflineJson(proOutput),
    });
    const freeClaimsForUser = freeClaims(user.sub, {
      grantId: "64444444-4444-4444-8444-444444444445",
    });
    const freeGrant = await sign(freeClaimsForUser);
    const abstention = output("70000008-0404-4000-8000-000000000008", {
      resultKind: "low_confidence",
      overallScore: null,
    });
    const notChargeable = await receipt({
      receiptId: "receipt-abstain",
      ownerId: user.sub,
      grant: freeGrant,
      claims: freeClaimsForUser,
      ticket: ticketRef(TICKET_A, freeClaimsForUser),
      lifecycleSequence: 1,
      operationId: "operation-abstain",
      resultId: "70000008-0404-4000-8000-000000000008",
      fullOutputSha256: await digestCanonicalOfflineJson(abstention),
      billingDisposition: "not_chargeable",
    });

    const out = await results(
      await post(
        {
          receipts: [
            { receipt: pro, grant, output: proOutput },
            { receipt: notChargeable, grant: freeGrant, output: abstention },
          ],
        },
        user.token,
      ),
    );
    assertEquals(out[0].delivery, "settled");
    assertEquals(out[0].reconciliation?.financialDisposition, "not_applicable");
    assertEquals(out[1].delivery, "settled");
    assertEquals(out[1].reconciliation?.financialDisposition, "reserved");
    const params = settleCalls();
    assertEquals(params.length, 2);
    assertEquals(params[0].p_receipt.ticket, null);
    assertEquals(params[1].p_receipt.billingDisposition, "not_chargeable");
    assertEquals(params[1].p_hold_reason, null);
  },
);

Deno.test(
  "malformed entries are rejected per receipt, by the receipt id they name, without reaching the database; an entry naming no receipt id, like a malformed batch, is 400",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const { queuedAt: _queuedAt, ...noQueuedAt } = fixture.receipt;

    const body = await readJson(
      await post(
        {
          receipts: [
            // the full-evidence result-receipt form is not the wire contract
            {
              receipt: fullEvidenceForm(fixture.receipt),
              grant: fixture.grant,
              output: fixture.output,
            },
            {
              receipt: { ...fixture.receipt, receiptId: "receipt-2" },
              grant: { compactJws: "not.a.jws" },
              output: fixture.output,
            },
            {
              receipt: { ...fixture.receipt, receiptId: "receipt-3" },
              grant: fixture.grant,
              output: "not-an-object",
            },
            { receipt: { ...noQueuedAt, receiptId: "receipt-4" }, grant: fixture.grant },
            {
              receipt: { ...fixture.receipt, receiptId: "receipt-5", ownerId: "not-a-uuid" },
              grant: fixture.grant,
              output: fixture.output,
            },
            {
              receipt: { ...fixture.receipt, receiptId: "receipt-6" },
              grant: fixture.grant,
              output: fixture.output,
            },
          ],
        },
        user.token,
      ),
    );
    const answer = wire(body);
    assertEquals(
      answer.rejected.map((r) => [r.receiptId, r.code]),
      [
        ["receipt-1", "offline.invalid_input"],
        ["receipt-2", "offline.invalid_input"],
        ["receipt-3", "offline.invalid_input"],
        ["receipt-4", "offline.invalid_input"],
        ["receipt-5", "offline.invalid_input"],
      ],
    );
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery]),
      [["receipt-6", "settled"]],
    );
    assertEquals(
      mobileVerdicts(body, [
        "receipt-1",
        "receipt-2",
        "receipt-3",
        "receipt-4",
        "receipt-5",
        "receipt-6",
      ])?.map((v) => v.verdict),
      ["refused", "refused", "refused", "refused", "refused", "accepted"],
    );
    assertEquals(settleCalls().length, 1);
    assertEquals(settleCalls()[0].p_receipt.receiptId, "receipt-6");

    // Without a receipt id there is nothing to answer for; the app could not
    // attribute the refusal, so the batch is refused as malformed instead.
    for (const bad of [
      {},
      { receipts: [] },
      { receipts: "x" },
      { receipts: new Array(26).fill(null) },
      { receipts: ["not-an-entry"] },
      { receipts: [{ grant: fixture.grant, output: fixture.output }] },
      {
        receipts: [
          { receipt: { ...fixture.receipt, receiptId: 42 }, grant: fixture.grant, output: null },
        ],
      },
      {
        receipts: [
          { receipt: { ...fixture.receipt, receiptId: "" }, grant: fixture.grant, output: null },
        ],
      },
      {
        receipts: [
          {
            receipt: { ...fixture.receipt, receiptId: "has spaces" },
            grant: fixture.grant,
            output: null,
          },
        ],
      },
    ]) {
      const response = await post(bad, user.token);
      assertEquals(response.status, 400, JSON.stringify(bad).slice(0, 80));
      assertEquals(
        ((await readJson(response)).error as { code?: string }).code,
        "offline.invalid_input",
      );
    }
    assertEquals(settleCalls().length, 1);
  },
);

// ---------------------------------------------------------------------------
// Round 6 — the 1.0 wire contract, end to end with the shipping app's shapes.
// ---------------------------------------------------------------------------

/** The exact OfflineReceiptSubmission apps/mobile/src/data/api.ts posts for a
 * queued receipt (offlineWallet.ts submission(): the persisted
 * OfflineConsumptionReceipt minus `settlement` and `settledAt`), key order
 * included. Built by hand, not from receipt(), so a drift in either fixture
 * shows up here. */
async function mobileSubmission(
  ownerId: string,
  grant: OfflineSignedExecutionGrant,
  claims: OfflineExecutionGrantClaims,
  ticketId: string,
  out: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    receiptId: "mobile-receipt-1",
    ownerId,
    installationKeyId: claims.installationKeyId,
    grantId: claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(grant),
    lifecycleSequence: 1,
    ticket: ticketRef(ticketId, claims),
    operationId: "mobile-operation-1",
    resultId: String(out.id),
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    billingDisposition: "joint_verification_required",
    queuedAt: "2026-09-08T12:00:00.000Z",
  };
}

Deno.test(
  "the exact mobile OfflineReceiptSubmission entry settles, travels to the RPC byte for byte, and the answer is what parseOfflineReceiptVerdicts reads — every submitted id exactly once",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const out = output("70000061-0404-4000-8000-000000000061");
    const submission = await mobileSubmission(user.sub, grant, claims, TICKET_A, out);
    assertEquals(Object.keys(submission), [
      "receiptId",
      "ownerId",
      "installationKeyId",
      "grantId",
      "grantJwsSha256",
      "lifecycleSequence",
      "ticket",
      "operationId",
      "resultId",
      "fullOutputSha256",
      "billingDisposition",
      "queuedAt",
    ]);
    const grantEnvelope = { schemaVersion: grant.schemaVersion, compactJws: grant.compactJws };

    const response = await post(
      { receipts: [{ receipt: submission, grant: grantEnvelope, output: out }] },
      user.token,
    );
    const body = await readJson(response);
    assertEquals(response.status, 200, JSON.stringify(body));
    const answer = wire(body);
    assertEquals(answer.rejected, []);
    assertEquals(answer.receipts, [
      {
        receiptId: "mobile-receipt-1",
        status: "result_recorded",
        reasonCode: null,
        financialDisposition: "consumed",
        resultId: "70000061-0404-4000-8000-000000000061",
        delivery: "settled",
      },
    ]);
    assertEquals(mobileVerdicts(body, ["mobile-receipt-1"]), [
      { receiptId: "mobile-receipt-1", verdict: "accepted", code: "result_recorded" },
    ]);

    // The RPC received the device receipt exactly as posted (that is what its
    // digest binds) and the freeze flag, false under an unfrozen release.
    const params = settleCalls();
    assertEquals(params.length, 1);
    assertEquals(params[0].p_receipt, submission);
    assertEquals(params[0].p_receipt_sha256, await digestCanonicalOfflineJson(submission));
    assertEquals(params[0].p_output, out);
    assertEquals(params[0].p_hold_reason, null);
    assertEquals(params[0].p_defer_new, false);

    // Redelivered together with a second, held receipt and a rejected one:
    // three ids in, three verdicts out, each named once, order-independent.
    const held = await receipt({
      receiptId: "mobile-receipt-2",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 2,
      operationId: "mobile-operation-2",
      resultId: "70000062-0404-4000-8000-000000000062",
      fullOutputSha256: "a".repeat(64),
    });
    const mixed = await readJson(
      await post(
        {
          receipts: [
            { receipt: held, grant: grantEnvelope, output: null },
            {
              receipt: { ...submission, receiptId: "mobile-receipt-3" },
              grant: { compactJws: "not.a.jws" },
              output: out,
            },
            { receipt: submission, grant: grantEnvelope, output: out },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      mobileVerdicts(mixed, ["mobile-receipt-2", "mobile-receipt-3", "mobile-receipt-1"]),
      [
        { receiptId: "mobile-receipt-2", verdict: "held", code: "reconciliation_required" },
        { receiptId: "mobile-receipt-3", verdict: "refused", code: "offline.invalid_input" },
        { receiptId: "mobile-receipt-1", verdict: "accepted", code: "result_recorded" },
      ],
    );
    const folded = fold(mixed);
    assertEquals(
      folded.map((r) => [r.receiptId, r.delivery, r.reconciliation?.reasonCode ?? null]),
      [
        ["mobile-receipt-2", "held", "evidence_missing"],
        ["mobile-receipt-1", "replayed", null],
        ["mobile-receipt-3", "rejected", null],
      ],
    );
    assertEquals(durable.size, 2);
  },
);

// ---------------------------------------------------------------------------
// Round 6 — a reversible deny-new freeze on the release (denyNewAuthorizations
// set, NOT withdrawn). The freeze may lift or become a withdrawal, so it decides
// nothing durable — but it must never mask what IS durable: the RPC looks the
// receipt up under the owner lock first (replay / HOLD replay / same-id conflict)
// and only a genuinely new chargeable receipt is answered pending. The edge
// passes the freeze as p_defer_new; it never answers pending on its own.
// ---------------------------------------------------------------------------

/** The active authority under a reversible freeze: deny_new_authorizations set,
 * withdrawnAt null. */
function frozenActiveRow(): Record<string, unknown> {
  const base = releasePolicyRow.approval as Record<string, unknown>;
  return {
    ...releasePolicyRow,
    denyNewAuthorizations: true,
    approval: { ...base, withdrawnAt: null, denyNewAuthorizations: true },
  };
}

Deno.test(
  "under a reversible deny-new freeze the durable verdict wins: a settled receipt replays consumed, a held receipt replays its hold, a same-id/other-digest receipt is offline.receipt_conflict — and only a genuinely new chargeable receipt is pending, decided by the RPC with p_defer_new, nothing durable written",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const settled = await settledFixture(user.sub, TICKET_A, 1, { claims });
    const heldRec = await receipt({
      receiptId: "receipt-held",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 2,
      operationId: "operation-held",
      resultId: "70000071-0404-4000-8000-000000000071",
      fullOutputSha256: "a".repeat(64),
    });
    const settledEntry = { receipt: settled.receipt, grant, output: settled.output };
    const heldEntry = { receipt: heldRec, grant, output: null };

    // Before the freeze: one consumed, one durable HOLD (evidence_missing).
    const before = await results(await post({ receipts: [settledEntry, heldEntry] }, user.token));
    assertEquals(
      before.map((r) => [r.receiptId, r.delivery, r.reconciliation?.financialDisposition]),
      [
        ["receipt-1", "settled", "consumed"],
        ["receipt-held", "held", "reserved"],
      ],
    );
    assertEquals(durable.size, 2);
    assertEquals(
      settleCalls().map((p) => p.p_defer_new),
      [false, false],
    );

    // The operator freezes (does not withdraw) the active release.
    h.rpcs.read_analysis_release_policy = frozenActiveRow();
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: frozenActiveRow() });
    const forged = {
      receipt: {
        ...settled.receipt,
        resultId: "70000072-0404-4000-8000-000000000072",
        fullOutputSha256: await digestCanonicalOfflineJson(
          output("70000072-0404-4000-8000-000000000072"),
        ),
      },
      grant,
      output: output("70000072-0404-4000-8000-000000000072"),
    };
    const fresh = await settledFixture(user.sub, TICKET_B, 3, { claims });
    const abstention = output("70000073-0404-4000-8000-000000000073", {
      resultKind: "low_confidence",
      overallScore: null,
    });
    const notChargeable = await receipt({
      receiptId: "receipt-abstain",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 4,
      operationId: "operation-abstain",
      resultId: "70000073-0404-4000-8000-000000000073",
      fullOutputSha256: await digestCanonicalOfflineJson(abstention),
      billingDisposition: "not_chargeable",
    });
    const unverifiable = await settledFixture(user.sub, TICKET_B, 5, { key: foreignSigningKey });

    const body = await readJson(
      await post(
        {
          receipts: [
            settledEntry,
            heldEntry,
            forged,
            { receipt: fresh.receipt, grant, output: fresh.output },
            { receipt: notChargeable, grant, output: abstention },
            {
              receipt: unverifiable.receipt,
              grant: unverifiable.grant,
              output: unverifiable.output,
            },
          ],
        },
        user.token,
      ),
    );
    const out = fold(body);
    assertEquals(
      out.map((r) => [
        r.receiptId,
        r.delivery,
        r.reconciliation?.status ?? r.error?.code,
        r.reconciliation?.reasonCode ?? null,
        r.reconciliation?.financialDisposition ?? null,
      ]),
      [
        ["receipt-1", "replayed", "result_recorded", null, "consumed"],
        ["receipt-held", "replayed", "reconciliation_required", "evidence_missing", "reserved"],
        ["receipt-3", "pending", "pending", null, "reserved"],
        ["receipt-abstain", "settled", "result_recorded", null, "reserved"],
        ["receipt-5", "held", "reconciliation_required", "evidence_ambiguous", "reserved"],
        ["receipt-1", "rejected", "offline.receipt_conflict", null, null],
      ],
    );
    assertEquals(
      mobileVerdicts(body, [
        "receipt-1",
        "receipt-held",
        "receipt-1",
        "receipt-3",
        "receipt-abstain",
        "receipt-5",
      ]),
      null,
      "fixture: the same id twice in one batch is not something the app ever posts",
    );

    // Every entry reached the RPC — the edge decided nothing on its own — and
    // the freeze travelled with it exactly where it applies: a receipt with
    // complete, bound evidence (the RPC decides replay/conflict before it).
    const frozenCalls = settleCalls().slice(2);
    assertEquals(
      frozenCalls.map((p) => [p.p_receipt.receiptId, p.p_hold_reason, p.p_defer_new]),
      [
        ["receipt-1", null, true],
        ["receipt-held", "evidence_missing", false],
        ["receipt-1", null, true],
        ["receipt-3", null, true],
        ["receipt-abstain", null, true],
        ["receipt-5", "evidence_ambiguous", false],
      ],
    );
    // Durable: the two from before plus the recorded abstention and the
    // unverifiable HOLD; the pending chargeable receipt wrote nothing.
    assertEquals(durable.size, 4);
    assert(!durable.has(`${callerBearer(user.sub)}|receipt-3`));
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);

    // The freeze lifts: the identical redelivery of the pending receipt
    // settles, exactly once, under the same operation.
    h.rpcs.read_analysis_release_policy = releasePolicyRow;
    h.respond = durableRespond;
    const lifted = await results(
      await post(
        { receipts: [{ receipt: fresh.receipt, grant, output: fresh.output }] },
        user.token,
      ),
    );
    assertEquals(lifted[0].delivery, "settled");
    assertEquals(lifted[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(settleCalls().at(-1)?.p_defer_new, false);
    assertEquals(durable.size, 5);
  },
);

Deno.test(
  "a chargeable Pro (no-ticket) receipt under a reversible freeze is pending with financialDisposition not_applicable; a not_chargeable one is recorded",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    h.rpcs.read_analysis_release_policy = frozenActiveRow();
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: frozenActiveRow() });
    const scored = output("70000081-0404-4000-8000-000000000081");
    const chargeable = await receipt({
      receiptId: "receipt-pro-frozen",
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: 1,
      operationId: "operation-pro-frozen",
      resultId: "70000081-0404-4000-8000-000000000081",
      fullOutputSha256: await digestCanonicalOfflineJson(scored),
    });
    const abstention = output("70000082-0404-4000-8000-000000000082", {
      resultKind: "low_confidence",
      overallScore: null,
    });
    const notChargeable = await receipt({
      receiptId: "receipt-pro-abstain",
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: 2,
      operationId: "operation-pro-abstain",
      resultId: "70000082-0404-4000-8000-000000000082",
      fullOutputSha256: await digestCanonicalOfflineJson(abstention),
      billingDisposition: "not_chargeable",
    });
    const out = await results(
      await post(
        {
          receipts: [
            { receipt: chargeable, grant, output: scored },
            { receipt: notChargeable, grant, output: abstention },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.receiptId, r.delivery, r.reconciliation?.financialDisposition]),
      [
        ["receipt-pro-frozen", "pending", "not_applicable"],
        ["receipt-pro-abstain", "settled", "not_applicable"],
      ],
    );
    assertEquals(
      settleCalls().map((p) => p.p_defer_new),
      [true, true],
    );
    assertEquals(durable.size, 1);
  },
);

Deno.test("the route requires an authenticated caller and a live session", async () => {
  reset();
  const fixture = await settledFixture("aaaaaaaa-0404-4000-8000-999999999999", TICKET_A, 1);
  const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };
  const anonymous = await h.handler(
    new Request(`http://edge.test/functions/v1/api${RECEIPTS_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receipts: [entry] }),
    }),
  );
  assertEquals(anonymous.status, 401);

  h.rpcs.is_api_session_active = false;
  const user = freshUser();
  const stale = await post({ receipts: [entry] }, user.token);
  assertEquals(stale.status, 401);
  assertEquals(settleCalls().length, 0);
});

Deno.test(
  "a durable RPC failure is a generic 503 for that batch — the receipt is neither settled nor refunded",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    h.respond = () => null;
    h.rpcErrors.settle_offline_receipt = 500;
    const { result: response, logs } = await captureConsole(() =>
      post(
        { receipts: [{ receipt: fixture.receipt, grant: fixture.grant, output: fixture.output }] },
        user.token,
      ),
    );
    assertEquals(response.status, 503);
    const body = await readJson(response);
    const message = (body.error as { message: string }).message;
    assert(!message.includes("XX000") && !message.includes("injected"), message);
    assert(
      logs.some(
        (entry) =>
          entry.level === "error" &&
          typeof entry.args[0] === "string" &&
          entry.args[0].includes("[api]"),
      ),
      "failure detail belongs in the logs",
    );
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

Deno.test(
  "the route has its own per-user budget: the 26th delivery in a minute is 429",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };
    let limited: Response | null = null;
    for (let i = 0; i < 30; i += 1) {
      const response = await post({ receipts: [entry] }, user.token);
      if (response.status === 429) {
        limited = response;
        break;
      }
      assertEquals(response.status, 200);
      await response.body?.cancel();
    }
    assert(limited, "expected a 429 within 30 deliveries");
    assert(limited.headers.get("Retry-After"));
    await limited.body?.cancel();
  },
);

// ---------------------------------------------------------------------------
// Round 2 — release-authority rotation between offline execution and delayed
// delivery. The delayed receipt is judged against the release the grant was
// issued under (as the route already does for time via the grant's own
// expiry), read from the authority by its sha as the SERVICE ROLE — the
// signed grant only names which installed lineage to look up, it never
// supplies it.
// ---------------------------------------------------------------------------

Deno.test(
  "a receipt for a grant issued under the previous, still approved release settles after the authority rotates — the prior lineage is read once per batch as the service role, never from the token",
  async () => {
    reset();
    const user = freshUser();
    const executedUnderV1 = await settledFixture(user.sub, TICKET_A, 1);
    const alsoUnderV1 = await settledFixture(user.sub, TICKET_B, 2, {
      claims: executedUnderV1.claims,
    });
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow });

    const out = await results(
      await post(
        {
          receipts: [
            {
              receipt: alsoUnderV1.receipt,
              grant: alsoUnderV1.grant,
              output: alsoUnderV1.output,
            },
            {
              receipt: executedUnderV1.receipt,
              grant: executedUnderV1.grant,
              output: executedUnderV1.output,
            },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.receiptId, r.delivery, r.error]),
      [
        ["receipt-2", "settled", null],
        ["receipt-1", "settled", null],
      ],
    );
    const params = settleCalls();
    assertEquals(params.length, 2);
    assertEquals(
      params.map((p) => p.p_hold_reason),
      [null, null],
    );

    const lineage = h.callsTo(LINEAGE_RPC);
    assertEquals(lineage.length, 1, "one lineage read per distinct release per batch");
    assertEquals(lineage[0].headers.authorization, SERVICE_BEARER);
    assertEquals(lineageParams(lineage[0]), { p_policy_sha256: RELEASE.policy.sha256 });

    // A grant under the NOW-active release still verifies without a lineage read.
    reset();
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    h.respond = lineageRespond({});
    const rotated = h.rpcs.read_analysis_release_policy as {
      approval: { policy: { version: string; sha256: string } };
    };
    const v2: OfflineReleasedArtifacts = {
      policy: rotated.approval.policy,
      mechanicsModel: { version: "harness-2", sha256: "d".repeat(64) },
      benchmarkModel: { version: "harness-2", sha256: "d".repeat(64) },
    };
    const claimsV2 = offlineGrantClaimsFromIssuance(
      {
        result: "accepted",
        grant_id: GRANT_ID,
        generation: 3,
        entitlement_source: "identity_lifetime_free",
        issued_at: iso(nowSeconds() - 60),
        expires_at: iso(nowSeconds() - 60 + 7 * DAY),
        entitlement_expires_at: null,
        ticket_ids: [TICKET_A, TICKET_B],
      },
      { issuer: ISSUER, ownerId: user.sub, installationKeyId: INSTALLATION_KEY, release: v2 },
    );
    const grantV2 = await signOfflineExecutionGrant(claimsV2, signingKey, {
      binding: {
        issuer: ISSUER,
        allowedKeyIds: [KID],
        ownerId: user.sub,
        installationKeyId: INSTALLATION_KEY,
      },
      release: v2,
      nowEpochSeconds: claimsV2.iat + 1,
    });
    const resultId = crypto.randomUUID();
    const outV2 = output(resultId);
    const recV2 = await receipt({
      receiptId: "receipt-v2",
      ownerId: user.sub,
      grant: grantV2,
      claims: claimsV2,
      ticket: ticketRef(TICKET_A, claimsV2),
      lifecycleSequence: 1,
      operationId: "operation-v2",
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(outV2),
    });
    const current = await results(
      await post({ receipts: [{ receipt: recV2, grant: grantV2, output: outV2 }] }, user.token),
    );
    assertEquals(current[0].delivery, "settled");
    assertEquals(h.callsTo(LINEAGE_RPC).length, 0);
  },
);

Deno.test(
  "a grant whose release lineage was withdrawn is HELD as grant_revoked, an unknown lineage is HELD as evidence_ambiguous, a lineage read failure is a 503 that decides nothing",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();

    const withdrawnAt = nowSeconds() - 30;
    const withdrawnRow = {
      ...releasePolicyRow,
      approval: {
        ...(releasePolicyRow.approval as Record<string, unknown>),
        withdrawnAt,
      },
    };
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: withdrawnRow });
    const withdrawn = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(withdrawn[0].delivery, "held");
    assertEquals(withdrawn[0].reconciliation, {
      receiptId: "receipt-1",
      status: "reconciliation_required",
      reasonCode: "grant_revoked",
      financialDisposition: "reserved",
      resultId: null,
      delivery: "held",
    });
    assertEquals(settleCalls()[0].p_hold_reason, "grant_revoked");

    reset();
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    h.respond = lineageRespond({});
    const unknown = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(unknown[0].delivery, "held");
    assertEquals(unknown[0].reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(unknown[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(settleCalls()[0].p_hold_reason, "evidence_ambiguous");

    reset();
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    h.rpcErrors.read_analysis_release_policy_lineage = 500;
    const { result: failed } = await captureConsole(() => post({ receipts: [entry] }, user.token));
    assertEquals(failed.status, 503);
    await failed.body?.cancel();
    assertEquals(settleCalls().length, 0);
    assertEquals(durable.size, 0);
  },
);

// ---------------------------------------------------------------------------
// Round 2 — a receipt that arrives before the session it names has synced is
// a transient condition, not evidence against the receipt: the RPC answers
// `pending` with nothing durable and the ticket still reserved; the very same
// receipt (same identity, same operation) settles once the session exists.
// ---------------------------------------------------------------------------

Deno.test(
  "a receipt delivered before its session syncs is answered pending (reserved, not durable) and the identical redelivery settles once the session exists",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const sessionId = crypto.randomUUID();
    const resultId = crypto.randomUUID();
    const out = output(resultId, { sessionId });
    const rec = await receipt({
      receiptId: "receipt-early",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_A, claims),
      lifecycleSequence: 1,
      operationId: "operation-early",
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(out),
    });
    const entry = { receipt: rec, grant, output: out };

    const early = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(early[0].delivery, "pending");
    assertEquals(early[0].error, null);
    assertEquals(early[0].reconciliation, {
      receiptId: "receipt-early",
      status: "pending",
      reasonCode: null,
      financialDisposition: "reserved",
      resultId: null,
      delivery: "pending",
    });
    assertEquals(durable.size, 0);

    const stillEarly = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(stillEarly[0].delivery, "pending");

    syncedSessions.add(sessionId);
    const late = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(late[0].delivery, "settled");
    assertEquals(late[0].reconciliation?.status, "result_recorded");
    assertEquals(late[0].reconciliation?.financialDisposition, "consumed");
    const params = settleCalls();
    assertEquals(params.length, 3);
    assertEquals(new Set(params.map((p) => p.p_receipt_sha256)).size, 1);
    assertEquals(new Set(params.map((p) => p.p_receipt.operationId)).size, 1);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

// ---------------------------------------------------------------------------
// Round 3 — the release authority is judged PER RECEIPT, never for the batch.
// A delayed receipt is evidence about work already done under the grant it
// names; whether the CURRENTLY active release is chargeable right now decides
// nothing about it. Withdrawing the active release must therefore not turn
// the batch away: an already-settled receipt replays its verdict, a grant
// issued under another (still approved) lineage is judged against THAT
// lineage, a grant under the withdrawn lineage is a grant_revoked HOLD for
// chargeable work, and an abstention (nothing to charge) is still recorded.
// ---------------------------------------------------------------------------

/** The active authority WITHDRAWN with no successor: what
 * read_analysis_release_policy() answers once the operator pulls the release. */
function withdrawnActiveRow(): Record<string, unknown> {
  const base = releasePolicyRow.approval as Record<string, unknown>;
  return {
    ...releasePolicyRow,
    denyNewAuthorizations: true,
    approval: { ...base, withdrawnAt: nowSeconds() - 30, denyNewAuthorizations: true },
  };
}

Deno.test(
  "withdrawing the ACTIVE release does not refuse the batch: an already-consumed receipt still replays its durable verdict",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };
    const first = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(first[0].delivery, "settled");
    assertEquals(first[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(durable.size, 1);

    // The operator withdraws the active release; the device redelivers the
    // very same batch (its outbox never got the first answer).
    h.rpcs.read_analysis_release_policy = withdrawnActiveRow();
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: withdrawnActiveRow() });
    const redelivered = await post({ receipts: [entry] }, user.token);
    const body = await readJson(redelivered);
    assertEquals(
      redelivered.status,
      200,
      `a consumed receipt must replay its verdict, got ${redelivered.status} ${JSON.stringify(body)}`,
    );
    const out = fold(body);
    assertEquals(out[0].delivery, "replayed");
    assertEquals(out[0].reconciliation?.status, "result_recorded");
    assertEquals(out[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(durable.size, 1);
  },
);

Deno.test(
  "withdrawing the ACTIVE release does not block a receipt whose grant names a different, still-approved lineage: it settles against that lineage",
  async () => {
    reset();
    const user = freshUser();
    // Grant issued under the FIRST policy (RELEASE); by the time the receipt
    // arrives a second policy was active and then withdrawn. The first
    // lineage is still installed and approved.
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const rotated = await rotatedReleasePolicyRow();
    const rotatedApproval = rotated.approval as Record<string, unknown>;
    h.rpcs.read_analysis_release_policy = {
      ...rotated,
      denyNewAuthorizations: true,
      approval: { ...rotatedApproval, withdrawnAt: nowSeconds() - 30, denyNewAuthorizations: true },
    };
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow });
    const response = await post(
      { receipts: [{ receipt: fixture.receipt, grant: fixture.grant, output: fixture.output }] },
      user.token,
    );
    const body = await readJson(response);
    assertEquals(
      response.status,
      200,
      `expected a per-receipt verdict from the named lineage, got ${response.status} ${JSON.stringify(body)}`,
    );
    const out = fold(body);
    assertEquals(out[0].delivery, "settled");
    assertEquals(out[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(h.callsTo(LINEAGE_RPC).length, 1);
    assertEquals(lineageParams(h.callsTo(LINEAGE_RPC)[0]).p_policy_sha256, RELEASE.policy.sha256);
  },
);

Deno.test(
  "with the ACTIVE release withdrawn, a not_chargeable abstention under it is recorded (nothing to charge) and a chargeable receipt under it is a grant_revoked HOLD — neither is a 409",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const abstention = output("70000031-0404-4000-8000-000000000031", {
      resultKind: "low_confidence",
      overallScore: null,
    });
    const notChargeable = await receipt({
      receiptId: "receipt-abstain-withdrawn",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_A, claims),
      lifecycleSequence: 1,
      operationId: "operation-abstain-withdrawn",
      resultId: "70000031-0404-4000-8000-000000000031",
      fullOutputSha256: await digestCanonicalOfflineJson(abstention),
      billingDisposition: "not_chargeable",
    });
    const scored = output("70000032-0404-4000-8000-000000000032");
    const chargeable = await receipt({
      receiptId: "receipt-scored-withdrawn",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_B, claims),
      lifecycleSequence: 2,
      operationId: "operation-scored-withdrawn",
      resultId: "70000032-0404-4000-8000-000000000032",
      fullOutputSha256: await digestCanonicalOfflineJson(scored),
    });
    h.rpcs.read_analysis_release_policy = withdrawnActiveRow();
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: withdrawnActiveRow() });
    const response = await post(
      {
        receipts: [
          { receipt: notChargeable, grant, output: abstention },
          { receipt: chargeable, grant, output: scored },
        ],
      },
      user.token,
    );
    const body = await readJson(response);
    assertEquals(
      response.status,
      200,
      `an abstention has nothing to charge and must be recorded, got ${response.status} ${JSON.stringify(body)}`,
    );
    const out = fold(body);
    assertEquals(out[0].delivery, "settled");
    assertEquals(out[0].reconciliation?.status, "result_recorded");
    assertEquals(out[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(out[1].delivery, "held");
    assertEquals(out[1].reconciliation?.reasonCode, "grant_revoked");
    assertEquals(out[1].reconciliation?.financialDisposition, "reserved");
    const params = settleCalls();
    assertEquals(params.length, 2);
    assertEquals(params[0].p_hold_reason, null);
    assertEquals(params[1].p_hold_reason, "grant_revoked");
  },
);

Deno.test(
  "a lineage row that fails integrity verification is a server fault: 503, nothing settled, no durable hold — the identical receipt settles once the row is repaired",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    const corrupt = {
      ...releasePolicyRow,
      canonicalDocument: `${String(releasePolicyRow.canonicalDocument)} `,
    };
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: corrupt });
    const { result: failed } = await captureConsole(() => post({ receipts: [entry] }, user.token));
    const failedBody = await readJson(failed);
    assertEquals(failed.status, 503, JSON.stringify(failedBody));
    assertEquals(settleCalls().length, 0);
    assertEquals(durable.size, 0);

    // Operator repairs the row; the identical redelivery settles.
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow });
    const repaired = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(repaired[0].delivery, "settled");
    assertEquals(repaired[0].reconciliation?.financialDisposition, "consumed");
  },
);

// ---------------------------------------------------------------------------
// Round 3 — signing-key rotation. A delayed receipt's grant is verified as of
// an instant the grant was live; the ring's previous key is judged at the
// TRUSTED now (its retirement no further ahead than the propagation grace)
// and by the grant's issuance (no later than retirement plus the grace, and
// before the overlap closed). A routine rotation must never strand the
// receipt of a grant that expired before the rotation; a key the ring no
// longer holds, or a grant the previous key signed after it stopped being an
// issuer, stays ambiguous.
// ---------------------------------------------------------------------------

function ring(previous: { retiredAt: number; overlapEndsAt: number } | null): unknown {
  return {
    schemaVersion: 1,
    active: privateJwk,
    previous:
      previous === null
        ? null
        : {
            jwk: oldPublicJwk,
            retiredAtEpochSeconds: previous.retiredAt,
            overlapEndsAtEpochSeconds: previous.overlapEndsAt,
          },
  };
}

Deno.test(
  "a routine key rotation (previous key kept for the full overlap) settles the delayed receipt of an old-key grant that expired before the rotation",
  async () => {
    const now = nowSeconds();
    // Grant signed by the OLD key 10 days ago, expired 3 days ago; the device
    // consumed offline and only now comes online.
    const user = freshUser();
    const owned = freeClaims(user.sub, { issuedAt: now - 10 * DAY });
    assert(
      owned.exp < now - OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS - DAY,
      "fixture: the grant expired well before the rotation",
    );
    const fixture = await settledFixture(user.sub, TICKET_A, 1, {
      key: oldSigningKey,
      claims: owned,
    });
    const entry = { receipt: fixture.receipt, grant: fixture.grant, output: fixture.output };

    // Control: before the rotation (old key active) the receipt settles.
    reset();
    Deno.env.set(SIGNING_ENV, JSON.stringify(oldPrivateJwk));
    const before = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(before[0].delivery, "settled", "control: the grant itself is valid");

    // Rotation 1 day ago, previous key retained for the maximal 7-day overlap.
    reset();
    Deno.env.set(
      SIGNING_ENV,
      JSON.stringify(ring({ retiredAt: now - DAY, overlapEndsAt: now - DAY + 7 * DAY })),
    );
    const after = await results(await post({ receipts: [entry] }, user.token));
    assertEquals(
      after[0].delivery,
      "settled",
      `old-key grant inside the overlap window was ${after[0].delivery}: ${JSON.stringify(after[0].reconciliation)}`,
    );
    assertEquals(after[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(settleCalls()[0].p_hold_reason, null);

    // An old-key grant still inside its lease settles during the overlap too.
    reset();
    Deno.env.set(
      SIGNING_ENV,
      JSON.stringify(ring({ retiredAt: now - DAY, overlapEndsAt: now - DAY + 7 * DAY })),
    );
    const live = await settledFixture(user.sub, TICKET_B, 2, {
      key: oldSigningKey,
      claims: freeClaims(user.sub, { issuedAt: now - 2 * DAY }),
    });
    const liveOut = await results(
      await post(
        { receipts: [{ receipt: live.receipt, grant: live.grant, output: live.output }] },
        user.token,
      ),
    );
    assertEquals(liveOut[0].delivery, "settled");
  },
);

Deno.test(
  "a grant signed inside the propagation grace after retirement settles once its receipt is delayed past overlapEndsAt; a grant the previous key signed after the grace, or a key the ring dropped, stays HELD",
  async () => {
    const now = nowSeconds();
    const user = freshUser();
    const retiredAt = now - 8 * DAY;
    const overlapEndsAt = retiredAt + 7 * DAY; // the maximal window
    // Signed 5 minutes AFTER retirement (inside the grace the ring honours),
    // expired a day ago, delivered today — after the overlap closed.
    const grace = freeClaims(user.sub, {
      issuedAt: retiredAt + 5 * 60,
      grantId: "64444444-4444-4444-8444-444444444461",
    });
    assert(grace.exp - 1 >= overlapEndsAt, "fixture: the lease outlives the overlap");
    assert(grace.exp < now, "fixture: the lease has expired");
    const graceFixture = await settledFixture(user.sub, TICKET_A, 1, {
      key: oldSigningKey,
      claims: grace,
    });
    reset();
    Deno.env.set(SIGNING_ENV, JSON.stringify(ring({ retiredAt, overlapEndsAt })));
    const graceOut = await results(
      await post(
        {
          receipts: [
            {
              receipt: graceFixture.receipt,
              grant: graceFixture.grant,
              output: graceFixture.output,
            },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      graceOut[0].delivery,
      "settled",
      `grace-window grant was ${graceOut[0].delivery}: ${JSON.stringify(graceOut[0].reconciliation)}`,
    );

    // Signed by the previous key one second AFTER the grace: not an issuer any
    // more when it signed — ambiguous, HELD with the ticket reserved.
    const late = freeClaims(user.sub, {
      issuedAt: retiredAt + OFFLINE_KEY_ROTATION_PROPAGATION_GRACE_SECONDS + 1,
      grantId: "64444444-4444-4444-8444-444444444462",
    });
    const lateFixture = await settledFixture(user.sub, TICKET_B, 2, {
      key: oldSigningKey,
      claims: late,
    });
    const lateOut = await results(
      await post(
        {
          receipts: [
            { receipt: lateFixture.receipt, grant: lateFixture.grant, output: lateFixture.output },
          ],
        },
        user.token,
      ),
    );
    assertEquals(lateOut[0].delivery, "held");
    assertEquals(lateOut[0].reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(lateOut[0].reconciliation?.financialDisposition, "reserved");

    // Once the ring drops the previous key, an old-key receipt is ambiguous.
    reset();
    Deno.env.set(SIGNING_ENV, JSON.stringify(ring(null)));
    const dropped = await results(
      await post(
        {
          receipts: [
            {
              receipt: graceFixture.receipt,
              grant: graceFixture.grant,
              output: graceFixture.output,
            },
          ],
        },
        user.token,
      ),
    );
    assertEquals(dropped[0].delivery, "held");
    assertEquals(dropped[0].reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(dropped[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      0,
    );
  },
);

// ---------------------------------------------------------------------------
// Live postgres half — the REAL settle_offline_receipt() on a disposable
// postgres:16 with every migration applied.
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000b-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000b-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-04-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-${n}-${RUN}', '${U(n)}', '{"sub":"w04-04-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(tx: Tx, n: number, session = true): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (session) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

async function settle(
  tx: Tx,
  rec: OfflineResultReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(out)},
       ${hold === null ? "null::text" : `'${hold}'`}
     ) r`,
  );
  assertEquals(rows.length, 1);
  return rows[0];
}

async function ledgerEvents(sql: Sql, ticketId: string): Promise<string[]> {
  const rows = await sql.unsafe<{ event: string }[]>(
    `select event from public.offline_allocation_ledger where ticket_id = '${ticketId}' order by id`,
  );
  return rows.map((row) => row.event);
}

type LiveGrant = { claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant };

/** issue_offline_grant() for an already registered installation — the
 * documented lease-refresh path re-issues the installation's outstanding
 * tickets under the NEXT generation (a new grant id) without writing a new
 * allocation row. */
async function refreshFreeGrant(
  sql: Sql,
  n: number,
  key: string,
  requested = 2,
  ownerId = U(n),
): Promise<LiveGrant> {
  const row = await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ row: unknown }[]>(
      `select to_jsonb(g) as row from public.issue_offline_grant('${key}', ${requested}) g`,
    );
    return rows[0].row;
  });
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId,
    installationKeyId: key,
    release: RELEASE,
  });
  assert(claims.allocation, `free grant expected: ${JSON.stringify(row)}`);
  return { claims, grant: await sign(claims) };
}

async function registerDevice(sql: Sql, n: number, key: string): Promise<void> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
}

async function issueFreeGrant(sql: Sql, n: number, key: string, requested = 2): Promise<LiveGrant> {
  await registerDevice(sql, n, key);
  const issued = await refreshFreeGrant(sql, n, key, requested);
  assert(issued.claims.allocation && issued.claims.allocation.ticketIds.length === requested);
  return issued;
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineResultReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `receipt-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

async function shotCount(sql: Sql, ticketId: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where offline_ticket_id = '${ticketId}'`,
  );
  return Number(count);
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
}

Deno.test({
  name: "live DB: settle_offline_receipt() consumes a ticket exactly once across duplicate deliveries and holds a conflicting second result with the ticket still allocated",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const key = KEY("receipts");
      const { claims, grant } = await issueFreeGrant(sql, 1, key);
      assert(claims.allocation);
      const [ticketA, ticketB] = claims.allocation.ticketIds;
      const resultA = crypto.randomUUID();
      const outA = output(resultA);
      const recA = await receipt({
        receiptId: `receipt-a-${RUN}`,
        ownerId: U(1),
        grant,
        claims,
        ticket: ticketRef(ticketA, claims),
        lifecycleSequence: 1,
        operationId: `operation-a-${RUN}`,
        resultId: resultA,
        fullOutputSha256: await digestCanonicalOfflineJson(outA),
      });

      const first = await inTx(sql, 1, (tx) => settle(tx, recA, outA, null));
      assertEquals(first, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "consumed",
        result_id: resultA,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      const [shot] = await sql.unsafe<{ offline_ticket_id: string; user_id: string }[]>(
        `select offline_ticket_id, user_id from public.shots where id = '${resultA}'`,
      );
      assertEquals(shot, { offline_ticket_id: ticketA, user_id: U(1) });

      // Duplicate deliveries: the durable verdict replays, nothing is written twice.
      for (let i = 0; i < 3; i += 1) {
        const again = await inTx(sql, 1, (tx) => settle(tx, recA, outA, null));
        assertEquals(again, { ...first, delivery: "replayed" });
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      const [{ count: shots }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where offline_ticket_id = '${ticketA}'`,
      );
      assertEquals(shots, "1");

      // The same receipt id with a different body is a conflict, not a settlement.
      const forged = { ...recA, resultId: crypto.randomUUID() };
      const conflict = await inTx(sql, 1, (tx) => settle(tx, forged, outA, null));
      assertEquals(conflict.result, "offline.receipt_conflict");
      assertEquals(conflict.delivery, null);

      // A second receipt claiming the SAME ticket with another result: HELD
      // as conflicting_receipt; the consumed event stands, nothing is released.
      const resultB = crypto.randomUUID();
      const outB = output(resultB);
      const recB = await receipt({
        receiptId: `receipt-b-${RUN}`,
        ownerId: U(1),
        grant,
        claims,
        ticket: ticketRef(ticketA, claims),
        lifecycleSequence: 2,
        operationId: `operation-b-${RUN}`,
        resultId: resultB,
        fullOutputSha256: await digestCanonicalOfflineJson(outB),
      });
      const held = await inTx(sql, 1, (tx) => settle(tx, recB, outB, null));
      assertEquals(held, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "conflicting_receipt",
        financial_disposition: "reserved",
        result_id: null,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(
        (await sql.unsafe(`select 1 from public.shots where id = '${resultB}'`)).length,
        0,
      );

      // A second receipt re-using operation-a under ticket B: the operation
      // already has a recorded result → HELD, ticket B stays allocated (never
      // consumed, never released), and offline_hold_count() still counts it.
      const recC = await receipt({
        receiptId: `receipt-c-${RUN}`,
        ownerId: U(1),
        grant,
        claims,
        ticket: ticketRef(ticketB, claims),
        lifecycleSequence: 3,
        operationId: `operation-a-${RUN}`,
        resultId: crypto.randomUUID(),
        fullOutputSha256: await digestCanonicalOfflineJson(outB),
      });
      const heldC = await inTx(sql, 1, (tx) => settle(tx, recC, outB, null));
      assertEquals(heldC.delivery, "held");
      assertEquals(heldC.reason_code, "conflicting_receipt");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);

      // An edge-derived hold (unverifiable evidence) is durable and replays.
      const recD = await receipt({
        receiptId: `receipt-d-${RUN}`,
        ownerId: U(1),
        grant,
        claims,
        ticket: ticketRef(ticketB, claims),
        lifecycleSequence: 4,
        operationId: `operation-d-${RUN}`,
        resultId: crypto.randomUUID(),
        fullOutputSha256: "e".repeat(64),
      });
      const heldD = await inTx(sql, 1, (tx) => settle(tx, recD, null, "evidence_ambiguous"));
      assertEquals(heldD, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "evidence_ambiguous",
        financial_disposition: "reserved",
        result_id: null,
      });
      const replayD = await inTx(sql, 1, (tx) => settle(tx, recD, null, null));
      assertEquals(replayD, { ...heldD, delivery: "replayed" });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      const [{ held: holds }] = await inTx(sql, 1, (tx) =>
        tx.unsafe<{ held: number }[]>(`select public.offline_hold_count() as held`),
      );
      assertEquals(Number(holds), 1);

      // Ticket B, now settled for real with its own operation, still consumes
      // exactly once — holds never blocked the honest receipt.
      const resultE = crypto.randomUUID();
      const outE = output(resultE);
      const recE = await receipt({
        receiptId: `receipt-e-${RUN}`,
        ownerId: U(1),
        grant,
        claims,
        ticket: ticketRef(ticketB, claims),
        lifecycleSequence: 5,
        operationId: `operation-e-${RUN}`,
        resultId: resultE,
        fullOutputSha256: await digestCanonicalOfflineJson(outE),
      });
      const settledE = await inTx(sql, 1, (tx) => settle(tx, recE, outE, null));
      assertEquals(settledE.delivery, "settled");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);

      // Every verdict is durable, in delivery order (superuser view); the
      // table itself takes no client reads or writes — the RPC is its only
      // reader and writer — and no session-less call settles anything.
      const rows = await sql.unsafe<{ receipt_id: string; status: string; user_id: string }[]>(
        `select receipt_id, status, user_id from public.offline_receipt_settlements
         where user_id = '${U(1)}' order by id`,
      );
      assertEquals(
        rows.map((r) => [r.receipt_id, r.status]),
        [
          [recA.receiptId, "result_recorded"],
          [recB.receiptId, "reconciliation_required"],
          [recC.receiptId, "reconciliation_required"],
          [recD.receiptId, "reconciliation_required"],
          [recE.receiptId, "result_recorded"],
        ],
      );
      for (const statement of [
        `select 1 from public.offline_receipt_settlements`,
        `insert into public.offline_receipt_settlements (receipt_id, receipt_sha256, user_id, owner_id, installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence, status, financial_disposition, receipt)
         values ('x', '${"0".repeat(64)}', '${U(1)}', '${U(1)}', 'k', '${GRANT_ID}', '${"0".repeat(
           64,
         )}', 'op', 'res', '${"0".repeat(
           64,
         )}', 'not_chargeable', 1, 'result_recorded', 'not_applicable', '{}'::jsonb)`,
        `update public.offline_receipt_settlements set status = 'result_recorded' where receipt_id = '${recB.receiptId}'`,
        `delete from public.offline_receipt_settlements where receipt_id = '${recB.receiptId}'`,
      ]) {
        let code = "";
        try {
          await inTx(sql, 1, (tx) => tx.unsafe(statement));
        } catch (error) {
          code = (error as { code?: string }).code ?? "";
        }
        assertEquals(code, "42501", statement.slice(0, 40));
      }
      let sessionless = "";
      try {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, 1, false);
          await settle(tx as unknown as Tx, recE, outE, null);
        });
      } catch (error) {
        sessionless = (error as { code?: string }).code ?? "";
      }
      assertEquals(sessionless, "42501");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// Round 2, live DB — allocation LINEAGE. issue_offline_grant() re-issues the
// installation's outstanding tickets under the next generation (a new grant
// id) and writes no new allocation row, so a receipt rendered under the
// refreshed grant names the ticket exactly as that grant lists it. It must
// settle once; the superseded grant's receipt for the same ticket must then
// hold, never double-consume; a grant of another installation, or a
// generation the grant never had, stays HELD as evidence_ambiguous.
// ---------------------------------------------------------------------------

Deno.test({
  name: "live DB: a ticket re-issued under the next grant generation settles exactly once through a receipt bound to the refreshed grant; out-of-order receipts across generations never double-consume; foreign installations and contradictory generations stay HELD",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const key = KEY("refresh");
      const gen1 = await issueFreeGrant(sql, 2, key);
      assert(gen1.claims.allocation);
      const [ticketA, ticketB] = gen1.claims.allocation.ticketIds;

      const gen2 = await refreshFreeGrant(sql, 2, key);
      assert(gen2.claims.allocation);
      assert(gen2.claims.jti !== gen1.claims.jti);
      assertEquals(gen2.claims.allocation.generation, gen1.claims.allocation.generation + 1);
      assertEquals([...gen2.claims.allocation.ticketIds].sort(), [ticketA, ticketB].sort());
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // Rendered under the refreshed grant → settles, consumed once.
      const late = await liveReceipt(U(2), gen2, ticketA, "gen2");
      const verdict = await inTx(sql, 2, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals(verdict, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "consumed",
        result_id: late.receipt.resultId,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      const replay = await inTx(sql, 2, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals(replay, { ...verdict, delivery: "replayed" });

      // The SAME ticket under the superseded generation-1 grant: held as a
      // conflicting receipt, the consumed event stands, no second rating.
      const stale = await liveReceipt(U(2), gen1, ticketA, "gen1-stale");
      const held = await inTx(sql, 2, (tx) => settle(tx, stale.receipt, stale.output, null));
      assertEquals(held.delivery, "held");
      assertEquals(held.reason_code, "conflicting_receipt");
      assertEquals(held.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);

      // Ticket B rendered under the ORIGINAL grant still settles once —
      // delivery order across generations is free.
      const early = await liveReceipt(U(2), gen1, ticketB, "gen1");
      const first = await inTx(sql, 2, (tx) => settle(tx, early.receipt, early.output, null));
      assertEquals(first.delivery, "settled");
      assertEquals(first.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      // …and its refreshed twin then holds rather than consuming again.
      const twin = await liveReceipt(U(2), gen2, ticketB, "gen2-twin");
      const heldTwin = await inTx(sql, 2, (tx) => settle(tx, twin.receipt, twin.output, null));
      assertEquals(heldTwin.delivery, "held");
      assertEquals(heldTwin.reason_code, "conflicting_receipt");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 2), { held: 0, scored: 2 });

      // Another installation of the same account: its grant never listed
      // ticket 1, so a receipt binding ticket 1 to it is ambiguous evidence
      // (held, reserved) and the honest receipt under the allocating grant
      // still settles afterwards.
      await createUser(sql, 3);
      const key1 = KEY("install-1");
      const key2 = KEY("install-2");
      const g1 = await issueFreeGrant(sql, 3, key1, 1);
      await registerDevice(sql, 3, key2);
      const g2 = await refreshFreeGrant(sql, 3, key2, 1);
      assert(g1.claims.allocation && g2.claims.allocation);
      const [t1] = g1.claims.allocation.ticketIds;
      const [t2] = g2.claims.allocation.ticketIds;
      assert(t1 !== t2);
      const cross = await liveReceipt(U(3), g2, t1, "cross-install");
      const heldCross = await inTx(sql, 3, (tx) => settle(tx, cross.receipt, cross.output, null));
      assertEquals(heldCross.delivery, "held");
      assertEquals(heldCross.reason_code, "evidence_ambiguous");
      assertEquals(heldCross.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, t1), ["allocated"]);
      // A generation the allocating grant never had is contradictory evidence.
      const contradictory = await liveReceipt(U(3), g2, t2, "generation-99", {
        ticket: { ...ticketRef(t2, g2.claims), generation: 99 },
      });
      const heldContradictory = await inTx(sql, 3, (tx) =>
        settle(tx, contradictory.receipt, contradictory.output, null),
      );
      assertEquals(heldContradictory.delivery, "held");
      assertEquals(heldContradictory.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, t2), ["allocated"]);
      assertEquals(await counters(sql, 3), { held: 2, scored: 0 });
      const honest1 = await liveReceipt(U(3), g1, t1, "honest-1");
      const honest2 = await liveReceipt(U(3), g2, t2, "honest-2");
      assertEquals(
        (await inTx(sql, 3, (tx) => settle(tx, honest1.receipt, honest1.output, null))).delivery,
        "settled",
      );
      assertEquals(
        (await inTx(sql, 3, (tx) => settle(tx, honest2.receipt, honest2.output, null))).delivery,
        "settled",
      );
      assertEquals(await ledgerEvents(sql, t1), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, t2), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 3), { held: 0, scored: 2 });
    } finally {
      await sql.end();
    }
  },
});

/** The re-created account of a deleted user: a NEW auth.users row holding the
 * SAME sign-in identity (provider subject), the arm offline_ticket_owned_by()
 * recovers outstanding tickets through. */
async function recreateUser(sql: Sql, deleted: number, recreated: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(deleted)}'`);
  await sql.unsafe(`delete from auth.users where id = '${U(recreated)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(recreated)}', 'w04-04-${deleted}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-${deleted}-${RUN}', '${U(
       recreated,
     )}', '{"sub":"w04-04-${deleted}-${RUN}"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${SESSION(recreated)}', '${U(recreated)}')`,
  );
}

Deno.test({
  name: "live DB: the original installation of a deleted-and-re-created account settles its outstanding ticket through the grant that re-issued it (original-owner recovery), exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      const key = KEY("recovery");
      const original = await issueFreeGrant(sql, 4, key);
      assert(original.claims.allocation);
      const [ticketA, ticketB] = original.claims.allocation.ticketIds;

      await recreateUser(sql, 4, 40);
      await registerDevice(sql, 40, key);
      const recovered = await refreshFreeGrant(sql, 40, key);
      assert(recovered.claims.allocation);
      assertEquals([...recovered.claims.allocation.ticketIds].sort(), [ticketA, ticketB].sort());
      assert(recovered.claims.jti !== original.claims.jti);

      const rec = await liveReceipt(U(40), recovered, ticketA, "recovered");
      const verdict = await inTx(sql, 40, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(verdict.delivery, "settled", JSON.stringify(verdict));
      assertEquals(verdict.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      const [shot] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${rec.receipt.resultId}'`,
      );
      assertEquals(shot, { user_id: U(40) });
      const again = await inTx(sql, 40, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "replayed");
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await counters(sql, 40), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// Round 2, live DB — transient session and wide integers. A receipt that
// arrives before the session it names has synced is `pending` (no durable
// row, ticket reserved) and the identical receipt settles once the session
// exists; lifecycleSequence / generation are parsed as wide integers, so a
// contract-valid 2^31 receives a durable verdict and 2^53 (not a safe
// integer) is refused without a verdict.
// ---------------------------------------------------------------------------

Deno.test({
  name: "live DB: a receipt delivered before its session syncs is pending (nothing durable, ticket reserved) and settles once the session exists; lifecycleSequence 2^31 gets a durable verdict, 2^53 is refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const key = KEY("session");
      const issued = await issueFreeGrant(sql, 5, key);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const sessionId = crypto.randomUUID();
      const rec = await liveReceipt(U(5), issued, ticketA, "session", {}, { sessionId });

      const early = await inTx(sql, 5, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(early, {
        result: "accepted",
        delivery: "pending",
        status: "pending",
        reason_code: null,
        financial_disposition: "reserved",
        result_id: null,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      const settled = async (): Promise<string[]> =>
        (
          await sql.unsafe<{ receipt_id: string }[]>(
            `select receipt_id from public.offline_receipt_settlements where user_id = '${U(
              5,
            )}' order by id`,
          )
        ).map((r) => r.receipt_id);
      assertEquals(await settled(), []);
      assertEquals(await counters(sql, 5), { held: 2, scored: 0 });
      const stillEarly = await inTx(sql, 5, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(stillEarly, early);

      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${U(
          5,
        )}', now())`,
      );
      const late = await inTx(sql, 5, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(late, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "consumed",
        result_id: rec.receipt.resultId,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await settled(), [rec.receipt.receiptId]);
      assertEquals(
        (await inTx(sql, 5, (tx) => settle(tx, rec.receipt, rec.output, null))).delivery,
        "replayed",
      );

      // A generation beyond int4 the grant never had: contradictory evidence,
      // durably HELD (never a non-durable invalid_input).
      const wideGeneration = await liveReceipt(U(5), issued, ticketB, "generation-2p31", {
        ticket: { ...ticketRef(ticketB, issued.claims), generation: 2 ** 31 },
      });
      const heldWide = await inTx(sql, 5, (tx) =>
        settle(tx, wideGeneration.receipt, wideGeneration.output, null),
      );
      assertEquals(heldWide.delivery, "held");
      assertEquals(heldWide.reason_code, "evidence_ambiguous");
      assertEquals(heldWide.financial_disposition, "reserved");

      // lifecycleSequence 2^31 is contract-valid: settles, durably recorded.
      const wide = await liveReceipt(U(5), issued, ticketB, "sequence-2p31", {
        lifecycleSequence: 2 ** 31,
      });
      const verdict = await inTx(sql, 5, (tx) => settle(tx, wide.receipt, wide.output, null));
      assertEquals(verdict.delivery, "settled", JSON.stringify(verdict));
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      const [row] = await sql.unsafe<{ lifecycle_sequence: string; generation: string }[]>(
        `select lifecycle_sequence::text, generation::text from public.offline_receipt_settlements
         where receipt_id = '${wide.receipt.receiptId}'`,
      );
      assertEquals(row, {
        lifecycle_sequence: String(2 ** 31),
        generation: String(issued.claims.allocation.generation),
      });
      assertEquals(await settled(), [
        rec.receipt.receiptId,
        wideGeneration.receipt.receiptId,
        wide.receipt.receiptId,
      ]);

      // 2^53 is outside the shared contract (not a safe integer): refused,
      // nothing recorded.
      const unsafe = await liveReceipt(U(5), issued, ticketB, "sequence-2p53", {
        lifecycleSequence: 2 ** 53,
      });
      const refused = await inTx(sql, 5, (tx) => settle(tx, unsafe.receipt, unsafe.output, null));
      assertEquals(refused.result, "offline.invalid_input");
      assertEquals(refused.delivery, null);
      assertEquals((await settled()).length, 3);
      assertEquals(await counters(sql, 5), { held: 0, scored: 2 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// Round 3, live DB — the receipt's billing disposition and the delivered
// output must agree. A chargeable receipt beside an abstention output is
// HELD (already pinned); the mirror — a not_chargeable receipt beside an
// output that claims a scored rating — is the same contradictory evidence
// and must HOLD too, never become a durable result_recorded verdict. A
// not_chargeable receipt beside a genuine abstention is recorded and leaves
// the ticket outstanding.
// ---------------------------------------------------------------------------

Deno.test({
  name: "live DB: settle_offline_receipt() HOLDs a not_chargeable receipt whose delivered output claims resultKind=scored (contradictory evidence), records a genuine abstention, and consumes nothing either way",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      const issued = await issueFreeGrant(sql, 6, KEY("billing"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      // Control: chargeable receipt + abstention output → HOLD evidence_ambiguous.
      const mirror = await liveReceipt(
        U(6),
        issued,
        ticketA,
        "billing-mirror",
        {},
        { resultKind: "low_confidence", overallScore: null },
      );
      const mirrorVerdict = await inTx(sql, 6, (tx) =>
        settle(tx, mirror.receipt, mirror.output, null),
      );
      assertEquals(
        [mirrorVerdict.delivery, mirrorVerdict.status, mirrorVerdict.reason_code],
        ["held", "reconciliation_required", "evidence_ambiguous"],
      );

      // not_chargeable receipt + scored output: contradictory → HOLD, durable.
      const contradiction = await liveReceipt(U(6), issued, ticketB, "billing-scored", {
        billingDisposition: "not_chargeable",
      });
      const verdict = await inTx(sql, 6, (tx) =>
        settle(tx, contradiction.receipt, contradiction.output, null),
      );
      assertEquals(
        verdict,
        {
          result: "accepted",
          delivery: "held",
          status: "reconciliation_required",
          reason_code: "evidence_ambiguous",
          financial_disposition: "reserved",
          result_id: null,
        },
        `not_chargeable receipt with a scored output was ${JSON.stringify(verdict)}`,
      );
      const replay = await inTx(sql, 6, (tx) =>
        settle(tx, contradiction.receipt, contradiction.output, null),
      );
      assertEquals(replay, { ...verdict, delivery: "replayed" });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketB), 0);
      assertEquals(
        (
          await sql.unsafe(
            `select 1 from public.shots where id = '${contradiction.receipt.resultId}'`,
          )
        ).length,
        0,
      );

      // A genuine abstention under the same ticket is recorded; the ticket
      // stays outstanding (nothing consumed, nothing released).
      const abstention = await liveReceipt(
        U(6),
        issued,
        ticketB,
        "billing-abstain",
        { billingDisposition: "not_chargeable", lifecycleSequence: 2 },
        { resultKind: "low_confidence", overallScore: null },
      );
      const recorded = await inTx(sql, 6, (tx) =>
        settle(tx, abstention.receipt, abstention.output, null),
      );
      assertEquals(recorded, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "reserved",
        result_id: abstention.receipt.resultId,
      });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 6), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});
