// Adjudication reproductions for area xc-ci-release-static (commit 4d812e1a).
//
// Each test asserts the EXPECTED contract (AGENTS.md "Auth sessions": the ONE
// implicit sign-out is the server refusing the refresh token; anything
// transient must stay retryable for the app). A failing test here is a
// reproduced defect, not a harness problem — the observed status is printed
// beside the expectation so the log doubles as evidence.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json adjudicate_xc_ci_release_static.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  loadHarness,
  SUPABASE_URL,
  TEST_USER_ID,
  WEBHOOK_SECRET,
} from "./routesHarness.ts";

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

const authUserFault =
  (respond: () => Promise<Response> | Response): Fault => (request) => {
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      return respond();
    }
    return null;
  };

const refreshFault =
  (respond: () => Promise<Response> | Response): Fault => (request) => {
    if (
      request.url.includes("/auth/v1/token") &&
      request.url.includes("grant_type=refresh_token")
    ) {
      return respond();
    }
    return null;
  };

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

const isTransientStatus = (status: number) =>
  status === 503 || status === 502 || status === 429;

// ── AUTH-OUTAGE-1: authenticate() maps a transient Supabase Auth failure to 401.
for (
  const [label, respond] of [
    [
      "auth.getUser → HTTP 503",
      () => jsonResponse(503, { message: "upstream unavailable" }),
    ],
    [
      "auth.getUser → HTTP 502 html",
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    ],
    [
      "auth.getUser → HTTP 429",
      () =>
        jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" }),
    ],
    [
      "auth.getUser → network error (fetch rejects)",
      () => Promise.reject(new TypeError("connection reset")),
    ],
  ] as Array<[string, () => Promise<Response> | Response]>
) {
  Deno.test(`AUTH-OUTAGE-1 authenticated route stays retryable when ${label}`, async () => {
    const h = await loadHarness();
    const ip = `10.1.${Math.floor(Math.random() * 250)}.${
      Math.floor(Math.random() * 250)
    }`;
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, crypto.randomUUID());
    const observed = await withFault(
      authUserFault(respond),
      () => statusOf(h.handler, { method: "GET", path: "/v1/me", ip, bearer }),
    );
    console.log(
      `  [AUTH-OUTAGE-1] ${label}: observed ${observed.status} ${observed.body}`,
    );
    assert(
      isTransientStatus(observed.status),
      `expected 503/429 (retryable) for a transient Auth failure, observed ${observed.status}: ${observed.body}`,
    );
  });
}

// ── AUTH-OUTAGE-2: /v1/auth/refresh maps a non-5xx transient failure to 401,
// which the app treats as "server refused the refresh token" → sign-out.
for (
  const [label, respond] of [
    [
      "refreshSession → HTTP 429",
      () =>
        jsonResponse(429, { message: "rate limited" }, { "Retry-After": "5" }),
    ],
    [
      "refreshSession → HTTP 200 non-JSON body",
      () =>
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    ],
    [
      "refreshSession → HTTP 200 JSON without session",
      () => jsonResponse(200, { ok: true }),
    ],
  ] as Array<[string, () => Promise<Response> | Response]>
) {
  Deno.test(`AUTH-OUTAGE-2 /v1/auth/refresh does not answer 401 when ${label}`, async () => {
    const h = await loadHarness();
    const ip = `10.2.${Math.floor(Math.random() * 250)}.${
      Math.floor(Math.random() * 250)
    }`;
    const observed = await withFault(
      refreshFault(respond),
      () =>
        statusOf(h.handler, {
          method: "POST",
          path: "/v1/auth/refresh",
          ip,
          body: { refreshToken: "rt-live-device" },
        }),
    );
    console.log(
      `  [AUTH-OUTAGE-2] ${label}: observed ${observed.status} ${observed.body}`,
    );
    assert(
      observed.status !== 401,
      `refresh must not tell the app to sign out on a transient failure; observed 401: ${observed.body}`,
    );
  });
}

Deno.test("AUTH-OUTAGE-2b /v1/auth/refresh with Auth network error: status + wall time", async () => {
  const h = await loadHarness();
  const ip = "10.2.250.1";
  const startedAt = performance.now();
  const observed = await withFault(
    refreshFault(() => Promise.reject(new TypeError("connection reset"))),
    () =>
      statusOf(h.handler, {
        method: "POST",
        path: "/v1/auth/refresh",
        ip,
        body: { refreshToken: "rt-live-device" },
      }),
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  console.log(
    `  [AUTH-OUTAGE-2b] network error: observed ${observed.status} after ${elapsedMs}ms ${observed.body}`,
  );
  assert(
    observed.status !== 401,
    `refresh must not tell the app to sign out on a network error; observed 401 after ${elapsedMs}ms`,
  );
});

// ── AUTH-OUTAGE-3: outage-induced 401s are charged to the per-IP auth-failure
// budget (30 / 5 min), so a NAT'd office/carrier IP is locked out (429) once
// Auth recovers.
Deno.test("AUTH-OUTAGE-3 Auth outage must not trip the per-IP auth-failure lockout", async () => {
  const h = await loadHarness();
  const ip = "10.3.0.7";
  let outage401 = 0;
  await withFault(
    authUserFault(() => jsonResponse(503, { message: "down" })),
    async () => {
      for (let i = 0; i < 31; i++) {
        const r = await statusOf(h.handler, {
          method: "GET",
          path: "/v1/me",
          ip,
          bearer: fakeSupabaseAccessToken(TEST_USER_ID, `outage-${i}`),
        });
        if (r.status === 401) outage401 += 1;
      }
    },
  );
  // Auth recovered: a perfectly valid bearer from the same IP.
  h.tables.profiles = [
    {
      id: TEST_USER_ID,
      email: "user@example.com",
      onboarding_state: "complete",
      provider: "apple",
      skill_level: null,
      handedness: null,
      primary_goal: null,
      biggest_problem: null,
      focus_checkpoint: null,
      first_name: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ];
  const recovered = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () =>
      statusOf(h.handler, {
        method: "GET",
        path: "/v1/me",
        ip,
        bearer: fakeSupabaseAccessToken(TEST_USER_ID, "recovered"),
      }),
  );
  // Control: the same valid bearer from an IP that saw no outage is served.
  const control = await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    () =>
      statusOf(h.handler, {
        method: "GET",
        path: "/v1/me",
        ip: "10.3.0.8",
        bearer: fakeSupabaseAccessToken(TEST_USER_ID, "control"),
      }),
  );
  console.log(
    `  [AUTH-OUTAGE-3] ${outage401}/31 outage responses were 401; after recovery observed ${recovered.status} ${recovered.body}; control IP observed ${control.status}`,
  );
  assertEquals(control.status, 200, `control request failed: ${control.body}`);
  assert(
    recovered.status !== 429,
    `valid bearer after Auth recovery must not be rate-limited; observed 429: ${recovered.body}`,
  );
});

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

