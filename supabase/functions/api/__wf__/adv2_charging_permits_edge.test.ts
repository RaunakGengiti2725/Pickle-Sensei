// INT-charging-permits adversary (pass 2) — edge integration boundaries of the
// joint chargeability contract at HEAD 2994371e1c5edf9a1e9bb12f6c6e4751e3fb4ea1,
// attacked black-box through the REAL edge handler (routesHarness: Supabase
// stubbed at the fetch layer, every upstream call observable).
//
// Invariants under attack: charge only after BOTH independently validated
// outputs are durably delivered; partial / withheld / failed / replayed
// results never consume a credit; ambiguous commitment is HOLD with recovery
// (never refund, never a retry under a new operation id); permits never
// resurrect; premium bypasses the free allowance but never the permit or the
// release authority.
//
// A test that PASSES documents a boundary that HELD at this head; a test that
// FAILS is a confirmed break. Attack ids (ADV2-E*) are referenced from the
// adversary report.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { resolveAnalysisReleaseEligibility } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { decideChargeability } from "../../../../packages/shared-types/src/chargeability.ts";
import fixtures from "../../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json" with {
  type: "json",
};
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RELEASE_CODE = "access.release_not_authorized";
const MISMATCH_CODE = "shot.receipt_mismatch";
const INVALID_CODE = "shot.invalid_payload";
const WRITE_FAILED_CODE = "shot.write_failed";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const RESERVE_RPC = "/rest/v1/rpc/reserve_analysis_permit";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const PERMITS_TABLE = "/rest/v1/analysis_permits";

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

const artifact = { version: "adv2-1", sha256: "b".repeat(64) };
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
/** ACTIVE policy whose supported domain is exactly dink / side / right /
 * imported_video. Everything else is `unsupported` per the shared contract. */
const document: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "adv2-policy-1",
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

async function withdrawn() {
  const data = await authority();
  data.denyNewAuthorizations = true;
  data.approval.denyNewAuthorizations = true;
  data.approval.withdrawnAt = NOW - 60;
  return data;
}

