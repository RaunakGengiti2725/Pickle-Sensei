// STRUCTURAL AUDIT #1 (edge-domain-routes) — session-cache lifecycle,
// account deletion ordering/checkpoints, exit-survey vocabulary, route
// stubs, per-route budgets, onboarding caps, webhook replay dedupe and the
// user-facing copy policy. Real handler via routesHarness.
//
// Tests titled "REPRO:" are expected to FAIL on 4d812e1a (they encode the
// contract, not the current behaviour); everything else pins verified-good
// behaviour that had no HTTP-level test.

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  RC_URL,
  SUPABASE_URL,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import { drillCatalog } from "../drills.ts";

type FetchFn = typeof fetch;

let ipCounter = 0;
function freshIdentity(provider: "google" | "apple" = "google") {
  ipCounter += 1;
  const userId = crypto.randomUUID();
  const token = provider === "google"
    ? fakeGoogleIdToken(userId)
    : fakeAppleIdToken(userId);
  return { userId, token, ip: `198.51.100.${ipCounter}` };
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued access token as the durable-session contract sends it
 * (iss ends in /auth/v1). The harness has no /auth/v1/user stub, so tests
 * that use one intercept that call. */
function fakeSessionJwt(sub: string, nonce: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: nonce,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
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

/** Stub GoTrue's GET /auth/v1/user (session-token verification) and
 * POST /auth/v1/logout for the duration of `fn`. */
function withGoTrueUser<T>(
  userId: string,
  provider: "google" | "apple",
  fn: () => Promise<T>,
  onUserCall?: () => void,
  logoutUrls: string[] = [],
): Promise<T> {
  return withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "GET" &&
          request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)
        ) {
          onUserCall?.();
          return jsonRes(200, {
            id: userId,
            aud: "authenticated",
            role: "authenticated",
            email: "user@example.com",
            app_metadata: { provider, providers: [provider] },
            user_metadata: {},
            created_at: new Date().toISOString(),
          });
        }
        if (
          request.method === "POST" &&
          request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)
        ) {
          logoutUrls.push(request.url);
          return new Response(null, { status: 204 });
        }
        return inner(input, init);
      }) as FetchFn,
    fn,
  );
}

const profileRow = (id: string) => ({
  id,
  email: "user@example.com",
  onboarding_state: "complete",
  provider: "google",
  skill_level: "beginner",
  handedness: "right",
  primary_goal: "consistency",
  biggest_problem: "popping up dinks",
  focus_checkpoint: "contact_position",
  first_name: null,
  gender: null,
});

// ── Session cache lifecycle ──────────────────────────────────────────────────

Deno.test("auth cache — a verified session bearer is cached: GoTrue consulted once for repeated GETs", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.profiles = [profileRow(me.userId)];
  let userCalls = 0;
  await withGoTrueUser(me.userId, "google", async () => {
    const bearer = fakeSessionJwt(me.userId, "device-a");
    for (let i = 0; i < 3; i++) {
      const res = await h.handler(
        userRequest("GET", "/v1/me", { token: bearer, ip: me.ip }),
      );
      assertEquals(res.status, 200);
      await res.body?.cancel();
    }
  }, () => userCalls++);
  assertEquals(userCalls, 1);
});

Deno.test("auth cache — POST /v1/auth/logout evicts THIS bearer (next call re-verifies) and calls GoTrue with scope=local", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.profiles = [profileRow(me.userId)];
  let userCalls = 0;
  const logoutUrls: string[] = [];
  await withGoTrueUser(
    me.userId,
    "google",
    async () => {
      const bearer = fakeSessionJwt(me.userId, "device-a");
      await (await h.handler(
        userRequest("GET", "/v1/me", { token: bearer, ip: me.ip }),
      )).body?.cancel();
      assertEquals(userCalls, 1);
      const out = await h.handler(
        userRequest("POST", "/v1/auth/logout", { token: bearer, ip: me.ip }),
      );
      assertEquals(out.status, 204);
      assertEquals(logoutUrls.length, 1);
      assert(logoutUrls[0].includes("scope=local"), logoutUrls[0]);
      await (await h.handler(
        userRequest("GET", "/v1/me", { token: bearer, ip: me.ip }),
      )).body?.cancel();
      assertEquals(userCalls, 2, "bearer must be re-verified after logout");
    },
    () => userCalls++,
    logoutUrls,
  );
});

