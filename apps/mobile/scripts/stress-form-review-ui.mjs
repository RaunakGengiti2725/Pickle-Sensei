#!/usr/bin/env node
// Locale × time-zone sweep for __tests__/stress/formReviewUi.boundaryI18nA11y.
// Node/Jest resolve locale and zone once per process (LANG / LC_ALL / TZ),
// so the 12-locale × 8-zone matrix is a loop of jest processes over the
// same seed range; every run writes its own JSON table and this script
// prints a summary and the per-zone/locale rendered-tree hash diff.
//
//   node scripts/stress-form-review-ui.mjs [--iter N] [--out DIR] [--seed N]
//
// Exit code is 0 when every jest process exited 0 (the harness itself
// decides what is a failure; STRESS_SOFT is NOT set here so unknown
// failures fail the sweep).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES = [
  'de-DE',
  'fr-FR',
  'ar-EG',
  'hi-IN',
  'ja-JP',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'th-TH',
  'zh-CN',
  'en-IN',
  'es-419',
];

// UTC±14 extremes, half-hour and 45-minute offsets, and DST-observing zones
// on both hemispheres. The harness records the process offset either side
// of the 2026 DST transitions (`environment.dstEdgeOffsetsMinutes`) so each
// cell proves it ran in the requested zone.
const ZONES = [
  'Etc/UTC',
  'Pacific/Kiritimati', // UTC+14, no DST
  'Etc/GMT+12', // UTC-12 (POSIX sign)
  'Pacific/Chatham', // UTC+12:45 / +13:45 DST
  'America/New_York', // UTC-5 / -4 DST (spring-forward gap)
  'Europe/Berlin', // UTC+1 / +2 DST
  'Australia/Lord_Howe', // 30-minute DST shift
  'Asia/Kolkata', // UTC+5:30, no DST
];

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] !== undefined
    ? process.argv[index + 1]
    : fallback;
}

const iter = arg('--iter', '40');
const outDir = arg('--out', '/tmp/stress/sweep');
const baseSeed = arg('--seed', undefined);
mkdirSync(outDir, { recursive: true });

const rows = [];
let failed = 0;
for (const zone of ZONES) {
  for (const locale of LOCALES) {
    const out = join(outDir, `${zone.replace(/\//g, '_')}__${locale}.json`);
    const env = {
      ...process.env,
      TZ: zone,
      LANG: `${locale.replace('-', '_')}.UTF-8`,
      LC_ALL: `${locale.replace('-', '_')}.UTF-8`,
      STRESS_LOCALE: locale,
      STRESS_ITER: iter,
      STRESS_OUT: out,
      ...(baseSeed ? { STRESS_BASE_SEED: baseSeed } : {}),
    };
    const result = spawnSync(
      'npx',
      [
        'jest',
        '--ci',
        '--silent',
        '__tests__/stress/formReviewUi.boundaryI18nA11y.stress.test.tsx',
      ],
      { env, encoding: 'utf8', cwd: join(import.meta.dirname, '..') },
    );
    let table = null;
    try {
      table = JSON.parse(readFileSync(out, 'utf8'));
    } catch {
      table = null;
    }
    const row = {
      zone,
      locale,
      exit: result.status,
      resolvedTimeZone: table?.env?.resolvedTimeZone ?? null,
      utcOffsetMinutes: table?.env?.utcOffsetMinutes ?? null,
      resolvedLocale: table?.env?.resolvedLocale ?? null,
      held: table?.counts?.held ?? null,
      broken: table?.counts?.broken ?? null,
      brokenPropFault: table?.counts?.brokenPropFault ?? null,
      treeHashes: table
        ? table.results.map(item => `${item.seed}:${item.treeHash}`)
        : [],
      out,
    };
    if (result.status !== 0) {
      failed += 1;
      row.stderrTail = (result.stderr ?? '').split('\n').slice(-25).join('\n');
    }
    rows.push(row);
    console.log(
      `${zone.padEnd(22)} ${locale.padEnd(7)} exit=${result.status} ` +
        `zone=${row.resolvedTimeZone} offset=${row.utcOffsetMinutes} ` +
        `held=${row.held} broken=${row.broken} propFault=${row.brokenPropFault}`,
    );
  }
}

// Rendered trees are locale/zone independent by contract: the same seed must
// hash identically in every cell of the matrix.
const bySeed = new Map();
for (const row of rows) {
  for (const entry of row.treeHashes) {
    const [seed, hash] = entry.split(':');
    const set = bySeed.get(seed) ?? new Map();
    set.set(hash, [...(set.get(hash) ?? []), `${row.zone}/${row.locale}`]);
    bySeed.set(seed, set);
  }
}
const divergent = [...bySeed.entries()]
  .filter(([, hashes]) => hashes.size > 1)
  .map(([seed, hashes]) => ({
    seed: Number(seed),
    variants: [...hashes.entries()].map(([hash, cells]) => ({
      hash,
      cells: cells.slice(0, 6),
      cellCount: cells.length,
    })),
  }));

const summary = {
  generatedAt: new Date().toISOString(),
  iterPerCell: Number(iter),
  cells: rows.length,
  cellsFailed: failed,
  scenariosExecuted: rows.reduce(
    (sum, row) => sum + (row.held ?? 0) + (row.broken ?? 0),
    0,
  ),
  seedsDivergentAcrossCells: divergent,
  rows: rows.map(({ treeHashes: _hashes, ...rest }) => rest),
};
writeFileSync(
  join(outDir, 'sweep-summary.json'),
  JSON.stringify(summary, null, 2),
);
console.log(
  `\n${rows.length} cells, ${failed} failed, ${summary.scenariosExecuted} iterations, ` +
    `${divergent.length} seeds whose rendered tree differs across zone/locale ` +
    `→ ${join(outDir, 'sweep-summary.json')}`,
);
process.exit(failed === 0 && divergent.length === 0 ? 0 : 1);
