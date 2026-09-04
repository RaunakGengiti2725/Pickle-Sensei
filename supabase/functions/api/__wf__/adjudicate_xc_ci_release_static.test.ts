// Adjudication reproductions for area xc-ci-release-static (commit 4d812e1a) —
// this file carries the XC-RS-03 case (LOGOUT-1) only; the other cases of the
// area are owned by their own fix clusters.
//
// Each test asserts the EXPECTED contract (AGENTS.md "Auth sessions": anything
// transient must stay retryable for the app). A failing test here is a
// reproduced defect, not a harness problem — the observed status is printed
// beside the expectation so the log doubles as evidence.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json adjudicate_xc_ci_release_static.test.ts

import { assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase-issued ACCESS token (iss ends in /auth/v1). */
function fakeSupabaseAccessToken(sub = TEST_USER_ID, salt = ""): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

type Fault = (request: Request) => Promise<Response> | Response | null;

/** Install a fault in front of the harness' stubbed fetch for the duration of `run`. */
async function withFault<T>(fault: Fault, run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const injected = await fault(request.clone());
    if (injected) return injected;
    return base(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = base;
  }
}

const healthyUser = () => ({
  id: TEST_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "apple", providers: ["apple"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
});

async function statusOf(
  handler: (request: Request) => Promise<Response>,
  init: {
    method: string;
    path: string;
    ip: string;
    bearer?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "x-forwarded-for": init.ip,
    "content-type": "application/json",
  };
  if (init.bearer) headers.Authorization = `Bearer ${init.bearer}`;
  const response = await handler(
    new Request(`http://edge.test${init.path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return { status: response.status, body: await response.text() };
}

// ── LOGOUT-1: /v1/auth/logout network error to Supabase Auth → generic 500.
Deno.test("LOGOUT-1 /v1/auth/logout answers 503 (not 500) when Auth is unreachable", async () => {
  const h = await loadHarness();
  const ip = "10.4.0.1";
  const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "logout");
  const observed = await withFault(
    (request) => {
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
        return jsonResponse(200, healthyUser());
      }
      if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/logout`)) {
        return Promise.reject(new TypeError("connection reset"));
      }
      return null;
    },
    () =>
      statusOf(h.handler, {
        method: "POST",
        path: "/v1/auth/logout",
        ip,
        bearer,
      }),
  );
  console.log(`  [LOGOUT-1] observed ${observed.status} ${observed.body}`);
  assertEquals(
    observed.status,
    503,
    `logout on Auth network error must be the generic 503 'temporarily unavailable', observed ${observed.status}`,
  );
});
