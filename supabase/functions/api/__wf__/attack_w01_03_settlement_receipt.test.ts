// W01-03 ADVERSARY — attacks on the settlement receipt / replay boundary at
// candidate d5469efcd87a5190c1ff0b76d23575ec1155c67d (devin/pp/w01-03/impl-r2).
//
// Every test is an ATTACK: it asserts the behaviour the work package promises
// ("identical replay ⇒ the original receipt, nothing spent; mismatched replay
// ⇒ rejected BEFORE any credit, permit, free rating or sequence is consumed";
// identity semantics consistent with the database) and FAILS when the
// candidate breaks it. A passing attack is evidence the boundary held.
//
// Two halves, black-box like the candidate's own suite:
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer);
//   * the REAL apply_synced_shot(jsonb) on a disposable PostgreSQL with every
//     migration applied (XC_PG_URL). Without XC_PG_URL the pg half is
//     `ignore`d — an ignored run is NOT a pass.
//
// Fixtures are built here so the file runs unchanged against BASE_SHA.
// Nothing here touches the candidate's production code or its tests.

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const RECEIPTS_TABLE = "/rest/v1/settlement_receipts";
const MISMATCH_CODE = "shot.receipt_mismatch";
const WRITE_FAILED_CODE = "shot.write_failed";
const SHA256_HEX = /^[0-9a-f]{64}$/;

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

const artifact = { version: "attack-fixture-1", sha256: "b".repeat(64) };
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
const NOW = Math.floor(Date.now() / 1000);
function policyDocument(version: string): AnalysisReleasePolicyDocument {
  return {
    schemaVersion: "analysis-release-policy-v1",
    version,
    validFrom: NOW - 86_400,
    validUntil: NOW + 86_400,
    mechanics: { lineage },
    benchmark: {
      lineage,
      uncertainty: {
        kind: "calibrated_prediction_interval",
        nominalCoverage: 0.9,
        coverageScope: "supported_slice",
        calibrationUnit: "player_session",
      },
      maximumIntervalWidth: 1.5,
      boundaryStep: 0.25,
      supportedIntervals: [{ lower: 3, upper: 5 }],
    },
    supportedInputs: [
      { shotType: "dink", cameraView: "side", handedness: "right", captureMode: "imported_video" },
    ],
  };
}
const document = policyDocument("attack-policy-1");

/** What read_analysis_release_policy() returns (migration 20260908020000). */
async function authority(doc: AnalysisReleasePolicyDocument = document) {
  return {
    document: doc,
    canonicalDocument: canonicalizeOfflineJson(doc),
    denyNewAuthorizations: false,
    approval: {
      policy: { version: doc.version, sha256: await digestCanonicalOfflineJson(doc) },
      mechanicsApprovedAt: doc.validFrom,
      benchmarkApprovedAt: doc.validFrom,
      withdrawnAt: null as number | null,
      denyNewAuthorizations: false,
    },
  };
}

