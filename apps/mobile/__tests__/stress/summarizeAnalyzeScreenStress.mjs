// Merges every per-cell summary the stress suite wrote into one seed→outcome
// table (campaign-summary.json) plus a short console digest.
//
//   node __tests__/stress/summarizeAnalyzeScreenStress.mjs artifacts/stress
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? join(process.cwd(), 'artifacts', 'stress');
const files = readdirSync(dir)
  .filter(
    f =>
      f.startsWith('analyzeScreen-boundary-i18n-a11y.') &&
      f.endsWith('.json') &&
      !f.includes('.tree.'),
  )
  .sort();

const cells = [];
const table = [];
const kinds = {};
const byScenario = {};
const byPhase = {};
const localesActual = new Set();
const zonesActual = new Set();
const fontScales = new Set();
const viewports = new Set();
const boundaries = new Set();

for (const file of files) {
  const s = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  cells.push({
    file,
    cell: s.cell,
    localeActual: s.localeActual,
    timeZone: s.timeZone,
    seedBase: s.seedBase,
    iterations: s.iterations,
    held: s.held,
    broken: s.broken,
  });
  for (const r of s.rows) {
    localesActual.add(r.localeActual);
    zonesActual.add(r.timeZone);
    fontScales.add(r.fontScale);
    viewports.add(r.viewport);
    boundaries.add(r.boundary);
    byScenario[r.scenario] = (byScenario[r.scenario] ?? 0) + 1;
    byPhase[r.phaseReached] = (byPhase[r.phaseReached] ?? 0) + 1;
    for (const v of r.violations) kinds[v.kind] = (kinds[v.kind] ?? 0) + 1;
    table.push({
      cell: s.cell,
      seed: r.seed,
      scenario: r.scenario,
      fontScale: r.fontScale,
      viewport: r.viewport,
      localeActual: r.localeActual,
      timeZone: r.timeZone,
      rtl: r.rtl,
      boundary: r.boundary,
      phaseReached: r.phaseReached,
      outcome: r.outcome,
      violations: r.violations.map(v => `${v.kind}[${v.basis}]`),
    });
  }
}

const summary = {
  unit: 'scr-analyzescreen',
  lens: 'boundary-i18n-a11y',
  cells,
  iterations: table.length,
  held: table.filter(r => r.outcome === 'HELD').length,
  broken: table.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
  brokenHostTree: table
    .filter(r => r.violations.some(v => v.endsWith('[host-tree]')))
    .map(r => r.seed),
  brokenLayoutModelOnly: table
    .filter(
      r =>
        r.outcome === 'BROKEN' &&
        r.violations.every(v => v.endsWith('[layout-model]')),
    )
    .map(r => r.seed),
  violationKinds: kinds,
  byScenario,
  byPhase,
  coverage: {
    localesActual: [...localesActual].sort(),
    timeZonesActual: [...zonesActual].sort(),
    fontScales: [...fontScales].sort((a, b) => a - b),
    viewports: [...viewports].sort(),
    boundaries: [...boundaries].sort(),
  },
  table,
};
writeFileSync(
  join(dir, 'campaign-summary.json'),
  JSON.stringify(summary, null, 2),
);
console.log(
  JSON.stringify(
    {
      cells: cells.length,
      iterations: summary.iterations,
      held: summary.held,
      broken: summary.broken.length,
      violationKinds: kinds,
      localesActual: summary.coverage.localesActual,
      timeZonesActual: summary.coverage.timeZonesActual,
    },
    null,
    2,
  ),
);
