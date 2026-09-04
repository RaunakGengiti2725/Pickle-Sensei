// Execution audit (edge-domain-routes, pass 2): drives the REAL handler in
// index.ts through routesHarness.ts across the loading / success / failure /
// empty / stale / missing-data states of every domain route in scope —
// /v1/me, onboarding, access, permits, shots:sync, rank, progress, consent,
// saved drills + catalog, account deletion, legal pages.
//
// Tests tagged [defect-pin] assert CURRENT behaviour that the audit flagged;
// flip the assertion when the fix lands.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     audit_domain_routes_execution.test.ts

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  RC_URL,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

// ─── Fetch overrides layered on top of the harness stub ─────────────────────
// The harness answers every PostgREST GET with the same rows regardless of
// filters/Range and every PATCH with an empty 201. Overrides let a test model
// a DB failure, a real PATCH echo, paging, or a slow read.

type Override = (request: Request) => Promise<Response> | Response | null;
const overrides: Override[] = [];
let stubbedFetch: typeof fetch | null = null;

let current: Harness | null = null;

async function harness(): Promise<Harness> {
  const h = await loadHarness();
  current = h;
  if (!stubbedFetch) {
    stubbedFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      for (const override of overrides) {
        const hit = override(request.clone());
        if (hit) {
          // Overridden calls are still recorded so call-count assertions hold.
          const headers: Record<string, string> = {};
          request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
          const text = await request.text().catch(() => "");
          let body: unknown = null;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              body = text;
            }
          }
          current?.calls.push({ url: request.url, method: request.method, headers, body });
          return await hit;
        }
      }
      return stubbedFetch!(input, init);
    }) as typeof fetch;
  }
  overrides.length = 0;
  return h;
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const rest = (table: string): string => `${SUPABASE_URL}/rest/v1/${table}`;

let ipCounter = 0;
const nextIp = (): string => `198.51.100.${(ipCounter++ % 250) + 1}`;

/** One fresh identity per test: the in-process L1 cache (auth, rank,
 * progress) and the per-user rate limits would otherwise leak between tests. */
function identity(provider: "google" | "apple" = "google") {
  const sub = crypto.randomUUID();
  const token = provider === "google" ? fakeGoogleIdToken(sub) : fakeAppleIdToken(sub);
  const ip = nextIp();
  return {
    sub,
    token,
    ip,
    call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
      userRequest(method, path, { token, ip, body, headers }),
  };
}

const PROFILE_ROW = {
  id: "",
  email: "user@example.com",
  onboarding_state: "complete",
  provider: "google",
  skill_level: "beginner",
  handedness: "right",
  primary_goal: "dinks",
  biggest_problem: "x",
  focus_checkpoint: "contact_position",
  first_name: null,
  gender: null,
};

const ONBOARDING = {
  skillLevel: "beginner",
  handedness: "right",
  goal: "dinks",
  biggestProblem: "I pop up my dinks",
};

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "b1",
  poseModelVersion: "p1",
  paddleModelVersion: "pd1",
  strokeDetectorVersion: "s1",
  phaseModelVersion: "ph1",
  scoringModelVersion: "sc1",
  shotConfigVersion: "c1",
};

function syncShot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: crypto.randomUUID(),
    source: "real",
    analysisPermitId: crypto.randomUUID(),
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7.2,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

interface ErrorBody {
  error: { code?: string; message: string };
}

async function errorOf(res: Response): Promise<ErrorBody["error"]> {
  return ((await res.json()) as ErrorBody).error;
}

// ─── GET /v1/me ─────────────────────────────────────────────────────────────

Deno.test(
  "GET /v1/me: success returns the account, onboarding state and coaching profile",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.profiles = [{ ...PROFILE_ROW, id: me.sub, onboarding_state: "pending" }];
    const res = await h.handler(me.call("GET", "/v1/me"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      user: { id: string; email: string };
      onboardingState: string;
      profile: Record<string, unknown>;
    };
    assertEquals(body.user, { id: me.sub, email: "user@example.com" });
    assertEquals(body.onboardingState, "pending");
    assertEquals(body.profile.focus_checkpoint, "contact_position");
    assertEquals(Object.keys(body.profile).sort(), [
      "biggest_problem",
      "first_name",
      "focus_checkpoint",
      "gender",
      "handedness",
      "primary_goal",
      "skill_level",
    ]);
  },
);

Deno.test(
  "GET /v1/me: missing profile row retries once (~400ms) and then answers a generic retryable 503",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.profiles = [];
    const started = performance.now();
    const res = await h.handler(me.call("GET", "/v1/me"));
    const elapsed = performance.now() - started;
    assertEquals(res.status, 503);
    const err = await errorOf(res);
    assertEquals(err.message, "Your account is temporarily unavailable. Please try again.");
    assert(elapsed >= 380, `expected the signup-race retry delay, got ${elapsed.toFixed(0)}ms`);
    const reads = h.callsTo("/rest/v1/profiles").filter((c) => c.method === "GET");
    assertEquals(reads.length, 2, "exactly one retry");
  },
);

Deno.test("GET /v1/me: PostgREST 500 is a generic 503 with no DB detail in the body", async () => {
  const h = await harness();
  const me = identity();
  overrides.push((req) =>
    req.url.startsWith(rest("profiles")) && req.method === "GET"
      ? jsonResponse(500, { message: 'relation "profiles" does not exist', code: "42P01" })
      : null,
  );
  const res = await h.handler(me.call("GET", "/v1/me"));
  assertEquals(res.status, 503);
  const text = await res.text();
  assert(!text.includes("relation"), text);
  assert(!text.includes("42P01"), text);
});

// ─── PUT /v1/me/onboarding ──────────────────────────────────────────────────

function echoProfilePatch(sub: string): Override {
  return (req) => {
    if (!(req.url.startsWith(rest("profiles")) && req.method === "PATCH")) return null;
    return req.json().then((patch) => {
      const row = { ...PROFILE_ROW, id: sub, ...(patch as Record<string, unknown>) };
      const accept = req.headers.get("accept") ?? "";
      return jsonResponse(200, accept.includes("vnd.pgrst.object") ? row : [row]);
    });
  };
}

Deno.test(
  "PUT /v1/me/onboarding: success maps the goal to a focus checkpoint and marks onboarding complete",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push(echoProfilePatch(me.sub));
    const res = await h.handler(
      me.call("PUT", "/v1/me/onboarding", { ...ONBOARDING, firstName: "Ana", gender: "female" }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      plan: { focusCheckpoint: string };
      recommendedCheckpoint: string;
      profile: Record<string, unknown>;
    };
    assertEquals(body.plan.focusCheckpoint, body.recommendedCheckpoint);
    assertEquals(body.profile.first_name, "Ana");
    assertEquals(body.profile.gender, "female");
    const patch = h.callsTo("/rest/v1/profiles").find((c) => c.method === "PATCH");
    assert(patch);
    const sent = patch.body as Record<string, unknown>;
    assertEquals(sent.onboarding_state, "complete");
    assertEquals(sent.focus_checkpoint, body.plan.focusCheckpoint);
  },
);

Deno.test(
  "PUT /v1/me/onboarding: every invalid shape is a 400 and nothing is written",
  async () => {
    const h = await harness();
    const me = identity();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["missing skillLevel", { ...ONBOARDING, skillLevel: "" }],
      ["bad handedness", { ...ONBOARDING, handedness: "ambidextrous" }],
      ["missing goal", { ...ONBOARDING, goal: undefined }],
      ["missing biggestProblem", { ...ONBOARDING, biggestProblem: "   " }],
      ["biggestProblem > 256", { ...ONBOARDING, biggestProblem: "x".repeat(257) }],
      ["firstName not a string", { ...ONBOARDING, firstName: 42 }],
      ["firstName only bidi/whitespace", { ...ONBOARDING, firstName: " \u202e\u200b " }],
      ["firstName > 40", { ...ONBOARDING, firstName: "a".repeat(41) }],
      ["gender outside vocabulary", { ...ONBOARDING, gender: "other" }],
      ["array body", [] as unknown as Record<string, unknown>],
    ];
    for (const [label, body] of cases) {
      const res = await h.handler(me.call("PUT", "/v1/me/onboarding", body));
      assertEquals(res.status, 400, label);
      await res.body?.cancel();
    }
    assertEquals(h.callsTo("/rest/v1/profiles").filter((c) => c.method === "PATCH").length, 0);
  },
);

