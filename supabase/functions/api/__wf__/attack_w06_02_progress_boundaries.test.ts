/**
 * W06-02 adversary — GET /v1/progress at its boundaries, through the REAL
 * handler (routesHarness). The route now carries `definitionVersion`; that
 * tag promises the numbers underneath are what the shared definition yields
 * for the served rows. Attacks:
 *
 *   • scale conversion at EVERY two-decimal value the view can produce
 *     (0.00 … 10.00): the legacy 0-100 wire value must be the decimal text
 *     with its point shifted — no binary-float drift (7.23 → 72.3, never
 *     72.30000000000001), best_score ≥ avg_score preserved;
 *   • corrupt / partial persisted rows: null or non-numeric avg/best/count,
 *     a legacy 0-100-scale row, negative and >10 scores, null day/shot type,
 *     duplicate (day, shot_type, version) keys, far-future day, a
 *     non-array body;
 *   • an empty account is an honest empty series with the tag, no fabricated
 *     trend entries;
 *   • the payload the mobile parser rejects (NaN/Infinity) must never be
 *     produced from finite-looking rows.
 *
 *   deno test -A --no-check --config deno.json attack_w06_02_progress_boundaries.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { SCORING_DEFINITION, SCORING_DEFINITION_VERSION } from "../scoringDefinition.ts";
import { fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const h = await loadHarness();
let userSeq = 0;

interface SeriesRow {
  day: string;
  shot_type: string;
  scoring_model_version: string;
  shot_count: number;
  avg_score: number;
  best_score: number;
}
interface ProgressPayload {
  definitionVersion?: unknown;
  series: SeriesRow[];
  improving: unknown[];
  needsAttention: unknown[];
  streak: {
    currentDays: number;
    longestDays: number;
    practicedToday: boolean;
    lastPracticeDate: string | null;
  };
}

async function progressFor(
  rows: Array<Record<string, unknown>>,
  days: string[] = [],
): Promise<{ status: number; raw: string; body: ProgressPayload }> {
  userSeq += 1;
  const userId = `fd000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.progress_daily = rows.map((row) => ({ ...row, user_id: userId }));
  h.tables.practice_days = days.map((day) => ({ user_id: userId, day }));
  const response = await h.handler(
    userRequest("GET", "/v1/progress", {
      token: fakeGoogleIdToken(userId),
      ip: `198.51.${180 + Math.floor(userSeq / 250)}.${(userSeq % 250) + 1}`,
    }),
  );
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as ProgressPayload };
}

const ROW = {
  day: "2026-09-01",
  shot_type: "dink",
  scoring_model_version: "v1",
  shot_count: 3,
  avg_score: 7.25,
  best_score: 8.1,
};

/** What the shared definition allows a served series row to be. */
function assertSeriesRowSatisfiesDefinition(row: SeriesRow, context: string): void {
  const { min, max } = SCORING_DEFINITION.scale;
  const perPoint = SCORING_DEFINITION.components.scoreQuantization.perPoint;
  assert(/^\d{4}-\d{2}-\d{2}$/.test(row.day), `${context}: day ${JSON.stringify(row.day)}`);
  assert(Number.isFinite(Date.parse(`${row.day}T00:00:00.000Z`)), `${context}: day parses`);
  assert(row.shot_type.trim().length > 0 && row.shot_type !== "null", `${context}: shot_type`);
  assert(
    Number.isInteger(row.shot_count) && row.shot_count >= 1,
    `${context}: shot_count ${row.shot_count}`,
  );
  for (
    const [name, wire] of [["avg_score", row.avg_score], ["best_score", row.best_score]] as const
  ) {
    assert(Number.isFinite(wire), `${context}: ${name} ${wire}`);
    const points = wire / 10;
    assert(
      points >= min && points <= max,
      `${context}: ${name} ${wire} outside ${min * 10}..${max * 10}`,
    );
    assertEquals(
      Math.round(points * perPoint) / perPoint,
      Number(points.toFixed(2)),
      `${context}: ${name} not quantised to 1/${perPoint}`,
    );
    assertEquals(wire, Number(wire.toFixed(1)), `${context}: ${name} carries float drift ${wire}`);
  }
  assert(row.best_score >= row.avg_score, `${context}: best < avg`);
}

Deno.test("ATTACK W06-02 progress boundary: every two-decimal view score maps to its exact 0-100 legacy value", async () => {
  const rows: Array<Record<string, unknown>> = [];
  for (let hundredths = 0; hundredths <= 1000; hundredths += 1) {
    const text = (hundredths / 100).toFixed(2);
    rows.push({
      day: `20${String(Math.floor(hundredths / 31)).padStart(2, "0")}-01-${
        String((hundredths % 28) + 1).padStart(2, "0")
      }`,
      shot_type: `t${hundredths}`,
      scoring_model_version: "v1",
      shot_count: 1,
      avg_score: Number(text),
      best_score: Number(text),
    });
  }
  // the harness stub does not honour PostgREST Range paging: keep each
  // request under one page (1 000 rows) so every row is served exactly once
  const served: SeriesRow[] = [];
  for (let start = 0; start < rows.length; start += 500) {
    const { status, body } = await progressFor(rows.slice(start, start + 500));
    assertEquals(status, 200);
    assertEquals(body.definitionVersion, SCORING_DEFINITION_VERSION);
    served.push(...body.series);
  }
  assertEquals(served.length, 1001);
  const drift: string[] = [];
  for (const row of served) {
    const hundredths = Number(row.shot_type.slice(1));
    const expectedWire = Number((hundredths / 10).toFixed(1));
    if (row.avg_score !== expectedWire || row.best_score !== expectedWire) {
      drift.push(
        `${
          (hundredths / 100).toFixed(2)
        } → ${row.avg_score}/${row.best_score} (want ${expectedWire})`,
      );
    }
    if (String(row.avg_score).length > 5) drift.push(`float drift ${row.avg_score}`);
  }
  assertEquals(drift, []);
});

