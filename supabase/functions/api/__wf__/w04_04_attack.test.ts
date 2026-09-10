// W04-04 ADVERSARIAL TESTS — candidate devin/pp/w04-04/impl-r7-c2 @ 58c46a3a.
//
// Every test here is an ATTACK on a failure boundary of POST /v1/offline/receipts
// and public.settle_offline_receipt(), written against the shipping device's
// behaviour (apps/mobile/src/data/offlineWallet.ts reconcileOfflineWallet:
// EVERY unsettled receipt — held ones included — is re-presented in ONE POST,
// oldest first, on every drain; parseOfflineReceiptVerdicts refuses an answer
// that does not name every submitted id exactly once).
//
// Tests whose name starts with "BREAK" assert the behaviour the work package
// promises and FAIL against the candidate — each one is a confirmed break.
// Tests whose name starts with "HOLDS" are attacks the candidate survives.
//
// Route half: the REAL edge handler through routesHarness with the RPC stood
// in exactly like the migration (durable by caller + receiptId + digest).
// Live half: the REAL settle_offline_receipt() on the disposable postgres:16
// (./xc_pg_up.sh, XC_PG_URL). Without XC_PG_URL the live half is `ignore`d —
// an ignored run is NOT a pass.

import postgres from "postgres";
import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
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
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-4444444444aa";
const TICKET_A = "65555555-5555-4555-8555-5555555555a1";
const DAY = 86_400;
/** The candidate's per-request settlement budget (index.ts
 * OFFLINE_RECEIPT_BATCH_SETTLE_MAX) and body cap (OFFLINE_RECEIPT_BATCH_BODY_BYTES). */
