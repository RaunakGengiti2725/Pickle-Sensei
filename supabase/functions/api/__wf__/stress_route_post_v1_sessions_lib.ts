// Stress harness for `POST /v1/sessions` (lens: fuzz-boundary).
//
// Drives the REAL handler in-process (../index.ts through routesHarness.ts —
// Deno.serve captured, Supabase Auth/RevenueCat/Apple stubbed at the fetch
// layer) with a seeded generator of requests that vary body, query string,
// headers, path, method and bearer. On top of the static routesHarness stub
// this module models PostgREST for the ONE table the route touches
// (`public.sessions`: insert-or-ignore upsert, owner-scoped select, the
// finalize PATCH) against a pluggable SessionStore — an in-memory model that
// mirrors the RLS policies, or (stress_route_post_v1_sessions_pg.test.ts) a
// throwaway docker postgres:16 with every migration applied.
//
// Every case is fully determined by its 32-bit seed: the same seed replays
// the same bytes on the wire and the same pre-seeded rows, so a failing seed
// is a one-line repro (STRESS_REPLAY_SEEDS=<seed>). Results are a JSON table
// (seed → outcome) written under STRESS_OUT.
//
// Invariants checked on EVERY response (see checkResponse):
//   * bad input never yields anything but 400/401/403/404/405/413/415/429;
//   * no 5xx unless the case injected an upstream fault, and then the body is
//     the generic retryable message — no SQLSTATE, table, stack or host;
//   * x-request-id present (echoed when the client's was well-formed, minted
//     otherwise) and the access-log line carries the same id, status and a
//     UUID-free route template;
//   * JSON security headers (nosniff / no-store / no-referrer);
//   * rejected requests perform NO write (no insert attempt on the store) and
//     unauthenticated ones perform no PostgREST call at all;
//   * accepted requests leave exactly one row owned by the bearer's user, with
//     body extras (user_id, kind, notes, …) ignored; replays are idempotent;
//     a foreign id yields 409 and leaves the foreign row untouched.

import { captureAccessLog } from "../http.ts";
import { loadHarness, SUPABASE_URL, type Harness } from "./routesHarness.ts";

// ─── Deterministic randomness ───────────────────────────────────────────────

/** mulberry32 (same generator family as xc_concurrency_harness.ts). */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i += 1) out += this.int(0, 15).toString(16);
    return out;
  }
  /** A well-formed RFC 4122 v4 UUID. */
  uuid(): string {
    return `${this.hex(8)}-${this.hex(4)}-4${this.hex(3)}-${"89ab"[this.int(0, 3)]}${this.hex(3)}-${this.hex(12)}`;
  }
  string(length: number, alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"): string {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[this.int(0, alphabet.length - 1)];
    return out;
  }
}

