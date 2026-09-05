// PRE-EXISTING at f702f0f8 — NOT a break of a6fb880a (logoutRoute is untouched
// by the EACR-1 candidate). Recorded here because it is the same defect class
// the cluster fixes (a GoTrue transient answer misread as a verdict) on the one
// GoTrue call the new typed gateway does not cover.
//
// logoutRoute(): `if (!response.ok && response.status >= 500) → 503; else fall
// through to fenceRevokedSession(token) + 204`. A GoTrue 429 on
// /auth/v1/logout?scope=local is therefore answered 204: the app believes the
// device is signed out and drops its vault, the edge fences the bearer locally,
// but GoTrue never revoked the device's refresh token — it stays valid
// server-side. Observed on both a6fb880a and f702f0f8: 204, then GET /v1/me
// with the same bearer → 401 (fenced) while /auth/v1/logout was called once
// and answered 429.
//
//   cd supabase/functions/api/__wf__ && \
//     deno test -A --no-check --config deno.json preexisting_logout_gotrue_429_test.ts
import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID, userRequest } from "./routesHarness.ts";

const h = await loadHarness();

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function sessionToken(jti: string): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: TEST_USER_ID,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      session_id: crypto.randomUUID(),
      jti,
    }),
  );
  return `${header}.${payload}.sig`;
}

type GoTrueFault = (request: Request, url: URL) => Response | Promise<Response> | null;

async function withGoTrue<T>(fault: GoTrueFault, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1/")) {
      const handled = await fault(request.clone(), url);
      if (handled) return handled;
    }
    return previous(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

const goTrueJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

const healthyUser = () =>
  goTrueJson(200, {
    id: TEST_USER_ID,
    aud: "authenticated",
    role: "authenticated",
    email: null,
    app_metadata: { provider: "google", providers: ["google"] },
    identities: [{ provider: "google" }],
  });

Deno.test(
  "PRE-EXISTING: logout × GoTrue 429 → retryable 503/429 and the bearer stays valid (not 204 + fenced)",
  async () => {
    h.reset();
    h.tables.profiles = [
      { id: TEST_USER_ID, email: null, onboarding_state: "pending", provider: "google" },
    ];
    const ip = "198.51.103.1";
    const token = sessionToken("logout-429");
    let logoutCalls = 0;
    await withGoTrue(
      (_request, url) => {
        if (url.pathname === "/auth/v1/user") return healthyUser();
        if (url.pathname === "/auth/v1/logout") {
          logoutCalls += 1;
          return goTrueJson(
            429,
            { code: 429, error_code: "over_request_rate_limit", msg: "slow down" },
            {
              "Retry-After": "3",
            },
          );
        }
        return null;
      },
      async () => {
        const me = await h.handler(userRequest("GET", "/v1/me", { ip, token }));
        await me.body?.cancel();
        assertEquals(me.status, 200, "precondition: the session authenticates");

        const logout = await h.handler(userRequest("POST", "/v1/auth/logout", { ip, token }));
        const body = await logout.text();
        assertEquals(logoutCalls, 1);
        assert(
          logout.status === 503 || logout.status === 429,
          `GoTrue did not revoke the device session (429); the edge must answer retryable, got ${logout.status} ${body}`,
        );

        // Nothing was revoked upstream, so the bearer must still authenticate.
        const after = await h.handler(userRequest("GET", "/v1/me", { ip, token }));
        await after.body?.cancel();
        assertEquals(
          after.status,
          200,
          "the bearer was fenced locally although GoTrue never revoked the session",
        );
      },
    );
  },
);
