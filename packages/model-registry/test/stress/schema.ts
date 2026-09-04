import { SHOT_TYPES } from "@pickle/shared-types";
import { EXECUTION_TARGETS, MODEL_RUNTIMES, MODEL_TASKS } from "@pickle/swing-domain";
import { DEPLOYMENT_STATUSES, PLATFORMS } from "../../src/registry.js";

/**
 * Runtime conformance checks mirroring the TypeScript interfaces in
 * src/registry.ts and src/datasetRelease.ts. They are the ORACLE for
 * "accepted although malformed": whenever the production validator lets a
 * value through that these checks reject, the campaign records
 * `accepted_malformed` with the exact violation.
 *
 * They intentionally check TYPES and enumerations only — never business
 * rules the validators own (duplicate ids, lineage coupling, …).
 */

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isStringOrNull = (value: unknown): boolean => value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function oneOf(values: readonly string[], value: unknown): boolean {
  return typeof value === "string" && values.includes(value);
}

export function modelEntryViolations(entry: unknown, where: string): string[] {
  const v: string[] = [];
  if (!isObject(entry)) return [`${where}: entry is ${typeof entry}, not an object`];
  if (typeof entry.id !== "string") v.push(`${where}.id: not a string`);
  if (typeof entry.version !== "string") v.push(`${where}.version: not a string`);
  if (!oneOf(MODEL_TASKS, entry.task)) v.push(`${where}.task: not a ModelTask`);
  if (!oneOf(MODEL_RUNTIMES, entry.runtime)) v.push(`${where}.runtime: not a ModelRuntime`);
  if (!oneOf(EXECUTION_TARGETS, entry.executionTarget)) {
    v.push(`${where}.executionTarget: not an ExecutionTarget`);
  }
  if (!oneOf(DEPLOYMENT_STATUSES, entry.deploymentStatus)) {
    v.push(`${where}.deploymentStatus: not a DeploymentStatus`);
  }
  if (
    !Array.isArray(entry.supportedPlatforms) ||
    !entry.supportedPlatforms.every((p) => oneOf(PLATFORMS, p))
  ) {
    v.push(`${where}.supportedPlatforms: not Platform[]`);
  }
  if (
    entry.supportedStrokes !== "all" &&
    (!Array.isArray(entry.supportedStrokes) ||
      !entry.supportedStrokes.every((s) => oneOf(SHOT_TYPES, s)))
  ) {
    v.push(`${where}.supportedStrokes: not ShotTypeSlug[] | "all"`);
  }
  for (const key of ["inputSchemaVersion", "outputSchemaVersion"] as const) {
    if (!isFiniteNumber(entry[key])) v.push(`${where}.${key}: not a finite number`);
  }
  for (const key of [
    "artifactHash",
    "artifactUri",
    "trainingDatasetVersion",
    "evaluationDatasetVersion",
    "commit",
    "supportedCaptureEnvelope",
    "calibrationVersion",
    "promotionDate",
    "rollbackPredecessor",
    "license",
  ] as const) {
    if (!isStringOrNull(entry[key])) v.push(`${where}.${key}: not string | null`);
  }
  if (entry.splits !== null) {
    const splits = entry.splits;
    if (
      !isObject(splits) ||
      typeof splits.train !== "string" ||
      typeof splits.validation !== "string" ||
      typeof splits.test !== "string"
    ) {
      v.push(`${where}.splits: not DatasetSplits | null`);
    }
  }
  if (entry.metrics !== null) {
    const metrics = entry.metrics;
    if (!isObject(metrics) || !Object.values(metrics).every(isFiniteNumber)) {
      v.push(`${where}.metrics: not Record<string, finite number> | null`);
    }
  }
  if (!isStringArray(entry.runtimeRequirements)) {
    v.push(`${where}.runtimeRequirements: not string[]`);
  }
  if (typeof entry.notes !== "string") v.push(`${where}.notes: not a string`);
  return v;
}

export function modelManifestViolations(manifest: unknown): string[] {
  if (!isObject(manifest)) return [`manifest is ${describeType(manifest)}, not an object`];
  const v: string[] = [];
  if (manifest.schemaVersion !== 1) v.push("schemaVersion: not 1");
  if (!Array.isArray(manifest.entries)) return [...v, "entries: not an array"];
  manifest.entries.forEach((entry, i) => v.push(...modelEntryViolations(entry, `entries[${i}]`)));
  return v;
}

const CLASSIFICATIONS = [
  "gold_human_labels",
  "machine_generated",
  "mixed_human_and_machine",
  "registry_metadata",
  "media",
  "run_outputs",
  "release_snapshots",
] as const;
const STATISTIC_KEYS = [
  "sources",
  "recordings",
  "rootRecordings",
  "sessions",
  "rootFootageMinutes",
  "annotatedCases",
  "goldTargetEvents",
  "tierCCandidateEvents",
  "annotators",
  "expertCoaches",
] as const;

function artifactViolations(ref: unknown, where: string): string[] {
  if (!isObject(ref)) return [`${where}: not an object`];
  const v: string[] = [];
  if (typeof ref.path !== "string") v.push(`${where}.path: not a string`);
  if (!isStringOrNull(ref.livePath)) v.push(`${where}.livePath: not string | null`);
  if (typeof ref.sha256 !== "string") v.push(`${where}.sha256: not a string`);
  return v;
}

