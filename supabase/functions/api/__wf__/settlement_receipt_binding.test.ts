// W01-03 — the scored settlement receipt binds owner, device (installation
// key), grant, ticket, operation id, the canonical payload digest and the full
// release-policy lineage; replay is decided on that binding.
//
// Two halves, both black-box:
//   * the REAL edge handler through routesHarness (Supabase stubbed at the
//     fetch layer): the receipt that reaches apply_synced_shot, the receipt
//     the client gets back, an identical replay answered with the ORIGINAL
//     stored receipt without touching the chargeable RPC or the release
//     authority, and every mismatched replay rejected as
//     shot.receipt_mismatch before any RPC (credit / sequence) is spent;
//   * the REAL apply_synced_shot(jsonb) on a disposable postgres:16 with
//     every migration applied (./xc_pg_up.sh, XC_PG_URL) — the receipt row is
//     durable in the same transaction as the shot, an identical replay is
//     accepted with exactly one row / one consumed permit / one counted
//     rating, a mismatched replay is refused BEFORE the permit it names is
//     touched, the client role holds no write on the receipt table and cannot
//     read another owner's receipt, and two racing settlements of one shot id
//     with different bindings end with exactly one receipt.
// Without XC_PG_URL the postgres half is `ignore`d — an ignored run is NOT a
// pass (the W01-03-AC2 gate runs with XC_PG_URL set).
//
// Fixtures are built here (not imported from the harness) so the file runs
// unchanged against BASE_SHA, where it must fail.

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const RECEIPTS_TABLE = "/rest/v1/settlement_receipts";
const MISMATCH_CODE = "shot.receipt_mismatch";
const INVALID_CODE = "shot.invalid_payload";
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

const artifact = { version: "fixture-1", sha256: "a".repeat(64) };
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
const document: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "settlement-policy-1",
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

