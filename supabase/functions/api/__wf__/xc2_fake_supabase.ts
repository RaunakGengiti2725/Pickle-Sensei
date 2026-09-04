// xc2 — cross-user isolation audit #2: stateful fake Supabase behind the
// REAL edge function.
//
// Loads ../index.ts exactly like routesHarness.ts does (Deno.serve captured,
// globalThis.fetch replaced) but replaces the per-test fixture tables with a
// STATEFUL, ROW-LEVEL-SECURITY-EMULATING PostgREST + Auth fake:
//
//   * every PostgREST call is resolved to the identity behind its bearer
//     (a fake Supabase session JWT minted by this module, the service-role
//     key, or anonymous) and the emulated RLS predicate
//     `owner_column = auth.uid()` is applied to reads, writes, updates and
//     deletes exactly as the migrations' policies do;
//   * the three hot-path RPCs (access_state, reserve_analysis_permit,
//     apply_synced_shot) are emulated with the ownership semantics of
//     migrations 20260831000000 / 20260901000000 / 20260902150000 so the
//     route layer's handling of foreign ids can be observed end to end;
//   * every outbound call is recorded with the identity it carried, so a
//     request handled for user B that reaches PostgREST bearing user A's
//     session is detectable (auth-cache confusion), not just a wrong body.
//
// This fake is an OBSERVATION instrument for the route layer: it says what
// the edge function ASKS the database for and under WHOSE identity. The real
// Postgres semantics of the SECURITY DEFINER / INVOKER functions are exercised
// separately against a throwaway Postgres in xc2_definer_surfaces.test.ts.
//
// Nothing here talks to the network: fetch is intercepted for the fake
// Supabase host, RevenueCat and Apple; any other URL throws.

export const SUPABASE_URL = "http://xc2.supabase.test";
export const ANON_KEY = "xc2-anon-test-key";
export const SERVICE_ROLE_KEY = "xc2-service-role-test-key";
const WEBHOOK_SECRET = "xc2-webhook-secret";

export type Row = Record<string, unknown>;

export interface FakeUser {
  id: string;
  email: string;
  provider: "google" | "apple";
  providerSubject: string;
}

export interface RecordedCall {
  seq: number;
  method: string;
  url: string;
  /** Who the request acted as: a user id, "service", "anon" or "invalid". */
  actor: string;
  table: string | null;
  status: number;
}

interface TableSpec {
  /** Column that carries the owner (RLS `= auth.uid()`); null = service-only. */
  owner: string | null;
  pk: string[];
  clientRead: boolean;
  clientInsert: boolean;
  clientUpdate: boolean;
  clientDelete: boolean;
  /** Extra unique keys enforced like the migrations' constraints. */
  unique?: string[][];
}

/** Grants and policies as the migrations leave them for `authenticated`
 * (security_regression.sql pins the real ones; this mirrors them so the fake
 * says 42501 where Postgres would). */
