/**
 * Adversarial regression tests for the release:check CLI entry point
 * (tools/release/check-release-manifest.mjs), written against 22851ac9.
 *
 * The candidate wrapped main() in
 *   `if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)`
 * so the module can be imported by the unit tests. Node resolves the main
 * module's `import.meta.url` to its REAL path, while `process.argv[1]` keeps
 * the path exactly as typed. When the script is invoked through a symlinked
 * path the two differ, the guard is false, and the gate exits 0 having run
 * NO checks and printed nothing — a silent vacuous pass. At 4d812e1a the same
 * invocation ran every check (main() was unconditional).
 *
 * This is not hypothetical: macOS `os.tmpdir()` lives under /var/folders,
 * and /var is a symlink to /private/var, so the candidate's own acceptance
 * harness (tools/release/__adjudicate__/gate-mutations.mjs, which spawns the
 * gate from a mkdtemp scratch root) reports GAP_REPRODUCED for every R1–R17
 * scenario on a Mac, and any caller that passes a symlinked absolute path
 * (checkouts under a symlinked directory, `$TMPDIR` scratch copies) gets a
 * green gate that checked nothing.
 *
 * Run: node --test tools/release/check-release-manifest.cli.attack.test.mjs
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const SCRIPT = "tools/release/check-release-manifest.mjs";
const MANIFEST = "infra/release/release-manifest.json";
const FILES = [
  SCRIPT,
  MANIFEST,
  "apps/mobile/ios/PickleSensei.xcodeproj/project.pbxproj",
  "apps/mobile/android/app/build.gradle",
  "apps/mobile/src/config/runtimeConfig.ts",
];

const scratchRoots = [];
after(() => {
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
});

/**
 * Scratch copy of the gate + its inputs. Returns the REAL path of the copy and
 * a SYMLINK to it (what a macOS $TMPDIR or a symlinked checkout looks like).
 */
function scratch(mutations = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "release-cli-attack-")));
  scratchRoots.push(base);
  const real = join(base, "real");
  for (const rel of FILES) {
    const dst = join(real, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(join(repoRoot, rel), dst);
  }
  for (const [rel, fn] of Object.entries(mutations)) {
    const dst = join(real, rel);
    const before = readFileSync(dst, "utf8");
    const after = fn(before);
    assert.notEqual(after, before, `${rel}: mutation was a no-op`);
    writeFileSync(dst, after);
  }
  const link = join(base, "link");
  symlinkSync(real, link, "dir");
  return { real, link };
}

function runGate(root) {
  const result = spawnSync(process.execPath, [join(root, SCRIPT)], {
    cwd: root,
    encoding: "utf8",
  });
  const out = `${result.stdout}${result.stderr}`;
  return {
    status: result.status,
    out,
    lines: out.split("\n").filter((line) => /^(ok  |FAIL) /.test(line)),
    failLines: out.split("\n").filter((line) => /^FAIL /.test(line)),
  };
}

const breakSchema = (text) => text.replace('"schemaVersion": 1', '"schemaVersion": 99');

describe("release:check CLI entry point runs regardless of how its path is spelled", () => {
  it("control: invoked by its real path, the unmodified tree prints its check lines and exits 0", () => {
    const { real } = scratch();
    const result = runGate(real);
    assert.equal(result.status, 0, result.out);
    assert.ok(result.lines.length > 0, "expected ok/FAIL check lines");
    assert.match(result.out, /All release-manifest checks passed\./);
  });

  it("control: invoked by its real path, schemaVersion 99 exits 1 with a FAIL line", () => {
    const { real } = scratch({ [MANIFEST]: breakSchema });
    const result = runGate(real);
    assert.equal(result.status, 1, result.out);
    assert.ok(
      result.failLines.some((line) => /schemaVersion/.test(line)),
      result.out,
    );
  });

  it("invoked through a symlinked path, the unmodified tree still RUNS its checks (not a silent exit 0)", () => {
    const { link } = scratch();
    const result = runGate(link);
    assert.equal(result.status, 0, result.out);
    assert.ok(
      result.lines.length > 0,
      `gate printed nothing — main() never ran (exit ${result.status}, ${result.out.length} bytes of output)`,
    );
    assert.match(result.out, /All release-manifest checks passed\./);
  });

  it("invoked through a symlinked path, schemaVersion 99 must still exit 1 with a FAIL line", () => {
    const { link } = scratch({ [MANIFEST]: breakSchema });
    const result = runGate(link);
    assert.equal(
      result.status,
      1,
      `expected exit 1; got exit ${result.status} with ${result.out.length} bytes of output (vacuous pass)`,
    );
    assert.ok(
      result.failLines.some((line) => /schemaVersion/.test(line)),
      result.out,
    );
  });

  it("invoked through a symlinked path, a missing manifest must still exit 1 with a FAIL line", () => {
    const { real, link } = scratch();
    rmSync(join(real, MANIFEST));
    const result = runGate(link);
    assert.equal(
      result.status,
      1,
      `expected exit 1; got exit ${result.status} with ${result.out.length} bytes of output (vacuous pass)`,
    );
    assert.ok(
      result.failLines.some((line) => /readable JSON/.test(line)),
      result.out,
    );
  });
});
