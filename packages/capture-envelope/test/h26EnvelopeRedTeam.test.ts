import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateCaptureEnvelope } from "../src/envelope.js";
import { measureClip } from "../src/clipProbe.js";

/**
 * h26-redteam-perception envelope pin (Wave H). SYNTHETIC clips generated at
 * test time. KNOWN-GAP pin in the f22 convention: whole-clip aggregation
 * hides a catastrophic temporal SEGMENT — a clip whose entire second half is
 * pitch black measures SUPPORTED on every dimension because brightness is a
 * whole-clip mean and the Laplacian median comes from the good half. A fix
 * requires per-window measurements plus labeled downstream evidence (E15
 * mandate), so the gap is pinned, not patched. If this fails because the gap
 * was FIXED, flip the pin — do not delete it.
 */

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

describe.skipIf(!hasFfmpeg)(
  "h26-E1 (KNOWN GAP, P1): half-good/half-black clip passes the envelope",
  { timeout: 120_000 },
  () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "h26-envelope-"));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("KNOWN GAP: 4s good + 4s pitch-black concat is overall SUPPORTED", () => {
      const good = join(dir, "good.mp4");
      const black = join(dir, "black.mp4");
      const split = join(dir, "split.mp4");
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=1280x720:rate=30:duration=4",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        good,
      ]);
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "color=c=black:size=1280x720:rate=30:duration=4",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        black,
      ]);
      ffmpeg([
        "-i",
        good,
        "-i",
        black,
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1[v]",
        "-map",
        "[v]",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        split,
      ]);
      const measurements = measureClip(split);
      // The catastrophic half IS visible in the (unused) brightness std.
      expect(measurements.brightnessStdLuma ?? 0).toBeGreaterThan(40);
      const verdict = evaluateCaptureEnvelope(measurements);
      expect(verdict.overall).toBe("SUPPORTED"); // pinned gap
    });
  },
);