Deno.test(
  "PUT /v1/me/onboarding: null firstName/gender leave those columns untouched",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push(echoProfilePatch(me.sub));
    const res = await h.handler(
      me.call("PUT", "/v1/me/onboarding", { ...ONBOARDING, firstName: null, gender: null }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const patch = h.callsTo("/rest/v1/profiles").find((c) => c.method === "PATCH");
    assert(patch);
    const sent = patch.body as Record<string, unknown>;
    assert(!("first_name" in sent));
    assert(!("gender" in sent));
  },
);

Deno.test(
  "PUT /v1/me/onboarding: an RLS-empty update (no row returned) is a retryable 503, not a fake success",
  async () => {
    const h = await harness();
    const me = identity();
    const res = await h.handler(me.call("PUT", "/v1/me/onboarding", ONBOARDING));
    assertEquals(res.status, 503);
    assertStringIncludes((await errorOf(res)).message, "temporarily unavailable");
  },
);

// ─── GET /v1/me/access ──────────────────────────────────────────────────────

Deno.test(
  "GET /v1/me/access: counters fold into the client's arithmetic invariants (clamped used/reserved)",
  async () => {
    const h = await harness();
    const me = identity();
    const expect = async (
      state: { premium: boolean; scored_count: number; reserved_count: number },
      want: Record<string, unknown>,
    ) => {
      h.rpcs.access_state = [state];
      const res = await h.handler(me.call("GET", "/v1/me/access"));
      assertEquals(res.status, 200);
      const body = (await res.json()) as Record<string, unknown> & {
        freeRatings: Record<string, number>;
        entitlements: string[];
      };
      for (const [k, v] of Object.entries(want))
        assertEquals(body[k], v, `${JSON.stringify(state)} → ${k}`);
      const fr = body.freeRatings;
      assertEquals(fr.limit, 2);
      assert(fr.reserved <= fr.remaining);
      assertEquals(fr.availableToReserve, fr.remaining - fr.reserved);
      assertEquals(fr.used + fr.remaining, 2);
      assertEquals(body.premium, body.entitlements.includes("premium"));
    };
    await expect(
      { premium: false, scored_count: 0, reserved_count: 0 },
      {
        canStartRating: true,
        paywallRequired: false,
        freeRatings: { limit: 2, used: 0, reserved: 0, remaining: 2, availableToReserve: 2 },
      },
    );
    await expect(
      { premium: false, scored_count: 1, reserved_count: 1 },
      {
        canStartRating: false,
        freeRatings: { limit: 2, used: 1, reserved: 1, remaining: 1, availableToReserve: 0 },
      },
    );
    // Stale holds past the limit are clamped, never negative.
    await expect(
      { premium: false, scored_count: 5, reserved_count: 7 },
      {
        canStartRating: false,
        paywallRequired: true,
        freeRatings: { limit: 2, used: 2, reserved: 0, remaining: 0, availableToReserve: 0 },
      },
    );
    await expect(
      { premium: true, scored_count: 9, reserved_count: 0 },
      {
        canStartRating: true,
        paywallRequired: false,
        entitlements: ["premium"],
      },
    );
  },
);

Deno.test("GET /v1/me/access: RPC missing or returning no row is a generic 503", async () => {
  const h = await harness();
  const me = identity();
  let res = await h.handler(me.call("GET", "/v1/me/access"));
  assertEquals(res.status, 503);
  assert(!(await res.text()).includes("PGRST"));
  h.rpcs.access_state = [];
  res = await h.handler(me.call("GET", "/v1/me/access"));
  assertEquals(res.status, 503);
  assert(!(await res.text()).includes("no row"));
});

// ─── POST /v1/analysis-permits ──────────────────────────────────────────────

const PERMIT_ID = "33333333-3333-4333-8333-333333333333";
const permitRpcRow = (result: string, createdAt = "2026-09-01T10:00:00.000Z") => [
  {
    result,
    permit_id: result === "accepted" ? PERMIT_ID : null,
    permit_status: result === "accepted" ? "reserved" : null,
    permit_outcome: null,
    permit_created_at: result === "accepted" ? createdAt : null,
  },
];

Deno.test(
  "POST /v1/analysis-permits: accepted permit advertises a 24h expiry derived from created_at, plus access",
  async () => {
    const h = await harness();
    const me = identity();
    h.rpcs.reserve_analysis_permit = permitRpcRow("accepted");
    h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 1 }];
    const res = await h.handler(me.call("POST", "/v1/analysis-permits", { idempotencyKey: "k-1" }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      permit: Record<string, unknown>;
      access: { freeRatings: { reserved: number } };
    };
    assertEquals(body.permit, {
      id: PERMIT_ID,
      accessSource: "free",
      status: "reserved",
      outcome: null,
      reservedAt: "2026-09-01T10:00:00.000Z",
      expiresAt: "2026-09-02T10:00:00.000Z",
    });
    assertEquals(body.access.freeRatings.reserved, 1);
    const rpc = h.callsTo("/rest/v1/rpc/reserve_analysis_permit");
    assertEquals(rpc.length, 1);
    assertEquals((rpc[0].body as Record<string, unknown>).p_idempotency_key, "k-1");
  },
);

Deno.test(
  "POST /v1/analysis-permits: validation, paywall, unknown RPC verdict and missing RPC states",
  async () => {
    const h = await harness();
    const me = identity();
    for (const body of [
      {},
      { idempotencyKey: "" },
      { idempotencyKey: "k".repeat(129) },
      { idempotencyKey: 7 },
    ]) {
      const res = await h.handler(me.call("POST", "/v1/analysis-permits", body));
      assertEquals(res.status, 400, JSON.stringify(body));
      assertEquals((await errorOf(res)).code, "validation.analysis_permit");
    }
    assertEquals(h.callsTo("/rest/v1/rpc/").length, 0, "invalid bodies never reach the DB");

    h.rpcs.reserve_analysis_permit = permitRpcRow("access.paywall_required");
    let res = await h.handler(me.call("POST", "/v1/analysis-permits", { idempotencyKey: "k" }));
    assertEquals(res.status, 402);
    assertEquals((await errorOf(res)).code, "access.paywall_required");

    h.rpcs.reserve_analysis_permit = [{ result: "something.new", permit_id: null }];
    res = await h.handler(me.call("POST", "/v1/analysis-permits", { idempotencyKey: "k" }));
    assertEquals(res.status, 503);
    assert(!(await res.text()).includes("something.new"), "unknown verdict detail stays in logs");

    h.rpcs.reserve_analysis_permit = [];
    res = await h.handler(me.call("POST", "/v1/analysis-permits", { idempotencyKey: "k" }));
    assertEquals(res.status, 503);
    await res.body?.cancel();

    delete h.rpcs.reserve_analysis_permit;
    res = await h.handler(me.call("POST", "/v1/analysis-permits", { idempotencyKey: "k" }));
    assertEquals(res.status, 503);
    await res.body?.cancel();
  },
);

// ─── POST /v1/analysis-permits/:id/finalize ─────────────────────────────────

