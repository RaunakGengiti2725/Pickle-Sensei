import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  abortedSwingFixture,
  energeticAbortedSwingFixture,
  facingFlipAtContactFixture,
  nonDominantHandSwingFixture,
  practiceShadowSwingFixture,
  profileViewCollapsedShouldersFixture,
  staticReachFixture,
  twoHandedBackhandFixture,
  walkThroughFixture,
  wheelchairDegenerateTorsoFixture,
  wheelchairRimPushFixture,
  wheelchairSeatedStrokeFixture,
  type AdversarialStrokeFixture,
} from "@pickle/evaluation";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { targetPoseSequence, type PlayerTrack } from "./playerTracker.js";
import {
  classifyStroke as classifyStrokeIncumbent,
  STROKE_HEURISTIC_VERSION as INCUMBENT_VERSION,
  type StrokePrediction,
} from "./strokeHeuristic.js";
import {
  classifyStroke as classifyStrokeCandidateV5,
  STROKE_HEURISTIC_VERSION as CANDIDATE_V5_VERSION,
} from "./strokeHeuristicV5Frozen.js";
import {
  loadCaseHandedness,
  loadCasePose,
  loadStrokeGold,
  pickOtherTrack,
  pickTargetTrack,
  STROKE_BENCH_POSE_CASES,
  type BenchPose,
  type StrokeClassifier,
} from "./strokeHeuristicBench.js";

/**
 * SHADOW EVALUATION (wave-i i04) — run a CANDIDATE stroke classifier beside
 * the INCUMBENT over the existing committed fixture/benchmark corpus, without
 * affecting the primary (incumbent) output.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/shadowEval.ts
 *
 * Roles in this run (the harness itself is role-agnostic — classifiers are
 * injected):
 *  - INCUMBENT / primary: the canonical production classifier
 *    (packages/vision-geometry strokeHeuristicLite, re-exported by
 *    strokeHeuristic.ts) — this is what mobile AUTO DETECT ships today.
 *  - CANDIDATE / shadow: strokeHeuristicV5Frozen.ts — the byte-frozen
 *    stroke-heuristic-5 snapshot (git d6f951f). It is a REAL alternative
 *    implementation, used here as the shadow side so the disagreement
 *    machinery is exercised by genuine behavioral differences, not a
 *    self-comparison.
 *
 * NON-INTERFERENCE GUARANTEE: the primary output of a shadow run is defined
 * as the incumbent's prediction alone. Both classifiers are pure functions
 * over read-only inputs built once per row by the e03 bench loader
 * (strokeHeuristicBench.ts); the candidate never sees or alters the
 * incumbent's result. The test suite (test/shadowEval.test.ts) verifies that
 * per-row primary predictions from a shadow run are deep-equal to an
 * incumbent-only run over the same corpus.
 *
 * Per-case comparison AXES (target / event / paddle / ball / contact /
 * stroke). Each axis is scored agree / disagree / not_evaluable with the
 * observed per-side values, never silently folded:
 *  - target: which pose track the row was attributed to. Track selection is
 *    an UPSTREAM shared stage (pickTargetTrack / pickOtherTrack) that both
 *    sides consume identically — recorded so a future candidate that owns
 *    its own selection has a place to disagree.
 *  - event: the timing reference actually used by each side's prediction
 *    (gold contact vs isolated-event peak), read from the prediction's
 *    limiting factors.
 *  - paddle: whether the side trusted a paddle observation as the contact
 *    point. NOT_EVALUABLE on this corpus: no committed paddle track exists
 *    (paddle=null for both sides by construction).
 *  - ball: NOT_EVALUABLE by design — neither classifier consumes ball
 *    observations; no ball track is committed for these windows.
 *  - contact: contact-point source + provenance reliability claimed by each
 *    side's prediction.
 *  - stroke: the committed label + taxonomy depth (UNKNOWN = abstention).
 *
 * Coverage/abstention are counted per side (committed = label !== UNKNOWN).
 * Latency is per-call wall-clock (performance.now) on THIS dev box — a
 * relative microbenchmark of the two implementations on identical inputs,
 * NOT a device measurement; disclosed as such.
 *
 * THIS HARNESS NEVER PROMOTES. The report's promotion field is a constant
 * non-decision; there is no code path that swaps the primary classifier.
 */

