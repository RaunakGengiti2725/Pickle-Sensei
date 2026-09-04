// Stress lens `concurrency` for GET /v1/progress — the REAL Postgres half.
//
// The route reads two security_invoker views (progress_daily, practice_days)
// through PostgREST with ORDER BY … DESC + OFFSET/LIMIT paging (index.ts
// ~2176-2193); it issues no RPC. This file drives exactly those queries on a
// disposable postgres:16 with shim_auth.sql + every migration applied
// (./xc_pg_up.sh), as role `authenticated` with the caller's JWT sub, from N
// INDEPENDENT connections while owner-role writers insert shots/captures
// concurrently — i.e. the database-side truth behind the in-process
// stress_progress_* campaigns.
//
//   ./xc_pg_up.sh                       # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_ITER=60 deno test -A --no-check --config deno.json stress_progress_pg.test.ts
//
// Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
// ignored run is NOT a pass. Seeded (STRESS_SEED); every iteration replayable.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  type CampaignReport,
  envInt,
  type IterationRow,
  Prng,
  writeCampaign,
} from "./stress_progress_harness.ts";
import { KNOWN_DEFECTS } from "./stress_progress_campaign.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const PAGE_ROWS = 1_000;
const FAMILIES = [
  "pg-paging-torn",
  "pg-concurrent-readers",
  "pg-utc-day-boundaries",
] as const;
type PgFamily = (typeof FAMILIES)[number];
const SHOT_TYPES = [
  "dink",
  "drive",
  "serve",
  "return",
  "third_shot_drop",
  "volley",
];
const VERSIONS = ["scoring-1", "scoring-2", "scoring-3"];

interface SeriesRow {
  day: string;
  shot_type: string;
  scoring_model_version: string;
  shot_count: number;
  avg_score: string;
  best_score: string;
}

