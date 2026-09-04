#!/usr/bin/env node
// Dependency hygiene inventory for every JS lockfile in the repo:
//   * duplicated / conflicting versions of the same package
//   * lifecycle scripts (preinstall/install/postinstall) in installed packages
//   * deprecated packages (registry `deprecated` flag on the pinned version)
//   * staleness: months since the pinned version and since the package's last release
//   * floating specifiers in manifests (`*`, `latest`, bare `npm:pkg@MAJOR`, git/URL deps)
//
//   node tools/security-deps/dep_inventory.mjs [--out-dir DIR] [--no-registry]
//
// Read-only. Registry lookups use the public abbreviated metadata endpoint and
// can be disabled with --no-registry (then staleness/deprecation are "unknown").
// Exit 0 when the inventory ran to completion (data, not verdicts); 2 on error.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const args = process.argv.slice(2);
const outDir = resolve(
  args.includes("--out-dir")
    ? args[args.indexOf("--out-dir") + 1]
    : resolve(repoRoot, "artifacts", "security-deps"),
);
const useRegistry = !args.includes("--no-registry");
const REGISTRY = process.env.NPM_REGISTRY ?? "https://registry.npmjs.org";
const STALE_MONTHS = 24;

const read = (rel) =>
  existsSync(resolve(repoRoot, rel)) ? readFileSync(resolve(repoRoot, rel), "utf8") : null;

// ---------- pnpm-lock.yaml ----------
function pnpmPackages(text) {
  const out = [];
  const section = text.split(/\npackages:\n/)[1]?.split(/\nsnapshots:\n/)[0] ?? "";
  for (const m of section.matchAll(/^  '?([^\s:']+)'?:\s*$/gm)) {
    const key = m[1].replace(/\(.*$/, "");
    const at = key.lastIndexOf("@");
    if (at <= 0) continue;
    out.push({ name: key.slice(0, at), version: key.slice(at + 1) });
  }
  return out;
}

// ---------- package-lock.json ----------
function npmPackages(text) {
  const lock = JSON.parse(text);
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path || !meta.version) continue;
    const name =
      meta.name ?? path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    out.push({
      name,
      version: meta.version,
      dev: Boolean(meta.dev),
      optional: Boolean(meta.optional),
      path,
      hasInstallScript: Boolean(meta.hasInstallScript),
      deprecated: meta.deprecated ?? null,
    });
  }
  return out;
}

function duplicates(pkgs) {
  const byName = new Map();
  for (const p of pkgs) {
    if (!byName.has(p.name)) byName.set(p.name, new Set());
    byName.get(p.name).add(p.version);
  }
  return [...byName.entries()]
    .filter(([, v]) => v.size > 1)
    .map(([name, v]) => ({
      name,
      versions: [...v].sort(),
      majors: new Set([...v].map((x) => x.split(".")[0])).size,
    }))
    .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name));
}

// ---------- lifecycle scripts from installed trees ----------
function* walkPackageJsons(dir, depth = 0) {
  if (depth > 6 || !existsSync(dir)) return;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === ".bin" || e === ".cache") continue;
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (e.startsWith("@")) {
      yield* walkPackageJsons(p, depth + 1);
      continue;
    }
    const pj = join(p, "package.json");
    if (existsSync(pj)) yield pj;
    const nested = join(p, "node_modules");
    if (existsSync(nested)) yield* walkPackageJsons(nested, depth + 1);
  }
}

