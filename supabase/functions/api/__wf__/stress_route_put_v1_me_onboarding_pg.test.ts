/**
 * stress — PUT /v1/me/onboarding, concurrency lens, DIRECT Postgres half.
 *
 * The in-process campaign (stress_route_put_v1_me_onboarding_concurrency.test.ts)
 * proves the REAL handler over a modelled PostgREST. The route's single write
 * is a PostgREST `PATCH /rest/v1/profiles?id=eq.<uid>` under the caller's JWT
 * (role `authenticated`, RLS `id = auth.uid()`), i.e. exactly
 *
 *   update public.profiles set skill_level=$1, handedness=$2, primary_goal=$3,
 *     biggest_problem=$4, focus_checkpoint=$5, onboarding_state='complete'
 *     [, first_name=$6][, gender=$7] where id=$uid
 *   returning skill_level, handedness, primary_goal, biggest_problem,
 *     focus_checkpoint, first_name, gender
 *
 * This file drives THAT statement on a disposable postgres:16 with
 * shim_auth.sql + every migration applied (./xc_pg_up.sh), from N INDEPENDENT
 * connections each in its own transaction as `authenticated` with the caller's
 * JWT sub, released from a barrier so the row lock genuinely contends.
 *
 *   ./xc_pg_up.sh                      # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_OUT_DIR=/tmp/stress/ deno test -A --no-check --config deno.json \
 *     stress_route_put_v1_me_onboarding_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 * Same knobs as the in-process file: STRESS_SEED / STRESS_ITER (rounds) /
 * STRESS_BURST (lanes = connections per burst) / STRESS_OUT_DIR.
 */
import postgres from "postgres";
import { assert } from "@std/assert";
import {
  bounded,
  expectedColumns,
  histogram,
  type Invariant,
  type OnboardingPayload,
  Prng,
  randomPayload,
  replayCommand,
  roundReplayCommand,
  roundSeeds,
  type ScenarioReport,
  STRESS_BURST,
  STRESS_ITER,
  STRESS_SEED,
  writeReport,
} from "./stress_onboarding_harness.ts";

const FILE = "stress_route_put_v1_me_onboarding_pg.test.ts";
const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = STRESS_BURST;
const ROUND_BUDGET_MS = 15_000;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const SELECT_COLS = "skill_level, handedness, primary_goal, biggest_problem, focus_checkpoint, first_name, gender";

interface LaneRow {
  round: number;
  lane: number;
  op: string;
  /** "1 row" | "0 rows" | sqlstate */
  result: string;
  returned?: Record<string, unknown>;
  /** transaction_timestamp() of the lane's tx — what set_updated_at() writes */
  txStartMs?: number;
  serverStartMs: number;
  serverEndMs: number;
  clientMs: number;
}

const campaign: Array<
  { scenario: string; rounds: number; lanes: number; broken: number; durationMs: number; report: string }
> = [];
let campaignStatements = 0;

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** Owner-role setup: (re)create the auth user; handle_new_user() creates the
 * profile row exactly like GoTrue sign-up does on the hosted platform. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(`select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`);
  return Number(r[0].t);
}

/** The route's PATCH, verbatim in SQL (PostgREST emits a single UPDATE …
 * RETURNING under the caller's role). `targetId` is the `?id=eq.` filter —
 * always the caller's own id in the route; PG3 points it at another user. */
async function routeUpdate(tx: Tx, targetId: string, payload: OnboardingPayload, op: string) {
  const cols = expectedColumns(payload);
  const keys = Object.keys(cols);
  const set = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
  const params = keys.map((k) => cols[k] as string);
  params.push(targetId);
  const txStart = await tx.unsafe(`select (extract(epoch from now()) * 1000)::float8 as t`);
  const txStartMs = Number(txStart[0].t);
  const t0 = await serverNowMs(tx);
  try {
    const rows = await tx.unsafe(
      `update public.profiles set ${set} where id = $${params.length} returning ${SELECT_COLS}`,
      params,
    );
    const t1 = await serverNowMs(tx);
    return {
      op,
      result: rows.length === 1 ? "1 row" : `${rows.length} rows`,
      returned: rows.length === 1 ? { ...rows[0] } : undefined,
      txStartMs,
      serverStartMs: t0,
      serverEndMs: t1,
    };
  } catch (error) {
    const t1 = await serverNowMs(tx).catch(() => t0);
    const code = (error as { code?: string }).code ?? (error instanceof Error ? error.message : String(error));
    return { op, result: String(code), txStartMs, serverStartMs: t0, serverEndMs: t1 };
  }
}

