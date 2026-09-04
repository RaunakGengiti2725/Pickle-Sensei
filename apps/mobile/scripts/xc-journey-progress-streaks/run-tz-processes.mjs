#!/usr/bin/env node
/**
 * Runs the process-timezone-sensitive xc suites once per IANA zone by
 * spawning jest with TZ=<zone> (Jest sandboxes process.env, so the zone must
 * be fixed before the worker starts). Records exit codes, per-zone logs and
 * the per-zone JSON artifacts the suites write, then exits non-zero if any
 * zone failed — the matrix is the evidence, never a pass by omission.
 *
 * Usage (from apps/mobile):  node scripts/xc-journey-progress-streaks/run-tz-processes.mjs
 *   XC_TZ_ZONES="UTC,Pacific/Kiritimati"  to override the zone list.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..', '..');
const repoRoot = resolve(mobileRoot, '..', '..');
const artifactDir =
  process.env.XC_ARTIFACT_DIR ??
  join(repoRoot, 'artifacts', 'xc-journey-progress-streaks');
mkdirSync(join(artifactDir, 'tz-process-logs'), { recursive: true });

const DEFAULT_ZONES = [
  'Etc/GMT+12',
  'Pacific/Honolulu',
  'America/Los_Angeles',
  'America/New_York',
  'America/Santiago',
  'UTC',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Pacific/Chatham',
  'Pacific/Apia',
  'Pacific/Kiritimati',
];
const zones = (process.env.XC_TZ_ZONES ?? DEFAULT_ZONES.join(','))
  .split(',')
  .map(z => z.trim())
  .filter(Boolean);

const suites = [
  '__tests__/xc/journeyProgressStreaks.calendarLabels.test.tsx',
  '__tests__/xc/journeyProgressStreaks.notificationDst.test.ts',
];

const rows = [];
for (const zone of zones) {
  const started = Date.now();
  const result = spawnSync(
    'npx',
    ['jest', '--ci', '--colors=false', ...suites],
    {
      cwd: mobileRoot,
      env: { ...process.env, TZ: zone, XC_ARTIFACT_DIR: artifactDir },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const slug = zone.replace(/\//g, '_');
  const logPath = join(artifactDir, 'tz-process-logs', `${slug}.log`);
  writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const summary = /Tests:\s+(.*)/.exec(result.stderr ?? '')?.[1] ?? '';
  const readJson = name => {
    const path = join(artifactDir, name);
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  };
  const labels = readJson(`calendar-labels.${slug}.json`);
  const notifications = readJson(`notification-dst.${slug}.json`);
  const row = {
    zone,
    exitCode: result.status,
    durationMs: Date.now() - started,
    jestSummary: summary,
    log: logPath,
    utcOffsetMinutes: labels?.utcOffsetMinutes ?? null,
    calendarLabelFailures: labels?.failures?.length ?? null,
    calendarLabelSample: labels?.failures?.[0] ?? null,
    gridMisalignments:
      labels?.gridCases?.filter(g => g.leadCells !== g.expectedLead).length ??
      null,
    notificationProbes: notifications?.probes?.length ?? null,
    notificationFailures: notifications?.failures?.length ?? null,
    notificationFailureSample: notifications?.failures?.[0] ?? null,
  };
  rows.push(row);
  console.log(
    `${zone.padEnd(22)} exit=${row.exitCode} labels=${row.calendarLabelFailures} grid=${row.gridMisalignments} notif=${row.notificationFailures}/${row.notificationProbes}  ${summary}`,
  );
}

const out = {
  generatedAt: new Date().toISOString(),
  node: process.version,
  suites,
  zones,
  rows,
  failingZones: rows.filter(r => r.exitCode !== 0).map(r => r.zone),
};
writeFileSync(
  join(artifactDir, 'tz-process-matrix.json'),
  JSON.stringify(out, null, 2),
);
console.log(`wrote ${join(artifactDir, 'tz-process-matrix.json')}`);
process.exit(out.failingZones.length === 0 ? 0 : 1);