const CLAIMS = {
  installationKeyId: "ik_attack_0d8f5e1c4a2b",
  grant: { grantId: "grant_attack_0001", grantJwsSha256: "d".repeat(64) },
  ticket: { allocationId: "alloc_attack_0001", generation: 2, ticketId: "ticket_attack_0001" },
  operationId: "op_attack_2b4d-4e6f-8a9b-0c1d2e3f4a5b",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ReceiptTransport {
  canonical: string;
  sha256: string;
}

interface Receipt {
  schemaVersion: number;
  kind: string;
  binding: Record<string, unknown> & { shotId: string; ownerId: string };
  bindingSha256: string;
  policy: Record<string, unknown> | null;
}

// ── Edge half ────────────────────────────────────────────────────────────────

let subject = 0;
function signIn(): { token: string; ip: string; userId: string } {
  subject += 1;
  const userId = `7a010300-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.tables.settlement_receipts = [];
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: `203.0.113.${subject}`, userId };
}

function shot(
  resultKind: "scored" | "low_confidence" | "partial",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-08T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore: resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [{ key: "backswing", startMs: 0, representativeMs: 200, endMs: 400, confidence: 0.9 }],
    checkpoints: [
      {
        key: "paddle_height",
        score: 71,
        confidence: 0.8,
        band: "green",
        direction: "up",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: VERSION_VECTOR,
    settlement: structuredClone(CLAIMS),
    ...overrides,
  };
}

interface SyncBody {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
  receipts?: Array<{ id: string } & ReceiptTransport>;
}

async function sync(auth: { token: string; ip: string }, shots: unknown[]) {
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
  );
  return { status: response.status, body: (await response.json()) as SyncBody };
}

function transportOf(value: unknown): ReceiptTransport {
  assert(isRecord(value), "settlementReceipt must be an object");
  assert(typeof value.canonical === "string", "settlementReceipt.canonical is a string");
  assert(typeof value.sha256 === "string" && SHA256_HEX.test(value.sha256));
  return { canonical: value.canonical, sha256: value.sha256 };
}

function receiptFor(body: SyncBody, id: string): ReceiptTransport {
  assert(Array.isArray(body.receipts), "response carries receipts");
  const entry = body.receipts.find((r) => r.id === id);
  assert(entry, `receipt for ${id} in the response`);
  return transportOf(entry);
}

function storeReceipt(userId: string, shotId: string, transport: ReceiptTransport) {
  h.tables.shots = [{ id: shotId, user_id: userId }];
  h.tables.settlement_receipts = [
    {
      shot_id: shotId,
      user_id: userId,
      receipt_canonical: transport.canonical,
      receipt_sha256: transport.sha256,
    },
  ];
}

/** Settle one scored shot through the edge and persist its receipt in the
 * stubbed tables exactly as PostgreSQL would (uuid columns are lower-case). */
async function settled(auth: { token: string; ip: string; userId: string }) {
  h.rpcs.read_analysis_release_policy = await authority();
  const scored = shot("scored");
  const first = await sync(auth, [scored]);
  assertEquals(first.status, 200, JSON.stringify(first.body));
  assertEquals(first.body.acceptedIds, [scored.id]);
  const original = receiptFor(first.body, scored.id);
  storeReceipt(auth.userId, scored.id, original);
  h.calls.length = 0;
  return { scored, original };
}

// ATTACK E1 — boundary / duplicate identity: the same UUID in a different case.
// The edge's own validator admits upper-case UUIDs (UUID_RE is /i) and
// PostgreSQL's uuid type treats the two spellings as ONE identity, so the
// replay decision must too: an identical settlement re-sent with its id
// upper-cased is the same settlement and must be answered with the original
// receipt WITHOUT reaching the chargeable RPC. (The harness returns every
// stored receipt row for the owner — a superset of PostgREST's uuid-typed
// `in.(...)` match — so a miss here is the edge's own keying, not the stub.)
Deno.test(
  "ATTACK W01-03 E1: an identical settlement replayed with its UUID upper-cased is the same identity — original receipt, no RPC",
  async () => {
    const auth = signIn();
    const { scored, original } = await settled(auth);
    const replay = { ...structuredClone(scored), id: scored.id.toUpperCase() };
    const result = await sync(auth, [replay]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      0,
      `a replay of an owned, receipted shot must be decided before the chargeable RPC; response=${
        JSON.stringify({ acceptedIds: result.body.acceptedIds, rejected: result.body.rejected })
      }`,
    );
    assertEquals(result.body.rejected, []);
    assertEquals(result.body.acceptedIds.map((id) => id.toLowerCase()), [scored.id]);
    assertEquals(receiptFor(result.body, result.body.acceptedIds[0]), original);
  },
);

// ATTACK E2 — network failure at the receipt read: a 5xx / 429 / redirect from
// the settlement_receipts lookup must fail the WHOLE batch retryably (the
// outbox keeps every row) and must not fabricate a fresh settlement: no
// authority read, no chargeable RPC, no partial acceptance.
Deno.test(
  "ATTACK W01-03 E2: a failing stored-receipt read is retryable for the batch — no RPC, no authority read, nothing accepted",
  async () => {
    for (const status of [500, 429, 503, 307]) {
      const auth = signIn();
      const { scored } = await settled(auth);
      h.respond = (call) =>
        call.url.includes(RECEIPTS_TABLE) && call.method === "GET"
          ? new Response(status === 307 ? null : JSON.stringify({ message: "injected" }), {
            status,
            headers: status === 307
              ? { Location: "https://elsewhere.invalid/" }
              : status === 429
              ? { "Retry-After": "7", "Content-Type": "application/json" }
              : { "Content-Type": "application/json" },
          })
          : null;
      const result = await sync(auth, [structuredClone(scored), shot("scored")]);
      assertEquals(result.status, 503, `status ${status}: ${JSON.stringify(result.body)}`);
      assertEquals(h.callsTo(APPLY_RPC).length, 0, `status ${status}: RPC must not run`);
      assertEquals(h.callsTo(POLICY_RPC).length, 0, `status ${status}: no authority read`);
      assert(!("acceptedIds" in result.body), `status ${status}: no partial acceptance`);
    }
  },
);

// ATTACK E3 — duplicate identities INSIDE one batch: the outbox drains up to
// 200 rows; two entries wearing the same id where the second is a mutated
// twin. The batched replay lookup ran BEFORE either was written, so the edge
// cannot see the first commit; the database does (P7 pins the real verdict:
// the second RPC call is `shot.receipt_mismatch`). The RPC stub here answers
// exactly as the database does, and the edge must relay one acceptance, one
// typed mismatch, one receipt — never two acceptances for one id.
Deno.test(
  "ATTACK W01-03 E3: a mutated twin of a shot in the same batch is relayed as one acceptance + one typed mismatch, one receipt",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const twin = structuredClone(scored);
    twin.overallScore = 7.6;
    let applies = 0;
    h.respond = (call) =>
      call.url.includes(APPLY_RPC)
        ? new Response(JSON.stringify(applies++ === 0 ? "accepted" : MISMATCH_CODE), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
        : null;
    const result = await sync(auth, [scored, twin]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(h.callsTo(APPLY_RPC).length, 2, "both entries reached the database");
    assertEquals(result.body.acceptedIds, [scored.id]);
    assertEquals(result.body.rejected.map((r) => r.code), [MISMATCH_CODE]);
    assertEquals((result.body.receipts ?? []).length, 1);
    assertEquals(receiptFor(result.body, scored.id).sha256.length, 64);
  },
);

// ATTACK E4 — process death between commit and acknowledgement: the RPC
// call fails (gateway timeout) after the database committed. The client must
// see a retryable verdict with nothing accepted or fabricated; the retry
// (same bytes) must be answered with the stored receipt and never re-charge.
Deno.test(
  "ATTACK W01-03 E4: RPC timeout ⇒ retryable, nothing accepted; identical retry after the commit ⇒ original receipt, no RPC, no authority read",
  async () => {
    const auth = signIn();
    const policy = await authority();
    h.rpcs.read_analysis_release_policy = policy;
    h.rpcErrors.apply_synced_shot = 504;
    const scored = shot("scored");
    const lost = await sync(auth, [scored]);
    assertEquals(lost.status, 200, JSON.stringify(lost.body));
    assertEquals(lost.body.acceptedIds, []);
    assertEquals(lost.body.rejected.map((r) => r.code), [WRITE_FAILED_CODE]);
    assertEquals(lost.body.receipts ?? [], []);
    const calls = h.callsTo(APPLY_RPC);
    assertEquals(calls.length, 1);
    const body = calls[0].body;
    assert(isRecord(body) && isRecord(body.shot));
    const committed = transportOf(body.shot.settlementReceipt);

    // The database did commit the settlement before the response was lost.
    storeReceipt(auth.userId, scored.id, committed);
    delete h.rpcErrors.apply_synced_shot;
    h.calls.length = 0;
    const retry = await sync(auth, [structuredClone(scored)]);
    assertEquals(retry.status, 200, JSON.stringify(retry.body));
    assertEquals(retry.body.acceptedIds, [scored.id]);
    assertEquals(retry.body.rejected, []);
    assertEquals(receiptFor(retry.body, scored.id), committed);
    assertEquals(h.callsTo(APPLY_RPC).length, 0, "the retry must not re-run the chargeable RPC");
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "the retry needs no authority read");
  },
);

// ATTACK E5 — corrupt / partial persisted state: stored bytes that are valid
// JSON with a matching digest but NOT canonical, a truncated receipt, and an
// upper-cased stored digest. None may become a replay match, a fresh
// settlement, or a permanent rejection of a settlement the server itself
// persisted: unknown state is retryable (HOLD).
async function corruptStoredReceipt(
  label: string,
  auth: { token: string; ip: string; userId: string },
  scored: ReturnType<typeof shot>,
  corrupt: ReceiptTransport,
) {
  storeReceipt(auth.userId, scored.id, corrupt);
  h.calls.length = 0;
  const result = await sync(auth, [structuredClone(scored)]);
  assertEquals(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
  assertEquals(result.body.acceptedIds, [], `${label}: nothing accepted`);
  assertEquals(result.body.receipts ?? [], [], `${label}: nothing fabricated`);
  assertEquals(h.callsTo(APPLY_RPC).length, 0, `${label}: no chargeable RPC`);
  assertEquals(result.body.rejected.length, 1, label);
  assertEquals(
    result.body.rejected[0].code,
    WRITE_FAILED_CODE,
    `${label}: a receipt the server itself persisted must never become a permanent refusal`,
  );
}

Deno.test(
  "ATTACK W01-03 E5a: non-canonical / truncated / upper-case-digest stored receipts are unknown state — retryable, no RPC, nothing fabricated",
  async () => {
    const auth = signIn();
    const { scored, original } = await settled(auth);
    const receipt = JSON.parse(original.canonical) as Receipt;
    const pretty = JSON.stringify(receipt, null, 2);
    const truncated = original.canonical.slice(0, -1);
    const corruptions: Array<[string, ReceiptTransport]> = [
      ["non-canonical bytes", { canonical: pretty, sha256: await sha256Hex(pretty) }],
      ["truncated bytes", { canonical: truncated, sha256: await sha256Hex(truncated) }],
      ["upper-case digest", {
        canonical: original.canonical,
        sha256: original.sha256.toUpperCase(),
      }],
    ];
    for (const [label, corrupt] of corruptions) {
      await corruptStoredReceipt(label, auth, scored, corrupt);
    }
  },
);

// A stored receipt row whose binding describes ANOTHER shot (or owner) is not
// this shot's receipt: it is corrupt state, not evidence that THIS settlement
// was "settled with different details".
Deno.test(
  "ATTACK W01-03 E5b: a stored receipt whose binding names another shot/owner is corrupt state — retryable, never a permanent mismatch",
  async () => {
    const auth = signIn();
    const { scored, original } = await settled(auth);
    const receipt = JSON.parse(original.canonical) as Receipt;
    const foreignShot = structuredClone(receipt);
    foreignShot.binding.shotId = crypto.randomUUID();
    const foreignOwner = structuredClone(receipt);
    foreignOwner.binding.ownerId = "7a010300-0000-4000-8000-ffffffffffff";
    const corruptions: Array<[string, ReceiptTransport]> = [];
    for (
      const [label, value] of [
        ["foreign shot binding", foreignShot],
        ["foreign owner binding", foreignOwner],
      ] as const
    ) {
      const canonical = canonicalizeOfflineJson(value);
      corruptions.push([label, { canonical, sha256: await sha256Hex(canonical) }]);
    }
    for (const [label, corrupt] of corruptions) {
      await corruptStoredReceipt(label, auth, scored, corrupt);
    }
  },
);

// ── Postgres half ────────────────────────────────────────────────────────────

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

async function asUser(tx: Tx, userId: string, gate = true): Promise<void> {
  if (gate) {
    await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
      'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  }
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string, sub: string) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `delete from public.free_rating_ledger
      where identity_hash = public.free_rating_identity_hash('google', '${sub}')`,
  );
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
}

async function reservePermit(sql: Sql, userId: string, key: string): Promise<string> {
  let permitId = "";
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const r = await tx.unsafe(
      `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
    );
    assertEquals(String(r[0].result), "accepted");
    permitId = String(r[0].permit_id);
  });
  return permitId;
}

