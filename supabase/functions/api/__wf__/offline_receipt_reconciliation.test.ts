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
// Runs unchanged against BASE_SHA, where the route answers 404 and the RPC
// does not exist, so every test fails there.

import postgres from "postgres";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RECONCILIATION_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  type OfflineExecutionGrantClaims,
  type OfflineFreeTicketReference,
  type OfflineReleasedArtifacts,
  type OfflineResultReceipt,
  type OfflineSignedExecutionGrant,
} from "../../../../packages/shared-types/src/offlineAuthorization.ts";
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
  offlineGrantClaimsFromIssuance,
  signOfflineExecutionGrant,
  type OfflineGrantKey,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
  type RecordedCall,
} from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const SETTLE_RPC = "/rest/v1/rpc/settle_offline_receipt";
const CONSUME_RPC = "/rest/v1/rpc/consume_offline_ticket";
const RELEASE_RPC = "/rest/v1/rpc/release_offline_ticket";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-test-key";
const FOREIGN_KID = "w04-04-foreign-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04";
const GRANT_ID = "64444444-4444-4444-8444-444444444444";
const TICKET_A = "65555555-5555-4555-8555-555555555551";
const TICKET_B = "65555555-5555-4555-8555-555555555552";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DAY = 86_400;

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
  options: { grantId?: string; tickets?: string[]; installationKeyId?: string } = {},
): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
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
  billingDisposition?: OfflineResultReceipt["billingDisposition"];
  installationKeyId?: string;
  grantJwsSha256?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: options.grantJwsSha256 ?? (await digestOfflineGrantTransport(options.grant)),
    ticket: options.ticket,
    lifecycleSequence: options.lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04",
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

/** One settled receipt fixture: grant, receipt and its durably delivered output. */
async function settledFixture(
  ownerId: string,
  ticketId: string,
  n: number,
  options: { key?: OfflineGrantKey; claims?: OfflineExecutionGrantClaims } = {},
): Promise<{
  claims: OfflineExecutionGrantClaims;
  grant: OfflineSignedExecutionGrant;
  receipt: OfflineResultReceipt;
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
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

interface RouteResult {
  receiptId: string;
  delivery: "settled" | "replayed" | "held" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  assertEquals(response.status, 200);
  const body = await readJson(response);
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
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
      schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
      ownerId: user.sub,
      receiptId: "receipt-1",
      status: "result_recorded",
      resultId: first.receipt.resultId,
      financialDisposition: "consumed",
    });

    const calls = h.callsTo(SETTLE_RPC);
    assertEquals(calls.length, 2);
    for (const call of calls) assertEquals(call.headers.authorization, callerBearer(user.sub));
    const params = calls.map(settleParams);
    assertEquals(params[0].p_receipt.receiptId, "receipt-2");
    assertEquals(params[1].p_receipt.receiptId, "receipt-1");
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
    assertEquals(again[0].reconciliation, first[0].reconciliation);
    assertEquals(again[1].reconciliation, first[0].reconciliation);
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
      schemaVersion: OFFLINE_RECONCILIATION_SCHEMA_VERSION,
      ownerId: user.sub,
      receiptId: "receipt-1",
      status: "reconciliation_required",
      reasonCode: "evidence_ambiguous",
      financialDisposition: "reserved",
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
    assertEquals(again[0].reconciliation, out[0].reconciliation);
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
  "malformed entries are rejected per receipt without reaching the database; a malformed batch is 400",
  async () => {
    reset();
    const user = freshUser();
    const fixture = await settledFixture(user.sub, TICKET_A, 1);

    const out = await results(
      await post(
        {
          receipts: [
            {
              receipt: { ...fixture.receipt, receiptId: 42 },
              grant: fixture.grant,
              output: fixture.output,
            },
            {
              receipt: fixture.receipt,
              grant: { compactJws: "not.a.jws" },
              output: fixture.output,
            },
            { receipt: fixture.receipt, grant: fixture.grant, output: "not-an-object" },
            "not-an-entry",
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.delivery, r.error?.code]),
      [
        ["rejected", "offline.invalid_input"],
        ["rejected", "offline.invalid_input"],
        ["rejected", "offline.invalid_input"],
        ["rejected", "offline.invalid_input"],
      ],
    );
    assertEquals(out[1].receiptId, "receipt-1");
    assertEquals(settleCalls().length, 0);

    for (const bad of [
      {},
      { receipts: [] },
      { receipts: "x" },
      { receipts: new Array(26).fill(null) },
    ]) {
      const response = await post(bad, user.token);
      assertEquals(response.status, 400);
      assertEquals(
        ((await readJson(response)).error as { code?: string }).code,
        "offline.invalid_input",
      );
    }
    assertEquals(settleCalls().length, 0);
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

async function issueFreeGrant(
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
  assert(claims.allocation && claims.allocation.ticketIds.length === 2);
  return { claims, grant: await sign(claims) };
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
         values ('x', '${"0".repeat(64)}', '${U(1)}', '${U(1)}', 'k', '${GRANT_ID}', '${"0".repeat(64)}', 'op', 'res', '${"0".repeat(64)}', 'not_chargeable', 1, 'result_recorded', 'not_applicable', '{}'::jsonb)`,
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
