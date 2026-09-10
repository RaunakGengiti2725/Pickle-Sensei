// W04-04 ADVERSARIAL TESTS against candidate 9d8b4b31 (impl-r10).
//
// Every test here is an ATTACK at a failure boundary of POST /v1/offline/receipts
// and the real settle_offline_receipt(): concurrency on one ticket / one
// receipt, a settle-vs-release race, cross-account replay of another owner's
// receipt, unauthorised roles for the SQL surface, corrupt persisted state
// (the allocating grant gone), boundary values (safe-integer edges, the
// device's far-future/epoch clocks), the per-request byte cap against the
// device's drain-everything batch, and a database failure mid-batch. Each
// asserts the invariant the package promises (settle at most once, ambiguous
// evidence HOLDs, free ratings are conserved, nothing durable for pending) —
// a failing assertion is a break, a passing one is an attack that held.
//
// The route half runs through routesHarness with the same durable stand-in
// shape the candidate's own tests use; the postgres half runs the REAL
// function on a disposable postgres:16 with every migration applied
// (./xc_pg_up.sh, XC_PG_URL). Without XC_PG_URL the postgres half is
// `ignore`d — an ignored run is NOT a pass.
//
// Nothing in the candidate's own test file or production code is touched.

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
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-444444444499";
const DAY = 86_400;
/** index.ts OFFLINE_RECEIPT_BATCH_SETTLE_MAX / OFFLINE_RECEIPT_BATCH_BODY_BYTES. */
const ROUTE_SETTLE_MAX = 250;
const ROUTE_BODY_BYTES = 2_000_000;

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
  const sub = `aaaaaaaa-0404-4000-8000-9d8b4b31${String(userSeq).padStart(4, "0")}`;
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

/** The frozen 1.0 shot.sync-shaped output the device delivers beside a receipt. */
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

/** A rated dink as the on-device pipeline really renders it: every phase and
 * every checkpoint the scoring definition knows — the realistic per-entry
 * payload size the byte cap is measured against. */
function realisticOutput(resultId: string): Record<string, unknown> {
  const phaseKeys = ["ready", "prep", "backswing", "contact", "follow_through", "recovery"];
  const checkpointKeys = [
    "paddle_height",
    "paddle_face",
    "knee_bend",
    "shoulder_rotation",
    "contact_point",
    "weight_transfer",
    "wrist_stability",
    "elbow_angle",
    "head_still",
    "recovery_speed",
  ];
  return output(resultId, {
    phases: phaseKeys.map((key, i) => ({
      key,
      startMs: i * 100,
      representativeMs: i * 100 + 50,
      endMs: i * 100 + 100,
      confidence: 0.75,
    })),
    checkpoints: checkpointKeys.map((key, i) => ({
      key,
      score: 50 + i,
      confidence: 0.8,
      band: i % 2 === 0 ? "green" : "yellow",
      direction: "up",
      severity: 0.2,
      applicable: true,
    })),
    timestamps: { startMs: 0, contactMs: 350, endMs: 600 },
  });
}

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

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract the candidate's route tests use).
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
      financial_disposition: params.p_receipt.ticket === null ? "not_applicable" : "consumed",
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

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

interface Entry {
  receipt: OfflineDeviceReceipt;
  grant: OfflineSignedExecutionGrant;
  output: Record<string, unknown> | null;
}

async function proEntries(
  user: { sub: string },
  count: number,
  make: (resultId: string) => Record<string, unknown> = output,
): Promise<{ entries: Entry[]; ids: string[] }> {
  const claims = proClaims(user.sub);
  const grant = await sign(claims);
  const entries: Entry[] = [];
  const ids: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const resultId = `7000${String(n).padStart(4, "0")}-0404-4000-8000-9d8b4b310000`;
    const out = make(resultId);
    const rec = await receipt({
      receiptId: `atk-${n}`,
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: n,
      operationId: `atk-op-${n}`,
      resultId,
      fullOutputSha256: await digestCanonicalOfflineJson(out),
    });
    entries.push({ receipt: rec, grant, output: out });
    ids.push(rec.receiptId);
  }
  return { entries, ids };
}

// ---------------------------------------------------------------------------
// ATK-1 — a database failure MID-BATCH after durable decisions were already
// made: the whole batch is 503, nothing is refunded or retried under another
// id, and the redelivery replays the decided ones and settles the rest —
// exactly n durable rows however the failure lands. Also: the database
// answering 429 mid-batch is a 503 for the batch, never surfaced as a
// per-receipt refusal.
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-1 route: RPC 5xx / 429 on the k-th entry after k-1 durable decisions — 503 for the batch, the decided rows stay decided, redelivery settles the rest exactly once",
  async () => {
    reset();
    const user = freshUser();
    const { entries, ids } = await proEntries(user, 7);
    for (const [k, injected] of [
      [3, 500],
      [5, 429],
    ] as const) {
      h.reset();
      let seen = 0;
      h.respond = (call) => {
        if (!call.url.endsWith(SETTLE_RPC)) return null;
        seen += 1;
        if (seen === k) {
          return new Response(JSON.stringify({ message: "injected" }), {
            status: injected,
            headers: { "Content-Type": "application/json", "Retry-After": "1" },
          });
        }
        return durableRespond(call);
      };
      const { result: response } = await captureConsole(() =>
        post({ receipts: entries }, user.token),
      );
      assertEquals(response.status, 503, `injected ${injected} at entry ${k}`);
      const body = await readJson(response);
      assertEquals(Object.hasOwn(body, "receipts"), false, "no partial verdict list on a 503");
      // The k-1 entries decided before the failure are durable; nothing else is.
      assertEquals(settleCalls().length, k);
    }
    // Only entries 1,2 (first pass) and 3,4 (second pass; 1,2 replayed) are durable.
    assertEquals(durable.size, 4);

    // Redelivery of the whole queue: replays for the decided, settlements for the rest.
    h.reset();
    h.respond = durableRespond;
    const again = wire(await readJson(await post({ receipts: entries }, user.token)));
    assertEquals(again.rejected, []);
    assertEquals(
      again.receipts.map((r) => [r.receiptId, r.delivery, r.status]),
      ids.map((id, i) => [id, i < 4 ? "replayed" : "settled", "result_recorded"]),
    );
    assertEquals(durable.size, 7);
    // One durable decision per receipt, ever.
    const decided = new Set(settleCalls().map((p) => p.p_receipt.receiptId));
    assertEquals(decided.size, 7);
  },
);

