/**
 * W07-06 adversarial tests — GET /v1/progress through the REAL edge handler
 * against a REAL PostgREST over the disposable Postgres (no stand-in parser).
 *
 * The candidate's route tests prove the keyset `or=(…)` grammar against a
 * PostgREST-like stand-in that the same author wrote. These tests instead let
 * the shipping fn talk to PostgREST v12 itself, so the composite-key
 * predicate, its quoting/escaping, the DB collation order, and PostgREST's
 * `db-max-rows` clamp are exercised as deployed.
 *
 *   ./xc_pg_up.sh                                  # prints XC_PG_URL
 *   docker run -d --name pickle-xc-pgrst --network host \
 *     -e PGRST_DB_URI=postgres://authenticator:pgrst@127.0.0.1:55433/postgres \
 *     -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
 *     -e PGRST_JWT_SECRET=<32+ chars> -e PGRST_DB_MAX_ROWS=1000 \
 *     -e PGRST_SERVER_PORT=3300 -e PGRST_SERVER_HOST=127.0.0.1 postgrest/postgrest:v12.2.3
 *   (optional, for L4) the same image with PGRST_DB_MAX_ROWS=500 on port 3301
 *   XC_PG_URL=postgres://postgres:pg@127.0.0.1:55433/postgres \
 *   XC_PGRST_URL=http://127.0.0.1:3300 \
 *   XC_PGRST_MAXROWS500_URL=http://127.0.0.1:3301 \
 *   XC_PGRST_JWT=<HS256 JWT {role:"pgrst_inv"} signed with PGRST_JWT_SECRET> \
 *     deno test -A --no-check --config deno.json attack_w0706_live_postgrest.test.ts
 *
 * The PostgREST role (`pgrst_inv`, BYPASSRLS, SELECT on public) exists only in
 * the disposable DB; roles `authenticator`/`anon` are created for it there.
 * Without the env every test is `ignore`d — an ignored run is NOT a pass.
 */
import postgres from "postgres";
import { assert, assertEquals } from "@std/assert";
import { cacheDel } from "../cache.ts";
import { fakeGoogleIdToken, loadHarness, type RecordedCall, userRequest } from "./routesHarness.ts";

const PG_URL = Deno.env.get("XC_PG_URL") ?? "";
const PGRST_URL = Deno.env.get("XC_PGRST_URL") ?? "";
const PGRST_500_URL = Deno.env.get("XC_PGRST_MAXROWS500_URL") ?? "";
const PGRST_JWT = Deno.env.get("XC_PGRST_JWT") ?? "";
const ignore = PG_URL === "" || PGRST_URL === "" || PGRST_JWT === "";

const h = await loadHarness();

const OWNER = "07060b00-0000-4000-8000-000000000001";
const OTHER = "07060b00-0000-4000-8000-000000000002";
const DAY_MS = 86_400_000;

/** Values chosen to stress PostgREST's filter grammar (quotes, backslashes,
 * commas, parentheses, dots, logical keywords, `null`), URL encoding (space,
 * plus, percent, ampersand), and collation order (case, unicode). */
const SHOT_TYPES = [
  "dink",
  "Dink",
  "DINK",
  "dink,drive",
  'dr"ive',
  "back\\slash",
  "paren)",
  "(paren",
  "dot.op",
  "lt.x",
  "or",
  "and",
  "sp ace",
  " lead",
  "trail ",
  "ünïcödé",
  "日本語",
  "emoji🎾",
  "%25percent",
  "plus+sign",
  "amp&sand",
  "null",
  "-1",
  "*",
];
const VERSIONS = ["sm-v1", "sm-v10", "sm-v2", '1.0"q', "1.0,0"];
const DAYS = 10; // 24 × 5 × 10 = 1 200 progress_daily rows → 1 full page + 200
const PRACTICE_DAYS = 1_001; // 1 full page + 1 (consecutive, ending today)
/** Clock-boundary practice days at the table's CHECK bounds: a far-future
 * capture (a device clock years ahead) and the oldest permitted one. Both
 * are rows the keyset must page past; the streak must ignore the future one. */
const CLOCK_EDGE_DAYS = ["2099-12-31", "2000-01-01"];

const isoDay = (dayIndex: number): string => new Date(dayIndex * DAY_MS).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / DAY_MS);

type Sql = ReturnType<typeof postgres>;

