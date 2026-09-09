// ADVERSARIAL TESTS — W04-04 candidate b214adf57f90d6a43de0b344c1ece775f8aee467
// (POST /v1/offline/receipts + settle_offline_receipt()).
//
// Every test asserts the behaviour the work package and the product
// invariants REQUIRE; a failing test is a confirmed break of the candidate,
// a passing test is an attack that did not break anything. Nothing here
// touches the candidate's own tests or production code.
//
// Attack categories (each is at least one Deno.test below):
//   A1 authority state    — the ACTIVE release policy withdrawn/expired blocks
//                           replay + other-lineage receipts with a false
//                           "No rating was counted" 409
//   A2 corrupt state      — a tampered lineage row becomes a DURABLE hold
//   A3 clock / rotation   — a routine signing-key rotation retroactively
//                           holds every delayed receipt of an already-expired
//                           old-key grant (verification instant vs window)
//   A4 boundary values    — 0 / -1 / 1.5 / string / 2^53 / 129-char ids /
//                           null entries / 25 malformed entries / far-future
//                           and far-past grants
//   A5 replay identities  — same receipt id + other digest inside ONE batch,
//                           tampered output in a duplicate, batch of 25 copies
//   A6 network + restart  — lineage 429 (Retry-After) / redirect / 502,
//                           settle 429 / 302, crash mid-batch then redelivery
//   A7 pending / restart  — pending never becomes durable, batch mixes settle
//                           with pending, redelivery after the session lands
//   L1 live: duplicate identities across tickets (result id reuse)
//   L2 live: concurrency — N parallel settlements, settle ‖ release, two
//            receipts for one ticket racing
//   L3 live: roles — anon / no session / no API key / service_role /
//            other user / direct table write / lineage RPC grants
//   L4 live: free-rating conservation — not_chargeable scored output,
//            evidence_missing hold then full evidence, held ticket count
//   L5 live: account deletion + re-creation — original receipt as the new
//            account, identity-lifetime capacity stays 2
//   L6 live: SQL boundaries — string sequence, 2^53 generation, unknown
//            hold reason, malformed sha
//
// Without XC_PG_URL the live half is `ignore`d — an ignored run is NOT a
// pass (run with the disposable postgres from ./xc_pg_up.sh).

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
  type OfflineReleasedArtifacts,
  type OfflineResultReceipt,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import {
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
  digestOfflineGrantTransport,
} from "../canonicalDigest.ts";
import {
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
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-active";
const OLD_KID = "w04-04-attack-old";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-4444444444a1";
const TICKET_A = "65555555-5555-4555-8555-5555555555a1";
const TICKET_B = "65555555-5555-4555-8555-5555555555a2";
const DAY = 86_400;
const GRACE = 15 * 60;

const activePair = await generateKeyPair("ES256", { extractable: true });
const oldPair = await generateKeyPair("ES256", { extractable: true });
const activePrivateJwk = { ...(await exportJWK(activePair.privateKey)), kid: KID };
const oldPrivateJwk = { ...(await exportJWK(oldPair.privateKey)), kid: OLD_KID };
const oldPublicJwk = { ...(await exportJWK(oldPair.publicKey)), kid: OLD_KID };
const activeKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: activePair.privateKey,
};
const oldKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: OLD_KID,
  key: oldPair.privateKey,
};

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

const nowSeconds = (): number => Math.floor(Date.now() / 1000);
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

/** The authority after a rotation to a second approved policy (the first
 * stays installed, never withdrawn). */
async function rotatedReleasePolicyRow(): Promise<Record<string, unknown>> {
  const artifact = { version: "attack-2", sha256: "e".repeat(64) };
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
  const issuedAt = nowSeconds() - 3_600;
  const document: AnalysisReleasePolicyDocument = {
    ...HARNESS_RELEASE_POLICY,
    version: "attack-policy-2",
    validFrom: issuedAt,
    validUntil: issuedAt + 365 * DAY,
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

const UNKNOWN_LINEAGE_ROW = {
  document: null,
  canonicalDocument: null,
  denyNewAuthorizations: true,
  approval: null,
};

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

let userSeq = 0;
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0404-4000-8000-a${String(userSeq).padStart(11, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

interface ClaimOptions {
  grantId?: string;
  tickets?: string[];
  installationKeyId?: string;
  issuedAt?: number;
  generation?: number;
  release?: OfflineReleasedArtifacts;
}

function freeClaims(ownerId: string, options: ClaimOptions = {}): OfflineExecutionGrantClaims {
  const issuedAt = options.issuedAt ?? nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: options.grantId ?? GRANT_ID,
      generation: options.generation ?? 3,
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
      release: options.release ?? RELEASE,
    },
  );
}

async function sign(
  claims: OfflineExecutionGrantClaims,
  key: OfflineGrantKey = activeKey,
  release: OfflineReleasedArtifacts = RELEASE,
): Promise<OfflineSignedExecutionGrant> {
  return await signOfflineExecutionGrant(claims, key, {
    binding: {
      issuer: ISSUER,
      allowedKeyIds: [key.kid],
      ownerId: claims.sub,
      installationKeyId: claims.installationKeyId,
    },
    release,
    nowEpochSeconds: claims.iat + 1,
  });
}

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
  billingDisposition?: OfflineResultReceipt["billingDisposition"];
  installationKeyId?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    ticket: options.ticket,
    lifecycleSequence: options.lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04-attack",
      elapsedMs: 120_000 * options.lifecycleSequence,
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "QUJDRA",
      clientDataSha256: "c".repeat(64),
    },
    operationId: options.operationId,
    resultId: options.resultId,
    fullOutputSha256: options.fullOutputSha256,
    billingDisposition: options.billingDisposition ?? "joint_verification_required",
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

interface Fixture {
  claims: OfflineExecutionGrantClaims;
  grant: OfflineSignedExecutionGrant;
  receipt: OfflineResultReceipt;
  output: Record<string, unknown>;
}

async function fixture(
  ownerId: string,
  ticketId: string,
  tag: string,
  options: {
    key?: OfflineGrantKey;
    claims?: OfflineExecutionGrantClaims;
    release?: OfflineReleasedArtifacts;
    billingDisposition?: OfflineResultReceipt["billingDisposition"];
    outputOverrides?: Record<string, unknown>;
  } = {},
): Promise<Fixture> {
  const release = options.release ?? RELEASE;
  const claims = options.claims ?? freeClaims(ownerId, { release });
  const grant = await sign(claims, options.key, release);
  const resultId = crypto.randomUUID();
  const out = output(resultId, options.outputOverrides);
  const rec = await receipt({
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
  });
  return { claims, grant, receipt: rec, output: out };
}

const entryOf = (f: Fixture): Record<string, unknown> => ({
  receipt: f.receipt,
  grant: f.grant,
  output: f.output,
});

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the candidate's harness half: keyed
// by caller bearer + receipt id, replay on same digest, conflict on another).
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
}

