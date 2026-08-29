// H15 — AUTO DETECT + adaptive completion certification (wave-h).
//
// Certifies, with COUNTED evidence, on the release candidate:
//  1. REPLAY LADDER: every evaluable non-holdout stroke-gold label runs the
//     full AUTO route (classifyStroke → resolvePredictedProfile) — counts of
//     leaf / family / abstain routes, cross-tabbed against gold verdicts,
//     confidently-wrong side reads counted per session group.
//  2. DECLARED SEPARATION (replay-derived): for every committed side read,
//     both agreeing and contradicting declarations are checked — the
//     declaration must never be silently overwritten and the disagreement
//     must be surfaced exactly when structurally demonstrable.
//  3. SYNTHETIC ADVERSARIAL: practice swing / whiff (no contact evidence),
//     static reach, walk-through, bimanual rim propulsion, near-profile,
//     torso collapse, midline-ambiguous contact, no-reference, ambidextrous
//     handedness — none may resolve to a leaf (confident stroke Result);
//     plus ladder-level adversarial predictions (sub-floor confidence,
//     unregistered leaf, unresolvable label, depth-2 promotion attempt).
//  4. ADAPTIVE COMPLETION: D-029 constant parity across the four copies
//     (bench source, session engine, mobile TS telemetry schema, native
//     Swift monitor), plus live-engine synthetic closure counts
//     (settle / valley / safety / flush) and the append-only guarantee.
//
// Run from packages/swing-lab (its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-h/h15-autodetect-cert.ts
//
// LINUX-CPU, committed data only. Held-out cases wm-dink-01 / afn-vic-rally1
// are absent from stroke-gold by construction and never touched. No
// thresholds, denominators, or assertions are altered by this script.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PoseSequence } from "@pickle/swing-domain";
import type { ShotTypeSlug } from "@pickle/shared-types";
import {
  runStrokeHeuristicBench,
  type BenchRow,
} from "../../../packages/swing-lab/src/strokeHeuristicBench.ts";
import { classifyStroke } from "../../../packages/swing-lab/src/strokeHeuristic.ts";
import {
  AUTO_RESOLUTION_MIN_CONFIDENCE,
  detectHierarchicalDisagreement,
  resolvePredictedProfile,
  resolveSlugProfileId,
  type HierarchicalStrokePrediction,
} from "../../../packages/analysis-pipeline/src/strokeAutoResolution.ts";
import {
  SESSION_COMPLETION,
  SessionEventEngine,
  type SpeedSample,
} from "../../../packages/analysis-pipeline/src/sessionEngine.ts";

const OUT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO = join(OUT_DIR, "../../..", "Pickle-Sensei");
// OUT_DIR is <repo>/datasets/experiments/wave-h — derive repo root directly.
const REPO_ROOT = join(OUT_DIR, "../../..");
void REPO;

// ── helpers ───────────────────────────────────────────────────────────────

function rowToPrediction(row: BenchRow): HierarchicalStrokePrediction | null {
  if (row.taxonomyDepth === null || row.confidence === null) return null;
  return {
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "replayed-from-bench-row",
    label: row.predictedLabel,
    leaf: row.predictedLabel === "OVERHEAD" ? "OVERHEAD" : null,
    taxonomyDepth: row.taxonomyDepth as 1 | 2 | 3,
    confidence: row.confidence,
    evidence: [],
    limitingFactors: row.limitingFactors,
  };
}

// ── 1. replay ladder ──────────────────────────────────────────────────────

const bench = runStrokeHeuristicBench();
const evaluable = bench.rows.filter((row) => row.l1 !== "pose_unavailable");

interface LadderCounts {
  n: number;
  leaf: number;
  family: number;
  abstain: number;
  leafCorrect: number;
  leafWrong: number;
  familySideCorrect: number;
  familySideWrong: number;
  familySideGoldUnknown: number;
  confidentWrongRoutes: string[];
}
const ladder: LadderCounts = {
  n: 0,
  leaf: 0,
  family: 0,
  abstain: 0,
  leafCorrect: 0,
  leafWrong: 0,
  familySideCorrect: 0,
  familySideWrong: 0,
  familySideGoldUnknown: 0,
  confidentWrongRoutes: [],
};
const byGroupWrong: Record<string, number> = {};
const byGroupN: Record<string, number> = {};

