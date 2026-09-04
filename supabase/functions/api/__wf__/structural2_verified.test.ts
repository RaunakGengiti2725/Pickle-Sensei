/**
 * Structural audit #2 — edge-domain-routes — HOLDS.
 *
 * HTTP-level probes (real ../index.ts handler, fake Supabase/provider HTTP) for
 * behaviours the mapper listed as weak/untested. Every test here PASSES on
 * 4d812e1a; they exist so the coordinator can pin the verified behaviour.
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json structural2_verified.test.ts
 */
import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from "@std/assert";
import {
  decryptAppleRefreshToken,
  encryptAppleRefreshToken,
} from "../externalAccounts.ts";
import { RC_URL, userRequest } from "./routesHarness.ts";
import {
  deferred,
  distinctGoogleIdToken,
  fakeAppleIdToken,
  intercept,
  jsonResponse,
  loadStructuralHarness,
  readJson,
  restPath,
  syncShot,
  userId,
} from "./structural2Harness.ts";

const h = await loadStructuralHarness();

const rpcCalls = (fn: string) =>
  h.calls.filter((c) =>
    c.url.includes(`/rest/v1/rpc/${fn}`) && c.method === "POST"
  );
const tableReads = (table: string) =>
  h.calls.filter((c) =>
    c.method === "GET" && c.url.includes(`/rest/v1/${table}`)
  );

function deletionRequestRow(challenge: string, ageMs = 10_000) {
  return {
    challenge,
    created_at: new Date(Date.now() - ageMs).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

// ── POST /v1/shots:sync ──────────────────────────────────────────────────────

Deno.test("V1 shots:sync rejects malformed entries per item without spending a query", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(201), "phone");
  const bad = [
    syncShot({ id: "not-a-uuid" }),
    syncShot({ source: "synthetic" }),
    syncShot({ cameraView: "top" }),
    syncShot({ timestamps: { startMs: 500, contactMs: 400.5, endMs: 900 } }),
    syncShot({ overallScore: 10.5 }),
    syncShot({
      checkpoints: [{
        ...(syncShot().checkpoints as Record<string, unknown>[])[0],
        score: 101,
      }],
    }),
    syncShot({ versionVector: {} }),
    syncShot({ resultKind: "scored", overallScore: null }),
  ];
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token, body: { shots: bad } }),
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.acceptedIds, []);
  const rejected = body.rejected as Array<
    { id: string; code: string; message: string }
  >;
  assertEquals(rejected.length, bad.length);
  for (const r of rejected) {
    assertEquals(r.message.includes("undefined"), false);
  }
  assertEquals(
    rejected.map((r) => r.code),
    [
      "shot.invalid_payload",
      "shot.non_real_source",
      ...Array.from({ length: bad.length - 2 }, () => "shot.invalid_payload"),
    ],
  );
  assertEquals(rejected[0].id, "not-a-uuid");
  assertEquals(tableReads("shots").length, 0);
  assertEquals(rpcCalls("apply_synced_shot").length, 0);
});

// Observation (P3, not a defect claim): parseSyncShot checks each timestamp
// is a bounded integer but not their ordering; the shots table has no CHECK
// on start_ms <= contact_ms <= end_ms either (20260829120000_progress_data.sql:75-77),
// so a contact before the start is stored as-is.
Deno.test("V1b shots:sync accepts non-monotonic timestamps (parser validates bounds, not ordering)", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(2011), "phone");
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  const shot = syncShot({
    timestamps: { startMs: 500, contactMs: 400, endMs: 300 },
  });
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token, body: { shots: [shot] } }),
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.acceptedIds, [shot.id]);
  assertEquals(rpcCalls("apply_synced_shot").length, 1);
});

