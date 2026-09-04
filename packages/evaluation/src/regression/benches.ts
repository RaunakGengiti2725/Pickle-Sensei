import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTACT_ESTIMATOR_VERSION,
  CONTACT_OWNERSHIP_POSTERIOR_VERSION,
  FEATURE_EXTRACTOR_VERSION,
  FRAME_ANALYZABILITY_VERSION,
  GEOMETRY_BUNDLE_VERSION,
  OFFLINE_TRIGGER_VERSION,
  PADDLE_TRACK_IDENTITY_VERSION,
  STROKE_HEURISTIC_VERSION,
} from "../../../vision-geometry/src/index.js";
import {
  loadGoldEvents,
  quantile,
  replayAll,
  type ReplayRow,
} from "../../../vision-geometry/eval/contactGoldReplay.js";
import { BALL_TRACKER_VERSION } from "../../../swing-lab/src/ballTracker.js";
import { COACH_GATES_SPEC_ID, runCoachGates } from "../../../swing-lab/src/coachGates.js";
import { runE13EventBoundsEval } from "../../../swing-lab/src/e13EventBoundsEval.js";
import {
  OWNERSHIP_BENCH_VERSION,
  runBench as runOwnershipBench,
  type MethodReport,
} from "../../../swing-lab/src/ownershipBench.js";
import {
  PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
  PHASE_TEMPORAL_V2_VERSION,
  PHASE_TEMPORAL_VERSION,
} from "../../../swing-lab/src/phaseTemporal.js";
import { PLAYER_TRACKER_VERSION } from "../../../swing-lab/src/playerTracker.js";
import { STROKE_EVENT_VERSION_2 } from "../../../swing-lab/src/strokeEvents.js";
import {
  STROKE_HEURISTIC_BENCH_VERSION,
  runStrokeHeuristicBench,
} from "../../../swing-lab/src/strokeHeuristicBench.js";
import type { BenchKind } from "./summarySchema.js";

/** Repository root (this file lives at packages/evaluation/src/regression/). */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export const SWING_LAB_DIR = join(REPO_ROOT, "packages/swing-lab");
export const TSX_BIN = join(SWING_LAB_DIR, "node_modules/.bin/tsx");

/**
 * Version constants of every estimator / heuristic the Linux benches
 * exercise, captured into `provenance.modelVersions`. All are heuristic,
 * uncalibrated code paths — there is no trained model in the repository.
 */
export function collectModelVersions(): Record<string, string> {
  return {
    contactEstimator: CONTACT_ESTIMATOR_VERSION,
    contactOwnershipPosterior: CONTACT_OWNERSHIP_POSTERIOR_VERSION,
    offlineTrigger: OFFLINE_TRIGGER_VERSION,
    strokeHeuristic: STROKE_HEURISTIC_VERSION,
    strokeHeuristicBench: STROKE_HEURISTIC_BENCH_VERSION,
    strokeEventProposer: STROKE_EVENT_VERSION_2,
    phaseTemporal: PHASE_TEMPORAL_VERSION,
    phaseTemporalV2: PHASE_TEMPORAL_V2_VERSION,
    phaseTemporalV2AnchorFree: PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
    featureExtractor: FEATURE_EXTRACTOR_VERSION,
    frameAnalyzability: FRAME_ANALYZABILITY_VERSION,
    geometryBundle: GEOMETRY_BUNDLE_VERSION,
    paddleTrackIdentity: PADDLE_TRACK_IDENTITY_VERSION,
    playerTracker: PLAYER_TRACKER_VERSION,
    ballTracker: BALL_TRACKER_VERSION,
    ownershipBench: OWNERSHIP_BENCH_VERSION,
    coachGatesSpec: COACH_GATES_SPEC_ID,
  };
}

export interface BenchOutput {
  metrics: Record<string, number | null>;
  labels: Record<string, string>;
}

export interface SubprocessSpec {
  /** Script path relative to `cwd`. */
  script: string;
  args: string[];
  cwd: string;
}

export interface BenchDefinition {
  id: string;
  title: string;
  kind: BenchKind;
  /** Human-readable command (in_process: the exported function invoked). */
  command: string;
  cwd: string;
  inputs: string[];
  caveats: string[];
  run: () => BenchOutput | Promise<BenchOutput>;
}