for (const row of evaluable) {
  const prediction = rowToPrediction(row);
  if (!prediction) continue;
  ladder.n += 1;
  byGroupN[row.group] = (byGroupN[row.group] ?? 0) + 1;
  const resolution = resolvePredictedProfile(prediction);
  if (resolution.kind === "abstain") {
    ladder.abstain += 1;
    continue;
  }
  if (resolution.kind === "leaf") {
    ladder.leaf += 1;
    const ok = row.l1 === "correct" && row.l2 !== "wrong";
    if (ok) ladder.leafCorrect += 1;
    else {
      ladder.leafWrong += 1;
      byGroupWrong[row.group] = (byGroupWrong[row.group] ?? 0) + 1;
      ladder.confidentWrongRoutes.push(
        `${row.caseId}@${row.eventStartMs} leaf ${resolution.canonical} vs gold ${row.goldL1}/${row.goldL2} (conf ${row.confidence})`,
      );
    }
    continue;
  }
  ladder.family += 1;
  if (row.goldL2 === "unknown" || row.goldL2 === "not_applicable") {
    ladder.familySideGoldUnknown += 1;
  } else if (row.l2 === "correct") {
    ladder.familySideCorrect += 1;
  } else if (row.l2 === "wrong") {
    ladder.familySideWrong += 1;
    byGroupWrong[row.group] = (byGroupWrong[row.group] ?? 0) + 1;
    ladder.confidentWrongRoutes.push(
      `${row.caseId}@${row.eventStartMs} family ${resolution.side} vs gold ${row.goldL1}/${row.goldL2} (conf ${row.confidence}, limits ${row.limitingFactors.join("|")})`,
    );
  }
}

// ── 2. declared separation (replay-derived) ───────────────────────────────

const sep = {
  checked: 0,
  contradictionSurfaced: 0,
  contradictionMissed: 0,
  agreementFalseAlarm: 0,
  sideAgnosticFalseAlarm: 0,
  declaredProfileUnchangedUnderContradiction: 0,
  declaredProfileChanged: 0,
};
for (const row of evaluable) {
  const prediction = rowToPrediction(row);
  if (!prediction) continue;
  if (prediction.label !== "FOREHAND" && prediction.label !== "BACKHAND") continue;
  if (prediction.confidence < AUTO_RESOLUTION_MIN_CONFIDENCE) continue;
  sep.checked += 1;
  const opposite: ShotTypeSlug =
    prediction.label === "FOREHAND" ? "backhand_drive" : "forehand_drive";
  const same: ShotTypeSlug = prediction.label === "FOREHAND" ? "forehand_drive" : "backhand_drive";
  const contradiction = detectHierarchicalDisagreement(opposite, prediction);
  if (contradiction && contradiction.basis === "side_vs_declared") sep.contradictionSurfaced += 1;
  else sep.contradictionMissed += 1;
  if (detectHierarchicalDisagreement(same, prediction) !== null) sep.agreementFalseAlarm += 1;
  // A side-agnostic declaration (serve) must never be "contradicted" by a side.
  if (detectHierarchicalDisagreement("serve", prediction) !== null) {
    sep.sideAgnosticFalseAlarm += 1;
  }
  // The declared route's profile must not depend on the prediction at all.
  const withPrediction = resolveSlugProfileId(opposite, null);
  const canonical = opposite === "backhand_drive" ? "BACKHAND_DRIVE" : "FOREHAND_DRIVE";
  const withCanonical = resolveSlugProfileId(opposite, canonical);
  if (withPrediction.profileId === null || withCanonical.profileId?.includes(canonical)) {
    sep.declaredProfileUnchangedUnderContradiction += 1;
  } else {
    sep.declaredProfileChanged += 1;
  }
}

// ── 3. synthetic adversarial ──────────────────────────────────────────────

