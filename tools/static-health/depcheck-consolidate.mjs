#!/usr/bin/env node
// Consolidates per-package depcheck JSON (from depcheck-all.sh) into one
// markdown table and labels each hit with a triage class so a reviewer can
// separate real unused deps from tool/config false positives.
//
//   node tools/static-health/depcheck-consolidate.mjs <depcheck-out-dir>
//
// Triage classes (labels only — nothing is filtered out or deleted):
//   tooling      typescript, vitest, tsx, eslint, prettier, @types/*, jest: used via
//                scripts/tsconfig, not imports. depcheck cannot see that.
//   workspace    @pickle/* deps. Consumed via tsconfig paths or re-exported types;
//                check the dead-packages harness before treating as unused.
//   runtime-lib  a normal npm package declared in "dependencies" and never imported
//                anywhere in the package — the interesting bucket.
//   dev-lib      same but declared in "devDependencies".
//   missing      imported but undeclared; resolves today only through hoisting.
import { readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";

const TOOLING = new Set([
  "typescript",
  "vitest",
  "tsx",
  "eslint",
  "prettier",
  "jest",
  "ts-jest",
  "@vitest/coverage-v8",
  "vite",
  "@vitejs/plugin-react",
  "playwright",
  "@playwright/test",
  "tsup",
  "esbuild",
  "nodemon",
  "concurrently",
  "@typescript-eslint/parser",
  "@typescript-eslint/eslint-plugin",
]);

export function classify(name, bucket) {
  if (bucket === "missing") return "missing";
  if (TOOLING.has(name) || name.startsWith("@types/") || name.startsWith("eslint-"))
    return "tooling";
  if (name.startsWith("@pickle/")) return "workspace";
  return bucket === "dependencies" ? "runtime-lib" : "dev-lib";
}

export function consolidate(dir) {
  const rows = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const pkg = basename(f, ".json").replace("_", "/");
    const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const d of j.dependencies)
      rows.push({
        pkg,
        name: d,
        bucket: "dependencies",
        cls: classify(d, "dependencies"),
        where: "",
      });
    for (const d of j.devDependencies)
      rows.push({
        pkg,
        name: d,
        bucket: "devDependencies",
        cls: classify(d, "devDependencies"),
        where: "",
      });
    for (const [d, files] of Object.entries(j.missing)) {
      rows.push({
        pkg,
        name: d,
        bucket: "missing",
        cls: "missing",
        where: files
          .slice(0, 3)
          .map((p) => p.replace(/^.*\/Pickle-Sensei\//, ""))
          .join(", "),
      });
    }
  }

  const byClass = {};
  for (const r of rows) byClass[r.cls] = (byClass[r.cls] ?? 0) + 1;

  const out = [];
  out.push(`# depcheck consolidated (${rows.length} hits)\n`);
  out.push("| class | count |\n|---|---|");
  for (const [c, n] of Object.entries(byClass).sort()) out.push(`| ${c} | ${n} |`);
  out.push(
    "\n| package | dependency | bucket | class | first importers (missing only) |\n|---|---|---|---|---|",
  );
  const order = { "runtime-lib": 0, missing: 1, "dev-lib": 2, workspace: 3, tooling: 4 };
  rows.sort(
    (a, b) =>
      order[a.cls] - order[b.cls] || a.pkg.localeCompare(b.pkg) || a.name.localeCompare(b.name),
  );
  for (const r of rows) out.push(`| ${r.pkg} | ${r.name} | ${r.bucket} | ${r.cls} | ${r.where} |`);
  return out.join("\n") + "\n";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: depcheck-consolidate.mjs <out-dir>");
    process.exit(2);
  }
  process.stdout.write(consolidate(dir));
}
