// stress-catalog-drill / failure-load lens — LOAD for GET /v1/catalog/drills/:slug
// (real handler, Redis-LESS isolate: L1 caches and in-memory rate windows are
// what is being measured, so Upstash must be absent from this process).
//
//   campaign A  ≥ STRESS_ITER sequential requests over a small user pool:
//               p50/p95 latency, Supabase round trips per request (cold = 2,
//               warm = 1; anything above 3 is a finding), correctness of the
//               `saved` flag against the seeded truth, unknown/malformed slugs.
//   campaign B  concurrent bursts (Promise.all) — latency under contention and
//               that no request observes another user's saved row.
//   campaign C  STRESS_USERS distinct users (fresh provider tokens → cold auth
//               + auth-cache write + a per-user rate window each): heap before
//               and after, and the bounded-memory contract of cache.ts
//               (MEMORY_MAX_ENTRIES = 5 000) and rateLimit.ts
//               (MEMORY_WINDOW_MAX = 20 000) checked BEHAVIOURALLY — the first
//               user's cached session must have been evicted (its next request
//               re-verifies at Auth) while every request still answers 200.
//
// Defaults are small so the suite stays fast (STRESS_ITER=200, STRESS_USERS=2000);
// the lens run is STRESS_ITER=1200 STRESS_USERS=20000. Seeded: request k of a
// campaign derives from STRESS_SEED (+ campaign offset) and is replayable.

