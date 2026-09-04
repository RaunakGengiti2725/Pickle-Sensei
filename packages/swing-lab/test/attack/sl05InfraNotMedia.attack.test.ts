import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * ADVERSARIAL SL-05 follow-up — infrastructure failures the fix at 5af4f1a4
 * still scores as `undecodable_media`.
 *
 * frameStats.ts now promises: "A FrameStats value is always a statement about
 * the media: it exists only when the input file was found and ffmpeg/ffprobe
 * actually ran on it." These attacks keep the media itself healthy (the same
 * clip passes the control) and break only the host:
 *
 *  1. ffmpeg IS on PATH but its dynamic loader fails (missing shared library,
 *     exit 127, "error while loading shared libraries" on stderr). ffmpeg never
 *     ran on the media, yet the gate brands the healthy clip undecodable.
 *  2. The input path exists but is a DIRECTORY. `assertInputExists` stats the
 *     path and discards the result, so ffmpeg's EISDIR becomes a media verdict.
 *  3. The input file exists but is UNREADABLE (mode 000). stat() succeeds, so
 *     the extractor proceeds and ffmpeg's EACCES becomes a media verdict.
 *
 * Each case expects a FrameStatsError (sync and async agree) rather than a
 * `{frameCount: 0, decode: {errorCount: 1}}` shape — the very conflation
 * SL-05 was raised for.
 */

const dir = mkdtempSync(join(tmpdir(), "attack-sl05-infra-"));
const healthyClip = join(dir, "healthy.mp4");
const originalPath = process.env.PATH;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

type Outcome = { kind: "returned"; stats: unknown } | { kind: "threw"; error: unknown };

function runSync(path: string): Outcome {
  try {
    return { kind: "returned", stats: extractFrameStats(path) };
  } catch (error) {
    return { kind: "threw", error };
  }
}

async function runAsync(path: string): Promise<Outcome> {
  try {
    return { kind: "returned", stats: await extractFrameStatsAsync(path) };
  } catch (error) {
    return { kind: "threw", error };
  }
}

/** Fails when the extractor handed a healthy clip to the gate as broken media. */
function expectInfrastructureFailure(label: string, outcome: Outcome): void {
  if (outcome.kind === "returned") {
    const report = evaluateFrameAnalyzability(
      outcome.stats as ReturnType<typeof extractFrameStats>,
    );
    expect(
      report.reasons,
      `${label}: infrastructure failure scored as a media verdict: ${JSON.stringify(outcome.stats)}`,
    ).not.toContain("undecodable_media");
    return;
  }
  expect(outcome.error, `${label}: error is not a FrameStatsError`).toBeInstanceOf(FrameStatsError);
}

/** A fake ffmpeg/ffprobe that behaves like a binary whose shared libraries are gone. */
function loaderFailureShimDir(): string {
  const shim = mkdtempSync(join(tmpdir(), "attack-sl05-noldso-"));
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const bin = join(shim, tool);
    writeFileSync(
      bin,
      `#!/bin/sh\necho "${tool}: error while loading shared libraries: libavcodec.so.60: cannot open shared object file: No such file or directory" >&2\nexit 127\n`,
    );
    chmodSync(bin, 0o755);
  }
  return shim;
}

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
    "2",
    "-pix_fmt",
    "yuv420p",
    healthyClip,
  ]);
});
afterEach(() => {
  process.env.PATH = originalPath;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("ADVERSARIAL SL-05: infrastructure failures must not become media verdicts", () => {
  it("control: the clip is healthy with a working toolchain", async () => {
    const sync = extractFrameStats(healthyClip);
    const async = await extractFrameStatsAsync(healthyClip);
    expect(sync.frameCount).toBeGreaterThanOrEqual(50);
    expect(sync.decode?.errorCount).toBe(0);
    expect(async).toEqual(sync);
  });

  it("ffmpeg on PATH but unable to load its shared libraries is a toolchain failure, not undecodable media", async () => {
    process.env.PATH = loaderFailureShimDir();
    const sync = runSync(healthyClip);
    const async = await runAsync(healthyClip);
    writeFileSync(
      join(dir, "loader-failure.json"),
      JSON.stringify({ sync: String(sync.kind === "threw" ? sync.error : sync.stats) }, null, 2),
    );
    expectInfrastructureFailure("sync loader failure", sync);
    expectInfrastructureFailure("async loader failure", async);
    expect(sync).toMatchObject({ kind: "threw", error: { kind: "toolchain_unavailable" } });
    expect(async).toMatchObject({ kind: "threw", error: { kind: "toolchain_unavailable" } });
  });

  it("a directory as the input path is an input failure, not undecodable media", async () => {
    const asDir = join(dir, "clip-is-a-directory.mp4");
    mkdirSync(asDir);
    const sync = runSync(asDir);
    const async = await runAsync(asDir);
    expectInfrastructureFailure("sync directory input", sync);
    expectInfrastructureFailure("async directory input", async);
    expect(sync).toMatchObject({ kind: "threw", error: { tool: null } });
    expect(async).toMatchObject({ kind: "threw", error: { tool: null } });
  });

  it.runIf(!isRoot)(
    "an unreadable (mode 000) input file is an input failure, not undecodable media",
    async () => {
      const locked = join(dir, "unreadable.mp4");
      execFileSync("cp", [healthyClip, locked]);
      chmodSync(locked, 0o000);
      try {
        const sync = runSync(locked);
        const async = await runAsync(locked);
        expectInfrastructureFailure("sync unreadable input", sync);
        expectInfrastructureFailure("async unreadable input", async);
        expect(sync).toMatchObject({ kind: "threw", error: { tool: null } });
        expect(async).toMatchObject({ kind: "threw", error: { tool: null } });
      } finally {
        chmodSync(locked, 0o644);
      }
    },
  );
});
