// STRUCTURAL AUDIT #1 (edge-domain-routes) — POST /v1/shots:sync HTTP layer
// and the rank/progress read-model cache it invalidates.
//
// Real handler via routesHarness (PostgREST + Auth stubbed at fetch). Each
// test uses its own user id + IP so per-user/per-IP budgets never collide.
//
// Covers what the mapper listed as untested: mixed accepted/rejected batches,
// replay short-circuit, replay-SELECT failure → 503, RPC error / unknown
// status / "shot.write_failed:<detail>" → stable code + generic message,
// cacheDel only when evidence was written, and the coalesce-vs-cacheDel race
// (a rank build that READ before a sync committed but FINISHED after the
// sync's cacheDel re-populates the cache with pre-sync data for 60 s).

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  fakeGoogleIdToken,
  loadHarness,
  userRequest,
} from "./routesHarness.ts";

type FetchFn = typeof fetch;

function validShot(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
    resultKind: "scored",
    overallScore: 7.2,
    confidence: 0.91,
    phases: [{
      key: "prep",
      startMs: 0,
      representativeMs: 100,
      endMs: 300,
      confidence: 0.9,
    }],
    checkpoints: [
      {
        key: "contact_position",
        score: 72,
        confidence: 0.8,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "b1",
      poseModelVersion: "p1",
      paddleModelVersion: "pd1",
      strokeDetectorVersion: "s1",
      phaseModelVersion: "ph1",
      scoringModelVersion: "sc1",
      shotConfigVersion: "c1",
    },
    ...overrides,
  };
}

interface SyncResponse {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}

let ipCounter = 0;
function freshIdentity() {
  ipCounter += 1;
  const userId = crypto.randomUUID();
  return {
    userId,
    token: fakeGoogleIdToken(userId),
    ip: `198.51.100.${ipCounter}`,
  };
}

/** Run `fn` with `globalThis.fetch` wrapped; the wrapper is removed after. */
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

Deno.test("shots:sync — mixed batch: malformed rejected per-shot, replay acknowledged without RPC, new shot applied", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const replay = validShot();
  const fresh = validShot();
  const bogus = validShot({ source: "synthetic" });
  const badTs = validShot({
    timestamps: { startMs: -1, contactMs: null, endMs: 10 },
  });
  h.tables.shots = [{ id: replay.id }];
  h.rpcs.apply_synced_shot = "accepted";

  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: [replay, bogus, fresh, badTs] },
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as SyncResponse;
  assertEquals(body.acceptedIds.sort(), [replay.id, fresh.id].sort());
  assertEquals(body.rejected.map((r) => [r.id, r.code]), [
    [bogus.id, "shot.non_real_source"],
    [badTs.id, "shot.invalid_payload"],
  ]);
  assertEquals(
    h.callsTo("rpc/apply_synced_shot").length,
    1,
    "replay must not re-run the RPC",
  );
  assertEquals(
    h.callsTo("rest/v1/shots?").length,
    1,
    "one batched replay SELECT",
  );
});

Deno.test("shots:sync — replay SELECT failure → 503 with generic body (whole batch retryable)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.rpcs.apply_synced_shot = "accepted";
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" && request.url.includes("/rest/v1/shots?")
        ) {
          return new Response(
            JSON.stringify({
              code: "57014",
              message: "canceling statement due to statement timeout",
            }),
            { status: 500, headers: { "Content-Type": "application/json" } },
          );
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", "/v1/shots:sync", {
          token: me.token,
          ip: me.ip,
          body: { shots: [validShot()] },
        }),
      ),
  );
  assertEquals(res.status, 503);
  const text = await res.text();
  assert(!text.includes("statement timeout"), `DB detail leaked: ${text}`);
  assert(text.includes("temporarily unavailable"));
  assertEquals(h.callsTo("rpc/apply_synced_shot").length, 0);
});

