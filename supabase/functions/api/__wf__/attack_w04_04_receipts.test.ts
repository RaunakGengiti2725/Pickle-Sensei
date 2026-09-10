// W04-04 ADVERSARIAL — POST /v1/offline/receipts (candidate afb40817).
// Each test is one attack at a failure boundary of delayed receipt
// reconciliation. Tests that PASS document a defence that held; tests that
// FAIL are the reproducible breaks reported for this candidate.
//
// Two halves, both black-box (same layout as the candidate's own suite):
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer with a durable in-memory settlement stand-in keyed exactly
//     like settle_offline_receipt());
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with
//     every migration applied (./xc_pg_up.sh, XC_PG_URL). Without XC_PG_URL
//     the postgres half is `ignore`d — an ignored run is NOT a pass.
//
// Attack classes covered:
//   A1  wire contract vs the shipping app's receipt drain (interleaved
//       client/server generations)
//   A2  durable verdict masked by a reversible freeze (replay / conflict
//       under deny_new)
//   A3  boundary values: empty / max / over-max batch, oversize body,
//       0 / negative / fractional / 2^53 sequences, duplicate ids in a batch,
//       foreign shapes for output / ticket / entries
//   A4  network / database failure mid-batch (5xx, 429, malformed RPC row,
//       lineage unavailable) — nothing partial is fabricated
//   A5  clock: far-past expiry, future iat, tampered exp in the envelope
//   A6  interleaved account switch: another signed-in account presents a
//       receipt it does not own
//   A7  live DB concurrency: N-way double submit of one receipt, N different
//       receipts racing for one ticket, settle racing an unused-ticket return
//   A8  live DB authorization: anon / service_role / no API key / no session /
//       expired session / banned user — denied paths leave nothing durable
//   A9  live DB free-rating conservation: partial, abstaining and
//       self-contradictory outputs never charge; the honest receipt then
//       charges exactly once; a replayed operation under a fresh receipt id
//       stays HOLD
//   A10 live DB crash between steps: a rolled-back settlement leaves nothing;
//       a ticket returned unused holds the late receipt; a rating naming a
//       session of ANOTHER account is pending, never written

import postgres from "postgres";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
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
const LINEAGE_RPC = "/rest/v1/rpc/read_analysis_release_policy_lineage";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-444444444445";
const TICKET_A = "65555555-5555-4555-8555-555555555561";
const TICKET_B = "65555555-5555-4555-8555-555555555562";
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
const signingKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: keyPair.privateKey,
};

const releasePolicyRow = await activeReleasePolicyRow();
const approval = releasePolicyRow.approval as { policy: { version: string; sha256: string } };
const RELEASE: OfflineReleasedArtifacts = {
  policy: approval.policy,
  mechanicsModel: HARNESS_RELEASE_POLICY.mechanics.lineage.model,
  benchmarkModel: HARNESS_RELEASE_POLICY.benchmark.lineage.model,
};

const UNKNOWN_LINEAGE_ROW = {
  document: null,
  canonicalDocument: null,
  denyNewAuthorizations: true,
  approval: null,
};

function frozenActiveRow(): Record<string, unknown> {
  const base = releasePolicyRow.approval as Record<string, unknown>;
  return {
    ...releasePolicyRow,
    denyNewAuthorizations: true,
    approval: { ...base, withdrawnAt: null, denyNewAuthorizations: true },
  };
}

