// Deterministic reproductions distilled from the seeded campaign
// (xc_rsm_c/scripts/run_campaign.ts, invariant REVOKED_SESSION_REFUSED).
//
// Each test states the expected contract (AGENTS.md: "POST /v1/auth/logout
// revokes THIS device's session ... and drops the bearer from the auth
// cache") and FAILS on the current index.ts — they are bug reproductions,
// deliberately not auto-discovered by `deno task test` (no *_test.ts name).
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json xc_rsm_c/repros/logout_cache_repro.ts
//
// The fake Auth server refuses a revoked session's bearer on getUser exactly
// like GoTrue (session_not_found), and the fake PostgREST — like the real
// one, which only checks the JWT signature/exp — still answers with the row.
// So a 200/404 (an authenticated route decision) after logout can only come
// from the edge function's own auth cache.

import { assertEquals } from "@std/assert";
import { type EdgeIsolate, loadEdgeIsolate } from "../edgeIsolates.ts";
import { FakeSupabase, type GateEntry } from "../fakeSupabase.ts";
import { fakeIdToken } from "../tokens.ts";

const IP = "10.99.0.1";
const USER = {
  id: "0000c0de-0000-4000-8000-000000000001",
  provider: "google" as const,
  subject: "repro-sub",
  email: "repro@example.test",
};

function request(
  isolate: EdgeIsolate,
  method: string,
  path: string,
  bearer: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "x-forwarded-for": IP };
  if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return isolate.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function bootstrap(
  fake: FakeSupabase,
  isolate: EdgeIsolate,
  nonce: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  fake.addUser(USER);
  const idToken = fakeIdToken("google", USER.subject, Math.floor(Date.now() / 1000) + 3600, nonce);
  const response = await request(isolate, "POST", "/v1/account/bootstrap", idToken);
  assertEquals(response.status, 200, "bootstrap must mint a session");
  const body = (await response.json()) as {
    session: { accessToken: string; refreshToken: string };
  };
  return body.session;
}

async function drain(response: Response): Promise<number> {
  await response.text();
  return response.status;
}

let counter = 0;
async function withIsolates(
  redis: boolean,
  count: number,
  body: (fake: FakeSupabase, isolates: EdgeIsolate[]) => Promise<void>,
): Promise<void> {
  const fake = new FakeSupabase();
  fake.install();
  try {
    const isolates: EdgeIsolate[] = [];
    for (let i = 0; i < count; i += 1) {
      counter += 1;
      isolates.push(await loadEdgeIsolate(`repro-${counter}`, { redis }));
    }
    await body(fake, isolates);
  } finally {
    fake.restore();
  }
}

Deno.test({
  name: "logout must not leave the bearer authorized in ANOTHER isolate's L1 cache (index.ts logoutRoute → cache.ts cacheDel)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(true, 2, async (fake, [a, b]) => {
      const { accessToken } = await bootstrap(fake, a, "cross-isolate");
      assertEquals(await drain(await request(a, "GET", "/v1/me", accessToken)), 200);
      assertEquals(
        await drain(await request(b, "GET", "/v1/me", accessToken)),
        200,
        "isolate B verifies + caches the bearer",
      );
      assertEquals(await drain(await request(a, "POST", "/v1/auth/logout", accessToken)), 204);
      assertEquals(
        fake.sessionOfToken(accessToken)?.revoked,
        true,
        "fake Auth has revoked the session",
      );
      assertEquals(
        await drain(await request(a, "GET", "/v1/me", accessToken)),
        401,
        "isolate A (which handled the logout) refuses",
      );
      // Contract: the logged-out bearer is refused everywhere. Observed: 200
      // from isolate B's L1 for up to AUTH_CACHE_MAX_TTL_SECONDS - 30 = 570s.
      assertEquals(
        await drain(await request(b, "GET", "/v1/me", accessToken)),
        401,
        "isolate B must refuse the logged-out bearer",
      );
    });
  },
});

