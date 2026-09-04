// stress-consent-withdraw — concurrency harness for POST /v1/me/consent/withdraw.
//
// The route (index.ts withdrawConsent, lines 1864-1889) is READ → INSERT →
// READ over three separate PostgREST round trips, so every concurrent caller
// can observe a different "before" state. xc_concurrency_harness.ts models
// Auth/PostgREST/RPCs but its table map has no `consent_records`, and its
// PostgREST model neither stamps `created_at` nor honours `order=` — both are
// exactly what this route's fold depends on (`order by created_at, id`, last
// row per scope wins). This file therefore layers a Postgres-faithful
// `consent_records` model (append-only rows, gen_random_uuid ids, now() taken
// at TRANSACTION START, RLS by JWT sub, deferred visibility until "commit")
// over the existing harness WITHOUT modifying it: it wraps globalThis.fetch
// and delegates every other upstream call to the harness dispatcher.
//
// The real handler from ../index.ts is still the thing under test (Deno.serve
// captured by loadXcHarness()).
//
// Schema mirrored: supabase/migrations/20260829140000_permits_sync_consent.sql
//   consent_records(id uuid default gen_random_uuid(), user_id, scope,
//   consent_version, action check in ('grant','withdraw'), source, device,
//   capture_mode, created_at timestamptz default now())
//   index (user_id, created_at, id); RLS own-row; grants: select, insert only.

import {
  FakeSupabase,
  isRecord,
  loadXcHarness,
  Prng,
  sleep,
  SUPABASE_URL,
  type XcHarness,
} from "./xc_concurrency_harness.ts";

export interface StoredConsentRow {
  id: string;
  user_id: string;
  scope: string;
  consent_version: string | null;
  action: string;
  source: string | null;
  device: unknown;
  capture_mode: string | null;
  created_at: string;
  /** model-only: order the INSERT actually committed in (not a real column) */
  _commitSeq: number;
}

/** How the modelled Postgres host stamps now() for each implicit transaction.
 *  - monotonic: distinct, increasing microsecond timestamps (normal case).
 *  - coarse: timestamps quantised to `coarseMs` — two transactions that start
 *    inside the same tick share now(), which is what makes the fold's
 *    `order by created_at, id` tie-break on a RANDOM uuid observable.
 *  - skew: monotonic with seeded backwards steps (host clock correction). */
export type ClockMode = "monotonic" | "coarse" | "skew";

export interface ConsentStoreOptions {
  latencyMaxMs?: number;
  clockMode?: ClockMode;
  coarseMs?: number;
  skewMaxUs?: number;
  skewChance?: number;
  /** Return a PostgREST error for this insert attempt (1-based per reset). */
  failInsert?: (attempt: number) => boolean;
}

export class ConsentStore {
  rows: StoredConsentRow[] = [];
  prng = new Prng(1);
  latencyMaxMs = 8;
  clockMode: ClockMode = "monotonic";
  coarseMs = 1;
  skewMaxUs = 4_000;
  skewChance = 0.25;
  failInsert: (attempt: number) => boolean = () => false;
  counters: Record<string, number> = {};
  /** every request the store served, in service order */
  log: Array<{ op: string; detail: string }> = [];

  private baseMs = Date.parse("2026-09-04T12:00:00.000Z");
  private us = 0;
  private commitSeq = 0;
  private insertAttempts = 0;

  reset(seed: number, options: ConsentStoreOptions = {}): void {
    this.rows = [];
    this.prng = new Prng(seed);
    this.latencyMaxMs = options.latencyMaxMs ?? 8;
    this.clockMode = options.clockMode ?? "monotonic";
    this.coarseMs = options.coarseMs ?? 1;
    this.skewMaxUs = options.skewMaxUs ?? 4_000;
    this.skewChance = options.skewChance ?? 0.25;
    this.failInsert = options.failInsert ?? (() => false);
    this.counters = {};
    this.log = [];
    this.us = 0;
    this.commitSeq = 0;
    this.insertAttempts = 0;
  }

  private count(key: string): void {
    this.counters[key] = (this.counters[key] ?? 0) + 1;
  }