export const SHADOW_EVAL_VERSION = "shadow-eval-v1";

export type ShadowAxis = "target" | "event" | "paddle" | "ball" | "contact" | "stroke";

export const SHADOW_AXES: readonly ShadowAxis[] = [
  "target",
  "event",
  "paddle",
  "ball",
  "contact",
  "stroke",
];

export type AxisStatus = "agree" | "disagree" | "not_evaluable";

export interface AxisComparison {
  status: AxisStatus;
  /** Observed value on the incumbent (primary) side, or null when the axis is not evaluable for that side. */
  incumbent: string | null;
  /** Observed value on the candidate (shadow) side, or null when the axis is not evaluable for that side. */
  candidate: string | null;
  /** Why the axis is not evaluable / where the shared value comes from. */
  note: string | null;
}

export interface ShadowCaseRecord {
  corpusSegment: "gold_bench" | "synthetic_adversarial";
  caseId: string;
  group: string;
  owner: "target" | "other" | "synthetic";
  eventStartMs: number;
  goldL1: string | null;
  goldL2: string | null;
  axes: Record<ShadowAxis, AxisComparison>;
  incumbentCommitted: boolean;
  candidateCommitted: boolean;
  incumbentLatencyMs: number;
  candidateLatencyMs: number;
  incumbentLimitingFactors: string[];
  candidateLimitingFactors: string[];
}

export interface AxisTally {
  agree: number;
  disagree: number;
  notEvaluable: number;
}

export interface SideCoverage {
  rows: number;
  committed: number;
  abstained: number;
}

export interface LatencySummary {
  samples: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface ShadowEvalReport {
  shadowEvalVersion: string;
  incumbent: { role: "primary"; classifierVersion: string; provenance: string };
  candidate: { role: "shadow"; classifierVersion: string; provenance: string };
  goldLabelsTotal: number;
  evaluableGoldRows: number;
  unevaluableCases: Record<string, number>;
  syntheticFixtureRows: number;
  rows: ShadowCaseRecord[];
  disagreementByAxis: Record<ShadowAxis, AxisTally>;
  strokeDisagreements: Array<{
    corpusSegment: string;
    caseId: string;
    eventStartMs: number;
    incumbent: string;
    candidate: string;
  }>;
  coverage: { incumbent: SideCoverage; candidate: SideCoverage };
  latency: { incumbent: LatencySummary; candidate: LatencySummary; disclosure: string };
  holdoutStatement: string;
  promotion: {
    decision: "NOT_PROMOTED";
    statement: string;
  };
  disclosures: string[];
}

// ── per-row comparison ─────────────────────────────────────────────────────

function strokeValue(prediction: StrokePrediction): string {
  return `${prediction.label}@depth${prediction.taxonomyDepth}`;
}

function contactValue(prediction: StrokePrediction): string {
  return `${prediction.contactPointSource ?? "none"}/${prediction.contactPointReliability ?? "none"}`;
}

function eventReferenceValue(prediction: StrokePrediction): string {
  return prediction.limitingFactors.includes("reference_is_event_peak_not_contact")
    ? "event_peak"
    : "contact";
}

function compared(incumbent: string, candidate: string, note: string | null): AxisComparison {
  return {
    status: incumbent === candidate ? "agree" : "disagree",
    incumbent,
    candidate,
    note,
  };
}

function notEvaluable(note: string): AxisComparison {
  return { status: "not_evaluable", incumbent: null, candidate: null, note };
}

export function compareAxes(
  incumbent: StrokePrediction,
  candidate: StrokePrediction,
  context: {
    sharedTrackId: string | null;
    paddleProvided: boolean;
  },
): Record<ShadowAxis, AxisComparison> {
  return {
    target:
      context.sharedTrackId === null
        ? notEvaluable("no per-side track selection (synthetic single-skeleton fixture)")
        : compared(
            context.sharedTrackId,
            context.sharedTrackId,
            "track selection is a shared upstream stage; both sides consume the same track by construction",
          ),
    event: compared(
      eventReferenceValue(incumbent),
      eventReferenceValue(candidate),
      "timing reference claimed by each side's prediction (contact vs isolated-event peak)",
    ),
    paddle: context.paddleProvided
      ? compared(
          incumbent.contactPointSource === "paddle" ? "used_paddle" : "ignored_paddle",
          candidate.contactPointSource === "paddle" ? "used_paddle" : "ignored_paddle",
          null,
        )
      : notEvaluable("no committed paddle track on this corpus: paddle=null for both sides"),
    ball: notEvaluable(
      "neither classifier consumes ball observations; no committed ball track for these windows",
    ),
    contact: compared(
      contactValue(incumbent),
      contactValue(candidate),
      "contact-point source and provenance reliability claimed by each prediction",
    ),
    stroke: compared(strokeValue(incumbent), strokeValue(candidate), null),
  };
}

// ── timing ─────────────────────────────────────────────────────────────────

function timeCall(
  classifier: StrokeClassifier,
  input: Parameters<StrokeClassifier>[0],
): { prediction: StrokePrediction; latencyMs: number } {
  const start = performance.now();
  const prediction = classifier(input);
  return { prediction, latencyMs: performance.now() - start };
}

export function summarizeLatency(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { samples: 0, meanMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (quantile: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))]!;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  return {
    samples: sorted.length,
    meanMs: mean,
    p50Ms: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted[sorted.length - 1]!,
  };
}

