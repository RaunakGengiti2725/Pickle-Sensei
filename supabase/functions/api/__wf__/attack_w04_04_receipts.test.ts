// W04-04 ADVERSARIAL TESTS — POST /v1/offline/receipts + settle_offline_receipt().
// Candidate: devin/pp/w04-04/impl-r6 @ 1b09289eaf11e7ee895c9bfc230b6e2206d62df2.
//
// Each Deno.test below is one attack at a failure boundary of the delayed
// receipt reconciliation. The candidate's own tests are NOT modified; this
// file only adds attacks. Two halves like the candidate suite:
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer with a durable in-memory stand-in for the RPC);
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with every
//     migration applied (./xc_pg_up.sh, XC_PG_URL). Without XC_PG_URL the
//     postgres half is `ignore`d — an ignored run is NOT a pass.
//
// Attacks (A1..A10). A test that FAILS on the candidate is a confirmed break;
// its expectation states the supported-path behaviour the product invariants
// and the frozen wire contract require.
//
//   A1  capacity: the device drains EVERY pending receipt in one batch
//       (apps/mobile/src/data/offlineWallet.ts openPresentation → submission),
//       so 26 pending receipts must each be answered — not 400 for the batch.
//   A2  crash between entries: a database failure on the 2nd of 3 entries is a
//       503 for the batch; the 1st stays durable; the redelivery replays it
//       and settles the rest exactly once.
//   A3  boundary values in one batch: each malformed entry is rejected by its
//       own id without reaching the database, the maximal valid one settles,
//       every id appears exactly once, the mobile parser reads the answer.
//   A4  clock boundaries: a grant that expired 393 days ago and a receipt
//       queued in 2999 still settle (consumption is settled against the
//       ledger, not the clock).
//   A5  corrupt durable state: an RPC row contradicting the receipt is a 503,
//       never a verdict the device would store as final.
//   A6  live: concurrent double submit (same receipt, two connections) and a
//       concurrent second result for the same ticket — one consumed event,
//       one shot, free-rating conservation.
//   A7  live: client crash before commit — settlement + consumption roll back
//       together; the redelivery settles (not replays).
//   A8  live: interleaved account switch on one device — user B presents user
//       A's receipt: HOLD owner_mismatch in B's namespace, nothing about A's
//       ticket or budget moves, A settles it once afterwards.
//   A9  live: unauthorised roles for the new SQL surfaces — anon and
//       service_role cannot settle, authenticated cannot read a lineage,
//       service_role can (allowed path), anon cannot read settlements.
//   A10 live: a Pro (no-ticket) receipt answered result_recorded must leave the
//       rated shot on the server (the app marks the local shot synced exactly
//       as a successful shot.sync does on result_recorded — W05-07 contract).

import postgres from "postgres";
import { assert, assertEquals, assertMatch } from "@std/assert";
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
  importOfflineGrantVerificationKey,
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
const CONSUME_RPC = "/rest/v1/rpc/consume_offline_ticket";
const RELEASE_RPC = "/rest/v1/rpc/release_offline_ticket";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-444444444440";
const TICKET_A = "65555555-5555-4555-8555-555555555540";
const TICKET_B = "65555555-5555-4555-8555-555555555541";
const DAY = 86_400;
/** What the device drain presents: every pending receipt of the owner in ONE
 * batch (offlineWallet.ts openPresentation has no chunking). A Pro lease is
 * ≤ 7 days and never limits how many ratings a disconnected device renders. */