const uuidFrom = (prng: Prng): string => {
  const hex = () => prng.int(0, 0xffff).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-8${
    hex().slice(1)
  }-${hex()}${hex()}${hex()}`;
};

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

async function dropUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
}

interface ShotSpec {
  capturedAt: string;
  shotType: string;
  version: string;
  score: number;
}

/** Owner-role insert (no JWT sub: the table-layer permit gate and RLS do not
 * apply, exactly like the service path) of scored shots. */
async function insertShots(
  sql: Sql,
  userId: string,
  shots: ShotSpec[],
): Promise<void> {
  if (shots.length === 0) return;
  const rows = shots.map((s) => [
    crypto.randomUUID(),
    userId,
    s.shotType,
    s.capturedAt,
    0,
    200,
    s.score,
    0.9,
    "scored",
    "1.0.0",
    "bundle-1",
    "pose-1",
    "paddle-1",
    "stroke-1",
    "phase-1",
    s.version,
    "config-1",
  ]);
  await sql`insert into public.shots ${
    sql(
      rows.map((r) => ({
        id: r[0],
        user_id: r[1],
        shot_type: r[2],
        captured_at: r[3],
        start_ms: r[4],
        end_ms: r[5],
        overall_score: r[6],
        analysis_confidence: r[7],
        result_kind: r[8],
        app_version: r[9],
        model_bundle_version: r[10],
        pose_model_version: r[11],
        paddle_model_version: r[12],
        stroke_detector_version: r[13],
        phase_model_version: r[14],
        scoring_model_version: r[15],
        shot_config_version: r[16],
      })),
    )
  }`;
}

async function insertCaptures(
  sql: Sql,
  userId: string,
  captures: Array<{ capturedAt: string; mode: string; status: string }>,
): Promise<void> {
  if (captures.length === 0) return;
  await sql`insert into public.captures ${
    sql(
      captures.map((c) => ({
        id: crypto.randomUUID(),
        user_id: userId,
        captured_at: c.capturedAt,
        duration_ms: 1_000,
        fps: 30,
        capture_mode: c.mode,
        evidence_status: c.status,
      })),
    )
  }`;
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

/** The exact SQL PostgREST emits for the route's progress_daily read
 * (select + eq + three ORDER BY DESC + range → LIMIT/OFFSET). */
async function readSeriesPage(
  tx: Tx,
  userId: string,
  offset: number,
): Promise<SeriesRow[]> {
  const rows = await tx.unsafe(
    `select day::text as day, shot_type, scoring_model_version, shot_count, avg_score::text as avg_score, best_score::text as best_score
       from public.progress_daily where user_id = '${userId}'
      order by day desc, shot_type desc, scoring_model_version desc
      limit ${PAGE_ROWS} offset ${offset}`,
  );
  return rows as unknown as SeriesRow[];
}

async function readDaysPage(
  tx: Tx,
  userId: string,
  offset: number,
): Promise<string[]> {
  const rows = await tx.unsafe(
    `select day::text as day from public.practice_days where user_id = '${userId}'
      order by day desc limit ${PAGE_ROWS} offset ${offset}`,
  );
  return (rows as unknown as Array<{ day: string }>).map((r) => r.day);
}

/** index.ts readAllRows: keep paging while a page is full. Each page is its
 * own statement (PostgREST issues one HTTP request per page), run here in
 * ONE transaction per page so pages can interleave with writers exactly like
 * the route's separate requests do. */
async function readAll<T>(
  sql: Sql,
  userId: string,
  page: (tx: Tx, offset: number) => Promise<T[]>,
  between?: (pageIndex: number) => Promise<void>,
): Promise<{ rows: T[]; pages: number }> {
  const rows: T[] = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    let got: T[] = [];
    await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, userId);
      got = await page(tx as unknown as Tx, offset);
    });
    pages += 1;
    rows.push(...got);
    if (got.length < PAGE_ROWS) break;
    offset += PAGE_ROWS;
    if (between) await between(pages);
  }
  return { rows, pages };
}

const seriesKey = (r: SeriesRow) =>
  `${r.day}|${r.shot_type}|${r.scoring_model_version}`;

function inv(
  row: IterationRow,
  name: string,
  holds: boolean,
  detail: string,
): void {
  row.invariants.push({ name, holds, detail });
}

function newRow(seed: number, family: PgFamily, replay: string): IterationRow {
  return {
    seed,
    family,
    outcome: "HELD",
    scale: {},
    statusHistogram: {},
    invariants: [],
    observations: {},
    durationMs: 0,
    replay,
  };
}

const isoDaysAgo = (days: number, hour: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(hour, 0, 0, 0);
  return d.toISOString();
};

// ── pg-paging-torn ───────────────────────────────────────────────────────────
// > 1000 groups, then a shot for TODAY (a brand-new first group under DESC
// ordering) is committed between page 1 and page 2 of the same build. With
// OFFSET paging the second page re-serves page 1's last row: the stitched
// body has a duplicate group — the database-side cause of
// PROGRESS-PAGING-TORN-BODY. The control read (no write between pages) must
// match a single-statement full read exactly.
async function pgPagingTorn(
  sql: Sql,
  prng: Prng,
  row: IterationRow,
): Promise<void> {
  const userId = uuidFrom(prng);
  await createUser(sql, userId);
  try {
    const groups = prng.int(PAGE_ROWS + 1, PAGE_ROWS + 300);
    row.scale.seriesRows = groups;
    const specs: ShotSpec[] = [];
    let daysAgo = 1;
    while (specs.length < groups) {
      const perDay = prng.int(1, 3);
      const used = new Set<string>();
      for (let k = 0; k < perDay && specs.length < groups; k += 1) {
        const shotType = SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)];
        const version = VERSIONS[prng.int(0, VERSIONS.length - 1)];
        if (used.has(`${shotType}|${version}`)) continue;
        used.add(`${shotType}|${version}`);
        specs.push({
          capturedAt: isoDaysAgo(daysAgo, prng.int(1, 22)),
          shotType,
          version,
          score: prng.int(40, 95) / 10,
        });
      }
      daysAgo += 1;
    }
    for (let i = 0; i < specs.length; i += 500) {
      await insertShots(sql, userId, specs.slice(i, i + 500));
    }

    const control = await readAll(
      sql,
      userId,
      (tx, off) => readSeriesPage(tx, userId, off),
    );
    const fullPre = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, userId);
      const r = await (tx as unknown as Tx).unsafe(
        `select day::text as day, shot_type, scoring_model_version, shot_count, avg_score::text as avg_score, best_score::text as best_score
           from public.progress_daily where user_id = '${userId}'
          order by day desc, shot_type desc, scoring_model_version desc`,
      );
      return r as unknown as SeriesRow[];
    });
    inv(
      row,
      "control-pages-equal-full-read",
      control.pages >= 2 &&
        control.rows.length === fullPre.length &&
        control.rows.every((r, i) => seriesKey(r) === seriesKey(fullPre[i])),
      `${control.pages} pages, ${control.rows.length} rows vs ${fullPre.length} in one statement`,
    );
    inv(
      row,
      "group-key-is-a-total-order",
      new Set(fullPre.map(seriesKey)).size === fullPre.length,
      `${fullPre.length} distinct (day, shot_type, version) groups`,
    );

    let wroteBetween = false;
    const todayType = SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)];
    const torn = await readAll(
      sql,
      userId,
      (tx, off) => readSeriesPage(tx, userId, off),
      async (pageIndex) => {
        if (pageIndex !== 1) return;
        await insertShots(sql, userId, [{
          capturedAt: isoDaysAgo(0, 12),
          shotType: todayType,
          version: VERSIONS[0],
          score: 8.8,
        }]);
        wroteBetween = true;
      },
    );
    inv(
      row,
      "sync-committed-between-pages",
      wroteBetween,
      `today's ${todayType} row committed after page 1`,
    );
    const keys = torn.rows.map(seriesKey);
    const distinct = new Set(keys);
    const dupes = keys.length - distinct.size;
    const preKeys = new Set(fullPre.map(seriesKey));
    const matchesPre = keys.length === fullPre.length && keys.every((k) =>
      preKeys.has(k)
    ) && dupes === 0;
    const matchesFresh = keys.length === fullPre.length + 1 && dupes === 0 &&
      keys.some((k) =>
        k.startsWith(`${isoDaysAgo(0, 12).slice(0, 10)}|${todayType}|`)
      );
    row.observations.stitchedRows = keys.length;
    row.observations.duplicatedGroups = dupes;
    row.observations.groupsBefore = fullPre.length;
    // The body a real caller would get for this build must be ONE snapshot.
    inv(
      row,
      "stitched-body-is-a-snapshot",
      matchesPre || matchesFresh,
      `stitched ${keys.length} rows (${dupes} duplicated) for ${fullPre.length} pre-write groups; matches pre=${matchesPre} fresh=${matchesFresh}`,
    );
    if (!(matchesPre || matchesFresh)) {
      row.observations.knownDefect = KNOWN_DEFECTS.pagingTorn;
    }
    // …and once the write has landed, a fresh build is exactly the fresh snapshot.
    const after = await readAll(
      sql,
      userId,
      (tx, off) => readSeriesPage(tx, userId, off),
    );
    const afterKeys = after.rows.map(seriesKey);
    inv(
      row,
      "next-build-is-fresh-snapshot",
      afterKeys.length === fullPre.length + 1 &&
        new Set(afterKeys).size === afterKeys.length,
      `${afterKeys.length} rows, ${
        afterKeys.length - new Set(afterKeys).size
      } duplicated`,
    );
  } finally {
    await dropUser(sql, userId);
  }
}

