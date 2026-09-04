// Adversarial pass 3 — edge domain routes (HELD scenarios). Every request goes
// through the REAL handler via routesHarness (auth → rate limits → routing);
// PostgREST/Auth are stubbed at the fetch layer. Each test uses a FRESH user
// id so per-user rate-limit windows never bleed across tests or files.
//
// Scenarios (assignment "ADVERSARIAL TESTER #3", target 4d812e1a):
//   S1 POST /v1/me/delete-request survey: platform 'web', reason outside the
//      vocabulary, 5 000-char free text → challenge still minted; survey row
//      nulls invalid enums; free text capped + sanitized.
//   S2 PUT /v1/me/onboarding firstName of only ZWJ/bidi → 400, no PATCH;
//      gender 'Female' → 400, no PATCH.
//   S3 PUT /v1/me/onboarding goal not in GOAL_FOCUS → contact_position echoed;
//      goal 64 chars → 200, 65 chars → 400.
//   S6 Rate-limit budgets: 31st shots:sync, 13th trials, 4th delete-request,
//      6th delete-confirm → 429 + Retry-After; other user on same IP unaffected.
//   S7 Saved drills: 120-char slug → 200, 121 → 400, '..%2F..' → 400.
//
// The expected-to-FAIL attacks (S5 cache race, S7 placeholder-id stability)
// live in attack3_edge_domain_routes_expected_failures.attack.ts so that
// `deno task test` stays green while the defects are still reproducible.
//
// Run: deno test -A --no-check --config deno.json attack3_edge_domain_routes.test.ts

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { fakeGoogleIdToken, loadHarness, userRequest, type Harness } from "./routesHarness.ts";

const freshUser = (): string => crypto.randomUUID();

/** Layer a response rewriter on top of the harness fetch (the harness still
 * records every call). Restored by the returned function. */
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

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const CONTROL_OR_SPOOFING =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;

// ─────────────────────────────────────────────────────────────────────────────
// S1 — delete-request exit survey
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S1: delete-request with an out-of-vocabulary reason still mints the challenge (survey dropped, deletion never blocked)", async () => {
  const h = await loadHarness();
  const user = freshUser();
  const details = "x".repeat(5_000);
  const res = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: fakeGoogleIdToken(user),
      ip: "198.51.100.201",
      body: {
        survey: { reason: "moved_to_competitor", wanted: "everything", platform: "web", details },
      },
    }),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertMatch(String(body.challenge), /^[0-9a-f-]{36}$/);
  assert(Date.parse(String(body.expiresAt)) > Date.now());
  const minted = h.callsTo("/rest/v1/account_deletion_requests");
  assertEquals(minted.length, 1);
  assertEquals((minted[0].body as Record<string, unknown>).user_id, user);
  // Documented contract (index.ts DELETION_SURVEY_* comment): an unknown
  // reason drops the WHOLE survey — the DB column `reason` is NOT NULL so a
  // row with a nulled reason cannot exist. Nothing is written.
  assertEquals(h.callsTo("/rest/v1/account_deletion_feedback").length, 0);
});

