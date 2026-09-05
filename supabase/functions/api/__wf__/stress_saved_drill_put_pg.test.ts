/**
 * stress/saved-drill PUT — REAL Postgres half.
 *
 * `PUT /v1/me/saved-drills/:slug` never calls an RPC: it issues two PostgREST
 * table requests through the caller's RLS-scoped client —
 *
 *   INSERT INTO public.user_saved_drills (user_id, slug) VALUES ($1, $2)
 *     ON CONFLICT (user_id, slug) DO NOTHING            -- upsert, ignoreDuplicates
 *   SELECT slug, saved_at FROM public.user_saved_drills
 *     WHERE user_id = $1 AND slug = $2                  -- read-back, maybeSingle
 *
 * The in-process files (stress_saved_drill_put_{faults,load,l1_memory}) prove
 * the handler over a MODELLED PostgREST. This file drives the exact statements
 * PostgREST derives from those two calls on a disposable postgres:16 with
 * supabase/tests/shim_auth.sql + EVERY migration applied (./xc_pg_up.sh), on N
 * INDEPENDENT connections, each in its own transaction as role `authenticated`
 * with the caller's JWT sub, released from a barrier so the primary-key race
 * (duplicate delivery of the same PUT) genuinely contends.
 *
 *   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh   # prints XC_PG_URL
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres \
 *     STRESS_OUT_DIR=/tmp/stress-pg/ deno test -A --no-check --config deno.json \
 *     stress_saved_drill_put_pg.test.ts
 *
 * Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
 *
 * Seeded (STRESS_SEED): every user id and slug replays from the seed. Scale
 * knobs: STRESS_PG_LANES (default 16 concurrent connections), STRESS_PG_ROUNDS
 * (default 6), STRESS_PG_SLUGS (default 400 fuzzed slugs for the route-regex vs
 * DB-check agreement scan). Each scenario writes <STRESS_OUT_DIR>/pg_*.json.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  histogram,
  latencySummary,
  Prng,
  STRESS_SEED,
  writeArtifact,
} from "./stress_saved_drill_put_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);
const ROUNDS = envInt("STRESS_PG_ROUNDS", 6);
const SLUG_FUZZ = envInt("STRESS_PG_SLUGS", 400);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** The route's slug gate, read from index.ts at test time so the two halves
 * cannot drift silently (the production constant is module-private). */
async function routeSlugRegex(): Promise<RegExp> {
  const source = await Deno.readTextFile(
    new URL("../index.ts", import.meta.url),
  );
  const m = /const DRILL_SLUG_RE = \/(.+)\/([a-z]*);/.exec(source);
  assert(m, "DRILL_SLUG_RE not found in index.ts");
  return new RegExp(m[1], m[2]);
}

interface PgError {
  code?: string;
  message: string;
}

function pgError(err: unknown): PgError {
  if (typeof err === "object" && err !== null) {
    const e = err as { code?: unknown; message?: unknown };
    return {
      code: typeof e.code === "string" ? e.code : undefined,
      message: typeof e.message === "string" ? e.message : String(err),
    };
  }
  return { message: String(err) };
}