/** Case seed for iteration `i` of a campaign rooted at `base` (murmur3 fmix). */
export function caseSeed(base: number, i: number): number {
  let h = (base ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

// ─── Users, tokens, ips ─────────────────────────────────────────────────────

/** Pool user `i` — a fixed, valid v4 UUID that doubles as the provider `sub`
 * (the routesHarness Auth stub mints user id = sub). */
export function poolUser(i: number): string {
  const hex = (i >>> 0).toString(16).padStart(8, "0");
  return `${hex}-0000-4000-8000-0000${hex}`;
}

export function poolIp(i: number): string {
  return `10.${(i >>> 16) & 0xff}.${(i >>> 8) & 0xff}.${i & 0xff}`;
}

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Seconds well past 2100 so pool tokens are byte-stable across runs. */
const FAR_FUTURE_EXP = 4_102_444_800;

export function jwt(
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", typ: "JWT" },
): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.sig`;
}

export function googleIdToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({ iss: "https://accounts.google.com", sub, exp: FAR_FUTURE_EXP, ...extra });
}

export function appleIdToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({ iss: "https://appleid.apple.com", sub, exp: FAR_FUTURE_EXP, ...extra });
}

/** A Supabase-issued access token (iss …/auth/v1) — verified through the
 * modelled GET /auth/v1/user below. */
export function supabaseAccessToken(sub: string, extra: Record<string, unknown> = {}): string {
  return jwt({
    iss: `${SUPABASE_URL}/auth/v1`,
    sub,
    aud: "authenticated",
    role: "authenticated",
    session_id: `sess-${sub}`,
    exp: FAR_FUTURE_EXP,
    ...extra,
  });
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3) return null;
  try {
    const base64 = segments[1].replace(/-/g, "+").replace(/_/g, "/");
    const parsed = JSON.parse(atob(base64)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ─── Session store (the table the route writes) ─────────────────────────────

export interface SessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
  kind: string;
  notes: string | null;
  event_count: number;
}

/** SQLSTATE-shaped failure, exactly what PostgREST relays. */
export type StoreOutcome<T = undefined> =
  { ok: true; value: T } | { ok: false; sqlstate: string; message: string };

export interface SessionStore {
  readonly name: string;
  /** Make `userId` exist (auth.users → profiles). */
  provisionUsers(userIds: string[]): Promise<void>;
  /** Ground-truth write bypassing RLS (a row some OTHER user created earlier). */
  seedRow(row: { id: string; user_id: string; started_at: string }): Promise<void>;
  /** `insert … on conflict (id) do nothing` as `asUser` under RLS. */
  insertIgnore(
    row: Record<string, unknown>,
    asUser: string | null,
    ignoreDuplicates: boolean,
  ): Promise<StoreOutcome>;
  /** `select <columns> where <eq filters>` as `asUser` under RLS. */
  select(
    columns: string[],
    filters: Array<[string, string]>,
    asUser: string | null,
  ): Promise<StoreOutcome<Record<string, unknown>[]>>;
  /** `update set <patch> where <eq filters>` as `asUser` (column grant: ended_at only). */
  update(
    patch: Record<string, unknown>,
    filters: Array<[string, string]>,
    asUser: string | null,
  ): Promise<StoreOutcome<number>>;
  /** Ground truth, bypassing RLS. */
  rowById(id: string): Promise<SessionRow | null>;
  /** Insert attempts that reached the table (accepted or refused). */
  insertAttempts(): number;
  /** Rows actually created so far. */
  rowsCreated(): number;
  close(): Promise<void>;
}

const UUID_ANY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_COLUMNS = new Set([
  "id",
  "user_id",
  "kind",
  "started_at",
  "ended_at",
  "event_count",
  "notes",
  "created_at",
  "updated_at",
]);

/** In-memory `public.sessions` mirroring 20260829120000_progress_data.sql +
 * 20260831160000_defense_in_depth.sql: PK on id, FK user_id → profiles,
 * owner-only RLS (select/insert/update with check auth.uid() = user_id), and
 * the column-level UPDATE grant limited to ended_at. Deliberately no smarter
 * than Postgres. */
export class MemorySessionStore implements SessionStore {
  readonly name = "memory";
  private rows = new Map<string, SessionRow>();
  private profiles = new Set<string>();
  private attempts = 0;
  private created = 0;
  /** Seeded jitter so concurrent handler calls genuinely interleave. */
  constructor(private readonly jitter: Prng | null = null) {}

  private async pause(): Promise<void> {
    if (!this.jitter) return;
    await new Promise((resolve) => setTimeout(resolve, this.jitter!.int(0, 3)));
  }

  provisionUsers(userIds: string[]): Promise<void> {
    for (const id of userIds) this.profiles.add(id);
    return Promise.resolve();
  }

  seedRow(row: { id: string; user_id: string; started_at: string }): Promise<void> {
    this.profiles.add(row.user_id);
    this.rows.set(row.id.toLowerCase(), {
      id: row.id.toLowerCase(),
      user_id: row.user_id,
      started_at: new Date(row.started_at).toISOString(),
      ended_at: null,
      kind: "practice",
      notes: null,
      event_count: 0,
    });
    return Promise.resolve();
  }

  async insertIgnore(
    row: Record<string, unknown>,
    asUser: string | null,
    ignoreDuplicates: boolean,
  ): Promise<StoreOutcome> {
    await this.pause();
    if (asUser === null) {
      return { ok: false, sqlstate: "42501", message: "permission denied for table sessions" };
    }
    for (const key of Object.keys(row)) {
      if (!SESSION_COLUMNS.has(key)) {
        return {
          ok: false,
          sqlstate: "PGRST204",
          message: `Could not find the '${key}' column of 'sessions' in the schema cache`,
        };
      }
    }
    const id = row.id;
    if (typeof id !== "string" || !UUID_ANY_RE.test(id)) {
      return {
        ok: false,
        sqlstate: "22P02",
        message: `invalid input syntax for type uuid: "${String(id)}"`,
      };
    }
    const userId = row.user_id;
    if (typeof userId !== "string" || !UUID_ANY_RE.test(userId)) {
      return {
        ok: false,
        sqlstate: "23502",
        message: 'null value in column "user_id" violates not-null constraint',
      };
    }
    const startedMs = typeof row.started_at === "string" ? Date.parse(row.started_at) : NaN;
    if (!Number.isFinite(startedMs)) {
      return {
        ok: false,
        sqlstate: "22007",
        message: `invalid input syntax for type timestamp with time zone: "${String(row.started_at)}"`,
      };
    }
    this.attempts += 1;
    // RLS WITH CHECK runs on the candidate row before the conflict check.
    if (userId !== asUser) {
      return {
        ok: false,
        sqlstate: "42501",
        message: 'new row violates row-level security policy for table "sessions"',
      };
    }
    if (!this.profiles.has(userId)) {
      return {
        ok: false,
        sqlstate: "23503",
        message:
          'insert or update on table "sessions" violates foreign key constraint "sessions_user_id_fkey"',
      };
    }
    const key = id.toLowerCase();
    if (this.rows.has(key)) {
      if (ignoreDuplicates) return { ok: true, value: undefined };
      return {
        ok: false,
        sqlstate: "23505",
        message: 'duplicate key value violates unique constraint "sessions_pkey"',
      };
    }
    this.rows.set(key, {
      id: key,
      user_id: userId,
      started_at: new Date(startedMs).toISOString(),
      ended_at: typeof row.ended_at === "string" ? row.ended_at : null,
      kind: typeof row.kind === "string" ? row.kind : "practice",
      notes: typeof row.notes === "string" ? row.notes : null,
      event_count: typeof row.event_count === "number" ? row.event_count : 0,
    });
    this.created += 1;
    return { ok: true, value: undefined };
  }

  private visible(filters: Array<[string, string]>, asUser: string | null): SessionRow[] {
    const out: SessionRow[] = [];
    for (const row of this.rows.values()) {
      if (row.user_id !== asUser) continue; // RLS USING
      let match = true;
      for (const [column, value] of filters) {
        const current = (row as unknown as Record<string, unknown>)[column];
        if (column === "id" || column === "user_id") {
          if (String(current).toLowerCase() !== value.toLowerCase()) match = false;
        } else if (String(current ?? "") !== value) match = false;
      }
      if (match) out.push(row);
    }
    return out;
  }

  async select(
    columns: string[],
    filters: Array<[string, string]>,
    asUser: string | null,
  ): Promise<StoreOutcome<Record<string, unknown>[]>> {
    await this.pause();
    if (asUser === null) {
      return { ok: false, sqlstate: "42501", message: "permission denied for table sessions" };
    }
    for (const [column, value] of filters) {
      if (!SESSION_COLUMNS.has(column)) {
        return {
          ok: false,
          sqlstate: "42703",
          message: `column sessions.${column} does not exist`,
        };
      }
      if ((column === "id" || column === "user_id") && !UUID_ANY_RE.test(value)) {
        return {
          ok: false,
          sqlstate: "22P02",
          message: `invalid input syntax for type uuid: "${value}"`,
        };
      }
    }
    const rows = this.visible(filters, asUser).map((row) => {
      const projected: Record<string, unknown> = {};
      for (const column of columns) {
        projected[column] = (row as unknown as Record<string, unknown>)[column];
      }
      return projected;
    });
    return { ok: true, value: rows };
  }

  async update(
    patch: Record<string, unknown>,
    filters: Array<[string, string]>,
    asUser: string | null,
  ): Promise<StoreOutcome<number>> {
    await this.pause();
    if (asUser === null) {
      return { ok: false, sqlstate: "42501", message: "permission denied for table sessions" };
    }
    for (const key of Object.keys(patch)) {
      if (key !== "ended_at") {
        return { ok: false, sqlstate: "42501", message: "permission denied for table sessions" };
      }
    }
    let n = 0;
    for (const row of this.visible(filters, asUser)) {
      if (typeof patch.ended_at === "string") row.ended_at = new Date(patch.ended_at).toISOString();
      n += 1;
    }
    return { ok: true, value: n };
  }

  rowById(id: string): Promise<SessionRow | null> {
    return Promise.resolve(this.rows.get(id.toLowerCase()) ?? null);
  }
  insertAttempts(): number {
    return this.attempts;
  }
  rowsCreated(): number {
    return this.created;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── PostgREST + GoTrue model layered over routesHarness' fetch stub ────────

export type FaultMode =
  | "none"
  | "upsert-http500"
  | "upsert-http503-html"
  | "upsert-42501"
  | "upsert-throw"
  | "upsert-garbage-2xx"
  | "select-http500"
  | "select-throw"
  | "select-garbage-2xx"
  | "auth-user-http500"
  | "auth-user-throw";

export interface RestModel {
  fault: FaultMode;
  /** Calls that reached the sessions model, by method. */
  restCalls: Array<{ method: string; url: string; asUser: string | null; status: number }>;
  authUserCalls: number;
  /** Users the modelled GET /auth/v1/user recognises. */
  knownUsers: Set<string>;
  restore(): void;
}

const PGRST_STATUS: Record<string, number> = {
  "42501": 403,
  "23503": 409,
  "23505": 409,
  "22P02": 400,
  "22007": 400,
  "23502": 400,
  "42703": 400,
  PGRST204: 400,
};

function pgrstError(sqlstate: string, message: string): Response {
  return new Response(JSON.stringify({ code: sqlstate, message, details: null, hint: null }), {
    status: PGRST_STATUS[sqlstate] ?? 500,
    headers: { "Content-Type": "application/json" },
  });
}

/** The user a user-scoped supabase-js client acts as: the routesHarness Auth
 * stub mints `session-for-<sub>` access tokens; a Supabase JWT carries `sub`. */
export function userOfBearer(authorization: string | null): string | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length);
  if (token.startsWith("session-for-")) return token.slice("session-for-".length);
  const payload = jwtPayload(token);
  return typeof payload?.sub === "string" ? payload.sub : null;
}

export function installRestModel(store: SessionStore): RestModel {
  const base = globalThis.fetch;
  const model: RestModel = {
    fault: "none",
    restCalls: [],
    authUserCalls: 0,
    knownUsers: new Set(),
    restore() {
      globalThis.fetch = base;
    },
  };

  const sessions = async (request: Request, url: URL): Promise<Response> => {
    const asUser = userOfBearer(request.headers.get("authorization"));
    const record = (status: number) =>
      model.restCalls.push({ method: request.method, url: url.toString(), asUser, status });
    const filters: Array<[string, string]> = [];
    let columns = ["*"];
    let onConflict: string | null = null;
    for (const [key, value] of url.searchParams) {
      if (key === "select") columns = value.split(",").map((c) => c.trim());
      else if (key === "on_conflict") onConflict = value;
      else if (value.startsWith("eq.")) filters.push([key, value.slice(3)]);
      else {
        record(500);
        return new Response(`stress model: unsupported filter ${key}=${value}`, { status: 500 });
      }
    }
    const prefer = request.headers.get("prefer") ?? "";

    if (request.method === "POST") {
      if (model.fault === "upsert-throw") {
        record(0);
        throw new TypeError("stress model: connection reset");
      }
      if (model.fault === "upsert-http500") {
        record(500);
        return pgrstError("XX000", "stress model: internal error in upsert");
      }
      if (model.fault === "upsert-http503-html") {
        record(503);
        return new Response(
          "<html><body>503 Service Unavailable (stress model gateway)</body></html>",
          {
            status: 503,
            headers: { "Content-Type": "text/html" },
          },
        );
      }
      if (model.fault === "upsert-42501") {
        record(403);
        return pgrstError(
          "42501",
          'new row violates row-level security policy for table "sessions"',
        );
      }
      if (model.fault === "upsert-garbage-2xx") {
        record(200);
        return new Response("<html>stress model: gateway page instead of JSON</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      let body: unknown;
      try {
        body = JSON.parse(await request.text());
      } catch {
        record(400);
        return pgrstError("PGRST102", "stress model: unparsable insert body");
      }
      const rows = Array.isArray(body) ? body : [body];
      const ignoreDuplicates =
        onConflict === "id" && prefer.includes("resolution=ignore-duplicates");
      for (const row of rows) {
        if (!isRecord(row)) {
          record(400);
          return pgrstError("PGRST102", "stress model: insert row is not an object");
        }
        const outcome = await store.insertIgnore(row, asUser, ignoreDuplicates);
        if (!outcome.ok) {
          const response = pgrstError(outcome.sqlstate, outcome.message);
          record(response.status);
          return response;
        }
      }
      record(201);
      return new Response(null, { status: 201 });
    }

    if (request.method === "GET") {
      if (model.fault === "select-throw") {
        record(0);
        throw new TypeError("stress model: connection reset");
      }
      if (model.fault === "select-http500") {
        record(500);
        return pgrstError("XX000", "stress model: internal error in select");
      }
      if (model.fault === "select-garbage-2xx") {
        record(200);
        return new Response("<html>stress model: gateway page instead of JSON</html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      const outcome = await store.select(columns, filters, asUser);
      if (!outcome.ok) {
        const response = pgrstError(outcome.sqlstate, outcome.message);
        record(response.status);
        return response;
      }
      const accept = request.headers.get("accept") ?? "";
      if (accept.includes("application/vnd.pgrst.object+json")) {
        if (outcome.value.length !== 1) {
          record(406);
          return new Response(
            JSON.stringify({
              code: "PGRST116",
              message: `JSON object requested, multiple (or no) rows returned`,
              details: `Results contain ${outcome.value.length} rows`,
              hint: null,
            }),
            { status: 406, headers: { "Content-Type": "application/json" } },
          );
        }
        record(200);
        return new Response(JSON.stringify(outcome.value[0]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      record(200);
      return new Response(JSON.stringify(outcome.value), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (request.method === "PATCH") {
      let patch: unknown;
      try {
        patch = JSON.parse(await request.text());
      } catch {
        record(400);
        return pgrstError("PGRST102", "stress model: unparsable patch body");
      }
      if (!isRecord(patch)) {
        record(400);
        return pgrstError("PGRST102", "stress model: patch is not an object");
      }
      const outcome = await store.update(patch, filters, asUser);
      if (!outcome.ok) {
        const response = pgrstError(outcome.sqlstate, outcome.message);
        record(response.status);
        return response;
      }
      record(204);
      return new Response(null, { status: 204 });
    }

    record(500);
    return new Response(`stress model: unsupported ${request.method} on sessions`, { status: 500 });
  };

  /** GoTrue's id_token grant, modelled as strictly as the real service is
   * about token SHAPE (signature checking is what `knownUsers` stands in
   * for): three base64url segments, a JSON-object header and payload, a
   * Google/Apple issuer, a non-empty string `sub` that the provider would
   * sign for, and a numeric, unexpired `exp`. The routesHarness stub behind
   * this accepts anything, which would let malformed bearers through. */
  const idTokenGrant = async (request: Request): Promise<Response> => {
    const refuse = (description: string) =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: description }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    let body: unknown;
    try {
      body = JSON.parse(await request.clone().text());
    } catch {
      return refuse("stress gotrue: unparsable grant body");
    }
    const token = isRecord(body) && typeof body.id_token === "string" ? body.id_token : "";
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) {
      return refuse("stress gotrue: token is not a compact JWS");
    }
    let header: unknown;
    try {
      header = JSON.parse(atob(segments[0].replace(/-/g, "+").replace(/_/g, "/")));
    } catch {
      return refuse("stress gotrue: bad header");
    }
    if (!isRecord(header) || typeof header.alg !== "string")
      return refuse("stress gotrue: bad header");
    const payload = jwtPayload(token);
    if (!payload) return refuse("stress gotrue: bad payload");
    const iss = typeof payload.iss === "string" ? payload.iss : "";
    if (
      !["https://accounts.google.com", "accounts.google.com", "https://appleid.apple.com"].includes(
        iss,
      )
    ) {
      return refuse("stress gotrue: issuer");
    }
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now())
      return refuse("stress gotrue: exp");
    if (typeof payload.sub !== "string" || !payload.sub || !model.knownUsers.has(payload.sub)) {
      return refuse("stress gotrue: signature");
    }
    return base(request);
  };

  const authUser = (request: Request): Response => {
    model.authUserCalls += 1;
    if (model.fault === "auth-user-throw") throw new TypeError("stress model: connection reset");
    if (model.fault === "auth-user-http500") {
      return new Response(JSON.stringify({ message: "stress model: gotrue down" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
    const authorization = request.headers.get("authorization") ?? "";
    const payload = jwtPayload(authorization.replace(/^Bearer /, ""));
    const sub = typeof payload?.sub === "string" ? payload.sub : "";
    if (!sub || !model.knownUsers.has(sub)) {
      return new Response(
        JSON.stringify({ code: 401, msg: "invalid JWT: unable to parse or verify signature" }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const noProvider = payload?.stress_no_provider === true;
    return new Response(
      JSON.stringify({
        id: sub,
        aud: "authenticated",
        role: "authenticated",
        email: `${sub}@example.com`,
        app_metadata: noProvider ? {} : { provider: "google", providers: ["google"] },
        user_metadata: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === SUPABASE_URL && url.pathname === "/rest/v1/sessions") {
      return await sessions(request, url);
    }
    if (url.origin === SUPABASE_URL && url.pathname === "/auth/v1/user") {
      return await authUser(request);
    }
    if (
      url.origin === SUPABASE_URL &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "id_token"
    ) {
      return await idTokenGrant(request);
    }
    return await base(request);
  }) as typeof fetch;

  return model;
}

// ─── Independent oracle for the body contract ───────────────────────────────
//
// Written from the wire contract (api-contracts: id is a UUID, startedAt is a
// `Date#toISOString`-shaped UTC instant), NOT copied from index.ts — the
// point is to disagree with the handler when the handler is wrong.

const ORACLE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ORACLE_ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/;

export function oracleIsUuid(value: unknown): boolean {
  return typeof value === "string" && ORACLE_UUID_RE.test(value);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function oracleIsIsoInstant(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const m = ORACLE_ISO_RE.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (year < 2000 || year >= 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return true;
}

/** What a body text MUST produce at the route: 400 unless it is a JSON object
 * with a valid id + startedAt. */
export function oracleBodyValid(bodyText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  return isRecord(parsed) && oracleIsUuid(parsed.id) && oracleIsIsoInstant(parsed.startedAt);
}

// ─── Case generation ────────────────────────────────────────────────────────

export type CaseKind =
  | "valid"
  | "replay-same-user"
  | "replay-other-user"
  | "bad-body"
  | "malformed-json"
  | "oversize"
  | "bad-auth"
  | "wrong-route"
  | "fault";

export const BAD_INPUT_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403, 404, 405, 413, 415, 429,
]);

export interface StepSpec {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** How the body travels: a string, raw bytes, or a chunked stream. */
  body:
    | { kind: "none" }
    | { kind: "text"; text: string }
    | { kind: "bytes"; bytes: Uint8Array }
    | {
        kind: "stream";
        chunks: Uint8Array[];
      };
  /** The text the handler decodes (oracle input); null when there is no body. */
  bodyText: string | null;
  fault: FaultMode;
  /** Authenticated user the handler should resolve (null: must not authenticate). */
  user: string | null;
  requestIdSent: string | null;
  requestIdWellFormed: boolean;
  expect: {
    statuses: number[];
    code: string | null;
    /** An insert attempt may reach the table. */
    writeAllowed: boolean;
    /** No PostgREST call of any kind may happen (pre-auth / auth rejections). */
    noRestCalls: boolean;
    /** No upstream call at all (413 on declared size happens before Auth). */
    noUpstreamCalls: boolean;
  };
}

export interface FuzzCase {
  seed: number;
  kind: CaseKind;
  strategy: string;
  ip: string;
  sessionId: string;
  startedAt: string;
  seedRows: Array<{ id: string; user_id: string; started_at: string }>;
  steps: StepSpec[];
  /** Ground-truth expectation once all steps ran. */
  finalRow:
    { present: false } | { present: true; owner: string; startedAt: string; endedAtNull: boolean };
}

export interface GeneratorConfig {
  users: string[];
  ips: string[];
  /** Stream/declared oversize bodies cost ~5 MB each; keep them rare. */
  oversizeShare: number;
}

const PATH_PREFIXES = ["/functions/v1/api", "/api", "", "/functions/v1/api", "/functions/v1/api"];

const ISO_VALID_EDGES = [
  "2000-01-01T00:00:00Z",
  "2000-01-01T00:00:00.000Z",
  "2099-12-31T23:59:59.999Z",
  "2099-12-31T23:59:59Z",
  "2024-02-29T12:00:00.000Z",
  "2026-09-01T10:00:00.1Z",
  "2026-09-01T10:00:00.123456Z",
  "2026-09-01T10:00:00.123456789Z",
  "2026-12-31T23:59:59.999Z",
];

const ISO_INVALID = [
  "1999-12-31T23:59:59.999Z",
  "2100-01-01T00:00:00Z",
  "2100-01-01T00:00:00.000Z",
  "2023-02-29T12:00:00.000Z",
  "2026-02-30T12:00:00.000Z",
  "2026-04-31T12:00:00.000Z",
  "2026-00-01T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-09-00T00:00:00Z",
  "2026-09-32T00:00:00Z",
  "2026-09-01T24:00:00Z",
  "2026-09-01T23:60:00Z",
  "2026-09-01T23:59:60Z",
  "2026-09-01T10:00:00",
  "2026-09-01T10:00:00+00:00",
  "2026-09-01T10:00:00-05:00",
  "2026-09-01T10:00:00.000+00:00",
  "2026-09-01T10:00:00.000z",
  "2026-09-01 10:00:00Z",
  "2026-09-01T10:00Z",
  "2026-09-01",
  "2026-09-01T10:00:00.Z",
  "2026-09-01T10:00:00.1234567890Z",
  " 2026-09-01T10:00:00.000Z",
  "2026-09-01T10:00:00.000Z ",
  "2026-09-01T10:00:00.000Z\n",
  "2026-09-01T10:00:00.000ZZ",
  "20260901T100000Z",
  "Jan 1 2026",
  "1756720800000",
  "now",
  "",
  "٢٠٢٦-09-01T10:00:00.000Z",
  "2026-09-01T10:00:00.000Z\u0000",
  "+002026-09-01T10:00:00.000Z",
  "2026-9-1T10:00:00.000Z",
];

const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

function mutateUuid(rng: Prng, valid: string): { value: unknown; label: string } {
  const strategies: Array<() => { value: unknown; label: string }> = [
    () => ({ value: valid.toUpperCase(), label: "uuid-upper(valid)" }),
    () => ({ value: valid.replace(/-/g, ""), label: "uuid-no-dashes" }),
    () => ({ value: `{${valid}}`, label: "uuid-braces" }),
    () => ({ value: `urn:uuid:${valid}`, label: "uuid-urn" }),
    () => ({
      value: valid.slice(0, 14) + rng.pick(["0", "9", "a", "f"]) + valid.slice(15),
      label: "uuid-bad-version",
    }),
    () => ({
      value: valid.slice(0, 19) + rng.pick(["0", "7", "c", "f"]) + valid.slice(20),
      label: "uuid-bad-variant",
    }),
    () => ({
      value:
        valid.slice(0, 19) +
        rng.pick(["1", "2", "3", "5", "6", "7", "8"]) +
        valid.slice(15, 19) +
        valid.slice(20),
      label: "uuid-shuffled",
    }),
    () => ({ value: valid.slice(0, -1), label: "uuid-short" }),
    () => ({ value: valid + rng.hex(1), label: "uuid-long" }),
    () => ({ value: ` ${valid}`, label: "uuid-leading-space" }),
    () => ({ value: `${valid}\n`, label: "uuid-trailing-newline" }),
    () => ({ value: NIL_UUID, label: "uuid-nil" }),
    () => ({ value: MAX_UUID, label: "uuid-max" }),
    () => ({ value: valid.replace(/[0-9a-f]/, "g"), label: "uuid-non-hex" }),
    () => ({ value: valid.replace("-", "\u2010"), label: "uuid-unicode-dash" }),
    () => ({ value: `${valid}\u0000`, label: "uuid-nul" }),
    () => ({ value: rng.int(0, 2 ** 31), label: "uuid-number" }),
    () => ({ value: null, label: "uuid-null" }),
    () => ({ value: true, label: "uuid-bool" }),
    () => ({ value: [valid], label: "uuid-array" }),
    () => ({ value: { id: valid }, label: "uuid-object" }),
    () => ({ value: "", label: "uuid-empty" }),
    () => ({ value: rng.string(rng.int(1, 200)), label: "uuid-random-string" }),
    () => ({ value: "a".repeat(rng.int(1_000, 200_000)), label: "uuid-huge-string" }),
    () => ({ value: "' OR 1=1 --", label: "uuid-sqli" }),
    () => ({ value: `${valid}' OR '1'='1`, label: "uuid-sqli-suffix" }),
    () => ({ value: "../../etc/passwd", label: "uuid-traversal" }),
    () => ({ value: "<script>alert(1)</script>", label: "uuid-html" }),
    () => ({
      value:
        rng.hex(8) +
        "-" +
        rng.hex(4) +
        "-4" +
        rng.hex(3) +
        "-" +
        rng.pick(["8", "9", "a", "b"]) +
        rng.hex(3) +
        "-" +
        rng.hex(11) +
        "g",
      label: "uuid-last-char-bad",
    }),
    () => ({ value: valid.split("").reverse().join(""), label: "uuid-reversed" }),
  ];
  return rng.pick(strategies)();
}

function mutateStartedAt(rng: Prng): { value: unknown; label: string } {
  const strategies: Array<() => { value: unknown; label: string }> = [
    () => ({ value: rng.pick(ISO_INVALID), label: "iso-invalid-list" }),
    () => ({
      value: Date.UTC(2026, 8, 1) + rng.int(0, 90 * 24 * 3600 * 1000),
      label: "iso-epoch-number",
    }),
    () => ({ value: null, label: "iso-null" }),
    () => ({ value: false, label: "iso-bool" }),
    () => ({ value: ["2026-09-01T10:00:00.000Z"], label: "iso-array" }),
    () => ({ value: { $date: "2026-09-01T10:00:00.000Z" }, label: "iso-object" }),
    () => ({ value: rng.string(rng.int(1, 64), "0123456789-:TZ."), label: "iso-random-shape" }),
    () => ({
      value: `${rng.int(0, 9999).toString().padStart(4, "0")}-${rng.int(0, 19).toString().padStart(2, "0")}-${rng.int(0, 39).toString().padStart(2, "0")}T${rng.int(0, 29).toString().padStart(2, "0")}:${rng.int(0, 69).toString().padStart(2, "0")}:${rng.int(0, 69).toString().padStart(2, "0")}Z`,
      label: "iso-random-fields",
    }),
    () => ({ value: "2026-09-01T10:00:00.000Z".repeat(rng.int(2, 5000)), label: "iso-repeated" }),
    () => ({ value: "1970-01-01T00:00:00.000Z", label: "iso-epoch" }),
    () => ({ value: "0000-01-01T00:00:00.000Z", label: "iso-year0" }),
    () => ({ value: "9999-12-31T23:59:59.999Z", label: "iso-year9999" }),
    () => ({ value: "275760-09-13T00:00:00.000Z", label: "iso-max-date" }),
  ];
  return rng.pick(strategies)();
}

const EXTRA_FIELD_POOL: Array<[string, () => unknown]> = [
  ["mode", () => "practice"],
  ["shotType", () => "dink"],
  ["focusCheckpoint", () => "contact_position"],
  ["kind", () => "game"],
  ["ended_at", () => "2026-09-01T11:00:00.000Z"],
  ["endedAt", () => "2026-09-01T11:00:00.000Z"],
  ["notes", () => "x".repeat(5000)],
  ["event_count", () => -1],
  ["created_at", () => "1999-01-01T00:00:00.000Z"],
  ["updated_at", () => "1999-01-01T00:00:00.000Z"],
  ["__proto__", () => ({ polluted: true })],
  ["constructor", () => ({ prototype: { polluted: true } })],
  ["toString", () => "x"],
  ["", () => ""],
  ["\u0000", () => "nul-key"],
  ["id ", () => "trailing-space-key"],
  ["ID", () => "case-key"],
  ["startedat", () => "case-key"],
];

/** A JSON text for a body object with seeded key order / whitespace / escapes. */
function renderJson(rng: Prng, entries: Array<[string, unknown]>): string {
  const shuffled = [...entries];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = rng.int(0, i);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const ws = rng.pick(["", " ", "\n  ", "\t"]);
  const parts = shuffled.map(([key, value]) => {
    let renderedKey = JSON.stringify(key);
    if (rng.chance(0.15)) {
      // Escape every char as \uXXXX — same key after JSON.parse.
      renderedKey = `"${Array.from(key)
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("")}"`;
    }
    let renderedValue = JSON.stringify(value);
    if (typeof value === "string" && rng.chance(0.1)) {
      renderedValue = `"${Array.from(value)
        .map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)
        .join("")}"`;
    }
    return `${ws}${renderedKey}:${ws}${renderedValue}`;
  });
  return `{${parts.join(",")}${ws}}`;
}

function textBody(text: string): StepSpec["body"] {
  return { kind: "text", text };
}

interface AuthChoice {
  header: string | null;
  user: string | null;
  label: string;
}

function validAuth(rng: Prng, user: string): AuthChoice {
  const flavour = rng.int(0, 9);
  if (flavour < 5)
    return { header: `Bearer ${googleIdToken(user)}`, user, label: "google-id-token" };
  if (flavour < 7) return { header: `Bearer ${appleIdToken(user)}`, user, label: "apple-id-token" };
  return { header: `Bearer ${supabaseAccessToken(user)}`, user, label: "supabase-access-token" };
}

function badAuth(rng: Prng, user: string): AuthChoice {
  const strategies: Array<() => AuthChoice> = [
    () => ({ header: null, user: null, label: "auth-missing" }),
    () => ({ header: "", user: null, label: "auth-empty" }),
    () => ({ header: "Bearer", user: null, label: "auth-bearer-no-token" }),
    () => ({ header: "Bearer ", user: null, label: "auth-bearer-space" }),
    () => ({ header: `bearer ${googleIdToken(user)}`, user: null, label: "auth-lowercase-scheme" }),
    () => ({ header: `Basic ${btoa("user:pass")}`, user: null, label: "auth-basic" }),
    () => ({ header: `Bearer ${rng.string(rng.int(1, 80))}`, user: null, label: "auth-garbage" }),
    () => ({ header: `Bearer a.b`, user: null, label: "auth-two-segments" }),
    () => ({ header: `Bearer a.b.c.d`, user: null, label: "auth-four-segments" }),
    () => ({
      header: `Bearer ${googleIdToken(user, { exp: 1_600_000_000 })}`,
      user: null,
      label: "auth-expired-google",
    }),
    () => ({
      header: `Bearer ${supabaseAccessToken(user, { exp: 1_600_000_000 })}`,
      user: null,
      label: "auth-expired-session",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://evil.example.com", sub: user, exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-unknown-issuer",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com.evil.example", sub: user, exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-issuer-suffix",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "http://accounts.google.com", sub: user, exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-issuer-http",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-no-sub",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: "", exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-empty-sub",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: 12345, exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-numeric-sub",
    }),
    () => ({
      header: `Bearer ${supabaseAccessToken(rng.uuid())}`,
      user: null,
      label: "auth-session-unknown-user",
    }),
    () => ({
      header: `Bearer ${supabaseAccessToken(user, { stress_no_provider: true })}`,
      user: null,
      label: "auth-session-no-provider",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: `${SUPABASE_URL}/auth/v1`, exp: FAR_FUTURE_EXP })}`,
      user: null,
      label: "auth-session-no-sub",
    }),
    () => ({
      header: `Bearer ${"x".repeat(rng.int(10_000, 70_000))}`,
      user: null,
      label: "auth-huge",
    }),
    () => ({
      header: `Bearer ${b64url("{}")}.${b64url("[]")}.sig`,
      user: null,
      label: "auth-array-payload",
    }),
    () => ({
      header: `Bearer ${b64url("{}")}.${b64url("null")}.sig`,
      user: null,
      label: "auth-null-payload",
    }),
    () => ({ header: `Bearer ${b64url("{}")}.!!!.sig`, user: null, label: "auth-bad-base64" }),
    () => ({
      header: `Bearer ${googleIdToken(user)} extra`,
      user: null,
      label: "auth-trailing-token",
    }),
    () => ({
      header: `Bearer Bearer ${googleIdToken(user)}`,
      user: null,
      label: "auth-double-bearer",
    }),
    () => ({ header: `Token ${googleIdToken(user)}`, user: null, label: "auth-wrong-scheme" }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: user, exp: "soon" })}`,
      user: null,
      label: "auth-string-exp",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: user, exp: FAR_FUTURE_EXP }, { alg: "none" }).replace(/\.sig$/, ".")}`,
      user: null,
      label: "auth-alg-none-unsigned",
    }),
    () => ({
      header: `Bearer ${jwt({ iss: "https://accounts.google.com", sub: user, exp: FAR_FUTURE_EXP })}.extra`,
      user: null,
      label: "auth-five-segments",
    }),
  ];
  return rng.pick(strategies)();
}

function requestIdChoice(rng: Prng): { value: string | null; wellFormed: boolean; label: string } {
  const roll = rng.next();
  if (roll < 0.55) return { value: null, wellFormed: false, label: "rid-none" };
  if (roll < 0.8) {
    const length = rng.int(8, 64);
    return {
      value: rng.string(
        length,
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-",
      ),
      wellFormed: true,
      label: "rid-valid",
    };
  }
  const bad = rng.pick([
    rng.string(rng.int(1, 7)),
    rng.string(rng.int(65, 300)),
    `${rng.string(10)} ${rng.string(4)}`,
    `${rng.string(10)}/${rng.string(4)}`,
    `${rng.string(10)}\u00e9`,
    `<${rng.string(10)}>`,
    `${rng.string(10)}\t`,
    `   ${rng.string(12)}   `,
    "",
  ]);
  return {
    value: bad,
    wellFormed: /^[A-Za-z0-9._-]{8,64}$/.test(bad.trim()),
    label: "rid-malformed",
  };
}

function ipHeaders(rng: Prng, ip: string): { headers: Array<[string, string]>; label: string } {
  const roll = rng.next();
  if (roll < 0.6) return { headers: [["x-forwarded-for", ip]], label: "ip-xff" };
  if (roll < 0.75)
    return {
      headers: [["x-forwarded-for", `198.51.100.${rng.int(1, 254)}, ${ip}`]],
      label: "ip-xff-hops",
    };
  if (roll < 0.85)
    return {
      headers: [
        ["cf-connecting-ip", ip],
        ["x-forwarded-for", "203.0.113.99"],
      ],
      label: "ip-cf",
    };
  if (roll < 0.93) return { headers: [["x-forwarded-for", `  ${ip}  `]], label: "ip-xff-padded" };
  return { headers: [["x-forwarded-for", `${ip},`]], label: "ip-xff-trailing-comma" };
}

function contentTypeHeader(rng: Prng): Array<[string, string]> {
  const roll = rng.next();
  if (roll < 0.6) return [["content-type", "application/json"]];
  if (roll < 0.7) return [["content-type", "application/json; charset=utf-8"]];
  if (roll < 0.75) return [];
  return [
    [
      "content-type",
      rng.pick([
        "text/plain",
        "application/x-www-form-urlencoded",
        "multipart/form-data; boundary=----stress",
        "application/json; charset=utf-16",
        "application/xml",
        "image/png",
        "*/*",
      ]),
    ],
  ];
}

function noiseHeaders(rng: Prng): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const n = rng.int(0, 4);
  for (let i = 0; i < n; i += 1) {
    out.push(
      rng.pick<[string, string]>([
        [
          "accept",
          rng.pick(["application/json", "*/*", "text/html", "application/vnd.pgrst.object+json"]),
        ],
        [
          "prefer",
          rng.pick(["return=representation", "resolution=merge-duplicates", "count=exact"]),
        ],
        ["apikey", rng.string(20)],
        ["x-client-info", `stress/${rng.int(0, 99)}`],
        ["origin", rng.pick(["https://evil.example", "null", "http://localhost"])],
        ["user-agent", `PickleSensei/${rng.int(1, 9)}.0 (${rng.string(6)})`],
        ["accept-encoding", "gzip, br"],
        ["x-supabase-auth", rng.string(12)],
        ["cookie", `sb-access-token=${rng.string(30)}`],
        ["x-http-method-override", rng.pick(["DELETE", "PUT", "GET"])],
        ["transfer-encoding", "chunked"],
        ["expect", "100-continue"],
        ["range", "bytes=0-1"],
        ["if-match", '"etag"'],
        [`x-${rng.string(8)}`, rng.string(rng.int(0, 200))],
      ]),
    );
  }
  return out;
}

function queryString(rng: Prng, sessionId: string): string {
  const roll = rng.next();
  if (roll < 0.5) return "";
  const params: string[] = [];
  const n = rng.int(1, 5);
  for (let i = 0; i < n; i += 1) {
    params.push(
      rng.pick([
        `id=${rng.uuid()}`,
        `id=${sessionId}`,
        `startedAt=${encodeURIComponent("2026-09-01T10:00:00.000Z")}`,
        `select=*`,
        `user_id=eq.${rng.uuid()}`,
        `on_conflict=id`,
        `${rng.string(rng.int(1, 10))}=${rng.string(rng.int(0, 30))}`,
        `x=${"y".repeat(rng.int(100, 10_000))}`,
        `%00=%00`,
        `a[]=1&a[]=2`,
        `__proto__[polluted]=1`,
        `=`,
        `&&&`,
        `q=%E2%9C%93`,
        `q=%ZZ`,
      ]),
    );
  }
  return `?${params.join("&")}`;
}

const V1_SESSIONS_PATHS_OK = ["/v1/sessions"];

export function buildStep(
  rng: Prng,
  args: {
    method: string;
    path: string;
    query: string;
    auth: AuthChoice;
    ip: string;
    body: StepSpec["body"];
    bodyText: string | null;
    extraHeaders?: Array<[string, string]>;
    fault?: FaultMode;
    expect: StepSpec["expect"];
  },
): StepSpec {
  const prefix = rng.pick(PATH_PREFIXES);
  const headers: Array<[string, string]> = [];
  if (args.auth.header !== null) headers.push(["authorization", args.auth.header]);
  headers.push(...ipHeaders(rng, args.ip).headers);
  const rid = requestIdChoice(rng);
  if (rid.value !== null) headers.push(["x-request-id", rid.value]);
  if (args.body.kind !== "none") headers.push(...contentTypeHeader(rng));
  headers.push(...noiseHeaders(rng));
  headers.push(...(args.extraHeaders ?? []));
  return {
    method: args.method,
    url: `http://edge.test${prefix}${args.path}${args.query}`,
    headers,
    body: args.body,
    bodyText: args.bodyText,
    fault: args.fault ?? "none",
    user: args.auth.user,
    requestIdSent: rid.value,
    requestIdWellFormed: rid.wellFormed,
    expect: args.expect,
  };
}