Deno.test("V2 shots:sync mixed batch: replay accepted without RPC, new shot applied, malformed rejected", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(202), "phone");
  const replay = syncShot();
  const fresh = syncShot();
  h.tables.shots = [{ id: replay.id }];
  h.rpcs.apply_synced_shot = "accepted";
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token,
      body: { shots: [replay, fresh, syncShot({ shotType: "" })] },
    }),
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(
    new Set(body.acceptedIds as string[]),
    new Set([replay.id, fresh.id]),
  );
  assertEquals((body.rejected as unknown[]).length, 1);
  assertEquals(tableReads("shots").length, 1);
  const applied = rpcCalls("apply_synced_shot");
  assertEquals(applied.length, 1);
  assertEquals(
    ((applied[0].body as Record<string, unknown>).shot as Record<
      string,
      unknown
    >).id,
    fresh.id,
  );
});

Deno.test("V3 shots:sync known RPC statuses map to their codes; unknown/detail statuses collapse to generic shot.write_failed", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(203), "phone");
  h.tables.shots = [];
  const cases: Array<[string, string, boolean]> = [
    ["access.permit_not_found", "access.permit_not_found", false],
    ["access.paywall_required", "access.paywall_required", false],
    ["shot.id_conflict", "shot.id_conflict", false],
    [
      "shot.write_failed:23514 violates check constraint shots_score_check",
      "shot.write_failed",
      true,
    ],
    ["totally_unexpected", "shot.write_failed", true],
  ];
  for (const [rpcStatus, code, generic] of cases) {
    h.rpcs.apply_synced_shot = rpcStatus;
    const res = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        token,
        body: { shots: [syncShot()] },
      }),
    );
    assertEquals(res.status, 200);
    const body = await readJson(res);
    const rejected = body.rejected as Array<{ code: string; message: string }>;
    assertEquals(rejected.length, 1, rpcStatus);
    assertEquals(rejected[0].code, code, rpcStatus);
    if (generic) {
      assertEquals(rejected[0].message.includes("23514"), false);
      assertEquals(rejected[0].message.includes("unexpected"), false);
    }
  }
});

Deno.test("V4 shots:sync RPC transport error → per-shot retryable shot.write_failed, no detail leaked", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(204), "phone");
  h.tables.shots = [];
  intercept((request) =>
    restPath(request).startsWith("rpc/apply_synced_shot")
      ? jsonResponse(500, {
        code: "XX000",
        message: "deadlock detected on shots_pkey",
      })
      : null
  );
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token,
      body: { shots: [syncShot()] },
    }),
  );
  intercept(null);
  assertEquals(res.status, 200);
  const text = await res.text();
  assertStringIncludes(text, "shot.write_failed");
  assertEquals(text.includes("deadlock"), false);
});

Deno.test("V5 shots:sync replay-lookup failure → whole batch 503 with a generic body", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(205), "phone");
  intercept((request) =>
    request.method === "GET" && restPath(request).startsWith("shots")
      ? jsonResponse(500, {
        code: "57014",
        message: "canceling statement due to statement timeout",
      })
      : null
  );
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token,
      body: { shots: [syncShot()] },
    }),
  );
  intercept(null);
  assertEquals(res.status, 503);
  const text = await res.text();
  assertEquals(text.includes("statement timeout"), false);
  assertEquals(rpcCalls("apply_synced_shot").length, 0);
});

Deno.test("V6 shots:sync batch bounds: empty and 201 entries → 400 validation.shots_sync", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(206), "phone");
  for (const shots of [[], Array.from({ length: 201 }, () => syncShot())]) {
    const res = await h.handler(
      userRequest("POST", "/v1/shots:sync", { token, body: { shots } }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes(await res.text(), "validation.shots_sync");
  }
});

// ── Rank / progress cache ───────────────────────────────────────────────────

