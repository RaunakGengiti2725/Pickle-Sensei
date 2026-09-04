// stress-edge-drills-media / lens CONCURRENCY — REAL Postgres half.
//
// stress_drills_media_concurrency.test.ts proves the handler over a modelled
// PostgREST. This file replays the exact statement sequence the saved-drill
// routes issue (index.ts saveDrill / unsaveDrill / listSavedDrills — one
// autocommit transaction per PostgREST request, role `authenticated`, the
// caller's JWT sub) against a disposable postgres:16 with shim_auth.sql and
// EVERY migration applied (./xc_pg_up.sh), from N independent connections
// released from a barrier, so the composite primary key, RLS policies and the
// `user_saved_drills_slug_bounds` CHECK are exercised for real.
//
//   ./xc_pg_up.sh                      # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_OUT_DIR=/tmp/stress-pg/ deno test -A --no-check --config deno.json stress_drills_media_pg.test.ts
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
// ignored run is NOT a pass.
//
// Scenarios:
//   PG1 duplicate PUT burst — ON CONFLICT DO NOTHING from N connections: one
//       row, every statement succeeds, one saved_at
//   PG2 PUT/DELETE read-back race — deterministic interleaving + free burst:
//       the route's second statement returns 0 rows (the edge fn maps that
//       to 503; classified defect PUT_DELETE_RACE) — rows ∈ {0,1}, never an
//       error, never a deadlock
//   PG3 two actors on one slug — RLS: B's DELETE/SELECT of A's row affects 0
//   PG4 slug oracle differential — everything the route regex accepts the
//       CHECK accepts (else the route would 503); everything it rejects the
//       CHECK rejects (23514) — over the seeded fuzz corpus
//   PG5 mixed insert/delete storm on 2 users × 2 slugs — no 40P01, bounded

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, histogram, Prng } from "./xc_concurrency_harness.ts";
import {
  DRILL_SLUG_RE,
  fnv1a,
  fuzzSlugs,
  inv,
  PUT_DELETE_RACE,
  replay,
  type Row,
  STRESS_BURST,
  STRESS_DEADLINE_MS,
  STRESS_ITER,
  STRESS_SEED,
  type StressInvariant,
  stressOutDir,
  type StressReport,
  writeStressReport,
} from "./stress_drills_media_harness.ts";

const FILE = "stress_drills_media_pg.test.ts";
const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", Math.min(STRESS_BURST, 16));
const ROUNDS = 2 * STRESS_ITER;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const reports: StressReport[] = [];

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

/** One PostgREST request = one transaction as `authenticated` with the
 * caller's sub. `fn` receives the tx; the result is committed on return. */
async function asRequest<T>(
  sql: Sql,
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`set local role authenticated`);
    await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
    return await fn(tx as unknown as Tx);
  }) as T;
}

interface PgResult {
  status: number;
  code?: string;
  rows?: number;
}

/** PostgREST `POST /user_saved_drills?on_conflict=user_id,slug` with
 * `Prefer: resolution=ignore-duplicates` — INSERT … ON CONFLICT DO NOTHING. */
async function upsertStmt(
  sql: Sql,
  userId: string,
  slug: string,
): Promise<PgResult> {
  try {
    await asRequest(sql, userId, (tx) =>
      tx.unsafe(
        `insert into public.user_saved_drills (user_id, slug) values ($1, $2) on conflict (user_id, slug) do nothing`,
        [userId, slug],
      ));
    return { status: 201 };
  } catch (error) {
    return {
      status: 500,
      code: String(
        (error as { code?: string }).code ?? (error as Error).message,
      ),
    };
  }
}

/** `GET /user_saved_drills?select=slug,saved_at&user_id=eq.&slug=eq.` with
 * `Accept: application/vnd.pgrst.object+json` (maybeSingle) — the route's
 * read-back. 0 rows ⇒ the edge fn answers 503. */
async function readBackStmt(
  sql: Sql,
  userId: string,
  slug: string,
): Promise<PgResult & { savedAt?: string }> {
  try {
    const out = await asRequest(sql, userId, (tx) =>
      tx.unsafe(
        `select slug, saved_at from public.user_saved_drills where user_id = $1 and slug = $2`,
        [userId, slug],
      ));
    const rows = out as unknown as Array<{ saved_at: string }>;
    return rows.length === 1
      ? { status: 200, rows: 1, savedAt: String(rows[0].saved_at) }
      : { status: 404, rows: rows.length };
  } catch (error) {
    return {
      status: 500,
      code: String(
        (error as { code?: string }).code ?? (error as Error).message,
      ),
    };
  }
}

