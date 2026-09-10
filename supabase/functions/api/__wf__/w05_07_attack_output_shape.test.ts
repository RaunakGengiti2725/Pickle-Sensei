// W05-07 ADVERSARY — what the server does with the output the candidate's
// receipt drain actually sends.
//
// apps/mobile (candidate 1e35b5fc) presents `output` as the persisted
// ShotAnalysis record verbatim (`capturedAtIso`, `analysisConfidence`,
// `handedness`, `measurements`, `guidance`, `priorityFix`, ...) and binds the
// receipt's fullOutputSha256 to that object. The route admits `output` under
// the sync ingress rules (parseSyncShot: `capturedAt`, `confidence`, ...), so
// the digest verifies but the shape is refused and the receipt is HELD as
// evidence_ambiguous — durably, ticket reserved — on every court-offline read.
//
// The frozen 1.0 shape of the SAME shot (toSyncPayload minus analysisPermitId)
// settles as result_recorded. Both halves run the REAL edge handler through
// routesHarness with a durable settle_offline_receipt() stand-in.

import { assert, assertEquals } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  type OfflineDeviceReceipt,
  type OfflineExecutionGrantClaims,
  type OfflineReleasedArtifacts,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
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
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w05-07-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w05-07";
const GRANT_ID = "64444444-4444-4444-8444-000000000507";
const TICKET_A = "65555555-5555-4555-8555-000000000571";
const TICKET_B = "65555555-5555-4555-8555-000000000572";
const RESULT_ID = "70000507-0507-4000-8000-000000000001";
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
const signingKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: keyPair.privateKey,
};
await importOfflineGrantVerificationKey(KID, await exportJWK(keyPair.publicKey));

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  return {
    sub: `aaaaaaaa-0507-4000-8000-${String(userSeq).padStart(12, "0")}`,
    token: fakeGoogleIdToken(`aaaaaaaa-0507-4000-8000-${String(userSeq).padStart(12, "0")}`),
  };
}

function freeClaims(ownerId: string): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: GRANT_ID,
      generation: 1,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 6 * DAY),
      entitlement_expires_at: null,
      ticket_ids: [TICKET_A, TICKET_B],
    },
    { issuer: ISSUER, ownerId, installationKeyId: INSTALLATION_KEY, release: RELEASE },
  );
}

async function sign(claims: OfflineExecutionGrantClaims): Promise<OfflineSignedExecutionGrant> {
  return await signOfflineExecutionGrant(claims, signingKey, {
    binding: {
      issuer: ISSUER,
      allowedKeyIds: [KID],
      ownerId: claims.sub,
      installationKeyId: claims.installationKeyId,
    },
    release: RELEASE,
    nowEpochSeconds: claims.iat + 1,
  });
}

