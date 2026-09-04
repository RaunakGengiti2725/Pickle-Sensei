import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { evaluateFrameAnalyzability } from "@pickle/vision-geometry";
import {
  extractFrameStats,
  extractFrameStatsAsync,
  FrameStatsToolingError,
} from "../src/frameStats.js";
import { measureOodCorpusWaveE } from "../src/oodGateWaveE.js";
import { measureOodNegatives } from "../src/oodNegativesMeasure.js";

/**
 * Pins two contracts of the ffmpeg-backed frame-statistics extractor:
 *
 * 1. Infrastructure failures (no ffmpeg/ffprobe on PATH, input file missing)
 *    are thrown as `FrameStatsToolingError`, never returned as a media verdict.
 *    Before this pin they came back as `{frameCount: 0, decode.errorCount: 1}`
 *    — indistinguishable from a corrupt clip — and a bench run with an empty
 *    PATH "abstained" on every clip and exited 0.
 * 2. Truncated Matroska/WebM clips are rejected. The demuxer reports the cut
 *    only as a warning ("File ended prematurely") and ffmpeg exits 0, so the
 *    decoded-frame deficit has to be counted on its own.
 *
 * Fixtures are generated at test time with ffmpeg. Where ffmpeg is absent the
 * ffmpeg-backed cases skip — except in CI, where the gate must fail loudly.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const repoRoot = resolve(packageRoot, "..", "..");
const validClip = join(repoRoot, "datasets", "ood", "positive", "backhand-dink-front-view.mp4");

const ffmpegAvailable = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
if (!ffmpegAvailable && process.env.CI !== undefined) {
  throw new Error(
    "ffmpeg is not on PATH but CI is set: frameStats fixtures cannot be generated. Install ffmpeg in the CI image instead of skipping this suite.",
  );
}
const withFfmpeg = ffmpegAvailable ? describe : describe.skip;

const workDir = mkdtempSync(join(tmpdir(), "frame-stats-test-"));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function truncateTo(source: string, fraction: number): string {
  const bytes = readFileSync(source);
  const cut = Math.floor(bytes.byteLength * fraction);
  const out = join(workDir, `${fraction}-${source.split("/").pop() ?? "clip"}`);
  writeFileSync(out, bytes.subarray(0, cut));
  return out;
}

function expectToolingError(error: unknown, pattern: RegExp): FrameStatsToolingError {
  expect(error).toBeInstanceOf(FrameStatsToolingError);
  const tooling = error as FrameStatsToolingError;
  expect(tooling.kind).toBe("tooling_error");
  expect(tooling.message).toMatch(pattern);
  return tooling;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function withEmptyPath<T>(run: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    return run();
  } finally {
    process.env.PATH = previous;
  }
}

describe("extractFrameStats: infrastructure failures are errors, not media verdicts", () => {
  it("throws a tooling error naming ffmpeg/ffprobe when PATH is empty (sync)", () => {
    expect(statSync(validClip).isFile()).toBe(true);
    let caught: unknown = null;
    withEmptyPath(() => {
      try {
        extractFrameStats(validClip);
      } catch (error) {
        caught = error;
      }
    });
    const tooling = expectToolingError(
      caught,
      /ff(mpeg|probe).*not found|not found.*ff(mpeg|probe)/i,
    );
    expect(tooling.code).toBe("ENOENT");
    expect(["ffmpeg", "ffprobe"]).toContain(tooling.tool);
  });

  it("rejects identically when PATH is empty (async)", async () => {
    const previous = process.env.PATH;
    process.env.PATH = "";
    let caught: unknown;
    try {
      caught = await captureRejection(extractFrameStatsAsync(validClip));
    } finally {
      process.env.PATH = previous;
    }
    const tooling = expectToolingError(
      caught,
      /ff(mpeg|probe).*not found|not found.*ff(mpeg|probe)/i,
    );
    expect(tooling.code).toBe("ENOENT");
  });

  it("throws an ENOENT-classified error for a nonexistent input path (sync + async)", async () => {
    const missing = join(workDir, "nonexistent.mp4");
    let caught: unknown = null;
    try {
      extractFrameStats(missing);
    } catch (error) {
      caught = error;
    }
    const sync = expectToolingError(caught, /nonexistent\.mp4/);
    expect(sync.code).toBe("ENOENT");
    expect(sync.tool).toBe("input");

    const async = expectToolingError(
      await captureRejection(extractFrameStatsAsync(missing)),
      /nonexistent\.mp4/,
    );
    expect(async.code).toBe("ENOENT");
    expect(async.tool).toBe("input");
  });

  it("throws an ENOENT-classified error for a directory passed as the input", () => {
    let caught: unknown = null;
    try {
      extractFrameStats(workDir);
    } catch (error) {
      caught = error;
    }
    expect(expectToolingError(caught, /not a file|ENOENT/i).tool).toBe("input");
  });

  withFfmpeg("with ffmpeg present", () => {
    it("still returns a media verdict (undecodable_media) for a genuinely corrupt file", async () => {
      const corrupt = join(workDir, "corrupt.mp4");
      const noise = Buffer.alloc(64 * 1024);
      for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
      writeFileSync(corrupt, noise);

      const stats = extractFrameStats(corrupt);
      expect(stats.frameCount).toBe(0);
      expect(stats.decode).toBeDefined();
      expect(stats.decode?.errorCount ?? 0).toBeGreaterThan(0);
      const report = evaluateFrameAnalyzability(stats);
      expect(report.analyzable).toBe(false);
      expect(report.reasons).toContain("undecodable_media");

      expect(await extractFrameStatsAsync(corrupt)).toEqual(stats);
    });

    it("OOD measurement entry points propagate the tooling error instead of recording abstentions", () => {
      let waveE: unknown = null;
      let negatives: unknown = null;
      withEmptyPath(() => {
        try {
          measureOodCorpusWaveE();
        } catch (error) {
          waveE = error;
        }
        try {
          measureOodNegatives();
        } catch (error) {
          negatives = error;
        }
      });
      expectToolingError(waveE, /ff(mpeg|probe)/i);
      expectToolingError(negatives, /ff(mpeg|probe)/i);
    });

    it("an OOD bench process with no toolchain exits non-zero and names the missing tool", () => {
      // Mirrors the `invokedDirectly` block of oodGateWaveE.ts without its file
      // write, so a regression here can never overwrite the committed dataset.
      const script = join(workDir, "run-ood-gate.ts");
      writeFileSync(
        script,
        [
          `import { measureOodCorpusWaveE } from ${JSON.stringify(join(packageRoot, "src", "oodGateWaveE.ts"))};`,
          "const measurements = measureOodCorpusWaveE();",
          "console.log(JSON.stringify({ abstained: measurements.filter((m) => !m.gateOk).length }));",
          "",
        ].join("\n"),
      );
      const tsxCli = join(packageRoot, "node_modules", "tsx", "dist", "cli.mjs");
      const result = spawnSync(process.execPath, [tsxCli, script], {
        cwd: packageRoot,
        env: { ...process.env, PATH: "" },
        encoding: "utf8",
        timeout: 120_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, `stdout=${result.stdout}\nstderr=${result.stderr}`).not.toBe(0);
      expect(result.stderr).toMatch(/ff(mpeg|probe)/i);
      expect(result.stdout).not.toMatch(/abstained/);
    });
  });
});

withFfmpeg("extractFrameStats: truncated Matroska is rejected even though ffmpeg exits 0", () => {
  const intact = join(workDir, "mandelbrot.mkv");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "mandelbrot=size=320x240:rate=30",
      "-t",
      "3",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-g",
      "1",
      intact,
    ],
    { stdio: "ignore" },
  );
  const half = truncateTo(intact, 0.5);
  const third = truncateTo(intact, 0.3);

  it("the intact clip decodes every declared frame and is analyzable", async () => {
    const stats = extractFrameStats(intact);
    expect(stats.decode).toEqual({ errorCount: 0, expectedFrameCount: 90 });
    expect(stats.frameCount).toBe(90);
    const report = evaluateFrameAnalyzability(stats);
    expect(report.analyzable, report.reasons.join(",")).toBe(true);
    expect(await extractFrameStatsAsync(intact)).toEqual(stats);
  });

  it.each([
    ["50%", half],
    ["30%", third],
  ])("the clip cut at %s records the demuxer EOF and fails the deficit check", async (_, clip) => {
    const stats = extractFrameStats(clip);
    // ffmpeg exits 0 here; only stderr carries "[matroska,webm] File ended prematurely".
    expect(stats.decode?.expectedFrameCount).toBe(90);
    expect(stats.frameCount).toBeGreaterThan(1);
    expect(stats.frameCount).toBeLessThan(0.9 * 90);
    expect(stats.decode?.errorCount ?? 0).toBeGreaterThan(0);

    const report = evaluateFrameAnalyzability(stats);
    expect(report.analyzable).toBe(false);
    expect(report.reasons).toContain("decoded_frame_deficit");
    expect(report.reasons).not.toContain("undecodable_media");

    expect(await extractFrameStatsAsync(clip)).toEqual(stats);
  });

  it("does not count the Matroska EOF warning against an intact clip of another container", () => {
    const mp4 = join(workDir, "mandelbrot.mp4");
    execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "mandelbrot=size=320x240:rate=30",
        "-t",
        "3",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4,
      ],
      { stdio: "ignore" },
    );
    const stats = extractFrameStats(mp4);
    expect(stats.decode).toEqual({ errorCount: 0, expectedFrameCount: 90 });
    expect(evaluateFrameAnalyzability(stats).analyzable).toBe(true);
  });
});
