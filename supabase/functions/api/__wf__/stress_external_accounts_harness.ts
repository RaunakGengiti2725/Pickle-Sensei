// Shared plumbing for the external-account stress suites
// (stress_external_accounts_*.test.ts): seeded RNG, replayable seeds, a
// stateful per-user PostgREST model layered over routesHarness, fault
// injection at each upstream boundary (Supabase Auth / PostgREST, Apple,
// RevenueCat, Upstash) and JSON evidence written under
// artifacts/stress-edge-external-accounts/.
//
// Campaign sizes come from env so the suite stays fast by default:
//   STRESS_ITER   iterations per fault case / load requests (default small)
//   STRESS_USERS  distinct users for the L1 cache campaign
//   STRESS_SEED   base seed (default 20260905)
//   STRESS_OUT    output directory for JSON tables

import { Prng } from "./xc_concurrency_harness.ts";
import {
  encryptAppleRefreshToken,
  ExternalAccountError,
} from "../externalAccounts.ts";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  RC_URL,
  SUPABASE_URL,
  userRequest,
} from "./routesHarness.ts";

export { Prng };

export const RC_URL_PREFIX = RC_URL;
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const CREDENTIALS_TABLE = "account_external_credentials";
export const DELETION_TABLE = "account_deletion_requests";

export const BASE_SEED = Number(Deno.env.get("STRESS_SEED") ?? "20260905");
export const STRESS_ITER = Math.max(1, Number(Deno.env.get("STRESS_ITER") ?? "3"));
export const STRESS_USERS = Math.max(1, Number(Deno.env.get("STRESS_USERS") ?? "1500"));