Deno.test(
  "finalize permit: id/outcome/ratingId validation happens before any DB read",
  async () => {
    const h = await harness();
    const me = identity();
    let res = await h.handler(
      me.call("POST", "/v1/analysis-permits/not-a-uuid/finalize", {
        outcome: "cancelled",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
    res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "scored",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 400);
    assertStringIncludes((await errorOf(res)).message, "never finalized directly");
    res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "cancelled",
        ratingId: "r1",
      }),
    );
    assertEquals(res.status, 400);
    await res.body?.cancel();
    assertEquals(h.callsTo("/rest/v1/analysis_permits").length, 0);
  },
);

Deno.test(
  "finalize permit: not found → 404, idempotent replay → 200, conflicting outcome → 409",
  async () => {
    const h = await harness();
    const me = identity();
    h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    h.tables.analysis_permits = [];
    let res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "cancelled",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 404);
    assertEquals((await errorOf(res)).code, "access.permit_not_found");

    h.tables.analysis_permits = [
      {
        id: PERMIT_ID,
        status: "finalized",
        outcome: "cancelled",
        created_at: "2026-09-01T10:00:00.000Z",
      },
    ];
    res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "cancelled",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(
      ((await res.json()) as { permit: { outcome: string } }).permit.outcome,
      "cancelled",
    );
    assertEquals(
      h.callsTo("/rest/v1/analysis_permits").filter((c) => c.method === "PATCH").length,
      0,
    );

    res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "failed",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 409);
    const err = await errorOf(res);
    assertEquals(err.code, "access.permit_already_finalized");
    assertStringIncludes(err.message, "cancelled");
  },
);

Deno.test("finalize permit: reserved permit is finalized via a status-guarded PATCH", async () => {
  const h = await harness();
  const me = identity();
  h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
  h.tables.analysis_permits = [
    { id: PERMIT_ID, status: "reserved", outcome: null, created_at: "2026-09-01T10:00:00.000Z" },
  ];
  overrides.push((req) => {
    if (!(req.url.startsWith(rest("analysis_permits")) && req.method === "PATCH")) return null;
    const url = new URL(req.url);
    assertEquals(
      url.searchParams.get("status"),
      "eq.reserved",
      "PATCH must be guarded by status=reserved",
    );
    assertEquals(url.searchParams.get("id"), `eq.${PERMIT_ID}`);
    return jsonResponse(200, {
      id: PERMIT_ID,
      status: "finalized",
      outcome: "low_confidence",
      created_at: "2026-09-01T10:00:00.000Z",
    });
  });
  const res = await h.handler(
    me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
      outcome: "low_confidence",
      ratingId: null,
    }),
  );
  assertEquals(res.status, 200);
  const body = (await res.json()) as { permit: { status: string; outcome: string } };
  assertEquals(body.permit.status, "finalized");
  assertEquals(body.permit.outcome, "low_confidence");
});

Deno.test(
  "finalize permit: losing the race to shots:sync reports the settled state as 409 (no silent overwrite)",
  async () => {
    const h = await harness();
    const me = identity();
    h.rpcs.access_state = [{ premium: false, scored_count: 1, reserved_count: 0 }];
    let reads = 0;
    overrides.push((req) => {
      if (!req.url.startsWith(rest("analysis_permits"))) return null;
      if (req.method === "PATCH")
        return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
      reads += 1;
      // First read: still reserved. Second (settled) read: sync scored it meanwhile.
      const row =
        reads === 1
          ? {
              id: PERMIT_ID,
              status: "reserved",
              outcome: null,
              created_at: "2026-09-01T10:00:00.000Z",
            }
          : {
              id: PERMIT_ID,
              status: "finalized",
              outcome: "scored",
              created_at: "2026-09-01T10:00:00.000Z",
            };
      return jsonResponse(200, row);
    });
    const res = await h.handler(
      me.call("POST", `/v1/analysis-permits/${PERMIT_ID}/finalize`, {
        outcome: "cancelled",
        ratingId: null,
      }),
    );
    assertEquals(res.status, 409);
    assertStringIncludes((await errorOf(res)).message, "scored");
  },
);

// ─── POST /v1/shots:sync ────────────────────────────────────────────────────

Deno.test(
  "shots:sync: batch bounds (0 and 201 entries) are a single 400 with no DB traffic",
  async () => {
    const h = await harness();
    const me = identity();
    for (const shots of [[], Array.from({ length: 201 }, () => syncShot()), "nope"]) {
      const res = await h.handler(me.call("POST", "/v1/shots:sync", { shots }));
      assertEquals(res.status, 400);
      assertEquals((await errorOf(res)).code, "validation.shots_sync");
    }
    assertEquals(h.callsTo("/rest/v1/").length, 0);
  },
);

Deno.test(
  "shots:sync: per-shot validation rejects only the bad rows and never queries for them",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";
    const checkpoint = {
      key: "paddle_prep",
      score: 62,
      confidence: 0.8,
      band: "yellow",
      direction: "earlier",
      severity: 0.4,
      applicable: true,
    };
    const good = syncShot({
      checkpoints: [checkpoint, { ...checkpoint, key: "contact", score: null, band: "unscored" }],
    });
    const bad: Array<[string, Record<string, unknown>, string]> = [
      ["non-real source", syncShot({ source: "synthetic" }), "shot.non_real_source"],
      [
        "duplicate checkpoint key",
        syncShot({ checkpoints: [checkpoint, { ...checkpoint, score: 10 }] }),
        "shot.invalid_payload",
      ],
      [
        "too many checkpoints",
        syncShot({
          checkpoints: Array.from({ length: 65 }, (_, i) => ({ ...checkpoint, key: `k${i}` })),
        }),
        "shot.invalid_payload",
      ],
      ["bad id", syncShot({ id: "abc" }), "shot.invalid_payload"],
      ["bad permit", syncShot({ analysisPermitId: "x" }), "shot.invalid_payload"],
      ["bad camera", syncShot({ cameraView: "front" }), "shot.invalid_payload"],
      [
        "negative ms",
        syncShot({ timestamps: { startMs: -1, contactMs: null, endMs: 5 } }),
        "shot.invalid_payload",
      ],
      [
        "ms past int4",
        syncShot({ timestamps: { startMs: 0, contactMs: null, endMs: 2147483648 } }),
        "shot.invalid_payload",
      ],
      ["score out of range", syncShot({ overallScore: 10.5 }), "shot.invalid_payload"],
      [
        "low_confidence with score",
        syncShot({ resultKind: "low_confidence", overallScore: 5 }),
        "shot.invalid_payload",
      ],
      [
        "duplicate phase key",
        syncShot({
          phases: [
            { key: "a", startMs: 0, representativeMs: 1, endMs: 2, confidence: 0.5 },
            { key: "a", startMs: 0, representativeMs: 1, endMs: 2, confidence: 0.5 },
          ],
        }),
        "shot.invalid_payload",
      ],
      [
        "bad checkpoint band",
        syncShot({
          checkpoints: [
            {
              key: "c",
              score: 50,
              confidence: 0.5,
              band: "purple",
              direction: "up",
              severity: 0.1,
              applicable: true,
            },
          ],
        }),
        "shot.invalid_payload",
      ],
      [
        "versionVector value > 64",
        syncShot({ versionVector: { ...VERSION_VECTOR, appVersion: "v".repeat(65) } }),
        "shot.invalid_payload",
      ],
      ["not an object", 5 as unknown as Record<string, unknown>, "shot.invalid_payload"],
    ];
    const res = await h.handler(
      me.call("POST", "/v1/shots:sync", { shots: [good, ...bad.map((b) => b[1])] }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      acceptedIds: string[];
      rejected: Array<{ id: string; code: string; message: string }>;
    };
    assertEquals(body.acceptedIds, [good.id]);
    assertEquals(body.rejected.length, bad.length);
    for (let i = 0; i < bad.length; i += 1) {
      const [label, shot, code] = bad[i];
      const r = body.rejected[i];
      assertEquals(r.code, code, label);
      assertEquals(r.id, typeof shot.id === "string" ? shot.id : "unknown", label);
    }
    const applied = h.callsTo("/rest/v1/rpc/apply_synced_shot");
    assertEquals(applied.length, 1, "only the valid shot is written");
    const sent = (applied[0].body as { shot: { checkpoints: unknown[] } }).shot;
    assertEquals(sent.checkpoints, good.checkpoints, "checkpoints reach the RPC verbatim");
  },
);

