// W04-04 round 6 — the 1.0 wire contract of POST /v1/offline/receipts and the
// ordering of the reversible deny-new freeze against the durable ledger.
//
// Regression for the adversary findings against the round-4 candidate:
//   A1  the shipping app posts the DEVICE receipt exactly as
//       apps/mobile/src/data/api.ts OfflineReceiptSubmission persists it (no
//       nativeTime / attestation, plus queuedAt) inside { receipt, grant,
//       output } and reads { receipts: [{ receiptId, status, … }], rejected:
//       [{ receiptId, code, … }] } — every submitted id named exactly once
//       (parseOfflineReceiptVerdicts). The route used to demand the
//       full-evidence receipt and answer results[].
//   A2  a receipt already SETTLED, durably HELD, or a same-id/different-digest
//       forgery, redelivered while the release is frozen (deny new
//       authorizations, NOT withdrawn), must replay the ledger's verdict /
//       be refused offline.receipt_conflict — the freeze may only defer a
//       genuinely NEW chargeable settlement. The route used to answer pending
//       for all of them before calling the RPC.
//
// Two halves, both black-box:
//   * the REAL edge handler through routesHarness with the settlement RPC
//     stood in exactly like the migration (replay / conflict / hold first,
//     then p_defer_new);
//   * the REAL settle_offline_receipt(…, p_defer_new) on a disposable
//     postgres:16 with every migration applied (./xc_pg_up.sh, XC_PG_URL).
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a
// pass (the W04-04-AC2 gate runs with XC_PG_URL set).
//
// On BASE_SHA the route rejects the device receipt (receiptId unnamed, no
// receipts[]/rejected[]) and the RPC has no fifth parameter, so every test
// here fails there.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  type OfflineDeviceReceipt,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
  type OfflineReleasedArtifacts,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  offlineGrantClaimsFromIssuance,
  type OfflineGrantKey,
  signOfflineExecutionGrant,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import {
  fakeGoogleIdToken,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const SETTLE_RPC = "/rest/v1/rpc/settle_offline_receipt";
const CONSUME_RPC = "/rest/v1/rpc/consume_offline_ticket";
const RELEASE_RPC = "/rest/v1/rpc/release_offline_ticket";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-r6-test-key";
const FOREIGN_KID = "w04-04-r6-foreign-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-r6";
const GRANT_ID = "64444444-4444-4444-8444-444444444460";
const TICKET_A = "65555555-5555-4555-8555-555555555561";
const TICKET_B = "65555555-5555-4555-8555-555555555562";
const DAY = 86_400;

/** The field list of apps/mobile/src/data/api.ts OfflineReceiptSubmission —
 * the device receipt as the app persists and posts it. */
const MOBILE_RECEIPT_FIELDS = [
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
] as const;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const foreignKeyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
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

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

/** The ACTIVE release under a reversible freeze: it denies NEW authorizations
 * but is not withdrawn — the operator may lift it. */
function frozenActiveRow(): Record<string, unknown> {
  const base = releasePolicyRow.approval as Record<string, unknown>;
  return {
    ...releasePolicyRow,
    denyNewAuthorizations: true,
    approval: { ...base, denyNewAuthorizations: true },
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
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0406-4000-8000-${String(userSeq).padStart(12, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(ownerId: string, grantId = GRANT_ID): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: grantId,
      generation: 3,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 7 * DAY),
      entitlement_expires_at: null,
      ticket_ids: [TICKET_A, TICKET_B],
    },
    { issuer: ISSUER, ownerId, installationKeyId: INSTALLATION_KEY, release: RELEASE },
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

/** The rated shot payload the device durably delivered; `id` is the result
 * id the receipt names. */
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

interface DeviceReceiptOptions {
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
}

/** The device receipt EXACTLY as apps/mobile persists it. */
async function deviceReceipt(options: DeviceReceiptOptions): Promise<OfflineDeviceReceipt> {
  return {
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    lifecycleSequence: options.lifecycleSequence,
    ticket: options.ticket,
    operationId: options.operationId,
    resultId: options.resultId,
    fullOutputSha256: options.fullOutputSha256,
    billingDisposition: options.billingDisposition ?? "joint_verification_required",
    queuedAt: "2026-09-08T10:00:00.000Z",
  };
}

interface Entry {
  receipt: OfflineDeviceReceipt;
  grant: OfflineSignedExecutionGrant;
  output: Record<string, unknown> | null;
}

async function ticketEntry(
  ownerId: string,
  claims: OfflineExecutionGrantClaims,
  grant: OfflineSignedExecutionGrant,
  ticketId: string,
  tag: string,
  options: {
    billingDisposition?: OfflineDeviceReceipt["billingDisposition"];
    outputOverrides?: Record<string, unknown>;
  } = {},
): Promise<Entry> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, options.outputOverrides ?? {});
  return {
    receipt: await deviceReceipt({
      receiptId: `receipt-${tag}`,
      ownerId,
      grant,
      claims,
      ticket: ticketRef(ticketId, claims),
      lifecycleSequence: 1,
      operationId: `operation-${tag}`,
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(out),
      billingDisposition: options.billingDisposition,
    }),
    grant,
    output: out,
  };
}

// ---------------------------------------------------------------------------
// Durable RPC stand-in — the migration's decision order: a receipt already
// held by (caller, receiptId) replays its verdict or is a conflict; an edge
// hold or contradictory evidence is a durable HOLD; only then does
// p_defer_new turn a genuinely new chargeable receipt into pending.
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
  p_defer_new: boolean;
}

