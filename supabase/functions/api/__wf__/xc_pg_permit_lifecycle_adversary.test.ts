/**
 * Adversary round 7 (cluster sync-permit-durability, OFF-24H-02) — REAL
 * Postgres attacks on migration 20260906140000_permit_lifecycle_null_safe.
 *
 * Every scenario drives the actual RPCs / triggers on a disposable postgres:16
 * with shim_auth.sql + every migration applied (./xc_pg_up.sh), as role
 * `authenticated` with a JWT sub, from INDEPENDENT connections whose
 * transactions genuinely overlap (one side is held uncommitted behind a gate
 * while the other issues its statement). Nothing is mocked.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     deno test -A --no-check --config deno.json xc_pg_permit_lifecycle_adversary.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 *
 * Claims attacked (each test names the one it pins):
 *   ADV-1  one permit backs exactly one shot under a concurrent double spend
 *   ADV-2  same shot id replayed with a different payload keeps the original
 *   ADV-3  sweep UPDATE uncommitted vs apply_synced_shot: no deadlock, accepted
 *   ADV-4  apply_synced_shot uncommitted vs sweep: the sweep is not rejected by
 *          the lifecycle guard after the concurrent consume; it updates 0 rows
 *   ADV-5  reserved→consumed vs reserved→finalized/cancelled racing client
 *          PATCH: exactly one wins in either order, never two shots
 *   ADV-6  a permit of another user / of a deleted user / NULL → contract
 *          verdict, no shot row; a non-UUID permit never writes a row
 *   ADV-7  the lifecycle guard's (status, outcome) matrix as `authenticated`
 *          (UPDATE from reserved, direct INSERT): exactly the documented set
 *   ADV-8  no trigger bypass for `authenticated`: other-column UPDATEs,
 *          ALTER TABLE … DISABLE TRIGGER, DROP TRIGGER, CREATE OR REPLACE of
 *          the guard, session_replication_role — all refused
 *   ADV-9  third free rating: two swept permits + two fresh scored ratings →
 *          both late syncs are access.paywall_required, no third row, the
 *          swept permits end released/free_limit_exceeded; premium is accepted
 *   ADV-10 (BREAK, round 7) a settled permit is NOT terminal for the client
 *          role: `authenticated` holds DELETE (policy analysis_permits_delete_own,
 *          20260829140000) and INSERT on id/created_at, so a PostgREST client
 *          can DELETE its finalized/scored permit and re-INSERT the same id as
 *          reserved — apply_synced_shot() then backs a SECOND scored shot with
 *          that permit id. The lifecycle guard never fires (no UPDATE). The
 *          free-rating backstop still caps free accounts, so this is an
 *          invariant escape (claims 2 + 3), not a free-rating bypass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const U1 = "0000000a-d7e0-4000-8000-000000000001";
const U2 = "0000000a-d7e0-4000-8000-000000000002";
const PREMIUM = "0000000a-d7e0-4000-8000-000000000003";

const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

function shotPayload(
  id: string,
  analysisPermitId: string | null,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    analysisPermitId,
    sessionId: null,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: 7,
    confidence: 0.9,
    resultKind: "scored",
    phases: [],
    checkpoints: [],
    versionVector: VERSION_VECTOR,
    ...overrides,
  };
}

let shotSeq = 0;
function shotId(): string {
  shotSeq += 1;
  return `0000000a-d7e0-4000-8000-1${String(shotSeq).padStart(11, "0")}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { wait, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Owner-role reset: the seeded ids repeat across runs against the same
 * disposable DB. The user cascade removes permits/shots/ledger owners. */
