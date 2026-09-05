/**
 * STRESS — POST /webhooks/revenuecat against a REAL Postgres.
 *
 * The in-memory campaign (stress_webhook_failure_load.test.ts) models
 * PostgREST. This file swaps that model for the real schema: the harness's
 * `PgBridge` translates the route's two PostgREST calls (the
 * `webhook_events` idempotency lookup and the `billing_entitlements` /
 * `webhook_events` upserts) into SQL executed as `service_role` on a
 * docker postgres:16 with EVERY migration applied — so the FK to profiles,
 * the PK-backed duplicate detection, `ON CONFLICT` semantics and the pg_cron
 * retention sweep are the database's, not a fake's. RevenueCat and Upstash
 * stay stubbed.
 *
 *   docker run -d --name pickle-stress-pg -e POSTGRES_PASSWORD=pg -p 55444:5432 postgres:16
 *   # apply supabase/tests/shim_auth.sql then every supabase/migrations/*.sql in order
 *   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55444/postgres \
 *     deno test -A --no-check --config deno.json stress_webhook_pg_idempotency.test.ts
 *
 * Without STRESS_PG_URL (alias: XC_PG_URL) every test is `ignore`d — an ignored
 * run is NOT a pass.
 *
 * Knobs: STRESS_SEED (default 20260905), STRESS_PG_EVENTS (events per test,
 * default 25), STRESS_PG_LANES (concurrent duplicate deliveries, default 16),
 * STRESS_OUT_DIR (JSON tables; default artifacts/stress-webhook-revenuecat/latest/).
 */

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  envInt,
  fnv1a,
  lapsedSubscriber,
  loadWorld,
  type PgBridge,
  Prng,
  run,
  webhookRequest,
  type World,
  writeJson,
} from "./stress_webhook_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ?? "";
const ignore = PG_URL === "";
const BASE_SEED = envInt("STRESS_SEED", 20260905);
const EVENTS = Math.max(1, envInt("STRESS_PG_EVENTS", 25));
const LANES = Math.max(2, envInt("STRESS_PG_LANES", 16));

type Sql = ReturnType<typeof postgres>;

const TABLES: Record<string, readonly string[]> = {
  webhook_events: ["id", "provider", "event_type", "app_user_id", "payload", "received_at"],
  billing_entitlements: ["user_id", "premium", "product_key", "expires_at", "verified_at"],
};

/** Every statement runs as `service_role` (the key the route holds), so the
 * grants + bypassrls the migrations give that role are what's exercised. */
function bridge(sql: Sql): PgBridge & { sqlCalls: number } {
  const ident = (name: string, allowed: readonly string[]) => {
    if (!allowed.includes(name)) throw new Error(`unexpected identifier ${name}`);
    return `"${name}"`;
  };
  const state = {
    sqlCalls: 0,
    async select(table: string, column: string, value: string, selectCols: string) {
      state.sqlCalls += 1;
      const cols = TABLES[table];
      if (!cols) throw new Error(`unexpected table ${table}`);
      const projection =
        selectCols === "*"
          ? "*"
          : selectCols
              .split(",")
              .map((c) => ident(c.trim(), cols))
              .join(", ");
      return (await sql.begin(async (tx) => {
        await tx.unsafe("set local role service_role");
        return await tx.unsafe(
          `select ${projection} from public.${ident(table, Object.keys(TABLES))} where ${ident(column, cols)} = $1`,
          [value],
        );
      })) as unknown[];
    },
    async upsert(
      table: string,
      row: Record<string, unknown>,
      onConflict: string,
      ignoreDuplicates: boolean,
    ) {
      state.sqlCalls += 1;
      const cols = TABLES[table];
      if (!cols) throw new Error(`unexpected table ${table}`);
      const keys = Object.keys(row).map((k) => ident(k, cols));
      const values = Object.keys(row).map((k) => {
        const v = row[k];
        return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
      });
      const params = keys.map((_, i) => `$${i + 1}`).join(", ");
      const conflict = onConflict
        .split(",")
        .map((c) => ident(c.trim(), cols))
        .join(", ");
      const update = ignoreDuplicates
        ? "do nothing"
        : `do update set ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}`;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("set local role service_role");
          await tx.unsafe(
            `insert into public.${ident(table, Object.keys(TABLES))} (${keys.join(", ")}) values (${params}) on conflict (${conflict}) ${update}`,
            values as never[],
          );
        });
        return null;
      } catch (error) {
        const e = error as { code?: string; message?: string };
        return { code: e.code ?? "XX000", message: e.message ?? String(error) };
      }
    },
  };
  return state;
}

