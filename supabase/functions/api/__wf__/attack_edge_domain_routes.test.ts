// ADVERSARIAL tests against the EDR-1/EDR-2/EDR-3 fix (candidate e52c45e8, v1
// of devin/fix-edge-domain-routes-…; the requested v2 eecbe88d was never
// pushed). Each case asserts the CONTRACT the fix claims and FAILS on the
// candidate — they are the evidence for the attack report, not a regression
// pin. None of them passes on the 4d812e1a baseline either (regression: no).
//
// Run:
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     attack_edge_domain_routes.test.ts
//
// Every route case drives the REAL handler via routesHarness (fetch-level
// stubs for PostgREST / GoTrue / RevenueCat / Apple; no network).

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  decryptAppleRefreshToken,
  ExternalAccountError,
  isPermanentAppleRevocationFailure,
} from "../externalAccounts.ts";
import {
  fakeAppleIdToken,
  loadHarness,
  RC_URL,
  TEST_USER_ID,
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

function pendingDeletion(challenge: string) {
  return [
    {
      challenge,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    },
  ];
}

const authAdminDeletes = () =>
  h.calls.filter((c) => c.url.includes("/auth/v1/admin/users/") && c.method === "DELETE");
const revenueCatDeletes = () =>
  h.calls.filter((c) => c.url.startsWith(RC_URL) && c.method === "DELETE");

/** Gate the first PostgREST read of `table` inside an in-flight build; the
 * gate resolves with `preSyncRows`. Returns the release + reached promises. */
function gatedRead(table: string, preSyncRows: unknown[]) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let readReached!: () => void;
  const reached = new Promise<void>((resolve) => (readReached = resolve));
  let gated = false;
  const intercept = async (request: Request): Promise<Response | null> => {
    if (!gated && request.url.includes(`/rest/v1/${table}`)) {
      gated = true;
      readReached();
      await gate;
      return jsonResponse(200, preSyncRows);
    }
    return null;
  };
  return { intercept, release: () => release(), reached };
}

// ─── ATTACK 1 (EDR-3, concurrency variant of REPRO B) ────────────────────────
// The fix stops the stale build from RE-CACHING (cacheSetIfCurrent), but the
// per-isolate single-flight `coalesce()` still hands the stale in-flight
// build to every GET that arrives after the accepted sync and before the
// build resolves. The client that just got `acceptedIds: [id]` therefore
// reads its own pre-sync rank/progress back — the exact acceptance sentence
// of EDR-3 ("post-sync GET /v1/player/rank is not the pre-sync {rank:null}
// payload") fails whenever the post-sync GET overlaps the stale build.

