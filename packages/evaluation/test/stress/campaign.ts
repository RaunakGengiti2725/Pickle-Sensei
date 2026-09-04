import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import {
  assignSplits,
  calibrationReport,
  classificationReport,
  compareSummaries,
  flattenBenchMetrics,
  formatCompareReport,
  meanAbsoluteError,
  pearsonCorrelation,
  spearmanCorrelation,
  timingReport,
  validateRealBenchmarkManifest,
  validateRegressionSummary,
  validateToleranceConfig,
  type BenchRecord,
  type CompareReport,
  type RegressionSummary,
  type ToleranceConfig,
} from "../../src/index.js";
import { main as cliMain } from "../../src/regression/cli.js";
import { REPO_ROOT } from "../../src/regression/benches.js";
import { assertValidRunId, runRegression } from "../../src/regression/run.js";
import { bench as fixtureBench, summary as fixtureSummary } from "../regressionFixtures.js";
import {
  allPlainObjects,
  deepEqual,
  errorSummary,
  findNonFinite,
  looksLikeStackTrace,
  prototypesUnchanged,
  restorePrototypes,
  snapshotPrototypes,
  typedFailure,
} from "./oracles.js";
import {
  EDGE_NUMBERS_FINITE,
  EDGE_NUMBERS_NON_FINITE,
  EDGE_NUMBER_TOKENS,
  PATH_TRAVERSAL_STRINGS,
  PROTO_KEYS,
  UNICODE_NORMALIZATION_PAIRS,
  cloneJsonish,
  deepNestedArray,
  deepNestedObject,
  deleteAt,
  describeValue,
  edgeString,
  enumeratePaths,
  getAt,
  setAt,
  wrongTypeValue,
  type JsonPath,
} from "./payloads.js";
import { Prng } from "./prng.js";

/**
 * Boundary / malformed-input stress campaign over the evaluation package's
 * input surfaces: the summary / tolerance / manifest validators, the
 * comparator, the `bench:compare` CLI, run-id validation, and the pure metric
 * functions. One seed → one fully replayable iteration.
 *
 * Verdicts: HELD (graceful typed rejection or a sound acceptance) or BROKEN
 * (escaped exception, silent alteration, non-finite output, prototype
 * pollution, unsafe acceptance). BROKEN records carry a `brokenClass`; the
 * classes listed in KNOWN_BROKEN are documented findings, anything else is
 * `UNEXPECTED:*` and fails the campaign test.
 */

export const SURFACES = [
  "summary",
  "tolerances",
  "manifest",
  "compare_pairs",
  "cli",
  "run_id",
  "metrics",
] as const;
export type Surface = (typeof SURFACES)[number];
const SURFACE_WEIGHTS: Record<Surface, number> = {
  summary: 28,
  tolerances: 12,
  manifest: 12,
  compare_pairs: 10,
  cli: 18,
  run_id: 8,
  metrics: 12,
};

export const KNOWN_BROKEN = {
  F1_PROTO_KEY_SILENTLY_DROPPED:
    'validateMetrics/validateStringRecord/validateToleranceConfig assign through `obj["__proto__"]` so an own `__proto__` key is silently dropped (or re-prototypes the record) instead of being rejected',
  F2_COMPARE_DELTA_NON_FINITE:
    "compareMetric computes candidate - baseline without an overflow guard; two finite metrics yield delta ±Infinity (serialised as null by --json)",
  F3_CLASSIFICATION_PROTOTYPE_POLLUTION:
    "classificationReport indexes confusion[truth][predicted] on plain objects; inherited-key labels (`__proto__`, `toString`, `constructor`, ...) write counters onto Object.prototype / its shared methods and yield NaN recall",
  F4_MANIFEST_UNSANITIZED_PASSTHROUGH:
    "validateRealBenchmarkManifest returns the raw input object; `version`/`createdAtIso` are never checked and unknown/own-__proto__ keys pass through",
  F5_METRIC_MATH_NON_FINITE_OUTPUT:
    "timingReport/meanAbsoluteError/pearsonCorrelation/spearmanCorrelation return NaN/±Infinity for finite-but-extreme or non-finite inputs (no guard, unlike calibrationReport)",
  F6_CALIBRATION_BIN_COUNT_UNTYPED_THROW:
    "calibrationReport with binCount <= 0, fractional, NaN or Infinity throws TypeError/RangeError instead of a typed error",
  F7_VALIDATOR_RANGE_ERROR_ON_DEEP_ARRAY:
    "validators interpolate `String(value)` into error messages; a deeply nested array value makes Array.prototype.toString overflow the stack, escaping the Result contract with RangeError",
} as const;
export type KnownBrokenClass = keyof typeof KNOWN_BROKEN;

export type Expectation = "accept" | "reject" | "either" | "typed_error";
export type Verdict = "HELD" | "BROKEN";

export interface IterationRecord {
  seed: number;
  surface: Surface;
  op: string;
  path: string;
  payload: string;
  expectation: Expectation;
  outcome: string;
  detail: string;
  verdict: Verdict;
  brokenClass: string | null;
  durationMs: number;
}

export interface CampaignOptions {
  seedBase: number;
  iterations: number;
  /** Scratch directory for CLI file payloads (created + emptied by the campaign). */
  scratchDir: string;
  /** Re-run every seed and compare fingerprints (determinism). */
  replay?: boolean;
  /** Also exercise `runRegression` with unsafe run ids (throws before any I/O). */
  includeRunnerRejections?: boolean;
}

export interface CampaignResult {
  meta: {
    seedBase: number;
    iterations: number;
    executed: number;
    replayed: number;
    nondeterministic: number[];
    held: number;
    broken: number;
    brokenBySeed: Record<string, string>;
    brokenClasses: Record<string, number>;
    unexpected: number[];
    surfaces: Record<string, number>;
    ops: Record<string, number>;
    durationMs: number;
    node: string;
  };
  records: IterationRecord[];
}

export function fingerprint(record: IterationRecord): string {
  return [
    record.seed,
    record.surface,
    record.op,
    record.path,
    record.payload,
    record.expectation,
    record.outcome,
    record.detail,
    record.verdict,
    record.brokenClass ?? "",
  ].join("\u001f");
}

let committedTolerances: ToleranceConfig | null = null;
export function loadCommittedTolerances(): ToleranceConfig {
  if (committedTolerances) return committedTolerances;
  const path = join(REPO_ROOT, "packages/evaluation/regression.tolerances.json");
  const validated = validateToleranceConfig(JSON.parse(readFileSync(path, "utf8")));
  if (!validated.ok) throw new Error(`committed tolerances invalid: ${validated.failure.message}`);
  committedTolerances = validated.value;
  return validated.value;
}

// ---------------------------------------------------------------------------
// Seeded synthetic documents (shapes come from the committed fixtures; values
// are seeded — no labels or measurements are fabricated as evidence).
// ---------------------------------------------------------------------------

const BENCH_IDS = [
  "contact_replay",
  "coach_gates",
  "event_recall",
  "stroke_heuristic",
  "phase_timing",
];
const METRIC_NAMES = [
  "target_events",
  "estimated",
  "median_error_ms",
  "p90_error_ms",
  "recall",
  "abstained",
];
const HEX = "0123456789abcdef";

export function hexString(rng: Prng, length: number): string {
  let out = "";
  for (let index = 0; index < length; index += 1) out += HEX[rng.int(0, 15)];
  return out;
}

function finiteMetricValue(rng: Prng): number {
  const roll = rng.int(0, 9);
  if (roll < 6) return rng.int(0, 200);
  if (roll < 8) return Math.round(rng.float() * 10000) / 100;
  return rng.pick(EDGE_NUMBERS_FINITE);
}

export function randomBench(rng: Prng, id: string): BenchRecord {
  const kind = rng.bool(0.6) ? "in_process" : "subprocess";
  const metrics: Record<string, number | null> = {};
  const count = rng.int(0, 5);
  for (const name of rng.shuffle(METRIC_NAMES).slice(0, count)) {
    // null = bounded abstention ("not measurable"), never a fabricated number.
    metrics[name] = rng.bool(0.2) ? null : finiteMetricValue(rng);
  }
  return fixtureBench({
    id,
    kind,
    exitCode: kind === "subprocess" ? rng.int(0, 1) : null,
    wallClockMs: rng.int(0, 100000),
    metrics,
    labels: rng.bool(0.5) ? { estimatorVersion: `v${rng.int(1, 9)}.${rng.int(0, 9)}` } : {},
  });
}

export function randomSummary(rng: Prng): RegressionSummary {
  const ids = rng.shuffle(BENCH_IDS).slice(0, rng.int(1, 3));
  const benches = ids.map((id) => randomBench(rng, id));
  return fixtureSummary(
    {
      runId: `stress-${rng.int(0, 0xffffff).toString(16)}`,
      totalWallClockMs: rng.int(0, 10_000_000),
      caveats: rng.bool(0.3) ? [] : ["proxy evidence"],
    },
    benches,
  );
}

