import { afterAll, describe, expect, it } from "vitest";
import {
  clippedPixelFraction,
  laplacianVariance,
  meanAbsDiff,
  meanLuma,
  spatialStd,
} from "../../src/clipProbe.js";
import {
  clipTailFractions,
  meanSpatialGradient,
  motionExtent,
  temporalMeanFrame,
} from "../../src/g08EvidenceSignals.js";
import {
  computeG08Metrics,
  computeG08MetricsByFamily,
  evaluateG08Promotion,
  evidenceSufficient,
  type G08EvalRow,
  type G08GateMetrics,
  type G08RateWithCounts,
} from "../../src/g08Gate.js";
import {
  firstBandFlip,
  isMonotone,
  ruleOfThreeUpperBound,
  trialsForUpperBound,
  type LadderRow,
} from "../../src/f18Analysis.js";
import {
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
} from "../../src/g08LabelSchema.js";
import {
  describeValue,
  isFiniteNumber,
  isPrototypeClean,
  offTypeValue,
  ResultTable,
  SeededRng,
  stableJson,
  STRESS_ITER,
  STRESS_OUT,
  STRESS_SEED,
  writeTable,
} from "./boundaryMalformedSupport.js";

/**
 * boundary-malformed stress — numeric helpers that sit behind the evaluator
 * and the g08 gate: pixel statistics fed by ffmpeg raw frames (length /
 * dimension mismatches, empty frames, 0/1/2-pixel edges), g08 metric
 * aggregation over malformed rows, and the F18 arithmetic helpers with
 * NaN/Infinity/-0/empty inputs. Invariants: never throw, no NaN/Infinity in
 * a reported value, every rate carries its N, numerator ≤ denominator,
 * deterministic.
 */

const table = new ResultTable();
const pixelNaNSeeds: number[] = [];
const f18DomainSeeds: number[] = [];

afterAll(() => {
  writeTable(STRESS_OUT, "numeric", table);
  process.stderr.write(
    `[stress numeric] executed=${table.rows.length} broken=${table.broken().length} byKind=${JSON.stringify(table.countByKind())}\n`,
  );
});

function rateProblems(name: string, r: G08RateWithCounts): string[] {
  const out: string[] = [];
  if (!Number.isSafeInteger(r.numerator) || r.numerator < 0)
    out.push(`${name}.numerator=${describeValue(r.numerator)}`);
  if (!Number.isSafeInteger(r.denominator) || r.denominator < 0)
    out.push(`${name}.denominator=${describeValue(r.denominator)}`);
  if (r.numerator > r.denominator) out.push(`${name} numerator>denominator`);
  if (r.denominator === 0 && r.rate !== null) out.push(`${name} rate without N`);
  if (r.denominator > 0 && (!isFiniteNumber(r.rate) || r.rate < 0 || r.rate > 1)) {
    out.push(`${name}.rate=${describeValue(r.rate)}`);
  }
  return out;
}

function metricsProblems(rows: unknown[], m: G08GateMetrics): string[] {
  const out: string[] = [];
  if (m.n !== rows.length) out.push(`n=${m.n} rows=${rows.length}`);
  for (const key of [
    "nAmbiguous",
    "nSafe",
    "nDegraded",
    "nUnsafe",
    "distinctSessionKeys",
  ] as const) {
    if (!Number.isSafeInteger(m[key]) || m[key] < 0 || m[key] > rows.length)
      out.push(`${key}=${describeValue(m[key])}`);
  }
  if (m.nAmbiguous + m.nSafe + m.nDegraded + m.nUnsafe > m.n) out.push("label counts exceed n");
  for (const key of [
    "falseSafeRate",
    "falseRejectRate",
    "missedDegradationRate",
    "usableRateGivenSupported",
    "usableRateGivenFlagged",
    "silentFailureRateGivenSupported",
  ] as const) {
    out.push(...rateProblems(key, m[key]));
  }
  if (m.falseSafeRate.denominator !== m.nUnsafe) out.push("falseSafe denominator ≠ nUnsafe");
  if (m.falseRejectRate.denominator !== m.nSafe) out.push("falseReject denominator ≠ nSafe");
  if (m.missedDegradationRate.denominator !== m.nDegraded)
    out.push("missedDegradation denominator ≠ nDegraded");
  if (m.silentFailureRateGivenSupported.denominator !== m.usableRateGivenSupported.denominator) {
    out.push("supported-conditioned denominators disagree");
  }
  return out;
}

