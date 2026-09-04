// Durable-session contract of the edge function, end to end through the real
// handler against a stateful fake GoTrue (xc_sessionHarness.ts). Written on
// the mutation-testing attack branch for the survivors ED-03..ED-14, ED-16..19,
// ED-21, ED-22: before this file no test exercised getUser() verification,
// the refresh_token grant, logout, or cache lifetime — so a handler that
// skipped verification, never revoked, cached forever, or returned no session
// passed the suite.
//
//   cd supabase/functions/api/__wf__ && deno task test xc_session_contract_test.ts

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { FakeTime } from "jsr:@std/testing@1/time";
import {
  APPLE_USER_ID,
  EMAIL_USER_ID,
  GOOGLE_USER_ID,
  SUPABASE_URL,
  apiRequest,
  appleIdToken,
  errorMessage,
  forgedSessionToken,
  freshIp,
  googleIdToken,
  jwtPayload,
  loadSessionHarness,
  withClockOffset,
  withFrozenClock,
} from "./xc_sessionHarness.ts";

interface SessionView {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

async function bootstrap(token = googleIdToken(), ip = freshIp()) {
  const h = await loadSessionHarness();
  const response = await h.handler(
    apiRequest("POST", "/v1/account/bootstrap", { token, ip, body: {} }),
  );
  const body = (await response.json()) as {
    user?: { id: string; email: string };
    onboardingState?: string;
    session?: SessionView;
    error?: { message: string };
  };
  return { response, body };
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

Deno.test(
  "bootstrap spends the provider token once and returns the minted session verbatim",
  async () => {
    const h = await loadSessionHarness();
    const { response, body } = await bootstrap(googleIdToken());
    assertEquals(response.status, 200);
    assertEquals(body.user?.id, GOOGLE_USER_ID);
    assertEquals(body.onboardingState, "complete");

    const grants = h.callsTo("/auth/v1/token?grant_type=id_token");
    assertEquals(grants.length, 1);
    const minted = [...h.sessions.values()][0];
    assertEquals(body.session, {
      accessToken: minted.accessToken,
      refreshToken: minted.refreshToken,
      expiresAt: minted.expiresAt,
    });
    assert(body.session!.expiresAt > Math.floor(Date.now() / 1000), "expiresAt is in the future");
    assertEquals(h.callsTo("/auth/v1/user").length, 0);
  },
);

Deno.test("bootstrap works for Apple exactly like Google (session shape identical)", async () => {
  const h = await loadSessionHarness();
  const { response, body } = await bootstrap(appleIdToken());
  assertEquals(response.status, 200);
  assertEquals(body.user?.id, APPLE_USER_ID);
  const minted = [...h.sessions.values()][0];
  assertEquals(body.session?.accessToken, minted.accessToken);
  assertEquals(body.session?.refreshToken, minted.refreshToken);
  assertEquals(body.session?.expiresAt, minted.expiresAt);
});

Deno.test("bootstrap refuses an already-expired provider token before any exchange", async () => {
  const h = await loadSessionHarness();
  const { response, body } = await bootstrap(googleIdToken(GOOGLE_USER_ID, -60));
  assertEquals(response.status, 401);
  assertStringIncludes(body.error?.message ?? "", "expired");
  assertEquals(h.callsTo("/auth/v1/token").length, 0);
});

Deno.test(
  "bootstrap with a provider token GoTrue rejects is a clean 401 (never a 500)",
  async () => {
    const { response, body } = await bootstrap(googleIdToken("no-such-user"));
    assertEquals(response.status, 401);
    assertStringIncludes(body.error?.message ?? "", "could not be verified");
  },
);

// ─── authenticate(): session tokens ──────────────────────────────────────────

Deno.test(
  "a bootstrapped access token authenticates via getUser and is then served from cache",
  async () => {
    const h = await loadSessionHarness();
    const { body } = await bootstrap();
    const token = body.session!.accessToken;

    const first = await h.handler(apiRequest("GET", "/v1/me", { token }));
    assertEquals(first.status, 200);
    assertEquals(((await first.json()) as { user: { id: string } }).user.id, GOOGLE_USER_ID);
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    const second = await h.handler(apiRequest("GET", "/v1/me", { token }));
    assertEquals(second.status, 200);
    await second.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1, "second request served from the auth cache");
  },
);

Deno.test(
  "a Supabase-shaped bearer nobody minted is refused — verification is never skipped",
  async () => {
    const h = await loadSessionHarness();
    const response = await h.handler(apiRequest("GET", "/v1/me", { token: forgedSessionToken() }));
    assertEquals(response.status, 401);
    assertStringIncludes(await errorMessage(response), "no longer valid");
    assertEquals(h.callsTo("/auth/v1/user").length, 1, "the forged token was checked upstream");
  },
);

Deno.test(
  "a session whose account is not Google/Apple is refused even though GoTrue accepts it",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(EMAIL_USER_ID);
    const response = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
    assertEquals(response.status, 401);
    assertStringIncludes(await errorMessage(response), "Google or Apple");
  },
);