/** The device-side settlement claims the client presents with a shot. */
const CLAIMS = {
  installationKeyId: "ik_7b0a0d8f5e1c4a2b",
  grant: { grantId: "grant_2026-09-08_0001", grantJwsSha256: "c".repeat(64) },
  ticket: { allocationId: "alloc_0001", generation: 3, ticketId: "ticket_0001" },
  operationId: "op_5f1e3c9a-2b4d-4e6f-8a9b-0c1d2e3f4a5b",
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Receipt {
  schemaVersion: number;
  kind: string;
  binding: {
    ownerId: string;
    shotId: string;
    analysisPermitId: string;
    resultKind: string;
    installationKeyId: string | null;
    grant: { grantId: string; grantJwsSha256: string } | null;
    ticket: { allocationId: string; generation: number; ticketId: string } | null;
    operationId: string | null;
    payloadSha256: string;
  };
  bindingSha256: string;
  policy: Record<string, unknown> | null;
}

interface ReceiptTransport {
  canonical: string;
  sha256: string;
}

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

/** The `shot` argument of the single apply_synced_shot call. */
function appliedShot(): Record<string, unknown> {
  const calls = h.callsTo(APPLY_RPC);
  assertEquals(calls.length, 1, "exactly one apply_synced_shot call");
  const body = calls[0].body;
  assert(isRecord(body) && isRecord(body.shot), "rpc body carries the shot");
  return body.shot;
}

function transportOf(value: unknown): ReceiptTransport {
  assert(isRecord(value), "settlementReceipt must be an object");
  assert(typeof value.canonical === "string", "settlementReceipt.canonical is the canonical JSON");
  assert(typeof value.sha256 === "string" && SHA256_HEX.test(value.sha256));
  return { canonical: value.canonical, sha256: value.sha256 };
}

async function verifiedReceipt(transport: ReceiptTransport): Promise<Receipt> {
  assertEquals(await sha256Hex(transport.canonical), transport.sha256, "receipt digest");
  const receipt = JSON.parse(transport.canonical) as Receipt;
  assertEquals(
    canonicalizeOfflineJson(receipt),
    transport.canonical,
    "the receipt is transported as its RFC 8785 canonical bytes",
  );
  assertEquals(receipt.schemaVersion, 1);
  assertEquals(receipt.kind, "settlement_receipt");
  assertEquals(
    await digestCanonicalOfflineJson(receipt.binding),
    receipt.bindingSha256,
    "bindingSha256 is the digest of the canonical binding",
  );
  return receipt;
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

function receiptFor(body: SyncBody, id: string): ReceiptTransport {
  assert(Array.isArray(body.receipts), "response carries receipts");
  const entry = body.receipts.find((r) => r.id === id);
  assert(entry, `receipt for ${id} in the response`);
  return transportOf(entry);
}

// ── Edge: a fresh scored settlement is bound ─────────────────────────────────

Deno.test(
  "W01-03 edge: a scored settlement binds owner/device/grant/ticket/operation/payload digest/policy lineage into the receipt the RPC persists and the client receives",
  async () => {
    const auth = signIn();
    const policy = await authority();
    h.rpcs.read_analysis_release_policy = policy;
    const scored = shot("scored");
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [scored.id]);
    assertEquals(result.body.rejected, []);

    const applied = appliedShot();
    const { settlementReceipt, ...payload } = applied;
    const transport = transportOf(settlementReceipt);
    const receipt = await verifiedReceipt(transport);

    // Binding: every identity the settlement rests on, plus the digest of
    // EXACTLY the payload the RPC persists (nothing else).
    assertEquals(receipt.binding.ownerId, auth.userId);
    assertEquals(receipt.binding.shotId, scored.id);
    assertEquals(receipt.binding.analysisPermitId, scored.analysisPermitId);
    assertEquals(receipt.binding.resultKind, "scored");
    assertEquals(receipt.binding.installationKeyId, CLAIMS.installationKeyId);
    assertEquals(receipt.binding.grant, CLAIMS.grant);
    assertEquals(receipt.binding.ticket, CLAIMS.ticket);
    assertEquals(receipt.binding.operationId, CLAIMS.operationId);
    assertEquals(receipt.binding.payloadSha256, await digestCanonicalOfflineJson(payload));
    assertEquals(payload.id, scored.id);
    assertEquals(payload.overallScore, 7.5);
    assertEquals(payload.checkpoints, scored.checkpoints);
    assert(!("settlement" in payload), "client claims live in the binding, not the row payload");

    // Full policy lineage of the release authority the charge was admitted
    // under — the verified document's version + digest, both artifact
    // lineages and the approval record. Nothing is invented.
    assertEquals(receipt.policy, {
      version: document.version,
      sha256: policy.approval.policy.sha256,
      validFrom: document.validFrom,
      validUntil: document.validUntil,
      mechanics: { lineage },
      benchmark: { lineage },
      approval: {
        mechanicsApprovedAt: policy.approval.mechanicsApprovedAt,
        benchmarkApprovedAt: policy.approval.benchmarkApprovedAt,
        withdrawnAt: null,
        denyNewAuthorizations: false,
      },
    });

    // The client receives the very receipt that was persisted.
    assertEquals(receiptFor(result.body, scored.id), transport);
  },
);

Deno.test(
  "W01-03 edge: absent device claims are recorded as absent (never fabricated) and an abstention carries no policy lineage",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const { settlement: _omitted, ...unbound } = shot("low_confidence");
    const result = await sync(auth, [unbound]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [unbound.id]);
    const receipt = await verifiedReceipt(transportOf(appliedShot().settlementReceipt));
    assertEquals(receipt.binding.ownerId, auth.userId);
    assertEquals(receipt.binding.resultKind, "low_confidence");
    assertEquals(receipt.binding.installationKeyId, null);
    assertEquals(receipt.binding.grant, null);
    assertEquals(receipt.binding.ticket, null);
    assertEquals(receipt.binding.operationId, null);
    assert(SHA256_HEX.test(receipt.binding.payloadSha256));
    assertEquals(receipt.policy, null);
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "abstentions never consult the authority");
  },
);

Deno.test(
  "W01-03 edge: malformed settlement claims are a typed per-shot rejection, RPC untouched",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const bad = [
      shot("scored", { settlement: { ...CLAIMS, operationId: 42 } }),
      shot("scored", {
        settlement: { ...CLAIMS, grant: { ...CLAIMS.grant, grantJwsSha256: "zz" } },
      }),
      shot("scored", { settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 0 } } }),
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: "" } }),
      shot("scored", { settlement: { ...CLAIMS, extra: true } }),
      shot("scored", { settlement: null }),
      shot("scored", { settlement: "ik_1" }),
    ];
    const result = await sync(auth, bad);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      bad.map(() => INVALID_CODE),
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "invalid entries never cost an authority read");
  },
);

