// G20 — SELECTIVE-RISK CURVES for the confidence-emitting cascade stages
// (contact, stroke, ownership), on replayable committed labeled data
// (LINUX-CPU, committed wave-a pose windows — NOT the canonical Mac cascade).
//
// For each stage we sweep an answer/abstain confidence threshold t and
// report, at every distinct observed confidence value (plus t=0, the current
// production operating point where every internally-committed answer is
// shown): coverage = answered / all evaluable units, and silent-failure rate
// among answered = wrong-answered / answered — with raw counts at every
// point, pooled AND per independent source session (never random splits).
//
// MEASUREMENT ONLY — no production threshold is changed by this experiment.
//
// Confidence provenance (stated, never blended):
//  - CONTACT: estimateContact's emitted confidence on the e02 contact-gold
//    replay (ORACLE ball, no paddle track — measures temporal fusion).
//    Wrongness follows silent-failure-v1 CONTACT_MARKER: |err| > 132ms, or
//    66 < |err| <= 132ms without ball/paddle confirmation.
//  - STROKE: classifyStroke's emitted confidence on the e03 committed-data
//    bench. Wrongness = confidently-wrong convention (L1 wrong OR L2 wrong);
//    rows with no verifiable component (gold unknown at both levels) are
//    excluded and disclosed.
//  - OWNERSHIP: the production S3 analog emits NO confidence (a finding in
//    itself). We measure a DERIVED selection-margin score for the incumbent
//    frame-level analog: margin = 1 - dBest/dSecond over the veto-surviving
//    candidates (sole-survivor frames get margin 1, counted separately).
//    This is a measured geometric margin, NOT a calibrated probability.
//
// Held-out cases (wm-dink-01, afn-vic-rally1) are never read: the contact
// and stroke benches exclude them by construction, and this script passes
// includeHeldOut=false to the ownership loader.
//
//   cd packages/swing-lab && pnpm exec tsx ../../datasets/experiments/wave-g/g20-selective-risk.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { replayAll } from "../../../packages/vision-geometry/eval/contactGoldReplay.js";
import {
  runStrokeHeuristicBench,
  type BenchRow,
} from "../../../packages/swing-lab/src/strokeHeuristicBench.js";
import { loadDualFrames, type DualFrame } from "../../../packages/swing-lab/src/ownershipBench.js";
import { TRACKER_GATES } from "../../../packages/swing-lab/src/paddleTracker.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const OUT_DIR = join(ROOT, "datasets/experiments/wave-g");

const CONTACT_STRICT_MS = 66;
const CONTACT_ACCEPT_MS = 132;

// ── generic selective-risk sweep ──────────────────────────────────────────

/** One evaluable unit: answered units carry the stage's confidence and a
 *  gold verdict; unanswered units are the stage's own internal abstentions
 *  (they stay in every coverage denominator at every threshold). */
export interface Unit {
  group: string;
  confidence: number | null;
  /** null iff confidence is null (abstained — no claim to verify). */
  wrong: boolean | null;
}

export interface GroupCounts {
  n: number;
  answered: number;
  wrongAnswered: number;
}