async function resetUsers(sql: Sql, premium = false): Promise<void> {
  for (const id of [U1, U2, PREMIUM]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
  if (premium) {
    await sql.unsafe(
      `insert into public.billing_entitlements (user_id, premium, product_key, expires_at)
       values ('${PREMIUM}', true, 'pickle_sensei_pro_lifetime', null)`,
    );
  }
}

/** One statement in its own transaction as `userId`; the tx commits when fn
 * returns, or stays open until `hold` resolves (the concurrency lever). */
function inTx<T>(
  sql: Sql,
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
  hold?: Promise<void>,
): Promise<T> {
  return sql.begin(async (tx) => {
    if (userId) await asUser(tx as unknown as Tx, userId);
    const out = await fn(tx as unknown as Tx);
    if (hold) await hold;
    return out;
  }) as Promise<T>;
}

async function reserve(sql: Sql, userId: string, key: string): Promise<string> {
  const rows = await inTx(
    sql,
    userId,
    async (tx) =>
      await tx.unsafe(
        `select x.result, x.permit_id::text as permit_id from public.reserve_analysis_permit('${key}') x`,
      ),
  );
  assertEquals(rows[0].result, "accepted", `reserve ${key}`);
  return rows[0].permit_id as string;
}

async function sync(tx: Tx, payload: Record<string, unknown>): Promise<string> {
  // postgres.js serializes an object bound to a jsonb parameter itself; a
  // pre-stringified payload would arrive as a jsonb *string* scalar.
  const rows = await tx.unsafe(`select public.apply_synced_shot($1::jsonb) as r`, [payload]);
  return String(rows[0].r);
}

async function permitState(sql: Sql, permitId: string): Promise<string> {
  const rows = await sql.unsafe(
    `select status || '/' || coalesce(outcome, 'NULL') as s from public.analysis_permits where id = '${permitId}'`,
  );
  return rows.length === 0 ? "MISSING" : String(rows[0].s);
}

async function shotCount(sql: Sql, userId: string): Promise<number> {
  const rows = await sql.unsafe(
    `select count(*)::int as n from public.shots where user_id = '${userId}'`,
  );
  return Number(rows[0].n);
}

/** Backdate a reservation past the sweep horizon (owner role; the client
 * holds no UPDATE grant on created_at — ADV-8 proves that). */
async function backdate(sql: Sql, permitId: string): Promise<void> {
  await sql.unsafe(
    `update public.analysis_permits set created_at = now() - interval '25 hours' where id = '${permitId}'`,
  );
}

/** The pg_cron expire-stale-analysis-permits statement, scoped to this file's
 * users so stale rows other suites left on the shared disposable DB do not
 * count. */
const SWEEP_SQL = `update public.analysis_permits set status = 'released', outcome = 'expired' where status = 'reserved' and created_at < now() - interval '24 hours' and user_id in ('${U1}', '${U2}', '${PREMIUM}')`;

/** Fail fast instead of hanging if a lock is never released (a deadlock would
 * surface as 40P01 from Postgres itself; this bounds a missed gate). */
async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what}: no result within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pgError(e: unknown): { code: string; hint: string | null } {
  const err = e as { code?: string; hint?: string };
  return { code: err.code ?? "?", hint: err.hint ?? null };
}

/** One client statement in its own transaction as `userId`: "allowed <rows>"
 * or "<SQLSTATE>:<hint>". (postgres.js surfaces a failed statement again at
 * COMMIT, so the whole transaction is the unit that is caught.) */
async function attempt(sql: Sql, userId: string, stmt: string): Promise<string> {
  try {
    const n = await inTx(sql, userId, async (tx) => (await tx.unsafe(stmt)).count);
    return `allowed ${n}`;
  } catch (e) {
    const { code, hint } = pgError(e);
    return `${code}:${hint}`;
  }
}

