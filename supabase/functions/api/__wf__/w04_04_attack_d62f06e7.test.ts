// W04-04 ADVERSARIAL ATTACKS against candidate d62f06e7 (branch
// devin/pp/w04-04/impl-r9) — POST /v1/offline/receipts and the live
// settle_offline_receipt(). Every test here is an attack at a failure boundary
// the candidate's own suite does not pin: it asserts the behaviour the W04-04
// objective and the product invariants REQUIRE, so a failing test is a
// reproduced break, never a documentation of observed behaviour.
//
// Route half: the REAL edge handler through routesHarness with a durable
// in-memory settlement stand-in keyed (caller, receiptId) like the RPC.
// Live half: the REAL settle_offline_receipt() on the disposable postgres
// (./xc_pg_up.sh, XC_PG_URL) — `ignore`d without it (an ignored run is NOT a
// pass).
//
// Attacks (the number in the test name is the attack id in the report):
//   A01 body-size boundary: exactly-at-cap admitted, cap+1 coded 413, a
//       chunked (no Content-Length) oversized stream is the same coded 413
//   A02 crash between steps: RPC failure mid-batch → one generic 503, nothing
//       partial answered; redelivery replays the decided and settles the rest
//   A03 interleaved account switch at the route: another account presenting
//       this device's receipts is HELD in its own namespace, the owner still
//       settles, and a same-named receipt of the other account is independent
//   A04 decision-budget boundary: 250 fresh decided, the 251st pending with
//       nothing durable; rejected entries and replays never spend the budget
//   A05 duplicate identity inside ONE batch with two digests: first decides,
//       second is offline.receipt_conflict, nothing settles twice
//   A06 boundary values: every malformed number / instant / identifier is
//       refused per entry without reaching the RPC while a sibling settles
//   A07 (live) two receipts for one ticket racing in parallel transactions
//   A08 (live) the same receipt delivered twice concurrently
//   A09 (live) a receipt racing the device's explicit return of its ticket
//   A10 (live) cross-account namespace with the SQL's own owner check
//   A11 (live) unauthorised roles: anon / service_role / no session / another
//       user's session / direct table access / the private lease writer
//   A12 (live) free-rating conservation across offline consumption, replay,
//       a HOLD, an explicit return and the online permit gate
//   A13 (live) a lease receipt that declares execution AFTER the lease and the
//       entitlement expired is recorded as a rating (expected: HOLD)
//   A14 (live) a free-ticket receipt declaring execution after the grant
//       expired still consumes exactly one ticket (conservation holds)