Deno.test("auth — transitional: a raw Google ID token is accepted as bearer on a domain route (documented removal pending)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.profiles = [profileRow(me.userId)];
  const res = await h.handler(
    userRequest("GET", "/v1/me", { token: me.token, ip: me.ip }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  // The provider token is exchanged with GoTrue (signInWithIdToken) — it is
  // not trusted on its own signature.
  assertEquals(h.callsTo("/auth/v1/token").length, 1);
});

// ── Account deletion ─────────────────────────────────────────────────────────

function pendingDeletion(challenge: string) {
  return {
    challenge,
    created_at: new Date(Date.now() - 10_000).toISOString(),
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  };
}

Deno.test("deletion — confirm evicts the confirming bearer; a second device's cached bearer for the same user is still served from cache (documented ≤10 min window)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.profiles = [profileRow(me.userId)];
  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [pendingDeletion(challenge)];
  h.tables.account_external_credentials = [];
  let userCalls = 0;
  await withGoTrueUser(me.userId, "google", async () => {
    const deviceA = fakeSessionJwt(me.userId, "device-a");
    const deviceB = fakeSessionJwt(me.userId, "device-b");
    await (await h.handler(
      userRequest("GET", "/v1/me", { token: deviceA, ip: me.ip }),
    )).body?.cancel();
    await (await h.handler(
      userRequest("GET", "/v1/me", { token: deviceB, ip: me.ip }),
    )).body?.cancel();
    assertEquals(userCalls, 2);

    const confirm = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: deviceA,
        ip: me.ip,
        body: { challenge },
      }),
    );
    assertEquals(confirm.status, 200);
    assertEquals(await confirm.json(), {
      deleted: true,
      appleAuthorizationRevocation: "not_applicable",
    });
    assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);

    // Device A's bearer must be re-verified (cache evicted).
    await (await h.handler(
      userRequest("GET", "/v1/me", { token: deviceA, ip: me.ip }),
    )).body?.cancel();
    assertEquals(userCalls, 3, "confirming bearer must be evicted");

    // Device B: still served from the verified-session cache without asking
    // GoTrue. This is the documented residual window (index.ts:2625-2628);
    // pinned here so a future change to the contract is deliberate.
    await (await h.handler(
      userRequest("GET", "/v1/me", { token: deviceB, ip: me.ip }),
    )).body?.cancel();
    assertEquals(
      userCalls,
      3,
      "device B is served from cache (no GoTrue re-check)",
    );
  }, () => userCalls++);
});

Deno.test("deletion — Apple revoke is checkpointed: RevenueCat 5xx after the revoke → 503, retry skips Apple and completes", async () => {
  const h = await loadHarness();
  const me = freshIdentity("apple");
  h.tables.profiles = [{ ...profileRow(me.userId), provider: "apple" }];

  // The encrypted refresh token exactly as bootstrap stores it (AAD = user id).
  const encrypted = await encryptAppleRefreshToken(
    "apple-refresh-token",
    me.userId,
    h.appleTokenEncryptionKey,
  );

  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [pendingDeletion(challenge)];
  const credentials: {
    apple_refresh_token_encrypted: string;
    apple_revoked_at: string | null;
    revenuecat_deleted_at: string | null;
  } = {
    apple_refresh_token_encrypted: encrypted,
    apple_revoked_at: null,
    revenuecat_deleted_at: null,
  };
  h.tables.account_external_credentials = [credentials];
  const revokesBefore = h.callsTo("appleid.apple.com/auth/revoke").length;

  const first = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "DELETE" && request.url.startsWith(RC_URL)) {
          return new Response("upstream error", { status: 502 });
        }
        if (
          request.method === "PATCH" &&
          request.url.includes("/rest/v1/account_external_credentials")
        ) {
          // Persist the Apple checkpoint like PostgREST would.
          const patch = (await request.clone().json()) as {
            apple_revoked_at?: string;
          };
          credentials.apple_revoked_at = patch.apple_revoked_at ?? null;
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: me.token,
          ip: me.ip,
          body: { challenge },
        }),
      ),
  );
  assertEquals(first.status, 503);
  assert(!(await first.text()).includes("upstream error"));
  assertEquals(
    h.callsTo("appleid.apple.com/auth/revoke").length,
    revokesBefore + 1,
  );
  assertEquals(
    h.callsTo("/auth/v1/admin/users/").length,
    0,
    "auth.users must survive a failed external step",
  );
  assertNotEquals(credentials.apple_revoked_at, null);

  const retry = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: me.token,
      ip: me.ip,
      body: { challenge },
    }),
  );
  assertEquals(retry.status, 200);
  assertEquals(await retry.json(), {
    deleted: true,
    appleAuthorizationRevocation: "revoked",
  });
  assertEquals(
    h.callsTo("appleid.apple.com/auth/revoke").length,
    revokesBefore + 1,
    "Apple must not be revoked twice",
  );
  assertEquals(h.callsTo("/auth/v1/admin/users/").length, 1);
});

