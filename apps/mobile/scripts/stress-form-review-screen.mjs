#!/usr/bin/env node
/**
 * Process-level locale × time-zone matrix for the FormReviewScreen stress
 * suite (__tests__/stress/formReviewScreen.boundaryI18nA11y.stress.test.tsx).
 *
 * Jest cannot change the ICU default locale or the zone of a running
 * process, so this driver starts ONE Jest process per (locale, zone) cell
 * with LANG/LC_ALL/TZ set, replays the SAME seeds in every cell and then
 * compares, seed by seed, the rendered-text digest and the oracle failure
 * signature the suite recorded. The invariant under test: the screen's
 * rendered output must not depend on the device locale or zone (the suite's
 * R12 oracle asserts no locale-sensitive formatting API runs; this driver
 * proves the consequence end to end across processes).
 *
 * Usage:
 *   node scripts/stress-form-review-screen.mjs [--matrix pairs|grid]
 *        [--iter N] [--seed N] [--jobs N] [--out DIR]
 *
 *   --matrix pairs  12 cells: locale[i] × zone[i mod 8]   (default, fast)
 *   --matrix grid   96 cells: every locale × every zone
 *   --iter N        seeds per cell (STRESS_ITER, default 12)
 *   --seed N        base seed (STRESS_SEED, default 20260904)
 *   --jobs N        concurrent Jest processes (default 2)
 *   --out DIR       where cell results + matrix.json land
 *                   (default artifacts/stress/formReviewScreen-locale-zone-matrix)
 *
 * Exit 0 ⇔ every cell produced a results table under the requested
 * locale/zone AND every seed has exactly one digest and one failure
 * signature across all cells. The per-cell Jest exit code is recorded but
 * does not drive the verdict: a seed that reproduces a known finding in
 * EVERY cell is invariant (the finding belongs to the suite's report), a
 * seed that fails in some cells only is a locale/zone dependency and fails
 * here. NODE_OPTIONS is inherited (this repo's node:sqlite tests need
 * `--experimental-sqlite` on Node < 22.13).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const mobileRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const SUITE =
  '__tests__/stress/formReviewScreen.boundaryI18nA11y.stress.test.tsx';

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
const TIME_ZONES = [
  'Etc/GMT+12',
  'Pacific/Kiritimati',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'America/Santiago',
];

function parseArgs(argv) {
  const opts = {
    matrix: 'pairs',
    iter: 12,
    seed: 20260904,
    jobs: 2,
    out: join(
      mobileRoot,
      'artifacts',
      'stress',
      'formReviewScreen-locale-zone-matrix',
    ),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    const need = () => {
      if (value === undefined) throw new Error(`${flag} needs a value`);
      i += 1;
      return value;
    };
    switch (flag) {
      case '--matrix': {
        const m = need();
        if (m !== 'pairs' && m !== 'grid') {
          throw new Error(`--matrix must be pairs|grid, got ${m}`);
        }
        opts.matrix = m;
        break;
      }
      case '--iter':
        opts.iter = positiveInt(flag, need());
        break;
      case '--seed':
        opts.seed = positiveInt(flag, need());
        break;
      case '--jobs':
        opts.jobs = positiveInt(flag, need());
        break;
      case '--out':
        opts.out = resolve(need());
        break;
      default:
        throw new Error(`unknown argument ${flag}`);
    }
  }
  return opts;
}

function positiveInt(flag, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got ${raw}`);
  }
  return n;
}

/** ICU locale tag → POSIX locale name Node's ICU reads from LANG/LC_ALL. */
function posixLocale(tag) {
  return `${tag.replace('-', '_')}.UTF-8`;
}

function cellsFor(matrix) {
  if (matrix === 'grid') {
    return LOCALES.flatMap(locale =>
      TIME_ZONES.map(zone => ({ locale, zone })),
    );
  }
  return LOCALES.map((locale, i) => ({
    locale,
    zone: TIME_ZONES[i % TIME_ZONES.length],
  }));
}

function tagFor(cell) {
  return `${cell.locale}__${cell.zone.replace(/[^A-Za-z0-9+-]/g, '_')}`;
}

