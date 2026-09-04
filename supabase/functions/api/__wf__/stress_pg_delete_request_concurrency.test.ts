/**
 * stress — POST /v1/me/delete-request × concurrency: the REAL Postgres half.
 *
 * The in-process campaign (stress_delete_request_concurrency.test.ts) proves
 * the handler over a MODELLED PostgREST. This file issues the exact statement
 * PostgREST issues for `upsert(..., { onConflict: "user_id" })` —
 *   insert into public.account_deletion_requests (user_id, challenge,
 *     created_at, expires_at) values (…)
 *   on conflict (user_id) do update set user_id = excluded.user_id,
 *     challenge = excluded.challenge, created_at = excluded.created_at,
 *     expires_at = excluded.expires_at
 * — from N INDEPENDENT connections, each in its own transaction as role
 * `authenticated` with the caller's JWT sub, all released from a barrier so
 * they genuinely contend on the primary key. That covers what a fake cannot:
 * the real unique index, the RLS policies, the column-level UPDATE grant
 * (20260831160000 grants EXACTLY these four columns — a missing one surfaces
 * as 42501 → the route's 503), the profiles FK, and deadlock behaviour.
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json \
 *     stress_pg_delete_request_concurrency.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Scale: STRESS_PG_LANES (default 8) × STRESS_PG_ROUNDS (default 2).
 * Writes <STRESS_OUT_DIR>/delete_request_pg.json (round → lane outcomes,
 * server-side clock windows so overlap is provable, invariants, replay).
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  outDir,
  Prng,
  salt,
  STRESS_SEED,
} from "./stress_delete_request_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 8);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 2);
const TTL_MS = 15 * 60_000;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  result: string;
  challenge?: string;
  sqlState?: string;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

interface PgScenarioReport {
  scenario: string;
  seed: number;
  scale: { lanes: number; rounds: number };
  inputs: Record<string, unknown>;
  resultHistogram: Record<string, number>;
  lanesOverlappingAnotherLane: number;
  invariants: Invariant[];
  observations: Record<string, unknown>;
  rows: LaneRow[];
  durationMs: number;
  replay: string;
}

const reports: PgScenarioReport[] = [];

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Seeded ids repeat across runs against the same disposable DB, so drop what
 * an earlier run with this seed left behind. `handle_new_user()` creates the
 * profiles row the deletion tables reference. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
     values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

function sqlStateOf(error: unknown): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

/** The statement PostgREST emits for the route's upsert. */
async function upsertRequest(
  tx: Tx,
  userId: string,
  challenge: string,
  nowMs: number,
): Promise<Omit<LaneRow, "round" | "lane" | "clientMs">> {
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + TTL_MS).toISOString();
  const t0 = await serverNowMs(tx);
  try {
    await tx.unsafe(
      `insert into public.account_deletion_requests (user_id, challenge, created_at, expires_at)
       values ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz)
       on conflict (user_id) do update
         set user_id = excluded.user_id,
             challenge = excluded.challenge,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at`,
      [userId, challenge, createdAt, expiresAt],
    );
    return {
      op: "upsert",
      result: "ok",
      challenge,
      serverStartMs: t0,
      serverEndMs: await serverNowMs(tx),
    };
  } catch (error) {
    return {
      op: "upsert",
      result: "error",
      challenge,
      sqlState: sqlStateOf(error),
      serverStartMs: t0,
      serverEndMs: Date.now(),
    };
  }
}

/** Run `lanes` transactions concurrently: each opens, becomes its caller,
 * waits at the barrier, runs `fn`, then commits. */
