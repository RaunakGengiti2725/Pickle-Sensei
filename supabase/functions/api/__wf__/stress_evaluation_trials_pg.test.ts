// stress — POST /v1/me/evaluation/trials, lens CONCURRENCY, Postgres half.
//
// The in-process campaign (stress_evaluation_trials_concurrency.test.ts) proves
// the handler over a MODELLED PostgREST. This file drives the SQL that
// PostgREST issues for the route's two statements on a REAL disposable
// postgres:16 with supabase/tests/shim_auth.sql + every migration applied
// (./xc_pg_up.sh):
//
//   upsert      INSERT INTO evaluation_trials (id, user_id, payload)
//               SELECT ... FROM json_populate_recordset(...) ON CONFLICT (id) DO NOTHING
//               (supabase-js `.upsert(row, { onConflict: "id", ignoreDuplicates: true })`,
//               Prefer: resolution=ignore-duplicates,return=minimal — one row per
//               statement, autocommit, exactly like the handler's per-trial loop)
//   ownership   SELECT id FROM evaluation_trials WHERE id = $1 AND user_id = $2
//               (RLS as role `authenticated` with request.jwt.claim.sub = caller)
//
// from N INDEPENDENT connections released from a barrier, so the unique index
// on id and RLS genuinely arbitrate the race. Scenarios (seeded, replayable):
//
//   PG-A  same user, K trialIds, L lanes, each lane its own shuffled order →
//         every lane's ownership read finds every id, exactly K rows, no error
//   PG-B  two users racing on shared trialIds → exactly one row per id, the
//         owner's read finds it, the other user's read finds nothing (→ the
//         handler's evaluation.trial_id_conflict), RLS hides the row from them
//   PG-C  append-only: the owner's UPDATE/DELETE on their own row is refused
//         (42501) — a "lost update" is structurally impossible
//   PG-D  payload-size boundary: payloads the handler ACCEPTS (JSON text ≤
//         250 000 chars) vs. the table CHECK pg_column_size(payload) ≤ 262144 —
//         recorded per shape (accepted-by-edge but refused-by-db means the
//         handler answers evaluation.trial_write_failed, which the mobile
//         outbox retries as transient)
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
// ignored run is NOT a pass. Scale: STRESS_PG_ITER rounds (default 4; the
// recorded stress campaign used 60), STRESS_SEED base seed, STRESS_REPLAY=<seed>
// replays one round. Output: <STRESS_OUT_DIR>/pg/pg_campaign.json.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, histogram, type Invariant, Prng } from "./xc_concurrency_harness.ts";
import {
  caseSeed,
  outDir,
  STRESS_REPLAY,
  STRESS_SEED,
  trialPayload,
  withDeadline,
  writeJson,
} from "./stress_evaluation_trials_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_ITER = envInt("STRESS_PG_ITER", 4);
const DEADLINE_MS = envInt("STRESS_PG_DEADLINE_MS", 30_000);
const FILE = "stress_evaluation_trials_pg.test.ts";

type Sql = ReturnType<typeof postgres>;
type Conn = Awaited<ReturnType<Sql["reserve"]>>;

interface LaneRow {
  lane: number;
  user: string;
  trialId: string;
  op: string;
  result: string;
  sqlstate?: string;
  serverStartMs: number;
  serverEndMs: number;
}

