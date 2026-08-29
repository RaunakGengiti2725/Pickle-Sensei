/**
 * Temporal / honesty invariants over analysis artifacts.
 *
 * One generic deep-walk checker applied both to fuzz-generated pipeline
 * outputs (property tests) and to every committed JSON artifact under
 * datasets/ (corpus check). Rules encode contracts that already exist in the
 * codebase — they are read from the shapes, never invented:
 *
 *  - no negative durations: any {startMs, endMs} span and any durationMs;
 *  - contact/peak inside its event when both exist on one object;
 *  - phase ordering: preparation ≤ acceleration ≤ contact ≤ follow-through
 *    ≤ recovery (TemporalPhaseBoundaries) and phase-span arrays ordered with
 *    representatives inside their span;
 *  - no NaN / non-finite / out-of-unit confidences;
 *  - provenance: every producedBy carries providerId + modelVersion, every
 *    phase-boundaries object carries version + source;
 *  - predicted vs observed never conflated: anchor-free timelines
 *    (anchorBasis "event_peak") must not carry a contact value; a
 *    resolutionBasis of "declared" requires a declared stroke and a
 *    "predicted_*" basis requires a prediction.
 *
 * The checker REPORTS violations; it never mutates or repairs data.
 */

export interface InvariantViolation {
  rule: string;
  path: string;
  detail: string;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const PHASE_KEYS = new Set([
  "ready",
  "prepare",
  "accelerate",
  "contact",
  "follow_through",
  "recover",
]);

export function checkArtifactInvariants(value: unknown, path = "$"): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  walk(value, path, violations);
  return violations;
}

function walk(value: unknown, path: string, out: InvariantViolation[]): void {
  if (Array.isArray(value)) {
    checkPhaseSpanArray(value, path, out);
    value.forEach((item, index) => walk(item, `${path}[${index}]`, out));
    return;
  }
  if (!isObject(value)) return;
  checkObject(value, path, out);
  for (const [key, child] of Object.entries(value)) {
    walk(child, `${path}.${key}`, out);
  }
}

function checkObject(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  // ── non-finite / out-of-range confidence-like fields ─────────────────
  for (const [key, val] of Object.entries(obj)) {
    if (!/confidence/i.test(key)) continue;
    if (typeof val === "number") {
      if (!Number.isFinite(val)) {
        out.push({ rule: "non_finite_confidence", path: `${path}.${key}`, detail: String(val) });
      } else if (val < 0 || val > 1) {
        out.push({
          rule: "confidence_out_of_unit_range",
          path: `${path}.${key}`,
          detail: String(val),
        });
      }
    }
  }

  // ── spans and durations ───────────────────────────────────────────────
  const startMs = obj["startMs"];
  const endMs = obj["endMs"];
  const hasSpan = finiteNumber(startMs) && finiteNumber(endMs);
  if (hasSpan && (endMs as number) < (startMs as number)) {
    out.push({
      rule: "negative_duration",
      path,
      detail: `startMs=${startMs} endMs=${endMs}`,
    });
  }
  if (typeof obj["startMs"] === "number" && !Number.isFinite(obj["startMs"])) {
    out.push({ rule: "non_finite_timestamp", path: `${path}.startMs`, detail: String(obj["startMs"]) });
  }
  if (typeof obj["endMs"] === "number" && !Number.isFinite(obj["endMs"])) {
    out.push({ rule: "non_finite_timestamp", path: `${path}.endMs`, detail: String(obj["endMs"]) });
  }
  const durationMs = obj["durationMs"];
  if (finiteNumber(durationMs) && durationMs < 0) {
    out.push({ rule: "negative_duration", path: `${path}.durationMs`, detail: String(durationMs) });
  }

  // ── contact / peak inside the event when both live on one object ──────
  if (hasSpan) {
    for (const key of ["contactMs", "peakMs", "peakMotionMs", "representativeMs"] as const) {
      const t = obj[key];
      if (finiteNumber(t) && (t < (startMs as number) || t > (endMs as number))) {
        out.push({
          rule: "contact_outside_event",
          path: `${path}.${key}`,
          detail: `${key}=${t} outside [${startMs}, ${endMs}]`,
        });
      }
    }
  }

  // ── TemporalPhaseBoundaries ordering + provenance + conflation ───────
  if (finiteNumber(obj["accelerationStartMs"]) && "followThroughEndMs" in obj) {
    checkPhaseBoundaries(obj, path, out);
  }

  // ── producedBy provenance ─────────────────────────────────────────────
  if ("producedBy" in obj) {
    const ref = obj["producedBy"];
    if (
      !isObject(ref) ||
      typeof ref["providerId"] !== "string" ||
      ref["providerId"].length === 0 ||
      typeof ref["modelVersion"] !== "string" ||
      ref["modelVersion"].length === 0
    ) {
      out.push({
        rule: "provenance_missing",
        path: `${path}.producedBy`,
        detail: "producedBy must carry providerId and modelVersion",
      });
    }
  }

  // ── declared vs predicted never conflated ─────────────────────────────
  const basis = obj["resolutionBasis"];
  if (typeof basis === "string") {
    if (basis === "declared" && obj["declaredStroke"] == null) {
      out.push({
        rule: "predicted_declared_conflation",
        path,
        detail: 'resolutionBasis "declared" without a declared stroke',
      });
    }
    if (basis.startsWith("predicted") && obj["predictedStroke"] == null) {
      out.push({
        rule: "predicted_declared_conflation",
        path,
        detail: `resolutionBasis "${basis}" without a prediction`,
      });
    }
  }
}

