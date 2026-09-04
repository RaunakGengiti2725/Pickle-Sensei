// Adversarial pass 3 — edge domain routes: attacks that FAIL on 4d812e1a.
//
// Every test here asserts the CORRECT behaviour and is therefore red on the
// target commit; each documents the observed defect inline. The file name
// ends in `.attack.ts` on purpose so `deno task test` (which sweeps
// `{*_,*.,}test.ts`) does not pick it up — run it explicitly:
//
//   deno test -A --no-check --config deno.json attack3_edge_domain_routes_expected_failures.attack.ts
//
// Once a defect is fixed, move its test into attack3_edge_domain_routes.test.ts.
//
//   S5  rank + progress cache race: an in-flight coalesced build finishing
//       AFTER an accepted shots:sync re-populates the cache with pre-sync
//       data, and the next GET (within the 60 s TTL) serves it.
//   S7  orphaned saved-drill placeholder gets a fresh crypto.randomUUID() id
//       on every GET /v1/me/saved-drills.
//   S3+ onboarding `goal` equal to an Object.prototype method name
//       ('constructor', 'toString', …) resolves GOAL_FOCUS[goal] to a
//       Function: focus_checkpoint is silently dropped from the PATCH and
//       the response carries no recommendedCheckpoint.
//   S2+/S3+ firstName/goal length caps count UTF-16 units, not characters:
//       a 40-character name / 64-character goal with astral characters is
//       rejected as too long.

import { assert, assertEquals } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest, type Harness } from "./routesHarness.ts";

const freshUser = (): string => crypto.randomUUID();

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Layer a response rewriter on top of the harness fetch (the harness still
 * records every call and reads `h.tables` at request time). */
function interceptFetch(
  rewrite: (request: Request, response: Response) => Promise<Response> | Response,
): () => void {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const probe = request.clone();
    const response = await base(input, init);
    return rewrite(probe, response);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = base;
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

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

const acceptedShot = () => ({
  id: crypto.randomUUID(),
  source: "real",
  analysisPermitId: crypto.randomUUID(),
  sessionId: null,
  shotType: "dink",
  cameraView: "side",
  capturedAt: "2026-09-04T10:00:00.000Z",
  timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
  resultKind: "scored",
  overallScore: 7,
  confidence: 0.9,
  phases: [],
  checkpoints: [],
  versionVector: VERSION_VECTOR,
});

async function syncAccepted(h: Harness, token: string, ip: string): Promise<void> {
  h.tables["shots"] = [];
  h.rpcs["apply_synced_shot"] = "accepted";
  const res = await h.handler(
    userRequest("POST", "/v1/shots:sync", { token, ip, body: { shots: [acceptedShot()] } }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.acceptedIds.length, 1, JSON.stringify(body));
}

function setRankTables(h: Harness, score: number): void {
  h.tables["player_technique_rating"] = [
    {
      shot_type: "dink",
      score,
      captured_at: "2026-09-04T10:00:00.000Z",
      sampled_count: 3,
      confidence_weight: 3,
    },
  ];
  h.tables["player_rank_state"] = [
    {
      rating: score,
      tier: score >= 7 ? "platinum" : "bronze",
      technique_count: 1,
      scored_shot_count: 3,
      updated_at: "2026-09-04T10:00:00.000Z",
    },
  ];
}

// ─────────────────────────────────────────────────────────────────────────────
// S5 — rank cache race
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S5: GET /v1/rank whose PostgREST read is in flight across an accepted shots:sync must NOT re-populate the cache with the pre-sync rank", async () => {
  const h = await loadHarness();
  const user = freshUser();
  const token = fakeGoogleIdToken(user);
  const ip = "198.51.100.230";
  // Warm auth so the race is purely about the rank build.
  await (await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip }))).body?.cancel();

  setRankTables(h, 5);
  const gate = deferred();
  const intercepted = deferred();
  const restore = interceptFetch(async (req, res) => {
    if (req.method === "GET" && req.url.includes("/rest/v1/player_rank_state")) {
      intercepted.resolve();
      await gate.promise; // the DB answered pre-sync; the network is slow.
    }
    return res;
  });
  try {
    const inflight = h.handler(userRequest("GET", "/v1/rank", { token, ip }));
    await intercepted.promise;

    // New evidence lands while the read is in flight → cacheDel(rank:user).
    await syncAccepted(h, token, ip);
    setRankTables(h, 7);

    gate.resolve();
    const stale = await inflight;
    assertEquals(stale.status, 200);
    assertEquals((await stale.json()).rank.rating, 5, "the in-flight response itself is legitimately pre-sync");

    // Within the 60 s TTL: the cache must not hold the pre-sync rank.
    const after = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
    assertEquals(after.status, 200);
    const body = await after.json();
    const rankReads = h.callsTo("/rest/v1/player_rank_state").length;
    assertEquals(
      body.rank.rating,
      7,
      `stale pre-sync rank served from cache after an accepted sync (PostgREST rank reads so far: ${rankReads})`,
    );
  } finally {
    restore();
  }
});

Deno.test("S5: control — without an in-flight build, an accepted shots:sync is followed by a fresh rank read (cache invalidation works in the simple order)", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  const ip = "198.51.100.231";
  setRankTables(h, 5);
  const first = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
  assertEquals((await first.json()).rank.rating, 5);
  await syncAccepted(h, token, ip);
  setRankTables(h, 7);
  const second = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
  assertEquals((await second.json()).rank.rating, 7);
});

