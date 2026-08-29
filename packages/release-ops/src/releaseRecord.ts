/**
 * Release-pipeline manifest — the canonical, versioned record of exactly what
 * a release IS: which commit, which mobile build, which backend release, which
 * database schema, which model versions, which interpretation registries
 * (technique profiles, score config, fault taxonomy, drill library, capture
 * envelope), and which feature flags.
 *
 * TRUTH CONTRACT:
 *  - A ReleaseRecord never asserts a gate passed without evidence. Gates that
 *    require external humans or hardware (physical devices, coach review)
 *    default to BLOCKED_EXTERNAL and can only leave that state with an
 *    explicit evidence reference.
 *  - Validation rejects incomplete manifests outright — a manifest missing a
 *    version dimension is not a manifest.
 */

/** Bump when the ReleaseRecord shape changes incompatibly. */
export const RELEASE_RECORD_SCHEMA_VERSION = 1 as const;

/**
 * Promotion stages in canonical order. A release moves strictly left to
 * right; a stage's gate must not be PASSED while an earlier stage is
 * FAILED or NOT_RUN.
 */
export const RELEASE_STAGES = [
  "dev",
  "unit",
  "validation",
  "locked-test",
  "shadow",
  "physical-device",
  "internal",
  "beta",
  "canary",
  "staged",
  "full",
] as const;
export type ReleaseStage = (typeof RELEASE_STAGES)[number];

export const GATE_STATES = [
  "NOT_RUN",
  "IN_PROGRESS",
  "PASSED",
  "FAILED",
  "NOT_EVALUABLE",
  "BLOCKED_EXTERNAL",
] as const;
export type GateState = (typeof GATE_STATES)[number];

/**
 * Stages whose gates cannot be evaluated by machines alone: they require
 * external hardware or humans and therefore default to BLOCKED_EXTERNAL.
 */
export const EXTERNALLY_BLOCKED_STAGES: readonly ReleaseStage[] = ["physical-device"];

export interface StageGate {
  stage: ReleaseStage;
  state: GateState;
  /** Pointer to the evidence backing the state (report path, CI run, doc). */
  evidence: string | null;
  /** ISO timestamp of the evaluation; null when never evaluated. */
  evaluatedAt: string | null;
  /** Required when state is BLOCKED_EXTERNAL or NOT_EVALUABLE. */
  blockedReason: string | null;
}

/**
 * Coach review is an external gate that spans stages rather than being a
 * stage itself: no coach-facing claim ships without it, and it defaults to
 * BLOCKED_EXTERNAL because coach evidence cannot be machine-generated.
 */
export interface CoachReviewGate {
  state: GateState;
  evidence: string | null;
  evaluatedAt: string | null;
  blockedReason: string | null;
}

export interface MobileBuildRef {
  appVersion: string;
  /** Store build number when one exists; null for unreleased dev builds. */
  buildNumber: string | null;
}

export interface BackendReleaseRef {
  serviceName: string;
  version: string;
}

export interface DatabaseSchemaRef {
  /** Filename of the latest migration, e.g. "0018_evaluation_telemetry.sql". */
  latestMigration: string;
  migrationCount: number;
}

export interface ModelVersionRef {
  id: string;
  version: string;
  deploymentStatus: string;
}

export interface ReleaseRecord {
  schemaVersion: typeof RELEASE_RECORD_SCHEMA_VERSION;
  generatedAtIso: string;
  /** Full 40-hex commit SHA the release was built from. */
  commitSha: string;
  mobileBuild: MobileBuildRef;
  backendRelease: BackendReleaseRef;
  databaseSchema: DatabaseSchemaRef;
  /** Every model in the manifest, pinned by id + version. */
  modelVersions: readonly ModelVersionRef[];
  /** Canonical technique → profileVersion for every registered profile. */
  techniqueAnalysisProfileVersions: Readonly<Record<string, string>>;
  scoreVersion: string;
  faultTaxonomyVersion: string;
  drillLibraryVersion: string;
  captureEnvelopeVersion: string;
  /** Flag key → default enabled state at release time. */
  featureFlags: Readonly<Record<string, boolean>>;
  /** One gate per stage, in RELEASE_STAGES order. */
  stageGates: readonly StageGate[];
  coachReviewGate: CoachReviewGate;
}

