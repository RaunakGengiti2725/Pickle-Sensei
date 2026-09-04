#!/usr/bin/env node
// i18n / locale-formatting audit orchestrator for apps/mobile.
//
// Node (and therefore jest) fixes the process time zone and default locale at
// startup, so the matrix test is spawned once per dimension value:
//   * one process per IANA zone (locale zones + adversarial zones), TZ=<zone>,
//   * one process per audited locale with LANG=<posix>.UTF-8 so the UNSHIMMED
//     `env` run resolves to that locale and cross-checks the shim.
// Each process writes its 25-run JSON to PS_I18N_OUT; this script merges them
// into <out-dir>/matrix.json plus a per-process log and a divergence table,
// and exits non-zero if any jest process failed (a `test.failing` pin that
// unexpectedly passes counts as a failure — that is the point of the pins).
//
// Usage: node i18n-harness/run-locale-matrix.mjs [--out-dir <dir>] [--zones a,b]
// Replay a single cell: TZ=<zone> LANG=<posix>.UTF-8 npx jest __tests__/i18n

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..');
const dimensions = JSON.parse(
  readFileSync(join(here, 'dimensions.json'), 'utf8'),
);

const args = process.argv.slice(2);
function flag(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}
const outDir = resolve(
  flag('--out-dir') ??
    join(
      mobileRoot,
      '..',
      '..',
      'artifacts',
      'i18n-locale-matrix',
      new Date().toISOString().replace(/[:.]/g, '-'),
    ),
);
const zoneFilter = flag('--zones')?.split(',').filter(Boolean);

const zones = [
  ...new Set([
    ...dimensions.locales.map(l => l.zone),
    ...dimensions.adversarialZones,
  ]),
].filter(zone => !zoneFilter || zoneFilter.includes(zone));

const cells = [
  ...zones.map(zone => ({
    id: `tz-${zone.replace(/\//g, '_')}`,
    env: { TZ: zone },
  })),
  ...dimensions.locales.map(l => ({
    id: `lang-${l.posix}`,
    env: { TZ: l.zone, LANG: `${l.posix}.UTF-8`, LC_ALL: `${l.posix}.UTF-8` },
  })),
];

mkdirSync(join(outDir, 'runs'), { recursive: true });
const results = [];
for (const cell of cells) {
  const outFile = join(outDir, 'runs', `${cell.id}.json`);
  const logFile = join(outDir, 'runs', `${cell.id}.log`);
  const started = Date.now();
  const proc = spawnSync(
    'npx',
    ['jest', '--ci', '--colors=false', '__tests__/i18n/localeMatrix.test.ts'],
    {
      cwd: mobileRoot,
      env: {
        ...process.env,
        ...cell.env,
        PS_I18N_OUT: outFile,
        FORCE_COLOR: '0',
      },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const log = `${proc.stdout ?? ''}\n${proc.stderr ?? ''}`;
  writeFileSync(logFile, log);
  const testLines = log
    .split('\n')
    .filter(line => /^\s+(✓|✕|○)/.test(line))
    .map(line => line.trim());
  let payload = null;
  try {
    payload = JSON.parse(readFileSync(outFile, 'utf8'));
  } catch {
    payload = null;
  }
  const status = proc.status ?? -1;
  results.push({
    id: cell.id,
    env: cell.env,
    command: `${Object.entries(cell.env)
      .map(([k, v]) => `${k}=${v}`)
      .join(
        ' ',
      )} PS_I18N_OUT=${outFile} npx jest --ci __tests__/i18n/localeMatrix.test.ts`,
    exitCode: status,
    durationMs: Date.now() - started,
    processZone: payload?.processZone ?? null,
    envLocale: payload?.envLocale ?? null,
    runs: payload?.runs?.length ?? 0,
    tests: testLines,
    out: outFile,
    log: logFile,
  });
  process.stdout.write(
    `${status === 0 ? 'ok  ' : 'FAIL'} ${cell.id.padEnd(28)} zone=${payload?.processZone ?? '?'} env=${payload?.envLocale ?? '?'} tests=${testLines.length}\n`,
  );
}

// ---- Divergence table: for every probe site, the distinct outputs observed
// across (zone, env locale, state, locale) with the cells that produced them.
const table = new Map();
for (const result of results) {
  if (!result.runs) continue;
  const payload = JSON.parse(readFileSync(result.out, 'utf8'));
  for (const run of payload.runs) {
    for (const row of run.rows) {
      const site = table.get(row.site) ?? {
        site: row.site,
        kind: row.kind,
        file: row.file,
        expectation: row.expectation,
        input: row.input,
        outputs: new Map(),
      };
      const seen = site.outputs.get(row.output) ?? [];
      seen.push({
        cell: result.id,
        zone: payload.processZone,
        state: run.state,
        locale: run.locale,
        defaultLocale: run.defaultLocale,
      });
      site.outputs.set(row.output, seen);
      table.set(row.site, site);
    }
  }
}
const divergences = [...table.values()]
  .map(site => ({
    site: site.site,
    kind: site.kind,
    file: site.file,
    expectation: site.expectation,
    input: site.input,
    distinctOutputs: site.outputs.size,
    outputs: [...site.outputs.entries()].map(([output, cells]) => ({
      output,
      cells: cells.length,
      sample: cells.slice(0, 4),
      zones: [...new Set(cells.map(c => c.zone))],
      defaultLocales: [...new Set(cells.map(c => c.defaultLocale))],
    })),
  }))
  .sort((a, b) => b.distinctOutputs - a.distinctOutputs);

const summary = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  icu: process.versions.icu,
  unicode: process.versions.unicode,
  platform: `${process.platform}/${process.arch}`,
  cells: results.length,
  failedCells: results.filter(r => r.exitCode !== 0).map(r => r.id),
  zones,
  locales: dimensions.locales.map(l => l.tag),
  probeRunsTotal: results.reduce((sum, r) => sum + r.runs, 0),
  results,
};
writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
writeFileSync(
  join(outDir, 'divergences.json'),
  JSON.stringify(divergences, null, 2),
);

// Markdown view of the divergence table for humans.
const md = [
  `# i18n locale matrix — ${summary.generatedAt}`,
  '',
  `Node ${summary.node}, ICU ${summary.icu}, ${summary.platform}. ${summary.cells} jest processes, ${summary.probeRunsTotal} probe runs (25 per process: 12 locales × 2 runtime states + 1 unshimmed env run).`,
  '',
  `Failed cells: ${summary.failedCells.length ? summary.failedCells.join(', ') : 'none'}`,
  '',
  '| site | kind | expectation | distinct outputs | file |',
  '|---|---|---|---|---|',
  ...divergences.map(
    d =>
      `| ${d.site} | ${d.kind} | ${d.expectation} | ${d.distinctOutputs} | ${d.file} |`,
  ),
  '',
];
writeFileSync(join(outDir, 'divergences.md'), md.join('\n'));

process.stdout.write(
  `\nwrote ${outDir}/{summary.json,divergences.json,divergences.md,runs/}\n`,
);
process.exit(summary.failedCells.length === 0 ? 0 : 1);