// ── corpus construction ────────────────────────────────────────────────────

const PB = join(REPO_ROOT, "datasets/paddle-bench");

export interface ShadowInputRow {
  corpusSegment: ShadowCaseRecord["corpusSegment"];
  caseId: string;
  group: string;
  owner: ShadowCaseRecord["owner"];
  eventStartMs: number;
  goldL1: string | null;
  goldL2: string | null;
  sharedTrackId: string | null;
  input: Parameters<StrokeClassifier>[0];
}

function framesInWindow(track: PlayerTrack, window: { startMs: number; endMs: number }): number {
  return track.frames.filter(
    (frame) => frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs,
  ).length;
}

/** Build classifier inputs for every evaluable gold-bench row — the same
 *  loading, track-attribution, and reference rules as strokeHeuristicBench
 *  (e03), so both sides of the shadow pair see byte-identical inputs. */
export function buildGoldBenchInputs(root: string = PB): {
  rows: ShadowInputRow[];
  goldLabelsTotal: number;
  unevaluableCases: Record<string, number>;
} {
  const gold = loadStrokeGold(root);
  const unevaluableCases: Record<string, number> = {};
  const poseCache = new Map<string, BenchPose | null>();
  const rows: ShadowInputRow[] = [];
  for (const label of gold.labels) {
    const info = STROKE_BENCH_POSE_CASES[label.caseId];
    if (!info) {
      unevaluableCases[label.caseId] = (unevaluableCases[label.caseId] ?? 0) + 1;
      continue;
    }
    if (!poseCache.has(label.caseId)) poseCache.set(label.caseId, loadCasePose(label.caseId, root));
    const pose = poseCache.get(label.caseId)!;
    if (!pose) {
      unevaluableCases[label.caseId] = (unevaluableCases[label.caseId] ?? 0) + 1;
      continue;
    }
    const handedness = loadCaseHandedness(label.caseId, root) ?? "right";
    const window = { startMs: label.eventStartMs, endMs: label.eventEndMs };
    const target = pickTargetTrack(pose.tracks);
    let track: PlayerTrack | null = null;
    if (label.owner === "target") {
      track = target;
    } else if (target) {
      track = pickOtherTrack(pose.tracks, target, window);
    }
    if (!track || framesInWindow(track, window) === 0) {
      unevaluableCases[label.caseId] = (unevaluableCases[label.caseId] ?? 0) + 1;
      continue;
    }
    const sequence = targetPoseSequence(pose.file, track);
    const wristSpeeds = dominantWristSpeeds(sequence.frames);
    let eventPeakMs: number | null = null;
    if (label.contactMs === null) {
      const inWindow = wristSpeeds.filter(
        (sample) => sample.timestampMs >= window.startMs && sample.timestampMs <= window.endMs,
      );
      const peak = inWindow.reduce(
        (best: { timestampMs: number; value: number } | null, sample) =>
          best === null || sample.value > best.value ? sample : best,
        null,
      );
      eventPeakMs = peak?.timestampMs ?? null;
    }
    rows.push({
      corpusSegment: "gold_bench",
      caseId: label.caseId,
      group: info.group,
      owner: label.owner,
      eventStartMs: label.eventStartMs,
      goldL1: label.l1,
      goldL2: label.l2,
      sharedTrackId: String(track.trackId),
      input: {
        sequence,
        window,
        contactMs: label.contactMs,
        eventPeakMs,
        handedness,
        paddle: null,
        paddleSpeeds: null,
        wristSpeeds,
      },
    });
  }
  return { rows, goldLabelsTotal: gold.labels.length, unevaluableCases };
}