// ── pg-concurrent-readers ────────────────────────────────────────────────────
// K users; R reader lanes (independent connections, role authenticated, own
// sub) read both views while W owner lanes insert shots + captures for a
// random user. Every reader body must be that user's own rows only (RLS +
// eq filter), a consistent snapshot (sum of shot_count is between the user's
// pre- and post-burst totals, group keys unique, practice days distinct), and
// the whole burst completes in bounded time (no deadlock).
async function pgConcurrentReaders(
  sql: Sql,
  prng: Prng,
  row: IterationRow,
): Promise<void> {
  const users = Array.from({ length: prng.int(2, 4) }, () => uuidFrom(prng));
  for (const u of users) await createUser(sql, u);
  try {
    const todayIso = isoDaysAgo(0, 10);
    const pre: Record<string, number> = {};
    for (const u of users) {
      const n = prng.int(0, 12);
      pre[u] = n;
      await insertShots(
        sql,
        u,
        Array.from({ length: n }, () => ({
          capturedAt: isoDaysAgo(prng.int(0, 6), prng.int(0, 23)),
          shotType: SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)],
          version: VERSIONS[prng.int(0, VERSIONS.length - 1)],
          score: prng.int(40, 95) / 10,
        })),
      );
      await insertCaptures(
        sql,
        u,
        Array.from({ length: prng.int(0, 4) }, () => ({
          capturedAt: isoDaysAgo(prng.int(0, 6), prng.int(0, 23)),
          mode: "automatic_pose_trigger",
          status: "valid",
        })),
      );
    }
    const readers = prng.int(6, 16);
    const writers = prng.int(1, 4);
    row.scale.users = users.length;
    row.scale.readers = readers;
    row.scale.writers = writers;
    const writes: Record<string, number> = {};
    const t0 = performance.now();
    const results: Array<
      { user: string; series: SeriesRow[]; days: string[]; leaked: number }
    > = [];
    let violations = 0;
    await Promise.all([
      ...Array.from({ length: readers }, async (_, i) => {
        await new Promise((r) => setTimeout(r, prng.int(0, 20)));
        const user = users[i % users.length];
        const [series, days, leak] = await sql.begin(async (tx) => {
          await asUser(tx as unknown as Tx, user);
          // The route's two reads run under Promise.all — one snapshot each.
          const s = await readSeriesPage(tx as unknown as Tx, user, 0);
          const d = await readDaysPage(tx as unknown as Tx, user, 0);
          // Without the eq filter RLS alone must still hide other users.
          const all = await (tx as unknown as Tx).unsafe(
            `select count(*)::int as n from public.progress_daily where user_id <> '${user}'`,
          );
          return [
            s,
            d,
            Number((all as unknown as Array<{ n: number }>)[0].n),
          ] as const;
        });
        results.push({ user, series, days, leaked: leak });
      }),
      ...Array.from({ length: writers }, async () => {
        await new Promise((r) => setTimeout(r, prng.int(0, 20)));
        const user = users[prng.int(0, users.length - 1)];
        const n = prng.int(1, 3);
        try {
          await insertShots(
            sql,
            user,
            Array.from({ length: n }, () => ({
              capturedAt: todayIso,
              shotType: SHOT_TYPES[prng.int(0, SHOT_TYPES.length - 1)],
              version: VERSIONS[prng.int(0, VERSIONS.length - 1)],
              score: prng.int(40, 95) / 10,
            })),
          );
          await insertCaptures(sql, user, [{
            capturedAt: todayIso,
            mode: "automatic_pose_trigger",
            status: "valid",
          }]);
          writes[user] = (writes[user] ?? 0) + n;
        } catch {
          violations += 1;
        }
      }),
    ]);
    const wall = performance.now() - t0;
    row.observations.wallMs = Math.round(wall);
    inv(
      row,
      "no-deadlock-bounded-wall",
      wall < 5_000,
      `${Math.round(wall)}ms for ${readers} readers + ${writers} writers`,
    );
    inv(
      row,
      "writers-succeeded",
      violations === 0,
      `${violations} writer errors`,
    );
    inv(
      row,
      "rls-hides-other-users",
      results.every((r) => r.leaked === 0),
      `max leaked rows ${Math.max(...results.map((r) => r.leaked))}`,
    );
    inv(
      row,
      "reader-snapshot-within-pre-post",
      results.every((r) => {
        const sum = r.series.reduce((n, s) => n + Number(s.shot_count), 0);
        return sum >= pre[r.user] && sum <= pre[r.user] + (writes[r.user] ?? 0);
      }),
      `${results.length} reader bodies bracketed by their user's pre/post shot totals`,
    );
    inv(
      row,
      "group-keys-unique-per-body",
      results.every((r) =>
        new Set(r.series.map(seriesKey)).size === r.series.length
      ),
      "no duplicate (day, shot_type, version) group in any body",
    );
    inv(
      row,
      "practice-days-distinct-and-desc",
      results.every((r) =>
        new Set(r.days).size === r.days.length &&
        r.days.every((d, i) => i === 0 || d < r.days[i - 1])
      ),
      "practice_days rows distinct, strictly descending",
    );
    // Final read-your-writes: after every writer committed, one more read per
    // user is exactly the owner-side totals.
    for (const u of users) {
      const total = await sql.unsafe(
        `select coalesce(sum(1), 0)::int as n from public.shots where user_id = '${u}' and result_kind = 'scored'`,
      );
      const body = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, u);
        return readSeriesPage(tx as unknown as Tx, u, 0);
      });
      const sum = body.reduce((n, s) => n + Number(s.shot_count), 0);
      inv(
        row,
        `final-read-your-writes:${u.slice(0, 8)}`,
        sum === Number((total as unknown as Array<{ n: number }>)[0].n),
        `view total ${sum} vs table ${
          (total as unknown as Array<{ n: number }>)[0].n
        }`,
      );
    }
  } finally {
    for (const u of users) await dropUser(sql, u);
  }
}

