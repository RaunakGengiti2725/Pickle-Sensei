// W04-04 ADVERSARIAL ATTACKS — edge route half.
//
// The REAL edge handler through routesHarness (Supabase stubbed at the fetch
// layer with a durable settlement stand-in keyed exactly like the RPC),
// attacked at the boundaries the candidate's own suite does not pin:
//
//   B1 batch bounds     — 0 and 26 entries, a non-array, a body over the cap,
//                         and a full 25-entry batch whose malformed neighbours
//                         must not poison the valid entries.
//   B2 network failure  — the settlement RPC failing (5xx, 429) on the SECOND
//                         entry after the first settled: the batch is a generic
//                         503, nothing is refunded, and the redelivery replays
//                         the first entry and settles the second exactly once
//                         (no new operation id, no second charge); the lineage
//                         RPC failing → 503 before any settlement.
//   B3 roles            — no bearer, the service-role key as bearer, and a
//                         bearer whose session is no longer active.
//   B4 clock            — a grant whose issuer clock is ahead of the edge
//                         (iat in the future) and a grant long expired: the
//                         expired one settles (documented), the future one never
//                         settles a charge on the strength of an unverifiable
//                         signature.
//   B5 copy             — no error message the route emits names Android,
//                         Google Play, guest mode, Live Court, DUPR, a
//                         competitor, an accuracy percentage or a superlative.
//   B6 freeze           — the active release under an operator deny-new freeze
//                         (approved, NOT withdrawn): what happens to a completed
//                         chargeable receipt, and whether lifting the freeze
//                         lets the redelivery settle.
//
// On BASE_SHA the route answers 404, so every test fails there.

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
import { digestCanonicalOfflineJson, digestOfflineGrantTransport } from "../canonicalDigest.ts";
import {
  importOfflineGrantVerificationKey,
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
const LINEAGE_RPC = "/rest/v1/rpc/read_analysis_release_policy_lineage";
const ISSUER = `${SUPABASE_URL}/functions/v1/api`;
const KID = "w04-04-attack-route-key";
const SIGNING_ENV = "OFFLINE_GRANT_SIGNING_JWK";
const INSTALLATION_KEY = "ios-installation-w04-04-attack";
const GRANT = (n: number): string => `64444444-4444-4444-8444-4444444444${String(n).padStart(2, "0")}`;
const TICKETS = Array.from(
  { length: 60 },
  (_, i) => `65555555-5555-4555-8555-5555555555${String(i).padStart(2, "0")}`,
);
/** A free grant carries at most two tickets: receipt n rides its own grant. */
const ticketsFor = (n: number): string[] => [TICKETS[2 * n], TICKETS[2 * n + 1]];
const DAY = 86_400;

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
  const sub = `aaaaaaaa-0404-4000-8000-a7a7${String(userSeq).padStart(8, "0")}`;
  return { sub, token: fakeGoogleIdToken(sub) };
}

