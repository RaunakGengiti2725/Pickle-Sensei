// Adversarial tests for fix round 2 of the `edge-domain-routes` cluster
// (EDR-2 account-deletion external cleanup, EDR-3 rank/progress cacheFence).
//
// Every case drives the REAL edge handler through routesHarness (PostgREST,
// GoTrue, RevenueCat and Apple stubbed at the fetch layer). Each scenario signs
// in as its own subject: delete-confirm has a per-user budget of 5/hour and the
// rank/progress cache module is process-wide.

import { assert, assertEquals } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  RC_URL,
  userRequest,
} from "./routesHarness.ts";

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
    if (owned) return owned;
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

// ─── EDR-2: Apple revocation refused for reasons that are OURS, not the token's ─
//
// Apple's ErrorResponse contract (developer.apple.com/documentation/
// signinwithapplerestapi/errorresponse): only `invalid_grant` says anything
// about the user's refresh token. `invalid_client` = OUR client_secret / client
// id failed ("expired token, malformed claims, or invalid signature" — i.e. a
// rotated or mis-set APPLE_SIGN_IN_PRIVATE_KEY / KEY_ID / TEAM_ID, or a skewed
// clock making the 300 s JWT invalid); `invalid_request`,
// `unauthorized_client`, `unsupported_grant_type`, `invalid_scope` describe our
// request or our client configuration. All of those are fixed by the operator
// and the SAME stored refresh token revokes fine afterwards — exactly the
// "configuration: retryable once the operator recovers" class the module's own
// docstring defines, and exactly how the sibling exchangeAppleAuthorizationCode
// classifies them (`unavailable`).
//
// 3a134e80 fails closed (503, nothing written). The candidate treats every
// 4xx except 429 as a permanent refusal of the credential: it NULLs the
// encrypted refresh token, deletes the RevenueCat subscriber and the Supabase
// identity, and answers `manual_action_required`. Once the operator repairs
// the secret the revocation can never be performed — the only copy of the
// token is gone — so every Apple user who deletes during a configuration
// fault loses server-side revocation permanently.

const GENERIC_DELETION_503 = {
  error: {
    message: "Account deletion is temporarily unavailable. Please try again.",
  },
};

