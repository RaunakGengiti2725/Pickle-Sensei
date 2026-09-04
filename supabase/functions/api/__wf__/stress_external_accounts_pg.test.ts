/**
 * Stress · externalAccounts cleanup · lens = concurrency · REAL Postgres half.
 *
 * The route campaign (stress_external_accounts_routes.test.ts) proves the
 * handler's behaviour over a modelled PostgREST. This file replays the exact
 * statements the route issues on `public.account_external_credentials` —
 * the deletion checkpoint UPDATE, the RevenueCat checkpoint UPSERT, the
 * bootstrap UPSERT — plus the `auth.users` DELETE that auth.admin.deleteUser
 * performs, on a disposable postgres:16 with shim_auth.sql + every migration
 * (./xc_pg_up.sh), from N INDEPENDENT reserved connections released from a
 * barrier:
 *
 *   PG1 duplicate delete-confirm (autocommit, as PostgREST issues them): one
 *       lane deletes auth.users, the others run the route's checkpoint
 *       UPDATE + UPSERT after a seeded provider-latency delay. Every writer
 *       lands before the cascade (row then cascades) or fails with 23503 —
 *       the DB truth behind EA-1; a writer that provably runs after the
 *       cascade ALWAYS gets 23503. Never a deadlock, never a duplicate row,
 *       never an orphan row.
 *   PG2 delete-confirm racing bootstrap upserts (EA-2 at the DB layer): the
 *       blind `set apple_revoked_at = now()` lands on whichever ciphertext
 *       is in the row at that instant. Records how often a NEVER-revoked
 *       token is marked revoked (lost update) before the cascade destroys it.
 *   PG3 N concurrent RevenueCat checkpoint UPSERTs for a user with no row:
 *       exactly one row, no 23505, no deadlock, every lane commits.
 *   PG4 transaction-wrapped writers holding the credential row while the
 *       auth.users cascade arrives (NOT a production path — PostgREST
 *       autocommits — but the schema's deadlock exposure): bounded by the
 *       deadlock detector, the state stays consistent (all gone or all
 *       present), and the victim side is recorded.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json stress_external_accounts_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is UNKNOWN, not
 * a pass. Seeded: STRESS_SEED drives every id; STRESS_ITER rounds,
 * STRESS_BURST lanes.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import type { Invariant } from "./xc_concurrency_harness.ts";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  assertCampaign,
  campaign,
  type KnownBroken,
  STRESS_BURST,
  STRESS_ITER,
} from "./stress_external_accounts_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const FILE = "stress_external_accounts_pg.test.ts";
const inv = (name: string, holds: boolean, detail: string): Invariant => ({ name, holds, detail });

/** EA-1 (DB truth): a checkpoint writer that outlives the auth.users cascade
 * gets 23503; the route turns that into a 503 for a deleted account. */
const EA1: KnownBroken = { no_writer_fails_after_cascade: "EA-1" };
/** EA-2 (DB truth): the deletion's blind revoked-mark lands on a ciphertext
 * it never revoked when a bootstrap upsert interleaves. */
const EA2: KnownBroken = { revoked_mark_only_on_revoked_token: "EA-2" };

type Sql = ReturnType<typeof postgres>;
type Reserved = Awaited<ReturnType<Sql["reserve"]>>;

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