function barrier(): { gate: Promise<void>; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  return { gate, open };
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asAnon(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role anon`);
  await tx.unsafe(`set local request.jwt.claim.sub = ''`);
}

/** Owner-role fixture: an auth.users row (the migrations' trigger creates the
 * public.profiles row the saved-drills FK points at). Seeded ids repeat across
 * runs against the same disposable DB, so remove a previous run's user first. */
async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

const q = (s: string) => s.replace(/'/g, "''");

/** The route's first PostgREST call. postgres.js exposes the command tag's
 * row count, so `inserted` distinguishes the lane that created the row (1)
 * from the lanes that hit DO NOTHING (0). */
async function routeUpsert(
  tx: Tx,
  userId: string,
  slug: string,
): Promise<number> {
  const r = await tx.unsafe(
    `insert into public.user_saved_drills (user_id, slug) values ('${userId}', '${
      q(slug)
    }')
       on conflict (user_id, slug) do nothing`,
  );
  return r.count;
}

/** The route's second PostgREST call (maybeSingle → 0 or 1 rows). */
async function routeReadBack(
  tx: Tx,
  userId: string,
  slug: string,
): Promise<Array<{ slug: string; saved_at: string }>> {
  const rows = await tx.unsafe(
    `select slug, saved_at::text as saved_at from public.user_saved_drills
       where user_id = '${userId}' and slug = '${q(slug)}'`,
  );
  return rows as unknown as Array<{ slug: string; saved_at: string }>;
}

interface LaneRow {
  round: number;
  lane: number;
  userId: string;
  slug: string;
  inserted: number | null;
  readBackRows: number;
  savedAt: string | null;
  error: PgError | null;
  ms: number;
}

/** Run the route's two statements on `lanes` independent connections, each in
 * its own transaction as `userIdFor(lane)`, released together. Commits, so the
 * property under test (one row, one saved_at, every lane sees it) is what a
 * client sees after N duplicate PUTs land at once. */
async function burst(
  sql: Sql,
  round: number,
  lanes: number,
  userIdFor: (lane: number) => string,
  slugFor: (lane: number) => string,
): Promise<LaneRow[]> {
  const b = barrier();
  let ready = 0;
  const rows: LaneRow[] = [];
  const all = Promise.all(
    Array.from({ length: lanes }, (_, lane) =>
      sql
        .begin(async (tx) => {
          const t = tx as unknown as Tx;
          const userId = userIdFor(lane);
          const slug = slugFor(lane);
          await asUser(t, userId);
          ready += 1;
          await b.gate;
          const t0 = performance.now();
          const row: LaneRow = {
            round,
            lane,
            userId,
            slug,
            inserted: null,
            readBackRows: 0,
            savedAt: null,
            error: null,
            ms: 0,
          };
          try {
            row.inserted = await routeUpsert(t, userId, slug);
            const back = await routeReadBack(t, userId, slug);
            row.readBackRows = back.length;
            row.savedAt = back[0]?.saved_at ?? null;
          } catch (err) {
            row.error = pgError(err);
            rows.push(row);
            throw err; // rolls this lane back; the others commit
          }
          row.ms = Math.round((performance.now() - t0) * 100) / 100;
          rows.push(row);
        })
        .catch(() => undefined)),
  );
  while (ready < lanes) await new Promise((r) => setTimeout(r, 1));
  b.open();
  await all;
  rows.sort((a, b) => a.lane - b.lane);
  return rows;
}

function connect(): Sql {
  return postgres(PG_URL, {
    max: LANES + 4,
    idle_timeout: 5,
    connect_timeout: 10,
  });
}

async function tableRows(
  sql: Sql,
  userId: string,
): Promise<Array<{ slug: string; saved_at: string }>> {
  const rows = await sql.unsafe(
    `select slug, saved_at::text as saved_at from public.user_saved_drills where user_id = '${userId}' order by slug`,
  );
  return rows as unknown as Array<{ slug: string; saved_at: string }>;
}

// ── PG-SD1: duplicate delivery of the same PUT ───────────────────────────────

Deno.test({
  name:
    `stress/saved-drill PUT pg: PG-SD1 ${LANES} concurrent duplicate PUTs × ${ROUNDS} rounds → one row, one saved_at, every lane 200-shaped`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d1);
    const violations: string[] = [];
    const rounds: Array<Record<string, unknown>> = [];
    const latencies: number[] = [];
    try {
      for (let round = 0; round < ROUNDS; round++) {
        const userId = prng.uuid();
        const slug = prng.slug(40);
        await createUser(sql, userId);

        // Burst 1: N duplicate deliveries race for the primary key.
        const first = await burst(sql, round, LANES, () => userId, () => slug);
        const inserted = first.reduce((n, r) => n + (r.inserted ?? 0), 0);
        const errors = first.filter((r) => r.error);
        const savedAts = new Set(
          first.map((r) => r.savedAt).filter((s): s is string => s !== null),
        );
        const stored = await tableRows(sql, userId);
        for (const r of first) latencies.push(r.ms);

        if (errors.length) {
          violations.push(
            `round ${round}: ${errors.length} lanes errored: ${
              JSON.stringify(errors.map((e) => e.error))
            }`,
          );
        }
        if (inserted !== 1) {
          violations.push(
            `round ${round}: ${inserted} lanes reported INSERT 1 (expected exactly 1)`,
          );
        }
        if (first.some((r) => r.readBackRows !== 1)) {
          violations.push(
            `round ${round}: a lane's read-back did not return exactly one row`,
          );
        }
        if (savedAts.size !== 1) {
          violations.push(
            `round ${round}: lanes observed ${savedAts.size} distinct saved_at values`,
          );
        }
        if (stored.length !== 1 || stored[0].slug !== slug) {
          violations.push(
            `round ${round}: table holds ${stored.length} rows for the user (expected 1 × ${slug})`,
          );
        }

        // Burst 2 (replayed PUT after commit): must not bump saved_at, must not insert.
        await new Promise((r) => setTimeout(r, 5));
        const replay = await burst(
          sql,
          round,
          Math.min(LANES, 4),
          () => userId,
          () => slug,
        );
        const replayInserted = replay.reduce(
          (n, r) => n + (r.inserted ?? 0),
          0,
        );
        const replaySavedAts = new Set(replay.map((r) => r.savedAt));
        if (replayInserted !== 0) {
          violations.push(
            `round ${round}: replay inserted ${replayInserted} rows`,
          );
        }
        if (
          replaySavedAts.size !== 1 ||
          !savedAts.has([...replaySavedAts][0] as string)
        ) {
          violations.push(
            `round ${round}: replay saved_at ${[
              ...replaySavedAts,
            ]} differs from original ${[...savedAts]}`,
          );
        }

        rounds.push({
          round,
          userId,
          slug,
          lanes: first,
          inserted,
          distinctSavedAt: savedAts.size,
          storedRows: stored.length,
          replay: {
            lanes: replay.length,
            inserted: replayInserted,
            savedAtStable: replaySavedAts.size === 1 &&
              savedAts.has([...replaySavedAts][0] as string),
          },
        });
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    const path = await writeArtifact("pg_sd1_duplicate_delivery", {
      seed: STRESS_SEED,
      replay:
        `XC_PG_URL=… STRESS_SEED=${STRESS_SEED} STRESS_PG_LANES=${LANES} STRESS_PG_ROUNDS=${ROUNDS} deno test -A --no-check --config deno.json stress_saved_drill_put_pg.test.ts`,
      lanes: LANES,
      rounds,
      latencyMs: latencySummary(latencies),
      statementsPerRequest: 2,
      violations,
    });
    console.log(
      `[stress] pg PG-SD1: rounds=${ROUNDS} lanes=${LANES} lane-latency p50=${
        latencySummary(latencies).p50
      }ms p95=${
        latencySummary(latencies).p95
      }ms violations=${violations.length} → ${path}`,
    );
    if (violations.length) {
      throw new Error(`PG-SD1 violations:\n${violations.join("\n")}`);
    }
  },
});

