// ADJUDICATION reproductions for area `edge-domain-routes` on 4d812e1a.
//
// Deliberately NOT named *.test.ts so `deno task test` does not sweep it: the
// REPRO cases assert the EXPECTED (contract) behaviour and therefore FAIL on
// the baseline by design; the CHARACTERIZE cases pin current behaviour that
// was adjudicated as by-design/deferred and PASS.
//
// Run:
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json \
//     adjudicate_edge_domain_routes.repro.ts
//
// Every case drives the REAL handler via routesHarness (fetch-level stubs for
// PostgREST / GoTrue / RevenueCat / Apple; no network, no production project).

import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import { PRIVACY_POLICY_TEXT, TERMS_TEXT } from "../legal.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const h = await loadHarness();

type FetchFn = typeof fetch;

/** Wrap the harness fetch for one test: `intercept` may return a Response
 * (or throw) for requests it wants to own; anything else falls through. */
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

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A second, distinct Google ID token for the SAME subject (different nonce →
 * different token hash → its own auth-cache entry), i.e. "another device". */
function otherDeviceGoogleToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      nonce: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

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

// ─── A. POST /v1/auth/refresh: transport failure → 401 ──────────────────────
// Contract (AGENTS.md "Auth sessions"): the ONE implicit sign-out is the server
// refusing the refresh token with 401/403; transient failures must be 5xx.
// supabase-js surfaces a fetch rejection as AuthRetryableFetchError{status:0};
// refreshSessionRoute only treats `status >= 500` as transient → 401.
// NOTE: supabase-js retries the refresh internally (~25 s backoff) first.

Deno.test(
  "REPRO A: refresh — GoTrue unreachable (fetch rejects) must be 5xx, not 401 (401 signs the device out)",
  async () => {
    h.reset();
    const res = await withFetchIntercept(
      async (request) => {
        if (
          request.url.includes("/auth/v1/token") &&
          request.url.includes("grant_type=refresh_token")
        ) {
          throw new TypeError("error sending request: connection reset");
        }
        return null;
      },
      () =>
        h.handler(
          userRequest("POST", "/v1/auth/refresh", {
            ip: "203.0.113.201",
            body: { refreshToken: "rt-transport-failure" },
          }),
        ),
    );
    const body = await res.json();
    assert(
      res.status >= 500,
      `expected 5xx for a transport failure, got ${res.status} ${JSON.stringify(body)}`,
    );
  },
);

// ─── B. Rank/progress cache TOCTOU ──────────────────────────────────────────
// A build that read pre-sync rows, then finished AFTER an accepted shots:sync
// ran cacheDel, writes the pre-sync payload back into the 60 s cache.

Deno.test(
  "REPRO B: rank build that read before an accepted shots:sync must not re-cache the pre-sync payload",
  async () => {
    h.reset();
    h.tables.profiles = [{ id: TEST_USER_ID, email: "u@example.com", provider: "google" }];
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";
    const ip = "203.0.113.202";

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
          // Pre-sync snapshot: no scored evidence yet.
          return jsonResponse(200, []);
        }
        return null;
      },
      async () => {
        // 1. Cache miss → build starts and blocks inside its DB read.
        const inflight = h.handler(userRequest("GET", "/v1/rank", { ip }));
        await reached;

        // 2. Accepted sync → cacheDel(rank, progress).
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

        // 4. The stale build completes and re-populates the cache.
        releaseRead();
        const stale = await inflight;
        assertEquals(stale.status, 200);
        assertEquals(await stale.json(), { rank: null });

        // 5. Next read must reflect the accepted sync (cache was busted).
        const after = await h.handler(userRequest("GET", "/v1/rank", { ip }));
        assertEquals(after.status, 200);
        const payload = (await after.json()) as { rank: unknown };
        assertNotEquals(
          payload.rank,
          null,
          "stale pre-sync {rank:null} was served from cache after an accepted sync",
        );
      },
    );
  },
);

// ─── C. GET /v1/progress: silent MAX_PAGES truncation keeps the OLDEST rows ──