import { assert, assertEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import {
  envInt,
  isRecord,
  latencySummary,
  loadStressHarness,
  Prng,
  type RunResult,
  userRequest,
  writeArtifact,
} from "./stress_catalog_drill_harness.ts";

const GENERAL_USER_LIMIT = 240; // per 60 s — index.ts GENERAL_USER_LIMIT
const IP_LIMIT = 1_200; // per 60 s — index.ts IP_LIMIT
const L1_MAX_ENTRIES = 5_000; // cache.ts MEMORY_MAX_ENTRIES
const WINDOW_MAX = 20_000; // rateLimit.ts MEMORY_WINDOW_MAX

const path = (slug: string) => `/v1/catalog/drills/${encodeURIComponent(slug)}`;
const drillOf = (r: RunResult) =>
  isRecord(r.body) && isRecord(r.body.drill) ? r.body.drill : null;

interface Pool {
  users: Array<{ id: string; token: string; ip: string }>;
}

Deno.test({
  name: "stress/catalog-drill: load — latency, Supabase round trips, L1 memory under distinct users (seeded)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const h = await loadStressHarness({ redis: false });
    try {
      const slugs = (await drillCatalog()).map((d) => d.slug);
      const baseSeed = envInt("STRESS_SEED", 20260905);
      const iterations = envInt("STRESS_ITER", 200);
      const distinctUsers = envInt("STRESS_USERS", 2_000);
      const report: Record<string, unknown> = {
        lens: "failure-load/load",
        route: "GET /v1/catalog/drills/:slug",
        baseSeed,
        iterations,
        distinctUsers,
        redis: false,
        deno: Deno.version.deno,
      };

      // ── A. sequential latency + round trips ──────────────────────────────────
      await t.step(`A. ${iterations} sequential requests`, async () => {
        h.reset();
        const rng = new Prng(baseSeed);
        // Enough users that nobody exceeds the per-user budget inside the run.
        const poolSize = Math.max(8, Math.ceil(iterations / (GENERAL_USER_LIMIT * 0.6)));
        const pool: Pool = { users: [] };
        for (let u = 0; u < poolSize; u += 1) {
          const id = rng.uuid();
          pool.users.push({ id, token: h.mintSession(id), ip: rng.ip() });
          for (const slug of slugs) if (rng.chance(0.3)) h.saved.add(`${id}|${slug}`);
        }
        const rows: Array<Record<string, unknown>> = [];
        const latency: Record<string, number[]> = {
          all: [],
          cold: [],
          warm: [],
          notFound: [],
          malformed: [],
        };
        const tripHistogram: Record<string, number> = {};
        const statusHistogram: Record<string, number> = {};
        const seenUser = new Set<string>();
        const violations: string[] = [];
        for (let k = 0; k < iterations; k += 1) {
          const seed = baseSeed + 1_000_000 + k;
          const r = new Prng(seed);
          const user = r.pick(pool.users);
          const roll = r.next();
          let kind: "known" | "unknown" | "malformed" = "known";
          let slug = r.pick(slugs);
          if (roll > 0.95) {
            kind = "malformed";
            slug = r.pick(["%E0%A4%A", "%ZZ", "%", "%C0%AF"]);
          } else if (roll > 0.85) {
            kind = "unknown";
            slug = `${r.string(r.int(1, 24))}-nope`;
          }
          const cold = !seenUser.has(user.id);
          seenUser.add(user.id);
          const request =
            kind === "malformed"
              ? new Request(`http://edge.test/functions/v1/api/v1/catalog/drills/${slug}`, {
                  headers: { Authorization: `Bearer ${user.token}`, "x-forwarded-for": user.ip },
                })
              : userRequest(path(slug), { token: user.token, ip: user.ip });
          const res = await h.run(request, 5_000);
          statusHistogram[String(res.status)] = (statusHistogram[String(res.status)] ?? 0) + 1;
          tripHistogram[String(res.roundTrips.supabase)] =
            (tripHistogram[String(res.roundTrips.supabase)] ?? 0) + 1;
          latency.all.push(res.latencyMs);
          if (kind === "known") latency[cold ? "cold" : "warm"].push(res.latencyMs);
          else latency[kind === "unknown" ? "notFound" : "malformed"].push(res.latencyMs);

          const expectedStatus = kind === "known" ? 200 : kind === "unknown" ? 404 : 400;
          if (res.timedOut) violations.push(`k=${k} seed=${seed} stalled`);
          else if (res.status !== expectedStatus) {
            violations.push(
              `k=${k} seed=${seed} ${kind} → ${res.status} ${res.bodyText.slice(0, 120)}`,
            );
          }
          if (res.roundTrips.supabase > 3)
            violations.push(`k=${k} seed=${seed} ${res.roundTrips.supabase} Supabase round trips`);
          if (res.roundTrips.supabase > (cold ? 2 : 1)) {
            violations.push(
              `k=${k} seed=${seed} ${cold ? "cold" : "warm"} request used ${res.roundTrips.supabase} round trips`,
            );
          }
          if (res.roundTrips.revenuecat > 0 || res.roundTrips.redis > 0)
            violations.push(`k=${k} unexpected upstream`);
          if (kind === "known" && res.status === 200) {
            const drill = drillOf(res);
            const truth = h.saved.has(`${user.id}|${slug}`);
            if (!drill || drill.slug !== slug) violations.push(`k=${k} seed=${seed} wrong drill`);
            if (drill && drill.saved !== truth)
              violations.push(`k=${k} seed=${seed} saved=${String(drill.saved)} truth=${truth}`);
          }
          if (kind === "unknown" && res.code !== "drill.not_found")
            violations.push(`k=${k} seed=${seed} 404 without drill.not_found`);
          if (kind !== "known" && res.roundTrips.rest > 0)
            violations.push(`k=${k} seed=${seed} ${kind} slug reached PostgREST`);
          rows.push({
            k,
            seed,
            user: user.id,
            kind,
            slug,
            cold,
            status: res.status,
            latencyMs: Math.round(res.latencyMs * 1000) / 1000,
            roundTrips: res.roundTrips,
          });
        }
        const summary = {
          poolSize,
          statuses: statusHistogram,
          supabaseRoundTripsPerRequest: tripHistogram,
          latencyMs: Object.fromEntries(
            Object.entries(latency).map(([k, v]) => [k, latencySummary(v)]),
          ),
          violations,
        };
        report.sequential = { ...summary, rows };
        assertEquals(violations, [], "sequential campaign violations");
        assert(rows.length >= iterations);
      });

      // ── B. concurrent bursts ─────────────────────────────────────────────────
      await t.step("B. concurrent bursts", async () => {
        h.reset();
        const rng = new Prng(baseSeed + 7);
        const burst = Math.min(100, Math.max(20, Math.floor(iterations / 10)));
        const bursts = Math.max(3, Math.ceil(iterations / burst / 2));
        const pool: Pool = { users: [] };
        for (let u = 0; u < 40; u += 1) {
          const id = rng.uuid();
          pool.users.push({ id, token: h.mintSession(id), ip: rng.ip() });
          for (const slug of slugs) if (rng.chance(0.3)) h.saved.add(`${id}|${slug}`);
        }
        const latencies: number[] = [];
        const wall: number[] = [];
        const violations: string[] = [];
        let total = 0;
        let restCalls = 0;
        for (let b = 0; b < bursts; b += 1) {
          const plan = Array.from({ length: burst }, (_, j) => {
            const r = new Prng(baseSeed + 2_000_000 + b * 1_000 + j);
            return { user: r.pick(pool.users), slug: r.pick(slugs), seed: r.seed };
          });
          const before = h.calls.length;
          const startedAt = performance.now();
          const answers = await Promise.all(
            plan.map(async (p) => {
              const t0 = performance.now();
              const response = await h.handler(
                userRequest(path(p.slug), { token: p.user.token, ip: p.user.ip }),
              );
              const text = await response.text();
              return { p, status: response.status, text, latencyMs: performance.now() - t0 };
            }),
          );
          wall.push(performance.now() - startedAt);
          restCalls += h.calls.slice(before).filter((c) => c.upstream === "rest").length;
          for (const a of answers) {
            total += 1;
            latencies.push(a.latencyMs);
            if (a.status !== 200) {
              violations.push(`burst ${b} seed=${a.p.seed} → ${a.status} ${a.text.slice(0, 100)}`);
              continue;
            }
            const body = JSON.parse(a.text);
            const drill = isRecord(body) && isRecord(body.drill) ? body.drill : null;
            const truth = h.saved.has(`${a.p.user.id}|${a.p.slug}`);
            if (!drill || drill.slug !== a.p.slug || drill.saved !== truth) {
              violations.push(
                `burst ${b} seed=${a.p.seed} saved=${String(drill?.saved)} truth=${truth}`,
              );
            }
          }
        }
        report.concurrent = {
          burst,
          bursts,
          requests: total,
          restCallsTotal: restCalls,
          restCallsPerRequest: Math.round((restCalls / total) * 1000) / 1000,
          latencyMs: latencySummary(latencies),
          burstWallMs: latencySummary(wall),
          violations,
        };
        assertEquals(violations, [], "concurrent campaign violations");
        assert(total >= burst * bursts);
      });

      // ── C. distinct users → L1 auth cache + rate windows memory ──────────────
      await t.step(`C. ${distinctUsers} distinct users`, async () => {
        h.reset();
        const rng = new Prng(baseSeed + 99);
        // Run with --v8-flags=--expose-gc for a settled heap delta; without it the
        // delta includes garbage V8 has not collected yet (recorded as such).
        const gc = (globalThis as { gc?: () => void }).gc;
        gc?.();
        const heapBefore = Deno.memoryUsage();
        const t0 = performance.now();
        const first = { id: rng.uuid(), token: "" };
        first.token = h.providerToken(first.id);
        const slug = rng.pick(slugs);
        let ipIndex = 0;
        let ip = rng.ip();
        const statuses: Record<string, number> = {};
        const trips: Record<string, number> = {};
        const latencies: number[] = [];
        const violations: string[] = [];
        const firstRun = await h.run(userRequest(path(slug), { token: first.token, ip }));
        if (firstRun.status !== 200) violations.push(`first user → ${firstRun.status}`);
        for (let u = 1; u < distinctUsers; u += 1) {
          if (u % Math.floor(IP_LIMIT * 0.5) === 0) {
            ipIndex += 1;
            ip = rng.ip();
          }
          const id = rng.uuid();
          const token = rng.chance(0.5) ? h.mintSession(id) : h.providerToken(id);
          const res = await h.run(userRequest(path(slug), { token, ip }));
          statuses[String(res.status)] = (statuses[String(res.status)] ?? 0) + 1;
          trips[String(res.roundTrips.supabase)] =
            (trips[String(res.roundTrips.supabase)] ?? 0) + 1;
          latencies.push(res.latencyMs);
          if (res.status !== 200)
            violations.push(`user #${u} → ${res.status} ${res.bodyText.slice(0, 100)}`);
          if (res.roundTrips.supabase !== 2)
            violations.push(`user #${u} cold request used ${res.roundTrips.supabase} round trips`);
          // The harness' own call log is not what is being measured.
          h.calls.length = 0;
        }
        const wallMs = performance.now() - t0;
        // Behavioural bound check: the first user's cached verification must be
        // gone once far more than MEMORY_MAX_ENTRIES users came through.
        const again = await h.run(userRequest(path(slug), { token: first.token, ip: rng.ip() }));
        const firstEvicted = again.roundTrips.auth_token === 1;
        h.calls.length = 0;
        gc?.();
        const heapAfter = Deno.memoryUsage();
        const heapGrowthMb = (heapAfter.heapUsed - heapBefore.heapUsed) / 1_048_576;
        report.distinctUsers = {
          users: distinctUsers,
          ipsUsed: ipIndex + 1,
          wallMs: Math.round(wallMs),
          statuses,
          supabaseRoundTripsPerRequest: trips,
          latencyMs: latencySummary(latencies),
          gcForced: typeof gc === "function",
          heapBefore,
          heapAfter,
          heapGrowthMb: Math.round(heapGrowthMb * 100) / 100,
          harnessOwnedEntries: { sessions: h.users.size },
          firstUserReVerifiedAfterCampaign: firstEvicted,
          firstUserSecondRun: { status: again.status, roundTrips: again.roundTrips },
          bounds: { L1_MAX_ENTRIES, WINDOW_MAX },
          violations,
        };
        assertEquals(violations, [], "distinct-user campaign violations");
        assertEquals(again.status, 200);
        if (distinctUsers > L1_MAX_ENTRIES * 2) {
          assert(
            firstEvicted,
            "L1 auth cache did not evict under 2× MEMORY_MAX_ENTRIES distinct users",
          );
        }
        // Working set of the bounded maps (entries ≈ 500 B) plus session tokens the
        // harness itself minted; a leak proportional to users would be far larger.
        assert(heapGrowthMb < 400, `heap grew ${heapGrowthMb} MB across ${distinctUsers} users`);
      });

      const artifact = await writeArtifact("load.json", report);
      console.log(`stress/catalog-drill load report → ${artifact}`);
    } finally {
      h.restore();
    }
  },
});
