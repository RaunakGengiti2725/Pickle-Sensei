// H04-01 adversarial re-execution of the toolchain evidence the candidate
// document (docs/security/ADVISORIES_2026-09-08.md §2 #5–#8, #11–#12) cites
// for its reachability and Deno-lock claims. Every command is the document's
// own; each assertion is a number or string the document states.
//
// Slow (production iOS bundle ≈ 1–3 min). Requires `npm ci` in apps/mobile,
// `pnpm install --frozen-lockfile` at the root, and `deno` on PATH.
// Run: node --test tools/attack/h04-01/toolchain-evidence.attack.test.mjs

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const mobileDir = path.join(repoRoot, "apps/mobile");
const outDir = path.join(repoRoot, "artifacts/attack/bundle");
const mobileAudit = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "artifacts/advisories/mobile.json"), "utf8"),
);

function sh(cmd, cwd = repoRoot) {
  return spawnSync("bash", ["-c", cmd], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

describe('A7 — production iOS bundle module scan (§2 #11/#12, §4.1 "In the shipped app? No", §4.3 "bundled")', () => {
  let sources;
  let bundleText;

  test("react-native bundle --platform ios --dev false exits 0", () => {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const r = sh(
      `npx react-native bundle --platform ios --dev false --minify false --entry-file index.js --bundle-output ${outDir}/main.jsbundle --assets-dest ${outDir}/assets --sourcemap-output ${outDir}/main.jsbundle.map`,
      mobileDir,
    );
    fs.writeFileSync(path.join(outDir, "bundle.log"), r.stdout + r.stderr + `\nexit ${r.status}\n`);
    assert.equal(r.status, 0, r.stderr.slice(-2000));
    const map = JSON.parse(fs.readFileSync(path.join(outDir, "main.jsbundle.map"), "utf8"));
    sources = map.sections ? map.sections.flatMap((s) => s.map.sources) : map.sources;
    bundleText = fs.readFileSync(path.join(outDir, "main.jsbundle"), "utf8");
  });

  const pkgOf = (s) => {
    const m = s.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
    return m ? m[m.length - 1].replace("node_modules/", "") : null;
  };

  test("source map lists 2001 modules (doc §2 #12)", () => {
    assert.equal(sources.length, 2001);
  });

  test("0 modules from image-size / metro / metro-config / metro-transform-worker / @react-native/metro-config / community-cli-plugin / new-app-screen", () => {
    for (const p of [
      "image-size",
      "metro",
      "metro-config",
      "metro-transform-worker",
      "@react-native/metro-config",
      "@react-native/community-cli-plugin",
      "@react-native/new-app-screen",
    ]) {
      assert.equal(sources.filter((s) => pkgOf(s) === p).length, 0, p);
    }
    assert.equal((bundleText.match(/image-size/g) || []).length, 0);
  });

  test("exactly 1 module each from decode-uri-component and query-string (the vulnerable code IS shipped)", () => {
    assert.equal(sources.filter((s) => pkgOf(s) === "decode-uri-component").length, 1);
    assert.equal(sources.filter((s) => pkgOf(s) === "query-string").length, 1);
  });

  test("every other npm-labelled package in mobile.json is accounted for: navigation/react-native present, build tooling absent", () => {
    const labelled = Object.keys(mobileAudit.vulnerabilities);
    const buildOnly = new Set([
      "image-size",
      "metro",
      "metro-config",
      "metro-transform-worker",
      "@react-native/metro-config",
      "@react-native/community-cli-plugin",
      "@react-native/new-app-screen",
    ]);
    for (const p of labelled) {
      const n = sources.filter((s) => pkgOf(s) === p).length;
      if (buildOnly.has(p)) assert.equal(n, 0, p);
      else assert.ok(n >= 1, `${p} expected in bundle, got 0`);
    }
  });

  test("the only importer of decode-uri-component in the bundle graph is query-string, and the only query-string parse() call site in @react-navigation/core is getStateFromPath", () => {
    const qs = fs.readFileSync(path.join(mobileDir, "node_modules/query-string/index.js"), "utf8");
    assert.match(qs, /require\('decode-uri-component'\)/);
    const coreSrc = path.join(mobileDir, "node_modules/@react-navigation/core/src");
    const files = fs
      .readdirSync(coreSrc)
      .filter((f) => f.endsWith(".tsx") && !f.includes(".test."));
    const parseCallers = files.filter((f) =>
      /queryString\.parse\(/.test(fs.readFileSync(path.join(coreSrc, f), "utf8")),
    );
    assert.deepEqual(parseCallers, ["getStateFromPath.tsx"]);
    const other = sources
      .filter((s) => fs.existsSync(s))
      .filter(
        (s) =>
          !/node_modules\/(query-string|decode-uri-component)\//.test(s) &&
          /decode-uri-component/.test(fs.readFileSync(s, "utf8")),
      );
    assert.deepEqual(other, []);
  });
});

describe("A8 — Deno lock review and audit parity (§2 #5–#8)", () => {
  test("#6 deno audit --lock=deno.lock (root) exits 0 and reports no known vulnerabilities", () => {
    const r = sh("deno audit --lock=deno.lock");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /No known vulnerabilities found/);
  });

  test("#7 deno audit --lock=deno.lock (supabase/functions/api) exits 0 and reports no known vulnerabilities", () => {
    const r = sh("deno audit --lock=deno.lock", path.join(repoRoot, "supabase/functions/api"));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout + r.stderr, /No known vulnerabilities found/);
  });

  test("#8 frozen-lock typecheck of the Edge entrypoint with deno@2.5.6 exits 0", () => {
    const r = sh(
      "npx --yes deno@2.5.6 check --node-modules-dir=none --frozen --lock=deno.lock supabase/functions/api/index.ts",
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("both deno.lock files contain exactly 13 npm packages and no jsr/remote entries (§3)", () => {
    for (const rel of ["deno.lock", "supabase/functions/api/deno.lock"]) {
      const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));
      assert.equal(lock.version, "5", rel);
      assert.equal(Object.keys(lock.npm ?? {}).length, 13, rel);
      assert.equal(lock.jsr, undefined, rel);
      assert.equal(lock.remote, undefined, rel);
    }
  });

  test('#5 npm audit --omit=dev labels the identical 16 packages and 3 GHSA ids as the full audit (§3 "Identical set with --omit=dev")', () => {
    const r = sh("npm audit --omit=dev --json", mobileDir);
    assert.equal(r.status, 1, "npm audit exits 1 when advisories exist");
    const omit = JSON.parse(r.stdout);
    assert.deepEqual(
      Object.keys(omit.vulnerabilities).sort(),
      Object.keys(mobileAudit.vulnerabilities).sort(),
    );
    const ids = (rep) =>
      new Set(
        Object.values(rep.vulnerabilities)
          .flatMap((v) => v.via)
          .filter((x) => x && x.url)
          .map((x) => x.url.match(/GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4}/)[0]),
      );
    assert.deepEqual([...ids(omit)].sort(), [
      "GHSA-5p2g-fcmc-qvqq",
      "GHSA-vcc3-ghjq-m6fr",
      "GHSA-w3rx-r6r6-pgpr",
    ]);
    assert.deepEqual([...ids(mobileAudit)].sort(), [
      "GHSA-5p2g-fcmc-qvqq",
      "GHSA-vcc3-ghjq-m6fr",
      "GHSA-w3rx-r6r6-pgpr",
    ]);
  });

  test("#4 pnpm audit --prod reports zero advisories (§3)", () => {
    const r = sh("pnpm audit --prod --json");
    assert.equal(r.status, 0, r.stderr);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(Object.values(rep.metadata.vulnerabilities), [0, 0, 0, 0, 0]);
  });
});
