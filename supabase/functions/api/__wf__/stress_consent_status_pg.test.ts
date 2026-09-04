/**
 * stress — GET /v1/me/consent/status, DIRECT Postgres half (lens: concurrency).
 *
 * The in-process campaign (stress_consent_status_concurrency.test.ts) proves
 * the real edge handler over a *modelled* consent ledger. This file drives the
 * exact SQL that PostgREST executes for the route — the SELECT in
 * index.ts loadConsentRows() and the INSERTs of grantConsent()/withdrawConsent()
 * — against a disposable postgres:16 with shim_auth.sql + every migration
 * applied (./xc_pg_up.sh), from N INDEPENDENT connections as role
 * `authenticated` with the caller's JWT sub, released from a barrier.
 *
 *   ./xc_pg_up.sh                         # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *     STRESS_PG_ITER=60 STRESS_OUT_DIR=/tmp/stress/ \
 *     deno test -A --no-check --config deno.json stress_consent_status_pg.test.ts
 *
 * Replay one seed: STRESS_ONLY_SEED=<seed> (same STRESS_SEED / STRESS_PG_LANES).
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Per seed (all lanes concurrent, one barrier; every lane opens its
 * transaction(s) AFTER the barrier, like PostgREST does per request, so
 * created_at = now() is stamped at request time, not at lane setup):
 *   writers  — W lanes (2 devices of the same user) each INSERT one grant or
 *              withdraw row exactly as the POST routes do (withdraw = read
 *              latest in one request/transaction, then insert carrying its
 *              version in a second one);
 *   readers  — R lanes run the route's SELECT and record client-side
 *              start/end plus server clock_timestamp() before/after;
 *   stranger — S lanes run the route's SELECT as a DIFFERENT user (RLS) and
 *              as the same user but with an explicit foreign user_id filter.
 * Invariants (asserted): every reader result is a fold of the committed
 * ledger at SOME instant inside its window (linearizable read under READ
 * COMMITTED); rows == inserts (none lost, none duplicated, ids distinct);
 * strangers see zero rows; UPDATE/DELETE by `authenticated` is refused
 * (append-only trigger + revoked grant); the (user_id, created_at, id) index
 * exists and the planner uses it for the route's query; bounded wall time.
 * Observed (not asserted): created_at order vs commit order under
 * contention (created_at = now() = transaction start, not commit).
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { envInt, Prng } from "./xc_concurrency_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const STRESS_PG_ITER = envInt("STRESS_PG_ITER", 3);
const LANES = envInt("STRESS_PG_LANES", 12);
const ITER_BUDGET_MS = envInt("STRESS_ITER_BUDGET_MS", 8_000);
const ONLY_SEED = Deno.env.get("STRESS_ONLY_SEED");

const CONSENT_SCOPES = [
  "video_analysis",
  "model_training",
  "evaluation_telemetry",
] as const;
type Scope = (typeof CONSENT_SCOPES)[number];
const TEST_FILE = "stress_consent_status_pg.test.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

function outDir(): string {
  const env = Deno.env.get("STRESS_OUT_DIR");
  if (env) return env.endsWith("/") ? env : `${env}/`;
  return new URL(
    "../../../../artifacts/stress-consent-status/latest/",
    import.meta.url,
  ).pathname;
}

/** Exactly the route's query (index.ts loadConsentRows). `created_at` is
 * read as text so the microsecond precision PostgREST serialises survives
 * (postgres.js would otherwise parse it to a millisecond Date). */
const ROUTE_SELECT =
  `select scope, action, consent_version, created_at::text as created_at
  from public.consent_records where user_id = $1 order by created_at asc, id asc`;
/** The same query as the planner sees it (no cast, as PostgREST issues it). */
const ROUTE_SELECT_PLAN = `select scope, action, consent_version, created_at
  from public.consent_records where user_id = $1 order by created_at asc, id asc`;

interface Row {
  scope: string;
  action: "grant" | "withdraw";
  consent_version: string | null;
  created_at: string;
}

interface Folded {
  scope: string;
  active: boolean;
  consentVersion: string | null;
  lastAction: "granted" | "withdrawn" | null;
  lastActionAt: string | null;
}

