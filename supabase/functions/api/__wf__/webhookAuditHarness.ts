/**
 * Structural-audit harness for POST /webhooks/revenuecat (audit pass 1 of 3,
 * subsystem edge-billing-webhook). Unlike routesHarness.ts, this harness
 * PERSISTS PostgREST writes into an in-memory store so the check-then-act
 * dedupe (`select id from webhook_events` → process → `upsert ...
 * ignore-duplicates`) and the entitlement upsert can be observed the way a
 * real database would observe them. It also exposes an `intercept` hook so a
 * test can inject PostgREST failures (transient 5xx, FK 23503, ...) and a
 * `restLatencyMs` knob so concurrent deliveries actually interleave.
 *
 * `index.ts` is imported with a distinct query-string specifier so this
 * harness gets its OWN module instance (own lazy service-role client bound to
 * THIS fetch stub) and never disturbs routesHarness-based test files that may
 * run in the same `deno test` process.
 *
 * Audit-only: this file is new; no production code or existing test changed.
 */

export const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";
export const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";
export const WEBHOOK_SECRET = "wf-audit-webhook-secret";
export const SERVICE_ROLE_KEY = "service-role-audit-key";
export const SUPABASE_URL = "http://supabase.audit.test";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
export const EDGE_BASE = "http://edge.audit.test/functions/v1/api";

export interface AuditCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /** Query string parsed from `url` (PostgREST filters live here). */
  query: URLSearchParams;
}

export type SubscriberSource =
  | Record<string, unknown>
  | null
  | ((appUserId: string) => Record<string, unknown> | Response | null);

export interface AuditHarness {
  handler(request: Request): Promise<Response>;
  calls: AuditCall[];
  callsTo(fragment: string): AuditCall[];
  /** Persisted `public.webhook_events` rows keyed by `id` (text primary key). */
  webhookEvents: Map<string, Record<string, unknown>>;
  /** Persisted `public.billing_entitlements` rows keyed by `user_id`. */
  billingEntitlements: Map<string, Record<string, unknown>>;
  /** RevenueCat subscriber answer; null = upstream 500; function = per user. */
  subscriber: SubscriberSource;
  /** Return a Response to override any PostgREST request (failure injection). */
  intercept: ((call: AuditCall, table: string) => Response | undefined) | null;
  /** Artificial latency applied to every stubbed upstream response. */
  restLatencyMs: number;
  /** console.error / console.warn lines captured while the harness is live. */
  logs: string[];
  reset(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const pgrstError = (status: number, code: string, message: string): Response =>
  jsonResponse(status, { code, message, details: null, hint: null });

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

let harness: AuditHarness | null = null;

export async function loadAuditHarness(): Promise<AuditHarness> {
  if (harness) {
    harness.reset();
    return harness;
  }

  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", "anon-audit-key");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_audit_revenuecat");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const state: AuditHarness = {
    handler: () => Promise.reject(new Error("handler not captured")),
    calls: [],
    webhookEvents: new Map(),
    billingEntitlements: new Map(),
    subscriber: {},
    intercept: null,
    restLatencyMs: 0,
    logs: [],
    reset() {
      state.calls = [];
      state.webhookEvents = new Map();
      state.billingEntitlements = new Map();
      state.subscriber = {};
      state.intercept = null;
      state.restLatencyMs = 0;
      state.logs = [];
    },
    callsTo(fragment: string) {
      return state.calls.filter((call) => call.url.includes(fragment));
    },
  };

  const originalError = console.error;
  const originalWarn = console.warn;
  // Capture AND forward so other test files in the same process see exactly
  // the console behaviour they always had.
  const capture =
    (level: string, forward: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      state.logs.push(
        `${level} ${args
          .map((a) =>
            typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a),
          )
          .join(" ")}`,
      );
      forward(...args);
    };
  console.error = capture("error", originalError);
  console.warn = capture("warn", originalWarn);

  const restTable = (url: URL): string => url.pathname.slice("/rest/v1/".length);

  const upsertRows = (
    store: Map<string, Record<string, unknown>>,
    key: string,
    body: unknown,
    prefer: string,
  ): Response => {
    const rows = Array.isArray(body) ? body : isRecord(body) ? [body] : [];
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const id = String(row[key]);
      const exists = store.has(id);
      if (exists && prefer.includes("resolution=ignore-duplicates")) continue;
      if (exists && !prefer.includes("resolution=merge-duplicates")) {
        return pgrstError(409, "23505", `duplicate key value violates unique constraint on ${key}`);
      }
      store.set(id, { ...(store.get(id) ?? {}), ...row });
    }
    return new Response(null, { status: 201 });
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const parsed = new URL(url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    let body: unknown = null;
    const text = await request.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const call: AuditCall = {
      url,
      method: request.method,
      headers,
      body,
      query: parsed.searchParams,
    };
    state.calls.push(call);
    await sleep(state.restLatencyMs);

    if (url.startsWith(RC_URL)) {
      const appUserId = decodeURIComponent(url.slice(RC_URL.length));
      const source = state.subscriber;
      const answer = typeof source === "function" ? source(appUserId) : source;
      if (answer instanceof Response) return answer;
      if (!answer) return new Response("upstream error", { status: 500 });
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber: answer });
    }

