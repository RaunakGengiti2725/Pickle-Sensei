/**
 * W04-01 round-2 adversary — CONCURRENCY half of the attack (candidate
 * 1da63a1e, supabase/migrations/20260908120000_offline_device_grants.sql).
 *
 * The SQL matrix (supabase/tests/xc_adjudication/w04_01_r2_offline_attack.sql)
 * attacks the offline RPCs one statement at a time. This file drives the REAL
 * register_offline_device / issue_offline_grant / consume_offline_ticket /
 * release_offline_ticket / reserve_analysis_permit / access_state on a
 * disposable postgres:16 (./xc_pg_up.sh) from N INDEPENDENT connections, each
 * in its own transaction as role `authenticated` with the caller's JWT sub,
 * live session claim and the API header, released from a barrier so the
 * per-user advisory xact locks genuinely contend:
 *
 *   PA1 double-submit registration of ONE new key ×N        → N accepted, ONE device row
 *   PA2 N devices of ONE free identity each ask 2 tickets    → ≤ 2 tickets in total
 *   PA3 offline issue ×N racing online reserve ×N (same uid) → holds + live permits ≤ 2
 *   PA4 consume ONE ticket with N DISTINCT delivered shots   → exactly ONE consumed row
 *   PA5 interleaved account switch on ONE installation key   → each account bounded to its
 *       own identity budget, no lane receives the other account's ticket ids
 *   PA6 consume (distinct shots) ×N racing release ×N, ONE ticket → exactly ONE terminal event
 *
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55435/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_offline_grants_attack.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, histogram } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("XC_PG_LANES", 12);
/** The allocation ledger is append-only and survives account deletion BY
 * DESIGN, so a rerun against the same disposable database must use fresh
 * ids: every uuid carries this nonce (override to replay a run). */
const RUN = envInt("XC_RUN_NONCE", Date.now()) % 0x1000000;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface LaneOut {
  lane: number;
  op: string;
  result: string;
  ticketIds: string[];
  sqlstate?: string;
}