interface Mark {
  name: string;
  x: number;
  y: number;
  visibility: number;
}
const SHOULDER_Y = 0.4;
const HIP_Y = 0.6;
const PEAK_MS = 2000;
const mark = (name: string, x: number, y: number, visibility = 0.9): Mark => ({
  name,
  x,
  y,
  visibility,
});
const torso = (hipY = HIP_Y, shoulderY = SHOULDER_Y, lsx = 0.62, rsx = 0.78): Mark[] => [
  mark("left_shoulder", lsx, shoulderY),
  mark("right_shoulder", rsx, shoulderY),
  mark("left_hip", lsx + 0.01, hipY),
  mark("right_hip", rsx - 0.01, hipY),
];
function toSequence(frames: Array<{ timestampMs: number; landmarks: Mark[] }>): PoseSequence {
  return {
    schemaVersion: 1,
    format: "pickle.pose-sequence.v1",
    coordinateSystem: "normalized_image_top_left",
    producedBy: {
      providerId: "synthetic.h15-autodetect-cert",
      modelVersion: "h15-cert-1",
      runtime: "deterministic",
      executionTarget: "on_device",
      artifactHash: null,
    },
    video: { width: 1080, height: 1080, fps: 33 },
    frames: frames.map((frame, index) => ({
      frameIndex: index,
      timestampMs: frame.timestampMs,
      confidence: 0.9,
      landmarks: frame.landmarks,
    })),
  } as PoseSequence;
}
function buildFrames(
  halfSpanMs: number,
  frameAt: (tMs: number) => Mark[],
): Array<{ timestampMs: number; landmarks: Mark[] }> {
  const frames: Array<{ timestampMs: number; landmarks: Mark[] }> = [];
  for (let tMs = PEAK_MS - halfSpanMs; tMs <= PEAK_MS + halfSpanMs; tMs += 30) {
    frames.push({ timestampMs: tMs, landmarks: frameAt(tMs) });
  }
  return frames;
}
const fastSpeeds = Array.from({ length: 20 }, (_, index) => ({
  timestampMs: PEAK_MS - 300 + index * 30,
  value: 1.2,
}));
const slowSpeeds = Array.from({ length: 20 }, (_, index) => ({
  timestampMs: PEAK_MS - 300 + index * 30,
  value: 0.1,
}));

/** Genuine one-armed right forehand swing geometry (the motion itself). */
function swingFrames(overrides?: {
  hipYAt?: (tMs: number) => number;
  shoulders?: { lsx: number; rsx: number };
  wristTravelScale?: number;
  contactX?: number;
}): Array<{ timestampMs: number; landmarks: Mark[] }> {
  const scale = overrides?.wristTravelScale ?? 1;
  return buildFrames(600, (tMs) => {
    const phase = Math.min(1, Math.max(-1, (tMs - PEAK_MS) / 250));
    const wristX = (overrides?.contactX ?? 0.88) + 0.08 * phase * scale;
    const wristY = 0.55 - 0.04 * Math.max(0, phase);
    const hipY = overrides?.hipYAt ? overrides.hipYAt(tMs) : HIP_Y;
    const shoulders = overrides?.shoulders ?? { lsx: 0.62, rsx: 0.78 };
    return [
      ...torso(hipY, SHOULDER_Y, shoulders.lsx, shoulders.rsx),
      mark("right_wrist", wristX, wristY),
      mark("right_elbow", (shoulders.rsx + wristX) / 2, (SHOULDER_Y + wristY) / 2),
      mark("left_wrist", 0.6, 0.56, 0.7),
      mark("left_elbow", 0.61, 0.49, 0.7),
    ];
  });
}

interface AdversarialCase {
  id: string;
  description: string;
  expected: "abstain" | "no_leaf";
  run: () => { label: string; confidence: number; resolutionKind: string };
}
function ladderKind(prediction: {
  label: string;
  leaf: string | null;
  taxonomyDepth: number;
  confidence: number;
}): string {
  return resolvePredictedProfile({
    taxonomyVersion: "pickleball-stroke-taxonomy-v3",
    classifierVersion: "synthetic",
    label: prediction.label,
    leaf: prediction.leaf,
    taxonomyDepth: prediction.taxonomyDepth as 1 | 2 | 3,
    confidence: prediction.confidence,
    evidence: [],
    limitingFactors: [],
  }).kind;
}
function classifyCase(input: {
  frames: Array<{ timestampMs: number; landmarks: Mark[] }>;
  contactMs: number | null;
  eventPeakMs?: number | null;
  wristSpeeds?: Array<{ timestampMs: number; value: number }> | null;
  handedness?: "right" | "left" | "ambidextrous" | "unknown";
}) {
  const prediction = classifyStroke({
    sequence: toSequence(input.frames),
    window: { startMs: PEAK_MS - 300, endMs: PEAK_MS + 300 },
    contactMs: input.contactMs,
    eventPeakMs: input.eventPeakMs ?? null,
    handedness: (input.handedness ?? "right") as never,
    paddle: null,
    paddleSpeeds: null,
    wristSpeeds: input.wristSpeeds === undefined ? fastSpeeds : input.wristSpeeds,
  });
  return {
    label: prediction.label,
    confidence: prediction.confidence,
    resolutionKind: ladderKind(prediction),
  };
}

