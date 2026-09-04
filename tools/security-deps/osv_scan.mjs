#!/usr/bin/env node
// Dependency vulnerability scan over EVERY lockfile in the repo, using the
// OSV.dev batch API as a registry-independent second source next to
// `pnpm audit` / `npm audit`.
//
//   node tools/security-deps/osv_scan.mjs [--out-dir DIR] [--json]
//
// Inputs (all read-only):
//   pnpm-lock.yaml                                   -> npm
//   apps/mobile/package-lock.json                    -> npm   (dev flag kept)
//   deno.lock                                        -> npm (+ jsr as npm names when applicable)
//   apps/mobile/Gemfile.lock                         -> RubyGems
//   apps/mobile/ios/.../swiftpm/Package.resolved     -> SwiftURL
//   apps/mobile/ios/Podfile.lock                     -> listed only (OSV has no CocoaPods ecosystem)
//
// Output: <out-dir>/osv-scan.json (machine-readable) and osv-scan.md.
// Exit 0 when the scan ran to completion (findings are data, not a failure);
// exit 2 on usage / IO error; exit 3 when OSV was unreachable (never a pass).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const args = process.argv.slice(2);
const outDir = resolve(
  args.includes("--out-dir")
    ? args[args.indexOf("--out-dir") + 1]
    : resolve(repoRoot, "artifacts", "security-deps"),
);
const OSV = process.env.OSV_API_BASE ?? "https://api.osv.dev";

function readText(rel) {
  const p = resolve(repoRoot, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8");
}

// ---------- lockfile parsers ----------

function parsePnpmLock(text) {
  // Flat "packages:" section; keys look like `'@scope/name@1.2.3'` or `name@1.2.3(peer@x)`.
  const pkgs = [];
  const section = text.split(/\npackages:\n/)[1]?.split(/\nsnapshots:\n/)[0] ?? "";
  for (const m of section.matchAll(/^  '?([^\s:']+)'?:\s*$/gm)) {
    const key = m[1].replace(/\(.*$/, "");
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    pkgs.push({ name: key.slice(0, at), version: key.slice(at + 1), ecosystem: "npm" });
  }
  // importers -> which workspace project pulls what (direct deps only)
  const importers = {};
  const impSection = text.split(/\nimporters:\n/)[1]?.split(/\npackages:\n/)[0] ?? "";
  let current = null;
  let block = null;
  for (const line of impSection.split("\n")) {
    const imp = line.match(/^  ([^\s:][^:]*):\s*$/);
    if (imp) {
      current = imp[1];
      importers[current] = { dependencies: {}, devDependencies: {}, optionalDependencies: {} };
      continue;
    }
    const b = line.match(/^    (dependencies|devDependencies|optionalDependencies):\s*$/);
    if (b) {
      block = b[1];
      continue;
    }
    const dep = line.match(/^      '?([^\s:']+)'?:\s*$/);
    if (dep && current && block) {
      importers[current][block][dep[1]] = null;
      continue;
    }
    const ver = line.match(/^        version:\s*(\S+)/);
    if (ver && current && block) {
      const names = Object.keys(importers[current][block]);
      const last = names[names.length - 1];
      if (last && importers[current][block][last] === null)
        importers[current][block][last] = ver[1].replace(/\(.*$/, "");
    }
  }
  return { pkgs, importers };
}

function parseNpmLock(text) {
  const lock = JSON.parse(text);
  const pkgs = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !meta.version) continue;
    const name =
      meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    pkgs.push({
      name,
      version: meta.version,
      ecosystem: "npm",
      dev: Boolean(meta.dev),
      optional: Boolean(meta.optional),
      path,
      hasInstall: Boolean(meta.hasInstallScript),
    });
  }
  return { pkgs, root: lock.packages?.[""] ?? {} };
}