Deno.test("S1: valid reason + platform 'web' + unknown wanted + 5 000-char details → row nulls the invalid enums, details capped at 500 code points and sanitized", async () => {
  const h = await loadHarness();
  const user = freshUser();
  // 5 000 chars laced with control, zero-width, bidi, lone surrogate and
  // multi-codepoint emoji so the code-point cap (not UTF-16) is exercised.
  const seed = "A\u0000B\u200bC\u202eD\u2066E\ud800F  G\t\nH😀I";
  const details = seed.repeat(Math.ceil(5_000 / seed.length)).slice(0, 5_000);
  assertEquals(details.length, 5_000);
  const res = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: fakeGoogleIdToken(user),
      ip: "198.51.100.202",
      body: {
        survey: {
          reason: "other",
          wanted: "everything",
          platform: "web",
          appVersion: "\u202e" + "9".repeat(200),
          details,
        },
      },
    }),
  );
  assertEquals(res.status, 200);
  assertMatch(String((await res.json()).challenge), /^[0-9a-f-]{36}$/);
  const inserts = h.callsTo("/rest/v1/account_deletion_feedback");
  assertEquals(inserts.length, 1);
  const row = inserts[0].body as Record<string, unknown>;
  assertEquals(row.user_id, user);
  assertEquals(row.reason, "other");
  assertEquals(row.wanted, null, "unknown wanted must be nulled");
  assertEquals(row.platform, null, "platform 'web' is outside ios|android and must be nulled");
  assertEquals(row.provider, "google");
  const stored = String(row.details);
  assert(Array.from(stored).length <= 500, `details must be ≤500 code points, got ${Array.from(stored).length}`);
  assert(!CONTROL_OR_SPOOFING.test(stored), "control/zero-width/bidi chars must be stripped");
  assert(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(stored), "lone surrogates must be stripped");
  assert(!/\s\s/.test(stored), "whitespace runs must collapse");
  assert(stored.includes("😀"), "well-formed astral characters survive");
  assertEquals(Array.from(String(row.app_version)).length, 64);
  assert(!CONTROL_OR_SPOOFING.test(String(row.app_version)));
  // Survey write happened strictly AFTER the challenge upsert.
  const order = h.calls.map((c) => c.url);
  assert(
    order.findIndex((u) => u.includes("account_deletion_requests")) <
      order.findIndex((u) => u.includes("account_deletion_feedback")),
  );
});

Deno.test("S1: survey write failure (RLS/constraint 4xx from PostgREST) never turns the delete-request into an error", async () => {
  const h = await loadHarness();
  const user = freshUser();
  const restore = interceptFetch((req, res) =>
    req.url.includes("/rest/v1/account_deletion_feedback")
      ? jsonResponse(403, { code: "42501", message: "permission denied" })
      : res,
  );
  try {
    const res = await h.handler(
      userRequest("POST", "/v1/me/delete-request", {
        token: fakeGoogleIdToken(user),
        ip: "198.51.100.203",
        body: { survey: { reason: "privacy", details: "bye" } },
      }),
    );
    assertEquals(res.status, 200);
    assertMatch(String((await res.json()).challenge), /^[0-9a-f-]{36}$/);
  } finally {
    restore();
  }
});

Deno.test("S1: survey that is not an object / reason of wrong type is ignored without a 4xx", async () => {
  const h = await loadHarness();
  for (const survey of [null, "string", 42, [], { reason: 7 }, { reason: ["other"] }]) {
    const res = await h.handler(
      userRequest("POST", "/v1/me/delete-request", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.204",
        body: { survey },
      }),
    );
    assertEquals(res.status, 200, `survey=${JSON.stringify(survey)}`);
    await res.body?.cancel();
  }
  assertEquals(h.callsTo("/rest/v1/account_deletion_feedback").length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// S2 / S3 — onboarding
// ─────────────────────────────────────────────────────────────────────────────

const ONBOARDING_BASE = {
  handedness: "right",
  skillLevel: "beginner",
  goal: "dinks",
  biggestProblem: "popping up dinks",
};

/** PostgREST PATCH …/profiles → echo the patch as the saved row (the harness
 * default returns an empty 201, which the route treats as "no row"). */
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

const profilePatches = (h: Harness) =>
  h.callsTo("/rest/v1/profiles").filter((c) => c.method === "PATCH");

Deno.test("S2: firstName made only of zero-width joiners + bidi overrides → 400 'firstName must be 1-40 characters after trimming.' and NO PATCH", async () => {
  const h = await loadHarness();
  const spoof = "\u200d\u200d\u202e\u202d\u2066\u2069\u200b\u200c\u200e\u200f\ufeff \u202a\u202b\u202c\u202d\u202e\u2067\u2068";
  const restore = echoProfilePatch();
  try {
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.205",
        body: { ...ONBOARDING_BASE, firstName: spoof },
      }),
    );
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error.message, "firstName must be 1-40 characters after trimming.");
    assertEquals(profilePatches(h).length, 0);
  } finally {
    restore();
  }
});