Deno.test(
  "shots:sync: every apply_synced_shot verdict maps to the client contract code; DB detail never leaks",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.shots = [];
    const verdicts: Array<[string, string]> = [
      ["auth.required", "auth.required"],
      ["access.permit_not_found", "access.permit_not_found"],
      ["access.permit_not_reserved", "access.permit_not_reserved"],
      ["access.permit_expired", "access.permit_expired"],
      ["access.paywall_required", "access.paywall_required"],
      ["shot.session_not_found", "shot.session_not_found"],
      ["shot.id_conflict", "shot.id_conflict"],
      [
        'shot.write_failed:new row for relation "shots" violates check constraint "shots_text_bounds"',
        "shot.write_failed",
      ],
      ["totally.unexpected", "shot.write_failed"],
    ];
    for (const [verdict, code] of verdicts) {
      h.rpcs.apply_synced_shot = verdict;
      const shot = syncShot();
      const res = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [shot] }));
      assertEquals(res.status, 200, verdict);
      const text = await res.text();
      const body = JSON.parse(text) as {
        acceptedIds: string[];
        rejected: Array<{ id: string; code: string }>;
      };
      assertEquals(body.acceptedIds, [], verdict);
      assertEquals(
        body.rejected,
        [{ id: shot.id, code, message: body.rejected[0]?.message }],
        verdict,
      );
      assert(!text.includes("shots_text_bounds") && !text.includes("totally.unexpected"), verdict);
    }
  },
);

Deno.test(
  "shots:sync: RPC transport error rejects the shot as retryable write_failed, batch replay check failure is a 503",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.shots = [];
    const shot = syncShot();
    let res = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [shot] }));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { rejected: Array<{ code: string; message: string }> };
    assertEquals(body.rejected[0].code, "shot.write_failed");
    assertStringIncludes(body.rejected[0].message, "will retry");

    overrides.push((req) =>
      req.url.startsWith(rest("shots")) && req.method === "GET"
        ? jsonResponse(500, { message: "boom" })
        : null,
    );
    res = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [shot] }));
    assertEquals(res.status, 503);
    assert(!(await res.text()).includes("boom"));
  },
);

Deno.test(
  "shots:sync: replayed ids are acknowledged from the batched lookup without re-running the RPC or busting caches",
  async () => {
    const h = await harness();
    const me = identity();
    const shot = syncShot();
    h.tables.shots = [{ id: shot.id }];
    // Warm the rank cache first.
    h.tables.player_technique_rating = [];
    let res = await h.handler(me.call("GET", "/v1/rank"));
    assertEquals(await res.json(), { rank: null });
    const rankReadsBefore = h.callsTo("/rest/v1/player_technique_rating").length;

    res = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [shot] }));
    assertEquals((await res.json()) as unknown, { acceptedIds: [shot.id], rejected: [] });
    assertEquals(h.callsTo("/rest/v1/rpc/apply_synced_shot").length, 0);

    res = await h.handler(me.call("GET", "/v1/rank"));
    await res.body?.cancel();
    assertEquals(
      h.callsTo("/rest/v1/player_technique_rating").length,
      rankReadsBefore,
      "replay did not invalidate the cached rank",
    );
  },
);

Deno.test(
  "shots:sync → rank/progress: an accepted shot busts both caches so the next reads hit the DB",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.shots = [];
    h.tables.player_technique_rating = [];
    h.tables.progress_daily = [];
    h.tables.practice_days = [];
    h.rpcs.apply_synced_shot = "accepted";

    let res = await h.handler(me.call("GET", "/v1/rank"));
    assertEquals(await res.json(), { rank: null });
    res = await h.handler(me.call("GET", "/v1/progress"));
    assertEquals(((await res.json()) as { series: unknown[] }).series, []);
    // Cached now: no further DB reads.
    res = await h.handler(me.call("GET", "/v1/rank"));
    await res.body?.cancel();
    res = await h.handler(me.call("GET", "/v1/progress"));
    await res.body?.cancel();
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1);
    assertEquals(h.callsTo("/rest/v1/progress_daily").length, 1);

    res = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [syncShot()] }));
    assertEquals(((await res.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);

    h.tables.player_technique_rating = [
      {
        shot_type: "dink",
        score: 7.2,
        captured_at: "2026-09-01T10:00:00.000Z",
        sampled_count: 1,
        confidence_weight: 1,
      },
    ];
    h.tables.player_rank_state = [
      {
        rating: 7.2,
        tier: "platinum",
        technique_count: 1,
        scored_shot_count: 1,
        updated_at: "2026-09-01T10:00:01.000Z",
      },
    ];
    res = await h.handler(me.call("GET", "/v1/rank"));
    const rank = (await res.json()) as { rank: { rating: number; tier: string } };
    assertEquals(rank.rank.rating, 7.2);
    assertEquals(rank.rank.tier, "platinum");
    res = await h.handler(me.call("GET", "/v1/progress"));
    await res.body?.cancel();
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 2);
    assertEquals(h.callsTo("/rest/v1/progress_daily").length, 2);
  },
);

// ─── GET /v1/rank ───────────────────────────────────────────────────────────

Deno.test(
  "GET /v1/rank: saved state is authoritative; confidence_weight never leaks into the payload",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.player_technique_rating = [
      {
        shot_type: "serve",
        score: 6.1,
        captured_at: "2026-09-01T10:00:00.000Z",
        sampled_count: 3,
        confidence_weight: 3,
      },
      {
        shot_type: "dink",
        score: 8.4,
        captured_at: "2026-09-02T10:00:00.000Z",
        sampled_count: 1,
        confidence_weight: 1,
      },
    ];
    h.tables.player_rank_state = [
      {
        rating: 6.68,
        tier: "platinum",
        technique_count: 2,
        scored_shot_count: 4,
        updated_at: "2026-09-02T10:00:01.000Z",
      },
    ];
    const res = await h.handler(me.call("GET", "/v1/rank"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      rank: {
        rating: number;
        tier: string;
        techniqueCount: number;
        scoredShotCount: number;
        techniques: Array<Record<string, unknown>>;
      };
    };
    assertEquals(body.rank.rating, 6.68);
    assertEquals(body.rank.scoredShotCount, 4);
    assertEquals(body.rank.techniqueCount, 2);
    assertEquals(
      body.rank.techniques.map((t) => t.shot_type),
      ["dink", "serve"],
      "sorted by score desc",
    );
    for (const t of body.rank.techniques) assert(!("confidence_weight" in t));
  },
);

Deno.test(
  "GET /v1/rank: missing player_rank_state row falls back to the inline formula (bit-identical rounding)",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.player_technique_rating = [
      {
        shot_type: "serve",
        score: 6.1,
        captured_at: "2026-09-01T10:00:00.000Z",
        sampled_count: 3,
        confidence_weight: 3,
      },
      {
        shot_type: "dink",
        score: 8.4,
        captured_at: "2026-09-02T10:00:00.000Z",
        sampled_count: 1,
        confidence_weight: 1,
      },
    ];
    h.tables.player_rank_state = [];
    const res = await h.handler(me.call("GET", "/v1/rank"));
    const body = (await res.json()) as {
      rank: { rating: number; tier: string; scoredShotCount: null; updatedAt: null };
    };
    // (3*610 + 1*840) / 4 = 667.5 → round → 668 → 6.68
    assertEquals(body.rank.rating, 6.68);
    assertEquals(body.rank.tier, "platinum");
    assertEquals(body.rank.scoredShotCount, null);
    assertEquals(body.rank.updatedAt, null);
  },
);

