import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope } from "../src/envelope.js";
import { measureClip, probeClipStream, probeFrameIntervalCv } from "../src/clipProbe.js";

/**
 * Red-team regression suite (D3-07): SYNTHETIC adversarial clips generated
 * locally with ffmpeg at test time. No committed corpus clips are read or
 * written. Each clip degrades exactly one capture dimension; the suite
 * asserts the checker actually detects it.
 *
 * Documented breaks this suite guards against:
 *  - VFR timestamp jitter passing as SUPPORTED because only the AVERAGE
 *    frame rate was checked (fixed via the timing_stability dimension).
 *  - 90°/270° rotation metadata silently distorting the sampled-frame
 *    aspect ratio, corrupting the Laplacian / frame-diff normalization
 *    (fixed by measuring against display dimensions).
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

function makeBase(path: string, size = "1280x720", rate = 30, duration = 3): void {
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

/**
 * Writes a stream copy of `src` carrying `degrees` of rotation metadata.
 * ffmpeg <5 honors the legacy `rotate` stream tag; newer ffmpeg dropped that
 * path in favor of the `-display_rotation` input option (which writes a
 * displaymatrix, the same side data real phone captures carry).
 */
function makeRotated(src: string, dest: string, degrees: number): void {
  ffmpeg(["-i", src, "-c", "copy", "-metadata:s:v:0", `rotate=${degrees}`, dest]);
  if (probeClipStream(dest).rotationDegrees === 0) {
    ffmpeg(["-display_rotation", String(degrees), "-i", src, "-c", "copy", dest]);
  }
}

function dimensionStatus(clipPath: string, dimension: string): string | undefined {
  const verdict = evaluateCaptureEnvelope(measureClip(clipPath));
  return verdict.dimensions.find((d) => d.dimension === dimension)?.status;
}

describe.skipIf(!hasFfmpeg)(
  "red-team synthetic adversarial clips (D3-07)",
  { timeout: 120_000 },
  () => {
    let dir: string;
    let base: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "envelope-redteam-"));
      base = join(dir, "base.mp4");
      makeBase(base);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("baseline synthetic clip is fully SUPPORTED on video dimensions", () => {
      const verdict = evaluateCaptureEnvelope(measureClip(base));
      expect(verdict.overall).toBe("SUPPORTED");
      expect(verdict.notMeasured).toEqual(["player_pixel_height", "player_visibility"]);
    });

    it("8 fps capture is detected on frame_rate", () => {
      const clip = join(dir, "fps8.mp4");
      makeBase(clip, "1280x720", 8);
      expect(dimensionStatus(clip, "frame_rate")).toBe("UNSUPPORTED");
    });

    it("240p capture is detected on resolution", () => {
      const clip = join(dir, "res240.mp4");
      makeBase(clip, "426x240");
      expect(dimensionStatus(clip, "resolution")).toBe("UNSUPPORTED");
    });

    it("near-black exposure is detected on brightness", () => {
      const clip = join(dir, "nearblack.mp4");
      ffmpeg([
        "-i",
        base,
        "-vf",
        "eq=brightness=-0.45",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        clip,
      ]);
      expect(dimensionStatus(clip, "brightness")).toBe("UNSUPPORTED");
    });

    it("heavy synthetic motion blur is detected on motion_blur", () => {
      const clip = join(dir, "blur.mp4");
      ffmpeg(["-i", base, "-vf", "gblur=sigma=12", "-pix_fmt", "yuv420p", "-c:v", "libx264", clip]);
      expect(dimensionStatus(clip, "motion_blur")).toBe("UNSUPPORTED");
    });

    it("0.5s clip is detected on clip_duration", () => {
      const clip = join(dir, "halfsec.mp4");
      makeBase(clip, "1280x720", 30, 0.5);
      expect(dimensionStatus(clip, "clip_duration")).toBe("UNSUPPORTED");
    });

    it("VFR timestamps are detected on timing_stability even when avg fps passes", () => {
      const clip = join(dir, "vfr.mp4");
      ffmpeg([
        "-i",
        base,
        "-vf",
        "setpts=PTS+(mod(N\\,2)/40)/TB",
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
      const measurements = measureClip(clip);
      const verdict = evaluateCaptureEnvelope(measurements);
      expect(measurements.avgFrameRateFps).toBeGreaterThanOrEqual(29);
      expect(verdict.dimensions.find((d) => d.dimension === "frame_rate")?.status).toBe(
        "SUPPORTED",
      );
      expect(verdict.dimensions.find((d) => d.dimension === "timing_stability")?.status).toBe(
        "UNSUPPORTED",
      );
    });

    it("baseline CFR clip measures near-zero interval jitter", () => {
      const cv = probeFrameIntervalCv(base);
      expect(cv).not.toBeNull();
      expect(cv!).toBeLessThan(0.15);
    });

    it("90° rotation metadata swaps display dimensions and keeps resolution honest", () => {
      const clip = join(dir, "portraitmeta.mp4");
      makeRotated(base, clip, 90);
      const info = probeClipStream(clip);
      expect([90, 270]).toContain(info.rotationDegrees);
      expect(info.displayWidth).toBe(720);
      expect(info.displayHeight).toBe(1280);
      const measurements = measureClip(clip);
      expect(Math.min(measurements.frameWidthPx!, measurements.frameHeightPx!)).toBe(720);
      const verdict = evaluateCaptureEnvelope(measurements);
      expect(verdict.dimensions.find((d) => d.dimension === "resolution")?.status).toBe(
        "SUPPORTED",
      );
    });

    it("180° rotation metadata leaves pixel measurements identical to the unrotated clip", () => {
      const clip = join(dir, "rot180meta.mp4");
      makeRotated(base, clip, 180);
      const rotated = measureClip(clip);
      const plain = measureClip(base);
      expect(rotated.frameWidthPx).toBe(plain.frameWidthPx);
      expect(rotated.frameHeightPx).toBe(plain.frameHeightPx);
      expect(rotated.laplacianVarianceMedian!).toBeCloseTo(plain.laplacianVarianceMedian!, 0);
      expect(rotated.meanAbsFrameDiff!).toBeCloseTo(plain.meanAbsFrameDiff!, 1);
    });
  },
);