/** Fresh gate set: nothing evaluated, external gates honestly blocked. */
export function createInitialStageGates(): StageGate[] {
  return RELEASE_STAGES.map((stage) => {
    const blocked = EXTERNALLY_BLOCKED_STAGES.includes(stage);
    return {
      stage,
      state: blocked ? "BLOCKED_EXTERNAL" : "NOT_RUN",
      evidence: null,
      evaluatedAt: null,
      blockedReason: blocked
        ? "Requires physical-device measurements that cannot be machine-generated."
        : null,
    };
  });
}

export function createInitialCoachReviewGate(): CoachReviewGate {
  return {
    state: "BLOCKED_EXTERNAL",
    evidence: null,
    evaluatedAt: null,
    blockedReason: "Requires reviews from real coaches; machine output is never coach evidence.",
  };
}

export interface ReleaseRecordValidation {
  valid: boolean;
  problems: string[];
}

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;
const MIGRATION_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isGateState(value: unknown): value is GateState {
  return typeof value === "string" && (GATE_STATES as readonly string[]).includes(value);
}

function validateGateShape(
  gate: unknown,
  label: string,
  problems: string[],
): gate is Record<string, unknown> {
  if (!isRecord(gate)) {
    problems.push(`${label} must be an object`);
    return false;
  }
  if (!isGateState(gate["state"])) {
    problems.push(`${label} state must be one of ${GATE_STATES.join(", ")}`);
  }
  if (!isStringOrNull(gate["evidence"])) problems.push(`${label} evidence must be string or null`);
  if (!isStringOrNull(gate["evaluatedAt"])) {
    problems.push(`${label} evaluatedAt must be string or null`);
  }
  if (!isStringOrNull(gate["blockedReason"])) {
    problems.push(`${label} blockedReason must be string or null`);
  }
  if (gate["state"] === "PASSED" && gate["evidence"] === null) {
    problems.push(`${label} cannot be PASSED without evidence`);
  }
  if (
    (gate["state"] === "BLOCKED_EXTERNAL" || gate["state"] === "NOT_EVALUABLE") &&
    gate["blockedReason"] === null
  ) {
    problems.push(`${label} in state ${String(gate["state"])} requires a blockedReason`);
  }
  return true;
}

/**
 * Structural + semantic validation. Returns every problem found rather than
 * failing fast so an incomplete manifest is diagnosable in one pass.
 */