// ---------------------------------------------------------------------------
// ATK-2 — duplicate identities INSIDE one batch: the same receipt twice
// (settled + replayed) and the same id under another body (settled +
// offline.receipt_conflict). Neither settles twice; every entry is answered.
// A replay queued BEHIND 250 fresh decisions is answered pending (the budget
// is applied before the RPC is consulted) — never a second settlement.
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-2 route: the same receipt id twice in one batch settles once; a replay behind a full budget is pending, not re-settled",
  async () => {
    reset();
    const user = freshUser();
    const { entries, ids } = await proEntries(user, ROUTE_SETTLE_MAX + 1);
    const first = entries[0];
    const forgedFirst: Entry = {
      ...first,
      receipt: { ...first.receipt, lifecycleSequence: 999 },
    };
    const answer = wire(
      await readJson(await post({ receipts: [first, first, forgedFirst] }, user.token)),
    );
    assertEquals(
      answer.receipts.map((r) => [r.receiptId, r.delivery]),
      [
        [ids[0], "settled"],
        [ids[0], "replayed"],
      ],
    );
    assertEquals(
      answer.rejected.map((r) => [r.receiptId, r.code]),
      [[ids[0], "offline.receipt_conflict"]],
    );
    assertEquals(durable.size, 1);

    // 250 fresh decisions then the already-settled receipt: the route defers it
    // without asking the database; the durable verdict is untouched.
    h.reset();
    h.respond = durableRespond;
    const big = wire(
      await readJson(await post({ receipts: [...entries.slice(1), first] }, user.token)),
    );
    assertEquals(big.rejected, []);
    assertEquals(big.receipts.length, ROUTE_SETTLE_MAX + 1);
    assertEquals(
      big.receipts.slice(0, ROUTE_SETTLE_MAX).every((r) => r.delivery === "settled"),
      true,
    );
    assertEquals(big.receipts[ROUTE_SETTLE_MAX].receiptId, ids[0]);
    assertEquals(big.receipts[ROUTE_SETTLE_MAX].delivery, "pending");
    assertEquals(settleCalls().length, ROUTE_SETTLE_MAX);
    assertEquals(durable.size, ROUTE_SETTLE_MAX + 1);
    const firstRows = [...durable.entries()].filter(([key]) => key.endsWith(`|${ids[0]}`));
    assertEquals(firstRows.length, 1);
    assertEquals(firstRows[0][1].row.delivery, "settled");
  },
);

// ---------------------------------------------------------------------------
// ATK-3 — the per-request BYTE cap against the device's drain-everything
// batch (apps/mobile offlineWallet presents every pending receipt in ONE
// POST, no chunking). Measures how many realistic Pro entries fit under
// OFFLINE_RECEIPT_BATCH_BODY_BYTES, proves that count is answered per
// receipt, and that one more is a 413 naming no receipt at all — a queue
// past that size can never drain until the device chunks it.
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-3 route: the 2,000,000-byte body cap — the largest realistic drain that fits is answered per receipt; one entry more is 413 with no receipt named",
  async () => {
    reset();
    const user = freshUser();
    const { entries } = await proEntries(user, 1, realisticOutput);
    const one = JSON.stringify(entries[0]).length;
    // Build a few more distinct entries than could fit, then take the longest
    // prefix whose body stays under the cap (the wrapper and later index digits
    // cost bytes too).
    const many = await proEntries(user, Math.floor(ROUTE_BODY_BYTES / one) + 2, realisticOutput);
    let fit = 0;
    let bytes = JSON.stringify({ receipts: [] }).length;
    for (const entry of many.entries) {
      const next = bytes + JSON.stringify(entry).length + (fit === 0 ? 0 : 1);
      if (next > ROUTE_BODY_BYTES) break;
      bytes = next;
      fit += 1;
    }
    assert(fit < many.entries.length, "the prefix must stop before the last entry");
    const fitting = many.entries.slice(0, fit);
    const bodyFit = JSON.stringify({ receipts: fitting });
    assert(bodyFit.length <= ROUTE_BODY_BYTES, `${bodyFit.length} bytes for ${fit} entries`);
    console.info(
      `[atk-3] one realistic Pro entry = ${one} bytes; ${fit} entries fit under ${ROUTE_BODY_BYTES}`,
    );

    const ok = await post({ receipts: fitting }, user.token);
    assertEquals(ok.status, 200);
    const answer = wire(await readJson(ok));
    assertEquals(answer.rejected, []);
    assertEquals(answer.receipts.length, fit);
    // Beyond the decision budget the rest is pending — but every id is named.
    assertEquals(
      answer.receipts.filter((r) => r.delivery === "settled").length,
      Math.min(fit, ROUTE_SETTLE_MAX),
    );
    assertEquals(
      answer.receipts.filter((r) => r.delivery === "pending").length,
      Math.max(0, fit - ROUTE_SETTLE_MAX),
    );

    h.reset();
    h.respond = durableRespond;
    const oneMore = many.entries.slice(0, fit + 1);
    const over = JSON.stringify({ receipts: oneMore });
    assert(over.length > ROUTE_BODY_BYTES, `${over.length} bytes must exceed the cap`);
    const tooLarge = await post({ receipts: oneMore }, user.token);
    assertEquals(tooLarge.status, 413);
    const body = await readJson(tooLarge);
    assertEquals(Object.hasOwn(body, "receipts"), false);
    assertEquals(settleCalls().length, 0);
    // The device-side consequence: every receipt of that drain stays a HOLD and
    // the identical drain is refused the same way next time. Recorded as a
    // finding, asserted here only as the route's exact behaviour.
  },
);

