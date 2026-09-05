/**
 * stress — POST /v1/sessions/:id/finalize, DIRECT Postgres half.
 *
 * stress_sessions_finalize_concurrency.test.ts proves the handler's
 * behaviour over the in-memory PostgREST model. This file replays the exact
 * statements the route makes PostgREST issue — as role `authenticated` with
 * the caller's JWT sub, one autocommitted transaction per HTTP call, from N
 * INDEPENDENT connections released by a barrier — against a disposable
 * postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh):
 *
 *   GET   → select id, ended_at from public.sessions where id=$1 and user_id=$2
 *   PATCH → update public.sessions set ended_at=$3 where id=$1 and user_id=$2
 *
 * so the read-then-write window is a real READ COMMITTED window and the
 * column grants / RLS policies from the migrations are the real ones.
 *
 *   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres \
 *     STRESS_PG_ITER=40 STRESS_OUT_DIR=/tmp/stress-pg \
 *     deno test -A --no-check --config deno.json stress_sessions_finalize_pg_concurrency.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass. Inputs (user ids, session ids, lane counts,
 * per-lane think-time between the GET and the PATCH, per-lane clock skew)
 * are derived from STRESS_SEED; the database's own scheduling is not, so a
 * seed is a replayable *input*, and a BROKEN seed is re-run 10× by the
 * campaign report to show its rate.
 *
 * Scenarios:
 *   pg_dup            N duplicate finalizes by the owner on one row
 *   pg_two_actors     owner burst + another user's burst on the same row id
 *                     (the intruder also fires the PATCH the route would
 *                     have skipped — RLS must make it a no-op)
 *   pg_column_grant   client attempts to move id / user_id / started_at on
 *                     finalize (defense-in-depth column grant → 42501)
 *   pg_create_race    the sync upsert (insert … on conflict do nothing) races
 *                     the finalize on the same id
 *   pg_guarded_oracle the same burst with `and ended_at is null` on the
 *                     UPDATE — documents that Postgres enforces stamp-once
 *                     under READ COMMITTED once the predicate is present
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  Prng,
} from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 3);
const WALL_BUDGET_MS = envInt("STRESS_WALL_MS", 5_000);
const FILE = "stress_sessions_finalize_pg_concurrency.test.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-sessions-finalize/latest/",
    import.meta.url,
  )
    .pathname;
}

function iterationSeed(base: number, i: number): number {
  if (i === 0) return base;
  let x = (base ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0 || 1;
}

function replayCommand(scenario: string, seed: number): string {
  return `XC_PG_URL=$XC_PG_URL STRESS_SEED=${seed} STRESS_PG_ITER=1 deno test -A --no-check --config deno.json ${FILE} --filter "${scenario}"`;
}

function inv(name: string, holds: boolean, detail: string): Invariant {
  return { name, holds, detail };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx | Reserved, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** One autocommitted PostgREST request on a RESERVED connection (postgres.js
 * reserved handles have no `.begin`, so the transaction is spelled out). */
async function requestOn<T>(
  conn: Reserved,
  userId: string,
  fn: (conn: Reserved) => Promise<T>,
): Promise<T> {
  await conn.unsafe("begin");
  try {
    await asUser(conn, userId);
    const out = await fn(conn);
    await conn.unsafe("commit");
    return out;
  } catch (error) {
    await conn.unsafe("rollback");
    throw error;
  }
}

