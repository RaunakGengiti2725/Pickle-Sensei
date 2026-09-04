// STRESS — POST /v1/account/bootstrap — load campaign (lens failure-load).
//
// Drives the REAL edge handler in-process (stress_bootstrap_harness.ts) with
// Upstash configured (production shape: L2 rate limits) through a seeded mix
// of bootstrap scenarios and records, per request: outcome, latency, the
// number of Supabase round trips, Redis pipelines and Apple calls. Then a
// concurrent burst checks that no response is ever delivered to the wrong
// identity and that request ids stay unique.
//
//   STRESS_ITER   requests per latency phase (default 200; campaign ≥ 1000)
//   STRESS_SEED   campaign seed — every request i replays from
//                 seed_i = STRESS_SEED ^ (i * 0x9E3779B1)
//   STRESS_OUT_DIR  where load.json is written
//
// Replay:  STRESS_SEED=<seed> STRESS_ITER=<n> deno test -A --no-check \
//            --config deno.json stress_bootstrap_load.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  bootstrapRequest,
  captureConsole,
  type Harness,
  isRecord,
  latencyStats,
  loadHarness,
  observe,
  Prng,
  providerIdToken,
  STRESS_ITER,
  STRESS_SEED,
  uuidFor,
  writeReport,
} from "./stress_bootstrap_harness.ts";

type Scenario =
  | "google-existing"
  | "apple-existing"
  | "google-first-signin"
  | "apple-provider-switch"
  | "google-profile-lag";

/** Seeded scenario mix (weights sum to 100). */
const MIX: Array<[Scenario, number]> = [
  ["google-existing", 55],
  ["apple-existing", 28],
  ["google-first-signin", 10],
  ["apple-provider-switch", 5],
  ["google-profile-lag", 2],
];

const EXISTING_POOL = 400;

/** The documented contract: a bootstrap hot path costs at most 3 Supabase
 * round trips (id_token exchange + profile read + optional Apple credential
 * write). Anything above is reported. */
const MAX_HOT_PATH_SUPABASE_ROUND_TRIPS = 3;

interface RequestRecord {
  i: number;
  seed: number;
  scenario: Scenario;
  status: number;
  appClass: string;
  durationMs: number;
  supabaseRoundTrips: number;
  redisRoundTrips: number;
  appleCalls: number;
  totalUpstreamHops: number;
  requestId: string | null;
}

function pickScenario(prng: Prng): Scenario {
  let roll = prng.int(1, 100);
  for (const [scenario, weight] of MIX) {
    if (roll <= weight) return scenario;
    roll -= weight;
  }
  return "google-existing";
}

function requestSeed(i: number): number {
  return (STRESS_SEED ^ Math.imul(i, 0x9e3779b1)) >>> 0;
}

/** Build the request for iteration i; returns the expected canonical user id. */
function prepare(
  h: Harness,
  i: number,
): { request: Request; scenario: Scenario; userId: string; seed: number } {
  const seed = requestSeed(i);
  const prng = new Prng(seed);
  const scenario = pickScenario(prng);
  switch (scenario) {
    case "google-existing": {
      const sub = `g-pool-${prng.int(0, EXISTING_POOL - 1)}`;
      const user = h.users.get(sub) ?? h.provision(sub, "google");
      return {
        seed,
        scenario,
        userId: user.id,
        request: bootstrapRequest({ token: providerIdToken("google", sub) }),
      };
    }
    case "apple-existing": {
      const sub = `a-pool-${prng.int(0, EXISTING_POOL - 1)}`;
      const user = h.users.get(sub) ?? h.provision(sub, "apple");
      return {
        seed,
        scenario,
        userId: user.id,
        request: bootstrapRequest({
          token: providerIdToken("apple", sub),
          body: { appleAuthorizationCode: h.mintAppleCode(sub) },
          headers: { "X-Apple-Revocation-Protocol": "1" },
        }),
      };
    }
    case "google-first-signin": {
      // Unknown to GoTrue: provisioned on the exchange (handle_new_user()).
      const sub = `g-new-${seed.toString(16)}`;
      return {
        seed,
        scenario,
        userId: uuidFor(`google:${sub}`),
        request: bootstrapRequest({ token: providerIdToken("google", sub) }),
      };
    }
    case "apple-provider-switch": {
      // Profile stamped google (previous provider), signs in with Apple now.
      const sub = `a-switch-${seed.toString(16)}`;
      const user = h.provision(sub, "apple");
      h.profiles.get(user.id)!.provider = "google";
      return {
        seed,
        scenario,
        userId: user.id,
        request: bootstrapRequest({
          token: providerIdToken("apple", sub),
          body: { appleAuthorizationCode: h.mintAppleCode(sub) },
          headers: { "X-Apple-Revocation-Protocol": "1" },
        }),
      };
    }
    case "google-profile-lag": {
      const sub = `g-lag-${seed.toString(16)}`;
      const user = h.provision(sub, "google");
      h.profileLag.set(user.id, 1);
      return {
        seed,
        scenario,
        userId: user.id,
        request: bootstrapRequest({ token: providerIdToken("google", sub) }),
      };
    }
  }
}

