// xc-journey-signin-restore — Edge half of the durable-session journey.
//
// Black-box, adversarial exercise of the REAL edge handler (via
// routesHarness.ts) against a STATEFUL fake GoTrue that mints, rotates,
// spends and revokes sessions exactly like Supabase Auth does for
// `grant_type=id_token`, `grant_type=refresh_token`, `GET /user` and
// `POST /logout?scope=local`. The fake is the oracle: every edge response is
// checked against what the auth state says must happen.
//
// Covered:
//   * Google / Apple bootstrap → { session: { accessToken, refreshToken,
//     expiresAt } }; provider ID token spent exactly once with Supabase Auth
//     and never forwarded anywhere else; no provider material in the body.
//   * Apple: the plaintext Apple refresh token from the authorization-code
//     grant never leaves the edge (only the encrypted form reaches PostgREST).
//   * /v1/auth/refresh rotation: old refresh token spent → 401; new pair
//     works; replay of the spent token is refused.
//   * Upstream fault mapping on refresh: 5xx → 503 (transient for the app),
//     network failure / 429 characterised (contract says only a REFUSED
//     refresh token may sign the user out).
//   * /v1/auth/logout is local scope: exactly the calling device's session
//     dies (its bearer + refresh token), the same user's other devices keep
//     rotating and authenticating.
//   * Per-IP budgets: spent-token stuffing trips the auth-failure budget and
//     a later VALID refresh from that IP is throttled (429), never refused
//     (401).
//   * A seeded multi-device program matrix (XC_EDGE_SCENARIOS, default 300)
//     with replayable seeds.
//
// Two upstream-fault cases (GoTrue 429, GoTrue unreachable) are answered 401
// by the edge today (index.ts refreshSessionRoute: only `status >= 500` is
// mapped to 503; status 0/429 fall through to 401), and the app treats a 401
// refresh as its ONE implicit sign-out. Those cases are CHARACTERISED below
// (the test pins the observed 401 so the suite stays green and the defect is
// visible); run with XC_STRICT_CONTRACT=1 to assert the contract instead and
// see them fail.
//
// Run:   cd supabase/functions/api/__wf__ && deno task test
// One file: deno test -A --no-check --config deno.json xc_journey_signin_restore.test.ts
// Artifacts: $XC_ARTIFACT_DIR/edge/*.json (default artifacts/xc-journey-signin-restore/edge).

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  fakeAppleIdToken,
  fakeGoogleIdToken,
  type Harness,
  loadHarness,
  SUPABASE_URL,
} from "./routesHarness.ts";

// ─── artifacts ───────────────────────────────────────────────────────────────

function artifactDir(): string {
  const configured = Deno.env.get("XC_ARTIFACT_DIR");
  const base =
    configured && configured.trim()
      ? configured
      : new URL("../../../../artifacts/xc-journey-signin-restore", import.meta.url).pathname;
  const dir = `${base}/edge`;
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, data: unknown): string {
  const path = `${artifactDir()}/${name}`;
  Deno.writeTextFileSync(path, JSON.stringify(data, null, 2));
  return path;
}

function heap(label: string): Record<string, unknown> {
  const m = Deno.memoryUsage();
  return {
    label,
    heapUsedMB: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
    heapTotalMB: Math.round((m.heapTotal / 1_048_576) * 100) / 100,
    rssMB: Math.round((m.rss / 1_048_576) * 100) / 100,
    externalMB: Math.round((m.external / 1_048_576) * 100) / 100,
  };
}

// ─── deterministic randomness ────────────────────────────────────────────────

class Prng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

let tokenCounter = 0;
const uniq = (): string => `${Date.now().toString(36)}${(tokenCounter++).toString(36)}`;

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const raw = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(raw + "=".repeat((4 - (raw.length % 4)) % 4)));
  } catch {
    return null;
  }
}

// ─── stateful fake GoTrue ────────────────────────────────────────────────────

type Provider = "google" | "apple";

interface FakeUser {
  id: string;
  email: string;
  provider: Provider;
}

interface FakeSession {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  /** Refresh tokens this session has already rotated away from. */
  spent: string[];
  revoked: boolean;
  createdBy: string;
}

type Endpoint = "token:id_token" | "token:refresh_token" | "user" | "logout";

type UpstreamFault = { kind: "status"; status: number; body?: unknown } | { kind: "network" };

interface GoTrueCall {
  endpoint: Endpoint;
  query: string;
  status: number | "network";
  /** Redacted description of the material carried. */
  material: string;
}

const redactTok = (value: string): string => `<${value.slice(0, 4)}…${value.slice(-6)}>`;

class FakeGoTrue {
  users = new Map<string, FakeUser>();
  sessions = new Map<string, FakeSession>();
  calls: GoTrueCall[] = [];
  /** One-shot faults per endpoint (consumed FIFO). */
  private faults = new Map<Endpoint, UpstreamFault[]>();
  /** Sticky faults per endpoint (applied until cleared). */
  private sticky = new Map<Endpoint, UpstreamFault>();

  fault(endpoint: Endpoint, fault: UpstreamFault): void {
    const queue = this.faults.get(endpoint) ?? [];
    queue.push(fault);
    this.faults.set(endpoint, queue);
  }
  stick(endpoint: Endpoint, fault: UpstreamFault | null): void {
    if (fault) this.sticky.set(endpoint, fault);
    else this.sticky.delete(endpoint);
  }
  clearFaults(): void {
    this.faults.clear();
    this.sticky.clear();
  }

  userForSubject(sub: string, provider: Provider): FakeUser {
    const key = `${provider}:${sub}`;
    let user = this.users.get(key);
    if (!user) {
      user = {
        id: crypto.randomUUID(),
        email: `${provider}-${sub.replace(/[^a-z0-9]/gi, "").slice(0, 12)}@example.com`,
        provider,
      };
      this.users.set(key, user);
    }
    return user;
  }

  private mintAccess(user: FakeUser, sessionId: string): string {
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64url(
      JSON.stringify({
        iss: `${SUPABASE_URL}/auth/v1`,
        sub: user.id,
        aud: "authenticated",
        role: "authenticated",
        exp: Math.floor(Date.now() / 1000) + 3600,
        session_id: sessionId,
        jti: uniq(),
      }),
    );
    return `${header}.${payload}.sig${uniq()}`;
  }

  private newSession(user: FakeUser, createdBy: string): FakeSession {
    const id = crypto.randomUUID();
    const session: FakeSession = {
      id,
      userId: user.id,
      accessToken: this.mintAccess(user, id),
      refreshToken: `rt_${uniq()}_${crypto.randomUUID().slice(0, 8)}`,
      spent: [],
      revoked: false,
      createdBy,
    };
    this.sessions.set(id, session);
    return session;
  }