Deno.test(
  "GET /v1/rank: technique view failure is a generic 503; state-row failure with no techniques is still an honest empty rank",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push((req) =>
      req.url.startsWith(rest("player_technique_rating"))
        ? jsonResponse(500, { message: "view missing" })
        : null,
    );
    let res = await h.handler(me.call("GET", "/v1/rank"));
    assertEquals(res.status, 503);
    assert(!(await res.text()).includes("view missing"));

    overrides.length = 0;
    const other = identity();
    h.tables.player_technique_rating = [];
    overrides.push((req) =>
      req.url.startsWith(rest("player_rank_state"))
        ? jsonResponse(500, { message: "state missing" })
        : null,
    );
    res = await h.handler(other.call("GET", "/v1/rank"));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { rank: null });
  },
);

Deno.test(
  "GET /v1/rank: concurrent cold reads coalesce into ONE DB read and each caller gets a full body",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.player_technique_rating = [];
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => h.handler(me.call("GET", "/v1/rank"))),
    );
    for (const res of responses) {
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { rank: null });
    }
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1);
  },
);

Deno.test(
  "[defect-pin] GET /v1/rank: a shot accepted while a cold rank build is in flight is served STALE from cache afterwards",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.shots = [];
    h.tables.player_technique_rating = [];
    h.rpcs.apply_synced_shot = "accepted";

    // Hold the cold rank read open until the sync has landed.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    overrides.push((req) =>
      req.url.startsWith(rest("player_technique_rating"))
        ? gate.then(() => jsonResponse(200, []))
        : null,
    );
    const slowRank = h.handler(me.call("GET", "/v1/rank"));
    // Let the rank handler reach its (blocked) DB read.
    await new Promise((r) => setTimeout(r, 30));

    const synced = await h.handler(me.call("POST", "/v1/shots:sync", { shots: [syncShot()] }));
    assertEquals(((await synced.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);
    // The new evidence is now in the DB…
    h.tables.player_technique_rating = [
      {
        shot_type: "dink",
        score: 7.2,
        captured_at: "2026-09-01T10:00:00.000Z",
        sampled_count: 1,
        confidence_weight: 1,
      },
    ];
    h.tables.player_rank_state = [
      {
        rating: 7.2,
        tier: "platinum",
        technique_count: 1,
        scored_shot_count: 1,
        updated_at: "2026-09-01T10:00:01.000Z",
      },
    ];
    overrides.length = 0;
    release();
    assertEquals(
      await (await slowRank).json(),
      { rank: null },
      "the in-flight build legitimately saw the old state",
    );

    // …but the completed stale build wrote itself into the cache AFTER the
    // sync's invalidation, so the next read is stale for up to 60s.
    const after = await h.handler(me.call("GET", "/v1/rank"));
    const body = (await after.json()) as { rank: unknown };
    // Current behaviour (defect): stale null rank. Desired: { rank: { rating: 7.2 … } }.
    assertEquals(body, { rank: null });
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1, "no re-read happened");
  },
);

// ─── GET /v1/progress ───────────────────────────────────────────────────────

Deno.test(
  "GET /v1/progress: empty history is an honest empty series with a zero streak",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.progress_daily = [];
    h.tables.practice_days = [];
    const res = await h.handler(me.call("GET", "/v1/progress"));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      series: [],
      improving: [],
      needsAttention: [],
      streak: { currentDays: 0, longestDays: 0, practicedToday: false, lastPracticeDate: null },
    });
  },
);

Deno.test(
  "GET /v1/progress: scores are ×10 for the contract and the streak folds practice days",
  async () => {
    const h = await harness();
    const me = identity();
    const today = new Date().toISOString().slice(0, 10);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    h.tables.progress_daily = [
      {
        day: daysAgo(2),
        shot_type: "dink",
        scoring_model_version: "v1",
        shot_count: 2,
        avg_score: 6.55,
        best_score: 7.1,
      },
    ];
    h.tables.practice_days = [
      { day: daysAgo(2) },
      { day: daysAgo(1) },
      { day: today },
      { day: daysAgo(10) },
    ];
    const res = await h.handler(me.call("GET", "/v1/progress"));
    const body = (await res.json()) as {
      series: Array<Record<string, unknown>>;
      streak: {
        currentDays: number;
        longestDays: number;
        practicedToday: boolean;
        lastPracticeDate: string;
      };
    };
    assertEquals(body.series[0].avg_score, 65.5);
    assertEquals(body.series[0].best_score, 71);
    assertEquals(body.streak, {
      currentDays: 3,
      longestDays: 3,
      practicedToday: true,
      lastPracticeDate: today,
    });
  },
);

Deno.test(
  "GET /v1/progress: >1000 progress_daily rows are paged (offset/limit), none are dropped",
  async () => {
    const h = await harness();
    const me = identity();
    const total = 2345;
    const rows = Array.from({ length: total }, (_, i) => ({
      day: new Date(Date.UTC(2020, 0, 1) + Math.floor(i / 3) * 86_400_000)
        .toISOString()
        .slice(0, 10),
      shot_type: ["dink", "serve", "drive"][i % 3],
      scoring_model_version: "v1",
      shot_count: 1,
      avg_score: 6,
      best_score: 6,
    }));
    const ranges: string[] = [];
    overrides.push((req) => {
      if (!req.url.startsWith(rest("progress_daily"))) return null;
      // supabase-js ≥2.x expresses .range(from, to) as offset/limit query params.
      const params = new URL(req.url).searchParams;
      const offset = Number(params.get("offset") ?? "0");
      const limit = Number(params.get("limit") ?? String(rows.length));
      ranges.push(`${offset}-${offset + limit - 1}`);
      return jsonResponse(200, rows.slice(offset, offset + limit));
    });
    h.tables.practice_days = [];
    const res = await h.handler(me.call("GET", "/v1/progress"));
    assertEquals(res.status, 200);
    const body = (await res.json()) as { series: unknown[] };
    assertEquals(body.series.length, total);
    assertEquals(ranges, ["0-999", "1000-1999", "2000-2999"]);
  },
);

Deno.test(
  "GET /v1/progress: a failing page read is a generic 503 (never a partial series)",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.progress_daily = [];
    overrides.push((req) =>
      req.url.startsWith(rest("practice_days"))
        ? jsonResponse(500, { message: "practice_days gone" })
        : null,
    );
    const res = await h.handler(me.call("GET", "/v1/progress"));
    assertEquals(res.status, 503);
    assert(!(await res.text()).includes("practice_days gone"));
  },
);

Deno.test(
  "GET /v1/progress: cached payload is served for repeat reads within the TTL (documented ≤60s staleness)",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.progress_daily = [];
    h.tables.practice_days = [];
    let res = await h.handler(me.call("GET", "/v1/progress"));
    await res.body?.cancel();
    h.tables.practice_days = [{ day: new Date().toISOString().slice(0, 10) }];
    res = await h.handler(me.call("GET", "/v1/progress"));
    const body = (await res.json()) as { streak: { practicedToday: boolean } };
    assertEquals(body.streak.practicedToday, false, "stale-by-design within the 60s window");
    assertEquals(h.callsTo("/rest/v1/practice_days").length, 1);
  },
);

// ─── Consent ────────────────────────────────────────────────────────────────

