import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * P0-05 adversarial tests (attack branch) for the ffmpeg 4.4 portability fix.
 *
 * 1. Runtime: the flag the fixtures now use (`-vsync passthrough`) must be
 *    accepted by whichever ffmpeg is on PATH and re-timing with it must keep
 *    every frame (the property the red-team fixtures rely on); the premise
 *    of the fix (fps_mode unknown before 5.1) is checked on that same binary.
 * 2. Scope of the static pin: test/ffmpegPortability.test.ts only lists the
 *    IMMEDIATE `.ts` children of src/ and test/. A fixture in a nested
 *    directory or a non-.ts helper (.mts/.mjs/.sh) that reintroduces the
 *    ffmpeg >= 5.1-only flag would evade it. This file lives in a nested
 *    directory and spells the forbidden flag inside a quoted string on
 *    purpose: the candidate pin still passes with it present, while a
 *    recursive scan finds exactly this file and nothing else.
 */

const selfPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(selfPath), "..", "..");
// Deliberately the exact quoted spelling the static pin greps for.
const FORBIDDEN_FLAG = "-fps_mode";
const QUOTED_FORBIDDEN = `"${FORBIDDEN_FLAG}"`;

const hasFfmpeg =
  spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

function ffmpeg(args: string[]): void {
  execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "ignore", "pipe"] });
}

// nb_read_frames (decoded frame count) is reported identically by ffprobe
// 4.4 through 8.x; per-frame `pts` only exists from ffprobe 5 on.
function frameCount(path: string): number {
  const out = execFileSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-count_frames",
      "-show_entries",
      "stream=nb_read_frames",
      "-of",
      "csv=p=0",
      path,
    ],
    { encoding: "utf8" },
  );
  return Number(out.trim());
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const SCRIPT_LIKE = /\.(c|m)?(t|j)sx?$|\.sh$|\.py$/;

describe.skipIf(!hasFfmpeg)(
  "attack: -vsync passthrough on the PATH ffmpeg",
  { timeout: 60_000 },
  () => {
    let dir: string;
    let base: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "p0-05-attack-ffmpeg-"));
      base = join(dir, "base.mp4");
      ffmpeg([
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=30:duration=1",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        base,
      ]);
    });

    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("is accepted (exit 0) and preserves the frame count when re-timing with setpts", () => {
      const out = join(dir, "retimed.mp4");
      ffmpeg([
        "-i",
        base,
        "-vf",
        "setpts=floor(N/2)*2/30/TB",
        "-vsync",
        "passthrough",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        out,
      ]);
      const before = frameCount(base);
      const after = frameCount(out);
      expect(before).toBe(30);
      expect(after).toBe(before);
    });

    it("the premise of the fix holds on the PATH ffmpeg: fps_mode is rejected before 5.1 and accepted from 5.1 on", () => {
      const banner =
        spawnSync("ffmpeg", ["-version"], { encoding: "utf8" }).stdout.split("\n")[0] ?? "";
      const match = /^ffmpeg version n?(\d+)\.(\d+)/.exec(banner);
      expect(match).not.toBeNull();
      const major = Number(match?.[1]);
      const minor = Number(match?.[2]);
      const supportsFpsMode = major > 5 || (major === 5 && minor >= 1);

      const out = join(dir, "fpsmode.mp4");
      const run = spawnSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-y",
          "-i",
          base,
          FORBIDDEN_FLAG,
          "passthrough",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          out,
        ],
        { encoding: "utf8" },
      );
      if (supportsFpsMode) {
        expect(run.status).toBe(0);
      } else {
        expect(run.status).not.toBe(0);
        expect(run.stderr).toContain("Unrecognized option");
      }
    });
  },
);

describe("attack: scope of the static ffmpeg portability pin", () => {
  const scannedByCandidate = ["src", "test"].flatMap((dir) =>
    readdirSync(join(packageRoot, dir))
      .filter((name) => name.endsWith(".ts") && name !== "ffmpegPortability.test.ts")
      .map((name) => join(dir, name)),
  );

  const allScriptLike = ["src", "test"]
    .flatMap((dir) => walk(join(packageRoot, dir)))
    .filter((file) => SCRIPT_LIKE.test(file))
    .map((file) => relative(packageRoot, file));

  it("the pin's file list includes a nested test/**/*.ts file that spells the forbidden flag in quotes", () => {
    // Precondition: this file really carries the quoted flag the pin greps for.
    const self = relative(packageRoot, selfPath);
    expect(readFileSync(selfPath, "utf8")).toContain(QUOTED_FORBIDDEN);
    // If the pin scanned recursively it would list this file (and then fail
    // on it). It does not: a nested fixture reintroducing fps_mode is invisible.
    expect(scannedByCandidate).toContain(self);
  });

  it("a recursive scan of every script-like file finds the forbidden flag ONLY in this attack file", () => {
    const self = relative(packageRoot, selfPath);
    const offenders = allScriptLike.filter((file) => {
      const text = readFileSync(join(packageRoot, file), "utf8");
      return new RegExp(`["'\`]${FORBIDDEN_FLAG}["'\`]`).test(text);
    });
    expect(offenders).toEqual([self]);
  });

  it("the candidate's flat scan covers every script-like file under src/ and test/ (nested / non-.ts files included)", () => {
    const self = relative(packageRoot, selfPath);
    const uncovered = allScriptLike.filter(
      (file) =>
        file !== self &&
        !scannedByCandidate.includes(file) &&
        basename(file) !== "ffmpegPortability.test.ts",
    );
    expect(uncovered).toEqual([]);
  });
});
