/**
 * Structural audit #2 — edge-domain-routes — FINDINGS.
 *
 * Every test here asserts the behaviour the code's own comments / the product
 * hard rules promise. Each one FAILS on 4d812e1a: the failure IS the
 * reproduction. They are grouped in this file (separate from the holds in
 * structural2_verified.test.ts) so the coordinator can run either set alone:
 *
 *   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json structural2_findings.test.ts
 */
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";
import { userRequest } from "./routesHarness.ts";
import {
  deferred,
  distinctGoogleIdToken,
  fakeAppleIdToken,
  intercept,
  loadStructuralHarness,
  readJson,
  restPath,
  syncShot,
  userId,
} from "./structural2Harness.ts";

const h = await loadStructuralHarness();

function deletionRequestRow(challenge: string) {
  return {
    challenge,
    created_at: new Date(Date.now() - 10_000).toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
}

const deleteUserCalls = () =>
  h.calls.filter(
    (call) =>
      call.url.includes("/auth/v1/admin/users/") && call.method === "DELETE",
  ).length;

// ─────────────────────────────────────────────────────────────────────────────
// F1 — index.ts:1110-1111 promises "Busted on every accepted shot write so
// cached responses can never go stale", and 1734-1735 "progress only changes
// when new evidence syncs (which busts this key)". A progress build that was
// already in flight when the sync committed re-populates the key AFTER the
// cacheDel (coalesce 1118-1128 → buildProgress 1791 cacheSet), so the next
// 60 s of GET /v1/progress serve the pre-sync snapshot.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "F1 progress cache: an accepted sync must not be undone by an in-flight coalesced build",
  async () => {
    h.reset();
    const token = distinctGoogleIdToken(userId(101), "phone");
    const before = {
      day: "2026-09-01",
      shot_type: "dink",
      scoring_model_version: "scoring-1",
      shot_count: 3,
      avg_score: 6.5,
      best_score: 7.1,
    };
    const after = { ...before, day: "2026-09-02", shot_count: 1 };
    h.tables.progress_daily = [before];
    h.tables.practice_days = [{ day: "2026-09-01" }];
    h.tables.shots = [];
    h.rpcs.apply_synced_shot = "accepted";

    // The first progress_daily read is a DB snapshot taken when the query
    // starts (what Postgres returns), whose delivery is held until released.
    const gate = deferred();
    const started = deferred();
    let gated = false;
    intercept(async (request) => {
      if (
        request.method === "GET" &&
        restPath(request).startsWith("progress_daily") && !gated
      ) {
        gated = true;
        const snapshot = JSON.stringify(h.tables.progress_daily);
        started.resolve();
        await gate.promise;
        return new Response(snapshot, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return null;
    });

    const inflight = h.handler(userRequest("GET", "/v1/progress", { token }));
    await started.promise;

    const sync = await h.handler(
      userRequest("POST", "/v1/shots:sync", {
        token,
        body: { shots: [syncShot()] },
      }),
    );
    assertEquals(sync.status, 200);
    assertEquals(((await readJson(sync)).acceptedIds as string[]).length, 1);

    // The sync committed new evidence; the DB now shows both days.
    h.tables.progress_daily = [before, after];
    gate.resolve();
    const stale = await inflight;
    assertEquals(stale.status, 200);
    intercept(null);

    const fresh = await h.handler(
      userRequest("GET", "/v1/progress", { token }),
    );
    assertEquals(fresh.status, 200);
    const series = (await readJson(fresh)).series as unknown[];
    assertEquals(
      series.length,
      2,
      "GET /v1/progress after an accepted sync must reflect the synced evidence, not the pre-sync snapshot re-cached by the in-flight build",
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// F2 — index.ts:2625-2633: delete-confirm evicts ONLY the confirming bearer's
// auth-cache entry. Another device's bearer for the same (now deleted)
// account keeps authenticating from cache — no GoTrue re-verification — for
// up to AUTH_CACHE_MAX_TTL_SECONDS (600 s).
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "F2 delete-confirm must evict every cached bearer of the deleted account, not just the confirming one",
  async () => {
    h.reset();
    const uid = userId(102);
    const phone = distinctGoogleIdToken(uid, "phone");
    const tablet = distinctGoogleIdToken(uid, "tablet");
    h.rpcs.access_state = [{
      premium: false,
      scored_count: 0,
      reserved_count: 0,
    }];
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRequestRow(challenge)];
    h.tables.account_external_credentials = [];

    // Warm both bearers.
    assertEquals(
      (await h.handler(userRequest("GET", "/v1/me/access", { token: phone })))
        .status,
      200,
    );
    assertEquals(
      (await h.handler(userRequest("GET", "/v1/me/access", { token: tablet })))
        .status,
      200,
    );
    const verifications = () => h.callsTo("/auth/v1/token").length;
    assertEquals(verifications(), 2);

    const confirm = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token: phone,
        body: { challenge },
      }),
    );
    assertEquals(confirm.status, 200);
    assertEquals(deleteUserCalls(), 1);

    // The tablet's bearer must be re-verified (which, against real GoTrue,
    // fails for a deleted user) — not served from the cache.
    const tabletAfter = await h.handler(
      userRequest("GET", "/v1/me/access", { token: tablet }),
    );
    assert(
      verifications() === 3 || tabletAfter.status === 401,
      `deleted account's other bearer was served from the auth cache (status ${tabletAfter.status}, GoTrue verifications ${verifications()})`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// F3 — index.ts:2539-2546 + externalAccounts.ts:366-372: the RevenueCat
// erasure step has NO fallback and NO terminal signal. With
// REVENUECAT_SECRET_API_KEY unset (docs/APP_STORE_SUBMISSION.md:124 still
// lists it as an unchecked VERIFY item; billing/sync itself falls back to the
// public key) every delete-confirm is a generic retryable 503, deleteUser is
// never reached, and the per-user delete_confirm budget (5/h) then 429s.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "F3 delete-confirm without REVENUECAT_SECRET_API_KEY must not become an indefinite generic 503",
  async () => {
    h.reset();
    const uid = userId(103);
    const token = distinctGoogleIdToken(uid, "phone");
    const challenge = crypto.randomUUID();
    h.tables.account_deletion_requests = [deletionRequestRow(challenge)];
    h.tables.account_external_credentials = [];
    const saved = Deno.env.get("REVENUECAT_SECRET_API_KEY") ?? "";
    Deno.env.delete("REVENUECAT_SECRET_API_KEY");
    try {
      const first = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token,
          body: { challenge },
        }),
      );
      const body = await readJson(first);
      assertNotEquals(
        [first.status, deleteUserCalls()],
        [503, 0],
        `deletion blocked by server configuration: ${JSON.stringify(body)}`,
      );
    } finally {
      Deno.env.set("REVENUECAT_SECRET_API_KEY", saved);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// F4 — index.ts:2502-2517: a stored Apple refresh token that can no longer be
// decrypted (APPLE_TOKEN_ENCRYPTION_KEY rotated, or a corrupted row) makes
// decryptAppleRefreshToken throw invalid_response → generic 503 on EVERY
// retry. The legacy no-token account degrades to manual_action_required
// (2529-2536); the undecryptable-token account never can.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test(
  "F4 delete-confirm with an undecryptable stored Apple token must degrade like the legacy path, not 503 forever",
  async () => {
    h.reset();
    const uid = userId(104);
    const token = fakeAppleIdToken(uid);
    const challenge = crypto.randomUUID();
    h.tables.profiles = [{
      id: uid,
      email: "a@example.com",
      provider: "apple",
    }];
    h.tables.account_deletion_requests = [deletionRequestRow(challenge)];
    const rotatedKey = btoa(
      String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
    );
    h.tables.account_external_credentials = [
      {
        apple_refresh_token_encrypted: await encryptAppleRefreshToken(
          "apple-refresh-token",
          uid,
          rotatedKey,
        ),
        apple_revoked_at: null,
        revenuecat_deleted_at: null,
      },
    ];

    const first = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token,
        body: { challenge },
      }),
    );
    const second = await h.handler(
      userRequest("POST", "/v1/me/delete-confirm", {
        token,
        body: { challenge },
      }),
    );
    assert(
      first.status !== 503 || second.status !== 503 || deleteUserCalls() > 0,
      `two consecutive delete-confirms → ${first.status}, ${second.status}; deleteUser calls ${deleteUserCalls()}; Apple revoke attempts ${
        h.callsTo("appleid.apple.com/auth/revoke").length
      }`,
    );
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// F5 — copy policy hard rule (never mention Google Play / Android / DUPR /
// competitors in user-facing copy). legal.ts:224,447,639 say "Google Play",
// legal.ts:533 says "DUPR", drillMedia.ts:103 attributes a clip to
// "Selkirk TV" — all served to the app / at the App-Store-listed URLs.
// (legal_test.ts:69 currently PINS the DUPR sentence.)
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("F5 served legal text and drill media honour the never-mention copy rule", async () => {
  h.reset();
  const banned = [
    /Google Play/i,
    /Android/i,
    /DUPR/,
    /Selkirk/i,
    /JOOLA/i,
    /SwingVision/i,
    /PB Vision/i,
  ];
  const offenders: string[] = [];
  for (const path of ["/privacy", "/terms", "/support"]) {
    const res = await h.handler(
      new Request(`http://edge.test/functions/v1/api${path}`, {
        headers: { "x-forwarded-for": "203.0.113.77" },
      }),
    );
    assertEquals(res.status, 200);
    const text = await res.text();
    for (const re of banned) {
      const m = re.exec(text);
      if (m) offenders.push(`${path}: "${m[0]}"`);
    }
  }
  const drill = await h.handler(
    userRequest("GET", "/v1/catalog/drills/midcourt-reset-blocks", {
      token: distinctGoogleIdToken(userId(105), "phone"),
    }),
  );
  assertEquals(drill.status, 200);
  const drillText = JSON.stringify(await drill.json());
  for (const re of banned) {
    const m = re.exec(drillText);
    if (m) {
      offenders.push(`GET /v1/catalog/drills/midcourt-reset-blocks: "${m[0]}"`);
    }
  }
  assertEquals(
    offenders,
    [],
    `user-facing text violates the never-mention rule:\n${
      offenders.join("\n")
    }`,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// F6 — index.ts:1133-1152: readAllRows stops after MAX_PAGES (20 × 1000) and
// returns the partial result as if complete — no error, no marker — and
// buildProgress caches that partial payload for 60 s. A store that keeps
// answering full pages is therefore reported as exactly 20 000 rows.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("F6 GET /v1/progress must not silently truncate progress_daily at 20 pages", async () => {
  h.reset();
  const token = distinctGoogleIdToken(userId(106), "phone");
  const fullPage = Array.from({ length: 1000 }, (_, i) => ({
    day: "2026-01-01",
    shot_type: `t${i}`,
    scoring_model_version: "s",
    shot_count: 1,
    avg_score: 5,
    best_score: 5,
  }));
  h.tables.progress_daily = fullPage;
  h.tables.practice_days = [];
  const res = await h.handler(userRequest("GET", "/v1/progress", { token }));
  const pages = h.calls.filter(
    (c) => c.method === "GET" && c.url.includes("/rest/v1/progress_daily"),
  ).length;
  if (res.status === 200) {
    const series = (await readJson(res)).series as unknown[];
    assert(
      !(pages === 20 && series.length === 20_000),
      `stopped after exactly ${pages} full pages and returned ${series.length} rows as a complete series`,
    );
  } else {
    assert(res.status >= 500, `unexpected status ${res.status}`);
  }
});