Deno.test("S2: firstName of 41 visible chars padded with bidi noise → 400; 40 BMP chars wrapped in zero-width/bidi noise → 200 stored sanitized", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const tooLong = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.206",
        body: { ...ONBOARDING_BASE, firstName: "\u202e" + "a".repeat(41) + "\u200d" },
      }),
    );
    assertEquals(tooLong.status, 400);
    assertEquals((await tooLong.json()).error.message, "firstName must be 1-40 characters after trimming.");
    assertEquals(profilePatches(h).length, 0);

    // 40 BMP characters (Latin + accented + CJK) survive; the surrounding
    // zero-width/bidi noise is stripped and the visible name is stored.
    // (Astral characters count as TWO here — see the expected-failures file.)
    const name = "José-Müller " + "李".repeat(10) + " " + "a".repeat(17);
    assertEquals(name.length, 40);
    const ok = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.206",
        body: { ...ONBOARDING_BASE, firstName: "\u200b " + name + " \u202e" },
      }),
    );
    assertEquals(ok.status, 200);
    assertEquals((await ok.json()).profile.first_name, name);
    assertEquals(profilePatches(h).length, 1);
    assertEquals((profilePatches(h)[0].body as Record<string, unknown>).first_name, name);
  } finally {
    restore();
  }
});

Deno.test("S2: gender 'Female' (capitalised) → 400 with the vocabulary message and NO PATCH; every lower-case option → 200", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    for (const bad of ["Female", "FEMALE", "female ", " male", "non-binary", "prefer_not_to_say\u200b", 1, true, {}]) {
      const res = await h.handler(
        userRequest("PUT", "/v1/me/onboarding", {
          token: fakeGoogleIdToken(freshUser()),
          ip: "198.51.100.207",
          body: { ...ONBOARDING_BASE, gender: bad },
        }),
      );
      assertEquals(res.status, 400, `gender=${JSON.stringify(bad)}`);
      assertEquals(
        (await res.json()).error.message,
        "gender must be one of female|male|nonbinary|prefer_not_to_say.",
      );
    }
    assertEquals(profilePatches(h).length, 0);
    for (const good of ["female", "male", "nonbinary", "prefer_not_to_say"]) {
      const res = await h.handler(
        userRequest("PUT", "/v1/me/onboarding", {
          token: fakeGoogleIdToken(freshUser()),
          ip: "198.51.100.207",
          body: { ...ONBOARDING_BASE, gender: good },
        }),
      );
      assertEquals(res.status, 200, `gender=${good}`);
      assertEquals((await res.json()).profile.gender, good);
    }
    assertEquals(profilePatches(h).length, 4);
    // null / absent leave the column untouched (not in the PATCH).
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.207",
        body: { ...ONBOARDING_BASE, gender: null, firstName: null },
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const last = profilePatches(h).at(-1)!.body as Record<string, unknown>;
    assert(!("gender" in last));
    assert(!("first_name" in last));
  } finally {
    restore();
  }
});

Deno.test("S3: goal not in GOAL_FOCUS ('win_more') → focus_checkpoint defaults to contact_position, PATCHed and echoed in both response fields", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const res = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.208",
        body: { ...ONBOARDING_BASE, goal: "win_more" },
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.plan.focusCheckpoint, "contact_position");
    assertEquals(body.recommendedCheckpoint, "contact_position");
    assertEquals(body.profile.focus_checkpoint, "contact_position");
    assertEquals(body.profile.primary_goal, "win_more");
    const patch = profilePatches(h)[0].body as Record<string, unknown>;
    assertEquals(patch.focus_checkpoint, "contact_position");
    assertEquals(patch.primary_goal, "win_more");
    assertEquals(patch.onboarding_state, "complete");
  } finally {
    restore();
  }
});

Deno.test("S3: every GOAL_FOCUS key maps to its documented checkpoint (spot-check) and '__proto__' as a goal falls back to contact_position on Deno", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const expected: Array<[string, string]> = [
      ["dinks", "contact_position"],
      ["drives", "preparation"],
      ["drops", "paddle_set"],
      ["serve", "sequencing"],
      ["return", "athletic_base"],
      ["volleys", "face_wrist_stability"],
      ["footwork", "athletic_base"],
      ["all-around", "contact_position"],
      // Deno's Object.prototype.__proto__ accessor yields undefined for a
      // plain literal lookup, so this one falls back. (Runtime-dependent —
      // the production edge runtime is Deno-based; not claimed beyond that.)
      ["__proto__", "contact_position"],
    ];
    for (const [goal, focus] of expected) {
      const res = await h.handler(
        userRequest("PUT", "/v1/me/onboarding", {
          token: fakeGoogleIdToken(freshUser()),
          ip: "198.51.100.209",
          body: { ...ONBOARDING_BASE, goal },
        }),
      );
      assertEquals(res.status, 200, goal);
      const body = await res.json();
      assertEquals(body.recommendedCheckpoint, focus, `goal=${goal}`);
      assertEquals(body.plan.focusCheckpoint, focus, `goal=${goal}`);
    }
  } finally {
    restore();
  }
});

