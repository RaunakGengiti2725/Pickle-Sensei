// Adversarial pass 3 — `edge-auth-cache-ratelimit` — REPRODUCED DEFECTS.
//
// Every case here asserts the EXPECTED (secure / contract) behaviour and
// therefore FAILS on 4d812e1a. Each failure message states what the edge does
// today. Once the underlying behaviour is fixed these cases turn green and
// become regression pins; until then they are deliberately red and live on the
// attack branch only (see attack_p3_auth_cache_ratelimit_test.ts for the
// cases that HELD).
//
//   deno test -A --no-check --config deno.json attack_p3_findings_repro.ts
//
// (Named *_repro.ts on purpose: the canonical `deno task test` glob must stay
// green; run this file explicitly to reproduce.)
//
// Findings (severity per the audit rubric):
//   F1 (P3) bootstrap forwards an implausible provider subject (10 000 chars)
//           to Supabase Auth instead of refusing it pre-verification
//           (index.ts authenticateProviderToken: only typeof/emptiness checked).
//   F1b(P3) likewise a 70 KB refreshToken is forwarded to GoTrue (only the
//           5 MB JSON body cap applies).
//   F3 (P2) refresh during a GoTrue 5xx is retried ~8× over ~25 s by auth-js
//           before the edge answers 503 (retry storm + long hold; logout has
//           no such retry because it calls the REST endpoint directly).
//   F2 (P2) delete-confirm evicts ONLY the confirming bearer's cache entry:
//           another bearer of the same user, verified and cached in ANY
//           isolate (and in L2 Redis), keeps passing authenticate() for up to
//           ~10 min (AUTH_CACHE_MAX_TTL_SECONDS − 30 s) and gets 503s from the
//           RLS-empty rows instead of a 401 that would sign the device out
//           (index.ts confirmAccountDeletion cacheDel: rank, progress,
//           authCacheKey(bearerOf(request)) only — documented as accepted at
//           index.ts:2625-2628; the scenario's ≤60 s expectation does not hold).

import { assert, assertEquals } from "@std/assert";
import { cacheGet, sha256Hex } from "../cache.ts";
import { SUPABASE_URL, TEST_USER_ID, loadHarness, userRequest } from "./routesHarness.ts";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";

const h = await loadHarness();

function b64url(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function jwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

function supabaseAccessToken(opts: { sub?: string; expSec: number; jti: string }): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: opts.sub ?? TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    exp: opts.expSec,
    jti: opts.jti,
  });
}

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function gotrueUser(id = TEST_USER_ID) {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: "user@example.com",
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function stubGetUser(respond: () => Response) {
  const inner = globalThis.fetch;
  const seen = { user: 0 };
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      seen.user += 1;
      return Promise.resolve(respond());
    }
    return inner(request);
  }) as typeof fetch;
  return {
    seen,
    restore() {
      globalThis.fetch = inner;
    },
  };
}

const profileRow = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