// ── pg-utc-day-boundaries ────────────────────────────────────────────────────
// The handler's streak treats practice_days.day as a UTC calendar day and
// compares it with its own UTC "today". Pin the view: captures at
// 23:59:59.999Z and 00:00:00.000Z land on different days, an offset-notated
// timestamp resolves to its UTC day, duplicates collapse, and only
// valid + automatic captures count.
async function pgUtcDayBoundaries(
  sql: Sql,
  prng: Prng,
  row: IterationRow,
): Promise<void> {
  const userId = uuidFrom(prng);
  await createUser(sql, userId);
  try {
    const base = new Date();
    base.setUTCDate(base.getUTCDate() - prng.int(2, 40));
    const day = base.toISOString().slice(0, 10);
    const prev = new Date(base);
    prev.setUTCDate(prev.getUTCDate() - 1);
    const prevDay = prev.toISOString().slice(0, 10);
    const next = new Date(base);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextDay = next.toISOString().slice(0, 10);
    await insertCaptures(sql, userId, [
      {
        capturedAt: `${day}T23:59:59.999Z`,
        mode: "automatic_pose_trigger",
        status: "valid",
      },
      {
        capturedAt: `${nextDay}T00:00:00.000Z`,
        mode: "automatic_pose_trigger",
        status: "valid",
      },
      {
        capturedAt: `${day}T12:00:00.000Z`,
        mode: "automatic_pose_trigger",
        status: "valid",
      },
      // 01:30 on `day` in UTC+5 is 20:30 on prevDay in UTC.
      {
        capturedAt: `${day}T01:30:00+05:00`,
        mode: "automatic_pose_trigger",
        status: "valid",
      },
      {
        capturedAt: `${day}T08:00:00.000Z`,
        mode: "imported_video",
        status: "valid",
      },
      {
        capturedAt: `${day}T09:00:00.000Z`,
        mode: "automatic_pose_trigger",
        status: "corrupt",
      },
    ]);
    const days = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, userId);
      return readDaysPage(tx as unknown as Tx, userId, 0);
    });
    row.observations.days = days;
    inv(
      row,
      "utc-day-boundaries-and-distinct",
      JSON.stringify(days) === JSON.stringify([nextDay, day, prevDay]),
      `got ${JSON.stringify(days)} expected ${
        JSON.stringify([nextDay, day, prevDay])
      }`,
    );
    const nonCounting = await sql.begin(async (tx) => {
      await asUser(tx as unknown as Tx, userId);
      const r = await (tx as unknown as Tx).unsafe(
        `select count(*)::int as n from public.captures where user_id = '${userId}'`,
      );
      return Number((r as unknown as Array<{ n: number }>)[0].n);
    });
    inv(
      row,
      "only-valid-automatic-captures-count",
      nonCounting === 6 && days.length === 3,
      `6 captures → 3 practice days`,
    );
  } finally {
    await dropUser(sql, userId);
  }
}

