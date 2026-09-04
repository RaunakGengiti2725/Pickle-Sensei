// Identity + eviction invariants the durable-session suite left unpinned
// (found by mutation: tools/mutation-auth ED-23, ED-24, ED-25 survive
// auth_session_contract_test.ts / auth_cache_redis_test.ts):
//
//   * every real account's provider subject (Google `sub`, Apple `sub`) is
//     NOT its Supabase uuid, so a handler that identifies the user by the
//     provider subject must fail — the legacy fixtures made the two equal;
//   * logout must evict the cached bearer even when GoTrue already considers
//     the session gone (revoked elsewhere / expired) — otherwise the bearer
//     keeps working at this edge for up to the cache lifetime;
//   * an identity served from the auth cache keeps its verified provider
//     (account deletion's Apple revocation branch keys off it).
//
//   cd supabase/functions/api/__wf__ && deno task test auth_identity_contract_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  APPLE_USER_ID,
  DISTINCT_APPLE_SUBJECT,
  DISTINCT_APPLE_USER_ID,
  DISTINCT_GOOGLE_SUBJECT,
  DISTINCT_GOOGLE_USER_ID,
  GOOGLE_USER_ID,
  apiRequest,
  appleIdToken,
  googleIdToken,
  jwtPayload,
  loadSessionHarness,
} from "./sessionHarness.ts";

interface MeBody {
  user?: { id: string; email: string };
  session?: { accessToken: string; refreshToken: string; expiresAt: number };
  error?: { message: string };
}

function assertNeverNamed(subject: string, calls: Array<{ url: string; body: unknown }>) {
  for (const call of calls) {
    assert(!call.url.includes(subject), `provider subject leaked into a request URL: ${call.url}`);
    assert(
      !JSON.stringify(call.body ?? null).includes(subject),
      `provider subject leaked into a request body: ${call.url}`,
    );
  }
}

Deno.test(
  "bootstrap identifies the account by the verified Supabase user id, never by the Google subject",
  async () => {
    const h = await loadSessionHarness();
    const response = await h.handler(
      apiRequest("POST", "/v1/account/bootstrap", {
        token: googleIdToken(DISTINCT_GOOGLE_SUBJECT),
        body: {},
      }),
    );
    const body = (await response.json()) as MeBody;
    assertEquals(response.status, 200, body.error?.message);
    assertEquals(body.user?.id, DISTINCT_GOOGLE_USER_ID);
    assertEquals(jwtPayload(body.session!.accessToken)?.sub, DISTINCT_GOOGLE_USER_ID);

    const profileLookups = h.callsTo("/rest/v1/profiles");
    assert(profileLookups.length >= 1, "bootstrap read the profile row");
    for (const lookup of profileLookups) {
      assertEquals(new URL(lookup.url).searchParams.get("id"), `eq.${DISTINCT_GOOGLE_USER_ID}`);
    }
    assertNeverNamed(DISTINCT_GOOGLE_SUBJECT, h.callsTo("/rest/v1/"));

    const me = await h.handler(
      apiRequest("GET", "/v1/me", { token: body.session!.accessToken }),
    );
    assertEquals(me.status, 200);
    assertEquals(((await me.json()) as MeBody).user?.id, DISTINCT_GOOGLE_USER_ID);
  },
);

Deno.test(
  "bootstrap identifies the account by the verified Supabase user id, never by the Apple subject",
  async () => {
    const h = await loadSessionHarness();
    const response = await h.handler(
      apiRequest("POST", "/v1/account/bootstrap", {
        token: appleIdToken(DISTINCT_APPLE_SUBJECT),
        body: {},
      }),
    );
    const body = (await response.json()) as MeBody;
    assertEquals(response.status, 200, body.error?.message);
    assertEquals(body.user?.id, DISTINCT_APPLE_USER_ID);
    assertEquals(jwtPayload(body.session!.accessToken)?.sub, DISTINCT_APPLE_USER_ID);
    for (const lookup of h.callsTo("/rest/v1/profiles")) {
      assertEquals(new URL(lookup.url).searchParams.get("id"), `eq.${DISTINCT_APPLE_USER_ID}`);
    }
    assertNeverNamed(DISTINCT_APPLE_SUBJECT, h.callsTo("/rest/v1/"));
  },
);

Deno.test(
  "the transitional provider-token bearer is also identified by the exchanged Supabase user id",
  async () => {
    const h = await loadSessionHarness();
    const me = await h.handler(
      apiRequest("GET", "/v1/me", { token: googleIdToken(DISTINCT_GOOGLE_SUBJECT) }),
    );
    const body = (await me.json()) as MeBody;
    assertEquals(me.status, 200, body.error?.message);
    assertEquals(body.user?.id, DISTINCT_GOOGLE_USER_ID);
    for (const lookup of h.callsTo("/rest/v1/profiles")) {
      assertEquals(new URL(lookup.url).searchParams.get("id"), `eq.${DISTINCT_GOOGLE_USER_ID}`);
    }
  },
);

Deno.test(
  "logout evicts the cached bearer even when GoTrue already considers the session gone",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID);

    const warm = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(warm.status, 200);
    await warm.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    // Another device signed this account out globally (or the session expired
    // upstream): GoTrue no longer knows the session, but this edge still holds
    // it in the auth cache.
    minted.revoked = true;
    h.logoutStatus = 401;

    const logout = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(logout.status, 204, "an already-gone session is the outcome the caller wanted");
    assertEquals(h.callsTo("/auth/v1/logout").length, 1);

    h.logoutStatus = null;
    const after = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(after.status, 401, "the bearer must stop working at this edge immediately");
    assertStringIncludes(
      ((await after.json()) as MeBody).error?.message ?? "",
      "no longer valid",
    );
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      2,
      "the cache entry was evicted, so the bearer was re-verified with GoTrue and refused",
    );
  },
);

Deno.test(
  "an Apple session served from the auth cache still carries provider=apple downstream",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(APPLE_USER_ID);

    const warm = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(warm.status, 200);
    await warm.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    const response = await h.handler(
      apiRequest("POST", "/v1/me/delete-request", {
        token: minted.accessToken,
        body: { survey: { reason: "other", platform: "ios" } },
      }),
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1, "served from the auth cache");

    const feedback = h.callsTo("/rest/v1/account_deletion_feedback");
    assertEquals(feedback.length, 1, "the exit survey was recorded");
    const row = feedback[0].body as { user_id?: string; provider?: string };
    assertEquals(row.user_id, APPLE_USER_ID);
    assertEquals(row.provider, "apple");
  },
);