/** Run `fn` on `lanes` independent connections; each lane opens a tx, sets the
 * caller, waits at the barrier, then runs fn and COMMITs. A lane whose
 * statement errored is rolled back by `begin` rejecting — we swallow that so
 * every lane's outcome is recorded (the row is what the invariants check). */
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
          rows.push({ round, lane, clientMs: Math.round((performance.now() - t0) * 100) / 100, ...out });
          if (!out.result.startsWith("1 row") && !out.result.endsWith("rows")) {
            throw new Error(`lane ${lane} ${out.op}: ${out.result}`); // roll back the errored tx
          }
        })
        .catch((error: unknown) => {
          if (!rows.some((r) => r.round === round && r.lane === lane)) {
            rows.push({
              round,
              lane,
              op: "tx",
              result: error instanceof Error ? error.message : String(error),
              serverStartMs: 0,
              serverEndMs: 0,
              clientMs: 0,
            });
          }
        })),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  campaignStatements += rows.length;
  return rows;
}

async function readRow(sql: Sql, userId: string, as: string = userId): Promise<Record<string, unknown> | null> {
  let out: Record<string, unknown> | null = null;
  await sql.begin(async (tx) => {
    await asUser(tx as unknown as Tx, as);
    const r = await tx.unsafe(
      `select ${SELECT_COLS}, onboarding_state, (extract(epoch from updated_at) * 1000)::float8 as updated_ms, xmin::text as version_probe
         from public.profiles where id = '${userId}'`,
    );
    out = r.length === 1 ? { ...r[0] } : null;
  });
  return out;
}

async function rowCount(sql: Sql, userId: string): Promise<number> {
  const r = await sql.unsafe(`select count(*)::int as n from public.profiles where id = '${userId}'`);
  return Number(r[0].n);
}

function matches(row: Record<string, unknown> | null, payload: OnboardingPayload): boolean {
  if (!row) return false;
  return Object.entries(expectedColumns(payload)).every(([k, v]) => row[k] === v);
}

function returnedMatches(row: Record<string, unknown> | undefined, payload: OnboardingPayload): boolean {
  if (!row) return false;
  const { onboarding_state: _s, ...echo } = expectedColumns(payload);
  return Object.entries(echo).every(([k, v]) => row[k] === v);
}

function overlaps(rows: LaneRow[]): number {
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (a.serverStartMs < b.serverEndMs && b.serverStartMs < a.serverEndMs) n++;
    }
  }
  return n;
}

interface Ctx {
  sql: Sql;
  prng: Prng;
  seed: number;
  round: number;
  rows: LaneRow[];
  inv: (name: string, holds: boolean, detail: string) => void;
}

