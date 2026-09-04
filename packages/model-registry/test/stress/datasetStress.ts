import {
  DatasetReleaseIndex,
  assertValidDatasetReleaseManifest,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetComponent,
  type DatasetReleaseManifest,
  type ModelManifest,
  type ModelManifestEntry,
} from "../../src/index.js";
import { errorMessage, type Rng, type SequenceRun, type StepFailure } from "./harness.js";
import { legalEntry } from "./registryStress.js";

/**
 * Randomized sequences over dataset-release validation, DatasetReleaseIndex and
 * auditModelDatasetLineage, checked against a reference model of the contract
 * documented in datasetRelease.ts:
 *
 *  D1 validateDatasetReleaseManifest returns [] iff no documented governance /
 *     structural rule is violated; it never throws and never mutates its input;
 *     assertValid… throws iff validate… is non-empty.
 *  D2 register() throws iff the manifest is invalid or releaseId / version is
 *     already indexed; on success has(releaseId) && has(version) and
 *     byVersion(...) returns the SAME manifest object; a rejected register
 *     leaves versions() unchanged (atomic).
 *  D3 registerLegacy(v) throws iff v is already indexed; afterwards has(v) is
 *     true and byVersion(v) is null.
 *  D4 versions() lists every indexed key in insertion order.
 *  D5 auditModelDatasetLineage reports exactly one problem per non-null
 *     dataset pointer that does not resolve; null pointers pass.
 *
 * Two additional properties come from the stress brief ("no NaN/Infinity in
 * outputs") and the leakage doc comment ("every session that spans splits must
 * be recorded"); they are generated only when the corresponding option is on so
 * the legal campaign and the defect pins stay separate:
 *  D6 a ±Infinity statistic must be rejected like NaN is.
 *  D7 a leakage finding for session "s10" must not satisfy session "s1".
 */

export const DATASET_DEFECTS = [
  "schema_version",
  "empty_dataset_id",
  "bad_version",
  "release_id_mismatch",
  "bad_timestamp",
  "not_immutable",
  "bad_annotation_schema",
  "no_components",
  "duplicate_component",
  "empty_component_path",
  "not_gold_without_reason",
  "gold_marked_not_gold",
  "machine_not_marked",
  "empty_artifact_path",
  "bad_sha256",
  "negative_statistic",
  "nan_statistic",
  "bad_gold_count",
  "silver_without_note",
  "tier_c_definition",
  "consent_policy",
  "training_exceeds_analysis",
  "empty_rights_policy",
  "empty_split_policy",
  "unrecorded_leakage",
  "bad_dedup_report",
  "no_limitations",
] as const;
export type DatasetDefect = (typeof DATASET_DEFECTS)[number];

/** Extra-strict mutations; see D6/D7. */
export const DATASET_STRICT_DEFECTS = ["infinite_statistic", "substring_leakage_finding"] as const;
export type DatasetStrictDefect = (typeof DATASET_STRICT_DEFECTS)[number];

export interface DatasetGeneratorOptions {
  strict: boolean;
}

export type DatasetAction =
  | { kind: "validate"; manifest: DatasetReleaseManifest }
  | { kind: "register"; manifest: DatasetReleaseManifest }
  | { kind: "registerLegacy"; version: string }
  | { kind: "has"; version: string }
  | { kind: "byVersion"; version: string }
  | { kind: "versions" }
  | { kind: "audit"; manifest: ModelManifest };

const DATASET_IDS = ["pickle-real", "paddle-distill", "synthetic-court"] as const;
const LEGACY_VERSIONS = ["pickle-real-v0.3", "paddle-distill-v0.1", "legacy-x"] as const;
const SESSIONS = ["s1", "s2", "s3", "s10", "s11", "s21"] as const;
const SHA_OK = "0123456789abcdef".repeat(4);

function randomVersion(rng: Rng): string {
  const major = rng.int(0, 5);
  return rng.chance(0.5) ? `v${major}` : `v${major}.${rng.int(0, 9)}`;
}