import postgres from "postgres";
import { assert, assertEquals, assertMatch } from "@std/assert";
import { exportJWK, generateKeyPair } from "jose";
import {
  OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES,
  OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
  OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE,
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
  captureConsole,
  fakeGoogleIdToken,
  loadHarness,
  type RecordedCall,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const RECEIPTS_URL = `http://edge.test/functions/v1/api${RECEIPTS_PATH}`;
const SETTLE_RPC = "/rest/v1/rpc/settle_offline_receipt";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-444444444499";
const TICKET_A = "65555555-5555-4555-8555-555555555591";
const TICKET_B = "65555555-5555-4555-8555-555555555592";
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
  return {
    sub: `abababab-0404-4000-8000-${String(userSeq).padStart(12, "0")}`,
    token: fakeGoogleIdToken(`abababab-0404-4000-8000-${String(userSeq).padStart(12, "0")}`),
  };
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

function proClaims(ownerId: string, issuedAt = nowSeconds() - 60): OfflineExecutionGrantClaims {
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

/** The frozen 1.0 output shape (shot.sync payload without analysisPermitId). */
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
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    source: "real",
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

/** The row shape the route hands the RPC as p_output. */
function sqlOutput(out: Record<string, unknown>): Record<string, unknown> {
  const ts = out.timestamps as Record<string, unknown>;
  return {
    id: out.id,
    sessionId: out.sessionId,
    shotType: out.shotType,
    cameraView: out.cameraView,
    capturedAt: out.capturedAt,
    startMs: ts.startMs,
    contactMs: ts.contactMs,
    endMs: ts.endMs,
    overallScore: out.overallScore,
    confidence: out.confidence,
    resultKind: out.resultKind,
    phases: out.phases,
    checkpoints: out.checkpoints,
    versionVector: out.versionVector,
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
  queuedAt?: string;
}

/** The DEVICE receipt exactly as apps/mobile OfflineReceiptSubmission posts it. */
async function receipt(options: ReceiptOptions): Promise<OfflineDeviceReceipt> {
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
    queuedAt: options.queuedAt ?? "2026-09-08T12:00:00.000Z",
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
  receipt: OfflineDeviceReceipt;
  output: Record<string, unknown>;
}

async function freeFixture(
  ownerId: string,
  ticketId: string,
  n: number,
  claims = freeClaims(ownerId),
  grant?: OfflineSignedExecutionGrant,
): Promise<Fixture> {
  const signed = grant ?? (await sign(claims));
  const resultId = `7000000${n % 10}-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `receipt-${n}`,
    ownerId,
    grant: signed,
    claims,
    ticket: ticketRef(ticketId, claims),
    lifecycleSequence: n,
    operationId: `operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { claims, grant: signed, receipt: rec, output: out };
}

async function proFixture(
  ownerId: string,
  n: number,
  claims: OfflineExecutionGrantClaims,
  grant: OfflineSignedExecutionGrant,
): Promise<Fixture> {
  const resultId = `7100000${n % 10}-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `lease-receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: null,
    lifecycleSequence: n,
    operationId: `lease-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { claims, grant, receipt: rec, output: out };
}

const entry = (fixture: Fixture, output: unknown = fixture.output): Record<string, unknown> => ({
  receipt: fixture.receipt,
  grant: fixture.grant,
  output,
});

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same keying as the migration: caller + receiptId).
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

function rpcRow(row: SettleRow): Response {
  return new Response(JSON.stringify([row]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  const key = `${call.headers.authorization}|${params.p_receipt.receiptId}`;
  const known = durable.get(key);
  if (known) {
    return rpcRow(
      known.sha256 === params.p_receipt_sha256 ? { ...known.row, delivery: "replayed" } : {
        result: "offline.receipt_conflict",
        delivery: null,
        status: null,
        reason_code: null,
        financial_disposition: null,
        result_id: null,
      },
    );
  }
  const ticketless = params.p_receipt.ticket === null;
  const row: SettleRow = params.p_hold_reason !== null
    ? {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason,
      financial_disposition: ticketless ? "not_applicable" : "reserved",
      result_id: null,
    }
    : {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition: ticketless ? "not_applicable" : "consumed",
      result_id: String(params.p_receipt.resultId),
    };
  durable.set(key, { sha256: params.p_receipt_sha256, row });
  return rpcRow(row);
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

interface RouteReceipt {
  receiptId: string;
  status: string;
  reasonCode: string | null;
  financialDisposition: string;
  resultId: string | null;
  delivery: "settled" | "replayed" | "held" | "pending";
}

interface RouteRejection {
  receiptId: string;
  code: string;
  message: string;
}

interface WireAnswer {
  receipts: RouteReceipt[];
  rejected: RouteRejection[];
}

/** The 200 body checked against the 1.0 wire contract, key for key. */
async function wire(response: Response): Promise<WireAnswer> {
  const body = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(body));
  assertEquals(Object.keys(body).sort(), ["receipts", "rejected"], JSON.stringify(body));
  assert(Array.isArray(body.receipts) && Array.isArray(body.rejected));
  for (const item of body.receipts) {
    assertEquals(
      Object.keys(item).sort(),
      ["delivery", "financialDisposition", "reasonCode", "receiptId", "resultId", "status"],
      JSON.stringify(item),
    );
  }
  for (const item of body.rejected) {
    assertEquals(Object.keys(item).sort(), ["code", "message", "receiptId"], JSON.stringify(item));
  }
  return body as unknown as WireAnswer;
}

/** Every submitted receiptId is named exactly once across receipts + rejected. */
function assertNamedOnce(answer: WireAnswer, submitted: readonly string[]): void {
  const named = [
    ...answer.receipts.map((r) => r.receiptId),
    ...answer.rejected.map((r) => r.receiptId),
  ].sort();
  assertEquals(named, [...submitted].sort());
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

async function codedError(response: Response): Promise<{ code: string | null; message: string }> {
  const body = await readJson(response);
  const error = body.error as Record<string, unknown>;
  assert(error && typeof error === "object", JSON.stringify(body));
  return {
    code: typeof error.code === "string" ? error.code : null,
    message: String(error.message),
  };
}

// ---------------------------------------------------------------------------
// A01 — body-size boundary
// ---------------------------------------------------------------------------

/** A syntactically valid batch of EXACTLY `bytes` UTF-8 bytes whose single
 * entry is shape-rejected (its grant is a padding string) — the batch is
 * admitted or refused on its size alone, nothing reaches the RPC. */
function paddedBatch(bytes: number): string {
  const skeleton = JSON.stringify({
    receipts: [{ receipt: { receiptId: "pad" }, grant: "", output: null }],
  });
  const padding = bytes - new TextEncoder().encode(skeleton).byteLength;
  assert(padding >= 0);
  return JSON.stringify({
    receipts: [{ receipt: { receiptId: "pad" }, grant: "x".repeat(padding), output: null }],
  });
}

function rawPost(body: BodyInit, token: string, headers: Record<string, string> = {}): Request {
  return new Request(RECEIPTS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-forwarded-for": "203.0.113.77",
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

Deno.test(
  "A01 body-size boundary: exactly OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES is admitted, one byte more is the coded 413, and a chunked oversized stream is the same coded 413 with nothing decided",
  async () => {
    reset();
    const user = freshUser();

    const atCap = paddedBatch(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES);
    assertEquals(new TextEncoder().encode(atCap).byteLength, OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES);
    const admitted = await wire(await h.handler(rawPost(atCap, user.token)));
    assertEquals(admitted.receipts, []);
    assertEquals(admitted.rejected.map((r) => r.receiptId), ["pad"]);
    assertEquals(settleCalls().length, 0);

    const overCap = paddedBatch(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES + 1);
    const refused = await h.handler(rawPost(overCap, user.token));
    assertEquals(refused.status, 413);
    const coded = await codedError(refused);
    assertEquals(coded.code, OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE);
    assertMatch(coded.message, new RegExp(String(OFFLINE_RECEIPT_BATCH_MAX_BODY_BYTES)));
    assertEquals(settleCalls().length, 0);

    // Chunked upload: no Content-Length at all, the bytes still exceed the cap.
    const chunks = new TextEncoder().encode(overCap);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < chunks.byteLength; offset += 65_536) {
          controller.enqueue(chunks.subarray(offset, Math.min(offset + 65_536, chunks.byteLength)));
        }
        controller.close();
      },
    });
    const streamed = await h.handler(rawPost(stream, user.token));
    assertEquals(streamed.status, 413);
    assertEquals((await codedError(streamed)).code, OFFLINE_RECEIPT_BATCH_TOO_LARGE_CODE);
    assertEquals(settleCalls().length, 0);

    // The same over-cap body posted to another JSON route is the generic
    // uncoded 413 — proves the code is the receipts route's own answer.
    const elsewhere = await h.handler(
      new Request("http://edge.test/functions/v1/api/v1/sessions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${user.token}`,
          "x-forwarded-for": "203.0.113.77",
          "Content-Type": "application/json",
        },
        body: overCap,
      }),
    );
    assertEquals(elsewhere.status, 413);
    assertEquals((await codedError(elsewhere)).code, null);
  },
);

// ---------------------------------------------------------------------------
// A02 — crash between steps
// ---------------------------------------------------------------------------

