import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EnvelopeStatus } from "@pickle/shared-types";
import type { G08BypassFamily, G08LabelRecord } from "./g08LabelSchema.js";
import { G08_BYPASS_FAMILIES } from "./g08LabelSchema.js";

/**
 * g08-f22-evidence FROZEN promotion gate.
 *
 * The metric definitions and promotion criteria in this module were frozen
 * BEFORE any human label existed (see datasets/experiments/wave-g/
 * g08-frozen-gate.md, whose sha256 is pinned below and asserted in tests).
 * Changing them after labels exist is post-hoc tuning and is prohibited;
 * any change requires a new gate version evaluated only on labels collected
 * AFTER the change.
 */

export const G08_GATE_VERSION = "g08-f22-evidence-gate-v1.0-frozen";

/**
 * sha256 of datasets/experiments/wave-g/g08-frozen-gate.md at freeze time.
 * The test suite recomputes the hash from the committed document; a mismatch
 * means the frozen gate was edited after the fact.
 */
export const G08_FROZEN_GATE_DOC_SHA256 =
  "e32ceb29ed9663506d17e07f579cd705217e87cec0807e052508160799052b1c";

export type G08EnvelopeOverall = Exclude<EnvelopeStatus, "NOT_MEASURED">;

/** One evaluation row: a human label joined with the envelope verdict the
 * CURRENT checker (or a candidate configuration) produces for that window. */
export interface G08EvalRow {
  labelId: string;
  family: G08BypassFamily;
  sessionKey: string;
  capture: G08LabelRecord["capture"];
  downstream: G08LabelRecord["downstream"];
  envelopeOverall: G08EnvelopeOverall;
}

export interface G08RateWithCounts {
  numerator: number;
  denominator: number;
  /** null when denominator is 0 — a rate is NEVER reported without N. */
  rate: number | null;
}

export interface G08GateMetrics {
  n: number;
  nAmbiguous: number;
  nSafe: number;
  nDegraded: number;
  nUnsafe: number;
  distinctSessionKeys: number;
  /**
   * FALSE-SAFE RATE: of windows a human labeled UNSAFE, the fraction the
   * envelope reported overall SUPPORTED. The single most important number:
   * every false-safe is a capture the checker waves through that cannot be
   * analyzed.
   */
  falseSafeRate: G08RateWithCounts;
  /**
   * FALSE-REJECT RATE: of windows a human labeled SAFE, the fraction the
   * envelope flagged (overall DEGRADED or UNSUPPORTED).
   */
  falseRejectRate: G08RateWithCounts;
  /**
   * MISSED-DEGRADATION RATE: of windows a human labeled DEGRADED, the
   * fraction the envelope reported overall SUPPORTED. Reported separately —
   * never folded into false-safe.
   */
  missedDegradationRate: G08RateWithCounts;
  /**
   * DOWNSTREAM USABLE-RESULT RATE conditioned on envelope verdict: of
   * windows with a known downstream outcome and the given verdict, the
   * fraction whose outcome is USABLE.
   */
  usableRateGivenSupported: G08RateWithCounts;
  usableRateGivenFlagged: G08RateWithCounts;
  /**
   * SILENT-FAILURE RATE conditioned on envelope verdict SUPPORTED: of
   * windows with a known downstream outcome that the envelope passed, the
   * fraction whose outcome is SILENT_FAILURE.
   */
  silentFailureRateGivenSupported: G08RateWithCounts;
}

