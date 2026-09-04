// Deterministic reproduction distilled from the seeded campaign (invariant
// UPSTREAM_5XX_NOT_AUTH_FAILURE): when Supabase Auth answers a bearer
// verification with a 5xx — or the fetch to it fails outright —
// authenticate() must not collapse the outage into a 401 "session no longer
// valid" (the app treats that as a sign-out) nor let the router charge the
// per-IP auth-failure budget for it. The contract is the one refreshSessionRoute
// and logoutRoute already follow: a generic 503 with Retry-After and no-store,
// which the mobile outbox retries like any other 5xx.
//
// Not auto-discovered by `deno task test` (no *_test.ts name):
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json xc_rsm_c/repros/upstream_5xx_repro.ts

import { assert, assertEquals, assertMatch } from "@std/assert";
import { type EdgeIsolate, loadEdgeIsolate } from "../edgeIsolates.ts";
import { FakeSupabase } from "../fakeSupabase.ts";
import { fakeIdToken } from "../tokens.ts";

const IP = "10.99.1.1";
const USER = {
  id: "0000c0de-0000-4000-8000-000000000002",
  provider: "google" as const,
  subject: "repro-5xx",
  email: "repro5xx@example.test",
};

function request(isolate: EdgeIsolate, path: string, bearer: string, ip = IP): Promise<Response> {
  return isolate.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, {
      method: "GET",
      headers: { "x-forwarded-for": ip, Authorization: `Bearer ${bearer}` },
    }),
  );
}

async function drain(response: Response): Promise<number> {
  await response.text();
  return response.status;
}

/** The retryable-outage shape: 503, Retry-After, no-store, generic JSON body. */
async function assertServiceUnavailable(response: Response): Promise<void> {
  assertEquals(response.status, 503);
  assertMatch(response.headers.get("Retry-After") ?? "", /^[1-9]\d*$/);
  assertEquals(response.headers.get("Cache-Control"), "no-store");
  const body = (await response.json()) as { error?: { message?: string } };
  assertEquals(typeof body.error?.message, "string");
  assert(!/injected fault/i.test(body.error?.message ?? ""), "upstream detail must not leak");
  assert(!/sign in again/i.test(body.error?.message ?? ""), "an outage is not a sign-out");
}

async function mint(isolate: EdgeIsolate, nonce: string): Promise<string> {
  const idToken = fakeIdToken("google", USER.subject, Math.floor(Date.now() / 1000) + 3600, nonce);
  const response = await isolate.handler(
    new Request("http://edge.test/functions/v1/api/v1/account/bootstrap", {
      method: "POST",
      headers: { "x-forwarded-for": "10.99.1.200", Authorization: `Bearer ${idToken}` },
    }),
  );
  assertEquals(response.status, 200);
  return ((await response.json()) as { session: { accessToken: string } }).session.accessToken;
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
    await body(fake, await loadEdgeIsolate(`repro5xx-${counter}`, { redis: false }));
  } finally {
    fake.restore();
  }
}

Deno.test({
  name: "a 503 from Supabase Auth getUser must surface as 503 + Retry-After, not 401 (index.ts authenticate)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const accessToken = await mint(solo, "getuser-503");
      fake.faults.set(accessToken, { kind: "getuser", status: 503 });
      const response = await request(solo, "/v1/me", accessToken);
      assertEquals(fake.calls.at(-1)?.status, 503, "fake Auth really answered 503");
      await assertServiceUnavailable(response);
      // Auth is back: the very same bearer is still good and the cache has
      // not memorised anything about the outage.
      assertEquals(await drain(await request(solo, "/v1/me", accessToken)), 200);
    });
  },
});

Deno.test({
  name: "a failed fetch to Supabase Auth (network error) surfaces as 503 + Retry-After, not 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (_fake, solo) => {
      const accessToken = await mint(solo, "getuser-network");
      const fakeFetch = globalThis.fetch;
      let refused = 0;
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url.includes("/auth/v1/user") && refused === 0) {
          refused += 1;
          return Promise.reject(new TypeError("error sending request for url"));
        }
        return fakeFetch(input, init);
      }) as typeof fetch;
      try {
        const response = await request(solo, "/v1/me", accessToken);
        assertEquals(refused, 1, "the fetch to Auth really failed");
        await assertServiceUnavailable(response);
      } finally {
        globalThis.fetch = fakeFetch;
      }
      assertEquals(await drain(await request(solo, "/v1/me", accessToken)), 200);
    });
  },
});

Deno.test({
  name: "a genuine refusal from Supabase Auth (bad_jwt / session_not_found) is still a 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const forged = await mint(solo, "forged");
      fake.resetSessions();
      const response = await request(solo, "/v1/me", forged);
      assertEquals(fake.calls.at(-1)?.status, 401, "fake Auth refused the bearer");
      assertEquals(response.status, 401);
      assertEquals(response.headers.get("Retry-After"), null);
      const body = (await response.json()) as { error?: { message?: string } };
      assertMatch(body.error?.message ?? "", /sign in again/i);
    });
  },
});

Deno.test({
  name: "Auth 5xx must not consume the per-IP auth-failure budget (index.ts recordAuthFailure after authenticate)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      // 30 distinct valid bearers behind one NAT address, each verified while
      // Auth is degraded (AUTH_FAILURE_LIMIT = 30 / 300s).
      for (let i = 0; i < 30; i += 1) {
        const accessToken = await mint(solo, `outage-${i}`);
        fake.faults.set(accessToken, { kind: "getuser", status: 500 });
        await drain(await request(solo, "/v1/me", accessToken));
      }
      // Auth has recovered; a brand-new, perfectly valid bearer from that IP.
      const healthy = await mint(solo, "recovered");
      const status = await drain(await request(solo, "/v1/me", healthy));
      // Contract: an upstream outage is not the client's authentication failure,
      // so the IP must not be locked out.
      assertEquals(status, 200);
    });
  },
});

Deno.test({
  name: "a 5xx from Supabase Auth signInWithIdToken (bootstrap / transitional provider bearer) is a 503, not a 401",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const idToken = fakeIdToken(
        "google",
        USER.subject,
        Math.floor(Date.now() / 1000) + 3600,
        "signin-outage",
      );
      fake.faults.set(idToken, { kind: "signin", status: 502 });
      const bootstrap = await solo.handler(
        new Request("http://edge.test/functions/v1/api/v1/account/bootstrap", {
          method: "POST",
          headers: { "x-forwarded-for": IP, Authorization: `Bearer ${idToken}` },
        }),
      );
      assertEquals(fake.calls.at(-1)?.status, 502, "fake Auth really answered 502");
      await assertServiceUnavailable(bootstrap);

      fake.faults.set(idToken, { kind: "signin", status: 500 });
      await assertServiceUnavailable(await request(solo, "/v1/me", idToken));

      // Recovered: the same ID token still bootstraps.
      assertEquals(
        await drain(
          await solo.handler(
            new Request("http://edge.test/functions/v1/api/v1/account/bootstrap", {
              method: "POST",
              headers: { "x-forwarded-for": IP, Authorization: `Bearer ${idToken}` },
            }),
          ),
        ),
        200,
      );
    });
  },
});
