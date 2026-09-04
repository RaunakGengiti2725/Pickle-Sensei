/// <reference types="node" />
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import type { Category, Finding, ScanReport } from './types';
import { loadMobileProgram, relPath, type MobileProgram } from './program';
import {
  scanCasts,
  scanCatches,
  scanComments,
  scanFlags,
  scanLoops,
  scanPromises,
  scanTimers,
} from './scanners';
import { scanDeadExports } from './deadExports';

export const ALL_CATEGORIES: Category[] = [
  'marker',
  'empty-catch',
  'catch-swallows-rejection',
  'catch-drops-error',
  'as-any',
  'double-cast',
  'non-null-index',
  'non-null',
  'ts-directive',
  'eslint-disable',
  'floating-promise',
  'voided-promise-unhandled',
  'then-without-catch',
  'effect-without-cleanup',
  'effect-cleanup-incomplete',
  'ref-timer-not-cleared',
  'timer-handle-discarded',
  'module-timer-uncleared',
  'unbounded-loop',
  'poll-loop',
  'self-rescheduling-timer',
  'dead-export',
  'test-only-export',
  'dead-file',
  'constant-condition',
  'boolean-const-flag',
  'platform-branch',
  'dev-branch',
];

export interface ScanOptions {
  /** Include __tests__ files in the per-file scanners (dead-export analysis always reads them). */
  includeTests?: boolean;
  root?: string;
}

export function runScan(opts: ScanOptions = {}): ScanReport {
  const started = Date.now();
  const mp: MobileProgram = loadMobileProgram(opts.root);
  const findings: Finding[] = [];
  const targets = opts.includeTests
    ? [...mp.productionFiles, ...mp.testFiles]
    : mp.productionFiles;
  for (const sf of targets) {
    const ctx = {
      checker: mp.checker,
      file: relPath(mp.root, sf.fileName),
      sf,
      searchFiles: mp.productionFiles,
    };
    findings.push(
      ...scanComments(ctx),
      ...scanCatches(ctx),
      ...scanCasts(ctx),
      ...scanPromises(ctx),
      ...scanTimers(ctx),
      ...scanLoops(ctx),
      ...scanFlags(ctx),
    );
  }
  findings.push(...scanDeadExports(mp));
  // Identical anchors in one file (e.g. two `points[0]!`) get an ordinal so
  // the baseline ratchets on occurrence COUNT, not just presence.
  const seen = new Map<string, number>();
  for (const f of findings) {
    const n = (seen.get(f.fingerprint) ?? 0) + 1;
    seen.set(f.fingerprint, n);
    if (n > 1) f.fingerprint = `${f.fingerprint}#${n}`;
  }
  findings.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.column - b.column ||
      a.category.localeCompare(b.category),
  );
  const counts = Object.fromEntries(ALL_CATEGORIES.map(c => [c, 0])) as Record<
    Category,
    number
  >;
  for (const f of findings) counts[f.category] += 1;
  const mem = process.memoryUsage();
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    root: mp.root,
    files: {
      production: mp.productionFiles.length,
      test: mp.testFiles.length,
      total: mp.productionFiles.length + mp.testFiles.length,
    },
    counts,
    findings,
    durationMs: Date.now() - started,
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1048576),
      rssMB: Math.round(mem.rss / 1048576),
    },
    versions: { typescript: ts.version, node: process.version },
  };
}

/** Baseline file format consumed by __tests__/staticHealthRatchet.test.ts. */
export interface Baseline {
  schemaVersion: 1;
  /** Sorted, unique fingerprints of every accepted finding. */
  fingerprints: string[];
}

export function toBaseline(report: ScanReport): Baseline {
  return {
    schemaVersion: 1,
    fingerprints: [...new Set(report.findings.map(f => f.fingerprint))].sort(),
  };
}

export interface RatchetDiff {
  /** Fingerprints present now but absent from the baseline: new debt. */
  added: Finding[];
  /** Baseline entries no longer produced: debt paid down (or a rename). */
  stale: string[];
}

export function diffAgainstBaseline(
  report: ScanReport,
  baseline: Baseline,
): RatchetDiff {
  const accepted = new Set(baseline.fingerprints);
  const live = new Set(report.findings.map(f => f.fingerprint));
  return {
    added: report.findings.filter(f => !accepted.has(f.fingerprint)),
    stale: baseline.fingerprints.filter(fp => !live.has(fp)),
  };
}

export function toMarkdownTable(findings: Finding[]): string {
  const rows = findings.map(
    f =>
      `| ${f.category} | ${f.file}:${f.line} | ${f.message.replace(/\|/g, '\\|')} | \`${f.snippet.replace(/\|/g, '\\|').replace(/`/g, "'")}\` |`,
  );
  return [
    '| category | location | why | source |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n');
}

export function writeReport(report: ScanReport, outDir: string): string[] {
  fs.mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const json = path.join(outDir, 'static-health.json');
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  written.push(json);
  const md = path.join(outDir, 'static-health.md');
  const header = [
    `# apps/mobile static health — ${report.generatedAt}`,
    '',
    `files: production=${report.files.production} test=${report.files.test}; findings=${report.findings.length}; duration=${report.durationMs}ms`,
    '',
    '| category | count |',
    '| --- | --- |',
    ...ALL_CATEGORIES.filter(c => report.counts[c] > 0).map(
      c => `| ${c} | ${report.counts[c]} |`,
    ),
    '',
  ].join('\n');
  fs.writeFileSync(md, header + toMarkdownTable(report.findings) + '\n');
  written.push(md);
  const baseline = path.join(outDir, 'baseline.json');
  fs.writeFileSync(
    baseline,
    JSON.stringify(toBaseline(report), null, 2) + '\n',
  );
  written.push(baseline);
  const fp = path.join(outDir, 'fingerprints.txt');
  fs.writeFileSync(
    fp,
    report.findings
      .map(f => f.fingerprint)
      .sort()
      .join('\n') + '\n',
  );
  written.push(fp);
  return written;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outDir =
    outIdx >= 0 && args[outIdx + 1]
      ? path.resolve(args[outIdx + 1]!)
      : path.resolve(process.cwd(), 'artifacts', 'static-health');
  const includeTests = args.includes('--include-tests');
  const baselineIdx = args.indexOf('--baseline');
  const report = runScan({ includeTests });
  const files = writeReport(report, outDir);
  let ratchet: { added: number; stale: number } | null = null;
  if (baselineIdx >= 0 && args[baselineIdx + 1]) {
    const baseline = JSON.parse(
      fs.readFileSync(path.resolve(args[baselineIdx + 1]!), 'utf8'),
    ) as Baseline;
    const diff = diffAgainstBaseline(report, baseline);
    ratchet = { added: diff.added.length, stale: diff.stale.length };
    fs.writeFileSync(
      path.join(outDir, 'ratchet-diff.json'),
      JSON.stringify(diff, null, 2) + '\n',
    );
  }
  process.stdout.write(
    JSON.stringify(
      {
        files: report.files,
        findings: report.findings.length,
        counts: Object.fromEntries(
          Object.entries(report.counts).filter(([, n]) => n > 0),
        ),
        durationMs: report.durationMs,
        memory: report.memory,
        versions: report.versions,
        ratchet,
        written: files,
      },
      null,
      2,
    ) + '\n',
  );
  if (ratchet && ratchet.added > 0) process.exitCode = 1;
}
