import { performance } from "node:perf_hooks";
import * as v8 from "node:v8";
import * as vm from "node:vm";
import { SHOT_TYPES } from "@pickle/shared-types";
import { EXECUTION_TARGETS, MODEL_RUNTIMES, MODEL_TASKS } from "@pickle/swing-domain";
import {
  DEFAULT_MODEL_MANIFEST,
  DEPLOYMENT_STATUSES,
  DatasetReleaseIndex,
  ModelRegistry,
  PLATFORMS,
  SubsystemReleaseState,
  auditModelDatasetLineage,
  runRollbackDrill,
  validateDatasetReleaseManifest,
  type DatasetComponentClassification,
  type DatasetReleaseManifest,
  type DeploymentStatus,
  type ModelManifest,
  type ModelManifestEntry,
  type ResolveQuery,
} from "../../src/index.js";

/**
 * Long-run leak / soak harness for @pickle/model-registry.
 *
 * Every scenario is a pure function of its seed: the same seed must produce
 * the same digest on replay (determinism), every numeric output must be
 * finite, `resolve()` may return null ONLY when no manifest entry matches
 * (bounded abstention), and repeating a scenario thousands of times in one
 * process must not grow the heap, leave timers/handles/listeners behind, or
 * slow down (invocation-time drift).
 *
 * Inputs are the committed DEFAULT_MODEL_MANIFEST plus seeded SYNTHETIC
 * entries/manifests. Nothing here is a label, a metric, or a claim about a
 * model — synthetic values are structural fuzz only.
 */

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) + digest (FNV-1a 32) — small, dependency-free.
// ---------------------------------------------------------------------------

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [0, n). */
  int(n: number): number;
  pick<T>(items: readonly T[]): T;
  bool(p?: number): boolean;
  /** Random subset of `items`; non-empty when `minSize` ≥ 1. */
  subset<T>(items: readonly T[], minSize: number): T[];
  hex(chars: number): string;
}

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rng: Rng = {
    next,
    int: (n) => Math.floor(next() * n),
    pick: (items) => {
      if (items.length === 0) throw new Error("pick from empty list");
      return items[Math.floor(next() * items.length)]!;
    },
    bool: (p = 0.5) => next() < p,
    subset: (items, minSize) => {
      const out = items.filter(() => next() < 0.5);
      while (out.length < minSize) {
        const candidate = rng.pick(items);
        if (!out.includes(candidate)) out.push(candidate);
      }
      return out;
    },
    hex: (chars) => {
      let s = "";
      while (s.length < chars) s += Math.floor(next() * 16).toString(16);
      return s;
    },
  };
  return rng;
}

export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Replayable per-iteration seed: campaign seed × scenario name × index. */
export function iterationSeed(campaignSeed: number, scenario: string, index: number): number {
  return parseInt(fnv1a(`${campaignSeed}|${scenario}|${index}`), 16) >>> 0;
}

// ---------------------------------------------------------------------------
// Scenario contract
// ---------------------------------------------------------------------------

export interface ScenarioOutcome {
  /** Deterministic fingerprint of everything the unit returned. */
  digest: string;
  /** Invariant violations observed in this iteration (empty = held). */
  failures: string[];
  /** resolve()/byVersion() calls that returned null. */
  abstentions: number;
  /** Total unit invocations (queries, transitions, validations) this iteration. */
  invocations: number;
  /** Numeric outputs the unit produced (durations, counts) — must all be finite. */
  numericOutputs: number[];
  /** Free-form counters (e.g. fuzz outcome classes). */
  counters: Record<string, number>;
}

export interface Scenario {
  name: string;
  run(seed: number): ScenarioOutcome;
  /**
   * True when the scenario deliberately keeps state alive across iterations
   * (a long-lived instance) so retained growth is expected and is judged by
   * `retainedBytesPerUnit` instead of the flat-heap rule.
   */
  retainsStateAcrossIterations: boolean;
  /** For long-lived scenarios: number of retained units created so far. */
  retainedUnits?: () => number;
}

// ---------------------------------------------------------------------------
// Synthetic manifest generation (structural fuzz — never labels or metrics)
// ---------------------------------------------------------------------------

const STATUSES: readonly DeploymentStatus[] = DEPLOYMENT_STATUSES;

function synthEntry(
  rng: Rng,
  ordinal: number,
  registeredKeys: readonly string[],
): ModelManifestEntry {
  const task = rng.pick(MODEL_TASKS);
  const withArtifact = rng.bool(0.3);
  const withTraining = rng.bool(0.3);
  const withEval = rng.bool(0.3);
  const trainingDatasetVersion = withTraining ? `synthetic-train-v${rng.int(5)}` : null;
  const evaluationDatasetVersion = withEval ? `synthetic-eval-v${rng.int(5)}` : null;
  const rollbackPredecessor =
    registeredKeys.length > 0 && rng.bool(0.3) ? rng.pick(registeredKeys) : null;
  return {
    id: `stress.${task}.${rng.int(4)}`,
    version: `v${rng.int(20)}.${rng.int(10)}-s${ordinal}`,
    task,
    runtime: rng.pick(MODEL_RUNTIMES),
    executionTarget: rng.pick(EXECUTION_TARGETS),
    deploymentStatus: rng.pick(STATUSES),
    supportedPlatforms: rng.subset(PLATFORMS, 1),
    supportedStrokes: rng.bool(0.5) ? "all" : rng.subset(SHOT_TYPES, rng.bool(0.9) ? 1 : 0),
    inputSchemaVersion: 1 + rng.int(3),
    outputSchemaVersion: 1 + rng.int(3),
    artifactHash: withArtifact ? rng.hex(64) : null,
    artifactUri: withArtifact ? `https://models.invalid/${rng.hex(8)}.bin` : null,
    trainingDatasetVersion,
    evaluationDatasetVersion,
    commit: rng.bool(0.3) ? rng.hex(40) : null,
    // Splits only with a training dataset; metrics only with an eval dataset
    // (structural placeholders — a synthetic metric is not an evaluation).
    splits: withTraining && rng.bool(0.5) ? { train: "t", validation: "v", test: "x" } : null,
    metrics: withEval && rng.bool(0.5) ? { synthetic_placeholder: rng.next() } : null,
    supportedCaptureEnvelope: rng.bool(0.4) ? "capture-envelope-thresholds-v0.4-provisional" : null,
    calibrationVersion: null,
    runtimeRequirements: rng.subset(["a", "b", "c"], 0),
    promotionDate: null,
    rollbackPredecessor,
    license: rng.bool(0.5) ? "synthetic" : null,
    notes: `synthetic stress entry ${ordinal}`,
  };
}

function entryKey(entry: ModelManifestEntry): string {
  return `${entry.id}@${entry.version}`;
}