Deno.test(
  "A02 crash between steps: an RPC failure on the 2nd of 3 receipts is one generic 503 with nothing partial answered; the redelivery replays the 1st and settles the other two exactly once",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const fixtures = await Promise.all(
      [1, 2, 3].map((n) => proFixture(user.sub, n, claims, grant)),
    );
    const ids = fixtures.map((f) => f.receipt.receiptId);

    let failures = 0;
    h.respond = (call) => {
      if (call.url.endsWith(SETTLE_RPC) && settleParams(call).p_receipt.receiptId === ids[1]) {
        failures += 1;
        return new Response(JSON.stringify({ message: "connection reset" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return durableRespond(call);
    };
    const { result: crashed } = await captureConsole(() =>
      post({ receipts: fixtures.map((f) => entry(f)) }, user.token)
    );
    assertEquals(crashed.status, 503);
    const body = await readJson(crashed);
    assertEquals(Object.keys(body), ["error"]);
    const error = body.error as Record<string, unknown>;
    assertEquals(typeof error.message, "string");
    assert(!String(error.message).includes("connection reset"), JSON.stringify(body));
    assertEquals(failures, 1);
    // Only the first receipt was decided; the third was never looked at.
    assertEquals(settleCalls().map((p) => p.p_receipt.receiptId), [ids[0], ids[1]]);
    assertEquals(durable.size, 1);

    h.respond = durableRespond;
    const redelivered = await wire(
      await post({ receipts: fixtures.map((f) => entry(f)) }, user.token),
    );
    assertNamedOnce(redelivered, ids);
    assertEquals(redelivered.rejected, []);
    assertEquals(
      redelivered.receipts.map((r) => [r.receiptId, r.delivery, r.status, r.financialDisposition]),
      [
        [ids[0], "replayed", "result_recorded", "not_applicable"],
        [ids[1], "settled", "result_recorded", "not_applicable"],
        [ids[2], "settled", "result_recorded", "not_applicable"],
      ],
    );
    assertEquals(durable.size, 3);
    // Exactly one settlement per receipt across both deliveries.
    const settledOnce = new Map<string, number>();
    for (const [, value] of durable) {
      settledOnce.set(
        value.row.result_id ?? "",
        (settledOnce.get(value.row.result_id ?? "") ?? 0) + 1,
      );
    }
    assertEquals([...settledOnce.values()], [1, 1, 1]);
  },
);

// ---------------------------------------------------------------------------
// A03 — interleaved account switch at the route
// ---------------------------------------------------------------------------

Deno.test(
  "A03 interleaved account switch: account B presenting A's receipt is HELD owner_mismatch in B's namespace with the ticket reserved, A then settles the same receipt, B's own receipt is independent, and a same-id/other-body receipt in B's namespace is a conflict",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const ofA = await freeFixture(a.sub, TICKET_A, 1);
    const ofB = await freeFixture(b.sub, TICKET_A, 2);
    const sameIdAsA: Fixture = {
      ...ofB,
      receipt: { ...ofB.receipt, receiptId: ofA.receipt.receiptId },
    };

    // B (the device switched accounts before draining) posts A's receipt.
    const asB = await wire(await post({ receipts: [entry(ofA)] }, b.token));
    assertEquals(asB.rejected, []);
    assertEquals(asB.receipts.length, 1);
    assertEquals(asB.receipts[0].delivery, "held");
    assertEquals(asB.receipts[0].status, "reconciliation_required");
    assertEquals(asB.receipts[0].reasonCode, "owner_mismatch");
    assertEquals(asB.receipts[0].financialDisposition, "reserved");
    assertEquals(asB.receipts[0].resultId, null);
    assertEquals(settleCalls()[0].p_hold_reason, "owner_mismatch");

    // A signs back in and drains: the SAME receipt settles for its owner.
    const asA = await wire(await post({ receipts: [entry(ofA)] }, a.token));
    assertEquals(asA.receipts.map((r) => [r.delivery, r.financialDisposition, r.resultId]), [
      ["settled", "consumed", ofA.receipt.resultId],
    ]);

    // B's OWN receipt (its own device-minted id) is a different namespace entry.
    const own = await wire(await post({ receipts: [entry(ofB)] }, b.token));
    assertEquals(own.rejected, []);
    assertEquals(own.receipts.map((r) => [r.delivery, r.resultId]), [[
      "settled",
      ofB.receipt.resultId,
    ]]);
    // A receipt of B's reusing A's receipt id is a different body under an id
    // B's namespace already holds: offline.receipt_conflict, nothing settles.
    const reused = await wire(await post({ receipts: [entry(sameIdAsA)] }, b.token));
    assertEquals(reused.receipts, []);
    assertEquals(reused.rejected.map((r) => r.code), ["offline.receipt_conflict"]);

    // Replays stay in their namespaces: A replays consumed, B replays the HOLD.
    const againA = await wire(await post({ receipts: [entry(ofA)] }, a.token));
    assertEquals(againA.receipts[0].delivery, "replayed");
    assertEquals(againA.receipts[0].financialDisposition, "consumed");
    const againB = await wire(await post({ receipts: [entry(ofA)] }, b.token));
    assertEquals(againB.receipts[0].delivery, "replayed");
    assertEquals(againB.receipts[0].reasonCode, "owner_mismatch");
    assertEquals(durable.size, 3);
    assertEquals(
      [...durable.values()].map((v) => v.row.result_id).filter((id) => id !== null).sort(),
      [ofA.receipt.resultId, ofB.receipt.resultId].sort(),
    );
  },
);

// ---------------------------------------------------------------------------
// A04 — decision-budget boundary
// ---------------------------------------------------------------------------

Deno.test(
  "A04 decision budget: 250 fresh Pro receipts are all decided in one drain, the 251st is pending with nothing durable, a rejected entry spends nothing, and the redelivery replays 250 and settles the 251st",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const fixtures: Fixture[] = [];
    for (let n = 1; n <= OFFLINE_RECEIPT_BATCH_MAX_ENTRIES + 1; n += 1) {
      fixtures.push(await proFixture(user.sub, n, claims, grant));
    }
    const malformed = { receipt: { receiptId: "malformed-first" }, grant, output: null };
    const batch = [malformed, ...fixtures.map((f) => entry(f))];
    const ids = ["malformed-first", ...fixtures.map((f) => f.receipt.receiptId)];

    const first = await wire(await post({ receipts: batch }, user.token));
    assertNamedOnce(first, ids);
    assertEquals(first.rejected.map((r) => r.receiptId), ["malformed-first"]);
    const deliveries = first.receipts.map((r) => r.delivery);
    assertEquals(
      deliveries.filter((d) => d === "settled").length,
      OFFLINE_RECEIPT_BATCH_MAX_ENTRIES,
    );
    assertEquals(deliveries.at(-1), "pending");
    const pending = first.receipts.at(-1)!;
    assertEquals(pending.receiptId, fixtures.at(-1)!.receipt.receiptId);
    assertEquals(pending.status, "pending");
    assertEquals(pending.financialDisposition, "not_applicable");
    assertEquals(pending.resultId, null);
    assertEquals(settleCalls().length, OFFLINE_RECEIPT_BATCH_MAX_ENTRIES);
    assertEquals(durable.size, OFFLINE_RECEIPT_BATCH_MAX_ENTRIES);
    for (const r of first.receipts.slice(0, -1)) {
      assertEquals(r.financialDisposition, "not_applicable");
      assertEquals(r.status, "result_recorded");
    }

    h.calls = [];
    const second = await wire(await post({ receipts: batch }, user.token));
    assertNamedOnce(second, ids);
    assertEquals(
      second.receipts.map((r) => r.delivery).filter((d) => d === "replayed").length,
      250,
    );
    assertEquals(second.receipts.at(-1)!.delivery, "settled");
    assertEquals(second.receipts.at(-1)!.resultId, fixtures.at(-1)!.receipt.resultId);
    assertEquals(settleCalls().length, OFFLINE_RECEIPT_BATCH_MAX_ENTRIES + 1);
    assertEquals(durable.size, OFFLINE_RECEIPT_BATCH_MAX_ENTRIES + 1);
  },
);

// ---------------------------------------------------------------------------
// A05 — duplicate identity in one batch, two digests
// ---------------------------------------------------------------------------

Deno.test(
  "A05 duplicate identity in ONE batch with two digests: the first decides, the second is offline.receipt_conflict, both are named, nothing settles twice",
  async () => {
    reset();
    const user = freshUser();
    const original = await freeFixture(user.sub, TICKET_A, 1);
    const forged: Fixture = {
      ...original,
      receipt: { ...original.receipt, lifecycleSequence: 2 },
    };
    const answer = await wire(
      await post({ receipts: [entry(original), entry(forged), entry(original)] }, user.token),
    );
    assertEquals(answer.receipts.map((r) => [r.receiptId, r.delivery]), [
      ["receipt-1", "settled"],
      ["receipt-1", "replayed"],
    ]);
    assertEquals(answer.rejected.map((r) => [r.receiptId, r.code]), [
      ["receipt-1", "offline.receipt_conflict"],
    ]);
    assertEquals(durable.size, 1);
    assertEquals([...durable.values()][0].row.result_id, original.receipt.resultId);
    assertEquals(settleCalls().length, 3);

    // The other order: the forged body first wins the id, the original conflicts.
    reset();
    const other = freshUser();
    const fresh = await freeFixture(other.sub, TICKET_A, 1);
    const fresh2: Fixture = { ...fresh, receipt: { ...fresh.receipt, lifecycleSequence: 2 } };
    const reversed = await wire(
      await post({ receipts: [entry(fresh2), entry(fresh)] }, other.token),
    );
    assertEquals(reversed.receipts.map((r) => r.delivery), ["settled"]);
    assertEquals(reversed.rejected.map((r) => r.code), ["offline.receipt_conflict"]);
    assertEquals(durable.size, 1);
  },
);

// ---------------------------------------------------------------------------
// A06 — boundary values
// ---------------------------------------------------------------------------

Deno.test(
  "A06 boundary values: zero/negative/fractional/unsafe/string sequences, malformed or offset instants, over-long or spaced ids and extra fields are refused per entry without reaching the RPC; the max safe integer and far-past/far-future instants are admitted",
  async () => {
    reset();
    const user = freshUser();
    const good = await freeFixture(user.sub, TICKET_A, 1);
    const variants: [string, Record<string, unknown>][] = [
      ["seq-0", { lifecycleSequence: 0 }],
      ["seq-neg", { lifecycleSequence: -1 }],
      ["seq-frac", { lifecycleSequence: 1.5 }],
      ["seq-unsafe", { lifecycleSequence: 2 ** 53 }],
      ["seq-str", { lifecycleSequence: "1" }],
      ["seq-null", { lifecycleSequence: null }],
      ["gen-0", { ticket: { ...good.receipt.ticket, generation: 0 } }],
      ["gen-frac", { ticket: { ...good.receipt.ticket, generation: 3.5 } }],
      ["ticket-extra", { ticket: { ...good.receipt.ticket, extra: 1 } }],
      ["queued-offset", { queuedAt: "2026-09-08T12:00:00+00:00" }],
      ["queued-month13", { queuedAt: "2026-13-40T00:00:00.000Z" }],
      ["queued-micro", { queuedAt: "2026-09-08T12:00:00.000000Z" }],
      ["queued-empty", { queuedAt: "" }],
      ["queued-number", { queuedAt: 1_757_332_800_000 }],
      ["owner-upper", { ownerId: user.sub.toUpperCase() }],
      ["digest-upper", { fullOutputSha256: good.receipt.fullOutputSha256.toUpperCase() }],
      ["digest-short", { fullOutputSha256: good.receipt.fullOutputSha256.slice(1) }],
      ["billing-other", { billingDisposition: "consumed" }],
      ["native-time", { nativeTime: { clock: "x" } }],
      ["settlement-leak", { settlement: null, settledAt: null }],
    ];
    const entries: Record<string, unknown>[] = variants.map(([id, patch]) => ({
      receipt: { ...good.receipt, receiptId: id, ...patch },
      grant: good.grant,
      output: good.output,
    }));
    // Ids the shape validator must refuse but the batch can still attribute.
    entries.push({
      receipt: { ...good.receipt, receiptId: "a".repeat(128) },
      grant: good.grant,
      output: good.output,
    });
    const maxSafe = {
      ...good.receipt,
      receiptId: "seq-max",
      lifecycleSequence: Number.MAX_SAFE_INTEGER,
    };
    const farPast = {
      ...good.receipt,
      receiptId: "queued-past",
      queuedAt: "0001-01-01T00:00:00.000Z",
    };
    const farFuture = {
      ...good.receipt,
      receiptId: "queued-future",
      queuedAt: "9999-12-31T23:59:59.999Z",
    };
    entries.push(
      { receipt: maxSafe, grant: good.grant, output: good.output },
      { receipt: farPast, grant: good.grant, output: good.output },
      { receipt: farFuture, grant: good.grant, output: good.output },
      entry(good),
    );
    const ids = entries.map((e) => (e.receipt as OfflineDeviceReceipt).receiptId);

    const answer = await wire(await post({ receipts: entries }, user.token));
    assertNamedOnce(answer, ids);
    assertEquals(
      answer.rejected.map((r) => r.receiptId).sort(),
      [...variants.map(([id]) => id)].sort(),
      "every malformed variant is refused per entry",
    );
    for (const r of answer.rejected) assertEquals(r.code, "offline.invalid_input");
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery]),
      [
        ["a".repeat(128), "settled"],
        ["seq-max", "settled"],
        ["queued-past", "settled"],
        ["queued-future", "settled"],
        ["receipt-1", "settled"],
      ],
    );
    assertEquals(settleCalls().length, 5, "no malformed variant reached the RPC");

    // Ids the batch cannot attribute at all are a 400 for the batch, nothing decided.
    h.calls = [];
    for (const bad of ["", "a".repeat(129), "has space", 7, null]) {
      const response = await post(
        {
          receipts: [entry(good), {
            receipt: { ...good.receipt, receiptId: bad },
            grant: good.grant,
            output: good.output,
          }],
        },
        user.token,
      );
      assertEquals(response.status, 400, String(bad));
      assertEquals((await codedError(response)).code, "offline.invalid_input");
    }
    for (const body of [{ receipts: [] }, { receipts: {} }, { receipts: null }, {}, []]) {
      const response = await post(body, user.token);
      assertEquals(response.status, 400, JSON.stringify(body));
    }
    assertEquals(settleCalls().length, 0);
  },
);

