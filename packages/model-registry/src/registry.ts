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

/**
 * Thrown when a manifest fails validation. `problems` lists EVERY defect
 * found (not just the first) so a manifest edit can be fixed in one pass.
 */
export class ModelRegistryValidationError extends Error {
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(
      problems.length === 1
        ? `Invalid model manifest: ${problems[0]}`
        : `Invalid model manifest (${problems.length} problems):\n  - ${problems.join("\n  - ")}`,
    );
    this.name = "ModelRegistryValidationError";
    this.problems = Object.freeze([...problems]);
  }
}

/**
 * Thrown when more than one production entry answers a resolve() query.
 * Construction already forbids production entries with overlapping
 * coverage, so this is reachable only through a stroke-less query over
 * per-stroke production entries — a question with no single honest answer.
 */
export class AmbiguousModelResolutionError extends Error {
  public readonly candidates: readonly string[];

  public constructor(query: ResolveQuery, candidates: readonly ModelManifestEntry[]) {
    const keys = candidates.map(entryKey);
    super(
      `Ambiguous model resolution for task ${query.task} on ${query.platform}` +
        `${query.stroke === undefined ? "" : ` (stroke ${query.stroke})`}: ` +
        `${keys.join(", ")} all match. Query a specific stroke or fix the manifest.`,
    );
    this.name = "AmbiguousModelResolutionError";
    this.candidates = Object.freeze(keys);
  }
}

export class ModelRegistry {
  /** Validated, deep-frozen copies — never the caller's objects. */
  private readonly entries: readonly ModelManifestEntry[];

  public constructor(manifest: ModelManifest) {
    this.entries = validateManifest(manifest);
  }

