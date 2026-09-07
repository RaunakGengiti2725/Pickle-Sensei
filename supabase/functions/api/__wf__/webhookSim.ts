// Stateful PostgREST stand-in for the webhook idempotency/entitlement plane,
// shared by webhook.test.ts and adjudicate_webhook.test.ts.
//
// routesHarness stubs PostgREST statelessly (every POST is a 201, every GET
// returns the seeded table verbatim), which is right for routes that only
// need "the write happened". The webhook path is different: its correctness
// IS the state machine over public.webhook_events (insert-first reservation →
// verify → persist → mark processed; release on upstream failure) plus the
// verified_at monotonic trigger on public.billing_entitlements. This module
// emulates the PostgREST semantics those two tables rely on so the webhook
// suites can assert against rows, not call counts alone:
//
//   POST   …/webhook_events        upsert. Prefer resolution=ignore-duplicates
//                                  → an existing id yields [] (nothing
//                                  inserted); a new id is stored and, under
//                                  return=representation, echoed back.
//   GET    …/webhook_events?…      filters: eq / neq / is / lt / gt.
//   PATCH  …/webhook_events?…      filtered update, echoed under representation.
//   DELETE …/webhook_events?…      filtered delete.
//   POST   …/billing_entitlements  upsert on user_id under the trigger from
//                                  20260906120000_webhook_reservation_and_monotonic_verified_at:
//                                  a row whose verified_at is OLDER than the
//                                  stored one is dropped ([]).
//   GET    …/billing_entitlements  filters as above (the re-read after a
//                                  dropped write).
//
// Faults are matched per request; `times` bounds how many requests a fault
// eats (default 1). Every request is counted BEFORE fault evaluation, so
// "N upserts" means N attempts, whether or not they succeeded. Requests the
// sim does not own (RevenueCat without a fault, Auth, RPCs) fall through to
// the routesHarness stub, so `h.subscriber` / `h.rpcs` keep working.

import {
  activeSubscriber,
  billingRpcResponse,
  type Harness,
  loadHarness,
  RC_URL,
  SUPABASE_URL,
} from "./routesHarness.ts";

export const EVENTS_URL = `${SUPABASE_URL}/rest/v1/webhook_events`;
export const ENTITLEMENTS_URL = `${SUPABASE_URL}/rest/v1/billing_entitlements`;
export const VERDICT_URL = `${SUPABASE_URL}/rest/v1/rpc/persist_billing_verdict`;
export const EVENT_CLAIM_URL = `${SUPABASE_URL}/rest/v1/rpc/claim_billing_webhook_delivery`;
export const EVENT_COMPLETE_URL = `${SUPABASE_URL}/rest/v1/rpc/complete_billing_webhook`;
export const EVENT_RELEASE_URL = `${SUPABASE_URL}/rest/v1/rpc/release_billing_webhook_delivery`;
export const BILLING_BEGIN_URL = `${SUPABASE_URL}/rest/v1/rpc/begin_billing_verification`;

export type Row = Record<string, unknown>;

export interface Fault {
  match: (method: string, url: string) => boolean;
  /** Respond with this HTTP status and `body` (PostgREST/RevenueCat error). */
  status?: number;
  body?: unknown;
  /** Hold the response this long first (abort-aware). */
  delayMs?: number;
  /** How many matching requests the fault eats. Default 1. */
  times?: number;
  /** RevenueCat: answer 200 with this subscriber instead of `h.subscriber`. */
  subscriber?: Record<string, unknown>;
  /** RevenueCat: the `request_date_ms` to answer with. Default: the moment
   * the request ARRIVED — RevenueCat stamps when it evaluated the
   * subscriber, so a `delayMs` models a slow answer carrying that older
   * truth, not a later evaluation. `null` omits the field altogether. */
  requestDateMs?: number | null;
}

export interface Sim {
  h: Harness;
  auditRows: Map<string, Row>;
  entitlementRows: Map<string, Row>;
  /** Every ACCEPTED billing_entitlements write, in order (dropped stale writes excluded). */
  entitlementWrites: Row[];
  verdictResults: Row[];
  expireLease(eventId: string): void;
  faults: Fault[];
  errors: string[];
  restore(): void;
  rcCalls(): number;
  entitlementUpserts(): number;
  auditUpserts(): number;
  auditLookups(): number;
  auditPatches(): number;
  auditDeletes(): number;
}

type Filter = { column: string; op: string; value: string };

const NON_FILTER_PARAMS = new Set(["select", "on_conflict", "columns", "order", "limit", "offset"]);

const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

