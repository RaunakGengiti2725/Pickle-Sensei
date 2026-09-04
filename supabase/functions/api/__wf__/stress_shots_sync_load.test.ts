// stress: LOAD for POST /v1/shots:sync against the REAL handler in-process
// (Supabase Auth / PostgREST / Upstash / RevenueCat are the fakes of
// stress_shots_sync_harness.ts, answering in ~0 ms, so latency here is the
// handler's own cost and the round-trip counts are exact).
//
// Campaign 1 — request mix (STRESS_ITER iterations, default 1000):
//   premium single new shot · fresh free user's first shot (auth-cache miss)
//   · premium batch of 2..8 · replay of an accepted batch · invalid body
//   · valid+invalid batch. Every iteration records latency, HTTP status, the
//   client verdict per shot, and the upstream round trips it cost (GoTrue,
//   PostgREST SELECT, PostgREST RPC, Upstash pipelines). Asserted:
//     · every outcome is the contract's (accepted / replay-acknowledged with
//       zero RPCs / 400 validation / per-shot invalid_payload), never a 5xx;
//     · a warm single-shot sync costs ≤ 3 Supabase round trips;
//     · replays cost exactly one PostgREST round trip (the batched SELECT).
//   Recorded, not asserted (reported as findings by the campaign owner):
//     · PostgREST round trips per request grow as 1 + N for N new shots;
//     · Upstash pipelines per request.
//
// Campaign 2 — L1 memory under STRESS_USERS distinct users (default 2000;
//   the lens asks for 20 000): each user makes one request, first with Upstash
//   up, then with Upstash down (memory fallback for the auth cache and every
//   rate-limit window). Heap is sampled (gc when --v8-flags=--expose-gc) at
//   baseline, after the flood, and after the fake model is cleared so what
//   remains is the function's own per-isolate state. Also checked: a user who
//   exhausted the 30/min shots_sync budget before the flood — does the budget
//   survive 20k strangers (MEMORY_WINDOW_MAX eviction)?
//
// Results: artifacts/stress-shots-sync/latest/load.json and memory.json.
//   STRESS_SEED=<n> STRESS_ITER=<n> STRESS_USERS=<n> deno test -A --no-check \
//     --v8-flags=--expose-gc --config deno.json stress_shots_sync_load.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  buildShots,
  envInt,
  errorClass,
  grantPremium,
  loadStressHarness,
  mintUser,
  type Outcome,
  ownedShotIds,
  Prng,
  send,
  type StressHarness,
  type StressUser,
  summarize,
  syncRequest,
  type Verdict,
  verdictFor,
  writeArtifact,
} from "./stress_shots_sync_harness.ts";

const STRESS_SEED = envInt("STRESS_SEED", 20260904);
const ITER = envInt("STRESS_ITER", 1000);
const USERS = envInt("STRESS_USERS", 2000);
const SHOTS_SYNC_LIMIT = 30;

type Kind =
  | "premium_single_new"
  | "free_first_shot"
  | "premium_batch_new"
  | "replay_accepted"
  | "invalid_body"
  | "mixed_valid_invalid";

interface Row {
  i: number;
  seed: number;
  kind: Kind;
  user: string;
  shots: number;
  status: number;
  errorClass: string;
  verdicts: Verdict[];
  latencyMs: number;
  auth: number;
  select: number;
  rpc: number;
  postgrest: number;
  supabase: number;
  redis: number;
  ok: boolean;
  why: string;
}

const gc = (globalThis as { gc?: () => void }).gc;
const RESIDUAL_MAX_BYTES = 48 * 1024 * 1024;
function heap(): { heapUsed: number; rss: number; gc: boolean } {
  // two passes: the first may only schedule finalizers/weak-ref clearing
  gc?.();
  gc?.();
  const m = Deno.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, gc: gc !== undefined };
}