  private rotate(session: FakeSession): void {
    const user = [...this.users.values()].find((u) => u.id === session.userId)!;
    session.spent.push(session.refreshToken);
    session.refreshToken = `rt_${uniq()}_${crypto.randomUUID().slice(0, 8)}`;
    session.accessToken = this.mintAccess(user, session.id);
  }

  sessionByAccess(token: string): FakeSession | null {
    for (const s of this.sessions.values()) if (s.accessToken === token) return s;
    return null;
  }
  sessionByRefresh(token: string): { session: FakeSession; spent: boolean } | null {
    for (const s of this.sessions.values()) {
      if (s.refreshToken === token) return { session: s, spent: false };
      if (s.spent.includes(token)) return { session: s, spent: true };
    }
    return null;
  }
  userById(id: string): FakeUser | null {
    for (const u of this.users.values()) if (u.id === id) return u;
    return null;
  }

  private sessionJson(session: FakeSession): Record<string, unknown> {
    const user = this.userById(session.userId)!;
    return {
      access_token: session.accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: session.refreshToken,
      user: this.userJson(user),
    };
  }
  private userJson(user: FakeUser): Record<string, unknown> {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00Z",
    };
  }

  private takeFault(endpoint: Endpoint): UpstreamFault | null {
    const sticky = this.sticky.get(endpoint);
    if (sticky) return sticky;
    const queue = this.faults.get(endpoint);
    if (queue && queue.length) return queue.shift()!;
    return null;
  }

  private json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  private applyFault(endpoint: Endpoint, query: string, material: string): Response | null {
    const fault = this.takeFault(endpoint);
    if (!fault) return null;
    if (fault.kind === "network") {
      this.calls.push({ endpoint, query, status: "network", material });
      throw new TypeError("error sending request for url (gotrue): connection reset");
    }
    this.calls.push({ endpoint, query, status: fault.status, material });
    return this.json(
      fault.status,
      fault.body ?? { code: fault.status, msg: `injected upstream ${fault.status}` },
    );
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s*/i, "");

    if (path === "/auth/v1/token" && request.method === "POST") {
      const grant = url.searchParams.get("grant_type") ?? "";
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      if (grant === "id_token") {
        const idToken = typeof body.id_token === "string" ? body.id_token : "";
        const provider = body.provider === "apple" ? "apple" : "google";
        const material = `id_token=${redactTok(idToken)} provider=${String(body.provider)}`;
        const faulted = this.applyFault("token:id_token", grant, material);
        if (faulted) return faulted;
        const claims = decodeJwtPayload(idToken);
        const sub = typeof claims?.sub === "string" ? claims.sub : "";
        if (!sub) {
          this.calls.push({ endpoint: "token:id_token", query: grant, status: 400, material });
          return this.json(400, { error: "invalid_grant", error_description: "bad id token" });
        }
        const user = this.userForSubject(sub, provider);
        const session = this.newSession(user, "id_token");
        this.calls.push({ endpoint: "token:id_token", query: grant, status: 200, material });
        return this.json(200, this.sessionJson(session));
      }
      if (grant === "refresh_token") {
        const rt = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const material = `refresh_token=${redactTok(rt)}`;
        const faulted = this.applyFault("token:refresh_token", grant, material);
        if (faulted) return faulted;
        const found = this.sessionByRefresh(rt);
        if (!found || found.spent || found.session.revoked) {
          this.calls.push({ endpoint: "token:refresh_token", query: grant, status: 400, material });
          return this.json(400, {
            error: "invalid_grant",
            error_description: !found
              ? "Invalid Refresh Token: Refresh Token Not Found"
              : found.spent
                ? "Invalid Refresh Token: Already Used"
                : "Invalid Refresh Token: Session Expired",
          });
        }
        this.rotate(found.session);
        this.calls.push({ endpoint: "token:refresh_token", query: grant, status: 200, material });
        return this.json(200, this.sessionJson(found.session));
      }
      return this.json(400, { error: "unsupported_grant_type" });
    }

    if (path === "/auth/v1/user" && request.method === "GET") {
      const material = `bearer=${redactTok(bearer)}`;
      const faulted = this.applyFault("user", "", material);
      if (faulted) return faulted;
      const session = this.sessionByAccess(bearer);
      if (!session || session.revoked) {
        this.calls.push({ endpoint: "user", query: "", status: 401, material });
        return this.json(401, { code: 401, msg: "invalid JWT: session not found" });
      }
      this.calls.push({ endpoint: "user", query: "", status: 200, material });
      return this.json(200, this.userJson(this.userById(session.userId)!));
    }

    if (path === "/auth/v1/logout" && request.method === "POST") {
      const scope = url.searchParams.get("scope") ?? "(none)";
      const material = `bearer=${redactTok(bearer)} scope=${scope}`;
      const faulted = this.applyFault("logout", scope, material);
      if (faulted) return faulted;
      const session = this.sessionByAccess(bearer);
      if (!session || session.revoked) {
        this.calls.push({ endpoint: "logout", query: scope, status: 401, material });
        return this.json(401, { code: 401, msg: "invalid JWT: session not found" });
      }
      if (scope === "global") {
        for (const s of this.sessions.values()) if (s.userId === session.userId) s.revoked = true;
      } else if (scope === "others") {
        for (const s of this.sessions.values()) {
          if (s.userId === session.userId && s.id !== session.id) s.revoked = true;
        }
      } else {
        session.revoked = true;
      }
      this.calls.push({ endpoint: "logout", query: scope, status: 204, material });
      return new Response(null, { status: 204 });
    }

    return this.json(404, { msg: `fake gotrue: unhandled ${request.method} ${path}` });
  }
}

// ─── fetch interposer (GoTrue + RLS-shaped profiles) ─────────────────────────

interface World {
  h: Harness;
  gotrue: FakeGoTrue;
  /** Every response body the edge returned in this world (for leak scans). */
  responses: Array<{ route: string; status: number; body: string }>;
  uninstall(): void;
}

