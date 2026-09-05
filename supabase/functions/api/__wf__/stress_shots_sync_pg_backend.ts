/**
 * PostgREST stand-in for the stress harness that answers the route's
 * `shots` lookup and `apply_synced_shot` RPC from a REAL Postgres (the
 * throwaway postgres:16 that xc_pg_up.sh builds with the shim + every
 * migration), under the caller's `authenticated` role and JWT sub — exactly
 * the privilege the edge function's per-user supabase-js client has.
 *
 * Each PostgREST call is one short transaction, so concurrent handler
 * invocations contend on the real advisory lock / row locks / unique index.
 * Every error is shaped like a PostgREST error body ({code, message, …}) so
 * the route's `applied.error` branch is the one exercised.
 */
import postgres from "postgres";
import {
  isRecord,
  jsonResponse,
  type RestBackend,
  type RestCall,
  shotsLookupFilter,
} from "./stress_shots_sync_harness.ts";

export type Sql = ReturnType<typeof postgres>;

interface PgErrorLike {
  code?: string;
  message?: string;
  detail?: string;
  hint?: string;
}

/** PostgREST maps SQLSTATE classes to HTTP statuses; the route only looks at
 * `error` truthiness, so the two it could plausibly see are enough. */
function postgrestError(error: unknown): Response {
  const e = (isRecord(error) ? error : {}) as PgErrorLike;
  const code = typeof e.code === "string" ? e.code : "XX000";
  const status = code === "42501" ? 403 : code.startsWith("28") ? 401 : 400;
  return jsonResponse(status, {
    code,
    message: typeof e.message === "string" ? e.message : String(error),
    details: e.detail ?? null,
    hint: e.hint ?? null,
  });
}

export class PostgresBackend implements RestBackend {
  readonly sql: Sql;
  /** Every PostgREST-shaped call that reached the database. */
  calls: Array<{ kind: "lookup" | "rpc" | "other"; userId: string | null; ms: number; outcome: string }> = [];

  constructor(url: string, max = 16) {
    this.sql = postgres(url, { max, onnotice: () => {} });
  }

  /** The shim's auth.users insert fires handle_new_user → profiles row. */
  async ensureUser(id: string): Promise<void> {
    await this.sql.unsafe(
      `insert into auth.users (id, email) values ($1, $2) on conflict do nothing`,
      [id, `${id}@stress.example`],
    );
  }

  /** Cascade-delete everything the run created for this user. */
  async removeUser(id: string): Promise<void> {
    await this.sql.unsafe(`delete from auth.users where id = $1`, [id]);
  }

  /** Runs `fn` as the user (authenticated role + JWT sub) in one transaction
   * that COMMITS — the handler must observe the rows afterwards. */
  async asUser<T>(userId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    return (await this.sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [userId]);
      return await fn(tx as unknown as Sql);
    })) as T;
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async handle(call: RestCall): Promise<Response> {
    const started = performance.now();
    const record = {
      kind: (call.rpc !== null ? "rpc" : call.table === "shots" && call.method === "GET" ? "lookup" : "other") as
        | "lookup"
        | "rpc"
        | "other",
      userId: call.who.userId,
      ms: 0,
      outcome: "",
    };
    this.calls.push(record);
    try {
      if (call.who.role === "anon") {
        record.outcome = "anon";
        return jsonResponse(401, { code: "PGRST301", message: "JWT required" });
      }
      const response = (await this.sql.begin(async (raw) => {
        const tx = raw as unknown as Sql;
        if (call.who.role === "user") {
          if (!call.who.userId) return jsonResponse(401, { code: "PGRST301", message: "JWT has no sub" });
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [call.who.userId]);
        }
        if (call.rpc !== null) {
          if (call.rpc !== "apply_synced_shot") {
            return jsonResponse(404, { code: "PGRST202", message: `rpc ${call.rpc} not modelled` });
          }
          const shot = isRecord(call.body) && "shot" in call.body ? call.body.shot : null;
          const rows = await tx.unsafe(
            `select public.apply_synced_shot($1::text::jsonb) as status`,
            [JSON.stringify(shot)],
          );
          const status = rows[0]?.status;
          record.outcome = String(status);
          return jsonResponse(200, status === null || status === undefined ? null : String(status));
        }
        if (call.table === "shots" && call.method === "GET") {
          const filter = shotsLookupFilter(call.url);
          const rows = await tx.unsafe(
            `select id from public.shots
              where ($1::uuid is null or user_id = $1::uuid)
                and ($2::uuid[] is null or id = any($2::uuid[]))
              order by id`,
            [filter.userId, filter.ids],
          );
          record.outcome = `${rows.length} rows`;
          return jsonResponse(200, rows.map((r) => ({ id: String(r.id) })));
        }
        record.outcome = "unmodelled";
        return new Response(`stress pg backend: unmodelled ${call.method} ${call.url}`, { status: 599 });
      })) as Response;
      return response;
    } catch (error) {
      record.outcome = `error ${isRecord(error) && typeof error.code === "string" ? error.code : String(error)}`;
      return postgrestError(error);
    } finally {
      record.ms = Math.round((performance.now() - started) * 100) / 100;
    }
  }
}