Deno.test("ATTACK W06-02 progress boundary: empty account ⇒ tagged, honest-empty payload (no fabricated trends, zero streak)", async () => {
  const { status, body } = await progressFor([]);
  assertEquals(status, 200);
  assertEquals(body, {
    definitionVersion: SCORING_DEFINITION_VERSION,
    series: [],
    improving: [],
    needsAttention: [],
    streak: { currentDays: 0, longestDays: 0, practicedToday: false, lastPracticeDate: null },
  });
});

// `mustDrop`: the row has NO honest numeric reading (a null average is not
// a 0.0 average; "7.2x" is not a score) — serving it under the tag fabricates.
for (
  const [label, patch, mustDrop] of [
    ["avg_score null", { avg_score: null }, true],
    ["best_score null", { best_score: null }, true],
    ["shot_count null", { shot_count: null }, true],
    ["shot_count 0", { shot_count: 0 }, false],
    ["shot_count fractional", { shot_count: 2.5 }, false],
    ["avg_score text junk", { avg_score: "7.2x" }, true],
    ["legacy 0-100 row", { avg_score: 72.5, best_score: 81 }, false],
    ["negative score", { avg_score: -1.5, best_score: 0 }, false],
    ["score above scale", { avg_score: 10.01, best_score: 10.01 }, false],
    ["best below avg", { avg_score: 8, best_score: 2 }, false],
    ["three-decimal score", { avg_score: 7.255, best_score: 7.255 }, false],
    ["day null", { day: null }, true],
    ["shot_type null", { shot_type: null }, true],
    ["shot_type empty", { shot_type: "   " }, true],
    ["day far future", { day: "2999-12-31" }, false],
    ["day not a date", { day: "2026-13-45" }, true],
  ] as const
) {
  Deno.test(`ATTACK W06-02 progress corrupt row: ${label} ⇒ dropped, or the row is what the definition allows`, async () => {
    const { status, body } = await progressFor([{ ...ROW, ...patch }]);
    assertEquals(status, 200, label);
    assertEquals(body.definitionVersion, SCORING_DEFINITION_VERSION, label);
    if (mustDrop) {
      assertEquals(
        body.series,
        [],
        `${label}: a row with no honest reading must be dropped, got ${
          JSON.stringify(body.series)
        }`,
      );
    }
    for (const row of body.series) assertSeriesRowSatisfiesDefinition(row, label);
  });
}

Deno.test("ATTACK W06-02 progress corrupt rows: duplicate (day, shot_type, version) keys survive as two contradictory rows", async () => {
  const { body } = await progressFor([ROW, {
    ...ROW,
    avg_score: 2.5,
    best_score: 3,
    shot_count: 9,
  }]);
  const keys = body.series.map((r) => `${r.day}|${r.shot_type}|${r.scoring_model_version}`);
  assertEquals(new Set(keys).size, keys.length, "series keys must be unique");
});

Deno.test("ATTACK W06-02 progress: PostgREST returns a non-array body for progress_daily ⇒ no 500 crash, no tagged garbage", async () => {
  userSeq += 1;
  const userId = `fd000000-0000-4000-8000-${String(userSeq).padStart(12, "0")}`;
  h.reset();
  h.tables.profiles = [{ id: userId, email: `${userId}@example.com`, provider: "google" }];
  h.tables.shots = [];
  h.tables.progress_daily = [];
  h.tables.practice_days = [];
  h.respond = (call) =>
    call.url.includes("/rest/v1/progress_daily")
      ? new Response(JSON.stringify({ day: "2026-09-01" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
      : null;
  const response = await h.handler(
    userRequest("GET", "/v1/progress", {
      token: fakeGoogleIdToken(userId),
      ip: "198.51.190.250",
    }),
  );
  const text = await response.text();
  assert(response.status === 200 || response.status === 503, `status ${response.status}: ${text}`);
  if (response.status === 200) {
    const body = JSON.parse(text) as ProgressPayload;
    assertEquals(body.series, []);
    assertEquals(body.definitionVersion, SCORING_DEFINITION_VERSION);
  } else {
    assert(!text.includes("definitionVersion"));
  }
});

Deno.test("ATTACK W06-02 progress streak boundary: practice days in the future or malformed never inflate the streak", async () => {
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const { body } = await progressFor([], [
    today,
    yesterday,
    "2999-01-01",
    "not-a-day",
    "2026-02-30",
    today,
  ]);
  assertEquals(body.streak.practicedToday, true);
  assertEquals(body.streak.currentDays, 2);
  assertEquals(body.streak.longestDays, 2);
  assertEquals(body.streak.lastPracticeDate, today);
});