export function validateReleaseRecord(record: unknown): ReleaseRecordValidation {
  const problems: string[] = [];
  if (!isRecord(record)) {
    return { valid: false, problems: ["release record must be an object"] };
  }

  if (record["schemaVersion"] !== RELEASE_RECORD_SCHEMA_VERSION) {
    problems.push(`schemaVersion must be ${RELEASE_RECORD_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(record["generatedAtIso"])) {
    problems.push("generatedAtIso must be a non-empty string");
  }
  if (typeof record["commitSha"] !== "string" || !COMMIT_SHA_PATTERN.test(record["commitSha"])) {
    problems.push("commitSha must be a full 40-hex commit SHA");
  }

  const mobileBuild = record["mobileBuild"];
  if (!isRecord(mobileBuild)) {
    problems.push("mobileBuild must be an object");
  } else {
    if (!isNonEmptyString(mobileBuild["appVersion"])) {
      problems.push("mobileBuild.appVersion must be a non-empty string");
    }
    if (!isStringOrNull(mobileBuild["buildNumber"])) {
      problems.push("mobileBuild.buildNumber must be string or null");
    }
  }

  const backendRelease = record["backendRelease"];
  if (!isRecord(backendRelease)) {
    problems.push("backendRelease must be an object");
  } else {
    if (!isNonEmptyString(backendRelease["serviceName"])) {
      problems.push("backendRelease.serviceName must be a non-empty string");
    }
    if (!isNonEmptyString(backendRelease["version"])) {
      problems.push("backendRelease.version must be a non-empty string");
    }
  }

  const databaseSchema = record["databaseSchema"];
  if (!isRecord(databaseSchema)) {
    problems.push("databaseSchema must be an object");
  } else {
    const latest = databaseSchema["latestMigration"];
    if (typeof latest !== "string" || !MIGRATION_PATTERN.test(latest)) {
      problems.push("databaseSchema.latestMigration must look like NNNN_name.sql");
    }
    const count = databaseSchema["migrationCount"];
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1) {
      problems.push("databaseSchema.migrationCount must be a positive integer");
    }
  }

  const modelVersions = record["modelVersions"];
  if (!Array.isArray(modelVersions) || modelVersions.length === 0) {
    problems.push("modelVersions must be a non-empty array");
  } else {
    const seen = new Set<string>();
    for (const [index, entry] of modelVersions.entries()) {
      if (!isRecord(entry)) {
        problems.push(`modelVersions[${index}] must be an object`);
        continue;
      }
      if (!isNonEmptyString(entry["id"]) || !isNonEmptyString(entry["version"])) {
        problems.push(`modelVersions[${index}] must have non-empty id and version`);
        continue;
      }
      if (!isNonEmptyString(entry["deploymentStatus"])) {
        problems.push(`modelVersions[${index}] must have a deploymentStatus`);
      }
      const key = `${entry["id"]}@${entry["version"]}`;
      if (seen.has(key)) problems.push(`modelVersions contains duplicate entry ${key}`);
      seen.add(key);
    }
  }

  const profiles = record["techniqueAnalysisProfileVersions"];
  if (!isRecord(profiles)) {
    problems.push("techniqueAnalysisProfileVersions must be an object");
  } else if (Object.keys(profiles).length === 0) {
    problems.push("techniqueAnalysisProfileVersions must not be empty");
  } else {
    for (const [canonical, version] of Object.entries(profiles)) {
      if (!isNonEmptyString(version)) {
        problems.push(`techniqueAnalysisProfileVersions.${canonical} must be a non-empty string`);
      }
    }
  }

  for (const field of [
    "scoreVersion",
    "faultTaxonomyVersion",
    "drillLibraryVersion",
    "captureEnvelopeVersion",
  ] as const) {
    if (!isNonEmptyString(record[field])) problems.push(`${field} must be a non-empty string`);
  }

  const featureFlags = record["featureFlags"];
  if (!isRecord(featureFlags)) {
    problems.push("featureFlags must be an object (may be empty, never absent)");
  } else {
    for (const [key, value] of Object.entries(featureFlags)) {
      if (typeof value !== "boolean") problems.push(`featureFlags.${key} must be a boolean`);
    }
  }

  const stageGates = record["stageGates"];
  if (!Array.isArray(stageGates)) {
    problems.push("stageGates must be an array");
  } else {
    if (stageGates.length !== RELEASE_STAGES.length) {
      problems.push(
        `stageGates must contain exactly one gate per stage (${RELEASE_STAGES.length})`,
      );
    }
    const orderedStages = stageGates
      .filter(isRecord)
      .map((gate) => gate["stage"])
      .filter((stage): stage is ReleaseStage =>
        (RELEASE_STAGES as readonly unknown[]).includes(stage),
      );
    for (const [index, stage] of RELEASE_STAGES.entries()) {
      if (orderedStages[index] !== stage) {
        problems.push(`stageGates[${index}] must be for stage "${stage}" (canonical order)`);
        break;
      }
    }
    for (const [index, gate] of stageGates.entries()) {
      validateGateShape(gate, `stageGates[${index}]`, problems);
    }
    let earlierUnresolved = false;
    for (const gate of stageGates) {
      if (!isRecord(gate)) continue;
      if (earlierUnresolved && gate["state"] === "PASSED") {
        problems.push(
          `stage "${String(gate["stage"])}" cannot be PASSED while an earlier stage is unresolved`,
        );
      }
      if (gate["state"] !== "PASSED") earlierUnresolved = true;
    }
  }

  validateGateShape(record["coachReviewGate"], "coachReviewGate", problems);

  return { valid: problems.length === 0, problems };
}
