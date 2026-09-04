import datasetV1Json from "../../../../datasets/releases/pickle-sensei-datasets-v1/manifest.json" with { type: "json" };
import datasetV2Json from "../../../../datasets/releases/pickle-sensei-datasets-v2/manifest.json" with { type: "json" };
import {
  DEFAULT_MODEL_MANIFEST,
  DatasetReleaseIndex,
  ModelRegistry,
  SubsystemReleaseState,
  assertValidDatasetReleaseManifest,
  auditModelDatasetLineage,
  validateDatasetReleaseManifest,
  type DatasetReleaseManifest,
  type ModelManifest,
  type ModelManifestEntry,
  type ResolveQuery,
  type VersionedArtifact,
} from "../../src/index.js";
import {
  clone,
  deepEqual,
  describeMutations,
  mutateJsonText,
  mutateObject,
  type Mutation,
} from "./mutate.js";
import { describeValue, pickPoison } from "./poison.js";
import { Prng, iterationSeed } from "./prng.js";
import { datasetReleaseViolations, modelManifestViolations } from "./schema.js";

/**
 * Boundary / malformed-input stress campaign for @pickle/model-registry.
 *
 * Every iteration is a pure function of (campaignSeed, index): the same pair
 * always produces the same payload, the same surface and the same outcome.
 * Surfaces are the package's deserialization and mutation boundaries —
 * everything that could receive a manifest or query from disk, a remote
 * manifest, or an untyped caller.
 *
 * Outcomes (the oracle):
 *  - rejected_validation  the surface refused the payload with a plain
 *                         `Error` carrying a message (the typed rejection the
 *                         package documents), or returned problems.
 *  - rejected_parse       fromJson / JSON.parse raised SyntaxError.
 *  - accepted_valid       payload accepted AND conforms to the TS interface.
 *  - accepted_malformed   payload accepted although it violates the TS
 *                         interface (wrong types, NaN, unknown enum, …).
 *  - untyped_throw        a non-Error-class exception (TypeError, RangeError)
 *                         escaped a surface that is allowed to throw.
 *  - unexpected_throw     ANY exception escaped a surface documented as
 *                         non-throwing.
 *  - state_write          a rejected payload still mutated the store.
 *  - pollution            Object.prototype gained a property.
 *  - noop                 mutation produced an input identical to the fixture
 *                         (counted, but carries no signal).
 */
export type Outcome =
  | "rejected_validation"
  | "rejected_parse"
  | "accepted_valid"
  | "accepted_malformed"
  | "untyped_throw"
  | "unexpected_throw"
  | "state_write"
  | "pollution"
  | "noop";

export const HELD_OUTCOMES: ReadonlySet<Outcome> = new Set<Outcome>([
  "rejected_validation",
  "rejected_parse",
  "accepted_valid",
  "noop",
]);

export type Surface =
  | "registry_object"
  | "registry_json"
  | "registry_query"
  | "registry_with_entry"
  | "dataset_validate"
  | "dataset_json"
  | "dataset_index"
  | "lineage_audit"
  | "rollback_activate";

export const SURFACES: readonly Surface[] = [
  "registry_object",
  "registry_json",
  "registry_query",
  "registry_with_entry",
  "dataset_validate",
  "dataset_json",
  "dataset_index",
  "lineage_audit",
  "rollback_activate",
];

export interface IterationRecord {
  index: number;
  seed: number;
  /** Mutation-prefix limit used to generate this record; null = unlimited (the campaign run). */
  applyLimit: number | null;
  surface: Surface;
  mutations: Mutation[];
  mutationSummary: string;
  outcome: Outcome;
  held: boolean;
  /** Error class name or first violation — bounded to keep the table small. */
  detail: string;
  durationMs: number;
}

export interface IterationInput {
  surface: Surface;
  mutations: Mutation[];
  payload: unknown;
}

/** Committed dataset release fixtures (datasets/releases/*, never edited; read-only inputs). */
const DATASET_V1 = datasetV1Json as unknown as DatasetReleaseManifest;
const DATASET_V2 = datasetV2Json as unknown as DatasetReleaseManifest;