    if (url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      const table = restTable(parsed);
      const injected = state.intercept?.(call, table);
      if (injected) return injected;
      const prefer = headers["prefer"] ?? "";
      const accept = headers["accept"] ?? "";

      if (table.startsWith("rpc/")) {
        return pgrstError(404, "PGRST202", `rpc ${table} not stubbed in audit harness`);
      }

      const store =
        table === "webhook_events"
          ? state.webhookEvents
          : table === "billing_entitlements"
            ? state.billingEntitlements
            : null;
      if (!store) {
        return new Response(`audit harness: unexpected table ${table}`, { status: 599 });
      }
      const key = table === "webhook_events" ? "id" : "user_id";

      if (request.method === "GET") {
        let rows = [...store.values()];
        const filter = parsed.searchParams.get(key);
        if (filter?.startsWith("eq.")) {
          const wanted = filter.slice("eq.".length);
          rows = rows.filter((row) => String(row[key]) === wanted);
        }
        if (accept.includes("application/vnd.pgrst.object+json")) {
          if (rows.length === 0) return pgrstError(406, "PGRST116", "0 rows");
          if (rows.length > 1) return pgrstError(406, "PGRST116", "multiple rows");
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST") {
        return upsertRows(store, key, body, prefer);
      }
      if (request.method === "PATCH") {
        return new Response(null, { status: 204 });
      }
      if (request.method === "DELETE") {
        return new Response(null, { status: 204 });
      }
    }
    return new Response(`unexpected fetch in audit harness: ${request.method} ${url}`, {
      status: 599,
    });
  }) as typeof fetch;

  const realServe = Deno.serve;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    state.handler = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    };
  }) as unknown as typeof Deno.serve;

  try {
    // Distinct specifier → distinct module instance (own lazy admin client).
    await import("../index.ts?audit=edge-billing-webhook-structural1");
  } finally {
    Deno.serve = realServe;
  }

  harness = state;
  return state;
}

let ipCounter = 0;
/** Fresh client IP per request so the per-IP webhook budget never interferes. */
export function nextIp(): string {
  ipCounter += 1;
  return `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export function webhookRequest(
  event: unknown,
  options: { secret?: string; path?: string; ip?: string; rawBody?: string } = {},
): Request {
  return new Request(`${EDGE_BASE}${options.path ?? "/webhooks/revenuecat"}`, {
    method: "POST",
    headers: {
      Authorization: options.secret ?? WEBHOOK_SECRET,
      "Content-Type": "application/json",
      "x-forwarded-for": options.ip ?? nextIp(),
    },
    body: options.rawBody ?? JSON.stringify({ api_version: "1.0", event }),
  });
}

export function activeSubscriber(
  expiresDate: string | null = new Date(Date.now() + 86_400_000).toISOString(),
  productId = "pickle_sensei_pro_monthly",
  entitlement = "pickle_sensei_pro",
): Record<string, unknown> {
  return {
    entitlements: {
      [entitlement]: { expires_date: expiresDate, product_identifier: productId },
    },
  };
}

export function lapsedSubscriber(): Record<string, unknown> {
  return activeSubscriber(new Date(Date.now() - 86_400_000).toISOString());
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as unknown;
  return isRecord(parsed) ? parsed : {};
}
