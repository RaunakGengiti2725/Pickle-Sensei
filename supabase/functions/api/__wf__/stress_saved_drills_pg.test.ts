// Stress lens `failure-load` for GET /v1/me/saved-drills — Postgres-backed leg.
//
// The route's ONE database call is a PostgREST table read
// (`user_saved_drills` select slug,saved_at / eq.user_id / order saved_at.desc),
// not an RPC. Here the stub PostgREST answers that exact query from a REAL
// postgres:16 with every migration applied, under the `authenticated` role and
// the bearer's JWT sub — i.e. through the same RLS the hosted PostgREST enforces
// — while Auth/Redis/RevenueCat stay stubbed and the real handler runs
// in-process.
//
//   ./xc_pg_up.sh                         # disposable postgres:16 + shim + migrations
//   STRESS_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_PG_USERS=200 deno test -A --no-check --config deno.json \
//     stress_saved_drills_pg.test.ts
//
// Without STRESS_PG_URL (aliases: XC_PG_URL, PICKLE_AUDIT_PG_URL) every test is
// `ignore`d — an ignored test is not a pass. Never points at a hosted project.

import { assert, assertEquals, assertRejects } from "@std/assert";
import postgres from "postgres";
import {
  assertHydrated,
  catalogSlugs,
  seedRows,
} from "./stress_saved_drills_cases.ts";
import {
  caseSeed,
  type DbQuery,
  envInt,
  histogram,
  latencySummary,
  loadStressHarness,
  Prng,
  replayCommand,
  run,
  type SavedDrillRow,
  savedDrillsRequest,
  sessionBearer,
  type StressHarness,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const FILE = "stress_saved_drills_pg.test.ts";
const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const PG_USERS = envInt("STRESS_PG_USERS", 40);

type Sql = ReturnType<typeof postgres>;

const hostedProject = /ucqnaiwqwjtgvlduiuib|supabase\.co|supabase\.com/i;
if (!ignore && hostedProject.test(PG_URL)) {
  throw new Error(
    "STRESS_PG_URL must be a disposable local Postgres, never the hosted project",
  );
}

interface PgUser {
  userId: string;
  ip: string;
  bearer: string;
  rows: SavedDrillRow[];
}

/** PostgREST's wire format for the route's query: json_agg of the ordered
 * rows with timestamptz rendered by Postgres in UTC (exactly what the
 * hosted PostgREST returns), under the authenticated role + JWT sub. */
function realPostgrestBackend(
  sql: Sql,
): (query: DbQuery) => Promise<SavedDrillRow[]> {
  return async (query) => {
    assertEquals(query.select, ["slug", "saved_at"]);
    assertEquals(query.order, "saved_at.desc");
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`set local timezone = 'UTC'`);
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
        query.bearerSub ?? "",
      ]);
      const out = await tx.unsafe(
        `select coalesce(json_agg(t), '[]'::json)::text as body
           from (select slug, saved_at from public.user_saved_drills
                  where user_id = $1 order by saved_at desc) t`,
        [query.userId],
      );
      return JSON.parse(String(out[0].body)) as SavedDrillRow[];
    });
    return rows;
  };
}

/** Postgres renders timestamptz JSON without trailing fractional zeros
 * (`…:30+00:00`, `…:30.003+00:00`); the seeded ISO strings carry `.000`. */
function pgRendered(row: SavedDrillRow): SavedDrillRow {
  return {
    ...row,
    saved_at: row.saved_at.replace(
      /\.(\d*?)0+\+/,
      (_m, keep: string) => (keep ? `.${keep}+` : "+"),
    ),
  };
}