async function createUser(sql: Sql, userId: string) {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"apple"}')`,
  );
  const profile = await sql.unsafe(`select id from public.profiles where id = '${userId}'`);
  assertEquals(profile.length, 1, "on_auth_user_created must create the profile row");
}

async function entitlement(sql: Sql, userId: string) {
  const rows = await sql.unsafe(
    `select user_id, premium, product_key, expires_at, verified_at from public.billing_entitlements where user_id = '${userId}'`,
  );
  return rows.length === 1 ? (rows[0] as Record<string, unknown>) : null;
}

async function countRows(sql: Sql, query: string): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(query);
  return Number(rows[0].n);
}

function auditRows(sql: Sql, eventId: string): Promise<number> {
  return countRows(
    sql,
    `select count(*)::int as n from public.webhook_events where id = '${eventId}'`,
  );
}

async function withPg(fn: (sql: Sql, w: World, pg: ReturnType<typeof bridge>) => Promise<void>) {
  const sql = postgres(PG_URL, { max: LANES + 2, onnotice: () => {} });
  const w = await loadWorld();
  const pg = bridge(sql);
  w.pg = pg;
  try {
    // Seeds are deterministic, so audit rows from an earlier run of this suite
    // against the same database would make every first delivery a duplicate.
    await sql.unsafe(`delete from public.webhook_events where id ~ '^pg[1-6]-'`);
    await fn(sql, w, pg);
  } finally {
    w.pg = null;
    w.reset();
    await sql.end({ timeout: 5 });
  }
}

const replayCmd = (filter: string) =>
  `STRESS_PG_URL=<docker postgres:16> STRESS_SEED=${BASE_SEED} STRESS_PG_EVENTS=${EVENTS} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json stress_webhook_pg_idempotency.test.ts --filter "${filter}"`;

Deno.test({
  name: `stress webhook/pg — PG1 ${EVENTS} seeded deliveries + exact replay: real rows, real duplicate detection`,
  ignore,
  async fn() {
    await withPg(async (sql, w, pg) => {
      const rng = new Prng(fnv1a(`pg1:${BASE_SEED}`));
      const rows: Array<Record<string, unknown>> = [];
      for (let i = 0; i < EVENTS; i += 1) {
        const seed = rng.int(2 ** 31);
        const r = new Prng(seed);
        const user = r.uuid();
        const eventId = `pg1-${r.hex(16)}`;
        const premium = r.next() < 0.7;
        await createUser(sql, user);
        w.subscribers.set(user, premium ? activeSubscriber() : lapsedSubscriber());
        const event = {
          id: eventId,
          type: r.pick(["INITIAL_PURCHASE", "RENEWAL", "EXPIRATION", "CANCELLATION"]),
          app_user_id: user,
        };
        const sqlBefore = pg.sqlCalls;
        const first = await run(w, webhookRequest(event, { ip: r.ip() }));
        const sqlFirst = pg.sqlCalls - sqlBefore;
        const row = await entitlement(sql, user);
        const replay = await run(w, webhookRequest(event, { ip: r.ip() }));
        const rowAfter = await entitlement(sql, user);
        const audits = await auditRows(sql, eventId);
        const checks = {
          firstOk: first.status === 200 && first.body?.verified === true,
          rowPremium: row?.premium === premium,
          auditExactlyOne: audits === 1,
          replayDuplicate: replay.status === 200 && replay.body?.duplicate === true,
          replayNoRevenueCat: replay.rcCalls === 0,
          replayNoRewrite: JSON.stringify(row) === JSON.stringify(rowAfter),
          threeSqlStatements: sqlFirst === 3,
        };
        rows.push({
          i,
          seed,
          user,
          eventId,
          premium,
          first: first.body,
          replay: replay.body,
          sqlFirst,
          ...checks,
          outcome: Object.values(checks).every(Boolean) ? "HELD" : "BROKEN",
        });
      }
      const broken = rows.filter((r) => r.outcome === "BROKEN");
      const path = await writeJson("pg1_deliveries.json", {
        seed: BASE_SEED,
        events: EVENTS,
        held: rows.length - broken.length,
        broken: broken.length,
        replay: replayCmd("PG1"),
        rows,
      });
      console.log(`PG1: ${rows.length} deliveries, ${broken.length} broken → ${path}`);
      assertEquals(broken, [], `PG1 broken rows: ${JSON.stringify(broken.map((r) => r.seed))}`);
    });
  },
});