// ---------------------------------------------------------------------------
// ATK-4 — device clock boundaries and safe-integer edges at the ROUTE. A
// device whose wall clock is in year 10000 stamps queuedAt as
// Date#toISOString renders it ("+010000-…"); the epoch is "1970-…". The
// lifecycleSequence edges: MAX_SAFE_INTEGER settles, MAX_SAFE_INTEGER + 1,
// 0, -1, 1.5 and a numeric string are refused per entry (never the batch),
// nothing durable for a refused entry, and every id named exactly once.
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-4 route: far-future / epoch queuedAt and lifecycleSequence edges are decided per entry, never for the batch, with nothing durable for a refused entry",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const make = async (tag: string, n: number, patch: Record<string, unknown>): Promise<Entry> => {
      const resultId = `7100${String(n).padStart(4, "0")}-0404-4000-8000-9d8b4b310000`;
      const out = output(resultId);
      const rec = await receipt({
        receiptId: `atk4-${tag}`,
        ownerId: user.sub,
        grant,
        claims,
        ticket: null,
        lifecycleSequence: n,
        operationId: `atk4-op-${tag}`,
        resultId,
        fullOutputSha256: await digestCanonicalOfflineJson(out),
      });
      return { receipt: { ...rec, ...patch } as OfflineDeviceReceipt, grant, output: out };
    };
    const farFuture = new Date(253_402_300_800_000).toISOString();
    assert(farFuture.startsWith("+010000-"), farFuture);
    const entries = [
      await make("y10000", 1, { queuedAt: farFuture }),
      await make("epoch", 2, { queuedAt: "1970-01-01T00:00:00.000Z" }),
      await make("y0000", 3, { queuedAt: "0000-01-01T00:00:00.000Z" }),
      await make("maxsafe", 4, { lifecycleSequence: Number.MAX_SAFE_INTEGER }),
      await make("maxsafe+1", 5, { lifecycleSequence: Number.MAX_SAFE_INTEGER + 1 }),
      await make("zero", 6, { lifecycleSequence: 0 }),
      await make("negative", 7, { lifecycleSequence: -1 }),
      await make("fraction", 8, { lifecycleSequence: 1.5 }),
      await make("string", 9, { lifecycleSequence: "9" }),
      await make("honest", 10, {}),
    ];
    const response = await post({ receipts: entries }, user.token);
    assertEquals(response.status, 200);
    const answer = wire(await readJson(response));
    const byId = new Map<string, string>();
    for (const r of answer.receipts) {
      assert(!byId.has(r.receiptId));
      byId.set(r.receiptId, r.delivery);
    }
    for (const r of answer.rejected) {
      assert(!byId.has(r.receiptId));
      byId.set(r.receiptId, `rejected:${r.code}`);
    }
    assertEquals(byId.size, entries.length, "every id named exactly once");
    assertEquals(byId.get("atk4-epoch"), "settled");
    // Year 0 is a well-formed Date#toISOString instant; only the six-digit
    // expanded-year forms fall outside the grammar.
    assertEquals(byId.get("atk4-y0000"), "settled");
    assertEquals(byId.get("atk4-maxsafe"), "settled");
    assertEquals(byId.get("atk4-honest"), "settled");
    for (const tag of ["y10000", "maxsafe+1", "zero", "negative", "fraction", "string"]) {
      assertEquals(byId.get(`atk4-${tag}`), "rejected:offline.invalid_input", tag);
    }
    // Only the admitted entries reached the database; nothing durable for the refused.
    assertEquals(
      settleCalls()
        .map((p) => p.p_receipt.receiptId)
        .sort(),
      ["atk4-epoch", "atk4-honest", "atk4-maxsafe", "atk4-y0000"],
    );
    assertEquals(durable.size, 4);
    // The MAX_SAFE_INTEGER sequence travels to SQL as the exact JSON number.
    const maxsafe = settleCalls().find((p) => p.p_receipt.receiptId === "atk4-maxsafe");
    assertEquals(maxsafe?.p_receipt.lifecycleSequence, Number.MAX_SAFE_INTEGER);
  },
);

// ---------------------------------------------------------------------------
// ATK-12 — the r10 boundary itself. (a) 250 replays queued ahead of one fresh
// receipt must not starve it: the replays are free, the fresh one settles in
// the same drain (fails on the r8 route, which answered it pending after 250
// RPC calls). (b) The price of that rule: a body of entries the database
// keeps answering `pending` is verified (ES256 + two digests) and settled
// (one RPC, owner lock) ENTRY BY ENTRY with no per-request ceiling other than
// the 2,000,000-byte body cap — the smallest well-formed Pro entry decides
// how many RPC round trips one request can force. Measured and pinned.
// ---------------------------------------------------------------------------