Deno.test(
  "a bearer from an unknown issuer is refused up front without consulting GoTrue",
  async () => {
    const h = await loadSessionHarness();
    const token = forgedSessionToken().split(".");
    const evil = `${token[0]}.${btoa(
      JSON.stringify({
        iss: "https://evil.example/tokens",
        sub: GOOGLE_USER_ID,
        exp: 9_999_999_999,
      }),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "")}.${token[2]}`;
    const response = await h.handler(apiRequest("GET", "/v1/me", { token: evil }));
    assertEquals(response.status, 401);
    assertStringIncludes(await errorMessage(response), "not a session token");
    assertEquals(h.callsTo("/auth/v1/user").length, 0);
    assertEquals(h.callsTo("/auth/v1/token").length, 0);
  },
);

Deno.test("an expired session token is refused before cache or GoTrue", async () => {
  const h = await loadSessionHarness();
  const minted = h.mintSession(GOOGLE_USER_ID, -30);
  const response = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
  assertEquals(response.status, 401);
  assertStringIncludes(await errorMessage(response), "expired");
  assertEquals(h.callsTo("/auth/v1/user").length, 0);
});

// ─── authenticate(): provider tokens (transitional branch) ──────────────────

Deno.test("a provider ID token is exchanged once and then served from cache", async () => {
  const h = await loadSessionHarness();
  const token = googleIdToken();
  const first = await h.handler(apiRequest("GET", "/v1/me", { token }));
  assertEquals(first.status, 200);
  await first.body?.cancel();
  const second = await h.handler(apiRequest("GET", "/v1/me", { token }));
  assertEquals(second.status, 200);
  await second.body?.cancel();
  assertEquals(h.callsTo("/auth/v1/token?grant_type=id_token").length, 1);
});

Deno.test("a provider ID token GoTrue rejects is a clean 401 from authenticate()", async () => {
  const h = await loadSessionHarness();
  const response = await h.handler(
    apiRequest("GET", "/v1/me", { token: appleIdToken("stranger") }),
  );
  assertEquals(response.status, 401);
  assertStringIncludes(await errorMessage(response), "could not be verified");
});

// ─── Cache lifetime ──────────────────────────────────────────────────────────

Deno.test(
  "the auth cache never outlives the bearer: a 5-minute session token is re-verified after 4.5 minutes",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID, 300);
    await withFrozenClock(async () => {
      const first = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(first.status, 200);
      await first.body?.cancel();
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    await withClockOffset(270_000, async () => {
      const later = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(later.status, 200);
      await later.body?.cancel();
    });
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      2,
      "cache entry expired with the bearer, not at the 10-minute cap",
    );
  },
);

Deno.test("the auth cache never outlives the bearer for a provider token either", async () => {
  const h = await loadSessionHarness();
  const token = googleIdToken(GOOGLE_USER_ID, 300);
  await withFrozenClock(async () => {
    const first = await h.handler(apiRequest("GET", "/v1/me", { token }));
    assertEquals(first.status, 200);
    await first.body?.cancel();
  });
  await withClockOffset(270_000, async () => {
    const later = await h.handler(apiRequest("GET", "/v1/me", { token }));
    assertEquals(later.status, 200);
    await later.body?.cancel();
  });
  assertEquals(h.callsTo("/auth/v1/token?grant_type=id_token").length, 2);
});