/** Seeded PRNG (mulberry32) so the "random" subject is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5eed_0003;

// ─── F1 (P3): 10 000-char provider subject reaches Supabase Auth ────────────

Deno.test(
  "BROKEN F1 (P3): bootstrap with a 10 000-char sub should be refused pre-verification (401, no Supabase Auth call)",
  async () => {
    h.reset();
    h.tables.profiles = [profileRow()];
    const rand = mulberry32(SEED);
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    let sub = "";
    while (sub.length < 10_000) sub += alphabet[Math.floor(rand() * alphabet.length)];
    const token = jwt({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    });

    const response = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", { token, ip: "198.51.100.201", body: {} }),
    );
    const upstream = h.callsTo("/auth/v1/token");
    await response.body?.cancel();

    assertEquals(
      upstream.length,
      0,
      `OBSERVED: the 10 000-char sub was forwarded to Supabase Auth (${upstream.length} signInWithIdToken call, edge answered ${response.status}); ` +
        "Google subs are ≤255 chars and Apple's ~44 — an implausible subject should be a 401 without an upstream round trip",
    );
    assertEquals(response.status, 401);
  },
);

// ─── F2 (P2): another cached bearer of the deleted user survives ────────────

Deno.test(
  "BROKEN F2 (P2, black-box): delete-confirm with bearer A; bearer B (same user, cached) must be refused within ≤60 s — it is not",
  async () => {
    const realNow = Date.now;
    let now = 1_800_001_000_000;
    Date.now = () => now;
    const gotrue = stubGetUser(() => jsonResponse(200, gotrueUser()));
    try {
      h.reset();
      h.tables.profiles = [profileRow()];
      const expSec = Math.floor(now / 1000) + 3600;
      const bearerA = supabaseAccessToken({ expSec, jti: "device-A" });
      const bearerB = supabaseAccessToken({ expSec, jti: "device-B" });
      const ipA = "198.51.100.202";
      const ipB = "198.51.100.203";

      // Device B is signed in and its session is verified + cached at the edge.
      const b1 = await h.handler(userRequest("GET", "/v1/me", { token: bearerB, ip: ipB }));
      assertEquals(b1.status, 200);
      await b1.body?.cancel();
      assertEquals(gotrue.seen.user, 1);

      // Device A deletes the account.
      const challenge = "88888888-8888-4888-8888-888888888888";
      h.tables.account_deletion_requests = [
        {
          challenge,
          created_at: new Date(now - 10_000).toISOString(),
          expires_at: new Date(now + 60_000).toISOString(),
        },
      ];
      h.tables.account_external_credentials = [];
      const deleted = await h.handler(
        userRequest("POST", "/v1/me/delete-confirm", {
          token: bearerA,
          ip: ipA,
          body: { challenge },
        }),
      );
      assertEquals(deleted.status, 200);
      assertEquals(((await deleted.json()) as { deleted: boolean }).deleted, true);
      assertEquals(gotrue.seen.user, 2);

      // After deletion GoTrue no longer knows the user and every row is gone.
      gotrue.restore();
      const gone = stubGetUser(() =>
        jsonResponse(403, {
          code: 403,
          error_code: "user_not_found",
          msg: "User from sub claim in JWT does not exist",
        }),
      );
      try {
        h.tables.profiles = [];
        h.tables.account_deletion_requests = [];

        // 60 s later, device B calls again.
        now += 60_000;
        const b2 = await h.handler(userRequest("GET", "/v1/me", { token: bearerB, ip: ipB }));
        const body = await b2.text();
        assertEquals(
          b2.status,
          401,
          `OBSERVED: 60 s after delete-confirm bearer B still passes authenticate() from the cache — edge answered ${b2.status} ${body} (getUser calls: ${gone.seen.user}); ` +
            "expected 401 so the second device signs out, since the account no longer exists",
        );
        assertEquals(gone.seen.user, 1, "bearer B must be re-verified with Supabase Auth");
        assert((await cacheGet(`auth:${await sha256Hex(bearerB)}`)) === null);
      } finally {
        gone.restore();
      }
    } finally {
      Date.now = realNow;
    }
  },
);

Deno.test(
  "BROKEN F2 (P2, cache mirror): loadIsolate ×2 + fakeUpstash — isolate A's delete-confirm cacheDel leaves isolate B's auth entry (and the L2 copy) alive for ~570 s, not ≤60 s",
  async () => {
    const realNow = Date.now;
    let now = 1_800_002_000_000;
    Date.now = () => now;
    configureRedis(true);
    const redis = fakeUpstash();
    try {
      const isoA = await loadIsolate();
      const isoB = await loadIsolate();
      assert(isoA.cache.redisConfigured() && isoB.cache.redisConfigured());

      const userId = TEST_USER_ID;
      const bearerA = supabaseAccessToken({ expSec: now / 1000 + 3600, jti: "iso-A" });
      const bearerB = supabaseAccessToken({ expSec: now / 1000 + 3600, jti: "iso-B" });
      const keyA = `auth:${await isoA.cache.sha256Hex(bearerA)}`;
      const keyB = `auth:${await isoB.cache.sha256Hex(bearerB)}`;

      // Mirror of writeAuthCache(): 600 s cap − 30 s → ttl 570 s, expiresAtMs = now + 600 s.
      const entry = (accessToken: string) =>
        JSON.stringify({
          userId,
          email: null,
          provider: "google",
          accessToken,
          expiresAtMs: now + 600_000,
        });
      await isoA.cache.cacheSet(keyA, entry(bearerA), 570);
      await isoB.cache.cacheSet(keyB, entry(bearerB), 570);
      assert(redis.store.has(keyA) && redis.store.has(keyB), "both entries reached L2");

      // Mirror of confirmAccountDeletion()'s eviction, executed in isolate A with bearer A.
      await isoA.cache.cacheDel(`rank:${userId}`, `progress:${userId}`, keyA);
      assertEquals(await isoA.cache.cacheGet(keyA), null);

      // ≤60 s later, isolate B (and a brand-new isolate C reading L2) still see bearer B.
      now += 60_000;
      const isoC = await loadIsolate();
      const seenByB = await isoB.cache.cacheGet(keyB);
      const seenByC = await isoC.cache.cacheGet(keyB);
      const survivesL2 = redis.store.has(keyB);
      // Document the real window: the entry only disappears when its own TTL runs out.
      const savedNow = now;
      now = savedNow - 60_000 + 569_000;
      const at569 = await isoC.cache.cacheGet(keyB);
      now = savedNow - 60_000 + 571_000;
      const at571 = await isoC.cache.cacheGet(keyB);
      now = savedNow;

      assertEquals(
        seenByB,
        null,
        `OBSERVED: 60 s after isolate A's delete-confirm eviction, isolate B still serves bearer B from L1 (${seenByB !== null}), ` +
          `a fresh isolate C warms it from L2 (${seenByC !== null}), Redis still holds the key (${survivesL2}); ` +
          `entry alive at +569 s: ${at569 !== null}, gone at +571 s: ${at571 === null} — i.e. the window is the full 570 s cache TTL, not ≤60 s`,
      );
      assertEquals(seenByC, null);
      assertEquals(survivesL2, false);
    } finally {
      redis.restore();
      configureRedis(false);
      Date.now = realNow;
    }
  },
);

// ─── F1b (P3): a 70 KB refreshToken is forwarded to GoTrue ──────────────────

Deno.test(
  "BROKEN F1b (P3): refresh with a 70 KB refreshToken should be a 400 without a GoTrue call (only the 5 MB JSON cap applies today)",
  async () => {
    h.reset();
    const inner = globalThis.fetch;
    let tokenCalls = 0;
    let forwardedBytes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
        tokenCalls += 1;
        forwardedBytes = (await request.text()).length;
        return jsonResponse(400, {
          code: 400,
          error_code: "refresh_token_not_found",
          msg: "Invalid Refresh Token",
        });
      }
      return inner(request);
    }) as typeof fetch;
    try {
      const rand = mulberry32(SEED ^ 0xb);
      const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789-_";
      let refreshToken = "";
      while (refreshToken.length < 70_000)
        refreshToken += alphabet[Math.floor(rand() * alphabet.length)];
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.204" },
          body: JSON.stringify({ refreshToken }),
        }),
      );
      await response.body?.cancel();
      assertEquals(
        tokenCalls,
        0,
        `OBSERVED: the 70 000-char refreshToken was forwarded to GoTrue (${tokenCalls} call, ${forwardedBytes} body bytes; edge answered ${response.status}); ` +
          "real Supabase refresh tokens are short opaque strings — an implausible length should be refused pre-upstream",
      );
      assertEquals(response.status, 400);
    } finally {
      globalThis.fetch = inner;
    }
  },
);

// ─── F3 (P2): refresh retry storm while GoTrue is 5xx ───────────────────────
//
// refreshSessionRoute() calls supabase-js `auth.refreshSession()`, whose
// `_refreshAccessToken` wraps the request in auth-js `retryable()` with
// exponential backoff (200 ms · 2^n, up to MAX_RETRIES=10 or the 30 s tick).
// A 5xx / unreachable GoTrue therefore holds each refresh request ~25 s and
// multiplies upstream load ~8× before the edge finally answers 503.
// (`logoutRoute` calls GoTrue's REST endpoint directly and has no such retry.)
// Real clock on purpose: the library's stop condition reads Date.now().

Deno.test(
  "BROKEN F3 (P2): refresh while GoTrue answers 503 should fail fast with ONE upstream attempt — auth-js retries ~8× for ~25 s instead",
  async () => {
    h.reset();
    const inner = globalThis.fetch;
    const attemptsAt: number[] = [];
    const startedAt = Date.now();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/token") {
        attemptsAt.push(Date.now() - startedAt);
        return Promise.resolve(new Response(null, { status: 503 })); // HTTP/2-style: no reason phrase, no body
      }
      return inner(request);
    }) as typeof fetch;
    try {
      const response = await h.handler(
        new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.205" },
          body: JSON.stringify({ refreshToken: "rt-live" }),
        }),
      );
      const elapsedMs = Date.now() - startedAt;
      const body = await response.text();
      assertEquals(response.status, 503, "the eventual answer is the generic 503");
      assertEquals(body.includes("503"), false, "body stays generic");
      assertEquals(
        attemptsAt.length,
        1,
        `OBSERVED: ${attemptsAt.length} GoTrue attempts at +${attemptsAt.map((t) => (t / 1000).toFixed(1)).join("s, +")}s; ` +
          `the request was held for ${(elapsedMs / 1000).toFixed(1)} s before the 503 — expected one attempt and a fast 503 so the app's own backoff (sessionKeeper) paces the retries`,
      );
    } finally {
      globalThis.fetch = inner;
    }
  },
);