interface Lane {
  lane: number;
  op: string;
  /** "ok" | sqlstate */
  result: string;
  rows: number;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

const pgCode = (e: unknown): string =>
  e && typeof e === "object" && "code" in e
    ? String((e as { code: unknown }).code)
    : `throw:${String(e)}`;

async function serverNowMs(c: Reserved): Promise<number> {
  const r = await c.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** Run one autocommit statement per lane on its own reserved connection,
 * all released from the barrier. Mirrors PostgREST: no transaction wrapper. */
async function burst(
  sql: Sql,
  lanes: Array<{ op: string; delayMs?: number; run: (c: Reserved) => Promise<number> }>,
): Promise<Lane[]> {
  const b = barrier();
  const conns = await Promise.all(lanes.map(() => sql.reserve()));
  try {
    // Each lane runs synchronously up to `await b.gate`, so by the time the
    // array is built every lane is parked on the barrier with its own
    // connection already reserved.
    const pending = lanes.map(async (l, lane) => {
      const c = conns[lane];
      await b.gate;
      // Seeded "provider latency" between reading the row and writing: the
      // scheduler that decides who lands before the cascade.
      if (l.delayMs) await c.unsafe(`select pg_sleep(${l.delayMs / 1000})`);
      const t0 = performance.now();
      const s = await serverNowMs(c);
      let result = "ok";
      let n = 0;
      try {
        n = await l.run(c);
      } catch (e) {
        result = pgCode(e);
      }
      const e = await serverNowMs(c);
      return {
        lane,
        op: l.op,
        result,
        rows: n,
        serverStartMs: s,
        serverEndMs: e,
        clientMs: Math.round((performance.now() - t0) * 100) / 100,
      };
    });
    b.open();
    return await Promise.all(pending);
  } finally {
    for (const c of conns) c.release();
  }
}

/** Seeded ids repeat across runs against the same disposable DB. */
async function freshUser(sql: Sql, userId: string, provider: "apple" | "google"): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"${provider}"}')`,
  );
}

const cipher = (tag: string) => `v1.${"a".repeat(16)}.${tag.padEnd(40, "x")}`;

/** Run one route statement on its own connection (setup only). */
async function once(sql: Sql, run: (c: Reserved) => Promise<number>): Promise<number> {
  const c = await sql.reserve();
  try {
    return await run(c);
  } finally {
    c.release();
  }
}

async function credentialRows(sql: Sql, userId: string) {
  return await sql.unsafe(
    `select user_id::text, apple_refresh_token_encrypted as tok, apple_revoked_at, revenuecat_deleted_at from public.account_external_credentials where user_id = '${userId}'`,
  );
}

async function userState(sql: Sql, userId: string) {
  const r = await sql.unsafe(
    `select (select count(*) from auth.users where id = '${userId}')::int as users,
            (select count(*) from public.profiles where id = '${userId}')::int as profiles,
            (select count(*) from public.account_external_credentials where user_id = '${userId}')::int as creds,
            (select count(*) from public.account_deletion_requests where user_id = '${userId}')::int as challenges`,
  );
  return {
    users: Number(r[0].users),
    profiles: Number(r[0].profiles),
    creds: Number(r[0].creds),
    challenges: Number(r[0].challenges),
  };
}

// The three statements the route issues, as PostgREST would (autocommit).
const revokeMark = (userId: string) => async (c: Reserved) =>
  (
    await c.unsafe(
      `update public.account_external_credentials set apple_revoked_at = now(), updated_at = now() where user_id = '${userId}'`,
    )
  ).count;
const rcCheckpoint = (userId: string) => async (c: Reserved) =>
  (
    await c.unsafe(
      `insert into public.account_external_credentials (user_id, revenuecat_deleted_at, updated_at) values ('${userId}', now(), now())
     on conflict (user_id) do update set revenuecat_deleted_at = excluded.revenuecat_deleted_at, updated_at = excluded.updated_at`,
    )
  ).count;
const bootstrapUpsert = (userId: string, tok: string) => async (c: Reserved) =>
  (
    await c.unsafe(
      `insert into public.account_external_credentials (user_id, apple_refresh_token_encrypted, apple_token_captured_at, apple_revoked_at, updated_at)
     values ('${userId}', '${tok}', now(), null, now())
     on conflict (user_id) do update set apple_refresh_token_encrypted = excluded.apple_refresh_token_encrypted,
       apple_token_captured_at = excluded.apple_token_captured_at, apple_revoked_at = excluded.apple_revoked_at, updated_at = excluded.updated_at`,
    )
  ).count;
const adminDelete = (userId: string) => async (c: Reserved) =>
  (await c.unsafe(`delete from auth.users where id = '${userId}'`)).count;

const BOUND_MS = 10_000;