/** One fully-populated lineage entry so every optional field is present and mutable. */
export function lineageEntryFixture(): ModelManifestEntry {
  const predecessor = DEFAULT_MODEL_MANIFEST.entries[0];
  return {
    id: "scorer.stress-fixture",
    version: "stress-fixture-2",
    task: "technique_scoring",
    runtime: "coreml",
    executionTarget: "on_device",
    deploymentStatus: "shadow",
    supportedPlatforms: ["ios"],
    supportedStrokes: ["forehand_drive", "dink"],
    inputSchemaVersion: 1,
    outputSchemaVersion: 2,
    artifactHash: "b".repeat(64),
    artifactUri: "https://example.invalid/models/scorer-stress-fixture-2.mlmodelc",
    trainingDatasetVersion: DATASET_V2.version,
    evaluationDatasetVersion: DATASET_V1.version,
    commit: "1fb0efd7f3157060af4c61342f5102e068d2ddc5",
    splits: { train: "train", validation: "validation", test: "test" },
    metrics: { mae: 0.5, coverage: 0.9 },
    supportedCaptureEnvelope: "capture-envelope-thresholds-v0.4-provisional",
    calibrationVersion: "cal-1",
    runtimeRequirements: ["ios-coreml"],
    promotionDate: null,
    rollbackPredecessor: predecessor ? `${predecessor.id}@${predecessor.version}` : null,
    license: "proprietary",
    notes: "Stress fixture — exercises every optional lineage field.",
  };
}

/** The committed default manifest plus the lineage entry. */
export function modelFixture(): ModelManifest {
  const base = clone(DEFAULT_MODEL_MANIFEST);
  return { schemaVersion: 1, entries: [...base.entries, lineageEntryFixture()] };
}

export function datasetFixture(): DatasetReleaseManifest {
  return clone(DATASET_V2);
}

const MODEL_FIXTURE_JSON = JSON.stringify(modelFixture());
const DATASET_FIXTURE_JSON = JSON.stringify(DATASET_V2);