function pendingDeletion(challenge: string) {
  return [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
}

function storedAppleCredential(encrypted: string) {
  return [
    {
      apple_refresh_token_encrypted: encrypted,
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
    },
  ];
}

function deleteConfirm(challenge: string, ip: string, userId: string): Promise<Response> {
  return h.handler(
    userRequest("POST", "/v1/me/delete-confirm", {
      token: fakeAppleIdToken(userId),
      ip,
      body: { challenge },
    }),
  );
}

const revenueCatDeletes = () =>
  h.calls.filter((call) => call.url.startsWith(RC_URL) && call.method === "DELETE");
const authAdminDeletes = () =>
  h.calls.filter((call) => call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE");
const credentialWrites = () =>
  h.calls.filter(
    (call) =>
      call.url.includes("/rest/v1/account_external_credentials") &&
      (call.method === "PATCH" || call.method === "POST"),
  );

/** Apple refusals whose cause is our client configuration or our request —
 * never the stored refresh token. */
const clientSideAppleRefusals: Array<[label: string, response: () => Response]> = [
  [
    "400 invalid_client (rotated/mis-set .p8, wrong key id, clock skew)",
    () => jsonResponse(400, { error: "invalid_client" }),
  ],
  [
    "400 invalid_request (our request malformed)",
    () => jsonResponse(400, { error: "invalid_request" }),
  ],
  ["400 unauthorized_client", () => jsonResponse(400, { error: "unauthorized_client" })],
  ["400 unsupported_grant_type", () => jsonResponse(400, { error: "unsupported_grant_type" })],
  [
    "401 with no Apple error body (edge/WAF between us and Apple)",
    () => new Response(null, { status: 401 }),
  ],
  ["403 with no Apple error body", () => new Response("Forbidden", { status: 403 })],
  [
    "404 with no Apple error body (endpoint unreachable through a proxy)",
    () => new Response("<html>not found</html>", { status: 404 }),
  ],
];

for (const [index, [label, refusal]] of clientSideAppleRefusals.entries()) {
  Deno.test(
    `ATTACK EDR-2: Apple revoke ${label} is OUR fault, not the token's → must stay 503 and keep the credential (candidate drops it forever)`,
    async () => {
      h.reset();
      const challenge = "a77ac000-0000-4000-8000-00000000a77a";
      const userId = `a77ac000-00${String(index).padStart(2, "0")}-4aaa-8aaa-aaaaaaaaaaaa`;
      h.tables.account_deletion_requests = pendingDeletion(challenge);
      h.tables.account_external_credentials = storedAppleCredential(
        await encryptAppleRefreshToken(
          "refresh-still-perfectly-valid",
          userId,
          h.appleTokenEncryptionKey,
        ),
      );

      let revokeCalls = 0;
      const response = await withFetchIntercept(
        (request) => {
          if (request.url !== "https://appleid.apple.com/auth/revoke") {
            return Promise.resolve(null);
          }
          revokeCalls += 1;
          return Promise.resolve(refusal());
        },
        () => deleteConfirm(challenge, "203.0.113.70", userId),
      );

      assertEquals(revokeCalls, 1, "the revoke was attempted exactly once");
      const body = await response.json();
      assertEquals(
        response.status,
        503,
        `a client-configuration refusal must fail closed like 429/5xx do; got ${response.status} ${JSON.stringify(
          body,
        )}`,
      );
      assertEquals(body, GENERIC_DELETION_503);
      assertEquals(
        credentialWrites().length,
        0,
        "the encrypted refresh token must survive an operator-side fault (it is the only copy)",
      );
      assertEquals(revenueCatDeletes().length, 0, "fail closed: RevenueCat untouched");
      assertEquals(authAdminDeletes().length, 0, "fail closed: Supabase identity kept");
    },
  );
}

Deno.test(
  "ATTACK EDR-2: after the operator repairs the client secret, the same stored token must still be revocable (candidate has already NULLed it)",
  async () => {
    h.reset();
    const challenge = "a77ac001-0000-4000-8000-00000000a77a";
    const userId = "a77ac001-0000-4aaa-8aaa-aaaaaaaaaaaa";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    h.tables.account_external_credentials = storedAppleCredential(
      await encryptAppleRefreshToken(
        "refresh-token-apple-still-honours",
        userId,
        h.appleTokenEncryptionKey,
      ),
    );

    // Attempt 1 during the fault: Apple refuses OUR client_secret.
    let appleAccepts = false;
    const revokeBodies: string[] = [];
    const intercept = async (request: Request): Promise<Response | null> => {
      if (request.url !== "https://appleid.apple.com/auth/revoke") return null;
      revokeBodies.push(await request.text());
      return appleAccepts
        ? new Response(null, { status: 200 })
        : jsonResponse(400, { error: "invalid_client" });
    };
    const first = await withFetchIntercept(intercept, () =>
      deleteConfirm(challenge, "203.0.113.71", userId),
    );
    await first.body?.cancel();

    // The row the fixed retry would read is whatever the first attempt left behind.
    const cleared = h.calls.find(
      (call) =>
        call.url.includes("/rest/v1/account_external_credentials") &&
        call.method === "PATCH" &&
        (call.body as Record<string, unknown>)?.apple_refresh_token_encrypted === null,
    );
    if (cleared) {
      h.tables.account_external_credentials = [
        {
          apple_refresh_token_encrypted: null,
          apple_revoked_at: null,
          revenuecat_deleted_at: new Date().toISOString(),
        },
      ];
    }

    // Operator fixes the secret; user (or support) retries the deletion.
    appleAccepts = true;
    h.calls.length = 0;
    const retry = await withFetchIntercept(intercept, () =>
      deleteConfirm(challenge, "203.0.113.71", userId),
    );
    assertEquals(retry.status, 200);
    const outcome = (await retry.json()) as {
      appleAuthorizationRevocation: string;
    };
    assertEquals(
      revokeBodies.length,
      2,
      "the retry must re-attempt the revoke with the stored token",
    );
    assert(
      revokeBodies[1]?.includes("token=refresh-token-apple-still-honours"),
      "the retry must send the stored refresh token to Apple",
    );
    assertEquals(
      outcome.appleAuthorizationRevocation,
      "revoked",
      "a recoverable operator fault must not downgrade the user's revocation to manual_action_required forever",
    );
  },
);

// ─── EDR-3: post-sync read coalesced onto a pre-sync in-flight build ─────────
//
// Variant of REPRO B with the reads reordered: the stale build is still in
// flight when the FIRST post-sync GET arrives. cacheDel emptied the cache, so
// the new request misses; `coalesce()` must NOT hand it the pending pre-sync
// build (the fence already keeps that payload out of the cache) — the accepted
// sync bumped the key's generation, so the request starts a fresh build and
// the device that just synced reads its own write.

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

function syncShotBody(id = crypto.randomUUID()) {
  return {
    shots: [
      {
        id,
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
        versionVector: VERSION_VECTOR,
      },
    ],
  };
}

function cacheUser(userId: string) {
  h.reset();
  h.tables.profiles = [
    {
      id: userId,
      email: "u@example.com",
      provider: "google",
    },
  ];
  h.tables.shots = [];
  h.rpcs.apply_synced_shot = "accepted";
  return { token: fakeGoogleIdToken(userId) };
}

Deno.test(
  "EDR-3: the first GET /v1/progress AFTER an accepted sync is never served the pre-sync body by an in-flight coalesced build",
  async () => {
    const auth = cacheUser("a77ac003-0000-4ddd-8ddd-dddddddddddd");
    const ip = "203.0.113.73";
    h.tables.progress_daily = [];
    h.tables.practice_days = [];

    let releaseRead!: () => void;
    const gate = new Promise<void>((resolve) => (releaseRead = resolve));
    let readReached!: () => void;
    const reached = new Promise<void>((resolve) => (readReached = resolve));
    let gated = false;

    await withFetchIntercept(
      async (request) => {
        if (!gated && request.url.includes("/rest/v1/progress_daily")) {
          gated = true;
          readReached();
          await gate;
          return jsonResponse(200, []);
        }
        return null;
      },
      async () => {
        const inflight = h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
        await reached;

        const synced = await h.handler(
          userRequest("POST", "/v1/shots:sync", {
            ...auth,
            ip,
            body: syncShotBody(),
          }),
        );
        assertEquals(synced.status, 200);
        const syncBody = (await synced.json()) as { acceptedIds: string[]; rejected: unknown[] };
        assertEquals(syncBody.rejected, [], "the sync must be ACCEPTED for this scenario to bite");
        assertEquals(syncBody.acceptedIds.length, 1);

        const today = new Date().toISOString().slice(0, 10);
        h.tables.progress_daily = [
          {
            day: today,
            shot_type: "dink",
            scoring_model_version: "scoring-1",
            shot_count: 1,
            avg_score: 7.5,
            best_score: 7.5,
          },
        ];
        h.tables.practice_days = [{ day: today }];

        // The device that just synced asks for progress while the stale build is still running.
        const postSync = h.handler(userRequest("GET", "/v1/progress", { ...auth, ip }));
        // Let the post-sync request reach the cache miss (authenticate + cacheGet
        // are async) while the pre-sync build is still parked on its DB read.
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseRead();
        const [stale, after] = await Promise.all([inflight, postSync]);
        assertEquals(stale.status, 200);
        assertEquals(after.status, 200);
        const payload = (await after.json()) as { series: unknown[] };
        assertEquals(
          payload.series.length,
          1,
          "a GET issued after the accepted sync returned the pre-sync payload (coalesced onto the stale build)",
        );
      },
    );
  },
);