const ROUTE_SETTLE_MAX = 250;
const ROUTE_BODY_BYTES = 2_000_000;

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
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  const sub = `aaaaaaaa-0404-4000-8000-a${String(userSeq).padStart(11, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
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

/** The FROZEN 1.0 output shape the device delivers (shot.sync payload without
 * analysisPermitId). */
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

/** The row shape the route hands the RPC for an admitted frozen output. */
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
  installationKeyId?: string;
  grantJwsSha256?: string;
  queuedAt?: string;
}

/** The DEVICE receipt exactly as apps/mobile OfflineReceiptSubmission posts it. */
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

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the migration, see the candidate's
// own offline_receipt_reconciliation.test.ts durableRespond).
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

/** A new request on the same durable store: what the device's NEXT drain sees. */
function nextDrain(): void {
  h.reset();
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

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

/** Faithful mirror of apps/mobile/src/data/api.ts parseOfflineReceiptVerdicts():
 * null is the app's unreadableAnswer() — the drain fails, every receipt stays
 * queued. */
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

interface Entry {
  receipt: OfflineDeviceReceipt;
  grant: OfflineSignedExecutionGrant;
  output: Record<string, unknown> | null;
}

/** `count` honest Pro receipts under one lease; `withoutOutput(n)` decides
 * which ones the device delivers with `output: null` (a scored rating whose
 * output is gone → the route's evidence_missing HOLD, durable). */
async function proBatch(
  user: { sub: string },
  from: number,
  count: number,
  withoutOutput: (n: number) => boolean = () => false,
): Promise<{ entries: Entry[]; ids: string[] }> {
  const claims = proClaims(user.sub);
  const grant = await sign(claims);
  const entries: Entry[] = [];
  const ids: string[] = [];
  for (let n = from; n < from + count; n += 1) {
    const resultId = `7100${String(n).padStart(4, "0")}-0404-4000-8000-0000000000aa`;
    const out = output(resultId);
    const rec = await receipt({
      receiptId: `pro-receipt-${n}`,
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: n,
      operationId: `pro-operation-${n}`,
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(out),
      queuedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, n)).toISOString(),
    });
    entries.push({ receipt: rec, grant, output: withoutOutput(n) ? null : out });
    ids.push(rec.receiptId);
  }
  return { entries, ids };
}

/** What apps/mobile re-presents on its next drain: every receipt the previous
 * answer did NOT settle terminally (accepted / refused leave the queue; held —
 * pending and reconciliation_required alike — stays), oldest first, plus
 * whatever was queued since. */
function stillQueued(entries: Entry[], verdicts: MobileVerdict[]): Entry[] {
  const byId = new Map(verdicts.map((v) => [v.receiptId, v.verdict]));
  return entries.filter((e) => byId.get(e.receipt.receiptId) === "held");
}

// ---------------------------------------------------------------------------
// ATTACK 1 — starvation: durable HOLDs at the head of the device queue eat
// the whole per-request settlement budget, forever.
// ---------------------------------------------------------------------------

Deno.test(
  "BREAK [P1] route: once 250 receipts of an owner are durable HOLDs, every later receipt is answered pending on every drain — the device re-presents held receipts first, each replay spends the settlement budget, and the new receipt is never looked at",
  async () => {
    reset();
    const user = freshUser();
    // Day 1: a Pro week offline, 250 chargeable receipts whose output the
    // device can no longer produce (evidence_missing → durable HOLD each).
    const held = await proBatch(user, 1, ROUTE_SETTLE_MAX, () => true);
    let body = await readJson(await post({ receipts: held.entries }, user.token));
    let verdicts = mobileVerdicts(body, held.ids);
    assert(verdicts !== null);
    assertEquals(verdicts.filter((v) => v.verdict === "held").length, ROUTE_SETTLE_MAX);
    assertEquals(
      wire(body).receipts.every(
        (r) => r.delivery === "held" && r.reasonCode === "evidence_missing",
      ),
      true,
    );
    assertEquals(durable.size, ROUTE_SETTLE_MAX);
    let queue = stillQueued(held.entries, verdicts);
    assertEquals(queue.length, ROUTE_SETTLE_MAX, "held receipts stay in the device queue");

    // Day 2: one honest, complete, chargeable receipt is queued behind them.
    const fresh = await proBatch(user, 9_001, 1);
    queue = [...queue, ...fresh.entries];
    const freshId = fresh.ids[0];

    // Three consecutive drains — the device re-presents the whole queue each
    // time. The promise of the design ("the app redelivers it on the next
    // drain") is that the deferred receipt eventually settles.
    const answers: string[] = [];
    for (let drain = 1; drain <= 3; drain += 1) {
      nextDrain();
      body = await readJson(await post({ receipts: queue }, user.token));
      const ids = queue.map((e) => e.receipt.receiptId);
      verdicts = mobileVerdicts(body, ids);
      assert(verdicts !== null, `drain ${drain}: answer must be readable by the app`);
      const answer = wire(body);
      const freshRow = answer.receipts.find((r) => r.receiptId === freshId);
      assert(freshRow, `drain ${drain}: the fresh receipt must be named`);
      answers.push(freshRow.delivery);
      // Every RPC call of the drain was a replay of an already-held receipt.
      const calls = settleCalls();
      assertEquals(calls.length, ROUTE_SETTLE_MAX);
      assertEquals(
        calls.every((c) => c.p_receipt.receiptId !== freshId),
        true,
      );
      queue = stillQueued(queue, verdicts);
    }
    assertEquals(
      durable.size,
      ROUTE_SETTLE_MAX,
      "nothing durable was ever written for the fresh receipt",
    );
    // EXPECTED: the fresh receipt settles on some drain (delivery "settled").
    // OBSERVED on 58c46a3a: ["pending", "pending", "pending"] — starvation.
    assert(
      answers.includes("settled"),
      `fresh receipt never settled across 3 drains; deliveries = ${JSON.stringify(answers)}`,
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 2 — body cap: an honest queue larger than 2 MB can never drain.
// ---------------------------------------------------------------------------

Deno.test(
  "BREAK [P2] route: a queue of honest, individually settleable receipts whose one-POST body exceeds 2 MB is refused wholesale (413) — nothing settles, the device (which never chunks) re-sends the same body on every drain",
  async () => {
    reset();
    const user = freshUser();
    // Grow the queue until the exact wire body the device would send crosses
    // the cap: each entry carries the receipt, the signed grant and the output.
    const probe = await proBatch(user, 1, 1);
    const entryBytes = new TextEncoder().encode(JSON.stringify(probe.entries[0])).length + 1;
    const count = Math.ceil(ROUTE_BODY_BYTES / entryBytes) + 1;
    const { entries, ids } = await proBatch(user, 1, count);
    const bodyText = JSON.stringify({ receipts: entries });
    const bodyBytes = new TextEncoder().encode(bodyText).length;
    assert(bodyBytes > ROUTE_BODY_BYTES, `probe: ${count} entries = ${bodyBytes} bytes`);

    const first = await post({ receipts: entries }, user.token);
    const firstBody = await first.text();
    // The same receipts, in two halves, are all honest and settle.
    nextDrain();
    const half = Math.ceil(count / 2);
    const a = wire(await readJson(await post({ receipts: entries.slice(0, half) }, user.token)));
    nextDrain();
    const b = wire(await readJson(await post({ receipts: entries.slice(half) }, user.token)));
    const settledIds = [...a.receipts, ...b.receipts]
      .filter((r) => r.delivery === "settled" || r.delivery === "pending")
      .map((r) => r.receiptId);
    assertEquals(settledIds.length, count, "every receipt is honest: settled or budget-deferred");

    // EXPECTED: the device's single POST is answered per receipt (200, every
    // id named once) — or at least some receipts settle so the queue shrinks.
    // OBSERVED on 58c46a3a: 413 with an empty verdict list; the queue never
    // shrinks because the app re-sends the identical body next time.
    assertEquals(
      first.status,
      200,
      `queue of ${count} entries (${bodyBytes} bytes) answered ${first.status}: ${firstBody.slice(0, 200)}`,
    );
    assertEquals(mobileVerdicts(JSON.parse(firstBody), ids)?.length, count);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 3 — duplicate identities inside ONE batch (the device never sends
// them, but a poisoned or replayed request could).
// ---------------------------------------------------------------------------

Deno.test(
  "HOLDS route: the same receiptId twice in one batch with two bodies settles the first and rejects the second as offline.receipt_conflict; a key-order permutation of the same receipt is a replay, not a conflict",
  async () => {
    reset();
    const user = freshUser();
    const { entries } = await proBatch(user, 1, 2);
    const [one, two] = entries;
    // Same id as `one`, but the body of `two` (another operation / result).
    const rebody: Entry = {
      ...two,
      receipt: { ...two.receipt, receiptId: one.receipt.receiptId },
    };
    // `one` again with its keys in another order (JSON key order is not identity).
    const permuted: Entry = {
      ...one,
      receipt: Object.fromEntries(
        Object.entries(one.receipt).reverse(),
      ) as unknown as OfflineDeviceReceipt,
    };
    const answer = wire(
      await readJson(await post({ receipts: [one, rebody, permuted] }, user.token)),
    );
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery, r.status]),
      [
        [one.receipt.receiptId, "settled", "result_recorded"],
        [one.receipt.receiptId, "replayed", "result_recorded"],
      ],
    );
    assertEquals(
      answer.rejected.map((r) => [r.receiptId, r.code]),
      [[one.receipt.receiptId, "offline.receipt_conflict"]],
    );
    assertEquals(durable.size, 1);
    // The app's parser refuses an answer naming one id three times: the drain
    // fails closed, nothing is marked locally (the server settled once).
    assertEquals(mobileVerdicts(answer, [one.receipt.receiptId]), null);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4 — boundary values in the receipt itself.
// ---------------------------------------------------------------------------

Deno.test(
  "HOLDS route: lifecycleSequence at 2^53-1 settles, 2^53 / 0 / -1 / 1.5 / a numeric string are rejected per entry and never reach the RPC; a 129-char receiptId is a whole-batch 400 (never emitted by the device); a receipt with an extra key or a missing key is rejected per entry",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const mk = async (
      n: number,
      patch: (r: OfflineDeviceReceipt) => Record<string, unknown>,
    ): Promise<{
      receipt: Record<string, unknown>;
      grant: OfflineSignedExecutionGrant;
      output: unknown;
    }> => {
      const resultId = `7200${String(n).padStart(4, "0")}-0404-4000-8000-0000000000aa`;
      const out = output(resultId);
      const rec = await receipt({
        receiptId: `bound-${n}`,
        ownerId: user.sub,
        grant,
        claims,
        ticket: null,
        lifecycleSequence: n,
        operationId: `bound-op-${n}`,
        resultId,
        fullOutputSha256: await digestCanonicalOfflineJson(out),
      });
      return { receipt: patch(rec), grant, output: out };
    };
    const entries = [
      await mk(1, (r) => ({ ...r, lifecycleSequence: Number.MAX_SAFE_INTEGER })),
      await mk(2, (r) => ({ ...r, lifecycleSequence: 2 ** 53 })),
      await mk(3, (r) => ({ ...r, lifecycleSequence: 0 })),
      await mk(4, (r) => ({ ...r, lifecycleSequence: -1 })),
      await mk(5, (r) => ({ ...r, lifecycleSequence: 1.5 })),
      await mk(6, (r) => ({ ...r, lifecycleSequence: "7" })),
      await mk(7, (r) => ({ ...r, extra: true })),
      await mk(8, (r) => {
        const { queuedAt: _q, ...rest } = r;
        return rest;
      }),
      await mk(9, (r) => ({ ...r, queuedAt: "not-a-date" })),
      await mk(10, (r) => ({ ...r, ownerId: r.ownerId.toUpperCase() })),
    ];
    const answer = wire(await readJson(await post({ receipts: entries }, user.token)));
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery]),
      [["bound-1", "settled"]],
    );
    // An upper-cased owner UUID is not the frozen receipt shape: rejected per
    // entry (never settled, never a 5xx, never a whole-batch 400).
    assertEquals(answer.rejected.map((r) => r.receiptId).sort(), [
      "bound-10",
      "bound-2",
      "bound-3",
      "bound-4",
      "bound-5",
      "bound-6",
      "bound-7",
      "bound-8",
      "bound-9",
    ]);
    assertEquals(settleCalls().length, 1);

    nextDrain();
    const long = await mk(11, (r) => ({ ...r, receiptId: "x".repeat(129) }));
    const whole = await post({ receipts: [entries[0], long] }, user.token);
    assertEquals(whole.status, 400);
    assertEquals(settleCalls().length, 0);
  },
);

// ---------------------------------------------------------------------------
// Live half — the REAL settle_offline_receipt() on the disposable postgres.
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
     values ('google', 'w04-04-attack-${n}-${RUN}', '${U(n)}', '{"sub":"w04-04-attack-${n}-${RUN}"}')`,
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
  rec: OfflineDeviceReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
  deferNew: boolean | null = null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(sqlOutput(out))},
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

