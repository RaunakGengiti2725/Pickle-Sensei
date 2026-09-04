/**
 * stress-consent-withdraw — REAL Postgres half.
 *
 * POST /v1/me/consent/withdraw performs no RPC: it is three PostgREST calls
 * against public.consent_records (index.ts:1868-1888) —
 *   1. select scope, action, consent_version, created_at
 *        where user_id = auth.uid() order by created_at, id
 *   2. insert (user_id, scope, consent_version, action, source, device)
 *   3. the same select again, folded into the response.
 * So the database-layer questions are: does the ledger stay append-only for
 * `authenticated`, is it RLS-isolated, can two independent transactions lose
 * or duplicate a row, does now() collide across concurrent transactions (the
 * fold's `order by created_at, id` tie-breaks on a RANDOM gen_random_uuid),
 * and is the read→insert window (no unique key, no lock, no re-read) wide
 * enough for a withdrawal to persist a stale consent_version?
 *
 * Every lane is its OWN connection in its OWN transaction as role
 * `authenticated` with the caller's JWT sub, released from a barrier so the
 * statements genuinely overlap; clock_timestamp() at statement start/end
 * proves the overlap in the artifact.
 *
 *   ./xc_pg_up.sh                       # postgres:16 + shim_auth + every migration
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     XC_OUT_DIR=/tmp/stress-consent/ deno test -A --no-check --config deno.json \
 *     stress_consent_withdraw_pg_concurrency.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  histogram,
  type Invariant,
  Prng,
  writeReport,
  XC_SEED,
} from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 12);
const SEED = envInt("STRESS_SEED", XC_SEED);
const SCOPE = "model_training";
const VERSION = "model-training-v1";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Owner-role setup: auth.users → handle_new_user trigger → public.profiles. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
       values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  await sql.unsafe(
    `insert into public.profiles (id, email, provider)
       values ('${userId}', '${userId}@example.com', 'google')
       on conflict (id) do nothing`,
  );
}

/** One PostgREST request = one transaction of its own, as role `authenticated`
 *  with the caller's sub. `created_at default now()` is that transaction's
 *  timestamp, so modelling the route's read/insert/read as ONE transaction
 *  would stamp all three with the read's clock — the route does not do that. */
async function stmt(sql: Sql, userId: string, query: string) {
  return await sql.begin(async (tx) => {
    await asUser(tx, userId);
    return await tx.unsafe(query);
  });
}

function nowMs(rows: unknown): number {
  const value = (rows as Array<{ t: string }>)[0]?.t;
  return value ? new Date(value).getTime() : 0;
}

const CLOCK = `select clock_timestamp()::text as t`;

/** The route's step 1/3: the ledger read, in the fold's order. */
function ledgerQuery(userId: string): string {
  return `select scope, action, consent_version, created_at::text as created_at, id
            from public.consent_records
           where user_id = '${userId}'
           order by created_at asc, id asc`;
}

/** The route's step 2 (index.ts:1874-1882) — the version it read, verbatim. */
function insertQuery(
  userId: string,
  action: "grant" | "withdraw",
  version: string | null,
): string {
  return `insert into public.consent_records
            (user_id, scope, consent_version, action, source, device)
          values ('${userId}', '${SCOPE}', ${version ? `'${version}'` : "null"},
            '${action}', 'stress', null)`;
}

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  outcome: string;
  serverStartMs: number;
  serverEndMs: number;
  detail?: string;
}

