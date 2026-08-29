// G19 — ORACLE WATERFALL on the Linux-replayable DEV evaluation set.
//
// For every DEV gold TARGET event replayable from committed artifacts, this
// harness computes a usable-result-v1-style verdict end-to-end (EVENT →
// CONTACT → PHASE → STROKE composed from the real stage implementations),
// then substitutes ONE perfect stage at a time (oracle = construction truth /
// committed gold labels) and re-runs everything downstream of the
// substitution. The output is a ranked frontier-attribution table: which
// single-oracle substitution recovers the most non-usable Results.
//
// Run (from packages/swing-lab, its tsx + deps):
//   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-g/g19-oracle-waterfall.ts
//
// MEASUREMENT BOUNDARY (disclosed, same as wave-f f16):
//  - NOT the canonical Mac n=5 strict cascade. Pose exists only for the 8
//    wave-a windowed bundles (runs-wave-a/<case>/people.json) plus the W6
//    replay-validated rally1 wrist fixture; the canonical run dirs are
//    gitignored/absent on Linux.
//  - Baseline modality reality on Linux: paddle track ABSENT (never zeroed,
//    passed as null) and ball tracker inputs ABSENT (ballObservations null at
//    baseline). The ORACLE BALL condition injects the visually-verified gold
//    ball frames (confidence 0.9 by construction — same condition as e02/f16).
//  - TARGET and OWNERSHIP oracles are structural no-ops on this set: the
//    committed windowed bundles were built so the auto-target policy resolves
//    the annotator-verified player, and the wrist series is target-attributed
//    by construction. PADDLE oracle is NOT CONSTRUCTIBLE here (no committed
//    paddle truth series exists). All three are reported, never guessed.
//  - Held-out cases (wm-dink-01, afn-vic-rally1) are never read: wave-a
//    bundles exclude them by construction and paddle-bench.json roles
//    held_out/test_held_out are skipped.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "../../../packages/swing-lab/src/engine/corpus.js";
import { dominantWristSpeeds } from "../../../packages/swing-lab/src/engine/minerCore.js";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
  type PlayerTrack,
} from "../../../packages/swing-lab/src/playerTracker.js";
import { proposeStrokeEventsV2 } from "../../../packages/swing-lab/src/strokeEvents.js";
import { segmentPhasesTemporalV2 } from "../../../packages/swing-lab/src/phaseTemporal.js";
import { classifyStroke } from "../../../packages/swing-lab/src/strokeHeuristic.js";
import type { StrokePrediction } from "../../../packages/swing-lab/src/strokeHeuristic.js";
import {
  loadStrokeGold,
  loadCaseHandedness,
  pickTargetTrack,
  goldL1Class,
  predictedL1Class,
  type BenchL1,
} from "../../../packages/swing-lab/src/strokeHeuristicBench.js";
import type {
  StrokeEventLabel,
  SwingAnnotation,
} from "../../../packages/swing-lab/src/annotationSchema.js";
import { estimateContact, type StrokeFamily } from "../../../packages/vision-geometry/src/index.js";
import { loadBallObservations } from "../../../packages/vision-geometry/eval/contactGoldReplay.js";
import { toLegacyPoseFrames, type BallObservation } from "@pickle/swing-domain";

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const RALLY1_FIXTURE = "apps/mobile/__tests__/fixtures/sessionReplay.afn-sasebo-rally1.json";
const CONTACT_PAD_MS = 250;

type Oracle = "NONE" | "EVENT" | "BALL" | "CONTACT" | "STROKE";
const MEASURABLE_ORACLES: Exclude<Oracle, "NONE">[] = ["EVENT", "BALL", "CONTACT", "STROKE"];

interface Speed {
  timestampMs: number;
  value: number;
}

interface BenchCase {
  id: string;
  labels: string;
  runDir: string;
  role?: string;
}

interface EventContext {
  eventKey: string;
  caseId: string;
  gold: StrokeEventLabel;
  goldStrokeL1: string | null; // stroke-gold l1 (null = no stroke gold for this event)
  goldBenchL1: BenchL1 | null; // OVERHEAD | SWING | null (gold unknown / missing)
  family: StrokeFamily;
  wristSpeeds: Speed[];
  signalSource: string;
  pose: { file: PeopleFile; track: PlayerTrack } | null; // null → wrist-only (rally1 fixture)
  handedness: "right" | "left";
  ball: BallObservation[]; // committed gold ball frames (oracle condition only)
  proposals: Array<{ startMs: number; endMs: number; peakMs: number }>;
}