async function burst(
  sql: Sql,
  lanes: number,
  userIdFor: (lane: number) => string,
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneRow, "round" | "lane" | "clientMs">>,
  round: number,
  onOpen?: () => void,
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
        .catch((error: unknown) => {
          // The lane's statement already recorded its own outcome; the COMMIT
          // of the poisoned transaction then fails with the same SQLSTATE.
          // Keep one row per lane and annotate it.
          const own = rows.find((x) => x.round === round && x.lane === lane);
          if (own) {
            own.result = own.result === "ok" ? "commit_failed" : own.result;
            own.sqlState ||= sqlStateOf(error);
            return;
          }
          rows.push({
            round,
            lane,
            op: "tx",
            result: "tx_aborted",
            sqlState: sqlStateOf(error),
            serverStartMs: Date.now(),
            serverEndMs: Date.now(),
            clientMs: 0,
          });
        }),
    ),
  );
  while (ready + rows.length < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  onOpen?.();
  await all;
  rows.sort((a, b2) => a.lane - b2.lane);
  return rows;
}

function overlapCount(rows: LaneRow[]): number {
  let n = 0;
  for (const a of rows) {
    if (
      rows.some(
        (b) => b !== a && a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs,
      )
    )
      n++;
  }
  return n;
}

function inv(invariants: Invariant[], name: string, holds: boolean, detail: string): void {
  invariants.push({ name, holds, detail });
}

function replay(filter: string): string {
  return `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_pg_delete_request_concurrency.test.ts --filter "${filter}"`;
}

async function requestRows(sql: Sql, userId: string): Promise<Array<Record<string, unknown>>> {
  const r = await sql.unsafe(
    `select user_id::text as user_id, challenge::text as challenge,
            (extract(epoch from created_at) * 1000)::float8 as created_ms,
            (extract(epoch from expires_at) * 1000)::float8 as expires_ms
       from public.account_deletion_requests where user_id = '${userId}'`,
  );
  return r as unknown as Array<Record<string, unknown>>;
}

