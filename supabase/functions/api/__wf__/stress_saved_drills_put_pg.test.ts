/**
 * STRESS (fuzz-boundary, Postgres half) — PUT /v1/me/saved-drills/:slug.
 *
 * The edge route does not call an RPC; it issues two PostgREST statements as
 * the authenticated user:
 *
 *   INSERT INTO public.user_saved_drills (user_id, slug) VALUES ($me, $slug)
 *     ON CONFLICT (user_id, slug) DO NOTHING            -- upsert, ignoreDuplicates
 *   SELECT slug, saved_at FROM public.user_saved_drills
 *     WHERE user_id = $me AND slug = $slug              -- .maybeSingle()
 *
 * This file replays the SAME seeded slug corpus as
 * stress_saved_drills_put_fuzz.test.ts (shared generator in
 * stress_saved_drills_gen.ts) against a disposable postgres:16 with
 * shim_auth.sql + every migration applied, issuing exactly those statements
 * under `set local role authenticated` + `request.jwt.claim.sub`, and checks
 * the database layer agrees with the edge validator:
 *
 *   P1 edge-valid slug  ⇒ insert succeeds, exactly one row, saved_at set
 *   P2 edge-invalid slug ⇒ the CHECK constraint user_saved_drills_slug_bounds
 *      (20260831160000_defense_in_depth.sql) refuses it too (23514) — or the
 *      text is unstorable (NUL → 22021); never a silent accept
 *      (any accepted edge-invalid slug is recorded as a defense-in-depth gap)
 *   P3 re-PUT is idempotent: second insert DO NOTHING, still one row,
 *      saved_at unchanged
 *   P4 RLS: inserting a row for ANOTHER user_id as the authed user → 42501;
 *      the other user never sees the row; a delete as the other user affects
 *      0 rows and the owner's row survives
 *   P5 anon has no path at all (42501 on select/insert)
 *
 * Every iteration is derived from iterSeedOf(STRESS_SEED, i) and is written
 * to <STRESS_OUT_DIR>/pg_results.json; the file is `ignore`d without
 * XC_PG_URL (`./xc_pg_up.sh` prints one), so `deno task test` stays
 * self-contained.
 *
 *   ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres STRESS_ITER=3000 \
 *     deno test -A --no-check --config deno.json stress_saved_drills_put_pg.test.ts
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import {
  DRILL_SLUG_RE,
  genSlug,
  iterSeedOf,
  Prng,
  type SlugKind,
} from "./stress_saved_drills_gen.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

const envInt = (name: string, fallback: number): number => {
  const raw = Deno.env.get(name);
  const n = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};
const STRESS_SEED = envInt("STRESS_SEED", 20260905);
const STRESS_ITER = envInt("STRESS_ITER", 120);
const OUT_DIR = Deno.env.get("STRESS_OUT_DIR") ??
  new URL(
    "../../../../artifacts/stress/saved-drills-put-fuzz/latest/",
    import.meta.url,
  ).pathname;

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** What the edge handler hands PostgREST: the DECODED path segment, or
 * nothing when decodeURIComponent throws (the route answers 400 first). */
function decodedSlug(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

interface PgRow {
  i: number;
  iterSeed: number;
  slugKind: SlugKind;
  slugRaw: string;
  /** decoded slug the edge would pass on (null = malformed percent, edge 400) */
  slug: string | null;
  edgeValid: boolean;
  user: string;
  insert: "ok" | string; // sqlstate on failure
  rowsAfterInsert: number;
  savedAt: string | null;
  reinsert: "ok" | "skipped" | string;
  rowsAfterReinsert: number;
  savedAtStable: boolean;
  crossInsert: "skipped" | "ok" | string; // 42501 expected
  otherSees: number | null;
  otherDeleteCount: number | null;
  ownerRowSurvives: boolean | null;
  violations: string[];
}

async function asUser(tx: Tx, userId: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`set local request.jwt.claim.sub = '${userId}'`);
}

async function asAnon(tx: Tx): Promise<void> {
  await tx.unsafe(`set local role anon`);
  await tx.unsafe(`set local request.jwt.claim.sub = ''`);
}

