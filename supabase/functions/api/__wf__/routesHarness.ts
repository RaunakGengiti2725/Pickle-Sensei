// Black-box harness for the edge function: imports ../index.ts with Deno.serve
// captured (so no port is opened), Supabase (PostgREST + Auth) and RevenueCat
// stubbed at the fetch layer, and env populated. Every request goes through
// the REAL handler (auth → rate limits → routing → billing/webhook/drills).

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A PostgREST error body (what supabase-js folds into `error.code` /
 * `error.message`). */
export interface PostgrestFailure {
  status: number;
  code: string;
  message: string;
}

/** Stateful billing tables. When installed (`h.useBillingStore()`), the
 * PostgREST stub PERSISTS `webhook_events` (id-keyed, ignore-duplicates) and
 * `billing_entitlements` (user_id-keyed) rows instead of answering a blind
 * 201, so idempotency / replay / partial-persistence behaviour is observable.
 * Every call is still recorded in `h.calls`. */
export interface BillingStore {
  webhookEvents: Map<string, Record<string, unknown>>;
  entitlements: Map<string, Record<string, unknown>>;
  /** Every billing_entitlements upsert payload, in order (failed ones too). */
  entitlementUpserts: Record<string, unknown>[];
  /** Consulted before the Nth (0-based) billing_entitlements upsert; a
   * returned failure is answered instead of persisting the row. */
  failEntitlementUpsert: (n: number, row: Record<string, unknown>) => PostgrestFailure | null;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  realFetch: typeof fetch;
  realServe: typeof Deno.serve;
  calls: RecordedCall[];
  /** Subscriber JSON RevenueCat returns (null → HTTP 500 from RevenueCat). */
  subscriber: Record<string, unknown> | null;
  /** When set, RevenueCat answers this HTTP status with its documented
   * `{code: 7225, message: "Invalid API key."}` error body. */
  rcStatus: number | null;
  /** When set, the RevenueCat fetch rejects with this error (network failure
   * / AbortSignal timeout). */
  rcError: Error | null;
  /** Rows returned for PostgREST GET by table name. */
  tables: Record<string, unknown[]>;
  /** Rows returned for PostgREST RPC POST by function name. */
  rpcs: Record<string, unknown>;
  /** Stateful webhook_events / billing_entitlements (null → stateless 201). */
  billing: BillingStore | null;
  /** Test-only copy of the generated AES key used by the lazy edge config. */
  appleTokenEncryptionKey: string;
  reset(): void;
  callsTo(fragment: string): RecordedCall[];
  useBillingStore(): BillingStore;
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

/** A syntactically valid Google ID token (issuer routing only — verification
 * is stubbed in the fake Supabase Auth). */
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
    rcStatus: null,
    rcError: null,
    tables: {},
    rpcs: {},
    billing: null,
    appleTokenEncryptionKey,
    reset() {
      state.calls = [];
      state.subscriber = {};
      state.rcStatus = null;
      state.rcError = null;
      state.tables = {};
      state.rpcs = {};
      state.billing = null;
    },
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
    useBillingStore() {
      const store: BillingStore = {
        webhookEvents: new Map(),
        entitlements: new Map(),
        entitlementUpserts: [],
        failEntitlementUpsert: () => null,
      };
      state.billing = store;
      return store;
    },
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const pgFailure = (failure: PostgrestFailure): Response =>
    jsonResponse(failure.status, {
      code: failure.code,
      message: failure.message,
      details: null,
      hint: null,
    });

  // maybeSingle(): PostgREST answers 406/PGRST116 for 0 rows; supabase-js
  // folds that into data:null, error:null.
  const noRows = (): Response => pgFailure({ status: 406, code: "PGRST116", message: "0 rows" });

  const statefulBilling = (
    table: string,
    request: Request,
    headers: Record<string, string>,
    body: unknown,
  ): Response | null => {
    const store = state.billing;
    if (!store) return null;
    if (table === "webhook_events") {
      if (request.method === "GET") {
        const filter = new URL(request.url).searchParams.get("id") ?? "";
        const id = filter.startsWith("eq.") ? filter.slice(3) : filter;
        const row = store.webhookEvents.get(id);
        if ((headers["accept"] ?? "").includes("application/vnd.pgrst.object+json")) {
          return row ? jsonResponse(200, { id: row.id }) : noRows();
        }
        return jsonResponse(200, row ? [{ id: row.id }] : []);
      }
      if (request.method === "POST" && isRecord(body)) {
        const id = String(body.id);
        if (!store.webhookEvents.has(id)) store.webhookEvents.set(id, body);
        return new Response(null, { status: 201 });
      }
      return null;
    }
    if (table === "billing_entitlements" && request.method === "POST" && isRecord(body)) {
      const n = store.entitlementUpserts.length;
      store.entitlementUpserts.push(body);
      const failure = store.failEntitlementUpsert(n, body);
      if (failure) return pgFailure(failure);
      store.entitlements.set(String(body.user_id), body);
      return new Response(null, { status: 201 });
    }
    return null;
  };

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
      if (state.rcError) throw state.rcError;
      if (state.rcStatus !== null) {
        return jsonResponse(state.rcStatus, { code: 7225, message: "Invalid API key." });
      }
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
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      const payload = isRecord(body) ? body : {};
      const token = typeof payload.id_token === "string" ? payload.id_token : "";
      const segment = token.split(".")[1] ?? "";
      let sub = TEST_USER_ID;
      try {
        const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
        const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
        sub = String(JSON.parse(atob(padded)).sub ?? TEST_USER_ID);
      } catch {
        // keep default
      }
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: `session-for-${sub}`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: "refresh",
        user: {
          id: sub,
          aud: "authenticated",
          role: "authenticated",
          email: "user@example.com",
          app_metadata: {},
          user_metadata: {},
          created_at: new Date().toISOString(),
        },
      });
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
      const stateful = statefulBilling(table, request, headers, body);
      if (stateful) return stateful;
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
  harness = state;
  return state;
}

/** Capture console.error / console.warn lines (joined args) until restored.
 * Use to assert that a failure path leaves an operator diagnostic — and that
 * no diagnostic leaks a secret. */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const originalError = console.error;
  const originalWarn = console.warn;
  const record = (...args: unknown[]) => {
    lines.push(
      args
        .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
        .join(" "),
    );
  };
  console.error = record;
  console.warn = record;
  return {
    lines,
    restore: () => {
      console.error = originalError;
      console.warn = originalWarn;
    },
  };
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
  const headers = new Headers({
    Authorization: `Bearer ${options.token ?? fakeGoogleIdToken()}`,
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
