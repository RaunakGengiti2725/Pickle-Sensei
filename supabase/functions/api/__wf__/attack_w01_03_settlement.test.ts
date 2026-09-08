// W01-03 ADVERSARIAL TESTS against candidate ac7b4956 (branch
// devin/pp/w01-03/impl-r1). Each Deno.test is one attack at a failure boundary
// of the receipt-bound settlement path. A failing test is a confirmed break; a
// passing test is an attack that did not break the candidate. Nothing here
// modifies the candidate's own tests or production code.
//
// Edge half: the REAL handler through routesHarness (Supabase stubbed at the
// fetch layer). Postgres half: the REAL apply_synced_shot(jsonb) on the
// disposable postgres:16 from ./xc_pg_up.sh (XC_PG_URL); `ignore`d without it
// (an ignored run is not a pass).

import postgres from "postgres";
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { captureConsole, fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const RECEIPTS_TABLE = "/rest/v1/settlement_receipts";
const MISMATCH_CODE = "shot.receipt_mismatch";
const INVALID_CODE = "shot.invalid_payload";
const WRITE_FAILED_CODE = "shot.write_failed";

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

const artifact = { version: "attack-fixture-1", sha256: "a".repeat(64) };
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
const POLICY_A = policyDocument("attack-policy-A");
const POLICY_B = policyDocument("attack-policy-B");

/** What read_analysis_release_policy() returns (migration 20260908020000). */
async function authority(doc: AnalysisReleasePolicyDocument) {
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
  installationKeyId: "ik_attack_device",
  grant: { grantId: "grant_attack_0001", grantJwsSha256: "c".repeat(64) },
  ticket: { allocationId: "alloc_attack", generation: 3, ticketId: "ticket_attack" },
  operationId: "op_attack_0001",
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
interface SyncBody {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
  receipts?: Array<{ id: string } & ReceiptTransport>;
}

let subject = 0;
function signIn(): { token: string; ip: string; userId: string } {
  subject += 1;
  const userId = `7a010303-0000-4000-8000-${String(subject).padStart(12, "0")}`;
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

async function sync(auth: { token: string; ip: string }, shots: unknown[]) {
  const { result } = await captureConsole(() =>
    h.handler(
      userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
    ),
  );
  const status = result.status;
  const retryAfter = result.headers.get("Retry-After");
  return { status, retryAfter, body: (await result.json()) as SyncBody };
}

function transportOf(value: unknown): ReceiptTransport {
  assert(isRecord(value), "settlementReceipt must be an object");
  assert(typeof value.canonical === "string");
  assert(typeof value.sha256 === "string");
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

async function settleOnce(auth: ReturnType<typeof signIn>, entry: Record<string, unknown>) {
  const first = await sync(auth, [entry]);
  assertEquals(first.status, 200, JSON.stringify(first.body));
  assertEquals(first.body.acceptedIds, [entry.id]);
  const original = receiptFor(first.body, String(entry.id));
  storeReceipt(auth.userId, String(entry.id), original);
  h.calls.length = 0;
  delete h.rpcs.apply_synced_shot;
  return original;
}

// Copy the store can never contain per APP_STORE_SUBMISSION.md.
const FORBIDDEN_COPY =
  /android|google play|guest|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?%|best|#1|most accurate/i;

// ── ATTACK 1 · network failure at the receipt read (5xx / 429+Retry-After) ──

Deno.test(
  "W01-03 attack · network: a failed owner receipt read (500, then 429+Retry-After) fails the whole batch retryably — no RPC, no authority read, no fabricated acceptance",
  async () => {
    for (const upstream of [
      { status: 500, headers: {} as Record<string, string> },
      { status: 429, headers: { "Retry-After": "7" } },
      { status: 503, headers: {} as Record<string, string> },
    ]) {
      const auth = signIn();
      h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
      h.respond = (call) =>
        call.method === "GET" && call.url.includes(RECEIPTS_TABLE)
          ? new Response(JSON.stringify({ message: "injected" }), {
              status: upstream.status,
              headers: { "Content-Type": "application/json", ...upstream.headers },
            })
          : null;
      const result = await sync(auth, [shot("scored"), shot("low_confidence")]);
      assertEquals(result.status, 503, `${upstream.status}: ${JSON.stringify(result.body)}`);
      assertEquals(h.callsTo(APPLY_RPC).length, 0, `${upstream.status}: nothing is charged`);
      assertEquals(h.callsTo(POLICY_RPC).length, 0, `${upstream.status}: no admission read`);
      assert(
        !JSON.stringify(result.body).includes("injected"),
        `${upstream.status}: upstream detail must not leak`,
      );
    }
  },
);

// ── ATTACK 2 · network failure AFTER the receipt is built (RPC transport) ──

Deno.test(
  "W01-03 attack · network: an RPC transport failure (5xx) or an unexpected RPC verdict after the receipt was built is a retryable per-shot rejection with NO receipt handed out",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    h.rpcErrors.apply_synced_shot = 502;
    const scored = shot("scored");
    let result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [WRITE_FAILED_CODE],
    );
    assertEquals(result.body.receipts ?? [], [], "no receipt for an unconfirmed settlement");

    delete h.rpcErrors.apply_synced_shot;
    h.rpcs.apply_synced_shot = "accepted:" + "x".repeat(4000);
    result = await sync(auth, [structuredClone(scored)]);
    assertEquals(result.status, 200);
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [WRITE_FAILED_CODE],
    );
    assertEquals(result.body.receipts ?? [], []);

    h.rpcs.apply_synced_shot = null;
    result = await sync(auth, [structuredClone(scored)]);
    assertEquals(result.status, 200);
    assertEquals(result.body.acceptedIds, [], "a null verdict is not acceptance");
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [WRITE_FAILED_CODE],
    );
  },
);