Deno.test("S3: goal of exactly 64 chars → 200, 65 chars → 400 (boundary measured after sanitizing)", async () => {
  const h = await loadHarness();
  const restore = echoProfilePatch();
  try {
    const ok = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.210",
        body: { ...ONBOARDING_BASE, goal: "g".repeat(64) },
      }),
    );
    assertEquals(ok.status, 200);
    const okBody = await ok.json();
    assertEquals(okBody.profile.primary_goal, "g".repeat(64));
    assertEquals(okBody.recommendedCheckpoint, "contact_position");

    const tooLong = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.210",
        body: { ...ONBOARDING_BASE, goal: "g".repeat(65) },
      }),
    );
    assertEquals(tooLong.status, 400);
    assertEquals((await tooLong.json()).error.message, "Invalid onboarding payload.");
    assertEquals(profilePatches(h).length, 1);

    // 65 raw chars whose sanitized form is 64 (one zero-width stripped) → 200.
    const trimmed = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.210",
        body: { ...ONBOARDING_BASE, goal: "g".repeat(64) + "\u200b" },
      }),
    );
    assertEquals(trimmed.status, 200);
    assertEquals((await trimmed.json()).profile.primary_goal, "g".repeat(64));

    // 64 raw chars padded with 200 spaces on both sides → collapsed/trimmed → 200.
    const padded = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.210",
        body: { ...ONBOARDING_BASE, goal: " ".repeat(200) + "g".repeat(64) + " ".repeat(200) },
      }),
    );
    assertEquals(padded.status, 200);
    assertEquals((await padded.json()).profile.primary_goal, "g".repeat(64));

    // whitespace-only goal sanitizes to "" → 400.
    const blank = await h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: fakeGoogleIdToken(freshUser()),
        ip: "198.51.100.210",
        body: { ...ONBOARDING_BASE, goal: " \t\u200b\u202e " },
      }),
    );
    assertEquals(blank.status, 400);
    await blank.body?.cancel();
  } finally {
    restore();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S6 — rate-limit budgets
// ─────────────────────────────────────────────────────────────────────────────

/** Fire `limit` requests as `user`, expect none of them 429, then assert the
 * (limit+1)th is a 429 with Retry-After ≤ window. Re-runs with a fresh user
 * if the aligned fixed window rolled over mid-burst (fixed windows are
 * bucketed on floor(now / window)). */
async function exhaustBudget(
  h: Harness,
  method: string,
  path: string,
  limit: number,
  windowSeconds: number,
  ip: string,
  body: unknown,
): Promise<{ user: string; statusesBeforeLimit: number[]; blocked: Response }> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const user = freshUser();
    const token = fakeGoogleIdToken(user);
    const bucketBefore = Math.floor(Date.now() / (windowSeconds * 1_000));
    const statuses: number[] = [];
    for (let i = 0; i < limit; i += 1) {
      const res = await h.handler(userRequest(method, path, { token, ip, body }));
      statuses.push(res.status);
      await res.body?.cancel();
    }
    const blocked = await h.handler(userRequest(method, path, { token, ip, body }));
    const bucketAfter = Math.floor(Date.now() / (windowSeconds * 1_000));
    if (bucketBefore !== bucketAfter) {
      await blocked.body?.cancel();
      continue;
    }
    return { user, statusesBeforeLimit: statuses, blocked };
  }
  throw new Error("fixed window rolled over three times in a row");
}