// ── PG-SD2: many users, one popular slug, under RLS ──────────────────────────

Deno.test({
  name:
    `stress/saved-drill PUT pg: PG-SD2 ${LANES} distinct users save the same slug at once → N rows, each user reads back only their own`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d2);
    const violations: string[] = [];
    const users = Array.from({ length: LANES }, () => prng.uuid());
    const slug = prng.slug(40);
    let lanes: LaneRow[] = [];
    let total = 0;
    let crossVisible = 0;
    try {
      for (const u of users) await createUser(sql, u);
      lanes = await burst(sql, 0, LANES, (lane) => users[lane], () => slug);
      const inserted = lanes.reduce((n, r) => n + (r.inserted ?? 0), 0);
      if (inserted !== LANES) {
        violations.push(`${inserted} rows inserted for ${LANES} users`);
      }
      if (lanes.some((r) => r.error)) {
        violations.push(`errors: ${
          JSON.stringify(
            lanes.filter((r) => r.error).map((r) => r.error),
          )
        }`);
      }
      if (lanes.some((r) => r.readBackRows !== 1)) {
        violations.push("a user's read-back did not return exactly one row");
      }
      total = Number(
        (await sql.unsafe(
          `select count(*)::int as n from public.user_saved_drills where slug = '${
            q(slug)
          }'`,
        ))[0].n,
      );
      if (total !== LANES) {
        violations.push(
          `table holds ${total} rows for slug (expected ${LANES})`,
        );
      }
      // RLS: as user[0], a slug-only filter (what a buggy client without .eq(user_id) would send) sees ONLY its own row.
      await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, users[0]);
        const rows = await tx.unsafe(
          `select user_id::text as user_id from public.user_saved_drills where slug = '${
            q(slug)
          }'`,
        );
        crossVisible = rows.length;
        if (rows.length !== 1 || rows[0].user_id !== users[0]) {
          violations.push(
            `RLS leak: user[0] sees ${rows.length} rows for the slug`,
          );
        }
      });
    } finally {
      await sql.end({ timeout: 5 });
    }
    const path = await writeArtifact("pg_sd2_many_users_one_slug", {
      seed: STRESS_SEED,
      slug,
      users,
      lanes,
      totalRowsForSlug: total,
      rowsVisibleToUser0: crossVisible,
      violations,
    });
    console.log(
      `[stress] pg PG-SD2: users=${LANES} rows=${total} visibleToOne=${crossVisible} violations=${violations.length} → ${path}`,
    );
    if (violations.length) {
      throw new Error(`PG-SD2 violations:\n${violations.join("\n")}`);
    }
  },
});

