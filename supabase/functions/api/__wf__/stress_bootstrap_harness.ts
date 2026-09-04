// stress — POST /v1/account/bootstrap (failure injection + load).
//
// Boots the REAL ../index.ts in-process (Deno.serve captured) behind a fake of
// every upstream the route can reach — Supabase Auth (GoTrue id_token grant),
// PostgREST (profiles GET/PATCH, account_external_credentials upsert), Apple's
// token endpoint, Upstash Redis (REST pipeline) and RevenueCat — with a
// per-target FAULT switch (HTTP status + body, thrown fetch, delay, hang,
// custom) and a SEEDED latency model so bursts genuinely interleave.
//
// Every scenario is replayable from its seed (mulberry32); results are written
// as JSON tables under STRESS_OUT_DIR (default artifacts/stress-bootstrap/latest/).
//
// Nothing here talks to a network: the only fetch that exists is the fake.

export const SUPABASE_URL = "http://supabase.stress.test";
export const REDIS_URL = "http://upstash.stress.test";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const REVENUECAT_URL = "https://api.revenuecat.com/v1/subscribers/";
export const ANON_KEY = "stress-anon-key";
export const SERVICE_ROLE_KEY = "stress-service-role-key";
export const REDIS_TOKEN = "stress-upstash-token";
export const APPLE_CLIENT_ID = "com.picklesensei";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function b64urlDecode(segment: string): string {
  const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
  return atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const seg = token.split(".")[1];
  if (!seg) return null;
  try {
    const parsed = JSON.parse(b64urlDecode(seg)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** mulberry32 — deterministic, replayable. */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
/** Default sizes are small so the suite stays fast; the campaign sets them. */
export const STRESS_ITER = envInt("STRESS_ITER", 200);
export const STRESS_USERS = envInt("STRESS_USERS", 2_000);

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic v4-shaped uuid from any string (GoTrue's id for a subject). */
export function uuidFor(text: string): string {
  const parts: string[] = [];
  for (let i = 0; i < 4; i++) {
    parts.push(fnv1a(`${i}:${text}`).toString(16).padStart(8, "0"));
  }
  const hex = parts.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${
    "89ab"[parseInt(hex[16], 16) % 4]
  }${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export type Provider = "google" | "apple";

export function providerIdToken(
  provider: Provider,
  sub: string,
  options: { ttlSeconds?: number; extra?: Record<string, unknown> } = {},
): string {
  const header = b64url(
    JSON.stringify({ alg: "RS256", typ: "JWT", kid: "stress" }),
  );
  const payload = b64url(
    JSON.stringify({
      iss: provider === "google"
        ? "https://accounts.google.com"
        : "https://appleid.apple.com",
      aud: APPLE_CLIENT_ID,
      sub,
      exp: Math.floor(Date.now() / 1000) + (options.ttlSeconds ?? 3600),
      iat: Math.floor(Date.now() / 1000),
      ...(options.extra ?? {}),
    }),
  );
  return `${header}.${payload}.${b64url("sig-" + sub)}`;
}

// ── Faults ───────────────────────────────────────────────────────────────────

export type FaultTarget =
  | "gotrue.id_token"
  | "postgrest.profiles.get"
  | "postgrest.profiles.patch"
  | "postgrest.credentials.upsert"
  | "apple.token"
  | "redis"
  | "revenuecat";

export interface RecordedCall {
  seq: number;
  t: number;
  target: FaultTarget | "other";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** Set once the fake answered (status) or failed ("throw"/"hang"). */
  outcome?: string;
}

export type FaultSpec =
  | {
    kind: "http";
    status: number;
    body?: string;
    /** null = no Content-Type header at all */
    contentType?: string | null;
    headers?: Record<string, string>;
  }
  | { kind: "throw"; message?: string }
  | { kind: "delay"; ms: number }
  | { kind: "hang" }
  | {
    kind: "custom";
    respond: (
      call: RecordedCall,
      real: () => Promise<Response>,
    ) => Promise<Response> | Response;
  };

interface ArmedFault {
  spec: FaultSpec;
  remaining: number;
  hits: number;
}

export interface FakeUser {
  id: string;
  sub: string;
  email: string | null;
  provider: Provider;
}

export interface FakeRedisEntry {
  value: string;
  expiresAtMs: number;
}

export interface Harness {
  handler: (request: Request) => Promise<Response>;
  prng: Prng;
  /** Max seeded latency (ms) added to every upstream answer; 0 = none. */
  latencyMaxMs: number;
  /** False = count calls but keep no per-call record (memory campaigns must
   * not measure the harness's own log). */
  recordCalls: boolean;
  calls: RecordedCall[];
  counters: Record<string, number>;
  users: Map<string, FakeUser>;
  /** profiles by user id */
  profiles: Map<string, Record<string, unknown>>;
  /** account_external_credentials by user id */
  credentials: Map<string, Record<string, unknown>>;
  /** Apple authorization codes → subject */
  appleCodes: Map<
    string,
    { sub: string; refreshToken: string; spent: boolean }
  >;
  redis: Map<string, FakeRedisEntry>;
  redisCommands: Array<Array<string | number>>;
  /** Unknown id_token subjects are provisioned like GoTrue does on first sign-in. */
  autoProvision: boolean;
  /** user ids whose profile row is not visible for the first N reads (trigger lag). */
  profileLag: Map<string, number>;
  /** Pending `hang` faults; release() answers them all with the real fake. */
  release(): void;
  arm(target: FaultTarget, spec: FaultSpec, times?: number): void;
  disarm(target?: FaultTarget): void;
  faultHits(target: FaultTarget): number;
  reset(seed?: number): void;
  provision(
    sub: string,
    provider: Provider,
    overrides?: Partial<FakeUser>,
  ): FakeUser;
  mintAppleCode(sub: string): string;
  callsTo(target: FaultTarget): RecordedCall[];
  /** The seq the NEXT recorded upstream call will get (seq never resets). */
  nextSeq(): number;
  supabaseRoundTrips(fromSeq: number): number;
  redisRoundTrips(fromSeq: number): number;
}

let harness: Harness | null = null;
let ipCounter = 0;

/** A fresh client IP per case so per-IP budgets never bleed across cases. */
export function freshIp(): string {
  ipCounter += 1;
  return `203.0.${Math.floor(ipCounter / 250) % 250}.${(ipCounter % 250) + 1}`;
}

export function bootstrapRequest(options: {
  token?: string | null;
  authorization?: string;
  ip?: string;
  body?: unknown;
  rawBody?: BodyInit | null;
  headers?: Record<string, string>;
} = {}): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? freshIp(),
    ...options.headers,
  });
  if (options.authorization !== undefined) {
    headers.set("Authorization", options.authorization);
  } else if (options.token !== null && options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  let body: BodyInit | null = null;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(options.body);
  }
  return new Request("http://edge.test/functions/v1/api/v1/account/bootstrap", {
    method: "POST",
    headers,
    body,
  });
}

async function applePrivateKeyPem(): Promise<string> {
  const key = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    [
      "sign",
      "verify",
    ],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", key.privateKey),
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${
    lines.join("\n")
  }\n-----END PRIVATE KEY-----`;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** Boot the real edge function once per test module. `redis` fixes whether
 * cache.ts sees Upstash (it reads env at import); `apple` installs a complete
 * Sign in with Apple server configuration (a fresh P-256 key). */
export async function loadHarness(
  options: { redis?: boolean; apple?: boolean; seed?: number } = {},
): Promise<Harness> {
  if (harness) {
    harness.reset(options.seed);
    return harness;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "stress-rc-key");
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  if (options.apple ?? true) {
    Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", APPLE_CLIENT_ID);
    Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "STRESSTEAM1");
    Deno.env.set("APPLE_SIGN_IN_KEY_ID", "STRESSKEY01");
    Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await applePrivateKeyPem());
    Deno.env.set(
      "APPLE_TOKEN_ENCRYPTION_KEY",
      btoa(
        String.fromCharCode(
          ...Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff),
        ),
      ),
    );
  } else {
    for (
      const name of [
        "APPLE_SIGN_IN_CLIENT_ID",
        "APPLE_SIGN_IN_TEAM_ID",
        "APPLE_SIGN_IN_KEY_ID",
        "APPLE_SIGN_IN_PRIVATE_KEY",
        "APPLE_TOKEN_ENCRYPTION_KEY",
      ]
    ) Deno.env.delete(name);
  }
  if (options.redis) {
    Deno.env.set("UPSTASH_REDIS_REST_URL", REDIS_URL);
    Deno.env.set("UPSTASH_REDIS_REST_TOKEN", REDIS_TOKEN);
  } else {
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  }

  const faults = new Map<FaultTarget, ArmedFault>();
  const hangs: Array<() => void> = [];
  let seq = 0;
  const t0 = performance.now();

  const state: Harness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    prng: new Prng(options.seed ?? STRESS_SEED),
    latencyMaxMs: 0,
    recordCalls: true,
    calls: [],
    counters: {},
    users: new Map(),
    profiles: new Map(),
    credentials: new Map(),
    appleCodes: new Map(),
    redis: new Map(),
    redisCommands: [],
    autoProvision: true,
    profileLag: new Map(),
    release() {
      for (const fn of hangs.splice(0)) fn();
    },
    arm(target, spec, times = Number.POSITIVE_INFINITY) {
      faults.set(target, { spec, remaining: times, hits: 0 });
    },
    disarm(target) {
      if (target) faults.delete(target);
      else faults.clear();
    },
    faultHits(target) {
      return faults.get(target)?.hits ?? 0;
    },
    reset(seed) {
      state.prng = new Prng(seed ?? STRESS_SEED);
      state.latencyMaxMs = 0;
      state.recordCalls = true;
      state.calls = [];
      state.counters = {};
      state.users.clear();
      state.profiles.clear();
      state.credentials.clear();
      state.appleCodes.clear();
      state.redis.clear();
      state.redisCommands = [];
      state.autoProvision = true;
      state.profileLag.clear();
      faults.clear();
      state.release();
    },
    provision(sub, provider, overrides = {}) {
      const id = overrides.id ?? uuidFor(`${provider}:${sub}`);
      const user: FakeUser = {
        id,
        sub,
        email: overrides.email === undefined
          ? `${id.slice(0, 8)}@example.com`
          : overrides.email,
        provider,
      };
      state.users.set(sub, user);
      // handle_new_user() trigger equivalent
      state.profiles.set(id, {
        id,
        email: user.email,
        onboarding_state: "pending",
        provider,
        skill_level: null,
        handedness: null,
        primary_goal: null,
        biggest_problem: null,
        focus_checkpoint: null,
        first_name: null,
        gender: null,
      });
      return user;
    },
    mintAppleCode(sub) {
      const code = `c-${state.prng.uuid()}`;
      state.appleCodes.set(code, {
        sub,
        refreshToken: `rt-${state.prng.uuid()}`,
        spent: false,
      });
      return code;
    },
    callsTo(target) {
      return state.calls.filter((call) => call.target === target);
    },
    nextSeq() {
      return seq + 1;
    },
    supabaseRoundTrips(fromSeq) {
      return state.calls.filter((c) =>
        c.seq >= fromSeq && c.url.startsWith(SUPABASE_URL)
      ).length;
    },
    redisRoundTrips(fromSeq) {
      return state.calls.filter((c) => c.seq >= fromSeq && c.target === "redis")
        .length;
    },
  };

  const count = (key: string) => {
    state.counters[key] = (state.counters[key] ?? 0) + 1;
  };

  const classify = (
    method: string,
    url: string,
    headers: Record<string, string>,
  ): RecordedCall["target"] => {
    if (url.startsWith(`${REDIS_URL}/pipeline`)) return "redis";
    if (
      url.startsWith(`${SUPABASE_URL}/auth/v1/token`) &&
      url.includes("grant_type=id_token")
    ) {
      return "gotrue.id_token";
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/profiles`)) {
      if (method === "GET") return "postgrest.profiles.get";
      if (method === "PATCH") return "postgrest.profiles.patch";
    }
    if (
      url.startsWith(`${SUPABASE_URL}/rest/v1/account_external_credentials`)
    ) {
      return "postgrest.credentials.upsert";
    }
    if (url === APPLE_TOKEN_URL) return "apple.token";
    if (url.startsWith(REVENUECAT_URL)) return "revenuecat";
    void headers;
    return "other";
  };

  const principal = (headers: Record<string, string>) => {
    const auth = headers["authorization"] ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token === SERVICE_ROLE_KEY) {
      return { role: "service" as const, userId: null };
    }
    if (!token || token === ANON_KEY) {
      return { role: "anon" as const, userId: null };
    }
    const payload = jwtPayload(token);
    return {
      role: "user" as const,
      userId: typeof payload?.sub === "string" ? payload.sub : null,
    };
  };

  const sessionFor = (user: FakeUser) => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const sid = state.prng.uuid();
    const accessToken = `${
      b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    }.${
      b64url(
        JSON.stringify({
          iss: `${SUPABASE_URL}/auth/v1`,
          sub: user.id,
          aud: "authenticated",
          role: "authenticated",
          session_id: sid,
          exp,
        }),
      )
    }.sig`;
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: exp,
      refresh_token: `rt-${state.prng.uuid()}`,
      user: {
        id: user.id,
        aud: "authenticated",
        role: "authenticated",
        email: user.email,
        app_metadata: { provider: user.provider, providers: [user.provider] },
        user_metadata: {},
        identities: [],
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    };
  };

  const real = (call: RecordedCall, parsed: URL): Response => {
    const { url, method, headers, body } = call;
    if (call.target === "redis") {
      if (headers["authorization"] !== `Bearer ${REDIS_TOKEN}`) {
        return jsonResponse(401, { error: "Unauthorized" });
      }
      const commands = Array.isArray(body)
        ? (body as Array<Array<string | number>>)
        : [];
      return jsonResponse(
        200,
        commands.map((command) => runRedisCommand(state, command)),
      );
    }
    if (call.target === "gotrue.id_token") {
      const payload = isRecord(body) ? body : {};
      const idToken = typeof payload.id_token === "string"
        ? payload.id_token
        : "";
      const claims = jwtPayload(idToken);
      const sub = typeof claims?.sub === "string" ? claims.sub : "";
      const wanted = payload.provider === "apple" ? "apple" : "google";
      let user = state.users.get(sub);
      if (!user && sub && state.autoProvision) {
        user = state.provision(sub, wanted);
      }
      if (!user || user.provider !== wanted) {
        count("gotrue.invalid_grant");
        return jsonResponse(400, {
          error: "invalid_grant",
          error_description: "Bad ID token",
          error_code: "bad_id_token",
        });
      }
      count("gotrue.sessions");
      return jsonResponse(200, sessionFor(user));
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = parsed.pathname.slice("/rest/v1/".length);
      const who = principal(headers);
      if (table === "profiles") {
        const idFilter = parsed.searchParams.get("id") ?? "";
        const wantedId = idFilter.startsWith("eq.") ? idFilter.slice(3) : null;
        if (who.role !== "user" || !who.userId) {
          return jsonResponse(401, {
            message: "JWT expired or missing",
            code: "PGRST301",
          });
        }
        // RLS: owner rows only.
        const visible = wantedId && wantedId === who.userId
          ? state.profiles.get(wantedId)
          : undefined;
        if (method === "GET") {
          const lag = state.profileLag.get(who.userId) ?? 0;
          let row = visible;
          if (lag > 0) {
            state.profileLag.set(who.userId, lag - 1);
            row = undefined;
          }
          const accept = headers["accept"] ?? "";
          if (accept.includes("application/vnd.pgrst.object+json")) {
            if (!row) {
              return jsonResponse(406, {
                code: "PGRST116",
                message:
                  "JSON object requested, multiple (or no) rows returned",
                details: "The result contains 0 rows",
                hint: null,
              });
            }
            return jsonResponse(200, row);
          }
          return jsonResponse(200, row ? [row] : []);
        }
        if (method === "PATCH") {
          if (visible && isRecord(body)) Object.assign(visible, body);
          count("profiles.patch");
          return new Response(null, { status: 204 });
        }
      }
      if (table === "account_external_credentials") {
        if (who.role !== "service") {
          return jsonResponse(401, {
            code: "42501",
            message: "permission denied for table account_external_credentials",
          });
        }
        if (
          method === "POST" && isRecord(body) &&
          typeof body.user_id === "string"
        ) {
          state.credentials.set(body.user_id, { ...body });
          count("credentials.upsert");
          return new Response(null, { status: 201 });
        }
        return jsonResponse(400, { message: "unexpected credentials write" });
      }
      return jsonResponse(404, { message: `stress fake: no table ${table}` });
    }
    if (call.target === "apple.token") {
      const form = typeof body === "string"
        ? new URLSearchParams(body)
        : new URLSearchParams();
      const secret = form.get("client_secret") ?? "";
      if (
        form.get("client_id") !== APPLE_CLIENT_ID ||
        secret.split(".").length !== 3
      ) {
        return jsonResponse(400, { error: "invalid_client" });
      }
      const grant = state.appleCodes.get(form.get("code") ?? "");
      if (!grant || grant.spent) {
        return jsonResponse(400, { error: "invalid_grant" });
      }
      grant.spent = true;
      count("apple.grants");
      return jsonResponse(200, {
        access_token: `at-${state.prng.uuid()}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: grant.refreshToken,
        id_token: providerIdToken("apple", grant.sub),
      });
    }
    if (call.target === "revenuecat") {
      count("revenuecat.calls");
      return jsonResponse(200, {
        subscriber: { entitlements: {}, subscriptions: {} },
      });
    }
    return new Response(
      `unexpected fetch in stress harness: ${method} ${url}`,
      { status: 599 },
    );
  };

  /** Honour the caller's AbortSignal like a real fetch (cache.ts and
   * externalAccounts.ts bound their calls with one). */
  const withSignal = (
    work: Promise<Response>,
    signal: AbortSignal | null | undefined,
  ) => {
    if (!signal) return work;
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<Response>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  };

  globalThis.fetch =
    ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const signal = init?.signal ??
        (input instanceof Request ? input.signal : null);
      return withSignal(fakeFetch(input, init), signal);
    }) as typeof fetch;

  const fakeFetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
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
    seq += 1;
    const call: RecordedCall = {
      seq,
      t: Math.round((performance.now() - t0) * 100) / 100,
      target: classify(request.method, request.url, headers),
      url: request.url,
      method: request.method,
      headers,
      body,
    };
    if (state.recordCalls) state.calls.push(call);
    count(`calls.${call.target}`);
    const parsed = new URL(request.url);
    const answer = async (): Promise<Response> => {
      if (state.latencyMaxMs > 0) {
        await sleep(state.prng.int(0, state.latencyMaxMs));
      }
      const response = real(call, parsed);
      call.outcome = String(response.status);
      return response;
    };

    const armed = call.target !== "other" ? faults.get(call.target) : undefined;
    if (armed && armed.remaining > 0) {
      armed.remaining -= 1;
      armed.hits += 1;
      if (armed.remaining <= 0) faults.delete(call.target as FaultTarget);
      const spec = armed.spec;
      count(`faults.${call.target}.${spec.kind}`);
      switch (spec.kind) {
        case "http": {
          call.outcome = `fault:${spec.status}`;
          return new Response(spec.body ?? "", {
            status: spec.status,
            headers: {
              ...(spec.contentType === null
                ? {}
                : { "Content-Type": spec.contentType ?? "application/json" }),
              ...(spec.headers ?? {}),
            },
          });
        }
        case "throw":
          call.outcome = "fault:throw";
          throw new TypeError(
            spec.message ?? "error sending request for url: connection refused",
          );
        case "delay":
          call.outcome = `fault:delay${spec.ms}`;
          await sleep(spec.ms);
          return answer();
        case "hang": {
          call.outcome = "fault:hang";
          await new Promise<void>((resolve) => hangs.push(resolve));
          return answer();
        }
        case "custom":
          call.outcome = "fault:custom";
          return spec.respond(call, answer);
      }
    }
    return answer();
  };

  Deno.serve = ((...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | ((request: Request) => Promise<Response>)
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    state.handler = fn;
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

function redisLive(state: Harness, key: string): FakeRedisEntry | null {
  const entry = state.redis.get(key);
  if (!entry) return null;
  if (entry.expiresAtMs <= Date.now()) {
    state.redis.delete(key);
    return null;
  }
  return entry;
}

/** Minimal Upstash-compatible executor for the commands cache.ts issues. */
export function runRedisCommand(
  state: Harness,
  command: Array<string | number>,
): { result?: unknown; error?: string } {
  if (state.recordCalls) state.redisCommands.push(command);
  const [op, ...args] = command.map((part) => String(part));
  switch (op) {
    case "GET":
      return { result: redisLive(state, args[0])?.value ?? null };
    case "TTL": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: -2 };
      if (!Number.isFinite(entry.expiresAtMs)) return { result: -1 };
      return {
        result: Math.max(1, Math.ceil((entry.expiresAtMs - Date.now()) / 1000)),
      };
    }
    case "SET": {
      const ttl = args[2] === "EX" ? Number(args[3]) : NaN;
      state.redis.set(args[0], {
        value: args[1],
        expiresAtMs: Number.isFinite(ttl) ? Date.now() + ttl * 1000 : Infinity,
      });
      return { result: "OK" };
    }
    case "DEL": {
      let removed = 0;
      for (const key of args) if (state.redis.delete(key)) removed += 1;
      return { result: removed };
    }
    case "INCR": {
      const entry = redisLive(state, args[0]);
      const next = (entry ? Number(entry.value) : 0) + 1;
      state.redis.set(args[0], {
        value: String(next),
        expiresAtMs: entry?.expiresAtMs ?? Infinity,
      });
      return { result: next };
    }
    case "EXPIRE": {
      const entry = redisLive(state, args[0]);
      if (!entry) return { result: 0 };
      if (args[2] === "NX" && Number.isFinite(entry.expiresAtMs)) {
        return { result: 0 };
      }
      entry.expiresAtMs = Date.now() + Number(args[1]) * 1000;
      return { result: 1 };
    }
    default:
      return { error: `ERR unknown command '${op}'` };
  }
}

// ── Response classification (what the app does with the answer) ─────────────
//
// Mirrors apps/mobile/src/account/bootstrap.ts: 401/403 → `account.rejected`
// (non-retryable — the app reports the sign-in as refused), other non-2xx →
// `account.unavailable` (retryable only for 5xx/429), 2xx without a canonical
// account → `account.invalid_response`.

export type AppClass =
  | "ok"
  | "rejected(non-retryable)"
  | "unavailable(retryable)"
  | "unavailable(non-retryable)"
  | "invalid_response(retryable)";

export interface Observed {
  status: number;
  code: string | null;
  message: string | null;
  appClass: AppClass;
  requestId: string | null;
  retryAfter: string | null;
  bodyOk: boolean;
}

export async function observe(response: Response): Promise<Observed> {
  const text = await response.text();
  let payload: unknown = null;
  let bodyOk = true;
  try {
    payload = JSON.parse(text);
  } catch {
    bodyOk = false;
  }
  const error = isRecord(payload) && isRecord(payload.error)
    ? payload.error
    : null;
  const code = typeof error?.code === "string" ? error.code : null;
  const message = typeof error?.message === "string" ? error.message : null;
  let appClass: AppClass;
  if (!bodyOk) appClass = "invalid_response(retryable)";
  else if (response.ok) {
    const user = isRecord(payload) ? payload.user : null;
    const session = isRecord(payload) ? payload.session : null;
    appClass = isRecord(user) &&
        typeof user.id === "string" &&
        isRecord(session) &&
        typeof session.accessToken === "string" &&
        typeof session.refreshToken === "string" &&
        typeof session.expiresAt === "number"
      ? "ok"
      : "invalid_response(retryable)";
  } else if (response.status === 401 || response.status === 403) {
    appClass = "rejected(non-retryable)";
  } else if (response.status >= 500 || response.status === 429) {
    appClass = "unavailable(retryable)";
  } else appClass = "unavailable(non-retryable)";
  return {
    status: response.status,
    code,
    message,
    appClass,
    requestId: response.headers.get("x-request-id"),
    retryAfter: response.headers.get("Retry-After"),
    bodyOk,
  };
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-bootstrap/latest/",
    import.meta.url,
  ).pathname;
}

export async function writeReport(
  name: string,
  report: unknown,
): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

export function latencyStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted[sorted.length - 1] ?? 0,
    mean: sorted.length ? Math.round((sum / sorted.length) * 1000) / 1000 : 0,
  };
}

/** Pin Date.now() so rate-limit buckets (60 s / 300 s windows) cannot roll
 * over in the middle of a campaign; timers keep running on the real clock. */
export async function withFrozenClock<T>(fn: () => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
  }
}

/** Silence the handler's own console noise during a campaign (it logs one
 * `[api] …:` line per injected failure) while keeping the lines countable. */
export function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = {
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  const record = (level: string) => (...args: unknown[]) => {
    lines.push(
      `${level} ${
        args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(
          " ",
        )
      }`,
    );
  };
  console.error = record("error");
  console.warn = record("warn");
  console.log = record("log");
  return {
    lines,
    restore() {
      console.error = original.error;
      console.warn = original.warn;
      console.log = original.log;
    },
  };
}
