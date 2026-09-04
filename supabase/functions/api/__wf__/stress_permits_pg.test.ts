/**
 * stress: POST /v1/analysis-permits — REAL handler + REAL RPCs on a
 * disposable postgres:16 with shim_auth.sql + every migration applied
 * (lens `failure-load`, Postgres-backed half).
 *
 * The in-process route (stress_permits_harness.ts) has its PostgREST fake
 * pointed at a real database: every rpc/reserve_analysis_permit and
 * rpc/access_state the handler issues runs `select * from
 * public.reserve_analysis_permit($1)` / `public.access_state()` on its own
 * connection, in a transaction as role `authenticated` with the caller's
 * JWT sub, then COMMITs — exactly what PostgREST does.
 *
 *   ./xc_pg_up.sh                       # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_ITER=1000 STRESS_OUT_DIR=/tmp/stress \
 *     deno test -A --no-check --config deno.json stress_permits_pg.test.ts
 *
 * Without XC_PG_URL (alias STRESS_PG_URL / PICKLE_AUDIT_PG_URL) every test is
 * `ignore`d — an ignored run is NOT a pass.
 *
 * Scenarios
 *   PG-LOAD   STRESS_ITER sequential requests over a premium pool: p50/p95
 *             end-to-end latency (handler + real SQL) and RPC count/request.
 *   PG-SAME   N parallel requests, one user, ONE idempotency key → one row,
 *             every answer 200 with that row's id (duplicate delivery).
 *   PG-DIFF   N parallel requests, one FREE user, N different keys → exactly
 *             2 accepted, N-2 × 402, 2 rows (free-rating double spend).
 *   PG-LOCK   another session holds the user's access_lock_key: the request
 *             blocks; with the hosted role's statement_timeout the RPC fails
 *             → 503, and once the lock is released the same key succeeds.
 *   PG-KILL   the RPC's backend is terminated mid-statement → 503, no row
 *             leaked, replay succeeds.
 *   PG-ACCESS access_state fails AFTER the row was written (injected at the
 *             PostgREST layer) → 503; replay returns the SAME permit.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  deriveSeed,
  loadStressHarness,
  observe,
  percentile,
  Prng,
  type RpcBackend,
  STRESS_ITER,
  STRESS_SEED,
  type StressHarness,
  UPSTREAM_DETAIL_MARKER,
  writeReport,
} from "./stress_permits_harness.ts";

const PG_URL =
  Deno.env.get("XC_PG_URL") ??
  Deno.env.get("STRESS_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ??
  "";
const ignore = PG_URL === "";
const LANES = Math.max(4, Math.min(30, Number(Deno.env.get("STRESS_PG_LANES") ?? 16)));

type Sql = ReturnType<typeof postgres>;

interface PgBackend extends RpcBackend {
  sql: Sql;
  /** Applied inside every RPC transaction (e.g. a statement_timeout). */
  perTxSetup: string[];
  rpcCount: number;
  /** pid of the most recent RPC backend, for PG-KILL. */
  lastPid: number | null;
  /** Resolves when the next RPC has begun executing (set by PG-KILL). */
  onRpcStart: ((pid: number) => void) | null;
}

function makeBackend(sql: Sql): PgBackend {
  const backend: PgBackend = {
    sql,
    perTxSetup: [],
    rpcCount: 0,
    lastPid: null,
    onRpcStart: null,
    async reserve(userId, key) {
      return await run(`select * from public.reserve_analysis_permit($1)`, userId, [key]);
    },
    async access(userId) {
      return await run(`select * from public.access_state()`, userId, []);
    },
  };
  async function run(statement: string, userId: string, params: string[]): Promise<unknown[]> {
    backend.rpcCount += 1;
    return (await sql.begin(async (tx) => {
      const pidRow = await tx.unsafe(`select pg_backend_pid() as pid`);
      const pid = Number(pidRow[0].pid);
      backend.lastPid = pid;
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
      backend.onRpcStart?.(pid);
      for (const s of backend.perTxSetup) await tx.unsafe(s);
      const rows = await tx.unsafe(statement, params);
      return rows.map((r) => ({ ...r }));
    })) as unknown[];
  }
  return backend;
}

