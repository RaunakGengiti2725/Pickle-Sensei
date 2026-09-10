// W04-04 ADVERSARIAL ATTACKS against candidate 6441f5050d7d2f5897a5c0acdc1819722e89f134
// (branch devin/pp/w04-04/impl-r8): POST /v1/offline/receipts + settle_offline_receipt().
//
// Every test here is an ATTACK at a failure boundary the candidate claims to
// hold — concurrency (double submit, two receipts racing for one ticket,
// settle racing release), replay of durable verdicts under contention,
// boundary values (identifier length, lifecycleSequence extremes, clock
// values), network failure mid-batch (5xx / 429 from PostgREST), unauthorised
// roles on the SQL surface (anon, service_role, session-less authenticated,
// direct table access) and interleaved account switching, free-rating
// conservation across every outcome, and the per-request decision budget.
//
// Two halves, mirroring the candidate suite:
//   * the REAL edge handler through routesHarness with a durable in-memory
//     stand-in for the RPC (same key as the migration: caller + receiptId +
//     receipt digest);
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with every
//     migration applied (./xc_pg_up.sh, XC_PG_URL) — N independent connections
//     contend on the RPC's advisory locks for real.
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a pass.
//
// This file MUST fail against BASE_SHA d446dcddee32d6ee43e8519b4fe2cd16a35cf1a4
// (route speaks the pre-1.0 full-evidence contract, no p_defer_new, no budget
// exemption for replays) and is expected to pass against the candidate unless
// a break is confirmed; confirmed breaks are reported in the W04-04 attack report.

import postgres from "postgres";
import { assert, assertEquals, assertRejects } from "@std/assert";
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
const GRANT_ID = "64444444-4444-4444-8444-444444444499";
const TICKET_A = "65555555-5555-4555-8555-555555555591";
const TICKET_B = "65555555-5555-4555-8555-555555555592";
const DAY = 86_400;
/** The candidate's per-request decision budget (index.ts OFFLINE_RECEIPT_BATCH_SETTLE_MAX). */
const BATCH_SETTLE_MAX = 250;

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
  return {
    sub: `aaaaaaaa-0404-4000-8000-a77ac${String(userSeq).padStart(7, "0")}`,
    token: fakeGoogleIdToken(`aaaaaaaa-0404-4000-8000-a77ac${String(userSeq).padStart(7, "0")}`),
  };
}

function freeClaims(
  ownerId: string,
  options: { grantId?: string; tickets?: string[] } = {},
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
    { issuer: ISSUER, ownerId, installationKeyId: INSTALLATION_KEY, release: RELEASE },
  );
}

