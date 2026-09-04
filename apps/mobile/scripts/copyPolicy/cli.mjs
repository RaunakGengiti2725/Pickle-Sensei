#!/usr/bin/env node
/**
 * Release copy policy scan — CLI entry.
 *
 *   node apps/mobile/scripts/copyPolicy/cli.mjs [--out artifacts/copy-policy/<run>]
 *
 * Re-executes itself under `--experimental-strip-types` (Node ≥ 22.6) so the
 * TypeScript library can be loaded without a build step, then writes
 * copy-policy-report.{json,md}, copy-policy-visible-strict-hits.json and
 * copy-policy-visible-strings.json into --out.
 *
 * Exit code: 0 clean, 2 user-visible strict hits, 3 extraction coverage gap.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STRIP_FLAG = '--experimental-strip-types';

if (!process.execArgv.includes(STRIP_FLAG)) {
  const child = spawnSync(
    process.execPath,
    [
      STRIP_FLAG,
      '--no-warnings',
      fileURLToPath(import.meta.url),
      ...process.argv.slice(2),
    ],
    { stdio: 'inherit' },
  );
  process.exit(child.status ?? 1);
}

register('./tsResolver.mjs', import.meta.url);

const { findRepoRoot, runScan, writeReport, exitCodeFor } =
  await import('./scan.ts');

const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const outDir = outIdx >= 0 ? argv[outIdx + 1] : null;
if (outIdx >= 0 && !outDir) {
  process.stderr.write('usage: cli.mjs [--out <dir>]\n');
  process.exit(64);
}

const host = { ...fs, path };
const repoRoot = findRepoRoot(host, process.cwd());
const report = runScan(host, repoRoot);
const written = outDir ? writeReport(host, report, outDir) : [];
process.stdout.write(
  `${JSON.stringify({
    commit: report.commit,
    totals: report.totals,
    coverageGaps: report.coverageGaps.length,
    surfaces: report.surfaces,
    written,
  })}\n`,
);
process.exitCode = exitCodeFor(report);
