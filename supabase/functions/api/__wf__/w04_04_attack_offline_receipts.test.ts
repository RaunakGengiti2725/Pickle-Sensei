// W04-04 ADVERSARIAL — POST /v1/offline/receipts + settle_offline_receipt().
// Attack tests only: nothing here changes production code or the candidate's
// own test file. Each Deno.test is one distinct attack at a failure boundary
// of the delayed-reconciliation path and asserts the W04-04 invariant that
// boundary must hold (settle at most once, ambiguous ⇒ durable HOLD, foreign
// receipts never settle, faults never decide, free ratings conserved).
//
// Two halves, both black-box, mirroring the candidate's layout:
//   * the REAL edge handler through routesHarness (Supabase stubbed at fetch)
//     with a durable settle_offline_receipt() stand-in keyed like the RPC;
//   * the REAL settle_offline_receipt() on a disposable postgres:16 with every
//     migration applied (XC_PG_URL); without it the live half is `ignore`d and
//     an ignored run is NOT a pass.
//
// On BASE_SHA (7cfeacbb) the route answers 404 and the RPC does not exist, so
// every attack fails there; on the candidate each attack either passes (the
// boundary holds) or exposes a break that is reported in the attack ledger.

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
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
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import {
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
  digestOfflineGrantTransport,
} from "../canonicalDigest.ts";
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
const CONSUME_RPC = "/rest/v1/rpc/consume_offline_ticket";
const RELEASE_RPC = "/rest/v1/rpc/release_offline_ticket";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT_ID = "64444444-4444-4444-8444-4444444444aa";
const TICKET_A = "65555555-5555-4555-8555-5555555555a1";
const TICKET_B = "65555555-5555-4555-8555-5555555555a2";
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
  const sub = `aaaaaaaa-0404-4000-8000-a${String(userSeq).padStart(11, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(
  ownerId: string,
  options: {
    grantId?: string;
    tickets?: string[];
    installationKeyId?: string;
    issuedAt?: number;
    lifeSeconds?: number;
    release?: OfflineReleasedArtifacts;
  } = {},
): OfflineExecutionGrantClaims {
  const issuedAt = options.issuedAt ?? nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: options.grantId ?? GRANT_ID,
      generation: 3,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + (options.lifeSeconds ?? 7 * DAY)),
      entitlement_expires_at: null,
      ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
    },
    {
      issuer: ISSUER,
      ownerId,
      installationKeyId: options.installationKeyId ?? INSTALLATION_KEY,
      release: options.release ?? RELEASE,
    },
  );
}

async function sign(
  claims: OfflineExecutionGrantClaims,
  release: OfflineReleasedArtifacts = RELEASE,
): Promise<OfflineSignedExecutionGrant> {
  return await signOfflineExecutionGrant(claims, signingKey, {
    binding: {
      issuer: ISSUER,
      allowedKeyIds: [KID],
      ownerId: claims.sub,
      installationKeyId: claims.installationKeyId,
    },
    release,
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
  installationKeyId?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    ticket: options.ticket,
    lifecycleSequence: options.lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04-attack",
      elapsedMs: 120_000 * Math.max(1, Math.trunc(options.lifecycleSequence)),
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
  options: {
    claims?: OfflineExecutionGrantClaims;
    release?: OfflineReleasedArtifacts;
    outputOverrides?: Record<string, unknown>;
  } = {},
): Promise<Fixture> {
  const claims = options.claims ?? freeClaims(ownerId, { release: options.release });
  const grant = await sign(claims, options.release);
  const resultId = `7000000${n % 10}-0404-4000-8000-a${String(n).padStart(11, "0")}`;
  const out = output(resultId, options.outputOverrides);
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

const entry = (f: Fixture): Record<string, unknown> => ({
  receipt: f.receipt,
  grant: f.grant,
  output: f.output,
});

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the candidate's harness half).
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

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

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
  return jsonResponse(200, [row]);
}

function reset(): void {
  h.reset();
  durable.clear();
  Deno.env.set(
    SIGNING_ENV,
    JSON.stringify({ schemaVersion: 1, active: privateJwk, previous: null }),
  );
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

interface RouteResult {
  receiptId: string | null;
  delivery: "settled" | "replayed" | "held" | "pending" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  assertEquals(response.status, 200, await response.clone().text());
  const body = (await response.json()) as Record<string, unknown>;
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

const settleCalls = (): SettleParams[] => h.callsTo(SETTLE_RPC).map(settleParams);

async function genericFault(response: Response): Promise<void> {
  assertEquals(response.status, 503);
  const text = await response.text();
  for (const leak of ["injected", "upstream", "22P05", "evil.example", "XX000", "Retry-After"]) {
    assert(!text.includes(leak), `503 body leaks "${leak}": ${text}`);
  }
}

// ---------------------------------------------------------------------------
// ATTACK 1 — concurrency at the route: the same batch submitted 6× at once,
// and one batch carrying a receipt twice plus a same-id/other-body twin.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK-1 concurrency: six simultaneous identical batches settle each receipt once (settled or replayed, never twice, never a conflict) and an in-batch duplicate replays while a same-id twin is a conflict",
  async () => {
    reset();
    const user = freshUser();
    const a = await fixture(user.sub, TICKET_A, 1);
    const b = await fixture(user.sub, TICKET_B, 2, { claims: a.claims });
    const batch = { receipts: [entry(a), entry(b)] };

    const responses = await Promise.all(Array.from({ length: 6 }, () => post(batch, user.token)));
    const all = await Promise.all(responses.map(results));
    for (const out of all) {
      assertEquals(out.length, 2);
      for (const r of out) {
        assert(r.delivery === "settled" || r.delivery === "replayed", JSON.stringify(r));
        assertEquals(r.error, null);
        assertEquals(r.reconciliation?.status, "result_recorded");
        assertEquals(r.reconciliation?.financialDisposition, "consumed");
      }
    }
    const settledCount = (id: string) =>
      all.flat().filter((r) => r.receiptId === id && r.delivery === "settled").length;
    assertEquals(settledCount("attack-receipt-1"), 1);
    assertEquals(settledCount("attack-receipt-2"), 1);
    const calls = settleCalls();
    assertEquals(calls.length, 12);
    assertEquals(
      new Set(
        calls
          .filter((c) => c.p_receipt.receiptId === "attack-receipt-1")
          .map((c) => c.p_receipt_sha256),
      ).size,
      1,
    );
    assert(calls.every((c) => c.p_hold_reason === null));
    assertEquals(h.callsTo(CONSUME_RPC).length, 0);
    assertEquals(h.callsTo(RELEASE_RPC).length, 0);

    // In-batch duplicate + same id with another body.
    const twin = { ...b.receipt, resultId: "70000009-0404-4000-8000-a00000000999" };
    const out = await results(
      await post(
        { receipts: [entry(a), entry(a), { receipt: twin, grant: b.grant, output: b.output }] },
        user.token,
      ),
    );
    assertEquals(
      out.map((r) => [r.delivery, r.error?.code ?? null]),
      [
        ["replayed", null],
        ["replayed", null],
        ["rejected", "offline.receipt_conflict"],
      ],
    );
  },
);

// ---------------------------------------------------------------------------
// ATTACK 2 — network failure at the settlement step: gateway 429+Retry-After,
// a 5xx on the SECOND entry after the first settled, a fetch-level failure,
// a 302 redirect, and malformed RPC rows. Each must be a generic 503 that
// decides nothing; redelivery must replay what settled and settle the rest.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK-2 network faults at the RPC step never decide, never leak, never follow a redirect; the identical redelivery settles once",
  async () => {
    reset();
    const user = freshUser();
    const a = await fixture(user.sub, TICKET_A, 1);
    const b = await fixture(user.sub, TICKET_B, 2, { claims: a.claims });
    const batch = { receipts: [entry(a), entry(b)] };

    // (a) 429 + Retry-After from the data gateway.
    h.respond = (call) =>
      call.url.endsWith(SETTLE_RPC)
        ? jsonResponse(429, { message: "rate limited upstream" }, { "Retry-After": "7" })
        : null;
    const { result: limited } = await captureConsole(() => post(batch, user.token));
    await genericFault(limited);
    assertEquals(settleCalls().length, 1);
    assertEquals(durable.size, 0);

    // (b) first entry settles, second hits a 500: batch is 503, first stays decided.
    h.reset();
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      const p = settleParams(call);
      if (p.p_receipt.receiptId === "attack-receipt-2") {
        return jsonResponse(500, { code: "XX000", message: "injected rpc failure" });
      }
      return durableRespond(call);
    };
    const { result: partial } = await captureConsole(() => post(batch, user.token));
    await genericFault(partial);
    assertEquals(settleCalls().length, 2);
    assertEquals(durable.size, 1);

    // (c) fetch itself fails (network down).
    h.reset();
    h.respond = (call) => {
      if (call.url.endsWith(SETTLE_RPC)) throw new TypeError("network down");
      return null;
    };
    const { result: down } = await captureConsole(() => post(batch, user.token));
    await genericFault(down);
    assertEquals(durable.size, 1);

    // (d) 302 to a foreign host: not followed, no receipt bytes leave.
    h.reset();
    h.respond = (call) =>
      call.url.endsWith(SETTLE_RPC)
        ? new Response(null, { status: 302, headers: { Location: "https://evil.example/collect" } })
        : null;
    const { result: redirected } = await captureConsole(() => post(batch, user.token));
    await genericFault(redirected);
    assertEquals(h.calls.filter((c) => c.url.includes("evil.example")).length, 0);
    assertEquals(durable.size, 1);

    // (e) 200 with no row / two rows.
    for (const rows of [
      [],
      [{ result: "accepted", delivery: "settled" }, { result: "accepted" }],
    ]) {
      h.reset();
      h.respond = (call) => (call.url.endsWith(SETTLE_RPC) ? jsonResponse(200, rows) : null);
      const { result: odd } = await captureConsole(() => post(batch, user.token));
      await genericFault(odd);
    }
    assertEquals(durable.size, 1);

    // Redelivery after the faults: the first replays, the second settles — once.
    h.reset();
    h.respond = durableRespond;
    const out = await results(await post(batch, user.token));
    assertEquals(
      out.map((r) => [r.receiptId, r.delivery]),
      [
        ["attack-receipt-1", "replayed"],
        ["attack-receipt-2", "settled"],
      ],
    );
    assertEquals(durable.size, 2);
  },
);

// ---------------------------------------------------------------------------
// ATTACK 3 — boundary values: batch size 0/25/26, 2 MB body, per-user budget
// (25/60s) with Retry-After, lifecycleSequence at -0/0/1.5/2^53-1/2^53/-1,
// a grant with a far-future iat (device clock ahead), a grant that expired a
// month ago (device offline for weeks / clock rollback), uppercase digests.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK-3 boundaries: batch/body/budget limits hold; numeric edges of lifecycleSequence are rejected per entry without an RPC; future-issued grants HOLD; long-expired grants still settle",
  async () => {
    reset();
    const user = freshUser();
    const a = await fixture(user.sub, TICKET_A, 1);

    // Batch size.
    assertEquals((await post({ receipts: [] }, user.token)).status, 400);
    assertEquals((await post({ receipts: {} }, user.token)).status, 400);
    assertEquals((await post({}, user.token)).status, 400);
    const twentySix = { receipts: Array.from({ length: 26 }, () => entry(a)) };
    assertEquals((await post(twentySix, user.token)).status, 400);
    assertEquals(settleCalls().length, 0);
    const twentyFive = await results(
      await post({ receipts: Array.from({ length: 25 }, () => entry(a)) }, user.token),
    );
    assertEquals(twentyFive.length, 25);
    assertEquals(twentyFive[0].delivery, "settled");
    assert(twentyFive.slice(1).every((r) => r.delivery === "replayed"));
    assertEquals(settleCalls().length, 25);

    // Body cap: one entry with an output of > 2,000,000 bytes.
    const huge = {
      receipts: [{ ...entry(a), output: { ...a.output, blob: "x".repeat(2_000_001) } }],
    };
    assertEquals((await post(huge, user.token)).status, 413);

    // Per-user route budget: 25 requests per 60 s, then 429 + Retry-After.
    const budgetUser = freshUser();
    const tiny = { receipts: [entry(await fixture(budgetUser.sub, TICKET_A, 3))] };
    for (let i = 0; i < 25; i += 1) {
      const r = await post(tiny, budgetUser.token);
      assertEquals(r.status, 200, `request ${i + 1}`);
      await r.text();
    }
    const limited = await post(tiny, budgetUser.token);
    assertEquals(limited.status, 429);
    assert(limited.headers.get("Retry-After"), "Retry-After expected");
    await limited.text();

    // lifecycleSequence edges (JSON has no NaN/Infinity; -0 serialises as 0).
    h.reset();
    h.respond = durableRespond;
    const seqUser = freshUser();
    const base = await fixture(seqUser.sub, TICKET_A, 4);
    const withSeq = (lifecycleSequence: number, receiptId: string) => ({
      ...entry(base),
      receipt: { ...base.receipt, lifecycleSequence, receiptId },
    });
    const edges = await results(
      await post(
        {
          receipts: [
            withSeq(-0, "seq-neg-zero"),
            withSeq(0, "seq-zero"),
            withSeq(1.5, "seq-fraction"),
            withSeq(-1, "seq-negative"),
            withSeq(2 ** 53, "seq-unsafe"),
            withSeq(2 ** 53 - 1, "seq-max-safe"),
            withSeq(2 ** 31, "seq-int4-overflow"),
          ],
        },
        seqUser.token,
      ),
    );
    assertEquals(
      edges.map((r) => [r.receiptId, r.delivery]),
      [
        ["seq-neg-zero", "rejected"],
        ["seq-zero", "rejected"],
        ["seq-fraction", "rejected"],
        ["seq-negative", "rejected"],
        ["seq-unsafe", "rejected"],
        ["seq-max-safe", "settled"],
        ["seq-int4-overflow", "settled"],
      ],
    );
    assertEquals(settleCalls().length, 2);
    assert(settleCalls().every((c) => Number.isSafeInteger(c.p_receipt.lifecycleSequence)));

    // Uppercase digest → rejected per entry, nothing reaches the RPC.
    h.reset();
    h.respond = durableRespond;
    const upper = {
      ...entry(base),
      receipt: { ...base.receipt, fullOutputSha256: base.receipt.fullOutputSha256.toUpperCase() },
    };
    const [rej] = await results(await post({ receipts: [upper] }, seqUser.token));
    assertEquals(rej.delivery, "rejected");
    assertEquals(settleCalls().length, 0);

    // Device clock ahead: a grant "issued" 2 days from now is not yet valid at
    // any instant the route may verify at → HOLD (ticket reserved), no settle.
    const futureUser = freshUser();
    const future = await fixture(futureUser.sub, TICKET_A, 5, {
      claims: freeClaims(futureUser.sub, { issuedAt: nowSeconds() + 2 * DAY }),
    });
    const [futureOut] = await results(await post({ receipts: [entry(future)] }, futureUser.token));
    assertEquals(futureOut.delivery, "held");
    assertEquals(futureOut.reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(futureOut.reconciliation?.financialDisposition, "reserved");

    // Device offline for five weeks: the grant expired four weeks ago. The
    // consumption happened while it was live; the receipt must still settle.
    const lateUser = freshUser();
    const late = await fixture(lateUser.sub, TICKET_A, 6, {
      claims: freeClaims(lateUser.sub, { issuedAt: nowSeconds() - 35 * DAY }),
    });
    const [lateOut] = await results(await post({ receipts: [entry(late)] }, lateUser.token));
    assertEquals(lateOut.delivery, "settled");
    assertEquals(lateOut.reconciliation?.financialDisposition, "consumed");
  },
);

// ---------------------------------------------------------------------------
// ATTACK 4 — unauthorised callers at the route: anonymous, a bearer for
// another account delivering this owner's receipts (interleaved account
// switch on one device), and a receipt whose grant was signed for another
// owner but re-labelled with the caller's id.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK-4 route authorisation: anonymous is 401; another account's receipts HOLD as owner_mismatch in the caller's namespace and never settle; the owner's later delivery settles once; a re-owned receipt over a foreign grant HOLDs",
  async () => {
    reset();
    const owner = freshUser();
    const intruder = freshUser();
    const a = await fixture(owner.sub, TICKET_A, 1);
    const b = await fixture(owner.sub, TICKET_B, 2, { claims: a.claims });

    const anonymous = await h.handler(
      new Request(`http://edge.test/functions/v1/api${RECEIPTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.77" },
        body: JSON.stringify({ receipts: [entry(a)] }),
      }),
    );
    assertEquals(anonymous.status, 401);
    await anonymous.text();
    assertEquals(settleCalls().length, 0);

    // Account switch: the device now bears the intruder's session and flushes
    // the owner's outbox.
    const switched = await results(await post({ receipts: [entry(a), entry(b)] }, intruder.token));
    for (const r of switched) {
      assertEquals(r.delivery, "held");
      assertEquals(r.reconciliation?.reasonCode, "owner_mismatch");
      assertEquals(r.reconciliation?.financialDisposition, "reserved");
      assertEquals(r.reconciliation?.ownerId, owner.sub);
    }
    assert(settleCalls().every((c) => c.p_hold_reason === "owner_mismatch"));
    assert(settleCalls().every((c) => c.p_receipt.ownerId === owner.sub));

    // The owner signs back in and delivers: settles once, unaffected.
    const own = await results(await post({ receipts: [entry(a), entry(b)] }, owner.token));
    assertEquals(
      own.map((r) => r.delivery),
      ["settled", "settled"],
    );
    assertEquals(
      own.map((r) => r.reconciliation?.financialDisposition),
      ["consumed", "consumed"],
    );
    const again = await results(await post({ receipts: [entry(b)] }, intruder.token));
    assertEquals(again[0].delivery, "replayed");
    assertEquals(again[0].reconciliation?.reasonCode, "owner_mismatch");

    // A receipt relabelled with the intruder's ownerId over the OWNER's grant:
    // the grant's sub does not verify for the intruder → HOLD, never settle.
    const relabelled = {
      ...entry(a),
      receipt: { ...a.receipt, receiptId: "relabelled-1", ownerId: intruder.sub },
    };
    const [stolen] = await results(await post({ receipts: [relabelled] }, intruder.token));
    assertEquals(stolen.delivery, "held");
    assertEquals(stolen.reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(stolen.reconciliation?.financialDisposition, "reserved");
  },
);

