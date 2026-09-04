// Deterministic reproduction distilled from the seeded campaign (soft
// invariant UPSTREAM_5XX_NOT_AUTH_FAILURE): when Supabase Auth answers a
// bearer verification with a 5xx, authenticate() collapses it into a 401 and
// the router charges the per-IP auth-failure budget for it. refreshSessionRoute
// and logoutRoute already map upstream 5xx to 503 — authenticate() does not.
//
// These tests FAIL on the current index.ts and are deliberately not
// auto-discovered by `deno task test` (no *_test.ts name).
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json xc_rsm_c/repros/upstream_5xx_repro.ts

import { assertEquals } from "@std/assert";
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
  name: "a 503 from Supabase Auth getUser must surface as 503, not 401 (index.ts authenticate)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    await withIsolate(async (fake, solo) => {
      const accessToken = await mint(solo, "getuser-503");
      fake.faults.set(accessToken, { kind: "getuser", status: 503 });
      const status = await drain(await request(solo, "/v1/me", accessToken));
      assertEquals(fake.calls.at(-1)?.status, 503, "fake Auth really answered 503");
      // refreshSessionRoute/logoutRoute map upstream 5xx → 503 (serviceUnavailable);
      // authenticate() returns 401 "The session is no longer valid. Sign in again."
      assertEquals(status, 503);
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
      // so the IP must not be locked out. Observed: 429 for the rest of the
      // 5-minute authfail window.
      assertEquals(status, 200);
    });
  },
});
