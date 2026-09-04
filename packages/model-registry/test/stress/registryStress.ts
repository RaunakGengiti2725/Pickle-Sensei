import { SHOT_TYPES, type ShotTypeSlug } from "@pickle/shared-types";
import {
  EXECUTION_TARGETS,
  MODEL_RUNTIMES,
  MODEL_TASKS,
  type ModelTask,
} from "@pickle/swing-domain";
import {
  DEPLOYMENT_STATUSES,
  ModelRegistry,
  PLATFORMS,
  type DeploymentStatus,
  type ModelManifest,
  type ModelManifestEntry,
  type ResolveQuery,
} from "../../src/index.js";
import {
  containsNonFinite,
  errorMessage,
  type Rng,
  type SequenceRun,
  type StepFailure,
} from "./harness.js";

/**
 * Randomized action sequences over the public ModelRegistry API, checked
 * against an independent reference model of the documented contract
 * (registry.ts doc comments + AGENTS.md "model registry" rules):
 *
 *  R1 construction accepts a manifest iff no documented validation rule is
 *     violated (duplicate id@version, forbidden alias, unknown status, no
 *     platforms, artifactUri without hash, splits without training dataset,
 *     metrics without eval dataset, dangling/self rollback predecessor,
 *     schemaVersion ≠ 1).
 *  R2 resolve() returns null iff no entry matches (task, status, platform,
 *     stroke) — never a guess; a non-null result satisfies every predicate
 *     and has the highest version among matches (numeric locale compare).
 *  R3 shadowFor(q) ≡ resolve({...q, status: "shadow"}).
 *  R4 byId is exact on (id, version).
 *  R5 list() preserves registration order; list(task) is the task filter.
 *  R6 withEntry is append-only: throws on an existing id@version, otherwise
 *     returns a NEW registry with the entry appended and leaves the original
 *     registry's list() unchanged.
 *  R7 fromJson(JSON.stringify(list)) round-trips to an identical list.
 *  R8 no output contains NaN or ±Infinity.
 */

const ID_POOL = ["a.alpha", "b.beta", "c.gamma", "d.delta", "e.eps", "f.zeta"] as const;
const VERSION_POOL = [
  "v1",
  "v2",
  "v3",
  "v9",
  "v10",
  "v11",
  "sm-v1",
  "sm-v2",
  "sm-v10",
  "x-1.2",
  "x-1.10",
  "2026-01",
  "rc1",
] as const;
/** Small task pool so queries collide often; a few full-range picks keep coverage. */
const TASK_POOL: readonly ModelTask[] = [
  "pose_estimation",
  "technique_scoring",
  "stroke_classification",
  "paddle_ownership",
];
const ALIASES = ["latest", "current", "head", "newest", ""] as const;
const DATASET_VERSIONS = ["v1", "v2", "pickle-real-v0.3"] as const;

export type RegistryAction =
  | { kind: "construct"; manifest: ModelManifest }
  | { kind: "withEntry"; entry: ModelManifestEntry }
  | { kind: "resolve"; query: ResolveQuery }
  | { kind: "shadowFor"; query: Omit<ResolveQuery, "status"> }
  | { kind: "byId"; id: string; version: string }
  | { kind: "list"; task: ModelTask | undefined }
  | { kind: "roundTrip" };

function randomVersion(rng: Rng): string {
  return rng.chance(0.85) ? rng.pick(VERSION_POOL) : `v${rng.int(0, 99)}`;
}

function randomTask(rng: Rng): ModelTask {
  return rng.chance(0.8) ? rng.pick(TASK_POOL) : rng.pick(MODEL_TASKS);
}

function randomStrokes(rng: Rng): ShotTypeSlug[] | "all" {
  if (rng.chance(0.5)) return "all";
  return rng.subset(SHOT_TYPES, 0.4);
}

