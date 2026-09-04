// Minimal Supabase PostgREST stand-in for the RevenueCat webhook path of the
// REAL edge function (supabase/functions/api/index.ts). The shipped
// __wf__/supabase_stub.ts answers 404 for `webhook_events`, so idempotency
// cannot be observed through it; this stub keeps an in-memory
// `webhook_events` table with the exact PostgREST semantics the function
// relies on:
//   GET  /rest/v1/webhook_events?select=id&id=eq.<id>   → [] | [{id}]
//   POST /rest/v1/webhook_events?on_conflict=id         → 201 (Prefer:
//        resolution=ignore-duplicates keeps the first row, like ON CONFLICT
//        DO NOTHING)
// Everything else → 404, counted under "unhandled".
//
//   STUB_PORT (default 54399)   STUB_DB_LATENCY_MS (default 20)
//
// Introspection:  GET /__stub/state  → { rows, counters }
//                 POST /__stub/reset → clear rows + counters
const PORT = Number(Deno.env.get("STUB_PORT") ?? "54399");
const DB_LATENCY_MS = Number(Deno.env.get("STUB_DB_LATENCY_MS") ?? "20");

const rows = new Map<string, Record<string, unknown>>();
const counters = new Map<string, number>();
const bump = (k: string) => counters.set(k, (counters.get(k) ?? 0) + 1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, async (request) => {
  const url = new URL(request.url);
  if (url.pathname === "/__stub/state") {
    return json(200, {
      rows: [...rows.values()],
      counters: Object.fromEntries([...counters.entries()].sort()),
    });
  }
  if (url.pathname === "/__stub/reset") {
    rows.clear();
    counters.clear();
    return json(200, { ok: true });
  }
  if (url.pathname === "/rest/v1/webhook_events") {
    bump(`db:${request.method} webhook_events`);
    await sleep(DB_LATENCY_MS);
    if (request.method === "GET") {
      const eq = url.searchParams.get("id") ?? "";
      const id = eq.startsWith("eq.") ? eq.slice(3) : null;
      const hit = id !== null ? rows.get(id) : undefined;
      return json(200, hit ? [{ id: hit.id }] : []);
    }
    if (request.method === "POST") {
      const prefer = request.headers.get("prefer") ?? "";
      const body = (await request.json()) as Record<string, unknown> | Record<string, unknown>[];
      const list = Array.isArray(body) ? body : [body];
      for (const row of list) {
        const id = String(row.id);
        if (rows.has(id)) {
          bump("db:webhook_events conflict");
          if (!prefer.includes("ignore-duplicates")) rows.set(id, row);
        } else {
          rows.set(id, row);
          bump("db:webhook_events inserted");
        }
      }
      return new Response(null, { status: 201 });
    }
  }
  bump(`unhandled:${request.method} ${url.pathname}`);
  return json(404, { message: `webhook_stub: unhandled ${request.method} ${url.pathname}` });
});