interface StageTrace {
  event: {
    pass: boolean;
    window: { startMs: number; endMs: number } | null;
    bestOverlap: number | null;
    contactInside: boolean | null;
    detail: string;
  };
  contact: {
    status: "estimated" | "abstained" | "not_runnable" | "oracle";
    estimatedContactMs: number | null;
    errorMs: number | null;
    ballConfirmed: boolean;
    paddleConfirmed: boolean;
    detail: string;
  };
  phase: { status: "segmented" | "abstained" | "not_run"; orderingValid: boolean; detail: string };
  stroke: {
    state: "committed" | "abstained" | "oracle" | "not_runnable";
    predictedLabel: string | null;
    l1Verdict: "correct" | "wrong" | "abstained" | "unverifiable";
    detail: string;
  };
}

interface UsableVerdict {
  usable: boolean;
  replayClause: "a" | "b" | "c" | null;
  reasons: string[];
}

function overlapOfGold(
  proposal: { startMs: number; endMs: number },
  label: { eventStartMs: number; eventEndMs: number },
): number {
  const overlap =
    Math.min(proposal.endMs, label.eventEndMs) - Math.max(proposal.startMs, label.eventStartMs);
  return overlap / (label.eventEndMs - label.eventStartMs);
}

function familyFromL1(l1: string | null): StrokeFamily {
  if (l1 === null) return "unknown";
  if (l1 === "overhead_lob") return "overhead";
  if (l1 === "serve") return "serve";
  if (l1 === "dink") return "dink";
  if (l1 === "volley") return "volley";
  if (l1 === "drive") return "drive";
  return "unknown";
}

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

function loadContexts(): {
  contexts: EventContext[];
  heldOutExcluded: string[];
  notReplayable: string[];
} {
  const cases: BenchCase[] = [];
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: BenchCase[];
  };
  cases.push(...bench.cases);
  const waveAPath = join(PB, "event-bounds-wave-a.json");
  if (existsSync(waveAPath)) {
    cases.push(...(JSON.parse(readFileSync(waveAPath, "utf8")) as { cases: BenchCase[] }).cases);
  }

  const strokeGold = loadStrokeGold();
  const heldOutExcluded: string[] = [];
  const notReplayable: string[] = [];
  const contexts: EventContext[] = [];

  for (const benchCase of cases) {
    if (benchCase.role === "held_out" || benchCase.role === "test_held_out") {
      heldOutExcluded.push(benchCase.id);
      continue;
    }
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation & { eventLabels?: StrokeEventLabel[] };
    const allLabels = annotation.eventLabels ?? [];
    const targetGold = allLabels
      .map((label, index) => ({ label, eventKey: `${benchCase.id}#${index + 1}` }))
      .filter((entry) => entry.label.owner === "target");
    if (targetGold.length === 0) continue;

    // Signal: committed windowed pose, else the replay-validated rally1 fixture.
    const peoplePath = resolve(PB, benchCase.runDir, "people.json");
    let speeds: Speed[] | null = null;
    let signalSource = "";
    let pose: EventContext["pose"] = null;
    if (existsSync(peoplePath)) {
      const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
      const tracks = buildPlayerTracks(people);
      const target = pickTargetTrack(tracks);
      if (target) {
        pose = { file: people, track: target };
        speeds = dominantWristSpeeds(targetPoseSequence(people, target).frames);
        signalSource = `${benchCase.runDir}/people.json`;
      }
    } else if (benchCase.id === "afn-sasebo-rally1") {
      const fixture = JSON.parse(readFileSync(join(REPO_ROOT, RALLY1_FIXTURE), "utf8")) as {
        wristSamples: Array<{ tMs: number; v: number }>;
      };
      speeds = fixture.wristSamples.map((sample) => ({
        timestampMs: sample.tMs,
        value: sample.v,
      }));
      signalSource = RALLY1_FIXTURE;
    }
    if (!speeds || speeds.length === 0) {
      notReplayable.push(benchCase.id);
      continue;
    }

    const clipStart = speeds[0]!.timestampMs;
    const clipEnd = speeds[speeds.length - 1]!.timestampMs;
    const { events } = proposeStrokeEventsV2({
      paddleSpeeds: null,
      wristSpeeds: speeds,
      clipStartMs: clipStart,
      clipEndMs: clipEnd,
    });
    const proposals = events.map((event) => ({
      startMs: event.startMs,
      endMs: event.endMs,
      peakMs: event.peakMs,
    }));
    const ball = pose ? loadBallObservations(benchCase.id) : [];
    const handedness = loadCaseHandedness(benchCase.id) ?? "right";

    for (const entry of targetGold) {
      const goldStroke =
        strokeGold.labels.find(
          (label) =>
            label.caseId === benchCase.id &&
            label.owner === "target" &&
            label.eventStartMs === entry.label.eventStartMs &&
            label.eventEndMs === entry.label.eventEndMs,
        ) ?? null;
      contexts.push({
        eventKey: entry.eventKey,
        caseId: benchCase.id,
        gold: entry.label,
        goldStrokeL1: goldStroke?.l1 ?? null,
        goldBenchL1: goldStroke ? goldL1Class(goldStroke.l1) : null,
        family: familyFromL1(goldStroke?.l1 ?? null),
        wristSpeeds: speeds,
        signalSource,
        pose,
        handedness,
        ball,
        proposals,
      });
    }
  }
  return { contexts, heldOutExcluded, notReplayable };
}