// ── PG-SD3: tenant isolation for the exact statements the route issues ──────

Deno.test({
  name:
    "stress/saved-drill PUT pg: PG-SD3 cross-tenant upsert/read-back/delete and anon are refused by RLS/grants",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d3);
    const a = prng.uuid();
    const b = prng.uuid();
    const slug = prng.slug(30);
    const cases: Array<Record<string, unknown>> = [];
    const violations: string[] = [];
    let grants: Array<{ privilege_type: string; column_name: string }> = [];
    const attempt = async (
      id: string,
      who: "a" | "anon",
      statement: string,
      expect: { codes?: string[]; rows?: number; count?: number },
    ) => {
      let outcome: Record<string, unknown> = {};
      try {
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          if (who === "anon") await asAnon(t);
          else await asUser(t, a);
          const r = await t.unsafe(statement);
          outcome = { rows: r.length, count: r.count };
        });
      } catch (err) {
        outcome = { error: pgError(err) };
      }
      let held = true;
      if (expect.codes) {
        held = expect.codes.includes(
          String((outcome.error as PgError | undefined)?.code),
        );
      }
      if (expect.rows !== undefined) {
        held = held && outcome.rows === expect.rows;
      }
      if (expect.count !== undefined) {
        held = held && outcome.count === expect.count;
      }
      cases.push({ id, who, statement, expect, outcome, held });
      if (!held) {
        violations.push(
          `${id}: expected ${JSON.stringify(expect)} got ${
            JSON.stringify(outcome)
          }`,
        );
      }
    };
    try {
      await createUser(sql, a);
      await createUser(sql, b);
      // B owns the slug (owner-role fixture).
      await sql.unsafe(
        `insert into public.user_saved_drills (user_id, slug) values ('${b}', '${
          q(slug)
        }')`,
      );

      // A's client tampered user_id → the route's upsert with check fails.
      await attempt(
        "a-upserts-for-b",
        "a",
        `insert into public.user_saved_drills (user_id, slug) values ('${b}', '${
          q(slug)
        }') on conflict (user_id, slug) do nothing`,
        { codes: ["42501"] },
      );
      // Same, but a slug B does not yet have (no conflict path, pure insert).
      await attempt(
        "a-inserts-new-for-b",
        "a",
        `insert into public.user_saved_drills (user_id, slug) values ('${b}', '${
          q(slug)
        }-x') on conflict (user_id, slug) do nothing`,
        { codes: ["42501"] },
      );
      // A reads B's row with the route's read-back filter → 0 rows (maybeSingle → null → 503, never B's data).
      await attempt(
        "a-reads-b",
        "a",
        `select slug, saved_at from public.user_saved_drills where user_id = '${b}' and slug = '${
          q(slug)
        }'`,
        { rows: 0 },
      );
      // A deletes B's bookmark (the sibling DELETE route's statement) → 0 rows affected.
      await attempt(
        "a-deletes-b",
        "a",
        `delete from public.user_saved_drills where user_id = '${b}' and slug = '${
          q(slug)
        }'`,
        { count: 0 },
      );
      // A updates B's saved_at → 0 rows affected. (The migrations grant
      // authenticated UPDATE on this table although the edge fn never updates
      // it — RLS is the only thing standing here; recorded below as evidence.)
      await attempt(
        "a-updates-b",
        "a",
        `update public.user_saved_drills set saved_at = now() where user_id = '${b}'`,
        { count: 0 },
      );
      // anon (no bearer) → no grant at all.
      await attempt(
        "anon-upsert",
        "anon",
        `insert into public.user_saved_drills (user_id, slug) values ('${a}', '${
          q(slug)
        }') on conflict (user_id, slug) do nothing`,
        { codes: ["42501"] },
      );
      await attempt(
        "anon-select",
        "anon",
        `select slug, saved_at from public.user_saved_drills where user_id = '${b}'`,
        { codes: ["42501"] },
      );
      // Control: A's own upsert + read-back succeed.
      await attempt(
        "a-own-upsert",
        "a",
        `insert into public.user_saved_drills (user_id, slug) values ('${a}', '${
          q(slug)
        }') on conflict (user_id, slug) do nothing`,
        { count: 1 },
      );
      await attempt(
        "a-own-readback",
        "a",
        `select slug, saved_at from public.user_saved_drills where user_id = '${a}' and slug = '${
          q(slug)
        }'`,
        { rows: 1 },
      );
      // B's row is untouched by everything A tried.
      const bRows = await tableRows(sql, b);
      if (bRows.length !== 1) {
        violations.push(`B's bookmarks changed: ${JSON.stringify(bRows)}`);
      }
      grants = (await sql.unsafe(
        `select privilege_type, column_name from information_schema.column_privileges
           where table_schema = 'public' and table_name = 'user_saved_drills' and grantee = 'authenticated'
           order by 1, 2`,
      )) as unknown as Array<{ privilege_type: string; column_name: string }>;
    } finally {
      await sql.end({ timeout: 5 });
    }
    const path = await writeArtifact("pg_sd3_tenant_isolation", {
      seed: STRESS_SEED,
      a,
      b,
      slug,
      cases,
      authenticatedColumnGrants: grants,
      edgeFnWritesOnThisTable: [
        "INSERT … ON CONFLICT DO NOTHING (PUT)",
        "DELETE (DELETE route)",
      ],
      violations,
    });
    console.log(
      `[stress] pg PG-SD3: cases=${cases.length} held=${
        cases.filter((c) => c.held).length
      } → ${path}`,
    );
    if (violations.length) {
      throw new Error(`PG-SD3 violations:\n${violations.join("\n")}`);
    }
  },
});