async function assertRateLimited(res: Response, limit: number, windowSeconds: number) {
  assertEquals(res.status, 429);
  const retryAfter = Number(res.headers.get("Retry-After"));
  assert(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= windowSeconds, `Retry-After=${retryAfter}`);
  assertEquals(res.headers.get("RateLimit-Limit"), String(limit));
  assertEquals(res.headers.get("RateLimit-Remaining"), "0");
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  const body = await res.json();
  assertEquals(body.error.code, "rate_limited");
}

const BUDGETS: Array<{
  name: string;
  path: string;
  limit: number;
  windowSeconds: number;
  ip: string;
  body: unknown;
}> = [
  { name: "shots:sync", path: "/v1/shots:sync", limit: 30, windowSeconds: 60, ip: "198.51.100.211", body: {} },
  { name: "evaluation/trials", path: "/v1/me/evaluation/trials", limit: 12, windowSeconds: 60, ip: "198.51.100.212", body: {} },
  { name: "delete-request", path: "/v1/me/delete-request", limit: 3, windowSeconds: 3_600, ip: "198.51.100.213", body: {} },
  { name: "delete-confirm", path: "/v1/me/delete-confirm", limit: 5, windowSeconds: 3_600, ip: "198.51.100.214", body: {} },
];

for (const budget of BUDGETS) {
  Deno.test(`S6: ${budget.name} — request #${budget.limit + 1} in the window is 429 + Retry-After; a different user on the SAME IP is unaffected; the same user on a DIFFERENT IP is still blocked`, async () => {
    const h = await loadHarness();
    const { user, statusesBeforeLimit, blocked } = await exhaustBudget(
      h,
      "POST",
      budget.path,
      budget.limit,
      budget.windowSeconds,
      budget.ip,
      budget.body,
    );
    assert(statusesBeforeLimit.every((s) => s !== 429), `early 429 in ${statusesBeforeLimit}`);
    await assertRateLimited(blocked, budget.limit, budget.windowSeconds);

    // Budgets are per USER: the same bearer from another IP stays blocked…
    const otherIp = await h.handler(
      userRequest("POST", budget.path, { token: fakeGoogleIdToken(user), ip: "203.0.113.99", body: budget.body }),
    );
    await assertRateLimited(otherIp, budget.limit, budget.windowSeconds);
    // …and a different user behind the same NAT address is untouched.
    const neighbour = await h.handler(
      userRequest("POST", budget.path, { token: fakeGoogleIdToken(freshUser()), ip: budget.ip, body: budget.body }),
    );
    assertNotEquals(neighbour.status, 429);
    assertEquals(neighbour.headers.get("Retry-After"), null);
    await neighbour.body?.cancel();
    // The route budget is scoped to its own family: the blocked user can
    // still use an unrelated GET route (general 240/min budget).
    const unrelated = await h.handler(
      userRequest("GET", "/v1/me/saved-drills", { token: fakeGoogleIdToken(user), ip: budget.ip }),
    );
    assertNotEquals(unrelated.status, 429);
    await unrelated.body?.cancel();
  });
}

Deno.test("S6: concurrent burst — 40 simultaneous shots:sync from one user yields exactly 30 non-429 and 10 429 (in-memory INCR is not a read-then-write)", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  // Warm the auth cache so the burst does not race 40 sign-ins.
  await (await h.handler(userRequest("GET", "/v1/me/saved-drills", { token, ip: "198.51.100.215" }))).body?.cancel();
  const bucketBefore = Math.floor(Date.now() / 60_000);
  const responses = await Promise.all(
    Array.from({ length: 40 }, () =>
      h.handler(userRequest("POST", "/v1/shots:sync", { token, ip: "198.51.100.215", body: {} }))),
  );
  const bucketAfter = Math.floor(Date.now() / 60_000);
  const limited = responses.filter((r) => r.status === 429).length;
  await Promise.all(responses.map((r) => r.body?.cancel()));
  if (bucketBefore === bucketAfter) {
    assertEquals(limited, 10);
  } else {
    // Window rolled over mid-burst: only a weaker bound is meaningful.
    assert(limited <= 10);
  }
});

