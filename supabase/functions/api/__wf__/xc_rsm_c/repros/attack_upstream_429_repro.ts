// Adversarial variant of upstream_5xx_repro.ts (cluster XCF-03, candidate
// fcf951d8): `isAuthUpstreamOutage()` only recognises AuthRetryableFetchError,
// status 0 and status >= 500. Supabase Auth also answers requests that are NOT
// the bearer's fault with 429 `over_request_rate_limit` — `/auth/v1/token` is
// limited per IP at 1800/h with bursts of 30 (supabase.com/docs/guides/auth/
// rate-limits), and every refresh of every device reaches GoTrue from the edge
// function, not from the phone. Today that 429 is collapsed into the same 401
// "Sign in again" as a revoked token: the router charges recordAuthFailure()
// and the mobile sessionKeeper treats the 401 as non-retryable and signs the
// account out (sessionLifecycle.ts:89-90).
//
// Not auto-discovered by `deno task test` (no *_test.ts name):
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json xc_rsm_c/repros/attack_upstream_429_repro.ts

import { assert, assertEquals, assertMatch } from "@std/assert";
import { type EdgeIsolate, loadEdgeIsolate } from "../edgeIsolates.ts";
import { FakeSupabase } from "../fakeSupabase.ts";
import { fakeIdToken } from "../tokens.ts";

const IP = "10.99.2.1";
const USER = {
  id: "0000c0de-0000-4000-8000-000000000003",
  provider: "google" as const,
  subject: "attack-429",
  email: "attack429@example.test",
};

function api(
  isolate: EdgeIsolate,
  path: string,
  init: RequestInit & { ip?: string },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-forwarded-for", init.ip ?? IP);
  return isolate.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      ...init,
      headers,
    }),
  );
}

async function drain(response: Response): Promise<number> {
  await response.text();
  return response.status;
}

/** The retryable shape the candidate already emits for a 5xx outage. */
async function assertRetryableNotSignOut(response: Response): Promise<void> {
  assert(
    response.status === 503 || response.status === 429,
    `expected a retryable 503/429, got ${response.status}`,
  );
  assertMatch(response.headers.get("Retry-After") ?? "", /^[1-9]\d*$/);
  const body = (await response.json()) as { error?: { message?: string } };
  assert(
    !/sign in again/i.test(body.error?.message ?? ""),
    "an upstream rate limit is not a sign-out",
  );
}

async function mint(
  isolate: EdgeIsolate,
  nonce: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const idToken = fakeIdToken(
    "google",
    USER.subject,
    Math.floor(Date.now() / 1000) + 3600,
    nonce,
  );
  const response = await api(isolate, "/v1/account/bootstrap", {
    method: "POST",
    headers: { Authorization: `Bearer ${idToken}` },
    ip: "10.99.2.200",
  });
  assertEquals(response.status, 200);
  const body = (await response.json()) as {
    session: { accessToken: string; refreshToken: string };
  };
  return body.session;
}

let counter = 0;
async function withIsolate(
  body: (fake: FakeSupabase, isolate: EdgeIsolate) => Promise<void>,
): Promise<void> {
  const fake = new FakeSupabase();
  fake.install();
  fake.addUser(USER);
  try {
    counter += 1;
    await body(
      fake,
      await loadEdgeIsolate(`attack429-${counter}`, { redis: false }),
    );
  } finally {
    fake.restore();
  }
}

Deno.test({
  name:
    "ATTACK XCF-03: GoTrue 429 on the refresh grant must not become a 401 'Sign in again' (mobile signs the account out)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const { refreshToken } = await mint(solo, "refresh-429");
      fake.faults.set(refreshToken, { kind: "refresh", status: 429 });
      const response = await api(solo, "/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      assertEquals(
        fake.calls.at(-1)?.status,
        429,
        "fake Auth really answered 429",
      );
      // The session is intact server-side (the fault consumed the call, the
      // token was not rotated); the ONLY implicit sign-out the app performs is
      // a 401/403 from this route.
      assert(
        fake.refreshTokens.has(refreshToken),
        "the refresh token is still current upstream",
      );
      await assertRetryableNotSignOut(response);
    });
  },
});

Deno.test({
  name:
    "ATTACK XCF-03: GoTrue 429 on getUser is not the client's auth failure — 30 of them must not lock the IP out",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      for (let i = 0; i < 30; i += 1) {
        const { accessToken } = await mint(solo, `getuser-429-${i}`);
        fake.faults.set(accessToken, { kind: "getuser", status: 429 });
        const response = await api(solo, "/v1/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        assertEquals(
          fake.calls.at(-1)?.status,
          429,
          "fake Auth really answered 429",
        );
        await assertRetryableNotSignOut(response);
      }
      const healthy = await mint(solo, "recovered-429");
      const status = await drain(
        await api(solo, "/v1/me", {
          method: "GET",
          headers: { Authorization: `Bearer ${healthy.accessToken}` },
        }),
      );
      assertEquals(status, 200, "a valid bearer from that IP is still served");
    });
  },
});

Deno.test({
  name:
    "ATTACK XCF-03: GoTrue 429 on signInWithIdToken (bootstrap) is retryable, not 'token could not be verified'",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const idToken = fakeIdToken(
        "google",
        USER.subject,
        Math.floor(Date.now() / 1000) + 3600,
        "signin-429",
      );
      fake.faults.set(idToken, { kind: "signin", status: 429 });
      const response = await api(solo, "/v1/account/bootstrap", {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      assertEquals(
        fake.calls.at(-1)?.status,
        429,
        "fake Auth really answered 429",
      );
      // bootstrap.ts:231 maps 401/403 to the non-retryable `account.rejected`.
      assert(
        response.status !== 401 && response.status !== 403,
        `got ${response.status}`,
      );
      await assertRetryableNotSignOut(response);
    });
  },
});