/** `DELETE /user_saved_drills?user_id=eq.&slug=eq.` — unsaveDrill. */
async function deleteStmt(
  sql: Sql,
  userId: string,
  slug: string,
  targetUserId = userId,
): Promise<PgResult> {
  try {
    const out = await asRequest(
      sql,
      userId,
      (tx) =>
        tx.unsafe(
          `delete from public.user_saved_drills where user_id = $1 and slug = $2`,
          [targetUserId, slug],
        ),
    );
    return { status: 204, rows: (out as unknown as { count: number }).count };
  } catch (error) {
    return {
      status: 500,
      code: String(
        (error as { code?: string }).code ?? (error as Error).message,
      ),
    };
  }
}

async function listStmt(
  sql: Sql,
  userId: string,
  targetUserId = userId,
): Promise<string[]> {
  const out = await asRequest(
    sql,
    userId,
    (tx) =>
      tx.unsafe(
        `select slug from public.user_saved_drills where user_id = $1 order by saved_at desc`,
        [targetUserId],
      ),
  );
  return (out as unknown as Array<{ slug: string }>).map((r) => r.slug);
}

async function ownerRows(
  sql: Sql,
  userId: string,
): Promise<Array<{ slug: string; saved_at: string }>> {
  return (await sql.unsafe(
    `select slug, saved_at::text from public.user_saved_drills where user_id = '${userId}'`,
  )) as unknown as Array<{ slug: string; saved_at: string }>;
}

/** The route's full PUT: upsert (tx 1) then read-back (tx 2). */
async function routePut(
  sql: Sql,
  userId: string,
  slug: string,
  between?: () => Promise<void>,
): Promise<PgResult & { savedAt?: string }> {
  const up = await upsertStmt(sql, userId, slug);
  if (up.status !== 201) return up;
  if (between) await between();
  const rb = await readBackStmt(sql, userId, slug);
  // index.ts: row.error || !row.data ⇒ serviceUnavailable ⇒ 503
  return rb.status === 200
    ? rb
    : { status: 503, code: rb.code ?? "readback-miss", rows: rb.rows };
}

async function timedRow(
  rows: Row[],
  round: number,
  i: number,
  op: string,
  tag: string | undefined,
  fn: () => Promise<PgResult>,
): Promise<PgResult> {
  const startedAt = performance.now();
  const out = await fn();
  rows.push({
    round,
    i,
    op,
    tag,
    status: out.status,
    code: out.code,
    startedAt: Math.round(startedAt * 100) / 100,
    endedAt: Math.round(performance.now() * 100) / 100,
  });
  return out;
}

class Deadline extends Error {}