Deno.test({
  name: "a getUser verification that completes AFTER logout must not re-populate the auth cache (index.ts authenticate → writeAuthCache)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(false, 1, async (fake, [solo]) => {
      const { accessToken } = await bootstrap(fake, solo, "write-race");
      const parked: GateEntry[] = [];
      fake.gate = {
        shouldPark: (kind) => kind === "getuser",
        computeAt: () => "arrival", // GoTrue evaluated the JWT while the session was still alive
        park: (entry) => parked.push(entry),
      };
      // Request 1: /v1/me with an UNCACHED bearer → authenticate() is now
      // awaiting auth.getUser (the response is in transit).
      const slowMe = request(solo, "GET", "/v1/me", accessToken);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(parked.length, 1, "getUser is in flight");
      fake.gate = null;
      // Request 2: logout lands first → cacheDel + session revoked upstream.
      assertEquals(await drain(await request(solo, "POST", "/v1/auth/logout", accessToken)), 204);
      assertEquals(fake.sessionOfToken(accessToken)?.revoked, true);
      // Now the stale getUser answer arrives and authenticate() writes the cache.
      parked[0].release();
      assertEquals(
        await drain(await slowMe),
        200,
        "the in-flight request itself was legitimately authorized",
      );
      // Contract: a logged-out bearer is never served from cache. Observed: 200.
      assertEquals(
        await drain(await request(solo, "GET", "/v1/me", accessToken)),
        401,
        "next request must hit Auth and be refused",
      );
    });
  },
});

Deno.test({
  name: "writeAuthCache refuses to STORE an entry for a session revoked while its verification was in flight (observable in L2)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(true, 1, async (fake, [solo]) => {
      const { accessToken } = await bootstrap(fake, solo, "write-race-l2");
      // index.ts keys auth entries as `auth:${sha256Hex(token)}`.
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
      const entryKey = `auth:${[...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
      assertEquals(fake.redis.store.has(entryKey), false, "bearer not cached before first use");
      const parked: GateEntry[] = [];
      fake.gate = {
        shouldPark: (kind) => kind === "getuser",
        computeAt: () => "arrival",
        park: (entry) => parked.push(entry),
      };
      const slowMe = request(solo, "GET", "/v1/me", accessToken);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(parked.length, 1, "getUser is in flight");
      fake.gate = null;
      assertEquals(await drain(await request(solo, "POST", "/v1/auth/logout", accessToken)), 204);
      parked[0].release();
      assertEquals(await drain(await slowMe), 200);
      // The verification was answered before the logout, but the write lands
      // after it: the entry must not be stored anywhere, not merely masked.
      assertEquals(
        fake.redis.store.has(entryKey),
        false,
        "no auth entry may be written after the logout",
      );
      assertEquals(await drain(await request(solo, "GET", "/v1/me", accessToken)), 401);
    });
  },
});

Deno.test({
  name: "logout with the ROTATED bearer must also stop the previous bearer of the same session (index.ts logoutRoute deletes one token hash)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolates(false, 1, async (fake, [solo]) => {
      const first = await bootstrap(fake, solo, "sibling");
      assertEquals(
        await drain(await request(solo, "GET", "/v1/me", first.accessToken)),
        200,
        "first bearer verified + cached",
      );
      const refreshed = await request(solo, "POST", "/v1/auth/refresh", null, {
        refreshToken: first.refreshToken,
      });
      assertEquals(refreshed.status, 200);
      const rotated = ((await refreshed.json()) as { session: { accessToken: string } }).session
        .accessToken;
      assertEquals(await drain(await request(solo, "GET", "/v1/me", rotated)), 200);
      assertEquals(await drain(await request(solo, "POST", "/v1/auth/logout", rotated)), 204);
      assertEquals(
        fake.sessionOfToken(first.accessToken)?.revoked,
        true,
        "both bearers belong to the revoked session",
      );
      assertEquals(
        await drain(await request(solo, "GET", "/v1/me", rotated)),
        401,
        "the presented bearer is refused",
      );
      // Contract: the session is revoked, so its earlier (still unexpired)
      // bearer must be refused too. Observed: 200 from cache until that
      // bearer's own cache entry expires.
      assertEquals(
        await drain(await request(solo, "GET", "/v1/me", first.accessToken)),
        401,
        "the sibling bearer must be refused",
      );
    });
  },
});