async function runSequential(
  h: Harness,
  count: number,
  offset: number,
): Promise<RequestRecord[]> {
  const records: RequestRecord[] = [];
  for (let k = 0; k < count; k++) {
    const i = offset + k;
    const { request, scenario, userId, seed } = prepare(h, i);
    const fromSeq = h.nextSeq();
    const started = performance.now();
    const response = await h.handler(request);
    const obs = await observe(response);
    const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    const appleCalls = h.calls.filter((c) =>
      c.seq >= fromSeq && c.target === "apple.token"
    ).length;
    const supabaseRoundTrips = h.supabaseRoundTrips(fromSeq);
    const redisRoundTrips = h.redisRoundTrips(fromSeq);
    records.push({
      i,
      seed,
      scenario,
      status: obs.status,
      appClass: obs.appClass,
      durationMs,
      supabaseRoundTrips,
      redisRoundTrips,
      appleCalls,
      totalUpstreamHops: supabaseRoundTrips + redisRoundTrips + appleCalls,
      requestId: obs.requestId,
    });
    assertEquals(
      obs.status,
      200,
      `[seed ${seed}] i=${i} ${scenario}: ${obs.status} ${obs.message}`,
    );
    void userId;
    // Keep the call log bounded across a long campaign.
    if (h.calls.length > 5_000) h.calls.splice(0, h.calls.length - 1_000);
  }
  return records;
}

function summarize(records: RequestRecord[]) {
  const byScenario: Record<string, unknown> = {};
  for (const [scenario] of MIX) {
    const rows = records.filter((r) => r.scenario === scenario);
    if (rows.length === 0) continue;
    const trips = rows.map((r) => r.supabaseRoundTrips);
    byScenario[scenario] = {
      n: rows.length,
      latencyMs: latencyStats(rows.map((r) => r.durationMs)),
      supabaseRoundTrips: {
        min: Math.min(...trips),
        max: Math.max(...trips),
        histogram: trips.reduce<Record<string, number>>((acc, t) => {
          acc[String(t)] = (acc[String(t)] ?? 0) + 1;
          return acc;
        }, {}),
      },
      redisRoundTrips: Math.max(...rows.map((r) => r.redisRoundTrips)),
      appleCalls: Math.max(...rows.map((r) => r.appleCalls)),
      totalUpstreamHopsMax: Math.max(...rows.map((r) => r.totalUpstreamHops)),
    };
  }
  return {
    n: records.length,
    latencyMs: latencyStats(records.map((r) => r.durationMs)),
    statuses: records.reduce<Record<string, number>>((acc, r) => {
      acc[String(r.status)] = (acc[String(r.status)] ?? 0) + 1;
      return acc;
    }, {}),
    supabaseRoundTripsMax: Math.max(
      ...records.map((r) => r.supabaseRoundTrips),
    ),
    overBudget:
      records.filter((r) =>
        r.supabaseRoundTrips > MAX_HOT_PATH_SUPABASE_ROUND_TRIPS
      ).length,
    byScenario,
  };
}