function versionCompare(a: ModelManifestEntry, b: ModelManifestEntry): number {
  return b.version.localeCompare(a.version, undefined, { numeric: true });
}

/** Independent brute-force oracle for resolve(): the match set, unsorted. */
function oracleMatches(
  entries: readonly ModelManifestEntry[],
  q: ResolveQuery,
): ModelManifestEntry[] {
  const status = q.status ?? "production";
  return entries.filter(
    (e) =>
      e.task === q.task &&
      e.deploymentStatus === status &&
      e.supportedPlatforms.includes(q.platform) &&
      (q.stroke === undefined ||
        e.supportedStrokes === "all" ||
        e.supportedStrokes.includes(q.stroke)),
  );
}

function checkFinite(values: number[], where: string, failures: string[]): void {
  for (const value of values) {
    if (!Number.isFinite(value))
      failures.push(`${where}: non-finite numeric output ${String(value)}`);
  }
}

function expectThrow(fn: () => unknown, pattern: RegExp, label: string, failures: string[]): void {
  try {
    fn();
    failures.push(`${label}: expected throw ${pattern} but nothing was thrown`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) failures.push(`${label}: wrong error "${message}"`);
  }
}

// ---------------------------------------------------------------------------
// Scenario 1 — registry lifecycle: construct, append, round-trip, query.
// ---------------------------------------------------------------------------

export const registryLifecycle: Scenario = {
  name: "registry-lifecycle",
  retainsStateAcrossIterations: false,
  run(seed) {
    const rng = makeRng(seed);
    const failures: string[] = [];
    const results: unknown[] = [];
    let abstentions = 0;
    let invocations = 0;

    let registry = new ModelRegistry(DEFAULT_MODEL_MANIFEST);
    invocations += 1;
    const keys = registry.list().map(entryKey);
    const extraCount = rng.int(9);
    for (let n = 0; n < extraCount; n += 1) {
      const entry = synthEntry(rng, n, keys);
      const before = registry.list().length;
      if (keys.includes(entryKey(entry))) {
        expectThrow(() => registry.withEntry(entry), /immutable/, "withEntry duplicate", failures);
      } else {
        const next = registry.withEntry(entry);
        if (next.list().length !== before + 1)
          failures.push("withEntry did not append exactly one");
        if (registry.list().length !== before)
          failures.push("withEntry mutated the source registry");
        registry = next;
        keys.push(entryKey(entry));
      }
      invocations += 1;
    }
    // Re-registering ANY existing key (identical content) must throw.
    const dup = rng.pick(registry.list());
    expectThrow(() => registry.withEntry({ ...dup }), /immutable/, "withEntry identical", failures);
    invocations += 1;

    // JSON round trip must be lossless.
    const serialized = JSON.stringify({ schemaVersion: 1, entries: registry.list() });
    const roundTripped = ModelRegistry.fromJson(serialized);
    invocations += 1;
    if (
      JSON.stringify(roundTripped.list()) !==
      serialized.slice('{"schemaVersion":1,"entries":'.length, -1)
    ) {
      failures.push("fromJson round trip is not lossless");
    }

    const entries = registry.list();
    const queryCount = 20 + rng.int(41);
    for (let i = 0; i < queryCount; i += 1) {
      const kind = rng.int(5);
      if (kind <= 1) {
        const query: ResolveQuery = { task: rng.pick(MODEL_TASKS), platform: rng.pick(PLATFORMS) };
        if (rng.bool(0.5)) query.stroke = rng.pick(SHOT_TYPES);
        if (rng.bool(0.3)) query.status = rng.pick(STATUSES);
        const got = registry.resolve(query);
        invocations += 1;
        const matches = oracleMatches(entries, query);
        if (got === null) {
          abstentions += 1;
          if (matches.length > 0) failures.push(`resolve abstained with ${matches.length} matches`);
        } else {
          if (!matches.includes(got)) failures.push("resolve returned a non-matching entry");
          const better = matches.find((m) => versionCompare(m, got) < 0);
          if (better)
            failures.push(`resolve skipped higher version ${better.version} for ${got.version}`);
        }
        results.push(got === null ? null : entryKey(got));
      } else if (kind === 2) {
        const query = { task: rng.pick(MODEL_TASKS), platform: rng.pick(PLATFORMS) };
        const got = registry.shadowFor(query);
        invocations += 1;
        const matches = oracleMatches(entries, { ...query, status: "shadow" });
        if (got === null) {
          abstentions += 1;
          if (matches.length > 0) failures.push("shadowFor abstained with matches");
        } else if (got.deploymentStatus !== "shadow") {
          failures.push("shadowFor returned a non-shadow entry");
        }
        results.push(got === null ? null : entryKey(got));
      } else if (kind === 3) {
        const known = rng.bool(0.7);
        const target = rng.pick(entries);
        const got = known
          ? registry.byId(target.id, target.version)
          : registry.byId(target.id, `${target.version}-missing`);
        invocations += 1;
        if (known && got !== target) failures.push("byId missed a registered entry");
        if (!known && got !== null) failures.push("byId returned an entry for an unknown version");
        if (got === null) abstentions += 1;
        results.push(got === null ? null : entryKey(got));
      } else {
        const task = rng.bool(0.5) ? rng.pick(MODEL_TASKS) : undefined;
        const listed = registry.list(task);
        invocations += 1;
        if (task !== undefined && listed.some((e) => e.task !== task))
          failures.push("list(task) leaked other tasks");
        if (task === undefined && listed.length !== entries.length)
          failures.push("list() lost entries");
        results.push(listed.map(entryKey));
      }
    }

    // Every DEFAULT production task must still resolve on its declared platforms
    // (bounded abstention: null only for genuinely absent tasks).
    for (const entry of DEFAULT_MODEL_MANIFEST.entries) {
      if (entry.deploymentStatus !== "production") continue;
      for (const platform of entry.supportedPlatforms) {
        const got = registry.resolve({ task: entry.task, platform });
        invocations += 1;
        if (got === null)
          failures.push(`default production task ${entry.task}/${platform} abstained`);
      }
    }

    // Negative validation: one seeded malformed manifest must be rejected cleanly.
    if (rng.bool(0.6)) {
      const base = rng.pick(DEFAULT_MODEL_MANIFEST.entries);
      const variants: Array<[RegExp, ModelManifestEntry[]]> = [
        [
          /version alias/,
          [{ ...base, version: rng.pick(["latest", "HEAD", "Current", "", " newest "]) }],
        ],
        [/Duplicate/, [base, { ...base, notes: "dup" }]],
        [/no platforms/, [{ ...base, supportedPlatforms: [] }]],
        [/artifact hash/, [{ ...base, artifactUri: "https://x.invalid/a", artifactHash: null }]],
        [
          /training dataset/,
          [
            {
              ...base,
              splits: { train: "t", validation: "v", test: "x" },
              trainingDatasetVersion: null,
            },
          ],
        ],
        [
          /evaluation dataset/,
          [{ ...base, metrics: { placeholder: 0 }, evaluationDatasetVersion: null }],
        ],
        [/not registered/, [{ ...base, rollbackPredecessor: "ghost@v0" }]],
        [/own rollback predecessor/, [{ ...base, rollbackPredecessor: entryKey(base) }]],
        [/deployment status/, [{ ...base, deploymentStatus: "retired" as DeploymentStatus }]],
      ];
      const [pattern, bad] = rng.pick(variants);
      expectThrow(
        () => new ModelRegistry({ schemaVersion: 1, entries: bad }),
        pattern,
        "validateManifest",
        failures,
      );
      invocations += 1;
    }

    return {
      digest: fnv1a(JSON.stringify(results)),
      failures,
      abstentions,
      invocations,
      numericOutputs: [],
      counters: { extraEntries: extraCount, queries: queryCount },
    };
  },
};

