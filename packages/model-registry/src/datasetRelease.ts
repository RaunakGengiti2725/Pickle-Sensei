import type { ModelManifest } from "./registry.js";

/**
 * Versioned dataset releases — the dataset-side half of model↔data lineage.
 *
 * A DatasetReleaseManifest is an immutable, hash-sealed description of what
 * data existed at a version: recordings, sessions, events, labels (with tier
 * accounting — machine output is NEVER silently a gold label), per-modality
 * rights, consent (analysis consent is separate from training consent),
 * splits, dedup lineage, annotation schema version, statistics, and known
 * limitations.
 *
 * Model manifest entries point at releases through `trainingDatasetVersion`
 * / `evaluationDatasetVersion`; `auditModelDatasetLineage` verifies every
 * non-null pointer resolves to an exact registered release.
 */

export const DATASET_RELEASE_SCHEMA_VERSION = 1 as const;

/** Repo-relative artifact reference, frozen by content hash. */
export interface DatasetArtifactRef {
  /** Path of the frozen copy inside the release directory (or the live file for append-only registries). */
  path: string;
  /** Live repo path the artifact was captured from; null when path IS the live file. */
  livePath: string | null;
  sha256: string;
}

export type DatasetComponentClassification =
  | "gold_human_labels"
  | "machine_generated"
  | "mixed_human_and_machine"
  | "registry_metadata"
  | "media"
  | "run_outputs"
  | "release_snapshots";

export interface DatasetComponent {
  componentId: string;
  /** Repo-relative directory. */
  path: string;
  description: string;
  classification: DatasetComponentClassification;
  /** True when contents are machine-generated / synthetic / unverified — never reportable as gold. */
  notGold: boolean;
  /** Required whenever notGold is true. */
  notGoldReason: string | null;
  artifacts: DatasetArtifactRef[];
}

export interface DatasetReleaseStatistics {
  sources: number;
  recordings: number;
  rootRecordings: number;
  sessions: number;
  rootFootageMinutes: number;
  annotatedCases: number;
  goldTargetEvents: number;
  tierCCandidateEvents: number;
  goldLabelCounts: Record<string, number>;
  annotators: number;
  expertCoaches: number;
}

export interface DatasetReleaseLabelTiers {
  GOLD: { definition: string; count: number };
  SILVER: { definition: string; count: number; verificationNote: string };
  TIER_C: { definition: string; count: number };
}

export interface DatasetReleaseRights {
  trainingEligibleSources: number;
  rightsQuarantinedSources: number;
  /** How rights gate training eligibility (per-modality answers, quarantine rule). */
  policy: string;
}

export interface DatasetReleaseConsent {
  firstPartyRecordings: number;
  analysisConsentRecords: number;
  trainingConsentRecords: number;
  /** Must state that analysis consent never implies training consent. */
  policy: string;
}

export interface DatasetReleaseSplits {
  policyVersion: string;
  /** The grouping unit that splits are assigned at. */
  unit: "session";
  bySplit: Record<string, { sessions: string[] }>;
  /** Every session that spans splits must be recorded here as a known finding. */
  leakageFindings: string[];
}

export interface DatasetReleaseDedupLineage {
  algo: string;
  findings: number;
  declaredLineageConfirmed: number;
  mergedSessions: number;
  limitations: string;
  report: DatasetArtifactRef | null;
}

