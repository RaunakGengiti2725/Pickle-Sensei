// STRUCTURAL AUDIT #1 (edge-auth-cache-ratelimit) — handler-level probes for
// /v1/auth/refresh, /v1/auth/logout and authenticate() upstream-failure
// mapping. Boots the REAL index.ts (Deno.serve captured, fetch stubbed) so
// every request runs auth → rate limits → routing exactly as in production.
//
// Every test asserts the behaviour the auth-session contract in AGENTS.md
// implies ("closing the app must NEVER sign out"; 5xx = retryable). Tests
// whose name starts with `[defect]` FAIL on 4d812e1a — they are the
// reproductions for the audit findings. Untagged tests pass and pin
// behaviour that the audit verified holds.
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s1_auth_refresh_logout_test.ts)

import { assert, assertEquals } from "@std/assert";

const SUPABASE_URL = "http://supabase.audit.test";
const IP_A = "198.51.100.10";

Deno.env.set("SUPABASE_URL", SUPABASE_URL);
Deno.env.set("SUPABASE_ANON_KEY", "anon-audit-key");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-audit-key");
Deno.env.delete("SB_PUBLISHABLE_KEY");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

// ─── Fake GoTrue / PostgREST at the fetch layer ──────────────────────────────

interface Upstream {
  /** POST /auth/v1/token?grant_type=refresh_token */
  refresh: { status: number; body?: unknown; throwError?: boolean };
  /** GET /auth/v1/user */
  getUser: { status: number; body?: unknown };
  /** POST /auth/v1/logout */
  logout: { status: number; throwError?: boolean };
  calls: Array<{ method: string; url: string; authorization: string | null }>;
}

const upstream: Upstream = {
  refresh: { status: 200 },
  getUser: { status: 200 },
  logout: { status: 204 },
  calls: [],
};

function resetUpstream(): void {
  upstream.refresh = { status: 200 };
  upstream.getUser = { status: 200 };
  upstream.logout = { status: 204 };
  upstream.calls = [];
}

const callsTo = (fragment: string) =>
  upstream.calls.filter((c) => c.url.includes(fragment));

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const nowSeconds = () => Math.floor(Date.now() / 1_000);

function jwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.sig`;
}

/** A Supabase-issued access token (iss ends with /auth/v1), as bootstrap or
 * refresh would hand the app. Verification happens in (fake) GoTrue. */
function supabaseAccessToken(userId: string, expInSeconds = 3_600): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub: userId,
    aud: "authenticated",
    role: "authenticated",
    exp: nowSeconds() + expInSeconds,
  });
}

function googleIdToken(sub: string, expInSeconds = 3_600): string {
  return jwt({
    iss: "https://accounts.google.com",
    sub,
    exp: nowSeconds() + expInSeconds,
  });
}

function gotrueUser(id: string) {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: "user@example.com",
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

function gotrueSession(id: string) {
  const exp = nowSeconds() + 3_600;
  return {
    access_token: supabaseAccessToken(id),
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: exp,
    refresh_token: `rotated-refresh-${crypto.randomUUID()}`,
    user: gotrueUser(id),
  };
}

const realFetch = globalThis.fetch;
globalThis.fetch =
  (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    upstream.calls.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.get("authorization"),
    });
    if (!request.url.startsWith(SUPABASE_URL)) {
      return new Response(
        `unexpected fetch in audit test: ${request.method} ${request.url}`,
        {
          status: 599,
        },
      );
    }

    if (url.pathname === "/auth/v1/token") {
      const grant = url.searchParams.get("grant_type");
      if (grant === "refresh_token") {
        const spec = upstream.refresh;
        if (spec.throwError) {
          throw new TypeError("error sending request: connection refused");
        }
        if (spec.status === 200) {
          return jsonResponse(200, gotrueSession(crypto.randomUUID()));
        }
        return jsonResponse(
          spec.status,
          spec.body ??
            {
              code: spec.status,
              error_code: "unexpected_failure",
              msg: "upstream",
            },
        );
      }
      if (grant === "id_token") {
        const body = (await request.json().catch(() => ({}))) as {
          id_token?: string;
        };
        const segment = (body.id_token ?? "").split(".")[1] ?? "";
        let sub = "unknown";
        try {
          const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
          sub = String(
            JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).sub,
          );
        } catch {
          // keep default
        }
        return jsonResponse(200, gotrueSession(sub));
      }
    }
    if (url.pathname === "/auth/v1/user" && request.method === "GET") {
      const spec = upstream.getUser;
      if (spec.status === 200) {
        const token = (request.headers.get("authorization") ?? "").slice(
          "Bearer ".length,
        );
        const segment = token.split(".")[1] ?? "";
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const sub = String(
          JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).sub,
        );
        return jsonResponse(200, gotrueUser(sub));
      }
      return jsonResponse(
        spec.status,
        spec.body ??
          {
            code: spec.status,
            error_code: "unexpected_failure",
            msg: "upstream",
          },
      );
    }
    if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
      const spec = upstream.logout;
      if (spec.throwError) {
        throw new TypeError("error sending request: connection reset");
      }
      return new Response(null, { status: spec.status });
    }
    if (url.pathname === "/rest/v1/rpc/access_state") {
      return jsonResponse(200, [{
        premium: false,
        scored_count: 0,
        reserved_count: 0,
      }]);
    }
    if (url.pathname.startsWith("/rest/v1/profiles")) {
      const token = (request.headers.get("authorization") ?? "").slice(
        "Bearer ".length,
      );
      const segment = token.split(".")[1] ?? "";
      const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
      const sub = String(
        JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4))).sub,
      );
      const row = {
        id: sub,
        email: "user@example.com",
        onboarding_state: "complete",
        provider: "google",
        skill_level: "beginner",
        handedness: "right",
        primary_goal: null,
        biggest_problem: null,
        focus_checkpoint: null,
        first_name: null,
        gender: null,
      };
      const single = (request.headers.get("accept") ?? "").includes(
        "vnd.pgrst.object",
      );
      if (request.method === "GET") {
        return jsonResponse(200, single ? row : [row]);
      }
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, {
      message: `audit fake: unhandled ${request.method} ${url.pathname}`,
    });
  }) as typeof fetch;

// ─── Boot index.ts with Deno.serve captured ──────────────────────────────────

type Handler = (request: Request) => Promise<Response> | Response;
let captured: Handler | null = null;
const realServe = Deno.serve;
(Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
  captured = (typeof args[0] === "function" ? args[0] : args[1]) as Handler;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
await import("../index.ts");
(Deno as unknown as { serve: unknown }).serve = realServe;
if (!captured) {
  throw new Error("index.ts did not register a Deno.serve handler");
}
const api: Handler = captured;

interface CallOptions {
  token?: string | null;
  ip?: string | null;
  body?: unknown;
  rawBody?: BodyInit;
}

function call(
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  if (options.ip !== null) headers.set("x-forwarded-for", options.ip ?? IP_A);
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return Promise.resolve(
    api(
      new Request(`http://edge.audit.test/functions/v1/api${path}`, {
        method,
        headers,
        body: options.rawBody ??
          (options.body === undefined
            ? undefined
            : JSON.stringify(options.body)),
        ...(options.rawBody instanceof ReadableStream
          ? ({ duplex: "half" } as unknown as RequestInit)
          : {}),
      }),
    ),
  );
}

const freshIp = (() => {
  let n = 0;
  return () => {
    n += 1;
    return `203.0.113.${n}`;
  };
})();

const quiet = { sanitizeOps: false, sanitizeResources: false };

// ─── /v1/auth/refresh ────────────────────────────────────────────────────────

Deno.test({
  name:
    "refresh: missing refreshToken → 400 validation.refresh (no GoTrue call)",
  ...quiet,
  async fn() {
    resetUpstream();
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: {},
    });
    assertEquals(res.status, 400);
    assertEquals(
      ((await res.json()) as { error: { code: string } }).error.code,
      "validation.refresh",
    );
    assertEquals(callsTo("grant_type=refresh_token").length, 0);
  },
});

