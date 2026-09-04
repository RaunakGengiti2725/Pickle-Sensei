import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ENVELOPE_DIMENSIONS,
  type EnvelopeDimension,
  type EnvelopeStatus,
} from "@pickle/shared-types";
import {
  CAPTURE_ENVELOPE_THRESHOLDS,
  type CaptureEnvelopeMeasurements,
  type DimensionThreshold,
  type EnvelopeBand,
  clippedPixelFraction,
  computeBypassSignals,
  computeG08Metrics,
  computeG08MetricsByFamily,
  evaluateCaptureEnvelope,
  evaluateG08Promotion,
  evidenceSufficient,
  G08_BYPASS_FAMILIES,
  G08_CAPTURE_LABELS,
  G08_DOWNSTREAM_OUTCOMES,
  G08_LABEL_SCHEMA_VERSION,
  type G08EvalRow,
  type G08GateMetrics,
  laplacianVariance,
  meanAbsDiff,
  meanLuma,
  measureClip,
  probeClipStream,
  spatialStd,
  validateG08LabelFile,
} from "../../src/index.js";
import { probeFrameIntervalCv } from "../../src/clipProbe.js";
import {
  clipTailFractions,
  meanSpatialGradient,
  motionExtent,
  temporalMeanFrame,
} from "../../src/g08EvidenceSignals.js";
import { canonicalJson, runCampaign, type CampaignReport } from "./leakHarness.js";
import { seededRng, type SeededRng } from "./seededRng.js";

/**
 * Stress campaigns for @pickle/capture-envelope (lens: long-run leak).
 * Every campaign is a seeded generator + independent invariant oracle; the
 * harness in leakHarness.ts turns it into ≥N in-process invocations with
 * heap/resource/timing sampling. No labels are fabricated anywhere here:
 * synthetic inputs are checked against MATHEMATICAL properties (bands,
 * bounds, determinism, finiteness), never against invented ground truth.
 */

// ---------------------------------------------------------------------------
// Campaign 1: evaluateCaptureEnvelope over seeded measurements
// ---------------------------------------------------------------------------

const MEASUREMENT_KEYS = [
  "frameWidthPx",
  "frameHeightPx",
  "avgFrameRateFps",
  "brightnessMeanLuma",
  "brightnessStdLuma",
  "laplacianVarianceMedian",
  "meanAbsFrameDiff",
  "denoiseSurvivalRatio",
  "clippedPixelFraction",
  "contrastNormalizedFrameDiff",
  "frameIntervalCv",
  "clipDurationMs",
  "playerPixelHeightFraction",
  "playerMeanJointVisibility",
] as const satisfies ReadonlyArray<keyof CaptureEnvelopeMeasurements>;

/** Which measurement field feeds which dimension (the checker's contract). */
const DIMENSION_SOURCE: Record<EnvelopeDimension, keyof CaptureEnvelopeMeasurements | "min_wh"> = {
  resolution: "min_wh",
  frame_rate: "avgFrameRateFps",
  brightness: "brightnessMeanLuma",
  exposure_clipping: "clippedPixelFraction",
  exposure_stability: "brightnessStdLuma",
  motion_blur: "laplacianVarianceMedian",
  sensor_noise: "denoiseSurvivalRatio",
  camera_motion: "meanAbsFrameDiff",
  camera_shake: "contrastNormalizedFrameDiff",
  timing_stability: "frameIntervalCv",
  clip_duration: "clipDurationMs",
  player_pixel_height: "playerPixelHeightFraction",
  player_visibility: "playerMeanJointVisibility",
};

const PATHOLOGICAL_VALUES = [
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
  -0,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  2 ** 53,
  -1,
];

function bandEdge(band: EnvelopeBand, rng: SeededRng): number | null {
  const edges: number[] = [];
  if (band.min !== undefined) edges.push(band.min, band.min - Number.EPSILON * 64, band.min + 1e-9);
  if (band.max !== undefined) edges.push(band.max, band.max + Number.EPSILON * 64, band.max - 1e-9);
  return edges.length > 0 ? rng.pick(edges) : null;
}

function insideBand(band: EnvelopeBand, rng: SeededRng): number {
  const lo = band.min ?? (band.max ?? 0) - 1000;
  const hi = band.max ?? (band.min ?? 0) + 1000;
  return rng.float(lo, hi);
}

function outsideBands(threshold: DimensionThreshold, rng: SeededRng): number {
  const d = threshold.degraded;
  if (d.min !== undefined && (d.max === undefined || rng.chance(0.5)))
    return d.min - rng.float(1e-6, 1000);
  if (d.max !== undefined) return d.max + rng.float(1e-6, 1000);
  return rng.float(-1e6, 1e6);
}

