/**
 * Structural audit (pass 1) — frameStats subprocess error-path probes.
 *
 * The OOD gate consumes `decode.errorCount`/`frameCount` to decide
 * "undecodable_media". These probes check whether infrastructure failures
 * (decoder toolchain missing from PATH; input path that does not exist) are
 * distinguishable from corrupt media. A FAILING case is the evidence for a
 * finding; production code is not modified.
 *
 * Plane: Linux bench (replay proxy). Requires ffmpeg/ffprobe on PATH for the
 * control case; the "missing toolchain" cases remove PATH deliberately.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/engine/corpus.js";
import { extractFrameStats, extractFrameStatsAsync } from "../src/frameStats.js";

type FrameStats = ReturnType<typeof extractFrameStats>;

// Committed DEV bundle (not held out).
const CLIP = join(
  REPO_ROOT,
  "datasets",
  "paddle-bench",
  "bundles",
  "afn-sasebo-rally1",
  "clip.mp4",
);

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

function removeToolchainFromPath(): void {
  process.env.PATH = mkdtempSync(join(tmpdir(), "audit-empty-path-"));
}

interface Outcome {
  threw: boolean;
  frameCount: number | null;
  decodeErrorCount: number | null;
  reasons: string[];
}

function outcomeOf(run: () => FrameStats): Outcome {
  try {
    const stats = run();
    return {
      threw: false,
      frameCount: stats.frameCount,
      decodeErrorCount: stats.decode?.errorCount ?? null,
      reasons: evaluateFrameAnalyzability(stats).reasons,
    };
  } catch {
    return { threw: true, frameCount: null, decodeErrorCount: null, reasons: [] };
  }
}

describe("audit: frameStats control", () => {
  it("with the toolchain present the dev clip decodes and passes the frame gate", () => {
    const stats = extractFrameStats(CLIP);
    expect(stats.frameCount).toBeGreaterThan(0);
    expect(stats.decode?.errorCount ?? 0).toBe(0);
    expect(evaluateFrameAnalyzability(stats).analyzable).toBe(true);
  });
});

describe("audit: missing decoder toolchain is an infrastructure error, not a media verdict", () => {
  it("sync: extractFrameStats throws when ffmpeg is absent from PATH", () => {
    removeToolchainFromPath();
    const outcome = outcomeOf(() => extractFrameStats(CLIP));
    // On the baseline this resolves to frameCount 0 + "undecodable_media" for
    // a clip that decodes fine with the toolchain present (see control).
    expect(outcome.threw).toBe(true);
  });

  it("async: extractFrameStatsAsync rejects when ffmpeg is absent from PATH", async () => {
    removeToolchainFromPath();
    let rejected = false;
    let reasons: string[] = [];
    try {
      const stats = await extractFrameStatsAsync(CLIP);
      reasons = evaluateFrameAnalyzability(stats).reasons;
    } catch {
      rejected = true;
    }
    expect({ rejected, reasons }).toEqual({ rejected: true, reasons: [] });
  });
});

describe("audit: nonexistent input path", () => {
  it("a path that does not exist throws rather than being scored as undecodable media", () => {
    const outcome = outcomeOf(() =>
      extractFrameStats(join(REPO_ROOT, "datasets", "does-not-exist.mp4")),
    );
    expect(outcome.threw).toBe(true);
  });

  it("nonexistent input and missing toolchain do not collapse to the same verdict as each other", () => {
    const missingInput = outcomeOf(() =>
      extractFrameStats(join(REPO_ROOT, "datasets", "does-not-exist.mp4")),
    );
    removeToolchainFromPath();
    const missingTool = outcomeOf(() => extractFrameStats(CLIP));
    // Both are infrastructure failures; the OOD gate must not receive an
    // identical (frameCount, reasons) tuple for "no file" and "no decoder".
    expect({
      sameFrameCount: missingInput.frameCount === missingTool.frameCount,
      sameReasons: JSON.stringify(missingInput.reasons) === JSON.stringify(missingTool.reasons),
      missingInput,
      missingTool,
    }).toMatchObject({ sameFrameCount: false });
  });
});