let subject = 0;
function signIn(options: { premium?: boolean } = {}) {
  subject += 1;
  const userId = `7a0c4a22-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.tables.settlement_receipts = [];
  h.rpcs.access_state = [{ premium: options.premium ?? false, scored_count: 0, reserved_count: 0 }];
  h.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: crypto.randomUUID(),
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: new Date().toISOString(),
    },
  ];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: `203.0.113.${subject}`, userId };
}

type Auth = ReturnType<typeof signIn>;

interface ShotOverrides {
  id?: string;
  analysisPermitId?: string | null;
  shotType?: string;
  cameraView?: string;
  overallScore?: unknown;
  extra?: Record<string, unknown>;
}

function shot(resultKind: "scored" | "low_confidence" | "partial", overrides: ShotOverrides = {}) {
  const base: Record<string, unknown> = {
    id: overrides.id ?? crypto.randomUUID(),
    source: "real",
    analysisPermitId: overrides.analysisPermitId === undefined
      ? crypto.randomUUID()
      : overrides.analysisPermitId,
    sessionId: null,
    shotType: overrides.shotType ?? "dink",
    cameraView: overrides.cameraView ?? "side",
    capturedAt: "2026-09-08T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore: "overallScore" in overrides
      ? overrides.overallScore
      : resultKind === "scored"
      ? 7.5
      : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...(overrides.extra ?? {}),
  };
  if (overrides.analysisPermitId === null) delete base.analysisPermitId;
  return base;
}

async function reserve(auth: Auth, idempotencyKey = crypto.randomUUID()) {
  const response = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: auth.token,
      ip: auth.ip,
      body: { idempotencyKey },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function finalize(auth: Auth, permitId: string, outcome: unknown) {
  const response = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: auth.token,
      ip: auth.ip,
      body: { outcome, ratingId: null },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface SyncBody {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
  receipts?: Array<{ id: string; canonical: string; sha256: string }>;
}

async function sync(auth: Auth, shots: unknown[]) {
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
  );
  return { status: response.status, body: (await response.json()) as SyncBody };
}

function appliedShots(): Array<Record<string, unknown>> {
  return h.callsTo(APPLY_RPC).map((call) => {
    const body = call.body as { shot: Record<string, unknown> };
    return body.shot;
  });
}

function permitWrites() {
  return h.callsTo(PERMITS_TABLE).filter((c) => c.method === "PATCH" || c.method === "POST");
}

function errorCode(body: Record<string, unknown>): unknown {
  const error = body.error;
  return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

function receiptOf(body: SyncBody, id: string) {
  assert(Array.isArray(body.receipts), "response carries receipts");
  const entry = body.receipts.find((r) => r.id === id);
  assert(entry, `receipt for ${id}`);
  return entry;
}

/** Persist the receipt the edge produced, as the RPC's trigger would. */
function storeSettlement(
  auth: Auth,
  shotId: string,
  receipt: { canonical: string; sha256: string },
) {
  h.tables.shots = [{ id: shotId, user_id: auth.userId }];
  h.tables.settlement_receipts = [
    {
      shot_id: shotId,
      user_id: auth.userId,
      receipt_canonical: receipt.canonical,
      receipt_sha256: receipt.sha256,
    },
  ];
}

/** A first, admitted scored settlement whose receipt is then durable. */
async function settledScored(auth: Auth) {
  h.rpcs.read_analysis_release_policy = await authority();
  const scored = shot("scored");
  const first = await sync(auth, [scored]);
  assertEquals(first.status, 200, JSON.stringify(first.body));
  assertEquals(first.body.acceptedIds, [scored.id]);
  assertEquals(h.callsTo(APPLY_RPC).length, 1);
  const receipt = receiptOf(first.body, scored.id as string);
  storeSettlement(auth, scored.id as string, receipt);
  return { scored, receipt };
}

const partialFixture = fixtures.cases.find(
  (c) => c.id === "partial_mechanics_only_benchmark_insufficient_evidence",
);
assert(partialFixture, "shared fixture table must carry the mechanics-only partial case");

// ── ADV2-E1 — partial output presented as `scored` is charged ────────────────
// The sync wire shape carries ONE label (`resultKind`) and one number
// (`overallScore`); nothing on the server asks whether the SECOND output
// (technique benchmark) was validated. A row that explicitly says its
// benchmark was withheld is settled as a chargeable scored rating.

Deno.test("ADV2-E1 shared contract: the mechanics-only fixture is NOT chargeable", () => {
  const decision = decideChargeability(partialFixture.outcome, partialFixture.eligibility);
  assertEquals(decision.chargeable, false);
  assertEquals(decision.creditsConsumed, 0);
  assertEquals(decision.reasonCode, "outcome_partial");
});

Deno.test(
  "ADV2-E1 sync: a scored row carrying an explicit WITHHELD benchmark marker must not reach the chargeable RPC",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored", {
      extra: {
        benchmark: { schemaVersion: "technique-benchmark-v1", status: "insufficient_evidence" },
      },
    });
    const synced = await sync(auth, [scored]);
    assertEquals(synced.status, 200, JSON.stringify(synced.body));
    // EXPECTED: the withheld second output makes the outcome partial — no
    // chargeable settlement. OBSERVED at HEAD: apply_synced_shot is called
    // with resultKind='scored' (the permit is finalized and the rating counted).
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      0,
      `chargeable RPC called ${h.callsTo(APPLY_RPC).length}x for a withheld-benchmark row: ${
        JSON.stringify(appliedShots().map((s) => s.resultKind))
      }`,
    );
  },
);

// ── ADV2-E2 — out-of-domain scored shot under an ACTIVE policy ──────────────

Deno.test(
  "ADV2-E2 sync: a scored shot OUTSIDE the active policy's supported domain must not be settled",
  async () => {
    const active = await authority();
    const eligibility = resolveAnalysisReleaseEligibility(
      document,
      active.approval,
      {
        shotType: "forehand_drive",
        cameraView: "rear_oblique",
        handedness: "right",
        captureMode: "imported_video",
      },
      NOW,
    );
    assertEquals(eligibility, { status: "ineligible", reasonCode: "unsupported" });
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const out = shot("scored", { shotType: "forehand_drive", cameraView: "rear_oblique" });
    const synced = await sync(auth, [out]);
    assertEquals(synced.status, 200, JSON.stringify(synced.body));
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      0,
      `out-of-domain scored shot reached apply_synced_shot (${synced.body.acceptedIds.length} accepted)`,
    );
  },
);

// ── ADV2-E3 — withheld-after-reserve: HOLD must come with recovery ──────────

Deno.test(
  "ADV2-E3 release authority withdrawn between reserve and sync: the final refusal must settle (or hold retryably) the reservation it strands",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const reserved = await reserve(auth);
    assertEquals(reserved.status, 200, JSON.stringify(reserved.body));
    const permit = reserved.body.permit as { id: string; status: string };
    assertEquals(permit.status, "reserved");
    h.tables.analysis_permits = [
      {
        id: permit.id,
        user_id: auth.userId,
        status: "reserved",
        outcome: null,
        created_at: new Date().toISOString(),
      },
    ];

    h.rpcs.read_analysis_release_policy = await withdrawn();
    const synced = await sync(auth, [shot("scored", { analysisPermitId: permit.id })]);
    assertEquals(synced.status, 200, JSON.stringify(synced.body));
    assertEquals(synced.body.rejected.map((r) => r.code), [RELEASE_CODE]);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
    // The code is permanent for the mobile outbox (not in
    // TRANSIENT_SYNC_REJECTION_CODES) and 'scored' is not finalizable...
    const direct = await finalize(auth, permit.id, "scored");
    assertEquals(direct.status, 400, JSON.stringify(direct.body));
    // ...so either the server settles the reservation now, or the verdict
    // must be retryable (HOLD). Neither: zero permit writes.
    assert(
      permitWrites().length >= 1,
      `final refusal ${RELEASE_CODE} settled nothing: permit ${permit.id} stays reserved until the sweep and the device holds a dead letter`,
    );
  },
);

// ── ADV2-E4 — "retry under a new operation id" of an already settled shot ───
// A shot that was settled under permit P is replayed with a fresh permit Q
// (the client re-reserved after losing its receipt). The receipt binding must
// refuse it BEFORE the authority read and BEFORE the chargeable RPC; Q is
// never spent and no second credit is consumed.

Deno.test(
  "ADV2-E4 replay of a settled shot under a NEW permit id is refused before any RPC — no second credit, no authority read",
  async () => {
    const auth = signIn();
    const { scored } = await settledScored(auth);
    const applyBefore = h.callsTo(APPLY_RPC).length;
    const policyBefore = h.callsTo(POLICY_RPC).length;

    const replay = await sync(auth, [{ ...scored, analysisPermitId: crypto.randomUUID() }]);
    assertEquals(replay.status, 200, JSON.stringify(replay.body));
    assertEquals(replay.body.acceptedIds, []);
    assertEquals(replay.body.rejected.map((r) => r.code), [MISMATCH_CODE]);
    assertEquals(replay.body.receipts, undefined, "no receipt for a refused replay");
    assertEquals(h.callsTo(APPLY_RPC).length, applyBefore, "chargeable RPC not called again");
    assertEquals(
      h.callsTo(POLICY_RPC).length,
      policyBefore,
      "authority not consulted for a replay",
    );
    assertEquals(permitWrites().length, 0);

    // Same id, same permit, but the payload changed (a different score): still
    // a different settlement wearing the id.
    const rescored = await sync(auth, [{ ...scored, overallScore: 9.9 }]);
    assertEquals(rescored.body.rejected.map((r) => r.code), [MISMATCH_CODE]);
    assertEquals(h.callsTo(APPLY_RPC).length, applyBefore);
  },
);

// ── ADV2-E5 — identical replay is answered from the receipt, whatever the
// authority says now (withdrawn) or whether it answers at all (down) ────────

Deno.test(
  "ADV2-E5 identical replay after the policy was withdrawn / while the authority is DOWN returns the ORIGINAL receipt, spends nothing",
  async () => {
    const auth = signIn();
    const { scored, receipt } = await settledScored(auth);
    const applyBefore = h.callsTo(APPLY_RPC).length;
    const policyBefore = h.callsTo(POLICY_RPC).length;

    h.rpcs.read_analysis_release_policy = await withdrawn();
    const afterWithdrawal = await sync(auth, [structuredClone(scored)]);
    assertEquals(afterWithdrawal.status, 200, JSON.stringify(afterWithdrawal.body));
    assertEquals(afterWithdrawal.body.acceptedIds, [scored.id]);
    assertEquals(afterWithdrawal.body.rejected, []);
    assertEquals(receiptOf(afterWithdrawal.body, scored.id as string).sha256, receipt.sha256);

    delete h.rpcs.read_analysis_release_policy;
    h.rpcErrors.read_analysis_release_policy = 503;
    const whileDown = await sync(auth, [structuredClone(scored)]);
    assertEquals(whileDown.status, 200, JSON.stringify(whileDown.body));
    assertEquals(whileDown.body.acceptedIds, [scored.id]);
    assertEquals(receiptOf(whileDown.body, scored.id as string).canonical, receipt.canonical);

    assertEquals(h.callsTo(APPLY_RPC).length, applyBefore, "a replay never re-charges");
    assertEquals(h.callsTo(POLICY_RPC).length, policyBefore, "a replay never reads the authority");
    assertEquals(permitWrites().length, 0);
  },
);

// ── ADV2-E6 — authority unavailable: abstentions settle, scored batches HOLD ─

Deno.test(
  "ADV2-E6 authority DOWN: a batch of abstention + partial still settles; a batch holding a scored shot is HELD whole (503) with nothing written",
  async () => {
    const auth = signIn();
    h.rpcErrors.read_analysis_release_policy = 503;

    const abstained = shot("low_confidence");
    const partial = shot("partial");
    const nonChargeable = await sync(auth, [abstained, partial]);
    assertEquals(nonChargeable.status, 200, JSON.stringify(nonChargeable.body));
    assertEquals(nonChargeable.body.acceptedIds.sort(), [abstained.id, partial.id].sort());
    assertEquals(appliedShots().map((s) => s.resultKind).sort(), ["low_confidence", "partial"]);
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "no authority read for non-chargeable rows");
    for (const applied of appliedShots()) {
      const transport = applied.settlementReceipt as { canonical: string };
      const parsed = JSON.parse(transport.canonical) as { policy: unknown };
      assertEquals(parsed.policy, null, "a non-chargeable settlement names no policy lineage");
    }

    h.reset();
    const again = signIn();
    h.rpcErrors.read_analysis_release_policy = 503;
    const held = await sync(again, [shot("scored"), shot("partial")]);
    assertEquals(held.status, 503, JSON.stringify(held.body));
    assertEquals(h.callsTo(APPLY_RPC).length, 0, "HOLD: nothing settled, nothing refunded");
    assertEquals(permitWrites().length, 0);
  },
);

// ── ADV2-E7 — finalize: malformed outcomes and resurrection attempts ────────

Deno.test(
  "ADV2-E7 finalize refuses scored/partial/expired/free_limit_exceeded/junk outcomes with 400 and touches no permit; a settled permit cannot be re-finalized to another outcome",
  async () => {
    const auth = signIn();
    const permitId = crypto.randomUUID();
    h.tables.analysis_permits = [
      {
        id: permitId,
        user_id: auth.userId,
        status: "reserved",
        outcome: null,
        created_at: new Date().toISOString(),
      },
    ];
    for (
      const outcome of ["scored", "partial", "expired", "free_limit_exceeded", "", 42, null, [
        "low_confidence",
      ]]
    ) {
      const res = await finalize(auth, permitId, outcome);
      assertEquals(res.status, 400, `${JSON.stringify(outcome)} → ${JSON.stringify(res.body)}`);
      assertEquals(errorCode(res.body), "validation.analysis_permit_finalize");
    }
    assertEquals(h.callsTo(PERMITS_TABLE).length, 0, "malformed outcomes never cost a query");

    // Settled permits: replaying the same outcome is acknowledged; any other
    // outcome is a 409 and writes nothing (no resurrection through finalize).
    for (
      const [status, outcome] of [
        ["released", "cancelled"],
        ["finalized", "scored"],
        ["released", "expired"],
        ["released", "partial"],
        ["released", "free_limit_exceeded"],
      ] as const
    ) {
      h.tables.analysis_permits = [
        {
          id: permitId,
          user_id: auth.userId,
          status,
          outcome,
          created_at: new Date().toISOString(),
        },
      ];
      for (
        const attempt of [
          "low_confidence",
          "cancelled",
          "failed",
          "unsupported",
          "incorrect_recognition",
        ]
      ) {
        const res = await finalize(auth, permitId, attempt);
        if (attempt === outcome) {
          assertEquals(res.status, 200, `${status}/${outcome} replay ${attempt}`);
        } else {
          assertEquals(
            res.status,
            409,
            `${status}/${outcome} ← ${attempt}: ${JSON.stringify(res.body)}`,
          );
          assertEquals(errorCode(res.body), "access.permit_already_finalized");
        }
      }
    }
    assertEquals(permitWrites().length, 0, "no PATCH/POST reached analysis_permits");
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

// ── ADV2-E8 — reserve: settled replays are surfaced honestly; refusals write
// nothing; the authority gates the RPC ───────────────────────────────────────

Deno.test(
  "ADV2-E8 reserve: an idempotent replay that resolves to a SETTLED permit is returned with its real status (never relabelled reserved); paywall and ineligible authority reserve nothing",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const settledId = crypto.randomUUID();
    h.rpcs.reserve_analysis_permit = [
      {
        result: "accepted",
        permit_id: settledId,
        permit_status: "released",
        permit_outcome: "cancelled",
        permit_created_at: new Date().toISOString(),
      },
    ];
    const replay = await reserve(auth, crypto.randomUUID());
    assertEquals(replay.status, 200, JSON.stringify(replay.body));
    const permit = replay.body.permit as { id: string; status: string; outcome: string | null };
    assertEquals(permit.id, settledId);
    assertNotEquals(permit.status, "reserved", "a cancelled permit must not come back as reserved");
    assertEquals(permit.outcome, "cancelled");
    assertEquals(permitWrites().length, 0);

    h.rpcs.reserve_analysis_permit = [{ result: "access.paywall_required", permit_id: null }];
    const paywall = await reserve(auth);
    assertEquals(paywall.status, 402, JSON.stringify(paywall.body));
    assertEquals(errorCode(paywall.body), "access.paywall_required");
    assertEquals(permitWrites().length, 0);

    const rpcBefore = h.callsTo(RESERVE_RPC).length;
    h.rpcs.read_analysis_release_policy = await withdrawn();
    const ineligible = await reserve(auth);
    assert(ineligible.status >= 400 && ineligible.status < 500, JSON.stringify(ineligible.body));
    assertEquals(errorCode(ineligible.body), RELEASE_CODE);
    assertEquals(h.callsTo(RESERVE_RPC).length, rpcBefore, "no reservation RPC without authority");

    // Premium bypasses the allowance, never the authority.
    const pro = signIn({ premium: true });
    h.rpcs.read_analysis_release_policy = await withdrawn();
    const proReserve = await reserve(pro);
    assertEquals(errorCode(proReserve.body), RELEASE_CODE, JSON.stringify(proReserve.body));
    assertEquals(h.callsTo(RESERVE_RPC).length, 0);
  },
);

// ── ADV2-E9 — corrupt persisted receipt: unknown state is HOLD, not a fresh
// settlement and not a fabricated replay ────────────────────────────────────

Deno.test(
  "ADV2-E9 a stored receipt whose bytes no longer match their digest makes the replay a retryable shot.write_failed — never a second settlement, never an acknowledgement",
  async () => {
    const auth = signIn();
    const { scored, receipt } = await settledScored(auth);
    const applyBefore = h.callsTo(APPLY_RPC).length;
    // One byte flipped inside the stored canonical bytes; the digest column
    // still carries the original digest (bit rot / partial write).
    const flipped = receipt.canonical.slice(0, -2) +
      (receipt.canonical.endsWith("}}") ? "]}" : "}]");
    assertNotEquals(flipped, receipt.canonical);
    h.tables.settlement_receipts = [
      {
        shot_id: scored.id,
        user_id: auth.userId,
        receipt_canonical: flipped,
        receipt_sha256: receipt.sha256,
      },
    ];
    const corrupt = await sync(auth, [structuredClone(scored)]);
    assertEquals(corrupt.status, 200, JSON.stringify(corrupt.body));
    assertEquals(corrupt.body.acceptedIds, []);
    assertEquals(corrupt.body.rejected.map((r) => r.code), [WRITE_FAILED_CODE]);
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      applyBefore,
      "corrupt state never becomes a settlement",
    );

    h.tables.settlement_receipts = [
      {
        shot_id: scored.id,
        user_id: auth.userId,
        receipt_canonical: "{not json",
        receipt_sha256: receipt.sha256,
      },
    ];
    const garbage = await sync(auth, [structuredClone(scored)]);
    assertEquals(garbage.body.rejected.map((r) => r.code), [WRITE_FAILED_CODE]);
    assertEquals(h.callsTo(APPLY_RPC).length, applyBefore);
  },
);

// ── ADV2-E10 — parser: partial vocabulary and malformed labels ──────────────
// Migration 20260908100000 says the edge parser "still narrows resultKind to
// scored|low_confidence". Measure it instead of believing it.

Deno.test(
  "ADV2-E10 parser: resultKind=partial with a null score reaches the RPC as a non-chargeable partial (no authority read); a partial WITH a score, a scored WITHOUT one, and a scored without a permit are refused before any RPC",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const partial = shot("partial");
    const ok = await sync(auth, [partial]);
    assertEquals(ok.status, 200, JSON.stringify(ok.body));
    assertEquals(ok.body.acceptedIds, [partial.id]);
    assertEquals(appliedShots().map((s) => s.resultKind), ["partial"]);
    assertEquals(appliedShots()[0].overallScore, null);
    assertEquals(h.callsTo(POLICY_RPC).length, 0, "a partial never consults the authority");

    const before = h.callsTo(APPLY_RPC).length;
    const bad = await sync(auth, [
      shot("partial", { overallScore: 7.5 }),
      shot("scored", { overallScore: null }),
      shot("scored", { analysisPermitId: null }),
      shot("low_confidence", { overallScore: 3 }),
      { ...shot("scored"), resultKind: "SCORED" },
      { ...shot("scored"), resultKind: "abstained" },
    ]);
    assertEquals(bad.status, 200, JSON.stringify(bad.body));
    assertEquals(bad.body.acceptedIds, []);
    assertEquals(bad.body.rejected.length, 6);
    for (const r of bad.body.rejected) assertEquals(r.code, INVALID_CODE, JSON.stringify(r));
    assertEquals(h.callsTo(APPLY_RPC).length, before, "malformed rows never cost a query");
  },
);

// ── ADV2-E11 — premium bypass boundary at sync ──────────────────────────────

Deno.test(
  "ADV2-E11 premium: a scored sync still needs the release authority (withdrawn → refused, no RPC) and still needs a permit id; premium never bypasses the permit boundary",
  async () => {
    const pro = signIn({ premium: true });
    h.rpcs.read_analysis_release_policy = await withdrawn();
    const refused = await sync(pro, [shot("scored")]);
    assertEquals(refused.status, 200, JSON.stringify(refused.body));
    assertEquals(refused.body.rejected.map((r) => r.code), [RELEASE_CODE]);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);

    h.rpcs.read_analysis_release_policy = await authority();
    const permitless = await sync(pro, [shot("scored", { analysisPermitId: null })]);
    assertEquals(permitless.body.rejected.map((r) => r.code), [INVALID_CODE]);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);

    // With authority and a permit the settlement proceeds and its receipt
    // carries the policy lineage the premium user was admitted under.
    const admitted = await sync(pro, [shot("scored")]);
    assertEquals(admitted.body.rejected, []);
    assertEquals(h.callsTo(APPLY_RPC).length, 1);
    const transport = appliedShots()[0].settlementReceipt as { canonical: string };
    const parsed = JSON.parse(transport.canonical) as { policy: { version: string } | null };
    assertEquals(parsed.policy?.version, document.version);
  },
);
