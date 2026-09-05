// stress — POST /webhooks/revenuecat under CONCURRENCY.
//
// Drives the REAL handler (../index.ts, Deno.serve captured) with seeded
// Promise.all bursts. Everything the route talks to is stubbed at the fetch
// boundary with SEEDED latency so bursts genuinely interleave:
//
//   • RevenueCat  GET /v1/subscribers/:id  — per-user verdict SEQUENCE (call k
//     returns verdict k, so the truth can flip between two in-flight copies),
//     plus "outage" (503) and "abort" (fetch rejects) verdicts;
//   • PostgREST   webhook_events GET (seen-check) / POST upsert
//     ignore-duplicates, billing_entitlements POST upsert merge-duplicates —
//     served by ONE of two backends behind the same shim:
//       MemoryBackend   — atomic in-process tables (fast; the default);
//       PostgresBackend — the SAME three PostgREST shapes translated to SQL
//                         (`on conflict do nothing` / `do update`) against a
//                         disposable postgres:16 with every migration applied
//                         (./xc_pg_up.sh → STRESS_PG_URL), one statement per
//                         transaction as role service_role, exactly like
//                         PostgREST behind the service-role key.
//
// Nothing here changes the route: the harness only observes. Every upstream
// call is recorded (order, user, verdict tag) so the invariant oracle can say
// which RevenueCat verdict was the FRESHEST and whether the row that won the
// upsert race is that one.
//
// Knobs (all optional):
//   STRESS_SEED       base seed (default 20260905); iteration i uses seed+i
//   STRESS_ITER       iterations per campaign (default 12 — fast enough for
//                     the suite; the reported campaign ran ≥500)
//   STRESS_LATENCY_MS max seeded latency per upstream hop (default 8)
//   STRESS_OUT_DIR    report directory (default
//                     artifacts/stress-webhook-revenuecat/latest/)
//   STRESS_PG_URL     enables the Postgres backend test (alias XC_PG_URL)
//
// Replay one iteration: STRESS_SEED=<seed> STRESS_ITER=1 deno test -A
// --no-check --config deno.json stress_webhook_revenuecat_concurrency.test.ts

import postgres from "postgres";
import { envInt, Prng } from "./xc_concurrency_harness.ts";

export const SUPABASE_URL = "http://supabase.stress.test";
export const WEBHOOK_SECRET = "stress-webhook-secret";
export const RC_URL = "https://api.revenuecat.com/v1/subscribers/";
const ANON_KEY = "stress-anon-key";
const SERVICE_ROLE_KEY = "stress-service-role-key";

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 12);
export const STRESS_LATENCY_MS = envInt("STRESS_LATENCY_MS", 8);
/** A burst that has not settled after this long is recorded as a deadlock. */
export const STRESS_BURST_TIMEOUT_MS = envInt("STRESS_BURST_TIMEOUT_MS", 20_000);

export const sleep = (ms: number): Promise<void> =>
  ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ── Rows ─────────────────────────────────────────────────────────────────────

export interface BillingRow {
  user_id: string;
  premium: boolean;
  product_key: string | null;
  expires_at: string | null;
  verified_at: string;
}

export interface EventRow {
  id: string;
  provider: string;
  event_type: string | null;
  app_user_id: string | null;
  payload: unknown;
}

export interface DbError {
  code: string;
  message: string;
}

/** The three statements the route issues through PostgREST. */
export interface Backend {
  readonly kind: "memory" | "postgres";
  /** Fresh state for one iteration: `profiled` users exist (profiles row —
   * the billing FK target); `orphans` do not; the given event ids are absent. */
  reset(profiled: string[], orphans: string[], eventIds: string[]): Promise<void>;
  lookupEvent(id: string): Promise<EventRow | null>;
  insertEventIgnoreDuplicate(row: EventRow): Promise<DbError | null>;
  upsertBilling(row: BillingRow): Promise<DbError | null>;
  billingFor(userIds: string[]): Promise<BillingRow[]>;
  eventsFor(ids: string[]): Promise<EventRow[]>;
  close(): Promise<void>;
}

// ── Memory backend ───────────────────────────────────────────────────────────

export class MemoryBackend implements Backend {
  readonly kind = "memory" as const;
  profiles = new Set<string>();
  events = new Map<string, EventRow>();
  billing = new Map<string, BillingRow>();

