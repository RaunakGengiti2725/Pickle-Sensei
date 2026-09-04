// Black-box harness for the edge function: imports ../index.ts with Deno.serve
// captured (so no port is opened), Supabase (PostgREST + Auth) and RevenueCat
// stubbed at the fetch layer, and env populated. Every request goes through
// the REAL handler (auth → rate limits → routing → billing/webhook/drills).
//
// Bearer contract mirrored by the fake Auth: a provider ID token is spent
// ONCE by `POST /v1/account/bootstrap` (fake `/auth/v1/token` mints a
// Supabase-shaped session), and every other route bears the session ACCESS
// token that bootstrap returned (fake `/auth/v1/user` verifies it, fake
// `/auth/v1/logout` revokes it). `loadHarness()` performs that bootstrap once
// for TEST_USER_ID, and `userRequest()` bears its access token by default.

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  realFetch: typeof fetch;
  realServe: typeof Deno.serve;
  calls: RecordedCall[];
  /** Subscriber JSON RevenueCat returns (null → HTTP 500 from RevenueCat). */
  subscriber: Record<string, unknown> | null;
  /** Rows returned for PostgREST GET by table name. */
  tables: Record<string, unknown[]>;
  /** Rows returned for PostgREST RPC POST by function name. */
  rpcs: Record<string, unknown>;
  /** Test-only copy of the generated AES key used by the lazy edge config. */
  appleTokenEncryptionKey: string;
  /** Session access token bootstrap issued for TEST_USER_ID at harness load
   * (what `userRequest()` bears by default). */
  accessToken: string;
  /** Access tokens the fake Supabase Auth currently considers live. Survives
   * `reset()` because the default session is minted once per harness load. */
  sessions: Map<string, FakeAuthUser>;
  reset(): void;
  callsTo(fragment: string): RecordedCall[];
}

export interface FakeAuthUser {
  id: string;
  email: string;
  provider: "google" | "apple";
}

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
export const WEBHOOK_SECRET = "wf-test-webhook-secret";
export const SUPABASE_URL = "http://supabase.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A syntactically valid Google ID token (issuer routing only — verification
 * is stubbed in the fake Supabase Auth). Only `POST /v1/account/bootstrap`
 * accepts it; use `bootstrapAccessToken()` for every other route. */
export function fakeGoogleIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function fakeAppleIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://appleid.apple.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function testApplePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    bytesToBase64(pkcs8)
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

let harness: Harness | null = null;

/** Spend `idToken` on `POST /v1/account/bootstrap` through the real handler
 * and return the session access token it issued — the bearer every other
 * route expects. Bootstrap reads the profile row, so one is provided for the
 * duration of the call when the test has not staged its own. */