  /** timestamptz text exactly as PostgREST renders it (microseconds, +00:00). */
  private stamp(us: number): string {
    const ms = Math.floor(us / 1000);
    const rem = ((us % 1000) + 1000) % 1000;
    return `${new Date(this.baseMs + ms).toISOString().slice(0, -1)}${
      String(rem).padStart(3, "0")
    }+00:00`;
  }

  /** now() — evaluated once per implicit transaction, at its start. */
  private txNow(): string {
    this.us += this.prng.int(40, 900);
    if (this.clockMode === "coarse") {
      const tick = this.coarseMs * 1000;
      return this.stamp(Math.floor(this.us / tick) * tick);
    }
    if (this.clockMode === "skew" && this.prng.next() < this.skewChance) {
      return this.stamp(
        Math.max(0, this.us - this.prng.int(1, this.skewMaxUs)),
      );
    }
    return this.stamp(this.us);
  }

  /** Postgres ordering for `order by created_at asc, id asc`. */
  private sorted(rows: StoredConsentRow[]): StoredConsentRow[] {
    return [...rows].sort((a, b) =>
      a.created_at === b.created_at
        ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
        : (a.created_at < b.created_at ? -1 : 1)
    );
  }

  ofUser(userId: string): StoredConsentRow[] {
    return this.sorted(this.rows.filter((r) => r.user_id === userId));
  }

  /** The ledger fold the route promises: last row per scope in DB order. */
  latestForScope(userId: string, scope: string): StoredConsentRow | null {
    return this.ofUser(userId).filter((r) => r.scope === scope).at(-1) ?? null;
  }

  /** The row that physically committed last for the scope (insertion truth). */
  lastCommittedForScope(
    userId: string,
    scope: string,
  ): StoredConsentRow | null {
    const rows = this.rows
      .filter((r) => r.user_id === userId && r.scope === scope)
      .sort((a, b) => a._commitSeq - b._commitSeq);
    return rows.at(-1) ?? null;
  }

  private async latency(): Promise<void> {
    if (this.latencyMaxMs > 0) await sleep(this.prng.int(0, this.latencyMaxMs));
  }