async function scenario(
  name: string,
  label: string,
  run: (
    sql: Sql,
    prng: Prng,
    rows: LaneRow[],
    invariants: Invariant[],
    inputs: Record<string, unknown>,
    observations: Record<string, unknown>,
  ) => Promise<void>,
): Promise<PgScenarioReport> {
  const sql = postgres(PG_URL, { max: LANES + 2 });
  const prng = new Prng((STRESS_SEED ^ salt(name)) >>> 0);
  const rows: LaneRow[] = [];
  const invariants: Invariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const t0 = performance.now();
  try {
    await run(sql, prng, rows, invariants, inputs, observations);
  } finally {
    await sql.end();
  }
  const report: PgScenarioReport = {
    scenario: name,
    seed: STRESS_SEED,
    scale: { lanes: LANES, rounds: ROUNDS },
    inputs,
    resultHistogram: histogram(
      rows.map((r) => `${r.op}:${r.result}${r.sqlState ? `/${r.sqlState}` : ""}`),
    ),
    lanesOverlappingAnotherLane: overlapCount(rows),
    invariants,
    observations,
    rows,
    durationMs: Math.round(performance.now() - t0),
    replay: replay(label),
  };
  reports.push(report);
  const dir = outDir();
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}delete_request_pg.json`,
    JSON.stringify(
      {
        meta: {
          file: "stress_pg_delete_request_concurrency.test.ts",
          seed: STRESS_SEED,
          lanes: LANES,
          rounds: ROUNDS,
          iterations: reports.reduce((n, r) => n + r.scale.rounds, 0),
        },
        scenarios: reports,
      },
      null,
      2,
    ),
  );
  console.log(
    `[stress-pg] ${name}: ${report.durationMs}ms overlap=${report.lanesOverlappingAnotherLane}/${rows.length} ${JSON.stringify(
      report.resultHistogram,
    )}`,
  );
  for (const i of invariants)
    if (!i.holds) console.error(`[stress-pg]   BROKEN ${i.name} — ${i.detail}`);
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPG1 — N concurrent upserts, same user, distinct challenges
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress SPG1: delete-request upsert ×N concurrent transactions — every lane commits, ONE row, last committed challenge wins, no 23505/40P01",
  ignore,
  async fn() {
    const report = await scenario(
      "spg1_same_user_upsert",
      "stress SPG1",
      async (sql, prng, rows, invariants, inputs) => {
        const users: string[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid);
          const challenges = Array.from({ length: LANES }, () => prng.uuid());
          const nowMs = Date.now();
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx, lane) => upsertRequest(tx, uid, challenges[lane], nowMs + lane),
            r,
          );
          rows.push(...out);
          const stored = await requestRows(sql, uid);
          const h = histogram(out.map((x) => `${x.result}${x.sqlState ? `/${x.sqlState}` : ""}`));
          inv(
            invariants,
            `round ${r}: every lane committed (no 23505 duplicate key, no 40P01 deadlock, no 42501 grant gap)`,
            out.every((x) => x.result === "ok"),
            JSON.stringify(h),
          );
          inv(
            invariants,
            `round ${r}: exactly one row for the user`,
            stored.length === 1,
            `rows=${stored.length}`,
          );
          const winner = challenges.find((c) => c === String(stored[0]?.challenge));
          inv(
            invariants,
            `round ${r}: stored challenge is one lane's payload, not a mix`,
            winner !== undefined &&
              Number(stored[0].expires_ms) - Number(stored[0].created_ms) === TTL_MS,
            `stored=${String(stored[0]?.challenge)} ttl=${Number(stored[0]?.expires_ms) - Number(stored[0]?.created_ms)}ms`,
          );
          // Last writer wins: the winner is the lane whose UPDATE committed last,
          // so its created_at is the newest payload timestamp among the lanes
          // that ran — never an older one resurrected over a newer write.
          const winnerIdx = challenges.indexOf(String(stored[0]?.challenge));
          inv(
            invariants,
            `round ${r}: no lost update (stored created_at is that lane's own payload)`,
            winnerIdx >= 0 && Number(stored[0].created_ms) === nowMs + winnerIdx,
            `winnerLane=${winnerIdx} created_ms=${Number(stored[0]?.created_ms)} expected=${nowMs + winnerIdx}`,
          );
        }
        inputs.users = users;
      },
    );
    inv(
      report.invariants,
      "lanes genuinely overlapped",
      report.lanesOverlappingAnotherLane > 0,
      `${report.lanesOverlappingAnotherLane}/${report.rows.length}`,
    );
    for (const i of report.invariants) assert(i.holds, `${i.name}: ${i.detail}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SPG2 — two actors, one row: half the lanes target ANOTHER user's id
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress SPG2: half the lanes upsert a FOREIGN user_id — RLS refuses every one (42501), the victim's row is untouched",
  ignore,
  async fn() {
    const report = await scenario(
      "spg2_foreign_user_id",
      "stress SPG2",
      async (sql, prng, rows, invariants, inputs, obs) => {
        const pairs: Array<[string, string]> = [];
        for (let r = 0; r < ROUNDS; r++) {
          const victim = prng.uuid();
          const attacker = prng.uuid();
          pairs.push([victim, attacker]);
          await createUser(sql, victim);
          await createUser(sql, attacker);
          const victimChallenge = prng.uuid();
          const nowMs = Date.now();
          await sql.begin(async (tx) => {
            await asUser(tx as unknown as Tx, victim);
            const out = await upsertRequest(tx as unknown as Tx, victim, victimChallenge, nowMs);
            assert(out.result === "ok", `victim setup upsert failed: ${out.sqlState}`);
          });
          const forged = Array.from({ length: LANES }, () => prng.uuid());
          const out = await burst(
            sql,
            LANES,
            (lane) => (lane % 2 === 0 ? attacker : victim),
            // Every lane writes the VICTIM's user_id; the even lanes do it under
            // the attacker's JWT, so only RLS stands between them and the row.
            (tx, lane) => upsertRequest(tx, victim, forged[lane], nowMs + 1_000 + lane),
            r,
          );
          rows.push(...out);
          const attackerLanes = out.filter((x) => x.lane % 2 === 0);
          const victimLanes = out.filter((x) => x.lane % 2 === 1);
          inv(
            invariants,
            `round ${r}: every foreign-id lane refused with 42501`,
            attackerLanes.every(
              (x) => x.result !== "ok" && (x.sqlState === "42501" || x.result === "tx_aborted"),
            ),
            JSON.stringify(histogram(attackerLanes.map((x) => `${x.result}/${x.sqlState ?? ""}`))),
          );
          inv(
            invariants,
            `round ${r}: the owner's own lanes still commit`,
            victimLanes.every((x) => x.result === "ok"),
            JSON.stringify(histogram(victimLanes.map((x) => `${x.result}/${x.sqlState ?? ""}`))),
          );
          const stored = await requestRows(sql, victim);
          const attackerRows = await requestRows(sql, attacker);
          const forgedByAttacker = new Set(attackerLanes.map((x) => x.challenge));
          inv(
            invariants,
            `round ${r}: one victim row, never an attacker-minted challenge; attacker has no row`,
            stored.length === 1 &&
              !forgedByAttacker.has(String(stored[0].challenge)) &&
              attackerRows.length === 0,
            `victimRows=${stored.length} stored=${String(stored[0]?.challenge)} attackerRows=${attackerRows.length}`,
          );
          obs.storedChallengeWasOwnersOwn = victimLanes.some(
            (x) => x.challenge === String(stored[0]?.challenge),
          );
        }
        inputs.pairs = pairs;
      },
    );
    for (const i of report.invariants) assert(i.holds, `${i.name}: ${i.detail}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SPG3 — upsert racing the account cascade (delete-confirm on another device)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress SPG3: upserts racing the auth.users cascade — each lane either commits before the cascade or fails 23503; ZERO orphan rows survive",
  ignore,
  async fn() {
    const report = await scenario(
      "spg3_upsert_vs_cascade",
      "stress SPG3",
      async (sql, prng, rows, invariants, inputs, obs) => {
        const users: string[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid);
          const challenges = Array.from({ length: LANES }, () => prng.uuid());
          const nowMs = Date.now();
          // The service role's Auth admin deleteUser, as the DB sees it, fired a
          // seeded number of ms AFTER the barrier opens so the cascade lands
          // somewhere inside the burst instead of always winning the race.
          const delayMs = prng.int(0, 12);
          let cascade: Promise<unknown> = Promise.resolve();
          const out = await burst(
            sql,
            LANES,
            () => uid,
            (tx, lane) => upsertRequest(tx, uid, challenges[lane], nowMs + lane),
            r,
            () => {
              cascade = new Promise((resolve) =>
                setTimeout(
                  () => resolve(sql.unsafe(`delete from auth.users where id = '${uid}'`)),
                  delayMs,
                ),
              );
            },
          );
          await cascade;
          rows.push(...out);
          const stored = await requestRows(sql, uid);
          const profiles = await sql.unsafe(
            `select count(*)::int as n from public.profiles where id = '${uid}'`,
          );
          const codes = histogram(out.map((x) => `${x.result}/${x.sqlState ?? ""}`));
          inv(
            invariants,
            `round ${r}: every lane either committed or failed with an FK/RLS refusal — never a duplicate key or deadlock`,
            out.every(
              (x) =>
                x.result === "ok" ||
                ["23503", "42501", "40001", "55P03", ""].includes(x.sqlState ?? ""),
            ),
            JSON.stringify(codes),
          );
          inv(
            invariants,
            `round ${r}: no orphan deletion request survives the cascade`,
            Number(profiles[0].n) === 0 ? stored.length === 0 : stored.length <= 1,
            `profiles=${Number(profiles[0].n)} rows=${stored.length}`,
          );
          obs[`round${r}Codes`] = codes;
          obs[`round${r}CascadeDelayMs`] = delayMs;
        }
        inputs.users = users;
      },
    );
    for (const i of report.invariants) assert(i.holds, `${i.name}: ${i.detail}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// SPG4 — concurrent exit-survey inserts (insert-only feedback table)
// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name: "stress SPG4: N concurrent account_deletion_feedback inserts — N rows, no update/delete allowed, DB caps hold above the edge's 500-char cap",
  ignore,
  async fn() {
    const report = await scenario(
      "spg4_feedback_inserts",
      "stress SPG4",
      async (sql, prng, rows, invariants, inputs, obs) => {
        const users: string[] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const uid = prng.uuid();
          users.push(uid);
          await createUser(sql, uid);
          const out = await burst(
            sql,
            LANES,
            () => uid,
            async (tx, _lane) => {
              const t0 = await serverNowMs(tx);
              try {
                await tx.unsafe(
                  `insert into public.account_deletion_feedback
                   (user_id, reason, wanted, details, provider, platform, app_version, account_age_days, scored_count)
                 values ($1::uuid, $2, $3, $4, 'google', 'ios', '1.0.0', 3, 1)`,
                  [uid, "not_using", "price", "x".repeat(500)],
                );
                return {
                  op: "feedback.insert",
                  result: "ok",
                  serverStartMs: t0,
                  serverEndMs: await serverNowMs(tx),
                };
              } catch (error) {
                return {
                  op: "feedback.insert",
                  result: "error",
                  sqlState: sqlStateOf(error),
                  serverStartMs: t0,
                  serverEndMs: Date.now(),
                };
              }
            },
            r,
          );
          rows.push(...out);
          const count = await sql.unsafe(
            `select count(*)::int as n from public.account_deletion_feedback where user_id = '${uid}'`,
          );
          inv(
            invariants,
            `round ${r}: all ${LANES} concurrent inserts committed, ${LANES} rows`,
            out.every((x) => x.result === "ok") && Number(count[0].n) === LANES,
            `${JSON.stringify(histogram(out.map((x) => `${x.result}/${x.sqlState ?? ""}`)))} rows=${Number(count[0].n)}`,
          );
          // The table is append-only for clients, and its length caps sit ABOVE
          // the edge's sanitizer caps (500 details / 64 app_version) — a survey
          // the route accepted can never be refused by the DB.
          const denied: string[] = [];
          for (const stmt of [
            `update public.account_deletion_feedback set reason = 'privacy' where user_id = '${uid}'`,
            `delete from public.account_deletion_feedback where user_id = '${uid}'`,
          ]) {
            try {
              await sql.begin(async (tx) => {
                await asUser(tx as unknown as Tx, uid);
                await (tx as unknown as Tx).unsafe(stmt);
              });
              denied.push(`ALLOWED: ${stmt.split(" ")[0]}`);
            } catch (error) {
              denied.push(`${stmt.split(" ")[0]}=${sqlStateOf(error) || "refused"}`);
            }
          }
          const stillThere = await sql.unsafe(
            `select count(*)::int as n from public.account_deletion_feedback where user_id = '${uid}'`,
          );
          inv(
            invariants,
            `round ${r}: insert-only for the owner (update/delete refused, rows intact)`,
            !denied.some((d) => d.startsWith("ALLOWED")) && Number(stillThere[0].n) === LANES,
            `${denied.join(" ")} rows=${Number(stillThere[0].n)}`,
          );
          let overLongRefused = "";
          try {
            await sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, uid);
              await (tx as unknown as Tx).unsafe(
                `insert into public.account_deletion_feedback (user_id, reason, details)
               values ($1::uuid, 'other', $2)`,
                [uid, "y".repeat(1_001)],
              );
            });
            overLongRefused = "ALLOWED";
          } catch (error) {
            overLongRefused = sqlStateOf(error) || "refused";
          }
          inv(
            invariants,
            `round ${r}: DB caps details at 1000 chars (above the edge's 500) — 23514`,
            overLongRefused === "23514",
            `1001-char details → ${overLongRefused}`,
          );
          obs[`round${r}Denials`] = denied;
        }
        inputs.users = users;
      },
    );
    for (const i of report.invariants) assert(i.holds, `${i.name}: ${i.detail}`);
  },
});