async function bounded<T>(label: string, p: Promise<T>): Promise<T> {
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Deadline(`${label}: not settled within ${STRESS_DEADLINE_MS}ms`),
        ),
      STRESS_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([p, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Release `lanes` async functions together after all are parked. */
async function fire<T>(
  label: string,
  lanes: Array<(gate: Promise<void>) => Promise<T>>,
): Promise<T[]> {
  const b = barrier();
  const all = Promise.all(lanes.map((fn) => fn(b.gate)));
  await new Promise((r) => setTimeout(r, 2));
  b.open();
  return await bounded(label, all);
}

async function scenario(
  name: string,
  filter: string,
  run: (
    sql: Sql,
    prng: Prng,
    rows: Row[],
    invariants: StressInvariant[],
    inputs: Record<string, unknown>,
    observations: Record<string, unknown>,
  ) => Promise<void>,
): Promise<StressReport> {
  const sql = postgres(PG_URL, { max: LANES + 4, onnotice: () => {} });
  const prng = new Prng((STRESS_SEED ^ fnv1a(name)) >>> 0);
  const rows: Row[] = [];
  const invariants: StressInvariant[] = [];
  const inputs: Record<string, unknown> = {};
  const observations: Record<string, unknown> = {};
  const before = Deno.memoryUsage();
  const t0 = performance.now();
  try {
    await run(sql, prng, rows, invariants, inputs, observations);
  } catch (error) {
    if (error instanceof Deadline) {
      inv(invariants, "bounded wall time (no deadlock)", false, error.message);
    } else throw error;
  } finally {
    await sql.end({ timeout: 5 });
  }
  const report: StressReport = {
    scenario: name,
    seed: STRESS_SEED,
    scale: { rounds: ROUNDS, lanes: LANES },
    inputs,
    statusHistogram: histogram(
      rows.map((r) => `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`),
    ),
    counters: {},
    invariants,
    observations,
    requests: rows.length,
    durationMs: Math.round(performance.now() - t0),
    heap: { before, after: Deno.memoryUsage() },
    replay: `XC_PG_URL=<from ./xc_pg_up.sh> ${
      replay(FILE, filter, STRESS_SEED)
    }`,
    rows,
  };
  const path = await writeStressReport(report);
  reports.push(report);
  console.log(
    `[stress-pg] ${name}: ${rows.length} statements in ${report.durationMs}ms → ${path}`,
  );
  for (const i of invariants) {
    console.log(
      `[stress-pg]   ${
        i.holds ? "HELD  " : i.known ? `BROKEN(known:${i.known})` : "BROKEN"
      } ${i.name} — ${i.detail}`,
    );
  }
  return report;
}

function assertReport(report: StressReport): void {
  for (const i of report.invariants) {
    if (!i.known) {
      assert(i.holds, `${report.scenario}: ${i.name}: ${i.detail}`);
    }
  }
}

const errors = (rows: Row[]) => rows.filter((r) => r.status === 500);
const deadlocks = (rows: Row[]) => rows.filter((r) => r.code === "40P01");

// ─────────────────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress PG1: duplicate PUT burst from N connections — ON CONFLICT DO NOTHING yields one row, no error, one saved_at",
  ignore,
  async fn() {
    const report = await scenario(
      "pg1_duplicate_put_burst",
      "stress PG1",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const users: string[] = [];
        let multiRow = 0;
        let savedAtVariants = 0;
        let readbackMiss = 0;
        for (let r = 0; r < ROUNDS; r++) {
          const user = prng.uuid();
          users.push(user);
          await createUser(sql, user);
          const slug = ["wall-dink-rally", "skinny-singles"][r % 2];
          const results = await fire(
            `PG1 round ${r}`,
            Array.from(
              { length: LANES },
              (_, i) => async (gate: Promise<void>) => {
                await gate;
                return await timedRow(
                  rows,
                  r,
                  i,
                  "put",
                  `${user}:${slug}`,
                  () => routePut(sql, user, slug),
                );
              },
            ),
          );
          const savedAts = new Set(
            results.filter((x) => x.status === 200).map((x) =>
              (x as { savedAt?: string }).savedAt
            ),
          );
          if (savedAts.size > 1) savedAtVariants += 1;
          readbackMiss += results.filter((x) => x.status === 503).length;
          const mine = await ownerRows(sql, user);
          if (mine.length !== 1) multiRow += 1;
        }
        inputs.users = users;
        observations.readbackMiss = readbackMiss;
        inv(
          invariants,
          "every duplicate PUT sequence completes 200 (no unique_violation, no read-back miss without a DELETE)",
          rows.every((r) => r.status === 200),
          JSON.stringify(
            histogram(
              rows.map((r) => `${r.status}${r.code ? `:${r.code}` : ""}`),
            ),
          ),
        );
        inv(
          invariants,
          "exactly one row per (user, slug)",
          multiRow === 0,
          `${multiRow} rounds off`,
        );
        inv(
          invariants,
          "one saved_at across all duplicates",
          savedAtVariants === 0,
          `${savedAtVariants} rounds with >1 saved_at`,
        );
        inv(
          invariants,
          "no statement errors, no deadlocks",
          errors(rows).length === 0 && deadlocks(rows).length === 0,
          `${errors(rows).length} errors, ${deadlocks(rows).length} deadlocks`,
        );
      },
    );
    assertReport(report);
  },
});