  /**
   * The active implementation for a task, or null — never a guess. When the
   * query matches more than one production entry (possible only for a
   * stroke-less query over per-stroke production entries) this throws
   * rather than picking one by label order.
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
    if (status === "production") throw new AmbiguousModelResolutionError(query, matches);
    // Non-production statuses legitimately accumulate history (several
    // deprecated versions, several shadow candidates); report the newest by
    // version label, ties broken by id so the answer is deterministic.
    return [...matches].sort(compareNewestFirst)[0] ?? null;
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
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new ModelRegistryValidationError([
        `manifest text is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
    return new ModelRegistry(parsed as ModelManifest);
  }
}

function entryKey(entry: Pick<ModelManifestEntry, "id" | "version">): string {
  return `${entry.id}@${entry.version}`;
}

function compareNewestFirst(a: ModelManifestEntry, b: ModelManifestEntry): number {
  const byVersion = b.version.localeCompare(a.version, undefined, { numeric: true });
  return byVersion !== 0 ? byVersion : a.id.localeCompare(b.id);
}

// ---------------------------------------------------------------------------
// Validation. The manifest is treated as untrusted input (it may come from
// JSON): every field is checked for presence, type and domain, every problem
// is collected, and the registry keeps deep-frozen copies of the entries so
// neither the caller's manifest nor an entry handed out by list()/resolve()
// can change what resolve() answers later.
// ---------------------------------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;
const WHITESPACE = /\s/;
/**
 * Floating labels that would let "the same version" mean different
 * artifacts over time. Matched after trim + lower-case so near-spellings
 * ("Latest", " latest ") are caught as well.
 */
const FORBIDDEN_VERSION_ALIASES = new Set([
  "",
  "latest",
  "current",
  "head",
  "newest",
  "stable",
  "main",
  "master",
  "trunk",
  "tip",
  "default",
  "nightly",
  "dev",
  "snapshot",
]);

const ENTRY_KEYS: ReadonlySet<string> = new Set<keyof ModelManifestEntry>([
  "id",
  "version",
  "task",
  "runtime",
  "executionTarget",
  "deploymentStatus",
  "supportedPlatforms",
  "supportedStrokes",
  "inputSchemaVersion",
  "outputSchemaVersion",
  "artifactHash",
  "artifactUri",
  "trainingDatasetVersion",
  "evaluationDatasetVersion",
  "commit",
  "splits",
  "metrics",
  "supportedCaptureEnvelope",
  "calibrationVersion",
  "runtimeRequirements",
  "promotionDate",
  "rollbackPredecessor",
  "license",
  "notes",
]);

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return JSON.stringify(value);
  return typeof value;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

function validateManifest(input: unknown): readonly ModelManifestEntry[] {
  if (!isPlainObject(input)) {
    throw new ModelRegistryValidationError([
      `manifest must be an object with schemaVersion and entries (got ${describeValue(input)})`,
    ]);
  }
  const problems: string[] = [];
  if (input.schemaVersion !== 1) {
    problems.push(`Unsupported model manifest schema version: ${String(input.schemaVersion)}`);
  }
  for (const key of Object.keys(input)) {
    if (key !== "schemaVersion" && key !== "entries") {
      problems.push(`manifest has unknown key "${key}"`);
    }
  }
  if (!Array.isArray(input.entries)) {
    problems.push(
      `manifest entries must be an array of entries (got ${describeValue(input.entries)})`,
    );
    throw new ModelRegistryValidationError(problems);
  }

  const entries: ModelManifestEntry[] = [];
  input.entries.forEach((raw, index) => {
    const entry = validateEntry(raw, index, problems);
    if (entry !== null) entries.push(entry);
  });
  if (problems.length > 0) throw new ModelRegistryValidationError(problems);

  validateCrossEntryInvariants(entries, problems);
  if (problems.length > 0) throw new ModelRegistryValidationError(problems);

  return Object.freeze(entries.map(deepFreeze));
}

/**
 * Checks one raw entry field by field and returns a clean copy built only
 * from validated values, or null when anything was wrong (problems are
 * appended). Every check names the offending field so the message is
 * actionable for whoever edits the manifest.
 */
function validateEntry(raw: unknown, index: number, problems: string[]): ModelManifestEntry | null {
  const at = `entries[${index}]`;
  if (!isPlainObject(raw)) {
    problems.push(`${at} must be an entry object (got ${describeValue(raw)})`);
    return null;
  }
  const label =
    typeof raw.id === "string" && typeof raw.version === "string"
      ? `${at} (${raw.id}@${raw.version})`
      : at;
  const before = problems.length;
  const bad = (field: keyof ModelManifestEntry, expectation: string): void => {
    problems.push(`${label}: ${field} ${expectation} (got ${describeValue(raw[field])})`);
  };

  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) problems.push(`${label}: unknown field "${key}"`);
  }
  for (const key of ENTRY_KEYS) {
    if (!(key in raw)) problems.push(`${label}: ${key} is missing`);
  }

  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    bad("id", "must be a non-empty string");
  } else if (WHITESPACE.test(id)) {
    bad("id", "must not contain whitespace");
  } else if (id.includes("@")) {
    bad("id", 'must not contain "@" (reserved for id@version keys)');
  }

  const version = raw.version;
  if (typeof version !== "string") {
    bad("version", "must be a string");
  } else if (FORBIDDEN_VERSION_ALIASES.has(version.trim().toLowerCase())) {
    problems.push(
      `${label}: version uses a forbidden version alias: "${version}" — versions are explicit and immutable`,
    );
  } else if (WHITESPACE.test(version)) {
    bad("version", "must not contain whitespace");
  }

  if (!isOneOf(MODEL_TASKS, raw.task)) bad("task", `must be one of ${MODEL_TASKS.join("|")}`);
  if (!isOneOf(MODEL_RUNTIMES, raw.runtime)) {
    bad("runtime", `must be one of ${MODEL_RUNTIMES.join("|")}`);
  }
  if (!isOneOf(EXECUTION_TARGETS, raw.executionTarget)) {
    bad("executionTarget", `must be one of ${EXECUTION_TARGETS.join("|")}`);
  }
  if (!isOneOf(DEPLOYMENT_STATUSES, raw.deploymentStatus)) {
    bad("deploymentStatus", `must be one of ${DEPLOYMENT_STATUSES.join("|")}`);
  }

  const platforms = raw.supportedPlatforms;
  if (!Array.isArray(platforms) || platforms.length === 0) {
    bad("supportedPlatforms", `must be a non-empty array of ${PLATFORMS.join("|")}`);
  } else if (!platforms.every((p) => isOneOf(PLATFORMS, p))) {
    bad("supportedPlatforms", `may only contain ${PLATFORMS.join("|")}`);
  } else if (new Set(platforms).size !== platforms.length) {
    bad("supportedPlatforms", "must not repeat a platform");
  }

  const strokes = raw.supportedStrokes;
  if (strokes !== "all") {
    if (!Array.isArray(strokes) || strokes.length === 0) {
      bad("supportedStrokes", `must be "all" or a non-empty array of ${SHOT_TYPES.join("|")}`);
    } else if (!strokes.every((s) => isOneOf(SHOT_TYPES, s))) {
      bad("supportedStrokes", `may only contain ${SHOT_TYPES.join("|")}`);
    } else if (new Set(strokes).size !== strokes.length) {
      bad("supportedStrokes", "must not repeat a stroke");
    }
  }

  for (const field of ["inputSchemaVersion", "outputSchemaVersion"] as const) {
    const value = raw[field];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      bad(field, "must be a positive integer");
    }
  }

  const artifactHash = raw.artifactHash;
  if (
    artifactHash !== null &&
    (typeof artifactHash !== "string" || !SHA256_HEX.test(artifactHash))
  ) {
    bad("artifactHash", "must be null or a lowercase 64-hex sha256");
  }
  const artifactUri = raw.artifactUri;
  if (
    artifactUri !== null &&
    (typeof artifactUri !== "string" || artifactUri.trim().length === 0)
  ) {
    bad("artifactUri", "must be null or a non-empty string");
  } else if (artifactUri !== null && artifactHash === null) {
    // A downloadable artifact must be verifiable.
    problems.push(`${label}: has an artifact URI but no artifact hash (artifactHash is null)`);
  }

  for (const field of [
    "trainingDatasetVersion",
    "evaluationDatasetVersion",
    "commit",
    "supportedCaptureEnvelope",
    "calibrationVersion",
    "rollbackPredecessor",
    "license",
  ] as const) {
    const value = raw[field];
    if (value !== null && (typeof value !== "string" || value.trim().length === 0)) {
      bad(field, "must be null or a non-empty string");
    }
  }

  const promotionDate = raw.promotionDate;
  if (
    promotionDate !== null &&
    (typeof promotionDate !== "string" || Number.isNaN(Date.parse(promotionDate)))
  ) {
    bad("promotionDate", "must be null or an ISO-8601 date string");
  }

  const splits = raw.splits;
  if (splits !== null) {
    if (
      !isPlainObject(splits) ||
      Object.keys(splits).length !== 3 ||
      !["train", "validation", "test"].every(
        (k) => typeof splits[k] === "string" && (splits[k] as string).length > 0,
      )
    ) {
      bad("splits", "must be null or {train, validation, test} non-empty strings");
    } else if (raw.trainingDatasetVersion === null) {
      problems.push(`${label}: declares splits without a training dataset version`);
    }
  }

  const metrics = raw.metrics;
  if (metrics !== null) {
    if (
      !isPlainObject(metrics) ||
      !Object.values(metrics).every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      bad("metrics", "must be null or a record of finite numbers");
    } else if (raw.evaluationDatasetVersion === null) {
      problems.push(`${label}: declares metrics without an evaluation dataset version`);
    }
  }

  const requirements = raw.runtimeRequirements;
  if (!Array.isArray(requirements) || !requirements.every((r) => typeof r === "string")) {
    bad("runtimeRequirements", "must be an array of strings");
  }
  if (typeof raw.notes !== "string") bad("notes", "must be a string");

  if (problems.length > before) return null;

  // Every field was checked above; rebuild the entry from validated values
  // (fresh arrays/objects — nothing shared with the caller's manifest).
  const checked = raw as unknown as ModelManifestEntry;
  return {
    id: checked.id,
    version: checked.version,
    task: checked.task,
    runtime: checked.runtime,
    executionTarget: checked.executionTarget,
    deploymentStatus: checked.deploymentStatus,
    supportedPlatforms: [...checked.supportedPlatforms],
    supportedStrokes: checked.supportedStrokes === "all" ? "all" : [...checked.supportedStrokes],
    inputSchemaVersion: checked.inputSchemaVersion,
    outputSchemaVersion: checked.outputSchemaVersion,
    artifactHash: checked.artifactHash,
    artifactUri: checked.artifactUri,
    trainingDatasetVersion: checked.trainingDatasetVersion,
    evaluationDatasetVersion: checked.evaluationDatasetVersion,
    commit: checked.commit,
    splits: checked.splits === null ? null : { ...checked.splits },
    metrics: checked.metrics === null ? null : { ...checked.metrics },
    supportedCaptureEnvelope: checked.supportedCaptureEnvelope,
    calibrationVersion: checked.calibrationVersion,
    runtimeRequirements: [...checked.runtimeRequirements],
    promotionDate: checked.promotionDate,
    rollbackPredecessor: checked.rollbackPredecessor,
    license: checked.license,
    notes: checked.notes,
  };
}

