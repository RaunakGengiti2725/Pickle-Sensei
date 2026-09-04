/**
 * Adversarial pass #2 (3/3) — edge-domain-routes, against 4d812e1a.
 *
 * Every test drives the real handler from supabase/functions/api/index.ts
 * through attack_edge_domain_routes_2_harness.ts (in-process, fake Supabase
 * Auth + PostgREST + Apple + RevenueCat; nothing touches the network).
 *
 *   deno test -A --no-check --config deno.json attack_edge_domain_routes_2.test.ts
 *
 * Scenarios (assignment numbering):
 *   S1 GET /v1/rank single-flight (coalesce + Response.clone) + build throw
 *   S2 POST /v1/auth/logout with Supabase 404 → 204; cache dropped; Auth re-consulted
 *   S3 finalize: conditional UPDATE matches 0 rows → 409 / idempotent replay, never 404
 *   S4 finalize: outcome 'scored' / 'expired' → 400
 *   S5 reserve: same idempotencyKey twice → same permit id, same access payload
 *   S6 delete-confirm clock edges (2.9 s / 3.0 s / 15 min + 1 s) via Date.now stub
 *   S7 delete-confirm: Apple 200 then RevenueCat 500 → 503 generic; checkpoint via
 *      service role; retry skips Apple and completes
 *   X* extra attacks (unicode/huge inputs, clock skew, permanent Apple 4xx, …)
 */
import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  APPLE_REVOKE_URL,
  RC_URL,
  SERVICE_ROLE_KEY,
  googleIdToken,
  loadAttackHarness,
  sessionToken,
  settleWithin,
  sleep,
  uid,
  userRequest,
  withClock,
} from "./attack_edge_domain_routes_2_harness.ts";

const h = await loadAttackHarness();

const MIN = 60_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const ACCESS_STATE_ONE_RESERVED = [{ premium: false, scored_count: 0, reserved_count: 1 }];
const ACCESS_STATE_EMPTY = [{ premium: false, scored_count: 0, reserved_count: 0 }];

function rankFixtures(userId: string) {
  h.tables.player_technique_rating = [
    {
      user_id: userId,
      shot_type: "dink",
      score: 7.25,
      captured_at: "2026-09-01T10:00:00.000Z",
      sampled_count: 3,
      confidence_weight: 3,
    },
    {
      user_id: userId,
      shot_type: "drive",
      score: 6.5,
      captured_at: "2026-09-01T11:00:00.000Z",
      sampled_count: 2,
      confidence_weight: 2,
    },
  ];
  h.tables.player_rank_state = [
    {
      user_id: userId,
      rating: 6.95,
      tier: "silver",
      technique_count: 2,
      scored_shot_count: 5,
      updated_at: "2026-09-01T11:00:00.000Z",
    },
  ];
}

/** Warm the auth cache for `token` so concurrent requests skip Supabase Auth
 * and hit the route under test simultaneously. */
async function warmAuth(token: string, ip: string): Promise<void> {
  h.rpcs.access_state = ACCESS_STATE_EMPTY;
  const response = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
  assertEquals(response.status, 200, await response.text());
}

// ─────────────────────────────────────────────────────────────────────────────
// S1 — GET /v1/rank single-flight
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S1a rank: two concurrent callers, slow DB → exactly one PostgREST read per table, both bodies complete and independently addressable",
  async () => {
    h.reset();
    const user = uid(101);
    const token = sessionToken(user, "s1a");
    const ip = "198.51.100.11";
    await warmAuth(token, ip);
    rankFixtures(user);
    const userCallsAfterWarm = h.userCalls;

    h.rest = async ({ table }) => {
      if (table === "player_technique_rating" || table === "player_rank_state") await sleep(300);
      return null;
    };

    const [a, b] = await Promise.all([
      settleWithin(
        h.handler(
          userRequest("GET", "/v1/rank", {
            token,
            ip,
            headers: { "x-request-id": "attack-rank-a1" },
          }),
        ),
        5_000,
      ),
      settleWithin(
        h.handler(
          userRequest("GET", "/v1/rank", {
            token,
            ip,
            headers: { "x-request-id": "attack-rank-b2" },
          }),
        ),
        5_000,
      ),
    ]);

    assertEquals(a.status, 200);
    assertEquals(b.status, 200);
    // Response.clone semantics: both bodies readable, identical, complete.
    const bodyA = await a.json();
    const bodyB = await b.json();
    assertEquals(bodyA, bodyB);
    assertEquals(bodyA.rank.rating, 6.95);
    assertEquals(bodyA.rank.tier, "silver");
    assertEquals(bodyA.rank.techniques.length, 2);
    assertEquals(bodyA.rank.techniques[0].shot_type, "dink");
    assertEquals("confidence_weight" in bodyA.rank.techniques[0], false);
    // Each caller keeps its own request id (headers are per clone, not shared).
    assertEquals(a.headers.get("x-request-id"), "attack-rank-a1");
    assertEquals(b.headers.get("x-request-id"), "attack-rank-b2");

    assertEquals(h.restReads("player_technique_rating").length, 1, "coalesced technique read");
    assertEquals(h.restReads("player_rank_state").length, 1, "coalesced state read");
    assertEquals(h.userCalls, userCallsAfterWarm, "auth served from cache for both callers");

    // A follow-up request is served from the 60 s cache: still one read.
    const c = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
    assertEquals(c.status, 200);
    assertEquals(await c.json(), bodyA);
    assertEquals(h.restReads("player_technique_rating").length, 1);
  },
);