Deno.test("V7 rank cache: served for 60 s, NOT busted by an all-rejected sync, busted by an accepted sync", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(207), "phone");
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 6.5,
      captured_at: "2026-09-01T00:00:00Z",
      sampled_count: 3,
      confidence_weight: 3,
    },
  ];
  h.tables.player_rank_state = [
    {
      rating: 6.5,
      tier: "Silver",
      technique_count: 1,
      scored_shot_count: 3,
      updated_at: "2026-09-01T00:00:00Z",
    },
  ];
  h.tables.shots = [];

  const first = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(first.status, 200);
  assertEquals(tableReads("player_technique_rating").length, 1);
  await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(
    tableReads("player_technique_rating").length,
    1,
    "second GET served from cache",
  );

  h.rpcs.apply_synced_shot = "access.permit_not_found";
  await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token,
      body: { shots: [syncShot()] },
    }),
  );
  await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(
    tableReads("player_technique_rating").length,
    1,
    "rejected sync must not evict",
  );

  h.rpcs.apply_synced_shot = "accepted";
  const sync = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token,
      body: { shots: [syncShot()] },
    }),
  );
  assertEquals(sync.status, 200);
  h.tables.player_rank_state[0] = {
    ...h.tables.player_rank_state[0] as Record<string, unknown>,
    rating: 7.1,
  };
  const after = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(
    tableReads("player_technique_rating").length,
    2,
    "accepted sync evicts",
  );
  assertEquals(
    ((await readJson(after)).rank as Record<string, unknown>).rating,
    7.1,
  );
});

Deno.test("V8 rank: no technique evidence → { rank: null }, cached; state row ignored", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(208), "phone");
  h.tables.player_technique_rating = [];
  h.tables.player_rank_state = [{ rating: 5, tier: "Bronze" }];
  const res = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(res.status, 200);
  assertEquals(await readJson(res), { rank: null });
});

Deno.test("V9 rank: inline fallback when player_rank_state is missing matches the documented formula", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(209), "phone");
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 6.55,
      captured_at: "2026-09-01T00:00:00Z",
      sampled_count: 5,
      confidence_weight: 5,
    },
    {
      shot_type: "drive",
      score: 8.1,
      captured_at: "2026-09-01T00:00:00Z",
      sampled_count: 1,
      confidence_weight: 1,
    },
  ];
  h.tables.player_rank_state = [];
  const res = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(res.status, 200);
  const rank = (await readJson(res)).rank as Record<string, unknown>;
  // (5*655 + 1*810) / 6 = 680.83 → 681 → 6.81
  assertEquals(rank.rating, 6.81);
  assertEquals(rank.scoredShotCount, null);
  assertEquals(rank.techniqueCount, 2);
  const techniques = rank.techniques as Array<Record<string, unknown>>;
  assertEquals(techniques[0].shot_type, "drive", "sorted by score desc");
  assertEquals(
    "confidence_weight" in techniques[0],
    false,
    "weight never exposed",
  );
});

Deno.test("V10 coalesce: concurrent cold GET /v1/rank shares ONE DB read and every caller gets a full body", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(210), "phone");
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 6.5,
      captured_at: "2026-09-01T00:00:00Z",
      sampled_count: 3,
      confidence_weight: 3,
    },
  ];
  h.tables.player_rank_state = [];
  const gate = deferred();
  intercept(async (request) => {
    if (
      request.method === "GET" &&
      restPath(request).startsWith("player_technique_rating")
    ) {
      await gate.promise;
    }
    return null;
  });
  const pending = Promise.all(
    Array.from(
      { length: 5 },
      () => h.handler(userRequest("GET", "/v1/rank", { token })),
    ),
  );
  await new Promise((r) => setTimeout(r, 20));
  gate.resolve();
  const responses = await pending;
  intercept(null);
  const bodies = await Promise.all(responses.map((r) => r.text()));
  assertEquals(tableReads("player_technique_rating").length, 1);
  assert(bodies.every((b) => b === bodies[0] && b.includes('"rating":6.5')));
});

Deno.test("V11 coalesce: a 503 build is not cached — the next request re-reads", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(211), "phone");
  h.tables.player_technique_rating = [];
  h.tables.player_rank_state = [];
  let failedReads = 0;
  intercept((request) => {
    if (
      request.method === "GET" &&
      restPath(request).startsWith("player_technique_rating")
    ) {
      failedReads += 1;
      return jsonResponse(500, { message: "boom" });
    }
    return null;
  });
  const failed = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(failed.status, 503);
  assertEquals((await failed.text()).includes("boom"), false);
  assertEquals(failedReads, 1);
  intercept(null);
  const ok = await h.handler(userRequest("GET", "/v1/rank", { token }));
  assertEquals(ok.status, 200);
  assertEquals(
    tableReads("player_technique_rating").length,
    1,
    "re-read after the 503",
  );
});

