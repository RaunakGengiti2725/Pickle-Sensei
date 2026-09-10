// W04-04 ADVERSARIAL TESTS — POST /v1/offline/receipts + settle_offline_receipt()
// attacked at its failure boundaries. Written against candidate
// ab34866ed7cd6697ba2ddd40bdc9019f9c2979ba; on BASE_SHA (17377c5a) the route
// answers 404 and the RPC does not exist, so every test here fails there.
//
// Attack categories (each is a real test, none is skipped when XC_PG_URL is set):
//   A. duplicate identities   — the same receiptId twice in ONE batch
//   B. boundary values        — lifecycleSequence 0/-1/1.5/2^53/"7", generation 0,
//                               far-future / epoch / offset clocks, 128 vs 129
//                               char ids, array / string outputs, body cap ±1 byte
//   C. network failure        — RPC answers [], garbage rows, HTML, 429, 500 and
//                               a failure MID-batch (decided entries stay decided)
//   D. concurrency            — the same receipt on two connections at once; two
//                               different receipts for one ticket at once; two
//                               accounts interleaved on one ticket id space
//   E. process death          — a settling backend killed before commit; a
//                               settler killed while blocked on the owner lock
//   F. interleaved accounts   — B presents A's receipt straight to the RPC with
//                               NO hold reason; same receipt id under two owners
//   G. unauthorised roles     — anon / service_role / no session / no API key on
//                               the RPC and the settlement table (allowed AND denied)
//   H. free-rating conservation — replays, abstentions, terminal tickets and
//                               HOLDs never move lifetime_scored_count()
//   I. corrupt persisted state — settlement row lost after consumption; the
//                               rating already in shots; ticket released behind
//                               the device's back; revoked installation; expired
//                               grant row; Pro lease after the entitlement lapsed
//   J. clock rollback         — a receipt queued "before" its grant was issued
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
const BODY_CAP = 2_000_000;

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
  return {
    sub: `abababab-0404-4000-8000-${String(userSeq).padStart(12, "0")}`,
    token: fakeGoogleIdToken(`abababab-0404-4000-8000-${String(userSeq).padStart(12, "0")}`),
  };
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