export type MeasurementProfile = "finite" | "pathological";

/**
 * Seeded measurement vector. `finite` draws only null or finite numbers
 * (including exact band edges); `pathological` additionally injects ±Infinity,
 * NaN, -0 and extreme magnitudes.
 */
export function generateMeasurements(
  seed: number,
  profile: MeasurementProfile,
): CaptureEnvelopeMeasurements {
  const rng = seededRng(seed);
  const out: Partial<Record<keyof CaptureEnvelopeMeasurements, number | null>> = {};
  const thresholdFor = (key: keyof CaptureEnvelopeMeasurements): DimensionThreshold => {
    const dimension = (Object.keys(DIMENSION_SOURCE) as EnvelopeDimension[]).find(
      (d) => DIMENSION_SOURCE[d] === key,
    );
    return dimension
      ? CAPTURE_ENVELOPE_THRESHOLDS[dimension]
      : CAPTURE_ENVELOPE_THRESHOLDS.resolution;
  };
  for (const key of MEASUREMENT_KEYS) {
    const threshold = thresholdFor(key);
    const roll = rng.next();
    let value: number | null;
    if (roll < 0.15) value = null;
    else if (roll < 0.45) value = insideBand(threshold.supported, rng);
    else if (roll < 0.6) value = insideBand(threshold.degraded, rng);
    else if (roll < 0.75) value = outsideBands(threshold, rng);
    else if (roll < 0.9) {
      value = bandEdge(rng.chance(0.5) ? threshold.supported : threshold.degraded, rng);
    } else if (profile === "pathological") value = rng.pick(PATHOLOGICAL_VALUES);
    else value = rng.float(-1e6, 1e6);
    out[key] = value;
  }
  return out as CaptureEnvelopeMeasurements;
}

function oracleInBand(value: number, band: EnvelopeBand): boolean {
  if (band.min !== undefined && value < band.min) return false;
  if (band.max !== undefined && value > band.max) return false;
  return true;
}

function oracleStatus(value: number | null, threshold: DimensionThreshold): EnvelopeStatus {
  if (value === null || Number.isNaN(value)) return "NOT_MEASURED";
  if (oracleInBand(value, threshold.supported)) return "SUPPORTED";
  if (oracleInBand(value, threshold.degraded)) return "DEGRADED";
  return "UNSUPPORTED";
}

function oracleMeasured(
  dimension: EnvelopeDimension,
  m: CaptureEnvelopeMeasurements,
): number | null {
  const source = DIMENSION_SOURCE[dimension];
  if (source === "min_wh") {
    return m.frameWidthPx !== null && m.frameHeightPx !== null
      ? Math.min(m.frameWidthPx, m.frameHeightPx)
      : null;
  }
  return m[source];
}

const SEVERITY: Record<EnvelopeStatus, number> = {
  NOT_MEASURED: -1,
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
};