Deno.test(
  "S1b rank: the coalesced build throws → both callers settle with a generic 5xx (no hung promise), and the in-flight slot is released for the next caller",
  async () => {
    h.reset();
    const user = uid(102);
    const token = sessionToken(user, "s1b");
    const ip = "198.51.100.12";
    await warmAuth(token, ip);
    rankFixtures(user);

    // Fault: PostgREST answers the technique list with a JSON object. The
    // build's `(data ?? []).map` then throws a TypeError inside coalesce().
    let poison = true;
    h.rest = async ({ table }) => {
      if (table === "player_technique_rating") {
        await sleep(150);
        if (poison) return jsonResponse(200, { unexpected: "object, not a list" });
      }
      return null;
    };

    const [a, b] = await Promise.all([
      settleWithin(h.handler(userRequest("GET", "/v1/rank", { token, ip })), 5_000),
      settleWithin(h.handler(userRequest("GET", "/v1/rank", { token, ip })), 5_000),
    ]);
    assert(a.status >= 500 && a.status < 600, `caller A status ${a.status}`);
    assert(b.status >= 500 && b.status < 600, `caller B status ${b.status}`);
    assertEquals(a.status, b.status, "both callers observe the same failure");
    const textA = await a.text();
    const textB = await b.text();
    assertEquals(textA, textB);
    // Generic body only — no stack, no TypeError text, no table name.
    assertEquals(textA.includes("map"), false, textA);
    assertEquals(textA.includes("player_technique_rating"), false, textA);
    assertEquals(JSON.parse(textA).error.message.length > 0, true);
    assertEquals(h.restReads("player_technique_rating").length, 1, "single read even on failure");
    console.log(`[S1b] thrown build → both callers ${a.status}: ${textA}`);

    // The failed build must not poison the key: the next caller rebuilds.
    poison = false;
    const c = await settleWithin(h.handler(userRequest("GET", "/v1/rank", { token, ip })), 5_000);
    assertEquals(c.status, 200);
    assertEquals((await c.json()).rank.rating, 6.95);
    assertEquals(h.restReads("player_technique_rating").length, 2, "fresh read after failure");
  },
);

Deno.test(
  "S1c rank: 12 rapid concurrent callers with interleaved arrival still trigger exactly one build",
  async () => {
    h.reset();
    const user = uid(103);
    const token = sessionToken(user, "s1c");
    const ip = "198.51.100.13";
    await warmAuth(token, ip);
    rankFixtures(user);
    h.rest = async ({ table }) => {
      if (table === "player_technique_rating" || table === "player_rank_state") await sleep(200);
      return null;
    };
    const requests: Promise<Response>[] = [];
    for (let i = 0; i < 12; i += 1) {
      requests.push(settleWithin(h.handler(userRequest("GET", "/v1/rank", { token, ip })), 5_000));
      if (i % 3 === 2) await sleep(20);
    }
    const responses = await Promise.all(requests);
    const bodies = await Promise.all(responses.map((r) => r.text()));
    assertEquals(new Set(responses.map((r) => r.status)), new Set([200]));
    assertEquals(new Set(bodies).size, 1, "every caller got the same complete body");
    assertEquals(h.restReads("player_technique_rating").length, 1);
    assertEquals(h.restReads("player_rank_state").length, 1);
  },
);

Deno.test(
  "S1d rank: a request whose client disconnects mid-build does not break the surviving caller",
  async () => {
    h.reset();
    const user = uid(104);
    const token = sessionToken(user, "s1d");
    const ip = "198.51.100.14";
    await warmAuth(token, ip);
    rankFixtures(user);
    h.rest = async ({ table }) => {
      if (table === "player_technique_rating") await sleep(250);
      return null;
    };
    const controller = new AbortController();
    const aborted = new Request("http://edge.test/functions/v1/api/v1/rank", {
      headers: { Authorization: `Bearer ${token}`, "x-forwarded-for": ip },
      signal: controller.signal,
    });
    const first = settleWithin(h.handler(aborted), 5_000);
    await sleep(30);
    controller.abort();
    const second = settleWithin(h.handler(userRequest("GET", "/v1/rank", { token, ip })), 5_000);
    const [a, b] = await Promise.allSettled([first, second]);
    assertEquals(b.status, "fulfilled");
    if (b.status === "fulfilled") {
      assertEquals(b.value.status, 200);
      assertEquals((await b.value.json()).rank.rating, 6.95);
    }
    // The aborted caller either got the shared response or rejected; it must
    // not have hung.
    assert(a.status === "fulfilled" || a.status === "rejected");
    assertEquals(h.restReads("player_technique_rating").length, 1);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S2 — logout with an already-revoked session
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S2a logout: Supabase answers 404 (already revoked) → 204; the bearer's auth cache entry is dropped and the next call consults Supabase Auth again (session token)",
  async () => {
    h.reset();
    const user = uid(201);
    const token = sessionToken(user, "s2a");
    const ip = "198.51.100.21";

    h.rpcs.access_state = ACCESS_STATE_EMPTY;
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token, ip }))).status, 200);
    assertEquals(h.userCalls, 1);
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token, ip }))).status, 200);
    assertEquals(h.userCalls, 1, "second call served from the auth cache");

    h.logoutStatus = 404;
    const logout = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
    assertEquals(logout.status, 204);
    assertEquals(h.logoutCalls, 1);
    const logoutCall = h.callsTo("/auth/v1/logout")[0];
    assertStringIncludes(logoutCall.url, "scope=local");
    assertEquals(logoutCall.headers.authorization, `Bearer ${token}`);

    // Supabase really has revoked it: the fake now answers getUser with 401.
    h.revokedSessions.add(token);
    const after = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(h.userCalls, 2, "Supabase Auth consulted again → cache entry was dropped");
    assertEquals(after.status, 401);
    assertEquals(h.userCalls, 2);

    // Rapid repeat logout with the dead bearer: 401 from authenticate (the
    // route requires a valid bearer), never a 5xx.
    const again = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
    assertEquals(again.status, 401);
    assertEquals(h.logoutCalls, 1);
  },
);