const durable = new Map<string, { sha256: string; row: SettleRow }>();

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  assertEquals(typeof params.p_defer_new, "boolean", "the freeze travels to the RPC");
  const key = `${call.headers.authorization}|${params.p_receipt.receiptId}`;
  const known = durable.get(key);
  const ticketed = params.p_receipt.ticket !== null;
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
    (ticketed &&
      params.p_receipt.billingDisposition === "not_chargeable" &&
      params.p_output !== null &&
      params.p_output.resultKind === "scored")
  ) {
    row = {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason ?? "evidence_ambiguous",
      financial_disposition: ticketed ? "reserved" : "not_applicable",
      result_id: null,
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  } else if (
    params.p_defer_new &&
    params.p_receipt.billingDisposition === "joint_verification_required"
  ) {
    row = {
      result: "accepted",
      delivery: "pending",
      status: "pending",
      reason_code: null,
      financial_disposition: ticketed ? "reserved" : "not_applicable",
      result_id: null,
    };
  } else {
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition: !ticketed
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
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

// ---------------------------------------------------------------------------
// apps/mobile/src/data/api.ts parseOfflineReceiptVerdicts, mirrored line for
// line (the mobile module cannot be imported into the Deno suite): the answer
// is readable only when `receipts` and `rejected` are arrays naming every
// submitted receipt id exactly once with a status the app knows.
// ---------------------------------------------------------------------------

type MobileVerdictKind = "accepted" | "held" | "refused";
interface MobileVerdict {
  receiptId: string;
  verdict: MobileVerdictKind;
  code: string;
}
const MOBILE_STATUS_VERDICTS = new Map<string, MobileVerdictKind>([
  ["result_recorded", "accepted"],
  ["unused_ticket_returned", "refused"],
  ["pending", "held"],
  ["reconciliation_required", "held"],
  ["support_review_required", "held"],
]);
const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

function mobileParse(value: unknown, submittedIds: readonly string[]): MobileVerdict[] | null {
  if (!isJsonObject(value)) return null;
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
    if (!isJsonObject(entry)) return null;
    const { receiptId, status } = entry;
    if (!isNonEmptyString(receiptId) || !isNonEmptyString(status)) return null;
    const verdict = MOBILE_STATUS_VERDICTS.get(status);
    if (verdict === undefined) return null;
    if (!record({ receiptId, verdict, code: status })) return null;
  }
  for (const entry of rejected) {
    if (!isJsonObject(entry)) return null;
    const { receiptId, code } = entry;
    if (!isNonEmptyString(receiptId) || !isNonEmptyString(code)) return null;
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

/** Post a batch as the app does and read it as the app does. */
async function drain(
  entries: Entry[],
  token: string,
): Promise<{ body: Record<string, unknown>; verdicts: MobileVerdict[] }> {
  const response = await post({ receipts: entries }, token);
  const body = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(body));
  const verdicts = mobileParse(
    body,
    entries.map((entry) => entry.receipt.receiptId),
  );
  assert(verdicts, `unreadable by the app: ${JSON.stringify(body)}`);
  return { body, verdicts };
}

interface WireVerdict {
  receiptId: string;
  status: string;
  reasonCode: string | null;
  financialDisposition: string;
  resultId: string | null;
  delivery: string;
}

function wireReceipts(body: Record<string, unknown>): WireVerdict[] {
  return body.receipts as WireVerdict[];
}

function wireRejected(body: Record<string, unknown>): { receiptId: string; code: string }[] {
  return body.rejected as { receiptId: string; code: string }[];
}

// ---------------------------------------------------------------------------
// A1 — the exact mobile OfflineReceiptSubmission entry, the exact mobile answer
// ---------------------------------------------------------------------------

Deno.test(
  "A1 [wire contract] the exact mobile OfflineReceiptSubmission entry (no nativeTime/attestation, with queuedAt) settles and is answered in the shape parseOfflineReceiptVerdicts reads — { receipts, rejected }, every id once",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const entry = await ticketEntry(user.sub, claims, grant, TICKET_A, "mobile-1");
    // The posted receipt IS the mobile submission: its keys, no more, no less.
    assertEquals(Object.keys(entry.receipt).sort(), [...MOBILE_RECEIPT_FIELDS].sort());
    assertEquals(entry.receipt.billingDisposition, "joint_verification_required");
    assert(!("schemaVersion" in entry.receipt));
    assert(!("nativeTime" in entry.receipt));
    assert(!("attestation" in entry.receipt));

    const pro = await sign(proClaims(user.sub));
    const proResultId = crypto.randomUUID();
    const proOutput = output(proResultId);
    const proEntry: Entry = {
      receipt: await deviceReceipt({
        receiptId: "receipt-mobile-pro",
        ownerId: user.sub,
        grant: pro,
        claims: proClaims(user.sub),
        ticket: null,
        lifecycleSequence: 1,
        operationId: "operation-mobile-pro",
        resultId: proResultId,
        fullOutputSha256: await digestCanonicalOfflineJson(proOutput),
      }),
      grant: pro,
      output: proOutput,
    };

    const { body, verdicts } = await drain([entry, proEntry], user.token);
    assertEquals(verdicts, [
      { receiptId: "receipt-mobile-1", verdict: "accepted", code: "result_recorded" },
      { receiptId: "receipt-mobile-pro", verdict: "accepted", code: "result_recorded" },
    ]);
    assertEquals(Object.keys(body).sort(), ["receipts", "rejected"]);
    assertEquals(wireRejected(body), []);
    assertEquals(wireReceipts(body), [
      {
        receiptId: "receipt-mobile-1",
        status: "result_recorded",
        reasonCode: null,
        financialDisposition: "consumed",
        resultId: entry.receipt.resultId,
        delivery: "settled",
      },
      {
        receiptId: "receipt-mobile-pro",
        status: "result_recorded",
        reasonCode: null,
        financialDisposition: "not_applicable",
        resultId: proResultId,
        delivery: "settled",
      },
    ]);

    // The device receipt reaches the durable settlement byte for byte, with
    // its own canonical digest, the delivered output and no freeze.
    const params = settleCalls();
    assertEquals(params.length, 2);
    assertEquals(params[0].p_receipt, { ...entry.receipt });
    assertEquals(params[0].p_receipt_sha256, await digestCanonicalOfflineJson(entry.receipt));
    assertEquals(params[0].p_output, entry.output);
    assertEquals(params[0].p_hold_reason, null);
    assertEquals(params[0].p_defer_new, false);
    assertEquals(params[1].p_receipt.ticket, null);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);

    // A held receipt and a per-entry refusal are read by the app too — as
    // held / refused, each id once, alongside the good one.
    reset();
    const foreignGrant = await sign(claims, foreignSigningKey);
    const ambiguous = await ticketEntry(user.sub, claims, foreignGrant, TICKET_B, "mobile-2");
    const malformed: Entry = {
      ...entry,
      receipt: { ...entry.receipt, receiptId: "receipt-mobile-3", lifecycleSequence: 0 },
    };
    const mixed = await drain([ambiguous, malformed, entry], user.token);
    assertEquals(mixed.verdicts, [
      { receiptId: "receipt-mobile-2", verdict: "held", code: "reconciliation_required" },
      { receiptId: "receipt-mobile-3", verdict: "refused", code: "offline.invalid_input" },
      { receiptId: "receipt-mobile-1", verdict: "accepted", code: "result_recorded" },
    ]);
    assertEquals(wireReceipts(mixed.body)[0].reasonCode, "evidence_ambiguous");
    assertEquals(wireReceipts(mixed.body)[0].financialDisposition, "reserved");
    assertEquals(wireReceipts(mixed.body)[0].delivery, "held");
    assertEquals(settleCalls().length, 2, "a malformed entry never reaches the database");
  },
);

