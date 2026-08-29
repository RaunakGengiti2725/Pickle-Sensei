// I29 cost-per-analysis report generator: derives ESTIMATED unit economics
// (per video minute, per stroke analysis, per game session, per coach-reviewed
// event) from the repo's REAL Linux benchmark measurements
// (datasets/experiments/wave-g/g24-linux-profile.json) plus the explicit,
// provenance-labeled rate card in @pickle/analytics. Every dollar figure is an
// estimate; components with no real measurement on this box are reported as
// NOT_MEASURED, never invented.
//
//   cd packages/swing-lab && pnpm exec tsx ../../datasets/experiments/wave-i/i29-cost-report-run.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_RATE_CARD,
  ZERO_USAGE,
  addUsage,
  computeCost,
  scaleUsage,
  suggestOptimizations,
  type CostBreakdown,
  type UsageQuantities,
} from "../../../packages/analytics/src/costModel.js";

const ROOT = join(import.meta.dirname ?? ".", "..", "..", "..");
const PROFILE_PATH = "datasets/experiments/wave-g/g24-linux-profile.json";
const OUT_DIR = join(ROOT, "datasets/experiments/wave-i");

interface TimingStat {
  meanMs: number;
}

interface ProfiledClip {
  clip: string;
  meta: { durationMs: number };
  clipBytes: number;
  ffprobeMetadataMs: TimingStat;
  fullDecodeToNullMs: TimingStat;
  frameExtractJpegMs: TimingStat;
  extractedBytes: number;
}

interface ScheduleMechanics {
  clip: string;
  planWallMs: TimingStat;
}

interface JsonArtifactTiming {
  parse: TimingStat;
  stringify: TimingStat;
  roundTripWrite: TimingStat;
}

interface LinuxProfile {
  generatedAtIso: string;
  boundary: string;
  provenance: { gitCommit: string; gitBranch: string };
  clips: ProfiledClip[];
  jsonArtifacts: JsonArtifactTiming[];
  twoPassScheduleMechanics: ScheduleMechanics[];
}

