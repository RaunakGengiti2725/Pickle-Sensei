/**
 * stress-route-post-v1-me-delete-confirm — in-process harness.
 *
 * Boots the REAL edge function (../index.ts) with Deno.serve captured and
 * every upstream stubbed at the fetch layer behind a mutable `World`:
 * Supabase Auth (id-token exchange, GET /user, admin deleteUser), PostgREST
 * (account_deletion_requests as the user, account_external_credentials as
 * the service role), RevenueCat and Apple. Upstash is unset, so rate limits
 * and the auth cache run on the per-isolate memory implementation.
 *
 * Every upstream call is recorded with a `write` flag so a scenario can
 * assert "no write on rejection" precisely: a write is any PostgREST
 * POST/PATCH/DELETE, the GoTrue admin DELETE, the RevenueCat DELETE or the
 * Apple revoke POST.
 *
 * Distinctive upstream error strings carry `LEAK_MARKER` so any response
 * that echoes upstream detail is caught by a plain substring search.
 */

export const SUPABASE_URL = "http://supabase.stress.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const LEAK_MARKER = "STRESS_UPSTREAM_DETAIL_7f3c9";

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  write: boolean;
  kind:
    | "gotrue.id_token"
    | "gotrue.get_user"
    | "gotrue.admin_delete"
    | "rest.deletion_requests.read"
    | "rest.deletion_requests.write"
    | "rest.external_credentials.read"
    | "rest.external_credentials.write"
    | "rest.other"
    | "revenuecat.delete"
    | "revenuecat.other"
    | "apple.revoke"
    | "apple.token"
    | "unexpected";
}

/** How a stubbed upstream answers. `throw` = fetch rejects (network fault). */
export type UpstreamAnswer =
  | { status: number; body?: unknown; text?: string }
  | "throw";

export interface DeletionRow {
  challenge: unknown;
  created_at: unknown;
  expires_at: unknown;
}

export interface ExternalRow {
  apple_refresh_token_encrypted: string | null;
  apple_revoked_at: string | null;
  revenuecat_deleted_at: string | null;
}

export interface World {
  /** Users known to the fake GoTrue: id → provider. Session bearers whose
   * `sub` is not here are refused (403 user_not_found), like a deleted user. */
  users: Map<
    string,
    { provider: "google" | "apple" | "none"; email: string | null }
  >;
  /** Override for POST /auth/v1/token?grant_type=id_token (default: mint). */
  idTokenExchange: UpstreamAnswer | null;
  /** Override for GET /auth/v1/user (default: look up `users`). */
  getUser: UpstreamAnswer | null;
  /** DELETE /auth/v1/admin/users/:id. Default: 200 if known, else 404. */
  adminDelete: UpstreamAnswer | null;
  /** Rows of account_deletion_requests keyed by user_id. */
  deletionRows: Map<string, DeletionRow>;
  /** Override for the deletion-row read (PostgREST error / garbage). */
  deletionRead: UpstreamAnswer | null;
  /** Rows of account_external_credentials keyed by user_id. */
  externalRows: Map<string, ExternalRow>;
  externalRead: UpstreamAnswer | null;
  externalWrite: UpstreamAnswer | null;
  revenuecatDelete: UpstreamAnswer | null;
  appleRevoke: UpstreamAnswer | null;
  /** When true the admin delete removes the user from `users` (so a replayed
   * bearer is refused like production) and drops its deletion row (cascade). */
  cascade: boolean;
}

export function freshWorld(): World {
  return {
    users: new Map(),
    idTokenExchange: null,
    getUser: null,
    adminDelete: null,
    deletionRows: new Map(),
    deletionRead: null,
    externalRows: new Map(),
    externalRead: null,
    externalWrite: null,
    revenuecatDelete: null,
    appleRevoke: null,
    cascade: true,
  };
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  world: World;
  calls: RecordedCall[];
  appleTokenEncryptionKey: string;
  /** Replace the world, clear recorded calls and (re)install the upstream
   * fetch stub. */
  begin(world?: World): World;
  /** Restore `globalThis.fetch` and every environment variable the harness
   * changed, so test files that run later in the same process see the
   * process as they would have without this harness. */
  teardown(): void;
  realFetch: typeof fetch;
}