// ---------------------------------------------------------------------------
// ATTACK 5 — corrupt persisted output: a delivered output whose JSON PostgreSQL
// cannot store as jsonb (a "\u0000" escape or a lone surrogate). The receipt
// is well formed and the digest binds, so the edge computes hold=null and hands
// the output to the RPC; PostgREST's jsonb cast fails (SQLSTATE 22P05, HTTP
// 400) → the route answers 503 for the WHOLE batch and records nothing, so
// the identical redelivery fails identically — including for the healthy
// sibling receipt. The live half proves the cast failure on real postgres.
// ---------------------------------------------------------------------------

const POSTGREST_JSONB_FAILURE = {
  code: "22P05",
  details: null,
  hint: null,
  message: "unsupported Unicode escape sequence",
};

Deno.test(
  "ATTACK-5 route: one entry whose output holds \\u0000 is forwarded to the RPC as settle (hold=null); the jsonb cast failure becomes a batch-wide 503 with no durable verdict, and the healthy sibling never settles on redelivery either",
  async () => {
    reset();
    const user = freshUser();
    const healthy = await fixture(user.sub, TICKET_A, 1);
    const poisoned = await fixture(user.sub, TICKET_B, 2, {
      claims: healthy.claims,
      outputOverrides: { note: "nul\u0000byte" },
    });
    h.respond = (call) => {
      if (!call.url.endsWith(SETTLE_RPC)) return null;
      const p = settleParams(call);
      if (JSON.stringify(p.p_output).includes("\\u0000")) {
        return jsonResponse(400, POSTGREST_JSONB_FAILURE);
      }
      return durableRespond(call);
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      h.calls.length = 0;
      const { result } = await captureConsole(() =>
        post({ receipts: [entry(poisoned), entry(healthy)] }, user.token),
      );
      await genericFault(result);
      const calls = settleCalls();
      assertEquals(calls.length, 1, "the batch stops at the poisoned entry");
      assertEquals(calls[0].p_receipt.receiptId, "attack-receipt-2");
      assertEquals(calls[0].p_hold_reason, null, "edge forwards the poisoned output as settle");
      assertEquals(durable.size, 0, "healthy sibling never reached the RPC");
    }
  },
);