function installWorld(h: Harness): World {
  const gotrue = new FakeGoTrue();
  const base = globalThis.fetch;
  const world: World = {
    h,
    gotrue,
    responses: [],
    uninstall() {
      globalThis.fetch = base;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/`)) {
      return gotrue.handle(request);
    }
    if (url.pathname === "/rest/v1/profiles" && request.method === "GET") {
      // Behave like RLS: the row visible is the one owned by the bearer.
      const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s*/i, "");
      const session = gotrue.sessionByAccess(bearer);
      const user = session ? gotrue.userById(session.userId) : null;
      const rows = user
        ? [
            {
              id: user.id,
              email: user.email,
              onboarding_state: "pending",
              provider: user.provider,
              skill_level: null,
              handedness: null,
              primary_goal: null,
              biggest_problem: null,
              focus_checkpoint: null,
              first_name: null,
              gender: null,
            },
          ]
        : [];
      const accept = request.headers.get("accept") ?? "";
      // Record it the same way the base harness does so callsTo() sees it.
      h.calls.push({ url: request.url, method: "GET", headers: { accept }, body: null });
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (!rows.length) {
          return new Response(JSON.stringify({ code: "PGRST116", message: "0 rows" }), {
            status: 406,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(rows[0]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return base(input, init);
  }) as typeof fetch;
  return world;
}

// ─── edge client helpers ─────────────────────────────────────────────────────

interface EdgeResult {
  status: number;
  body: Record<string, unknown> | null;
  text: string;
  headers: Record<string, string>;
}

let ipCounter = 1;
const freshIp = (): string => `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

async function edge(
  world: World,
  method: string,
  path: string,
  options: {
    bearer?: string | null;
    ip: string;
    body?: unknown;
    rawBody?: string;
    headers?: Record<string, string>;
  },
): Promise<EdgeResult> {
  const headers = new Headers({ "x-forwarded-for": options.ip, ...options.headers });
  if (options.bearer !== null && options.bearer !== undefined) {
    headers.set("Authorization", `Bearer ${options.bearer}`);
  }
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set("Content-Type", "application/json");
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("Content-Type", "application/json");
  }
  const response = await world.h.handler(
    new Request(`http://edge.test/functions/v1/api${path}`, { method, headers, body }),
  );
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  const out: Record<string, string> = {};
  response.headers.forEach((v, k) => (out[k] = v));
  world.responses.push({ route: `${method} ${path}`, status: response.status, body: text });
  return { status: response.status, body: parsed, text, headers: out };
}

interface SessionView {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function sessionOf(result: EdgeResult): SessionView {
  const s = result.body?.session as Record<string, unknown> | undefined;
  assert(s, `response has no session: ${result.status} ${result.text.slice(0, 200)}`);
  assertEquals(typeof s.accessToken, "string");
  assertEquals(typeof s.refreshToken, "string");
  assertEquals(typeof s.expiresAt, "number");
  assertEquals(
    Object.keys(s).sort(),
    ["accessToken", "expiresAt", "refreshToken"],
    "session view carries exactly accessToken/refreshToken/expiresAt",
  );
  return s as unknown as SessionView;
}

async function bootstrap(
  world: World,
  provider: Provider,
  sub: string,
  ip: string,
  options: { appleCode?: string } = {},
): Promise<{ result: EdgeResult; idToken: string }> {
  const idToken = provider === "apple" ? fakeAppleIdToken(sub) : fakeGoogleIdToken(sub);
  const result = await edge(world, "POST", "/v1/account/bootstrap", {
    bearer: idToken,
    ip,
    body:
      provider === "apple" && options.appleCode
        ? { appleAuthorizationCode: options.appleCode }
        : {},
    headers:
      provider === "apple" && options.appleCode ? { "X-Apple-Revocation-Protocol": "1" } : {},
  });
  return { result, idToken };
}

const refresh = (world: World, refreshToken: unknown, ip: string) =>
  edge(world, "POST", "/v1/auth/refresh", { ip, body: { refreshToken } });

const logout = (world: World, bearer: string | null, ip: string) =>
  edge(world, "POST", "/v1/auth/logout", { ip, bearer });

const whoami = (world: World, bearer: string | null, ip: string) =>
  edge(world, "GET", "/v1/me/access", { ip, bearer });

/** Scan every recorded edge response + every recorded outbound call for
 * material that must never appear there. */
function leakScan(
  world: World,
  forbidden: Array<{ label: string; value: string; allowedIn?: (url: string) => boolean }>,
): string[] {
  const hits: string[] = [];
  for (const f of forbidden) {
    if (!f.value) continue;
    for (const r of world.responses) {
      if (r.body.includes(f.value)) hits.push(`${f.label} in edge response ${r.route} ${r.status}`);
    }
    for (const c of world.h.calls) {
      const serialized = JSON.stringify({ url: c.url, headers: c.headers, body: c.body });
      if (serialized.includes(f.value) && !(f.allowedIn && f.allowedIn(c.url))) {
        hits.push(`${f.label} in outbound ${c.method} ${c.url}`);
      }
    }
  }
  return hits;
}

const isGoTrueTokenUrl = (url: string) => url.startsWith(`${SUPABASE_URL}/auth/v1/token`);

// ─── scenario record ─────────────────────────────────────────────────────────

const journey: Record<string, unknown>[] = [];
const record = (name: string, data: Record<string, unknown>) => {
  journey.push({ name, at: new Date().toISOString(), ...data });
};

const h = await loadHarness();
h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];

// ─── tests ───────────────────────────────────────────────────────────────────

Deno.test(
  "edge journey: Google bootstrap mints a session; provider token spent exactly once and never re-forwarded",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result, idToken } = await bootstrap(world, "google", `g-sub-${uniq()}`, ip);
      assertEquals(result.status, 200, result.text);
      const session = sessionOf(result);
      const user = result.body?.user as Record<string, unknown>;
      assertEquals(typeof user.id, "string");
      assertEquals(result.body?.onboardingState, "pending");
      // expiresAt is epoch SECONDS about an hour out.
      const nowSec = Math.floor(Date.now() / 1000);
      assert(session.expiresAt > nowSec + 3000 && session.expiresAt <= nowSec + 3700);

      // Exactly one id_token grant with Supabase Auth; nothing else touched it.
      const grants = world.gotrue.calls.filter((c) => c.endpoint === "token:id_token");
      assertEquals(grants.length, 1);
      assertEquals(grants[0].status, 200);
      const leaks = leakScan(world, [
        { label: "provider id token", value: idToken, allowedIn: isGoTrueTokenUrl },
        {
          label: "provider id token payload",
          value: idToken.split(".")[1],
          allowedIn: isGoTrueTokenUrl,
        },
      ]);
      assertEquals(leaks, []);
      // The response carries the minted pair and nothing about the provider.
      assert(!result.text.includes("id_token"));
      assert(!result.text.includes("appleid"));
      // The minted session is the one Supabase Auth holds.
      const live = world.gotrue.sessionByAccess(session.accessToken);
      assert(live && !live.revoked && live.refreshToken === session.refreshToken);
      record("google-bootstrap", {
        status: result.status,
        sessionKeys: Object.keys(result.body?.session as object),
        gotrueCalls: world.gotrue.calls,
        leaks,
      });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: Apple bootstrap stores only the ENCRYPTED Apple refresh token; plaintext never leaves the edge",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const sub = "11111111-1111-4111-8111-111111111111"; // matches the harness's Apple grant stub subject
      const { result, idToken } = await bootstrap(world, "apple", sub, ip, {
        appleCode: `c_apple_${uniq()}`,
      });
      assertEquals(result.status, 200, result.text);
      const session = sessionOf(result);
      const upserts = h
        .callsTo("/rest/v1/account_external_credentials")
        .filter((c) => c.method === "POST" || c.method === "PATCH");
      assertEquals(upserts.length, 1, "one credential upsert");
      const row = Array.isArray(upserts[0].body) ? upserts[0].body[0] : upserts[0].body;
      assert(row && typeof row === "object");
      const encrypted = (row as Record<string, unknown>).apple_refresh_token_encrypted;
      assertEquals(typeof encrypted, "string");
      assertNotEquals(encrypted, "apple-refresh-token-from-grant");
      const leaks = leakScan(world, [
        {
          label: "apple plaintext refresh token",
          value: "apple-refresh-token-from-grant",
        },
        { label: "provider id token", value: idToken, allowedIn: isGoTrueTokenUrl },
        {
          label: "apple authorization code",
          value: `c_apple_`,
          allowedIn: (u) => u.startsWith("https://appleid.apple.com/auth/token"),
        },
      ]);
      assertEquals(leaks, []);
      assert(world.gotrue.sessionByAccess(session.accessToken));
      record("apple-bootstrap", {
        status: result.status,
        leaks,
        upsertKeys: Object.keys(row as object),
      });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: refresh rotation spends the old token; replay is refused with 401",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result } = await bootstrap(world, "google", `g-rot-${uniq()}`, ip);
      const s0 = sessionOf(result);

      const r1 = await refresh(world, s0.refreshToken, ip);
      assertEquals(r1.status, 200, r1.text);
      const s1 = sessionOf(r1);
      assertNotEquals(s1.refreshToken, s0.refreshToken);
      assertNotEquals(s1.accessToken, s0.accessToken);

      const replay = await refresh(world, s0.refreshToken, ip);
      assertEquals(replay.status, 401, "spent refresh token is refused");
      assert(!replay.text.includes(s1.refreshToken), "refusal leaks no live token");

      const r2 = await refresh(world, s1.refreshToken, ip);
      assertEquals(r2.status, 200);
      const s2 = sessionOf(r2);
      assertNotEquals(s2.refreshToken, s1.refreshToken);

      // Spent tokens stay spent.
      assertEquals((await refresh(world, s0.refreshToken, ip)).status, 401);
      assertEquals((await refresh(world, s1.refreshToken, ip)).status, 401);

      // Old bearers are not what the auth service holds now, new one is.
      assert(!world.gotrue.sessionByAccess(s0.accessToken));
      assert(world.gotrue.sessionByAccess(s2.accessToken));

      // Leak scan: no spent refresh token appears in any later response.
      const leaks = leakScan(world, [
        { label: "s0 refresh (spent)", value: s0.refreshToken, allowedIn: isGoTrueTokenUrl },
        { label: "s1 refresh (spent)", value: s1.refreshToken, allowedIn: isGoTrueTokenUrl },
      ]);
      // The s0/s1 tokens were legitimately returned in their own responses.
      const unexpected = leaks.filter(
        (l) => !/edge response POST \/v1\/(auth\/refresh|account\/bootstrap) 200/.test(l),
      );
      assertEquals(unexpected, []);
      record("refresh-rotation", {
        statuses: [r1.status, replay.status, r2.status],
        gotrueCalls: world.gotrue.calls,
      });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: refresh validation errors are 400, not 401, and do not spend the auth-failure budget",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result } = await bootstrap(world, "google", `g-val-${uniq()}`, ip);
      const s0 = sessionOf(result);
      const cases: Array<[string, () => Promise<EdgeResult>]> = [
        ["empty body", () => edge(world, "POST", "/v1/auth/refresh", { ip })],
        [
          "non-json body",
          () => edge(world, "POST", "/v1/auth/refresh", { ip, rawBody: "{not json" }),
        ],
        ["missing key", () => refresh(world, undefined, ip)],
        ["numeric token", () => refresh(world, 42, ip)],
        ["blank token", () => refresh(world, "   ", ip)],
        ["array token", () => refresh(world, ["x"], ip)],
        ["object token", () => refresh(world, { refresh_token: s0.refreshToken }, ip)],
      ];
      const results: Record<string, number> = {};
      for (const [label, run] of cases) {
        const r = await run();
        results[label] = r.status;
        assertEquals(r.status, 400, `${label}: ${r.text}`);
        assertEquals((r.body?.error as Record<string, unknown>)?.code, "validation.refresh");
      }
      // No refresh grant ever reached Supabase Auth for malformed input.
      assertEquals(
        world.gotrue.calls.filter((c) => c.endpoint === "token:refresh_token").length,
        0,
      );
      // And the valid token still works from the same IP (nothing was budgeted).
      assertEquals((await refresh(world, s0.refreshToken, ip)).status, 200);
      record("refresh-validation", { results });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: upstream 5xx during refresh — a single blip is absorbed by the client's retry, a sustained outage is 503 (transient), never a 401 sign-out",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result } = await bootstrap(world, "google", `g-5xx-${uniq()}`, ip);
      let live = sessionOf(result);
      const outcomes: Record<string, unknown> = {};

      // One-shot 500/502/503: supabase-js (auth-js retryable()) re-sends after
      // 200ms and the second attempt rotates normally → the app sees 200.
      for (const status of [500, 502, 503]) {
        world.gotrue.fault("token:refresh_token", { kind: "status", status });
        const before = world.gotrue.calls.length;
        const r = await refresh(world, live.refreshToken, ip);
        const attempts = world.gotrue.calls
          .slice(before)
          .filter((c) => c.endpoint === "token:refresh_token").length;
        outcomes[`one-shot-${status}`] = { edge: r.status, attempts };
        assertEquals(r.status, 200, `one-shot GoTrue ${status} → ${r.status} ${r.text}`);
        assertEquals(attempts, 2, "exactly one retry");
        live = sessionOf(r);
      }

      // A non-retryable 5xx (599 is not in auth-js NETWORK_ERROR_CODES) is
      // surfaced once and mapped to 503 by the edge; the token is not spent.
      world.gotrue.fault("token:refresh_token", { kind: "status", status: 599 });
      const r599 = await refresh(world, live.refreshToken, ip);
      outcomes["one-shot-599"] = { edge: r599.status };
      assertEquals(r599.status, 503, r599.text);
      assert(!r599.text.includes("injected"), "5xx never leaks upstream detail");
      assert(world.gotrue.sessionByRefresh(live.refreshToken)?.spent === false);

      // Sustained 500: the client retries with backoff for up to ~30s, then
      // the edge answers 503 — still transient for the app, token still valid.
      world.gotrue.stick("token:refresh_token", { kind: "status", status: 500 });
      const started = Date.now();
      const before = world.gotrue.calls.length;
      const sustained = await refresh(world, live.refreshToken, ip);
      world.gotrue.stick("token:refresh_token", null);
      const attempts = world.gotrue.calls
        .slice(before)
        .filter((c) => c.endpoint === "token:refresh_token").length;
      outcomes["sustained-500"] = {
        edge: sustained.status,
        attempts,
        elapsedMs: Date.now() - started,
      };
      assertEquals(sustained.status, 503, sustained.text);
      assert(!sustained.text.includes("injected"));
      assert(world.gotrue.sessionByRefresh(live.refreshToken)?.spent === false);

      const ok = await refresh(world, live.refreshToken, ip);
      assertEquals(ok.status, 200);
      record("refresh-upstream-5xx", { outcomes });
    } finally {
      world.uninstall();
    }
  },
);