Deno.test({
  name: "refresh: GoTrue accepts → 200 { session } with rotated tokens",
  ...quiet,
  async fn() {
    resetUpstream();
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: { refreshToken: "live-refresh" },
    });
    assertEquals(res.status, 200);
    const body = (await res.json()) as {
      session: { accessToken: string; refreshToken: string; expiresAt: number };
    };
    assert(body.session.accessToken.length > 0);
    assert(body.session.refreshToken.startsWith("rotated-refresh-"));
    assert(body.session.expiresAt > nowSeconds());
  },
});

Deno.test({
  name:
    "refresh: GoTrue 400 refresh_token_not_found (revoked/rotated away) → 401",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.refresh = {
      status: 400,
      body: {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token",
      },
    };
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: { refreshToken: "dead-refresh" },
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
  },
});

Deno.test({
  name:
    "[defect] refresh: GoTrue 429 (over_request_rate_limit) is returned as 401 — the app treats 401 as 'session revoked' and signs the user out",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.refresh = {
      status: 429,
      body: {
        code: 429,
        error_code: "over_request_rate_limit",
        msg: "Request rate limit reached",
      },
    };
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: { refreshToken: "live-refresh" },
    });
    await res.body?.cancel();
    // apps/mobile/src/account/sessionLifecycle.ts:89-91 — 401/403 ⇒
    // SessionRefreshError(retryable=false) ⇒ authStore signs the user out.
    // A GoTrue throttle is transient; it must surface as 429 or 503 so the
    // app keeps the session and retries with backoff.
    assert(
      res.status === 429 || res.status === 503,
      `transient GoTrue 429 must not be a 401 sign-out signal (got ${res.status})`,
    );
  },
});

Deno.test({
  name:
    "[defect] refresh: GoTrue 401 (e.g. misconfigured apikey) is returned as 401 → every device signs out",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.refresh = {
      status: 401,
      body: {
        code: 401,
        error_code: "invalid_api_key",
        msg: "Invalid API key",
      },
    };
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: { refreshToken: "live-refresh" },
    });
    await res.body?.cancel();
    assert(
      res.status !== 401,
      `an upstream configuration failure must not be reported as a revoked session (got ${res.status})`,
    );
  },
});

Deno.test({
  name:
    "[defect] refresh: 30 transient GoTrue 429s from one NAT egress lock that IP out of bootstrap for 5 minutes",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    upstream.refresh = {
      status: 429,
      body: {
        code: 429,
        error_code: "over_request_rate_limit",
        msg: "Request rate limit reached",
      },
    };
    for (let i = 0; i < 30; i += 1) {
      const res = await call("POST", "/v1/auth/refresh", {
        token: null,
        ip,
        body: { refreshToken: `live-refresh-${i}` },
      });
      await res.body?.cancel();
    }
    // GoTrue recovers; a NEW user behind the same egress signs in.
    upstream.refresh = { status: 200 };
    const bootstrap = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip,
      body: {},
    });
    await bootstrap.body?.cancel();
    assertEquals(
      bootstrap.status,
      200,
      "transient upstream throttling of refresh must not charge the per-IP auth-failure budget",
    );
  },
});

Deno.test({
  name:
    "[defect] refresh: GoTrue 503 → auth-js retries ~25 s before the edge answers 503 (mobile aborts at 15 s)",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.refresh = {
      status: 503,
      body: { code: 503, msg: "service unavailable" },
    };
    const t0 = performance.now();
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      body: { refreshToken: "live-refresh" },
    });
    const elapsedMs = performance.now() - t0;
    await res.body?.cancel();
    const attempts = callsTo("grant_type=refresh_token").length;
    console.log(
      `[audit] refresh under GoTrue 503: status=${res.status} attempts=${attempts} elapsedMs=${
        elapsedMs.toFixed(0)
      }`,
    );
    assertEquals(res.status, 503);
    // sessionLifecycle.ts REQUEST_TIMEOUT_MS = 15_000: the device has given
    // up (and will retry, re-entering the same ~25 s loop) long before this
    // response exists. The edge must answer within the client's timeout.
    assert(
      elapsedMs < 15_000,
      `edge took ${
        elapsedMs.toFixed(0)
      } ms (${attempts} upstream attempts) to report a 5xx`,
    );
  },
});