Deno.test(
  "ATTACK EDR-3a: GET /v1/rank issued AFTER an accepted shots:sync but while the pre-sync build is still in flight must not return the pre-sync {rank:null}",
  async () => {
    h.reset();
    h.tables.profiles = [{ id: TEST_USER_ID, email: "u@example.com", provider: "google" }];
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";
    const ip = "203.0.113.230";
    const gate = gatedRead("player_technique_rating", []);

    await withFetchIntercept(gate.intercept, async () => {
      // 1. Cache miss → build starts and blocks inside its DB read.
      const inflight = h.handler(userRequest("GET", "/v1/rank", { ip }));
      await gate.reached;

      // 2. Accepted sync → cacheDel(rank, progress) (generation bumped).
      const synced = await h.handler(
        userRequest("POST", "/v1/shots:sync", { ip, body: syncShotBody() }),
      );
      assertEquals(synced.status, 200);
      assertEquals(((await synced.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);

      // 3. Post-sync truth: one scored technique now exists.
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

      // 4. The device that synced reads its rank back BEFORE the stale build
      //    has resolved (same isolate, cache miss → coalesce joins it).
      const afterSync = h.handler(userRequest("GET", "/v1/rank", { ip }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.release();

      const stale = await inflight;
      assertEquals(stale.status, 200);
      assertEquals(await stale.json(), { rank: null }, "the pre-sync build itself is stale");

      const after = await afterSync;
      assertEquals(after.status, 200);
      const payload = (await after.json()) as { rank: unknown };
      assertNotEquals(
        payload.rank,
        null,
        "a GET issued after the accepted sync was served the pre-sync {rank:null} via the coalesced in-flight build",
      );
    });
  },
);

Deno.test(
  "ATTACK EDR-3b: GET /v1/progress issued AFTER an accepted shots:sync but while the pre-sync build is still in flight must not return the pre-sync empty series",
  async () => {
    h.reset();
    h.tables.profiles = [{ id: TEST_USER_ID, email: "u@example.com", provider: "google" }];
    h.tables.shots = [];
    h.tables.practice_days = [];
    h.rpcs.apply_synced_shot = "accepted";
    const ip = "203.0.113.231";
    const gate = gatedRead("progress_daily", []);

    await withFetchIntercept(gate.intercept, async () => {
      const inflight = h.handler(userRequest("GET", "/v1/progress", { ip }));
      await gate.reached;

      const synced = await h.handler(
        userRequest("POST", "/v1/shots:sync", { ip, body: syncShotBody() }),
      );
      assertEquals(synced.status, 200);
      assertEquals(((await synced.json()) as { acceptedIds: string[] }).acceptedIds.length, 1);

      const today = new Date().toISOString().slice(0, 10);
      h.tables.progress_daily = [
        {
          day: today,
          shot_type: "dink",
          scoring_model_version: "1",
          shot_count: 1,
          avg_score: 7.5,
          best_score: 7.5,
        },
      ];
      h.tables.practice_days = [{ day: today }];

      const afterSync = h.handler(userRequest("GET", "/v1/progress", { ip }));
      await new Promise((resolve) => setTimeout(resolve, 20));
      gate.release();

      const stale = await inflight;
      assertEquals(stale.status, 200);
      assertEquals(((await stale.json()) as { series: unknown[] }).series.length, 0);

      const after = await afterSync;
      assertEquals(after.status, 200);
      const payload = (await after.json()) as { series: unknown[] };
      assertEquals(
        payload.series.length,
        1,
        "a GET issued after the accepted sync was served the pre-sync empty series via the coalesced in-flight build",
      );
    });
  },
);

// ─── ATTACK 2 (EDR-2, corrupt-ciphertext variant of REPRO E1) ───────────────
// `isPermanentAppleRevocationFailure` documents "corrupt ciphertext" as
// permanent, but `decryptAppleRefreshToken` runs `decodeBase64()` on the IV
// and ciphertext segments INSIDE its try block, and decodeBase64 throws
// ExternalAccountError("configuration", "APPLE_TOKEN_ENCRYPTION_KEY is not
// valid base64.") for ANY non-base64 input. The catch rethrows
// ExternalAccountError as-is, so a `v1.<garbage>.<garbage>` row is classified
// as a server misconfiguration → 503 on every retry, RevenueCat and Auth
// deletion never run — the original EDR-2 failure mode.

const CORRUPT_CIPHERTEXTS: Array<[string, string]> = [
  ["non-base64 IV", "v1.not*valid*base64.QUJDREVGR0hJSktMTU5PUA"],
  ["non-base64 ciphertext", "v1.QUJDREVGR0hJSktM.ciphertext-with-unicode-🥒"],
];

Deno.test(
  "ATTACK EDR-2a: a stored Apple credential whose IV/ciphertext is not base64 is a permanent failure, not a server-configuration failure",
  async () => {
    for (const [label, ciphertext] of CORRUPT_CIPHERTEXTS) {
      const error = await decryptAppleRefreshToken(
        ciphertext,
        TEST_USER_ID,
        h.appleTokenEncryptionKey,
      ).then(
        () => null,
        (e: unknown) => e,
      );
      assert(error instanceof ExternalAccountError, label);
      assert(
        isPermanentAppleRevocationFailure(error),
        `${label}: classified as kind=${error.kind} (${error.message}) — retrying can never decrypt it`,
      );
    }
  },
);

Deno.test(
  "ATTACK EDR-2b: delete-confirm with a corrupt (non-base64) stored Apple credential must fulfil deletion (manual_action_required), not 503 on every retry",
  async () => {
    h.reset();
    const challenge = "99999999-9999-4999-8999-999999999991";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: CORRUPT_CIPHERTEXTS[0][1],
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const attempt = () =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeAppleIdToken(),
          ip: "203.0.113.232",
          body: { challenge },
        }),
      );
    const first = await attempt();
    const firstBody = await first.json();
    const second = await attempt();
    const secondBody = (await second.json()) as { appleAuthorizationRevocation?: string };
    assertEquals(
      second.status,
      200,
      `retry still fails: ${first.status} ${JSON.stringify(firstBody)} then ${second.status} ${JSON.stringify(
        secondBody,
      )}`,
    );
    assertEquals(secondBody.appleAuthorizationRevocation, "manual_action_required");
    assert(revenueCatDeletes().length >= 1, "RevenueCat subscriber was never erased");
    assert(authAdminDeletes().length >= 1, "Supabase identity was never deleted");
  },
);

// ─── ATTACK 3 (EDR-1, client-synthesized 4xx) ────────────────────────────────
// The candidate treats every error with a numeric 4xx status (≠ 429) as a
// GoTrue refusal. supabase-js also SYNTHESIZES a status-400 error client-side:
// `_callRefreshToken` throws AuthSessionMissingError (status 400) when GoTrue
// answered 200 with a JSON body that carries no session. That never reached a
// refusal decision at GoTrue, yet it becomes the one implicit sign-out (401 +
// auth-failure budget). The candidate's own `"no session"` 5xx branch is
// unreachable for this input because supabase-js converts it into an error.

Deno.test(
  "ATTACK EDR-1a: GoTrue 200 with a JSON body that carries no session is not a refusal — refresh must be 5xx (retryable), not 401 sign-out",
  async () => {
    h.reset();
    const res = await withFetchIntercept(
      (request) =>
        Promise.resolve(
          request.url.includes("/auth/v1/token") && request.url.includes("grant_type=refresh_token")
            ? jsonResponse(200, { message: "ok" })
            : null,
        ),
      () =>
        h.handler(
          userRequest("POST", "/v1/auth/refresh", {
            ip: "203.0.113.233",
            body: { refreshToken: "rt-gateway-200-without-session" },
          }),
        ),
    );
    const body = await res.json();
    assert(
      res.status >= 500,
      `expected 5xx for a non-refusal, got ${res.status} ${JSON.stringify(body)}`,
    );
  },
);