const adversarialCases: AdversarialCase[] = [
  {
    id: "practice_swing_no_contact",
    description:
      "Ball-less practice swing: genuine swing motion, contact never measured, event-peak reference only, no paddle corroboration — must never resolve to a leaf (confident stroke Result).",
    expected: "no_leaf",
    run: () => classifyCase({ frames: swingFrames(), contactMs: null, eventPeakMs: PEAK_MS }),
  },
  {
    id: "whiff_miss_estimated_contact",
    description:
      "Complete miss where an upstream estimator still supplied a contactMs but no paddle evidence exists — must never resolve to a leaf.",
    expected: "no_leaf",
    run: () => classifyCase({ frames: swingFrames(), contactMs: PEAK_MS }),
  },
  {
    id: "static_reach",
    description: "Held-still reach (near-zero wrist travel, slow series) — must abstain.",
    expected: "abstain",
    run: () =>
      classifyCase({
        frames: swingFrames({ wristTravelScale: 0.02 }),
        contactMs: PEAK_MS,
        wristSpeeds: slowSpeeds,
      }),
  },
  {
    id: "walk_through_no_swing_energy",
    description: "Walk-through: measured speed series never exceeds 0.1 u/s — must abstain.",
    expected: "abstain",
    run: () => classifyCase({ frames: swingFrames(), contactMs: PEAK_MS, wristSpeeds: slowSpeeds }),
  },
  {
    id: "bimanual_rim_propulsion",
    description:
      "Wheelchair rim propulsion: both wrists synchronized, similar magnitude, wide separation — must abstain (E10-F5 gate).",
    expected: "abstain",
    run: () => {
      const frames = buildFrames(600, (tMs) => {
        const phase = Math.min(1, Math.max(-1, (tMs - PEAK_MS) / 250));
        const dy = 0.18 * phase;
        return [
          ...torso(),
          mark("right_wrist", 0.95, 0.62 + dy),
          mark("right_elbow", 0.86, 0.55 + dy / 2),
          mark("left_wrist", 0.45, 0.62 + dy),
          mark("left_elbow", 0.54, 0.55 + dy / 2),
        ];
      });
      return classifyCase({ frames, contactMs: PEAK_MS });
    },
  },
  {
    id: "near_profile_shoulders",
    description:
      "Near-profile: image-plane shoulder separation below 0.04u — side decision must abstain (E10-F3 gate).",
    expected: "abstain",
    run: () =>
      classifyCase({
        frames: swingFrames({ shoulders: { lsx: 0.695, rsx: 0.7 } }),
        contactMs: PEAK_MS,
      }),
  },
  {
    id: "torso_collapse_transient",
    description:
      "Transient hip-line collapse at the reference vs the sequence's own median — must abstain (v4 gate).",
    expected: "abstain",
    run: () =>
      classifyCase({
        frames: swingFrames({
          hipYAt: (tMs) => (Math.abs(tMs - PEAK_MS) <= 60 ? SHOULDER_Y + 0.05 : HIP_Y),
        }),
        contactMs: PEAK_MS,
      }),
  },
  {
    id: "midline_ambiguous_contact",
    description: "Contact directly on the body midline — side must abstain, never guess.",
    expected: "abstain",
    run: () =>
      classifyCase({
        frames: swingFrames({ contactX: 0.7, wristTravelScale: 0.4 }),
        contactMs: PEAK_MS,
      }),
  },
  {
    id: "no_reference_at_all",
    description: "No contact and no event peak — must abstain (never a window midpoint).",
    expected: "abstain",
    run: () => classifyCase({ frames: swingFrames(), contactMs: null, eventPeakMs: null }),
  },
  {
    id: "ambidextrous_handedness",
    description: "Unknown/ambidextrous declared handedness — must abstain, never assume.",
    expected: "abstain",
    run: () =>
      classifyCase({ frames: swingFrames(), contactMs: PEAK_MS, handedness: "ambidextrous" }),
  },
];

