#!/usr/bin/env node
// Read-only reachability check: which npm packages actually ship in the iOS
// Hermes bundle? Builds a release bundle with Metro (no minify, with sourcemap)
// and reports, for every package named in an OSV/npm-audit report, whether any
// of its files were included by Metro.
//
//   node tools/security-deps/bundle_reachability.mjs \
//     --osv /path/osv-scan.json --npm-audit /path/npm-audit-mobile.json \
//     --out-dir /path/out [--skip-build]
//
// Never modifies the repo: the bundle, sourcemap and assets are written to
// --out-dir only.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const mobileDir = join(repoRoot, "apps", "mobile");

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
}
const outDir = resolve(arg("--out-dir", join(repoRoot, "artifacts", "security-deps", "bundle")));
const osvPath = arg("--osv", null);
const npmAuditPath = arg("--npm-audit", null);
const skipBuild = process.argv.includes("--skip-build");
mkdirSync(outDir, { recursive: true });

const bundlePath = join(outDir, "main.jsbundle");
const mapPath = join(outDir, "main.jsbundle.map");

if (!skipBuild) {
  const args = [
    "react-native",
    "bundle",
    "--platform",
    "ios",
    "--dev",
    "false",
    "--minify",
    "false",
    "--entry-file",
    "index.js",
    "--bundle-output",
    bundlePath,
    "--sourcemap-output",
    mapPath,
    "--assets-dest",
    join(outDir, "assets"),
    "--reset-cache",
  ];
  const started = Date.now();
  const r = spawnSync("npx", args, {
    cwd: mobileDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  writeFileSync(join(outDir, "bundle.log"), `${r.stdout ?? ""}\n${r.stderr ?? ""}`);
  writeFileSync(join(outDir, "bundle.exit"), `exit=${r.status}\nms=${Date.now() - started}\n`);
  if (r.status !== 0) {
    console.error(`metro bundle failed (exit ${r.status}); see ${join(outDir, "bundle.log")}`);
    process.exit(r.status ?? 1);
  }
}

if (!existsSync(mapPath)) {
  console.error(`missing sourcemap ${mapPath}`);
  process.exit(2);
}

const map = JSON.parse(readFileSync(mapPath, "utf8"));
const sources = [];
for (const sec of map.sections ?? []) sources.push(...(sec.map?.sources ?? []));
sources.push(...(map.sources ?? []));

const pkgRe = /node_modules\/((?:@[^/]+\/)?[^/]+)/;
const files = new Map();
for (const s of sources) {
  const m = pkgRe.exec(s);
  if (!m) continue;
  if (!files.has(m[1])) files.set(m[1], []);
  files.get(m[1]).push(s.replace(`${repoRoot}/`, ""));
}

const candidates = new Map();
function add(name, version, from) {
  if (!candidates.has(name))
    candidates.set(name, { name, versions: new Set(), reportedBy: new Set() });
  const c = candidates.get(name);
  if (version) c.versions.add(version);
  c.reportedBy.add(from);
}
if (osvPath) {
  const osv = JSON.parse(readFileSync(osvPath, "utf8"));
  for (const f of osv.findings ?? [])
    if (f.ecosystem === "npm") add(f.package, f.version, `osv:${f.id}`);
}
if (npmAuditPath) {
  const audit = JSON.parse(readFileSync(npmAuditPath, "utf8"));
  for (const [name, v] of Object.entries(audit.vulnerabilities ?? {})) {
    const direct = (v.via ?? []).filter((x) => typeof x === "object");
    add(
      name,
      null,
      direct.length
        ? `npm-audit:${direct.map((x) => x.url).join(",")}`
        : "npm-audit:transitive-parent",
    );
  }
}

const rows = [...candidates.values()]
  .map((c) => ({
    package: c.name,
    version: [...c.versions].sort().join(", ") || null,
    reportedBy: [...c.reportedBy].sort(),
    inBundle: files.has(c.name),
    bundledFiles: files.get(c.name) ?? [],
  }))
  .sort((a, b) => Number(b.inBundle) - Number(a.inBundle) || a.package.localeCompare(b.package));

const report = {
  generatedAt: new Date().toISOString(),
  bundle: bundlePath,
  sourcemap: mapPath,
  sourceCount: sources.length,
  packageCount: files.size,
  bundledPackages: [...files.keys()].sort(),
  candidates: rows,
};
writeFileSync(join(outDir, "bundle-reachability.json"), JSON.stringify(report, null, 2));

const md = [
  `# iOS release bundle reachability`,
  ``,
  `Metro sources: ${sources.length}; distinct node_modules packages in bundle: ${files.size}`,
  ``,
  `| package | version | in bundle | reported by |`,
  `|---|---|---|---|`,
  ...rows.map(
    (r) =>
      `| ${r.package} | ${r.version ?? "-"} | ${r.inBundle ? "YES" : "no"} | ${r.reportedBy.join("<br>")} |`,
  ),
  ``,
];
writeFileSync(join(outDir, "bundle-reachability.md"), md.join("\n"));
for (const r of rows)
  console.log(
    `${r.inBundle ? "IN-BUNDLE " : "not-bundled"} ${r.package}${r.version ? `@${r.version}` : ""}`,
  );
console.log(`-> ${join(outDir, "bundle-reachability.json")}`);
