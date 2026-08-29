// G02 — F09 OWNERSHIP ORACLE HARNESS (wave-g, Linux, research-only).
//
// Question: would PERFECT paddle ownership eliminate the F09 residual
// (adversarial contact failures attributed to the paddle track carrying a
// foreign — opponent-owned — paddle)?
//
// Three measurements, all against the REAL estimateContact code path
// (contact-evidence-4.3, packages/vision-geometry/src/offlineStroke.ts):
//
//  (a) CURRENT ownership accuracy — the incumbent frame-level S3 wrist-ratio
//      analog replayed on the committed dual-labeled ownership gold
//      (ownershipBench, corrections applied), counts reported. Oracle
//      ownership is 100% correct on the same frames BY CONSTRUCTION (it IS
//      the gold label) — stated, not "measured".
//
//  (b) Adversarial contact fixtures — the 10 committed synthetic fixtures
//      (all of whose paddle samples are target-owned by construction) PLUS
//      reconstructions of the two committed red-team foreign-paddle attacks
//      (beyond-reach F2; within-reach F3 residual), whose paddle samples are
//      foreign by construction. Conditions: CURRENT (tracks as the attack
//      supplies them) vs ORACLE ownership (foreign samples removed — with
//      perfect ownership the target's paddle is simply untracked there).
//
//  (c) Every replayable committed contact gold event (16 events, 8 bundles,
//      5 sessions; held-out wm-dink-01 / afn-vic-rally1 never read) under
//      three paddle conditions: CURRENT (no paddle modality — no committed
//      paddle track exists on Linux, exactly the e02/f16 replay condition),
//      ORACLE ownership (gold TARGET paddle points from the committed
//      ownership annotations fed as paddleCenters), and WRONG ownership
//      (gold OTHER paddle points fed instead — a perfect-ownership-failure
//      lower bound quantifying downstream sensitivity).
//
// Run:  cd packages/vision-geometry && \
//       npx tsx ../../datasets/experiments/wave-g/g02-f09-oracle-run.ts
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BallObservation } from "@pickle/swing-domain";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import {
  generateAdversarialContactFixtures,
  generateSwingSequence,
} from "../../../packages/evaluation/src/index.js";
import {
  CONTACT_ESTIMATOR_VERSION,
  estimateContact,
} from "../../../packages/vision-geometry/src/index.js";
import {
  loadBallObservations,
  loadGoldEvents,
  quantile,
  type GoldContactEvent,
} from "../../../packages/vision-geometry/eval/contactGoldReplay.js";
import {
  applyOwnershipCorrections,
  runBench,
  type AnnotationPass,
  type OwnershipCorrectionSet,
} from "../../../packages/swing-lab/src/ownershipBench.js";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
} from "../../../packages/swing-lab/src/playerTracker.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const PB = join(ROOT, "datasets/paddle-bench");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-g");

const HELD_OUT = new Set(["wm-dink-01", "afn-vic-rally1"]);
const STRICT_MS = 66;
const ACCEPT_MS = 132;
const CONFIDENT_WRONG_ERROR_MS = 150;
const CONFIDENT_WRONG_CONFIDENCE = 0.6;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

// ── (a) ownership accuracy: incumbent replay on dual-labeled gold ─────────

const ownershipReport = runBench(false, true);
const incumbent = ownershipReport.poseSubsetMethods.find(
  (method) => method.method === "incumbent_wrist_ratio",
)!;
const incumbentAll = ownershipReport.methods.find(
  (method) => method.method === "incumbent_wrist_ratio",
)!;

// ── (b) adversarial fixtures: current vs oracle ownership ─────────────────

interface OracleFixture {
  id: string;
  source: "committed_generator" | "reconstructed_redteam";
  /** Ownership truth of every paddle sample, from construction. */
  paddleOwnershipTruth: "target" | "foreign" | "none";
  trueContactMs: number;
  run: (oracle: boolean) => ReturnType<typeof estimateContact>;
}

function speedsOf(
  centers: ReadonlyArray<{ timestampMs: number; x: number; y: number }>,
): Array<{ timestampMs: number; value: number }> {
  const speeds: Array<{ timestampMs: number; value: number }> = [];
  for (let index = 1; index < centers.length; index += 1) {
    const previous = centers[index - 1]!;
    const current = centers[index]!;
    const dtMs = current.timestampMs - previous.timestampMs;
    if (dtMs <= 0) continue;
    speeds.push({
      timestampMs: (current.timestampMs + previous.timestampMs) / 2,
      value: (Math.hypot(current.x - previous.x, current.y - previous.y) / dtMs) * 1000,
    });
  }
  return speeds;
}