const HARNESS_ENV: Record<string, string | null> = {
  SUPABASE_URL,
  SUPABASE_ANON_KEY: "anon-stress-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-stress-key",
  REVENUECAT_WEBHOOK_AUTH: "stress-webhook-secret",
  REVENUECAT_SECRET_API_KEY: "sk_stress_revenuecat",
  APPLE_SIGN_IN_CLIENT_ID: "com.picklesensei",
  APPLE_SIGN_IN_TEAM_ID: "TEAMID1234",
  APPLE_SIGN_IN_KEY_ID: "KEYID12345",
  UPSTASH_REDIS_REST_URL: null,
  UPSTASH_REDIS_REST_TOKEN: null,
};

function applyEnv(values: Record<string, string | null>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function decodeJwtPayloadLoose(
  token: string,
): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const raw = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const parsed = JSON.parse(atob(padded)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function googleIdToken(
  sub: string,
  expSeconds = Math.floor(Date.now() / 1000) + 3600,
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: expSeconds,
    }),
  );
  return `${header}.${payload}.sig`;
}

export function appleIdToken(
  sub: string,
  expSeconds = Math.floor(Date.now() / 1000) + 3600,
): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iss: "https://appleid.apple.com", sub, exp: expSeconds }),
  );
  return `${header}.${payload}.sig`;
}

