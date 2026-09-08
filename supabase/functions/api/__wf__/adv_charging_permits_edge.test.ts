// INT-charging-permits adversary — edge integration boundaries of the joint
// chargeability contract, attacked black-box through the REAL edge handler
// (routesHarness: Supabase stubbed at the fetch layer, every upstream call
// observable).
//
// The invariant under attack: charge only after BOTH independently validated
// outputs (mechanics + technique benchmark) are durably delivered; a partial,
// withheld, failed or replayed result never consumes a credit; ambiguous
// commitment is HOLD with recovery, never a silent dead end.
//
// Attack ids (ATK-E*) are referenced from the adversary report. A test that
// PASSES here documents a boundary that HELD; a test that FAILS is a
// confirmed break at HEAD 30a4065036a917514fb4984fde73f87867f38619.

import { assert, assertEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { resolveAnalysisReleaseEligibility } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { decideChargeability } from "../../../../packages/shared-types/src/chargeability.ts";
import fixtures from "../../../../packages/shared-types/fixtures/chargeability/joint-chargeability-v1.json" with { type: "json" };
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RELEASE_CODE = "access.release_not_authorized";
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

const artifact = { version: "adv-1", sha256: "a".repeat(64) };
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
/** ACTIVE policy whose supported domain is EXACTLY one input: dink / side /
 * right-handed / imported_video. Anything else is `unsupported` per the
 * shared contract (resolveAnalysisReleaseEligibility). */
const document: AnalysisReleasePolicyDocument = {
  schemaVersion: "analysis-release-policy-v1",
  version: "adv-policy-1",
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

const NO_POLICY = { document: null, approval: null, denyNewAuthorizations: true };

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
  const userId = `7a0c4a11-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
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

interface ShotOverrides {
  id?: string;
  analysisPermitId?: string;
  shotType?: string;
  cameraView?: string;
  overallScore?: unknown;
  extra?: Record<string, unknown>;
}

function shot(resultKind: "scored" | "low_confidence" | "partial", overrides: ShotOverrides = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    source: "real",
    analysisPermitId: overrides.analysisPermitId ?? crypto.randomUUID(),
    sessionId: null,
    shotType: overrides.shotType ?? "dink",
    cameraView: overrides.cameraView ?? "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore:
      "overallScore" in overrides ? overrides.overallScore : resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...(overrides.extra ?? {}),
  };
}

async function reserve(auth: { token: string; ip: string }, idempotencyKey = crypto.randomUUID()) {
  const response = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: auth.token,
      ip: auth.ip,
      body: { idempotencyKey },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function finalize(auth: { token: string; ip: string }, permitId: string, outcome: string) {
  const response = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: auth.token,
      ip: auth.ip,
      body: { outcome, ratingId: null },
    }),
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function sync(auth: { token: string; ip: string }, shots: unknown[]) {
  const response = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token: auth.token, ip: auth.ip, body: { shots } }),
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      acceptedIds: string[];
      rejected: Array<{ id: string; code: string; message: string }>;
    },
  };
}

function appliedShots(): Array<Record<string, unknown>> {
  return h.callsTo(APPLY_RPC).map((call) => {
    const body = call.body as { shot: Record<string, unknown> };
    return body.shot;
  });
}

const partialFixture = fixtures.cases.find(
  (c) => c.id === "partial_mechanics_only_benchmark_insufficient_evidence",
);
assert(partialFixture, "shared fixture table must carry the mechanics-only partial case");

// ── ATK-E1 — partial output presented as `scored` is charged ────────────────
// The shared contract (decideChargeability) says a mechanics-only outcome with
// a withheld benchmark is `outcome_partial` / creditsConsumed 0. The sync wire
// shape carries ONE number (`overallScore`) and one `resultKind`; the edge
// never sees the second output. A client that has a mechanics score but no
// validated benchmark and labels the row `scored` is charged.

Deno.test("ATK-E1 shared contract: the mechanics-only fixture outcome is NOT chargeable", () => {
  const decision = decideChargeability(partialFixture.outcome, partialFixture.eligibility);
  assertEquals(decision.chargeable, false);
  assertEquals(decision.creditsConsumed, 0);
  assertEquals(decision.reasonCode, "outcome_partial");
});

Deno.test(
  "ATK-E1 sync: scored row carrying an explicit withheld benchmark is still settled by apply_synced_shot (charged)",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    // The honest second output, as the shared contract spells it: withheld.
    const withheldBenchmark = partialFixture.outcome.benchmark;
    const scored = shot("scored", { extra: { benchmark: withheldBenchmark } });
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    // Expected (contract): rejected non-chargeable, apply RPC never invoked.
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      0,
      "apply_synced_shot must not settle a scored shot whose benchmark is withheld",
    );
    assertEquals(result.body.acceptedIds, []);
  },
);

// ── ATK-E2 — out-of-domain scored shot admitted under an ACTIVE policy ──────
// The policy authorizes exactly dink/side/right/imported_video. The edge
// admits ANY scored shot as long as SOME policy is active; the per-shot
// eligibility of the shared contract (`unsupported`) is never evaluated.

Deno.test(
  "ATK-E2 shared contract: forehand_drive/rear_oblique is `unsupported` under this policy",
  async () => {
    const data = await authority();
    const eligibility = resolveAnalysisReleaseEligibility(
      data.document,
      data.approval,
      {
        shotType: "forehand_drive",
        cameraView: "rear_oblique",
        handedness: "right",
        captureMode: "automatic_pose_trigger",
        source: "real",
        intentConfirmed: true,
      },
      NOW,
    );
    assertEquals(eligibility, { status: "ineligible", reasonCode: "unsupported" });
  },
);

Deno.test(
  "ATK-E2 sync: scored shot OUTSIDE the policy's supported domain is settled (charged) anyway",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored", { shotType: "forehand_drive", cameraView: "rear_oblique" });
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(
      h.callsTo(APPLY_RPC).length,
      0,
      "a scored shot outside the released domain must not reach the chargeable RPC",
    );
    assertEquals(
      result.body.rejected.map((r) => r.code),
      [RELEASE_CODE],
    );
  },
);

// ── ATK-E3 — withheld AFTER reservation: HOLD without any settlement path ───
// Reserve under an ACTIVE policy (admission granted, permit occupies a free
// slot), then the authority is withdrawn before the device syncs. The scored
// shot is refused with a FINAL code, but the permit is never settled by the
// server and the client has no legal move: finalize('scored') is 400, and the
// only releasable outcomes mislabel a delivered rating. The reservation is
// held for PERMIT_LIFETIME_HOURS (24h) against the account's allowance.

Deno.test(
  "ATK-E3 withheld-after-reserve: scored shot refused, permit never settled, no client path to settle it",
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
    const scored = shot("scored", { analysisPermitId: permit.id });
    const synced = await sync(auth, [scored]);
    assertEquals(synced.status, 200, JSON.stringify(synced.body));
    assertEquals(
      synced.body.rejected.map((r) => r.code),
      [RELEASE_CODE],
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
    // The refusal is FINAL for the client: the code is not in the mobile
    // outbox's transient set (sync.ts TRANSIENT_SYNC_REJECTION_CODES), so the
    // row burns attempts and is eventually dropped — the scored shot will
    // never be re-presented against this permit.
    assert(
      ![
        "shot.write_failed",
        "evaluation.trial_write_failed",
        "auth.required",
        "shot.session_not_found",
      ].includes(RELEASE_CODE),
    );
    // The client cannot settle a delivered-but-unauthorized rating honestly:
    // 'scored' is not finalizable...
    const direct = await finalize(auth, permit.id, "scored");
    assertEquals(direct.status, 400, JSON.stringify(direct.body));
    // ...and no releasable outcome names "withheld by release authority".
    const releasable = [
      "low_confidence",
      "cancelled",
      "failed",
      "unsupported",
      "incorrect_recognition",
    ];
    assert(!releasable.includes("withheld") && !releasable.includes("release_not_authorized"));

    // EXPECTED by the invariant (ambiguous commitment ⇒ HOLD *with recovery*,
    // never a silent dead end): a FINAL refusal of the only shot the permit
    // can ever back must settle the reservation server-side (released/<final
    // reason>), so the free slot it occupies is returned now — not after the
    // 24h pg_cron sweep. Observed: the edge leaves the reservation untouched
    // while telling the user the rating "was not counted".
    const permitWrites = h
      .callsTo(PERMITS_TABLE)
      .filter((c) => c.method === "PATCH" || c.method === "POST");
    assert(
      permitWrites.length >= 1,
      `final refusal ${JSON.stringify(synced.body.rejected[0])} settled nothing: ` +
        `permit ${permit.id} stays reserved and counts against the allowance until the sweep`,
    );
  },
);

// ── ATK-E4 — premium bypass boundary under NO release authority ────────────
// Premium bypasses the free allowance but never the permit requirement nor
// the release authority. With no policy installed: reservation is a typed
// 409 (not a 5xx, not a fresh permit), a scored sync naming a permit is
// refused before apply_synced_shot, and a mechanics-only partial — never
// chargeable — still settles without consulting the authority.

Deno.test(
  "ATK-E4 premium + no policy: no reservation, no scored settlement, partial still settles",
  async () => {
    const auth = signIn({ premium: true });
    h.rpcs.read_analysis_release_policy = NO_POLICY;
    const reserved = await reserve(auth);
    assertEquals(reserved.status, 409, JSON.stringify(reserved.body));
    assertEquals((reserved.body.error as { code: string }).code, RELEASE_CODE);
    assertEquals(h.callsTo(RESERVE_RPC).length, 0);

    const scored = shot("scored");
    const refused = await sync(auth, [scored]);
    assertEquals(refused.status, 200, JSON.stringify(refused.body));
    assertEquals(refused.body.acceptedIds, []);
    assertEquals(
      refused.body.rejected.map((r) => r.code),
      [RELEASE_CODE],
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);

    const partial = shot("partial");
    const synced = await sync(auth, [partial]);
    assertEquals(synced.status, 200, JSON.stringify(synced.body));
    assertEquals(synced.body.acceptedIds, [partial.id]);
    assertEquals(synced.body.rejected, []);
    assertEquals(
      appliedShots().map((s) => s.resultKind),
      ["partial"],
    );
  },
);

// ── ATK-E5 — replayed idempotency key after settlement ──────────────────────
// Relaunch replays reserve(reservationKey) for a permit that already settled.
// The edge answers 200 with the SETTLED permit view; the journal recovery
// (runJournal.ts recoverOne) treats a non-reserved status as terminal
// permit_not_reserved and never releases it — no second credit, no reopen.

Deno.test(
  "ATK-E5 reserve replay of a settled key returns the settled permit (no fresh reservation, no reopen)",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const settledId = crypto.randomUUID();
    h.rpcs.reserve_analysis_permit = [
      {
        result: "accepted",
        permit_id: settledId,
        permit_status: "finalized",
        permit_outcome: "scored",
        permit_created_at: new Date().toISOString(),
      },
    ];
    const replay = await reserve(auth, "relaunch-replayed-key");
    assertEquals(replay.status, 200, JSON.stringify(replay.body));
    const permit = replay.body.permit as { id: string; status: string; outcome: string | null };
    assertEquals(permit.id, settledId);
    assertEquals(permit.status, "finalized");
    assertEquals(permit.outcome, "scored");
    assertEquals(h.callsTo(RESERVE_RPC).length, 1);
    // No PATCH resurrects the settled row on the replay path.
    assertEquals(h.callsTo(PERMITS_TABLE).filter((c) => c.method === "PATCH").length, 0);
  },
);

// ── ATK-E6 — abstention finalize while the authority is unavailable ─────────
// An abstention is never charged, so releasing the permit must not depend on
// the release authority at all (503 from the authority must not block it).

Deno.test("ATK-E6 finalize(low_confidence) does not consult the release authority", async () => {
  const auth = signIn();
  h.rpcErrors.read_analysis_release_policy = 500;
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
  // The harness PATCH answers 201/no-body; the route then re-reads the row.
  h.respond = (call) => {
    if (call.url.includes(PERMITS_TABLE) && call.method === "PATCH") {
      h.tables.analysis_permits = [
        {
          id: permitId,
          user_id: auth.userId,
          status: "finalized",
          outcome: "low_confidence",
          created_at: new Date().toISOString(),
        },
      ];
      return new Response(
        JSON.stringify([
          {
            id: permitId,
            status: "finalized",
            outcome: "low_confidence",
            created_at: new Date().toISOString(),
          },
        ]),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    return null;
  };
  const released = await finalize(auth, permitId, "low_confidence");
  h.respond = () => null;
  assertEquals(released.status, 200, JSON.stringify(released.body));
  assertEquals(h.callsTo("/rest/v1/rpc/read_analysis_release_policy").length, 0);
  assertEquals(h.callsTo(APPLY_RPC).length, 0);
});

// ── ATK-E7 — malformed scored payloads never reach the chargeable RPC ───────

Deno.test(
  "ATK-E7 malformed scored rows: NaN / string / >10 / null score never reach apply_synced_shot",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const bad = [
      shot("scored", { overallScore: null }),
      shot("scored", { overallScore: "7.5" }),
      shot("scored", { overallScore: 10.0001 }),
      shot("scored", { overallScore: -0.1 }),
      shot("partial", { overallScore: 6 }),
      shot("low_confidence", { overallScore: 6 }),
    ];
    for (const row of bad) {
      const result = await sync(auth, [row]);
      assert(
        result.status === 400 || result.body.acceptedIds.length === 0,
        `malformed row accepted: ${JSON.stringify(row)} → ${JSON.stringify(result)}`,
      );
    }
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

// ── ATK-E8 — replayed scored result in a mixed batch never re-settles ───────

Deno.test(
  "ATK-E8 replayed scored id beside a fresh abstention: replay acknowledged, only the abstention is applied",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await withdrawn();
    const replayed = shot("scored");
    h.tables.shots = [{ id: replayed.id, user_id: auth.userId }];
    const abstention = shot("low_confidence");
    const result = await sync(auth, [replayed, abstention]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(new Set(result.body.acceptedIds), new Set([replayed.id, abstention.id]));
    assertEquals(result.body.rejected, []);
    const applied = appliedShots();
    assertEquals(applied.length, 1);
    assertEquals(applied[0]?.id, abstention.id);
  },
);