/** Invariant check for one measurement vector; returns violations. */
export function checkEnvelopeInvariants(m: CaptureEnvelopeMeasurements): string[] {
  const violations: string[] = [];
  const first = evaluateCaptureEnvelope(m);
  const second = evaluateCaptureEnvelope(m);
  if (canonicalJson(first) !== canonicalJson(second)) violations.push("nondeterministic verdict");

  if (first.dimensions.length !== ENVELOPE_DIMENSIONS.length) {
    violations.push(`dimension count ${first.dimensions.length}`);
  }
  const order = first.dimensions.map((d) => d.dimension);
  if (order.join(",") !== ENVELOPE_DIMENSIONS.join(",")) {
    violations.push(`dimension order/identity drifted: ${order.join(",")}`);
  }

  let worst: EnvelopeStatus = "SUPPORTED";
  const expectedNotMeasured: EnvelopeDimension[] = [];
  for (const dimension of ENVELOPE_DIMENSIONS) {
    const threshold: DimensionThreshold = CAPTURE_ENVELOPE_THRESHOLDS[dimension];
    const expectedMeasured = oracleMeasured(dimension, m);
    const expectedStatus = oracleStatus(expectedMeasured, threshold);
    const actual = first.dimensions.find((d) => d.dimension === dimension);
    if (!actual) {
      violations.push(`${dimension}: missing`);
      continue;
    }
    if (actual.status !== expectedStatus) {
      violations.push(`${dimension}: status ${actual.status} != oracle ${expectedStatus}`);
    }
    if (actual.thresholdId !== threshold.id || actual.unit !== threshold.unit) {
      violations.push(`${dimension}: threshold id/unit mismatch`);
    }
    if (expectedStatus === "NOT_MEASURED") {
      if (actual.measured !== null) violations.push(`${dimension}: NOT_MEASURED with measured`);
      expectedNotMeasured.push(dimension);
    } else {
      if (SEVERITY[expectedStatus] > SEVERITY[worst]) worst = expectedStatus;
      if (actual.measured === null) {
        violations.push(`${dimension}: measured dimension reports measured=null`);
      } else if (!Number.isFinite(actual.measured)) {
        violations.push(
          `${dimension}: nonfinite measured ${String(actual.measured)} passes through as ${actual.status}`,
        );
      } else if (!Object.is(actual.measured, expectedMeasured)) {
        violations.push(`${dimension}: measured ${actual.measured} != source ${expectedMeasured}`);
      }
    }
  }
  if (first.overall !== worst) violations.push(`overall ${first.overall} != oracle ${worst}`);
  const expectedCoverage =
    worst === "SUPPORTED" && expectedNotMeasured.length > 0 ? "SUPPORTED_UNMEASURED" : worst;
  if (first.overallWithCoverage !== expectedCoverage) {
    violations.push(`overallWithCoverage ${first.overallWithCoverage} != ${expectedCoverage}`);
  }
  if (first.notMeasured.join(",") !== expectedNotMeasured.join(",")) {
    violations.push(
      `notMeasured ${first.notMeasured.join(",")} != ${expectedNotMeasured.join(",")}`,
    );
  }
  if (!first.provisional || !/provisional/.test(first.thresholdsVersion)) {
    violations.push("verdict not marked provisional");
  }
  // JSON round trip must not silently change the verdict (Infinity → null).
  // -0 → 0 is numerically harmless and deliberately ignored here.
  const roundTrip = JSON.parse(JSON.stringify(first)) as typeof first;
  const negZeroNormalized = canonicalJson(first).replaceAll('"__negzero"', "0");
  if (canonicalJson(roundTrip) !== negZeroNormalized) {
    violations.push("JSON round trip alters verdict (non-finite measured → null)");
  }
  return violations;
}

export function envelopeCampaign(
  campaignSeed: number,
  iterations: number,
  profile: MeasurementProfile,
): CampaignReport {
  return runCampaign({
    name: `envelope-${profile}`,
    campaignSeed,
    iterations,
    iterate: (seed) => {
      const m = generateMeasurements(seed, profile);
      return { violations: checkEnvelopeInvariants(m), scenario: canonicalJson(m) };
    },
  });
}

// ---------------------------------------------------------------------------
// Campaign 2: pixel math over seeded synthetic frames
// ---------------------------------------------------------------------------

type FrameKind = "flat" | "gradient" | "checker" | "noise" | "bimodal" | "hot_pixel" | "shifted";

const FRAME_KINDS: readonly FrameKind[] = [
  "flat",
  "gradient",
  "checker",
  "noise",
  "bimodal",
  "hot_pixel",
  "shifted",
];

function makeFrame(kind: FrameKind, width: number, height: number, rng: SeededRng): Uint8Array {
  const frame = new Uint8Array(width * height);
  const base = rng.int(0, 255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = y * width + x;
      switch (kind) {
        case "flat":
          frame[i] = base;
          break;
        case "gradient":
          frame[i] = width > 1 ? Math.round((x / (width - 1)) * 255) : base;
          break;
        case "checker":
          frame[i] = (x + y) % 2 === 0 ? 0 : 255;
          break;
        case "noise":
          frame[i] = rng.int(0, 255);
          break;
        case "bimodal":
          frame[i] = x < width / 2 ? rng.int(0, 16) : rng.int(235, 255);
          break;
        case "hot_pixel":
          frame[i] = 128;
          break;
        case "shifted":
          frame[i] = (x * 7 + y * 13 + base) & 0xff;
          break;
      }
    }
  }
  if (kind === "hot_pixel" && frame.length > 0) frame[rng.int(0, frame.length - 1)] = 255;
  return frame;
}

