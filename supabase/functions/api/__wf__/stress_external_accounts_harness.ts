/**
 * stress_external_accounts — CONCURRENCY lens harness for
 * supabase/functions/api/externalAccounts.ts (Apple credential storage,
 * revocation, RevenueCat deletion) and the two routes that drive it
 * (POST /v1/account/bootstrap, POST /v1/me/delete-confirm).
 *
 * The REAL edge handler is loaded in-process (Deno.serve captured, exactly
 * like xc_concurrency_harness.ts). Every upstream is a STATEFUL fake driven
 * by a seeded PRNG so each interleaving is replayable from its seed:
 *
 *  - Apple ID (appleid.apple.com/auth/token + /auth/revoke): verifies the
 *    ES256 client_secret with the public half of the harness key, enforces
 *    iat/exp against ITS clock (skew tolerance), one-use authorization codes,
 *    a refresh-token registry with revoked flags (revoke is idempotent, an
 *    unknown token is invalid_grant), per-call fault injection.
 *  - RevenueCat DELETE /v1/subscribers/:id: subscriber registry (200 then
 *    404), per-call fault injection.
 *  - GoTrue admin DELETE /auth/v1/admin/users/:id: deletes the user, revokes
 *    every session, cascades the user's rows (profiles(id) and every
 *    user_id table) — the auth.users FK cascade; 404 user_not_found after.
 *  - Everything else (GoTrue id_token/getUser/logout, PostgREST tables with
 *    upsert merge/ignore semantics) is the shared FakeSupabase model.
 *
 * Scale knobs (all env, small defaults so the file lives in `deno task test`):
 *   STRESS_SEED      base seed (default 20260904)
 *   STRESS_ITER      rounds per scenario (default 4) — the campaign uses ≥ 60
 *   STRESS_BURST     concurrent lanes per round (default 6)
 *   STRESS_LATENCY_MS max seeded upstream latency per call (default 8)
 *   STRESS_OUT_DIR   where <scenario>.json reports go
 */
import { FakeSupabase, Prng, sleep, SUPABASE_URL } from "./xc_concurrency_harness.ts";
import type { Invariant, TimelineEntry } from "./xc_concurrency_harness.ts";

export { Prng, sleep };

/** Must equal the (unexported) keys FakeSupabase.principal() recognises. */
export const ANON_KEY = "xc-anon-key";
export const SERVICE_ROLE_KEY = "xc-service-role-key";
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
export const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const APPLE_CLIENT_ID = "com.picklesensei";
export const APPLE_TEAM_ID = "TEAMSTRESS";
export const APPLE_KEY_ID = "KEYSTRESS1";
/** Apple's tolerance for our client_secret clock, as modelled here. */
export const APPLE_SKEW_TOLERANCE_S = 60;

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ITER = envInt("STRESS_ITER", 4);
export const STRESS_BURST = envInt("STRESS_BURST", 6);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);

export const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
export const b64urlText = (value: string): string => b64url(new TextEncoder().encode(value));