const TABLES: Record<string, TableSpec> = {
  profiles: {
    owner: "id",
    pk: ["id"],
    clientRead: true,
    clientInsert: false,
    clientUpdate: true,
    clientDelete: false,
  },
  sessions: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: true,
    clientDelete: false,
  },
  shots: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  shot_phases: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  shot_checkpoints: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  analysis_permits: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: true,
    clientDelete: false,
    unique: [["user_id", "idempotency_key"]],
  },
  consent_records: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  evaluation_trials: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  analysis_feedback: {
    owner: "user_id",
    pk: ["id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
    unique: [["analysis_id", "user_id"]],
  },
  user_saved_drills: {
    owner: "user_id",
    pk: ["user_id", "slug"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: true,
  },
  player_rank_state: {
    owner: "user_id",
    pk: ["user_id"],
    clientRead: true,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  player_technique_rating: {
    owner: "user_id",
    pk: ["user_id", "shot_type"],
    clientRead: true,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  progress_daily: {
    owner: "user_id",
    pk: ["user_id", "day", "shot_type", "scoring_model_version"],
    clientRead: true,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  practice_days: {
    owner: "user_id",
    pk: ["user_id", "day"],
    clientRead: true,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  account_deletion_requests: {
    owner: "user_id",
    pk: ["user_id"],
    clientRead: true,
    clientInsert: true,
    clientUpdate: true,
    clientDelete: false,
  },
  account_deletion_feedback: {
    owner: "user_id",
    pk: ["id"],
    clientRead: false,
    clientInsert: true,
    clientUpdate: false,
    clientDelete: false,
  },
  billing_entitlements: {
    owner: null,
    pk: ["user_id"],
    clientRead: false,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  webhook_events: {
    owner: null,
    pk: ["id"],
    clientRead: false,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  account_external_credentials: {
    owner: null,
    pk: ["user_id"],
    clientRead: false,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
  free_rating_ledger: {
    owner: null,
    pk: ["identity_hash"],
    clientRead: false,
    clientInsert: false,
    clientUpdate: false,
    clientDelete: false,
  },
};

/** Tables whose rows cascade away with auth.users (every FK chain in the
 * migrations ends at profiles → auth.users). The ledger deliberately has no FK. */
const CASCADE_TABLES = Object.keys(TABLES).filter((t) => t !== "free_rating_ledger");

const PERMIT_LIFETIME_MS = 24 * 3_600_000;

function b64url(input: string): string {
  return btoa(input).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeJwtPayload(token: string): Row | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const padded = parts[1].replaceAll("-", "+").replaceAll("_", "/");
    const decoded = JSON.parse(atob(padded + "=".repeat((4 - (padded.length % 4)) % 4)));
    return typeof decoded === "object" && decoded !== null ? (decoded as Row) : null;
  } catch {
    return null;
  }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function pgError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { code, details: null, hint: null, message });
}

const isRecord = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

/** Provider ID token (Google/Apple) the transitional authenticate() branch
 * accepts; the fake exchange trusts `sub` — signature verification is
 * Supabase Auth's job and is out of scope here. */
export function providerIdToken(provider: "google" | "apple", sub: string, expOffsetS = 3600) {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "xc2" }));
  const payload = b64url(
    JSON.stringify({
      iss: provider === "google" ? "https://accounts.google.com" : "https://appleid.apple.com",
      aud: "xc2-audience",
      sub,
      exp: Math.floor(Date.now() / 1000) + expOffsetS,
    }),
  );
  return `${header}.${payload}.sig`;
}

function sessionJwt(sub: string, sid: string, expOffsetS = 3600): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      role: "authenticated",
      aud: "authenticated",
      sid,
      exp: Math.floor(Date.now() / 1000) + expOffsetS,
    }),
  );
  return `${header}.${payload}.forged-sig-${sid.slice(0, 8)}`;
}

interface Session {
  sid: string;
  userId: string;
  refreshToken: string;
  revoked: boolean;
}

export class FakeSupabase {
  users = new Map<string, FakeUser>();
  identities = new Map<string, string>(); // `${provider}:${sub}` → userId
  sessions = new Map<string, Session>(); // sid → session
  refreshTokens = new Map<string, string>(); // refresh token → sid
  tables = new Map<string, Row[]>();
  calls: RecordedCall[] = [];
  seq = 0;
  serial = 0;
  /** Timestamp source so permit expiry checks are deterministic. */
  now: () => number = () => Date.now();

  constructor() {
    for (const table of Object.keys(TABLES)) this.tables.set(table, []);
  }

  reset(): void {
    this.users.clear();
    this.identities.clear();
    this.sessions.clear();
    this.refreshTokens.clear();
    for (const table of Object.keys(TABLES)) this.tables.set(table, []);
    this.calls = [];
    this.seq = 0;
    this.serial = 0;
  }

  rows(table: string): Row[] {
    const rows = this.tables.get(table);
    if (!rows) throw new Error(`fake supabase: unknown table ${table}`);
    return rows;
  }

  nextId(): string {
    this.serial += 1;
    // Deterministic, well-formed v4-looking UUIDs (sequence in the last group).
    return `f0000000-0000-4000-8000-${String(this.serial).padStart(12, "0")}`;
  }

  /** Mirror of handle_new_user(): a provisioned auth user gets a profile row. */
  addUser(user: FakeUser): FakeUser {
    this.users.set(user.id, user);
    this.identities.set(`${user.provider}:${user.providerSubject}`, user.id);
    this.rows("profiles").push({
      id: user.id,
      email: user.email,
      onboarding_state: "pending",
      provider: user.provider,
      skill_level: null,
      handedness: null,
      primary_goal: null,
      biggest_problem: null,
      focus_checkpoint: null,
      first_name: null,
      gender: null,
    });
    return user;
  }

