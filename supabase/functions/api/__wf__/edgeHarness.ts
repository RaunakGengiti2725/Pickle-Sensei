// Test harness: boots the real edge function (index.ts → Deno.serve on :8000)
// against a fake Supabase (Auth + PostgREST) so router behaviour can be
// asserted end-to-end without a project. The fake records every PostgREST
// request so tests can inspect exactly what the function would write.
//
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const API_BASE = "http://127.0.0.1:8000";

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
 * fake Auth server's job here; the function only routes on `iss`. */
export function fakeGoogleIdToken(subject = "probe"): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: "https://accounts.google.com",
      sub: subject,
      aud: "test",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
    }),
  );
  return `${header}.${payload}.${b64url("sig")}`;
}

async function fakeSupabase(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/auth/v1/token") {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return restJson(200, {
      access_token: "fake-session-access-token",
      token_type: "bearer",
      expires_in: 3600,
      expires_at: nowSeconds + 3600,
      refresh_token: "fake-refresh",
      user: { id: USER_ID, email: "probe@example.com", aud: "authenticated" },
    });
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
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const res = await fetch(`${API_BASE}/healthz`);
        await res.body?.cancel();
        if (res.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("edge function did not start on :8000");
  })();
  return booted;
}

export function authedInit(init: RequestInit = {}, token = fakeGoogleIdToken()): RequestInit {
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
