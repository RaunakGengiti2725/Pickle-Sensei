// Memory probe for the edge function's per-isolate L1 caches, exercised
// through `GET /v1/training-plans/current` with N distinct users and NO
// Upstash configured (so every cache/rate-limit structure lives in this
// isolate). Run with --expose-gc so the heap numbers are post-collection:
//
//   deno run -A --no-check --v8-flags=--expose-gc --config deno.json \
//     stress_training_plans_current_memory_probe.ts --users 20000 --seed 1
//
// Prints one JSON report line last (the stress test parses it) and writes it
// to the artifact directory. Exit 1 when any request is not a 200.
//
// The fake Auth is stateless (any Supabase-shaped bearer is a valid user) so
// the harness itself holds no per-user state — the heap delta is the
// function's own L1 auth cache (bounded at 5000 entries) plus its in-memory
// rate-limit windows (bounded at 20000 entries).

import {
  envInt,
  loadStressHarness,
  Prng,
  seedFor,
  writeArtifact,
} from "./stress_training_plans_current_harness.ts";

const L1_MAX_ENTRIES = 5_000;

function argInt(name: string, fallback: number): number {
  const index = Deno.args.indexOf(name);
  if (index === -1) return fallback;
  const n = Number(Deno.args[index + 1]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

const users = argInt("--users", envInt("STRESS_USERS", 2000));
const seed = argInt(
  "--seed",
  seedFor(envInt("STRESS_SEED", 20260905), "memory-probe", 0),
);

const gc = (globalThis as { gc?: () => void }).gc;
function heapMB(): { heapUsedMB: number; rssMB: number; gc: boolean } {
  gc?.();
  const m = Deno.memoryUsage();
  return {
    heapUsedMB: Math.round((m.heapUsed / 1_048_576) * 100) / 100,
    rssMB: Math.round((m.rss / 1_048_576) * 100) / 100,
    gc: typeof gc === "function",
  };
}

const h = await loadStressHarness({ redis: false });
Deno.env.set("AUTH_UPSTREAM_TIMEOUT_MS", "1500");
h.statelessAuth = true;
const prng = new Prng(seed);

// Warm the isolate once so module-level allocations are not counted as growth.
await h.run(
  h.request({ token: h.forgedToken(prng.uuid(), 3600), ip: prng.ip() }),
);
h.calls = [];
h.accessLog = [];

const samples: Array<{ users: number; heapUsedMB: number; rssMB: number }> = [];
const baseline = heapMB();
samples.push({ users: 0, ...baseline });

const statuses: Record<string, number> = {};
const latencies: number[] = [];
const checkpoints = new Set([0, 999, 4_999, 9_999, users - 1]);
const tokens: Record<number, string> = {};
const every = Math.max(1, Math.floor(users / 10));
for (let start = 0; start < users; start += 64) {
  const batch = Math.min(64, users - start);
  const results = await Promise.all(
    Array.from({ length: batch }, (_, k) => {
      const token = h.forgedToken(prng.uuid(), 3600);
      if (checkpoints.has(start + k)) tokens[start + k] = token;
      return h.run(h.request({ token, ip: prng.ip() }));
    }),
  );
  for (const r of results) {
    statuses[String(r.status)] = (statuses[String(r.status)] ?? 0) + 1;
    latencies.push(r.durationMs);
  }
  // Drop the harness's own per-request bookkeeping so it never inflates the delta.
  h.calls = [];
  h.accessLog = [];
  h.operatorLog = [];
  const done = start + batch;
  if (done % every === 0 || done === users) {
    const m = heapMB();
    samples.push({ users: done, heapUsedMB: m.heapUsedMB, rssMB: m.rssMB });
  }
}

const final = heapMB();
h.calls = [];
const revisit: Record<string, { status: number; supabase: number }> = {};
for (const [index, token] of Object.entries(tokens)) {
  const r = await h.run(h.request({ token, ip: prng.ip() }));
  revisit[index] = { status: r.status, supabase: r.calls.supabase };
}
const oldest = revisit["0"];
const newest = revisit[String(users - 1)];
const sortedLatency = [...latencies].sort((a, b) => a - b);
const pct = (q: number) =>
  sortedLatency[
    Math.min(
      sortedLatency.length - 1,
      Math.max(0, Math.ceil(q * sortedLatency.length) - 1),
    )
  ] ?? 0;

const report = {
  mode: "memory-only (no Upstash)",
  seed,
  distinctUsers: users,
  gcExposed: baseline.gc,
  statuses,
  heapSamples: samples,
  heapGrowthMBAfterGc:
    Math.round((final.heapUsedMB - baseline.heapUsedMB) * 100) / 100,
  rssGrowthMB: Math.round((final.rssMB - baseline.rssMB) * 100) / 100,
  bytesPerUserUpperBound: Math.round(
    ((final.heapUsedMB - baseline.heapUsedMB) * 1_048_576) /
      Math.min(users, L1_MAX_ENTRIES),
  ),
  latencyMs: {
    p50: pct(0.5),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sortedLatency[sortedLatency.length - 1] ?? 0,
  },
  l1MaxEntries: L1_MAX_ENTRIES,
  revisit: { oldestUser: oldest, newestUser: newest, byIndex: revisit },
  // Beyond the L1 cap the oldest entry must have been evicted: revisiting it
  // costs one GoTrue round trip; the newest is still cached (zero).
  l1EvictionObserved: users > L1_MAX_ENTRIES
    ? oldest.supabase === 1
    : oldest.supabase === 0,
};

await writeArtifact("memory_probe_memory_only.json", report);
console.log(JSON.stringify(report));
const ok = Object.keys(statuses).length === 1 && statuses["200"] === users &&
  newest.supabase === 0;
Deno.exit(ok ? 0 : 1);