Deno.test({
  name: "ADV-1: one permit + two shot ids in two concurrent sessions → exactly one accepted, the other access.permit_not_reserved, one shot row, permit finalized/scored",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv1");
      const a = shotId();
      const b = shotId();
      const [ra, rb] = await Promise.all([
        inTx(sql, U1, (tx) => sync(tx, shotPayload(a, permit))),
        inTx(sql, U1, (tx) => sync(tx, shotPayload(b, permit))),
      ]);
      assertEquals([ra, rb].sort(), ["accepted", "access.permit_not_reserved"]);
      assertEquals(await shotCount(sql, U1), 1);
      assertEquals(await permitState(sql, permit), "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-2: same permit, same shot id, different payload → both 'accepted', the original row is preserved byte-for-byte",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv2");
      const id = shotId();
      const r1 = await inTx(sql, U1, (tx) =>
        sync(tx, shotPayload(id, permit, { overallScore: 3 })),
      );
      const r2 = await inTx(sql, U1, (tx) =>
        sync(tx, shotPayload(id, permit, { overallScore: 9.9, shotType: "drive" })),
      );
      assertEquals([r1, r2], ["accepted", "accepted"]);
      const rows = await sql.unsafe(
        `select overall_score::text as s, shot_type from public.shots where id = '${id}'`,
      );
      assertEquals(rows.length, 1);
      assertEquals(Number(rows[0].s), 3);
      assertEquals(rows[0].shot_type, "dink");
      assertEquals(await permitState(sql, permit), "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-3: sweep UPDATE held uncommitted while apply_synced_shot locks the permit → the sync waits (no deadlock), then is accepted on the swept row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv3");
      await backdate(sql, permit);
      const g = gate();
      const sweep = inTx(sql, null, async (tx) => (await tx.unsafe(SWEEP_SQL)).count, g.wait);
      await sleep(300);
      const t0 = performance.now();
      const syncP = inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit)));
      await sleep(500);
      g.open();
      const [swept, verdict] = await within(Promise.all([sweep, syncP]), 15_000, "ADV-3");
      assertEquals(swept, 1);
      assertEquals(verdict, "accepted");
      assert(
        performance.now() - t0 >= 450,
        "the sync must have blocked behind the sweep's row lock",
      );
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(await shotCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-4: apply_synced_shot held uncommitted (permit consumed) while the sweep runs → the sweep waits, is NOT rejected by the lifecycle guard, and updates 0 rows",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv4");
      await backdate(sql, permit);
      const g = gate();
      const syncP = inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit)), g.wait);
      await sleep(300);
      const sweep = inTx(sql, null, async (tx) => {
        try {
          return `swept ${(await tx.unsafe(SWEEP_SQL)).count}`;
        } catch (e) {
          const { code, hint } = pgError(e);
          return `error ${code} ${hint}`;
        }
      });
      await sleep(500);
      g.open();
      const [verdict, swept] = await within(Promise.all([syncP, sweep]), 15_000, "ADV-4");
      assertEquals(verdict, "accepted");
      assertEquals(swept, "swept 0");
      assertEquals(await permitState(sql, permit), "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-5: reserved→consumed (sync) racing reserved→finalized/cancelled (client PATCH): exactly one wins in either order, never two outcomes, never a shot on a cancelled permit",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 6 });
    try {
      await resetUsers(sql);
      const cancelSql = (permit: string) =>
        `update public.analysis_permits set status = 'finalized', outcome = 'cancelled' where id = '${permit}' and status = 'reserved'`;

      // sync first, cancel blocks on the row lock
      {
        const permit = await reserve(sql, U1, "adv5a");
        const g = gate();
        const syncP = inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit)), g.wait);
        await sleep(300);
        const cancel = inTx(sql, U1, async (tx) => {
          try {
            return `updated ${(await tx.unsafe(cancelSql(permit))).count}`;
          } catch (e) {
            return `error ${pgError(e).code}`;
          }
        });
        await sleep(500);
        g.open();
        const [verdict, c] = await within(Promise.all([syncP, cancel]), 15_000, "ADV-5a");
        assertEquals(verdict, "accepted");
        assertEquals(c, "updated 0");
        assertEquals(await permitState(sql, permit), "finalized/scored");
      }
      // cancel first, sync blocks on the row lock
      {
        const permit = await reserve(sql, U1, "adv5b");
        const g = gate();
        const cancel = inTx(
          sql,
          U1,
          async (tx) => (await tx.unsafe(cancelSql(permit))).count,
          g.wait,
        );
        await sleep(300);
        const syncP = inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit)));
        await sleep(500);
        g.open();
        const [c, verdict] = await within(Promise.all([cancel, syncP]), 15_000, "ADV-5b");
        assertEquals(c, 1);
        assertEquals(verdict, "access.permit_not_reserved");
        assertEquals(await permitState(sql, permit), "finalized/cancelled");
      }
      assertEquals(await shotCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-6: permit of another user / of a deleted user / NULL → access.permit_not_found and no row; a non-UUID permit never writes a row",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const theirs = await reserve(sql, U2, "adv6-theirs");
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), theirs))),
        "access.permit_not_found",
      );
      assertEquals(await permitState(sql, theirs), "reserved/NULL");

      const orphan = await reserve(sql, U2, "adv6-orphan");
      await sql.unsafe(`delete from auth.users where id = '${U2}'`);
      assertEquals(await permitState(sql, orphan), "MISSING");
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), orphan))),
        "access.permit_not_found",
      );

      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), null))),
        "access.permit_not_found",
      );

      // Garbage ids are stopped at the edge (400 validation.shots_sync) and
      // the RPC itself never lets one through: whatever it raises, no row.
      let garbage = "returned";
      try {
        garbage = await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), "not-a-uuid")));
      } catch (e) {
        garbage = `error ${pgError(e).code}`;
      }
      assert(garbage !== "accepted", `garbage permit id must never be accepted (got ${garbage})`);
      assertEquals(await shotCount(sql, U1), 0);
    } finally {
      await sql.end();
    }
  },
});

