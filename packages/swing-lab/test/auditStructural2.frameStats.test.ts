import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { extractFrameStats, extractFrameStatsAsync } from "../src/frameStats.js";

/**
 * Structural audit (pass 1, auditor #2) — frameStats error-path
 * distinguishability. extractFrameStats feeds the pre-analysis OOD gate,
 * envelope certification (h17) and OOD negative measurements. If ffmpeg is
 * absent from PATH the result must not be indistinguishable from "this clip
 * is corrupt", otherwise a mis-provisioned bench host silently produces
 * abstention verdicts that look like measurements. A FAILING test is a
 * reproduced finding on 4d812e1a.
 */

const dir = mkdtempSync(join(tmpdir(), "audit-framestats-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const originalPath = process.env["PATH"];
afterEach(() => {
  process.env["PATH"] = originalPath;
});

const corrupt = join(dir, "corrupt.mp4");
writeFileSync(corrupt, Buffer.from("definitely not an mp4 container, just bytes"));

describe("audit: ffmpeg ENOENT vs corrupt media", () => {
  it("sync: a missing ffmpeg binary is not reported as a decoded-but-corrupt clip", () => {
    const withTool = extractFrameStats(corrupt);
    expect(withTool.frameCount).toBe(0);

    process.env["PATH"] = dir; // no ffmpeg / ffprobe reachable
    let noTool: ReturnType<typeof extractFrameStats> | null = null;
    let threw: unknown = null;
    try {
      noTool = extractFrameStats(corrupt);
    } catch (error) {
      threw = error;
    }
    // Acceptable: throw (ENOENT surfaces) — OR return something a caller can
    // tell apart from the corrupt-media result.
    if (threw === null) {
      expect(noTool).not.toEqual(withTool);
    }
  });

  it("async: a missing ffmpeg binary is not reported as a decoded-but-corrupt clip", async () => {
    const withTool = await extractFrameStatsAsync(corrupt);
    expect(withTool.frameCount).toBe(0);

    process.env["PATH"] = dir;
    let noTool: Awaited<ReturnType<typeof extractFrameStatsAsync>> | null = null;
    let threw: unknown = null;
    try {
      noTool = await extractFrameStatsAsync(corrupt);
    } catch (error) {
      threw = error;
    }
    if (threw === null) {
      expect(noTool).not.toEqual(withTool);
    }
  });

  it("sync: a NONEXISTENT input path is distinguishable from a corrupt one", () => {
    const missing = extractFrameStats(join(dir, "does-not-exist.mp4"));
    const bad = extractFrameStats(corrupt);
    expect(missing).not.toEqual(bad);
  });
});
