/**
 * W06-03 ADVERSARIAL — SQL rank plane vs the shared TS definition, beyond the
 * golden fixture. Attacks candidate 0dc89d1c (definition_version stamping):
 *
 *   A1  differential fuzz: seeded random histories INSIDE the input domain
 *       (ties on the stored instant, 1-9 fraction digits, >2-decimal scores,
 *       replayed ids, mixed-case ids, abstentions, window overflow) inserted in
 *       arrival order — SQL (player_rank_state + player_technique_rating) must
 *       reproduce computePlayerRank bit for bit, definition_version included;
 *   A2  concurrency: two owner-path writers of the SAME user whose transactions
 *       overlap — the saved row must equal a recompute over the committed rows
 *       (a lost update leaves a v2-labelled row that v2 does not reproduce);
 *   A3  boundary: microsecond half-even rounding at the .5 µs tie and the
 *       2100-01-01 exclusive bound through both planes.
 *
 * Postgres setup: as w06_01_golden_parity.test.ts (shim + every migration),
 * then run with PICKLE_AUDIT_PG_URL set; the SQL tests are skipped (NOT a
 * pass) without it.
 */
import postgres from "postgres";
import { assertEquals } from "@std/assert";
import {
  computePlayerRank,
  type PlayerRankAnalysisInput,
  type PlayerRankSummary,
} from "../../../../packages/shared-types/src/playerRank.ts";
import { SCORING_DEFINITION_VERSION } from "../../../../packages/shared-types/src/scoringDefinition.ts";

const PG_URL = Deno.env.get("PICKLE_AUDIT_PG_URL") ?? "";
const ignore = PG_URL === "";

type Sql = ReturnType<typeof postgres>;

async function withRollback(sql: Sql, fn: (tx: Sql) => Promise<void>): Promise<void> {
  try {
    await sql.begin(async (tx) => {
      await fn(tx as unknown as Sql);
      throw new Error("__rollback__");
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "__rollback__") throw error;
  }
}

interface Analysis extends PlayerRankAnalysisInput {
  id: string;
}

const INSERT_SHOT = `insert into public.shots
   (id, user_id, shot_type, camera_view, captured_at, start_ms, contact_ms, end_ms,
    overall_score, analysis_confidence, result_kind, source,
    app_version, model_bundle_version, pose_model_version, paddle_model_version,
    stroke_detector_version, phase_model_version, scoring_model_version, shot_config_version)
 values ($1, $2, $3, 'side', $4::text::timestamptz, 0, 100, 200, $5::numeric, 0.9, $6, 'real',
         '1', '1', '1', '1', '1', '1', '1', '1')`;

/** Owner-path insert with score + timestamp bound as their JSON text (what
 * the sync payload carries). Returns the refusing constraint or null. */
async function insertAnalysis(tx: Sql, userId: string, a: Analysis): Promise<string | null> {
  await tx.unsafe(`savepoint row_insert`);
  try {
    await tx.unsafe(INSERT_SHOT, [
      a.id,
      userId,
      a.shotType,
      a.capturedAt,
      a.overallScore === null ? null : String(a.overallScore),
      a.resultKind,
    ]);
    await tx.unsafe(`release savepoint row_insert`);
    return null;
  } catch (error) {
    await tx.unsafe(`rollback to savepoint row_insert`);
    const message = error instanceof Error ? error.message : String(error);
    return /constraint "([^"]+)"/.exec(message)?.[1] ?? message;
  }
}

async function newUser(tx: Sql): Promise<string> {
  const userId = crypto.randomUUID();
  await tx.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
    userId,
    `${userId}@example.com`,
  ]);
  return userId;
}

interface SqlProjection {
  definitionVersion: string;
  rating: number;
  tier: string;
  techniqueCount: number;
  scoredAnalysisCount: number;
  techniques: Array<{
    shotType: string;
    score: number;
    capturedAtMicros: string;
    sampledCount: number;
    confidenceWeight: number;
    definitionVersion: string;
  }>;
}

