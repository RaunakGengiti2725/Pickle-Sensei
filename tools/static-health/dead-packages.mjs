#!/usr/bin/env node
// Dead-package census for the pnpm workspace.
//
// For every workspace package it records WHO references it and HOW:
//   codeImporters      import/require of `@pickle/<name>` in source outside the package's own dir
//   manifestDependents package.json dependencies/devDependencies entries in other workspace packages
//   configAliases      tsconfig paths / metro / jest moduleNameMapper aliases (apps/mobile consumes packages this way)
//   scriptInvocations  `--filter @pickle/<name>` or the package dir in package.json scripts, scripts/**, tools/**, .github/workflows/**
//   ownEntrypoints     package.json scripts beyond typecheck/test/lint/build, `bin`, and *.sh in its own dir
//   docMentions        *.md mentions (informational only — docs do not keep a package alive)
//
// Verdict per package (all evidence-based, nothing is deleted):
//   shipping       imported by apps/mobile/src (non-test) or supabase/functions
//   library        imported by non-test code of some other workspace package / tool
//   test-only      imported ONLY from test files of other packages
//   cli-only       not imported anywhere, but its scripts are invoked by root scripts / CI / shell scripts
//   standalone-cli not referenced from outside, but ships its own CLI/shell entrypoints (operator tool)
//   dead-candidate no importer, no invocation, no entrypoint: only its own tests exercise it
//
// Usage: node tools/static-health/dead-packages.mjs [--out <file.json>] [--md <file.md>]
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, walk, rel, loadWorkspacePackages, SOURCE_EXTENSIONS } from "./lib/repo.mjs";

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const mdIdx = args.indexOf("--md");
const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
const mdFile = mdIdx >= 0 ? args[mdIdx + 1] : null;

const packages = loadWorkspacePackages();
const byName = new Map(packages.map((p) => [p.name, p]));
const scopedNames = packages.map((p) => p.name).filter((n) => n.startsWith("@pickle/"));

const TEST_PATH =
  /(^|\/)(__tests__|__wf__|tests?|e2e)\/|\.(test|spec)\.[cm]?[jt]sx?$|\/test-utils?\//;
const SHIPPING_PREFIXES = [
  "apps/mobile/src/",
  "apps/mobile/App.tsx",
  "apps/mobile/index.js",
  "supabase/functions/",
];

const importRe = (name) =>
  new RegExp(
    `(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"]${name.replace("/", "\\/")}(?:\\/[^'"]*)?['"]`,
    "g",
  );

const codeFiles = [...walk(REPO_ROOT, { extensions: SOURCE_EXTENSIONS })].filter(
  (f) => !rel(f).startsWith("tools/static-health/"),
);
const configFiles = [
  "apps/mobile/tsconfig.json",
  "apps/mobile/metro.config.js",
  "apps/mobile/jest.config.js",
  "apps/mobile/babel.config.js",
]
  .map((p) => path.join(REPO_ROOT, p))
  .filter((p) => fs.existsSync(p));
const scriptFiles = [
  ...walk(path.join(REPO_ROOT, "scripts"), {
    extensions: new Set([".sh", ".mjs", ".js", ".ts", ".py"]),
  }),
  ...walk(path.join(REPO_ROOT, ".github"), { extensions: new Set([".yml", ".yaml"]) }),
  ...walk(path.join(REPO_ROOT, "tools"), {
    extensions: new Set([".sh", ".mjs", ".js", ".py"]),
  }).filter((f) => !rel(f).startsWith("tools/static-health/")),
];
const docFiles = [...walk(REPO_ROOT, { extensions: new Set([".md"]) })];
const packageJsons = packages.map((p) => path.join(p.dir, "package.json"));
const rootPackageJson = path.join(REPO_ROOT, "package.json");

const cache = new Map();
const readText = (f) => {
  if (!cache.has(f)) cache.set(f, fs.readFileSync(f, "utf8"));
  return cache.get(f);
};

const VERDICTS = [
  "shipping",
  "library",
  "test-only",
  "cli-only",
  "standalone-cli",
  "dead-candidate",
];
const HOUSEKEEPING_SCRIPTS = new Set(["typecheck", "test", "lint", "build", "format", "clean"]);

function describeOwnEntrypoints(pkg) {
  const manifest = JSON.parse(readText(path.join(pkg.dir, "package.json")));
  const entrypoints = [];
  for (const [script, cmd] of Object.entries(manifest.scripts ?? {})) {
    if (HOUSEKEEPING_SCRIPTS.has(script) || script.startsWith("test:")) continue;
    entrypoints.push({ kind: "script", name: script, command: cmd });
  }
  if (manifest.bin) entrypoints.push({ kind: "bin", name: JSON.stringify(manifest.bin) });
  for (const f of walk(pkg.dir, { extensions: new Set([".sh"]) })) {
    entrypoints.push({ kind: "shell", name: rel(f) });
  }
  return entrypoints;
}