Deno.test("V12 progress: 0–10 view scores ×10, streak from UTC days, paging stops on a short page", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(212), "phone");
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(
    0,
    10,
  );
  h.tables.progress_daily = [
    {
      day: yesterday,
      shot_type: "dink",
      scoring_model_version: "s1",
      shot_count: "2",
      avg_score: "6.55",
      best_score: "7.1",
    },
  ];
  h.tables.practice_days = [{ day: yesterday }, { day: today }];
  const res = await h.handler(userRequest("GET", "/v1/progress", { token }));
  assertEquals(res.status, 200);
  const body = await readJson(res);
  const series = body.series as Array<Record<string, unknown>>;
  assertEquals(series[0].avg_score, 65.5);
  assertEquals(series[0].best_score, 71);
  assertEquals(series[0].shot_count, 2);
  assertEquals(body.improving, []);
  assertEquals(body.needsAttention, []);
  assertEquals(body.streak, {
    currentDays: 2,
    longestDays: 2,
    practicedToday: true,
    lastPracticeDate: today,
  });
  assertEquals(tableReads("progress_daily").length, 1);
  assertEquals(tableReads("practice_days").length, 1);
  const read = tableReads("progress_daily")[0];
  const url = new URL(read.url);
  const paged = read.headers["range"] === "0-999" ||
    (url.searchParams.get("offset") === "0" &&
      url.searchParams.get("limit") === "1000");
  assert(
    paged,
    `first page not bounded to 1000 rows: ${read.url} ${
      JSON.stringify(read.headers)
    }`,
  );
});

Deno.test("V13 progress: exactly 1000 rows triggers a second page and both are concatenated", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(213), "phone");
  const page = Array.from({ length: 1000 }, (_, i) => ({
    day: "2026-01-01",
    shot_type: `t${i}`,
    scoring_model_version: "s",
    shot_count: 1,
    avg_score: 5,
    best_score: 5,
  }));
  let served = 0;
  intercept((request) => {
    if (
      request.method === "GET" && restPath(request).startsWith("progress_daily")
    ) {
      served += 1;
      return jsonResponse(200, served === 1 ? page : page.slice(0, 7));
    }
    return null;
  });
  h.tables.practice_days = [];
  const res = await h.handler(userRequest("GET", "/v1/progress", { token }));
  intercept(null);
  assertEquals(res.status, 200);
  assertEquals(((await readJson(res)).series as unknown[]).length, 1007);
  assertEquals(served, 2);
});

// ── Permits ─────────────────────────────────────────────────────────────────

Deno.test("V14 permits: reserve → 200 {permit, access}; paywall RPC result → 402; RPC error → generic 503", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(214), "phone");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 1,
    reserved_count: 1,
  }];
  const permitId = crypto.randomUUID();
  h.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: permitId,
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: "2026-09-01T00:00:00Z",
    },
  ];
  const ok = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token,
      body: { idempotencyKey: "k1" },
    }),
  );
  assertEquals(ok.status, 200);
  const okBody = await readJson(ok);
  assertEquals((okBody.permit as Record<string, unknown>).id, permitId);
  assert("access" in okBody);

  h.rpcs.reserve_analysis_permit = [{
    result: "access.paywall_required",
    permit_id: null,
  }];
  const paywall = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token,
      body: { idempotencyKey: "k2" },
    }),
  );
  assertEquals(paywall.status, 402);
  assertStringIncludes(await paywall.text(), "access.paywall_required");

  h.rpcs.reserve_analysis_permit = [{ result: "weird", permit_id: null }];
  const weird = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token,
      body: { idempotencyKey: "k3" },
    }),
  );
  assertEquals(weird.status, 503);
  assertEquals((await weird.text()).includes("weird"), false);

  const noKey = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token,
      body: { idempotencyKey: "x".repeat(129) },
    }),
  );
  assertEquals(noKey.status, 400);
});