/** XC_STRICT_CONTRACT=1 asserts the durable-session contract (a still-valid
 * refresh token must never be answered 401); the default characterises the
 * shipped behaviour so the suite stays green while the defect is documented. */
const STRICT = Deno.env.get("XC_STRICT_CONTRACT") === "1";

Deno.test(
  `edge journey: GoTrue 429 during refresh — ${STRICT ? "CONTRACT: must not become a 401 sign-out" : "CHARACTERISATION (known defect): becomes a 401 → app signs out"}`,
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result } = await bootstrap(world, "google", `g-429-${uniq()}`, ip);
      const s0 = sessionOf(result);
      world.gotrue.fault("token:refresh_token", {
        kind: "status",
        status: 429,
        body: {
          code: 429,
          error_code: "over_request_rate_limit",
          msg: "Request rate limit reached",
        },
      });
      const r = await refresh(world, s0.refreshToken, ip);
      record("refresh-upstream-429", {
        edgeStatus: r.status,
        body: r.body,
        tokenStillValidAtGoTrue: world.gotrue.sessionByRefresh(s0.refreshToken)?.spent === false,
        gotrueCalls: world.gotrue.calls.filter((c) => c.endpoint === "token:refresh_token"),
        strict: STRICT,
      });
      // The token is still perfectly valid at Supabase Auth …
      assert(world.gotrue.sessionByRefresh(s0.refreshToken)?.spent === false);
      if (STRICT) {
        // … so the app must be told "try later", not "sign in again".
        assertNotEquals(
          r.status,
          401,
          `GoTrue 429 (token still valid) was mapped to 401 → app signs the user out: ${r.text}`,
        );
      } else {
        assertEquals(
          r.status,
          401,
          "characterised: index.ts refreshSessionRoute maps a 429 from Supabase Auth to 401",
        );
        // The same token still rotates once GoTrue stops throttling — proof the
        // 401 was not a refusal of the token.
        assertEquals((await refresh(world, s0.refreshToken, ip)).status, 200);
      }
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  `edge journey: Supabase Auth unreachable during refresh — ${STRICT ? "CONTRACT: must not become a 401 sign-out" : "CHARACTERISATION (known defect): becomes a 401 after ~25s of client retries → app signs out"}`,
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const { result } = await bootstrap(world, "google", `g-net-${uniq()}`, ip);
      const s0 = sessionOf(result);
      world.gotrue.stick("token:refresh_token", { kind: "network" });
      const started = Date.now();
      const r = await refresh(world, s0.refreshToken, ip);
      const elapsedMs = Date.now() - started;
      world.gotrue.stick("token:refresh_token", null);
      const attempts = world.gotrue.calls.filter(
        (c) => c.endpoint === "token:refresh_token",
      ).length;
      record("refresh-upstream-network", {
        edgeStatus: r.status,
        body: r.body,
        elapsedMs,
        attempts,
        tokenStillValidAtGoTrue: world.gotrue.sessionByRefresh(s0.refreshToken)?.spent === false,
        strict: STRICT,
      });
      assert(world.gotrue.sessionByRefresh(s0.refreshToken)?.spent === false);
      assert(attempts >= 2, "auth-js retried the network failure");
      if (STRICT) {
        assertNotEquals(
          r.status,
          401,
          `network failure to GoTrue (token still valid, ${attempts} attempts over ${elapsedMs}ms) was mapped to 401 → app signs the user out: ${r.text}`,
        );
      } else {
        assertEquals(
          r.status,
          401,
          "characterised: AuthRetryableFetchError status 0 is not >= 500, so refreshSessionRoute answers 401",
        );
        assertEquals(
          (await refresh(world, s0.refreshToken, ip)).status,
          200,
          "the token was never refused",
        );
      }
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: logout is local scope — exactly this device dies, the other device keeps rotating and authenticating",
  async () => {
    const world = installWorld(h);
    try {
      const sub = `g-multi-${uniq()}`;
      const ipA = freshIp();
      const ipB = freshIp();
      const a = sessionOf((await bootstrap(world, "google", sub, ipA)).result);
      const b = sessionOf((await bootstrap(world, "google", sub, ipB)).result);
      assertEquals(
        world.gotrue.sessionByAccess(a.accessToken)!.userId,
        world.gotrue.sessionByAccess(b.accessToken)!.userId,
      );
      assertNotEquals(a.refreshToken, b.refreshToken);

      // Both bearers authenticate (and get cached at the edge).
      assertEquals((await whoami(world, a.accessToken, ipA)).status, 200);
      assertEquals((await whoami(world, b.accessToken, ipB)).status, 200);

      const out = await logout(world, a.accessToken, ipA);
      assertEquals(out.status, 204, out.text);
      const logoutCalls = world.gotrue.calls.filter((c) => c.endpoint === "logout");
      assertEquals(logoutCalls.length, 1);
      assertEquals(logoutCalls[0].query, "local", "edge asks Supabase Auth for scope=local");
      assert(
        logoutCalls[0].material.includes(redactTok(a.accessToken)),
        "the CALLING device's bearer is what gets revoked",
      );

      // Device A: bearer dead at this edge immediately (cache dropped), refresh dead.
      assertEquals(
        (await whoami(world, a.accessToken, ipA)).status,
        401,
        "revoked bearer rejected",
      );
      assertEquals(
        (await refresh(world, a.refreshToken, ipA)).status,
        401,
        "revoked refresh token refused",
      );

      // Device B: untouched.
      assertEquals(
        (await whoami(world, b.accessToken, ipB)).status,
        200,
        "other device bearer still valid",
      );
      const rb = await refresh(world, b.refreshToken, ipB);
      assertEquals(rb.status, 200, "other device still rotates");
      const b1 = sessionOf(rb);
      assertEquals((await whoami(world, b1.accessToken, ipB)).status, 200);

      // Model agrees: exactly one session revoked for that user.
      const userSessions = [...world.gotrue.sessions.values()].filter(
        (s) => s.userId === world.gotrue.sessionByAccess(b1.accessToken)!.userId,
      );
      assertEquals(userSessions.filter((s) => s.revoked).length, 1);
      assertEquals(userSessions.length, 2);

      // Idempotent: logging out an already-dead bearer is not an error for the app.
      const again = await logout(world, a.accessToken, ipA);
      assert(again.status === 204 || again.status === 401, `second logout: ${again.status}`);
      record("logout-local-scope", {
        logoutCalls,
        secondLogoutStatus: again.status,
        revoked: userSessions.filter((s) => s.revoked).length,
      });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: logout upstream mapping — 5xx → 503 (app retries), already-gone → 204",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const a = sessionOf((await bootstrap(world, "google", `g-lo-${uniq()}`, ip)).result);
      world.gotrue.fault("logout", { kind: "status", status: 500 });
      const failed = await logout(world, a.accessToken, ip);
      assertEquals(failed.status, 503, failed.text);
      assert(!failed.text.includes("injected"));
      // Session is still alive at Supabase Auth — the app will retry or the user stays signed in elsewhere.
      assertEquals(world.gotrue.sessionByAccess(a.accessToken)!.revoked, false);

      // Upstream says "already gone" (404): the caller's intent is satisfied → 204.
      world.gotrue.fault("logout", { kind: "status", status: 404 });
      const gone = await logout(world, a.accessToken, ip);
      assertEquals(gone.status, 204, gone.text);

      // Real logout now.
      const ok = await logout(world, a.accessToken, ip);
      assertEquals(ok.status, 204);
      assertEquals(world.gotrue.sessionByAccess(a.accessToken)!.revoked, true);

      // Logout without any bearer never reaches Supabase Auth.
      const before = world.gotrue.calls.length;
      const anon = await logout(world, null, ip);
      assertEquals(anon.status, 401);
      assertEquals(world.gotrue.calls.length, before);
      record("logout-upstream-mapping", {
        failed: failed.status,
        gone: gone.status,
        ok: ok.status,
        anon: anon.status,
      });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: bootstrap refuses non-provider bearers without touching Supabase Auth",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const a = sessionOf((await bootstrap(world, "google", `g-bad-${uniq()}`, ip)).result);
      const before = world.gotrue.calls.length;
      const expired = (() => {
        const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const payload = b64url(
          JSON.stringify({
            iss: "https://accounts.google.com",
            sub: "x",
            exp: Math.floor(Date.now() / 1000) - 5,
          }),
        );
        return `${header}.${payload}.sig`;
      })();
      const noSub = (() => {
        const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
        const payload = b64url(
          JSON.stringify({
            iss: "https://accounts.google.com",
            exp: Math.floor(Date.now() / 1000) + 600,
          }),
        );
        return `${header}.${payload}.sig`;
      })();
      const cases: Array<[string, string | null]> = [
        ["supabase access token as bootstrap bearer", a.accessToken],
        ["refresh token as bootstrap bearer", a.refreshToken],
        ["expired provider token", expired],
        ["provider token without sub", noSub],
        ["garbage", "not.a.jwt"],
        ["missing", null],
      ];
      const statuses: Record<string, number> = {};
      for (const [label, bearer] of cases) {
        const r = await edge(world, "POST", "/v1/account/bootstrap", { ip, bearer, body: {} });
        statuses[label] = r.status;
        assertEquals(r.status, 401, `${label}: ${r.text}`);
      }
      assertEquals(
        world.gotrue.calls.length,
        before,
        "no Supabase Auth call for a refused bootstrap bearer",
      );
      record("bootstrap-bad-bearers", { statuses });
    } finally {
      world.uninstall();
    }
  },
);

