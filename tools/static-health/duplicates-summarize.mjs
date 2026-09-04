#!/usr/bin/env node
// Summarizes jscpd JSON reports written by duplicates.sh into a markdown table.
//   node tools/static-health/duplicates-summarize.mjs <out-dir> <minTokens> <minLines>
// For each pass: totals, then clones ranked by lines, with both locations so a
// reviewer can open file:line-line pairs directly. Cross-package clones (the two
// halves live in different workspace packages) are flagged because those are the
// ones a shared helper would remove; intra-file clones are usually table-like code.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const [outDir, minTokens, minLines] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: duplicates-summarize.mjs <out-dir> <minTokens> <minLines>");
  process.exit(2);
}

const pkgOf = (p) =>
  p
    .replace(/^.*?\/Pickle-Sensei\//, "")
    .split("/")
    .slice(0, 2)
    .join("/");
const short = (p) => p.replace(/^.*?\/Pickle-Sensei\//, "");

console.log(`# Duplicate-logic census (jscpd, min-tokens=${minTokens}, min-lines=${minLines})\n`);
for (const pass of ["src-only", "all"]) {
  const file = join(outDir, pass, "jscpd-report.json");
  if (!existsSync(file)) {
    console.log(`## ${pass}: report missing (${file})\n`);
    continue;
  }
  const j = JSON.parse(readFileSync(file, "utf8"));
  const t = j.statistics.total;
  console.log(`## ${pass}\n`);
  console.log(
    `| sources | lines | tokens | clones | duplicated lines | duplicated % |\n|---|---|---|---|---|---|`,
  );
  console.log(
    `| ${t.sources} | ${t.lines} | ${t.tokens} | ${t.clones} | ${t.duplicatedLines} | ${t.percentage}% |\n`,
  );

  const dups = j.duplicates.map((d) => ({
    lines: d.lines,
    tokens: d.tokens,
    a: `${short(d.firstFile.name)}:${d.firstFile.startLoc.line}-${d.firstFile.endLoc.line}`,
    b: `${short(d.secondFile.name)}:${d.secondFile.startLoc.line}-${d.secondFile.endLoc.line}`,
    scope:
      pkgOf(d.firstFile.name) === pkgOf(d.secondFile.name)
        ? d.firstFile.name === d.secondFile.name
          ? "same-file"
          : "same-package"
        : "cross-package",
  }));
  const byScope = {};
  for (const d of dups) byScope[d.scope] = (byScope[d.scope] ?? 0) + 1;
  console.log(`clones by scope: ${JSON.stringify(byScope)}\n`);
  console.log("| lines | tokens | scope | first | second |\n|---|---|---|---|---|");
  for (const d of dups.sort(
    (x, y) =>
      (x.scope === "cross-package" ? -1 : 0) - (y.scope === "cross-package" ? -1 : 0) ||
      y.lines - x.lines,
  )) {
    console.log(`| ${d.lines} | ${d.tokens} | ${d.scope} | ${d.a} | ${d.b} |`);
  }
  console.log();
}