const fixtures: OracleFixture[] = [];

for (const fixture of generateAdversarialContactFixtures()) {
  const owned = fixture.paddleCenters !== null && fixture.paddleCenters.length > 0;
  fixtures.push({
    id: fixture.id,
    source: "committed_generator",
    // Every generator paddle track is derived from the target's own wrist
    // (paddleFromWrist) — target-owned by construction.
    paddleOwnershipTruth: owned ? "target" : "none",
    trueContactMs: fixture.trueContactMs,
    run: () =>
      estimateContact({
        sequence: fixture.sequence,
        window: fixture.window,
        ballObservations: fixture.ballObservations,
        paddleSpeeds: fixture.paddleSpeeds,
        paddleCenters: fixture.paddleCenters,
        targetWrists: fixture.targetWrists,
        strokeFamily: fixture.strokeFamily,
      }),
  });
}

// Reconstruction of the committed red-team F2 attack (contactRedTeam.test.ts
// "rejects a paddle track beyond reach…"): the paddle track switched to the
// OPPONENT's paddle across the court; ball turns at the opponent's hit
// truth+600ms. All paddle samples are foreign by construction.
{
  const { sequence, window } = generateSwingSequence();
  const oppHitMs = window.peakMs + 600;
  const paddleCenters = Array.from({ length: 70 }, (_, i) => {
    const t = window.startMs + i * 30;
    const arc = Math.exp(-((t - oppHitMs) ** 2) / (2 * 100 * 100));
    return { timestampMs: t, x: 0.05 + 0.1 * arc, y: 0.18 - 0.03 * arc };
  });
  const ball: BallObservation[] = [];
  let frameIndex = 0;
  for (let t = oppHitMs - 400; t <= oppHitMs + 300; t += 30) {
    const before = t <= oppHitMs;
    const raw = before ? (t - (oppHitMs - 400)) / 400 : (t - oppHitMs) / 300;
    ball.push({
      frameIndex: frameIndex++,
      timestampMs: t,
      x: before ? 0.6 - 0.45 * raw : 0.15 + 0.3 * raw,
      y: before ? 0.55 - 0.4 * raw : 0.15 + 0.1 * raw,
      confidence: 0.8,
    });
  }
  fixtures.push({
    id: "foreign-paddle-beyond-reach (e09 F2)",
    source: "reconstructed_redteam",
    paddleOwnershipTruth: "foreign",
    trueContactMs: window.peakMs,
    run: (oracle) =>
      estimateContact({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs + 500, peakMotionMs: window.peakMs },
        ballObservations: ball,
        paddleSpeeds: oracle ? null : speedsOf(paddleCenters),
        paddleCenters: oracle ? null : paddleCenters,
      }),
  });
}

// Reconstruction of the committed F3 residual (contactRedTeam.test.ts "F3
// residual (documented RED)"): a foreign paddle WITHIN reach of the target's
// idle off-hand wrist; ball turns at the opponent's hit truth+600ms near that
// idle wrist. All paddle samples are foreign by construction.
{
  const { sequence, window } = generateSwingSequence();
  const idleWrist = sequence.frames
    .map((frame) => frame.landmarks.find((mark) => mark.name === "left_wrist"))
    .find((mark): mark is NonNullable<typeof mark> => mark !== undefined)!;
  const oppHitMs = window.peakMs + 600;
  const paddleCenters = Array.from({ length: 70 }, (_, i) => {
    const t = window.startMs + i * 30;
    const arc = Math.exp(-((t - oppHitMs) ** 2) / (2 * 100 * 100));
    return {
      timestampMs: t,
      x: idleWrist.x - 0.12 - 0.1 * arc,
      y: idleWrist.y + 0.05 - 0.03 * arc,
    };
  });
  const hitAt = { x: idleWrist.x - 0.22, y: idleWrist.y + 0.02 };
  const ball: BallObservation[] = [];
  let frameIndex = 0;
  for (let t = oppHitMs - 400; t <= oppHitMs + 300; t += 30) {
    const before = t <= oppHitMs;
    const raw = before ? (t - (oppHitMs - 400)) / 400 : (t - oppHitMs) / 300;
    ball.push({
      frameIndex: frameIndex++,
      timestampMs: t,
      x: before ? hitAt.x + 0.4 - 0.4 * raw : hitAt.x + 0.35 * raw,
      y: before ? hitAt.y - 0.35 + 0.35 * raw : hitAt.y - 0.3 * raw,
      confidence: 0.8,
    });
  }
  fixtures.push({
    id: "foreign-paddle-within-reach (F3 residual)",
    source: "reconstructed_redteam",
    paddleOwnershipTruth: "foreign",
    trueContactMs: window.peakMs,
    run: (oracle) =>
      estimateContact({
        sequence,
        window: { startMs: window.startMs, endMs: window.endMs + 500, peakMotionMs: window.peakMs },
        ballObservations: ball,
        paddleSpeeds: oracle ? null : speedsOf(paddleCenters),
        paddleCenters: oracle ? null : paddleCenters,
      }),
  });
}