async function readSql(tx: Sql, userId: string): Promise<SqlProjection | null> {
  const state = await tx.unsafe(
    `select rating::text as rating, tier, technique_count, scored_shot_count, definition_version
       from public.player_rank_state where user_id = $1`,
    [userId],
  );
  const view = await tx.unsafe(
    `select shot_type, score::text as score,
            (extract(epoch from captured_at) * 1000000)::numeric(20,0)::text as captured_at_micros,
            sampled_count, confidence_weight, definition_version
       from public.player_technique_rating t where user_id = $1
       order by t.score desc, t.shot_type collate "C" asc`,
    [userId],
  );
  if (state.length === 0) {
    assertEquals(view.length, 0, "technique rows without saved rank state");
    return null;
  }
  return {
    definitionVersion: String(state[0].definition_version),
    rating: Number(state[0].rating),
    tier: String(state[0].tier),
    techniqueCount: Number(state[0].technique_count),
    scoredAnalysisCount: Number(state[0].scored_shot_count),
    techniques: view.map((row) => ({
      shotType: String(row.shot_type),
      score: Number(row.score),
      capturedAtMicros: String(row.captured_at_micros),
      sampledCount: Number(row.sampled_count),
      confidenceWeight: Number(row.confidence_weight),
      definitionVersion: String(row.definition_version),
    })),
  };
}

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

