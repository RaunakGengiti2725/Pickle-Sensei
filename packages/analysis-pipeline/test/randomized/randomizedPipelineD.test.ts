/**
 * randomized-pipeline-D — seeded randomized property tests (seeds 4000–4099)
 * over analysis-pipeline segmentation/classification under keypoint noise,
 * landmark/frame dropout, timing jitter and frame reordering.
 *
 * Inputs are the committed deterministic synthetic generator
 * (`@pickle/evaluation` generateSwingSequence) — a replay proxy, not Apple
 * device truth. Every row is replayable from (seed, perturbation spec); with
 * RANDOMIZED_D_OUT=<dir> every table is written as raw JSON (see replay.test.ts
 * to dump the exact generated input for one seed).
 *
 * Tests marked `it.fails` are PROPERTIES THAT DO NOT HOLD on the baseline
 * (findings): vitest passes them while the property keeps failing and turns
 * them red the day the property starts holding — at which point the marker
 * should be removed. The violation tables are still written so the finding is
 * inspectable without reading test output.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { SESSION_COMPLETION, SessionEventEngine } from "../../src/index.js";
import {
  NOISE_LADDER,
  POSITION_ONLY_LADDER,
  SEEDS,
  applyFrameDropout,
  applyFrameReordering,
  applyNoise,
  applyTimingJitter,
  delaySamples,
  expectedLateDrops,
  isStrictlyMonotone,
  jitterSamples,
  noiseField,
  oneByOne,
  randomBatches,
  runCapture,
  runClassifier,
  runEngine,
  runSegmenter,
  scenarioForSeed,
  shuffleWithinBatches,
  stableStringify,
  streamSpecForSeed,
  synthesize,
  wristStream,
  type CaptureOutcome,
  type ClassifierOutcome,
  type EngineOutcome,
  type NoiseLevel,
  type Scenario,
  type SegmenterOutcome,
} from "./harness.js";

const OUT_DIR = process.env["RANDOMIZED_D_OUT"] ?? null;
const EPSILON = 1e-9;
const LONG = 600_000;

/** Labels the synthetic forehand-drive fixture can honestly support. */
const FIXTURE_SUPPORTED_LABELS = new Set(["UNKNOWN", "FOREHAND", "FOREHAND_DRIVE"]);
const FIXTURE_FORBIDDEN_LABEL_PREFIXES = ["BACKHAND", "OVERHEAD", "SERVE", "RETURN"];
const FIXTURE_SUPPORTED_SHOT_TYPES = new Set<string>(["forehand_drive"]);

type Row = Record<string, unknown>;

function dump(name: string, payload: unknown): void {
  if (!OUT_DIR) return;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, name), JSON.stringify(payload, null, 2));
}

function heap(): { rssMb: number; heapUsedMb: number } {
  const usage = process.memoryUsage();
  return {
    rssMb: Number((usage.rss / 1048576).toFixed(1)),
    heapUsedMb: Number((usage.heapUsed / 1048576).toFixed(1)),
  };
}

