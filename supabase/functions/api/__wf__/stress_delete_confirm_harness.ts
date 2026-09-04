/**
 * stress-route-post-v1-me-delete-confirm — in-process world for the
 * CONCURRENCY lens on `POST /v1/me/delete-confirm`.
 *
 * Loads the REAL handler from ../index.ts (Deno.serve captured) over the
 * xc FakeSupabase model (sessions, refresh rotation, logout, PostgREST with
 * RLS scoping, seeded upstream latency) and adds everything the delete-confirm
 * route reaches that the shared model does not cover:
 *
 *   - GoTrue `DELETE /auth/v1/admin/users/:id` (service role) with the
 *     auth.users → profiles → every-user-table CASCADE, the user's sessions
 *     dying with it (getUser → 403) and `404 user_not_found` on replay;
 *   - `public.account_deletion_requests` (RLS: owner only);
 *   - `public.account_external_credentials` FK `user_id → profiles(id)`:
 *     an INSERT/upsert for a user whose cascade already ran is refused with
 *     23503 (PostgREST → HTTP 409), exactly what the hosted database does;
 *   - RevenueCat `DELETE /v1/subscribers/:id` (200 first, 404 once gone) and
 *     Apple `POST /auth/revoke` (idempotent 200, or `invalid_grant` on a
 *     replayed token when `appleReplayMode = "invalid_grant"`);
 *   - seeded fault queues for Apple / RevenueCat / GoTrue admin so transient
 *     upstream failures can be injected at exact positions.
 *
 * Every upstream interaction is counted PER USER so a burst of duplicates can
 * be checked for "exactly the side effects of the 200s, nothing more".
 */
import {
  edgeRequest,
  FakeSupabase,
  isRecord,
  type Prng,
  RC_URL,
  readJson,
  sleep,
  SUPABASE_URL,
} from "./xc_concurrency_harness.ts";
import { encryptAppleRefreshToken } from "../externalAccounts.ts";

// Must equal the private constants in xc_concurrency_harness.ts — the model's
// principal() compares bearers against them. loadDeleteConfirmWorld() probes
// that agreement at startup so a drift fails loudly instead of silently
// turning the service role into `anon`.
const ANON_KEY = "xc-anon-key";
const SERVICE_ROLE_KEY = "xc-service-role-key";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";

export type AppleReplayMode = "idempotent" | "invalid_grant";

export interface UpstreamCall {
  t: number;
  method: string;
  url: string;
  status: number;
  userId: string | null;
}

export interface PerUserCounters {
  adminDelete: number;
  adminDeleteOk: number;
  adminDelete404: number;
  rcDelete: number;
  rcDeleteOk: number;
  rcDelete404: number;
  appleRevoke: number;
  appleRevokeOk: number;
  appleRevokeInvalidGrant: number;
  fkViolations: number;
  getUser: number;
}

export class DeleteConfirmWorld {
  fake: FakeSupabase;
  appleReplayMode: AppleReplayMode = "idempotent";
  /** HTTP statuses to answer (in order) before the normal behaviour resumes. */
  faults: { apple: number[]; rc: number[]; admin: number[] } = { apple: [], rc: [], admin: [] };
  rcCustomers = new Set<string>();
  revokedAppleTokens = new Set<string>();
  appleTokenOwner = new Map<string, string>();
  perUser = new Map<string, PerUserCounters>();
  calls: UpstreamCall[] = [];
  private t0 = performance.now();

  constructor(fake: FakeSupabase, public readonly appleTokenEncryptionKey: string) {
    this.fake = fake;
    this.fake.tables.account_deletion_requests = [];
  }

  reset(seed: number, latencyMaxMs: number): void {
    this.fake.reset(seed, latencyMaxMs);
    this.appleReplayMode = "idempotent";
    this.faults = { apple: [], rc: [], admin: [] };
    this.rcCustomers.clear();
    this.revokedAppleTokens.clear();
    this.appleTokenOwner.clear();
    this.perUser.clear();
    this.calls = [];
    this.t0 = performance.now();
  }

  counters(userId: string): PerUserCounters {
    let c = this.perUser.get(userId);
    if (!c) {
      c = {
        adminDelete: 0,
        adminDeleteOk: 0,
        adminDelete404: 0,
        rcDelete: 0,
        rcDeleteOk: 0,
        rcDelete404: 0,
        appleRevoke: 0,
        appleRevokeOk: 0,
        appleRevokeInvalidGrant: 0,
        fkViolations: 0,
        getUser: 0,
      };
      this.perUser.set(userId, c);
    }
    return c;
  }

  private async latency(): Promise<void> {
    if (this.fake.latencyMaxMs > 0) await sleep(this.fake.prng.int(0, this.fake.latencyMaxMs));
  }

