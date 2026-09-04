/**
 * STRESS — unit route-post-v1-me-consent-grant, lens `concurrency`,
 * REAL-POSTGRES half.
 *
 * stress_consent_grant_concurrency.test.ts proves the handler's behaviour over
 * a modelled database. This file drives what the route actually writes —
 * `insert into public.consent_records` and the ordered read-back
 * (`order created_at, id`) — as role `authenticated` with the caller's JWT
 * sub, from N INDEPENDENT connections released from a barrier, on a disposable
 * postgres:16 with shim_auth.sql + EVERY migration applied (./xc_pg_up.sh).
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d, and an
 * ignored run is NOT a pass — the report records it as UNKNOWN.
 *
 * Seeded: STRESS_SEED drives every user id, so a failure replays with the
 * printed command. Each scenario appends to <STRESS_OUT_DIR>/consent_grant_pg.json
 * (lane rows with server-side clock_timestamp() windows, invariants, replay).
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  outDir,
  Prng,
  STRESS_SEED,
} from "./stress_consent_grant_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 2);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  result: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface PgScenario {
  scenario: string;
  seed: number;
  lanes: number;
  rounds: number;
  laneRows: LaneRow[];
  resultHistogram: Record<string, number>;
  overlappingLanes: number;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
}

const scenarios: PgScenario[] = [];

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** auth.users → the handle_new_user trigger creates the profiles row the
 * consent_records FK points at. Seeded ids repeat, so clear first. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  const profile = await sql.unsafe(`select 1 from public.profiles where id = '${userId}'`);
  if (profile.length === 0) {
    await sql.unsafe(
      `insert into public.profiles (id, email, provider) values ('${userId}', '${userId}@example.com', 'google')`,
    );
  }
}

/** N independent connections; each opens a tx, becomes `authenticated` with
 * its sub, waits at the barrier, then runs `fn` and COMMITs. */
async function burst(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneRow, "round" | "lane" | "clientMs">>,
  round: number,
): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql
        .begin(async (tx) => {
          await asUser(tx as unknown as Tx, userIdFor(lane));
          ready += 1;
          await b.gate;
          const t0 = performance.now();
          const out = await fn(tx as unknown as Tx, lane);
          rows.push({
            round,
            lane,
            clientMs: Math.round((performance.now() - t0) * 100) / 100,
            ...out,
          });
        })
        .catch((error) => {
          // A lane whose statement raised aborts its tx; the raised SQLSTATE
          // IS the observation (RLS denial, check violation, append-only).
          rows.push({
            round,
            lane,
            op: "aborted",
            result: sqlstate(error),
            serverStartMs: 0,
            serverEndMs: 0,
            clientMs: 0,
          });
        }),
    ),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b2) => a.lane - b2.lane);
  return rows;
}

/** Run a statement that is EXPECTED to be able to fail inside an open tx,
 * behind a savepoint so the lane's transaction survives the error and can
 * keep observing (Postgres aborts the whole tx otherwise). */
async function attempt(tx: Tx, statement: string, params: unknown[]): Promise<string> {
  await tx.unsafe(`savepoint probe`);
  try {
    await tx.unsafe(statement, params as never);
    await tx.unsafe(`release savepoint probe`);
    return "ok";
  } catch (error) {
    await tx.unsafe(`rollback to savepoint probe`);
    return sqlstate(error);
  }
}

