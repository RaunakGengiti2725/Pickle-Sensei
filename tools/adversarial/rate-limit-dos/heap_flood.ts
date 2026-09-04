// Adversarial measurement: memory growth of the edge function's L1 rate-limit
// window map (`rateLimit.ts` `windows`) and of the L1 cache (`cache.ts`
// `memory`) under a flood of DISTINCT keys, at the scale a single abusive
// client can reach.
//
// Why this is reachable: the limiter's `id` for every pre-auth scope is
// `clientIp(request)` (`http.ts:57-65`), which is taken verbatim from the
// `cf-connecting-ip` / `x-forwarded-for` request headers with NO syntax and
// NO length validation. One client can therefore choose both the NUMBER of
// distinct keys and the SIZE of each key.
//
//   deno run -A --v8-flags=--expose-gc tools/adversarial/rate-limit-dos/heap_flood.ts
//
// Writes a JSON table to --out (default artifacts/xc-rate-limit-dos/heap_flood.json).
// Deterministic: keys are generated from a fixed seed, printed in the report.

import {
  configureRedis,
  loadIsolate,
} from "../../../supabase/functions/api/__wf__/harness.ts";

const SEED = 0x5eed_1337;
const OUT =
  (Deno.args.includes("--out")
    ? Deno.args[Deno.args.indexOf("--out") + 1]
    : null) ??
    "artifacts/xc-rate-limit-dos/heap_flood.json";

/** Deterministic 32-bit LCG so every reported failure is replayable. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function gc(): void {
  const maybe = (globalThis as { gc?: () => void }).gc;
  if (maybe) {
    maybe();
    maybe();
  }
}

function heapUsedBytes(): number {
  gc();
  return Deno.memoryUsage().heapUsed;
}

const MB = 1024 * 1024;
const mb = (bytes: number) => Number((bytes / MB).toFixed(2));

interface Scenario {
  name: string;
  keys: number;
  /** Length in bytes of each attacker-chosen `id` (the header value). */
  idBytes: number;
  scope: string;
  limit: number;
  windowSeconds: number;
}

interface Result extends Scenario {
  heapBeforeMb: number;
  /** Heap (after GC) with the map full: 19 999 live windows, just before the
   * 20 000th distinct key triggers the sweep/clear. This is the steady state
   * an attacker can HOLD by pacing distinct keys to the map cap. */
  heapAtCapMb: number;
  heapRetainedAtCapMb: number;
  heapAfterFloodMb: number;
  heapPeakMb: number;
  heapGrowthMb: number;
  bytesPerKeyRetained: number;
  wallMs: number;
  keysPerSecond: number;
  /** Canary: a client that was ALREADY rate-limited before the flood. */
  canaryDeniedBeforeFlood: boolean;
  canaryAllowedAfterFlood: boolean;
  canaryRemainingAfterFlood: number;
  /** How many flood keys it took for the canary's window to be wiped. */
  floodKeysUntilCanaryReset: number | null;
  canaryResetsObserved: number;
}

async function runScenario(scenario: Scenario): Promise<Result> {
  configureRedis(false); // no Upstash secrets → the documented per-isolate memory path
  const iso = await loadIsolate();
  const rnd = lcg(SEED);
  const filler = "A".repeat(Math.max(0, scenario.idBytes - 24));

  // Canary: exhaust a victim's budget so it is DENIED before the flood.
  const canary = "203.0.113.7";
  for (let i = 0; i < 3; i += 1) {
    await iso.rateLimit.enforceRateLimit(
      scenario.scope,
      canary,
      3,
      scenario.windowSeconds,
    );
  }
  const deniedBefore = !(
    await iso.rateLimit.peekRateLimit(
      scenario.scope,
      canary,
      3,
      scenario.windowSeconds,
    )
  ).allowed;

  const heapBefore = heapUsedBytes();
  let heapPeak = heapBefore;
  let heapAtCap = heapBefore;
  let firstReset: number | null = null;
  let resets = 0;
  const startedAt = performance.now();

  for (let i = 0; i < scenario.keys; i += 1) {
    const id = `${(rnd() % 4294967295).toString(16)}-${i}-${filler}`;
    await iso.rateLimit.enforceRateLimit(
      scenario.scope,
      id,
      scenario.limit,
      scenario.windowSeconds,
    );
    if (i + 1 === 19_999) heapAtCap = heapUsedBytes();
    if ((i + 1) % 2_000 === 0) {
      const peek = await iso.rateLimit.peekRateLimit(
        scenario.scope,
        canary,
        3,
        scenario.windowSeconds,
      );
      if (peek.allowed) {
        if (firstReset === null) firstReset = i + 1;
        // Re-arm the canary so further wipes are observable.
        for (let k = 0; k < 3; k += 1) {
          await iso.rateLimit.enforceRateLimit(
            scenario.scope,
            canary,
            3,
            scenario.windowSeconds,
          );
        }
        resets += 1;
      }
      const used = Deno.memoryUsage().heapUsed;
      if (used > heapPeak) heapPeak = used;
    }
  }

  const wallMs = performance.now() - startedAt;
  const heapAfter = heapUsedBytes();
  if (heapAfter > heapPeak) heapPeak = heapAfter;
  const after = await iso.rateLimit.peekRateLimit(
    scenario.scope,
    canary,
    3,
    scenario.windowSeconds,
  );

  return {
    ...scenario,
    heapBeforeMb: mb(heapBefore),
    heapAtCapMb: mb(heapAtCap),
    heapRetainedAtCapMb: mb(heapAtCap - heapBefore),
    heapAfterFloodMb: mb(heapAfter),
    heapPeakMb: mb(heapPeak),
    heapGrowthMb: mb(heapAfter - heapBefore),
    bytesPerKeyRetained: Math.round((heapAtCap - heapBefore) / 19_999),
    wallMs: Math.round(wallMs),
    keysPerSecond: Math.round(scenario.keys / (wallMs / 1_000)),
    canaryDeniedBeforeFlood: deniedBefore,
    canaryAllowedAfterFlood: after.allowed,
    canaryRemainingAfterFlood: after.remaining,
    floodKeysUntilCanaryReset: firstReset,
    canaryResetsObserved: resets,
  };
}