// ─── /v1/auth/logout ─────────────────────────────────────────────────────────

Deno.test({
  name:
    "logout: GoTrue 204 → 204 and the bearer is dropped from the auth cache",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    const token = supabaseAccessToken(crypto.randomUUID());
    const first = await call("GET", "/v1/me/access", { token, ip });
    assertEquals(first.status, 200);
    await first.body?.cancel();
    assertEquals(callsTo("/auth/v1/user").length, 1);
    const second = await call("GET", "/v1/me/access", { token, ip });
    await second.body?.cancel();
    assertEquals(
      callsTo("/auth/v1/user").length,
      1,
      "second call is served from the auth cache",
    );

    const out = await call("POST", "/v1/auth/logout", { token, ip });
    assertEquals(out.status, 204);
    const logoutCalls = callsTo("/auth/v1/logout");
    assertEquals(logoutCalls.length, 1);
    assert(logoutCalls[0].url.includes("scope=local"));
    assertEquals(logoutCalls[0].authorization, `Bearer ${token}`);

    // GoTrue now refuses the bearer; the cache must not resurrect it.
    upstream.getUser = {
      status: 403,
      body: { code: 403, error_code: "session_not_found", msg: "" },
    };
    const after = await call("GET", "/v1/me/access", { token, ip });
    await after.body?.cancel();
    assertEquals(after.status, 401);
    assertEquals(
      callsTo("/auth/v1/user").length,
      2,
      "bearer was re-verified with GoTrue",
    );
  },
});

Deno.test({
  name: "logout: GoTrue 401/403/404 (already signed out) → 204",
  ...quiet,
  async fn() {
    for (const status of [401, 403, 404]) {
      resetUpstream();
      upstream.logout = { status };
      const res = await call("POST", "/v1/auth/logout", {
        token: supabaseAccessToken(crypto.randomUUID()),
        ip: freshIp(),
      });
      assertEquals(res.status, 204, `GoTrue ${status}`);
    }
  },
});

Deno.test({
  name: "logout: GoTrue 5xx → generic 503 (no upstream detail in the body)",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.logout = { status: 502 };
    const res = await call("POST", "/v1/auth/logout", {
      token: supabaseAccessToken(crypto.randomUUID()),
      ip: freshIp(),
    });
    assertEquals(res.status, 503);
    const body = (await res.json()) as { error: { message: string } };
    assert(!body.error.message.includes("502"));
  },
});

Deno.test({
  name:
    "[defect] logout: a thrown fetch (network failure to GoTrue) escapes logoutRoute → outer 500 'unhandled error'",
  ...quiet,
  async fn() {
    resetUpstream();
    upstream.logout = { status: 204, throwError: true };
    const res = await call("POST", "/v1/auth/logout", {
      token: supabaseAccessToken(crypto.randomUUID()),
      ip: freshIp(),
    });
    const body = (await res.json().catch(() => null)) as {
      error?: { message?: string };
    } | null;
    // A GoTrue network failure is the same class of failure as its 5xx and
    // must map to the retryable 503 branch, not to the catch-all 500 that
    // also logs `[api] unhandled error`.
    assertEquals(
      res.status,
      503,
      `expected the service-unavailable mapping, got ${res.status} ${
        JSON.stringify(body)
      }`,
    );
  },
});

