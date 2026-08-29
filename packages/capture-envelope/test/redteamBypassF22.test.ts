import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope } from "../src/envelope.js";
import { measureClip, probeClipStream } from "../src/clipProbe.js";

/**
 * f22-rt-envelope-bypass regression suite. SYNTHETIC clips generated locally
 * with ffmpeg at test time; no committed corpus clips are read or written.
 *
 * Three kinds of assertions:
 *  - PROVEN-NEGATIVE pins: attacks the checker DOES catch must stay caught.
 *  - FIXED-GAP regressions: bypasses closed in wave G (g07) after the g06
 *    forensic dossiers classified them as logic bugs, normalization bugs,
 *    or missing pre-capture signals computable today (B1, B2, B3, B5, B6,
 *    B7). Each asserts the attack is now detected.
 *  - KNOWN-GAP pins: confirmed bypasses that cannot be fixed defensibly
 *    today (a fix needs labeled downstream evidence per the E15 mandate —
 *    B4 upscale detection, FR1 low-texture false reject). Each pin asserts
 *    the CURRENT bypassed behavior so any silent change to thresholds or
 *    the measurement pipeline surfaces here. If one of these fails because
 *    the gap was FIXED, update the corresponding finding in
 *    datasets/experiments/wave-f/f22-rt-envelope-bypass-attacks.json and
 *    flip the pin — do not delete it.
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
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

function statusOf(clipPath: string, dimension: string): string | undefined {
  const verdict = evaluateCaptureEnvelope(measureClip(clipPath));
  return verdict.dimensions.find((d) => d.dimension === dimension)?.status;
}

describe.skipIf(!hasFfmpeg)("f22 envelope bypass regressions", { timeout: 120_000 }, () => {
  let dir: string;
  let base: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "envelope-f22-"));
    base = join(dir, "base.mp4");
    makeBase(base);
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // FIXED f22-B1 (g07): temporal grain still pushes Laplacian variance
  // above the supported floor, but the injected grain collapses under a
  // 3x3 median denoise and the sensor_noise dimension (denoise-survival
  // ratio) rejects the clip.
  it("FIXED: heavy blur + grain is caught by sensor_noise", () => {
    const clip = join(dir, "blur-noise.mp4");
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
    const verdict = evaluateCaptureEnvelope(measureClip(clip));
    expect(verdict.dimensions.find((d) => d.dimension === "sensor_noise")?.status).toBe(
      "UNSUPPORTED",
    );
    expect(verdict.overall).not.toBe("SUPPORTED");
  });

  // FIXED f22-B2 (g07): spatially bimodal exposure (half crushed, half
  // blown) still has a mid-band spatial mean — brightness alone cannot see
  // it — but the exposure_clipping dimension (clipped-pixel fraction)
  // rejects the clip.
  it("FIXED: half-crushed/half-blown frame is caught by exposure_clipping", () => {
    const clip = join(dir, "bimodal.mp4");
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
    const verdict = evaluateCaptureEnvelope(measureClip(clip));
    expect(verdict.dimensions.find((d) => d.dimension === "brightness")?.status).toBe("SUPPORTED");
    expect(verdict.dimensions.find((d) => d.dimension === "exposure_clipping")?.status).toBe(
      "UNSUPPORTED",
    );
    expect(verdict.overall).toBe("UNSUPPORTED");
  });

  // FIXED f22-B3 (g07): temporally strobing exposure (alternating
  // near-black / near-white frames) still passes the brightness MEAN, but
  // brightnessStdLuma now feeds the exposure_stability dimension, which
  // rejects the clip directly instead of relying on incidental catches.
  it("FIXED: strobing exposure is caught by exposure_stability", () => {
    const clip = join(dir, "strobe.mp4");
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
    const m = measureClip(clip);
    expect(m.brightnessStdLuma!).toBeGreaterThan(50);
    expect(statusOf(clip, "brightness")).toBe("SUPPORTED");
    expect(statusOf(clip, "exposure_stability")).toBe("UNSUPPORTED");
  });

  // KNOWN GAP f22-B4: true-240p content upscaled to 720p passes resolution
  // (metadata-only) and everything else — sampling normalizes to 320px wide,
  // below the true detail level, so the upscale is invisible end to end.
  it("KNOWN GAP: 240p upscaled to 720p is overall SUPPORTED", () => {
    const tiny = join(dir, "true240.mp4");
    makeBase(tiny, "426x240");
    const clip = join(dir, "upscaled.mp4");
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
    const verdict = evaluateCaptureEnvelope(measureClip(clip));
    expect(verdict.dimensions.find((d) => d.dimension === "resolution")?.status).toBe("SUPPORTED");
    expect(verdict.overall).toBe("SUPPORTED");
  });

  // FIXED f22-B5 (g07, verdict-contract): pose dimensions are still
  // NOT_MEASURED without a pose pass and `overall` still reflects only
  // measured dimensions, but `overallWithCoverage` refuses to report a
  // partially observed envelope as fully verified SUPPORTED.
  it("FIXED: tiny-subject clip with pose NOT_MEASURED is SUPPORTED_UNMEASURED, not verified", () => {
    const bgFrame = join(dir, "bg.png");
    ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "1", bgFrame]);
    const clip = join(dir, "tiny-subject.mp4");
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
    const verdict = evaluateCaptureEnvelope(measureClip(clip));
    expect(verdict.overall).toBe("SUPPORTED");
    expect(verdict.notMeasured).toContain("player_pixel_height");
    expect(verdict.overallWithCoverage).toBe("SUPPORTED_UNMEASURED");
  });

  // FIXED f22-B6 (g07, normalization): sampling now normalizes the LONG
  // side to 320px, so a rotate=90 metadata tag on identical pixels can no
  // longer change the effective sampling scale — Laplacian variance is
  // orientation-invariant (thresholds re-versioned to
  // laplacian-variance-320long-median-v0.2).
  it("FIXED: rotate-tag metadata no longer shifts Laplacian variance", () => {
    const clip = join(dir, "rot90tag.mp4");
    ffmpeg(["-i", base, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
    if (probeClipStream(clip).rotationDegrees !== 90) return; // ffmpeg dropped the tag path
    const plain = measureClip(base).laplacianVarianceMedian!;
    const rotated = measureClip(clip).laplacianVarianceMedian!;
    expect(Math.abs(1 - rotated / plain)).toBeLessThan(0.05);
  });

  // KNOWN GAP f22-FR1 (false reject): Laplacian variance is a texture
  // statistic, not a blur statistic — a razor-sharp but low-texture scene
  // (flat field + sharp moving block) is flagged as motion blur.
  it("KNOWN GAP: sharp low-texture scene is falsely flagged on motion_blur", () => {
    const clip = join(dir, "low-texture.mp4");
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
    expect(statusOf(clip, "motion_blur")).not.toBe("SUPPORTED");
  });

  // ------------------------------------------------------------------
  // PROVEN NEGATIVES: attacks the checker catches must stay caught.

  it("proven negative: rotation metadata cannot inflate the resolution short side", () => {
    const land = join(dir, "land480.mp4");
    makeBase(land, "854x480");
    const clip = join(dir, "rot-lie.mp4");
    ffmpeg(["-i", land, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
    expect(statusOf(clip, "resolution")).toBe("DEGRADED");
  });

  it("proven negative: duplicate-PTS re-timing is still flagged on timing_stability", () => {
    const clip = join(dir, "dup-pts.mp4");
    ffmpeg([
      "-i",
      base,
      "-vf",
      "setpts=floor(N/2)*2/30/TB",
      "-vsync",
      "passthrough",
      "-enc_time_base",
      "1/90000",
      "-video_track_timescale",
      "90000",
      "-c:v",
      "libx264",
      clip,
    ]);
    expect(statusOf(clip, "timing_stability")).not.toBe("SUPPORTED");
  });

  // FIXED f22-B7 (g07): the raw mean-abs-frame-diff proxy (camera_motion)
  // remains content-contrast-dependent, but the camera_shake dimension
  // divides the diff by the mean spatial luma std, which is stable across
  // content contrast — the same crop-jitter shake is detected on synthetic
  // content too.
  it("FIXED: violent crop-jitter shake on low-contrast content is caught by camera_shake", () => {
    const clip = join(dir, "shake.mp4");
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
    expect(statusOf(clip, "camera_motion")).toBe("SUPPORTED");
    expect(statusOf(clip, "camera_shake")).not.toBe("SUPPORTED");
  });
});