/** L1 cache (cache.ts) under the same flood, for comparison: it evicts the
 * oldest third instead of clearing, and is capped at MEMORY_MAX_ENTRIES. */
async function runCacheFlood(keys: number, valueBytes: number) {
  configureRedis(false);
  const iso = await loadIsolate();
  const value = "V".repeat(valueBytes);
  const heapBefore = heapUsedBytes();
  const startedAt = performance.now();
  await iso.cache.cacheSet("auth:canary", "canary-session", 600);
  for (let i = 0; i < keys; i += 1) {
    await iso.cache.cacheSet(`auth:flood-${i}`, value, 600);
  }
  const wallMs = performance.now() - startedAt;
  const heapAfter = heapUsedBytes();
  const canary = await iso.cache.cacheGet("auth:canary");
  return {
    name: "cache.ts L1 flood",
    keys,
    valueBytes,
    heapBeforeMb: mb(heapBefore),
    heapAfterFloodMb: mb(heapAfter),
    heapGrowthMb: mb(heapAfter - heapBefore),
    wallMs: Math.round(wallMs),
    canarySurvived: canary !== null,
  };
}

const scenarios: Scenario[] = [
  {
    name: "100k distinct short ids (IPv4-shaped)",
    keys: 100_000,
    idBytes: 24,
    scope: "ip",
    limit: 1_200,
    windowSeconds: 60,
  },
  {
    name: "100k distinct 1 KiB ids (oversized cf-connecting-ip)",
    keys: 100_000,
    idBytes: 1_024,
    scope: "ip",
    limit: 1_200,
    windowSeconds: 60,
  },
  {
    name: "100k distinct 8 KiB ids (header-cap-sized)",
    keys: 100_000,
    idBytes: 8_192,
    scope: "ip",
    limit: 1_200,
    windowSeconds: 60,
  },
  {
    name: "25k distinct 32 KiB ids (largest identity the handler accepts)",
    keys: 25_000,
    idBytes: 32_768,
    scope: "ip",
    limit: 1_200,
    windowSeconds: 60,
  },
  {
    name: "100k distinct short ids on the auth-failure scope (300 s window)",
    keys: 100_000,
    idBytes: 24,
    scope: "authfail",
    limit: 30,
    windowSeconds: 300,
  },
];

const results: Result[] = [];
for (const scenario of scenarios) {
  const result = await runScenario(scenario);
  results.push(result);
  console.log(
    `${result.name}: heap ${result.heapBeforeMb} → at-cap ${result.heapAtCapMb} ` +
      `(retained +${result.heapRetainedAtCapMb} MiB, ${result.bytesPerKeyRetained} B/key) → ` +
      `after ${result.heapAfterFloodMb} MiB (peak ${result.heapPeakMb}), ` +
      `${result.keysPerSecond} keys/s, canary reset after ${result.floodKeysUntilCanaryReset} keys, ` +
      `${result.canaryResetsObserved} wipes`,
  );
}

const cacheFlood = await runCacheFlood(100_000, 1_024);
console.log(
  `${cacheFlood.name}: heap ${cacheFlood.heapBeforeMb} → ${cacheFlood.heapAfterFloodMb} MiB ` +
    `(+${cacheFlood.heapGrowthMb}), canary survived: ${cacheFlood.canarySurvived}`,
);

const report = {
  harness: "tools/adversarial/rate-limit-dos/heap_flood.ts",
  seed: SEED,
  deno: Deno.version.deno,
  v8: Deno.version.v8,
  measuredAt: new Date().toISOString(),
  notes: [
    "rateLimit.ts MEMORY_WINDOW_MAX = 20000; on overflow with nothing expired it calls windows.clear()",
    "cache.ts MEMORY_MAX_ENTRIES = 5000; on overflow it drops the oldest third (insertion order)",
    "clientIp() (http.ts:57-65) applies no syntax or length validation to the header value",
  ],
  rateLimitWindows: results,
  cacheL1: cacheFlood,
};
await Deno.mkdir(new URL(".", `file://${Deno.cwd()}/${OUT}`), {
  recursive: true,
}).catch(() => {});
await Deno.writeTextFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`wrote ${OUT}`);