Deno.test({
  name:
    "[defect] logout with an expired bearer is refused 401 before revocation AND charges the auth-failure budget",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    const expired = supabaseAccessToken(crypto.randomUUID(), -60);
    const res = await call("POST", "/v1/auth/logout", { token: expired, ip });
    await res.body?.cancel();
    const revoked = callsTo("/auth/v1/logout").length;
    // 29 more honest sign-outs from devices behind the same egress whose
    // bearer lapsed while suspended, then a new sign-in from that egress.
    for (let i = 0; i < 29; i += 1) {
      const again = await call("POST", "/v1/auth/logout", {
        token: supabaseAccessToken(crypto.randomUUID(), -60),
        ip,
      });
      await again.body?.cancel();
    }
    const bootstrap = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip,
      body: {},
    });
    await bootstrap.body?.cancel();
    console.log(
      `[audit] expired-bearer logout: status=${res.status} gotrueRevocations=${revoked} bootstrapAfter30=${bootstrap.status}`,
    );
    // Sign-out from a suspended app whose bearer lapsed: GoTrue is never told
    // to revoke the device's refresh token (the session stays alive
    // server-side until natural rotation), and the honest sign-out is
    // counted like a credential-stuffing attempt.
    assertEquals(
      res.status,
      204,
      "sign-out must be idempotent for an expired bearer",
    );
    assertEquals(
      revoked,
      1,
      "GoTrue scope=local revocation must still be attempted",
    );
    assertEquals(
      bootstrap.status,
      200,
      "honest sign-outs must not spend the auth-failure budget",
    );
  },
});

// ─── authenticate(): upstream failure mapping ────────────────────────────────

Deno.test({
  name:
    "[defect] authenticate: GoTrue getUser 503 → 401 'session no longer valid' and the IP is charged an auth failure",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    upstream.getUser = {
      status: 503,
      body: { code: 503, msg: "service unavailable" },
    };
    const res = await call("GET", "/v1/me/access", {
      token: supabaseAccessToken(crypto.randomUUID()),
      ip,
    });
    const body = (await res.json()) as { error: { message: string } };
    console.log(`[audit] getUser 503 → ${res.status} ${body.error.message}`);
    assert(
      res.status >= 500,
      `an Auth outage must be reported as retryable 5xx, not as an invalid session (got ${res.status})`,
    );
  },
});

Deno.test({
  name:
    "[defect] authenticate: 30 requests during a GoTrue outage lock the shared IP out of bootstrap for 5 minutes after recovery",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    upstream.getUser = {
      status: 503,
      body: { code: 503, msg: "service unavailable" },
    };
    for (let i = 0; i < 30; i += 1) {
      const res = await call("GET", "/v1/me/access", {
        token: supabaseAccessToken(crypto.randomUUID()),
        ip,
      });
      await res.body?.cancel();
      assertEquals(res.status, 401);
    }
    upstream.getUser = { status: 200 };
    const bootstrap = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip,
      body: {},
    });
    await bootstrap.body?.cancel();
    assertEquals(
      bootstrap.status,
      200,
      "an Auth outage must not consume the per-IP auth-failure budget (everyone behind a NAT is locked out)",
    );
  },
});

Deno.test({
  name:
    "authenticate: 40 CONCURRENT bad bearers from one IP are all counted (atomic INCR) → bootstrap from that IP is 429",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    const results = await Promise.all(
      Array.from(
        { length: 40 },
        (_, i) => call("GET", "/v1/me/access", { token: `bad-${i}`, ip }),
      ),
    );
    const statuses = results.map((r) => r.status);
    await Promise.all(results.map((r) => r.body?.cancel()));
    assertEquals(
      statuses.filter((s) => s === 401).length,
      40,
      "peek happens before any INCR lands, so all 40 see 401",
    );
    const bootstrap = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip,
      body: {},
    });
    await bootstrap.body?.cancel();
    assertEquals(
      bootstrap.status,
      429,
      "30+ failures were counted despite concurrency",
    );
    assert(Number(bootstrap.headers.get("retry-after")) >= 1);
    assertEquals(
      callsTo("/auth/v1/").length,
      0,
      "no GoTrue traffic for garbage bearers or the locked-out bootstrap",
    );
  },
});