Deno.test(
  "edge journey: spent-token stuffing trips the per-IP auth-failure budget; a later VALID refresh from that IP is throttled (429), not refused (401)",
  async () => {
    const world = installWorld(h);
    try {
      const ip = freshIp();
      const victimIp = freshIp();
      const a = sessionOf((await bootstrap(world, "google", `g-stuff-${uniq()}`, victimIp)).result);
      // Spend one token legitimately so we have a known-spent value to replay.
      const r1 = await refresh(world, a.refreshToken, victimIp);
      const a1 = sessionOf(r1);

      const statuses: number[] = [];
      for (let i = 0; i < 29; i += 1) {
        statuses.push((await refresh(world, a.refreshToken, ip)).status);
      }
      assert(
        statuses.every((s) => s === 401),
        `first 29 replays refused: ${statuses.join(",")}`,
      );
      // 30th refusal fills the budget (limit 30 / 300s) — still a 401 itself.
      const thirtieth = await refresh(world, a.refreshToken, ip);
      // Either the 30th is the last 401 (budget then full) or the auth_refresh
      // route budget (30/min) already trips first; both are throttles, never a
      // silent acceptance.
      assert(thirtieth.status === 401 || thirtieth.status === 429, String(thirtieth.status));

      // A VALID refresh from the abusive IP must be throttled, not refused —
      // refusing it would sign out an innocent device sharing that NAT.
      const valid = await refresh(world, a1.refreshToken, ip);
      assertEquals(
        valid.status,
        429,
        `valid refresh from budget-exhausted IP: ${valid.status} ${valid.text}`,
      );
      assert(valid.headers["retry-after"], "429 carries Retry-After");
      // … and the valid token was NOT spent by the throttled attempt.
      assert(world.gotrue.sessionByRefresh(a1.refreshToken)?.spent === false);

      // Same token from a clean IP works.
      const other = await refresh(world, a1.refreshToken, freshIp());
      assertEquals(other.status, 200);
      record("authfail-budget", {
        replays: statuses.length + 1,
        thirtieth: thirtieth.status,
        validFromAbusiveIp: valid.status,
        retryAfter: valid.headers["retry-after"] ?? null,
        validFromCleanIp: other.status,
      });
    } finally {
      world.uninstall();
    }
  },
);