export function datasetReleaseViolations(manifest: unknown): string[] {
  if (!isObject(manifest)) return [`manifest is ${describeType(manifest)}, not an object`];
  const v: string[] = [];
  if (manifest.schemaVersion !== 1) v.push("schemaVersion: not 1");
  for (const key of ["releaseId", "datasetId", "version", "createdAtIso"] as const) {
    if (typeof manifest[key] !== "string") v.push(`${key}: not a string`);
  }
  if (manifest.immutable !== true) v.push("immutable: not true");
  if (!isFiniteNumber(manifest.annotationSchemaVersion)) {
    v.push("annotationSchemaVersion: not a finite number");
  }
  if (!Array.isArray(manifest.components)) v.push("components: not an array");
  else {
    manifest.components.forEach((component, i) => {
      const where = `components[${i}]`;
      if (!isObject(component)) {
        v.push(`${where}: not an object`);
        return;
      }
      if (typeof component.componentId !== "string") v.push(`${where}.componentId: not a string`);
      if (typeof component.path !== "string") v.push(`${where}.path: not a string`);
      if (typeof component.description !== "string") v.push(`${where}.description: not a string`);
      if (!oneOf(CLASSIFICATIONS, component.classification)) {
        v.push(`${where}.classification: not a DatasetComponentClassification`);
      }
      if (typeof component.notGold !== "boolean") v.push(`${where}.notGold: not a boolean`);
      if (!isStringOrNull(component.notGoldReason)) {
        v.push(`${where}.notGoldReason: not string | null`);
      }
      if (!Array.isArray(component.artifacts)) v.push(`${where}.artifacts: not an array`);
      else {
        component.artifacts.forEach((ref, j) =>
          v.push(...artifactViolations(ref, `${where}.artifacts[${j}]`)),
        );
      }
    });
  }
  if (!isObject(manifest.statistics)) v.push("statistics: not an object");
  else {
    for (const key of STATISTIC_KEYS) {
      if (!isFiniteNumber(manifest.statistics[key])) {
        v.push(`statistics.${key}: not a finite number`);
      }
    }
    const counts = manifest.statistics.goldLabelCounts;
    if (!isObject(counts) || !Object.values(counts).every(isFiniteNumber)) {
      v.push("statistics.goldLabelCounts: not Record<string, finite number>");
    }
  }
  if (!isObject(manifest.labels)) v.push("labels: not an object");
  else {
    for (const tier of ["GOLD", "SILVER", "TIER_C"] as const) {
      const t = manifest.labels[tier];
      if (!isObject(t) || typeof t.definition !== "string" || !isFiniteNumber(t.count)) {
        v.push(`labels.${tier}: malformed`);
      } else if (tier === "SILVER" && typeof t.verificationNote !== "string") {
        v.push("labels.SILVER.verificationNote: not a string");
      }
    }
  }
  if (!isObject(manifest.rights)) v.push("rights: not an object");
  else {
    if (!isFiniteNumber(manifest.rights.trainingEligibleSources)) {
      v.push("rights.trainingEligibleSources: not a finite number");
    }
    if (!isFiniteNumber(manifest.rights.rightsQuarantinedSources)) {
      v.push("rights.rightsQuarantinedSources: not a finite number");
    }
    if (typeof manifest.rights.policy !== "string") v.push("rights.policy: not a string");
  }
  if (!isObject(manifest.consent)) v.push("consent: not an object");
  else {
    for (const key of [
      "firstPartyRecordings",
      "analysisConsentRecords",
      "trainingConsentRecords",
    ] as const) {
      if (!isFiniteNumber(manifest.consent[key])) v.push(`consent.${key}: not a finite number`);
    }
    if (typeof manifest.consent.policy !== "string") v.push("consent.policy: not a string");
  }
  if (!isObject(manifest.splits)) v.push("splits: not an object");
  else {
    if (typeof manifest.splits.policyVersion !== "string") {
      v.push("splits.policyVersion: not a string");
    }
    if (manifest.splits.unit !== "session") v.push('splits.unit: not "session"');
    const bySplit = manifest.splits.bySplit;
    if (!isObject(bySplit)) v.push("splits.bySplit: not an object");
    else {
      for (const [split, group] of Object.entries(bySplit)) {
        if (!isObject(group) || !isStringArray(group.sessions)) {
          v.push(`splits.bySplit.${split}.sessions: not string[]`);
        }
      }
    }
    if (!isStringArray(manifest.splits.leakageFindings)) {
      v.push("splits.leakageFindings: not string[]");
    }
  }
  if (!isObject(manifest.dedupLineage)) v.push("dedupLineage: not an object");
  else {
    const d = manifest.dedupLineage;
    if (typeof d.algo !== "string") v.push("dedupLineage.algo: not a string");
    for (const key of ["findings", "declaredLineageConfirmed", "mergedSessions"] as const) {
      if (!isFiniteNumber(d[key])) v.push(`dedupLineage.${key}: not a finite number`);
    }
    if (typeof d.limitations !== "string") v.push("dedupLineage.limitations: not a string");
    if (d.report !== null) v.push(...artifactViolations(d.report, "dedupLineage.report"));
  }
  for (const key of ["knownLimitations", "problems", "warnings"] as const) {
    if (!isStringArray(manifest[key])) v.push(`${key}: not string[]`);
  }
  return v;
}

export function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