// ---------------------------------------------------------------------------
// ATTACK 11 — release policy validity expires between execution and delivery
// (the operator lets a policy lapse; no withdrawal). The grant was issued and
// executed while the policy was valid.
// ---------------------------------------------------------------------------

async function lapsedPolicyRow(validUntil: number): Promise<{
  row: Record<string, unknown>;
  release: OfflineReleasedArtifacts;
}> {
  const artifact = { version: "attack-lapsed", sha256: "e".repeat(64) };
  const lineage = {
    pipeline: artifact,
    definition: artifact,
    model: artifact,
    preprocessing: artifact,
    calibration: artifact,
    dataset: artifact,
    validationReport: artifact,
    supportedDomain: artifact,
  };
  const document: AnalysisReleasePolicyDocument = {
    ...HARNESS_RELEASE_POLICY,
    version: "attack-policy-lapsed",
    validFrom: validUntil - 30 * DAY,
    validUntil,
    mechanics: { lineage },
    benchmark: { ...HARNESS_RELEASE_POLICY.benchmark, lineage },
  };
  const policy = { version: document.version, sha256: await digestCanonicalOfflineJson(document) };
  return {
    row: {
      document,
      canonicalDocument: canonicalizeOfflineJson(document),
      denyNewAuthorizations: false,
      approval: {
        policy,
        mechanicsApprovedAt: document.validFrom,
        benchmarkApprovedAt: document.validFrom,
        withdrawnAt: null,
        denyNewAuthorizations: false,
      },
    },
    release: { policy, mechanicsModel: artifact, benchmarkModel: artifact },
  };
}