Deno.test({
  name:
    "stress/bootstrap load: seeded mix, p50/p95, Supabase round trips per request, concurrent identity integrity",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const h = await loadHarness({ redis: true, apple: true });
    const console_ = captureConsole();
    const report: Record<string, unknown> = {
      unit: "route-post-v1-account-bootstrap",
      lens: "failure-load",
      seed: STRESS_SEED,
      iterationsPerPhase: STRESS_ITER,
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_ITER=${STRESS_ITER} deno test -A --no-check --config deno.json stress_bootstrap_load.test.ts`,
      mix: Object.fromEntries(MIX),
      maxHotPathSupabaseRoundTrips: MAX_HOT_PATH_SUPABASE_ROUND_TRIPS,
    };
    let executed = 0;
    let phase0: RequestRecord[] = [];
    let phase1: RequestRecord[] = [];
    try {
      // ── Phase 0: zero upstream latency → pure handler overhead ──────────
      await t.step(
        `phase 0: ${STRESS_ITER} sequential, upstream 0 ms`,
        async () => {
          h.reset(STRESS_SEED);
          h.latencyMaxMs = 0;
          phase0 = await runSequential(h, STRESS_ITER, 0);
          executed += phase0.length;
          report.phase0 = summarize(phase0);
        },
      );

      // ── Phase 1: seeded 0–20 ms jitter per upstream hop ─────────────────
      await t.step(
        `phase 1: ${STRESS_ITER} sequential, upstream U(0,20) ms per hop`,
        async () => {
          h.reset(STRESS_SEED + 1);
          h.latencyMaxMs = 20;
          phase1 = await runSequential(h, STRESS_ITER, STRESS_ITER);
          executed += phase1.length;
          report.phase1 = summarize(phase1);
        },
      );

      // ── Phase 2: concurrent burst — identity integrity ──────────────────
      const burst = Math.max(50, Math.min(400, Math.floor(STRESS_ITER / 3)));
      await t.step(
        `phase 2: ${burst} concurrent (batches of 50), every response reaches its own identity`,
        async () => {
          h.reset(STRESS_SEED + 2);
          h.latencyMaxMs = 10;
          const fromSeq = h.nextSeq();
          const requestIds = new Set<string>();
          let mismatches = 0;
          let non200 = 0;
          const durations: number[] = [];
          const started = performance.now();
          for (let base = 0; base < burst; base += 50) {
            const batch = Array.from(
              { length: Math.min(50, burst - base) },
              (_, k) => prepare(h, 2 * STRESS_ITER + base + k),
            );
            const settled = await Promise.all(
              batch.map(async (item) => {
                const t1 = performance.now();
                const response = await h.handler(item.request);
                const text = await response.text();
                durations.push(performance.now() - t1);
                return { item, response, text };
              }),
            );
            for (const { item, response, text } of settled) {
              executed += 1;
              const rid = response.headers.get("x-request-id");
              if (rid) requestIds.add(rid);
              if (response.status !== 200) {
                non200 += 1;
                continue;
              }
              let payload: unknown = null;
              try {
                payload = JSON.parse(text);
              } catch {
                mismatches += 1;
                continue;
              }
              const user = isRecord(payload) ? payload.user : null;
              const session = isRecord(payload) ? payload.session : null;
              const accessToken = isRecord(session) &&
                  typeof session.accessToken === "string"
                ? session.accessToken
                : "";
              const claims = (() => {
                try {
                  const [, body] = accessToken.split(".");
                  return JSON.parse(
                    atob(body.replace(/-/g, "+").replace(/_/g, "/")),
                  ) as Record<string, unknown>;
                } catch {
                  return null;
                }
              })();
              if (
                !isRecord(user) || user.id !== item.userId ||
                claims?.sub !== item.userId
              ) {
                mismatches += 1;
              }
            }
          }
          const wallMs = performance.now() - started;
          const supabaseCalls = h.supabaseRoundTrips(fromSeq);
          report.phase2 = {
            n: burst,
            concurrency: 50,
            wallMs: Math.round(wallMs),
            requestsPerSecond: Math.round((burst / wallMs) * 1000),
            latencyMs: latencyStats(durations),
            non200,
            identityMismatches: mismatches,
            uniqueRequestIds: requestIds.size,
            supabaseRoundTripsPerRequest:
              Math.round((supabaseCalls / burst) * 100) / 100,
          };
          assertEquals(non200, 0, "burst: every bootstrap answered 200");
          assertEquals(
            mismatches,
            0,
            "burst: a response reached a different identity",
          );
          assertEquals(requestIds.size, burst, "burst: x-request-id unique");
        },
      );

      // ── Redis footprint: bootstrap must write no cache rows ─────────────
      await t.step("bootstrap writes only rate-limit windows to Redis", () => {
        const ops = new Set(h.redisCommands.map((c) => String(c[0])));
        const keys = h.redisCommands
          .map((c) => String(c[1] ?? ""))
          .filter((k) => k && !k.startsWith("rl:"));
        report.redis = {
          ops: [...ops].sort(),
          nonRateLimitKeys: keys.length,
          liveKeys: h.redis.size,
        };
        assertEquals(keys, [], "only rl:* keys touched");
        for (const op of ops) {
          assert(
            ["INCR", "EXPIRE", "GET", "TTL"].includes(op),
            `unexpected Redis op ${op}`,
          );
        }
      });
    } finally {
      console_.restore();
      report.scenariosExecuted = executed;
      report.handlerLogLines = console_.lines.length;
      report.requests = [...phase0, ...phase1];
      const path = await writeReport("load", report);
      const p0 = report.phase0 as ReturnType<typeof summarize> | undefined;
      const p1 = report.phase1 as ReturnType<typeof summarize> | undefined;
      console.log(
        `[stress] load: ${executed} requests; phase0 p50=${p0?.latencyMs.p50} p95=${p0?.latencyMs.p95} ms; phase1 p50=${p1?.latencyMs.p50} p95=${p1?.latencyMs.p95} ms; max Supabase round trips=${p0?.supabaseRoundTripsMax} → ${path}`,
      );
    }

    // Hot-path budget: per-scenario round-trip ceilings are pinned so a
    // regression (an extra read/write on the happy path) fails the suite.
    const p0 = report.phase0 as ReturnType<typeof summarize>;
    const expectedTrips: Record<Scenario, number> = {
      "google-existing": 2,
      "google-first-signin": 2,
      "apple-existing": 3,
      "apple-provider-switch": 4,
      "google-profile-lag": 3,
    };
    for (const [scenario, trips] of Object.entries(expectedTrips)) {
      const row = p0.byScenario[scenario] as
        | { supabaseRoundTrips: { min: number; max: number } }
        | undefined;
      if (!row) continue;
      assertEquals(
        [row.supabaseRoundTrips.min, row.supabaseRoundTrips.max],
        [trips, trips],
        `${scenario}: Supabase round trips`,
      );
    }
  },
});