Deno.test(
  "a verified session is re-checked with GoTrue at most 10 minutes later even if the bearer lives for an hour",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID, 3600);
    await withFrozenClock(async () => {
      const first = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(first.status, 200);
      await first.body?.cancel();
    });
    await withClockOffset(9 * 60_000, async () => {
      const warm = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(warm.status, 200);
      await warm.body?.cancel();
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 1, "still cached inside the 10-minute window");
    await withClockOffset(11 * 60_000, async () => {
      const cold = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken }));
      assertEquals(cold.status, 200);
      await cold.body?.cancel();
    });
    assertEquals(h.callsTo("/auth/v1/user").length, 2, "re-verified after the 10-minute cap");
  },
);

// ─── Refresh ─────────────────────────────────────────────────────────────────

Deno.test(
  "refresh rotates both tokens; the old refresh token is dead and the new bearer authenticates",
  async () => {
    const h = await loadSessionHarness();
    const { body } = await bootstrap();
    const initial = body.session!;

    const rotated = await h.handler(
      apiRequest("POST", "/v1/auth/refresh", {
        token: null,
        body: { refreshToken: initial.refreshToken },
      }),
    );
    assertEquals(rotated.status, 200);
    const next = ((await rotated.json()) as { session: SessionView }).session;
    assertNotEquals(next.accessToken, initial.accessToken);
    assertNotEquals(next.refreshToken, initial.refreshToken);
    assert(next.expiresAt > Math.floor(Date.now() / 1000));
    const grants = h.callsTo("grant_type=refresh_token");
    assertEquals(grants.length, 1);
    assertEquals((grants[0].body as { refresh_token: string }).refresh_token, initial.refreshToken);

    const me = await h.handler(apiRequest("GET", "/v1/me", { token: next.accessToken }));
    assertEquals(me.status, 200);
    await me.body?.cancel();

    const replay = await h.handler(
      apiRequest("POST", "/v1/auth/refresh", {
        token: null,
        body: { refreshToken: initial.refreshToken },
      }),
    );
    assertEquals(replay.status, 401);
    assertStringIncludes(await errorMessage(replay), "Sign in again");
  },
);

Deno.test(
  "refresh with a refresh token GoTrue does not know is 401 — the only implicit sign-out signal",
  async () => {
    const h = await loadSessionHarness();
    const response = await h.handler(
      apiRequest("POST", "/v1/auth/refresh", {
        token: null,
        body: { refreshToken: "rt-never-issued" },
      }),
    );
    assertEquals(response.status, 401);
    assertStringIncludes(await errorMessage(response), "could not be refreshed");
  },
);

Deno.test(
  "refresh while GoTrue is failing (5xx) is 503, never a 401 that would sign the device out",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID);
    h.refreshGrantStatus = 500;
    // supabase-js retries a 5xx refresh with exponential backoff for up to
    // ~30s of wall clock; fake time drives those timers instead of waiting.
    using time = new FakeTime();
    const pending = h.handler(
      apiRequest("POST", "/v1/auth/refresh", {
        token: null,
        body: { refreshToken: minted.refreshToken },
      }),
    );
    let settled = false;
    const tracked = pending.then((response) => {
      settled = true;
      return response;
    });
    for (let i = 0; i < 20 && !settled; i += 1) {
      await time.tickAsync(5_000);
    }
    const response = await tracked;
    assertEquals(response.status, 503);
    await response.body?.cancel();
    assert(h.callsTo("grant_type=refresh_token").length >= 1);
  },
);

Deno.test("refresh without a refreshToken is a 400 validation error", async () => {
  const h = await loadSessionHarness();
  const response = await h.handler(
    apiRequest("POST", "/v1/auth/refresh", { token: null, body: {} }),
  );
  assertEquals(response.status, 400);
  await response.body?.cancel();
  assertEquals(h.callsTo("/auth/v1/token").length, 0);
});

Deno.test("refused refreshes count toward the per-IP auth-failure budget", async () => {
  const h = await loadSessionHarness();
  const ip = freshIp();
  await withFrozenClock(async () => {
    for (let i = 0; i < 30; i += 1) {
      const response = await h.handler(
        apiRequest("POST", "/v1/auth/refresh", {
          token: null,
          ip,
          body: { refreshToken: `rt-bogus-${i}` },
        }),
      );
      assertEquals(response.status, 401);
      await response.body?.cancel();
    }
    const minted = h.mintSession(GOOGLE_USER_ID);
    const blocked = await h.handler(apiRequest("GET", "/v1/me", { token: minted.accessToken, ip }));
    assertEquals(blocked.status, 429, "a good bearer from the failing IP is throttled");
    assert(Number(blocked.headers.get("Retry-After")) >= 1);
    await blocked.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 0);
  });
});