function expectClose(a: number, b: number, eps = 1e-9): boolean {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

export function checkPixelInvariants(seed: number): { violations: string[]; scenario: string } {
  const rng = seededRng(seed);
  const violations: string[] = [];
  // Include degenerate geometries: 0x0, 1x1, 2xN, Nx2 and up to 96x96.
  const width = rng.chance(0.1) ? rng.int(0, 2) : rng.int(3, 96);
  const height = rng.chance(0.1) ? rng.int(0, 2) : rng.int(3, 96);
  const kindA = rng.pick(FRAME_KINDS);
  const kindB = rng.pick(FRAME_KINDS);
  const frameCount = rng.int(1, 6);
  // Frames share one backing buffer exactly like extractSampledGrayFrames.
  const backing = new Uint8Array(width * height * frameCount);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    const kind = index === 0 ? kindA : index === 1 ? kindB : rng.pick(FRAME_KINDS);
    const generated = makeFrame(kind, width, height, rng);
    const view = backing.subarray(index * width * height, (index + 1) * width * height);
    view.set(generated);
    frames.push(view);
  }
  const a = frames[0]!;
  const b = frames[1] ?? a;
  const scenario = `${width}x${height} frames=${frameCount} kinds=${kindA},${kindB}`;

  const luma = meanLuma(a);
  let exactSum = 0;
  for (let i = 0; i < a.length; i += 1) exactSum += a[i]!;
  const exactMean = a.length > 0 ? exactSum / a.length : 0;
  if (!Number.isFinite(luma) || luma < 0 || luma > 255) violations.push(`meanLuma ${luma}`);
  else if (!expectClose(luma, exactMean)) violations.push(`meanLuma ${luma} != ${exactMean}`);
  if (!Object.is(meanLuma(a), luma)) violations.push("meanLuma nondeterministic");

  const lap = laplacianVariance(a, width, height);
  if (!Number.isFinite(lap) || lap < 0) violations.push(`laplacianVariance ${lap}`);
  if ((width < 3 || height < 3) && lap !== 0) violations.push(`laplacianVariance ${lap} on <3px`);
  if (kindA === "flat" && lap !== 0) violations.push(`laplacianVariance ${lap} on flat frame`);
  if (!Object.is(laplacianVariance(a, width, height), lap)) {
    violations.push("laplacianVariance nondeterministic");
  }

  const diff = meanAbsDiff(a, b);
  if (!Number.isFinite(diff) || diff < 0 || diff > 255) violations.push(`meanAbsDiff ${diff}`);
  if (!Object.is(meanAbsDiff(b, a), diff)) violations.push("meanAbsDiff asymmetric");
  if (meanAbsDiff(a, a) !== 0) violations.push("meanAbsDiff(a,a) != 0");

  const std = spatialStd(a);
  if (!Number.isFinite(std) || std < 0 || std > 127.5 + 1e-9) violations.push(`spatialStd ${std}`);
  if (kindA === "flat" && std !== 0) violations.push(`spatialStd ${std} on flat frame`);

  const clipped = clippedPixelFraction(frames);
  if (a.length === 0) {
    if (clipped !== null) violations.push(`clippedPixelFraction ${clipped} on empty frames`);
  } else if (clipped === null || !Number.isFinite(clipped) || clipped < 0 || clipped > 1) {
    violations.push(`clippedPixelFraction ${clipped}`);
  } else if (kindA === "checker" && frameCount === 1 && clipped !== 1) {
    violations.push(`clippedPixelFraction ${clipped} on pure 0/255 checker`);
  }
  if (clippedPixelFraction([]) !== null) violations.push("clippedPixelFraction([]) != null");

  const tails = clipTailFractions(a);
  if (tails.low < 0 || tails.high < 0 || tails.low + tails.high > 1 + 1e-12) {
    violations.push(`clipTailFractions ${tails.low}/${tails.high}`);
  }

  const gradient = meanSpatialGradient(a, width, height);
  if (!Number.isFinite(gradient) || gradient < 0 || gradient > 255) {
    violations.push(`meanSpatialGradient ${gradient}`);
  }
  if (kindA === "flat" && gradient !== 0) violations.push(`meanSpatialGradient ${gradient} flat`);

  const extent = motionExtent(a, b, width, height);
  for (const [name, value] of Object.entries(extent)) {
    if (!Number.isFinite(value) || value < 0 || value > 1)
      violations.push(`motionExtent.${name} ${value}`);
  }
  if (extent.heightFraction * extent.widthFraction + 1e-12 < extent.coverage) {
    violations.push("motionExtent bounding box smaller than active coverage");
  }
  const noMotion = motionExtent(a, a, width, height);
  if (noMotion.coverage !== 0 || noMotion.heightFraction !== 0 || noMotion.widthFraction !== 0) {
    violations.push("motionExtent(a,a) reports motion");
  }

  if (a.length > 0) {
    const meanFrame = temporalMeanFrame(frames);
    if (meanFrame.length !== a.length) violations.push("temporalMeanFrame length");
    const identical = temporalMeanFrame([a, a, a]);
    for (let i = 0; i < a.length; i += 1) {
      if (identical[i] !== a[i]) {
        violations.push("temporalMeanFrame of identical frames != frame");
        break;
      }
    }
  }
  return { violations, scenario };
}