// ── PG-SD4: route regex vs DB check constraint agreement (seeded fuzz) ───────

Deno.test({
  name:
    `stress/saved-drill PUT pg: PG-SD4 ${SLUG_FUZZ} fuzzed slugs — DRILL_SLUG_RE and user_saved_drills_slug_bounds agree`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d4);
    const routeRe = await routeSlugRegex();
    const userId = prng.uuid();
    const alphabet = [
      ..."abcxyz019",
      ..."ABCXYZ",
      "_",
      "-",
      ".",
      " ",
      "/",
      "%",
      "\u212a", // KELVIN SIGN — lower-cases to 'k'
      "\u017f", // LATIN SMALL LETTER LONG S — upper-cases to 'S'
      "\u00e9",
      "\u{1F952}",
      "\n",
      "\u0000",
      "'",
      ";",
    ];
    const boundary = [
      "a",
      "A",
      "0",
      "a".repeat(120),
      "a".repeat(121),
      `a${"-".repeat(119)}`,
      `a${"-".repeat(120)}`,
      "-a",
      "_a",
      "a\n",
      "\na",
      "a b",
      "\u212a",
      "a\u212a",
      "\u017f",
      "a\u017f",
      "drop-table",
      "a'b",
    ];
    const slugs = [...boundary];
    while (slugs.length < SLUG_FUZZ) {
      const len = prng.int(1, prng.next() < 0.1 ? 125 : 24);
      let s = "";
      for (let i = 0; i < len; i++) {
        // Bias to the valid alphabet so long slugs are not trivially rejected.
        s += prng.next() < 0.85
          ? prng.pick([..."abcxyz019ABCXYZ_-"])
          : prng.pick(alphabet);
      }
      slugs.push(s);
    }
    const table: Array<Record<string, unknown>> = [];
    const disagreements: string[] = [];
    let routeAccepts = 0;
    let dbAccepts = 0;
    try {
      await createUser(sql, userId);
      for (const slug of slugs) {
        if (slug.includes("\u0000")) {
          // Postgres text cannot hold NUL at all (22021) — the route rejects it before the DB anyway.
          const route = routeRe.test(slug);
          table.push({
            slug: JSON.stringify(slug),
            route,
            db: false,
            dbCode: "22021-implied",
            agree: route === false,
          });
          if (route) {
            disagreements.push(
              `${JSON.stringify(slug)}: route accepts, DB cannot store NUL`,
            );
          }
          continue;
        }
        const route = routeRe.test(slug);
        let db = false;
        let dbCode: string | null = null;
        try {
          await sql.begin(async (tx) => {
            const t = tx as unknown as Tx;
            await asUser(t, userId);
            const paramInsert = await t.unsafe(
              `insert into public.user_saved_drills (user_id, slug) values ($1, $2) on conflict (user_id, slug) do nothing`,
              [userId, slug],
            );
            db = paramInsert.count === 1;
            throw new Error("__rollback__"); // keep the fixture user's table empty between probes
          });
        } catch (err) {
          const e = pgError(err);
          if (e.message !== "__rollback__") {
            dbCode = e.code ?? e.message;
            db = false;
          }
        }
        if (route) routeAccepts++;
        if (db) dbAccepts++;
        const agree = route === db;
        table.push({
          slug: JSON.stringify(slug),
          len: slug.length,
          route,
          db,
          dbCode,
          agree,
        });
        if (!agree) {
          disagreements.push(
            `${JSON.stringify(slug)}: route=${route} db=${db} (${dbCode})`,
          );
        }
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    const path = await writeArtifact("pg_sd4_slug_gate_agreement", {
      seed: STRESS_SEED,
      routeRegex: routeRe.toString(),
      dbConstraint:
        "user_saved_drills_slug_bounds: slug ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$'",
      slugs: slugs.length,
      routeAccepts,
      dbAccepts,
      dbCodes: histogram(table.map((r) => String(r.dbCode ?? "ok"))),
      disagreements,
      table,
    });
    console.log(
      `[stress] pg PG-SD4: slugs=${slugs.length} routeAccepts=${routeAccepts} dbAccepts=${dbAccepts} disagreements=${disagreements.length} → ${path}`,
    );
    if (disagreements.length) {
      throw new Error(`PG-SD4 disagreements:\n${disagreements.join("\n")}`);
    }
  },
});

