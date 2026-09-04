// node --test tools/static-health/test
//
// Runs the real dead-package census against the repo (~1s) and checks its
// internal consistency plus the invariants a wrong verdict would break.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../dead-packages.mjs", import.meta.url));
let report;

before(() => {
  const dir = mkdtempSync(join(tmpdir(), "dead-packages-"));
  try {
    const out = join(dir, "report.json");
    execFileSync(process.execPath, [HARNESS, "--out", out], { stdio: "pipe" });
    report = JSON.parse(readFileSync(out, "utf8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every workspace package gets exactly one verdict", () => {
  const all = Object.values(report.verdicts).flat();
  assert.equal(all.length, report.packagesScanned);
  assert.equal(new Set(all).size, all.length);
  assert.ok(report.packagesScanned >= 20, `scanned ${report.packagesScanned}`);
});

test("verdicts are consistent with the recorded evidence", () => {
  for (const [name, r] of Object.entries(report.packages)) {
    const prod = r.codeImporters.filter((c) => c.kind === "production");
    const ship = r.codeImporters.filter((c) => c.shipping);
    switch (r.verdict) {
      case "shipping":
        assert.ok(ship.length > 0, name);
        break;
      case "library":
        assert.equal(ship.length, 0, name);
        assert.ok(prod.length > 0, name);
        break;
      case "test-only":
        assert.equal(prod.length, 0, name);
        assert.ok(r.codeImporters.length > 0, name);
        break;
      case "cli-only":
        assert.equal(r.codeImporters.length, 0, name);
        assert.ok(r.scriptInvocations.length > 0, name);
        break;
      case "standalone-cli":
        assert.equal(r.codeImporters.length, 0, name);
        assert.equal(r.scriptInvocations.length, 0, name);
        assert.ok(r.ownEntrypoints.length > 0, name);
        break;
      case "dead-candidate":
        assert.equal(r.codeImporters.length, 0, name);
        assert.equal(r.scriptInvocations.length, 0, name);
        assert.equal(r.ownEntrypoints.length, 0, name);
        break;
      default:
        assert.fail(`unknown verdict ${r.verdict} for ${name}`);
    }
    for (const c of r.codeImporters) {
      assert.ok(!c.file.startsWith(r.dir + "/"), `${name}: own file counted as importer ${c.file}`);
    }
  }
});

test("the on-device analysis stack is classified as shipping (consumed by apps/mobile)", () => {
  for (const name of [
    "@pickle/shared-types",
    "@pickle/swing-domain",
    "@pickle/scoring",
    "@pickle/analysis-pipeline",
    "@pickle/vision-geometry",
    "@pickle/vision-contracts",
  ]) {
    assert.equal(report.packages[name]?.verdict, "shipping", name);
    assert.ok(
      report.packages[name].codeImporters.some((c) => c.file.startsWith("apps/mobile/src/")),
      `${name} should have an apps/mobile/src importer`,
    );
  }
});

test("doc mentions never promote a package out of dead-candidate", () => {
  for (const [name, r] of Object.entries(report.packages)) {
    if (r.verdict !== "dead-candidate") continue;
    assert.equal(
      r.codeImporters.length + r.scriptInvocations.length + r.ownEntrypoints.length,
      0,
      name,
    );
  }
});