/** One autocommitted PostgREST request: own transaction, caller's role/sub. */
async function asRequest<T>(
  sql: Sql,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await sql.begin(async (tx) => {
    await asUser(tx, userId);
    return await fn(tx);
  }) as T;
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function createSession(
  sql: Sql,
  userId: string,
  sessionId: string,
  startedAt: string,
) {
  await sql.unsafe(`delete from public.sessions where id = '${sessionId}'`);
  await asRequest(sql, userId, async (tx) => {
    await tx.unsafe(
      `insert into public.sessions (id, user_id, kind, started_at)
         values ('${sessionId}', '${userId}', 'practice', '${startedAt}')
         on conflict (id) do nothing`,
    );
  });
}

interface SessionRow {
  id: string;
  user_id: string;
  started_at: string;
  ended_at: string | null;
}

async function readRows(sql: Sql, sessionId: string): Promise<SessionRow[]> {
  const rows = await sql.unsafe(
    `select id::text, user_id::text, started_at::text, ended_at::text from public.sessions where id = '${sessionId}'`,
  );
  return rows as unknown as SessionRow[];
}

// ── The route's database traffic, one lane per HTTP request ────────────────

interface LaneResult {
  lane: number;
  actor: "owner" | "intruder";
  /** rows the route's SELECT returned (0 → the route answers 404) */
  found: number;
  endedAtSeen: string | null;
  /** rows the route's UPDATE affected (only issued when ended_at was null) */
  updated: number;
  wrote: string | null;
  /** server clock_timestamp() (ms) at SELECT and at UPDATE — overlap proof */
  selectAtMs: number;
  updateAtMs: number | null;
  error: string | null;
  thinkMs: number;
  skewMs: number;
}

interface FinalizeLaneOptions {
  /** append `and ended_at is null` to the UPDATE (oracle variant) */
  guarded?: boolean;
  /** issue the PATCH even when the SELECT found nothing (hostile client) */
  forcePatch?: boolean;
  /** extra columns a hostile client tries to move in the same PATCH */
  extraSet?: string;
}

async function finalizeLane(
  sql: Sql,
  gate: Promise<void>,
  ready: () => void,
  lane: number,
  actor: "owner" | "intruder",
  userId: string,
  sessionId: string,
  thinkMs: number,
  skewMs: number,
  opts: FinalizeLaneOptions = {},
): Promise<LaneResult> {
  const out: LaneResult = {
    lane,
    actor,
    found: 0,
    endedAtSeen: null,
    updated: 0,
    wrote: null,
    selectAtMs: 0,
    updateAtMs: null,
    error: null,
    thinkMs,
    skewMs,
  };
  // reserve the connection before the barrier so every lane genuinely
  // fires its SELECT at the same instant
  const reserved = await sql.reserve();
  try {
    ready();
    await gate;
    const found = await requestOn(reserved, userId, async (conn) => {
      const rows = await conn.unsafe(
        `select id::text, ended_at::text, (extract(epoch from clock_timestamp()) * 1000)::float8 as at_ms
           from public.sessions where id = '${sessionId}' and user_id = '${userId}'`,
      );
      return rows as unknown as Array<
        { id: string; ended_at: string | null; at_ms: number }
      >;
    });
    out.found = found.length;
    out.endedAtSeen = found[0]?.ended_at ?? null;
    out.selectAtMs = found[0]?.at_ms ?? Date.now();
    const shouldPatch = (found.length === 1 && found[0].ended_at === null) ||
      opts.forcePatch === true;
    if (shouldPatch) {
      if (thinkMs > 0) await sleep(thinkMs);
      // the route stamps `new Date()` in the edge isolate: model isolates whose
      // clocks disagree by skewMs
      const stamp = new Date(Date.now() + skewMs).toISOString();
      out.wrote = stamp;
      try {
        const updated = await requestOn(reserved, userId, async (conn) => {
          const rows = await conn.unsafe(
            `update public.sessions set ended_at = '${stamp}'${
              opts.extraSet ?? ""
            }
               where id = '${sessionId}' and user_id = '${userId}'${
              opts.guarded ? " and ended_at is null" : ""
            }
               returning (extract(epoch from clock_timestamp()) * 1000)::float8 as at_ms`,
          );
          return rows as unknown as Array<{ at_ms: number }>;
        });
        out.updated = updated.length;
        out.updateAtMs = updated[0]?.at_ms ?? Date.now();
      } catch (error) {
        const e = error as { code?: string; message?: string };
        out.error = `${e.code ?? "?"}:${e.message ?? String(error)}`;
      }
    }
  } catch (error) {
    const e = error as { code?: string; message?: string };
    out.error = `${e.code ?? "?"}:${e.message ?? String(error)}`;
  } finally {
    reserved.release();
  }
  return out;
}

interface BurstLane {
  actor: "owner" | "intruder";
  userId: string;
  opts?: FinalizeLaneOptions;
}

async function burst(
  sql: Sql,
  prng: Prng,
  sessionId: string,
  lanes: BurstLane[],
  maxThinkMs: number,
  maxSkewMs: number,
  extra: Array<(gate: Promise<void>, ready: () => void) => Promise<void>> = [],
): Promise<{ results: LaneResult[]; wallMs: number }> {
  const b = barrier();
  let readyCount = 0;
  const total = lanes.length + extra.length;
  let allReady!: () => void;
  const everyoneReady = new Promise<void>((resolve) => (allReady = resolve));
  const ready = () => {
    readyCount += 1;
    if (readyCount === total) allReady();
  };
  const t0 = performance.now();
  const laneJobs = lanes.map((l, i) =>
    finalizeLane(
      sql,
      b.gate,
      ready,
      i + 1,
      l.actor,
      l.userId,
      sessionId,
      maxThinkMs > 0 ? prng.int(0, maxThinkMs) : 0,
      maxSkewMs > 0 ? prng.int(-maxSkewMs, maxSkewMs) : 0,
      l.opts,
    )
  );
  const extraJobs = extra.map((fn) => fn(b.gate, ready));
  await everyoneReady;
  b.open();
  const results = await Promise.all(laneJobs);
  await Promise.all(extraJobs);
  return { results, wallMs: Math.round((performance.now() - t0) * 100) / 100 };
}

// ── Common invariants on a burst against one row ───────────────────────────

function rowInvariants(
  label: string,
  owner: string,
  sessionId: string,
  results: LaneResult[],
  rows: SessionRow[],
  expectStampOnce: boolean,
): Invariant[] {
  const owners = results.filter((r) => r.actor === "owner");
  const intruders = results.filter((r) => r.actor === "intruder");
  const writes = owners.filter((r) => r.updated > 0);
  const distinct = new Set(writes.map((r) => r.wrote));
  const overlapping = owners.filter((r) => r.updateAtMs !== null).length;
  const prefix = label ? `${label}:` : "";
  const out: Invariant[] = [
    inv(
      `${prefix}owner-sees-row`,
      owners.every((r) => r.found === 1 && r.error === null),
      `${owners.length} owner lanes: ${
        JSON.stringify(histogram(owners.map((r) =>
          `found=${r.found}${r.error ? ` err=${r.error}` : ""}`
        )))
      }`,
    ),
    inv(
      `${prefix}no-lost-stamp`,
      rows.length === 1 && rows[0].ended_at !== null,
      `row.ended_at=${
        rows[0]?.ended_at ?? "<no row>"
      } after ${owners.length} owner finalizes`,
    ),
    inv(
      `${prefix}stamp-once`,
      !expectStampOnce || writes.length === 1,
      `${writes.length} UPDATE(s) affected the row (contract: exactly one) — lanes ${
        writes.map((r) =>
          `L${r.lane}@+${
            Math.round(
              r.updateAtMs! - Math.min(...owners.map((o) => o.selectAtMs)),
            )
          }ms`
        ).join(",")
      }${expectStampOnce ? "" : " (informational)"}`,
    ),
    inv(
      `${prefix}ended_at-never-moves`,
      !expectStampOnce || distinct.size <= 1,
      `${distinct.size} distinct ended_at values written${
        expectStampOnce ? "" : " (informational)"
      }: ${[...distinct].join(" | ")}`,
    ),
    inv(
      `${prefix}no-duplicate-rows`,
      rows.length === 1,
      `${rows.length} rows with id=${sessionId}`,
    ),
    inv(
      `${prefix}ownership-unchanged`,
      rows.length === 1 && rows[0].user_id === owner,
      `row.user_id=${rows[0]?.user_id ?? "<no row>"} (owner ${owner})`,
    ),
  ];
  if (intruders.length > 0) {
    out.push(
      inv(
        `${prefix}intruder-invisible`,
        intruders.every((r) => r.found === 0),
        `${intruders.length} intruder SELECTs: ${
          JSON.stringify(histogram(intruders.map((r) => `found=${r.found}`)))
        }`,
      ),
      inv(
        `${prefix}intruder-cannot-write`,
        intruders.every((r) => r.updated === 0),
        `${
          intruders.filter((r) => r.updated > 0).length
        } intruder UPDATEs affected the row: ${
          JSON.stringify(histogram(intruders.map((r) =>
            r.error ?? `updated=${r.updated}`
          )))
        }`,
      ),
    );
  }
  out.push(inv(
    `${prefix}overlap-observed`,
    true,
    `${overlapping} lanes reached UPDATE; SELECT spread ${
      Math.round(
        Math.max(...owners.map((o) => o.selectAtMs)) -
          Math.min(...owners.map((o) => o.selectAtMs)),
      )
    }ms`,
  ));
  return out;
}

// ── Scenarios ──────────────────────────────────────────────────────────────

interface IterationRow {
  scenario: string;
  iteration: number;
  seed: number;
  outcome: "HELD" | "BROKEN";
  failed: string[];
  inputs: Record<string, unknown>;
  lanes: LaneResult[];
  finalRows: SessionRow[];
  wallMs: number;
  invariants: Invariant[];
  replay: string;
}

type ScenarioFn = (sql: Sql, prng: Prng, seed: number) => Promise<{
  inputs: Record<string, unknown>;
  lanes: LaneResult[];
  finalRows: SessionRow[];
  wallMs: number;
  invariants: Invariant[];
}>;

const pgDup: ScenarioFn = async (sql, prng) => {
  const owner = prng.uuid();
  const sessionId = prng.uuid();
  const n = prng.int(2, 8);
  const maxThinkMs = prng.int(0, 25);
  const maxSkewMs = prng.int(0, 2_000);
  await createUser(sql, owner);
  await createSession(
    sql,
    owner,
    sessionId,
    new Date(Date.now() - 60_000).toISOString(),
  );
  const lanes: BurstLane[] = Array.from(
    { length: n },
    () => ({ actor: "owner", userId: owner }),
  );
  const { results, wallMs } = await burst(
    sql,
    prng,
    sessionId,
    lanes,
    maxThinkMs,
    maxSkewMs,
  );
  const finalRows = await readRows(sql, sessionId);
  return {
    inputs: { owner, sessionId, duplicates: n, maxThinkMs, maxSkewMs },
    lanes: results,
    finalRows,
    wallMs,
    invariants: rowInvariants("", owner, sessionId, results, finalRows, true),
  };
};

const pgTwoActors: ScenarioFn = async (sql, prng) => {
  const owner = prng.uuid();
  const intruder = prng.uuid();
  const sessionId = prng.uuid();
  const nOwner = prng.int(1, 4);
  const nIntruder = prng.int(1, 4);
  const maxThinkMs = prng.int(0, 25);
  await createUser(sql, owner);
  await createUser(sql, intruder);
  await createSession(
    sql,
    owner,
    sessionId,
    new Date(Date.now() - 60_000).toISOString(),
  );
  const lanes: BurstLane[] = prng.shuffle([
    ...Array.from(
      { length: nOwner },
      (): BurstLane => ({ actor: "owner", userId: owner }),
    ),
    ...Array.from({ length: nIntruder }, (): BurstLane => ({
      actor: "intruder",
      userId: intruder,
      opts: { forcePatch: true },
    })),
  ]);
  const { results, wallMs } = await burst(
    sql,
    prng,
    sessionId,
    lanes,
    maxThinkMs,
    0,
  );
  const finalRows = await readRows(sql, sessionId);
  return {
    inputs: { owner, intruder, sessionId, nOwner, nIntruder, maxThinkMs },
    lanes: results,
    finalRows,
    wallMs,
    invariants: rowInvariants("", owner, sessionId, results, finalRows, true),
  };
};

const pgColumnGrant: ScenarioFn = async (sql, prng) => {
  const owner = prng.uuid();
  const other = prng.uuid();
  const sessionId = prng.uuid();
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await createUser(sql, owner);
  await createUser(sql, other);
  await createSession(sql, owner, sessionId, startedAt);
  const attempts = prng.shuffle([
    `, user_id = '${other}'`,
    `, started_at = '${new Date(Date.now() - 3_600_000).toISOString()}'`,
    `, id = '${prng.uuid()}'`,
    `, event_count = 999`,
  ]).slice(0, prng.int(2, 4));
  const lanes: BurstLane[] = [
    { actor: "owner", userId: owner },
    // a hostile client sends the PATCH regardless of what the GET showed
    ...attempts.map((extraSet): BurstLane => ({
      actor: "owner",
      userId: owner,
      opts: { extraSet, forcePatch: true },
    })),
  ];
  const { results, wallMs } = await burst(sql, prng, sessionId, lanes, 0, 0);
  const finalRows = await readRows(sql, sessionId);
  const hostile = results.filter((r) => r.lane > 1);
  const invariants = [
    inv(
      "column-grant-refuses-extra-columns",
      hostile.every((r) =>
        r.updated === 0 && r.error !== null && r.error.startsWith("42501")
      ),
      JSON.stringify(
        histogram(hostile.map((r) => r.error ?? `updated=${r.updated}`)),
      ),
    ),
    inv(
      "ownership-unchanged",
      finalRows.length === 1 && finalRows[0].user_id === owner &&
        finalRows[0].id === sessionId,
      `row=${JSON.stringify(finalRows[0] ?? null)}`,
    ),
    inv(
      "started_at-unchanged",
      finalRows.length === 1 &&
        new Date(finalRows[0].started_at).toISOString() === startedAt,
      `started_at=${finalRows[0]?.started_at}`,
    ),
    inv(
      "no-duplicate-rows",
      finalRows.length === 1,
      `${finalRows.length} rows with id=${sessionId}`,
    ),
    inv(
      "no-lost-stamp",
      finalRows.length === 1 && finalRows[0].ended_at !== null,
      `row.ended_at=${finalRows[0]?.ended_at ?? "<no row>"}`,
    ),
  ];
  return {
    inputs: { owner, other, sessionId, attempts },
    lanes: results,
    finalRows,
    wallMs,
    invariants,
  };
};

const pgCreateRace: ScenarioFn = async (sql, prng) => {
  const owner = prng.uuid();
  const sessionId = prng.uuid();
  const nCreate = prng.int(1, 4);
  const nFinalize = prng.int(1, 4);
  const maxThinkMs = prng.int(0, 25);
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  await createUser(sql, owner);
  await sql.unsafe(`delete from public.sessions where id = '${sessionId}'`);
  const creates: string[] = [];
  const extra = Array.from(
    { length: nCreate },
    () => async (gate: Promise<void>, ready: () => void) => {
      const reserved = await sql.reserve();
      try {
        ready();
        await gate;
        try {
          await requestOn(reserved, owner, async (conn) => {
            await conn.unsafe(
              `insert into public.sessions (id, user_id, kind, started_at)
               values ('${sessionId}', '${owner}', 'practice', '${startedAt}')
               on conflict (id) do nothing`,
            );
          });
          creates.push("ok");
        } catch (error) {
          const e = error as { code?: string; message?: string };
          creates.push(`${e.code ?? "?"}:${e.message ?? String(error)}`);
        }
      } finally {
        reserved.release();
      }
    },
  );
  const lanes: BurstLane[] = Array.from(
    { length: nFinalize },
    () => ({ actor: "owner", userId: owner }),
  );
  const { results, wallMs } = await burst(
    sql,
    prng,
    sessionId,
    lanes,
    maxThinkMs,
    0,
    extra,
  );
  const finalRows = await readRows(sql, sessionId);
  const writes = results.filter((r) => r.updated > 0);
  const distinct = new Set(writes.map((r) => r.wrote));
  const invariants = [
    inv(
      "creates-idempotent",
      creates.every((c) => c === "ok"),
      JSON.stringify(histogram(creates)),
    ),
    inv(
      "no-duplicate-rows",
      finalRows.length === 1,
      `${finalRows.length} rows with id=${sessionId}`,
    ),
    inv(
      "finalize-found-or-not-found",
      results.every((r) =>
        r.error === null && (r.found === 0 || r.found === 1)
      ),
      JSON.stringify(
        histogram(results.map((r) => r.error ?? `found=${r.found}`)),
      ),
    ),
    inv(
      "stamp-once",
      writes.length <= 1,
      `${writes.length} UPDATE(s) affected the row (contract: at most one — 0 when every finalize lost the race to the insert)`,
    ),
    inv(
      "ended_at-never-moves",
      distinct.size <= 1,
      `${distinct.size} distinct ended_at values written`,
    ),
    inv(
      "ownership-unchanged",
      finalRows.length === 1 && finalRows[0].user_id === owner,
      `row.user_id=${finalRows[0]?.user_id}`,
    ),
  ];
  return {
    inputs: { owner, sessionId, nCreate, nFinalize, maxThinkMs },
    lanes: results,
    finalRows,
    wallMs,
    invariants,
  };
};

const pgGuardedOracle: ScenarioFn = async (sql, prng) => {
  const owner = prng.uuid();
  const sessionId = prng.uuid();
  const n = prng.int(2, 8);
  const maxThinkMs = prng.int(0, 25);
  const maxSkewMs = prng.int(0, 2_000);
  await createUser(sql, owner);
  await createSession(
    sql,
    owner,
    sessionId,
    new Date(Date.now() - 60_000).toISOString(),
  );
  const lanes: BurstLane[] = Array.from({ length: n }, () => ({
    actor: "owner",
    userId: owner,
    opts: { guarded: true },
  }));
  const { results, wallMs } = await burst(
    sql,
    prng,
    sessionId,
    lanes,
    maxThinkMs,
    maxSkewMs,
  );
  const finalRows = await readRows(sql, sessionId);
  const attempted = results.filter((r) => r.wrote !== null).length;
  return {
    inputs: { owner, sessionId, duplicates: n, maxThinkMs, maxSkewMs },
    lanes: results,
    finalRows,
    wallMs,
    invariants: [
      ...rowInvariants("", owner, sessionId, results, finalRows, true),
      inv(
        "guard-absorbed-concurrent-writers",
        true,
        `${attempted} lanes issued the guarded UPDATE, ${
          results.filter((r) => r.updated > 0).length
        } affected the row`,
      ),
    ],
  };
};

const SCENARIOS: Record<string, ScenarioFn> = {
  pg_dup: pgDup,
  pg_two_actors: pgTwoActors,
  pg_column_grant: pgColumnGrant,
  pg_create_race: pgCreateRace,
  pg_guarded_oracle: pgGuardedOracle,
};

// ── Campaign ────────────────────────────────────────────────────────────────

const table: IterationRow[] = [];

async function runScenario(name: string, fn: ScenarioFn): Promise<void> {
  const sql = postgres(PG_URL, { max: 24, onnotice: () => {} });
  try {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_PG_ITER; i++) {
      const seed = iterationSeed(STRESS_SEED, i);
      const prng = new Prng(seed ^ 0x5e55);
      const result = await fn(sql, prng, seed);
      const invariants = [
        ...result.invariants,
        inv(
          "bounded-wall-time",
          result.wallMs <= WALL_BUDGET_MS,
          `${result.wallMs}ms burst wall time (budget ${WALL_BUDGET_MS}ms)`,
        ),
      ];
      const failed = invariants.filter((x) => !x.holds).map((x) => x.name);
      const row: IterationRow = {
        scenario: name,
        iteration: i,
        seed,
        outcome: failed.length === 0 ? "HELD" : "BROKEN",
        failed,
        inputs: result.inputs,
        lanes: result.lanes,
        finalRows: result.finalRows,
        wallMs: result.wallMs,
        invariants,
        replay: replayCommand(name, seed),
      };
      table.push(row);
      if (failed.length > 0) {
        failures.push(
          `  seed=${seed} failed=[${failed.join(",")}] ${
            invariants.filter((x) => !x.holds).map((x) =>
              `${x.name}: ${x.detail}`
            ).join(" ; ")
          } — replay: ${row.replay}`,
        );
      }
    }
    assert(
      failures.length === 0,
      `${name}: ${failures.length}/${STRESS_PG_ITER} iterations BROKEN (table: ${outDir()}${
        FILE.replace(/\.test\.ts$/, ".json")
      })\n${failures.join("\n")}`,
    );
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function writeTable(): Promise<string> {
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}${FILE.replace(/\.test\.ts$/, ".json")}`;
  const broken = table.filter((r) => r.outcome === "BROKEN");
  await Deno.writeTextFile(
    path,
    JSON.stringify(
      {
        file: FILE,
        pgUrlHost: PG_URL ? new URL(PG_URL).host : null,
        baseSeed: STRESS_SEED,
        iterationsPerScenario: STRESS_PG_ITER,
        executed: table.length,
        held: table.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map((r) => ({
          scenario: r.scenario,
          seed: r.seed,
          failed: r.failed,
          replay: r.replay,
        })),
        rows: table,
      },
      null,
      2,
    ),
  );
  return path;
}

for (const [name, fn] of Object.entries(SCENARIOS)) {
  Deno.test({
    name:
      `stress finalize pg concurrency: ${name} (${STRESS_PG_ITER} seeded bursts)`,
    ignore,
    sanitizeOps: false,
    sanitizeResources: false,
    fn: async () => {
      try {
        await runScenario(name, fn);
      } finally {
        await writeTable();
      }
    },
  });
}

Deno.test({
  name: "stress finalize pg concurrency: table written",
  ignore,
  fn: async () => {
    const path = await writeTable();
    console.log(`stress pg table: ${path} (${table.length} iterations)`);
  },
});