// ── Edge: replay ─────────────────────────────────────────────────────────────

Deno.test(
  "W01-03 edge: an identical replay returns the ORIGINAL stored receipt and spends nothing — no RPC, no authority read",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const first = await sync(auth, [scored]);
    assertEquals(first.status, 200, JSON.stringify(first.body));
    const original = receiptFor(first.body, scored.id);

    // The row and its receipt are now durable; a later, byte-identical sync
    // (lost acknowledgement, reinstalled outbox) must be answered from them.
    storeReceipt(auth.userId, scored.id, original);
    h.calls.length = 0;
    delete h.rpcs.apply_synced_shot;
    const replay = await sync(auth, [structuredClone(scored)]);
    assertEquals(replay.status, 200, JSON.stringify(replay.body));
    assertEquals(replay.body.acceptedIds, [scored.id]);
    assertEquals(replay.body.rejected, []);
    assertEquals(
      receiptFor(replay.body, scored.id),
      original,
      "the original receipt, byte for byte",
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0, "a replay never reaches the chargeable RPC");
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "a replay never re-admits the charge");
    assertEquals(h.callsTo(RECEIPTS_TABLE).length, 1, "the stored receipt is read once per batch");
  },
);

Deno.test(
  "W01-03 edge: a replay that differs in ANY bound field is rejected as shot.receipt_mismatch before the RPC — no credit, no sequence",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const first = await sync(auth, [scored]);
    assertEquals(first.status, 200, JSON.stringify(first.body));
    const original = receiptFor(first.body, scored.id);
    storeReceipt(auth.userId, scored.id, original);

    const mutations: Record<string, (s: ReturnType<typeof shot>) => void> = {
      "payload: overallScore": (s) => (s.overallScore = 7.6),
      "payload: checkpoints": (s) => (s.checkpoints[0].score = 72),
      "payload: phases": (s) => (s.phases[0].endMs = 401),
      "payload: versionVector": (s) =>
        (s.versionVector = { ...VERSION_VECTOR, appVersion: "1.0.1" }),
      "payload: capturedAt": (s) => (s.capturedAt = "2026-09-08T10:00:01.000Z"),
      permit: (s) => (s.analysisPermitId = crypto.randomUUID()),
      resultKind: (s) => {
        s.resultKind = "low_confidence";
        s.overallScore = null;
      },
      device: (s) => (s.settlement.installationKeyId = "ik_other_device"),
      "grant id": (s) => (s.settlement.grant.grantId = "grant_2026-09-08_0002"),
      "grant bytes": (s) => (s.settlement.grant.grantJwsSha256 = "d".repeat(64)),
      "ticket id": (s) => (s.settlement.ticket.ticketId = "ticket_0002"),
      "ticket allocation": (s) => (s.settlement.ticket.allocationId = "alloc_0002"),
      "ticket generation": (s) => (s.settlement.ticket.generation = 4),
      "operation id": (s) => (s.settlement.operationId = "op_other"),
      "claims withheld": (s) => {
        delete (s as Record<string, unknown>).settlement;
      },
    };
    for (const [label, mutate] of Object.entries(mutations)) {
      h.calls.length = 0;
      delete h.rpcs.apply_synced_shot;
      const mutated = structuredClone(scored);
      mutate(mutated);
      const result = await sync(auth, [mutated]);
      assertEquals(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
      assertEquals(result.body.acceptedIds, [], `${label}: a mismatched replay is never accepted`);
      assertEquals(result.body.rejected.length, 1, label);
      assertEquals(result.body.rejected[0].id, scored.id, label);
      assertEquals(result.body.rejected[0].code, MISMATCH_CODE, label);
      assertEquals(result.body.receipts ?? [], [], `${label}: no receipt is handed out`);
      assertEquals(h.callsTo(APPLY_RPC).length, 0, `${label}: rejected BEFORE the chargeable RPC`);
      assertEquals(h.callsTo(POLICY_RPC).length, 0, `${label}: no admission for a mismatch`);
    }
  },
);

