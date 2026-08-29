import { readFileSync } from "node:fs";

/**
 * Per-clip capture metadata the operator fills from the session sheet. The
 * enums mirror datasets/pickleball/collection_manifest.schema.json `capture`
 * plus the record identifiers intake needs to draft a manifest entry.
 */

export const CAMERA_VIEWS = [
  "front",
  "rear",
  "dominant_side",
  "nondominant_side",
  "diagonal",
  "overhead",
  "other",
] as const;
export const ENVIRONMENTS = ["indoor", "outdoor"] as const;
export const LIGHTING = ["daylight", "court_lighting", "mixed", "low_light"] as const;
export const HANDEDNESS = ["left", "right", "ambidextrous", "unknown"] as const;
export const SKILL_BANDS = [
  "novice",
  "recreational",
  "intermediate",
  "advanced",
  "professional",
  "unknown",
] as const;
export const AGE_BANDS = [
  "minor_13_17",
  "adult_18_34",
  "adult_35_54",
  "adult_55_plus",
  "withheld",
] as const;
export const BYSTANDER_STATES = ["none", "released", "irreversibly_redacted"] as const;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export interface CaptureMeta {
  clipId: string;
  athleteId: string;
  athleteGroupId: string;
  sessionId: string;
  recordedAt: string;
  capture: {
    cameraView: (typeof CAMERA_VIEWS)[number];
    environment: (typeof ENVIRONMENTS)[number];
    lighting: (typeof LIGHTING)[number];
    deviceClass: string;
    handedness: (typeof HANDEDNESS)[number];
    skillBand: (typeof SKILL_BANDS)[number];
    ageBand: (typeof AGE_BANDS)[number];
    adaptivePlay: boolean;
    bystanderState: (typeof BYSTANDER_STATES)[number];
  };
}

function pushIfNotEnum(
  errors: string[],
  field: string,
  value: unknown,
  allowed: readonly string[],
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    errors.push(`capture.${field}: expected one of ${allowed.join("|")}, got ${String(value)}`);
  }
}

export function loadCaptureMeta(metaPath: string): CaptureMeta {
  const parsed: unknown = JSON.parse(readFileSync(metaPath, "utf8"));
  const errors: string[] = [];
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`capture metadata ${metaPath} must be a JSON object`);
  }
  const m = parsed as Record<string, unknown>;
  for (const idField of ["clipId", "athleteId", "athleteGroupId", "sessionId"] as const) {
    if (typeof m[idField] !== "string" || !OPAQUE_ID.test(m[idField] as string)) {
      errors.push(`${idField}: must match manifest opaqueId pattern ${OPAQUE_ID.source}`);
    }
  }
  if (typeof m.recordedAt !== "string" || Number.isNaN(Date.parse(m.recordedAt))) {
    errors.push("recordedAt: must be an ISO date-time string");
  }
  const capture = m.capture;
  if (typeof capture !== "object" || capture === null) {
    errors.push("capture: missing object");
  } else {
    const c = capture as Record<string, unknown>;
    pushIfNotEnum(errors, "cameraView", c.cameraView, CAMERA_VIEWS);
    pushIfNotEnum(errors, "environment", c.environment, ENVIRONMENTS);
    pushIfNotEnum(errors, "lighting", c.lighting, LIGHTING);
    pushIfNotEnum(errors, "handedness", c.handedness, HANDEDNESS);
    pushIfNotEnum(errors, "skillBand", c.skillBand, SKILL_BANDS);
    pushIfNotEnum(errors, "ageBand", c.ageBand, AGE_BANDS);
    pushIfNotEnum(errors, "bystanderState", c.bystanderState, BYSTANDER_STATES);
    if (typeof c.deviceClass !== "string" || c.deviceClass.length === 0) {
      errors.push("capture.deviceClass: must be a non-empty string");
    }
    if (typeof c.adaptivePlay !== "boolean") {
      errors.push("capture.adaptivePlay: must be a boolean");
    }
  }
  if (errors.length > 0) {
    throw new Error(`capture metadata ${metaPath} is invalid:\n${errors.join("\n")}`);
  }
  return parsed as CaptureMeta;
}