Deno.test(
  "S2b logout (transitional provider-token bearer): 404 → 204, cache dropped, tokenCalls increments; DOCUMENTS that the bearer sent to /auth/v1/logout is the Google ID token, not the Supabase session minted for it",
  async () => {
    h.reset();
    const user = uid(202);
    const token = googleIdToken(user);
    const ip = "198.51.100.22";

    h.rpcs.access_state = ACCESS_STATE_EMPTY;
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token, ip }))).status, 200);
    assertEquals(h.tokenCalls, 1);
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token, ip }))).status, 200);
    assertEquals(h.tokenCalls, 1, "cached");

    h.logoutStatus = 404;
    const logout = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
    assertEquals(logout.status, 204);
    assertEquals(h.tokenCalls, 1, "logout itself served from the cache");
    const logoutCall = h.callsTo("/auth/v1/logout")[0];
    assertEquals(
      logoutCall.headers.authorization,
      `Bearer ${token}`,
      "logout forwards the raw bearer (provider ID token) — the Supabase session " +
        `'session-for-${user}' minted by signInWithIdToken is never named to /logout`,
    );
    assertNotEquals(logoutCall.headers.authorization, `Bearer session-for-${user}`);

    const after = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(after.status, 200);
    assertEquals(h.tokenCalls, 2, "Supabase Auth consulted again → cache entry was dropped");
  },
);

Deno.test(
  "S2c logout: Supabase 500 → 503 generic, but the cache entry is still dropped first (fail-safe)",
  async () => {
    h.reset();
    const user = uid(203);
    const token = sessionToken(user, "s2c");
    const ip = "198.51.100.23";
    h.rpcs.access_state = ACCESS_STATE_EMPTY;
    assertEquals((await h.handler(userRequest("GET", "/v1/me/access", { token, ip }))).status, 200);
    assertEquals(h.userCalls, 1);

    h.logoutStatus = 500;
    const logout = await h.handler(userRequest("POST", "/v1/auth/logout", { token, ip }));
    assertEquals(logout.status, 503);
    const body = await logout.json();
    assertEquals(body, {
      error: { message: "Sign-out is temporarily unavailable. Please try again." },
    });

    const after = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(after.status, 200);
    assertEquals(h.userCalls, 2, "cache dropped even though upstream logout failed");
  },
);