export interface DatasetReleaseManifest {
  schemaVersion: typeof DATASET_RELEASE_SCHEMA_VERSION;
  /** Globally unique pointer target: `${datasetId}@${version}`. */
  releaseId: string;
  datasetId: string;
  version: string;
  createdAtIso: string;
  immutable: true;
  annotationSchemaVersion: number;
  components: DatasetComponent[];
  statistics: DatasetReleaseStatistics;
  labels: DatasetReleaseLabelTiers;
  rights: DatasetReleaseRights;
  consent: DatasetReleaseConsent;
  splits: DatasetReleaseSplits;
  dedupLineage: DatasetReleaseDedupLineage;
  knownLimitations: string[];
  problems: string[];
  warnings: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const VERSION_PATTERN = /^v\d+(\.\d+)*$/;

function validateArtifact(ref: DatasetArtifactRef, where: string, problems: string[]): void {
  if (ref.path.length === 0) problems.push(`${where}: empty artifact path`);
  if (!SHA256_HEX.test(ref.sha256)) problems.push(`${where}: malformed sha256 (${ref.sha256})`);
}

/**
 * Structural + governance validation. Returns problems (empty = valid);
 * never throws so callers can report all findings at once.
 */
export function validateDatasetReleaseManifest(manifest: DatasetReleaseManifest): string[] {
  const problems: string[] = [];
  if (manifest.schemaVersion !== DATASET_RELEASE_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion: ${String(manifest.schemaVersion)}`);
  }
  if (manifest.datasetId.length === 0) problems.push("empty datasetId");
  if (!VERSION_PATTERN.test(manifest.version)) {
    problems.push(`version must match ${VERSION_PATTERN.source}: ${manifest.version}`);
  }
  if (manifest.releaseId !== `${manifest.datasetId}@${manifest.version}`) {
    problems.push(`releaseId must be datasetId@version, got: ${manifest.releaseId}`);
  }
  if (Number.isNaN(Date.parse(manifest.createdAtIso))) {
    problems.push(`createdAtIso is not a parseable timestamp: ${manifest.createdAtIso}`);
  }
  if (manifest.immutable !== true) problems.push("releases must be immutable");
  if (!Number.isInteger(manifest.annotationSchemaVersion) || manifest.annotationSchemaVersion < 1) {
    problems.push("annotationSchemaVersion must be a positive integer");
  }

  if (manifest.components.length === 0) problems.push("no components");
  const componentIds = new Set<string>();
  for (const component of manifest.components) {
    const where = `component ${component.componentId}`;
    if (componentIds.has(component.componentId)) problems.push(`duplicate ${where}`);
    componentIds.add(component.componentId);
    if (component.path.length === 0) problems.push(`${where}: empty path`);
    if (component.notGold && (component.notGoldReason ?? "").length === 0) {
      problems.push(`${where}: notGold requires a notGoldReason`);
    }
    if (component.classification === "gold_human_labels" && component.notGold) {
      problems.push(`${where}: gold_human_labels cannot also be notGold — reclassify honestly`);
    }
    if (
      (component.classification === "machine_generated" ||
        component.classification === "run_outputs") &&
      !component.notGold
    ) {
      problems.push(`${where}: ${component.classification} must be marked notGold`);
    }
    for (const artifact of component.artifacts) validateArtifact(artifact, where, problems);
  }

  for (const [key, value] of Object.entries(manifest.statistics)) {
    if (typeof value === "number" && (value < 0 || Number.isNaN(value))) {
      problems.push(`statistics.${key} is negative or NaN`);
    }
  }
  for (const [key, value] of Object.entries(manifest.statistics.goldLabelCounts)) {
    if (value < 0 || !Number.isInteger(value)) {
      problems.push(`statistics.goldLabelCounts.${key} must be a non-negative integer`);
    }
  }

  if (manifest.labels.SILVER.count > 0 && manifest.labels.SILVER.verificationNote.length === 0) {
    problems.push("SILVER labels claimed without a verificationNote — silver-washing forbidden");
  }
  if (
    manifest.labels.TIER_C.count > 0 &&
    !/never|candidate/i.test(manifest.labels.TIER_C.definition)
  ) {
    problems.push("TIER_C definition must state candidates are never labels");
  }

  if (!/analysis/i.test(manifest.consent.policy) || !/training/i.test(manifest.consent.policy)) {
    problems.push("consent.policy must address analysis vs training consent separately");
  }
  if (manifest.consent.trainingConsentRecords > manifest.consent.analysisConsentRecords) {
    problems.push("trainingConsentRecords cannot exceed analysisConsentRecords");
  }

  if (manifest.rights.policy.length === 0) problems.push("empty rights.policy");

  if (manifest.splits.policyVersion.length === 0) problems.push("empty splits.policyVersion");
  const splitBySession = new Map<string, string[]>();
  for (const [split, group] of Object.entries(manifest.splits.bySplit)) {
    for (const session of group.sessions) {
      splitBySession.set(session, [...(splitBySession.get(session) ?? []), split]);
    }
  }
  for (const [session, splits] of splitBySession) {
    if (splits.length > 1) {
      const recorded = manifest.splits.leakageFindings.some((finding) => finding.includes(session));
      if (!recorded) {
        problems.push(
          `session ${session} spans splits (${splits.join(", ")}) without a recorded leakage finding`,
        );
      }
    }
  }

  if (manifest.dedupLineage.report !== null) {
    validateArtifact(manifest.dedupLineage.report, "dedupLineage.report", problems);
  }
  if (manifest.knownLimitations.length === 0) {
    problems.push("knownLimitations is empty — every release has honest limitations");
  }
  return problems;
}

/** Throwing wrapper for construction-time use. */
export function assertValidDatasetReleaseManifest(manifest: DatasetReleaseManifest): void {
  const problems = validateDatasetReleaseManifest(manifest);
  if (problems.length > 0) {
    throw new Error(`invalid dataset release ${manifest.releaseId}:\n${problems.join("\n")}`);
  }
}

/**
 * Index of known dataset releases so model entries can be checked against
 * exact versions. Legacy releases (pickle-real-v0.x, paddle-distill-v0.x)
 * predate dataset-release-v1 and are registered by version string only.
 */
export class DatasetReleaseIndex {
  private readonly byVersionKey = new Map<string, DatasetReleaseManifest | "legacy">();

  public constructor(manifests: DatasetReleaseManifest[] = []) {
    for (const manifest of manifests) this.register(manifest);
  }

  public register(manifest: DatasetReleaseManifest): void {
    assertValidDatasetReleaseManifest(manifest);
    for (const key of [manifest.releaseId, manifest.version]) {
      if (this.byVersionKey.has(key)) throw new Error(`duplicate dataset release: ${key}`);
    }
    this.byVersionKey.set(manifest.releaseId, manifest);
    this.byVersionKey.set(manifest.version, manifest);
  }

  /** Pre-v1 releases that exist on disk but do not carry this schema. */
  public registerLegacy(version: string): void {
    if (this.byVersionKey.has(version)) throw new Error(`duplicate dataset release: ${version}`);
    this.byVersionKey.set(version, "legacy");
  }

  public has(version: string): boolean {
    return this.byVersionKey.has(version);
  }

  public byVersion(version: string): DatasetReleaseManifest | null {
    const found = this.byVersionKey.get(version);
    return found === undefined || found === "legacy" ? null : found;
  }

  public versions(): string[] {
    return [...this.byVersionKey.keys()];
  }
}

/**
 * Every model entry's dataset pointers must resolve to an exact registered
 * dataset version. Null pointers are honest (no trained model yet) and pass.
 */
export function auditModelDatasetLineage(
  manifest: ModelManifest,
  index: DatasetReleaseIndex,
): string[] {
  const problems: string[] = [];
  for (const entry of manifest.entries) {
    const key = `${entry.id}@${entry.version}`;
    for (const [field, pointer] of [
      ["trainingDatasetVersion", entry.trainingDatasetVersion],
      ["evaluationDatasetVersion", entry.evaluationDatasetVersion],
    ] as const) {
      if (pointer !== null && !index.has(pointer)) {
        problems.push(`${key}: ${field} "${pointer}" does not resolve to a known dataset release`);
      }
    }
  }
  return problems;
}