export interface ManifestDoc {
  schemaVersion: 1;
  id: string;
  version: string;
  createdAtIso: string;
  provenance: string;
  splitRatios: { train: number; val: number; test: number };
  cases: Array<{
    caseId: string;
    videoSha256: string;
    poseSequenceSha256: string;
    playerId: string;
    declaredStroke: string;
    annotationPath: string;
  }>;
}

export function randomManifest(rng: Prng): ManifestDoc {
  const count = rng.int(0, 4);
  const cases: ManifestDoc["cases"] = [];
  for (let index = 0; index < count; index += 1) {
    cases.push({
      caseId: `case-${index}`,
      videoSha256: hexString(rng, 64),
      poseSequenceSha256: hexString(rng, 64),
      playerId: `player-${rng.int(0, 3)}`,
      declaredStroke: rng.pick(["forehand_drive", "dink", "serve"]),
      annotationPath: `annotations/case-${index}.json`,
    });
  }
  const train = rng.pick([0.7, 0.6, 1, 0]);
  const val = train === 1 ? 0 : rng.pick([0.15, 0.2, 0]);
  return {
    schemaVersion: 1,
    id: `pickle-real-v${rng.int(1, 3)}`,
    version: `${rng.int(1, 3)}.0.0`,
    createdAtIso: "2026-08-27T00:00:00.000Z",
    provenance: rng.pick(["consented_first_party", "commissioned", "licensed"]),
    splitRatios: { train, val, test: Math.round((1 - train - val) * 1e6) / 1e6 },
    cases,
  };
}