function histogram(values: readonly (string | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) {
    const key = value ?? "null";
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function mean(values: readonly number[]): number | null {
  return values.length
    ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(4))
    : null;
}

function isForbiddenLabel(label: string | null): boolean {
  if (label === null) return false;
  return FIXTURE_FORBIDDEN_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

function nearestFrameDeltaMs(
  frames: readonly { timestampMs: number }[],
  timestampMs: number,
): number | null {
  let best: number | null = null;
  for (const frame of frames) {
    const delta = Math.abs(frame.timestampMs - timestampMs);
    if (best === null || delta < best) best = delta;
  }
  return best === null ? null : Number(best.toFixed(3));
}

interface LadderRow {
  seed: number;
  level: number;
  sigma: number;
  landmarkDropout: number;
  visibility: number;
  frames: number;
  segmenter: SegmenterOutcome;
  classifier: ClassifierOutcome;
  declared: CaptureOutcome;
  auto: CaptureOutcome;
}

async function ladderRow(
  scenario: Scenario,
  level: NoiseLevel,
  ladderName: string,
): Promise<LadderRow> {
  const { sequence, window } = synthesize(scenario);
  const noisy = applyNoise(sequence, noiseField(scenario.seed, sequence), level);
  const id = `${ladderName}-${scenario.seed}-L${level.level}`;
  return {
    seed: scenario.seed,
    level: level.level,
    sigma: level.sigma,
    landmarkDropout: level.landmarkDropout,
    visibility: level.visibility,
    frames: noisy.frames.length,
    segmenter: await runSegmenter(noisy, window),
    classifier: runClassifier(noisy, window, scenario.handedness),
    declared: await runCapture(noisy, window, scenario.handedness, scenario.declared, `${id}-decl`),
    auto: await runCapture(noisy, window, scenario.handedness, null, `${id}-auto`),
  };
}

function groupBySeed(rows: readonly LadderRow[]): Map<number, LadderRow[]> {
  const bySeed = new Map<number, LadderRow[]>();
  for (const row of rows) {
    const list = bySeed.get(row.seed) ?? [];
    list.push(row);
    bySeed.set(row.seed, list);
  }
  for (const list of bySeed.values()) list.sort((a, b) => a.level - b.level);
  return bySeed;
}

const CONFIDENCE_READERS = {
  phase: (row: LadderRow) => row.segmenter.confidence ?? 0,
  declaredAnalysis: (row: LadderRow) => row.declared.analysisConfidence ?? 0,
  autoAnalysis: (row: LadderRow) => row.auto.analysisConfidence ?? 0,
  classifierCommitted: (row: LadderRow) =>
    row.classifier.label === "UNKNOWN" ? 0 : row.classifier.confidence,
} as const;

function monotoneViolations(rows: readonly LadderRow[]): Row[] {
  const violations: Row[] = [];
  for (const [seed, list] of groupBySeed(rows)) {
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (!previous || !current) continue;
      for (const [metric, read] of Object.entries(CONFIDENCE_READERS)) {
        const from = read(previous);
        const to = read(current);
        if (to > from + EPSILON) {
          violations.push({
            seed,
            fromLevel: previous.level,
            toLevel: current.level,
            metric,
            from,
            to,
          });
        }
      }
      if (previous.classifier.label === "UNKNOWN" && current.classifier.label !== "UNKNOWN") {
        violations.push({
          seed,
          fromLevel: previous.level,
          toLevel: current.level,
          metric: "classifier_label_appears_on_noisier_input",
          from: previous.classifier.label,
          to: current.classifier.label,
          fromLimitingFactors: previous.classifier.limitingFactors,
          toLimitingFactors: current.classifier.limitingFactors,
        });
      }
      if (previous.declared.outcome === "failed" && current.declared.outcome !== "failed") {
        violations.push({
          seed,
          fromLevel: previous.level,
          toLevel: current.level,
          metric: "declared_result_appears_on_noisier_input",
          from: `${previous.declared.outcome}:${previous.declared.failureCode ?? ""}`,
          to: `${current.declared.outcome}:${current.declared.analysisConfidence ?? ""}`,
        });
      }
    }
  }
  return violations;
}

function ladderMatrix(ladder: readonly NoiseLevel[], rows: readonly LadderRow[]): Row[] {
  return ladder.map((level) => {
    const at = rows.filter((row) => row.level === level.level);
    const count = (predicate: (row: LadderRow) => boolean) => at.filter(predicate).length;
    return {
      level: level.level,
      sigma: level.sigma,
      landmarkDropout: level.landmarkDropout,
      visibility: level.visibility,
      n: at.length,
      meanPhaseConfidence: mean(at.map((row) => row.segmenter.confidence ?? 0)),
      meanDeclaredAnalysisConfidence: mean(at.map((row) => row.declared.analysisConfidence ?? 0)),
      meanAutoAnalysisConfidence: mean(at.map((row) => row.auto.analysisConfidence ?? 0)),
      meanOverallScore: mean(
        at.flatMap((row) =>
          row.declared.overallScore === null ? [] : [row.declared.overallScore],
        ),
      ),
      meanClassifierConfidence: mean(at.map((row) => row.classifier.confidence)),
      classifierCommittedRate: mean(at.map((row) => (row.classifier.label === "UNKNOWN" ? 0 : 1))),
      classifierLabels: histogram(at.map((row) => row.classifier.label)),
      classifierLimitingFactors: histogram(at.flatMap((row) => row.classifier.limitingFactors)),
      segmenterAbstain: count((row) => !row.segmenter.ok),
      segmenterFailureCodes: histogram(at.map((row) => row.segmenter.failureCode)),
      declaredScored: count((row) => row.declared.outcome === "scored"),
      declaredLowConfidence: count((row) => row.declared.outcome === "low_confidence"),
      declaredFailed: count((row) => row.declared.outcome === "failed"),
      declaredFailureCodes: histogram(at.map((row) => row.declared.failureCode)),
      declaredAbstainRate: at.length
        ? Number((count((row) => row.declared.outcome !== "scored") / at.length).toFixed(4))
        : null,
      autoScored: count((row) => row.auto.outcome === "scored"),
      autoLowConfidence: count((row) => row.auto.outcome === "low_confidence"),
      autoNoResult: count((row) => row.auto.outcome === "no_result"),
      autoFailed: count((row) => row.auto.outcome === "failed"),
      autoResolution: histogram(at.map((row) => row.auto.strokeResolutionKind)),
      crashes: count((row) => row.declared.crashed || row.auto.crashed),
    };
  });
}

function fabricatedLabels(rows: readonly LadderRow[]): Row[] {
  const fabricated: Row[] = [];
  for (const row of rows) {
    const labels: Array<[string, string | null]> = [
      ["classifier.label", row.classifier.label],
      ["classifier.leaf", row.classifier.leaf],
      ["auto.predictedLabel", row.auto.predictedLabel],
      ["auto.predictedLeaf", row.auto.predictedLeaf],
    ];
    for (const [surface, label] of labels) {
      if (label === null) continue;
      if (isForbiddenLabel(label) || !FIXTURE_SUPPORTED_LABELS.has(label)) {
        fabricated.push({
          seed: row.seed,
          level: row.level,
          surface,
          label,
          confidence: row.classifier.confidence,
          limitingFactors: row.classifier.limitingFactors,
        });
      }
    }
    for (const [surface, shotType] of [
      ["declared.shotType", row.declared.shotType],
      ["auto.shotType", row.auto.shotType],
    ] as const) {
      if (shotType !== null && !FIXTURE_SUPPORTED_SHOT_TYPES.has(shotType)) {
        fabricated.push({ seed: row.seed, level: row.level, surface, label: shotType });
      }
    }
    if (row.declared.outcome === "scored" && row.declared.overallScore === null) {
      fabricated.push({
        seed: row.seed,
        level: row.level,
        surface: "declared.scored_without_score",
        label: "null",
      });
    }
    if (row.auto.outcome === "no_result" && row.auto.shotType !== null) {
      fabricated.push({
        seed: row.seed,
        level: row.level,
        surface: "auto.no_result_with_shotType",
        label: row.auto.shotType,
      });
    }
  }
  return fabricated;
}

// ─── Coupled noise ladder (keypoint noise + landmark dropout + visibility) ──

describe("randomized-pipeline-D — coupled noise ladder (seeds 4000–4099)", () => {
  const rows: LadderRow[] = [];
  const mismatches: Row[] = [];
  let elapsedMs = 0;

  beforeAll(async () => {
    const started = Date.now();
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      for (const level of NOISE_LADDER) {
        const first = await ladderRow(scenario, level, "ladder");
        const second = await ladderRow(scenario, level, "ladder");
        rows.push(first);
        for (const surface of ["segmenter", "classifier", "declared", "auto"] as const) {
          if (stableStringify(first[surface]) !== stableStringify(second[surface])) {
            mismatches.push({
              seed,
              level: level.level,
              surface,
              first: first[surface],
              second: second[surface],
            });
          }
        }
      }
    }
    elapsedMs = Date.now() - started;
    dump("ladder_rows.json", rows);
    dump("ladder_matrix.json", ladderMatrix(NOISE_LADDER, rows));
  }, LONG);

  it("D1 determinism: same seed + rung ⇒ byte-identical outcomes on all four surfaces (2 fresh runs each)", () => {
    dump("d1_determinism.json", {
      seeds: SEEDS.length,
      rungs: NOISE_LADDER.length,
      runsPerSurface: SEEDS.length * NOISE_LADDER.length * 2,
      mismatches,
      elapsedMs,
      memory: heap(),
    });
    expect(rows.length).toBe(SEEDS.length * NOISE_LADDER.length);
    expect(mismatches).toEqual([]);
  });

  it("D3 bounded abstention: clean rung never abstains/crashes; declared-path abstention non-decreasing with noise; zero crashes", () => {
    const matrix = ladderMatrix(NOISE_LADDER, rows);
    dump("d3_abstention.json", matrix);
    const clean = matrix[0];
    expect(clean).toBeDefined();
    if (!clean) return;
    expect(clean["n"]).toBe(SEEDS.length);
    expect(clean["segmenterAbstain"]).toBe(0);
    expect(clean["declaredFailed"]).toBe(0);
    expect(clean["declaredScored"]).toBe(SEEDS.length);
    for (const rung of matrix) expect(rung["crashes"]).toBe(0);
    for (let index = 1; index < matrix.length; index += 1) {
      const previous = matrix[index - 1];
      const current = matrix[index];
      if (!previous || !current) continue;
      expect(current["declaredAbstainRate"] as number).toBeGreaterThanOrEqual(
        previous["declaredAbstainRate"] as number,
      );
    }
  });

  it("D4 no fabricated labels on the coupled ladder: committed labels / shot types stay inside the fixture-supported set", () => {
    const fabricated = fabricatedLabels(rows);
    dump("d4_labels_coupled.json", {
      fabricated,
      classifierLabels: histogram(rows.map((row) => row.classifier.label)),
      autoPredicted: histogram(rows.map((row) => row.auto.predictedLabel)),
      autoResolution: histogram(rows.map((row) => row.auto.strokeResolutionKind)),
      declaredShotTypes: histogram(rows.map((row) => row.declared.shotType)),
    });
    expect(fabricated).toEqual([]);
  });

  // FINDING D-2: not monotone. Rung 4 abstains (phase.no_distinct_stroke) while
  // the noisier rung 5 segments and returns a low_confidence result; two seeds
  // abstain (UNKNOWN) on cleaner input and commit FOREHAND on noisier input.
  it.fails(
    "D2 monotone confidence along the coupled ladder (never increases; no label/result appearing on noisier input) [FINDING D-2]",
    () => {
      const violations = monotoneViolations(rows);
      dump("d2_monotone_confidence.json", {
        violations,
        violationsByMetric: histogram(violations.map((v) => String(v["metric"]))),
        seedsAffected: [...new Set(violations.map((v) => v["seed"] as number))].sort(),
        matrix: ladderMatrix(NOISE_LADDER, rows),
      });
      expect(violations).toEqual([]);
    },
  );
});

