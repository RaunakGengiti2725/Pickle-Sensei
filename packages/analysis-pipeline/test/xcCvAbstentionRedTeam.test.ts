/**
 * CV failure-detection / abstention red team (role `cv-failure-detection-abstention`).
 *
 * Feeds no-player, far-camera, occluded, multi-player and synthetic-garbage
 * pose inputs through the production fusion path (see
 * ./xcCvAbstention/harness.ts) and writes replayable evidence:
 *
 *   artifacts/xc-cv-abstention/rows.json         every row (inputs → outcome)
 *   artifacts/xc-cv-abstention/matrix.json       family × outcome matrix
 *   artifacts/xc-cv-abstention/confident-wrong.json  rows that scored
 *                                                 despite carrying no honest evidence
 *   artifacts/xc-cv-abstention/summary.json      counts, heap, timing, seeds
 *
 * Scale: XC_CV_SEEDS seeds per seeded family (default 40 → ~1k fusion runs).
 * Replay one row: `XC_CV_ONLY=<fixture id> npx vitest run test/xcCvAbstentionRedTeam.test.ts`.
 *
 * Assertions pin what the pipeline provably does today (including that the
 * library capture-quality gate is enforced inside analyzeCapture itself); the
 * harness rows document any remaining adversarial gaps as findings (never as
 * passing tests).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { allSyntheticFixtures, type Fixture } from "./xcCvAbstention/fixtures.js";
import {
  codeHistogram,
  familyMatrix,
  runFixture,
  type RowResult,
} from "./xcCvAbstention/harness.js";
import { realMultiPersonFixtures } from "./xcCvAbstention/realTracks.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const OUT_DIR = resolve(REPO_ROOT, "artifacts/xc-cv-abstention");
const SEEDS = Number(process.env.XC_CV_SEEDS ?? "40");
const ONLY = process.env.XC_CV_ONLY ?? null;

function fixtures(): Fixture[] {
  const all = [...allSyntheticFixtures(SEEDS), ...realMultiPersonFixtures(REPO_ROOT)];
  return ONLY ? all.filter((fixture) => fixture.id === ONLY) : all;
}

async function runAll(): Promise<{
  rows: RowResult[];
  heap: Record<string, number>;
  wallMs: number;
}> {
  const before = process.memoryUsage();
  const started = Date.now();
  const rows: RowResult[] = [];
  for (const fixture of fixtures()) rows.push(await runFixture(fixture));
  const after = process.memoryUsage();
  return {
    rows,
    heap: {
      heapUsedBeforeBytes: before.heapUsed,
      heapUsedAfterBytes: after.heapUsed,
      rssAfterBytes: after.rss,
      externalAfterBytes: after.external,
    },
    wallMs: Date.now() - started,
  };
}

/**
 * Every synthetic non-control fixture is a corruption of the SAME truth swing
 * as `ctrl-default-forehand`, so its true technique is known: the control's
 * score. A scored corrupted row therefore has a measurable error
 * (|score − control|, per checkpoint too) AND a reported confidence — the
 * pair is the "confident-wrong" evidence.
 */
function deviationMatrix(rows: RowResult[]): {
  controlScore: number | null;
  perRow: Array<{
    id: string;
    family: string;
    score: number;
    scoreDelta: number;
    analysisConfidence: number | null;
    worstCheckpoint: string | null;
    worstCheckpointDelta: number;
  }>;
  perFamilyCheckpoint: Record<
    string,
    Record<string, { n: number; meanAbsDelta: number; maxAbsDelta: number }>
  >;
  confidenceByFamily: Record<string, { scoredRows: number; distinctConfidences: number[] }>;
} {
  const control = rows.find((row) => row.id === "ctrl-default-forehand");
  const controlScore = control?.overallScore ?? null;
  const perRow: ReturnType<typeof deviationMatrix>["perRow"] = [];
  const perFamilyCheckpoint: ReturnType<typeof deviationMatrix>["perFamilyCheckpoint"] = {};
  const confidenceByFamily: ReturnType<typeof deviationMatrix>["confidenceByFamily"] = {};
  for (const row of rows) {
    if (row.overallScore === null) continue;
    const conf = confidenceByFamily[row.family] ?? { scoredRows: 0, distinctConfidences: [] };
    conf.scoredRows += 1;
    const rounded =
      row.analysisConfidence === null ? null : Math.round(row.analysisConfidence * 1000) / 1000;
    if (rounded !== null && !conf.distinctConfidences.includes(rounded))
      conf.distinctConfidences.push(rounded);
    confidenceByFamily[row.family] = conf;
    if (
      control === undefined ||
      controlScore === null ||
      row.id.startsWith("mp-real-") ||
      row.family === "control"
    )
      continue;
    let worstCheckpoint: string | null = null;
    let worstCheckpointDelta = 0;
    const familyEntry = perFamilyCheckpoint[row.family] ?? {};
    for (const [key, score] of Object.entries(row.checkpointScores)) {
      const truth = control.checkpointScores[key];
      if (score === null || truth === null || truth === undefined) continue;
      const delta = Math.abs(score - truth);
      const cell = familyEntry[key] ?? { n: 0, meanAbsDelta: 0, maxAbsDelta: 0 };
      cell.meanAbsDelta = (cell.meanAbsDelta * cell.n + delta) / (cell.n + 1);
      cell.n += 1;
      cell.maxAbsDelta = Math.max(cell.maxAbsDelta, delta);
      familyEntry[key] = cell;
      if (delta > worstCheckpointDelta) {
        worstCheckpointDelta = delta;
        worstCheckpoint = key;
      }
    }
    perFamilyCheckpoint[row.family] = familyEntry;
    perRow.push({
      id: row.id,
      family: row.family,
      score: row.overallScore,
      scoreDelta: row.overallScore - controlScore,
      analysisConfidence: row.analysisConfidence,
      worstCheckpoint,
      worstCheckpointDelta,
    });
  }
  for (const conf of Object.values(confidenceByFamily))
    conf.distinctConfidences.sort((a, b) => a - b);
  return { controlScore, perRow, perFamilyCheckpoint, confidenceByFamily };
}

