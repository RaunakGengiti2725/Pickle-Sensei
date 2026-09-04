/**
 * Campaign driver: runs STRESS_ITER seeded interleavings against the
 * disposable Postgres at STRESS_PG_URL and writes a JSON results table
 * (seed → outcome) plus a failures file.
 *
 *   STRESS_PG_URL   required   postgres://postgres:pg@127.0.0.1:5499/postgres
 *   STRESS_ITER     default 20 iterations (interleavings) to run
 *   STRESS_SEED     default 20260906 base seed; iteration i uses mix32(seed, i)
 *   STRESS_REPLAY   run ONLY iteration i of the campaign (exact replay)
 *   STRESS_ONLY     scenario name or prefix (e.g. "A" or "F_cross_user_same_shot_id")
 *   STRESS_LANES    default 10 max lanes per burst
 *   STRESS_TIMEOUT_MS default 20000 per-iteration deadline (deadlock bound)
 *   STRESS_RERUN_FAILED default 10 re-runs per failing seed (flake rate)
 *   STRESS_SERIALIZABLE_PCT default 0 — percent of lanes run under SERIALIZABLE.
 *                   Hosted PostgREST runs RPCs under READ COMMITTED, so the
 *                   default models production; set e.g. 25 to probe the
 *                   SERIALIZABLE snapshot behaviour of the same RPC.
 *   STRESS_OUT_DIR  default ./out
 */
import postgres from "postgres";
import {
  burst,
  envInt,
  histogram,
  type Invariant,
  mix32,
  Prng,
  snapshotUser,
  stdout,
  type Sql,
  type UserSnapshot,
} from "./harness.ts";
import { genericChecks, type Knobs, pickScenario } from "./scenarios.ts";

export interface IterationRecord {
  iter: number;
  seed: number;
  scenario: string;
  params: Record<string, unknown>;
  lanes: number;
  wallMs: number;
  timedOut: boolean;
  laneResults: unknown[];
  histogram: Record<string, number>;
  invariants: Invariant[];
  failed: string[];
  observations: Record<string, unknown>;
  setupError?: string;
  replay: string;
}

export interface CampaignConfig {
  pgUrl: string;
  iterations: number;
  baseSeed: number;
  replay?: number;
  only?: string;
  knobs: Knobs;
  timeoutMs: number;
  rerunFailed: number;
  outDir: string;
}

export function configFromEnv(): CampaignConfig {
  const pgUrl = Deno.env.get("STRESS_PG_URL") ?? "";
  const replayRaw = Deno.env.get("STRESS_REPLAY");
  return {
    pgUrl,
    iterations: envInt("STRESS_ITER", 20),
    baseSeed: envInt("STRESS_SEED", 20260906),
    replay: replayRaw ? Number(replayRaw) : undefined,
    only: Deno.env.get("STRESS_ONLY") || undefined,
    knobs: {
      lanesMax: envInt("STRESS_LANES", 10),
      holdMaxMs: envInt("STRESS_HOLD_MS", 30),
      preDelayMaxMs: envInt("STRESS_PREDELAY_MS", 6),
      rollbackP: 0.15,
      cancelP: 0.08,
      serializableP: envInt("STRESS_SERIALIZABLE_PCT", 0) / 100,
    },
    timeoutMs: envInt("STRESS_TIMEOUT_MS", 20_000),
    rerunFailed: envInt("STRESS_RERUN_FAILED", 10),
    outDir: Deno.env.get("STRESS_OUT_DIR") ?? new URL("./out/", import.meta.url).pathname,
  };
}

export function replayCommand(cfg: CampaignConfig, iter: number): string {
  const only = cfg.only ? ` STRESS_ONLY=${cfg.only}` : "";
  return `STRESS_PG_URL=<url> STRESS_SEED=${cfg.baseSeed} STRESS_LANES=${cfg.knobs.lanesMax} STRESS_SERIALIZABLE_PCT=${Math.round(
    cfg.knobs.serializableP * 100,
  )} STRESS_REPLAY=${iter}${only} deno task campaign  (in supabase/tests/stress)`;
}