const EXPECT_OK: StepSpec["expect"] = {
  statuses: [200],
  code: null,
  writeAllowed: true,
  noRestCalls: false,
  noUpstreamCalls: false,
};
const EXPECT_400_BODY: StepSpec["expect"] = {
  statuses: [400],
  code: "validation.session",
  writeAllowed: false,
  noRestCalls: false,
  noUpstreamCalls: false,
};

function validBodyEntries(
  rng: Prng,
  sessionId: string,
  startedAt: string,
  otherUser: string,
): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [
    ["id", sessionId],
    ["startedAt", startedAt],
  ];
  const extras = rng.int(0, 4);
  for (let i = 0; i < extras; i += 1) {
    const [key, make] = rng.pick(EXTRA_FIELD_POOL);
    if (entries.some(([k]) => k === key)) continue;
    entries.push([key, make()]);
  }
  if (rng.chance(0.3)) entries.push(["user_id", otherUser]);
  if (rng.chance(0.2)) entries.push(["userId", otherUser]);
  return entries;
}

export function generateCase(seed: number, config: GeneratorConfig): FuzzCase {
  const rng = new Prng(seed);
  const user = rng.pick(config.users);
  let otherUser = rng.pick(config.users);
  if (otherUser === user)
    otherUser = config.users[(config.users.indexOf(user) + 1) % config.users.length];
  const ip = rng.pick(config.ips);
  // Seed-prefixed so ids never collide across cases and replaying a seed
  // reproduces the same id.
  const sessionId = `${(seed >>> 0).toString(16).padStart(8, "0")}-${rng.hex(4)}-4${rng.hex(3)}-${"89ab"[rng.int(0, 3)]}${rng.hex(3)}-${rng.hex(12)}`;
  const startedAt = rng.chance(0.2)
    ? rng.pick(ISO_VALID_EDGES)
    : new Date(
        Date.UTC(
          rng.int(2000, 2099),
          rng.int(0, 11),
          rng.int(1, 28),
          rng.int(0, 23),
          rng.int(0, 59),
          rng.int(0, 59),
          rng.int(0, 999),
        ),
      ).toISOString();

  const roll = rng.next();
  let kind: CaseKind;
  if (roll < 0.2) kind = "valid";
  else if (roll < 0.27) kind = "replay-same-user";
  else if (roll < 0.33) kind = "replay-other-user";
  else if (roll < 0.58) kind = "bad-body";
  else if (roll < 0.66) kind = "malformed-json";
  else if (roll < 0.66 + config.oversizeShare) kind = "oversize";
  else if (roll < 0.66 + config.oversizeShare + 0.12) kind = "bad-auth";
  else if (roll < 0.66 + config.oversizeShare + 0.22) kind = "wrong-route";
  else kind = "fault";

  const base: Omit<FuzzCase, "steps" | "strategy" | "finalRow" | "seedRows"> = {
    seed,
    kind,
    ip,
    sessionId,
    startedAt,
  };
  const path = rng.pick(V1_SESSIONS_PATHS_OK);
  const query = queryString(rng, sessionId);

  switch (kind) {
    case "valid": {
      const auth = validAuth(rng, user);
      const text = renderJson(rng, validBodyEntries(rng, sessionId, startedAt, otherUser));
      const wire = rng.next();
      const body: StepSpec["body"] =
        wire < 0.7
          ? textBody(text)
          : wire < 0.85
            ? { kind: "bytes", bytes: new TextEncoder().encode(text) }
            : { kind: "stream", chunks: chunk(new TextEncoder().encode(text), rng.int(1, 64)) };
      return {
        ...base,
        strategy: `${auth.label}/${body.kind}`,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body,
            bodyText: text,
            expect: EXPECT_OK,
          }),
        ],
        finalRow: { present: true, owner: user, startedAt, endedAtNull: true },
      };
    }
    case "replay-same-user": {
      const auth = validAuth(rng, user);
      const text = renderJson(rng, validBodyEntries(rng, sessionId, startedAt, otherUser));
      const secondAuth = rng.chance(0.5) ? auth : validAuth(rng, user);
      // The replay may carry different extras / a different startedAt: the
      // first write wins and the replay is still a 200.
      const replayText = rng.chance(0.5)
        ? text
        : renderJson(rng, [
            ["id", sessionId],
            ["startedAt", rng.pick(ISO_VALID_EDGES)],
            ["mode", "replay"],
          ]);
      const steps = [
        buildStep(rng, {
          method: "POST",
          path,
          query,
          auth,
          ip,
          body: textBody(text),
          bodyText: text,
          expect: EXPECT_OK,
        }),
        buildStep(rng, {
          method: "POST",
          path,
          query: queryString(rng, sessionId),
          auth: secondAuth,
          ip,
          body: textBody(replayText),
          bodyText: replayText,
          expect: EXPECT_OK,
        }),
      ];
      if (rng.chance(0.3)) {
        steps.push(
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: textBody(text),
            bodyText: text,
            expect: EXPECT_OK,
          }),
        );
      }
      return {
        ...base,
        strategy: `replay×${steps.length}/${auth.label}`,
        seedRows: [],
        steps,
        finalRow: { present: true, owner: user, startedAt, endedAtNull: true },
      };
    }
    case "replay-other-user": {
      const auth = validAuth(rng, user);
      const foreignStartedAt = "2026-01-02T03:04:05.000Z";
      const text = renderJson(rng, validBodyEntries(rng, sessionId, startedAt, otherUser));
      const expect409: StepSpec["expect"] = {
        statuses: [409],
        code: "session.id_conflict",
        writeAllowed: true, // the insert-or-ignore is attempted; it must not land
        noRestCalls: false,
        noUpstreamCalls: false,
      };
      const steps = [
        buildStep(rng, {
          method: "POST",
          path,
          query,
          auth,
          ip,
          body: textBody(text),
          bodyText: text,
          expect: expect409,
        }),
      ];
      if (rng.chance(0.4)) {
        steps.push(
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: textBody(text),
            bodyText: text,
            expect: expect409,
          }),
        );
      }
      return {
        ...base,
        strategy: `foreign-id/${auth.label}`,
        seedRows: [{ id: sessionId, user_id: otherUser, started_at: foreignStartedAt }],
        steps,
        finalRow: {
          present: true,
          owner: otherUser,
          startedAt: foreignStartedAt,
          endedAtNull: true,
        },
      };
    }
    case "bad-body": {
      const auth = validAuth(rng, user);
      const entries: Array<[string, unknown]> = [];
      let label: string;
      const which = rng.next();
      if (which < 0.35) {
        const m = mutateUuid(rng, sessionId);
        entries.push(["id", m.value], ["startedAt", startedAt]);
        label = m.label;
      } else if (which < 0.7) {
        const m = mutateStartedAt(rng);
        entries.push(["id", sessionId], ["startedAt", m.value]);
        label = m.label;
      } else if (which < 0.8) {
        const a = mutateUuid(rng, sessionId);
        const b = mutateStartedAt(rng);
        entries.push(["id", a.value], ["startedAt", b.value]);
        label = `${a.label}+${b.label}`;
      } else if (which < 0.87) {
        entries.push(rng.chance(0.5) ? ["id", sessionId] : ["startedAt", startedAt]);
        label = "one-field-missing";
      } else if (which < 0.92) {
        entries.push(["Id", sessionId], ["started_at", startedAt]);
        label = "wrong-key-case";
      } else if (which < 0.96) {
        entries.push(["session", { id: sessionId, startedAt }]);
        label = "nested-under-key";
      } else {
        label = "empty-object";
      }
      // Extras never rescue a bad body.
      const extras = rng.int(0, 3);
      for (let i = 0; i < extras; i += 1) {
        const [key, make] = rng.pick(EXTRA_FIELD_POOL);
        if (entries.some(([k]) => k === key)) continue;
        entries.push([key, make()]);
      }
      let text = renderJson(rng, entries);
      // Duplicate-key trick: the LAST occurrence wins in JSON.parse, so a valid
      // pair after the bad one flips the body back to valid (oracle decides).
      if (rng.chance(0.08)) {
        text = text.replace(
          /}$/,
          `,"id":${JSON.stringify(sessionId)},"startedAt":${JSON.stringify(startedAt)}}`,
        );
        label += "+dup-keys-valid-last";
      }
      const valid = oracleBodyValid(text);
      return {
        ...base,
        strategy: `${label}${valid ? "(oracle:valid)" : ""}`,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: rng.chance(0.8)
              ? textBody(text)
              : { kind: "bytes", bytes: new TextEncoder().encode(text) },
            bodyText: text,
            expect: valid ? EXPECT_OK : EXPECT_400_BODY,
          }),
        ],
        finalRow: valid
          ? { present: true, owner: user, startedAt: parsedStartedAt(text), endedAtNull: true }
          : { present: false },
      };
    }
    case "malformed-json": {
      const auth = validAuth(rng, user);
      const validText = renderJson(rng, [
        ["id", sessionId],
        ["startedAt", startedAt],
      ]);
      const choice = rng.pick<[string, string | Uint8Array]>([
        ["empty", ""],
        ["whitespace", "   \n\t "],
        ["truncated", validText.slice(0, rng.int(1, validText.length - 1))],
        ["trailing-comma", validText.replace(/}$/, ",}")],
        ["trailing-garbage", `${validText}garbage`],
        ["double-object", `${validText}${validText}`],
        ["single-quotes", validText.replace(/"/g, "'")],
        ["unquoted-keys", validText.replace(/"(id|startedAt)"/g, "$1")],
        ["nan", `{"id":NaN,"startedAt":Infinity}`],
        ["comment", `/* c */ ${validText}`],
        ["bom", `\uFEFF${validText}`],
        ["array-root", `[${validText}]`],
        ["string-root", JSON.stringify(validText)],
        ["number-root", "42"],
        ["null-root", "null"],
        ["true-root", "true"],
        ["form-encoded", `id=${sessionId}&startedAt=${encodeURIComponent(startedAt)}`],
        ["xml", `<session><id>${sessionId}</id><startedAt>${startedAt}</startedAt></session>`],
        ["deep-nesting", `${"[".repeat(rng.int(1_000, 200_000))}`],
        ["deep-nesting-closed", `${"[".repeat(50_000)}${"]".repeat(50_000)}`],
        ["deep-object", `${'{"a":'.repeat(20_000)}1${"}".repeat(20_000)}`],
        ["huge-number", `{"id":${"9".repeat(5000)},"startedAt":1e400}`],
        [
          "invalid-utf8",
          new Uint8Array([0x7b, 0x22, 0x69, 0x64, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0xc0, 0x22, 0x7d]),
        ],
        [
          "utf16le",
          new Uint8Array(
            Array.from(validText).flatMap((c) => [c.charCodeAt(0) & 0xff, c.charCodeAt(0) >> 8]),
          ),
        ],
        ["nul-bytes", new Uint8Array([0, 0, 0, 0])],
        [
          "random-bytes",
          (() => {
            const bytes = new Uint8Array(rng.int(1, 4096));
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = rng.int(0, 255);
            return bytes;
          })(),
        ],
        ["lone-surrogate-escape", `{"id":"\\ud800","startedAt":"\\udfff"}`],
        ["valid-with-nul-suffix", `${validText}\u0000`],
        [
          "gzip-magic",
          new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03]),
        ],
      ]);
      const [label, payload] = choice;
      const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
      const decoded = new TextDecoder().decode(bytes);
      const valid = oracleBodyValid(decoded);
      const noBody = rng.chance(0.06);
      const body: StepSpec["body"] = noBody
        ? { kind: "none" }
        : rng.chance(0.3)
          ? { kind: "stream", chunks: chunk(bytes, rng.int(1, 512)) }
          : { kind: "bytes", bytes };
      return {
        ...base,
        strategy: noBody ? "no-body" : `${label}/${body.kind}${valid ? "(oracle:valid)" : ""}`,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body,
            bodyText: noBody ? "" : decoded,
            expect: !noBody && valid ? EXPECT_OK : EXPECT_400_BODY,
          }),
        ],
        finalRow:
          !noBody && valid
            ? { present: true, owner: user, startedAt: parsedStartedAt(decoded), endedAtNull: true }
            : { present: false },
      };
    }
    case "oversize": {
      const auth = rng.chance(0.75) ? validAuth(rng, user) : badAuth(rng, user);
      const text = renderJson(rng, [
        ["id", sessionId],
        ["startedAt", startedAt],
      ]);
      const which = rng.next();
      if (which < 0.45) {
        // Declared > cap (body itself small): refused before Auth is consulted.
        const declared = rng.pick([
          "5000001",
          "5000000000",
          "9".repeat(30),
          "1e7",
          " 6000000",
          "6000000.5",
        ]);
        return {
          ...base,
          strategy: `declared-${declared.length > 12 ? "huge" : declared}/${auth.label}`,
          seedRows: [],
          steps: [
            buildStep(rng, {
              method: "POST",
              path,
              query,
              auth,
              ip,
              body: textBody(text),
              bodyText: text,
              extraHeaders: [["content-length", declared]],
              expect: {
                statuses: [413],
                code: null,
                writeAllowed: false,
                noRestCalls: true,
                noUpstreamCalls: true,
              },
            }),
          ],
          finalRow: { present: false },
        };
      }
      if (which < 0.6) {
        // Declared exactly at / under the cap or unparsable: the body decides.
        const declared = rng.pick([
          "5000000",
          "-1",
          "NaN",
          "abc",
          "0",
          "1",
          "1e999",
          "Infinity",
          "",
          "0x10",
        ]);
        const validAuthed = auth.user !== null;
        return {
          ...base,
          strategy: `declared-noncap-${declared || "empty"}/${auth.label}`,
          seedRows: [],
          steps: [
            buildStep(rng, {
              method: "POST",
              path,
              query,
              auth,
              ip,
              body: textBody(text),
              bodyText: text,
              extraHeaders: [["content-length", declared]],
              expect: validAuthed
                ? EXPECT_OK
                : {
                    statuses: [401, 429],
                    code: null,
                    writeAllowed: false,
                    noRestCalls: true,
                    noUpstreamCalls: false,
                  },
            }),
          ],
          finalRow: validAuthed
            ? { present: true, owner: user, startedAt, endedAtNull: true }
            : { present: false },
        };
      }
      // Actual bytes past the cap without a truthful Content-Length (chunked):
      // the streaming reader must cut it at the cap. Valid JSON is padded with
      // whitespace so, were the cap ignored, the body would be ACCEPTED.
      const overBy = rng.int(1, 4096);
      const padding = 5_000_000 + overBy - text.length;
      const big = `${" ".repeat(padding)}${text}`;
      const validAuthed = auth.user !== null;
      return {
        ...base,
        strategy: `streamed-${5_000_000 + overBy}B/${auth.label}`,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: { kind: "stream", chunks: chunk(new TextEncoder().encode(big), 65_536) },
            bodyText: big,
            expect: validAuthed
              ? {
                  statuses: [413],
                  code: null,
                  writeAllowed: false,
                  noRestCalls: true,
                  noUpstreamCalls: false,
                }
              : {
                  statuses: [401, 413, 429],
                  code: null,
                  writeAllowed: false,
                  noRestCalls: true,
                  noUpstreamCalls: false,
                },
          }),
        ],
        finalRow: { present: false },
      };
    }
    case "bad-auth": {
      const auth = badAuth(rng, user);
      const text = renderJson(rng, validBodyEntries(rng, sessionId, startedAt, otherUser));
      const authed = auth.user !== null;
      return {
        ...base,
        strategy: auth.label,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: textBody(text),
            bodyText: text,
            expect: authed
              ? EXPECT_OK
              : {
                  statuses: [401, 429],
                  code: null,
                  writeAllowed: false,
                  noRestCalls: true,
                  noUpstreamCalls: false,
                },
          }),
        ],
        finalRow: authed
          ? { present: true, owner: user, startedAt, endedAtNull: true }
          : { present: false },
      };
    }
    case "wrong-route": {
      const auth = validAuth(rng, user);
      const text = renderJson(rng, [
        ["id", sessionId],
        ["startedAt", startedAt],
      ]);
      const which = rng.next();
      if (which < 0.4) {
        // `post`/`Post` are normalised to POST by the Request constructor
        // (fetch spec) and therefore ARE the route; TRACE/CONNECT are
        // forbidden methods and never construct.
        const method = rng.pick([
          "GET",
          "PUT",
          "PATCH",
          "DELETE",
          "HEAD",
          "OPTIONS",
          "PROPFIND",
          "post",
          "Post",
        ]);
        const isPost = method.toUpperCase() === "POST";
        const hasBody = isPost || (!["GET", "HEAD"].includes(method) && rng.chance(0.7));
        return {
          ...base,
          strategy: `method-${method}`,
          seedRows: [],
          steps: [
            buildStep(rng, {
              method,
              path,
              query,
              auth,
              ip,
              body: hasBody ? textBody(text) : { kind: "none" },
              bodyText: hasBody ? text : null,
              expect: isPost
                ? EXPECT_OK
                : {
                    statuses: [404, 405],
                    code: null,
                    writeAllowed: false,
                    noRestCalls: false,
                    noUpstreamCalls: false,
                  },
            }),
          ],
          finalRow: isPost
            ? { present: true, owner: user, startedAt, endedAtNull: true }
            : { present: false },
        };
      }
      if (which < 0.75) {
        // [path, expected statuses, routes to createSession after WHATWG URL
        // normalisation (dot segments collapse, `?` starts the query)]
        const [variant, statuses, isRoute] = rng.pick<[string, number[], boolean]>([
          ["/v1/sessions/", [404], false],
          ["/v1/Sessions", [404], false],
          ["/v1/SESSIONS", [404], false],
          ["/v1/sessions%20", [404], false],
          ["/v1/sessions%2F", [404], false],
          ["/v1/sessions/../sessions", [200], true],
          ["/v1/sessions/./", [404], false],
          ["/v1//sessions", [404], false],
          ["/v1/sessions;x=1", [404], false],
          ["/v1/sessions.json", [404], false],
          ["/v1/session", [404], false],
          ["/v1/sessionss", [404], false],
          ["/v1/sessions/v1/sessions", [200], true],
          ["/v2/sessions", [404], false],
          ["/v1/sessions%00", [400, 404], false],
          ["/v1/sessions%", [400, 404], false],
          ["/v1/sessions%ZZ", [400, 404], false],
          [`/v1/sessions/${rng.uuid()}`, [404], false],
          [`/v1/sessions/${rng.uuid()}/end`, [404], false],
          [`/v1/sessions/${"a".repeat(rng.int(100, 20_000))}`, [404], false],
          ["/v1/sessions/\u00e9", [404], false],
          ["/v1/sessions/%C3%A9", [404], false],
          ["/v1/sessions?/x", [200], true],
          ["/v1/%73essions", [400, 404], false],
          ["/v1/sessions#frag", [200], true],
        ]);
        return {
          ...base,
          strategy: `path-${variant.length > 40 ? variant.slice(0, 40) + "…" : variant}`,
          seedRows: [],
          steps: [
            buildStep(rng, {
              method: "POST",
              path: variant,
              query: variant.includes("?") || variant.includes("#") ? "" : query,
              auth,
              ip,
              body: textBody(text),
              bodyText: text,
              expect: isRoute
                ? EXPECT_OK
                : {
                    statuses,
                    code: null,
                    writeAllowed: false,
                    noRestCalls: false,
                    noUpstreamCalls: false,
                  },
            }),
          ],
          finalRow: isRoute
            ? { present: true, owner: user, startedAt, endedAtNull: true }
            : { present: false },
        };
      }
      // Path-parameter boundary: the sibling finalize route.
      const idVariant = rng.pick<[string, number[], string | null, boolean]>([
        [sessionId, [200], null, true],
        [rng.uuid(), [404], "session.not_found", false],
        [sessionId.toUpperCase(), [200], null, true],
        ["not-a-uuid", [400], "validation.session", false],
        [NIL_UUID, [400], "validation.session", false],
        ["%ZZ", [400], null, false],
        ["%E0%A4%A", [400], null, false],
        [encodeURIComponent(sessionId), [200], null, true],
        [`${sessionId}%00`, [400], "validation.session", false],
        ["' OR 1=1", [400], "validation.session", false],
        ["%27%20OR%201%3D1", [400], "validation.session", false],
        ["..", [400, 404], null, false],
        [`${sessionId}/../${sessionId}`, [400, 404], null, false],
        ["a".repeat(rng.int(1_000, 100_000)), [400], "validation.session", false],
        ["%F0%9F%8F%93", [400], "validation.session", false],
        ["%", [400], null, false],
      ]);
      const [segment, statuses, code, seeded] = idVariant;
      return {
        ...base,
        strategy: `finalize-id-${segment.length > 30 ? segment.slice(0, 30) + "…" : segment}`,
        seedRows: seeded ? [{ id: sessionId, user_id: user, started_at: startedAt }] : [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path: `/v1/sessions/${segment}/finalize`,
            query,
            auth,
            ip,
            body: rng.chance(0.5) ? textBody(text) : { kind: "none" },
            bodyText: null,
            expect: {
              statuses,
              code,
              writeAllowed: false,
              noRestCalls: false,
              noUpstreamCalls: false,
            },
          }),
        ],
        finalRow: seeded
          ? { present: true, owner: user, startedAt, endedAtNull: false }
          : { present: false },
      };
    }
    case "fault": {
      const auth = validAuth(rng, user);
      const text = renderJson(rng, validBodyEntries(rng, sessionId, startedAt, otherUser));
      // Auth faults need a bearer no earlier case verified (the auth cache
      // would otherwise answer without consulting Supabase Auth).
      const supabaseBearer = auth.label === "supabase-access-token";
      if (supabaseBearer)
        auth.header = `Bearer ${supabaseAccessToken(user, { stress_nonce: seed })}`;
      const fault = rng.pick<FaultMode>(
        supabaseBearer
          ? ["auth-user-http500", "auth-user-throw", "upsert-http500", "select-http500"]
          : [
              "upsert-http500",
              "upsert-http503-html",
              "upsert-42501",
              "upsert-throw",
              "upsert-garbage-2xx",
              "select-http500",
              "select-throw",
              "select-garbage-2xx",
            ],
      );
      const writeLands = fault.startsWith("select-");
      const expectFault: StepSpec["expect"] = {
        statuses: [503],
        code: null,
        writeAllowed: fault.startsWith("upsert-") || writeLands,
        noRestCalls: fault.startsWith("auth-user-"),
        noUpstreamCalls: false,
      };
      // Recovery: the same request with the fault cleared must succeed and
      // must not have left a second row / a foreign owner behind.
      const recovery = buildStep(rng, {
        method: "POST",
        path,
        query,
        auth,
        ip,
        body: textBody(text),
        bodyText: text,
        fault: "none",
        expect: EXPECT_OK,
      });
      return {
        ...base,
        strategy: `${fault}/${auth.label}`,
        seedRows: [],
        steps: [
          buildStep(rng, {
            method: "POST",
            path,
            query,
            auth,
            ip,
            body: textBody(text),
            bodyText: text,
            fault,
            expect: expectFault,
          }),
          recovery,
        ],
        finalRow: { present: true, owner: user, startedAt, endedAtNull: true },
      };
    }
  }
}