export function randomToleranceDoc(rng: Prng): Record<string, unknown> {
  const committed = loadCommittedTolerances();
  const keys = rng.shuffle(Object.keys(committed.metrics)).slice(0, rng.int(1, 4));
  const metrics: Record<string, unknown> = {};
  for (const key of keys) metrics[key] = { ...committed.metrics[key]! };
  return {
    configVersion: 1,
    contract: "pickle-sensei-linux-regression",
    contractVersion: 1,
    unlistedMetricPolicy: rng.pick(["fail", "informational"]),
    lostMeasurementIsRegression: rng.bool(),
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Generic document mutation
// ---------------------------------------------------------------------------

const GENERIC_OPS = [
  "control",
  "type_swap",
  "number_non_finite",
  "number_finite_edge",
  "string_edge",
  "delete_key",
  "add_unknown_key",
  "proto_key",
  "empty_container",
  "future_version",
  "wrap_root",
  "deep_array",
  "deep_object",
] as const;
type GenericOp = (typeof GENERIC_OPS)[number];

interface Mutation {
  op: string;
  path: JsonPath;
  doc: unknown;
  payload: string;
  /** What the schema, by construction, must do with this document. */
  expectation: Expectation;
}

function pathToString(path: JsonPath): string {
  return path.length === 0 ? "$" : `$.${path.map(String).join(".")}`;
}

function pathsOfType(
  doc: unknown,
  predicate: (value: unknown, path: JsonPath) => boolean,
): JsonPath[] {
  return enumeratePaths(doc).filter((path) => predicate(getAt(doc, path), path));
}

/** Record-typed fields whose keys are caller-defined (validateStringRecord / validateMetrics / tolerance metrics). */
const OPEN_RECORD_KEYS = new Set(["labels", "metrics", "modelVersions"]);

function isOpenRecordPath(path: JsonPath): boolean {
  const last = path[path.length - 1];
  return typeof last === "string" && OPEN_RECORD_KEYS.has(last);
}

function mutateGeneric(
  rng: Prng,
  base: unknown,
  op: GenericOp,
  policy: {
    closed: boolean;
    versionPaths: JsonPath[];
    /** A value the open record at `parentKey` would accept (so a hostile KEY, not the value, is under test). */
    openRecordLeaf?: (rng: Prng, parentKey: string) => unknown;
  },
): Mutation {
  const doc = cloneJsonish(base);
  const anyPath = (): JsonPath => rng.pick(enumeratePaths(doc));
  switch (op) {
    case "control":
      return { op, path: [], doc, payload: "unmodified seeded document", expectation: "accept" };
    case "type_swap": {
      const path = rng.pick(enumeratePaths(doc).filter((candidate) => candidate.length > 0));
      const current = getAt(doc, path);
      const value = wrongTypeValue(rng, current);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: "either",
      };
    }
    case "number_non_finite": {
      const numbers = pathsOfType(doc, (value) => typeof value === "number");
      const path = numbers.length > 0 ? rng.pick(numbers) : anyPath();
      const value = rng.pick(EDGE_NUMBERS_NON_FINITE);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: "reject",
      };
    }
    case "number_finite_edge": {
      const numbers = pathsOfType(doc, (value) => typeof value === "number");
      const path = numbers.length > 0 ? rng.pick(numbers) : anyPath();
      const value = rng.pick(EDGE_NUMBERS_FINITE);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: "either",
      };
    }
    case "string_edge": {
      const strings = pathsOfType(doc, (value) => typeof value === "string");
      const path = strings.length > 0 ? rng.pick(strings) : anyPath();
      const value = edgeString(rng);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: "either",
      };
    }
    case "delete_key": {
      const keys = enumeratePaths(doc).filter((candidate) => candidate.length > 0);
      const path = rng.pick(keys);
      return {
        op,
        path,
        doc: deleteAt(doc, path),
        payload: "deleted",
        expectation:
          policy.closed &&
          typeof path[path.length - 1] === "string" &&
          !isOpenRecordPath(path.slice(0, -1))
            ? "reject"
            : "either",
      };
    }
    case "add_unknown_key": {
      const objects = pathsOfType(
        doc,
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      );
      const parent = rng.pick(objects);
      const key = `zz_unknown_${rng.int(0, 999)}`;
      const value = rng.bool()
        ? edgeString(rng)
        : rng.pick([...EDGE_NUMBERS_FINITE, null, true, {}, []]);
      const path = [...parent, key];
      const closed = policy.closed && !isOpenRecordPath(parent);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: closed ? "reject" : "either",
      };
    }
    case "proto_key": {
      const objects = pathsOfType(
        doc,
        (value) => typeof value === "object" && value !== null && !Array.isArray(value),
      );
      const parent = rng.pick(objects);
      const key = rng.pick(PROTO_KEYS);
      const parentKey = parent[parent.length - 1];
      const value =
        typeof parentKey === "string" &&
        OPEN_RECORD_KEYS.has(parentKey) &&
        policy.openRecordLeaf &&
        rng.bool()
          ? policy.openRecordLeaf(rng, parentKey)
          : rng.pick<unknown>([
              null,
              1,
              "polluted",
              { polluted: true },
              [],
              { direction: "informational", absoluteTolerance: 0, rationale: "x" },
            ]);
      const path = [...parent, key];
      const closed = policy.closed && !isOpenRecordPath(parent);
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: closed ? "reject" : "either",
      };
    }
    case "empty_container": {
      const containers = pathsOfType(
        doc,
        (value, path) => path.length > 0 && typeof value === "object" && value !== null,
      );
      const path = containers.length > 0 ? rng.pick(containers) : anyPath();
      const value = Array.isArray(getAt(doc, path)) ? [] : {};
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: "either",
      };
    }
    case "future_version": {
      const path = rng.pick(policy.versionPaths);
      const value = rng.pick<unknown>([2, 999, "1", 1.5, -1, 0, 2 ** 53, "2", null, 1e21, true]);
      const key = String(path[path.length - 1]);
      const strict = key !== "contractVersion";
      const positiveInt = typeof value === "number" && Number.isInteger(value) && value >= 1;
      return {
        op,
        path,
        doc: setAt(doc, path, value),
        payload: describeValue(value),
        expectation: strict || !positiveInt ? "reject" : "either",
      };
    }
    case "wrap_root": {
      const value = rng.pick<unknown>([[], [doc], "summary", 42, null, true, undefined, () => doc]);
      return { op, path: [], doc: value, payload: describeValue(value), expectation: "reject" };
    }
    case "deep_array": {
      const path = rng.pick(enumeratePaths(doc).filter((p) => p.length > 0));
      const depth = rng.pick([64, 1024, 5000, 20000, 50000]);
      return {
        op,
        path,
        doc: setAt(doc, path, deepNestedArray(depth)),
        payload: `nested array depth ${depth}`,
        expectation: "either",
      };
    }
    case "deep_object": {
      const path = rng.pick(enumeratePaths(doc).filter((p) => p.length > 0));
      const depth = rng.pick([64, 1024, 5000, 20000]);
      return {
        op,
        path,
        doc: setAt(doc, path, deepNestedObject(depth)),
        payload: `nested object depth ${depth}`,
        expectation: "either",
      };
    }
    default: {
      const exhaustive: never = op;
      throw new Error(`unhandled op ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

interface Judgement {
  outcome: string;
  detail: string;
  verdict: Verdict;
  brokenClass: string | null;
}

function held(outcome: string, detail = ""): Judgement {
  return { outcome, detail, verdict: "HELD", brokenClass: null };
}

function broken(
  outcome: string,
  brokenClass: KnownBrokenClass | `UNEXPECTED:${string}`,
  detail: string,
): Judgement {
  return { outcome, detail, verdict: "BROKEN", brokenClass };
}

function classifyThrow(error: unknown, op: string): Judgement {
  const summary = errorSummary(error);
  if (error instanceof RangeError && (op === "deep_array" || op === "deep_object")) {
    return broken("threw", "F7_VALIDATOR_RANGE_ERROR_ON_DEEP_ARRAY", summary);
  }
  return broken("threw", "UNEXPECTED:validator_threw", summary);
}

/** Every comparator report must be finite, exhaustive and never coerce a null (abstention) into a number. */
function checkCompareReport(report: CompareReport): string | null {
  if (![0, 1, 3].includes(report.exitCode)) return `exitCode ${report.exitCode}`;
  const nonFinite = findNonFinite(report);
  if (nonFinite) return `non-finite ${nonFinite}`;
  for (const metric of report.metrics) {
    const bothNumeric = typeof metric.baseline === "number" && typeof metric.candidate === "number";
    if (!bothNumeric && metric.delta !== null)
      return `${metric.metric}: delta ${metric.delta} with a null/missing side`;
    if (bothNumeric && metric.delta === null)
      return `${metric.metric}: delta null with numeric sides`;
    if (!bothNumeric) {
      const nullStatuses = [
        "measurement_lost",
        "newly_measured",
        "unmeasured_both",
        "missing_in_candidate",
        "missing_in_baseline",
      ];
      if (!nullStatuses.includes(metric.status))
        return `${metric.metric}: status ${metric.status} with a null/missing side`;
    }
  }
  const total = Object.values(report.counts).reduce((sum, n) => sum + n, 0);
  if (report.comparable && total !== report.metrics.length)
    return `counts ${total} != metrics ${report.metrics.length}`;
  return null;
}

function compareOracle(
  baseline: RegressionSummary,
  candidate: RegressionSummary,
): Judgement | null {
  const config = loadCommittedTolerances();
  let report: CompareReport;
  try {
    report = compareSummaries(baseline, candidate, config);
    formatCompareReport(baseline, candidate, report);
    JSON.stringify(report);
  } catch (error) {
    return broken("compare_threw", "UNEXPECTED:compare_threw", errorSummary(error));
  }
  const problem = checkCompareReport(report);
  if (problem) {
    if (problem.startsWith("non-finite") && problem.includes("delta")) {
      return broken("compare_non_finite", "F2_COMPARE_DELTA_NON_FINITE", problem);
    }
    return broken("compare_invalid", "UNEXPECTED:compare_report", problem);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

function summaryVersionPaths(): JsonPath[] {
  return [["schemaVersion"], ["contractVersion"]];
}

const SUMMARY_OPS = [
  ...GENERIC_OPS,
  "dup_bench",
  "metrics_mismatch",
  "bench_id_traversal",
  "run_id_traversal",
  "unicode_pair",
  "null_metrics",
] as const;

function summaryIteration(rng: Prng): { mutation: Mutation; judgement: Judgement } {
  const base = randomSummary(rng);
  const op = rng.pick(SUMMARY_OPS);
  let mutation: Mutation;
  if ((GENERIC_OPS as readonly string[]).includes(op)) {
    mutation = mutateGeneric(rng, base, op as GenericOp, {
      closed: true,
      versionPaths: summaryVersionPaths(),
      openRecordLeaf: (leafRng, parentKey) =>
        parentKey === "metrics" ? leafRng.int(0, 100) : `v${leafRng.int(0, 99)}`,
    });
  } else {
    const doc = cloneJsonish(base) as Record<string, unknown>;
    const benches = doc.benches as Array<Record<string, unknown>>;
    switch (op) {
      case "dup_bench": {
        const copy = cloneJsonish(benches[0]!);
        benches.push(copy as Record<string, unknown>);
        doc.metrics = flattenBenchMetrics(benches as unknown as BenchRecord[]);
        mutation = {
          op,
          path: ["benches", benches.length - 1],
          doc,
          payload: "duplicate of benches[0]",
          expectation: "reject",
        };
        break;
      }
      case "metrics_mismatch": {
        const flat = doc.metrics as Record<string, number | null>;
        const keys = Object.keys(flat);
        if (keys.length === 0) {
          flat["ghost.metric"] = 1;
          mutation = {
            op,
            path: ["metrics", "ghost.metric"],
            doc,
            payload: "1 (no such bench metric)",
            expectation: "reject",
          };
        } else {
          const key = rng.pick(keys);
          const current = flat[key];
          if (rng.bool()) {
            delete flat[key];
            mutation = {
              op,
              path: ["metrics", key],
              doc,
              payload: "deleted flattened metric",
              expectation: "reject",
            };
          } else {
            flat[key] = current === null ? 1 : current === 1 ? 2 : 1;
            mutation = {
              op,
              path: ["metrics", key],
              doc,
              payload: describeValue(flat[key]),
              expectation: "reject",
            };
          }
        }
        break;
      }
      case "bench_id_traversal": {
        const value = rng.pick([
          ...PATH_TRAVERSAL_STRINGS,
          "Contact",
          "9x",
          "a-b",
          "a b",
          "",
          "\u00e9",
          "a\u0000",
        ]);
        benches[0]!.id = value;
        doc.metrics = flattenBenchMetrics(benches as unknown as BenchRecord[]);
        mutation = {
          op,
          path: ["benches", 0, "id"],
          doc,
          payload: describeValue(value),
          expectation: "reject",
        };
        break;
      }
      case "run_id_traversal": {
        const value = rng.pick(PATH_TRAVERSAL_STRINGS);
        doc.runId = value;
        mutation = {
          op,
          path: ["runId"],
          doc,
          payload: describeValue(value),
          expectation: "either",
        };
        break;
      }
      case "unicode_pair": {
        const [nfc, nfd] = rng.pick(UNICODE_NORMALIZATION_PAIRS);
        const target = rng.pick(["labels", "modelVersions", "title", "runId", "gitBranch"]);
        const value = rng.bool() ? nfc : nfd;
        if (target === "labels") (benches[0]!.labels as Record<string, string>).normalized = value;
        else if (target === "modelVersions")
          (
            (doc.provenance as Record<string, unknown>).modelVersions as Record<string, string>
          ).contactEstimator = value;
        else if (target === "title") benches[0]!.title = value;
        else if (target === "runId") doc.runId = value;
        else (doc.provenance as Record<string, unknown>).gitBranch = value;
        mutation = {
          op,
          path: [target],
          doc,
          payload: `${describeValue(value)} (${value === nfc ? "NFC" : "NFD"})`,
          expectation: "accept",
        };
        break;
      }
      default: {
        // null_metrics: every metric abstains.
        for (const bench of benches) {
          const metrics = bench.metrics as Record<string, number | null>;
          for (const key of Object.keys(metrics)) metrics[key] = null;
        }
        doc.metrics = flattenBenchMetrics(benches as unknown as BenchRecord[]);
        mutation = {
          op,
          path: ["benches", "*", "metrics"],
          doc,
          payload: "all metrics null (abstained)",
          expectation: "accept",
        };
      }
    }
  }
  return { mutation, judgement: judgeValidator(mutation, base, "summary") };
}

function tolerancesIteration(rng: Prng): { mutation: Mutation; judgement: Judgement } {
  const base = randomToleranceDoc(rng);
  const op = rng.pick(GENERIC_OPS);
  const mutation = mutateGeneric(rng, base, op, {
    closed: false,
    versionPaths: [["configVersion"], ["contractVersion"]],
    openRecordLeaf: () => ({
      direction: "informational",
      absoluteTolerance: 0,
      rationale: "seeded",
    }),
  });
  return { mutation, judgement: judgeValidator(mutation, base, "tolerances") };
}

function manifestIteration(rng: Prng): { mutation: Mutation; judgement: Judgement } {
  const base = randomManifest(rng);
  const op = rng.pick(GENERIC_OPS);
  const mutation = mutateGeneric(rng, base, op, {
    closed: false,
    versionPaths: [["schemaVersion"]],
  });
  return { mutation, judgement: judgeValidator(mutation, base, "manifest") };
}

/** Independent structural check of the RealBenchmarkManifest interface. */
function conformsToManifestInterface(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "root not an object";
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "schemaVersion",
    "id",
    "version",
    "createdAtIso",
    "provenance",
    "splitRatios",
    "cases",
  ];
  const extra = Object.keys(record).filter((key) => !expectedKeys.includes(key));
  if (extra.length > 0) return `unknown keys pass through: ${extra.join(",")}`;
  if (record.schemaVersion !== 1) return "schemaVersion !== 1";
  if (typeof record.id !== "string" || record.id.length === 0) return "id";
  if (typeof record.version !== "string") return `version is ${describeValue(record.version)}`;
  if (typeof record.createdAtIso !== "string")
    return `createdAtIso is ${describeValue(record.createdAtIso)}`;
  if (!["consented_first_party", "commissioned", "licensed"].includes(String(record.provenance)))
    return "provenance";
  const ratios = record.splitRatios as Record<string, unknown> | null;
  if (!ratios || typeof ratios !== "object") return "splitRatios";
  for (const key of ["train", "val", "test"]) {
    const ratio = ratios[key];
    if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 0 || ratio > 1)
      return `splitRatios.${key}`;
  }
  if (!Array.isArray(record.cases)) return "cases";
  for (const [index, item] of record.cases.entries()) {
    if (typeof item !== "object" || item === null) return `cases[${index}]`;
    const c = item as Record<string, unknown>;
    for (const key of ["caseId", "playerId", "declaredStroke", "annotationPath"]) {
      if (typeof c[key] !== "string") return `cases[${index}].${key}`;
    }
    for (const key of ["videoSha256", "poseSequenceSha256"]) {
      if (typeof c[key] !== "string" || !/^[0-9a-f]{64}$/.test(c[key] as string))
        return `cases[${index}].${key}`;
    }
  }
  return null;
}

function judgeValidator(
  mutation: Mutation,
  base: unknown,
  kind: "summary" | "tolerances" | "manifest",
): Judgement {
  const input = mutation.doc;
  let result:
    | ReturnType<typeof validateRegressionSummary>
    | ReturnType<typeof validateToleranceConfig>
    | ReturnType<typeof validateRealBenchmarkManifest>;
  try {
    result =
      kind === "summary"
        ? validateRegressionSummary(input)
        : kind === "tolerances"
          ? validateToleranceConfig(input)
          : validateRealBenchmarkManifest(input);
  } catch (error) {
    return classifyThrow(error, mutation.op);
  }
  if (!result.ok) {
    const shape = typedFailure(result.failure);
    if (typeof shape === "string") return broken("rejected", "UNEXPECTED:untyped_failure", shape);
    if (mutation.expectation === "accept") {
      return broken(
        "rejected",
        "UNEXPECTED:control_rejected",
        `${shape.code}: ${shape.message.slice(0, 160)}`,
      );
    }
    return held("rejected", `${shape.code}: ${shape.message.slice(0, 120)}`);
  }
  // Accepted.
  const value: unknown = result.value;
  if (mutation.expectation === "reject") {
    if (mutation.op === "proto_key") {
      return broken(
        "accepted",
        "F1_PROTO_KEY_SILENTLY_DROPPED",
        `accepted ${pathToString(mutation.path)}=${mutation.payload}`,
      );
    }
    return broken(
      "accepted",
      "UNEXPECTED:accepted_invalid",
      `accepted ${pathToString(mutation.path)}=${mutation.payload}`,
    );
  }
  const nonFinite = findNonFinite(value);
  if (nonFinite) return broken("accepted", "UNEXPECTED:non_finite_in_value", nonFinite);
  const plain = allPlainObjects(value);
  if (plain) {
    return broken(
      "accepted",
      mutation.op === "proto_key" ? "F1_PROTO_KEY_SILENTLY_DROPPED" : "UNEXPECTED:non_plain_object",
      plain,
    );
  }
  if (kind === "summary") {
    const diff = deepEqual(input, value);
    if (diff) {
      return broken(
        "accepted",
        mutation.op === "proto_key"
          ? "F1_PROTO_KEY_SILENTLY_DROPPED"
          : "UNEXPECTED:accepted_altered",
        diff,
      );
    }
    const accepted = value as RegressionSummary;
    const compared =
      compareOracle(base as RegressionSummary, accepted) ?? compareOracle(accepted, accepted);
    if (compared) return compared;
    // Idempotence through a JSON round trip (what the CLI reads back).
    const roundTrip = validateRegressionSummary(JSON.parse(JSON.stringify(accepted)));
    if (!roundTrip.ok)
      return broken(
        "accepted",
        "UNEXPECTED:round_trip_rejected",
        roundTrip.failure.message.slice(0, 160),
      );
    return held(
      "accepted",
      mutation.op === "control"
        ? ""
        : `accepted ${pathToString(mutation.path)}=${mutation.payload.slice(0, 80)}`,
    );
  }
  if (kind === "tolerances") {
    const rawInput = input as Record<string, unknown>;
    const accepted = value as ToleranceConfig;
    const inputMetrics = rawInput.metrics as Record<string, Record<string, unknown>>;
    const normalise = (entry: {
      direction: unknown;
      absoluteTolerance: unknown;
      rationale: unknown;
    }): Record<string, unknown> => ({
      direction: entry.direction,
      absoluteTolerance: entry.absoluteTolerance,
      rationale: entry.rationale,
    });
    const diff = deepEqual(
      Object.fromEntries(
        Object.keys(inputMetrics).map((key) => [
          key,
          normalise(
            inputMetrics[key] as {
              direction: unknown;
              absoluteTolerance: unknown;
              rationale: unknown;
            },
          ),
        ]),
      ),
      Object.fromEntries(
        Object.keys(accepted.metrics).map((key) => [key, normalise(accepted.metrics[key]!)]),
      ),
    );
    if (diff) {
      return broken(
        "accepted",
        mutation.op === "proto_key"
          ? "F1_PROTO_KEY_SILENTLY_DROPPED"
          : "UNEXPECTED:accepted_altered",
        diff,
      );
    }
    for (const key of [
      "contractVersion",
      "unlistedMetricPolicy",
      "lostMeasurementIsRegression",
    ] as const) {
      if (rawInput[key] !== accepted[key])
        return broken(
          "accepted",
          "UNEXPECTED:accepted_altered",
          `${key}: ${describeValue(rawInput[key])} → ${describeValue(accepted[key])}`,
        );
    }
    return held(
      "accepted",
      mutation.op === "control"
        ? ""
        : `accepted ${pathToString(mutation.path)}=${mutation.payload.slice(0, 80)}`,
    );
  }
  // manifest
  const conformance = conformsToManifestInterface(value);
  if (conformance) return broken("accepted", "F4_MANIFEST_UNSANITIZED_PASSTHROUGH", conformance);
  try {
    const manifest = value as ReturnType<typeof randomManifest> & {
      provenance: "consented_first_party";
    };
    const splitsA = assignSplits(manifest);
    const splitsB = assignSplits(manifest);
    const diff = deepEqual(splitsA, splitsB);
    if (diff) return broken("accepted", "UNEXPECTED:split_nondeterministic", diff);
    for (const item of splitsA) {
      if (!["train", "val", "test"].includes(item.split))
        return broken("accepted", "UNEXPECTED:split_value", item.split);
    }
  } catch (error) {
    return broken("accepted", "UNEXPECTED:assign_splits_threw", errorSummary(error));
  }
  return held(
    "accepted",
    mutation.op === "control"
      ? ""
      : `accepted ${pathToString(mutation.path)}=${mutation.payload.slice(0, 80)}`,
  );
}

// --- compare_pairs -----------------------------------------------------------

function comparePairsIteration(rng: Prng): { mutation: Mutation; judgement: Judgement } {
  const baseline = randomSummary(rng);
  const candidate = cloneJsonish(baseline) as RegressionSummary;
  const flavour = rng.pick([
    "identity",
    "perturb",
    "abstain",
    "extreme",
    "unicode_model_version",
    "drop_bench",
    "fail_bench",
  ]);
  const benches = candidate.benches;
  switch (flavour) {
    case "identity":
      break;
    case "perturb":
      for (const bench of benches) {
        for (const key of Object.keys(bench.metrics)) {
          const current = bench.metrics[key];
          if (typeof current === "number" && rng.bool(0.5))
            bench.metrics[key] = current + rng.pick([-1, 1, 0.5, -0.5]);
        }
      }
      break;
    case "abstain":
      for (const bench of benches) {
        for (const key of Object.keys(bench.metrics)) if (rng.bool(0.5)) bench.metrics[key] = null;
      }
      break;
    case "extreme":
      for (const bench of benches) {
        for (const key of Object.keys(bench.metrics))
          if (rng.bool(0.7)) bench.metrics[key] = rng.pick(EDGE_NUMBERS_FINITE);
      }
      break;
    case "unicode_model_version": {
      const [nfc, nfd] = rng.pick(UNICODE_NORMALIZATION_PAIRS);
      baseline.provenance.modelVersions.contactEstimator = nfc;
      candidate.provenance.modelVersions.contactEstimator = nfd;
      break;
    }
    case "drop_bench":
      if (benches.length > 1) benches.pop();
      break;
    default: {
      const bench = rng.pick(benches);
      bench.status = "failed";
      bench.error = "seeded failure";
      bench.metrics = {};
    }
  }
  candidate.metrics = flattenBenchMetrics(benches);
  const mutation: Mutation = {
    op: `pair_${flavour}`,
    path: [],
    doc: candidate,
    payload: describeValue(candidate.metrics),
    expectation: "accept",
  };
  const validBaseline = validateRegressionSummary(baseline);
  const validCandidate = validateRegressionSummary(candidate);
  if (!validBaseline.ok || !validCandidate.ok) {
    return {
      mutation,
      judgement: broken(
        "rejected",
        "UNEXPECTED:pair_rejected",
        `${!validBaseline.ok ? validBaseline.failure.message : validCandidate.ok ? "" : validCandidate.failure.message}`.slice(
          0,
          160,
        ),
      ),
    };
  }
  const oracle = compareOracle(validBaseline.value, validCandidate.value);
  if (oracle) return { mutation, judgement: oracle };
  const report = compareSummaries(
    validBaseline.value,
    validCandidate.value,
    loadCommittedTolerances(),
  );
  const again = compareSummaries(
    validBaseline.value,
    validCandidate.value,
    loadCommittedTolerances(),
  );
  const diff = deepEqual(report, again);
  if (diff)
    return { mutation, judgement: broken("compared", "UNEXPECTED:compare_nondeterministic", diff) };
  if (flavour === "identity") {
    // Identical documents may still exit 1 under `unlistedMetricPolicy: fail`, but no
    // metric may move and nothing may be classified as a regression/improvement.
    const moved = report.metrics.find((metric) => metric.delta !== null && metric.delta !== 0);
    if (moved)
      return {
        mutation,
        judgement: broken(
          "compared",
          "UNEXPECTED:identity_delta",
          `${moved.metric}: Δ ${moved.delta}`,
        ),
      };
    const misclassified = report.metrics.find(
      (metric) => metric.status === "regressed" || metric.status === "improved",
    );
    if (misclassified)
      return {
        mutation,
        judgement: broken(
          "compared",
          "UNEXPECTED:identity_not_clean",
          `${misclassified.metric}: ${misclassified.status}`,
        ),
      };
    if (!report.comparable)
      return {
        mutation,
        judgement: broken(
          "compared",
          "UNEXPECTED:identity_not_comparable",
          report.regressions.join("; ").slice(0, 160),
        ),
      };
  }
  if (flavour === "abstain") {
    const bad = report.metrics.find((metric) => metric.candidate === null && metric.delta !== null);
    if (bad)
      return {
        mutation,
        judgement: broken("compared", "UNEXPECTED:abstention_coerced", bad.metric),
      };
  }
  return {
    mutation,
    judgement: held(
      "compared",
      `exit ${report.exitCode}, ${report.metrics.length} metrics, ${report.regressions.length} regressions`,
    ),
  };
}

// --- cli ---------------------------------------------------------------------

interface CapturedMain {
  code: number | undefined;
  threw: string | null;
  stdout: string;
  stderr: string;
}

function captureMain(argv: string[]): CapturedMain {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalError = console.error;
  let stdout = "";
  let stderr = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  console.error = (...args: unknown[]) => {
    stderr += `${args.map(String).join(" ")}\n`;
  };
  try {
    const result = cliMain(argv);
    if (typeof result !== "number") {
      // `compare` and usage errors are synchronous by contract; a promise here means `run` was reached.
      return {
        code: undefined,
        threw: "main returned a promise (run command reached)",
        stdout,
        stderr,
      };
    }
    return { code: result, threw: null, stdout, stderr };
  } catch (error) {
    return { code: undefined, threw: errorSummary(error), stdout, stderr };
  } finally {
    process.stdout.write = originalWrite;
    console.error = originalError;
  }
}

const CLI_TEXT_OPS = [
  "control",
  "truncate",
  "insert_null_byte",
  "bom",
  "invalid_utf8",
  "trailing_garbage",
  "duplicate_key",
  "number_token",
  "long_string_field",
  "replace_whole",
  "deep_text",
  "proto_text",
  "missing_file",
  "directory_as_file",
  "nul_in_path",
  "argv_fuzz",
] as const;

function mutateText(
  rng: Prng,
  text: string,
  op: (typeof CLI_TEXT_OPS)[number],
): { bytes: Buffer; payload: string } {
  const buf = Buffer.from(text, "utf8");
  switch (op) {
    case "truncate": {
      const at = rng.int(0, buf.length);
      return { bytes: buf.subarray(0, at), payload: `truncated at byte ${at}/${buf.length}` };
    }
    case "insert_null_byte": {
      const at = rng.int(0, buf.length);
      return {
        bytes: Buffer.concat([buf.subarray(0, at), Buffer.from([0]), buf.subarray(at)]),
        payload: `NUL inserted at ${at}`,
      };
    }
    case "bom":
      return {
        bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]),
        payload: "UTF-8 BOM prefix",
      };
    case "invalid_utf8": {
      const at = rng.int(0, buf.length);
      const junk = rng.pick([
        Buffer.from([0xff]),
        Buffer.from([0xc0, 0x80]),
        Buffer.from([0xed, 0xa0, 0x80]),
        Buffer.from([0xf4, 0x90, 0x80, 0x80]),
      ]);
      return {
        bytes: Buffer.concat([buf.subarray(0, at), junk, buf.subarray(at)]),
        payload: `invalid UTF-8 ${junk.toString("hex")} at ${at}`,
      };
    }
    case "trailing_garbage": {
      const junk = rng.pick(["}", "]", ",", "{}", "null", "\u0000", "x", " // comment", "\n\n{"]);
      return {
        bytes: Buffer.concat([buf, Buffer.from(junk)]),
        payload: `trailing ${JSON.stringify(junk)}`,
      };
    }
    case "duplicate_key": {
      const match =
        /"(schemaVersion|contractVersion|runId|configVersion|totalWallClockMs)":\s*("[^"]*"|[-0-9.eE+]+)/.exec(
          text,
        );
      if (!match) return { bytes: buf, payload: "no duplicable key" };
      const dup = `"${match[1]}": ${rng.pick(["2", '"dup"', "null", "1e999", "-0"])}, ${match[0]}`;
      return {
        bytes: Buffer.from(text.replace(match[0], dup)),
        payload: `duplicate key ${match[1]} (first ${dup.slice(0, 30)})`,
      };
    }
    case "number_token": {
      const numbers = [...text.matchAll(/:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/g)];
      if (numbers.length === 0) return { bytes: buf, payload: "no number token" };
      const hit = rng.pick(numbers);
      const token = rng.pick(EDGE_NUMBER_TOKENS);
      const index = hit.index + hit[0].indexOf(hit[1]!);
      const replaced = text.slice(0, index) + token + text.slice(index + hit[1]!.length);
      return {
        bytes: Buffer.from(replaced),
        payload: `number token → ${JSON.stringify(token.slice(0, 40))}`,
      };
    }
    case "long_string_field": {
      const size = rng.pick([64 * 1024, 64 * 1024 + 1, 256 * 1024, 1024 * 1024]);
      const replaced = text.replace(/"runId":\s*"[^"]*"/, `"runId": "${"x".repeat(size)}"`);
      return { bytes: Buffer.from(replaced), payload: `runId string ${size} bytes` };
    }
    case "replace_whole": {
      const whole = rng.pick([
        "",
        " ",
        "\n",
        "null",
        "[]",
        "{}",
        '"summary"',
        "42",
        "true",
        "{",
        "}",
        "[{}]",
        '{"a":1,}',
        "{'a':1}",
        "undefined",
        "NaN",
        "\ufeff{}",
      ]);
      return { bytes: Buffer.from(whole), payload: `whole file ${JSON.stringify(whole)}` };
    }
    case "deep_text": {
      const depth = rng.pick([1000, 10000, 100000, 500000]);
      const replaced = text.replace(
        /"schemaVersion":\s*1/,
        `"schemaVersion": ${"[".repeat(depth)}${"]".repeat(depth)}`,
      );
      return { bytes: Buffer.from(replaced), payload: `schemaVersion nested array depth ${depth}` };
    }
    case "proto_text": {
      const key = rng.pick(PROTO_KEYS);
      const value = rng.pick(['{"polluted":1}', "null", "1", '"x"']);
      const target = rng.pick(["metrics", "labels", "modelVersions"]);
      const emptyObject = new RegExp(`"${target}":\\s*\\{(?=\\s*\\})`);
      const replaced = emptyObject.test(text)
        ? text.replace(emptyObject, `"${target}": {"${key}": ${value}`)
        : text.replace(new RegExp(`"${target}":\\s*\\{`), `"${target}": {"${key}": ${value},`);
      return { bytes: Buffer.from(replaced), payload: `${target}.${key} = ${value}` };
    }
    default:
      return { bytes: buf, payload: "unmodified" };
  }
}

function cliIteration(
  rng: Prng,
  scratchDir: string,
  seed: number,
): { mutation: Mutation; judgement: Judgement } {
  const baseline = randomSummary(rng);
  const candidate = cloneJsonish(baseline) as RegressionSummary;
  for (const bench of candidate.benches) {
    for (const key of Object.keys(bench.metrics)) {
      const current = bench.metrics[key];
      if (typeof current === "number" && rng.bool(0.3)) bench.metrics[key] = current + 1;
    }
  }
  candidate.metrics = flattenBenchMetrics(candidate.benches);
  const tolerances = randomToleranceDoc(rng);
  const op = rng.pick(CLI_TEXT_OPS);
  const target = rng.pick(["baseline", "candidate", "tolerances"] as const);
  const dir = join(scratchDir, `s${seed}`);
  mkdirSync(dir, { recursive: true });
  const paths = {
    baseline: join(dir, "baseline.json"),
    candidate: join(dir, "candidate.json"),
    tolerances: join(dir, "tolerances.json"),
  };
  const texts = {
    baseline: `${JSON.stringify(baseline, null, 2)}\n`,
    candidate: `${JSON.stringify(candidate, null, 2)}\n`,
    tolerances: `${JSON.stringify(tolerances, null, 2)}\n`,
  };
  let payload = "unmodified";
  let argv = [
    "compare",
    paths.baseline,
    paths.candidate,
    "--tolerances",
    paths.tolerances,
    "--json",
  ];
  let expectation: Expectation = "either";
  const written: Record<string, Buffer> = {
    baseline: Buffer.from(texts.baseline),
    candidate: Buffer.from(texts.candidate),
    tolerances: Buffer.from(texts.tolerances),
  };
  if (op === "control") {
    expectation = "accept";
    if (rng.bool(0.3)) argv = argv.slice(0, -1);
  } else if (op === "missing_file") {
    paths[target] = join(
      dir,
      rng.pick(["missing.json", "../../../etc/passwd", "..\\x.json", "\u00e9.json"]),
    );
    payload = `${target} → ${basename(paths[target])}`;
    argv = ["compare", paths.baseline, paths.candidate, "--tolerances", paths.tolerances, "--json"];
    expectation = "reject";
  } else if (op === "directory_as_file") {
    paths[target] = dir;
    payload = `${target} → directory`;
    argv = ["compare", paths.baseline, paths.candidate, "--tolerances", paths.tolerances, "--json"];
    expectation = "reject";
  } else if (op === "nul_in_path") {
    paths[target] = `${paths[target]}\u0000.json`;
    payload = `${target} → path with NUL`;
    argv = ["compare", paths.baseline, paths.candidate, "--tolerances", paths.tolerances, "--json"];
    expectation = "reject";
  } else if (op === "argv_fuzz") {
    const pool = [
      "compare",
      "run",
      "bogus",
      "--json",
      "--tolerances",
      "--out-dir",
      "--only",
      "--run-id",
      "--",
      "-",
      "",
      paths.baseline,
      paths.candidate,
      paths.tolerances,
      edgeString(rng),
      rng.pick(PATH_TRAVERSAL_STRINGS),
    ];
    const count = rng.int(0, 6);
    argv = [];
    for (let index = 0; index < count; index += 1) argv.push(rng.pick(pool));
    // Never launch the real bench runner from the fuzzer.
    argv = argv.filter((arg) => arg !== "run");
    payload = `argv ${describeValue(argv)}`;
    expectation = "either";
  } else {
    const mutated = mutateText(rng, texts[target], op);
    written[target] = mutated.bytes;
    payload = `${target}: ${mutated.payload}`;
    expectation = op === "replace_whole" ? "reject" : "either";
  }
  for (const name of ["baseline", "candidate", "tolerances"] as const) {
    writeFileSync(join(dir, `${name}.json`), written[name]!);
  }
  const before = readdirSync(dir).sort();
  const reportsBefore = listReportsDir();
  const mutation: Mutation = { op, path: [target], doc: null, payload, expectation };
  const captured = captureMain(argv);
  const after = readdirSync(dir).sort();
  const reportsAfter = listReportsDir();
  rmSync(dir, { recursive: true, force: true });
  const judgement = judgeCli(captured, expectation, before, after, reportsBefore === reportsAfter);
  return { mutation, judgement };
}

function listReportsDir(): string {
  try {
    return readdirSync(join(REPO_ROOT, "datasets/reports/regression")).sort().join("\n");
  } catch {
    return "<absent>";
  }
}

function judgeCli(
  captured: CapturedMain,
  expectation: Expectation,
  before: string[],
  after: string[],
  reportsUnchanged: boolean,
): Judgement {
  if (captured.threw !== null) return broken("threw", "UNEXPECTED:cli_threw", captured.threw);
  const code = captured.code;
  if (code === undefined || ![0, 1, 2, 3].includes(code))
    return broken(`exit_${String(code)}`, "UNEXPECTED:cli_exit_code", `exit ${String(code)}`);
  if (before.join("\n") !== after.join("\n"))
    return broken(
      `exit_${code}`,
      "UNEXPECTED:cli_wrote_file",
      `scratch dir changed: ${after.filter((f) => !before.includes(f)).join(",")}`,
    );
  if (!reportsUnchanged)
    return broken(
      `exit_${code}`,
      "UNEXPECTED:cli_wrote_report",
      "datasets/reports/regression changed",
    );
  if (looksLikeStackTrace(captured.stderr))
    return broken(`exit_${code}`, "UNEXPECTED:cli_stack_trace", captured.stderr.slice(0, 200));
  if (code === 2) {
    if (captured.stderr.trim().length === 0)
      return broken("exit_2", "UNEXPECTED:cli_silent_failure", "exit 2 with empty stderr");
    if (expectation === "accept")
      return broken("exit_2", "UNEXPECTED:cli_control_rejected", captured.stderr.slice(0, 200));
    return held("exit_2", captured.stderr.split("\n")[0]!.slice(0, 120));
  }
  if (expectation === "reject")
    return broken(
      `exit_${code}`,
      "UNEXPECTED:cli_accepted_invalid",
      `exit ${code} for a document that must be refused`,
    );
  if (captured.stdout.trim().startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(captured.stdout);
    } catch (error) {
      return broken(`exit_${code}`, "UNEXPECTED:cli_json_output", errorSummary(error));
    }
    const report = parsed as CompareReport;
    if (report.exitCode !== code)
      return broken(
        `exit_${code}`,
        "UNEXPECTED:cli_exit_mismatch",
        `report.exitCode ${report.exitCode}`,
      );
    for (const metric of report.metrics ?? []) {
      if (
        typeof metric.baseline === "number" &&
        typeof metric.candidate === "number" &&
        metric.delta === null
      ) {
        return broken(
          `exit_${code}`,
          "F2_COMPARE_DELTA_NON_FINITE",
          `${metric.metric}: delta serialised as null (${metric.baseline} → ${metric.candidate})`,
        );
      }
    }
  }
  return held(
    `exit_${code}`,
    captured.stdout.length > 0 ? `${captured.stdout.length} bytes stdout` : "",
  );
}

// --- run_id ------------------------------------------------------------------

function unsafeRunIdReason(id: string): string | null {
  if (id.length === 0) return "empty";
  if (id.length > 128) return "longer than 128";
  if (id.includes("/") || id.includes("\\") || id.includes("\u0000"))
    return "contains a path separator or NUL";
  if (id.startsWith(".") || id.startsWith("-")) return "leading dot or dash";
  if (/\s/.test(id)) return "whitespace";
  if (!/^[\x21-\x7e]+$/.test(id)) return "non printable-ASCII";
  if (basename(id) !== id) return "basename differs";
  const dir = "/tmp/reports";
  const resolved = resolve(dir, `${id}.json`);
  if (!resolved.startsWith(dir + sep) || resolved.slice(dir.length + 1).includes(sep))
    return "escapes the output directory";
  return null;
}

function randomRunId(rng: Prng): string {
  const kind = rng.int(0, 9);
  switch (kind) {
    case 0:
      return rng.pick(PATH_TRAVERSAL_STRINGS);
    case 1:
      return edgeString(rng);
    case 2:
      return `run-${rng.int(0, 999)}`;
    case 3:
      return "2026-09-04T02-24-36.147Z";
    case 4:
      return `${rng.pick(["a", "Z", "9"])}${rng.pick([".", "-", "_"]).repeat(rng.int(0, 130))}`;
    case 5:
      return `a${"b".repeat(rng.pick([126, 127, 128, 129]))}`;
    case 6:
      return `${rng.pick(["x", ".x", "-x", "x\n", "x\r", "x ", " x", "x.json", "x/..", "x\u00e9", "\u00e9x", "x\u200b", "x..", "x.", "x-"])}`;
    case 7:
      return `${rng.pick(["a", "b"])}${rng.pick(["/", "\\", "\u0000", ":", "*", "?", '"', "<", ">", "|"])}${rng.pick(["a", "b"])}`;
    case 8: {
      let out = "";
      const length = rng.int(1, 20);
      for (let index = 0; index < length; index += 1)
        out += String.fromCharCode(rng.int(0x20, 0x7e));
      return out;
    }
    default:
      return String.fromCodePoint(rng.int(0x80, 0xd7ff));
  }
}

async function runIdIteration(
  rng: Prng,
  scratchDir: string,
  seed: number,
  includeRunner: boolean,
): Promise<{ mutation: Mutation; judgement: Judgement }> {
  const id = randomRunId(rng);
  const unsafe = unsafeRunIdReason(id);
  const mutation: Mutation = {
    op: "assert_valid_run_id",
    path: ["runId"],
    doc: id,
    payload: describeValue(id),
    expectation: unsafe ? "reject" : "either",
  };
  let accepted: string | null = null;
  try {
    accepted = assertValidRunId(id);
  } catch (error) {
    if (!(error instanceof Error) || error instanceof TypeError || error instanceof RangeError) {
      return {
        mutation,
        judgement: broken("threw", "UNEXPECTED:run_id_untyped_throw", errorSummary(error)),
      };
    }
    if (!unsafe)
      return {
        mutation,
        judgement: held("rejected", `conservatively refused: ${error.message.slice(0, 80)}`),
      };
    if (includeRunner && rng.bool(0.5)) {
      const outDir = join(scratchDir, `runid-${seed}`);
      try {
        await runRegression({ runId: id, outDir, only: ["contact_replay"], log: () => undefined });
        return {
          mutation,
          judgement: broken(
            "runner_accepted",
            "UNEXPECTED:runner_accepted_unsafe_id",
            id.slice(0, 80),
          ),
        };
      } catch (runnerError) {
        const leftovers = (() => {
          try {
            return readdirSync(outDir);
          } catch {
            return [];
          }
        })();
        rmSync(outDir, { recursive: true, force: true });
        if (leftovers.length > 0)
          return {
            mutation,
            judgement: broken(
              "runner_rejected",
              "UNEXPECTED:runner_left_files",
              leftovers.join(","),
            ),
          };
        if (!(runnerError instanceof Error))
          return {
            mutation,
            judgement: broken(
              "runner_threw",
              "UNEXPECTED:runner_untyped_throw",
              errorSummary(runnerError),
            ),
          };
        return {
          mutation,
          judgement: held("rejected", `validator + runner refused (${unsafe}); no files written`),
        };
      }
    }
    return { mutation, judgement: held("rejected", `refused (${unsafe})`) };
  }
  if (unsafe)
    return {
      mutation,
      judgement: broken(
        "accepted",
        "UNEXPECTED:run_id_unsafe_accepted",
        `${describeValue(id)}: ${unsafe}`,
      ),
    };
  if (accepted !== id)
    return {
      mutation,
      judgement: broken("accepted", "UNEXPECTED:run_id_altered", describeValue(accepted)),
    };
  return { mutation, judgement: held("accepted", "") };
}

// --- metrics -----------------------------------------------------------------

const METRIC_OPS = [
  "classification_edge_labels",
  "classification_plain",
  "timing_edge",
  "mae_edge",
  "pearson_edge",
  "spearman_edge",
  "calibration_confidence",
  "calibration_bin_count",
] as const;

function edgeNumber(rng: Prng, allowNonFinite: boolean): number {
  if (allowNonFinite && rng.bool(0.3)) return rng.pick(EDGE_NUMBERS_NON_FINITE);
  return rng.bool(0.5) ? rng.pick(EDGE_NUMBERS_FINITE) : rng.int(-1000, 1000);
}

function metricsIteration(rng: Prng): { mutation: Mutation; judgement: Judgement } {
  const op = rng.pick(METRIC_OPS);
  const count = rng.int(0, 6);
  switch (op) {
    case "classification_edge_labels":
    case "classification_plain": {
      const labelPool =
        op === "classification_plain"
          ? ["dink", "drive", "serve", "lob"]
          : [
              ...PROTO_KEYS,
              ...UNICODE_NORMALIZATION_PAIRS.flat(),
              "\u0000",
              "",
              "a".repeat(70000),
              "dink",
            ];
      const cases = Array.from({ length: count }, () => ({
        truth: rng.pick(labelPool),
        predicted: rng.pick(labelPool),
      }));
      const mutation: Mutation = {
        op,
        path: [],
        doc: cases,
        payload: describeValue(
          cases.map((c) => `${c.truth.slice(0, 12)}→${c.predicted.slice(0, 12)}`),
        ),
        expectation: "accept",
      };
      try {
        const report = classificationReport(cases);
        const hostileLabel = cases.some(
          (c) => PROTO_KEYS.includes(c.truth) || PROTO_KEYS.includes(c.predicted),
        );
        const nonFinite = findNonFinite(report);
        if (nonFinite) {
          return {
            mutation,
            judgement: broken(
              "returned",
              hostileLabel
                ? "F3_CLASSIFICATION_PROTOTYPE_POLLUTION"
                : "UNEXPECTED:classification_non_finite",
              nonFinite,
            ),
          };
        }
        if (
          report.accuracy < 0 ||
          report.accuracy > 1 ||
          report.macroF1 < 0 ||
          report.macroF1 > 1
        ) {
          return {
            mutation,
            judgement: broken(
              "returned",
              "UNEXPECTED:classification_range",
              `accuracy ${report.accuracy} macroF1 ${report.macroF1}`,
            ),
          };
        }
        const labels = new Set(cases.flatMap((c) => [c.truth, c.predicted]));
        const reported = new Set(report.perClass.map((entry) => entry.label));
        if (labels.size !== reported.size)
          return {
            mutation,
            judgement: broken(
              "returned",
              "F3_CLASSIFICATION_PROTOTYPE_POLLUTION",
              `perClass labels ${reported.size} != distinct labels ${labels.size}`,
            ),
          };
        const plain = allPlainObjects(report.confusion);
        if (plain)
          return {
            mutation,
            judgement: broken("returned", "F3_CLASSIFICATION_PROTOTYPE_POLLUTION", plain),
          };
        return {
          mutation,
          judgement: held(
            "returned",
            `${report.caseCount} cases, accuracy ${report.accuracy.toFixed(3)}`,
          ),
        };
      } catch (error) {
        return {
          mutation,
          judgement: broken("threw", "UNEXPECTED:classification_threw", errorSummary(error)),
        };
      }
    }
    case "timing_edge":
    case "mae_edge":
    case "pearson_edge":
    case "spearman_edge": {
      const allowNonFinite = rng.bool(0.4);
      const pairs = Array.from({ length: count }, () => ({
        a: edgeNumber(rng, allowNonFinite),
        b: edgeNumber(rng, allowNonFinite),
      }));
      const inputsFinite = pairs.every(
        (pair) => Number.isFinite(pair.a) && Number.isFinite(pair.b),
      );
      const mutation: Mutation = {
        op,
        path: [],
        doc: pairs,
        payload: describeValue(pairs.map((pair) => [pair.a, pair.b])),
        expectation: "accept",
      };
      try {
        let output: unknown;
        if (op === "timing_edge") {
          const report = timingReport(
            pairs.map((pair) => ({ truthMs: pair.a, predictedMs: pair.b })),
          );
          output = {
            mean: report.meanAbsoluteErrorMs,
            median: report.medianAbsoluteErrorMs,
            within: report.withinTolerance(10),
          };
        } else if (op === "mae_edge") {
          output = meanAbsoluteError(pairs.map((pair) => ({ truth: pair.a, predicted: pair.b })));
        } else if (op === "pearson_edge") {
          output = pearsonCorrelation(pairs.map((pair) => ({ truth: pair.a, predicted: pair.b })));
        } else {
          output = spearmanCorrelation(pairs.map((pair) => ({ truth: pair.a, predicted: pair.b })));
        }
        const nonFinite = findNonFinite(output);
        if (nonFinite) {
          return {
            mutation,
            judgement: broken(
              "returned",
              "F5_METRIC_MATH_NON_FINITE_OUTPUT",
              `${inputsFinite ? "finite inputs" : "non-finite inputs"} → ${nonFinite}`,
            ),
          };
        }
        if (
          (op === "pearson_edge" || op === "spearman_edge") &&
          typeof output === "number" &&
          Math.abs(output) > 1 + 1e-9
        ) {
          return {
            mutation,
            judgement: broken("returned", "UNEXPECTED:correlation_out_of_range", String(output)),
          };
        }
        return { mutation, judgement: held("returned", describeValue(output)) };
      } catch (error) {
        return {
          mutation,
          judgement: broken("threw", "UNEXPECTED:metric_threw", errorSummary(error)),
        };
      }
    }
    case "calibration_confidence": {
      const cases = Array.from({ length: count }, () => ({
        confidence: rng.bool(0.6)
          ? rng.float()
          : rng.pick([
              ...EDGE_NUMBERS_NON_FINITE,
              ...EDGE_NUMBERS_FINITE,
              0,
              1,
              -0,
              1.0000001,
              -1e-12,
            ]),
        correct: rng.bool(),
      }));
      const valid = cases.every(
        (item) => Number.isFinite(item.confidence) && item.confidence >= 0 && item.confidence <= 1,
      );
      const mutation: Mutation = {
        op,
        path: [],
        doc: cases,
        payload: describeValue(cases.map((c) => c.confidence)),
        expectation: valid ? "accept" : "typed_error",
      };
      try {
        const report = calibrationReport(cases);
        if (!valid)
          return {
            mutation,
            judgement: broken(
              "returned",
              "UNEXPECTED:calibration_accepted_invalid",
              describeValue(cases.map((c) => c.confidence)),
            ),
          };
        const nonFinite = findNonFinite({
          ece: report.expectedCalibrationError,
          bins: report.bins,
        });
        if (nonFinite)
          return {
            mutation,
            judgement: broken("returned", "UNEXPECTED:calibration_non_finite", nonFinite),
          };
        if (report.expectedCalibrationError < 0 || report.expectedCalibrationError > 1)
          return {
            mutation,
            judgement: broken(
              "returned",
              "UNEXPECTED:calibration_range",
              String(report.expectedCalibrationError),
            ),
          };
        if (report.n < 10 && report.warnings.length === 0)
          return {
            mutation,
            judgement: broken(
              "returned",
              "UNEXPECTED:calibration_no_small_n_warning",
              `n=${report.n}`,
            ),
          };
        return {
          mutation,
          judgement: held(
            "returned",
            `ECE ${report.expectedCalibrationError.toFixed(4)} n=${report.n}`,
          ),
        };
      } catch (error) {
        if (valid)
          return {
            mutation,
            judgement: broken(
              "threw",
              "UNEXPECTED:calibration_threw_on_valid",
              errorSummary(error),
            ),
          };
        if (
          error instanceof Error &&
          !(error instanceof TypeError) &&
          !(error instanceof RangeError) &&
          error.message.startsWith("confidence must be finite")
        ) {
          return { mutation, judgement: held("typed_error", error.message.slice(0, 80)) };
        }
        return {
          mutation,
          judgement: broken("threw", "UNEXPECTED:calibration_untyped_throw", errorSummary(error)),
        };
      }
    }
    default: {
      const binCount = rng.pick([
        0,
        -1,
        1.5,
        2.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        -0,
        1,
        3,
        10,
        100,
      ]);
      const cases = Array.from({ length: Math.max(1, count) }, () => ({
        confidence: rng.float(),
        correct: rng.bool(),
      }));
      const mutation: Mutation = {
        op,
        path: ["binCount"],
        doc: binCount,
        payload: describeValue(binCount),
        expectation: "either",
      };
      try {
        const report = calibrationReport(cases, binCount);
        const nonFinite = findNonFinite({
          ece: report.expectedCalibrationError,
          bins: report.bins,
        });
        if (nonFinite)
          return {
            mutation,
            judgement: broken(
              "returned",
              "F6_CALIBRATION_BIN_COUNT_UNTYPED_THROW",
              `non-finite ${nonFinite}`,
            ),
          };
        if (report.bins.length !== binCount)
          return {
            mutation,
            judgement: broken(
              "returned",
              "F6_CALIBRATION_BIN_COUNT_UNTYPED_THROW",
              `bins ${report.bins.length} for binCount ${describeValue(binCount)}`,
            ),
          };
        return { mutation, judgement: held("returned", `${report.bins.length} bins`) };
      } catch (error) {
        if (error instanceof TypeError || error instanceof RangeError) {
          return {
            mutation,
            judgement: broken(
              "threw",
              "F6_CALIBRATION_BIN_COUNT_UNTYPED_THROW",
              errorSummary(error),
            ),
          };
        }
        return { mutation, judgement: held("typed_error", errorSummary(error)) };
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Iteration + campaign drivers
// ---------------------------------------------------------------------------

export async function runIteration(
  seed: number,
  scratchDir: string,
  includeRunner = false,
): Promise<IterationRecord> {
  const rng = new Prng(seed);
  const surface = rng.weighted(
    SURFACES,
    SURFACES.map((name) => SURFACE_WEIGHTS[name]),
  );
  const started = process.hrtime.bigint();
  const snapshot = snapshotPrototypes();
  let outcome: { mutation: Mutation; judgement: Judgement };
  try {
    switch (surface) {
      case "summary":
        outcome = summaryIteration(rng);
        break;
      case "tolerances":
        outcome = tolerancesIteration(rng);
        break;
      case "manifest":
        outcome = manifestIteration(rng);
        break;
      case "compare_pairs":
        outcome = comparePairsIteration(rng);
        break;
      case "cli":
        outcome = cliIteration(rng, scratchDir, seed);
        break;
      case "run_id":
        outcome = await runIdIteration(rng, scratchDir, seed, includeRunner);
        break;
      default:
        outcome = metricsIteration(rng);
    }
  } catch (error) {
    outcome = {
      mutation: { op: "harness", path: [], doc: null, payload: "", expectation: "either" },
      judgement: broken("harness_threw", "UNEXPECTED:harness_threw", errorSummary(error)),
    };
  }
  const pollution = prototypesUnchanged(snapshot);
  if (pollution) {
    restorePrototypes(snapshot);
    outcome.judgement = broken(
      outcome.judgement.outcome,
      surface === "metrics"
        ? "F3_CLASSIFICATION_PROTOTYPE_POLLUTION"
        : "UNEXPECTED:prototype_pollution",
      pollution,
    );
  }
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  return {
    seed,
    surface,
    op: outcome.mutation.op,
    path: pathToString(outcome.mutation.path),
    payload: outcome.mutation.payload.slice(0, 200),
    expectation: outcome.mutation.expectation,
    outcome: outcome.judgement.outcome,
    detail: outcome.judgement.detail.slice(0, 300),
    verdict: outcome.judgement.verdict,
    brokenClass: outcome.judgement.brokenClass,
    durationMs: Math.round(durationMs * 1000) / 1000,
  };
}

export async function runCampaign(options: CampaignOptions): Promise<CampaignResult> {
  const started = Date.now();
  mkdirSync(options.scratchDir, { recursive: true });
  const records: IterationRecord[] = [];
  const brokenBySeed: Record<string, string> = {};
  const brokenClasses: Record<string, number> = {};
  const surfaces: Record<string, number> = {};
  const ops: Record<string, number> = {};
  const unexpected: number[] = [];
  for (let index = 0; index < options.iterations; index += 1) {
    const seed = (options.seedBase + index) >>> 0;
    const record = await runIteration(
      seed,
      options.scratchDir,
      options.includeRunnerRejections ?? false,
    );
    records.push(record);
    surfaces[record.surface] = (surfaces[record.surface] ?? 0) + 1;
    ops[`${record.surface}/${record.op}`] = (ops[`${record.surface}/${record.op}`] ?? 0) + 1;
    if (record.verdict === "BROKEN") {
      const cls = record.brokenClass ?? "UNEXPECTED:unclassified";
      brokenBySeed[String(seed)] = cls;
      brokenClasses[cls] = (brokenClasses[cls] ?? 0) + 1;
      if (!(cls in KNOWN_BROKEN)) unexpected.push(seed);
    }
  }
  const nondeterministic: number[] = [];
  let replayed = 0;
  if (options.replay ?? true) {
    for (const record of records) {
      const again = await runIteration(
        record.seed,
        options.scratchDir,
        options.includeRunnerRejections ?? false,
      );
      replayed += 1;
      if (fingerprint(again) !== fingerprint(record)) nondeterministic.push(record.seed);
    }
  }
  const held = records.filter((record) => record.verdict === "HELD").length;
  return {
    meta: {
      seedBase: options.seedBase,
      iterations: options.iterations,
      executed: records.length,
      replayed,
      nondeterministic,
      held,
      broken: records.length - held,
      brokenBySeed,
      brokenClasses,
      unexpected,
      surfaces,
      ops,
      durationMs: Date.now() - started,
      node: process.version,
    },
    records,
  };
}