  /** Mint a Supabase-style session for a user (what bootstrap/refresh hand
   * the app). The bearer works for auth.getUser AND PostgREST until logged
   * out or the account is deleted. */
  mintSession(userId: string, expOffsetS = 3600): { accessToken: string; refreshToken: string } {
    const sid = `sid-${this.nextId()}`;
    const refreshToken = `refresh-${this.nextId()}`;
    this.sessions.set(sid, { sid, userId, refreshToken, revoked: false });
    this.refreshTokens.set(refreshToken, sid);
    return { accessToken: sessionJwt(userId, sid, expOffsetS), refreshToken };
  }

  /** A syntactically valid session JWT for `userId` that this Auth never
   * issued (attacker forges a token naming the victim's uid). */
  forgedSessionToken(userId: string): string {
    return sessionJwt(userId, `sid-forged-${userId}`);
  }

  /** Resolve a PostgREST/Auth bearer to the identity it proves. */
  resolveBearer(token: string):
    | { kind: "user"; userId: string }
    | { kind: "service" }
    | {
        kind: "anon";
      }
    | { kind: "invalid" } {
    if (!token) return { kind: "anon" };
    if (token === SERVICE_ROLE_KEY) return { kind: "service" };
    if (token === ANON_KEY) return { kind: "anon" };
    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.sid !== "string" || typeof payload.sub !== "string") {
      return { kind: "invalid" };
    }
    if (typeof payload.exp === "number" && payload.exp * 1000 <= this.now()) {
      return { kind: "invalid" };
    }
    const session = this.sessions.get(payload.sid);
    if (!session || session.revoked || session.userId !== payload.sub) {
      return { kind: "invalid" };
    }
    if (!this.users.has(session.userId)) return { kind: "invalid" };
    return { kind: "user", userId: session.userId };
  }

  private identityHash(userId: string): string {
    const user = this.users.get(userId);
    return user ? `hash:${user.provider}:${user.providerSubject}` : `hash:orphan:${userId}`;
  }

  lifetimeScoredCount(userId: string): number {
    const own = this.rows("shots").filter(
      (s) => s.user_id === userId && s.result_kind === "scored",
    ).length;
    const hash = this.identityHash(userId);
    const ledger = this.rows("free_rating_ledger").find((l) => l.identity_hash === hash);
    return Math.max(own, ledger ? Number(ledger.scored_count) : 0);
  }

  private recordScoredShotInLedger(userId: string): void {
    const hash = this.identityHash(userId);
    const ledger = this.rows("free_rating_ledger");
    const existing = ledger.find((l) => l.identity_hash === hash);
    const next = (existing ? Number(existing.scored_count) : 0) + 1;
    if (existing) existing.scored_count = next;
    else ledger.push({ identity_hash: hash, scored_count: next });
  }

  private premiumOf(userId: string): boolean {
    const billing = this.rows("billing_entitlements").find((b) => b.user_id === userId);
    if (!billing || billing.premium !== true) return false;
    const expires = typeof billing.expires_at === "string" ? Date.parse(billing.expires_at) : NaN;
    return Number.isNaN(expires) || expires > this.now();
  }

  private reservedCount(userId: string): number {
    const cutoff = this.now() - PERMIT_LIFETIME_MS;
    return this.rows("analysis_permits").filter(
      (p) =>
        p.user_id === userId &&
        p.status === "reserved" &&
        Date.parse(String(p.created_at)) > cutoff,
    ).length;
  }

  /** Delete an auth user and cascade every FK-linked row (never the ledger). */
  deleteUser(userId: string): boolean {
    const existed = this.users.delete(userId);
    for (const table of CASCADE_TABLES) {
      const spec = TABLES[table];
      const ownerCol = spec.owner ?? "user_id";
      const kept = this.rows(table).filter((row) => row[ownerCol] !== userId);
      this.tables.set(table, kept);
    }
    for (const [key, uid] of [...this.identities]) {
      if (uid === userId) this.identities.delete(key);
    }
    for (const session of this.sessions.values()) {
      if (session.userId === userId) session.revoked = true;
    }
    return existed;
  }

  // ── PostgREST emulation ───────────────────────────────────────────────────

  private applyFilters(rows: Row[], params: URLSearchParams): Row[] {
    let result = rows;
    for (const [key, raw] of params) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(key)) continue;
      const dot = raw.indexOf(".");
      const op = dot === -1 ? "eq" : raw.slice(0, dot);
      const value = dot === -1 ? raw : raw.slice(dot + 1);
      result = result.filter((row) => {
        const cell = row[key];
        switch (op) {
          case "eq":
            return String(cell) === value;
          case "neq":
            return String(cell) !== value;
          case "is":
            return value === "null" ? cell === null || cell === undefined : String(cell) === value;
          case "in": {
            const list = value
              .replace(/^\(/, "")
              .replace(/\)$/, "")
              .split(",")
              .map((v) => v.trim().replace(/^"(.*)"$/, "$1"));
            return list.includes(String(cell));
          }
          case "gt":
            return String(cell) > value;
          case "gte":
            return String(cell) >= value;
          case "lt":
            return String(cell) < value;
          case "lte":
            return String(cell) <= value;
          default:
            throw new Error(`fake supabase: unsupported filter ${key}=${raw}`);
        }
      });
    }
    return result;
  }

  private applyOrderAndPage(rows: Row[], params: URLSearchParams): Row[] {
    let result = [...rows];
    const order = params.get("order");
    if (order) {
      const terms = order.split(",").map((t) => {
        const [col, dir] = t.split(".");
        return { col, desc: dir === "desc" };
      });
      result.sort((a, b) => {
        for (const term of terms) {
          const x = a[term.col];
          const y = b[term.col];
          if (x === y) continue;
          const cmp = String(x) < String(y) ? -1 : 1;
          return term.desc ? -cmp : cmp;
        }
        return 0;
      });
    }
    const offset = Number(params.get("offset") ?? 0);
    const limit = params.has("limit") ? Number(params.get("limit")) : undefined;
    if (offset || limit !== undefined) {
      result = result.slice(offset, limit === undefined ? undefined : offset + limit);
    }
    return result;
  }

  private project(rows: Row[], params: URLSearchParams): Row[] {
    const select = params.get("select");
    if (!select || select === "*") return rows.map((r) => ({ ...r }));
    const columns = select.split(",").map((c) => c.trim());
    return rows.map((row) => {
      const out: Row = {};
      for (const column of columns) out[column] = row[column] ?? null;
      return out;
    });
  }

  private visible(
    table: string,
    spec: TableSpec,
    actor: ReturnType<FakeSupabase["resolveBearer"]>,
  ) {
    const rows = this.rows(table);
    if (actor.kind === "service") return rows;
    if (actor.kind !== "user" || !spec.owner) return [];
    return rows.filter((row) => row[spec.owner as string] === actor.userId);
  }

  private uniqueConflict(table: string, spec: TableSpec, row: Row): Row | null {
    const rows = this.rows(table);
    const match = (keys: string[]) =>
      rows.find((existing) => keys.every((k) => existing[k] === row[k])) ?? null;
    const pkHit = match(spec.pk);
    if (pkHit) return pkHit;
    for (const keys of spec.unique ?? []) {
      const hit = match(keys);
      if (hit) return hit;
    }
    return null;
  }

  private handleRest(
    request: Request,
    url: URL,
    actor: ReturnType<FakeSupabase["resolveBearer"]>,
    bodyText: string,
  ): Response {
    const path = url.pathname.slice("/rest/v1/".length);
    if (actor.kind === "invalid") {
      return pgError(401, "PGRST301", "JWT invalid");
    }
    if (path.startsWith("rpc/")) {
      return this.handleRpc(path.slice("rpc/".length), actor, bodyText);
    }
    const table = path;
    const spec = TABLES[table];
    if (!spec) {
      return pgError(404, "PGRST205", `Could not find the table 'public.${table}'`);
    }
    const method = request.method;
    const prefer = request.headers.get("Prefer") ?? "";
    const wantsRepresentation = prefer.includes("return=representation");
    const client = actor.kind !== "service";

    if (method === "GET") {
      if (client && !spec.clientRead) {
        return pgError(403, "42501", `permission denied for table ${table}`);
      }
      const rows = this.applyOrderAndPage(
        this.applyFilters(this.visible(table, spec, actor), url.searchParams),
        url.searchParams,
      );
      return jsonResponse(200, this.project(rows, url.searchParams));
    }

    if (method === "POST") {
      if (client && !spec.clientInsert) {
        return pgError(403, "42501", `permission denied for table ${table}`);
      }
      let payload: unknown;
      try {
        payload = JSON.parse(bodyText || "null");
      } catch {
        return pgError(400, "PGRST102", "Empty or invalid json");
      }
      const incoming = (Array.isArray(payload) ? payload : [payload]).filter(isRecord);
      const resolution = prefer.match(/resolution=(merge|ignore)-duplicates/)?.[1] ?? null;
      const written: Row[] = [];
      for (const raw of incoming) {
        const row: Row = { ...raw };
        if (spec.pk.length === 1 && row[spec.pk[0]] === undefined) {
          row[spec.pk[0]] = this.nextId();
        }
        if (row.created_at === undefined) {
          row.created_at = new Date(this.now()).toISOString();
        }
        const conflict = this.uniqueConflict(table, spec, row);
        if (conflict) {
          if (resolution === "ignore") continue;
          if (resolution === "merge") {
            // ON CONFLICT DO UPDATE: the existing row must satisfy the UPDATE
            // policy's USING, otherwise Postgres raises 42501.
            if (
              client &&
              spec.owner &&
              conflict[spec.owner] !== (actor as { userId: string }).userId
            ) {
              return pgError(
                403,
                "42501",
                `new row violates row-level security policy for table "${table}"`,
              );
            }
            if (client && !spec.clientUpdate) {
              return pgError(403, "42501", `permission denied for table ${table}`);
            }
            Object.assign(conflict, raw);
            if (
              client &&
              spec.owner &&
              conflict[spec.owner] !== (actor as { userId: string }).userId
            ) {
              return pgError(
                403,
                "42501",
                `new row violates row-level security policy for table "${table}"`,
              );
            }
            written.push(conflict);
            continue;
          }
          return pgError(
            409,
            "23505",
            `duplicate key value violates unique constraint "${table}_pkey"`,
          );
        }
        if (client) {
          if (!spec.owner || row[spec.owner] !== (actor as { userId: string }).userId) {
            return pgError(
              403,
              "42501",
              `new row violates row-level security policy for table "${table}"`,
            );
          }
        }
        this.rows(table).push(row);
        this.afterInsert(table, row);
        written.push(row);
      }
      if (!wantsRepresentation) return new Response(null, { status: 201 });
      return jsonResponse(201, this.project(written, url.searchParams));
    }

    if (method === "PATCH") {
      if (client && !spec.clientUpdate) {
        return pgError(403, "42501", `permission denied for table ${table}`);
      }
      let patch: unknown;
      try {
        patch = JSON.parse(bodyText || "null");
      } catch {
        return pgError(400, "PGRST102", "Empty or invalid json");
      }
      if (!isRecord(patch)) {
        return pgError(400, "PGRST102", "Empty or invalid json");
      }
      const targets = this.applyFilters(this.visible(table, spec, actor), url.searchParams);
      for (const target of targets) {
        const next = { ...target, ...patch };
        if (client && spec.owner && next[spec.owner] !== (actor as { userId: string }).userId) {
          return pgError(
            403,
            "42501",
            `new row violates row-level security policy for table "${table}"`,
          );
        }
        Object.assign(target, patch);
      }
      if (!wantsRepresentation) return new Response(null, { status: 204 });
      return jsonResponse(200, this.project(targets, url.searchParams));
    }

    if (method === "DELETE") {
      if (client && !spec.clientDelete) {
        return pgError(403, "42501", `permission denied for table ${table}`);
      }
      const targets = new Set(
        this.applyFilters(this.visible(table, spec, actor), url.searchParams),
      );
      this.tables.set(
        table,
        this.rows(table).filter((row) => !targets.has(row)),
      );
      if (!wantsRepresentation) return new Response(null, { status: 204 });
      return jsonResponse(200, this.project([...targets], url.searchParams));
    }
    return pgError(405, "PGRST", "method not allowed");
  }

  /** Trigger emulation: the ledger trigger on scored shot inserts. */
  private afterInsert(table: string, row: Row): void {
    if (table === "shots" && row.result_kind === "scored" && typeof row.user_id === "string") {
      this.recordScoredShotInLedger(row.user_id);
    }
  }

  private handleRpc(
    fn: string,
    actor: ReturnType<FakeSupabase["resolveBearer"]>,
    bodyText: string,
  ): Response {
    let args: Row = {};
    try {
      const parsed = JSON.parse(bodyText || "{}");
      if (isRecord(parsed)) args = parsed;
    } catch {
      return pgError(400, "PGRST102", "Empty or invalid json");
    }
    if (actor.kind === "anon") {
      return pgError(401, "42501", `permission denied for function ${fn}`);
    }
    const uid = actor.kind === "user" ? actor.userId : null;

    switch (fn) {
      case "access_state": {
        if (!uid) return jsonResponse(200, []);
        return jsonResponse(200, [
          {
            premium: this.premiumOf(uid),
            scored_count: this.lifetimeScoredCount(uid),
            reserved_count: this.reservedCount(uid),
          },
        ]);
      }
      case "reserve_analysis_permit": {
        const key = args.p_idempotency_key;
        if (!uid) {
          return jsonResponse(200, [
            {
              result: "auth.required",
              permit_id: null,
            },
          ]);
        }
        if (typeof key !== "string") {
          return pgError(400, "22P02", "invalid input");
        }
        const permits = this.rows("analysis_permits");
        const view = (p: Row) => ({
          result: "accepted",
          permit_id: p.id,
          permit_status: p.status,
          permit_outcome: p.outcome,
          permit_created_at: p.created_at,
        });
        const existing = permits.find((p) => p.user_id === uid && p.idempotency_key === key);
        if (existing) return jsonResponse(200, [view(existing)]);
        const remaining = 2 - Math.min(this.lifetimeScoredCount(uid), 2);
        if (!this.premiumOf(uid) && remaining <= this.reservedCount(uid)) {
          return jsonResponse(200, [
            {
              result: "access.paywall_required",
              permit_id: null,
            },
          ]);
        }
        const row: Row = {
          id: this.nextId(),
          user_id: uid,
          idempotency_key: key,
          status: "reserved",
          outcome: null,
          created_at: new Date(this.now()).toISOString(),
        };
        permits.push(row);
        return jsonResponse(200, [view(row)]);
      }
      case "apply_synced_shot": {
        if (!uid) return jsonResponse(200, "auth.required");
        const shot = args.shot;
        if (!isRecord(shot)) {
          return jsonResponse(200, "shot.write_failed:invalid");
        }
        const permit = this.rows("analysis_permits").find(
          (p) => p.id === shot.analysisPermitId && p.user_id === uid,
        );
        if (!permit) return jsonResponse(200, "access.permit_not_found");
        if (permit.status !== "reserved") {
          return jsonResponse(200, "access.permit_not_reserved");
        }
        if (Date.parse(String(permit.created_at)) <= this.now() - PERMIT_LIFETIME_MS) {
          return jsonResponse(200, "access.permit_expired");
        }
        if (typeof shot.sessionId === "string") {
          const session = this.rows("sessions").find(
            (s) => s.id === shot.sessionId && s.user_id === uid,
          );
          if (!session) return jsonResponse(200, "shot.session_not_found");
        }
        const shots = this.rows("shots");
        const clash = shots.find((s) => s.id === shot.id);
        if (clash && clash.user_id !== uid) {
          return jsonResponse(200, "shot.id_conflict");
        }
        if (clash) return jsonResponse(200, "accepted");
        if (
          shot.resultKind === "scored" &&
          !this.premiumOf(uid) &&
          this.lifetimeScoredCount(uid) >= 2
        ) {
          return jsonResponse(200, "access.paywall_required");
        }
        const row: Row = {
          id: shot.id,
          user_id: uid,
          session_id: shot.sessionId ?? null,
          analysis_permit_id: permit.id,
          shot_type: shot.shotType,
          camera_view: shot.cameraView,
          captured_at: shot.capturedAt,
          overall_score: shot.overallScore,
          confidence: shot.confidence,
          result_kind: shot.resultKind,
          created_at: new Date(this.now()).toISOString(),
        };
        shots.push(row);
        this.afterInsert("shots", row);
        for (const phase of Array.isArray(shot.phases) ? shot.phases : []) {
          if (!isRecord(phase)) continue;
          this.rows("shot_phases").push({
            id: this.nextId(),
            user_id: uid,
            shot_id: shot.id,
            ...phase,
          });
        }
        for (const checkpoint of Array.isArray(shot.checkpoints) ? shot.checkpoints : []) {
          if (!isRecord(checkpoint)) continue;
          this.rows("shot_checkpoints").push({
            id: this.nextId(),
            user_id: uid,
            shot_id: shot.id,
            ...checkpoint,
          });
        }
        permit.status = "finalized";
        permit.outcome = shot.resultKind;
        return jsonResponse(200, "accepted");
      }
      case "complete_onboarding": {
        if (!uid) return jsonResponse(200, null);
        const profile = this.rows("profiles").find((p) => p.id === uid);
        if (profile) profile.onboarding_state = "complete";
        return jsonResponse(200, null);
      }
      default:
        return pgError(404, "PGRST202", `Could not find the function public.${fn}`);
    }
  }

  // ── Auth emulation ────────────────────────────────────────────────────────

  private sessionPayload(userId: string, minted: { accessToken: string; refreshToken: string }) {
    const user = this.users.get(userId)!;
    return {
      access_token: minted.accessToken,
      token_type: "bearer",
      expires_in: 3600,
      expires_at: Math.floor(this.now() / 1000) + 3600,
      refresh_token: minted.refreshToken,
      user: this.userPayload(user),
    };
  }

  private userPayload(user: FakeUser) {
    return {
      id: user.id,
      aud: "authenticated",
      role: "authenticated",
      email: user.email,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
    };
  }

  private handleAuth(request: Request, url: URL, bearer: string, bodyText: string): Response {
    const path = url.pathname.slice("/auth/v1".length);
    if (path === "/token") {
      const grant = url.searchParams.get("grant_type");
      let body: Row = {};
      try {
        const parsed = JSON.parse(bodyText || "{}");
        if (isRecord(parsed)) body = parsed;
      } catch {
        return jsonResponse(400, { error: "invalid_request" });
      }
      if (grant === "id_token") {
        const idToken = typeof body.id_token === "string" ? body.id_token : "";
        const provider = body.provider;
        const payload = decodeJwtPayload(idToken);
        if (
          !payload ||
          typeof payload.sub !== "string" ||
          (provider !== "google" && provider !== "apple")
        ) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Bad ID token",
          });
        }
        if (typeof payload.exp === "number" && payload.exp * 1000 <= this.now()) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Token expired",
          });
        }
        let userId = this.identities.get(`${provider}:${payload.sub}`);
        if (!userId) {
          // Unknown identity → Supabase creates the user (handle_new_user fires).
          userId = this.nextId();
          this.addUser({
            id: userId,
            email: `${payload.sub}@xc2.example`,
            provider,
            providerSubject: payload.sub,
          });
        }
        return jsonResponse(200, this.sessionPayload(userId, this.mintSession(userId)));
      }
      if (grant === "refresh_token") {
        const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : "";
        const sid = this.refreshTokens.get(refreshToken);
        const session = sid ? this.sessions.get(sid) : undefined;
        if (!session || session.revoked || !this.users.has(session.userId)) {
          return jsonResponse(400, {
            error: "invalid_grant",
            error_description: "Invalid Refresh Token",
          });
        }
        // Rotation: the old refresh token dies with the old session.
        session.revoked = true;
        this.refreshTokens.delete(refreshToken);
        return jsonResponse(
          200,
          this.sessionPayload(session.userId, this.mintSession(session.userId)),
        );
      }
      return jsonResponse(400, { error: "unsupported_grant_type" });
    }
    if (path === "/user" && request.method === "GET") {
      const actor = this.resolveBearer(bearer);
      if (actor.kind !== "user") {
        return jsonResponse(401, { code: 401, msg: "invalid JWT" });
      }
      return jsonResponse(200, this.userPayload(this.users.get(actor.userId)!));
    }
    if (path === "/logout" && request.method === "POST") {
      const payload = decodeJwtPayload(bearer);
      const session = typeof payload?.sid === "string" ? this.sessions.get(payload.sid) : undefined;
      if (!session || session.revoked) {
        return jsonResponse(401, { code: 401, msg: "invalid JWT" });
      }
      session.revoked = true;
      this.refreshTokens.delete(session.refreshToken);
      return new Response(null, { status: 204 });
    }
    if (path.startsWith("/admin/users/") && request.method === "DELETE") {
      if (bearer !== SERVICE_ROLE_KEY) {
        return jsonResponse(401, { code: 401, msg: "not admin" });
      }
      const userId = path.slice("/admin/users/".length);
      if (!this.deleteUser(userId)) {
        return jsonResponse(404, {
          code: 404,
          error_code: "user_not_found",
          msg: "User not found",
        });
      }
      return jsonResponse(200, {});
    }
    return jsonResponse(404, { msg: `fake auth: ${request.method} ${path}` });
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const bearer = (request.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const bodyText =
      request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    let response: Response;
    let table: string | null = null;
    let actorLabel = "n/a";
    if (url.origin === SUPABASE_URL && url.pathname.startsWith("/rest/v1/")) {
      const actor = this.resolveBearer(bearer);
      actorLabel = actor.kind === "user" ? actor.userId : actor.kind;
      table = url.pathname.slice("/rest/v1/".length);
      response = this.handleRest(request, url, actor, bodyText);
    } else if (url.origin === SUPABASE_URL && url.pathname.startsWith("/auth/v1")) {
      const actor = this.resolveBearer(bearer);
      actorLabel = actor.kind === "user" ? actor.userId : actor.kind;
      table = `auth${url.pathname.slice("/auth/v1".length)}`;
      response = this.handleAuth(request, url, bearer, bodyText);
    } else if (url.hostname === "api.revenuecat.com") {
      actorLabel = "revenuecat";
      table = "revenuecat";
      response =
        request.method === "DELETE"
          ? jsonResponse(200, { deleted: true })
          : jsonResponse(200, {
              subscriber: {
                entitlements: {},
                subscriptions: {},
                original_app_user_id: "x",
              },
            });
    } else {
      throw new Error(`xc2 fake supabase: unexpected outbound fetch ${request.method} ${url.href}`);
    }
    this.seq += 1;
    this.calls.push({
      seq: this.seq,
      method: request.method,
      url: url.pathname + url.search,
      actor: actorLabel,
      table,
      status: response.status,
    });
    return response;
  }
}