Deno.test({
  name: `stress webhook/pg — PG2 ${LANES} concurrent deliveries of ONE event id (real PK race)`,
  ignore,
  async fn() {
    await withPg(async (sql, w) => {
      const rng = new Prng(fnv1a(`pg2:${BASE_SEED}`));
      const results: Array<Record<string, unknown>> = [];
      for (let round = 0; round < 3; round += 1) {
        const user = rng.uuid();
        const eventId = `pg2-${rng.hex(16)}`;
        await createUser(sql, user);
        w.subscribers.set(user, activeSubscriber());
        const event = { id: eventId, type: "RENEWAL", app_user_id: user };
        const callsBefore = w.calls.length;
        const outcomes = await Promise.all(
          Array.from({ length: LANES }, () => run(w, webhookRequest(event, { ip: rng.ip() }))),
        );
        const statuses = outcomes.map((o) => o.status);
        const rcCalls = w.callsTo("rc", callsBefore).length;
        const audits = await auditRows(sql, eventId);
        const entitlementRows = await countRows(
          sql,
          `select count(*)::int as n from public.billing_entitlements where user_id = '${user}'`,
        );
        const row = await entitlement(sql, user);
        results.push({
          round,
          user,
          eventId,
          statuses,
          bodies: outcomes.map((o) => o.body),
          rcCalls,
          audits,
          entitlementRows,
          premium: row?.premium,
        });
        assert(
          statuses.every((s) => s === 200),
          `all lanes acknowledged: ${statuses}`,
        );
        assertEquals(audits, 1, "exactly one audit row survives the PK race");
        assertEquals(entitlementRows, 1, "exactly one entitlement row");
        assertEquals(row?.premium, true);
        assert(
          outcomes.every((o) => o.body?.verified === true || o.body?.duplicate === true),
          "every lane either verified or reported duplicate",
        );
      }
      const path = await writeJson("pg2_concurrent_duplicates.json", {
        seed: BASE_SEED,
        lanes: LANES,
        replay: replayCmd("PG2"),
        results,
      });
      console.log(
        `PG2: ${results.length} rounds × ${LANES} lanes → ${path} (RC calls per round: ${results.map((r) => r.rcCalls)})`,
      );
    });
  },
});