Deno.test(
  "W01-03 edge: the same shot id under another owner is not a replay of this owner's settlement",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const first = await sync(auth, [scored]);
    assertEquals(first.body.acceptedIds, [scored.id]);
    // The stored receipt belongs to a different owner: the edge's owner-scoped
    // read cannot surface it (modelled as empty tables), so this owner's sync
    // proceeds to the RPC, whose RLS-visible verdict decides (the id conflict).
    const other = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    h.rpcs.apply_synced_shot = "shot.id_conflict";
    const result = await sync(other, [structuredClone(scored)]);
    assertEquals(result.status, 200);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      ["shot.id_conflict"],
    );
    const applied = appliedShot();
    const receipt = await verifiedReceipt(transportOf(applied.settlementReceipt));
    assertEquals(
      receipt.binding.ownerId,
      other.userId,
      "the binding names the caller, never the client",
    );
    assertNotEquals(receipt.binding.ownerId, auth.userId);
  },
);

Deno.test(
  "W01-03 edge: a stored receipt whose bytes no longer match their digest is corrupt state — retryable rejection, nothing accepted or fabricated",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const first = await sync(auth, [scored]);
    const original = receiptFor(first.body, scored.id);
    storeReceipt(auth.userId, scored.id, { ...original, sha256: "e".repeat(64) });
    h.calls.length = 0;
    const result = await sync(auth, [structuredClone(scored)]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      ["shot.write_failed"],
    );
    assertEquals(result.body.receipts ?? [], []);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

// ── Postgres: the real RPC on a disposable database ──────────────────────────

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
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

async function applyAs(sql: Sql, userId: string, shot: Record<string, unknown>): Promise<string> {
  let verdict = "";
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
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

/** Build the receipt the edge would attach: the binding over the payload as
 * persisted, the claims, and the fixture policy lineage. */
async function bound(
  ownerId: string,
  payload: ReturnType<typeof pgPayload>,
  claims: typeof CLAIMS | null = CLAIMS,
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
  const receipt = {
    schemaVersion: 1,
    kind: "settlement_receipt",
    binding,
    bindingSha256: await digestCanonicalOfflineJson(binding),
    policy: {
      version: document.version,
      sha256: await digestCanonicalOfflineJson(document),
      validFrom: document.validFrom,
      validUntil: document.validUntil,
      mechanics: { lineage },
      benchmark: { lineage },
      approval: {
        mechanicsApprovedAt: document.validFrom,
        benchmarkApprovedAt: document.validFrom,
        withdrawnAt: null,
        denyNewAuthorizations: false,
      },
    },
  };
  const canonical = canonicalizeOfflineJson(receipt);
  return { ...payload, settlementReceipt: { canonical, sha256: await sha256Hex(canonical) } };
}

const PG_USER = "7a010300-aaaa-4000-8000-000000000001";
const PG_OTHER = "7a010300-aaaa-4000-8000-000000000002";

Deno.test({
  name: "W01-03 pg: the receipt is durable with the shot; an identical replay is accepted once, a mismatched replay is refused before its permit is touched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, PG_USER, "w0103-sub-1");
      await createUser(sql, PG_OTHER, "w0103-sub-2");
      const permit = await reservePermit(sql, PG_USER, "w0103-permit-1");
      const spare = await reservePermit(sql, PG_USER, "w0103-permit-spare");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      const settlement = await bound(PG_USER, payload);

      assertEquals(await applyAs(sql, PG_USER, settlement), "accepted");
      let f = await facts(sql, PG_USER, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1, "the receipt row is written in the settlement transaction");
      assertEquals(f.permits[permit], "finalized/scored");
      assertEquals(f.permits[spare], "reserved/");
      assertEquals(f.ledger, 1);

      // The owner reads back exactly what was persisted (SELECT through RLS +
      // the API gate); another owner sees nothing.
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PG_USER);
        const rows = await tx.unsafe(
          `select shot_id::text as shot_id, receipt_canonical, receipt_sha256, installation_key_id,
                  grant_id, grant_jws_sha256, ticket_allocation_id, ticket_generation, ticket_id,
                  operation_id, payload_sha256, binding_sha256, policy_version, policy_sha256
             from public.settlement_receipts where shot_id = '${shotId}'`,
        );
        assertEquals(rows.length, 1);
        const transport = settlement.settlementReceipt as ReceiptTransport;
        assertEquals(rows[0].receipt_canonical, transport.canonical);
        assertEquals(rows[0].receipt_sha256, transport.sha256);
        const receipt = JSON.parse(transport.canonical) as Receipt;
        assertEquals(rows[0].installation_key_id, CLAIMS.installationKeyId);
        assertEquals(rows[0].grant_id, CLAIMS.grant.grantId);
        assertEquals(rows[0].grant_jws_sha256, CLAIMS.grant.grantJwsSha256);
        assertEquals(rows[0].ticket_allocation_id, CLAIMS.ticket.allocationId);
        assertEquals(Number(rows[0].ticket_generation), CLAIMS.ticket.generation);
        assertEquals(rows[0].ticket_id, CLAIMS.ticket.ticketId);
        assertEquals(rows[0].operation_id, CLAIMS.operationId);
        assertEquals(rows[0].payload_sha256, receipt.binding.payloadSha256);
        assertEquals(rows[0].binding_sha256, receipt.bindingSha256);
        assertEquals(rows[0].policy_version, document.version);
        assertEquals(rows[0].policy_sha256, await digestCanonicalOfflineJson(document));
      });
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PG_OTHER);
        const rows = await tx.unsafe(
          `select shot_id from public.settlement_receipts where shot_id = '${shotId}'`,
        );
        assertEquals(rows.length, 0, "receipts are owner-isolated");
      });

      // Identical replay: accepted, and NOTHING moves.
      assertEquals(await applyAs(sql, PG_USER, structuredClone(settlement)), "accepted");
      f = await facts(sql, PG_USER, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[spare], "reserved/");
      assertEquals(f.ledger, 1);

      // Mismatched replays: each names the SPARE permit (or the original with a
      // different payload/claims). All are refused, and the spare permit is
      // never consumed — the check runs before any permit is locked or moved.
      const mismatches: Record<string, Record<string, unknown>> = {
        "payload digest": await bound(PG_USER, pgPayload(shotId, permit, { overallScore: 7.6 })),
        "different permit": await bound(PG_USER, pgPayload(shotId, spare)),
        "different device": await bound(PG_USER, payload, {
          ...CLAIMS,
          installationKeyId: "ik_other",
        }),
        "different grant": await bound(PG_USER, payload, {
          ...CLAIMS,
          grant: { ...CLAIMS.grant, grantId: "grant_x" },
        }),
        "different ticket": await bound(PG_USER, payload, {
          ...CLAIMS,
          ticket: { ...CLAIMS.ticket, generation: 9 },
        }),
        "different operation": await bound(PG_USER, payload, { ...CLAIMS, operationId: "op_x" }),
        "claims withheld": await bound(PG_USER, payload, null),
        "receipt withheld": structuredClone(payload),
      };
      for (const [label, replay] of Object.entries(mismatches)) {
        assertEquals(await applyAs(sql, PG_USER, replay), "shot.receipt_mismatch", label);
        f = await facts(sql, PG_USER, shotId);
        assertEquals(f.shots, 1, label);
        assertEquals(f.receipts, 1, label);
        assertEquals(f.permits[permit], "finalized/scored", label);
        assertEquals(f.permits[spare], "reserved/", `${label}: zero credit consumed`);
        assertEquals(f.ledger, 1, `${label}: zero sequence consumed`);
      }

      // A receipt that does not describe the shot it travels with, or whose
      // bytes do not match their digest, is refused on a FRESH settlement too:
      // nothing persists and the permit stays reserved for a clean retry.
      const freshId = crypto.randomUUID();
      const fresh = pgPayload(freshId, spare);
      const invalid: Record<string, Record<string, unknown>> = {
        "receipt for another shot id": {
          ...fresh,
          settlementReceipt: (await bound(PG_USER, pgPayload(crypto.randomUUID(), spare)))
            .settlementReceipt,
        },
        "receipt for another owner": {
          ...fresh,
          settlementReceipt: (await bound(PG_OTHER, fresh)).settlementReceipt,
        },
        "receipt for another permit": {
          ...fresh,
          settlementReceipt: (await bound(PG_USER, pgPayload(freshId, permit))).settlementReceipt,
        },
        "receipt digest mismatch": {
          ...fresh,
          settlementReceipt: {
            ...((await bound(PG_USER, fresh)).settlementReceipt as ReceiptTransport),
            sha256: "f".repeat(64),
          },
        },
        "receipt not an object": { ...fresh, settlementReceipt: "receipt" },
      };
      for (const [label, attempt] of Object.entries(invalid)) {
        assertEquals(await applyAs(sql, PG_USER, attempt), "shot.receipt_invalid", label);
        f = await facts(sql, PG_USER, freshId);
        assertEquals(f.shots, 0, label);
        assertEquals(f.receipts, 0, label);
        assertEquals(f.permits[spare], "reserved/", label);
        assertEquals(f.ledger, 1, label);
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-03 pg: the client role holds no write on settlement_receipts and cannot forge or alter a receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-sub-1");
      const permit = await reservePermit(sql, PG_USER, "w0103-permit-rls");
      const shotId = crypto.randomUUID();
      const settlement = await bound(PG_USER, pgPayload(shotId, permit));
      assertEquals(await applyAs(sql, PG_USER, settlement), "accepted");
      const attempts = [
        `insert into public.settlement_receipts (shot_id, user_id, analysis_permit_id, result_kind, payload_sha256, binding_sha256, receipt, receipt_canonical, receipt_sha256)
           values ('${crypto.randomUUID()}', '${PG_USER}', '${permit}', 'scored', '${"0".repeat(64)}', '${"0".repeat(64)}', '{}', '{}', '${await sha256Hex("{}")}')`,
        `update public.settlement_receipts set payload_sha256 = '${"1".repeat(64)}' where shot_id = '${shotId}'`,
        `delete from public.settlement_receipts where shot_id = '${shotId}'`,
      ];
      for (const statement of attempts) {
        let code = "";
        try {
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, PG_USER);
            await tx.unsafe(statement);
          });
        } catch (error) {
          code = String((error as { code?: string }).code ?? "");
        }
        assertEquals(code, "42501", statement);
      }
      const f = await facts(sql, PG_USER, shotId);
      assertEquals(f.receipts, 1);
      const rls = await sql.unsafe(
        `select relrowsecurity, has_table_privilege('authenticated', 'public.settlement_receipts', 'INSERT,UPDATE,DELETE') as writable,
                has_table_privilege('anon', 'public.settlement_receipts', 'SELECT') as anon_read
           from pg_class where oid = 'public.settlement_receipts'::regclass`,
      );
      assertEquals(Boolean(rls[0].relrowsecurity), true);
      assertEquals(Boolean(rls[0].writable), false);
      assertEquals(Boolean(rls[0].anon_read), false);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "W01-03 pg: two racing settlements of one shot id with different bindings end with exactly one receipt; the loser's permit is untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await createUser(sql, PG_USER, "w0103-sub-1");
      const permitA = await reservePermit(sql, PG_USER, "w0103-race-a");
      const permitB = await reservePermit(sql, PG_USER, "w0103-race-b");
      const shotId = crypto.randomUUID();
      const a = await bound(PG_USER, pgPayload(shotId, permitA));
      const b = await bound(PG_USER, pgPayload(shotId, permitB, { overallScore: 6.5 }), {
        ...CLAIMS,
        operationId: "op_race_b",
      });
      let open!: () => void;
      const gate = new Promise<void>((resolve) => (open = resolve));
      const lane = (shot: Record<string, unknown>) =>
        sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, PG_USER);
          await gate;
          const r = await tx.unsafe(`select public.apply_synced_shot($1::text::jsonb) as result`, [
            JSON.stringify(shot),
          ]);
          return String(r[0].result);
        });
      const lanes = [lane(a), lane(b)];
      open();
      const verdicts = await Promise.all(lanes);
      assertEquals(verdicts.filter((v) => v === "accepted").length, 1, JSON.stringify(verdicts));
      assertEquals(
        verdicts.filter((v) => v === "shot.receipt_mismatch").length,
        1,
        JSON.stringify(verdicts),
      );
      const f = await facts(sql, PG_USER, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      const winner = verdicts[0] === "accepted" ? a : b;
      const loserPermit = verdicts[0] === "accepted" ? permitB : permitA;
      const stored = await sql.unsafe(
        `select receipt_canonical, receipt_sha256 from public.settlement_receipts where shot_id = '${shotId}'`,
      );
      assertEquals(
        stored[0].receipt_canonical,
        (winner.settlementReceipt as ReceiptTransport).canonical,
      );
      assertEquals(stored[0].receipt_sha256, (winner.settlementReceipt as ReceiptTransport).sha256);
      assertEquals(f.permits[loserPermit], "reserved/", "the loser's permit is never consumed");
      assertEquals(f.ledger, 1);
    } finally {
      await sql.end();
    }
  },
});