Deno.test({
  name:
    "stress PG2: the route's upsert→read-back sequence racing the same user's DELETE — read-back returns 0 rows (edge maps to 503), rows ∈ {0,1}, no errors",
  ignore,
  async fn() {
    const report = await scenario(
      "pg2_put_delete_readback_race",
      "stress PG2",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const slug = "wall-dink-rally";
        // (a) deterministic: DELETE committed strictly between the two statements
        const detUser = prng.uuid();
        await createUser(sql, detUser);
        const det = await timedRow(
          rows,
          0,
          0,
          "det.put",
          `${detUser}:${slug}`,
          () =>
            routePut(sql, detUser, slug, async () => {
              await timedRow(
                rows,
                0,
                1,
                "det.delete",
                `${detUser}:${slug}`,
                () => deleteStmt(sql, detUser, slug),
              );
            }),
        );
        observations.deterministic = det;
        inv(
          invariants,
          "deterministic interleaving: upsert ok, DELETE ok, read-back finds 0 rows ⇒ route answers 503 (CONTRACT: 200)",
          det.status === 200,
          `route PUT outcome ${det.status} (${det.code ?? "ok"})`,
          det.status === 503 && det.code === "readback-miss"
            ? PUT_DELETE_RACE
            : undefined,
        );

        // (b) free burst: PUT sequences and DELETEs released together
        const users: string[] = [];
        let multiRow = 0;
        let finalDisagree = 0;
        for (let r = 1; r <= ROUNDS; r++) {
          const user = prng.uuid();
          users.push(user);
          await createUser(sql, user);
          const ops = prng.shuffle(
            Array.from(
              { length: LANES },
              (_, i) => (i % 3 === 2 ? "delete" : "put"),
            ),
          );
          await fire(
            `PG2 round ${r}`,
            ops.map((op, i) => async (gate: Promise<void>) => {
              await gate;
              await new Promise((res) => setTimeout(res, prng.int(0, 4)));
              return await timedRow(
                rows,
                r,
                i,
                op,
                `${user}:${slug}`,
                () =>
                  op === "put"
                    ? routePut(sql, user, slug)
                    : deleteStmt(sql, user, slug),
              );
            }),
          );
          const mine = await ownerRows(sql, user);
          if (mine.length > 1) {
            multiRow += 1;
          }
          const listed = await listStmt(sql, user);
          if (
            (listed.length === 1) !== (mine.length === 1) || listed.length > 1
          ) {
            finalDisagree += 1;
          }
        }
        inputs.users = users;
        const puts = rows.filter((r) => r.op === "put");
        const misses = puts.filter((r) =>
          r.status === 503 && r.code === "readback-miss"
        );
        observations.readbackMiss = misses.length;
        observations.putTotal = puts.length;
        inv(
          invariants,
          "every PUT sequence answers 200 (CONTRACT)",
          puts.every((r) => r.status === 200),
          `${misses.length}/${puts.length} PUT sequences hit a read-back miss (503 at the edge); ${
            JSON.stringify(histogram(puts.map((r) =>
              `${r.status}${r.code ? `:${r.code}` : ""}`
            )))
          }`,
          puts.every((r) =>
              r.status === 200 ||
              (r.status === 503 && r.code === "readback-miss")
            )
            ? PUT_DELETE_RACE
            : undefined,
        );
        inv(
          invariants,
          "rows per (user, slug) never exceed 1",
          multiRow === 0,
          `${multiRow} rounds with duplicates`,
        );
        inv(
          invariants,
          "every DELETE succeeds",
          rows.filter((r) => r.op === "delete").every((r) => r.status === 204),
          JSON.stringify(histogram(
            rows.filter((r) => r.op === "delete").map((r) => r.status),
          )),
        );
        inv(
          invariants,
          "final list agrees with the table",
          finalDisagree === 0,
          `${finalDisagree} disagreements`,
        );
        inv(
          invariants,
          "no statement errors, no deadlocks",
          errors(rows).length === 0 && deadlocks(rows).length === 0,
          `${errors(rows).length} errors, ${deadlocks(rows).length} deadlocks`,
        );
      },
    );
    assertReport(report);
  },
});