/** index.ts foldConsentStatus over rows already in query order. */
function fold(rows: Row[]): Folded[] {
  return CONSENT_SCOPES.map((scope) => {
    const last = rows.filter((r) => r.scope === scope).at(-1) ?? null;
    return {
      scope,
      active: last?.action === "grant",
      consentVersion: last?.consent_version ?? null,
      lastAction: last === null
        ? null
        : last.action === "grant"
        ? "granted"
        : "withdrawn",
      lastActionAt: last?.created_at ?? null,
    };
  });
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function serverNowMs(tx: Tx): Promise<number> {
  const r = await tx.unsafe(
    `select (extract(epoch from clock_timestamp()) * 1000)::float8 as t`,
  );
  return Number(r[0].t);
}

interface Commit {
  lane: number;
  tag: string;
  scope: Scope;
  action: "grant" | "withdraw";
  /** client instant right after COMMIT returned */
  committedAt: number;
  /** version the withdraw lane read before inserting (null for grants) */
  carried?: string | null;
}

interface Read {
  lane: number;
  kind: "reader" | "stranger" | "foreign-filter";
  startedAt: number;
  endedAt: number;
  serverStartMs: number;
  serverEndMs: number;
  rows: Row[];
  fold: Folded[];
}

interface IterationResult {
  seed: number;
  outcome: "HELD" | "BROKEN";
  failed: Array<{ name: string; detail: string }>;
  checks: number;
  inputs: Record<string, unknown>;
  observations: Record<string, unknown>;
  durationMs: number;
  replay: string;
  error?: string;
}

class Checks {
  n = 0;
  failed: Array<{ name: string; detail: string }> = [];
  obs: Record<string, unknown> = {};
  that(name: string, ok: boolean, detail = ""): void {
    this.n += 1;
    if (!ok) this.failed.push({ name, detail });
  }
  note(name: string, value: unknown): void {
    this.obs[name] = value;
  }
}

/** Was `body` the fold of some committed prefix available during [start, end]?
 * `ledger` is the final table in the route's own order (created_at, id); a
 * prefix is that order filtered to the seed rows plus the first k commits. */
function linearizable(
  body: Folded[],
  ledger: Array<Row & { source: string }>,
  commits: Commit[],
  start: number,
  end: number,
): string | null {
  const ordered = [...commits].sort((a, b) => a.committedAt - b.committedAt);
  const lo = ordered.filter((c) => c.committedAt <= start).length;
  const hi = ordered.filter((c) => c.committedAt <= end).length;
  const tried: number[] = [];
  for (let k = lo; k <= hi; k++) {
    const visible = new Set(ordered.slice(0, k).map((c) => c.tag));
    const rows = ledger.filter((r) =>
      !r.source?.startsWith("w") || visible.has(r.source)
    );
    if (same(fold(rows), body)) return null;
    tried.push(k);
  }
  return `no prefix in [${lo},${hi}] matches (tried ${tried.join(",")})`;
}

async function runIteration(sql: Sql, seed: number): Promise<IterationResult> {
  const prng = new Prng(seed);
  const c = new Checks();
  const t0 = performance.now();
  const uid = prng.uuid();
  const stranger = prng.uuid();
  const writers = prng.int(2, Math.max(2, Math.floor(LANES / 2)));
  const readers = Math.max(2, LANES - writers - 2);
  const seededRows = prng.int(0, 6);
  const ops = Array.from({ length: writers }, () => ({
    scope: CONSENT_SCOPES[prng.int(0, 2)],
    action: (prng.next() < 0.6 ? "grant" : "withdraw") as "grant" | "withdraw",
    version: `v${prng.int(1, 9)}`,
    delayMs: prng.int(0, 4),
  }));
  const readerDelays = Array.from({ length: readers }, () => prng.int(0, 6));
  const inputs = {
    uid,
    stranger,
    writers,
    readers,
    seededRows,
    ops,
    readerDelays,
    lanes: LANES,
  };
  const replay =
    `XC_PG_URL=$XC_PG_URL STRESS_ONLY_SEED=${seed} STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} ` +
    `deno test -A --no-check --config deno.json ${TEST_FILE}`;

  try {
    await createUser(sql, uid);
    await createUser(sql, stranger);
    // Seed rows as the POST routes would have (withdraw carries latest version).
    for (let k = 0; k < seededRows; k++) {
      const scope = CONSENT_SCOPES[prng.int(0, 2)];
      const action = prng.next() < 0.6 ? "grant" : "withdraw";
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, uid);
        if (action === "grant") {
          await tx.unsafe(
            `insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
             values ('${uid}', '${scope}', 'v${
              prng.int(1, 5)
            }', 'grant', 'stress_seed', null, null)`,
          );
        } else {
          const before =
            (await tx.unsafe(ROUTE_SELECT, [uid])) as unknown as Row[];
          const latest = before.filter((r) => r.scope === scope).at(-1) ?? null;
          await tx.unsafe(
            `insert into public.consent_records (user_id, scope, consent_version, action, source, device)
             values ('${uid}', '${scope}', ${
              latest?.consent_version ? `'${latest.consent_version}'` : "null"
            }, 'withdraw', 'stress_seed', null)`,
          );
        }
      });
    }
    const seededLedger =
      (await sql.unsafe(ROUTE_SELECT, [uid])) as unknown as Row[];
    c.note("seeded_rows_in_ledger", seededLedger.length);

    const b = barrier();
    let ready = 0;
    const commits: Commit[] = [];
    const reads: Read[] = [];
    const laneErrors: string[] = [];
    const lanes: Promise<void>[] = [];

    /** One PostgREST request = one transaction as the user, opened on demand. */
    const asRequest = <T>(
      who: string,
      fn: (tx: Tx) => Promise<T>,
    ): Promise<T> =>
      sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, who);
        return await fn(tx as unknown as Tx);
      }) as unknown as Promise<T>;

    // Writers: grant = one request; withdraw = read request, then insert request.
    ops.forEach((op, lane) => {
      const tag = `w${lane}`;
      lanes.push(
        (async () => {
          ready += 1;
          await b.gate;
          if (op.delayMs) await new Promise((r) => setTimeout(r, op.delayMs));
          let carried: string | null = null;
          if (op.action === "grant") {
            await asRequest(uid, (tx) =>
              tx.unsafe(
                `insert into public.consent_records (user_id, scope, consent_version, action, source, device, capture_mode)
                 values ('${uid}', '${op.scope}', '${op.version}', 'grant', '${tag}', null, null)`,
              ));
          } else {
            const before = await asRequest(
              uid,
              (tx) =>
                tx.unsafe(ROUTE_SELECT, [uid]) as unknown as Promise<Row[]>,
            );
            carried = before.filter((r) =>
              r.scope === op.scope
            ).at(-1)?.consent_version ?? null;
            await asRequest(uid, (tx) =>
              tx.unsafe(
                `insert into public.consent_records (user_id, scope, consent_version, action, source, device)
                 values ('${uid}', '${op.scope}', ${
                  carried ? `'${carried}'` : "null"
                }, 'withdraw', '${tag}', null)`,
              ));
          }
          commits.push({
            lane,
            tag,
            scope: op.scope,
            action: op.action,
            committedAt: performance.now(),
            carried,
          });
        })().catch((e) => {
          laneErrors.push(
            `writer ${lane}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }),
      );
    });

    const readLane = (
      lane: number,
      kind: Read["kind"],
      who: string,
      filter: string,
      delayMs: number,
    ) =>
      (async () => {
        ready += 1;
        await b.gate;
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        const startedAt = performance.now();
        await asRequest(who, async (tx) => {
          const serverStartMs = await serverNowMs(tx);
          const rows =
            (await tx.unsafe(ROUTE_SELECT, [filter])) as unknown as Row[];
          const serverEndMs = await serverNowMs(tx);
          const endedAt = performance.now();
          reads.push({
            lane,
            kind,
            startedAt,
            endedAt,
            serverStartMs,
            serverEndMs,
            rows,
            fold: fold(rows),
          });
        });
      })().catch((e) => {
        laneErrors.push(
          `${kind} ${lane}: ${e instanceof Error ? e.message : String(e)}`,
        );
      });

    readerDelays.forEach((d, i) =>
      lanes.push(readLane(100 + i, "reader", uid, uid, d))
    );
    lanes.push(readLane(200, "stranger", stranger, uid, prng.int(0, 3)));
    lanes.push(readLane(201, "foreign-filter", uid, stranger, prng.int(0, 3)));

    const total = writers + readers + 2;
    while (ready < total) await new Promise((r) => setTimeout(r, 1));
    b.open();
    const budget = new Promise<"timeout">((r) =>
      setTimeout(() => r("timeout"), ITER_BUDGET_MS)
    );
    const outcome = await Promise.race([
      Promise.all(lanes).then(() => "done" as const),
      budget,
    ]);
    c.that(
      "bounded_wall_time_no_deadlock",
      outcome === "done",
      `lanes did not settle within ${ITER_BUDGET_MS}ms`,
    );
    if (outcome !== "done") throw new Error("iteration exceeded budget");
    c.that("no_lane_errors", laneErrors.length === 0, laneErrors.join("; "));

    // Final ledger (owner view) — exact row accounting.
    const finalRows = (await sql.unsafe(
      `select id, scope, action, consent_version, source, created_at::text as created_at
         from public.consent_records where user_id = $1 order by created_at asc, id asc`,
      [uid],
    )) as unknown as Array<Row & { id: string; source: string }>;
    c.that(
      "rows_equal_seeded_plus_inserts",
      finalRows.length === seededRows + writers,
      `rows=${finalRows.length} expected=${seededRows + writers}`,
    );
    c.that(
      "ids_distinct",
      new Set(finalRows.map((r) => r.id)).size === finalRows.length,
    );
    const tags = finalRows.filter((r) => r.source?.startsWith("w")).map((r) =>
      r.source
    );
    c.that(
      "every_writer_row_present_once",
      same([...tags].sort(), ops.map((_, i) => `w${i}`).sort()),
      tags.join(","),
    );

    const readerReads = reads.filter((r) => r.kind === "reader");
    c.that(
      "all_readers_returned",
      readerReads.length === readers,
      `${readerReads.length}/${readers}`,
    );
    const lin = readerReads
      .map((r) => ({
        lane: r.lane,
        err: linearizable(r.fold, finalRows, commits, r.startedAt, r.endedAt),
      }))
      .filter((x) => x.err);
    c.that(
      "every_read_is_linearizable_snapshot",
      lin.length === 0,
      lin.map((x) => `lane ${x.lane}: ${x.err}`).join("; "),
    );
    // The final read (after every commit) must equal the fold of the whole ledger.
    const finalFold = fold(finalRows);
    const settled = (await sql.unsafe(ROUTE_SELECT, [uid])) as unknown as Row[];
    c.that(
      "settled_read_equals_final_ledger_fold",
      same(fold(settled), finalFold),
    );
    // Observation: withdraw rows whose carried version is stale because a
    // grant of the same scope committed between the withdraw's read and its
    // insert (the two-request race in index.ts withdrawConsent).
    const staleCarry = finalRows
      .map((r, idx) => {
        if (r.action !== "withdraw" || !r.source?.startsWith("w")) return null;
        const prev = finalRows.slice(0, idx).filter((p) => p.scope === r.scope)
          .at(-1);
        const expected = prev?.consent_version ?? null;
        return expected === r.consent_version ? null : {
          row: r.source,
          carried: r.consent_version,
          latestBefore: expected,
        };
      })
      .filter((x) => x !== null);
    c.note("withdraw_version_carry_mismatches", staleCarry.length);
    if (staleCarry.length > 0) {
      c.note("withdraw_version_carry_detail", staleCarry);
    }
    // Same-user reads that overlap no commit must agree with each other.
    const quiet = readerReads.filter((r) =>
      !commits.some((cm) =>
        cm.committedAt > r.startedAt && cm.committedAt < r.endedAt
      )
    );
    c.note("reads_overlapping_no_commit", quiet.length);
    c.note("reads_overlapping_a_commit", readerReads.length - quiet.length);

    const strangers = reads.filter((r) => r.kind !== "reader");
    c.that("strangers_returned", strangers.length === 2);
    c.that(
      "rls_stranger_sees_zero_rows",
      strangers.every((r) => r.rows.length === 0),
      strangers.map((r) => `${r.kind}=${r.rows.length}`).join(","),
    );
    c.that(
      "stranger_fold_is_all_inactive",
      strangers.every((r) => same(r.fold, fold([]))),
    );

    // Append-only: the ledger refuses client rewrites (grant revoked + trigger).
    let updErr = "";
    let delErr = "";
    try {
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, uid);
        await tx.unsafe(
          `update public.consent_records set action = 'grant' where user_id = '${uid}'`,
        );
      });
    } catch (e) {
      updErr = e instanceof Error ? e.message : String(e);
    }
    try {
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, uid);
        await tx.unsafe(
          `delete from public.consent_records where user_id = '${uid}'`,
        );
      });
    } catch (e) {
      delErr = e instanceof Error ? e.message : String(e);
    }
    c.that("client_update_refused", updErr !== "", "update succeeded");
    c.that("client_delete_refused", delErr !== "", "delete succeeded");
    c.note("append_only_errors", {
      update: updErr.slice(0, 80),
      delete: delErr.slice(0, 80),
    });
    const after = (await sql.unsafe(
      `select count(*)::int as n from public.consent_records where user_id = $1`,
      [uid],
    )) as unknown as Array<{ n: number }>;
    c.that(
      "ledger_unchanged_after_refused_rewrites",
      after[0].n === finalRows.length,
    );

    // Index + plan for the route's query.
    const idx = (await sql.unsafe(
      `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'consent_records' and indexname = 'consent_records_user_created_idx'`,
    )) as unknown as Array<{ indexdef: string }>;
    c.that(
      "user_created_id_index_exists",
      idx.length === 1 && /\(user_id, created_at, id\)/.test(idx[0].indexdef),
      idx[0]?.indexdef ?? "missing",
    );
    // With seq/bitmap scans disabled the only remaining path is an ordered
    // index scan — it must satisfy the ORDER BY without a Sort node (i.e. the
    // index really covers (user_id, created_at, id) in the route's order).
    const plan = (await sql.unsafe(
      `set local enable_seqscan = off; set local enable_bitmapscan = off;
       explain (format json) ${ROUTE_SELECT_PLAN.replace("$1", `'${uid}'`)}`,
    )) as unknown as Array<{ "QUERY PLAN": unknown }>;
    const planText = JSON.stringify(plan.at(-1)?.["QUERY PLAN"] ?? plan);
    c.that(
      "planner_can_use_ledger_index",
      planText.includes("consent_records_user_created_idx"),
      planText.slice(0, 200),
    );
    c.that(
      "index_scan_needs_no_sort",
      !planText.includes('"Node Type":"Sort"'),
      planText.slice(0, 300),
    );
    c.note(
      "plan_node_types",
      [...planText.matchAll(/"Node Type":"([^"]+)"/g)].map((m) => m[1]),
    );

    // Observation: created_at (= now() at tx start) order vs commit order.
    const commitOrder = [...commits].sort((a, b) =>
      a.committedAt - b.committedAt
    ).map((x) => x.tag);
    const createdOrder = finalRows.filter((r) => r.source?.startsWith("w")).map(
      (r) => r.source,
    );
    c.note("commit_order", commitOrder);
    c.note("created_at_order", createdOrder);
    c.note(
      "created_at_order_equals_commit_order",
      same(commitOrder, createdOrder),
    );
    const ties = new Set(finalRows.map((r) =>
      String(r.created_at)
    )).size !== finalRows.length;
    c.note("created_at_ties", ties);
    // Last-committed vs fold divergence per scope (only possible when orders differ).
    const lastCommittedByScope = CONSENT_SCOPES.map((scope) => {
      const last = [...commits].sort((a, b) => a.committedAt - b.committedAt)
        .filter((x) => x.scope === scope).at(-1);
      return last ? { scope, active: last.action === "grant" } : null;
    }).filter((x) => x !== null);
    const divergent = lastCommittedByScope.filter((x) =>
      finalFold.find((f) => f.scope === x!.scope)!.active !== x!.active
    );
    c.note(
      "scopes_where_fold_differs_from_last_committed_action",
      divergent.map((x) => x!.scope),
    );
    c.note(
      "server_read_windows_ms",
      readerReads.map((r) =>
        Math.round((r.serverEndMs - r.serverStartMs) * 100) / 100
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    c.that("iteration_completed_without_exception", false, msg);
    return {
      seed,
      outcome: "BROKEN",
      failed: c.failed,
      checks: c.n,
      inputs,
      observations: c.obs,
      durationMs: Math.round((performance.now() - t0) * 100) / 100,
      replay,
      error: msg,
    };
  }
  return {
    seed,
    outcome: c.failed.length === 0 ? "HELD" : "BROKEN",
    failed: c.failed,
    checks: c.n,
    inputs,
    observations: c.obs,
    durationMs: Math.round((performance.now() - t0) * 100) / 100,
    replay,
  };
}

Deno.test({
  name:
    `stress-pg GET /v1/me/consent/status ledger concurrency (STRESS_PG_ITER=${STRESS_PG_ITER}, STRESS_SEED=${STRESS_SEED}, lanes=${LANES})`,
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 4, prepare: false });
    try {
      const seeds = ONLY_SEED
        ? [Number(ONLY_SEED)]
        : Array.from({ length: STRESS_PG_ITER }, (_, i) => STRESS_SEED + i);
      const results: IterationResult[] = [];
      const t0 = performance.now();
      for (const seed of seeds) results.push(await runIteration(sql, seed));
      const broken = results.filter((r) => r.outcome === "BROKEN");
      const report = {
        route: "GET /v1/me/consent/status",
        plane: "postgres:16 + every migration (disposable, ./xc_pg_up.sh)",
        file: TEST_FILE,
        config: {
          STRESS_SEED,
          STRESS_PG_ITER,
          LANES,
          ITER_BUDGET_MS,
          ONLY_SEED: ONLY_SEED ?? null,
        },
        summary: {
          executed: results.length,
          held: results.length - broken.length,
          broken: broken.length,
          brokenSeeds: broken.map((r) => r.seed),
          checks: results.reduce((a, r) => a + r.checks, 0),
          durationMs: Math.round((performance.now() - t0) * 100) / 100,
          maxIterationMs: Math.max(0, ...results.map((r) => r.durationMs)),
          readsOverlappingACommit: results.reduce(
            (a, r) =>
              a + Number(r.observations.reads_overlapping_a_commit ?? 0),
            0,
          ),
          seedsWhereCreatedAtOrderDiffersFromCommitOrder: results
            .filter((r) =>
              r.observations.created_at_order_equals_commit_order === false
            )
            .map((r) => r.seed),
          seedsWhereFoldDiffersFromLastCommittedAction: results
            .filter((r) =>
              ((r.observations
                .scopes_where_fold_differs_from_last_committed_action as unknown[]) ??
                []).length > 0
            )
            .map((r) => r.seed),
        },
        replayAll:
          `XC_PG_URL=$XC_PG_URL STRESS_SEED=${STRESS_SEED} STRESS_PG_ITER=${STRESS_PG_ITER} STRESS_PG_LANES=${LANES} deno test -A --no-check --config deno.json ${TEST_FILE}`,
        iterations: results,
      };
      const dir = outDir();
      await Deno.mkdir(dir, { recursive: true });
      const path = `${dir}consent_status_pg.json`;
      await Deno.writeTextFile(path, JSON.stringify(report, null, 2));
      console.log(
        `stress-pg consent: executed=${report.summary.executed} held=${report.summary.held} broken=${report.summary.broken} → ${path}`,
      );
      assert(results.length === seeds.length, "every seed must run");
      assertEquals(
        broken.map((r) => ({ seed: r.seed, failed: r.failed, error: r.error })),
        [],
        `BROKEN seeds — replay each with its \`replay\` command in ${path}`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