// ---------------------------------------------------------------------------
// A2 — the freeze never hides the ledger
// ---------------------------------------------------------------------------

Deno.test(
  "A2 [freeze ordering] under a reversible deny-new freeze a settled receipt replays consumed, a durable HOLD replays held, a same-id forgery is offline.receipt_conflict, and only a genuinely new chargeable receipt is pending — the freeze travels to the RPC as p_defer_new",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const settled = await ticketEntry(user.sub, claims, grant, TICKET_A, "frozen-settled");
    const held = await ticketEntry(
      user.sub,
      claims,
      await sign(claims, foreignSigningKey),
      TICKET_B,
      "frozen-held",
    );

    // Before the freeze: one settles (consumed), one is durably held.
    const before = await drain([settled, held], user.token);
    assertEquals(
      wireReceipts(before.body).map((r) => [r.delivery, r.status, r.financialDisposition]),
      [
        ["settled", "result_recorded", "consumed"],
        ["held", "reconciliation_required", "reserved"],
      ],
    );
    assertEquals(
      settleCalls().map((p) => p.p_defer_new),
      [false, false],
    );
    assertEquals(durable.size, 2);

    // The operator freezes the active release (deny new authorizations, NOT
    // withdrawn). The device redelivers the same receipts beside two
    // genuinely new ones: a chargeable rating and an abstention.
    h.rpcs.read_analysis_release_policy = frozenActiveRow();
    const fresh = await ticketEntry(user.sub, claims, grant, TICKET_B, "frozen-new");
    const abstention = await ticketEntry(user.sub, claims, grant, TICKET_B, "frozen-abstain", {
      billingDisposition: "not_chargeable",
      outputOverrides: { resultKind: "low_confidence", overallScore: null },
    });
    const frozen = await drain([settled, held, fresh, abstention], user.token);
    assertEquals(
      frozen.verdicts.map((v) => [v.receiptId, v.verdict, v.code]),
      [
        ["receipt-frozen-settled", "accepted", "result_recorded"],
        ["receipt-frozen-held", "held", "reconciliation_required"],
        ["receipt-frozen-new", "held", "pending"],
        ["receipt-frozen-abstain", "accepted", "result_recorded"],
      ],
    );
    assertEquals(wireRejected(frozen.body), []);
    assertEquals(wireReceipts(frozen.body), [
      {
        receiptId: "receipt-frozen-settled",
        status: "result_recorded",
        reasonCode: null,
        financialDisposition: "consumed",
        resultId: settled.receipt.resultId,
        delivery: "replayed",
      },
      {
        receiptId: "receipt-frozen-held",
        status: "reconciliation_required",
        reasonCode: "evidence_ambiguous",
        financialDisposition: "reserved",
        resultId: null,
        delivery: "replayed",
      },
      {
        receiptId: "receipt-frozen-new",
        status: "pending",
        reasonCode: null,
        financialDisposition: "reserved",
        resultId: null,
        delivery: "pending",
      },
      {
        receiptId: "receipt-frozen-abstain",
        status: "result_recorded",
        reasonCode: null,
        financialDisposition: "reserved",
        resultId: abstention.receipt.resultId,
        delivery: "settled",
      },
    ]);
    // Every one of them reached the RPC with the freeze — the RPC, under the
    // owner lock, decided replay / hold / defer / record; nothing was decided
    // in the edge before the call.
    const frozenCalls = settleCalls().slice(2);
    assertEquals(frozenCalls.length, 4);
    assertEquals(
      frozenCalls.map((p) => [p.p_receipt.receiptId, p.p_defer_new, p.p_hold_reason]),
      [
        ["receipt-frozen-settled", true, null],
        ["receipt-frozen-held", true, "evidence_ambiguous"],
        ["receipt-frozen-new", true, null],
        ["receipt-frozen-abstain", true, null],
      ],
    );
    assertEquals(durable.size, 3, "the deferred receipt wrote nothing durable");
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);

    // A DIFFERENT receipt reusing the settled id, still under the freeze, is
    // refused as a conflict — never pending, never a second settlement.
    const forged: Entry = {
      ...settled,
      receipt: { ...settled.receipt, resultId: crypto.randomUUID() },
    };
    const conflict = await drain([forged], user.token);
    assertEquals(conflict.verdicts, [
      { receiptId: "receipt-frozen-settled", verdict: "refused", code: "offline.receipt_conflict" },
    ]);
    assertEquals(wireReceipts(conflict.body), []);
    assertEquals(
      wireRejected(conflict.body).map((r) => r.code),
      ["offline.receipt_conflict"],
    );
    assertEquals(durable.size, 3);

    // The freeze lifts: the identical deferred receipt settles under the same
    // operation id — nothing was retried under a new one.
    h.rpcs.read_analysis_release_policy = releasePolicyRow;
    const lifted = await drain([fresh], user.token);
    assertEquals(lifted.verdicts, [
      { receiptId: "receipt-frozen-new", verdict: "accepted", code: "result_recorded" },
    ]);
    assertEquals(wireReceipts(lifted.body)[0].delivery, "settled");
    assertEquals(wireReceipts(lifted.body)[0].financialDisposition, "consumed");
    const last = settleCalls().at(-1);
    assert(last);
    assertEquals(last.p_defer_new, false);
    assertEquals(last.p_receipt.operationId, "operation-frozen-new");
    assertEquals(durable.size, 4);
  },
);

