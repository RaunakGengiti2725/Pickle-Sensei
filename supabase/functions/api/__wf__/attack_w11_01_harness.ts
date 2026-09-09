// Adversarial scaffolding for W11-01 (auth-failure budgets behind NAT).
// Black-box only: the real handler from index.ts (captured by routesHarness)
// in front of a scripted GoTrue that knows which access/refresh tokens it
// minted, which it has since killed, and refuses everything else as a guess.
// Nothing here touches candidate production code or the candidate's tests.

import {
  fakeSupabaseAccessToken,
  loadHarness,
  type RecordedCall,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

export const BUDGET = { limit: 30, windowSeconds: 300 };
export const PROBE = "/v1/me/consent/status";

export type Json = Record<string, unknown>;

export const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export const b64url = (text: string) =>
  btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function jwtSub(token: string): string {
  try {
    const segment = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const sub = JSON.parse(atob(segment)).sub;
    return typeof sub === "string" ? sub : "";
  } catch {
    return "";
  }
}

/** A Supabase-issued session bearer whose own `exp` is in the past: the edge
 * refuses it locally, before Auth. */
export function expiredSessionBearer(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${Deno.env.get("SUPABASE_URL") ?? "https://test.supabase.co"}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      session_id: crypto.randomUUID(),
      exp: Math.floor(Date.now() / 1000) - 60,
    }),
  );
  return `${header}.${payload}.sig`;
}

/** A distinct Google ID token per handset (real ones carry a fresh jti). */
export function handsetIdToken(sub = TEST_USER_ID): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
      jti: crypto.randomUUID(),
    }),
  );
  return `${header}.${payload}.sig`;
}

export const forgedBearer = () => fakeSupabaseAccessToken(crypto.randomUUID());

export const profile = () => ({
  id: TEST_USER_ID,
  email: "user@example.com",
  provider: "google",
  onboarding_state: "complete",
});

export function frozenClock(): () => void {
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  return () => {
    Date.now = realNow;
  };
}

/** A clock pinned just past the start of an auth-failure window that the test
 * can step forward or backward. */
export function pinnedClock(): {
  advance: (ms: number) => void;
  set: (ms: number) => void;
  now: () => number;
  restore: () => void;
} {
  const realNow = Date.now;
  const windowMs = BUDGET.windowSeconds * 1000;
  let now = Math.floor(realNow() / windowMs) * windowMs + 1000;
  Date.now = () => now;
  return {
    advance: (ms) => {
      now += ms;
    },
    set: (ms) => {
      now = ms;
    },
    now: () => now,
    restore: () => {
      Date.now = realNow;
    },
  };
}

/** GoTrue stand-in. `userStatus` other than 200 makes GET /user answer that
 * status with a service-style body (an outage, never a verdict). */
export class ScriptedAuth {
  readonly live = new Set<string>();
  readonly dead = new Set<string>();
  readonly refreshable = new Map<string, string>();
  tokenGrants = 0;
  userChecks = 0;
  userStatus = 200;

  mint(sub = TEST_USER_ID): Json & { access_token: string; refresh_token: string } {
    const accessToken = fakeSupabaseAccessToken(sub);
    const refreshToken = `rt-${crypto.randomUUID()}`;
    this.live.add(accessToken);
    this.refreshable.set(refreshToken, sub);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: refreshToken,
      user: this.user(sub),
    };
  }

  user(sub: string): Json {
    return {
      id: sub,
      aud: "authenticated",
      role: "authenticated",
      email: "user@example.com",
      app_metadata: { provider: "google", providers: ["google"] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  /** Sign the session out upstream: the access token is dead, the refresh
   * token row is gone. */
  signOut(accessToken: string, refreshToken: string) {
    this.live.delete(accessToken);
    this.dead.add(accessToken);
    this.refreshable.delete(refreshToken);
  }

  respond = (call: RecordedCall): Response | null => {
    const url = new URL(call.url);
    if (!url.pathname.startsWith("/auth/v1/")) return null;
    const body = (call.body ?? {}) as Json;
    if (url.pathname === "/auth/v1/token") {
      this.tokenGrants += 1;
      const grant = url.searchParams.get("grant_type");
      if (grant === "id_token") {
        const token = typeof body.id_token === "string" ? body.id_token : "";
        const sub = jwtSub(token);
        if (sub !== TEST_USER_ID) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
            error_code: "bad_id_token",
          });
        }
        return jsonResponse(200, this.mint(sub));
      }
      if (grant === "refresh_token") {
        const presented = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const sub = this.refreshable.get(presented);
        if (sub === undefined) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Invalid Refresh Token: Refresh Token Not Found",
            error_code: "refresh_token_not_found",
          });
        }
        this.refreshable.delete(presented);
        return jsonResponse(200, this.mint(sub));
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/auth/v1/user" && call.method === "GET") {
      this.userChecks += 1;
      if (this.userStatus !== 200) {
        return jsonResponse(this.userStatus, { message: "service unavailable" });
      }
      const bearer = (call.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (this.live.has(bearer)) return jsonResponse(200, this.user(jwtSub(bearer)));
      if (this.dead.has(bearer)) {
        return jsonResponse(401, {
          code: 401,
          error_code: "session_not_found",
          msg: "Session from session_id claim in JWT does not exist",
        });
      }
      return jsonResponse(401, {
        code: 401,
        error_code: "bad_jwt",
        msg: "invalid JWT: unable to parse or verify signature",
      });
    }
    return null;
  };
}

export interface Wired {
  h: Awaited<ReturnType<typeof loadHarness>>;
  auth: ScriptedAuth;
  call: (request: Request) => Promise<{
    status: number;
    retryAfter: string | null;
    body: Json | null;
  }>;
  bootstrap: (ip: string) => Promise<{ accessToken: string; refreshToken: string }>;
  refresh: (
    ip: string,
    refreshToken: string,
    bearer?: string,
  ) => Promise<{
    status: number;
    retryAfter: string | null;
    body: Json | null;
  }>;
  probe: (ip: string, token: string) => Promise<{ status: number; retryAfter: string | null }>;
}

export async function wire(): Promise<Wired> {
  const h = await loadHarness();
  h.reset();
  const auth = new ScriptedAuth();
  h.respond = auth.respond;
  h.tables.profiles = [profile()];
  const call = async (request: Request) => {
    const response = await h.handler(request);
    const status = response.status;
    const retryAfter = response.headers.get("Retry-After");
    const body = (await response.json().catch(() => null)) as Json | null;
    return { status, retryAfter, body };
  };
  const bootstrap = async (ip: string) => {
    const res = await call(
      userRequest("POST", "/v1/account/bootstrap", { token: handsetIdToken(), ip, body: {} }),
    );
    if (res.status !== 200) {
      throw new Error(`bootstrap → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return (res.body as { session: { accessToken: string; refreshToken: string } }).session;
  };
  const refresh = (ip: string, refreshToken: string, bearer?: string) =>
    call(
      userRequest("POST", "/v1/auth/refresh", {
        ip,
        body: { refreshToken },
        ...(bearer === undefined ? {} : { token: bearer }),
      }),
    );
  const probe = async (ip: string, token: string) => {
    const res = await call(userRequest("GET", PROBE, { token, ip }));
    return { status: res.status, retryAfter: res.retryAfter };
  };
  return { h, auth, call, bootstrap, refresh, probe };
}
