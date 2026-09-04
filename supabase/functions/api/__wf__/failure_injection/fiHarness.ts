// Failure-injection harness for the shipping edge function.
//
// Loads the REAL handler (../../index.ts, captured from Deno.serve) exactly
// once per isolate, with Upstash Redis ENABLED (pointed at a fake in-process
// Redis so the L2 cache + shared rate-limit paths are exercised) and every
// outbound fetch routed through a controllable fault interceptor. A scenario
// installs fault rules per upstream dependency (Supabase Auth, PostgREST,
// Redis, RevenueCat, Apple); anything not faulted is answered by healthy
// fixtures derived deterministically from the scenario seed.
//
// Nothing here touches production code. The harness is additive test
// infrastructure only.

import { encryptAppleRefreshToken } from "../../externalAccounts.ts";

export type Dependency =
  | "auth"
  | "rest"
  | "redis"
  | "revenuecat"
  | "apple"
  | "storage"
  | "other";

export type FaultMode =
  | { kind: "healthy" }
  | { kind: "http"; status: number; body: string; contentType: string }
  | { kind: "network_error" }
  | { kind: "malformed_json" }
  | { kind: "wrong_shape" }
  | { kind: "empty_body" }
  | { kind: "slow"; delayMs: number }
  | { kind: "hang" };

export interface OutboundCall {
  seq: number;
  dependency: Dependency;
  method: string;
  url: string;
  path: string;
  query: string;
  accept: string | null;
  body: string | null;
  faulted: boolean;
  faultKind: string | null;
  faultStatus: number | null;
  durationMs: number;
}

export interface FaultRule {
  dependency: Dependency;
  mode: FaultMode;
  /** Narrow the rule to a subset of calls (e.g. one table / one auth path). */
  match?: (call: OutboundCall) => boolean;
  /** Only fault the Nth (0-based) and later matching calls of this dependency. */
  fromMatchIndex?: number;
  /** Stop faulting after this many faulted calls. */
  maxFaults?: number;
}

export interface ScenarioIds {
  permitId: string;
  sessionId: string;
  shotId: string;
  analysisId: string;
  trialId: string;
  challenge: string;
  eventId: string;
  drillSlug: string;
}

export interface ScenarioContext {
  seed: string;
  sentinel: string;
  userId: string;
  provider: "google" | "apple";
  ip: string;
  bearer: string;
  refreshToken: string;
  ids: ScenarioIds;
  /** Optional fixture overrides: rows for PostgREST GET by table name. */
  tableRows?: Record<string, unknown[]>;
  /** Optional fixture overrides: RPC results by function name. */
  rpcResults?: Record<string, unknown>;
  /** Optional RevenueCat subscriber override (healthy path). */
  subscriber?: Record<string, unknown> | null;
  /** Apple external-credentials row is present (delete-confirm apple path). */
  appleCredentialStored?: boolean;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  /** Install the active scenario (fault rules + fixture context). */
  arm(ctx: ScenarioContext, rules: FaultRule[]): void;
  /** Calls recorded since the last arm(). */
  calls(): OutboundCall[];
  /** Release every hanging upstream promise (they resolve as 599). */
  releaseHangs(): number;
  /** Reset the fake Redis. */
  resetRedis(): void;
  redisKeys(): number;
  appleTokenEncryptionKey: string;
}

export const SUPABASE_URL = "http://supabase.fi.test";
export const REDIS_URL = "http://redis.fi.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const WEBHOOK_SECRET = "fi-webhook-secret";
export const REVENUECAT_SECRET_API_KEY = "sk_fi_revenuecat";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function fakeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  return `${header}.${b64url(JSON.stringify(payload))}.fi-signature`;
}