async function createUsers(
  sql: Sql,
  state: StressHarness,
  prng: Prng,
  count: number,
): Promise<PgUser[]> {
  const slugs = await catalogSlugs();
  const users: PgUser[] = [];
  for (let i = 0; i < count; i++) {
    const userId = prng.uuid();
    const rows = seedRows(prng, slugs, prng.int(0, 12)).map(pgRendered);
    users.push({
      userId,
      rows,
      ip: prng.ip(),
      bearer: sessionBearer(state, userId),
    });
  }
  // handle_new_user() (on_auth_user_created) creates the profiles row, as on hosted.
  await sql.begin(async (tx) => {
    for (const u of users) {
      await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
        u.userId,
        `${u.userId}@stress.test`,
      ]);
    }
  });
  // Saves are written the way the client would: as the owner, through RLS.
  for (const u of users) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
        u.userId,
      ]);
      for (const row of u.rows) {
        await tx.unsafe(
          `insert into public.user_saved_drills (user_id, slug, saved_at) values ($1, $2, $3)`,
          [
            u.userId,
            row.slug,
            row.saved_at,
          ],
        );
      }
    });
  }
  return users;
}

async function dropUsers(sql: Sql, users: PgUser[]): Promise<void> {
  if (users.length === 0) return;
  // auth.users → profiles → user_saved_drills all cascade.
  await sql.unsafe(`delete from auth.users where id = any($1::uuid[])`, [
    users.map((u) => u.userId),
  ]);
}

Deno.test({
  name:
    `stress saved-drills pg: ${PG_USERS} users' saves round-trip through RLS + the real handler`,
  ignore,
  async fn() {
    const state = await loadStressHarness();
    const sql = postgres(PG_URL, { max: 4 });
    const seed = caseSeed("pg-roundtrip");
    const prng = new Prng(seed);
    let users: PgUser[] = [];
    try {
      state.dbBackend = realPostgrestBackend(sql);
      users = await createUsers(sql, state, prng, PG_USERS);
      const slugs = await catalogSlugs();

      const latencies: number[] = [];
      const shapes: string[] = [];
      let executed = 0;
      for (const u of users) {
        // Cold then warm: the second request must hit Postgres again (no
        // response cache on this route) but not Auth.
        for (const tag of ["pg-cold", "pg-warm"]) {
          const r = await run(
            state,
            savedDrillsRequest(u.bearer, { ip: u.ip }),
            tag,
          );
          executed += 1;
          assertEquals(r.status, 200, `${tag} ${u.userId}`);
          assertHydrated(r.body, u.rows, slugs);
          latencies.push(r.latencyMs);
          shapes.push(`${tag} auth=${r.roundTrips.auth} db=${r.roundTrips.db}`);
          state.calls.length = 0;
        }
      }

      const report = {
        seed,
        replay: `STRESS_PG_URL=<from ./xc_pg_up.sh> ${
          replayCommand(FILE, "round-trip through RLS", {
            STRESS_PG_USERS: PG_USERS,
          })
        }`,
        users: users.length,
        savedRows: users.reduce((n, u) => n + u.rows.length, 0),
        requestsExecuted: executed,
        latency: latencySummary(latencies),
        roundTripShapes: histogram(shapes),
      };
      const path = await writeJson("pg_roundtrip.json", report);
      console.log(
        `[stress] wrote ${path}: ${JSON.stringify(report.roundTripShapes)}`,
      );

      assertEquals(executed, users.length * 2);
      assertEquals(report.roundTripShapes, {
        "pg-cold auth=1 db=1": users.length,
        "pg-warm auth=0 db=1": users.length,
      });
    } finally {
      await dropUsers(sql, users);
      await sql.end();
      state.reset();
    }
  },
});