function sqlstate(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${code}:${message.slice(0, 80)}` : `unknown:${message.slice(0, 80)}`;
}

/** The exact statement the route issues (index.ts:1847-1856). */
async function insertGrant(
  tx: Tx,
  userId: string,
  scope: string,
  version: string,
  source: string,
): Promise<Omit<LaneRow, "round" | "lane" | "clientMs">> {
  const t0 = await serverNowMs(tx);
  let result = "inserted";
  try {
    await tx.unsafe(
      `insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
       values ($1, $2, $3, 'grant', $4, $5::jsonb, 'all_captures')`,
      [userId, scope, version, source, JSON.stringify("iPhone15,2 iOS 18.2")],
    );
  } catch (error) {
    result = sqlstate(error);
    throw Object.assign(error as Error, { laneResult: result });
  }
  const t1 = await serverNowMs(tx);
  return { op: "grant", result, serverStartMs: t0, serverEndMs: t1 };
}

async function insertWithdraw(
  tx: Tx,
  userId: string,
  scope: string,
  source: string,
): Promise<Omit<LaneRow, "round" | "lane" | "clientMs">> {
  const t0 = await serverNowMs(tx);
  // withdrawConsent reads the ledger first and carries the version forward
  // (index.ts:1874-1884) — the read-then-write the race can interleave.
  const before = await tx.unsafe(
    `select consent_version from public.consent_records
      where user_id = $1 and scope = $2 order by created_at desc, id desc limit 1`,
    [userId, scope],
  );
  const carried = before.length > 0 ? (before[0].consent_version as string | null) : null;
  await tx.unsafe(
    `insert into public.consent_records (user_id, scope, consent_version, action, source, device)
     values ($1, $2, $3, 'withdraw', $4, $5::jsonb)`,
    [userId, scope, carried, source, JSON.stringify("iPhone15,2 iOS 18.2")],
  );
  const t1 = await serverNowMs(tx);
  return { op: "withdraw", result: "inserted", serverStartMs: t0, serverEndMs: t1 };
}

/** The route's read-back (index.ts:1796-1801) folded like foldConsentStatus. */
async function foldFromDb(
  sql: Sql,
  userId: string,
): Promise<{ rows: number; fold: Record<string, { active: boolean; version: string | null }> }> {
  let out!: { rows: number; fold: Record<string, { active: boolean; version: string | null }> };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId);
    const rows = await (tx as unknown as Tx).unsafe(
      `select scope, action, consent_version, created_at from public.consent_records
        where user_id = $1 order by created_at asc, id asc`,
      [userId],
    );
    const fold: Record<string, { active: boolean; version: string | null }> = {};
    for (const row of rows) {
      fold[String(row.scope)] = {
        active: row.action === "grant",
        version: (row.consent_version as string | null) ?? null,
      };
    }
    out = { rows: rows.length, fold };
  });
  return out;
}

function overlapCount(rows: LaneRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (
      rows.some(
        (b) =>
          b !== a &&
          a.serverEndMs > 0 &&
          b.serverEndMs > 0 &&
          a.serverStartMs < b.serverEndMs &&
          b.serverStartMs < a.serverEndMs,
      )
    ) {
      n += 1;
    }
  }
  return n;
}

function replay(scenario: string): string {
  return (
    `XC_PG_URL=$XC_PG_URL STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} ` +
    `deno test -A --no-check --config deno.json stress_consent_grant_pg.test.ts --filter "${scenario}"`
  );
}

function record(
  scenario: string,
  laneRows: LaneRow[],
  invariants: Invariant[],
  observations: Record<string, unknown>,
  durationMs: number,
): void {
  scenarios.push({
    scenario,
    seed: STRESS_SEED,
    lanes: LANES,
    rounds: ROUNDS,
    laneRows,
    resultHistogram: histogram(laneRows.map((r) => r.result.split(":")[0])),
    overlappingLanes: overlapCount(laneRows),
    invariants,
    observations,
    durationMs: Math.round(durationMs * 100) / 100,
    replay: replay(scenario),
  });
  const failed = invariants.filter((inv) => !inv.holds);
  assertEquals(
    failed.map((inv) => `${inv.name}: ${inv.detail}`),
    [],
    `[${scenario}] BROKEN — replay: ${replay(scenario)}`,
  );
}

function connect(): Sql {
  return postgres(PG_URL, { max: LANES + 4, idle_timeout: 5, onnotice: () => {} });
}

const seedPrng = new Prng(STRESS_SEED);
const userIds = Array.from({ length: 6 }, () => seedPrng.uuid());

// ── PG1: duplicate delivery — N identical grants from N transactions ────────
Deno.test({
  name: "stress/consent-grant/pg: PG1 duplicate_grant_burst",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const userId = userIds[0];
      await createUser(sql, userId);
      const laneRows: LaneRow[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        laneRows.push(
          ...(await burst(
            sql,
            LANES,
            () => userId,
            (tx, lane) =>
              insertGrant(tx, userId, "model_training", "model-training-v1", `r${round}l${lane}`),
            round,
          )),
        );
      }
      const durationMs = performance.now() - started;
      const after = await foldFromDb(sql, userId);
      const inserted = laneRows.filter((r) => r.result === "inserted").length;
      const invariants: Invariant[] = [
        {
          name: "PG1_every_lane_committed",
          holds: inserted === LANES * ROUNDS && after.rows === LANES * ROUNDS,
          detail: `lanes_inserted=${inserted} rows=${after.rows} expected=${LANES * ROUNDS}`,
        },
        {
          name: "PG1_no_deadlock_or_serialization_failure",
          holds: laneRows.every((r) => !/40P01|40001/.test(r.result)),
          detail: histogramText(laneRows),
        },
        {
          name: "PG1_status_idempotent",
          holds: after.fold.model_training?.active === true,
          detail: `fold=${JSON.stringify(after.fold)}`,
        },
        {
          name: "PG1_lanes_overlapped",
          holds: overlapCount(laneRows) > 1,
          detail: `${overlapCount(laneRows)}/${laneRows.length} lanes overlapped a peer`,
        },
        {
          name: "PG1_bounded_wall_time",
          holds: durationMs < 30_000,
          detail: `${Math.round(durationMs)}ms for ${LANES}×${ROUNDS} concurrent inserts`,
        },
      ];
      record(
        "PG1_duplicate_grant_burst",
        laneRows,
        invariants,
        { ledgerRows: after.rows, fold: after.fold },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

function histogramText(rows: LaneRow[]): string {
  return JSON.stringify(histogram(rows.map((r) => r.result.split(":")[0])));
}

// ── PG2: grant vs withdraw racing on the same scope ─────────────────────────
Deno.test({
  name: "stress/consent-grant/pg: PG2 grant_withdraw_race",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const userId = userIds[1];
      await createUser(sql, userId);
      const laneRows: LaneRow[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        laneRows.push(
          ...(await burst(
            sql,
            LANES,
            () => userId,
            (tx, lane) =>
              lane % 2 === 0
                ? insertGrant(
                    tx,
                    userId,
                    "model_training",
                    `mt-v${round}${lane}`,
                    `r${round}l${lane}`,
                  )
                : insertWithdraw(tx, userId, "model_training", `r${round}l${lane}`),
            round,
          )),
        );
      }
      const durationMs = performance.now() - started;
      const first = await foldFromDb(sql, userId);
      const second = await foldFromDb(sql, userId);
      const winner = await sql.unsafe(
        `select action, consent_version from public.consent_records
          where user_id = $1 and scope = 'model_training'
          order by created_at desc, id desc limit 1`,
        [userId],
      );
      const invariants: Invariant[] = [
        {
          name: "PG2_no_lost_write",
          holds: first.rows === LANES * ROUNDS,
          detail: `rows=${first.rows} expected=${LANES * ROUNDS}`,
        },
        {
          name: "PG2_fold_stable_across_reads",
          holds: JSON.stringify(first.fold) === JSON.stringify(second.fold),
          detail: `${JSON.stringify(first.fold)} vs ${JSON.stringify(second.fold)}`,
        },
        {
          name: "PG2_fold_is_last_row_in_index_order",
          holds:
            first.fold.model_training?.active === (String(winner[0]?.action ?? "") === "grant"),
          detail: `fold=${JSON.stringify(first.fold.model_training)} last_row=${JSON.stringify(winner[0] ?? null)}`,
        },
        {
          name: "PG2_no_deadlock",
          holds: laneRows.every((r) => !/40P01|40001/.test(r.result)),
          detail: histogramText(laneRows),
        },
        {
          name: "PG2_bounded_wall_time",
          holds: durationMs < 30_000,
          detail: `${Math.round(durationMs)}ms`,
        },
      ];
      record(
        "PG2_grant_withdraw_race",
        laneRows,
        invariants,
        { rows: first.rows, fold: first.fold, lastRow: winner[0] ?? null },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

// ── PG3: two actors — RLS under contention ──────────────────────────────────
Deno.test({
  name: "stress/consent-grant/pg: PG3 two_actors_rls",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const [victim, attacker] = [userIds[2], userIds[3]];
      await createUser(sql, victim);
      await createUser(sql, attacker);
      // The victim grants while the attacker tries to write rows OWNED BY the
      // victim and to read the victim's ledger, all from concurrent lanes.
      const laneRows = await burst(
        sql,
        LANES,
        (lane) => (lane % 2 === 0 ? victim : attacker),
        async (tx, lane) => {
          if (lane % 2 === 0) {
            return await insertGrant(tx, victim, "video_analysis", "va-v1", `victim-l${lane}`);
          }
          const t0 = await serverNowMs(tx);
          const outcome = await attempt(
            tx,
            `insert into public.consent_records (user_id, scope, consent_version, action, source)
             values ($1, 'video_analysis', 'forged', 'withdraw', $2)`,
            [victim, `attacker-l${lane}`],
          );
          const result = outcome === "ok" ? "leaked" : outcome;
          const seen = await tx.unsafe(
            `select count(*)::int as n from public.consent_records where user_id = $1`,
            [victim],
          );
          const t1 = await serverNowMs(tx);
          return {
            op: "forge+read",
            result: `${result}|victim_rows_visible=${Number(seen[0].n)}`,
            serverStartMs: t0,
            serverEndMs: t1,
          };
        },
        0,
      );
      const durationMs = performance.now() - started;
      const victimRows = await foldFromDb(sql, victim);
      const forged = await sql.unsafe(
        `select count(*)::int as n from public.consent_records where source like 'attacker-%'`,
      );
      const attackerLanes = laneRows.filter((r) => r.op === "forge+read");
      const invariants: Invariant[] = [
        {
          name: "PG3_forged_insert_always_denied",
          holds:
            attackerLanes.length > 0 && attackerLanes.every((r) => r.result.startsWith("42501")),
          detail: JSON.stringify(attackerLanes.map((r) => r.result.split("|")[0])),
        },
        {
          name: "PG3_no_forged_row_exists",
          holds: Number(forged[0].n) === 0,
          detail: `forged_rows=${Number(forged[0].n)}`,
        },
        {
          name: "PG3_attacker_reads_nothing",
          holds: attackerLanes.every((r) => r.result.endsWith("victim_rows_visible=0")),
          detail: JSON.stringify(attackerLanes.map((r) => r.result.split("|")[1])),
        },
        {
          name: "PG3_victim_writes_all_landed",
          holds: victimRows.rows === LANES / 2,
          detail: `victim_rows=${victimRows.rows} expected=${LANES / 2}`,
        },
      ];
      record(
        "PG3_two_actors_rls",
        laneRows,
        invariants,
        { victimRows: victimRows.rows, forgedRows: Number(forged[0].n) },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

// ── PG4: append-only under concurrency ──────────────────────────────────────
Deno.test({
  name: "stress/consent-grant/pg: PG4 append_only_under_load",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const userId = userIds[4];
      await createUser(sql, userId);
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, userId);
        await (tx as unknown as Tx).unsafe(
          `insert into public.consent_records (user_id, scope, consent_version, action, source)
           values ($1, 'model_training', 'mt-v1', 'grant', 'seed-row')`,
          [userId],
        );
      });
      const laneRows = await burst(
        sql,
        LANES,
        () => userId,
        async (tx, lane) => {
          if (lane % 3 === 0) {
            return await insertGrant(tx, userId, "model_training", "mt-v1", `append-l${lane}`);
          }
          const t0 = await serverNowMs(tx);
          const statement =
            lane % 3 === 1
              ? `update public.consent_records set action = 'withdraw' where user_id = $1`
              : `delete from public.consent_records where user_id = $1`;
          const outcome = await attempt(tx, statement, [userId]);
          const result = outcome === "ok" ? "MUTATED" : outcome;
          const t1 = await serverNowMs(tx);
          return {
            op: lane % 3 === 1 ? "update" : "delete",
            result,
            serverStartMs: t0,
            serverEndMs: t1,
          };
        },
        0,
      );
      const durationMs = performance.now() - started;
      const after = await foldFromDb(sql, userId);
      const mutations = laneRows.filter((r) => r.op === "update" || r.op === "delete");
      const appended = laneRows.filter((r) => r.op === "grant" && r.result === "inserted").length;
      const invariants: Invariant[] = [
        {
          name: "PG4_no_mutation_succeeded",
          holds: mutations.length > 0 && mutations.every((r) => r.result !== "MUTATED"),
          detail: JSON.stringify(histogram(mutations.map((r) => r.result.split(":")[0]))),
        },
        {
          name: "PG4_appends_still_land",
          holds: after.rows === appended + 1,
          detail: `rows=${after.rows} appended=${appended} + seed row`,
        },
        {
          name: "PG4_still_granted",
          holds: after.fold.model_training?.active === true,
          detail: JSON.stringify(after.fold),
        },
        {
          name: "PG4_bounded_wall_time",
          holds: durationMs < 30_000,
          detail: `${Math.round(durationMs)}ms`,
        },
      ];
      record(
        "PG4_append_only_under_load",
        laneRows,
        invariants,
        { rows: after.rows, mutationsAttempted: mutations.length },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

// ── PG5: created_at ties — the fold must still be deterministic ─────────────
Deno.test({
  name: "stress/consent-grant/pg: PG5 created_at_tie_ordering",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const userId = userIds[5];
      await createUser(sql, userId);
      const stamp = "2026-09-04T12:00:00.000000Z";
      const laneRows = await burst(
        sql,
        LANES,
        () => userId,
        async (tx, lane) => {
          const t0 = await serverNowMs(tx);
          await tx.unsafe(
            `insert into public.consent_records
               (user_id, scope, consent_version, action, source, created_at)
             values ($1, 'evaluation_telemetry', $2, $3, $4, $5::timestamptz)`,
            [userId, `et-v${lane}`, lane % 2 === 0 ? "grant" : "withdraw", `tie-l${lane}`, stamp],
          );
          const t1 = await serverNowMs(tx);
          return {
            op: lane % 2 === 0 ? "grant" : "withdraw",
            result: "inserted",
            serverStartMs: t0,
            serverEndMs: t1,
          };
        },
        0,
      );
      const durationMs = performance.now() - started;
      const reads = [
        await foldFromDb(sql, userId),
        await foldFromDb(sql, userId),
        await foldFromDb(sql, userId),
      ];
      const stamps = await sql.unsafe(
        `select count(distinct created_at)::int as n from public.consent_records where user_id = $1`,
        [userId],
      );
      const folds = reads.map((r) => JSON.stringify(r.fold));
      const invariants: Invariant[] = [
        {
          name: "PG5_all_rows_share_created_at",
          holds: Number(stamps[0].n) === 1,
          detail: `distinct created_at=${Number(stamps[0].n)} over ${reads[0].rows} rows`,
        },
        {
          name: "PG5_fold_deterministic_under_tie",
          holds: folds.every((f) => f === folds[0]),
          detail: folds.join(" | "),
        },
        {
          name: "PG5_no_lost_write",
          holds: reads[0].rows === LANES,
          detail: `rows=${reads[0].rows} expected=${LANES}`,
        },
      ];
      record(
        "PG5_created_at_tie_ordering",
        laneRows,
        invariants,
        { fold: reads[0].fold, tieWinnerVersion: reads[0].fold.evaluation_telemetry?.version },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

// ── PG6: the route's sanitize ceiling vs the table's CHECK ──────────────────
// index.ts:1850 sanitizes consentVersion to 64 chars and 1855 captureMode to
// 64, but consent_records_bounds caps both at 50. A version between 51 and 64
// characters therefore reaches Postgres and is REJECTED (23514), which
// grantConsent turns into a 503. Measured here so the claim is evidence, not
// inference.
Deno.test({
  name: "stress/consent-grant/pg: PG6 sanitize_ceiling_vs_check_bound",
  ignore,
  fn: async () => {
    const sql = connect();
    const started = performance.now();
    try {
      const userId = userIds[0];
      await createUser(sql, userId);
      const probes: Array<{ label: string; version: string; captureMode: string }> = [
        { label: "len50", version: "v".repeat(50), captureMode: "all_captures" },
        { label: "len51", version: "v".repeat(51), captureMode: "all_captures" },
        { label: "len64", version: "v".repeat(64), captureMode: "all_captures" },
        { label: "capture_len64", version: "mt-v1", captureMode: "c".repeat(64) },
      ];
      const laneRows: LaneRow[] = [];
      let lane = 0;
      for (const probe of probes) {
        let result = "inserted";
        await sql
          .begin(async (tx) => {
            await asUser(tx as unknown as Tx, userId);
            await (tx as unknown as Tx).unsafe(
              `insert into public.consent_records
                 (user_id, scope, consent_version, action, source, capture_mode)
               values ($1, 'model_training', $2, 'grant', $3, $4)`,
              [userId, probe.version, `probe-${probe.label}`, probe.captureMode],
            );
          })
          .catch((error) => {
            result = sqlstate(error);
          });
        laneRows.push({
          round: 0,
          lane: lane++,
          op: probe.label,
          result,
          serverStartMs: 0,
          serverEndMs: 0,
          clientMs: 0,
        });
      }
      const durationMs = performance.now() - started;
      const byLabel = new Map(laneRows.map((r) => [r.op, r.result]));
      const rejected = ["len51", "len64", "capture_len64"].filter((label) =>
        (byLabel.get(label) ?? "").startsWith("23514"),
      );
      const invariants: Invariant[] = [
        {
          name: "PG6_len50_accepted",
          holds: byLabel.get("len50") === "inserted",
          detail: `len50 → ${byLabel.get("len50")}`,
        },
        {
          // The bound belongs to the table; the route sanitizing to 64 means a
          // 51..64 char version is a guaranteed 503. Recorded, not asserted
          // away: the assertion is that the behaviour is EXACTLY this.
          name: "PG6_51_to_64_rejected_by_check",
          holds: rejected.length === 3,
          detail: `rejected=${JSON.stringify(rejected)} results=${JSON.stringify(
            Object.fromEntries(byLabel),
          )}`,
        },
      ];
      record(
        "PG6_sanitize_ceiling_vs_check_bound",
        laneRows,
        invariants,
        {
          note:
            "grantConsent sanitizes consentVersion/captureMode to 64 chars " +
            "(index.ts:1850,1855) while consent_records_bounds caps both at 50 " +
            "— a 51..64 char value is a permanent 503 for that client",
          results: Object.fromEntries(byLabel),
        },
        durationMs,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress/consent-grant/pg: report",
  ignore,
  fn: async () => {
    const dir = outDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}consent_grant_pg.json`;
    const payload = {
      unit: "route-post-v1-me-consent-grant",
      lens: "concurrency",
      plane: "cloud/linux — disposable postgres:16, shim_auth.sql + every migration",
      pgUrl: PG_URL.replace(/:[^:@/]*@/, ":***@"),
      lanes: LANES,
      rounds: ROUNDS,
      seed: STRESS_SEED,
      finishedAt: new Date().toISOString(),
      totals: {
        scenarios: scenarios.length,
        laneExecutions: scenarios.reduce((sum, s) => sum + s.laneRows.length, 0),
        failedInvariants: scenarios.flatMap((s) => s.invariants.filter((i) => !i.holds)).length,
      },
      scenarios,
    };
    await Deno.writeTextFile(path, JSON.stringify(payload, null, 2));
    console.log(
      `[stress-pg] ${payload.totals.scenarios} scenarios, ${payload.totals.laneExecutions} lane executions → ${path}`,
    );
    assert(scenarios.length >= 6, `expected 6 pg scenarios, got ${scenarios.length}`);
  },
});