function validateCrossEntryInvariants(entries: readonly ModelManifestEntry[], problems: string[]) {
  // Exact keys must be unique, and so must case-folded keys: two entries
  // that differ only by letter case are a typo, not two artifacts.
  const byKey = new Map<string, ModelManifestEntry>();
  const byFoldedKey = new Map<string, string>();
  for (const entry of entries) {
    const key = entryKey(entry);
    if (byKey.has(key)) {
      problems.push(`Duplicate model manifest entry: ${key}`);
      continue;
    }
    byKey.set(key, entry);
    const folded = key.toLowerCase();
    const clash = byFoldedKey.get(folded);
    if (clash !== undefined) {
      problems.push(`Entries ${clash} and ${key} differ only by letter case`);
    } else {
      byFoldedKey.set(folded, key);
    }
  }

  // Rollback edges: target registered, no self-loop, no cycle of any length.
  for (const entry of entries) {
    const predecessor = entry.rollbackPredecessor;
    if (predecessor === null) continue;
    const key = entryKey(entry);
    if (predecessor === key) {
      problems.push(`Entry ${key} cannot be its own rollback predecessor.`);
    } else if (!byKey.has(predecessor)) {
      problems.push(
        `Entry ${key} names rollback predecessor ${predecessor}, which is not registered.`,
      );
    }
  }
  const cycles = findRollbackCycles(byKey);
  for (const cycle of cycles) {
    problems.push(`rollbackPredecessor cycle: ${cycle.join(" -> ")}`);
  }

  // Production coverage must be unambiguous: for every (task, platform,
  // stroke) at most one production entry may apply, so resolve() never has
  // to rank two live implementations against each other.
  const production = entries.filter((entry) => entry.deploymentStatus === "production");
  for (let i = 0; i < production.length; i += 1) {
    for (let j = i + 1; j < production.length; j += 1) {
      const a = production[i]!;
      const b = production[j]!;
      if (a.task !== b.task) continue;
      const platforms = a.supportedPlatforms.filter((p) => b.supportedPlatforms.includes(p));
      if (platforms.length === 0) continue;
      const strokes = overlappingStrokes(a.supportedStrokes, b.supportedStrokes);
      if (strokes === null) continue;
      problems.push(
        `Ambiguous production entries for task ${a.task} on ${platforms.join("/")}` +
          ` (${strokes}): ${entryKey(a)} and ${entryKey(b)} are both production.` +
          " Keep one in production (deprecate, shadow or candidate the other) or split their strokes/platforms.",
      );
    }
  }
}