const PENDING_RECEIPTS_AFTER_A_WEEK_OFFLINE = 26;

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
  const sub = `aaaaaaaa-0404-4000-8000-a77ac${String(userSeq).padStart(7, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(
  ownerId: string,
  options: { issuedAt?: number; expiresAt?: number } = {},
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
      expires_at: iso(issuedAt + 7 * DAY),
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

/** The flat output the device durably delivered (consume_offline_ticket()'s
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
        applicable: true,
        severity: 0.1,
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

interface Entry {
  receipt: OfflineDeviceReceipt;
  grant: OfflineSignedExecutionGrant;
  output: Record<string, unknown> | null;
}

async function freeEntry(
  ownerId: string,
  ticketId: string,
  n: number,
  options: { claims?: OfflineExecutionGrantClaims; queuedAt?: string } = {},
): Promise<Entry & { claims: OfflineExecutionGrantClaims }> {
  const claims = options.claims ?? freeClaims(ownerId);
  const grant = await sign(claims);
  const resultId = `7000000${n % 10}-0404-4000-8000-a77ac000${String(n).padStart(4, "0")}`;
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
    queuedAt: options.queuedAt,
  });
  return { claims, grant, receipt: rec, output: out };
}

async function proEntry(
  ownerId: string,
  grant: OfflineSignedExecutionGrant,
  claims: OfflineExecutionGrantClaims,
  n: number,
): Promise<Entry> {
  const resultId = crypto.randomUUID();
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `pro-receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: null,
    lifecycleSequence: n,
    operationId: `pro-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { receipt: rec, grant, output: out };
}

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the migration: first delivery
// settles/holds and is remembered by (caller, receiptId, digest); the same
// receipt again replays; the same id with another digest is a conflict).
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

function rpcJson(row: SettleRow, status = 200): Response {
  return new Response(JSON.stringify([row]), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The migration casts ownerId / grantId / ticket ids to uuid before anything
 * else and answers offline.invalid_input when a cast fails (nothing durable). */
function castsAsSql(receipt: Record<string, unknown>): boolean {
  const ticket = receipt.ticket;
  const ids = [receipt.ownerId, receipt.grantId];
  if (ticket !== null && typeof ticket === "object") {
    const ref = ticket as Record<string, unknown>;
    ids.push(ref.allocationId, ref.ticketId);
  }
  return ids.every((id) => typeof id === "string" && UUID_RE.test(id));
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  const key = `${call.headers.authorization}|${params.p_receipt.receiptId}`;
  const known = durable.get(key);
  let row: SettleRow;
  if (!castsAsSql(params.p_receipt)) {
    row = {
      result: "offline.invalid_input",
      delivery: null,
      status: null,
      reason_code: null,
      financial_disposition: null,
      result_id: null,
    };
  } else if (known) {
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
  return rpcJson(row);
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

function wire(body: Record<string, unknown>): WireAnswer {
  assertEquals(Object.keys(body).sort(), ["receipts", "rejected"], JSON.stringify(body));
  assert(Array.isArray(body.receipts) && Array.isArray(body.rejected), JSON.stringify(body));
  return body as unknown as WireAnswer;
}

/** A faithful mirror of apps/mobile/src/data/api.ts parseOfflineReceiptVerdicts():
 * null is the app's unreadableAnswer() — the drain fails, every receipt stays
 * queued. */
function mobileVerdicts(
  value: unknown,
  submittedIds: readonly string[],
): Map<string, "accepted" | "refused" | "held"> | null {
  const statuses = new Map<string, "accepted" | "refused" | "held">([
    ["result_recorded", "accepted"],
    ["unused_ticket_returned", "refused"],
    ["pending", "held"],
    ["reconciliation_required", "held"],
    ["support_review_required", "held"],
  ]);
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  if (!isObject(value)) return null;
  const receipts = value.receipts;
  const rejected = value.rejected ?? [];
  if (!Array.isArray(receipts) || !Array.isArray(rejected)) return null;
  const verdicts = new Map<string, "accepted" | "refused" | "held">();
  for (const entry of receipts) {
    if (!isObject(entry) || !isText(entry.receiptId) || !isText(entry.status)) return null;
    const verdict = statuses.get(entry.status);
    if (verdict === undefined || verdicts.has(entry.receiptId)) return null;
    verdicts.set(entry.receiptId, verdict);
  }
  for (const entry of rejected) {
    if (!isObject(entry) || !isText(entry.receiptId) || !isText(entry.code)) return null;
    if (verdicts.has(entry.receiptId)) return null;
    verdicts.set(entry.receiptId, "refused");
  }
  if (verdicts.size !== submittedIds.length) return null;
  for (const id of submittedIds) if (!verdicts.has(id)) return null;
  return verdicts;
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

// ---------------------------------------------------------------------------
// A1 — capacity vs the device drain
// ---------------------------------------------------------------------------

Deno.test(
  "A1 route: a week offline on a Pro lease leaves 26 pending receipts and the device drains them in ONE batch — every receipt must be answered, not 400 for the batch",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const entries: Entry[] = [];
    for (let n = 1; n <= PENDING_RECEIPTS_AFTER_A_WEEK_OFFLINE; n += 1) {
      entries.push(await proEntry(user.sub, grant, claims, n));
    }
    const ids = entries.map((entry) => entry.receipt.receiptId);
    // The whole batch is well under the route's body cap.
    assert(JSON.stringify({ receipts: entries }).length < 2_000_000);

    const response = await post({ receipts: entries }, user.token);
    const body = await readJson(response);
    assertEquals(
      response.status,
      200,
      `the device presents every pending receipt at once; a batch of ${ids.length} valid receipts must be answered — got ${response.status} ${JSON.stringify(
        body,
      )}`,
    );
    const verdicts = mobileVerdicts(body, ids);
    assert(verdicts !== null, "the app must be able to read the answer");
    for (const id of ids) assertEquals(verdicts.get(id), "accepted", id);
    assertEquals(settleCalls().length, ids.length);
  },
);

// ---------------------------------------------------------------------------
// A2 — crash between entries
// ---------------------------------------------------------------------------

Deno.test(
  "A2 route: the database fails on the 2nd of 3 entries — 503 for the batch, the 1st stays durable, the redelivery replays it and settles the other two exactly once",
  async () => {
    reset();
    const user = freshUser();
    const first = await freeEntry(user.sub, TICKET_A, 1);
    const claims = proClaims(user.sub);
    const proGrant = await sign(claims);
    const second = await proEntry(user.sub, proGrant, claims, 2);
    const third = await freeEntry(user.sub, TICKET_B, 3, { claims: first.claims });
    const entries = [first, second, third].map(({ receipt, grant, output }) => ({
      receipt,
      grant,
      output,
    }));

    let settleSeen = 0;
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      settleSeen += 1;
      if (settleSeen === 2) {
        return new Response(JSON.stringify({ message: "injected connection reset" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return durableRespond(call);
    };
    const { result: failed, logs } = await captureConsole(() =>
      post({ receipts: entries }, user.token),
    );
    assertEquals(failed.status, 503);
    const failedBody = await readJson(failed);
    const message = (failedBody.error as { message: string }).message;
    assert(!message.includes("injected"), message);
    assert(
      logs.some((entry) => entry.level === "error"),
      "failure detail belongs in the logs",
    );
    assertEquals(settleSeen, 2, "the batch stops at the failing entry");
    assertEquals(durable.size, 1, "only the entry the database answered is durable");

    h.respond = durableRespond;
    const retry = await post({ receipts: entries }, user.token);
    const body = await readJson(retry);
    assertEquals(retry.status, 200, JSON.stringify(body));
    const answer = wire(body);
    assertEquals(answer.rejected, []);
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery, r.status, r.financialDisposition]),
      [
        ["receipt-1", "replayed", "result_recorded", "consumed"],
        ["pro-receipt-2", "settled", "result_recorded", "not_applicable"],
        ["receipt-3", "settled", "result_recorded", "consumed"],
      ],
    );
    assertEquals(durable.size, 3);
    const verdicts = mobileVerdicts(
      body,
      entries.map((e) => e.receipt.receiptId),
    );
    assert(verdicts !== null);
    assertEquals([...verdicts.values()], ["accepted", "accepted", "accepted"]);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);
  },
);

// ---------------------------------------------------------------------------
// A3 — boundary values
// ---------------------------------------------------------------------------

Deno.test(
  "A3 route: boundary receipts in one batch — 0 / -1 / 1.5 / 2^53 / 1e21 sequences, generation 0, uppercase owner, offset queuedAt, uppercase digest, extra field, array output, non-uuid grant id — each rejected by its own id without reaching the database; the 128-char id settles; every id exactly once",
  async () => {
    reset();
    const user = freshUser();
    const base = await freeEntry(user.sub, TICKET_A, 1);
    const maxId = "r".repeat(128);
    const valid = { ...base.receipt, receiptId: maxId };
    interface RawEntry {
      receipt: Record<string, unknown>;
      grant: OfflineSignedExecutionGrant;
      output: unknown;
    }
    const withReceipt = (patch: Record<string, unknown>, id: string): RawEntry => ({
      receipt: { ...base.receipt, ...patch, receiptId: id },
      grant: base.grant,
      output: base.output,
    });
    const ticket = base.receipt.ticket;
    assert(ticket !== null);
    const attacks: RawEntry[] = [
      withReceipt({ lifecycleSequence: 0 }, "seq-zero"),
      withReceipt({ lifecycleSequence: -1 }, "seq-negative"),
      withReceipt({ lifecycleSequence: 1.5 }, "seq-fraction"),
      withReceipt({ lifecycleSequence: 9007199254740992 }, "seq-2pow53"),
      withReceipt({ lifecycleSequence: 1e21 }, "seq-huge"),
      withReceipt({ ticket: { ...ticket, generation: 0 } }, "gen-zero"),
      withReceipt({ ownerId: user.sub.toUpperCase() }, "owner-upper"),
      withReceipt({ queuedAt: "2026-09-08T12:00:00+00:00" }, "queued-offset"),
      withReceipt({ queuedAt: "2026-13-40T12:00:00.000Z" }, "queued-invalid"),
      withReceipt({ fullOutputSha256: base.receipt.fullOutputSha256.toUpperCase() }, "sha-upper"),
      withReceipt({ nativeTime: null }, "extra-field"),
      withReceipt({ grantId: "not-a-uuid" }, "grant-not-uuid"),
      { receipt: { ...base.receipt, receiptId: "output-array" }, grant: base.grant, output: [] },
      { receipt: valid, grant: base.grant, output: base.output },
    ];
    const ids = attacks.map((entry) => String(entry.receipt.receiptId));
    assertEquals(new Set(ids).size, ids.length);

    const response = await post({ receipts: attacks }, user.token);
    const body = await readJson(response);
    assertEquals(response.status, 200, JSON.stringify(body));
    const answer = wire(body);
    const verdicts = mobileVerdicts(body, ids);
    assert(verdicts !== null, "every id must be answered exactly once");
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery, r.status, r.financialDisposition]),
      [[maxId, "settled", "result_recorded", "consumed"]],
    );
    // grant-not-uuid passes the edge shape (identifier grammar) and is refused
    // by the RPC's uuid cast; nothing durable is written for it.
    const rejectedIds = answer.rejected.map((r) => r.receiptId).sort();
    assertEquals(rejectedIds, ids.filter((id) => id !== maxId).sort());
    for (const rejection of answer.rejected) {
      assertEquals(rejection.code, "offline.invalid_input", JSON.stringify(rejection));
    }
    const reached = settleCalls().map((p) => p.p_receipt.receiptId);
    assertEquals(reached.sort(), ["grant-not-uuid", maxId].sort());
    assertEquals(durable.size, 1);
  },
);

// ---------------------------------------------------------------------------
// A4 — clock boundaries
// ---------------------------------------------------------------------------

Deno.test(
  "A4 route: a grant that expired 393 days ago and a receipt queued in 2999 settle — consumption is judged against the ledger, never against the clock",
  async () => {
    reset();
    const user = freshUser();
    const issuedAt = nowSeconds() - 400 * DAY;
    const stale = await freeEntry(user.sub, TICKET_A, 1, {
      claims: freeClaims(user.sub, { issuedAt, expiresAt: issuedAt + 7 * DAY }),
      queuedAt: "2999-12-31T23:59:59.999Z",
    });
    const response = await post(
      { receipts: [{ receipt: stale.receipt, grant: stale.grant, output: stale.output }] },
      user.token,
    );
    const body = await readJson(response);
    assertEquals(response.status, 200, JSON.stringify(body));
    const answer = wire(body);
    assertEquals(answer.rejected, []);
    assertEquals(answer.receipts.length, 1);
    assertEquals(answer.receipts[0].delivery, "settled");
    assertEquals(answer.receipts[0].status, "result_recorded");
    assertEquals(answer.receipts[0].financialDisposition, "consumed");
    assertEquals(answer.receipts[0].resultId, stale.receipt.resultId);
    const calls = settleCalls();
    assertEquals(calls.length, 1);
    assertEquals(calls[0].p_hold_reason, null);
    assertEquals(calls[0].p_receipt.queuedAt, "2999-12-31T23:59:59.999Z");
  },
);

// ---------------------------------------------------------------------------
// A5 — corrupt durable state
// ---------------------------------------------------------------------------

Deno.test(
  "A5 route: a durable row that contradicts the receipt (result_recorded for another result, consumed on a no-ticket receipt, a status the app cannot store) is a 503 — never a verdict the device would mark final",
  async () => {
    const user = freshUser();
    const free = await freeEntry(user.sub, TICKET_A, 1);
    const claims = proClaims(user.sub);
    const pro = await proEntry(user.sub, await sign(claims), claims, 2);
    const corrupt: { entry: Entry; row: SettleRow }[] = [
      {
        entry: free,
        row: {
          result: "accepted",
          delivery: "settled",
          status: "result_recorded",
          reason_code: null,
          financial_disposition: "consumed",
          result_id: crypto.randomUUID(),
        },
      },
      {
        entry: pro,
        row: {
          result: "accepted",
          delivery: "settled",
          status: "result_recorded",
          reason_code: null,
          financial_disposition: "consumed",
          result_id: pro.receipt.resultId,
        },
      },
      {
        entry: free,
        row: {
          result: "accepted",
          delivery: "held",
          status: "support_review_required",
          reason_code: "conflicting_receipt",
          financial_disposition: "reserved",
          result_id: null,
        },
      },
      {
        entry: free,
        row: {
          result: "accepted",
          delivery: "held",
          status: "reconciliation_required",
          reason_code: "conflicting_receipt",
          financial_disposition: "consumed",
          result_id: null,
        },
      },
    ];
    for (const { entry, row } of corrupt) {
      reset();
      h.respond = (call) => (call.url.endsWith(SETTLE_RPC) ? rpcJson(row) : null);
      const { result: response } = await captureConsole(() =>
        post(
          { receipts: [{ receipt: entry.receipt, grant: entry.grant, output: entry.output }] },
          user.token,
        ),
      );
      const body = await readJson(response);
      assertEquals(response.status, 503, JSON.stringify({ row, body }));
      assertEquals(Object.keys(body), ["error"], JSON.stringify(body));
      assert(!JSON.stringify(body).includes(row.status ?? ""), JSON.stringify(body));
    }
  },
);

// ---------------------------------------------------------------------------
// Live PostgreSQL half (disposable postgres:16, every migration applied)
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
     values ('google', 'w04-04-attack-${n}-${RUN}', '${U(
       n,
     )}', '{"sub":"w04-04-attack-${n}-${RUN}"}')`,
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