function malformedRow(rng: SeededRng, index: number): Record<string, unknown> {
  const row: Record<string, unknown> = {
    labelId: `L${index}`,
    family: rng.pick(G08_BYPASS_FAMILIES),
    sessionKey: `S${rng.int(4)}`,
    capture: rng.pick(G08_CAPTURE_LABELS),
    downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
    envelopeOverall: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const),
  };
  const corrupt = rng.int(4);
  for (let k = 0; k < corrupt; k += 1) {
    const key = rng.pick(Object.keys(row));
    const value = rng.bool(0.5)
      ? offTypeValue(rng)
      : rng.pick(["", "supported", "SAFE ", "NOT_MEASURED", "safe", "\u0000"]);
    if (value === undefined) delete row[key];
    else row[key] = value;
  }
  return row;
}

describe("boundary-malformed stress: g08 metrics over malformed rows", () => {
  it(`rows with wrong-typed/missing/near-miss fields × ${STRESS_ITER} seeds: never throw, counts bounded, rates carry N, deterministic`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 30_000_000 + i;
      const rng = new SeededRng(seed);
      const count = rng.bool(0.1) ? 0 : rng.bool(0.05) ? 5000 : rng.intBetween(1, 40);
      const rows: unknown[] = [];
      for (let r = 0; r < count; r += 1) rows.push(malformedRow(rng, r));
      if (rng.bool(0.1)) rows.push(offTypeValue(rng) ?? null);
      try {
        const typed = rows as G08EvalRow[];
        const m = computeG08Metrics(typed);
        const problems = metricsProblems(rows, m);
        if (stableJson(computeG08Metrics(typed)) !== stableJson(m))
          problems.push("non-deterministic");
        const evidence = evidenceSufficient(m);
        if (typeof evidence.sufficient !== "boolean" || !Array.isArray(evidence.reasons))
          problems.push("evidence shape");
        const family = rng.pick(G08_BYPASS_FAMILIES);
        const verdict = evaluateG08Promotion(family, m, m);
        if (
          verdict.family !== family ||
          typeof verdict.decidable !== "boolean" ||
          typeof verdict.promote !== "boolean"
        ) {
          problems.push("promotion verdict shape");
        }
        if (verdict.promote && !verdict.decidable) problems.push("promote while undecidable");
        if (verdict.promote && verdict.reasons.length > 0) problems.push("promote with reasons");
        if (!verdict.promote && verdict.reasons.length === 0)
          problems.push("reject without reasons");
        if (verdict.decidable && !evidence.sufficient) problems.push("decidable without evidence");
        const byFamily = computeG08MetricsByFamily(typed);
        const familySum = G08_BYPASS_FAMILIES.reduce((acc, f) => acc + byFamily[f].n, 0);
        if (familySum > m.n) problems.push("family partition exceeds n");
        if (!isPrototypeClean()) problems.push("Object.prototype polluted");
        if (problems.length > 0) {
          failures.push(`seed ${seed}: ${problems.join("; ")}`);
          table.record({
            seed,
            generator: "metrics",
            kind: "invariant",
            outcome: "BROKEN",
            detail: problems.join("; "),
          });
        } else {
          table.record({
            seed,
            generator: "metrics",
            kind: "invariants",
            outcome: "HELD",
            detail: `rows=${rows.length} decidable=${verdict.decidable} promote=${verdict.promote}`,
          });
        }
      } catch (error) {
        const nullRow = rows.some((r) => r === null || typeof r !== "object");
        if (nullRow) {
          table.record({
            seed,
            generator: "metrics",
            kind: "non-object-row-throws",
            outcome: "BROKEN",
            detail: describeValue(error),
          });
        } else {
          failures.push(`seed ${seed}: threw ${describeValue(error)}`);
          table.record({
            seed,
            generator: "metrics",
            kind: "throw",
            outcome: "BROKEN",
            detail: describeValue(error),
          });
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

interface PixelCase {
  width: number;
  height: number;
  frame: Uint8Array;
  other: Uint8Array;
  consistent: boolean;
}

function pixelCase(rng: SeededRng): PixelCase {
  const dims = [0, 1, 2, 3, 4, 5, 7, 8, 16, 17, 31, 32, 64];
  const width = rng.pick(dims);
  const height = rng.pick(dims);
  const exact = width * height;
  const lengthChoice = rng.int(6);
  const length =
    lengthChoice === 0
      ? exact
      : lengthChoice === 1
        ? Math.max(0, exact - 1)
        : lengthChoice === 2
          ? exact + 1
          : lengthChoice === 3
            ? 0
            : lengthChoice === 4
              ? rng.int(exact + 10)
              : exact;
  const fill = rng.int(5);
  const frame =
    fill === 0
      ? new Uint8Array(length)
      : fill === 1
        ? new Uint8Array(length).fill(255)
        : fill === 2
          ? new Uint8Array(length).fill(16)
          : rng.bytes(length);
  const other = rng.bool(0.7) ? rng.bytes(length) : rng.bytes(rng.int(length + 5));
  return { width, height, frame, other, consistent: length === exact && other.length === length };
}

function finiteOrNull(value: unknown): boolean {
  return value === null || isFiniteNumber(value);
}

describe("boundary-malformed stress: pixel statistics on truncated/oversized/empty frames", () => {
  it(`frames × ${STRESS_ITER} seeds: never throw, finite when frame matches its dimensions, deterministic`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 40_000_000 + i;
      const c = pixelCase(new SeededRng(seed));
      const label = `${c.width}x${c.height} len=${c.frame.length}/${c.other.length}`;
      try {
        const outputs: Record<string, unknown> = {
          meanLuma: meanLuma(c.frame),
          laplacianVariance: laplacianVariance(c.frame, c.width, c.height),
          meanAbsDiff: meanAbsDiff(c.frame, c.other),
          spatialStd: spatialStd(c.frame),
          clippedPixelFraction: clippedPixelFraction([c.frame, c.other]),
          clippedEmpty: clippedPixelFraction([]),
          tails: clipTailFractions(c.frame),
          meanSpatialGradient: meanSpatialGradient(c.frame, c.width, c.height),
          motionExtent: motionExtent(c.frame, c.other, c.width, c.height),
          temporalMean: temporalMeanFrame([c.frame, c.other]).length,
          temporalMeanEmpty: temporalMeanFrame([]).length,
        };
        const flat: Array<[string, unknown]> = [];
        for (const [key, value] of Object.entries(outputs)) {
          if (value !== null && typeof value === "object") {
            for (const [sub, inner] of Object.entries(value)) flat.push([`${key}.${sub}`, inner]);
          } else flat.push([key, value]);
        }
        const nonFinite = flat
          .filter(([, v]) => !finiteOrNull(v))
          .map(([k, v]) => `${k}=${describeValue(v)}`);
        const problems: string[] = [];
        if (outputs.clippedEmpty !== null) problems.push("clippedPixelFraction([]) must be null");
        if (outputs.temporalMeanEmpty !== 0) problems.push("temporalMeanFrame([]) must be empty");
        for (const [k, v] of flat) {
          if (
            typeof v === "number" &&
            Number.isFinite(v) &&
            (k.endsWith("Fraction") ||
              k.startsWith("tails.") ||
              k === "coverage" ||
              k === "motionExtent.coverage") &&
            (v < 0 || v > 1)
          ) {
            problems.push(`${k}=${v} outside [0,1]`);
          }
        }
        if (c.consistent && nonFinite.length > 0)
          problems.push(`non-finite on consistent input: ${nonFinite.join(",")}`);
        const replay = pixelCase(new SeededRng(seed));
        if (
          stableJson(laplacianVariance(replay.frame, replay.width, replay.height)) !==
          stableJson(outputs.laplacianVariance)
        )
          problems.push("non-deterministic");
        if (!c.consistent && nonFinite.length > 0) {
          pixelNaNSeeds.push(seed);
          table.record({
            seed,
            generator: "pixel",
            kind: "mismatched-frame-nan",
            outcome: "BROKEN",
            detail: `${label}: ${nonFinite.join(",")}`,
          });
        }
        if (problems.length > 0) {
          failures.push(`seed ${seed} [${label}]: ${problems.join("; ")}`);
          table.record({
            seed,
            generator: "pixel",
            kind: "invariant",
            outcome: "BROKEN",
            detail: `${label}: ${problems.join("; ")}`,
          });
        } else {
          table.record({
            seed,
            generator: "pixel",
            kind: "invariants",
            outcome: "HELD",
            detail: label,
          });
        }
      } catch (error) {
        failures.push(`seed ${seed} [${label}]: threw ${describeValue(error)}`);
        table.record({
          seed,
          generator: "pixel",
          kind: "throw",
          outcome: "BROKEN",
          detail: `${label}: ${describeValue(error)}`,
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("a frame shorter than width×height yields NaN from the raw-frame statistics (recorded, no upstream caller can produce it: extractSampledGrayFrames slices exact frames)", () => {
    const short = new Uint8Array(5);
    expect(Number.isNaN(laplacianVariance(short, 4, 4))).toBe(true);
    expect(Number.isNaN(meanAbsDiff(new Uint8Array(4), new Uint8Array(2)))).toBe(true);
  });
});

function numberPalette(rng: SeededRng): number {
  const palette = [
    0,
    -0,
    1,
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.MAX_VALUE,
    Number.MIN_VALUE,
    Number.MAX_SAFE_INTEGER,
    1e-9,
    1 - 1e-16,
    rng.next(),
    rng.int(1000),
  ];
  return rng.pick(palette);
}

describe("boundary-malformed stress: F18 arithmetic helpers", () => {
  it(`isMonotone/ruleOfThree/trialsForUpperBound/firstBandFlip × ${STRESS_ITER} seeds: never throw, finite in-domain, deterministic`, () => {
    const failures: string[] = [];
    for (let i = 0; i < STRESS_ITER; i += 1) {
      const seed = STRESS_SEED + 50_000_000 + i;
      const rng = new SeededRng(seed);
      const values = Array.from({ length: rng.int(6) }, () => numberPalette(rng));
      const n = numberPalette(rng);
      const target = numberPalette(rng);
      const rows: LadderRow[] = Array.from({ length: rng.int(6) }, (_, index) => ({
        unitId: `u${index}`,
        sessionKey: "s",
        dimension: "brightness",
        injected: rng.bool(0.3) ? null : numberPalette(rng),
        measured: rng.bool(0.3) ? null : numberPalette(rng),
        bandStatus: rng.pick(["SUPPORTED", "DEGRADED", "UNSUPPORTED", "", "bogus"]),
      }));
      try {
        const monoUp = isMonotone(values, "increasing");
        const monoDown = isMonotone(values, "decreasing");
        const bound = ruleOfThreeUpperBound(n);
        const trials = trialsForUpperBound(target);
        const flip = firstBandFlip(rows);
        const problems: string[] = [];
        if (typeof monoUp !== "boolean" || typeof monoDown !== "boolean")
          problems.push("isMonotone non-boolean");
        if (values.length >= 2 && values.every((v) => Number.isFinite(v)) && monoUp && monoDown) {
          problems.push("both strictly increasing and decreasing");
        }
        const nInDomain = Number.isFinite(n) && n >= 1;
        if (nInDomain && (!isFiniteNumber(bound) || bound < 0 || bound > 1))
          problems.push(`ruleOfThree(${describeValue(n)})=${describeValue(bound)}`);
        const targetInDomain = Number.isFinite(target) && target >= Number.EPSILON && target < 1;
        if (targetInDomain && (!Number.isSafeInteger(trials) || trials < 1))
          problems.push(`trials(${describeValue(target)})=${describeValue(trials)}`);
        if (flip !== null && typeof flip !== "number") problems.push("firstBandFlip type");
        if (!nInDomain && !finiteOrNull(bound)) {
          f18DomainSeeds.push(seed);
          table.record({
            seed,
            generator: "f18",
            kind: "out-of-domain-nonfinite",
            outcome: "BROKEN",
            detail: `ruleOfThree(${describeValue(n)})=${describeValue(bound)}`,
          });
        }
        if (!targetInDomain && !Number.isSafeInteger(trials)) {
          f18DomainSeeds.push(seed);
          table.record({
            seed,
            generator: "f18",
            kind: "out-of-domain-nonfinite",
            outcome: "BROKEN",
            detail: `trials(${describeValue(target)})=${describeValue(trials)}`,
          });
        }
        if (
          isMonotone(values, "increasing") !== monoUp ||
          !Object.is(ruleOfThreeUpperBound(n), bound)
        )
          problems.push("non-deterministic");
        if (problems.length > 0) {
          failures.push(`seed ${seed}: ${problems.join("; ")}`);
          table.record({
            seed,
            generator: "f18",
            kind: "invariant",
            outcome: "BROKEN",
            detail: problems.join("; "),
          });
        } else {
          table.record({
            seed,
            generator: "f18",
            kind: "invariants",
            outcome: "HELD",
            detail: `n=${describeValue(n)} target=${describeValue(target)} rows=${rows.length}`,
          });
        }
      } catch (error) {
        failures.push(`seed ${seed}: threw ${describeValue(error)}`);
        table.record({
          seed,
          generator: "f18",
          kind: "throw",
          outcome: "BROKEN",
          detail: describeValue(error),
        });
      }
    }
    expect(failures).toEqual([]);
  });

  it("out-of-domain inputs to the F18 helpers return NaN/Infinity (recorded; callers pass literal constants)", () => {
    expect(Number.isNaN(ruleOfThreeUpperBound(Number.NaN))).toBe(true);
    expect(Number.isSafeInteger(trialsForUpperBound(2))).toBe(false);
    expect(Number.isSafeInteger(trialsForUpperBound(0))).toBe(false);
    expect(Number.isSafeInteger(trialsForUpperBound(Number.NaN))).toBe(false);
  });
});