export function b64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function jwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64urlDecode(segment)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Syntactically valid provider ID token (issuer routing only — verification
 * is the fake GoTrue's job). */
export function fakeIdToken(provider: "apple" | "google", sub: string): string {
  const header = b64urlText(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlText(
    JSON.stringify({
      iss: provider === "apple" ? "https://appleid.apple.com" : "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  );
  return `${header}.${payload}.sig`;
}

// ── Apple signing key (ES256) ────────────────────────────────────────────────

export interface AppleKeyMaterial {
  privateKeyPem: string;
  publicKey: CryptoKey;
}

export async function generateAppleKeyMaterial(): Promise<AppleKeyMaterial> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const encoded =
    btoa(String.fromCharCode(...pkcs8))
      .match(/.{1,64}/g)
      ?.join("\n") ?? "";
  return {
    privateKeyPem: `-----BEGIN PRIVATE KEY-----\n${encoded}\n-----END PRIVATE KEY-----`,
    publicKey: pair.publicKey,
  };
}

export function randomEncryptionKey(prng?: Prng): string {
  const bytes = new Uint8Array(32);
  if (prng) for (let i = 0; i < 32; i++) bytes[i] = prng.int(0, 255);
  else crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export interface AppleConfig {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  tokenEncryptionKey: string;
}

// ── Stateful Apple / RevenueCat world ────────────────────────────────────────

export type AppleFault =
  | { kind: "status"; status: number; body?: unknown }
  | { kind: "throw" }
  | { kind: "hang_body" }
  | { kind: "delay"; ms: number };

export interface AppleWorldOptions {
  /** Apple's own clock; defaults to the real clock. */
  now?: () => number;
  /** Per-call fault decision for the token endpoint (null → normal). */
  tokenFault?: (ctx: { call: number; code: string }) => AppleFault | null;
  /** Per-call fault decision for the revoke endpoint (null → normal). */
  revokeFault?: (ctx: { call: number; token: string }) => AppleFault | null;
}

export interface AppleGrant {
  refreshToken: string;
  subject: string;
  code: string;
  issuedAtCall: number;
  /** performance.now() when Apple issued it (same clock as adminDeletes[].t). */
  issuedAt: number;
  revoked: boolean;
  revokedAtCall: number | null;
}

/** Apple's server, as far as externalAccounts.ts can observe it. */
export class AppleWorld {
  codes = new Map<string, { subject: string; used: boolean }>();
  grants = new Map<string, AppleGrant>();
  tokenCalls = 0;
  revokeCalls = 0;
  /** client_secret checks that failed and why */
  secretRejections: string[] = [];
  timeline: TimelineEntry[] = [];
  private t0 = performance.now();
  private issued = 0;

  constructor(
    readonly key: AppleKeyMaterial,
    readonly prng: Prng,
    readonly opts: AppleWorldOptions = {},
  ) {}

  log(op: string, detail: string): void {
    this.timeline.push({ t: Math.round((performance.now() - this.t0) * 100) / 100, op, detail });
  }

  now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  /** Mint a one-use authorization code bound to a subject. */
  issueCode(subject: string): string {
    const code = `c${this.prng.uuid().slice(0, 8)}.${this.codes.size}`;
    this.codes.set(code, { subject, used: false });
    return code;
  }

  liveGrantsFor(subject: string): AppleGrant[] {
    return [...this.grants.values()].filter((g) => g.subject === subject && !g.revoked);
  }

  private async verifyClientSecret(secret: string): Promise<string | null> {
    const [h, p, s, extra] = secret.split(".");
    if (!h || !p || !s || extra !== undefined) return "malformed";
    const header = jwtPayload(`x.${h}.x`);
    const payload = jwtPayload(secret);
    if (!header || header.alg !== "ES256" || header.kid !== APPLE_KEY_ID) return "header";
    if (
      !payload ||
      payload.iss !== APPLE_TEAM_ID ||
      payload.sub !== APPLE_CLIENT_ID ||
      payload.aud !== "https://appleid.apple.com"
    ) {
      return "claims";
    }
    const iat = Number(payload.iat);
    const exp = Number(payload.exp);
    const nowS = Math.floor(this.now() / 1000);
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return "times";
    if (iat > nowS + APPLE_SKEW_TOLERANCE_S) return `iat_in_future(${iat - nowS}s)`;
    if (exp < nowS - APPLE_SKEW_TOLERANCE_S) return `expired(${nowS - exp}s)`;
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      this.key.publicKey,
      b64urlDecode(s),
      new TextEncoder().encode(`${h}.${p}`),
    );
    return ok ? null : "signature";
  }

  private async applyFault(fault: AppleFault | null): Promise<Response | null> {
    if (!fault) return null;
    if (fault.kind === "delay") {
      await sleep(fault.ms);
      return null;
    }
    if (fault.kind === "throw") throw new TypeError("stress: simulated Apple network failure");
    if (fault.kind === "hang_body") {
      return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(fault.body === undefined ? "" : JSON.stringify(fault.body), {
      status: fault.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  async handle(request: Request, rawBody: string): Promise<Response> {
    const form = new URLSearchParams(rawBody);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    const secretProblem = await this.verifyClientSecret(form.get("client_secret") ?? "");
    if (request.url === APPLE_TOKEN_URL) {
      this.tokenCalls += 1;
      const call = this.tokenCalls;
      const code = form.get("code") ?? "";
      const faulted = await this.applyFault(this.opts.tokenFault?.({ call, code }) ?? null);
      if (faulted) {
        this.log("apple.token", `#${call} code=${code} → fault ${faulted.status}`);
        return faulted;
      }
      if (secretProblem || form.get("client_id") !== APPLE_CLIENT_ID) {
        this.secretRejections.push(secretProblem ?? "client_id");
        this.log("apple.token", `#${call} → 400 invalid_client (${secretProblem})`);
        return json(400, { error: "invalid_client" });
      }
      if (form.get("grant_type") !== "authorization_code") {
        return json(400, { error: "unsupported_grant_type" });
      }
      const entry = this.codes.get(code);
      // Apple: a code is single-use and expires after 5 minutes. The second
      // exchange of the same code is invalid_grant.
      if (!entry || entry.used) {
        this.log(
          "apple.token",
          `#${call} code=${code} → 400 invalid_grant (${entry ? "reused" : "unknown"})`,
        );
        return json(400, { error: "invalid_grant" });
      }
      entry.used = true;
      this.issued += 1;
      const refreshToken = `rt.${this.issued}.${this.prng.uuid().slice(0, 12)}`;
      this.grants.set(refreshToken, {
        refreshToken,
        subject: entry.subject,
        code,
        issuedAtCall: call,
        issuedAt: performance.now(),
        revoked: false,
        revokedAtCall: null,
      });
      const idToken = `${b64urlText(JSON.stringify({ alg: "RS256", kid: "apple" }))}.${b64urlText(
        JSON.stringify({
          iss: "https://appleid.apple.com",
          sub: entry.subject,
          aud: APPLE_CLIENT_ID,
        }),
      )}.sig`;
      this.log("apple.token", `#${call} code=${code} → 200 ${refreshToken}`);
      return json(200, {
        access_token: `at.${this.issued}`,
        token_type: "Bearer",
        expires_in: 3600,
        refresh_token: refreshToken,
        id_token: idToken,
      });
    }
    if (request.url === APPLE_REVOKE_URL) {
      this.revokeCalls += 1;
      const call = this.revokeCalls;
      const token = form.get("token") ?? "";
      const faulted = await this.applyFault(this.opts.revokeFault?.({ call, token }) ?? null);
      if (faulted) {
        this.log("apple.revoke", `#${call} token=${token} → fault ${faulted.status}`);
        return faulted;
      }
      if (secretProblem || form.get("client_id") !== APPLE_CLIENT_ID) {
        this.secretRejections.push(secretProblem ?? "client_id");
        this.log("apple.revoke", `#${call} → 400 invalid_client (${secretProblem})`);
        return json(400, { error: "invalid_client" });
      }
      const grant = this.grants.get(token);
      if (!grant) {
        this.log("apple.revoke", `#${call} token=${token} → 400 invalid_grant (unknown)`);
        return json(400, { error: "invalid_grant" });
      }
      // Idempotent: revoking an already-revoked token is 200.
      if (!grant.revoked) {
        grant.revoked = true;
        grant.revokedAtCall = call;
      }
      this.log(
        "apple.revoke",
        `#${call} token=${token} → 200 (${grant.revokedAtCall === call ? "revoked" : "already"})`,
      );
      return new Response(null, { status: 200 });
    }
    return new Response("stress: unknown Apple path", { status: 599 });
  }
}

export interface RevenueCatWorldOptions {
  deleteFault?: (ctx: { call: number; appUserId: string }) => AppleFault | null;
}

export class RevenueCatWorld {
  subscribers = new Set<string>();
  deleteCalls = 0;
  deletedAtCall = new Map<string, number>();
  timeline: TimelineEntry[] = [];
  private t0 = performance.now();
  constructor(readonly opts: RevenueCatWorldOptions = {}) {}

  log(op: string, detail: string): void {
    this.timeline.push({ t: Math.round((performance.now() - this.t0) * 100) / 100, op, detail });
  }

  async handle(request: Request): Promise<Response> {
    const appUserId = decodeURIComponent(request.url.slice(RC_URL.length));
    if (request.method !== "DELETE") {
      return new Response(JSON.stringify({ subscriber: { entitlements: {} } }), { status: 200 });
    }
    this.deleteCalls += 1;
    const call = this.deleteCalls;
    const fault = this.opts.deleteFault?.({ call, appUserId }) ?? null;
    if (fault) {
      if (fault.kind === "throw")
        throw new TypeError("stress: simulated RevenueCat network failure");
      if (fault.kind === "delay") await sleep(fault.ms);
      else if (fault.kind === "hang_body") {
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200 });
      } else {
        this.log("rc.delete", `#${call} ${appUserId} → fault ${fault.status}`);
        return new Response(fault.body === undefined ? "" : JSON.stringify(fault.body), {
          status: fault.status,
        });
      }
    }
    const auth = request.headers.get("authorization") ?? "";
    if (!auth.startsWith("Bearer ") || auth.length < 8) {
      return new Response(JSON.stringify({ code: 7225, message: "Invalid API key" }), {
        status: 401,
      });
    }
    if (this.subscribers.has(appUserId)) {
      this.subscribers.delete(appUserId);
      this.deletedAtCall.set(appUserId, call);
      this.log("rc.delete", `#${call} ${appUserId} → 200`);
      return new Response(JSON.stringify({ app_user_id: appUserId, deleted: [appUserId] }), {
        status: 200,
      });
    }
    this.log("rc.delete", `#${call} ${appUserId} → 404`);
    return new Response(JSON.stringify({ code: 7259, message: "Couldn't find subscriber." }), {
      status: 404,
    });
  }
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressWorld {
  fake: FakeSupabase;
  apple: AppleWorld;
  rc: RevenueCatWorld;
  /** GoTrue admin deleteUser calls, in order (user id → status returned). */
  adminDeletes: Array<{ userId: string; status: number; t: number }>;
  /** user ids whose checkpoint upsert hit the profiles FK (23503). */
  fkViolations: string[];
  upstreamCalls: Array<{ t: number; method: string; url: string }>;
  /** Seeded latency injected before every upstream call. */
  latencyMaxMs: number;
  prng: Prng;
}

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  key: AppleKeyMaterial;
  encryptionKey: string;
  world: StressWorld;
  /** Fresh world for a scenario (all fakes reset, seeded). */
  reset(
    seed: number,
    options?: { apple?: AppleWorldOptions; rc?: RevenueCatWorldOptions; latencyMaxMs?: number },
  ): StressWorld;
  /** Rotate APPLE_TOKEN_ENCRYPTION_KEY (the operator did it between requests). */
  rotateEncryptionKey(next?: string): string;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(): Promise<StressHarness> {
  if (loaded) return loaded;
  const key = await generateAppleKeyMaterial();
  let encryptionKey = randomEncryptionKey();
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "stress-webhook-secret");
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.set("APPLE_SIGN_IN_CLIENT_ID", APPLE_CLIENT_ID);
  Deno.env.set("APPLE_SIGN_IN_TEAM_ID", APPLE_TEAM_ID);
  Deno.env.set("APPLE_SIGN_IN_KEY_ID", APPLE_KEY_ID);
  Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", key.privateKeyPem);
  Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", encryptionKey);
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const fake = new FakeSupabase(1, 0);
  fake.tables.account_deletion_requests = [];
  const world: StressWorld = {
    fake,
    apple: new AppleWorld(key, new Prng(1)),
    rc: new RevenueCatWorld(),
    adminDeletes: [],
    fkViolations: [],
    upstreamCalls: [],
    latencyMaxMs: 0,
    prng: new Prng(1),
  };
  const t0 = performance.now();

  const cascadeDelete = (userId: string) => {
    for (const table of Object.keys(fake.tables)) {
      const ownerCol = table === "profiles" ? "id" : "user_id";
      fake.tables[table] = fake.tables[table].filter((r) => r[ownerCol] !== userId);
    }
    for (const session of fake.sessions.values()) {
      if (session.userId === userId) session.revoked = true;
    }
    fake.users.delete(userId);
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    world.upstreamCalls.push({
      t: Math.round((performance.now() - t0) * 100) / 100,
      method: request.method,
      url: request.url,
    });
    if (world.latencyMaxMs > 0) await sleep(world.prng.int(0, world.latencyMaxMs));
    if (request.url === APPLE_TOKEN_URL || request.url === APPLE_REVOKE_URL) {
      return world.apple.handle(request, rawBody);
    }
    if (request.url.startsWith(RC_URL)) return world.rc.handle(request);
    const url = new URL(request.url);
    // FK account_external_credentials.user_id → profiles(id) (ON DELETE
    // CASCADE): once the auth.users cascade removed the profile, an insert /
    // upsert of a checkpoint row is a 23503 in Postgres — model it, otherwise
    // the fake silently accepts an orphan row PostgREST would refuse.
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/account_external_credentials" &&
      request.method === "POST"
    ) {
      let payload: unknown = null;
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = null;
      }
      const rows = Array.isArray(payload) ? payload : [payload];
      const orphan = rows.find(
        (r) => isRecord(r) && !fake.tables.profiles.some((p) => p.id === r.user_id),
      );
      if (orphan && isRecord(orphan)) {
        world.fkViolations.push(String(orphan.user_id));
        fake.log(
          "rest.upsert",
          `account_external_credentials user=${String(orphan.user_id)} → 409 23503`,
        );
        return new Response(
          JSON.stringify({
            code: "23503",
            details: `Key (user_id)=(${String(orphan.user_id)}) is not present in table "profiles".`,
            hint: null,
            message:
              'insert or update on table "account_external_credentials" violates foreign key constraint "account_external_credentials_user_id_fkey"',
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        );
      }
    }
    if (
      url.origin === SUPABASE_URL &&
      url.pathname.startsWith("/auth/v1/admin/users/") &&
      request.method === "DELETE"
    ) {
      const userId = decodeURIComponent(url.pathname.slice("/auth/v1/admin/users/".length));
      const auth = request.headers.get("authorization") ?? "";
      if (auth !== `Bearer ${SERVICE_ROLE_KEY}`) {
        world.adminDeletes.push({ userId, status: 401, t: performance.now() });
        return new Response(JSON.stringify({ code: 401, msg: "not service role" }), {
          status: 401,
        });
      }
      if (!fake.users.has(userId)) {
        world.adminDeletes.push({ userId, status: 404, t: performance.now() });
        fake.log("gotrue.admin.delete", `user=${userId} → 404 user_not_found`);
        return new Response(
          JSON.stringify({ code: 404, error_code: "user_not_found", msg: "User not found" }),
          { status: 404, headers: { "Content-Type": "application/json" } },
        );
      }
      cascadeDelete(userId);
      world.adminDeletes.push({ userId, status: 200, t: performance.now() });
      fake.log("gotrue.admin.delete", `user=${userId} → 200 (cascaded)`);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return fake.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");

  loaded = {
    handler,
    key,
    get encryptionKey() {
      return encryptionKey;
    },
    world,
    reset(seed, options = {}) {
      fake.reset(seed, 0);
      fake.tables.account_deletion_requests = [];
      world.apple = new AppleWorld(key, new Prng(seed ^ 0x5bd1e995), options.apple);
      world.rc = new RevenueCatWorld(options.rc);
      world.adminDeletes = [];
      world.fkViolations = [];
      world.upstreamCalls = [];
      world.latencyMaxMs = options.latencyMaxMs ?? STRESS_LATENCY_MS;
      world.prng = new Prng(seed ^ 0x9e3779b9);
      Deno.env.set("APPLE_SIGN_IN_PRIVATE_KEY", key.privateKeyPem);
      return world;
    },
    rotateEncryptionKey(next) {
      encryptionKey = next ?? randomEncryptionKey();
      Deno.env.set("APPLE_TOKEN_ENCRYPTION_KEY", encryptionKey);
      return encryptionKey;
    },
  };
  return loaded;
}

// ── Request builders ─────────────────────────────────────────────────────────

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string | null;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "198.51.100.7",
    ...options.headers,
  });
  if (options.token) headers.set("Authorization", `Bearer ${options.token}`);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  return new Request(`http://edge.stress.test/functions/v1/api${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : { _value: parsed };
  } catch {
    return { _raw: text };
  }
}

export interface LaneResult {
  lane: number;
  op: string;
  status: number;
  code?: string;
  body: Record<string, unknown>;
  ms: number;
}

export async function drive(
  h: StressHarness,
  lane: number,
  op: string,
  request: Request,
): Promise<LaneResult> {
  const t0 = performance.now();
  const response = await h.handler(request);
  const body = await readJson(response);
  return {
    lane,
    op,
    status: response.status,
    code: isRecord(body.error) && typeof body.error.code === "string" ? body.error.code : undefined,
    body,
    ms: Math.round((performance.now() - t0) * 100) / 100,
  };
}

/** Apple bootstrap through the real route with a fresh one-use code. */
export function appleBootstrapRequest(
  w: StressWorld,
  subject: string,
  ip: string,
  options: { code?: string | null; legacy?: boolean } = {},
): Request {
  const code = options.code === undefined ? w.apple.issueCode(subject) : options.code;
  return edgeRequest("POST", "/v1/account/bootstrap", {
    token: fakeIdToken("apple", subject),
    ip,
    headers: options.legacy ? {} : { "X-Apple-Revocation-Protocol": "1" },
    body: code ? { appleAuthorizationCode: code } : {},
  });
}

/** A pending deletion challenge, minted straight into the (fake) table so the
 * 3 s minimum age and the 1 h expiry are controlled by the scenario. */
export function seedDeletionChallenge(
  w: StressWorld,
  userId: string,
  options: { ageMs?: number; ttlMs?: number; challenge?: string } = {},
): string {
  const challenge = options.challenge ?? w.prng.uuid();
  const created = Date.now() - (options.ageMs ?? 10_000);
  w.fake.tables.account_deletion_requests.push({
    user_id: userId,
    challenge,
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + (options.ttlMs ?? 3_600_000)).toISOString(),
  });
  return challenge;
}

export function deleteConfirmRequest(token: string, challenge: string, ip: string): Request {
  return edgeRequest("POST", "/v1/me/delete-confirm", { token, ip, body: { challenge } });
}

export function credentialRow(w: StressWorld, userId: string): Record<string, unknown> | undefined {
  return w.fake.tables.account_external_credentials.find((r) => r.user_id === userId);
}

export function credentialRows(w: StressWorld, userId: string): Record<string, unknown>[] {
  return w.fake.tables.account_external_credentials.filter((r) => r.user_id === userId);
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface RoundOutcome {
  seed: number;
  round: number;
  /** "HELD", "KNOWN_BROKEN(<finding ids>)" or "BROKEN: <invariant names>" */
  outcome: string;
  failed: string[];
  statuses: Record<string, number>;
  ms: number;
  detail?: Record<string, unknown>;
}

export interface StressReport {
  scenario: string;
  label: string;
  file: string;
  baseSeed: number;
  scale: Record<string, number>;
  iterations: number;
  held: number;
  /** rounds where an invariant NOT listed in knownBroken failed */
  broken: number;
  /** rounds where only known-broken invariants failed (reproduced defects) */
  knownBroken: number;
  /** finding id → rounds that reproduced it */
  reproduced: Record<string, number>;
  rounds: RoundOutcome[];
  invariants: Invariant[];
  counters: Record<string, number>;
  observations: Record<string, unknown>;
  durationMs: number;
  heap: { before: Deno.MemoryUsage; after: Deno.MemoryUsage };
  replay: string;
}

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-external-accounts/latest/", import.meta.url)
    .pathname;
}

export async function writeStressReport(report: StressReport): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${report.scenario}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
  return path;
}

/** Scenario ids are `stress-<id>-<slug>`; the Deno test name starts with
 * `stress-<id> ` so the filter is the id prefix followed by a space. */
export function replayCommand(file: string, scenario: string, seed: number): string {
  const filter = `${scenario.split("-").slice(0, 2).join("-")} `;
  const pg = file.includes("_pg.") ? "XC_PG_URL=$XC_PG_URL " : "";
  return `${pg}STRESS_SEED=${seed} STRESS_ITER=1 STRESS_BURST=${STRESS_BURST} STRESS_LATENCY_MS=${STRESS_LATENCY_MS} deno test -A --no-check --config deno.json ${file} --filter "${filter}"`;
}

export function histogram(values: Array<string | number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/** Deterministic per-round seed derived from the base seed. */
export function roundSeed(base: number, round: number): number {
  let x = (base ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

/**
 * Known defects reproduced by this harness. An invariant listed here is still
 * evaluated and recorded BROKEN in the JSON report (never hidden), but the
 * Deno test does not fail on it — it fails instead if the defect STOPS
 * reproducing, so a production fix forces this table to be trimmed and the
 * finding closed. Keys are invariant names, values are finding ids.
 */
export type KnownBroken = Record<string, string>;

/** Runs `iterations` seeded rounds, collects invariants per round, writes the
 * report; the caller asserts on `broken` / `reproduced`. */
export async function campaign(
  scenario: string,
  label: string,
  file: string,
  scale: Record<string, number>,
  iterations: number,
  round: (
    seed: number,
    round: number,
  ) => Promise<{
    invariants: Invariant[];
    statuses: Array<number | string>;
    detail?: Record<string, unknown>;
  }>,
  extra: {
    counters?: () => Record<string, number>;
    observations?: () => Record<string, unknown>;
    knownBroken?: KnownBroken;
  } = {},
): Promise<StressReport> {
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  const rounds: RoundOutcome[] = [];
  const failures = new Map<string, { detail: string; seeds: number[] }>();
  const known = extra.knownBroken ?? {};
  const reproduced: Record<string, number> = {};
  for (const id of Object.values(known)) reproduced[id] = 0;
  let held = 0;
  let knownBroken = 0;
  for (let i = 0; i < iterations; i++) {
    const seed = roundSeed(STRESS_SEED, i);
    const r0 = performance.now();
    const out = await round(seed, i);
    const failed = out.invariants.filter((inv) => !inv.holds);
    for (const inv of failed) {
      const entry = failures.get(inv.name) ?? { detail: inv.detail, seeds: [] };
      entry.seeds.push(seed);
      failures.set(inv.name, entry);
    }
    const unexpected = failed.filter((f) => !(f.name in known));
    const ids = [...new Set(failed.filter((f) => f.name in known).map((f) => known[f.name]))];
    for (const id of ids) reproduced[id] = (reproduced[id] ?? 0) + 1;
    let outcome: string;
    if (failed.length === 0) {
      held += 1;
      outcome = "HELD";
    } else if (unexpected.length === 0) {
      knownBroken += 1;
      outcome = `KNOWN_BROKEN(${ids.join(",")})`;
    } else {
      outcome = `BROKEN: ${unexpected.map((f) => f.name).join(", ")}`;
    }
    rounds.push({
      seed,
      round: i,
      outcome,
      failed: failed.map((f) => f.name),
      statuses: histogram(out.statuses),
      ms: Math.round((performance.now() - r0) * 100) / 100,
      detail: failed.length
        ? { ...out.detail, failed: failed.map((f) => `${f.name}: ${f.detail}`) }
        : out.detail,
    });
  }
  const invariants: Invariant[] = [...failures.entries()].map(([name, f]) => ({
    name,
    holds: false,
    detail: `${name in known ? `[${known[name]}] ` : ""}${f.detail} — seeds ${f.seeds.slice(0, 5).join(",")}${f.seeds.length > 5 ? "…" : ""}`,
  }));
  const report: StressReport = {
    scenario,
    label,
    file,
    baseSeed: STRESS_SEED,
    scale,
    iterations,
    held,
    broken: iterations - held - knownBroken,
    knownBroken,
    reproduced,
    rounds,
    invariants,
    counters: extra.counters?.() ?? {},
    observations: extra.observations?.() ?? {},
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
    heap: { before, after: Deno.memoryUsage() },
    replay: replayCommand(
      file,
      scenario,
      rounds.find((r) => r.outcome !== "HELD")?.seed ?? STRESS_SEED,
    ),
  };
  const path = await writeStressReport(report);
  // Progress goes to stderr (the repo's eslint no-console allows warn/error;
  // stdout stays Deno's test-reporter stream).
  console.error(
    `[stress] ${scenario}: ${held}/${iterations} HELD, ${knownBroken} KNOWN_BROKEN, ${report.broken} BROKEN in ${report.durationMs}ms → ${path}`,
  );
  for (const i of invariants) console.error(`[stress]   BROKEN ${i.name} — ${i.detail}`);
  return report;
}

/** Test-side verdict: no unexpected breakage, and (given ≥ 4 rounds — a
 * single-seed replay is not a statement about the defect) every defect in
 * `mustReproduce` actually reproduced, otherwise the entry is stale. */
export function assertCampaign(report: StressReport, mustReproduce: KnownBroken = {}): void {
  if (report.broken > 0) {
    throw new Error(
      `${report.scenario}: ${report.broken}/${report.iterations} rounds BROKEN — ${JSON.stringify(report.invariants)}; replay: ${report.replay}`,
    );
  }
  if (report.iterations < 4) return;
  for (const id of new Set(Object.values(mustReproduce))) {
    if ((report.reproduced[id] ?? 0) === 0) {
      throw new Error(
        `${report.scenario}: known defect ${id} did not reproduce in ${report.iterations} rounds — fixed? remove it from knownBroken and close the finding.`,
      );
    }
  }
}