Deno.test({
  name: "stress webhook/pg — PG3 lapse revokes premium on the real row; transfer moves it",
  ignore,
  async fn() {
    await withPg(async (sql, w) => {
      const rng = new Prng(fnv1a(`pg3:${BASE_SEED}`));
      const a = rng.uuid();
      const b = rng.uuid();
      await createUser(sql, a);
      await createUser(sql, b);
      w.subscribers.set(a, activeSubscriber());
      const buy = await run(
        w,
        webhookRequest(
          { id: `pg3-buy-${rng.hex(8)}`, type: "INITIAL_PURCHASE", app_user_id: a },
          { ip: rng.ip() },
        ),
      );
      assertEquals(buy.body?.verified, true);
      assertEquals((await entitlement(sql, a))?.premium, true);

      w.subscribers.set(a, lapsedSubscriber());
      const lapse = await run(
        w,
        webhookRequest(
          { id: `pg3-lapse-${rng.hex(8)}`, type: "EXPIRATION", app_user_id: a },
          { ip: rng.ip() },
        ),
      );
      assertEquals(lapse.body?.verified, true);
      const lapsed = await entitlement(sql, a);
      assertEquals(lapsed?.premium, false, "EXPIRATION must revoke premium on the real row");

      w.subscribers.set(a, lapsedSubscriber());
      w.subscribers.set(b, activeSubscriber());
      const transfer = await run(
        w,
        webhookRequest(
          {
            id: `pg3-xfer-${rng.hex(8)}`,
            type: "TRANSFER",
            transferred_from: [a],
            transferred_to: [b],
          },
          { ip: rng.ip() },
        ),
      );
      assertEquals(transfer.body?.verified, true);
      assertEquals((await entitlement(sql, a))?.premium, false);
      assertEquals((await entitlement(sql, b))?.premium, true, "TRANSFER destination gets premium");
      const path = await writeJson("pg3_lapse_transfer.json", {
        seed: BASE_SEED,
        a,
        b,
        buy: buy.body,
        lapse: lapse.body,
        transfer: transfer.body,
        transferSupabaseCalls: transfer.supabaseCalls,
        replay: replayCmd("PG3"),
      });
      console.log(`PG3 → ${path}`);
    });
  },
});

Deno.test({
  name: "stress webhook/pg — PG4 real FK 23503: event for a user who never bootstrapped (acknowledged by design)",
  ignore,
  async fn() {
    await withPg(async (sql, w) => {
      const rng = new Prng(fnv1a(`pg4:${BASE_SEED}`));
      const ghost = rng.uuid();
      await sql.unsafe(`delete from auth.users where id = '${ghost}'`);
      w.subscribers.set(ghost, activeSubscriber());
      const eventId = `pg4-${rng.hex(12)}`;
      const first = await run(
        w,
        webhookRequest(
          { id: eventId, type: "INITIAL_PURCHASE", app_user_id: ghost },
          { ip: rng.ip() },
        ),
      );
      assertEquals(first.status, 200);
      assertEquals(first.body?.verified, false, "FK failure surfaces as verified:false");
      assertEquals(await entitlement(sql, ghost), null);
      assertEquals(
        await auditRows(sql, eventId),
        1,
        "audit row written even though the verdict did not land",
      );
      // The user bootstraps afterwards; RevenueCat re-delivers the same event id.
      await createUser(sql, ghost);
      const redelivery = await run(
        w,
        webhookRequest(
          { id: eventId, type: "INITIAL_PURCHASE", app_user_id: ghost },
          { ip: rng.ip() },
        ),
      );
      const after = await entitlement(sql, ghost);
      const path = await writeJson("pg4_fk_ghost_user.json", {
        seed: BASE_SEED,
        ghost,
        eventId,
        first: first.body,
        redelivery: redelivery.body,
        entitlementAfterRedelivery: after,
        replay: replayCmd("PG4"),
      });
      console.log(
        `PG4 → ${path} (redelivery: ${JSON.stringify(redelivery.body)}, row: ${JSON.stringify(after)})`,
      );
      // Documented behaviour (see AGENTS.md "Billing"): the app's own billing
      // sync reconciles the entitlement on next launch; the webhook does not.
      assertEquals(
        redelivery.body?.duplicate,
        true,
        "redelivery is treated as a duplicate (audit row exists)",
      );
      assertEquals(
        after,
        null,
        "redelivery does not land the verdict — reconciliation relies on client billing sync",
      );
    });
  },
});

