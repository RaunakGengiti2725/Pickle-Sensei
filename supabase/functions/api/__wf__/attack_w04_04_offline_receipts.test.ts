// W04-04 ADVERSARIAL TESTS — POST /v1/offline/receipts + settle_offline_receipt()
// against candidate 9034c0545c6c033e91ee2e953539135f06f52a8f.
//
// Every test states the behaviour the work package promises ("each receipt
// settles at most once, bound to grant/ticket/operation/digest; out-of-order
// and duplicate batches are safe; ambiguous receipts HOLD rather than
// refund/retry") and asserts it at a failure boundary the candidate's own
// suite does not visit. A failing test here is a confirmed break; a passing
// one is an attack that did not break anything.
//
// Two halves, both black-box and independent of the candidate's test file:
//   * the REAL edge handler through routesHarness with a durable in-memory
//     stand-in for settle_offline_receipt() keyed exactly like the RPC;
//   * the REAL settle_offline_receipt() / issue_offline_grant() /
//     consume_offline_ticket() on a disposable postgres:16 with every
//     migration applied (./xc_pg_up.sh, XC_PG_URL). Without XC_PG_URL the
//     postgres half is `ignore`d — an ignored run is NOT a pass.

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
  signOfflineExecutionGrant,
  type OfflineGrantKey,
} from "../offlineSignature.ts";
import { activeReleasePolicyRow, HARNESS_RELEASE_POLICY } from "./releasePolicyFixture.ts";
import {
  fakeGoogleIdToken,
  loadHarness,
  SUPABASE_URL,
  userRequest,
  type RecordedCall,
} from "./routesHarness.ts";

const h = await loadHarness();

const RECEIPTS_PATH = "/v1/offline/receipts";
const SETTLE_RPC = "/rest/v1/rpc/settle_offline_receipt";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "attack-w04-04-key";
const RETIRED_KID = "attack-w04-04-retired-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-attack-w04-04";
const GRANT_ID = "64444444-4444-4444-8444-4444444444aa";
const TICKET_A = "65555555-5555-4555-8555-5555555555a1";
const TICKET_B = "65555555-5555-4555-8555-5555555555a2";
const DAY = 86_400;

const keyPair = await generateKeyPair("ES256", { extractable: true });
const retiredKeyPair = await generateKeyPair("ES256", { extractable: true });
const privateJwk = { ...(await exportJWK(keyPair.privateKey)), kid: KID };
const retiredPublicJwk = { ...(await exportJWK(retiredKeyPair.publicKey)), kid: RETIRED_KID };
const signingKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: KID,
  key: keyPair.privateKey,
};
const retiredSigningKey: OfflineGrantKey = {
  purpose: "offline_execution_grant",
  kid: RETIRED_KID,
  key: retiredKeyPair.privateKey,
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
    issuedAt?: number;
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
      expires_at: iso(issuedAt + 7 * DAY),
      entitlement_expires_at: null,
      ticket_ids: options.tickets ?? [TICKET_A, TICKET_B],
    },
    {
      issuer: ISSUER,
      ownerId,
      installationKeyId: INSTALLATION_KEY,
      release: options.release ?? RELEASE,
    },
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
    release: claims.release,
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
  grantId?: string;
}