function runCell(cell, opts) {
  const tag = tagFor(cell);
  const env = {
    ...process.env,
    TZ: cell.zone,
    LANG: posixLocale(cell.locale),
    LC_ALL: posixLocale(cell.locale),
    STRESS_ITER: String(opts.iter),
    STRESS_SEED: String(opts.seed),
    STRESS_TAG: tag,
    STRESS_OUT: opts.out,
  };
  return new Promise(resolveCell => {
    const started = Date.now();
    const child = spawn('npx', ['jest', '--ci', '--silent', SUITE], {
      cwd: mobileRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout.on('data', chunk => {
      log += String(chunk);
    });
    child.stderr.on('data', chunk => {
      log += String(chunk);
    });
    child.on('close', code => {
      writeFileSync(join(opts.out, `${tag}.jest.log`), log);
      resolveCell({
        cell,
        tag,
        exit: code,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function runAll(cells, opts) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < cells.length) {
      const cell = cells[next];
      next += 1;
      const result = await runCell(cell, opts);
      results.push(result);
      console.log(
        `${String(results.length).padStart(3)}/${cells.length} ${result.tag} → jest exit ${result.exit} (${result.durationMs} ms)`,
      );
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(opts.jobs, cells.length) }, worker),
  );
  return results.sort((a, b) => a.tag.localeCompare(b.tag));
}

function readCellTable(opts, tag) {
  const file = join(opts.out, `${tag}.results.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function signatureOf(row) {
  const failures = row.failures
    .map(f => `${f.oracle}: ${f.detail}`)
    .sort()
    .join('\n');
  return `${row.outcome}|${row.state}|${row.digest}|${failures}`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.out, { recursive: true });
  const cells = cellsFor(opts.matrix);
  console.log(
    `matrix=${opts.matrix} cells=${cells.length} iter=${opts.iter} seed=${opts.seed} jobs=${opts.jobs}\nout=${opts.out}`,
  );
  return runAll(cells, opts).then(runs => {
    const problems = [];
    const cellReports = [];
    /** seed → Map<signature, tag[]> */
    const bySeed = new Map();
    for (const run of runs) {
      const table = readCellTable(opts, run.tag);
      if (!table) {
        problems.push(
          `${run.tag}: no results table written (jest exit ${run.exit})`,
        );
        cellReports.push({ ...run, applied: false, iterations: 0, broken: [] });
        continue;
      }
      const { summary } = table;
      const applied =
        canonicalZone(summary.processTimeZone) ===
          canonicalZone(run.cell.zone) &&
        summary.processLocale === run.cell.locale;
      if (!applied) {
        problems.push(
          `${run.tag}: process ran as ${summary.processLocale} / ${summary.processTimeZone}, not ${run.cell.locale} / ${run.cell.zone}`,
        );
      }
      if (summary.iterations !== opts.iter) {
        problems.push(
          `${run.tag}: ${summary.iterations} iterations recorded, expected ${opts.iter}`,
        );
      }
      cellReports.push({
        ...run,
        applied,
        processLocale: summary.processLocale,
        processTimeZone: summary.processTimeZone,
        iterations: summary.iterations,
        broken: summary.broken,
      });
      for (const row of table.table) {
        const perSeed = bySeed.get(row.seed) ?? new Map();
        const sig = signatureOf(row);
        perSeed.set(sig, [...(perSeed.get(sig) ?? []), run.tag]);
        bySeed.set(row.seed, perSeed);
      }
    }

    const seeds = [...bySeed.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([seed, perSeed]) => {
        const signatures = [...perSeed.entries()].map(([sig, tags]) => {
          const [outcome, state, digest] = sig.split('|');
          return { outcome, state, digest, cells: tags.length, tags };
        });
        const cellsSeen = signatures.reduce((n, s) => n + s.cells, 0);
        if (signatures.length !== 1) {
          problems.push(
            `seed ${seed}: ${signatures.length} distinct outcomes across cells — locale/zone dependent`,
          );
        }
        if (cellsSeen !== runs.length) {
          problems.push(
            `seed ${seed}: recorded in ${cellsSeen}/${runs.length} cells`,
          );
        }
        return { seed, invariant: signatures.length === 1, signatures };
      });

    const executed = cellReports.reduce((n, c) => n + c.iterations, 0);
    const verdict = problems.length === 0 ? 'HELD' : 'BROKEN';
    const report = {
      matrix: opts.matrix,
      iter: opts.iter,
      baseSeed: opts.seed,
      cells: cellReports,
      scenariosExecuted: executed,
      seeds,
      problems,
      verdict,
    };
    writeFileSync(
      join(opts.out, 'matrix.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(
      `\n${verdict}: ${cellReports.length} cells, ${executed} rendered variants, ${seeds.filter(s => s.invariant).length}/${seeds.length} seeds invariant across locale × zone`,
    );
    for (const p of problems) console.log(`  - ${p}`);
    console.log(`matrix.json → ${join(opts.out, 'matrix.json')}`);
    process.exitCode = problems.length === 0 ? 0 : 1;
  });
}

/** ICU reports some zones under their canonical alias (Asia/Kolkata →
 * Asia/Calcutta), so both sides are compared after the same resolution. */
function canonicalZone(zone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
    }).resolvedOptions().timeZone;
  } catch {
    return zone;
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