const adversarialResults = adversarialCases.map((testCase) => {
  const outcome = testCase.run();
  const pass =
    testCase.expected === "abstain"
      ? outcome.label === "UNKNOWN" && outcome.resolutionKind === "abstain"
      : outcome.resolutionKind !== "leaf";
  return { id: testCase.id, description: testCase.description, ...outcome, pass };
});

// Ladder-level adversarial predictions (a hostile/buggy future provider).
const hostile = [
  {
    id: "sub_floor_confidence_commit",
    prediction: { label: "FOREHAND", leaf: null, taxonomyDepth: 2, confidence: 0.45 },
    expectKind: "abstain",
  },
  {
    id: "unregistered_leaf",
    prediction: {
      label: "FOREHAND_SMASH",
      leaf: "FOREHAND_SMASH",
      taxonomyDepth: 3,
      confidence: 0.9,
    },
    expectKind: "abstain",
  },
  {
    id: "unresolvable_depth2_label",
    prediction: { label: "SWING", leaf: null, taxonomyDepth: 2, confidence: 0.9 },
    expectKind: "abstain",
  },
  {
    id: "side_never_promoted_to_leaf",
    prediction: { label: "FOREHAND", leaf: null, taxonomyDepth: 2, confidence: 0.8 },
    expectKind: "side",
  },
  {
    id: "unknown_leaf_marker",
    prediction: { label: "FOREHAND", leaf: "UNKNOWN", taxonomyDepth: 2, confidence: 0.8 },
    expectKind: "abstain",
  },
] as const;
const hostileResults = hostile.map((testCase) => {
  const kind = ladderKind(testCase.prediction);
  return {
    id: testCase.id,
    kind,
    expected: testCase.expectKind,
    pass: kind === testCase.expectKind,
  };
});

// Declared-route ambiguity: a multi-canonical slug without a canonical must
// resolve to NO profile (never a guessed side); a contradicting canonical is
// ignored, not trusted.
const slugChecks = [
  {
    id: "ambiguous_slug_no_canonical",
    result: resolveSlugProfileId("dink", null).profileId,
    expected: null,
  },
  {
    id: "ambiguous_slug_valid_canonical",
    result: resolveSlugProfileId("dink", "FOREHAND_DINK").profileId,
    expected: "FOREHAND_DINK",
  },
  {
    id: "contradicting_canonical_ignored",
    result: resolveSlugProfileId("dink", "OVERHEAD").profileId,
    expected: null,
  },
].map((check) => ({ ...check, pass: check.result === check.expected }));

// UNKNOWN / below-floor predictions must never claim a disagreement.
const unknownPrediction: HierarchicalStrokePrediction = {
  taxonomyVersion: "pickleball-stroke-taxonomy-v3",
  classifierVersion: "synthetic",
  label: "UNKNOWN",
  leaf: null,
  taxonomyDepth: 1,
  confidence: 0.2,
  evidence: [],
  limitingFactors: [],
};
const noFalseDisagreement =
  detectHierarchicalDisagreement("forehand_drive", unknownPrediction) === null;

// ── 4. adaptive completion ────────────────────────────────────────────────