Deno.test(
  "REPRO C: progress with >20,000 practice_days rows drops the newest rows (practicedToday false) and reports 200",
  async () => {
    h.reset();
    const ip = "203.0.113.203";
    const total = 20_001; // 21 pages of 1000 → the 21st page holds "today"
    const today = Math.floor(Date.now() / 86_400_000);
    const dayAt = (index: number) =>
      new Date((today - (total - 1 - index)) * 86_400_000).toISOString().slice(0, 10);

    const res = await withFetchIntercept(
      async (request) => {
        if (request.method !== "GET") return null;
        if (request.url.includes("/rest/v1/progress_daily")) return jsonResponse(200, []);
        if (request.url.includes("/rest/v1/practice_days")) {
          const url = new URL(request.url);
          const offset = url.searchParams.get("offset");
          const limit = url.searchParams.get("limit");
          const range = request.headers.get("range") ?? "0-999";
          const [from, to] =
            offset !== null && limit !== null
              ? [Number(offset), Number(offset) + Number(limit) - 1]
              : range.split("-").map(Number);
          // PostgREST applies `order` before paging: honour day.asc/day.desc.
          const order = url.searchParams.get("order") ?? "day.asc";
          const descending = order.startsWith("day.desc");
          const rows: Array<{ day: string }> = [];
          for (let i = from; i <= Math.min(to, total - 1); i += 1) {
            rows.push({ day: dayAt(descending ? total - 1 - i : i) });
          }
          return jsonResponse(200, rows);
        }
        return null;
      },
      () => h.handler(userRequest("GET", "/v1/progress", { ip })),
    );
    assertEquals(res.status, 200);
    const body = (await res.json()) as { streak: { practicedToday: boolean; currentDays: number } };
    assertEquals(
      body.streak.practicedToday,
      true,
      `today's practice row was silently dropped by MAX_PAGES: ${JSON.stringify(body.streak)}`,
    );
  },
);

// ─── D. REVENUECAT_SECRET_API_KEY unset → delete-confirm 503 (fail-closed) ──
// Characterization: the route refuses to delete the Supabase identity while
// the RevenueCat subscriber cannot be erased. Production secret presence is
// NOT checked here (must not touch project ucqnaiwqwjtgvlduiuib).

Deno.test(
  "CHARACTERIZE D: with REVENUECAT_SECRET_API_KEY unset, delete-confirm is 503 and neither RevenueCat nor auth.admin.deleteUser is called",
  async () => {
    h.reset();
    const challenge = "55555555-5555-4555-8555-555555555555";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    h.tables.account_external_credentials = [];
    const saved = Deno.env.get("REVENUECAT_SECRET_API_KEY");
    Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    try {
      const res = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          ip: "203.0.113.204",
          body: { challenge },
        }),
      );
      assertEquals(res.status, 503);
      await res.body?.cancel();
      assertEquals(revenueCatDeletes().length, 0);
      assertEquals(authAdminDeletes().length, 0);
    } finally {
      if (saved !== undefined) Deno.env.set("REVENUECAT_SECRET_API_KEY", saved);
    }
  },
);

// ─── E. Apple credential permanently unusable → deletion permanently 503 ────
// Undecryptable ciphertext (key rotated / corrupt row) and a persistent Apple
// 4xx (invalid_grant / invalid_client) are NOT transient, yet every attempt is
// a generic 503; no checkpoint, no RevenueCat erasure, no auth deletion, and
// no fallback to `manual_action_required`.

