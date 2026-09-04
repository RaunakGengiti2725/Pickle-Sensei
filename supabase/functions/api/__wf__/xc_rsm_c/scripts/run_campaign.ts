// CLI: run the seeded randomized state-machine campaign and write raw evidence.
//
//   cd supabase/functions/api/__wf__
//   deno run -A --no-check --config deno.json xc_rsm_c/scripts/run_campaign.ts \
//     --seeds 3000-3099 --out ../../../../artifacts/xc-rsm-c/<run>
//
// Options:
//   --seeds <list>        e.g. 3000-3099 or 3017,3042   (default 3000-3099)
//   --min-requests <n>    minimum requests per seed      (default 2000)
//   --out <dir>           artifact directory              (default artifacts/xc-rsm-c/<timestamp>)
//   --focus <idx>         with a single seed: print every record around idx
//   --access-log-seed <s> keep the full edge access log for this seed (default: first seed)
//
// Exit code: 0 when no hard invariant failed, 1 otherwise.

import { aggregate, groupFailures, parseSeeds, runSeed } from "../runner.ts";
import type { Failure, SeedResult } from "../campaign.ts";

type Flag = "seeds" | "out" | "min-requests" | "focus" | "access-log-seed";

function parseFlags(argv: string[]): Record<Flag, string | undefined> {
  const flags: Record<Flag, string | undefined> = {
    seeds: "3000-3099",
    out: undefined,
    "min-requests": "2000",
    focus: undefined,
    "access-log-seed": undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const match = argv[i].match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!match) throw new Error(`unexpected argument: ${argv[i]}`);
    const name = match[1];
    if (!(name in flags)) throw new Error(`unknown flag: --${name}`);
    const value = match[2] ?? argv[++i];
    if (value === undefined) throw new Error(`--${name} needs a value`);
    flags[name as Flag] = value;
  }
  return flags;
}

const args = parseFlags(Deno.args);

const seeds = parseSeeds(args.seeds ?? "3000-3099");
const minRequests = Number(args["min-requests"]);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir =
  args.out ?? new URL(`../../../../../../artifacts/xc-rsm-c/${stamp}/`, import.meta.url).pathname;
await Deno.mkdir(outDir, { recursive: true });
const accessLogSeed = args["access-log-seed"] ? Number(args["access-log-seed"]) : seeds[0];
const focus = args.focus ? Number(args.focus) : null;

const logPath = `${outDir}/campaign.log`;
const logFile = await Deno.open(logPath, { create: true, write: true, truncate: true });
const encoder = new TextEncoder();
const log = async (line: string): Promise<void> => {
  const stamped = `${new Date().toISOString()} ${line}`;
  console.error(stamped);
  await logFile.write(encoder.encode(`${stamped}\n`));
};

await log(
  `campaign start seeds=${args.seeds} (${seeds.length}) minRequests=${minRequests} out=${outDir}`,
);
await log(`deno ${Deno.version.deno} v8 ${Deno.version.v8} ${Deno.build.os}/${Deno.build.arch}`);

const results: SeedResult[] = [];
const failuresFile = await Deno.open(`${outDir}/failures.jsonl`, {
  create: true,
  write: true,
  truncate: true,
});
const seedsFile = await Deno.open(`${outDir}/seeds.jsonl`, {
  create: true,
  write: true,
  truncate: true,
});
const heapRows: Array<{
  seed: number;
  requests: number;
  wallMs: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  redisKeys: number;
}> = [];

let accessLogFile: Deno.FsFile | null = null;