/** A Pro lease: no tickets, verified-store entitlement (the receipt's grant IS the lineage). */
function proClaims(ownerId: string, grantId: string = GRANT_ID): OfflineExecutionGrantClaims {
  const issuedAt = nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: grantId,
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

/** The FROZEN 1.0 output shape the device posts (shot.sync payload, no permit). */
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

/** The row shape the route hands the RPC as p_output for an admitted output. */
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

async function fixture(
  ownerId: string,
  ticketId: string | null,
  n: number,
  options: {
    claims?: OfflineExecutionGrantClaims;
    receiptId?: string;
    lifecycleSequence?: number;
    queuedAt?: string;
    sessionId?: string | null;
  } = {},
): Promise<Fixture> {
  const claims = options.claims ?? freeClaims(ownerId);
  const grant = await sign(claims);
  const resultId = `7a77ac00-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = output(
    resultId,
    options.sessionId === undefined ? {} : { sessionId: options.sessionId },
  );
  const rec = await receipt({
    receiptId: options.receiptId ?? `attack-receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: ticketId === null ? null : ticketRef(ticketId, claims),
    lifecycleSequence: options.lifecycleSequence ?? n,
    operationId: `attack-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    queuedAt: options.queuedAt,
  });
  return { claims, grant, receipt: rec, output: out };
}

const entry = (f: Fixture): Record<string, unknown> => ({
  receipt: f.receipt,
  grant: f.grant,
  output: f.output,
});

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the candidate suite's).
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
    params.p_output !== null &&
    typeof params.p_output.sessionId === "string" &&
    !syncedSessions.has(params.p_output.sessionId)
  ) {
    row = {
      result: "accepted",
      delivery: "pending",
      status: "pending",
      reason_code: null,
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "reserved",
      result_id: null,
    };
  } else {
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "consumed",
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

/** The 200 body checked against the 1.0 wire contract; every submitted id
 * named exactly once (what parseOfflineReceiptVerdicts demands). */
async function wire(response: Response, submittedIds: readonly string[]): Promise<WireAnswer> {
  const body = (await response.json()) as Record<string, unknown>;
  assertEquals(response.status, 200, JSON.stringify(body));
  assertEquals(Object.keys(body).sort(), ["receipts", "rejected"], JSON.stringify(body));
  const answer = body as unknown as WireAnswer;
  assert(Array.isArray(answer.receipts) && Array.isArray(answer.rejected));
  for (const r of answer.receipts) {
    assertEquals(
      Object.keys(r).sort(),
      ["delivery", "financialDisposition", "reasonCode", "receiptId", "resultId", "status"],
      JSON.stringify(r),
    );
  }
  for (const r of answer.rejected) {
    assertEquals(Object.keys(r).sort(), ["code", "message", "receiptId"], JSON.stringify(r));
  }
  const named = [
    ...answer.receipts.map((r) => r.receiptId),
    ...answer.rejected.map((r) => r.receiptId),
  ];
  assertEquals([...named].sort(), [...submittedIds].sort(), JSON.stringify(body));
  assertEquals(new Set(named).size, submittedIds.length, JSON.stringify(body));
  return answer;
}

const byId = <T extends { receiptId: string }>(rows: readonly T[]): Map<string, T> =>
  new Map(rows.map((r) => [r.receiptId, r]));

// ---------------------------------------------------------------------------
// ATTACK 1 — boundary values: identifier length limits, lifecycleSequence
// extremes (2^53-1 vs 2^53, 0, -1, 1.5, "1", NaN-ish), far-future / epoch /
// unnormalised queuedAt. A malformed sibling must be REFUSED per entry (its id
// is attributable) without refusing, re-ordering or double-naming the valid
// receipts; nothing malformed reaches the RPC.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK boundary: 128-char receipt id and 2^53-1 lifecycleSequence settle; 2^53 / 0 / -1 / 1.5 / string sequence, out-of-range or unnormalised queuedAt are refused per entry, valid siblings settle once and no malformed receipt reaches the RPC",
  async () => {
    reset();
    const user = freshUser();
    const claims = freeClaims(user.sub);
    const maxId = "r".repeat(128);
    const good = await fixture(user.sub, TICKET_A, 1, {
      claims,
      receiptId: maxId,
      lifecycleSequence: Number.MAX_SAFE_INTEGER,
    });
    const goodB = await fixture(user.sub, TICKET_B, 2, {
      claims,
      queuedAt: "9999-12-31T23:59:59.999Z",
    });
    const epoch = await fixture(user.sub, TICKET_B, 3, {
      claims,
      queuedAt: "1970-01-01T00:00:00.000Z",
    });

    const malformed = async (tag: string, patch: Record<string, unknown>) => {
      const f = await fixture(user.sub, TICKET_B, 10, { claims, receiptId: `bad-${tag}` });
      return { receipt: { ...f.receipt, ...patch }, grant: f.grant, output: f.output };
    };
    const bad = [
      await malformed("seq-2pow53", { lifecycleSequence: 2 ** 53 }),
      await malformed("seq-zero", { lifecycleSequence: 0 }),
      await malformed("seq-negative", { lifecycleSequence: -1 }),
      await malformed("seq-fraction", { lifecycleSequence: 1.5 }),
      await malformed("seq-string", { lifecycleSequence: "1" }),
      await malformed("seq-null", { lifecycleSequence: null }),
      await malformed("queued-beyond-range", { queuedAt: "+275760-09-13T00:00:00.001Z" }),
      await malformed("queued-offset", { queuedAt: "2026-09-08T12:00:00.000+02:00" }),
      await malformed("queued-space", { queuedAt: "2026-09-08 12:00:00.000Z" }),
      await malformed("queued-nan", { queuedAt: "not-a-date" }),
      await malformed("owner-upper", { ownerId: user.sub.toUpperCase() }),
      await malformed("digest-upper", { fullOutputSha256: "A".repeat(64) }),
      await malformed("extra-key", { nativeTime: { schemaVersion: "x" } }),
    ];
    const ids = [good, goodB, ...bad, epoch].map((e) => e.receipt.receiptId);
    assertEquals(new Set(ids).size, ids.length);

    const answer = await wire(
      await post({ receipts: [entry(good), entry(goodB), ...bad, entry(epoch)] }, user.token),
      ids,
    );
    const receipts = byId(answer.receipts);
    assertEquals(receipts.get(maxId)?.delivery, "settled");
    assertEquals(receipts.get(maxId)?.financialDisposition, "consumed");
    assertEquals(receipts.get(goodB.receipt.receiptId)?.delivery, "settled");
    // Same ticket B, another operation: HELD (conflicting_receipt) in SQL; the
    // stand-in cannot see the ticket so it "settles" — the live half pins the
    // ticket race. Here the boundary claim is: an epoch queuedAt is admitted.
    assertEquals(receipts.get(epoch.receipt.receiptId)?.delivery, "settled");
    assertEquals(answer.rejected.length, bad.length);
    for (const r of answer.rejected) {
      assert(r.receiptId.startsWith("bad-"), JSON.stringify(r));
      assertEquals(r.code, "offline.invalid_input", JSON.stringify(r));
    }
    const settled = h.callsTo(SETTLE_RPC).map(settleParams);
    assertEquals(settled.length, 3);
    assertEquals(
      settled.map((p) => p.p_receipt.receiptId),
      [maxId, goodB.receipt.receiptId, epoch.receipt.receiptId],
    );
    assertEquals(settled[0].p_receipt.lifecycleSequence, Number.MAX_SAFE_INTEGER);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);

    // An id the route cannot attribute (129 chars, or a non-string) refuses the
    // whole batch BEFORE any settlement — nothing partial, nothing durable.
    reset();
    const tooLong = await fixture(user.sub, TICKET_A, 20, { claims, receiptId: "r".repeat(129) });
    const fresh = await fixture(user.sub, TICKET_B, 21, { claims });
    const refused = await post({ receipts: [entry(fresh), entry(tooLong)] }, user.token);
    assertEquals(refused.status, 400);
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    assertEquals(durable.size, 0);
    reset();
    const numericId = { ...entry(fresh), receipt: { ...fresh.receipt, receiptId: 42 } };
    const refusedNumeric = await post({ receipts: [numericId] }, user.token);
    assertEquals(refusedNumeric.status, 400);
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    // Empty batch / non-array: refused, nothing settled.
    for (const body of [{ receipts: [] }, { receipts: {} }, {}, { receipts: null }]) {
      reset();
      assertEquals((await post(body, user.token)).status, 400, JSON.stringify(body));
      assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 2 — network failure mid-batch: PostgREST answers 5xx (and 429) for
// the SECOND of three receipts. The route must answer a GENERIC 503 (no DB
// detail), the first receipt stays durable exactly once, nothing after the
// failure is decided, and the device's retry of the whole batch replays the
// first and settles the rest — one settlement per receipt overall.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK network: RPC 5xx / 429 on the 2nd of 3 receipts → generic 503 without detail, only the 1st durable; the retried batch replays it and settles the rest exactly once",
  async () => {
    for (const [status, statusText] of [
      [500, "Internal Server Error"],
      [429, "Too Many Requests"],
      [502, "Bad Gateway"],
    ] as const) {
      reset();
      const user = freshUser();
      const claims = freeClaims(user.sub);
      const a = await fixture(user.sub, TICKET_A, 1, { claims });
      const b = await fixture(user.sub, TICKET_B, 2, { claims });
      const c = await fixture(user.sub, null, 3, {
        claims: proClaims(user.sub, "64444444-4444-4444-8444-4444444444c3"),
      });
      let settleCalls = 0;
      h.respond = (call) => {
        if (!call.url.endsWith(SETTLE_RPC)) return null;
        settleCalls += 1;
        if (settleCalls === 2) {
          return new Response(
            JSON.stringify({
              code: "XX000",
              message: "SECRET internal detail: relation offline_receipt_settlements",
            }),
            {
              status,
              statusText,
              headers: { "Content-Type": "application/json", "Retry-After": "7" },
            },
          );
        }
        return durableRespond(call);
      };
      const { result: failed, logs } = await captureConsole(() =>
        post({ receipts: [entry(a), entry(b), entry(c)] }, user.token),
      );
      assertEquals(failed.status, 503, `${status}`);
      const failedBody = await failed.text();
      assert(!failedBody.includes("SECRET"), failedBody);
      assert(!failedBody.includes("offline_receipt_settlements"), failedBody);
      assert(!failedBody.includes("XX000"), failedBody);
      assert(logs.length >= 1, "operators get the bounded detail");
      assertEquals(settleCalls, 2, "nothing after the failure is decided");
      assertEquals(durable.size, 1);

      // The device retries the same batch (its outbox keeps every receipt).
      h.respond = durableRespond;
      const answer = await wire(
        await post({ receipts: [entry(a), entry(b), entry(c)] }, user.token),
        [a.receipt.receiptId, b.receipt.receiptId, c.receipt.receiptId],
      );
      assertEquals(
        answer.receipts.map((r) => [r.receiptId, r.delivery, r.financialDisposition]),
        [
          [a.receipt.receiptId, "replayed", "consumed"],
          [b.receipt.receiptId, "settled", "consumed"],
          [c.receipt.receiptId, "settled", "not_applicable"],
        ],
      );
      assertEquals(answer.rejected, []);
      assertEquals(durable.size, 3);
    }

    // A malformed RPC answer (200 with a non-row body) is equally a generic 503.
    reset();
    const user = freshUser();
    const a = await fixture(user.sub, TICKET_A, 1);
    h.respond = (call) =>
      call.url.endsWith(SETTLE_RPC)
        ? new Response(JSON.stringify([{ result: "accepted", delivery: "settled" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        : null;
    const { result: garbled } = await captureConsole(() =>
      post({ receipts: [entry(a)] }, user.token),
    );
    assertEquals(garbled.status, 503);
    assert(!(await garbled.text()).includes("delivery"));
  },
);

// ---------------------------------------------------------------------------
// ATTACK 3 — interleaved account switch at the route: account B (signed in on
// the same phone) drains a queue that still holds A's receipt. B's bearer must
// not consume A's ticket nor learn A's verdict; the receipt is HELD for B
// (owner_mismatch, durable per caller) and A's later drain settles it exactly
// once. B's verdict for the same receiptId never shadows A's.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK account switch: B's bearer presenting A's receipt is HELD owner_mismatch with no consumption; A then settles once; the two callers' durable verdicts for one receiptId never cross",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const claims = freeClaims(a.sub);
    const fx = await fixture(a.sub, TICKET_A, 1, { claims });
    const own = await fixture(b.sub, TICKET_B, 2, {
      claims: freeClaims(b.sub, { grantId: "64444444-4444-4444-8444-4444444444b2" }),
    });

    const asB = await wire(await post({ receipts: [entry(fx), entry(own)] }, b.token), [
      fx.receipt.receiptId,
      own.receipt.receiptId,
    ]);
    const heldForB = byId(asB.receipts).get(fx.receipt.receiptId);
    assertEquals(heldForB, {
      receiptId: fx.receipt.receiptId,
      status: "reconciliation_required",
      reasonCode: "owner_mismatch",
      financialDisposition: "reserved",
      resultId: null,
      delivery: "held",
    });
    assertEquals(byId(asB.receipts).get(own.receipt.receiptId)?.delivery, "settled");
    const bCalls = h.callsTo(SETTLE_RPC).map(settleParams);
    assertEquals(bCalls.length, 2);
    assertEquals(bCalls[0].p_hold_reason, "owner_mismatch");
    assertEquals(
      bCalls[0].p_receipt.ownerId,
      a.sub,
      "the receipt travels as signed, the caller is B",
    );
    for (const call of h.callsTo(SETTLE_RPC))
      assertEquals(call.headers.authorization, `Bearer session-for-${b.sub}`);
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);

    // A drains: settled (not replayed — B's hold is B's), consumed once.
    h.reset();
    h.respond = durableRespond;
    const asA = await wire(await post({ receipts: [entry(fx)] }, a.token), [fx.receipt.receiptId]);
    assertEquals(asA.receipts[0].delivery, "settled");
    assertEquals(asA.receipts[0].financialDisposition, "consumed");
    assertEquals(asA.receipts[0].resultId, fx.receipt.resultId);
    assertEquals(h.callsTo(SETTLE_RPC)[0].headers.authorization, `Bearer session-for-${a.sub}`);

    // B again: still B's own hold (replayed), never A's settlement.
    h.reset();
    h.respond = durableRespond;
    const asBAgain = await wire(await post({ receipts: [entry(fx)] }, b.token), [
      fx.receipt.receiptId,
    ]);
    assertEquals(asBAgain.receipts[0].delivery, "replayed");
    assertEquals(asBAgain.receipts[0].reasonCode, "owner_mismatch");
    assertEquals(asBAgain.receipts[0].resultId, null);

    // A again: replayed, still consumed exactly once (one durable row per caller).
    h.reset();
    h.respond = durableRespond;
    const asAAgain = await wire(await post({ receipts: [entry(fx)] }, a.token), [
      fx.receipt.receiptId,
    ]);
    assertEquals(asAAgain.receipts[0].delivery, "replayed");
    assertEquals(asAAgain.receipts[0].financialDisposition, "consumed");
    assertEquals(durable.size, 3);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4 — the per-request decision budget vs SQL-pending: a queue of 250
// receipts whose sessions have not synced (each answered pending by SQL and
// counted as a decision) followed by ONE fresh settleable receipt. The fresh
// receipt is answered pending WITHOUT reaching SQL (starved this drain) —
// while durable replays are free. Pinned so the behaviour is explicit; the
// receipt is not lost (pending keeps it queued) and settles once presented
// ahead of the pending ones.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK budget: a fresh receipt queued behind 250 SQL-pending (nothing-recorded) receipts must still be decided in the same drain — pending decisions should not spend the settlement budget",
  async () => {
    reset();
    const user = freshUser();
    // A Pro week offline: hundreds of no-ticket receipts under one lease.
    const claims = proClaims(user.sub);
    const unsyncedSession = "9a77ac00-0404-4000-8000-000000000e55";
    const pendingOnes: Fixture[] = [];
    for (let i = 0; i < BATCH_SETTLE_MAX; i += 1) {
      pendingOnes.push(
        await fixture(user.sub, null, 1000 + i, { claims, sessionId: unsyncedSession }),
      );
    }
    const fresh = await fixture(user.sub, null, 2000, { claims });
    const ids = [...pendingOnes, fresh].map((f) => f.receipt.receiptId);

    // The app drains `ORDER BY queued_at ASC` and a pending receipt stays
    // queued, so the fresh receipt sits behind the 250 pending ones on EVERY
    // drain until their session syncs. A pending decision records nothing —
    // like a durable replay it should not spend the settlement budget.
    const first = await wire(
      await post({ receipts: [...pendingOnes.map(entry), entry(fresh)] }, user.token),
      ids,
    );
    const verdicts = byId(first.receipts);
    for (const p of pendingOnes)
      assertEquals(verdicts.get(p.receipt.receiptId)?.delivery, "pending");
    assertEquals(durable.size, 1, "the fresh receipt behind 250 pending ones is decided");
    assertEquals(
      h.callsTo(SETTLE_RPC).length,
      BATCH_SETTLE_MAX + 1,
      "the fresh receipt reached SQL",
    );
    assertEquals(verdicts.get(fresh.receipt.receiptId)?.delivery, "settled");
  },
);

Deno.test(
  "ATTACK budget (control): presented FIRST the fresh receipt settles and its replay behind 250 pending is free (r8 budget exemption holds for durable replays)",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const unsyncedSession = "9a77ac00-0404-4000-8000-000000000e56";
    const pendingOnes: Fixture[] = [];
    for (let i = 0; i < BATCH_SETTLE_MAX; i += 1) {
      pendingOnes.push(
        await fixture(user.sub, null, 3000 + i, { claims, sessionId: unsyncedSession }),
      );
    }
    const fresh = await fixture(user.sub, null, 4000, { claims });
    const ids = [...pendingOnes, fresh].map((f) => f.receipt.receiptId);

    const second = await wire(
      await post({ receipts: [entry(fresh), ...pendingOnes.map(entry)] }, user.token),
      ids,
    );
    assertEquals(byId(second.receipts).get(fresh.receipt.receiptId)?.delivery, "settled");
    // fresh (1 decision) + 249 pending decisions = the budget; the 250th pending
    // entry is answered pending by the edge without an RPC.
    assertEquals(h.callsTo(SETTLE_RPC).length, BATCH_SETTLE_MAX);
    assertEquals(durable.size, 1);
    h.reset();
    h.respond = durableRespond;
    const third = await wire(
      await post({ receipts: [...pendingOnes.map(entry), entry(fresh)] }, user.token),
      ids,
    );
    // 250 pending decisions exhaust the budget before the durable replay is
    // reached, so the edge never asks SQL and answers pending for a receipt
    // whose verdict is durable. Harmless (redelivered), pinned as observed.
    assertEquals(h.callsTo(SETTLE_RPC).length, BATCH_SETTLE_MAX);
    assertEquals(byId(third.receipts).get(fresh.receipt.receiptId)?.delivery, "pending");
    // Replays ARE free when reached: 250 replays + 1 new decision in one batch.
    h.reset();
    h.respond = durableRespond;
    syncedSessions.add(unsyncedSession);
    const fourth = await wire(
      await post({ receipts: [entry(fresh), ...pendingOnes.map(entry)] }, user.token),
      ids,
    );
    assertEquals(byId(fourth.receipts).get(fresh.receipt.receiptId)?.delivery, "replayed");
    assertEquals(
      pendingOnes.filter(
        (p) => byId(fourth.receipts).get(p.receipt.receiptId)?.delivery === "settled",
      ).length,
      BATCH_SETTLE_MAX,
    );
    assertEquals(h.callsTo(SETTLE_RPC).length, BATCH_SETTLE_MAX + 1);
    assertEquals(durable.size, BATCH_SETTLE_MAX + 1);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4b — clocks and intra-batch identity: a receipt under a grant that
// EXPIRED 23 days ago (device offline longer than the lease) must still
// settle — exp bounds execution, not reporting; a grant whose iat is 1 h in
// the future (device clock ahead when it was minted is impossible — the
// server mints — so this is a forged/rolled-back clock) must not settle. In
// one batch: the same receipt twice (same body) and the same id with another
// body — every submitted id must still be answered exactly once by position.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK clocks: a receipt under a grant expired 23 days ago settles once; a future-iat grant is HELD; one batch carrying the same receipt twice and the same id with another body answers every entry, settles exactly once and refuses the conflicting body",
  async () => {
    reset();
    const user = freshUser();
    const past = nowSeconds() - 30 * DAY;
    const expired = offlineGrantClaimsFromIssuance(
      {
        result: "accepted",
        grant_id: GRANT_ID,
        generation: 3,
        entitlement_source: "identity_lifetime_free",
        issued_at: iso(past),
        expires_at: iso(past + 7 * DAY),
        entitlement_expires_at: null,
        ticket_ids: [TICKET_A, TICKET_B],
      },
      { issuer: ISSUER, ownerId: user.sub, installationKeyId: INSTALLATION_KEY, release: RELEASE },
    );
    const late = await fixture(user.sub, TICKET_A, 41, { claims: expired });
    const future = nowSeconds() + 3600;
    const futureClaims = offlineGrantClaimsFromIssuance(
      {
        result: "accepted",
        grant_id: "64444444-4444-4444-8444-4444444444f1",
        generation: 3,
        entitlement_source: "identity_lifetime_free",
        issued_at: iso(future),
        expires_at: iso(future + 7 * DAY),
        entitlement_expires_at: null,
        ticket_ids: [TICKET_B],
      },
      { issuer: ISSUER, ownerId: user.sub, installationKeyId: INSTALLATION_KEY, release: RELEASE },
    );
    const ahead = await fixture(user.sub, TICKET_B, 42, { claims: futureClaims });
    const twin = { ...late, receipt: { ...late.receipt, lifecycleSequence: 99 } };
    const ids = [late, ahead, late, twin].map((f) => f.receipt.receiptId);

    const response = await post({ receipts: [late, ahead, late, twin].map(entry) }, user.token);
    const body = (await response.json()) as {
      receipts?: RouteReceipt[];
      rejected?: { receiptId: string; code: string }[];
      error?: unknown;
    };
    // Every entry answered, in order, exactly one verdict or refusal per position.
    assertEquals(response.status, 200, JSON.stringify(body));
    const answered = [
      ...(body.receipts ?? []).map((r) => r.receiptId),
      ...(body.rejected ?? []).map((r) => r.receiptId),
    ];
    assertEquals(answered.length, 4, JSON.stringify(body));
    assertEquals(answered.sort(), [...ids].sort());
    const verdicts = body.receipts ?? [];
    assertEquals(
      verdicts.map((r) => [r.receiptId, r.delivery, r.financialDisposition, r.reasonCode]),
      [
        [late.receipt.receiptId, "settled", "consumed", null],
        [ahead.receipt.receiptId, "held", "reserved", "evidence_ambiguous"],
        [late.receipt.receiptId, "replayed", "consumed", null],
      ],
    );
    assertEquals(
      body.rejected?.map((r) => [r.receiptId, r.code]),
      [[late.receipt.receiptId, "offline.receipt_conflict"]],
    );
    // Exactly one consumption for TICKET_A; the future grant consumed nothing.
    const consumed = h
      .callsTo(SETTLE_RPC)
      .map(settleParams)
      .filter((c) => c.p_hold_reason === null);
    assertEquals(
      consumed.length,
      3,
      "late, late-again and the twin reach SQL without a hold; SQL decides replay and conflict",
    );
    assertEquals(durable.size, 2);
    assertEquals(
      durable.get(`Bearer session-for-${user.sub}|${late.receipt.receiptId}`)?.row
        .financial_disposition,
      "consumed",
    );
    assertEquals(
      durable.get(`Bearer session-for-${user.sub}|${ahead.receipt.receiptId}`)?.row.status,
      "reconciliation_required",
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 5 — RPC fan-out: one request of 650 durable replays (under the 2 MB
// body cap) is 650 sequential RPC round trips inside one edge invocation.
// Pinned as a measured cost, bounded only by the route rate limit.
// ---------------------------------------------------------------------------

const FANOUT = 650;

Deno.test(
  "ATTACK fan-out: a 650-entry replay batch under the 2 MB body cap is answered 200 with 650 RPC round trips in one invocation (measured; bounded only by the route rate limit)",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const entries: Record<string, unknown>[] = [];
    for (let i = 0; i < FANOUT; i += 1) {
      const resultId = `7a77ac00-0404-4000-8000-${String(300_000 + i).padStart(12, "0")}`;
      const out = output(resultId);
      const rec = await receipt({
        receiptId: `fanout-${i}`,
        ownerId: user.sub,
        grant,
        claims,
        ticket: null,
        lifecycleSequence: i + 1,
        operationId: `fanout-op-${i}`,
        resultId,
        fullOutputSha256: await digestCanonicalOfflineJson(out),
      });
      entries.push({ receipt: rec, grant, output: out });
      durable.set(`Bearer session-for-${user.sub}|fanout-${i}`, {
        sha256: await digestCanonicalOfflineJson(rec),
        row: {
          result: "accepted",
          delivery: "settled",
          status: "result_recorded",
          reason_code: null,
          financial_disposition: "not_applicable",
          result_id: resultId,
        },
      });
    }
    const bytes = new TextEncoder().encode(JSON.stringify({ receipts: entries })).byteLength;
    assert(bytes < 2_000_000, `${bytes}`);
    const answer = await wire(
      await post({ receipts: entries }, user.token),
      entries.map((_, i) => `fanout-${i}`),
    );
    assertEquals(answer.receipts.length, FANOUT);
    assert(answer.receipts.every((r) => r.delivery === "replayed"));
    assertEquals(h.callsTo(SETTLE_RPC).length, FANOUT);
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
const U = (n: number): string => `0000000a-7ac0-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000a-7ac0-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
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

async function asRole(
  tx: Tx,
  role: "authenticated" | "anon" | "service_role",
  n: number | null,
  session: boolean,
): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role ${role}`);
  if (n !== null) await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (session && n !== null) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asRole(tx as unknown as Tx, "authenticated", n, true);
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
       ${hold === null ? "null::text" : `'${hold}'`},
       false
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
  assert(
    claims.allocation && claims.allocation.ticketIds.length === requested,
    JSON.stringify(row),
  );
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string,
  tag: string,
  outputOverrides: Record<string, unknown> = {},
  overrides: Partial<ReceiptOptions> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
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

async function settlementRows(
  sql: Sql,
  n: number,
): Promise<{ receipt_id: string; status: string; reason_code: string | null }[]> {
  const rows = await sql.unsafe<
    { receipt_id: string; status: string; reason_code: string | null }[]
  >(
    `select receipt_id, status, reason_code from public.offline_receipt_settlements
     where user_id = '${U(n)}' order by id`,
  );
  return rows.map((r) => ({
    receipt_id: r.receipt_id,
    status: r.status,
    reason_code: r.reason_code,
  }));
}

/** offline_hold_count() = the caller's OUTSTANDING tickets (allocated, not
 * consumed; released still counts); lifetime_scored_count() = ratings spent.
 * Allocation is not consumption: for a two-ticket free identity
 * held + scored must stay exactly 2 through every outcome. */
async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
}

const tally = (rows: SettleRow[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = `${r.result}/${r.delivery}/${r.reason_code ?? "-"}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
};

// ---------------------------------------------------------------------------
// ATTACK 6 — double submit for real: 8 independent connections deliver the
// SAME receipt at the same instant (the device retrying while the first POST
// is still in flight). Exactly one `settled`, seven `replayed` with the
// identical verdict; ONE consumed ledger event, ONE shot, ONE free rating spent.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK live concurrency: 8 simultaneous deliveries of one receipt → exactly 1 settled + 7 identical replays, one consumed event, one shot, one free rating",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("dbl"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const { receipt: rec, output: out } = await liveReceipt(U(1), issued, ticket, "dbl");
      const before = await counters(sql, 1);

      const rows = await Promise.all(
        Array.from({ length: 8 }, () => inTx(sql, 1, (tx) => settle(tx, rec, out, null))),
      );
      assertEquals(tally(rows), {
        "accepted/settled/-": 1,
        "accepted/replayed/-": 7,
      });
      for (const r of rows) {
        assertEquals(r.status, "result_recorded");
        assertEquals(r.financial_disposition, "consumed");
        assertEquals(r.result_id, rec.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticket), 1);
      assertEquals((await settlementRows(sql, 1)).length, 1);
      assertEquals(before, { held: 2, scored: 0 });
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 7 — two DIFFERENT receipts (two operations, two results) racing for
// ONE ticket from parallel connections, plus a Pro-shaped (ticket:null) receipt
// for one of those result ids racing alongside. Exactly one consumption; the
// loser is HELD conflicting_receipt with nothing written; the free-rating
// count moves by exactly one; every verdict replays identically afterwards.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK live concurrency: 6 distinct receipts racing for one ticket → exactly one consumed, five HELD conflicting_receipt, one shot, one free rating; the holds replay identically",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("race"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const contenders = await Promise.all(
        Array.from({ length: 6 }, (_, i) => liveReceipt(U(2), issued, ticket, `race-${i}`)),
      );
      const before = await counters(sql, 2);

      const rows = await Promise.all(
        contenders.map((c) => inTx(sql, 2, (tx) => settle(tx, c.receipt, c.output, null))),
      );
      assertEquals(tally(rows), {
        "accepted/settled/-": 1,
        "accepted/held/conflicting_receipt": 5,
      });
      const winner = rows.findIndex((r) => r.delivery === "settled");
      assertEquals(rows[winner].result_id, contenders[winner].receipt.resultId);
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticket), 1);
      for (let i = 0; i < contenders.length; i += 1) {
        const stored = await sql.unsafe(
          `select 1 from public.shots where id = '${contenders[i].receipt.resultId}'`,
        );
        assertEquals(stored.length, i === winner ? 1 : 0);
        assertEquals(rows[i].financial_disposition, i === winner ? "consumed" : "reserved");
      }
      assertEquals(before, { held: 2, scored: 0 });
      const after = await counters(sql, 2);
      assertEquals(after, { held: 1, scored: 1 }, "five holds spend nothing and reclaim nothing");

      // Redelivery of the whole race, again in parallel: every verdict replays
      // unchanged, nothing new is written.
      const again = await Promise.all(
        contenders.map((c) => inTx(sql, 2, (tx) => settle(tx, c.receipt, c.output, null))),
      );
      assertEquals(
        again,
        rows.map((r) => ({ ...r, delivery: "replayed" })),
      );
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
      assertEquals((await settlementRows(sql, 2)).length, 6);
      assertEquals(await counters(sql, 2), after);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 8 — settle racing release_offline_ticket() on the same ticket from