/** Subprocess result handed to a bench's parser. */
export interface SubprocessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SubprocessRunner = (spec: SubprocessSpec) => Promise<SubprocessResult>;

export const CONTACT_STRICT_MS = 66;
export const CONTACT_ACCEPT_MS = 132;

class BenchDataError extends Error {}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BenchDataError(`${where}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) throw new BenchDataError(`${where}: expected an array`);
  return value;
}

function numOrNull(record: Record<string, unknown>, key: string, where: string): number | null {
  const value = record[key];
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new BenchDataError(
    `${where}.${key}: expected a finite number or null, got ${String(value)}`,
  );
}

function num(record: Record<string, unknown>, key: string, where: string): number {
  const value = numOrNull(record, key, where);
  if (value === null) throw new BenchDataError(`${where}.${key}: expected a number, got null`);
  return value;
}

function str(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new BenchDataError(`${where}.${key}: expected a string, got ${String(value)}`);
  }
  return value;
}

/** "13/18" -> [13, 18]; the d3-05 phase script prints ratios this way. */
export function parseRatio(
  text: string,
  where: string,
): { numerator: number; denominator: number } {
  const match = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!match) throw new BenchDataError(`${where}: expected "n/d", got "${text}"`);
  return { numerator: Number(match[1]), denominator: Number(match[2]) };
}

function snake(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9_]/g, "_")
    .toLowerCase();
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function roundOrNull(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** Mirrors `metricsFor` in packages/vision-geometry/eval/contactGold.eval.ts
 *  (STRICT 66ms / ACCEPT 132ms = 2 and 4 frames at 30fps). */
export function contactReplayMetrics(rows: ReplayRow[]): Record<string, number | null> {
  const target = rows.filter((row) => row.event.owner === "target");
  const estimated = target.filter((row) => row.status === "estimated");
  const errors = estimated
    .map((row) => {
      if (row.errorMs === null) throw new BenchDataError("estimated row without errorMs");
      return row.errorMs;
    })
    .sort((a, b) => a - b);
  const wrong = errors.filter((error) => error > CONTACT_ACCEPT_MS);
  const highConfidenceViolations = estimated.filter(
    (row) => row.confidence !== null && row.confidence >= 0.7 && row.errorMs! > CONTACT_ACCEPT_MS,
  );
  return {
    rows_replayed: rows.length,
    target_events: target.length,
    estimated: estimated.length,
    abstained: target.length - estimated.length,
    coverage: target.length > 0 ? round3(estimated.length / target.length) : null,
    abstention_rate: target.length > 0 ? round3(1 - estimated.length / target.length) : null,
    wrong_markers: wrong.length,
    wrong_marker_rate_of_estimated:
      estimated.length > 0 ? round3(wrong.length / estimated.length) : null,
    strict_hits: errors.filter((error) => error <= CONTACT_STRICT_MS).length,
    acceptable_hits: errors.filter((error) => error <= CONTACT_ACCEPT_MS).length,
    median_error_ms: roundOrNull(quantile(errors, 0.5)),
    p75_error_ms: roundOrNull(quantile(errors, 0.75)),
    p90_error_ms: roundOrNull(quantile(errors, 0.9)),
    high_confidence_violations: highConfidenceViolations.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function ownershipMethodMetrics(
  prefix: string,
  method: MethodReport,
): Record<string, number | null> {
  const key = `${prefix}${method.method}`;
  return {
    [`${key}.scored_frames`]: method.scoredFrames,
    [`${key}.correct`]: method.correct,
    [`${key}.abstained`]: method.abstained,
    [`${key}.accuracy`]: method.accuracy,
    [`${key}.accuracy_when_answering`]: method.accuracyWhenAnswering,
    [`${key}.coverage`]: method.coverage,
  };
}

const WAVE_A_GOLD_INPUTS = [
  "datasets/corpus/bundles/wavea-*/annotation/*.json (wave-a gold sidecars: devin-visual-v2/v3/v4)",
  "datasets/corpus/bundles/wavea-*/runs-wave-a/ (committed Apple-Vision pose replay windows)",
];

const LINUX_PROXY_CAVEAT =
  "Linux replay over COMMITTED Apple-Vision pose + oracle/absent paddle & ball tracks; a proxy for the on-device pipeline, not the canonical Mac cascade.";

/**
 * Deterministic, Linux-runnable benches that already exist in the repository.
 * Each in-process bench calls an exported function and never writes to disk;
 * each subprocess bench is a `tsx` script whose report is written to an
 * explicit path inside `scratchDir` (owned and removed by the runner), so a
 * bench never touches the committed `datasets/` tree and two runs never see
 * each other's files.
 */
export function benchDefinitions(
  runSubprocess: SubprocessRunner,
  scratchDir: string,
): BenchDefinition[] {
  const swingLabScript = (script: string, args: string[] = []): SubprocessSpec => ({
    script,
    args,
    cwd: SWING_LAB_DIR,
  });
  const describe = (spec: SubprocessSpec): string =>
    ["tsx", spec.script, ...spec.args.map((arg) => arg.replace(scratchDir, "<scratch>"))].join(" ");

  const runAndRequireOk = async (spec: SubprocessSpec): Promise<SubprocessResult> => {
    const result = await runSubprocess(spec);
    if (result.exitCode !== 0) {
      throw new BenchDataError(
        `${describe(spec)} exited ${result.exitCode}\n${result.stderr.trim().split("\n").slice(-20).join("\n")}`,
      );
    }
    return result;
  };

  /** Run a script told to write its JSON report to `outPath` (inside the
   *  scratch dir) and parse that report. */
  const runWritingReport = async (spec: SubprocessSpec, outPath: string): Promise<unknown> => {
    await runAndRequireOk(spec);
    if (!existsSync(outPath)) {
      throw new BenchDataError(
        `${describe(spec)}: exited 0 but did not write ${outPath.replace(scratchDir, "<scratch>")}`,
      );
    }
    return JSON.parse(readFileSync(outPath, "utf8"));
  };

  const eventRecallOut = join(scratchDir, "event-recall.json");
  const eventRecallSpec = swingLabScript("src/eventRecallBench.ts", [eventRecallOut]);
  const completionOut = join(scratchDir, "completion-bench.json");
  const completionSpec = swingLabScript("src/eventCompletionBench.ts", [completionOut]);
  const ballHardSliceOut = join(scratchDir, "ball-hard-slice.json");
  const ballHardSliceSpec = swingLabScript("src/ballHardSliceEval.ts", [ballHardSliceOut]);
  const phaseSpec: SubprocessSpec = {
    script: relative(
      SWING_LAB_DIR,
      join(REPO_ROOT, "datasets/experiments/wave-d3/d3-05-measure-gold.ts"),
    ),
    args: [],
    cwd: SWING_LAB_DIR,
  };

  return [
    {
      id: "stroke_heuristic",
      title:
        "Stroke classification (L1 overhead/swing, L2 family) — stroke-heuristic-lite over wave-a gold",
      kind: "in_process",
      command: "runStrokeHeuristicBench() from packages/swing-lab/src/strokeHeuristicBench.ts",
      cwd: SWING_LAB_DIR,
      inputs: [
        ...WAVE_A_GOLD_INPUTS,
        "datasets/corpus/bundles/*/annotation/devin-visual-v4-waveD2-events.json (stroke labels, taxonomy v2 families)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "Paddle track is null for every case (not committed); other-player rows use heuristic attribution; L1 only separates OVERHEAD vs SWING.",
        "Abstentions are honest outcomes, not errors: score correct/wrong/abstained separately.",
      ],
      run: () => {
        const report = runStrokeHeuristicBench();
        const o = report.overall;
        return {
          metrics: {
            gold_labels_total: report.goldLabelsTotal,
            evaluable_labels: report.evaluableLabels,
            n: o.n,
            l1_correct: o.l1Correct,
            l1_wrong: o.l1Wrong,
            l1_abstained: o.l1Abstained,
            l1_gold_unknown: o.l1GoldUnknown,
            l2_correct: o.l2Correct,
            l2_wrong: o.l2Wrong,
            l2_abstained: o.l2Abstained,
            l2_gold_unknown: o.l2GoldUnknown,
            l2_not_applicable: o.l2NotApplicable,
            confidently_wrong: o.confidentlyWrong,
          },
          labels: {
            benchVersion: report.benchVersion,
            classifierVersion: report.classifierVersion,
          },
        };
      },
    },
    {
      id: "contact_replay",
      title:
        "Contact estimation — e02 contact-gold replay (wave-a target events, oracle ball, no paddle)",
      kind: "in_process",
      command:
        "replayAll() + loadGoldEvents() from packages/vision-geometry/eval/contactGoldReplay.ts",
      cwd: join(REPO_ROOT, "packages/vision-geometry"),
      inputs: [
        "datasets/corpus/bundles/wavea-*/annotation/devin-visual-v3-waveD-contact.json (gold contact events)",
        "datasets/corpus/bundles/wavea-*/runs-wave-a/people.json (committed pose)",
        "datasets/corpus/bundles/wavea-*/annotation/*ball* (oracle ball observations)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        `strict = |error| <= ${CONTACT_STRICT_MS}ms, acceptable = |error| <= ${CONTACT_ACCEPT_MS}ms (2 / 4 frames at 30fps); wrong marker = estimated beyond acceptable.`,
        "Held-out bundles are excluded by the replay itself.",
      ],
      run: () => {
        const rows = replayAll();
        const gold = loadGoldEvents();
        return {
          metrics: { gold_events: gold.length, ...contactReplayMetrics(rows) },
          labels: { estimatorVersion: CONTACT_ESTIMATOR_VERSION },
        };
      },
    },
    {
      id: "event_bounds_e13",
      title:
        "Stroke segmentation — e13 event bounds (proposeStrokeEventsV2 vs D2-07 gold, 3 bundles)",
      kind: "in_process",
      command: "runE13EventBoundsEval() from packages/swing-lab/src/e13EventBoundsEval.ts",
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/corpus/bundles/{wavea-marne-serve,wavea-wgm-wheelchair,wavea-sasebo-volleys}/annotation/devin-visual-v4-waveD2-events.json",
        "datasets/corpus/bundles/*/runs-wave-a/ (windowed auto-target wrist series)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "Paddle series not committed, so paddle confirmation is structurally absent.",
        "PROPOSED_OK = overlap >= 0.5 of gold span OR gold contact inside proposal ±60ms; one-to-one greedy matching.",
        "Other-owner rows replay the TARGET's wrist and are expected misses (contamination context, not opponent detection).",
      ],
      run: () => {
        const { perBundle, eventRows, nonEventRows } = runE13EventBoundsEval();
        const target = eventRows.filter((row) => row.owner === "target");
        const other = eventRows.filter((row) => row.owner === "other");
        const count = (rows: typeof eventRows, outcome: string) =>
          rows.filter((row) => row.outcome === outcome).length;
        return {
          metrics: {
            bundles: perBundle.length,
            target_n: target.length,
            target_proposed_ok: count(target, "PROPOSED_OK"),
            target_mis_bounded: count(target, "MIS_BOUNDED"),
            target_missed: count(target, "MISSED"),
            target_median_start_err_ms: median(
              target.flatMap((row) => (row.startErrMs !== null ? [row.startErrMs] : [])),
            ),
            target_median_end_err_ms: median(
              target.flatMap((row) => (row.endErrMs !== null ? [row.endErrMs] : [])),
            ),
            target_contact_inside: target.filter((row) => row.contactInside === true).length,
            target_contact_inside_denominator: target.filter((row) => row.contactInside !== null)
              .length,
            other_n: other.length,
            other_proposed_ok: count(other, "PROPOSED_OK"),
            other_missed: count(other, "MISSED"),
            non_events: nonEventRows.length,
            false_positive_non_events: nonEventRows.filter((row) => row.falsePositive).length,
            total_proposals: perBundle.reduce((total, entry) => total + entry.proposals.length, 0),
          },
          labels: { proposerVersion: STROKE_EVENT_VERSION_2 },
        };
      },
    },
    {
      id: "event_recall",
      title: "Stroke segmentation — e01 event recall over DEV gold target events",
      kind: "subprocess",
      command: describe(eventRecallSpec),
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/corpus/bundles/*/annotation/*events*.json (gold target events, held-out excluded)",
        "datasets/corpus/bundles/*/runs-wave-a/ + committed run artifacts (wrist series)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "unmatchedProposals is an upper bound on false proposals (windows are not exhaustively labeled), not a verdict.",
      ],
      run: async () => {
        const report = asRecord(
          await runWritingReport(eventRecallSpec, eventRecallOut),
          "event-recall report",
        );
        const summary = asRecord(report.summary, "event-recall summary");
        const where = "event-recall summary";
        const metrics: Record<string, number | null> = {};
        for (const key of [
          "goldTargetEvents",
          "proposedOk",
          "misBounded",
          "missed",
          "recall",
          "meanBestOverlapOfProposedOk",
          "contactInsideRate",
          "contactInsideDenominator",
          "totalProposals",
          "lowAmplitudeProposals",
          "falseInNonEvent",
          "nonEventSpans",
          "unmatchedProposals",
        ]) {
          metrics[snake(key)] = num(summary, key, where);
        }
        return {
          metrics,
          labels: { benchVersion: str(report, "benchVersion", "event-recall report") },
        };
      },
    },
    {
      id: "completion_bench",
      title:
        "Analysis completion — fixed 1.5s post-roll vs adaptive settle, against gold event/phase ends",
      kind: "subprocess",
      command: describe(completionSpec),
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/corpus/bundles/*/annotation/ (event + phase labels incl. event-bounds-wave-a.json)",
        "datasets/corpus/bundles/*/runs-wave-a/ (wrist speed series)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "Per-event table is the honest unit; n is small and no reliability claim is made.",
        "FIXED is the shipped constant policy and serves as the reference; ADAPTIVE is the candidate policy under test.",
      ],
      run: async () => {
        const report = asRecord(
          await runWritingReport(completionSpec, completionOut),
          "completion report",
        );
        const summary = asRecord(report.summary, "completion summary");
        const metrics: Record<string, number | null> = { n: num(report, "n", "completion report") };
        for (const policy of ["FIXED", "ADAPTIVE"] as const) {
          const block = asRecord(summary[policy], `completion summary.${policy}`);
          for (const key of [
            "medianAbsEndErrorMs",
            "medianAbsRecoveryErrorMs",
            "earlyStops",
            "contactLost",
            "followThroughLost",
            "recoveryLost",
            "meanTrailingExcessMs",
            "meanPostTriggerMs",
          ]) {
            metrics[`${policy.toLowerCase()}.${snake(key)}`] = numOrNull(
              block,
              key,
              `completion summary.${policy}`,
            );
          }
        }
        return {
          metrics,
          labels: { benchVersion: str(report, "benchVersion", "completion report") },
        };
      },
    },
    {
      id: "ownership_dual_frame",
      title:
        "Paddle ownership — frame-level target-vs-other paddle attribution on human-labeled dual frames",
      kind: "in_process",
      command:
        "runBench(includeHeldOut=false, applyCorrections=false) from packages/swing-lab/src/ownershipBench.ts",
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/corpus/bundles/*/annotation/ (dual-paddle frame labels)",
        "datasets/corpus/bundles/*/runs-wave-a/people.json (committed pose, subset of frames)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "Methods needing pose can only answer on frames with committed pose; `pose_subset.*` is the apples-to-apples surface.",
        "Held-out cases excluded; annotator corrections NOT applied (raw labels).",
      ],
      run: () => {
        const report = runOwnershipBench(false, false);
        let metrics: Record<string, number | null> = {
          dual_frames: report.dualFrames,
          frames_with_pose: report.framesWithPose,
        };
        for (const method of report.methods) {
          metrics = { ...metrics, ...ownershipMethodMetrics("", method) };
        }
        for (const method of report.poseSubsetMethods) {
          metrics = { ...metrics, ...ownershipMethodMetrics("pose_subset.", method) };
        }
        return { metrics, labels: { benchVersion: report.benchVersion } };
      },
    },
    {
      id: "ball_hard_slice",
      title: "Ball tracking — e12 hard-slice occlusion eval over D2-06 gold (pose-free proxy)",
      kind: "subprocess",
      command: describe(ballHardSliceSpec),
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/experiments/wave-e/e12-ball-hard-slices/manifest.json (+ referenced labels and candidate files)",
      ],
      caveats: [
        "Linux CPU, pose-free, no paddle track; candidate clocks shifted to label clocks per manifest.",
        "OCCLUDED / NOT_VISIBLE buckets score abstention (correct behaviour) and violations, not hits.",
        "UNCERTAIN_EXCLUDED labels are reported but excluded from slice quality.",
      ],
      run: async () => {
        const report = asRecord(
          await runWritingReport(ballHardSliceSpec, ballHardSliceOut),
          "ball hard-slice report",
        );
        const metrics: Record<string, number | null> = {};
        for (const entry of asArray(report.aggregate, "ball hard-slice aggregate")) {
          const bucket = asRecord(entry, "ball hard-slice aggregate bucket");
          const name = snake(str(bucket, "bucket", "aggregate bucket"));
          for (const key of ["n", "hits", "misses", "wrongLocation", "abstained", "violations"]) {
            metrics[`bucket.${name}.${snake(key)}`] = num(bucket, key, `aggregate.${name}`);
          }
        }
        for (const entry of asArray(report.slices, "ball hard-slice slices")) {
          const slice = asRecord(entry, "ball hard-slice slice");
          const name = snake(str(slice, "slice", "slice"));
          for (const key of [
            "n",
            "hits",
            "misses",
            "wrongLocation",
            "abstained",
            "violations",
            "excluded",
          ]) {
            metrics[`slice.${name}.${snake(key)}`] = num(slice, key, `slices.${name}`);
          }
        }
        return { metrics, labels: { ballTrackerVersion: BALL_TRACKER_VERSION } };
      },
    },
    {
      id: "phase_gold_d3_05",
      title:
        "Phase segmentation — segmentPhasesTemporalV2 anchored vs anchor-free over wave-a gold contacts",
      kind: "subprocess",
      command: describe(phaseSpec),
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/corpus/bundles/wavea-*/annotation/ (gold phase boundaries / contacts)",
        "datasets/corpus/bundles/wavea-*/runs-wave-a/ (committed pose)",
      ],
      caveats: [
        LINUX_PROXY_CAVEAT,
        "Counts are segmented-vs-abstained only; boundary timing error is not measured by this script.",
      ],
      run: async () => {
        const result = await runAndRequireOk(phaseSpec);
        const lines = result.stdout.trim().split("\n");
        const last = lines[lines.length - 1] ?? "";
        const parsed = asRecord(JSON.parse(last), "phase gold summary line");
        const anchored = parseRatio(str(parsed, "anchored", "phase summary"), "anchored");
        const anchorFree = parseRatio(str(parsed, "anchorFree", "phase summary"), "anchorFree");
        return {
          metrics: {
            anchored_segmented: anchored.numerator,
            anchored_total: anchored.denominator,
            anchor_free_segmented: anchorFree.numerator,
            anchor_free_total: anchorFree.denominator,
          },
          labels: {
            phaseTemporalV2Version: PHASE_TEMPORAL_V2_VERSION,
            phaseTemporalV2AnchorFreeVersion: PHASE_TEMPORAL_V2_ANCHOR_FREE_VERSION,
          },
        };
      },
    },
    {
      id: "coach_gates",
      title: "Coaching consistency — frozen coach release gates (PASS / FAIL / NOT_EVALUABLE)",
      kind: "in_process",
      command: "runCoachGates() from packages/swing-lab/src/coachGates.ts",
      cwd: SWING_LAB_DIR,
      inputs: [
        "datasets/coach-review/gates/coach-gates.v1.json (frozen spec, sha-pinned)",
        "datasets/coach-review/ (coach review files; held-out cases excluded)",
      ],
      caveats: [
        "Gates that lack evidence report NOT_EVALUABLE and block release; this bench measures gate status, not coaching quality.",
        "With zero active coaches the expected verdict is RELEASE_BLOCKED — that is honest, not a code regression.",
      ],
      run: () => {
        const report = runCoachGates();
        const verdicts = report.gates.map((gate) => gate.verdict);
        return {
          metrics: {
            gates_total: report.gates.length,
            gates_pass: verdicts.filter((v) => v === "PASS").length,
            gates_fail: verdicts.filter((v) => v === "FAIL").length,
            gates_not_evaluable: verdicts.filter((v) => v === "NOT_EVALUABLE").length,
            active_coaches: report.evidenceCounts.activeCoaches,
            review_files: report.evidenceCounts.reviewFiles,
            counted_reviews: report.evidenceCounts.countedReviews,
            invalid_review_files: report.evidenceCounts.invalidReviewFiles,
          },
          labels: {
            specId: report.specId,
            specSha256: report.specSha256,
            overallVerdict: report.overallVerdict,
          },
        };
      },
    },
  ];
}