  async handle(
    request: Request,
    rawBody: string,
    fake: FakeSupabase,
  ): Promise<Response> {
    const url = new URL(request.url);
    const who = fake.principal(request.headers);
    const jsonResponse = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });

    // Transaction start: now() is fixed here, BEFORE the statement latency.
    const txStamp = this.txNow();
    await this.latency();

    if (request.method === "GET") {
      this.count("rest.get.consent_records");
      if (who.role === "anon" || !who.userId) {
        this.log.push({ op: "select", detail: "anon → 0 rows (RLS)" });
        return jsonResponse(200, []);
      }
      let rows = who.role === "service"
        ? this.sorted(this.rows)
        : this.ofUser(who.userId);
      for (const [col, raw] of url.searchParams.entries()) {
        if (
          ["select", "order", "limit", "offset", "on_conflict", "columns"]
            .includes(col)
        ) {
          continue;
        }
        if (raw.startsWith("eq.")) {
          const value = raw.slice(3);
          rows = rows.filter((r) =>
            String((r as unknown as Record<string, unknown>)[col]) === value
          );
        } else {
          throw new Error(
            `stress-consent harness: unsupported filter ${col}=${raw}`,
          );
        }
      }
      const select = (url.searchParams.get("select") ?? "*").split(",").map((
        c,
      ) => c.trim());
      const projected = rows.map((row) => {
        if (select.includes("*")) return { ...row };
        const out: Record<string, unknown> = {};
        for (const col of select) {
          out[col] = (row as unknown as Record<string, unknown>)[col];
        }
        return out;
      });
      this.log.push({
        op: "select",
        detail: `user=${who.userId?.slice(0, 8)} rows=${projected.length}`,
      });
      return jsonResponse(200, projected);
    }

    if (request.method === "POST") {
      this.count("rest.post.consent_records");
      this.insertAttempts += 1;
      const attempt = this.insertAttempts;
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        parsed = {};
      }
      const incoming = (Array.isArray(parsed) ? parsed : [parsed]).filter(
        isRecord,
      );
      if (this.failInsert(attempt)) {
        this.count("rest.post.injected_failure");
        this.log.push({
          op: "insert",
          detail: `attempt=${attempt} → injected 503`,
        });
        return jsonResponse(503, {
          code: "57P01",
          message: "terminating connection due to administrator command",
          details: null,
          hint: null,
        });
      }
      for (const row of incoming) {
        if (
          who.role !== "service" && (!who.userId || row.user_id !== who.userId)
        ) {
          this.count("rest.post.rls_refused");
          return jsonResponse(403, {
            code: "42501",
            message:
              'new row violates row-level security policy for table "consent_records"',
            details: null,
            hint: null,
          });
        }
        if (typeof row.scope !== "string" || row.scope.length === 0) {
          return jsonResponse(400, {
            code: "23502",
            message:
              'null value in column "scope" violates not-null constraint',
            details: null,
            hint: null,
          });
        }
        if (row.action !== "grant" && row.action !== "withdraw") {
          return jsonResponse(400, {
            code: "23514",
            message:
              'new row for relation "consent_records" violates check constraint' +
              ' "consent_records_action_check"',
            details: null,
            hint: null,
          });
        }
      }
      // "Commit": rows become visible to other transactions only now.
      const committed: StoredConsentRow[] = [];
      for (const row of incoming) {
        this.commitSeq += 1;
        const stored: StoredConsentRow = {
          id: this.prng.uuid(),
          user_id: String(row.user_id),
          scope: String(row.scope),
          consent_version: typeof row.consent_version === "string"
            ? row.consent_version
            : null,
          action: String(row.action),
          source: typeof row.source === "string" ? row.source : null,
          device: row.device ?? null,
          capture_mode: typeof row.capture_mode === "string"
            ? row.capture_mode
            : null,
          created_at: txStamp,
          _commitSeq: this.commitSeq,
        };
        this.rows.push(stored);
        committed.push(stored);
        this.log.push({
          op: "insert",
          detail: `user=${stored.user_id.slice(0, 8)} scope=${stored.scope} ` +
            `action=${stored.action} version=${stored.consent_version} at=${stored.created_at}`,
        });
      }
      const prefer = request.headers.get("prefer") ?? "";
      return prefer.includes("return=representation")
        ? jsonResponse(201, committed)
        : new Response(null, { status: 201 });
    }

    // The migration grants `authenticated` only SELECT and INSERT.
    this.count(`rest.${request.method.toLowerCase()}.refused`);
    return jsonResponse(403, {
      code: "42501",
      message: `permission denied for table consent_records`,
      details: null,
      hint: null,
    });
  }
}

export interface ConsentStressHarness extends XcHarness {
  store: ConsentStore;
}

let stress: ConsentStressHarness | null = null;

/** Load the REAL handler and install the consent_records model in front of
 *  the xc harness fetch dispatcher. Idempotent per process. */
export async function loadConsentStress(): Promise<ConsentStressHarness> {
  if (stress) return stress;
  const harness = await loadXcHarness();
  // Registered so an unwrapped call cannot silently 404 into a 503.
  harness.fake.tables.consent_records ??= [];
  harness.fake.tables.evaluation_trials ??= [];
  const store = new ConsentStore();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/rest/v1/consent_records"
    ) {
      const rawBody = await request.text().catch(() => "");
      harness.upstreamCalls.push({
        t: performance.now(),
        method: request.method,
        url: request.url,
      });
      return await store.handle(request, rawBody, harness.fake);
    }
    return await inner(input, init);
  }) as typeof fetch;
  stress = { ...harness, store };
  return stress;
}

export const CONSENT_SCOPES = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
] as const;

export type ConsentScope = typeof CONSENT_SCOPES[number];

export interface ScopeStatus {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: string | null;
  lastActionAt: string | null;
}

/** Read the folded status a response carries for one scope. */
export function scopeStatus(
  body: Record<string, unknown>,
  scope: string,
): ScopeStatus | null {
  const scopes = Array.isArray(body.scopes) ? body.scopes : [];
  const row = scopes.filter(isRecord).find((r) => r.scope === scope);
  if (!row) return null;
  return {
    scope: String(row.scope),
    active: row.active === true,
    consentVersion: typeof row.consentVersion === "string"
      ? row.consentVersion
      : null,
    lastAction: typeof row.lastAction === "string" ? row.lastAction : null,
    lastActionAt: typeof row.lastActionAt === "string"
      ? row.lastActionAt
      : null,
  };
}