Deno.test(
  "ATK-12 route: 250 replays ahead of a fresh receipt do not starve it; a body of database-pending entries is settled entry by entry with only the byte cap as ceiling",
  async () => {
    reset();
    const user = freshUser();
    const { entries, ids } = await proEntries(user, ROUTE_SETTLE_MAX + 1);
    const seed = wire(
      await readJson(await post({ receipts: entries.slice(0, ROUTE_SETTLE_MAX) }, user.token)),
    );
    assertEquals(
      seed.receipts.every((r) => r.delivery === "settled"),
      true,
    );
    assertEquals(durable.size, ROUTE_SETTLE_MAX);

    h.reset();
    h.respond = durableRespond;
    const drain = wire(await readJson(await post({ receipts: entries }, user.token)));
    assertEquals(drain.rejected, []);
    assertEquals(
      drain.receipts.map((r) => r.delivery),
      [...Array<string>(ROUTE_SETTLE_MAX).fill("replayed"), "settled"],
    );
    assertEquals(drain.receipts[ROUTE_SETTLE_MAX].receiptId, ids[ROUTE_SETTLE_MAX]);
    assertEquals(settleCalls().length, ROUTE_SETTLE_MAX + 1);
    assertEquals(durable.size, ROUTE_SETTLE_MAX + 1);

    // (b) the smallest well-formed Pro entry: an honest abstention with no
    // output. The database (stand-in) answers every one of them pending, as
    // it does for shot.session_not_found or a deferral under a reversible
    // freeze.
    h.reset();
    durable.clear();
    let rpcCalls = 0;
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      rpcCalls += 1;
      const params = settleParams(call);
      assertEquals(params.p_hold_reason, null);
      return rpcJson({
        result: "accepted",
        delivery: "pending",
        status: "pending",
        reason_code: null,
        financial_disposition: "not_applicable",
        result_id: null,
      });
    };
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const minimal = async (n: number): Promise<Entry> => {
      const rec = await receipt({
        receiptId: `p${n}`,
        ownerId: user.sub,
        grant,
        claims,
        ticket: null,
        lifecycleSequence: n,
        operationId: `o${n}`,
        resultId: `7200${String(n).padStart(4, "0")}-0404-4000-8000-9d8b4b310000`,
        fullOutputSha256: await digestCanonicalOfflineJson(null),
        billingDisposition: "not_chargeable",
      });
      return { receipt: rec, grant, output: null };
    };
    const probe = JSON.stringify(await minimal(1)).length;
    const candidates: Entry[] = [];
    for (let n = 1; n <= Math.floor(ROUTE_BODY_BYTES / probe) + 2; n += 1) {
      candidates.push(await minimal(n));
    }
    let fit = 0;
    let bytes = JSON.stringify({ receipts: [] }).length;
    for (const entry of candidates) {
      const next = bytes + JSON.stringify(entry).length + (fit === 0 ? 0 : 1);
      if (next > ROUTE_BODY_BYTES) break;
      bytes = next;
      fit += 1;
    }
    assert(fit < candidates.length);
    const fitting = candidates.slice(0, fit);
    assert(JSON.stringify({ receipts: fitting }).length <= ROUTE_BODY_BYTES);
    console.info(
      `[atk-12] one minimal Pro entry = ${probe} bytes; ${fit} entries fit under ${ROUTE_BODY_BYTES}`,
    );

    const started = performance.now();
    const response = await post({ receipts: fitting }, user.token);
    const elapsedMs = Math.round(performance.now() - started);
    assertEquals(response.status, 200);
    const answer = wire(await readJson(response));
    assertEquals(answer.rejected, []);
    assertEquals(answer.receipts.length, fit);
    assertEquals(new Set(answer.receipts.map((r) => r.receiptId)).size, fit);
    assertEquals(
      answer.receipts.every((r) => r.delivery === "pending"),
      true,
    );
    // Every entry reached the database: the settlement budget never engaged.
    assertEquals(rpcCalls, fit);
    assertEquals(settleCalls().length, fit);
    assert(fit > ROUTE_SETTLE_MAX, `${fit} entries must exceed the ${ROUTE_SETTLE_MAX} budget`);
    console.info(
      `[atk-12] ${fit} pending entries → ${rpcCalls} settle_offline_receipt calls in one request (${ROUTE_SETTLE_MAX} is the durable budget; ${elapsedMs}ms in-process with a stand-in database)`,
    );
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
     values ('${U(n)}', 'w04-04-atk-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'w04-04-atk-${n}-${RUN}', '${U(n)}', '{"sub":"w04-04-atk-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(tx: Tx, n: number, session: string | null = SESSION(n)): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (session !== null) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${session}"}'`);
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
  return [...rows];
}

async function shotCount(sql: Sql, resultId: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where id = '${resultId}'`,
  );
  return Number(count);
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

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `atk-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `atk-op-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
}

// ---------------------------------------------------------------------------
// ATK-5 — CONCURRENCY on one receipt and on one ticket. Two connections
// present the SAME receipt at the same instant; then two DIFFERENT receipts
// (two operations) for the same still-reserved ticket at the same instant.
// Exactly one consumed ledger event, one shot, one result_recorded row per
// ticket; the loser of the second race is a durable conflicting_receipt
// HOLD; lifetime_scored_count() moves by exactly one per ticket.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-5 live DB: two simultaneous deliveries of one receipt, then two simultaneous receipts for one ticket — one consumption, one shot, one free rating counted",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("atk5"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const before = await counters(sql, 1);

      // Same receipt, two connections, same instant.
      const a = await liveReceipt(U(1), issued, ticketA, "5a");
      const twice = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null)),
        inTx(sql, 1, (tx) => settle(tx, a.receipt, a.output, null)),
      ]);
      assertEquals(
        twice.map((r) => r.status),
        ["result_recorded", "result_recorded"],
      );
      assertEquals(twice.map((r) => r.delivery).sort(), ["replayed", "settled"]);
      assertEquals(
        twice.map((r) => r.financial_disposition),
        ["consumed", "consumed"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, a.output.id as string), 1);

      // Two different operations racing for ticket B.
      const b1 = await liveReceipt(U(1), issued, ticketB, "5b1", { lifecycleSequence: 2 });
      const b2 = await liveReceipt(U(1), issued, ticketB, "5b2", { lifecycleSequence: 3 });
      const race = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, b1.receipt, b1.output, null)),
        inTx(sql, 1, (tx) => settle(tx, b2.receipt, b2.output, null)),
      ]);
      assertEquals(race.map((r) => r.delivery).sort(), ["held", "settled"]);
      const winner = race.find((r) => r.delivery === "settled");
      const loser = race.find((r) => r.delivery === "held");
      assert(winner && loser);
      assertEquals(winner.financial_disposition, "consumed");
      assertEquals(
        [loser.status, loser.reason_code, loser.financial_disposition],
        ["reconciliation_required", "conflicting_receipt", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(
        (await shotCount(sql, b1.output.id as string)) +
          (await shotCount(sql, b2.output.id as string)),
        1,
      );
      // The loser is durable: it replays as the same HOLD, never settles later.
      const loserRec = winner.result_id === b1.receipt.resultId ? b2 : b1;
      const replay = await inTx(sql, 1, (tx) =>
        settle(tx, loserRec.receipt, loserRec.output, null),
      );
      assertEquals(
        [replay.delivery, replay.status, replay.reason_code],
        ["replayed", "reconciliation_required", "conflicting_receipt"],
      );
      assertEquals((await settlementRows(sql, 1)).length, 3);

      const after = await counters(sql, 1);
      assertEquals(after.scored - before.scored, 2, "exactly two free ratings for two tickets");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-6 — settle vs release RACE on the same ticket (the device returns the
// ticket as unused on one connection while its receipt for that ticket lands
// on another). The ledger must end with exactly ONE terminal event; whichever
// loses is a durable HOLD (settle) or a non-accepted answer (release) — never
// a consumed AND released ticket, never a refund of a consumed one.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-6 live DB: a receipt and an unused-ticket release racing on one ticket leave exactly one terminal ledger event; the loser never rewrites it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("atk6"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(2), issued, ticketA, "6");
      const [settled, released] = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, rec.receipt, rec.output, null)),
        inTx(sql, 2, async (tx) => {
          const rows = await tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as result`,
          );
          return rows[0].result;
        }),
      ]);
      const events = await ledgerEvents(sql, ticketA);
      assertEquals(events.length, 2, JSON.stringify(events));
      assertEquals(events[0], "allocated");
      if (events[1] === "consumed") {
        assertEquals([settled.delivery, settled.financial_disposition], ["settled", "consumed"]);
        assertEquals(released, "offline.ticket_consumed");
      } else {
        assertEquals(events[1], "released");
        assertEquals(released, "accepted");
        assertEquals(
          [settled.delivery, settled.status, settled.reason_code, settled.financial_disposition],
          ["held", "reconciliation_required", "conflicting_receipt", "reserved"],
        );
        assertEquals(await shotCount(sql, rec.output.id as string), 0);
      }
      // A second pass of either side changes nothing.
      const again = await inTx(sql, 2, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "replayed");
      assertEquals(again.status, settled.status);
      const releaseAgain = await inTx(sql, 2, async (tx) => {
        const rows = await tx.unsafe<{ result: string }[]>(
          `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as result`,
        );
        return rows[0].result;
      });
      assertEquals(releaseAgain, events[1] === "consumed" ? "offline.ticket_consumed" : "accepted");
      assertEquals(await ledgerEvents(sql, ticketA), events);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-7 — UNAUTHORISED ROLES for the new SQL surface (allowed AND denied):
