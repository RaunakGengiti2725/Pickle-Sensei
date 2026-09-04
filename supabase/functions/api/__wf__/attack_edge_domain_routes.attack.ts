// ADVERSARIAL attack cases against the EDR-1/EDR-2/EDR-3 fix (e52c45e8).
//
// Deliberately NOT named *.test.ts so `deno task test` does not sweep it: each
// ATTACK case asserts the CONTRACT behaviour the fix claims and therefore
// FAILS on the candidate where the fix is incomplete; the HOLD cases pin
// variants the fix handles correctly and PASS (they document what was tried).
//
// Run:
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_edge_domain_routes.attack.ts
//
// Every case drives the REAL handler via routesHarness (fetch-level stubs for
// PostgREST / GoTrue / RevenueCat / Apple; no network, no production project).

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import { fakeAppleIdToken, fakeGoogleIdToken, loadHarness, RC_URL, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

type FetchFn = typeof fetch;

async function withFetchIntercept<T>(
  intercept: (request: Request) => Promise<Response | null>,
  run: () => Promise<T>,
): Promise<T> {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const owned = await intercept(request.clone());
    if (owned) {
      h.calls.push({ url: request.url, method: request.method, headers: {}, body: null });
      return owned;
    }
    return inner(input, init);
  }) as FetchFn;
  try {
    return await run();
  } finally {
    globalThis.fetch = inner;
  }
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function pendingDeletion(challenge: string) {
  return [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
}

let userCounter = 0;
function freshUser(provider: "google" | "apple") {
  userCounter += 1;
  const userId = crypto.randomUUID();
  h.tables.profiles = [{ id: userId, email: "u@example.com", provider }];
  const token = provider === "apple" ? fakeAppleIdToken(userId) : fakeGoogleIdToken(userId);
  return { userId, token, ip: `203.0.113.${150 + userCounter}` };
}

const revenueCatDeletes = () =>
  h.calls.filter((c) => c.url.startsWith(RC_URL) && c.method === "DELETE");
const authAdminDeletes = () =>
  h.calls.filter((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE");
const credentialCleared = () =>
  h.calls.filter(
    (c) =>
      c.url.includes("/rest/v1/account_external_credentials") &&
      c.method === "PATCH" &&
      c.body !== null &&
      typeof c.body === "object" &&
      (c.body as Record<string, unknown>).apple_refresh_token_encrypted === null,
  );

function syncShotBody() {
  return {
    shots: [
      {
        id: crypto.randomUUID(),
        source: "real",
        analysisPermitId: crypto.randomUUID(),
        sessionId: null,
        shotType: "dink",
        cameraView: "side",
        capturedAt: new Date().toISOString(),
        timestamps: { startMs: 0, contactMs: 500, endMs: 1000 },
        resultKind: "scored",
        overallScore: 7.5,
        confidence: 0.9,
        phases: [],
        checkpoints: [],
        versionVector: {
          appVersion: "1.0.0",
          modelBundleVersion: "1",
          poseModelVersion: "1",
          paddleModelVersion: "1",
          strokeDetectorVersion: "1",
          phaseModelVersion: "1",
          scoringModelVersion: "1",
          shotConfigVersion: "1",
        },
      },
    ],
  };
}

// ─── EDR-2 ──────────────────────────────────────────────────────────────────

Deno.test(
  "ATTACK EDR-2a: stored ciphertext whose IV segment is not base64 (corrupt row) → decrypt throws kind 'configuration' → 503 forever (fix's own doc says corrupt ciphertext is permanent)",
  async () => {
    h.reset();
    const challenge = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { userId, token } = freshUser("apple");
    const good = await encryptAppleRefreshToken("refresh-ok", userId, h.appleTokenEncryptionKey);
    const [, , ciphertext] = good.split(".");
    h.tables.account_external_credentials = [
      {
        // Same shape (v1.<iv>.<ct>) but the IV bytes were corrupted into
        // characters outside the base64 alphabet.
        apple_refresh_token_encrypted: `v1.!!!!!!!!!!!!!!!!.${ciphertext}`,
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const attempt = () =>
      h.handler(userRequest("POST", "/v1/me/delete-confirm", { token, body: { challenge } }));
    const first = await attempt();
    const firstBody = await first.json();
    const second = await attempt();
    const secondBody = (await second.json()) as { appleAuthorizationRevocation?: string };
    assertEquals(
      second.status,
      200,
      `retry still fails: ${first.status} ${JSON.stringify(firstBody)} then ${second.status} ${JSON.stringify(secondBody)}`,
    );
    assertEquals(secondBody.appleAuthorizationRevocation, "manual_action_required");
    assert(revenueCatDeletes().length >= 1, "RevenueCat subscriber was never erased");
    assert(authAdminDeletes().length >= 1, "Supabase identity was never deleted");
  },
);

Deno.test(
  "ATTACK EDR-2b: Apple 400 invalid_client (server client_secret misconfiguration / clock skew) is classified PERMANENT → stored token nulled, deletion proceeds; expected 503 + token kept (fix doc: 'a misconfigured server — NOT permanent')",
  async () => {
    h.reset();
    const challenge = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { userId, token } = freshUser("apple");
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-valid-at-apple",
          userId,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const res = await withFetchIntercept(
      async (request) => {
        if (request.url === "https://appleid.apple.com/auth/revoke") {
          return jsonResponse(400, { error: "invalid_client" });
        }
        return null;
      },
      () => h.handler(userRequest("POST", "/v1/me/delete-confirm", { token, body: { challenge } })),
    );
    const body = await res.json();
    assertEquals(
      credentialCleared().length,
      0,
      `the user's ONLY Apple revocation credential was destroyed on a server-side client_secret failure: ${res.status} ${JSON.stringify(body)}`,
    );
    assertEquals(res.status, 503, JSON.stringify(body));
    assertEquals(revenueCatDeletes().length, 0);
    assertEquals(authAdminDeletes().length, 0);
  },
);

Deno.test(
  "HOLD EDR-2c: Apple 429 → 503, token kept, neither RevenueCat nor admin delete (transient)",
  async () => {
    h.reset();
    const challenge = "cccccccc-3333-4333-8333-cccccccccccc";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { userId, token } = freshUser("apple");
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-valid",
          userId,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const res = await withFetchIntercept(
      async (request) => {
        if (request.url === "https://appleid.apple.com/auth/revoke") {
          return new Response(null, { status: 429 });
        }
        return null;
      },
      () => h.handler(userRequest("POST", "/v1/me/delete-confirm", { token, body: { challenge } })),
    );
    assertEquals(res.status, 503);
    await res.body?.cancel();
    assertEquals(credentialCleared().length, 0);
    assertEquals(revenueCatDeletes().length, 0);
    assertEquals(authAdminDeletes().length, 0);
  },
);

Deno.test(
  "HOLD EDR-2d: APPLE_TOKEN_ENCRYPTION_KEY misconfigured (not 32 bytes) → 503, token kept (server misconfig is transient)",
  async () => {
    h.reset();
    const challenge = "dddddddd-4444-4444-8444-dddddddddddd";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const { userId, token } = freshUser("apple");
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-valid",
          userId,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const saved = Deno.env.get("APPLE_TOKEN_ENCRYPTION_KEY")!;
    Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", btoa("short"));
    try {
      const res = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", { token, body: { challenge } }),
      );
      const body = await res.json();
      // Either the lazy config caches the good key (200 revoked) or the bad key
      // is read (503) — but the credential must never be nulled.
      assertEquals(credentialCleared().length, 0, `${res.status} ${JSON.stringify(body)}`);
    } finally {
      Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", saved);
    }
  },
);

// ─── EDR-3 ──────────────────────────────────────────────────────────────────

Deno.test(
  "ATTACK EDR-3a: GET /v1/rank issued AFTER an accepted shots:sync joins the still-in-flight pre-sync build (coalesce) and is served the pre-sync {rank:null}",
  async () => {
    h.reset();
    const { token, ip } = freshUser("google");
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let readReached!: () => void;
    const reached = new Promise<void>((resolve) => (readReached = resolve));
    let gated = false;

    await withFetchIntercept(
      async (request) => {
        if (!gated && request.url.includes("/rest/v1/player_technique_rating")) {
          gated = true;
          readReached();
          await gate;
          return jsonResponse(200, []); // pre-sync snapshot
        }
        return null;
      },
      async () => {
        // 1. Build A starts and blocks inside its DB read.
        const inflightA = h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        await reached;

        // 2. The sync is ACCEPTED and answered 200 to the client.
        const synced = await h.handler(
          userRequest("POST", "/v1/shots:sync", { token, ip, body: syncShotBody() }),
        );
        assertEquals(synced.status, 200);
        await synced.body?.cancel();
        h.tables.player_technique_rating = [
          {
            shot_type: "dink",
            score: 7.5,
            captured_at: new Date().toISOString(),
            sampled_count: 1,
            confidence_weight: 1,
          },
        ];
        h.tables.player_rank_state = [];

        // 3. The SAME client, having seen its sync accepted, reads its rank
        //    while build A is still in flight.
        const inflightB = h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        await new Promise((r) => setTimeout(r, 20));

        // 4. Build A completes with the pre-sync view.
        releaseRead();
        const a = await inflightA;
        assertEquals(await a.json(), { rank: null });

        const b = await inflightB;
        assertEquals(b.status, 200);
        const payload = (await b.json()) as { rank: unknown };
        assertNotEquals(
          payload.rank,
          null,
          "post-sync GET /v1/rank was served the pre-sync payload via the in-flight coalesced build",
        );
      },
    );
  },
);

Deno.test(
  "HOLD EDR-3b: two accepted syncs during one in-flight build → generation moves twice, stale payload still not cached",
  async () => {
    h.reset();
    const { token, ip } = freshUser("google");
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let readReached!: () => void;
    const reached = new Promise<void>((resolve) => (readReached = resolve));
    let gated = false;

    await withFetchIntercept(
      async (request) => {
        if (!gated && request.url.includes("/rest/v1/player_technique_rating")) {
          gated = true;
          readReached();
          await gate;
          return jsonResponse(200, []);
        }
        return null;
      },
      async () => {
        const inflight = h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        await reached;
        for (let i = 0; i < 2; i += 1) {
          const synced = await h.handler(
            userRequest("POST", "/v1/shots:sync", { token, ip, body: syncShotBody() }),
          );
          assertEquals(synced.status, 200);
          await synced.body?.cancel();
        }
        h.tables.player_technique_rating = [
          {
            shot_type: "dink",
            score: 7.5,
            captured_at: new Date().toISOString(),
            sampled_count: 2,
            confidence_weight: 2,
          },
        ];
        h.tables.player_rank_state = [];
        releaseRead();
        const stale = await inflight;
        assertEquals(await stale.json(), { rank: null });
        const after = await h.handler(userRequest("GET", "/v1/rank", { token, ip }));
        const payload = (await after.json()) as { rank: unknown };
        assertNotEquals(payload.rank, null);
      },
    );
  },
);

// ─── EDR-1 ──────────────────────────────────────────────────────────────────

async function refreshWithGoTrue(
  respond: (request: Request) => Promise<Response>,
  ip: string,
): Promise<Response> {
  return await withFetchIntercept(
    async (request) => {
      if (
        request.url.includes("/auth/v1/token") &&
        request.url.includes("grant_type=refresh_token")
      ) {
        return respond(request);
      }
      return null;
    },
    () =>
      h.handler(
        userRequest("POST", "/v1/auth/refresh", { ip, body: { refreshToken: "rt-attack" } }),
      ),
  );
}

Deno.test("HOLD EDR-1a: GoTrue 429 → 503 (not a sign-out)", async () => {
  h.reset();
  const res = await refreshWithGoTrue(
    async () => jsonResponse(429, { error: "over_request_rate_limit", msg: "slow down" }),
    "203.0.113.230",
  );
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

Deno.test("HOLD EDR-1b: GoTrue 500 with a JSON body → 503", async () => {
  h.reset();
  const res = await refreshWithGoTrue(
    async () => jsonResponse(500, { error: "internal", msg: "db down" }),
    "203.0.113.231",
  );
  assertEquals(res.status, 503);
  await res.body?.cancel();
});

Deno.test("HOLD EDR-1c: GoTrue 403 → 401 Sign in again", async () => {
  h.reset();
  const res = await refreshWithGoTrue(
    async () => jsonResponse(403, { error: "invalid_grant", msg: "Session from session_id claim in JWT does not exist" }),
    "203.0.113.232",
  );
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("HOLD EDR-1d: GoTrue 200 with a non-JSON (proxy HTML) body → 503", async () => {
  h.reset();
  const res = await refreshWithGoTrue(
    async () => new Response("<html>ok</html>", { status: 200, headers: { "Content-Type": "text/html" } }),
    "203.0.113.233",
  );
  assertEquals(res.status, 503);
  await res.body?.cancel();
});