export function providerIdToken(
  provider: "google" | "apple",
  sub: string,
): string {
  return fakeJwt({
    iss: provider === "google"
      ? "https://accounts.google.com"
      : "https://appleid.apple.com",
    sub,
    aud: "com.picklesensei",
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}

export function supabaseAccessToken(sub: string, ttlSeconds = 3600): string {
  return fakeJwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
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
  const encoded = bytesToBase64(pkcs8).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic RFC-4122-shaped UUID from a seed string (v4 bits set). */
export async function seededUuid(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  const v = hex.slice(12, 15);
  const y = ["8", "9", "a", "b"][parseInt(hex[16], 16) % 4];
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${v}-${y}${
    hex.slice(17, 20)
  }-${hex.slice(20, 32)}`;
}

export async function buildScenarioContext(
  seed: string,
  provider: "google" | "apple" = "google",
): Promise<ScenarioContext> {
  const hex = await sha256Hex(seed);
  const userId = await seededUuid(`${seed}:user`);
  const octet = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return {
    seed,
    sentinel: `FI_LEAK_${hex.slice(0, 12)}`,
    userId,
    provider,
    ip: `10.${octet(0)}.${octet(2)}.${octet(4)}`,
    bearer: supabaseAccessToken(userId),
    refreshToken: `fi-refresh-${hex.slice(0, 16)}`,
    ids: {
      permitId: await seededUuid(`${seed}:permit`),
      sessionId: await seededUuid(`${seed}:session`),
      shotId: await seededUuid(`${seed}:shot`),
      analysisId: await seededUuid(`${seed}:analysis`),
      trialId: await seededUuid(`${seed}:trial`),
      challenge: await seededUuid(`${seed}:challenge`),
      eventId: `evt-${hex.slice(0, 16)}`,
      drillSlug: "wall-dink-rally",
    },
  };
}

// ─── Fake Redis (Upstash pipeline semantics, in-process) ─────────────────────

interface RedisEntry {
  value: string;
  expiresAtMs: number | null;
}

class FakeRedis {
  private store = new Map<string, RedisEntry>();

  reset(): void {
    this.store.clear();
  }

  size(): number {
    this.sweep();
    return this.store.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAtMs !== null && entry.expiresAtMs <= now) {
        this.store.delete(key);
      }
    }
  }

  exec(
    command: Array<string | number>,
  ): { result: unknown } | { error: string } {
    this.sweep();
    const [op, ...args] = command.map(String);
    switch (op.toUpperCase()) {
      case "GET": {
        const entry = this.store.get(args[0]);
        return { result: entry ? entry.value : null };
      }
      case "SET": {
        let expiresAtMs: number | null = null;
        for (let i = 2; i < args.length; i += 1) {
          if (args[i].toUpperCase() === "EX") {
            expiresAtMs = Date.now() + Number(args[i + 1]) * 1000;
          }
        }
        this.store.set(args[0], { value: args[1], expiresAtMs });
        return { result: "OK" };
      }
      case "DEL": {
        let n = 0;
        for (const key of args) if (this.store.delete(key)) n += 1;
        return { result: n };
      }
      case "INCR": {
        const entry = this.store.get(args[0]);
        const next = (entry ? Number(entry.value) : 0) + 1;
        this.store.set(args[0], {
          value: String(next),
          expiresAtMs: entry?.expiresAtMs ?? null,
        });
        return { result: next };
      }
      case "EXPIRE": {
        const entry = this.store.get(args[0]);
        if (!entry) return { result: 0 };
        const nx = args.slice(2).some((a) => a.toUpperCase() === "NX");
        if (nx && entry.expiresAtMs !== null) return { result: 0 };
        entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
        return { result: 1 };
      }
      case "TTL": {
        const entry = this.store.get(args[0]);
        if (!entry) return { result: -2 };
        if (entry.expiresAtMs === null) return { result: -1 };
        return {
          result: Math.max(
            1,
            Math.ceil((entry.expiresAtMs - Date.now()) / 1000),
          ),
        };
      }
      default:
        return { error: `ERR unknown command '${op}'` };
    }
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const jsonResponse = (
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });

function supabaseUser(ctx: ScenarioContext) {
  return {
    id: ctx.userId,
    aud: "authenticated",
    role: "authenticated",
    email: `fi-${ctx.userId.slice(0, 8)}@example.com`,
    app_metadata: { provider: ctx.provider, providers: [ctx.provider] },
    user_metadata: {},
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

function supabaseSession(ctx: ScenarioContext) {
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: supabaseAccessToken(ctx.userId),
    token_type: "bearer",
    expires_in: 3600,
    expires_at: expiresAt,
    refresh_token: `${ctx.refreshToken}-rotated`,
    user: supabaseUser(ctx),
  };
}

function profileRow(ctx: ScenarioContext) {
  return {
    id: ctx.userId,
    email: `fi-${ctx.userId.slice(0, 8)}@example.com`,
    onboarding_state: "complete",
    provider: ctx.provider,
    skill_level: "intermediate",
    handedness: "right",
    primary_goal: "dinks",
    biggest_problem: "Consistency",
    focus_checkpoint: "contact_position",
    first_name: null,
    gender: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };
}

function nowIso(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

async function healthyTableRows(
  ctx: ScenarioContext,
  table: string,
  method: string,
  query: URLSearchParams,
  appleKey: string,
): Promise<unknown[]> {
  if (ctx.tableRows && table in ctx.tableRows) return ctx.tableRows[table];
  switch (table) {
    case "profiles":
      return [profileRow(ctx)];
    case "analysis_permits":
      return method === "PATCH"
        ? [
          {
            id: ctx.ids.permitId,
            status: "finalized",
            outcome: "cancelled",
            created_at: nowIso(-60_000),
          },
        ]
        : [{
          id: ctx.ids.permitId,
          status: "reserved",
          outcome: null,
          created_at: nowIso(-60_000),
        }];
    case "sessions":
      return [{ id: ctx.ids.sessionId, ended_at: null }];
    case "shots": {
      // Feedback looks the analysis up by id=eq.<analysisId>; sync asks
      // id=in.(...) for replay detection (none exist → every shot is new).
      const idFilter = query.get("id") ?? "";
      return idFilter.startsWith("eq.") ? [{ id: idFilter.slice(3) }] : [];
    }
    case "consent_records":
      return [
        {
          scope: "evaluation_telemetry",
          action: "grant",
          consent_version: "2026-08",
          created_at: nowIso(-86_400_000),
        },
        {
          scope: "model_training",
          action: "grant",
          consent_version: "2026-08",
          created_at: nowIso(-86_400_000),
        },
      ];
    case "evaluation_trials":
      return [{ id: ctx.ids.trialId }];
    case "analysis_feedback":
      return [{
        id: await seededUuid(`${ctx.seed}:feedback`),
        created_at: nowIso(),
      }];
    case "progress_daily":
      return [
        {
          day: "2026-09-01",
          shot_type: "dink",
          scoring_model_version: "scoring-v1",
          shot_count: 3,
          avg_score: 7.1,
          best_score: 8.2,
        },
      ];
    case "practice_days":
      return [{ day: "2026-09-01" }, { day: "2026-09-02" }];
    case "player_technique_rating":
      return [
        {
          shot_type: "dink",
          score: 7.1,
          captured_at: "2026-09-01T10:00:00.000Z",
          sampled_count: 3,
          confidence_weight: 3,
        },
      ];
    case "player_rank_state":
      return [
        {
          rating: 7.1,
          tier: "gold",
          technique_count: 1,
          scored_shot_count: 3,
          updated_at: "2026-09-01T10:00:00.000Z",
        },
      ];
    case "user_saved_drills":
      return [{ slug: ctx.ids.drillSlug, saved_at: nowIso(-3_600_000) }];
    case "account_deletion_requests":
      return [
        {
          challenge: ctx.ids.challenge,
          created_at: nowIso(-10_000),
          expires_at: nowIso(15 * 60_000),
        },
      ];
    case "account_external_credentials":
      if (ctx.provider === "apple" && ctx.appleCredentialStored) {
        return [
          {
            apple_refresh_token_encrypted: await encryptAppleRefreshToken(
              "fi-apple-refresh-token",
              ctx.userId,
              appleKey,
            ),
            apple_revoked_at: null,
            revenuecat_deleted_at: null,
          },
        ];
      }
      return [];
    case "webhook_events":
      return [];
    case "billing_entitlements":
      return [];
    default:
      return [];
  }
}

function healthyRpc(ctx: ScenarioContext, fn: string): unknown {
  if (ctx.rpcResults && fn in ctx.rpcResults) return ctx.rpcResults[fn];
  switch (fn) {
    case "access_state":
      return [{ premium: false, scored_count: 0, reserved_count: 0 }];
    case "reserve_analysis_permit":
      return [
        {
          result: "accepted",
          permit_id: ctx.ids.permitId,
          permit_status: "reserved",
          permit_outcome: null,
          permit_created_at: nowIso(),
        },
      ];
    case "apply_synced_shot":
      return "accepted";
    default:
      return null;
  }
}

export function activeSubscriber(): Record<string, unknown> {
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: nowIso(86_400_000),
        product_identifier: "pickle_sensei_pro_monthly",
      },
    },
  };
}

// ─── Fault bodies ────────────────────────────────────────────────────────────

export function faultBody(
  dependency: Dependency,
  status: number,
  sentinel: string,
): {
  body: string;
  contentType: string;
} {
  if (status === 502 || status === 504) {
    return {
      contentType: "text/html",
      body:
        `<html><head><title>${status} Bad Gateway</title></head><body>${status} Bad Gateway ${sentinel} upstream connect error</body></html>`,
    };
  }
  switch (dependency) {
    case "rest":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          code: "XX000",
          message: `${sentinel} relation "public.secret_table" does not exist`,
          details: `${sentinel} PL/pgSQL function at /var/lib/postgresql/x.sql`,
          hint: null,
        }),
      };
    case "auth":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          code: status,
          error_code: "unexpected_failure",
          msg: `${sentinel} database error querying schema auth.users`,
        }),
      };
    case "redis":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: `${sentinel} WRONGPASS invalid username-password pair`,
        }),
      };
    case "revenuecat":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          code: 7225,
          message: `${sentinel} Internal server error`,
        }),
      };
    case "apple":
      return {
        contentType: "application/json",
        body: JSON.stringify({
          error: "server_error",
          error_description: sentinel,
        }),
      };
    default:
      return {
        contentType: "text/plain",
        body: `${sentinel} upstream failure`,
      };
  }
}

export const httpFault = (
  dependency: Dependency,
  status: number,
  sentinel: string,
): FaultMode => {
  const { body, contentType } = faultBody(dependency, status, sentinel);
  return { kind: "http", status, body, contentType };
};

// ─── Harness ─────────────────────────────────────────────────────────────────

let loaded: Harness | null = null;

function classify(url: URL): Dependency {
  const origin = url.origin;
  if (origin === SUPABASE_URL) {
    if (url.pathname.startsWith("/auth/v1/")) return "auth";
    if (url.pathname.startsWith("/rest/v1/")) return "rest";
    if (url.pathname.startsWith("/storage/v1/")) return "storage";
    return "other";
  }
  if (origin === REDIS_URL) return "redis";
  if (url.href.startsWith(RC_URL)) return "revenuecat";
  if (url.hostname === "appleid.apple.com") return "apple";
  return "other";
}

export async function loadFailureInjectionHarness(): Promise<Harness> {
  if (loaded) return loaded;

  const appleTokenEncryptionKey = bytesToBase64(
    crypto.getRandomValues(new Uint8Array(32)),
  );
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "fi-anon-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "fi-service-role-key");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", REVENUECAT_SECRET_API_KEY);
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "FITEAM1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "FIKEY12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  // Redis ON: cache.ts reads these at module load, so they must be set
  // before ../../index.ts is imported below.
  Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
  Deno.env.set("UPSTASH_REDIS_REST_TOKEN", "fi-redis-token");

  const redis = new FakeRedis();
  let ctx: ScenarioContext | null = null;
  let rules: FaultRule[] = [];
  let calls: OutboundCall[] = [];
  let seq = 0;
  const matchCounters = new Map<FaultRule, { seen: number; faulted: number }>();
  const hanging = new Set<(response: Response) => void>();

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const applyFault = (
    call: OutboundCall,
    mode: FaultMode,
    signal: AbortSignal | null | undefined,
    healthy: () => Promise<Response>,
    dependency: Dependency,
    sentinel: string,
  ): Promise<Response> => {
    switch (mode.kind) {
      case "healthy":
        return healthy();
      case "http":
        return Promise.resolve(
          new Response(mode.body, {
            status: mode.status,
            headers: { "Content-Type": mode.contentType },
          }),
        );
      case "network_error":
        return Promise.reject(
          new TypeError(
            `error sending request for url (${call.url}): client error (Connect): dns error ${sentinel}`,
          ),
        );
      case "malformed_json":
        return Promise.resolve(
          new Response(`{"${sentinel}": tru`, {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      case "wrong_shape": {
        // Valid JSON, wrong type: an object where an array is expected (REST
        // rows, Redis pipeline) or an unrelated object (Auth/RevenueCat).
        const body = dependency === "revenuecat"
          ? { unexpected: sentinel }
          : dependency === "rest"
          ? { message: sentinel }
          : dependency === "redis"
          ? { result: sentinel }
          : { unexpected: sentinel };
        return Promise.resolve(jsonResponse(200, body));
      }
      case "empty_body":
        return Promise.resolve(
          new Response("", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      case "slow":
        return sleep(mode.delayMs).then(healthy);
      case "hang":
        return new Promise<Response>((resolve, reject) => {
          const release = (response: Response) => {
            hanging.delete(release);
            resolve(response);
          };
          hanging.add(release);
          if (signal) {
            const onAbort = () => {
              hanging.delete(release);
              reject(
                signal.reason instanceof Error
                  ? signal.reason
                  : new DOMException(
                    "The operation was aborted.",
                    "AbortError",
                  ),
              );
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        });
    }
  };

  const healthyResponse = async (
    dependency: Dependency,
    request: Request,
    url: URL,
    bodyText: string,
    scenario: ScenarioContext,
  ): Promise<Response> => {
    switch (dependency) {
      case "auth": {
        const path = url.pathname.slice("/auth/v1".length);
        if (request.method === "POST" && path === "/token") {
          const grant = url.searchParams.get("grant_type");
          if (grant === "id_token" || grant === "refresh_token") {
            return jsonResponse(200, supabaseSession(scenario));
          }
          return jsonResponse(400, { error: "unsupported_grant_type" });
        }
        if (request.method === "GET" && path === "/user") {
          return jsonResponse(200, supabaseUser(scenario));
        }
        if (request.method === "POST" && path === "/logout") {
          return new Response(null, { status: 204 });
        }
        if (request.method === "DELETE" && path.startsWith("/admin/users/")) {
          return jsonResponse(200, {});
        }
        return jsonResponse(404, { msg: "fi auth: unhandled" });
      }
      case "rest": {
        const table = url.pathname.slice("/rest/v1/".length);
        if (table.startsWith("rpc/")) {
          return jsonResponse(
            200,
            healthyRpc(scenario, table.slice("rpc/".length)),
          );
        }
        const accept = request.headers.get("accept") ?? "";
        const wantsObject = accept.includes(
          "application/vnd.pgrst.object+json",
        );
        const rows = await healthyTableRows(
          scenario,
          table,
          request.method,
          url.searchParams,
          appleTokenEncryptionKey,
        );
        if (request.method === "GET") {
          return wantsObject
            ? jsonResponse(200, rows[0] ?? {})
            : jsonResponse(200, rows);
        }
        const wantsRepresentation = (request.headers.get("prefer") ?? "")
          .includes(
            "return=representation",
          );
        if (wantsRepresentation) {
          return wantsObject
            ? jsonResponse(201, rows[0] ?? {})
            : jsonResponse(request.method === "POST" ? 201 : 200, rows);
        }
        return new Response(null, {
          status: request.method === "DELETE" ? 204 : 201,
        });
      }
      case "redis": {
        let commands: unknown;
        try {
          commands = JSON.parse(bodyText);
        } catch {
          return jsonResponse(400, { error: "ERR invalid pipeline" });
        }
        if (!Array.isArray(commands)) {
          return jsonResponse(400, { error: "ERR invalid pipeline" });
        }
        return jsonResponse(
          200,
          commands.map((command) =>
            redis.exec(command as Array<string | number>)
          ),
        );
      }
      case "revenuecat": {
        if (request.method === "DELETE") return jsonResponse(200, {});
        const subscriber = scenario.subscriber === undefined
          ? activeSubscriber()
          : scenario.subscriber;
        return jsonResponse(200, { request_date_ms: Date.now(), subscriber });
      }
      case "apple": {
        if (url.pathname === "/auth/token") {
          return jsonResponse(200, {
            refresh_token: "fi-apple-refresh-token",
            id_token: providerIdToken("apple", scenario.userId),
          });
        }
        if (url.pathname === "/auth/revoke") {
          return new Response(null, { status: 200 });
        }
        return jsonResponse(404, { error: "fi apple: unhandled" });
      }
      case "storage":
        return new Response(
          `fi: storage is not stubbed (no route should reach it) ${url}`,
          {
            status: 599,
          },
        );
      default:
        return new Response(`fi: unexpected fetch ${request.method} ${url}`, {
          status: 599,
        });
    }
  };

  const realServe = Deno.serve;
  let captured: ((request: Request) => Promise<Response>) | null = null;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const dependency = classify(url);
    const bodyText = request.method === "GET" || request.method === "HEAD"
      ? ""
      : await request.clone().text().catch(() => "");
    const startedAt = performance.now();
    const call: OutboundCall = {
      seq: seq++,
      dependency,
      method: request.method,
      url: request.url,
      path: url.pathname,
      query: url.search,
      accept: request.headers.get("accept"),
      body: bodyText ? bodyText.slice(0, 2_000) : null,
      faulted: false,
      faultKind: null,
      faultStatus: null,
      durationMs: 0,
    };
    calls.push(call);
    const scenario = ctx;
    if (!scenario) {
      call.durationMs = performance.now() - startedAt;
      return new Response("fi: no scenario armed", { status: 599 });
    }

    let mode: FaultMode = { kind: "healthy" };
    for (const rule of rules) {
      if (rule.dependency !== dependency) continue;
      if (rule.match && !rule.match(call)) continue;
      const counter = matchCounters.get(rule) ?? { seen: 0, faulted: 0 };
      matchCounters.set(rule, counter);
      const index = counter.seen;
      counter.seen += 1;
      if (rule.fromMatchIndex !== undefined && index < rule.fromMatchIndex) {
        continue;
      }
      if (rule.maxFaults !== undefined && counter.faulted >= rule.maxFaults) {
        continue;
      }
      counter.faulted += 1;
      mode = rule.mode;
      break;
    }
    if (mode.kind !== "healthy") {
      call.faulted = true;
      call.faultKind = mode.kind;
      call.faultStatus = mode.kind === "http" ? mode.status : null;
    }
    const signal = init?.signal ??
      (input instanceof Request ? input.signal : null);
    try {
      return await applyFault(
        call,
        mode,
        signal,
        () => healthyResponse(dependency, request, url, bodyText, scenario),
        dependency,
        scenario.sentinel,
      );
    } finally {
      call.durationMs = performance.now() - startedAt;
    }
  }) as typeof fetch;

  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    captured = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../../index.ts");
  Deno.serve = realServe;
  if (!captured) {
    throw new Error("fi: edge handler was not captured from Deno.serve");
  }
  const handler = captured;

  const cacheModule = await import("../../cache.ts");
  if (!cacheModule.redisConfigured()) {
    throw new Error(
      "fi: cache.ts loaded without Redis configured — another harness imported index.ts first in this isolate",
    );
  }

  loaded = {
    handler,
    appleTokenEncryptionKey,
    arm(next, nextRules) {
      ctx = next;
      rules = nextRules;
      calls = [];
      matchCounters.clear();
    },
    calls: () => calls,
    releaseHangs() {
      const n = hanging.size;
      for (const release of [...hanging]) {
        release(new Response("fi: hang released", { status: 599 }));
      }
      return n;
    },
    resetRedis: () => redis.reset(),
    redisKeys: () => redis.size(),
  };
  return loaded;
}

// ─── Request builders ────────────────────────────────────────────────────────

export const EDGE_ORIGIN = "http://edge.fi.test/functions/v1/api";

export function edgeRequest(
  ctx: ScenarioContext,
  method: string,
  path: string,
  options: {
    body?: unknown;
    bearer?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": ctx.ip,
    ...options.headers,
  });
  const bearer = options.bearer === undefined ? ctx.bearer : options.bearer;
  if (bearer) headers.set("Authorization", `Bearer ${bearer}`);
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return new Request(`${EDGE_ORIGIN}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export function canonicalShot(ctx: ScenarioContext): Record<string, unknown> {
  return {
    id: ctx.ids.shotId,
    source: "real",
    analysisPermitId: ctx.ids.permitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    timestamps: { startMs: 0, contactMs: 100, endMs: 200 },
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [{
      key: "preparation",
      startMs: 0,
      representativeMs: 50,
      endMs: 100,
      confidence: 0.9,
    }],
    checkpoints: [
      {
        key: "contact_position",
        score: 70,
        confidence: 0.9,
        band: "green",
        direction: "ok",
        severity: 0.1,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: "1.0.0",
      modelBundleVersion: "b1",
      poseModelVersion: "p1",
      paddleModelVersion: "pd1",
      strokeDetectorVersion: "s1",
      phaseModelVersion: "ph1",
      scoringModelVersion: "sc1",
      shotConfigVersion: "cfg1",
    },
  };
}

export { isRecord };
