// Test harness: boots the real edge function (index.ts → Deno.serve on :8000)
// against a fake Supabase (Auth + PostgREST) so router behaviour can be
// asserted end-to-end without a project. The fake records every PostgREST
// request so tests can inspect exactly what the function would write.
//
// Bearer contract mirrored by the fake Auth: `bootEdgeFunction()` spends a
// provider ID token once on `POST /v1/account/bootstrap`; the session access
// token it returns (`sessionAccessToken()`) is what `authedInit()` bears by
// default, verified by the fake `/auth/v1/user`. A provider ID token on any
// other route is a 401.
//
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const API_BASE = "http://127.0.0.1:8000";

/** Access tokens the fake Supabase Auth considers live (minted by its
 * `/auth/v1/token`, revoked by its `/auth/v1/logout`). */
export const liveSessions = new Set<string>();

/** How many times the function asked the fake Auth to exchange an ID token
 * (`/auth/v1/token?grant_type=id_token`). */
export const authCalls: string[] = [];

let bootstrappedAccessToken = "";

/** The session access token `bootEdgeFunction()` obtained from bootstrap. */
export function sessionAccessToken(): string {
  if (!bootstrappedAccessToken) {
    throw new Error("sessionAccessToken(): await bootEdgeFunction() first");
  }
  return bootstrappedAccessToken;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: string;
}

export const recorded: RecordedRequest[] = [];

/** Per-test PostgREST responder. Return null to fall through to the default
 * (200 `[]`, or `{}` for single-object requests). */
export type RestResponder = (req: RecordedRequest) => Response | null | Promise<Response | null>;
let responder: RestResponder = () => null;
export function setRestResponder(fn: RestResponder): void {
  responder = fn;
}
export function resetRest(): void {
  responder = () => null;
  recorded.length = 0;
}

export function restJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function wantsSingleObject(req: RecordedRequest): boolean {
  return (req.headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid (unsigned) Google ID token. Verification is the
 * fake Auth server's job here; the function only routes on `iss`. Accepted
 * by `POST /v1/account/bootstrap` alone. */
export function fakeGoogleIdToken(subject = "probe"): string {
  return fakeProviderIdToken("https://accounts.google.com", subject);
}

export function fakeAppleIdToken(subject = "probe"): string {
  return fakeProviderIdToken("https://appleid.apple.com", subject);
}

function fakeProviderIdToken(iss: string, subject: string): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss,
      sub: subject,
      aud: "test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  );
  return `${header}.${payload}.${b64url("sig")}`;
}

const fakeUser = () => ({
  id: USER_ID,
  email: "probe@example.com",
  aud: "authenticated",
  role: "authenticated",
  app_metadata: { provider: "google", providers: ["google"] },
});

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/v1/token") {
    authCalls.push(`${url.pathname}?${url.searchParams.toString()}`);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessToken = [
      b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
      b64url(
        JSON.stringify({
          iss: `${Deno.env.get("SUPABASE_URL")}/auth/v1`,
          sub: USER_ID,
          aud: "authenticated",
          role: "authenticated",
          exp: nowSeconds + 3600,
          jti: crypto.randomUUID(),
        }),
      ),
      b64url("sig"),
    ].join(".");
    liveSessions.add(accessToken);
    return restJson(200, {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: nowSeconds + 3600,
      refresh_token: `refresh-for-${accessToken}`,
      user: fakeUser(),
    });
  }
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
  if (url.pathname === "/auth/v1/user" && request.method === "GET") {
    if (!liveSessions.has(bearer)) {
      return restJson(401, { code: 401, msg: "invalid JWT: session not found" });
    }
    return restJson(200, fakeUser());
  }
  if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
    if (!liveSessions.delete(bearer)) {
      return restJson(401, { code: 401, msg: "invalid JWT: session not found" });
    }
    return new Response(null, { status: 204 });
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    const rec: RecordedRequest = {
      method: request.method,
      path: url.pathname.slice("/rest/v1/".length),
      query: url.searchParams,
      headers: request.headers,
      body: await request.text(),
    };
    recorded.push(rec);
    const custom = await responder(rec);
    if (custom) return custom;
    return restJson(200, wantsSingleObject(rec) ? {} : []);
  }
  return restJson(404, { message: `fake supabase: unhandled ${url.pathname}` });
}

let booted: Promise<void> | null = null;

/** Start the fake Supabase, point the function at it, import index.ts (which
 * calls Deno.serve) and wait until /healthz answers. Idempotent. */
export function bootEdgeFunction(): Promise<void> {
  if (booted) return booted;
  booted = (async () => {
    const fake = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen: () => {} }, fakeSupabase);
    Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${fake.addr.port}`);
    Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
    Deno.env.delete("UPSTASH_REDIS_REST_URL");
    Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
    await import("../index.ts");
    let listening = false;
    for (let attempt = 0; attempt < 50 && !listening; attempt += 1) {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        await res.body?.cancel();
        listening = res.ok;
      } catch {
        // not listening yet
      }
      if (!listening) await new Promise((r) => setTimeout(r, 100));
    }
    if (!listening) throw new Error("edge function did not start on :8000");

    // Bootstrap reads the caller's profile row; stage one for the duration.
    const profileRow = {
      id: USER_ID,
      email: "probe@example.com",
      provider: "google",
      onboarding_state: "complete",
    };
    setRestResponder((req) =>
      req.path === "profiles" && req.method === "GET"
        ? restJson(200, wantsSingleObject(req) ? profileRow : [profileRow])
        : null,
    );
    const bootstrap = await fetch(`${API_BASE}/v1/account/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fakeGoogleIdToken()}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    if (bootstrap.status !== 200) {
      throw new Error(`harness bootstrap failed: ${bootstrap.status} ${await bootstrap.text()}`);
    }
    const body = (await bootstrap.json()) as { session?: { accessToken?: unknown } };
    if (typeof body.session?.accessToken !== "string" || !body.session.accessToken) {
      throw new Error("harness bootstrap returned no session access token");
    }
    bootstrappedAccessToken = body.session.accessToken;
    resetRest();
    authCalls.length = 0;
  })();
  return booted;
}

export function authedInit(init: RequestInit = {}, token = sessionAccessToken()): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
}

/** A streamed request body (no Content-Length): `totalBytes` of `fill`
 * inside `prefix`…`suffix`, so the JSON stays valid. */
export function streamedJsonBody(
  prefix: string,
  suffix: string,
  totalBytes: number,
  fill = "x",
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunk = encoder.encode(fill.repeat(64 * 1024));
  let sent = 0;
  let started = false;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(prefix));
        return;
      }
      if (sent < totalBytes) {
        const remaining = totalBytes - sent;
        const piece = remaining >= chunk.length ? chunk : chunk.subarray(0, remaining);
        controller.enqueue(piece);
        sent += piece.length;
        return;
      }
      if (!finished) {
        finished = true;
        controller.enqueue(encoder.encode(suffix));
        controller.close();
      }
    },
  });
}