Deno.test({
  name:
    "stress saved-drills pg: RLS hides every other user's saves from a foreign bearer",
  ignore,
  async fn() {
    const state = await loadStressHarness();
    const sql = postgres(PG_URL, { max: 2 });
    const prng = new Prng(caseSeed("pg-rls"));
    let users: PgUser[] = [];
    try {
      const backend = realPostgrestBackend(sql);
      users = await createUsers(sql, state, prng, 6);
      const [victim, ...others] = users;
      assert(victim.rows.length > 0 || others.some((u) => u.rows.length > 0));
      const seen: Array<{ bearerSub: string | null; rows: number }> = [];
      for (
        const bearerSub of [
          ...others.map((u) => u.userId),
          null,
          "",
          "not-a-uuid",
        ]
      ) {
        // PostgREST evaluates the route's filter (eq.user_id=<victim>) under
        // the bearer's RLS identity: anyone but the victim must see nothing.
        const rows = await backend({
          bearerSub,
          bearer: "irrelevant",
          userId: victim.userId,
          select: ["slug", "saved_at"],
          order: "saved_at.desc",
        }).catch((error: unknown) => {
          // A non-uuid sub makes auth.uid() fail to cast: still zero rows.
          assert(
            error instanceof Error && /uuid/i.test(error.message),
            String(error),
          );
          return [] as SavedDrillRow[];
        });
        seen.push({ bearerSub, rows: rows.length });
        assertEquals(
          rows.length,
          0,
          `foreign bearer ${bearerSub} saw ${rows.length} rows`,
        );
      }
      const own = await backend({
        bearerSub: victim.userId,
        bearer: "irrelevant",
        userId: victim.userId,
        select: ["slug", "saved_at"],
        order: "saved_at.desc",
      });
      assertEquals(own.length, victim.rows.length);
      const path = await writeJson("pg_rls.json", {
        seed: prng.seed,
        replay: `STRESS_PG_URL=<from ./xc_pg_up.sh> ${
          replayCommand(FILE, "RLS hides")
        }`,
        victimRows: victim.rows.length,
        foreignBearers: seen,
      });
      console.log(`[stress] wrote ${path}`);
    } finally {
      await dropUsers(sql, users);
      await sql.end();
      state.reset();
    }
  },
});

Deno.test({
  name:
    "stress saved-drills pg: the table refuses duplicate saves and out-of-bounds slugs (route inputs D19/D20 are unreachable)",
  ignore,
  async fn() {
    const state = await loadStressHarness();
    const sql = postgres(PG_URL, { max: 2 });
    const prng = new Prng(caseSeed("pg-constraints"));
    let users: PgUser[] = [];
    const outcomes: Array<{ slug: string; outcome: string }> = [];
    try {
      users = await createUsers(sql, state, prng, 1);
      const [u] = users;
      const asOwner = async (slug: string) => {
        await sql.begin(async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          await tx.unsafe(
            `select set_config('request.jwt.claim.sub', $1, true)`,
            [u.userId],
          );
          await tx.unsafe(
            `insert into public.user_saved_drills (user_id, slug) values ($1, $2)`,
            [u.userId, slug],
          );
        });
      };
      const expectRefused = async (slug: string, sqlstate: string) => {
        const error = await assertRejects(() => asOwner(slug));
        const code = (error as { code?: string }).code ?? "";
        outcomes.push({
          slug: slug.length > 60
            ? `${slug.slice(0, 57)}…(${slug.length})`
            : slug,
          outcome: code,
        });
        assertEquals(
          code,
          sqlstate,
          `${slug} → ${code} (${(error as Error).message})`,
        );
      };
      await asOwner("stress-fresh-slug");
      outcomes.push({ slug: "stress-fresh-slug", outcome: "inserted" });
      await expectRefused("stress-fresh-slug", "23505"); // idempotent save: PK, no duplicate row
      await expectRefused("<script>alert(1)</script>", "23514"); // D20 markup slug
      await expectRefused("", "23514");
      await expectRefused("a".repeat(121), "23514"); // D19-style oversized slug
      await expectRefused("-leading-dash", "23514");
      await expectRefused("with space", "23514");
      // The bound admits exactly the catalog + orphan shapes the harness uses.
      await asOwner(prng.orphanSlug());
      outcomes.push({ slug: "orphan-*", outcome: "inserted" });
      await asOwner("a".repeat(120));
      outcomes.push({ slug: "a×120", outcome: "inserted" });

      const path = await writeJson("pg_constraints.json", {
        seed: prng.seed,
        replay: `STRESS_PG_URL=<from ./xc_pg_up.sh> ${
          replayCommand(FILE, "refuses duplicate")
        }`,
        outcomes,
      });
      console.log(`[stress] wrote ${path}`);
    } finally {
      await dropUsers(sql, users);
      await sql.end();
      state.reset();
    }
  },
});
