/**
 * W04-01 adversarial concurrency attacks (candidate 52867e38) — the REAL
 * offline RPCs on a disposable postgres:16 with shim_auth.sql + every
 * migration applied (./xc_pg_up.sh), N INDEPENDENT connections, each in its
 * own transaction as role `authenticated` with a live API session, released
 * from a barrier so the per-user advisory xact locks genuinely contend.
 *
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json attack_w04_01_offline_concurrency.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Each test asserts the objective's conservation / append-only / terminal
 * invariants after the burst; a failing assertion is a confirmed break.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = Number(Deno.env.get("XC_PG_LANES") ?? "8");

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

interface Caller {
  userId: string;
  sessionId: string;
  provider: string;
  sub: string;
}

const RUN = crypto.randomUUID().slice(0, 8);

/** Fresh account per test run: the offline ledger survives the auth.users
 * cascade BY DESIGN (identity-hashed, user_id kept), so a reused user id
 * would inherit an earlier run's holds. */
function caller(n: number): Caller {
  return {
    userId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    provider: n % 2 === 0 ? "google" : "apple",
    sub: `${RUN}-sub-${n}`,
  };
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, c: Caller): Promise<void> {
  await tx.unsafe(`select set_config('request.headers', jsonb_build_object(
    'x-pickle-api-key', public.get_api_request_key())::text, true)`);
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${c.userId}'`);
  await tx.unsafe(`set local request.jwt.claims = '{"session_id":"${c.sessionId}"}'`);
}