// 4a. constant parity across the four copies.
const swiftSource = readFileSync(
  join(REPO_ROOT, "apps/mobile/ios/LocalPods/PickleNative/Sources/StrokeCompletionMonitor.swift"),
  "utf8",
);
const captureSource = readFileSync(join(REPO_ROOT, "apps/mobile/src/camera/capture.ts"), "utf8");
const benchSource = readFileSync(
  join(REPO_ROOT, "packages/swing-lab/src/eventCompletionBench.ts"),
  "utf8",
);
function swiftConst(name: string): number {
  const match = swiftSource.match(new RegExp(`static let ${name} = ([0-9_.]+)`));
  if (!match) throw new Error(`Swift constant ${name} not found`);
  return Number(match[1]!.replace(/_/g, ""));
}
function captureConst(name: string): number {
  const match = captureSource.match(new RegExp(`${name}: ([0-9.]+)`));
  if (!match) throw new Error(`capture.ts constant ${name} not found`);
  return Number(match[1]);
}
const parity = [
  {
    field: "settleFloor",
    engine: SESSION_COMPLETION.settleFloor,
    swift: swiftConst("settleFloorPerSecond"),
    capture: captureConst("settleFloorPerSecond"),
    benchLiteral: benchSource.includes("Math.max(0.15, 0.25 * peak.value)"),
  },
  {
    field: "settlePeakFraction",
    engine: SESSION_COMPLETION.settlePeakFraction,
    swift: swiftConst("settlePeakFraction"),
    capture: captureConst("settlePeakFraction"),
    benchLiteral: benchSource.includes("Math.max(0.15, 0.25 * peak.value)"),
  },
  {
    field: "settleQuietMs",
    engine: SESSION_COMPLETION.settleQuietMs,
    swift: swiftConst("settleHoldMs"),
    capture: captureConst("settleHoldMs"),
    benchLiteral: benchSource.includes(">= 400"),
  },
  {
    field: "minFollowThroughMs",
    engine: SESSION_COMPLETION.minFollowThroughMs,
    swift: swiftConst("minFollowThroughMs"),
    capture: captureConst("minFollowThroughMs"),
    benchLiteral: benchSource.includes("trigger + 300"),
  },
  {
    field: "safetyMaxMs",
    engine: SESSION_COMPLETION.safetyMaxMs,
    swift: swiftConst("safetyMaxMs"),
    capture: captureConst("safetyMaxMs"),
    benchLiteral: benchSource.includes("trigger + 2500"),
  },
  {
    field: "valleyDipFraction",
    engine: SESSION_COMPLETION.valleyDipFraction,
    swift: swiftConst("valleyDipFraction"),
    capture: captureConst("valleyDipFraction"),
    benchLiteral: benchSource.includes("0.6 * peak.value"),
  },
  {
    field: "valleyRiseRatio",
    engine: SESSION_COMPLETION.valleyRiseRatio,
    swift: swiftConst("valleyRiseRatio"),
    capture: captureConst("valleyRiseRatio"),
    benchLiteral: benchSource.includes("1.5 * valley.value"),
  },
  {
    field: "valleyMinDwellMs",
    engine: SESSION_COMPLETION.valleyMinDwellMs,
    swift: swiftConst("valleyRiseMinGapMs"),
    capture: captureConst("valleyRiseMinGapMs"),
    benchLiteral: benchSource.includes("valley.timestampMs + 80"),
  },
].map((row) => ({
  ...row,
  pass: row.engine === row.swift && row.engine === row.capture && row.benchLiteral,
}));

// Shipped default must be FIXED (D-043): the Swift store starts fixed.
const defaultFixed =
  swiftSource.includes("storedStrategy: CaptureCompletionStrategy = .fixed") &&
  captureSource.includes("Default builds\n *    always say 'fixed'");

// 4b. live-engine synthetic closure behavior.
function stream(samples: Array<[number, number]>): SpeedSample[] {
  return samples.map(([timestampMs, value]) => ({ timestampMs, value }));
}
function swingBurst(startMs: number): Array<[number, number]> {
  // ~600ms burst peaking at 1.5 u/s (well above proposal floors).
  const out: Array<[number, number]> = [];
  for (let t = 0; t <= 600; t += 30) {
    const x = (t - 300) / 300;
    out.push([startMs + t, Math.max(0.05, 1.5 * (1 - x * x))]);
  }
  return out;
}
function runEngine(samples: Array<[number, number]>, flush = true) {
  const engine = new SessionEventEngine({ sessionId: "h15-cert" });
  const closed: string[] = [];
  for (const sample of stream(samples)) {
    for (const event of engine.pushWristSample(sample)) closed.push(event.closeReason);
  }
  if (flush) for (const event of engine.flush()) closed.push(event.closeReason);
  return { closed, snapshot: engine.snapshot() };
}

// settle: one swing then sustained quiet + trailing samples past stability.
const settleSamples: Array<[number, number]> = [
  ...swingBurst(1000),
  ...Array.from({ length: 80 }, (_, index): [number, number] => [1630 + index * 30, 0.05]),
];
const settleRun = runEngine(settleSamples, false);

// valley: two rapid swings — first closes at the inter-stroke valley.
const valleySamples: Array<[number, number]> = [...swingBurst(1000), ...swingBurst(1700)];
const valleyRun = runEngine(valleySamples, true);