function parseDenoLock(text) {
  const lock = JSON.parse(text);
  const pkgs = [];
  for (const key of Object.keys(lock.npm ?? {})) {
    const k = key.replace(/_.*$/, ""); // strip peer suffix
    const at = k.lastIndexOf("@");
    pkgs.push({ name: k.slice(0, at), version: k.slice(at + 1), ecosystem: "npm" });
  }
  const jsr = Object.keys(lock.jsr ?? {});
  return { pkgs, jsr, specifiers: lock.specifiers ?? {} };
}

function parseGemfileLock(text) {
  const pkgs = [];
  const specs = text.split(/\n  specs:\n/)[1]?.split(/\n\n/)[0] ?? "";
  for (const m of specs.matchAll(/^    ([A-Za-z0-9_.-]+) \(([^)]+)\)\s*$/gm)) {
    pkgs.push({ name: m[1], version: m[2].split("-")[0], ecosystem: "RubyGems" });
  }
  return { pkgs };
}

function parsePackageResolved(text) {
  const r = JSON.parse(text);
  const pins = r.pins ?? r.object?.pins ?? [];
  return {
    pkgs: pins
      .filter((p) => p.state?.version)
      .map((p) => ({
        name: (p.location ?? p.repositoryURL ?? "").replace(/\.git$/, ""),
        version: p.state.version,
        ecosystem: "SwiftURL",
      })),
  };
}

function parsePodfileLock(text) {
  const pods = [];
  const section = text.split(/^PODS:\n/m)[1]?.split(/\n\n/)[0] ?? "";
  for (const m of section.matchAll(/^  - ([^\s(]+) \(([^)]+)\)/gm)) {
    if (m[1].includes("/")) continue; // subspecs
    pods.push({ name: m[1], version: m[2], ecosystem: "CocoaPods" });
  }
  return { pkgs: pods };
}

// ---------- OSV ----------

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function osvQueryBatch(pkgs) {
  const results = new Array(pkgs.length);
  const chunk = 500;
  for (let i = 0; i < pkgs.length; i += chunk) {
    const slice = pkgs.slice(i, i + chunk);
    const body = {
      queries: slice.map((p) => ({
        package: { name: p.name, ecosystem: p.ecosystem },
        version: p.version,
      })),
    };
    const json = await postJson(`${OSV}/v1/querybatch`, body);
    json.results.forEach((r, j) => (results[i + j] = (r.vulns ?? []).map((v) => v.id)));
  }
  return results;
}

async function osvVuln(id, cache) {
  if (cache.has(id)) return cache.get(id);
  const res = await fetch(`${OSV}/v1/vulns/${id}`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`vuln ${id} -> HTTP ${res.status}`);
  const v = await res.json();
  cache.set(id, v);
  return v;
}

function severityOf(v) {
  const db = v.database_specific?.severity;
  if (db) return String(db).toUpperCase();
  const cvss = (v.severity ?? []).find((s) => s.type?.startsWith("CVSS"));
  return cvss ? cvss.score : "UNKNOWN";
}

function fixedVersionsFor(v, pkg) {
  const out = new Set();
  for (const a of v.affected ?? []) {
    if (a.package?.name !== pkg.name || a.package?.ecosystem !== pkg.ecosystem) continue;
    for (const r of a.ranges ?? []) for (const e of r.events ?? []) if (e.fixed) out.add(e.fixed);
  }
  return [...out];
}

// ---------- main ----------