export const pgError = (status: number, code: string, message: string): Response =>
  new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function parseFilters(url: URL): Filter[] {
  const filters: Filter[] = [];
  for (const [column, raw] of url.searchParams) {
    if (NON_FILTER_PARAMS.has(column)) continue;
    const dot = raw.indexOf(".");
    if (dot < 0) {
      throw new Error(`webhookSim: unsupported PostgREST query ${column}=${raw}`);
    }
    filters.push({ column, op: raw.slice(0, dot), value: raw.slice(dot + 1) });
  }
  return filters;
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ column, op, value }) => {
    const actual = row[column];
    const isNull = actual === null || actual === undefined;
    switch (op) {
      case "eq":
        return !isNull && String(actual) === value;
      case "neq":
        return isNull || String(actual) !== value;
      case "is":
        if (value === "null") return isNull;
        if (value === "true") return actual === true;
        if (value === "false") return actual === false;
        throw new Error(`webhookSim: unsupported is.${value}`);
      case "lt":
        return typeof actual === "string" && Date.parse(actual) < Date.parse(value);
      case "gt":
        return typeof actual === "string" && Date.parse(actual) > Date.parse(value);
      default:
        throw new Error(`webhookSim: unsupported PostgREST filter ${column}=${op}.${value}`);
    }
  });
}

/** Shape a row set the way PostgREST does for the request's Accept/Prefer:
 * reads always carry rows; writes carry them only under
 * `Prefer: return=representation` (201 for inserts, 200 for update/delete),
 * otherwise 201 / 204 with no body. */
function rowsResponse(headers: Headers, rows: Row[], kind: "read" | "insert" | "mutate"): Response {
  const accept = headers.get("accept") ?? "";
  const prefer = headers.get("prefer") ?? "";
  if (kind !== "read" && !prefer.includes("return=representation")) {
    return new Response(null, { status: kind === "insert" ? 201 : 204 });
  }
  const status = kind === "insert" ? 201 : 200;
  if (accept.includes("application/vnd.pgrst.object+json")) {
    if (rows.length === 1) return jsonResponse(status, rows[0]);
    return pgError(
      406,
      "PGRST116",
      `JSON object requested, multiple (or no) rows returned (${rows.length})`,
    );
  }
  return jsonResponse(status, rows);
}

