// Renders perf_edge_latency_bench.ts JSON outputs as Markdown tables (one
// per run) plus a cross-run route matrix, so the raw JSON stays the source of
// truth and the table is reproducible from it.
//
//   deno run -A perf_summarize.ts results/*.json > results/SUMMARY.md

import type { BenchOutput, ScenarioResult } from "./perf_edge_latency_bench.ts";

export async function writeStdout(text: string): Promise<void> {
  let bytes = new TextEncoder().encode(text);
  while (bytes.length > 0) {
    const written = await Deno.stdout.write(bytes);
    bytes = bytes.subarray(written);
  }
}

function fmtMs(value: number): string {
  return value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
}

function fmtBytes(value: number): string {
  if (value >= 1_048_576) return `${(value / 1_048_576).toFixed(2)} MiB`;
  if (value >= 1_024) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${value} B`;
}

function statusCell(scenario: ScenarioResult): string {
  return Object.entries(scenario.statuses)
    .map(([status, count]) => `${status}×${count}`)
    .join(" ");
}

function runTitle(run: BenchOutput): string {
  return `redis=${run.meta.redis ? "on" : "off"} latency=${run.meta.latencyMode}`;
}

function renderRun(run: BenchOutput): string {
  const lines: string[] = [];
  const m = run.meta;
  lines.push(`## ${runTitle(run)}`);
  lines.push("");
  lines.push(
    `seed \`${m.seed}\` · ${m.requestsPerScenario} req/scenario (heavy: ${m.heavyRequestsPerScenario}) · ` +
      `concurrency ${m.concurrency} · deno ${m.deno} / v8 ${m.v8} · ` +
      `${m.startedAt} · ${(m.durationMs / 1000).toFixed(1)}s`,
  );
  lines.push("");
  lines.push(
    `Injected upstream latency (ms, SIMULATED, not a measurement of the hosted platform): ` +
      `auth ${m.latencyMs.supabase_auth} · rest ${m.latencyMs.supabase_rest} · redis ${m.latencyMs.redis} · ` +
      `revenuecat ${m.latencyMs.revenuecat}`,
  );
  lines.push("");
  lines.push(
    "| scenario | route | status | p50 ms | p95 ms | p99 ms | hot RT p50 | hot p95 | auth | rest | rc | redis | other | req bytes p50 | res bytes p50 | upstream res p50 | Δheap | fails | >3 |",
  );
  lines.push(
    "|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|:-:|",
  );
  for (const s of run.scenarios) {
    const c = s.roundTrips.byClass;
    lines.push(
      `| ${s.id} | \`${s.route}\` | ${statusCell(s)} | ${fmtMs(s.latencyMs.p50)} | ${fmtMs(s.latencyMs.p95)} | ` +
        `${fmtMs(s.latencyMs.p99)} | ${s.roundTrips.hot.p50} | ${s.roundTrips.hot.p95} | ` +
        `${c.supabase_auth.p50} | ${c.supabase_rest.p50} | ${c.revenuecat.p50} | ${c.redis.p50} | ${c.other.p50} | ` +
        `${fmtBytes(s.bytes.request.p50)} | ${fmtBytes(s.bytes.response.p50)} | ` +
        `${fmtBytes(s.bytes.upstreamResponse.p50)} | ${fmtBytes(s.heap.deltaHeapUsed)} | ${s.failureCount} | ` +
        `${s.exceedsThreshold ? "**YES**" : s.hotPath ? "no" : "n/a"} |`,
    );
  }
  lines.push("");
  const failing = run.scenarios.filter((s) => s.failureCount > 0);
  if (failing.length > 0) {
    lines.push("### Unexpected statuses (replay records in the JSON `failures[]`)");
    lines.push("");
    for (const s of failing) {
      lines.push(
        `- ${s.id}: ${s.failureCount} unexpected; first: ${JSON.stringify(s.failures[0])}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function renderMatrix(runs: BenchOutput[]): string {
  const ids = new Map<string, ScenarioResult>();
  for (const run of runs) for (const s of run.scenarios) if (!ids.has(s.id)) ids.set(s.id, s);
  const lines: string[] = [];
  lines.push("## Cross-run matrix (p50 ms / p95 ms per mode; hot RT p50 from the first run)");
  lines.push("");
  lines.push(`| scenario | hot RT | ${runs.map((run) => runTitle(run)).join(" | ")} |`);
  lines.push(`|---|---:|${runs.map(() => "---:").join("|")}|`);
  for (const [id, first] of ids) {
    const cells = runs.map((run) => {
      const s = run.scenarios.find((entry) => entry.id === id);
      return s ? `${fmtMs(s.latencyMs.p50)} / ${fmtMs(s.latencyMs.p95)}` : "—";
    });
    lines.push(`| ${id} | ${first.roundTrips.hot.p50} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

function renderScaling(runs: BenchOutput[]): string {
  const families: Array<{ title: string; prefix: string }> = [
    { title: "POST /v1/shots:sync — N shots per request", prefix: "shots-sync-" },
    { title: "POST /v1/me/evaluation/trials — N trials per request", prefix: "evaluation-trials-" },
  ];
  const lines: string[] = [];
  lines.push("## N-scaling (round trips grow with batch size)");
  lines.push("");
  for (const family of families) {
    lines.push(`### ${family.title}`);
    lines.push("");
    lines.push(
      `| scenario | rest RT p50 | req bytes p50 | ${runs.map((run) => `${runTitle(run)} p50/p95 ms`).join(" | ")} |`,
    );
    lines.push(`|---|---:|---:|${runs.map(() => "---:").join("|")}|`);
    const ids = [...new Set(runs.flatMap((run) => run.scenarios.map((s) => s.id)))].filter(
      (id) => id.startsWith(family.prefix) && /\d+$/.test(id),
    );
    ids.sort((a, b) => Number(a.match(/\d+$/)![0]) - Number(b.match(/\d+$/)![0]));
    for (const id of ids) {
      const first = runs.flatMap((run) => run.scenarios).find((s) => s.id === id)!;
      const cells = runs.map((run) => {
        const s = run.scenarios.find((entry) => entry.id === id);
        return s ? `${fmtMs(s.latencyMs.p50)} / ${fmtMs(s.latencyMs.p95)}` : "—";
      });
      lines.push(
        `| ${id} | ${first.roundTrips.byClass.supabase_rest.p50} | ${fmtBytes(first.bytes.request.p50)} | ${cells.join(" | ")} |`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const runs: BenchOutput[] = [];
  for (const path of Deno.args) {
    runs.push(JSON.parse(await Deno.readTextFile(path)) as BenchOutput);
  }
  if (runs.length === 0) {
    console.error("usage: deno run -A perf_summarize.ts <bench.json> [...]");
    Deno.exit(2);
  }
  const out: string[] = [];
  out.push("# Edge Function per-route round trips & latency");
  out.push("");
  out.push(
    "Generated by `perf_summarize.ts` from `perf_edge_latency_bench.ts` outputs. " +
      "Latencies are in-process handler wall time against emulated upstreams " +
      "(zero or injected latency) — they measure the handler's own work and its " +
      "sequential round-trip chain, NOT hosted Supabase network time. " +
      '"hot RT" = Supabase Auth + PostgREST + RevenueCat calls per request; Redis is listed separately.',
  );
  out.push("");
  out.push(renderMatrix(runs));
  out.push(renderScaling(runs));
  for (const run of runs) out.push(renderRun(run));
  await writeStdout(out.join("\n") + "\n");
}