Deno.test("deletion — challenge mismatch → 403 invalid; expired → 403 expired; neither touches external providers", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.tables.account_deletion_requests = [pendingDeletion(crypto.randomUUID())];
  const wrong = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: me.token,
      ip: me.ip,
      body: { challenge: crypto.randomUUID() },
    }),
  );
  assertEquals(wrong.status, 403);
  assertEquals(
    ((await wrong.json()) as { error: { code: string } }).error.code,
    "account.deletion_challenge_invalid",
  );

  const challenge = crypto.randomUUID();
  h.tables.account_deletion_requests = [
    {
      ...pendingDeletion(challenge),
      expires_at: new Date(Date.now() - 1_000).toISOString(),
    },
  ];
  const expired = await h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: me.token,
      ip: me.ip,
      body: { challenge },
    }),
  );
  assertEquals(expired.status, 403);
  assertEquals(
    ((await expired.json()) as { error: { code: string } }).error.code,
    "account.deletion_challenge_expired",
  );
  assertEquals(h.callsTo(RC_URL).length, 0);
  assertEquals(h.callsTo("/auth/v1/admin/users/").length, 0);
});

Deno.test("deletion — exit survey: unknown reason drops the survey (deletion still 200); details capped at 500; unknown wanted → null", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 1,
    reserved_count: 0,
  }];
  h.tables.profiles = [{
    ...profileRow(me.userId),
    created_at: new Date(Date.now() - 5 * 86_400_000).toISOString(),
  }];

  const ignored = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: me.token,
      ip: me.ip,
      body: { survey: { reason: "hates_it" } },
    }),
  );
  assertEquals(ignored.status, 200);
  await ignored.body?.cancel();
  assertEquals(h.callsTo("/rest/v1/account_deletion_feedback").length, 0);

  const recorded = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: me.token,
      ip: me.ip,
      body: {
        survey: {
          reason: "too_expensive",
          wanted: "a_pony",
          details: "x".repeat(700),
          platform: "ios",
          appVersion: "1.2.3",
        },
      },
    }),
  );
  assertEquals(recorded.status, 200);
  const body = (await recorded.json()) as {
    challenge: string;
    expiresAt: string;
  };
  assert(/^[0-9a-f-]{36}$/.test(body.challenge));
  const inserted = h.callsTo("/rest/v1/account_deletion_feedback").find((c) =>
    c.method === "POST"
  )?.body as Record<
    string,
    unknown
  >;
  assertEquals(inserted.reason, "too_expensive");
  assertEquals(inserted.wanted, null);
  assertEquals((inserted.details as string).length, 500);
  assertEquals(inserted.platform, "ios");
  assertEquals(inserted.provider, "google");
  assertEquals(inserted.account_age_days, 5);
  assertEquals(inserted.was_premium, false);
  assertEquals(inserted.scored_count, 1);
});

Deno.test("REPRO: deletion — exit survey accepts platform 'android' (server vocabulary for an iPhone-only product)", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  h.rpcs.access_state = [{
    premium: false,
    scored_count: 0,
    reserved_count: 0,
  }];
  h.tables.profiles = [profileRow(me.userId)];
  const res = await h.handler(
    userRequest("POST", "/v1/me/delete-request", {
      token: me.token,
      ip: me.ip,
      body: { survey: { reason: "other", platform: "android" } },
    }),
  );
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const inserted = h.callsTo("/rest/v1/account_deletion_feedback").find((c) =>
    c.method === "POST"
  )?.body as {
    platform: string | null;
  };
  // Contract: only "ios" is a shipping platform; anything else is "not stated".
  assertEquals(inserted.platform, null);
});

