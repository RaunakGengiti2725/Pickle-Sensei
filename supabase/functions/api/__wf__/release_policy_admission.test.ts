// W01-02 — edge admission requires an ACTIVE, non-withdrawn release policy
// before a chargeable scored run.
//
// Both chargeable paths of the REAL edge handler are exercised black-box
// through routesHarness (Supabase stubbed at the fetch layer, so the exact
// upstream calls are observable):
//   * POST /v1/analysis-permits   — reserving a permit is the admission of a
//     chargeable scored run;
//   * POST /v1/shots:sync         — apply_synced_shot settles a `scored` shot
//     (finalized/scored = the charge / the spent free rating).
// Without an active release authority (no installed policy, withdrawn,
// expired, corrupt / lineage-mismatched) admission must answer a TYPED,
// non-5xx, non-chargeable verdict and the chargeable RPC must never be
// invoked. Abstentions (low_confidence) and mechanics-only partials are never
// chargeable and settle regardless of the authority. A storage failure of the
// authority itself is not authorization either: it stays retryable (503 /
// shot.write_failed) and still never reaches the chargeable RPC.
//
// The policy fixture is built here (not imported from the harness) so the
// file runs unchanged against BASE_SHA, where it must fail.

import { assert, assertEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RELEASE_CODE = "access.release_not_authorized";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";
const RESERVE_RPC = "/rest/v1/rpc/reserve_analysis_permit";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";

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
  version: "admission-policy-1",
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

/** What read_analysis_release_policy() returns: the row shape of migration
 * 20260908020000 (document + canonical bytes + approval + deny switch). */
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

/** The database default: nothing installed, deny_new_authorizations = true. */
const NO_POLICY = { document: null, approval: null, denyNewAuthorizations: true };

async function withdrawn() {
  const data = await authority();
  data.denyNewAuthorizations = true;
  data.approval.denyNewAuthorizations = true;
  data.approval.withdrawnAt = NOW - 60;
  return data;
}

async function expired() {
  return authority({ ...document, validFrom: NOW - 7_200, validUntil: NOW - 3_600 });
}

/** Approval digest that does not match the installed document bytes. */
async function mismatched() {
  const data = await authority();
  data.approval.policy.sha256 = "b".repeat(64);
  return data;
}

let subject = 0;
function signIn(): { token: string; ip: string; userId: string } {
  subject += 1;
  const userId = `7a010200-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
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

function shot(resultKind: "scored" | "low_confidence" | "partial", id = crypto.randomUUID()) {
  return {
    id,
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore: resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
  };
}

async function reserve(auth: { token: string; ip: string }) {
  const response = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: auth.token,
      ip: auth.ip,
      body: { idempotencyKey: crypto.randomUUID() },
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

function expectTypedRelease(
  result: { status: number; body: Record<string, unknown> },
  reasonCode: string,
) {
  assertEquals(result.status, 409, JSON.stringify(result.body));
  const error = result.body.error as Record<string, unknown>;
  assertEquals(error.code, RELEASE_CODE);
  assert(typeof error.message === "string" && error.message.length > 0);
  assertEquals(result.body.release, { status: "ineligible", reasonCode });
  assertEquals(h.callsTo(RESERVE_RPC).length, 0, "reserve_analysis_permit must not be invoked");
}

// ── Permit reservation ───────────────────────────────────────────────────────

Deno.test("W01-02 permit: no installed policy → typed 409, reserve RPC never called", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  expectTypedRelease(await reserve(auth), "unverified");
  // The authority is read through the service-role client (the RPC is
  // EXECUTE-granted to service_role only), never through the user's bearer.
  const reads = h.callsTo(POLICY_RPC);
  assertEquals(reads.length, 1);
  assertEquals(reads[0].headers.authorization, "Bearer service-role-test-key");
});

Deno.test("W01-02 permit: withdrawn policy → typed 409 withdrawn, uncharged", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await withdrawn();
  expectTypedRelease(await reserve(auth), "withdrawn");
});

Deno.test("W01-02 permit: expired policy → typed 409 expired, uncharged", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await expired();
  expectTypedRelease(await reserve(auth), "expired");
});

Deno.test("W01-02 permit: digest-mismatched policy → typed 409 unverified, never 5xx", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await mismatched();
  expectTypedRelease(await reserve(auth), "unverified");
});

Deno.test(
  "W01-02 permit: authority storage failure → retryable 503, reserve RPC never called",
  async () => {
    const auth = signIn();
    h.rpcErrors.read_analysis_release_policy = 500;
    const result = await reserve(auth);
    assertEquals(result.status, 503, JSON.stringify(result.body));
    assertEquals(h.callsTo(RESERVE_RPC).length, 0);
  },
);

Deno.test("W01-02 permit: ACTIVE policy → reservation proceeds exactly as before", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await authority();
  const result = await reserve(auth);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  const permit = result.body.permit as Record<string, unknown>;
  assertEquals(permit.status, "reserved");
  assertEquals(h.callsTo(RESERVE_RPC).length, 1);
});

// ── Scored settlement ────────────────────────────────────────────────────────

Deno.test(
  "W01-02 sync: scored shot without policy → typed per-shot rejection, apply RPC never called",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = NO_POLICY;
    const scored = shot("scored");
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(result.body.rejected.length, 1);
    assertEquals(result.body.rejected[0].id, scored.id);
    assertEquals(result.body.rejected[0].code, RELEASE_CODE);
    assert(result.body.rejected[0].message.length > 0);
    assertEquals(h.callsTo(APPLY_RPC).length, 0, "apply_synced_shot must not settle a scored shot");
  },
);

Deno.test(
  "W01-02 sync: withdrawn policy → scored rejected, abstention in the same batch still settles",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await withdrawn();
    const scored = shot("scored");
    const abstained = shot("low_confidence");
    const result = await sync(auth, [scored, abstained]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [abstained.id]);
    assertEquals(
      result.body.rejected.map((entry) => [entry.id, entry.code]),
      [[scored.id, RELEASE_CODE]],
    );
    const applies = h.callsTo(APPLY_RPC);
    assertEquals(applies.length, 1);
    const applied = (applies[0].body as { shot: Record<string, unknown> }).shot;
    assertEquals(applied.id, abstained.id);
    assertEquals(applied.resultKind, "low_confidence");
    // Exactly one authority read per batch.
    assertEquals(h.callsTo(POLICY_RPC).length, 1);
  },
);

Deno.test(
  "W01-02 sync: mechanics-only partial is never chargeable and settles without a policy",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = NO_POLICY;
    const partial = shot("partial");
    const result = await sync(auth, [partial]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [partial.id]);
    assertEquals(result.body.rejected, []);
    const applies = h.callsTo(APPLY_RPC);
    assertEquals(applies.length, 1);
    const applied = (applies[0].body as { shot: Record<string, unknown> }).shot;
    assertEquals(applied.resultKind, "partial");
    assertEquals(applied.overallScore, null);
  },
);

Deno.test(
  "W01-02 sync: a partial carrying a score is refused as invalid, never settled",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const result = await sync(auth, [{ ...shot("partial"), overallScore: 6 }]);
    assertEquals(result.status, 200);
    assertEquals(result.body.acceptedIds, []);
    assertEquals(result.body.rejected[0].code, "shot.invalid_payload");
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

Deno.test(
  "W01-02 sync: authority storage failure → scored shot stays retryable, apply RPC never called",
  async () => {
    const auth = signIn();
    h.rpcErrors.read_analysis_release_policy = 500;
    const scored = shot("scored");
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, []);
    assertEquals(
      result.body.rejected.map((entry) => [entry.id, entry.code]),
      [[scored.id, "shot.write_failed"]],
    );
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

Deno.test(
  "W01-02 sync: replayed scored shot is acknowledged without re-settlement and without a policy",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = NO_POLICY;
    const scored = shot("scored");
    h.tables.shots = [{ id: scored.id, user_id: auth.userId }];
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [scored.id]);
    assertEquals(result.body.rejected, []);
    assertEquals(h.callsTo(APPLY_RPC).length, 0);
  },
);

Deno.test(
  "W01-02 sync: ACTIVE policy → scored settlement proceeds through apply_synced_shot",
  async () => {
    const auth = signIn();
    h.rpcs.read_analysis_release_policy = await authority();
    const scored = shot("scored");
    const result = await sync(auth, [scored]);
    assertEquals(result.status, 200, JSON.stringify(result.body));
    assertEquals(result.body.acceptedIds, [scored.id]);
    assertEquals(result.body.rejected, []);
    const applies = h.callsTo(APPLY_RPC);
    assertEquals(applies.length, 1);
    assertEquals((applies[0].body as { shot: Record<string, unknown> }).shot.resultKind, "scored");
  },
);