function lineageRespond(
  known: Record<string, Record<string, unknown>>,
  inner: (call: RecordedCall) => Response | null = durableRespond,
): (call: RecordedCall) => Response | null {
  return (call) => {
    if (!call.url.endsWith(LINEAGE_RPC)) return inner(call);
    const body = call.body as { p_policy_sha256: string };
    const row = known[body.p_policy_sha256] ?? UNKNOWN_LINEAGE_ROW;
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
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0404-4000-8000-a${String(userSeq).padStart(11, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(
  ownerId: string,
  options: { issuedAt?: number; expiresAt?: number; tickets?: string[] } = {},
): OfflineExecutionGrantClaims {
  const issuedAt = options.issuedAt ?? nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: GRANT_ID,
      generation: 3,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(options.expiresAt ?? issuedAt + 7 * DAY),
      entitlement_expires_at: null,
      ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
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
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.claims.installationKeyId,
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
  ticketId: string | null,
  n: number,
  options: { claims?: OfflineExecutionGrantClaims; grant?: OfflineSignedExecutionGrant } = {},
): Promise<Fixture> {
  const claims = options.claims ?? freeClaims(ownerId);
  const grant = options.grant ?? (await sign(claims));
  const resultId = `7a00000${n % 10}-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `attack-receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: ticketId === null ? null : ticketRef(ticketId, claims),
    lifecycleSequence: n,
    operationId: `attack-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { claims, grant, receipt: rec, output: out };
}

// ---------------------------------------------------------------------------
// Durable RPC stand-in (mirrors the migration exactly as the candidate's
// harness does: remembered by (caller, receiptId, digest); replay; conflict).
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
    row = known.sha256 === params.p_receipt_sha256 ? { ...known.row, delivery: "replayed" } : {
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
  } else {
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition: params.p_receipt.ticket === null
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

async function postRaw(text: string, token: string): Promise<Response> {
  return await h.handler(
    new Request(`http://edge.test/functions/v1/api${RECEIPTS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-forwarded-for": "203.0.113.77",
        "Content-Type": "application/json",
      },
      body: text,
    }),
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface RouteResult {
  receiptId: string | null;
  delivery: "settled" | "replayed" | "held" | "pending" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  const body = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(body));
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

const entry = (f: Fixture): Record<string, unknown> => ({
  receipt: f.receipt,
  grant: f.grant,
  output: f.output,
});

// ---------------------------------------------------------------------------
// A1 — wire contract vs the shipping app. apps/mobile/src/data/syncRuntime.ts
// drains queued receipts through reconcileOfflineWallet() →
// OfflineGrantClient.submitReceipts() (apps/mobile/src/data/api.ts), which
// POSTs `{ receipts: OfflineReceiptSubmission[] }` — a bare receipt per entry
// (no `{ receipt, grant, output }` envelope, no nativeTime / attestation /
// schemaVersion, plus `queuedAt`) — and accepts ONLY an answer of the shape
// `{ receipts: [{ receiptId, status }], rejected: [{ receiptId, code }] }`
// (parseOfflineReceiptVerdicts; anything else is "unreadable" and settles
// nothing, so the receipts stay queued and the drain backs off forever).
// The mobile side (W04-05, commit 7ec8d097) is an ancestor of BASE_SHA.
// ---------------------------------------------------------------------------

/** Exactly what `submission()` in offlineWallet.ts sends for one queued
 * receipt: the OfflineConsumptionReceipt row minus settlement/settledAt. */
function mobileSubmission(
  ownerId: string,
  claims: OfflineExecutionGrantClaims,
  grantJwsSha256: string,
  n: number,
  fullOutputSha256: string,
): Record<string, unknown> {
  assert(claims.allocation);
  return {
    receiptId: `mobile-receipt-${n}`,
    ownerId,
    installationKeyId: claims.installationKeyId,
    grantId: claims.jti,
    grantJwsSha256,
    lifecycleSequence: n,
    ticket: {
      allocationId: claims.allocation.allocationId,
      generation: claims.allocation.generation,
      ticketId: claims.allocation.ticketIds[0],
    },
    operationId: `mobile-operation-${n}`,
    resultId: `7b000000-0404-4000-8000-${String(n).padStart(12, "0")}`,
    fullOutputSha256,
    billingDisposition: "joint_verification_required",
    queuedAt: iso(claims.iat + 600),
  };
}

Deno.test(
  "A1 [wire contract] the shipping app's receipt drain (syncRuntime → submitReceipts) is accepted by the route and answered in the shape parseOfflineReceiptVerdicts() reads",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const out = output("7b000000-0404-4000-8000-000000000001");
    const submission = mobileSubmission(
      user.sub,
      claims,
      await digestOfflineGrantTransport(grant),
      1,
      await digestCanonicalOfflineJson(out),
    );
    const response = await post({ receipts: [submission] }, user.token);
    const body = await readJson(response);
    assertEquals(response.status, 200, JSON.stringify(body));

    // What the device parses (apps/mobile/src/data/api.ts parseOfflineReceiptVerdicts):
    // `receipts` and `rejected` arrays naming every submitted id exactly once.
    assert(
      Array.isArray(body.receipts),
      `route answer has no receipts[] the shipping app can read: ${JSON.stringify(body)}`,
    );
    const rejected = Array.isArray(body.rejected) ? (body.rejected as unknown[]) : [];
    const named = [
      ...(body.receipts as Record<string, unknown>[]),
      ...(rejected as Record<string, unknown>[]),
    ];
    assertEquals(named.length, 1);
    assertEquals(named[0].receiptId, "mobile-receipt-1");
    // A well-formed device receipt is judged (settled / held / pending), not
    // rejected as malformed — the app cannot re-shape a receipt it already
    // durably queued.
    assertEquals(rejected.length, 0, `device receipt rejected: ${JSON.stringify(body)}`);
    assertEquals(settleCalls().length, 1);
  },
);

// ---------------------------------------------------------------------------
// A2 — reversible freeze masks a DURABLE verdict. A receipt already settled
// (ticket consumed) is redelivered while the release is under deny_new: the
// route short-circuits to `pending` / `reserved` without consulting the
// database, contradicting the ledger (consumed). The same short-circuit hides
// the conflict verdict for a forged receipt re-using a settled id.
// ---------------------------------------------------------------------------

function freezeRelease(): void {
  h.rpcs.read_analysis_release_policy = frozenActiveRow();
  h.respond = lineageRespond({ [RELEASE.policy.sha256]: frozenActiveRow() });
}

Deno.test(
  "A2a [freeze masks durable verdict] a receipt already SETTLED (ticket consumed) redelivered under a reversible deny-new freeze replays its durable consumed verdict — not pending/reserved",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, 1);
    const batch = { receipts: [entry(f)] };
    const first = await results(await post(batch, user.token));
    assertEquals(first[0].delivery, "settled");
    assertEquals(first[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(durable.size, 1);

    freezeRelease();
    const again = await results(await post(batch, user.token));
    assertEquals(
      again[0].delivery,
      "replayed",
      `durable consumed verdict answered as ${again[0].delivery}: ${JSON.stringify(again[0])}`,
    );
    assertEquals(again[0].reconciliation?.status, "result_recorded");
    assertEquals(again[0].reconciliation?.financialDisposition, "consumed");
  },
);

Deno.test(
  "A2b [freeze masks conflict] under a reversible deny-new freeze a DIFFERENT receipt re-using a settled receipt id is still rejected offline.receipt_conflict — not answered pending",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, 1);
    const first = await results(await post({ receipts: [entry(f)] }, user.token));
    assertEquals(first[0].delivery, "settled");

    freezeRelease();
    const forged = { ...f.receipt, resultId: "7a000009-0404-4000-8000-000000000999" };
    const forgedOut = output(forged.resultId);
    forged.fullOutputSha256 = await digestCanonicalOfflineJson(forgedOut);
    const conflict = await results(
      await post(
        { receipts: [{ receipt: forged, grant: f.grant, output: forgedOut }] },
        user.token,
      ),
    );
    assertEquals(
      conflict[0].delivery,
      "rejected",
      `forged same-id receipt answered as ${conflict[0].delivery}: ${JSON.stringify(conflict[0])}`,
    );
    assertEquals(conflict[0].error?.code, "offline.receipt_conflict");
  },
);

