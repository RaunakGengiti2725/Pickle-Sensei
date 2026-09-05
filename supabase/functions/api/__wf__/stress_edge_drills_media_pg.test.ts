// STRESS — edge-drills-media, lens failure-load, part 3: REAL POSTGRES.
//
// The saved-drill routes (PUT/DELETE/GET /v1/me/saved-drills, and the `saved`
// flags on GET /v1/catalog/drills[/:slug]) read and write
// public.user_saved_drills through PostgREST. Here the REAL edge handler runs
// in-process (stress_edge_drills_media_harness.ts) and its PostgREST calls are
// translated onto a disposable docker postgres:16 with EVERY migration applied
// (`../../../tests/run_rls_tests.sh` style; see ./xc_pg_up.sh), executed AS the
// bearer's role (`set local role authenticated` + `request.jwt.claim.sub`) so
// RLS, grants, the PK and the slug CHECK constraint are the real ones.
//
//   ./xc_pg_up.sh                                   # prints XC_PG_URL
//   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
//     deno test -A --no-check --config deno.json stress_edge_drills_media_pg.test.ts
//
// Without STRESS_PG_URL / XC_PG_URL / PICKLE_AUDIT_PG_URL every test is
// `ignore`d — an ignored test is NOT a pass (the suite prints it as ignored).
// Never points at a hosted project. Scale knob: STRESS_PG_ITER (default 200).

import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  edgeRequest,
  envInt,
  histogram,
  loadStressHarness,
  percentile,
  Prng,
  readJson,
  sessionToken,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_edge_drills_media_harness.ts";

const PG_URL = Deno.env.get("STRESS_PG_URL") ?? Deno.env.get("XC_PG_URL") ??
  Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";
const ITER = envInt("STRESS_PG_ITER", 200);

type Sql = ReturnType<typeof postgres>;
type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLUMNS = new Set(["user_id", "slug", "saved_at"]);

// ── PostgREST → SQL translator (user_saved_drills only) ──────────────────────