// ── PG-SD5: lifecycle — FK to profiles, cascade on account deletion ──────────

Deno.test({
  name:
    "stress/saved-drill PUT pg: PG-SD5 bookmark needs a profile row (FK) and cascades away with the account",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d5);
    const userId = prng.uuid();
    const ghost = prng.uuid();
    const slugs = Array.from({ length: 5 }, () => prng.slug(20));
    const evidence: Record<string, unknown> = {
      seed: STRESS_SEED,
      userId,
      ghost,
      slugs,
    };
    const violations: string[] = [];
    try {
      await createUser(sql, userId);
      const profile = await sql.unsafe(
        `select 1 from public.profiles where id = '${userId}'`,
      );
      evidence.profileCreatedByTrigger = profile.length === 1;
      if (profile.length !== 1) {
        violations.push("handle_new_user() did not create the profile row");
      }

      for (const s of slugs) {
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, userId);
          await routeUpsert(t, userId, s);
        });
      }
      evidence.rowsAfterSaves = (await tableRows(sql, userId)).length;
      if (evidence.rowsAfterSaves !== slugs.length) {
        violations.push(
          `expected ${slugs.length} rows, table holds ${evidence.rowsAfterSaves}`,
        );
      }

      // A JWT whose sub has no profile row (deleted mid-session): the route's
      // upsert fails with a FK violation → serviceUnavailable("Drill save"), i.e.
      // 503, not a 200 with a phantom bookmark. Document the code.
      try {
        await sql.begin(async (tx) => {
          const t = tx as unknown as Tx;
          await asUser(t, ghost);
          await routeUpsert(t, ghost, slugs[0]);
        });
        evidence.ghostUpsert = "inserted";
        violations.push("upsert for a sub without a profile row succeeded");
      } catch (err) {
        evidence.ghostUpsert = pgError(err);
        if (pgError(err).code !== "23503") {
          violations.push(
            `ghost upsert failed with ${pgError(err).code}, expected 23503`,
          );
        }
      }

      await sql.unsafe(`delete from auth.users where id = '${userId}'`);
      evidence.rowsAfterAccountDelete = (await tableRows(sql, userId)).length;
      if (evidence.rowsAfterAccountDelete !== 0) {
        violations.push(
          `${evidence.rowsAfterAccountDelete} bookmarks survived account deletion`,
        );
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    evidence.violations = violations;
    const path = await writeArtifact("pg_sd5_lifecycle", evidence);
    console.log(
      `[stress] pg PG-SD5: rows=${evidence.rowsAfterSaves} afterDelete=${evidence.rowsAfterAccountDelete} ghost=${
        JSON.stringify(evidence.ghostUpsert)
      } → ${path}`,
    );
    if (violations.length) {
      throw new Error(`PG-SD5 violations:\n${violations.join("\n")}`);
    }
  },
});