export interface CurvePoint {
  threshold: number;
  nUnits: number;
  answered: number;
  wrongAnswered: number;
  coverage: number;
  /** Silent-failure rate among answered; null when nothing is answered. */
  riskOfAnswered: number | null;
  perGroup: Record<string, GroupCounts>;
  /** True when no other point has >= coverage AND <= wrongAnswered rate
   *  with at least one strict improvement (Pareto-efficient). */
  onFrontier: boolean;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function sweepCurve(units: Unit[]): CurvePoint[] {
  const confidences = [
    ...new Set(units.filter((unit) => unit.confidence !== null).map((unit) => unit.confidence!)),
  ].sort((a, b) => b - a);
  const thresholds = [...confidences];
  if (thresholds[thresholds.length - 1] !== 0) thresholds.push(0);
  const groups = [...new Set(units.map((unit) => unit.group))].sort();
  const points: CurvePoint[] = thresholds.map((threshold) => {
    const answeredUnits = units.filter(
      (unit) => unit.confidence !== null && unit.confidence >= threshold,
    );
    const wrongAnswered = answeredUnits.filter((unit) => unit.wrong === true).length;
    const perGroup: Record<string, GroupCounts> = {};
    for (const group of groups) {
      const groupUnits = units.filter((unit) => unit.group === group);
      const groupAnswered = groupUnits.filter(
        (unit) => unit.confidence !== null && unit.confidence >= threshold,
      );
      perGroup[group] = {
        n: groupUnits.length,
        answered: groupAnswered.length,
        wrongAnswered: groupAnswered.filter((unit) => unit.wrong === true).length,
      };
    }
    return {
      threshold: round3(threshold),
      nUnits: units.length,
      answered: answeredUnits.length,
      wrongAnswered,
      coverage: units.length > 0 ? round3(answeredUnits.length / units.length) : 0,
      riskOfAnswered:
        answeredUnits.length > 0 ? round3(wrongAnswered / answeredUnits.length) : null,
      perGroup,
      onFrontier: false,
    };
  });
  for (const point of points) {
    const rate = point.answered > 0 ? point.wrongAnswered / point.answered : 0;
    point.onFrontier = !points.some((other) => {
      if (other === point) return false;
      const otherRate = other.answered > 0 ? other.wrongAnswered / other.answered : 0;
      const geqCoverage = other.coverage >= point.coverage;
      const leqRisk = otherRate <= rate;
      const strict = other.coverage > point.coverage || otherRate < rate;
      return geqCoverage && leqRisk && strict;
    });
  }
  return points;
}

/** Lowest threshold whose answered set contains zero wrong answers (the
 *  zero-observed-silent-failure operating point ON THIS DATA — small n,
 *  not a population guarantee), or null if none exists. */
export function zeroRiskOperatingPoint(points: CurvePoint[]): CurvePoint | null {
  const clean = points.filter((point) => point.answered > 0 && point.wrongAnswered === 0);
  if (clean.length === 0) return null;
  return clean.reduce((best, point) => (point.coverage > best.coverage ? point : best));
}

// ── stage unit extraction ─────────────────────────────────────────────────

export function contactUnits(): { units: Unit[]; disclosures: string[] } {
  const rows = replayAll().filter((row) => row.event.owner === "target");
  const units: Unit[] = rows.map((row) => {
    if (row.status !== "estimated") {
      return { group: row.event.session, confidence: null, wrong: null };
    }
    const error = row.errorMs!;
    const confirmed = row.ballConfirmed === true; // paddle track absent on Linux
    const wrong =
      error > CONTACT_ACCEPT_MS ||
      (error > CONTACT_STRICT_MS && error <= CONTACT_ACCEPT_MS && !confirmed);
    return { group: row.event.session, confidence: row.confidence, wrong };
  });
  return {
    units,
    disclosures: [
      "target-owned gold contact events only (silent-failure-v1 CONTACT_MARKER is a target claim)",
      "ORACLE-BALL condition (gold ball frames, conf 0.9) — measures the estimator's temporal fusion, not the ball tracker; no committed paddle track, so paddleConfirmed is unreachable",
      "wrong = |err| > 132ms, or 66 < |err| <= 132ms without ball confirmation (contract v1 CONTACT_MARKER)",
      "estimator-internal abstentions stay in every coverage denominator",
    ],
  };
}

export function strokeUnits(): {
  units: Unit[];
  excludedUnverifiable: number;
  disclosures: string[];
} {
  const report = runStrokeHeuristicBench();
  const units: Unit[] = [];
  let excludedUnverifiable = 0;
  for (const row of report.rows as BenchRow[]) {
    const answered = row.predictedLabel !== "UNKNOWN" && row.predictedLabel !== "—";
    if (!answered) {
      units.push({ group: row.group, confidence: null, wrong: null });
      continue;
    }
    const l1Verifiable = row.l1 === "correct" || row.l1 === "wrong";
    const l2Verifiable = row.l2 === "correct" || row.l2 === "wrong";
    if (!l1Verifiable && !l2Verifiable) {
      excludedUnverifiable += 1;
      continue;
    }
    if (row.confidence === null) {
      throw new Error(
        `committed stroke prediction without confidence: ${row.caseId} @${row.eventStartMs}`,
      );
    }
    units.push({
      group: row.group,
      confidence: row.confidence,
      wrong: row.l1 === "wrong" || row.l2 === "wrong",
    });
  }
  return {
    units,
    excludedUnverifiable,
    disclosures: [
      "unit = evaluable stroke-gold label (committed wave-a pose windows only; paddle=null everywhere)",
      "wrong = confidently-wrong convention (L1 wrong OR L2 wrong); answered rows with no gold-verifiable component are excluded and counted",
      "classifier-internal abstentions (UNKNOWN) and pose-unavailable rows stay in every coverage denominator",
    ],
  };
}

/** Incumbent frame-level analog (same rule as ownershipBench.pickIncumbent)
 *  plus a measured selection margin over the veto-surviving candidates. */
export function ownershipUnits(): {
  units: Unit[];
  soleSurvivorAnswers: number;
  disclosures: string[];
} {
  const frames: DualFrame[] = loadDualFrames(false);
  const units: Unit[] = [];
  let soleSurvivorAnswers = 0;
  for (const frame of frames) {
    if (!frame.pose) {
      units.push({ group: frame.group, confidence: null, wrong: null });
      continue;
    }
    const eligible: Array<{ index: number; dTarget: number }> = [];
    for (const [index, candidate] of frame.candidates.entries()) {
      const dTarget =
        frame.pose.targetWrists.length > 0
          ? Math.min(
              ...frame.pose.targetWrists.map((wrist) =>
                Math.hypot(wrist.x - candidate.point.x, wrist.y - candidate.point.y),
              ),
            )
          : null;
      if (dTarget === null) continue;
      const dOther =
        frame.pose.otherWrists.length > 0
          ? Math.min(
              ...frame.pose.otherWrists.map((wrist) =>
                Math.hypot(wrist.x - candidate.point.x, wrist.y - candidate.point.y),
              ),
            )
          : null;
      const otherOwned = dOther !== null && dOther < TRACKER_GATES.otherOwnershipFactor * dTarget;
      if (!otherOwned) eligible.push({ index, dTarget });
    }
    if (eligible.length === 0) {
      units.push({ group: frame.group, confidence: null, wrong: null });
      continue;
    }
    eligible.sort((a, b) => a.dTarget - b.dTarget);
    const best = eligible[0]!;
    const second = eligible[1] ?? null;
    let margin: number;
    if (second === null) {
      margin = 1;
      soleSurvivorAnswers += 1;
    } else {
      margin = second.dTarget > 0 ? Math.max(0, Math.min(1, 1 - best.dTarget / second.dTarget)) : 0;
    }
    units.push({
      group: frame.group,
      confidence: margin,
      wrong: frame.candidates[best.index]!.owner !== "target",
    });
  }
  return {
    units,
    soleSurvivorAnswers,
    disclosures: [
      "unit = committed dual frame (>=1 visible target + >=1 visible other paddle point); held-out cases never loaded",
      "the production S3 rule emits NO confidence — this margin (1 - dBest/dSecond over veto-surviving candidates) is a DERIVED geometric score measured here, not a calibrated probability and not a production output",
      "frames whose veto leaves a single candidate answer at margin 1 (counted separately as soleSurvivorAnswers — the margin cannot rank them)",
      "frames without committed pose are abstentions of the incumbent analog and stay in every coverage denominator",
    ],
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("g20-selective-risk.ts");
if (isMain) {
  const contact = contactUnits();
  const stroke = strokeUnits();
  const ownership = ownershipUnits();

  const stages = [
    {
      stage: "contact",
      confidenceSource: "estimateContact emitted confidence (e02 replay, ORACLE ball, no paddle)",
      currentProductionOperatingPoint:
        "t=0 — every internally-committed estimate is shown; no downstream confidence gate exists (caps: 0.7 without ball confirm, 0.55 without ball+paddle)",
      ...contact,
      curve: sweepCurve(contact.units),
    },
    {
      stage: "stroke",
      confidenceSource: "classifyStroke emitted confidence (e03 committed-data bench)",
      currentProductionOperatingPoint:
        "t=0 — every committed (non-UNKNOWN) label is shown; internal gates abstain below evidence floors, no downstream confidence gate exists",
      ...stroke,
      curve: sweepCurve(stroke.units),
    },
    {
      stage: "ownership",
      confidenceSource:
        "DERIVED selection margin for the incumbent S3 frame-level analog (production emits no confidence)",
      currentProductionOperatingPoint:
        "veto-only (t=0) — the wrist-ratio veto is the only production gate; every surviving nearest-wrist pick is committed",
      ...ownership,
      curve: sweepCurve(ownership.units),
    },
  ].map((entry) => ({
    ...entry,
    zeroObservedRiskPoint: zeroRiskOperatingPoint(entry.curve),
    currentPoint: entry.curve[entry.curve.length - 1] ?? null,
  }));

  const artifact = {
    experiment: "g20-selective-risk",
    generatedAtIso: new Date().toISOString(),
    condition: {
      platform: "linux-cpu — NOT-CANONICAL / NOT-MAC (committed replayable data only)",
      heldOut: "wm-dink-01 and afn-vic-rally1 never read",
      grouping: "independent source session (per-point per-group counts; never random splits)",
      productionThresholdsChanged: false,
    },
    stages,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, "g20-selective-risk-curves.json");
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);

  for (const stage of stages) {
    console.log("═".repeat(74));
    console.log(`${stage.stage.toUpperCase()} — ${stage.confidenceSource}`);
    console.log(`  current: ${stage.currentProductionOperatingPoint}`);
    console.log("  threshold  coverage  risk|answered  answered  wrong  frontier");
    for (const point of stage.curve) {
      console.log(
        `  ${point.threshold.toFixed(3).padStart(9)} ${point.coverage.toFixed(3).padStart(9)} ${(point.riskOfAnswered ===
        null
          ? "  —"
          : point.riskOfAnswered.toFixed(3)
        ).padStart(13)} ${String(point.answered).padStart(9)}/${point.nUnits} ${String(
          point.wrongAnswered,
        ).padStart(4)}  ${point.onFrontier ? "YES" : "no"}`,
      );
    }
    const zero = stage.zeroObservedRiskPoint;
    console.log(
      zero
        ? `  zero-observed-risk point: t=${zero.threshold} coverage=${zero.coverage} (${zero.answered}/${zero.nUnits} answered, 0 wrong)`
        : "  zero-observed-risk point: NONE (every non-empty answered set contains a wrong answer)",
    );
  }
  console.log(`\nwritten: ${outPath.replace(`${ROOT}/`, "")}`);
}