Deno.test(
  "consent: empty ledger folds to three inactive scopes; grant/withdraw append and re-fold",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.consent_records = [];
    let res = await h.handler(me.call("GET", "/v1/me/consent/status"));
    assertEquals(res.status, 200);
    const empty = (await res.json()) as {
      subjectPseudonym: null;
      scopes: Array<{ scope: string; active: boolean; lastAction: null }>;
    };
    assertEquals(empty.subjectPseudonym, null);
    assertEquals(empty.scopes.length, 3);
    for (const s of empty.scopes) {
      assertEquals(s.active, false);
      assertEquals(s.lastAction, null);
    }
    const scope = empty.scopes[0].scope;

    res = await h.handler(
      me.call("POST", "/v1/me/consent/grant", { scope: "nope", consentVersion: "v1" }),
    );
    assertEquals(res.status, 400);
    assertEquals((await errorOf(res)).code, "validation.consent_grant");
    res = await h.handler(me.call("POST", "/v1/me/consent/grant", { scope, consentVersion: "" }));
    assertEquals(res.status, 400);
    await res.body?.cancel();
    assertEquals(
      h.callsTo("/rest/v1/consent_records").filter((c) => c.method === "POST").length,
      0,
    );

    h.tables.consent_records = [
      { scope, action: "grant", consent_version: "v1", created_at: "2026-09-01T00:00:00Z" },
    ];
    res = await h.handler(
      me.call("POST", "/v1/me/consent/grant", {
        scope,
        consentVersion: "v1",
        source: "settings\u202e",
        device: "iPhone",
      }),
    );
    assertEquals(res.status, 200);
    const granted = (await res.json()) as {
      scopes: Array<{ scope: string; active: boolean; lastAction: string }>;
    };
    assertEquals(granted.scopes.find((s) => s.scope === scope)?.active, true);
    assertEquals(granted.scopes.find((s) => s.scope === scope)?.lastAction, "granted");
    const insert = h.callsTo("/rest/v1/consent_records").find((c) => c.method === "POST");
    assert(insert);
    assertEquals((insert.body as Record<string, unknown>).source, "settings", "bidi stripped");

    h.tables.consent_records = [
      { scope, action: "grant", consent_version: "v1", created_at: "2026-09-01T00:00:00Z" },
      { scope, action: "withdraw", consent_version: "v1", created_at: "2026-09-02T00:00:00Z" },
    ];
    res = await h.handler(me.call("POST", "/v1/me/consent/withdraw", { scope }));
    assertEquals(res.status, 200);
    const withdrawn = (await res.json()) as {
      scopes: Array<{ scope: string; active: boolean; lastAction: string; consentVersion: string }>;
    };
    const row = withdrawn.scopes.find((s) => s.scope === scope)!;
    assertEquals(row.active, false);
    assertEquals(row.lastAction, "withdrawn");
    assertEquals(row.consentVersion, "v1", "withdrawal carries the version forward");
    const wInsert = h
      .callsTo("/rest/v1/consent_records")
      .filter((c) => c.method === "POST")
      .at(-1)!;
    assertEquals((wInsert.body as Record<string, unknown>).action, "withdraw");
    assertEquals((wInsert.body as Record<string, unknown>).consent_version, "v1");
  },
);

Deno.test(
  "consent: ledger read failure is a generic 503 on status, grant and withdraw",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push((req) =>
      req.url.startsWith(rest("consent_records")) && req.method === "GET"
        ? jsonResponse(500, { message: "ledger down" })
        : null,
    );
    for (const [method, path, body] of [
      ["GET", "/v1/me/consent/status", undefined],
      ["POST", "/v1/me/consent/withdraw", { scope: "evaluation_telemetry" }],
    ] as const) {
      const res = await h.handler(me.call(method, path, body));
      assertEquals(res.status, 503, `${method} ${path}`);
      assert(!(await res.text()).includes("ledger down"));
    }
  },
);

// ─── Drills: catalog + saved ────────────────────────────────────────────────

Deno.test(
  "catalog drills: list/search/detail/404, and the saved flag reflects the user's bookmarks",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.user_saved_drills = [];
    let res = await h.handler(me.call("GET", "/v1/catalog/drills"));
    assertEquals(res.status, 200);
    const list = (await res.json()) as {
      items: Array<{ slug: string; saved: boolean; validation_state: string }>;
      cursor: null;
    };
    assert(list.items.length > 0);
    assertEquals(list.cursor, null);
    assert(list.items.every((i) => i.saved === false && i.validation_state === "PUBLISHED"));
    const slug = list.items[0].slug;

    h.tables.user_saved_drills = [{ slug }];
    res = await h.handler(
      me.call(
        "GET",
        `/v1/catalog/drills?q=${encodeURIComponent(list.items[0].slug.split("-")[0])}`,
      ),
    );
    const filtered = (await res.json()) as { items: Array<{ slug: string; saved: boolean }> };
    assert(filtered.items.length <= list.items.length);
    assertEquals(filtered.items.find((i) => i.slug === slug)?.saved, true);

    res = await h.handler(me.call("GET", `/v1/catalog/drills?family=no-such-family-xyz`));
    assertEquals(((await res.json()) as { items: unknown[] }).items, []);

    res = await h.handler(me.call("GET", `/v1/catalog/drills/${slug}`));
    assertEquals(res.status, 200);
    const detail = (await res.json()) as {
      drill: { slug: string; saved: boolean };
      mappings: unknown[];
      instructionalMedia: unknown[];
    };
    assertEquals(detail.drill.slug, slug);
    assertEquals(detail.drill.saved, true);
    assertEquals(detail.mappings, []);
    assert(Array.isArray(detail.instructionalMedia));

    res = await h.handler(me.call("GET", "/v1/catalog/drills/does-not-exist"));
    assertEquals(res.status, 404);
    assertEquals((await errorOf(res)).code, "drill.not_found");

    res = await h.handler(me.call("GET", "/v1/catalog/drills/%E0%A4%A"));
    assertEquals(res.status, 400);
    assertEquals((await errorOf(res)).message, "Malformed path segment.");
  },
);

Deno.test(
  "saved drills: empty list, invalid slug 400, save echoes saved_at, idempotent unsave is 204",
  async () => {
    const h = await harness();
    const me = identity();
    h.tables.user_saved_drills = [];
    let res = await h.handler(me.call("GET", "/v1/me/saved-drills"));
    assertEquals(await res.json(), { items: [] });

    res = await h.handler(me.call("PUT", "/v1/me/saved-drills/-bad"));
    assertEquals(res.status, 400);
    assertEquals((await errorOf(res)).code, "validation.saved_drill");
    res = await h.handler(me.call("PUT", `/v1/me/saved-drills/${"a".repeat(121)}`));
    assertEquals(res.status, 400);
    await res.body?.cancel();

    h.tables.user_saved_drills = [{ slug: "kitchen-line-dinks", saved_at: "2026-09-01T00:00:00Z" }];
    res = await h.handler(me.call("PUT", "/v1/me/saved-drills/kitchen-line-dinks"));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      slug: "kitchen-line-dinks",
      saved: true,
      savedAt: "2026-09-01T00:00:00Z",
    });
    const upsert = h.callsTo("/rest/v1/user_saved_drills").find((c) => c.method === "POST");
    assert(upsert);
    assertStringIncludes(upsert.headers["prefer"] ?? "", "resolution=ignore-duplicates");

    res = await h.handler(me.call("DELETE", "/v1/me/saved-drills/kitchen-line-dinks"));
    assertEquals(res.status, 204);
    assertEquals(await res.text(), "");
    res = await h.handler(me.call("DELETE", "/v1/me/saved-drills/never-saved"));
    assertEquals(res.status, 204);
  },
);