Deno.test("S6: route budget path matching is exact — '/v1/shots:sync/' (trailing slash) and '/v1/shots%3Async' do not reach the shots handler under the general budget", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  for (const path of ["/v1/shots:sync/", "/v1/shots%3Async", "/v1/Shots:sync"]) {
    const res = await h.handler(userRequest("POST", path, { token, ip: "198.51.100.216", body: {} }));
    // Either a 404 (unknown route) or the shots handler's 400 — but never a
    // 5xx and never a different user-facing handler.
    assert([400, 404].includes(res.status), `${path} → ${res.status}`);
    const body = await res.json();
    if (res.status === 400) assertEquals(body.error.code, "validation.shots_sync");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// S7 — saved drills slug validation
// ─────────────────────────────────────────────────────────────────────────────

Deno.test("S7: PUT /v1/me/saved-drills/<120 a's> → 200, 121 → 400 'validation.saved_drill', no upsert for the rejected slug", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  const slug120 = "a".repeat(120);
  h.tables["user_saved_drills"] = [{ slug: slug120, saved_at: "2026-09-04T00:00:00.000Z" }];
  const ok = await h.handler(userRequest("PUT", `/v1/me/saved-drills/${slug120}`, { token, ip: "198.51.100.217" }));
  assertEquals(ok.status, 200);
  const okBody = await ok.json();
  assertEquals(okBody.slug, slug120);
  assertEquals(okBody.saved, true);
  assertEquals(
    h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "POST").length,
    1,
  );

  const slug121 = "a".repeat(121);
  const bad = await h.handler(userRequest("PUT", `/v1/me/saved-drills/${slug121}`, { token, ip: "198.51.100.217" }));
  assertEquals(bad.status, 400);
  assertEquals((await bad.json()).error.code, "validation.saved_drill");
  assertEquals(
    h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "POST").length,
    1,
    "the 121-char slug must never reach PostgREST",
  );
});

Deno.test("S7: traversal / hostile slugs are rejected AFTER decoding ('..%2F..' → '../..'), including leading '-'/'_' and non-ASCII look-alikes", async () => {
  const h = await loadHarness();
  const token = fakeGoogleIdToken(freshUser());
  const hostile = [
    "..%2F..",
    "..%252F..",
    "%2e%2e%2f%2e%2e",
    "-leading-dash",
    "_leading_underscore",
    "a%20b",
    "a%00b",
    "a%2Fb",
    "a.b",
    "%C3%A9clair",
    "%E2%80%8Bzero-width",
    "a%3Bselect",
    "%2A",
  ];
  for (const raw of hostile) {
    const res = await h.handler(userRequest("PUT", `/v1/me/saved-drills/${raw}`, { token, ip: "198.51.100.218" }));
    assertEquals(res.status, 400, `slug=${raw} → ${res.status}`);
    const body = await res.json();
    assertEquals(body.error.code, "validation.saved_drill", `slug=${raw}`);
  }
  assertEquals(h.callsTo("/rest/v1/user_saved_drills").length, 0);
  // Malformed percent-encoding is a 400 too, never an uncaught URIError.
  const malformed = await h.handler(userRequest("PUT", "/v1/me/saved-drills/%E0%A4%A", { token, ip: "198.51.100.218" }));
  assertEquals(malformed.status, 400);
  await malformed.body?.cancel();
  // Mixed-case ASCII with '_' and '-' after the first char is accepted (regex is /i).
  h.tables["user_saved_drills"] = [{ slug: "Dink-Ladder_2", saved_at: "2026-09-04T00:00:00.000Z" }];
  const ok = await h.handler(userRequest("PUT", "/v1/me/saved-drills/Dink-Ladder_2", { token, ip: "198.51.100.218" }));
  assertEquals(ok.status, 200);
  await ok.body?.cancel();
});

Deno.test("S7: DELETE with a slug that fails the regex still scopes to the user and is a 204 no-op (no validation on unsave, but the query is user-pinned)", async () => {
  const h = await loadHarness();
  const user = freshUser();
  const res = await h.handler(
    userRequest("DELETE", "/v1/me/saved-drills/..%2F..", { token: fakeGoogleIdToken(user), ip: "198.51.100.219" }),
  );
  assertEquals(res.status, 204);
  const deletes = h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "DELETE");
  assertEquals(deletes.length, 1);
  const url = new URL(deletes[0].url);
  assertEquals(url.searchParams.get("user_id"), `eq.${user}`);
  assertEquals(url.searchParams.get("slug"), "eq.../..");
});