for (const seed of seeds) {
  let accessSink: ((line: string) => void) | undefined;
  if (seed === accessLogSeed) {
    accessLogFile = await Deno.open(`${outDir}/edge-access.${seed}.log`, {
      create: true,
      write: true,
      truncate: true,
    });
    const file = accessLogFile;
    accessSink = (line) => {
      file.writeSync(encoder.encode(`${line}\n`));
    };
  }
  const result = await runSeed(
    seed,
    { minRequests },
    {
      accessLogSink: accessSink,
      onRecord: (run) => {
        if (focus === null || seeds.length !== 1) return;
        const around = run.records.filter((r) => Math.abs(r.spec.idx - focus) <= 8);
        for (const r of around) {
          const { token: _t, refreshToken: _r, ...spec } = r.spec;
          console.error(
            JSON.stringify({
              marker: r.spec.idx === focus ? ">>>" : "   ",
              spec,
              launchedAtMs: r.launchedAtMs,
              completedAtMs: r.completedAtMs,
              events: [r.launchEvent, r.completeEvent],
              truth: r.truthAtLaunch,
              revokedConfirmedAtLaunch: r.revokedConfirmedAtLaunch,
              outcome: r.outcome,
              expected: r.expected
                ? {
                    status: r.expected.status,
                    reason: r.expected.reason,
                    fromCache: r.expected.fromCache,
                  }
                : null,
              violations: r.violations,
            }),
          );
        }
      },
    },
  );
  if (accessLogFile) {
    accessLogFile.close();
    accessLogFile = null;
  }
  results.push(result);
  const { failures, ...row } = result;
  await seedsFile.write(encoder.encode(`${JSON.stringify(row)}\n`));
  for (const f of failures) await failuresFile.write(encoder.encode(`${JSON.stringify(f)}\n`));
  heapRows.push({
    seed,
    requests: result.requests,
    wallMs: result.wallMs,
    rss: result.heap.rss,
    heapUsed: result.heap.heapUsed,
    heapTotal: result.heap.heapTotal,
    external: result.heap.external,
    redisKeys: result.redisKeys,
  });
  await log(
    `seed ${seed}: ${result.requests} req (A=${result.perPhase.A} B=${result.perPhase.B} C=${result.perPhase.C}) ` +
      `statuses=${JSON.stringify(result.statusCounts)} hard=${result.hardFailures} soft=${result.softFailures} ` +
      `violations=${JSON.stringify(result.invariantViolations)} cacheHits(A)=${result.cacheHitsPredicted} ` +
      `clock+${Math.round(result.clock.forwardMs / 1000)}s back=${result.clock.backwardJumps} ` +
      `heapUsed=${(result.heap.heapUsed / 1048576).toFixed(1)}MiB rss=${(result.heap.rss / 1048576).toFixed(1)}MiB ${result.wallMs}ms`,
  );
}
failuresFile.close();
seedsFile.close();

const agg = aggregate(results);
const allFailures: Failure[] = results.flatMap((r) => r.failures);
const groups = groupFailures(allFailures);

await Deno.writeTextFile(
  `${outDir}/summary.json`,
  JSON.stringify(
    {
      seeds: args.seeds,
      minRequests,
      outDir,
      aggregate: agg,
      failureGroups: groups.map(({ example, ...g }) => ({
        ...g,
        exampleIdx: example.idx,
        exampleSeed: example.seed,
        exampleDetail: example.detail,
        replay: example.replay,
      })),
    },
    null,
    2,
  ),
);
await Deno.writeTextFile(
  `${outDir}/seeds.json`,
  JSON.stringify(
    results.map(({ failures: _f, ...r }) => r),
    null,
    2,
  ),
);
await Deno.writeTextFile(`${outDir}/heap.json`, JSON.stringify(heapRows, null, 2));
await Deno.writeTextFile(
  `${outDir}/matrices.json`,
  JSON.stringify(
    {
      truthStatusMatrix: agg.truthStatusMatrix,
      bearerKindStatusMatrix: agg.bearerKindStatusMatrix,
      reasonStatusMatrix: agg.reasonStatusMatrix,
      upstreamFaultMatrix: agg.upstreamFaultMatrix,
      upstreamCalls: agg.upstreamCalls,
    },
    null,
    2,
  ),
);
await Deno.writeTextFile(`${outDir}/failure-groups.json`, JSON.stringify(groups, null, 2));

await log(
  `TOTAL ${agg.requests} requests over ${agg.seeds} seeds; statuses=${JSON.stringify(agg.statusCounts)}`,
);
await log(
  `invariant violations: ${JSON.stringify(agg.invariantViolations)} hard=${agg.hardFailures} soft=${agg.softFailures}`,
);
await log(
  `seeds with hard failures: ${agg.seedsWithHardFailures.length}/${agg.seeds} → ${agg.seedsWithHardFailures.join(",")}`,
);
for (const g of groups) {
  await log(
    `  [${g.soft ? "soft" : "HARD"}] ${g.invariant} ${g.pattern} ×${g.count} in ${g.seeds.length} seeds; e.g. seed ${g.example.seed} idx ${g.example.idx}: ${g.example.detail}`,
  );
}
await log(
  `heap: heapUsed ${(agg.heap.minHeapUsed / 1048576).toFixed(1)}–${(agg.heap.maxHeapUsed / 1048576).toFixed(1)} MiB, max rss ${(agg.heap.maxRss / 1048576).toFixed(1)} MiB; wall ${Math.round(agg.wallMs / 1000)}s`,
);
await log(`artifacts: ${outDir}`);
logFile.close();
Deno.exit(agg.hardFailures > 0 ? 1 : 0);