/** Install the stateful simulation over the routesHarness stub. */
export async function simulate(): Promise<Sim> {
  const h = await loadHarness();
  const stub = globalThis.fetch;
  const auditRows = new Map<string, Row>();
  const entitlementRows = new Map<string, Row>();
  const entitlementWrites: Row[] = [];
  const verdictResults: Row[] = [];
  const faults: Fault[] = [];
  const errors: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  const counts = {
    rc: 0,
    ent: 0,
    auditPost: 0,
    auditGet: 0,
    auditPatch: 0,
    auditDelete: 0,
  };

  const record = (request: Request, body: unknown) => {
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    h.calls.push({ url: request.url, method: request.method, headers, body });
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const { url, method } = request;
    const bodyText = await request
      .clone()
      .text()
      .catch(() => "");
    let body: unknown = null;
    try {
      body = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      body = bodyText;
    }
    const parsed = new URL(url);
    const path = `${parsed.origin}${parsed.pathname}`;

    if (url.startsWith(RC_URL)) counts.rc += 1;
    if (path === VERDICT_URL && method === "POST") counts.ent += 1;
    if (path === EVENT_CLAIM_URL && method === "POST") counts.auditPost += 1;
    if (path === EVENT_COMPLETE_URL && method === "POST") counts.auditPatch += 1;
    if (path === EVENT_RELEASE_URL && method === "POST") counts.auditDelete += 1;
    if (path === EVENTS_URL && method === "GET") counts.auditGet += 1;

    const fault = faults.find((f) => f.match(method, url) && (f.times ?? 1) > 0);
    if (fault) {
      fault.times = (fault.times ?? 1) - 1;
      const requestDateMs = fault.requestDateMs === undefined ? Date.now() : fault.requestDateMs;
      if (fault.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, fault.delayMs);
          request.signal.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      if (fault.status !== undefined) {
        record(request, body);
        return new Response(fault.body === undefined ? "" : JSON.stringify(fault.body), {
          status: fault.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (fault.subscriber) {
        record(request, body);
        return jsonResponse(200, {
          ...(requestDateMs === null ? {} : { request_date_ms: requestDateMs }),
          subscriber: fault.subscriber,
        });
      }
    }

    if (
      method === "POST" &&
      [
        VERDICT_URL,
        EVENT_CLAIM_URL,
        EVENT_COMPLETE_URL,
        EVENT_RELEASE_URL,
        BILLING_BEGIN_URL,
      ].includes(path)
    ) {
      record(request, body);
      if (
        request.headers.get("apikey") !== "service-role-test-key" ||
        request.headers.get("authorization") !== "Bearer service-role-test-key"
      ) {
        return pgError(403, "42501", "server credentials required");
      }
      const name = parsed.pathname.split("/").at(-1)!;
      if (name in h.rpcErrors) return pgError(h.rpcErrors[name], "XX000", "injected rpc failure");
      if (name in h.rpcs) return jsonResponse(200, h.rpcs[name]);
      h.tables.webhook_events = [...auditRows.values()];
      h.tables.billing_entitlements = [...entitlementRows.values()];
      const result = billingRpcResponse(h, name, isRecord(body) ? body : {})!;
      for (const row of h.tables.webhook_events as Row[]) auditRows.set(String(row.id), row);
      for (const row of h.tables.billing_entitlements as Row[]) {
        const userId = String(row.user_id);
        if (entitlementRows.get(userId) !== row) entitlementWrites.push(row);
        entitlementRows.set(userId, row);
      }
      if (name === "persist_billing_verdict") {
        const verdictResult = await result.clone().json();
        if (isRecord(verdictResult)) verdictResults.push(verdictResult);
      }
      return result;
    }
    if ([EVENTS_URL, ENTITLEMENTS_URL].includes(path) && method !== "GET") {
      record(request, body);
      return pgError(403, "42501", "ordered billing helpers required");
    }
    if (path === EVENTS_URL) {
      record(request, body);
      const filters = parseFilters(parsed);
      if (method === "GET") {
        const rows = [...auditRows.values()].filter((row) => matches(row, filters));
        return rowsResponse(request.headers, rows, "read");
      }
      if (method === "POST") {
        const prefer = request.headers.get("prefer") ?? "";
        const incoming = (Array.isArray(body) ? body : [body]).filter(isRecord);
        const inserted: Row[] = [];
        for (const row of incoming) {
          const id = String(row.id);
          const existing = auditRows.get(id);
          if (existing) {
            if (prefer.includes("resolution=ignore-duplicates")) continue;
            if (prefer.includes("resolution=merge-duplicates")) {
              const merged = { ...existing, ...row };
              auditRows.set(id, merged);
              inserted.push(merged);
              continue;
            }
            return pgError(
              409,
              "23505",
              'duplicate key value violates unique constraint "webhook_events_pkey"',
            );
          }
          const now = new Date().toISOString();
          const stored: Row = {
            received_at: now,
            claimed_at: now,
            processed_at: null,
            ...row,
          };
          auditRows.set(id, stored);
          inserted.push(stored);
        }
        return rowsResponse(request.headers, inserted, "insert");
      }
      if (method === "PATCH" && isRecord(body)) {
        const updated: Row[] = [];
        for (const [id, row] of auditRows) {
          if (!matches(row, filters)) continue;
          const next = { ...row, ...body };
          auditRows.set(id, next);
          updated.push(next);
        }
        return rowsResponse(request.headers, updated, "mutate");
      }
      if (method === "DELETE") {
        const removed: Row[] = [];
        for (const [id, row] of auditRows) {
          if (!matches(row, filters)) continue;
          auditRows.delete(id);
          removed.push(row);
        }
        return rowsResponse(request.headers, removed, "mutate");
      }
    }

    if (path === ENTITLEMENTS_URL && method === "GET") {
      record(request, body);
      const filters = parseFilters(parsed);
      const rows = [...entitlementRows.values()].filter((row) => matches(row, filters));
      return rowsResponse(request.headers, rows, "read");
    }

    if (path === ENTITLEMENTS_URL && method === "POST") {
      record(request, body);
      const incoming = (Array.isArray(body) ? body : [body]).filter(isRecord);
      const accepted: Row[] = [];
      for (const row of incoming) {
        const userId = String(row.user_id);
        const existing = entitlementRows.get(userId);
        if (
          existing &&
          typeof existing.verified_at === "string" &&
          typeof row.verified_at === "string" &&
          Date.parse(row.verified_at) < Date.parse(existing.verified_at)
        ) {
          // billing_entitlements_verified_at_monotonic: the BEFORE UPDATE
          // trigger returns NULL, the stale write is skipped, PostgREST echoes
          // nothing for it.
          continue;
        }
        const stored = { ...(existing ?? {}), ...row };
        entitlementRows.set(userId, stored);
        entitlementWrites.push(stored);
        accepted.push(stored);
      }
      return rowsResponse(request.headers, accepted, "insert");
    }

    return stub(request);
  }) as typeof fetch;

  return {
    h,
    auditRows,
    entitlementRows,
    entitlementWrites,
    verdictResults,
    expireLease(eventId) {
      const row = auditRows.get(eventId);
      if (row) row.claimed_at = new Date(Date.now() - 300_001).toISOString();
      const claim = (h.tables.billing_webhook_claims as Row[] | undefined)?.find(
        (item) => item.event_id === eventId,
      );
      if (claim) claim.lease_expires_at_ms = Date.now() - 1;
    },
    faults,
    errors,
    restore() {
      globalThis.fetch = stub;
      console.error = realError;
    },
    rcCalls: () => counts.rc,
    entitlementUpserts: () => counts.ent,
    auditUpserts: () => counts.auditPost,
    auditLookups: () => counts.auditGet,
    auditPatches: () => counts.auditPatch,
    auditDeletes: () => counts.auditDelete,
  };
}

/** RevenueCat subscriber whose entitlement lapsed a minute ago. */
export const expiredSubscriber = (): Record<string, unknown> =>
  activeSubscriber(new Date(Date.now() - 60_000).toISOString());

/** PostgREST's "could not connect to database" (transient, retryable). */
export const dbUnavailable: Pick<Fault, "status" | "body"> = {
  status: 503,
  body: { code: "PGRST001", message: "could not connect to database" },
};
