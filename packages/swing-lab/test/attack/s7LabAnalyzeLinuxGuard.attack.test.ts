import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/engine/corpus.js";

/**
 * ADVERSARIAL S7 — `pnpm lab:analyze` on Linux.
 *
 * analyzeVideo.ts drives the Apple-Vision native extractor
 * (native/swing-lab, built with `swift build`). On the Linux bench plane that
 * toolchain does not exist, so the ONLY correct outcome is a clear, early
 * "native extractor requires macOS" refusal, exit non-zero, BEFORE any
 * side effect. The attack runs the real root script against a tiny valid MP4
 * and checks the order of operations: does the out dir exist when the run
 * dies, and what does the operator actually read on stderr?
 */

const tmp = mkdtempSync(join(tmpdir(), "attack-s7-lab-analyze-"));
/** Kept after the run (evidence); the fixture dir above is removed. */
const artifacts = mkdtempSync(join(tmpdir(), "attack-s7-artifacts-"));
const video = join(tmp, "tiny.mp4");
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
  console.log(`S7 evidence: ${artifacts}`);
});

const CLEAR_GUARD =
  /native extractor requires macOS|requires macOS|only supported on macOS|darwin/i;
const LOW_LEVEL = /ENOENT|spawnSync swift|spawn swift/i;

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  outDirExists: boolean;
  outDirEntries: string[];
}

function labAnalyze(args: string[], outDir: string): RunResult {
  const result = spawnSync("pnpm", ["lab:analyze", ...args, "--out", outDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    timeout: 120_000,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    outDirExists: existsSync(outDir),
    outDirEntries: existsSync(outDir) ? readdirSync(outDir) : [],
  };
}

describe("ADVERSARIAL S7: pnpm lab:analyze on the Linux bench plane", () => {
  beforeAll(() => {
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "mandelbrot=size=64x36:rate=30",
      "-t",
      "0.5",
      "-pix_fmt",
      "yuv420p",
      video,
    ]);
    expect(existsSync(video)).toBe(true);
  });

  it("precondition: this is Linux and `swift` is not on PATH (otherwise the scenario is moot)", () => {
    expect(process.platform).toBe("linux");
    const which = spawnSync("sh", ["-c", "command -v swift"], { encoding: "utf8" });
    expect(which.status, `swift found at ${which.stdout.trim()}`).not.toBe(0);
  });

  it("control: a missing video is refused BEFORE the out dir is created (exit 2, clear message)", () => {
    const outDir = join(tmp, "out-missing-video");
    const run = labAnalyze([join(tmp, "does-not-exist.mp4")], outDir);
    writeFileSync(join(artifacts, "control.json"), JSON.stringify(run, null, 2));
    expect(run.status).toBe(2);
    expect(`${run.stdout}\n${run.stderr}`).toMatch(/video not found/);
    expect(run.outDirExists).toBe(false);
  });

  it("attack: a valid tiny mp4 must fail with a clear 'native extractor requires macOS' error and NO out dir", () => {
    const outDir = join(tmp, "out-attack");
    const run = labAnalyze([video], outDir);
    writeFileSync(join(artifacts, "attack.json"), JSON.stringify(run, null, 2));
    const text = `${run.stdout}\n${run.stderr}`;

    expect(run.status, text).not.toBe(0);
    expect(run.status).not.toBeNull();

    // What the operator reads. Today: "building native extractor (first
    // run)…" followed by a raw `spawnSync swift ENOENT` stack trace.
    expect(text, `stdout/stderr did not contain a clear guard:\n${text.slice(0, 2000)}`).toMatch(
      CLEAR_GUARD,
    );
    expect(
      text,
      `low-level toolchain error leaked to the operator:\n${text.slice(0, 2000)}`,
    ).not.toMatch(LOW_LEVEL);

    // Side effect ordering: nothing may be created for a run that cannot
    // proceed on this plane.
    expect(
      run.outDirExists,
      `out dir was created before the platform check (entries: ${JSON.stringify(run.outDirEntries)})`,
    ).toBe(false);
  });

  it("attack (repeat, --reuse-extract with no artifacts): same guard, same ordering", () => {
    const outDir = join(tmp, "out-reuse");
    const run = labAnalyze([video, "--reuse-extract"], outDir);
    writeFileSync(join(artifacts, "attack-reuse.json"), JSON.stringify(run, null, 2));
    const text = `${run.stdout}\n${run.stderr}`;
    expect(run.status, text).not.toBe(0);
    expect(text).toMatch(CLEAR_GUARD);
    expect(run.outDirExists).toBe(false);
  });

  it("attack (nested out dir): no parent directories are materialized either", () => {
    const outDir = join(tmp, "deep", "nested", "out");
    const run = labAnalyze([video], outDir);
    writeFileSync(join(artifacts, "attack-nested.json"), JSON.stringify(run, null, 2));
    expect(run.status).not.toBe(0);
    expect(
      existsSync(join(tmp, "deep")),
      "mkdirSync recursive created the whole parent chain",
    ).toBe(false);
  });
});