// parallel connections (the app returning an unused ticket while a stale
// receipt for it is in flight): exactly ONE terminal ledger event, and the
// two answers agree with it — never consumed AND released.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK live concurrency: settle vs release_offline_ticket on one ticket, 4 rounds → exactly one terminal event per ticket and verdicts consistent with it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      // A free identity owns two lifetime tickets; two identities give four rounds.
      await createUser(sql, 3);
      await createUser(sql, 13);
      const issuedByUser = new Map<number, LiveGrant>();
      let consumedRounds = 0;
      let releasedRounds = 0;
      for (let round = 0; round < 4; round += 1) {
        const n = round < 2 ? 3 : 13;
        if (!issuedByUser.has(n))
          issuedByUser.set(n, await issueFreeGrant(sql, n, KEY(`rel-${n}`)));
        const issued = issuedByUser.get(n)!;
        assert(issued.claims.allocation);
        const ticket = issued.claims.allocation.ticketIds[round % 2];
        const { receipt: rec, output: out } = await liveReceipt(
          U(n),
          issued,
          ticket,
          `rel-${round}`,
        );
        const [verdict, released] = await Promise.all([
          inTx(sql, n, (tx) => settle(tx, rec, out, null)),
          inTx(sql, n, async (tx) => {
            const rows = await tx.unsafe<{ r: string }[]>(
              `select public.release_offline_ticket('${ticket}', 'unused_ticket_returned') as r`,
            );
            return rows[0].r;
          }),
        ]);
        const events = await ledgerEvents(sql, ticket);
        assertEquals(events.length, 2, JSON.stringify(events));
        assertEquals(events[0], "allocated");
        if (events[1] === "consumed") {
          consumedRounds += 1;
          assertEquals(verdict.delivery, "settled");
          assertEquals(verdict.financial_disposition, "consumed");
          assertEquals(released, "offline.ticket_consumed");
          assertEquals(await shotCount(sql, ticket), 1);
        } else {
          releasedRounds += 1;
          assertEquals(events[1], "released");
          assertEquals(released, "accepted");
          assertEquals(verdict.delivery, "held");
          assertEquals(verdict.reason_code, "conflicting_receipt");
          assertEquals(verdict.financial_disposition, "reserved");
          assertEquals(await shotCount(sql, ticket), 0);
          // Redelivery keeps the hold — the released ticket is never consumed later.
          const again = await inTx(sql, n, (tx) => settle(tx, rec, out, null));
          assertEquals(again, { ...verdict, delivery: "replayed" });
          assertEquals(await ledgerEvents(sql, ticket), ["allocated", "released"]);
        }
      }
      assertEquals(consumedRounds + releasedRounds, 4);
      const a = await counters(sql, 3);
      const b = await counters(sql, 13);
      assertEquals(a.scored + b.scored, consumedRounds);
      // Allocation is never reclaimed: outstanding + spent stays 2 per identity.
      assertEquals(a.held + a.scored, 2);
      assertEquals(b.held + b.scored, 2);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 9 — unauthorised roles on the SQL surface (allowed AND denied):
