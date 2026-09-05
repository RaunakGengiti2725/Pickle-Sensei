import { afterAll, describe, expect, it } from "vitest";
import type { EnvelopeDimension, EnvelopeVerdict } from "@pickle/shared-types";
import {
  classifyDimension,
  evaluateCaptureEnvelope,
  type CaptureEnvelopeMeasurements,
} from "../../src/envelope.js";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL,
  CAPTURE_ENVELOPE_THRESHOLDS_VERSION,
  type DimensionThreshold,
} from "../../src/thresholds.js";
import {
  describeValue,
  ENVELOPE_STATUSES,
  inTypeNumber,
  isFiniteNumber,
  isJsonReachable,
  isPrototypeClean,
  MEASUREMENT_KEYS,
  offTypeValue,
  referenceStatus,
  ResultTable,
  SeededRng,
  stableJson,
  STRESS_ITER,
  STRESS_OUT,
  STRESS_SEED,
  withPollutionKeys,
  writeTable,
  type MeasurementKey,
} from "./boundaryMalformedSupport.js";

/**
 * boundary-malformed stress — `evaluateCaptureEnvelope` / `classifyDimension`.
 *
 * Seed → input is total and deterministic; replay one row with
 * `STRESS_SEED=<seed> STRESS_ITER=1 pnpm --filter @pickle/capture-envelope test -- boundaryMalformedEnvelope`.
 * Full campaign: `STRESS_ITER=3000 STRESS_OUT=/tmp/stress/table.json`.
 */

const DIMENSIONS = Object.keys(CAPTURE_ENVELOPE_THRESHOLDS) as EnvelopeDimension[];
const THRESHOLDS = Object.entries(CAPTURE_ENVELOPE_THRESHOLDS) as Array<
  [EnvelopeDimension, DimensionThreshold]
>;

const SOURCE_KEYS: Record<EnvelopeDimension, MeasurementKey[]> = {
  resolution: ["frameWidthPx", "frameHeightPx"],
  frame_rate: ["avgFrameRateFps"],
  brightness: ["brightnessMeanLuma"],
  exposure_clipping: ["clippedPixelFraction"],
  exposure_stability: ["brightnessStdLuma"],
  motion_blur: ["laplacianVarianceMedian"],
  sensor_noise: ["denoiseSurvivalRatio"],
  camera_motion: ["meanAbsFrameDiff"],
  camera_shake: ["contrastNormalizedFrameDiff"],
  timing_stability: ["frameIntervalCv"],
  clip_duration: ["clipDurationMs"],
  player_pixel_height: ["playerPixelHeightFraction"],
  player_visibility: ["playerMeanJointVisibility"],
};

function thresholdFor(key: MeasurementKey): DimensionThreshold {
  const dimension = DIMENSIONS.find((d) => SOURCE_KEYS[d].includes(key))!;
  return CAPTURE_ENVELOPE_THRESHOLDS[dimension];
}

function inTypeMeasurements(rng: SeededRng): Record<MeasurementKey, number | null> {
  const out = {} as Record<MeasurementKey, number | null>;
  for (const key of MEASUREMENT_KEYS) out[key] = inTypeNumber(rng, thresholdFor(key));
  return out;
}

/** What the reference model says each dimension should report for `m`. */
function referenceDimensionStatus(dimension: EnvelopeDimension, m: Record<string, unknown>) {
  const threshold = CAPTURE_ENVELOPE_THRESHOLDS[dimension];
  if (dimension === "resolution") {
    const w = m.frameWidthPx;
    const h = m.frameHeightPx;
    return isFiniteNumber(w) && isFiniteNumber(h)
      ? referenceStatus(Math.min(w, h), threshold)
      : "NOT_MEASURED";
  }
  return referenceStatus(m[SOURCE_KEYS[dimension][0]!], threshold);
}

interface ShapeProblem {
  what: string;
}