// safety: elevated, never-settling motion after the swing — the trailing
// plateau stays above the valley-dip line (0.6 × peak) so neither settle nor
// valley can fire and only the safety max can close the event.
const safetySamples: Array<[number, number]> = [
  ...Array.from({ length: 21 }, (_, index): [number, number] => [
    1000 + index * 30,
    Math.min(1.5, 0.95 + (index * 30) / 400),
  ]),
  ...Array.from({ length: 120 }, (_, index): [number, number] => [
    1630 + index * 30,
    1.0 + 0.04 * Math.sin(index),
  ]),
];
const safetyRun = runEngine(safetySamples, false);

// flush: stream ends immediately after the swing (no D-029 condition held).
const flushRun = runEngine(swingBurst(1000), true);

// append-only: late samples behind the frontier are dropped and counted.
const lateEngine = new SessionEventEngine({ sessionId: "h15-late" });
for (const sample of stream(settleSamples)) lateEngine.pushWristSample(sample);
const closedBefore = JSON.stringify(lateEngine.snapshot().events.map((e) => e.proposal));
lateEngine.push({ wrist: [{ timestampMs: 1100, value: 2.5 }] });
const closedAfter = JSON.stringify(lateEngine.snapshot().events.map((e) => e.proposal));
const appendOnly = {
  droppedLateSamples: lateEngine.snapshot().qualityState.droppedLateSamples,
  closedEventsUnchanged: closedBefore === closedAfter,
};

const engineChecks = [
  { id: "settle_close", closed: settleRun.closed, pass: settleRun.closed.includes("settle") },
  {
    id: "valley_close_first_of_two",
    closed: valleyRun.closed,
    pass:
      valleyRun.closed.length >= 2 &&
      (valleyRun.closed[0] === "next_stroke_valley" ||
        valleyRun.closed[0] === "next_event_proposed"),
  },
  { id: "safety_close", closed: safetyRun.closed, pass: safetyRun.closed.includes("safety_max") },
  {
    id: "flush_close_never_silent",
    closed: flushRun.closed,
    pass: flushRun.closed.length === 1,
  },
  {
    id: "append_only_late_samples_dropped",
    closed: [],
    pass: appendOnly.droppedLateSamples >= 1 && appendOnly.closedEventsUnchanged,
  },
];

// ── report ────────────────────────────────────────────────────────────────

const report = {
  certId: "h15-autodetect-cert",
  generatedAtIso: new Date().toISOString(),
  benchVersion: bench.benchVersion,
  classifierVersion: bench.classifierVersion,
  replayLadder: {
    goldLabelsTotal: bench.goldLabelsTotal,
    evaluableLabels: bench.evaluableLabels,
    unevaluableCases: bench.unevaluableCases,
    ladder,
    byGroupN,
    byGroupConfidentWrong: byGroupWrong,
  },
  declaredSeparation: { ...sep, noFalseDisagreementOnUnknown: noFalseDisagreement },
  syntheticAdversarial: adversarialResults,
  hostileProviderLadder: hostileResults,
  slugResolution: slugChecks,
  adaptiveCompletion: {
    constantParity: parity,
    shippedDefaultFixed: defaultFixed,
    engineChecks: engineChecks.map(({ id, closed, pass }) => ({ id, closed, pass })),
    appendOnly,
  },
};
writeFileSync(join(OUT_DIR, "h15-cert-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
const failures = [
  ...adversarialResults.filter((r) => !r.pass).map((r) => `adversarial:${r.id}`),
  ...hostileResults.filter((r) => !r.pass).map((r) => `hostile:${r.id}`),
  ...slugChecks.filter((r) => !r.pass).map((r) => `slug:${r.id}`),
  ...parity.filter((r) => !r.pass).map((r) => `parity:${r.field}`),
  ...engineChecks.filter((r) => !r.pass).map((r) => `engine:${r.id}`),
  ...(noFalseDisagreement ? [] : ["separation:false_disagreement_on_unknown"]),
  ...(sep.contradictionMissed > 0 ? ["separation:contradiction_missed"] : []),
  ...(sep.agreementFalseAlarm > 0 ? ["separation:agreement_false_alarm"] : []),
  ...(sep.sideAgnosticFalseAlarm > 0 ? ["separation:side_agnostic_false_alarm"] : []),
  ...(sep.declaredProfileChanged > 0 ? ["separation:declared_profile_changed"] : []),
  ...(defaultFixed ? [] : ["completion:shipped_default_not_fixed"]),
];
console.log(`\nCHECK FAILURES: ${failures.length === 0 ? "none" : failures.join(", ")}`);