// anon, service_role, authenticated without a session claim, authenticated
// with a foreign session, a banned user; exactly one settle_offline_receipt
// overload exists (the old 4-arg signature is gone, no ambiguous default);
// the settlement table refuses every direct client DML; the lease-shot
// writer is not executable by any client role.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-7 live DB: anon / service_role / no-session / foreign-session / banned callers are refused, one overload exists, direct table DML and the lease writer are denied",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const issued = await issueFreeGrant(sql, 3, KEY("atk7"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(3), issued, ticketA, "7");
      const roleCall = (setup: (tx: Tx) => Promise<void>) =>
        sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await setup(tx);
          return await settle(tx, rec.receipt, rec.output, null);
        });

      // Exactly one overload.
      const [{ n }] = await sql.unsafe<{ n: string }[]>(
        `select count(*)::text as n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
         where s.nspname = 'public' and p.proname = 'settle_offline_receipt'`,
      );
      assertEquals(n, "1");

      // anon: no execute.
      await assertRejects(() =>
        roleCall(async (tx) => {
          await tx.unsafe(`set local role anon`);
        }),
      );
      // service_role: no execute (server-owned rows are not settled this way).
      await assertRejects(() =>
        roleCall(async (tx) => {
          await tx.unsafe(`set local role service_role`);
        }),
      );
      // authenticated without a session claim.
      await assertRejects(() =>
        roleCall(async (tx) => {
          await asUser(tx, 3, null);
        }),
      );
      // authenticated with ANOTHER user's session id.
      await assertRejects(() =>
        roleCall(async (tx) => {
          await asUser(tx, 3, SESSION(4));
        }),
      );
      // authenticated with a session that does not exist.
      await assertRejects(() =>
        roleCall(async (tx) => {
          await asUser(tx, 3, "0000000c-0404-4000-8000-000000000000");
        }),
      );
      // authenticated without the API request key header.
      await assertRejects(() =>
        sql.begin(async (raw) => {
          const tx = raw as unknown as Tx;
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`set local request.jwt.claim.sub = '${U(3)}'`);
          await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(3)}"}'`);
          return await settle(tx, rec.receipt, rec.output, null);
        }),
      );
      // banned user.
      await sql.unsafe(
        `update auth.users set banned_until = now() + interval '1 day' where id = '${U(3)}'`,
      );
      await assertRejects(() => inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null)));
      await sql.unsafe(`update auth.users set banned_until = null where id = '${U(3)}'`);

      // None of the refused attempts wrote anything.
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlementRows(sql, 3), []);
      assertEquals(await shotCount(sql, rec.output.id as string), 0);

      // The allowed path still works for the owner with a live session.
      const ok = await inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals([ok.delivery, ok.financial_disposition], ["settled", "consumed"]);

      // Direct DML on the settlement table as the owner: every verb denied.
      for (const statement of [
        `select count(*) from public.offline_receipt_settlements`,
        `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${U(3)}'`,
        `delete from public.offline_receipt_settlements where user_id = '${U(3)}'`,
        `insert into public.offline_receipt_settlements (user_id, receipt_id, receipt_sha256, owner_id,
           installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256,
           billing_disposition, lifecycle_sequence, status, financial_disposition, receipt)
         values ('${U(3)}', 'forged', '${"a".repeat(64)}', '${U(3)}', 'k', '${GRANT_ID}',
           '${"b".repeat(64)}', 'op', 'res', '${"c".repeat(64)}', 'joint_verification_required', 1,
           'result_recorded', 'consumed', '{}')`,
      ]) {
        await assertRejects(() => inTx(sql, 3, (tx) => tx.unsafe(statement)), Error, "", statement);
      }
      // The lease-shot writer: not executable by clients or the service role.
      for (const role of ["anon", "authenticated", "service_role"]) {
        await assertRejects(() =>
          sql.begin(async (raw) => {
            const tx = raw as unknown as Tx;
            await tx.unsafe(`set local role ${role}`);
            await tx.unsafe(
              `select api_private.record_offline_lease_shot('${GRANT_ID}', '{}'::jsonb)`,
            );
          }),
        );
      }
      // Still exactly one settlement, one consumption.
      assertEquals((await settlementRows(sql, 3)).length, 1);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-8 — CROSS-ACCOUNT replay: user B (same device, interleaved account
// switch) presents user A's receipt VERBATIM, then A's receipt with the
// ownerId rewritten to B, then A presents the genuine receipt. B's attempts
// are durable HOLDs in B's namespace only; A's ticket is consumed exactly
// once by A; nothing of A's verdict leaks to B; B's free ratings are not
// touched; B cannot lock A out of the ticket.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-8 live DB: another account replaying or re-owning a receipt is held in its own namespace; the owner still settles exactly once and nothing leaks across accounts",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      await createUser(sql, 6);
      const issued = await issueFreeGrant(sql, 5, KEY("atk8"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(5), issued, ticketA, "8");
      const bBefore = await counters(sql, 6);

      // B presents A's receipt verbatim (ownerId = A).
      const verbatim = await inTx(sql, 6, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(
        [
          verbatim.delivery,
          verbatim.status,
          verbatim.reason_code,
          verbatim.financial_disposition,
          verbatim.result_id,
        ],
        ["held", "reconciliation_required", "owner_mismatch", "reserved", null],
      );
      // B presents A's receipt re-owned to B (same ticket, another body). B's
      // own durable owner_mismatch HOLD already names this operation, so the
      // re-owned copy is a conflicting_receipt HOLD in B's namespace.
      const reowned: OfflineDeviceReceipt = {
        ...a.receipt,
        receiptId: `${a.receipt.receiptId}-b`,
        ownerId: U(6),
      };
      const forged = await inTx(sql, 6, (tx) => settle(tx, reowned, a.output, null));
      assertEquals(
        [forged.delivery, forged.status, forged.reason_code, forged.financial_disposition],
        ["held", "reconciliation_required", "conflicting_receipt", "reserved"],
      );
      // A fresh operation re-owned to B for A's ticket: ticket not B's → ambiguous.
      const stolen: OfflineDeviceReceipt = {
        ...a.receipt,
        receiptId: `${a.receipt.receiptId}-c`,
        ownerId: U(6),
        operationId: `${a.receipt.operationId}-c`,
        resultId: crypto.randomUUID(),
      };
      const stolenAnswer = await inTx(sql, 6, (tx) => settle(tx, stolen, null, null));
      assertEquals(
        [
          stolenAnswer.delivery,
          stolenAnswer.status,
          stolenAnswer.reason_code,
          stolenAnswer.financial_disposition,
        ],
        ["held", "reconciliation_required", "evidence_ambiguous", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, a.output.id as string), 0);

      // A presents the genuine receipt: settled once, B's rows are no obstacle.
      const genuine = await inTx(sql, 5, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(
        [genuine.delivery, genuine.financial_disposition, genuine.result_id],
        ["settled", "consumed", a.receipt.resultId],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      const [shot] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${a.output.id}'`,
      );
      assertEquals(shot.user_id, U(5));

      // B replaying afterwards still sees ITS hold, never A's verdict.
      const bAgain = await inTx(sql, 6, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(
        [bAgain.delivery, bAgain.status, bAgain.reason_code, bAgain.result_id],
        ["replayed", "reconciliation_required", "owner_mismatch", null],
      );
      // B with A's grant but with the settle deferred under a freeze: the
      // durable HOLD still replays (durable first, freeze never consulted).
      const bFrozen = await inTx(sql, 6, (tx) => settle(tx, a.receipt, a.output, null, true));
      assertEquals(bFrozen.delivery, "replayed");

      assertEquals(
        (await settlementRows(sql, 6)).map((r) => [r.status, r.reason_code]),
        [
          ["reconciliation_required", "owner_mismatch"],
          ["reconciliation_required", "conflicting_receipt"],
          ["reconciliation_required", "evidence_ambiguous"],
        ],
      );
      assertEquals(
        (await settlementRows(sql, 5)).map((r) => r.status),
        ["result_recorded"],
      );
      const bAfter = await counters(sql, 6);
      assertEquals(bAfter.scored, bBefore.scored, "B's free ratings untouched");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-9 — CORRUPT / PARTIAL persisted state: the allocating grant row is gone
// (offline_grants) while the ledger still holds the allocation; a shot with
// the receipt's result id already exists for the owner (written by another
// path); the receipt names a session that does not exist / belongs to
// another user. None may consume the ticket; the first two are durable HOLDs;
// the session case is pending with NOTHING durable and settles exactly once
// after the session lands.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-9 live DB: a vanished grant row, a pre-existing shot id and a missing / foreign session never consume the ticket; only the owner's session landing settles it, once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      await createUser(sql, 8);
      await createUser(sql, 11);
      const before = await counters(sql, 7);

      // (a) Grant row deleted after issuance (ledger keeps the allocation) —
      // its own user, since one grant already reserves both free ratings.
      const gone = await issueFreeGrant(sql, 11, KEY("atk9-gone"));
      assert(gone.claims.allocation);
      const [goneTicket] = gone.claims.allocation.ticketIds;
      const goneRec = await liveReceipt(U(11), gone, goneTicket, "9-gone");
      await sql.unsafe(`delete from public.offline_grants where id = '${gone.claims.jti}'`);
      const heldGone = await inTx(sql, 11, (tx) =>
        settle(tx, goneRec.receipt, goneRec.output, null),
      );
      assertEquals(
        [heldGone.delivery, heldGone.reason_code, heldGone.financial_disposition],
        ["held", "evidence_ambiguous", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, goneTicket), ["allocated"]);
      assertEquals(
        (await settlementRows(sql, 11)).map((r) => r.reason_code),
        ["evidence_ambiguous"],
      );

      // (b) A shot with this result id already exists for the owner.
      const issued = await issueFreeGrant(sql, 7, KEY("atk9"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const dup = await liveReceipt(U(7), issued, ticketA, "9-dup");
      await sql.unsafe(
        `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, end_ms,
           analysis_confidence, result_kind, app_version, model_bundle_version, pose_model_version,
           paddle_model_version, stroke_detector_version, phase_model_version, scoring_model_version,
           shot_config_version)
         values ('${dup.output.id}', '${U(7)}', 'dink', 'side', '2026-09-01T10:00:00Z', 0, 200,
           0.5, 'low_confidence', '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1',
           'scoring-1', 'config-1')`,
      );
      const heldDup = await inTx(sql, 7, (tx) => settle(tx, dup.receipt, dup.output, null));
      assertEquals(
        [heldDup.delivery, heldDup.reason_code, heldDup.financial_disposition],
        ["held", "conflicting_receipt", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, dup.output.id as string), 1);

      // (c) Session not yet synced, then a session that belongs to user 8.
      const sessionId = crypto.randomUUID();
      const foreignSession = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${foreignSession}', '${U(8)}', now())`,
      );
      const late = await liveReceipt(
        U(7),
        issued,
        ticketB,
        "9-late",
        { lifecycleSequence: 2 },
        {
          sessionId,
        },
      );
      for (let i = 0; i < 3; i += 1) {
        const pending = await inTx(sql, 7, (tx) => settle(tx, late.receipt, late.output, null));
        assertEquals(
          [pending.delivery, pending.status, pending.financial_disposition],
          ["pending", "pending", "reserved"],
        );
      }
      const foreign = await liveReceipt(
        U(7),
        issued,
        ticketB,
        "9-foreign",
        { lifecycleSequence: 3 },
        {
          sessionId: foreignSession,
        },
      );
      const foreignAnswer = await inTx(sql, 7, (tx) =>
        settle(tx, foreign.receipt, foreign.output, null),
      );
      assertEquals(
        foreignAnswer.delivery,
        "pending",
        "a foreign session is answered like a missing one",
      );
      assertEquals(
        (await settlementRows(sql, 7)).map((r) => r.receipt_id),
        [dup.receipt.receiptId],
        "nothing durable for pending",
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotCount(sql, late.output.id as string), 0);

      // The owner's session lands: the identical redelivery settles exactly once.
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${U(7)}', now())`,
      );
      const settled = await inTx(sql, 7, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals([settled.delivery, settled.financial_disposition], ["settled", "consumed"]);
      const replay = await inTx(sql, 7, (tx) => settle(tx, late.receipt, late.output, null));
      assertEquals([replay.delivery, replay.financial_disposition], ["replayed", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, late.output.id as string), 1);
      // The foreign-session receipt for the now-consumed ticket is a durable HOLD.
      const foreignAfter = await inTx(sql, 7, (tx) =>
        settle(tx, foreign.receipt, foreign.output, null),
      );
      assertEquals(
        [foreignAfter.delivery, foreignAfter.reason_code],
        ["held", "conflicting_receipt"],
      );

      const after = await counters(sql, 7);
      assertEquals(after.scored - before.scored, 1, "one free rating for the whole matrix");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-10 — SQL boundary matrix, bypassing the edge validator (a compromised
// client posts straight at the RPC): safe-integer edges of lifecycleSequence
// and ticket.generation, a fraction, a numeric string, an empty / oversize
// receipt id, an unknown hold reason, a non-object output. Every malformed
// input is offline.invalid_input with NOTHING durable and the ticket
// untouched; MAX_SAFE_INTEGER itself settles.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-10 live DB: malformed receipts at the RPC are offline.invalid_input with nothing durable; MAX_SAFE_INTEGER edges settle",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueFreeGrant(sql, 9, KEY("atk10"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const base = await liveReceipt(U(9), issued, ticketA, "10");
      const mutate = (patch: Record<string, unknown>): OfflineDeviceReceipt =>
        ({ ...base.receipt, ...patch }) as OfflineDeviceReceipt;
      const ticket = base.receipt.ticket;
      assert(ticket);
      const invalid: [
        string,
        OfflineDeviceReceipt,
        Record<string, unknown> | null,
        string | null,
      ][] = [
        ["sequence 0", mutate({ lifecycleSequence: 0 }), base.output, null],
        ["sequence -1", mutate({ lifecycleSequence: -1 }), base.output, null],
        ["sequence 1.5", mutate({ lifecycleSequence: 1.5 }), base.output, null],
        ["sequence string", mutate({ lifecycleSequence: "1" }), base.output, null],
        ["sequence 2^53", mutate({ lifecycleSequence: 9007199254740992 }), base.output, null],
        ["sequence 1e300", mutate({ lifecycleSequence: 1e300 }), base.output, null],
        ["generation 0", mutate({ ticket: { ...ticket, generation: 0 } }), base.output, null],
        [
          "generation 2^53",
          mutate({ ticket: { ...ticket, generation: 9007199254740992 } }),
          base.output,
          null,
        ],
        [
          "generation string",
          mutate({ ticket: { ...ticket, generation: "1" } }),
          base.output,
          null,
        ],
        [
          "ticket missing",
          (({ ticket: _t, ...rest }) => rest as unknown as OfflineDeviceReceipt)(base.receipt),
          base.output,
          null,
        ],
        [
          "ticket not uuid",
          mutate({ ticket: { ...ticket, ticketId: "not-a-uuid" } }),
          base.output,
          null,
        ],
        ["receipt id empty", mutate({ receiptId: "" }), base.output, null],
        ["receipt id 129", mutate({ receiptId: "r".repeat(129) }), base.output, null],
        ["owner not uuid", mutate({ ownerId: "nobody" }), base.output, null],
        ["billing unknown", mutate({ billingDisposition: "free" }), base.output, null],
        ["hold reason unknown", base.receipt, base.output, "refund_requested"],
        ["output array", base.receipt, [1, 2, 3] as unknown as Record<string, unknown>, null],
      ];
      for (const [label, rec, out, hold] of invalid) {
        const rows = await inTx(sql, 9, (tx) =>
          tx.unsafe<SettleRow[]>(
            `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
             from public.settle_offline_receipt(${lit(rec)}, '${"f".repeat(64)}',
               ${out === null ? "null::jsonb" : lit(out)}, ${hold === null ? "null::text" : `'${hold}'`}) r`,
          ),
        );
        assertEquals(rows.length, 1, label);
        assertEquals(rows[0].result, "offline.invalid_input", label);
        assertEquals(rows[0].delivery, null, label);
      }
      // A malformed digest parameter too.
      const badDigest = await inTx(sql, 9, (tx) =>
        tx.unsafe<SettleRow[]>(
          `select r.result from public.settle_offline_receipt(${lit(base.receipt)}, 'ABC', ${lit(sqlOutput(base.output))}, null) r`,
        ),
      );
      assertEquals(badDigest[0].result, "offline.invalid_input");
      assertEquals(await settlementRows(sql, 9), []);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // The edges that ARE valid settle once and replay.
      const maxSeq = await liveReceipt(U(9), issued, ticketA, "10-max", {
        lifecycleSequence: 9007199254740991,
      });
      const first = await inTx(sql, 9, (tx) => settle(tx, maxSeq.receipt, maxSeq.output, null));
      assertEquals([first.delivery, first.financial_disposition], ["settled", "consumed"]);
      const again = await inTx(sql, 9, (tx) => settle(tx, maxSeq.receipt, maxSeq.output, null));
      assertEquals(again.delivery, "replayed");
      const [{ lifecycle_sequence }] = await sql.unsafe<{ lifecycle_sequence: string }[]>(
        `select lifecycle_sequence::text from public.offline_receipt_settlements
         where user_id = '${U(9)}' and receipt_id = '${maxSeq.receipt.receiptId}'`,
      );
      assertEquals(lifecycle_sequence, "9007199254740991");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATK-11 — FREE-RATING CONSERVATION through the freeze and through
// contradictory billing: under p_defer_new a new chargeable receipt is
// pending N times with nothing consumed; a not_chargeable receipt beside a
// scored output is a HOLD; an abstention (not_chargeable, no output) is
// recorded without consuming; the freeze lifting settles the deferred
// receipt exactly once. lifetime_scored_count() moves by exactly one.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATK-11 live DB: deferred, contradictory and abstaining receipts never consume; the freeze lifting settles the deferred one exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("atk11"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const before = await counters(sql, 10);

      const deferred = await liveReceipt(U(10), issued, ticketA, "11-defer");
      for (let i = 0; i < 5; i += 1) {
        const pending = await inTx(sql, 10, (tx) =>
          settle(tx, deferred.receipt, deferred.output, null, true),
        );
        assertEquals([pending.delivery, pending.financial_disposition], ["pending", "reserved"]);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlementRows(sql, 10), []);

      // A contradictory receipt on ticket B: says nothing to charge, output scored.
      const contradiction = await liveReceipt(U(10), issued, ticketB, "11-contra", {
        billingDisposition: "not_chargeable",
        lifecycleSequence: 2,
      });
      const held = await inTx(sql, 10, (tx) =>
        settle(tx, contradiction.receipt, contradiction.output, null),
      );
      assertEquals(
        [held.delivery, held.reason_code, held.financial_disposition],
        ["held", "evidence_ambiguous", "reserved"],
      );
      // An honest abstention on ticket B: recorded, ticket stays outstanding.
      const abstention = await liveReceipt(U(10), issued, ticketB, "11-abstain", {
        billingDisposition: "not_chargeable",
        lifecycleSequence: 3,
      });
      const recorded = await inTx(sql, 10, (tx) => settle(tx, abstention.receipt, null, null));
      assertEquals(
        [recorded.delivery, recorded.status, recorded.financial_disposition],
        ["settled", "result_recorded", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      // Under the freeze the abstention and the HOLD replay, never pending.
      const replayHeld = await inTx(sql, 10, (tx) =>
        settle(tx, contradiction.receipt, contradiction.output, null, true),
      );
      assertEquals(
        [replayHeld.delivery, replayHeld.reason_code],
        ["replayed", "evidence_ambiguous"],
      );
      const replayRecorded = await inTx(sql, 10, (tx) =>
        settle(tx, abstention.receipt, null, null, true),
      );
      assertEquals(
        [replayRecorded.delivery, replayRecorded.status],
        ["replayed", "result_recorded"],
      );

      const mid = await counters(sql, 10);
      assertEquals(mid.scored, before.scored, "nothing counted yet");

      // The freeze lifts: the deferred receipt settles once.
      const settled = await inTx(sql, 10, (tx) =>
        settle(tx, deferred.receipt, deferred.output, null, false),
      );
      assertEquals([settled.delivery, settled.financial_disposition], ["settled", "consumed"]);
      const frozenReplay = await inTx(sql, 10, (tx) =>
        settle(tx, deferred.receipt, deferred.output, null, true),
      );
      assertEquals(
        [frozenReplay.delivery, frozenReplay.financial_disposition],
        ["replayed", "consumed"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, deferred.output.id as string), 1);

      const after = await counters(sql, 10);
      assertEquals(after.scored - before.scored, 1);
    } finally {
      await sql.end();
    }
  },
});