interface RoundOutcome {
  round: number;
  seed: number;
  kind: string;
  params: Record<string, unknown>;
  statements: number;
  resultHistogram: Record<string, number>;
  invariants: Invariant[];
  holds: boolean;
  timedOut: boolean;
  durationMs: number;
  observations: Record<string, unknown>;
  replay: string;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
       values ('${userId}', '${userId}@example.com', '{"provider":"apple"}')`,
  );
}

async function asUser(c: Conn, userId: string): Promise<void> {
  await c.unsafe(`set role authenticated`);
  await c.unsafe(`set request.jwt.claim.sub = '${userId}'`);
}

async function release(c: Conn): Promise<void> {
  try {
    await c.unsafe(`reset role`);
    await c.unsafe(`reset request.jwt.claim.sub`);
  } finally {
    c.release();
  }
}

async function serverNowMs(c: Conn): Promise<number> {
  const r = await c.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

const UPSERT_SQL = `insert into public.evaluation_trials (id, user_id, payload)
  select id, user_id, payload
    from json_populate_recordset(null::public.evaluation_trials, $1::json)
  on conflict (id) do nothing`;

const OWNERSHIP_SQL = `select id from public.evaluation_trials where id = $1 and user_id = $2`;

/** The handler's per-trial sequence for ONE trial, as the caller. */
async function upsertThenRead(
  c: Conn,
  lane: number,
  user: string,
  trialId: string,
  payload: Record<string, unknown>,
  rows: LaneRow[],
): Promise<"accepted" | "conflict" | "error"> {
  const t0 = await serverNowMs(c);
  let result: "accepted" | "conflict" | "error";
  let sqlstate: string | undefined;
  try {
    await c.unsafe(UPSERT_SQL, [[{ id: trialId, user_id: user, payload }]]);
    const found = await c.unsafe(OWNERSHIP_SQL, [trialId, user]);
    result = found.length === 1 ? "accepted" : "conflict";
  } catch (error) {
    result = "error";
    sqlstate = (error as { code?: string }).code;
  }
  const t1 = await serverNowMs(c);
  rows.push({
    lane,
    user,
    trialId,
    op: "upsert+read",
    result,
    sqlstate,
    serverStartMs: t0,
    serverEndMs: t1,
  });
  return result;
}

/** Run `fn` on `lanes` reserved connections (autocommit — one statement, one
 * transaction, exactly like PostgREST), each set to its caller, all released
 * from one barrier. */
async function burst(
  sql: Sql,
  lanes: number,
  userFor: (lane: number) => string,
  fn: (c: Conn, lane: number) => Promise<void>,
): Promise<void> {
  const b = barrier();
  let ready = 0;
  await Promise.all(
    Array.from({ length: lanes }, async (_, lane) => {
      const c = await sql.reserve();
      try {
        await asUser(c, userFor(lane));
        ready += 1;
        await b.gate;
        await fn(c, lane);
      } finally {
        await release(c);
      }
    }).concat([
      (async () => {
        while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
        b.open();
      })(),
    ]),
  );
}

async function storedRows(sql: Sql, ids: string[]) {
  if (ids.length === 0) return [] as Array<{ id: string; user_id: string; marker: string }>;
  const r = await sql.unsafe(
    `select id::text, user_id::text, payload->>'marker' as marker
       from public.evaluation_trials where id = any($1::uuid[])`,
    [ids],
  );
  return r as unknown as Array<{ id: string; user_id: string; marker: string }>;
}

function inv(list: Invariant[], name: string, holds: boolean, detail: string): void {
  list.push({ name, holds, detail });
}

// ── rounds ───────────────────────────────────────────────────────────────────

const KINDS = ["same_user_dup", "two_actors", "append_only", "size_boundary"] as const;
type Kind = (typeof KINDS)[number];

async function runRound(sql: Sql, round: number, seed: number): Promise<RoundOutcome> {
  const prng = new Prng(seed);
  const kind: Kind = KINDS[prng.int(0, KINDS.length - 1)];
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const params: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  const { timedOut } = await withDeadline(DEADLINE_MS, async () => {
    switch (kind) {
      case "same_user_dup": {
        const user = prng.uuid();
        await createUser(sql, user);
        const k = prng.int(1, 6);
        const lanes = prng.int(2, 12);
        const ids = Array.from({ length: k }, () => prng.uuid());
        const orders = Array.from({ length: lanes }, () => prng.shuffle(ids));
        Object.assign(params, {
          trials: k,
          lanes,
          orders: orders.map((o) => o.map((x) => x.slice(0, 4))),
        });
        const verdicts: string[][] = Array.from({ length: lanes }, () => []);
        await burst(
          sql,
          lanes,
          () => user,
          async (c, lane) => {
            for (const id of orders[lane]) {
              verdicts[lane].push(
                await upsertThenRead(c, lane, user, id, trialPayload(prng, id, `m${lane}`), rows),
              );
            }
          },
        );
        const stored = await storedRows(sql, ids);
        inv(
          invariants,
          "every lane's ownership read finds every trialId (idempotent duplicate delivery)",
          verdicts.every((v) => v.length === k && v.every((x) => x === "accepted")),
          JSON.stringify(histogram(verdicts.flat())),
        );
        inv(
          invariants,
          "exactly one row per trialId, owned by the user",
          stored.length === k && stored.every((r) => r.user_id === user),
          `${stored.length} rows / ${k} ids`,
        );
        inv(
          invariants,
          "stored payload is one lane's payload (first writer wins, never merged)",
          stored.every((r) => /^m\d+$/.test(r.marker)),
          stored.map((r) => r.marker).join(","),
        );
        return;
      }
      case "two_actors": {
        const a = prng.uuid();
        const b = prng.uuid();
        await createUser(sql, a);
        await createUser(sql, b);
        const shared = Array.from({ length: prng.int(1, 4) }, () => prng.uuid());
        const lanesA = prng.int(1, 4);
        const lanesB = prng.int(1, 4);
        Object.assign(params, { shared: shared.length, lanesA, lanesB });
        const verdicts = new Map<string, Array<{ user: string; verdict: string }>>();
        await burst(
          sql,
          lanesA + lanesB,
          (lane) => (lane < lanesA ? a : b),
          async (c, lane) => {
            const user = lane < lanesA ? a : b;
            for (const id of prng.shuffle(shared)) {
              const v = await upsertThenRead(
                c,
                lane,
                user,
                id,
                trialPayload(prng, id, user === a ? "A" : "B"),
                rows,
              );
              verdicts.set(id, [...(verdicts.get(id) ?? []), { user, verdict: v }]);
            }
          },
        );
        const stored = await storedRows(sql, shared);
        let ok = true;
        const detail: string[] = [];
        for (const id of shared) {
          const row = stored.filter((r) => r.id === id);
          const owner = row[0]?.user_id;
          const vs = verdicts.get(id) ?? [];
          const ownerAccepted = vs
            .filter((v) => v.user === owner)
            .every((v) => v.verdict === "accepted");
          const otherConflict = vs
            .filter((v) => v.user !== owner)
            .every((v) => v.verdict === "conflict");
          const payloadOk = row.length === 1 && row[0].marker === (owner === a ? "A" : "B");
          const good = row.length === 1 && ownerAccepted && otherConflict && payloadOk;
          ok &&= good;
          detail.push(
            `${id.slice(0, 8)}:rows=${row.length},owner=${owner === a ? "A" : owner === b ? "B" : "-"},ownerAcc=${ownerAccepted},otherConflict=${otherConflict}`,
          );
        }
        inv(
          invariants,
          "each shared trialId: one row, owner's reads accepted, other user's reads conflict, payload is the owner's",
          ok,
          detail.join(" | "),
        );
        // RLS: neither user can see a shared id the OTHER user won; each
        // sees exactly the ids they own.
        const visible: Record<string, { own: number; other: number }> = {};
        for (const user of [a, b]) {
          const c = await sql.reserve();
          try {
            await asUser(c, user);
            const seen = await c.unsafe(
              `select user_id::text from public.evaluation_trials where id = any($1::uuid[])`,
              [shared],
            );
            const owners = (seen as unknown as Array<{ user_id: string }>).map((r) => r.user_id);
            visible[user === a ? "A" : "B"] = {
              own: owners.filter((o) => o === user).length,
              other: owners.filter((o) => o !== user).length,
            };
          } finally {
            await release(c);
          }
        }
        inv(
          invariants,
          "each user sees exactly their own rows and none of the other user's (RLS)",
          visible.A.other === 0 &&
            visible.B.other === 0 &&
            visible.A.own === stored.filter((r) => r.user_id === a).length &&
            visible.B.own === stored.filter((r) => r.user_id === b).length,
          JSON.stringify(visible),
        );
        return;
      }
      case "append_only": {
        const user = prng.uuid();
        await createUser(sql, user);
        const id = prng.uuid();
        const lanes = prng.int(2, 6);
        Object.assign(params, { lanes });
        const errors: string[] = [];
        await burst(
          sql,
          lanes,
          () => user,
          async (c, lane) => {
            if (lane === 0) {
              await upsertThenRead(c, lane, user, id, trialPayload(prng, id, "owner"), rows);
              return;
            }
            // wait until the row exists, then try to rewrite / delete it
            for (let i = 0; i < 200; i++) {
              const found = await c.unsafe(OWNERSHIP_SQL, [id, user]);
              if (found.length === 1) break;
              await new Promise((r) => setTimeout(r, 2));
            }
            const stmt =
              lane % 2 === 1
                ? `update public.evaluation_trials set payload = payload || '{"marker":"rewritten"}' where id = $1`
                : `delete from public.evaluation_trials where id = $1`;
            const t0 = await serverNowMs(c);
            let result = "ok";
            let sqlstate: string | undefined;
            try {
              await c.unsafe(stmt, [id]);
            } catch (error) {
              result = "error";
              sqlstate = (error as { code?: string }).code;
              errors.push(sqlstate ?? "?");
            }
            const t1 = await serverNowMs(c);
            rows.push({
              lane,
              user,
              trialId: id,
              op: lane % 2 === 1 ? "update" : "delete",
              result,
              sqlstate,
              serverStartMs: t0,
              serverEndMs: t1,
            });
          },
        );
        const stored = await storedRows(sql, [id]);
        inv(
          invariants,
          "owner UPDATE/DELETE refused with 42501 (append-only; lost update impossible)",
          errors.length === lanes - 1 && errors.every((e) => e === "42501"),
          JSON.stringify(histogram(errors)),
        );
        inv(
          invariants,
          "row intact with the original payload",
          stored.length === 1 && stored[0].marker === "owner",
          `${stored.length} rows marker=${stored[0]?.marker}`,
        );
        return;
      }
      case "size_boundary": {
        const user = prng.uuid();
        await createUser(sql, user);
        const shapes = ["string", "numbers", "keys"] as const;
        const shape = shapes[prng.int(0, shapes.length - 1)];
        const targetChars = prng.int(200_000, 250_000);
        const id = prng.uuid();
        const base = trialPayload(prng, id, `size:${shape}`);
        let payload: Record<string, unknown>;
        if (shape === "string") {
          const room = targetChars - JSON.stringify(base).length - 20;
          const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
          let s = "";
          while (s.length < room) s += chars[prng.int(0, chars.length - 1)];
          payload = { ...base, limitingFactors: [s] };
        } else if (shape === "numbers") {
          const nums: number[] = [];
          let len = JSON.stringify(base).length + 20;
          while (len < targetChars) {
            const n = prng.int(0, 99);
            nums.push(n);
            len += String(n).length + 1;
          }
          payload = { ...base, dims: nums };
        } else {
          const obj: Record<string, number> = {};
          let len = JSON.stringify(base).length + 20;
          let i = 0;
          while (len < targetChars) {
            const key = `k${(i++).toString(36)}`;
            obj[key] = prng.int(0, 9);
            len += key.length + 5;
          }
          payload = { ...base, userFlags: obj };
        }
        const text = JSON.stringify(payload);
        const edgeAccepts = text.length <= 250_000;
        const size = await sql.unsafe(`select pg_column_size($1::jsonb)::int as n`, [payload]);
        const jsonbBytes = Number(size[0].n);
        Object.assign(params, { shape, jsonTextChars: text.length, jsonbBytes, edgeAccepts });
        const c = await sql.reserve();
        let verdict: string;
        try {
          await asUser(c, user);
          verdict = await upsertThenRead(c, 0, user, id, payload, rows);
        } finally {
          await release(c);
        }
        observations.dbVerdict = verdict;
        observations.dbSqlstate = rows[0]?.sqlstate;
        observations.edgeAcceptsButDbRefuses = edgeAccepts && verdict === "error";
        // Recorded, not asserted (see the stress report): the handler's text-length
        // gate and the table's jsonb-size cap measure different things.
        inv(
          invariants,
          "a refused write fails with the CHECK sqlstate 23514, never anything else",
          verdict !== "error" || rows[0]?.sqlstate === "23514",
          `verdict=${verdict} sqlstate=${rows[0]?.sqlstate}`,
        );
        return;
      }
    }
  });
  const durationMs = Math.round(performance.now() - t0);
  inv(
    invariants,
    `bounded wall time (< ${DEADLINE_MS} ms, no deadlock)`,
    !timedOut,
    `${durationMs} ms`,
  );
  const deadlocks = rows.filter((r) => r.sqlstate === "40P01" || r.sqlstate === "40001");
  inv(
    invariants,
    "no deadlock / serialization failure (40P01, 40001)",
    deadlocks.length === 0,
    `${deadlocks.length}`,
  );
  const unexpected = rows.filter(
    (r) => r.result === "error" && r.op === "upsert+read" && kind !== "size_boundary",
  );
  inv(
    invariants,
    "no SQL error on the route's statements",
    unexpected.length === 0,
    JSON.stringify(histogram(unexpected.map((r) => r.sqlstate ?? "?"))),
  );
  const overlapping = rows.some((x) =>
    rows.some((y) => x !== y && x.serverStartMs < y.serverEndMs && y.serverStartMs < x.serverEndMs),
  );
  observations.serverSideOverlapObserved = overlapping;
  return {
    round,
    seed,
    kind,
    params,
    statements: rows.length,
    resultHistogram: histogram(
      rows.map((r) => `${r.op}:${r.result}${r.sqlstate ? `:${r.sqlstate}` : ""}`),
    ),
    invariants,
    holds: invariants.every((i) => i.holds),
    timedOut,
    durationMs,
    observations,
    replay: `XC_PG_URL=<url> STRESS_REPLAY=${seed} deno test -A --no-check --config deno.json ${FILE}`,
  };
}

Deno.test({
  name: "stress trials (pg): seeded upsert/ownership races on a real postgres:16 with every migration",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 24, onnotice: () => {} });
    try {
      const seeds = STRESS_REPLAY
        ? [Number(STRESS_REPLAY) >>> 0]
        : Array.from({ length: PG_ITER }, (_, i) => caseSeed(STRESS_SEED ^ 0x9c, i));
      const outcomes: RoundOutcome[] = [];
      const t0 = performance.now();
      for (let i = 0; i < seeds.length; i++) {
        const o = await runRound(sql, i, seeds[i]);
        outcomes.push(o);
        if (!o.holds) {
          console.log(`[stress-pg] seed=${o.seed} kind=${o.kind} BROKEN:`);
          for (const x of o.invariants.filter((x) => !x.holds)) {
            console.log(`[stress-pg]   ${x.name} — ${x.detail}`);
          }
        }
      }
      const version = await sql.unsafe(`select version()`);
      const summary = {
        file: FILE,
        postgres: String(version[0].version),
        baseSeed: STRESS_SEED,
        rounds: outcomes.length,
        held: outcomes.filter((o) => o.holds).length,
        broken: outcomes.filter((o) => !o.holds).length,
        statements: outcomes.reduce((n, o) => n + o.statements, 0),
        invariantsChecked: outcomes.reduce((n, o) => n + o.invariants.length, 0),
        byKind: histogram(outcomes.map((o) => o.kind)),
        edgeAcceptsButDbRefuses: outcomes
          .filter((o) => o.observations.edgeAcceptsButDbRefuses === true)
          .map((o) => ({ seed: o.seed, ...o.params })),
        durationMs: Math.round(performance.now() - t0),
        brokenSeeds: outcomes.filter((o) => !o.holds).map((o) => o.seed),
      };
      const path = await writeJson(outDir("pg"), "pg_campaign.json", { summary, table: outcomes });
      console.log(
        `[stress-pg] ${summary.rounds} rounds, ${summary.held} HELD, ${summary.broken} BROKEN, ${summary.statements} statements, ${summary.durationMs} ms → ${path}`,
      );
      console.log(`[stress-pg] by kind: ${JSON.stringify(summary.byKind)}`);
      assertEquals(summary.brokenSeeds, [], `broken seeds: ${summary.brokenSeeds.join(", ")}`);
      assert(summary.rounds > 0);
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});

Deno.test({
  name: "stress trials (pg): every scenario kind runs at least once from a fixed seed",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 24, onnotice: () => {} });
    try {
      const outcomes: RoundOutcome[] = [];
      for (let i = 0; i < KINDS.length; i++) {
        // find the first seed in a small window that draws KINDS[i]
        let seed = caseSeed(STRESS_SEED ^ 0x5eed, i);
        for (let j = 0; j < 64; j++) {
          const probe = caseSeed(STRESS_SEED ^ 0x5eed, i * 64 + j);
          if (KINDS[new Prng(probe).int(0, KINDS.length - 1)] === KINDS[i]) {
            seed = probe;
            break;
          }
        }
        outcomes.push(await runRound(sql, 1000 + i, seed));
      }
      const kinds = new Set(outcomes.map((o) => o.kind));
      assertEquals(
        [...KINDS].filter((k) => !kinds.has(k)),
        [],
      );
      const broken = outcomes.filter((o) => !o.holds);
      assertEquals(
        broken.map(
          (o) =>
            `${o.kind}@${o.seed}: ${o.invariants
              .filter((i) => !i.holds)
              .map((i) => i.name)
              .join("; ")}`,
        ),
        [],
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