  reset(profiled: string[], orphans: string[], eventIds: string[]): Promise<void> {
    for (const u of profiled) this.profiles.add(u);
    for (const u of orphans) {
      this.profiles.delete(u);
      this.billing.delete(u);
    }
    for (const u of profiled) this.billing.delete(u);
    for (const id of eventIds) this.events.delete(id);
    return Promise.resolve();
  }
  lookupEvent(id: string): Promise<EventRow | null> {
    return Promise.resolve(this.events.get(id) ?? null);
  }
  insertEventIgnoreDuplicate(row: EventRow): Promise<DbError | null> {
    if (!this.events.has(row.id)) this.events.set(row.id, { ...row });
    return Promise.resolve(null);
  }
  upsertBilling(row: BillingRow): Promise<DbError | null> {
    if (!this.profiles.has(row.user_id)) {
      return Promise.resolve({
        code: "23503",
        message:
          'insert or update on table "billing_entitlements" violates foreign key constraint "billing_entitlements_user_id_fkey"',
      });
    }
    this.billing.set(row.user_id, { ...row });
    return Promise.resolve(null);
  }
  billingFor(userIds: string[]): Promise<BillingRow[]> {
    return Promise.resolve(
      userIds.flatMap((u) => (this.billing.has(u) ? [this.billing.get(u)!] : [])),
    );
  }
  eventsFor(ids: string[]): Promise<EventRow[]> {
    return Promise.resolve(
      ids.flatMap((id) => (this.events.has(id) ? [this.events.get(id)!] : [])),
    );
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ── Postgres backend ─────────────────────────────────────────────────────────

type Sql = ReturnType<typeof postgres>;

const PG_ROLE_STATEMENT = "set local role service_role";

export class PostgresBackend implements Backend {
  readonly kind = "postgres" as const;
  private readonly sql: Sql;
  constructor(url: string, maxConnections: number) {
    this.sql = postgres(url, { max: maxConnections });
  }

  /** One statement per transaction as service_role — PostgREST's shape. */
  private async asService<T>(fn: (tx: { unsafe: Sql["unsafe"] }) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      await tx.unsafe(PG_ROLE_STATEMENT);
      return await fn(tx as unknown as { unsafe: Sql["unsafe"] });
    })) as T;
  }

  async reset(profiled: string[], orphans: string[], eventIds: string[]): Promise<void> {
    // Owner-role setup (never through the shim): auth.users → profiles via
    // the on_auth_user_created trigger, exactly like a bootstrapped user.
    for (const u of [...profiled, ...orphans]) {
      await this.sql.unsafe(`delete from auth.users where id = $1`, [u]);
    }
    for (const u of profiled) {
      await this.sql.unsafe(
        `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
        [u, `${u}@stress.example.com`],
      );
    }
    if (eventIds.length) {
      await this.sql.unsafe(`delete from public.webhook_events where id = any($1::text[])`, [
        eventIds,
      ]);
    }
  }

  async lookupEvent(id: string): Promise<EventRow | null> {
    const rows = await this.asService((tx) =>
      tx.unsafe(`select id from public.webhook_events where id = $1`, [id]),
    );
    return rows.length ? (rows[0] as unknown as EventRow) : null;
  }

  async insertEventIgnoreDuplicate(row: EventRow): Promise<DbError | null> {
    try {
      await this.asService((tx) =>
        tx.unsafe(
          `insert into public.webhook_events (id, provider, event_type, app_user_id, payload)
             values ($1, $2, $3, $4, $5::jsonb)
             on conflict (id) do nothing`,
          [row.id, row.provider, row.event_type, row.app_user_id, JSON.stringify(row.payload)],
        ),
      );
      return null;
    } catch (error) {
      return pgError(error);
    }
  }

  async upsertBilling(row: BillingRow): Promise<DbError | null> {
    try {
      await this.asService((tx) =>
        tx.unsafe(
          `insert into public.billing_entitlements (user_id, premium, product_key, expires_at, verified_at)
             values ($1, $2, $3, $4::timestamptz, $5::timestamptz)
             on conflict (user_id) do update set
               premium = excluded.premium,
               product_key = excluded.product_key,
               expires_at = excluded.expires_at,
               verified_at = excluded.verified_at`,
          [row.user_id, row.premium, row.product_key, row.expires_at, row.verified_at],
        ),
      );
      return null;
    } catch (error) {
      return pgError(error);
    }
  }

  async billingFor(userIds: string[]): Promise<BillingRow[]> {
    const rows = await this.sql.unsafe(
      `select user_id::text as user_id, premium, product_key,
              to_char(expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at,
              to_char(verified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as verified_at
         from public.billing_entitlements where user_id = any($1::uuid[]) order by user_id`,
      [userIds],
    );
    return rows as unknown as BillingRow[];
  }

  async eventsFor(ids: string[]): Promise<EventRow[]> {
    const rows = await this.sql.unsafe(
      `select id, provider, event_type, app_user_id, payload
         from public.webhook_events where id = any($1::text[]) order by id`,
      [ids],
    );
    return rows as unknown as EventRow[];
  }

  async close(): Promise<void> {
    await this.sql.end();
  }
}

function pgError(error: unknown): DbError {
  const e = error as { code?: unknown; message?: unknown };
  return {
    code: typeof e.code === "string" ? e.code : "XX000",
    message: typeof e.message === "string" ? e.message : String(error),
  };
}

// ── RevenueCat stub ──────────────────────────────────────────────────────────

export type Verdict =
  | { kind: "premium"; tag: string; expiresAt: string | null; productId: string }
  | { kind: "free"; tag: string }
  | { kind: "outage"; tag: string }
  | { kind: "abort"; tag: string };

export interface RcCall {
  /** arrival order across the whole iteration */
  n: number;
  /** delivery order across the whole iteration — the oracle for "freshest verdict" */
  delivered: number;
  /** delivery index for this user (selects the verdict from the sequence) */
  k: number;
  user: string;
  verdict: Verdict | null;
  /** harness clock at arrival / delivery, plus wall clock at delivery */
  t: number;
  tDelivered: number;
  wallDelivered: number;
}

// ── World: fetch shim + recording ────────────────────────────────────────────

export interface UpstreamCall {
  t: number;
  method: string;
  url: string;
  status: number;
}

/** Which upstream hop is about to be served — lets a scenario shape the
 * interleaving deliberately (e.g. delay ONE verdict's persist). */
export interface Hop {
  hop: "rc" | "seen" | "audit" | "billing";
  user: string | null;
  /** billing hop only: the verdict's product_key ("free" when not premium) */
  tag: string | null;
}

export class World {
  backend: Backend;
  /** per user, the verdict sequence: RC call k for that user returns [min(k, len-1)] */
  truth = new Map<string, Verdict[]>();
  /** seeded latency per hop — set per iteration */
  latency: (hop: Hop) => number = () => 0;
  rcCalls: RcCall[] = [];
  upstream: UpstreamCall[] = [];
  unexpected: string[] = [];
  billingWrites: BillingRow[] = [];
  /** per user, how many RevenueCat answers have been DELIVERED — the truth
   * sequence advances on delivery, i.e. RevenueCat reads its state when it
   * answers, so a later answer is never staler than an earlier one. */
  private rcDeliveredPerUser = new Map<string, number>();
  private rcDelivered = 0;
  private readonly t0 = performance.now();

  constructor(backend: Backend) {
    this.backend = backend;
  }

  resetRecording(): void {
    this.rcCalls = [];
    this.upstream = [];
    this.unexpected = [];
    this.billingWrites = [];
    this.rcDeliveredPerUser.clear();
    this.rcDelivered = 0;
  }

  now(): number {
    return Math.round((performance.now() - this.t0) * 100) / 100;
  }

  async handleFetch(request: Request, rawBody: string): Promise<Response> {
    const response = await this.dispatch(request, rawBody);
    this.upstream.push({
      t: this.now(),
      method: request.method,
      url: request.url,
      status: response.status,
    });
    return response;
  }

  private async dispatch(request: Request, rawBody: string): Promise<Response> {
    const url = new URL(request.url);
    if (request.url.startsWith(RC_URL)) return await this.revenueCat(url);
    if (request.url.startsWith(`${SUPABASE_URL}/rest/v1/`)) {
      return await this.postgrest(request, url, rawBody);
    }
    this.unexpected.push(`${request.method} ${request.url}`);
    return new Response("stress harness: unexpected fetch", { status: 599 });
  }

  private async revenueCat(url: URL): Promise<Response> {
    const user = decodeURIComponent(url.pathname.slice("/v1/subscribers/".length));
    const n = this.rcCalls.length;
    const call: RcCall = {
      n,
      delivered: -1,
      k: -1,
      user,
      verdict: null,
      t: this.now(),
      tDelivered: -1,
      wallDelivered: -1,
    };
    this.rcCalls.push(call);
    await sleep(this.latency({ hop: "rc", user, tag: null }));
    const k = this.rcDeliveredPerUser.get(user) ?? 0;
    this.rcDeliveredPerUser.set(user, k + 1);
    const seq = this.truth.get(user) ?? [{ kind: "free", tag: "free" } as Verdict];
    const verdict = seq[Math.min(k, seq.length - 1)];
    call.k = k;
    call.verdict = verdict;
    call.delivered = this.rcDelivered++;
    call.tDelivered = this.now();
    call.wallDelivered = Date.now();
    if (verdict.kind === "abort") {
      throw new DOMException("The signal has been aborted", "AbortError");
    }
    if (verdict.kind === "outage") {
      return jsonResponse(503, { code: 7000, message: "stress: RevenueCat outage" });
    }
    const entitlements =
      verdict.kind === "premium"
        ? {
            pickle_sensei_pro: {
              expires_date: verdict.expiresAt,
              product_identifier: verdict.productId,
            },
          }
        : {};
    return jsonResponse(200, {
      request_date_ms: Date.now(),
      subscriber: { original_app_user_id: user, entitlements, subscriptions: {} },
    });
  }

  private async postgrest(request: Request, url: URL, rawBody: string): Promise<Response> {
    const table = url.pathname.slice("/rest/v1/".length);
    const apikey = request.headers.get("apikey") ?? "";
    if (apikey !== SERVICE_ROLE_KEY) {
      // The route must reach these tables with the service-role key only.
      this.unexpected.push(`${request.method} ${table} with non-service key`);
      return jsonResponse(401, { code: "42501", message: "stress: not service role" });
    }
    let body: unknown = null;
    if (request.method === "POST") {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }
    const first = Array.isArray(body) ? body[0] : body;
    const hop: Hop =
      request.method === "GET"
        ? { hop: "seen", user: null, tag: null }
        : table === "billing_entitlements" && isRecord(first)
          ? {
              hop: "billing",
              user: typeof first.user_id === "string" ? first.user_id : null,
              tag: first.premium
                ? typeof first.product_key === "string"
                  ? first.product_key
                  : "premium"
                : "free",
            }
          : { hop: "audit", user: null, tag: null };
    await sleep(this.latency(hop));
    if (table === "webhook_events" && request.method === "GET") {
      const filter = url.searchParams.get("id") ?? "";
      if (!filter.startsWith("eq.")) {
        this.unexpected.push(`GET webhook_events filter ${filter}`);
        return jsonResponse(400, { code: "PGRST100", message: "stress: unexpected filter" });
      }
      const row = await this.backend.lookupEvent(filter.slice(3));
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (!row) {
          return jsonResponse(406, {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: "The result contains 0 rows",
            hint: null,
          });
        }
        return jsonResponse(200, { id: row.id });
      }
      return jsonResponse(200, row ? [{ id: row.id }] : []);
    }
    if (
      request.method === "POST" &&
      (table === "webhook_events" || table === "billing_entitlements")
    ) {
      const prefer = request.headers.get("prefer") ?? "";
      const conflict = url.searchParams.get("on_conflict");
      const rows = Array.isArray(body) ? body : [body];
      let error: DbError | null = null;
      for (const raw of rows) {
        if (!isRecord(raw)) {
          error = { code: "22P02", message: "stress: malformed row" };
          break;
        }
        if (table === "webhook_events") {
          if (conflict !== "id" || !prefer.includes("resolution=ignore-duplicates")) {
            this.unexpected.push(`POST webhook_events on_conflict=${conflict} prefer=${prefer}`);
          }
          error = await this.backend.insertEventIgnoreDuplicate({
            id: String(raw.id),
            provider: String(raw.provider ?? "revenuecat"),
            event_type: typeof raw.event_type === "string" ? raw.event_type : null,
            app_user_id: typeof raw.app_user_id === "string" ? raw.app_user_id : null,
            payload: raw.payload ?? {},
          });
        } else {
          if (conflict !== "user_id" || !prefer.includes("resolution=merge-duplicates")) {
            this.unexpected.push(
              `POST billing_entitlements on_conflict=${conflict} prefer=${prefer}`,
            );
          }
          const row: BillingRow = {
            user_id: String(raw.user_id),
            premium: Boolean(raw.premium),
            product_key: typeof raw.product_key === "string" ? raw.product_key : null,
            expires_at: typeof raw.expires_at === "string" ? raw.expires_at : null,
            verified_at: String(raw.verified_at),
          };
          error = await this.backend.upsertBilling(row);
          if (!error) this.billingWrites.push(row);
        }
        if (error) break;
      }
      if (error) {
        // PostgREST maps 23503 → 409, 42501 → 401/403; the client only reads
        // the body's message/code.
        const status = error.code === "23503" || error.code === "23505" ? 409 : 400;
        return jsonResponse(status, { ...error, details: null, hint: null });
      }
      return prefer.includes("return=representation")
        ? jsonResponse(201, rows)
        : new Response(null, { status: 201 });
    }
    this.unexpected.push(`${request.method} ${request.url}`);
    return jsonResponse(404, { code: "PGRST205", message: `stress: ${table} not modelled` });
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Loading the real handler ─────────────────────────────────────────────────

export interface StressHarness {
  handler: (request: Request) => Promise<Response>;
  world: World;
}

let loaded: StressHarness | null = null;

export async function loadStressHarness(backend: Backend): Promise<StressHarness> {
  if (loaded) {
    loaded.world.backend = backend;
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_stress");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");

  const world = new World(backend);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const rawBody = await request.text().catch(() => "");
    return world.handleFetch(request, rawBody);
  }) as typeof fetch;

  let handler: StressHarness["handler"] | null = null;
  const realServe = Deno.serve;
  (Deno as unknown as { serve: unknown }).serve = (...args: unknown[]) => {
    const fn = args.find((arg) => typeof arg === "function") as
      StressHarness["handler"] | undefined;
    if (!fn) throw new Error("Deno.serve called without a handler");
    handler = fn;
    return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
  };
  await import("../index.ts");
  (Deno as unknown as { serve: unknown }).serve = realServe;
  if (!handler) throw new Error("index.ts did not register a Deno.serve handler");
  loaded = { handler, world };
  return loaded;
}

// ── Request builder ──────────────────────────────────────────────────────────

export function webhookRequest(
  event: Record<string, unknown>,
  options: { ip?: string; authorization?: string } = {},
): Request {
  return new Request("http://edge.stress.test/functions/v1/api/webhooks/revenuecat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: options.authorization ?? WEBHOOK_SECRET,
      "x-forwarded-for": options.ip ?? "203.0.113.99",
    },
    body: JSON.stringify({ api_version: "1.0", event }),
  });
}

export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed : { _raw: text };
  } catch {
    return { _raw: text };
  }
}

// ── Reports ──────────────────────────────────────────────────────────────────

export function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL("../../../../artifacts/stress-webhook-revenuecat/latest/", import.meta.url)
    .pathname;
}

export async function writeJson(name: string, value: unknown): Promise<string> {
  const path = `${outDir()}${name}`;
  await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(path, JSON.stringify(value, null, 2));
  return path;
}

/** The route logs one JSON line per request plus every upstream error; a
 * campaign of thousands of requests would bury the report. Counted, not
 * printed — the counts land in the summary. */
export interface Muted {
  logs: number;
  errors: Record<string, number>;
  restore: () => void;
}

export function muteRouteConsole(): Muted {
  const target: Pick<Console, "log" | "warn" | "error"> = console;
  const original = { log: target.log, warn: target.warn, error: target.error };
  const muted: Muted = {
    logs: 0,
    errors: {},
    restore: () => Object.assign(target, original),
  };
  Object.assign(target, {
    log: () => {
      muted.logs++;
    },
    warn: () => {
      muted.logs++;
    },
    error: (...args: unknown[]) => {
      const key = String(args[0] ?? "").slice(0, 80);
      muted.errors[key] = (muted.errors[key] ?? 0) + 1;
    },
  });
  return muted;
}

export function seededLatency(prng: Prng, maxMs: number): (hop: Hop) => number {
  return () => (maxMs <= 0 ? 0 : prng.int(0, maxMs));
}
