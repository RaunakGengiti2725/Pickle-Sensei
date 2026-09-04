import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Structural audit (pass 1, auditor #2) — `lab:analyze` host guard.
 * analyzeVideo.ts documents itself as the Apple-Vision research pipeline
 * (native/swing-lab Swift extractor). Running it on a non-Apple bench host is
 * therefore always an operator error; the question is whether it fails
 * closed BEFORE side effects with an actionable message, or whether the
 * failure is a raw `spawnSync swift ENOENT` after the output directory has
 * been created. Only runs where `swift` is absent (Linux bench plane).
 */

const dir = mkdtempSync(join(tmpdir(), "audit-analyze-host-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const swiftPresent = spawnSync("swift", ["--version"], { stdio: "ignore" }).status === 0;
const pkgDir = join(import.meta.dirname, "..");

describe.skipIf(swiftPresent || process.platform === "darwin")(
  "audit: lab:analyze on a host without the Swift toolchain",
  () => {
    it("fails closed with a host/toolchain diagnostic and no partial output directory", () => {
      const video = join(dir, "clip.mp4");
      writeFileSync(video, Buffer.alloc(64));
      const outDir = join(dir, "clip.mp4.swing-lab");
      const result = spawnSync(
        join(pkgDir, "node_modules/.bin/tsx"),
        [join(pkgDir, "src/analyzeVideo.ts"), video, "--out", outDir],
        { encoding: "utf8", timeout: 60_000 },
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      expect(result.status).not.toBe(0);
      // Actionable: names the missing capability rather than a bare ENOENT.
      expect(combined).toMatch(/macOS|Apple|Xcode|swift toolchain/i);
      expect(combined).not.toMatch(/ENOENT/);
      // No side effects before the precondition check.
      expect(existsSync(outDir)).toBe(false);
    }, 90_000);
  },
);