/** The committed synthetic adversarial fixtures (packages/evaluation) — the
 *  red-team non-stroke / ambiguous-motion corpus. Provenance is synthetic
 *  and stamped in each sequence; there is no gold here (these fixtures'
 *  contract is abstention-oriented and owned by their own red-team suites). */
export function buildSyntheticInputs(): ShadowInputRow[] {
  const fixtures: AdversarialStrokeFixture[] = [
    abortedSwingFixture(),
    walkThroughFixture(),
    wheelchairDegenerateTorsoFixture(),
    wheelchairSeatedStrokeFixture(),
    staticReachFixture(),
    practiceShadowSwingFixture(),
    nonDominantHandSwingFixture(),
    profileViewCollapsedShouldersFixture(),
    facingFlipAtContactFixture(),
    wheelchairRimPushFixture(),
    twoHandedBackhandFixture(),
    energeticAbortedSwingFixture(),
  ];
  return fixtures.map((fixture) => ({
    corpusSegment: "synthetic_adversarial",
    caseId: fixture.id,
    group: "synthetic-adversarial",
    owner: "synthetic",
    eventStartMs: fixture.window.startMs,
    goldL1: null,
    goldL2: null,
    sharedTrackId: null,
    input: {
      sequence: fixture.sequence,
      window: { startMs: fixture.window.startMs, endMs: fixture.window.endMs },
      contactMs: null,
      eventPeakMs: fixture.window.peakMs,
      handedness: "right",
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: fixture.wristSpeeds,
    },
  }));
}

// ── shadow run ─────────────────────────────────────────────────────────────

export interface ShadowClassifierPair {
  incumbent: { classify: StrokeClassifier; version: string; provenance: string };
  candidate: { classify: StrokeClassifier; version: string; provenance: string };
}

export function defaultShadowPair(): ShadowClassifierPair {
  return {
    incumbent: {
      classify: classifyStrokeIncumbent,
      version: INCUMBENT_VERSION,
      provenance:
        "canonical production classifier — packages/vision-geometry strokeHeuristicLite.ts, re-exported by swing-lab strokeHeuristic.ts (the mobile AUTO DETECT path)",
    },
    candidate: {
      classify: classifyStrokeCandidateV5 as StrokeClassifier,
      version: CANDIDATE_V5_VERSION,
      provenance:
        "strokeHeuristicV5Frozen.ts — byte-for-byte git show d6f951f:packages/swing-lab/src/strokeHeuristic.ts plus a provenance header",
    },
  };
}

/** Classify one row with both sides. The candidate runs strictly AFTER the
 *  incumbent and never receives or mutates the incumbent's result; inputs
 *  are shared read-only. */