async function main() {
  const sources = [];
  const pnpm = readText("pnpm-lock.yaml");
  if (pnpm) sources.push({ id: "pnpm-lock.yaml", ...parsePnpmLock(pnpm) });
  const mobile = readText("apps/mobile/package-lock.json");
  if (mobile) sources.push({ id: "apps/mobile/package-lock.json", ...parseNpmLock(mobile) });
  const deno = readText("deno.lock");
  if (deno) sources.push({ id: "deno.lock", ...parseDenoLock(deno) });
  const gem = readText("apps/mobile/Gemfile.lock");
  if (gem) sources.push({ id: "apps/mobile/Gemfile.lock", ...parseGemfileLock(gem) });
  const spm = readText(
    "apps/mobile/ios/PickleSensei.xcworkspace/xcshareddata/swiftpm/Package.resolved",
  );
  if (spm)
    sources.push({
      id: "apps/mobile/ios/.../swiftpm/Package.resolved",
      ...parsePackageResolved(spm),
    });
  const pods = readText("apps/mobile/ios/Podfile.lock");
  if (pods)
    sources.push({
      id: "apps/mobile/ios/Podfile.lock",
      ...parsePodfileLock(pods),
      unsupported: true,
    });

  const findings = [];
  const cache = new Map();
  const summary = [];
  for (const src of sources) {
    const queryable = src.pkgs.filter((p) => p.ecosystem !== "CocoaPods");
    let ids = [];
    if (queryable.length) {
      try {
        ids = await osvQueryBatch(queryable);
      } catch (err) {
        console.error(`OSV unreachable for ${src.id}: ${err.message}`);
        process.exit(3);
      }
    }
    let vulnerable = 0;
    for (let i = 0; i < queryable.length; i++) {
      if (!ids[i]?.length) continue;
      vulnerable++;
      const p = queryable[i];
      for (const id of ids[i]) {
        const v = await osvVuln(id, cache);
        findings.push({
          source: src.id,
          package: p.name,
          version: p.version,
          ecosystem: p.ecosystem,
          dev: p.dev ?? null,
          optional: p.optional ?? null,
          path: p.path ?? null,
          id,
          aliases: v.aliases ?? [],
          cve: (v.aliases ?? []).find((a) => a.startsWith("CVE-")) ?? null,
          severity: severityOf(v),
          summary: v.summary ?? v.details?.slice(0, 160) ?? "",
          fixed: fixedVersionsFor(v, p),
          published: v.published ?? null,
          modified: v.modified ?? null,
        });
      }
    }
    summary.push({
      source: src.id,
      packages: src.pkgs.length,
      queried: queryable.length,
      vulnerablePackages: vulnerable,
      note: src.unsupported
        ? "OSV has no CocoaPods ecosystem — versions listed only; see podfile-inventory in osv-scan.json"
        : null,
    });
  }

  findings.sort(
    (a, b) =>
      a.source.localeCompare(b.source) ||
      a.package.localeCompare(b.package) ||
      a.id.localeCompare(b.id),
  );
  const out = {
    generatedAt: new Date().toISOString(),
    osvApiBase: OSV,
    sources: summary,
    findings,
    podfileInventory: sources.find((s) => s.unsupported)?.pkgs ?? [],
    denoJsr: sources.find((s) => s.id === "deno.lock")?.jsr ?? [],
    pnpmImporters: sources.find((s) => s.id === "pnpm-lock.yaml")?.importers ?? {},
  };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "osv-scan.json"), JSON.stringify(out, null, 2));

  const md = [];
  md.push(`# OSV scan (${out.generatedAt})`, "");
  md.push("| source | packages | queried | vulnerable packages |", "| --- | ---: | ---: | ---: |");
  for (const s of summary)
    md.push(
      `| ${s.source} | ${s.packages} | ${s.queried} | ${s.vulnerablePackages}${s.note ? " (n/a)" : ""} |`,
    );
  md.push(
    "",
    "| source | package | version | dev | advisory | CVE | severity | fixed in | summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const f of findings)
    md.push(
      `| ${f.source} | ${f.package} | ${f.version} | ${f.dev === null ? "" : f.dev ? "dev" : "prod"} | ${f.id} | ${f.cve ?? ""} | ${f.severity} | ${f.fixed.join(", ")} | ${f.summary.replace(/\|/g, "/")} |`,
    );
  writeFileSync(resolve(outDir, "osv-scan.md"), md.join("\n") + "\n");
  if (args.includes("--json")) process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  else {
    for (const s of summary)
      console.log(
        `${s.source}: ${s.packages} packages, ${s.vulnerablePackages} vulnerable${s.note ? " (" + s.note + ")" : ""}`,
      );
    console.log(`${findings.length} advisory hits -> ${resolve(outDir, "osv-scan.json")}`);
  }
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(2);
});