function parsedStartedAt(text: string): string {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return String(parsed.startedAt);
}

function chunk(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  if (out.length === 0) out.push(new Uint8Array(0));
  return out;
}

// ─── Execution ──────────────────────────────────────────────────────────────

export interface StepResult {
  method: string;
  url: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
  bodyPreview: string;
  restCalls: number;
  insertAttempts: number;
  rowsCreated: number;
  durationMs: number;
  violations: string[];
  /** Reproduced defects tracked as findings (see FINDING_* below) — reported
   * per seed in the campaign summary and pinned by their own focused test,
   * not folded into `violations` so the 3000-case oracle stays green on
   * everything else. */
  findings: string[];
  /** Access-log `route` field as written by the handler. */
  logRoute?: string;
  /** Request could not even be constructed (e.g. GET with a body). */
  unconstructible?: string;
}

/** F1 (P3): http.ts routeTemplate() collapses only segments that are EXACTLY
 * a UUID or a ≥4-digit run; any other client-supplied path segment is written
 * verbatim into the structured access log (`route`), unbounded by anything
 * but the URL length. */
export const FINDING_LOG_ROUTE_CLIENT_TEXT = "F1-access-log-route-carries-client-path-text";

/** Segments a redacted route may legitimately contain: short route words and
 * the `:id` placeholder. Anything else came from the client. */