export function evaluateShadowRow(
  row: ShadowInputRow,
  pair: ShadowClassifierPair,
): ShadowCaseRecord {
  const incumbentRun = timeCall(pair.incumbent.classify, row.input);
  const candidateRun = timeCall(pair.candidate.classify, row.input);
  return {
    corpusSegment: row.corpusSegment,
    caseId: row.caseId,
    group: row.group,
    owner: row.owner,
    eventStartMs: row.eventStartMs,
    goldL1: row.goldL1,
    goldL2: row.goldL2,
    axes: compareAxes(incumbentRun.prediction, candidateRun.prediction, {
      sharedTrackId: row.sharedTrackId,
      paddleProvided: row.input.paddle !== null,
    }),
    incumbentCommitted: incumbentRun.prediction.label !== "UNKNOWN",
    candidateCommitted: candidateRun.prediction.label !== "UNKNOWN",
    incumbentLatencyMs: incumbentRun.latencyMs,
    candidateLatencyMs: candidateRun.latencyMs,
    incumbentLimitingFactors: incumbentRun.prediction.limitingFactors,
    candidateLimitingFactors: candidateRun.prediction.limitingFactors,
  };
}

function emptyTally(): AxisTally {
  return { agree: 0, disagree: 0, notEvaluable: 0 };
}

export function runShadowEval(
  root: string = PB,
  pair: ShadowClassifierPair = defaultShadowPair(),
): ShadowEvalReport {
  const goldCorpus = buildGoldBenchInputs(root);
  const syntheticRows = buildSyntheticInputs();
  const inputRows = [...goldCorpus.rows, ...syntheticRows];

  const rows = inputRows.map((row) => evaluateShadowRow(row, pair));

  const disagreementByAxis = Object.fromEntries(
    SHADOW_AXES.map((axis) => [axis, emptyTally()]),
  ) as Record<ShadowAxis, AxisTally>;
  const coverage: ShadowEvalReport["coverage"] = {
    incumbent: { rows: rows.length, committed: 0, abstained: 0 },
    candidate: { rows: rows.length, committed: 0, abstained: 0 },
  };
  for (const row of rows) {
    for (const axis of SHADOW_AXES) {
      const tally = disagreementByAxis[axis];
      const status = row.axes[axis].status;
      if (status === "agree") tally.agree += 1;
      else if (status === "disagree") tally.disagree += 1;
      else tally.notEvaluable += 1;
    }
    if (row.incumbentCommitted) coverage.incumbent.committed += 1;
    else coverage.incumbent.abstained += 1;
    if (row.candidateCommitted) coverage.candidate.committed += 1;
    else coverage.candidate.abstained += 1;
  }

  return {
    shadowEvalVersion: SHADOW_EVAL_VERSION,
    incumbent: {
      role: "primary",
      classifierVersion: pair.incumbent.version,
      provenance: pair.incumbent.provenance,
    },
    candidate: {
      role: "shadow",
      classifierVersion: pair.candidate.version,
      provenance: pair.candidate.provenance,
    },
    goldLabelsTotal: goldCorpus.goldLabelsTotal,
    evaluableGoldRows: goldCorpus.rows.length,
    unevaluableCases: goldCorpus.unevaluableCases,
    syntheticFixtureRows: syntheticRows.length,
    rows,
    disagreementByAxis,
    strokeDisagreements: rows
      .filter((row) => row.axes.stroke.status === "disagree")
      .map((row) => ({
        corpusSegment: row.corpusSegment,
        caseId: row.caseId,
        eventStartMs: row.eventStartMs,
        incumbent: row.axes.stroke.incumbent ?? "—",
        candidate: row.axes.stroke.candidate ?? "—",
      })),
    coverage,
    latency: {
      incumbent: summarizeLatency(rows.map((row) => row.incumbentLatencyMs)),
      candidate: summarizeLatency(rows.map((row) => row.candidateLatencyMs)),
      disclosure:
        "per-call wall-clock (performance.now) on the dev box running this harness — a relative microbenchmark of the two implementations over identical inputs, NOT a physical-device measurement",
    },
    holdoutStatement:
      "Held-out cases wm-dink-01 and afn-vic-rally1 were never read, listed, or evaluated: they have no rows in stroke-gold.json and no committed pose in runs-wave-a.",
    promotion: {
      decision: "NOT_PROMOTED",
      statement:
        "Shadow evaluation only: this harness has no code path that changes the primary classifier. Promotion is a separate, human-gated decision outside this tool.",
    },
    disclosures: [
      "Gold-bench segment: dev-tier committed gold only; pose exists for the 8 wave-a corpus windows, so gold on afn-sasebo-rally1/2 and wm-volley-02 is not evaluable on this machine.",
      "paddle=null everywhere (no committed paddle track): the paddle axis is NOT_EVALUABLE and contact points are wrist-derived for BOTH sides identically.",
      "ball axis is NOT_EVALUABLE by design: neither classifier consumes ball observations and no ball track is committed for these windows.",
      "target axis records the shared upstream track selection; per-side disagreement is structurally impossible in this run because selection happens before either classifier — kept as an axis so a candidate that owns selection has a place to disagree.",
      "Synthetic segment rows are red-team fixtures (provenance stamped synthetic); they exercise abstention behavior and are never mixed into gold-bench counts.",
      "Latency numbers are dev-box wall-clock microbenchmarks, not device measurements.",
      "All rates are reported as counts; slice Ns are small — treat differences as per-row facts, not statistics.",
    ],
  };
}