async function applyAs(
  sql: Sql,
  userId: string,
  shot: Record<string, unknown>,
  gate = true,
): Promise<string> {
  let verdict = "";
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId, gate);
    const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
      JSON.stringify(shot),
    ]);
    verdict = String(r[0].result);
  });
  return verdict;
}

/** Owner-role facts (bypass RLS on purpose: these are the invariants). */
async function facts(sql: Sql, userId: string, shotId: string) {
  const shots = await sql.unsafe(
    `select count(*)::int as n from public.shots where id = '${shotId}'`,
  );
  const receipts = await sql.unsafe(
    `select count(*)::int as n from public.settlement_receipts where shot_id = '${shotId}'`,
  );
  const permits = await sql.unsafe(
    `select id::text as id, status, coalesce(outcome, '') as outcome from public.analysis_permits where user_id = '${userId}' order by created_at, id`,
  );
  const ledger = await sql.unsafe(
    `select coalesce(max(l.scored_count), 0)::int as n from public.free_rating_ledger l
       join auth.identities i on l.identity_hash = public.free_rating_identity_hash(i.provider, i.provider_id)
      where i.user_id = '${userId}'`,
  );
  return {
    shots: Number(shots[0].n),
    receipts: Number(receipts[0].n),
    permits: Object.fromEntries(
      permits.map((p) => [String(p.id), `${p.status}/${p.outcome}`]),
    ) as Record<string, string>,
    ledger: Number(ledger[0].n),
  };
}

