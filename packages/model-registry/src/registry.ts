import { SHOT_TYPES, type ShotTypeSlug } from "@pickle/shared-types";
import {
  EXECUTION_TARGETS,
  MODEL_RUNTIMES,
  MODEL_TASKS,
  type ExecutionTarget,
  type ModelRuntime,
  type ModelTask,
} from "@pickle/swing-domain";

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
  /**
   * Lower-case hex SHA-256 of the model artifact (64 chars); null for
   * pure-code providers. Required whenever `artifactUri` is set.
   */
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
   * the manifest. Null when no registered predecessor exists. Predecessor
   * chains must terminate: any cycle is rejected at validation.
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

/**
 * Registered entries are private copies of the manifest the registry was
 * built from and are deeply frozen: neither the caller's manifest objects
 * nor the entries handed out by `resolve` / `byId` / `list` can change
 * registry state.
 */
export class ModelRegistry {
  private readonly entries: readonly ModelManifestEntry[];

  public constructor(manifest: ModelManifest) {
    this.entries = validateManifest(manifest);
  }

  /**
   * The active implementation for a task, or null — never a guess.
   *
   * When several entries of the requested status match, promotion intent
   * decides: an entry named as another matching entry's rollbackPredecessor
   * is superseded and never returned. If more than one unsuperseded entry
   * remains, the manifest has not said which one is live. Entries whose
   * promotion was recorded (`promotionDate`) without lineage are a manifest
   * contradiction and resolution throws; unrecorded (legacy) entries are
   * ordered by their numeric version suffix only when every contender shares
   * one version scheme, otherwise the result is null.
   */
  public resolve(query: ResolveQuery): ModelManifestEntry | null {
    const status = query.status ?? "production";
    const matches = this.entries.filter(
      (entry) =>
        entry.task === query.task &&
        entry.deploymentStatus === status &&
        entry.supportedPlatforms.includes(query.platform) &&
        (query.stroke === undefined ||
          entry.supportedStrokes === "all" ||
          entry.supportedStrokes.includes(query.stroke)),
    );
    if (matches.length <= 1) return matches[0] ?? null;

    const superseded = new Set<string>();
    for (const entry of matches) {
      if (entry.rollbackPredecessor !== null) superseded.add(entry.rollbackPredecessor);
    }
    const contenders = matches.filter((entry) => !superseded.has(entryKey(entry)));
    if (contenders.length === 1) return contenders[0]!;

    const keys = contenders.map(entryKey).join(", ");
    if (contenders.some((entry) => entry.promotionDate !== null)) {
      throw new Error(
        `Ambiguous ${status} entries for ${query.task} on ${query.platform}: ${keys} — a recorded promotion must name the entry it superseded as its rollbackPredecessor, or the superseded entry must be deprecated.`,
      );
    }
    return highestWithinVersionScheme(contenders);
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
    const parsed: unknown = JSON.parse(json);
    return new ModelRegistry(parsed as ModelManifest);
  }
}

function entryKey(entry: Pick<ModelManifestEntry, "id" | "version">): string {
  return `${entry.id}@${entry.version}`;
}

/**
 * Free-form version strings are comparable only within one scheme: the same
 * stem followed by an integer ("v2"/"v10", "sm-v1"/"sm-v9"). Returns the
 * entry with the highest suffix, or null when the contenders do not share a
 * stem or two of them carry the same number.
 */
function highestWithinVersionScheme(
  contenders: readonly ModelManifestEntry[],
): ModelManifestEntry | null {
  let stem: string | null = null;
  let best: { entry: ModelManifestEntry; ordinal: number } | null = null;
  let tie = false;
  for (const entry of contenders) {
    const match = /^(.*?)(\d+)$/.exec(entry.version);
    if (match === null) return null;
    const entryStem = match[1]!;
    if (stem === null) stem = entryStem;
    else if (stem !== entryStem) return null;
    const ordinal = Number.parseInt(match[2]!, 10);
    if (best === null || ordinal > best.ordinal) {
      best = { entry, ordinal };
      tie = false;
    } else if (ordinal === best.ordinal) {
      tie = true;
    }
  }
  return tie || best === null ? null : best.entry;
}