function checkPhaseBoundaries(obj: JsonObject, path: string, out: InvariantViolation[]): void {
  const prep = obj["preparationStartMs"];
  const accel = obj["accelerationStartMs"] as number;
  const contact = obj["contactMs"];
  const follow = obj["followThroughEndMs"];
  const recovery = obj["recoveryEndMs"];

  const ordered: Array<[string, number]> = [];
  if (finiteNumber(prep)) ordered.push(["preparationStartMs", prep]);
  ordered.push(["accelerationStartMs", accel]);
  if (finiteNumber(contact)) ordered.push(["contactMs", contact]);
  if (finiteNumber(follow)) ordered.push(["followThroughEndMs", follow]);
  if (finiteNumber(recovery)) ordered.push(["recoveryEndMs", recovery]);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i]![1] < ordered[i - 1]![1]) {
      out.push({
        rule: "phase_ordering_invalid",
        path,
        detail: `${ordered[i - 1]![0]}=${ordered[i - 1]![1]} > ${ordered[i]![0]}=${ordered[i]![1]}`,
      });
    }
  }

  // Provenance is required only on machine-produced TemporalPhaseBoundaries
  // (identified by their confidence/anchorBasis/relative fields). Nested
  // anchor-relative copies and human annotation "phases" objects carry
  // provenance on their enclosing object (version / annotatorId) instead.
  const machineBoundaries = "confidence" in obj || "anchorBasis" in obj || "relative" in obj;
  if (!machineBoundaries) return;

  if (typeof obj["version"] !== "string" || obj["version"].length === 0) {
    out.push({ rule: "provenance_missing", path: `${path}.version`, detail: "phase boundaries must carry a version" });
  }
  if (obj["source"] !== "paddle" && obj["source"] !== "wrist") {
    out.push({ rule: "provenance_missing", path: `${path}.source`, detail: "phase boundaries must carry a kinematic source" });
  }

  // Anchor-free timelines have no established contact — a numeric contact
  // here would present motion evidence as an observed contact.
  if (obj["anchorBasis"] === "event_peak" && finiteNumber(contact)) {
    out.push({
      rule: "anchor_free_contact_conflation",
      path: `${path}.contactMs`,
      detail: `anchorBasis=event_peak with numeric contactMs=${contact}`,
    });
  }
}

function checkPhaseSpanArray(value: unknown[], path: string, out: InvariantViolation[]): void {
  const spans = value.filter(
    (item): item is JsonObject =>
      isObject(item) &&
      typeof item["key"] === "string" &&
      PHASE_KEYS.has(item["key"]) &&
      finiteNumber(item["startMs"]) &&
      finiteNumber(item["endMs"]),
  );
  if (spans.length < 2 || spans.length !== value.length) return;
  for (let i = 1; i < spans.length; i += 1) {
    if ((spans[i]!["startMs"] as number) < (spans[i - 1]!["startMs"] as number)) {
      out.push({
        rule: "phase_spans_unordered",
        path: `${path}[${i}]`,
        detail: `startMs ${spans[i]!["startMs"]} before previous ${spans[i - 1]!["startMs"]}`,
      });
    }
  }
}
