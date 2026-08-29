import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  evaluateCaptureEnvelope,
  measureClip,
  probeClipStream,
  SAMPLE_FPS,
} from "@pickle/capture-envelope";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { extractFrameStats } from "./frameStats.js";

/**
 * g06-f22-dossiers: forensic measurement harness for the 8 pinned envelope
 * bypasses in packages/capture-envelope/test/redteamBypassF22.test.ts.
 *
 * For each bypass this harness re-synthesizes the exact clip from the pinned
 * recipe and measures, on this machine (Linux, no pose):
 *  1. the CURRENT envelope signals + verdict (why the checker passes it);
 *  2. what the DOWNSTREAM pipeline actually does with the clip — the two
 *     pose-free downstream stages runnable on Linux:
 *       a. the pre-analysis OOD gate (extractFrameStats →
 *          evaluateFrameAnalyzability, frame-analyzability-3);
 *       b. ball candidate generation (tools/paddle-lab/ball_candidates.py,
 *          ball-diff-candidates-1) — the perception front-end that feeds
 *          ball-track-2;
 *     pose-gated stages (target/paddle/stroke/phase/contact) CANNOT run here
 *     (Apple-Vision-only) and are reported as such, never fabricated;
 *  3. CANDIDATE preventive signals: pre-capture-computable statistics that
 *     would separate the bypass from its honest control, measured on both.
 *
 * Held-out cases wm-dink-01 and afn-vic-rally1 are never opened. The only
 * real clip used is afn-sasebo-rally1 (committed, non-held-out), exactly as
 * the pinned B7/a10 probe uses it.
 *
 * Usage: pnpm --filter @pickle/swing-lab exec tsx src/g06F22Dossiers.ts
 * Output: datasets/experiments/wave-g/g06-f22-dossiers.json
 */

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = join(repoRoot, "datasets", "experiments", "wave-g");
mkdirSync(outDir, { recursive: true });
const workDir = join(tmpdir(), `g06-dossiers-${Date.now()}`);
mkdirSync(workDir, { recursive: true });