function uniqueIp(n: number): string {
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

function counts(h: StressHarness) {
  const auth = h.counters["auth"] ?? 0;
  const select = h.counters["rest.select"] ?? 0;
  const rpc = h.counters["rest.rpc"] ?? 0;
  const redis = h.counters["redis"] ?? 0;
  return { auth, select, rpc, redis, postgrest: select + rpc, supabase: auth + select + rpc };
}

async function measured(
  h: StressHarness,
  request: Request,
): Promise<{ outcome: Outcome } & ReturnType<typeof counts>> {
  h.resetEvidence();
  const outcome = await send(h, request);
  return { outcome, ...counts(h) };
}

Deno.test(
  `stress load: POST /v1/shots:sync — ${ITER} seeded requests, latency + round trips`,
  async () => {
    const h = await loadStressHarness({ redis: true, authTimeoutMs: 400 });
    const prng = new Prng(STRESS_SEED);

    // premium pool: 30/min per user, so size the pool for the campaign
    const poolSize = Math.max(50, Math.ceil((ITER * 0.7) / 20));
    const premium: StressUser[] = [];
    for (let n = 0; n < poolSize; n++) {
      const u = mintUser(h, prng, uniqueIp(100_000 + n));
      grantPremium(h, u.id);
      premium.push(u);
    }
    // warm every pool user's auth-cache entry with one accepted shot
    for (const u of premium) {
      const r = await send(h, syncRequest(u, buildShots(h, prng, u.id, 1)));
      assertEquals(r.status, 200, `warm-up failed: ${errorClass(r)}`);
    }
    const perUser = new Map<string, number>(premium.map((u) => [u.id, 1]));
    const accepted: Array<{ user: StressUser; batch: Array<Record<string, unknown>> }> = [];
    let freeUsers = 0;

    const rows: Row[] = [];
    const startedAt = performance.now();
    for (let i = 0; i < ITER; i++) {
      const seed = (STRESS_SEED + i * 7919) >>> 0;
      const p = new Prng(seed);
      const roll = p.int(0, 99);
      const kind: Kind =
        roll < 45
          ? "premium_single_new"
          : roll < 60
            ? "free_first_shot"
            : roll < 75
              ? "premium_batch_new"
              : roll < 90 && accepted.length > 0
                ? "replay_accepted"
                : roll < 95
                  ? "invalid_body"
                  : "mixed_valid_invalid";

      const pickPremium = (): StressUser => {
        // never exceed the route budget: pick the least-used of two candidates
        const a = premium[p.int(0, premium.length - 1)];
        const b = premium[p.int(0, premium.length - 1)];
        const u = (perUser.get(a.id) ?? 0) <= (perUser.get(b.id) ?? 0) ? a : b;
        perUser.set(u.id, (perUser.get(u.id) ?? 0) + 1);
        return u;
      };

      let user: StressUser;
      let batch: unknown[];
      let expectStatus = 200;
      let expectVerdicts: Verdict[] = [];
      let shotIds: string[] = [];
      switch (kind) {
        case "premium_single_new": {
          user = pickPremium();
          const shots = buildShots(h, p, user.id, 1);
          batch = shots;
          shotIds = shots.map((s) => String(s.id));
          expectVerdicts = ["accepted"];
          break;
        }
        case "free_first_shot": {
          user = mintUser(h, p, uniqueIp(200_000 + freeUsers++));
          const shots = buildShots(h, p, user.id, 1);
          batch = shots;
          shotIds = shots.map((s) => String(s.id));
          expectVerdicts = ["accepted"];
          break;
        }
        case "premium_batch_new": {
          user = pickPremium();
          const shots = buildShots(h, p, user.id, p.int(2, 8));
          batch = shots;
          shotIds = shots.map((s) => String(s.id));
          expectVerdicts = shots.map(() => "accepted");
          break;
        }
        case "replay_accepted": {
          const prior = accepted[p.int(0, accepted.length - 1)];
          user = prior.user;
          perUser.set(user.id, (perUser.get(user.id) ?? 0) + 1);
          batch = prior.batch;
          shotIds = prior.batch.map((s) => String(s.id));
          expectVerdicts = prior.batch.map(() => "accepted");
          break;
        }
        case "invalid_body": {
          user = pickPremium();
          batch = p.int(0, 1) === 0 ? [] : Array.from({ length: 201 }, () => ({ id: p.uuid() }));
          expectStatus = 400;
          break;
        }
        case "mixed_valid_invalid": {
          user = pickPremium();
          const shots = buildShots(h, p, user.id, 2);
          const bad = { ...shots[0], id: p.uuid(), overallScore: 42 };
          batch = [shots[0], bad, shots[1]];
          shotIds = [String(shots[0].id), String(bad.id), String(shots[1].id)];
          expectVerdicts = ["accepted", "rejected_contract", "accepted"];
          break;
        }
      }

      const m = await measured(h, syncRequest(user, batch));
      const verdicts = shotIds.map((id) => verdictFor(m.outcome, id));
      const owned = ownedShotIds(h, user.id);
      let ok = m.outcome.status === expectStatus && m.outcome.status < 500;
      let why = "";
      if (ok && expectStatus === 200) {
        ok = verdicts.every((v, n) => v === expectVerdicts[n]);
        if (!ok) why = `verdicts=${verdicts.join(",")} expected=${expectVerdicts.join(",")}`;
        if (ok && !m.outcome.acceptedIds.every((id) => owned.has(id))) {
          ok = false;
          why = "accepted id without a row";
        }
        if (ok && kind === "replay_accepted" && m.rpc !== 0) {
          ok = false;
          why = `replay cost ${m.rpc} RPC calls`;
        }
        if (ok && kind === "premium_single_new" && m.supabase > 3) {
          ok = false;
          why = `warm single-shot sync cost ${m.supabase} Supabase round trips`;
        }
      } else if (!ok) {
        why = `status=${m.outcome.status} expected=${expectStatus} class=${errorClass(m.outcome)}`;
      }
      if (
        ok &&
        (kind === "premium_single_new" ||
          kind === "premium_batch_new" ||
          kind === "free_first_shot")
      ) {
        accepted.push({ user, batch: batch as Array<Record<string, unknown>> });
      }

      rows.push({
        i,
        seed,
        kind,
        user: user.id,
        shots: shotIds.length,
        status: m.outcome.status,
        errorClass: errorClass(m.outcome),
        verdicts,
        latencyMs: m.outcome.ms,
        auth: m.auth,
        select: m.select,
        rpc: m.rpc,
        postgrest: m.postgrest,
        supabase: m.supabase,
        redis: m.redis,
        ok,
        why,
      });
    }
    const wallMs = Math.round(performance.now() - startedAt);

    const byKind: Record<string, unknown> = {};
    for (const kind of [...new Set(rows.map((r) => r.kind))]) {
      const rs = rows.filter((r) => r.kind === kind);
      byKind[kind] = {
        n: rs.length,
        failed: rs.filter((r) => !r.ok).length,
        latencyMs: summarize(rs.map((r) => r.latencyMs)),
        supabaseRoundTrips: summarize(rs.map((r) => r.supabase)),
        postgrestRoundTrips: summarize(rs.map((r) => r.postgrest)),
        authCalls: summarize(rs.map((r) => r.auth)),
        redisPipelines: summarize(rs.map((r) => r.redis)),
        over3SupabaseRoundTrips: rs.filter((r) => r.supabase > 3).length,
      };
    }
    const byBatchSize: Record<string, unknown> = {};
    for (const r of rows.filter(
      (r) => r.kind === "premium_batch_new" || r.kind === "premium_single_new",
    )) {
      const key = String(r.shots);
      const bucket = (byBatchSize[key] ??= {
        n: 0,
        postgrest: [] as number[],
        supabase: [] as number[],
      }) as {
        n: number;
        postgrest: number[];
        supabase: number[];
      };
      bucket.n += 1;
      bucket.postgrest.push(r.postgrest);
      bucket.supabase.push(r.supabase);
    }
    for (const [key, value] of Object.entries(byBatchSize)) {
      const b = value as { n: number; postgrest: number[]; supabase: number[] };
      byBatchSize[key] = {
        n: b.n,
        postgrestRoundTrips: summarize(b.postgrest),
        supabaseRoundTrips: summarize(b.supabase),
        formula: "1 SELECT + N RPC",
      };
    }

    const failed = rows.filter((r) => !r.ok);
    const table = {
      suite: "stress_shots_sync_load",
      seed: STRESS_SEED,
      iterations: rows.length,
      wallMs,
      requestsPerSecond: Math.round((rows.length / wallMs) * 1000),
      latencyMs: summarize(rows.map((r) => r.latencyMs)),
      latencyNote: "in-process handler cost; every upstream is a fake answering in ~0 ms",
      statuses: Object.fromEntries(
        [...new Set(rows.map((r) => r.status))].map((s) => [
          s,
          rows.filter((r) => r.status === s).length,
        ]),
      ),
      supabaseRoundTrips: summarize(rows.map((r) => r.supabase)),
      postgrestRoundTrips: summarize(rows.map((r) => r.postgrest)),
      redisPipelines: summarize(rows.map((r) => r.redis)),
      over3SupabaseRoundTrips: rows.filter((r) => r.supabase > 3).length,
      byKind,
      byBatchSize,
      premiumPool: premium.length,
      freeUsersMinted: freeUsers,
      failed: failed.map((r) => ({
        i: r.i,
        seed: r.seed,
        kind: r.kind,
        why: r.why,
        errorClass: r.errorClass,
      })),
      replayCommand: `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${ITER} deno test -A --no-check --config deno.json stress_shots_sync_load.test.ts`,
      heap: Deno.memoryUsage(),
      rows,
    };
    const path = await writeArtifact("load.json", table);
    console.log(
      `[stress load] ${rows.length} requests in ${wallMs} ms — p50 ${table.latencyMs.p50} ms, p95 ${table.latencyMs.p95} ms, ` +
        `Supabase round trips p50 ${table.supabaseRoundTrips.p50} max ${table.supabaseRoundTrips.max}, ` +
        `>3 on ${table.over3SupabaseRoundTrips} requests → ${path}`,
    );
    assertEquals(
      failed.length,
      0,
      `${failed.length} requests broke the contract: ${JSON.stringify(table.failed.slice(0, 5))}`,
    );
    assert(rows.length >= Math.min(ITER, 1000) || ITER < 1000, `ran ${rows.length} of ${ITER}`);
  },
);

Deno.test(
  `stress memory: L1 caches + rate-limit windows under ${USERS} distinct users (Upstash up, then down)`,
  async () => {
    const h = await loadStressHarness({ redis: true, authTimeoutMs: 400 });
    const prng = new Prng(STRESS_SEED ^ 0x5eed);

    const flood = async (offset: number, label: string) => {
      const before = heap();
      const latencies: number[] = [];
      const statuses: Record<string, number> = {};
      const supabaseTrips: number[] = [];
      const redisTrips: number[] = [];
      const startedAt = performance.now();
      for (let n = 0; n < USERS; n++) {
        const u = mintUser(h, prng, uniqueIp(offset + n));
        const m = await measured(h, syncRequest(u, buildShots(h, prng, u.id, 1)));
        latencies.push(m.outcome.ms);
        statuses[m.outcome.status] = (statuses[m.outcome.status] ?? 0) + 1;
        supabaseTrips.push(m.supabase);
        redisTrips.push(m.redis);
      }
      const wallMs = Math.round(performance.now() - startedAt);
      const after = heap();
      return {
        label,
        users: USERS,
        wallMs,
        before,
        after,
        deltaHeapBytes: after.heapUsed - before.heapUsed,
        latencyMs: summarize(latencies),
        statuses,
        supabaseRoundTrips: summarize(supabaseTrips),
        redisPipelines: summarize(redisTrips),
      };
    };

    // Drop every byte the FAKES hold for the flooded users so the residual heap
    // is the function's own per-isolate state (L1 cache, rate-limit windows).
    const clearModel = () => {
      for (const key of Object.keys(h.fake.tables)) h.fake.tables[key].length = 0;
      h.fake.sessions.clear();
      h.fake.accessIndex.clear();
      h.fake.refreshIndex.clear();
      h.fake.users.clear();
      h.fake.identityLedger.clear();
      h.fake.timeline.length = 0;
      h.redis.store.clear();
      h.resetEvidence();
    };

    // ── phase A: Upstash up
    const redisKeysBefore = h.redis.store.size;
    const phaseA = await flood(1_000_000, "upstash_up");
    const redisKeysAfterA = h.redis.store.size;
    const keyKind = (k: string) =>
      k
        .replace(/:[0-9a-f]{40,}$/, ":<hash>")
        .replace(/[0-9a-f-]{36}/g, "<uuid>")
        .replace(/:\d{6,}:/, ":<bucket>:")
        .replace(/:\d+\.\d+\.\d+\.\d+$/, ":<ip>");
    const redisKeyKinds: Record<string, number> = {};
    for (const k of h.redis.store.keys())
      redisKeyKinds[keyKind(k)] = (redisKeyKinds[keyKind(k)] ?? 0) + 1;
    clearModel();
    const residualA = heap();

    // ── phase B: Upstash down for the whole flood (memory fallback)
    const hot = mintUser(h, prng, uniqueIp(3_000_000));
    grantPremium(h, hot.id);
    h.injector.arm({ target: "redis", mode: "network_error" });
    const hotStatuses: number[] = [];
    for (let n = 0; n < SHOTS_SYNC_LIMIT + 2; n++) {
      hotStatuses.push((await send(h, syncRequest(hot, buildShots(h, prng, hot.id, 1)))).status);
    }
    const hotLimitedBefore = hotStatuses.slice(SHOTS_SYNC_LIMIT).every((s) => s === 429);
    const phaseB = await flood(2_000_000, "upstash_down");
    const hotAfter = await send(h, syncRequest(hot, buildShots(h, prng, hot.id, 1)));
    h.injector.clear();
    clearModel();
    const residualB = heap();

    const table = {
      suite: "stress_shots_sync_memory",
      seed: STRESS_SEED,
      users: USERS,
      gcExposed: gc !== undefined,
      caps: { L1_MEMORY_MAX_ENTRIES: 5_000, RATE_LIMIT_MEMORY_WINDOW_MAX: 20_000 },
      phaseA: {
        ...phaseA,
        redisKeys: {
          before: redisKeysBefore,
          after: redisKeysAfterA,
          perUser: (redisKeysAfterA - redisKeysBefore) / USERS,
          kinds: redisKeyKinds,
        },
        residualHeapAfterModelCleared: residualA,
        residualGrowthBytes: residualA.heapUsed - phaseA.before.heapUsed,
      },
      phaseB: {
        ...phaseB,
        residualHeapAfterModelCleared: residualB,
        residualGrowthBytes: residualB.heapUsed - phaseB.before.heapUsed,
        hotUserBudget: {
          requestsBeforeFlood: hotStatuses.length,
          statusesBeforeFlood: hotStatuses,
          limitedBeforeFlood: hotLimitedBefore,
          statusAfterFlood: hotAfter.status,
          budgetSurvivedFlood: hotAfter.status === 429,
          note: `memory windows hold ≤${20_000} keys; a flood of strangers past the cap clears every window (rateLimit.ts memoryIncr)`,
        },
      },
      residualAssertion:
        gc !== undefined
          ? `asserted: residual growth < ${RESIDUAL_MAX_BYTES} bytes after the fakes' state is cleared`
          : "NOT asserted: heapUsed without --v8-flags=--expose-gc is dominated by uncollected garbage; rerun the replay command",
      replayCommand: `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${USERS} deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_shots_sync_load.test.ts`,
    };
    const path = await writeArtifact("memory.json", table);
    console.log(
      `[stress memory] ${USERS} users: up Δheap ${(phaseA.deltaHeapBytes / 1e6).toFixed(1)} MB (residual growth ${((residualA.heapUsed - phaseA.before.heapUsed) / 1e6).toFixed(1)} MB), ` +
        `down Δheap ${(phaseB.deltaHeapBytes / 1e6).toFixed(1)} MB (residual growth ${((residualB.heapUsed - phaseB.before.heapUsed) / 1e6).toFixed(1)} MB), ` +
        `hot user budget survived flood: ${hotAfter.status === 429} → ${path}`,
    );
    assertEquals(
      Object.keys(phaseA.statuses),
      ["200"],
      `Upstash up: statuses ${JSON.stringify(phaseA.statuses)}`,
    );
    assertEquals(
      Object.keys(phaseB.statuses),
      ["200"],
      `Upstash down: statuses ${JSON.stringify(phaseB.statuses)}`,
    );
    assert(
      hotLimitedBefore,
      `shots_sync budget not enforced in memory fallback: ${hotStatuses.join(",")}`,
    );
    // L1 (≤5 000 entries) + memory windows (≤20 000) must stay bounded — never
    // O(users) — once the fakes' own state is gone. Only meaningful after a
    // forced GC; without --expose-gc heapUsed measures garbage, not state.
    if (gc !== undefined) {
      assert(
        residualA.heapUsed - phaseA.before.heapUsed < RESIDUAL_MAX_BYTES &&
          residualB.heapUsed - phaseB.before.heapUsed < RESIDUAL_MAX_BYTES,
        `per-isolate state grew ${residualA.heapUsed - phaseA.before.heapUsed} / ${residualB.heapUsed - phaseB.before.heapUsed} bytes after ${USERS} users`,
      );
    }
  },
);