async function report(
  scenario: string,
  label: string,
  seed: number,
  scale: Record<string, number>,
  lanes: LaneRow[],
  invariants: Invariant[],
  observations: Record<string, unknown>,
): Promise<string> {
  return await writeReport({
    scenario: `stress_consent_withdraw_pg_${scenario}`,
    label,
    seed,
    scale,
    inputs: {
      scope: SCOPE,
      version: VERSION,
      pg: "docker postgres:16 + every migration",
    },
    statusHistogram: histogram(lanes.map((l) => l.outcome)),
    counters: { lanes: lanes.length },
    invariants,
    observations,
    timeline: [],
    requests: lanes as unknown as Array<Record<string, unknown>>,
    durationMs: 0,
    heap: { before: Deno.memoryUsage(), after: Deno.memoryUsage() },
    replay:
      `XC_PG_URL=… STRESS_SEED=${seed} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} ` +
      `deno test -A --no-check --config deno.json stress_consent_withdraw_pg_concurrency.test.ts ` +
      `--filter "${scenario}"`,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name:
    "stress-consent-withdraw PG1: N concurrent withdrawals of one scope — every lane commits, N rows, no lost/duplicate row, no deadlock",
  ignore,
  fn: async () => {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    const prng = new Prng(SEED);
    const lanes: LaneRow[] = [];
    let ties = 0;
    let stamps = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const userId = prng.uuid();
        await createUser(sql, userId);
        await sql.unsafe(
          `insert into public.consent_records (user_id, scope, consent_version, action, source)
             values ('${userId}', '${SCOPE}', '${VERSION}', 'grant', 'setup')`,
        );
        const { gate, open } = barrier();
        const work = Array.from({ length: LANES }, async (_, lane) => {
          await gate;
          const startRow = await stmt(sql, userId, CLOCK);
          const before = await stmt(sql, userId, ledgerQuery(userId));
          const latest = [...before].filter((r) => r.scope === SCOPE).at(-1) ??
            null;
          const carried = (latest?.consent_version as string | null) ?? null;
          await stmt(sql, userId, insertQuery(userId, "withdraw", carried));
          const endRow = await stmt(sql, userId, CLOCK);
          return {
            round,
            lane,
            op: "withdraw",
            outcome: "committed",
            serverStartMs: nowMs(startRow),
            serverEndMs: nowMs(endRow),
            detail: `read ${before.length} rows, carried ${carried ?? "null"}`,
          } satisfies LaneRow;
        });
        const started = performance.now();
        // Let every lane open its transaction and settle on the gate first.
        await new Promise((resolve) => setTimeout(resolve, 25));
        open();
        const settled = await Promise.all(
          work.map((p) => p.catch((e) => String(e))),
        );
        const wallMs = performance.now() - started;
        assert(
          wallMs < 30_000,
          `round ${round} took ${wallMs}ms — possible deadlock`,
        );
        for (const outcome of settled) {
          if (typeof outcome === "string") {
            lanes.push({
              round,
              lane: -1,
              op: "withdraw",
              outcome: "error",
              serverStartMs: 0,
              serverEndMs: 0,
              detail: outcome,
            });
          } else lanes.push(outcome);
        }
        const rows = await sql.unsafe(
          `select action, consent_version, created_at::text as created_at, id from public.consent_records
             where user_id = '${userId}' order by created_at asc, id asc`,
        );
        assertEquals(
          rows.length,
          LANES + 1,
          `round ${round}: ${LANES} concurrent withdrawals + 1 grant must persist ${
            LANES + 1
          } rows`,
        );
        assertEquals(
          rows.filter((r) => r.action === "withdraw").length,
          LANES,
          `round ${round}: no withdrawal may be lost or duplicated`,
        );
        assertEquals(
          rows.at(-1)?.action,
          "withdraw",
          `round ${round}: the fold must end withdrawn`,
        );
        const distinct = new Set(rows.map((r) => String(r.created_at))).size;
        stamps += rows.length;
        ties += rows.length - distinct;
      }
    } finally {
      await sql.end();
    }
    const path = await report(
      "pg1_duplicate_withdrawals",
      "N concurrent withdrawals of one scope from N connections",
      SEED,
      { rounds: ROUNDS, lanes: LANES },
      lanes,
      [
        {
          name: "every lane committed, no deadlock",
          holds: lanes.every((l) => l.outcome === "committed"),
          detail: `${lanes.length} lanes across ${ROUNDS} rounds`,
        },
        {
          name: "one accepted call ⇒ exactly one row",
          holds: true,
          detail: "asserted per round against the persisted table",
        },
      ],
      {
        createdAtTies: ties,
        rowsStamped: stamps,
        note: "now() is the TRANSACTION start time; a tie makes the fold's " +
          "`order by created_at, id` tie-break on a random gen_random_uuid id",
      },
    );
    console.log(`PG1 → ${path} (created_at ties: ${ties}/${stamps})`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name:
    "stress-consent-withdraw PG2: read→insert window — a grant committing between the withdrawal's read and insert persists a stale consent_version",
  ignore,
  fn: async () => {
    const sql = postgres(PG_URL, { max: 6 });
    const prng = new Prng(SEED + 1);
    const lanes: LaneRow[] = [];
    let stale = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const userId = prng.uuid();
        await createUser(sql, userId);
        // Lane W = the route's read-modify-append; lane G = a concurrent grant
        // that commits inside W's window (two devices / a retried grant).
        const readDone = barrier();
        const grantDone = barrier();
        const withdrawLane = (async () => {
          const startRow = await stmt(sql, userId, CLOCK);
          const before = await stmt(sql, userId, ledgerQuery(userId));
          const latest = [...before].filter((r) => r.scope === SCOPE).at(-1) ??
            null;
          const carried = (latest?.consent_version as string | null) ?? null;
          readDone.open();
          await grantDone.gate;
          await stmt(sql, userId, insertQuery(userId, "withdraw", carried));
          const endRow = await stmt(sql, userId, CLOCK);
          return {
            round,
            lane: 0,
            op: "withdraw",
            outcome: "committed",
            serverStartMs: nowMs(startRow),
            serverEndMs: nowMs(endRow),
            detail: `carried ${carried ?? "null"}`,
          } satisfies LaneRow;
        })();
        const grantLane = (async () => {
          await readDone.gate;
          const startRow = await stmt(sql, userId, CLOCK);
          await stmt(sql, userId, insertQuery(userId, "grant", VERSION));
          const endRow = await stmt(sql, userId, CLOCK);
          grantDone.open();
          return {
            round,
            lane: 1,
            op: "grant",
            outcome: "committed",
            serverStartMs: nowMs(startRow),
            serverEndMs: nowMs(endRow),
          } satisfies LaneRow;
        })();
        lanes.push(...(await Promise.all([withdrawLane, grantLane])));

        const rows = await sql.unsafe(
          `select action, consent_version, created_at::text as created_at, id from public.consent_records
             where user_id = '${userId}' order by created_at asc, id asc`,
        );
        assertEquals(
          rows.length,
          2,
          `round ${round}: both lanes must persist a row`,
        );
        const last = rows.at(-1);
        const first = rows[0];
        if (
          last?.action === "withdraw" && first?.action === "grant" &&
          last?.consent_version !== first?.consent_version
        ) {
          stale += 1;
          lanes.push({
            round,
            lane: 2,
            op: "audit",
            outcome: "stale_version",
            serverStartMs: 0,
            serverEndMs: 0,
            detail: `ledger = grant(${first?.consent_version}) then ` +
              `withdraw(${last?.consent_version})`,
          });
        }
      }
    } finally {
      await sql.end();
    }
    const path = await report(
      "pg2_read_insert_window",
      "a grant committing inside the withdrawal's read→insert window",
      SEED + 1,
      { rounds: ROUNDS, lanes: 2 },
      lanes,
      [
        {
          name: "the withdrawal row records the version it supersedes",
          holds: stale === 0,
          detail:
            `${stale}/${ROUNDS} rounds persisted grant(${VERSION}) followed by ` +
            "withdraw(null) — the ledger says the user withdrew from no version",
        },
      ],
      {
        staleRounds: stale,
        note:
          "nothing in the schema serializes this: no unique key, no lock, and the " +
          "route never re-reads after the insert",
      },
    );
    console.log(`PG2 → ${path} (stale carry-forward: ${stale}/${ROUNDS})`);
    assertEquals(
      stale,
      0,
      `${stale}/${ROUNDS} rounds persisted a withdrawal whose consent_version disagrees with ` +
        `the grant it supersedes (artifact: ${path})`,
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name:
    "stress-consent-withdraw PG3: the ledger is append-only and RLS-isolated for `authenticated` under concurrency",
  ignore,
  fn: async () => {
    const sql = postgres(PG_URL, { max: 6 });
    const prng = new Prng(SEED + 2);
    const lanes: LaneRow[] = [];
    try {
      const owner = prng.uuid();
      const other = prng.uuid();
      await createUser(sql, owner);
      await createUser(sql, other);
      await sql.unsafe(
        `insert into public.consent_records (user_id, scope, consent_version, action, source)
           values ('${owner}', '${SCOPE}', '${VERSION}', 'grant', 'setup')`,
      );
      const attempts: Array<{ op: string; run: (tx: Tx) => Promise<unknown> }> =
        [
          {
            op: "owner withdraws",
            run: (tx) =>
              tx.unsafe(
                `insert into public.consent_records (user_id, scope, consent_version, action, source)
                 values ('${owner}', '${SCOPE}', '${VERSION}', 'withdraw', 'stress')`,
              ),
          },
          {
            op: "owner updates own row",
            run: (tx) =>
              tx.unsafe(
                `update public.consent_records set action = 'grant' where user_id = '${owner}'`,
              ),
          },
          {
            op: "owner deletes own row",
            run: (tx) =>
              tx.unsafe(
                `delete from public.consent_records where user_id = '${owner}'`,
              ),
          },
          {
            op: "other inserts for owner",
            run: (tx) =>
              tx.unsafe(
                `insert into public.consent_records (user_id, scope, action, source)
                 values ('${owner}', '${SCOPE}', 'withdraw', 'stress')`,
              ),
          },
          {
            op: "other selects owner rows",
            run: async (tx) => {
              const rows = await tx.unsafe(
                `select id from public.consent_records where user_id = '${owner}'`,
              );
              if (rows.length > 0) {
                throw new Error(`leaked ${rows.length} rows`);
              }
              return rows;
            },
          },
          {
            op: "bad action value",
            run: (tx) =>
              tx.unsafe(
                `insert into public.consent_records (user_id, scope, action, source)
                 values ('${owner}', '${SCOPE}', 'revoke', 'stress')`,
              ),
          },
        ];
      const { gate, open } = barrier();
      const started = attempts.map((attempt, lane) =>
        sql
          .begin(async (tx) => {
            await asUser(tx, attempt.op.startsWith("other") ? other : owner);
            await gate;
            const startRow = await tx.unsafe(`select clock_timestamp() as t`);
            await attempt.run(tx);
            const endRow = await tx.unsafe(`select clock_timestamp() as t`);
            return {
              round: 0,
              lane,
              op: attempt.op,
              outcome: "allowed",
              serverStartMs: new Date(startRow[0].t as string).getTime(),
              serverEndMs: new Date(endRow[0].t as string).getTime(),
            } satisfies LaneRow;
          })
          .catch((error) => ({
            round: 0,
            lane,
            op: attempt.op,
            outcome: "refused",
            serverStartMs: 0,
            serverEndMs: 0,
            detail: String(error).slice(0, 200),
          } satisfies LaneRow))
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
      open();
      lanes.push(...(await Promise.all(started)));
      const outcomeOf = (op: string) => lanes.find((l) => l.op === op)?.outcome;
      assertEquals(
        outcomeOf("owner withdraws"),
        "allowed",
        "the owner may append a withdrawal",
      );
      assertEquals(
        outcomeOf("owner updates own row"),
        "refused",
        "no UPDATE grant on the ledger",
      );
      assertEquals(
        outcomeOf("owner deletes own row"),
        "refused",
        "no DELETE grant on the ledger",
      );
      assertEquals(
        outcomeOf("other inserts for owner"),
        "refused",
        "RLS refuses a foreign insert",
      );
      assertEquals(
        outcomeOf("other selects owner rows"),
        "allowed",
        "RLS returns zero foreign rows",
      );
      assertEquals(
        outcomeOf("bad action value"),
        "refused",
        "the action CHECK holds",
      );
      const rows = await sql.unsafe(
        `select action from public.consent_records where user_id = '${owner}'
           order by created_at asc, id asc`,
      );
      assertEquals(
        rows.map((r) => r.action),
        ["grant", "withdraw"],
        "the ledger kept exactly the grant and the appended withdrawal",
      );
    } finally {
      await sql.end();
    }
    const path = await report(
      "pg3_append_only_rls",
      "append-only + RLS under a concurrent burst of allowed and denied paths",
      SEED + 2,
      { rounds: 1, lanes: lanes.length },
      lanes,
      [
        {
          name: "a persisted withdrawal cannot be updated, deleted or forged",
          holds: true,
          detail: "asserted per attempt against the real grants/policies",
        },
      ],
      {},
    );
    console.log(`PG3 → ${path}`);
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// PG5 — the fold's ordering key. `order by created_at, id` is NOT a total
// order over causally distinct writes: now() is the transaction timestamp and
// two backends that begin inside the same clock tick get the SAME microsecond
// (measured: see PG1/PG4 tie census). The remaining tie-break is
// gen_random_uuid(), so a simultaneous grant can mask an acknowledged
// withdrawal. Consent must fail safe: a ledger that holds a withdrawal not
// strictly older than every grant must never fold to `active`.
// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name:
    "stress-consent-withdraw PG5: simultaneous grant+withdraw — a tied created_at must not fold to `active` (consent fails safe)",
  ignore,
  fn: async () => {
    const sql = postgres(PG_URL, { max: 6 });
    const prng = new Prng(SEED + 4);
    const lanes: LaneRow[] = [];
    let tied = 0;
    let maskedWithdrawals = 0;
    const rounds = ROUNDS * 4;
    try {
      for (let round = 0; round < rounds; round++) {
        const userId = prng.uuid();
        await createUser(sql, userId);
        const { gate, open } = barrier();
        const work = (["grant", "withdraw"] as const).map(
          async (action, lane) => {
            await gate;
            const startRow = await stmt(sql, userId, CLOCK);
            await stmt(sql, userId, insertQuery(userId, action, VERSION));
            const endRow = await stmt(sql, userId, CLOCK);
            return {
              round,
              lane,
              op: action,
              outcome: "committed",
              serverStartMs: nowMs(startRow),
              serverEndMs: nowMs(endRow),
            } satisfies LaneRow;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        open();
        lanes.push(...(await Promise.all(work)));
        const rows = await sql.unsafe(
          `select action, created_at::text as created_at, id from public.consent_records
             where user_id = '${userId}' order by created_at asc, id asc`,
        );
        assertEquals(
          rows.length,
          2,
          `round ${round}: both lanes must persist a row`,
        );
        const isTied =
          String(rows[0].created_at) === String(rows[1].created_at);
        if (isTied) tied += 1;
        const foldActive = rows.at(-1)?.action === "grant";
        const withdrawStamp = String(
          rows.find((r) => r.action === "withdraw")?.created_at,
        );
        const grantStamp = String(
          rows.find((r) => r.action === "grant")?.created_at,
        );
        // Fail-safe rule: `active` is only defensible when the withdrawal is
        // STRICTLY older than the grant.
        if (foldActive && !(withdrawStamp < grantStamp)) {
          maskedWithdrawals += 1;
          lanes.push({
            round,
            lane: 2,
            op: "audit",
            outcome: "withdrawal_masked",
            serverStartMs: 0,
            serverEndMs: 0,
            detail:
              `tie=${isTied} withdraw@${withdrawStamp} grant@${grantStamp} ` +
              `fold=${rows.at(-1)?.action} (tie-break by id ${
                String(rows.at(-1)?.id)
              })`,
          });
        }
      }
    } finally {
      await sql.end();
    }
    const path = await report(
      "pg5_tied_timestamps",
      "simultaneous grant + withdraw from two connections",
      SEED + 4,
      { rounds, lanes: 2 },
      lanes,
      [
        {
          name: "a withdrawal is never masked by a non-older grant",
          holds: maskedWithdrawals === 0,
          detail:
            `${tied}/${rounds} rounds shared one created_at; ${maskedWithdrawals} of them ` +
            "folded to active=true, i.e. a random uuid decided the consent state",
        },
      ],
      { tiedRounds: tied, maskedWithdrawals, rounds },
    );
    console.log(
      `PG5 → ${path} (ties ${tied}/${rounds}, masked withdrawals ${maskedWithdrawals})`,
    );
    assertEquals(
      maskedWithdrawals,
      0,
      `${maskedWithdrawals}/${rounds} simultaneous grant+withdraw pairs folded to active=true ` +
        `with a tied created_at (artifact: ${path})`,
    );
  },
});

// ─────────────────────────────────────────────────────────────────────────────
Deno.test({
  name:
    "stress-consent-withdraw PG4: fold stability — repeated `order by created_at, id` reads of a settled ledger are identical, and now() collisions are counted",
  ignore,
  fn: async () => {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    const prng = new Prng(SEED + 3);
    const lanes: LaneRow[] = [];
    let ties = 0;
    let rowsTotal = 0;
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const userId = prng.uuid();
        await createUser(sql, userId);
        const { gate, open } = barrier();
        const work = Array.from({ length: LANES }, async (_, lane) => {
          const action = lane % 2 === 0
            ? "grant" as const
            : "withdraw" as const;
          await gate;
          const startRow = await stmt(sql, userId, CLOCK);
          await stmt(
            sql,
            userId,
            insertQuery(userId, action, action === "grant" ? VERSION : null),
          );
          const endRow = await stmt(sql, userId, CLOCK);
          return {
            round,
            lane,
            op: action,
            outcome: "committed",
            serverStartMs: nowMs(startRow),
            serverEndMs: nowMs(endRow),
          } satisfies LaneRow;
        });
        await new Promise((resolve) => setTimeout(resolve, 25));
        open();
        lanes.push(...(await Promise.all(work)));
        const reads = await Promise.all(
          Array.from({ length: 5 }, () =>
            sql.unsafe(
              `select action, consent_version, created_at::text as created_at, id from public.consent_records
                 where user_id = '${userId}' order by created_at asc, id asc`,
            )),
        );
        const serialized = reads.map((r) => JSON.stringify(r));
        assertEquals(
          new Set(serialized).size,
          1,
          `round ${round}: repeated folds of a settled ledger must be identical`,
        );
        assertEquals(
          reads[0].length,
          LANES,
          `round ${round}: every lane's row must persist`,
        );
        const distinct = new Set(reads[0].map((r) =>
          String(r.created_at)
        )).size;
        rowsTotal += reads[0].length;
        ties += reads[0].length - distinct;
      }
    } finally {
      await sql.end();
    }
    const path = await report(
      "pg4_fold_stability",
      "repeated folds of a settled ledger + now() collision census",
      SEED + 3,
      { rounds: ROUNDS, lanes: LANES },
      lanes,
      [
        {
          name: "the fold is stable and total",
          holds: true,
          detail:
            "5 concurrent reads per round returned byte-identical row orders",
        },
        {
          name: "no now() collision observed among concurrent transactions",
          holds: ties === 0,
          detail: `${ties} tied created_at values across ${rowsTotal} rows ` +
            "(a tie would make the fold pick by random uuid)",
        },
      ],
      { createdAtTies: ties, rowsTotal },
    );
    console.log(`PG4 → ${path} (created_at ties: ${ties}/${rowsTotal})`);
  },
});
