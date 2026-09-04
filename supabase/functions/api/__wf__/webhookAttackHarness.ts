// Fault-injection layer for adversarial RevenueCat-webhook tests.
//
// Wraps the routesHarness fetch stub (which records calls and answers
// PostgREST / RevenueCat with canned success) with:
//   - a STATEFUL webhook_events table (POST records ids, GET ?id=eq.<id>
//     returns the row) so replay/idempotency behaves like real PostgREST;
//   - a STATEFUL billing_entitlements table (last successful upsert per user);
//   - ordered fault rules that can delay a call (honouring the caller's
//     AbortSignal exactly like a real socket would) and/or replace the
//     response (500 / 409 / custom RevenueCat subscriber per user).
//
// Production code is untouched: everything here sits on globalThis.fetch.

import { type Harness, loadHarness, RC_URL, SUPABASE_URL } from "./routesHarness.ts";

export interface ObservedCall {
  ordinal: number;
  method: string;
  url: string;
  body: unknown;
  startedAt: number;
  entitlementUpsertsBefore: number;
}

export interface FaultRule {
  /** Human label kept in the trace. */
  label: string;
  match: (call: ObservedCall) => boolean;
  /** Milliseconds to hold the call before answering (abortable). */
  delayMs?: number;
  /** Replacement response; return undefined to pass the stub response through. */
  respond?: (call: ObservedCall) => Response | undefined;
  /** Apply at most this many times (default: unlimited). */
  times?: number;
}

export interface AttackHarness {
  h: Harness;
  /** webhook_events rows recorded by successful POSTs (id → row). */
  auditRows: Map<string, Record<string, unknown>>;
  /** billing_entitlements rows recorded by successful POSTs (user_id → row). */
  entitlementRows: Map<string, Record<string, unknown>>;
  /** Every call seen by the wrapper in order. */
  trace: ObservedCall[];
  faults: FaultRule[];
  addFault(rule: FaultRule): void;
  clearFaults(): void;
  /** Reset stateful tables, trace and faults (keeps the wrapper installed). */
  reset(): void;
  /** Uninstall the wrapper (restores the plain routesHarness stub). */
  restore(): void;
  rcCalls(): ObservedCall[];
  entitlementUpserts(): ObservedCall[];
  auditUpserts(): ObservedCall[];
  auditLookups(): ObservedCall[];
}

export const WEBHOOK_EVENTS_URL = `${SUPABASE_URL}/rest/v1/webhook_events`;
export const BILLING_ENTITLEMENTS_URL = `${SUPABASE_URL}/rest/v1/billing_entitlements`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function postgrestError(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
): Response {
  return new Response(JSON.stringify({ code, message, details, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function rcSubscriber(subscriber: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ subscriber }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export function premiumSubscriber(expiresAt = "2999-01-01T00:00:00Z"): Record<string, unknown> {
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: expiresAt,
        product_identifier: "pickle_sensei_pro_monthly",
        purchase_date: "2026-01-01T00:00:00Z",
      },
    },
  };
}

export function expiredSubscriber(): Record<string, unknown> {
  return {
    entitlements: {
      pickle_sensei_pro: {
        expires_date: "2020-01-01T00:00:00Z",
        product_identifier: "pickle_sensei_pro_monthly",
        purchase_date: "2019-12-01T00:00:00Z",
      },
    },
  };
}

export function noEntitlements(): Record<string, unknown> {
  return { entitlements: {} };
}

/** Deterministic v4-shaped UUIDs from a seed (recorded in the test output). */
export function seededUuids(seed: number, count: number): string[] {
  let state = seed >>> 0;
  const next = () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0").slice(-width);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = hex(next(), 8);
    const b = hex(next() & 0xffff, 4);
    const c = "4" + hex(next() & 0x0fff, 3);
    const d = "8" + hex(next() & 0x0fff, 3);
    const e = hex(next(), 8) + hex(next() & 0xffff, 4);
    out.push(`${a}-${b}-${c}-${d}-${e}`);
  }
  return out;
}