Deno.test("V15 permit finalize: 'scored' and unknown outcomes refused (400) before any DB read; non-null ratingId refused", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(215), "phone");
  const id = crypto.randomUUID();
  for (
    const body of [{ outcome: "scored", ratingId: null }, {
      outcome: "great",
      ratingId: null,
    }, { outcome: "cancelled", ratingId: crypto.randomUUID() }]
  ) {
    const res = await h.handler(
      userRequest("POST", `/v1/analysis-permits/${id}/finalize`, {
        token,
        body,
      }),
    );
    assertEquals(res.status, 400, JSON.stringify(body));
    assertStringIncludes(
      await res.text(),
      "validation.analysis_permit_finalize",
    );
  }
  assertEquals(tableReads("analysis_permits").length, 0);
  const notUuid = await h.handler(
    userRequest("POST", "/v1/analysis-permits/nope/finalize", {
      token,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(notUuid.status, 400);
});

Deno.test("V16 permit finalize: missing row → 404; already finalized with another outcome → 409; same outcome → 200 replay", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(216), "phone");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  const id = crypto.randomUUID();
  h.tables.analysis_permits = [];
  const missing = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${id}/finalize`, {
      token,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(missing.status, 404);
  assertStringIncludes(await missing.text(), "access.permit_not_found");

  h.tables.analysis_permits = [{
    id,
    status: "finalized",
    outcome: "scored",
    created_at: "2026-09-01T00:00:00Z",
  }];
  const conflict = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${id}/finalize`, {
      token,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(conflict.status, 409);
  assertStringIncludes(
    await conflict.text(),
    "access.permit_already_finalized",
  );

  h.tables.analysis_permits = [{
    id,
    status: "finalized",
    outcome: "cancelled",
    created_at: "2026-09-01T00:00:00Z",
  }];
  const replay = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${id}/finalize`, {
      token,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(replay.status, 200);
});

// ── Auth cache / logout ─────────────────────────────────────────────────────

Deno.test("V17 auth cache: verified bearer is re-used; POST /v1/auth/logout evicts THIS bearer only", async () => {
  h.reset();
  const uid = userId(217);
  const phone = distinctGoogleIdToken(uid, "phone");
  const tablet = distinctGoogleIdToken(uid, "tablet");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  const logoutUrls: string[] = [];
  intercept((request) => {
    if (request.url.startsWith("http://supabase.test/auth/v1/logout")) {
      logoutUrls.push(request.url);
      return new Response(null, { status: 204 });
    }
    return null;
  });
  const verifications = () => h.callsTo("/auth/v1/token").length;
  await h.handler(userRequest("GET", "/v1/me/access", { token: phone }));
  await h.handler(userRequest("GET", "/v1/me/access", { token: phone }));
  await h.handler(userRequest("GET", "/v1/me/access", { token: tablet }));
  assertEquals(verifications(), 2);

  const logout = await h.handler(
    userRequest("POST", "/v1/auth/logout", { token: phone }),
  );
  assertEquals(logout.status, 204);
  assertEquals(logoutUrls.length, 1);
  assertStringIncludes(logoutUrls[0], "scope=local");

  await h.handler(userRequest("GET", "/v1/me/access", { token: phone }));
  assertEquals(verifications(), 3, "logged-out bearer re-verified");
  await h.handler(userRequest("GET", "/v1/me/access", { token: tablet }));
  assertEquals(verifications(), 3, "other device untouched");
  intercept(null);
});

Deno.test("V18 access clamping: over-limit counters clamp to the 2-rating ledger; premium bypasses it", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(218), "phone");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 7,
    reserved_count: 99,
  }];
  const res = await h.handler(userRequest("GET", "/v1/me/access", { token }));
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.premium, false);
  assertEquals(body.freeRatings, {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  });
  assertEquals(body.canStartRating, false);
  assertEquals(body.paywallRequired, true);

  h.rpcs.access_state = [{ premium: true, scored_count: 7, reserved_count: 0 }];
  // fresh bearer: the access payload itself is not cached, but keep it explicit
  const premium = await readJson(
    await h.handler(userRequest("GET", "/v1/me/access", { token })),
  );
  assertEquals(premium.premium, true);
  assertEquals(premium.canStartRating, true);
  assertEquals(premium.paywallRequired, false);
  assertEquals((premium.entitlements as string[]).includes("premium"), true);
});

// ── Onboarding ──────────────────────────────────────────────────────────────

Deno.test("V19 onboarding: field caps and optional-field vocabularies are enforced with 400s; no DB write", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(219), "phone");
  const base = {
    handedness: "right",
    skillLevel: "beginner",
    goal: "consistency",
    biggestProblem: "pop-ups",
  };
  const bad = [
    { ...base, skillLevel: "x".repeat(65) },
    { ...base, goal: "x".repeat(65) },
    { ...base, biggestProblem: "x".repeat(257) },
    { ...base, handedness: "ambi" },
    { ...base, firstName: 42 },
    { ...base, firstName: "x".repeat(41) },
    { ...base, firstName: "\u200b\u200b" },
    { ...base, gender: "other" },
  ];
  for (const body of bad) {
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", { token, body }),
    );
    assertEquals(res.status, 400, JSON.stringify(body).slice(0, 80));
  }
  assertEquals(
    h.calls.filter((c) =>
      c.method === "PATCH" && c.url.includes("/rest/v1/profiles")
    ).length,
    0,
  );
});

Deno.test("V20 onboarding: unknown goal defaults focus to contact_position, known goal maps; PATCH carries sanitized fields", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(220), "phone");
  let patch: Record<string, unknown> | null = null;
  intercept((request, body) => {
    if (
      request.method === "PATCH" && restPath(request).startsWith("profiles")
    ) {
      patch = body as Record<string, unknown>;
      return jsonResponse(200, {
        skill_level: "beginner",
        handedness: "right",
        primary_goal: "whatever",
        biggest_problem: "x",
        focus_checkpoint: "contact_position",
        first_name: "Sam",
        gender: null,
      });
    }
    return null;
  });
  const res = await h.handler(
    userRequest("PUT", "/v1/me/onboarding", {
      token,
      body: {
        handedness: "right",
        skillLevel: "beginner",
        goal: "whatever",
        biggestProblem: "x",
        firstName: " Sam\u0000 ",
      },
    }),
  );
  intercept(null);
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assertEquals(body.recommendedCheckpoint, "contact_position");
  assert(patch !== null, "profiles PATCH not issued");
  const sent = patch as Record<string, unknown>;
  assertEquals(sent.first_name, "Sam");
  assertEquals(sent.focus_checkpoint, "contact_position");
  assertEquals(sent.onboarding_state, "complete");
});

// ── Account deletion ────────────────────────────────────────────────────────

Deno.test("V21 deletion: RevenueCat 5xx → 503 before deleteUser; retry after Apple revoke reuses the checkpoint", async () => {
  h.reset();
  const uid = userId(221);
  const token = fakeAppleIdToken(uid);
  const challenge = crypto.randomUUID();
  h.tables.profiles = [{ id: uid, email: "a@example.com", provider: "apple" }];
  h.tables.account_deletion_requests = [deletionRequestRow(challenge)];
  h.tables.account_external_credentials = [
    {
      apple_refresh_token_encrypted: await encryptAppleRefreshToken(
        "rt",
        uid,
        h.appleTokenEncryptionKey,
      ),
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
  intercept((request) =>
    request.method === "DELETE" && request.url.startsWith(RC_URL)
      ? new Response("upstream", { status: 502 })
      : null
  );
  const first = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token,
      body: { challenge },
    }),
  );
  assertEquals(first.status, 503);
  assertEquals(h.callsTo("appleid.apple.com/auth/revoke").length, 1);
  assertEquals(
    h.calls.filter((c) =>
      c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
    ).length,
    0,
  );
  const checkpoint = h.calls.filter(
    (c) =>
      c.url.includes("/rest/v1/account_external_credentials") &&
      (c.method === "PATCH" || c.method === "POST"),
  );
  assert(checkpoint.length >= 1, "Apple revoke checkpointed");

  // Retry: the DB now records the Apple checkpoint; RevenueCat recovers.
  h.tables.account_external_credentials = [
    {
      ...h.tables.account_external_credentials[0] as Record<string, unknown>,
      apple_revoked_at: new Date().toISOString(),
    },
  ];
  intercept((request) =>
    request.method === "DELETE" && request.url.startsWith(RC_URL)
      ? new Response(null, { status: 404 })
      : null
  );
  const second = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token,
      body: { challenge },
    }),
  );
  intercept(null);
  assertEquals(second.status, 200);
  assertEquals(
    h.callsTo("appleid.apple.com/auth/revoke").length,
    1,
    "revoke not repeated",
  );
  assertEquals(
    h.calls.filter((c) =>
      c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE"
    ).length,
    1,
  );
});

Deno.test("V22 deletion: challenge younger than 3 s or unknown → refused; the confirming bearer is evicted", async () => {
  h.reset();
  const uid = userId(222);
  const token = distinctGoogleIdToken(uid, "phone");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [deletionRequestRow(challenge, 500)];
  h.tables.account_external_credentials = [];
  const young = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token,
      body: { challenge },
    }),
  );
  assertNotEquals(young.status, 200);
  h.tables.account_deletion_requests = [];
  const unknown = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token,
      body: { challenge: crypto.randomUUID() },
    }),
  );
  assertNotEquals(unknown.status, 200);

  h.tables.account_deletion_requests = [deletionRequestRow(challenge)];
  const verifications = () => h.callsTo("/auth/v1/token").length;
  const before = verifications();
  const ok = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token,
      body: { challenge },
    }),
  );
  assertEquals(ok.status, 200);
  await h.handler(userRequest("GET", "/v1/me/access", { token }));
  assertEquals(
    verifications(),
    before + 1,
    "confirming bearer re-verified after deletion",
  );
});

Deno.test("V23 delete-request: exit survey is best-effort — platform 'android' accepted server-side, garbage ignored, request still 200", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(223), "phone");
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  const res = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token,
      body: {
        survey: {
          reason: "not_useful",
          platform: "android",
          details: "x".repeat(5000),
        },
      },
    }),
  );
  assertEquals(res.status, 200);
  const body = await readJson(res);
  assert(typeof body.challenge === "string");
  const garbage = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token,
      body: { survey: "nope" },
    }),
  );
  assertEquals(garbage.status, 200);
});

// ── externalAccounts crypto ─────────────────────────────────────────────────

Deno.test("V24 externalAccounts: AAD binds ciphertext to the user; wrong-length key → configuration error", async () => {
  const key = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  );
  const uid = userId(224);
  const sealed = await encryptAppleRefreshToken("rt", uid, key);
  assertEquals(await decryptAppleRefreshToken(sealed, uid, key), "rt");
  let crossUser: unknown = null;
  try {
    await decryptAppleRefreshToken(sealed, userId(225), key);
  } catch (error) {
    crossUser = error;
  }
  assert(crossUser instanceof Error, "ciphertext decrypted for another user");
  const short = btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))),
  );
  let shortErr: unknown = null;
  try {
    await encryptAppleRefreshToken("rt", uid, short);
  } catch (error) {
    shortErr = error;
  }
  assert(shortErr instanceof Error);
  // base64url form of the same key is accepted (documented leniency)
  const url = key.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assertEquals(await decryptAppleRefreshToken(sealed, uid, url), "rt");
});

// ── Route budgets ───────────────────────────────────────────────────────────

Deno.test("V25 per-user shots budget: 31st sync in a minute → 429 with Retry-After", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(226), "phone");
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  let last: Response | null = null;
  for (let i = 0; i < 31; i += 1) {
    last = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        token,
        body: { shots: [syncShot()] },
      }),
    );
    if (i < 30) assertEquals(last.status, 200, `request ${i + 1}`);
  }
  assertEquals(last!.status, 429);
  assert(last!.headers.get("Retry-After"));
});