Deno.test({
  name: "stress webhook/pg — PG5 transient billing write failure then redelivery (P1 candidate on the real schema)",
  ignore,
  async fn() {
    await withPg(async (sql, w) => {
      const rng = new Prng(fnv1a(`pg5:${BASE_SEED}`));
      const user = rng.uuid();
      await createUser(sql, user);
      w.subscribers.set(user, activeSubscriber());
      const eventId = `pg5-${rng.hex(12)}`;
      w.rules = [
        {
          target: "pg.billing_entitlements.post",
          fault: { kind: "http", status: 503, body: '{"message":"connection pool exhausted"}' },
          times: 1,
        },
      ];
      const faulted = await run(
        w,
        webhookRequest({ id: eventId, type: "RENEWAL", app_user_id: user }, { ip: rng.ip() }),
      );
      w.rules = [];
      const rowAfterFault = await entitlement(sql, user);
      const auditsAfterFault = await auditRows(sql, eventId);
      const redelivery = await run(
        w,
        webhookRequest({ id: eventId, type: "RENEWAL", app_user_id: user }, { ip: rng.ip() }),
      );
      const rowAfterRedelivery = await entitlement(sql, user);
      const record = {
        seed: BASE_SEED,
        user,
        eventId,
        faulted: {
          status: faulted.status,
          body: faulted.body,
          supabaseCalls: faulted.supabaseCalls,
        },
        rowAfterFault,
        auditsAfterFault,
        redelivery: {
          status: redelivery.status,
          body: redelivery.body,
          rcCalls: redelivery.rcCalls,
        },
        rowAfterRedelivery,
        expected:
          "a transient persist failure must stay retryable: either 503 to RevenueCat or no audit row, so the redelivery lands the verdict",
        observed: rowAfterRedelivery
          ? "redelivery landed the verdict"
          : "redelivery acknowledged as duplicate; entitlement never written",
        replay: replayCmd("PG5"),
      };
      const path = await writeJson("pg5_persist_failure_redelivery.json", record);
      console.log(`PG5 → ${path}: ${record.observed}`);
      assertEquals(faulted.status, 200);
      assertEquals(faulted.body?.verified, false);
      assertEquals(rowAfterFault, null, "the faulted write did not reach Postgres");
      // Pins the CURRENT behaviour so the finding stays reproducible; the
      // expected behaviour is recorded in the JSON artifact above.
      assertEquals(auditsAfterFault, 1, "audit row is written despite the failed verdict write");
      assertEquals(
        redelivery.body?.duplicate,
        true,
        "redelivery is short-circuited as a duplicate",
      );
      assertEquals(
        rowAfterRedelivery,
        null,
        "entitlement is never written (KNOWN DEFECT — see stress_webhook_failure_load.test.ts db-billing-*)",
      );
    });
  },
});

Deno.test({
  name: "stress webhook/pg — PG6 retention sweep (pg_cron statement) then redelivery re-verifies without corrupting the row",
  ignore,
  async fn() {
    await withPg(async (sql, w) => {
      const rng = new Prng(fnv1a(`pg6:${BASE_SEED}`));
      const user = rng.uuid();
      await createUser(sql, user);
      w.subscribers.set(user, activeSubscriber());
      const eventId = `pg6-${rng.hex(12)}`;
      const first = await run(
        w,
        webhookRequest({ id: eventId, type: "RENEWAL", app_user_id: user }, { ip: rng.ip() }),
      );
      assertEquals(first.body?.verified, true);
      await sql.unsafe(
        `update public.webhook_events set received_at = now() - interval '91 days' where id = '${eventId}'`,
      );
      // The exact statement 20260831000000_scale_and_security.sql schedules via pg_cron.
      await sql.unsafe(
        `delete from public.webhook_events where received_at < now() - interval '90 days'`,
      );
      assertEquals(await auditRows(sql, eventId), 0);
      w.subscribers.set(user, lapsedSubscriber());
      const redelivery = await run(
        w,
        webhookRequest({ id: eventId, type: "RENEWAL", app_user_id: user }, { ip: rng.ip() }),
      );
      const row = await entitlement(sql, user);
      const path = await writeJson("pg6_retention_sweep.json", {
        seed: BASE_SEED,
        user,
        eventId,
        first: first.body,
        redelivery: redelivery.body,
        row,
        replay: replayCmd("PG6"),
      });
      console.log(`PG6 → ${path}`);
      assertEquals(
        redelivery.body?.verified,
        true,
        "after the sweep the event is processed again (re-verified, not trusted)",
      );
      assertEquals(redelivery.rcCalls, 1);
      assertEquals(row?.premium, false, "the CURRENT RevenueCat state wins, not the stale event");
      assertEquals(await auditRows(sql, eventId), 1);
    });
  },
});
