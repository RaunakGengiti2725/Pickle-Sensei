import type { ShotTypeSlug } from "@pickle/shared-types";
import type { ExecutionTarget, ModelRuntime, ModelTask } from "@pickle/swing-domain";

/**
 * Model registry — the single place that knows which model implements which
 * task, at what version, in which deployment state, for which platforms.
 * Application code resolves through this registry; it never hardcodes a
 * model version or branches on `if model === …`.
 */

export const DEPLOYMENT_STATUSES = [
  "experimental",
  "shadow",
  "candidate",
  "production",
  "deprecated",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const PLATFORMS = ["ios", "android", "server"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Named dataset splits behind a trained artifact. Null until one exists. */
export interface DatasetSplits {
  train: string;
  validation: string;
  test: string;
}

export interface ModelManifestEntry {
  /** Stable provider id, e.g. "pose.apple-vision". */
  id: string;
  /**
   * Explicit, immutable version. Never an alias — "latest", "current",
   * "head" and the empty string are rejected at validation.
   */
  version: string;
  task: ModelTask;
  runtime: ModelRuntime;
  executionTarget: ExecutionTarget;
  deploymentStatus: DeploymentStatus;
  supportedPlatforms: Platform[];
  supportedStrokes: ShotTypeSlug[] | "all";
  inputSchemaVersion: number;
  outputSchemaVersion: number;
  /** SHA-256 of the model artifact; null for pure-code providers. */
  artifactHash: string | null;
  /** Where the artifact lives when downloadable; null when built in. */
  artifactUri: string | null;
  /** Dataset lineage — null until a trained model exists. */
  trainingDatasetVersion: string | null;
  evaluationDatasetVersion: string | null;
  /**
   * Source commit that produced a trained artifact. Null for in-repo code
   * providers, whose implementation lives at the monorepo HEAD by
   * definition and is versioned by its exported version constant.
   */
  commit: string | null;
  /** Split lineage — requires trainingDatasetVersion when present. */
  splits: DatasetSplits | null;
  /**
   * Frozen, accepted evaluation metrics for THIS id@version. Null until a
   * real evaluation on a named eval dataset has been accepted; requires
   * evaluationDatasetVersion when present. Never seeded from wishes.
   */
  metrics: Record<string, number> | null;
  /**
   * Capture-envelope version this entry is validated to operate inside,
   * e.g. "capture-envelope-thresholds-v0.4-provisional". Null when the
   * component does not consume capture-envelope-gated input.
   */
  supportedCaptureEnvelope: string | null;
  /** Confidence-calibration version. Null = honestly uncalibrated. */
  calibrationVersion: string | null;
  /** What the runtime needs to execute this entry (frameworks, interpreters). */
  runtimeRequirements: string[];
  /**
   * ISO date the entry entered production. Null when the promotion predates
   * this registry and was never recorded — never backfilled from guesses.
   */
  promotionDate: string | null;
  /**
   * "id@version" of the entry to roll back to, which must itself exist in
   * the manifest. Null when no registered predecessor exists.
   */
  rollbackPredecessor: string | null;
  license: string | null;
  notes: string;
}

export interface ModelManifest {
  schemaVersion: 1;
  entries: ModelManifestEntry[];
}

export interface ResolveQuery {
  task: ModelTask;
  platform: Platform;
  stroke?: ShotTypeSlug;
  /** Defaults to production. */
  status?: DeploymentStatus;
}

export class ModelRegistry {
  private readonly entries: ModelManifestEntry[];

  public constructor(manifest: ModelManifest) {
    validateManifest(manifest);
    this.entries = [...manifest.entries];
  }

  /** The active implementation for a task, or null — never a guess. */
  public resolve(query: ResolveQuery): ModelManifestEntry | null {
    const status = query.status ?? "production";
    const matches = this.entries
      .filter(
        (entry) =>
          entry.task === query.task &&
          entry.deploymentStatus === status &&
          entry.supportedPlatforms.includes(query.platform) &&
          (query.stroke === undefined ||
            entry.supportedStrokes === "all" ||
            entry.supportedStrokes.includes(query.stroke)),
      )
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return matches[0] ?? null;
  }

  /**
   * The shadow candidate for a task, when one is registered. Shadow models
   * run beside production on the same input without changing the user-facing
   * result; their outputs are recorded for offline comparison.
   */
  public shadowFor(query: Omit<ResolveQuery, "status">): ModelManifestEntry | null {
    return this.resolve({ ...query, status: "shadow" });
  }

  /**
   * Exact lookup. Version is REQUIRED: there is no anonymous "latest" —
   * callers that want the active model for a task use resolve(), which
   * still returns one concrete, fully-versioned entry.
   */
  public byId(id: string, version: string): ModelManifestEntry | null {
    return this.entries.find((entry) => entry.id === id && entry.version === version) ?? null;
  }

  /**
   * Append-only registration. An id@version, once registered, is immutable:
   * re-registering it — even with identical content — throws. Changing a
   * model means bumping its version, never overwriting an artifact in place.
   */
  public withEntry(entry: ModelManifestEntry): ModelRegistry {
    if (this.entries.some((e) => e.id === entry.id && e.version === entry.version)) {
      throw new Error(
        `Artifact ${entry.id}@${entry.version} is already registered and immutable — bump the version instead of overwriting.`,
      );
    }
    return new ModelRegistry({ schemaVersion: 1, entries: [...this.entries, entry] });
  }

  public list(task?: ModelTask): ModelManifestEntry[] {
    return task === undefined
      ? [...this.entries]
      : this.entries.filter((entry) => entry.task === task);
  }

  public static fromJson(json: string): ModelRegistry {
    const parsed = JSON.parse(json) as ModelManifest;
    return new ModelRegistry(parsed);
  }
}

function validateManifest(manifest: ModelManifest): void {
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported model manifest schema version: ${String(manifest.schemaVersion)}`);
  }
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    const key = `${entry.id}@${entry.version}`;
    if (seen.has(key)) throw new Error(`Duplicate model manifest entry: ${key}`);
    seen.add(key);
    if (FORBIDDEN_VERSION_ALIASES.has(entry.version.trim().toLowerCase())) {
      throw new Error(`Entry ${entry.id} uses a forbidden version alias: "${entry.version}".`);
    }
    if (!DEPLOYMENT_STATUSES.includes(entry.deploymentStatus)) {
      throw new Error(`Unknown deployment status for ${key}: ${entry.deploymentStatus}`);
    }
    if (entry.supportedPlatforms.length === 0) {
      throw new Error(`Entry ${key} supports no platforms.`);
    }
    // A production entry claiming a downloadable artifact must be verifiable.
    if (entry.artifactUri !== null && entry.artifactHash === null) {
      throw new Error(`Entry ${key} has an artifact URI but no artifact hash.`);
    }
    if (entry.splits !== null && entry.trainingDatasetVersion === null) {
      throw new Error(`Entry ${key} declares splits without a training dataset version.`);
    }
    if (entry.metrics !== null && entry.evaluationDatasetVersion === null) {
      throw new Error(`Entry ${key} declares metrics without an evaluation dataset version.`);
    }
  }
  for (const entry of manifest.entries) {
    if (entry.rollbackPredecessor !== null && !seen.has(entry.rollbackPredecessor)) {
      throw new Error(
        `Entry ${entry.id}@${entry.version} names rollback predecessor ${entry.rollbackPredecessor}, which is not registered.`,
      );
    }
    if (entry.rollbackPredecessor === `${entry.id}@${entry.version}`) {
      throw new Error(`Entry ${entry.id}@${entry.version} cannot be its own rollback predecessor.`);
    }
  }
}

const FORBIDDEN_VERSION_ALIASES = new Set(["", "latest", "current", "head", "newest"]);
