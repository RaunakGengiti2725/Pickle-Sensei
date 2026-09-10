// W04-04 ADVERSARIAL TESTS — POST /v1/offline/receipts + settle_offline_receipt()
// at candidate sha bcab5bac215d04550e42968855f2e9d2a0ba753a.
//
// Every test below is an attack on a failure boundary of the candidate. A test
// that PASSES means the attack did NOT break the candidate (the asserted
// behaviour is the one the work package / product invariants require). A test
// that FAILS is a confirmed break — the assertion message names the invariant.
//
// Attack classes covered (≥ 6 required):
//   A1 crash between steps        — RPC dies mid-batch, redelivery settles once
//   A2 network failure at the RPC — 429+Retry-After / 5xx / 302 / malformed rows
//   A3 boundary values (Edge)     — sequence, generation, ids, queuedAt clocks
//   A4 ingress parity (Edge)      — output forwarded without shot validation
//   A5 frozen wire contract       — the manifest's `output` shape settles?
//   L1 concurrency (live)         — N parallel deliveries, settle vs release
//   L2 unauthorised roles (live)  — anon / service_role / no API key / no session
//   L3 cross-account (live)       — user B presents user A's receipt
//   L4 free-rating conservation   — held/pending/replayed never move the counters
//   L5 corrupt / partial state    — ledger and settlement rows out of step
//   L6 boundary values (SQL)      — limits the migration must refuse/accept
//   L7 Pro (no-ticket) receipts   — result_recorded without a durable result?
//   L8 ingress parity (live)      — values the shot.sync ingress refuses land
//
// Same fixtures as the candidate's own suite (harness + disposable postgres via
// XC_PG_URL); nothing in the candidate is modified. Without XC_PG_URL the live
// half is `ignore`d — an ignored run is NOT a pass.

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
const GRANT_ID = "64444444-4444-4444-8444-444444444440";
const TICKET_A = "65555555-5555-4555-8555-555555555540";
const TICKET_B = "65555555-5555-4555-8555-555555555541";
const DAY = 86_400;
const MAX_SEQUENCE = 9007199254740991;

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
  const sub = `aaaaaaaa-0404-4000-8000-a77ac${String(userSeq).padStart(7, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(ownerId: string): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: GRANT_ID,
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

/** The FLAT output the candidate's own suite settles with (the
 * consume_offline_ticket() p_shot shape). */
function flatOutput(
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

/** The output shape the FROZEN 1.0 wire contract names (build_manifest.py,
 * "Court-offline shipping path"): "the shot payload the device rated (same
 * object shape as the `shot.sync` outbox payload, WITHOUT analysisPermitId)".
 * That payload is apps/mobile/src/data/sync.ts toSyncPayload(): nested
 * `timestamps { startMs, contactMs, endMs }` and `source: 'real'`. */
function contractOutput(resultId: string): Record<string, unknown> {
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
  queuedAt?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineDeviceReceipt> {
  return {
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    lifecycleSequence: options.lifecycleSequence,
    ticket: options.ticket,
    operationId: options.operationId,
    resultId: options.resultId,
    fullOutputSha256: options.fullOutputSha256,
    billingDisposition: options.billingDisposition ?? "joint_verification_required",
    queuedAt: options.queuedAt ?? "2026-09-08T10:00:00.000Z",
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

async function entry(
  ownerId: string,
  ticketId: string,
  n: number,
  options: {
    claims?: OfflineExecutionGrantClaims;
    grant?: OfflineSignedExecutionGrant;
    receipt?: Partial<ReceiptOptions>;
    output?: Record<string, unknown>;
  } = {},
): Promise<Entry & { claims: OfflineExecutionGrantClaims }> {
  const claims = options.claims ?? freeClaims(ownerId);
  const grant = options.grant ?? (await sign(claims));
  const resultId = `7a77ac0${n % 10}-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = flatOutput(resultId, options.output);
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
    ...options.receipt,
  });
  return { claims, receipt: rec, grant, output: out };
}

// ---------------------------------------------------------------------------
// Durable RPC stand-in with an injectable fault and a settlement counter.
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
/** How many times a NEW settlement was written per receipt id (a correct
 * server never writes the same receipt twice). */