Deno.test(
  "REPRO E1: Apple refresh token encrypted under another key → deletion must still be fulfilled (manual_action_required), not 503 forever",
  async () => {
    h.reset();
    const challenge = "66666666-6666-4666-8666-666666666666";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    const rotatedKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-under-old-key",
          TEST_USER_ID,
          rotatedKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    const attempt = () =>
      h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: fakeAppleIdToken(),
          ip: "203.0.113.205",
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

Deno.test(
  "REPRO E2: Apple revoke persistently 400 invalid_grant → deletion must still be fulfilled, not 503 forever",
  async () => {
    h.reset();
    const challenge = "77777777-7777-4777-8777-777777777777";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "refresh-already-revoked-at-apple",
          TEST_USER_ID,
          h.appleTokenEncryptionKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];
    let revokeCalls = 0;
    await withFetchIntercept(
      async (request) => {
        if (request.url === "https://appleid.apple.com/auth/revoke") {
          revokeCalls += 1;
          return jsonResponse(400, { error: "invalid_grant" });
        }
        return null;
      },
      async () => {
        const attempt = () =>
          h.handler(
            userRequest("POST", "/v1/me/delete-confirm", {
              token: fakeAppleIdToken(),
              ip: "203.0.113.206",
              body: { challenge },
            }),
          );
        const first = await attempt();
        const firstBody = await first.json();
        const second = await attempt();
        const secondBody = (await second.json()) as { appleAuthorizationRevocation?: string };
        assertEquals(revokeCalls, 2);
        assertEquals(
          second.status,
          200,
          `retry still fails: ${first.status} ${JSON.stringify(firstBody)} then ${second.status} ${JSON.stringify(
            secondBody,
          )}`,
        );
        assert(revenueCatDeletes().length >= 1, "RevenueCat subscriber was never erased");
        assert(authAdminDeletes().length >= 1, "Supabase identity was never deleted");
      },
    );
  },
);

// ─── F. Another device's cached bearer survives account deletion ────────────
// Characterization of the DOCUMENTED limit (index.ts confirmAccountDeletion:
// "any other cached bearer ages out within ≤10 min").

Deno.test(
  "CHARACTERIZE F: after delete-confirm from device A, device B's cached bearer still authenticates (documented ≤10 min window)",
  async () => {
    h.reset();
    const ip = "203.0.113.207";
    // A different user: TEST_USER_ID's per-user delete_confirm budget (5/h)
    // is spent by the D/E cases above.
    h.tables.profiles = [{ id: OTHER_USER_ID, email: "u@example.com", provider: "google" }];
    const deviceA = fakeGoogleIdToken(OTHER_USER_ID);
    const deviceB = otherDeviceGoogleToken(OTHER_USER_ID);

    // Warm device B's auth-cache entry.
    const warm = await h.handler(userRequest("GET", "/v1/me", { token: deviceB, ip }));
    assertEquals(warm.status, 200);
    await warm.body?.cancel();

    const challenge = "88888888-8888-4888-8888-888888888888";
    h.tables.account_deletion_requests = pendingDeletion(challenge);
    h.tables.account_external_credentials = [];
    const deleted = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", { token: deviceA, ip, body: { challenge } }),
    );
    assertEquals(deleted.status, 200);
    await deleted.body?.cancel();

    // Device A is evicted; device B is not.
    const gotrueCalls = () => h.calls.filter((c) => c.url.includes("/auth/v1/token")).length;
    const beforeA = gotrueCalls();
    const afterA = await h.handler(userRequest("GET", "/v1/me", { token: deviceA, ip }));
    await afterA.body?.cancel();
    assertEquals(gotrueCalls(), beforeA + 1, "device A was evicted and re-verified with GoTrue");
    const beforeB = gotrueCalls();
    const afterB = await h.handler(userRequest("GET", "/v1/me", { token: deviceB, ip }));
    await afterB.body?.cancel();
    assertEquals(afterB.status, 200, "device B bearer was served from the auth cache");
    assertEquals(gotrueCalls(), beforeB, "device B never re-verified: cache hit after deletion");
  },
);

// ─── G. User-facing copy hard rule (AGENTS.md / REVIEW.md / dossier §1.4) ───

Deno.test("REPRO G1: /privacy and /terms must not mention Google Play or DUPR", () => {
  const hits: string[] = [];
  for (const [name, text] of [
    ["privacy", PRIVACY_POLICY_TEXT],
    ["terms", TERMS_TEXT],
  ] as const) {
    for (const term of ["Google Play", "DUPR", "Android", "guest mode", "Live Court"]) {
      const count = text.split(term).length - 1;
      if (count > 0) hits.push(`${name}: "${term}" ×${count}`);
    }
  }
  assertEquals(hits, [], `forbidden terms in legal copy: ${hits.join("; ")}`);
});

Deno.test(
  "CHARACTERIZE G2: drill media attribution includes a creator named 'Selkirk TV' (competitor name in user-facing copy vs 5.2.1 attribution — human decision)",
  async () => {
    const media = await drillInstructionalMedia("midcourt-reset-blocks");
    const creators = media.map((m) => JSON.stringify(m)).join("\n");
    assert(creators.includes("Selkirk TV"), creators);
  },
);