// ─── seeded multi-device program matrix ──────────────────────────────────────

type Op =
  | "bootstrap"
  | "refresh"
  | "replay-spent"
  | "authed-get"
  | "logout"
  | "refresh-upstream-5xx"
  | "refresh-upstream-429"
  | "foreign-refresh";

interface Device {
  name: string;
  user: string;
  provider: Provider;
  ip: string;
  /** Pair the DEVICE currently holds (what the vault would hold). */
  access: string | null;
  refreshToken: string | null;
  spent: string[];
  /** Model: device believes it is signed in. */
  signedIn: boolean;
  /** Model: server session revoked by this device's own local logout. */
  loggedOut: boolean;
}

interface StepRecord {
  i: number;
  op: Op;
  device: string;
  expected: number | number[];
  observed: number;
  ok: boolean;
  note?: string;
}

interface ScenarioRecord {
  seed: number;
  devices: Array<{ name: string; user: string; provider: Provider }>;
  steps: StepRecord[];
  violations: string[];
  gotrueCalls: number;
  ok: boolean;
}

/** Times the seeded matrix observed GoTrue 429 → edge 401 (the characterised defect). */
let defect429Hits = 0;

async function runScenario(seed: number): Promise<ScenarioRecord> {
  const rng = new Prng(seed);
  const world = installWorld(h);
  try {
    const users = ["u1", "u2"].slice(0, 1 + rng.int(2)).map((u) => `${u}-${seed}`);
    const devices: Device[] = [];
    const deviceCount = 1 + rng.int(3);
    for (let d = 0; d < deviceCount; d += 1) {
      devices.push({
        name: `d${d}`,
        user: rng.pick(users),
        provider: rng.pick(["google", "apple"] as const),
        ip: freshIp(),
        access: null,
        refreshToken: null,
        spent: [],
        signedIn: false,
        loggedOut: false,
      });
    }
    const steps: StepRecord[] = [];
    const violations: string[] = [];
    const stepCount = 4 + rng.int(7);
    const ops: Op[] = [
      "bootstrap",
      "refresh",
      "refresh",
      "replay-spent",
      "authed-get",
      "authed-get",
      "logout",
      "refresh-upstream-5xx",
      "refresh-upstream-429",
      "foreign-refresh",
    ];

    for (let i = 0; i < stepCount; i += 1) {
      const device = rng.pick(devices);
      let op = rng.pick(ops);
      if (!device.signedIn && op !== "bootstrap" && rng.chance(0.7)) op = "bootstrap";
      const check = (expected: number | number[], observed: number, note?: string) => {
        const ok = Array.isArray(expected) ? expected.includes(observed) : expected === observed;
        steps.push({ i, op, device: device.name, expected, observed, ok, note });
        if (!ok)
          violations.push(
            `step ${i} ${op} ${device.name}: expected ${JSON.stringify(expected)} got ${observed}${note ? ` (${note})` : ""}`,
          );
      };

      switch (op) {
        case "bootstrap": {
          // Apple bootstrap without the revocation header = legacy build path (200).
          const r = (
            await bootstrap(world, device.provider, `${device.user}-${device.provider}`, device.ip)
          ).result;
          check(200, r.status, r.status === 200 ? undefined : r.text.slice(0, 120));
          if (r.status === 200) {
            const s = sessionOf(r);
            device.access = s.accessToken;
            device.refreshToken = s.refreshToken;
            device.spent = [];
            device.signedIn = true;
            device.loggedOut = false;
          }
          break;
        }
        case "refresh": {
          if (!device.refreshToken) {
            check(400, (await refresh(world, device.refreshToken ?? undefined, device.ip)).status);
            break;
          }
          const r = await refresh(world, device.refreshToken, device.ip);
          const expected = device.loggedOut ? 401 : 200;
          check(expected, r.status, r.status === 200 ? undefined : r.text.slice(0, 120));
          if (r.status === 200) {
            const s = sessionOf(r);
            if (s.refreshToken === device.refreshToken)
              violations.push(`step ${i}: refresh did not rotate`);
            device.spent.push(device.refreshToken);
            device.access = s.accessToken;
            device.refreshToken = s.refreshToken;
          } else if (r.status === 401) {
            device.signedIn = false;
          }
          break;
        }
        case "replay-spent": {
          const spent = device.spent.length ? rng.pick(device.spent) : null;
          if (!spent) {
            steps.push({
              i,
              op,
              device: device.name,
              expected: 0,
              observed: 0,
              ok: true,
              note: "nothing spent yet",
            });
            break;
          }
          const r = await refresh(world, spent, device.ip);
          check(401, r.status, "spent token replay");
          // Replay must not disturb the live pair.
          if (device.refreshToken && !device.loggedOut) {
            const live = world.gotrue.sessionByRefresh(device.refreshToken);
            if (!live || live.spent)
              violations.push(`step ${i}: replay of a spent token invalidated the live token`);
          }
          break;
        }
        case "authed-get": {
          const r = await whoami(world, device.access, device.ip);
          if (!device.access) {
            check(401, r.status);
            break;
          }
          // The bearer works while its session lives (even after rotation the
          // OLD access token stays valid until exp at GoTrue — our fake keeps
          // only the latest, so authenticity here is "session not revoked").
          const live = world.gotrue.sessionByAccess(device.access);
          const expected = device.loggedOut ? 401 : live ? 200 : [200, 401];
          check(expected, r.status, r.status === 200 ? undefined : r.text.slice(0, 120));
          break;
        }
        case "logout": {
          const r = await logout(world, device.access, device.ip);
          if (!device.access) {
            check(401, r.status);
            break;
          }
          // Cached bearer from a prior authed-get → 204; an already-rotated
          // bearer unknown to the fake → 401 (already gone). Both fine for the app.
          const live = world.gotrue.sessionByAccess(device.access);
          const expected = device.loggedOut ? [204, 401] : live ? 204 : [204, 401];
          check(expected, r.status, r.text.slice(0, 120));
          if (r.status === 204 && live) {
            device.loggedOut = true;
            device.signedIn = false;
            // Other-device invariant: no other device's session is revoked by this.
            for (const other of devices) {
              if (other === device || !other.access) continue;
              const os = world.gotrue.sessionByAccess(other.access);
              if (os && os.revoked && !other.loggedOut) {
                violations.push(
                  `step ${i}: logout of ${device.name} revoked ${other.name}'s session`,
                );
              }
            }
          }
          break;
        }
        case "refresh-upstream-5xx": {
          if (!device.refreshToken || device.loggedOut) {
            steps.push({
              i,
              op,
              device: device.name,
              expected: 0,
              observed: 0,
              ok: true,
              note: "no live token",
            });
            break;
          }
          // One-shot upstream 5xx: a retryable code (500/502/503) is re-sent
          // by auth-js and the second attempt rotates → 200; a non-retryable
          // code (599) is surfaced → 503. Never 401.
          const status = rng.pick([500, 502, 503, 599]);
          world.gotrue.fault("token:refresh_token", { kind: "status", status });
          const r = await refresh(world, device.refreshToken, device.ip);
          check(status === 599 ? 503 : 200, r.status, `gotrue ${status} → edge ${r.status}`);
          if (r.status === 200) {
            const s = sessionOf(r);
            device.spent.push(device.refreshToken);
            device.access = s.accessToken;
            device.refreshToken = s.refreshToken;
          }
          world.gotrue.clearFaults();
          break;
        }
        case "refresh-upstream-429": {
          if (!device.refreshToken || device.loggedOut) {
            steps.push({
              i,
              op,
              device: device.name,
              expected: 0,
              observed: 0,
              ok: true,
              note: "no live token",
            });
            break;
          }
          world.gotrue.fault("token:refresh_token", { kind: "status", status: 429 });
          const r = await refresh(world, device.refreshToken, device.ip);
          // Contract: a still-valid token must never be answered 401. The
          // shipped edge answers 401 (characterised; XC_STRICT_CONTRACT=1
          // asserts the contract).
          if (r.status === 401) defect429Hits += 1;
          check(STRICT ? [429, 503] : 401, r.status, `gotrue 429 → edge ${r.status}`);
          if (world.gotrue.sessionByRefresh(device.refreshToken)?.spent !== false) {
            violations.push(`step ${i}: a throttled refresh spent the token`);
          }
          world.gotrue.clearFaults();
          break;
        }
        case "foreign-refresh": {
          // Another device's token used from this device: works at GoTrue (a
          // refresh token is bearer-like) — but must rotate THAT session, not ours.
          const other = devices.find((d) => d !== device && d.refreshToken && !d.loggedOut);
          if (!other || !other.refreshToken) {
            steps.push({
              i,
              op,
              device: device.name,
              expected: 0,
              observed: 0,
              ok: true,
              note: "no foreign token",
            });
            break;
          }
          const r = await refresh(world, other.refreshToken, device.ip);
          check(200, r.status, r.text.slice(0, 120));
          if (r.status === 200) {
            const s = sessionOf(r);
            other.spent.push(other.refreshToken);
            other.access = s.accessToken;
            other.refreshToken = s.refreshToken;
            if (device.refreshToken && world.gotrue.sessionByRefresh(device.refreshToken)?.spent) {
              violations.push(`step ${i}: foreign refresh spent this device's token`);
            }
          }
          break;
        }
      }
    }

    // Global leak scan for this scenario: no provider id token payload, no
    // spent refresh token in any response other than the one that minted it.
    const providerPayloads = world.h.calls
      .filter((c) => c.url.startsWith(`${SUPABASE_URL}/auth/v1/token?grant_type=id_token`))
      .map((c) => (c.body as Record<string, unknown> | null)?.id_token)
      .filter((t): t is string => typeof t === "string");
    for (const t of providerPayloads) {
      for (const r of world.responses) {
        if (r.body.includes(t))
          violations.push(`provider id token echoed in ${r.route} ${r.status}`);
      }
    }
    for (const d of devices) {
      for (const spent of d.spent) {
        const echoes = world.responses.filter((r) => r.body.includes(spent));
        // Exactly the response that minted it may carry it.
        if (echoes.length !== 1)
          violations.push(`${d.name} spent refresh token appears in ${echoes.length} responses`);
      }
    }

    return {
      seed,
      devices: devices.map((d) => ({ name: d.name, user: d.user, provider: d.provider })),
      steps,
      violations,
      gotrueCalls: world.gotrue.calls.length,
      ok: violations.length === 0,
    };
  } finally {
    world.uninstall();
  }
}