function pgPayload(id: string, analysisPermitId: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-08T10:00:00.000Z",
    startMs: 0,
    contactMs: 500,
    endMs: 1000,
    overallScore: 7.5,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

type Claims = {
  installationKeyId: string | null;
  grant: { grantId: string; grantJwsSha256: string } | null;
  ticket: { allocationId: string; generation: number; ticketId: string } | null;
  operationId: string | null;
};

/** The receipt the edge attaches: binding over the payload as persisted, the
 * claims, and the policy lineage (null for abstentions, exactly as the edge). */
async function bound(
  ownerId: string,
  payload: ReturnType<typeof pgPayload>,
  claims: Claims | null = CLAIMS,
  doc: AnalysisReleasePolicyDocument | null = document,
): Promise<Record<string, unknown>> {
  const binding = {
    ownerId,
    shotId: payload.id,
    analysisPermitId: payload.analysisPermitId,
    resultKind: payload.resultKind,
    installationKeyId: claims?.installationKeyId ?? null,
    grant: claims?.grant ?? null,
    ticket: claims?.ticket ?? null,
    operationId: claims?.operationId ?? null,
    payloadSha256: await digestCanonicalOfflineJson(payload),
  };
  const policy = doc === null ? null : {
    version: doc.version,
    sha256: await digestCanonicalOfflineJson(doc),
    validFrom: doc.validFrom,
    validUntil: doc.validUntil,
    mechanics: { lineage },
    benchmark: { lineage },
    approval: {
      mechanicsApprovedAt: doc.validFrom,
      benchmarkApprovedAt: doc.validFrom,
      withdrawnAt: null,
      denyNewAuthorizations: false,
    },
  };
  const receipt = {
    schemaVersion: 1,
    kind: "settlement_receipt",
    binding,
    bindingSha256: await digestCanonicalOfflineJson(binding),
    policy,
  };
  const canonical = canonicalizeOfflineJson(receipt);
  return { ...payload, settlementReceipt: { canonical, sha256: await sha256Hex(canonical) } };
}

const PG_A = "7a010300-bbbb-4000-8000-000000000001";
const PG_B = "7a010300-bbbb-4000-8000-000000000002";
const PG_C = "7a010300-bbbb-4000-8000-000000000003";
const PG_D = "7a010300-bbbb-4000-8000-000000000004";
const PG_E = "7a010300-bbbb-4000-8000-000000000005";
const PG_F = "7a010300-bbbb-4000-8000-000000000006";
const PG_G = "7a010300-bbbb-4000-8000-000000000007";
const PG_H = "7a010300-bbbb-4000-8000-000000000008";
const PG_I = "7a010300-bbbb-4000-8000-000000000009";

// ATTACK P1 — boundary / identity: upper-case UUID spellings. PostgreSQL's
// uuid type accepts them and `apply_synced_shot` itself casts them (a caller
// without a receipt settles fine), so the receipt check must agree with the
// database about WHICH shot/permit is meant: the same settlement in upper
// case is accepted (fresh) and is a replay (afterwards), never a permanent
// refusal that strands the reserved permit.
Deno.test({
  name:
    "ATTACK W01-03 P1a: a fresh settlement whose shot id is spelled in upper case settles (the database accepts the id; a receipt-less caller settles it)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_A, "w0103-attack-a");
      const permit = await reservePermit(sql, PG_A, "w0103-attack-a-1");
      const control = await reservePermit(sql, PG_A, "w0103-attack-a-control");

      // Control: the SAME upper-case spelling without a receipt (a caller
      // that predates receipts) is accepted by the RPC — the id is valid.
      const controlId = crypto.randomUUID().toUpperCase();
      assertEquals(await applyAs(sql, PG_A, pgPayload(controlId, control)), "accepted");
      assertEquals((await facts(sql, PG_A, controlId.toLowerCase())).shots, 1);

      // Attack: the receipt the edge builds names exactly the payload ids.
      const upperId = crypto.randomUUID().toUpperCase();
      const upper = await bound(PG_A, pgPayload(upperId, permit));
      const verdict = await applyAs(sql, PG_A, upper);
      const f = await facts(sql, PG_A, upperId.toLowerCase());
      assertEquals(
        verdict,
        "accepted",
        `an id the database accepts must settle; permit=${f.permits[permit]} shots=${f.shots}`,
      );
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[permit], "finalized/scored");
      assertEquals(f.ledger, 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name:
    "ATTACK W01-03 P1b: the identical settlement replayed with its shot id re-spelled in upper case is a replay of itself, not a permanent mismatch",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_H, "w0103-attack-h");
      const permit = await reservePermit(sql, PG_H, "w0103-attack-h-1");
      const lowerId = crypto.randomUUID();
      const lower = await bound(PG_H, pgPayload(lowerId, permit));
      assertEquals(await applyAs(sql, PG_H, lower), "accepted");
      const replay = await bound(PG_H, pgPayload(lowerId.toUpperCase(), permit));
      const verdict = await applyAs(sql, PG_H, replay);
      const f = await facts(sql, PG_H, lowerId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.ledger, 1);
      assertEquals(
        verdict,
        "accepted",
        "the identical settlement, re-spelled, is a replay of itself",
      );
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P2 — concurrency: the SAME settlement submitted twice at once (double
// tap / two outbox drains). Both lanes must end 'accepted' with one shot, one
// receipt, one consumed permit and one counted rating.
Deno.test({
  name:
    "ATTACK W01-03 P2: two racing submissions of ONE identical settlement both succeed with exactly one shot/receipt/permit/rating",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, PG_B, "w0103-attack-b");
      const permit = await reservePermit(sql, PG_B, "w0103-attack-b-1");
      const spare = await reservePermit(sql, PG_B, "w0103-attack-b-spare");
      const shotId = crypto.randomUUID();
      const settlement = await bound(PG_B, pgPayload(shotId, permit));
      const verdicts = await Promise.all([
        applyAs(sql, PG_B, structuredClone(settlement)),
        applyAs(sql, PG_B, structuredClone(settlement)),
        applyAs(sql, PG_B, structuredClone(settlement)),
      ]);
      assertEquals(verdicts, ["accepted", "accepted", "accepted"]);
      const f = await facts(sql, PG_B, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[permit], "finalized/scored");
      assertEquals(f.permits[spare], "reserved/");
      assertEquals(f.ledger, 1, "one rating counted for three identical submissions");
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P3 — concurrency + policy rotation: the SAME binding (same owner,
// device, grant, ticket, operation, payload) racing while the release policy
// rotates between the two lanes. The package contract makes the policy
// lineage part of the replay identity, so exactly one lane settles and the
// other is the typed, non-chargeable mismatch — never two charges, never a
// second receipt, never an unexpected verdict.
Deno.test({
  name:
    "ATTACK W01-03 P3: an identical binding racing under a rotated policy lineage settles once — one charge, the other lane is the typed mismatch",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, PG_C, "w0103-attack-c");
      const permit = await reservePermit(sql, PG_C, "w0103-attack-c-1");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      const under1 = await bound(PG_C, payload, CLAIMS, policyDocument("attack-policy-1"));
      const under2 = await bound(PG_C, payload, CLAIMS, policyDocument("attack-policy-2"));
      const [first, second] = await Promise.all([
        applyAs(sql, PG_C, under1),
        applyAs(sql, PG_C, under2),
      ]);
      const f = await facts(sql, PG_C, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.ledger, 1);
      assertEquals(
        [first, second].sort(),
        ["accepted", "shot.receipt_mismatch"],
        "exactly one lane settles; the rotated-lineage lane is the typed mismatch",
      );
      assertEquals(f.permits[permit], "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P7 — duplicate identity inside one batch against the REAL RPC: the
// edge's batched replay lookup saw neither entry, so both reach the database
// back to back. The second (a mutated twin under the same id) must be the
// typed mismatch — not a second acceptance, not a second receipt or charge.
Deno.test({
  name:
    "ATTACK W01-03 P7: a mutated twin applied right after its original (same batch, no lookup in between) is the typed mismatch — one receipt, one charge",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_I, "w0103-attack-i");
      const permit = await reservePermit(sql, PG_I, "w0103-attack-i-1");
      const shotId = crypto.randomUUID();
      const original = await bound(PG_I, pgPayload(shotId, permit));
      const twin = await bound(PG_I, pgPayload(shotId, permit, { overallScore: 7.6 }));
      assertEquals(await applyAs(sql, PG_I, original), "accepted");
      const verdict = await applyAs(sql, PG_I, twin);
      const f = await facts(sql, PG_I, shotId);
      assertEquals(verdict, "shot.receipt_mismatch");
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.ledger, 1);
      assertEquals(f.permits[permit], "finalized/scored");
      const stored = await sql.unsafe(
        `select overall_score::text as s from public.shots where id = '${shotId}'`,
      );
      assertNotEquals(stored[0].s, "7.6", "the twin's score never replaced the settled one");
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P4 — unauthorised roles on the new surfaces (allowed AND denied):
// anon cannot execute the RPC; a caller without a JWT subject is refused;
// an authenticated owner WITHOUT the API gate can neither read receipts nor
// turn a replay into a fresh settlement; another owner cannot replay or read.
Deno.test({
  name:
    "ATTACK W01-03 P4: anon / no-subject / un-gated owner / other owner are all refused on the receipt surfaces, and nothing moves",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_D, "w0103-attack-d");
      await createUser(sql, PG_E, "w0103-attack-e");
      const permit = await reservePermit(sql, PG_D, "w0103-attack-d-1");
      const spare = await reservePermit(sql, PG_D, "w0103-attack-d-spare");
      const shotId = crypto.randomUUID();
      const settlement = await bound(PG_D, pgPayload(shotId, permit));
      assertEquals(await applyAs(sql, PG_D, settlement), "accepted");
      const before = await facts(sql, PG_D, shotId);

      // anon: no EXECUTE.
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role anon`);
            await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb)`, [
              JSON.stringify(settlement),
            ]);
          }),
        Error,
        "permission denied",
      );
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await tx.unsafe(`set local role anon`);
            await tx.unsafe(`select * from public.settlement_receipts`);
          }),
        Error,
        "permission denied",
      );

      // authenticated without a subject.
      let noSubject = "";
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role authenticated`);
        const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
          JSON.stringify(settlement),
        ]);
        noSubject = String(r[0].result);
      });
      assertEquals(noSubject, "auth.required");

      // The owner without the API gate: cannot read the receipt, and a
      // mutated replay naming the spare permit must not settle.
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PG_D, false);
        const rows = await tx.unsafe(
          `select shot_id from public.settlement_receipts where shot_id = '${shotId}'`,
        );
        assertEquals(rows.length, 0, "receipts are API-gated");
      });
      const ungated = await applyAs(
        sql,
        PG_D,
        await bound(PG_D, pgPayload(shotId, spare)),
        false,
      );
      assertNotEquals(ungated, "accepted");

      // Another owner presenting the same id + a receipt naming the victim.
      const other = await applyAs(sql, PG_E, structuredClone(settlement));
      assertNotEquals(other, "accepted");
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PG_E);
        const rows = await tx.unsafe(`select shot_id from public.settlement_receipts`);
        assertEquals(rows.length, 0, "other owners see no receipts");
      });

      const after = await facts(sql, PG_D, shotId);
      assertEquals(after, before, "nothing moved");
      assertEquals(after.permits[spare], "reserved/");
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P5 — boundary values in the claims: the largest admitted ticket
// generation and id lengths settle; one past each boundary, zero, negative
// and fractional generations, and an over-long installation key are refused
// as invalid WITHOUT touching the permit or the ledger.
Deno.test({
  name:
    "ATTACK W01-03 P5: claim boundary values — max admitted settles, one past each edge is refused before any permit or rating moves",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_F, "w0103-attack-f");
      const permit = await reservePermit(sql, PG_F, "w0103-attack-f-1");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      const invalid: Array<[string, Claims]> = [
        ["generation 10^9", { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 1_000_000_000 } }],
        ["generation 0", { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 0 } }],
        ["generation -1", { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: -1 } }],
        ["generation 2.5", { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 2.5 } }],
        ["installation key 129 chars", { ...CLAIMS, installationKeyId: "k".repeat(129) }],
        ["empty operation id", { ...CLAIMS, operationId: "" }],
        ["grant digest upper-case", {
          ...CLAIMS,
          grant: { ...CLAIMS.grant, grantJwsSha256: "D".repeat(64) },
        }],
      ];
      for (const [label, claims] of invalid) {
        const verdict = await applyAs(sql, PG_F, await bound(PG_F, payload, claims));
        assertEquals(verdict, "shot.receipt_invalid", label);
        const f = await facts(sql, PG_F, shotId);
        assertEquals(f.shots, 0, label);
        assertEquals(f.receipts, 0, label);
        assertEquals(f.permits[permit], "reserved/", `${label}: permit untouched`);
        assertEquals(f.ledger, 0, `${label}: no rating counted`);
      }
      const maximal: Claims = {
        installationKeyId: "k".repeat(128),
        grant: { grantId: "g".repeat(128), grantJwsSha256: "f".repeat(64) },
        ticket: {
          allocationId: "a".repeat(128),
          generation: 999_999_999,
          ticketId: "t".repeat(128),
        },
        operationId: "o".repeat(128),
      };
      assertEquals(await applyAs(sql, PG_F, await bound(PG_F, payload, maximal)), "accepted");
      const f = await facts(sql, PG_F, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[permit], "finalized/scored");
      assertEquals(f.ledger, 1);
    } finally {
      await sql.end();
    }
  },
});

// ATTACK P6 — process death between steps + free-rating conservation: the
// settlement transaction is rolled back after the RPC returned 'accepted'
// (the process died before COMMIT). Nothing may remain, the permit stays
// reserved, no rating is counted, and the identical retry settles exactly
// once. Then an abstention settled with a receipt cannot be upgraded to a
// scored settlement under the same id with a spare permit.
Deno.test({
  name:
    "ATTACK W01-03 P6: a settlement rolled back before COMMIT leaves nothing behind and retries once; an abstention cannot be re-settled as scored",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_G, "w0103-attack-g");
      const permit = await reservePermit(sql, PG_G, "w0103-attack-g-1");
      const spare = await reservePermit(sql, PG_G, "w0103-attack-g-spare");
      const shotId = crypto.randomUUID();
      const settlement = await bound(PG_G, pgPayload(shotId, permit));

      class Died extends Error {}
      await assertRejects(
        () =>
          sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, PG_G);
            const r = await tx.unsafe(
              `select public.apply_synced_shot($1::text::jsonb) as result`,
              [JSON.stringify(settlement)],
            );
            assertEquals(String(r[0].result), "accepted");
            throw new Died("process died before COMMIT");
          }),
        Died,
      );
      let f = await facts(sql, PG_G, shotId);
      assertEquals(f.shots, 0);
      assertEquals(f.receipts, 0);
      assertEquals(f.permits[permit], "reserved/");
      assertEquals(f.ledger, 0);

      assertEquals(await applyAs(sql, PG_G, structuredClone(settlement)), "accepted");
      assertEquals(await applyAs(sql, PG_G, structuredClone(settlement)), "accepted");
      f = await facts(sql, PG_G, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[permit], "finalized/scored");
      assertEquals(f.ledger, 1);

      // Abstention first, then a scored re-settlement of the same id.
      const abstainId = crypto.randomUUID();
      const abstention = await bound(
        PG_G,
        pgPayload(abstainId, spare, { resultKind: "partial", overallScore: null }),
        CLAIMS,
        null,
      );
      assertEquals(await applyAs(sql, PG_G, abstention), "accepted");
      f = await facts(sql, PG_G, abstainId);
      assertEquals(f.receipts, 1);
      assertEquals(f.ledger, 1, "an abstention never counts");
      const spare2 = await reservePermit(sql, PG_G, "w0103-attack-g-spare-2");
      const upgrade = await bound(PG_G, pgPayload(abstainId, spare2));
      assertEquals(await applyAs(sql, PG_G, upgrade), "shot.receipt_mismatch");
      f = await facts(sql, PG_G, abstainId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[spare2], "reserved/", "the spare permit is never consumed");
      assertEquals(f.ledger, 1, "no rating counted for a refused upgrade");
    } finally {
      await sql.end();
    }
  },
});