function roundHalfEven(value: number): number {
  const floor = Math.floor(value);
  const remainder = value - floor;
  if (remainder < 0.5) return floor;
  if (remainder > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** The stored (timestamptz) instant of an admitted capturedAt text, in
 * microseconds — the definition's `countability.capturedAt.stored`. */
function storedMicros(text: string): string {
  const m = ISO_RE.exec(text);
  if (!m) throw new Error(`not an instant: ${text}`);
  const seconds = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
  const fraction = m[7] === undefined ? 0 : roundHalfEven(Number(`0.${m[7]}`) * 1e6);
  return String(BigInt(seconds) * 1_000_000n + BigInt(fraction));
}

function tsProjection(summary: PlayerRankSummary | null): SqlProjection | null {
  if (summary === null) return null;
  return {
    definitionVersion: summary.definitionVersion ?? "(absent)",
    rating: summary.rating,
    tier: summary.tier,
    techniqueCount: summary.techniqueCount,
    scoredAnalysisCount: summary.scoredAnalysisCount,
    techniques: summary.techniques.map((t) => ({
      shotType: t.shotType,
      score: t.score,
      capturedAtMicros: storedMicros(t.capturedAt),
      sampledCount: t.sampledCount ?? -1,
      // total analyses == sampledCount below the window; capped at 5 either way
      confidenceWeight: Math.min(t.sampledCount ?? -1, 5),
      definitionVersion: SCORING_DEFINITION_VERSION,
    })),
  };
}

// ─── seeded generator (mulberry32) ───────────────────────────────────────────

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, items: readonly T[]): T {
  return items[Math.floor(r() * items.length)]!;
}

function uuidFrom(r: () => number): string {
  const hex = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 32; i += 1) s += hex[Math.floor(r() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${
    s.slice(20)
  }`;
}

const SHOT_TYPES = ["dink", "serve", "drive", "Dink", "third_shot_drop", "volley", "lob", "üñí"];

const SCORE_TEXTS = [
  "0",
  "10",
  "7",
  "6.5",
  "6.55",
  "6.005",
  "6.004999",
  "6.0050001",
  "9.995",
  "9.994",
  "0.005",
  "0.004",
  "5.555555555555555",
  "3.3333333333333335",
  "4.125",
  "4.135",
  "4.145",
  "1e-7",
  "7.999999999",
  "2.675",
  "8.885",
];

function randomScoreText(r: () => number): string {
  if (r() < 0.6) return pick(r, SCORE_TEXTS);
  const decimals = Math.floor(r() * 5);
  const value = r() * 10;
  return value.toFixed(decimals);
}

const BASE_SECONDS = Date.UTC(2026, 0, 1) / 1000;

function isoAt(seconds: number, fraction: string): string {
  const d = new Date(seconds * 1000).toISOString().slice(0, 19);
  return fraction === "" ? `${d}Z` : `${d}.${fraction}Z`;
}

/** Fraction texts that collide or nearly collide on the stored microsecond. */
const FRACTION_FAMILIES: readonly (readonly string[])[] = [
  ["", "0", "000", "000000", "0000000", "00000000", "000000000"],
  ["5", "50", "500", "500000", "5000000", "499999999"],
  ["1234565", "123456", "12345649", "123456500"],
  ["0000005", "000000", "0000004", "00000049"],
  ["0000015", "000002", "0000025"],
  ["9999995", "9999994", "999999", "99999949"],
  ["123", "1230", "12300", "123000"],
  ["7", "70", "700", "7000000", "699999999"],
];

interface Timeline {
  seconds: number[];
}

function randomCapturedAt(r: () => number, timeline: Timeline): string {
  let seconds: number;
  if (timeline.seconds.length > 0 && r() < 0.45) {
    seconds = pick(r, timeline.seconds);
  } else {
    seconds = BASE_SECONDS + Math.floor(r() * 3_000_000);
    timeline.seconds.push(seconds);
  }
  const family = pick(r, FRACTION_FAMILIES);
  return isoAt(
    seconds,
    r() < 0.15 ? String(Math.floor(r() * 1e9)).padStart(9, "0") : pick(r, family),
  );
}

function randomHistory(r: () => number, size: number): Analysis[] {
  const timeline: Timeline = { seconds: [] };
  const rows: Analysis[] = [];
  for (let i = 0; i < size; i += 1) {
    let id = uuidFrom(r);
    if (rows.length > 0 && r() < 0.12) {
      const prior = pick(r, rows).id;
      id = r() < 0.5 ? prior : prior.toUpperCase();
    }
    const abstain = r() < 0.15;
    const shotType = r() < 0.7 ? pick(r, SHOT_TYPES.slice(0, 3)) : pick(r, SHOT_TYPES);
    rows.push({
      id,
      shotType,
      capturedAt: randomCapturedAt(r, timeline),
      resultKind: abstain ? "low_confidence" : "scored",
      overallScore: abstain ? null : Number(randomScoreText(r)),
      source: "real",
    });
  }
  return rows;
}

// ─── A1: differential fuzz ───────────────────────────────────────────────────

Deno.test({
  name: "W06-03 attack A1: seeded in-domain histories reproduce bit-for-bit on the SQL plane",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const problems: string[] = [];
    const seeds = 1500;
    try {
      for (let seed = 1; seed <= seeds; seed += 1) {
        const r = rng(seed * 7919);
        const history = randomHistory(r, 1 + Math.floor(r() * 30));
        await withRollback(sql, async (tx) => {
          const userId = await newUser(tx);
          const refused: string[] = [];
          for (const a of history) {
            const outcome = await insertAnalysis(tx, userId, a);
            if (outcome !== null && outcome !== "shots_pkey") {
              refused.push(`${a.id}@${a.capturedAt}=${a.overallScore}: ${outcome}`);
            }
          }
          const expected = tsProjection(computePlayerRank(history));
          const actual = await readSql(tx, userId);
          const same = JSON.stringify(expected) === JSON.stringify(actual);
          if (!same || refused.length > 0) {
            problems.push(
              [
                `seed ${seed}:`,
                ...refused.map((x) => `  in-domain row refused: ${x}`),
                `  history:  ${JSON.stringify(history)}`,
                `  expected: ${JSON.stringify(expected)}`,
                `  sql:      ${JSON.stringify(actual)}`,
              ].join("\n"),
            );
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(problems, [], `SQL diverged from computePlayerRank:\n${problems.join("\n")}`);
  },
});

// ─── A3: instant boundaries through both planes ──────────────────────────────

Deno.test({
  name: "W06-03 attack A3: microsecond ties and the 2100 exclusive bound agree across planes",
  ignore,
  async fn() {
    const sql = postgres(PG_URL);
    const problems: string[] = [];
    const cases: Analysis[][] = [
      // .5 µs half-even ties: 0000005 → 0 µs (even), 0000015 → 2 µs; the id
      // decides the order for the exact tie, the 2 µs row is newest.
      [
        {
          id: "0a000000-0000-4000-8000-000000000001",
          shotType: "dink",
          capturedAt: "2026-03-01T00:00:00.0000005Z",
          resultKind: "scored",
          overallScore: 2,
          source: "real",
        },
        {
          id: "0a000000-0000-4000-8000-000000000002",
          shotType: "dink",
          capturedAt: "2026-03-01T00:00:00.000000Z",
          resultKind: "scored",
          overallScore: 4,
          source: "real",
        },
        {
          id: "0a000000-0000-4000-8000-000000000000",
          shotType: "dink",
          capturedAt: "2026-03-01T00:00:00.0000015Z",
          resultKind: "scored",
          overallScore: 9,
          source: "real",
        },
        {
          id: "0a000000-0000-4000-8000-000000000003",
          shotType: "dink",
          capturedAt: "2026-03-01T00:00:00.0000025Z",
          resultKind: "scored",
          overallScore: 6,
          source: "real",
        },
      ],
      // Rounds up into the excluded 2100 bound on the SQL plane; the
      // millisecond plane sees 2099. Every plane must abstain.
      [
        {
          id: "0b000000-0000-4000-8000-000000000001",
          shotType: "serve",
          capturedAt: "2099-12-31T23:59:59.9999995Z",
          resultKind: "scored",
          overallScore: 8,
          source: "real",
        },
        {
          id: "0b000000-0000-4000-8000-000000000002",
          shotType: "serve",
          capturedAt: "2099-12-31T23:59:59.9999994Z",
          resultKind: "scored",
          overallScore: 3,
          source: "real",
        },
      ],
      // Lower bound: 1999-12-31T23:59:59.9999995Z stores as 2000-01-01 but the
      // Edge plane refuses it — TS abstains; the SQL owner path would store it.
      [
        {
          id: "0c000000-0000-4000-8000-000000000001",
          shotType: "drive",
          capturedAt: "2000-01-01T00:00:00.000000Z",
          resultKind: "scored",
          overallScore: 5,
          source: "real",
        },
        {
          id: "0c000000-0000-4000-8000-000000000002",
          shotType: "drive",
          capturedAt: "2000-01-01T00:00:00Z",
          resultKind: "scored",
          overallScore: 7,
          source: "real",
        },
      ],
    ];
    try {
      for (const history of cases) {
        await withRollback(sql, async (tx) => {
          const userId = await newUser(tx);
          const refused: string[] = [];
          for (const a of history) {
            const outcome = await insertAnalysis(tx, userId, a);
            if (outcome !== null) refused.push(`${a.id}: ${outcome}`);
          }
          const expected = tsProjection(computePlayerRank(history));
          const actual = await readSql(tx, userId);
          if (JSON.stringify(expected) !== JSON.stringify(actual)) {
            problems.push(
              `${history[0]!.id}: refused=${JSON.stringify(refused)}\n  expected ${
                JSON.stringify(expected)
              }\n  sql      ${JSON.stringify(actual)}`,
            );
          }
        });
      }
    } finally {
      await sql.end();
    }
    assertEquals(problems, [], problems.join("\n"));
  },
});

// ─── A2: overlapping owner-path writers of one user ──────────────────────────

Deno.test({
  name:
    "W06-03 attack A2: overlapping writers leave a saved row v2 reproduces from the committed rows",
  ignore,
  async fn() {
    const sql = postgres(PG_URL, { max: 3 });
    const userId = crypto.randomUUID();
    await sql.unsafe(`insert into auth.users (id, email) values ($1, $2)`, [
      userId,
      `${userId}@example.com`,
    ]);
    const rows: Analysis[] = [
      {
        id: "0d000000-0000-4000-8000-000000000001",
        shotType: "dink",
        capturedAt: "2026-01-01T00:00:00Z",
        resultKind: "scored",
        overallScore: 4,
        source: "real",
      },
      {
        id: "0d000000-0000-4000-8000-000000000002",
        shotType: "serve",
        capturedAt: "2026-01-02T00:00:00Z",
        resultKind: "scored",
        overallScore: 8,
        source: "real",
      },
    ];
    try {
      const a = await sql.reserve();
      const b = await sql.reserve();
      try {
        await a.unsafe(`begin`);
        await a.unsafe(INSERT_SHOT, [
          rows[0]!.id,
          userId,
          "dink",
          rows[0]!.capturedAt,
          "4",
          "scored",
        ]);
        // b's statement runs its AFTER trigger against a snapshot without a's
        // row, then waits on a's player_rank_state lock.
        const pending = b
          .unsafe(INSERT_SHOT, [rows[1]!.id, userId, "serve", rows[1]!.capturedAt, "8", "scored"])
          .execute();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await a.unsafe(`commit`);
        await pending;
      } finally {
        a.release();
        b.release();
      }
      const stored = await sql.unsafe(
        `select count(*)::int as n from public.shots where user_id = $1`,
        [userId],
      );
      assertEquals(Number(stored[0].n), 2, "both rows committed");
      const saved = await readSql(sql as unknown as Sql, userId);
      const expected = tsProjection(computePlayerRank(rows));
      assertEquals(
        saved,
        expected,
        "saved player_rank_state after two overlapping commits must equal the v2 recompute of the committed rows",
      );
    } finally {
      await sql.unsafe(`delete from auth.users where id = $1`, [userId]);
      await sql.end();
    }
  },
});