// ── Route stubs and unrouted client calls ────────────────────────────────────

Deno.test("training — GET current → {plan:null}; POST → 409 training.plan_unavailable; client-only endpoints are 404", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const current = await h.handler(
    userRequest("GET", "/v1/training-plans/current", {
      token: me.token,
      ip: me.ip,
    }),
  );
  assertEquals(current.status, 200);
  assertEquals(await current.json(), { plan: null });

  const create = await h.handler(
    userRequest("POST", "/v1/training-plans", {
      token: me.token,
      ip: me.ip,
      body: { shotId: crypto.randomUUID() },
    }),
  );
  assertEquals(create.status, 409);
  assertEquals(
    ((await create.json()) as { error: { code: string } }).error.code,
    "training.plan_unavailable",
  );

  // apps/mobile/src/training/api.ts:536,541 call these; the edge never routes them.
  const completion = await h.handler(
    userRequest("POST", "/v1/drill-completions", {
      token: me.token,
      ip: me.ip,
      body: {},
    }),
  );
  assertEquals(completion.status, 404);
  await completion.body?.cancel();
  const reassess = await h.handler(
    userRequest(
      "POST",
      `/v1/training-plans/${crypto.randomUUID()}/reassessment`,
      {
        token: me.token,
        ip: me.ip,
        body: { shotId: crypto.randomUUID() },
      },
    ),
  );
  assertEquals(reassess.status, 404);
  await reassess.body?.cancel();
});

// ── Per-route budgets (not pinned anywhere) ──────────────────────────────────

async function exhaust(
  h: Awaited<ReturnType<typeof loadHarness>>,
  make: () => Request,
  limit: number,
): Promise<Response> {
  for (let i = 0; i < limit; i++) {
    const res = await h.handler(make());
    assertNotEquals(
      res.status,
      429,
      `request ${i + 1} of ${limit} must not be throttled`,
    );
    await res.body?.cancel();
  }
  return h.handler(make());
}

Deno.test("budgets — POST /v1/shots:sync 30/min per user → 31st is 429 with Retry-After", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const over = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/shots:sync", {
        token: me.token,
        ip: me.ip,
        body: { shots: [] },
      }),
    30,
  );
  assertEquals(over.status, 429);
  assert(Number(over.headers.get("retry-after")) > 0);
  await over.body?.cancel();
});

Deno.test("budgets — POST /v1/analysis-permits 30/min per user → 31st is 429", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const over = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/analysis-permits", {
        token: me.token,
        ip: me.ip,
        body: {},
      }),
    30,
  );
  assertEquals(over.status, 429);
  await over.body?.cancel();
});

Deno.test("budgets — POST /v1/me/delete-request 3/h and delete-confirm 5/h per user", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const overRequest = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/me/delete-request", {
        token: me.token,
        ip: me.ip,
        body: {},
      }),
    3,
  );
  assertEquals(overRequest.status, 429);
  assert(Number(overRequest.headers.get("retry-after")) > 60);
  await overRequest.body?.cancel();

  const overConfirm = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/me/delete-confirm", {
        token: me.token,
        ip: me.ip,
        body: { challenge: "nope" },
      }),
    5,
  );
  assertEquals(overConfirm.status, 429);
  await overConfirm.body?.cancel();
});

Deno.test("budgets — POST /v1/me/evaluation/trials 12/min and consent 30/min per user", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const overTrials = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/me/evaluation/trials", {
        token: me.token,
        ip: me.ip,
        body: {},
      }),
    12,
  );
  assertEquals(overTrials.status, 429);
  await overTrials.body?.cancel();

  const overConsent = await exhaust(
    h,
    () =>
      userRequest("POST", "/v1/me/consent/grant", {
        token: me.token,
        ip: me.ip,
        body: {},
      }),
    30,
  );
  assertEquals(overConsent.status, 429);
  await overConsent.body?.cancel();
});

// ── Onboarding caps ──────────────────────────────────────────────────────────

