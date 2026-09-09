// W04-04 ADVERSARIAL ATTACKS against candidate 14c0f7e846cecd817219aae3b12220f79c31ac1a
// (branch devin/pp/w04-04/impl-r3) — POST /v1/offline/receipts + settle_offline_receipt().
//
// Every test here is an attack at a failure boundary the candidate's own suite
// does not exercise. A test that PASSES means the attack did not break the
// candidate; a test that FAILS is a confirmed break (reported with its
// severity in the attack report). Nothing in the candidate's production code
// or its own test file is modified by this file.
//
// Two halves, like the candidate suite:
//   * the REAL edge handler through routesHarness with a durable in-memory
//     settlement stand-in that mirrors the migration (crash between steps,
//     network failure at each hop, boundary values, contradictory Pro
//     evidence, poisoned first delivery, max-size batches);
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with every
//     migration applied (XC_PG_URL / PICKLE_AUDIT_PG_URL): true concurrency
//     over separate connections (same receipt, different receipts for one
//     ticket, one operation across two tickets, settle vs release),
//     cross-account delivery, role matrix, foreign-session pending, Pro
//     contradictory evidence.
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a
// pass.

import postgres from "postgres";
import { assert, assertEquals, assertMatch, assertRejects } from "@std/assert";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
  OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
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
const ACTIVE_POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-444444444444";
const TICKET_A = "65555555-5555-4555-8555-555555555551";
const TICKET_B = "65555555-5555-4555-8555-555555555552";
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
function freshUser(): { sub: string; token: string } {
  userSeq += 1;
  return {
    sub: `aaaaaaaa-0404-4000-8000-a7${String(userSeq).padStart(10, "0")}`,
    token: fakeGoogleIdToken(`aaaaaaaa-0404-4000-8000-a7${String(userSeq).padStart(10, "0")}`),
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
  ticketId: string,
  n: number,
  shared?: { claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant },
): Promise<Fixture> {
  const claims = shared?.claims ?? freeClaims(ownerId);
  const grant = shared?.grant ?? (await sign(claims));
  const resultId = `7${String(n).padStart(7, "0")}-0404-4000-8000-${String(n).padStart(12, "0")}`;
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
// Durable RPC stand-in mirroring settle_offline_receipt() (same rules as the
// candidate suite's stand-in) plus the consumption ledger the attacks audit:
// how many times each ticket was consumed, whatever the route reported.
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
const consumedTickets = new Map<string, number>();
const syncedSessions = new Set<string>();

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function rowResponse(row: SettleRow): Response {
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
  let row: SettleRow;
  const ticket = params.p_receipt.ticket as { ticketId?: string } | null;
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
  } else if (
    params.p_hold_reason !== null ||
    (ticket !== null &&
      params.p_receipt.billingDisposition === "not_chargeable" &&
      params.p_output !== null &&
      params.p_output.resultKind === "scored")
  ) {
    row = {
      result: "accepted",
      delivery: "held",
      status: "reconciliation_required",
      reason_code: params.p_hold_reason ?? "evidence_ambiguous",
      financial_disposition: ticket === null ? "not_applicable" : "reserved",
      result_id: null,
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  } else if (
    ticket !== null &&
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
    const consumes =
      ticket !== null && params.p_receipt.billingDisposition === "joint_verification_required";
    if (consumes && ticket?.ticketId) {
      consumedTickets.set(ticket.ticketId, (consumedTickets.get(ticket.ticketId) ?? 0) + 1);
    }
    row = {
      result: "accepted",
      delivery: "settled",
      status: "result_recorded",
      reason_code: null,
      financial_disposition:
        ticket === null ? "not_applicable" : consumes ? "consumed" : "reserved",
      result_id: String(params.p_receipt.resultId),
    };
    durable.set(key, { sha256: params.p_receipt_sha256, row });
  }
  return rowResponse(row);
}

function reset(): void {
  h.reset();
  durable.clear();
  consumedTickets.clear();
  syncedSessions.clear();
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
  delivery: "settled" | "replayed" | "held" | "pending" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  assertEquals(response.status, 200, await response.clone().text());
  const body = await readJson(response);
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

function entry(f: Fixture): { receipt: unknown; grant: unknown; output: unknown } {
  return { receipt: f.receipt, grant: f.grant, output: f.output };
}

/** A generic 503 whose body leaks no detail; the failure went to the logs. */
async function assertGeneric503(response: Response): Promise<void> {
  assertEquals(response.status, 503);
  const body = await readJson(response);
  const message = (body.error as { message: string }).message;
  assert(!/XX000|injected|redirect|html|ECONN|TypeError/i.test(message), message);
}

// ===========================================================================
// ATTACK A1 — crash between steps: the database fails AFTER the first entry of
// a batch settled. The batch is a 503; the identical redelivery must replay
// entry 1 and settle entry 2 — exactly one consumption per ticket overall, and
// the ticket the failed entry names is not consumed by the failed attempt.
// ===========================================================================
Deno.test(
  "A1 crash mid-batch: entry 1 settled, entry 2's RPC fails → 503; redelivery replays 1 and settles 2 exactly once",
  async () => {
    reset();
    const user = freshUser();
    const one = await fixture(user.sub, TICKET_A, 1);
    const two = await fixture(user.sub, TICKET_B, 2, one);
    let settleSeen = 0;
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      settleSeen += 1;
      if (settleSeen === 2) {
        return new Response(JSON.stringify({ code: "XX000", message: "injected crash" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return durableRespond(call);
    };
    const { result: crashed } = await captureConsole(() =>
      post({ receipts: [entry(one), entry(two)] }, user.token),
    );
    await assertGeneric503(crashed);
    assertEquals(consumedTickets.get(TICKET_A), 1);
    assertEquals(consumedTickets.get(TICKET_B), undefined);

    h.respond = durableRespond;
    const again = await results(await post({ receipts: [entry(one), entry(two)] }, user.token));
    assertEquals(
      again.map((r) => [r.receiptId, r.delivery]),
      [
        ["receipt-1", "replayed"],
        ["receipt-2", "settled"],
      ],
    );
    assertEquals(consumedTickets.get(TICKET_A), 1);
    assertEquals(consumedTickets.get(TICKET_B), 1);

    // Third delivery, reversed order: both replay, nothing consumed again.
    const third = await results(await post({ receipts: [entry(two), entry(one)] }, user.token));
    assertEquals(
      third.map((r) => r.delivery),
      ["replayed", "replayed"],
    );
    assertEquals([...consumedTickets.values()], [1, 1]);
  },
);

// ===========================================================================
// ATTACK A2 — network failure at each hop: the PostgREST hop answers a
// redirect, an HTML gateway error, a thrown transport error, an empty row set,
// two rows, or a row that names ANOTHER result. None may be reported as
// settled/held/pending; each is a generic 503 and the ticket is consumed by
// the eventual clean redelivery exactly once. The active-authority read
// failing the same ways decides nothing (no settle call at all).
// ===========================================================================
Deno.test(
  "A2 transport faults on the settle hop (302, HTML 502, thrown fetch error, 0 rows, 2 rows, foreign result row) are 503 and never a verdict",
  async () => {
    reset();
    const user = freshUser();
    const one = await fixture(user.sub, TICKET_A, 1);
    const faults: Array<[string, (call: RecordedCall) => Response]> = [
      [
        "302 redirect",
        () =>
          new Response(null, {
            status: 302,
            headers: { Location: "https://attacker.example/rest/v1/rpc/settle_offline_receipt" },
          }),
      ],
      [
        "HTML 502",
        () =>
          new Response("<html><body>502 Bad Gateway</body></html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
      ],
      [
        "thrown transport error",
        () => {
          throw new TypeError("error sending request: ECONNRESET");
        },
      ],
      ["0 rows", () => new Response("[]", { status: 200 })],
      [
        "2 rows",
        () => {
          const row = JSON.parse(String(rowResponseBody(one)));
          return new Response(JSON.stringify([row, row]), { status: 200 });
        },
      ],
      [
        "row naming another result",
        () =>
          rowResponse({
            result: "accepted",
            delivery: "settled",
            status: "result_recorded",
            reason_code: null,
            financial_disposition: "consumed",
            result_id: "70000099-0404-4000-8000-000000000099",
          }),
      ],
      [
        "row with an unknown delivery",
        () =>
          rowResponse({
            result: "accepted",
            delivery: "refunded",
            status: "result_recorded",
            reason_code: null,
            financial_disposition: "consumed",
            result_id: String(one.receipt.resultId),
          }),
      ],
    ];
    for (const [name, fault] of faults) {
      h.respond = (call) => (call.url.endsWith(SETTLE_RPC) ? fault(call) : null);
      const { result: response } = await captureConsole(() =>
        post({ receipts: [entry(one)] }, user.token),
      );
      assertEquals(response.status, 503, `${name}: expected 503, got ${response.status}`);
      await assertGeneric503(response);
    }
    // Same faults on the active-authority read: 503 before any settle call.
    for (const [name, fault] of faults.slice(0, 3)) {
      h.respond = (call) => (call.url.endsWith(ACTIVE_POLICY_RPC) ? fault(call) : null);
      const before = settleCalls().length;
      const { result: response } = await captureConsole(() =>
        post({ receipts: [entry(one)] }, user.token),
      );
      assertEquals(response.status, 503, `authority ${name}: expected 503`);
      assertEquals(settleCalls().length, before, `authority ${name}: settle must not be called`);
    }
    assertEquals(consumedTickets.size, 0);

    h.respond = durableRespond;
    const clean = await results(await post({ receipts: [entry(one)] }, user.token));
    assertEquals(clean[0].delivery, "settled");
    assertEquals(consumedTickets.get(TICKET_A), 1);
  },
);

function rowResponseBody(f: Fixture): string {
  return JSON.stringify({
    result: "accepted",
    delivery: "settled",
    status: "result_recorded",
    reason_code: null,
    financial_disposition: "consumed",
    result_id: f.receipt.resultId,
  });
}

// ===========================================================================
// ATTACK A3 — boundary values the shared-types validator must refuse BEFORE
// the database (no RPC call, `rejected`), plus the batch extremes: 25 distinct
// receipts settle exactly once each; 25 copies of one receipt settle once and
// replay 24 times; a 2 MB body is refused.
// ===========================================================================
Deno.test(
  "A3 boundaries: malformed numerics/identifiers are rejected without an RPC call; a max batch settles each ticket once; 25 duplicates consume once",
  async () => {
    reset();
    const user = freshUser();
    const base = await fixture(user.sub, TICKET_A, 1);
    const ticket = base.receipt.ticket;
    assert(ticket);
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["lifecycleSequence 0", { lifecycleSequence: 0 }],
      ["lifecycleSequence -1", { lifecycleSequence: -1 }],
      ["lifecycleSequence 1.5", { lifecycleSequence: 1.5 }],
      ["lifecycleSequence 2^53", { lifecycleSequence: 2 ** 53 }],
      ["lifecycleSequence string", { lifecycleSequence: "1" }],
      ["lifecycleSequence null", { lifecycleSequence: null }],
      ["generation 0", { ticket: { ...ticket, generation: 0 } }],
      ["generation -0", { ticket: { ...ticket, generation: -0 } }],
      ["generation 1.5", { ticket: { ...ticket, generation: 1.5 } }],
      ["generation 2^53", { ticket: { ...ticket, generation: 2 ** 53 } }],
      ["generation string", { ticket: { ...ticket, generation: "3" } }],
      ["ticket undefined", { ticket: undefined }],
      ["ticket array", { ticket: [] }],
      ["receiptId 129 chars", { receiptId: "r".repeat(129) }],
      ["receiptId empty", { receiptId: "" }],
      ["receiptId with space", { receiptId: "receipt 1" }],
      ["ownerId uppercase", { ownerId: user.sub.toUpperCase() }],
      ["ownerId nil uuid", { ownerId: "00000000-0000-0000-0000-000000000000" }],
      ["grantJwsSha256 uppercase", { grantJwsSha256: base.receipt.grantJwsSha256.toUpperCase() }],
      ["fullOutputSha256 63 chars", { fullOutputSha256: "a".repeat(63) }],
      ["billingDisposition refund", { billingDisposition: "refund" }],
      ["schemaVersion 0", { schemaVersion: 0 }],
      ["extra field", { refund: true }],
      ["nativeTime elapsedMs -1", { nativeTime: { ...base.receipt.nativeTime, elapsedMs: -1 } }],
      ["nativeTime elapsedMs 1.5", { nativeTime: { ...base.receipt.nativeTime, elapsedMs: 1.5 } }],
      [
        "nativeTime elapsedMs 2^53",
        { nativeTime: { ...base.receipt.nativeTime, elapsedMs: 2 ** 53 } },
      ],
      [
        "attestation kind attestation",
        { attestation: { ...base.receipt.attestation, kind: "attestation" } },
      ],
      ["__proto__ key", JSON.parse('{"__proto__":{"polluted":true}}')],
    ];
    const receipts = malformed.map(([, patch]) => ({
      receipt: { ...base.receipt, ...patch },
      grant: base.grant,
      output: base.output,
    }));
    // 28 entries > 25: split into two batches.
    const outA = await results(await post({ receipts: receipts.slice(0, 25) }, user.token));
    const outB = await results(await post({ receipts: receipts.slice(25) }, user.token));
    const out = [...outA, ...outB];
    for (let i = 0; i < malformed.length; i += 1) {
      assertEquals(out[i].delivery, "rejected", `${malformed[i][0]} must be rejected`);
      assertEquals(out[i].error?.code, "offline.invalid_input", malformed[i][0]);
    }
    assertEquals(settleCalls().length, 0, "no malformed receipt may reach the database");
    assertEquals(consumedTickets.size, 0);

    // Max batch: 25 distinct receipts for 25 distinct tickets across 13 grants
    // (a free grant carries at most two tickets).
    reset();
    const tickets = Array.from(
      { length: 26 },
      (_, i) => `65555555-5555-4555-8555-${String(i + 100).padStart(12, "0")}`,
    );
    const grants: Array<{
      claims: OfflineExecutionGrantClaims;
      grant: OfflineSignedExecutionGrant;
    }> = [];
    for (let g = 0; g < 13; g += 1) {
      const claims = freeClaims(user.sub, {
        grantId: `6444444${g.toString(16)}-4444-4444-8444-${String(g).padStart(12, "0")}`,
        tickets: [tickets[2 * g], tickets[2 * g + 1]],
      });
      grants.push({ claims, grant: await sign(claims) });
    }
    const fixtures: Fixture[] = [];
    for (let i = 0; i < 25; i += 1) {
      fixtures.push(await fixture(user.sub, tickets[i], i + 10, grants[Math.floor(i / 2)]));
    }
    const { claims, grant } = grants[0];
    const max = await results(await post({ receipts: fixtures.map(entry) }, user.token));
    assertEquals(max.length, 25);
    assertEquals(new Set(max.map((r) => r.delivery)), new Set(["settled"]));
    assertEquals(settleCalls().length, 25);
    for (const t of tickets.slice(0, 25)) assertEquals(consumedTickets.get(t), 1, t);

    // 25 copies of one NEW receipt inside one batch: settled once, replayed 24 times.
    const dup = await fixture(user.sub, tickets[0], 99, { claims, grant });
    const dups = await results(
      await post({ receipts: Array.from({ length: 25 }, () => entry(dup)) }, user.token),
    );
    assertEquals(dups.filter((r) => r.delivery === "settled").length, 1);
    assertEquals(dups.filter((r) => r.delivery === "replayed").length, 24);
    assertEquals(
      consumedTickets.get(tickets[0]),
      2,
      "the stand-in consumed a second time as asked",
    );

    // 26 entries and a body over the 2 MB cap are refused with no RPC call.
    reset();
    const twentySix = await post(
      { receipts: Array.from({ length: 26 }, () => entry(dup)) },
      user.token,
    );
    assertEquals(twentySix.status, 400);
    const huge = await post(
      { receipts: [{ ...entry(dup), output: { ...dup.output, pad: "x".repeat(2_000_001) } }] },
      user.token,
    );
    assert(huge.status === 400 || huge.status === 413, `got ${huge.status}`);
    assertEquals(settleCalls().length, 0);
  },
);

// ===========================================================================
// ATTACK A4 — replay & poisoned identities: a receipt first delivered with a
// corrupt output is HELD durably; the corrected redelivery replays the hold
// (never a late consumption); a receipt settled once then redelivered with a
// different output replays the settlement (the receipt is the identity); the
// same receipt id under two different bodies is a conflict for the second
// and the first verdict stands.
// ===========================================================================
Deno.test(
  "A4 replay identities: corrupt-first-delivery hold is durable against the corrected redelivery; settled-first replays against a corrupt redelivery",
  async () => {
    reset();
    const user = freshUser();
    const one = await fixture(user.sub, TICKET_A, 1);
    const corrupt = { ...one.output, overallScore: 9 };
    const first = await results(
      await post({ receipts: [{ ...entry(one), output: corrupt }] }, user.token),
    );
    assertEquals(first[0].delivery, "held");
    assertEquals(first[0].reconciliation?.reasonCode, "evidence_ambiguous");
    const corrected = await results(await post({ receipts: [entry(one)] }, user.token));
    assertEquals(corrected[0].delivery, "replayed");
    assertEquals(corrected[0].reconciliation?.status, "reconciliation_required");
    assertEquals(consumedTickets.get(TICKET_A), undefined, "a held receipt never consumes later");

    const two = await fixture(user.sub, TICKET_B, 2, one);
    const settled = await results(await post({ receipts: [entry(two)] }, user.token));
    assertEquals(settled[0].delivery, "settled");
    const corruptLater = await results(
      await post(
        { receipts: [{ ...entry(two), output: { ...two.output, overallScore: 1 } }] },
        user.token,
      ),
    );
    assertEquals(corruptLater[0].delivery, "replayed");
    assertEquals(corruptLater[0].reconciliation?.status, "result_recorded");
    assertEquals(consumedTickets.get(TICKET_B), 1);

    // Same receipt id, another body (a new resultId): conflict, first verdict stands.
    const forgedOut = output("70000077-0404-4000-8000-000000000077");
    const forged = {
      ...two.receipt,
      resultId: "70000077-0404-4000-8000-000000000077",
      fullOutputSha256: await digestCanonicalOfflineJson(forgedOut),
    };
    const conflict = await results(
      await post(
        { receipts: [{ receipt: forged, grant: two.grant, output: forgedOut }] },
        user.token,
      ),
    );
    assertEquals(conflict[0].delivery, "rejected");
    assertEquals(conflict[0].error?.code, "offline.receipt_conflict");
    assertEquals(consumedTickets.get(TICKET_B), 1);
  },
);

// ===========================================================================
// ATTACK A5 — contradictory evidence on the Pro (no-ticket) path. The
// migration holds a ticketed not_chargeable receipt beside a scored output
// (L4b) but the `v_ticket_id is null` branch records ANY output beside ANY
// billing disposition. The invariant says ambiguous evidence HOLDs.
// Expected: held / evidence_ambiguous. (Stand-in mirrors the migration: it
// records the Pro contradiction, so this test fails iff the route also lets
// it through — the route derives no hold for it.)
// ===========================================================================
Deno.test(
  "A5 Pro contradictory evidence: not_chargeable receipt + scored output, and chargeable receipt + abstention output, must HOLD not record",
  async () => {
    reset();
    const user = freshUser();
    const claims = proClaims(user.sub);
    const grant = await sign(claims);
    const scoredOut = output("70000011-0404-4000-8000-000000000011");
    const abstainSaysReceipt = await receipt({
      receiptId: "receipt-pro-contra-1",
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: 1,
      operationId: "operation-pro-contra-1",
      resultId: "70000011-0404-4000-8000-000000000011",
      fullOutputSha256: await digestCanonicalOfflineJson(scoredOut),
      billingDisposition: "not_chargeable",
    });
    const abstainOut = output("70000012-0404-4000-8000-000000000012", {
      resultKind: "low_confidence",
      overallScore: null,
    });
    const chargeableSaysReceipt = await receipt({
      receiptId: "receipt-pro-contra-2",
      ownerId: user.sub,
      grant,
      claims,
      ticket: null,
      lifecycleSequence: 2,
      operationId: "operation-pro-contra-2",
      resultId: "70000012-0404-4000-8000-000000000012",
      fullOutputSha256: await digestCanonicalOfflineJson(abstainOut),
    });
    const out = await results(
      await post(
        {
          receipts: [
            { receipt: abstainSaysReceipt, grant, output: scoredOut },
            { receipt: chargeableSaysReceipt, grant, output: abstainOut },
          ],
        },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.delivery, r.reconciliation?.status]),
      [
        ["held", "reconciliation_required"],
        ["held", "reconciliation_required"],
      ],
      `observed: ${JSON.stringify(out)}`,
    );
  },
);

// ===========================================================================
// ATTACK A6 — interleaved account switch on one installation: two accounts
// on the same device each deliver the OTHER's receipt (bearer of A, receipt of
// B and vice versa) inside the same batch as their own. Own receipts settle;
// foreign receipts are held owner_mismatch under the CALLER's namespace, and
// the durable call carries the caller's bearer — never the receipt owner's.
// ===========================================================================
Deno.test(
  "A6 interleaved account switch: each caller's own receipt settles, the other account's receipt is held owner_mismatch under the caller, tickets consumed once",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const ownA = await fixture(a.sub, TICKET_A, 1);
    const ownB = await fixture(b.sub, TICKET_B, 2);
    const fromA = await results(await post({ receipts: [entry(ownA), entry(ownB)] }, a.token));
    assertEquals(
      fromA.map((r) => [r.delivery, r.reconciliation?.reasonCode ?? null]),
      [
        ["settled", null],
        ["held", "owner_mismatch"],
      ],
    );
    const fromB = await results(await post({ receipts: [entry(ownA), entry(ownB)] }, b.token));
    assertEquals(
      fromB.map((r) => [r.delivery, r.reconciliation?.reasonCode ?? null]),
      [
        ["held", "owner_mismatch"],
        ["settled", null],
      ],
    );
    assertEquals(consumedTickets.get(TICKET_A), 1);
    assertEquals(consumedTickets.get(TICKET_B), 1);
    const bearers = h.callsTo(SETTLE_RPC).map((c) => c.headers.authorization);
    assertEquals(new Set(bearers).size, 2, "every settle call is made as the caller");
    // Redelivery by each: replays only, nothing new consumed.
    const againA = await results(await post({ receipts: [entry(ownA), entry(ownB)] }, a.token));
    assertEquals(
      againA.map((r) => r.delivery),
      ["replayed", "replayed"],
    );
    assertEquals([...consumedTickets.values()], [1, 1]);
  },
);

// ===========================================================================
// ATTACK A17 — unauthenticated / wrong-method / wrong-content edge surface:
// no bearer, a garbage bearer, GET, a JSON array body, a string body, a body
// with `receipts: {}`; none may reach the database.
// ===========================================================================
Deno.test(
  "A17 edge surface: anonymous, garbage bearer, GET, non-object bodies never reach settle_offline_receipt",
  async () => {
    reset();
    const user = freshUser();
    const one = await fixture(user.sub, TICKET_A, 1);
    const anon = await h.handler(
      new Request(`${ISSUER}${RECEIPTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ receipts: [entry(one)] }),
      }),
    );
    assertEquals(anon.status, 401);
    const garbage = await h.handler(
      new Request(`${ISSUER}${RECEIPTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-token" },
        body: JSON.stringify({ receipts: [entry(one)] }),
      }),
    );
    assertEquals(garbage.status, 401);
    const get = await h.handler(userRequest("GET", RECEIPTS_PATH, { token: user.token }));
    assert(get.status === 404 || get.status === 405, `GET → ${get.status}`);
    for (const body of [[entry(one)], "receipts", 42, null, { receipts: {} }, { receipts: "x" }]) {
      const response = await post(body, user.token);
      assertEquals(response.status, 400, JSON.stringify(body).slice(0, 40));
    }
    assertEquals(settleCalls().length, 0);
    assertEquals(consumedTickets.size, 0);
  },
);

// ===========================================================================
// Live postgres half — the REAL settle_offline_receipt().
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

async function asUser(tx: Tx, n: number, session = true, apiKey = true): Promise<void> {
  if (apiKey) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
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
  assert(claims.allocation, `free grant expected: ${JSON.stringify(row)}`);
  assertEquals(claims.allocation.ticketIds.length, requested);
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  ownerId: string,
  issued: LiveGrant,
  ticketId: string | null,
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
    ticket: ticketId === null ? null : ticketRef(ticketId, issued.claims),
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

async function settlementRows(sql: Sql, n: number): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.offline_receipt_settlements where user_id = '${U(n)}'`,
  );
  return Number(count);
}

/** Fire `fns` truly concurrently on separate connections/transactions. */
function race<T>(fns: Array<() => Promise<T>>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(fns.map((fn) => fn()));
}

function fulfilled<T>(settled: PromiseSettledResult<T>[]): T[] {
  const out: T[] = [];
  for (const s of settled) {
    if (s.status === "rejected") throw s.reason;
    out.push(s.value);
  }
  return out;
}

// ===========================================================================
// ATTACK A7 — true concurrency, first delivery: 8 connections deliver the SAME
// new receipt at once. Exactly one 'settled', seven 'replayed', one consumed
// event, one shot, lifetime_scored_count 1.
// ===========================================================================
Deno.test({
  name: "A7 live DB: 8 concurrent first deliveries of one receipt → 1 settled + 7 replayed, one consumed event, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("a7"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(1), issued, ticketA, "a7");
      const verdicts = fulfilled(
        await race(
          Array.from(
            { length: 8 },
            () => () => inTx(sql, 1, (tx) => settle(tx, rec.receipt, rec.output, null)),
          ),
        ),
      );
      assertEquals(verdicts.filter((v) => v.delivery === "settled").length, 1);
      assertEquals(verdicts.filter((v) => v.delivery === "replayed").length, 7);
      for (const v of verdicts) {
        assertEquals(v.status, "result_recorded");
        assertEquals(v.financial_disposition, "consumed");
        assertEquals(v.result_id, rec.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await settlementRows(sql, 1), 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A8 — true concurrency, different identities for one ticket: 6
// DIFFERENT receipts (distinct id/operation/result) all claim ticket A at
// once. Exactly one consumes; the other five are held conflicting_receipt;
// one shot; the ticket's ledger has exactly one terminal event.
// ===========================================================================
Deno.test({
  name: "A8 live DB: 6 concurrent different receipts for one ticket → exactly one consumed, five held conflicting_receipt, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const issued = await issueFreeGrant(sql, 2, KEY("a8"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const recs = [];
      for (let i = 0; i < 6; i += 1) recs.push(await liveReceipt(U(2), issued, ticketA, `a8-${i}`));
      const verdicts = fulfilled(
        await race(
          recs.map((r) => () => inTx(sql, 2, (tx) => settle(tx, r.receipt, r.output, null))),
        ),
      );
      assertEquals(verdicts.filter((v) => v.delivery === "settled").length, 1);
      const held = verdicts.filter((v) => v.delivery === "held");
      assertEquals(held.length, 5);
      for (const v of held) {
        assertEquals(v.reason_code, "conflicting_receipt");
        assertEquals(v.financial_disposition, "reserved");
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await settlementRows(sql, 2), 6);
      // Free-rating conservation: one scored, ticket B still an outstanding hold.
      assertEquals(await counters(sql, 2), { held: 1, scored: 1 });

      // Replaying every one of the six afterwards changes nothing.
      const again = fulfilled(
        await race(
          recs.map((r) => () => inTx(sql, 2, (tx) => settle(tx, r.receipt, r.output, null))),
        ),
      );
      assertEquals(again.filter((v) => v.delivery === "replayed").length, 6);
      assertEquals(await shotCount(sql, ticketA), 1);
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A9 — true concurrency across tickets: one OPERATION reported under
// ticket A and ticket B at once (two receipts, two results); and one RESULT
// reported under two tickets at once. Exactly one consumption per operation
// and per result; the losing ticket stays allocated (never released).
// ===========================================================================
Deno.test({
  name: "A9 live DB: one operation (and one result) raced across two tickets consumes exactly one ticket; the other stays allocated",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      const issued = await issueFreeGrant(sql, 3, KEY("a9"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const opA = await liveReceipt(U(3), issued, ticketA, "a9-op-a");
      const opB = await liveReceipt(U(3), issued, ticketB, "a9-op-b", {
        operationId: opA.receipt.operationId,
      });
      const verdicts = fulfilled(
        await race([
          () => inTx(sql, 3, (tx) => settle(tx, opA.receipt, opA.output, null)),
          () => inTx(sql, 3, (tx) => settle(tx, opB.receipt, opB.output, null)),
        ]),
      );
      assertEquals(verdicts.filter((v) => v.delivery === "settled").length, 1);
      assertEquals(verdicts.filter((v) => v.reason_code === "conflicting_receipt").length, 1);
      const eventsA = await ledgerEvents(sql, ticketA);
      const eventsB = await ledgerEvents(sql, ticketB);
      assertEquals([eventsA, eventsB].filter((e) => e.includes("consumed")).length, 1);
      assert(!eventsA.includes("released") && !eventsB.includes("released"));
      assertEquals((await shotCount(sql, ticketA)) + (await shotCount(sql, ticketB)), 1);
      assertEquals(await counters(sql, 3), { held: 1, scored: 1 });

      // Same RESULT id under the still-allocated ticket, new operation: held,
      // no second shot, the losing ticket still allocated.
      const loser = eventsA.includes("consumed") ? ticketB : ticketA;
      const winner = eventsA.includes("consumed") ? opA : opB;
      const sameResult = await liveReceipt(U(3), issued, loser, "a9-same-result", {
        resultId: winner.receipt.resultId,
        fullOutputSha256: winner.receipt.fullOutputSha256,
      });
      const v = await inTx(sql, 3, (tx) => settle(tx, sameResult.receipt, winner.output, null));
      assertEquals(v.delivery, "held");
      assertEquals(v.reason_code, "conflicting_receipt");
      assertEquals(await ledgerEvents(sql, loser), ["allocated"]);
      assertEquals((await shotCount(sql, ticketA)) + (await shotCount(sql, ticketB)), 1);
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A10 — settle vs explicit return: the device returns ticket A
// (release_offline_ticket) while a receipt for ticket A is settling. Exactly
// ONE terminal event; if the return won, the receipt is held (never consumed
// afterwards); if the settlement won, the return is refused.
// ===========================================================================
Deno.test({
  name: "A10 live DB: settle_offline_receipt vs release_offline_ticket race ends with exactly one terminal event",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      const issued = await issueFreeGrant(sql, 4, KEY("a10"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(4), issued, ticketA, "a10");
      const [settled, released] = fulfilled(
        await race<SettleRow | string>([
          () => inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, null)),
          () =>
            inTx(sql, 4, async (tx) => {
              const rows = await tx.unsafe<{ r: string }[]>(
                `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as r`,
              );
              return rows[0].r;
            }),
        ]),
      );
      const verdict = settled as SettleRow;
      const events = await ledgerEvents(sql, ticketA);
      assertEquals(events.length, 2, JSON.stringify(events));
      if (events[1] === "consumed") {
        assertEquals(verdict.delivery, "settled");
        assert(released !== "accepted", `return must be refused after consumption: ${released}`);
        assertEquals(await shotCount(sql, ticketA), 1);
      } else {
        assertEquals(events[1], "released");
        assertEquals(released, "accepted");
        assertEquals(verdict.delivery, "held");
        assertEquals(verdict.reason_code, "conflicting_receipt");
        assertEquals(await shotCount(sql, ticketA), 0);
        // The redelivery of that receipt replays the hold; it never consumes.
        const again = await inTx(sql, 4, (tx) => settle(tx, rec.receipt, rec.output, null));
        assertEquals(again.delivery, "replayed");
        assertEquals(again.status, "reconciliation_required");
        assertEquals(await shotCount(sql, ticketA), 0);
      }
      assertEquals((await counters(sql, 4)).scored, events[1] === "consumed" ? 1 : 0);
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A11 — cross-account delivery straight at the RPC (the edge's hold
// derivation bypassed: p_hold_reason null). Account B delivers A's receipt;
// account B delivers a receipt in its own name that names A's ticket; no
// session; no API key; anon; service_role; direct table access.
// ===========================================================================
Deno.test({
  name: "A11 live DB: other-account, no-session, no-api-key, anon and service_role deliveries never touch the ticket; the settlement table is client-opaque",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      await createUser(sql, 6);
      // One ticket per installation: the free budget is two tickets lifetime.
      const issued = await issueFreeGrant(sql, 5, KEY("a11"), 1);
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const recA = await liveReceipt(U(5), issued, ticketA, "a11-a");

      // B delivers A's receipt with no edge hold: owner_mismatch, recorded under B.
      const byB = await inTx(sql, 6, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(byB.delivery, "held");
      assertEquals(byB.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);

      // B claims A's ticket in B's own name: not B's allocation → evidence_ambiguous.
      const stolen = await liveReceipt(U(6), issued, ticketA, "a11-stolen");
      const byBOwn = await inTx(sql, 6, (tx) => settle(tx, stolen.receipt, stolen.output, null));
      assertEquals(byBOwn.delivery, "held");
      assertEquals(byBOwn.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // A's SECOND installation reports A's first installation's ticket under
      // its own grant: same owner, other installation → evidence_ambiguous.
      const second = await issueFreeGrant(sql, 5, KEY("a11-dev2"), 1);
      const crossDevice = await liveReceipt(U(5), second, ticketA, "a11-cross-device");
      const byDev2 = await inTx(sql, 5, (tx) =>
        settle(tx, crossDevice.receipt, crossDevice.output, null),
      );
      assertEquals(byDev2.delivery, "held");
      assertEquals(byDev2.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // A without a live session / without the API key: refused, nothing recorded.
      for (const [session, apiKey] of [
        [false, true],
        [true, false],
      ] as const) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, 5, session, apiKey);
              await settle(tx as unknown as Tx, recA.receipt, recA.output, null);
            }),
          Error,
        );
      }
      // anon and service_role hold no EXECUTE.
      for (const role of ["anon", "service_role"]) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await settle(tx as unknown as Tx, recA.receipt, recA.output, null);
            }),
          Error,
          "permission denied",
        );
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await settlementRows(sql, 5), 1, "only the cross-device hold is A's");

      // The legitimate owner still settles once afterwards.
      const legit = await inTx(sql, 5, (tx) => settle(tx, recA.receipt, recA.output, null));
      assertEquals(legit.delivery, "settled");
      assertEquals(legit.financial_disposition, "consumed");

      // B reports its OWN ticket with an output whose id is A's consumed shot:
      // A's shot is untouched (still A's), B's ticket stays allocated.
      const issuedB = await issueFreeGrant(sql, 6, KEY("a11-b"), 1);
      assert(issuedB.claims.allocation);
      const [ticketB] = issuedB.claims.allocation.ticketIds;
      const collide = await liveReceipt(U(6), issuedB, ticketB, "a11-collide", {
        resultId: recA.receipt.resultId,
        fullOutputSha256: recA.receipt.fullOutputSha256,
      });
      const collided = await inTx(sql, 6, (tx) => settle(tx, collide.receipt, recA.output, null));
      assert(collided.delivery !== "settled", JSON.stringify(collided));
      assertEquals(collided.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      const owners = await sql.unsafe<{ user_id: string; offline_ticket_id: string }[]>(
        `select user_id, offline_ticket_id from public.shots where id = '${recA.receipt.resultId}'`,
      );
      assertEquals(
        owners.map((row) => [row.user_id, row.offline_ticket_id]),
        [[U(5), ticketA]],
      );

      // Direct table access: authenticated (own rows), anon, service_role → denied.
      for (const [role, n] of [
        ["authenticated", 5],
        ["anon", null],
        ["service_role", null],
      ] as const) {
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              if (n !== null) await asUser(tx as unknown as Tx, n);
              else await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`select count(*) from public.offline_receipt_settlements`);
            }),
          Error,
          "permission denied",
        );
        await assertRejects(
          () =>
            sql.begin(async (tx) => {
              if (n !== null) await asUser(tx as unknown as Tx, n);
              else await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(
                `delete from public.offline_receipt_settlements where user_id = '${U(5)}'`,
              );
            }),
          Error,
          "permission denied",
        );
      }
      // Owner-level update/delete is refused by the append-only guard.
      await assertRejects(
        () =>
          sql.unsafe(
            `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${U(6)}'`,
          ),
        Error,
        "append-only",
      );
      // read_analysis_release_policy_lineage: authenticated denied, service_role allowed.
      await assertRejects(
        () =>
          inTx(sql, 5, (tx) =>
            tx.unsafe(
              `select * from public.read_analysis_release_policy_lineage('${"a".repeat(64)}')`,
            ),
          ),
        Error,
        "permission denied",
      );
      const lineage = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role service_role`);
        return await tx.unsafe(
          `select * from public.read_analysis_release_policy_lineage('${"a".repeat(64)}')`,
        );
      });
      assertEquals(lineage.length, 1);
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A15 — process death after the RPC returned but before COMMIT: the
// settlement, the shot and the consumed event must vanish TOGETHER, and the
// redelivery must settle (not replay a phantom) exactly once.
// ===========================================================================
Deno.test({
  name: "A15 live DB: a transaction that dies after settle_offline_receipt() leaves no partial state; the redelivery settles exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const issued = await issueFreeGrant(sql, 10, KEY("a15"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const rec = await liveReceipt(U(10), issued, ticketA, "a15");
      await assertRejects(
        () =>
          inTx(sql, 10, async (tx) => {
            const v = await settle(tx, rec.receipt, rec.output, null);
            assertEquals(v.delivery, "settled");
            assertEquals(v.financial_disposition, "consumed");
            throw new Error("process died before commit");
          }),
        Error,
        "process died",
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await settlementRows(sql, 10), 0);
      assertEquals(await counters(sql, 10), { held: 2, scored: 0 });

      const again = await inTx(sql, 10, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again.delivery, "settled");
      const third = await inTx(sql, 10, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(third.delivery, "replayed");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await settlementRows(sql, 10), 1);
      assertEquals(await counters(sql, 10), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A12 — corrupt persisted-state candidates at the output: outputs the
// shots table refuses (bad cast, overflow, NOT NULL, phases not an array,
// size cap, bounds). Expected: each is a durable HOLD (reserved) — never a
// consumption, never an exception that would 503 the batch forever — and the
// corrected redelivery of the SAME receipt id is a conflict (the id is spent).
// ===========================================================================
Deno.test({
  name: "A12 live DB: outputs the shots table refuses are durable holds, never a consumption or an exception",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const issued = await issueFreeGrant(sql, 7, KEY("a12"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;

      const refused: Array<[string, Record<string, unknown>]> = [
        ["startMs not an int", { startMs: "abc" }],
        ["startMs overflow", { startMs: 2 ** 40 }],
        ["capturedAt missing", { capturedAt: null }],
        ["phases object", { phases: { key: "prep" } }],
        ["phases scalar entries", { phases: [1, 2] }],
        ["overallScore text", { overallScore: "seven" }],
        ["overallScore 11", { overallScore: 11 }],
        ["shotType 5000 chars", { shotType: "x".repeat(5000) }],
        ["capturedAt year 1999", { capturedAt: "1999-12-31T23:59:59.000Z" }],
        ["confidence 2", { confidence: 2 }],
        ["cameraView drone", { cameraView: "drone" }],
        ["sessionId not a uuid", { sessionId: "not-a-uuid" }],
      ];
      for (const [name, patch] of refused) {
        const rec = await liveReceipt(
          U(7),
          issued,
          ticketA,
          `a12-${name.replaceAll(" ", "-")}`,
          {},
          patch,
        );
        const v = await inTx(sql, 7, (tx) => settle(tx, rec.receipt, rec.output, null));
        assertEquals(v.result, "accepted", name);
        assertEquals(v.delivery, "held", `${name}: ${JSON.stringify(v)}`);
        assertEquals(v.financial_disposition, "reserved", name);
        assertEquals(await ledgerEvents(sql, ticketA), ["allocated"], name);
        // The corrected output under the SAME receipt id: the id is spent.
        const fixedOut = output(String(rec.output.id));
        const fixedRec = {
          ...rec.receipt,
          fullOutputSha256: await digestCanonicalOfflineJson(fixedOut),
        };
        const again = await inTx(sql, 7, (tx) => settle(tx, fixedRec, fixedOut, null));
        assertEquals(again.result, "offline.receipt_conflict", name);
        assertEquals(await ledgerEvents(sql, ticketA), ["allocated"], name);
      }
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await settlementRows(sql, 7), refused.length);
      assertEquals(await counters(sql, 7), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A16 — an output naming a session id that belongs to ANOTHER account:
// this account's session sync can never create that row (the id is taken), so
// the receipt can never settle. Expected: a durable verdict (held) rather than
// an endless `pending` that re-runs on every delivery forever. Verified along
// the way: pending never consumes, never writes a settlement row, and the
// three redeliveries do not grow anything.
// ===========================================================================
Deno.test({
  name: "A16 live DB: an output naming another account's session is a durable verdict, not an endless pending",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      await createUser(sql, 11);
      const issued = await issueFreeGrant(sql, 11, KEY("a16"));
      assert(issued.claims.allocation);
      const [ticketA] = issued.claims.allocation.ticketIds;
      const foreignSession = crypto.randomUUID();
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${foreignSession}', '${U(8)}', now())`,
      );
      const rec = await liveReceipt(
        U(11),
        issued,
        ticketA,
        "a16-foreign-session",
        {},
        {
          sessionId: foreignSession,
        },
      );
      const verdicts: SettleRow[] = [];
      for (let i = 0; i < 3; i += 1) {
        verdicts.push(await inTx(sql, 11, (tx) => settle(tx, rec.receipt, rec.output, null)));
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      assertEquals(await counters(sql, 11), { held: 2, scored: 0 });
      for (const v of verdicts) assert(v.delivery !== "settled", JSON.stringify(v));
      assertEquals(
        verdicts.map((v) => v.delivery),
        ["held", "replayed", "replayed"],
        `observed: ${JSON.stringify(verdicts)}; settlement rows: ${await settlementRows(sql, 11)}`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A13 — Pro (no-ticket) contradictory evidence against the REAL
// migration: a not_chargeable receipt beside a scored output, a chargeable
// receipt beside an abstention output. Expected: held / evidence_ambiguous,
// like the ticketed branch (L4b). Also a Pro receipt naming a grant this
// account never held: expected held (evidence about no lease of the caller).
// ===========================================================================
Deno.test({
  name: "A13 live DB: Pro contradictory evidence (not_chargeable+scored, chargeable+abstention) and an unknown lease are HELD, not recorded",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const claims = proClaims(U(9));
      const issued: LiveGrant = { claims, grant: await sign(claims) };
      const contraA = await liveReceipt(U(9), issued, null, "a13-a", {
        billingDisposition: "not_chargeable",
      });
      const va = await inTx(sql, 9, (tx) => settle(tx, contraA.receipt, contraA.output, null));
      const contraB = await liveReceipt(
        U(9),
        issued,
        null,
        "a13-b",
        {},
        {
          resultKind: "low_confidence",
          overallScore: null,
        },
      );
      const vb = await inTx(sql, 9, (tx) => settle(tx, contraB.receipt, contraB.output, null));
      assertEquals(
        [va.delivery, va.status, vb.delivery, vb.status],
        ["held", "reconciliation_required", "held", "reconciliation_required"],
        `observed: ${JSON.stringify([va, vb])}`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ===========================================================================
// ATTACK A14 — clock boundaries at the edge, signed RAW with the trusted key
// (the issuance-side validation bypassed, as a compromised or buggy issuer
// would): far-future exp, iat == exp, iat > exp, exp 0, negative iat,
// exp beyond 2^53, a grant expired a year ago (historical instant rule).
// Each must be a 200 with a per-receipt verdict — never a 503 that poisons
// the batch — and only a grant that was valid at some instant may settle.
// ===========================================================================
async function signRaw(claims: Record<string, unknown>): Promise<OfflineSignedExecutionGrant> {
  const compactJws = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", typ: OFFLINE_GRANT_JWS_TYPE, kid: KID })
    .sign(keyPair.privateKey);
  return { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws };
}

Deno.test(
  "A14 clock boundaries (raw-signed grants): far-future exp and a long-expired grant settle, iat>=exp / exp 0 / negative iat / exp 2^53 are held, never 503",
  async () => {
    reset();
    const user = freshUser();
    const now = nowSeconds();
    const cases: Array<[string, Record<string, unknown>, "settled" | "held"]> = [
      ["exp year 2200", { exp: 7_258_118_400 }, "settled"],
      ["expired a year ago", { iat: now - 400 * DAY, exp: now - 393 * DAY }, "settled"],
      ["iat == exp", { iat: now - 60, exp: now - 60 }, "held"],
      ["iat > exp", { iat: now, exp: now - 3_600 }, "held"],
      ["exp 0", { exp: 0 }, "held"],
      ["iat negative", { iat: -1, exp: now + DAY }, "held"],
      ["exp 2^53", { exp: 2 ** 53 }, "held"],
      ["exp 1e300", { exp: 1e300 }, "held"],
      ["iat future", { iat: now + DAY, exp: now + 8 * DAY }, "held"],
    ];
    let n = 20;
    for (const [name, patch, expected] of cases) {
      n += 1;
      const claims = { ...freeClaims(user.sub), ...patch } as OfflineExecutionGrantClaims;
      const grant = await signRaw(claims as unknown as Record<string, unknown>);
      const f = await fixture(user.sub, TICKET_A, n, { claims, grant });
      const { result: response } = await captureConsole(() =>
        post({ receipts: [entry(f)] }, user.token),
      );
      assertMatch(String(response.status), /^200$/, `${name}: status ${response.status}`);
      const out = await results(response);
      assertEquals(out[0].delivery, expected, `${name}: ${JSON.stringify(out[0])}`);
    }
  },
);