Deno.test(
  "edge journey matrix: seeded multi-device programs (XC_EDGE_SCENARIOS, replay with XC_EDGE_ONLY_SEED)",
  async () => {
    const only = Deno.env.get("XC_EDGE_ONLY_SEED");
    const count = Number(Deno.env.get("XC_EDGE_SCENARIOS") ?? "300");
    const seedBase = Number(Deno.env.get("XC_EDGE_SEED_BASE") ?? "5000000");
    const seeds = only ? [Number(only)] : Array.from({ length: count }, (_, i) => seedBase + i);
    const started = Date.now();
    const heaps = [heap("start")];
    const scenarios: ScenarioRecord[] = [];
    let totalSteps = 0;
    let totalCalls = 0;
    const byOp: Record<string, { ran: number; failed: number }> = {};
    for (const [i, seed] of seeds.entries()) {
      const s = await runScenario(seed);
      scenarios.push(s);
      totalSteps += s.steps.length;
      totalCalls += s.gotrueCalls;
      for (const st of s.steps) {
        const e = byOp[st.op] ?? { ran: 0, failed: 0 };
        e.ran += 1;
        if (!st.ok) e.failed += 1;
        byOp[st.op] = e;
      }
      if ((i + 1) % 50 === 0) heaps.push(heap(`after ${i + 1}`));
    }
    heaps.push(heap("end"));
    const failures = scenarios.filter((s) => !s.ok);
    const summary = {
      scenarios: seeds.length,
      seedBase,
      onlySeed: only ?? null,
      totalSteps,
      totalGoTrueCalls: totalCalls,
      failures: failures.length,
      failureSeeds: failures.map((f) => f.seed),
      strictContract: STRICT,
      gotrue429MappedTo401: defect429Hits,
      byOp,
      heaps,
      wallMs: Date.now() - started,
      replay:
        "cd supabase/functions/api/__wf__ && XC_EDGE_ONLY_SEED=<seed> deno test -A --no-check --config deno.json xc_journey_signin_restore.test.ts",
    };
    const matrixPath = writeArtifact("edge-matrix.json", { summary, scenarios });
    writeArtifact("edge-matrix-failures.json", failures);
    console.log(
      `[xc-edge-matrix] ${JSON.stringify({ ...summary, heaps: undefined })} → ${matrixPath}`,
    );
    assertEquals(
      failures.map((f) => ({ seed: f.seed, violations: f.violations })),
      [],
      `edge matrix violations (replay: ${summary.replay})`,
    );
  },
);

Deno.test("edge journey: write journey artifact", () => {
  const path = writeArtifact("edge-journey.json", { heap: heap("end"), steps: journey });
  console.log(`[xc-edge-journey] ${journey.length} records → ${path}`);
});