// ─── Position-only ladder (visibility/dropout held constant) ───────────────

describe("randomized-pipeline-D — position-only noise ladder (visibility fixed)", () => {
  const rows: LadderRow[] = [];

  beforeAll(async () => {
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      for (const level of POSITION_ONLY_LADDER) {
        rows.push(await ladderRow(scenario, level, "position-only"));
      }
    }
    dump("position_only_rows.json", rows);
  }, LONG);

  it("D2b-hard: no crash; typed outcomes only; abstention (declared path) non-decreasing with positional noise", () => {
    const matrix = ladderMatrix(POSITION_ONLY_LADDER, rows);
    dump("d2b_position_only_matrix.json", matrix);
    for (const rung of matrix) expect(rung["crashes"]).toBe(0);
    for (let index = 1; index < matrix.length; index += 1) {
      const previous = matrix[index - 1];
      const current = matrix[index];
      if (!previous || !current) continue;
      expect(current["declaredAbstainRate"] as number).toBeGreaterThanOrEqual(
        previous["declaredAbstainRate"] as number,
      );
    }
  });

  // FINDING D-1: with visibility held at 0.98, analysisConfidence RISES with
  // positional noise (the score moves, the confidence does not track it) and
  // rung 5 (σ=0.04) commits BACKHAND at the same 0.6 confidence as a correct
  // FOREHAND call on the synthetic forehand-drive stream.
  it.fails(
    "D2b monotone confidence + no mirrored label under position-only noise [FINDING D-1 / D-3]",
    () => {
      const increases = monotoneViolations(rows).filter(
        (v) => v["metric"] === "phase" || v["metric"] === "declaredAnalysis",
      );
      const fabricated = fabricatedLabels(rows);
      dump("d2b_position_only.json", {
        increases,
        increasesByMetric: histogram(increases.map((v) => String(v["metric"]))),
        fabricated,
        matrix: ladderMatrix(POSITION_ONLY_LADDER, rows),
      });
      expect(increases).toEqual([]);
      expect(fabricated).toEqual([]);
    },
  );
});