/** v4-shaped uuid from the run nonce + a namespace + an ordinal. */
function uid(ns: number, n: number): string {
  const run = RUN.toString(16).padStart(6, "0");
  const tail = n.toString(16).padStart(12, "0");
  return `d${ns.toString(16)}${run}-0000-4000-8000-${tail}`;
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

/** Owner-role fixture: user + one sign-in identity + one live auth session.
 * The sign-in subject carries the run nonce too, so the identity's
 * free-rating ledger row and any surviving allocation rows are this run's. */
async function createUser(
  sql: Sql,
  userId: string,
  sessionId: string,
  provider: string,
  subBase: string,
) {
  const sub = `${subBase}-${RUN}`;
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
      values ('${userId}', '${userId}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
      values ('${provider}', '${sub}', '${userId}', '{"sub":"${sub}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${sessionId}', '${userId}')`);
}

async function asUser(tx: Tx, userId: string, sessionId: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`select set_config('request.jwt.claim.sub', '${userId}', true)`);
  await tx.unsafe(
    `select set_config('request.jwt.claims', jsonb_build_object('session_id', '${sessionId}')::text, true)`,
  );
  await tx.unsafe(`set local role authenticated`);
}

/** Owner-role write of a durably delivered offline result (scored, no online
 * permit) — the row consume_offline_ticket() is specified to bind. */
async function deliverShot(sql: Sql, userId: string, shotId: string) {
  await sql.unsafe(`delete from public.shots where id = '${shotId}'`);
  await sql.unsafe(
    `insert into public.shots (
       id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
       app_version, model_bundle_version, pose_model_version, paddle_model_version,
       stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
     ) values ('${shotId}', '${userId}', 'drive', now(), 0, 1000, 7, 1, 'scored',
       'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1')`,
  );
}

async function burst(
  sql: Sql,
  lanes: number,
  callerFor: (lane: number) => { userId: string; sessionId: string },
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneOut, "lane">>,
): Promise<LaneOut[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneOut[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql
        .begin(async (tx) => {
          const c = callerFor(lane);
          await asUser(tx as unknown as Tx, c.userId, c.sessionId);
          ready += 1;
          await b.gate;
          try {
            rows.push({ lane, ...(await fn(tx as unknown as Tx, lane)) });
          } catch (e) {
            const err = e as { code?: string; message?: string };
            rows.push({
              lane,
              op: "error",
              result: `error:${err.message ?? String(e)}`,
              ticketIds: [],
              sqlstate: err.code,
            });
            throw e;
          }
        })
        .catch(() => undefined),
    ),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

async function registerRpc(tx: Tx, key: string): Promise<Omit<LaneOut, "lane">> {
  const r = await tx.unsafe(
    `select result from public.register_offline_device('${key}', 'production', true)`,
  );
  return { op: "register", result: String(r[0].result), ticketIds: [] };
}

async function issueRpc(tx: Tx, key: string, n: number): Promise<Omit<LaneOut, "lane">> {
  const r = await tx.unsafe(
    `select result, coalesce(ticket_ids, '{}')::text[] as ticket_ids
       from public.issue_offline_grant('${key}', ${n})`,
  );
  return {
    op: "issue",
    result: String(r[0].result),
    ticketIds: (r[0].ticket_ids as string[]).map(String),
  };
}

async function reserveRpc(tx: Tx, key: string): Promise<Omit<LaneOut, "lane">> {
  const r = await tx.unsafe(`select result from public.reserve_analysis_permit('${key}')`);
  return { op: "reserve", result: String(r[0].result), ticketIds: [] };
}

async function consumeRpc(tx: Tx, ticket: string, shot: string): Promise<Omit<LaneOut, "lane">> {
  const r = await tx.unsafe(
    `select public.consume_offline_ticket('${ticket}', '${shot}') as result`,
  );
  return { op: "consume", result: String(r[0].result), ticketIds: [ticket] };
}

async function releaseRpc(tx: Tx, ticket: string, reason: string): Promise<Omit<LaneOut, "lane">> {
  const r = await tx.unsafe(
    `select public.release_offline_ticket('${ticket}', '${reason}') as result`,
  );
  return { op: "release", result: String(r[0].result), ticketIds: [ticket] };
}

async function ledgerEvents(sql: Sql, userId: string): Promise<Record<string, number>> {
  const r = await sql.unsafe(
    `select event, count(*)::int as n from public.offline_allocation_ledger
      where user_id = '${userId}' group by event`,
  );
  const out: Record<string, number> = {};
  for (const row of r) out[String(row.event)] = Number(row.n);
  return out;
}

async function accessState(sql: Sql, userId: string, sessionId: string) {
  let out = { scored: -1, reserved: -1 };
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, userId, sessionId);
    const r = await tx.unsafe(`select scored_count, reserved_count from public.access_state()`);
    out = { scored: Number(r[0].scored_count), reserved: Number(r[0].reserved_count) };
  });
  return out;
}

/** Ordered setup + a fresh sql pool per test (postgres.js pools are per-test
 * so a failed lane cannot poison the next scenario's connections). */
async function withSql(fn: (sql: Sql) => Promise<void>) {
  const sql = postgres(PG_URL, { max: LANES + 4, onnotice: () => {} });
  try {
    await fn(sql);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

Deno.test({
  name: "xc PA1: register_offline_device same NEW key ×N concurrent — every lane accepted, ONE device row",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const u = uid(1, 1),
        s = uid(1, 2);
      await createUser(sql, u, s, "google", "pa1-sub");
      const rows = await burst(
        sql,
        LANES,
        () => ({ userId: u, sessionId: s }),
        (tx) => registerRpc(tx, "pa1-installation-key"),
      );
      console.log("PA1", histogram(rows.map((r) => r.result)));
      const devices = await sql.unsafe(
        `select count(*)::int as n from public.offline_devices where user_id = '${u}'`,
      );
      assertEquals(Number(devices[0].n), 1, "one device row for one key");
      assertEquals(
        rows.filter((r) => r.result !== "accepted").map((r) => r.result),
        [],
        "every concurrent registration of the same key is accepted (no unique_violation surfaces)",
      );
    });
  },
});

Deno.test({
  name: "xc PA2: issue_offline_grant on N DISTINCT devices of ONE free identity, each asking 2 — total distinct tickets ≤ 2, ledger allocated ≤ 2",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const u = uid(2, 1),
        s = uid(2, 2);
      await createUser(sql, u, s, "google", "pa2-sub");
      for (let i = 0; i < LANES; i++) {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, u, s);
          await registerRpc(tx as unknown as Tx, `pa2-device-${i}`);
        });
      }
      const rows = await burst(
        sql,
        LANES,
        () => ({ userId: u, sessionId: s }),
        (tx, lane) => issueRpc(tx, `pa2-device-${lane}`, 2),
      );
      console.log("PA2", histogram(rows.map((r) => r.result)));
      const tickets = new Set(rows.flatMap((r) => r.ticketIds));
      const ledger = await ledgerEvents(sql, u);
      const state = await accessState(sql, u, s);
      console.log("PA2 tickets", tickets.size, "ledger", ledger, "access_state", state);
      assertEquals(rows.filter((r) => r.op === "error").length, 0, "no lane errored");
      assert(tickets.size <= 2, `distinct tickets across devices ${tickets.size} > 2`);
      assert((ledger.allocated ?? 0) <= 2, `ledger allocated ${ledger.allocated} > 2`);
      assertEquals(state.reserved, tickets.size, "access_state counts every hold");
    });
  },
});

Deno.test({
  name: "xc PA3: offline issue ×N racing online reserve_analysis_permit ×N for ONE free identity — holds + live permits ≤ 2",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const u = uid(3, 1),
        s = uid(3, 2);
      await createUser(sql, u, s, "google", "pa3-sub");
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, u, s);
        await registerRpc(tx as unknown as Tx, "pa3-device");
      });
      const rows = await burst(
        sql,
        LANES,
        () => ({ userId: u, sessionId: s }),
        (tx, lane) =>
          lane % 2 === 0 ? issueRpc(tx, "pa3-device", 2) : reserveRpc(tx, `pa3-reserve-${lane}`),
      );
      console.log("PA3", histogram(rows.map((r) => `${r.op}:${r.result}`)));
      const tickets = new Set(rows.flatMap((r) => r.ticketIds));
      const permits = await sql.unsafe(
        `select count(*)::int as n from public.analysis_permits
          where user_id = '${u}' and status = 'reserved'`,
      );
      const live = Number(permits[0].n);
      const state = await accessState(sql, u, s);
      console.log("PA3 holds", tickets.size, "live permits", live, "access_state", state);
      assertEquals(rows.filter((r) => r.op === "error").length, 0, "no lane errored");
      assert(tickets.size + live <= 2, `holds ${tickets.size} + live permits ${live} > 2`);
      assertEquals(state.reserved, tickets.size + live, "access_state counts holds and permits");
    });
  },
});

Deno.test({
  name: "xc PA4: consume_offline_ticket ONE ticket ×N concurrent with N DISTINCT delivered shots — exactly ONE consumed event",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const u = uid(4, 1),
        s = uid(4, 2);
      await createUser(sql, u, s, "google", "pa4-sub");
      let ticket = "";
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, u, s);
        await registerRpc(tx as unknown as Tx, "pa4-device");
        const g = await issueRpc(tx as unknown as Tx, "pa4-device", 1);
        assertEquals(g.result, "accepted");
        ticket = g.ticketIds[0];
      });
      for (let i = 0; i < LANES; i++) await deliverShot(sql, u, uid(4, 100 + i));
      const rows = await burst(
        sql,
        LANES,
        () => ({ userId: u, sessionId: s }),
        (tx, lane) => consumeRpc(tx, ticket, uid(4, 100 + lane)),
      );
      const hist = histogram(rows.map((r) => r.result));
      const ledger = await ledgerEvents(sql, u);
      console.log("PA4", hist, "ledger", ledger);
      assertEquals(rows.filter((r) => r.op === "error").length, 0, "no lane errored");
      assertEquals(hist.accepted ?? 0, 1, "exactly one lane binds the ticket");
      assertEquals(ledger.consumed ?? 0, 1, "exactly one consumed event");
      const bound = await sql.unsafe(
        `select count(distinct shot_id)::int as n from public.offline_allocation_ledger
          where ticket_id = '${ticket}' and event = 'consumed'`,
      );
      assertEquals(Number(bound[0].n), 1, "the ticket is bound to exactly one shot");
    });
  },
});

Deno.test({
  name: "xc PA5: interleaved account switch — accounts A and B alternate on ONE installation key ×N — each bounded to 2, no cross-account ticket ids",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const a = uid(5, 1),
        sa = uid(5, 2),
        b = uid(5, 3),
        sb = uid(5, 4);
      await createUser(sql, a, sa, "google", "pa5-sub-a");
      await createUser(sql, b, sb, "apple", "pa5-sub-b");
      for (const [u, s] of [
        [a, sa],
        [b, sb],
      ]) {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, u, s);
          await registerRpc(tx as unknown as Tx, "pa5-shared-key");
        });
      }
      const caller = (lane: number) =>
        lane % 2 === 0 ? { userId: a, sessionId: sa } : { userId: b, sessionId: sb };
      const rows = await burst(sql, LANES, caller, (tx) => issueRpc(tx, "pa5-shared-key", 2));
      console.log("PA5", histogram(rows.map((r) => r.result)));
      const ticketsA = new Set(rows.filter((r) => r.lane % 2 === 0).flatMap((r) => r.ticketIds));
      const ticketsB = new Set(rows.filter((r) => r.lane % 2 === 1).flatMap((r) => r.ticketIds));
      const ledgerA = await ledgerEvents(sql, a);
      const ledgerB = await ledgerEvents(sql, b);
      console.log("PA5 A", ticketsA.size, ledgerA, "B", ticketsB.size, ledgerB);
      assertEquals(rows.filter((r) => r.op === "error").length, 0, "no lane errored");
      assert(ticketsA.size <= 2 && ticketsB.size <= 2, "each account bounded to 2");
      assertEquals(
        [...ticketsA].filter((t) => ticketsB.has(t)),
        [],
        "no shared ticket ids",
      );
      const owners = await sql.unsafe(
        `select ticket_id::text as t, user_id::text as u from public.offline_allocation_ledger
          where user_id in ('${a}', '${b}') and event = 'allocated'`,
      );
      for (const row of owners) {
        const t = String(row.t),
          owner = String(row.u);
        if (ticketsA.has(t)) assertEquals(owner, a, "A received only A-owned tickets");
        if (ticketsB.has(t)) assertEquals(owner, b, "B received only B-owned tickets");
      }
    });
  },
});

Deno.test({
  name: "xc PA6: consume (N distinct delivered shots) ×N racing release ×N on ONE ticket — exactly ONE terminal ledger event, losers see a terminal state, never an error",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const u = uid(6, 1),
        s = uid(6, 2);
      await createUser(sql, u, s, "google", "pa6-sub");
      let ticket = "";
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, u, s);
        await registerRpc(tx as unknown as Tx, "pa6-device");
        const g = await issueRpc(tx as unknown as Tx, "pa6-device", 1);
        assertEquals(g.result, "accepted");
        ticket = g.ticketIds[0];
      });
      for (let i = 0; i < LANES; i++) await deliverShot(sql, u, uid(6, 100 + i));
      const rows = await burst(
        sql,
        LANES,
        () => ({ userId: u, sessionId: s }),
        (tx, lane) =>
          lane % 2 === 0
            ? consumeRpc(tx, ticket, uid(6, 100 + lane))
            : releaseRpc(tx, ticket, "unused_ticket_returned"),
      );
      const hist = histogram(rows.map((r) => `${r.op}:${r.result}`));
      const ledger = await ledgerEvents(sql, u);
      console.log("PA6", hist, "ledger", ledger);
      assertEquals(rows.filter((r) => r.op === "error").length, 0, "no lane errored");
      const terminal = (ledger.consumed ?? 0) + (ledger.released ?? 0);
      assertEquals(terminal, 1, `exactly one terminal event, got ${JSON.stringify(ledger)}`);
      const accepted = rows.filter((r) => r.result === "accepted");
      assertEquals(accepted.length, 1, "exactly one lane wins the ticket");
      for (const r of rows) {
        if (r.result === "accepted") continue;
        assert(
          r.result === "offline.ticket_consumed" || r.result === "offline.ticket_released",
          `loser saw ${r.op}:${r.result}`,
        );
      }
    });
  },
});
