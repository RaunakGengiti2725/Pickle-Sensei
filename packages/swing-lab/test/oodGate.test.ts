import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { preAnalysisGate } from "@pickle/analysis-pipeline";
import { extractFrameStats } from "../src/frameStats.js";

/**
 * OOD gate against REAL negative fixtures constructed locally with ffmpeg.
 * These are SYNTHETIC NEGATIVES (solid-color clip, still-image clip,
 * 1-frame clip, letterboxed title card) — clearly labeled as such; they
 * exercise the pose-free signals end-to-end through actual video decode.
 * The positive control is a committed real bundle clip.
 */

const dir = mkdtempSync(join(tmpdir(), "ood-fixtures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
}

describe("OOD gate on ffmpeg-constructed negatives", () => {
  it("rejects a solid-color clip (still + textureless)", () => {
    const path = join(dir, "solid.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=30", path]);
    const report = evaluateFrameAnalyzability(extractFrameStats(path));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("still_image_video");
    expect(report.reasons).toContain("solid_color_frames");
  });

  it("rejects a still-image clip (textured but frozen)", () => {
    const image = join(dir, "frame.png");
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x240:rate=30", "-frames:v", "1", image]);
    const path = join(dir, "still.mp4");
    ffmpeg(["-loop", "1", "-i", image, "-t", "2", "-r", "30", "-pix_fmt", "yuv420p", path]);
    const report = evaluateFrameAnalyzability(extractFrameStats(path));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("still_image_video");
    expect(report.reasons).not.toContain("solid_color_frames");
  });

  it("rejects a 1-frame clip", () => {
    const path = join(dir, "oneframe.mp4");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "testsrc=size=320x240:rate=30",
      "-frames:v",
      "1",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const report = evaluateFrameAnalyzability(extractFrameStats(path));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("single_frame_clip");
  });

  it("rejects a letterboxed title card", () => {
    const image = join(dir, "card.png");
    ffmpeg(["-f", "lavfi", "-i", "testsrc=size=320x64:rate=30", "-frames:v", "1", image]);
    const path = join(dir, "titlecard.mp4");
    ffmpeg([
      "-loop",
      "1",
      "-i",
      image,
      "-t",
      "2",
      "-r",
      "30",
      "-vf",
      "pad=320:240:0:88:black",
      "-pix_fmt",
      "yuv420p",
      path,
    ]);
    const report = evaluateFrameAnalyzability(extractFrameStats(path));
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("letterbox_dominant");
    expect(report.reasons).toContain("still_image_video");
  });

  it("routes frame-stat rejections through the typed pipeline abstention", () => {
    const path = join(dir, "solid2.mp4");
    ffmpeg(["-f", "lavfi", "-i", "color=c=gray:s=320x240:d=2:r=30", path]);
    const result = preAnalysisGate({
      frame: evaluateFrameAnalyzability(extractFrameStats(path)),
      pose: null,
      poseQuality: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.kind).toBe("corrupted_media");
    expect(result.failure.code).toMatch(/^capture\.not_analyzable\./);
  });

  it("passes the real committed bundle clip (positive control)", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const clip = join(root, "datasets", "paddle-bench", "bundles", "wm-volley-02", "clip.mp4");
    expect(existsSync(clip)).toBe(true);
    const report = evaluateFrameAnalyzability(extractFrameStats(clip));
    expect(report.analyzable).toBe(true);
    expect(report.reasons).toEqual([]);
  });
});