// ---------------------------------------------------------------------------
// Scenario 2 — release-state lifecycle with a reference model + drill.
// ---------------------------------------------------------------------------

const BROKEN_POSE_ENTRY: ModelManifestEntry = {
  ...DEFAULT_MODEL_MANIFEST.entries[0]!,
  id: "pose.broken-candidate",
  version: "broken-pose-99",
  supportedPlatforms: ["ios", "android", "server"],
  notes: "Deliberately bad drill candidate — never ship.",
};
const BROKEN_MANIFEST: ModelManifest = { schemaVersion: 1, entries: [BROKEN_POSE_ENTRY] };

function synthManifest(rng: Rng, ordinal: number): ModelManifest {
  const entries = DEFAULT_MODEL_MANIFEST.entries.filter(() => rng.bool(0.8));
  // Keep the subset closed under rollbackPredecessor so it stays a valid manifest.
  for (let i = 0; i < entries.length; i += 1) {
    const predecessor = entries[i]!.rollbackPredecessor;
    if (predecessor === null || entries.some((e) => entryKey(e) === predecessor)) continue;
    const missing = DEFAULT_MODEL_MANIFEST.entries.find((e) => entryKey(e) === predecessor);
    if (missing) entries.push(missing);
  }
  const keys = entries.map(entryKey);
  const extra = rng.int(4);
  for (let n = 0; n < extra; n += 1) {
    const entry = synthEntry(rng, ordinal * 100 + n, keys);
    if (!keys.includes(entryKey(entry))) {
      entries.push(entry);
      keys.push(entryKey(entry));
    }
  }
  return { schemaVersion: 1, entries };
}

function poseIdOf(manifest: ModelManifest): string | null {
  return (
    new ModelRegistry(manifest).resolve({ task: "pose_estimation", platform: "ios" })?.id ?? null
  );
}

type ReleaseOp = "activate" | "record_known_good" | "disable" | "rollback";
const RELEASE_OPS: readonly ReleaseOp[] = ["activate", "record_known_good", "disable", "rollback"];

