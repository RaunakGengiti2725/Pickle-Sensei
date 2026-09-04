// Stress `POST /v1/me/delete-confirm` — lens `failure-load`, part 3:
// per-isolate memory (L1 auth cache, local rate-limit windows) under many
// DISTINCT users while Upstash is down (every pipeline answers 500, so the
// function runs on its in-memory fallbacks — the only place per-user state
// can accumulate inside the isolate).
//
// Campaign (seeded, replayable):
//   1. a victim exhausts the 5/hour delete-confirm budget (five wrong
//      challenges → 403 ×5, then 429);
//   2. STRESS_USERS distinct users (distinct IPs, distinct sessions) each send
//      one wrong-challenge confirm; heap is sampled every batch;
//   3. probes: the newest user is served from L1 (no Auth call), the oldest
//      was evicted by the 5 000-entry bound (Auth called again);
//   4. the victim retries: the lens contract is that its hour-long budget is
//      still exhausted (429); today's fallback clears EVERY live window when
//      the 20 000-entry bound is hit, so the budget is gone (recorded, pinned);
//   5. a second wave of STRESS_USERS: heap growth must plateau (bounded maps).
//
// Defaults are small so the suite stays fast; the lens scale is
//   STRESS_USERS=20000 deno test -A --no-check --config deno.json \
//     --v8-flags=--expose-gc stress_delete_confirm_cache_memory.test.ts
// (--expose-gc makes the heap samples post-GC; without it they are noisier
// and the file records gcAvailable=false).

import { assert, assertEquals } from "@std/assert";
import {
  envInt,
  type FakeUser,
  fault,
  fnv1a,
  type Harness,
  latencySummary,
  loadStressHarness,
  Prng,
  STRESS_SEED,
  writeJson,
} from "./stress_delete_confirm_harness.ts";

const USERS = envInt("STRESS_USERS", 2_000);
const CONCURRENCY = envInt("STRESS_CONCURRENCY", 64);
const BATCH = 500;
/** cache.ts MEMORY_MAX_ENTRIES / rateLimit.ts MEMORY_WINDOW_MAX (not exported). */
const L1_MAX_ENTRIES = 5_000;
const WINDOW_MAX_ENTRIES = 20_000;
/** Per request on this route: rl:ip, rl:user, rl:delete_confirm. */
const WINDOWS_PER_REQUEST = 3;

const gc = (globalThis as { gc?: () => void }).gc;
/** Heap bounds are only asserted on post-GC samples (--v8-flags=--expose-gc);
 * without forced GC a sample is mostly uncollected garbage from whatever ran
 * before in the shared isolate, so the numbers are recorded but not judged. */
const HEAP_ASSERTED = Boolean(gc);
const heapLabel = HEAP_ASSERTED ? "bounded heap" : "heap recorded, not asserted (no --expose-gc)";
const MB = (bytes: number) => Math.round((bytes / 1024 / 1024) * 100) / 100;

function heap(): { heapUsedMb: number; rssMb: number; externalMb: number } {
  gc?.();
  const m = Deno.memoryUsage();
  return { heapUsedMb: MB(m.heapUsed), rssMb: MB(m.rss), externalMb: MB(m.external) };
}

interface WaveUser {
  user: FakeUser;
  bearer: string;
  ip: string;
}

function mintUser(h: Harness, prng: Prng): WaveUser {
  const user: FakeUser = { id: prng.uuid(), email: `${prng.hex(10)}@example.com`, provider: "google" };
  return { user, bearer: h.bearer(user.id, prng.uuid()), ip: prng.ip() };
}

async function wrongConfirm(h: Harness, w: WaveUser, challenge: string): Promise<number> {
  const res = await h.handler(h.request("/v1/me/delete-confirm", { bearer: w.bearer, ip: w.ip, body: { challenge } }));
  await res.body?.cancel();
  return res.status;
}

