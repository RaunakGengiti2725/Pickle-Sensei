import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static pin: every ffmpeg invocation in this package (synthetic fixtures in
 * test/, research probes in src/) must stay runnable on ffmpeg 4.4, the
 * version Ubuntu 22.04 (the Linux verification plane) ships.
 *
 * The per-stream fps_mode option only exists in ffmpeg >= 5.1; the global
 * vsync option is accepted by every release from 4.4 through 8.0 (deprecated
 * but not removed). The fixtures were moved to vsync once already and
 * regressed to fps_mode in a later merge, which made the red-team suites
 * fail on the Linux plane while CI (ubuntu-latest) stayed green.
 */

const selfPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(selfPath), "..");

function listSourceFiles(dir: string): string[] {
  return readdirSync(join(packageRoot, dir))
    .filter((name) => name.endsWith(".ts") && name !== basename(selfPath))
    .map((name) => join(dir, name));
}

const sourceFiles = [...listSourceFiles("src"), ...listSourceFiles("test")];

function filesMatching(pattern: RegExp): string[] {
  return sourceFiles.filter((file) => pattern.test(readFileSync(join(packageRoot, file), "utf8")));
}

describe("ffmpeg fixture portability (ffmpeg 4.4+)", () => {
  it("scans both src/ and test/", () => {
    expect(sourceFiles).toContain(join("test", "redteamEnvelope.test.ts"));
    expect(sourceFiles).toContain(join("test", "redteamBypassF22.test.ts"));
    expect(sourceFiles).toContain(join("src", "redteamF22.ts"));
  });

  it("never passes the ffmpeg >= 5.1-only fps_mode flag", () => {
    expect(filesMatching(/["'`]-fps_mode["'`]/)).toEqual([]);
  });

  it("re-timed fixtures use the portable vsync passthrough flag", () => {
    expect(filesMatching(/"-vsync",\s*"passthrough"/)).toEqual(
      expect.arrayContaining([
        join("src", "redteamF22.ts"),
        join("test", "redteamBypassF22.test.ts"),
        join("test", "redteamEnvelope.test.ts"),
      ]),
    );
  });
});
