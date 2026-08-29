import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { checkArtifactInvariants, type InvariantViolation } from "./invariants.js";

/**
 * Corpus invariant check: runs the artifact invariants over every committed
 * JSON file under a root (datasets/ in practice) and REPORTS what it finds.
 * Violations are findings about the data, never repaired here.
 */

export interface CorpusViolation extends InvariantViolation {
  file: string;
}

export interface CorpusCheckReport {
  root: string;
  filesChecked: number;
  parseFailures: Array<{ file: string; error: string }>;
  violations: CorpusViolation[];
}

export function runCorpusCheck(rootDir: string): CorpusCheckReport {
  const files: string[] = [];
  collectJsonFiles(rootDir, files);
  files.sort();
  const parseFailures: CorpusCheckReport["parseFailures"] = [];
  const violations: CorpusViolation[] = [];
  for (const file of files) {
    const rel = relative(rootDir, file);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
      parseFailures.push({
        file: rel,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const violation of checkArtifactInvariants(parsed)) {
      violations.push({ file: rel, ...violation });
    }
  }
  return { root: rootDir, filesChecked: files.length, parseFailures, violations };
}

function collectJsonFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) collectJsonFiles(full, out);
    else if (entry.endsWith(".json")) out.push(full);
  }
}

const invokedDirectly = process.argv[1] !== undefined && process.argv[1].endsWith("corpusCheck.ts");
if (invokedDirectly) {
  const root = process.argv[2] ?? join(process.cwd(), "..", "..", "datasets");
  const report = runCorpusCheck(root);
  console.log(
    `corpus check · ${report.filesChecked} files · ${report.parseFailures.length} parse failures · ${report.violations.length} violations`,
  );
  for (const failure of report.parseFailures)
    console.log(`  PARSE ${failure.file}: ${failure.error}`);
  const byRule = new Map<string, CorpusViolation[]>();
  for (const violation of report.violations) {
    const list = byRule.get(violation.rule) ?? [];
    list.push(violation);
    byRule.set(violation.rule, list);
  }
  for (const [rule, list] of byRule) {
    console.log(`  ${rule}: ${list.length}`);
    for (const violation of list)
      console.log(`    ${violation.file} ${violation.path} — ${violation.detail}`);
  }
}