function pgrst(
  status: number,
  code: string,
  message: string,
  details: string | null = null,
): Response {
  return new Response(JSON.stringify({ code, message, details, hint: null }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** PostgREST's HTTP status for a Postgres SQLSTATE (the subset these routes can hit). */
function statusForSqlState(code: string): number {
  if (code === "42501") return 403; // insufficient_privilege / RLS with-check
  if (code === "23505" || code === "23503") return 409;
  if (code === "23514" || code === "22P02" || code === "22001") return 400;
  if (code === "42P01") return 404;
  return 500;
}

async function asUser(tx: Tx, sub: string): Promise<void> {
  await tx.unsafe(`set local role authenticated`);
  await tx.unsafe(`select set_config('request.jwt.claim.sub', $1, true)`, [
    sub,
  ]);
}

/** Answer one PostgREST request against the real table as `sub`. */
function makeRestBackend(sql: Sql) {
  return async (
    request: Request,
    rawBody: string,
    sub: string,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const table = url.pathname.slice("/rest/v1/".length);
    if (table !== "user_saved_drills") {
      return pgrst(404, "PGRST205", `not modelled: ${table}`);
    }
    if (!UUID_RE.test(sub)) {
      return pgrst(401, "PGRST301", "JWT sub is not a uuid");
    }
    const where: string[] = [];
    const params: unknown[] = [];
    let order = "";
    for (const [key, value] of url.searchParams) {
      if (
        ["select", "on_conflict", "columns", "limit", "offset"].includes(key)
      ) continue;
      if (key === "order") {
        const [col, dir] = value.split(".");
        if (!COLUMNS.has(col)) {
          return pgrst(400, "PGRST100", `bad order column ${col}`);
        }
        order = ` order by ${col} ${dir === "desc" ? "desc" : "asc"}`;
        continue;
      }
      if (!COLUMNS.has(key) || !value.startsWith("eq.")) {
        return pgrst(400, "PGRST100", `unsupported filter ${key}=${value}`);
      }
      params.push(value.slice(3));
      where.push(`${key} = $${params.length}`);
    }
    const whereSql = where.length ? ` where ${where.join(" and ")}` : "";
    const prefer = request.headers.get("prefer") ?? "";
    const wantsObject = (request.headers.get("accept") ?? "").includes(
      "application/vnd.pgrst.object+json",
    );
    const select = (url.searchParams.get("select") ?? "*").split(",").map((c) =>
      c.trim()
    );
    if (!select.every((c) => c === "*" || COLUMNS.has(c))) {
      return pgrst(400, "PGRST100", "bad select");
    }
    const cols = select.includes("*")
      ? "user_id, slug, to_json(saved_at)#>>'{}' as saved_at"
      : select.map((
        c,
      ) => (c === "saved_at" ? "to_json(saved_at)#>>'{}' as saved_at" : c))
        .join(", ");

    try {
      return await sql.begin(async (t) => {
        const tx = t as unknown as Tx;
        await asUser(tx, sub);
        if (request.method === "GET") {
          const rows = await tx.unsafe(
            `select ${cols} from public.user_saved_drills${whereSql}${order}`,
            params as never,
          );
          if (wantsObject) {
            if (rows.length === 1) {
              return new Response(JSON.stringify(rows[0]), { status: 200 });
            }
            return pgrst(
              406,
              "PGRST116",
              "JSON object requested, multiple (or no) rows returned",
              `The result contains ${rows.length} rows`,
            );
          }
          return new Response(JSON.stringify([...rows]), { status: 200 });
        }
        if (request.method === "POST") {
          let payload: unknown;
          try {
            payload = JSON.parse(rawBody);
          } catch {
            return pgrst(400, "PGRST102", "Empty or invalid json");
          }
          const rows = (Array.isArray(payload) ? payload : [payload]) as Array<
            Record<string, unknown>
          >;
          const onConflict = url.searchParams.get("on_conflict");
          const conflict = onConflict
            ? prefer.includes("resolution=ignore-duplicates")
              ? ` on conflict (${
                onConflict.split(",").filter((c) => COLUMNS.has(c)).join(", ")
              }) do nothing`
              : prefer.includes("resolution=merge-duplicates")
              ? ` on conflict (${
                onConflict.split(",").filter((c) => COLUMNS.has(c)).join(", ")
              }) do update set slug = excluded.slug`
              : ""
            : "";
          const inserted: unknown[] = [];
          for (const row of rows) {
            const keys = Object.keys(row);
            if (!keys.every((k) => COLUMNS.has(k))) {
              return pgrst(400, "PGRST204", `unknown column ${keys.join(",")}`);
            }
            const values = keys.map((k) => row[k]);
            const out = await tx.unsafe(
              `insert into public.user_saved_drills (${
                keys.join(", ")
              }) values (${
                keys.map((_, i) => `$${i + 1}`).join(", ")
              })${conflict} returning user_id, slug, to_json(saved_at)#>>'{}' as saved_at`,
              values as never,
            );
            inserted.push(...out);
          }
          if (prefer.includes("return=representation")) {
            return new Response(JSON.stringify(inserted), { status: 201 });
          }
          return new Response(null, { status: 201 });
        }
        if (request.method === "DELETE") {
          const gone = await tx.unsafe(
            `delete from public.user_saved_drills${whereSql} returning user_id, slug, to_json(saved_at)#>>'{}' as saved_at`,
            params as never,
          );
          if (prefer.includes("return=representation")) {
            return new Response(JSON.stringify([...gone]), { status: 200 });
          }
          return new Response(null, { status: 204 });
        }
        if (request.method === "PATCH") {
          return pgrst(405, "PGRST105", "PATCH not modelled");
        }
        return pgrst(405, "PGRST105", `${request.method} not modelled`);
      }) as Response;
    } catch (error) {
      const code = (error as { code?: string }).code ?? "XX000";
      const message = (error as Error).message ?? String(error);
      return pgrst(statusForSqlState(code), code, message);
    }
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

interface User {
  id: string;
  token: string;
  ip: string;
}

async function createUser(sql: Sql, id: string): Promise<void> {
  await sql.unsafe(`delete from auth.users where id = $1`, [id]);
  await sql.unsafe(
    `insert into auth.users (id, email, raw_app_meta_data) values ($1, $2, '{"provider":"google"}')`,
    [id, `${id}@stress.example`],
  );
  // on_auth_user_created materialises the profile row the FK needs.
  const profile = await sql.unsafe(
    `select 1 from public.profiles where id = $1`,
    [id],
  );
  assertEquals(
    profile.length,
    1,
    `profile for ${id} must be created by trigger`,
  );
}

async function ownerRows(
  sql: Sql,
  id: string,
): Promise<Array<{ slug: string; saved_at: string }>> {
  return [
    ...(await sql.unsafe(
      `select slug, to_json(saved_at)#>>'{}' as saved_at from public.user_saved_drills where user_id = $1 order by slug`,
      [id],
    )),
  ] as Array<{ slug: string; saved_at: string }>;
}

async function setup(): Promise<
  { sql: Sql; h: StressHarness; users: User[]; prng: Prng; catalog: string[] }
> {
  const sql = postgres(PG_URL, { max: 8 });
  const h = await loadStressHarness({ redis: false });
  h.restBackend = makeRestBackend(sql);
  const prng = new Prng(STRESS_SEED).fork("pg-routes");
  const users: User[] = [];
  for (let i = 0; i < 5; i++) {
    const id = prng.uuid();
    await createUser(sql, id);
    users.push({ id, token: sessionToken(id), ip: prng.ip() });
  }
  const catalog = (await drillCatalog()).map((d) => d.slug);
  return { sql, h, users, prng, catalog };
}

async function teardown(
  sql: Sql,
  h: StressHarness,
  users: User[],
): Promise<void> {
  for (const u of users) {
    await sql.unsafe(`delete from auth.users where id = $1`, [u.id]);
  }
  await sql.end({ timeout: 5 });
  h.restBackend = null;
  h.dispose();
}

const put = (h: StressHarness, u: User, slug: string) =>
  h.handler(
    edgeRequest("PUT", `/v1/me/saved-drills/${slug}`, {
      token: u.token,
      ip: u.ip,
      body: { slug, saved: true },
    }),
  );
const del = (h: StressHarness, u: User, slug: string) =>
  h.handler(
    edgeRequest("DELETE", `/v1/me/saved-drills/${slug}`, {
      token: u.token,
      ip: u.ip,
    }),
  );
const saved = (h: StressHarness, u: User) =>
  h.handler(
    edgeRequest("GET", "/v1/me/saved-drills", { token: u.token, ip: u.ip }),
  );
const detail = (h: StressHarness, u: User, slug: string) =>
  h.handler(
    edgeRequest("GET", `/v1/catalog/drills/${slug}`, {
      token: u.token,
      ip: u.ip,
    }),
  );
const list = (h: StressHarness, u: User) =>
  h.handler(
    edgeRequest("GET", "/v1/catalog/drills", { token: u.token, ip: u.ip }),
  );

Deno.test({
  name:
    "stress/pg: saved-drill routes against docker postgres:16 — idempotent PUT, slug bounds, owner isolation, model check",
  ignore,
  async fn() {
    const { sql, h, users, prng, catalog } = await setup();
    const report: Record<string, unknown> = {
      seed: STRESS_SEED,
      pg_url_host: new URL(PG_URL).host,
      iterations: ITER,
    };
    const failures: string[] = [];
    try {
      const [a, b] = users;
      const slug = catalog[0];

      // 1. PUT is idempotent (PK + ignore-duplicates): N sequential + 8 concurrent PUTs → one row, savedAt unchanged.
      const first = await readJson(await put(h, a, slug));
      const seqStatuses: number[] = [];
      for (let i = 0; i < 5; i++) {
        seqStatuses.push((await put(h, a, slug)).status);
      }
      const concurrent = await Promise.all(
        Array.from({ length: 8 }, () => put(h, a, slug)),
      );
      const concurrentBodies = await Promise.all(
        concurrent.map((r) => readJson(r)),
      );
      const rowsA = await ownerRows(sql, a.id);
      report.idempotent_put = {
        first,
        sequential_statuses: histogram(seqStatuses),
        concurrent_statuses: histogram(concurrent.map((r) => r.status)),
        rows_in_db: rowsA.length,
        saved_at_stable: concurrentBodies.every((x) =>
          x.savedAt === first.savedAt
        ),
      };
      if (rowsA.length !== 1) {
        failures.push(`idempotent PUT left ${rowsA.length} rows`);
      }
      if (
        !concurrent.every((r) => r.status === 200) ||
        !seqStatuses.every((s) => s === 200)
      ) failures.push("repeat PUT not 200");
      if (!concurrentBodies.every((x) => x.savedAt === first.savedAt)) {
        failures.push("savedAt changed on duplicate PUT");
      }

      // 2. Slug bounds: 120 chars accepted end-to-end (edge regex AND DB CHECK); 121 refused at the edge (400) and,
      //    bypassing the edge, by the DB CHECK (23514); uppercase survives round-trip byte-for-byte.
      const s120 = `z${"a".repeat(119)}`;
      const s121 = `z${"a".repeat(120)}`;
      const upper = "Wall-Dink-RALLY";
      const r120 = await put(h, a, s120);
      const r121 = await put(h, a, s121);
      const rUpper = await readJson(await put(h, a, upper));
      let dbCheck = "not raised";
      try {
        await sql.begin(async (t) => {
          await asUser(t as unknown as Tx, a.id);
          await (t as unknown as Tx).unsafe(
            `insert into public.user_saved_drills (user_id, slug) values ($1, $2)`,
            [a.id, s121],
          );
        });
      } catch (error) {
        dbCheck = `${(error as { code?: string }).code}: ${
          (error as Error).message
        }`;
      }
      const afterBounds = await ownerRows(sql, a.id);
      report.slug_bounds = {
        put_120: r120.status,
        put_121: r121.status,
        put_121_code: (await readJson(r121)).error,
        db_check_on_121_bypassing_edge: dbCheck,
        upper_saved: rUpper,
        upper_in_db: afterBounds.some((r) => r.slug === upper),
        upper_detail_lookup: (await detail(h, a, upper)).status,
      };
      await r120.body?.cancel();
      if (r120.status !== 200) {
        failures.push(`120-char slug PUT → ${r120.status}`);
      }
      if (r121.status !== 400) {
        failures.push(`121-char slug PUT → ${r121.status}`);
      }
      if (!dbCheck.startsWith("23514")) {
        failures.push(`DB CHECK did not refuse 121 chars: ${dbCheck}`);
      }

      // 3. Differential: the edge regex and the DB CHECK regex must agree on hostile inputs
      //    (a disagreement would let the edge 400 something the DB accepts, or 503 on a DB refusal).
      const EDGE_RE = /^[a-z0-9][a-z0-9_-]{0,119}$/i;
      const fuzz = new Prng(STRESS_SEED).fork("slug-regex-diff");
      const alphabet = "abcXYZ019_-./%é\u00df\u30c9 \t\n'\";*";
      const disagreements: Array<{ slug: string; edge: boolean; db: boolean }> =
        [];
      const probes: string[] = [
        "",
        "a",
        "A",
        "-",
        "_",
        "z".repeat(120),
        "z".repeat(121),
        "\u00e9",
        "a\u0301",
        "a\n",
        "A-Z_9",
      ];
      for (let i = 0; i < 200; i++) {
        probes.push(
          Array.from(
            { length: fuzz.int(0, 8) },
            () => alphabet[fuzz.int(0, alphabet.length - 1)],
          ).join(""),
        );
      }
      for (const p of probes) {
        const [{ ok }] = await sql.unsafe(
          `select $1 ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$' as ok`,
          [p],
        );
        if (Boolean(ok) !== EDGE_RE.test(p)) {
          disagreements.push({
            slug: p,
            edge: EDGE_RE.test(p),
            db: Boolean(ok),
          });
        }
      }
      report.regex_differential = { probes: probes.length, disagreements };
      if (disagreements.length) {
        failures.push(
          `edge/DB slug regex disagree on ${disagreements.length} probes`,
        );
      }

      // 4. Owner isolation under real RLS: B cannot see, delete, or write A's rows via the edge or the table.
      const bList = await readJson(await saved(h, b));
      const bDelete = await del(h, b, slug);
      await bDelete.body?.cancel();
      const aAfterBDelete = await ownerRows(sql, a.id);
      const bDetail = await readJson(await detail(h, b, slug));
      let crossWrite = "not raised";
      try {
        await sql.begin(async (t) => {
          await asUser(t as unknown as Tx, b.id);
          await (t as unknown as Tx).unsafe(
            `insert into public.user_saved_drills (user_id, slug) values ($1, $2)`,
            [a.id, "cross-user"],
          );
        });
      } catch (error) {
        crossWrite = `${(error as { code?: string }).code}: ${
          (error as Error).message
        }`;
      }
      let crossRead = -1;
      await sql.begin(async (t) => {
        await asUser(t as unknown as Tx, b.id);
        crossRead = (await (t as unknown as Tx).unsafe(
          `select count(*)::int as n from public.user_saved_drills where user_id = $1`,
          [a.id],
        ))[0].n;
      });
      report.owner_isolation = {
        b_saved_list_items: (bList.items as unknown[]).length,
        b_delete_a_slug: bDelete.status,
        a_rows_after_b_delete: aAfterBDelete.length,
        b_detail_saved_flag: (bDetail.drill as { saved: boolean }).saved,
        b_insert_as_a_bypassing_edge: crossWrite,
        b_select_a_rows_bypassing_edge: crossRead,
      };
      if ((bList.items as unknown[]).length !== 0) {
        failures.push("B sees A's saved drills");
      }
      if (aAfterBDelete.length !== 3) {
        failures.push(
          `B's DELETE removed A's rows (${aAfterBDelete.length} left of 3)`,
        );
      }
      if ((bDetail.drill as { saved: boolean }).saved) {
        failures.push("B's detail shows A's save");
      }
      if (!crossWrite.startsWith("42501")) {
        failures.push(`RLS did not refuse B writing A's row: ${crossWrite}`);
      }
      if (crossRead !== 0) {
        failures.push(`RLS let B read ${crossRead} of A's rows`);
      }

      // 5. Seeded model check: random PUT/DELETE/GET across 5 users; the edge's
      //    saved list + `saved` flags must equal the model and the table after every op.
      const model = new Map<string, Set<string>>(
        users.map((u) => [u.id, new Set<string>()]),
      );
      for (const u of users) {
        await sql.unsafe(
          `delete from public.user_saved_drills where user_id = $1`,
          [u.id],
        );
      }
      const ops: Array<
        {
          i: number;
          seed: number;
          user: number;
          op: string;
          slug: string;
          status: number;
          rest: number;
          ms: number;
        }
      > = [];
      const latency: number[] = [];
      for (let i = 0; i < ITER; i++) {
        const seed = (prng.seed ^ (i * 40503)) >>> 0;
        const step = new Prng(seed);
        const ui = step.int(0, users.length - 1);
        const u = users[ui];
        const op = step.pick([
          "put",
          "put",
          "delete",
          "saved",
          "list",
          "detail",
        ]);
        const s = step.next() < 0.85
          ? step.pick(catalog)
          : `orphan-${step.int(0, 3)}`;
        const mark = h.calls.length;
        const t0 = performance.now();
        let response: Response;
        let ok = true;
        if (op === "put") {
          response = await put(h, u, s);
          ok = response.status === 200;
          if (ok) model.get(u.id)!.add(s);
        } else if (op === "delete") {
          response = await del(h, u, s);
          ok = response.status === 204;
          if (ok) model.get(u.id)!.delete(s);
        } else if (op === "saved") {
          response = await saved(h, u);
          const body = await readJson(response.clone());
          const got = new Set(
            ((body.items as Array<{ slug: string }>) ?? []).map((x) => x.slug),
          );
          ok = response.status === 200 && got.size === model.get(u.id)!.size &&
            [...got].every((x) => model.get(u.id)!.has(x));
        } else if (op === "list") {
          response = await list(h, u);
          const body = await readJson(response.clone());
          const flagged = new Set(
            ((body.items as Array<{ slug: string; saved: boolean }>) ?? [])
              .filter((x) => x.saved).map((x) => x.slug),
          );
          const expected = new Set(
            [...model.get(u.id)!].filter((x) => catalog.includes(x)),
          );
          ok = response.status === 200 && flagged.size === expected.size &&
            [...flagged].every((x) => expected.has(x));
        } else {
          response = await detail(h, u, s);
          const body = await readJson(response.clone());
          ok = catalog.includes(s)
            ? response.status === 200 &&
              (body.drill as { saved: boolean }).saved ===
                model.get(u.id)!.has(s)
            : response.status === 404;
        }
        const ms = performance.now() - t0;
        await response.body?.cancel();
        latency.push(ms);
        const rest = h.callsSince(mark).filter((c) =>
          c.upstream === "rest"
        ).length;
        ops.push({
          i,
          seed,
          user: ui,
          op,
          slug: s,
          status: response.status,
          rest,
          ms: Math.round(ms * 100) / 100,
        });
        if (!ok) {
          failures.push(
            `model op ${i} (seed ${seed}) ${op} ${s} user${ui} → ${response.status}`,
          );
        }
        if (rest > 2) {
          failures.push(`op ${i} did ${rest} PostgREST round trips`);
        }
      }
      // Table must equal the model for every user.
      for (const [ui, u] of users.entries()) {
        const rows = (await ownerRows(sql, u.id)).map((r) => r.slug).sort();
        const expected = [...model.get(u.id)!].sort();
        if (JSON.stringify(rows) !== JSON.stringify(expected)) {
          failures.push(
            `table ≠ model for user${ui}: ${JSON.stringify(rows)} vs ${
              JSON.stringify(expected)
            }`,
          );
        }
      }
      const sorted = latency.slice().sort((x, y) => x - y);
      report.model_check = {
        ops: ops.length,
        statuses: histogram(ops.map((o) => `${o.op}:${o.status}`)),
        rest_round_trips: histogram(ops.map((o) => o.rest)),
        p50_ms: Math.round(percentile(sorted, 50) * 100) / 100,
        p95_ms: Math.round(percentile(sorted, 95) * 100) / 100,
        rows_by_user: Object.fromEntries(
          users.map((u, i) => [`user${i}`, model.get(u.id)!.size]),
        ),
      };
      report.ops = ops;
    } finally {
      report.failures = failures;
      const path = await writeArtifact("pg_routes.json", report);
      console.log(
        `[stress/pg] ${ITER} model ops + fixtures against ${
          new URL(PG_URL).host
        }; failures=${failures.length} → ${path}`,
      );
      await teardown(sql, h, users);
    }
    assertEquals(failures, [], failures.join("\n"));
    assert(true);
  },
});
