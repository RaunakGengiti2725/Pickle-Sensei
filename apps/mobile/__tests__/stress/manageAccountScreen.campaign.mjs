#!/usr/bin/env node
/**
 * Sharded driver for the ManageAccountScreen seeded randomized campaign.
 *
 * One jest process cannot host thousands of real-navigator mounts: every
 * NavigationContainer + native-stack mount/unmount cycle retains ~0.4–5 MB
 * in the test process (measured with `STRESS_HEAP_EVERY`; a trivial screen
 * leaks at the same rate as ManageAccountScreen, so this is test/navigation
 * infrastructure, not the screen), and a 2000-seed run OOMs near 4 GB.
 * This driver splits the seed range into shards, runs each shard in its
 * own jest process (bounded concurrency) and merges the shard reports into
 * ONE seed → outcome table with the same shape the test writes.
 *
 *   node __tests__/stress/manageAccountScreen.campaign.mjs \
 *     --iterations 2000 --seed 20260904 --shard 250 --concurrency 4 \
 *     --out /tmp/manage-account-campaign
 *
 * Exit code: 0 iff every shard's jest run exited 0 (every seed HELD and
 * every determinism replay matched). Shard logs and JSON live under --out.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const mobileRoot = resolve(here, '..', '..');
const TEST_PATTERN = '__tests__/stress/manageAccountScreen.randomizedSeeded';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const iterations = Number(arg('iterations', 2000));
const baseSeed = Number(arg('seed', 20260904)) >>> 0;
const shardSize = Number(arg('shard', 250));
const concurrency = Math.max(1, Number(arg('concurrency', 4)));
const heapEvery = Number(arg('heap-every', 50));
const outDir = resolve(arg('out', join(mobileRoot, 'artifacts', 'stress')));
mkdirSync(outDir, { recursive: true });

const shards = [];
for (let offset = 0; offset < iterations; offset += shardSize) {
  const count = Math.min(shardSize, iterations - offset);
  shards.push({
    index: shards.length,
    seed: (baseSeed + offset) >>> 0,
    count,
    json: join(outDir, `shard-${String(shards.length).padStart(2, '0')}.json`),
    log: join(outDir, `shard-${String(shards.length).padStart(2, '0')}.log`),
  });
}

function runShard(shard) {
  return new Promise(resolvePromise => {
    const startedAt = Date.now();
    const child = spawn('npx', ['jest', '--ci', '-i', TEST_PATTERN], {
      cwd: mobileRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS ?? '', '--expose-gc']
          .join(' ')
          .trim(),
        STRESS_ITER: String(shard.count),
        STRESS_SEED: String(shard.seed),
        STRESS_OUT: shard.json,
        STRESS_HEAP_EVERY: String(heapEvery),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks = [];
    child.stdout.on('data', d => chunks.push(d));
    child.stderr.on('data', d => chunks.push(d));
    child.on('close', code => {
      writeFileSync(shard.log, Buffer.concat(chunks));
      const durationMs = Date.now() - startedAt;
      process.stdout.write(
        `[campaign] shard ${shard.index} seeds ${shard.seed}..${(shard.seed + shard.count - 1) >>> 0} → jest exit ${code} (${durationMs} ms)\n`,
      );
      resolvePromise({ ...shard, exitCode: code ?? -1, durationMs });
    });
  });
}

async function runAll() {
  const results = new Array(shards.length);
  let next = 0;
  async function worker() {
    while (next < shards.length) {
      const i = next;
      next += 1;
      results[i] = await runShard(shards[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, shards.length) }, worker),
  );
  return results;
}

function addInto(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + value;
  }
}

const startedAt = Date.now();
const shardResults = await runAll();

const merged = {
  unit: 'scr-manageaccountscreen',
  lens: 'randomized-seeded',
  baseSeed,
  iterations,
  lengthRange: null,
  scenariosExecuted: 0,
  stepsExecuted: 0,
  held: 0,
  broken: 0,
  durationMs: Date.now() - startedAt,
  shards: [],
  results: [],
  failures: [],
  determinism: [],
  actionHistogram: {},
  outcomeHistogram: {},
  heap: [],
};

let missing = 0;
for (const shard of shardResults) {
  const entry = {
    index: shard.index,
    seed: shard.seed,
    count: shard.count,
    jestExitCode: shard.exitCode,
    durationMs: shard.durationMs,
    json: shard.json,
    log: shard.log,
    reportPresent: existsSync(shard.json),
  };
  merged.shards.push(entry);
  if (!entry.reportPresent) {
    missing += 1;
    continue;
  }
  const report = JSON.parse(readFileSync(shard.json, 'utf8'));
  merged.lengthRange = report.lengthRange;
  merged.scenariosExecuted += report.scenariosExecuted;
  merged.stepsExecuted += report.stepsExecuted;
  merged.held += report.held;
  merged.broken += report.broken;
  merged.results.push(...report.results);
  merged.failures.push(...report.failures);
  merged.determinism.push(...report.determinism);
  addInto(merged.actionHistogram, report.actionHistogram);
  addInto(merged.outcomeHistogram, report.outcomeHistogram);
  merged.heap.push(
    ...(report.heap ?? []).map(h => ({ shard: shard.index, ...h })),
  );
}

const mergedPath = join(outDir, 'campaign.json');
writeFileSync(mergedPath, JSON.stringify(merged, null, 2));

const failedShards = shardResults.filter(s => s.exitCode !== 0).length;
const nonDeterministic = merged.determinism.filter(d => !d.identical).length;
process.stdout.write(
  `[campaign] seeds executed=${merged.scenariosExecuted}/${iterations} steps=${merged.stepsExecuted} held=${merged.held} broken=${merged.broken} determinism=${merged.determinism.length} replays (${nonDeterministic} mismatched) shards failing=${failedShards} reports missing=${missing}\n[campaign] merged → ${mergedPath}\n`,
);
process.exit(failedShards === 0 && missing === 0 ? 0 : 1);
