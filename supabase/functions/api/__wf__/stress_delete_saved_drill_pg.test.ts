// stress — DIRECT Postgres half for DELETE /v1/me/saved-drills/:slug.
//
// The route issues, through PostgREST with the caller's JWT,
//   DELETE FROM public.user_saved_drills WHERE user_id = <auth.uid()> AND slug = <slug>
// (index.ts unsaveDrill → .delete().eq("user_id", authed.id).eq("slug", slug)).
// This file drives that exact statement — and the adversarial variants the
// route can never send but RLS must still refuse — on a disposable
// postgres:16 with shim_auth.sql + every migration applied (./xc_pg_up.sh),
// as role `authenticated` with the caller's `request.jwt.claim.sub`, on N
// INDEPENDENT connections released from a barrier for the duplicate-delivery
// case.
//
//   ./xc_pg_up.sh                      # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     STRESS_OUT_DIR=/tmp/stress-out/ deno test -A --no-check --config deno.json stress_delete_saved_drill_pg.test.ts
//
// Without XC_PG_URL every test is `ignore`d — an ignored run is NOT a pass.
// Never points at a hosted project.

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  fnv1a,
  Prng,
  STRESS_ITER,
  STRESS_SEED,
  writeJson,
} from "./stress_saved_drills_harness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
const ignore = PG_URL === "";
const LANES = envInt("STRESS_PG_LANES", 16);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const seed = (STRESS_SEED ^ fnv1a("pg:saved-drills")) >>> 0;
const prng = new Prng(seed);

const uuidFrom = (p: Prng): string => p.uuid();

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
  // handle_new_user() (20260829000000) creates public.profiles; make sure.
  await sql.unsafe(
    `insert into public.profiles (id) values ('${userId}') on conflict (id) do nothing`,
  );
}

async function bookmarks(sql: Sql, userId: string): Promise<string[]> {
  const rows = await sql.unsafe(
    `select slug from public.user_saved_drills where user_id = '${userId}' order by slug`,
  );
  return rows.map((r) => String(r.slug));
}

async function seedBookmarks(sql: Sql, userId: string, slugs: string[]): Promise<void> {
  await sql.unsafe(`delete from public.user_saved_drills where user_id = '${userId}'`);
  for (const s of slugs) {
    await sql.unsafe(
      `insert into public.user_saved_drills (user_id, slug) values ('${userId}', '${s}')`,
    );
  }
}

/** The route's statement. Returns rows affected (PostgREST returns 204 regardless). */
async function routeDelete(tx: Tx, userId: string, slug: string): Promise<number> {
  const r = await tx.unsafe(
    `delete from public.user_saved_drills where user_id = $1 and slug = $2`,
    [userId, slug],
  );
  return r.count;
}

interface Row {
  scenario: string;
  seed: number;
  actor: string;
  statement: string;
  affected: number | string;
  before: Record<string, string[]>;
  after: Record<string, string[]>;
  verdict: "HELD" | "BROKEN";
  note?: string;
}
const rows: Row[] = [];