// ── Campaign ─────────────────────────────────────────────────────────────────

Deno.test({
  name:
    "stress(pg): GET /v1/progress view reads on postgres:16 with every migration — concurrent readers/writers, paging, UTC days",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 24, onnotice: () => {} });
    const iterations = envInt("STRESS_PG_ITER", 12);
    const seedBase = envInt("STRESS_SEED", 20260904);
    const only = Deno.env.get("STRESS_FAMILY") ?? "";
    const rows: IterationRow[] = [];
    const familyCounts: Record<string, number> = {};
    const t0 = performance.now();
    try {
      for (let i = 0; i < iterations; i += 1) {
        const family = (only || FAMILIES[i % FAMILIES.length]) as PgFamily;
        if (!(FAMILIES as readonly string[]).includes(family)) {
          throw new Error(
            `STRESS_FAMILY must be one of ${FAMILIES.join(", ")}`,
          );
        }
        const seed = seedBase + i;
        const replay =
          `XC_PG_URL=<from ./xc_pg_up.sh> STRESS_SEED=${seed} STRESS_PG_ITER=1 STRESS_FAMILY=${family} deno test -A --no-check --config deno.json stress_progress_pg.test.ts`;
        const row = newRow(seed, family, replay);
        const prng = new Prng((seed ^ family.length * 0x9e3779b1) >>> 0);
        const tIter = performance.now();
        try {
          if (family === "pg-paging-torn") await pgPagingTorn(sql, prng, row);
          else if (family === "pg-concurrent-readers") {
            await pgConcurrentReaders(sql, prng, row);
          } else await pgUtcDayBoundaries(sql, prng, row);
        } catch (error) {
          inv(
            row,
            "no-exception",
            false,
            String(
              error instanceof Error ? error.stack ?? error.message : error,
            ),
          );
        }
        row.durationMs = Math.round((performance.now() - tIter) * 100) / 100;
        const broken = row.invariants.filter((x) => !x.holds);
        row.outcome = broken.length ? "BROKEN" : "HELD";
        if (
          broken.length && row.observations.knownDefect &&
          broken.every((x) => x.name === "stitched-body-is-a-snapshot")
        ) {
          row.knownDefect = String(row.observations.knownDefect);
        }
        rows.push(row);
        familyCounts[family] = (familyCounts[family] ?? 0) + 1;
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
    const failing = rows.filter((r) => r.outcome === "BROKEN").map((r) => ({
      seed: r.seed,
      family: r.family,
      invariants: r.invariants.filter((i) => !i.holds).map((i) =>
        `${i.name}: ${i.detail}`
      ),
      ...(r.knownDefect ? { knownDefect: r.knownDefect } : {}),
    }));
    const knownDefectSeeds: Record<string, number[]> = {};
    for (const r of rows) {
      if (r.knownDefect) {
        (knownDefectSeeds[r.knownDefect] ??= []).push(r.seed);
      }
    }
    const report: CampaignReport = {
      suite: "progress-concurrency-pg",
      redis: false,
      redisFaultRate: 0,
      seedBase,
      iterations,
      latencyMs: 0,
      startedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - t0),
      scenariosExecuted: rows.length,
      requestsExecuted: rows.reduce((n, r) => n + (r.scale.readers ?? 0), 0),
      held: rows.length - failing.length,
      broken: failing.length,
      brokenKnown: failing.filter((f) => f.knownDefect).length,
      brokenUnknown: failing.filter((f) => !f.knownDefect).length,
      knownDefectSeeds,
      failingSeeds: failing,
      familyCounts,
      rows,
    };
    const path = await writeCampaign(report.suite, report);
    console.log(
      `[${report.suite}] ${report.held} HELD / ${report.broken} BROKEN (${report.brokenKnown} known-defect, ${report.brokenUnknown} unexplained) over ${report.scenariosExecuted} iterations (${report.durationMs}ms) → ${path}`,
    );
    assert(report.scenariosExecuted > 0, "no iterations ran");
    const unexplained = report.failingSeeds.filter((f) => !f.knownDefect);
    assertEquals(
      unexplained.length,
      0,
      `${unexplained.length} BROKEN iteration(s) not explained by a known defect: ${
        JSON.stringify(unexplained.slice(0, 5), null, 1)
      }`,
    );
    // The paging tear is a property of ORDER BY DESC + OFFSET on a live view:
    // it must reproduce on real Postgres whenever a write lands between pages.
    const torn = rows.filter((r) => r.family === "pg-paging-torn");
    if (torn.length) {
      assert(
        torn.every((r) => r.knownDefect === KNOWN_DEFECTS.pagingTorn),
        `expected every pg-paging-torn iteration to reproduce ${KNOWN_DEFECTS.pagingTorn}; got ${
          JSON.stringify(torn.map((r) => [r.seed, r.outcome, r.knownDefect]))
        }`,
      );
    }
  },
});
