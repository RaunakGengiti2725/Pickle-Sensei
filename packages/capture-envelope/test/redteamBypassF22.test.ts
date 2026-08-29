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
 * Two kinds of assertions:
 *  - PROVEN-NEGATIVE pins: attacks the checker DOES catch must stay caught.
 *  - KNOWN-GAP pins: confirmed bypasses that cannot be fixed defensibly
 *    today (a fix needs labeled downstream evidence per the E15 mandate, or
 *    a versioned normalization-contract change). Each pin asserts the
 *    CURRENT bypassed behavior so any silent change to thresholds or the
 *    measurement pipeline surfaces here. If one of these fails because the
 *    gap was FIXED, update the corresponding finding in
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
  // KNOWN GAP f22-B1: noise defeats the Laplacian blur proxy. Sigma-12
  // gaussian blur destroys all scene detail (the plain-blur case is
  // UNSUPPORTED, see redteamEnvelope.test.ts) but adding temporal grain on
  // top pushes Laplacian variance back above the supported floor.
  it("KNOWN GAP: heavy blur + grain passes motion_blur", () => {
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
    expect(statusOf(clip, "motion_blur")).toBe("SUPPORTED");
  });

  // KNOWN GAP f22-B2: spatially bimodal exposure (half crushed, half blown)
  // has a mid-band spatial mean; the whole clip is overall SUPPORTED with no
  // usable pixels anywhere.
  it("KNOWN GAP: half-crushed/half-blown frame passes brightness and overall", () => {
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
    expect(verdict.overall).toBe("SUPPORTED");
  });

  // KNOWN GAP f22-B3: temporally strobing exposure (alternating near-black /
  // near-white frames) passes the brightness dimension — the temporal mean is
  // mid-band and brightnessStdLuma (109 here) has no consuming dimension.
  // The clip is only caught incidentally by motion_blur / camera_motion.
  it("KNOWN GAP: strobing exposure passes the brightness dimension", () => {
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

  // KNOWN GAP f22-B5 (structural): pose dimensions are NOT_MEASURED without
  // a pose pass and never worsen the overall verdict, so a subject occupying
  // 5% of frame height sails through as overall SUPPORTED.
  it("KNOWN GAP: tiny-subject clip is overall SUPPORTED with pose NOT_MEASURED", () => {
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
  });

  // KNOWN GAP f22-B6: a rotate=90 metadata tag on a landscape clip changes
  // the sampling geometry (320w of the display-portrait frame vs 320w of the
  // landscape frame) and shifts the measured Laplacian variance ~30% for
  // identical pixels. The normalization contract is orientation-sensitive;
  // fixing it means re-versioning laplacian-variance-320w thresholds.
  it("KNOWN GAP: rotate-tag metadata alone shifts Laplacian variance materially", () => {
    const clip = join(dir, "rot90tag.mp4");
    ffmpeg(["-i", base, "-c", "copy", "-metadata:s:v:0", "rotate=90", clip]);
    if (probeClipStream(clip).rotationDegrees !== 90) return; // ffmpeg dropped the tag path
    const plain = measureClip(base).laplacianVarianceMedian!;
    const rotated = measureClip(clip).laplacianVarianceMedian!;
    expect(Math.abs(1 - rotated / plain)).toBeGreaterThan(0.15);
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

  // KNOWN GAP f22-B7: camera_motion v0.2 bands were widened to max 33 to
  // stop flagging subject motion (E15), but the mean-abs-frame-diff proxy is
  // content-contrast-dependent: the same ±40px/frame crop jitter measures
  // ~35.5 on real high-contrast footage (DEGRADED, harness a10) yet only
  // ~13 on lower-contrast synthetic content — violent global shake passes.
  it("KNOWN GAP: violent crop-jitter shake on low-contrast content passes camera_motion", () => {
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
  });
});
