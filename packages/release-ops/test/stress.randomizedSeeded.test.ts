import { describe, expect, it } from "vitest";
import {
  RELEASE_RECORD_SCHEMA_VERSION,
  RELEASE_STAGES,
  createInitialCoachReviewGate,
  createInitialStageGates,
  validateReleaseRecord,
  type ReleaseRecord,
  type StageGate,
} from "../src/index.js";
import {
  check,
  describeFailures,
  executeSteps,
  findNonFinite,
  readStressEnv,
  runCampaign,
  type Rng,
} from "../../../tools/stress-kit/kit.js";

/**
 * SEEDED RANDOMIZED LONG-RUN over `validateReleaseRecord`.
 *
 * Each sequence starts from a structurally valid SYNTHETIC release record
 * (no real release evidence is asserted — all gates start NOT_RUN /
 * BLOCKED_EXTERNAL exactly as createInitialStageGates() produces them) and
 * applies 5–60 seeded mutations, some invalidating, some benign, some
 * repairing. After every step the validator is model-checked:
 *
 *  V1  never throws, for any mutated shape (returns {valid, problems}).
 *  V2  valid ⇔ no invalidating mutation is outstanding in the model;
 *      problems is empty ⇔ valid.
 *  V3  every outstanding invalidating dimension is named in `problems`
 *      (diagnosable in one pass — no fail-fast masking).
 *  V4  the input is not mutated (validated through a deep-frozen clone) and
 *      validation is idempotent (two calls → identical result).
 *  V5  TRUTH CONTRACT edges: PASSED without evidence, BLOCKED_EXTERNAL /
 *      NOT_EVALUABLE without blockedReason, a PASSED gate after an unresolved
 *      earlier gate, wrong gate count/order, duplicate model entries,
 *      non-boolean flags, malformed migration name / SHA / schemaVersion are
 *      ALL rejected.
 *  V6  no NaN/Infinity in the output.
 *  D   same seed → identical trace (kit-level).
 */

type Dimension =
  | "schemaVersion"
  | "generatedAtIso"
  | "commitSha"
  | "mobileBuild"
  | "backendRelease"
  | "migrationName"
  | "migrationCount"
  | "modelVersions"
  | "profiles"
  | "registryVersion"
  | "featureFlags"
  | "gateCount"
  | "gateOrder"
  | "gateShape"
  | "gateLeftToRight"
  | "coachGate";

/** Substring the validator must emit for each broken dimension. */
const PROBLEM_MARKER: Record<Dimension, string> = {
  schemaVersion: "schemaVersion must be",
  generatedAtIso: "generatedAtIso",
  commitSha: "commitSha",
  mobileBuild: "mobileBuild",
  backendRelease: "backendRelease",
  migrationName: "latestMigration",
  migrationCount: "migrationCount",
  modelVersions: "modelVersions",
  profiles: "techniqueAnalysisProfileVersions",
  registryVersion: "Version must be a non-empty string",
  featureFlags: "featureFlags",
  gateCount: "exactly one gate per stage",
  gateOrder: "canonical order",
  gateShape: "stageGates[",
  gateLeftToRight: "cannot be PASSED while an earlier stage is unresolved",
  coachGate: "coachReviewGate",
};

type Action =
  | { kind: "break"; dimension: Dimension; variant: number }
  | { kind: "repair"; dimension: Dimension }
  | { kind: "benign"; variant: number }
  | { kind: "passPrefix"; count: number };

const DIMENSIONS = Object.keys(PROBLEM_MARKER) as Dimension[];

function generate(rng: Rng, length: number): Action[] {
  const actions: Action[] = [];
  for (let i = 0; i < length; i += 1) {
    const roll = rng.next();
    if (roll < 0.4)
      actions.push({ kind: "break", dimension: rng.pick(DIMENSIONS), variant: rng.int(4) });
    else if (roll < 0.7) actions.push({ kind: "repair", dimension: rng.pick(DIMENSIONS) });
    else if (roll < 0.9) actions.push({ kind: "benign", variant: rng.int(6) });
    else actions.push({ kind: "passPrefix", count: rng.int(RELEASE_STAGES.length + 1) });
  }
  return actions;
}

// Mutable working copy; `unknown` fields let us inject wrong types.
type Loose = Record<string, unknown>;

