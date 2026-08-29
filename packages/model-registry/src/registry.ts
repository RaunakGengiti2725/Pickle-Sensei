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

export interface ModelManifestEntry {
  /** Stable provider id, e.g. "pose.apple-vision". */
  id: string;
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

  public byId(id: string, version?: string): ModelManifestEntry | null {
    const matches = this.entries
      .filter((entry) => entry.id === id && (version === undefined || entry.version === version))
      .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
    return matches[0] ?? null;
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
  }
}