async function createUser(sql: Sql, userId: string, premium: boolean): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into auth.identities (provider, provider_id, user_id, identity_data)
     values ('google', 'g-${userId}', '${userId}', '{"sub":"g-${userId}"}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, email, provider) values ('${userId}', '${userId}@example.com', 'google') on conflict (id) do nothing`,
  );
  if (premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key) values ('${userId}', true, 'pickle_sensei_pro')
       on conflict (user_id) do update set premium = true, expires_at = null`,
    );
  }
}

async function permitRows(
  sql: Sql,
  userId: string,
): Promise<Array<{ id: string; idempotency_key: string; status: string }>> {
  const rows = await sql.unsafe(
    `select id::text as id, idempotency_key, status from public.analysis_permits where user_id = '${userId}' order by created_at`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    idempotency_key: String(r.idempotency_key),
    status: String(r.status),
  }));
}

let shared: { h: StressHarness; sql: Sql; backend: PgBackend } | null = null;
async function setup(): Promise<{ h: StressHarness; sql: Sql; backend: PgBackend }> {
  if (shared) {
    shared.h.upstream.reset();
    shared.h.upstream.rpcBackend = shared.backend;
    shared.backend.perTxSetup = [];
    shared.backend.onRpcStart = null;
    return shared;
  }
  const sql = postgres(PG_URL, { max: LANES + 4, onnotice: () => {} });
  const h = await loadStressHarness({ seed: STRESS_SEED });
  const backend = makeBackend(sql);
  h.upstream.rpcBackend = backend;
  shared = { h, sql, backend };
  return shared;
}

async function user(h: StressHarness, sql: Sql, prng: Prng, premium: boolean) {
  const id = prng.uuid();
  await createUser(sql, id, premium);
  h.upstream.addUser({ id, premium });
  return { id, token: h.upstream.mintSession(id), ip: h.freshIp() };
}

Deno.test({
  name: "stress/permits pg PG-LOAD: STRESS_ITER real-RPC requests — p50/p95 and RPCs per request",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql, backend } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-load"));
    // Pool sized so no user exceeds the 30/min route budget (warm-up + ≤ 25 hits).
    const POOL = Math.max(40, Math.ceil(STRESS_ITER / 25));
    const users = [];
    for (let i = 0; i < POOL; i++) {
      const u = await user(h, sql, prng, true);
      const warm = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `warm-${prng.hex(6)}` },
        }),
      );
      assertEquals(warm.status, 200, warm.text);
      users.push(u);
    }
    const latencies: number[] = [];
    const rpcHist: Record<number, number> = {};
    const statuses: Record<number, number> = {};
    const t0 = performance.now();
    for (let i = 0; i < STRESS_ITER; i++) {
      const u = users[i % POOL];
      const before = backend.rpcCount;
      const o = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `pg-load-${i}-${prng.hex(6)}` },
        }),
      );
      statuses[o.status] = (statuses[o.status] ?? 0) + 1;
      const rpcs = backend.rpcCount - before;
      rpcHist[rpcs] = (rpcHist[rpcs] ?? 0) + 1;
      latencies.push(o.latencyMs);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const report = {
      seed: STRESS_SEED,
      requests: STRESS_ITER,
      pool: POOL,
      statuses,
      elapsedMs: Math.round(performance.now() - t0),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted[sorted.length - 1],
      rpcsPerRequest: rpcHist,
    };
    console.log(`[stress] pg load: ${JSON.stringify(report)}`);
    await writeReport("permits_pg_load", report);
    assertEquals(Object.keys(statuses), ["200"], JSON.stringify(statuses));
    assertEquals(rpcHist, { 2: STRESS_ITER }, "exactly 2 RPC transactions per warm request");
    // Every request left exactly one row (no duplicate, no lost write).
    let rows = 0;
    for (const u of users) rows += (await permitRows(sql, u.id)).length;
    assertEquals(rows, STRESS_ITER + POOL);
  },
});

Deno.test({
  name: "stress/permits pg PG-SAME: parallel same-key delivery collapses to one real row",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-same"));
    const results: Array<{ round: number; ids: number; statuses: number[]; rows: number }> = [];
    for (let round = 0; round < 3; round++) {
      const u = await user(h, sql, prng, false);
      const key = `pg-same-${prng.hex(8)}`;
      const answers = await Promise.all(
        Array.from({ length: LANES }, () =>
          observe(
            h.handler,
            h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
          ),
        ),
      );
      const ids = new Set(answers.filter((a) => a.status === 200).map((a) => a.permitId));
      const rows = await permitRows(sql, u.id);
      results.push({
        round,
        ids: ids.size,
        statuses: answers.map((a) => a.status),
        rows: rows.length,
      });
      assertEquals(
        answers.map((a) => a.status),
        Array(LANES).fill(200),
        `round ${round}: ${answers.map((a) => a.text).join(" | ")}`,
      );
      assertEquals(ids.size, 1, `round ${round}: ${ids.size} distinct permit ids for one key`);
      assertEquals(rows.length, 1, `round ${round}: ${rows.length} rows for one key`);
      assertEquals(rows[0].id, [...ids][0]);
    }
    console.log(`[stress] pg same-key: ${JSON.stringify(results)}`);
    await writeReport("permits_pg_same_key", { seed: STRESS_SEED, lanes: LANES, results });
  },
});

Deno.test({
  name: "stress/permits pg PG-DIFF: parallel different keys for a free user — exactly two accepted (no double spend)",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-diff"));
    const results: Array<{
      round: number;
      accepted: number;
      paywalled: number;
      other: number[];
      rows: number;
      p50Ms: number;
      p95Ms: number;
    }> = [];
    for (let round = 0; round < 3; round++) {
      const u = await user(h, sql, prng, false);
      const answers = await Promise.all(
        Array.from({ length: LANES }, (_, i) =>
          observe(
            h.handler,
            h.permitRequest({
              token: u.token,
              ip: u.ip,
              body: { idempotencyKey: `pg-diff-${round}-${i}-${prng.hex(4)}` },
            }),
          ),
        ),
      );
      const accepted = answers.filter((a) => a.status === 200).length;
      const paywalled = answers.filter(
        (a) => a.status === 402 && a.code === "access.paywall_required",
      ).length;
      const other = answers
        .filter((a) => a.status !== 200 && a.status !== 402)
        .map((a) => a.status);
      const rows = await permitRows(sql, u.id);
      const sorted = answers.map((a) => a.latencyMs).sort((x, y) => x - y);
      results.push({
        round,
        accepted,
        paywalled,
        other,
        rows: rows.length,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
      });
      assertEquals(other, [], `round ${round}: unexpected statuses`);
      assertEquals(
        accepted,
        2,
        `round ${round}: ${accepted} accepted under ${LANES} parallel keys`,
      );
      assertEquals(paywalled, LANES - 2);
      assertEquals(rows.length, 2);
      // The access payload every accepted answer carried is consistent with 2 reserved.
      for (const a of answers.filter((x) => x.status === 200)) {
        const access = (
          a.body as { access: { freeRatings: { reserved: number; availableToReserve: number } } }
        ).access;
        assert(
          access.freeRatings.reserved >= 1 && access.freeRatings.reserved <= 2,
          JSON.stringify(access),
        );
      }
    }
    console.log(`[stress] pg diff-key: ${JSON.stringify(results)}`);
    await writeReport("permits_pg_diff_key", { seed: STRESS_SEED, lanes: LANES, results });
  },
});

Deno.test({
  name: "stress/permits pg PG-LOCK: lock holder + statement_timeout → 503, then the same key succeeds",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql, backend } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-lock"));
    const u = await user(h, sql, prng, true);
    const warm = await observe(
      h.handler,
      h.permitRequest({
        token: u.token,
        ip: u.ip,
        body: { idempotencyKey: `warm-${prng.hex(6)}` },
      }),
    );
    assertEquals(warm.status, 200);
    // Hosted Supabase gives `authenticated` statement_timeout = 8s; scaled to 500ms here.
    backend.perTxSetup = [`set local statement_timeout = '500ms'`];
    const key = `pg-lock-${prng.hex(8)}`;
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = sql.begin(async (tx) => {
      await tx.unsafe(`select pg_advisory_xact_lock(public.access_lock_key('${u.id}'))`);
      await released;
    });
    // Wait until the holder has the lock.
    for (let i = 0; i < 100; i++) {
      const locks = await sql.unsafe(
        `select count(*)::int as n from pg_locks where locktype = 'advisory' and granted`,
      );
      if (Number(locks[0].n) > 0) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const t0 = performance.now();
    const blocked = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
    );
    const blockedMs = performance.now() - t0;
    release();
    await holder;
    backend.perTxSetup = [];
    const replay = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
    );
    const rows = (await permitRows(sql, u.id)).filter((r) => r.idempotency_key === key);
    console.log(
      `[stress] pg lock: blocked=${blocked.status} after ${blockedMs.toFixed(0)}ms; replay=${replay.status}; rows=${rows.length}`,
    );
    await writeReport("permits_pg_lock", {
      seed: STRESS_SEED,
      blockedStatus: blocked.status,
      blockedMs,
      replayStatus: replay.status,
      rows: rows.length,
      body: blocked.body,
    });
    assertEquals(blocked.status, 503, blocked.text);
    assert(blockedMs >= 450, `statement_timeout fired after ${blockedMs.toFixed(0)}ms`);
    assert(
      !blocked.text.includes("statement timeout") && !blocked.text.includes("canceling"),
      "503 body stays generic",
    );
    assertEquals(replay.status, 200, replay.text);
    assertEquals(rows.length, 1, "one row after the failed attempt + successful replay");
  },
});

Deno.test({
  name: "stress/permits pg PG-KILL: backend terminated mid-RPC → 503, no leaked row, replay succeeds",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql, backend } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-kill"));
    const u = await user(h, sql, prng, true);
    const warm = await observe(
      h.handler,
      h.permitRequest({
        token: u.token,
        ip: u.ip,
        body: { idempotencyKey: `warm-${prng.hex(6)}` },
      }),
    );
    assertEquals(warm.status, 200);
    const key = `pg-kill-${prng.hex(8)}`;
    const killer = postgres(PG_URL, { max: 1, onnotice: () => {} });
    // Terminate the RPC's backend the moment the RPC transaction starts.
    backend.onRpcStart = (pid) => {
      backend.onRpcStart = null;
      void killer.unsafe(`select pg_terminate_backend(${pid})`).catch(() => undefined);
    };
    // Give the terminate a window: slow the statement with pg_sleep inside the same tx.
    backend.perTxSetup = [`select pg_sleep(0.3)`];
    const killed = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
    );
    backend.perTxSetup = [];
    backend.onRpcStart = null;
    await killer.end();
    const replay = await observe(
      h.handler,
      h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
    );
    const rows = (await permitRows(sql, u.id)).filter((r) => r.idempotency_key === key);
    console.log(
      `[stress] pg kill: killed=${killed.status} replay=${replay.status} rows=${rows.length} body=${killed.text}`,
    );
    await writeReport("permits_pg_kill", {
      seed: STRESS_SEED,
      killedStatus: killed.status,
      replayStatus: replay.status,
      rows: rows.length,
      body: killed.body,
    });
    assertEquals(killed.status, 503, killed.text);
    assert(
      !killed.text.includes("terminat") && !killed.text.includes("administrator"),
      "503 body stays generic",
    );
    assertEquals(replay.status, 200, replay.text);
    assertEquals(rows.length, 1);
    assertEquals(replay.permitId, rows[0].id);
  },
});

Deno.test({
  name: "stress/permits pg PG-ACCESS: access_state fails after the real row was written → 503; replay returns the same permit",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const { h, sql } = await setup();
    const prng = new Prng(deriveSeed(STRESS_SEED, "pg-access"));
    const outcomes: Array<Record<string, unknown>> = [];
    const faults = [
      {
        id: "500",
        fault: {
          kind: "status" as const,
          status: 500,
          body: { message: `${UPSTREAM_DETAIL_MARKER} boom`, code: "XX000" },
        },
      },
      { id: "socket", fault: { kind: "throw" as const } },
      { id: "empty", fault: { kind: "status" as const, status: 200, body: [] } },
    ];
    for (const f of faults) {
      const u = await user(h, sql, prng, false);
      const warm = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `warm-${prng.hex(6)}` },
        }),
      );
      assertEquals(warm.status, 200);
      const key = `pg-access-${f.id}-${prng.hex(6)}`;
      h.upstream.inject("access", f.fault, 1);
      const failed = await observe(
        h.handler,
        h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
      );
      h.upstream.clearFaults();
      const replay = await observe(
        h.handler,
        h.permitRequest({ token: u.token, ip: u.ip, body: { idempotencyKey: key } }),
      );
      const third = await observe(
        h.handler,
        h.permitRequest({
          token: u.token,
          ip: u.ip,
          body: { idempotencyKey: `pg-access-third-${prng.hex(6)}` },
        }),
      );
      const rows = await permitRows(sql, u.id);
      outcomes.push({
        fault: f.id,
        failed: failed.status,
        replay: replay.status,
        replayPermit: replay.permitId,
        third: third.status,
        rows: rows.length,
      });
      assertEquals(failed.status, 503, failed.text);
      assert(!failed.text.includes(UPSTREAM_DETAIL_MARKER));
      assertEquals(replay.status, 200, replay.text);
      assertEquals(rows.filter((r) => r.idempotency_key === key).length, 1);
      assertEquals(
        replay.permitId,
        rows.find((r) => r.idempotency_key === key)!.id,
        "replay returns the row written before the fault",
      );
      // warm + key = both free ratings reserved → a third key is paywalled (the failed attempt did not leak a rating).
      assertEquals(third.status, 402, third.text);
      assertEquals(rows.length, 2);
    }
    console.log(`[stress] pg access-after-write: ${JSON.stringify(outcomes)}`);
    await writeReport("permits_pg_access_after_write", { seed: STRESS_SEED, outcomes });
  },
});

Deno.test({
  name: "stress/permits pg: close pool",
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    if (shared) {
      await shared.sql.end({ timeout: 5 });
      shared = null;
    }
  },
});