function validRecord(): ReleaseRecord {
  return {
    schemaVersion: RELEASE_RECORD_SCHEMA_VERSION,
    generatedAtIso: "2026-09-04T00:00:00.000Z",
    commitSha: "1fb0efd7f3157060af4c61342f5102e068d2ddc5",
    mobileBuild: { appVersion: "0.0.0-synthetic", buildNumber: null },
    backendRelease: { serviceName: "synthetic-api", version: "0.0.0-synthetic" },
    databaseSchema: { latestMigration: "0001_synthetic.sql", migrationCount: 1 },
    modelVersions: [{ id: "synthetic-model", version: "0.0.1", deploymentStatus: "synthetic" }],
    techniqueAnalysisProfileVersions: { synthetic_technique: "synthetic-v1" },
    scoreVersion: "synthetic-score-v1",
    faultTaxonomyVersion: "synthetic-taxonomy-v1",
    drillLibraryVersion: "synthetic-drills-v1",
    captureEnvelopeVersion: "synthetic-envelope-v1",
    featureFlags: { synthetic_flag: false },
    stageGates: createInitialStageGates(),
    coachReviewGate: createInitialCoachReviewGate(),
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** How many leading gates are PASSED in the current (possibly mutated) gate list. */
function passedPrefix(gates: unknown[]): number {
  let n = 0;
  for (const gate of gates) {
    if (typeof gate === "object" && gate !== null && (gate as Loose)["state"] === "PASSED") n += 1;
    else break;
  }
  return n;
}

function repair(record: Loose, dimension: Dimension, fresh: ReleaseRecord): void {
  const gates = record["stageGates"];
  switch (dimension) {
    case "schemaVersion":
      record["schemaVersion"] = fresh.schemaVersion;
      return;
    case "generatedAtIso":
      record["generatedAtIso"] = fresh.generatedAtIso;
      return;
    case "commitSha":
      record["commitSha"] = fresh.commitSha;
      return;
    case "mobileBuild":
      record["mobileBuild"] = deepClone(fresh.mobileBuild);
      return;
    case "backendRelease":
      record["backendRelease"] = deepClone(fresh.backendRelease);
      return;
    case "migrationName":
      (record["databaseSchema"] as Loose)["latestMigration"] = fresh.databaseSchema.latestMigration;
      return;
    case "migrationCount":
      (record["databaseSchema"] as Loose)["migrationCount"] = fresh.databaseSchema.migrationCount;
      return;
    case "modelVersions":
      record["modelVersions"] = deepClone(fresh.modelVersions);
      return;
    case "profiles":
      record["techniqueAnalysisProfileVersions"] = deepClone(
        fresh.techniqueAnalysisProfileVersions,
      );
      return;
    case "registryVersion":
      record["scoreVersion"] = fresh.scoreVersion;
      record["faultTaxonomyVersion"] = fresh.faultTaxonomyVersion;
      return;
    case "featureFlags":
      record["featureFlags"] = deepClone(fresh.featureFlags);
      return;
    case "gateCount":
    case "gateOrder":
    case "gateShape":
    case "gateLeftToRight": {
      // Rebuild gates preserving the PASSED prefix if the list is still well-formed.
      const prefix = Array.isArray(gates) ? passedPrefix(gates) : 0;
      record["stageGates"] = passGates(createInitialStageGates(), prefix);
      return;
    }
    case "coachGate":
      record["coachReviewGate"] = createInitialCoachReviewGate();
      return;
  }
}

function passGates(gates: StageGate[], count: number): StageGate[] {
  return gates.map((gate, index) =>
    index < count
      ? {
          ...gate,
          state: "PASSED",
          evidence: `artifacts/synthetic/${gate.stage}.json`,
          evaluatedAt: "2026-09-04T00:00:00.000Z",
          blockedReason: null,
        }
      : gate,
  );
}

/** Apply an invalidating mutation; returns the dimensions it breaks (may cascade). */
function breakDimension(record: Loose, dimension: Dimension, variant: number): Dimension[] {
  const schema = record["databaseSchema"] as Loose;
  const gates = record["stageGates"] as unknown[];
  switch (dimension) {
    case "schemaVersion":
      record["schemaVersion"] = [2, "1", null, 0][variant];
      return ["schemaVersion"];
    case "generatedAtIso":
      record["generatedAtIso"] = ["", null, 42, undefined][variant];
      return ["generatedAtIso"];
    case "commitSha":
      record["commitSha"] = [
        "1fb0efd7",
        "1FB0EFD7F3157060AF4C61342F5102E068D2DDC5",
        "",
        "g".repeat(40),
      ][variant];
      return ["commitSha"];
    case "mobileBuild":
      record["mobileBuild"] = [
        null,
        { appVersion: "", buildNumber: null },
        { appVersion: "1.0", buildNumber: 7 },
        "1.0",
      ][variant];
      return ["mobileBuild"];
    case "backendRelease":
      record["backendRelease"] = [
        null,
        { serviceName: "", version: "1" },
        { serviceName: "api", version: "" },
        [],
      ][variant];
      return ["backendRelease"];
    case "migrationName":
      schema["latestMigration"] = ["18_x.sql", "0018_Name.sql", "0018_name.SQL", null][variant];
      return ["migrationName"];
    case "migrationCount":
      schema["migrationCount"] = [0, 1.5, Number.NaN, "3"][variant];
      return ["migrationCount"];
    case "modelVersions": {
      const dup = { id: "synthetic-model", version: "0.0.1", deploymentStatus: "synthetic" };
      record["modelVersions"] = [
        [],
        [dup, dup],
        [{ id: "", version: "1", deploymentStatus: "x" }],
        [{ id: "m", version: "1" }],
      ][variant];
      return ["modelVersions"];
    }
    case "profiles":
      record["techniqueAnalysisProfileVersions"] = [{}, { t: "" }, null, []][variant];
      return ["profiles"];
    case "registryVersion":
      if (variant % 2 === 0) record["scoreVersion"] = "";
      else record["faultTaxonomyVersion"] = variant === 1 ? null : 3;
      return ["registryVersion"];
    case "featureFlags":
      record["featureFlags"] = [{ f: "yes" }, { f: 1 }, null, { a: true, b: null }][variant];
      return ["featureFlags"];
    case "gateCount":
      if (variant % 2 === 0) record["stageGates"] = gates.slice(0, -1);
      else record["stageGates"] = [...gates, deepClone(gates[gates.length - 1])];
      // Dropping the last gate or duplicating "full" keeps canonical order for the
      // first 11 positions only in the duplicate case; dropping breaks the count only.
      return ["gateCount"];
    case "gateOrder": {
      const swapped = [...gates];
      const i = variant % (gates.length - 1);
      [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
      record["stageGates"] = swapped;
      return ["gateOrder"];
    }
    case "gateShape": {
      const idx = variant % gates.length;
      const gate = { ...(gates[idx] as Loose) };
      const shapes: Loose[] = [
        { ...gate, state: "PASSED", evidence: null },
        { ...gate, state: "BLOCKED_EXTERNAL", blockedReason: null },
        { ...gate, state: "NOT_EVALUABLE", blockedReason: null },
        { ...gate, state: "DONE" },
      ];
      const next = [...gates];
      next[idx] = shapes[variant]!;
      record["stageGates"] = next;
      // A PASSED gate injected after an unresolved one also trips left-to-right.
      return variant === 0 && idx > passedPrefix(gates)
        ? ["gateShape", "gateLeftToRight"]
        : ["gateShape"];
    }
    case "gateLeftToRight": {
      const prefix = passedPrefix(gates);
      const target = Math.min(prefix + 1 + (variant % 2), gates.length - 1);
      if (target <= prefix) return [];
      const next = [...gates];
      next[target] = {
        ...(gates[target] as Loose),
        state: "PASSED",
        evidence: "artifacts/synthetic/late.json",
        blockedReason: null,
      };
      record["stageGates"] = next;
      return ["gateLeftToRight"];
    }
    case "coachGate":
      record["coachReviewGate"] = [
        { state: "PASSED", evidence: null, evaluatedAt: null, blockedReason: null },
        { state: "BLOCKED_EXTERNAL", evidence: null, evaluatedAt: null, blockedReason: null },
        null,
        { state: "REVIEWED", evidence: "x", evaluatedAt: null, blockedReason: null },
      ][variant];
      return ["coachGate"];
  }
}

function applyBenign(record: Loose, variant: number): string {
  switch (variant) {
    case 0:
      (record["featureFlags"] as Loose)[
        `synthetic_flag_${Object.keys(record["featureFlags"] as Loose).length}`
      ] = true;
      return "add flag";
    case 1:
      (record["mobileBuild"] as Loose)["buildNumber"] = "42";
      return "buildNumber string";
    case 2:
      (record["modelVersions"] as unknown[]).push({
        id: "synthetic-model",
        version: `0.0.${(record["modelVersions"] as unknown[]).length + 1}`,
        deploymentStatus: "synthetic",
      });
      return "add model version";
    case 3:
      record["extraUnknownField"] = { anything: [1, 2, 3] };
      return "extra field";
    case 4:
      (record["techniqueAnalysisProfileVersions"] as Loose)["another_technique"] = "synthetic-v2";
      return "add profile";
    default:
      record["coachReviewGate"] = {
        state: "PASSED",
        evidence: "docs/synthetic/coach.md",
        evaluatedAt: "2026-09-04T00:00:00.000Z",
        blockedReason: null,
      };
      return "coach passed with evidence";
  }
}

function execute(actions: readonly Action[]) {
  const fresh = validRecord();
  const record: Loose = deepClone(fresh) as unknown as Loose;
  const broken = new Set<Dimension>();

  const validateChecked = (): { valid: boolean; problems: string[] } => {
    const frozen = deepFreeze(deepClone(record));
    const before = JSON.stringify(frozen);
    const first = validateReleaseRecord(frozen);
    const second = validateReleaseRecord(frozen);
    check(JSON.stringify(frozen) === before, "V4 input untouched", () => "");
    check(JSON.stringify(first) === JSON.stringify(second), "V4 idempotent", () => "");
    const expectedValid = broken.size === 0;
    check(
      first.valid === expectedValid,
      "V2 valid flag",
      () =>
        `valid=${first.valid} broken=${[...broken].join(",")} problems=${JSON.stringify(first.problems)}`,
    );
    check(first.valid === (first.problems.length === 0), "V2 problems iff invalid", () =>
      JSON.stringify(first),
    );
    for (const dimension of broken) {
      const marker = PROBLEM_MARKER[dimension];
      check(
        first.problems.some((p) => p.includes(marker)),
        "V3 dimension named",
        () => `${dimension} (${marker}) missing from ${JSON.stringify(first.problems)}`,
      );
    }
    const nonFinite = findNonFinite(first);
    check(nonFinite === null, "V6 finite", () => nonFinite ?? "");
    return first;
  };

  validateChecked();

  return executeSteps(actions, (action) => {
    // Gate-family mutations interact; only mutate gates when the list is still an array of gates.
    const gatesWellFormed =
      Array.isArray(record["stageGates"]) &&
      !broken.has("gateCount") &&
      !broken.has("gateOrder") &&
      !broken.has("gateShape") &&
      !broken.has("gateLeftToRight");
    if (action.kind === "break") {
      const isGateDim = action.dimension.startsWith("gate");
      if (isGateDim && !gatesWellFormed) {
        return { skip: action.dimension };
      }
      if (
        (action.dimension === "migrationName" || action.dimension === "migrationCount") &&
        typeof record["databaseSchema"] !== "object"
      ) {
        return { skip: action.dimension };
      }
      const hits = breakDimension(record, action.dimension, action.variant);
      for (const d of hits) broken.add(d);
      const result = validateChecked();
      return {
        break: action.dimension,
        variant: action.variant,
        valid: result.valid,
        problems: result.problems.length,
      };
    }
    if (action.kind === "repair") {
      repair(record, action.dimension, fresh);
      if (action.dimension.startsWith("gate")) {
        for (const d of ["gateCount", "gateOrder", "gateShape", "gateLeftToRight"] as const)
          broken.delete(d);
      } else {
        broken.delete(action.dimension);
      }
      const result = validateChecked();
      return { repair: action.dimension, valid: result.valid };
    }
    if (action.kind === "passPrefix") {
      if (!gatesWellFormed) return { skip: "passPrefix" };
      record["stageGates"] = passGates(createInitialStageGates(), action.count);
      const result = validateChecked();
      return { passPrefix: action.count, valid: result.valid };
    }
    // benign — only when the touched containers are intact
    const containers: Record<number, string> = {
      0: "featureFlags",
      1: "mobileBuild",
      2: "modelVersions",
      4: "techniqueAnalysisProfileVersions",
    };
    const container = containers[action.variant];
    if (container !== undefined) {
      const value = record[container];
      const intact =
        container === "modelVersions"
          ? Array.isArray(value)
          : typeof value === "object" && value !== null && !Array.isArray(value);
      const dimensionForContainer: Record<string, Dimension> = {
        featureFlags: "featureFlags",
        mobileBuild: "mobileBuild",
        modelVersions: "modelVersions",
        techniqueAnalysisProfileVersions: "profiles",
      };
      if (!intact || broken.has(dimensionForContainer[container]!))
        return { skip: `benign-${action.variant}` };
    }
    if (action.variant === 5) broken.delete("coachGate");
    const label = applyBenign(record, action.variant);
    const result = validateChecked();
    return { benign: label, valid: result.valid };
  });
}

const env = readStressEnv(300);

describe("release-ops seeded randomized long-run", () => {
  it("validateReleaseRecord invariants V1–V6 hold for every seed and every step; same seed → same trace", () => {
    const report = runCampaign<Action>({
      campaign: "release-ops",
      env,
      minLength: 5,
      maxLength: 60,
      generate,
      execute,
    });
    expect(report.sequencesExecuted).toBe(env.iterations);
    expect(describeFailures(report)).toBe("");
    expect(report.broken + report.nondeterministic).toBe(0);
  });
});