const sqlstate = (e: unknown): string =>
  e instanceof Error && "code" in e && typeof e.code === "string"
    ? e.code
    : e instanceof Error
    ? `err:${e.message.slice(0, 80)}`
    : String(e);

async function createUser(sql: Sql, userId: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = '${userId}'`);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data)
       values ('${userId}', '${userId}@example.com', '{"provider":"google"}')`,
  );
}

/** The two statements saveDrill() issues via PostgREST, as the user. */
async function edgePut(
  sql: Sql,
  userId: string,
  slug: string,
): Promise<{ insert: string; rows: { slug: string; saved_at: string }[] }> {
  let insert = "ok";
  try {
    await sql.begin(async (tx) => {
      await asUser(tx, userId);
      await tx`insert into public.user_saved_drills (user_id, slug)
                 values (${userId}::uuid, ${slug})
                 on conflict (user_id, slug) do nothing`;
    });
  } catch (e) {
    insert = sqlstate(e);
  }
  let rows: { slug: string; saved_at: string }[] = [];
  try {
    rows = await sql.begin(async (tx) => {
      await asUser(tx, userId);
      return await tx<{ slug: string; saved_at: string }[]>`
        select slug, saved_at::text as saved_at from public.user_saved_drills
         where user_id = ${userId}::uuid and slug = ${slug}`;
    });
  } catch (e) {
    // an unstorable text (NUL) fails the read-back the same way it failed the
    // insert; keep the insert's verdict and report no rows
    if (insert === "ok") insert = `select:${sqlstate(e)}`;
  }
  return { insert, rows };
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await Deno.mkdir(OUT_DIR, { recursive: true });
  await Deno.writeTextFile(
    `${OUT_DIR.replace(/\/$/, "")}/${name}`,
    JSON.stringify(value, null, 1),
  );
}