/** Owner-role fixture: account, one sign-in identity, one live session. */
async function createCaller(sql: Sql, c: Caller): Promise<void> {
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${c.userId}', '${c.userId}@example.com', '{"provider":"${c.provider}"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('${c.provider}', '${c.sub}', '${c.userId}', '{"sub":"${c.sub}"}')`,
  );
  await sql.unsafe(
    `insert into auth.sessions (id, user_id) values ('${c.sessionId}', '${c.userId}')`,
  );
}

async function ownerScoredShot(sql: Sql, c: Caller, id: string): Promise<void> {
  await sql.unsafe(
    `insert into public.shots (
       id, user_id, shot_type, captured_at, start_ms, end_ms, overall_score, analysis_confidence, result_kind,
       app_version, model_bundle_version, pose_model_version, paddle_model_version,
       stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version
     ) values ('${id}', '${c.userId}', 'drive', now(), 0, 1000, 7, 1, 'scored',
       'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1', 'v1')`,
  );
}

interface LaneOut {
  lane: number;
  result: string;
  detail?: string;
  error?: string;
}

/** Run `fn` on `lanes` independent connections; every lane opens a tx, sets
 * its caller, waits at the barrier, runs fn and COMMITs. SQL errors are
 * captured per lane (the edge function would turn them into a 5xx). */
async function burst(
  sql: Sql,
  lanes: number,
  callerFor: (lane: number) => Caller,
  fn: (tx: Tx, lane: number) => Promise<Omit<LaneOut, "lane">>,
): Promise<LaneOut[]> {
  const b = barrier();
  let ready = 0;
  const out: LaneOut[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql
        .begin(async (tx) => {
          try {
            await asUser(tx as unknown as Tx, callerFor(lane));
          } finally {
            ready += 1;
          }
          await b.gate;
          const r = await fn(tx as unknown as Tx, lane);
          out.push({ lane, ...r });
        })
        .catch((e: unknown) => {
          const err = e as { code?: string; message?: string };
          out.push({
            lane,
            result: "ERROR",
            error: `${err.code ?? ""} ${err.message ?? String(e)}`,
          });
        }),
    ),
  );
  // Fire once every lane holds an open transaction with its caller set.
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  out.sort((a, b) => a.lane - b.lane);
  return out;
}

async function registerRpc(tx: Tx, key: string, attested: boolean) {
  const r = await tx.unsafe(
    `select result, device_id::text as device_id, attestation_state from public.register_offline_device('${key}', 'production', ${attested})`,
  );
  return { result: String(r[0].result), detail: `${r[0].attestation_state}` };
}

async function issueRpc(tx: Tx, key: string, requested: number) {
  const r = await tx.unsafe(
    `select result, generation, coalesce(array_length(ticket_ids, 1), 0)::int as n, array_to_string(ticket_ids, ',') as tickets
       from public.issue_offline_grant('${key}', ${requested})`,
  );
  return {
    result: String(r[0].result),
    detail: `gen=${r[0].generation} n=${r[0].n} ${r[0].tickets ?? ""}`,
  };
}

async function ledger(sql: Sql, c: Caller) {
  const rows = await sql.unsafe(
    `select event, count(*)::int as n, count(distinct ticket_id)::int as tickets
       from public.offline_allocation_ledger where user_id = '${c.userId}' group by event order by event`,
  );
  const o: Record<string, { n: number; tickets: number }> = {};
  for (const r of rows) o[String(r.event)] = { n: Number(r.n), tickets: Number(r.tickets) };
  return o;
}

async function holdCount(sql: Sql, c: Caller): Promise<number> {
  let n = -1;
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, c);
    const r = await tx.unsafe(`select public.offline_hold_count()::int as n`);
    n = Number(r[0].n);
  });
  return n;
}

function histogram(rows: LaneOut[]): Record<string, number> {
  const h: Record<string, number> = {};
  for (const r of rows) h[r.result] = (h[r.result] ?? 0) + 1;
  return h;
}

Deno.test({
  name: "ATTACK C1a — first registration, deterministic interleave: tx1 registers (uncommitted), tx2 registers the same key → tx2 must be accepted once tx1 commits, not a SQL error",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const c = caller(0);
      await createCaller(sql, c);
      const key = `c1a-${RUN}`;
      let second: LaneOut = { lane: 1, result: "" };
      let firstCommitted = false;
      const b = barrier();
      const tx1 = sql
        .begin(async (tx) => {
          await asUser(tx as unknown as Tx, c);
          const r = await registerRpc(tx as unknown as Tx, key, true);
          assertEquals(r.result, "accepted");
          await b.gate; // hold the uncommitted row until tx2 is blocked on it
        })
        .then(() => {
          firstCommitted = true;
        });
      // tx2: READ COMMITTED sees no row, takes the insert path, blocks on the
      // unique index until tx1 commits.
      const tx2 = sql
        .begin(async (tx) => {
          await asUser(tx as unknown as Tx, c);
          const r = await registerRpc(tx as unknown as Tx, key, false);
          second = { lane: 1, ...r };
        })
        .catch((e: unknown) => {
          const err = e as { code?: string; message?: string };
          second = {
            lane: 1,
            result: "ERROR",
            error: `${err.code ?? ""} ${err.message ?? String(e)}`,
          };
        });
      await new Promise((r) => setTimeout(r, 300));
      assert(
        !firstCommitted && second.result === "",
        "precondition: tx2 is blocked behind tx1's uncommitted insert",
      );
      b.open();
      await tx1;
      await tx2;
      const devices = await sql.unsafe(
        `select count(*)::int as n from public.offline_devices where user_id = '${c.userId}' and installation_key_id = '${key}'`,
      );
      console.log(
        `[attack-w04-01] C1a tx2 → ${second.result} ${second.error ?? second.detail ?? ""} devices=${devices[0].n}`,
      );
      assertEquals(Number(devices[0].n), 1);
      assertEquals(
        second.result,
        "accepted",
        `a concurrent first registration of the same key must be idempotent, got ${second.result} ${second.error ?? ""}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C1 — first registration double-submit: same key, N lanes → one device row, every lane accepted, no error",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(1);
      await createCaller(sql, c);
      const key = `c1-${RUN}`;
      const rows = await burst(
        sql,
        LANES,
        () => c,
        (tx, lane) => registerRpc(tx, key, lane % 2 === 0),
      );
      const devices = await sql.unsafe(
        `select count(*)::int as n, bool_and(attestation_state = 'attested') as attested
           from public.offline_devices where user_id = '${c.userId}' and installation_key_id = '${key}'`,
      );
      console.log(`[attack-w04-01] C1 ${JSON.stringify(histogram(rows))} devices=${devices[0].n}`);
      for (const r of rows.filter((r) => r.result === "ERROR"))
        console.log(`[attack-w04-01] C1 lane ${r.lane}: ${r.error}`);
      assertEquals(Number(devices[0].n), 1, "exactly one device row per (user, key)");
      assertEquals(
        rows
          .filter((r) => r.result !== "accepted")
          .map((r) => `${r.lane}:${r.result}:${r.error ?? ""}`),
        [],
        "registration is idempotent: a concurrent first registration must not surface a SQL error",
      );
      assert(devices[0].attested === true, "an attested lane wins: the device ends attested");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C2 — grant double-submit: same device, N lanes request 2 → ≤ 2 tickets ever, unique generations, no error",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(2);
      await createCaller(sql, c);
      const key = `c2-${RUN}`;
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, c);
        await registerRpc(tx as unknown as Tx, key, true);
      });
      const rows = await burst(
        sql,
        LANES,
        () => c,
        (tx) => issueRpc(tx, key, 2),
      );
      const l = await ledger(sql, c);
      const gens = await sql.unsafe(
        `select count(*)::int as n, count(distinct generation)::int as distinct_gens
           from public.offline_grants g join public.offline_devices d on d.id = g.device_id
          where d.user_id = '${c.userId}' and d.installation_key_id = '${key}'`,
      );
      console.log(
        `[attack-w04-01] C2 ${JSON.stringify(histogram(rows))} ledger=${JSON.stringify(l)} grants=${JSON.stringify(gens[0])}`,
      );
      for (const r of rows)
        console.log(`[attack-w04-01] C2 lane ${r.lane}: ${r.result} ${r.detail ?? r.error}`);
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      assertEquals(l.allocated?.tickets ?? 0, 2, "two tickets ever allocated for a fresh identity");
      assertEquals(l.allocated?.n ?? 0, 2, "one allocated event per ticket");
      assertEquals(
        Number(gens[0].n),
        Number(gens[0].distinct_gens),
        "generations unique per device",
      );
      assertEquals(Number(gens[0].n), LANES, "every accepted lane produced its own generation");
      for (const r of rows)
        assert(r.detail?.includes("n=2"), `lane ${r.lane} must see both tickets: ${r.detail}`);
      assertEquals(await holdCount(sql, c), 2);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C3 — two devices race for the last two ratings: allocated across devices ≤ 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(3);
      await createCaller(sql, c);
      const keys = Array.from({ length: LANES }, (_, i) => `c3-${RUN}-${i}`);
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, c);
        for (const k of keys) await registerRpc(tx as unknown as Tx, k, true);
      });
      const rows = await burst(
        sql,
        LANES,
        () => c,
        (tx, lane) => issueRpc(tx, keys[lane], 2),
      );
      const l = await ledger(sql, c);
      console.log(
        `[attack-w04-01] C3 ${JSON.stringify(histogram(rows))} ledger=${JSON.stringify(l)}`,
      );
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      assert(
        (l.allocated?.tickets ?? 0) <= 2,
        `allocated across ${LANES} devices must be ≤ 2, got ${l.allocated?.tickets}`,
      );
      assertEquals(l.allocated?.tickets ?? 0, 2, "the budget is fully usable");
      assertEquals(await holdCount(sql, c), 2);
      assertEquals(rows.filter((r) => r.result === "accepted").length >= 1, true);
      assertEquals(
        rows.filter((r) => r.result === "access.paywall_required").length,
        LANES - rows.filter((r) => r.result === "accepted").length,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C4 — online reservation vs offline allocation on the same identity: reserved + held ≤ 2",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(4);
      await createCaller(sql, c);
      const key = `c4-${RUN}`;
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, c);
        await registerRpc(tx as unknown as Tx, key, true);
      });
      const rows = await burst(
        sql,
        LANES,
        () => c,
        async (tx, lane) => {
          if (lane % 2 === 0) {
            const r = await tx.unsafe(
              `select result from public.reserve_analysis_permit('c4-${RUN}-${lane}')`,
            );
            return { result: `reserve:${r[0].result}` };
          }
          const r = await issueRpc(tx, key, 2);
          return { result: `issue:${r.result}`, detail: r.detail };
        },
      );
      const l = await ledger(sql, c);
      const reserved = await sql.unsafe(
        `select count(*)::int as n from public.analysis_permits p
          where p.user_id = '${c.userId}' and public.permit_backs_sync(p.status, p.outcome)
            and not exists (select 1 from public.shots s where s.analysis_permit_id = p.id)`,
      );
      console.log(
        `[attack-w04-01] C4 ${JSON.stringify(histogram(rows))} ledger=${JSON.stringify(l)} reserved=${reserved[0].n}`,
      );
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      const total = Number(reserved[0].n) + (l.allocated?.tickets ?? 0);
      assert(
        total <= 2,
        `reserved (${reserved[0].n}) + allocated (${l.allocated?.tickets ?? 0}) must be ≤ 2`,
      );
      assertEquals(total, 2, "the budget is fully usable");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C5 — consume vs release race on one ticket: exactly one terminal event, the loser sees the winner's verdict",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(5);
      await createCaller(sql, c);
      const key = `c5-${RUN}`;
      let ticket = "";
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, c);
        await registerRpc(tx as unknown as Tx, key, true);
        const r = await tx.unsafe(
          `select ticket_ids[1]::text as t from public.issue_offline_grant('${key}', 1)`,
        );
        ticket = String(r[0].t);
      });
      const shot = crypto.randomUUID();
      await ownerScoredShot(sql, c, shot);
      const rows = await burst(
        sql,
        LANES,
        () => c,
        async (tx, lane) => {
          if (lane % 2 === 0) {
            const r = await tx.unsafe(
              `select public.consume_offline_ticket('${ticket}', '${shot}') as v`,
            );
            return { result: `consume:${r[0].v}` };
          }
          const r = await tx.unsafe(
            `select public.release_offline_ticket('${ticket}', 'unused_ticket_returned') as v`,
          );
          return { result: `release:${r[0].v}` };
        },
      );
      const events = await sql.unsafe(
        `select event, count(*)::int as n from public.offline_allocation_ledger where ticket_id = '${ticket}' group by event order by event`,
      );
      const h = histogram(rows);
      console.log(`[attack-w04-01] C5 ${JSON.stringify(h)} events=${JSON.stringify(events)}`);
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      const terminal = events.filter((e) => e.event === "consumed" || e.event === "released");
      assertEquals(
        terminal.length,
        1,
        `exactly one terminal event kind: ${JSON.stringify(events)}`,
      );
      assertEquals(Number(terminal[0].n), 1, "exactly one terminal row");
      const winner = String(terminal[0].event);
      // Every lane of the winning kind is accepted (idempotent replay); every
      // lane of the losing kind names the winning state.
      const consumeAccepted = h["consume:accepted"] ?? 0;
      const releaseAccepted = h["release:accepted"] ?? 0;
      if (winner === "consumed") {
        assertEquals(consumeAccepted, Math.ceil(LANES / 2));
        assertEquals(h["release:offline.ticket_consumed"] ?? 0, Math.floor(LANES / 2));
        assertEquals(releaseAccepted, 0);
      } else {
        assertEquals(releaseAccepted, Math.floor(LANES / 2));
        assertEquals(h["consume:offline.ticket_released"] ?? 0, Math.ceil(LANES / 2));
        assertEquals(consumeAccepted, 0);
      }
      assertEquals(await holdCount(sql, c), winner === "released" ? 1 : 0);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C6 — one shot, two tickets, concurrent consume: the shot is charged once; the other ticket stays held",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const c = caller(6);
      await createCaller(sql, c);
      const key = `c6-${RUN}`;
      let tickets: string[] = [];
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, c);
        await registerRpc(tx as unknown as Tx, key, true);
        const r = await tx.unsafe(
          `select array_to_string(ticket_ids, ',') as t from public.issue_offline_grant('${key}', 2)`,
        );
        tickets = String(r[0].t).split(",");
      });
      assertEquals(tickets.length, 2);
      const shot = crypto.randomUUID();
      await ownerScoredShot(sql, c, shot);
      const rows = await burst(
        sql,
        LANES,
        () => c,
        async (tx, lane) => {
          const r = await tx.unsafe(
            `select public.consume_offline_ticket('${tickets[lane % 2]}', '${shot}') as v`,
          );
          return { result: `t${lane % 2}:${r[0].v}` };
        },
      );
      const consumed = await sql.unsafe(
        `select ticket_id::text as t from public.offline_allocation_ledger where user_id = '${c.userId}' and event = 'consumed' and shot_id = '${shot}'`,
      );
      const h = histogram(rows);
      console.log(`[attack-w04-01] C6 ${JSON.stringify(h)} consumed=${consumed.length}`);
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      assertEquals(consumed.length, 1, "one shot settles exactly one ticket");
      const w = tickets.indexOf(String(consumed[0].t));
      assertEquals(
        h[`t${w}:accepted`],
        LANES / 2,
        "every replay of the winning ticket is accepted",
      );
      assertEquals(
        h[`t${1 - w}:offline.shot_not_chargeable`],
        LANES / 2,
        "the other ticket is refused for this shot",
      );
      assertEquals(await holdCount(sql, c), 1, "the other ticket is still an outstanding hold");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK C7 — interleaved account switch on one installation: two accounts, same key, concurrent register+issue → per-account budgets, no cross-over",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const a = caller(7);
      const b = caller(8);
      await createCaller(sql, a);
      await createCaller(sql, b);
      const key = `c7-${RUN}`;
      // Each account has registered the installation once (the concurrent
      // FIRST registration is C1's subject); the switch races the grants.
      for (const c of [a, b]) {
        await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, c);
          assertEquals((await registerRpc(tx as unknown as Tx, key, true)).result, "accepted");
        });
      }
      const rows = await burst(
        sql,
        LANES,
        (lane) => (lane % 2 === 0 ? a : b),
        async (tx) => {
          const reg = await registerRpc(tx, key, true);
          if (reg.result !== "accepted") return { result: `register:${reg.result}` };
          const r = await issueRpc(tx, key, 2);
          return { result: `issue:${r.result}`, detail: r.detail };
        },
      );
      const la = await ledger(sql, a);
      const lb = await ledger(sql, b);
      const cross = await sql.unsafe(
        `select count(*)::int as n from public.offline_allocation_ledger x join public.offline_allocation_ledger y
            on x.ticket_id = y.ticket_id and x.user_id <> y.user_id
          where x.installation_key_id = '${key}'`,
      );
      console.log(
        `[attack-w04-01] C7 ${JSON.stringify(histogram(rows))} a=${JSON.stringify(la)} b=${JSON.stringify(lb)} cross=${cross[0].n}`,
      );
      for (const r of rows.filter((r) => r.result === "ERROR"))
        console.log(`[attack-w04-01] C7 lane ${r.lane}: ${r.error}`);
      assertEquals(
        rows.filter((r) => r.result === "ERROR"),
        [],
        "no lane may fail with a SQL error",
      );
      assertEquals(la.allocated?.tickets ?? 0, 2);
      assertEquals(lb.allocated?.tickets ?? 0, 2);
      assertEquals(Number(cross[0].n), 0, "a ticket belongs to exactly one account");
      assertEquals(await holdCount(sql, a), 2);
      assertEquals(await holdCount(sql, b), 2);
    } finally {
      await sql.end();
    }
  },
});