interface FixtureConditionRow {
  status: "estimated" | "abstained";
  estimatedContactMs: number | null;
  errorMs: number | null;
  confidence: number | null;
  ballConfirmed: boolean | null;
  paddleConfirmed: boolean | null;
  confidentWrong: boolean;
  modalityConfirmedWrong: boolean;
  reason: string | null;
  limitingFactors: string[];
  supportingEvidence: Array<{ signal: string; timestampMs: number; weight: number }>;
}

function evidenceOf(
  estimate: ReturnType<typeof estimateContact>,
): Array<{ signal: string; timestampMs: number; weight: number }> {
  if (estimate.status !== "estimated") return [];
  return estimate.supportingEvidence.map((signal) => ({
    signal: signal.signal,
    timestampMs: Math.round(signal.timestampMs),
    weight: round3(signal.weight),
  }));
}

function fixtureRow(
  estimate: ReturnType<typeof estimateContact>,
  trueContactMs: number,
): FixtureConditionRow {
  if (estimate.status !== "estimated") {
    return {
      status: "abstained",
      estimatedContactMs: null,
      errorMs: null,
      confidence: null,
      ballConfirmed: null,
      paddleConfirmed: null,
      confidentWrong: false,
      modalityConfirmedWrong: false,
      reason: estimate.reason,
      limitingFactors: estimate.limitingFactors ?? [],
      supportingEvidence: [],
    };
  }
  const errorMs = Math.abs(estimate.estimatedContactMs - trueContactMs);
  return {
    status: "estimated",
    estimatedContactMs: Math.round(estimate.estimatedContactMs),
    errorMs: Math.round(errorMs),
    confidence: round3(estimate.confidence),
    ballConfirmed: estimate.ballConfirmed,
    paddleConfirmed: estimate.paddleConfirmed,
    confidentWrong:
      errorMs > CONFIDENT_WRONG_ERROR_MS && estimate.confidence >= CONFIDENT_WRONG_CONFIDENCE,
    modalityConfirmedWrong:
      errorMs > CONFIDENT_WRONG_ERROR_MS && (estimate.ballConfirmed || estimate.paddleConfirmed),
    reason: null,
    limitingFactors: estimate.limitingFactors,
    supportingEvidence: evidenceOf(estimate),
  };
}

const fixtureRows = fixtures.map((fixture) => ({
  id: fixture.id,
  source: fixture.source,
  paddleOwnershipTruth: fixture.paddleOwnershipTruth,
  trueContactMs: Math.round(fixture.trueContactMs),
  current: fixtureRow(fixture.run(false), fixture.trueContactMs),
  oracle: fixtureRow(fixture.run(true), fixture.trueContactMs),
}));

function fixtureTotals(rows: typeof fixtureRows, condition: "current" | "oracle") {
  const picked = rows.map((row) => row[condition]);
  return {
    n: picked.length,
    estimated: picked.filter((row) => row.status === "estimated").length,
    abstained: picked.filter((row) => row.status === "abstained").length,
    confidentWrong: picked.filter((row) => row.confidentWrong).length,
    modalityConfirmedWrong: picked.filter((row) => row.modalityConfirmedWrong).length,
  };
}

// ── (c) committed contact gold under three paddle-ownership conditions ────