/** A structurally legal entry; `existing` lets rollback edges point at registered entries. */
export function legalEntry(rng: Rng, existing: readonly ModelManifestEntry[]): ModelManifestEntry {
  const hasArtifact = rng.chance(0.3);
  const training = rng.chance(0.3) ? rng.pick(DATASET_VERSIONS) : null;
  const evaluation = rng.chance(0.3) ? rng.pick(DATASET_VERSIONS) : null;
  const predecessor = existing.length > 0 && rng.chance(0.3) ? rng.pick(existing) : null;
  return {
    id: rng.pick(ID_POOL),
    version: randomVersion(rng),
    task: randomTask(rng),
    runtime: rng.pick(MODEL_RUNTIMES),
    executionTarget: rng.pick(EXECUTION_TARGETS),
    deploymentStatus: rng.pick(DEPLOYMENT_STATUSES),
    supportedPlatforms: rng.nonEmptySubset(PLATFORMS, 0.6),
    supportedStrokes: randomStrokes(rng),
    inputSchemaVersion: rng.int(1, 3),
    outputSchemaVersion: rng.int(1, 3),
    artifactHash: hasArtifact ? rng.pick(["a", "b", "0"]).repeat(64) : null,
    artifactUri: hasArtifact ? `https://models.example/${rng.int(1, 999)}.mlmodelc` : null,
    trainingDatasetVersion: training,
    evaluationDatasetVersion: evaluation,
    commit: rng.chance(0.2) ? "0123456789abcdef0123456789abcdef01234567" : null,
    splits:
      training !== null && rng.chance(0.5) ? { train: "t", validation: "v", test: "x" } : null,
    metrics:
      evaluation !== null && rng.chance(0.5)
        ? { accuracy: rng.int(0, 1000) / 1000, f1: rng.int(0, 1000) / 1000 }
        : null,
    supportedCaptureEnvelope: rng.chance(0.3)
      ? "capture-envelope-thresholds-v0.4-provisional"
      : null,
    calibrationVersion: null,
    runtimeRequirements: rng.subset(["coreml", "python3.12", "ffmpeg"], 0.3),
    promotionDate: rng.chance(0.2) ? "2026-09-01" : null,
    rollbackPredecessor: predecessor === null ? null : `${predecessor.id}@${predecessor.version}`,
    license: rng.chance(0.5) ? "apache-2.0" : null,
    notes: "stress",
  };
}

export const REGISTRY_DEFECTS = [
  "alias_version",
  "duplicate_key",
  "no_platforms",
  "uri_without_hash",
  "splits_without_training",
  "metrics_without_eval",
  "dangling_predecessor",
  "self_predecessor",
  "unknown_status",
] as const;
export type RegistryDefect = (typeof REGISTRY_DEFECTS)[number];

/** Near-legal entry: one documented rule broken on purpose. */
export function defectiveEntry(
  rng: Rng,
  existing: readonly ModelManifestEntry[],
  defect: RegistryDefect,
): ModelManifestEntry {
  const base = legalEntry(rng, existing);
  switch (defect) {
    case "alias_version": {
      const alias = rng.pick(ALIASES);
      const decorated = rng.chance(0.5) ? alias.toUpperCase() : alias;
      return { ...base, version: rng.chance(0.3) ? ` ${decorated}\t` : decorated };
    }
    case "duplicate_key": {
      if (existing.length === 0) return base;
      const twin = rng.pick(existing);
      return { ...base, id: twin.id, version: twin.version };
    }
    case "no_platforms":
      return { ...base, supportedPlatforms: [] };
    case "uri_without_hash":
      return { ...base, artifactUri: "https://models.example/unverified.bin", artifactHash: null };
    case "splits_without_training":
      return {
        ...base,
        splits: { train: "t", validation: "v", test: "x" },
        trainingDatasetVersion: null,
      };
    case "metrics_without_eval":
      return { ...base, metrics: { accuracy: 0.5 }, evaluationDatasetVersion: null };
    case "dangling_predecessor":
      return { ...base, rollbackPredecessor: `ghost.${rng.int(0, 99)}@v${rng.int(0, 9)}` };
    case "self_predecessor":
      return { ...base, rollbackPredecessor: `${base.id}@${base.version}` };
    case "unknown_status":
      return {
        ...base,
        deploymentStatus: rng.pick(["live", "prod", "PRODUCTION"]) as DeploymentStatus,
      };
  }
}