export function pixelCampaign(campaignSeed: number, iterations: number): CampaignReport {
  return runCampaign({
    name: "pixel-math",
    campaignSeed,
    iterations,
    iterate: (seed) => checkPixelInvariants(seed),
  });
}

// ---------------------------------------------------------------------------
// Campaign 3: g08 frozen gate metrics over seeded evaluation rows
// ---------------------------------------------------------------------------

const KNOWN_OUTCOMES = new Set([
  "USABLE",
  "DEGRADED_RESULT",
  "UNUSABLE_DISCLOSED",
  "SILENT_FAILURE",
]);
const OVERALLS = ["SUPPORTED", "DEGRADED", "UNSUPPORTED"] as const;

function generateRows(rng: SeededRng, count: number): G08EvalRow[] {
  const rows: G08EvalRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      labelId: `g08-label-${i}`,
      family: rng.pick(G08_BYPASS_FAMILIES),
      sessionKey: `s${rng.int(0, 5)}`,
      capture: rng.pick(G08_CAPTURE_LABELS),
      downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
      envelopeOverall: rng.pick(OVERALLS),
    });
  }
  return rows;
}

function checkRate(name: string, r: G08GateMetrics[keyof G08GateMetrics]): string[] {
  if (typeof r !== "object") return [];
  const out: string[] = [];
  if (r.numerator < 0 || r.denominator < 0 || r.numerator > r.denominator) {
    out.push(`${name} ${r.numerator}/${r.denominator}`);
  }
  if (r.denominator === 0 && r.rate !== null) out.push(`${name} rate without N`);
  if (
    r.denominator > 0 &&
    (r.rate === null || !Number.isFinite(r.rate) || r.rate < 0 || r.rate > 1)
  ) {
    out.push(`${name} rate ${String(r.rate)}`);
  }
  if (r.denominator > 0 && r.rate !== null && !expectClose(r.rate, r.numerator / r.denominator)) {
    out.push(`${name} rate != numerator/denominator`);
  }
  return out;
}

export function checkG08Invariants(seed: number): { violations: string[]; scenario: string } {
  const rng = seededRng(seed);
  const violations: string[] = [];
  const count = rng.chance(0.1) ? 0 : rng.int(1, 60);
  const rows = generateRows(rng, count);
  const m = computeG08Metrics(rows);
  if (canonicalJson(computeG08Metrics(rows)) !== canonicalJson(m))
    violations.push("nondeterministic");
  if (m.n !== rows.length) violations.push(`n ${m.n} != ${rows.length}`);
  if (m.nAmbiguous + m.nSafe + m.nDegraded + m.nUnsafe !== m.n)
    violations.push("class counts != n");
  if (m.falseSafeRate.denominator !== m.nUnsafe)
    violations.push("falseSafe denominator != nUnsafe");
  if (m.falseRejectRate.denominator !== m.nSafe)
    violations.push("falseReject denominator != nSafe");
  if (m.missedDegradationRate.denominator !== m.nDegraded) {
    violations.push("missedDegradation denominator != nDegraded");
  }
  const known = rows.filter((r) => KNOWN_OUTCOMES.has(r.downstream)).length;
  if (m.usableRateGivenSupported.denominator + m.usableRateGivenFlagged.denominator !== known) {
    violations.push("usable-rate denominators do not partition known outcomes");
  }
  if (m.silentFailureRateGivenSupported.denominator !== m.usableRateGivenSupported.denominator) {
    violations.push("silent-failure denominator != supported-known denominator");
  }
  for (const key of Object.keys(m) as Array<keyof G08GateMetrics>) {
    violations.push(...checkRate(key, m[key]));
  }
  const byFamily = computeG08MetricsByFamily(rows);
  const familyN = G08_BYPASS_FAMILIES.reduce((acc, f) => acc + byFamily[f].n, 0);
  if (familyN !== m.n) violations.push(`family partition ${familyN} != ${m.n}`);

  const incumbent = computeG08Metrics(generateRows(rng, rng.int(0, 40)));
  const family = rng.pick(G08_BYPASS_FAMILIES);
  const verdict = evaluateG08Promotion(family, incumbent, m);
  const sufficient = evidenceSufficient(m).sufficient;
  if (!sufficient && verdict.decidable) violations.push("decidable without sufficient evidence");
  if (verdict.promote && !verdict.decidable) violations.push("promote while undecidable");
  if (verdict.promote && verdict.reasons.length > 0) violations.push("promote with reasons");
  if (!verdict.promote && verdict.reasons.length === 0)
    violations.push("rejection without reasons");
  if (verdict.family !== family) violations.push("family echoed incorrectly");
  if (
    verdict.decidable &&
    verdict.promote &&
    m.falseSafeRate.rate !== null &&
    incumbent.falseSafeRate.rate !== null &&
    m.falseSafeRate.rate > incumbent.falseSafeRate.rate
  ) {
    violations.push("promoted despite worse false-safe than incumbent");
  }
  if (/NaN|Infinity/.test(JSON.stringify(m) + JSON.stringify(verdict)))
    violations.push("non-finite in output");
  return { violations, scenario: `rows=${count} family=${family}` };
}