export async function bootstrapAccessToken(
  h: Harness,
  options: { sub?: string; provider?: "google" | "apple"; ip?: string } = {},
): Promise<string> {
  const sub = options.sub ?? TEST_USER_ID;
  const provider = options.provider ?? "google";
  const idToken = provider === "apple" ? fakeAppleIdToken(sub) : fakeGoogleIdToken(sub);
  const stagedProfiles = h.tables.profiles;
  if (!stagedProfiles || stagedProfiles.length === 0) {
    h.tables.profiles = [
      { id: sub, email: "user@example.com", provider, onboarding_state: "complete" },
    ];
  }
  const callsBefore = h.calls.length;
  try {
    const response = await h.handler(
      userRequest("POST", "/v1/account/bootstrap", {
        token: idToken,
        ip: options.ip ?? "203.0.113.250",
        body: {},
      }),
    );
    if (response.status !== 200) {
      throw new Error(`harness bootstrap failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as { session?: { accessToken?: unknown } };
    const accessToken = body.session?.accessToken;
    if (typeof accessToken !== "string" || !accessToken) {
      throw new Error("harness bootstrap returned no session access token");
    }
    return accessToken;
  } finally {
    if (!stagedProfiles || stagedProfiles.length === 0) {
      if (stagedProfiles) h.tables.profiles = stagedProfiles;
      else delete h.tables.profiles;
    }
    h.calls.splice(callsBefore);
  }
}

export async function loadHarness(): Promise<Harness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-test-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_revenuecat");
  const appleTokenEncryptionKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;
  const state: Harness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    realFetch,
    realServe,
    calls: [],
    subscriber: {},
    tables: {},
    rpcs: {},
    appleTokenEncryptionKey,
    accessToken: "",
    sessions: new Map(),
    reset() {
      state.calls = [];
      state.subscriber = {};
      state.tables = {};
      state.rpcs = {};
    },
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    state.calls.push({ url, method: request.method, headers, body });

    if (url.startsWith(RC_URL)) {
      if (!state.subscriber) {
        return new Response("upstream error", { status: 500 });
      }
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: state.subscriber,
      });
    }
    if (url === "https://appleid.apple.com/auth/token") {
      return jsonResponse(200, {
        refresh_token: "apple-refresh-token-from-grant",
        id_token: fakeAppleIdToken(),
      });
    }
    if (url === "https://appleid.apple.com/auth/revoke") {
      return new Response(null, { status: 200 });
    }
    const authUserJson = (user: FakeAuthUser) => ({
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: new Date().toISOString(),
    });
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      const grant = new URL(url).searchParams.get("grant_type");
      const payload = isRecord(body) ? body : {};
      let user: FakeAuthUser | null = null;
      if (grant === "id_token") {
        const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
        const claims = decodeJwtPayload(idToken);
        const provider = payload.provider === "apple" ? "apple" : "google";
        if (typeof claims?.sub === "string" && claims.sub) {
          user = { id: claims.sub, email: "user@example.com", provider };
        }
      } else if (grant === "refresh_token") {
        const refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : "";
        for (const [accessToken, live] of state.sessions) {
          if (refreshToken === `refresh-for-${accessToken}`) {
            user = live;
            state.sessions.delete(accessToken);
            break;
          }
        }
      }
      if (!user) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "fake auth: token not recognised",
        });
      }
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      const accessToken = [
        b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
        b64url(
          JSON.stringify({
            iss: `${SUPABASE_URL}/auth/v1`,
            sub: user.id,
            aud: "authenticated",
            role: "authenticated",
            exp: expiresAt,
            jti: crypto.randomUUID(),
          }),
        ),
        "sig",
      ].join(".");
      state.sessions.set(accessToken, user);
      return jsonResponse(200, {
        access_token: accessToken,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `refresh-for-${accessToken}`,
        user: authUserJson(user),
      });
    }
    if (url === `${SUPABASE_URL}/auth/v1/user` && request.method === "GET") {
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer /, "");
      const user = state.sessions.get(bearer);
      if (!user) {
        return jsonResponse(401, { code: 401, msg: "invalid JWT: session not found" });
      }
      return jsonResponse(200, authUserJson(user));
    }
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/logout`) && request.method === "POST") {
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer /, "");
      if (!state.sessions.delete(bearer)) {
        return jsonResponse(401, { code: 401, msg: "invalid JWT: session not found" });
      }
      return new Response(null, { status: 204 });
    }
    if (request.method === "DELETE" && url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
      return jsonResponse(200, {});
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = new URL(url).pathname.slice("/rest/v1/".length);
      if (table.startsWith("rpc/")) {
        const fn = table.slice("rpc/".length);
        if (!(fn in state.rpcs)) {
          return jsonResponse(404, {
            code: "PGRST202",
            message: `rpc ${fn} not stubbed`,
          });
        }
        return jsonResponse(200, state.rpcs[fn]);
      }
      if (request.method === "GET") {
        const rows = state.tables[table] ?? [];
        const accept = headers["accept"] ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) {
            return new Response(
              JSON.stringify({
                code: "PGRST116",
                message: "0 rows",
                details: null,
                hint: null,
              }),
              {
                status: 406,
                headers: { "Content-Type": "application/json" },
              },
            );
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST" || request.method === "PATCH") {
        return new Response(null, { status: 201 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`unexpected fetch in test: ${request.method} ${url}`, { status: 599 });
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  state.accessToken = await bootstrapAccessToken(state);
  state.reset();
  harness = state;
  return state;
}

export function webhookRequest(
  event: Record<string, unknown> | null,
  options: { authorization?: string | null; ip?: string; rawBody?: string } = {},
): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  const authorization =
    options.authorization === undefined ? WEBHOOK_SECRET : options.authorization;
  if (authorization !== null) headers.set("Authorization", authorization);
  headers.set("x-forwarded-for", options.ip ?? "203.0.113.10");
  return new Request("http://edge.test/functions/v1/api/webhooks/revenuecat", {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(event ? { api_version: "1.0", event } : {}),
  });
}

export function userRequest(
  method: string,
  path: string,
  options: {
    token?: string;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const token = options.token ?? harness?.accessToken;
  if (!token) {
    throw new Error("userRequest(): call loadHarness() first or pass an explicit token");
  }
  const headers = new Headers({
    Authorization: `Bearer ${token}`,
    "x-forwarded-for": options.ip ?? "203.0.113.20",
    ...options.headers,
  });
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`http://edge.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function activeSubscriber(
  expiresDate: string | null = new Date(Date.now() + 86_400_000).toISOString(),
  productId = "pickle_sensei_pro_monthly",
): Record<string, unknown> {
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: expiresDate,
        product_identifier: productId,
      },
    },
  };
}