async function fixture(
  ownerId: string,
  ticketId: string,
  n: number,
  claims = freeClaims(ownerId),
): Promise<{
  claims: OfflineExecutionGrantClaims;
  grant: OfflineSignedExecutionGrant;
  receipt: OfflineDeviceReceipt;
  output: Record<string, unknown>;
}> {
  const grant = await sign(claims);
  const resultId = `7100000${n % 10}-0404-4000-8000-000000000${String(n).padStart(3, "0")}`;
  const out = output(resultId);
  const rec = await receipt({
    receiptId: `attack-receipt-${n}`,
    ownerId,
    grant,
    claims,
    ticket: ticketRef(ticketId, claims),
    lifecycleSequence: n,
    operationId: `attack-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
  });
  return { claims, grant, receipt: rec, output: out };
}

// --- durable RPC stand-in (mirrors the migration's replay / conflict rule) ----

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
  const template = userRequest("POST", RECEIPTS_PATH, { token, body: {} });
  const headers = new Headers(template.headers);
  headers.set("content-length", String(new TextEncoder().encode(text).byteLength));
  return await h.handler(new Request(template.url, { method: "POST", headers, body: text }));
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
  delivery: string;
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
  assert(Array.isArray(body.receipts) && Array.isArray(body.rejected));
  return body as unknown as WireAnswer;
}

/** Every submitted id named exactly once across receipts[] + rejected[]. */
function assertNamedOnce(answer: WireAnswer, ids: readonly string[]): void {
  const named = [
    ...answer.receipts.map((r) => r.receiptId),
    ...answer.rejected.map((r) => r.receiptId),
  ];
  assertEquals([...named].sort(), [...ids].sort(), JSON.stringify(answer));
}

/** Mirror of apps/mobile parseOfflineReceiptVerdicts: null = unreadable answer. */
function mobileVerdicts(value: unknown, submittedIds: readonly string[]): string[] | null {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isObject(value) || !Array.isArray(value.receipts) || !Array.isArray(value.rejected)) {
    return null;
  }
  const verdicts = new Map<string, string>();
  const statuses = new Map([
    ["result_recorded", "accepted"],
    ["unused_ticket_returned", "refused"],
    ["pending", "held"],
    ["reconciliation_required", "held"],
    ["support_review_required", "held"],
  ]);
  for (const entry of value.receipts) {
    if (
      !isObject(entry) || typeof entry.receiptId !== "string" || typeof entry.status !== "string"
    ) {
      return null;
    }
    const verdict = statuses.get(entry.status);
    if (verdict === undefined || verdicts.has(entry.receiptId)) return null;
    verdicts.set(entry.receiptId, verdict);
  }
  for (const entry of value.rejected) {
    if (!isObject(entry) || typeof entry.receiptId !== "string" || typeof entry.code !== "string") {
      return null;
    }
    if (verdicts.has(entry.receiptId)) return null;
    verdicts.set(entry.receiptId, "refused");
  }
  if (verdicts.size !== submittedIds.length) return null;
  const ordered: string[] = [];
  for (const id of submittedIds) {
    const verdict = verdicts.get(id);
    if (verdict === undefined) return null;
    ordered.push(verdict);
  }
  return ordered;
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

// ===========================================================================
// A. Duplicate identities — the same receiptId twice in ONE batch
// ===========================================================================

Deno.test("attack A: the same receiptId twice in one batch (different bodies) settles once; the copy is a conflict, the mobile parser refuses the doubled answer", async () => {
  reset();
  const user = freshUser();
  const first = await fixture(user.sub, TICKET_A, 1);
  const twin = await fixture(user.sub, TICKET_B, 2);
  const forged = { ...twin.receipt, receiptId: first.receipt.receiptId };
  const ids = [first.receipt.receiptId, forged.receiptId];
  const response = await post(
    {
      receipts: [
        { receipt: first.receipt, grant: first.grant, output: first.output },
        { receipt: forged, grant: twin.grant, output: twin.output },
      ],
    },
    user.token,
  );
  assertEquals(response.status, 200);
  const body = await readJson(response);
  const answer = wire(body);
  assertEquals(answer.receipts.map((r) => [r.receiptId, r.delivery, r.status]), [
    [first.receipt.receiptId, "settled", "result_recorded"],
  ]);
  assertEquals(answer.rejected.map((r) => [r.receiptId, r.code]), [
    [first.receipt.receiptId, "offline.receipt_conflict"],
  ]);
  // Exactly one settlement was made durable for that id.
  assertEquals([...durable.values()].filter((d) => d.row.delivery === "settled").length, 1);
  // The doubled id is unreadable to the shipping app — the drain fails closed
  // (journal in_flight) rather than misattributing a verdict.
  assertEquals(mobileVerdicts(body, ids), null);

  // Same id, same body, twice in one batch: settled then replayed.
  reset();
  const other = freshUser();
  const same = await fixture(other.sub, TICKET_A, 3);
  const entry = { receipt: same.receipt, grant: same.grant, output: same.output };
  const again = wire(await readJson(await post({ receipts: [entry, entry] }, other.token)));
  assertEquals(again.receipts.map((r) => r.delivery), ["settled", "replayed"]);
  assertEquals(again.rejected, []);
  assertEquals(settleCalls().length, 2);
});

// ===========================================================================
// B. Boundary values
// ===========================================================================

Deno.test("attack B1: hostile scalar boundaries are rejected PER ENTRY before the database, each id named exactly once, the well-formed sibling settles", async () => {
  reset();
  const user = freshUser();
  const good = await fixture(user.sub, TICKET_A, 4);
  const base = good.receipt;
  const ticket = base.ticket;
  assert(ticket);
  const variants: Record<string, Record<string, unknown>> = {
    "seq-zero": { ...base, lifecycleSequence: 0 },
    "seq-negative": { ...base, lifecycleSequence: -1 },
    "seq-fraction": { ...base, lifecycleSequence: 1.5 },
    "seq-unsafe": { ...base, lifecycleSequence: 2 ** 53 },
    "seq-string": { ...base, lifecycleSequence: "7" },
    "seq-negzero": { ...base, lifecycleSequence: -0 },
    "gen-zero": { ...base, ticket: { ...ticket, generation: 0 } },
    "gen-fraction": { ...base, ticket: { ...ticket, generation: 1.5 } },
    "queued-offset": { ...base, queuedAt: "2026-09-08T12:00:00.000+00:00" },
    "queued-nonsense": { ...base, queuedAt: "2026-13-45T99:00:00.000Z" },
    "queued-number": { ...base, queuedAt: 1757332800000 },
    "receipt-extra-key": { ...base, nativeTime: null },
    "receipt-missing-key": (() => {
      const { queuedAt: _q, ...rest } = base;
      return rest;
    })(),
    "owner-uppercase": { ...base, ownerId: base.ownerId.toUpperCase() },
    "digest-uppercase": { ...base, fullOutputSha256: base.fullOutputSha256.toUpperCase() },
    "digest-short": { ...base, fullOutputSha256: base.fullOutputSha256.slice(0, 63) },
    "billing-unknown": { ...base, billingDisposition: "refunded" },
    "ticket-string": { ...base, ticket: ticket.ticketId },
  };
  const entries: Record<string, unknown>[] = [];
  const ids: string[] = [];
  for (const [tag, rec] of Object.entries(variants)) {
    const id = `attack-b1-${tag}`;
    entries.push({ receipt: { ...rec, receiptId: id }, grant: good.grant, output: good.output });
    ids.push(id);
  }
  // Output shape boundaries: array / string / number / boolean instead of object|null.
  for (
    const [tag, out] of Object.entries({
      "out-array": [],
      "out-string": "scored",
      "out-number": 7,
      "out-true": true,
    })
  ) {
    const id = `attack-b1-${tag}`;
    entries.push({ receipt: { ...base, receiptId: id }, grant: good.grant, output: out });
    ids.push(id);
  }
  // Entry-level shape: grant missing, grant null, output key missing.
  entries.push({ receipt: { ...base, receiptId: "attack-b1-no-grant" }, output: good.output });
  ids.push("attack-b1-no-grant");
  entries.push({
    receipt: { ...base, receiptId: "attack-b1-null-grant" },
    grant: null,
    output: good.output,
  });
  ids.push("attack-b1-null-grant");
  entries.push({ receipt: { ...base, receiptId: "attack-b1-no-output" }, grant: good.grant });
  ids.push("attack-b1-no-output");
  // The well-formed sibling last.
  entries.push({ receipt: base, grant: good.grant, output: good.output });
  ids.push(base.receiptId);

  const response = await post({ receipts: entries }, user.token);
  assertEquals(response.status, 200);
  const body = await readJson(response);
  const answer = wire(body);
  assertNamedOnce(answer, ids);
  assertEquals(answer.receipts.map((r) => [r.receiptId, r.delivery]), [[
    base.receiptId,
    "settled",
  ]]);
  assertEquals(answer.rejected.length, ids.length - 1);
  for (const r of answer.rejected) assertEquals(r.code, "offline.invalid_input");
  // Nothing malformed reached the database.
  assertEquals(settleCalls().length, 1);
  assertEquals(settleCalls()[0].p_receipt.receiptId, base.receiptId);
  assertEquals(mobileVerdicts(body, ids)?.at(-1), "accepted");
});

Deno.test("attack B2: far-future and epoch queue clocks are still settleable (the ledger, not the clock, decides); a receiptId of 128 chars settles, 129 is a batch-level 400", async () => {
  reset();
  const user = freshUser();
  const a = await fixture(user.sub, TICKET_A, 5);
  const b = await fixture(user.sub, TICKET_B, 6);
  const future = { ...a.receipt, queuedAt: "9999-12-31T23:59:59.999Z" };
  const epoch = { ...b.receipt, queuedAt: "1970-01-01T00:00:00.000Z" };
  const answer = wire(
    await readJson(
      await post(
        {
          receipts: [
            { receipt: future, grant: a.grant, output: a.output },
            { receipt: epoch, grant: b.grant, output: b.output },
          ],
        },
        user.token,
      ),
    ),
  );
  assertEquals(answer.receipts.map((r) => r.delivery), ["settled", "settled"]);
  assertEquals(answer.rejected, []);

  reset();
  const user2 = freshUser();
  const c = await fixture(user2.sub, TICKET_A, 7);
  const id128 = "r".repeat(128);
  const ok = wire(
    await readJson(
      await post(
        {
          receipts: [{
            receipt: { ...c.receipt, receiptId: id128 },
            grant: c.grant,
            output: c.output,
          }],
        },
        user2.token,
      ),
    ),
  );
  assertEquals(ok.receipts.map((r) => [r.receiptId, r.delivery]), [[id128, "settled"]]);

  const id129 = "r".repeat(129);
  const tooLong = await post(
    {
      receipts: [
        { receipt: c.receipt, grant: c.grant, output: c.output },
        { receipt: { ...c.receipt, receiptId: id129 }, grant: c.grant, output: c.output },
      ],
    },
    user2.token,
  );
  assertEquals(tooLong.status, 400);
  const err = await readJson(tooLong);
  assertEquals((err.error as Record<string, unknown>).code, "offline.invalid_input");
  // The batch was refused before anything reached the database: the sibling
  // was NOT settled a second time (still exactly one call from the 128 case).
  assertEquals(settleCalls().length, 1);

  // Non-array / empty / null receipts are 400, never 200 with an empty answer.
  for (
    const body of [{ receipts: [] }, { receipts: {} }, { receipts: null }, {}, { receipts: "x" }]
  ) {
    assertEquals((await post(body, user2.token)).status, 400, JSON.stringify(body));
  }
});

Deno.test("attack B3: request body exactly at the 2,000,000-byte cap is read; one byte over is 413 and never reaches the database", async () => {
  reset();
  const user = freshUser();
  const a = await fixture(user.sub, TICKET_A, 8);
  const entry = { receipt: a.receipt, grant: a.grant, output: a.output };
  const prefix = `{"receipts":[${JSON.stringify(entry)}],"pad":"`;
  const suffix = `"}`;
  const enc = new TextEncoder();
  const padLength = BODY_CAP - enc.encode(prefix).byteLength - enc.encode(suffix).byteLength;
  assert(padLength > 0);
  const exact = `${prefix}${"x".repeat(padLength)}${suffix}`;
  assertEquals(enc.encode(exact).byteLength, BODY_CAP);
  const atCap = await postRaw(exact, user.token);
  assertEquals(atCap.status, 200, await atCap.text());
  const over = `${prefix}${"x".repeat(padLength + 1)}${suffix}`;
  const overCap = await postRaw(over, user.token);
  assertEquals(overCap.status, 413);
  await overCap.body?.cancel();
  assertEquals(settleCalls().length, 1);
});

// ===========================================================================
// C. Network failure at the RPC step
// ===========================================================================

Deno.test("attack C: every malformed / failing RPC answer is a generic 503 (never a 200 that the app would apply); entries decided before the failure replay on redelivery", async () => {
  const user = freshUser();
  const fixtures = [
    await fixture(user.sub, TICKET_A, 9),
    await fixture(user.sub, TICKET_B, 10),
    await fixture(user.sub, TICKET_A, 11),
  ];
  const entries = fixtures.map((f) => ({ receipt: f.receipt, grant: f.grant, output: f.output }));
  const failures: Record<string, () => Response> = {
    "empty-array": () =>
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    "two-rows": () =>
      new Response(
        JSON.stringify([{ result: "accepted", delivery: "settled" }, { result: "accepted" }]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    "unknown-delivery": () =>
      new Response(
        JSON.stringify([
          {
            result: "accepted",
            delivery: "exploded",
            status: "result_recorded",
            reason_code: null,
            financial_disposition: "consumed",
            result_id: fixtures[1].receipt.resultId,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    "status-financial-contradiction": () =>
      new Response(
        JSON.stringify([
          {
            result: "accepted",
            delivery: "settled",
            status: "result_recorded",
            reason_code: null,
            financial_disposition: "returned",
            result_id: fixtures[1].receipt.resultId,
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    "foreign-result-id": () =>
      new Response(
        JSON.stringify([
          {
            result: "accepted",
            delivery: "settled",
            status: "result_recorded",
            reason_code: null,
            financial_disposition: "consumed",
            result_id: crypto.randomUUID(),
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    html: () =>
      new Response("<html>gateway</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    "http-429": () =>
      new Response(JSON.stringify({ message: "rate limited" }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "7" },
      }),
    "http-500": () => new Response("", { status: 500 }),
    "http-401": () => new Response(JSON.stringify({ message: "JWT expired" }), { status: 401 }),
  };
  for (const [tag, fail] of Object.entries(failures)) {
    reset();
    let calls = 0;
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      calls += 1;
      // The second entry's RPC fails; the first is durable in the stand-in.
      return calls === 2 ? fail() : durableRespond(call);
    };
    const response = await post({ receipts: entries }, user.token);
    const body = await readJson(response);
    assertEquals(response.status, 503, `${tag}: ${JSON.stringify(body)}`);
    // Generic 5xx body: no PostgREST detail, no partial receipts[] leaks out.
    assert(!("receipts" in body), `${tag}: ${JSON.stringify(body)}`);
    assert(!JSON.stringify(body).includes("JWT"), `${tag}: leaked detail`);
    assertEquals(calls, 2, `${tag}: the batch stopped at the failure`);
    // Redelivery with the database healthy: the decided entry replays, the
    // others settle now — nothing settled twice, nothing dropped.
    h.respond = durableRespond;
    const again = wire(await readJson(await post({ receipts: entries }, user.token)));
    assertEquals(again.receipts.map((r) => r.delivery), ["replayed", "settled", "settled"], tag);
    assertEquals(again.rejected, [], tag);
  }
});

// ===========================================================================
// Live postgres half — the REAL settle_offline_receipt()
// ===========================================================================

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const RUN = crypto.randomUUID().slice(0, 8);
const U = (n: number): string => `0000000c-0404-4000-8000-${RUN}00${String(n).padStart(2, "0")}`;
const SESSION = (n: number): string =>
  `0000000c-0404-4000-8000-${RUN}0a${String(n).padStart(2, "0")}`;
const KEY = (name: string): string => `${name}-atk-${RUN}`;

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

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asUser(tx as unknown as Tx, n);
    return await fn(tx as unknown as Tx);
  }) as Promise<T>;
}

const lit = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

async function settleSql(
  rec: OfflineDeviceReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
  deferNew: boolean | null = null,
): Promise<string> {
  return `select r.result, r.delivery, r.status, r.reason_code, r.financial_disposition, r.result_id
     from public.settle_offline_receipt(
       ${lit(rec)},
       '${await digestCanonicalOfflineJson(rec)}',
       ${out === null ? "null::jsonb" : lit(sqlOutput(out))},
       ${hold === null ? "null::text" : `'${hold}'`}${
    deferNew === null ? "" : `, ${deferNew ? "true" : "false"}`
  }
     ) r`;
}

async function settle(
  tx: Tx,
  rec: OfflineDeviceReceipt,
  out: Record<string, unknown> | null,
  hold: string | null,
  deferNew: boolean | null = null,
): Promise<SettleRow> {
  const rows = await tx.unsafe<SettleRow[]>(await settleSql(rec, out, hold, deferNew));
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
): Promise<
  { receipt_id: string; status: string; reason_code: string | null; ticket_id: string | null }[]
> {
  const rows = await sql.unsafe<
    { receipt_id: string; status: string; reason_code: string | null; ticket_id: string | null }[]
  >(
    `select receipt_id, status, reason_code, ticket_id from public.offline_receipt_settlements
     where user_id = '${U(n)}' order by id`,
  );
  return [...rows];
}

/** Owner-side (no JWT) shot row, as an online sync would have left it. */
async function insertShot(sql: Sql, n: number, id: string): Promise<void> {
  await sql.unsafe(
    `insert into public.shots (id, user_id, shot_type, camera_view, captured_at, start_ms, end_ms,
       overall_score, analysis_confidence, result_kind, source, app_version, model_bundle_version,
       pose_model_version, paddle_model_version, stroke_detector_version, phase_model_version,
       scoring_model_version, shot_config_version)
     values ('${id}', '${U(n)}', 'dink', 'side', now(), 0, 200, 7, 0.9, 'scored', 'real',
       '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
  );
}

/** Corrupt the store behind every trigger's back (superuser, replica mode). */
async function corrupt(sql: Sql, statement: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local session_replication_role = replica`);
    await tx.unsafe(statement);
  });
}

async function shotRows(sql: Sql, resultId: string): Promise<number> {
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

async function issueFreeGrant(
  sql: Sql,
  n: number,
  key: string,
): Promise<LiveGrant & { tickets: string[] }> {
  const issued = await issueGrant(sql, n, key, 2);
  assert(
    issued.claims.allocation && issued.claims.allocation.ticketIds.length === 2,
    JSON.stringify(issued.claims),
  );
  return { ...issued, tickets: [...issued.claims.allocation.ticketIds] };
}

async function liveReceipt(
  n: number,
  issued: LiveGrant,
  ticketId: string | null,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineDeviceReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `atk-receipt-${tag}-${RUN}`,
    ownerId: U(n),
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketId === null ? null : ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `atk-operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
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

const settledRow = (resultId: string): SettleRow => ({
  result: "accepted",
  delivery: "settled",
  status: "result_recorded",
  reason_code: null,
  financial_disposition: "consumed",
  result_id: resultId,
});

const heldRow = (reason: string, financial = "reserved"): SettleRow => ({
  result: "accepted",
  delivery: "held",
  status: "reconciliation_required",
  reason_code: reason,
  financial_disposition: financial,
  result_id: null,
});

// ===========================================================================
// D. Concurrency
// ===========================================================================

Deno.test({
  name:
    "attack D1 (live): the SAME receipt on two connections at the same instant consumes once — one settled, one replayed, one ledger event, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("d1"));
      const [ticketA] = issued.tickets;
      const { receipt: rec, output: out } = await liveReceipt(1, issued, ticketA, "d1");
      const race = await Promise.all(
        [0, 1, 2].map(() => inTx(sql, 1, (tx) => settle(tx, rec, out, null))),
      );
      const deliveries = race.map((r) => r.delivery).sort();
      assertEquals(deliveries, ["replayed", "replayed", "settled"]);
      for (const r of race) {
        assertEquals({ ...r, delivery: "settled" }, settledRow(rec.resultId));
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, rec.resultId), 1);
      assertEquals((await settlementRows(sql, 1)).length, 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack D2 (live): two DIFFERENT receipts for one ticket racing on two connections — exactly one consumes, the other is a durable conflicting_receipt HOLD, never a second shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("d2"));
      const [ticketA] = issued.tickets;
      const first = await liveReceipt(2, issued, ticketA, "d2-first");
      const second = await liveReceipt(2, issued, ticketA, "d2-second");
      const race = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, first.receipt, first.output, null)),
        inTx(sql, 2, (tx) => settle(tx, second.receipt, second.output, null)),
      ]);
      assertEquals(race.map((r) => r.delivery).sort(), ["held", "settled"]);
      const held = race.find((r) => r.delivery === "held");
      assertEquals(held, heldRow("conflicting_receipt"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(
        (await shotRows(sql, first.receipt.resultId)) +
          (await shotRows(sql, second.receipt.resultId)),
        1,
      );
      // Redelivering both: the verdicts are stable — the loser never gets a
      // second chance under a redelivery, the winner never settles twice.
      const again = await Promise.all([
        inTx(sql, 2, (tx) => settle(tx, first.receipt, first.output, null)),
        inTx(sql, 2, (tx) => settle(tx, second.receipt, second.output, null)),
      ]);
      assertEquals(again.map((r) => r.delivery), ["replayed", "replayed"]);
      assertEquals(again.map((r) => r.status).sort(), [
        "reconciliation_required",
        "result_recorded",
      ]);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 2), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack D3 (live): two accounts settling at the same instant on the same receipt-id string are isolated — each consumes its own ticket, neither sees the other's row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      await createUser(sql, 4);
      const a = await issueFreeGrant(sql, 3, KEY("d3a"));
      const b = await issueFreeGrant(sql, 4, KEY("d3b"));
      const ra = await liveReceipt(3, a, a.tickets[0], "d3-shared");
      const rb = await liveReceipt(4, b, b.tickets[0], "d3-shared");
      assertEquals(ra.receipt.receiptId, rb.receipt.receiptId);
      const [outA, outB] = await Promise.all([
        inTx(sql, 3, (tx) => settle(tx, ra.receipt, ra.output, null)),
        inTx(sql, 4, (tx) => settle(tx, rb.receipt, rb.output, null)),
      ]);
      assertEquals(outA, settledRow(ra.receipt.resultId));
      assertEquals(outB, settledRow(rb.receipt.resultId));
      assertEquals(await ledgerEvents(sql, a.tickets[0]), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, b.tickets[0]), ["allocated", "consumed"]);
      // A's redelivery of its receipt id is A's replay, not B's.
      const replayA = await inTx(sql, 3, (tx) => settle(tx, ra.receipt, ra.output, null));
      assertEquals(replayA, { ...settledRow(ra.receipt.resultId), delivery: "replayed" });
      // B presenting A's receipt body under the shared id is a CONFLICT for
      // B's own row (different digest), never a replay of A's settlement.
      const cross = await inTx(sql, 4, (tx) => settle(tx, ra.receipt, ra.output, null));
      assertEquals(cross.result, "offline.receipt_conflict");
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });
      assertEquals(await counters(sql, 4), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// E. Process death
// ===========================================================================

Deno.test({
  name:
    "attack E1 (live): the settling transaction dies after settle_offline_receipt() returned but before COMMIT — nothing durable, ticket still allocated, the redelivery settles once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 5, KEY("e1"));
      const [ticketA] = issued.tickets;
      const { receipt: rec, output: out } = await liveReceipt(5, issued, ticketA, "e1");
      const dying = inTx(sql, 5, async (tx) => {
        const row = await settle(tx, rec, out, null);
        assertEquals(row, settledRow(rec.resultId));
        // "Process death": the transaction aborts before COMMIT (PostgREST
        // runs the RPC in one transaction; a killed Edge call never commits).
        await tx.unsafe(`select 1 / 0`);
      });
      await assertRejects(() => dying, Error, "division by zero");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotRows(sql, rec.resultId), 0);
      assertEquals(await settlementRows(sql, 5), []);
      assertEquals(await counters(sql, 5), { held: 2, scored: 0 });
      // The device redelivers the identical receipt: a first-time settlement.
      const redelivered = await inTx(sql, 5, (tx) => settle(tx, rec, out, null));
      assertEquals(redelivered, settledRow(rec.resultId));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, rec.resultId), 1);
      assertEquals(await counters(sql, 5), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack E2 (live): a settler cancelled while BLOCKED on the owner lock leaves nothing behind; the lock holder's own settlement and the next redelivery are unaffected",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 5, onnotice: () => {} });
    try {
      await createUser(sql, 6);
      const issued = await issueFreeGrant(sql, 6, KEY("e2"));
      const [ticketA, ticketB] = issued.tickets;
      const first = await liveReceipt(6, issued, ticketA, "e2-first");
      const second = await liveReceipt(6, issued, ticketB, "e2-second");
      let releaseHolder: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holderReady = Promise.withResolvers<void>();
      const holder = sql.begin(async (tx) => {
        await tx.unsafe(`select pg_advisory_xact_lock(public.access_lock_key('${U(6)}'))`);
        holderReady.resolve();
        await held;
        // The holder settles its own receipt while still holding the lock.
        await asUser(tx as unknown as Tx, 6);
        const row = await settle(tx as unknown as Tx, first.receipt, first.output, null);
        assertEquals(row, settledRow(first.receipt.resultId));
      });
      await holderReady.promise;
      // The settler is cancelled while waiting on the owner lock (the Edge
      // call's statement timeout / a dead isolate): its transaction aborts.
      await assertRejects(
        () =>
          inTx(sql, 6, async (tx) => {
            await tx.unsafe(`set local lock_timeout = '300ms'`);
            return await settle(tx, second.receipt, second.output, null);
          }),
        Error,
        "lock timeout",
      );
      releaseHolder();
      await holder;
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotRows(sql, second.receipt.resultId), 0);
      const redelivered = await inTx(
        sql,
        6,
        (tx) => settle(tx, second.receipt, second.output, null),
      );
      assertEquals(redelivered, settledRow(second.receipt.resultId));
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 6), { held: 0, scored: 2 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// F. Interleaved accounts
// ===========================================================================

Deno.test({
  name:
    "attack F (live): account B presents A's receipt straight to the RPC with NO hold reason — A's ticket is untouched, B gets a durable owner_mismatch HOLD, A still settles once; B's HOLD never counts against A",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      await createUser(sql, 8);
      const a = await issueFreeGrant(sql, 7, KEY("f-a"));
      const ra = await liveReceipt(7, a, a.tickets[0], "f");
      const before = await counters(sql, 8);
      // B (the edge's owner_mismatch check bypassed): the RPC must decide itself.
      const stolen = await inTx(sql, 8, (tx) => settle(tx, ra.receipt, ra.output, null));
      assertEquals(stolen, heldRow("owner_mismatch"));
      assertEquals(await ledgerEvents(sql, a.tickets[0]), ["allocated"]);
      assertEquals(await shotRows(sql, ra.receipt.resultId), 0);
      assertEquals(await counters(sql, 8), before);
      // B also tries to release A's ticket through the ticket RPC.
      const release = await inTx(sql, 8, (tx) =>
        tx.unsafe<{ result: string }[]>(
          `select public.release_offline_ticket('${
            a.tickets[0]
          }', 'unused_ticket_returned') as result`,
        )).then((rows) => rows[0].result, (error: unknown) => `raised:${String(error)}`);
      assert(release !== "accepted", release);
      assertEquals(await ledgerEvents(sql, a.tickets[0]), ["allocated"]);
      // A settles its own receipt as a FIRST delivery (B's row is B's).
      const own = await inTx(sql, 7, (tx) => settle(tx, ra.receipt, ra.output, null));
      assertEquals(own, settledRow(ra.receipt.resultId));
      assertEquals(await ledgerEvents(sql, a.tickets[0]), ["allocated", "consumed"]);
      // B redelivering stays the same durable HOLD (no refund, no retry).
      const again = await inTx(sql, 8, (tx) => settle(tx, ra.receipt, ra.output, null));
      assertEquals(again, { ...heldRow("owner_mismatch"), delivery: "replayed" });
      assertEquals((await settlementRows(sql, 8)).map((r) => r.reason_code), ["owner_mismatch"]);
      assertEquals((await settlementRows(sql, 7)).map((r) => r.status), ["result_recorded"]);
      assertEquals(await counters(sql, 7), { held: 1, scored: 1 });
      assertEquals(await counters(sql, 8), before);
      // B cannot read A's settlement (or its own) through the table.
      await assertRejects(() =>
        inTx(sql, 8, (tx) => tx.unsafe(`select * from public.offline_receipt_settlements`))
      );
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// G. Unauthorised roles
// ===========================================================================

Deno.test({
  name:
    "attack G (live): settle_offline_receipt() refuses anon, service_role, a bearer without an active session and a caller without the API key; the table refuses every client verb; the owner with a session is allowed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueFreeGrant(sql, 9, KEY("g"));
      const { receipt: rec, output: out } = await liveReceipt(9, issued, issued.tickets[0], "g");
      const statement = await settleSql(rec, out, null);
      const denied: { label: string; prepare: (tx: Tx) => Promise<void> }[] = [
        { label: "anon", prepare: (tx) => tx.unsafe(`set local role anon`).then(() => undefined) },
        {
          label: "service_role",
          prepare: (tx) => tx.unsafe(`set local role service_role`).then(() => undefined),
        },
        { label: "no session", prepare: (tx) => asUser(tx, 9, { session: false }) },
        { label: "no api key", prepare: (tx) => asUser(tx, 9, { apiKey: false }) },
        {
          label: "authenticated without any claim",
          prepare: (tx) => tx.unsafe(`set local role authenticated`).then(() => undefined),
        },
      ];
      for (const attempt of denied) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await attempt.prepare(tx as unknown as Tx);
              await tx.unsafe(statement);
            }),
          Error,
          undefined,
          attempt.label,
        );
      }
      assertEquals(await ledgerEvents(sql, issued.tickets[0]), ["allocated"]);
      assertEquals(await settlementRows(sql, 9), []);
      // The table: no client verb at all, authenticated or anon.
      for (const role of ["authenticated", "anon", "service_role"]) {
        for (
          const verb of [
            `select count(*) from public.offline_receipt_settlements`,
            `insert into public.offline_receipt_settlements (user_id, receipt_id, receipt_sha256, owner_id, installation_key_id, grant_id, grant_jws_sha256, operation_id, result_id, full_output_sha256, billing_disposition, lifecycle_sequence, status, financial_disposition, receipt) values ('${
              U(9)
            }', 'x', '${"a".repeat(64)}', '${U(9)}', 'k', '${GRANT_ID}', '${
              "b".repeat(64)
            }', 'op', '${rec.resultId}', '${
              "c".repeat(64)
            }', 'joint_verification_required', 1, 'result_recorded', 'consumed', '{}')`,
            `update public.offline_receipt_settlements set status = 'result_recorded'`,
            `delete from public.offline_receipt_settlements`,
          ]
        ) {
          await assertRejects(
            () =>
              sql.begin(async (tx) => {
                if (role === "authenticated") await asUser(tx as unknown as Tx, 9);
                else await tx.unsafe(`set local role ${role}`);
                await tx.unsafe(verb);
              }),
            Error,
            undefined,
            `${role}: ${verb.slice(0, 40)}`,
          );
        }
      }
      // The private lease writer is not client-callable even by the owner.
      await assertRejects(() =>
        inTx(
          sql,
          9,
          (tx) =>
            tx.unsafe(`select api_private.record_offline_lease_shot('${GRANT_ID}', '{}'::jsonb)`),
        )
      );
      // ALLOWED path: the owner with an active session settles.
      const own = await inTx(sql, 9, (tx) => settle(tx, rec, out, null));
      assertEquals(own, settledRow(rec.resultId));
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// H. Free-rating conservation
// ===========================================================================

Deno.test({
  name:
    "attack H (live): lifetime_scored_count() moves exactly once per consumed ticket — replays, abstentions, evidence HOLDs, terminal-ticket HOLDs and a chargeable receipt reusing a returned ticket never charge",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("h"));
      const [ticketA, ticketB] = issued.tickets;
      assertEquals(await counters(sql, 10), { held: 2, scored: 0 });

      // A chargeable receipt WITHOUT output (evidence_missing) does not charge.
      const missing = await liveReceipt(10, issued, ticketA, "h-missing");
      assertEquals(
        await inTx(sql, 10, (tx) => settle(tx, missing.receipt, null, "evidence_missing")),
        heldRow("evidence_missing"),
      );
      assertEquals(await counters(sql, 10), { held: 2, scored: 0 });

      // The genuine rating for ticket A charges once, however often it arrives.
      const a = await liveReceipt(10, issued, ticketA, "h-a");
      assertEquals(
        await inTx(sql, 10, (tx) => settle(tx, a.receipt, a.output, null)),
        settledRow(a.receipt.resultId),
      );
      for (let i = 0; i < 4; i += 1) {
        await inTx(sql, 10, (tx) => settle(tx, a.receipt, a.output, null));
      }
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });

      // An abstention on ticket B (not_chargeable, null output): recorded,
      // nothing charged, ticket still outstanding.
      const abstain = await liveReceipt(10, issued, ticketB, "h-abstain", {
        billingDisposition: "not_chargeable",
      });
      const recorded = await inTx(sql, 10, (tx) => settle(tx, abstain.receipt, null, null));
      assertEquals(recorded.status, "result_recorded");
      assertEquals(recorded.financial_disposition, "reserved");
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);

      // The device returns ticket B; a chargeable receipt for it afterwards is
      // a conflicting_receipt HOLD — the returned ticket is never re-spent.
      const [{ result: released }] = await inTx(
        sql,
        10,
        (tx) =>
          tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketB}', 'unused_ticket_returned') as result`,
          ),
      );
      assertEquals(released, "accepted");
      // A released ticket still counts as held (documented: returning a ticket
      // is not a re-credit) — what matters here is that nothing was scored.
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });
      const late = await liveReceipt(10, issued, ticketB, "h-late");
      assertEquals(
        await inTx(sql, 10, (tx) => settle(tx, late.receipt, late.output, null)),
        heldRow("conflicting_receipt"),
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      assertEquals(await shotRows(sql, late.receipt.resultId), 0);
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });

      // A contradictory abstention (not_chargeable + scored output) HOLDs.
      const contradictory = await liveReceipt(10, issued, ticketA, "h-contra", {
        billingDisposition: "not_chargeable",
      });
      assertEquals(
        (await inTx(sql, 10, (tx) => settle(tx, contradictory.receipt, contradictory.output, null)))
          .delivery,
        "held",
      );
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });
      // access_state() agrees with the ledger: one rating spent.
      const [state] = await inTx(
        sql,
        10,
        (tx) =>
          tx.unsafe<{ scored_count: number; premium: boolean }[]>(
            `select s.scored_count, s.premium from public.access_state() s`,
          ),
      );
      assertEquals(Number(state.scored_count), 1, JSON.stringify(state));
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// I. Corrupt / partial persisted state
// ===========================================================================