const ROUTE_WORD_RE = /^[a-z][a-z0-9_-]{0,31}$|^:id$|^$/;
export function routeCarriesClientText(route: string): string | null {
  for (const segment of route.split("/")) {
    if (ROUTE_WORD_RE.test(segment)) continue;
    return segment.length > 48 ? `${segment.slice(0, 48)}…(${segment.length} chars)` : segment;
  }
  return null;
}

export interface CaseResult {
  seed: number;
  kind: CaseKind;
  strategy: string;
  ip: string;
  sessionId: string;
  payloadDigest: string;
  payloadPreview: string;
  steps: StepResult[];
  finalRowViolations: string[];
  /** Union of the steps' findings (defect classes reproduced by this seed). */
  findings: string[];
  ok: boolean;
}

const STACK_MARKERS = [
  "\n    at ",
  "    at ",
  "index.ts",
  "file://",
  ".ts:",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "RangeError",
  "PGRST",
  "42501",
  "23503",
  "23505",
  "relation ",
  "column ",
  "constraint",
  "row-level security",
  "supabase.test",
  "session-for-",
  "stress model",
  "postgres",
  "sql",
];

const GENERIC_5XX_RE =
  /^(?:[A-Za-z ]+ is temporarily unavailable\. Please try again\.|Something went wrong\. Please try again\.)$/;