// ---------------------------------------------------------------------------
// A15 — the shipping route forwards a lease receipt executed after the lease
// ---------------------------------------------------------------------------

Deno.test(
  "A15 route: a Pro receipt whose declared execution instant (queuedAt) is a month after its 3-day lease AND after the recorded entitlement expiry must reach the RPC as a HOLD, not as a plain settlement",
  async () => {
    reset();
    const user = freshUser();
    // Lease issued 40 days ago (3-day lease, entitlement expiry 10 days ago).
    const claims = proClaims(user.sub, nowSeconds() - 40 * DAY);
    const grant = await sign(claims);
    const onTime = await proFixture(user.sub, 1, claims, grant);
    const late: Fixture = {
      ...(await proFixture(user.sub, 2, claims, grant)),
    };
    late.receipt = { ...late.receipt, queuedAt: iso(nowSeconds() - DAY) };
    onTime.receipt = { ...onTime.receipt, queuedAt: iso(claims.iat + DAY) };

    const answer = await wire(await post({ receipts: [entry(onTime), entry(late)] }, user.token));
    assertNamedOnce(answer, [onTime.receipt.receiptId, late.receipt.receiptId]);
    assertEquals(answer.rejected, []);
    // Honest late delivery of an in-window rating settles.
    assertEquals(
      [answer.receipts[0].delivery, answer.receipts[0].financialDisposition],
      ["settled", "not_applicable"],
    );
    // Execution declared 37 days after the lease ended is ambiguous evidence.
    const calls = settleCalls();
    assertEquals(calls.length, 2);
    assertEquals(calls[0].p_hold_reason, null);
    assert(
      calls[1].p_hold_reason !== null,
      `the route forwarded an out-of-lease execution as a plain settlement: ${
        JSON.stringify(answer.receipts[1])
      }`,
    );
    assertEquals(answer.receipts[1].delivery, "held");
    assertEquals(answer.receipts[1].financialDisposition, "not_applicable");
  },
);