// ── ATTACK 3 · duplicate identities inside ONE batch ──

Deno.test(
  "W01-03 attack · duplicate identities: the same shot id twice in one batch (identical, then mutated) yields one verdict per id, one receipt, one charge",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const scored = shot("scored");
    const result = await sync(auth, [scored, structuredClone(scored)]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(
      new Set(result.body.acceptedIds).size,
      result.body.acceptedIds.length,
      `acceptedIds must not repeat an id: ${JSON.stringify(result.body)}`,
    );
    assertEquals((result.body.receipts ?? []).length, 1, JSON.stringify(result.body.receipts));
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      1,
      "the second copy of the same settlement must not reach the chargeable RPC again",
    );

    const other = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const fresh = shot("scored");
    const mutated = structuredClone(fresh);
    mutated.overallScore = 7.9;
    // The RPC stub answers the second call as the real RPC would (the shot now
    // exists with a different binding).
    let calls = 0;
    h.respond = (call) => {
      if (!call.url.includes(APPLY_RPC)) return null;
      calls += 1;
      return new Response(JSON.stringify(calls === 1 ? "accepted" : MISMATCH_CODE), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const mixed = await sync(other, [fresh, mutated]);
    assertEquals(mixed.status, 200, JSON.stringify(mixed.body));
    assertEquals(mixed.body.acceptedIds, [fresh.id]);
    assertEquals(
      mixed.body.rejected.map((r) => r.code),
      [MISMATCH_CODE],
    );
    assertEquals((mixed.body.receipts ?? []).length, 1);
  },
);

// ── ATTACK 4 · boundary values of the settlement claims ──

Deno.test(
  "W01-03 attack · boundaries: claim values at and beyond every edge (max ids, generation limits, floats, negative zero, unicode, wrong containers) are either bound exactly or rejected before any RPC — never coerced",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const accepted = [
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: "A".repeat(128) } }),
      shot("scored", {
        settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 999_999_999 } },
      }),
      shot("scored", { settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 1 } } }),
      shot("scored", { settlement: { ...CLAIMS, operationId: "a/b+c=d:e.f-g_h" } }),
    ];
    let result = await sync(auth, accepted);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.rejected, []);
    assertEquals(
      result.body.acceptedIds,
      accepted.map((s) => s.id),
    );
    // Every persisted binding must also satisfy the RPC / table CHECK shapes,
    // or the settlement would die as shot.write_failed:23514 at insert time.
    for (const call of h.callsTo(APPLY_RPC)) {
      assert(isRecord(call.body) && isRecord(call.body.shot));
      const transport = transportOf(call.body.shot.settlementReceipt);
      const receipt = JSON.parse(transport.canonical) as {
        binding: {
          installationKeyId: string | null;
          operationId: string | null;
          ticket: { generation: number } | null;
        };
      };
      const idRe = /^[A-Za-z0-9._:/+=-]{1,128}$/;
      if (receipt.binding.installationKeyId !== null) {
        assert(idRe.test(receipt.binding.installationKeyId));
      }
      if (receipt.binding.operationId !== null) assert(idRe.test(receipt.binding.operationId));
      if (receipt.binding.ticket) {
        assert(/^[1-9][0-9]{0,8}$/.test(String(receipt.binding.ticket.generation)));
      }
      assert(transport.canonical.length <= 65_536, "receipt fits the RPC's 64 KiB bound");
    }

    const rejectedShots = [
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: "A".repeat(129) } }),
      shot("scored", {
        settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 1_000_000_000 } },
      }),
      shot("scored", { settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: 3.5 } } }),
      shot("scored", { settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: -0 } } }),
      shot("scored", { settlement: { ...CLAIMS, ticket: { ...CLAIMS.ticket, generation: "3" } } }),
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: "ik_ünïcode" } }),
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: " ik_padded" } }),
      shot("scored", { settlement: { ...CLAIMS, operationId: "" } }),
      shot("scored", {
        settlement: { ...CLAIMS, grant: { ...CLAIMS.grant, grantJwsSha256: "C".repeat(64) } },
      }),
      shot("scored", { settlement: { ...CLAIMS, grant: {} } }),
      shot("scored", { settlement: { ...CLAIMS, ticket: [] } }),
      shot("scored", { settlement: [] }),
      shot("scored", { settlement: { ...CLAIMS, installationKeyId: undefined } }),
    ];
    h.calls.length = 0;
    result = await sync(auth, rejectedShots);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      rejectedShots.map(() => INVALID_CODE),
      JSON.stringify(result.body.rejected),
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
    assertEquals(h.callsTo(POLICY_RPC).length, 0);
  },
);