Deno.test(
  "A2c [freeze masks durable hold] a receipt durably HELD (conflicting_receipt) redelivered under a reversible deny-new freeze replays its held verdict — not pending",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, 1);
    // Stand-in: the database already holds this receipt (e.g. its ticket was
    // returned unused before the receipt arrived).
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      const params = settleParams(call);
      return durableRespond({ ...call, body: { ...params, p_hold_reason: "conflicting_receipt" } });
    };
    const first = await results(await post({ receipts: [entry(f)] }, user.token));
    assertEquals(first[0].delivery, "held");
    assertEquals(first[0].reconciliation?.reasonCode, "conflicting_receipt");

    freezeRelease();
    const again = await results(await post({ receipts: [entry(f)] }, user.token));
    assertEquals(
      again[0].delivery,
      "replayed",
      `durable held verdict answered as ${again[0].delivery}: ${JSON.stringify(again[0])}`,
    );
    assertEquals(again[0].reconciliation?.status, "reconciliation_required");
    assertEquals(again[0].reconciliation?.reasonCode, "conflicting_receipt");
  },
);

// ---------------------------------------------------------------------------
// A3 — boundary values.
// ---------------------------------------------------------------------------

Deno.test(
  "A3 [boundaries] empty / 26 / non-array batches are 400 with no RPC; a 25-entry batch with 24 malformed entries settles exactly the valid one; duplicate ids inside one batch replay or conflict; a body over the cap is 413 with no RPC",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, TICKET_A, 1);

    for (
      const body of [
        { receipts: [] },
        { receipts: Array.from({ length: 26 }, () => entry(f)) },
        { receipts: {} },
        { receipts: "x" },
        { receipts: null },
        {},
      ]
    ) {
      const response = await post(body, user.token);
      assertEquals(response.status, 400, JSON.stringify(body).slice(0, 80));
      const parsed = await readJson(response);
      assertEquals((parsed.error as Record<string, unknown>).code, "offline.invalid_input");
    }
    assertEquals(settleCalls().length, 0);

    // 24 malformed shapes + the one valid receipt, valid one LAST.
    const oversizeId = "x".repeat(129);
    const malformed: unknown[] = [
      null,
      1,
      "receipt",
      [],
      {},
      { receipt: f.receipt },
      { receipt: f.receipt, grant: f.grant },
      { receipt: null, grant: f.grant, output: f.output },
      { receipt: f.receipt, grant: null, output: f.output },
      { receipt: f.receipt, grant: f.grant, output: [] },
      { receipt: f.receipt, grant: f.grant, output: "scored" },
      { receipt: f.receipt, grant: f.grant, output: 7 },
      { receipt: { ...f.receipt, lifecycleSequence: 0 }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, lifecycleSequence: -1 }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, lifecycleSequence: 1.5 }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, lifecycleSequence: 2 ** 53 }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, lifecycleSequence: "1" }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, receiptId: oversizeId }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, receiptId: "" }, grant: f.grant, output: f.output },
      { receipt: { ...f.receipt, ticket: "ticket" }, grant: f.grant, output: f.output },
      {
        receipt: { ...f.receipt, ticket: { ...f.receipt.ticket, generation: 0 } },
        grant: f.grant,
        output: f.output,
      },
      {
        receipt: { ...f.receipt, ticket: { ...f.receipt.ticket, generation: -3 } },
        grant: f.grant,
        output: f.output,
      },
      {
        receipt: { ...f.receipt, fullOutputSha256: "F".repeat(64) },
        grant: f.grant,
        output: f.output,
      },
      { receipt: { ...f.receipt, extra: true }, grant: f.grant, output: f.output },
    ];
    assertEquals(malformed.length, 24);
    const mixed = await results(await post({ receipts: [...malformed, entry(f)] }, user.token));
    assertEquals(mixed.length, 25);
    for (const r of mixed.slice(0, 24)) {
      assertEquals(r.delivery, "rejected", JSON.stringify(r));
      assertEquals(r.error?.code, "offline.invalid_input");
      assertEquals(r.reconciliation, null);
    }
    assertEquals(mixed[24].delivery, "settled");
    assertEquals(settleCalls().length, 1);
    assertEquals(durable.size, 1);

    // Duplicate ids inside ONE batch: exact duplicate replays, forged conflicts.
    const forged = { ...f.receipt, operationId: "attack-operation-forged" };
    const dup = await results(
      await post(
        {
          receipts: [entry(f), entry(f), { receipt: forged, grant: f.grant, output: f.output }],
        },
        user.token,
      ),
    );
    assertEquals(dup.map((r) => r.delivery), ["replayed", "replayed", "rejected"]);
    assertEquals(dup[2].error?.code, "offline.receipt_conflict");
    assertEquals(durable.size, 1);

    // Body over the route cap: refused before any receipt is looked at.
    const before = settleCalls().length;
    const padding = "p".repeat(2_000_001);
    const big = await postRaw(
      JSON.stringify({ receipts: [entry(f)], padding }),
      user.token,
    );
    assertEquals(big.status, 413);
    assertEquals(settleCalls().length, before);
  },
);