const durable = new Map<string, { sha256: string; row: SettleRow }>();
const syncedSessions = new Set<string>();
let settleFailures: Array<() => Response | null> = [];

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function jsonRows(row: SettleRow): Response {
  return new Response(JSON.stringify([row]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const injected = settleFailures.shift();
  if (injected) {
    const failure = injected();
    if (failure) return failure;
  }
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
  } else if (params.p_hold_reason !== null) {
    row = {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason,
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "reserved",
      result_id: null,
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  } else if (
    params.p_receipt.ticket !== null &&
    params.p_output !== null &&
    typeof params.p_output.sessionId === "string" &&
    !syncedSessions.has(params.p_output.sessionId)
  ) {
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
  return jsonRows(row);
}

function lineageRespond(
  known: Record<string, Record<string, unknown>>,
  lineageFailure: (() => Response | null) | null = null,
): (call: RecordedCall) => Response | null {
  return (call) => {
    if (!call.url.endsWith(LINEAGE_RPC)) return durableRespond(call);
    if (lineageFailure) {
      const failure = lineageFailure();
      if (failure) return failure;
    }
    const body = call.body as { p_policy_sha256: string };
    const row = known[body.p_policy_sha256] ?? UNKNOWN_LINEAGE_ROW;
    return new Response(JSON.stringify(row), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

function reset(ring: unknown = activePrivateJwk): void {
  h.reset();
  durable.clear();
  syncedSessions.clear();
  settleFailures = [];
  Deno.env.set(SIGNING_ENV, JSON.stringify(ring));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

interface RouteResult {
  receiptId: string | null;
  delivery: "settled" | "replayed" | "held" | "pending" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  const body = (await response.json()) as Record<string, unknown>;
  assertEquals(response.status, 200, JSON.stringify(body));
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

const callerBearer = (sub: string): string => `Bearer session-for-${sub}`;

// ===========================================================================
// A1 — authority state: the ACTIVE release policy withdrawn (no successor)
// ===========================================================================

Deno.test(
  "ATTACK A1: withdrawing the ACTIVE release must not turn a replay of an already-consumed receipt into a 409 'No rating was counted'",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, "a1-replay");
    const first = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(first[0].delivery, "settled");
    assertEquals(first[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(durable.size, 1);

    // The operator withdraws the active release; the device redelivers the
    // very same batch (its outbox never got the first answer).
    h.rpcs.read_analysis_release_policy = withdrawnActiveRow();
    const redelivered = await post({ receipts: [entryOf(f)] }, user.token);
    const body = (await redelivered.json()) as Record<string, unknown>;
    assertEquals(
      redelivered.status,
      200,
      `a consumed receipt must replay its verdict, got ${redelivered.status} ${JSON.stringify(body)}`,
    );
    const out = body.results as RouteResult[];
    assertEquals(out[0].delivery, "replayed");
    assertEquals(out[0].reconciliation?.financialDisposition, "consumed");
  },
);

Deno.test(
  "ATTACK A1b: withdrawing the ACTIVE release must not block a receipt whose grant names a different, still-approved lineage",
  async () => {
    reset();
    const user = freshUser();
    // Grant issued under the FIRST policy (RELEASE); by the time the receipt
    // arrives a second policy was active and then withdrawn. The first
    // lineage is still installed and approved.
    const f = await fixture(user.sub, TICKET_A, "a1b-lineage");
    const rotated = await rotatedReleasePolicyRow();
    const rotatedApproval = rotated.approval as Record<string, unknown>;
    h.rpcs.read_analysis_release_policy = {
      ...rotated,
      denyNewAuthorizations: true,
      approval: { ...rotatedApproval, withdrawnAt: nowSeconds() - 30, denyNewAuthorizations: true },
    };
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow });
    const response = await post({ receipts: [entryOf(f)] }, user.token);
    const body = (await response.json()) as Record<string, unknown>;
    assertEquals(
      response.status,
      200,
      `expected a per-receipt verdict from the named lineage, got ${response.status} ${JSON.stringify(body)}`,
    );
    const out = body.results as RouteResult[];
    assertEquals(out[0].delivery, "settled");
  },
);

Deno.test(
  "ATTACK A1c: with no chargeable active release, a not_chargeable abstention receipt (nothing to charge) must still be recorded, and a chargeable receipt must HOLD (grant_revoked/ambiguous) rather than be refused with 'No rating was counted' as a settled answer",
  async () => {
    reset();
    const user = freshUser();
    const abstention = await fixture(user.sub, TICKET_A, "a1c-abstain", {
      billingDisposition: "not_chargeable",
      outputOverrides: { resultKind: "low_confidence", overallScore: null },
    });
    h.rpcs.read_analysis_release_policy = withdrawnActiveRow();
    const response = await post({ receipts: [entryOf(abstention)] }, user.token);
    const body = (await response.json()) as Record<string, unknown>;
    assertEquals(
      response.status,
      200,
      `an abstention has nothing to charge and must be recorded, got ${response.status} ${JSON.stringify(body)}`,
    );
    const out = body.results as RouteResult[];
    assertEquals(out[0].delivery, "settled");
    assertEquals(out[0].reconciliation?.financialDisposition, "reserved");
  },
);

// ===========================================================================
// A2 — corrupt persisted state: a lineage row that fails integrity
// ===========================================================================

Deno.test(
  "ATTACK A2: a lineage row that fails integrity (tampered canonical document) is a server-side fault — it must not become a DURABLE evidence_ambiguous hold that the corrected row can never undo",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, "a2-corrupt");
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    const corrupt = {
      ...releasePolicyRow,
      canonicalDocument: `${String(releasePolicyRow.canonicalDocument)} `,
    };
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: corrupt });
    const { result: first } = await captureConsole(() =>
      post({ receipts: [entryOf(f)] }, user.token),
    );
    const firstBody = (await first.json()) as Record<string, unknown>;
    const firstResults = Array.isArray(firstBody.results)
      ? (firstBody.results as RouteResult[])
      : [];
    // Either answer is acceptable here: a 503 that decides nothing, or a
    // per-receipt answer that is not durable. What is NOT acceptable is a
    // durable hold recorded from a row the server itself could not verify.
    const durableHold = [...durable.values()].some(
      (v) => v.row.delivery === "held" && v.row.reason_code === "evidence_ambiguous",
    );
    assertEquals(
      durableHold,
      false,
      `a corrupt authority row was recorded as a durable hold: ${first.status} ${JSON.stringify(firstResults)}`,
    );

    // Operator repairs the row; the identical redelivery must settle.
    h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow });
    const repaired = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(repaired[0].delivery, "settled");
  },
);

// ===========================================================================
// A3 — clocks and signing-key rotation
// ===========================================================================