// anon, service_role, authenticated WITHOUT a live session, direct table
// access under authenticated (select / insert / update / delete), then the
// interleaved-account attack at the SQL layer: B presents A's receipt (with
// the edge's owner_mismatch hold) AND a forged receipt owned by B that names
// A's ticket without a hold. A's ticket must stay allocated; A settles once.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK live roles: anon / service_role / session-less authenticated cannot settle; the table takes no client reads or writes; B naming A's ticket is HELD and A still consumes exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 4, KEY("roles"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const { receipt: rec, output: out } = await liveReceipt(U(4), issued, ticket, "roles");

      const denied = async (
        role: "anon" | "service_role" | "authenticated",
        n: number | null,
        session: boolean,
      ) => {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await asRole(tx as unknown as Tx, role, n, session);
              await settle(tx as unknown as Tx, rec, out, null);
            }),
          Error,
          role === "authenticated" ? "API session authorization required" : "permission denied",
        );
      };
      await denied("anon", null, false);
      await denied("service_role", null, false);
      await denied("authenticated", 4, false);
      // No authenticated user at all (sub unset) is refused too.
      await denied("authenticated", null, false);
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await settlementRows(sql, 4), []);

      // Direct table access as the owner: every verb denied.
      for (const statement of [
        `select * from public.offline_receipt_settlements`,
        `insert into public.offline_receipt_settlements (user_id, receipt_id, receipt_sha256, owner_id,
           installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256,
           billing_disposition, lifecycle_sequence, status, financial_disposition, receipt)
         values ('${U(4)}', 'forged-${RUN}', '${"0".repeat(64)}', '${U(4)}', 'k', '${rec.grantId}',
           '${"0".repeat(64)}', 'op', 'res', '${"0".repeat(64)}', 'joint_verification_required', 1,
           'result_recorded', 'consumed', '{}'::jsonb)`,
        `update public.offline_receipt_settlements set status = 'result_recorded'`,
        `delete from public.offline_receipt_settlements`,
      ]) {
        await assertRejects(
          () => inTx(sql, 4, (tx) => tx.unsafe(statement)),
          Error,
          "permission denied",
        );
      }
      // The settlement RPC's helpers are not callable directly either.
      await assertRejects(
        () =>
          inTx(sql, 4, (tx) =>
            tx.unsafe(`select api_private.offline_ticket_lock_key('${ticket}')`),
          ),
        Error,
        "permission denied",
      );

      // Interleaved account: B presents A's receipt with the edge's hold, and a
      // forged receipt (ownerId = B, B's own grant digest) naming A's ticket.
      const bHold = await inTx(sql, 5, (tx) => settle(tx, rec, out, "owner_mismatch"));
      assertEquals(bHold, {
        result: "accepted",
        delivery: "held",
        status: "reconciliation_required",
        reason_code: "owner_mismatch",
        financial_disposition: "reserved",
        result_id: null,
      });
      const forged: OfflineDeviceReceipt = {
        ...rec,
        receiptId: `attack-forged-${RUN}`,
        ownerId: U(5),
        operationId: `attack-op-forged-${RUN}`,
        resultId: crypto.randomUUID(),
      };
      const bForged = await inTx(sql, 5, (tx) => settle(tx, forged, out, null));
      assertEquals(bForged.delivery, "held");
      assertEquals(bForged.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await shotCount(sql, ticket), 0);
      assertEquals(
        (await settlementRows(sql, 5)).map((r) => r.reason_code),
        ["owner_mismatch", "evidence_ambiguous"],
      );
      assertEquals((await counters(sql, 5)).scored, 0);

      // A settles its own receipt exactly once; B's holds did not touch it.
      const aSettled = await inTx(sql, 4, (tx) => settle(tx, rec, out, null));
      assertEquals(aSettled.delivery, "settled");
      assertEquals(aSettled.financial_disposition, "consumed");
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticket), 1);
      assertEquals((await counters(sql, 4)).scored, 1);
      assertEquals((await counters(sql, 5)).scored, 0);
      // B re-presenting A's receipt still gets B's own hold, never A's verdict.
      const bAgain = await inTx(sql, 5, (tx) => settle(tx, rec, out, "owner_mismatch"));
      assertEquals(bAgain, { ...bHold, delivery: "replayed" });
      // The shot belongs to A, and B cannot read it.
      const [shotOwner] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${rec.resultId}'`,
      );
      assertEquals(shotOwner.user_id, U(4));
      const bView = await inTx(sql, 5, (tx) =>
        tx.unsafe(`select id from public.shots where id = '${rec.resultId}'`),
      );
      assertEquals(bView.length, 0);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 10 — pending → durable under contention: a receipt whose session has