// ─── Timing jitter / frame dropout / frame reordering ─────────────────────

describe("randomized-pipeline-D — timing jitter, frame dropout", () => {
  const JITTER_FRACTIONS = [0.1, 0.25] as const;

  // FINDING D-4: monotone timestamp jitter of ±0.25 frame moves the reported
  // contact by > 1.5 frame intervals on ~40% of seeds and the overall score by
  // up to ±1.4 while analysisConfidence is byte-identical.
  it.fails(
    "D5 sub-frame monotone timing jitter never flips outcome/label; contact drift ≤ 1.5 frames; score drift ≤ 0.5 [FINDING D-4]",
    async () => {
      const flips: Row[] = [];
      const table: Row[] = [];
      for (const seed of SEEDS) {
        const scenario = scenarioForSeed(seed);
        const { sequence, window } = synthesize(scenario);
        const frameMs = 1000 / (scenario.truth.fps ?? 60);
        const base = await runCapture(
          sequence,
          window,
          scenario.handedness,
          scenario.declared,
          `jit-base-${seed}`,
        );
        const baseClf = runClassifier(sequence, window, scenario.handedness);
        for (const fraction of JITTER_FRACTIONS) {
          const jitterMs = Number((fraction * frameMs).toFixed(3));
          const jittered = applyTimingJitter(sequence, seed, jitterMs);
          expect(isStrictlyMonotone(jittered)).toBe(true);
          const perturbed = await runCapture(
            jittered,
            window,
            scenario.handedness,
            scenario.declared,
            `jit-${seed}-${fraction}`,
          );
          const jitClf = runClassifier(jittered, window, scenario.handedness);
          const contactDrift =
            base.contactMs !== null && perturbed.contactMs !== null
              ? Number(Math.abs(base.contactMs - perturbed.contactMs).toFixed(3))
              : null;
          const scoreDrift =
            base.overallScore !== null && perturbed.overallScore !== null
              ? Number(Math.abs(base.overallScore - perturbed.overallScore).toFixed(3))
              : null;
          const row: Row = {
            seed,
            fps: scenario.truth.fps,
            jitterFraction: fraction,
            jitterMs,
            baseOutcome: base.outcome,
            jitteredOutcome: perturbed.outcome,
            baseScore: base.overallScore,
            jitteredScore: perturbed.overallScore,
            scoreDrift,
            baseConfidence: base.analysisConfidence,
            jitteredConfidence: perturbed.analysisConfidence,
            baseLabel: baseClf.label,
            jitteredLabel: jitClf.label,
            baseContactMs: base.contactMs,
            jitteredContactMs: perturbed.contactMs,
            contactDriftMs: contactDrift,
            contactDriftFrames:
              contactDrift === null ? null : Number((contactDrift / frameMs).toFixed(3)),
          };
          table.push(row);
          if (base.outcome !== perturbed.outcome) flips.push({ ...row, kind: "outcome_flip" });
          if (baseClf.label !== jitClf.label) flips.push({ ...row, kind: "label_flip" });
          if (contactDrift !== null && contactDrift > 1.5 * frameMs)
            flips.push({ ...row, kind: "contact_drift" });
          if ((base.contactMs === null) !== (perturbed.contactMs === null))
            flips.push({ ...row, kind: "contact_presence_flip" });
          if (scoreDrift !== null && scoreDrift > 0.5) flips.push({ ...row, kind: "score_drift" });
        }
      }
      const summary = JITTER_FRACTIONS.map((fraction) => {
        const at = table.filter((row) => row["jitterFraction"] === fraction);
        return {
          jitterFraction: fraction,
          n: at.length,
          meanContactDriftFrames: mean(
            at.flatMap((row) =>
              row["contactDriftFrames"] === null ? [] : [row["contactDriftFrames"] as number],
            ),
          ),
          maxContactDriftFrames: Math.max(
            ...at.map((row) => (row["contactDriftFrames"] as number | null) ?? 0),
          ),
          meanScoreDrift: mean(
            at.flatMap((row) => (row["scoreDrift"] === null ? [] : [row["scoreDrift"] as number])),
          ),
          maxScoreDrift: Math.max(...at.map((row) => (row["scoreDrift"] as number | null) ?? 0)),
          confidenceChanged: at.filter((row) => row["baseConfidence"] !== row["jitteredConfidence"])
            .length,
          flipsByKind: histogram(
            flips.filter((f) => f["jitterFraction"] === fraction).map((f) => String(f["kind"])),
          ),
        };
      });
      dump("d5_timing_jitter.json", { summary, flips, table });
      expect(flips).toEqual([]);
    },
    LONG,
  );

  it(
    "D6-hard frame dropout (p = 0.1 / 0.3 / 0.5): typed outcomes only, phases ordered & inside window, ranges valid, no crash",
    async () => {
      const structural: Row[] = [];
      const table: Row[] = [];
      const mirrored: Row[] = [];
      for (const seed of SEEDS) {
        const scenario = scenarioForSeed(seed);
        const { sequence, window } = synthesize(scenario);
        for (const p of [0.1, 0.3, 0.5]) {
          const dropped = applyFrameDropout(sequence, seed, p);
          const seg = await runSegmenter(dropped, window);
          const cap = await runCapture(
            dropped,
            window,
            scenario.handedness,
            scenario.declared,
            `drop-${seed}-${p}`,
          );
          const clf = runClassifier(dropped, window, scenario.handedness);
          const row: Row = {
            seed,
            p,
            fps: scenario.truth.fps,
            framesKept: dropped.frames.length,
            framesTotal: sequence.frames.length,
            nearestFrameToPeakMs: nearestFrameDeltaMs(dropped.frames, window.peakMs),
            segmenterOk: seg.ok,
            segmenterFailure: seg.failureCode,
            captureOutcome: cap.outcome,
            captureFailure: cap.failureCode,
            score: cap.overallScore,
            confidence: cap.analysisConfidence,
            classifierLabel: clf.label,
            classifierConfidence: clf.confidence,
            classifierLimitingFactors: clf.limitingFactors,
          };
          table.push(row);
          if (cap.crashed) structural.push({ ...row, kind: "crash" });
          if (isForbiddenLabel(clf.label) || isForbiddenLabel(clf.leaf))
            mirrored.push({ ...row, kind: "forbidden_label", leaf: clf.leaf });
          if (seg.ok) {
            let cursor = window.startMs;
            for (const span of seg.phases) {
              const inside =
                span.startMs >= window.startMs - EPSILON &&
                span.endMs <= window.endMs + EPSILON &&
                span.startMs <= span.representativeMs + EPSILON &&
                span.representativeMs <= span.endMs + EPSILON &&
                span.startMs >= cursor - EPSILON &&
                Number.isFinite(span.confidence) &&
                span.confidence >= 0 &&
                span.confidence <= 1;
              if (!inside) structural.push({ ...row, kind: "phase_structure", span });
              cursor = span.startMs;
            }
          }
          if (
            cap.outcome === "scored" &&
            (cap.overallScore === null || cap.overallScore < 0 || cap.overallScore > 10)
          ) {
            structural.push({ ...row, kind: "score_range" });
          }
          if (
            cap.analysisConfidence !== null &&
            (cap.analysisConfidence < 0 || cap.analysisConfidence > 1)
          ) {
            structural.push({ ...row, kind: "confidence_range" });
          }
          if (!cap.ok && cap.failureCode === null)
            structural.push({ ...row, kind: "untyped_failure" });
        }
      }
      const summary = [0.1, 0.3, 0.5].map((p) => {
        const at = table.filter((row) => row["p"] === p);
        return {
          p,
          n: at.length,
          captureOutcomes: histogram(at.map((row) => String(row["captureOutcome"]))),
          segmenterFailures: histogram(at.map((row) => row["segmenterFailure"] as string | null)),
          classifierLabels: histogram(at.map((row) => String(row["classifierLabel"]))),
          meanScore: mean(
            at.flatMap((row) => (row["score"] === null ? [] : [row["score"] as number])),
          ),
          meanConfidence: mean(
            at.flatMap((row) => (row["confidence"] === null ? [] : [row["confidence"] as number])),
          ),
          mirroredLabels: mirrored.filter((row) => row["p"] === p).length,
        };
      });
      dump("d6_frame_dropout.json", { summary, structural, mirrored, table });
      expect(structural).toEqual([]);
    },
    LONG,
  );

  // FINDING D-3: with ZERO keypoint noise, dropping 30–50% of frames makes the
  // classifier commit BACKHAND (mirrored side) at 0.6 confidence on the
  // synthetic forehand-drive stream — the nearest frame to the event peak is
  // up to 80 ms away and the side is read there without any limiting factor.
  it.fails(
    "D6 frame dropout never yields a mirrored (BACKHAND) side label on the forehand fixture [FINDING D-3]",
    async () => {
      const mirrored: Row[] = [];
      for (const seed of SEEDS) {
        const scenario = scenarioForSeed(seed);
        const { sequence, window } = synthesize(scenario);
        for (const p of [0.1, 0.3, 0.5]) {
          const dropped = applyFrameDropout(sequence, seed, p);
          const clf = runClassifier(dropped, window, scenario.handedness);
          if (isForbiddenLabel(clf.label) || isForbiddenLabel(clf.leaf)) {
            mirrored.push({
              seed,
              p,
              fps: scenario.truth.fps,
              label: clf.label,
              confidence: clf.confidence,
              limitingFactors: clf.limitingFactors,
              nearestFrameToPeakMs: nearestFrameDeltaMs(dropped.frames, window.peakMs),
              framesKept: dropped.frames.length,
            });
          }
        }
      }
      dump("d6_mirrored_labels.json", mirrored);
      expect(mirrored).toEqual([]);
    },
    LONG,
  );
});