function ring(previous: { retiredAt: number; overlapEndsAt: number } | null): unknown {
  return {
    schemaVersion: 1,
    active: activePrivateJwk,
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
  "ATTACK A3: a routine key rotation (previous key kept for the full overlap) must not HOLD the delayed receipt of an old-key grant that expired before the rotation",
  async () => {
    const now = nowSeconds();
    // Grant signed by the OLD key 10 days ago, expired 3 days ago; the device
    // consumed offline and only now comes online — the documented W04-04 case.
    const user = freshUser();
    const owned = freeClaims(user.sub, { issuedAt: now - 10 * DAY });
    assert(owned.exp < now - GRACE, "fixture: the grant expired well before the rotation");
    const f = await fixture(user.sub, TICKET_A, "a3-old-key", { key: oldKey, claims: owned });

    // Control: before the rotation (old key active) the receipt settles.
    reset(oldPrivateJwk);
    const before = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(before[0].delivery, "settled", "control: the grant itself is valid");

    // Rotation 1 day ago, previous key retained for the maximal 7-day overlap.
    reset(ring({ retiredAt: now - DAY, overlapEndsAt: now - DAY + 7 * DAY }));
    const after = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(
      after[0].delivery,
      "settled",
      `old-key grant inside the overlap window was ${after[0].delivery}: ${JSON.stringify(after[0].reconciliation)}`,
    );
    assertEquals(settleCalls()[0].p_hold_reason, null);
  },
);

Deno.test(
  "ATTACK A3b: an old-key grant still inside its lease settles during the overlap (the rotation is honoured for live grants) — pins the asymmetry with A3",
  async () => {
    const now = nowSeconds();
    const user = freshUser();
    const live = freeClaims(user.sub, { issuedAt: now - 2 * DAY });
    const f = await fixture(user.sub, TICKET_A, "a3b-live", { key: oldKey, claims: live });
    reset(ring({ retiredAt: now - DAY, overlapEndsAt: now - DAY + 7 * DAY }));
    const out = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(out[0].delivery, "settled");
  },
);

Deno.test(
  "ATTACK A3c: a grant signed inside the propagation grace after retirement (allowed by the ring) must not be HELD once its receipt is delayed past overlapEndsAt",
  async () => {
    const now = nowSeconds();
    const user = freshUser();
    const retiredAt = now - 8 * DAY;
    const overlapEndsAt = retiredAt + 7 * DAY; // the maximal window
    // Signed 5 minutes AFTER retirement (inside the 15-minute grace the ring
    // explicitly honours), expired 1 day + 5 minutes ago, delivered today.
    const claims = freeClaims(user.sub, { issuedAt: retiredAt + 5 * 60 });
    assert(
      claims.exp - 1 >= overlapEndsAt,
      "the lease outlives the overlap by design of the fixture",
    );
    const f = await fixture(user.sub, TICKET_A, "a3c-grace", { key: oldKey, claims });
    reset(ring({ retiredAt, overlapEndsAt }));
    const out = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(
      out[0].delivery,
      "settled",
      `grace-window grant was ${out[0].delivery}: ${JSON.stringify(out[0].reconciliation)}`,
    );
  },
);

Deno.test(
  "ATTACK A3d: once the ring drops the previous key, an old-key receipt is a durable evidence_ambiguous hold that restoring the key can never settle (documents the one-previous-key limit)",
  async () => {
    const now = nowSeconds();
    const user = freshUser();
    const claims = freeClaims(user.sub, { issuedAt: now - 2 * DAY });
    const f = await fixture(user.sub, TICKET_A, "a3d-dropped", { key: oldKey, claims });
    reset(ring(null));
    const dropped = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(dropped[0].delivery, "held");
    assertEquals(dropped[0].reconciliation?.reasonCode, "evidence_ambiguous");
    // Operator restores the previous key (still inside a valid window).
    Deno.env.set(
      SIGNING_ENV,
      JSON.stringify(ring({ retiredAt: now - DAY, overlapEndsAt: now - DAY + 7 * DAY })),
    );
    const restored = await results(await post({ receipts: [entryOf(f)] }, user.token));
    // Expected by the invariants: an ambiguous receipt HOLDS (never refunds,
    // never re-runs) — so the replayed hold is the contract. We pin it and
    // pin that nothing was consumed.
    assertEquals(restored[0].delivery, "replayed");
    assertEquals(restored[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      0,
    );
  },
);

Deno.test(
  "ATTACK A3e: far-future (not yet valid) and far-past grants; clock rollback on the caller",
  async () => {
    reset();
    const user = freshUser();
    const now = nowSeconds();
    // Grant issued 1 day in the future (server clock rolled back / device clock
    // ahead): not yet valid at the verification instant → HOLD, never settle.
    const future = freeClaims(user.sub, { issuedAt: now + DAY });
    const f1 = await fixture(user.sub, TICKET_A, "a3e-future", { claims: future });
    const out1 = await results(await post({ receipts: [entryOf(f1)] }, user.token));
    assertEquals(out1[0].delivery, "held");
    assertEquals(out1[0].reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(out1[0].reconciliation?.financialDisposition, "reserved");

    // Grant that expired 400 days ago: the route verifies as of exp-1 by design;
    // it must settle (delayed reconciliation) and must not be settled twice.
    const ancient = freeClaims(user.sub, { issuedAt: now - 407 * DAY });
    const f2 = await fixture(user.sub, TICKET_B, "a3e-ancient", { claims: ancient });
    const out2 = await results(await post({ receipts: [entryOf(f2)] }, user.token));
    assertEquals(out2[0].delivery, "settled");
    const again = await results(await post({ receipts: [entryOf(f2)] }, user.token));
    assertEquals(again[0].delivery, "replayed");
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      1,
    );
  },
);

// ===========================================================================
// A4 — boundary values at the route
// ===========================================================================

Deno.test(
  "ATTACK A4: lifecycleSequence / generation / id boundaries never reach the database and never decide anything",
  async () => {
    reset();
    const user = freshUser();
    const base = await fixture(user.sub, TICKET_A, "a4-base");
    const variants: Array<[string, Record<string, unknown>]> = [
      ["sequence 0", { ...base.receipt, lifecycleSequence: 0 }],
      ["sequence -1", { ...base.receipt, lifecycleSequence: -1 }],
      ["sequence 1.5", { ...base.receipt, lifecycleSequence: 1.5 }],
      ["sequence string", { ...base.receipt, lifecycleSequence: "1" }],
      ["sequence 2^53", { ...base.receipt, lifecycleSequence: 2 ** 53 }],
      ["sequence null", { ...base.receipt, lifecycleSequence: null }],
      [
        "generation 0",
        { ...base.receipt, ticket: { ...(base.receipt.ticket as object), generation: 0 } },
      ],
      [
        "generation 2^53",
        { ...base.receipt, ticket: { ...(base.receipt.ticket as object), generation: 2 ** 53 } },
      ],
      ["receiptId 129 chars", { ...base.receipt, receiptId: "r".repeat(129) }],
      ["receiptId empty", { ...base.receipt, receiptId: "" }],
      ["receiptId with space", { ...base.receipt, receiptId: "receipt 1" }],
      ["ownerId not uuid", { ...base.receipt, ownerId: "not-a-uuid" }],
      [
        "sha uppercase",
        { ...base.receipt, fullOutputSha256: base.receipt.fullOutputSha256.toUpperCase() },
      ],
      ["sha 63 chars", { ...base.receipt, fullOutputSha256: "a".repeat(63) }],
      ["extra field", { ...base.receipt, extra: true }],
      ["billing other", { ...base.receipt, billingDisposition: "consumed" }],
    ];
    const entries = variants.map(([, rec]) => ({
      receipt: rec,
      grant: base.grant,
      output: base.output,
    }));
    assert(entries.length <= 25);
    const out = await results(await post({ receipts: entries }, user.token));
    assertEquals(out.length, variants.length);
    for (const [index, [label]] of variants.entries()) {
      assertEquals(out[index].delivery, "rejected", `${label} must be rejected`);
      assertEquals(out[index].reconciliation, null, label);
      assert(out[index].error, label);
    }
    assertEquals(settleCalls().length, 0, "no malformed receipt reached the database");
    assertEquals(durable.size, 0);

    // A 128-char receipt id is the documented maximum and is legal.
    const maxId = { ...base.receipt, receiptId: "r".repeat(128) };
    const ok = await results(
      await post(
        { receipts: [{ receipt: maxId, grant: base.grant, output: base.output }] },
        user.token,
      ),
    );
    assertEquals(ok[0].delivery, "settled");
    assertEquals(ok[0].receiptId, "r".repeat(128));
  },
);

Deno.test(
  "ATTACK A4b: null / primitive / empty entries, a batch of 25 rejects, and a 26th entry: nothing settles, per-entry order is kept",
  async () => {
    reset();
    const user = freshUser();
    const base = await fixture(user.sub, TICKET_A, "a4b");
    const junk: unknown[] = [
      null,
      1,
      "receipt",
      [],
      {},
      { receipt: null, grant: null, output: null },
    ];
    const out = await results(await post({ receipts: junk }, user.token));
    assertEquals(out.length, junk.length);
    for (const r of out) {
      assertEquals(r.delivery, "rejected");
      assertEquals(r.receiptId, null);
    }
    assertEquals(settleCalls().length, 0);

    const twentyFive = Array.from({ length: 25 }, () => ({}));
    const all = await results(await post({ receipts: twentyFive }, user.token));
    assertEquals(all.length, 25);
    assertEquals(
      all.every((r) => r.delivery === "rejected"),
      true,
    );
    assertEquals(settleCalls().length, 0);

    const twentySix = [...twentyFive, entryOf(base)];
    const tooMany = await post({ receipts: twentySix }, user.token);
    assertEquals(tooMany.status, 400);
    await tooMany.body?.cancel();
    assertEquals(settleCalls().length, 0, "an oversize batch decides nothing");

    const notArray = await post({ receipts: { receipt: 1 } }, user.token);
    assertEquals(notArray.status, 400);
    await notArray.body?.cancel();
    const empty = await post({ receipts: [] }, user.token);
    assertEquals(empty.status, 400);
    await empty.body?.cancel();
    const noBody = await post({}, user.token);
    assertEquals(noBody.status, 400);
    await noBody.body?.cancel();
    assertEquals(durable.size, 0);
  },
);

Deno.test(
  "ATTACK A4c: output boundaries — output as array/string/number, tampered output, output naming another result, oversized body",
  async () => {
    reset();
    const user = freshUser();
    const base = await fixture(user.sub, TICKET_A, "a4c");
    const shaped = await results(
      await post(
        {
          receipts: [
            { receipt: base.receipt, grant: base.grant, output: [] },
            { receipt: base.receipt, grant: base.grant, output: "x" },
            { receipt: base.receipt, grant: base.grant, output: 7 },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      shaped.map((r) => r.delivery),
      ["rejected", "rejected", "rejected"],
    );
    assertEquals(settleCalls().length, 0);

    // Tampered output (score changed): digest mismatch → HOLD, reserved.
    const tampered = { ...base.output, overallScore: 10 };
    const other = { ...base.output, id: crypto.randomUUID() };
    const held = await results(
      await post(
        {
          receipts: [
            { receipt: base.receipt, grant: base.grant, output: tampered },
            {
              receipt: { ...base.receipt, receiptId: "a4c-other" },
              grant: base.grant,
              output: other,
            },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      held.map((r) => [r.delivery, r.reconciliation?.reasonCode]),
      [
        ["held", "evidence_ambiguous"],
        ["held", "evidence_ambiguous"],
      ],
    );
    assertEquals(
      held.every((r) => r.reconciliation?.financialDisposition === "reserved"),
      true,
    );

    // Body above 2,000,000 bytes: refused before any verdict.
    const big = {
      receipt: base.receipt,
      grant: base.grant,
      output: { ...base.output, pad: "p".repeat(2_000_001) },
    };
    const oversize = await post({ receipts: [big] }, user.token);
    assert(oversize.status === 400 || oversize.status === 413, `got ${oversize.status}`);
    await oversize.body?.cancel();
    assertEquals(settleCalls().length, 2, "no further settlement attempted");
  },
);

// ===========================================================================
// A5 — replay / duplicate identities inside one batch
// ===========================================================================

Deno.test(
  "ATTACK A5: same receipt id with another digest inside ONE batch settles once and rejects the other; 25 copies of one receipt settle once",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, "a5");
    // Same receipt id, same evidence, but a different operation id: a distinct
    // receipt body (other digest) that is itself well-formed and settleable.
    const forged = { ...f.receipt, operationId: "operation-a5-other" };
    const out = await results(
      await post(
        {
          receipts: [
            { receipt: forged, grant: f.grant, output: f.output },
            entryOf(f),
            { receipt: forged, grant: f.grant, output: f.output },
          ],
        },
        user.token,
      ),
    );
    // Whichever body arrives first owns the id; the other is a conflict, never
    // a second settlement; the third (same as first) replays.
    assertEquals(out[0].delivery, "settled");
    assertEquals(out[1].delivery, "rejected");
    assertEquals(out[1].error?.code, "offline.receipt_conflict");
    assertEquals(out[2].delivery, "replayed");
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      1,
    );

    reset();
    const g = await fixture(user.sub, TICKET_B, "a5-copies");
    const copies = Array.from({ length: 25 }, () => entryOf(g));
    const many = await results(await post({ receipts: copies }, user.token));
    assertEquals(many[0].delivery, "settled");
    assertEquals(
      many.slice(1).every((r) => r.delivery === "replayed"),
      true,
    );
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      1,
    );
  },
);

Deno.test(
  "ATTACK A5b: a duplicate carrying a tampered OUTPUT (same receipt digest) must not overwrite the recorded verdict",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, "a5b");
    const first = await results(await post({ receipts: [entryOf(f)] }, user.token));
    assertEquals(first[0].delivery, "settled");
    const tampered = {
      receipt: f.receipt,
      grant: f.grant,
      output: { ...f.output, overallScore: 10 },
    };
    const second = await results(await post({ receipts: [tampered] }, user.token));
    // The edge derives evidence_ambiguous for the tampered output, but the
    // durable store already holds this receipt: the ORIGINAL verdict replays.
    assertEquals(second[0].delivery, "replayed");
    assertEquals(second[0].reconciliation?.status, "result_recorded");
    assertEquals(settleCalls()[1].p_hold_reason, "evidence_ambiguous");
    const stored = [...durable.values()][0];
    assertEquals(stored.row.status, "result_recorded");
  },
);

// ===========================================================================
// A6 — network failures at each step; crash mid-batch; redelivery
// ===========================================================================

function status(code: number, headers: Record<string, string> = {}): () => Response {
  return () =>
    new Response(JSON.stringify({ code: "XX000", message: "injected" }), {
      status: code,
      headers: { "Content-Type": "application/json", ...headers },
    });
}

Deno.test(
  "ATTACK A6: lineage read 429+Retry-After / 502 / 302 → 503 that decides nothing; the redelivery settles",
  async () => {
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, "a6-lineage");
    for (const failure of [
      status(429, { "Retry-After": "7" }),
      status(502),
      status(302, { Location: "http://elsewhere.test/" }),
    ]) {
      reset();
      h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
      let fired = false;
      h.respond = lineageRespond({ [RELEASE.policy.sha256]: releasePolicyRow }, () => {
        if (fired) return null;
        fired = true;
        return failure();
      });
      const { result: response } = await captureConsole(() =>
        post({ receipts: [entryOf(f)] }, user.token),
      );
      assertEquals(response.status, 503);
      await response.body?.cancel();
      assertEquals(settleCalls().length, 0);
      assertEquals(durable.size, 0);
      const retried = await results(await post({ receipts: [entryOf(f)] }, user.token));
      assertEquals(retried[0].delivery, "settled");
    }
  },
);

Deno.test(
  "ATTACK A6b: settle RPC 429 / 302 / 500 on the SECOND entry of a batch — earlier verdicts stand, nothing is doubled on redelivery, no receipt is lost",
  async () => {
    const user = freshUser();
    const one = await fixture(user.sub, TICKET_A, "a6b-1");
    const two = await fixture(user.sub, TICKET_B, "a6b-2", { claims: one.claims });
    const three = await fixture(user.sub, TICKET_B, "a6b-3", {
      claims: one.claims,
      billingDisposition: "not_chargeable",
      outputOverrides: { resultKind: "low_confidence", overallScore: null },
    });
    for (const failure of [
      status(429, { "Retry-After": "3" }),
      status(302, { Location: "http://x.test/" }),
      status(500),
    ]) {
      reset();
      settleFailures = [() => null, failure];
      const { result: crashed } = await captureConsole(() =>
        post({ receipts: [entryOf(one), entryOf(two), entryOf(three)] }, user.token),
      );
      assertEquals(crashed.status, 503);
      await crashed.body?.cancel();
      assertEquals(settleCalls().length, 2, "the batch stopped at the failure");
      assertEquals(durable.size, 1, "only the first receipt has a verdict");

      // Device restarts and redelivers the whole batch.
      const redelivered = await results(
        await post({ receipts: [entryOf(one), entryOf(two), entryOf(three)] }, user.token),
      );
      assertEquals(
        redelivered.map((r) => r.delivery),
        ["replayed", "settled", "settled"],
      );
      assertEquals(
        [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
        2,
      );
    }
  },
);

// ===========================================================================
// A7 — pending never durable; mixed batches; process death between steps
// ===========================================================================

Deno.test(
  "ATTACK A7: a pending receipt redelivered 5 times leaves nothing durable and never consumes; once the session lands it settles once",
  async () => {
    reset();
    const user = freshUser();
    const sessionId = crypto.randomUUID();
    const pend = await fixture(user.sub, TICKET_A, "a7-pending", {
      outputOverrides: { sessionId },
    });
    const settled = await fixture(user.sub, TICKET_B, "a7-settled", { claims: pend.claims });
    for (let i = 0; i < 5; i += 1) {
      const out = await results(
        await post({ receipts: [entryOf(pend), entryOf(settled)] }, user.token),
      );
      assertEquals(out[0].delivery, "pending");
      assertEquals(out[0].reconciliation?.status, "pending");
      assertEquals(out[0].reconciliation?.financialDisposition, "reserved");
      assertEquals(out[1].delivery, i === 0 ? "settled" : "replayed");
    }
    assertEquals(durable.size, 1);
    syncedSessions.add(sessionId);
    const landed = await results(
      await post({ receipts: [entryOf(pend), entryOf(settled)] }, user.token),
    );
    assertEquals(
      landed.map((r) => r.delivery),
      ["settled", "replayed"],
    );
    const again = await results(await post({ receipts: [entryOf(pend)] }, user.token));
    assertEquals(again[0].delivery, "replayed");
    assertEquals(
      [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length,
      2,
    );
  },
);

Deno.test(
  "ATTACK A7b: the reconciliation the route returns never exposes another caller's namespace — the same receipt id from two accounts",
  async () => {
    reset();
    const alice = freshUser();
    const bob = freshUser();
    const a = await fixture(alice.sub, TICKET_A, "shared-id");
    const b = await fixture(bob.sub, TICKET_A, "shared-id");
    const outA = await results(await post({ receipts: [entryOf(a)] }, alice.token));
    const outB = await results(await post({ receipts: [entryOf(b)] }, bob.token));
    assertEquals(outA[0].delivery, "settled");
    assertEquals(outB[0].delivery, "settled");
    assertEquals(outA[0].reconciliation?.ownerId, alice.sub);
    assertEquals(outB[0].reconciliation?.ownerId, bob.sub);
    // Bob delivering Alice's receipt: HOLD in Bob's namespace, Alice's verdict untouched.
    const stolen = await results(
      await post(
        { receipts: [{ ...entryOf(a), receipt: { ...a.receipt, receiptId: "stolen" } }] },
        bob.token,
      ),
    );
    assertEquals(stolen[0].delivery, "held");
    assertEquals(stolen[0].reconciliation?.reasonCode, "owner_mismatch");
    assertEquals(settleCalls()[2].p_hold_reason, "owner_mismatch");
    assertEquals(h.callsTo(SETTLE_RPC)[2].headers.authorization, callerBearer(bob.sub));
    const aliceAgain = await results(await post({ receipts: [entryOf(a)] }, alice.token));
    assertEquals(aliceAgain[0].delivery, "replayed");
    assertEquals(aliceAgain[0].reconciliation?.status, "result_recorded");
  },
);

// ===========================================================================
// Live PostgreSQL half — the REAL settle_offline_receipt()
// ===========================================================================

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `atk-${name}-${RUN}`;

async function createUser(sql: Sql, n: number, identity = n): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-04-atk-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-atk-${identity}-${RUN}', '${U(n)}', '{"sub":"w04-04-atk-${identity}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(
  tx: Tx,
  n: number,
  options: { session?: boolean; apiKey?: boolean } = {},
): Promise<void> {
  if (options.apiKey !== false) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (options.session !== false) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
  }
}

function inTx<T>(
  sql: Sql,
  n: number | null,
  fn: (tx: Tx) => Promise<T>,
  options: { session?: boolean; apiKey?: boolean } = {},
): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n, options);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

async function settle(
  tx: Tx,
  rec: OfflineResultReceipt | Record<string, unknown>,
  out: Record<string, unknown> | null,
  hold: string | null,
  sha?: string,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${sha ?? (await digestCanonicalOfflineJson(rec))}',
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

async function settlementRows(
  sql: Sql,
  n: number,
): Promise<
  Array<{
    receipt_id: string;
    status: string;
    reason_code: string | null;
    financial_disposition: string;
  }>
> {
  return await sql.unsafe(
    `select receipt_id, status, reason_code, financial_disposition
     from public.offline_receipt_settlements where user_id = '${U(n)}' order by id`,
  );
}

// ---------------------------------------------------------------------------
// L1 — duplicate identities across tickets
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L1 (live): reusing a consumed RESULT id under the other ticket, and a receipt for a ticket of another installation of the same user, both HOLD; one shot, one consumed event",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const key = KEY("l1");
      const issued = await issueFreeGrant(sql, 1, key);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(1), issued, ticketA, "l1-a");
      const first = await inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(first.delivery, "settled");
      assertEquals(first.financial_disposition, "consumed");

      // Same RESULT id, new operation, other ticket: never a second shot.
      const reuse = await liveReceipt(U(1), issued, ticketB, "l1-reuse", {
        resultId: a.receipt.resultId,
        fullOutputSha256: a.receipt.fullOutputSha256,
      });
      const held = await inTx(sql, 1, (tx) => settle(tx, reuse.receipt, a.output, null));
      assertEquals(held.delivery, "held");
      assertEquals(held.reason_code, "conflicting_receipt");
      assertEquals(held.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await shotCount(sql, ticketB), 0);

      // Same OPERATION id under ticket B with a new result: also held.
      const sameOp = await liveReceipt(U(1), issued, ticketB, "l1-sameop", {
        operationId: a.receipt.operationId,
      });
      const heldOp = await inTx(sql, 1, (tx) => settle(tx, sameOp.receipt, sameOp.output, null));
      assertEquals([heldOp.delivery, heldOp.reason_code], ["held", "conflicting_receipt"]);

      // A second installation of the SAME user names ticket B: the allocation
      // belongs to installation 1 → HOLD evidence_ambiguous, ticket reserved.
      const key2 = KEY("l1-dev2");
      await registerDevice(sql, 1, key2);
      const foreign = await liveReceipt(U(1), issued, ticketB, "l1-dev2", {
        installationKeyId: key2,
      });
      const heldDev = await inTx(sql, 1, (tx) => settle(tx, foreign.receipt, foreign.output, null));
      assertEquals(
        [heldDev.delivery, heldDev.reason_code, heldDev.financial_disposition],
        ["held", "evidence_ambiguous", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L2 — concurrency
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L2 (live): 8 parallel deliveries of one receipt → exactly one settlement; settle ‖ release of the same ticket → exactly one terminal event; two receipts racing for one ticket → one consumed, one held",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 12, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const key = KEY("l2");
      const issued = await issueFreeGrant(sql, 2, key);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      const a = await liveReceipt(U(2), issued, ticketA, "l2-a");
      const parallel = await Promise.all(
        Array.from({ length: 8 }, () =>
          inTx(sql, 2, (tx) => settle(tx, a.receipt, a.output, null)),
        ),
      );
      const deliveries = parallel.map((r) => r.delivery).sort();
      assertEquals(deliveries.filter((d) => d === "settled").length, 1, JSON.stringify(deliveries));
      assertEquals(
        deliveries.filter((d) => d === "replayed").length,
        7,
        JSON.stringify(deliveries),
      );
      assertEquals(
        parallel.every((r) => r.financial_disposition === "consumed"),
        true,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);

      // Ticket B: a receipt races the device's explicit "unused" return.
      const b = await liveReceipt(U(2), issued, ticketB, "l2-b");
      const [settledB, released] = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, b.receipt, b.output, null)),
        inTx(sql, 2, async (tx) => {
          const rows = await tx.unsafe<{ r: string }[]>(
            `select public.release_offline_ticket('${ticketB}', 'unused_ticket_returned') as r`,
          );
          return rows[0].r;
        }),
      ]);
      const eventsB = await ledgerEvents(sql, ticketB);
      assertEquals(eventsB.length, 2, `exactly one terminal event: ${JSON.stringify(eventsB)}`);
      assertEquals(eventsB[0], "allocated");
      if (eventsB[1] === "consumed") {
        assertEquals(settledB.financial_disposition, "consumed");
        assertNotEquals(released, "accepted");
      } else {
        assertEquals(eventsB[1], "released");
        assertEquals(released, "accepted");
        assertEquals([settledB.delivery, settledB.reason_code], ["held", "conflicting_receipt"]);
      }
      assertEquals(await shotCount(sql, ticketB), eventsB[1] === "consumed" ? 1 : 0);

      // Fresh user: two DIFFERENT receipts (two operations) racing for ONE ticket.
      await createUser(sql, 3);
      const issued3 = await issueFreeGrant(sql, 3, KEY("l2-race"));
      assert(issued3.claims.allocation);
      const [ticketC] = issued3.claims.allocation.ticketIds;
      const c1 = await liveReceipt(U(3), issued3, ticketC, "l2-c1");
      const c2 = await liveReceipt(U(3), issued3, ticketC, "l2-c2");
      const race = await Promise.all([
        inTx(sql, 3, (tx) => settle(tx, c1.receipt, c1.output, null)),
        inTx(sql, 3, (tx) => settle(tx, c2.receipt, c2.output, null)),
      ]);
      const outcomes = race.map((r) => `${r.delivery}:${r.reason_code ?? ""}`).sort();
      assertEquals(outcomes, ["held:conflicting_receipt", "settled:"]);
      assertEquals(await ledgerEvents(sql, ticketC), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketC), 1);
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L3 — roles: allowed AND denied paths of the new SQL surfaces
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L3 (live): settle_offline_receipt() refuses anon / no session / no API key / service_role; another user's delivery HOLDs in their namespace only; the table and the lineage RPC refuse clients",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 4, KEY("l3"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(4), issued, ticketA, "l3-a");

      // anon (no JWT sub)
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role anon`);
            await settle(tx as unknown as Tx, a.receipt, a.output, null);
          }),
        Error,
      );
      // authenticated, no session claim
      await assertRejects(
        () => inTx(sql, 4, (tx) => settle(tx, a.receipt, a.output, null), { session: false }),
        Error,
        "authorization required",
      );
      // authenticated with session but without the edge's API key header
      await assertRejects(
        () => inTx(sql, 4, (tx) => settle(tx, a.receipt, a.output, null), { apiKey: false }),
        Error,
        "authorization required",
      );
      // service_role has no EXECUTE
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role service_role`);
            await settle(tx as unknown as Tx, a.receipt, a.output, null);
          }),
        Error,
        "permission denied",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);

      // Another signed-in user delivering user 4's receipt: HOLD in user 5's
      // namespace, user 4's ticket untouched, user 4 still settles.
      const stolen = await inTx(sql, 5, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(
        [stolen.delivery, stolen.reason_code, stolen.financial_disposition],
        ["held", "owner_mismatch", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      const owner = await inTx(sql, 4, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals([owner.delivery, owner.financial_disposition], ["settled", "consumed"]);
      assertEquals(
        (await settlementRows(sql, 5)).map((r) => r.reason_code),
        ["owner_mismatch"],
      );
      assertEquals(
        (await settlementRows(sql, 4)).map((r) => r.status),
        ["result_recorded"],
      );
      // user 5 may hold user 4's result id in their own hold row, but no shot.
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where id = '${a.receipt.resultId}' and user_id = '${U(5)}'`,
      );
      assertEquals(count, "0");
      assertEquals(await counters(sql, 5), { held: 0, scored: 0 });

      // Direct table access for clients: read and write refused.
      for (const role of ["authenticated", "anon"]) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(4)}'`);
              await tx.unsafe(`select * from public.offline_receipt_settlements`);
            }),
          Error,
          "permission denied",
        );
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(4)}'`);
              await tx.unsafe(
                `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${U(4)}'`,
              );
            }),
          Error,
          "permission denied",
        );
      }
      // Owner (postgres) cannot flip a recorded verdict either (append-only lifecycle guard).
      await assertRejects(
        () =>
          sql.unsafe(
            `update public.offline_receipt_settlements set status = 'reconciliation_required', reason_code = 'evidence_missing', financial_disposition = 'reserved' where user_id = '${U(4)}'`,
          ),
        Error,
      );
      await assertRejects(
        () =>
          sql.unsafe(`delete from public.offline_receipt_settlements where user_id = '${U(4)}'`),
        Error,
      );

      // Lineage RPC: service_role allowed (unknown sha → null row; known sha → row),
      // authenticated and anon denied.
      const [unknown] = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role service_role`);
        return await tx.unsafe<
          { row: { document: unknown; approval: unknown; denyNewAuthorizations: unknown } }[]
        >(`select public.read_analysis_release_policy_lineage('${"f".repeat(64)}') as row`);
      });
      assertEquals(unknown.row.document, null);
      assertEquals(unknown.row.approval, null);
      assertEquals(unknown.row.denyNewAuthorizations, true);
      for (const role of ["authenticated", "anon"]) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(4)}'`);
              await tx.unsafe(
                `select * from public.read_analysis_release_policy_lineage('${"f".repeat(64)}')`,
              );
            }),
          Error,
          "permission denied",
        );
      }
      // Malformed sha: refused without a scan.
      for (const bad of ["", "F".repeat(64), "f".repeat(63), "f".repeat(64) + "'; --"]) {
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          return await tx.unsafe<{ row: { document: unknown } }[]>(
            `select public.read_analysis_release_policy_lineage($1) as row`,
            [bad],
          );
        });
        assertEquals(rows.length, 1, bad);
        assertEquals(rows[0].row.document, null, bad);
      }
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L4 — free-rating conservation
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L4 (live): a not_chargeable receipt whose output claims a SCORED rating is recorded but never consumes and never writes a shot; a later chargeable receipt for that same result HOLDs; a hold keeps the ticket counted as outstanding",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      const issued = await issueFreeGrant(sql, 6, KEY("l4"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      // Abstention receipt but the output says "scored" with a score: the
      // evidence contradicts the receipt. Whatever the verdict, nothing may be
      // consumed and no scored shot may exist.
      const lie = await liveReceipt(U(6), issued, ticketA, "l4-lie", {
        billingDisposition: "not_chargeable",
      });
      const recorded = await inTx(sql, 6, (tx) => settle(tx, lie.receipt, lie.output, null));
      assertEquals(recorded.result, "accepted");
      assertNotEquals(recorded.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      const [{ count: shots }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where id = '${lie.receipt.resultId}'`,
      );
      assertEquals(shots, "0", "an abstention receipt never writes a scored shot");
      assertEquals(await counters(sql, 6), { held: 2, scored: 0 });

      // Now the device "upgrades" the same result to chargeable under a new
      // receipt id: the result was already recorded → HOLD, no consumption.
      const upgrade = await liveReceipt(U(6), issued, ticketA, "l4-upgrade", {
        resultId: lie.receipt.resultId,
        fullOutputSha256: lie.receipt.fullOutputSha256,
        operationId: lie.receipt.operationId,
      });
      const heldUpgrade = await inTx(sql, 6, (tx) => settle(tx, upgrade.receipt, lie.output, null));
      assertEquals(
        [heldUpgrade.delivery, heldUpgrade.reason_code],
        ["held", "conflicting_receipt"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // Evidence missing (output lost on the device): HOLD; the redelivery of
      // the identical receipt WITH the output replays the hold — the ticket is
      // neither consumed nor released (never refund, never re-run).
      const lost = await liveReceipt(U(6), issued, ticketB, "l4-lost");
      const held = await inTx(sql, 6, (tx) => settle(tx, lost.receipt, null, "evidence_missing"));
      assertEquals(
        [held.delivery, held.reason_code, held.financial_disposition],
        ["held", "evidence_missing", "reserved"],
      );
      const found = await inTx(sql, 6, (tx) => settle(tx, lost.receipt, lost.output, null));
      assertEquals(
        [found.delivery, found.status, found.reason_code],
        ["replayed", "reconciliation_required", "evidence_missing"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketB), 0);
      assertEquals(await counters(sql, 6), { held: 2, scored: 0 });

      // A hold never opens capacity: a grant refresh re-issues the SAME two
      // tickets, allocating nothing new.
      const refreshed = await refreshFreeGrant(sql, 6, KEY("l4"));
      assert(refreshed.claims.allocation);
      assertEquals([...refreshed.claims.allocation.ticketIds].sort(), [ticketA, ticketB].sort());
      const [{ count: allocations }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.offline_allocation_ledger where user_id = '${U(6)}' and event = 'allocated'`,
      );
      assertEquals(allocations, "2");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK L4b (live): a not_chargeable receipt whose delivered output claims resultKind=scored is contradictory evidence and must HOLD (the mirror of a chargeable receipt with an abstention output), not be recorded as delivered",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("l4b"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      // Control: chargeable receipt + abstention output → HOLD evidence_ambiguous.
      const mirror = await liveReceipt(
        U(10),
        issued,
        ticketA,
        "l4b-mirror",
        {},
        { resultKind: "low_confidence", overallScore: null },
      );
      const mirrorVerdict = await inTx(sql, 10, (tx) =>
        settle(tx, mirror.receipt, mirror.output, null),
      );
      assertEquals(
        [mirrorVerdict.delivery, mirrorVerdict.reason_code],
        ["held", "evidence_ambiguous"],
      );
      // Attack: not_chargeable receipt + scored output.
      const lie = await liveReceipt(U(10), issued, ticketB, "l4b-lie", {
        billingDisposition: "not_chargeable",
      });
      const verdict = await inTx(sql, 10, (tx) => settle(tx, lie.receipt, lie.output, null));
      assertEquals(
        [verdict.delivery, verdict.status],
        ["held", "reconciliation_required"],
        `not_chargeable receipt with a scored output was ${JSON.stringify(verdict)}`,
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L5 — account deletion and re-creation with the original receipt
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L5 (live): after delete + re-create (same identity), the ORIGINAL receipt (old owner id) HOLDs as owner_mismatch and is never consumed twice; the identity's lifetime capacity stays 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const key = KEY("l5");
      const original = await issueFreeGrant(sql, 7, key);
      assert(original.claims.allocation);
      const [ticketA, ticketB] = original.claims.allocation.ticketIds;
      const a = await liveReceipt(U(7), original, ticketA, "l5-a");
      const consumed = await inTx(sql, 7, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(consumed.financial_disposition, "consumed");
      // Device produced a second receipt (ticket B) but the account was
      // deleted before it was delivered.
      const b = await liveReceipt(U(7), original, ticketB, "l5-b");

      // Delete user 7 (cascade), re-create the same identity as user 8.
      await sql.unsafe(`delete from auth.users where id = '${U(7)}'`);
      await createUser(sql, 8, 7);
      assertEquals(
        await counters(sql, 8),
        { held: 1, scored: 1 },
        "identity ledger + outstanding ticket follow the identity",
      );

      // The new account delivers the OLD receipts (owner = deleted uuid).
      const replayA = await inTx(sql, 8, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals([replayA.delivery, replayA.reason_code], ["held", "owner_mismatch"]);
      const holdB = await inTx(sql, 8, (tx) => settle(tx, b.receipt, b.output, null));
      assertEquals(
        [holdB.delivery, holdB.reason_code, holdB.financial_disposition],
        ["held", "owner_mismatch", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      // The account cascade removed the old account's shot rows; the identity
      // ledger (consumed event + lifetime count) is what survives.
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await shotCount(sql, ticketB), 0);

      // Original-owner recovery re-issues ONLY ticket B; a receipt bound to
      // the recovered grant settles it once; no third ticket ever exists.
      await registerDevice(sql, 8, key);
      const recovered = await refreshFreeGrant(sql, 8, key);
      assert(recovered.claims.allocation);
      assertEquals(recovered.claims.allocation.ticketIds, [ticketB]);
      const b2 = await liveReceipt(U(8), recovered, ticketB, "l5-b2");
      const settledB = await inTx(sql, 8, (tx) => settle(tx, b2.receipt, b2.output, null));
      assertEquals([settledB.delivery, settledB.financial_disposition], ["settled", "consumed"]);
      assertEquals(await counters(sql, 8), { held: 0, scored: 2 });
      const exhausted = await inTx(sql, 8, async (tx) => {
        const rows = await tx.unsafe<{ row: { result: string; ticket_ids: string[] | null } }[]>(
          `select to_jsonb(g) as row from public.issue_offline_grant('${key}', 2) g`,
        );
        return rows[0].row;
      });
      assert(
        exhausted.result !== "accepted" || (exhausted.ticket_ids ?? []).length === 0,
        `no new free ticket after both were spent: ${JSON.stringify(exhausted)}`,
      );
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.offline_allocation_ledger where event = 'allocated' and ticket_id in ('${ticketA}', '${ticketB}')`,
      );
      assertEquals(count, "2");
      const [{ total }] = await sql.unsafe<{ total: string }[]>(
        `select count(*)::text as total from public.offline_allocation_ledger l where l.event = 'allocated' and l.installation_key_id = '${key}'`,
      );
      assertEquals(total, "2", "the identity never had more than two tickets");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L6 — SQL-plane boundaries
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L6 (live): string sequence, 2^53 generation, unknown hold reason, uppercase sha, non-object output, receipt id > 128 are offline.invalid_input with nothing durable; a hold reason the edge never emits is refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueFreeGrant(sql, 9, KEY("l6"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(9), issued, ticketA, "l6-a");
      const rec = a.receipt as unknown as Record<string, unknown>;
      const ticket = a.receipt.ticket as unknown as Record<string, unknown>;
      // A syntactically valid digest for bodies the canonicaliser itself
      // refuses (unsafe integers, undefined): the shape check must come first.
      const anySha = "b".repeat(64);
      const cases: Array<
        [
          string,
          Record<string, unknown>,
          Record<string, unknown> | null,
          string | null,
          string | undefined,
        ]
      > = [
        ["sequence as string", { ...rec, lifecycleSequence: "1" }, a.output, null, undefined],
        ["sequence 0", { ...rec, lifecycleSequence: 0 }, a.output, null, undefined],
        ["sequence -1", { ...rec, lifecycleSequence: -1 }, a.output, null, undefined],
        ["sequence 1.5", { ...rec, lifecycleSequence: 1.5 }, a.output, null, undefined],
        ["sequence 2^53", { ...rec, lifecycleSequence: 2 ** 53 }, a.output, null, anySha],
        [
          "generation 2^53",
          { ...rec, ticket: { ...ticket, generation: 2 ** 53 } },
          a.output,
          null,
          anySha,
        ],
        [
          "generation string",
          { ...rec, ticket: { ...ticket, generation: "3" } },
          a.output,
          null,
          undefined,
        ],
        ["ticket missing", { ...rec, ticket: undefined }, a.output, null, anySha],
        ["receipt id 129", { ...rec, receiptId: "r".repeat(129) }, a.output, null, undefined],
        ["owner not uuid", { ...rec, ownerId: "nope" }, a.output, null, undefined],
        ["billing unknown", { ...rec, billingDisposition: "consumed" }, a.output, null, undefined],
        ["hold reason unknown", rec, a.output, "refund", undefined],
        ["hold reason empty", rec, a.output, "", undefined],
        ["sha uppercase", rec, a.output, null, "A".repeat(64)],
        ["sha short", rec, a.output, null, "a".repeat(63)],
      ];
      for (const [label, r, out, hold, sha] of cases) {
        const verdict = await inTx(sql, 9, (tx) => settle(tx, r, out, hold, sha));
        assertEquals(verdict.result, "offline.invalid_input", label);
        assertEquals(verdict.delivery, null, label);
      }
      // Output as a JSON array / scalar (with a well-formed receipt digest).
      const recSha = await digestCanonicalOfflineJson(rec);
      for (const bad of ["'[]'::jsonb", "'7'::jsonb", `'"x"'::jsonb`]) {
        const rows = await inTx(sql, 9, (tx) =>
          tx.unsafe<{ result: string }[]>(
            `select r.result from public.settle_offline_receipt(${lit(rec)}, '${recSha}', ${bad}, null) r`,
          ),
        );
        assertEquals(rows[0].result, "offline.invalid_input", bad);
      }
      assertEquals(
        (await settlementRows(sql, 9)).length,
        0,
        "nothing durable from malformed input",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // The well-formed receipt still settles exactly once afterwards.
      const ok = await inTx(sql, 9, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals([ok.delivery, ok.financial_disposition], ["settled", "consumed"]);
      assertEquals((await settlementRows(sql, 9)).length, 1);
    } finally {
      await sql.end();
    }
  },
});