Deno.test({
  name:
    "stress PG3: two actors on one slug — RLS: B's DELETE/SELECT against A's row affects 0 rows while both write concurrently",
  ignore,
  async fn() {
    const report = await scenario(
      "pg3_two_actors_rls",
      "stress PG3",
      async (sql, prng, rows, invariants, inputs) => {
        const slug = "skinny-singles";
        let aLost = 0;
        let bSawA = 0;
        let bDeletedA = 0;
        const pairs: string[][] = [];
        for (let r = 0; r < ROUNDS; r++) {
          const a = prng.uuid();
          const b = prng.uuid();
          pairs.push([a, b]);
          await createUser(sql, a);
          await createUser(sql, b);
          await fire(
            `PG3 round ${r}`,
            Array.from(
              { length: LANES },
              (_, i) => async (gate: Promise<void>) => {
                await gate;
                if (i % 2 === 0) {
                  return await timedRow(
                    rows,
                    r,
                    i,
                    "A.put",
                    `A:${slug}`,
                    () => routePut(sql, a, slug),
                  );
                }
                // B alternates: own PUT/DELETE, and a DELETE that TARGETS A's row
                if (i % 4 === 1) {
                  return await timedRow(
                    rows,
                    r,
                    i,
                    "B.put",
                    `B:${slug}`,
                    () => routePut(sql, b, slug),
                  );
                }
                return await timedRow(
                  rows,
                  r,
                  i,
                  "B.delete-A",
                  `B:${slug}`,
                  async () => {
                    const out = await deleteStmt(sql, b, slug, a);
                    if (out.status === 204 && (out.rows ?? 0) > 0) {
                      bDeletedA += 1;
                    }
                    return out;
                  },
                );
              },
            ),
          );
          if ((await ownerRows(sql, a)).length !== 1) {
            aLost += 1;
          }
          bSawA += (await listStmt(sql, b, a)).length;
        }
        inputs.pairs = pairs;
        inv(
          invariants,
          "A's row survives every B.delete-A (RLS: 0 rows affected)",
          aLost === 0 && bDeletedA === 0,
          `${aLost} rounds lost, ${bDeletedA} cross-user deletes affected rows`,
        );
        inv(
          invariants,
          "B never sees A's rows",
          bSawA === 0,
          `${bSawA} rows visible`,
        );
        inv(
          invariants,
          "A's PUTs all 200 (nobody else can race A's read-back)",
          rows.filter((r) => r.op === "A.put").every((r) => r.status === 200),
          JSON.stringify(
            histogram(
              rows.filter((r) => r.op === "A.put").map((r) => r.status),
            ),
          ),
        );
        inv(
          invariants,
          "no statement errors, no deadlocks",
          errors(rows).length === 0 && deadlocks(rows).length === 0,
          `${errors(rows).length} errors, ${deadlocks(rows).length} deadlocks`,
        );
      },
    );
    assertReport(report);
  },
});

Deno.test({
  name:
    "stress PG4: slug oracle differential — user_saved_drills_slug_bounds accepts exactly what the route regex accepts, under concurrent inserts",
  ignore,
  async fn() {
    const report = await scenario(
      "pg4_slug_check_differential",
      "stress PG4",
      async (sql, prng, rows, invariants, inputs, observations) => {
        const user = prng.uuid();
        await createUser(sql, user);
        const corpus = fuzzSlugs(prng, ROUNDS * LANES).filter((c) =>
          c.decoded !== null && !c.decoded.includes("\0")
        );
        inputs.corpus = corpus.map((c) => ({ id: c.id, decoded: c.decoded }));
        const routeAccepts: Array<Record<string, unknown>> = [];
        const routeRejects: Array<Record<string, unknown>> = [];
        for (let r = 0; r < ROUNDS; r++) {
          const slice = corpus.slice(r * LANES, (r + 1) * LANES);
          await fire(
            `PG4 round ${r}`,
            slice.map((c, i) => async (gate: Promise<void>) => {
              await gate;
              const decoded = c.decoded!;
              const accepts = DRILL_SLUG_RE.test(decoded);
              const out = await timedRow(
                rows,
                r,
                i,
                accepts ? "route-accepts.insert" : "route-rejects.insert",
                `${user}:${c.id}`,
                () => upsertStmt(sql, user, decoded),
              );
              if (accepts && out.status !== 201) {
                routeAccepts.push({ id: c.id, decoded, code: out.code });
              }
              if (!accepts && !(out.status === 500 && out.code === "23514")) {
                routeRejects.push({
                  id: c.id,
                  decoded,
                  status: out.status,
                  code: out.code,
                });
              }
              return out;
            }),
          );
        }
        // null bytes: the route rejects them by regex; Postgres refuses the
        // literal outright — record the sqlstate for the report.
        const nul = await upsertStmt(sql, user, "wall\0dink");
        observations.nullByte = nul;
        observations.routeAcceptsPgRejects = routeAccepts;
        observations.routeRejectsPgAccepts = routeRejects;
        inv(
          invariants,
          "every slug the route accepts the CHECK accepts (otherwise PUT → 503 at the edge)",
          routeAccepts.length === 0,
          `${routeAccepts.length} mismatches: ${
            JSON.stringify(routeAccepts.slice(0, 5))
          }`,
        );
        inv(
          invariants,
          "every slug the route rejects the CHECK rejects with 23514 (defence in depth holds)",
          routeRejects.length === 0,
          `${routeRejects.length} mismatches: ${
            JSON.stringify(routeRejects.slice(0, 5))
          }`,
        );
        inv(
          invariants,
          "no deadlocks",
          deadlocks(rows).length === 0,
          `${deadlocks(rows).length}`,
        );
      },
    );
    assertReport(report);
  },
});

