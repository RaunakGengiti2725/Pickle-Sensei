// STRUCTURAL AUDIT #1 (edge-domain-routes) — HTTP-level pins for the permit
// routes and the rank/progress read models (all listed as untested by the
// mapper). Real handler via routesHarness; PostgREST stubbed at fetch.

import { assert, assertEquals } from "jsr:@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  userRequest,
} from "./routesHarness.ts";

type FetchFn = typeof fetch;

let ipCounter = 0;
function freshIdentity() {
  ipCounter += 1;
  const userId = crypto.randomUUID();
  return {
    userId,
    token: fakeGoogleIdToken(userId),
    ip: `192.0.2.${ipCounter}`,
  };
}

async function withFetch<T>(
  wrap: (inner: FetchFn) => FetchFn,
  fn: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = wrap(inner);
  try {
    return await fn();
  } finally {
    globalThis.fetch = inner;
  }
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ACCESS_FREE = [{ premium: false, scored_count: 0, reserved_count: 1 }];

// ── Permits ──────────────────────────────────────────────────────────────────

Deno.test("permits — reserve: accepted row → { permit, access }, expiresAt = created_at + 24 h, accessSource 'free'", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const permitId = crypto.randomUUID();
  const createdAt = "2026-09-04T10:00:00.000Z";
  h.rpcs.reserve_analysis_permit = [
    {
      result: "accepted",
      permit_id: permitId,
      permit_status: "reserved",
      permit_outcome: null,
      permit_created_at: createdAt,
    },
  ];
  h.rpcs.access_state = ACCESS_FREE;
  const res = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: me.token,
      ip: me.ip,
      body: { idempotencyKey: "key-1" },
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    permit: {
      id: string;
      accessSource: string;
      status: string;
      expiresAt: string;
      reservedAt: string;
    };
    access: { freeRatings: { reserved: number; availableToReserve: number } };
  };
  assertEquals(body.permit.id, permitId);
  assertEquals(body.permit.accessSource, "free");
  assertEquals(body.permit.status, "reserved");
  assertEquals(body.permit.reservedAt, createdAt);
  assertEquals(body.permit.expiresAt, "2026-09-05T10:00:00.000Z");
  assertEquals(body.access.freeRatings.reserved, 1);
  assertEquals(body.access.freeRatings.availableToReserve, 1);
});

Deno.test("permits — reserve: paywall → 402 access.paywall_required; unknown RPC verdict → 503 generic; bad key → 400", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.rpcs.reserve_analysis_permit = [{
    result: "access.paywall_required",
    permit_id: null,
  }];
  const paywall = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: me.token,
      ip: me.ip,
      body: { idempotencyKey: "k" },
    }),
  );
  assertEquals(paywall.status, 402);
  assertEquals(
    ((await paywall.json()) as { error: { code: string } }).error.code,
    "access.paywall_required",
  );

  h.rpcs.reserve_analysis_permit = [{
    result: "something_new",
    permit_id: null,
  }];
  const weird = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: me.token,
      ip: me.ip,
      body: { idempotencyKey: "k" },
    }),
  );
  assertEquals(weird.status, 503);
  const text = await weird.text();
  assert(!text.includes("something_new"), text);

  const tooLong = await h.handler(
    userRequest("POST", "/v1/analysis-permits", {
      token: me.token,
      ip: me.ip,
      body: { idempotencyKey: "x".repeat(129) },
    }),
  );
  assertEquals(tooLong.status, 400);
  assertEquals(
    ((await tooLong.json()) as { error: { code: string } }).error.code,
    "validation.analysis_permit",
  );
});

Deno.test("permits — finalize refuses 'scored' and a non-null ratingId (400); unknown/foreign permit → 404", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const permitId = crypto.randomUUID();
  const scored = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: me.token,
      ip: me.ip,
      body: { outcome: "scored", ratingId: null },
    }),
  );
  assertEquals(scored.status, 400);
  assertEquals(
    ((await scored.json()) as { error: { code: string } }).error.code,
    "validation.analysis_permit_finalize",
  );

  const withRating = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: me.token,
      ip: me.ip,
      body: { outcome: "cancelled", ratingId: crypto.randomUUID() },
    }),
  );
  assertEquals(withRating.status, 400);
  await withRating.body?.cancel();

  h.tables.analysis_permits = []; // RLS: another user's row is invisible
  const missing = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: me.token,
      ip: me.ip,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(missing.status, 404);
  assertEquals(
    ((await missing.json()) as { error: { code: string } }).error.code,
    "access.permit_not_found",
  );
  assertEquals(
    h.callsTo("rest/v1/analysis_permits").filter((c) => c.method === "PATCH")
      .length,
    0,
  );
});

