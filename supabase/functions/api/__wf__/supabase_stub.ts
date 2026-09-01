// Minimal Supabase (Auth + PostgREST) stand-in used to run the REAL edge
// function (supabase/functions/api/index.ts) locally under k6 without a
// Supabase stack. It counts every upstream call so a load run can show how
// many Auth exchanges / DB queries the function actually issues.
//
//   deno run --allow-net --allow-env supabase/functions/api/__wf__/supabase_stub.ts
//
//   env STUB_PORT           (default 54399)
//       STUB_DB_LATENCY_MS  simulated Postgres round trip (default 20)
//       STUB_AUTH_LATENCY_MS simulated Supabase Auth round trip (default 60)
//
// Token contract (mirrors what the function expects from a provider ID
// token): the bearer must be a 3-part JWT whose payload has
//   iss = https://accounts.google.com | https://appleid.apple.com
//   sub = "user-<n>"  → accepted (user id = deterministic uuid of <n>)
//   anything else     → 400 invalid_grant (like GoTrue for a bad token)
// Signature is not checked — this is a stub, not an IdP.
//
// Introspection:  GET  /__stub/stats   → counters per upstream path
//                 POST /__stub/reset   → zero the counters

const PORT = Number(Deno.env.get("STUB_PORT") ?? "54399");
const DB_LATENCY_MS = Number(Deno.env.get("STUB_DB_LATENCY_MS") ?? "20");
const AUTH_LATENCY_MS = Number(Deno.env.get("STUB_AUTH_LATENCY_MS") ?? "60");

const counters = new Map<string, number>();
function bump(key: string): void {
  counters.set(key, (counters.get(key) ?? 0) + 1);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function decodePayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function userUuid(sub: string): string {
  const n = sub.slice("user-".length).padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${n.replace(/[^0-9a-f]/g, "0")}`;
}

function b64url(value: string): string {
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function accessTokenFor(userId: string, expSeconds: number): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ sub: userId, role: "authenticated", aud: "authenticated", exp: expSeconds }),
  );
  return `${header}.${payload}.stubsig`;
}

async function handleAuthToken(request: Request): Promise<Response> {
  bump("auth:/auth/v1/token");
  await sleep(AUTH_LATENCY_MS);
  let body: { id_token?: string; provider?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // fallthrough → invalid
  }
  const payload = body.id_token ? decodePayload(body.id_token) : null;
  const sub = typeof payload?.sub === "string" ? payload.sub : "";
  const exp = typeof payload?.exp === "number" ? payload.exp : 0;
  const now = Math.floor(Date.now() / 1_000);
  if (!sub.startsWith("user-") || (exp > 0 && exp <= now)) {
    bump("auth:rejected");
    return json(400, {
      error: "invalid_grant",
      error_code: "bad_jwt",
      msg: "Invalid or expired ID token",
    });
  }
  bump("auth:accepted");
  const id = userUuid(sub);
  const expiresIn = 3_600;
  return json(200, {
    access_token: accessTokenFor(id, now + expiresIn),
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: now + expiresIn,
    refresh_token: `refresh-${id}`,
    user: {
      id,
      aud: "authenticated",
      role: "authenticated",
      email: `${sub}@example.test`,
      app_metadata: { provider: body.provider ?? "google", providers: [body.provider ?? "google"] },
      user_metadata: {},
      identities: [],
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  });
}

function bearerUserId(request: Request): string | null {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = decodePayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

async function handleRest(request: Request, url: URL): Promise<Response> {
  const path = url.pathname.replace(/^\/rest\/v1/, "");
  bump(`db:${request.method} ${path}`);
  await sleep(DB_LATENCY_MS);
  const uid = bearerUserId(request);
  if (!uid) return json(401, { message: "JWT required" });

  if (path === "/rpc/access_state") {
    return json(200, [{ premium: false, scored_count: 0, reserved_count: 0 }]);
  }
  if (path === "/profiles") {
    if (request.method === "GET") {
      const row = {
        id: uid,
        email: `${uid}@example.test`,
        onboarding_state: "complete",
        provider: "google",
        skill_level: "beginner",
        handedness: "right",
        primary_goal: null,
        biggest_problem: null,
        focus_checkpoint: null,
        first_name: null,
        gender: null,
      };
      const single = (request.headers.get("accept") ?? "").includes("application/vnd.pgrst.object");
      return json(200, single ? row : [row]);
    }
    return new Response(null, { status: 204 });
  }
  if (
    path === "/player_technique_rating" ||
    path === "/progress_daily" ||
    path === "/practice_days" ||
    path === "/user_saved_drills"
  ) {
    return json(200, []);
  }
  if (path === "/player_rank_state") {
    const single = (request.headers.get("accept") ?? "").includes("application/vnd.pgrst.object");
    return single
      ? new Response("null", { status: 200, headers: { "content-type": "application/json" } })
      : json(200, []);
  }
  if (path === "/rpc/apply_synced_shot") {
    return json(200, { result: "accepted", shot_id: null });
  }
  if (path === "/shots" && request.method === "GET") {
    return json(200, []);
  }
  bump("db:unhandled");
  return json(404, { message: `stub: unhandled ${request.method} ${path}` });
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__stub/stats") {
    return json(200, Object.fromEntries([...counters.entries()].sort()));
  }
  if (url.pathname === "/__stub/reset") {
    counters.clear();
    return json(200, { ok: true });
  }
  if (url.pathname === "/auth/v1/token") return handleAuthToken(request);
  if (url.pathname.startsWith("/rest/v1/")) return handleRest(request, url);
  bump(`unhandled:${url.pathname}`);
  return json(404, { message: "stub: unhandled route" });
});
