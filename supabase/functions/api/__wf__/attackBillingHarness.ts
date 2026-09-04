// Adversarial harness for the RevenueCat webhook / billing-sync subsystem.
//
// routesHarness.ts stubs PostgREST statelessly (every GET answers from
// `h.tables`, every POST is a blind 201). That is enough for the happy paths
// but it cannot observe the check-then-act window, foreign-key failures,
// last-writer-wins, or the expires_at predicate. This layer sits on top of the
// routesHarness fetch stub and emulates JUST the tables the billing paths
// touch, statefully and with injectable faults + latency:
//
//   webhook_events        GET  ?select=id&id=eq.<id>   → row lookup
//                         POST Prefer: resolution=ignore-duplicates → insert-if-absent
//   billing_entitlements  POST Prefer: resolution=merge-duplicates  → upsert by user_id
//                         (FK to profiles: a user_id missing from `profiles`
//                          fails with PostgREST 409 / 23503, like Postgres)
//   rpc/access_state      computed from billing_entitlements with the exact
//                         predicate of migration 20260902150000
//                         (premium and (expires_at is null or expires_at > now())),
//                         scored_count/reserved_count from `accessCounts`
//   RevenueCat            per-call hook so responses can be held / released
//                         to force an interleaving.
//
// Everything else falls through to the routesHarness stub. Install with
// `installAttackDb(h)` and ALWAYS `restore()` in a finally block — the fetch
// override is process-global.

import type { Harness, RecordedCall } from "./routesHarness.ts";
import { RC_URL, SUPABASE_URL } from "./routesHarness.ts";

export interface EntitlementRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

export interface WebhookEventRow {
  id: string;
  provider: string;
  event_type: string | null;
  app_user_id: string | null;
  payload: unknown;
}

export interface AttackDb {
  /** user_ids that have a profiles row (FK target of billing_entitlements). */
  profiles: Set<string>;
  webhookEvents: Map<string, WebhookEventRow>;
  entitlements: Map<string, EntitlementRow>;
  /** scored/reserved counters access_state() reports (per user). */
  accessCounts: Map<string, { scored_count: number; reserved_count: number }>;
  /** Simulated network latency (ms) applied to every emulated PostgREST call. */
  latencyMs: number;
  /** When set, the NEXT n billing_entitlements upserts fail with this PostgREST status/body. */
  failNextUpserts: { remaining: number; status: number; body: unknown } | null;
  /** Optional per-call RevenueCat hook. Return a subscriber object (or null →
   * HTTP 500). May await to hold the response and force an interleaving. */
  rcHook:
    ((appUserId: string, callIndex: number) => Promise<Record<string, unknown> | null>) | null;
  /** Ordered log of every emulated write, for asserting write order. */
  writeLog: Array<{ table: string; row: unknown; at: number }>;
  /** Calls that reached the emulation (subset of h.calls). */
  calls: RecordedCall[];
  restore(): void;
}

export function accessStateRow(
  db: AttackDb,
  userId: string,
  nowMs = Date.now(),
): { premium: boolean; scored_count: number; reserved_count: number } {
  const row = db.entitlements.get(userId);
  const premium = Boolean(
    row && row.premium && (row.expires_at === null || Date.parse(row.expires_at) > nowMs),
  );
  const counts = db.accessCounts.get(userId) ?? { scored_count: 0, reserved_count: 0 };
  return { premium, ...counts };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const jsonResponse = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...extra },
  });

/** PostgREST's shape for a Postgres error. */
export const pgError = (code: string, message: string, details: string | null = null) => ({
  code,
  message,
  details,
  hint: null,
});