// ---------------------------------------------------------------------------
// Live postgres half — the REAL settle_offline_receipt(…, p_defer_new) with
// every migration applied.
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0406-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0406-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-04-r6-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-r6-${n}-${RUN}', '${U(n)}', '{"sub":"w04-04-r6-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

function inTx<T>(sql: Sql, n: number, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (raw) => {
    const tx = raw as unknown as Tx;
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
    return await fn(tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

async function settle(
  tx: Tx,
  rec: OfflineDeviceReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
  deferNew: boolean | null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(out)},
       ${hold === null ? "null::text" : `'${hold}'`}${
         deferNew === null ? "" : `,\n       ${deferNew ? "true" : "false"}`
       }
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

async function settlements(sql: Sql, n: number): Promise<[string, string][]> {
  const rows = await sql.unsafe<{ receipt_id: string; status: string }[]>(
    `select receipt_id, status from public.offline_receipt_settlements
     where user_id = '${U(n)}' order by id`,
  );
  return rows.map((r) => [r.receipt_id, r.status]);
}

async function issueLiveGrant(
  sql: Sql,
  n: number,
  key: string,
): Promise<{ claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant }> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
  const row = await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ row: unknown }[]>(
      `select to_jsonb(g) as row from public.issue_offline_grant('${key}', 2) g`,
    );
    return rows[0].row;
  });
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId: U(n),
    installationKeyId: key,
    release: RELEASE,
  });
  assert(claims.allocation && claims.allocation.ticketIds.length === 2, JSON.stringify(row));
  return { claims, grant: await sign(claims) };
}