// not synced is `pending` (nothing durable) however many times and however
// concurrently it arrives; once the session syncs, 5 simultaneous
// redeliveries settle exactly once. Then: 5 simultaneous deliveries of a
// HELD receipt (edge-derived hold) produce one durable hold + 4 replays.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK live concurrency: pending (unsynced session) writes nothing under 5 parallel deliveries, settles exactly once after sync under 5 more; a HELD receipt under 5 parallel deliveries is one durable hold",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      const issued = await issueFreeGrant(sql, 6, KEY("pend"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const sessionId = crypto.randomUUID();
      const { receipt: rec, output: out } = await liveReceipt(U(6), issued, ticketA, "pend", {
        sessionId,
      });

      const early = await Promise.all(
        Array.from({ length: 5 }, () => inTx(sql, 6, (tx) => settle(tx, rec, out, null))),
      );
      for (const r of early) {
        assertEquals(r, {
          result: "accepted",
          delivery: "pending",
          status: "pending",
          reason_code: null,
          financial_disposition: "reserved",
          result_id: null,
        });
      }
      assertEquals(await settlementRows(sql, 6), []);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${U(6)}', now())`,
      );
      const late = await Promise.all(
        Array.from({ length: 5 }, () => inTx(sql, 6, (tx) => settle(tx, rec, out, null))),
      );
      assertEquals(tally(late), { "accepted/settled/-": 1, "accepted/replayed/-": 4 });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      const [shot] = await sql.unsafe<{ session_id: string }[]>(
        `select session_id from public.shots where id = '${rec.resultId}'`,
      );
      assertEquals(shot.session_id, sessionId);

      // A HELD receipt (unknown key at the edge → hold reason) under contention.
      const { receipt: heldRec } = await liveReceipt(U(6), issued, ticketB, "held");
      const holds = await Promise.all(
        Array.from({ length: 5 }, () =>
          inTx(sql, 6, (tx) => settle(tx, heldRec, null, "evidence_missing")),
        ),
      );
      assertEquals(tally(holds), {
        "accepted/held/evidence_missing": 1,
        "accepted/replayed/evidence_missing": 4,
      });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(
        (await settlementRows(sql, 6)).map((r) => [r.receipt_id, r.status]),
        [
          [rec.receiptId, "result_recorded"],
          [heldRec.receiptId, "reconciliation_required"],
        ],
      );
      assertEquals(await counters(sql, 6), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});