function abortableSleep(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function loadAttackHarness(): Promise<AttackHarness> {
  const h = await loadHarness();
  h.reset();
  const stubFetch = globalThis.fetch;

  const auditRows = new Map<string, Record<string, unknown>>();
  const entitlementRows = new Map<string, Record<string, unknown>>();
  const trace: ObservedCall[] = [];
  const faults: FaultRule[] = [];
  const faultUses = new Map<FaultRule, number>();
  let ordinal = 0;

  const wrapped: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const text = await request
      .clone()
      .text()
      .catch(() => "");
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep raw text
    }
    const call: ObservedCall = {
      ordinal: ordinal++,
      method: request.method,
      url: request.url,
      body,
      startedAt: performance.now(),
      entitlementUpsertsBefore: entitlementRows.size,
    };
    trace.push(call);

    // Let the routesHarness stub record the call and produce its default answer.
    let response = await stubFetch(request);

    for (const rule of faults) {
      if (!rule.match(call)) continue;
      const used = faultUses.get(rule) ?? 0;
      if (rule.times !== undefined && used >= rule.times) continue;
      faultUses.set(rule, used + 1);
      if (rule.delayMs) await abortableSleep(rule.delayMs, request.signal);
      const replaced = rule.respond?.(call);
      if (replaced) response = replaced;
    }

    if (request.url.startsWith(WEBHOOK_EVENTS_URL)) {
      if (request.method === "GET" && response.ok && response.status === 200) {
        const filter = new URL(request.url).searchParams.get("id") ?? "";
        const id = filter.startsWith("eq.") ? filter.slice(3) : null;
        const row = id !== null ? auditRows.get(id) : undefined;
        // .maybeSingle() sends Accept: application/vnd.pgrst.object+json and
        // expects one object or 406 (PGRST116 when zero rows). The stub answers
        // [] (parsed as a null single row); emulate the real shape instead.
        const wantsObject = (request.headers.get("Accept") ?? "").includes("pgrst.object");
        if (row) {
          response = new Response(JSON.stringify(wantsObject ? { id: row.id } : [{ id: row.id }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        } else if (wantsObject) {
          response = postgrestError(
            406,
            "PGRST116",
            "JSON object requested, multiple (or no) rows returned",
            "The result contains 0 rows",
          );
        }
      } else if (request.method === "POST" && response.ok && isRecord(body)) {
        const id = body.id;
        if (typeof id === "string" && !auditRows.has(id)) auditRows.set(id, body);
      }
    } else if (request.url.startsWith(BILLING_ENTITLEMENTS_URL)) {
      if (
        request.method === "POST" &&
        response.ok &&
        isRecord(body) &&
        typeof body.user_id === "string"
      ) {
        entitlementRows.set(body.user_id, body);
      }
    }
    return response;
  };
  globalThis.fetch = wrapped;

  const attack: AttackHarness = {
    h,
    auditRows,
    entitlementRows,
    trace,
    faults,
    addFault: (rule) => {
      faults.push(rule);
    },
    clearFaults: () => {
      faults.length = 0;
      faultUses.clear();
    },
    reset: () => {
      h.reset();
      auditRows.clear();
      entitlementRows.clear();
      trace.length = 0;
      faults.length = 0;
      faultUses.clear();
      ordinal = 0;
    },
    restore: () => {
      globalThis.fetch = stubFetch;
    },
    rcCalls: () => trace.filter((c) => c.url.startsWith(RC_URL)),
    entitlementUpserts: () =>
      trace.filter((c) => c.method === "POST" && c.url.startsWith(BILLING_ENTITLEMENTS_URL)),
    auditUpserts: () =>
      trace.filter((c) => c.method === "POST" && c.url.startsWith(WEBHOOK_EVENTS_URL)),
    auditLookups: () =>
      trace.filter((c) => c.method === "GET" && c.url.startsWith(WEBHOOK_EVENTS_URL)),
  };
  return attack;
}

export function rcUserFromUrl(url: string): string {
  return decodeURIComponent(url.slice(RC_URL.length).split("?")[0]);
}

export const matchRc = (call: ObservedCall) => call.url.startsWith(RC_URL);
export const matchRcFor = (userId: string) => (call: ObservedCall) =>
  call.url.startsWith(RC_URL) && rcUserFromUrl(call.url) === userId;
export const matchAuditLookup = (call: ObservedCall) =>
  call.method === "GET" && call.url.startsWith(WEBHOOK_EVENTS_URL);
export const matchAuditUpsert = (call: ObservedCall) =>
  call.method === "POST" && call.url.startsWith(WEBHOOK_EVENTS_URL);
export const matchEntitlementUpsert = (call: ObservedCall) =>
  call.method === "POST" && call.url.startsWith(BILLING_ENTITLEMENTS_URL);
export const matchEntitlementUpsertFor = (userId: string) => (call: ObservedCall) =>
  matchEntitlementUpsert(call) && isRecord(call.body) && call.body.user_id === userId;

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as unknown;
  return isRecord(parsed) ? parsed : {};
}
