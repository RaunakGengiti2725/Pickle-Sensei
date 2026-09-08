/**
 * ADV INT-analysis-scoring — release authority × POST /v1/shots:sync under
 * inconsistent control state, double actions and account switches.
 *
 *   A1 withdrawn-but-deny-off  — approval.withdrawnAt in the past while the
 *                                deny switch is still false: scored must be
 *                                refused (withdrawal alone is authoritative).
 *   A2 approved-but-unreleased — validFrom in the future: scored refused.
 *   A3 one-of-two approvals    — only benchmark approved: scored refused.
 *   A4 scheduled withdrawal    — withdrawnAt in the future: still active now.
 *   A5 one id, two verdicts    — the same id twice in a batch (scored copy +
 *                                abstention copy) without authority must not
 *                                be BOTH accepted and rejected.
 *   A6 same scored id twice    — no authority: two typed rejections, zero
 *                                settlements; active authority: settled once
 *                                per batch, never twice.
 *   A7 slow authority          — a 1.2 s authority read still settles.
 *   A8 account switch          — user B's rank read right after user A's
 *                                cached read is B's own (null), never A's.
 *   A9 score boundary literals — -0, 1e1, 10.000000000000002, "7.5", 7.5e0.
 */
import { assert, assertEquals } from "@std/assert";
import { canonicalizeOfflineJson, digestCanonicalOfflineJson } from "../canonicalDigest.ts";
import type { AnalysisReleasePolicyDocument } from "../../../../packages/shared-types/src/analysisReleasePolicy.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const RELEASE_CODE = "access.release_not_authorized";
const APPLY_RPC = "/rest/v1/rpc/apply_synced_shot";
const POLICY_RPC = "/rest/v1/rpc/read_analysis_release_policy";

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

const artifact = { version: "adv-1", sha256: "d".repeat(64) };
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
      mechanicsApprovedAt: doc.validFrom as number | null,
      benchmarkApprovedAt: doc.validFrom as number | null,
      withdrawnAt: null as number | null,
      denyNewAuthorizations: false,
    },
  };
}
const NO_POLICY = { document: null, approval: null, denyNewAuthorizations: true };