Deno.test("S5: same race on GET /v1/progress — the in-flight progress build must not re-populate progress:<user> after the sync's cacheDel", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  const ip = "198.51.100.232";
  await (await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip }))).body?.cancel();

  const day = (count: number) => [
    {
      day: "2026-09-04",
      shot_type: "dink",
      scoring_model_version: "scoring-1",
      shot_count: count,
      avg_score: 6.5,
      best_score: 7,
    },
  ];
  h.tables["progress_daily"] = day(1);
  h.tables["practice_days"] = [{ day: "2026-09-04" }];
  const gate = deferred();
  const intercepted = deferred();
  const restore = interceptFetch(async (req, res) => {
    if (req.method === "GET" && req.url.includes("/rest/v1/practice_days")) {
      intercepted.resolve();
      await gate.promise;
    }
    return res;
  });
  try {
    const inflight = h.handler(userRequest("GET", "/v1/progress", { token, ip }));
    await intercepted.promise;
    await syncAccepted(h, token, ip);
    h.tables["progress_daily"] = day(2);
    gate.resolve();
    assertEquals((await (await inflight).json()).series[0].shot_count, 1);

    const after = await h.handler(userRequest("GET", "/v1/progress", { token, ip }));
    assertEquals(
      (await after.json()).series[0].shot_count,
      2,
      "stale pre-sync progress served from cache after an accepted sync",
    );
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — orphaned saved-drill placeholder id
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S7: GET /v1/me/saved-drills — the placeholder id of a 120-char orphan bookmark must be stable across two calls", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  const ip = "198.51.100.233";
  const slug = "a".repeat(120);
  h.tables["user_saved_drills"] = [{ slug, saved_at: "2026-09-04T00:00:00.000Z" }];
  const put = await h.handler(userRequest("PUT", `/v1/me/saved-drills/${slug}`, { token, ip }));
  assertEquals(put.status, 200);
  await put.body?.cancel();

  const list = async () => {
    const res = await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip }));
    assertEquals(res.status, 200);
    const items = (await res.json()).items as Array<Record<string, unknown>>;
    assertEquals(items.length, 1);
    assertEquals(items[0].slug, slug);
    assertEquals(items[0].title, slug);
    return String(items[0].id);
  };
  const first = await list();
  const second = await list();
  assertEquals(first, second, `placeholder id changed between two GETs: ${first} → ${second}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// S3+ — GOAL_FOCUS prototype lookup
// ─────────────────────────────────────────────────────────────────────────────

/** Echo the PATCH as the saved row so the route reaches its 200 path. */
function echoProfilePatch(): () => void {
  return interceptFetch(async (req, res) => {
    if (req.method === "PATCH" && req.url.includes("/rest/v1/profiles")) {
      const patch = (await req.json()) as Record<string, unknown>;
      return jsonResponse(200, {
        skill_level: patch.skill_level ?? null,
        handedness: patch.handedness ?? null,
        primary_goal: patch.primary_goal ?? null,
        biggest_problem: patch.biggest_problem ?? null,
        focus_checkpoint: patch.focus_checkpoint ?? null,
        first_name: patch.first_name ?? null,
        gender: patch.gender ?? null,
      });
    }
    return res;
  });
}

const ONBOARDING_BASE = {
  handedness: "right",
  skillLevel: "beginner",
  goal: "dinks",
  biggestProblem: "popping up dinks",
};

Deno.test("S3+: goal equal to an Object.prototype method name must still yield a string focus_checkpoint in the PATCH and the response", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const failures: string[] = [];
    for (const goal of ["constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "toLocaleString", "propertyIsEnumerable"]) {
      const res = await h.handler(
        userRequest("PUT", "/v1/me/onboarding", {
          token: fakeGoogleIdToken(freshUser()),
          ip: "198.51.100.234",
          body: { ...ONBOARDING_BASE, goal },
        }),
      );
      assertEquals(res.status, 200, goal);
      const body = await res.json();
      const patch = h.callsTo("/rest/v1/profiles").filter((c) => c.method === "PATCH").at(-1)!.body as Record<string, unknown>;
      if (
        typeof body.recommendedCheckpoint !== "string" ||
        typeof body.plan?.focusCheckpoint !== "string" ||
        typeof patch.focus_checkpoint !== "string"
      ) {
        failures.push(
          `goal=${goal}: recommendedCheckpoint=${JSON.stringify(body.recommendedCheckpoint)} plan=${JSON.stringify(body.plan)} patch.focus_checkpoint=${JSON.stringify(patch.focus_checkpoint)} patch.onboarding_state=${JSON.stringify(patch.onboarding_state)}`,
        );
      }
    }
    assertEquals(failures, [], failures.join("\n"));
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S2+/S3+ — UTF-16 vs character length caps
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S2+: a firstName of exactly 40 characters that contains astral characters must be accepted (message promises '1-40 characters')", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const name = "a".repeat(39) + "😀"; // 40 code points, 41 UTF-16 units
    assertEquals(Array.from(name).length, 40);
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.235",
        body: { ...ONBOARDING_BASE, firstName: name },
      }),
    );
    const text = await res.text();
    assertEquals(res.status, 200, `40-character name rejected: ${text}`);
  } finally {
    restore();
  }
});

Deno.test("S3+: a goal of exactly 64 characters that contains astral characters must be accepted (cap is documented as 64 characters; DB allows 200)", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const goal = "g".repeat(63) + "😀"; // 64 code points, 65 UTF-16 units
    assertEquals(Array.from(goal).length, 64);
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.235",
        body: { ...ONBOARDING_BASE, goal },
      }),
    );
    const text = await res.text();
    assertEquals(res.status, 200, `64-character goal rejected: ${text}`);
    assert(text.includes("contact_position"));
  } finally {
    restore();
  }
});