Deno.test(
  "refresh has its own per-IP budget: the 31st rotation in a minute is 429 even when every token is valid",
  async () => {
    const h = await loadSessionHarness();
    const ip = freshIp();
    let refreshToken = h.mintSession(GOOGLE_USER_ID).refreshToken;
    await withFrozenClock(async () => {
      for (let i = 0; i < 30; i += 1) {
        const response = await h.handler(
          apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }),
        );
        assertEquals(response.status, 200, `rotation ${i + 1}`);
        refreshToken = ((await response.json()) as { session: SessionView }).session.refreshToken;
      }
      const throttled = await h.handler(
        apiRequest("POST", "/v1/auth/refresh", { token: null, ip, body: { refreshToken } }),
      );
      assertEquals(throttled.status, 429);
      await throttled.body?.cancel();
      assertEquals(
        h.callsTo("grant_type=refresh_token").length,
        30,
        "the throttled call never reached GoTrue",
      );
    });
  },
);

// ─── Logout ──────────────────────────────────────────────────────────────────

Deno.test(
  "logout revokes THIS device's session at GoTrue with scope=local, kills its refresh token and evicts the cached bearer",
  async () => {
    const h = await loadSessionHarness();
    const { body } = await bootstrap();
    const { accessToken, refreshToken } = body.session!;
    const otherDevice = h.mintSession(GOOGLE_USER_ID);

    const warm = await h.handler(apiRequest("GET", "/v1/me", { token: accessToken }));
    assertEquals(warm.status, 200);
    await warm.body?.cancel();
    assertEquals(h.callsTo("/auth/v1/user").length, 1);

    const logout = await h.handler(apiRequest("POST", "/v1/auth/logout", { token: accessToken }));
    assertEquals(logout.status, 204);

    const revocations = h.callsTo(`${SUPABASE_URL}/auth/v1/logout`);
    assertEquals(revocations.length, 1, "GoTrue was told to revoke the session");
    assertEquals(new URL(revocations[0].url).searchParams.get("scope"), "local");
    assertEquals(revocations[0].headers["authorization"], `Bearer ${accessToken}`);

    // The bearer no longer authenticates — the cache entry is gone, GoTrue says no.
    const after = await h.handler(apiRequest("GET", "/v1/me", { token: accessToken }));
    assertEquals(after.status, 401);
    assertStringIncludes(await errorMessage(after), "no longer valid");
    assertEquals(
      h.callsTo("/auth/v1/user").length,
      2,
      "re-verified after logout instead of served from cache",
    );

    // Its refresh token is dead too.
    const refresh = await h.handler(
      apiRequest("POST", "/v1/auth/refresh", { token: null, body: { refreshToken } }),
    );
    assertEquals(refresh.status, 401);
    await refresh.body?.cancel();

    // The other device's session survives (scope=local, not global).
    const other = await h.handler(apiRequest("GET", "/v1/me", { token: otherDevice.accessToken }));
    assertEquals(other.status, 200);
    await other.body?.cancel();
  },
);

Deno.test(
  "logout is idempotent from the client's view: a second logout of the same bearer is not an error the app must handle",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID);
    const first = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(first.status, 204);
    const second = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(second.status, 401, "the revoked bearer no longer authenticates at all");
    await second.body?.cancel();
  },
);

Deno.test(
  "logout surfaces a GoTrue outage as 503 so the app retries instead of assuming the session died",
  async () => {
    const h = await loadSessionHarness();
    const minted = h.mintSession(GOOGLE_USER_ID);
    h.logoutStatus = 503;
    const response = await h.handler(
      apiRequest("POST", "/v1/auth/logout", { token: minted.accessToken }),
    );
    assertEquals(response.status, 503);
    await response.body?.cancel();
  },
);

// ─── Session-shape sanity used by the mobile vault ───────────────────────────

Deno.test(
  "the access token bootstrap returns is a Supabase-issued JWT whose exp matches expiresAt",
  async () => {
    const { body } = await bootstrap();
    const claims = jwtPayload(body.session!.accessToken);
    assertEquals(claims?.iss, `${SUPABASE_URL}/auth/v1`);
    assertEquals(claims?.exp, body.session!.expiresAt);
  },
);