const PAIRS: Array<[string | null, string | null]> = [
  ["reserved", null],
  ["reserved", ""],
  ["reserved", "scored"],
  ["reserved", "expired"],
  ["released", null],
  ["released", ""],
  ["released", "expired"],
  ["released", "low_confidence"],
  ["released", "free_limit_exceeded"],
  ["released", "scored"],
  ["released", "cancelled"],
  ["released", "bogus"],
  ["finalized", null],
  ["finalized", ""],
  ["finalized", "scored"],
  ["finalized", "low_confidence"],
  ["finalized", "cancelled"],
  ["finalized", "failed"],
  ["finalized", "unsupported"],
  ["finalized", "incorrect_recognition"],
  ["finalized", "expired"],
  ["finalized", "free_limit_exceeded"],
  ["finalized", "bogus"],
  ["Reserved", null],
  ["RELEASED", "expired"],
  ["consumed", "scored"],
  ["", null],
  [null, null],
];
const KNOWN_OUTCOMES = new Set([
  "scored",
  "low_confidence",
  "cancelled",
  "failed",
  "unsupported",
  "incorrect_recognition",
  "expired",
  "free_limit_exceeded",
]);
/** The documented shape: reserved ⇔ outcome NULL; any other status carries a
 * known outcome. (status NULL is the NOT NULL constraint's 23502.) */
function shapeAllowed(status: string | null, outcome: string | null): boolean {
  if (status === null) return false;
  if (status === "reserved") return outcome === null;
  if (status !== "released" && status !== "finalized") return false; // CHECK vocabulary
  return outcome !== null && KNOWN_OUTCOMES.has(outcome);
}
const lit = (v: string | null) => (v === null ? "null" : `'${v}'`);