Deno.test({
  name:
    "authenticate: expired Supabase access token → 401 before any GoTrue call",
  ...quiet,
  async fn() {
    resetUpstream();
    const res = await call("GET", "/v1/me/access", {
      token: supabaseAccessToken(crypto.randomUUID(), -1),
      ip: freshIp(),
    });
    assertEquals(res.status, 401);
    await res.body?.cancel();
    assertEquals(callsTo("/auth/v1/").length, 0);
  },
});

Deno.test({
  name:
    "authenticate: a Supabase token for a non-Google/Apple account → 401 and is not cached",
  ...quiet,
  async fn() {
    resetUpstream();
    const ip = freshIp();
    const token = supabaseAccessToken(crypto.randomUUID());
    upstream.getUser = {
      status: 200,
      body: null,
    };
    // Return a user whose provider is email — override the default responder.
    const original = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === "/auth/v1/user") {
        upstream.calls.push({
          method: "GET",
          url: request.url,
          authorization: null,
        });
        return Promise.resolve(jsonResponse(200, {
          ...gotrueUser(crypto.randomUUID()),
          app_metadata: { provider: "email", providers: ["email"] },
        }));
      }
      return original(input, init);
    }) as typeof fetch;
    try {
      const res = await call("GET", "/v1/me/access", { token, ip });
      assertEquals(res.status, 401);
      await res.body?.cancel();
      const again = await call("GET", "/v1/me/access", { token, ip });
      assertEquals(again.status, 401);
      await again.body?.cancel();
      assertEquals(
        callsTo("/auth/v1/user").length,
        2,
        "a refused user is never cached",
      );
    } finally {
      globalThis.fetch = original;
    }
  },
});

// ─── Body handling ───────────────────────────────────────────────────────────

Deno.test({
  name:
    "body: a request stream that errors mid-body → 400 validation (never 5xx, never a GoTrue call)",
  ...quiet,
  async fn() {
    resetUpstream();
    const encoder = new TextEncoder();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"refreshToken":"live-'));
        controller.error(new Error("client aborted"));
      },
    });
    const res = await call("POST", "/v1/auth/refresh", {
      token: null,
      ip: freshIp(),
      rawBody: broken,
    });
    assertEquals(res.status, 400);
    assertEquals(
      ((await res.json()) as { error: { code: string } }).error.code,
      "validation.refresh",
    );
    assertEquals(callsTo("grant_type=refresh_token").length, 0);
  },
});

Deno.test({
  name:
    "body: a non-object JSON body ({} after readBody) → 400 validation, not 5xx",
  ...quiet,
  async fn() {
    resetUpstream();
    for (const raw of ["[]", '"str"', "null", "42", "{not json"]) {
      const res = await call("POST", "/v1/auth/refresh", {
        token: null,
        ip: freshIp(),
        rawBody: raw,
      });
      assertEquals(res.status, 400, `body ${raw}`);
      await res.body?.cancel();
    }
    assertEquals(callsTo("grant_type=refresh_token").length, 0);
  },
});

// ─── Client-IP bucket when the gateway sends no address ──────────────────────

Deno.test({
  name:
    "[defect] no cf-connecting-ip / x-forwarded-for → every such client shares ONE 'unknown' auth-failure bucket",
  ...quiet,
  async fn() {
    resetUpstream();
    for (let i = 0; i < 30; i += 1) {
      const res = await call("GET", "/v1/me/access", {
        token: `garbage-${i}`,
        ip: null,
      });
      await res.body?.cancel();
      assertEquals(res.status, 401);
    }
    const victim = await call("POST", "/v1/account/bootstrap", {
      token: googleIdToken(crypto.randomUUID()),
      ip: null,
      body: {},
    });
    await victim.body?.cancel();
    // Fail-open (per-request) or a per-connection key would be safe here;
    // a single shared bucket lets one address-less client lock out all others.
    assertEquals(
      victim.status,
      200,
      "unrelated address-less client must not inherit the lockout",
    );
  },
});

Deno.test({
  name: "teardown",
  fn() {
    globalThis.fetch = realFetch;
  },
  ...quiet,
});