Deno.test("S2d logout without a bearer → 401 and no upstream call", async () => {
  h.reset();
  const response = await h.handler(userRequest("POST", "/v1/auth/logout", { ip: "198.51.100.24" }));
  assertEquals(response.status, 401);
  assertEquals(h.logoutCalls, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// S3 — finalize: conditional UPDATE matched 0 rows
// ─────────────────────────────────────────────────────────────────────────────

const PERMIT_A = "0f0f0f0f-1111-4222-8333-444444444401";

function permitFixture(userId: string, overrides: Record<string, unknown> = {}) {
  h.tables.analysis_permits = [
    {
      id: PERMIT_A,
      user_id: userId,
      status: "reserved",
      outcome: null,
      created_at: "2026-09-04T10:00:00.000Z",
      ...overrides,
    },
  ];
}

function finalize(token: string, ip: string, outcome: unknown, permitId = PERMIT_A) {
  return h.handler(
    userRequest("POST", `/v1/analysis-permits/${permitId}/finalize`, {
      token,
      ip,
      body: { outcome, ratingId: null },
    }),
  );
}

Deno.test(
  "S3a finalize: SELECT sees 'reserved', UPDATE…status=eq.reserved matches 0 rows (lost race), settled row is finalized with a DIFFERENT outcome → 409 access.permit_already_finalized (not 404)",
  async () => {
    h.reset();
    const user = uid(301);
    const token = sessionToken(user, "s3a");
    const ip = "198.51.100.31";
    permitFixture(user);
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;

    let patches = 0;
    h.rest = ({ table, method }) => {
      if (table === "analysis_permits" && method === "PATCH") {
        patches += 1;
        // Someone else finalized between our SELECT and UPDATE.
        for (const row of h.tables.analysis_permits) {
          row.status = "finalized";
          row.outcome = "cancelled";
        }
        return jsonResponse(200, []);
      }
      return null;
    };

    const response = await finalize(token, ip, "failed");
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.error.code, "access.permit_already_finalized");
    assertStringIncludes(body.error.message, "cancelled");
    assertEquals(patches, 1);
    const patch = h.restWrites("analysis_permits")[0];
    assertStringIncludes(patch.url, "status=eq.reserved");
    assertStringIncludes(patch.url, `user_id=eq.${user}`);
    assertEquals(h.restReads("analysis_permits").length, 2, "initial read + settled re-read");
  },
);

Deno.test(
  "S3b finalize: UPDATE matches 0 rows but the settled row carries the SAME outcome → 200 idempotent replay with the settled permit",
  async () => {
    h.reset();
    const user = uid(302);
    const token = sessionToken(user, "s3b");
    const ip = "198.51.100.32";
    permitFixture(user);
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;
    h.rest = ({ table, method }) => {
      if (table === "analysis_permits" && method === "PATCH") {
        for (const row of h.tables.analysis_permits) {
          row.status = "finalized";
          row.outcome = "cancelled";
        }
        return jsonResponse(200, []);
      }
      return null;
    };
    const response = await finalize(token, ip, "cancelled");
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.permit.id, PERMIT_A);
    assertEquals(body.permit.status, "finalized");
    assertEquals(body.permit.outcome, "cancelled");
    assertEquals(body.access.freeRatings.availableToReserve, 1);
  },
);

Deno.test(
  "S3c finalize: owner row already status='finalized' at first read → same outcome 200 replay, different outcome 409; the UPDATE is never attempted",
  async () => {
    h.reset();
    const user = uid(303);
    const token = sessionToken(user, "s3c");
    const ip = "198.51.100.33";
    permitFixture(user, { status: "finalized", outcome: "low_confidence" });
    h.rpcs.access_state = ACCESS_STATE_EMPTY;

    const replay = await finalize(token, ip, "low_confidence");
    assertEquals(replay.status, 200);
    assertEquals((await replay.json()).permit.outcome, "low_confidence");

    const conflict = await finalize(token, ip, "failed");
    assertEquals(conflict.status, 409);
    const body = await conflict.json();
    assertEquals(body.error.code, "access.permit_already_finalized");
    assertStringIncludes(body.error.message, "low_confidence");
    assertEquals(h.restWrites("analysis_permits").length, 0);
  },
);

Deno.test(
  "S3d finalize: UPDATE matches 0 rows AND the settled re-read finds nothing (row swept) → 409 'unknown', never 404/500",
  async () => {
    h.reset();
    const user = uid(304);
    const token = sessionToken(user, "s3d");
    const ip = "198.51.100.34";
    permitFixture(user);
    h.rpcs.access_state = ACCESS_STATE_EMPTY;
    h.rest = ({ table, method }) => {
      if (table === "analysis_permits" && method === "PATCH") {
        h.tables.analysis_permits = [];
        return jsonResponse(200, []);
      }
      return null;
    };
    const response = await finalize(token, ip, "failed");
    assertEquals(response.status, 409);
    const body = await response.json();
    assertEquals(body.error.code, "access.permit_already_finalized");
    assertStringIncludes(body.error.message, "unknown");
  },
);

Deno.test(
  "S3e finalize: permit owned by ANOTHER user (RLS-empty read) → 404, and a row status 'expired' → 409 naming 'expired'",
  async () => {
    h.reset();
    const user = uid(305);
    const token = sessionToken(user, "s3e");
    const ip = "198.51.100.35";
    permitFixture(uid(999));
    h.rpcs.access_state = ACCESS_STATE_EMPTY;
    const foreign = await finalize(token, ip, "failed");
    assertEquals(foreign.status, 404);
    assertEquals((await foreign.json()).error.code, "access.permit_not_found");

    permitFixture(user, { status: "expired", outcome: null });
    const expired = await finalize(token, ip, "failed");
    assertEquals(expired.status, 409);
    assertStringIncludes((await expired.json()).error.message, "expired");
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S4 — finalize refuses 'scored' and 'expired'
// ─────────────────────────────────────────────────────────────────────────────

Deno.test(
  "S4 finalize: outcome 'scored' → 400, outcome 'expired' → 400; no PostgREST traffic for either",
  async () => {
    h.reset();
    const user = uid(401);
    const token = sessionToken(user, "s4");
    const ip = "198.51.100.41";
    permitFixture(user);
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;
    await warmAuth(token, ip);
    const restBefore = h.calls.filter((c) => c.url.includes("/rest/v1/")).length;

    for (const outcome of ["scored", "expired"]) {
      const response = await finalize(token, ip, outcome);
      assertEquals(response.status, 400, outcome);
      const body = await response.json();
      assertEquals(body.error.code, "validation.analysis_permit_finalize");
      assertStringIncludes(body.error.message, "shots:sync");
    }
    assertEquals(
      h.calls.filter((c) => c.url.includes("/rest/v1/")).length,
      restBefore,
      "rejected before any DB call",
    );
    assertEquals(h.tables.analysis_permits[0].status, "reserved", "permit untouched");
  },
);

Deno.test(
  "X4 finalize: look-alike outcomes (case, unicode zero-width, trailing space, array, 1 MiB string) all → 400 without touching the DB; malformed/escaped permit ids → 400",
  async () => {
    h.reset();
    const user = uid(402);
    const token = sessionToken(user, "x4");
    const ip = "198.51.100.42";
    permitFixture(user);
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;
    await warmAuth(token, ip);
    const restBefore = h.calls.filter((c) => c.url.includes("/rest/v1/")).length;

    const lookalikes: unknown[] = [
      "CANCELLED",
      "cancelled\u200b",
      "cancelled ",
      "cancel\u0301led",
      ["cancelled"],
      { outcome: "cancelled" },
      "x".repeat(1024 * 1024),
      null,
      42,
    ];
    for (const outcome of lookalikes) {
      const response = await finalize(token, ip, outcome);
      assertEquals(response.status, 400, JSON.stringify(outcome).slice(0, 40));
    }
    // ratingId must be null for a released outcome.
    const withRating = await h.handler(
      userRequest("POST", `/v1/analysis-permits/${PERMIT_A}/finalize`, {
        token,
        ip,
        body: { outcome: "cancelled", ratingId: "11111111-1111-4111-8111-111111111111" },
      }),
    );
    assertEquals(withRating.status, 400);

    for (const permitId of [
      "not-a-uuid",
      `${PERMIT_A}%00`,
      "%E0%A4%A",
      `${PERMIT_A.toUpperCase()}x`,
      "..%2F..%2Fadmin",
    ]) {
      const response = await finalize(token, ip, "cancelled", permitId);
      assertEquals(response.status, 400, permitId);
    }
    assertEquals(h.calls.filter((c) => c.url.includes("/rest/v1/")).length, restBefore);

    // Upper-case UUID is a valid UUID and reaches the DB path (PostgREST
    // compares uuid semantically); here the fake matches by string so the
    // read returns no row → 404 rather than a 5xx.
    const upper = await finalize(token, ip, "cancelled", PERMIT_A.toUpperCase());
    assert([200, 404].includes(upper.status), String(upper.status));
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S5 — reserve: same idempotencyKey twice
// ─────────────────────────────────────────────────────────────────────────────

const PERMIT_B = "0f0f0f0f-2222-4222-8333-444444444402";

Deno.test(
  "S5 reserve: reserve_analysis_permit answers 'accepted' with the same permit twice for one idempotencyKey → both 200 echo the same permit id and the identical access payload (availableToReserve not decremented twice)",
  async () => {
    h.reset();
    const user = uid(501);
    const token = sessionToken(user, "s5");
    const ip = "198.51.100.51";
    const keysSeen: unknown[] = [];
    h.rpcs.reserve_analysis_permit = (input: unknown) => {
      keysSeen.push((input as Record<string, unknown>).p_idempotency_key);
      return [
        {
          result: "accepted",
          permit_id: PERMIT_B,
          permit_status: "reserved",
          permit_outcome: null,
          permit_created_at: "2026-09-04T10:00:00.000Z",
        },
      ];
    };
    // The DB reports ONE reserved permit both times (the RPC is idempotent).
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;

    const reserve = () =>
      h.handler(
        userRequest("POST", "/v1/analysis-permits", {
          token,
          ip,
          body: { idempotencyKey: "capture-2026-09-04-00042" },
        }),
      );
    const first = await reserve();
    const second = await reserve();
    assertEquals(first.status, 200);
    assertEquals(second.status, 200);
    const a = await first.json();
    const b = await second.json();
    assertEquals(a.permit.id, PERMIT_B);
    assertEquals(b.permit.id, a.permit.id);
    assertEquals(a.permit.status, "reserved");
    assertEquals(a.access.freeRatings, {
      limit: 2,
      used: 0,
      reserved: 1,
      remaining: 2,
      availableToReserve: 1,
    });
    assertEquals(b.access.freeRatings, a.access.freeRatings);
    assertEquals(b.access.canStartRating, true);
    assertEquals(keysSeen, ["capture-2026-09-04-00042", "capture-2026-09-04-00042"]);
    assertEquals(typeof a.permit.expiresAt, "string");

    // Rapid-fire: 6 concurrent replays of the same key collapse to the same id.
    const burst = await Promise.all(Array.from({ length: 6 }, reserve));
    const ids = new Set(await Promise.all(burst.map(async (r) => (await r.json()).permit.id)));
    assertEquals(ids, new Set([PERMIT_B]));
    assertEquals(keysSeen.length, 8, "every call reaches the atomic RPC (no client-side dedupe)");
  },
);

Deno.test(
  "X5 reserve: idempotencyKey validation edges — 128 chars accepted verbatim (unicode too), 129 → 400, whitespace-only → 400, non-string → 400, paywall verdict → 402, unknown RPC verdict → 503 generic",
  async () => {
    h.reset();
    const user = uid(502);
    const token = sessionToken(user, "x5");
    const ip = "198.51.100.52";
    const keysSeen: unknown[] = [];
    let verdict = "accepted";
    h.rpcs.reserve_analysis_permit = (input: unknown) => {
      keysSeen.push((input as Record<string, unknown>).p_idempotency_key);
      return [
        {
          result: verdict,
          permit_id: verdict === "accepted" ? PERMIT_B : null,
          permit_status: verdict === "accepted" ? "reserved" : null,
          permit_outcome: null,
          permit_created_at: verdict === "accepted" ? "2026-09-04T10:00:00.000Z" : null,
        },
      ];
    };
    h.rpcs.access_state = ACCESS_STATE_ONE_RESERVED;
    const reserve = (idempotencyKey: unknown) =>
      h.handler(
        userRequest("POST", "/v1/analysis-permits", { token, ip, body: { idempotencyKey } }),
      );

    const unicodeKey = "🥒".repeat(64); // 128 UTF-16 code units
    assertEquals(unicodeKey.length, 128);
    assertEquals((await reserve(unicodeKey)).status, 200);
    assertEquals(keysSeen.at(-1), unicodeKey);
    assertEquals((await reserve("k".repeat(128))).status, 200);
    assertEquals((await reserve("k".repeat(129))).status, 400);
    assertEquals((await reserve("   ")).status, 400);
    assertEquals((await reserve(12345)).status, 400);
    assertEquals((await reserve(undefined)).status, 400);
    assertEquals(keysSeen.length, 2);

    verdict = "access.paywall_required";
    const paywall = await reserve("k-paywall");
    assertEquals(paywall.status, 402);
    assertEquals((await paywall.json()).error.code, "access.paywall_required");

    verdict = "something_new_from_a_future_migration";
    const unknown = await reserve("k-unknown");
    assertEquals(unknown.status, 503);
    const text = await unknown.text();
    assertEquals(text.includes("something_new"), false, text);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S6 — delete-confirm clock edges via Date.now stub
// ─────────────────────────────────────────────────────────────────────────────

function deletionFixture(userId: string, challenge: string, createdMs: number, ttlMs = 15 * MIN) {
  h.tables.account_deletion_requests = [
    {
      user_id: userId,
      challenge,
      created_at: iso(createdMs),
      expires_at: iso(createdMs + ttlMs),
    },
  ];
  h.tables.account_external_credentials = [];
}

const confirm = (token: string, ip: string, challenge: unknown) =>
  h.handler(userRequest("POST", "/v1/me/delete-confirm", { token, ip, body: { challenge } }));

Deno.test(
  "S6a delete-confirm: challenge created 2.9 s ago → 429 account.deletion_too_fast (no external calls); at exactly 3.0 s → proceeds and deletes",
  async () => {
    h.reset();
    const user = uid(601);
    const token = sessionToken(user, "s6a");
    const ip = "198.51.100.61";
    const challenge = "66666666-6666-4666-8666-666666666601";
    const T = Date.now();
    deletionFixture(user, challenge, T - 2_900);

    const tooFast = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(tooFast.status, 429);
    assertEquals((await tooFast.json()).error.code, "account.deletion_too_fast");
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);

    const proceeds = await withClock(T + 100, () => confirm(token, ip, challenge));
    assertEquals(proceeds.status, 200, await proceeds.clone().text());
    assertEquals(await proceeds.json(), {
      deleted: true,
      appleAuthorizationRevocation: "not_applicable",
    });
    assertEquals(
      h.calls.filter((c) => c.url.startsWith(RC_URL) && c.method === "DELETE").length,
      1,
    );
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "S6b delete-confirm: challenge at 15 min + 1 s → 403 account.deletion_challenge_expired; at exactly expires_at → 403; 1 ms before expiry → proceeds",
  async () => {
    h.reset();
    const user = uid(602);
    const token = sessionToken(user, "s6b");
    const ip = "198.51.100.62";
    const challenge = "66666666-6666-4666-8666-666666666602";
    const T = Date.now();

    deletionFixture(user, challenge, T - 15 * MIN - 1_000);
    const expired = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(expired.status, 403);
    assertEquals((await expired.json()).error.code, "account.deletion_challenge_expired");

    deletionFixture(user, challenge, T - 15 * MIN);
    const boundary = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(boundary.status, 403, "expires_at <= now is expired");
    assertEquals((await boundary.json()).error.code, "account.deletion_challenge_expired");
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);

    deletionFixture(user, challenge, T - 15 * MIN + 1);
    const alive = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(alive.status, 200, await alive.clone().text());
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "X6 delete-confirm: clock skew (created_at in the future) → 429 not deletion; mismatched/upper-cased/foreign challenge → 403 invalid; non-UUID → 400; nothing external is called",
  async () => {
    h.reset();
    const user = uid(603);
    const token = sessionToken(user, "x6");
    const ip = "198.51.100.63";
    const challenge = "6666abcd-6666-4666-8666-66666666ab03";
    assertNotEquals(challenge.toUpperCase(), challenge);
    const T = Date.now();

    deletionFixture(user, challenge, T + 60_000);
    const skewed = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(skewed.status, 429);

    deletionFixture(user, challenge, T - 10_000);
    const upper = await withClock(T, () => confirm(token, ip, challenge.toUpperCase()));
    assertEquals(upper.status, 403);
    assertEquals((await upper.json()).error.code, "account.deletion_challenge_invalid");
    const foreign = await withClock(T, () =>
      confirm(token, ip, "66666666-6666-4666-8666-666666666699"),
    );
    assertEquals(foreign.status, 403);

    // Malformed bodies: a second user, because delete-confirm's per-user
    // budget is 5/hour and (correctly) counts rejected attempts too.
    const user2 = uid(604);
    const token2 = sessionToken(user2, "x6b");
    deletionFixture(user2, challenge, T - 10_000);
    const bads: unknown[] = ["", "x", 42, null, { challenge }];
    for (const bad of bads) {
      const response = await withClock(T, () => confirm(token2, ip, bad));
      assertEquals(response.status, 400, JSON.stringify(bad));
    }
    // 6th attempt inside the hour → the delete_confirm budget (5/h) trips.
    const throttled = await withClock(T, () => confirm(token2, ip, `${challenge}\u200b`));
    assertEquals(throttled.status, 429);
    assert(throttled.headers.get("retry-after"), "Retry-After present on the budget 429");
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// S7 — delete-confirm: Apple 200 then RevenueCat 500
// ─────────────────────────────────────────────────────────────────────────────

async function appleDeletionFixture(userId: string, challenge: string, T: number) {
  h.tables.account_deletion_requests = [
    {
      user_id: userId,
      challenge,
      created_at: iso(T - 10_000),
      expires_at: iso(T + 14 * MIN),
    },
  ];
  h.tables.account_external_credentials = [
    {
      user_id: userId,
      apple_refresh_token_encrypted: await encryptAppleRefreshToken(
        "refresh-to-revoke",
        userId,
        h.appleTokenEncryptionKey,
      ),
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
}

const rcDeletes = () => h.calls.filter((c) => c.url.startsWith(RC_URL) && c.method === "DELETE");

Deno.test(
  "S7 delete-confirm: Apple revoke 200, RevenueCat DELETE 500 → 503 generic body; Apple checkpoint written via service role; retry after RevenueCat recovers skips Apple and completes",
  async () => {
    h.reset();
    const user = uid(701);
    const token = sessionToken(user, "s7");
    h.sessionProviders.set(token, "apple");
    const ip = "198.51.100.71";
    const challenge = "77777777-7777-4777-8777-777777777701";
    const T = Date.now();
    await appleDeletionFixture(user, challenge, T);

    h.revenueCatDeleteStatus = 500;
    const failed = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(failed.status, 503);
    const failedText = await failed.text();
    assertEquals(JSON.parse(failedText), {
      error: { message: "Account deletion is temporarily unavailable. Please try again." },
    });
    assertEquals(failedText.includes("RevenueCat"), false, failedText);
    assertEquals(failedText.includes("500"), false, failedText);

    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 1);
    assertEquals(rcDeletes().length, 1);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0, "Supabase user NOT deleted");

    const checkpoint = h.restWrites("account_external_credentials");
    assertEquals(checkpoint.length, 1, "exactly the Apple checkpoint was written");
    assertEquals(checkpoint[0].method, "PATCH");
    assertStringIncludes(checkpoint[0].url, `user_id=eq.${user}`);
    const patchBody = checkpoint[0].body as Record<string, unknown>;
    assertEquals(typeof patchBody.apple_revoked_at, "string");
    assertEquals("revenuecat_deleted_at" in patchBody, false);
    assertEquals(checkpoint[0].headers.apikey, SERVICE_ROLE_KEY, "service role apikey");
    assertEquals(
      checkpoint[0].headers.authorization,
      `Bearer ${SERVICE_ROLE_KEY}`,
      "service role bearer",
    );
    assertEquals(
      typeof h.tables.account_external_credentials[0].apple_revoked_at,
      "string",
      "checkpoint persisted in the row",
    );
    // The user-scoped client must never have touched the server-owned row.
    for (const call of h.calls.filter((c) => c.url.includes("account_external_credentials"))) {
      assertEquals(call.headers.apikey, SERVICE_ROLE_KEY);
    }

    // RevenueCat recovers; the app retries the SAME challenge.
    h.revenueCatDeleteStatus = 200;
    const retry = await withClock(T + 1_000, () => confirm(token, ip, challenge));
    assertEquals(retry.status, 200, await retry.clone().text());
    assertEquals(await retry.json(), { deleted: true, appleAuthorizationRevocation: "revoked" });
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 1, "Apple NOT called again");
    assertEquals(rcDeletes().length, 2);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
    const rcCheckpoint = h.restWrites("account_external_credentials").at(-1)!;
    assertEquals(rcCheckpoint.method, "POST");
    assertStringIncludes(rcCheckpoint.headers.prefer ?? "", "merge-duplicates");
    assertEquals(
      typeof (rcCheckpoint.body as Record<string, unknown>).revenuecat_deleted_at,
      "string",
    );
    assertEquals(rcCheckpoint.headers.apikey, SERVICE_ROLE_KEY);

    // The deleting bearer's cache entry is gone: the next call re-consults Auth.
    const userCalls = h.userCalls;
    h.revokedSessions.add(token);
    const after = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(h.userCalls, userCalls + 1);
    assertEquals(after.status, 401);
  },
);

Deno.test(
  "X7a delete-confirm: Supabase admin deleteUser 500 AFTER both externals succeeded → 503; retry skips Apple AND RevenueCat (both checkpointed) and only repeats the admin delete",
  async () => {
    h.reset();
    const user = uid(702);
    const token = sessionToken(user, "x7a");
    h.sessionProviders.set(token, "apple");
    const ip = "198.51.100.72";
    const challenge = "77777777-7777-4777-8777-777777777702";
    const T = Date.now();
    await appleDeletionFixture(user, challenge, T);

    h.adminDeleteStatus = 500;
    const failed = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(failed.status, 503);
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 1);
    assertEquals(rcDeletes().length, 1);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);

    h.adminDeleteStatus = 200;
    const retry = await withClock(T + 500, () => confirm(token, ip, challenge));
    assertEquals(retry.status, 200, await retry.clone().text());
    assertEquals(await retry.json(), { deleted: true, appleAuthorizationRevocation: "revoked" });
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 1);
    assertEquals(rcDeletes().length, 1);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 2);
  },
);

Deno.test(
  "X7b delete-confirm: two confirms racing while RevenueCat is down → both 503, Apple revoked (idempotent upstream), no Supabase delete; a single retry then completes",
  async () => {
    h.reset();
    const user = uid(703);
    const token = sessionToken(user, "x7b");
    h.sessionProviders.set(token, "apple");
    const ip = "198.51.100.73";
    const challenge = "77777777-7777-4777-8777-777777777703";
    const T = Date.now();
    await appleDeletionFixture(user, challenge, T);
    await withClock(T, () => warmAuth(token, ip));

    h.revenueCatDeleteStatus = 500;
    const [a, b] = await withClock(T, () =>
      Promise.all([
        settleWithin(confirm(token, ip, challenge), 5_000),
        settleWithin(confirm(token, ip, challenge), 5_000),
      ]),
    );
    assertEquals([a.status, b.status], [503, 503]);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
    assert(h.callsTo(APPLE_REVOKE_URL).length >= 1);

    h.revenueCatDeleteStatus = 200;
    const retry = await withClock(T + 1_000, () => confirm(token, ip, challenge));
    assertEquals(retry.status, 200, await retry.clone().text());
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "X7c delete-confirm: Apple revoke answers 400 invalid_grant PERSISTENTLY (stored token dead / client secret rejected) → every confirm is 503; no checkpoint, no RevenueCat, no Supabase delete — the account cannot be deleted through the app",
  async () => {
    h.reset();
    const user = uid(704);
    const token = sessionToken(user, "x7c");
    h.sessionProviders.set(token, "apple");
    const ip = "198.51.100.74";
    const challenge = "77777777-7777-4777-8777-777777777704";
    const T = Date.now();
    await appleDeletionFixture(user, challenge, T);

    h.appleRevokeStatus = 400;
    h.appleRevokeBody = { error: "invalid_grant" };
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await withClock(T + attempt * 1_000, () => confirm(token, ip, challenge));
      statuses.push(response.status);
      const text = await response.text();
      assertEquals(text.includes("invalid_grant"), false, text);
    }
    assertEquals(statuses, [503, 503, 503]);
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 3);
    assertEquals(rcDeletes().length, 0);
    assertEquals(h.restWrites("account_external_credentials").length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
    console.log(
      "[X7c] persistent Apple 4xx on revoke → deletion permanently 503 for this account " +
        "(no manual_action_required fallback once a token is stored)",
    );
  },
);

Deno.test(
  "X7d delete-confirm: corrupt stored Apple ciphertext (wrong AAD / truncated) → 503 generic, nothing external called, row untouched",
  async () => {
    h.reset();
    const user = uid(705);
    const token = sessionToken(user, "x7d");
    h.sessionProviders.set(token, "apple");
    const ip = "198.51.100.75";
    const challenge = "77777777-7777-4777-8777-777777777705";
    const T = Date.now();
    await appleDeletionFixture(user, challenge, T);
    // Ciphertext encrypted for a DIFFERENT user id (moved between rows).
    h.tables.account_external_credentials[0].apple_refresh_token_encrypted =
      await encryptAppleRefreshToken("refresh-to-revoke", uid(999), h.appleTokenEncryptionKey);

    const moved = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(moved.status, 503);
    const text = await moved.text();
    assertEquals(text.includes("decrypt"), false, text);
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 0);
    assertEquals(rcDeletes().length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);

    h.tables.account_external_credentials[0].apple_refresh_token_encrypted = "v1.garbage";
    const truncated = await withClock(T, () => confirm(token, ip, challenge));
    assertEquals(truncated.status, 503);
    assertEquals(h.callsTo(APPLE_REVOKE_URL).length, 0);
  },
);