// ─── Frame reordering (non-monotonic timestamps) ──────────────────────────

describe("randomized-pipeline-D — frame reordering (adjacent swaps → non-monotonic timestamps)", () => {
  const table: Row[] = [];
  const crashes: Row[] = [];
  const mirrored: Row[] = [];
  const silentlyDivergent: Row[] = [];

  beforeAll(async () => {
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      const { sequence, window } = synthesize(scenario);
      const swaps = 1 + (seed % 8);
      const { sequence: reordered, swappedIndices } = applyFrameReordering(sequence, seed, swaps);
      const sortedSeg = await runSegmenter(sequence, window);
      const reorderedSeg = await runSegmenter(reordered, window);
      const sortedCap = await runCapture(
        sequence,
        window,
        scenario.handedness,
        scenario.declared,
        `ord-base-${seed}`,
      );
      const reorderedCap = await runCapture(
        reordered,
        window,
        scenario.handedness,
        scenario.declared,
        `ord-${seed}`,
      );
      const sortedClf = runClassifier(sequence, window, scenario.handedness);
      const reorderedClf = runClassifier(reordered, window, scenario.handedness);
      const capDiverged = stableStringify(sortedCap) !== stableStringify(reorderedCap);
      const row: Row = {
        seed,
        swaps,
        swappedIndices,
        swappedCount: swappedIndices.length,
        reorderedIsMonotone: isStrictlyMonotone(reordered),
        sortedOutcome: sortedCap.outcome,
        reorderedOutcome: reorderedCap.outcome,
        reorderedFailure: reorderedCap.failureCode,
        sortedScore: sortedCap.overallScore,
        reorderedScore: reorderedCap.overallScore,
        scoreDelta:
          sortedCap.overallScore !== null && reorderedCap.overallScore !== null
            ? Number(Math.abs(sortedCap.overallScore - reorderedCap.overallScore).toFixed(3))
            : null,
        sortedConfidence: sortedCap.analysisConfidence,
        reorderedConfidence: reorderedCap.analysisConfidence,
        sortedContactMs: sortedCap.contactMs,
        reorderedContactMs: reorderedCap.contactMs,
        sortedPhases: sortedSeg.phases,
        reorderedPhases: reorderedSeg.phases,
        sortedLabel: sortedClf.label,
        reorderedLabel: reorderedClf.label,
        segmenterDiverged: stableStringify(sortedSeg) !== stableStringify(reorderedSeg),
        captureDiverged: capDiverged,
        classifierDiverged: stableStringify(sortedClf) !== stableStringify(reorderedClf),
      };
      table.push(row);
      if (reorderedCap.crashed) crashes.push(row);
      if (isForbiddenLabel(reorderedClf.label)) mirrored.push(row);
      if (capDiverged && reorderedCap.ok) silentlyDivergent.push(row);
    }
    const count = (key: string) => table.filter((row) => row[key] === true).length;
    dump("d7_frame_reordering.json", {
      seeds: SEEDS.length,
      divergentSegmenter: count("segmenterDiverged"),
      divergentCapture: count("captureDiverged"),
      divergentClassifier: count("classifierDiverged"),
      silentlyDivergentCapture: silentlyDivergent.length,
      maxScoreDelta: Math.max(...table.map((row) => (row["scoreDelta"] as number | null) ?? 0)),
      confidenceChanged: table.filter(
        (row) => row["sortedConfidence"] !== row["reorderedConfidence"],
      ).length,
      contactChanged: table.filter((row) => row["sortedContactMs"] !== row["reorderedContactMs"])
        .length,
      reorderedOutcomes: histogram(table.map((row) => String(row["reorderedOutcome"]))),
      reorderedFailures: histogram(table.map((row) => row["reorderedFailure"] as string | null)),
      crashes,
      mirrored,
      table,
    });
  }, LONG);

  it("D7-hard: every seed has exactly `swaps` inversions; no crash; no mirrored label; typed outcomes only", () => {
    expect(table.length).toBe(SEEDS.length);
    for (const row of table) {
      expect(row["swappedCount"]).toBe(row["swaps"]);
      expect(row["reorderedIsMonotone"]).toBe(false);
    }
    expect(crashes).toEqual([]);
    expect(mirrored).toEqual([]);
  });

  // FINDING D-5: analyzeCapture never validates frame order. A stream whose
  // timestamps are NOT monotone (the canonical parser would reject it with
  // pose_sequence.non_monotonic) is accepted, scored, and on a quarter of the
  // seeds returns a different score / contact than the sorted stream with an
  // identical analysisConfidence and no limiting factor.
  it.fails(
    "D7 non-monotonic input is either rejected with a typed failure or yields the sorted-stream result [FINDING D-5]",
    () => {
      expect(silentlyDivergent).toEqual([]);
    },
  );
});

