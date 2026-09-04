#!/usr/bin/env node
/**
 * Locale × time-zone campaign driver for progressScreenBoundaryI18nA11y.
 *
 * Intl locale and time zone are fixed when node starts, so one jest process
 * can only observe one cell. This launches one process per (locale, zone)
 * cell with LANG/LC_ALL/TZ set, STRESS_ITER iterations each, and aggregates
 * the per-cell JSON tables into <out>/matrix.json.
 *
 *   node __tests__/stress/progressScreenMatrix.runner.mjs --out /tmp/psm --iter 2 --jobs 4
 *
 * Exit code is 0 only when every cell ran and every seed HELD.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = [
  'de_DE',
  'fr_FR',
  'ar_EG',
  'hi_IN',
  'ja_JP',
  'pt_BR',
  'tr_TR',
  'ru_RU',
  'th_TH',
  'zh_CN',
  'en_IN',
  'es_419',
];
// UTC+14, UTC-12, northern + southern DST, half-hour DST, 45-minute offset,
// no-DST half-hour, and the transition-heavy Berlin zone.
const ZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'America/Santiago',
  'Asia/Kolkata',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const outDir = resolve(arg('out', '/tmp/progress-screen-matrix'));
const iter = Number(arg('iter', '2'));
const jobs = Number(arg('jobs', '4'));
const baseSeed = Number(arg('seed', '20260904'));
const mobileDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
mkdirSync(outDir, { recursive: true });

const cells = [];
LOCALES.forEach((locale, li) => {
  ZONES.forEach((zone, zi) => {
    cells.push({
      locale,
      zone,
      seed: baseSeed + (li * ZONES.length + zi) * 1000,
      out: join(outDir, `${locale}__${zone.replace(/\//g, '-')}.json`),
    });
  });
});

function runCell(cell) {
  return new Promise(done => {
    const child = spawn(
      'npx',
      [
        'jest',
        '--ci',
        '--silent',
        '-w1',
        '__tests__/stress/progressScreenBoundaryI18nA11y',
      ],
      {
        cwd: mobileDir,
        env: {
          ...process.env,
          LANG: `${cell.locale}.UTF-8`,
          LC_ALL: `${cell.locale}.UTF-8`,
          TZ: cell.zone,
          STRESS_ITER: String(iter),
          STRESS_SEED: String(cell.seed),
          STRESS_OUT: cell.out,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    child.stdout.on('data', d => (log += d));
    child.stderr.on('data', d => (log += d));
    child.on('close', code => {
      writeFileSync(cell.out.replace(/\.json$/, '.log'), log);
      done({ ...cell, exitCode: code });
    });
  });
}

async function main() {
  const started = Date.now();
  const results = [];
  let next = 0;
  async function worker() {
    while (next < cells.length) {
      const cell = cells[next++];
      const r = await runCell(cell);
      const table = existsSync(r.out)
        ? JSON.parse(readFileSync(r.out, 'utf8'))
        : null;
      results.push({
        locale: r.locale,
        zone: r.zone,
        seed: r.seed,
        exitCode: r.exitCode,
        observedLocale: table?.env?.observedLocale ?? null,
        observedTimeZone: table?.env?.observedTimeZone ?? null,
        executed: table?.executed ?? 0,
        held: table?.held ?? 0,
        brokenSeeds: table?.broken ?? [],
        checks: table
          ? table.results.flatMap(x =>
              x.failures.map(f => `${x.seed}:${f.check}`),
            )
          : ['cell-did-not-produce-table'],
        table: r.out,
      });
      process.stdout.write(
        `${r.locale} ${r.zone} → exit ${r.exitCode} executed=${table?.executed ?? 0} broken=${(table?.broken ?? []).length}\n`,
      );
    }
  }
  await Promise.all(Array.from({ length: jobs }, worker));
  results.sort((a, b) => a.seed - b.seed);
  const executed = results.reduce((n, r) => n + r.executed, 0);
  const held = results.reduce((n, r) => n + r.held, 0);
  const summary = {
    unit: 'scr-progressscreen',
    lens: 'boundary-i18n-a11y',
    locales: LOCALES,
    zones: ZONES,
    iterationsPerCell: iter,
    cells: results.length,
    executed,
    held,
    broken: executed - held,
    cellsMissingTable: results.filter(r => r.executed === 0).length,
    durationMs: Date.now() - started,
    results,
  };
  writeFileSync(join(outDir, 'matrix.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(
    `\ncells=${results.length} executed=${executed} held=${held} broken=${executed - held} → ${join(outDir, 'matrix.json')}\n`,
  );
  process.exit(summary.cellsMissingTable === 0 && summary.broken === 0 ? 0 : 1);
}

main();
