/**
 * W06-02 adversary — network failure at each step, concurrency/reentrancy,
 * process restart (cache carried across deploys) and unauthorised callers,
 * all through the REAL handler (routesHarness).
 *
 * What the definition-version tag must guarantee under stress:
 *   • a 5xx / 429 / redirect / garbage body from PostgREST on EITHER read
 *     yields the generic 503 (no detail, no half-built tagged summary) and is
 *     NEVER cached as the user's rank/progress;
 *   • N concurrent first requests coalesce into ONE view read and every
 *     caller gets the identical tagged payload;
 *   • a payload cached by a pre-tag deployment (L1/L2 survive a rolling
 *     deploy for their TTL) is what the candidate serves until it expires —
 *     documented, measured, and bounded by the 60 s TTL;
 *   • anonymous / malformed bearers never reach the scoring path (401) and a
 *     second user never sees the first user's rows.
 *
 *   deno test -A --no-check --config deno.json attack_w06_02_network_concurrency.test.ts
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { SCORING_DEFINITION_VERSION } from "../scoringDefinition.ts";
import { cacheDel, cacheGet, cacheSet } from "../cache.ts";
import { fakeGoogleIdToken, loadHarness, type RecordedCall, userRequest } from "./routesHarness.ts";

const h = await loadHarness();
let userSeq = 0;

function freshUser(): { userId: string; token: string; ip: string } {
  userSeq += 1;
  const userId = `fc000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.player_technique_rating = [
    {
      user_id: userId,
      shot_type: "dink",
      score: 7.25,
      captured_at: "2026-09-01T00:00:00.000Z",
      sampled_count: 4,
      confidence_weight: 4,
    },
    {
      user_id: userId,
      shot_type: "drive",
      score: 5.5,
      captured_at: "2026-09-02T00:00:00.000Z",
      sampled_count: 2,
      confidence_weight: 2,
    },
  ];
  h.tables.player_rank_state = [];
  h.tables.progress_daily = [
    {
      user_id: userId,
      day: "2026-09-01",
      shot_type: "dink",
      scoring_model_version: "v1",
      shot_count: 3,
      avg_score: 7.25,
      best_score: 8.1,
    },
  ];
  h.tables.practice_days = [{ user_id: userId, day: "2026-09-01" }];
  return {
    userId,
    token: fakeGoogleIdToken(userId),
    ip: `198.51.${160 + Math.floor(userSeq / 250)}.${(userSeq % 250) + 1}`,
  };
}

const EXPECTED_RATING = Math.round((4 * 725 + 2 * 550) / 6) / 100; // 6.67

function isView(call: RecordedCall): boolean {
  return call.url.includes("/rest/v1/player_technique_rating");
}
function isState(call: RecordedCall): boolean {
  return call.url.includes("/rest/v1/player_rank_state");
}
function isProgressSeries(call: RecordedCall): boolean {
  return call.url.includes("/rest/v1/progress_daily");
}

async function get(path: string, auth: { token: string; ip: string }): Promise<Response> {
  return await h.handler(userRequest("GET", path, auth));
}

async function assertGeneric503(response: Response, context: string): Promise<void> {
  assertEquals(response.status, 503, `${context}: status`);
  const text = await response.text();
  const body = JSON.parse(text) as { error?: { message?: string } };
  assertEquals(body, {
    error: { message: `${context} is temporarily unavailable. Please try again.` },
  });
  assert(!text.includes("definitionVersion"), "a failure must not carry a definition tag");
  assert(!text.includes("PGRST") && !text.includes("player_"), "no internal detail leaks");
}

// ─── network failure at each step ───────────────────────────────────────────

for (
  const [label, status, body] of [
    ["500 internal", 500, { code: "XX000", message: "boom player_technique_rating" }],
    ["502 gateway", 502, "<html>bad gateway</html>"],
    ["429 throttled", 429, { message: "rate limited" }],
    ["503 with Retry-After", 503, { message: "maintenance" }],
  ] as const
) {
  Deno.test(`ATTACK W06-02 network: PostgREST ${label} on the technique view ⇒ generic 503, nothing cached, next call recovers tagged`, async () => {
    const auth = freshUser();
    h.respond = (call) =>
      isView(call)
        ? new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json", "Retry-After": "7" },
        })
        : null;
    await assertGeneric503(await get("/v1/rank", auth), "Player rank");
    assertEquals(await cacheGet(`rank:${auth.userId}`), null, "failure must not be cached");
    h.respond = () => null;
    const ok = await get("/v1/rank", auth);
    assertEquals(ok.status, 200);
    const payload = (await ok.json()) as { rank: { definitionVersion: string; rating: number } };
    assertEquals(payload.rank.definitionVersion, SCORING_DEFINITION_VERSION);
    assertEquals(payload.rank.rating, EXPECTED_RATING);
  });
}

Deno.test("ATTACK W06-02 network: PostgREST 500 on player_rank_state (view fine) ⇒ generic 503, no inline half-answer cached", async () => {
  const auth = freshUser();
  h.respond = (call) =>
    isState(call)
      ? new Response(JSON.stringify({ code: "XX000", message: "state boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  await assertGeneric503(await get("/v1/rank", auth), "Player rank");
  assertEquals(await cacheGet(`rank:${auth.userId}`), null);
});

Deno.test("ATTACK W06-02 network: PostgREST 302 redirect on the view is not followed into a foreign body", async () => {
  const auth = freshUser();
  h.respond = (call) =>
    isView(call)
      ? new Response(
        JSON.stringify([{
          shot_type: "evil",
          score: 10,
          sampled_count: 1,
          confidence_weight: 1,
          captured_at: "2026-01-01T00:00:00Z",
        }]),
        {
          status: 302,
          headers: {
            Location: "https://attacker.example/rows",
            "Content-Type": "application/json",
          },
        },
      )
      : null;
  const response = await get("/v1/rank", auth);
  assertEquals(response.status, 503, "a redirect is a failed read, never trusted rows");
  assertEquals(h.callsTo("attacker.example").length, 0, "the Location must not be followed");
  const text = await response.text();
  assert(!text.includes("evil"));
  assertEquals(await cacheGet(`rank:${auth.userId}`), null);
});

Deno.test("ATTACK W06-02 network: PostgREST 200 with a non-array body on the view ⇒ no crash, no tagged garbage", async () => {
  const auth = freshUser();
  h.respond = (call) =>
    isView(call)
      ? new Response(JSON.stringify({ shot_type: "dink", score: 9 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  const response = await get("/v1/rank", auth);
  const text = await response.text();
  assert(response.status === 200 || response.status === 503, `status ${response.status}`);
  if (response.status === 200) {
    // An object is not rows: the only honest 200 is "unranked".
    assertEquals(JSON.parse(text), { rank: null });
  } else {
    assert(!text.includes("definitionVersion"));
  }
});

Deno.test("ATTACK W06-02 network: PostgREST 500 on progress_daily ⇒ generic 503, no cached progress", async () => {
  const auth = freshUser();
  h.respond = (call) =>
    isProgressSeries(call)
      ? new Response(JSON.stringify({ code: "XX000", message: "progress boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  await assertGeneric503(await get("/v1/progress", auth), "Progress");
  assertEquals(await cacheGet(`progress:${auth.userId}`), null);
  h.respond = () => null;
  const ok = await get("/v1/progress", auth);
  assertEquals(ok.status, 200);
  const payload = (await ok.json()) as { definitionVersion: string; series: unknown[] };
  assertEquals(payload.definitionVersion, SCORING_DEFINITION_VERSION);
  assertEquals(payload.series.length, 1);
});

// ─── concurrency / reentrancy ───────────────────────────────────────────────

Deno.test("ATTACK W06-02 concurrency: 12 simultaneous first reads coalesce into one view read and one identical tagged body", async () => {
  const auth = freshUser();
  let viewReads = 0;
  h.respond = (call) => {
    if (isView(call)) viewReads += 1;
    return null;
  };
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => get("/v1/rank", auth)),
  );
  const bodies = await Promise.all(responses.map((r) => r.text()));
  for (const r of responses) assertEquals(r.status, 200);
  assertEquals(new Set(bodies).size, 1, "every concurrent caller must see the same bytes");
  assertEquals(viewReads, 1, "coalesce: exactly one PostgREST read for the burst");
  const payload = JSON.parse(bodies[0]) as { rank: { definitionVersion: string } };
  assertEquals(payload.rank.definitionVersion, SCORING_DEFINITION_VERSION);
});

Deno.test("ATTACK W06-02 concurrency: a sync-side cache bust DURING the build fences the stale result out of the cache", async () => {
  const auth = freshUser();
  let released: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => (released = resolve));
  h.respond = async (call) => {
    if (isView(call)) await gate;
    return null;
  };
  const inFlight = get("/v1/rank", auth);
  // an accepted shot sync invalidates the key while the read is in flight
  await new Promise((r) => setTimeout(r, 5));
  await cacheDel(`rank:${auth.userId}`, `progress:${auth.userId}`);
  released!();
  const response = await inFlight;
  assertEquals(response.status, 200);
  assertEquals(await cacheGet(`rank:${auth.userId}`), null, "fenced write must be a no-op");
});

// ─── process death / restart / rolling deploy ───────────────────────────────

Deno.test("ATTACK W06-02 restart: a rank payload cached by the pre-tag deployment is served UNTAGGED until its TTL lapses", async () => {
  const auth = freshUser();
  const legacy = {
    rank: {
      rating: 6.67,
      tier: "platinum",
      techniqueCount: 2,
      scoredShotCount: 6,
      updatedAt: "2026-09-01T00:00:00.000Z",
      techniques: [],
    },
  };
  // L1 write (L2 is unconfigured in the harness — the return value only
  // reports L2); the entry survives exactly like an L2 row would across a
  // rolling deploy for its TTL.
  await cacheSet(`rank:${auth.userId}`, JSON.stringify(legacy), 60);
  const response = await get("/v1/rank", auth);
  assertEquals(response.status, 200);
  const payload = (await response.json()) as { rank: { definitionVersion?: string } };
  assertEquals(
    payload.rank.definitionVersion,
    SCORING_DEFINITION_VERSION,
    "a 200 from the tagged deployment must carry the tag (cache key does not encode the definition)",
  );
});

Deno.test("ATTACK W06-02 restart: a progress payload cached by the pre-tag deployment is served UNTAGGED until its TTL lapses", async () => {
  const auth = freshUser();
  const legacy = {
    series: [],
    improving: [],
    needsAttention: [],
    streak: { currentDays: 0, longestDays: 0, practicedToday: false, lastPracticeDate: null },
  };
  await cacheSet(`progress:${auth.userId}`, JSON.stringify(legacy), 60);
  const response = await get("/v1/progress", auth);
  assertEquals(response.status, 200);
  const payload = (await response.json()) as { definitionVersion?: string };
  assertEquals(payload.definitionVersion, SCORING_DEFINITION_VERSION);
});

Deno.test("ATTACK W06-02 restart: corrupt (non-JSON) cache entry falls through to a fresh tagged build", async () => {
  const auth = freshUser();
  await cacheSet(`rank:${auth.userId}`, "{not json", 60);
  const response = await get("/v1/rank", auth);
  assertEquals(response.status, 200);
  const payload = (await response.json()) as {
    rank: { definitionVersion: string; rating: number };
  };
  assertEquals(payload.rank.definitionVersion, SCORING_DEFINITION_VERSION);
  assertEquals(payload.rank.rating, EXPECTED_RATING);
});

// ─── unauthorised roles ─────────────────────────────────────────────────────

Deno.test("ATTACK W06-02 unauthorised: no bearer / garbage bearer / anon apikey never reach the scoring path", async () => {
  freshUser();
  for (
    const headers of [
      {} as Record<string, string>,
      { Authorization: "Bearer not-a-jwt" },
      { Authorization: "Bearer eyJhbGciOiJub25lIn0.e30." },
      { Authorization: "Basic dXNlcjpwYXNz" },
      { apikey: "anon-key" },
    ]
  ) {
    for (const path of ["/v1/rank", "/v1/progress"]) {
      const request = new Request(`http://edge.test/functions/v1/api${path}`, {
        method: "GET",
        headers: { "x-forwarded-for": "198.51.199.1", ...headers },
      });
      const response = await h.handler(request);
      assertEquals(response.status, 401, `${path} ${JSON.stringify(headers)}`);
      const text = await response.text();
      assert(!text.includes("definitionVersion") && !text.includes("rating"), text);
      assertEquals(
        h.callsTo("/rest/v1/player_").length,
        0,
        "no DB read for an unauthenticated caller",
      );
      assertEquals(h.callsTo("/rest/v1/progress_daily").length, 0);
    }
  }
});

Deno.test("ATTACK W06-02 unauthorised: the rank read is scoped to the bearer's user id on every PostgREST call", async () => {
  const auth = freshUser();
  const response = await get("/v1/rank", auth);
  assertEquals(response.status, 200);
  const reads = h.calls.filter((c) => isView(c) || isState(c));
  assertEquals(reads.length, 2);
  for (const call of reads) {
    assertStringIncludes(call.url, `user_id=eq.${auth.userId}`);
    // bootstrap exchanged the provider token for the user's session bearer
    assertStringIncludes(call.headers["authorization"] ?? "", `session-for-${auth.userId}`);
    assert(
      call.headers["authorization"] !== "Bearer service-role-test-key",
      "user session bearer, never the service role",
    );
  }
});
