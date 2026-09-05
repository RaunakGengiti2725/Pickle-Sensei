/**
 * XC-CV-1 companion to `xcCvAbstentionRedTeam.test.ts`.
 *
 * The red-team harness calls `analyzeCapture` directly, i.e. it starts BELOW
 * the point where the shipping path (`apps/mobile/src/analysis/
 * runCaptureAnalysis.ts`) decides the pose-quality gate:
 *
 *   evaluatePreAnalysisGate({ frame: null, pose, poseQuality:
 *     evaluateCaptureQuality(pose), stroke: <trigger window> })
 *   → !analyzable ⇒ permit released, `quality_blocked`, analyzeCapture never
 *     runs.
 *
 * This file replays the same fixture matrix through that exact composition
 * (production `evaluateCaptureQuality` + production `evaluatePreAnalysisGate`
 * with the mobile arguments) and pins the two properties the finding demands:
 *
 *  1. no row the library marks `analyzable === false` gets past the gate — so
 *     `far_camera` (too small / too close), `insufficient_fps`,
 *     `body_not_fully_visible`, `tracking_dropout_gap`, `low_confidence` can
 *     never reach a numeric score on the shipping path;
 *  2. the control family (valid swings) is NOT over-abstained: every control
 *     row passes the gate and, through the production provider bundle, still
 *     scores normally at the pinned control score.
 *
 * Linux replay proxy — pose sequences are synthetic; this is not Apple device
 * truth. Wiring of the gate INTO `runCaptureAnalysis` itself is pinned by the
 * mobile Jest suites (`captureAnalysisFlow.test.ts`,
 * `importedCaptureAnalysis.test.ts`, `xc/adjudication/*`).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parsePoseSequence, serializePoseSequence } from "@pickle/swing-domain";
import { evaluateCaptureQuality } from "@pickle/vision-geometry";
import { describe, expect, it } from "vitest";
import { evaluatePreAnalysisGate } from "../src/index.js";
import { allSyntheticFixtures, type Fixture } from "./xcCvAbstention/fixtures.js";
import { runFixture } from "./xcCvAbstention/harness.js";
import { realMultiPersonFixtures } from "./xcCvAbstention/realTracks.js";

const REPO_ROOT = resolve(__dirname, "../../..");
const OUT_DIR = resolve(REPO_ROOT, "artifacts/xc-cv-abstention");
const SEEDS = Number(process.env.XC_CV_SEEDS ?? "40");
const CONTROL_SCORE = 9.7;

interface GateRow {
  id: string;
  family: Fixture["family"];
  expected: Fixture["expected"];
  libraryAnalyzable: boolean;
  libraryReasons: string[];
  gateAnalyzable: boolean;
  gateReasons: string[];
}

/** Exactly the shipping composition in runCaptureAnalysis (live-capture
 * branch: the trigger window is the stroke window). */
function shippingGate(fixture: Fixture): GateRow {
  const parsed = parsePoseSequence(serializePoseSequence(fixture.sequence), {
    providerId: fixture.sequence.producedBy.providerId,
    runtime: fixture.sequence.producedBy.runtime,
    executionTarget: fixture.sequence.producedBy.executionTarget,
    artifactHash: fixture.sequence.producedBy.artifactHash,
  });
  const library = evaluateCaptureQuality(fixture.sequence);
  if (!parsed.ok) {
    // The sidecar reader refuses first (stage `sidecar_parse` in the
    // red-team harness) — nothing reaches the gate, nothing is scored.
    return {
      id: fixture.id,
      family: fixture.family,
      expected: fixture.expected,
      libraryAnalyzable: library.analyzable,
      libraryReasons: [...library.reasons],
      gateAnalyzable: false,
      gateReasons: [`sidecar_parse:${parsed.failure.code}`],
    };
  }
  const gate = evaluatePreAnalysisGate({
    frame: null,
    pose: parsed.value,
    poseQuality: evaluateCaptureQuality(parsed.value),
    stroke: {
      windowStartMs: fixture.trigger.startMs,
      windowEndMs: fixture.trigger.endMs,
    },
  });
  return {
    id: fixture.id,
    family: fixture.family,
    expected: fixture.expected,
    libraryAnalyzable: library.analyzable,
    libraryReasons: [...library.reasons],
    gateAnalyzable: gate.analyzable,
    gateReasons: [...gate.reasons],
  };
}