async function receipt(options: ReceiptOptions): Promise<OfflineResultReceipt> {
  return {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: options.receiptId,
    ownerId: options.ownerId,
    installationKeyId: options.installationKeyId ?? options.claims.installationKeyId,
    grantId: options.grantId ?? options.claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(options.grant),
    ticket: options.ticket,
    lifecycleSequence: options.lifecycleSequence,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-attack-w04-04",
      elapsedMs: 120_000 * Math.min(options.lifecycleSequence, 1_000),
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

async function fixture(
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
  const resultId = `7000000${n % 10}-0404-4000-8000-a0000000${String(n).padStart(4, "0")}`;
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

// ---------------------------------------------------------------------------
// Durable RPC stand-in (same contract as the migration, keyed by caller+id).
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
let settleCallCount = 0;
let failSettleCallAt: number | null = null;

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  settleCallCount += 1;
  if (failSettleCallAt !== null && settleCallCount === failSettleCallAt) {
    return new Response(JSON.stringify({ code: "XX000", message: "injected rpc failure" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
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
  settleCallCount = 0;
  failSettleCallAt = null;
  Deno.env.set(SIGNING_ENV, JSON.stringify(privateJwk));
  h.respond = durableRespond;
}

async function post(body: unknown, token: string): Promise<Response> {
  return await h.handler(userRequest("POST", RECEIPTS_PATH, { token, body }));
}

interface RouteResult {
  receiptId: string;
  delivery: "settled" | "replayed" | "held" | "rejected";
  reconciliation: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

async function results(response: Response): Promise<RouteResult[]> {
  assertEquals(response.status, 200);
  const body = (await response.json()) as Record<string, unknown>;
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

function settleCalls(): SettleParams[] {
  return h.callsTo(SETTLE_RPC).map(settleParams);
}

// ---------------------------------------------------------------------------
// ATTACK R1 — release-policy rotation between offline execution and delayed
// delivery. The grant is server-signed under release policy v1 (the release
// the device executed under). Before the receipt arrives the release
// authority moves to v2 (a routine model/policy update). The grant's signed
// release binding is intact and the ticket ledger is authoritative for
// consumption, so a legitimately rendered rating must still settle.
// ---------------------------------------------------------------------------

async function rotatedReleasePolicyRow(): Promise<Record<string, unknown>> {
  const artifact = { version: "harness-2", sha256: "d".repeat(64) };
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
  const issuedAt = nowSeconds() - 3_600;
  const document: AnalysisReleasePolicyDocument = {
    ...HARNESS_RELEASE_POLICY,
    version: "harness-policy-2",
    validFrom: issuedAt,
    validUntil: issuedAt + 365 * DAY,
    mechanics: { lineage },
    benchmark: { ...HARNESS_RELEASE_POLICY.benchmark, lineage },
  };
  return {
    document,
    canonicalDocument: canonicalizeOfflineJson(document),
    denyNewAuthorizations: false,
    approval: {
      policy: { version: document.version, sha256: await digestCanonicalOfflineJson(document) },
      mechanicsApprovedAt: issuedAt,
      benchmarkApprovedAt: issuedAt,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  };
}

Deno.test(
  "ATTACK R1: a receipt for a grant signed under the previous release policy settles after the release authority rotates",
  async () => {
    reset();
    const user = freshUser();
    const executedUnderV1 = await fixture(user.sub, TICKET_A, 1);

    // Sanity: under the release it was issued with, the receipt settles.
    const before = await results(
      await post(
        {
          receipts: [
            {
              receipt: executedUnderV1.receipt,
              grant: executedUnderV1.grant,
              output: executedUnderV1.output,
            },
          ],
        },
        user.token,
      ),
    );
    assertEquals(before[0].delivery, "settled");

    // The release authority rotates; a second receipt from the same grant
    // (rendered offline before the rotation) arrives afterwards.
    h.rpcs.read_analysis_release_policy = await rotatedReleasePolicyRow();
    const late = await fixture(user.sub, TICKET_B, 2, { claims: executedUnderV1.claims });
    const after = await results(
      await post(
        { receipts: [{ receipt: late.receipt, grant: late.grant, output: late.output }] },
        user.token,
      ),
    );
    const params = settleCalls();
    assertEquals(params.length, 2);
    assertEquals(
      after[0].delivery,
      "settled",
      `release rotation stranded a signed, bound receipt: ${JSON.stringify(after[0])}, hold reason handed to the RPC: ${params[1].p_hold_reason}`,
    );
    assertEquals(params[1].p_hold_reason, null);
  },
);

// ---------------------------------------------------------------------------
// ATTACK R2 — key rotation. A grant signed by the now-retired key, whose
// lease already expired, is delivered inside the retired key's overlap window.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK R2: a delayed receipt for an expired grant signed by the retired key settles inside the overlap window",
  async () => {
    reset();
    const now = nowSeconds();
    const retiredAt = now - 9 * DAY;
    Deno.env.set(
      SIGNING_ENV,
      JSON.stringify({
        schemaVersion: 1,
        active: privateJwk,
        previous: {
          jwk: retiredPublicJwk,
          retiredAtEpochSeconds: retiredAt,
          overlapEndsAtEpochSeconds: retiredAt + 7 * DAY,
        },
      }),
    );
    const user = freshUser();
    // Signed 10 days ago by the retired key, expired 3 days ago.
    const claims = freeClaims(user.sub, { issuedAt: now - 10 * DAY });
    const old = await fixture(user.sub, TICKET_A, 1, { key: retiredSigningKey, claims });
    const out = await results(
      await post(
        { receipts: [{ receipt: old.receipt, grant: old.grant, output: old.output }] },
        user.token,
      ),
    );
    assertEquals(out[0].delivery, "settled", JSON.stringify(out[0]));
    assertEquals(settleCalls()[0].p_hold_reason, null);
  },
);

// ---------------------------------------------------------------------------
// ATTACK R3 — crash between steps: the durable RPC fails on the SECOND entry
// of a batch. The first entry was decided; the batch is 503; the redelivered
// batch must replay the first and settle the second — never settle the first
// twice.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK R3: a database failure mid-batch leaves decided entries decided; the redelivered batch replays them and settles the rest",
  async () => {
    reset();
    const user = freshUser();
    const first = await fixture(user.sub, TICKET_A, 1);
    const second = await fixture(user.sub, TICKET_B, 2, { claims: first.claims });
    const batch = {
      receipts: [
        { receipt: first.receipt, grant: first.grant, output: first.output },
        { receipt: second.receipt, grant: second.grant, output: second.output },
      ],
    };
    failSettleCallAt = 2;
    const failed = await post(batch, user.token);
    assertEquals(failed.status, 503);
    await failed.body?.cancel();
    assertEquals(durable.size, 1);

    const redelivered = await results(await post(batch, user.token));
    assertEquals(
      redelivered.map((r) => r.delivery),
      ["replayed", "settled"],
    );
    assertEquals(durable.size, 2);
    assertEquals([...durable.values()].filter((v) => v.row.delivery === "settled").length, 2);
  },
);

// ---------------------------------------------------------------------------
// ATTACK R4 — interleaved account switch on one device: user B's session
// delivers user A's receipt, then A delivers it. B's hold must not poison A.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK R4: another account delivering my receipt is held as owner_mismatch under THAT account and never blocks my own settlement",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const mine = await fixture(a.sub, TICKET_A, 1);
    const entry = { receipt: mine.receipt, grant: mine.grant, output: mine.output };

    const viaB = await results(await post({ receipts: [entry] }, b.token));
    assertEquals(viaB[0].delivery, "held");
    assertEquals(viaB[0].reconciliation?.reasonCode, "owner_mismatch");
    assertEquals(viaB[0].reconciliation?.financialDisposition, "reserved");

    const viaA = await results(await post({ receipts: [entry] }, a.token));
    assertEquals(viaA[0].delivery, "settled");
    assertEquals(viaA[0].reconciliation?.financialDisposition, "consumed");

    const calls = h.callsTo(SETTLE_RPC);
    assertEquals(calls.length, 2);
    assertEquals(calls[0].headers.authorization, `Bearer session-for-${b.sub}`);
    assertEquals(calls[1].headers.authorization, `Bearer session-for-${a.sub}`);
  },
);

// ---------------------------------------------------------------------------
// ATTACK R5 — clock boundaries at the route: a grant whose lease expired
// 30 days ago (long offline) settles; a grant with iat in the future does not.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK R5: a receipt for a lease that expired 30 days ago settles; a grant dated in the future is held",
  async () => {
    reset();
    const user = freshUser();
    const stale = await fixture(user.sub, TICKET_A, 1, {
      claims: freeClaims(user.sub, { issuedAt: nowSeconds() - 37 * DAY }),
    });
    const future = await fixture(user.sub, TICKET_B, 2, {
      claims: freeClaims(user.sub, {
        grantId: "64444444-4444-4444-8444-4444444444ab",
        issuedAt: nowSeconds() + 2 * DAY,
      }),
    });
    const out = await results(
      await post(
        {
          receipts: [
            { receipt: stale.receipt, grant: stale.grant, output: stale.output },
            { receipt: future.receipt, grant: future.grant, output: future.output },
          ],
        },
        user.token,
      ),
    );
    assertEquals(out[0].delivery, "settled", JSON.stringify(out[0]));
    assertEquals(out[1].delivery, "held", JSON.stringify(out[1]));
    assertEquals(out[1].reconciliation?.reasonCode, "evidence_ambiguous");
  },
);

// ---------------------------------------------------------------------------
// ATTACK R6 — network/back-pressure: once one account exhausts the route
// budget, its 429 answers reach no RPC (nothing is decided behind a 429),
// carry Retry-After, and another account on the same device is unaffected.
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK R6: a 429 batch decides nothing, carries Retry-After, and does not throttle another account",
  async () => {
    reset();
    const a = freshUser();
    const b = freshUser();
    const mine = await fixture(a.sub, TICKET_A, 1);
    const entry = { receipt: mine.receipt, grant: mine.grant, output: mine.output };
    let limited: Response | null = null;
    let accepted = 0;
    for (let i = 0; i < 40 && limited === null; i += 1) {
      const response = await post({ receipts: [entry] }, a.token);
      if (response.status === 429) {
        limited = response;
      } else {
        assertEquals(response.status, 200);
        accepted += 1;
        await response.body?.cancel();
      }
    }
    assert(limited, "expected a 429 within 40 deliveries");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    assert(Number.isInteger(retryAfter) && retryAfter > 0, `Retry-After=${retryAfter}`);
    await limited.body?.cancel();
    const rpcCallsBefore = h.callsTo(SETTLE_RPC).length;
    assertEquals(rpcCallsBefore, accepted);

    // Further deliveries by A stay 429 and still reach no RPC.
    const again = await post({ receipts: [entry] }, a.token);
    assertEquals(again.status, 429);
    await again.body?.cancel();
    assertEquals(h.callsTo(SETTLE_RPC).length, rpcCallsBefore);

    // B (same device, own grant) is not throttled by A's budget.
    const theirs = await fixture(b.sub, TICKET_B, 2, {
      claims: freeClaims(b.sub, { grantId: "64444444-4444-4444-8444-4444444444ac" }),
    });
    const out = await results(
      await post(
        { receipts: [{ receipt: theirs.receipt, grant: theirs.grant, output: theirs.output }] },
        b.token,
      ),
    );
    assertEquals(out[0].delivery, "settled");
  },
);

// ---------------------------------------------------------------------------
// Live postgres half.
// ---------------------------------------------------------------------------

const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
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
     values ('${U(n)}', 'attack-w04-04-${n}-${RUN}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'attack-w04-04-${n}-${RUN}', '${U(n)}', '{"sub":"attack-w04-04-${n}-${RUN}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${SESSION(n)}', '${U(n)}')`);
}

async function asUser(tx: Tx, n: number): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${U(n)}'`);
  await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${SESSION(n)}"}'`);
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

async function shotCount(sql: Sql, ticketId: string): Promise<number> {
  const [{ count }] = await sql.unsafe<{ count: string }[]>(
    `select count(*)::text as count from public.shots where offline_ticket_id = '${ticketId}'`,
  );
  return Number(count);
}

async function registerDevice(sql: Sql, n: number, key: string): Promise<void> {
  await inTx(sql, n, async (tx) => {
    const rows = await tx.unsafe<{ result: string }[]>(
      `select r.result from public.register_offline_device('${key}', 'production', true) r`,
    );
    assertEquals(rows[0].result, "accepted");
  });
}

async function issueGrant(
  sql: Sql,
  n: number,
  key: string,
): Promise<{ claims: OfflineExecutionGrantClaims; grant: OfflineSignedExecutionGrant }> {
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
  return { claims, grant: await sign(claims) };
}

async function liveReceipt(
  n: number,
  claims: OfflineExecutionGrantClaims,
  grant: OfflineSignedExecutionGrant,
  ticketId: string,
  tag: string,
  overrides: Partial<ReceiptOptions> = {},
  outputOverrides: Record<string, unknown> = {},
): Promise<{ receipt: OfflineResultReceipt; output: Record<string, unknown> }> {
  const resultId = crypto.randomUUID();
  const out = output(resultId, outputOverrides);
  const rec = await receipt({
    receiptId: `attack-${tag}-${RUN}`,
    ownerId: U(n),
    grant,
    claims,
    ticket: ticketRef(ticketId, claims),
    lifecycleSequence: 1,
    operationId: `attack-op-${tag}-${RUN}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    ...overrides,
  });
  return { receipt: rec, output: out };
}

// ---------------------------------------------------------------------------
// ATTACK L1 — grant refresh. issue_offline_grant() re-issues the installation's
// outstanding tickets under the NEXT generation (its documented behaviour and
// the only way a device keeps its tickets past a 7-day lease). A rating the
// device renders under the refreshed grant, naming the ticket exactly as the
// refreshed grant lists it, is the supported path and must settle.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L1 (live DB): a ticket re-issued under the next grant generation settles through a receipt bound to that grant",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 1);
      const key = KEY("refresh");
      await registerDevice(sql, 1, key);
      const gen1 = await issueGrant(sql, 1, key);
      assert(gen1.claims.allocation);
      const [ticketA, ticketB] = gen1.claims.allocation.ticketIds;

      // Lease refresh: same device, same outstanding tickets, generation 2.
      const gen2 = await issueGrant(sql, 1, key);
      assert(gen2.claims.allocation);
      assertNotEquals(gen2.claims.jti, gen1.claims.jti);
      assertEquals(gen2.claims.allocation.generation, gen1.claims.allocation.generation + 1);
      assertEquals([...gen2.claims.allocation.ticketIds].sort(), [ticketA, ticketB].sort());

      // The device rated offline under the refreshed grant.
      const late = await liveReceipt(1, gen2.claims, gen2.grant, ticketA, "gen2");
      const verdict = await inTx(sql, 1, (tx) => settle(tx, late.receipt, late.output, null));
      const events = await ledgerEvents(sql, ticketA);
      assertEquals(
        verdict.delivery,
        "settled",
        `refreshed-grant receipt did not settle: ${JSON.stringify(verdict)}; ledger=${events.join(",")}`,
      );
      assertEquals(verdict.financial_disposition, "consumed");
      assertEquals(events, ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);

      // The same ticket under the ORIGINAL grant still settles once (out of
      // order across generations is safe).
      const early = await liveReceipt(1, gen1.claims, gen1.grant, ticketB, "gen1");
      const first = await inTx(sql, 1, (tx) => settle(tx, early.receipt, early.output, null));
      assertEquals(first.delivery, "settled", JSON.stringify(first));
      assertEquals(await ledgerEvents(sql, ticketB), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L1b — a HOLD produced by the refreshed grant is permanent: the ticket
// stays counted as an offline hold, so the user's free-rating capacity is
// spent by a rating that was never recorded. Documents the blast radius of
// L1 when the previous assertion fails; passes trivially when L1 settles.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L1b (live DB): after a refreshed-grant receipt is decided, the ticket is either consumed (a recorded rating) or still consumable — never a permanent hold that also spends the budget",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 2);
      const key = KEY("refresh-b");
      await registerDevice(sql, 2, key);
      const gen1 = await issueGrant(sql, 2, key);
      const gen2 = await issueGrant(sql, 2, key);
      assert(gen1.claims.allocation && gen2.claims.allocation);
      const [ticketA] = gen2.claims.allocation.ticketIds;

      const late = await liveReceipt(2, gen2.claims, gen2.grant, ticketA, "gen2b");
      const verdict = await inTx(sql, 2, (tx) => settle(tx, late.receipt, late.output, null));
      const [{ held, scored }] = await inTx(sql, 2, (tx) =>
        tx.unsafe<{ held: number; scored: number }[]>(
          `select public.offline_hold_count() as held, public.lifetime_scored_count() as scored`,
        ),
      );
      if (verdict.delivery === "settled") {
        assertEquals(Number(scored), 1);
        return;
      }
      // Held: the redelivered receipt must not stay held forever while the
      // ticket keeps counting against the lifetime budget.
      const again = await inTx(sql, 2, (tx) => settle(tx, late.receipt, late.output, null));
      assert(
        !(
          again.delivery === "replayed" &&
          again.status === "reconciliation_required" &&
          Number(held) === 2 &&
          Number(scored) === 0
        ),
        `permanent hold + budget spent: verdict=${JSON.stringify(verdict)} replay=${JSON.stringify(
          again,
        )} offline_hold_count=${held} lifetime_scored_count=${scored}`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L2 — concurrency: eight connections deliver the SAME receipt at once.
// Exactly one settlement, one consumed event, one shot; the rest replay.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L2 (live DB): eight concurrent deliveries of one receipt consume the ticket exactly once",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 10, onnotice: () => {} });
    try {
      await createUser(sql, 3);
      const key = KEY("concurrent");
      await registerDevice(sql, 3, key);
      const { claims, grant } = await issueGrant(sql, 3, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const rec = await liveReceipt(3, claims, grant, ticketA, "race");

      const verdicts = await Promise.all(
        Array.from({ length: 8 }, () =>
          inTx(sql, 3, (tx) => settle(tx, rec.receipt, rec.output, null)),
        ),
      );
      const deliveries = verdicts.map((v) => v.delivery).sort();
      assertEquals(deliveries.filter((d) => d === "settled").length, 1, deliveries.join(","));
      assertEquals(deliveries.filter((d) => d === "replayed").length, 7, deliveries.join(","));
      for (const v of verdicts) {
        assertEquals(v.result, "accepted");
        assertEquals(v.financial_disposition, "consumed");
        assertEquals(v.result_id, rec.receipt.resultId);
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.offline_receipt_settlements where user_id = '${U(3)}'`,
      );
      assertEquals(count, "1");
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L3 — concurrency: two DIFFERENT receipts race for the same ticket.
// Exactly one consumes; the other is held as conflicting_receipt.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L3 (live DB): two different receipts racing for one ticket yield one consumption and one hold",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6, onnotice: () => {} });
    try {
      await createUser(sql, 4);
      const key = KEY("race2");
      await registerDevice(sql, 4, key);
      const { claims, grant } = await issueGrant(sql, 4, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const x = await liveReceipt(4, claims, grant, ticketA, "x");
      const y = await liveReceipt(4, claims, grant, ticketA, "y");

      const [vx, vy] = await Promise.all([
        inTx(sql, 4, (tx) => settle(tx, x.receipt, x.output, null)),
        inTx(sql, 4, (tx) => settle(tx, y.receipt, y.output, null)),
      ]);
      const deliveries = [vx.delivery, vy.delivery].sort();
      assertEquals(deliveries, ["held", "settled"], JSON.stringify([vx, vy]));
      const held = vx.delivery === "held" ? vx : vy;
      assertEquals(held.reason_code, "conflicting_receipt");
      assertEquals(held.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
      // Redelivering both replays each verdict — the hold never flips to a
      // second consumption, the settlement never flips to a hold.
      const [rx, ry] = await Promise.all([
        inTx(sql, 4, (tx) => settle(tx, x.receipt, x.output, null)),
        inTx(sql, 4, (tx) => settle(tx, y.receipt, y.output, null)),
      ]);
      assertEquals(rx, { ...vx, delivery: "replayed" });
      assertEquals(ry, { ...vy, delivery: "replayed" });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L4 — cross-account: user 6 forges a receipt in their own name for
// user 5's ticket/grant (no edge hold reason, as if the edge were bypassed).
// The ledger must stay untouched and user 5 must still settle.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L4 (live DB): another account cannot consume or poison my ticket, with or without an edge hold reason",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 5);
      await createUser(sql, 6);
      const key = KEY("victim");
      await registerDevice(sql, 5, key);
      const { claims, grant } = await issueGrant(sql, 5, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const mine = await liveReceipt(5, claims, grant, ticketA, "victim");

      // (a) attacker claims ownership of the receipt body itself.
      const forged = await receipt({
        receiptId: `attack-forged-${RUN}`,
        ownerId: U(6),
        grant,
        claims,
        ticket: ticketRef(ticketA, claims),
        lifecycleSequence: 1,
        operationId: `attack-op-forged-${RUN}`,
        resultId: mine.receipt.resultId,
        fullOutputSha256: mine.receipt.fullOutputSha256,
      });
      const forgedVerdict = await inTx(sql, 6, (tx) => settle(tx, forged, mine.output, null));
      assertEquals(forgedVerdict.result, "accepted");
      assertEquals(forgedVerdict.delivery, "held");
      assertEquals(forgedVerdict.reason_code, "evidence_ambiguous");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);

      // (b) attacker replays the victim's exact receipt (owner mismatch).
      const replayed = await inTx(sql, 6, (tx) => settle(tx, mine.receipt, mine.output, null));
      assertEquals(replayed.delivery, "held");
      assertEquals(replayed.reason_code, "owner_mismatch");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      // (c) the victim's own delivery still settles exactly once.
      const own = await inTx(sql, 5, (tx) => settle(tx, mine.receipt, mine.output, null));
      assertEquals(own.delivery, "settled", JSON.stringify(own));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      const [shot] = await sql.unsafe<{ user_id: string }[]>(
        `select user_id from public.shots where id = '${mine.receipt.resultId}'`,
      );
      assertEquals(shot.user_id, U(5));
      // The attacker's holds are recorded under the attacker only.
      const rows = await sql.unsafe<{ user_id: string; status: string }[]>(
        `select user_id, status from public.offline_receipt_settlements where ticket_id = '${ticketA}' order by id`,
      );
      assertEquals(
        rows.map((r) => [r.user_id, r.status]),
        [
          [U(6), "reconciliation_required"],
          [U(6), "reconciliation_required"],
          [U(5), "result_recorded"],
        ],
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L5 — unauthorised roles on the new SQL surface.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L5 (live DB): anon and service_role cannot execute settle_offline_receipt() or touch the settlements table",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 7);
      const key = KEY("roles");
      await registerDevice(sql, 7, key);
      const { claims, grant } = await issueGrant(sql, 7, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const rec = await liveReceipt(7, claims, grant, ticketA, "roles");

      for (const role of ["anon", "service_role"]) {
        for (const statement of [
          `select * from public.settle_offline_receipt(${lit(rec.receipt)}, '${await digestCanonicalOfflineJson(
            rec.receipt,
          )}', ${lit(rec.output)}, null)`,
          `select 1 from public.offline_receipt_settlements`,
          `delete from public.offline_receipt_settlements`,
        ]) {
          let code = "";
          try {
            await sql.begin(async (tx) => {
              await tx.unsafe(`set local role ${role}`);
              await tx.unsafe(`set local request.jwt.claim.sub = '${U(7)}'`);
              await tx.unsafe(statement);
            });
          } catch (error) {
            code = (error as { code?: string }).code ?? "";
          }
          assertEquals(code, "42501", `${role}: ${statement.slice(0, 60)}`);
        }
      }
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L6 — free-rating conservation: two receipts consume both tickets;
// the identity now has no free capacity anywhere; replays and abstentions
// never add a rating.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L6 (live DB): receipts spend exactly the two lifetime free ratings; replays and not_chargeable receipts add none",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 8);
      const key = KEY("budget");
      await registerDevice(sql, 8, key);
      const { claims, grant } = await issueGrant(sql, 8, key);
      assert(claims.allocation);
      const [ticketA, ticketB] = claims.allocation.ticketIds;

      const abstain = await liveReceipt(
        8,
        claims,
        grant,
        ticketA,
        "abstain",
        { billingDisposition: "not_chargeable" },
        { resultKind: "low_confidence", overallScore: null },
      );
      const va = await inTx(sql, 8, (tx) => settle(tx, abstain.receipt, abstain.output, null));
      assertEquals(va.delivery, "settled");
      assertEquals(va.financial_disposition, "reserved");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);

      const a = await liveReceipt(8, claims, grant, ticketA, "a");
      const b = await liveReceipt(8, claims, grant, ticketB, "b");
      assertEquals(
        (await inTx(sql, 8, (tx) => settle(tx, a.receipt, a.output, null))).delivery,
        "settled",
      );
      assertEquals(
        (await inTx(sql, 8, (tx) => settle(tx, b.receipt, b.output, null))).delivery,
        "settled",
      );
      for (let i = 0; i < 2; i += 1) {
        assertEquals(
          (await inTx(sql, 8, (tx) => settle(tx, a.receipt, a.output, null))).delivery,
          "replayed",
        );
        assertEquals(
          (await inTx(sql, 8, (tx) => settle(tx, b.receipt, b.output, null))).delivery,
          "replayed",
        );
      }
      const [{ scored, held }] = await inTx(sql, 8, (tx) =>
        tx.unsafe<{ scored: number; held: number }[]>(
          `select public.lifetime_scored_count() as scored, public.offline_hold_count() as held`,
        ),
      );
      assertEquals(Number(scored), 2);
      assertEquals(Number(held), 0);

      // No third rating anywhere: a new device gets no tickets, the online
      // path is paywalled.
      const key2 = KEY("budget-2");
      await registerDevice(sql, 8, key2);
      const refused = await inTx(sql, 8, (tx) =>
        tx.unsafe<{ result: string }[]>(
          `select r.result from public.issue_offline_grant('${key2}', 2) r`,
        ),
      );
      assertEquals(refused[0].result, "access.paywall_required");
      const [access] = await inTx(sql, 8, (tx) =>
        tx.unsafe<{ premium: boolean; scored_count: number; reserved_count: number }[]>(
          `select premium, scored_count, reserved_count from public.access_state()`,
        ),
      );
      assertEquals(access.premium, false);
      assertEquals(Number(access.scored_count), 2);
      assertEquals(Number(access.reserved_count), 0);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L7 — the ticket was returned (released) before its receipt arrived.
// The receipt must HOLD, and the release must stand (no un-release, no shot).
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L7 (live DB): a receipt for a ticket the device already returned is held; nothing is consumed or un-released",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 9);
      const key = KEY("released");
      await registerDevice(sql, 9, key);
      const { claims, grant } = await issueGrant(sql, 9, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const rec = await liveReceipt(9, claims, grant, ticketA, "released");
      const released = await inTx(sql, 9, (tx) =>
        tx.unsafe<{ v: string }[]>(
          `select public.release_offline_ticket('${ticketA}', 'unused_ticket_returned') as v`,
        ),
      );
      assertEquals(released[0].v, "accepted");
      const verdict = await inTx(sql, 9, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(verdict.delivery, "held", JSON.stringify(verdict));
      assertEquals(verdict.reason_code, "conflicting_receipt");
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "released"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      const again = await inTx(sql, 9, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(again, { ...verdict, delivery: "replayed" });
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L8 — boundary: lifecycleSequence at 2^31. The shared receipt
// contract admits any positive safe integer; a receipt valid under the
// contract must get a durable verdict (settled or held), never a
// non-durable "invalid input" that the device treats as terminal.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L8 (live DB): a receipt with lifecycleSequence 2^31 (valid per the shared contract) receives a durable verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 10);
      const key = KEY("int4");
      await registerDevice(sql, 10, key);
      const { claims, grant } = await issueGrant(sql, 10, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const rec = await liveReceipt(10, claims, grant, ticketA, "int4", {
        lifecycleSequence: 2 ** 31,
      });
      const verdict = await inTx(sql, 10, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(
        verdict.result,
        "accepted",
        `contract-valid receipt refused as ${JSON.stringify(verdict)}: shared-types admits lifecycleSequence up to 2^53-1, the RPC casts to int4`,
      );
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L9 — out-of-order delivery across queues: the receipt arrives before
// the session it names has synced. That is a transient condition, not
// evidence against the receipt; the settlement must not become a PERMANENT
// hold that survives the session's arrival.
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L9 (live DB): a receipt delivered before its session syncs is not permanently stranded once the session exists",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 11);
      const key = KEY("session");
      await registerDevice(sql, 11, key);
      const { claims, grant } = await issueGrant(sql, 11, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const sessionId = crypto.randomUUID();
      const rec = await liveReceipt(11, claims, grant, ticketA, "session", {}, { sessionId });

      const early = await inTx(sql, 11, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);

      // The session syncs (as the app's outbox would), then the device
      // redelivers the very same receipt.
      await sql.unsafe(
        `insert into public.sessions (id, user_id, started_at) values ('${sessionId}', '${U(11)}', now())`,
      );
      const late = await inTx(sql, 11, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(
        late.status,
        "result_recorded",
        `first=${JSON.stringify(early)} after-session-sync=${JSON.stringify(late)}`,
      );
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
    } finally {
      await sql.end();
    }
  },
});

// ---------------------------------------------------------------------------
// ATTACK L10 — process death between the RPC and its commit: a transaction
// that ran the settlement and then died must leave nothing behind, and the
// redelivery settles for real (not "replayed" against a ghost).
// ---------------------------------------------------------------------------

Deno.test({
  name: "ATTACK L10 (live DB): a settlement whose transaction dies before commit leaves no shot, ledger row or verdict; redelivery settles",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      await createUser(sql, 12);
      const key = KEY("crash");
      await registerDevice(sql, 12, key);
      const { claims, grant } = await issueGrant(sql, 12, key);
      assert(claims.allocation);
      const [ticketA] = claims.allocation.ticketIds;
      const rec = await liveReceipt(12, claims, grant, ticketA, "crash");

      let died = false;
      try {
        await inTx(sql, 12, async (tx) => {
          const v = await settle(tx, rec.receipt, rec.output, null);
          assertEquals(v.delivery, "settled");
          throw new Error("process died before commit");
        });
      } catch (error) {
        died = (error as Error).message === "process died before commit";
      }
      assert(died);
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated"]);
      assertEquals(await shotCount(sql, ticketA), 0);
      const [{ count }] = await sql.unsafe<{ count: string }[]>(
        `select count(*)::text as count from public.offline_receipt_settlements where user_id = '${U(12)}'`,
      );
      assertEquals(count, "0");

      const redelivered = await inTx(sql, 12, (tx) => settle(tx, rec.receipt, rec.output, null));
      assertEquals(redelivered.delivery, "settled", JSON.stringify(redelivered));
      assertEquals(await ledgerEvents(sql, ticketA), ["allocated", "consumed"]);
      assertEquals(await shotCount(sql, ticketA), 1);
    } finally {
      await sql.end();
    }
  },
});