// ---------------------------------------------------------------------------
// Live postgres half — the REAL settle_offline_receipt().
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

async function asUser(tx: Tx, n: number, sessionOf: number | null = n): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (sessionOf !== null) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(sessionOf)}"}'`);
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
  rec: OfflineDeviceReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(sqlOutput(out))},
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

async function registerDevice(sql: Sql, n: number, key: string): Promise<void> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
}

async function issueGrant(sql: Sql, n: number, key: string, requested: number): Promise<LiveGrant> {
  await registerDevice(sql, n, key);
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
  return { claims, grant: await sign(claims) };
}

async function issueFreeGrant(sql: Sql, n: number, key: string, requested = 2): Promise<LiveGrant> {
  const issued = await issueGrant(sql, n, key, requested);
  assert(issued.claims.allocation && issued.claims.allocation.ticketIds.length === requested);
  return issued;
}

async function makePremium(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, expires_at)
     values ('${U(n)}', true, now() + interval '30 days')
     on conflict (user_id) do update set premium = true, expires_at = now() + interval '30 days'`,
  );
}

/** A Pro lease. With `aged`, the lease row is written the way issue_offline_grant()
 * would have written it `issuedDaysAgo` days ago (grants are immutable, so the
 * disposable DB's owner inserts the historical row; guard_offline_grant() still
 * runs and requires the effective entitlement at insert time). */
async function issueLeaseGrant(
  sql: Sql,
  n: number,
  key: string,
  aged: { issuedDaysAgo: number; leaseDays: number } | null = null,
): Promise<LiveGrant> {
  if (aged === null) {
    const issued = await issueGrant(sql, n, key, 0);
    assertEquals(issued.claims.entitlementSource, "verified_store");
    assertEquals(issued.claims.allocation, undefined);
    return issued;
  }
  await registerDevice(sql, n, key);
  const [row] = await sql.unsafe<
    { grant_id: string; issued_at: string; expires_at: string; entitlement_expires_at: string }[]
  >(
    `insert into public.offline_grants
       (user_id, device_id, entitlement_source, generation, issued_at, expires_at, entitlement_expires_at)
     select d.user_id, d.id, 'verified_store', 1,
       now() - interval '${aged.issuedDaysAgo} days',
       now() - interval '${aged.issuedDaysAgo - aged.leaseDays} days',
       b.expires_at
     from public.offline_devices d
     join public.billing_entitlements b on b.user_id = d.user_id
     where d.user_id = '${U(n)}' and d.installation_key_id = '${key}'
     returning id as grant_id, issued_at, expires_at, entitlement_expires_at`,
  );
  const claims = offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: row.grant_id,
      generation: 1,
      entitlement_source: "verified_store",
      issued_at: new Date(row.issued_at).toISOString(),
      expires_at: new Date(row.expires_at).toISOString(),
      entitlement_expires_at: new Date(row.entitlement_expires_at).toISOString(),
      ticket_ids: [],
    },
    { issuer: ISSUER, ownerId: U(n), installationKeyId: key, release: RELEASE },
  );
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string | null,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `receipt-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketId === null ? null : ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

