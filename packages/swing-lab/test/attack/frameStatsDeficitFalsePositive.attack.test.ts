import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import {
  extractFrameStats,
  extractFrameStatsAsync,
  FrameStatsToolingError,
} from "../../src/frameStats.js";

/**
 * Adversarial tests against aa5957d6 (ADJ-06 + ADJ-07).
 *
 * 1. ADJ-07 made `decoded_frame_deficit` fire regardless of `decode.errorCount`,
 *    but `expectedFrameCount` is still `round(format.duration * avg_frame_rate)`
 *    where `format.duration` is the CONTAINER duration — the longest stream.
 *    An intact clip whose audio track outlasts the video by more than ~11% now
 *    "expects" more video frames than the video stream ever declared and is
 *    rejected with zero decode errors. On 4d812e1a the same file was analyzable
 *    (the deficit branch only ran when errorCount > 0).
 *
 * 2. ADJ-06 classifies input failures by `stat()`, which succeeds on a file the
 *    process cannot read. The candidate documents `EACCES` as an input tooling
 *    code, but an unreadable input never produces it: ffmpeg's "Permission
 *    denied" exits non-zero and is folded into `{frameCount: 0, errorCount: 1}`
 *    -> `undecodable_media`, the exact conflation ADJ-06 set out to remove.
 *
 * Fixtures are generated at test time with ffmpeg (same skip/CI convention as
 * frameStats.test.ts).
 */

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (!ffmpegAvailable && process.env.CI !== undefined) {
  throw new Error(
    "ffmpeg is not on PATH but CI is set: attack fixtures cannot be generated. Install ffmpeg in the CI image instead of skipping this suite.",
  );
}
const withFfmpeg = ffmpegAvailable ? describe : describe.skip;

const workDir = mkdtempSync(join(tmpdir(), "frame-stats-attack-"));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "ignore" });
}

function videoOnly(path: string, seconds: number): void {
  ffmpeg([
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=size=320x240:rate=30",
    "-t",
    String(seconds),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path,
  ]);
}

/** Copies the video stream untouched and muxes a longer silent-ish sine track next to it. */
function withLongerAudio(video: string, out: string, audioSeconds: number): void {
  ffmpeg([
    "-i",
    video,
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    String(audioSeconds),
    "-c:v",
    "copy",
    "-c:a",
    out.endsWith(".mkv") ? "libopus" : "aac",
    out,
  ]);
}

withFfmpeg("ADJ-07 regression: intact clip whose audio outlasts the video is rejected", () => {
  const video = join(workDir, "video-3s.mp4");
  videoOnly(video, 3);

  it.each([
    ["mp4", 3.4],
    ["mp4", 4],
    ["mov", 4],
    ["mkv", 4],
  ])(
    "3.0 s / 90-frame video + %s audio track of %d s stays analyzable (all 90 frames decode, no errors)",
    async (ext, audioSeconds) => {
      const clip = join(workDir, `video-3s-audio-${audioSeconds}s.${ext}`);
      withLongerAudio(video, clip, audioSeconds);

      const stats = extractFrameStats(clip);
      // Every declared video frame decodes and ffmpeg logs nothing.
      expect(stats.frameCount).toBe(90);
      expect(stats.decode?.errorCount).toBe(0);

      const report = evaluateFrameAnalyzability(stats);
      expect(report.reasons).not.toContain("decoded_frame_deficit");
      expect(report.analyzable, report.reasons.join(",")).toBe(true);

      // The video stream declares 3.0 s @ 30 fps = 90 frames; the audio tail is not video.
      expect(stats.decode?.expectedFrameCount).toBe(90);

      expect(await extractFrameStatsAsync(clip)).toEqual(stats);
    },
  );
});

withFfmpeg("ADJ-06 gap: an unreadable input is a tooling error, not corrupt media", () => {
  const rootLike = typeof process.getuid === "function" && process.getuid() === 0;
  const unlessRoot = rootLike ? it.skip : it;

  unlessRoot(
    "extractFrameStats on a mode-000 clip throws FrameStatsToolingError(EACCES) (sync + async)",
    async () => {
      const clip = join(workDir, "unreadable.mp4");
      videoOnly(clip, 2);
      chmodSync(clip, 0o000);
      try {
        let syncError: unknown;
        try {
          const stats = extractFrameStats(clip);
          syncError = new Error(
            `returned a media verdict instead: ${JSON.stringify(stats.decode)}`,
          );
        } catch (error) {
          syncError = error;
        }
        expect(syncError).toBeInstanceOf(FrameStatsToolingError);
        expect((syncError as FrameStatsToolingError).tool).toBe("input");
        expect((syncError as FrameStatsToolingError).code).toBe("EACCES");

        let asyncError: unknown;
        try {
          const stats = await extractFrameStatsAsync(clip);
          asyncError = new Error(
            `resolved a media verdict instead: ${JSON.stringify(stats.decode)}`,
          );
        } catch (error) {
          asyncError = error;
        }
        expect(asyncError).toBeInstanceOf(FrameStatsToolingError);
        expect((asyncError as FrameStatsToolingError).tool).toBe("input");
        expect((asyncError as FrameStatsToolingError).code).toBe("EACCES");
      } finally {
        chmodSync(clip, 0o644);
      }
    },
  );
});