/** sway amplitude × sway period → how many idle (no-stroke) rows scored. */
function swayMatrix(rows: RowResult[]): Array<{
  swayAmplitude: number;
  periodMs: number;
  rows: number;
  scored: number;
  scoredIds: string[];
  scores: number[];
}> {
  const cells = new Map<
    string,
    {
      swayAmplitude: number;
      periodMs: number;
      rows: number;
      scored: number;
      scoredIds: string[];
      scores: number[];
    }
  >();
  for (const row of rows) {
    if (!row.id.startsWith("np-idle-sway-")) continue;
    const swayAmplitude = Number(row.params.swayAmplitude);
    const periodMs = Number(row.params.periodMs);
    const key = `${swayAmplitude}|${periodMs}`;
    const cell = cells.get(key) ?? {
      swayAmplitude,
      periodMs,
      rows: 0,
      scored: 0,
      scoredIds: [],
      scores: [],
    };
    cell.rows += 1;
    if (row.overallScore !== null) {
      cell.scored += 1;
      cell.scoredIds.push(row.id);
      cell.scores.push(row.overallScore);
    }
    cells.set(key, cell);
  }
  return [...cells.values()];
}

function writeArtifacts(rows: RowResult[], heap: Record<string, number>, wallMs: number): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const matrix = familyMatrix(rows);
  const confidentWrong = rows.filter(
    (row) => row.verdict === "confident_wrong" || row.verdict === "lower_confidence_wrong",
  );
  const controlFailed = rows.filter((row) => row.verdict === "control_failed");
  const deviation = deviationMatrix(rows);
  writeFileSync(resolve(OUT_DIR, "deviation-vs-control.json"), JSON.stringify(deviation, null, 2));
  const summary = {
    generatedAtIso: new Date().toISOString(),
    seedsPerFamily: SEEDS,
    only: ONLY,
    rows: rows.length,
    wallMs,
    heap,
    matrix,
    codeHistogram: codeHistogram(rows),
    controlScore: deviation.controlScore,
    confidenceByFamily: deviation.confidenceByFamily,
    confidentWrongIds: confidentWrong.map((row) => row.id),
    controlFailedIds: controlFailed.map((row) => row.id),
    provenance: {
      synthetic:
        "all non `mp-real-*` rows are synthetic (SYNTHETIC_PRODUCER); none are Apple Vision observations",
      real: "`mp-real-*` rows are single tracks cut from committed apple-vision-bodypose-1 all-person sidecars (datasets/paddle-bench/runs-wave-a)",
      planes:
        "Linux only — parse + fusion (TypeScript). Capture envelope, Apple Vision, Swift, iOS runtime NOT exercised.",
    },
  };
  writeFileSync(resolve(OUT_DIR, "sway-matrix.json"), JSON.stringify(swayMatrix(rows), null, 2));
  writeFileSync(resolve(OUT_DIR, "rows.json"), JSON.stringify(rows, null, 2));
  writeFileSync(resolve(OUT_DIR, "matrix.json"), JSON.stringify(matrix, null, 2));
  writeFileSync(resolve(OUT_DIR, "confident-wrong.json"), JSON.stringify(confidentWrong, null, 2));
  writeFileSync(resolve(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  const lines = [
    `family\trows\trej_parse\trej_fusion\tabstain\tscored_lower\tscored_normal\tconfident_wrong\tlower_conf_wrong\tcontrol_failed`,
    ...matrix.map(
      (m) =>
        `${m.family}\t${m.rows}\t${m.rejected_parse}\t${m.rejected_fusion}\t${m.abstained}\t${m.scored_lower_confidence}\t${m.scored_normal}\t${m.confident_wrong}\t${m.lower_confidence_wrong}\t${m.control_failed}`,
    ),
  ];
  writeFileSync(resolve(OUT_DIR, "matrix.tsv"), `${lines.join("\n")}\n`);
}

describe("CV failure detection & abstention red team (Linux replay of the fusion path)", () => {
  it("runs every fixture family and writes replayable evidence", { timeout: 600_000 }, async () => {
    const { rows, heap, wallMs } = await runAll();
    writeArtifacts(rows, heap, wallMs);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      // Every row is replayable: id, params and (when seeded) the seed.
      expect(typeof row.id).toBe("string");
      expect(row.params).toBeDefined();
    }
  });

  it("control swings still score (the harness is not vacuous)", async () => {
    const controls = fixtures().filter((fixture) => fixture.family === "control");
    if (controls.length === 0) return; // XC_CV_ONLY replay of a non-control row
    for (const fixture of controls) {
      const row = await runFixture(fixture);
      expect(row.verdict, `${row.id}: ${row.failureCode ?? row.outcome}`).toBe("control_ok");
    }
  });

  it(
    "a pose sequence the library capture-quality gate rejects never produces a numeric score",
    { timeout: 600_000 },
    async () => {
      // analyzeCapture must refuse (typed low_confidence abstention with
      // guidance) every sequence whose own evaluateCaptureQuality report says
      // analyzable=false — far/tiny, too close/cropped, low fps, partial body,
      // dropout gaps, low confidence — regardless of which caller reaches it.
      const gated: RowResult[] = [];
      for (const fixture of fixtures()) {
        const row = await runFixture(fixture);
        if (!row.libraryQuality.analyzable) gated.push(row);
      }
      if (!ONLY) expect(gated.length).toBeGreaterThan(0);
      for (const row of gated) {
        expect(
          row.overallScore,
          `${row.id} [${row.libraryQuality.reasons.join(",")}] scored ${row.overallScore} (${row.presentation})`,
        ).toBeNull();
        expect(row.verdict).not.toBe("confident_wrong");
        expect(row.verdict).not.toBe("lower_confidence_wrong");
      }
    },
  );

  it("empty / too-short / motionless / low-visibility no-player inputs never produce a numeric score", async () => {
    // The seeded idle-sway sweep (`np-idle-sway-*`) is deliberately NOT
    // pinned: it measures the false-stroke rate (see sway-matrix.json).
    const family = fixtures().filter(
      (fixture) => fixture.family === "no_player" && !fixture.id.startsWith("np-idle-sway-"),
    );
    if (family.length === 0) return;
    for (const fixture of family) {
      const row = await runFixture(fixture);
      expect(
        row.overallScore,
        `${row.id} scored ${row.overallScore} (${row.presentation})`,
      ).toBeNull();
    }
  });

  it("garbage geometry (uniform random / collapsed / random walk) never produces a numeric score", async () => {
    const family = fixtures().filter(
      (fixture) =>
        fixture.family === "garbage" &&
        (fixture.id.startsWith("gb-uniform-random") ||
          fixture.id.startsWith("gb-random-walk") ||
          fixture.id === "gb-collapsed-point"),
    );
    if (family.length === 0) return;
    for (const fixture of family) {
      const row = await runFixture(fixture);
      expect(
        row.overallScore,
        `${row.id} scored ${row.overallScore} (${row.presentation})`,
      ).toBeNull();
    }
  });

  it("a perfectly motionless bystander lock never produces a numeric score", async () => {
    // Only the noise-free lock is pinned: the seeded swaying bystanders
    // (`mp-bystander-swaying-s*`, 1% sway + 1px jitter, no stroke) DO score
    // for some seeds — see rows.json / findings; the relative 2×-median peak
    // test in GeometricPhaseSegmenter has no absolute speed floor.
    const family = fixtures().filter((fixture) => fixture.id === "mp-bystander-lock");
    if (family.length === 0) return;
    for (const fixture of family) {
      const row = await runFixture(fixture);
      expect(
        row.overallScore,
        `${row.id} scored ${row.overallScore} (${row.presentation})`,
      ).toBeNull();
    }
  });
});