const VERSION_VECTOR = {
  appVersion: "0.1.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

const CHECKPOINT = {
  key: "paddle_height",
  score: 70,
  confidence: 0.8,
  band: "green",
  direction: "up",
  severity: 0.1,
  applicable: true,
};
const PHASE = { key: "prep", startMs: 0, representativeMs: 50, endMs: 100, confidence: 0.8 };

/** The on-device ShotAnalysis record exactly as apps/mobile persists it in
 * local_shot.payload (packages/shared-types domain.ts ShotAnalysis) and as
 * the candidate's presentedOutput() returns it: readScoredShotPayload minus
 * `analysisPermitId` (which an offline shot never had). */
function mobileRecordOutput(): Record<string, unknown> {
  return {
    id: RESULT_ID,
    sessionId: null,
    shotType: "forehand_drive",
    cameraView: "side",
    handedness: "right",
    capturedAtIso: "2026-09-06T12:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    phases: [PHASE],
    measurements: [
      {
        metricKey: "paddle_height_ratio",
        value: 0.42,
        confidence: 0.8,
        unit: "ratio",
        source: "real",
      },
    ],
    checkpoints: [CHECKPOINT],
    overallScore: 7,
    analysisConfidence: 0.9,
    resultKind: "scored",
    guidance: null,
    priorityFix: null,
    versionVector: VERSION_VECTOR,
    source: "real",
  };
}

/** The same shot in the FROZEN 1.0 wire shape: apps/mobile/src/data/sync.ts
 * toSyncPayload(analysis, permit) without analysisPermitId. */
function frozenOutput(): Record<string, unknown> {
  const record = mobileRecordOutput();
  return {
    id: record.id,
    sessionId: record.sessionId,
    shotType: record.shotType,
    cameraView: record.cameraView,
    capturedAt: record.capturedAtIso,
    timestamps: record.timestamps,
    overallScore: record.overallScore,
    confidence: record.analysisConfidence,
    resultKind: record.resultKind,
    source: record.source,
    phases: record.phases,
    checkpoints: [CHECKPOINT],
    versionVector: record.versionVector,
  };
}

async function deviceReceipt(
  ownerId: string,
  grant: OfflineSignedExecutionGrant,
  claims: OfflineExecutionGrantClaims,
  output: Record<string, unknown>,
  receiptId: string,
): Promise<OfflineDeviceReceipt> {
  assert(claims.allocation, "free grant expected");
  return {
    receiptId,
    ownerId,
    installationKeyId: claims.installationKeyId,
    grantId: claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(grant),
    lifecycleSequence: 1,
    ticket: {
      allocationId: claims.allocation.allocationId,
      generation: claims.allocation.generation,
      ticketId: TICKET_A,
    },
    operationId: "44444444-4444-4444-8444-000000000507",
    resultId: RESULT_ID,
    fullOutputSha256: await digestCanonicalOfflineJson(output),
    billingDisposition: "joint_verification_required",
    queuedAt: "2026-09-08T12:00:00.000Z",
  };
}

interface SettleParams {
  p_receipt: Record<string, unknown>;
  p_receipt_sha256: string;
  p_output: Record<string, unknown> | null;
  p_hold_reason: string | null;
  p_defer_new: boolean;
}

interface SettleRow {
  result: string;
  delivery: string | null;
  status: string | null;
  reason_code: string | null;
  financial_disposition: string | null;
  result_id: string | null;
}

const durable = new Map<string, { sha256: string; row: SettleRow }>();

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

/** settle_offline_receipt() as the migration behaves: a hold reason is a
 * durable HOLD (ticket reserved), otherwise the receipt settles; a redelivery
 * replays the remembered verdict. */
function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  const key = `${call.headers.authorization}|${params.p_receipt.receiptId}`;
  const known = durable.get(key);
  let row: SettleRow;
  if (known) {
    row = { ...known.row, delivery: "replayed" };
  } else if (params.p_hold_reason !== null) {
    row = {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason,
      financial_disposition: "reserved",
      result_id: null,
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  } else {
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition: "consumed",
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

async function post(body: unknown, token: string): Promise<Record<string, unknown>> {
  const response = await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
  const json = (await response.json()) as Record<string, unknown>;
  assertEquals(response.status, 200, JSON.stringify(json));
  return json;
}

function firstReceipt(body: Record<string, unknown>): Record<string, unknown> {
  const receipts = body.receipts as Record<string, unknown>[];
  const rejected = body.rejected as unknown[];
  assertEquals(rejected, [], JSON.stringify(body));
  assertEquals(receipts.length, 1, JSON.stringify(body));
  return receipts[0];
}

Deno.test(
  "the candidate's output (the persisted ShotAnalysis record) passes the digest check but is refused by the sync ingress: HELD evidence_ambiguous, ticket reserved, nothing recorded — on every redelivery",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const output = mobileRecordOutput();
    const receipt = await deviceReceipt(user.sub, grant, claims, output, "receipt-mobile-shape");

    const first = firstReceipt(await post({ receipts: [{ receipt, grant, output }] }, user.token));
    assertEquals(first, {
      receiptId: "receipt-mobile-shape",
      status: "reconciliation_required",
      reasonCode: "evidence_ambiguous",
      financialDisposition: "reserved",
      resultId: null,
      delivery: "held",
    });
    const [settle] = h.callsTo(SETTLE_RPC).map(settleParams);
    assertEquals(settle.p_hold_reason, "evidence_ambiguous");
    assertEquals(settle.p_output, null);
    // The digest itself matched — the receipt travelled bound to exactly the
    // object delivered; only the SHAPE was refused.
    assertEquals(settle.p_receipt.fullOutputSha256, await digestCanonicalOfflineJson(output));

    // The device re-presents the same receipt on the next drain (the app
    // keeps a held receipt pending): the durable HOLD replays — the read is
    // never result_recorded and the ticket stays reserved forever.
    const again = firstReceipt(await post({ receipts: [{ receipt, grant, output }] }, user.token));
    assertEquals(again.delivery, "replayed");
    assertEquals(again.status, "reconciliation_required");
    assertEquals(again.financialDisposition, "reserved");
  },
);

Deno.test(
  "control: the SAME shot in the frozen 1.0 shape (toSyncPayload without analysisPermitId) settles as result_recorded",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const output = frozenOutput();
    const receipt = await deviceReceipt(user.sub, grant, claims, output, "receipt-frozen-shape");

    const settled = firstReceipt(
      await post({ receipts: [{ receipt, grant, output }] }, user.token),
    );
    assertEquals(settled, {
      receiptId: "receipt-frozen-shape",
      status: "result_recorded",
      reasonCode: null,
      financialDisposition: "consumed",
      resultId: RESULT_ID,
      delivery: "settled",
    });
    const [settle] = h.callsTo(SETTLE_RPC).map(settleParams);
    assertEquals(settle.p_hold_reason, null);
    assert(settle.p_output !== null);
    assertEquals(settle.p_output.capturedAt, "2026-09-06T12:00:00.000Z");
    assertEquals(settle.p_output.confidence, 0.9);
  },
);