const FORBIDDEN_VERSION_ALIASES = new Set(["", "latest", "current", "head", "newest"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function describe(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object" && value !== null) return "an object";
  return String(value);
}

/** Structural validation of one manifest entry; returns a private copy. */
function validateEntry(input: unknown, index: number): ModelManifestEntry {
  if (!isRecord(input)) {
    throw new Error(`Model manifest entry #${index} must be an object, got ${describe(input)}.`);
  }
  const where = `Model manifest entry #${index}`;
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new Error(`${where} must have a non-empty string id, got ${describe(input.id)}.`);
  }
  if (input.id !== input.id.trim()) {
    throw new Error(`${where} id ${describe(input.id)} has surrounding whitespace.`);
  }
  const id = input.id;
  if (typeof input.version !== "string") {
    throw new Error(`Entry ${id} must have a string version, got ${describe(input.version)}.`);
  }
  if (FORBIDDEN_VERSION_ALIASES.has(input.version.trim().toLowerCase())) {
    throw new Error(`Entry ${id} uses a forbidden version alias: "${input.version}".`);
  }
  if (input.version !== input.version.trim()) {
    throw new Error(`Entry ${id} version ${describe(input.version)} has surrounding whitespace.`);
  }
  const version = input.version;
  const key = `${id}@${version}`;

  const requireString = (field: string): string => {
    const value = input[field];
    if (typeof value !== "string") {
      throw new Error(`Entry ${key} field "${field}" must be a string, got ${describe(value)}.`);
    }
    return value;
  };
  const requireNullableString = (field: string): string | null => {
    const value = input[field];
    if (value !== null && typeof value !== "string") {
      throw new Error(
        `Entry ${key} field "${field}" must be a string or null, got ${describe(value)}.`,
      );
    }
    return value;
  };
  const requireSchemaVersion = (field: string): number => {
    const value = input[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      throw new Error(
        `Entry ${key} field "${field}" must be a positive integer, got ${describe(value)}.`,
      );
    }
    return value;
  };
  const requireStringArray = (field: string): string[] => {
    const value = input[field];
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
      throw new Error(
        `Entry ${key} field "${field}" must be an array of strings, got ${describe(value)}.`,
      );
    }
    return [...(value as string[])];
  };

  if (!isOneOf(MODEL_TASKS, input.task)) {
    throw new Error(`Unknown model task for ${key}: ${describe(input.task)}`);
  }
  if (!isOneOf(MODEL_RUNTIMES, input.runtime)) {
    throw new Error(`Unknown model runtime for ${key}: ${describe(input.runtime)}`);
  }
  if (!isOneOf(EXECUTION_TARGETS, input.executionTarget)) {
    throw new Error(`Unknown execution target for ${key}: ${describe(input.executionTarget)}`);
  }
  if (!isOneOf(DEPLOYMENT_STATUSES, input.deploymentStatus)) {
    throw new Error(`Unknown deployment status for ${key}: ${describe(input.deploymentStatus)}`);
  }

  const platforms = input.supportedPlatforms;
  if (!Array.isArray(platforms)) {
    throw new Error(
      `Entry ${key} field "supportedPlatforms" must be an array, got ${describe(platforms)}.`,
    );
  }
  if (platforms.length === 0) {
    throw new Error(`Entry ${key} supports no platforms.`);
  }
  const supportedPlatforms: Platform[] = [];
  for (const platform of platforms) {
    if (!isOneOf(PLATFORMS, platform)) {
      throw new Error(`Unknown platform for ${key}: ${describe(platform)}`);
    }
    supportedPlatforms.push(platform);
  }

  let supportedStrokes: ShotTypeSlug[] | "all";
  if (input.supportedStrokes === "all") {
    supportedStrokes = "all";
  } else if (Array.isArray(input.supportedStrokes)) {
    if (input.supportedStrokes.length === 0) {
      throw new Error(`Entry ${key} supports no strokes.`);
    }
    supportedStrokes = [];
    for (const stroke of input.supportedStrokes) {
      if (!isOneOf(SHOT_TYPES, stroke)) {
        throw new Error(`Unknown stroke for ${key}: ${describe(stroke)}`);
      }
      supportedStrokes.push(stroke);
    }
  } else {
    throw new Error(
      `Entry ${key} field "supportedStrokes" must be "all" or an array of strokes, got ${describe(input.supportedStrokes)}.`,
    );
  }

  const inputSchemaVersion = requireSchemaVersion("inputSchemaVersion");
  const outputSchemaVersion = requireSchemaVersion("outputSchemaVersion");
  const artifactHash = requireNullableString("artifactHash");
  const artifactUri = requireNullableString("artifactUri");
  // A production entry claiming a downloadable artifact must be verifiable.
  if (artifactUri !== null && artifactHash === null) {
    throw new Error(`Entry ${key} has an artifact URI but no artifact hash.`);
  }
  if (artifactHash !== null && !SHA256_HEX.test(artifactHash)) {
    throw new Error(
      `Entry ${key} artifact hash must be a lower-case 64-hex SHA-256, got ${describe(artifactHash)}.`,
    );
  }
  if (artifactUri !== null && artifactUri.trim().length === 0) {
    throw new Error(`Entry ${key} has an empty artifact URI.`);
  }
  const trainingDatasetVersion = requireNullableString("trainingDatasetVersion");
  const evaluationDatasetVersion = requireNullableString("evaluationDatasetVersion");
  const commit = requireNullableString("commit");

  let splits: DatasetSplits | null = null;
  if (input.splits !== null) {
    if (!isRecord(input.splits)) {
      throw new Error(
        `Entry ${key} field "splits" must be an object or null, got ${describe(input.splits)}.`,
      );
    }
    const { train, validation, test } = input.splits;
    if (typeof train !== "string" || typeof validation !== "string" || typeof test !== "string") {
      throw new Error(`Entry ${key} splits must name train, validation and test as strings.`);
    }
    splits = { train, validation, test };
  }
  if (splits !== null && trainingDatasetVersion === null) {
    throw new Error(`Entry ${key} declares splits without a training dataset version.`);
  }

  let metrics: Record<string, number> | null = null;
  if (input.metrics !== null) {
    if (!isRecord(input.metrics)) {
      throw new Error(
        `Entry ${key} field "metrics" must be an object or null, got ${describe(input.metrics)}.`,
      );
    }
    metrics = {};
    for (const [name, value] of Object.entries(input.metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Entry ${key} metric "${name}" must be a finite number.`);
      }
      metrics[name] = value;
    }
  }
  if (metrics !== null && evaluationDatasetVersion === null) {
    throw new Error(`Entry ${key} declares metrics without an evaluation dataset version.`);
  }

  const supportedCaptureEnvelope = requireNullableString("supportedCaptureEnvelope");
  const calibrationVersion = requireNullableString("calibrationVersion");
  const runtimeRequirements = requireStringArray("runtimeRequirements");
  const promotionDate = requireNullableString("promotionDate");
  if (promotionDate !== null && Number.isNaN(Date.parse(promotionDate))) {
    throw new Error(`Entry ${key} promotion date ${describe(promotionDate)} is not an ISO date.`);
  }
  const rollbackPredecessor = requireNullableString("rollbackPredecessor");
  const license = requireNullableString("license");
  const notes = requireString("notes");

  return deepFreezeEntry({
    id,
    version,
    task: input.task,
    runtime: input.runtime,
    executionTarget: input.executionTarget,
    deploymentStatus: input.deploymentStatus,
    supportedPlatforms,
    supportedStrokes,
    inputSchemaVersion,
    outputSchemaVersion,
    artifactHash,
    artifactUri,
    trainingDatasetVersion,
    evaluationDatasetVersion,
    commit,
    splits,
    metrics,
    supportedCaptureEnvelope,
    calibrationVersion,
    runtimeRequirements,
    promotionDate,
    rollbackPredecessor,
    license,
    notes,
  });
}

function deepFreezeEntry(entry: ModelManifestEntry): ModelManifestEntry {
  Object.freeze(entry.supportedPlatforms);
  if (entry.supportedStrokes !== "all") Object.freeze(entry.supportedStrokes);
  Object.freeze(entry.runtimeRequirements);
  if (entry.splits !== null) Object.freeze(entry.splits);
  if (entry.metrics !== null) Object.freeze(entry.metrics);
  return Object.freeze(entry);
}

/**
 * Validates a manifest of unknown shape (typed callers and `fromJson` alike)
 * and returns private, deeply frozen copies of its entries. Every rejection
 * is a deliberate validation Error naming the offending entry and field.
 */
function validateManifest(input: unknown): readonly ModelManifestEntry[] {
  if (!isRecord(input)) {
    throw new Error(`Model manifest must be an object, got ${describe(input)}.`);
  }
  if (input.schemaVersion !== 1) {
    throw new Error(`Unsupported model manifest schema version: ${String(input.schemaVersion)}`);
  }
  if (!Array.isArray(input.entries)) {
    throw new Error(`Model manifest "entries" must be an array, got ${describe(input.entries)}.`);
  }

  const entries: ModelManifestEntry[] = [];
  const byKey = new Map<string, ModelManifestEntry>();
  for (const [index, raw] of (input.entries as unknown[]).entries()) {
    const entry = validateEntry(raw, index);
    const key = entryKey(entry);
    if (byKey.has(key)) throw new Error(`Duplicate model manifest entry: ${key}`);
    byKey.set(key, entry);
    entries.push(entry);
  }

  for (const entry of entries) {
    if (entry.rollbackPredecessor === null) continue;
    if (!byKey.has(entry.rollbackPredecessor)) {
      throw new Error(
        `Entry ${entryKey(entry)} names rollback predecessor ${entry.rollbackPredecessor}, which is not registered.`,
      );
    }
    if (entry.rollbackPredecessor === entryKey(entry)) {
      throw new Error(`Entry ${entryKey(entry)} cannot be its own rollback predecessor.`);
    }
  }
  rejectRollbackCycles(byKey);

  return Object.freeze(entries);
}

/**
 * A rollback chain is walked backwards until it terminates at an entry with
 * no predecessor; a cycle would make that walk endless. Depth-first colouring
 * over the predecessor edges finds any cycle, however long.
 */
function rejectRollbackCycles(byKey: ReadonlyMap<string, ModelManifestEntry>): void {
  const state = new Map<string, "visiting" | "done">();
  for (const start of byKey.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && !state.has(current)) {
      state.set(current, "visiting");
      path.push(current);
      current = byKey.get(current)!.rollbackPredecessor;
    }
    if (current !== null && state.get(current) === "visiting") {
      const cycle = [...path.slice(path.indexOf(current)), current];
      throw new Error(`Rollback predecessor chain forms a cycle: ${cycle.join(" → ")}`);
    }
    for (const key of path) state.set(key, "done");
  }
}