export async function runIteration(
  sql: Sql,
  cfg: CampaignConfig,
  iter: number,
): Promise<IterationRecord> {
  const seed = mix32(cfg.baseSeed, iter);
  const prng = new Prng(seed);
  const scenario = pickScenario(prng, cfg.only);
  const rec: IterationRecord = {
    iter,
    seed,
    scenario: scenario.name,
    params: {},
    lanes: 0,
    wallMs: 0,
    timedOut: false,
    laneResults: [],
    histogram: {},
    invariants: [],
    failed: [],
    observations: {},
    replay: replayCommand(cfg, iter),
  };
  let built;
  try {
    built = await scenario.run(sql, prng, cfg.knobs);
  } catch (e) {
    rec.setupError = String((e as Error)?.stack ?? e);
    rec.failed = ["setup: " + String((e as Error)?.message ?? e)];
    return rec;
  }
  rec.params = built.params;
  rec.lanes = built.lanes.length;
  const out = await burst(sql, built.lanes, cfg.timeoutMs);
  rec.wallMs = out.wallMs;
  rec.timedOut = out.timedOut;
  rec.laneResults = out.results;
  rec.histogram = histogram(
    out.results.map((r) => `${r.op}:${r.result}${r.committed ? "" : "(rolled back)"}`),
  );
  const snaps = new Map<string, UserSnapshot>();
  for (const u of built.users) snaps.set(u.id, await snapshotUser(sql, u));
  try {
    await genericChecks(
      sql,
      built,
      out.results,
      snaps,
      out.wallMs,
      out.timedOut,
      cfg.timeoutMs,
      rec.invariants,
    );
    await built.check({
      sql,
      results: out.results,
      snaps,
      invariants: rec.invariants,
      observations: rec.observations,
    });
  } catch (e) {
    rec.invariants.push({
      name: "check threw",
      holds: false,
      detail: String((e as Error)?.stack ?? e),
    });
  }
  rec.observations.snapshots = Object.fromEntries(snaps);
  rec.failed = rec.invariants.filter((i) => !i.holds).map((i) => `${i.name} :: ${i.detail}`);
  return rec;
}

export interface CampaignSummary {
  baseSeed: number;
  config: Omit<CampaignConfig, "pgUrl">;
  executed: number;
  passed: number;
  failed: number;
  setupErrors: number;
  wallMs: number;
  byScenario: Record<
    string,
    { executed: number; failed: number; lanes: number; maxWallMs: number }
  >;
  laneOutcomeHistogram: Record<string, number>;
  invariantHistogram: Record<string, { checked: number; held: number }>;
  failedSeeds: Array<{
    iter: number;
    seed: number;
    scenario: string;
    failed: string[];
    replay: string;
  }>;
  flakeRates: Array<{
    iter: number;
    seed: number;
    reruns: number;
    failures: number;
    rate: number;
  }>;
  pgVersion: string;
}

