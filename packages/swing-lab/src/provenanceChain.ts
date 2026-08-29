/**
 * END-TO-END PROVENANCE CHAIN CHECK (provenance-chain-1).
 *
 * Walks a complete analysis artifact (LabRunReport shape and any nested
 * Result-surface fragments) and verifies that every user-visible claim in
 * the Result contract traces back to OBSERVED / TRACKED / PREDICTED
 * provenance, and that no PREDICTED value surfaces as an observation
 * anywhere in the chain. Rules are read from contracts that already exist
 * in the codebase, never invented:
 *
 *  - a contact ESTIMATE (offlineStroke.ts ContactEstimate, status
 *    "estimated") must carry at least one supporting evidence signal from
 *    the registered observed/tracked signal families, with a finite
 *    timestamp and positive weight; ballConfirmed / paddleConfirmed claims
 *    require a signal of the matching modality; an ABSTENTION must not
 *    carry an estimate;
 *  - a TRACKED stage claim (paddle / ball, report.ts) must be backed by at
 *    least one real observation; bridge points are PREDICTED
 *    (paddleCropRecovery.ts / ballTracker timeline) and require at least
 *    two real observations to interpolate between;
 *  - a tracked_estimate observation must never masquerade as a detection
 *    (detectorScore is 0 and nearWrist false by construction — a positive
 *    detector score or wrist claim on a bridge point is a fabrication);
 *  - a stroke PREDICTION (strokeHeuristic.ts StrokePrediction) that commits
 *    to a label must carry its evidence trail;
 *  - Result-surface measured rows (strokeResultModel.ts MeasuredRowView)
 *    must carry a registered provenance chip, and rows derived from
 *    predictions / estimates must not be presented as DETECTED or MEASURED.
 *
 * The checker REPORTS violations; it never mutates or repairs data.
 * Violations found in committed artifacts are findings about the data.
 */

import type { InvariantViolation } from "./invariants.js";

export const PROVENANCE_CHAIN_VERSION = "provenance-chain-1";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Registered contact evidence signal families (offlineStroke.ts). */
const CONTACT_SIGNALS = new Set([
  "paddle_speed_peak",
  "wrist_speed_peak",
  "ball_direction_change",
  "ball_paddle_proximity",
  "ball_wrist_proximity",
]);

const BALL_SIGNALS = new Set([
  "ball_direction_change",
  "ball_paddle_proximity",
  "ball_wrist_proximity",
]);
const PADDLE_SIGNALS = new Set(["paddle_speed_peak", "ball_paddle_proximity"]);

/** Registered Result-surface provenance chips (strokeResultModel.ts). */
const ROW_PROVENANCES = new Set(["DETECTED", "ESTIMATE", "MEASURED", "PREDICTED"]);

/** Result-surface row keys whose values are predictions / estimates and
 * must never surface under an observation chip. */
const ROW_KEY_REQUIRED_PROVENANCE: ReadonlyArray<[RegExp, string]> = [
  [/^predicted_stroke$/, "PREDICTED"],
  [/^contact_estimate$/, "ESTIMATE"],
];

export function checkProvenanceChain(value: unknown, path = "$"): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  walk(value, path, violations);
  return violations;
}