// ── PG-SD6: sustained load — the route's two statements, many users ─────────

Deno.test({
  name: `stress/saved-drill PUT pg: PG-SD6 ${
    LANES * ROUNDS * 4
  } PUT-equivalents across ${LANES} users — DB-side p50/p95 per request`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = connect();
    const prng = new Prng(STRESS_SEED ^ 0x5d6);
    const users = Array.from({ length: LANES }, () => prng.uuid());
    const perRound = 4;
    const latencies: number[] = [];
    const errors: Array<Record<string, unknown>> = [];
    let executed = 0;
    let expectedRows = 0;
    let actualRows = 0;
    try {
      for (const u of users) await createUser(sql, u);
      const seen = new Set<string>();
      for (let round = 0; round < ROUNDS; round++) {
        for (let k = 0; k < perRound; k++) {
          // 30% of PUTs repeat a slug the user already saved (idempotent path).
          const slugs = users.map((u) => {
            const mine = [...seen].filter((s) => s.startsWith(`${u}|`));
            if (mine.length && prng.next() < 0.3) {
              return prng.pick(mine).split("|")[1];
            }
            return prng.slug(32);
          });
          const rows = await burst(
            sql,
            round * perRound + k,
            LANES,
            (lane) => users[lane],
            (lane) => slugs[lane],
          );
          for (const r of rows) {
            executed++;
            if (r.error) {
              errors.push({ round, k, lane: r.lane, error: r.error });
            } else {
              latencies.push(r.ms);
              seen.add(`${r.userId}|${r.slug}`);
              if (r.readBackRows !== 1) {
                errors.push({
                  round,
                  k,
                  lane: r.lane,
                  readBackRows: r.readBackRows,
                });
              }
            }
          }
        }
      }
      expectedRows = seen.size;
      actualRows = Number(
        (await sql.unsafe(
          `select count(*)::int as n from public.user_saved_drills where user_id = any($1::uuid[])`,
          [users],
        ))[0].n,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
    const summary = latencySummary(latencies);
    const path = await writeArtifact("pg_sd6_sustained", {
      seed: STRESS_SEED,
      users: LANES,
      executed,
      errors,
      expectedRows,
      actualRows,
      statementsPerRequest: 2,
      dbLatencyMs: summary,
    });
    console.log(
      `[stress] pg PG-SD6: n=${executed} p50=${summary.p50}ms p95=${summary.p95}ms rows=${actualRows}/${expectedRows} errors=${errors.length} → ${path}`,
    );
    assertEquals(errors, []);
    assertEquals(actualRows, expectedRows);
  },
});