/** Structural invariants every verdict must satisfy regardless of input. */
function shapeProblems(verdict: EnvelopeVerdict): ShapeProblem[] {
  const problems: ShapeProblem[] = [];
  if (verdict.thresholdsVersion !== CAPTURE_ENVELOPE_THRESHOLDS_VERSION) {
    problems.push({ what: "thresholdsVersion drifted" });
  }
  if (verdict.provisional !== CAPTURE_ENVELOPE_THRESHOLDS_PROVISIONAL) {
    problems.push({ what: "provisional flag drifted" });
  }
  if (verdict.dimensions.length !== DIMENSIONS.length) {
    problems.push({ what: `dimension count ${verdict.dimensions.length}` });
  }
  verdict.dimensions.forEach((d, index) => {
    if (d.dimension !== DIMENSIONS[index]) problems.push({ what: `order ${d.dimension}@${index}` });
    if (!ENVELOPE_STATUSES.has(d.status)) problems.push({ what: `status ${String(d.status)}` });
    if (d.status === "NOT_MEASURED" && d.measured !== null) {
      problems.push({
        what: `${d.dimension} NOT_MEASURED with measured=${describeValue(d.measured)}`,
      });
    }
    if (d.thresholdId !== CAPTURE_ENVELOPE_THRESHOLDS[d.dimension].id) {
      problems.push({ what: `${d.dimension} thresholdId` });
    }
  });
  const notMeasured = verdict.dimensions.filter((d) => d.status === "NOT_MEASURED");
  if (stableJson(notMeasured.map((d) => d.dimension)) !== stableJson(verdict.notMeasured)) {
    problems.push({ what: "notMeasured list disagrees with dimension statuses" });
  }
  const rank = { SUPPORTED: 0, DEGRADED: 1, UNSUPPORTED: 2 } as const;
  let worst: keyof typeof rank = "SUPPORTED";
  for (const d of verdict.dimensions) {
    if (d.status !== "NOT_MEASURED" && d.status in rank && rank[d.status] > rank[worst]) {
      worst = d.status;
    }
  }
  if (verdict.overall !== worst) problems.push({ what: `overall ${verdict.overall} != ${worst}` });
  const expectedCoverage =
    worst === "SUPPORTED" && notMeasured.length > 0 ? "SUPPORTED_UNMEASURED" : worst;
  if (verdict.overallWithCoverage !== expectedCoverage) {
    problems.push({ what: `overallWithCoverage ${verdict.overallWithCoverage}` });
  }
  return problems;
}

/** `measured` must be null or a finite number — never NaN/±Infinity/off-type. */
function nonFiniteMeasured(verdict: EnvelopeVerdict): string[] {
  return verdict.dimensions
    .filter((d) => d.measured !== null && !isFiniteNumber(d.measured))
    .map((d) => `${d.dimension}=${describeValue(d.measured)}`);
}

function oracleMismatches(
  verdict: EnvelopeVerdict,
  m: Record<string, unknown>,
  skip: (dimension: EnvelopeDimension) => boolean,
): string[] {
  const out: string[] = [];
  for (const d of verdict.dimensions) {
    if (skip(d.dimension)) continue;
    const expected = referenceDimensionStatus(d.dimension, m);
    if (d.status !== expected) {
      const input = SOURCE_KEYS[d.dimension].map((k) => describeValue(m[k])).join("/");
      out.push(`${d.dimension}(${input}) ${d.status} expected ${expected}`);
    }
  }
  return out;
}

function hasNonFiniteInput(dimension: EnvelopeDimension, m: Record<string, unknown>): boolean {
  return SOURCE_KEYS[dimension].some((k) => {
    const v = m[k];
    return typeof v === "number" && !Number.isFinite(v) && !Number.isNaN(v);
  });
}

function hasOffTypeInput(dimension: EnvelopeDimension, m: Record<string, unknown>): boolean {
  return SOURCE_KEYS[dimension].some((k) => {
    const v = m[k];
    return v !== null && typeof v !== "number";
  });
}

const table = new ResultTable();
const inTypeInfinityDeviations: number[] = [];
const offTypeFailOpenDeviations: number[] = [];
const offTypeInProcessThrows: number[] = [];
const offTypeRootThrows: number[] = [];

afterAll(() => {
  writeTable(STRESS_OUT, "envelope", table);
  process.stderr.write(
    `[stress envelope] executed=${table.rows.length} broken=${table.broken().length} byKind=${JSON.stringify(table.countByKind())}\n`,
  );
});