async function shotCount(sql: Sql, where: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where ${where}`,
  );
  return Number(count);
}

async function settlementRows(
  sql: Sql,
  n: number,
): Promise<
  { receipt_id: string; status: string; reason_code: string | null; ticket_id: string | null }[]
> {
  return await sql.unsafe(
    `select receipt_id, status, reason_code, ticket_id::text as ticket_id
     from public.offline_receipt_settlements where user_id = '${U(n)}' order by receipt_id`,
  );
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

async function reservePermit(sql: Sql, n: number, key: string): Promise<string> {
  const [{ result }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ result: string }[]>(
      `select r.result from public.reserve_analysis_permit('${key}') r`,
    ));
  return result;
}

async function releaseTicket(tx: Tx, ticketId: string): Promise<string> {
  const [{ result }] = await tx.unsafe<{ result: string }[]>(
    `select public.release_offline_ticket('${ticketId}', 'unused_ticket_returned') as result`,
  );
  return result;
}

/** SQLSTATE of a refused statement, or null when it was allowed. */
async function sqlState(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "unknown";
  }
}

Deno.test({
  name:
    "A07 live: two receipts for the SAME ticket racing in parallel transactions — exactly one consumed, the other a durable conflicting_receipt HOLD, one shot, one consumed ledger event, the second ticket untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("race-ticket"));
      const [ticketA, ticketB] = issued.claims.allocation!.ticketIds;
      const first = await liveReceipt(U(1), issued, ticketA, "race-1");
      const second = await liveReceipt(U(1), issued, ticketA, "race-2", { lifecycleSequence: 2 });

      const [r1, r2] = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, first.receipt, first.output, null)),
        inTx(sql, 1, (tx) => settle(tx, second.receipt, second.output, null)),
      ]);
      const outcomes = [r1, r2].map((r) =>
        `${r.delivery}:${r.financial_disposition}:${r.reason_code}`
      ).sort();
      assertEquals(outcomes, ["held:reserved:conflicting_receipt", "settled:consumed:null"]);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, `offline_ticket_id = '${ticketA}'`), 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
      const rows = await settlementRows(sql, 1);
      assertEquals(rows.length, 2);
      assertEquals(rows.filter((r) => r.status === "result_recorded").length, 1);

      // Both replay their own verdict; the HOLD never becomes a rating later.
      const again = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, second.receipt, second.output, null)),
        inTx(sql, 1, (tx) => settle(tx, first.receipt, first.output, null)),
      ]);
      assertEquals(again.map((r) => r.delivery), ["replayed", "replayed"]);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, `offline_ticket_id = '${ticketA}'`), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A08 live: the SAME receipt delivered twice concurrently — one settled, one replayed, one settlement row, one consumed event, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("race-dup"));
      const [ticketA] = issued.claims.allocation!.ticketIds;
      const one = await liveReceipt(U(2), issued, ticketA, "dup");

      const results = await Promise.all(
        [0, 1, 2].map(() => inTx(sql, 2, (tx) => settle(tx, one.receipt, one.output, null))),
      );
      assertEquals(results.map((r) => r.delivery).sort(), ["replayed", "replayed", "settled"]);
      for (const r of results) {
        assertEquals(r.status, "result_recorded");
        assertEquals(r.financial_disposition, "consumed");
        assertEquals(r.result_id, one.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, `offline_ticket_id = '${ticketA}'`), 1);
      assertEquals((await settlementRows(sql, 2)).length, 1);
      assertEquals(await counters(sql, 2), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A09 live: a receipt racing the device's explicit return of the same ticket — exactly one terminal ledger event; consumed cannot be released, released is a conflicting_receipt HOLD and never a rating; the ticket keeps counting either way",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      const issued = await issueFreeGrant(sql, 3, KEY("race-release"));
      const [ticketA] = issued.claims.allocation!.ticketIds;
      const one = await liveReceipt(U(3), issued, ticketA, "vs-release");

      const [settled, released] = await Promise.all([
        inTx(sql, 3, (tx) => settle(tx, one.receipt, one.output, null)),
        inTx(sql, 3, (tx) => releaseTicket(tx, ticketA)),
      ]);
      const events = await ledgerEvents(sql, ticketA);
      assertEquals(events.length, 2, JSON.stringify(events));
      assertEquals(events[0], "allocated");
      if (events[1] === "consumed") {
        assertEquals(settled.delivery, "settled");
        assertEquals(settled.financial_disposition, "consumed");
        assertEquals(released, "offline.ticket_consumed");
        assertEquals(await shotCount(sql, `offline_ticket_id = '${ticketA}'`), 1);
        assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      } else {
        assertEquals(events[1], "released");
        assertEquals(released, "accepted");
        assertEquals(settled.delivery, "held");
        assertEquals(settled.reason_code, "conflicting_receipt");
        assertEquals(settled.financial_disposition, "reserved");
        assertEquals(await shotCount(sql, `offline_ticket_id = '${ticketA}'`), 0);
        // A returned ticket is not a re-credit: it still counts.
        assertEquals(await counters(sql, 3), { held: 2, scored: 0 });
      }
      // Whatever won, the redelivery replays and nothing else moves.
      const again = await inTx(sql, 3, (tx) => settle(tx, one.receipt, one.output, null));
      assertEquals(again.delivery, "replayed");
      assertEquals(await ledgerEvents(sql, ticketA), events);
      const releaseAgain = await inTx(sql, 3, (tx) => releaseTicket(tx, ticketA));
      assertEquals(releaseAgain, events[1] === "consumed" ? "offline.ticket_consumed" : "accepted");
      assertEquals(await ledgerEvents(sql, ticketA), events);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A10 live: cross-account namespace — B settling A's receipt (with and without the edge's hold reason) is HELD owner_mismatch under B with A's ticket untouched; A settles it once; B's own same-named receipt is independent",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      await createUser(sql, 5);
      const ofA = await issueFreeGrant(sql, 4, KEY("owner-a"));
      const ofB = await issueFreeGrant(sql, 5, KEY("owner-b"));
      const [ticketA1, ticketA2] = ofA.claims.allocation!.ticketIds;
      const [ticketB1] = ofB.claims.allocation!.ticketIds;
      const a1 = await liveReceipt(U(4), ofA, ticketA1, "shared");
      const a2 = await liveReceipt(U(4), ofA, ticketA2, "shared-2", { lifecycleSequence: 2 });
      const b1 = await liveReceipt(U(5), ofB, ticketB1, "own-b");
      const reusedId = {
        receipt: { ...b1.receipt, receiptId: a1.receipt.receiptId, lifecycleSequence: 2 },
        output: b1.output,
      };

      // As the route would: hold reason derived at the edge.
      const heldWithReason = await inTx(
        sql,
        5,
        (tx) => settle(tx, a1.receipt, a1.output, "owner_mismatch"),
      );
      assertEquals(heldWithReason.delivery, "held");
      assertEquals(heldWithReason.reason_code, "owner_mismatch");
      assertEquals(heldWithReason.financial_disposition, "reserved");
      // Bypassing the edge: the SQL's own owner check must hold it too.
      const heldBySql = await inTx(sql, 5, (tx) => settle(tx, a2.receipt, a2.output, null));
      assertEquals(heldBySql.delivery, "held");
      assertEquals(heldBySql.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticketA1), ["allocated"]);
      assertEquals(await ledgerEvents(sql, ticketA2), ["allocated"]);
      assertEquals(await shotCount(sql, `user_id = '${U(5)}'`), 0);
      assertEquals(await counters(sql, 4), { held: 2, scored: 0 });
      assertEquals(await counters(sql, 5), { held: 2, scored: 0 });

      // The owner settles both, once each.
      const ownA1 = await inTx(sql, 4, (tx) => settle(tx, a1.receipt, a1.output, null));
      const ownA2 = await inTx(sql, 4, (tx) => settle(tx, a2.receipt, a2.output, null));
      assertEquals([ownA1.delivery, ownA2.delivery], ["settled", "settled"]);
      assertEquals(await ledgerEvents(sql, ticketA1), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketA2), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 4), { held: 0, scored: 2 });

      // B's own receipt settles B's ticket — the HOLDs it carries for A's do not interfere.
      const ownB = await inTx(sql, 5, (tx) => settle(tx, b1.receipt, b1.output, null));
      assertEquals(ownB.delivery, "settled");
      assertEquals(ownB.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketB1), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 5), { held: 1, scored: 1 });
      // B's body under A's receipt id (an id B's namespace already holds with
      // another digest) is a conflict — no second rating, no ledger movement.
      const reused = await inTx(
        sql,
        5,
        (tx) => settle(tx, reusedId.receipt, reusedId.output, null),
      );
      assertEquals(reused.result, "offline.receipt_conflict");
      assertEquals(reused.delivery, null);
      assertEquals(await ledgerEvents(sql, ticketB1), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, `user_id = '${U(5)}'`), 1);

      const rowsB = await settlementRows(sql, 5);
      assertEquals(
        rowsB.map((r) => r.status).sort(),
        ["reconciliation_required", "reconciliation_required", "result_recorded"],
      );
      // Nothing of B's shows up in A's namespace and vice versa.
      const rowsA = await settlementRows(sql, 4);
      assertEquals(rowsA.map((r) => r.status), ["result_recorded", "result_recorded"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A11 live: unauthorised roles — anon, service_role, an authenticated caller without a session or with ANOTHER user's session cannot settle; authenticated cannot read/insert/update offline_receipt_settlements nor call record_offline_lease_shot(); the owner path still works",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      await createUser(sql, 7);
      const issued = await issueFreeGrant(sql, 6, KEY("roles"));
      const [ticketA] = issued.claims.allocation!.ticketIds;
      const one = await liveReceipt(U(6), issued, ticketA, "roles");

      const denied = async (setup: (tx: Tx) => Promise<unknown>): Promise<string | null> =>
        await sqlState(() =>
          sql.begin(async (raw) => {
            const tx = raw as unknown as Tx;
            await setup(tx);
            await settle(tx, one.receipt, one.output, null);
          })
        );

      assertEquals(await denied((tx) => tx.unsafe(`set local role anon`)), "42501");
      assertEquals(await denied((tx) => tx.unsafe(`set local role service_role`)), "42501");
      assertEquals(await denied((tx) => asUser(tx, 6, null)), "42501", "no session");
      assertEquals(await denied((tx) => asUser(tx, 6, 7)), "42501", "another user's session");
      assertEquals(
        await denied((tx) => tx.unsafe(`set local role authenticated`)),
        "42501",
        "no sub",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals((await settlementRows(sql, 6)).length, 0);

      // Direct table access from a client role.
      for (
        const statement of [
          `select count(*) from public.offline_receipt_settlements`,
          `insert into public.offline_receipt_settlements (user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence, status, financial_disposition, receipt)
         values ('${U(6)}', 'forged', '${"a".repeat(64)}', '${U(6)}', 'k', '${GRANT_ID}', '${
            "b".repeat(64)
          }', 'op', 'res', '${
            "c".repeat(64)
          }', 'joint_verification_required', 1, 'result_recorded', 'consumed', '{}'::jsonb)`,
          `update public.offline_receipt_settlements set status = 'result_recorded'`,
          `delete from public.offline_receipt_settlements`,
          `select api_private.record_offline_lease_shot('${GRANT_ID}', '{}'::jsonb)`,
        ]
      ) {
        const state = await sqlState(() => inTx(sql, 6, (tx) => tx.unsafe(statement)));
        assertEquals(state, "42501", statement);
      }
      for (const role of ["anon", "service_role"]) {
        const state = await sqlState(() =>
          sql.begin(async (raw) => {
            await raw.unsafe(`set local role ${role}`);
            await raw.unsafe(`select count(*) from public.offline_receipt_settlements`);
          })
        );
        assertEquals(state, "42501", role);
      }

      // The allowed path is intact.
      const own = await inTx(sql, 6, (tx) => settle(tx, one.receipt, one.output, null));
      assertEquals(own.delivery, "settled");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A12 live: free-rating conservation — one consumed offline + one outstanding ticket saturate the two lifetime ratings: replays add nothing, an online permit is refused, a HOLD keeps its ticket counted, an explicit return is not a re-credit, a lease refresh mints nothing",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      const key = KEY("conserve");
      const issued = await issueFreeGrant(sql, 8, key);
      const [ticketA, ticketB] = issued.claims.allocation!.ticketIds;
      assertEquals(await counters(sql, 8), { held: 2, scored: 0 });
      assertEquals(await reservePermit(sql, 8, `${key}-p0`), "access.paywall_required");

      const a = await liveReceipt(U(8), issued, ticketA, "conserve-a");
      assertEquals(
        (await inTx(sql, 8, (tx) => settle(tx, a.receipt, a.output, null))).delivery,
        "settled",
      );
      assertEquals(await counters(sql, 8), { held: 1, scored: 1 });
      for (let i = 0; i < 3; i += 1) {
        assertEquals(
          (await inTx(sql, 8, (tx) => settle(tx, a.receipt, a.output, null))).delivery,
          "replayed",
        );
      }
      assertEquals(await counters(sql, 8), { held: 1, scored: 1 });
      assertEquals(await reservePermit(sql, 8, `${key}-p1`), "access.paywall_required");

      // Ticket B: an ambiguous receipt (no output) → HOLD, the ticket still counts.
      const b = await liveReceipt(U(8), issued, ticketB, "conserve-b", { lifecycleSequence: 2 });
      const held = await inTx(sql, 8, (tx) => settle(tx, b.receipt, null, null));
      assertEquals([held.delivery, held.reason_code, held.financial_disposition], [
        "held",
        "evidence_missing",
        "reserved",
      ]);
      assertEquals(await counters(sql, 8), { held: 1, scored: 1 });
      assertEquals(await reservePermit(sql, 8, `${key}-p2`), "access.paywall_required");
      // The redelivery WITH the output is the same receipt: the HOLD replays, nothing consumed.
      const withOutput = await inTx(sql, 8, (tx) => settle(tx, b.receipt, b.output, null));
      assertEquals([withOutput.delivery, withOutput.reason_code], ["replayed", "evidence_missing"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);

      // The device returns the held ticket: released, still counted, no permit.
      assertEquals(await inTx(sql, 8, (tx) => releaseTicket(tx, ticketB)), "accepted");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      assertEquals(await counters(sql, 8), { held: 1, scored: 1 });
      assertEquals(await reservePermit(sql, 8, `${key}-p3`), "access.paywall_required");

      // A fresh receipt for the released ticket is a conflicting HOLD, never a rating.
      const c = await liveReceipt(U(8), issued, ticketB, "conserve-c", { lifecycleSequence: 3 });
      const conflict = await inTx(sql, 8, (tx) => settle(tx, c.receipt, c.output, null));
      assertEquals([conflict.delivery, conflict.reason_code], ["held", "conflicting_receipt"]);
      assertEquals(await shotCount(sql, `user_id = '${U(8)}'`), 1);

      // A lease refresh / new allocation request mints nothing more.
      const refreshed = await inTx(sql, 8, async (tx) => {
        const rows = await tx.unsafe<{ row: Record<string, unknown> }[]>(
          `select to_jsonb(g) as row from public.issue_offline_grant('${key}', 2) g`,
        );
        return rows[0].row;
      });
      const reissuedTickets = Array.isArray(refreshed.ticket_ids) ? refreshed.ticket_ids : [];
      assert(
        !reissuedTickets.includes(ticketA) && reissuedTickets.every((t) => t === ticketB),
        JSON.stringify(refreshed),
      );
      assertEquals(await counters(sql, 8), { held: 1, scored: 1 });
      assertEquals(await reservePermit(sql, 8, `${key}-p4`), "access.paywall_required");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A13 live: a Pro lease receipt that declares execution (queuedAt) AFTER the lease AND the entitlement expired must HOLD as ambiguous evidence, not be recorded as a delivered rating",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      await makePremium(sql, 9);
      const issued = await issueLeaseGrant(sql, 9, KEY("lapsed-lease"), {
        issuedDaysAgo: 40,
        leaseDays: 7,
      });
      // The subscription lapsed 20 days ago — 13 days after the lease ended.
      await sql.unsafe(
        `update public.billing_entitlements set premium = false, expires_at = now() - interval '20 days'
         where user_id = '${U(9)}'`,
      );
      const [{ premium }] = await inTx(
        sql,
        9,
        (tx) => tx.unsafe<{ premium: boolean }[]>(`select a.premium from public.access_state() a`),
      );
      assertEquals(premium, false, "the entitlement is verifiably lapsed");

      // Honest late delivery: rated inside the lease window, reported today.
      const onTime = await liveReceipt(U(9), issued, null, "on-time", {
        queuedAt: iso(issued.claims.iat + DAY),
      });
      const recorded = await inTx(sql, 9, (tx) => settle(tx, onTime.receipt, onTime.output, null));
      assertEquals(
        [recorded.delivery, recorded.status, recorded.financial_disposition],
        ["settled", "result_recorded", "not_applicable"],
      );
      assertEquals(await shotCount(sql, `user_id = '${U(9)}'`), 1);

      // The device says it rated THIS shot yesterday — 32 days after the lease
      // ended and 19 days after the entitlement lapsed.
      const late = await liveReceipt(U(9), issued, null, "lapsed", {
        lifecycleSequence: 2,
        queuedAt: new Date(Date.now() - DAY * 1000).toISOString(),
      });
      const verdict = await inTx(sql, 9, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals(verdict.financial_disposition, "not_applicable");
      assertEquals(
        [verdict.delivery, verdict.status],
        ["held", "reconciliation_required"],
        `a rating the lease never authorized was recorded: ${JSON.stringify(verdict)}`,
      );
      assertEquals(await shotCount(sql, `user_id = '${U(9)}'`), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "A14 live: a free-ticket receipt that declares execution BEFORE its grant existed (clock rollback) still consumes exactly one ticket and never a second — conservation holds whatever the clock says",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("expired-free"));
      const [ticketA] = issued.claims.allocation!.ticketIds;
      const late = await liveReceipt(U(10), issued, ticketA, "expired", {
        queuedAt: iso(issued.claims.iat - 30 * DAY),
      });
      const verdict = await inTx(sql, 10, (tx) => settle(tx, late.receipt, late.output, null));
      assert(
        verdict.result === "accepted" && verdict.delivery !== "pending",
        JSON.stringify(verdict),
      );
      if (verdict.delivery === "settled") {
        assertEquals(verdict.financial_disposition, "consumed");
        assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
        assertEquals(await counters(sql, 10), { held: 1, scored: 1 });
      } else {
        assertEquals(verdict.delivery, "held");
        assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
        assertEquals(await counters(sql, 10), { held: 2, scored: 0 });
      }
      // A second receipt for the same ticket, however it is timed, never rates twice.
      const again = await liveReceipt(U(10), issued, ticketA, "expired-2", {
        lifecycleSequence: 2,
      });
      const second = await inTx(sql, 10, (tx) => settle(tx, again.receipt, again.output, null));
      assertEquals(second.delivery, "held");
      assertEquals(second.reason_code, "conflicting_receipt");
      assert((await shotCount(sql, `offline_ticket_id = '${ticketA}'`)) <= 1);
      assertEquals(
        await reservePermit(sql, 10, `${KEY("expired-free")}-p`),
        "access.paywall_required",
      );
    } finally {
      await sql.end();
    }
  },
});