/** A Supabase session access token as the app bears it after bootstrap. */
export function sessionToken(
  sub: string,
  sessionId: string,
  expSeconds = Math.floor(Date.now() / 1000) + 3600,
  extra: Record<string, unknown> = {},
): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      session_id: sessionId,
      role: "authenticated",
      aud: "authenticated",
      exp: expSeconds,
      ...extra,
    }),
  );
  return `${header}.${payload}.${b64url(`sig-${sub}-${sessionId}`)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function testApplePrivateKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [
      "sign",
      "verify",
    ],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const encoded = bytesToBase64(pkcs8)
    .match(/.{1,64}/g)
    ?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

const jsonResponse = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

function answer(override: UpstreamAnswer): Response {
  if (override === "throw") {
    throw new TypeError(`stubbed network fault ${LEAK_MARKER}`);
  }
  if (override.text !== undefined) {
    return new Response(override.text, { status: override.status });
  }
  return jsonResponse(
    override.status,
    override.body === undefined ? {} : override.body,
  );
}

const userRow = (
  id: string,
  provider: "google" | "apple" | "none",
  email: string | null,
) => ({
  id,
  aud: "authenticated",
  role: "authenticated",
  email,
  app_metadata: provider === "none" ? {} : { provider, providers: [provider] },
  user_metadata: {},
  created_at: "2026-01-01T00:00:00.000Z",
});

function eqFilter(url: URL, column: string): string | null {
  const raw = url.searchParams.get(column);
  if (!raw || !raw.startsWith("eq.")) return null;
  return raw.slice(3);
}

let harness: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (harness) {
    harness.begin();
    return harness;
  }
  const appleTokenEncryptionKey = bytesToBase64(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  const env: Record<string, string | null> = {
    ...HARNESS_ENV,
    APPLE_SIGN_IN_PRIVATE_KEY: await testApplePrivateKeyPem(),
    APPLE_TOKEN_ENCRYPTION_KEY: appleTokenEncryptionKey,
  };
  const previousEnv: Record<string, string | null> = {};
  for (const key of Object.keys(env)) {
    previousEnv[key] = Deno.env.get(key) ?? null;
  }
  applyEnv(env);

  const realFetch = globalThis.fetch;
  const realServe = Deno.serve;
  const state: StressHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    world: freshWorld(),
    calls: [],
    appleTokenEncryptionKey,
    realFetch,
    begin(world = freshWorld()) {
      state.world = world;
      state.calls = [];
      applyEnv(env);
      globalThis.fetch = stubFetch;
      return world;
    },
    teardown() {
      globalThis.fetch = realFetch;
      applyEnv(previousEnv);
    },
  };

  const stubFetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    request.headers.forEach((
      value,
      key,
    ) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const w = state.world;
    const record = (kind: RecordedCall["kind"], write: boolean) =>
      state.calls.push({
        url,
        method: request.method,
        headers,
        body,
        write,
        kind,
      });

    // ── RevenueCat
    if (url.startsWith(RC_URL)) {
      if (request.method === "DELETE") {
        record("revenuecat.delete", true);
        if (w.revenuecatDelete) return answer(w.revenuecatDelete);
        return jsonResponse(200, {
          app_user_id: decodeURIComponent(url.slice(RC_URL.length)),
          deleted: true,
        });
      }
      record("revenuecat.other", false);
      return jsonResponse(200, {
        request_date_ms: Date.now(),
        subscriber: {},
      });
    }
    // ── Apple
    if (url === APPLE_REVOKE_URL) {
      record("apple.revoke", true);
      if (w.appleRevoke) return answer(w.appleRevoke);
      return new Response(null, { status: 200 });
    }
    if (url === APPLE_TOKEN_URL) {
      record("apple.token", false);
      return jsonResponse(200, {
        refresh_token: "apple-refresh",
        id_token: appleIdToken("apple-sub"),
      });
    }
    // ── GoTrue
    if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
      record("gotrue.id_token", false);
      if (w.idTokenExchange) return answer(w.idTokenExchange);
      const payload = isRecord(body) ? body : {};
      const token = typeof payload.id_token === "string"
        ? payload.id_token
        : "";
      const claims = decodeJwtPayloadLoose(token);
      const sub = typeof claims?.sub === "string" && claims.sub
        ? claims.sub
        : "";
      if (!sub) {
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: `bad id_token ${LEAK_MARKER}`,
        });
      }
      const provider = payload.provider === "apple" ? "apple" : "google";
      if (!w.users.has(sub)) {
        w.users.set(sub, {
          provider,
          email: `${sub.slice(0, 8)}@example.com`,
        });
      }
      const user = w.users.get(sub)!;
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      return jsonResponse(200, {
        access_token: sessionToken(sub, `sess-${sub}`),
        token_type: "bearer",
        expires_in: 3600,
        expires_at: expiresAt,
        refresh_token: `refresh-${sub}`,
        user: userRow(sub, user.provider, user.email),
      });
    }
    if (
      request.method === "GET" &&
      url.startsWith(`${SUPABASE_URL}/auth/v1/user`)
    ) {
      record("gotrue.get_user", false);
      if (w.getUser) return answer(w.getUser);
      const bearer = (headers["authorization"] ?? "").replace(/^Bearer /, "");
      const claims = decodeJwtPayloadLoose(bearer);
      const sub = typeof claims?.sub === "string" ? claims.sub : "";
      const user = sub ? w.users.get(sub) : undefined;
      if (!user) {
        return jsonResponse(403, {
          code: 403,
          error_code: "user_not_found",
          msg: `User not found ${LEAK_MARKER}`,
        });
      }
      return jsonResponse(200, userRow(sub, user.provider, user.email));
    }
    if (
      request.method === "DELETE" &&
      url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)
    ) {
      record("gotrue.admin_delete", true);
      if (w.adminDelete) return answer(w.adminDelete);
      const id = decodeURIComponent(
        parsed.pathname.slice(`/auth/v1/admin/users/`.length),
      );
      if (!w.users.has(id)) {
        return jsonResponse(404, {
          code: 404,
          error_code: "user_not_found",
          msg: `User not found ${LEAK_MARKER}`,
        });
      }
      if (w.cascade) {
        w.users.delete(id);
        w.deletionRows.delete(id);
        w.externalRows.delete(id);
      }
      return jsonResponse(200, {});
    }
    // ── PostgREST
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = parsed.pathname.slice("/rest/v1/".length);
      const wantsObject = (headers["accept"] ?? "").includes(
        "application/vnd.pgrst.object+json",
      );
      const single = (row: Record<string, unknown> | undefined): Response => {
        if (wantsObject) {
          if (!row) {
            return jsonResponse(406, {
              code: "PGRST116",
              message: `0 rows ${LEAK_MARKER}`,
              details: null,
              hint: null,
            });
          }
          return jsonResponse(200, row);
        }
        return jsonResponse(200, row ? [row] : []);
      };
      if (table === "account_deletion_requests") {
        if (request.method === "GET") {
          record("rest.deletion_requests.read", false);
          if (w.deletionRead) return answer(w.deletionRead);
          const userId = eqFilter(parsed, "user_id") ?? "";
          const row = w.deletionRows.get(userId);
          return single(row ? { ...row } : undefined);
        }
        record("rest.deletion_requests.write", true);
        return new Response(null, { status: 201 });
      }
      if (table === "account_external_credentials") {
        if (request.method === "GET") {
          record("rest.external_credentials.read", false);
          if (w.externalRead) return answer(w.externalRead);
          const userId = eqFilter(parsed, "user_id") ?? "";
          const row = w.externalRows.get(userId);
          return single(row ? { ...row } : undefined);
        }
        record("rest.external_credentials.write", true);
        if (w.externalWrite) return answer(w.externalWrite);
        const payload = isRecord(body) ? body : {};
        if (request.method === "POST") {
          const userId = typeof payload.user_id === "string"
            ? payload.user_id
            : "";
          const prior = w.externalRows.get(userId) ?? {
            apple_refresh_token_encrypted: null,
            apple_revoked_at: null,
            revenuecat_deleted_at: null,
          };
          w.externalRows.set(userId, {
            ...prior,
            ...(typeof payload.revenuecat_deleted_at === "string"
              ? { revenuecat_deleted_at: payload.revenuecat_deleted_at }
              : {}),
          });
          return new Response(null, { status: 201 });
        }
        if (request.method === "PATCH") {
          const userId = eqFilter(parsed, "user_id") ?? "";
          const prior = w.externalRows.get(userId);
          if (prior) {
            w.externalRows.set(userId, {
              apple_refresh_token_encrypted:
                "apple_refresh_token_encrypted" in payload
                  ? (payload.apple_refresh_token_encrypted as string | null)
                  : prior.apple_refresh_token_encrypted,
              apple_revoked_at: typeof payload.apple_revoked_at === "string"
                ? payload.apple_revoked_at
                : prior.apple_revoked_at,
              revenuecat_deleted_at: prior.revenuecat_deleted_at,
            });
          }
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 204 });
      }
      record("rest.other", request.method !== "GET");
      if (request.method === "GET") {
        return jsonResponse(200, wantsObject ? {} : []);
      }
      return new Response(null, { status: 201 });
    }
    record("unexpected", false);
    return new Response(
      `unexpected fetch in stress harness: ${request.method} ${url}`,
      { status: 599 },
    );
  }) as typeof fetch;
  globalThis.fetch = stubFetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
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
  Deno.serve = realServe;
  harness = state;
  return state;
}

/** Text that must never reach a client: stack frames, file paths, upstream
 * detail markers, table names. */
export const STACK_OR_INTERNAL_RE =
  /(\bat\s+\S+\s+\(|\.ts:\d+|\/functions\/api\/|TypeError|ReferenceError|SyntaxError|RangeError|PGRST\d+|account_deletion_requests|account_external_credentials|supabase\.stress\.test|Deno\.)/;

export interface ResponseSnapshot {
  status: number;
  requestId: string | null;
  contentType: string | null;
  body: string;
  json: unknown;
  errorCode: string | null;
  errorMessage: string | null;
  headers: Record<string, string>;
}

export async function snapshot(response: Response): Promise<ResponseSnapshot> {
  const body = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(body);
  } catch {
    json = null;
  }
  const error = isRecord(json) && isRecord(json.error) ? json.error : null;
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => (headers[key] = value));
  return {
    status: response.status,
    requestId: response.headers.get("x-request-id"),
    contentType: response.headers.get("content-type"),
    body,
    json,
    errorCode: typeof error?.code === "string" ? error.code : null,
    errorMessage: typeof error?.message === "string" ? error.message : null,
    headers,
  };
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Per-iteration seed: stable for (campaign seed, index) so any row of a
 * campaign report replays with STRESS_ONLY=<seed>. */
export function iterationSeed(campaignSeed: number, index: number): number {
  return fnv1a(`${campaignSeed}:${index}`);
}