function randomManifest(rng: Rng, defectChance: number): ModelManifest {
  const entries: ModelManifestEntry[] = [];
  const count = rng.int(0, 8);
  for (let i = 0; i < count; i += 1) {
    entries.push(
      rng.chance(defectChance)
        ? defectiveEntry(rng, entries, rng.pick(REGISTRY_DEFECTS))
        : legalEntry(rng, entries),
    );
  }
  const schemaVersion =
    defectChance > 0 && rng.chance(0.05) ? (rng.pick([0, 2, 9]) as unknown as 1) : 1;
  return { schemaVersion, entries };
}

function randomQuery(rng: Rng, entries: readonly ModelManifestEntry[]): ResolveQuery {
  const fromExisting = entries.length > 0 && rng.chance(0.6) ? rng.pick(entries) : null;
  const query: ResolveQuery = {
    task: fromExisting?.task ?? randomTask(rng),
    platform:
      fromExisting !== null ? rng.pick(fromExisting.supportedPlatforms) : rng.pick(PLATFORMS),
  };
  if (rng.chance(0.5)) query.stroke = rng.pick(SHOT_TYPES);
  if (rng.chance(0.4)) query.status = rng.pick(DEPLOYMENT_STATUSES);
  return query;
}

export function generateRegistryActions(rng: Rng, length: number): RegistryAction[] {
  // The opening manifest is always legal so every sequence exercises a live registry;
  // later constructs mix in near-legal manifests.
  const first = randomManifest(rng, 0);
  const actions: RegistryAction[] = [{ kind: "construct", manifest: first }];
  // Model-side view of the entries the executor will hold, so later actions can target them.
  let entries: ModelManifestEntry[] = registryValidity(first) === null ? [...first.entries] : [];
  while (actions.length < length) {
    const roll = rng.next();
    if (roll < 0.08) {
      const manifest = randomManifest(rng, 0.15);
      actions.push({ kind: "construct", manifest });
      entries = registryValidity(manifest) === null ? [...manifest.entries] : entries;
    } else if (roll < 0.3) {
      const entry = rng.chance(0.25)
        ? defectiveEntry(rng, entries, rng.pick(REGISTRY_DEFECTS))
        : legalEntry(rng, entries);
      actions.push({ kind: "withEntry", entry });
      if (registryValidity({ schemaVersion: 1, entries: [...entries, entry] }) === null) {
        entries = [...entries, entry];
      }
    } else if (roll < 0.6) {
      actions.push({ kind: "resolve", query: randomQuery(rng, entries) });
    } else if (roll < 0.72) {
      const { status: _status, ...query } = randomQuery(rng, entries);
      actions.push({ kind: "shadowFor", query });
    } else if (roll < 0.84) {
      const target = entries.length > 0 && rng.chance(0.7) ? rng.pick(entries) : null;
      actions.push({
        kind: "byId",
        id: target?.id ?? rng.pick(ID_POOL),
        version: target !== null && rng.chance(0.8) ? target.version : randomVersion(rng),
      });
    } else if (roll < 0.94) {
      actions.push({ kind: "list", task: rng.chance(0.5) ? randomTask(rng) : undefined });
    } else {
      actions.push({ kind: "roundTrip" });
    }
  }
  return actions;
}

// ── Reference model ─────────────────────────────────────────────────────────

const FORBIDDEN = new Set(["", "latest", "current", "head", "newest"]);
const keyOf = (entry: ModelManifestEntry): string => `${entry.id}@${entry.version}`;