const UUID_IN_TEXT_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildRequest(step: StepSpec): Request {
  const headers = new Headers();
  for (const [key, value] of step.headers) headers.append(key, value);
  let body: BodyInit | null = null;
  if (step.body.kind === "text") body = step.body.text;
  else if (step.body.kind === "bytes") body = step.body.bytes as unknown as BodyInit;
  else if (step.body.kind === "stream") {
    const chunks = step.body.chunks;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c);
        controller.close();
      },
    });
  }
  return new Request(step.url, { method: step.method, headers, body });
}

export interface RunContext {
  h: Harness;
  store: SessionStore;
  model: RestModel;
  accessLog: string[];
  consoleErrors: string[];
}

export async function runStep(ctx: RunContext, step: StepSpec): Promise<StepResult> {
  const violations: string[] = [];
  const t0 = performance.now();
  let request: Request;
  try {
    request = buildRequest(step);
  } catch (error) {
    return {
      method: step.method,
      url: step.url,
      status: null,
      code: null,
      requestId: null,
      bodyPreview: "",
      restCalls: 0,
      insertAttempts: 0,
      rowsCreated: 0,
      durationMs: performance.now() - t0,
      violations: [
        `harness: request could not be constructed (generator bug, not a handler outcome)`,
      ],
      findings: [],
      unconstructible: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
  const restBefore = ctx.model.restCalls.length;
  const authBefore = ctx.h.calls.length + ctx.model.authUserCalls;
  const attemptsBefore = ctx.store.insertAttempts();
  const createdBefore = ctx.store.rowsCreated();
  const logBefore = ctx.accessLog.length;
  const errBefore = ctx.consoleErrors.length;
  ctx.model.fault = step.fault;
  let response: Response;
  try {
    response = await ctx.h.handler(request);
  } catch (error) {
    ctx.model.fault = "none";
    violations.push(
      `handler threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    );
    return {
      method: step.method,
      url: step.url,
      status: null,
      code: null,
      requestId: null,
      bodyPreview: "",
      restCalls: ctx.model.restCalls.length - restBefore,
      insertAttempts: ctx.store.insertAttempts() - attemptsBefore,
      rowsCreated: ctx.store.rowsCreated() - createdBefore,
      durationMs: performance.now() - t0,
      violations,
      findings: [],
    };
  } finally {
    ctx.model.fault = "none";
  }
  const text = await response.text();
  const status = response.status;
  const restCalls = ctx.model.restCalls.length - restBefore;
  const upstreamCalls = ctx.h.calls.length + ctx.model.authUserCalls - authBefore + restCalls;
  const insertAttempts = ctx.store.insertAttempts() - attemptsBefore;
  const rowsCreated = ctx.store.rowsCreated() - createdBefore;
  const requestId = response.headers.get("x-request-id");

  // ── Status contract
  if (!step.expect.statuses.includes(status)) {
    violations.push(`status ${status} not in expected [${step.expect.statuses.join(",")}]`);
  }
  const isBadInputStep = step.expect.statuses.every((s) => s >= 400 && s !== 409 && s !== 503);
  if (isBadInputStep && !BAD_INPUT_STATUSES.has(status)) {
    violations.push(`bad input answered ${status} (allowed 400/401/403/404/405/413/415/429)`);
  }
  if (status >= 500 && step.fault === "none") {
    violations.push(`unexpected ${status} without an injected fault`);
  }

  // ── Body shape
  let parsed: unknown = null;
  const contentType = response.headers.get("content-type") ?? "";
  if (step.method !== "HEAD" && status !== 204) {
    try {
      parsed = JSON.parse(text);
    } catch {
      violations.push(
        `body is not JSON (content-type ${contentType || "<none>"}): ${text.slice(0, 80)}`,
      );
    }
    if (!contentType.includes("application/json"))
      violations.push(`content-type ${contentType || "<none>"} is not application/json`);
    if (response.headers.get("x-content-type-options") !== "nosniff")
      violations.push("missing X-Content-Type-Options: nosniff");
    if (response.headers.get("cache-control") !== "no-store")
      violations.push(`cache-control ${response.headers.get("cache-control")}`);
  }
  let code: string | null = null;
  if (status >= 400 && isRecord(parsed)) {
    const error = parsed.error;
    if (!isRecord(error) || typeof error.message !== "string" || !error.message) {
      violations.push("error body lacks error.message");
    } else {
      code = typeof error.code === "string" ? error.code : null;
      if (status >= 500 && !GENERIC_5XX_RE.test(error.message))
        violations.push(`5xx message not generic: ${error.message.slice(0, 120)}`);
      if (step.expect.code && code !== step.expect.code && step.expect.statuses.includes(status)) {
        violations.push(`error.code ${code} ≠ ${step.expect.code}`);
      }
    }
    for (const key of Object.keys(parsed))
      if (key !== "error") violations.push(`unexpected top-level key in error body: ${key}`);
  }
  if (status === 200 && text !== "{}") violations.push(`200 body is not {}: ${text.slice(0, 80)}`);
  const lower = text.toLowerCase();
  for (const marker of STACK_MARKERS) {
    if (lower.includes(marker.toLowerCase())) violations.push(`body leaks '${marker}'`);
  }
  if (step.user && lower.includes(step.user.toLowerCase()))
    violations.push("body echoes the authenticated user id");
  const sentBearer =
    step.headers.find(([k]) => k === "authorization")?.[1].replace(/^Bearer\s*/i, "") ?? "";
  if (sentBearer.length >= 8 && lower.includes(sentBearer.slice(0, 40).toLowerCase()))
    violations.push("body echoes the bearer");

  // ── Request id + access log
  if (!requestId) violations.push("missing x-request-id");
  else if (
    step.requestIdWellFormed &&
    step.requestIdSent &&
    requestId !== step.requestIdSent.trim()
  ) {
    violations.push(
      `x-request-id ${requestId} did not echo well-formed ${step.requestIdSent.trim()}`,
    );
  } else if (
    !step.requestIdWellFormed &&
    step.requestIdSent !== null &&
    requestId === step.requestIdSent
  ) {
    violations.push(`x-request-id echoed a malformed client id`);
  } else if (!step.requestIdWellFormed && !UUID_IN_TEXT_RE.test(requestId)) {
    violations.push(`minted x-request-id is not a UUID: ${requestId}`);
  }
  const findings: string[] = [];
  let logRoute: string | undefined;
  const logLines = ctx.accessLog.slice(logBefore);
  if (logLines.length !== 1) violations.push(`expected 1 access-log line, got ${logLines.length}`);
  else {
    let entry: Record<string, unknown> | null = null;
    try {
      const parsedLine = JSON.parse(logLines[0]) as unknown;
      entry = isRecord(parsedLine) ? parsedLine : null;
    } catch {
      violations.push("access-log line is not JSON");
    }
    if (entry) {
      if (entry.requestId !== requestId)
        violations.push("access-log requestId ≠ response x-request-id");
      if (entry.status !== status) violations.push(`access-log status ${entry.status} ≠ ${status}`);
      if (typeof entry.route === "string") {
        logRoute =
          entry.route.length > 200
            ? `${entry.route.slice(0, 200)}…(${entry.route.length})`
            : entry.route;
        // An exact UUID segment surviving is the redaction outright failing;
        // a UUID embedded in client junk is finding F1 (below).
        if (entry.route.split("/").some((s) => UUID_SEGMENT_RE.test(s)))
          violations.push("access-log route carries a raw UUID segment");
        const clientText = routeCarriesClientText(entry.route);
        if (clientText !== null) findings.push(`${FINDING_LOG_ROUTE_CLIENT_TEXT}: ${clientText}`);
      }
      const line = logLines[0].toLowerCase();
      if (step.user && line.includes(step.user.toLowerCase()))
        violations.push("access-log carries the user id");
      if (line.includes("bearer") || line.includes("authorization"))
        violations.push("access-log carries auth material");
      if (
        step.bodyText &&
        step.bodyText.length > 20 &&
        line.includes(step.bodyText.slice(0, 40).toLowerCase())
      )
        violations.push("access-log carries the body");
      const q = step.url.indexOf("?");
      if (q >= 0 && step.url.length - q > 3 && line.includes(step.url.slice(q).toLowerCase())) {
        violations.push("access-log carries the query string");
      }
    }
  }

  // ── Writes
  if (!step.expect.writeAllowed && insertAttempts > 0)
    violations.push(`rejected request attempted ${insertAttempts} insert(s)`);
  if (status !== 200 && status !== 503 && rowsCreated > 0 && !(status === 409))
    violations.push(`non-200 response created ${rowsCreated} row(s)`);
  if (status === 409 && rowsCreated > 0) violations.push("409 conflict created a row");
  if (step.expect.noRestCalls && restCalls > 0)
    violations.push(`${restCalls} PostgREST call(s) on a request that must not reach the database`);
  if (step.expect.noUpstreamCalls && upstreamCalls > 0)
    violations.push(`${upstreamCalls} upstream call(s) before the 413`);
  const pathname = new URL(step.url).pathname;
  const routePath = pathname.slice(Math.max(0, pathname.lastIndexOf("/v1/")));
  if (
    status === 200 &&
    step.method.toUpperCase() === "POST" &&
    routePath === "/v1/sessions" &&
    insertAttempts === 0
  ) {
    violations.push("200 without an insert attempt");
  }

  // ── Handler-side unhandled errors are always a finding.
  const newErrors = ctx.consoleErrors.slice(errBefore);
  if (newErrors.some((line) => line.includes("unhandled error")))
    violations.push(
      `handler logged an unhandled error: ${newErrors.find((l) => l.includes("unhandled error"))?.slice(0, 200)}`,
    );
  if (step.fault === "none" && newErrors.length > 0 && status < 500) {
    // Non-fault requests should not spam operator logs with errors.
    violations.push(`console.error without a fault/5xx: ${newErrors[0].slice(0, 160)}`);
  }

  return {
    method: step.method,
    url: step.url.length > 300 ? `${step.url.slice(0, 300)}…(${step.url.length})` : step.url,
    status,
    code,
    requestId,
    logRoute,
    findings,
    bodyPreview: text.slice(0, 160),
    restCalls,
    insertAttempts,
    rowsCreated,
    durationMs: performance.now() - t0,
    violations,
  };
}

export async function runCase(ctx: RunContext, fuzz: FuzzCase): Promise<CaseResult> {
  ctx.h.calls.length = 0;
  for (const row of fuzz.seedRows) await ctx.store.seedRow(row);
  const steps: StepResult[] = [];
  for (const step of fuzz.steps) steps.push(await runStep(ctx, step));

  const finalRowViolations: string[] = [];
  const row = await ctx.store.rowById(fuzz.sessionId);
  if (fuzz.finalRow.present) {
    if (!row) finalRowViolations.push("expected a sessions row, found none");
    else {
      if (row.user_id.toLowerCase() !== fuzz.finalRow.owner.toLowerCase())
        finalRowViolations.push(`row owner ${row.user_id} ≠ ${fuzz.finalRow.owner}`);
      const expectedMs = Date.parse(fuzz.finalRow.startedAt);
      if (Date.parse(row.started_at) !== expectedMs)
        finalRowViolations.push(`row started_at ${row.started_at} ≠ ${fuzz.finalRow.startedAt}`);
      if (fuzz.finalRow.endedAtNull && row.ended_at !== null)
        finalRowViolations.push(`row ended_at ${row.ended_at} should be null`);
      if (!fuzz.finalRow.endedAtNull && row.ended_at === null)
        finalRowViolations.push("finalized row has null ended_at");
      if (row.kind !== "practice")
        finalRowViolations.push(`row kind ${row.kind} (body extras must be ignored)`);
      if (row.notes !== null) finalRowViolations.push("row notes set from body extras");
      if (row.event_count !== 0)
        finalRowViolations.push(`row event_count ${row.event_count} from body extras`);
    }
  } else if (row) {
    finalRowViolations.push(`no row expected, found one owned by ${row.user_id}`);
  }

  const payload = fuzz.steps[0]?.bodyText ?? "";
  return {
    seed: fuzz.seed,
    kind: fuzz.kind,
    strategy: fuzz.strategy,
    ip: fuzz.ip,
    sessionId: fuzz.sessionId,
    payloadDigest: await sha256Hex(payload),
    payloadPreview:
      payload.length > 200 ? `${payload.slice(0, 200)}…(${payload.length} chars)` : payload,
    steps,
    finalRowViolations,
    findings: [...new Set(steps.flatMap((s) => s.findings.map((f) => f.split(":")[0])))],
    ok: finalRowViolations.length === 0 && steps.every((s) => s.violations.length === 0),
  };
}

export interface CampaignOptions {
  baseSeed: number;
  iterations: number;
  store: SessionStore;
  /** Replay exactly these seeds instead of the campaign sequence. */
  replaySeeds?: number[];
  oversizeShare?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface CampaignReport {
  meta: {
    harness: string;
    store: string;
    baseSeed: number;
    iterations: number;
    casesExecuted: number;
    requestsExecuted: number;
    unconstructibleRequests: number;
    users: number;
    ips: number;
    startedAt: string;
    durationMs: number;
    denoVersion: string;
  };
  summary: {
    byKind: Record<
      string,
      { cases: number; requests: number; statuses: Record<string, number>; failed: number }
    >;
    statuses: Record<string, number>;
    failedSeeds: number[];
    /** finding class → seeds that reproduced it */
    findingSeeds: Record<string, number[]>;
    fiveHundredSeeds: number[];
    violationKinds: Record<string, number>;
  };
  cases: CaseResult[];
  consoleErrorSample: string[];
}

export async function setupContext(
  store: SessionStore,
  users: string[],
): Promise<{ ctx: RunContext; teardown: () => void }> {
  const h = await loadHarness();
  const model = installRestModel(store);
  // Injected socket faults are retried with backoff inside one Auth deadline;
  // shrink the deadline so a fault case costs ~0.3 s instead of ~3 s.
  const previousAuthTimeout = Deno.env.get("AUTH_UPSTREAM_TIMEOUT_MS");
  Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "500");
  for (const user of users) model.knownUsers.add(user);
  await store.provisionUsers(users);
  const accessLog: string[] = [];
  const restoreLog = captureAccessLog((line) => accessLog.push(line));
  const consoleErrors: string[] = [];
  const realError = console.error;
  const realWarn = console.warn;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(
      args
        .map((a) =>
          a instanceof Error
            ? `${a.name}: ${a.message}`
            : typeof a === "string"
              ? a
              : JSON.stringify(a),
        )
        .join(" "),
    );
  };
  console.warn = (...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  return {
    ctx: { h, store, model, accessLog, consoleErrors },
    teardown() {
      console.error = realError;
      console.warn = realWarn;
      restoreLog();
      model.restore();
      if (previousAuthTimeout === undefined) Deno.env.delete("AUTH_UPSTREAM_TIMEOUT_MS");
      else Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", previousAuthTimeout);
    },
  };
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignReport> {
  const seeds =
    options.replaySeeds ??
    Array.from({ length: options.iterations }, (_, i) => caseSeed(options.baseSeed, i));
  // Pools sized so no honest user/IP can exhaust its per-minute budget
  // (240/user, 1200/ip) inside one campaign; bad bearers are spread the same
  // way under the 30-per-IP auth-failure budget.
  const poolSize = Math.max(64, Math.ceil((seeds.length * 2.2) / 100));
  const users = Array.from({ length: poolSize }, (_, i) => poolUser(0x5e55 + i));
  const ips = Array.from({ length: poolSize }, (_, i) => poolIp(0x0a5e5500 + i));
  const config: GeneratorConfig = { users, ips, oversizeShare: options.oversizeShare ?? 0.02 };
  const { ctx, teardown } = await setupContext(options.store, users);
  const startedAt = new Date();
  const t0 = performance.now();
  const cases: CaseResult[] = [];
  try {
    for (let i = 0; i < seeds.length; i += 1) {
      const fuzz = generateCase(seeds[i], config);
      cases.push(await runCase(ctx, fuzz));
      options.onProgress?.(i + 1, seeds.length);
    }
  } finally {
    teardown();
  }
  const byKind: CampaignReport["summary"]["byKind"] = {};
  const statuses: Record<string, number> = {};
  const violationKinds: Record<string, number> = {};
  let requests = 0;
  let unconstructible = 0;
  const fiveHundredSeeds: number[] = [];
  for (const c of cases) {
    const bucket = (byKind[c.kind] ??= { cases: 0, requests: 0, statuses: {}, failed: 0 });
    bucket.cases += 1;
    if (!c.ok) bucket.failed += 1;
    for (const s of c.steps) {
      if (s.unconstructible) {
        unconstructible += 1;
        continue;
      }
      requests += 1;
      bucket.requests += 1;
      const key = String(s.status);
      bucket.statuses[key] = (bucket.statuses[key] ?? 0) + 1;
      statuses[key] = (statuses[key] ?? 0) + 1;
      if ((s.status ?? 0) >= 500 && !fiveHundredSeeds.includes(c.seed))
        fiveHundredSeeds.push(c.seed);
      for (const v of s.violations) {
        const k = v
          .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
          .slice(0, 80);
        violationKinds[k] = (violationKinds[k] ?? 0) + 1;
      }
    }
    for (const v of c.finalRowViolations) {
      const k = v
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
        .slice(0, 80);
      violationKinds[k] = (violationKinds[k] ?? 0) + 1;
    }
  }
  return {
    meta: {
      harness:
        "stress_route_post_v1_sessions (real handler in-process; routesHarness + sessions PostgREST model)",
      store: options.store.name,
      baseSeed: options.baseSeed,
      iterations: seeds.length,
      casesExecuted: cases.length,
      requestsExecuted: requests,
      unconstructibleRequests: unconstructible,
      users: users.length,
      ips: ips.length,
      startedAt: startedAt.toISOString(),
      durationMs: Math.round(performance.now() - t0),
      denoVersion: Deno.version.deno,
    },
    summary: {
      byKind,
      statuses,
      failedSeeds: cases.filter((c) => !c.ok).map((c) => c.seed),
      findingSeeds: cases.reduce<Record<string, number[]>>((acc, c) => {
        for (const f of c.findings) (acc[f] ??= []).push(c.seed);
        return acc;
      }, {}),
      fiveHundredSeeds,
      violationKinds,
    },
    cases,
    consoleErrorSample: ctx.consoleErrors.slice(0, 50),
  };
}

// ─── Env / output helpers ───────────────────────────────────────────────────

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer, got ${raw}`);
  return value;
}

export function envSeeds(name: string): number[] | undefined {
  const raw = Deno.env.get(name);
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const n = Number(s);
      if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: bad seed ${s}`);
      return n >>> 0;
    });
}

/** artifacts/ is git-ignored at the repo root. */
export function defaultOutDir(): string {
  const here = new URL(".", import.meta.url).pathname;
  return `${here}../../../../artifacts/stress/route-post-v1-sessions/latest`;
}

export async function writeReport(
  report: CampaignReport,
  outDir: string,
  name: string,
): Promise<string> {
  await Deno.mkdir(outDir, { recursive: true });
  const path = `${outDir}/${name}`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 1));
  return path;
}