function loadProfile(): LinuxProfile {
  const raw = JSON.parse(readFileSync(join(ROOT, PROFILE_PATH), "utf8")) as LinuxProfile;
  if (!Array.isArray(raw.clips) || raw.clips.length === 0) {
    throw new Error(`i29: no measured clips in ${PROFILE_PATH}`);
  }
  return raw;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

const profile = loadProfile();

// --- Measured per-video-minute quantities (LINUX-CPU, real ffmpeg/ffprobe runs) ---
const perMinuteScale = profile.clips.map((c) => 60_000 / c.meta.durationMs);
const mediaCpuMsPerMinute = mean(
  profile.clips.map(
    (c, i) =>
      (c.ffprobeMetadataMs.meanMs + c.fullDecodeToNullMs.meanMs + c.frameExtractJpegMs.meanMs) *
      (perMinuteScale[i] ?? 0),
  ),
);
const clipBytesPerMinute = mean(
  profile.clips.map((c, i) => c.clipBytes * (perMinuteScale[i] ?? 0)),
);
const schedulePlanCpuMsPerClip = mean(
  profile.twoPassScheduleMechanics.map((m) => m.planWallMs.meanMs),
);
const jsonArtifactCpuMs = mean(
  profile.jsonArtifacts.map((a) => a.parse.meanMs + a.stringify.meanMs + a.roundTripWrite.meanMs),
);

// --- Workload shape assumptions (labeled; not measurements) ---
const ASSUMPTIONS = {
  strokeAnalysesPerVideoMinute: 6,
  videoMinutesPerGameSession: 12,
  retentionMonths: 1,
  coachMinutesPerReviewedEvent: 3,
  uploadedFractionOfClipBytes: 1,
} as const;

// --- Usage profiles ---
const perVideoMinuteUsage: UsageQuantities = {
  ...ZERO_USAGE,
  media_processing: mediaCpuMsPerMinute,
  server_cpu:
    (schedulePlanCpuMsPerClip + jsonArtifactCpuMs) * ASSUMPTIONS.strokeAnalysesPerVideoMinute,
  storage: clipBytesPerMinute * ASSUMPTIONS.retentionMonths,
  bandwidth: clipBytesPerMinute * ASSUMPTIONS.uploadedFractionOfClipBytes,
};

const perStrokeAnalysisUsage = scaleUsage(
  perVideoMinuteUsage,
  1 / ASSUMPTIONS.strokeAnalysesPerVideoMinute,
);

const perGameSessionUsage = scaleUsage(perVideoMinuteUsage, ASSUMPTIONS.videoMinutesPerGameSession);

const perCoachReviewedEventUsage: UsageQuantities = addUsage(perStrokeAnalysisUsage, {
  ...ZERO_USAGE,
  coach_review: ASSUMPTIONS.coachMinutesPerReviewedEvent,
});

function report(usage: UsageQuantities): CostBreakdown {
  return computeCost(usage, DEFAULT_RATE_CARD);
}

const perVideoMinute = report(perVideoMinuteUsage);
const perStrokeAnalysis = report(perStrokeAnalysisUsage);
const perGameSession = report(perGameSessionUsage);
const perCoachReviewedEvent = report(perCoachReviewedEventUsage);

const out = {
  workstream: "i29-cost-per-analysis",
  generatedFrom: {
    profile: PROFILE_PATH,
    profileGeneratedAtIso: profile.generatedAtIso,
    profileProvenance: profile.provenance,
    profileBoundary: profile.boundary,
  },
  honestyLabel:
    "ALL DOLLAR FIGURES ARE ESTIMATES. Quantities marked measured come from real Linux CPU " +
    "benchmark runs in the profile above; rates are public list-price estimates or explicit " +
    "assumptions (see rateCard provenance per component). No invoices, production traffic, " +
    "device measurements, GPU measurements, or real coach payroll data exist in this repo.",
  notMeasured: {
    device_compute:
      "NOT_MEASURED: no physical-device (iPhone/Android) measurements exist; on-device compute " +
      "is priced at zero marginal operator cost and its quantity is left at 0 rather than invented.",
    server_gpu:
      "NOT_MEASURED: no GPU exists on the Linux benchmark box and no server-side GPU inference " +
      "is deployed; quantity left at 0.",
    coach_review:
      "ASSUMPTION-ONLY: no real coach review sessions have occurred; minutes-per-event and the " +
      "$/hour rate are explicit assumptions, not observations.",
  },
  measuredInputs: {
    mediaCpuMsPerVideoMinute: {
      value: mediaCpuMsPerMinute,
      source: "ffprobe + full decode + JPEG frame extraction wall time, scaled to 60s per clip",
    },
    clipBytesPerVideoMinute: {
      value: clipBytesPerMinute,
      source: "real clip file sizes scaled to 60s per clip",
    },
    schedulePlanCpuMsPerClip: {
      value: schedulePlanCpuMsPerClip,
      source:
        "two-pass schedule planning wall time (synthetic sparse track over real clip metadata)",
    },
    jsonArtifactCpuMsPerAnalysis: {
      value: jsonArtifactCpuMs,
      source: "JSON parse + stringify + round-trip write of real committed artifacts",
    },
  },
  assumptions: ASSUMPTIONS,
  rateCard: DEFAULT_RATE_CARD,
  estimates: {
    perVideoMinute,
    perStrokeAnalysis,
    perGameSession,
    perCoachReviewedEvent,
  },
  optimizationSuggestions: suggestOptimizations(perCoachReviewedEvent),
  optimizationPolicy:
    "Suggestions come from a closed catalog in which every entry preserves core analysis " +
    "correctness by construction; cost work never loosens accuracy, thresholds, gates, or " +
    "coach-review scope.",
};

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, "i29-cost-report.json");
writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
console.log(`per video minute:        ${perVideoMinute.totalUsdFormatted}`);
console.log(`per stroke analysis:     ${perStrokeAnalysis.totalUsdFormatted}`);
console.log(`per game session:        ${perGameSession.totalUsdFormatted}`);
console.log(`per coach-reviewed event: ${perCoachReviewedEvent.totalUsdFormatted}`);
console.log(`written: ${outPath}`);
