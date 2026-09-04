import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  FrameStatsError,
  extractFrameStats,
  extractFrameStatsAsync,
} from "../../src/frameStats.js";

/**
 * ADVERSARIAL S4 — ffmpeg missing (ENOENT) must not masquerade as a decode
 * error.
 *
 * `extractFrameStats` shells out to ffmpeg/ffprobe. With PATH emptied the
 * spawn fails with ENOENT — a TOOLING failure on the bench host. A real,
 * healthy clip must not be reported as `undecodable_media` (which is what the
 * OOD gate emits for frameCount 0 + decode.errorCount > 0): that verdict is
 * indistinguishable from a genuinely corrupt file and silently turns an
 * environment problem into a "video is bad" analysis result. The attack
 * asserts that the result (or a thrown error) names the tooling failure.
 *
 * Control: the SAME healthy clip is measured with ffmpeg on PATH and must be
 * analyzable, so any failure below is caused by the tooling, not the media.
 */

const dir = mkdtempSync(join(tmpdir(), "attack-s4-enoent-"));
const healthyClip = join(dir, "healthy.mp4");
const originalPath = process.env.PATH;

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "mandelbrot=size=320x240:rate=30",
    "-t",
    "3",
    "-pix_fmt",
    "yuv420p",
    healthyClip,
  ]);
});
afterEach(() => {
  process.env.PATH = originalPath;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Anything that would let a caller tell "ffmpeg unavailable" from "media corrupt". */
function namesToolingFailure(value: unknown): boolean {
  const text = JSON.stringify(value) ?? String(value);
  return /ENOENT|tool|ffmpeg|spawn|unavailable|not found|missing binary/i.test(text);
}

describe("ADVERSARIAL S4: extractFrameStats with ffmpeg ENOENT", () => {
  it("control: with ffmpeg on PATH the clip is healthy and analyzable", () => {
    const stats = extractFrameStats(healthyClip);
    expect(stats.frameCount).toBeGreaterThanOrEqual(80);
    expect(stats.decode?.errorCount).toBe(0);
    expect(evaluateFrameAnalyzability(stats).analyzable).toBe(true);
  });

  it("sync: with PATH emptied the result distinguishes tooling failure from decode errors", () => {
    process.env.PATH = "";
    let outcome: { kind: "returned"; stats: unknown } | { kind: "threw"; error: unknown };
    try {
      outcome = { kind: "returned", stats: extractFrameStats(healthyClip) };
    } catch (error) {
      outcome = { kind: "threw", error };
    }
    writeFileSync(join(dir, "sync-outcome.json"), JSON.stringify(outcome, null, 2));

    if (outcome.kind === "threw") {
      // Acceptable: a thrown error that names the missing tool.
      expect(namesToolingFailure(String(outcome.error))).toBe(true);
      return;
    }
    const stats = outcome.stats as ReturnType<typeof extractFrameStats>;
    // A healthy clip with no decoder involved must not be scored as a decode
    // error, and the gate must not brand it undecodable media.
    const report = evaluateFrameAnalyzability(stats);
    expect(
      report.reasons,
      `gate verdict for a HEALTHY clip when ffmpeg is merely absent: ${JSON.stringify(stats)}`,
    ).not.toContain("undecodable_media");
    expect(
      namesToolingFailure(stats),
      `result carries no tooling signal: ${JSON.stringify(stats)}`,
    ).toBe(true);
  });

  it("async: extractFrameStatsAsync behaves identically under ENOENT", async () => {
    process.env.PATH = "";
    let outcome: { kind: "returned"; stats: unknown } | { kind: "threw"; error: unknown };
    try {
      outcome = { kind: "returned", stats: await extractFrameStatsAsync(healthyClip) };
    } catch (error) {
      outcome = { kind: "threw", error };
    }
    writeFileSync(join(dir, "async-outcome.json"), JSON.stringify(outcome, null, 2));
    if (outcome.kind === "threw") {
      expect(namesToolingFailure(String(outcome.error))).toBe(true);
      return;
    }
    const stats = outcome.stats as Awaited<ReturnType<typeof extractFrameStatsAsync>>;
    expect(evaluateFrameAnalyzability(stats).reasons).not.toContain("undecodable_media");
    expect(namesToolingFailure(stats)).toBe(true);
  });

  it("EVIDENCE: ENOENT is a typed toolchain failure while a corrupt file is still a media verdict", async () => {
    // On 4d812e1a both collapsed to {frameCount:0, decode:{errorCount:1}} →
    // `undecodable_media`; the healthy clip must now never reach the gate.
    process.env.PATH = "";
    let enoentSync: unknown = null;
    try {
      extractFrameStats(healthyClip);
    } catch (error) {
      enoentSync = error;
    }
    const enoentAsync = await extractFrameStatsAsync(healthyClip).then(
      () => null,
      (error: unknown) => error,
    );
    process.env.PATH = originalPath;

    // A genuinely corrupt "video": 64 KiB of deterministic garbage bytes.
    const corrupt = join(dir, "corrupt.mp4");
    const bytes = Buffer.alloc(65_536);
    let seed = 0x5eed;
    for (let index = 0; index < bytes.length; index += 1) {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      bytes[index] = seed >>> 24;
    }
    writeFileSync(corrupt, bytes);
    const corruptStats = extractFrameStats(corrupt);
    const corruptReport = evaluateFrameAnalyzability(corruptStats);
    writeFileSync(
      join(dir, "enoent-vs-corrupt.json"),
      JSON.stringify(
        {
          enoentSync: String(enoentSync),
          enoentAsync: String(enoentAsync),
          corruptStats,
          corruptReport,
        },
        null,
        2,
      ),
    );

    for (const enoent of [enoentSync, enoentAsync]) {
      expect(enoent).toBeInstanceOf(FrameStatsError);
      expect(enoent).toMatchObject({
        kind: "toolchain_unavailable",
        tool: "ffmpeg",
        videoPath: healthyClip,
      });
      expect(namesToolingFailure(String(enoent))).toBe(true);
    }
    expect((enoentSync as FrameStatsError).message).toBe((enoentAsync as FrameStatsError).message);
    // The corrupt file is real media that ffmpeg ran on and rejected.
    expect(corruptStats.frameCount).toBe(0);
    expect(corruptStats.decode?.errorCount).toBeGreaterThan(0);
    expect(corruptReport.reasons).toContain("undecodable_media");
  });
});