function runPipeline(context: EventContext, oracle: Oracle): StageTrace {
  const gold = context.gold;

  // ── EVENT ──
  let window: { startMs: number; endMs: number } | null = null;
  let eventPass = false;
  let bestOverlap: number | null = null;
  let contactInside: boolean | null = null;
  let eventDetail = "";
  if (oracle === "EVENT") {
    window = { startMs: gold.eventStartMs, endMs: gold.eventEndMs };
    eventPass = true;
    eventDetail = "ORACLE: gold event bounds substituted";
  } else {
    const overlapping = context.proposals
      .map((proposal) => ({ proposal, fraction: overlapOfGold(proposal, gold) }))
      .filter((candidate) => candidate.fraction > 0.3)
      .sort((a, b) => b.fraction - a.fraction);
    const best = overlapping[0] ?? null;
    bestOverlap = best ? Number(best.fraction.toFixed(2)) : null;
    contactInside =
      best !== null && gold.contactMs !== null
        ? gold.contactMs >= best.proposal.startMs - 60 && gold.contactMs <= best.proposal.endMs + 60
        : null;
    eventPass = best !== null && (best.fraction >= 0.5 || contactInside === true);
    window = best ? { startMs: best.proposal.startMs, endMs: best.proposal.endMs } : null;
    eventDetail = best
      ? `best proposal ${Math.round(best.proposal.startMs)}–${Math.round(best.proposal.endMs)} overlap ${bestOverlap}${contactInside ? " contact-inside" : ""}`
      : "no proposal overlaps >0.3 of gold";
  }

  // ── CONTACT ──
  let contact: StageTrace["contact"];
  if (oracle === "CONTACT") {
    contact =
      gold.contactMs !== null
        ? {
            status: "oracle",
            estimatedContactMs: gold.contactMs,
            errorMs: 0,
            ballConfirmed: false,
            paddleConfirmed: false,
            detail: "ORACLE: gold contactMs substituted (err 0 by construction)",
          }
        : {
            status: "not_runnable",
            estimatedContactMs: null,
            errorMs: null,
            ballConfirmed: false,
            paddleConfirmed: false,
            detail: "ORACLE CONTACT not constructible: gold contactMs is null",
          };
  } else if (context.pose && window) {
    const sequence = targetPoseSequence(context.pose.file, context.pose.track);
    const startMs = window.startMs - CONTACT_PAD_MS;
    const endMs = window.endMs + CONTACT_PAD_MS;
    const frames = (toLegacyPoseFrames(sequence) as LegacyFrame[]).filter(
      (frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs,
    );
    const ballObservations = oracle === "BALL" && context.ball.length > 0 ? context.ball : null;
    const estimate = estimateContact({
      sequence,
      window: { startMs, endMs, peakMotionMs: wristSpeedPeakMs(frames) },
      ballObservations,
      paddleSpeeds: null,
      paddleCenters: null,
      targetWrists: wristSeries(frames),
      strokeFamily: context.family,
    });
    if (estimate.status === "estimated") {
      contact = {
        status: "estimated",
        estimatedContactMs: estimate.estimatedContactMs,
        errorMs:
          gold.contactMs !== null ? Math.abs(estimate.estimatedContactMs - gold.contactMs) : null,
        ballConfirmed: estimate.ballConfirmed,
        paddleConfirmed: estimate.paddleConfirmed,
        detail: `estimated ${Math.round(estimate.estimatedContactMs)}ms conf ${estimate.confidence.toFixed(2)}${oracle === "BALL" ? " [oracle ball]" : " [no ball evidence]"}`,
      };
    } else {
      contact = {
        status: "abstained",
        estimatedContactMs: null,
        errorMs: null,
        ballConfirmed: false,
        paddleConfirmed: false,
        detail: `abstained: ${estimate.reason.slice(0, 120)}`,
      };
    }
  } else {
    contact = {
      status: "not_runnable",
      estimatedContactMs: null,
      errorMs: null,
      ballConfirmed: false,
      paddleConfirmed: false,
      detail: context.pose ? "no event window selected" : "no committed pose (wrist-only fixture)",
    };
  }

  // ── PHASE ── (production segments the selected event window)
  let phase: StageTrace["phase"];
  if (window) {
    const anchorMs =
      contact.status === "estimated" || contact.status === "oracle"
        ? contact.estimatedContactMs
        : null;
    const outcome = segmentPhasesTemporalV2({
      event: { startMs: window.startMs, endMs: window.endMs },
      contactMs: anchorMs,
      paddleSpeeds: null,
      wristSpeeds: context.wristSpeeds,
    });
    if (outcome.status === "segmented") {
      const boundaries = outcome.boundaries;
      const orderingValid =
        !Number.isFinite(boundaries.contactMs) ||
        boundaries.followThroughEndMs > boundaries.contactMs;
      phase = {
        status: "segmented",
        orderingValid,
        detail: orderingValid ? "segmented, ordering valid" : "segmented but followEnd ≤ contact",
      };
    } else {
      phase = {
        status: "abstained",
        orderingValid: false,
        detail: `abstained: ${outcome.reason.split(":")[0]}`,
      };
    }
  } else {
    phase = { status: "not_run", orderingValid: false, detail: "no event window selected" };
  }

  // ── STROKE ──
  let stroke: StageTrace["stroke"];
  if (oracle === "STROKE") {
    stroke =
      context.goldBenchL1 !== null
        ? {
            state: "oracle",
            predictedLabel: context.goldBenchL1,
            l1Verdict: "correct",
            detail: "ORACLE: gold stroke label substituted",
          }
        : {
            state: "not_runnable",
            predictedLabel: null,
            l1Verdict: "unverifiable",
            detail: "ORACLE STROKE not constructible: no stroke gold / gold L1 unknown",
          };
  } else if (context.pose && window) {
    const sequence = targetPoseSequence(context.pose.file, context.pose.track);
    const anchorMs =
      contact.status === "estimated" || contact.status === "oracle"
        ? contact.estimatedContactMs
        : null;
    let eventPeakMs: number | null = null;
    if (anchorMs === null) {
      const inWindow = context.wristSpeeds.filter(
        (sample) => sample.timestampMs >= window!.startMs && sample.timestampMs <= window!.endMs,
      );
      const peak = inWindow.reduce(
        (best: Speed | null, sample) =>
          best === null || sample.value > best.value ? sample : best,
        null,
      );
      eventPeakMs = peak?.timestampMs ?? null;
    }
    const prediction: StrokePrediction = classifyStroke({
      sequence,
      window,
      contactMs: anchorMs,
      eventPeakMs,
      handedness: context.handedness,
      paddle: null,
      paddleSpeeds: null,
      wristSpeeds: context.wristSpeeds,
    });
    const predicted = predictedL1Class(prediction);
    let l1Verdict: StageTrace["stroke"]["l1Verdict"];
    if (predicted === "ABSTAINED") l1Verdict = "abstained";
    else if (context.goldBenchL1 === null) l1Verdict = "unverifiable";
    else l1Verdict = predicted === context.goldBenchL1 ? "correct" : "wrong";
    stroke = {
      state: predicted === "ABSTAINED" ? "abstained" : "committed",
      predictedLabel: prediction.label,
      l1Verdict,
      detail: `predicted ${prediction.label} vs gold L1 ${context.goldBenchL1 ?? "(no stroke gold)"}`,
    };
  } else {
    // No pose (rally1 fixture) or no window: the classifier has no pose
    // evidence and would return UNKNOWN — an abstention, not a fabrication.
    stroke = {
      state: "abstained",
      predictedLabel: null,
      l1Verdict: "abstained",
      detail: context.pose ? "no event window selected" : "no committed pose → classifier abstains",
    };
  }

  return {
    event: { pass: eventPass, window, bestOverlap, contactInside, detail: eventDetail },
    contact,
    phase,
    stroke,
  };
}

/** usable-result-v1 clause mapping on the Linux-proxy stage traces.
 *  TARGET passes by construction on this set (disclosed). */
function evaluateUsable(trace: StageTrace, goldContactMs: number | null): UsableVerdict {
  const reasons: string[] = [];
  const contactEstimated =
    trace.contact.status === "estimated" || trace.contact.status === "oracle";
  const errorMs = trace.contact.errorMs;

  const strokeHonest = trace.stroke.l1Verdict !== "wrong";

  const confirmed = trace.contact.ballConfirmed || trace.contact.paddleConfirmed;
  let replayClause: UsableVerdict["replayClause"] = null;
  if (contactEstimated && errorMs !== null && errorMs <= 66) replayClause = "a";
  else if (contactEstimated && errorMs !== null && errorMs > 66 && errorMs <= 132 && confirmed)
    replayClause = "b";
  else if (!contactEstimated && trace.phase.status === "segmented" && trace.phase.orderingValid)
    replayClause = "c";

  const fabricated = contactEstimated && errorMs !== null && errorMs > 132;

  if (!trace.event.pass) reasons.push(`EVENT fail (${trace.event.detail})`);
  if (fabricated)
    reasons.push(
      `fabricated evidence veto: contact ${Math.round(errorMs ?? 0)}ms off gold (>132ms)`,
    );
  if (!strokeHonest) reasons.push(`stroke not honest: ${trace.stroke.detail}`);
  if (replayClause === null)
    reasons.push(
      `no trustworthy replay artifact (contact ${trace.contact.status}${errorMs !== null ? ` err ${Math.round(errorMs)}ms` : ""}${goldContactMs === null ? " · no gold contact" : ""}; phase ${trace.phase.status})`,
    );

  const usable = trace.event.pass && strokeHonest && replayClause !== null && !fabricated;
  if (usable) {
    reasons.push(
      replayClause === "a"
        ? `replay (a): contact |err| ${Math.round(errorMs ?? 0)}ms ≤ 66ms`
        : replayClause === "b"
          ? `replay (b): contact err ${Math.round(errorMs ?? 0)}ms ≤ 132ms with confirmation`
          : "replay (c): contact abstained, phases segmented with valid ordering",
      trace.stroke.l1Verdict === "correct" ? "stroke L1 match" : "honest stroke abstention",
    );
  }
  return { usable, replayClause, reasons };
}

// ── main ──────────────────────────────────────────────────────────────────
const { contexts, heldOutExcluded, notReplayable } = loadContexts();

interface EventResult {
  eventKey: string;
  goldSpanMs: [number, number];
  goldContactMs: number | null;
  baseline: { trace: StageTrace; usable: UsableVerdict };
  oracles: Record<
    string,
    {
      usable: boolean;
      flipped: "recovered" | "broken" | null;
      trace: StageTrace;
      reasons: string[];
    }
  >;
}

const results: EventResult[] = [];
for (const context of contexts) {
  const baselineTrace = runPipeline(context, "NONE");
  const baselineUsable = evaluateUsable(baselineTrace, context.gold.contactMs);
  const oracles: EventResult["oracles"] = {};
  for (const oracle of MEASURABLE_ORACLES) {
    const trace = runPipeline(context, oracle);
    const verdict = evaluateUsable(trace, context.gold.contactMs);
    oracles[oracle] = {
      usable: verdict.usable,
      flipped:
        verdict.usable && !baselineUsable.usable
          ? "recovered"
          : !verdict.usable && baselineUsable.usable
            ? "broken"
            : null,
      trace,
      reasons: verdict.reasons,
    };
  }
  results.push({
    eventKey: context.eventKey,
    goldSpanMs: [context.gold.eventStartMs, context.gold.eventEndMs],
    goldContactMs: context.gold.contactMs,
    baseline: { trace: baselineTrace, usable: baselineUsable },
    oracles,
  });
}

const baselineUsableCount = results.filter((row) => row.baseline.usable.usable).length;
const failedAtBaseline = results.filter((row) => !row.baseline.usable.usable);

const frontier = MEASURABLE_ORACLES.map((oracle) => {
  const recovered = results.filter((row) => row.oracles[oracle]!.flipped === "recovered");
  const broken = results.filter((row) => row.oracles[oracle]!.flipped === "broken");
  return {
    oracle,
    usable: results.filter((row) => row.oracles[oracle]!.usable).length,
    recoveredCount: recovered.length,
    recoveredEvents: recovered.map((row) => row.eventKey),
    brokenCount: broken.length,
    brokenEvents: broken.map((row) => row.eventKey),
  };
}).sort((a, b) => b.recoveredCount - a.recoveredCount);

const structuralOracles = {
  TARGET:
    "NO-OP on this set: the committed windowed bundles were constructed so the auto-target policy resolves the annotator-verified player, and the rally1 fixture wrist series is replay-validated target truth — the baseline already runs on construction-truth TARGET. Recovery attributable to TARGET is 0 by construction here, NOT measured as zero on the full product (Mac TA bench covers that).",
  OWNERSHIP:
    "NO-OP on this set: every evaluated series is target-attributed by construction (target-owned gold events replayed on the target track). Ownership contamination cannot be expressed in this proxy; its frontier contribution is unmeasurable here.",
  PADDLE:
    "NOT CONSTRUCTIBLE: no committed paddle truth series (track or speed series) exists for any replayable case on Linux; substituting a fabricated paddle signal is forbidden. The paddle oracle needs Mac run dirs (datasets/paddle-bench/runs/) or a committed paddle-truth series.",
};

const report = {
  workstream: "g19-oracle-waterfall",
  generatedAtIso: new Date().toISOString(),
  scope: {
    evaluationSet:
      "DEV gold TARGET events replayable from committed artifacts on Linux (wave-a windowed people.json bundles + W6 rally1 wrist fixture)",
    goldTargetEvents: results.length,
    heldOutExcluded,
    notReplayable,
    baselineConditions:
      "EVENT: proposeStrokeEventsV2 wrist-only · CONTACT: estimateContact with pose+wrist, ball ABSENT, paddle ABSENT · PHASE: segmentPhasesTemporalV2 on the selected window anchored to estimated contact · STROKE: classifyStroke paddle-null, contact/eventPeak reference",
    usableCriterion:
      "usable-result-v1 clause mapping (TARGET structural pass, EVENT pass, stroke honesty, replay evidence a/b/c, >132ms fabrication veto)",
  },
  baseline: {
    usable: baselineUsableCount,
    total: results.length,
    failedOrAbstained: failedAtBaseline.length,
    failedEvents: failedAtBaseline.map((row) => ({
      eventKey: row.eventKey,
      reasons: row.baseline.usable.reasons,
    })),
  },
  frontierAttribution: frontier,
  structuralOracles,
  rows: results,
};

const outDir = join(REPO_ROOT, "datasets/experiments/wave-g");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "g19-oracle-waterfall-results.json");
writeFileSync(outPath, JSON.stringify(report, null, 2));

