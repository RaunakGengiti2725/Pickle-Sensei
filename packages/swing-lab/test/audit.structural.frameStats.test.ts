/**
 * Structural audit (pass 1) — frameStats subprocess error-path probes.
 *
 * The OOD gate consumes `decode.errorCount`/`frameCount` to decide
 * "undecodable_media". These probes check that infrastructure failures
 * (decoder toolchain missing from PATH; input path that does not exist) are
 * distinguishable from corrupt media: both extractors throw a typed
 * FrameStatsError (kind `toolchain_unavailable` / `input_missing`) instead of
 * returning a FrameStats the gate could score.
 *
 * Plane: Linux bench (replay proxy). Requires ffmpeg/ffprobe on PATH for the
 * control case; the "missing toolchain" cases remove PATH deliberately.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import { afterEach, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/engine/corpus.js";
import {
  FrameStatsError,
  extractFrameStats,
  extractFrameStatsAsync,
  type FrameStatsFailureKind,
} from "../src/frameStats.js";

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

/** PATH containing only the real ffmpeg (resolved before PATH is replaced). */
function keepOnlyFfmpegOnPath(): void {
  const ffmpeg = execFileSync("sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).trim();
  const only = mkdtempSync(join(tmpdir(), "audit-ffmpeg-only-path-"));
  symlinkSync(ffmpeg, join(only, "ffmpeg"));
  process.env.PATH = only;
}

interface Outcome {
  threw: boolean;
  /** FrameStatsError.kind when the extractor threw one; null otherwise. */
  failureKind: FrameStatsFailureKind | null;
  frameCount: number | null;
  decodeErrorCount: number | null;
  reasons: string[];
}

function outcomeOf(run: () => FrameStats): Outcome {
  try {
    const stats = run();
    return {
      threw: false,
      failureKind: null,
      frameCount: stats.frameCount,
      decodeErrorCount: stats.decode?.errorCount ?? null,
      reasons: evaluateFrameAnalyzability(stats).reasons,
    };
  } catch (error) {
    return {
      threw: true,
      failureKind: error instanceof FrameStatsError ? error.kind : null,
      frameCount: null,
      decodeErrorCount: null,
      reasons: [],
    };
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
    // On 4d812e1a this resolved to frameCount 0 + "undecodable_media" for a
    // clip that decodes fine with the toolchain present (see control).
    expect(outcome).toMatchObject({ threw: true, failureKind: "toolchain_unavailable" });
  });

  it("async: extractFrameStatsAsync rejects when ffmpeg is absent from PATH", async () => {
    removeToolchainFromPath();
    let rejected: unknown = null;
    let reasons: string[] = [];
    try {
      const stats = await extractFrameStatsAsync(CLIP);
      reasons = evaluateFrameAnalyzability(stats).reasons;
    } catch (error) {
      rejected = error;
    }
    expect(reasons).toEqual([]);
    expect(rejected).toBeInstanceOf(FrameStatsError);
    expect(rejected).toMatchObject({ kind: "toolchain_unavailable", tool: "ffmpeg" });
  });

  it("a missing ffprobe (ffmpeg present) is reported against ffprobe, sync and async alike", async () => {
    keepOnlyFfmpegOnPath();
    const expected = { name: "FrameStatsError", kind: "toolchain_unavailable", tool: "ffprobe" };
    expect(() => extractFrameStats(CLIP)).toThrow(expect.objectContaining(expected));
    await expect(extractFrameStatsAsync(CLIP)).rejects.toMatchObject(expected);
  });

  it("sync and async agree on the failure (kind, tool, path)", async () => {
    removeToolchainFromPath();
    const async = await extractFrameStatsAsync(CLIP).then(
      () => null,
      (error: unknown) => error,
    );
    let sync: unknown = null;
    try {
      extractFrameStats(CLIP);
    } catch (error) {
      sync = error;
    }
    expect(sync).toBeInstanceOf(FrameStatsError);
    expect(async).toBeInstanceOf(FrameStatsError);
    const shape = (error: unknown) => {
      const { kind, tool, videoPath, message } = error as FrameStatsError;
      return { kind, tool, videoPath, message };
    };
    expect(shape(sync)).toEqual(shape(async));
    expect(shape(sync).message).toMatch(/ENOENT/);
  });
});

describe("audit: nonexistent input path", () => {
  it("a path that does not exist throws rather than being scored as undecodable media", () => {
    const outcome = outcomeOf(() =>
      extractFrameStats(join(REPO_ROOT, "datasets", "does-not-exist.mp4")),
    );
    expect(outcome).toMatchObject({ threw: true, failureKind: "input_missing" });
  });

  it("async: a path that does not exist rejects with the same input_missing failure", async () => {
    const missing = join(REPO_ROOT, "datasets", "does-not-exist.mp4");
    await expect(extractFrameStatsAsync(missing)).rejects.toMatchObject({
      name: "FrameStatsError",
      kind: "input_missing",
      tool: null,
      videoPath: missing,
    });
  });

  it("nonexistent input and missing toolchain do not collapse to the same verdict as each other", () => {
    const missingInput = outcomeOf(() =>
      extractFrameStats(join(REPO_ROOT, "datasets", "does-not-exist.mp4")),
    );
    removeToolchainFromPath();
    const missingTool = outcomeOf(() => extractFrameStats(CLIP));
    // Both are infrastructure failures; neither reaches the OOD gate, and a
    // caller can tell "no file" from "no decoder" by the typed kind.
    expect(missingInput.failureKind).toBe("input_missing");
    expect(missingTool.failureKind).toBe("toolchain_unavailable");
    expect({ missingInput, missingTool }).toMatchObject({
      missingInput: { threw: true, reasons: [] },
      missingTool: { threw: true, reasons: [] },
    });
  });
});