Deno.test("permits — finalize: reserved row is moved once; same-outcome replay → 200; different outcome → 409", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const permitId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  h.rpcs.access_state = ACCESS_FREE;
  h.tables.analysis_permits = [{
    id: permitId,
    status: "reserved",
    outcome: null,
    created_at: createdAt,
  }];

  const first = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "PATCH" &&
          request.url.includes("/rest/v1/analysis_permits")
        ) {
          const url = new URL(request.url);
          assertEquals(
            url.searchParams.get("status"),
            "eq.reserved",
            "update must be guarded on status",
          );
          assertEquals(url.searchParams.get("user_id"), `eq.${me.userId}`);
          const patch = (await request.clone().json()) as {
            status: string;
            outcome: string;
          };
          h.tables.analysis_permits = [{
            id: permitId,
            status: patch.status,
            outcome: patch.outcome,
            created_at: createdAt,
          }];
          return jsonRes(200, h.tables.analysis_permits[0]);
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
          token: me.token,
          ip: me.ip,
          body: { outcome: "low_confidence", ratingId: null },
        }),
      ),
  );
  assertEquals(first.status, 200);
  const firstBody = (await first.json()) as {
    permit: { status: string; outcome: string };
  };
  assertEquals(firstBody.permit, {
    ...firstBody.permit,
    status: "finalized",
    outcome: "low_confidence",
  });

  const patchCount = () =>
    h.callsTo("rest/v1/analysis_permits").filter((c) => c.method === "PATCH")
      .length;
  const before = patchCount();
  const replay = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: me.token,
      ip: me.ip,
      body: { outcome: "low_confidence", ratingId: null },
    }),
  );
  assertEquals(replay.status, 200);
  await replay.body?.cancel();
  assertEquals(patchCount(), before, "replay must not issue another UPDATE");

  const conflict = await h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token: me.token,
      ip: me.ip,
      body: { outcome: "cancelled", ratingId: null },
    }),
  );
  assertEquals(conflict.status, 409);
  assertEquals(
    ((await conflict.json()) as { error: { code: string } }).error.code,
    "access.permit_already_finalized",
  );
});

Deno.test("permits — finalize loses the race to a scored sync: guarded UPDATE matches 0 rows → 409 with the settled outcome", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const permitId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  h.tables.analysis_permits = [{
    id: permitId,
    status: "reserved",
    outcome: null,
    created_at: createdAt,
  }];
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "PATCH" &&
          request.url.includes("/rest/v1/analysis_permits")
        ) {
          // Between the SELECT and the UPDATE, apply_synced_shot finalized it.
          h.tables.analysis_permits = [{
            id: permitId,
            status: "finalized",
            outcome: "scored",
            created_at: createdAt,
          }];
          return jsonRes(200, []);
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
          token: me.token,
          ip: me.ip,
          body: { outcome: "cancelled", ratingId: null },
        }),
      ),
  );
  assertEquals(res.status, 409);
  const body = (await res.json()) as {
    error: { code: string; message: string };
  };
  assertEquals(body.error.code, "access.permit_already_finalized");
  assert(body.error.message.includes("scored"), body.error.message);
});

// ── Progress ─────────────────────────────────────────────────────────────────

const utcDay = (offsetDays: number) =>
  new Date(Date.now() - offsetDays * 86_400_000).toISOString().slice(0, 10);

Deno.test("progress — series scales 0-10 → 0-100, orders by day, UTC streak counts consecutive practice days", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.progress_daily = [
    {
      day: utcDay(0),
      shot_type: "dink",
      scoring_model_version: "sc1",
      avg_score: "7.35",
      best_score: 9,
      shot_count: 3,
    },
    {
      day: utcDay(1),
      shot_type: "dink",
      scoring_model_version: "sc1",
      avg_score: "6.07",
      best_score: 6.07,
      shot_count: 1,
    },
  ];
  h.tables.practice_days = [{ day: utcDay(0) }, { day: utcDay(1) }, {
    day: utcDay(3),
  }];
  const res = await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as {
    series: Array<{
      day: string;
      shot_type: string;
      scoring_model_version: string;
      avg_score: number;
      best_score: number;
      shot_count: number;
    }>;
    improving: unknown[];
    needsAttention: unknown[];
    streak: {
      currentDays: number;
      longestDays: number;
      practicedToday: boolean;
      lastPracticeDate: string | null;
    };
  };
  assertEquals(body.series.length, 2);
  const today = body.series.find((p) => p.day === utcDay(0));
  // numeric columns arrive as strings from PostgREST; 0-10 → 0-100 one decimal
  assertEquals(today?.avg_score, 73.5);
  assertEquals(today?.best_score, 90);
  assertEquals(today?.shot_count, 3);
  assertEquals(today?.scoring_model_version, "sc1");
  const yesterday = body.series.find((p) => p.day === utcDay(1));
  assertEquals(yesterday?.avg_score, 60.7);
  assertEquals(yesterday?.best_score, 60.7);
  assertEquals(body.improving, []);
  assertEquals(body.needsAttention, []);
  assertEquals(body.streak.currentDays, 2);
  assertEquals(body.streak.longestDays, 2);
  assertEquals(body.streak.practicedToday, true);
  assertEquals(body.streak.lastPracticeDate, utcDay(0));
});