export function g08Campaign(campaignSeed: number, iterations: number): CampaignReport {
  return runCampaign({
    name: "g08-gate",
    campaignSeed,
    iterations,
    iterate: (seed) => checkG08Invariants(seed),
  });
}

// ---------------------------------------------------------------------------
// Campaign 4: validateG08LabelFile over seeded well-formed + mutated files
// ---------------------------------------------------------------------------

type Mutation =
  | "none"
  | "drop_field"
  | "wrong_type"
  | "machine_annotator"
  | "duplicate_id"
  | "empty_notes_unsafe"
  | "supersede_valid"
  | "supersede_missing"
  | "supersede_self"
  | "supersede_cycle";

const MUTATIONS: readonly Mutation[] = [
  "none",
  "none",
  "none",
  "drop_field",
  "wrong_type",
  "machine_annotator",
  "duplicate_id",
  "empty_notes_unsafe",
  "supersede_valid",
  "supersede_missing",
  "supersede_self",
  "supersede_cycle",
];

const RECORD_FIELDS = [
  "labelId",
  "candidateId",
  "clip",
  "windowMs",
  "sessionKey",
  "family",
  "capture",
  "downstream",
  "annotatorKind",
  "annotator",
  "labeledAtIso",
  "notes",
] as const;

function wellFormedRecord(rng: SeededRng, index: number): Record<string, unknown> {
  const capture = rng.pick(G08_CAPTURE_LABELS);
  return {
    labelId: `g08-label-${String(index).padStart(4, "0")}`,
    candidateId: rng.chance(0.5) ? null : `cand-${rng.int(0, 99)}`,
    clip: `datasets/clips/clip-${rng.int(0, 9)}.mp4`,
    windowMs: { startMs: rng.int(0, 60_000), durationMs: rng.int(1, 8000) },
    sessionKey: `session-${rng.int(0, 4)}`,
    family: rng.pick(G08_BYPASS_FAMILIES),
    capture,
    downstream: rng.pick(G08_DOWNSTREAM_OUTCOMES),
    annotatorKind: "human",
    annotator: rng.pick(["ab", "cd", "ef"]),
    labeledAtIso: new Date(Date.UTC(2026, rng.int(0, 11), rng.int(1, 28))).toISOString(),
    notes:
      capture === "UNSAFE" || capture === "AMBIGUOUS" ? "reason recorded" : rng.pick(["", "ok"]),
  };
}

