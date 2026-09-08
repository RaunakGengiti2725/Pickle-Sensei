/**
 * W04-01 adversary — REAL-Postgres concurrency attacks on the offline device
 * registry / grant / allocation-ledger RPCs of
 * 20260908120000_offline_device_grants.sql.
 *
 * N independent connections, each in its own transaction as role
 * `authenticated` with the caller's JWT sub, live session claim and the API
 * header, released from a barrier so the per-user advisory xact locks (or
 * their absence) genuinely contend.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_offline_grants_adversary.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = Number(Deno.env.get("XC_PG_LANES") ?? "8");

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface Lane {
  lane: number;
  op: string;
  result: string;
  detail?: string;
}

let seq = 0;
function nextId(prefix: string): { uid: string; sid: string } {
  seq += 1;
  const tail = String(Date.now() % 1_000_000_000).padStart(9, "0") + String(seq).padStart(3, "0");
  return {
    uid: `${prefix}0000000-0000-4000-8000-${tail}`,
    sid: `${prefix}0000001-0000-4000-8000-${tail}`,
  };
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asApiUser(tx: Tx, uid: string, sid: string): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`select set_config('request.jwt.claim.sub', '${uid}', true)`);
  await tx.unsafe(`select set_config('request.jwt.claims', '{"session_id":"${sid}"}', true)`);
  await tx.unsafe(`set local role authenticated`);
}

async function createUser(sql: Sql, provider: string): Promise<{ uid: string; sid: string }> {
  const { uid, sid } = nextId("a");
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${uid}', '${uid}@example.com', '{"provider":"${provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${provider}', 'sub-${uid}', '${uid}', '{"sub":"sub-${uid}"}')`,
  );
  await sql.unsafe(`insert into auth.sessions (id, user_id) values ('${sid}', '${uid}')`);
  return { uid, sid };
}

/** Owner write of a durably delivered offline result (scored, no online permit). */
async function scoredShot(sql: Sql, uid: string): Promise<string> {
  const id = nextId("c").uid;
  await sql.unsafe(
    `insert into public.shots (
       id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
       app_version, model_bundle_version, pose_model_version, paddle_model_version,
       stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
     ) values ('${id}', '${uid}', 'drive', now(), 0, 1000, 7, 1, 'scored', 'v1','v1','v1','v1','v1','v1','v1','v1')`,
  );
  return id;
}

async function asUserOnce<T>(
  sql: Sql,
  uid: string,
  sid: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  let out!: T;
  await sql.begin(async (tx) => {
    await asApiUser(tx as unknown as Tx, uid, sid);
    out = await fn(tx as unknown as Tx);
  });
  return out;
}

async function registerDevice(tx: Tx, key: string): Promise<{ result: string; deviceId: string }> {
  const r = await tx.unsafe(
    `select result, device_id::text as device_id from public.register_offline_device('${key}', 'production', true)`,
  );
  return { result: String(r[0].result), deviceId: String(r[0].device_id) };
}

async function issueGrant(
  tx: Tx,
  key: string,
  n: number,
): Promise<{ result: string; tickets: string[] }> {
  const r = await tx.unsafe(
    `select result, coalesce(ticket_ids, '{}'::uuid[])::text[] as tickets from public.issue_offline_grant('${key}', ${n})`,
  );
  return { result: String(r[0].result), tickets: (r[0].tickets as string[]) ?? [] };
}

/** Run fn on `lanes` connections, each in an open transaction as the given
 * user, all released together. Exceptions are captured as results. */