Deno.test({
  name: "stress pg: route DELETE is owner-scoped, idempotent, and RLS refuses every cross-user variant",
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4 });
    try {
      const A = uuidFrom(prng);
      const B = uuidFrom(prng);
      await createUser(sql, A);
      await createUser(sql, B);
      const shared = prng.slug();
      const onlyA = prng.slug();
      const onlyB = prng.slug();
      const snapshot = async () => ({ A: await bookmarks(sql, A), B: await bookmarks(sql, B) });

      const run = async (
        scenario: string,
        actor: string,
        statement: string,
        fn: (tx: Tx) => Promise<number>,
        expect: (affected: number | string, after: { A: string[]; B: string[] }) => void,
        note?: string,
      ) => {
        await seedBookmarks(sql, A, [shared, onlyA]);
        await seedBookmarks(sql, B, [shared, onlyB]);
        const before = await snapshot();
        let affected: number | string;
        try {
          affected = (await sql.begin(async (tx) => {
            if (actor !== "owner-role")
              await asUser(tx as unknown as Tx, actor === "anon" ? A : actor);
            if (actor === "anon") await tx.unsafe(`set local role anon`);
            return await fn(tx as unknown as Tx);
          })) as number;
        } catch (error) {
          affected = `error:${(error as { code?: string }).code ?? String(error)}`;
        }
        const after = await snapshot();
        const row: Row = {
          scenario,
          seed,
          actor,
          statement,
          affected,
          before,
          after,
          verdict: "HELD",
          note,
        };
        rows.push(row);
        try {
          expect(affected, after);
        } catch (e) {
          row.verdict = "BROKEN";
          throw e;
        }
      };

      await run(
        "owner_deletes_own_shared_slug",
        A,
        "route filter (user_id=self, slug)",
        (tx) => routeDelete(tx, A, shared),
        (n, after) => {
          assertEquals(n, 1);
          assertEquals(after.A, [onlyA].sort());
          assertEquals(after.B, [shared, onlyB].sort(), "B's identical slug untouched");
        },
      );
      await run(
        "owner_deletes_absent_slug_idempotent",
        A,
        "route filter, slug never saved",
        (tx) => routeDelete(tx, A, prng.slug()),
        (n, after) => {
          assertEquals(n, 0, "no error, nothing deleted");
          assertEquals(after.A, [onlyA, shared].sort());
        },
      );
      await run(
        "owner_repeats_delete_idempotent",
        A,
        "route filter twice in one tx",
        async (tx) => {
          const first = await routeDelete(tx, A, onlyA);
          const second = await routeDelete(tx, A, onlyA);
          assertEquals(first, 1);
          return second;
        },
        (n, after) => {
          assertEquals(n, 0);
          assertEquals(after.A, [shared]);
        },
      );
      await run(
        "forged_filter_other_users_id",
        A,
        "user_id=B, slug (route can never send this; RLS backstop)",
        (tx) => routeDelete(tx, B, shared),
        (n, after) => {
          assertEquals(n, 0, "RLS hides B's row from A");
          assertEquals(after.B, [shared, onlyB].sort());
        },
      );
      await run(
        "slug_only_filter_no_user_predicate",
        A,
        "slug = shared (no user_id predicate)",
        async (tx) => {
          const r = await tx.unsafe(`delete from public.user_saved_drills where slug = $1`, [
            shared,
          ]);
          return r.count;
        },
        (n, after) => {
          assertEquals(n, 1, "RLS limits an unscoped delete to the caller's own row");
          assertEquals(after.A, [onlyA]);
          assertEquals(after.B, [shared, onlyB].sort());
        },
      );
      await run(
        "unfiltered_delete_all",
        A,
        "delete from user_saved_drills (no predicate)",
        async (tx) => {
          const r = await tx.unsafe(`delete from public.user_saved_drills`);
          return r.count;
        },
        (n, after) => {
          assertEquals(n, 2, "only A's two rows are visible to A");
          assertEquals(after.A, []);
          assertEquals(after.B, [shared, onlyB].sort());
        },
      );
      await run(
        "anon_role_delete",
        "anon",
        "route filter as anon",
        (tx) => routeDelete(tx, A, shared),
        (n, after) => {
          assert(
            n === 0 || String(n).startsWith("error:42501"),
            `anon must delete nothing (got ${n})`,
          );
          assertEquals(after.A, [onlyA, shared].sort());
        },
      );
      await run(
        "no_jwt_sub_authenticated",
        "owner-role",
        "role authenticated with NO request.jwt.claim.sub",
        async (tx) => {
          await tx.unsafe(`set local role authenticated`);
          const r = await tx.unsafe(`delete from public.user_saved_drills where slug = $1`, [
            shared,
          ]);
          return r.count;
        },
        (n, after) => {
          assertEquals(n, 0, "auth.uid() is null → no row matches any policy");
          assertEquals(after.A, [onlyA, shared].sort());
          assertEquals(after.B, [shared, onlyB].sort());
        },
      );
      // Slugs the edge parser lets through unchanged (decodeURIComponent only):
      for (const [label, slug] of [
        ["unicode", "ドリル-練習"],
        ["sqlish", "x' or '1'='1"],
        ["postgrest_operator", "eq.abc"],
        ["long_121", "a".repeat(121)],
        ["uppercase", "Dink-Drill"],
        ["with_slash", "a/b"],
        ["empty_after_decode", ""],
      ] as const) {
        await run(
          `odd_slug_${label}`,
          A,
          `route filter, slug=${JSON.stringify(slug)}`,
          (tx) => routeDelete(tx, A, slug),
          (n, after) => {
            assertEquals(
              n,
              0,
              "no such bookmark → 0 rows, no error (constraint only governs INSERT)",
            );
            assertEquals(after.A, [onlyA, shared].sort());
            assertEquals(after.B, [shared, onlyB].sort());
          },
        );
      }
      // Execution plan: the PK (user_id, slug) must serve the route filter.
      const plan = await sql.begin(async (tx) => {
        await asUser(tx as unknown as Tx, A);
        const r = await tx.unsafe(
          `explain (format json) delete from public.user_saved_drills where user_id = $1 and slug = $2`,
          [A, shared],
        );
        return r[0]["QUERY PLAN"];
      });
      const planText = JSON.stringify(plan);
      rows.push({
        scenario: "explain_route_delete",
        seed,
        actor: A,
        statement: "explain (format json) route filter",
        affected: planText.includes("Index") ? "index-scan" : "seq-scan",
        before: {},
        after: {},
        verdict: planText.includes("Index") ? "HELD" : "BROKEN",
        note: planText.slice(0, 600),
      });
      assert(
        planText.includes("Index"),
        `route DELETE must use the (user_id, slug) primary key: ${planText}`,
      );
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: `stress pg: ${LANES} concurrent duplicate deliveries of one DELETE — exactly one row goes, no lane errors`,
  ignore,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const sql = postgres(PG_URL, { max: LANES + 2 });
    try {
      const rounds = Math.max(3, STRESS_ITER);
      const summary: Array<{
        round: number;
        affectedPerLane: number[];
        errors: string[];
        remaining: string[];
      }> = [];
      for (let round = 0; round < rounds; round++) {
        const U = uuidFrom(prng);
        await createUser(sql, U);
        const slug = prng.slug();
        const keep = prng.slug();
        await seedBookmarks(sql, U, [slug, keep]);
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        let ready = 0;
        const errors: string[] = [];
        const lanes = Promise.all(
          Array.from({ length: LANES }, () =>
            sql.begin(async (tx) => {
              await asUser(tx as unknown as Tx, U);
              ready += 1;
              await gate;
              try {
                return await routeDelete(tx as unknown as Tx, U, slug);
              } catch (e) {
                errors.push((e as { code?: string }).code ?? String(e));
                return -1;
              }
            }),
          ),
        );
        while (ready < LANES) await new Promise((r) => setTimeout(r, 5));
        open();
        const affected = (await lanes) as number[];
        const remaining = await bookmarks(sql, U);
        summary.push({ round, affectedPerLane: affected, errors, remaining });
        assertEquals(errors, [], `round ${round}: no lane may fail`);
        assertEquals(
          affected.reduce((a, b) => a + b, 0),
          1,
          `round ${round}: exactly one row deleted across ${LANES} lanes`,
        );
        assertEquals(remaining, [keep], `round ${round}: the sibling bookmark survives`);
      }
      rows.push({
        scenario: "concurrent_duplicate_delivery",
        seed,
        actor: "per-round user",
        statement: `${LANES} lanes × ${rounds} rounds, barrier-released route DELETE`,
        affected: summary.map((s) => s.affectedPerLane.reduce((a, b) => a + b, 0)).join(","),
        before: {},
        after: {},
        verdict: "HELD",
        note: JSON.stringify(summary),
      });
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "stress pg: write JSON table",
  ignore,
  async fn() {
    const path = await writeJson("pg_saved_drills", {
      unit: "route-delete-v1-me-saved-drills-slug",
      seed,
      lanes: LANES,
      rows: rows.length,
      held: rows.filter((r) => r.verdict === "HELD").length,
      broken: rows.filter((r) => r.verdict === "BROKEN").length,
      table: rows,
    });
    console.log(`[stress] pg: ${rows.length} rows → ${path}`);
  },
});