const REAL_SHAKE_SOURCE = join(
  repoRoot,
  "datasets/paddle-bench/bundles/afn-sasebo-rally1/clip.mp4",
);

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function makeBase(path: string, size = "1280x720", rate = 30, duration = 4): void {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=${size}:rate=${rate}:duration=${duration}`,
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    path,
  ]);
}

// ── raw grayscale sampling (mirrors clipProbe's normalization contract) ────

interface GraySample {
  width: number;
  height: number;
  frames: Uint8Array[];
}

function decodeGray(clipPath: string, vf: string, width: number, height: number): GraySample {
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-i", clipPath, "-vf", vf, "-f", "rawvideo", "-"],
    { maxBuffer: 512 * 1024 * 1024 },
  );
  const frameBytes = width * height;
  const frameCount = Math.floor(raw.length / frameBytes);
  const frames: Uint8Array[] = [];
  for (let index = 0; index < frameCount; index += 1) {
    frames.push(new Uint8Array(raw.buffer, raw.byteOffset + index * frameBytes, frameBytes));
  }
  return { width, height, frames };
}

function evenScaleHeight(sourceWidth: number, sourceHeight: number, width: number): number {
  return Math.round((sourceHeight * width) / sourceWidth / 2) * 2;
}

function laplacianVariance(frame: Uint8Array, width: number, height: number): number {
  const count = (width - 2) * (height - 2);
  if (count <= 0) return 0;
  let sum = 0;
  let sumSq = 0;
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const i = row + x;
      const lap =
        frame[i - width]! + frame[i + width]! + frame[i - 1]! + frame[i + 1]! - 4 * frame[i]!;
      sum += lap;
      sumSq += lap * lap;
    }
  }
  const mean = sum / count;
  return sumSq / count - mean * mean;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianLapVar(sample: GraySample): number | null {
  return median(sample.frames.map((f) => laplacianVariance(f, sample.width, sample.height)));
}

function meanLuma(frame: Uint8Array): number {
  let sum = 0;
  for (let index = 0; index < frame.length; index += 1) sum += frame[index]!;
  return frame.length > 0 ? sum / frame.length : 0;
}

function spatialStd(frame: Uint8Array): number {
  const mean = meanLuma(frame);
  let sumSq = 0;
  for (let index = 0; index < frame.length; index += 1) {
    const d = frame[index]! - mean;
    sumSq += d * d;
  }
  return frame.length > 0 ? Math.sqrt(sumSq / frame.length) : 0;
}

/** Standard 320w sample at SAMPLE_FPS, optionally with an extra filter after scale. */
function sample320(clipPath: string, extraFilter?: string): GraySample {
  const info = probeClipStream(clipPath);
  const width = 320;
  const height = evenScaleHeight(info.displayWidth, info.displayHeight, width);
  const vf = [`fps=${SAMPLE_FPS}`, `scale=${width}:${height}`, "format=gray", extraFilter]
    .filter((part): part is string => part !== undefined)
    .join(",");
  return decodeGray(clipPath, vf, width, height);
}

/** Long-side-320 orientation-canonical sample (candidate B6 normalization). */
function sampleLongSide320(clipPath: string): GraySample {
  const info = probeClipStream(clipPath);
  const landscape = info.displayWidth >= info.displayHeight;
  const width = landscape ? 320 : evenScaleHeight(info.displayHeight, info.displayWidth, 320);
  const height = landscape ? evenScaleHeight(info.displayWidth, info.displayHeight, 320) : 320;
  return decodeGray(
    clipPath,
    `fps=${SAMPLE_FPS},scale=${width}:${height},format=gray`,
    width,
    height,
  );
}

/** 640w sample for the two-scale detail-ratio probe (candidate B4 signal). */
function sample640(clipPath: string): GraySample {
  const info = probeClipStream(clipPath);
  const width = 640;
  const height = evenScaleHeight(info.displayWidth, info.displayHeight, width);
  return decodeGray(
    clipPath,
    `fps=${SAMPLE_FPS},scale=${width}:${height},format=gray`,
    width,
    height,
  );
}

/** Fraction of sampled pixels at/below 16 or at/above 235 (clipping fraction). */
function clippedPixelFraction(sample: GraySample): number | null {
  if (sample.frames.length === 0) return null;
  let clipped = 0;
  let total = 0;
  for (const frame of sample.frames) {
    for (let index = 0; index < frame.length; index += 1) {
      const v = frame[index]!;
      if (v <= 16 || v >= 235) clipped += 1;
    }
    total += frame.length;
  }
  return total > 0 ? clipped / total : null;
}

/** Fraction of sampled frames whose own mean luma is outside the supported band [60,200]. */
function offBandFrameFraction(sample: GraySample): number | null {
  if (sample.frames.length === 0) return null;
  const offBand = sample.frames.filter((frame) => {
    const mean = meanLuma(frame);
    return mean < 60 || mean > 200;
  }).length;
  return offBand / sample.frames.length;
}

/** Mean |gradient| over the top 1% highest-gradient pixels (edge sharpness, texture-independent). */
function sharpEdgeGradient(sample: GraySample): number | null {
  const magnitudes: number[] = [];
  for (const frame of sample.frames) {
    const { width, height } = sample;
    for (let y = 1; y < height - 1; y += 1) {
      const row = y * width;
      for (let x = 1; x < width - 1; x += 1) {
        const i = row + x;
        const gx = frame[i + 1]! - frame[i - 1]!;
        const gy = frame[i + width]! - frame[i - width]!;
        magnitudes.push(Math.abs(gx) + Math.abs(gy));
      }
    }
  }
  if (magnitudes.length === 0) return null;
  magnitudes.sort((left, right) => right - left);
  const top = magnitudes.slice(0, Math.max(1, Math.floor(magnitudes.length * 0.01)));
  return top.reduce((acc, value) => acc + value, 0) / top.length;
}

/** meanAbsFrameDiff / mean spatial luma std — contrast-normalized motion proxy. */
function contrastNormalizedDiff(sample: GraySample): number | null {
  if (sample.frames.length < 2) return null;
  let diffSum = 0;
  for (let index = 1; index < sample.frames.length; index += 1) {
    const a = sample.frames[index - 1]!;
    const b = sample.frames[index]!;
    let sum = 0;
    for (let px = 0; px < a.length; px += 1) sum += Math.abs(a[px]! - b[px]!);
    diffSum += sum / a.length;
  }
  const meanDiff = diffSum / (sample.frames.length - 1);
  const meanStd =
    sample.frames.reduce((acc, frame) => acc + spatialStd(frame), 0) / sample.frames.length;
  return meanStd > 0 ? meanDiff / meanStd : null;
}

/**
 * Motion-based subject-size proxy: 3-frame differencing at 320w, threshold,
 * 4-connected components, per-frame tallest component bbox height as a
 * fraction of frame height; returns the median over frames with any motion.
 */
function movingSubjectHeightFraction(sample: GraySample, diffThreshold = 20): number | null {
  const { width, height } = sample;
  const perFrame: number[] = [];
  for (let index = 2; index < sample.frames.length; index += 1) {
    const a = sample.frames[index - 2]!;
    const b = sample.frames[index - 1]!;
    const c = sample.frames[index]!;
    const mask = new Uint8Array(width * height);
    for (let px = 0; px < mask.length; px += 1) {
      const d1 = Math.abs(b[px]! - a[px]!);
      const d2 = Math.abs(c[px]! - b[px]!);
      mask[px] = Math.min(d1, d2) >= diffThreshold ? 1 : 0;
    }
    const seen = new Uint8Array(width * height);
    let tallest = 0;
    for (let start = 0; start < mask.length; start += 1) {
      if (mask[start] !== 1 || seen[start] === 1) continue;
      let minY = height;
      let maxY = 0;
      const stack = [start];
      seen[start] = 1;
      while (stack.length > 0) {
        const i = stack.pop()!;
        const y = Math.floor(i / width);
        const x = i - y * width;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        const neighbors = [
          x > 0 ? i - 1 : -1,
          x < width - 1 ? i + 1 : -1,
          y > 0 ? i - width : -1,
          y < height - 1 ? i + width : -1,
        ];
        for (const n of neighbors) {
          if (n >= 0 && mask[n] === 1 && seen[n] === 0) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
      tallest = Math.max(tallest, maxY - minY + 1);
    }
    if (tallest > 0) perFrame.push(tallest / height);
  }
  return median(perFrame);
}

// ── downstream: ball candidate generation ──────────────────────────────────

interface BallCandidateSummary {
  framesProcessed: number;
  meanCandidatesPerFrame: number;
  meanRawComponentsPerFrame: number;
  maxRawComponentsPerFrame: number;
  framesWithZeroCandidates: number;
  chronicCellFraction: number;
  backgroundActivityMax: number;
}

function runBallCandidates(clipPath: string, outPath: string): BallCandidateSummary | null {
  const res = spawnSync(
    "python3",
    [join(repoRoot, "tools/paddle-lab/ball_candidates.py"), "--video", clipPath, "--out", outPath],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    console.warn(`ball_candidates failed for ${clipPath}: ${res.stderr?.toString().slice(-500)}`);
    return null;
  }
  const file = JSON.parse(readFileSync(outPath, "utf8")) as {
    backgroundActivity: { grid: number; cells: number[] };
    timing: { framesProcessed: number };
    frames: Array<{ candidates: unknown[]; rawComponentCount: number }>;
  };
  const frames = file.frames;
  const candidateCounts = frames.map((f) => f.candidates.length);
  const rawCounts = frames.map((f) => f.rawComponentCount);
  const cells = file.backgroundActivity.cells;
  const chronic = cells.filter((value) => value >= 0.5).length;
  return {
    framesProcessed: file.timing.framesProcessed,
    meanCandidatesPerFrame:
      candidateCounts.length > 0
        ? candidateCounts.reduce((acc, value) => acc + value, 0) / candidateCounts.length
        : 0,
    meanRawComponentsPerFrame:
      rawCounts.length > 0
        ? rawCounts.reduce((acc, value) => acc + value, 0) / rawCounts.length
        : 0,
    maxRawComponentsPerFrame: rawCounts.length > 0 ? Math.max(...rawCounts) : 0,
    framesWithZeroCandidates: candidateCounts.filter((count) => count === 0).length,
    chronicCellFraction: cells.length > 0 ? chronic / cells.length : 0,
    backgroundActivityMax: cells.length > 0 ? Math.max(...cells) : 0,
  };
}

// ── per-clip measurement bundle ────────────────────────────────────────────

interface ClipMeasurements {
  clip: string;
  envelope: {
    measurements: Record<string, number | null>;
    dimensionStatuses: Record<string, string>;
    overall: string;
    notMeasured: string[];
  };
  oodGate: {
    analyzable: boolean;
    reasons: string[];
    medianInterFrameDiff: number;
    medianSpatialLumaStd: number;
  };
  ballCandidates: BallCandidateSummary | null;
  candidateSignals: Record<string, number | null>;
}

function measureAll(
  label: string,
  clipPath: string,
  candidateSignals: Record<string, number | null>,
): ClipMeasurements {
  const m = measureClip(clipPath);
  const verdict = evaluateCaptureEnvelope(m);
  const statuses: Record<string, string> = {};
  for (const d of verdict.dimensions) statuses[d.dimension] = d.status;
  const stats = extractFrameStats(clipPath);
  const gate = evaluateFrameAnalyzability(stats);
  const ballOut = join(workDir, `${label}-ball-candidates.json`);
  const ball = runBallCandidates(clipPath, ballOut);
  const result: ClipMeasurements = {
    clip: label,
    envelope: {
      measurements: {
        shortSidePx:
          m.frameWidthPx !== null && m.frameHeightPx !== null
            ? Math.min(m.frameWidthPx, m.frameHeightPx)
            : null,
        avgFrameRateFps: m.avgFrameRateFps,
        brightnessMeanLuma: m.brightnessMeanLuma,
        brightnessStdLuma: m.brightnessStdLuma,
        laplacianVarianceMedian: m.laplacianVarianceMedian,
        meanAbsFrameDiff: m.meanAbsFrameDiff,
        frameIntervalCv: m.frameIntervalCv,
        clipDurationMs: m.clipDurationMs,
      },
      dimensionStatuses: statuses,
      overall: verdict.overall,
      notMeasured: verdict.notMeasured,
    },
    oodGate: {
      analyzable: gate.analyzable,
      reasons: gate.reasons,
      medianInterFrameDiff: gate.stats.medianInterFrameDiff,
      medianSpatialLumaStd: gate.stats.medianSpatialLumaStd,
    },
    ballCandidates: ball,
    candidateSignals,
  };
  console.warn(
    `${label}: envelope=${result.envelope.overall} oodGate=${gate.analyzable ? "ANALYZABLE" : gate.reasons.join("|")} ` +
      `ballCands/frame=${ball ? ball.meanCandidatesPerFrame.toFixed(1) : "n/a"}`,
  );
  return result;
}

// ── clip synthesis (exact recipes from redteamBypassF22.test.ts) ───────────

const base = join(workDir, "base.mp4");
makeBase(base);

const clips: Record<string, string> = { control_base: base };

{
  const clip = join(workDir, "b1-blur-noise.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "gblur=sigma=12,noise=alls=24:allf=t",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "14",
    clip,
  ]);
  clips["b1_blur_grain"] = clip;
  const blurOnly = join(workDir, "b1-blur-only.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "gblur=sigma=12",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "14",
    blurOnly,
  ]);
  clips["control_b1_blur_only"] = blurOnly;
}

{
  const clip = join(workDir, "b2-bimodal.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "split[l][r];[l]crop=iw/2:ih:0:0,lutyuv=y=16[lo];[r]crop=iw/2:ih:iw/2:0,lutyuv=y=235[hi];[lo][hi]hstack",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  clips["b2_bimodal_exposure"] = clip;
  // Realism variant: same bimodal split but retaining scene motion inside the
  // crushed/blown halves (the pinned lutyuv=const recipe freezes the frame,
  // which the OOD gate catches for the WRONG reason - staticness).
  const moving = join(workDir, "b2-bimodal-moving.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "split[l][r];[l]crop=iw/2:ih:0:0,lutyuv=y='val/16'[lo];[r]crop=iw/2:ih:iw/2:0,lutyuv=y='min(235,220+val/16)'[hi];[lo][hi]hstack",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    moving,
  ]);
  clips["b2_bimodal_moving"] = moving;
}

{
  const clip = join(workDir, "b3-strobe.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x101010:size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=0xebebeb:size=1280x720:rate=30:duration=4",
    "-filter_complex",
    "[0][1]blend=all_expr='if(eq(mod(N,2),0),A,B)'",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  clips["b3_strobing_exposure"] = clip;
}

{
  const tiny = join(workDir, "b4-true240.mp4");
  makeBase(tiny, "426x240");
  const clip = join(workDir, "b4-upscaled.mp4");
  ffmpeg([
    "-i",
    tiny,
    "-vf",
    "scale=1280:720:flags=lanczos",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  clips["b4_upscaled_240p"] = clip;
  clips["control_b4_true240"] = tiny;
}

{
  const bgFrame = join(workDir, "b5-bg.png");
  ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "1", bgFrame]);
  const clip = join(workDir, "b5-tiny-subject.mp4");
  ffmpeg([
    "-loop",
    "1",
    "-t",
    "4",
    "-framerate",
    "30",
    "-i",
    bgFrame,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x36:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x=600:y=340",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  clips["b5_tiny_subject"] = clip;
  const bigSubject = join(workDir, "b5-big-subject.mp4");
  ffmpeg([
    "-loop",
    "1",
    "-t",
    "4",
    "-framerate",
    "30",
    "-i",
    bgFrame,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=360x270:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x=460:y=225",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    bigSubject,
  ]);
  clips["control_b5_big_subject"] = bigSubject;
  // Realism variant: tiny subject over a MOVING background (the pinned recipe
  // freezes the background, which the OOD gate catches for the WRONG reason).
  const movingBg = join(workDir, "b5-tiny-subject-moving-bg.mp4");
  ffmpeg([
    "-i",
    base,
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=64x36:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x=600:y=340",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    movingBg,
  ]);
  clips["b5_tiny_subject_moving_bg"] = movingBg;
}

{
  const clip = join(workDir, "b6-rot90tag.mp4");
  ffmpeg(["-i", base, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
  if (probeClipStream(clip).rotationDegrees === 90) {
    clips["b6_rotate_tag"] = clip;
  } else {
    console.warn("b6: ffmpeg dropped the rotate tag; skipping");
  }
}

{
  const clip = join(workDir, "fr1-low-texture.mp4");
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "color=c=0x707070:size=1280x720:rate=30:duration=4",
    "-f",
    "lavfi",
    "-i",
    "color=c=white:size=120x240:rate=30:duration=4",
    "-filter_complex",
    "[0][1]overlay=x='100+mod(n*8,900)':y=300",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    clip,
  ]);
  clips["fr1_low_texture_sharp"] = clip;
  const blurred = join(workDir, "fr1-low-texture-blurred.mp4");
  ffmpeg([
    "-i",
    clip,
    "-vf",
    "gblur=sigma=6",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    blurred,
  ]);
  clips["control_fr1_blurred"] = blurred;
}

{
  const clip = join(workDir, "b7-shake.mp4");
  ffmpeg([
    "-i",
    base,
    "-vf",
    "crop=iw-96:ih-96:x='48+40*sin(n*1.7)':y='48+40*cos(n*2.3)',scale=1280:720",
    "-pix_fmt",
    "yuv420p",
    "-c:v",
    "libx264",
    clip,
  ]);
  clips["b7_synthetic_shake"] = clip;
  if (existsSync(REAL_SHAKE_SOURCE)) {
    const real = join(workDir, "b7-real-shake.mp4");
    ffmpeg([
      "-i",
      REAL_SHAKE_SOURCE,
      "-vf",
      "crop=iw-96:ih-96:x='48+40*sin(n*1.7)':y='48+40*cos(n*2.3)',scale=1280:720",
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      real,
    ]);
    clips["control_b7_real_shake"] = real;
    clips["control_b7_real_unshaken"] = REAL_SHAKE_SOURCE;
  }
}

// ── candidate preventive signals per clip ──────────────────────────────────

function candidateSignalsFor(clipPath: string): Record<string, number | null> {
  const std = sample320(clipPath);
  const denoised = sample320(clipPath, "median=radius=1");
  const wide = sample640(clipPath);
  const canonical = sampleLongSide320(clipPath);
  const lap320 = medianLapVar(std);
  const lapDen = medianLapVar(denoised);
  const lap640 = medianLapVar(wide);
  return {
    lapVar320: lap320,
    lapVarDenoised320: lapDen,
    denoiseSurvivalRatio: lap320 !== null && lap320 > 0 && lapDen !== null ? lapDen / lap320 : null,
    lapVar640: lap640,
    detailRatio640over320:
      lap320 !== null && lap320 > 0 && lap640 !== null ? lap640 / lap320 : null,
    lapVarLongSide320: medianLapVar(canonical),
    clippedPixelFraction: clippedPixelFraction(std),
    offBandFrameFraction: offBandFrameFraction(std),
    sharpEdgeGradientTop1pct: sharpEdgeGradient(std),
    contrastNormalizedDiff: contrastNormalizedDiff(std),
    movingSubjectHeightFraction: movingSubjectHeightFraction(std),
  };
}

const results: ClipMeasurements[] = [];
for (const [label, clipPath] of Object.entries(clips)) {
  results.push(measureAll(label, clipPath, candidateSignalsFor(clipPath)));
}

const output = {
  workstream: "g06-f22-dossiers",
  date: new Date().toISOString(),
  workDir,
  environment:
    "Linux CPU; pose-gated downstream stages (target/paddle/stroke/phase/contact) NOT runnable here (Apple-Vision-only) — nothing fabricated",
  heldOutExcluded: ["wm-dink-01", "afn-vic-rally1"],
  downstreamStagesMeasured: [
    "pre-analysis OOD gate (frame-analyzability-3): extractFrameStats -> evaluateFrameAnalyzability",
    "ball candidate generation (ball-diff-candidates-1): tools/paddle-lab/ball_candidates.py",
  ],
  clips: results,
};
writeFileSync(join(outDir, "g06-f22-dossiers.json"), JSON.stringify(output, null, 2) + "\n");
console.warn(`\nwritten to datasets/experiments/wave-g/g06-f22-dossiers.json`);