function walk(value: unknown, path: string, out: InvariantViolation[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (!isObject(value)) return;
  checkContactEstimate(value, path, out);
  checkTrackedStage(value, path, out);
  checkTrackedEstimateObservation(value, path, out);
  checkStrokePrediction(value, path, out);
  checkMeasuredRow(value, path, out);
  for (const [key, child] of Object.entries(value)) {
    walk(child, `${path}.${key}`, out);
  }
}

// ── contact estimate: user-visible marker must trace to observed signals ──

/**
 * Evidence tracing applies to FULL ContactEstimate nodes (the runtime
 * artifact shape, which always carries supportingEvidence/limitingFactors
 * when estimated). Experiment digests that echo an estimate (status +
 * estimatedContactMs only, e.g. errMs-vs-gold summaries) are derived
 * reporting — their provenance lives in the run artifact they summarize —
 * and are not treated as chain sources.
 */
function looksLikeContactEstimate(obj: JsonObject): boolean {
  return (
    (obj["status"] === "estimated" &&
      "estimatedContactMs" in obj &&
      ("supportingEvidence" in obj || "limitingFactors" in obj)) ||
    (obj["status"] === "abstained" && ("estimatedContactMs" in obj || "supportingEvidence" in obj))
  );
}

function checkContactEstimate(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  if (!looksLikeContactEstimate(obj)) return;

  if (obj["status"] === "abstained") {
    if (finiteNumber(obj["estimatedContactMs"])) {
      out.push({
        rule: "chain_abstention_with_estimate",
        path: `${path}.estimatedContactMs`,
        detail: `abstained contact carries estimatedContactMs=${obj["estimatedContactMs"]}`,
      });
    }
    return;
  }

  const evidence = obj["supportingEvidence"];
  const signals = Array.isArray(evidence) ? evidence.filter(isObject) : [];
  const traceable = signals.filter(
    (signal) =>
      typeof signal["signal"] === "string" &&
      CONTACT_SIGNALS.has(signal["signal"]) &&
      finiteNumber(signal["timestampMs"]) &&
      finiteNumber(signal["weight"]) &&
      (signal["weight"] as number) > 0,
  );
  if (traceable.length === 0) {
    out.push({
      rule: "chain_contact_estimate_without_evidence",
      path,
      detail:
        "contact status=estimated with no traceable supporting evidence signal (finite timestamp, positive weight, registered family)",
    });
  }
  for (const signal of signals) {
    if (typeof signal["signal"] === "string" && !CONTACT_SIGNALS.has(signal["signal"])) {
      out.push({
        rule: "chain_unregistered_evidence_signal",
        path: `${path}.supportingEvidence`,
        detail: `unregistered contact evidence signal "${signal["signal"]}"`,
      });
    }
  }
  const signalNames = new Set(
    signals
      .map((signal) => signal["signal"])
      .filter((name): name is string => typeof name === "string"),
  );
  if (obj["ballConfirmed"] === true && ![...signalNames].some((name) => BALL_SIGNALS.has(name))) {
    out.push({
      rule: "chain_confirmation_without_signal",
      path: `${path}.ballConfirmed`,
      detail: "ballConfirmed=true without a ball evidence signal in supportingEvidence",
    });
  }
  if (
    obj["paddleConfirmed"] === true &&
    ![...signalNames].some((name) => PADDLE_SIGNALS.has(name))
  ) {
    out.push({
      rule: "chain_confirmation_without_signal",
      path: `${path}.paddleConfirmed`,
      detail: "paddleConfirmed=true without a paddle evidence signal in supportingEvidence",
    });
  }
}

// ── tracked stage claims: TRACKED must be backed by real observations ──────

function checkTrackedStage(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  if (obj["status"] !== "tracked" || !("observationCount" in obj)) return;
  const count = obj["observationCount"];
  if (!finiteNumber(count) || count < 1) {
    out.push({
      rule: "chain_tracked_without_observations",
      path: `${path}.observationCount`,
      detail: `status=tracked with observationCount=${String(count)}`,
    });
  }
  const timeline = obj["timeline"];
  if (isObject(timeline) && "bridgePointCount" in timeline) {
    const bridges = timeline["bridgePointCount"];
    if (!finiteNumber(bridges) || bridges < 0) {
      out.push({
        rule: "chain_bridge_without_anchors",
        path: `${path}.timeline.bridgePointCount`,
        detail: `bridgePointCount=${String(bridges)} is not a non-negative finite count`,
      });
    } else if (bridges > 0 && (!finiteNumber(count) || count < 2)) {
      out.push({
        rule: "chain_bridge_without_anchors",
        path: `${path}.timeline.bridgePointCount`,
        detail: `${bridges} PREDICTED bridge point(s) require at least two real observations to interpolate between (observationCount=${String(count)})`,
      });
    }
  }
}

// ── tracked_estimate observations must never masquerade as detections ──────

function checkTrackedEstimateObservation(
  obj: JsonObject,
  path: string,
  out: InvariantViolation[],
): void {
  if (obj["source"] !== "tracked_estimate") return;
  if (finiteNumber(obj["detectorScore"]) && (obj["detectorScore"] as number) > 0) {
    out.push({
      rule: "chain_predicted_as_observation",
      path: `${path}.detectorScore`,
      detail: `tracked_estimate bridge point carries detectorScore=${obj["detectorScore"]} (bridge points are PREDICTED, detectorScore must be 0)`,
    });
  }
  if (obj["nearWrist"] === true) {
    out.push({
      rule: "chain_predicted_as_observation",
      path: `${path}.nearWrist`,
      detail: "tracked_estimate bridge point claims nearWrist=true (never measured on a bridge)",
    });
  }
}

// ── stroke prediction: a committed label must carry its evidence trail ─────

function looksLikeStrokePrediction(obj: JsonObject): boolean {
  return "label" in obj && "taxonomyDepth" in obj && "evidence" in obj;
}

function checkStrokePrediction(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  if (!looksLikeStrokePrediction(obj)) return;
  const label = obj["label"];
  if (typeof label !== "string" || label.length === 0 || label === "UNKNOWN") return;
  const evidence = obj["evidence"];
  const hasEvidence =
    Array.isArray(evidence) &&
    evidence.some((entry) => typeof entry === "string" && entry.length > 0);
  if (!hasEvidence) {
    out.push({
      rule: "chain_prediction_without_evidence",
      path,
      detail: `stroke prediction commits to "${label}" with no evidence trail`,
    });
  }
}

// ── Result-surface measured rows: provenance chips must be honest ───────────

function looksLikeMeasuredRow(obj: JsonObject): boolean {
  return (
    typeof obj["key"] === "string" &&
    typeof obj["label"] === "string" &&
    typeof obj["value"] === "string" &&
    typeof obj["provenance"] === "string"
  );
}

function checkMeasuredRow(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  if (!looksLikeMeasuredRow(obj)) return;
  const provenance = obj["provenance"] as string;
  if (!ROW_PROVENANCES.has(provenance)) {
    out.push({
      rule: "chain_unknown_row_provenance",
      path: `${path}.provenance`,
      detail: `measured row "${obj["key"]}" carries unregistered provenance "${provenance}"`,
    });
    return;
  }
  const key = obj["key"] as string;
  for (const [pattern, required] of ROW_KEY_REQUIRED_PROVENANCE) {
    if (pattern.test(key) && provenance !== required) {
      out.push({
        rule: "chain_predicted_row_masquerade",
        path: `${path}.provenance`,
        detail: `row "${key}" must be labeled ${required}, not ${provenance} — a prediction/estimate never surfaces as an observation`,
      });
    }
  }
}