export function checkLabelFileInvariants(seed: number): { violations: string[]; scenario: string } {
  const rng = seededRng(seed);
  const violations: string[] = [];
  const count = rng.int(1, 12);
  const labels = Array.from({ length: count }, (_, i) => wellFormedRecord(rng, i));
  const mutation = rng.pick(MUTATIONS);
  const target = labels[rng.int(0, count - 1)]!;
  let expectValid = true;
  switch (mutation) {
    case "none":
      break;
    case "drop_field":
      delete target[rng.pick(RECORD_FIELDS)];
      expectValid = false;
      break;
    case "wrong_type":
      target[rng.pick(RECORD_FIELDS)] = rng.pick([42, true, [], {}]);
      expectValid = false;
      break;
    case "machine_annotator":
      target.annotatorKind = "machine";
      expectValid = false;
      break;
    case "duplicate_id":
      if (count > 1) {
        labels[0]!.labelId = labels[count - 1]!.labelId;
        expectValid = false;
      }
      break;
    case "empty_notes_unsafe":
      target.capture = "UNSAFE";
      target.notes = "   ";
      expectValid = false;
      break;
    case "supersede_valid":
      if (count > 1) {
        labels[count - 1]!.supersedesLabelId = labels[0]!.labelId;
      }
      break;
    case "supersede_missing":
      target.supersedesLabelId = "g08-label-9999";
      expectValid = false;
      break;
    case "supersede_self":
      target.supersedesLabelId = target.labelId;
      break;
    case "supersede_cycle":
      if (count > 1) {
        labels[0]!.supersedesLabelId = labels[1]!.labelId;
        labels[1]!.supersedesLabelId = labels[0]!.labelId;
      } else {
        target.supersedesLabelId = target.labelId;
      }
      break;
  }
  const file = { schemaVersion: G08_LABEL_SCHEMA_VERSION, provenance: "stress harness", labels };
  const result = validateG08LabelFile(file);
  if (canonicalJson(validateG08LabelFile(file)) !== canonicalJson(result)) {
    violations.push("nondeterministic");
  }
  if (result.valid !== (result.errors.length === 0)) violations.push("valid flag != errors empty");
  if (result.valid !== expectValid) {
    violations.push(`valid=${result.valid} but mutation ${mutation} expected ${expectValid}`);
  }
  const ids = new Set(labels.map((l) => l.labelId));
  for (const record of result.effective) {
    if (!ids.has(record.labelId)) violations.push("effective record not in file");
  }
  if (mutation === "none" && result.effective.length !== count) {
    violations.push(`effective ${result.effective.length} != ${count} for untouched file`);
  }
  if (mutation === "supersede_valid" && count > 1 && result.effective.length !== count - 1) {
    violations.push(`effective ${result.effective.length} != ${count - 1} after one supersede`);
  }
  // Every human label in a VALID file must be accounted for: either effective
  // or (transitively) superseded by an effective record. A label that vanishes
  // through a self-supersede or a supersede cycle is silent data loss.
  if (result.valid) {
    const accounted = new Set(result.effective.map((r) => r.labelId));
    let grew = true;
    while (grew) {
      grew = false;
      for (const record of labels) {
        const id = record.labelId as string;
        const parent = record.supersedesLabelId;
        if (accounted.has(id) && typeof parent === "string" && !accounted.has(parent)) {
          accounted.add(parent);
          grew = true;
        }
      }
    }
    const dropped = labels.map((l) => l.labelId as string).filter((id) => !accounted.has(id));
    if (dropped.length > 0) {
      violations.push(
        `supersede_cycle: valid=true but ${dropped.length} label(s) silently dropped (${mutation}): ${dropped.join(",")}`,
      );
    }
  }
  return { violations, scenario: `labels=${count} mutation=${mutation}` };
}

export function labelFileCampaign(campaignSeed: number, iterations: number): CampaignReport {
  return runCampaign({
    name: "label-file-validation",
    campaignSeed,
    iterations,
    iterate: (seed) => checkLabelFileInvariants(seed),
  });
}

// ---------------------------------------------------------------------------
// Campaign 5: ffmpeg clip prober (measureClip / computeBypassSignals /
// probeFrameIntervalCv) over seeded synthetic fixtures generated ONCE
// ---------------------------------------------------------------------------

export const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

interface ClipFixture {
  path: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  source: string;
}

const CLIP_SIZES: ReadonlyArray<[number, number]> = [
  [256, 144],
  [144, 256],
  [320, 180],
  [192, 192],
];
const CLIP_SOURCES = ["testsrc2", "mandelbrot", "smptebars", "color=c=gray"] as const;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function generateFixtures(dir: string, rng: SeededRng, count: number): ClipFixture[] {
  const fixtures: ClipFixture[] = [];
  for (let index = 0; index < count; index += 1) {
    const [width, height] = rng.pick(CLIP_SIZES);
    const fps = rng.pick([24, 30]);
    const durationSec = rng.pick([2, 3]);
    const source = rng.pick(CLIP_SOURCES);
    const path = join(dir, `fixture-${index}-${source.replace(/[^a-z0-9]/g, "")}.mp4`);
    const lavfi = source.startsWith("color=")
      ? `${source}:size=${width}x${height}:rate=${fps}:duration=${durationSec}`
      : `${source}=size=${width}x${height}:rate=${fps}:duration=${durationSec}`;
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      lavfi,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      path,
    ]);
    fixtures.push({ path, width, height, fps, durationSec, source });
  }
  return fixtures;
}

function nonFiniteFields(record: Record<string, unknown>): string[] {
  return Object.entries(record)
    .filter(([, v]) => typeof v === "number" && !Number.isFinite(v))
    .map(([k]) => k);
}