Deno.test({
  name: "live DB: settle_offline_receipt(p_defer_new) defers only a genuinely new chargeable receipt (nothing durable, ticket allocated) and, under the freeze, still replays a settled or held receipt, refuses a same-id forgery and holds a terminal ticket — the four-argument call still resolves",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const { claims, grant } = await issueLiveGrant(sql, 1, `freeze-${RUN}`);
      assert(claims.allocation);
      const [ticketA, ticketB] = claims.allocation.ticketIds;
      const a = await ticketEntry(U(1), claims, grant, ticketA, `a-${RUN}`);

      // New chargeable receipt under the freeze: pending, nothing durable,
      // the ticket stays allocated (never released, never consumed).
      const deferred = await inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null, true));
      assertEquals(deferred, {
        result: "accepted",
        delivery: "pending",
        status: "pending",
        reason_code: null,
        financial_disposition: "reserved",
        result_id: null,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlements(sql, 1), []);

      // The freeze lifts: the identical receipt settles once (the four-argument
      // call is the pre-freeze signature, defaulting p_defer_new to false).
      const settled = await inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null, null));
      assertEquals(settled, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "consumed",
        result_id: a.receipt.resultId,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);

      // Frozen again: the settled receipt replays its durable verdict …
      const replayed = await inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null, true));
      assertEquals(replayed, { ...settled, delivery: "replayed" });
      // … a forgery reusing its id is a conflict, not pending …
      const forged = { ...a.receipt, resultId: crypto.randomUUID() };
      const conflict = await inTx(sql, 1, (tx) => settle(tx, forged, a.output, null, true));
      assertEquals([conflict.result, conflict.delivery], ["offline.receipt_conflict", null]);
      // … an edge-derived hold is recorded durably despite the freeze and
      // replays under it …
      const b = await ticketEntry(U(1), claims, grant, ticketB, `b-${RUN}`);
      const held = await inTx(sql, 1, (tx) =>
        settle(tx, b.receipt, b.output, "evidence_ambiguous", true),
      );
      assertEquals(held, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "evidence_ambiguous",
        financial_disposition: "reserved",
        result_id: null,
      });
      const heldAgain = await inTx(sql, 1, (tx) => settle(tx, b.receipt, b.output, null, true));
      assertEquals(heldAgain, { ...held, delivery: "replayed" });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      // … and a not_chargeable receipt for the CONSUMED ticket A is a durable
      // conflicting_receipt hold, freeze or not.
      const terminal = await ticketEntry(U(1), claims, grant, ticketA, `terminal-${RUN}`, {
        billingDisposition: "not_chargeable",
        outputOverrides: { resultKind: "low_confidence", overallScore: null },
      });
      const heldTerminal = await inTx(sql, 1, (tx) =>
        settle(tx, terminal.receipt, terminal.output, null, true),
      );
      assertEquals(heldTerminal, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "conflicting_receipt",
        financial_disposition: "reserved",
        result_id: null,
      });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await settlements(sql, 1), [
        [a.receipt.receiptId, "result_recorded"],
        [b.receipt.receiptId, "reconciliation_required"],
        [terminal.receipt.receiptId, "reconciliation_required"],
      ]);

      // A null freeze flag is malformed input, never a verdict.
      const nullFlag = await sql.begin(async (raw) => {
        const tx = raw as unknown as Tx;
        await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
          'x-pickle-api-key', public.get_api_request_key())::text, true)`);
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${U(1)}'`);
        await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(1)}"}'`);
        const rows = await tx.unsafe<SettleRow[]>(
          `select r.result, r.delivery from public.settle_offline_receipt(
             ${lit(b.receipt)}, '${await digestCanonicalOfflineJson(b.receipt)}',
             null::jsonb, null::text, null::boolean) r`,
        );
        return rows[0];
      });
      assertEquals([nullFlag.result, nullFlag.delivery], ["offline.invalid_input", null]);
    } finally {
      await sql.end();
    }
  },
});