interface OwnershipPoints {
  target: Array<{ timestampMs: number; x: number; y: number }>;
  other: Array<{ timestampMs: number; x: number; y: number }>;
}

interface RawAnnotation {
  kind?: string;
  annotatorId?: string;
  paddleFrames?: Array<{ tMs: number; point: { x: number; y: number } | null; visibility: string }>;
  otherPaddleFrames?: Array<{
    tMs: number;
    point: { x: number; y: number } | null;
    visibility: string;
  }>;
}

/** All committed gold paddle points per owner for a bundle, waveE corrections
 *  applied, duplicate annotator passes at the same instant deduped (<10ms). */
function loadOwnershipPoints(bundle: string): OwnershipPoints {
  const annotationDir = join(PB, "bundles", bundle, "annotation");
  const points: OwnershipPoints = { target: [], other: [] };
  if (!existsSync(annotationDir)) return points;
  const passes: AnnotationPass[] = [];
  const correctionSets: OwnershipCorrectionSet[] = [];
  for (const file of readdirSync(annotationDir).filter((name) => name.endsWith(".json"))) {
    const parsed = JSON.parse(readFileSync(join(annotationDir, file), "utf8")) as RawAnnotation;
    if (parsed.kind === "ownership-correction-set") {
      correctionSets.push(parsed as unknown as OwnershipCorrectionSet);
      continue;
    }
    if (!parsed.paddleFrames && !parsed.otherPaddleFrames) continue;
    passes.push({
      annotatorId: parsed.annotatorId ?? file,
      paddleFrames: parsed.paddleFrames ?? [],
      otherPaddleFrames: parsed.otherPaddleFrames ?? [],
    });
  }
  if (correctionSets.length > 0) applyOwnershipCorrections(passes, correctionSets);
  for (const pass of passes) {
    for (const [owner, frames] of [
      ["target", pass.paddleFrames],
      ["other", pass.otherPaddleFrames],
    ] as const) {
      for (const frame of frames) {
        if (frame.visibility !== "visible" || !frame.point) continue;
        const duplicate = points[owner].some(
          (existing) =>
            Math.abs(existing.timestampMs - frame.tMs) < 10 &&
            Math.hypot(existing.x - frame.point!.x, existing.y - frame.point!.y) < 0.01,
        );
        if (!duplicate) {
          points[owner].push({ timestampMs: frame.tMs, x: frame.point.x, y: frame.point.y });
        }
      }
    }
  }
  points.target.sort((a, b) => a.timestampMs - b.timestampMs);
  points.other.sort((a, b) => a.timestampMs - b.timestampMs);
  return points;
}

const SESSION: Record<string, string> = {
  "wavea-944403-dink": "dvids-944403",
  "wavea-944403-smash": "dvids-944403",
  "wavea-faead-feed": "dvids-faead",
  "wavea-faead-rally": "dvids-faead",
  "wavea-marne-dig": "dvids-marne",
  "wavea-marne-serve": "dvids-marne",
  "wavea-sasebo-volleys": "dvids-sasebo",
  "wavea-wgm-wheelchair": "dvids-wgm",
};

interface LegacyFrame {
  timestampMs: number;
  landmarks: Array<{ name: string; x: number; y: number; visibility: number }>;
}

function wristSeries(frames: LegacyFrame[]): Array<{ timestampMs: number; x: number; y: number }> {
  const series: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of frames) {
    for (const name of ["left_wrist", "right_wrist"]) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (joint) series.push({ timestampMs: frame.timestampMs, x: joint.x, y: joint.y });
    }
  }
  return series;
}

function wristSpeedPeakMs(frames: LegacyFrame[]): number | null {
  let best: { tMs: number; speed: number } | null = null;
  for (const name of ["left_wrist", "right_wrist"]) {
    let previous: { tMs: number; x: number; y: number } | null = null;
    for (const frame of frames) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (!joint) continue;
      if (previous && frame.timestampMs > previous.tMs) {
        const dt = (frame.timestampMs - previous.tMs) / 1000;
        const speed = Math.hypot(joint.x - previous.x, joint.y - previous.y) / dt;
        if (!best || speed > best.speed) best = { tMs: frame.timestampMs, speed };
      }
      previous = { tMs: frame.timestampMs, x: joint.x, y: joint.y };
    }
  }
  return best?.tMs ?? null;
}