Deno.test({
  name:
    "stress PG5: insert/delete storm on 2 users × 2 slugs from N connections — no 40P01, bounded, ≤1 row per key",
  ignore,
  async fn() {
    const report = await scenario(
      "pg5_mixed_storm",
      "stress PG5",
      async (sql, prng, rows, invariants, inputs) => {
        const users = [prng.uuid(), prng.uuid()];
        for (const u of users) await createUser(sql, u);
        const slugs = ["wall-dink-rally", "skinny-singles"];
        inputs.users = users;
        let overflow = 0;
        for (let r = 0; r < ROUNDS * 2; r++) {
          await fire(
            `PG5 round ${r}`,
            Array.from(
              { length: LANES },
              (_, i) => async (gate: Promise<void>) => {
                await gate;
                const u = users[prng.int(0, 1)];
                const s = slugs[prng.int(0, 1)];
                const op = prng.int(0, 2) === 0 ? "delete" : "upsert";
                return await timedRow(
                  rows,
                  r,
                  i,
                  op,
                  `${u}:${s}`,
                  () =>
                    op === "delete"
                      ? deleteStmt(sql, u, s)
                      : upsertStmt(sql, u, s),
                );
              },
            ),
          );
          for (const u of users) {
            const mine = await ownerRows(sql, u);
            if (
              new Set(mine.map((m) => m.slug)).size !== mine.length
            ) overflow += 1;
          }
        }
        inv(
          invariants,
          "never more than one row per (user, slug)",
          overflow === 0,
          `${overflow} snapshots with duplicates`,
        );
        inv(
          invariants,
          "every statement succeeds (no 40P01 deadlock, no other error)",
          errors(rows).length === 0,
          JSON.stringify(
            histogram(
              rows.map((r) =>
                `${r.op}:${r.status}${r.code ? `:${r.code}` : ""}`
              ),
            ),
          ),
        );
      },
    );
    assertReport(report);
  },
});

Deno.test({
  name: "stress-pg: write summary.json",
  ignore,
  async fn() {
    const dir = stressOutDir();
    await Deno.mkdir(dir, { recursive: true });
    const summary = {
      unit: "edge-drills-media",
      lens: "concurrency",
      plane:
        "docker postgres:16 + shim_auth.sql + every migration (./xc_pg_up.sh)",
      seed: STRESS_SEED,
      scale: { STRESS_ITER, lanes: LANES, rounds: ROUNDS },
      statements: reports.reduce((n, r) => n + r.requests, 0),
      scenarios: reports.map((r) => ({
        scenario: r.scenario,
        statements: r.requests,
        durationMs: r.durationMs,
        outcome: r.invariants.every((i) => i.holds)
          ? "HELD"
          : r.invariants.every((i) => i.holds || i.known)
          ? `BROKEN(known:${
            [
              ...new Set(
                r.invariants.filter((i) => i.known).map((i) => i.known),
              ),
            ].join(",")
          })`
          : "BROKEN",
        broken: r.invariants.filter((i) => !i.holds).map((i) =>
          `${i.known ? `[known:${i.known}] ` : ""}${i.name} — ${i.detail}`
        ),
        observations: r.observations,
        replay: r.replay,
      })),
    };
    await Deno.writeTextFile(
      `${dir}summary.json`,
      JSON.stringify(summary, null, 2),
    );
    console.log(
      `[stress-pg] summary → ${dir}summary.json (${summary.statements} statements)`,
    );
    assertEquals(reports.length, 5, "every scenario reported");
  },
});