// ── CLI ────────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("shadowEval.ts");
if (isMain) {
  const report = runShadowEval();
  console.log(
    `${report.shadowEvalVersion} — ${report.evaluableGoldRows}/${report.goldLabelsTotal} gold rows + ${report.syntheticFixtureRows} synthetic fixtures`,
  );
  console.log(`incumbent (primary): ${report.incumbent.classifierVersion}`);
  console.log(`candidate (shadow):  ${report.candidate.classifierVersion}`);
  console.log(`unevaluable gold cases: ${JSON.stringify(report.unevaluableCases)}`);
  console.log("\nDISAGREEMENT BY AXIS");
  for (const axis of SHADOW_AXES) {
    const tally = report.disagreementByAxis[axis];
    console.log(
      `  ${axis.padEnd(8)} agree ${tally.agree} · disagree ${tally.disagree} · not-evaluable ${tally.notEvaluable}`,
    );
  }
  console.log("\nCOVERAGE / ABSTENTION");
  console.log(
    `  incumbent committed ${report.coverage.incumbent.committed}/${report.coverage.incumbent.rows} (abstained ${report.coverage.incumbent.abstained})`,
  );
  console.log(
    `  candidate committed ${report.coverage.candidate.committed}/${report.coverage.candidate.rows} (abstained ${report.coverage.candidate.abstained})`,
  );
  const fmtLatency = (summary: LatencySummary) =>
    `n=${summary.samples} mean ${summary.meanMs.toFixed(2)}ms · p50 ${summary.p50Ms.toFixed(2)}ms · p95 ${summary.p95Ms.toFixed(2)}ms · max ${summary.maxMs.toFixed(2)}ms`;
  console.log("\nLATENCY (dev-box wall-clock — see disclosure)");
  console.log(`  incumbent ${fmtLatency(report.latency.incumbent)}`);
  console.log(`  candidate ${fmtLatency(report.latency.candidate)}`);
  console.log(`\nSTROKE DISAGREEMENTS: ${report.strokeDisagreements.length}`);
  for (const disagreement of report.strokeDisagreements) {
    console.log(
      `  [${disagreement.corpusSegment}] ${disagreement.caseId} @${disagreement.eventStartMs} ` +
        `incumbent=${disagreement.incumbent} candidate=${disagreement.candidate}`,
    );
  }
  console.log(`\nPROMOTION: ${report.promotion.decision} — ${report.promotion.statement}`);
  console.log("\nDISCLOSURES");
  for (const disclosure of report.disclosures) console.log(`  - ${disclosure}`);

  const outDir = join(REPO_ROOT, "datasets/experiments/wave-i");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "i04-shadow-eval-report.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport written: ${outPath}`);
}