Deno.test("onboarding — goal >64 / biggestProblem >256 / firstName >40 / unknown gender → 400; unknown goal → focus 'contact_position'", async () => {
  const h = await loadHarness();
  const me = freshIdentity();
  const base = {
    skillLevel: "beginner",
    handedness: "right",
    goal: "consistency",
    biggestProblem: "pop-ups",
  };
  const put = (body: Record<string, unknown>) =>
    h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        token: me.token,
        ip: me.ip,
        body,
      }),
    );

  for (
    const bad of [
      { ...base, goal: "g".repeat(65) },
      { ...base, biggestProblem: "p".repeat(257) },
      { ...base, firstName: "n".repeat(41) },
      { ...base, firstName: 42 },
      { ...base, gender: "unknown" },
      { ...base, handedness: "both" },
    ]
  ) {
    const res = await put(bad);
    assertEquals(res.status, 400, JSON.stringify(bad).slice(0, 80));
    await res.body?.cancel();
  }
  assertEquals(
    h.callsTo("/rest/v1/profiles").filter((c) => c.method === "PATCH").length,
    0,
  );

  let patch: Record<string, unknown> = {};
  const saved = await withFetch(
    (inner) =>
      (async (input, init) => {
        const request = new Request(input, init);
        if (
          request.method === "PATCH" &&
          request.url.includes("/rest/v1/profiles")
        ) {
          patch = (await request.clone().json()) as Record<string, unknown>;
          return jsonRes(200, { ...profileRow(me.userId), ...patch });
        }
        return inner(input, init);
      }) as FetchFn,
    () =>
      put({
        ...base,
        goal: "something-new",
        firstName: "  Ada\u200b ",
        gender: "female",
      }),
  );
  assertEquals(saved.status, 200);
  await saved.body?.cancel();
  assertEquals(patch.focus_checkpoint, "contact_position");
  assertEquals(patch.onboarding_state, "complete");
  assertEquals(patch.first_name, "Ada");
  assertEquals(patch.gender, "female");
});

// ── Webhook replay ───────────────────────────────────────────────────────────

Deno.test("webhook — an event id already in webhook_events is acknowledged as duplicate with no RevenueCat call and no write", async () => {
  const h = await loadHarness();
  h.tables.webhook_events = [{ id: "evt-seen" }];
  const res = await h.handler(
    webhookRequest({
      id: "evt-seen",
      type: "RENEWAL",
      app_user_id: crypto.randomUUID(),
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { received: true, duplicate: true });
  assertEquals(h.callsTo(RC_URL).length, 0);
  assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
});

// ── Copy policy (APP_STORE_SUBMISSION.md §1.4 + project hard rule) ───────────

const FORBIDDEN_COPY = [
  /Google Play/i,
  /\bAndroid\b/i,
  /\bDUPR\b/,
  /Selkirk/i,
  /JOOLA/i,
  /SwingVision/i,
  /PB Vision/i,
  /guest mode/i,
  /Live Court/i,
];

function forbiddenHits(label: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const re of FORBIDDEN_COPY) {
      if (re.test(line)) {
        hits.push(
          `${label}:${index + 1} ${re.source} → ${line.trim().slice(0, 90)}`,
        );
      }
    }
  });
  return hits;
}

Deno.test("REPRO: copy — legal texts served at the App-Store-listed /privacy and /terms URLs contain forbidden vocabulary", () => {
  const hits = [
    ...forbiddenHits("legal.ts SUPPORT_TEXT", SUPPORT_TEXT),
    ...forbiddenHits("legal.ts PRIVACY_POLICY_TEXT", PRIVACY_POLICY_TEXT),
    ...forbiddenHits("legal.ts TERMS_TEXT", TERMS_TEXT),
  ];
  assertEquals(
    hits,
    [],
    `forbidden user-facing vocabulary:\n${hits.join("\n")}`,
  );
});

Deno.test("REPRO: copy — drill media/catalog payloads sent to the app carry a competitor brand", async () => {
  const hits: string[] = [];
  for (const drill of await drillCatalog()) {
    hits.push(
      ...forbiddenHits(`drills.ts ${drill.slug}`, JSON.stringify(drill)),
    );
    for (const media of await drillInstructionalMedia(drill.slug)) {
      hits.push(
        ...forbiddenHits(`drillMedia.ts ${drill.slug}`, JSON.stringify(media)),
      );
    }
  }
  assertEquals(
    hits,
    [],
    `forbidden user-facing vocabulary:\n${hits.join("\n")}`,
  );
});