Deno.test(
  "ATTACK-11 lapsed (not withdrawn) release validity: a rating executed under a live grant while the policy was valid, delivered after validUntil, is HELD as evidence_ambiguous (not settled, not grant_revoked)",
  async () => {
    reset();
    const user = freshUser();
    const lapsed = await lapsedPolicyRow(nowSeconds() - DAY);
    h.rpcs.read_analysis_release_policy = lapsed.row;
    const claims = freeClaims(user.sub, {
      issuedAt: nowSeconds() - 2 * DAY,
      release: lapsed.release,
    });
    const f = await fixture(user.sub, TICKET_A, 1, { claims, release: lapsed.release });
    const [out] = await results(await post({ receipts: [entry(f)] }, user.token));
    assertEquals(out.delivery, "held");
    assertEquals(out.reconciliation?.reasonCode, "evidence_ambiguous");
    assertEquals(out.reconciliation?.financialDisposition, "reserved");
    assertEquals(settleCalls()[0].p_hold_reason, "evidence_ambiguous");

    // Same grant, delivered while the policy is still valid: settles.
    reset();
    const fresh = freshUser();
    const valid = await lapsedPolicyRow(nowSeconds() + DAY);
    h.rpcs.read_analysis_release_policy = valid.row;
    const validClaims = freeClaims(fresh.sub, {
      issuedAt: nowSeconds() - 2 * DAY,
      release: valid.release,
    });
    const g = await fixture(fresh.sub, TICKET_A, 2, {
      claims: validClaims,
      release: valid.release,
    });
    const [ok] = await results(await post({ receipts: [entry(g)] }, fresh.token));
    assertEquals(ok.delivery, "settled");
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
const KEY = (name: string): string => `atk-${name}-${RUN}`;

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

async function asRole(
  tx: Tx,
  role: "authenticated" | "anon" | "service_role",
  n: number | null,
  sessionOf: number | null,
): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role ${role}`);
  if (n !== null) await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  if (sessionOf !== null) {
    await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(sessionOf)}"}'`);
  }
}

