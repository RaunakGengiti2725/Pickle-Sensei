#!/usr/bin/env node
/**
 * Static policy pins for dependency integrity and toolchain contracts.
 * Pure file reads — no network, no installs.
 *
 * Run:  node --test tools/security-audit/dependency_policy.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(repoRoot, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));

/** Lowest version a node semver range admits, for the simple range shapes used here. */
function rangeFloor(range) {
  const m = range.match(/(?:>=|\^|~)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  assert.ok(m, `unparseable engines range: ${range}`);
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

describe("edge function dependency pinning", () => {
  const fnDir = "supabase/functions/api";
  const sources = readdirSync(join(repoRoot, fnDir)).filter((f) => f.endsWith(".ts"));
  const specifiers = new Set();
  for (const f of sources) {
    for (const m of read(`${fnDir}/${f}`).matchAll(/from\s+["']((?:npm|jsr):[^"']+)["']/g)) {
      specifiers.add(m[1]);
    }
  }

  it("finds the production import specifiers", () => {
    assert.ok(specifiers.size > 0, "expected at least one npm:/jsr: import in the edge function");
  });

  it("every npm:/jsr: specifier deployed with the function is pinned to an exact version", () => {
    // `supabase functions deploy` bundles supabase/functions/api/*.ts; a floating
    // major (npm:pkg@2) resolves at DEPLOY time unless a lockfile sits with the
    // function (supabase/functions/api/deno.lock or supabase/functions/deno.lock).
    const lockBesideFunction =
      existsSync(join(repoRoot, fnDir, "deno.lock")) ||
      existsSync(join(repoRoot, "supabase/functions/deno.lock"));
    const floating = [...specifiers].filter(
      (s) => !/@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(s),
    );
    assert.ok(
      lockBesideFunction || floating.length === 0,
      `floating specifiers with no lockfile beside the function: ${floating.join(", ")}`,
    );
  });
});

describe("dependency vulnerability scanning is part of the gate it claims to be", () => {
  const verifyCloud = read("scripts/verify-cloud.sh");
  const ci = read(".github/workflows/ci.yml");
  const auditCommand = /\b(pnpm|npm)\s+audit\b|\bosv-scanner\b|\btrivy\b|\bsnyk\b/;

  it("verify-cloud.sh's security stage runs a dependency audit when it advertises one", () => {
    const advertises = /security\s+.*dependency scan/.test(verifyCloud);
    assert.ok(advertises, "sanity: the stage header still advertises a dependency scan");
    const stageBody = verifyCloud.slice(verifyCloud.indexOf("stage_security() {"));
    const stage = stageBody.slice(0, stageBody.indexOf("\n}\n"));
    assert.match(
      stage,
      auditCommand,
      "scripts/verify-cloud.sh:24 says '(secret/dependency scan)' but stage_security only runs gitleaks",
    );
  });

  it("CI runs at least one dependency audit somewhere", () => {
    const anywhere = auditCommand.test(ci) || auditCommand.test(verifyCloud);
    const dependabot = existsSync(join(repoRoot, ".github/dependabot.yml"));
    assert.ok(
      anywhere || dependabot,
      "no `pnpm audit`/`npm audit`/scanner in ci.yml or verify-cloud.sh, and no dependabot.yml (mobile installs use `npm ci --no-audit`)",
    );
  });
});

describe("toolchain engine contracts", () => {
  const root = json("package.json");
  const mobile = json("apps/mobile/package.json");
  const ci = read(".github/workflows/ci.yml");

  it("pnpm version in CI matches package.json#packageManager", () => {
    const declared = root.packageManager.match(/^pnpm@(\S+)$/)[1];
    assert.match(ci, new RegExp(`version:\\s*${declared.replaceAll(".", "\\.")}\\b`));
  });

  it("CI's verify job Node major satisfies the root engines range", () => {
    const node = ci.match(/node-version:\s*"(\d+)"/g).map((s) => Number(s.match(/\d+/)[0]));
    const floor = rangeFloor(root.engines.node);
    const ceiling = root.engines.node.match(/<\s*(\d+)/);
    const ok = node.some((n) => n >= floor[0] && (!ceiling || n < Number(ceiling[1])));
    assert.ok(ok, `root engines ${root.engines.node} vs CI node-versions ${node.join(",")}`);
  });

  it("apps/mobile engines floor is not below what react-native itself requires", () => {
    const rn = json("apps/mobile/node_modules/react-native/package.json");
    const mobileFloor = rangeFloor(mobile.engines.node);
    // react-native's range is a disjunction (e.g. "^22.13.0 || ^24.3.0 || >= 26.0.0");
    // the floor the mobile manifest must honour is the lowest alternative.
    const rnFloor = rn.engines.node
      .split("||")
      .map((alt) => rangeFloor(alt.trim()))
      .sort(cmp)[0];
    assert.ok(
      cmp(mobileFloor, rnFloor) >= 0,
      `apps/mobile/package.json engines.node "${mobile.engines.node}" admits Node ${mobileFloor.join(".")}, ` +
        `but react-native@${rn.version} requires "${rn.engines.node}"`,
    );
  });
});