async function wave(
  h: Harness,
  label: string,
  prng: Prng,
  count: number,
  users: WaveUser[],
) {
  const statuses: Record<string, number> = {};
  const latencies: number[] = [];
  const heapSamples: Array<{ users: number; heapUsedMb: number; rssMb: number }> = [];
  const t0 = performance.now();
  for (let done = 0; done < count; done += BATCH) {
    // Each batch runs to completion so the heap sample sits on a quiet heap.
    const batchCount = Math.min(count, done + BATCH) - done;
    let issued = 0;
    const worker = async () => {
      while (issued < batchCount) {
        issued++;
        const w = mintUser(h, prng);
        users.push(w);
        h.addUser(w.user);
        const t = performance.now();
        const status = await wrongConfirm(h, w, prng.uuid());
        latencies.push(performance.now() - t);
        statuses[status] = (statuses[status] ?? 0) + 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batchCount) }, worker));
    const m = heap();
    heapSamples.push({ users: users.length, heapUsedMb: m.heapUsedMb, rssMb: m.rssMb });
  }
  const wallMs = performance.now() - t0;
  return { label, count, statuses, wallMs: Math.round(wallMs), latency: latencySummary(latencies), heapSamples };
}

Deno.test(`stress delete-confirm: L1 auth cache + local rate-limit memory under ${USERS} distinct users (Upstash down)`, async (t) => {
  const h = await loadStressHarness({ redis: true });
  try {
    h.upstreamLatencyMs = null;
    h.recordCalls = false;
    h.faults.push(fault.http("upstash_down", "upstash", 500, { error: "upstream unavailable" }));
    // The fake's own per-user rows are part of the measurement noise; keep
    // them minimal (Auth users only — no deletion rows, no RC subscribers).
    const seed = fnv1a(`${STRESS_SEED}:memory`);
    const prng = new Prng(seed);
    const report: Record<string, unknown> = {
      seed,
      users: USERS,
      concurrency: CONCURRENCY,
      gcAvailable: Boolean(gc),
      heapAssertions: HEAP_ASSERTED ? "asserted" : "unmeasured_without_expose_gc",
      l1MaxEntries: L1_MAX_ENTRIES,
      windowMaxEntries: WINDOW_MAX_ENTRIES,
      replay: `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${USERS} deno test -A --no-check --config deno.json --v8-flags=--expose-gc stress_delete_confirm_cache_memory.test.ts`,
    };
    const heap0 = heap();
    report.heapBaseline = heap0;

    // 1. Victim exhausts the hourly budget.
    const victim = mintUser(h, prng);
    h.addUser(victim.user);
    const victimChallenge = prng.uuid();
    h.addDeletionRow(victim.user.id, victimChallenge, 5_000);
    const victimBefore: number[] = [];
    await t.step("victim exhausts 5/hour budget (5×403 then 429)", async () => {
      for (let i = 0; i < 6; i++) victimBefore.push(await wrongConfirm(h, victim, prng.uuid()));
      assertEquals(victimBefore, [403, 403, 403, 403, 403, 429], `seed=${seed}`);
    });

    // 2. First wave.
    const users: WaveUser[] = [];
    const wave1 = await wave(h, "wave1", prng, USERS, users);
    report.wave1 = wave1;
    await t.step(`wave 1: ${USERS} distinct users → all 403 (no deletion), ${heapLabel}`, () => {
      assertEquals(Object.keys(wave1.statuses), ["403"], `statuses=${JSON.stringify(wave1.statuses)} seed=${seed}`);
      const last = wave1.heapSamples[wave1.heapSamples.length - 1];
      const growth = last.heapUsedMb - heap0.heapUsedMb;
      report.wave1HeapGrowthMb = Math.round(growth * 100) / 100;
      // 5 000 L1 rows + 20 000 windows + the fake's users: tens of MB would
      // mean something per-user leaks outside the bounded maps.
      if (HEAP_ASSERTED) assert(growth < 64, `heap grew ${growth} MB over ${USERS} users (seed=${seed})`);
    });

    // 3. L1 probes.
    await t.step("newest user served from L1 (no Auth call); oldest evicted once past the 5 000 bound", async () => {
      h.recordCalls = true;
      const newest = users[users.length - 1];
      const oldest = users[0];
      const seqA = h.calls[h.calls.length - 1]?.seq ?? 0;
      await wrongConfirm(h, newest, prng.uuid());
      const newestAuthCalls = h.callsSince(seqA).filter((c) => c.upstream === "auth").length;
      const seqB = h.calls[h.calls.length - 1]?.seq ?? 0;
      await wrongConfirm(h, oldest, prng.uuid());
      const oldestAuthCalls = h.callsSince(seqB).filter((c) => c.upstream === "auth").length;
      h.recordCalls = false;
      report.l1Probe = { newestAuthCalls, oldestAuthCalls, usersSeen: users.length };
      assertEquals(newestAuthCalls, 0, `newest user should hit L1 (seed=${seed})`);
      if (users.length > L1_MAX_ENTRIES) {
        assertEquals(oldestAuthCalls, 1, `oldest user should have been evicted from L1 (seed=${seed})`);
      }
    });

    // 4. Victim retries.
    await t.step("victim budget after the wave (contract: still 429; today: cleared with every live window)", async () => {
      const after = await wrongConfirm(h, victim, prng.uuid());
      const windowsWritten = (USERS + 6) * WINDOWS_PER_REQUEST;
      const clearsExpected = Math.floor(windowsWritten / WINDOW_MAX_ENTRIES);
      report.victim = {
        before: victimBefore,
        after,
        contract: 429,
        windowsWritten,
        boundHits: clearsExpected,
        verdict: after === 429 ? "HELD" : "BROKEN",
        note: after === 429
          ? "budget survived"
          : "rateLimit.ts memoryIncr: at MEMORY_WINDOW_MAX with nothing expired it calls windows.clear() — every live window (incl. hour-long delete_confirm budgets) resets",
      };
      if (clearsExpected === 0) {
        assertEquals(after, 429, `bound not reached (${windowsWritten} windows) yet the budget was lost (seed=${seed})`);
      } else {
        // Pinned: the bound WAS crossed and the fallback dropped the budget.
        assertEquals(after, 403, `expected today's fail-open reset (403) once ${clearsExpected} bound hit(s) occurred; got ${after} (seed=${seed})`);
      }
    });

    // 5. Second wave: plateau.
    const wave2 = await wave(h, "wave2", prng, USERS, users);
    report.wave2 = wave2;
    await t.step(`wave 2: heap growth plateaus (bounded L1 + windows) — ${heapLabel}`, () => {
      const w1 = wave1.heapSamples[wave1.heapSamples.length - 1].heapUsedMb - heap0.heapUsedMb;
      const w2 = wave2.heapSamples[wave2.heapSamples.length - 1].heapUsedMb -
        wave1.heapSamples[wave1.heapSamples.length - 1].heapUsedMb;
      report.wave2HeapGrowthMb = Math.round(w2 * 100) / 100;
      // The fake's `users` map (and this test's `users` array) grow linearly by
      // design; the function's own maps are bounded, so the second wave must
      // not grow faster than the first.
      if (HEAP_ASSERTED) {
        assert(w2 <= Math.max(w1, 1) * 1.25 + 4, `second wave grew ${w2} MB vs first ${w1} MB (seed=${seed})`);
      }
    });

    const heapEnd = heap();
    report.heapEnd = heapEnd;
    report.totalHeapGrowthMb = Math.round((heapEnd.heapUsedMb - heap0.heapUsedMb) * 100) / 100;
    const path = await writeJson("cache_memory.json", report);
    console.log(
      `[stress] memory: ${users.length} users, heap ${heap0.heapUsedMb}→${heapEnd.heapUsedMb} MB (gc=${Boolean(gc)}), victim after wave=${
        (report.victim as { after: number }).after
      } → ${path}`,
    );
    h.resetFaults();
    h.recordCalls = true;
    h.upstreamLatencyMs = { min: 1, max: 3 };
  } finally {
    h.detach();
  }
});