// ─── SessionEventEngine streaming segmentation ────────────────────────────

describe("randomized-pipeline-D — SessionEventEngine streaming segmentation", () => {
  it(
    "D8 deterministic; one-by-one == random batching == intra-batch shuffle == whole stream; late samples dropped+counted; closedAt ≤ endMs + safetyMax",
    () => {
      const started = Date.now();
      const violations: Row[] = [];
      const table: Row[] = [];
      for (const seed of SEEDS) {
        const spec = streamSpecForSeed(seed);
        const series = wristStream(spec);
        const single = runEngine(oneByOne(series), `D8-${seed}-single`);
        const singleAgain = runEngine(oneByOne(series), `D8-${seed}-single-again`);
        const batches = randomBatches(series, seed);
        const batched = runEngine(batches, `D8-${seed}-batched`);
        const shuffled = runEngine(shuffleWithinBatches(batches, seed), `D8-${seed}-shuffled`);
        const whole = runEngine([series], `D8-${seed}-whole`);
        const jittered = runEngine(
          oneByOne(jitterSamples(series, seed, spec.stepMs * 0.2)),
          `D8-${seed}-jitter`,
        );
        const slightlyLate = delaySamples(batches, seed, 0.05, 3);
        const veryLate = delaySamples(batches, seed, 0.05, 60);
        const late = runEngine(slightlyLate.batches, `D8-${seed}-late`);
        const stale = runEngine(veryLate.batches, `D8-${seed}-stale`);

        const eventsOf = (outcome: EngineOutcome) => stableStringify(outcome.events);
        const compare = (kind: string, other: EngineOutcome) => {
          if (eventsOf(single) !== eventsOf(other)) {
            violations.push({
              seed,
              kind,
              single: single.events,
              other: other.events,
              otherNotes: other.notes,
            });
          }
        };
        compare("determinism", singleAgain);
        compare("random_batching_vs_one_by_one", batched);
        compare("intra_batch_shuffle_vs_one_by_one", shuffled);
        compare("whole_stream_batch_vs_one_by_one", whole);
        for (const outcome of [single, batched, shuffled, whole, jittered, late, stale]) {
          if (outcome.threw !== null)
            violations.push({ seed, kind: "threw", message: outcome.threw });
          for (const event of outcome.events) {
            if (!(event.startMs <= event.peakMs && event.peakMs <= event.endMs)) {
              violations.push({ seed, kind: "event_bounds", event });
            }
          }
          for (let index = 1; index < outcome.events.length; index += 1) {
            const previous = outcome.events[index - 1];
            const current = outcome.events[index];
            if (previous && current && current.startMs < previous.endMs) {
              violations.push({ seed, kind: "overlapping_events", previous, current });
            }
          }
        }
        // Late-sample contract: exactly the samples behind the closed-event
        // frontier at delivery time are dropped and counted; nothing else is.
        for (const [name, delivery, outcome] of [
          ["late", slightlyLate, late],
          ["stale", veryLate, stale],
        ] as const) {
          const expected = expectedLateDrops(delivery, outcome);
          if (outcome.droppedLateSamples !== expected) {
            violations.push({
              seed,
              kind: `${name}_drop_count`,
              expected,
              observed: outcome.droppedLateSamples,
              delayed: delivery.delayed,
              frontierAfterBatch: outcome.frontierAfterBatch,
            });
          }
        }
        const lateKeys = new Set(
          late.events.map((event) => `${event.startMs}|${event.peakMs}|${event.endMs}`),
        );
        const rewritten = single.events.filter(
          (event) => !lateKeys.has(`${event.startMs}|${event.peakMs}|${event.endMs}`),
        );
        table.push({
          seed,
          spec,
          samples: series.length,
          singleEvents: single.events,
          batchedEvents: batched.events.length,
          wholeEvents: whole.events.length,
          jitteredEvents: jittered.events.length,
          jitterCountDelta: jittered.events.length - single.events.length,
          lateEvents: late.events.length,
          lateDropped: late.droppedLateSamples,
          lateDelayed: slightlyLate.delayed.length,
          lateDivergentEvents: rewritten.length,
          lateEventsDetail: rewritten.length > 0 ? late.events : undefined,
          staleEvents: stale.events.length,
          staleDropped: stale.droppedLateSamples,
          staleDelayed: veryLate.delayed.length,
          staleDivergedFromSingle: stableStringify(stale.events) !== stableStringify(single.events),
          singleNotes: single.notes,
          lateNotes: late.notes,
          staleNotes: stale.notes,
          closeReasons: histogram(single.events.map((event) => event.closeReason)),
        });
      }
      // closedAtMs is not part of the event summary; re-check the bound on the raw engine.
      for (const seed of SEEDS) {
        const spec = streamSpecForSeed(seed);
        const series = wristStream(spec);
        const engine = new SessionEventEngine({ sessionId: `D8-bound-${seed}` });
        const emitted = [];
        for (const sample of series) emitted.push(...engine.pushWristSample(sample));
        emitted.push(...engine.flush());
        for (const event of emitted) {
          if (event.closedAtMs > event.proposal.endMs + SESSION_COMPLETION.safetyMaxMs + EPSILON) {
            violations.push({
              seed,
              kind: "closedAt_exceeds_safety",
              eventId: event.eventId,
              closedAtMs: event.closedAtMs,
              endMs: event.proposal.endMs,
            });
          }
        }
      }
      dump("d8_session_engine.json", {
        seeds: SEEDS.length,
        violations,
        totalEvents: table.reduce((sum, row) => sum + (row["singleEvents"] as unknown[]).length, 0),
        syntheticStrokes: table.reduce(
          (sum, row) => sum + (row["spec"] as { strokes: unknown[] }).strokes.length,
          0,
        ),
        jitterCountDeltas: histogram(table.map((row) => String(row["jitterCountDelta"]))),
        lateDroppedTotal: table.reduce((sum, row) => sum + (row["lateDropped"] as number), 0),
        lateDelayedTotal: table.reduce((sum, row) => sum + (row["lateDelayed"] as number), 0),
        lateDivergentEventsTotal: table.reduce(
          (sum, row) => sum + (row["lateDivergentEvents"] as number),
          0,
        ),
        staleDroppedTotal: table.reduce((sum, row) => sum + (row["staleDropped"] as number), 0),
        staleDelayedTotal: table.reduce((sum, row) => sum + (row["staleDelayed"] as number), 0),
        staleDivergentSeeds: table.filter((row) => row["staleDivergedFromSingle"] === true).length,
        lateEventCountDeltas: histogram(
          table.map((row) =>
            String((row["lateEvents"] as number) - (row["singleEvents"] as unknown[]).length),
          ),
        ),
        elapsedMs: Date.now() - started,
        memory: heap(),
        table,
      });
      expect(violations).toEqual([]);
    },
    LONG,
  );
});