describe("boundary-malformed stress: evaluateCaptureEnvelope", () => {
  it(`in-type numeric boundaries (null/NaN/±Inf/-0/overflow/band edges) × ${STRESS_ITER} seeds: never throw, canonical shape, worst-wins, deterministic`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + i;
      const m = inTypeMeasurements(new SeededRng(seed));
      let verdict: EnvelopeVerdict;
      try {
        verdict = evaluateCaptureEnvelope(m);
      } catch (error) {
        failures.push(`seed ${seed}: threw ${describeValue(error)}`);
        table.record({
          seed,
          generator: "envelope.in-type",
          kind: "throw",
          outcome: "BROKEN",
          detail: String(error),
        });
        continue;
      }
      const problems = shapeProblems(verdict).map((p) => p.what);
      const again = stableJson(evaluateCaptureEnvelope(m));
      if (again !== stableJson(verdict)) problems.push("non-deterministic for same input");
      const finiteMismatch = oracleMismatches(verdict, m, (d) => hasNonFiniteInput(d, m));
      problems.push(...finiteMismatch);
      const nonFinite = nonFiniteMeasured(verdict);
      const infinityMismatch = oracleMismatches(verdict, m, (d) => !hasNonFiniteInput(d, m));
      if (nonFinite.length > 0 || infinityMismatch.length > 0) {
        inTypeInfinityDeviations.push(seed);
        table.record({
          seed,
          generator: "envelope.in-type",
          kind: "infinity-treated-as-measurement",
          outcome: "BROKEN",
          detail: [...nonFinite, ...infinityMismatch].join("; "),
        });
      }
      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.join("; ")}`);
        table.record({
          seed,
          generator: "envelope.in-type",
          kind: "invariant",
          outcome: "BROKEN",
          detail: problems.join("; "),
        });
      } else {
        table.record({
          seed,
          generator: "envelope.in-type",
          kind: "invariants",
          outcome: "HELD",
          detail: `${verdict.overallWithCoverage} notMeasured=${verdict.notMeasured.length}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it.fails(
    "PINNED DEVIATION: ±Infinity inputs should abstain (NOT_MEASURED) and never surface a non-finite `measured`",
    () => {
      const rng = new SeededRng(STRESS_SEED);
      const base = inTypeMeasurements(rng);
      const m: CaptureEnvelopeMeasurements = {
        ...base,
        laplacianVarianceMedian: Number.POSITIVE_INFINITY,
      };
      const verdict = evaluateCaptureEnvelope(m);
      const blur = verdict.dimensions.find((d) => d.dimension === "motion_blur")!;
      expect(blur.status).toBe("NOT_MEASURED");
      expect(blur.measured).toBeNull();
      expect(inTypeInfinityDeviations).toEqual([]);
    },
  );

  it(`off-type / missing / prototype-pollution fields × ${STRESS_ITER} seeds: never throw for JSON-reachable object roots, statuses stay in-enum, prototype untouched, deterministic`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 1_000_000 + i;
      const rng = new SeededRng(seed);
      const shape = rng.int(10);
      let m: Record<string, unknown>;
      if (shape === 0) m = {};
      else if (shape === 1) m = withPollutionKeys(rng, {});
      else if (shape === 2) {
        m = Object.create(null) as Record<string, unknown>;
        for (const key of MEASUREMENT_KEYS) m[key] = inTypeNumber(rng, thresholdFor(key));
      } else {
        m = { ...inTypeMeasurements(rng) } as Record<string, unknown>;
        const corrupt = rng.intBetween(1, MEASUREMENT_KEYS.length);
        for (let k = 0; k < corrupt; k += 1) {
          const key = rng.pick(MEASUREMENT_KEYS);
          const value = offTypeValue(rng);
          if (value === undefined) delete m[key];
          else m[key] = value;
        }
        if (rng.bool(0.3)) m = withPollutionKeys(rng, m);
        if (rng.bool(0.3)) m[`extra_${rng.int(100)}`] = offTypeValue(rng);
      }
      let verdict: EnvelopeVerdict;
      try {
        verdict = evaluateCaptureEnvelope(m as unknown as CaptureEnvelopeMeasurements);
      } catch (error) {
        if (isJsonReachable(m)) {
          failures.push(`seed ${seed}: threw ${describeValue(error)} for ${describeValue(m)}`);
          table.record({
            seed,
            generator: "envelope.off-type",
            kind: "throw",
            outcome: "BROKEN",
            detail: `${describeValue(error)} for ${describeValue(m)}`,
          });
        } else {
          offTypeInProcessThrows.push(seed);
          table.record({
            seed,
            generator: "envelope.off-type",
            kind: "in-process-only-value-throws",
            outcome: "BROKEN",
            detail: `${describeValue(error)} for ${describeValue(m)}`,
          });
        }
        continue;
      }
      const problems = shapeProblems(verdict).map((p) => p.what);
      if (!isPrototypeClean()) problems.push("Object.prototype polluted");
      const again = stableJson(
        evaluateCaptureEnvelope(m as unknown as CaptureEnvelopeMeasurements),
      );
      if (again !== stableJson(verdict)) problems.push("non-deterministic for same input");
      problems.push(
        ...oracleMismatches(verdict, m, (d) => hasOffTypeInput(d, m) || hasNonFiniteInput(d, m)),
      );
      const offTypeMismatch = oracleMismatches(verdict, m, (d) => !hasOffTypeInput(d, m));
      const offTypeLeaks = verdict.dimensions
        .filter(
          (d) =>
            hasOffTypeInput(d.dimension, m) && d.measured !== null && !isFiniteNumber(d.measured),
        )
        .map((d) => `${d.dimension} measured=${describeValue(d.measured)}`);
      if (offTypeMismatch.length > 0 || offTypeLeaks.length > 0) {
        offTypeFailOpenDeviations.push(seed);
        table.record({
          seed,
          generator: "envelope.off-type",
          kind: "off-type-fail-open",
          outcome: "BROKEN",
          detail: [...offTypeMismatch, ...offTypeLeaks].join("; "),
        });
      }
      const infinityMismatch = oracleMismatches(
        verdict,
        m,
        (d) => !hasNonFiniteInput(d, m) || hasOffTypeInput(d, m),
      );
      if (infinityMismatch.length > 0) {
        table.record({
          seed,
          generator: "envelope.off-type",
          kind: "infinity-treated-as-measurement",
          outcome: "BROKEN",
          detail: infinityMismatch.join("; "),
        });
      }
      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.join("; ")} for ${describeValue(m)}`);
        table.record({
          seed,
          generator: "envelope.off-type",
          kind: "invariant",
          outcome: "BROKEN",
          detail: problems.join("; "),
        });
      } else {
        table.record({
          seed,
          generator: "envelope.off-type",
          kind: "invariants",
          outcome: "HELD",
          detail: `${verdict.overallWithCoverage} input=${describeValue(m)}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it.fails(
    "PINNED DEVIATION: a missing or non-numeric field should abstain, not read as SUPPORTED",
    () => {
      const partial = {} as CaptureEnvelopeMeasurements;
      const verdict = evaluateCaptureEnvelope(partial);
      expect(verdict.overall).toBe("SUPPORTED");
      expect(verdict.notMeasured).toEqual(DIMENSIONS);
      expect(offTypeFailOpenDeviations).toEqual([]);
      expect(offTypeInProcessThrows).toEqual([]);
    },
  );

  it("non-object roots (null/undefined/primitives) are recorded: the evaluator has no guard and throws TypeError", () => {
    const roots: unknown[] = [null, undefined, 0, "", "{}", true, 42n, Symbol("m")];
    roots.forEach((root, index) => {
      const seed = STRESS_SEED + 2_000_000 + index;
      try {
        const verdict = evaluateCaptureEnvelope(root as CaptureEnvelopeMeasurements);
        table.record({
          seed,
          generator: "envelope.root",
          kind: "root-non-object",
          outcome: "HELD",
          detail: `${describeValue(root)} → ${verdict.overallWithCoverage}`,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        offTypeRootThrows.push(seed);
        table.record({
          seed,
          generator: "envelope.root",
          kind: "root-non-object-throws",
          outcome: "BROKEN",
          detail: `${describeValue(root)} → ${describeValue(error)}`,
        });
      }
    });
    expect(
      offTypeRootThrows.length + table.rows.filter((r) => r.kind === "root-non-object").length,
    ).toBe(roots.length);
  });
});

describe("boundary-malformed stress: classifyDimension", () => {
  it(`direct value × threshold × ${STRESS_ITER} seeds: never throws, in-enum, matches reference for finite/null/NaN`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 3_000_000 + i;
      const rng = new SeededRng(seed);
      const [dimension, threshold] = rng.pick(THRESHOLDS);
      const value = rng.bool(0.7) ? inTypeNumber(rng, threshold) : offTypeValue(rng);
      let status: string;
      try {
        status = classifyDimension(value as number | null, threshold);
      } catch (error) {
        failures.push(`seed ${seed}: threw ${describeValue(error)}`);
        table.record({
          seed,
          generator: "classify",
          kind: "throw",
          outcome: "BROKEN",
          detail: String(error),
        });
        continue;
      }
      const problems: string[] = [];
      if (!ENVELOPE_STATUSES.has(status)) problems.push(`status ${status}`);
      if (classifyDimension(value as number | null, threshold) !== status)
        problems.push("non-deterministic");
      const expected = referenceStatus(value, threshold);
      const strict =
        value === null ||
        (typeof value === "number" && (Number.isFinite(value) || Number.isNaN(value)));
      if (strict && status !== expected)
        problems.push(`${dimension}(${describeValue(value)}) ${status} expected ${expected}`);
      if (!strict && status !== expected) {
        table.record({
          seed,
          generator: "classify",
          kind: "boundary-oracle-deviation",
          outcome: "BROKEN",
          detail: `${dimension}(${describeValue(value)}) ${status} expected ${expected}`,
        });
      }
      if (problems.length > 0) {
        failures.push(`seed ${seed}: ${problems.join("; ")}`);
        table.record({
          seed,
          generator: "classify",
          kind: "invariant",
          outcome: "BROKEN",
          detail: problems.join("; "),
        });
      } else {
        table.record({
          seed,
          generator: "classify",
          kind: "invariants",
          outcome: "HELD",
          detail: `${dimension}(${describeValue(value)})=${status}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });
});