  /** Rows of every modelled table that still reference `userId` — after a
   * successful deletion this must be empty (the cascade + no late writes). */
  orphanRows(userId: string): Array<{ table: string; row: Record<string, unknown> }> {
    const out: Array<{ table: string; row: Record<string, unknown> }> = [];
    for (const [table, rows] of Object.entries(this.fake.tables)) {
      const ownerCol = table === "profiles" ? "id" : "user_id";
      for (const row of rows) if (row[ownerCol] === userId) out.push({ table, row });
    }
    return out;
  }

  userExists(userId: string): boolean {
    return this.fake.users.has(userId);
  }

  /** GoTrue admin deleteUser: auth.users row goes, the cascade takes every
   * user table, and every session of the user is dead from now on. */
  private cascadeDelete(userId: string): void {
    this.fake.users.delete(userId);
    for (const table of Object.keys(this.fake.tables)) {
      const ownerCol = table === "profiles" ? "id" : "user_id";
      this.fake.tables[table] = this.fake.tables[table].filter((r) => r[ownerCol] !== userId);
    }
    for (const session of this.fake.sessions.values()) {
      if (session.userId === userId) session.revoked = true;
    }
    this.fake.log("gotrue.admin.delete", `user=${userId} cascaded`);
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private userOfBearer(request: Request): string | null {
    const auth = request.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || token === ANON_KEY || token === SERVICE_ROLE_KEY) return null;
    const sid = this.fake.accessIndex.get(token);
    return sid ? (this.fake.sessions.get(sid)?.userId ?? null) : null;
  }