describe("XC-CV-1: shipping-path pose-quality gate over the red-team matrix", () => {
  const fixtures = [...allSyntheticFixtures(SEEDS), ...realMultiPersonFixtures(REPO_ROOT)];
  const rows = fixtures.map(shippingGate);

  it("every row the library marks analyzable=false is refused by the gate before analyzeCapture", () => {
    const leaked = rows.filter((row) => !row.libraryAnalyzable && row.gateAnalyzable);
    expect(rows.length).toBeGreaterThan(100);
    expect(leaked.map((row) => `${row.id} ${row.libraryReasons.join(",")}`)).toEqual([]);
  });

  it("far_camera family: 0 rows pass the gate (player_too_small_in_frame / player_too_close_or_cropped)", () => {
    const far = rows.filter((row) => row.family === "far_camera");
    expect(far.length).toBeGreaterThan(0);
    expect(far.filter((row) => row.gateAnalyzable)).toHaveLength(0);
    for (const row of far) {
      expect(row.gateReasons.length).toBeGreaterThan(0);
    }
  });

  it("every library reason the finding names is refused by the gate wherever it occurs", () => {
    const named = [
      "player_too_small_in_frame",
      "player_too_close_or_cropped",
      "insufficient_fps",
      "body_not_fully_visible",
      "tracking_dropout_gap",
      "low_confidence",
    ];
    const covered = named.filter((reason) =>
      rows.some((row) => row.libraryReasons.includes(reason)),
    );
    // The matrix must actually exercise the scale, fps and visibility
    // reasons (otherwise this test is vacuous).
    expect(covered).toEqual(
      expect.arrayContaining([
        "player_too_small_in_frame",
        "player_too_close_or_cropped",
        "insufficient_fps",
        "body_not_fully_visible",
      ]),
    );
    for (const reason of covered) {
      const hits = rows.filter((row) => row.libraryReasons.includes(reason));
      expect(
        hits.filter((row) => row.gateAnalyzable),
        reason,
      ).toHaveLength(0);
    }
  });

  it("control family is not over-abstained: every control row passes the gate and still scores normally", async () => {
    const control = fixtures.filter((fixture) => fixture.family === "control");
    expect(control).toHaveLength(12);
    for (const fixture of control) {
      expect(shippingGate(fixture).gateAnalyzable, fixture.id).toBe(true);
      const row = await runFixture(fixture);
      expect(row.outcome, fixture.id).toBe("scored_normal");
      if (fixture.id === "ctrl-default-forehand") {
        // The truth swing every corruption is derived from: the pinned
        // control score the red-team deviation matrix is measured against.
        expect(row.overallScore, fixture.id).toBe(CONTROL_SCORE);
      } else {
        // 1px-jitter controls land within one tenth of the truth swing.
        expect(row.overallScore, fixture.id).not.toBeNull();
        expect(Math.abs((row.overallScore ?? 0) - CONTROL_SCORE), fixture.id).toBeLessThan(
          0.1 + 1e-9,
        );
      }
    }
  });

  it("writes the shipping-gate matrix artifact", () => {
    mkdirSync(OUT_DIR, { recursive: true });
    const matrix: Record<string, { rows: number; gate_refused: number; gate_passed: number }> = {};
    for (const row of rows) {
      const entry = (matrix[row.family] ??= { rows: 0, gate_refused: 0, gate_passed: 0 });
      entry.rows += 1;
      if (row.gateAnalyzable) entry.gate_passed += 1;
      else entry.gate_refused += 1;
    }
    writeFileSync(
      resolve(OUT_DIR, "shipping-gate.json"),
      JSON.stringify({ seeds: SEEDS, matrix, rows }, null, 2),
    );
    expect(matrix.far_camera?.gate_passed).toBe(0);
    expect(matrix.control?.gate_passed).toBe(12);
  });
});