export const releaseStateLifecycle: Scenario = {
  name: "release-state-lifecycle",
  retainsStateAcrossIterations: false,
  run(seed) {
    const rng = makeRng(seed);
    const failures: string[] = [];
    const numericOutputs: number[] = [];
    const trace: unknown[] = [];
    let invocations = 0;

    const candidates: Array<{ version: string; artifact: ModelManifest }> = [
      { version: "m0", artifact: DEFAULT_MODEL_MANIFEST },
    ];
    const candidateCount = 1 + rng.int(4);
    for (let i = 1; i <= candidateCount; i += 1) {
      candidates.push({ version: `m${i}`, artifact: synthManifest(rng, i) });
    }
    const deterministicClock = rng.bool(0.5);
    let tick = 0;

    let live: ModelRegistry | null = null;
    let applyCalls = 0;
    const state = new SubsystemReleaseState<ModelManifest>({
      subsystem: `stress-${seed}`,
      initial: candidates[0]!,
      apply: (manifest) => {
        applyCalls += 1;
        live = manifest === null ? null : new ModelRegistry(manifest);
      },
      ...(deterministicClock ? { clock: () => (tick += 3) } : {}),
    });
    invocations += 1;
    if (applyCalls !== 1)
      failures.push("constructor did not apply the initial artifact exactly once");

    // Reference model of the controller's documented state machine.
    let expectedActive: string | null = "m0";
    let expectedKnownGood: string | null = null;
    let expectedJournal = 0;

    const opCount = 5 + rng.int(36);
    for (let i = 0; i < opCount; i += 1) {
      const op = rng.pick(RELEASE_OPS);
      const before = applyCalls;
      invocations += 1;
      switch (op) {
        case "activate": {
          const candidate = rng.pick(candidates);
          const duration = state.activate(candidate);
          numericOutputs.push(duration);
          if (deterministicClock && duration !== 3)
            failures.push(`activate duration ${duration} != clock delta 3`);
          if (applyCalls !== before + 1) failures.push("activate did not apply exactly once");
          expectedActive = candidate.version;
          expectedJournal += 1;
          break;
        }
        case "record_known_good": {
          if (expectedActive === null) {
            expectThrow(
              () => state.recordKnownGood(),
              /cannot record known-good while disabled/,
              "recordKnownGood",
              failures,
            );
            if (applyCalls !== before) failures.push("failed recordKnownGood reached apply()");
          } else {
            state.recordKnownGood();
            expectedKnownGood = expectedActive;
            expectedJournal += 1;
            if (applyCalls !== before) failures.push("recordKnownGood reached apply()");
          }
          break;
        }
        case "disable": {
          const duration = state.disable();
          numericOutputs.push(duration);
          if (applyCalls !== before + 1) failures.push("disable did not apply exactly once");
          expectedActive = null;
          expectedJournal += 1;
          break;
        }
        case "rollback": {
          if (expectedKnownGood === null) {
            expectThrow(
              () => state.rollback(),
              /no known-good version recorded/,
              "rollback",
              failures,
            );
            if (applyCalls !== before) failures.push("failed rollback reached apply()");
          } else {
            const duration = state.rollback();
            numericOutputs.push(duration);
            if (applyCalls !== before + 1) failures.push("rollback did not apply exactly once");
            expectedActive = expectedKnownGood;
            expectedJournal += 1;
          }
          break;
        }
      }
      const active = state.active()?.version ?? null;
      const knownGood = state.knownGood()?.version ?? null;
      if (active !== expectedActive)
        failures.push(`after ${op}: active ${active} != expected ${expectedActive}`);
      if (knownGood !== expectedKnownGood)
        failures.push(`after ${op}: knownGood ${knownGood} != expected ${expectedKnownGood}`);
      if (state.journal().length !== expectedJournal)
        failures.push(
          `after ${op}: journal length ${state.journal().length} != ${expectedJournal}`,
        );
      // Live behaviour must follow the active artifact exactly.
      const livePose =
        (live as ModelRegistry | null)?.resolve({ task: "pose_estimation", platform: "ios" })?.id ??
        null;
      const expectedPose =
        expectedActive === null
          ? null
          : poseIdOf(candidates.find((c) => c.version === expectedActive)!.artifact);
      if (livePose !== expectedPose)
        failures.push(`after ${op}: live pose ${livePose} != ${expectedPose}`);
      trace.push([op, active, knownGood]);
    }

    // journal() must be a defensive copy.
    const journalCopy = state.journal() as unknown[];
    journalCopy.length = 0;
    if (state.journal().length !== expectedJournal)
      failures.push("journal() exposed internal storage");
    for (const entry of state.journal()) {
      numericOutputs.push(entry.durationMs, entry.atEpochMs);
      if (entry.durationMs < 0) failures.push("negative journal duration");
    }

    // Full drill from whatever state we ended in (needs an active version whose
    // pose provider differs from the broken candidate's).
    if (expectedActive !== null) {
      const startPose = poseIdOf(candidates.find((c) => c.version === expectedActive)!.artifact);
      const resolvePose = (): string | null =>
        (live as ModelRegistry | null)?.resolve({ task: "pose_estimation", platform: "ios" })?.id ??
        null;
      const result = runRollbackDrill(
        state,
        { version: "broken-99", artifact: BROKEN_MANIFEST },
        {
          knownGoodLive: () => resolvePose() === startPose,
          badLive: () => resolvePose() === "pose.broken-candidate",
        },
      );
      invocations += 1;
      numericOutputs.push(result.timeToDisableMs, result.timeToRollbackMs);
      if (!result.badWasLive) failures.push("drill: bad candidate never went live");
      if (!result.recovered) failures.push("drill: known-good behaviour not restored");
      if (result.knownGoodVersion !== expectedActive)
        failures.push("drill: wrong knownGoodVersion");
      if (state.active()?.version !== expectedActive)
        failures.push("drill: active version not restored");
      if (state.journal().length !== expectedJournal + 4)
        failures.push("drill: journal did not gain exactly 4 entries");
      trace.push(["drill", result.badWasLive, result.recovered, result.environment]);
    } else {
      expectThrow(
        () =>
          runRollbackDrill(
            state,
            { version: "broken-99", artifact: BROKEN_MANIFEST },
            { knownGoodLive: () => true, badLive: () => true },
          ),
        /drill requires an active version/,
        "drill while disabled",
        failures,
      );
      invocations += 1;
    }

    checkFinite(numericOutputs, "release-state", failures);
    // Wall-clock fields are excluded from the digest; the deterministic-clock
    // branch includes durations so clock plumbing is covered by replay.
    const digestInput = deterministicClock
      ? [trace, state.journal().map((e) => [e.action, e.fromVersion, e.toVersion, e.durationMs])]
      : [trace, state.journal().map((e) => [e.action, e.fromVersion, e.toVersion])];
    return {
      digest: fnv1a(JSON.stringify(digestInput)),
      failures,
      abstentions: 0,
      invocations,
      numericOutputs,
      counters: {
        ops: opCount,
        candidates: candidateCount,
        deterministicClock: deterministicClock ? 1 : 0,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Scenario 2b — ONE release-state instance kept alive for the whole campaign.
// Retained growth here is the append-only journal; the harness measures
// bytes per journal entry instead of demanding a flat heap.
// ---------------------------------------------------------------------------

export function makeLongLivedReleaseState(): Scenario {
  let applied = 0;
  const state = new SubsystemReleaseState<number>({
    subsystem: "stress-long-lived",
    initial: { version: "v0", artifact: 0 },
    apply: () => {
      applied += 1;
    },
  });
  state.recordKnownGood();
  return {
    name: "release-state-long-lived",
    retainsStateAcrossIterations: true,
    retainedUnits: () => state.journal().length,
    run(seed) {
      const rng = makeRng(seed);
      const failures: string[] = [];
      const numericOutputs: number[] = [];
      const before = state.journal().length;
      const ops = 5 + rng.int(6);
      const sequence: string[] = [];
      for (let i = 0; i < ops; i += 1) {
        const op = rng.pick(RELEASE_OPS);
        sequence.push(op);
        if (op === "activate")
          numericOutputs.push(
            state.activate({ version: `v${rng.int(1000)}`, artifact: rng.int(1e6) }),
          );
        else if (op === "disable") numericOutputs.push(state.disable());
        else if (op === "rollback") numericOutputs.push(state.rollback());
        else if (state.active() !== null) state.recordKnownGood();
        else
          expectThrow(() => state.recordKnownGood(), /while disabled/, "recordKnownGood", failures);
      }
      const grew = state.journal().length - before;
      checkFinite(numericOutputs, "long-lived", failures);
      // The controller carries state across iterations, so only the seeded op
      // sequence (not the resulting state) is the replayable fingerprint.
      return {
        digest: fnv1a(JSON.stringify(sequence)),
        failures,
        abstentions: 0,
        invocations: ops,
        numericOutputs,
        counters: { journalEntries: grew, applied },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Scenario 3 — dataset release validation, index, lineage audit.
// ---------------------------------------------------------------------------

const CLASSIFICATIONS: readonly DatasetComponentClassification[] = [
  "gold_human_labels",
  "machine_generated",
  "mixed_human_and_machine",
  "registry_metadata",
  "media",
  "run_outputs",
  "release_snapshots",
];

function synthDatasetRelease(rng: Rng, ordinal: number): DatasetReleaseManifest {
  const datasetId = `synthetic-ds-${ordinal}`;
  const version = `v${ordinal}.${rng.int(5)}`;
  const componentCount = 1 + rng.int(4);
  const components = [];
  for (let i = 0; i < componentCount; i += 1) {
    const classification = rng.pick(CLASSIFICATIONS);
    const mustBeNotGold =
      classification === "machine_generated" || classification === "run_outputs";
    const notGold = mustBeNotGold || (classification !== "gold_human_labels" && rng.bool(0.3));
    const artifacts = [];
    const artifactCount = rng.int(3);
    for (let a = 0; a < artifactCount; a += 1) {
      artifacts.push({
        path: `releases/${version}/artifacts/${rng.hex(6)}.json`,
        livePath: rng.bool(0.5) ? `datasets/${rng.hex(4)}.json` : null,
        sha256: rng.hex(64),
      });
    }
    components.push({
      componentId: `component-${i}`,
      path: `datasets/${rng.hex(4)}`,
      description: "synthetic structural fixture",
      classification,
      notGold,
      notGoldReason: notGold ? "synthetic fixture — never ground truth" : null,
      artifacts,
    });
  }
  const analysisConsent = rng.int(50);
  const sessionCount = 1 + rng.int(6);
  const splitNames = ["dev", "locked_test", "holdout"].slice(0, 1 + rng.int(3));
  const bySplit: Record<string, { sessions: string[] }> = {};
  for (const name of splitNames) bySplit[name] = { sessions: [] };
  for (let s = 0; s < sessionCount; s += 1)
    bySplit[rng.pick(splitNames)]!.sessions.push(`session-${s}`);
  const silver = rng.bool(0.3) ? 1 + rng.int(9) : 0;
  return {
    schemaVersion: 1,
    releaseId: `${datasetId}@${version}`,
    datasetId,
    version,
    createdAtIso: new Date(1_700_000_000_000 + rng.int(1e9)).toISOString(),
    immutable: true,
    annotationSchemaVersion: 1 + rng.int(3),
    components,
    statistics: {
      sources: rng.int(30),
      recordings: rng.int(30),
      rootRecordings: rng.int(30),
      sessions: sessionCount,
      rootFootageMinutes: rng.int(600),
      annotatedCases: rng.int(10),
      goldTargetEvents: rng.int(10),
      tierCCandidateEvents: rng.int(500),
      goldLabelCounts: { synthetic_fixture_count: rng.int(50) },
      annotators: rng.int(3),
      expertCoaches: 0,
    },
    labels: {
      GOLD: { definition: "synthetic fixture definition", count: rng.int(50) },
      SILVER: {
        definition: "synthetic",
        count: silver,
        verificationNote: silver > 0 ? "synthetic verification note" : "",
      },
      TIER_C: { definition: "machine-mined candidates; NEVER labels", count: rng.int(300) },
    },
    rights: {
      trainingEligibleSources: rng.int(20),
      rightsQuarantinedSources: rng.int(5),
      policy: "synthetic rights policy",
    },
    consent: {
      firstPartyRecordings: rng.int(10),
      analysisConsentRecords: analysisConsent,
      trainingConsentRecords: rng.int(analysisConsent + 1),
      policy: "analysis consent is separate from training consent",
    },
    splits: {
      policyVersion: `splits-v${1 + rng.int(3)}`,
      unit: "session",
      bySplit,
      leakageFindings: [],
    },
    dedupLineage: {
      algo: "synthetic",
      findings: rng.int(10),
      declaredLineageConfirmed: rng.int(10),
      mergedSessions: rng.int(10),
      limitations: "synthetic",
      report: rng.bool(0.5)
        ? { path: "datasets/synthetic-dedup.json", livePath: null, sha256: rng.hex(64) }
        : null,
    },
    knownLimitations: ["synthetic fixture; no real limitation recorded"],
    problems: [],
    warnings: [],
  };
}

type Mutation = {
  name: string;
  expect: RegExp;
  apply: (m: DatasetReleaseManifest, rng: Rng) => void;
};

const DATASET_MUTATIONS: readonly Mutation[] = [
  {
    name: "bad-releaseId",
    expect: /releaseId must be datasetId@version/,
    apply: (m) => {
      m.releaseId = `${m.datasetId}@wrong`;
    },
  },
  {
    name: "bad-version",
    expect: /version must match/,
    apply: (m) => {
      m.version = "latest";
      m.releaseId = `${m.datasetId}@latest`;
    },
  },
  {
    name: "bad-timestamp",
    expect: /not a parseable timestamp/,
    apply: (m) => {
      m.createdAtIso = "yesterday-ish";
    },
  },
  {
    name: "mutable",
    expect: /must be immutable/,
    apply: (m) => {
      (m as { immutable: boolean }).immutable = false;
    },
  },
  {
    name: "schema-version-0",
    expect: /annotationSchemaVersion/,
    apply: (m) => {
      m.annotationSchemaVersion = 0;
    },
  },
  {
    name: "no-components",
    expect: /no components/,
    apply: (m) => {
      m.components = [];
    },
  },
  {
    name: "dup-component",
    expect: /duplicate component/,
    apply: (m) => {
      m.components.push({ ...m.components[0]! });
    },
  },
  {
    name: "bad-sha",
    expect: /malformed sha256/,
    apply: (m, rng) => {
      m.components[0]!.artifacts.push({ path: "x", livePath: null, sha256: rng.hex(63) });
    },
  },
  {
    name: "notGold-no-reason",
    expect: /requires a notGoldReason/,
    apply: (m) => {
      const c = m.components[0]!;
      c.classification = "media";
      c.notGold = true;
      c.notGoldReason = "";
    },
  },
  {
    name: "gold-and-notGold",
    expect: /cannot also be notGold/,
    apply: (m) => {
      const c = m.components[0]!;
      c.classification = "gold_human_labels";
      c.notGold = true;
      c.notGoldReason = "x";
    },
  },
  {
    name: "machine-not-notGold",
    expect: /must be marked notGold/,
    apply: (m) => {
      const c = m.components[0]!;
      c.classification = "machine_generated";
      c.notGold = false;
      c.notGoldReason = null;
    },
  },
  {
    name: "nan-statistic",
    expect: /statistics\.recordings is negative or NaN/,
    apply: (m) => {
      m.statistics.recordings = Number.NaN;
    },
  },
  {
    name: "negative-statistic",
    expect: /statistics\.sources is negative or NaN/,
    apply: (m) => {
      m.statistics.sources = -1;
    },
  },
  {
    name: "fractional-gold-count",
    expect: /goldLabelCounts.*non-negative integer/,
    apply: (m) => {
      m.statistics.goldLabelCounts["synthetic_fixture_count"] = 1.5;
    },
  },
  {
    name: "silver-washing",
    expect: /silver-washing forbidden/,
    apply: (m) => {
      m.labels.SILVER.count = 3;
      m.labels.SILVER.verificationNote = "";
    },
  },
  {
    name: "tier-c-definition",
    expect: /TIER_C definition/,
    apply: (m) => {
      m.labels.TIER_C.count = 5;
      m.labels.TIER_C.definition = "mined stuff";
    },
  },
  {
    name: "consent-conflated",
    expect: /analysis vs training/,
    apply: (m) => {
      m.consent.policy = "users agreed";
    },
  },
  {
    name: "consent-overflow",
    expect: /cannot exceed analysisConsentRecords/,
    apply: (m) => {
      m.consent.trainingConsentRecords = m.consent.analysisConsentRecords + 1;
    },
  },
  {
    name: "empty-rights",
    expect: /empty rights\.policy/,
    apply: (m) => {
      m.rights.policy = "";
    },
  },
  {
    name: "empty-splits-policy",
    expect: /empty splits\.policyVersion/,
    apply: (m) => {
      m.splits.policyVersion = "";
    },
  },
  {
    name: "split-leakage",
    expect: /spans splits .* without a recorded leakage finding/,
    apply: (m) => {
      const names = Object.keys(m.splits.bySplit);
      if (names.length < 2) m.splits.bySplit["leak"] = { sessions: [] };
      const all = Object.keys(m.splits.bySplit);
      const s = m.splits.bySplit[all[0]!]!.sessions[0] ?? "session-0";
      m.splits.bySplit[all[0]!]!.sessions.push(s);
      m.splits.bySplit[all[1]!]!.sessions.push(s);
    },
  },
  {
    name: "bad-dedup-report",
    expect: /dedupLineage\.report: malformed sha256/,
    apply: (m) => {
      m.dedupLineage.report = { path: "x", livePath: null, sha256: "nope" };
    },
  },
  {
    name: "no-limitations",
    expect: /knownLimitations is empty/,
    apply: (m) => {
      m.knownLimitations = [];
    },
  },
];

export const datasetReleaseIndex: Scenario = {
  name: "dataset-release-index",
  retainsStateAcrossIterations: false,
  run(seed) {
    const rng = makeRng(seed);
    const failures: string[] = [];
    const trace: unknown[] = [];
    let invocations = 0;
    let abstentions = 0;
    const counters = { valid: 0, mutated: 0, versionCollisions: 0 };

    const releaseCount = 1 + rng.int(8);
    const valid: DatasetReleaseManifest[] = [];
    const index = new DatasetReleaseIndex();
    for (let i = 0; i < releaseCount; i += 1) {
      const manifest = synthDatasetRelease(rng, i);
      if (rng.bool(0.45)) {
        const mutation = rng.pick(DATASET_MUTATIONS);
        mutation.apply(manifest, rng);
        const problems = validateDatasetReleaseManifest(manifest);
        invocations += 1;
        if (!problems.some((p) => mutation.expect.test(p))) {
          failures.push(
            `mutation ${mutation.name}: expected ${mutation.expect} in ${JSON.stringify(problems)}`,
          );
        }
        expectThrow(
          () => index.register(manifest),
          /invalid dataset release/,
          `register(${mutation.name})`,
          failures,
        );
        invocations += 1;
        counters.mutated += 1;
        trace.push([mutation.name, problems]);
      } else {
        const problems = validateDatasetReleaseManifest(manifest);
        invocations += 1;
        if (problems.length > 0)
          failures.push(`generator produced an invalid release: ${problems.join("; ")}`);
        index.register(manifest);
        invocations += 1;
        valid.push(manifest);
        counters.valid += 1;
        trace.push(["valid", manifest.releaseId]);
      }
    }
    // Re-registering a valid release (or its version under another datasetId) must throw.
    if (valid.length > 0) {
      const dup = rng.pick(valid);
      expectThrow(
        () => index.register(dup),
        /duplicate dataset release/,
        "register duplicate",
        failures,
      );
      invocations += 1;
      if (rng.bool(0.5)) {
        const collision: DatasetReleaseManifest = {
          ...dup,
          datasetId: "other-ds",
          releaseId: `other-ds@${dup.version}`,
        };
        expectThrow(
          () => index.register(collision),
          /duplicate dataset release/,
          "register version collision",
          failures,
        );
        invocations += 1;
        counters.versionCollisions += 1;
      }
    }
    const legacyCount = rng.int(3);
    const legacy: string[] = [];
    for (let l = 0; l < legacyCount; l += 1) {
      const version = `legacy-v0.${l}-${seed % 97}`;
      index.registerLegacy(version);
      invocations += 1;
      legacy.push(version);
      if (index.byVersion(version) !== null) failures.push("legacy release returned a manifest");
      abstentions += 1;
    }
    const registeredKey = legacy[0] ?? valid[0]?.version;
    if (registeredKey !== undefined) {
      expectThrow(
        () => index.registerLegacy(registeredKey),
        /duplicate dataset release/,
        "registerLegacy duplicate",
        failures,
      );
      invocations += 1;
    }
    if (index.versions().length !== valid.length * 2 + legacy.length)
      failures.push("versions() count mismatch");

    for (const manifest of valid) {
      if (index.byVersion(manifest.version) !== manifest) failures.push("byVersion(version) miss");
      if (index.byVersion(manifest.releaseId) !== manifest)
        failures.push("byVersion(releaseId) miss");
      if (!index.has(manifest.version) || !index.has(manifest.releaseId))
        failures.push("has() miss");
      invocations += 4;
    }
    if (index.byVersion(`missing-${seed}`) !== null)
      failures.push("byVersion returned for unknown");
    abstentions += 1;
    invocations += 1;

    // Lineage audit with a known number of dangling pointers.
    const knownVersions = [...valid.flatMap((m) => [m.version, m.releaseId]), ...legacy];
    const auditEntries: ModelManifestEntry[] = [];
    let expectedProblems = 0;
    const auditCount = 3 + rng.int(4);
    for (let i = 0; i < auditCount; i += 1) {
      const base = rng.pick(DEFAULT_MODEL_MANIFEST.entries);
      const pointer = (): string | null => {
        const roll = rng.int(3);
        if (roll === 0) return null;
        if (roll === 1 && knownVersions.length > 0) return rng.pick(knownVersions);
        expectedProblems += 1;
        return `dangling-${rng.hex(4)}`;
      };
      auditEntries.push({
        ...base,
        id: `audit.${i}`,
        trainingDatasetVersion: pointer(),
        evaluationDatasetVersion: pointer(),
        splits: null,
        metrics: null,
      });
    }
    const problems = auditModelDatasetLineage({ schemaVersion: 1, entries: auditEntries }, index);
    invocations += 1;
    if (problems.length !== expectedProblems)
      failures.push(`audit reported ${problems.length} problems, expected ${expectedProblems}`);
    trace.push(problems);

    return {
      digest: fnv1a(JSON.stringify(trace)),
      failures,
      abstentions,
      invocations,
      numericOutputs: [],
      counters: { ...counters },
    };
  },
};

// ---------------------------------------------------------------------------
// Scenario 4 — fromJson structural fuzz: malformed remote-manifest shapes.
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const FUZZ_VALUES: readonly Json[] = [
  null,
  0,
  1,
  -1,
  1.5,
  "",
  "x",
  true,
  false,
  [],
  {},
  ["ios"],
  "latest",
];

/** Fresh copy every time — mutations below must never touch the shared table. */
const fuzzValue = (rng: Rng): Json => structuredClone(rng.pick(FUZZ_VALUES));

export const fromJsonFuzz: Scenario = {
  name: "from-json-fuzz",
  retainsStateAcrossIterations: false,
  run(seed) {
    const rng = makeRng(seed);
    const failures: string[] = [];
    const counters = { accepted: 0, validationError: 0, typeError: 0, acceptedWithUnknownEnum: 0 };
    const manifest = JSON.parse(JSON.stringify(DEFAULT_MODEL_MANIFEST)) as {
      schemaVersion: Json;
      entries: Json;
    };
    const mutationCount = 1 + rng.int(3);
    const applied: string[] = [];
    for (let m = 0; m < mutationCount; m += 1) {
      const roll = rng.int(10);
      if (roll === 0) {
        manifest.schemaVersion = fuzzValue(rng);
        applied.push("schemaVersion");
      } else if (roll === 1) {
        manifest.entries = fuzzValue(rng);
        applied.push("entries");
      } else if (roll === 2 && Array.isArray(manifest.entries)) {
        manifest.entries.push(fuzzValue(rng));
        applied.push("entries.push");
      } else if (Array.isArray(manifest.entries) && manifest.entries.length > 0) {
        const entry = manifest.entries[rng.int(manifest.entries.length)];
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
          const keys = Object.keys(entry);
          const key = rng.pick(keys);
          const how = rng.int(3);
          if (how === 0) delete entry[key];
          else if (how === 1) entry[key] = fuzzValue(rng);
          else entry[key] = `unknown-${rng.hex(4)}`;
          applied.push(`${key}:${how}`);
        }
      }
    }
    const text = JSON.stringify(manifest);
    let outcome: string;
    let registry: ModelRegistry | null = null;
    try {
      registry = ModelRegistry.fromJson(text);
      outcome = "accepted";
      counters.accepted += 1;
    } catch (error) {
      if (error instanceof TypeError) {
        outcome = `typeError:${error.message}`;
        counters.typeError += 1;
      } else if (error instanceof Error) {
        outcome = `validationError:${error.message}`;
        counters.validationError += 1;
      } else {
        outcome = "unknownThrow";
        failures.push(`fromJson threw a non-Error: ${String(error)}`);
      }
    }
    let invocations = 1;
    let abstentions = 0;
    if (registry !== null) {
      // An accepted manifest must be queryable without throwing.
      for (const task of MODEL_TASKS) {
        for (const platform of PLATFORMS) {
          try {
            const got = registry.resolve({ task, platform });
            invocations += 1;
            if (got === null) abstentions += 1;
          } catch (error) {
            failures.push(
              `resolve threw after fromJson accepted: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
      const unknownEnum = registry
        .list()
        .some(
          (e) =>
            !(MODEL_TASKS as readonly string[]).includes(e.task) ||
            !(MODEL_RUNTIMES as readonly string[]).includes(e.runtime) ||
            !(EXECUTION_TARGETS as readonly string[]).includes(e.executionTarget) ||
            !Array.isArray(e.supportedPlatforms) ||
            e.supportedPlatforms.some((p) => !(PLATFORMS as readonly string[]).includes(p)) ||
            typeof e.id !== "string" ||
            typeof e.notes !== "string",
        );
      if (unknownEnum) counters.acceptedWithUnknownEnum += 1;
    }
    return {
      digest: fnv1a(JSON.stringify([applied, outcome, abstentions, failures.length])),
      failures,
      abstentions,
      invocations,
      numericOutputs: [],
      counters: { ...counters },
    };
  },
};

// ---------------------------------------------------------------------------
// Campaign runner — heap/handles/listeners every N iterations, time drift,
// determinism replay, JSON table of seed → outcome.
// ---------------------------------------------------------------------------

export interface HeapSample {
  iteration: number;
  heapUsed: number;
  heapTotal: number;
  rss: number;
  external: number;
  arrayBuffers: number;
  activeResources: Record<string, number>;
  timers: number;
  processListeners: number;
  retainedUnits: number | null;
}

export interface SeedRow {
  index: number;
  seed: number;
  digest: string;
  ms: number;
  abstentions: number;
  invocations: number;
  failures: string[];
  counters: Record<string, number>;
}

export interface CampaignResult {
  scenario: string;
  campaignSeed: number;
  iterations: number;
  iterationsExecuted: number;
  replaysExecuted: number;
  sampleEvery: number;
  warmup: number;
  gcAvailable: boolean;
  retainsStateAcrossIterations: boolean;
  baseline: { activeResources: Record<string, number>; timers: number; processListeners: number };
  final: { activeResources: Record<string, number>; timers: number; processListeners: number };
  handlesReturnedToBaseline: boolean;
  samples: HeapSample[];
  heap: {
    firstHeapUsed: number;
    lastHeapUsed: number;
    deltaPct: number;
    slopeBytesPerIteration: number;
    slopePctPer100: number;
    maxHeapUsed: number;
    retainedBytesPerUnit: number | null;
  };
  timing: {
    earlyMedianMs: number;
    lateMedianMs: number;
    driftRatio: number;
    meanMs: number;
    p99Ms: number;
    totalMs: number;
  };
  totals: {
    invocations: number;
    abstentions: number;
    nonFiniteOutputs: number;
    counters: Record<string, number>;
  };
  failures: Array<{ index: number; seed: number; failure: string }>;
  determinism: {
    replayed: number;
    mismatches: Array<{ index: number; seed: number; first: string; second: string }>;
  };
  rows: SeedRow[];
}

export interface CampaignOptions {
  iterations: number;
  campaignSeed: number;
  sampleEvery?: number;
  warmup?: number;
  /** Replay every seed and compare digests (1 = all, 0 = none, n = every nth). */
  replayEvery?: number;
}

type GcFn = () => void;

/** --expose-gc's global when present; otherwise the documented v8-flag route. */
export function acquireGc(): GcFn | null {
  const existing = (globalThis as { gc?: GcFn }).gc;
  if (typeof existing === "function") return existing;
  try {
    v8.setFlagsFromString("--expose-gc");
    const fromContext = vm.runInNewContext("gc") as unknown;
    return typeof fromContext === "function" ? (fromContext as GcFn) : null;
  } catch {
    return null;
  }
}

function activeResourceCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of process.getActiveResourcesInfo()) counts[name] = (counts[name] ?? 0) + 1;
  return counts;
}

function processListenerCount(): number {
  let total = 0;
  for (const name of process.eventNames()) total += process.listenerCount(name);
  return total;
}

function timerCount(counts: Record<string, number>): number {
  return (counts["Timeout"] ?? 0) + (counts["Immediate"] ?? 0);
}

function sameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) if ((a[key] ?? 0) !== (b[key] ?? 0)) return false;
  return true;
}

function median(values: number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Least-squares slope of y over x. */
function slope(points: Array<[number, number]>): number {
  if (points.length < 2) return 0;
  const n = points.length;
  const meanX = points.reduce((s, [x]) => s + x, 0) / n;
  const meanY = points.reduce((s, [, y]) => s + y, 0) / n;
  let num = 0;
  let den = 0;
  for (const [x, y] of points) {
    num += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function snapshot(gc: GcFn | null, iteration: number, scenario: Scenario): HeapSample {
  if (gc) {
    gc();
    gc();
  }
  const mem = process.memoryUsage();
  const activeResources = activeResourceCounts();
  return {
    iteration,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    rss: mem.rss,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers,
    activeResources,
    timers: timerCount(activeResources),
    processListeners: processListenerCount(),
    retainedUnits: scenario.retainedUnits ? scenario.retainedUnits() : null,
  };
}

export function runCampaign(scenario: Scenario, options: CampaignOptions): CampaignResult {
  const sampleEvery = options.sampleEvery ?? 50;
  const warmup = options.warmup ?? Math.min(sampleEvery, Math.floor(options.iterations / 10));
  const replayEvery = options.replayEvery ?? 1;
  const gc = acquireGc();

  const baselineSample = snapshot(gc, 0, scenario);
  const baseline = {
    activeResources: baselineSample.activeResources,
    timers: baselineSample.timers,
    processListeners: baselineSample.processListeners,
  };

  const rows: SeedRow[] = [];
  const samples: HeapSample[] = [];
  const failures: CampaignResult["failures"] = [];
  const totals = {
    invocations: 0,
    abstentions: 0,
    nonFiniteOutputs: 0,
    counters: {} as Record<string, number>,
  };
  const durations: number[] = [];
  const startedAt = performance.now();
  let iterationsExecuted = 0;

  for (let index = 0; index < options.iterations; index += 1) {
    const seed = iterationSeed(options.campaignSeed, scenario.name, index);
    const t0 = performance.now();
    const outcome = scenario.run(seed);
    const ms = performance.now() - t0;
    iterationsExecuted += 1;
    durations.push(ms);
    totals.invocations += outcome.invocations;
    totals.abstentions += outcome.abstentions;
    for (const value of outcome.numericOutputs)
      if (!Number.isFinite(value)) totals.nonFiniteOutputs += 1;
    for (const [key, value] of Object.entries(outcome.counters))
      totals.counters[key] = (totals.counters[key] ?? 0) + value;
    for (const failure of outcome.failures) failures.push({ index, seed, failure });
    rows.push({
      index,
      seed,
      digest: outcome.digest,
      ms,
      abstentions: outcome.abstentions,
      invocations: outcome.invocations,
      failures: outcome.failures,
      counters: outcome.counters,
    });
    const done = index + 1;
    if (
      done === warmup ||
      (done > warmup && (done - warmup) % sampleEvery === 0) ||
      done === options.iterations
    ) {
      samples.push(snapshot(gc, done, scenario));
    }
  }
  const totalMs = performance.now() - startedAt;

  // Determinism replay.
  const mismatches: CampaignResult["determinism"]["mismatches"] = [];
  let replaysExecuted = 0;
  if (replayEvery > 0) {
    for (const row of rows) {
      if (row.index % replayEvery !== 0) continue;
      const again = scenario.run(row.seed);
      replaysExecuted += 1;
      if (again.digest !== row.digest)
        mismatches.push({
          index: row.index,
          seed: row.seed,
          first: row.digest,
          second: again.digest,
        });
    }
  }

  const finalSample = snapshot(gc, options.iterations, scenario);
  const final = {
    activeResources: finalSample.activeResources,
    timers: finalSample.timers,
    processListeners: finalSample.processListeners,
  };

  // Heap trend over post-warmup samples (the warmup sample is the anchor).
  const trend = samples.filter((s) => s.iteration >= warmup);
  const first = trend[0] ?? finalSample;
  const last = trend[trend.length - 1] ?? finalSample;
  const slopeBytesPerIteration = slope(trend.map((s) => [s.iteration, s.heapUsed]));
  const slopePctPer100 =
    first.heapUsed === 0 ? 0 : ((slopeBytesPerIteration * 100) / first.heapUsed) * 100;
  const retainedBytesPerUnit =
    scenario.retainsStateAcrossIterations &&
    first.retainedUnits !== null &&
    last.retainedUnits !== null &&
    last.retainedUnits > first.retainedUnits
      ? (last.heapUsed - first.heapUsed) / (last.retainedUnits - first.retainedUnits)
      : null;

  const window = Math.max(10, Math.floor((options.iterations - warmup) / 5));
  const post = durations.slice(warmup);
  const early = post.slice(0, window);
  const late = post.slice(-window);
  const earlyMedianMs = median(early);
  const lateMedianMs = median(late);

  return {
    scenario: scenario.name,
    campaignSeed: options.campaignSeed,
    iterations: options.iterations,
    iterationsExecuted,
    replaysExecuted,
    sampleEvery,
    warmup,
    gcAvailable: gc !== null,
    retainsStateAcrossIterations: scenario.retainsStateAcrossIterations,
    baseline,
    final,
    handlesReturnedToBaseline:
      sameCounts(baseline.activeResources, final.activeResources) &&
      baseline.timers === final.timers &&
      baseline.processListeners === final.processListeners,
    samples,
    heap: {
      firstHeapUsed: first.heapUsed,
      lastHeapUsed: last.heapUsed,
      deltaPct:
        first.heapUsed === 0 ? 0 : ((last.heapUsed - first.heapUsed) / first.heapUsed) * 100,
      slopeBytesPerIteration,
      slopePctPer100,
      maxHeapUsed: Math.max(...samples.map((s) => s.heapUsed)),
      retainedBytesPerUnit,
    },
    timing: {
      earlyMedianMs,
      lateMedianMs,
      driftRatio: earlyMedianMs > 0 ? lateMedianMs / earlyMedianMs : Number.NaN,
      meanMs: durations.reduce((s, d) => s + d, 0) / Math.max(1, durations.length),
      p99Ms: percentile(durations, 0.99),
      totalMs,
    },
    totals,
    failures,
    determinism: { replayed: replaysExecuted, mismatches },
    rows,
  };
}

/**
 * Control: touches nothing in the unit. Its heap slope is the harness's own
 * per-iteration retention (the seed → outcome row kept for the JSON table),
 * so a unit scenario's slope minus this is the unit's contribution.
 */
export const harnessControl: Scenario = {
  name: "harness-control",
  retainsStateAcrossIterations: false,
  run(seed) {
    const rng = makeRng(seed);
    const draws = 20 + rng.int(41);
    const values: number[] = [];
    for (let i = 0; i < draws; i += 1) values.push(rng.next());
    return {
      digest: fnv1a(JSON.stringify(values)),
      failures: [],
      abstentions: 0,
      invocations: 0,
      numericOutputs: values,
      counters: { draws },
    };
  },
};

export const ALL_SCENARIOS = (): Scenario[] => [
  registryLifecycle,
  releaseStateLifecycle,
  datasetReleaseIndex,
  fromJsonFuzz,
  makeLongLivedReleaseState(),
];
