// node --test tools/release/check-release-manifest.attack.test.mjs
//
// Adversarial tests against candidate 6a5308e3 (release:check refactor). Each
// test documents a concrete failure mode of the checker and is EXPECTED TO
// FAIL on the candidate until the checker is fixed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { REPO_ROOT, loadInputs, runChecks } from "./check-release-manifest.mjs";

const SCRIPT_REL = "tools/release/check-release-manifest.mjs";

function runCli(scriptPath) {
  const proc = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
  return { status: proc.status, stdout: proc.stdout, stderr: proc.stderr };
}

// A1 — the `process.argv[1] === fileURLToPath(import.meta.url)` main-guard
// compares the invoked path string against Node's realpath-resolved module
// URL. Invoking the gate through ANY symlinked absolute path (e.g. macOS /tmp
// -> /private/tmp, a ~/repos symlink) makes main() never run: exit 0, no
// output, nothing checked. The baseline (4d812e1a) had no guard and always ran.
test("A1: release:check invoked via a symlinked absolute path still runs the checks", () => {
  const direct = runCli(join(REPO_ROOT, SCRIPT_REL));
  const tmp = mkdtempSync(join(tmpdir(), "ps-attack-"));
  const link = join(tmp, "repo");
  try {
    symlinkSync(REPO_ROOT, link, "dir");
    const viaLink = runCli(join(link, SCRIPT_REL));
    assert.equal(viaLink.status, direct.status, "exit code must not depend on the invoked path");
    assert.match(
      viaLink.stdout + viaLink.stderr,
      /release-manifest check/,
      "the gate must print a verdict (it printed nothing and exited 0)",
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A2 — readRuntimeConfigConst() takes the FIRST regex match anywhere in the
// source, including comments. A commented-out declaration carrying the old
// origin makes the gate report a committed https origin while the effective
// API_BASE_URL is null (the exact condition RCD-04 says must fail).
test("A2: a commented-out API_BASE_URL declaration must not satisfy the origin checks", () => {
  const inputs = loadInputs();
  const runtimeConfig = inputs.runtimeConfig.replace(
    /const API_BASE_URL: string \| null =\s*'[^']*';/,
    [
      "// Local-only builds: const API_BASE_URL: string | null = 'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';",
      "const API_BASE_URL: string | null = null;",
    ].join("\n"),
  );
  assert.notEqual(runtimeConfig, inputs.runtimeConfig, "mutation applied");
  const result = runChecks({ ...inputs, runtimeConfig });
  assert.ok(
    result.failures.some((l) => /API_BASE_URL is a committed https origin/.test(l)),
    "effective API_BASE_URL is null but the check passed",
  );
});

// A3 — "production mediaBucket is recorded (not \"tbd\")" only rejects the
// literal "tbd"; null / "" / non-strings pass as "recorded".
test("A3: production mediaBucket null or empty is not 'recorded'", () => {
  const inputs = loadInputs();
  for (const value of [null, ""]) {
    const manifest = structuredClone(inputs.manifest);
    manifest.environments.production.mediaBucket = value;
    const result = runChecks({ ...inputs, manifest });
    assert.ok(
      result.failures.some((l) => /production mediaBucket is recorded/.test(l)),
      `mediaBucket=${JSON.stringify(value)} passed as recorded`,
    );
  }
});

// A4 — the release gate at the candidate SHA itself: the checker was tightened
// but infra/release/release-manifest.json was not updated, so `pnpm
// release:check` (and `scripts/verify-cloud.sh --only release`) went from exit
// 0 on 4d812e1a to exit 1. A release gate that fails on its own tree is a
// regression regardless of how correct the new checks are.
test("A4: committed tree passes release:check (baseline 4d812e1a: 53 ok / 0 FAIL)", () => {
  const { failures } = runChecks(loadInputs());
  assert.deepEqual(failures, []);
});