async function burst(
  sql: Sql,
  lanes: number,
  who: (lane: number) => { uid: string; sid: string },
  fn: (tx: Tx, lane: number) => Promise<Omit<Lane, "lane">>,
): Promise<Lane[]> {
  const b = barrier();
  let ready = 0;
  const rows: Lane[] = [];
  const runLane = async (lane: number): Promise<void> => {
    try {
      await sql.begin(async (tx) => {
        const { uid, sid } = who(lane);
        await asApiUser(tx as unknown as Tx, uid, sid);
        ready += 1;
        await b.gate;
        const out = await fn(tx as unknown as Tx, lane);
        rows.push({ lane, ...out });
      });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      rows.push({
        lane,
        op: "error",
        result: `sqlstate:${e.code ?? "?"}`,
        detail: e.message,
      });
    }
  };
  const all = Promise.all(Array.from({ length: lanes }, (_, lane) => runLane(lane)));
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

async function ledger(sql: Sql, uid: string) {
  const rows = await sql.unsafe(
    `select event, count(*)::int as n from public.offline_allocation_ledger where user_id = '${uid}' group by 1 order by 1`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[String(r.event)] = Number(r.n);
  return out;
}

async function accessState(sql: Sql, uid: string, sid: string) {
  return await asUserOnce(sql, uid, sid, async (tx) => {
    const r = await tx.unsafe(
      `select scored_count, reserved_count, public.offline_hold_count() as held from public.access_state()`,
    );
    return {
      scored: Number(r[0].scored_count),
      reserved: Number(r[0].reserved_count),
      held: Number(r[0].held),
    };
  });
}

function histogram(values: string[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const v of values) h[v] = (h[v] ?? 0) + 1;
  return h;
}

function withSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = postgres(PG_URL, { max: LANES + 4 });
  return fn(sql).finally(() => sql.end());
}

// ─────────────────────────────────────────────────────────────────────────────
// PGO1 — N devices of one free identity each ask for 2 tickets at once
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO1: issue_offline_grant ×N devices concurrently — never more than 2 tickets",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "google");
      const keys = Array.from({ length: LANES }, (_, i) => `pgo1-dev-${i}`);
      for (const key of keys) {
        const r = await asUserOnce(sql, uid, sid, (tx) => registerDevice(tx, key));
        assertEquals(r.result, "accepted");
      }
      const out = await burst(
        sql,
        LANES,
        () => ({ uid, sid }),
        async (tx, lane) => {
          const r = await issueGrant(tx, keys[lane], 2);
          return { op: "issue", result: r.result, detail: r.tickets.join(",") };
        },
      );
      const hist = histogram(out.map((r) => r.result));
      const led = await ledger(sql, uid);
      const st = await accessState(sql, uid, sid);
      const issued = out.flatMap((r) => (r.detail ? r.detail.split(",").filter(Boolean) : []));
      const summary = { hist, led, st };
      console.log(`[xc-pgo1] ${JSON.stringify(summary)}`);
      assert(!out.some((r) => r.op === "error"), `no lane may error: ${JSON.stringify(out)}`);
      assertEquals(led.allocated ?? 0, 2, "exactly two tickets exist for the identity");
      assertEquals(new Set(issued).size, 2, "the two tickets are the ones handed out");
      assertEquals(st.held, 2);
      assertEquals(st.reserved, 2);
      assert(
        (hist["access.paywall_required"] ?? 0) >= LANES - 2,
        `losers see paywall: ${JSON.stringify(hist)}`,
      );
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGO2 — one ticket, N different delivered shots consume it at once
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO2: consume same ticket ×N shots concurrently — exactly one consumption",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "apple");
      await asUserOnce(sql, uid, sid, (tx) => registerDevice(tx, "pgo2-dev"));
      const g = await asUserOnce(sql, uid, sid, (tx) => issueGrant(tx, "pgo2-dev", 1));
      assertEquals(g.result, "accepted");
      const ticket = g.tickets[0];
      const shots: string[] = [];
      for (let i = 0; i < LANES; i++) shots.push(await scoredShot(sql, uid));
      const out = await burst(
        sql,
        LANES,
        () => ({ uid, sid }),
        async (tx, lane) => {
          const r = await tx.unsafe(
            `select public.consume_offline_ticket('${ticket}', '${shots[lane]}') as r`,
          );
          return { op: "consume", result: String(r[0].r), detail: shots[lane] };
        },
      );
      const hist = histogram(out.map((r) => r.result));
      const led = await ledger(sql, uid);
      const consumed = await sql.unsafe(
        `select shot_id::text as s from public.offline_allocation_ledger where ticket_id = '${ticket}' and event = 'consumed'`,
      );
      console.log(`[xc-pgo2] results=${JSON.stringify(hist)} ledger=${JSON.stringify(led)}`);
      assert(!out.some((r) => r.op === "error"), `no lane may error: ${JSON.stringify(out)}`);
      assertEquals(hist.accepted, 1, "exactly one shot wins the ticket");
      assertEquals(hist["offline.ticket_consumed"], LANES - 1);
      assertEquals(consumed.length, 1);
      const winner = out.find((r) => r.result === "accepted");
      assertEquals(String(consumed[0].s), winner?.detail);
      assertEquals(led.consumed, 1);
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGO3 — one delivered shot, two tickets, N lanes race to bind it
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO3: one shot, two tickets ×N concurrent consumes — the shot is paid for exactly once",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "google");
      await asUserOnce(sql, uid, sid, (tx) => registerDevice(tx, "pgo3-dev"));
      const g = await asUserOnce(sql, uid, sid, (tx) => issueGrant(tx, "pgo3-dev", 2));
      assertEquals(g.tickets.length, 2);
      const shot = await scoredShot(sql, uid);
      const out = await burst(
        sql,
        LANES,
        () => ({ uid, sid }),
        async (tx, lane) => {
          const ticket = g.tickets[lane % 2];
          const r = await tx.unsafe(
            `select public.consume_offline_ticket('${ticket}', '${shot}') as r`,
          );
          return { op: "consume", result: String(r[0].r), detail: ticket };
        },
      );
      const hist = histogram(out.map((r) => r.result));
      const led = await ledger(sql, uid);
      const st = await accessState(sql, uid, sid);
      const summary = { hist, led, st };
      console.log(`[xc-pgo3] ${JSON.stringify(summary)}`);
      assert(!out.some((r) => r.op === "error"), `no lane may error: ${JSON.stringify(out)}`);
      assertEquals(led.consumed, 1, "one consumed row for the one shot");
      const winners = new Set(out.filter((r) => r.result === "accepted").map((r) => r.detail));
      assertEquals(
        winners.size,
        1,
        "every accepted lane names the same ticket (idempotent replays only)",
      );
      assertEquals(
        out.filter((r) => r.result === "offline.shot_not_chargeable").length,
        out.filter((r) => r.detail !== [...winners][0]).length,
        "the other ticket is refused for the already-paid shot",
      );
      assertEquals(st.scored, 1);
      assertEquals(st.held, 1, "the other ticket is still held, not silently released");
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGO4 — online reservations and offline allocations race for the same budget
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO4: reserve_analysis_permit ∥ issue_offline_grant — reserved + allocated == 2",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "apple");
      const half = Math.max(2, Math.floor(LANES / 2));
      const keys = Array.from({ length: half }, (_, i) => `pgo4-dev-${i}`);
      for (const key of keys) await asUserOnce(sql, uid, sid, (tx) => registerDevice(tx, key));
      const out = await burst(
        sql,
        half * 2,
        () => ({ uid, sid }),
        async (tx, lane) => {
          if (lane % 2 === 0) {
            const r = await tx.unsafe(
              `select result from public.reserve_analysis_permit('pgo4-online-${lane}')`,
            );
            return { op: "reserve", result: String(r[0].result) };
          }
          const r = await issueGrant(tx, keys[(lane - 1) / 2], 2);
          return { op: "issue", result: r.result, detail: String(r.tickets.length) };
        },
      );
      const hist = histogram(out.map((r) => `${r.op}:${r.result}`));
      const led = await ledger(sql, uid);
      const permits = await sql.unsafe(
        `select count(*)::int as n from public.analysis_permits where user_id = '${uid}' and status = 'reserved'`,
      );
      const st = await accessState(sql, uid, sid);
      const summary = { hist, led, permits: permits[0].n, st };
      console.log(`[xc-pgo4] ${JSON.stringify(summary)}`);
      assert(!out.some((r) => r.op === "error"), `no lane may error: ${JSON.stringify(out)}`);
      assertEquals(
        Number(permits[0].n) + (led.allocated ?? 0),
        2,
        "online + offline == the 2 lifetime ratings",
      );
      assertEquals(st.reserved, 2);
      assertEquals(st.scored, 0);
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGO5 — first registration of one installation key double-submitted
// (timeout retry / 5xx retry / two in-flight bootstraps): idempotent RPC must
// answer `accepted` on every lane with ONE device row — not a unique
// violation the edge fn turns into a 5xx.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO5: register_offline_device same key ×N first-time — all accepted, one row",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "google");
      const out = await burst(
        sql,
        LANES,
        () => ({ uid, sid }),
        async (tx) => {
          const r = await registerDevice(tx, "pgo5-shared-key");
          return { op: "register", result: r.result, detail: r.deviceId };
        },
      );
      const hist = histogram(out.map((r) => r.result));
      const devices = await sql.unsafe(
        `select count(*)::int as n from public.offline_devices where user_id = '${uid}' and installation_key_id = 'pgo5-shared-key'`,
      );
      const errors = out.filter((r) => r.op === "error").map((r) => r.detail);
      const summary = { hist, devices: devices[0].n, errors };
      console.log(`[xc-pgo5] ${JSON.stringify(summary)}`);
      assertEquals(Number(devices[0].n), 1, "one device row");
      assertEquals(
        hist.accepted,
        LANES,
        `double-submitted first registration must be idempotent, got ${JSON.stringify(hist)}`,
      );
      assertEquals(new Set(out.map((r) => r.detail)).size, 1, "every lane sees the same device id");
    });
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PGO6 — crash between steps: the delivered shot is stored, then the client's
// consume retry and its "give the ticket back" path race. One terminal event.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name: "xc PGO6: consume ∥ release on one ticket — exactly one terminal event, no double terminal",
  ignore,
  async fn() {
    await withSql(async (sql) => {
      const { uid, sid } = await createUser(sql, "apple");
      await asUserOnce(sql, uid, sid, (tx) => registerDevice(tx, "pgo6-dev"));
      const g = await asUserOnce(sql, uid, sid, (tx) => issueGrant(tx, "pgo6-dev", 1));
      const ticket = g.tickets[0];
      const shot = await scoredShot(sql, uid);
      const out = await burst(
        sql,
        LANES,
        () => ({ uid, sid }),
        async (tx, lane) => {
          if (lane % 2 === 0) {
            const r = await tx.unsafe(
              `select public.consume_offline_ticket('${ticket}', '${shot}') as r`,
            );
            return { op: "consume", result: String(r[0].r) };
          }
          const r = await tx.unsafe(
            `select public.release_offline_ticket('${ticket}', 'unused_ticket_returned') as r`,
          );
          return { op: "release", result: String(r[0].r) };
        },
      );
      const hist = histogram(out.map((r) => `${r.op}:${r.result}`));
      const terminal = await sql.unsafe(
        `select event from public.offline_allocation_ledger where ticket_id = '${ticket}' and event in ('consumed', 'released')`,
      );
      const st = await accessState(sql, uid, sid);
      const summary = { hist, terminal: terminal.map((t) => t.event), st };
      console.log(`[xc-pgo6] ${JSON.stringify(summary)}`);
      assert(!out.some((r) => r.op === "error"), `no lane may error: ${JSON.stringify(out)}`);
      assertEquals(terminal.length, 1, "exactly one terminal event");
      const winner = String(terminal[0].event);
      const consumeAccepted = hist["consume:accepted"] ?? 0;
      const releaseAccepted = hist["release:accepted"] ?? 0;
      if (winner === "consumed") {
        assertEquals(releaseAccepted, 0, "release must not report accepted for a consumed ticket");
        assertEquals(hist["release:offline.ticket_consumed"], LANES / 2);
        assertEquals(st.held, 0);
      } else {
        assertEquals(consumeAccepted, 0, "consume must not report accepted for a released ticket");
        assertEquals(hist["consume:offline.ticket_released"], LANES / 2);
        assertEquals(st.held, 1, "a released ticket still counts");
      }
    });
  },
});