async function scenario(name: string, filter: string, run: (ctx: Ctx) => Promise<void>): Promise<ScenarioReport> {
  const sql = postgres(PG_URL, { max: LANES + 4, idle_timeout: 5, connect_timeout: 10 });
  const rounds: ScenarioReport["rounds"] = [];
  const invariants: Invariant[] = [];
  const allRows: LaneRow[] = [];
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  try {
    const seeds = roundSeeds(name);
    for (let round = 0; round < seeds.length; round++) {
      const seed = seeds[round];
      const prng = new Prng(seed);
      const rows: LaneRow[] = [];
      const roundInvariants: Invariant[] = [];
      const ctx: Ctx = {
        sql,
        prng,
        seed,
        round,
        rows,
        inv: (n, holds, detail) => roundInvariants.push({ name: `r${round}: ${n}`, holds, detail }),
      };
      try {
        await bounded(`${name} round ${round}`, ROUND_BUDGET_MS, run(ctx));
        ctx.inv(
          "no deadlock (40P01) / lock timeout (55P03) / serialization failure (40001)",
          rows.every((r) => !["40P01", "55P03", "40001"].includes(r.result)),
          JSON.stringify(histogram(rows.map((r) => `${r.op}:${r.result}`))),
        );
      } catch (error) {
        roundInvariants.push({
          name: `r${round}: round settles within ${ROUND_BUDGET_MS}ms without throwing`,
          holds: false,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
      invariants.push(...roundInvariants);
      allRows.push(...rows);
      const broken = roundInvariants.filter((i) => !i.holds);
      rounds.push({
        round,
        seed,
        outcome: broken.length === 0 ? "HELD" : "BROKEN",
        detail: broken.length === 0
          ? `${rows.length} statements, ${roundInvariants.length} invariants`
          : broken.map((b) => `${b.name}: ${b.detail}`).join(" || "),
        replay: roundReplayCommand(FILE, filter, seed),
      });
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
  const durationMs = Math.round(performance.now() - t0);
  const report: ScenarioReport = {
    scenario: name,
    seed: STRESS_SEED,
    scale: { iter: STRESS_ITER, lanes: LANES },
    rounds,
    statusHistogram: histogram(allRows.map((r) => `${r.op}:${r.result}`)),
    counters: { statements: allRows.length, overlappingPairs: overlaps(allRows.filter((r) => r.serverStartMs > 0)) },
    invariants,
    observations: {
      pg: PG_URL.replace(/\/\/.*@/, "//<redacted>@"),
      lanes: allRows.map((r) => ({ ...r, returned: undefined })),
    },
    requestsExecuted: allRows.length,
    durationMs,
    heap: { before, after: Deno.memoryUsage() },
    replay: `XC_PG_URL=<url> ${replayCommand(FILE, filter, STRESS_SEED)}`,
  };
  const path = await writeReport(report);
  campaign.push({
    scenario: name,
    rounds: rounds.length,
    lanes: LANES,
    broken: rounds.filter((r) => r.outcome === "BROKEN").length,
    durationMs,
    report: path,
  });
  console.log(`[stress-pg] ${name}: ${rounds.length} rounds, ${allRows.length} statements, ${durationMs}ms → ${path}`);
  for (const r of rounds.filter((r) => r.outcome === "BROKEN")) {
    console.log(`[stress-pg]   BROKEN seed=${r.seed}: ${r.detail}`);
  }
  const brokenInv = invariants.filter((i) => !i.holds);
  assert(
    brokenInv.length === 0,
    `${name}: ${brokenInv.map((i) => `${i.name} — ${i.detail}`).join("\n")}\nreplay: ${report.replay}`,
  );
  return report;
}

// ── PG1: N identical UPDATEs on one row, N connections ──────────────────────
Deno.test({
  name:
    "stress PG1: N concurrent identical route UPDATEs on one profile — every lane 1 row, RETURNING = payload, one row, final = payload, no deadlock",
  ignore,
  fn: async () => {
    await scenario("pg1_duplicate_identical_update", "PG1", async (ctx) => {
      const { sql, prng } = ctx;
      const uid = prng.uuid();
      await createUser(sql, uid);
      const payload = randomPayload(prng);
      const rows = await burst(
        sql,
        LANES,
        () => uid,
        (tx, lane) => routeUpdate(tx, uid, payload, `put.lane${lane}`),
        ctx.round,
      );
      ctx.rows.push(...rows);
      ctx.inv(
        "every lane updated exactly 1 row",
        rows.every((r) => r.result === "1 row"),
        JSON.stringify(histogram(rows.map((r) => r.result))),
      );
      ctx.inv("every RETURNING equals the payload", rows.every((r) => returnedMatches(r.returned, payload)), "");
      const final = await readRow(sql, uid);
      ctx.inv("final row = payload, onboarding_state complete", matches(final, payload), JSON.stringify(final));
      ctx.inv("exactly one profile row", (await rowCount(sql, uid)) === 1, "");
      ctx.inv(
        "lanes genuinely contended (≥1 overlapping server window)",
        overlaps(rows) >= 1,
        `overlaps=${overlaps(rows)}`,
      );
    });
  },
});

// ── PG2: conflicting payloads on one row ─────────────────────────────────────
Deno.test({
  name:
    "stress PG2: N conflicting route UPDATEs on one profile — each RETURNING is its own write, final row is whole and equals the last committer, updated_at monotonic",
  ignore,
  fn: async () => {
    await scenario("pg2_conflicting_updates_same_row", "PG2", async (ctx) => {
      const { sql, prng } = ctx;
      const uid = prng.uuid();
      await createUser(sql, uid);
      const before = await readRow(sql, uid);
      const payloads = Array.from({ length: LANES }, () => randomPayload(prng));
      const rows = await burst(
        sql,
        LANES,
        () => uid,
        (tx, lane) => routeUpdate(tx, uid, payloads[lane], `put.lane${lane}`),
        ctx.round,
      );
      ctx.rows.push(...rows);
      ctx.inv(
        "every lane updated exactly 1 row",
        rows.every((r) => r.result === "1 row"),
        JSON.stringify(histogram(rows.map((r) => r.result))),
      );
      ctx.inv(
        "every RETURNING is ITS OWN payload (no lane sees another lane's write)",
        rows.every((r) => returnedMatches(r.returned, payloads[r.lane])),
        "",
      );
      const final = await readRow(sql, uid);
      const last = rows.reduce((a, b) => (b.serverEndMs > a.serverEndMs ? b : a));
      ctx.inv(
        "final row equals the last lane to finish (row lock serializes; last committer wins, never torn)",
        matches(final, payloads[last.lane]),
        `last=lane${last.lane} final=${JSON.stringify(final)}`,
      );
      ctx.inv("final row is SOME lane's payload as a whole", payloads.some((p) => matches(final, p)), "");
      // set_updated_at() writes now() = the committing tx's transaction_timestamp.
      ctx.inv(
        "updated_at advanced past sign-up and equals the last committer's transaction_timestamp (trigger fired on the winning write)",
        Number(final?.updated_ms) > Number(before?.updated_ms) &&
          Math.abs(Number(final?.updated_ms) - Number(last.txStartMs)) < 1,
        `before=${before?.updated_ms} after=${final?.updated_ms} lastTx=${last.txStartMs}`,
      );
      ctx.inv("exactly one profile row", (await rowCount(sql, uid)) === 1, "");
    });
  },
});

// ── PG3: two actors on the same row ──────────────────────────────────────────
Deno.test({
  name:
    "stress PG3: actor B runs the route UPDATE against A's id (and vice versa) while A onboards — RLS yields 0 rows for the foreign id, A's row is A's write, B's row untouched by A",
  ignore,
  fn: async () => {
    await scenario("pg3_two_actors_same_row", "PG3", async (ctx) => {
      const { sql, prng } = ctx;
      const a = prng.uuid();
      const b = prng.uuid();
      await createUser(sql, a);
      await createUser(sql, b);
      const payloadsA: OnboardingPayload[] = [];
      const payloadsB: OnboardingPayload[] = [];
      const bOwnBefore = await readRow(sql, b);
      const rows = await burst(
        sql,
        LANES,
        (lane) => (lane % 2 === 0 ? a : b),
        (tx, lane) => {
          const p = randomPayload(prng);
          if (lane % 2 === 0) {
            payloadsA[lane] = p;
            return routeUpdate(tx, a, p, "A.put.own");
          }
          payloadsB[lane] = p;
          // B targets A's row (what a tampered `?id=eq.` filter would do)
          return routeUpdate(tx, a, p, "B.put.foreign");
        },
        ctx.round,
      );
      ctx.rows.push(...rows);
      const own = rows.filter((r) => r.op === "A.put.own");
      const foreign = rows.filter((r) => r.op === "B.put.foreign");
      ctx.inv(
        "A's own writes each hit 1 row",
        own.every((r) => r.result === "1 row"),
        JSON.stringify(histogram(own.map((r) => r.result))),
      );
      ctx.inv(
        "B's writes against A's id hit 0 rows (RLS), never error",
        foreign.every((r) => r.result === "0 rows"),
        JSON.stringify(histogram(foreign.map((r) => r.result))),
      );
      const finalA = await readRow(sql, a);
      ctx.inv(
        "A's final row is one of A's payloads (never B's)",
        own.some((r) => matches(finalA, payloadsA[r.lane])) && !foreign.some((r) => matches(finalA, payloadsB[r.lane])),
        JSON.stringify(finalA),
      );
      const finalB = await readRow(sql, b);
      ctx.inv(
        "B's own row is untouched (still onboarding_state from sign-up)",
        finalB?.onboarding_state === bOwnBefore?.onboarding_state && finalB?.skill_level === bOwnBefore?.skill_level,
        JSON.stringify(finalB),
      );
      ctx.inv("B cannot read A's row", (await readRow(sql, a, b)) === null, "");
    });
  },
});

// ── PG4: readers during writers ──────────────────────────────────────────────
Deno.test({
  name:
    "stress PG4: readers (GET /v1/me shape) interleaved with conflicting UPDATEs — every read is a whole committed snapshot (goal↔focus consistent), never a partial row",
  ignore,
  fn: async () => {
    await scenario("pg4_readers_during_writers", "PG4", async (ctx) => {
      const { sql, prng } = ctx;
      const uid = prng.uuid();
      await createUser(sql, uid);
      const payloads = Array.from({ length: LANES }, () => randomPayload(prng));
      const snapshots: Array<Record<string, unknown>> = [];
      const rows = await burst(
        sql,
        LANES,
        () => uid,
        async (tx, lane) => {
          if (lane % 3 === 2) {
            const t0 = await serverNowMs(tx);
            const r = await tx.unsafe(
              `select ${SELECT_COLS}, onboarding_state from public.profiles where id = '${uid}'`,
            );
            const t1 = await serverNowMs(tx);
            if (r.length === 1) snapshots.push({ ...r[0] });
            return {
              op: "get",
              result: `${r.length} row${r.length === 1 ? "" : "s"}`,
              serverStartMs: t0,
              serverEndMs: t1,
            };
          }
          return routeUpdate(tx, uid, payloads[lane], "put");
        },
        ctx.round,
      );
      ctx.rows.push(...rows);
      const written = payloads.filter((_, i) => i % 3 !== 2);
      ctx.inv(
        "every read is the sign-up row or a whole written payload (never a mix)",
        snapshots.every((s) =>
          (s.onboarding_state !== "complete" && s.primary_goal === null) || written.some((p) => matches(s, p))
        ),
        JSON.stringify(
          snapshots.filter((s) =>
            !(s.onboarding_state !== "complete" && s.primary_goal === null) && !written.some((p) => matches(s, p))
          ).slice(0, 3),
        ),
      );
      ctx.inv(
        "every write hit 1 row, every read 1 row",
        rows.every((r) => r.result === "1 row"),
        JSON.stringify(histogram(rows.map((r) => `${r.op}:${r.result}`))),
      );
      const final = await readRow(sql, uid);
      ctx.inv(
        "final row is one of the written payloads",
        written.some((p) => matches(final, p)),
        JSON.stringify(final),
      );
    });
  },
});

// ── PG5: contract rejections under the same lock contention ─────────────────
Deno.test({
  name:
    "stress PG5: invalid values (bad handedness/gender, oversize text, ungranted column) mixed into a burst — each is refused by the table (23514/42501), valid lanes land, final row valid",
  ignore,
  fn: async () => {
    await scenario("pg5_table_contract_under_contention", "PG5", async (ctx) => {
      const { sql, prng } = ctx;
      const uid = prng.uuid();
      await createUser(sql, uid);
      const validPayloads: OnboardingPayload[] = [];
      const rows = await burst(
        sql,
        LANES,
        () => uid,
        async (tx, lane) => {
          const kind = lane % 4;
          const p = randomPayload(prng);
          if (kind === 0) {
            validPayloads[lane] = p;
            return routeUpdate(tx, uid, p, "valid");
          }
          const t0 = await serverNowMs(tx);
          let stmt: string;
          let op: string;
          if (kind === 1) {
            op = "bad_handedness";
            stmt =
              `update public.profiles set handedness = 'ambidextrous', onboarding_state = 'complete' where id = '${uid}' returning ${SELECT_COLS}`;
          } else if (kind === 2) {
            op = "oversize_problem";
            stmt =
              `update public.profiles set biggest_problem = repeat('x', 501), onboarding_state = 'complete' where id = '${uid}' returning ${SELECT_COLS}`;
          } else {
            op = "ungranted_email";
            stmt =
              `update public.profiles set email = 'x@y.z', onboarding_state = 'complete' where id = '${uid}' returning ${SELECT_COLS}`;
          }
          try {
            const r = await tx.unsafe(stmt);
            return { op, result: `${r.length} row`, serverStartMs: t0, serverEndMs: await serverNowMs(tx) };
          } catch (error) {
            const code = (error as { code?: string }).code ?? "error";
            return { op, result: String(code), serverStartMs: t0, serverEndMs: t0 };
          }
        },
        ctx.round,
      );
      ctx.rows.push(...rows);
      const by = (op: string) => rows.filter((r) => r.op === op);
      ctx.inv(
        "valid lanes hit 1 row",
        by("valid").every((r) => r.result === "1 row"),
        JSON.stringify(histogram(by("valid").map((r) => r.result))),
      );
      ctx.inv(
        "bad handedness → 23514",
        by("bad_handedness").every((r) => r.result === "23514"),
        JSON.stringify(histogram(by("bad_handedness").map((r) => r.result))),
      );
      ctx.inv(
        "oversize biggest_problem (501) → 23514",
        by("oversize_problem").every((r) => r.result === "23514"),
        JSON.stringify(histogram(by("oversize_problem").map((r) => r.result))),
      );
      ctx.inv(
        "ungranted column (email) → 42501",
        by("ungranted_email").every((r) => r.result === "42501"),
        JSON.stringify(histogram(by("ungranted_email").map((r) => r.result))),
      );
      const final = await readRow(sql, uid);
      ctx.inv(
        "final row is one of the VALID payloads (rejected lanes rolled back, nothing partial)",
        by("valid").some((r) => matches(final, validPayloads[r.lane])),
        JSON.stringify(final),
      );
      ctx.inv("exactly one profile row", (await rowCount(sql, uid)) === 1, "");
    });
  },
});

Deno.test({
  name: "stress-pg: write campaign table (seed → outcome per scenario)",
  ignore,
  fn: async () => {
    const dir = (await import("./stress_onboarding_harness.ts")).outDir();
    await Deno.mkdir(dir, { recursive: true });
    const path = `${dir}campaign_pg.json`;
    await Deno.writeTextFile(
      path,
      JSON.stringify(
        {
          seed: STRESS_SEED,
          scale: { iter: STRESS_ITER, lanes: LANES },
          rounds: campaign.reduce((n, c) => n + c.rounds, 0),
          statements: campaignStatements,
          scenarios: campaign,
          replay: `XC_PG_URL=<url> ${replayCommand(FILE, "stress", STRESS_SEED)}`,
        },
        null,
        2,
      ),
    );
    console.log(
      `[stress-pg] campaign: ${
        campaign.reduce((n, c) => n + c.rounds, 0)
      } rounds, ${campaignStatements} statements → ${path}`,
    );
    assert(campaign.every((c) => c.broken === 0), "stress-pg campaign has BROKEN rounds");
  },
});