Deno.test("shots:sync — RPC error, unknown status and 'shot.write_failed:<detail>' all become shot.write_failed with a generic message", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const a = validShot();
  const b = validShot();
  const c = validShot();
  const d = validShot();
  const statuses = new Map<string, () => Response>([
    [
      a.id as string,
      () =>
        new Response(
          JSON.stringify({
            code: "42501",
            message: "permission denied for table shots",
          }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        ),
    ],
    [
      b.id as string,
      () => new Response(JSON.stringify("totally.unexpected"), { status: 200 }),
    ],
    [
      c.id as string,
      () =>
        new Response(
          JSON.stringify(
            "shot.write_failed:duplicate key value violates unique constraint",
          ),
          {
            status: 200,
          },
        ),
    ],
    [
      d.id as string,
      () =>
        new Response(JSON.stringify("access.permit_expired"), { status: 200 }),
    ],
  ]);
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("rpc/apply_synced_shot")) {
          const payload = (await request.clone().json()) as {
            shot: { id: string };
          };
          const make = statuses.get(payload.shot.id);
          if (make) return make();
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", "/v1/shots:sync", {
          token: me.token,
          ip: me.ip,
          body: { shots: [a, b, c, d] },
        }),
      ),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as SyncResponse;
  assertEquals(body.acceptedIds, []);
  const byId = new Map(body.rejected.map((r) => [r.id, r]));
  assertEquals(byId.get(a.id as string)?.code, "shot.write_failed");
  assertEquals(byId.get(b.id as string)?.code, "shot.write_failed");
  assertEquals(byId.get(c.id as string)?.code, "shot.write_failed");
  assertEquals(byId.get(d.id as string)?.code, "access.permit_expired");
  for (const r of body.rejected) {
    assert(
      !r.message.includes("duplicate key"),
      `DB detail leaked: ${r.message}`,
    );
    assert(
      !r.message.includes("permission denied"),
      `DB detail leaked: ${r.message}`,
    );
  }
});

Deno.test("shots:sync — cross-user uuid: not a replay for THIS user, reaches the RPC and maps to a permanent shot.id_conflict; duplicate ids in one batch hit the RPC twice", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const foreign = validShot();
  const twice = validShot();
  h.tables.shots = []; // the user-scoped replay SELECT (RLS) sees nothing
  h.rpcs.apply_synced_shot = "accepted";

  // Warm both caches so a wrongful invalidation would be visible.
  h.tables.progress_daily = [];
  h.tables.practice_days = [];
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  await (await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  const rankReadsBefore = h.callsTo("/rest/v1/player_technique_rating").length;

  let rpcCalls = 0;
  const res = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (request.url.includes("rpc/apply_synced_shot")) {
          rpcCalls += 1;
          const payload = (await request.clone().json()) as {
            shot: { id: string };
          };
          if (payload.shot.id === foreign.id) {
            return new Response(JSON.stringify("shot.id_conflict"), {
              status: 200,
            });
          }
          // Second occurrence of the same id inside one batch: the RPC's own
          // owned-id replay rule answers "accepted" (be-edge-routes-shots-rank).
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", "/v1/shots:sync", {
          token: me.token,
          ip: me.ip,
          body: { shots: [foreign, twice, twice] },
        }),
      ),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as SyncResponse;
  assertEquals(body.rejected, [
    {
      id: foreign.id,
      code: "shot.id_conflict",
      message: "Shot id is already bound to a different user.",
    },
  ]);
  // Duplicate ids inside one batch are NOT deduplicated by the edge — the
  // RPC is asked twice and the id is acknowledged twice.
  assertEquals(body.acceptedIds, [twice.id, twice.id]);
  assertEquals(rpcCalls, 3);

  // The batch wrote evidence (twice accepted) → caches busted → rank re-read.
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  assertEquals(
    h.callsTo("/rest/v1/player_technique_rating").length,
    rankReadsBefore + 1,
  );
});

Deno.test("shots:sync — batch bounds: 0 and 201 entries → 400 validation.shots_sync; 200 accepted", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.rpcs.apply_synced_shot = "accepted";
  const empty = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: [] },
    }),
  );
  assertEquals(empty.status, 400);
  assertEquals(
    ((await empty.json()) as { error: { code: string } }).error.code,
    "validation.shots_sync",
  );
  const tooMany = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: Array.from({ length: 201 }, () => validShot()) },
    }),
  );
  assertEquals(tooMany.status, 400);
  await tooMany.body?.cancel();
  const full = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: Array.from({ length: 200 }, () => validShot()) },
    }),
  );
  assertEquals(full.status, 200);
  assertEquals(((await full.json()) as SyncResponse).acceptedIds.length, 200);
});