function component(rng: Rng, id: string): DatasetComponent {
  const classification = rng.pick([
    "gold_human_labels",
    "machine_generated",
    "mixed_human_and_machine",
    "registry_metadata",
    "media",
    "run_outputs",
    "release_snapshots",
  ] as const);
  const mustBeNotGold = classification === "machine_generated" || classification === "run_outputs";
  const notGold = mustBeNotGold || (classification !== "gold_human_labels" && rng.chance(0.4));
  return {
    componentId: id,
    path: `datasets/${id}`,
    description: `stress ${id}`,
    classification,
    notGold,
    notGoldReason: notGold ? "synthetic stress data" : null,
    artifacts: Array.from({ length: rng.int(0, 2) }, (_, i) => ({
      path: `${id}/artifact-${i}.json`,
      livePath: rng.chance(0.5) ? null : `live/${id}-${i}.json`,
      sha256: SHA_OK,
    })),
  };
}

/** Structurally and governance-legal manifest. */
export function legalDatasetManifest(rng: Rng): DatasetReleaseManifest {
  const datasetId = rng.pick(DATASET_IDS);
  const version = randomVersion(rng);
  const componentCount = rng.int(1, 3);
  const components = Array.from({ length: componentCount }, (_, i) => component(rng, `c${i}`));
  const trainSessions = rng.subset(SESSIONS, 0.5);
  const testSessions = SESSIONS.filter((session) => !trainSessions.includes(session));
  const analysis = rng.int(0, 50);
  const silver = rng.int(0, 5);
  const tierC = rng.int(0, 5);
  return {
    schemaVersion: 1,
    releaseId: `${datasetId}@${version}`,
    datasetId,
    version,
    createdAtIso: "2026-09-04T00:00:00.000Z",
    immutable: true,
    annotationSchemaVersion: rng.int(1, 3),
    components,
    statistics: {
      sources: rng.int(0, 10),
      recordings: rng.int(0, 100),
      rootRecordings: rng.int(0, 100),
      sessions: SESSIONS.length,
      rootFootageMinutes: rng.int(0, 1000) / 10,
      annotatedCases: rng.int(0, 100),
      goldTargetEvents: rng.int(0, 100),
      tierCCandidateEvents: tierC,
      goldLabelCounts: { forehand_drive: rng.int(0, 20), dink: rng.int(0, 20) },
      annotators: rng.int(0, 3),
      expertCoaches: rng.int(0, 2),
    },
    labels: {
      GOLD: { definition: "human-verified", count: rng.int(0, 20) },
      SILVER: {
        definition: "reviewed once",
        count: silver,
        verificationNote: silver > 0 || rng.chance(0.5) ? "second-pass spot check" : "",
      },
      TIER_C: { definition: "candidates are never labels", count: tierC },
    },
    rights: {
      trainingEligibleSources: rng.int(0, 5),
      rightsQuarantinedSources: rng.int(0, 5),
      policy: "per-modality",
    },
    consent: {
      firstPartyRecordings: rng.int(0, 50),
      analysisConsentRecords: analysis,
      trainingConsentRecords: rng.int(0, analysis),
      policy: "analysis consent never implies training consent",
    },
    splits: {
      policyVersion: "split-policy-v1",
      unit: "session",
      bySplit: { train: { sessions: trainSessions }, test: { sessions: testSessions } },
      leakageFindings: [],
    },
    dedupLineage: {
      algo: "phash-v1",
      findings: rng.int(0, 3),
      declaredLineageConfirmed: rng.int(0, 3),
      mergedSessions: rng.int(0, 3),
      limitations: "stress",
      report: rng.chance(0.5)
        ? null
        : { path: "dedup/report.json", livePath: null, sha256: SHA_OK },
    },
    knownLimitations: ["synthetic stress release"],
    problems: [],
    warnings: [],
  };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One documented rule broken on purpose. */
export function defectiveDatasetManifest(
  rng: Rng,
  defect: DatasetDefect | DatasetStrictDefect,
): DatasetReleaseManifest {
  const m = legalDatasetManifest(rng);
  const first = m.components[0]!;
  switch (defect) {
    case "schema_version":
      return { ...m, schemaVersion: 2 as unknown as 1 };
    case "empty_dataset_id":
      return { ...m, datasetId: "", releaseId: `@${m.version}` };
    case "bad_version": {
      const version = rng.pick(["1.0", "v", "latest", "v1-rc", "V1", " v1"]);
      return { ...m, version, releaseId: `${m.datasetId}@${version}` };
    }
    case "release_id_mismatch":
      return {
        ...m,
        releaseId: rng.pick([`${m.datasetId}@v99`, m.version, `${m.datasetId}:${m.version}`]),
      };
    case "bad_timestamp":
      return { ...m, createdAtIso: rng.pick(["not-a-date", "", "2026-13-45T00:00:00Z"]) };
    case "not_immutable":
      return { ...m, immutable: false as unknown as true };
    case "bad_annotation_schema":
      return {
        ...m,
        annotationSchemaVersion: rng.pick([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]),
      };
    case "no_components":
      return { ...m, components: [] };
    case "duplicate_component":
      return { ...m, components: [...m.components, { ...clone(first) }] };
    case "empty_component_path":
      return { ...m, components: [{ ...first, path: "" }, ...m.components.slice(1)] };
    case "not_gold_without_reason":
      return {
        ...m,
        components: [
          { ...first, classification: "media", notGold: true, notGoldReason: rng.pick([null, ""]) },
          ...m.components.slice(1),
        ],
      };
    case "gold_marked_not_gold":
      return {
        ...m,
        components: [
          { ...first, classification: "gold_human_labels", notGold: true, notGoldReason: "oops" },
          ...m.components.slice(1),
        ],
      };
    case "machine_not_marked":
      return {
        ...m,
        components: [
          {
            ...first,
            classification: rng.pick(["machine_generated", "run_outputs"] as const),
            notGold: false,
            notGoldReason: null,
          },
          ...m.components.slice(1),
        ],
      };
    case "empty_artifact_path":
      return {
        ...m,
        components: [
          { ...first, artifacts: [{ path: "", livePath: null, sha256: SHA_OK }] },
          ...m.components.slice(1),
        ],
      };
    case "bad_sha256":
      return {
        ...m,
        components: [
          {
            ...first,
            artifacts: [
              {
                path: "a.json",
                livePath: null,
                sha256: rng.pick(["abc", SHA_OK.toUpperCase(), `${SHA_OK}0`, ""]),
              },
            ],
          },
          ...m.components.slice(1),
        ],
      };
    case "negative_statistic":
      return { ...m, statistics: { ...m.statistics, recordings: -rng.int(1, 9) } };
    case "nan_statistic":
      return { ...m, statistics: { ...m.statistics, rootFootageMinutes: Number.NaN } };
    case "infinite_statistic":
      return {
        ...m,
        statistics: {
          ...m.statistics,
          rootFootageMinutes: rng.chance(0.5) ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY,
        },
      };
    case "bad_gold_count":
      return {
        ...m,
        statistics: {
          ...m.statistics,
          goldLabelCounts: {
            ...m.statistics.goldLabelCounts,
            dink: rng.pick([-1, 1.5, Number.NaN]),
          },
        },
      };
    case "silver_without_note":
      return {
        ...m,
        labels: {
          ...m.labels,
          SILVER: { definition: "x", count: rng.int(1, 5), verificationNote: "" },
        },
      };
    case "tier_c_definition":
      return {
        ...m,
        labels: { ...m.labels, TIER_C: { definition: "machine output", count: rng.int(1, 5) } },
      };
    case "consent_policy":
      return {
        ...m,
        consent: { ...m.consent, policy: rng.pick(["analysis only", "training only", ""]) },
      };
    case "training_exceeds_analysis":
      return {
        ...m,
        consent: { ...m.consent, analysisConsentRecords: 3, trainingConsentRecords: rng.int(4, 9) },
      };
    case "empty_rights_policy":
      return { ...m, rights: { ...m.rights, policy: "" } };
    case "empty_split_policy":
      return { ...m, splits: { ...m.splits, policyVersion: "" } };
    case "unrecorded_leakage": {
      const leaked = rng.pick(SESSIONS);
      return {
        ...m,
        splits: {
          ...m.splits,
          bySplit: { train: { sessions: [leaked, "s99"] }, test: { sessions: [leaked] } },
          leakageFindings: rng.chance(0.5) ? [] : ["session s99 appears in train and validation"],
        },
      };
    }
    case "substring_leakage_finding":
      return {
        ...m,
        splits: {
          ...m.splits,
          bySplit: { train: { sessions: ["s1", "s10"] }, test: { sessions: ["s1", "s10"] } },
          // Only s10 is recorded; s1 is a substring of s10 and must still be reported.
          leakageFindings: ["session s10 appears in train and test"],
        },
      };
    case "bad_dedup_report":
      return {
        ...m,
        dedupLineage: {
          ...m.dedupLineage,
          report: { path: rng.pick(["", "r.json"]), livePath: null, sha256: "zz" },
        },
      };
    case "no_limitations":
      return { ...m, knownLimitations: [] };
  }
}

function randomManifest(rng: Rng, options: DatasetGeneratorOptions): DatasetReleaseManifest {
  if (rng.chance(0.65)) return legalDatasetManifest(rng);
  if (options.strict && rng.chance(0.25))
    return defectiveDatasetManifest(rng, rng.pick(DATASET_STRICT_DEFECTS));
  return defectiveDatasetManifest(rng, rng.pick(DATASET_DEFECTS));
}

function modelManifestWithPointers(rng: Rng, knownVersions: readonly string[]): ModelManifest {
  const entries: ModelManifestEntry[] = [];
  const count = rng.int(0, 4);
  const pointer = (): string | null => {
    const roll = rng.next();
    if (roll < 0.35) return null;
    if (roll < 0.8 && knownVersions.length > 0) return rng.pick(knownVersions);
    return rng.pick(["v77", "ghost@v1", "pickle-real-v9.9"]);
  };
  for (let i = 0; i < count; i += 1) {
    const base = legalEntry(rng, entries);
    const training = pointer();
    const evaluation = pointer();
    entries.push({
      ...base,
      id: `m${i}`,
      version: `v${i}`,
      rollbackPredecessor: null,
      trainingDatasetVersion: training,
      evaluationDatasetVersion: evaluation,
      splits: training === null ? null : base.splits,
      metrics: evaluation === null ? null : base.metrics,
    });
  }
  return { schemaVersion: 1, entries };
}

export function generateDatasetActions(
  rng: Rng,
  length: number,
  options: DatasetGeneratorOptions = { strict: false },
): DatasetAction[] {
  const actions: DatasetAction[] = [];
  const known: string[] = [];
  const anyVersion = (): string =>
    known.length > 0 && rng.chance(0.7)
      ? rng.pick(known)
      : rng.pick([...LEGACY_VERSIONS, "v9.9", "nope@v1"]);
  while (actions.length < length) {
    const roll = rng.next();
    if (roll < 0.2) {
      actions.push({ kind: "validate", manifest: randomManifest(rng, options) });
    } else if (roll < 0.45) {
      const manifest = randomManifest(rng, options);
      actions.push({ kind: "register", manifest });
      if (datasetValidity(manifest, options.strict).length === 0)
        known.push(manifest.releaseId, manifest.version);
    } else if (roll < 0.55) {
      const version = rng.chance(0.7) ? rng.pick(LEGACY_VERSIONS) : anyVersion();
      actions.push({ kind: "registerLegacy", version });
      known.push(version);
    } else if (roll < 0.7) {
      actions.push({ kind: "has", version: anyVersion() });
    } else if (roll < 0.82) {
      actions.push({ kind: "byVersion", version: anyVersion() });
    } else if (roll < 0.88) {
      actions.push({ kind: "versions" });
    } else {
      actions.push({ kind: "audit", manifest: modelManifestWithPointers(rng, known) });
    }
  }
  return actions;
}

// ── Reference model ─────────────────────────────────────────────────────────

const SHA = /^[0-9a-f]{64}$/;
const VERSION = /^v\d+(\.\d+)*$/;

/** Independent re-statement of the documented rules; returns rule names (empty = valid). */
export function datasetValidity(m: DatasetReleaseManifest, strict: boolean): string[] {
  const rules: string[] = [];
  if (m.schemaVersion !== 1) rules.push("schema_version");
  if (m.datasetId.length === 0) rules.push("empty_dataset_id");
  if (!VERSION.test(m.version)) rules.push("bad_version");
  if (m.releaseId !== `${m.datasetId}@${m.version}`) rules.push("release_id_mismatch");
  if (Number.isNaN(Date.parse(m.createdAtIso))) rules.push("bad_timestamp");
  if (m.immutable !== true) rules.push("not_immutable");
  if (!Number.isInteger(m.annotationSchemaVersion) || m.annotationSchemaVersion < 1)
    rules.push("bad_annotation_schema");
  if (m.components.length === 0) rules.push("no_components");
  const ids = new Set<string>();
  for (const c of m.components) {
    if (ids.has(c.componentId)) rules.push("duplicate_component");
    ids.add(c.componentId);
    if (c.path.length === 0) rules.push("empty_component_path");
    if (c.notGold && (c.notGoldReason ?? "").length === 0) rules.push("not_gold_without_reason");
    if (c.classification === "gold_human_labels" && c.notGold) rules.push("gold_marked_not_gold");
    if (
      (c.classification === "machine_generated" || c.classification === "run_outputs") &&
      !c.notGold
    ) {
      rules.push("machine_not_marked");
    }
    for (const a of c.artifacts) {
      if (a.path.length === 0) rules.push("empty_artifact_path");
      if (!SHA.test(a.sha256)) rules.push("bad_sha256");
    }
  }
  for (const value of Object.values(m.statistics)) {
    if (typeof value === "number") {
      if (value < 0 || Number.isNaN(value)) rules.push("negative_or_nan_statistic");
      else if (strict && !Number.isFinite(value)) rules.push("infinite_statistic");
    }
  }
  for (const value of Object.values(m.statistics.goldLabelCounts)) {
    if (value < 0 || !Number.isInteger(value)) rules.push("bad_gold_count");
  }
  if (m.labels.SILVER.count > 0 && m.labels.SILVER.verificationNote.length === 0)
    rules.push("silver_without_note");
  if (m.labels.TIER_C.count > 0 && !/never|candidate/i.test(m.labels.TIER_C.definition))
    rules.push("tier_c_definition");
  if (!/analysis/i.test(m.consent.policy) || !/training/i.test(m.consent.policy))
    rules.push("consent_policy");
  if (m.consent.trainingConsentRecords > m.consent.analysisConsentRecords)
    rules.push("training_exceeds_analysis");
  if (m.rights.policy.length === 0) rules.push("empty_rights_policy");
  if (m.splits.policyVersion.length === 0) rules.push("empty_split_policy");
  const splitsOf = new Map<string, number>();
  for (const group of Object.values(m.splits.bySplit)) {
    for (const session of group.sessions) splitsOf.set(session, (splitsOf.get(session) ?? 0) + 1);
  }
  for (const [session, count] of splitsOf) {
    if (count < 2) continue;
    const recorded = strict
      ? m.splits.leakageFindings.some((f) => f.split(/[^A-Za-z0-9_-]+/).includes(session))
      : m.splits.leakageFindings.some((f) => f.includes(session));
    if (!recorded) rules.push("unrecorded_leakage");
  }
  if (m.dedupLineage.report !== null) {
    if (m.dedupLineage.report.path.length === 0) rules.push("empty_artifact_path");
    if (!SHA.test(m.dedupLineage.report.sha256)) rules.push("bad_sha256");
  }
  if (m.knownLimitations.length === 0) rules.push("no_limitations");
  return rules;
}

// ── Executor ────────────────────────────────────────────────────────────────

export function executeDatasetActions(strict: boolean) {
  return (actions: DatasetAction[], seed: number): SequenceRun<DatasetAction> => {
    const trace: string[] = [];
    let failure: StepFailure | null = null;
    const fail = (step: number, invariant: string, detail: string): void => {
      failure = { step, invariant, detail };
    };

    const index = new DatasetReleaseIndex();
    /** Model: key → manifest | "legacy", insertion ordered like the index. */
    const model = new Map<string, DatasetReleaseManifest | "legacy">();

    const checkIndex = (step: number): boolean => {
      const listed = index.versions();
      const expected = [...model.keys()];
      if (listed.length !== expected.length || listed.some((v, i) => v !== expected[i])) {
        fail(
          step,
          "D4_versions_mismatch",
          `index=[${listed.join(",")}] model=[${expected.join(",")}]`,
        );
        return false;
      }
      return true;
    };

    for (let step = 0; step < actions.length && failure === null; step += 1) {
      const action = actions[step]!;
      switch (action.kind) {
        case "validate": {
          const before = JSON.stringify(action.manifest);
          const rules = datasetValidity(action.manifest, strict);
          let problems: string[];
          try {
            problems = validateDatasetReleaseManifest(action.manifest);
          } catch (error) {
            fail(step, "D1_validate_threw", errorMessage(error));
            break;
          }
          if (JSON.stringify(action.manifest) !== before) {
            fail(step, "D1_validate_mutated_input", action.manifest.releaseId);
            break;
          }
          if ((problems.length === 0) !== (rules.length === 0)) {
            fail(
              step,
              problems.length === 0 ? "D1_accepts_invalid_manifest" : "D1_rejects_valid_manifest",
              `model=[${rules.join(",")}] problems=[${problems.join(" | ")}]`,
            );
            break;
          }
          let threw = false;
          try {
            assertValidDatasetReleaseManifest(action.manifest);
          } catch {
            threw = true;
          }
          if (threw !== problems.length > 0) {
            fail(
              step,
              "D1_assert_disagrees_with_validate",
              `threw=${threw} problems=${problems.length}`,
            );
            break;
          }
          trace.push(
            problems.length === 0 ? "validate ok" : `validate rejected ${rules[0] ?? "?"}`,
          );
          break;
        }
        case "register": {
          const rules = datasetValidity(action.manifest, strict);
          const clash = model.has(action.manifest.releaseId) || model.has(action.manifest.version);
          const expectedRejection = rules[0] ?? (clash ? "duplicate" : null);
          const before = index.versions().join("|");
          try {
            index.register(action.manifest);
            if (expectedRejection !== null) {
              fail(
                step,
                "D2_register_accepts_invalid",
                `expected rejection for ${expectedRejection}`,
              );
              break;
            }
            model.set(action.manifest.releaseId, action.manifest);
            model.set(action.manifest.version, action.manifest);
            if (
              !index.has(action.manifest.releaseId) ||
              !index.has(action.manifest.version) ||
              index.byVersion(action.manifest.version) !== action.manifest ||
              index.byVersion(action.manifest.releaseId) !== action.manifest
            ) {
              fail(step, "D2_registered_not_resolvable", action.manifest.releaseId);
              break;
            }
            trace.push(`register ok ${action.manifest.releaseId}`);
          } catch (error) {
            if (expectedRejection === null) {
              fail(step, "D2_register_rejects_valid", errorMessage(error));
              break;
            }
            if (index.versions().join("|") !== before) {
              fail(step, "D2_register_not_atomic", "versions() changed after rejected register");
              break;
            }
            trace.push(`register rejected ${expectedRejection}`);
          }
          break;
        }
        case "registerLegacy": {
          const clash = model.has(action.version);
          try {
            index.registerLegacy(action.version);
            if (clash) {
              fail(step, "D3_legacy_duplicate_accepted", action.version);
              break;
            }
            model.set(action.version, "legacy");
            if (!index.has(action.version) || index.byVersion(action.version) !== null) {
              fail(step, "D3_legacy_not_indexed_as_legacy", action.version);
              break;
            }
            trace.push(`registerLegacy ok ${action.version}`);
          } catch (error) {
            if (!clash) {
              fail(step, "D3_legacy_rejects_fresh", errorMessage(error));
              break;
            }
            trace.push(`registerLegacy rejected duplicate ${action.version}`);
          }
          break;
        }
        case "has": {
          const result = index.has(action.version);
          if (result !== model.has(action.version)) {
            fail(step, "D2_has_mismatch", action.version);
            break;
          }
          trace.push(`has ${result ? "hit" : "miss"} ${action.version}`);
          break;
        }
        case "byVersion": {
          const result = index.byVersion(action.version);
          const entry = model.get(action.version);
          const expected = entry === undefined || entry === "legacy" ? null : entry;
          if (result !== expected) {
            fail(step, "D2_byVersion_mismatch", action.version);
            break;
          }
          trace.push(`byVersion ${result === null ? "null" : "hit"} ${action.version}`);
          break;
        }
        case "versions": {
          const listed = index.versions();
          listed.push("forged");
          if (index.versions().includes("forged")) {
            fail(step, "D4_versions_returns_internal_array", "");
            break;
          }
          trace.push(`versions ok ${listed.length - 1}`);
          break;
        }
        case "audit": {
          const problems = auditModelDatasetLineage(action.manifest, index);
          let expected = 0;
          for (const entry of action.manifest.entries) {
            for (const pointer of [entry.trainingDatasetVersion, entry.evaluationDatasetVersion]) {
              if (pointer !== null && !model.has(pointer)) expected += 1;
            }
          }
          if (problems.length !== expected) {
            fail(step, "D5_audit_count", `problems=${problems.length} expected=${expected}`);
            break;
          }
          trace.push(`audit ${expected === 0 ? "clean" : "problems"} ${expected}`);
          break;
        }
      }
      if (failure === null) checkIndex(step);
    }
    return { seed, actions, trace, failure };
  };
}