  async dispatch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    let userId: string | null = null;
    const response = await this.route(request, url, rawBody, (id) => (userId = id));
    this.calls.push({
      t: Math.round((performance.now() - this.t0) * 100) / 100,
      method: request.method,
      url: request.url,
      status: response.status,
      userId,
    });
    return response;
  }

  private async route(
    request: Request,
    url: URL,
    rawBody: string,
    tag: (userId: string) => void,
  ): Promise<Response> {
    // Apple token revocation (form-encoded: token=…&client_id=…&client_secret=…)
    if (request.url === APPLE_REVOKE_URL && request.method === "POST") {
      const form = new URLSearchParams(rawBody);
      const token = form.get("token") ?? "";
      const owner = this.appleTokenOwner.get(token) ?? "unknown";
      tag(owner);
      const c = this.counters(owner);
      c.appleRevoke += 1;
      await this.latency();
      const fault = this.faults.apple.shift();
      if (fault !== undefined) {
        this.fake.log("apple.revoke", `user=${owner} → injected ${fault}`);
        return fault === 400
          ? this.json(400, { error: "invalid_grant" })
          : new Response("apple upstream fault", { status: fault });
      }
      if (this.appleReplayMode === "invalid_grant" && this.revokedAppleTokens.has(token)) {
        c.appleRevokeInvalidGrant += 1;
        this.fake.log("apple.revoke", `user=${owner} → 400 invalid_grant (already revoked)`);
        return this.json(400, { error: "invalid_grant" });
      }
      this.revokedAppleTokens.add(token);
      c.appleRevokeOk += 1;
      this.fake.log("apple.revoke", `user=${owner} → 200`);
      return new Response(null, { status: 200 });
    }

    // RevenueCat customer deletion
    if (request.url.startsWith(RC_URL) && request.method === "DELETE") {
      const id = decodeURIComponent(request.url.slice(RC_URL.length));
      tag(id);
      const c = this.counters(id);
      c.rcDelete += 1;
      await this.latency();
      const fault = this.faults.rc.shift();
      if (fault !== undefined) {
        this.fake.log("rc.delete", `user=${id} → injected ${fault}`);
        return new Response("revenuecat upstream fault", { status: fault });
      }
      if (this.rcCustomers.delete(id)) {
        c.rcDeleteOk += 1;
        this.fake.log("rc.delete", `user=${id} → 200`);
        return this.json(200, { app_user_id: id, deleted: [id] });
      }
      c.rcDelete404 += 1;
      this.fake.log("rc.delete", `user=${id} → 404`);
      return this.json(404, { code: 7259, message: "Subscriber not found" });
    }

    // GoTrue admin deleteUser
    if (
      url.origin === SUPABASE_URL &&
      url.pathname.startsWith("/auth/v1/admin/users/") &&
      request.method === "DELETE"
    ) {
      const id = decodeURIComponent(url.pathname.slice("/auth/v1/admin/users/".length));
      tag(id);
      const auth = request.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) {
        return this.json(401, { code: 401, msg: "admin endpoint requires the service role" });
      }
      const c = this.counters(id);
      c.adminDelete += 1;
      await this.latency();
      const fault = this.faults.admin.shift();
      if (fault !== undefined) {
        this.fake.log("gotrue.admin.delete", `user=${id} → injected ${fault}`);
        return this.json(fault, { code: fault, msg: "injected fault" });
      }
      if (!this.fake.users.has(id)) {
        c.adminDelete404 += 1;
        this.fake.log("gotrue.admin.delete", `user=${id} → 404 user_not_found`);
        return this.json(404, { code: 404, error_code: "user_not_found", msg: "User not found" });
      }
      this.cascadeDelete(id);
      c.adminDeleteOk += 1;
      return this.json(200, {});
    }

    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      const owner = this.userOfBearer(request);
      if (owner) {
        tag(owner);
        this.counters(owner).getUser += 1;
      }
    }

    // INSERT / upsert into the two deletion tables, whose user_id has an FK to
    // profiles(id). Postgres checks the FK and writes the row in ONE
    // statement (the parent row is KEY SHARE locked), so the check and the
    // write happen here without an await between them: either the profile is
    // still there and the row lands (to be cascaded later), or the cascade
    // already ran and the statement fails with 23503 (PostgREST → 409). A
    // row for a deleted user can never exist, exactly as on the hosted DB.
    if (
      url.origin === SUPABASE_URL &&
      request.method === "POST" &&
      (url.pathname === "/rest/v1/account_external_credentials" ||
        url.pathname === "/rest/v1/account_deletion_requests")
    ) {
      const table = url.pathname.slice("/rest/v1/".length);
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = null;
      }
      const rows = (Array.isArray(parsed) ? parsed : [parsed]).filter(isRecord);
      const who = this.fake.principal(request.headers);
      if (who.userId) tag(who.userId);
      const prefer = request.headers.get("prefer") ?? "";
      const conflictCol = url.searchParams.get("on_conflict");
      this.fake.count(`rest.post.${table}`);
      await this.latency();
      for (const row of rows) {
        const owner = typeof row.user_id === "string" ? row.user_id : null;
        if (owner) tag(owner);
        if (who.role === "anon") {
          return this.json(401, { code: "42501", message: "permission denied" });
        }
        if (who.role === "user" && owner !== who.userId) {
          return this.json(403, { code: "42501", message: "rls: new row violates policy" });
        }
        if (owner && !this.fake.users.has(owner)) {
          this.counters(owner).fkViolations += 1;
          this.fake.log(`rest.insert.${table}`, `user=${owner} → 23503 (profile gone)`);
          return this.json(409, {
            code: "23503",
            details: `Key (user_id)=(${owner}) is not present in table "profiles".`,
            hint: null,
            message: `insert or update on table "${table}" violates foreign key constraint`,
          });
        }
        const existing = conflictCol
          ? this.fake.tables[table].find((r) => r[conflictCol] === row[conflictCol])
          : undefined;
        if (existing) {
          if (prefer.includes("resolution=ignore-duplicates")) continue;
          if (prefer.includes("resolution=merge-duplicates")) {
            Object.assign(existing, row);
            this.fake.log(`rest.upsert.${table}`, `merged user=${owner}`);
            continue;
          }
          return this.json(409, { code: "23505", message: "duplicate key value" });
        }
        this.fake.tables[table].push({ ...row });
        this.fake.log(`rest.insert.${table}`, `user=${owner}`);
      }
      return prefer.includes("return=representation")
        ? this.json(201, rows)
        : new Response(null, { status: 201 });
    }
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const who = this.fake.principal(request.headers);
      if (who.userId) tag(who.userId);
      else {
        const eq = url.searchParams.get("user_id");
        if (eq?.startsWith("eq.")) tag(eq.slice(3));
      }
    }
    return this.fake.handleFetch(request, rawBody);
  }
}

export interface DeleteConfirmHarness {
  handler: (request: Request) => Promise<Response>;
  world: DeleteConfirmWorld;
}