Deno.test({
  name: `stress-PG1 auth.users DELETE racing ${STRESS_BURST} delete-confirm checkpoint writers (autocommit) — cascade wins, writers ok-or-23503, no deadlock, no orphan`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: STRESS_BURST + 4, onnotice: () => {} });
    try {
      await sql.unsafe(`select 1`);
      const report = await campaign(
        "stress-PG1-delete-vs-checkpoint-writers",
        "duplicate delivery (DB truth)",
        FILE,
        { burst: STRESS_BURST + 1 },
        STRESS_ITER,
        async (seed) => {
          const prng = new Prng(seed);
          const userId = prng.uuid();
          await freshUser(sql, userId, "apple");
          await once(sql, bootstrapUpsert(userId, cipher(`t1.${seed}`)));
          await sql.unsafe(
            `insert into public.account_deletion_requests (user_id) values ('${userId}') on conflict (user_id) do nothing`,
          );
          const deleteLane = prng.int(0, STRESS_BURST);
          const lanes = Array.from({ length: STRESS_BURST + 1 }, (_, lane) => {
            if (lane === deleteLane) return { op: "auth.users delete", run: adminDelete(userId) };
            const ms = prng.int(0, 12);
            return prng.int(0, 1) === 0
              ? { op: `revoke-mark update +${ms}ms`, delayMs: ms, run: revokeMark(userId) }
              : { op: `rc-checkpoint upsert +${ms}ms`, delayMs: ms, run: rcCheckpoint(userId) };
          });
          const rows = await burst(sql, lanes);
          const after = await userState(sql, userId);
          const del = rows[deleteLane];
          const writers = rows.filter((_, i) => i !== deleteLane);
          const codes = writers.map((w) => w.result);
          // Writers whose statement STARTED after the delete COMMITTED (server
          // clock) are the route's "lost the race" lanes.
          const late = writers.filter((w) => w.serverStartMs > del.serverEndMs);
          const lateUpserts = late.filter((w) => w.op.startsWith("rc-checkpoint"));
          const lateUpdates = late.filter((w) => w.op.startsWith("revoke-mark"));
          // Deterministic proof of the mechanism, independent of the race.
          let sequential = "";
          try {
            await once(sql, rcCheckpoint(userId));
            sequential = "ok";
          } catch (e) {
            sequential = pgCode(e);
          }
          const invs: Invariant[] = [
            inv(
              "cascade_deleted_everything",
              del.result === "ok" &&
                del.rows === 1 &&
                after.users === 0 &&
                after.profiles === 0 &&
                after.creds === 0 &&
                after.challenges === 0,
              JSON.stringify(after),
            ),
            inv(
              "writers_ok_or_23503",
              codes.every((c) => c === "ok" || c === "23503"),
              codes.join(","),
            ),
            inv(
              "no_deadlock_no_unique_violation",
              codes.every((c) => c !== "40P01" && c !== "23505"),
              codes.join(","),
            ),
            inv(
              "late_upsert_is_23503",
              lateUpserts.every((w) => w.result === "23503"),
              lateUpserts.map((w) => w.result).join(","),
            ),
            inv(
              "late_update_is_0_rows",
              lateUpdates.every((w) => w.result === "ok" && w.rows === 0),
              lateUpdates.map((w) => `${w.result}/${w.rows}`).join(","),
            ),
            inv(
              "upsert_after_cascade_is_23503",
              sequential === "23503",
              `sequential upsert after cascade → ${sequential}`,
            ),
            inv(
              "no_writer_fails_after_cascade",
              codes.every((c) => c === "ok"),
              `23503×${codes.filter((c) => c === "23503").length} of ${codes.length} writers (${late.length} started after the delete committed)`,
            ),
            inv(
              "bounded_wall_time",
              rows.every((r) => r.clientMs < BOUND_MS),
              `max=${Math.max(...rows.map((r) => r.clientMs))}ms`,
            ),
          ];
          return {
            invariants: invs,
            statuses: rows.map((r) => r.result),
            detail: {
              lanes: rows.map((r) => `${r.op}:${r.result}/${r.rows}`),
              lateWriters: late.length,
              sequentialUpsertAfterCascade: sequential,
            },
          };
        },
        { knownBroken: EA1 },
      );
      assertCampaign(report, EA1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress-PG2 revoke-mark UPDATE racing ${STRESS_BURST} bootstrap UPSERTs then cascade — one row, pair constraint holds; counts revoked-mark on never-revoked token`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: STRESS_BURST + 4, onnotice: () => {} });
    try {
      await sql.unsafe(`select 1`);
      const report = await campaign(
        "stress-PG2-revoke-mark-vs-bootstrap",
        "two actors on one row (DB truth)",
        FILE,
        { burst: STRESS_BURST + 1 },
        STRESS_ITER,
        async (seed) => {
          const prng = new Prng(seed);
          const userId = prng.uuid();
          await freshUser(sql, userId, "apple");
          const t1 = cipher(`t1.${seed}`);
          await once(sql, bootstrapUpsert(userId, t1));
          const markLane = prng.int(0, STRESS_BURST);
          const tokens = Array.from({ length: STRESS_BURST + 1 }, (_, i) =>
            cipher(`t${i + 2}.${seed}`),
          );
          const lanes = Array.from({ length: STRESS_BURST + 1 }, (_, lane) =>
            lane === markLane
              ? { op: "revoke-mark update (revoked t1)", run: revokeMark(userId) }
              : {
                  op: `bootstrap upsert ${tokens[lane].slice(20, 26)}`,
                  run: bootstrapUpsert(userId, tokens[lane]),
                },
          );
          const rows = await burst(sql, lanes);
          const after = await credentialRows(sql, userId);
          const row = after[0];
          const markedTok = row ? String(row.tok) : "";
          const markedRevoked = row ? row.apple_revoked_at !== null : false;
          // Then the deletion completes: the row (and whatever token it holds) is gone.
          await once(sql, adminDelete(userId));
          const state = await userState(sql, userId);
          const invs: Invariant[] = [
            inv(
              "all_lanes_commit",
              rows.every((r) => r.result === "ok" && r.rows === 1),
              rows.map((r) => `${r.op}:${r.result}`).join(","),
            ),
            inv("exactly_one_row", after.length === 1, `rows=${after.length}`),
            inv(
              "row_holds_a_token",
              row !== undefined && row.tok !== null,
              `tok=${markedTok.slice(20, 26)}`,
            ),
            inv(
              "revoked_mark_only_on_revoked_token",
              !markedRevoked || markedTok === t1,
              `revoked_at set=${markedRevoked} on token=${markedTok.slice(20, 26)} (revoked token was t1)`,
            ),
            inv(
              "cascade_destroys_row",
              state.creds === 0 && state.profiles === 0,
              JSON.stringify(state),
            ),
            inv(
              "bounded_wall_time",
              rows.every((r) => r.clientMs < BOUND_MS),
              `max=${Math.max(...rows.map((r) => r.clientMs))}ms`,
            ),
          ];
          return {
            invariants: invs,
            statuses: rows.map((r) => r.result),
            detail: {
              finalToken: markedTok.slice(20, 26),
              finalRevoked: markedRevoked,
              order: rows
                .slice()
                .sort((a, b) => a.serverEndMs - b.serverEndMs)
                .map((r) => r.op),
            },
          };
        },
        { knownBroken: EA2 },
      );
      assertCampaign(report);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress-PG3 ${STRESS_BURST} concurrent RevenueCat checkpoint UPSERTs, no prior row — one row, no 23505, no deadlock`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: STRESS_BURST + 4, onnotice: () => {} });
    try {
      await sql.unsafe(`select 1`);
      const report = await campaign(
        "stress-PG3-checkpoint-upsert-idempotent",
        "duplicate delivery / idempotency (DB truth)",
        FILE,
        { burst: STRESS_BURST },
        STRESS_ITER,
        async (seed) => {
          const prng = new Prng(seed);
          const userId = prng.uuid();
          await freshUser(sql, userId, "google");
          const rows = await burst(
            sql,
            Array.from({ length: STRESS_BURST }, () => ({
              op: "rc-checkpoint upsert",
              run: rcCheckpoint(userId),
            })),
          );
          const after = await credentialRows(sql, userId);
          const invs: Invariant[] = [
            inv(
              "all_lanes_commit",
              rows.every((r) => r.result === "ok" && r.rows === 1),
              rows.map((r) => r.result).join(","),
            ),
            inv(
              "exactly_one_row",
              after.length === 1 && after[0].revenuecat_deleted_at !== null,
              `rows=${after.length}`,
            ),
            inv(
              "no_deadlock_no_unique_violation",
              rows.every((r) => r.result !== "40P01" && r.result !== "23505"),
              "",
            ),
            inv(
              "bounded_wall_time",
              rows.every((r) => r.clientMs < BOUND_MS),
              `max=${Math.max(...rows.map((r) => r.clientMs))}ms`,
            ),
          ];
          await sql.unsafe(`delete from auth.users where id = '${userId}'`);
          return { invariants: invs, statuses: rows.map((r) => r.result) };
        },
      );
      assertCampaign(report);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress-PG4 transaction-wrapped writers holding the row while auth.users DELETE arrives — bounded by the deadlock detector, state consistent either way`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: STRESS_BURST + 4, onnotice: () => {} });
    try {
      await sql.unsafe(`select 1`);
      const report = await campaign(
        "stress-PG4-tx-writers-vs-cascade",
        "transaction concurrency / deadlock (DB truth)",
        FILE,
        { burst: STRESS_BURST + 1 },
        Math.min(STRESS_ITER, 8),
        async (seed) => {
          const prng = new Prng(seed);
          const userId = prng.uuid();
          await freshUser(sql, userId, "apple");
          await once(sql, bootstrapUpsert(userId, cipher(`t1.${seed}`)));
          const holdMs = prng.int(5, 40);
          const deleteLane = prng.int(0, STRESS_BURST);
          // Writers: BEGIN; revoke-mark UPDATE (row lock held); sleep; RC upsert; COMMIT.
          const lanes = Array.from({ length: STRESS_BURST + 1 }, (_, lane) =>
            lane === deleteLane
              ? { op: "auth.users delete", run: adminDelete(userId) }
              : {
                  op: "tx: update, hold, upsert, commit",
                  run: async (c: Reserved) => {
                    await c.unsafe(`begin`);
                    try {
                      await revokeMark(userId)(c);
                      await c.unsafe(`select pg_sleep(${holdMs / 1000})`);
                      const n = await rcCheckpoint(userId)(c);
                      await c.unsafe(`commit`);
                      return n;
                    } catch (e) {
                      await c.unsafe(`rollback`).catch(() => {});
                      throw e;
                    }
                  },
                },
          );
          const rows = await burst(sql, lanes);
          const after = await userState(sql, userId);
          const codes = rows.map((r) => r.result);
          const del = rows[deleteLane];
          const allGone = after.users === 0 && after.creds === 0 && after.profiles === 0;
          const allPresent = after.users === 1 && after.creds === 1 && after.profiles === 1;
          const invs: Invariant[] = [
            inv(
              "state_consistent",
              (del.result === "ok" && allGone) || (del.result === "40P01" && allPresent),
              `delete=${del.result} after=${JSON.stringify(after)}`,
            ),
            inv(
              "writers_ok_23503_or_deadlock_victim",
              rows
                .filter((_, i) => i !== deleteLane)
                .every((r) => r.result === "ok" || r.result === "23503" || r.result === "40P01"),
              codes.join(","),
            ),
            inv(
              "only_deadlock_can_fail_the_delete",
              del.result === "ok" || del.result === "40P01",
              del.result,
            ),
            inv(
              "bounded_wall_time",
              rows.every((r) => r.clientMs < BOUND_MS),
              `max=${Math.max(...rows.map((r) => r.clientMs))}ms`,
            ),
          ];
          // Clean up whichever side survived.
          await sql.unsafe(`delete from auth.users where id = '${userId}'`);
          return {
            invariants: invs,
            statuses: codes,
            detail: {
              holdMs,
              deleteVictim: del.result === "40P01",
              deadlocks: codes.filter((c) => c === "40P01").length,
              fk: codes.filter((c) => c === "23503").length,
            },
          };
        },
      );
      assertCampaign(report);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress-PG sanity: schema present (account_external_credentials FK → profiles ON DELETE CASCADE, pair constraint)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2, onnotice: () => {} });
    try {
      const fk = await sql.unsafe(
        `select confdeltype from pg_constraint where conname = 'account_external_credentials_user_id_fkey'`,
      );
      assert(fk.length === 1 && fk[0].confdeltype === "c", `FK cascade: ${JSON.stringify(fk)}`);
      const pair = await sql.unsafe(
        `select 1 from pg_constraint where conname = 'account_external_credentials_apple_capture_pair'`,
      );
      assert(pair.length === 1, "pair constraint present");
    } finally {
      await sql.end();
    }
  },
});