console.log("═".repeat(74));
console.log(`G19 ORACLE WATERFALL — n=${results.length} replayable DEV gold target events`);
console.log(
  `baseline usable ${baselineUsableCount}/${results.length} · failed/abstained ${failedAtBaseline.length}`,
);
console.log("─".repeat(74));
console.log("RANKED SINGLE-ORACLE FRONTIER (recovered = baseline-failed → usable):");
for (const row of frontier) {
  console.log(
    `  ORACLE ${row.oracle.padEnd(8)} usable ${row.usable}/${results.length} · recovered ${row.recoveredCount}/${failedAtBaseline.length}` +
      (row.brokenCount > 0 ? ` · BROKE ${row.brokenCount}: ${row.brokenEvents.join(", ")}` : "") +
      (row.recoveredCount > 0 ? ` · ${row.recoveredEvents.join(", ")}` : ""),
  );
}
for (const [oracle, note] of Object.entries(structuralOracles)) {
  console.log(`  ORACLE ${oracle.padEnd(9)} ${note.split(":")[0]} (see structuralOracles)`);
}
console.log("─".repeat(74));
for (const row of results) {
  console.log(
    `${row.baseline.usable.usable ? "✓ USABLE    " : "✗ NOT USABLE"} ${row.eventKey.padEnd(26)} ` +
      MEASURABLE_ORACLES.map(
        (oracle) => `${oracle}:${row.oracles[oracle]!.usable ? "✓" : "✗"}`,
      ).join(" "),
  );
  for (const reason of row.baseline.usable.reasons) console.log(`      ${reason}`);
}
console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