/** Independent re-statement of the documented validity rules; null = valid. */
export function registryValidity(manifest: ModelManifest): string | null {
  if (manifest.schemaVersion !== 1) return "schema_version";
  const keys = new Set<string>();
  for (const entry of manifest.entries) {
    if (keys.has(keyOf(entry))) return "duplicate_key";
    keys.add(keyOf(entry));
  }
  for (const entry of manifest.entries) {
    if (FORBIDDEN.has(entry.version.trim().toLowerCase())) return "alias_version";
    if (!(DEPLOYMENT_STATUSES as readonly string[]).includes(entry.deploymentStatus)) {
      return "unknown_status";
    }
    if (entry.supportedPlatforms.length === 0) return "no_platforms";
    if (entry.artifactUri !== null && entry.artifactHash === null) return "uri_without_hash";
    if (entry.splits !== null && entry.trainingDatasetVersion === null) {
      return "splits_without_training";
    }
    if (entry.metrics !== null && entry.evaluationDatasetVersion === null) {
      return "metrics_without_eval";
    }
    if (entry.rollbackPredecessor === keyOf(entry)) return "self_predecessor";
    if (entry.rollbackPredecessor !== null && !keys.has(entry.rollbackPredecessor)) {
      return "dangling_predecessor";
    }
  }
  return null;
}

function matches(
  entry: ModelManifestEntry,
  query: ResolveQuery,
  status: DeploymentStatus,
): boolean {
  return (
    entry.task === query.task &&
    entry.deploymentStatus === status &&
    entry.supportedPlatforms.includes(query.platform) &&
    (query.stroke === undefined ||
      entry.supportedStrokes === "all" ||
      entry.supportedStrokes.includes(query.stroke))
  );
}

/** Highest version among matches under the documented numeric locale compare. */
export function modelResolve(
  entries: readonly ModelManifestEntry[],
  query: ResolveQuery,
): ModelManifestEntry[] {
  const status = query.status ?? "production";
  return entries.filter((entry) => matches(entry, query, status));
}

function isMaximalVersion(candidate: ModelManifestEntry, among: ModelManifestEntry[]): boolean {
  return among.every(
    (other) => other.version.localeCompare(candidate.version, undefined, { numeric: true }) <= 0,
  );
}

// ── Executor ────────────────────────────────────────────────────────────────

const snapshot = (registry: ModelRegistry): string => JSON.stringify(registry.list());