export function seedFor(campaign: string, index: number): number {
  // FNV-1a over the campaign name mixed with the base seed and index so every
  // (campaign, index) pair is a stable, printable 31-bit seed.
  let h = 0x811c9dc5;
  for (const ch of `${campaign}:${BASE_SEED}:${index}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h & 0x7fffffff;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank];
}

export function latencyStats(samples: number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    p50_ms: round(percentile(sorted, 50)),
    p95_ms: round(percentile(sorted, 95)),
    p99_ms: round(percentile(sorted, 99)),
    max_ms: round(sorted[sorted.length - 1] ?? 0),
    mean_ms: round(sorted.length ? sum / sorted.length : 0),
  };
}

export function round(value: number, digits = 3): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function outputDir(): string {
  const fromEnv = Deno.env.get("STRESS_OUT");
  if (fromEnv) return fromEnv;
  const here = new URL(".", import.meta.url).pathname;
  return `${here}../../../../artifacts/stress-edge-external-accounts`;
}

export async function writeReport(name: string, report: unknown): Promise<string> {
  const dir = outputDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${name}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

// ── Fault vocabulary ─────────────────────────────────────────────────────────

/** How an upstream misbehaves for one call. `timeout` rejects with the same
 * AbortError the edge fn's 15s AbortController produces (the real timer is
 * exercised at module level with FakeTime in the faults suite). */
export type Fault =
  | { kind: "ok" }
  | { kind: "reject"; error?: unknown }
  | { kind: "timeout" }
  | { kind: "status"; status: number; body?: string; contentType?: string }
  | { kind: "malformed_json"; status?: number }
  | { kind: "json"; status: number; body: unknown };

export function abortError(): DOMException {
  return new DOMException("The signal has been aborted", "AbortError");
}

export function faultResponse(fault: Fault): Promise<Response> | Response {
  switch (fault.kind) {
    case "ok":
      throw new Error("faultResponse(ok) — caller must serve the healthy response");
    case "reject":
      return Promise.reject(fault.error ?? new TypeError("error sending request: connection reset"));
    case "timeout":
      return Promise.reject(abortError());
    case "status":
      return new Response(fault.body ?? null, {
        status: fault.status,
        headers: fault.contentType ? { "Content-Type": fault.contentType } : {},
      });
    case "malformed_json":
      return new Response("<html>502 Bad Gateway</html>{", {
        status: fault.status ?? 200,
        headers: { "Content-Type": "application/json" },
      });
    case "json":
      return new Response(JSON.stringify(fault.body), {
        status: fault.status,
        headers: { "Content-Type": "application/json" },
      });
  }
}

export function describeFault(fault: Fault): string {
  switch (fault.kind) {
    case "ok":
      return "ok";
    case "reject":
      return "fetch-reject";
    case "timeout":
      return "timeout(abort)";
    case "status":
      return `http-${fault.status}${fault.body ? `:${fault.body.slice(0, 24)}` : ""}`;
    case "malformed_json":
      return `malformed-json(${fault.status ?? 200})`;
    case "json":
      return `http-${fault.status}:${JSON.stringify(fault.body).slice(0, 40)}`;
  }
}

// ── Stateful upstream model over the real handler ────────────────────────────

export interface CredentialRow {
  user_id: string;
  apple_refresh_token_encrypted: string | null;
  apple_token_captured_at: string | null;
  apple_revoked_at: string | null;
  revenuecat_deleted_at: string | null;
  updated_at?: string;
}

export interface UpstreamCounters {
  supabase: number;
  supabaseAuth: number;
  postgrest: number;
  apple: number;
  revenuecat: number;
  upstash: number;
}

/** Fault schedule: `next(target)` returns the fault the next call to that
 * upstream should experience (default ok). Faults can be armed once
 * (`once`) or persistently (`always`). */
export class FaultPlan {
  private queues = new Map<string, Fault[]>();
  private persistent = new Map<string, Fault>();

  once(target: string, fault: Fault): this {
    const q = this.queues.get(target) ?? [];
    q.push(fault);
    this.queues.set(target, q);
    return this;
  }

  always(target: string, fault: Fault | null): this {
    if (fault) this.persistent.set(target, fault);
    else this.persistent.delete(target);
    return this;
  }

  clear(): void {
    this.queues.clear();
    this.persistent.clear();
  }

  next(target: string): Fault {
    const q = this.queues.get(target);
    if (q && q.length > 0) return q.shift()!;
    return this.persistent.get(target) ?? { kind: "ok" };
  }
}

export const TARGETS = {
  authSignIn: "supabase.auth.token",
  authGetUser: "supabase.auth.user",
  authDeleteUser: "supabase.auth.admin.delete",
  credentialsGet: "postgrest.credentials.get",
  credentialsWrite: "postgrest.credentials.write",
  deletionGet: "postgrest.deletion.get",
  deletionWrite: "postgrest.deletion.write",
  profilesGet: "postgrest.profiles.get",
  postgrestOther: "postgrest.other",
  appleToken: "apple.token",
  appleRevoke: "apple.revoke",
  revenuecat: "revenuecat",
  upstash: "upstash",
} as const;

export interface StatefulWorld {
  harness: Harness;
  plan: FaultPlan;
  counters: UpstreamCounters;
  /** `METHOD url` of every upstream call since the last resetCounters(). */
  calls: string[];
  credentials: Map<string, CredentialRow>;
  deletions: Map<
    string,
    { challenge: string; user_id: string; created_at: string; expires_at: string }
  >;
  deletedUsers: Set<string>;
  /** Apple authorization codes accepted exactly once (models Apple's
   * single-use grant); value = refresh token Apple hands back. */
  appleCodes: Map<string, { refreshToken: string; subject: string }>;
  appleSpentCodes: Set<string>;
  revokedAppleTokens: string[];
  revenueCatDeleted: string[];
  /** Every plaintext refresh token the fake Apple ever issued — used to
   * assert secrecy (must never reach Supabase or RevenueCat or a body). */
  issuedRefreshTokens: Set<string>;
  resetCounters(): void;
  install(): void;
  uninstall(): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eqFilter(url: URL, column: string): string | null {
  const raw = url.searchParams.get(column);
  if (!raw) return null;
  return raw.startsWith("eq.") ? raw.slice(3) : raw;
}

function decodeJwtSub(token: string): string | null {
  const segment = token.split(".")[1] ?? "";
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
    const sub = JSON.parse(atob(padded)).sub;
    return typeof sub === "string" ? sub : null;
  } catch {
    return null;
  }
}

function supabaseUser(id: string, provider: "apple" | "google") {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: `${id.slice(0, 8)}@example.com`,
    app_metadata: { provider, providers: [provider] },
    user_metadata: {},
    created_at: new Date().toISOString(),
  };
}

/** Wraps the routesHarness fetch stub with a per-user stateful model for the
 * tables the external-account routes touch, fault injection per upstream
 * and round-trip counters. Calls the harness does not model fall through
 * to routesHarness's own stub. */
export async function loadWorld(): Promise<StatefulWorld> {
  const harness = await loadHarness();
  const base = globalThis.fetch;
  const plan = new FaultPlan();
  const counters: UpstreamCounters = {
    supabase: 0,
    supabaseAuth: 0,
    postgrest: 0,
    apple: 0,
    revenuecat: 0,
    upstash: 0,
  };
  const world: StatefulWorld = {
    harness,
    plan,
    counters,
    calls: [],
    credentials: new Map(),
    deletions: new Map(),
    deletedUsers: new Set(),
    appleCodes: new Map(),
    appleSpentCodes: new Set(),
    revokedAppleTokens: [],
    revenueCatDeleted: [],
    issuedRefreshTokens: new Set(),
    resetCounters() {
      for (const key of Object.keys(counters) as (keyof UpstreamCounters)[]) counters[key] = 0;
      world.calls = [];
    },
    install() {
      globalThis.fetch = intercept as typeof fetch;
    },
    uninstall() {
      globalThis.fetch = base;
    },
  };

  const faulted = (target: string): Response | Promise<Response> | null => {
    const fault = plan.next(target);
    if (fault.kind === "ok") return null;
    return faultResponse(fault);
  };

  const intercept = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const method = request.method;
    world.calls.push(`${method} ${url}`);

    if (url.includes("upstash")) {
      counters.upstash += 1;
      return faulted(TARGETS.upstash) ?? json(200, { result: null });
    }

    if (url === APPLE_TOKEN_URL) {
      counters.apple += 1;
      const form = new URLSearchParams(await request.clone().text());
      const code = form.get("code") ?? "";
      const f = faulted(TARGETS.appleToken);
      if (f) return f;
      const grant = world.appleCodes.get(code);
      if (!grant || world.appleSpentCodes.has(code)) {
        return json(400, { error: "invalid_grant" });
      }
      world.appleSpentCodes.add(code);
      world.issuedRefreshTokens.add(grant.refreshToken);
      return json(200, {
        refresh_token: grant.refreshToken,
        id_token: fakeAppleIdToken(grant.subject),
      });
    }
    if (url === APPLE_REVOKE_URL) {
      counters.apple += 1;
      const form = new URLSearchParams(await request.clone().text());
      const f = faulted(TARGETS.appleRevoke);
      if (f) return f;
      world.revokedAppleTokens.push(form.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (url.startsWith(RC_URL)) {
      counters.revenuecat += 1;
      if (method === "DELETE") {
        const f = faulted(TARGETS.revenuecat);
        if (f) return f;
        const appUserId = decodeURIComponent(url.slice(RC_URL.length));
        world.revenueCatDeleted.push(appUserId);
        return json(200, { app_user_id: appUserId, deleted: true });
      }
      return base(input, init);
    }

    if (url.startsWith(SUPABASE_URL)) {
      counters.supabase += 1;
      if (url.startsWith(`${SUPABASE_URL}/auth/v1/token`)) {
        counters.supabaseAuth += 1;
        const f = faulted(TARGETS.authSignIn);
        if (f) return f;
        const text = await request.clone().text();
        let payload: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(text);
          if (isRecord(parsed)) payload = parsed;
        } catch {
          // fall through
        }
        const idToken = typeof payload.id_token === "string" ? payload.id_token : "";
        const provider = payload.provider === "apple" ? "apple" : "google";
        const sub = decodeJwtSub(idToken) ?? "";
        if (!sub) return json(400, { error: "invalid_grant", error_description: "bad token" });
        if (world.deletedUsers.has(sub)) {
          return json(400, { error: "invalid_grant", error_description: "user deleted" });
        }
        const expiresAt = Math.floor(Date.now() / 1000) + 3600;
        return json(200, {
          access_token: sessionTokenFor(sub),
          token_type: "bearer",
          expires_in: 3600,
          expires_at: expiresAt,
          refresh_token: `refresh-${sub}`,
          user: supabaseUser(sub, provider),
        });
      }
      if (url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
        counters.supabaseAuth += 1;
        const f = faulted(TARGETS.authGetUser);
        if (f) return f;
        const bearer = request.headers.get("authorization")?.replace(/^Bearer /i, "") ?? "";
        const sub = decodeJwtSub(bearer) ?? "";
        if (!sub || world.deletedUsers.has(sub)) {
          return json(401, { code: 401, msg: "invalid JWT" });
        }
        const provider = sub.startsWith("a") ? "apple" : "google";
        return json(200, supabaseUser(sub, provider));
      }
      if (method === "DELETE" && url.startsWith(`${SUPABASE_URL}/auth/v1/admin/users/`)) {
        counters.supabaseAuth += 1;
        const f = faulted(TARGETS.authDeleteUser);
        if (f) return f;
        const id = url.slice(`${SUPABASE_URL}/auth/v1/admin/users/`.length).split("?")[0];
        if (world.deletedUsers.has(id)) {
          return json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
        }
        world.deletedUsers.add(id);
        world.credentials.delete(id);
        world.deletions.delete(id);
        return json(200, {});
      }
      if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
        counters.postgrest += 1;
        const parsed = new URL(url);
        const table = parsed.pathname.slice("/rest/v1/".length);
        const accept = request.headers.get("accept") ?? "";
        const single = accept.includes("application/vnd.pgrst.object+json");
        const text = await request.clone().text();
        let body: unknown = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = text;
        }
        const userId = eqFilter(parsed, "user_id");

        if (table === CREDENTIALS_TABLE) {
          if (method === "GET") {
            const f = faulted(TARGETS.credentialsGet);
            if (f) return f;
            const row = userId ? world.credentials.get(userId) : undefined;
            const rows = row ? [projectRow(row, parsed.searchParams.get("select"))] : [];
            return single
              ? rows.length
                ? json(200, rows[0])
                : json(406, { code: "PGRST116", message: "0 rows", details: null, hint: null })
              : json(200, rows);
          }
          const f = faulted(TARGETS.credentialsWrite);
          if (f) return f;
          if (method === "POST" && isRecord(body)) {
            // PostgREST upsert (resolution=merge-duplicates): every payload
            // column lands in DO UPDATE, unspecified columns keep their value.
            const id = String(body.user_id ?? "");
            const existing = world.credentials.get(id) ?? emptyRow(id);
            world.credentials.set(id, { ...existing, ...(body as Partial<CredentialRow>) });
            return new Response(null, { status: 201 });
          }
          if (method === "PATCH" && isRecord(body) && userId) {
            const existing = world.credentials.get(userId);
            if (existing) {
              world.credentials.set(userId, { ...existing, ...(body as Partial<CredentialRow>) });
            }
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 204 });
        }

        if (table === DELETION_TABLE) {
          if (method === "GET") {
            const f = faulted(TARGETS.deletionGet);
            if (f) return f;
            const row = userId ? world.deletions.get(userId) : undefined;
            const rows = row ? [row] : [];
            return single
              ? rows.length
                ? json(200, rows[0])
                : json(406, { code: "PGRST116", message: "0 rows", details: null, hint: null })
              : json(200, rows);
          }
          const f = faulted(TARGETS.deletionWrite);
          if (f) return f;
          if (method === "POST" && isRecord(body)) {
            const id = String(body.user_id ?? "");
            const now = new Date().toISOString();
            const row = {
              challenge: String(body.challenge ?? crypto.randomUUID()),
              user_id: id,
              created_at: String(body.created_at ?? now),
              expires_at: String(body.expires_at ?? new Date(Date.now() + 900_000).toISOString()),
            };
            world.deletions.set(id, row);
            return json(201, [row]);
          }
          if (method === "DELETE" && userId) {
            world.deletions.delete(userId);
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 204 });
        }

        if (table === "profiles" && method === "GET") {
          const f = faulted(TARGETS.profilesGet);
          if (f) return f;
          const id = eqFilter(parsed, "id") ?? "";
          if (world.deletedUsers.has(id)) {
            return single
              ? json(406, { code: "PGRST116", message: "0 rows", details: null, hint: null })
              : json(200, []);
          }
          const provider = id.startsWith("a") ? "apple" : "google";
          const row = {
            id,
            email: `${id.slice(0, 8)}@example.com`,
            onboarding_state: "completed",
            provider,
            skill_level: null,
            handedness: null,
            primary_goal: null,
            biggest_problem: null,
            focus_checkpoint: null,
            first_name: null,
            gender: null,
          };
          return single ? json(200, row) : json(200, [row]);
        }

        const f = faulted(TARGETS.postgrestOther);
        if (f) return f;
      }
    }
    return base(input, init);
  };

  world.install();
  return world;
}

function emptyRow(userId: string): CredentialRow {
  return {
    user_id: userId,
    apple_refresh_token_encrypted: null,
    apple_token_captured_at: null,
    apple_revoked_at: null,
    revenuecat_deleted_at: null,
  };
}

function projectRow(row: CredentialRow, select: string | null): Record<string, unknown> {
  if (!select || select === "*") return { ...row };
  const out: Record<string, unknown> = {};
  for (const col of select.split(",").map((s) => s.trim())) {
    if (col in row) out[col] = (row as unknown as Record<string, unknown>)[col];
  }
  return out;
}

// ── Users, tokens, requests ──────────────────────────────────────────────────

/** Apple users start with "a", Google users with "b"-"f" so the fake Auth
 * can derive the provider from the id alone (mirrors app_metadata.provider). */
export function userIdFor(rng: Prng, provider: "apple" | "google"): string {
  const id = rng.uuid();
  const first = provider === "apple" ? "a" : "b";
  return first + id.slice(1);
}

export function ipFor(rng: Prng, pool = 256): string {
  const n = rng.int(0, pool - 1);
  return `198.51.${Math.floor(n / 256) + 1}.${n % 256}`;
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A Supabase-issued access token as `authenticate()` recognizes it: issuer
 * ends in /auth/v1, carries sub + session_id + exp. Verification is the
 * fake GoTrue's job. The token is a pure function of (user, session) — `exp`
 * is fixed per process — so a revisit bears the SAME bearer a real client
 * would reuse (the auth cache is keyed by token hash). */
const SESSION_EXP = Math.floor(Date.now() / 1000) + 6 * 3600;
export function sessionTokenFor(userId: string, sessionId = `sess-${userId}`): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub: userId,
      session_id: sessionId,
      role: "authenticated",
      exp: SESSION_EXP,
    }),
  );
  return `${header}.${payload}.sig`;
}

export interface AppleUser {
  id: string;
  ip: string;
  idToken: string;
  code: string;
  refreshToken: string;
}

export function mintAppleUser(world: StatefulWorld, rng: Prng): AppleUser {
  const id = userIdFor(rng, "apple");
  const code = `c_${rng.uuid().replace(/-/g, "")}`;
  const refreshToken = `rt_${rng.uuid().replace(/-/g, "")}${rng.uuid().replace(/-/g, "")}`;
  world.appleCodes.set(code, { refreshToken, subject: id });
  return { id, ip: ipFor(rng), idToken: fakeAppleIdToken(id), code, refreshToken };
}

export function bootstrapRequest(
  user: AppleUser,
  options: { code?: string | null | unknown; protocol?: boolean; ip?: string } = {},
): Request {
  const body: Record<string, unknown> = {};
  const code = options.code === undefined ? user.code : options.code;
  if (code !== null) body.appleAuthorizationCode = code;
  return userRequest("POST", "/v1/account/bootstrap", {
    token: user.idToken,
    ip: options.ip ?? user.ip,
    body,
    headers: options.protocol === false ? {} : { "X-Apple-Revocation-Protocol": "1" },
  });
}

export function googleBootstrapRequest(userId: string, ip: string): Request {
  return userRequest("POST", "/v1/account/bootstrap", {
    token: fakeGoogleIdToken(userId),
    ip,
    body: {},
  });
}

/** Seeds a challenge old enough to confirm (min age 3s) directly in the
 * stateful table so delete-confirm can be exercised without sleeping. */
export function seedDeletionChallenge(world: StatefulWorld, userId: string, rng: Prng): string {
  const challenge = rng.uuid();
  const created = new Date(Date.now() - 10_000).toISOString();
  world.deletions.set(userId, {
    challenge,
    user_id: userId,
    created_at: created,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  });
  return challenge;
}

export function deleteConfirmRequest(userId: string, ip: string, challenge: string): Request {
  return userRequest("POST", "/v1/me/delete-confirm", {
    token: sessionTokenFor(userId),
    ip,
    body: { challenge },
  });
}

export async function storeAppleCredential(
  world: StatefulWorld,
  userId: string,
  refreshToken: string,
  overrides: Partial<CredentialRow> = {},
): Promise<CredentialRow> {
  const encrypted = await encryptAppleRefreshToken(
    refreshToken,
    userId,
    world.harness.appleTokenEncryptionKey,
  );
  const now = new Date().toISOString();
  const row: CredentialRow = {
    user_id: userId,
    apple_refresh_token_encrypted: encrypted,
    apple_token_captured_at: now,
    apple_revoked_at: null,
    revenuecat_deleted_at: null,
    updated_at: now,
    ...overrides,
  };
  world.credentials.set(userId, row);
  world.issuedRefreshTokens.add(refreshToken);
  return row;
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _raw: parsed };
  } catch {
    return { _raw: text };
  }
}

/** Client-visible error class — what the mobile app can act on. */
export type ErrorClass =
  | "ok"
  | "coded_4xx"
  | "generic_4xx"
  | "retryable_503"
  | "rate_limited_429"
  | "other_5xx"
  | "unexpected";

export function classify(status: number, body: Record<string, unknown>): ErrorClass {
  if (status >= 200 && status < 300) return "ok";
  if (status === 429) return "rate_limited_429";
  if (status === 503) return "retryable_503";
  if (status >= 500) return "other_5xx";
  if (status >= 400) return typeof body.code === "string" ? "coded_4xx" : "generic_4xx";
  return "unexpected";
}

const LEAK_MARKERS = [
  CREDENTIALS_TABLE,
  "PGRST",
  "postgres",
  "supabase.test",
  "revenuecat.com",
  "appleid.apple.com",
  "connection reset",
  "stack",
  "TypeError",
  "AbortError",
];

/** 5xx bodies must be generic: no table names, upstream hosts, PostgREST
 * codes, exception names or the injected fault text. Returns the offending
 * marker or null. */
export function leakMarker(bodyText: string, extra: string[] = []): string | null {
  const lowered = bodyText.toLowerCase();
  for (const marker of [...LEAK_MARKERS, ...extra]) {
    if (marker && lowered.includes(marker.toLowerCase())) return marker;
  }
  return null;
}

export function errorKind(error: unknown): string {
  if (error instanceof ExternalAccountError) return error.kind;
  if (error instanceof Error) return `Error:${error.name}`;
  return typeof error;
}