export async function runCampaign(
  cfg: CampaignConfig,
  log: (s: string) => void = stdout,
): Promise<{ summary: CampaignSummary; records: IterationRecord[] }> {
  if (!cfg.pgUrl) {
    throw new Error("STRESS_PG_URL is required (see ./stress_pg_up.sh)");
  }
  const sql = postgres(cfg.pgUrl, {
    max: cfg.knobs.lanesMax + 8,
    idle_timeout: 20,
    connect_timeout: 30,
    onnotice: () => {},
  });
  const t0 = performance.now();
  const records: IterationRecord[] = [];
  const pgVersion = String((await sql.unsafe(`select version() as v`))[0].v);
  const iters =
    cfg.replay !== undefined ? [cfg.replay] : Array.from({ length: cfg.iterations }, (_, i) => i);
  try {
    for (const iter of iters) {
      const rec = await runIteration(sql, cfg, iter);
      records.push(rec);
      const status = rec.failed.length === 0 ? "ok  " : "FAIL";
      log(
        `[${status}] iter=${iter} seed=${rec.seed} ${rec.scenario} lanes=${rec.lanes} wall=${rec.wallMs}ms ${JSON.stringify(
          rec.histogram,
        )}`,
      );
      for (const f of rec.failed) log(`       ✗ ${f}`);
    }
    const failedRecs = records.filter((r) => r.failed.length > 0);
    const flakeRates: CampaignSummary["flakeRates"] = [];
    if (cfg.rerunFailed > 0 && cfg.replay === undefined) {
      for (const rec of failedRecs.slice(0, 8)) {
        let failures = 0;
        for (let i = 0; i < cfg.rerunFailed; i++) {
          const again = await runIteration(sql, cfg, rec.iter);
          if (again.failed.length > 0) failures += 1;
        }
        flakeRates.push({
          iter: rec.iter,
          seed: rec.seed,
          reruns: cfg.rerunFailed,
          failures,
          rate: failures / cfg.rerunFailed,
        });
        log(`[rerun] iter=${rec.iter} seed=${rec.seed} failed ${failures}/${cfg.rerunFailed}`);
      }
    }
    const byScenario: CampaignSummary["byScenario"] = {};
    const laneOutcomes: string[] = [];
    const invHist: CampaignSummary["invariantHistogram"] = {};
    for (const r of records) {
      const b = (byScenario[r.scenario] ??= {
        executed: 0,
        failed: 0,
        lanes: 0,
        maxWallMs: 0,
      });
      b.executed += 1;
      b.lanes += r.lanes;
      b.maxWallMs = Math.max(b.maxWallMs, r.wallMs);
      if (r.failed.length > 0) b.failed += 1;
      for (const [k, v] of Object.entries(r.histogram)) {
        for (let i = 0; i < v; i++) {
          laneOutcomes.push(k);
        }
      }
      for (const inv of r.invariants) {
        const key = inv.name.replace(/[0-9a-f]{8}/g, "<uid>");
        const h = (invHist[key] ??= { checked: 0, held: 0 });
        h.checked += 1;
        if (inv.holds) h.held += 1;
      }
    }
    const summary: CampaignSummary = {
      baseSeed: cfg.baseSeed,
      config: { ...cfg, pgUrl: undefined } as unknown as Omit<CampaignConfig, "pgUrl">,
      executed: records.length,
      passed: records.length - failedRecs.length,
      failed: failedRecs.length,
      setupErrors: records.filter((r) => r.setupError).length,
      wallMs: Math.round(performance.now() - t0),
      byScenario,
      laneOutcomeHistogram: histogram(laneOutcomes),
      invariantHistogram: invHist,
      failedSeeds: failedRecs.map((r) => ({
        iter: r.iter,
        seed: r.seed,
        scenario: r.scenario,
        failed: r.failed,
        replay: r.replay,
      })),
      flakeRates,
      pgVersion,
    };
    delete (summary.config as Record<string, unknown>).pgUrl;
    await Deno.mkdir(cfg.outDir, { recursive: true });
    await Deno.writeTextFile(`${cfg.outDir}/summary.json`, JSON.stringify(summary, null, 2));
    await Deno.writeTextFile(`${cfg.outDir}/results.json`, JSON.stringify(records, null, 1));
    await Deno.writeTextFile(
      `${cfg.outDir}/failures.json`,
      JSON.stringify(
        records.filter((r) => r.failed.length > 0),
        null,
        2,
      ),
    );
    log(
      `campaign: executed=${summary.executed} passed=${summary.passed} failed=${summary.failed} wall=${summary.wallMs}ms → ${cfg.outDir}`,
    );
    return { summary, records };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (import.meta.main) {
  const cfg = configFromEnv();
  const { summary } = await runCampaign(cfg);
  Deno.exit(summary.failed === 0 && summary.setupErrors === 0 ? 0 : 1);
}