Deno.test({
  name:
    `stress pg: saved-drill slug corpus × STRESS_ITER against postgres:16 + migrations (seed ${STRESS_SEED})`,
  ignore,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const sql = postgres(PG_URL, { max: 4, onnotice: () => {} });
    const rows: PgRow[] = [];
    const violations: PgRow[] = [];
    const gaps: PgRow[] = [];
    try {
      const setup = new Prng(STRESS_SEED ^ 0x5eed);
      const users = Array.from({ length: 6 }, () => setup.uuid());
      const other = setup.uuid();
      for (const u of [...users, other]) await createUser(sql, u);

      for (let i = 0; i < STRESS_ITER; i += 1) {
        const iterSeed = iterSeedOf(STRESS_SEED, i);
        const rng = new Prng(iterSeed);
        const gen = genSlug(rng);
        const user = rng.pick(users);
        const slug = decodedSlug(gen.raw);
        const edgeValid = slug !== null && DRILL_SLUG_RE.test(slug);
        const row: PgRow = {
          i,
          iterSeed,
          slugKind: gen.kind,
          slugRaw: gen.raw.length > 200
            ? `${gen.raw.slice(0, 200)}…(+${gen.raw.length - 200})`
            : gen.raw,
          slug: slug === null
            ? null
            : slug.length > 200
            ? `${slug.slice(0, 200)}…(+${slug.length - 200})`
            : slug,
          edgeValid,
          user,
          insert: "skipped",
          rowsAfterInsert: 0,
          savedAt: null,
          reinsert: "skipped",
          rowsAfterReinsert: 0,
          savedAtStable: true,
          crossInsert: "skipped",
          otherSees: null,
          otherDeleteCount: null,
          ownerRowSurvives: null,
          violations: [],
        };
        if (slug === null) {
          // decodeURIComponent threw: the route returns 400 before PostgREST.
          rows.push(row);
          continue;
        }

        const first = await edgePut(sql, user, slug);
        row.insert = first.insert;
        row.rowsAfterInsert = first.rows.length;
        row.savedAt = first.rows[0]?.saved_at ?? null;

        if (edgeValid) {
          // P1
          if (first.insert !== "ok") {
            row.violations.push(
              `P1 edge-valid slug refused by Postgres: ${first.insert}`,
            );
          }
          if (first.rows.length !== 1) {
            row.violations.push(
              `P1 expected exactly one row after insert, saw ${first.rows.length}`,
            );
          }
          if (first.rows.length === 1 && first.rows[0].slug !== slug) {
            row.violations.push("P1 stored slug differs from the decoded slug");
          }
          // P3
          const second = await edgePut(sql, user, slug);
          row.reinsert = second.insert;
          row.rowsAfterReinsert = second.rows.length;
          row.savedAtStable = second.rows[0]?.saved_at === row.savedAt;
          if (second.insert !== "ok" || second.rows.length !== 1) {
            row.violations.push(
              `P3 re-PUT: insert=${second.insert} rows=${second.rows.length}`,
            );
          }
          if (!row.savedAtStable) {
            row.violations.push("P3 saved_at changed on re-PUT");
          }
          // P4 — every 4th valid iteration exercises the cross-user paths
          if (i % 4 === 0) {
            try {
              await sql.begin(async (tx) => {
                await asUser(tx, user);
                await tx`insert into public.user_saved_drills (user_id, slug)
                           values (${other}::uuid, ${slug})
                           on conflict (user_id, slug) do nothing`;
              });
              row.crossInsert = "ok";
              row.violations.push(
                "P4 authed user inserted a row for ANOTHER user_id (RLS bypass)",
              );
            } catch (e) {
              row.crossInsert = sqlstate(e);
              if (row.crossInsert !== "42501") {
                row.violations.push(
                  `P4 cross-user insert failed with ${row.crossInsert}, expected 42501`,
                );
              }
            }
            const seen = await sql.begin(async (tx) => {
              await asUser(tx, other);
              return await tx<{ n: number }[]>`
                select count(*)::int as n from public.user_saved_drills
                 where slug = ${slug}`;
            });
            row.otherSees = seen[0].n;
            if (row.otherSees !== 0) {
              row.violations.push(
                `P4 other user sees ${row.otherSees} row(s) for the slug`,
              );
            }
            const deleted = await sql.begin(async (tx) => {
              await asUser(tx, other);
              const r = await tx`delete from public.user_saved_drills
                                   where slug = ${slug}`;
              return r.count;
            });
            row.otherDeleteCount = deleted;
            if (deleted !== 0) {
              row.violations.push(`P4 other user deleted ${deleted} row(s)`);
            }
            const survives = await sql.begin(async (tx) => {
              await asUser(tx, user);
              return await tx<{ n: number }[]>`
                select count(*)::int as n from public.user_saved_drills
                 where user_id = ${user}::uuid and slug = ${slug}`;
            });
            row.ownerRowSurvives = survives[0].n === 1;
            if (!row.ownerRowSurvives) {
              row.violations.push(
                "P4 owner's row did not survive the other user's delete",
              );
            }
          }
        } else {
          // P2 — the edge already answered 400; the DB must refuse it too.
          if (first.insert === "ok") {
            gaps.push(row);
          } else if (first.insert !== "23514" && first.insert !== "22021") {
            row.violations.push(
              `P2 edge-invalid slug: unexpected sqlstate ${first.insert}`,
            );
          }
          if (first.rows.length !== 0 && first.insert !== "ok") {
            row.violations.push(
              `P2 refused insert but ${first.rows.length} row(s) present`,
            );
          }
        }
        rows.push(row);
        if (row.violations.length > 0) violations.push(row);
      }

      // P5 — anon (the whole transaction is the try scope: postgres.js
      // surfaces an in-transaction failure from `begin` itself)
      const anonSelect = await sql
        .begin(async (tx) => {
          await asAnon(tx);
          await tx`select count(*) from public.user_saved_drills`;
          return "ok";
        })
        .catch(sqlstate);
      const anonInsert = await sql
        .begin(async (tx) => {
          await asAnon(tx);
          await tx`insert into public.user_saved_drills (user_id, slug)
                     values (${users[0]}::uuid, 'anon-slug')`;
          return "ok";
        })
        .catch(sqlstate);

      const histogram = (values: string[]) =>
        values.reduce<Record<string, number>>((acc, v) => {
          acc[v] = (acc[v] ?? 0) + 1;
          return acc;
        }, {});
      const summary = {
        file: "stress_saved_drills_put_pg.test.ts",
        campaignSeed: STRESS_SEED,
        iterations: STRESS_ITER,
        executed: rows.length,
        pgUrlHost: new URL(PG_URL).host,
        violationCount: violations.length,
        defenseInDepthGaps: gaps.length,
        gapSlugKinds: histogram(gaps.map((g) => g.slugKind)),
        edgeValid: rows.filter((r) => r.edgeValid).length,
        edgeInvalidReachingDb: rows.filter((r) =>
          !r.edgeValid && r.slug !== null
        ).length,
        malformedPercentNeverReachDb: rows.filter((r) =>
          r.slug === null
        ).length,
        insertOutcomes: histogram(
          rows.map((r) => `${r.edgeValid ? "valid" : "invalid"}:${r.insert}`),
        ),
        crossUserChecks: rows.filter((r) => r.crossInsert !== "skipped").length,
        crossInsertOutcomes: histogram(
          rows.filter((r) => r.crossInsert !== "skipped").map((r) =>
            r.crossInsert
          ),
        ),
        anonSelect,
        anonInsert,
        slugKindHistogram: histogram(rows.map((r) => r.slugKind)),
        invariants: [
          {
            name: "P1 edge-valid ⇒ one row, slug stored as decoded",
            holds: !violations.some((v) =>
              v.violations.some((x) => x.startsWith("P1"))
            ),
          },
          {
            name:
              "P2 edge-invalid ⇒ refused by CHECK (23514) / unstorable (22021), never accepted",
            holds: gaps.length === 0 &&
              !violations.some((v) =>
                v.violations.some((x) => x.startsWith("P2"))
              ),
          },
          {
            name: "P3 re-PUT idempotent (one row, saved_at stable)",
            holds: !violations.some((v) =>
              v.violations.some((x) => x.startsWith("P3"))
            ),
          },
          {
            name:
              "P4 RLS owner-only (cross insert 42501, invisible, undeletable)",
            holds: !violations.some((v) =>
              v.violations.some((x) => x.startsWith("P4"))
            ),
          },
          {
            name: "P5 anon has no access",
            holds: anonSelect === "42501" && anonInsert === "42501",
          },
        ],
      };
      await writeJson("pg_summary.json", summary);
      await writeJson("pg_results.json", rows);
      await writeJson("pg_violations.json", violations);
      await writeJson("pg_defense_gaps.json", gaps);
      console.log(
        `[stress-pg] seed=${STRESS_SEED} executed=${rows.length} violations=${violations.length} gaps=${gaps.length} insertOutcomes=${
          JSON.stringify(summary.insertOutcomes)
        } anon=${anonSelect}/${anonInsert} → ${OUT_DIR}pg_summary.json`,
      );
      for (const v of violations.slice(0, 20)) {
        console.log(
          `[stress-pg]   BROKEN iterSeed=${v.iterSeed} i=${v.i} ${v.slugKind} ${
            JSON.stringify(v.slug)
          } :: ${v.violations.join(" | ")}`,
        );
      }
      for (const g of gaps.slice(0, 20)) {
        console.log(
          `[stress-pg]   GAP iterSeed=${g.iterSeed} i=${g.i} ${g.slugKind} ${
            JSON.stringify(g.slug)
          } accepted by Postgres, refused by edge`,
        );
      }
      assertEquals(rows.length, STRESS_ITER, "every iteration ran");
      assertEquals(anonSelect, "42501", "anon select refused");
      assertEquals(anonInsert, "42501", "anon insert refused");
      assertEquals(
        violations.length,
        0,
        `${violations.length} Postgres-layer violation(s); see pg_violations.json`,
      );
      assert(
        gaps.length === 0,
        `${gaps.length} edge-invalid slug(s) accepted by Postgres; see pg_defense_gaps.json`,
      );
    } finally {
      await sql.end({ timeout: 5 });
    }
  },
});