async function seed(sql: Sql): Promise<void> {
  for (const id of [OWNER, OTHER]) {
    await sql.unsafe(`delete from auth.users where id = '${id}'`);
    await sql.unsafe(
      `insert into auth.users (id, email, raw_app_meta_data) values ('${id}', '${id}@example.com', '{"provider":"google"}')`,
    );
  }
  const base = today();
  const shotRows: Array<Record<string, unknown>> = [];
  for (const user of [OWNER, OTHER]) {
    for (let offset = 0; offset < DAYS; offset += 1) {
      for (const [ti, shotType] of SHOT_TYPES.entries()) {
        for (const [vi, version] of VERSIONS.entries()) {
          // Two shots per point so avg != best and counts are 2.
          for (const k of [0, 1]) {
            shotRows.push({
              id: crypto.randomUUID(),
              user_id: user,
              shot_type: shotType,
              camera_view: "side",
              captured_at: new Date(
                (base - offset) * DAY_MS + 12 * 3_600_000 + k * 1_000,
              ).toISOString(),
              start_ms: 0,
              contact_ms: 1,
              end_ms: 2,
              overall_score: ((ti + vi + k + offset) % 10) + (k === 0 ? 0.25 : 0),
              analysis_confidence: 0.9,
              result_kind: "scored",
              app_version: "a",
              model_bundle_version: "b",
              pose_model_version: "c",
              paddle_model_version: "d",
              stroke_detector_version: "e",
              phase_model_version: "f",
              scoring_model_version: version,
              shot_config_version: "g",
            });
          }
        }
      }
    }
  }
  for (let i = 0; i < shotRows.length; i += 500) {
    await sql`insert into public.shots ${sql(shotRows.slice(i, i + 500))}`;
  }
  const captureRows: Array<Record<string, unknown>> = [];
  for (let offset = 0; offset < PRACTICE_DAYS; offset += 1) {
    captureRows.push({
      id: crypto.randomUUID(),
      user_id: OWNER,
      captured_at: new Date((base - offset) * DAY_MS + 9 * 3_600_000).toISOString(),
      duration_ms: 1_000,
      fps: 30,
      capture_mode: "automatic_pose_trigger",
      evidence_status: "valid",
    });
  }
  for (const day of CLOCK_EDGE_DAYS) {
    captureRows.push({
      id: crypto.randomUUID(),
      user_id: OWNER,
      captured_at: `${day}T09:00:00.000Z`,
      duration_ms: 1_000,
      fps: 30,
      capture_mode: "automatic_pose_trigger",
      evidence_status: "valid",
    });
  }
  for (let i = 0; i < captureRows.length; i += 500) {
    await sql`insert into public.captures ${sql(captureRows.slice(i, i + 500))}`;
  }
}

interface TruthPoint {
  day: string;
  shot_type: string;
  scoring_model_version: string;
  shot_count: number;
  avg_score: string;
  best_score: string;
}

async function truth(sql: Sql, user: string): Promise<TruthPoint[]> {
  const rows = await sql.unsafe(
    `select day::text, shot_type, scoring_model_version, shot_count, avg_score::text, best_score::text
       from public.progress_daily where user_id = '${user}'`,
  );
  return rows as unknown as TruthPoint[];
}

const pointKey = (p: { day: string; shot_type: string; scoring_model_version: string }) =>
  `${p.day}|${p.shot_type}|${p.scoring_model_version}`;

/** Route the fn's PostgREST GETs for the two progress views to a real PostgREST. */
function proxyTo(base: string): RecordedCall[] {
  const served: RecordedCall[] = [];
  h.respond = async (call) => {
    if (call.method !== "GET") return null;
    const url = new URL(call.url);
    const table = url.pathname.slice("/rest/v1/".length);
    if (table !== "progress_daily" && table !== "practice_days") return null;
    served.push(call);
    const upstream = await h.realFetch(`${base}/${table}${url.search}`, {
      headers: {
        Authorization: `Bearer ${PGRST_JWT}`,
        Accept: call.headers["accept"] ?? "application/json",
        "Accept-Profile": "public",
      },
    });
    const body = await upstream.text();
    return new Response(body, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "application/json",
        ...(upstream.headers.get("Content-Range")
          ? { "Content-Range": upstream.headers.get("Content-Range")! }
          : {}),
      },
    });
  };
  return served;
}

interface ProgressBody {
  series?: Array<{
    day: string;
    shot_type: string;
    scoring_model_version: string;
    shot_count: number;
    avg_score: number;
    best_score: number;
  }>;
  streak?: {
    practicedToday: boolean;
    currentDays: number;
    longestDays: number;
    lastPracticeDate: string | null;
  };
}