Deno.test("cache — accepted sync busts rank+progress; a rejected-only sync leaves both cached", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const progressDailyCalls = () => h.callsTo("rest/v1/progress_daily").length;
  const rankCalls = () => h.callsTo("rest/v1/player_technique_rating").length;

  // Warm both caches.
  h.tables.progress_daily = [];
  h.tables.practice_days = [];
  h.tables.player_technique_rating = [];
  assertEquals(
    (await h.handler(
      userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
    )).status,
    200,
  );
  assertEquals(
    (await h.handler(
      userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
    )).status,
    200,
  );
  assertEquals(progressDailyCalls(), 1);
  assertEquals(rankCalls(), 1);
  // Cached: no new PostgREST reads.
  await (await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  assertEquals(progressDailyCalls(), 1);
  assertEquals(rankCalls(), 1);

  // Rejected-only sync (permit expired): nothing written → caches kept.
  h.rpcs.apply_synced_shot = "access.permit_expired";
  const rejectedOnly = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: [validShot()] },
    }),
  );
  assertEquals(
    ((await rejectedOnly.json()) as SyncResponse).rejected[0].code,
    "access.permit_expired",
  );
  await (await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  assertEquals(
    progressDailyCalls(),
    1,
    "rejected-only sync must not bust progress",
  );
  assertEquals(rankCalls(), 1, "rejected-only sync must not bust rank");

  // Accepted sync → both caches dropped → next reads hit PostgREST.
  h.rpcs.apply_synced_shot = "accepted";
  const accepted = await h.handler(
    userRequest("POST", "/v1/shots:sync", {
      token: me.token,
      ip: me.ip,
      body: { shots: [validShot()] },
    }),
  );
  assertEquals(((await accepted.json()) as SyncResponse).acceptedIds.length, 1);
  await (await h.handler(
    userRequest("GET", "/v1/progress", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  await (await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  )).body?.cancel();
  assertEquals(progressDailyCalls(), 2, "accepted sync must bust progress");
  assertEquals(rankCalls(), 2, "accepted sync must bust rank");
});

Deno.test("REPRO: cache — a rank build that read BEFORE a sync commit but finished AFTER its cacheDel re-caches the pre-sync payload", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.player_technique_rating = []; // no evidence yet → {rank:null}
  h.rpcs.apply_synced_shot = "accepted";

  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));

  const raced = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        // Model a PostgREST read whose result was computed before the sync
        // committed but whose response reaches the isolate after it.
        if (
          request.method === "GET" &&
          request.url.includes("/rest/v1/player_technique_rating")
        ) {
          const response = await inner(input, init);
          await gate;
          return response;
        }
        return inner(input, init);
      }) as FetchFn,
    async () => {
      const inflight = h.handler(
        userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
      );
      // Let the build issue its PostgREST reads before the sync lands.
      await new Promise((r) => setTimeout(r, 50));
      const sync = await h.handler(
        userRequest("POST", "/v1/shots:sync", {
          token: me.token,
          ip: me.ip,
          body: { shots: [validShot()] },
        }),
      );
      assertEquals(((await sync.json()) as SyncResponse).acceptedIds.length, 1);
      // The committed shot is now visible to the DB.
      h.tables.player_technique_rating = [
        {
          shot_type: "dink",
          score: 7.2,
          captured_at: new Date().toISOString(),
          sampled_count: 1,
          confidence_weight: 1,
        },
      ];
      h.tables.player_rank_state = [];
      release();
      const stale = await inflight;
      assertEquals(stale.status, 200);
      return (await stale.json()) as { rank: unknown };
    },
  );
  assertEquals(
    raced.rank,
    null,
    "the in-flight build itself honestly returns what it read",
  );

  // Contract: after an accepted sync, GET /v1/rank must reflect the new
  // evidence (the sync's cacheDel exists for exactly this). On 4d812e1a the
  // late cacheSet in buildPlayerRank re-populates rank:<uid> with {rank:null}
  // and this read is served from cache for up to 60 s.
  const after = await h.handler(
    userRequest("GET", "/v1/rank", { token: me.token, ip: me.ip }),
  );
  const body = (await after.json()) as { rank: { rating: number } | null };
  assertNotEquals(
    body.rank,
    null,
    "rank read after an accepted sync must not serve the pre-sync payload",
  );
  assertEquals(body.rank?.rating, 7.2);
});