// ---------------------------------------------------------------------------
// A4 — network / database failure at each step.
// ---------------------------------------------------------------------------

Deno.test(
  "A4 [network failure mid-batch] a 5xx / 429 / malformed row from the settlement RPC on the SECOND entry is a generic 503 for the batch, the first entry stays durable and replays, nothing is fabricated for the second; an unavailable lineage read is a 503 with no settlement",
  async () => {
    reset();
    const user = freshUser();
    const a = await fixture(user.sub, TICKET_A, 1);
    const b = await fixture(user.sub, TICKET_B, 2);
    const batch = { receipts: [entry(a), entry(b)] };

    for (
      const failure of [
        () => new Response(JSON.stringify({ code: "XX000", message: "boom" }), { status: 500 }),
        () =>
          new Response(JSON.stringify({ message: "slow down" }), {
            status: 429,
            headers: { "Retry-After": "30" },
          }),
        () => new Response("<html>bad gateway</html>", { status: 502 }),
        () =>
          new Response(JSON.stringify([{ result: "accepted", delivery: "bogus" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        () =>
          new Response(JSON.stringify([]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ]
    ) {
      reset();
      let settleSeen = 0;
      h.respond = (call) => {
        if (!call.url.endsWith(SETTLE_RPC)) return null;
        settleSeen += 1;
        if (settleSeen === 2) return failure();
        return durableRespond(call);
      };
      const response = await post(batch, user.token);
      assertEquals(response.status, 503);
      const body = await readJson(response);
      const text = JSON.stringify(body);
      assert(!text.includes("boom") && !text.includes("XX000"), `5xx leaks detail: ${text}`);
      assertEquals(durable.size, 1, "only the first entry is durable");
      assertEquals(durable.has(`Bearer session-for-${user.sub}|attack-receipt-2`), false);

      h.respond = durableRespond;
      const retry = await results(await post(batch, user.token));
      assertEquals(retry.map((r) => r.delivery), ["replayed", "settled"]);
      assertEquals(durable.size, 2);
    }

    // Lineage authority unavailable: nothing is settled, nothing is held.
    reset();
    const user2 = freshUser();
    const c = await fixture(user2.sub, TICKET_A, 3);
    h.rpcErrors.read_analysis_release_policy = 500;
    const down = await post({ receipts: [entry(c)] }, user2.token);
    assertEquals(down.status, 503);
    assertEquals(settleCalls().length, 0);
    assertEquals(durable.size, 0);
  },
);

// ---------------------------------------------------------------------------
// A5 — clocks.
// ---------------------------------------------------------------------------

Deno.test(
  "A5 [clock] a receipt under a grant that expired 40 days ago settles (delayed verification at exp-1); a grant whose iat is in the future is HELD (nothing consumed); an envelope whose exp was tampered after signing is HELD",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 47 * DAY;
    const old = await fixture(user.sub, TICKET_A, 1, {
      claims: freeClaims(user.sub, { issuedAt, expiresAt: issuedAt + 7 * DAY }),
    });
    const delayed = await results(await post({ receipts: [entry(old)] }, user.token));
    assertEquals(delayed[0].delivery, "settled", JSON.stringify(delayed[0]));
    assertEquals(delayed[0].reconciliation?.financialDisposition, "consumed");

    // Issued "in the future" relative to the settling server.
    const ahead = nowSeconds() + 3_600;
    const future = await fixture(user.sub, TICKET_B, 2, {
      claims: freeClaims(user.sub, { issuedAt: ahead, expiresAt: ahead + 7 * DAY }),
    });
    const held = await results(await post({ receipts: [entry(future)] }, user.token));
    assertEquals(held[0].delivery, "held", JSON.stringify(held[0]));
    assertEquals(held[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(settleCalls()[1].p_hold_reason, "evidence_ambiguous");

    // Tamper the signed envelope's exp far into the future (payload edit
    // breaks the signature; the digest the receipt names is of the tampered
    // transport so only the signature can catch it).
    const user3 = freshUser();
    const f = await fixture(user3.sub, TICKET_A, 3);
    const [header, payload, signature] = f.grant.compactJws.split(".");
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<
      string,
      unknown
    >;
    claims.exp = 4_102_444_799; // 2099-12-31
    const forgedPayload = btoa(JSON.stringify(claims))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const tampered: OfflineSignedExecutionGrant = {
      ...f.grant,
      compactJws: `${header}.${forgedPayload}.${signature}`,
    };
    const rec = { ...f.receipt, grantJwsSha256: await digestOfflineGrantTransport(tampered) };
    const out = await results(
      await post({ receipts: [{ receipt: rec, grant: tampered, output: f.output }] }, user3.token),
    );
    assertEquals(out[0].delivery, "held", JSON.stringify(out[0]));
    assertEquals(out[0].reconciliation?.financialDisposition, "reserved");
    assertNotEquals(out[0].reconciliation?.status, "result_recorded");
  },
);

// ---------------------------------------------------------------------------
// A6 — interleaved account switch.
// ---------------------------------------------------------------------------

Deno.test(
  "A6 [account switch] account B presenting A's receipt+grant is HELD owner_mismatch under B and settles nothing for A; A's own later delivery settles once; B's own receipt with the same receipt id is independent",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const fa = await fixture(a.sub, TICKET_A, 1);
    const byB = await results(await post({ receipts: [entry(fa)] }, b.token));
    assertEquals(byB[0].delivery, "held");
    assertEquals(byB[0].reconciliation?.reasonCode, "owner_mismatch");
    // The status is bound to the receipt as presented (its ownerId is A's)...
    assertEquals(byB[0].reconciliation?.ownerId, a.sub);
    // ...but recorded under the CALLER (B); A's namespace is untouched.
    assertEquals(settleCalls()[0].p_hold_reason, "owner_mismatch");
    // The RPC was invoked as B, never as A.
    assertEquals(h.callsTo(SETTLE_RPC)[0].headers.authorization, `Bearer session-for-${b.sub}`);
    assertEquals(durable.has(`Bearer session-for-${a.sub}|attack-receipt-1`), false);

    const byA = await results(await post({ receipts: [entry(fa)] }, a.token));
    assertEquals(byA[0].delivery, "settled");
    assertEquals(byA[0].reconciliation?.financialDisposition, "consumed");

    const fb = await fixture(b.sub, TICKET_A, 1);
    const own = await results(await post({ receipts: [entry(fb)] }, b.token));
    // B's own receipt shares the id with the held foreign one under B: the
    // held verdict is durable and a different body under that id conflicts.
    assertEquals(own[0].delivery, "rejected");
    assertEquals(own[0].error?.code, "offline.receipt_conflict");
    assertEquals(durable.size, 2);
  },
);

// ---------------------------------------------------------------------------
// Live postgres half.
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-${RUN}`;

async function createUser(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${U(n)}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${U(n)}', 'w04-04-attack-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-attack-${n}-${RUN}', '${
      U(n)
    }', '{"sub":"w04-04-attack-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(
  tx: Tx,
  n: number,
  options: { session?: boolean; apiKey?: boolean; role?: string; sessionId?: string } = {},
): Promise<void> {
  if (options.apiKey !== false) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role ${options.role ?? "authenticated"}`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (options.session !== false) {
    await tx.unsafe(
      `set local request.jwt.claims = '{"session_id":"${options.sessionId ?? SESSION(n)}"}'`,
    );
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

function settleSql(
  rec: OfflineResultReceipt,
  sha: string,
  out: Record<string, unknown> | null,
  hold: string | null,
): string {
  return `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${sha}',
       ${out === null ? "null::jsonb" : lit(out)},
       ${hold === null ? "null::text" : `'${hold}'`}
     ) r`;
}

async function settle(
  tx: Tx,
  rec: OfflineResultReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    settleSql(rec, await digestCanonicalOfflineJson(rec), out, hold),
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

async function issueFreeGrant(sql: Sql, n: number, key: string, requested = 2): Promise<LiveGrant> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
  const row = await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ row: unknown }[]>(
      `select to_jsonb(g) as row from public.issue_offline_grant('${key}', ${requested}) g`,
    );
    return rows[0].row;
  });
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId: U(n),
    installationKeyId: key,
    release: RELEASE,
  });
  assert(claims.allocation && claims.allocation.ticketIds.length === requested);
  return { claims, grant: await sign(claims) };
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
    receiptId: `attack-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `attack-op-${tag}-${RUN}`,
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

async function settlementRows(sql: Sql, n: number): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.offline_receipt_settlements where user_id = '${
      U(n)
    }'`,
  );
  return Number(count);
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(
    sql,
    n,
    (tx) =>
      tx.unsafe<{ held: number; scored: number }[]>(
        `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
      ),
  );
  return { held: Number(held), scored: Number(scored) };
}

/** Run `count` settlements of the given receipts truly concurrently, each on
 * its own connection, each in its own session-authorized transaction. */
function race(jobs: Array<() => Promise<SettleRow>>): Promise<SettleRow[]> {
  return Promise.all(jobs.map((job) => job()));
}

Deno.test({
  name:
    "A7 [live concurrency] 8-way double submit of one receipt consumes once; 8 different receipts racing for one ticket settle exactly one and HOLD the rest; a receipt racing an unused-ticket return ends in exactly one terminal ledger event",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("race"), 2);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      // Same receipt, 8 connections at once.
      const same = await liveReceipt(U(1), issued, ticketA, "same");
      const rows = await race(
        Array.from(
          { length: 8 },
          () => () => inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        ),
      );
      const deliveries = rows.map((r) => r.delivery).sort();
      assertEquals(deliveries, [
        "replayed",
        "replayed",
        "replayed",
        "replayed",
        "replayed",
        "replayed",
        "replayed",
        "settled",
      ]);
      for (const r of rows) {
        assertEquals(r.status, "result_recorded");
        assertEquals(r.financial_disposition, "consumed");
        assertEquals(r.result_id, same.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await settlementRows(sql, 1), 1);

      // 8 DIFFERENT receipts (own operation + result each) for ticket B.
      const rivals = await Promise.all(
        Array.from(
          { length: 8 },
          (_, i) => liveReceipt(U(1), issued, ticketB, `rival-${i}`, { lifecycleSequence: 2 + i }),
        ),
      );
      const rivalRows = await race(
        rivals.map((r) => () => inTx(sql, 1, (tx) => settle(tx, r.receipt, r.output, null))),
      );
      const settled = rivalRows.filter((r) => r.delivery === "settled");
      const held = rivalRows.filter((r) => r.delivery === "held");
      assertEquals(settled.length, 1, JSON.stringify(rivalRows));
      assertEquals(held.length, 7, JSON.stringify(rivalRows));
      for (const r of held) {
        assertEquals(r.reason_code, "conflicting_receipt");
        assertEquals(r.financial_disposition, "reserved");
      }
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketB), 1);
      const { scored } = await counters(sql, 1);
      assertEquals(scored, 2);

      // Settle racing release_offline_ticket() on a fresh ticket.
      await createUser(sql, 2);
      const second = await issueFreeGrant(sql, 2, KEY("race2"), 1);
      assert(second.claims.allocation);
      const [ticketC] = second.claims.allocation.ticketIds;
      const late = await liveReceipt(U(2), second, ticketC, "late");
      const outcomes = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, late.receipt, late.output, null)),
        inTx(sql, 2, async (tx) => {
          const r = await tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketC}'::uuid, 'unused_ticket_returned') as result`,
          );
          return r[0];
        }),
      ]);
      const events = await ledgerEvents(sql, ticketC);
      assertEquals(events.length, 2, JSON.stringify({ events, outcomes }));
      assertEquals(events[0], "allocated");
      assert(events[1] === "consumed" || events[1] === "released", JSON.stringify(events));
      const settleRow = outcomes[0] as SettleRow;
      if (events[1] === "consumed") {
        assertEquals(settleRow.delivery, "settled");
        assertEquals(await shotCount(sql, ticketC), 1);
      } else {
        // The return won: the late receipt must HOLD, never consume or refund.
        assertEquals(settleRow.delivery, "held", JSON.stringify(settleRow));
        assertEquals(settleRow.reason_code, "conflicting_receipt");
        assertEquals(await shotCount(sql, ticketC), 0);
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A8 [live authorization] anon, service_role, a client without the API key, without a session, with an expired session and a banned user are all refused (42501) and leave nothing durable; the owner's session then settles once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      const issued = await issueFreeGrant(sql, 3, KEY("authz"), 1);
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const r = await liveReceipt(U(3), issued, ticket, "authz");
      const sha = await digestCanonicalOfflineJson(r.receipt);
      const call = settleSql(r.receipt, sha, r.output, null);

      const denied = async (setup: (tx: Tx) => Promise<void>): Promise<string> => {
        try {
          await sql.begin(async (raw) => {
            const tx = raw as unknown as Tx;
            await setup(tx);
            await tx.unsafe(call);
          });
          return "allowed";
        } catch (error) {
          return (error as { code?: string }).code ?? String(error);
        }
      };

      assertEquals(await denied((tx) => asUser(tx, 3, { role: "anon", session: false })), "42501");
      assertEquals(
        await denied((tx) => asUser(tx, 3, { role: "service_role", session: false })),
        "42501",
      );
      assertEquals(await denied((tx) => asUser(tx, 3, { role: "service_role" })), "42501");
      assertEquals(await denied((tx) => asUser(tx, 3, { apiKey: false })), "42501");
      assertEquals(await denied((tx) => asUser(tx, 3, { session: false })), "42501");
      // A session id that is not this user's.
      await createUser(sql, 4);
      assertEquals(await denied((tx) => asUser(tx, 3, { sessionId: SESSION(4) })), "42501");
      // Expired session.
      await sql.unsafe(
        `update auth.sessions set not_after = now() - interval '1 minute' where id = '${
          SESSION(3)
        }'`,
      );
      assertEquals(await denied((tx) => asUser(tx, 3)), "42501");
      await sql.unsafe(`update auth.sessions set not_after = null where id = '${SESSION(3)}'`);
      // Banned user.
      await sql.unsafe(
        `update auth.users set banned_until = now() + interval '1 day' where id = '${U(3)}'`,
      );
      assertEquals(await denied((tx) => asUser(tx, 3)), "42501");
      await sql.unsafe(`update auth.users set banned_until = null where id = '${U(3)}'`);

      // Direct table access from every client role is refused too.
      for (const role of ["anon", "authenticated", "service_role"]) {
        const code = await denied(async (tx) => {
          await asUser(tx, 3, { role });
          await tx.unsafe(`select count(*) from public.offline_receipt_settlements`);
        });
        assertEquals(code, "42501", role);
      }

      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await shotCount(sql, ticket), 0);
      assertEquals(await settlementRows(sql, 3), 0);

      // Another account (its own valid session) presenting this receipt.
      const foreign = await inTx(sql, 4, (tx) => settle(tx, r.receipt, r.output, "owner_mismatch"));
      assertEquals(foreign.delivery, "held");
      assertEquals(foreign.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await settlementRows(sql, 3), 0);
      assertEquals(await settlementRows(sql, 4), 1);
      // A foreign caller with NO hold reason must not be able to consume it either.
      const foreignNoHold = await inTx(sql, 4, async (tx) => {
        const rec = { ...r.receipt, receiptId: `attack-authz-2-${RUN}` };
        return await settle(tx, rec, r.output, null);
      });
      assertNotEquals(foreignNoHold.delivery, "settled", JSON.stringify(foreignNoHold));
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);

      // The owner, properly authorized, settles once.
      const owned = await inTx(sql, 3, (tx) => settle(tx, r.receipt, r.output, null));
      assertEquals(owned.delivery, "settled");
      assertEquals(owned.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A9 [live free-rating conservation] partial, abstaining and self-contradictory outputs never charge; the honest receipt then charges exactly once; the same operation replayed under a fresh receipt id stays HOLD; lifetime_scored_count() moves by exactly one",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 5, KEY("conserve"), 2);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const before = await counters(sql, 5);
      assertEquals(before, { held: 2, scored: 0 });

      // Chargeable receipt beside a PARTIAL output.
      const partial = await liveReceipt(U(5), issued, ticketA, "partial", {}, {
        resultKind: "partial",
        overallScore: null,
      });
      const p = await inTx(sql, 5, (tx) => settle(tx, partial.receipt, partial.output, null));
      assertEquals(p.delivery, "held", JSON.stringify(p));
      assertEquals(p.financial_disposition, "reserved");
      // Chargeable receipt beside an abstention.
      const abstain = await liveReceipt(
        U(5),
        issued,
        ticketA,
        "abstain",
        { lifecycleSequence: 2 },
        {
          resultKind: "low_confidence",
          overallScore: null,
        },
      );
      const a = await inTx(sql, 5, (tx) => settle(tx, abstain.receipt, abstain.output, null));
      assertEquals(a.delivery, "held", JSON.stringify(a));
      assertEquals(a.financial_disposition, "reserved");
      // "scored" without a score (violates scored_shots_have_scores).
      const noScore = await liveReceipt(
        U(5),
        issued,
        ticketA,
        "noscore",
        { lifecycleSequence: 3 },
        {
          overallScore: null,
        },
      );
      const s = await inTx(sql, 5, (tx) => settle(tx, noScore.receipt, noScore.output, null));
      assertEquals(s.delivery, "held", JSON.stringify(s));
      assertEquals(s.financial_disposition, "reserved");
      // scored output with an out-of-range score / far-future capture.
      const badScore = await liveReceipt(U(5), issued, ticketA, "badscore", {
        lifecycleSequence: 4,
      }, {
        overallScore: 99,
      });
      const b = await inTx(sql, 5, (tx) => settle(tx, badScore.receipt, badScore.output, null));
      assertNotEquals(b.delivery, "settled", JSON.stringify(b));
      assertNotEquals(b.financial_disposition, "consumed");
      const farFuture = await liveReceipt(
        U(5),
        issued,
        ticketA,
        "future",
        { lifecycleSequence: 5 },
        {
          capturedAt: "2101-01-01T00:00:00.000Z",
        },
      );
      const ff = await inTx(sql, 5, (tx) => settle(tx, farFuture.receipt, farFuture.output, null));
      assertNotEquals(ff.delivery, "settled", JSON.stringify(ff));
      assertNotEquals(ff.financial_disposition, "consumed");
      // not_chargeable receipt beside a scored output (contradiction).
      const contra = await liveReceipt(
        U(5),
        issued,
        ticketA,
        "contra",
        { lifecycleSequence: 6, billingDisposition: "not_chargeable" },
      );
      const c = await inTx(sql, 5, (tx) => settle(tx, contra.receipt, contra.output, null));
      assertEquals(c.delivery, "held", JSON.stringify(c));
      assertEquals(c.financial_disposition, "reserved");

      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await counters(sql, 5), { held: 2, scored: 0 });
      const [{ count: anyShot }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where user_id = '${U(5)}'`,
      );
      assertEquals(anyShot, "0");

      // The honest receipt for ticket A charges exactly once.
      const honest = await liveReceipt(U(5), issued, ticketA, "honest", { lifecycleSequence: 7 });
      const hRow = await inTx(sql, 5, (tx) => settle(tx, honest.receipt, honest.output, null));
      assertEquals(hRow.delivery, "settled", JSON.stringify(hRow));
      assertEquals(hRow.financial_disposition, "consumed");
      assertEquals(await counters(sql, 5), { held: 1, scored: 1 });

      // The same OPERATION replayed under a fresh receipt id and a fresh
      // result, against the other ticket: HOLD, ticket B stays allocated.
      const replayedOp = await liveReceipt(U(5), issued, ticketB, "replay-op", {
        lifecycleSequence: 8,
        operationId: honest.receipt.operationId,
      });
      const ro = await inTx(
        sql,
        5,
        (tx) => settle(tx, replayedOp.receipt, replayedOp.output, null),
      );
      assertEquals(ro.delivery, "held", JSON.stringify(ro));
      assertEquals(ro.reason_code, "conflicting_receipt");
      // The same RESULT id under a fresh receipt + operation: HOLD.
      const replayedResult = await liveReceipt(U(5), issued, ticketB, "replay-result", {
        lifecycleSequence: 9,
        resultId: honest.receipt.resultId,
        fullOutputSha256: honest.receipt.fullOutputSha256,
      });
      const rr = await inTx(
        sql,
        5,
        (tx) => settle(tx, replayedResult.receipt, honest.output, null),
      );
      assertEquals(rr.delivery, "held", JSON.stringify(rr));
      assertEquals(rr.reason_code, "conflicting_receipt");
      // The honest receipt again, 3 more times.
      for (let i = 0; i < 3; i += 1) {
        const again = await inTx(sql, 5, (tx) => settle(tx, honest.receipt, honest.output, null));
        assertEquals(again.delivery, "replayed");
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await counters(sql, 5), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A10 [live crash between steps] a settlement whose transaction rolls back leaves no shot, no ledger event, no settlement row and settles (not replays) on redelivery; a ticket returned unused HOLDs the late receipt; a rating naming ANOTHER account's session is pending and never written",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      await createUser(sql, 7);
      const issued = await issueFreeGrant(sql, 6, KEY("crash"), 2);
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;

      // Crash after the RPC decided but before the transaction committed.
      const r = await liveReceipt(U(6), issued, ticketA, "crash");
      const sha = await digestCanonicalOfflineJson(r.receipt);
      let decided: SettleRow | null = null;
      await sql
        .begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await asUser(tx, 6);
          const rows = await tx.unsafe<SettleRow[]>(settleSql(r.receipt, sha, r.output, null));
          decided = rows[0];
          throw new Error("process died before commit");
        })
        .catch((error: Error) => assertMatch(error.message, /process died/));
      assert(decided !== null);
      assertEquals((decided as SettleRow).delivery, "settled");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await settlementRows(sql, 6), 0);
      const redelivered = await inTx(sql, 6, (tx) => settle(tx, r.receipt, r.output, null));
      assertEquals(redelivered.delivery, "settled");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);

      // Ticket B returned unused by the device, then a late receipt for it.
      await inTx(sql, 6, async (tx) => {
        const rows = await tx.unsafe<{ result: string }[]>(
          `select public.release_offline_ticket('${ticketB}'::uuid, 'unused_ticket_returned') as result`,
        );
        assertEquals(rows[0].result, "accepted");
      });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      const late = await liveReceipt(U(6), issued, ticketB, "late-after-return", {
        lifecycleSequence: 2,
      });
      const l = await inTx(sql, 6, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals(l.delivery, "held", JSON.stringify(l));
      assertEquals(l.reason_code, "conflicting_receipt");
      assertEquals(l.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      assertEquals(await shotCount(sql, ticketB), 0);

      // A rating naming a session owned by ANOTHER account.
      await createUser(sql, 8);
      const other = await issueFreeGrant(sql, 8, KEY("other-session"), 1);
      assert(other.claims.allocation);
      const [ticketO] = other.claims.allocation.ticketIds;
      const foreignSession = crypto.randomUUID();
      await inTx(sql, 7, (tx) =>
        tx.unsafe(
          `insert into public.sessions (id, user_id, started_at) values ('${foreignSession}', '${
            U(7)
          }', now())`,
        ));
      const named = await liveReceipt(U(8), other, ticketO, "foreign-session", {}, {
        sessionId: foreignSession,
      });
      const n = await inTx(sql, 8, (tx) => settle(tx, named.receipt, named.output, null));
      assertNotEquals(n.delivery, "settled", JSON.stringify(n));
      assertNotEquals(n.financial_disposition, "consumed");
      assertEquals(await shotCount(sql, ticketO), 0);
      const [{ count: leaked }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.shots where session_id = '${foreignSession}'`,
      );
      assertEquals(leaked, "0");
      assertEquals(await ledgerEvents(sql, ticketO), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});