// ── ATTACK 5 · corrupt persisted state (variants the candidate did not pin) ──

Deno.test(
  "W01-03 attack · corrupt state: a stored receipt with a valid digest but non-canonical bytes, a foreign schema, or a binding for another owner is never a replay match and never a fabricated acceptance",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const scored = shot("scored");
    const original = await settleOnce(auth, scored);
    const parsed = JSON.parse(original.canonical) as Record<string, unknown>;

    const nonCanonical = JSON.stringify(parsed, null, 2);
    const foreignSchema = canonicalizeOfflineJson({ ...parsed, schemaVersion: 2 });
    const foreignKind = canonicalizeOfflineJson({ ...parsed, kind: "settlement" });
    const bindingNotObject = canonicalizeOfflineJson({ ...parsed, binding: "bound" });
    const retryable: Array<[string, string]> = [
      ["non-canonical bytes", nonCanonical],
      ["foreign schemaVersion", foreignSchema],
      ["foreign kind", foreignKind],
      ["binding not an object", bindingNotObject],
      ["empty canonical", ""],
      ["canonical is a JSON string", canonicalizeOfflineJson("receipt")],
    ];
    for (const [label, canonical] of retryable) {
      storeReceipt(auth.userId, scored.id, { canonical, sha256: await sha256Hex(canonical) });
      h.calls.length = 0;
      const result = await sync(auth, [structuredClone(scored)]);
      assertEquals(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
      assertEquals(result.body.acceptedIds, [], `${label}: corrupt state is never acceptance`);
      assertEquals(
        result.body.rejected.map((r) => r.code),
        [WRITE_FAILED_CODE],
        label,
      );
      assertEquals(result.body.receipts ?? [], [], label);
      assertEquals(h.callsTo(APPLY_RPC).length, 0, `${label}: never re-settled over corrupt state`);
    }

    // Row owned by me, receipt bytes naming another owner: a different
    // settlement, not mine → mismatch (permanent), still no RPC.
    const binding = parsed.binding as Record<string, unknown>;
    const foreign = {
      ...parsed,
      binding: { ...binding, ownerId: "7a010303-ffff-4000-8000-000000000099" },
    };
    const foreignCanonical = canonicalizeOfflineJson(foreign);
    storeReceipt(auth.userId, scored.id, {
      canonical: foreignCanonical,
      sha256: await sha256Hex(foreignCanonical),
    });
    h.calls.length = 0;
    const result = await sync(auth, [structuredClone(scored)]);
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [MISMATCH_CODE],
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

// ── ATTACK 6 · free-rating conservation: abstentions and upgrades ──

Deno.test(
  "W01-03 attack · conservation: a replayed abstention (partial / low_confidence) spends nothing and an abstention 'upgraded' to scored under its id is refused before the authority and the RPC",
  async () => {
    for (const kind of ["partial", "low_confidence"] as const) {
      const auth = signIn();
      h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
      const { settlement: _omitted, ...abstention } = shot(kind);
      const original = await settleOnce(auth, abstention);
      assertEquals(
        h.callsTo(POLICY_RPC).length,
        0,
        `${kind}: abstentions never read the authority`,
      );

      const replay = await sync(auth, [structuredClone(abstention)]);
      assertEquals(replay.body.acceptedIds, [abstention.id], kind);
      assertEquals(receiptFor(replay.body, abstention.id), original, kind);
      assertEquals(h.callsTo(APPLY_RPC).length, 0, kind);
      assertEquals(h.callsTo(POLICY_RPC).length, 0, kind);

      h.calls.length = 0;
      const upgraded = { ...structuredClone(abstention), resultKind: "scored", overallScore: 8.1 };
      const result = await sync(auth, [upgraded]);
      assertEquals(result.status, 200, `${kind}: ${JSON.stringify(result.body)}`);
      assertEquals(result.body.acceptedIds, [], `${kind}: an upgrade is never accepted`);
      assertEquals(
        result.body.rejected.map((r) => r.code),
        [MISMATCH_CODE],
        kind,
      );
      assertEquals(h.callsTo(APPLY_RPC).length, 0, `${kind}: rejected before the chargeable RPC`);
      assertEquals(h.callsTo(POLICY_RPC).length, 0, `${kind}: rejected before the authority`);
      assert(
        !FORBIDDEN_COPY.test(result.body.rejected[0].message),
        result.body.rejected[0].message,
      );
    }
  },
);

// ── ATTACK 7 · replay across a release-policy rotation (edge half) ──

Deno.test(
  "W01-03 attack · replay after a policy rotation (edge path): the identical client payload is answered with the ORIGINAL receipt, no re-admission, no RPC",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const scored = shot("scored");
    const original = await settleOnce(auth, scored);
    h.rpcs.read_analysis_release_policy = await authority(POLICY_B);
    const replay = await sync(auth, [structuredClone(scored)]);
    assertEquals(replay.status, 200, JSON.stringify(replay.body));
    assertEquals(replay.body.acceptedIds, [scored.id]);
    assertEquals(receiptFor(replay.body, scored.id), original);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
    assertEquals(h.callsTo(POLICY_RPC).length, 0);
  },
);

// ── ATTACK 8 · copy of every new rejection ──

Deno.test(
  "W01-03 attack · copy: the new rejection messages carry no store-forbidden claims and no internal detail",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority(POLICY_A);
    const scored = shot("scored");
    await settleOnce(auth, scored);
    const mutated = structuredClone(scored);
    mutated.settlement.operationId = "op_other";
    h.rpcs.apply_synced_shot = "shot.receipt_invalid";
    const fresh = shot("scored");
    const result = await sync(auth, [mutated, fresh]);
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [MISMATCH_CODE, "shot.receipt_invalid"],
      JSON.stringify(result.body),
    );
    for (const rejection of result.body.rejected) {
      assert(!FORBIDDEN_COPY.test(rejection.message), rejection.message);
      assert(!/sha256|jsonb|postgres|rpc|sql/i.test(rejection.message), rejection.message);
      assert(rejection.message.length > 0 && rejection.message.length <= 200);
    }
  },
);