/** Sanity: the unmutated fixtures must be accepted, or every result is noise. */
export function fixturesAreValid(): string[] {
  const problems: string[] = [];
  try {
    new ModelRegistry(modelFixture());
  } catch (error) {
    problems.push(`model fixture rejected: ${String(error)}`);
  }
  problems.push(...modelManifestViolations(modelFixture()).map((v) => `model fixture: ${v}`));
  for (const [name, fixture] of [
    ["v1", DATASET_V1],
    ["v2", DATASET_V2],
  ] as const) {
    problems.push(...validateDatasetReleaseManifest(fixture).map((p) => `dataset ${name}: ${p}`));
    problems.push(...datasetReleaseViolations(fixture).map((v) => `dataset ${name}: ${v}`));
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Payload generation
// ---------------------------------------------------------------------------

export function generate(rng: Prng, applyLimit = Number.POSITIVE_INFINITY): IterationInput {
  const surface = rng.pick(SURFACES);
  switch (surface) {
    case "registry_object":
    case "lineage_audit": {
      const m = mutateObject(modelFixture(), rng, 3, applyLimit);
      return { surface, mutations: m.mutations, payload: m.value };
    }
    case "registry_json": {
      const m = mutateJsonText(MODEL_FIXTURE_JSON, rng, 2, applyLimit);
      return { surface, mutations: m.mutations, payload: m.value };
    }
    case "registry_query": {
      const base: ResolveQuery = { task: "technique_scoring", platform: "ios", stroke: "dink" };
      const m = mutateObject(base, rng, 2, applyLimit);
      const idPoison = pickPoison(rng);
      const versionPoison = pickPoison(rng);
      m.mutations.push(
        { kind: "byId-id", at: "id", detail: idPoison.tag },
        { kind: "byId-version", at: "version", detail: versionPoison.tag },
      );
      return {
        surface,
        mutations: m.mutations,
        payload: { query: m.value, id: idPoison.value, version: versionPoison.value },
      };
    }
    case "registry_with_entry": {
      const m = mutateObject(lineageEntryFixture(), rng, 3, applyLimit);
      return { surface, mutations: m.mutations, payload: m.value };
    }
    case "dataset_validate":
    case "dataset_index": {
      const m = mutateObject(datasetFixture(), rng, 3, applyLimit);
      return { surface, mutations: m.mutations, payload: m.value };
    }
    case "dataset_json": {
      const m = mutateJsonText(DATASET_FIXTURE_JSON, rng, 2, applyLimit);
      return { surface, mutations: m.mutations, payload: m.value };
    }
    case "rollback_activate": {
      const versionPoison = pickPoison(rng);
      const artifactPoison = pickPoison(rng);
      return {
        surface,
        mutations: [
          { kind: "candidate-version", at: "version", detail: versionPoison.tag },
          { kind: "candidate-artifact", at: "artifact", detail: artifactPoison.tag },
        ],
        payload: { version: versionPoison.value, artifact: artifactPoison.value },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Execution + oracle
// ---------------------------------------------------------------------------

interface Verdict {
  outcome: Outcome;
  detail: string;
}

const MAX_DETAIL = 240;

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ");
  return flat.length > MAX_DETAIL ? `${flat.slice(0, MAX_DETAIL)}…(len=${flat.length})` : flat;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return shorten(`${error.constructor.name}: ${error.message}`);
  return shorten(`non-Error thrown: ${describeValue(error)}`);
}

/** Plain `Error` (not a subclass) with a message = the package's typed rejection. */
function isTypedRejection(error: unknown): boolean {
  return (
    error instanceof Error &&
    Object.getPrototypeOf(error) === Error.prototype &&
    error.message.length > 0
  );
}

function classifyThrow(error: unknown, parses = false): Verdict {
  const detail = describeError(error);
  if (parses && error instanceof SyntaxError) return { outcome: "rejected_parse", detail };
  if (isTypedRejection(error)) return { outcome: "rejected_validation", detail };
  return { outcome: "untyped_throw", detail };
}

function registryVerdict(registry: ModelRegistry, source: unknown): Verdict {
  const violations = modelManifestViolations(source);
  if (violations.length > 0) {
    return { outcome: "accepted_malformed", detail: shorten(violations.join("; ")) };
  }
  // Exercise the accepted registry: every read path must stay total.
  for (const entry of registry.list()) {
    registry.byId(entry.id, entry.version);
    registry.resolve({ task: entry.task, platform: entry.supportedPlatforms[0] ?? "ios" });
  }
  return { outcome: "accepted_valid", detail: "" };
}

function runRegistryObject(payload: unknown, fixture: unknown): Verdict {
  if (deepEqual(payload, fixture)) return { outcome: "noop", detail: "" };
  let registry: ModelRegistry;
  try {
    registry = new ModelRegistry(payload as ModelManifest);
  } catch (error) {
    return classifyThrow(error);
  }
  return registryVerdict(registry, payload);
}

function runRegistryJson(text: string): Verdict {
  if (text === MODEL_FIXTURE_JSON) return { outcome: "noop", detail: "" };
  let registry: ModelRegistry;
  try {
    registry = ModelRegistry.fromJson(text);
  } catch (error) {
    return classifyThrow(error, true);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { outcome: "accepted_malformed", detail: "fromJson accepted text JSON.parse rejects" };
  }
  return registryVerdict(registry, parsed);
}

function runRegistryQuery(payload: { query: unknown; id: unknown; version: unknown }): Verdict {
  const registry = new ModelRegistry(modelFixture());
  const before = JSON.stringify(registry.list());
  try {
    const resolved = registry.resolve(payload.query as ResolveQuery);
    const shadow = registry.shadowFor(payload.query as ResolveQuery);
    const byId = registry.byId(payload.id as string, payload.version as string);
    const listed = registry.list((payload.query as ResolveQuery).task);
    for (const value of [resolved, shadow, byId]) {
      if (
        value !== null &&
        modelManifestViolations({ schemaVersion: 1, entries: [value] }).length > 0
      ) {
        return { outcome: "accepted_malformed", detail: "query returned a malformed entry" };
      }
    }
    if (!Array.isArray(listed))
      return { outcome: "accepted_malformed", detail: "list() not array" };
  } catch (error) {
    return { outcome: "unexpected_throw", detail: describeError(error) };
  }
  if (JSON.stringify(registry.list()) !== before) {
    return { outcome: "state_write", detail: "read query changed registry contents" };
  }
  return { outcome: "accepted_valid", detail: "" };
}

function runRegistryWithEntry(payload: unknown): Verdict {
  const registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
  const before = JSON.stringify(registry.list());
  let next: ModelRegistry;
  try {
    next = registry.withEntry(payload as ModelManifestEntry);
  } catch (error) {
    const verdict = classifyThrow(error);
    if (JSON.stringify(registry.list()) !== before) {
      return {
        outcome: "state_write",
        detail: `rejected withEntry mutated parent: ${verdict.detail}`,
      };
    }
    return verdict;
  }
  if (JSON.stringify(registry.list()) !== before) {
    return { outcome: "state_write", detail: "withEntry mutated the parent registry" };
  }
  return registryVerdict(next, { schemaVersion: 1, entries: next.list() });
}

function runDatasetValidate(payload: unknown, fixture: unknown): Verdict {
  if (deepEqual(payload, fixture)) return { outcome: "noop", detail: "" };
  let problems: string[];
  try {
    problems = validateDatasetReleaseManifest(payload as DatasetReleaseManifest);
  } catch (error) {
    return { outcome: "unexpected_throw", detail: describeError(error) };
  }
  if (!Array.isArray(problems) || !problems.every((p) => typeof p === "string")) {
    return { outcome: "accepted_malformed", detail: "validator returned non-string[] problems" };
  }
  if (problems.length > 0) {
    return { outcome: "rejected_validation", detail: shorten(problems.join("; ")) };
  }
  const violations = datasetReleaseViolations(payload);
  if (violations.length > 0) {
    return { outcome: "accepted_malformed", detail: shorten(violations.join("; ")) };
  }
  return { outcome: "accepted_valid", detail: "" };
}

function runDatasetJson(text: string): Verdict {
  if (text === DATASET_FIXTURE_JSON) return { outcome: "noop", detail: "" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return classifyThrow(error, true);
  }
  return runDatasetValidate(parsed, null);
}

function runDatasetIndex(payload: unknown, fixture: unknown): Verdict {
  if (deepEqual(payload, fixture)) return { outcome: "noop", detail: "" };
  const index = new DatasetReleaseIndex([clone(DATASET_V1)]);
  const before = index.versions().join("\u0000");
  try {
    index.register(payload as DatasetReleaseManifest);
  } catch (error) {
    const verdict = classifyThrow(error);
    if (index.versions().join("\u0000") !== before) {
      return { outcome: "state_write", detail: `rejected register wrote: ${verdict.detail}` };
    }
    return verdict;
  }
  try {
    assertValidDatasetReleaseManifest(payload as DatasetReleaseManifest);
  } catch (error) {
    return {
      outcome: "state_write",
      detail: `register accepted what assert rejects: ${describeError(error)}`,
    };
  }
  const violations = datasetReleaseViolations(payload);
  if (violations.length > 0) {
    return { outcome: "accepted_malformed", detail: shorten(violations.join("; ")) };
  }
  const p = payload as DatasetReleaseManifest;
  if (!index.has(p.releaseId) || !index.has(p.version) || index.byVersion(p.version) !== payload) {
    return { outcome: "accepted_malformed", detail: "registered release not retrievable" };
  }
  return { outcome: "accepted_valid", detail: "" };
}

function runLineageAudit(payload: unknown, fixture: unknown): Verdict {
  if (deepEqual(payload, fixture)) return { outcome: "noop", detail: "" };
  const index = new DatasetReleaseIndex([clone(DATASET_V1), clone(DATASET_V2)]);
  const before = index.versions().join("\u0000");
  let problems: string[];
  try {
    problems = auditModelDatasetLineage(payload as ModelManifest, index);
  } catch (error) {
    return { outcome: "unexpected_throw", detail: describeError(error) };
  }
  if (index.versions().join("\u0000") !== before) {
    return { outcome: "state_write", detail: "audit mutated the dataset index" };
  }
  if (!Array.isArray(problems) || !problems.every((p) => typeof p === "string")) {
    return { outcome: "accepted_malformed", detail: "audit returned non-string[] problems" };
  }
  return problems.length > 0
    ? { outcome: "rejected_validation", detail: shorten(problems.join("; ")) }
    : { outcome: "accepted_valid", detail: "" };
}

interface StressArtifact {
  ok: true;
}

function isStressArtifact(value: unknown): value is StressArtifact {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === true;
}

/**
 * A subsystem whose `apply` refuses malformed artifacts by throwing — the
 * store must then stay on the previous version with an unchanged journal.
 */
function runRollbackActivate(payload: { version: unknown; artifact: unknown }): Verdict {
  let live: StressArtifact | null = null;
  const initial: VersionedArtifact<StressArtifact> = {
    version: "known-good-1",
    artifact: { ok: true },
  };
  const state = new SubsystemReleaseState<StressArtifact>({
    subsystem: "stress",
    initial,
    apply: (artifact) => {
      if (artifact !== null && !isStressArtifact(artifact)) {
        throw new Error("stress: refusing malformed artifact");
      }
      live = artifact;
    },
    clock: () => 0,
  });
  state.recordKnownGood();
  const journalBefore = state.journal().length;
  const candidate = payload as VersionedArtifact<StressArtifact>;
  try {
    state.activate(candidate);
  } catch (error) {
    const activeVersion = state.active()?.version;
    if (activeVersion !== initial.version || state.journal().length !== journalBefore) {
      return {
        outcome: "state_write",
        detail: shorten(
          `apply() rejected candidate but active=${describeValue(activeVersion)} journal=${state.journal().length} (was ${journalBefore}); live still known-good=${String(live === initial.artifact)}`,
        ),
      };
    }
    return classifyThrow(error);
  }
  const active = state.active();
  if (active === null || !Object.is(active.artifact, live)) {
    return { outcome: "state_write", detail: "active artifact differs from applied artifact" };
  }
  if (typeof payload.version !== "string") {
    return {
      outcome: "accepted_malformed",
      detail: `non-string version ${describeValue(payload.version)} journaled`,
    };
  }
  for (const entry of state.journal()) {
    if (!Number.isFinite(entry.durationMs) || !Number.isFinite(entry.atEpochMs)) {
      return { outcome: "accepted_malformed", detail: "non-finite duration in journal" };
    }
  }
  return { outcome: "accepted_valid", detail: "" };
}

function prototypeIsPolluted(): string | null {
  const probe: Record<string, unknown> = {};
  if ("polluted" in probe) return "Object.prototype.polluted is set";
  if ("polluted" in []) return "Array.prototype.polluted is set";
  if (Object.keys(Object.prototype).length > 0) {
    return `Object.prototype has enumerable keys: ${Object.keys(Object.prototype).join(",")}`;
  }
  return null;
}

export function execute(input: IterationInput): Verdict {
  const modelBase = modelFixture();
  const datasetBase = datasetFixture();
  let verdict: Verdict;
  switch (input.surface) {
    case "registry_object":
      verdict = runRegistryObject(input.payload, modelBase);
      break;
    case "registry_json":
      verdict = runRegistryJson(input.payload as string);
      break;
    case "registry_query":
      verdict = runRegistryQuery(
        input.payload as { query: unknown; id: unknown; version: unknown },
      );
      break;
    case "registry_with_entry":
      verdict = runRegistryWithEntry(input.payload);
      break;
    case "dataset_validate":
      verdict = runDatasetValidate(input.payload, datasetBase);
      break;
    case "dataset_json":
      verdict = runDatasetJson(input.payload as string);
      break;
    case "dataset_index":
      verdict = runDatasetIndex(input.payload, datasetBase);
      break;
    case "lineage_audit":
      verdict = runLineageAudit(input.payload, modelBase);
      break;
    case "rollback_activate":
      verdict = runRollbackActivate(input.payload as { version: unknown; artifact: unknown });
      break;
  }
  const polluted = prototypeIsPolluted();
  if (polluted !== null) return { outcome: "pollution", detail: polluted };
  return verdict;
}

// ---------------------------------------------------------------------------
// Campaign driver
// ---------------------------------------------------------------------------

export function runIteration(
  campaignSeed: number,
  index: number,
  applyLimit = Number.POSITIVE_INFINITY,
): IterationRecord {
  const seed = iterationSeed(campaignSeed, index);
  const rng = new Prng(seed);
  const input = generate(rng, applyLimit);
  const started = Date.now();
  const verdict = execute(input);
  const durationMs = Date.now() - started;
  return {
    index,
    seed,
    applyLimit: Number.isFinite(applyLimit) ? applyLimit : null,
    surface: input.surface,
    mutations: input.mutations,
    mutationSummary: describeMutations(input.mutations),
    outcome: verdict.outcome,
    held: HELD_OUTCOMES.has(verdict.outcome),
    detail: verdict.detail,
    durationMs,
  };
}

export interface CampaignSummary {
  campaignSeed: number;
  iterations: number;
  executed: number;
  bySurface: Record<string, number>;
  byOutcome: Record<string, number>;
  byMutationKind: Record<string, number>;
  failing: IterationRecord[];
}

export function runCampaign(
  campaignSeed: number,
  iterations: number,
): {
  records: IterationRecord[];
  summary: CampaignSummary;
} {
  const records: IterationRecord[] = [];
  const bySurface: Record<string, number> = {};
  const byOutcome: Record<string, number> = {};
  const byMutationKind: Record<string, number> = {};
  for (let i = 0; i < iterations; i += 1) {
    const record = runIteration(campaignSeed, i);
    records.push(record);
    bySurface[record.surface] = (bySurface[record.surface] ?? 0) + 1;
    byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1;
    for (const m of record.mutations) byMutationKind[m.kind] = (byMutationKind[m.kind] ?? 0) + 1;
  }
  return {
    records,
    summary: {
      campaignSeed,
      iterations,
      executed: records.length,
      bySurface,
      byOutcome,
      byMutationKind,
      failing: records.filter((r) => !r.held),
    },
  };
}

/**
 * Smallest mutation prefix of a failing iteration that still yields the same
 * outcome. Exact because generation consumes the RNG identically for every
 * prefix length (see mutateObject).
 */
export function minimize(campaignSeed: number, record: IterationRecord): IterationRecord {
  for (let limit = 1; limit < record.mutations.length; limit += 1) {
    const candidate = runIteration(campaignSeed, record.index, limit);
    if (candidate.outcome === record.outcome) return candidate;
  }
  return record;
}

/** Re-generates a record exactly as minimize()/runCampaign() produced it. */
export function replay(campaignSeed: number, record: IterationRecord): IterationRecord {
  return runIteration(campaignSeed, record.index, record.applyLimit ?? Number.POSITIVE_INFINITY);
}

/** Re-runs one iteration `times` times; returns how often the outcome matched the first run. */
export function stability(
  campaignSeed: number,
  index: number,
  times: number,
): { outcome: Outcome; matches: number; times: number; details: Set<string> } {
  const first = runIteration(campaignSeed, index);
  let matches = 1;
  const details = new Set<string>([first.detail]);
  for (let i = 1; i < times; i += 1) {
    const again = runIteration(campaignSeed, index);
    if (again.outcome === first.outcome && again.detail === first.detail) matches += 1;
    details.add(again.detail);
  }
  return { outcome: first.outcome, matches, times, details };
}