function rate(numerator: number, denominator: number): G08RateWithCounts {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

const KNOWN_OUTCOMES = new Set([
  "USABLE",
  "DEGRADED_RESULT",
  "UNUSABLE_DISCLOSED",
  "SILENT_FAILURE",
]);

export function computeG08Metrics(rows: G08EvalRow[]): G08GateMetrics {
  const ambiguous = rows.filter((r) => r.capture === "AMBIGUOUS");
  const decided = rows.filter((r) => r.capture !== "AMBIGUOUS");
  const safe = decided.filter((r) => r.capture === "SAFE");
  const degraded = decided.filter((r) => r.capture === "DEGRADED");
  const unsafe = decided.filter((r) => r.capture === "UNSAFE");

  const flagged = (r: G08EvalRow) => r.envelopeOverall !== "SUPPORTED";
  const knownOutcome = rows.filter((r) => KNOWN_OUTCOMES.has(r.downstream));
  const knownSupported = knownOutcome.filter((r) => r.envelopeOverall === "SUPPORTED");
  const knownFlagged = knownOutcome.filter(flagged);

  return {
    n: rows.length,
    nAmbiguous: ambiguous.length,
    nSafe: safe.length,
    nDegraded: degraded.length,
    nUnsafe: unsafe.length,
    distinctSessionKeys: new Set(rows.map((r) => r.sessionKey)).size,
    falseSafeRate: rate(unsafe.filter((r) => !flagged(r)).length, unsafe.length),
    falseRejectRate: rate(safe.filter(flagged).length, safe.length),
    missedDegradationRate: rate(degraded.filter((r) => !flagged(r)).length, degraded.length),
    usableRateGivenSupported: rate(
      knownSupported.filter((r) => r.downstream === "USABLE").length,
      knownSupported.length,
    ),
    usableRateGivenFlagged: rate(
      knownFlagged.filter((r) => r.downstream === "USABLE").length,
      knownFlagged.length,
    ),
    silentFailureRateGivenSupported: rate(
      knownSupported.filter((r) => r.downstream === "SILENT_FAILURE").length,
      knownSupported.length,
    ),
  };
}

/**
 * FROZEN minimum-evidence requirements: below these, the gate is NOT
 * DECIDABLE for a family and no promotion decision may be made.
 */
export const G08_MINIMUM_EVIDENCE = {
  /** Human-labeled windows in the family (AMBIGUOUS included in the count). */
  minLabeledWindows: 10,
  /** Windows labeled UNSAFE or DEGRADED (the checker must have something to catch). */
  minUnsafeOrDegraded: 5,
  /** Windows labeled SAFE (the checker must have something to pass). */
  minSafe: 3,
  /** Distinct sessionKeys across the family's labels — windows from one
   * session are not independent evidence. */
  minDistinctSessions: 3,
} as const;

/**
 * FROZEN promotion criteria for a candidate proxy/threshold change targeting
 * a family. All conditions must hold on the family's human labels:
 *  1. Evidence is sufficient (G08_MINIMUM_EVIDENCE).
 *  2. Candidate falseSafeRate <= 0.20.
 *  3. Candidate falseRejectRate <= 0.20.
 *  4. Candidate falseSafeRate <= incumbent falseSafeRate.
 *  5. Candidate falseRejectRate <= incumbent falseRejectRate + 0.05
 *     (a small false-reject regression is tolerable only while false-safes
 *     strictly do not increase).
 *  6. Candidate silentFailureRateGivenSupported <= incumbent's, whenever
 *     both are measurable (downstream outcomes exist on both sides).
 *  7. ONE-SHOT: a candidate is evaluated against the frozen label set at
 *     most once. Re-tuning and re-submitting against the same labels is
 *     prohibited; a failed candidate needs NEW labels to try again.
 */
export const G08_PROMOTION_CRITERIA = {
  maxFalseSafeRate: 0.2,
  maxFalseRejectRate: 0.2,
  maxFalseRejectRegression: 0.05,
} as const;

export interface G08PromotionVerdict {
  family: G08BypassFamily;
  decidable: boolean;
  promote: boolean;
  reasons: string[];
}

export function evidenceSufficient(m: G08GateMetrics): { sufficient: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const req = G08_MINIMUM_EVIDENCE;
  if (m.n < req.minLabeledWindows) {
    reasons.push(`labeled windows ${m.n} < ${req.minLabeledWindows}`);
  }
  if (m.nUnsafe + m.nDegraded < req.minUnsafeOrDegraded) {
    reasons.push(`UNSAFE+DEGRADED ${m.nUnsafe + m.nDegraded} < ${req.minUnsafeOrDegraded}`);
  }
  if (m.nSafe < req.minSafe) {
    reasons.push(`SAFE ${m.nSafe} < ${req.minSafe}`);
  }
  if (m.distinctSessionKeys < req.minDistinctSessions) {
    reasons.push(`distinct sessions ${m.distinctSessionKeys} < ${req.minDistinctSessions}`);
  }
  return { sufficient: reasons.length === 0, reasons };
}

export function evaluateG08Promotion(
  family: G08BypassFamily,
  incumbent: G08GateMetrics,
  candidate: G08GateMetrics,
): G08PromotionVerdict {
  const reasons: string[] = [];
  const evidence = evidenceSufficient(candidate);
  if (!evidence.sufficient) {
    return {
      family,
      decidable: false,
      promote: false,
      reasons: evidence.reasons.map((r) => `insufficient evidence: ${r}`),
    };
  }

  const c = G08_PROMOTION_CRITERIA;
  const candFalseSafe = candidate.falseSafeRate.rate;
  const candFalseReject = candidate.falseRejectRate.rate;
  const incFalseSafe = incumbent.falseSafeRate.rate;
  const incFalseReject = incumbent.falseRejectRate.rate;

  if (candFalseSafe === null || candFalseReject === null) {
    return {
      family,
      decidable: false,
      promote: false,
      reasons: ["candidate false-safe or false-reject rate has zero denominator"],
    };
  }

  if (candFalseSafe > c.maxFalseSafeRate) {
    reasons.push(
      `falseSafeRate ${candidate.falseSafeRate.numerator}/${candidate.falseSafeRate.denominator} > ${c.maxFalseSafeRate}`,
    );
  }
  if (candFalseReject > c.maxFalseRejectRate) {
    reasons.push(
      `falseRejectRate ${candidate.falseRejectRate.numerator}/${candidate.falseRejectRate.denominator} > ${c.maxFalseRejectRate}`,
    );
  }
  if (incFalseSafe !== null && candFalseSafe > incFalseSafe) {
    reasons.push(`falseSafeRate worsens vs incumbent (${candFalseSafe} > ${incFalseSafe})`);
  }
  if (incFalseReject !== null && candFalseReject > incFalseReject + c.maxFalseRejectRegression) {
    reasons.push(
      `falseRejectRate regression > ${c.maxFalseRejectRegression} vs incumbent (${candFalseReject} vs ${incFalseReject})`,
    );
  }
  const candSilent = candidate.silentFailureRateGivenSupported.rate;
  const incSilent = incumbent.silentFailureRateGivenSupported.rate;
  if (candSilent !== null && incSilent !== null && candSilent > incSilent) {
    reasons.push(
      `silentFailureRateGivenSupported worsens vs incumbent (${candSilent} > ${incSilent})`,
    );
  }

  return { family, decidable: true, promote: reasons.length === 0, reasons };
}

export function computeG08MetricsByFamily(
  rows: G08EvalRow[],
): Record<G08BypassFamily, G08GateMetrics> {
  const out = {} as Record<G08BypassFamily, G08GateMetrics>;
  for (const family of G08_BYPASS_FAMILIES) {
    out[family] = computeG08Metrics(rows.filter((r) => r.family === family));
  }
  return out;
}

export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
