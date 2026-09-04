// Boots the REAL edge function (index.ts) on 127.0.0.1:8000 against a fake
// Supabase whose Auth REFUSES every credential, so k6 abuse tests written for
// the hosted API — tools/loadtest/auth-abuse.js — can be executed on Linux with
// no project, no credentials and no network egress, and every response is
// decided by the production pre-auth pipeline (per-IP budget → auth-failure
// peek → authenticate → 401 / 429).
//
//   deno run -A --no-check tools/adversarial/rate-limit-dos/serve_local_edge.ts &
//   k6 run -e BASE_URL=http://127.0.0.1:8000 tools/loadtest/auth-abuse.js
//
// Redis is unconfigured on purpose (the documented per-isolate memory path,
// which is also what a project without UPSTASH_* secrets runs).

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let authCalls = 0;
let restCalls = 0;

function fakeSupabase(request: Request): Response {
  const url = new URL(request.url);
  if (url.pathname === "/__stats") {
    return json(200, { authCalls, restCalls });
  }
  if (url.pathname.startsWith("/auth/v1/")) {
    authCalls += 1;
    // GoTrue's shape for a bad id_token / bad bearer.
    return json(401, {
      code: 401,
      msg: "invalid JWT: unable to parse or verify signature",
    });
  }
  if (url.pathname.startsWith("/rest/v1/")) {
    restCalls += 1;
    return json(200, []);
  }
  return json(404, { message: `fake supabase: unhandled ${url.pathname}` });
}

const fake = Deno.serve(
  { hostname: "127.0.0.1", port: 0, onListen: () => {} },
  fakeSupabase,
);
Deno.env.set("SUPABASE_URL", `http://127.0.0.1:${fake.addr.port}`);
Deno.env.set("SUPABASE_ANON_KEY", "fake-anon-key");
Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
Deno.env.delete("UPSTASH_REDIS_REST_URL");
Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

await import("../../../supabase/functions/api/index.ts");
for (let attempt = 0; attempt < 50; attempt += 1) {
  try {
    const res = await fetch("http://127.0.0.1:8000/healthz");
    await res.body?.cancel();
    if (res.ok) break;
  } catch {
    // not listening yet
  }
  await new Promise((r) => setTimeout(r, 100));
}
console.log(
  `local edge function ready on http://127.0.0.1:8000 ` +
    `(fake Supabase on :${fake.addr.port} refusing all auth; stats at /__stats; no Redis)`,
);
await new Promise(() => {});