let subject = 0;
function signIn(): { token: string; ip: string; userId: string } {
  subject += 1;
  const userId = `ad010200-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId), ip: `198.51.100.${subject}`, userId };
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
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
    resultKind,
    overallScore: resultKind === "scored" ? 7.5 : null,
    confidence: resultKind === "low_confidence" ? 0.2 : 0.9,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
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

// signIn() resets the harness, which restores the DEFAULT active policy —
// every authority override must be installed after it.
async function expectScoredRefused(label: string, policy: unknown) {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = policy;
  const scored = shot("scored");
  const result = await sync(auth, [scored]);
  assertEquals(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
  assertEquals(result.body.acceptedIds, [], label);
  assertEquals(
    result.body.rejected.map((r) => [r.id, r.code]),
    [[scored.id, RELEASE_CODE]],
    label,
  );
  assertEquals(h.callsTo(APPLY_RPC).length, 0, `${label}: apply_synced_shot must not settle`);
}

Deno.test("ADV A1: withdrawnAt in the past with deny switch still false → scored refused", async () => {
  const data = await authority();
  data.approval.withdrawnAt = NOW - 30;
  await expectScoredRefused("withdrawn-but-deny-off", data);
});

Deno.test("ADV A2: approved policy whose validFrom is in the future → scored refused", async () => {
  const doc = { ...document, validFrom: NOW + 3_600, validUntil: NOW + 7_200 };
  const data = await authority(doc);
  data.approval.mechanicsApprovedAt = NOW - 60;
  data.approval.benchmarkApprovedAt = NOW - 60;
  await expectScoredRefused("unreleased", data);
});

Deno.test("ADV A3: only the benchmark approval recorded (mechanics null) → scored refused", async () => {
  const data = await authority();
  data.approval.mechanicsApprovedAt = null;
  await expectScoredRefused("one-of-two-approvals", data);
});

Deno.test("ADV A3b: only the mechanics approval recorded (benchmark null) → scored refused", async () => {
  const data = await authority();
  data.approval.benchmarkApprovedAt = null;
  await expectScoredRefused("one-of-two-approvals-benchmark", data);
});

Deno.test("ADV A4: a withdrawal scheduled in the future leaves the policy active now", async () => {
  const data = await authority();
  data.approval.withdrawnAt = NOW + 3_600;
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = data;
  const scored = shot("scored");
  const result = await sync(auth, [scored]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds, [scored.id]);
  assertEquals(h.callsTo(APPLY_RPC).length, 1);
});

Deno.test("ADV A5: one id submitted as scored AND as abstention in one batch (no authority) yields one verdict, not both", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const id = crypto.randomUUID();
  const scored = shot("scored", { id });
  const abstained = shot("low_confidence", { id });
  const result = await sync(auth, [scored, abstained]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  const accepted = result.body.acceptedIds.includes(id);
  const rejected = result.body.rejected.some((r) => r.id === id);
  assert(
    !(accepted && rejected),
    `id ${id} is both accepted and rejected in one response: ${JSON.stringify(result.body)}`,
  );
});

Deno.test("ADV A6: the same scored id twice in a batch without authority → two typed rejections, zero settlements", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = NO_POLICY;
  const scored = shot("scored");
  const result = await sync(auth, [scored, { ...scored }]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds, []);
  assertEquals(result.body.rejected.map((r) => r.code), [RELEASE_CODE, RELEASE_CODE]);
  assertEquals(h.callsTo(APPLY_RPC).length, 0);
  assertEquals(h.callsTo(POLICY_RPC).length, 1, "one authority read per batch");
});

Deno.test("ADV A6b: the same scored id twice in a batch with active authority — the second copy is a replay ack, never a second settlement of the same charge", async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await authority();
  // Real apply_synced_shot answers 'accepted' for both the settlement and
  // the idempotent replay of an owned row (20260831000000 scale_and_security),
  // which is exactly what the harness default returns.
  const scored = shot("scored");
  const result = await sync(auth, [scored, { ...scored }]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assert(result.body.acceptedIds.includes(scored.id), JSON.stringify(result.body));
  assertEquals(result.body.rejected, [], "a replay of an owned scored row must not be rejected");
  assertEquals(
    new Set(result.body.acceptedIds).size,
    result.body.acceptedIds.length,
    `duplicate acks for one id: ${JSON.stringify(result.body.acceptedIds)}`,
  );
});

Deno.test("ADV A7: a slow (1.2 s) authority read still settles the scored shot", async () => {
  const data = await authority();
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = data;
  h.respond = (call) => {
    if (!call.url.includes(POLICY_RPC)) return null;
    return new Promise<Response>((resolve) =>
      setTimeout(
        () =>
          resolve(
            new Response(JSON.stringify(data), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
          ),
        1_200,
      )
    );
  };
  const scored = shot("scored");
  const result = await sync(auth, [scored]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds, [scored.id]);
});

Deno.test("ADV A8: account switch — B's rank read right after A's cached read is B's own query, not A's cache", async () => {
  const a = signIn();
  h.tables.player_technique_rating = [
    {
      user_id: a.userId,
      shot_type: "dink",
      score: 8.25,
      captured_at: "2026-09-01T00:00:00.000Z",
      sampled_count: 5,
      confidence_weight: 5,
    },
  ];
  h.tables.player_rank_state = [];
  const ra = await h.handler(userRequest("GET", "/v1/rank", a));
  assertEquals(ra.status, 200);
  const bodyA = (await ra.json()) as { rank: { rating: number } | null };
  assert(bodyA.rank !== null && bodyA.rank.rating === 8.25);

  // Switch account on the same device/IP. The PostgREST stub does not apply
  // RLS or the user_id filter, so isolation is asserted on the wire: B's read
  // must be a fresh, B-scoped query (cache keyed per user, `user_id=eq.<B>`).
  subject += 1;
  const bId = `ad010200-0000-4000-8000-${String(subject).padStart(12, "0")}`;
  h.tables.profiles = [
    ...(h.tables.profiles as unknown[]),
    { id: bId, email: "b@example.com", provider: "google" },
  ];
  const b = { token: fakeGoogleIdToken(bId), ip: a.ip };
  const rb = await h.handler(userRequest("GET", "/v1/rank", b));
  assertEquals(rb.status, 200);
  const reads = h.callsTo("/rest/v1/player_technique_rating");
  assertEquals(reads.length, 2, "B's read must not be served from A's cache entry");
  const filters = reads.map((call) => new URL(call.url).searchParams.get("user_id"));
  assertEquals(filters, [`eq.${a.userId}`, `eq.${bId}`]);
  const stateReads = h.callsTo("/rest/v1/player_rank_state");
  assertEquals(
    stateReads.map((call) => new URL(call.url).searchParams.get("user_id")),
    [`eq.${a.userId}`, `eq.${bId}`],
  );
});

Deno.test('ADV A9: score literal boundaries — -0 and 1e1 accepted, 10.000000000000002 / "7.5" / null(scored) refused as invalid', async () => {
  const auth = signIn();
  h.rpcs.read_analysis_release_policy = await authority();
  const ok1 = shot("scored", { overallScore: -0 });
  const ok2 = shot("scored", { overallScore: 1e1 });
  const bad1 = shot("scored", { overallScore: 10.000000000000002 });
  const bad2 = shot("scored", { overallScore: "7.5" });
  const bad3 = shot("scored", { overallScore: null });
  const result = await sync(auth, [ok1, ok2, bad1, bad2, bad3]);
  assertEquals(result.status, 200, JSON.stringify(result.body));
  assertEquals(result.body.acceptedIds.sort(), [ok1.id, ok2.id].sort());
  assertEquals(
    result.body.rejected.map((r) => r.id).sort(),
    [bad1.id, bad2.id, bad3.id].sort(),
  );
  for (const r of result.body.rejected) {
    assert(r.code !== RELEASE_CODE, `invalid score must be an input rejection, got ${r.code}`);
  }
  assertEquals(h.callsTo(APPLY_RPC).length, 2);
});