// ── WEBHOOK-1: RevenueCat webhook acknowledges 200 although the entitlement
// row could not be persisted (transient PostgREST 5xx) — RevenueCat will not
// retry, so a verified entitlement change is dropped.
Deno.test("WEBHOOK-1 revenuecat webhook must not ack 200 when the verdict persist fails transiently", async () => {
  const h = await loadHarness();
  h.subscriber = {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: new Date(Date.now() + 86_400_000).toISOString(),
        product_identifier: "pickle_sensei_pro_monthly",
      },
    },
  };
  const observed = await withFault(
    (request) => {
      if (
        request.url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`)
      ) {
        return jsonResponse(503, {
          code: "PGRST001",
          message: "could not connect to database",
        });
      }
      return null;
    },
    async () => {
      const response = await h.handler(
        new Request("http://edge.test/webhooks/revenuecat", {
          method: "POST",
          headers: {
            Authorization: WEBHOOK_SECRET,
            "content-type": "application/json",
            "x-forwarded-for": "10.5.0.1",
          },
          body: JSON.stringify({
            event: {
              id: crypto.randomUUID(),
              type: "INITIAL_PURCHASE",
              app_user_id: TEST_USER_ID,
            },
          }),
        }),
      );
      return { status: response.status, body: await response.text() };
    },
  );
  console.log(`  [WEBHOOK-1] observed ${observed.status} ${observed.body}`);
  assert(
    observed.status >= 500,
    `webhook must fail (5xx) so RevenueCat retries when persistence fails; observed ${observed.status}: ${observed.body}`,
  );
});

// ── ROUTES-1: endpoints the mobile training client can call. Both are only
// reachable behind an ACTIVE training plan, which the server never issues
// (GET /v1/training-plans/current → plan:null, POST → 409) — recorded for the
// architecture-map adjudication, expectation is documentary (404 today).
Deno.test("ROUTES-1 mobile training endpoints not served by the edge fn (documentary)", async () => {
  const h = await loadHarness();
  const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "routes");
  const results: Record<string, number> = {};
  await withFault(
    authUserFault(() => jsonResponse(200, healthyUser())),
    async () => {
      for (
        const [method, path] of [
          ["POST", "/v1/drill-completions"],
          [
            "POST",
            "/v1/training-plans/00000000-0000-4000-8000-000000000000/reassessment",
          ],
          ["GET", "/v1/training-plans/current"],
          ["POST", "/v1/training-plans"],
        ]
      ) {
        const r = await statusOf(h.handler, {
          method,
          path,
          ip: "10.6.0.1",
          bearer,
          body: method === "GET" ? undefined : {},
        });
        results[`${method} ${path}`] = r.status;
      }
    },
  );
  console.log(`  [ROUTES-1] ${JSON.stringify(results)}`);
  assertEquals(results["GET /v1/training-plans/current"], 200);
  assertEquals(results["POST /v1/training-plans"], 409);
  assertEquals(results["POST /v1/drill-completions"], 404);
  assertEquals(
    results[
      "POST /v1/training-plans/00000000-0000-4000-8000-000000000000/reassessment"
    ],
    404,
  );
});

// ─── COPY-1: public legal text must obey the store-copy hard rules ────────────
// docs/APP_STORE_SUBMISSION.md §0 rule 4: never mention Android, Google Play,
// "guest mode", "Live Court", DUPR or competitor apps. /privacy and /terms are
// the URLs entered in App Store Connect, so their text is store-facing copy.
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";

const FORBIDDEN_COPY =
  /\b(android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola)\b/gi;

Deno.test("COPY-1 /privacy, /terms and /support text contain no forbidden store-copy terms", () => {
  const hits: string[] = [];
  for (
    const [name, text] of Object.entries({
      PRIVACY_POLICY_TEXT,
      TERMS_TEXT,
      SUPPORT_TEXT,
    })
  ) {
    for (const match of text.matchAll(FORBIDDEN_COPY)) {
      const line = text.slice(0, match.index).split("\n").length;
      hits.push(`${name}:${line} "${match[0]}"`);
    }
  }
  console.log(
    `  [COPY-1] forbidden-term hits: ${hits.length ? hits.join(", ") : "none"}`,
  );
  assertEquals(
    hits,
    [],
    `forbidden terms in public legal copy: ${hits.join("; ")}`,
  );
});