export function executeRegistryActions(
  actions: RegistryAction[],
  seed: number,
): SequenceRun<RegistryAction> {
  const trace: string[] = [];
  let failure: StepFailure | null = null;
  let registry: ModelRegistry | null = null;
  let model: ModelManifestEntry[] = [];

  const fail = (step: number, invariant: string, detail: string): void => {
    failure = { step, invariant, detail };
  };

  for (let step = 0; step < actions.length && failure === null; step += 1) {
    const action = actions[step]!;
    switch (action.kind) {
      case "construct": {
        const expected = registryValidity(action.manifest);
        try {
          const built = new ModelRegistry(action.manifest);
          if (expected !== null) {
            fail(step, "R1_accepts_invalid_manifest", `expected rejection for ${expected}`);
            break;
          }
          registry = built;
          model = [...action.manifest.entries];
          trace.push(`construct ok entries=${model.length}`);
        } catch (error) {
          if (expected === null) {
            fail(step, "R1_rejects_valid_manifest", errorMessage(error));
            break;
          }
          trace.push(`construct rejected ${expected}`);
        }
        break;
      }
      case "withEntry": {
        if (registry === null) {
          trace.push("withEntry skipped(no registry)");
          break;
        }
        const current: ModelRegistry = registry;
        const before = snapshot(current);
        const duplicate = model.some((entry) => keyOf(entry) === keyOf(action.entry));
        const expected = duplicate
          ? "duplicate_key"
          : registryValidity({ schemaVersion: 1, entries: [...model, action.entry] });
        try {
          const next: ModelRegistry = current.withEntry(action.entry);
          if (expected !== null) {
            fail(step, "R6_withEntry_accepts_invalid", `expected rejection for ${expected}`);
            break;
          }
          if (snapshot(current) !== before) {
            fail(step, "R6_withEntry_mutated_original", "original registry list() changed");
            break;
          }
          const expectedNext = JSON.stringify([...model, action.entry]);
          if (snapshot(next) !== expectedNext) {
            fail(step, "R6_withEntry_not_appended", "new registry list() != model + entry");
            break;
          }
          registry = next;
          model = [...model, action.entry];
          trace.push(`withEntry ok ${keyOf(action.entry)}`);
        } catch (error) {
          if (expected === null) {
            fail(step, "R6_withEntry_rejects_valid", errorMessage(error));
            break;
          }
          if (snapshot(current) !== before) {
            fail(step, "R6_withEntry_mutated_on_throw", "list() changed after rejected withEntry");
            break;
          }
          trace.push(`withEntry rejected ${expected}`);
        }
        break;
      }
      case "resolve":
      case "shadowFor": {
        if (registry === null) {
          trace.push(`${action.kind} skipped(no registry)`);
          break;
        }
        const current: ModelRegistry = registry;
        const query: ResolveQuery =
          action.kind === "resolve" ? action.query : { ...action.query, status: "shadow" };
        let result: ModelManifestEntry | null;
        try {
          result =
            action.kind === "resolve"
              ? current.resolve(action.query)
              : current.shadowFor(action.query);
        } catch (error) {
          fail(step, "R2_resolve_threw", errorMessage(error));
          break;
        }
        const candidates = modelResolve(model, query);
        if (result === null) {
          if (candidates.length > 0) {
            fail(step, "R2_null_despite_match", `${candidates.length} matching entries`);
            break;
          }
          trace.push(`${action.kind} null ${query.task}/${query.platform}`);
          break;
        }
        if (candidates.length === 0) {
          fail(step, "R2_guess_without_match", keyOf(result));
          break;
        }
        if (!candidates.some((entry) => entry === result)) {
          fail(step, "R2_result_not_a_match", keyOf(result));
          break;
        }
        if (!isMaximalVersion(result, candidates)) {
          fail(
            step,
            "R2_not_highest_version",
            `${keyOf(result)} vs ${candidates.map(keyOf).join(",")}`,
          );
          break;
        }
        if (action.kind === "shadowFor") {
          const viaResolve = current.resolve(query);
          if (viaResolve !== result) {
            fail(step, "R3_shadowFor_differs_from_resolve", keyOf(result));
            break;
          }
        }
        if (containsNonFinite(result)) {
          fail(step, "R8_non_finite_output", keyOf(result));
          break;
        }
        trace.push(`${action.kind} hit ${keyOf(result)}`);
        break;
      }
      case "byId": {
        if (registry === null) {
          trace.push("byId skipped(no registry)");
          break;
        }
        const result = registry.byId(action.id, action.version);
        const expected =
          model.find((entry) => entry.id === action.id && entry.version === action.version) ?? null;
        if (result !== expected) {
          fail(step, "R4_byId_mismatch", `${action.id}@${action.version}`);
          break;
        }
        trace.push(`byId ${result === null ? "null" : "hit"} ${action.id}@${action.version}`);
        break;
      }
      case "list": {
        if (registry === null) {
          trace.push("list skipped(no registry)");
          break;
        }
        const listed = registry.list(action.task);
        const expected =
          action.task === undefined ? model : model.filter((entry) => entry.task === action.task);
        if (listed.length !== expected.length || listed.some((entry, i) => entry !== expected[i])) {
          fail(step, "R5_list_order_or_content", `task=${action.task ?? "*"}`);
          break;
        }
        listed.push(listed[0] as ModelManifestEntry);
        if (registry.list(action.task).length !== expected.length) {
          fail(step, "R5_list_returns_internal_array", "mutating list() result changed registry");
          break;
        }
        trace.push(`list ok ${action.task ?? "*"}=${expected.length}`);
        break;
      }
      case "roundTrip": {
        if (registry === null) {
          trace.push("roundTrip skipped(no registry)");
          break;
        }
        const json = JSON.stringify({ schemaVersion: 1, entries: registry.list() });
        try {
          const rebuilt = ModelRegistry.fromJson(json);
          if (snapshot(rebuilt) !== snapshot(registry)) {
            fail(step, "R7_round_trip_differs", "fromJson(list) != list");
            break;
          }
          trace.push("roundTrip ok");
        } catch (error) {
          fail(step, "R7_round_trip_threw", errorMessage(error));
        }
        break;
      }
    }
  }
  return { seed, actions, trace, failure };
}