function freeClaims(
  ownerId: string,
  options: { issuedAt?: number; tickets?: string[]; grantId?: string } = {},
): OfflineExecutionGrantClaims {
  const issuedAt = options.issuedAt ?? nowSeconds() - 60;
  return offlineGrantClaimsFromIssuance(
    {
      result: "accepted",
      grant_id: options.grantId ?? GRANT(0),
      generation: 3,
      entitlement_source: "identity_lifetime_free",
      issued_at: iso(issuedAt),
      expires_at: iso(issuedAt + 7 * DAY),
      entitlement_expires_at: null,
      ticket_ids: options.tickets ?? ticketsFor(0),
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
  n: number,
  options: { claims?: OfflineExecutionGrantClaims; grant?: OfflineSignedExecutionGrant } = {},
): Promise<Fixture> {
  const claims = options.claims ?? freeClaims(ownerId, { grantId: GRANT(n), tickets: ticketsFor(n) });
  const grant = options.grant ?? (await sign(claims));
  const resultId = `7a7a${String(n).padStart(4, "0")}-0404-4000-8000-${String(n).padStart(12, "0")}`;
  const out = output(resultId);
  const rec: OfflineResultReceipt = {
    schemaVersion: OFFLINE_RESULT_RECEIPT_SCHEMA_VERSION,
    receiptId: `attack-receipt-${n}`,
    ownerId,
    installationKeyId: claims.installationKeyId,
    grantId: claims.jti,
    grantJwsSha256: await digestOfflineGrantTransport(grant),
    ticket: ticketRef(claims.allocation?.ticketIds[0] ?? TICKETS[0], claims),
    lifecycleSequence: n + 1,
    nativeTime: {
      schemaVersion: OFFLINE_NATIVE_TIME_SCHEMA_VERSION,
      clock: "ios_mach_continuous_time",
      anchorId: "anchor-w04-04-attack",
      elapsedMs: 120_000 * (n + 1),
    },
    attestation: {
      schemaVersion: OFFLINE_APP_ATTEST_EVIDENCE_SCHEMA_VERSION,
      format: "apple_app_attest",
      kind: "assertion",
      environment: "production",
      dataBase64Url: "QUJDRA",
      clientDataSha256: "c".repeat(64),
    },
    operationId: `attack-operation-${n}`,
    resultId,
    fullOutputSha256: await digestCanonicalOfflineJson(out),
    billingDisposition: "joint_verification_required",
  };
  return { claims, grant, receipt: rec, output: out };
}

const entryOf = (f: Fixture) => ({ receipt: f.receipt, grant: f.grant, output: f.output });

// ---------------------------------------------------------------------------
// Durable settlement stand-in (same key as the RPC: caller × receiptId × digest)
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
/** Fail the Nth settlement RPC call (1-based) with this HTTP status. */
let failSettleCall: { nth: number; status: number; retryAfter?: string } | null = null;

function settleParams(call: RecordedCall): SettleParams {
  assert(call.body && typeof call.body === "object", "rpc body must be an object");
  return call.body as SettleParams;
}

function durableRespond(call: RecordedCall): Response | null {
  if (!call.url.endsWith(SETTLE_RPC)) return null;
  settleCallCount += 1;
  if (failSettleCall && settleCallCount === failSettleCall.nth) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (failSettleCall.retryAfter) headers["Retry-After"] = failSettleCall.retryAfter;
    return new Response(JSON.stringify({ code: "XX000", message: "injected failure" }), {
      status: failSettleCall.status,
      headers,
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
  settleCallCount = 0;
  failSettleCall = null;
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
  const body = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(body));
  assert(Array.isArray(body.results), "results[] expected");
  return body.results as RouteResult[];
}

const consumedCount = (): number =>
  [...durable.values()].filter((v) => v.row.financial_disposition === "consumed").length;

/** Words APP_STORE_SUBMISSION.md forbids in anything a user could read. */
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*%|\bbest\b|most accurate|as good as a coach|world.class|#1\b/i;

const emitted: string[] = [];
function collectCopy(body: Record<string, unknown>): void {
  const walk = (value: unknown): void => {
    if (typeof value === "string") emitted.push(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(body);
}

// ---------------------------------------------------------------------------
// B1 — batch bounds
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK B1 batch bounds: 0 entries, 26 entries, a non-array and a non-object body are 400 with no settlement call; a body over the cap is refused before any settlement",
  async () => {
    reset();
    const user = freshUser();
    const one = await fixture(user.sub, 0);
    const twentySix = await Promise.all(Array.from({ length: 26 }, (_, i) => fixture(user.sub, i)));

    for (const body of [
      { receipts: [] },
      { receipts: twentySix.map(entryOf) },
      { receipts: { 0: entryOf(one) } },
      { receipts: null },
      { receipts: "x" },
      {},
    ]) {
      const response = await post(body, user.token);
      const json = await readJson(response);
      collectCopy(json);
      assertEquals(response.status, 400, JSON.stringify(json));
      assertEquals((json.error as { code: string }).code, "offline.invalid_input");
    }
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);

    // Oversized body: 25 entries padded past 2,000,000 bytes.
    const padded = twentySix.slice(0, 25).map((f) => ({
      ...entryOf(f),
      output: { ...f.output, padding: "x".repeat(90_000) },
    }));
    const oversize = await post({ receipts: padded }, user.token);
    const oversizeJson = await readJson(oversize);
    collectCopy(oversizeJson);
    assert(
      oversize.status === 400 || oversize.status === 413,
      `oversize body answered ${oversize.status}: ${JSON.stringify(oversizeJson)}`,
    );
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    assertEquals(durable.size, 0);
  },
);

Deno.test(
  "ATTACK B1 batch bounds: a full 25-entry batch with malformed neighbours (null, string, missing grant, non-object output, forged owner) settles every valid entry exactly once and rejects each bad one individually",
  async () => {
    reset();
    const user = freshUser();
    const valid = await Promise.all(Array.from({ length: 20 }, (_, i) => fixture(user.sub, i)));
    const other = freshUser();
    const foreign = await fixture(other.sub, 21);
    const entries: unknown[] = [
      null,
      "receipt",
      { receipt: valid[0].receipt, output: valid[0].output },
      { receipt: valid[0].receipt, grant: valid[0].grant, output: "scored" },
      entryOf(foreign),
      ...valid.map(entryOf),
    ];
    assertEquals(entries.length, 25);
    const out = await results(await post({ receipts: entries }, user.token));
    collectCopy({ out });
    assertEquals(out.length, 25);
    for (let i = 0; i < 4; i += 1) {
      assertEquals(out[i].delivery, "rejected", JSON.stringify(out[i]));
      assert(out[i].error, "rejected entries carry an error");
    }
    assertEquals(out[4].delivery, "held");
    assertEquals(out[4].reconciliation?.reasonCode, "owner_mismatch");
    for (let i = 5; i < 25; i += 1) {
      assertEquals(out[i].delivery, "settled", JSON.stringify(out[i]));
      assertEquals(out[i].receiptId, valid[i - 5].receipt.receiptId);
    }
    assertEquals(consumedCount(), 20);
    assertEquals(h.callsTo(SETTLE_RPC).length, 21);

    // The same batch again: every valid entry replays, nothing settles twice.
    const again = await results(await post({ receipts: entries }, user.token));
    assertEquals(again.filter((r) => r.delivery === "replayed").length, 21);
    assertEquals(again.filter((r) => r.delivery === "settled").length, 0);
    assertEquals(consumedCount(), 20);
  },
);

// ---------------------------------------------------------------------------
// B2 — network failure at each step
// ---------------------------------------------------------------------------

for (const [label, status, retryAfter] of [
  ["500", 500, undefined],
  ["429 + Retry-After", 429, "7"],
  ["503", 503, undefined],
] as const) {
  Deno.test(
    `ATTACK B2 network: settlement RPC answers ${label} on the 2nd of 3 entries → generic 503, first entry stays durably settled, redelivery replays it and settles the rest once (no new operation, no second charge)`,
    async () => {
      reset();
      const user = freshUser();
      const three = await Promise.all([0, 1, 2].map((i) => fixture(user.sub, i)));
      failSettleCall = { nth: 2, status, retryAfter };
      const first = await post({ receipts: three.map(entryOf) }, user.token);
      const firstJson = await readJson(first);
      collectCopy(firstJson);
      assertEquals(first.status, 503, JSON.stringify(firstJson));
      assert(
        !JSON.stringify(firstJson).includes("injected failure"),
        `5xx body leaked upstream detail: ${JSON.stringify(firstJson)}`,
      );
      assertEquals(h.callsTo(SETTLE_RPC).length, 2);
      assertEquals(consumedCount(), 1);

      // Retry after the failure: the outbox resends the identical batch.
      failSettleCall = null;
      const retry = await results(await post({ receipts: three.map(entryOf) }, user.token));
      assertEquals(
        retry.map((r) => r.delivery),
        ["replayed", "settled", "settled"],
      );
      assertEquals(consumedCount(), 3);
      const ops = h.callsTo(SETTLE_RPC).map((c) => settleParams(c).p_receipt.operationId);
      assertEquals(new Set(ops).size, 3, `operation ids re-minted: ${ops}`);
      assertEquals(
        [...durable.values()].map((v) => v.row.result_id).sort(),
        three.map((f) => f.receipt.resultId).sort(),
      );
    },
  );
}

Deno.test(
  "ATTACK B2 network: the lineage RPC failing for a grant under a non-active release is a 503 before any settlement; the active-policy read failing is a 503 before any settlement",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, 0);
    // Make the active policy a different one so the grant's lineage must be read.
    const rotated = { ...releasePolicyRow, approval: { ...(releasePolicyRow.approval as Record<string, unknown>), policy: { version: "other", sha256: "e".repeat(64) } } };
    h.rpcs.read_analysis_release_policy = rotated;
    h.respond = (call) => {
      if (call.url.endsWith(LINEAGE_RPC)) {
        return new Response(JSON.stringify({ code: "XX000", message: "injected failure" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      return durableRespond(call);
    };
    const response = await post({ receipts: [entryOf(f)] }, user.token);
    const json = await readJson(response);
    collectCopy(json);
    assertEquals(response.status, 503, JSON.stringify(json));
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    assertEquals(durable.size, 0);

    reset();
    h.rpcErrors.read_analysis_release_policy = 500;
    const second = await post({ receipts: [entryOf(f)] }, user.token);
    const secondJson = await readJson(second);
    collectCopy(secondJson);
    assertEquals(second.status, 503, JSON.stringify(secondJson));
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
  },
);

// ---------------------------------------------------------------------------
// B3 — roles at the route
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK B3 roles: no bearer, the service-role key as bearer, an inactive session and a foreign-account bearer never reach a settlement in the owner's name",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, 0);
    const entry = { receipts: [entryOf(f)] };

    const anon = await h.handler(
      new Request(`http://edge.test${RECEIPTS_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry),
      }),
    );
    collectCopy(await readJson(anon));
    assertEquals(anon.status, 401);

    const service = await post(entry, "service-role-test-key");
    collectCopy(await readJson(service));
    assert(service.status === 401 || service.status === 403, `service bearer got ${service.status}`);

    h.rpcs.is_api_session_active = false;
    const stale = await post(entry, user.token);
    const staleJson = await readJson(stale);
    collectCopy(staleJson);
    assert(stale.status === 401 || stale.status === 403, `inactive session got ${stale.status}`);
    assertEquals(h.callsTo(SETTLE_RPC).length, 0);
    assertEquals(durable.size, 0);

    // Another signed-in account delivering the owner's receipt: HELD in the
    // caller's namespace, never a consumption for anyone.
    h.rpcs.is_api_session_active = true;
    const other = freshUser();
    const out = await results(await post(entry, other.token));
    assertEquals(out[0].delivery, "held");
    assertEquals(out[0].reconciliation?.reasonCode, "owner_mismatch");
    assertEquals(out[0].reconciliation?.ownerId, f.receipt.ownerId);
    assertEquals(consumedCount(), 0);
    assertEquals(h.callsTo(SETTLE_RPC)[0].headers.authorization, `Bearer session-for-${other.sub}`);
  },
);

// ---------------------------------------------------------------------------
// B4 — clocks
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK B4 clocks: a grant whose issuer clock is a day ahead never settles a charge, while a grant that expired weeks ago still settles its completed work once",
  async () => {
    reset();
    const user = freshUser();
    const ahead = await fixture(user.sub, 0, {
      claims: freeClaims(user.sub, { issuedAt: nowSeconds() + DAY, grantId: GRANT(0), tickets: ticketsFor(0) }),
    });
    const aheadOut = await results(await post({ receipts: [entryOf(ahead)] }, user.token));
    collectCopy({ aheadOut });
    assertNotEquals(aheadOut[0].delivery, "settled", JSON.stringify(aheadOut[0]));
    assertNotEquals(aheadOut[0].reconciliation?.financialDisposition, "consumed");
    assertEquals(consumedCount(), 0);

    const expired = await fixture(user.sub, 1, {
      claims: freeClaims(user.sub, { issuedAt: nowSeconds() - 30 * DAY, grantId: GRANT(1), tickets: ticketsFor(1) }),
    });
    assert(expired.claims.exp < nowSeconds(), "fixture: grant expired");
    const expiredOut = await results(await post({ receipts: [entryOf(expired)] }, user.token));
    assertEquals(expiredOut[0].delivery, "settled", JSON.stringify(expiredOut[0]));
    const again = await results(await post({ receipts: [entryOf(expired)] }, user.token));
    assertEquals(again[0].delivery, "replayed");
    assertEquals(consumedCount(), 1);
  },
);

// ---------------------------------------------------------------------------
// B6 — operator freeze on the active release
// ---------------------------------------------------------------------------

Deno.test(
  "ATTACK B6 freeze: a completed chargeable receipt under the ACTIVE, approved, non-withdrawn release during a deny-new freeze — and the same receipt redelivered once the freeze is lifted",
  async () => {
    reset();
    const user = freshUser();
    const f = await fixture(user.sub, 0);
    const base = releasePolicyRow.approval as Record<string, unknown>;
    const frozen = {
      ...releasePolicyRow,
      denyNewAuthorizations: true,
      approval: { ...base, withdrawnAt: null, denyNewAuthorizations: true },
    };
    h.rpcs.read_analysis_release_policy = frozen;
    const during = await results(await post({ receipts: [entryOf(f)] }, user.token));
    collectCopy({ during });
    assertEquals(during[0].delivery, "held", JSON.stringify(during[0]));
    assertEquals(during[0].reconciliation?.reasonCode, "grant_revoked");
    assertEquals(during[0].reconciliation?.financialDisposition, "reserved");
    assertEquals(consumedCount(), 0);

    // The operator lifts the freeze (same policy re-activated, nothing withdrawn).
    h.rpcs.read_analysis_release_policy = releasePolicyRow;
    const after = await results(await post({ receipts: [entryOf(f)] }, user.token));
    // A temporary freeze must not turn work completed under an approved
    // release into a permanent reconciliation hold: once lifted, the
    // redelivery settles.
    assertEquals(
      after[0].delivery,
      "settled",
      `after the freeze lifted the redelivery was ${after[0].delivery}: ${JSON.stringify(after[0].reconciliation)}`,
    );
    assertEquals(consumedCount(), 1);
  },
);

// ---------------------------------------------------------------------------
// B5 — copy (runs last: every message the route emitted above is inspected)
// ---------------------------------------------------------------------------

Deno.test("ATTACK B5 copy: no message the route emitted names a forbidden term", () => {
  assert(emitted.length > 0, "the earlier attacks must have collected route copy");
  const offending = emitted.filter((text) => FORBIDDEN_COPY.test(text));
  assertEquals(offending, []);
});