function lifecycleScripts(rootNodeModules, label) {
  const hits = [];
  const seen = new Set();
  const dirs = [rootNodeModules];
  const pnpmStore = join(rootNodeModules, ".pnpm");
  if (existsSync(pnpmStore)) {
    for (const e of readdirSync(pnpmStore)) {
      const nm = join(pnpmStore, e, "node_modules");
      if (existsSync(nm)) dirs.push(nm);
    }
  }
  for (const d of dirs) {
    for (const pj of walkPackageJsons(d)) {
      let meta;
      try {
        meta = JSON.parse(readFileSync(pj, "utf8"));
      } catch {
        continue;
      }
      const key = `${meta.name}@${meta.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const s = meta.scripts ?? {};
      const found = {};
      for (const k of ["preinstall", "install", "postinstall"]) if (s[k]) found[k] = s[k];
      if (Object.keys(found).length)
        hits.push({ tree: label, package: meta.name, version: meta.version, scripts: found });
    }
  }
  return hits.sort((a, b) => a.package.localeCompare(b.package));
}

// ---------- floating specifiers in manifests ----------
function manifestSpecifiers() {
  const out = [];
  const manifests = [];
  const ws = read("pnpm-workspace.yaml") ?? "";
  const globs = [...ws.matchAll(/^\s+- ["']?(!?[^"'\n]+)["']?\s*$/gm)].map((m) => m[1]);
  const negated = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  for (const g of globs.filter((g) => !g.startsWith("!"))) {
    const [base, star] = g.split("/");
    if (star === "*") {
      const dir = resolve(repoRoot, base);
      if (!existsSync(dir)) continue;
      for (const e of readdirSync(dir)) {
        const rel = `${base}/${e}`;
        if (negated.includes(rel)) continue;
        if (existsSync(resolve(repoRoot, rel, "package.json")))
          manifests.push(`${rel}/package.json`);
      }
    } else if (existsSync(resolve(repoRoot, g, "package.json")))
      manifests.push(`${g}/package.json`);
  }
  manifests.push("package.json", "apps/mobile/package.json");
  for (const rel of manifests) {
    const text = read(rel);
    if (!text) continue;
    const pj = JSON.parse(text);
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      for (const [name, spec] of Object.entries(pj[field] ?? {})) {
        const floating =
          spec === "*" ||
          spec === "latest" ||
          spec.startsWith(">=") ||
          /^(git\+|https?:|github:)/.test(spec) ||
          /^npm:[^@]+@\d+$/.test(spec);
        if (floating) out.push({ manifest: rel, field, name, spec });
      }
    }
  }
  // Deno edge function: bare-major npm:/jsr: specifiers are floating at bundle time
  const fnDir = resolve(repoRoot, "supabase", "functions", "api");
  if (existsSync(fnDir)) {
    for (const f of readdirSync(fnDir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(join(fnDir, f), "utf8");
      for (const m of src.matchAll(/from\s+["']((?:npm|jsr):[^"']+)["']/g)) {
        const spec = m[1];
        const pinned = /@\d+\.\d+\.\d+/.test(spec);
        if (!pinned)
          out.push({
            manifest: `supabase/functions/api/${f}`,
            field: "import",
            name: spec,
            spec: "unpinned major",
          });
      }
    }
  }
  return out;
}

// ---------- registry metadata ----------
async function registryMeta(name) {
  const res = await fetch(`${REGISTRY}/${name.replace("/", "%2f")}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const j = await res.json();
  return {
    modified: j.modified ?? null,
    latest: j["dist-tags"]?.latest ?? null,
    versions: j.versions ?? {},
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

const monthsBetween = (a, b) => Math.round(((b - a) / (1000 * 60 * 60 * 24 * 30.44)) * 10) / 10;

async function main() {
  const trees = [];
  const pnpm = read("pnpm-lock.yaml");
  if (pnpm)
    trees.push({
      id: "pnpm-lock.yaml",
      pkgs: pnpmPackages(pnpm),
      nodeModules: resolve(repoRoot, "node_modules"),
    });
  const mobile = read("apps/mobile/package-lock.json");
  if (mobile)
    trees.push({
      id: "apps/mobile/package-lock.json",
      pkgs: npmPackages(mobile),
      nodeModules: resolve(repoRoot, "apps/mobile/node_modules"),
    });

  const report = {
    generatedAt: new Date().toISOString(),
    registry: useRegistry ? REGISTRY : null,
    trees: [],
    floatingSpecifiers: manifestSpecifiers(),
  };

  for (const t of trees) {
    const dup = duplicates(t.pkgs);
    const scripts = lifecycleScripts(t.nodeModules, t.id);
    const deprecatedFromLock = t.pkgs
      .filter((p) => p.deprecated)
      .map((p) => ({ name: p.name, version: p.version, dev: p.dev, message: p.deprecated }));
    let stale = [];
    let deprecated = deprecatedFromLock;
    let lookups = 0;
    let lookupErrors = 0;
    if (useRegistry) {
      const names = [...new Set(t.pkgs.map((p) => p.name))];
      const metas = new Map();
      await mapLimit(names, 12, async (n) => {
        lookups++;
        const m = await registryMeta(n).catch((e) => ({ error: e.message }));
        if (m.error) lookupErrors++;
        metas.set(n, m);
      });
      const now = Date.now();
      const dep = new Map(deprecated.map((d) => [`${d.name}@${d.version}`, d]));
      for (const p of t.pkgs) {
        const m = metas.get(p.name);
        if (!m || m.error) continue;
        const v = m.versions[p.version];
        if (v?.deprecated && !dep.has(`${p.name}@${p.version}`))
          dep.set(`${p.name}@${p.version}`, {
            name: p.name,
            version: p.version,
            dev: p.dev ?? null,
            message: v.deprecated,
          });
        if (m.modified) {
          const sinceLastRelease = monthsBetween(Date.parse(m.modified), now);
          if (sinceLastRelease >= STALE_MONTHS)
            stale.push({
              name: p.name,
              version: p.version,
              dev: p.dev ?? null,
              latest: m.latest,
              monthsSinceAnyRelease: sinceLastRelease,
            });
        }
      }
      deprecated = [...dep.values()].sort((a, b) => a.name.localeCompare(b.name));
      stale.sort((a, b) => b.monthsSinceAnyRelease - a.monthsSinceAnyRelease);
    }
    report.trees.push({
      source: t.id,
      packages: t.pkgs.length,
      uniqueNames: new Set(t.pkgs.map((p) => p.name)).size,
      duplicates: dup,
      lifecycleScripts: scripts,
      deprecated,
      stale,
      registryLookups: useRegistry ? { attempted: lookups, errors: lookupErrors } : null,
    });
  }

  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "dep-inventory.json"), JSON.stringify(report, null, 2));
  const md = [`# Dependency inventory (${report.generatedAt})`, ""];
  for (const t of report.trees) {
    md.push(`## ${t.source} — ${t.packages} package versions, ${t.uniqueNames} names`, "");
    md.push(
      `- duplicated names: ${t.duplicates.length} (${t.duplicates.filter((d) => d.majors > 1).length} span >1 major)`,
    );
    md.push(`- packages with install scripts: ${t.lifecycleScripts.length}`);
    md.push(`- deprecated pinned versions: ${t.deprecated.length}`);
    md.push(`- packages with no release in ≥${STALE_MONTHS} months: ${t.stale.length}`, "");
    md.push("| duplicated package | versions |", "| --- | --- |");
    for (const d of t.duplicates) md.push(`| ${d.name} | ${d.versions.join(", ")} |`);
    md.push("", "| install-script package | version | scripts |", "| --- | --- | --- |");
    for (const s of t.lifecycleScripts)
      md.push(`| ${s.package} | ${s.version} | ${JSON.stringify(s.scripts).replace(/\|/g, "/")} |`);
    md.push("", "| deprecated | version | dev | message |", "| --- | --- | --- | --- |");
    for (const d of t.deprecated)
      md.push(
        `| ${d.name} | ${d.version} | ${d.dev} | ${String(d.message).replace(/\|/g, "/").slice(0, 140)} |`,
      );
    md.push(
      "",
      "| stale (no release ≥24mo) | version | dev | latest | months |",
      "| --- | --- | --- | --- | ---: |",
    );
    for (const s of t.stale)
      md.push(`| ${s.name} | ${s.version} | ${s.dev} | ${s.latest} | ${s.monthsSinceAnyRelease} |`);
    md.push("");
  }
  md.push(
    "## Floating specifiers",
    "",
    "| manifest | field | name | spec |",
    "| --- | --- | --- | --- |",
  );
  for (const f of report.floatingSpecifiers)
    md.push(`| ${f.manifest} | ${f.field} | ${f.name} | ${f.spec} |`);
  writeFileSync(resolve(outDir, "dep-inventory.md"), md.join("\n") + "\n");
  for (const t of report.trees)
    console.log(
      `${t.source}: ${t.packages} versions / ${t.uniqueNames} names, ${t.duplicates.length} duplicated, ${t.lifecycleScripts.length} with install scripts, ${t.deprecated.length} deprecated, ${t.stale.length} stale`,
    );
  console.log(
    `${report.floatingSpecifiers.length} floating specifiers -> ${resolve(outDir, "dep-inventory.json")}`,
  );
}

main().catch((e) => {
  console.error(e.stack ?? String(e));
  process.exit(2);
});