export function installAttackDb(h: Harness, userIds: string[] = []): AttackDb {
  const previousFetch = globalThis.fetch;
  let rcCalls = 0;
  const db: AttackDb = {
    profiles: new Set(userIds),
    webhookEvents: new Map(),
    entitlements: new Map(),
    accessCounts: new Map(),
    latencyMs: 0,
    failNextUpserts: null,
    rcHook: null,
    writeLog: [],
    calls: [],
    restore() {
      globalThis.fetch = previousFetch;
    },
  };

  // The JWT sub the user-scoped supabase-js client sends (routesHarness mints
  // access tokens as `session-for-<uuid>`; raw provider tokens carry sub).
  const userFromAuthHeader = (headers: Record<string, string>): string | null => {
    const auth = headers["authorization"] ?? "";
    const token = auth.replace(/^Bearer\s+/i, "");
    const m = /^session-for-(.+)$/.exec(token);
    if (m) return m[1];
    const seg = token.split(".")[1];
    if (!seg) return null;
    try {
      const raw = seg.replace(/-/g, "+").replace(/_/g, "/");
      const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
      const sub = JSON.parse(atob(padded)).sub;
      return typeof sub === "string" ? sub : null;
    } catch {
      return null;
    }
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));

    if (url.startsWith(RC_URL) && db.rcHook) {
      // Record like routesHarness does so h.callsTo(RC_URL) keeps working.
      const appUserId = decodeURIComponent(url.slice(RC_URL.length));
      h.calls.push({ url, method: request.method, headers, body: null });
      const index = rcCalls++;
      const subscriber = await db.rcHook(appUserId, index);
      if (!subscriber) return new Response("upstream error", { status: 500 });
      return jsonResponse(200, { request_date_ms: Date.now(), subscriber });
    }

    if (!url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      return previousFetch(input, init);
    }
    const parsed = new URL(url);
    const table = parsed.pathname.slice("/rest/v1/".length);
    const text = await request
      .clone()
      .text()
      .catch(() => "");
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    const handled = new Set(["webhook_events", "billing_entitlements", "rpc/access_state"]);
    if (!handled.has(table)) {
      return previousFetch(input, init);
    }
    const call: RecordedCall = { url, method: request.method, headers, body };
    h.calls.push(call);
    db.calls.push(call);
    if (db.latencyMs > 0) await sleep(db.latencyMs);

    if (table === "webhook_events") {
      if (request.method === "GET") {
        const filter = parsed.searchParams.get("id") ?? "";
        const id = filter.startsWith("eq.") ? filter.slice(3) : null;
        const row = id !== null ? db.webhookEvents.get(id) : undefined;
        const rows = row ? [{ id: row.id }] : [];
        const accept = headers["accept"] ?? "";
        if (accept.includes("application/vnd.pgrst.object+json")) {
          // maybeSingle(): PostgREST answers 200 + null for zero rows... but
          // supabase-js maybeSingle actually sends Accept object+json and maps
          // PGRST116 (0 rows) to data:null. Mirror the routesHarness contract.
          if (rows.length === 0) {
            return jsonResponse(406, pgError("PGRST116", "0 rows"));
          }
          return jsonResponse(200, rows[0]);
        }
        return jsonResponse(200, rows);
      }
      if (request.method === "POST") {
        const prefer = headers["prefer"] ?? "";
        const rows = Array.isArray(body) ? body : [body];
        for (const raw of rows) {
          const row = raw as WebhookEventRow;
          if (db.webhookEvents.has(row.id)) {
            if (prefer.includes("resolution=ignore-duplicates")) continue;
            if (prefer.includes("resolution=merge-duplicates")) {
              db.webhookEvents.set(row.id, row);
              db.writeLog.push({ table, row, at: performance.now() });
              continue;
            }
            return jsonResponse(
              409,
              pgError(
                "23505",
                'duplicate key value violates unique constraint "webhook_events_pkey"',
              ),
            );
          }
          db.webhookEvents.set(row.id, row);
          db.writeLog.push({ table, row, at: performance.now() });
        }
        return new Response(null, { status: 201 });
      }
    }

    if (table === "billing_entitlements") {
      if (request.method === "GET") {
        const filter = parsed.searchParams.get("user_id") ?? "";
        const id = filter.startsWith("eq.") ? filter.slice(3) : null;
        const row = id ? db.entitlements.get(id) : undefined;
        return jsonResponse(200, row ? [row] : []);
      }
      if (request.method === "POST") {
        if (db.failNextUpserts && db.failNextUpserts.remaining > 0) {
          db.failNextUpserts.remaining -= 1;
          return jsonResponse(db.failNextUpserts.status, db.failNextUpserts.body);
        }
        const rows = Array.isArray(body) ? body : [body];
        for (const raw of rows) {
          const row = raw as EntitlementRow;
          if (!db.profiles.has(row.user_id)) {
            return jsonResponse(
              409,
              pgError(
                "23503",
                'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
                `Key (user_id)=(${row.user_id}) is not present in table "profiles".`,
              ),
            );
          }
          db.entitlements.set(row.user_id, row);
          db.writeLog.push({ table, row, at: performance.now() });
        }
        return new Response(null, { status: 201 });
      }
    }

    if (table === "rpc/access_state" && request.method === "POST") {
      const userId = userFromAuthHeader(headers);
      if (!userId) return jsonResponse(401, pgError("PGRST301", "JWT missing sub"));
      return jsonResponse(200, [accessStateRow(db, userId)]);
    }

    return previousFetch(input, init);
  }) as typeof fetch;

  return db;
}

/** A deferred promise for holding one RevenueCat response mid-flight. */
export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let isolateCounter = 0;

/** Boot a FRESH module instance of ../index.ts (its own lazily-cached
 * billingAdminClient), exactly like a cold edge isolate, with the routesHarness
 * Deno.serve stub capturing the handler. The shared harness handler is put back
 * afterwards so other test files are unaffected. */
export async function loadFreshIsolate(h: Harness): Promise<(req: Request) => Promise<Response>> {
  const previous = h.handler;
  isolateCounter += 1;
  await import(`../index.ts?attack-isolate=${Date.now()}-${isolateCounter}`);
  const fresh = h.handler;
  h.handler = previous;
  if (fresh === previous) throw new Error("fresh isolate did not register a handler");
  return fresh;
}

/** Deterministic seeded PRNG (mulberry32) so interleavings are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