async function asRole(tx: Tx, role: "anon" | "service_role"): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role ${role}`);
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

async function issueFreeGrant(sql: Sql, n: number, key: string): Promise<LiveGrant> {
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

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticket: OfflineFreeTicketReference | null,
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
    ticket,
    lifecycleSequence: 1,
    operationId: `operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

async function shotRows(sql: Sql, where: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where ${where}`,
  );
  return Number(count);
}

async function settlementRows(sql: Sql, n: number): Promise<Record<string, unknown>[]> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `select receipt_id, status, reason_code, financial_disposition, ticket_id, result_id
     from public.offline_receipt_settlements where user_id = '${U(n)}' order by receipt_id`,
  );
  return [...rows];
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
}

function sqlState(error: unknown): string {
  return error instanceof Error && "code" in error ? String(error.code) : String(error);
}

// ---------------------------------------------------------------------------
// A6 — concurrency
// ---------------------------------------------------------------------------

Deno.test({
  name: "A6 live: the same receipt from two connections at once settles once (one settled, one replayed, one consumed event, one shot); two different results racing for one ticket consume it once and HOLD the other — held + scored stays 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("race"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      assertEquals(await counters(sql, 1), { held: 2, scored: 0 });

      const same = await liveReceipt(U(1), issued, ticketRef(ticketA, issued.claims), "same");
      const race = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
      ]);
      assertEquals(
        race.map((r) => r.delivery).sort(),
        ["replayed", "settled"],
        JSON.stringify(race),
      );
      for (const row of race) {
        assertEquals(row.status, "result_recorded");
        assertEquals(row.financial_disposition, "consumed");
        assertEquals(row.result_id, same.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketA}'`), 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });

      const left = await liveReceipt(U(1), issued, ticketRef(ticketB, issued.claims), "left");
      const right = await liveReceipt(U(1), issued, ticketRef(ticketB, issued.claims), "right");
      const contest = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, left.receipt, left.output, null)),
        inTx(sql, 1, (tx) => settle(tx, right.receipt, right.output, null)),
      ]);
      assertEquals(
        contest.map((r) => [r.delivery, r.status, r.financial_disposition]).sort(),
        [
          ["held", "reconciliation_required", "reserved"],
          ["settled", "result_recorded", "consumed"],
        ],
        JSON.stringify(contest),
      );
      assertEquals(contest.find((r) => r.delivery === "held")?.reason_code, "conflicting_receipt");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketB}'`), 1);
      assertEquals(await counters(sql, 1), { held: 0, scored: 2 });

      // Redelivering everything, out of order and all at once, changes nothing.
      const replay = await Promise.all(
        [right, left, same].map((r) => inTx(sql, 1, (tx) => settle(tx, r.receipt, r.output, null))),
      );
      assertEquals(
        replay.map((r) => r.delivery),
        ["replayed", "replayed", "replayed"],
      );
      assertEquals(await shotRows(sql, `user_id = '${U(1)}'`), 2);
      assertEquals(await counters(sql, 1), { held: 0, scored: 2 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A7 — crash before commit
// ---------------------------------------------------------------------------

Deno.test({
  name: "A7 live: the client dies before commit — settlement and consumption roll back together (no row, no ledger event, no shot, budget untouched); the redelivery settles, not replays",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("crash"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(2), issued, ticketRef(ticketA, issued.claims), "crash");

      const insideTx: SettleRow[] = [];
      const crashed = await inTx(sql, 2, async (tx) => {
        insideTx.push(await settle(tx, rec.receipt, rec.output, null));
        throw new Error("client crashed before commit");
      }).then(
        () => false,
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      assertEquals(crashed, "client crashed before commit");
      assertEquals(insideTx.length, 1);
      assertEquals(insideTx[0].delivery, "settled");
      assertEquals(insideTx[0].financial_disposition, "consumed");

      assertEquals(await settlementRows(sql, 2), []);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketA}'`), 0);
      assertEquals(await counters(sql, 2), { held: 2, scored: 0 });

      const again = await inTx(sql, 2, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "settled");
      assertEquals(again.status, "result_recorded");
      assertEquals(again.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketA}'`), 1);
      assertEquals(await counters(sql, 2), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A8 — interleaved account switch
// ---------------------------------------------------------------------------

Deno.test({
  name: "A8 live: user B presents user A's receipt (account switch on one device) — HOLD owner_mismatch in B's namespace, A's ticket and budget untouched, B's budget untouched; A then settles it once; B's redelivery replays the hold",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const issued = await issueFreeGrant(sql, 3, KEY("switch"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(3), issued, ticketRef(ticketA, issued.claims), "switch");
      const beforeB = await counters(sql, 4);

      // The edge would derive owner_mismatch; the RPC must reach the same
      // verdict even when handed null (defence in depth).
      for (const hold of [null, "owner_mismatch"]) {
        const asB = await inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, hold));
        assertEquals(asB.result, "accepted");
        assertEquals(asB.status, "reconciliation_required");
        assertEquals(asB.reason_code, "owner_mismatch");
        assertEquals(asB.financial_disposition, "reserved");
        assertEquals(asB.result_id, null);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketA}'`), 0);
      assertEquals(await counters(sql, 3), { held: 2, scored: 0 });
      assertEquals(await counters(sql, 4), beforeB);
      assertEquals((await settlementRows(sql, 4)).length, 1);
      assertEquals(await settlementRows(sql, 3), []);

      const asA = await inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(asA.delivery, "settled");
      assertEquals(asA.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `offline_ticket_id = '${ticketA}'`), 1);
      assertEquals(await shotRows(sql, `user_id = '${U(4)}'`), 0);
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      assertEquals(await counters(sql, 4), beforeB);

      const asBAgain = await inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(asBAgain.delivery, "replayed");
      assertEquals(asBAgain.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A9 — roles
// ---------------------------------------------------------------------------

Deno.test({
  name: "A9 live: anon and service_role cannot settle a receipt, anon cannot read settlements, authenticated cannot read a release lineage — and service_role can read the lineage (allowed path)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 5, KEY("roles"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(5), issued, ticketRef(ticketA, issued.claims), "roles");

      for (const role of ["anon", "service_role"] as const) {
        const denied = await sql
          .begin(async (tx) => {
            await asRole(tx as unknown as Tx, role);
            return await settle(tx as unknown as Tx, rec.receipt, rec.output, null);
          })
          .then(
            (row) => `settled:${JSON.stringify(row)}`,
            (error: unknown) => sqlState(error),
          );
        assertEquals(denied, "42501", role);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlementRows(sql, 5), []);

      const anonRead = await sql
        .begin(async (tx) => {
          await asRole(tx as unknown as Tx, "anon");
          return await tx.unsafe(`select count(*) from public.offline_receipt_settlements`);
        })
        .then(
          () => "readable",
          (error: unknown) => sqlState(error),
        );
      assertEquals(anonRead, "42501");

      const authedLineage = await inTx(sql, 5, (tx) =>
        tx.unsafe(`select * from public.read_analysis_release_policy_lineage('${"a".repeat(64)}')`),
      ).then(
        () => "readable",
        (error: unknown) => sqlState(error),
      );
      assertEquals(authedLineage, "42501");

      const serviceLineage = await sql.begin(async (tx) => {
        await asRole(tx as unknown as Tx, "service_role");
        return await tx.unsafe<{ lineage: Record<string, unknown> }[]>(
          `select public.read_analysis_release_policy_lineage('${"a".repeat(64)}') as lineage`,
        );
      });
      assertEquals(serviceLineage.length, 1);
      // An unknown policy digest is "not chargeable, deny new": HOLD material,
      // never authority.
      assertEquals(serviceLineage[0].lineage, {
        approval: null,
        document: null,
        canonicalDocument: null,
        denyNewAuthorizations: true,
      });

      const grants = await sql.unsafe<{ grantee: string }[]>(
        `select grantee from information_schema.routine_privileges
         where routine_schema = 'public' and routine_name = 'settle_offline_receipt'
           and grantee not in ('postgres') order by grantee`,
      );
      assertEquals(
        grants.map((g) => g.grantee),
        ["authenticated"],
      );
      const overloads = await sql.unsafe<{ args: string }[]>(
        `select pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         where s.nspname = 'public' and p.proname = 'settle_offline_receipt'`,
      );
      assertEquals(
        overloads.map((o) => o.args),
        [
          "p_receipt jsonb, p_receipt_sha256 text, p_output jsonb, p_hold_reason text, p_defer_new boolean",
        ],
        "exactly one signature — the freeze-aware one; the old 4-argument overload must be gone",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// A10 — Pro output persistence
// ---------------------------------------------------------------------------

Deno.test({
  name: "A10 live: a Pro (no-ticket) receipt answered result_recorded leaves the delivered rating on the server as the owner's shot — the app marks the local shot synced on result_recorded and never re-sends it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      const claims = proClaims(U(6));
      const issued: LiveGrant = { claims, grant: await sign(claims) };
      const rec = await liveReceipt(U(6), issued, null, "pro");

      const first = await inTx(sql, 6, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(first, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "not_applicable",
        result_id: rec.receipt.resultId,
      });
      const again = await inTx(sql, 6, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "replayed");
      assertEquals(again.status, "result_recorded");
      assertEquals(again.result_id, rec.receipt.resultId);
      assertEquals((await settlementRows(sql, 6)).length, 1);

      // The rating the receipt carried must now be the server's: the device
      // marks its local copy synced on result_recorded (W05-07) and never
      // re-sends it, so a result recorded nowhere is a rating lost.
      assertEquals(
        await shotRows(sql, `id = '${rec.receipt.resultId}' and user_id = '${U(6)}'`),
        1,
        "result_recorded without a stored shot: the Pro rating exists only on the device",
      );
      // Pro reserves nothing.
      assertEquals((await counters(sql, 6)).held, 0);
    } finally {
      await sql.end();
    }
  },
});

// The maximal receipt id A3 relies on is exactly the route's wire grammar.
assertMatch("r".repeat(128), /^[A-Za-z0-9._:/+=-]{1,128}$/);