Deno.test({
  name:
    "attack I1 (live): the settlement row vanishes after the ticket was consumed — the redelivered receipt is a conflicting_receipt HOLD, never a second consumption or a second shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 11);
      const issued = await issueFreeGrant(sql, 11, KEY("i1"));
      const [ticketA] = issued.tickets;
      const a = await liveReceipt(11, issued, ticketA, "i1");
      assertEquals(
        await inTx(sql, 11, (tx) => settle(tx, a.receipt, a.output, null)),
        settledRow(a.receipt.resultId),
      );
      await corrupt(
        sql,
        `delete from public.offline_receipt_settlements where user_id = '${U(11)}'`,
      );
      const again = await inTx(sql, 11, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(again, heldRow("conflicting_receipt"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, a.receipt.resultId), 1);
      assertEquals(await counters(sql, 11), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I2 (live): the rating already exists in shots (synced online) — the offline receipt for the same result HOLDs, the ticket stays allocated, the count does not double",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 12);
      const issued = await issueFreeGrant(sql, 12, KEY("i2"));
      const [ticketA] = issued.tickets;
      const a = await liveReceipt(12, issued, ticketA, "i2");
      // Owner-side write (no JWT): the rating landed through another path.
      await insertShot(sql, 12, a.receipt.resultId);
      const before = await counters(sql, 12);
      assertEquals(before.scored, 1);
      const verdict = await inTx(sql, 12, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(verdict, heldRow("conflicting_receipt"));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotRows(sql, a.receipt.resultId), 1);
      assertEquals(await counters(sql, 12), { held: 2, scored: 1 });
      // A second receipt naming the SAME result id under the other ticket is
      // a conflict too (one result, one receipt).
      const twin = await liveReceipt(12, issued, issued.tickets[1], "i2-twin", {
        resultId: a.receipt.resultId,
      });
      assertEquals(
        (await inTx(sql, 12, (tx) => settle(tx, twin.receipt, twin.output, null))).reason_code,
        "conflicting_receipt",
      );
      assertEquals(await ledgerEvents(sql, issued.tickets[1]), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I3 (live): the ticket was released behind the device's back while it was offline — the delayed chargeable receipt HOLDs and the released ticket is never re-spent (allocation != consumption, no auto-reclaim)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 13);
      const issued = await issueFreeGrant(sql, 13, KEY("i3"));
      const [ticketA, ticketB] = issued.tickets;
      const [{ result }] = await inTx(
        sql,
        13,
        (tx) =>
          tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as result`,
          ),
      );
      assertEquals(result, "accepted");
      const a = await liveReceipt(13, issued, ticketA, "i3");
      assertEquals(
        await inTx(sql, 13, (tx) => settle(tx, a.receipt, a.output, null)),
        heldRow("conflicting_receipt"),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "released"]);
      assertEquals(await shotRows(sql, a.receipt.resultId), 0);
      // The other ticket, untouched for the whole test, is still reserved:
      // nothing reclaimed it.
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 13), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I4 (live): a receipt from an installation support REVOKED after the work was done — the RPC's verdict is durable and consistent under redelivery; whatever it decides never charges twice",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 14);
      const issued = await issueFreeGrant(sql, 14, KEY("i4"));
      const [ticketA] = issued.tickets;
      await sql.unsafe(
        `update public.offline_devices set revoked_at = now() where user_id = '${U(14)}'`,
      );
      const a = await liveReceipt(14, issued, ticketA, "i4");
      const first = await inTx(sql, 14, (tx) => settle(tx, a.receipt, a.output, null));
      assert(first.delivery === "settled" || first.delivery === "held", JSON.stringify(first));
      const again = await inTx(sql, 14, (tx) => settle(tx, a.receipt, a.output, null));
      assertEquals(again, { ...first, delivery: "replayed" });
      const events = await ledgerEvents(sql, ticketA);
      assertEquals(
        events.filter((e) => e === "consumed").length,
        first.delivery === "settled" ? 1 : 0,
      );
      assertEquals(await shotRows(sql, a.receipt.resultId), first.delivery === "settled" ? 1 : 0);
      // RECORDED for the report: what the candidate decides for a revoked device.
      console.log(
        `[attack I4] revoked-installation receipt → ${first.delivery}/${first.status}/${first.reason_code}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I5 (live): an EXPIRED grant row (device offline longer than the lease) still settles its ticket exactly once — consumption is judged by the ledger, not the clock",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 15);
      const issued = await issueFreeGrant(sql, 15, KEY("i5"));
      const [ticketA] = issued.tickets;
      // Grants are trigger-immutable: age the grant and its allocation behind
      // the trigger so the lease expired a month ago.
      await corrupt(
        sql,
        `update public.offline_grants
           set issued_at = issued_at - interval '40 days', expires_at = expires_at - interval '40 days'
         where user_id = '${U(15)}'`,
      );
      await corrupt(
        sql,
        `update public.offline_allocation_ledger set created_at = created_at - interval '40 days'
         where user_id = '${U(15)}'`,
      );
      const a = await liveReceipt(15, issued, ticketA, "i5");
      assertEquals(
        await inTx(sql, 15, (tx) => settle(tx, a.receipt, a.output, null)),
        settledRow(a.receipt.resultId),
      );
      assertEquals(
        await inTx(sql, 15, (tx) => settle(tx, a.receipt, a.output, null)),
        { ...settledRow(a.receipt.resultId), delivery: "replayed" },
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I6 (live): a Pro lease receipt delivered after the subscription LAPSED (entitlement expired, 3 free ratings already spent) is still recorded once — the entitlement was verified at issuance and the allowance never applies to a lease",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 16);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
         values ('${U(16)}', true, now() + interval '30 days')`,
      );
      const lease = await issueGrant(sql, 16, KEY("i6"), 0);
      assertEquals(lease.claims.entitlementSource, "verified_store");
      // The subscription lapses; the user also has scored ratings on record.
      await sql.unsafe(
        `update public.billing_entitlements set expires_at = now() - interval '1 day' where user_id = '${
          U(16)
        }'`,
      );
      for (let i = 0; i < 3; i += 1) await insertShot(sql, 16, crypto.randomUUID());
      const before = await counters(sql, 16);
      assertEquals(before.scored, 3);
      const r = await liveReceipt(16, lease, null, "i6");
      const first = await inTx(sql, 16, (tx) => settle(tx, r.receipt, r.output, null));
      assertEquals(first, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "not_applicable",
        result_id: r.receipt.resultId,
      });
      assertEquals(await shotRows(sql, r.receipt.resultId), 1);
      const again = await inTx(sql, 16, (tx) => settle(tx, r.receipt, r.output, null));
      assertEquals(again, { ...first, delivery: "replayed" });
      assertEquals(await shotRows(sql, r.receipt.resultId), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack I7 (live): a receipt naming a session that NEVER syncs stays pending (nothing durable, ticket reserved) across many redeliveries and settles once the session lands",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 17);
      const issued = await issueFreeGrant(sql, 17, KEY("i7"));
      const [ticketA] = issued.tickets;
      const sessionId = crypto.randomUUID();
      const a = await liveReceipt(17, issued, ticketA, "i7", {}, { sessionId });
      for (let i = 0; i < 5; i += 1) {
        const row = await inTx(sql, 17, (tx) => settle(tx, a.receipt, a.output, null));
        assertEquals(row.delivery, "pending");
        assertEquals(row.financial_disposition, "reserved");
      }
      assertEquals(await settlementRows(sql, 17), []);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await counters(sql, 17), { held: 2, scored: 0 });
      // A session owned by ANOTHER account with that id does not count.
      await createUser(sql, 18);
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${
          U(18)
        }', now())`,
      );
      assertEquals(
        (await inTx(sql, 17, (tx) => settle(tx, a.receipt, a.output, null))).delivery,
        "pending",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      // The owner's session lands: the identical redelivery settles once.
      await sql.unsafe(`delete from public.sessions where id = '${sessionId}'`);
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${
          U(17)
        }', now())`,
      );
      assertEquals(
        await inTx(sql, 17, (tx) => settle(tx, a.receipt, a.output, null)),
        settledRow(a.receipt.resultId),
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// J. Clock rollback
// ===========================================================================

Deno.test({
  name:
    "attack J (live): a receipt whose queuedAt predates its grant (device clock rolled back) and one queued in the far future both settle once — the digest binds the receipt, the clock is evidence only",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 19);
      const issued = await issueFreeGrant(sql, 19, KEY("j"));
      const [ticketA, ticketB] = issued.tickets;
      const past = await liveReceipt(19, issued, ticketA, "j-past", {
        queuedAt: "2001-01-01T00:00:00.000Z",
      });
      const future = await liveReceipt(19, issued, ticketB, "j-future", {
        queuedAt: "9999-12-31T23:59:59.999Z",
      });
      assertEquals(
        await inTx(sql, 19, (tx) => settle(tx, past.receipt, past.output, null)),
        settledRow(past.receipt.resultId),
      );
      assertEquals(
        await inTx(sql, 19, (tx) => settle(tx, future.receipt, future.output, null)),
        settledRow(future.receipt.resultId),
      );
      // A rollback that re-stamps the SAME receipt with another queuedAt is a
      // different digest under the same id: a conflict, never a second charge.
      const restamped = { ...past.receipt, queuedAt: "2026-09-08T12:00:00.000Z" };
      const conflict = await inTx(sql, 19, (tx) => settle(tx, restamped, past.output, null));
      assertEquals(conflict.result, "offline.receipt_conflict");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 19), { held: 0, scored: 2 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// L. Reversible freeze (p_defer_new) ordering
// ===========================================================================

Deno.test({
  name:
    "attack L1 (live): under a reversible freeze, durable replays / HOLD replays / same-id-different-digest conflicts are decided BEFORE the freeze short-circuit; only the genuinely new chargeable receipt answers pending — nothing durable, ticket still reserved — and repeated frozen redeliveries never consume or write",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 20);
      const issued = await issueFreeGrant(sql, 20, KEY("l1"));
      const [ticketA, ticketB] = issued.tickets;
      const a = await liveReceipt(20, issued, ticketA, "l1-a");
      const b = await liveReceipt(20, issued, ticketB, "l1-b");
      // Before the freeze: A settles, B is a durable evidence_missing HOLD.
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, a.receipt, a.output, null)),
        settledRow(a.receipt.resultId),
      );
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, b.receipt, null, null)),
        heldRow("evidence_missing"),
      );
      // Freeze on: the durable verdicts replay (never pending).
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, a.receipt, a.output, null, true)),
        { ...settledRow(a.receipt.resultId), delivery: "replayed" },
      );
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, b.receipt, null, null, true)),
        { ...heldRow("evidence_missing"), delivery: "replayed" },
      );
      // Same id, different digest under the freeze: a conflict, not pending.
      const restamped = { ...a.receipt, queuedAt: "2026-09-09T00:00:00.000Z" };
      const conflict = await inTx(sql, 20, (tx) => settle(tx, restamped, a.output, null, true));
      assertEquals(conflict.result, "offline.receipt_conflict");
      assertEquals(conflict.delivery, null);
      // The HELD receipt's ticket B is still outstanding; a NEW chargeable
      // receipt for it under the freeze is pending — nothing durable.
      const fresh = await liveReceipt(20, issued, ticketB, "l1-fresh");
      for (let i = 0; i < 5; i += 1) {
        assertEquals(
          await inTx(sql, 20, (tx) => settle(tx, fresh.receipt, fresh.output, null, true)),
          {
            result: "accepted",
            delivery: "pending",
            status: "pending",
            reason_code: null,
            financial_disposition: "reserved",
            result_id: null,
          },
        );
      }
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await shotRows(sql, fresh.receipt.resultId), 0);
      assertEquals(
        (await settlementRows(sql, 20)).map((r) => r.receipt_id),
        [a.receipt.receiptId, b.receipt.receiptId],
      );
      assertEquals(await counters(sql, 20), { held: 1, scored: 1 });
      // A frozen pending receipt whose ticket is meanwhile RELEASED becomes a
      // durable conflicting_receipt HOLD even under the freeze (terminal
      // ledger state is decided before the freeze).
      const released = await inTx(
        sql,
        20,
        (tx) =>
          tx.unsafe<{ result: string }[]>(
            `select public.release_offline_ticket('${ticketB}', 'unused_ticket_returned') as result`,
          ),
      );
      assertEquals(released[0].result, "accepted");
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, fresh.receipt, fresh.output, null, true)),
        heldRow("conflicting_receipt"),
      );
      assertEquals(
        await inTx(sql, 20, (tx) => settle(tx, fresh.receipt, fresh.output, null, false)),
        { ...heldRow("conflicting_receipt"), delivery: "replayed" },
      );
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "released"]);
      assertEquals(await counters(sql, 20), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "attack L2 (live): a frozen-pending chargeable receipt settles EXACTLY once when the freeze lifts, and a not_chargeable abstention or a Pro lease receipt under the freeze follows the same rule (abstention recorded durably, lease pending then recorded once)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3, onnotice: () => {} });
    try {
      await createUser(sql, 21);
      const issued = await issueFreeGrant(sql, 21, KEY("l2"));
      const [ticketA, ticketB] = issued.tickets;
      const a = await liveReceipt(21, issued, ticketA, "l2-a");
      const pendingRow: SettleRow = {
        result: "accepted",
        delivery: "pending",
        status: "pending",
        reason_code: null,
        financial_disposition: "reserved",
        result_id: null,
      };
      assertEquals(
        await inTx(sql, 21, (tx) => settle(tx, a.receipt, a.output, null, true)),
        pendingRow,
      );
      // Freeze lifts: the identical redelivery settles once, then replays.
      assertEquals(
        await inTx(sql, 21, (tx) => settle(tx, a.receipt, a.output, null, false)),
        settledRow(a.receipt.resultId),
      );
      assertEquals(
        await inTx(sql, 21, (tx) => settle(tx, a.receipt, a.output, null, true)),
        { ...settledRow(a.receipt.resultId), delivery: "replayed" },
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotRows(sql, a.receipt.resultId), 1);
      // An abstention under the freeze is not chargeable: recorded durably,
      // ticket left outstanding, nothing consumed.
      const abstain = await liveReceipt(21, issued, ticketB, "l2-abstain", {
        billingDisposition: "not_chargeable",
      });
      const recorded = await inTx(
        sql,
        21,
        (tx) => settle(tx, abstain.receipt, null, null, true),
      );
      assertEquals(recorded, {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "reserved",
        result_id: abstain.receipt.resultId,
      });
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 21), { held: 1, scored: 1 });

      // Pro lease under the freeze: pending, nothing written; recorded once
      // after the freeze; replayed thereafter.
      await createUser(sql, 22);
      await sql.unsafe(
        `insert into public.billing_entitlements (user_id, premium, expires_at)
         values ('${U(22)}', true, now() + interval '30 days')`,
      );
      const lease = await issueGrant(sql, 22, KEY("l2-lease"), 0);
      const r = await liveReceipt(22, lease, null, "l2-lease");
      const leasePending: SettleRow = { ...pendingRow, financial_disposition: "not_applicable" };
      assertEquals(
        await inTx(sql, 22, (tx) => settle(tx, r.receipt, r.output, null, true)),
        leasePending,
      );
      assertEquals(await shotRows(sql, r.receipt.resultId), 0);
      assertEquals(await settlementRows(sql, 22), []);
      const leaseSettled: SettleRow = {
        result: "accepted",
        delivery: "settled",
        status: "result_recorded",
        reason_code: null,
        financial_disposition: "not_applicable",
        result_id: r.receipt.resultId,
      };
      assertEquals(
        await inTx(sql, 22, (tx) => settle(tx, r.receipt, r.output, null, false)),
        leaseSettled,
      );
      assertEquals(
        await inTx(sql, 22, (tx) => settle(tx, r.receipt, r.output, null, true)),
        { ...leaseSettled, delivery: "replayed" },
      );
      assertEquals(await shotRows(sql, r.receipt.resultId), 1);
    } finally {
      await sql.end();
    }
  },
});