function inTx<T>(sql: Sql, n: number | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    if (n !== null) await asRole(tx as unknown as Tx, "authenticated", n, n);
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
  return await sql.unsafe(
    `select receipt_id, status, reason_code from public.offline_receipt_settlements
     where user_id = '${U(n)}' order by receipt_id`,
  );
}

async function counters(sql: Sql, n: number): Promise<{ held: number; scored: number }> {
  const [{ held, scored }] = await inTx(sql, n, (tx) =>
    tx.unsafe<{ held: number; scored: number }[]>(
      `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
    ),
  );
  return { held: Number(held), scored: Number(scored) };
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
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineResultReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `atk-receipt-${tag}-${RUN}`,
    ownerId,
    grant: issued.grant,
    claims: issued.claims,
    ticket: ticketRef(ticketId, issued.claims),
    lifecycleSequence: 1,
    operationId: `atk-operation-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : `no-sqlstate:${String(error)}`;
}

// ---------------------------------------------------------------------------
// ATTACK 6 — live concurrency: the same receipt from 3 connections at once
// plus 2 other receipts for the same ticket at the same instant.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-6 live concurrency: five simultaneous transactions on one ticket (3× the same receipt, 2× rival receipts) consume it exactly once — one settled, two replayed, two conflicting holds, one consumed ledger event, one shot",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const issued = await issueFreeGrant(sql, 1, KEY("race"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const same = await liveReceipt(U(1), issued, ticket, "race-same");
      const rivalA = await liveReceipt(U(1), issued, ticket, "race-rival-a");
      const rivalB = await liveReceipt(U(1), issued, ticket, "race-rival-b");

      const outcomes = await Promise.all([
        inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        inTx(sql, 1, (tx) => settle(tx, same.receipt, same.output, null)),
        inTx(sql, 1, (tx) => settle(tx, rivalA.receipt, rivalA.output, null)),
        inTx(sql, 1, (tx) => settle(tx, rivalB.receipt, rivalB.output, null)),
      ]);
      const sameRows = outcomes.slice(0, 3);
      const rivalRows = outcomes.slice(3);
      assertEquals(await ledgerEvents(sql, ticket), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticket), 1);
      const consumedRows = outcomes.filter((r) => r.financial_disposition === "consumed");
      assertEquals(
        consumedRows.length + outcomes.filter((r) => r.status === "reconciliation_required").length,
        5,
      );
      // Exactly one result_recorded lineage: the same receipt (settled once,
      // replayed twice) OR one rival (then the same receipt is a conflict).
      const settledOnce = outcomes.filter((r) => r.delivery === "settled");
      assertEquals(settledOnce.length, 1);
      const replays = outcomes.filter((r) => r.delivery === "replayed");
      const holds = outcomes.filter((r) => r.delivery === "held");
      if (settledOnce[0].result_id === same.receipt.resultId) {
        assertEquals(replays.length, 2);
        assertEquals(holds.length, 2);
        assert(sameRows.every((r) => r.status === "result_recorded"));
        assert(rivalRows.every((r) => r.reason_code === "conflicting_receipt"));
      } else {
        assertEquals(replays.length, 2);
        assertEquals(holds.length, 2);
        assert(sameRows.every((r) => r.reason_code === "conflicting_receipt"));
      }
      assert(holds.every((r) => r.financial_disposition === "reserved"));
      const rows = await settlementRows(sql, 1);
      assertEquals(rows.length, 3);
      assertEquals(rows.filter((r) => r.status === "result_recorded").length, 1);
      assertEquals(await counters(sql, 1), { held: 1, scored: 1 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 7 — live authorisation matrix for the new SQL surfaces.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-7 live roles: anon and service_role cannot call settle_offline_receipt(); a live session of ANOTHER user does not authorise the caller; authenticated cannot read lineage; owner cannot write or read settlement rows; service_role cannot mutate the append-only ledger",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      await createUser(sql, 3);
      const issued = await issueFreeGrant(sql, 2, KEY("roles"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const { receipt: rec, output: out } = await liveReceipt(U(2), issued, ticket, "roles");

      for (const role of ["anon", "service_role"] as const) {
        const state = await sql
          .begin(async (tx) => {
            await asRole(tx as unknown as Tx, role, null, null);
            await settle(tx as unknown as Tx, rec, out, null);
            return "allowed";
          })
          .catch(sqlState);
        assertEquals(state, "42501", `${role} must be denied EXECUTE`);
      }

      // Caller is user 2 but the bearer's session belongs to user 3: the
      // function must refuse (raise insufficient_privilege) or answer
      // invalid_input — never settle.
      const foreignSession = await sql
        .begin(async (tx) => {
          await asRole(tx as unknown as Tx, "authenticated", 2, 3);
          return (await settle(tx as unknown as Tx, rec, out, null)).result;
        })
        .catch(sqlState);
      assert(
        foreignSession === "42501" || foreignSession === "offline.invalid_input",
        String(foreignSession),
      );
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals((await settlementRows(sql, 2)).length, 0);

      // User 3 (a live session of their own) delivering user 2's receipt.
      const other = await inTx(sql, 3, (tx) => settle(tx, rec, out, null));
      assertEquals(other.delivery, "held");
      assertEquals(other.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals((await settlementRows(sql, 2)).length, 0);
      assertEquals((await settlementRows(sql, 3)).length, 1);

      // Lineage reader: authenticated and anon denied; service_role allowed.
      const sha = "f".repeat(64);
      for (const [role, n] of [
        ["authenticated", 2],
        ["anon", null],
      ] as const) {
        const state = await sql
          .begin(async (tx) => {
            await asRole(tx as unknown as Tx, role, n, n);
            await tx.unsafe(`select * from public.read_analysis_release_policy_lineage('${sha}')`);
            return "allowed";
          })
          .catch(sqlState);
        assertEquals(state, "42501", `${role} lineage read must be denied`);
      }
      const service = await sql.begin(async (tx) => {
        await asRole(tx as unknown as Tx, "service_role", null, null);
        return await tx.unsafe<Record<string, unknown>[]>(
          `select to_jsonb(r) as row from public.read_analysis_release_policy_lineage('${sha}') r`,
        );
      });
      assertEquals(service.length, 1);

      // Owner: no select, no DML on the ledger.
      for (const stmt of [
        `select * from public.offline_receipt_settlements`,
        `insert into public.offline_receipt_settlements (user_id, receipt_id) values ('${U(3)}', 'x')`,
        `update public.offline_receipt_settlements set status = 'result_recorded' where user_id = '${U(3)}'`,
        `delete from public.offline_receipt_settlements where user_id = '${U(3)}'`,
      ]) {
        const state = await inTx(sql, 3, async (tx) => {
          await tx.unsafe(stmt);
          return "allowed";
        }).catch(sqlState);
        assertEquals(state, "42501", stmt);
      }
      // Service role: append-only trigger refuses rewriting a verdict.
      for (const stmt of [
        `update public.offline_receipt_settlements set status = 'result_recorded', reason_code = null where user_id = '${U(3)}'`,
        `delete from public.offline_receipt_settlements where user_id = '${U(3)}'`,
      ]) {
        const state = await sql
          .begin(async (tx) => {
            await asRole(tx as unknown as Tx, "service_role", null, null);
            await tx.unsafe(stmt);
            return "allowed";
          })
          .catch(sqlState);
        assertNotEquals(state, "allowed", stmt);
      }
      assertEquals((await settlementRows(sql, 3))[0].reason_code, "owner_mismatch");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 8 — live cross-account: the interleaved account switch, and a
// receipt that claims the caller owns another account's ticket.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-8 live cross-account: another account flushing this owner's outbox holds in ITS namespace without touching the ticket or its own budget; the owner still settles once; a receipt re-owned onto a foreign ticket HOLDs and consumes nothing",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      await createUser(sql, 5);
      const issued = await issueFreeGrant(sql, 4, KEY("switch"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const a = await liveReceipt(U(4), issued, ticketA, "switch-a");
      const b = await liveReceipt(U(4), issued, ticketB, "switch-b");

      // Edge would pass owner_mismatch; also try the raw RPC with hold=null.
      const heldA = await inTx(sql, 5, (tx) => settle(tx, a.receipt, a.output, "owner_mismatch"));
      const heldB = await inTx(sql, 5, (tx) => settle(tx, b.receipt, b.output, null));
      assertEquals([heldA.reason_code, heldB.reason_code], ["owner_mismatch", "owner_mismatch"]);
      assertEquals(
        [heldA.financial_disposition, heldB.financial_disposition],
        ["reserved", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated"]);
      assertEquals(await counters(sql, 5), { held: 0, scored: 0 });
      assertEquals(await counters(sql, 4), { held: 2, scored: 0 });

      // The owner delivers: settles, once.
      const ownA = await inTx(sql, 4, (tx) => settle(tx, a.receipt, a.output, null));
      const ownB = await inTx(sql, 4, (tx) => settle(tx, b.receipt, b.output, null));
      assertEquals(
        [ownA.financial_disposition, ownB.financial_disposition],
        ["consumed", "consumed"],
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
      assertEquals(await counters(sql, 4), { held: 0, scored: 2 });
      assertEquals(await counters(sql, 5), { held: 0, scored: 0 });
      const replay = await inTx(sql, 5, (tx) => settle(tx, a.receipt, a.output, "owner_mismatch"));
      assertEquals([replay.delivery, replay.reason_code], ["replayed", "owner_mismatch"]);

      // User 5 re-owns user 4's receipt onto user 4's ticket (fresh id/op).
      await createUser(sql, 6);
      const grant6 = await issueFreeGrant(sql, 6, KEY("thief"));
      assert(grant6.claims.allocation);
      const stolen = await liveReceipt(U(6), grant6, ticketA, "steal", {
        ticket: { ...ticketRef(ticketA, issued.claims) },
      });
      const theft = await inTx(sql, 6, (tx) => settle(tx, stolen.receipt, stolen.output, null));
      assertEquals(theft.delivery, "held");
      assertEquals(theft.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      assertEquals(await counters(sql, 6), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 9 — live free-rating conservation across every outcome class.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-9 live conservation: lifetime_scored_count() + offline_hold_count() never exceeds 2 across consumed, abstention, held, pending and replayed receipts, and no third free ticket is issued afterwards",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const issued = await issueFreeGrant(sql, 7, KEY("conserve"));
      assert(issued.claims.allocation);
      const [ticketA, ticketB] = issued.claims.allocation.ticketIds;
      const total = async () => {
        const c = await counters(sql, 7);
        assert(c.held + c.scored <= 2, JSON.stringify(c));
        return c;
      };
      assertEquals(await total(), { held: 2, scored: 0 });

      // Abstention on A: recorded, ticket stays outstanding.
      const abstain = await liveReceipt(
        U(7),
        issued,
        ticketA,
        "abstain",
        {
          billingDisposition: "not_chargeable",
        },
        { resultKind: "low_confidence", overallScore: null },
      );
      const abstained = await inTx(sql, 7, (tx) =>
        settle(tx, abstain.receipt, abstain.output, null),
      );
      assertEquals([abstained.delivery, abstained.financial_disposition], ["settled", "reserved"]);
      assertEquals(await total(), { held: 2, scored: 0 });

      // Pending on B (session not synced): nothing recorded, still reserved.
      const sessionId = crypto.randomUUID();
      const pendingRec = await liveReceipt(U(7), issued, ticketB, "pending", {}, { sessionId });
      const pending = await inTx(sql, 7, (tx) =>
        settle(tx, pendingRec.receipt, pendingRec.output, null),
      );
      assertEquals(pending.delivery, "pending");
      assertEquals(await total(), { held: 2, scored: 0 });

      // Chargeable on A after the abstention: consumes A.
      const chargeA = await liveReceipt(U(7), issued, ticketA, "charge-a");
      const charged = await inTx(sql, 7, (tx) => settle(tx, chargeA.receipt, chargeA.output, null));
      assertEquals(charged.financial_disposition, "consumed");
      assertEquals(await total(), { held: 1, scored: 1 });

      // Held on B (missing output): B stays reserved.
      const missing = await liveReceipt(U(7), issued, ticketB, "missing");
      const held = await inTx(sql, 7, (tx) => settle(tx, missing.receipt, null, null));
      assertEquals([held.delivery, held.reason_code], ["held", "evidence_missing"]);
      assertEquals(await total(), { held: 1, scored: 1 });

      // Session syncs; the pending receipt now consumes B.
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${U(7)}', now())`,
      );
      const now = await inTx(sql, 7, (tx) =>
        settle(tx, pendingRec.receipt, pendingRec.output, null),
      );
      assertEquals(now.financial_disposition, "consumed");
      assertEquals(await total(), { held: 0, scored: 2 });

      // Replays of everything change nothing.
      for (const [r, o] of [
        [abstain.receipt, abstain.output],
        [chargeA.receipt, chargeA.output],
        [missing.receipt, null],
        [pendingRec.receipt, pendingRec.output],
      ] as const) {
        const again = await inTx(sql, 7, (tx) => settle(tx, r, o, null));
        assertEquals(again.delivery, "replayed");
      }
      assertEquals(await total(), { held: 0, scored: 2 });
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);

      // No third free ticket afterwards.
      const more = await inTx(sql, 7, async (tx) => {
        const rows = await tx.unsafe<{ result: string; ticket_ids: string[] | null }[]>(
          `select g.result, g.ticket_ids from public.issue_offline_grant('${KEY("conserve")}', 1) g`,
        );
        return rows[0];
      });
      assert(
        more.result !== "accepted" || (more.ticket_ids ?? []).length === 0,
        JSON.stringify(more),
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 10 — crash between steps: the receipt was flushed before its output
// was durable (output=null → HOLD evidence_missing); the output is recovered
// and the same receipt redelivered WITH it. Is the hold final, and does the
// evidence ever charge or double-charge?
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-10 live crash-between-steps: a receipt held for missing output stays a durable HOLD when redelivered with the output (replayed, never consumed, never re-run); a new receipt for the same operation is a conflicting hold; the ticket stays reserved",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      const issued = await issueFreeGrant(sql, 8, KEY("crash"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      const r = await liveReceipt(U(8), issued, ticket, "crash");
      const first = await inTx(sql, 8, (tx) => settle(tx, r.receipt, null, null));
      assertEquals(
        [first.delivery, first.reason_code, first.financial_disposition],
        ["held", "evidence_missing", "reserved"],
      );
      const second = await inTx(sql, 8, (tx) => settle(tx, r.receipt, r.output, null));
      assertEquals(
        [second.delivery, second.reason_code, second.financial_disposition],
        ["replayed", "evidence_missing", "reserved"],
      );
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await shotCount(sql, ticket), 0);
      // Client "retries under a new receipt id" for the same operation.
      const retry = await liveReceipt(U(8), issued, ticket, "crash-retry", {
        operationId: r.receipt.operationId,
      });
      const retried = await inTx(sql, 8, (tx) => settle(tx, retry.receipt, retry.output, null));
      assertEquals([retried.delivery, retried.reason_code], ["held", "conflicting_receipt"]);
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
      assertEquals(await counters(sql, 8), { held: 2, scored: 0 });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK 5 (live half) — the jsonb cast PostgREST performs on p_output fails
// for "\u0000" and for a lone surrogate, so the RPC is never entered.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK-5 live: an output carrying \\u0000 cannot be passed to settle_offline_receipt() as jsonb (SQLSTATE class 22) — the transaction fails before any verdict, so the route's 503 is permanent for that receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const issued = await issueFreeGrant(sql, 9, KEY("nul"));
      assert(issued.claims.allocation);
      const [ticket] = issued.claims.allocation.ticketIds;
      // A lone surrogate is rejected earlier by canonicalizeOfflineJson (the
      // edge holds it as evidence_ambiguous); "\u0000" is valid RFC 8785
      // input, digests cleanly, and only fails at the jsonb boundary.
      for (const [tag, poison] of [["nul", "nul\u0000byte"]] as const) {
        const r = await liveReceipt(U(9), issued, ticket, tag, {}, { note: poison });
        // PostgREST hands RPC arguments to PostgreSQL as JSON text that is
        // cast to the declared jsonb parameter type; the literal cast below is
        // that same conversion.
        const state = await inTx(sql, 9, async (tx) => {
          await settle(tx, r.receipt, r.output, null);
          return "accepted-by-postgres";
        }).catch(sqlState);
        assert(state.startsWith("22"), `${tag}: expected SQLSTATE class 22, got ${state}`);
        assertEquals((await settlementRows(sql, 9)).length, 0, "no durable verdict");
      }
      assertEquals(await ledgerEvents(sql, ticket), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});