Deno.test(
  "[defect-pin] saved drills: bookmarking a slug that is NOT in the published catalog succeeds (orphan created)",
  async () => {
    const h = await harness();
    const me = identity();
    const slug = "this-drill-does-not-exist";
    let res = await h.handler(me.call("GET", `/v1/catalog/drills/${slug}`));
    assertEquals(res.status, 404, "precondition: not in catalog");
    await res.body?.cancel();
    h.tables.user_saved_drills = [{ slug, saved_at: "2026-09-01T00:00:00Z" }];
    res = await h.handler(me.call("PUT", `/v1/me/saved-drills/${slug}`));
    // Current behaviour: 200 and an upsert is issued. Desired: 404 drill.not_found, no write.
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(
      h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "POST").length,
      1,
    );

    res = await h.handler(me.call("GET", "/v1/me/saved-drills"));
    const first = (await res.json()) as {
      items: Array<{ id: string; slug: string; title: string; description: string }>;
    };
    assertEquals(first.items[0].slug, slug);
    assertEquals(first.items[0].title, slug);
    assertStringIncludes(first.items[0].description, "no longer in the published catalog");
    res = await h.handler(me.call("GET", "/v1/me/saved-drills"));
    const second = (await res.json()) as { items: Array<{ id: string }> };
    // Placeholder id is regenerated per call (pinned in drills_billing_healthz.test.ts too).
    assertNotEquals(first.items[0].id, second.items[0].id);
  },
);

Deno.test(
  "saved drills: bookmark table failure is a generic 503 on list, save and unsave",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push((req) =>
      req.url.startsWith(rest("user_saved_drills"))
        ? jsonResponse(500, { message: "bookmarks down" })
        : null,
    );
    for (const [method, path] of [
      ["GET", "/v1/me/saved-drills"],
      ["PUT", "/v1/me/saved-drills/kitchen-line-dinks"],
      ["DELETE", "/v1/me/saved-drills/kitchen-line-dinks"],
      ["GET", "/v1/catalog/drills"],
    ] as const) {
      const res = await h.handler(me.call(method, path));
      assertEquals(res.status, 503, `${method} ${path}`);
      assert(!(await res.text()).includes("bookmarks down"));
    }
  },
);

// ─── Account deletion ───────────────────────────────────────────────────────

const deletionRow = (challenge: string, ageMs: number, ttlMs = 15 * 60_000) => ({
  challenge,
  created_at: new Date(Date.now() - ageMs).toISOString(),
  expires_at: new Date(Date.now() - ageMs + ttlMs).toISOString(),
});

Deno.test(
  "delete-request: mints a fresh UUID challenge; malformed/unknown survey is ignored, valid survey is recorded with server-side context",
  async () => {
    const h = await harness();
    const me = identity();
    let res = await h.handler(
      me.call("POST", "/v1/me/delete-request", { survey: { reason: "not-a-reason" } }),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as { challenge: string; expiresAt: string };
    assert(/^[0-9a-f-]{36}$/.test(body.challenge));
    const ttl = Date.parse(body.expiresAt) - Date.now();
    assert(ttl > 14 * 60_000 && ttl <= 15 * 60_000, `ttl=${ttl}`);
    assertEquals(
      h.callsTo("/rest/v1/account_deletion_feedback").length,
      0,
      "unknown reason → no survey row",
    );
    const upsert = h.callsTo("/rest/v1/account_deletion_requests").find((c) => c.method === "POST");
    assert(upsert);
    assertStringIncludes(upsert.headers["prefer"] ?? "", "resolution=merge-duplicates");

    h.rpcs.access_state = [{ premium: true, scored_count: 2, reserved_count: 0 }];
    h.tables.profiles = [{ created_at: new Date(Date.now() - 40 * 86_400_000).toISOString() }];
    res = await h.handler(
      me.call("POST", "/v1/me/delete-request", {
        survey: {
          reason: "too_expensive",
          wanted: "bogus",
          details: "hi\u0007 there",
          platform: "ios",
          appVersion: "1.2.3",
        },
      }),
    );
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const feedback = h.callsTo("/rest/v1/account_deletion_feedback");
    assertEquals(feedback.length, 1);
    const sent = feedback[0].body as Record<string, unknown>;
    assertEquals(sent.reason, "too_expensive");
    assertEquals(sent.wanted, null, "unknown wanted value is dropped, not stored");
    assertEquals(sent.was_premium, true);
    assertEquals(sent.scored_count, 2);
    assertEquals(sent.account_age_days, 40);
    assertEquals(sent.details, "hi there");
    assertEquals(sent.platform, "ios");
    assertEquals(sent.app_version, "1.2.3");
    assertEquals(sent.provider, "google");
  },
);

Deno.test(
  "delete-request: a failing survey insert never turns the deletion request into an error",
  async () => {
    const h = await harness();
    const me = identity();
    h.rpcs.access_state = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    h.tables.profiles = [{ created_at: new Date().toISOString() }];
    overrides.push((req) =>
      req.url.startsWith(rest("account_deletion_feedback"))
        ? jsonResponse(500, { message: "feedback down" })
        : null,
    );
    const res = await h.handler(
      me.call("POST", "/v1/me/delete-request", { survey: { reason: "too_expensive" } }),
    );
    assertEquals(res.status, 200);
    assert(typeof ((await res.json()) as { challenge: string }).challenge === "string");
    assertEquals(
      h.callsTo("/rest/v1/account_deletion_feedback").length,
      1,
      "the insert was attempted",
    );
  },
);

Deno.test(
  "delete-request: challenge upsert failure is a 503 and no survey row is written (no double count on retry)",
  async () => {
    const h = await harness();
    const me = identity();
    overrides.push((req) =>
      req.url.startsWith(rest("account_deletion_requests")) && req.method === "POST"
        ? jsonResponse(500, { message: "requests down" })
        : null,
    );
    const res = await h.handler(
      me.call("POST", "/v1/me/delete-request", { survey: { reason: "too_expensive" } }),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
    assertEquals(h.callsTo("/rest/v1/account_deletion_feedback").length, 0);
  },
);

Deno.test(
  "delete-confirm: invalid/mismatched/expired/too-fast challenges are refused BEFORE any external or admin call",
  async () => {
    const h = await harness();
    const me = identity();
    const challenge = crypto.randomUUID();
    const attempts: Array<[string, unknown, number, string]> = [
      ["non-uuid", { challenge: "abc" }, 400, "validation.account_deletion"],
      ["no pending row", { challenge }, 403, "account.deletion_challenge_invalid"],
    ];
    h.tables.account_deletion_requests = [];
    for (const [label, body, status, code] of attempts) {
      const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", body));
      assertEquals(res.status, status, label);
      assertEquals((await errorOf(res)).code, code, label);
    }
    h.tables.account_deletion_requests = [deletionRow(crypto.randomUUID(), 10_000)];
    let res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 403);
    assertEquals((await errorOf(res)).code, "account.deletion_challenge_invalid");

    h.tables.account_deletion_requests = [deletionRow(challenge, 16 * 60_000)];
    res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 403);
    assertEquals((await errorOf(res)).code, "account.deletion_challenge_expired");

    h.tables.account_deletion_requests = [deletionRow(challenge, 500)];
    res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 429);
    assertEquals((await errorOf(res)).code, "account.deletion_too_fast");

    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
    assertEquals(h.callsTo(RC_URL).length, 0);
  },
);

Deno.test(
  "delete-confirm: RevenueCat outage aborts BEFORE the Supabase user is deleted (retry-safe), no checkpoint written",
  async () => {
    const h = await harness();
    const me = identity();
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
    h.tables.account_external_credentials = [];
    overrides.push((req) =>
      req.url.startsWith(RC_URL) ? new Response("down", { status: 503 }) : null,
    );
    const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 503);
    const text = await res.text();
    assert(!text.includes("RevenueCat"), text);
    assertEquals(
      h.callsTo("/auth/v1/admin/users/").length,
      0,
      "auth user must survive a provider failure",
    );
    assertEquals(
      h.callsTo("/rest/v1/account_external_credentials").filter((c) => c.method !== "GET").length,
      0,
    );
  },
);