type GoldCondition = "current_no_paddle" | "oracle_ownership" | "wrong_ownership";

interface GoldRow {
  bundle: string;
  session: string;
  goldContactMs: number;
  owner: "target" | "other";
  family: string;
  paddlePointsInWindow: number;
  status: "estimated" | "abstained";
  estimatedContactMs: number | null;
  errorMs: number | null;
  confidence: number | null;
  ballConfirmed: boolean | null;
  paddleConfirmed: boolean | null;
  reason: string | null;
  limitingFactors: string[];
  supportingEvidence: Array<{ signal: string; timestampMs: number; weight: number }>;
}

function replayGold(condition: GoldCondition): GoldRow[] {
  const pad = 250;
  const rows: GoldRow[] = [];
  const gold = loadGoldEvents();
  for (const bundle of Object.keys(SESSION)) {
    if (HELD_OUT.has(bundle)) continue;
    const peoplePath = join(PB, "runs-wave-a", bundle, "people.json");
    if (!existsSync(peoplePath)) continue;
    const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const tracks = buildPlayerTracks(people);
    if (tracks.length === 0) continue;
    const target = [...tracks].sort(
      (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
    )[0]!;
    const sequence = targetPoseSequence(people, target);
    const ball = loadBallObservations(bundle);
    const ownership = loadOwnershipPoints(bundle);

    for (const event of gold.filter((candidate) => candidate.bundle === bundle)) {
      const startMs = event.eventStartMs - pad;
      const endMs = event.eventEndMs + pad;
      const frames = toLegacyPoseFrames(sequence).filter(
        (frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs,
      ) as LegacyFrame[];
      const peakMotionMs = wristSpeedPeakMs(frames);
      const pool =
        condition === "oracle_ownership"
          ? ownership.target
          : condition === "wrong_ownership"
            ? ownership.other
            : [];
      const inWindow = pool.filter(
        (point) => point.timestampMs >= startMs && point.timestampMs <= endMs,
      );
      const paddleCenters = inWindow.length > 0 ? inWindow : null;
      const paddleSpeeds =
        paddleCenters && paddleCenters.length >= 2 ? speedsOf(paddleCenters) : null;

      const estimate = estimateContact({
        sequence,
        window: { startMs, endMs, peakMotionMs },
        ballObservations: ball.length > 0 ? ball : null,
        paddleSpeeds: paddleSpeeds && paddleSpeeds.length > 0 ? paddleSpeeds : null,
        paddleCenters,
        targetWrists: wristSeries(frames),
        strokeFamily: event.family,
      });

      rows.push({
        bundle,
        session: event.session,
        goldContactMs: event.contactMs,
        owner: event.owner,
        family: event.family,
        paddlePointsInWindow: inWindow.length,
        status: estimate.status === "estimated" ? "estimated" : "abstained",
        estimatedContactMs:
          estimate.status === "estimated" ? Math.round(estimate.estimatedContactMs) : null,
        errorMs:
          estimate.status === "estimated"
            ? Math.round(Math.abs(estimate.estimatedContactMs - event.contactMs))
            : null,
        confidence: estimate.status === "estimated" ? round3(estimate.confidence) : null,
        ballConfirmed: estimate.status === "estimated" ? estimate.ballConfirmed : null,
        paddleConfirmed: estimate.status === "estimated" ? estimate.paddleConfirmed : null,
        reason: estimate.status === "estimated" ? null : estimate.reason,
        limitingFactors: estimate.limitingFactors ?? [],
        supportingEvidence: evidenceOf(estimate),
      });
    }
  }
  return rows;
}

function goldMetrics(rows: GoldRow[]) {
  const estimated = rows.filter((row) => row.status === "estimated");
  const errors = estimated.map((row) => row.errorMs!).sort((a, b) => a - b);
  const wrong = estimated.filter((row) => row.errorMs! > ACCEPT_MS);
  return {
    events: rows.length,
    estimated: estimated.length,
    abstained: rows.length - estimated.length,
    strictHits: errors.filter((error) => error <= STRICT_MS).length,
    acceptableHits: errors.filter((error) => error <= ACCEPT_MS).length,
    wrongMarkers: wrong.length,
    confidentWrongMarkers: estimated.filter(
      (row) => row.errorMs! > ACCEPT_MS && row.confidence! >= 0.7,
    ).length,
    medianErrorMs: errors.length > 0 ? Math.round(quantile(errors, 0.5)!) : null,
    p90ErrorMs: errors.length > 0 ? Math.round(quantile(errors, 0.9)!) : null,
  };
}

const goldConditions: GoldCondition[] = [
  "current_no_paddle",
  "oracle_ownership",
  "wrong_ownership",
];
const goldRuns = Object.fromEntries(
  goldConditions.map((name) => [name, replayGold(name)]),
) as Record<GoldCondition, GoldRow[]>;

const goldEvents: GoldContactEvent[] = loadGoldEvents();

const artifact = {
  experiment: "g02-f09-oracle",
  estimatorVersion: CONTACT_ESTIMATOR_VERSION,
  commit: execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim(),
  evaluatedAtIso: new Date().toISOString(),
  heldOut: "wm-dink-01 and afn-vic-rally1 never read",
  ownershipAccuracy: {
    method:
      "incumbent_wrist_ratio (frame-level S3 analog), ownershipBench v1, corrections applied, dev groups only",
    dualFrames: ownershipReport.dualFrames,
    framesWithPose: ownershipReport.framesWithPose,
    poseSubset: {
      scoredFrames: incumbent.scoredFrames,
      correct: incumbent.correct,
      abstained: incumbent.abstained,
      accuracy: incumbent.accuracy,
      accuracyWhenAnswering: incumbent.accuracyWhenAnswering,
      byGroup: incumbent.byGroup,
    },
    allFrames: {
      scoredFrames: incumbentAll.scoredFrames,
      correct: incumbentAll.correct,
      abstained: incumbentAll.abstained,
      accuracy: incumbentAll.accuracy,
    },
    oracleStatement:
      "Oracle ownership on these frames is the gold label itself: 100% correct by construction, not a measurement.",
  },
  adversarialFixtures: {
    fixtures: fixtureRows.length,
    foreignPaddleFixtures: fixtureRows.filter((row) => row.paddleOwnershipTruth === "foreign")
      .length,
    totals: {
      current: fixtureTotals(fixtureRows, "current"),
      oracle: fixtureTotals(fixtureRows, "oracle"),
    },
    rows: fixtureRows,
  },
  committedGold: {
    goldEvents: goldEvents.length,
    condition: {
      pose: "committed runs-wave-a people.json (auto target policy) — e02/f16 replay condition",
      ball: "ORACLE ball (gold annotation frames, conf 0.9)",
      paddle: {
        current_no_paddle: "no paddle modality (no committed paddle track exists on Linux)",
        oracle_ownership:
          "gold TARGET paddle points (committed ownership annotations, corrections applied) as paddleCenters (+speeds where >=2 in-window points)",
        wrong_ownership:
          "gold OTHER paddle points fed as the 'target' paddle — a perfect ownership FAILURE, quantifying downstream sensitivity",
      },
      toleranceMs: { strict: STRICT_MS, acceptable: ACCEPT_MS },
      grouping: "bundle/session (no random-frame splits)",
    },
    metrics: Object.fromEntries(goldConditions.map((name) => [name, goldMetrics(goldRuns[name])])),
    metricsTargetOnly: Object.fromEntries(
      goldConditions.map((name) => [
        name,
        goldMetrics(goldRuns[name].filter((row) => row.owner === "target")),
      ]),
    ),
    paddlePointAvailability: Object.fromEntries(
      goldConditions
        .filter((name) => name !== "current_no_paddle")
        .map((name) => [
          name,
          {
            eventsWithAnyPaddlePoint: goldRuns[name].filter((row) => row.paddlePointsInWindow > 0)
              .length,
            eventsWithZero: goldRuns[name].filter((row) => row.paddlePointsInWindow === 0).length,
          },
        ]),
    ),
    rows: goldRuns,
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "g02-f09-oracle-results.json");
writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(
  "ownership incumbent (pose subset):",
  JSON.stringify(artifact.ownershipAccuracy.poseSubset),
);
console.log("fixtures:", JSON.stringify(artifact.adversarialFixtures.totals));
for (const name of goldConditions) {
  console.log(name, JSON.stringify(artifact.committedGold.metrics[name]));
}
console.log(`written: ${outPath}`);