const report = {};
for (const name of scopedNames) {
  const pkg = byName.get(name);
  const ownPrefix = pkg.relDir + "/";
  const re = importRe(name);

  const codeImporters = [];
  for (const f of codeFiles) {
    const r = rel(f);
    if (r.startsWith(ownPrefix)) continue;
    const text = readText(f);
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    const owner = packages.find((p) => r.startsWith(p.relDir + "/"));
    codeImporters.push({
      file: r,
      kind: TEST_PATH.test(r) ? "test" : "production",
      shipping: SHIPPING_PREFIXES.some((pre) => r.startsWith(pre)) && !TEST_PATH.test(r),
      ownerPackage: owner?.name ?? null,
    });
  }

  const manifestDependents = [];
  for (const other of packages) {
    if (other.name === name) continue;
    for (const [field, list] of [
      ["dependencies", other.dependencies],
      ["devDependencies", other.devDependencies],
      ["peerDependencies", other.peerDependencies],
    ]) {
      if (list.some((d) => d.name === name))
        manifestDependents.push({ package: other.name, field });
    }
  }

  const configAliases = configFiles.filter((f) => readText(f).includes(`${name}`)).map(rel);

  const filterRe = new RegExp(
    `--filter[= ]+${name.replace("/", "\\/")}(?![\\w-])|(?<![\\w@/-])${pkg.relDir}(?![\\w-])`,
  );
  const scriptInvocations = [];
  for (const f of [rootPackageJson, ...packageJsons, ...scriptFiles]) {
    const r = rel(f);
    if (r.startsWith(ownPrefix)) continue;
    const text = readText(f);
    if (filterRe.test(text)) scriptInvocations.push(r);
  }

  const docMentions = docFiles
    .filter((f) => !rel(f).startsWith(ownPrefix) && readText(f).includes(name))
    .map(rel);

  const ownEntrypoints = describeOwnEntrypoints(pkg);

  const productionImporters = codeImporters.filter((c) => c.kind === "production");
  const shippingImporters = codeImporters.filter((c) => c.shipping);
  let verdict;
  if (shippingImporters.length > 0) verdict = "shipping";
  else if (productionImporters.length > 0) verdict = "library";
  else if (codeImporters.length > 0) verdict = "test-only";
  else if (scriptInvocations.length > 0) verdict = "cli-only";
  else if (ownEntrypoints.length > 0) verdict = "standalone-cli";
  else verdict = "dead-candidate";

  report[name] = {
    dir: pkg.relDir,
    verdict,
    counts: {
      codeImporters: codeImporters.length,
      productionImporters: productionImporters.length,
      shippingImporters: shippingImporters.length,
      manifestDependents: manifestDependents.length,
      configAliases: configAliases.length,
      scriptInvocations: scriptInvocations.length,
      ownEntrypoints: ownEntrypoints.length,
      docMentions: docMentions.length,
    },
    codeImporters,
    manifestDependents,
    configAliases,
    scriptInvocations,
    ownEntrypoints,
    docMentions,
  };
}

const summary = {
  generatedAt: new Date().toISOString(),
  packagesScanned: scopedNames.length,
  sourceFilesScanned: codeFiles.length,
  verdicts: Object.fromEntries(
    VERDICTS.map((v) => [
      v,
      Object.entries(report)
        .filter(([, r]) => r.verdict === v)
        .map(([n]) => n)
        .sort(),
    ]),
  ),
  packages: report,
};

const json = JSON.stringify(summary, null, 2);
if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, json);
}
if (mdFile) {
  const lines = [
    "| package | verdict | prod importers | test importers | manifest dependents | script invocations | own entrypoints | doc mentions |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const [name, r] of Object.entries(report).sort()) {
    lines.push(
      `| ${name} | ${r.verdict} | ${r.counts.productionImporters} | ${r.counts.codeImporters - r.counts.productionImporters} | ${r.counts.manifestDependents} | ${r.counts.scriptInvocations} | ${r.counts.ownEntrypoints} | ${r.counts.docMentions} |`,
    );
  }
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, lines.join("\n") + "\n");
}
if (!outFile) process.stdout.write(json + "\n");
else {
  for (const [v, names] of Object.entries(summary.verdicts))
    console.log(`${v.padEnd(15)} ${names.length}: ${names.join(", ")}`);
}