Deno.test(
  "delete-confirm: Google account success erases RevenueCat, checkpoints it, deletes the auth user, and drops the bearer from the auth cache",
  async () => {
    const h = await harness();
    const me = identity();
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
    h.tables.account_external_credentials = [];
    // Warm the auth cache with a prior authenticated call.
    h.tables.consent_records = [];
    let res = await h.handler(me.call("GET", "/v1/me/consent/status"));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    const tokenExchangesBefore = h.callsTo("/auth/v1/token").length;
    assertEquals(tokenExchangesBefore, 1);

    res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      deleted: true,
      appleAuthorizationRevocation: "not_applicable",
    });
    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assertEquals(rc[0].method, "DELETE");
    assertEquals(rc[0].headers["authorization"], "Bearer sk_test_revenuecat");
    const checkpoint = h
      .callsTo("/rest/v1/account_external_credentials")
      .find((c) => c.method === "POST");
    assert(checkpoint);
    assert(typeof (checkpoint.body as Record<string, unknown>).revenuecat_deleted_at === "string");
    assertEquals(
      checkpoint.headers["authorization"],
      "Bearer service-role-test-key",
      "checkpoint is a service-role write",
    );
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
    assertEquals(
      h.callsTo("/auth/v1/token").length,
      1,
      "delete-confirm itself was served from the auth cache",
    );

    // The same bearer must now be re-verified with Supabase Auth, not served from cache.
    res = await h.handler(me.call("GET", "/v1/me/consent/status"));
    await res.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/token").length, 2);
  },
);

Deno.test(
  "delete-confirm: already-checkpointed RevenueCat erasure is not repeated on retry",
  async () => {
    const h = await harness();
    const me = identity();
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: null,
        apple_revoked_at: null,
        revenuecat_deleted_at: "2026-09-01T00:00:00Z",
      },
    ];
    const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 200);
    await res.body?.cancel();
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "delete-confirm: Apple account with no stored revocation token is fulfilled and reports manual_action_required",
  async () => {
    const h = await harness();
    const me = identity("apple");
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
    h.tables.account_external_credentials = [];
    const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), {
      deleted: true,
      appleAuthorizationRevocation: "manual_action_required",
    });
    assertEquals(h.callsTo("https://appleid.apple.com/auth/revoke").length, 0);
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
  },
);

Deno.test(
  "delete-confirm: GoTrue user_not_found on deleteUser is treated as already deleted (idempotent replay)",
  async () => {
    const h = await harness();
    const me = identity();
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: null,
        apple_revoked_at: null,
        revenuecat_deleted_at: "2026-09-01T00:00:00Z",
      },
    ];
    overrides.push((req) =>
      req.method === "DELETE" && req.url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)
        ? jsonResponse(404, { code: 404, error_code: "user_not_found", msg: "User not found" })
        : null,
    );
    const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
    assertEquals(res.status, 200);
    assertEquals(((await res.json()) as { deleted: boolean }).deleted, true);
  },
);

Deno.test("delete-confirm: any other GoTrue admin failure is a generic 503", async () => {
  const h = await harness();
  const me = identity();
  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [deletionRow(challenge, 10_000)];
  h.tables.account_external_credentials = [
    {
      apple_refresh_token_encrypted: null,
      apple_revoked_at: null,
      revenuecat_deleted_at: "2026-09-01T00:00:00Z",
    },
  ];
  overrides.push((req) =>
    req.method === "DELETE" && req.url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)
      ? jsonResponse(500, { code: 500, msg: "database error deleting user" })
      : null,
  );
  const res = await h.handler(me.call("POST", "/v1/me/delete-confirm", { challenge }));
  assertEquals(res.status, 503);
  assert(!(await res.text()).includes("database error"));
});

// ─── Legal / public + router edges ──────────────────────────────────────────

Deno.test(
  "legal pages: 60 reads per IP per minute, the 61st is 429 with Retry-After; healthz has its own bucket",
  async () => {
    const h = await harness();
    const ip = nextIp();
    const get = (path: string) =>
      h.handler(
        new Request(`http://edge.test/functions/v1/api${path}`, {
          headers: { "x-forwarded-for": ip },
        }),
      );
    for (let i = 0; i < 60; i += 1) {
      const res = await get(i % 3 === 0 ? "/privacy" : i % 3 === 1 ? "/terms" : "/support");
      assertEquals(res.status, 200, `read ${i + 1}`);
      await res.body?.cancel();
    }
    const limited = await get("/privacy");
    assertEquals(limited.status, 429);
    assert(Number(limited.headers.get("retry-after")) >= 1);
    await limited.body?.cancel();
    const health = await get("/healthz");
    assertEquals(health.status, 200, "healthz is a separate budget");
    await health.body?.cancel();
  },
);

Deno.test(
  "legal pages: text/plain UTF-8, publicly cacheable, and HEAD answers 200 with the same headers",
  async () => {
    const h = await harness();
    const ip = nextIp();
    for (const path of ["/privacy", "/terms", "/support"]) {
      const res = await h.handler(
        new Request(`http://edge.test/functions/v1/api${path}`, {
          headers: { "x-forwarded-for": ip },
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assertEquals(res.headers.get("cache-control"), "public, max-age=3600");
      assertEquals(res.headers.get("x-content-type-options"), "nosniff");
      const text = await res.text();
      assert(text.length > 1000, `${path} is substantive`);
      assertStringIncludes(text, "picklesenseidev@gmail.com");
      const head = await h.handler(
        new Request(`http://edge.test/functions/v1/api${path}`, {
          method: "HEAD",
          headers: { "x-forwarded-for": ip },
        }),
      );
      assertEquals(head.status, 200);
      assertEquals(head.headers.get("content-type"), "text/plain; charset=utf-8");
      assertEquals(head.headers.get("cache-control"), "public, max-age=3600");
      // Body stripping for HEAD is the HTTP server's job (Deno.serve), not the
      // handler's; router_test pins that through a real listener.
      await head.body?.cancel();
    }
  },
);

Deno.test(
  "router: unknown routes and method mismatches are JSON 404s that echo only the method + path",
  async () => {
    const h = await harness();
    const me = identity();
    const cases: Array<[string, string]> = [
      ["GET", "/v1/shots:sync"],
      ["POST", "/v1/me"],
      ["GET", "/v1/me/saved-drills/slug"],
      ["DELETE", "/v1/me"],
      ["GET", "/v1/nope"],
    ];
    for (const [method, path] of cases) {
      const res = await h.handler(me.call(method, path));
      assertEquals(res.status, 404, `${method} ${path}`);
      assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
      assertStringIncludes((await errorOf(res)).message, `${method} ${path}`);
    }
  },
);

Deno.test("router: training plans are honest empty/unavailable states", async () => {
  const h = await harness();
  const me = identity();
  let res = await h.handler(me.call("GET", "/v1/training-plans/current"));
  assertEquals(await res.json(), { plan: null });
  res = await h.handler(me.call("POST", "/v1/training-plans", {}));
  assertEquals(res.status, 409);
  assertEquals((await errorOf(res)).code, "training.plan_unavailable");
});

Deno.test(
  "router: every response carries x-request-id and a client-supplied one is echoed",
  async () => {
    const h = await harness();
    const me = identity();
    const res = await h.handler(
      me.call("GET", "/v1/training-plans/current", undefined, { "x-request-id": "client-req-123" }),
    );
    assertEquals(res.headers.get("x-request-id"), "client-req-123");
    await res.body?.cancel();
    const auto = await h.handler(me.call("GET", "/v1/training-plans/current"));
    assert((auto.headers.get("x-request-id") ?? "").length > 0);
    await auto.body?.cancel();
  },
);