let loaded: DeleteConfirmHarness | null = null;

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
  const encoded = bytesToBase64(pkcs8).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`;
}

export async function loadDeleteConfirmWorld(): Promise<DeleteConfirmHarness> {
  if (loaded) return loaded;
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  const appleTokenEncryptionKey = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", "com.picklesensei");
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", "TEAMID1234");
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", "KEYID12345");
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", await testApplePrivateKeyPem());
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", appleTokenEncryptionKey);
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new FakeSupabase(1, 0);
  const service = fake.principal(new Headers({ authorization: `Bearer ${SERVICE_ROLE_KEY}` }));
  if (service.role !== "service") {
    throw new Error(
      "stress harness: SERVICE_ROLE_KEY no longer matches xc_concurrency_harness.ts — update the constant",
    );
  }
  const world = new DeleteConfirmWorld(fake, appleTokenEncryptionKey);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return world.dispatch(request, rawBody);
  }) as typeof fetch;

  let handler: DeleteConfirmHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      | DeleteConfirmHarness["handler"]
      | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, world };
  return loaded;
}

// ── Scenario building blocks ─────────────────────────────────────────────────

export interface Actor {
  userId: string;
  provider: "google" | "apple";
  accessToken: string;
  refreshToken: string;
  sessionId: string;
  challenge: string;
}

export interface ActorOptions {
  provider?: "google" | "apple";
  /** apple only: store an encrypted refresh token (the post-2026-09-02 shape) */
  appleToken?: boolean;
  /** age of the pending deletion request in ms (must be ≥ 3 000 to pass the
   * min-age gate; negative = created in the future, i.e. clock skew) */
  requestAgeMs?: number;
  /** override the expiry offset from created_at (default 15 min) */
  ttlMs?: number;
  /** no pending row at all */
  withoutRequest?: boolean;
}

/** A signed-in user with an RC customer, optional Apple credential row and a
 * pending deletion challenge — written straight into the model (the real
 * delete-request route would force a 3 s wait per iteration). */
export async function mintActor(
  world: DeleteConfirmWorld,
  prng: Prng,
  options: ActorOptions = {},
): Promise<Actor> {
  const provider = options.provider ?? "google";
  const userId = prng.uuid();
  world.fake.ensureUser(userId, provider);
  const session = world.fake.mintSession(userId, provider);
  world.rcCustomers.add(userId);
  if (provider === "apple" && options.appleToken) {
    const plain = `apple-rt-${userId}`;
    world.appleTokenOwner.set(plain, userId);
    world.fake.tables.account_external_credentials.push({
      user_id: userId,
      apple_refresh_token_encrypted: await encryptAppleRefreshToken(
        plain,
        userId,
        world.appleTokenEncryptionKey,
      ),
      apple_token_captured_at: new Date(Date.now() - 86_400_000).toISOString(),
      apple_revoked_at: null,
      revenuecat_deleted_at: null,
      created_at: new Date(Date.now() - 86_400_000).toISOString(),
      updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
  }
  const challenge = prng.uuid();
  if (!options.withoutRequest) {
    const ageMs = options.requestAgeMs ?? 10_000;
    const createdAt = Date.now() - ageMs;
    world.fake.tables.account_deletion_requests.push({
      user_id: userId,
      challenge,
      created_at: new Date(createdAt).toISOString(),
      expires_at: new Date(createdAt + (options.ttlMs ?? 15 * 60_000)).toISOString(),
    });
  }
  return {
    userId,
    provider,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    sessionId: session.sessionId,
    challenge,
  };
}

export interface Answer {
  op: string;
  status: number;
  code: string | null;
  body: Record<string, unknown>;
  ms: number;
  timedOut: boolean;
}

/** Run one edge request with a hard deadline (a deadlock shows up as a
 * `timedOut` answer with status 0, never as a hung test). */
export async function timedCall(
  h: DeleteConfirmHarness,
  op: string,
  request: Request,
  deadlineMs: number,
): Promise<Answer> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });
  try {
    const outcome = await Promise.race([h.handler(request), deadline]);
    const ms = Math.round((performance.now() - t0) * 100) / 100;
    if (outcome === "timeout") {
      return { op, status: 0, code: "harness.deadline", body: {}, ms, timedOut: true };
    }
    const body = await readJson(outcome);
    const error = isRecord(body.error) ? body.error : null;
    return {
      op,
      status: outcome.status,
      code: error && typeof error.code === "string" ? error.code : null,
      body,
      ms,
      timedOut: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function confirmRequest(actor: Actor, ip: string, challenge = actor.challenge): Request {
  return edgeRequest("POST", "/v1/me/delete-confirm", {
    token: actor.accessToken,
    ip,
    body: { challenge },
  });
}

export function requestDeletionRequest(actor: Actor, ip: string): Request {
  return edgeRequest("POST", "/v1/me/delete-request", { token: actor.accessToken, ip, body: {} });
}

export function logoutRequest(actor: Actor, ip: string): Request {
  return edgeRequest("POST", "/v1/auth/logout", { token: actor.accessToken, ip });
}

export function refreshRequest(actor: Actor, ip: string): Request {
  return edgeRequest("POST", "/v1/auth/refresh", {
    ip,
    body: { refreshToken: actor.refreshToken },
  });
}

export function accessProbe(token: string, ip: string): Request {
  return edgeRequest("GET", "/v1/me/access", { token, ip });
}
