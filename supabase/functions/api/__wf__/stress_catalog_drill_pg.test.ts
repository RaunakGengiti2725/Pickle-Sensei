/**
 * stress — `GET /v1/catalog/drills/:slug` under concurrency, `user_saved_drills`
 * on a REAL PostgreSQL 16 with every migration applied (./xc_pg_up.sh).
 *
 * Same real handler / same scenarios as stress_catalog_drill_concurrency.test.ts;
 * the PostgREST shim's table calls are executed as role `authenticated` with
 * the bearer's `sub` (RLS enforced), one connection per in-flight request.
 *
 *   XC_PG_CONTAINER=pickle-stress-pg XC_PG_PORT=55434 ./xc_pg_up.sh
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55434/postgres \
 *     deno test -A --no-check --config deno.json stress_catalog_drill_pg.test.ts
 *
 * Without XC_PG_URL (alias PICKLE_AUDIT_PG_URL) every test is `ignore`d — an
 * ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  loadStressHarness,
  runScenario,
  type SavedDrillRow,
  type SavedDrillsStore,
  STRESS_BURST,
  STRESS_ITER,
  writeSeedTable,
} from "./stress_catalog_drill_harness.ts";
import { SCENARIOS } from "./stress_catalog_drill_scenarios.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const TEST_FILE = "stress_catalog_drill_pg.test.ts";

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuidLiteral(id: string): string {
  if (!UUID_RE.test(id)) throw new Error(`not a uuid: ${id}`);
  return `'${id}'`;
}

/** `user_saved_drills` on the disposable database. Every call runs in its own
 * transaction as `authenticated` + the principal's sub (RLS), so the model's
 * "another user cannot read/write my row" is PostgreSQL's policy, not code. */
class PgSavedDrills implements SavedDrillsStore {
  readonly sql: Sql;
  private readonly users = new Set<string>();

  constructor(url: string) {
    this.sql = postgres(url, { max: STRESS_BURST * 2 + 4, onnotice: () => {} });
  }

  private async asPrincipal<T>(principal: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return await this.sql.begin(async (tx) => {
      if (principal) {
        await tx.unsafe(`set local role authenticated`);
        await tx.unsafe(`set local request.jwt.claim.sub = ${uuidLiteral(principal)}`);
      }
      return await fn(tx as unknown as Tx);
    }) as T;
  }

  async reset(): Promise<void> {
    for (const id of this.users) {
      await this.sql.unsafe(`delete from auth.users where id = ${uuidLiteral(id)}`);
    }
    this.users.clear();
  }

  async ensureUser(userId: string): Promise<void> {
    if (this.users.has(userId)) return;
    await this.sql.unsafe(`delete from auth.users where id = ${uuidLiteral(userId)}`);
    await this.sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data)
       values (${uuidLiteral(userId)}, '${userId}@example.com', '{"provider":"google"}')`,
    );
    this.users.add(userId);
  }

  select(principal: string | null, userId: string, slug: string): Promise<SavedDrillRow[]> {
    return this.asPrincipal(principal, async (tx) => {
      const rows = await tx.unsafe(
        `select user_id, slug, saved_at from public.user_saved_drills
          where user_id = ${uuidLiteral(userId)} and slug = $1`,
        [slug],
      );
      return rows.map((r) => ({
        user_id: String(r.user_id),
        slug: String(r.slug),
        saved_at: new Date(r.saved_at as string).toISOString(),
      }));
    });
  }

  upsertIgnore(principal: string | null, row: { user_id: string; slug: string }): Promise<boolean> {
    return this.asPrincipal(principal, async (tx) => {
      await tx.unsafe(
        `insert into public.user_saved_drills (user_id, slug)
          values (${uuidLiteral(row.user_id)}, $1)
          on conflict (user_id, slug) do nothing`,
        [row.slug],
      );
      return true;
    }).catch((error: unknown) => {
      // postgres.js rolled the tx back; an RLS denial is the modelled `false`.
      if ((error as { code?: string }).code === "42501") return false;
      throw error;
    });
  }

  del(principal: string | null, userId: string, slug: string): Promise<void> {
    return this.asPrincipal(principal, async (tx) => {
      await tx.unsafe(
        `delete from public.user_saved_drills where user_id = ${uuidLiteral(userId)} and slug = $1`,
        [slug],
      );
    });
  }

  async all(): Promise<SavedDrillRow[]> {
    if (this.users.size === 0) return [];
    const ids = [...this.users].map(uuidLiteral).join(",");
    const rows = await this.sql.unsafe(
      `select user_id, slug, saved_at from public.user_saved_drills where user_id in (${ids})`,
    );
    return rows.map((r) => ({
      user_id: String(r.user_id),
      slug: String(r.slug),
      saved_at: new Date(r.saved_at as string).toISOString(),
    }));
  }

  async seed(row: { user_id: string; slug: string }): Promise<void> {
    await this.ensureUser(row.user_id);
    await this.sql.unsafe(
      `insert into public.user_saved_drills (user_id, slug) values (${uuidLiteral(row.user_id)}, $1)
        on conflict do nothing`,
      [row.slug],
    );
  }

  async close(): Promise<void> {
    await this.reset();
    await this.sql.end({ timeout: 5 });
  }
}

const store = ignore ? null : new PgSavedDrills(PG_URL);

SCENARIOS.forEach((scenario, index) => {
  Deno.test({
    name: `${scenario.label} — ${scenario.name} (postgres:16, ${STRESS_ITER} seeds)`,
    ignore,
    async fn() {
      const h = await loadStressHarness(store!);
      const result = await runScenario(
        h,
        TEST_FILE,
        index,
        scenario.name,
        scenario.label,
        scenario.run,
      );
      const notHeld = result.iterations.filter((i) => i.outcome !== "HELD");
      assertEquals(
        notHeld.map((i) =>
          `seed=${i.seed} ${i.outcome}: ${i.failed.join(" | ")}\n  replay: XC_PG_URL=… ${i.replay}`
        ),
        [],
        `${scenario.name}: ${notHeld.length}/${result.iterations.length} iterations did not hold`,
      );
    },
  });
});

Deno.test({
  name: "stress — seed table written (postgres:16)",
  ignore,
  async fn() {
    const path = await writeSeedTable("seeds.pg.json");
    const table = JSON.parse(await Deno.readTextFile(path)) as { totals: { iterations: number } };
    assertEquals(table.totals.iterations, SCENARIOS.length * STRESS_ITER);
    await store!.close();
  },
});