export interface EdgeUnderTest {
  handler: (request: Request) => Promise<Response>;
  fake: FakeSupabase;
  anonKey: string;
  webhookSecret: string;
}

let loaded: EdgeUnderTest | null = null;

/** Boot the real edge function once per process with fetch pointed at the
 * fake. Repeated calls reset the fake's state (users, rows, calls). The edge
 * function's OWN in-memory state (auth cache, rank/progress cache, rate
 * limit windows) is deliberately NOT reset between calls — that persistence
 * across users is exactly what the isolation matrix must survive. */
export async function loadEdge(): Promise<EdgeUnderTest> {
  if (loaded) {
    loaded.fake.reset();
    return loaded;
  }
  Deno.env.set("SUPABASE_URL", SUPABASE_URL);
  Deno.env.set("SUPABASE_ANON_KEY", ANON_KEY);
  Deno.env.delete("SB_PUBLISHABLE_KEY");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", WEBHOOK_SECRET);
  Deno.env.set("REVENUECAT_SECRET_API_KEY", "sk_test_xc2");
  Deno.env.delete("UPSTASH_REDIS_REST_URL");
  Deno.env.delete("UPSTASH_REDIS_REST_TOKEN");
  Deno.env.delete("APPLE_SIGN_IN_CLIENT_ID");
  Deno.env.delete("APPLE_SIGN_IN_TEAM_ID");
  Deno.env.delete("APPLE_SIGN_IN_KEY_ID");
  Deno.env.delete("APPLE_SIGN_IN_PRIVATE_KEY");
  Deno.env.delete("APPLE_TOKEN_ENCRYPTION_KEY");

  const fake = new FakeSupabase();
  globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return fake.handle(request);
  }) as typeof fetch;

  let captured: ((request: Request) => Promise<Response>) | null = null;
  Deno.serve = ((...args: unknown[]) => {
    const handler = args.find((arg) => typeof arg === "function") as
      ((request: Request) => Promise<Response>) | undefined;
    if (!handler) throw new Error("Deno.serve called without a handler");
    captured = handler;
    return {
      finished: Promise.resolve(),
      addr: { transport: "tcp", hostname: "127.0.0.1", port: 0 },
      ref() {},
      unref() {},
      shutdown: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    } as unknown as ReturnType<typeof Deno.serve>;
  }) as typeof Deno.serve;

  await import("../index.ts");
  if (!captured) throw new Error("edge function did not call Deno.serve");
  loaded = {
    handler: captured,
    fake,
    anonKey: ANON_KEY,
    webhookSecret: WEBHOOK_SECRET,
  };
  return loaded;
}

export function edgeRequest(
  method: string,
  path: string,
  options: {
    token?: string;
    ip?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers = new Headers({
    "x-forwarded-for": options.ip ?? "203.0.113.10",
    ...(options.headers ?? {}),
  });
  if (options.token !== undefined) {
    headers.set("Authorization", `Bearer ${options.token}`);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
  }
  return new Request(`https://edge.xc2.test/functions/v1/api${path}`, {
    method,
    headers,
    body,
  });
}