/** Human-readable overlap between two stroke coverages, or null when disjoint. */
function overlappingStrokes(
  a: ModelManifestEntry["supportedStrokes"],
  b: ModelManifestEntry["supportedStrokes"],
): string | null {
  if (a === "all") return b === "all" ? "all strokes" : `strokes ${b.join("/")}`;
  if (b === "all") return `strokes ${a.join("/")}`;
  const shared = a.filter((s) => b.includes(s));
  return shared.length === 0 ? null : `strokes ${shared.join("/")}`;
}

/**
 * Every distinct cycle in the rollbackPredecessor graph (each node has at
 * most one outgoing edge, so a walk from any node either ends, reaches an
 * already-finished node, or closes a cycle).
 */
function findRollbackCycles(byKey: ReadonlyMap<string, ModelManifestEntry>): string[][] {
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  for (const start of byKey.keys()) {
    if (state.has(start)) continue;
    const path: string[] = [];
    let current: string | null = start;
    while (current !== null && !state.has(current)) {
      state.set(current, "visiting");
      path.push(current);
      const next: string | null = byKey.get(current)?.rollbackPredecessor ?? null;
      current = next !== null && byKey.has(next) ? next : null;
    }
    if (current !== null && state.get(current) === "visiting") {
      const loop = path.slice(path.indexOf(current));
      cycles.push([...loop, current]);
    }
    for (const key of path) state.set(key, "done");
  }
  return cycles;
}

/** Freezes an entry and every array/object reachable from it. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as object)) deepFreeze(child);
  return Object.freeze(value);
}