async function progress(user: string, ip: string) {
  // buildProgress caches its payload 60s per owner; every attack must read.
  await cacheDel(`progress:${user}`);
  const res = await h.handler(
    userRequest("GET", "/v1/progress", { token: fakeGoogleIdToken(user), ip }),
  );
  const text = await res.text();
  let body: ProgressBody | null = null;
  try {
    body = JSON.parse(text) as ProgressBody;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

Deno.test({
  name: "ATTACK W07-06 L1: composite keyset over adversarial shot_type/version values matches the SQL view exactly (real PostgREST)",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 2 });
    try {
      await seed(sql);
      const expected = await truth(sql, OWNER);
      assertEquals(expected.length, SHOT_TYPES.length * VERSIONS.length * DAYS);
      h.reset();
      const served = proxyTo(PGRST_URL);
      const { status, body, text } = await progress(OWNER, "203.0.113.170");
      const pages = served.filter((c) => c.url.includes("/progress_daily"));
      const cursors = pages.map((c) => new URL(c.url).searchParams.get("or"));
      assertEquals(status, 200, `${text.slice(0, 200)} cursors=${JSON.stringify(cursors)}`);
      assert(pages.length >= 2, "1 200 rows must take more than one page");
      assert(cursors[0] === null && cursors[1] !== null, JSON.stringify(cursors));

      const got = body?.series ?? [];
      const gotKeys = got.map(pointKey);
      const expectedKeys = new Set(expected.map(pointKey));
      const missing = [...expectedKeys].filter((k) => !gotKeys.includes(k));
      const extra = gotKeys.filter((k) => !expectedKeys.has(k));
      const duplicates = gotKeys.filter((k, i) => gotKeys.indexOf(k) !== i);
      assertEquals(
        {
          count: got.length,
          missing: missing.length,
          extra: extra.length,
          duplicates: duplicates.length,
        },
        { count: expected.length, missing: 0, extra: 0, duplicates: 0 },
        JSON.stringify({
          missing: missing.slice(0, 5),
          extra: extra.slice(0, 5),
          duplicates: duplicates.slice(0, 5),
          cursors,
        }),
      );
      const byKey = new Map(expected.map((p) => [pointKey(p), p]));
      for (const point of got) {
        const want = byKey.get(pointKey(point))!;
        assertEquals(point.shot_count, want.shot_count, pointKey(point));
        assertEquals(
          point.avg_score,
          Math.round(Number(want.avg_score) * 100) / 10,
          pointKey(point),
        );
        assertEquals(
          point.best_score,
          Math.round(Number(want.best_score) * 100) / 10,
          pointKey(point),
        );
      }
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK W07-06 L2: 1 001 consecutive practice days + far-future/far-past captures through real PostgREST → streak counts every real day",
  ignore,
  async fn() {
    h.reset();
    const served = proxyTo(PGRST_URL);
    const { status, body, text } = await progress(OWNER, "203.0.113.171");
    assertEquals(status, 200, text.slice(0, 200));
    const pages = served.filter((c) => c.url.includes("/practice_days"));
    assertEquals(pages.length, 2);
    // The far-future day sorts first under day.desc, so it is the first row of
    // page 1 and the page-2 cursor is a real day, not 2099.
    const cursor = new URL(pages[1].url).searchParams.get("or") ?? "";
    assert(cursor.startsWith('(day.lt."'), cursor);
    assert(!cursor.includes("2099"), cursor);
    assertEquals(body?.streak?.currentDays, PRACTICE_DAYS, "the 2099 day is not a streak day");
    assertEquals(body?.streak?.longestDays, PRACTICE_DAYS);
    assertEquals(body?.streak?.lastPracticeDate, isoDay(today()));
    assertEquals(body?.streak?.practicedToday, true);
  },
});

Deno.test({
  name: "ATTACK W07-06 L3: the keyset `or` never widens the owner filter — another owner's identical keys are absent",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 1 });
    try {
      const other = await truth(sql, OTHER);
      assertEquals(
        other.length,
        SHOT_TYPES.length * VERSIONS.length * DAYS,
        "OTHER is seeded with the same keys",
      );
      h.reset();
      proxyTo(PGRST_URL);
      const { status, body } = await progress(OTHER, "203.0.113.172");
      assertEquals(status, 200);
      // OTHER has no captures: a leak from OWNER's practice_days would show here.
      assertEquals(body?.streak?.currentDays, 0);
      assertEquals(body?.series?.length, other.length);
      const otherKeys = new Set(other.map(pointKey));
      for (const point of body?.series ?? []) assert(otherKeys.has(pointKey(point)));
    } finally {
      await sql.end();
    }
  },
});

Deno.test({
  name: "ATTACK W07-06 L4: PostgREST db-max-rows=500 (project 'Max rows' below the fn's page) must not be a 200 with 500 of 1 200 points",
  ignore: ignore || PGRST_500_URL === "",
  async fn() {
    const sql = postgres(PG_URL, { max: 1 });
    try {
      const expected = await truth(sql, OWNER);
      h.reset();
      const served = proxyTo(PGRST_500_URL);
      const { status, body, text } = await progress(OWNER, "203.0.113.173");
      const pages = served.filter((c) => c.url.includes("/progress_daily")).length;
      const dayPages = served.filter((c) => c.url.includes("/practice_days")).length;
      assert(
        status === 503 ||
          (status === 200 &&
            body?.series?.length === expected.length &&
            body?.streak?.currentDays === PRACTICE_DAYS),
        `status=${status} series=${body?.series?.length ?? text.slice(0, 80)} of ${expected.length} (${pages} page(s)); currentDays=${body?.streak?.currentDays} of ${PRACTICE_DAYS} (${dayPages} page(s)) — PostgREST clamped every page to 500 and the fn took the short page as proof of the end`,
      );
    } finally {
      await sql.end();
    }
  },
});
