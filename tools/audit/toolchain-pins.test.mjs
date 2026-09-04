// Cross-checks the toolchain pins that are declared in several places
// (root package.json engines/packageManager, apps/mobile engines, the Node
// versions CI actually runs, react-native's own engines) for mutual
// consistency. None of these pins is enforced at install time (npm/pnpm only
// WARN on EBADENGINE), so a contradiction here silently means "some plane runs
// an unsupported Node".
//
// Run: node --test tools/audit/toolchain-pins.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const readJson = (p) => JSON.parse(readFileSync(resolve(root, p), "utf8"));
// semver from the mobile tree (a transitive dep of react-native / npm itself).
const semver = createRequire(resolve(root, "apps/mobile/package.json"))("semver");

const rootPkg = readJson("package.json");
const mobilePkg = readJson("apps/mobile/package.json");
const ci = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const ciNodeVersions = [...ci.matchAll(/node-version:\s*"?(\d+)"?/g)].map((m) => m[1]);
const ciPnpm = ci.match(/pnpm\/action-setup@v\d+\s*\n\s*with:\s*\n\s*version:\s*([\d.]+)/)?.[1];

test("CI declares Node versions and a pnpm version", () => {
  assert.ok(ciNodeVersions.length >= 2, `found node-version entries: ${ciNodeVersions}`);
  assert.ok(ciPnpm, "pnpm/action-setup version not found");
});

test("root packageManager matches the pnpm CI installs", () => {
  assert.equal(rootPkg.packageManager, `pnpm@${ciPnpm}`);
});

test("root `eslint .` (covers apps/mobile per AGENTS.md) has a Node version satisfying BOTH engines", () => {
  // If the two ranges are disjoint there is no Node on which `pnpm lint` is a
  // supported invocation for the mobile files it lints.
  const rootRange = new semver.Range(rootPkg.engines.node);
  const mobileRange = new semver.Range(mobilePkg.engines.node);
  assert.ok(
    semver.intersects(rootRange, mobileRange),
    `root engines.node "${rootPkg.engines.node}" and apps/mobile engines.node "${mobilePkg.engines.node}" are disjoint`,
  );
});

test("every Node major CI runs is inside root engines.node", () => {
  const disallowed = ciNodeVersions.filter(
    (major) => !semver.satisfies(`${major}.99.99`, rootPkg.engines.node),
  );
  assert.deepEqual(
    disallowed,
    [],
    `CI runs Node ${disallowed.join(", ")} but root engines.node is "${rootPkg.engines.node}"`,
  );
});

test("apps/mobile engines.node is not looser than react-native's own engines", () => {
  const rnEngines = createRequire(resolve(root, "apps/mobile/package.json"))(
    "react-native/package.json",
  ).engines.node;
  // Every version the app claims to support must be supported by react-native.
  const mobileMin = semver.minVersion(mobilePkg.engines.node);
  assert.ok(
    semver.satisfies(mobileMin, rnEngines),
    `apps/mobile allows Node ${mobileMin} (engines "${mobilePkg.engines.node}") but react-native@${mobilePkg.dependencies["react-native"]} requires "${rnEngines}"`,
  );
});