export function clipCampaign(
  campaignSeed: number,
  iterations: number,
  fixtureCount = 4,
): CampaignReport {
  let dir = "";
  let fixtures: ClipFixture[] = [];
  const firstSeen = new Map<string, string>();
  return runCampaign({
    name: "clip-prober",
    campaignSeed,
    iterations,
    setup: () => {
      dir = mkdtempSync(join(tmpdir(), "capture-envelope-stress-"));
      fixtures = generateFixtures(dir, seededRng(campaignSeed), fixtureCount);
    },
    teardown: () => {
      firstSeen.clear();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
    iterate: (seed, iteration) => {
      const rng = seededRng(seed);
      const violations: string[] = [];
      const fixture = fixtures[iteration % fixtures.length]!;
      const useWindow = rng.chance(0.4);
      const window = useWindow
        ? { startMs: rng.pick([0, 250, 500]), durationMs: rng.pick([1000, 1500]) }
        : undefined;
      const mode = rng.pick(["measure", "measure", "signals", "intervals"] as const);
      const key = `${fixture.path}|${mode}|${canonicalJson(window ?? null)}`;
      const scenario = `${fixture.source} ${fixture.width}x${fixture.height}@${fixture.fps} ${mode} window=${canonicalJson(window ?? null)}`;

      if (mode === "measure") {
        const m = measureClip(fixture.path, window);
        const bad = nonFiniteFields(m as unknown as Record<string, unknown>);
        if (bad.length > 0) violations.push(`non-finite measurements: ${bad.join(",")}`);
        if (m.frameWidthPx !== fixture.width || m.frameHeightPx !== fixture.height) {
          violations.push(`dims ${m.frameWidthPx}x${m.frameHeightPx}`);
        }
        if (m.avgFrameRateFps === null || Math.abs(m.avgFrameRateFps - fixture.fps) > 0.5) {
          violations.push(`fps ${m.avgFrameRateFps}`);
        }
        const expectedDuration = window ? window.durationMs : fixture.durationSec * 1000;
        if (m.clipDurationMs === null || Math.abs(m.clipDurationMs - expectedDuration) > 150) {
          violations.push(`duration ${m.clipDurationMs} != ${expectedDuration}`);
        }
        if (m.playerPixelHeightFraction !== null || m.playerMeanJointVisibility !== null) {
          violations.push("prober fabricated pose signals");
        }
        if (
          m.brightnessMeanLuma !== null &&
          (m.brightnessMeanLuma < 0 || m.brightnessMeanLuma > 255)
        ) {
          violations.push(`brightness ${m.brightnessMeanLuma}`);
        }
        if (
          m.clippedPixelFraction !== null &&
          (m.clippedPixelFraction < 0 || m.clippedPixelFraction > 1)
        ) {
          violations.push(`clipped ${m.clippedPixelFraction}`);
        }
        if (m.frameIntervalCv !== null && m.frameIntervalCv < 0) violations.push("negative cv");
        if (m.frameIntervalCv !== null && m.frameIntervalCv > 0.01) {
          violations.push(`CFR fixture measured cv ${m.frameIntervalCv}`);
        }
        const verdict = evaluateCaptureEnvelope(m);
        if (/NaN|Infinity/.test(canonicalJson(verdict))) violations.push("non-finite in verdict");
        const json = canonicalJson(m);
        const seen = firstSeen.get(key);
        if (seen === undefined) firstSeen.set(key, json);
        else if (seen !== json) violations.push("measureClip nondeterministic across iterations");
      } else if (mode === "signals") {
        const s = computeBypassSignals(fixture.path, window);
        const bad = nonFiniteFields(s as unknown as Record<string, unknown>);
        if (bad.length > 0) violations.push(`non-finite signals: ${bad.join(",")}`);
        if (s.sampledFrameCount <= 0) violations.push("no sampled frames");
        for (const name of [
          "lowClipFraction",
          "highClipFraction",
          "bimodalClipScore",
          "motionHeightFraction",
          "motionWidthFraction",
          "motionCoverage",
        ] as const) {
          const v = s[name];
          if (v !== null && (v < 0 || v > 1)) violations.push(`${name} ${v}`);
        }
        if (s.hfEnergyRatio !== null) violations.push("hfEnergyRatio computed below 1280px");
        const json = canonicalJson(s);
        const seen = firstSeen.get(key);
        if (seen === undefined) firstSeen.set(key, json);
        else if (seen !== json) violations.push("computeBypassSignals nondeterministic");
      } else {
        const info = probeClipStream(fixture.path);
        if (info.rotationDegrees !== 0) violations.push(`rotation ${info.rotationDegrees}`);
        if (info.displayWidth !== fixture.width)
          violations.push(`displayWidth ${info.displayWidth}`);
        const cv = probeFrameIntervalCv(fixture.path, window);
        if (cv === null || !Number.isFinite(cv) || cv < 0) violations.push(`cv ${String(cv)}`);
        const json = canonicalJson({ info, cv });
        const seen = firstSeen.get(key);
        if (seen === undefined) firstSeen.set(key, json);
        else if (seen !== json) violations.push("probe nondeterministic");
      }
      return { violations, scenario };
    },
  });
}