Deno.test({
  name: "ADV-7: lifecycle guard matrix as authenticated — UPDATE from reserved and direct INSERT accept exactly the documented (status, outcome) set; every escape is 23514 + access.permit_transition_rejected",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const failures: string[] = [];
      for (const [status, outcome] of PAIRS) {
        const label = `${status ?? "NULL"}/${outcome ?? "NULL"}`;
        const expectAllowed = shapeAllowed(status, outcome);
        // Out-of-vocabulary statuses are 23514 from whichever fires first (the
        // guard's shape check, or the pre-existing CHECK without a hint);
        // everything else the guard refuses with the contract hint.
        const inVocabulary =
          status === "reserved" || status === "released" || status === "finalized";
        const want = expectAllowed
          ? "allowed 1"
          : status === null
            ? "23502:null"
            : inVocabulary
              ? "23514:access.permit_transition_rejected"
              : "23514:";
        const matches = (got: string) => (want === "23514:" ? got.startsWith(want) : got === want);
        // reserve_analysis_permit caps LIVE reservations at the remaining free
        // ratings, so each pair starts from a clean slate (owner cleanup).
        await sql.unsafe(`delete from public.analysis_permits where user_id = '${U1}'`);

        const permit = await reserve(sql, U1, `adv7-u-${label}`);
        const upd = await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = ${lit(status)}, outcome = ${lit(outcome)} where id = '${permit}'`,
        );
        if (!matches(upd)) failures.push(`UPDATE reserved→${label}: expected ${want}, got ${upd}`);

        const ins = await attempt(
          sql,
          U1,
          `insert into public.analysis_permits (user_id, idempotency_key, status, outcome)
           values ('${U1}', 'adv7-i-${label}', ${lit(status)}, ${lit(outcome)})`,
        );
        if (!matches(ins)) failures.push(`INSERT ${label}: expected ${want}, got ${ins}`);
      }
      // A settled row is terminal for every move, including "back to reserved".
      await sql.unsafe(`delete from public.analysis_permits where user_id = '${U1}'`);
      const settled = await reserve(sql, U1, "adv7-terminal");
      assertEquals(
        await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = 'finalized', outcome = 'scored' where id = '${settled}'`,
        ),
        "allowed 1",
      );
      for (const [status, outcome] of [
        ["reserved", null],
        ["released", "expired"],
        ["finalized", "cancelled"],
      ] as const) {
        const r = await attempt(
          sql,
          U1,
          `update public.analysis_permits set status = ${lit(status)}, outcome = ${lit(outcome)} where id = '${settled}'`,
        );
        if (r !== "23514:access.permit_transition_rejected") {
          failures.push(
            `finalized/scored → ${status}/${outcome ?? "NULL"}: expected refused, got ${r}`,
          );
        }
      }
      assertEquals(failures, []);
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-8: no bypass for authenticated — created_at/user_id/id/idempotency_key UPDATE, TRUNCATE, DISABLE/DROP TRIGGER, replacing the guard or the predicate, session_replication_role are all refused",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv8");
      const attempts: Array<[string, string]> = [
        [
          "created_at backdate",
          `update public.analysis_permits set created_at = now() - interval '30 hours' where id = '${permit}'`,
        ],
        [
          "user_id swap",
          `update public.analysis_permits set user_id = '${U2}' where id = '${permit}'`,
        ],
        [
          "id swap",
          `update public.analysis_permits set id = gen_random_uuid() where id = '${permit}'`,
        ],
        [
          "idempotency_key",
          `update public.analysis_permits set idempotency_key = 'zz' where id = '${permit}'`,
        ],
        ["truncate", `truncate public.analysis_permits`],
        ["disable trigger all", `alter table public.analysis_permits disable trigger all`],
        ["disable trigger user", `alter table public.analysis_permits disable trigger user`],
        [
          "disable guard",
          `alter table public.analysis_permits disable trigger analysis_permits_guard_lifecycle`,
        ],
        ["drop guard", `drop trigger analysis_permits_guard_lifecycle on public.analysis_permits`],
        [
          "replace guard fn",
          `create or replace function public.guard_analysis_permit_lifecycle() returns trigger language plpgsql as $$ begin return new; end $$`,
        ],
        [
          "replace predicate",
          `create or replace function public.permit_backs_sync(text, text) returns boolean language sql as $$ select true $$`,
        ],
        ["replication role", `set session_replication_role = replica`],
      ];
      const outcomes: string[] = [];
      for (const [label, stmt] of attempts) {
        outcomes.push(`${label}: ${await attempt(sql, U1, stmt)}`);
      }
      const allowed = outcomes.filter((o) => /: allowed/.test(o));
      assertEquals(allowed, [], `authenticated must not be able to: ${allowed.join("; ")}`);
      // insufficient_privilege (grant, ownership, or GUC) is the only refusal class.
      for (const o of outcomes) {
        assert(/: 42501:/.test(o), `unexpected refusal class: ${o}`);
      }
      assertEquals(await permitState(sql, permit), "reserved/NULL");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-9: third free rating — P1+P2 swept, P3+P4 fresh scored (count 2), late syncs of P1/P2 → access.paywall_required, no third row, swept permits end released/free_limit_exceeded; a premium account's late sync is accepted",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql, true);
      const p1 = await reserve(sql, U1, "adv10-p1");
      const p2 = await reserve(sql, U1, "adv10-p2");
      await backdate(sql, p1);
      await backdate(sql, p2);
      assertEquals((await sql.unsafe(SWEEP_SQL)).count, 2);
      assertEquals(await permitState(sql, p1), "released/expired");

      const p3 = await reserve(sql, U1, "adv10-p3");
      const p4 = await reserve(sql, U1, "adv10-p4");
      assertEquals(await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), p3))), "accepted");
      assertEquals(await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), p4))), "accepted");
      const access = await inTx(
        sql,
        U1,
        async (tx) => (await tx.unsafe(`select * from public.access_state()`))[0],
      );
      assertEquals(Number(access.scored_count), 2);

      const late1 = shotId();
      const late2 = shotId();
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(late1, p1))),
        "access.paywall_required",
      );
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(late2, p2))),
        "access.paywall_required",
      );
      assertEquals(await permitState(sql, p1), "released/free_limit_exceeded");
      assertEquals(await permitState(sql, p2), "released/free_limit_exceeded");
      // A retry after the refusal is the same permanent verdict, never a row.
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(late1, p1))),
        "access.permit_not_reserved",
      );
      assertEquals(await shotCount(sql, U1), 2);
      // A fifth reservation is refused too.
      const fifth = await inTx(
        sql,
        U1,
        async (tx) =>
          (await tx.unsafe(`select result from public.reserve_analysis_permit('adv10-p5')`))[0]
            .result,
      );
      assertEquals(fifth, "access.paywall_required");

      // Premium: swept permit, late sync accepted at any count.
      const pp = await reserve(sql, PREMIUM, "adv10-premium");
      await backdate(sql, pp);
      assertEquals((await sql.unsafe(SWEEP_SQL)).count, 1);
      assertEquals(
        await inTx(sql, PREMIUM, (tx) => sync(tx, shotPayload(shotId(), pp))),
        "accepted",
      );
      assertEquals(await permitState(sql, pp), "finalized/scored");
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ADV-10: a settled permit is terminal for the client role — authenticated cannot DELETE its finalized/scored permit and re-INSERT the same id as reserved so the RPC backs a second shot with it",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      await resetUsers(sql);
      const permit = await reserve(sql, U1, "adv10");
      assertEquals(
        await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit))),
        "accepted",
      );
      assertEquals(await permitState(sql, permit), "finalized/scored");

      // PostgREST-equivalent: DELETE /rest/v1/analysis_permits?id=eq.<permit>
      const del = await attempt(
        sql,
        U1,
        `delete from public.analysis_permits where id = '${permit}'`,
      );
      // then POST /rest/v1/analysis_permits {id: <permit>, user_id, idempotency_key}
      const ins = await attempt(
        sql,
        U1,
        `insert into public.analysis_permits (id, user_id, idempotency_key) values ('${permit}', '${U1}', 'adv10-again')`,
      );
      const second = await inTx(sql, U1, (tx) => sync(tx, shotPayload(shotId(), permit)));

      const escaped = del.startsWith("allowed 1") && ins.startsWith("allowed 1");
      assert(
        !escaped,
        `settled permit ${permit} was deleted (${del}) and re-inserted as reserved (${ins}) by the client role; ` +
          `second sync on the same permit id: ${second}; shots now ${await shotCount(sql, U1)}, permit ${await permitState(sql, permit)}`,
      );
      assertEquals(await permitState(sql, permit), "finalized/scored");
      assertEquals(second, "access.permit_not_reserved");
      assertEquals(await shotCount(sql, U1), 1);
    } finally {
      await sql.end();
    }
  },
});