// ── Postgres half: the real RPC ──

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

async function lineageOf(doc: AnalysisReleasePolicyDocument) {
  return {
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
}

/** The receipt the edge attaches: binding over the persisted payload, the
 * claims, and the lineage of the policy the charge is admitted under. */
async function bound(
  ownerId: string,
  payload: ReturnType<typeof pgPayload>,
  claims: typeof CLAIMS | null = CLAIMS,
  doc: AnalysisReleasePolicyDocument | null = POLICY_A,
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
    policy: doc ? await lineageOf(doc) : null,
  };
  const canonical = canonicalizeOfflineJson(receipt);
  return { ...payload, settlementReceipt: { canonical, sha256: await sha256Hex(canonical) } };
}

const PG_USER = "7a010303-aaaa-4000-8000-000000000001";
const PG_OTHER = "7a010303-aaaa-4000-8000-000000000002";

// ── ATTACK 9 · replay across a policy rotation (RPC half) — must agree with the edge ──

Deno.test({
  name: "W01-03 attack · replay after a policy rotation (RPC path): the identical binding presented under the rotated lineage must get the same verdict the edge gives (accepted, original receipt stands)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      const permit = await reservePermit(sql, PG_USER, "w0103-attack-rotation");
      const spare = await reservePermit(sql, PG_USER, "w0103-attack-rotation-spare");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      assertEquals(await applyAs(sql, PG_USER, await bound(PG_USER, payload)), "accepted");
      const before = await facts(sql, PG_USER, shotId);
      assertEquals(before.receipts, 1);

      // Same owner, same shot, same permit, same device/grant/ticket/operation,
      // same payload bytes — the ONLY difference is the release policy the
      // edge admits the retry under (rotated between the two attempts). The
      // edge's own replay check ignores the policy (ATTACK 7 passes); the RPC's
      // under-lock check must not contradict it, or a concurrent identical
      // retry that reaches the RPC (two isolates, no receipt stored yet) is
      // answered shot.receipt_mismatch — a permanent-class client verdict
      // ("settled with different details") for a charged, identical shot.
      const rotated = await bound(PG_USER, payload, CLAIMS, POLICY_B);
      const verdict = await applyAs(sql, PG_USER, rotated);
      const after = await facts(sql, PG_USER, shotId);
      assertEquals(after.shots, 1);
      assertEquals(after.receipts, 1);
      assertEquals(after.permits[spare], "reserved/");
      assertEquals(after.ledger, 1);
      assertEquals(
        verdict,
        "accepted",
        "RPC replay verdict for an identical binding under a rotated policy lineage",
      );
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 10 · interleaved account switch on one device ──

Deno.test({
  name: "W01-03 attack · account switch: the second account on the same device replaying the first account's settlement (its receipt, or its own) is refused with nothing of its own consumed and no receipt visible across owners",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      await createUser(sql, PG_OTHER, "w0103-attack-sub-2");
      const permitA = await reservePermit(sql, PG_USER, "w0103-attack-switch-a");
      const permitB = await reservePermit(sql, PG_OTHER, "w0103-attack-switch-b");
      const shotId = crypto.randomUUID();
      const payloadA = pgPayload(shotId, permitA);
      const settledA = await bound(PG_USER, payloadA);
      assertEquals(await applyAs(sql, PG_USER, settledA), "accepted");

      // B presents A's exact settlement (receipt bytes included).
      assertEquals(await applyAs(sql, PG_OTHER, structuredClone(settledA)), "shot.receipt_invalid");
      // B presents A's shot id under B's own permit and receipt.
      const asB = await bound(PG_OTHER, pgPayload(shotId, permitB));
      assertEquals(await applyAs(sql, PG_OTHER, asB), "shot.id_conflict");
      // B presents A's payload naming A's permit but B's receipt.
      const mixed = await bound(PG_OTHER, payloadA);
      assertNotEquals(await applyAs(sql, PG_OTHER, mixed), "accepted");

      const fa = await facts(sql, PG_USER, shotId);
      const fb = await facts(sql, PG_OTHER, shotId);
      assertEquals(fa.shots, 1);
      assertEquals(fa.receipts, 1);
      assertEquals(fa.permits[permitA], "finalized/scored");
      assertEquals(fb.permits[permitB], "reserved/", "B's permit is never consumed");
      assertEquals(fb.ledger, 0, "B's lifetime count never moves");
      const stored = await sql.unsafe(
        `select user_id::text as user_id from public.settlement_receipts where shot_id = '${shotId}'`,
      );
      assertEquals(
        stored.map((r) => String(r.user_id)),
        [PG_USER],
      );
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, PG_OTHER);
        const rows = await tx.unsafe(
          `select shot_id from public.settlement_receipts where shot_id = '${shotId}'`,
        );
        assertEquals(rows.length, 0);
      });
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 11 · a row settled BEFORE receipts existed (legacy row) ──

Deno.test({
  name: "W01-03 attack · legacy row: a shot settled before receipts existed accepts any replay under its id without a receipt (disclosed limitation) — but it must never consume a credit or a sequence, and must never grow a receipt after the fact",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      const permit = await reservePermit(sql, PG_USER, "w0103-attack-legacy");
      const spare = await reservePermit(sql, PG_USER, "w0103-attack-legacy-spare");
      const shotId = crypto.randomUUID();
      // Pre-migration state: the shot exists (owner write, no vouch, no
      // receipt) and its permit is finalized.
      await sql.unsafe(
        `insert into public.shots (id, user_id, analysis_permit_id, shot_type, camera_view, captured_at,
            start_ms, contact_ms, end_ms, overall_score, analysis_confidence, result_kind, source,
            app_version, model_bundle_version, pose_model_version, paddle_model_version,
            stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
         values ('${shotId}', '${PG_USER}', '${permit}', 'dink', 'side', '2026-09-08T10:00:00Z',
            0, 500, 1000, 7.5, 0.9, 'scored', 'real',
            '1.0.0', 'bundle-1', 'pose-1', 'paddle-1', 'stroke-1', 'phase-1', 'scoring-1', 'config-1')`,
      );
      await sql.unsafe(
        `update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '${permit}'`,
      );
      const before = await facts(sql, PG_USER, shotId);
      assertEquals(before.receipts, 0);

      const mutated = await bound(PG_USER, pgPayload(shotId, spare, { overallScore: 9.9 }));
      const verdict = await applyAs(sql, PG_USER, mutated);
      const after = await facts(sql, PG_USER, shotId);
      assertEquals(after.shots, 1);
      assertEquals(after.receipts, 0, "a replay must never mint a receipt for a legacy row");
      assertEquals(after.permits[spare], "reserved/", "zero credit consumed");
      assertEquals(after.ledger, before.ledger, "zero sequence consumed");
      const stored = await sql.unsafe(
        `select overall_score::text as score, analysis_permit_id::text as permit from public.shots where id = '${shotId}'`,
      );
      assertEquals(Number(stored[0].score), 7.5, "the original row is never mutated");
      assertEquals(stored[0].permit, permit);
      // Disclosed by the implementer: the ownership verdict stands for legacy
      // rows. Recorded here so the verdict is pinned rather than assumed.
      assertEquals(verdict, "accepted");
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 12 · RPC boundaries the edge cannot reach (forged transport) ──

Deno.test({
  name: "W01-03 attack · RPC boundaries: receipts at the byte/shape limits (65536 vs 65537 bytes, uppercase digest, generation 1e9 / 1.0 / '3', 129-char ids, ticket without generation, policy without sha256) are refused as shot.receipt_invalid with the permit untouched",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      const permit = await reservePermit(sql, PG_USER, "w0103-attack-bounds");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      const good = await bound(PG_USER, payload);
      const transport = good.settlementReceipt as ReceiptTransport;
      const receipt = JSON.parse(transport.canonical) as Record<string, unknown>;
      const binding = receipt.binding as Record<string, unknown>;

      const forge = async (
        mutate: (r: Record<string, unknown>, b: Record<string, unknown>) => void,
      ) => {
        const r = structuredClone(receipt);
        const b = r.binding as Record<string, unknown>;
        mutate(r, b);
        const canonical = JSON.stringify(r);
        return { ...payload, settlementReceipt: { canonical, sha256: await sha256Hex(canonical) } };
      };
      // Pad to an exact character count through a key the RPC does not
      // inspect (the edge never emits one; only the byte bound can refuse it).
      const sized = (base: Record<string, unknown>, size: number): string => {
        const probe = JSON.stringify({ ...base, zzPad: "" });
        const canonical = JSON.stringify({ ...base, zzPad: "o".repeat(size - probe.length) });
        assertEquals(canonical.length, size);
        return canonical;
      };
      const oversized = async (size: number) => {
        const canonical = sized(receipt, size);
        return { ...payload, settlementReceipt: { canonical, sha256: await sha256Hex(canonical) } };
      };

      const attempts: Array<[string, Record<string, unknown>]> = [
        [
          "uppercase transport digest",
          {
            ...payload,
            settlementReceipt: { ...transport, sha256: transport.sha256.toUpperCase() },
          },
        ],
        [
          "uppercase payload digest",
          await forge((_r, b) => (b.payloadSha256 = String(b.payloadSha256).toUpperCase())),
        ],
        [
          "generation 1e9",
          await forge(
            (_r, b) => ((b.ticket as Record<string, unknown>).generation = 1_000_000_000),
          ),
        ],
        [
          "generation 3.0 (float text)",
          await (async () => {
            const canonical = transport.canonical.replace(
              `"generation":${CLAIMS.ticket.generation}`,
              `"generation":${CLAIMS.ticket.generation}.0`,
            );
            assertNotEquals(canonical, transport.canonical);
            return {
              ...payload,
              settlementReceipt: { canonical, sha256: await sha256Hex(canonical) },
            };
          })(),
        ],
        [
          "generation as string",
          await forge((_r, b) => ((b.ticket as Record<string, unknown>).generation = "3")),
        ],
        [
          "generation negative",
          await forge((_r, b) => ((b.ticket as Record<string, unknown>).generation = -1)),
        ],
        [
          "ticket without generation",
          await forge((_r, b) => {
            const t = b.ticket as Record<string, unknown>;
            delete t.generation;
          }),
        ],
        [
          "129-char installation key",
          await forge((_r, b) => (b.installationKeyId = "k".repeat(129))),
        ],
        ["empty operation id", await forge((_r, b) => (b.operationId = ""))],
        [
          "policy without sha256",
          await forge((r) => {
            const p = r.policy as Record<string, unknown>;
            delete p.sha256;
          }),
        ],
        [
          "policy version 129 chars",
          await forge((r) => ((r.policy as Record<string, unknown>).version = "v".repeat(129))),
        ],
        ["binding sha256 not hex", await forge((r) => (r.bindingSha256 = "z".repeat(64)))],
        ["owner id is another user", await forge((_r, b) => (b.ownerId = PG_OTHER))],
        ["result kind 'abstain'", await forge((_r, b) => (b.resultKind = "abstain"))],
        ["scored with null policy", await forge((r) => (r.policy = null))],
        ["receipt 65537 chars", await oversized(65_537)],
        [
          "canonical is JSON null",
          { ...payload, settlementReceipt: { canonical: "null", sha256: await sha256Hex("null") } },
        ],
        [
          "canonical is a JSON array",
          { ...payload, settlementReceipt: { canonical: "[]", sha256: await sha256Hex("[]") } },
        ],
      ];
      for (const [label, attempt] of attempts) {
        const verdict = await applyAs(sql, PG_USER, attempt);
        assertEquals(verdict, "shot.receipt_invalid", label);
        const f = await facts(sql, PG_USER, shotId);
        assertEquals(f.shots, 0, label);
        assertEquals(f.receipts, 0, label);
        assertEquals(f.permits[permit], "reserved/", `${label}: permit untouched`);
        assertEquals(f.ledger, 0, `${label}: nothing counted`);
      }
      // The 1.0 float is what the edge would never send (it canonicalizes to 1),
      // and 1e9 is beyond both bounds — but a receipt at EXACTLY the byte
      // limit with a generation at EXACTLY the limit is a valid settlement.
      const edge = structuredClone(receipt);
      ((edge.binding as Record<string, unknown>).ticket as Record<string, unknown>).generation =
        999_999_999;
      (edge.binding as Record<string, unknown>).operationId = "o".repeat(128);
      assert(typeof binding.operationId === "string");
      const canonical = sized(edge, 65_536);
      // The binding hash is not recomputed by the RPC (it cannot canonicalize
      // RFC 8785); the transport digest is what it verifies.
      const atLimit = {
        ...payload,
        settlementReceipt: { canonical, sha256: await sha256Hex(canonical) },
      };
      assertEquals(await applyAs(sql, PG_USER, atLimit), "accepted", "exactly at the limits");
      const f = await facts(sql, PG_USER, shotId);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[permit], "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 13 · conservation after the free limit; mismatch ordering vs permit verdicts ──

Deno.test({
  name: "W01-03 attack · conservation at the RPC: an identical replay after the account hit its free limit is still the original acceptance (not a paywall), and a mismatched replay naming a released / foreign / missing permit is still refused as a mismatch before any permit verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      await createUser(sql, PG_OTHER, "w0103-attack-sub-2");
      const p1 = await reservePermit(sql, PG_USER, "w0103-attack-limit-1");
      const released = await reservePermit(sql, PG_USER, "w0103-attack-limit-released");
      const foreign = await reservePermit(sql, PG_OTHER, "w0103-attack-limit-foreign");
      const s1 = crypto.randomUUID();
      const s2 = crypto.randomUUID();
      const first = await bound(PG_USER, pgPayload(s1, p1));
      assertEquals(await applyAs(sql, PG_USER, first), "accepted");
      // A real abstention releases its permit through the RPC.
      const abstention = await bound(
        PG_USER,
        pgPayload(crypto.randomUUID(), released, {
          resultKind: "low_confidence",
          overallScore: null,
          confidence: 0.2,
        }),
        CLAIMS,
        null,
      );
      assertEquals(await applyAs(sql, PG_USER, abstention), "accepted");
      const p2 = await reservePermit(sql, PG_USER, "w0103-attack-limit-2");
      assertEquals(
        await applyAs(sql, PG_USER, await bound(PG_USER, pgPayload(s2, p2))),
        "accepted",
      );
      let f = await facts(sql, PG_USER, s1);
      assertEquals(f.ledger, 2, "both free ratings spent");

      // Identical replay of the first settlement past the limit.
      assertEquals(await applyAs(sql, PG_USER, structuredClone(first)), "accepted");
      f = await facts(sql, PG_USER, s1);
      assertEquals(f.ledger, 2);
      assertEquals(f.receipts, 1);

      // A released permit (an abstention released it), a permit of another
      // user, and a permit that does not exist: the mismatch must still win
      // over every permit verdict, and no permit may move.
      assertEquals(f.permits[released], "released/low_confidence");
      const attempts: Array<[string, string]> = [
        ["released permit", released],
        ["foreign permit", foreign],
        ["missing permit", crypto.randomUUID()],
      ];
      for (const [label, permitId] of attempts) {
        const replay = await bound(PG_USER, pgPayload(s1, permitId));
        assertEquals(await applyAs(sql, PG_USER, replay), "shot.receipt_mismatch", label);
      }
      const permits = await sql.unsafe(
        `select id::text as id, status, coalesce(outcome, '') as outcome from public.analysis_permits where id in ('${released}', '${foreign}')`,
      );
      for (const row of permits) {
        if (String(row.id) === released)
          assertEquals(`${row.status}/${row.outcome}`, "released/low_confidence");
        if (String(row.id) === foreign) assertEquals(`${row.status}/${row.outcome}`, "reserved/");
      }
      f = await facts(sql, PG_USER, s1);
      assertEquals(f.ledger, 2);
      assertEquals(f.receipts, 1);
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 15 · unauthorised roles on the new SQL surfaces (allowed AND denied) ──

Deno.test({
  name: "W01-03 attack · roles: anon cannot settle or read receipts, clients cannot execute the receipt trigger functions, an owner without the API gate reads nothing, the owner through the gate reads only its own rows, and the service owner may read but never rewrite a receipt",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      await createUser(sql, PG_OTHER, "w0103-attack-sub-2");
      const permit = await reservePermit(sql, PG_USER, "w0103-attack-roles");
      const shotId = crypto.randomUUID();
      const settlement = await bound(PG_USER, pgPayload(shotId, permit));
      assertEquals(await applyAs(sql, PG_USER, settlement), "accepted");

      const sqlstate = async (setup: (tx: Tx) => Promise<void>, statement: string) => {
        let code = "ok";
        try {
          await sql.begin(async (tx) => {
            await setup(tx as unknown as Tx);
            await tx.unsafe(statement);
          });
        } catch (error) {
          code = String((error as { code?: string }).code ?? "unknown");
        }
        return code;
      };
      const asAnon = async (tx: Tx) => {
        await tx.unsafe(`set local role anon`);
      };
      const asOwnerNoGate = async (tx: Tx) => {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = '${PG_USER}'`);
      };
      const asOwner = (tx: Tx) => asUser(tx, PG_USER);

      // Denied paths.
      assertEquals(
        await sqlstate(
          asAnon,
          `select public.apply_synced_shot('${JSON.stringify(settlement)}'::jsonb)`,
        ),
        "42501",
        "anon cannot settle",
      );
      assertEquals(
        await sqlstate(asAnon, `select * from public.settlement_receipts`),
        "42501",
        "anon cannot read receipts",
      );
      for (const fn of [
        "public.record_settlement_receipt()",
        "public.guard_settlement_receipt_lifecycle()",
      ]) {
        const priv = await sql.unsafe(
          `select has_function_privilege('authenticated', '${fn}', 'EXECUTE') as a,
                  has_function_privilege('anon', '${fn}', 'EXECUTE') as b`,
        );
        assertEquals(Boolean(priv[0].a), false, `${fn} not executable by authenticated`);
        assertEquals(Boolean(priv[0].b), false, `${fn} not executable by anon`);
      }
      await sql.begin(async (tx) => {
        await asOwnerNoGate(tx as unknown as Tx);
        const rows = await tx.unsafe(
          `select shot_id from public.settlement_receipts where shot_id = '${shotId}'`,
        );
        assertEquals(rows.length, 0, "an owner outside the API gate reads nothing");
      });

      // Allowed paths.
      await sql.begin(async (tx) => {
        await asOwner(tx as unknown as Tx);
        const rows = await tx.unsafe(
          `select shot_id::text as shot_id from public.settlement_receipts`,
        );
        assertEquals(
          rows.map((r) => String(r.shot_id)),
          [shotId],
          "the owner sees exactly its own rows",
        );
      });
      const service = await sql.unsafe(
        `select count(*)::int as n from public.settlement_receipts where shot_id = '${shotId}'`,
      );
      assertEquals(Number(service[0].n), 1, "the service owner may read");
      // Even the service owner cannot rewrite or remove a receipt while the
      // shot exists (append-only for every role).
      assertEquals(
        await sqlstate(
          async () => {},
          `update public.settlement_receipts set policy_version = 'x' where shot_id = '${shotId}'`,
        ),
        "23514",
      );
      assertEquals(
        await sqlstate(
          async () => {},
          `delete from public.settlement_receipts where shot_id = '${shotId}'`,
        ),
        "23514",
      );
      // A settlement presented WITHOUT a JWT subject is auth.required, never a
      // service-side settlement on someone's behalf.
      const noSubject = await sql.unsafe(
        `select public.apply_synced_shot('${JSON.stringify(settlement)}'::jsonb) as result`,
      );
      assertEquals(String(noSubject[0].result), "auth.required");
    } finally {
      await sql.end();
    }
  },
});

// ── ATTACK 14 · process death between the RPC commit and the acknowledgement, N times ──

Deno.test({
  name: "W01-03 attack · crash window: the settlement committed but the acknowledgement never arrived — five identical retries under two policy rotations settle once, return the one receipt and consume nothing more",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await createUser(sql, PG_USER, "w0103-attack-sub-1");
      const permit = await reservePermit(sql, PG_USER, "w0103-attack-crash");
      const spare = await reservePermit(sql, PG_USER, "w0103-attack-crash-spare");
      const shotId = crypto.randomUUID();
      const payload = pgPayload(shotId, permit);
      const original = await bound(PG_USER, payload);
      assertEquals(await applyAs(sql, PG_USER, original), "accepted");
      const stored = await sql.unsafe(
        `select receipt_sha256 from public.settlement_receipts where shot_id = '${shotId}'`,
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const verdict = await applyAs(sql, PG_USER, structuredClone(original));
        assertEquals(verdict, "accepted", `retry ${attempt}`);
      }
      const f = await facts(sql, PG_USER, shotId);
      assertEquals(f.shots, 1);
      assertEquals(f.receipts, 1);
      assertEquals(f.permits[spare], "reserved/");
      assertEquals(f.ledger, 1);
      const after = await sql.unsafe(
        `select receipt_sha256 from public.settlement_receipts where shot_id = '${shotId}'`,
      );
      assertEquals(
        after[0].receipt_sha256,
        stored[0].receipt_sha256,
        "the original receipt stands",
      );
    } finally {
      await sql.end();
    }
  },
});
