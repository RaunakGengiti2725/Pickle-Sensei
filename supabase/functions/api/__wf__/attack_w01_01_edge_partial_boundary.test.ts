/**
 * W01-01 adversary — the EDGE boundary of the partial terminal outcome.
 *
 * Companion to xc_pg_w01_01_partial_outcome_adversary.test.ts (SQL layer,
 * needs XC_PG_URL). These cases drive the REAL edge handler through
 * routesHarness (GoTrue/PostgREST stubbed at fetch level) and run without a
 * database: they pin what the shipping app can actually reach on the
 * candidate (4b785e99).
 *
 * Attack: the migration admits shots.result_kind='partial' and the
 * released/partial permit state, but the two supported entry points for a
 * mechanics-only result — POST /v1/shots:sync and
 * POST /v1/analysis-permits/:id/finalize — are the only way a partial can
 * reach that table from the app. If either refuses 'partial' the outcome is
 * unreachable end to end (the app is still limited to relabelling as
 * low_confidence or upgrading to scored), and if finalize writes its current
 * shape (status='finalized') the migration refuses it (SQL ATK-8: only
 * released/partial is admissible).
 *
 *   E-1  shots:sync  {resultKind:'partial', overallScore:null}  → per-shot
 *        rejection shot.invalid_payload before any RPC is called.
 *   E-2  shots:sync  {resultKind:'partial', overallScore:5}     → also
 *        refused (never silently upgraded / relabelled).
 *   E-3  finalize    {outcome:'partial'} → 400 validation.analysis_permit_finalize,
 *        no PATCH ever sent.
 *   E-4  finalize    {outcome:'low_confidence'} → the PATCH body the route
 *        sends today is {status:'finalized', outcome} — the write shape the
 *        migration refuses for 'partial' (documents the wiring hazard).
 *
 * The assertions describe the CANDIDATE's actual behaviour; a fix that
 * widens the parser / finalize route is expected to flip E-1 and E-3.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

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

const PERMIT_ID = "0000000b-4b78-4000-8000-00000000e001";

function partialShot(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: PERMIT_ID,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    resultKind: "partial",
    overallScore: null,
    confidence: 0.2,
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

function signIn(userId: string) {
  h.reset();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider: "google" }];
  h.tables.shots = [];
  h.tables.analysis_permits = [
    {
      id: PERMIT_ID,
      user_id: userId,
      status: "reserved",
      outcome: null,
      created_at: new Date().toISOString(),
    },
  ];
  h.rpcs.apply_synced_shot = "accepted";
  h.rpcs.access_state = [{ scored_count: 0, reserved_count: 1, premium: false }];
  return { token: fakeGoogleIdToken(userId) };
}

type SyncBody = {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
};

Deno.test(
  "W01-EDGE-1: POST /v1/shots:sync with a mechanics-only shot (resultKind=partial, overallScore=null) is rejected shot.invalid_payload before apply_synced_shot is ever called",
  async () => {
    const auth = signIn("0000000b-4b78-4000-8000-00000000e101");
    const shot = partialShot();
    const res = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        ...auth,
        ip: "203.0.113.201",
        body: { shots: [shot] },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as SyncBody;
    assertEquals(body.acceptedIds, []);
    assertEquals(body.rejected.length, 1);
    assertEquals(body.rejected[0].id, shot.id);
    assertEquals(body.rejected[0].code, "shot.invalid_payload");
    assertStringIncludes(body.rejected[0].message, "resultKind must be scored|low_confidence");
    // The RPC that would settle the permit as released/partial never ran.
    assertEquals(h.callsTo("rpc/apply_synced_shot").length, 0);
  },
);

Deno.test(
  "W01-EDGE-2: a partial carrying a stray score is refused as invalid — the parser never upgrades or relabels it",
  async () => {
    const auth = signIn("0000000b-4b78-4000-8000-00000000e102");
    const res = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        ...auth,
        ip: "203.0.113.202",
        body: { shots: [partialShot({ overallScore: 5 }), partialShot({ resultKind: "PARTIAL" })] },
      }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as SyncBody;
    assertEquals(body.acceptedIds, []);
    assertEquals(
      body.rejected.map((r) => r.code),
      ["shot.invalid_payload", "shot.invalid_payload"],
    );
    assertEquals(h.callsTo("rpc/apply_synced_shot").length, 0);
  },
);

Deno.test(
  "W01-EDGE-3: POST /v1/analysis-permits/:id/finalize {outcome:'partial'} is a 400 validation.analysis_permit_finalize and no PATCH reaches analysis_permits",
  async () => {
    const auth = signIn("0000000b-4b78-4000-8000-00000000e103");
    const res = await h.handler(
      userRequest("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        ...auth,
        ip: "203.0.113.203",
        body: { outcome: "partial", ratingId: null },
      }),
    );
    assertEquals(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assertEquals(body.error.code, "validation.analysis_permit_finalize");
    assertStringIncludes(
      body.error.message,
      "low_confidence|cancelled|failed|unsupported|incorrect_recognition",
    );
    const patches = h
      .callsTo("/rest/v1/analysis_permits")
      .filter((call) => call.method === "PATCH");
    assertEquals(patches.length, 0);
  },
);

Deno.test(
  "W01-EDGE-4: the finalize route's PATCH body is {status:'finalized', outcome} — the shape the candidate migration refuses for 'partial' (SQL ATK-8), so wiring must write released/partial",
  async () => {
    const auth = signIn("0000000b-4b78-4000-8000-00000000e104");
    // PostgREST stand-in: echo the row the route asked for so the route
    // completes its happy path; the assertion is on the WRITE it sent.
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "PATCH" && request.url.includes("/rest/v1/analysis_permits")) {
        await inner(request.clone());
        return new Response(
          JSON.stringify({
            id: PERMIT_ID,
            status: "finalized",
            outcome: "low_confidence",
            created_at: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return inner(request);
    }) as typeof fetch;
    let res: Response;
    try {
      res = await h.handler(
        userRequest("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
          ...auth,
          ip: "203.0.113.204",
          body: { outcome: "low_confidence", ratingId: null },
        }),
      );
    } finally {
      globalThis.fetch = inner;
    }
    assertEquals(res.status, 200);
    const patches = h
      .callsTo("/rest/v1/analysis_permits")
      .filter((call) => call.method === "PATCH");
    assertEquals(patches.length, 1);
    assertEquals(patches[0].body, { status: "finalized", outcome: "low_confidence" });
    assertStringIncludes(patches[0].url, "status=eq.reserved");
  },
);