Deno.test("progress — streak: practiced yesterday but not today keeps the streak alive; a 2-day gap resets it", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.progress_daily = [];
  h.tables.practice_days = [{ day: utcDay(1) }, { day: utcDay(2) }];
  const alive = (await (await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  )).json()) as {
    streak: { currentDays: number; practicedToday: boolean };
  };
  assertEquals(alive.streak.currentDays, 2);
  assertEquals(alive.streak.practicedToday, false);

  const other = freshIdentity();
  h.tables.practice_days = [{ day: utcDay(2) }, { day: utcDay(3) }];
  const reset = (await (await h.handler(
    userRequest("GET", "/v1/progress", { token: other.token, ip: other.ip }),
  )).json()) as {
    streak: { currentDays: number; longestDays: number };
  };
  assertEquals(reset.streak.currentDays, 0);
  assertEquals(reset.streak.longestDays, 2);
});

Deno.test("progress — paging: 1000-row pages via offset/limit, stops after MAX_PAGES=20 (20 000 rows) and still answers 200", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.practice_days = [];
  const ranges: string[] = [];
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" &&
          request.url.includes("/rest/v1/progress_daily")
        ) {
          const params = new URL(request.url).searchParams;
          const from = Number(params.get("offset") ?? "0");
          ranges.push(`${params.get("offset")}+${params.get("limit")}`);
          // An account with unbounded history: every page is full.
          const rows = Array.from({ length: 1000 }, (_, i) => ({
            day: `2020-01-01`,
            shot_type: `t${from + i}`,
            avg_score: 5,
            best_score: 5,
            shots: 1,
          }));
          return jsonRes(200, rows);
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
      ),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { series: unknown[] };
  assertEquals(ranges.length, 20, `pages requested: ${ranges.join(",")}`);
  assertEquals(ranges[0], "0+1000");
  assertEquals(ranges[19], "19000+1000");
  assertEquals(body.series.length, 20_000);
});

Deno.test("progress — a PostgREST failure on either read → 503 generic (nothing cached)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.progress_daily = [];
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" &&
          request.url.includes("/rest/v1/practice_days")
        ) {
          return jsonRes(500, {
            code: "XX000",
            message: "relation practice_days does not exist",
          });
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
      ),
  );
  assertEquals(res.status, 503);
  assert(!(await res.text()).includes("practice_days"));
  // Failure was not cached: the next read hits PostgREST again.
  h.tables.practice_days = [];
  const ok = await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  );
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

// ── Rank ─────────────────────────────────────────────────────────────────────

Deno.test("rank — no technique rows → { rank: null } (and it is cached)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.player_technique_rating = [];
  const res = await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { rank: null });
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  assertEquals(h.callsTo("rest/v1/player_technique_rating").length, 1);
});

Deno.test("rank — persisted player_rank_state wins when valid; payload never exposes confidence_weight", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const capturedAt = new Date().toISOString();
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 7.9,
      captured_at: capturedAt,
      sampled_count: 4,
      confidence_weight: 3.2,
    },
  ];
  h.tables.player_rank_state = [
    {
      rating: "7.60",
      tier: "diamond",
      technique_count: 1,
      scored_shot_count: 4,
      updated_at: capturedAt,
    },
  ];
  const body = (await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).json()) as {
    rank: {
      rating: number;
      tier: string;
      techniqueCount: number;
      scoredShotCount: number | null;
      updatedAt: string | null;
      techniques: Array<Record<string, unknown>>;
    };
  };
  assertEquals(body.rank.rating, 7.6);
  assertEquals(body.rank.tier, "diamond");
  assertEquals(body.rank.scoredShotCount, 4);
  assertEquals(body.rank.techniqueCount, 1);
  assertEquals(body.rank.updatedAt, capturedAt);
  assertEquals(body.rank.techniques.length, 1);
  assertEquals("confidence_weight" in body.rank.techniques[0], false);
  assertEquals("confidenceWeight" in body.rank.techniques[0], false);
});

Deno.test("rank — fallback: confidence-weighted mean over rounded technique scores; 6.5 lands exactly on platinum", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const capturedAt = new Date().toISOString();
  h.tables.player_technique_rating = [
    {
      shot_type: "dink",
      score: 7.0,
      captured_at: capturedAt,
      sampled_count: 5,
      confidence_weight: 5,
    },
    {
      shot_type: "drive",
      score: 4.0,
      captured_at: capturedAt,
      sampled_count: 1,
      confidence_weight: 1,
    },
  ];
  h.tables.player_rank_state = [];
  const body = (await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).json()) as {
    rank: {
      rating: number;
      tier: string;
      techniqueCount: number;
      scoredShotCount: number | null;
      updatedAt: string | null;
    };
  };
  // (5·700 + 1·400) / 6 = 650 → 6.5 → platinum (threshold is inclusive)
  assertEquals(body.rank.rating, 6.5);
  assertEquals(body.rank.tier, "platinum");
  assertEquals(body.rank.techniqueCount, 2);
  assertEquals(body.rank.scoredShotCount, null);
  assertEquals(body.rank.updatedAt, null);
});