type LiveGrant = { claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant };

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
  assert(
    claims.allocation && claims.allocation.ticketIds.length === requested,
    JSON.stringify(row),
  );
  return { claims, grant: await sign(claims) };
}

async function makePremium(sql: Sql, n: number): Promise<void> {
  await sql.unsafe(
    `insert into public.billing_entitlements (user_id, premium, expires_at)
     values ('${U(n)}', true, now() + interval '30 days')
     on conflict (user_id) do update set premium = true, expires_at = now() + interval '30 days'`,
  );
}

async function issueLeaseGrant(sql: Sql, n: number, key: string): Promise<LiveGrant> {
  await registerDevice(sql, n, key);
  const row = await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ row: unknown }[]>(
      `select to_jsonb(g) as row from public.issue_offline_grant('${key}', 0) g`,
    );
    return rows[0].row;
  });
  const claims = offlineGrantClaimsFromIssuance(row, {
    issuer: ISSUER,
    ownerId: U(n),
    installationKeyId: key,
    release: RELEASE,
  });
  assertEquals(claims.entitlementSource, "verified_store", JSON.stringify(row));
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string | null,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
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

async function shotRows(sql: Sql, where: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots s where ${where}`,
  );
  return Number(count);
}

async function settlementRows(
  sql: Sql,
  n: number,
): Promise<{ receipt_id: string; status: string }[]> {
  const rows = await sql.unsafe<{ receipt_id: string; status: string }[]>(
    `select receipt_id, status from public.offline_receipt_settlements where user_id = '${U(n)}' order by receipt_id`,
  );
  return rows.map((row) => ({ receipt_id: row.receipt_id, status: row.status }));
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
}

interface SqlFailure {
  code: string;
  message: string;
}

async function refused(work: Promise<unknown>): Promise<SqlFailure> {
  try {
    await work;
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { code: e.code ?? "", message: e.message ?? String(error) };
  }
  throw new Error("expected the statement to be refused");
}

// ---------------------------------------------------------------------------
// ATTACK 5 — concurrency: N connections settle at once.
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: 8 concurrent deliveries of the same ticket receipt, then 8 concurrent DIFFERENT receipts for the same ticket, consume it exactly once (one consumed event, one shot, one settled row); the ticket-B abstention afterwards is not_chargeable and leaves the ticket outstanding",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 8, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("conc"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const same = await liveReceipt(U(1), issued, ticketA, "conc-same");

      const first = await Promise.all(
        Array.from({ length: 8 }, () =>
          inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        ),
      );
      const settled = first.filter((r) => r.delivery === "settled");
      const replayed = first.filter((r) => r.delivery === "replayed");
      assertEquals(settled.length, 1, JSON.stringify(first));
      assertEquals(replayed.length, 7, JSON.stringify(first));
      assertEquals(
        first.every(
          (r) => r.status === "result_recorded" && r.financial_disposition === "consumed",
        ),
        true,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `s.offline_ticket_id = '${ticketA}'`), 1);

      // 8 different receipts (8 operations, 8 results) all claiming ticket A.
      const rivals = await Promise.all(
        Array.from({ length: 8 }, (_, i) => liveReceipt(U(1), issued, ticketA, `conc-rival-${i}`)),
      );
      const second = await Promise.all(
        rivals.map((r) => inTx(sql, 1, (tx) => settle(tx, r.receipt, r.output, null))),
      );
      assertEquals(
        second.every(
          (r) =>
            r.delivery === "held" &&
            r.reason_code === "conflicting_receipt" &&
            r.financial_disposition === "reserved" &&
            r.result_id === null,
        ),
        true,
        JSON.stringify(second),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `s.offline_ticket_id = '${ticketA}'`), 1);
      assertEquals(await shotRows(sql, `s.user_id = '${U(1)}'`), 1);
      assertEquals((await settlementRows(sql, 1)).length, 9);

      // Ticket B: an honest abstention (not_chargeable, no output) is recorded
      // and the ticket is still outstanding — held count stays 1 (B), scored 1 (A).
      const abstain = await liveReceipt(U(1), issued, ticketB, "conc-abstain", {
        billingDisposition: "not_chargeable",
      });
      const row = await inTx(sql, 1, (tx) => settle(tx, abstain.receipt, null, null));
      assertEquals(
        [row.delivery, row.status, row.financial_disposition],
        ["settled", "result_recorded", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "HOLDS live DB: 8 concurrent Pro-lease receipts (8 operations) naming the SAME resultId write exactly one rated shot; the other 7 are conflicting_receipt HOLDs with financial_disposition not_applicable",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 8, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      await makePremium(sql, 2);
      const lease = await issueLeaseGrant(sql, 2, KEY("lease-conc"));
      const resultId = crypto.randomUUID();
      const out = output(resultId);
      const sha = await digestCanonicalOfflineJson(out);
      const recs = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          receipt({
            receiptId: `receipt-lease-conc-${i}-${RUN}`,
            ownerId: U(2),
            grant: lease.grant,
            claims: lease.claims,
            ticket: null,
            lifecycleSequence: i + 1,
            operationId: `operation-lease-conc-${i}-${RUN}`,
            resultId,
            fullOutputSha256: sha,
          }),
        ),
      );
      const rows = await Promise.all(
        recs.map((r) => inTx(sql, 2, (tx) => settle(tx, r, out, null))),
      );
      assertEquals(rows.filter((r) => r.delivery === "settled").length, 1, JSON.stringify(rows));
      assertEquals(
        rows.filter((r) => r.delivery === "held" && r.reason_code === "conflicting_receipt").length,
        7,
        JSON.stringify(rows),
      );
      assertEquals(
        rows.every((r) => r.financial_disposition === "not_applicable"),
        true,
      );
      assertEquals(await shotRows(sql, `s.id = '${resultId}'`), 1);
      assertEquals(await shotRows(sql, `s.user_id = '${U(2)}'`), 1);
      assertEquals(await counters(sql, 2), { held: 0, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 6 — unauthorised roles and account switch (allowed AND denied paths).
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: settle_offline_receipt() is refused to anon, service_role and a session-less authenticated caller; an account-switched second user presenting the owner's receipt gets an owner_mismatch HOLD under HIS namespace (ticket untouched) and the owner still settles it consumed; the settlement table refuses every client write and hides other owners' rows",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const issued = await issueFreeGrant(sql, 3, KEY("roles"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const own = await liveReceipt(U(3), issued, ticketA, "roles-own");
      const call = async (tx: Tx): Promise<SettleRow> =>
        await settle(tx, own.receipt, own.output, null);

      // anon
      const anon = await refused(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role anon`);
          return await call(tx as unknown as Tx);
        }),
      );
      assertEquals(anon.code, "42501", anon.message);
      // service_role (revoked by the migration)
      const service = await refused(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role service_role`);
          return await call(tx as unknown as Tx);
        }),
      );
      assertEquals(service.code, "42501", service.message);
      // authenticated without a live API session
      const noSession = await refused(
        sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, 3, false);
          return await call(tx as unknown as Tx);
        }),
      );
      assertEquals(noSession.code, "42501", noSession.message);
      // authenticated, session, but without the API request key header
      const noKey = await refused(
        sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${U(3)}'`);
          await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(3)}"}'`);
          return await call(tx as unknown as Tx);
        }),
      );
      assertEquals(noKey.code, "42501", noKey.message);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlementRows(sql, 3), []);

      // Account switch: user 4 signed in on the same phone presents user 3's
      // receipt (the route would compute owner_mismatch; the SQL does too when
      // the edge passes no reason).
      const switched = await inTx(sql, 4, (tx) => settle(tx, own.receipt, own.output, null));
      assertEquals(
        [switched.delivery, switched.status, switched.reason_code, switched.financial_disposition],
        ["held", "reconciliation_required", "owner_mismatch", "reserved"],
      );
      const switchedWithReason = await inTx(sql, 4, (tx) =>
        settle(
          tx,
          { ...own.receipt, receiptId: `${own.receipt.receiptId}-b` },
          own.output,
          "owner_mismatch",
        ),
      );
      assertEquals(switchedWithReason.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals((await settlementRows(sql, 4)).length, 2);
      assertEquals(await settlementRows(sql, 3), []);

      // No client role touches the settlement table directly: not even the
      // owner's SELECT (the route reads verdicts through the RPC only).
      for (const stmt of [
        `select count(*)::text as n from public.offline_receipt_settlements where user_id = '${U(3)}'`,
        `select count(*)::text as n from public.offline_receipt_settlements where user_id = '${U(4)}'`,
        `insert into public.offline_receipt_settlements (user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence, status, financial_disposition, receipt)
         values ('${U(4)}', 'forged', '${"a".repeat(64)}', '${U(4)}', 'k', '${GRANT_ID}', '${"b".repeat(64)}', 'op', 'res', '${"c".repeat(64)}', 'joint_verification_required', 1, 'result_recorded', 'consumed', '{}')`,
        `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${U(4)}'`,
        `delete from public.offline_receipt_settlements where user_id = '${U(4)}'`,
      ]) {
        const denied = await refused(inTx(sql, 4, (tx) => tx.unsafe(stmt)));
        assertEquals(denied.code, "42501", `${stmt.slice(0, 40)}: ${denied.message}`);
      }

      // The owner signs back in: the identical receipt settles once, consumed.
      const owner = await inTx(sql, 3, (tx) => settle(tx, own.receipt, own.output, null));
      assertEquals(
        [owner.delivery, owner.status, owner.financial_disposition, owner.result_id],
        ["settled", "result_recorded", "consumed", own.receipt.resultId],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      // …and user 4's HOLD of the same receipt id stays a HOLD (his namespace).
      const again = await inTx(sql, 4, (tx) => settle(tx, own.receipt, own.output, null));
      assertEquals([again.delivery, again.reason_code], ["replayed", "owner_mismatch"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 7 — corrupt / partial persisted state around the settlement.
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: a receipt whose session never syncs (deleted on the device before the drain) is pending on every redelivery with the ticket reserved — never consumed, never released, never fabricated; a settled rating whose session is later deleted server-side replays result_recorded without resurrecting the shot; a lease receipt after the entitlement lapsed still settles (delayed reconciliation of work done under the lease)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 5, KEY("state"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const ghostSession = crypto.randomUUID();
      const ghost = await liveReceipt(
        U(5),
        issued,
        ticketA,
        "state-ghost",
        {},
        { sessionId: ghostSession },
      );
      for (let i = 0; i < 3; i += 1) {
        const row = await inTx(sql, 5, (tx) => settle(tx, ghost.receipt, ghost.output, null));
        assertEquals(
          [row.delivery, row.status, row.financial_disposition],
          ["pending", "pending", "reserved"],
        );
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotRows(sql, `s.id = '${ghost.receipt.resultId}'`), 0);
      assertEquals(await settlementRows(sql, 5), []);
      // Once the session lands (the app's session outbox, here written by the
      // owner service), the identical redelivery settles once.
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${ghostSession}', '${U(5)}', now())`,
      );
      const landed = await inTx(sql, 5, (tx) => settle(tx, ghost.receipt, ghost.output, null));
      assertEquals([landed.delivery, landed.financial_disposition], ["settled", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);

      // Corrupt state: the session and then the rated shot are removed
      // server-side (clients hold no DELETE on either; shots.session_id is ON
      // DELETE SET NULL). The settlement row survives, the replay still says
      // result_recorded, and nothing is re-written or re-consumed.
      for (const stmt of [
        `delete from public.sessions where id = '${ghostSession}'`,
        `delete from public.shots where id = '${ghost.receipt.resultId}'`,
      ]) {
        const clientDelete = await refused(inTx(sql, 5, (tx) => tx.unsafe(stmt)));
        assertEquals(clientDelete.code, "42501", clientDelete.message);
      }
      await sql.unsafe(`delete from public.sessions where id = '${ghostSession}'`);
      assertEquals(
        (
          await sql.unsafe<{ session_id: string | null }[]>(
            `select session_id from public.shots where id = '${ghost.receipt.resultId}'`,
          )
        ).map((r) => r.session_id),
        [null],
      );
      await sql.unsafe(`delete from public.shots where id = '${ghost.receipt.resultId}'`);
      assertEquals(await shotRows(sql, `s.id = '${ghost.receipt.resultId}'`), 0);
      const afterDelete = await inTx(sql, 5, (tx) => settle(tx, ghost.receipt, ghost.output, null));
      assertEquals(
        [afterDelete.delivery, afterDelete.status, afterDelete.result_id],
        ["replayed", "result_recorded", ghost.receipt.resultId],
      );
      assertEquals(await shotRows(sql, `s.id = '${ghost.receipt.resultId}'`), 0);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 5), { held: 1, scored: 1 });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);

      // Pro lease reported after the entitlement lapsed (grant rows are
      // immutable, so expiry itself is the Edge lineage's call and pinned by
      // the candidate's rotation tests; here the DB is asked whether the
      // caller's entitlement NOW is re-judged — it must not be).
      await createUser(sql, 6);
      await makePremium(sql, 6);
      const lease = await issueLeaseGrant(sql, 6, KEY("state-lease"));
      await sql.unsafe(
        `update public.billing_entitlements set premium = false, expires_at = now() - interval '1 day' where user_id = '${U(6)}'`,
      );
      const late = await liveReceipt(
        U(6),
        lease,
        null,
        "state-late",
        {},
        {
          capturedAt: "2026-09-02T10:00:00.000Z",
        },
      );
      const lateRow = await inTx(sql, 6, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals(
        [lateRow.delivery, lateRow.status, lateRow.financial_disposition, lateRow.result_id],
        ["settled", "result_recorded", "not_applicable", late.receipt.resultId],
      );
      assertEquals(
        await shotRows(sql, `s.id = '${late.receipt.resultId}' and s.user_id = '${U(6)}'`),
        1,
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 8 — free-rating conservation across the terminal-ticket boundary,
// out-of-order and duplicate batches.
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: out-of-order delivery — the device's SECOND receipt on ticket A lands first and consumes it; the FIRST (older lifecycleSequence) then arrives and is a conflicting_receipt HOLD; a not_chargeable receipt on the consumed ticket is also HELD, never released; a released ticket's late chargeable receipt is HELD; lifetime counters never exceed the allowance",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const issued = await issueFreeGrant(sql, 7, KEY("order"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const older = await liveReceipt(U(7), issued, ticketA, "order-1", { lifecycleSequence: 1 });
      const newer = await liveReceipt(U(7), issued, ticketA, "order-2", { lifecycleSequence: 2 });

      const n = await inTx(sql, 7, (tx) => settle(tx, newer.receipt, newer.output, null));
      assertEquals([n.delivery, n.financial_disposition], ["settled", "consumed"]);
      const o = await inTx(sql, 7, (tx) => settle(tx, older.receipt, older.output, null));
      assertEquals(
        [o.delivery, o.reason_code, o.financial_disposition, o.result_id],
        ["held", "conflicting_receipt", "reserved", null],
      );
      // Both again, in both orders: replays only.
      for (const [a, b] of [
        [older, newer],
        [newer, older],
      ]) {
        const ra = await inTx(sql, 7, (tx) => settle(tx, a.receipt, a.output, null));
        const rb = await inTx(sql, 7, (tx) => settle(tx, b.receipt, b.output, null));
        assertEquals([ra.delivery, rb.delivery], ["replayed", "replayed"]);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, `s.offline_ticket_id = '${ticketA}'`), 1);

      // A "nothing to charge" claim on the consumed ticket: HOLD, not release.
      const abstainA = await liveReceipt(U(7), issued, ticketA, "order-abstain", {
        billingDisposition: "not_chargeable",
      });
      const ab = await inTx(sql, 7, (tx) => settle(tx, abstainA.receipt, null, null));
      assertEquals(
        [ab.delivery, ab.reason_code, ab.financial_disposition],
        ["held", "conflicting_receipt", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);

      // The device returns ticket B (explicit release), then a chargeable
      // receipt for B arrives late: HOLD, no consumption, no shot.
      await inTx(sql, 7, async (tx) => {
        const rows = await tx.unsafe<{ r: string }[]>(
          `select public.release_offline_ticket('${ticketB}', 'unused_ticket_returned') as r`,
        );
        assertEquals(rows[0].r, "accepted");
      });
      const lateB = await liveReceipt(U(7), issued, ticketB, "order-lateB");
      const lb = await inTx(sql, 7, (tx) => settle(tx, lateB.receipt, lateB.output, null));
      assertEquals(
        [lb.delivery, lb.reason_code, lb.financial_disposition],
        ["held", "conflicting_receipt", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      assertEquals(await shotRows(sql, `s.user_id = '${U(7)}'`), 1);
      // A released ticket still counts against the lifetime allowance
      // (release_offline_ticket contract): held 1 (B), scored 1 (A) — the
      // identity never gets a third rating out of a late receipt.
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 9 — reversible freeze: pending must never leak durable state, and
// the durable verdict must dominate the freeze however the flag flips.
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: under p_defer_new a new chargeable ticket receipt is pending 3x with nothing written; a same-id/other-digest delivery during the freeze is offline.receipt_conflict only if a durable row exists (it does not — so it is judged on its own and is also pending); when the freeze lifts the FIRST body settles and the rebody is then a conflict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      const issued = await issueFreeGrant(sql, 8, KEY("freeze"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const first = await liveReceipt(U(8), issued, ticketA, "freeze-1");
      const rebody = await liveReceipt(U(8), issued, ticketA, "freeze-2", {
        receiptId: first.receipt.receiptId,
      });
      assertNotEquals(
        await digestCanonicalOfflineJson(first.receipt),
        await digestCanonicalOfflineJson(rebody.receipt),
      );
      for (let i = 0; i < 3; i += 1) {
        const row = await inTx(sql, 8, (tx) => settle(tx, first.receipt, first.output, null, true));
        assertEquals([row.delivery, row.financial_disposition], ["pending", "reserved"]);
      }
      const rb = await inTx(sql, 8, (tx) => settle(tx, rebody.receipt, rebody.output, null, true));
      assertEquals(rb.delivery, "pending", JSON.stringify(rb));
      assertEquals(await settlementRows(sql, 8), []);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      const thawed = await inTx(sql, 8, (tx) =>
        settle(tx, first.receipt, first.output, null, false),
      );
      assertEquals([thawed.delivery, thawed.financial_disposition], ["settled", "consumed"]);
      const conflict = await inTx(sql, 8, (tx) =>
        settle(tx, rebody.receipt, rebody.output, null, true),
      );
      assertEquals(conflict.result, "offline.receipt_conflict");
      const replayFrozen = await inTx(sql, 8, (tx) =>
        settle(tx, first.receipt, first.output, null, true),
      );
      assertEquals(
        [replayFrozen.delivery, replayFrozen.financial_disposition],
        ["replayed", "consumed"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 10 — the private lease writer through every client door.
// ---------------------------------------------------------------------------

Deno.test({
  name: "HOLDS live DB: api_private.record_offline_lease_shot() is refused to anon, authenticated (with session) and service_role; a premium owner's direct scored INSERT without a vouch is refused; the lease vouch of another owner's grant, a lease vouch stacked with a ticket vouch, and a lease vouch for a FREE grant are refused by enforce_scored_shot_permit()",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      await createUser(sql, 10);
      await makePremium(sql, 9);
      const lease = await issueLeaseGrant(sql, 9, KEY("writer"));
      const out = sqlOutput(output(crypto.randomUUID()));
      const direct = `select api_private.record_offline_lease_shot('${lease.claims.jti}', ${lit(out)})`;
      for (const role of ["anon", "service_role"]) {
        const denied = await refused(
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(direct);
          }),
        );
        assertEquals(denied.code, "42501", `${role}: ${denied.message}`);
      }
      const authed = await refused(inTx(sql, 9, (tx) => tx.unsafe(direct)));
      assertEquals(authed.code, "42501", authed.message);

      const scoredInsert = (n: number): string =>
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
           overall_score, analysis_confidence, result_kind, source, app_version, model_bundle_version,
           pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
           scoring_model_version, shot_config_version)
         values ('${crypto.randomUUID()}', '${U(n)}', 'dink', 'side', now(), 0, 100, 200, 7, 0.9, 'scored', 'real',
           '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`;
      // The premium owner writing a scored row directly (no permit, no ticket,
      // no lease): premium bypasses the allowance, never the permit.
      const bare = await refused(inTx(sql, 9, (tx) => tx.unsafe(scoredInsert(9))));
      assertMatch(bare.code, /^(42501|23514|P0001)$/, bare.message);
      // Lease vouch stacked with a ticket vouch (set_config is unreachable
      // through PostgREST; this pins the gate itself).
      const stacked = await refused(
        inTx(sql, 9, async (tx) => {
          await tx.unsafe(
            `select set_config('pickle.offline_lease_grant_id', '${lease.claims.jti}', true)`,
          );
          await tx.unsafe(`select set_config('pickle.offline_ticket_id', '${TICKET_A}', true)`);
          await tx.unsafe(scoredInsert(9));
        }),
      );
      assertEquals(stacked.code, "23514", stacked.message);
      // A lease vouch naming the caller's own FREE grant (not a verified-store lease).
      const free = await issueFreeGrant(sql, 10, KEY("writer-free"));
      const freeVouch = await refused(
        inTx(sql, 10, async (tx) => {
          await tx.unsafe(
            `select set_config('pickle.offline_lease_grant_id', '${free.claims.jti}', true)`,
          );
          await tx.unsafe(scoredInsert(10));
        }),
      );
      assertEquals(freeVouch.code, "23514", freeVouch.message);
      // Another owner vouching with user 9's lease.
      const foreign = await refused(
        inTx(sql, 10, async (tx) => {
          await tx.unsafe(
            `select set_config('pickle.offline_lease_grant_id', '${lease.claims.jti}', true)`,
          );
          await tx.unsafe(scoredInsert(10));
        }),
      );
      assertEquals(foreign.code, "23514", foreign.message);
      assertEquals(await shotRows(sql, `s.user_id in ('${U(9)}', '${U(10)}')`), 0);
    } finally {
      await sql.end();
    }
  },
});