const settlements = new Map<string, number>();
/** A fault the stand-in raises for a given receipt id on its next call. */
let fault: { receiptId: string; respond: () => Response } | null = null;

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  const params = settleParams(call);
  const receiptId = String(params.p_receipt.receiptId);
  if (fault !== null && fault.receiptId === receiptId) {
    const respond = fault.respond;
    fault = null;
    return respond();
  }
  const key = `${call.headers.authorization}|${receiptId}`;
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
    settlements.set(receiptId, (settlements.get(receiptId) ?? 0) + 1);
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
    settlements.set(receiptId, (settlements.get(receiptId) ?? 0) + 1);
  }
  return new Response(JSON.stringify([row]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function reset(): void {
  h.reset();
  durable.clear();
  settlements.clear();
  fault = null;
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

interface RouteVerdict {
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

async function answer(
  response: Response,
): Promise<{ receipts: RouteVerdict[]; rejected: RouteRejection[] }> {
  const body = (await response.json()) as Record<string, unknown>;
  assertEquals(response.status, 200, JSON.stringify(body));
  assert(Array.isArray(body.receipts), "receipts[] expected");
  assert(Array.isArray(body.rejected), "rejected[] expected");
  const receipts = body.receipts as RouteVerdict[];
  const rejected = body.rejected as RouteRejection[];
  const ids = [...receipts.map((r) => r.receiptId), ...rejected.map((r) => r.receiptId)];
  assertEquals(new Set(ids).size, ids.length, "every receipt id answered once");
  return { receipts, rejected };
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

const byId = (rows: RouteVerdict[], id: string): RouteVerdict => {
  const row = rows.find((r) => r.receiptId === id);
  assert(row, `verdict for ${id} expected`);
  return row;
};

// ---------------------------------------------------------------------------
// A1 — crash between steps. The RPC dies on the SECOND entry of a three-entry
// batch after the first has durably settled. The redelivery must replay the
// first (no second settlement), settle the other two, and every id must be
// answered exactly once in both answers.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK A1 (crash between steps): the RPC dies mid-batch; the redelivered batch settles each receipt exactly once",
  async () => {
    reset();
    const user = freshUser();
    const e1 = await entry(user.sub, TICKET_A, 1);
    const e2 = await entry(user.sub, TICKET_B, 2, { claims: e1.claims, grant: e1.grant });
    const e3 = await entry(user.sub, TICKET_B, 3, {
      claims: e1.claims,
      grant: e1.grant,
      receipt: { billingDisposition: "not_chargeable" },
      output: { resultKind: "low_confidence", overallScore: null },
    });
    const batch = [e1, e2, e3].map(({ receipt, grant, output }) => ({ receipt, grant, output }));

    fault = { receiptId: "receipt-2", respond: () => new Response("boom", { status: 500 }) };
    const crashed = await post({ receipts: batch }, user.token);
    assertEquals(crashed.status, 503, "a mid-batch RPC failure must be a 503, never a partial 200");
    const crashedBody = await crashed.text();
    assert(!crashedBody.includes("boom"), "5xx bodies stay generic");
    assertEquals(settleCalls().length, 2, "the batch stops at the failed entry");
    assertEquals(settlements.get("receipt-1"), 1);
    assertEquals(settlements.get("receipt-2"), undefined);
    assertEquals(settlements.get("receipt-3"), undefined);

    // The device (or a restarted isolate) redelivers the identical batch.
    h.calls.length = 0;
    const out = await answer(await post({ receipts: batch }, user.token));
    assertEquals(out.rejected, []);
    assertEquals(
      out.receipts.map((r) => [r.receiptId, r.delivery, r.financialDisposition]),
      [
        ["receipt-1", "replayed", "consumed"],
        ["receipt-2", "settled", "consumed"],
        ["receipt-3", "settled", "reserved"],
      ],
    );
    assertEquals(settlements.get("receipt-1"), 1, "receipt-1 must never settle twice");
    assertEquals(settlements.get("receipt-2"), 1);
    assertEquals(settlements.get("receipt-3"), 1);
    // A third delivery, reordered, is pure replay.
    const again = await answer(await post({ receipts: [...batch].reverse() }, user.token));
    assertEquals(
      again.receipts.map((r) => r.delivery),
      ["replayed", "replayed", "replayed"],
    );
    assertEquals([...settlements.values()], [1, 1, 1]);
  },
);

// ---------------------------------------------------------------------------
// A2 — network failure at the RPC step: 429 + Retry-After, 502, a redirect,
// an empty row set, two rows, a non-array body. None may settle anything, none
// may leak the upstream body, and the identical redelivery afterwards settles
// once.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK A2 (network failure at the RPC): 429/5xx/redirect/malformed RPC answers settle nothing and the redelivery settles once",
  async () => {
    reset();
    const user = freshUser();
    const e1 = await entry(user.sub, TICKET_A, 1);
    const batch = [{ receipt: e1.receipt, grant: e1.grant, output: e1.output }];
    const faults: Array<[string, () => Response]> = [
      [
        "429+Retry-After",
        () =>
          new Response(JSON.stringify({ message: "rate limited upstream-secret" }), {
            status: 429,
            headers: { "Retry-After": "7", "Content-Type": "application/json" },
          }),
      ],
      ["502", () => new Response("bad gateway upstream-secret", { status: 502 })],
      [
        "302",
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://evil.example/collect" },
          }),
      ],
      [
        "empty rows",
        () => new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
      ],
      [
        "two rows",
        () =>
          new Response(
            JSON.stringify([
              {
                result: "accepted",
                delivery: "settled",
                status: "result_recorded",
                reason_code: null,
                financial_disposition: "consumed",
                result_id: e1.receipt.resultId,
              },
              {
                result: "accepted",
                delivery: "settled",
                status: "result_recorded",
                reason_code: null,
                financial_disposition: "consumed",
                result_id: e1.receipt.resultId,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ],
      [
        "non-array body",
        () =>
          new Response(JSON.stringify({ result: "accepted", delivery: "settled" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ],
      [
        "unknown result code",
        () =>
          new Response(
            JSON.stringify([
              {
                result: "accepted",
                delivery: "teleported",
                status: "result_recorded",
                reason_code: null,
                financial_disposition: "consumed",
                result_id: e1.receipt.resultId,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ],
    ];
    for (const [label, respond] of faults) {
      fault = { receiptId: "receipt-1", respond };
      const response = await post({ receipts: batch }, user.token);
      const body = await response.text();
      assertEquals(response.status, 503, `${label}: expected 503, got ${response.status} ${body}`);
      assert(!body.includes("upstream-secret"), `${label}: upstream body leaked`);
      assert(!body.includes("evil.example"), `${label}: redirect target leaked`);
      assertEquals(settlements.get("receipt-1"), undefined, `${label}: settled through a fault`);
      assertEquals(fault, null, `${label}: the fault was never reached`);
    }
    // Only the retry the device performs after the faults settles — once.
    const out = await answer(await post({ receipts: batch }, user.token));
    assertEquals(
      out.receipts.map((r) => r.delivery),
      ["settled"],
    );
    assertEquals(settlements.get("receipt-1"), 1);
  },
);

// ---------------------------------------------------------------------------
// A3 — boundary values at the Edge. Each malformed receipt must be refused
// PER ENTRY (the honest receipt beside it settles), never reach the RPC, and
// be answered under its own id. Far-future / far-past / calendar-invalid
// queuedAt clocks are probed as well.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK A3 (boundary values, Edge): sequence/generation/id/clock extremes are refused per entry and never reach the RPC; the honest receipt settles",
  async () => {
    reset();
    const user = freshUser();
    const honest = await entry(user.sub, TICKET_A, 1);
    const { claims, grant } = honest;
    const bad = async (
      n: number,
      patch: Partial<ReceiptOptions>,
      mutate: (r: Record<string, unknown>) => void = () => {},
    ): Promise<Entry> => {
      const e = await entry(user.sub, TICKET_B, n, { claims, grant, receipt: patch });
      const rec = { ...e.receipt } as Record<string, unknown>;
      mutate(rec);
      return { receipt: rec as unknown as OfflineDeviceReceipt, grant, output: e.output };
    };
    const zeroSeq = await bad(2, { lifecycleSequence: 0 });
    const negSeq = await bad(3, { lifecycleSequence: -1 });
    const fracSeq = await bad(4, { lifecycleSequence: 1.5 });
    const hugeSeq = await bad(5, { lifecycleSequence: MAX_SEQUENCE + 1 });
    const zeroGen = await bad(6, {}, (r) => {
      r.ticket = { ...(r.ticket as Record<string, unknown>), generation: 0 };
    });
    const strGen = await bad(7, {}, (r) => {
      r.ticket = { ...(r.ticket as Record<string, unknown>), generation: "3" };
    });
    const offsetClock = await bad(8, { queuedAt: "2026-09-08T12:00:00.000+02:00" });
    const epochClock = await bad(9, {}, (r) => {
      r.queuedAt = 1757325600000;
    });
    const monthClock = await bad(10, { queuedAt: "2026-13-01T00:00:00.000Z" });
    const emptyId = await bad(11, {}, (r) => {
      r.receiptId = "";
    });
    const longId = await bad(12, {}, (r) => {
      r.receiptId = "r".repeat(129);
    });
    const extraField = await bad(13, {}, (r) => {
      r.nativeTime = { wallClockMs: 1 };
    });
    const upperDigest = await bad(14, {}, (r) => {
      r.fullOutputSha256 = String(r.fullOutputSha256).toUpperCase();
    });
    const nullTicketField = await bad(15, {}, (r) => {
      r.ticket = { ...(r.ticket as Record<string, unknown>), ticketId: null };
    });

    const batch: Entry[] = [
      { receipt: honest.receipt, grant, output: honest.output },
      zeroSeq,
      negSeq,
      fracSeq,
      hugeSeq,
      zeroGen,
      strGen,
      offsetClock,
      epochClock,
      monthClock,
      extraField,
      upperDigest,
      nullTicketField,
    ];
    const out = await answer(await post({ receipts: batch }, user.token));
    assertEquals(
      out.receipts.map((r) => [r.receiptId, r.delivery]),
      [["receipt-1", "settled"]],
    );
    assertEquals(
      out.rejected.map((r) => r.receiptId).sort(),
      batch
        .slice(1)
        .map((e) => e.receipt.receiptId)
        .sort(),
      "every malformed entry refused under its own id",
    );
    for (const r of out.rejected) assertEquals(r.code, "offline.invalid_input");
    assertEquals(settleCalls().length, 1, "malformed receipts never reach the RPC");
    assertEquals(settleCalls()[0].p_receipt.receiptId, "receipt-1");

    // A receipt id the answer cannot name (empty / > 128) refuses the WHOLE
    // batch — nothing beside it settles, and nothing reaches the RPC.
    for (const poison of [emptyId, longId]) {
      h.calls.length = 0;
      const e2 = await entry(user.sub, TICKET_B, 20, { claims, grant });
      const response = await post(
        { receipts: [{ receipt: e2.receipt, grant, output: e2.output }, poison] },
        user.token,
      );
      assertEquals(response.status, 400);
      const body = (await response.json()) as { error?: { code?: string } };
      assertEquals(body.error?.code, "offline.invalid_input");
      assertEquals(settleCalls().length, 0);
    }

    // Clock extremes the validator ACCEPTS: far future, far past, the exact
    // 128-char id, the maximum safe sequence. They must settle (the digest binds
    // whatever the device queued) — and the same receipt must replay.
    h.calls.length = 0;
    const extremes: Entry[] = [];
    let n = 30;
    for (const patch of [
      { queuedAt: "9999-12-31T23:59:59.999Z" },
      { queuedAt: "0001-01-01T00:00:00Z" },
      { queuedAt: "2026-02-30T00:00:00.000Z" },
      { queuedAt: "2026-09-08T24:00:00.000Z" },
      { receiptId: "x".repeat(128) },
      { lifecycleSequence: MAX_SEQUENCE },
    ] as Partial<ReceiptOptions>[]) {
      n += 1;
      const e = await entry(user.sub, TICKET_B, n, { claims, grant, receipt: patch });
      extremes.push({ receipt: e.receipt, grant, output: e.output });
    }
    const first = await answer(await post({ receipts: extremes }, user.token));
    assertEquals(first.rejected, []);
    assertEquals(
      first.receipts.map((r) => r.delivery),
      extremes.map(() => "settled"),
    );
    const second = await answer(await post({ receipts: extremes }, user.token));
    assertEquals(
      second.receipts.map((r) => r.delivery),
      extremes.map(() => "replayed"),
    );
    // Documented observation (not asserted as a break): calendar-invalid
    // instants such as Feb 30 and 24:00:00 pass the Edge validator because
    // Date.parse() rolls them over — recorded here so the boundary is visible.
    assertEquals(byId(first.receipts, "receipt-33").delivery, "settled");
    assertEquals(byId(first.receipts, "receipt-34").delivery, "settled");
  },
);

// ---------------------------------------------------------------------------
// A4 — ingress parity at the Edge. The candidate hands `output` to the RPC
// after checking only its `id` and canonical digest; nothing of what
// parseSyncShot enforces for the online shot.sync ingress (0..2^31-1 ms,
// scored ⇒ 0..10, ≤ 64-char keys, source='real') is applied. This test PINS
// that the Edge forwards such an output unchanged (the live half, L8, then
// shows what the database does with it).
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK A4 (ingress parity, Edge): an output the shot.sync ingress would refuse is forwarded to the RPC verbatim",
  async () => {
    reset();
    const user = freshUser();
    const hostile = {
      startMs: -2147483648,
      contactMs: 2147483647,
      endMs: -1,
      phases: [
        { key: "prep", startMs: -5, representativeMs: -5, endMs: -1, confidence: 0.8 },
        { key: "prep", startMs: 0, representativeMs: 0, endMs: 0, confidence: 0.8 },
      ],
      source: "synthetic",
    };
    const e1 = await entry(user.sub, TICKET_A, 1, { output: hostile });
    const out = await answer(
      await post(
        { receipts: [{ receipt: e1.receipt, grant: e1.grant, output: e1.output }] },
        user.token,
      ),
    );
    assertEquals(out.rejected, []);
    assertEquals(out.receipts[0].delivery, "settled");
    const [call] = settleCalls();
    assertEquals(call.p_hold_reason, null, "the Edge derived no hold for the hostile output");
    assertEquals(call.p_output, e1.output, "forwarded verbatim");
    assertEquals((call.p_output as Record<string, unknown>).startMs, -2147483648);
    assertEquals((call.p_output as Record<string, unknown>).source, "synthetic");
  },
);

// ---------------------------------------------------------------------------
// A5 — the frozen wire contract's output shape at the Edge: `timestamps`
// nested + `source: 'real'` (toSyncPayload without analysisPermitId). The Edge
// binds it (id + digest match) and forwards it with NO hold reason and NO
// normalisation — so whether it settles is decided by the SQL (see L-FROZEN).
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK A5 (frozen wire contract, Edge): the manifest's `output` shape is bound and forwarded with no hold and no normalisation to the flat p_shot shape",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const grant = await sign(claims);
    const resultId = "7a77ac05-0404-4000-8000-000000000005";
    const out = contractOutput(resultId);
    const rec = await receipt({
      receiptId: "receipt-contract",
      ownerId: user.sub,
      grant,
      claims,
      ticket: ticketRef(TICKET_A, claims),
      lifecycleSequence: 1,
      operationId: "operation-contract",
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(out),
    });
    const answered = await answer(
      await post({ receipts: [{ receipt: rec, grant, output: out }] }, user.token),
    );
    assertEquals(answered.rejected, []);
    const [call] = settleCalls();
    assertEquals(call.p_hold_reason, null);
    assertEquals(call.p_output, out);
    assertEquals(
      (call.p_output as Record<string, unknown>).startMs,
      undefined,
      "no flat startMs is derived from timestamps.startMs",
    );
  },
);

// ---------------------------------------------------------------------------
// Live postgres half — the REAL settle_offline_receipt() with every migration
// applied. Same helpers as the candidate suite.
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000a-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000a-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
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

async function asUser(
  tx: Tx,
  n: number,
  options: { session?: boolean; apiKey?: boolean; role?: string } = {},
): Promise<void> {
  if (options.apiKey !== false) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role ${options.role ?? "authenticated"}`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (options.session !== false) {
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
  rec: OfflineDeviceReceipt | Record<string, unknown>,
  out: Record<string, unknown> | null,
  hold: string | null,
  deferNew = false,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(
    `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(out)},
       ${hold === null ? "null::text" : `'${hold}'`},
       ${deferNew ? "true" : "false"}
     ) r`,
  );
  assertEquals(rows.length, 1);
  return rows[0];
}

async function sqlError(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
  return "";
}

async function ledgerEvents(sql: Sql, ticketId: string): Promise<string[]> {
  const rows = await sql.unsafe<{ event: string }[]>(
    `select event from public.offline_allocation_ledger where ticket_id = '${ticketId}' order by id`,
  );
  return rows.map((row) => row.event);
}

type LiveGrant = { claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant };

async function issueGrant(
  sql: Sql,
  n: number,
  key: string,
  requested: number,
  register = true,
): Promise<LiveGrant> {
  if (register) {
    await inTx(sql, n, async (tx) => {
      const rows = await tx.unsafe<{ result: string }[]>(
        `select r.result from public.register_offline_device('${key}', 'production', true) r`,
      );
      assertEquals(rows[0].result, "accepted");
    });
  }
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

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string | null,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = flatOutput(resultId, outputOverrides);
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

/** Simulate corruption a superuser repair / partial persist would leave:
 * the row disappears without the append-only guards firing. */
async function corruptDelete(sql: Sql, statement: string): Promise<void> {
  const table = /from (public\.[a-z_]+)/.exec(statement)?.[1];
  assert(table, "delete statement expected");
  await sql.begin(async (tx) => {
    await tx.unsafe(`alter table ${table} disable trigger all`);
    await tx.unsafe(statement);
    await tx.unsafe(`alter table ${table} enable trigger all`);
  });
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

function tickets(issued: LiveGrant): readonly string[] {
  assert(issued.claims.allocation, "free grant expected");
  return issued.claims.allocation.ticketIds;
}

// ---------------------------------------------------------------------------
// L-FROZEN — the frozen wire contract's output shape against the REAL
// settle_offline_receipt(). The manifest freezes `output` as the shot.sync
// payload without analysisPermitId (nested timestamps, source 'real'); the
// candidate forwards it verbatim (A5) and consume_offline_ticket() reads FLAT
// startMs/contactMs/endMs. A receipt the device produces exactly per contract
// must settle as consumed with the shot written — not HOLD forever.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L-FROZEN (wire contract): a receipt whose output is exactly the frozen contract shape (shot.sync payload minus analysisPermitId) settles as consumed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueGrant(sql, 1, KEY("frozen"), 2);
      const [ticketA] = tickets(issued);
      const resultId = crypto.randomUUID();
      const out = contractOutput(resultId);
      const rec = await receipt({
        receiptId: `receipt-frozen-${RUN}`,
        ownerId: U(1),
        grant: issued.grant,
        claims: issued.claims,
        ticket: ticketRef(ticketA, issued.claims),
        lifecycleSequence: 1,
        operationId: `operation-frozen-${RUN}`,
        resultId,
        fullOutputSha256: await digestCanonicalOfflineJson(out),
      });
      const verdict = await inTx(sql, 1, (tx) => settle(tx, rec, out, null));
      assertEquals(
        verdict,
        {
          result: "accepted",
          delivery: "settled",
          status: "result_recorded",
          reason_code: null,
          financial_disposition: "consumed",
          result_id: resultId,
        },
        "BREAK: the contract-shaped output does not settle — the device's honest receipt is HELD",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L1 — concurrency. Eight parallel deliveries of the SAME receipt on separate
// connections; two DIFFERENT receipts for the same ticket in parallel; a
// settlement racing release_offline_ticket(). Exactly one financial outcome
// per ticket, every time.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L1 (concurrency): parallel identical deliveries consume once; parallel rival receipts consume once and hold the other; settle vs release yields exactly one terminal event",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueGrant(sql, 2, KEY("race"), 2);
      const [ticketA, ticketB] = tickets(issued);

      // (a) 8 × the same receipt at once.
      const same = await liveReceipt(U(2), issued, ticketA, "race-same");
      const rows = await Promise.all(
        Array.from({ length: 8 }, () =>
          inTx(sql, 2, (tx) => settle(tx, same.receipt, same.output, null)),
        ),
      );
      const deliveries = rows.map((r) => r.delivery).sort();
      assertEquals(
        rows.every((r) => r.result === "accepted" && r.status === "result_recorded"),
        true,
      );
      assertEquals(
        rows.every((r) => r.financial_disposition === "consumed"),
        true,
      );
      assertEquals(deliveries.filter((d) => d === "settled").length, 1, "exactly one settlement");
      assertEquals(deliveries.filter((d) => d === "replayed").length, 7);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);

      // (b) two rival receipts (different operation/result) for ticket B at once.
      const rivalX = await liveReceipt(U(2), issued, ticketB, "race-x", { lifecycleSequence: 2 });
      const rivalY = await liveReceipt(U(2), issued, ticketB, "race-y", { lifecycleSequence: 3 });
      const [x, y] = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, rivalX.receipt, rivalX.output, null)),
        inTx(sql, 2, (tx) => settle(tx, rivalY.receipt, rivalY.output, null)),
      ]);
      const outcomes = [x, y].map((r) => `${r.delivery}:${r.financial_disposition}`).sort();
      assertEquals(outcomes, ["held:reserved", "settled:consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketB), 1);
      const winner = x.delivery === "settled" ? x : y;
      const loser = x.delivery === "settled" ? y : x;
      assertEquals(loser.reason_code, "conflicting_receipt");
      assertNotEquals(winner.result_id, null);

      // (c) a fresh grant: settle racing release for the same ticket.
      await createUser(sql, 3);
      const issued3 = await issueGrant(sql, 3, KEY("race-release"), 1);
      const [ticketC] = tickets(issued3);
      const rec = await liveReceipt(U(3), issued3, ticketC, "race-release");
      const outcomesC = await Promise.all([
        inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null)).then(
          (r) => `settle:${r.delivery}:${r.financial_disposition}`,
        ),
        inTx(sql, 3, async (tx) => {
          const [{ result }] = await tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketC}', 'unused_ticket_returned') as result`,
          );
          return `release:${result}`;
        }),
      ]);
      const events = await ledgerEvents(sql, ticketC);
      assertEquals(
        events.length,
        2,
        `one terminal event, got ${events.join(",")} via ${outcomesC.join(" | ")}`,
      );
      assert(events[1] === "consumed" || events[1] === "released");
      if (events[1] === "consumed") {
        assertEquals(await shotCount(sql, ticketC), 1);
        assert(outcomesC.includes("settle:settled:consumed"), outcomesC.join(" | "));
      } else {
        assertEquals(await shotCount(sql, ticketC), 0);
        assert(outcomesC.includes("settle:held:reserved"), outcomesC.join(" | "));
      }
      // The redelivery after the race replays whatever was decided; nothing moves.
      const again = await inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "replayed");
      assertEquals(await ledgerEvents(sql, ticketC), events);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L2 — unauthorised roles for the new SQL surface (allowed AND denied paths).
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L2 (roles): anon and service_role cannot execute settle_offline_receipt(); authenticated without the API key or a live session is refused; the live session settles",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      const issued = await issueGrant(sql, 4, KEY("roles"), 1);
      const [ticketA] = tickets(issued);
      const rec = await liveReceipt(U(4), issued, ticketA, "roles");
      const signature = "public.settle_offline_receipt(jsonb, text, jsonb, text, boolean)";
      const [priv] = await sql.unsafe<
        { anon: boolean; service: boolean; authed: boolean; pub: boolean }[]
      >(
        `select has_function_privilege('anon', '${signature}', 'execute') as anon,
                has_function_privilege('service_role', '${signature}', 'execute') as service,
                has_function_privilege('authenticated', '${signature}', 'execute') as authed,
                has_function_privilege('public', '${signature}', 'execute') as pub`,
      );
      assertEquals(priv, { anon: false, service: false, authed: true, pub: false });
      // The old 4-argument signature is gone (no second, differently guarded path).
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = 'settle_offline_receipt'`,
      );
      assertEquals(count, "1");

      for (const role of ["anon", "service_role"]) {
        const code = await sqlError(() =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, 4, { role });
            await settle(tx as unknown as Tx, rec.receipt, rec.output, null);
          }),
        );
        assertEquals(code, "42501", `${role} must not execute the settlement RPC`);
      }
      // authenticated, live session, but WITHOUT the API request key header.
      const noKey = await sqlError(() =>
        sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, 4, { apiKey: false });
          await settle(tx as unknown as Tx, rec.receipt, rec.output, null);
        }),
      );
      assertEquals(noKey, "42501", "no API key → refused");
      // authenticated, API key, no session claim.
      const noSession = await sqlError(() =>
        sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, 4, { session: false });
          await settle(tx as unknown as Tx, rec.receipt, rec.output, null);
        }),
      );
      assertEquals(noSession, "42501", "no live session → refused");
      // A session that has been revoked (not_after in the past).
      await sql.unsafe(
        `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SESSION(4)}'`,
      );
      const revoked = await sqlError(() =>
        inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, null)),
      );
      assertEquals(revoked, "42501", "revoked session → refused");
      await sql.unsafe(`update auth.sessions set not_after = null where id = '${SESSION(4)}'`);
      assertEquals(
        await ledgerEvents(sql, ticketA),
        ["allocated"],
        "nothing consumed by any denied path",
      );
      assertEquals(
        (
          await sql.unsafe(
            `select 1 from public.offline_receipt_settlements where user_id = '${U(4)}'`,
          )
        ).length,
        0,
      );
      // Allowed path.
      const ok = await inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(ok.delivery, "settled");
      assertEquals(ok.financial_disposition, "consumed");
      // anon / service_role cannot read the settlement table either.
      for (const role of ["anon", "service_role", "authenticated"]) {
        const code = await sqlError(() =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, 4, { role });
            await tx.unsafe(`select receipt from public.offline_receipt_settlements`);
          }),
        );
        assertEquals(code, "42501", `${role} read of settlements`);
      }
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L3 — cross-account. User B presents user A's receipt (A's owner id, A's
// grant, A's ticket): held under B as owner_mismatch, nothing of A's moves; B
// then forges ownerId = B over A's ticket: held as evidence_ambiguous; A still
// settles her own receipt exactly once afterwards. B's holds never count
// against A, and A's ticket never counts against B.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L3 (cross-account): another user presenting or re-owning a foreign receipt is held and moves nothing of the owner's; the owner still settles once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      await createUser(sql, 6);
      const issuedA = await issueGrant(sql, 5, KEY("owner-a"), 1);
      const [ticketA] = tickets(issuedA);
      const recA = await liveReceipt(U(5), issuedA, ticketA, "owner-a");
      const beforeA = await counters(sql, 5);
      const beforeB = await counters(sql, 6);
      assertEquals(beforeA, { held: 1, scored: 0 });
      assertEquals(beforeB, { held: 0, scored: 0 });

      // B replays A's receipt verbatim (the Edge would derive owner_mismatch; the
      // SQL must derive it on its own too).
      const stolen = await inTx(sql, 6, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(stolen, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "owner_mismatch",
        financial_disposition: "reserved",
        result_id: null,
      });
      // B re-owns it: same ticket, ownerId = B, own receipt id / operation.
      const reowned = await liveReceipt(U(6), issuedA, ticketA, "owner-b", {
        lifecycleSequence: 1,
      });
      const forged = await inTx(sql, 6, (tx) => settle(tx, reowned.receipt, reowned.output, null));
      assertEquals(forged.delivery, "held");
      assertEquals(forged.reason_code, "evidence_ambiguous");
      assertEquals(forged.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(
        (await sql.unsafe(`select 1 from public.shots where id = '${reowned.receipt.resultId}'`))
          .length,
        0,
      );
      assertEquals(await counters(sql, 5), beforeA, "A's counters untouched by B");
      assertEquals(await counters(sql, 6), beforeB, "B's holds never count foreign tickets");

      // A settles her own receipt — once — and B's hold rows remain B's.
      const mine = await inTx(sql, 5, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(mine.delivery, "settled");
      assertEquals(mine.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 5), { held: 0, scored: 1 });
      const replayB = await inTx(sql, 6, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(replayB, { ...stolen, delivery: "replayed" });
      const rows = await sql.unsafe<{ user_id: string; status: string; result_id: string }[]>(
        `select user_id, status, result_id from public.offline_receipt_settlements
         where receipt_id = '${recA.receipt.receiptId}' order by id`,
      );
      assertEquals(
        rows.map((r) => [r.user_id, r.status]),
        [
          [U(6), "reconciliation_required"],
          [U(5), "result_recorded"],
        ],
      );
      const [shot] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${recA.receipt.resultId}'`,
      );
      assertEquals(shot.user_id, U(5), "the shot belongs to the owner, never to the presenter");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L4 — free-rating conservation and duplicate identities. Held (missing /
// ambiguous / conflicting), pending (deferred, session missing), replayed and
// abstention outcomes must leave lifetime_scored_count() and
// offline_hold_count() exactly where they were; one consumed ticket moves
// scored by exactly one. Same operation under another ticket, same result
// under another operation: held, ticket kept.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L4 (conservation + duplicate identities): held/pending/replayed/abstained outcomes never move the counters; a consumed ticket moves scored by exactly one; reused operation/result ids are held with their ticket kept",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const issued = await issueGrant(sql, 7, KEY("conserve"), 2);
      const [ticketA, ticketB] = tickets(issued);
      assertEquals(await counters(sql, 7), { held: 2, scored: 0 });

      // Deferred under a reversible freeze: pending, nothing durable.
      const good = await liveReceipt(U(7), issued, ticketA, "conserve-good");
      const deferred = await inTx(sql, 7, (tx) =>
        settle(tx, good.receipt, good.output, null, true),
      );
      assertEquals(deferred.delivery, "pending");
      // Session not yet synced: pending, nothing durable.
      const orphan = await liveReceipt(
        U(7),
        issued,
        ticketA,
        "conserve-orphan",
        { lifecycleSequence: 2 },
        {
          sessionId: crypto.randomUUID(),
        },
      );
      const notYet = await inTx(sql, 7, (tx) => settle(tx, orphan.receipt, orphan.output, null));
      assertEquals(notYet.delivery, "pending");
      // Missing output for a chargeable receipt: held.
      const missing = await liveReceipt(U(7), issued, ticketA, "conserve-missing", {
        lifecycleSequence: 3,
      });
      assertEquals(
        (await inTx(sql, 7, (tx) => settle(tx, missing.receipt, null, null))).reason_code,
        "evidence_missing",
      );
      // Output naming another result: held.
      const other = await liveReceipt(U(7), issued, ticketA, "conserve-other", {
        lifecycleSequence: 4,
      });
      assertEquals(
        (
          await inTx(sql, 7, (tx) =>
            settle(tx, other.receipt, { ...other.output, id: crypto.randomUUID() }, null),
          )
        ).reason_code,
        "evidence_ambiguous",
      );
      // Edge-derived hold: held.
      const edge = await liveReceipt(U(7), issued, ticketA, "conserve-edge", {
        lifecycleSequence: 5,
      });
      assertEquals(
        (await inTx(sql, 7, (tx) => settle(tx, edge.receipt, edge.output, "grant_revoked")))
          .delivery,
        "held",
      );
      assertEquals(
        await counters(sql, 7),
        { held: 2, scored: 0 },
        "nothing above may move a counter",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(
        (
          await sql.unsafe(
            `select 1 from public.offline_receipt_settlements where user_id = '${U(7)}' and status <> 'reconciliation_required'`,
          )
        ).length,
        0,
        "pending answers wrote nothing durable",
      );

      // The honest receipt now settles (freeze lifted): scored +1, held −1.
      const settled = await inTx(sql, 7, (tx) => settle(tx, good.receipt, good.output, null));
      assertEquals(settled.delivery, "settled");
      assertEquals(settled.financial_disposition, "consumed");
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });
      for (let i = 0; i < 3; i += 1) {
        assertEquals(
          (await inTx(sql, 7, (tx) => settle(tx, good.receipt, good.output, null))).delivery,
          "replayed",
        );
      }
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 }, "replays never re-charge");

      // Duplicate identities across tickets: same operation id under ticket B;
      // same result id under ticket B with a new operation.
      const sameOp = await liveReceipt(U(7), issued, ticketB, "conserve-sameop", {
        lifecycleSequence: 6,
        operationId: good.receipt.operationId,
      });
      const sameOpVerdict = await inTx(sql, 7, (tx) =>
        settle(tx, sameOp.receipt, sameOp.output, null),
      );
      assertEquals(
        [sameOpVerdict.delivery, sameOpVerdict.reason_code],
        ["held", "conflicting_receipt"],
      );
      const sameResult = await liveReceipt(U(7), issued, ticketB, "conserve-sameresult", {
        lifecycleSequence: 7,
        resultId: good.receipt.resultId,
        fullOutputSha256: good.receipt.fullOutputSha256,
      });
      const sameResultVerdict = await inTx(sql, 7, (tx) =>
        settle(tx, sameResult.receipt, good.output, null),
      );
      assertEquals(
        [sameResultVerdict.delivery, sameResultVerdict.reason_code],
        ["held", "conflicting_receipt"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });

      // An abstention on ticket B: recorded, ticket kept; a later scored receipt
      // on the same ticket still consumes it exactly once.
      const abstain = await liveReceipt(
        U(7),
        issued,
        ticketB,
        "conserve-abstain",
        { lifecycleSequence: 8, billingDisposition: "not_chargeable" },
        { resultKind: "low_confidence", overallScore: null },
      );
      const abstained = await inTx(sql, 7, (tx) =>
        settle(tx, abstain.receipt, abstain.output, null),
      );
      assertEquals(
        [abstained.status, abstained.financial_disposition],
        ["result_recorded", "reserved"],
      );
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });
      const later = await liveReceipt(U(7), issued, ticketB, "conserve-later", {
        lifecycleSequence: 9,
      });
      const laterVerdict = await inTx(sql, 7, (tx) =>
        settle(tx, later.receipt, later.output, null),
      );
      assertEquals(
        [laterVerdict.delivery, laterVerdict.financial_disposition],
        ["settled", "consumed"],
      );
      assertEquals(await counters(sql, 7), { held: 0, scored: 2 });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      // The abstention replays as recorded/reserved even though the ticket is
      // now consumed — the durable verdict, not a re-judgement.
      const abstainAgain = await inTx(sql, 7, (tx) =>
        settle(tx, abstain.receipt, abstain.output, null),
      );
      assertEquals(abstainAgain, { ...abstained, delivery: "replayed" });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L5 — corrupt / partially persisted state (process death between the
// ledger write and the settlement row, or a lost settlement row). Whatever
// the corruption, redelivery must never charge a second time, never write a
// second shot, and never fabricate a consumed verdict without a ledger event.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L5 (corrupt/partial state): a settlement row lost after the ledger consumed, or a consumed ticket whose shot vanished, never double-charges or re-writes on redelivery",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      const issued = await issueGrant(sql, 8, KEY("corrupt"), 2);
      const [ticketA, ticketB] = tickets(issued);

      // (a) Ledger consumed + shot written, settlement row LOST (partial persist).
      const recA = await liveReceipt(U(8), issued, ticketA, "corrupt-a");
      const first = await inTx(sql, 8, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(first.financial_disposition, "consumed");
      // Defence: even the table owner cannot delete a settlement through the
      // normal path (append-only trigger). The corruption below is simulated
      // with triggers disabled, as a partial persist / broken repair would leave it.
      const guarded = await sqlError(() =>
        sql.unsafe(
          `delete from public.offline_receipt_settlements where receipt_id = '${recA.receipt.receiptId}'`,
        ),
      );
      assertNotEquals(guarded, "", "settlement rows are append-only");
      await corruptDelete(
        sql,
        `delete from public.offline_receipt_settlements where receipt_id = '${recA.receipt.receiptId}'`,
      );
      // The ledger says consumed and the shot exists, the settlement row does
      // not: the state is ambiguous. Either answer is honest — the durable
      // result (consumed, that one shot) or a HOLD — but never a second
      // charge, a second shot, or a refund.
      const redelivered = await inTx(sql, 8, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(redelivered.result, "accepted");
      assert(
        (redelivered.status === "result_recorded" &&
          redelivered.financial_disposition === "consumed" &&
          redelivered.result_id === recA.receipt.resultId) ||
          (redelivered.delivery === "held" && redelivered.financial_disposition === "reserved"),
        `unknown state became something other than the durable result or a HOLD: ${JSON.stringify(redelivered)}`,
      );
      assertEquals(
        await ledgerEvents(sql, ticketA),
        ["allocated", "consumed"],
        "no second consume",
      );
      assertEquals(await shotCount(sql, ticketA), 1, "no second shot");
      assertEquals((await counters(sql, 8)).scored, 1, "scored moves by exactly one");
      // A rival receipt for the consumed ticket now: held, ticket untouched.
      const rival = await liveReceipt(U(8), issued, ticketA, "corrupt-rival", {
        lifecycleSequence: 2,
      });
      const rivalVerdict = await inTx(sql, 8, (tx) =>
        settle(tx, rival.receipt, rival.output, null),
      );
      assertEquals(
        [rivalVerdict.delivery, rivalVerdict.reason_code],
        ["held", "conflicting_receipt"],
      );

      // (b) Ledger consumed, settlement row present, but the SHOT row vanished
      // (a superuser repair gone wrong). Redelivery replays the durable verdict
      // and must not resurrect the shot or re-consume.
      const recB = await liveReceipt(U(8), issued, ticketB, "corrupt-b", { lifecycleSequence: 3 });
      const settledB = await inTx(sql, 8, (tx) => settle(tx, recB.receipt, recB.output, null));
      assertEquals(settledB.financial_disposition, "consumed");
      await corruptDelete(sql, `delete from public.shots where id = '${recB.receipt.resultId}'`);
      const replayB = await inTx(sql, 8, (tx) => settle(tx, recB.receipt, recB.output, null));
      assertEquals(replayB, { ...settledB, delivery: "replayed" });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketB), 0, "a replay never re-writes");

      // (c) Both the settlement row AND the shot gone, ledger says consumed:
      // redelivery must not produce a second charge or a fabricated shot.
      await corruptDelete(
        sql,
        `delete from public.offline_receipt_settlements where receipt_id = '${recB.receipt.receiptId}'`,
      );
      const rebuilt = await inTx(sql, 8, (tx) => settle(tx, recB.receipt, recB.output, null));
      assert(
        (rebuilt.result === "accepted" && rebuilt.financial_disposition !== "consumed") ||
          (rebuilt.financial_disposition === "consumed" && (await shotCount(sql, ticketB)) === 1),
        `unknown state became a consumed verdict with no shot: ${JSON.stringify(rebuilt)}`,
      );
      assertEquals(
        await ledgerEvents(sql, ticketB),
        ["allocated", "consumed"],
        "never a second consume event",
      );
      assertEquals((await counters(sql, 8)).scored, 2, "two tickets, exactly two scored ratings");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L6 — boundary values against the SQL directly (the Edge is bypassed, as a
// compromised isolate or a direct PostgREST caller with a live session would).
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L6 (boundary values, SQL): sequence/generation/id/digest extremes are refused as invalid_input with nothing durable; the maximum legal values settle",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueGrant(sql, 9, KEY("bounds"), 2);
      const [ticketA, ticketB] = tickets(issued);
      const base = await liveReceipt(U(9), issued, ticketA, "bounds");
      const mutations: Array<[string, (r: Record<string, unknown>) => void]> = [
        [
          "sequence 0",
          (r) => {
            r.lifecycleSequence = 0;
          },
        ],
        [
          "sequence -1",
          (r) => {
            r.lifecycleSequence = -1;
          },
        ],
        [
          "sequence 2^53",
          (r) => {
            r.lifecycleSequence = MAX_SEQUENCE + 1;
          },
        ],
        [
          "sequence 1.5",
          (r) => {
            r.lifecycleSequence = 1.5;
          },
        ],
        [
          "sequence as string",
          (r) => {
            r.lifecycleSequence = "1";
          },
        ],
        [
          "generation 0",
          (r) => {
            r.ticket = { ...(r.ticket as Record<string, unknown>), generation: 0 };
          },
        ],
        [
          "generation as string",
          (r) => {
            r.ticket = { ...(r.ticket as Record<string, unknown>), generation: "1" };
          },
        ],
        [
          "receipt id 129",
          (r) => {
            r.receiptId = "r".repeat(129);
          },
        ],
        [
          "receipt id empty",
          (r) => {
            r.receiptId = "";
          },
        ],
        [
          "receipt id with space",
          (r) => {
            r.receiptId = "receipt one";
          },
        ],
        [
          "uppercase output digest",
          (r) => {
            r.fullOutputSha256 = String(r.fullOutputSha256).toUpperCase();
          },
        ],
        [
          "short grant digest",
          (r) => {
            r.grantJwsSha256 = "ab";
          },
        ],
        [
          "billing disposition unknown",
          (r) => {
            r.billingDisposition = "free";
          },
        ],
        [
          "owner not a uuid",
          (r) => {
            r.ownerId = "not-a-uuid";
          },
        ],
        [
          "ticket as string",
          (r) => {
            r.ticket = "ticket";
          },
        ],
        [
          "ticket missing",
          (r) => {
            delete r.ticket;
          },
        ],
        [
          "installation key 129",
          (r) => {
            r.installationKeyId = "k".repeat(129);
          },
        ],
      ];
      for (const [label, mutate] of mutations) {
        const rec = { ...base.receipt } as Record<string, unknown>;
        mutate(rec);
        let verdict: SettleRow | null = null;
        const code = await sqlError(async () => {
          verdict = await inTx(sql, 9, (tx) => settle(tx, rec, base.output, null));
        });
        if (code === "") {
          assert(verdict !== null);
          assertEquals((verdict as SettleRow).result, "offline.invalid_input", label);
          assertEquals((verdict as SettleRow).delivery, null, label);
        } else {
          // A raised error is acceptable only if it is a clean input error, never
          // an internal failure, and never something durable.
          assertMatch(code, /^22|^23|^P0001$/, `${label}: ${code}`);
        }
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(
        (
          await sql.unsafe(
            `select 1 from public.offline_receipt_settlements where user_id = '${U(9)}'`,
          )
        ).length,
        0,
        "no malformed receipt left a durable row",
      );
      // Maximum legal values settle once, and replay.
      const max = await liveReceipt(U(9), issued, ticketA, "bounds-max", {
        receiptId: "m".repeat(128),
        operationId: "o".repeat(128),
        lifecycleSequence: MAX_SEQUENCE,
        queuedAt: "9999-12-31T23:59:59.999Z",
      });
      const settled = await inTx(sql, 9, (tx) => settle(tx, max.receipt, max.output, null));
      assertEquals([settled.delivery, settled.financial_disposition], ["settled", "consumed"]);
      const replay = await inTx(sql, 9, (tx) => settle(tx, max.receipt, max.output, null));
      assertEquals(replay.delivery, "replayed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);

      // Output boundary: a scored output whose overallScore breaks the table
      // constraint (12) must be a durable HOLD (class 23), never an exception,
      // never a charge; the ticket stays allocated for the honest redelivery.
      const over = await liveReceipt(
        U(9),
        issued,
        ticketB,
        "bounds-over",
        { lifecycleSequence: 2 },
        { overallScore: 12 },
      );
      const overVerdict = await inTx(sql, 9, (tx) => settle(tx, over.receipt, over.output, null));
      assertEquals(
        [overVerdict.delivery, overVerdict.reason_code, overVerdict.financial_disposition],
        ["held", "evidence_ambiguous", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, ticketB), 0);
      // An output whose `id` is not a UUID (resultId matches, digest matches).
      const badId = await liveReceipt(U(9), issued, ticketB, "bounds-badid", {
        lifecycleSequence: 3,
        resultId: "not-a-uuid-result",
      });
      const badIdOut = { ...badId.output, id: "not-a-uuid-result" };
      const badIdRec = {
        ...badId.receipt,
        fullOutputSha256: await digestCanonicalOfflineJson(badIdOut),
      };
      const badIdVerdict = await inTx(sql, 9, (tx) => settle(tx, badIdRec, badIdOut, null));
      assertEquals(
        [badIdVerdict.delivery, badIdVerdict.reason_code],
        ["held", "evidence_ambiguous"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L7 — Pro (no-ticket) receipts. A Pro lease consumes nothing, but the
// candidate answers `result_recorded` with `resultId` — the app then treats
// the rating as delivered/reconciled. Is the rated result durable anywhere
// the account can read it back (public.shots), the way a free receipt's is?
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L7 (Pro/no-ticket): a chargeable Pro receipt answered result_recorded leaves the rated shot durable in public.shots (as the free path does)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
         values ('${U(10)}', true, 'pickle_sensei_pro_monthly', now() + interval '30 days')`,
      );
      const issued = await issueGrant(sql, 10, KEY("pro"), 0);
      assert(!issued.claims.allocation, "Pro lease carries no tickets");
      const rec = await liveReceipt(U(10), issued, null, "pro");
      const verdict = await inTx(sql, 10, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(verdict, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "not_applicable",
        result_id: rec.receipt.resultId,
      });
      const replay = await inTx(sql, 10, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(replay, { ...verdict, delivery: "replayed" });
      // The receipt is durable; is the RESULT it records?
      const shots = await sql.unsafe<{ id: string }[]>(
        `select id from public.shots where id = '${rec.receipt.resultId}'`,
      );
      assertEquals(
        shots.length,
        1,
        "BREAK: Pro receipt is result_recorded but the rated shot was never written (the result is acknowledged as delivered and then dropped)",
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// L8 — ingress parity against the REAL database. Values the online shot.sync
// ingress (parseSyncShot) refuses per shot — negative / out-of-range
// millisecond offsets, a synthetic source — must not land in public.shots
// through the receipt path either.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L8 (ingress parity, live): an output the shot.sync ingress refuses (negative ms offsets, non-real source) does not become a stored scored shot through the receipt path",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 11);
      const issued = await issueGrant(sql, 11, KEY("parity"), 2);
      const [ticketA, ticketB] = tickets(issued);
      const negative = await liveReceipt(
        U(11),
        issued,
        ticketA,
        "parity-neg",
        {},
        {
          startMs: -2147483648,
          contactMs: -1,
          endMs: -2,
          phases: [{ key: "prep", startMs: -5, representativeMs: -5, endMs: -1, confidence: 0.8 }],
        },
      );
      const negVerdict = await inTx(sql, 11, (tx) =>
        settle(tx, negative.receipt, negative.output, null),
      );
      const negShots = await sql.unsafe<{ start_ms: number; end_ms: number }[]>(
        `select start_ms, end_ms from public.shots where id = '${negative.receipt.resultId}'`,
      );
      assertEquals(
        [...negShots],
        [],
        `BREAK: negative offsets the sync ingress refuses were stored (verdict ${negVerdict.delivery}/${negVerdict.financial_disposition}): ${JSON.stringify(negShots)}`,
      );

      const synthetic = await liveReceipt(
        U(11),
        issued,
        ticketB,
        "parity-src",
        { lifecycleSequence: 2 },
        {
          source: "synthetic",
        },
      );
      const srcVerdict = await inTx(sql, 11, (tx) =>
        settle(tx, synthetic.receipt, synthetic.output, null),
      );
      const srcShots = await sql.unsafe<{ source: string }[]>(
        `select source from public.shots where id = '${synthetic.receipt.resultId}'`,
      );
      assertEquals(
        [...srcShots],
        [],
        `BREAK: a non-real output the sync ingress refuses was stored (verdict ${srcVerdict.delivery}/${srcVerdict.financial_disposition}): ${JSON.stringify(srcShots)}`,
      );
      assertEquals([srcVerdict.delivery, srcVerdict.reason_code], ["held", "evidence_ambiguous"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      // Blank shotType / oversize key: the same table constraints must hold.
      const blank = await liveReceipt(
        U(11),
        issued,
        ticketB,
        "parity-blank",
        { lifecycleSequence: 3 },
        {
          shotType: " ",
          phases: [
            { key: "k".repeat(65), startMs: 0, representativeMs: 0, endMs: 0, confidence: 0.5 },
          ],
        },
      );
      const blankVerdict = await inTx(sql, 11, (tx) =>
        settle(tx, blank.receipt, blank.output, null),
      );
      const blankShots = await sql.unsafe<{ shot_type: string }[]>(
        `select shot_type from public.shots where id = '${blank.receipt.resultId}'`,
      );
      assertEquals(
        [...blankShots],
        [],
        `BREAK: a blank shotType / 65-char phase key the sync ingress refuses was stored (verdict ${blankVerdict.delivery}/${blankVerdict.financial_disposition})`,
      );
    } finally {
      await sql.end();
    }
  },
});
