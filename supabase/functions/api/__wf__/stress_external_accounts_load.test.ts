// Stress lens `failure-load` for externalAccounts.ts — LOAD half.
//
// Drives the REAL edge handler in-process (stateful fake Supabase Auth /
// PostgREST / Apple / RevenueCat from stress_external_accounts_harness.ts) at
// volume and records, per request: wall-clock latency, Supabase round trips
// (Auth + PostgREST), Apple and RevenueCat calls. Three campaigns:
//
//   A. bootstrap — Apple (authorization-code protocol → exchange + encrypted
//      upsert) and Google sign-ins on fresh users.
//   B. session hot path — GET /v1/me for STRESS_USERS DISTINCT users bearing a
//      session token, then re-visits: exercises the L1 auth cache
//      (MEMORY_MAX_ENTRIES = 5_000) and the per-IP rate-limit windows
//      (MEMORY_WINDOW_MAX = 20_000) with far more principals than either cap,
//      and measures heap before/after.
//   C. delete-confirm — full Apple revoke + RevenueCat delete + Auth delete.
//
// Invariants asserted: every request answers the expected status; a HOT path
// (bootstrap, session-bearing read) never costs more than 3 Supabase round
// trips; a cached session costs 0 Auth round trips; the heap stays bounded
// while the number of distinct users grows past the L1 cap.
//
// Defaults are small so the suite stays fast; the campaign that produced the
// reported numbers ran with
//   STRESS_LOAD_REQUESTS=1200 STRESS_USERS=20000 STRESS_DELETIONS=1000 \
//   deno test -A --no-check --config deno.json --v8-flags=--expose-gc \
//     stress_external_accounts_load.test.ts
// Every user/IP/code is derived from seedFor(campaign, index) → replayable.

import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  BASE_SEED,
  bootstrapRequest,
  deleteConfirmRequest,
  googleBootstrapRequest,
  ipFor,
  latencyStats,
  loadWorld,
  mintAppleUser,
  readJson,
  round,
  seedDeletionChallenge,
  seedFor,
  sessionTokenFor,
  type StatefulWorld,
  storeAppleCredential,
  STRESS_USERS,
  userIdFor,
  writeReport,
} from "./stress_external_accounts_harness.ts";
import { userRequest } from "./routesHarness.ts";

const LOAD_REQUESTS = Math.max(
  20,
  Number(Deno.env.get("STRESS_LOAD_REQUESTS") ?? "120"),
);
const DELETIONS = Math.max(5, Number(Deno.env.get("STRESS_DELETIONS") ?? "40"));
const HOT_PATH_MAX_ROUND_TRIPS = 3;

interface Sample {
  seed: number;
  status: number;
  ms: number;
  supabase: number;
  auth: number;
  postgrest: number;
  apple: number;
  revenuecat: number;
}

function gc(): boolean {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g === "function") {
    g();
    return true;
  }
  return false;
}

function heapUsed(): number {
  gc();
  return Deno.memoryUsage().heapUsed;
}

async function timed(
  world: StatefulWorld,
  seed: number,
  request: Request,
): Promise<{ sample: Sample; body: Record<string, unknown> }> {
  world.resetCounters();
  const started = performance.now();
  const response = await world.harness.handler(request);
  const body = await readJson(response);
  const ms = performance.now() - started;
  const c = world.counters;
  return {
    sample: {
      seed,
      status: response.status,
      ms: round(ms),
      supabase: c.supabase,
      auth: c.supabaseAuth,
      postgrest: c.postgrest,
      apple: c.apple,
      revenuecat: c.revenuecat,
    },
    body,
  };
}

function summarize(samples: Sample[]) {
  const ms = samples.map((s) => s.ms);
  const rt = samples.map((s) => s.supabase);
  const statuses: Record<string, number> = {};
  const roundTrips: Record<string, number> = {};
  for (const s of samples) {
    statuses[s.status] = (statuses[s.status] ?? 0) + 1;
    roundTrips[s.supabase] = (roundTrips[s.supabase] ?? 0) + 1;
  }
  return {
    requests: samples.length,
    latencyMs: latencyStats(ms),
    supabaseRoundTrips: {
      min: Math.min(...rt),
      max: Math.max(...rt),
      mean: round(rt.reduce((a, b) => a + b, 0) / Math.max(1, rt.length)),
      histogram: roundTrips,
    },
    authRoundTrips: samples.reduce((a, s) => a + s.auth, 0),
    postgrestRoundTrips: samples.reduce((a, s) => a + s.postgrest, 0),
    appleCalls: samples.reduce((a, s) => a + s.apple, 0),
    revenuecatCalls: samples.reduce((a, s) => a + s.revenuecat, 0),
    statuses,
  };
}

Deno.test("stress/externalAccounts load: A. bootstrap p50/p95 + Supabase round trips per request", async () => {
  const world = await loadWorld();
  try {
    const apple: Sample[] = [];
    const google: Sample[] = [];
    const violations: string[] = [];
    for (let i = 0; i < LOAD_REQUESTS; i += 1) {
      const seed = seedFor("load.bootstrap", i);
      const rng = new Prng(seed);
      const isApple = i % 3 !== 2; // 2/3 Apple (the heavier path), 1/3 Google
      const ip = ipFor(rng, 4096);
      let result;
      if (isApple) {
        const user = mintAppleUser(world, rng);
        result = await timed(world, seed, bootstrapRequest(user, { ip }));
        if (result.sample.status === 200) {
          assert(
            world.credentials.get(user.id)?.apple_refresh_token_encrypted,
            `seed ${seed}: credential stored`,
          );
          assertEquals(
            result.sample.apple,
            1,
            `seed ${seed}: exactly one Apple exchange`,
          );
        }
        apple.push(result.sample);
      } else {
        const id = userIdFor(rng, "google");
        result = await timed(world, seed, googleBootstrapRequest(id, ip));
        if (result.sample.status === 200) {
          assertEquals(
            result.sample.apple,
            0,
            `seed ${seed}: Google bootstrap never calls Apple`,
          );
          assert(
            !world.credentials.has(id),
            `seed ${seed}: Google bootstrap writes no credential row`,
          );
        }
        google.push(result.sample);
      }
      if (result.sample.status !== 200) {
        violations.push(
          `seed ${seed}: bootstrap ${
            isApple ? "apple" : "google"
          } → HTTP ${result.sample.status} ${
            JSON.stringify(result.body).slice(0, 120)
          }`,
        );
      } else if (result.sample.supabase > HOT_PATH_MAX_ROUND_TRIPS) {
        violations.push(
          `seed ${seed}: bootstrap ${
            isApple ? "apple" : "google"
          } cost ${result.sample.supabase} Supabase round trips (> ${HOT_PATH_MAX_ROUND_TRIPS})`,
        );
      }
    }
    const report = {
      campaign: "load.bootstrap",
      baseSeed: BASE_SEED,
      requests: LOAD_REQUESTS,
      hotPathMaxRoundTrips: HOT_PATH_MAX_ROUND_TRIPS,
      apple: summarize(apple),
      google: summarize(google),
      violations,
      samples: [...apple, ...google].sort((a, b) => a.seed - b.seed),
    };
    const path = await writeReport("load_bootstrap", report);
    console.log(
      `[stress load/bootstrap] ${LOAD_REQUESTS} requests: apple p50=${report.apple.latencyMs.p50_ms}ms p95=${report.apple.latencyMs.p95_ms}ms rt=${
        JSON.stringify(report.apple.supabaseRoundTrips.histogram)
      }; google p50=${report.google.latencyMs.p50_ms}ms p95=${report.google.latencyMs.p95_ms}ms rt=${
        JSON.stringify(report.google.supabaseRoundTrips.histogram)
      }; ${violations.length} violations → ${path}`,
    );
    assertEquals(
      violations,
      [],
      "every bootstrap answers 200 within the hot-path round-trip budget",
    );
  } finally {
    world.uninstall();
  }
});

Deno.test("stress/externalAccounts load: B. session hot path over STRESS_USERS distinct users — L1 auth cache + rate-limit windows + heap", async () => {
  const world = await loadWorld();
  try {
    const gcAvailable = gc();
    const heapBefore = heapUsed();
    const first: Sample[] = [];
    const violations: string[] = [];
    const users: { id: string; ip: string; seed: number }[] = [];
    let heapPeak = heapBefore;
    const heapTrail: { users: number; heapUsed: number }[] = [];

    for (let i = 0; i < STRESS_USERS; i += 1) {
      const seed = seedFor("load.session", i);
      const rng = new Prng(seed);
      const id = userIdFor(rng, i % 2 === 0 ? "apple" : "google");
      const ip = ipFor(rng, 65_536);
      users.push({ id, ip, seed });
      const r = await timed(
        world,
        seed,
        userRequest("GET", "/v1/me", { token: sessionTokenFor(id), ip }),
      );
      first.push(r.sample);
      if (r.sample.status !== 200) {
        violations.push(
          `seed ${seed}: first GET /v1/me → HTTP ${r.sample.status} ${
            JSON.stringify(r.body).slice(0, 120)
          }`,
        );
      } else {
        if (r.sample.auth !== 1) {
          violations.push(
            `seed ${seed}: first request cost ${r.sample.auth} Auth round trips (expected 1: getUser)`,
          );
        }
        if (r.sample.supabase > HOT_PATH_MAX_ROUND_TRIPS) {
          violations.push(
            `seed ${seed}: GET /v1/me cost ${r.sample.supabase} Supabase round trips`,
          );
        }
      }
      if ((i + 1) % 1_000 === 0 || i === STRESS_USERS - 1) {
        const h = heapUsed();
        heapPeak = Math.max(heapPeak, h);
        heapTrail.push({ users: i + 1, heapUsed: h });
      }
    }
    const heapAfterFill = heapUsed();

    // Re-visit: the most recent users must still be in L1 (0 Auth round
    // trips); users far beyond the cap must have been evicted (1 Auth round
    // trip) — proving the cache is bounded rather than growing with users.
    const recentCount = Math.min(500, Math.floor(users.length / 4));
    const recent: Sample[] = [];
    for (const u of users.slice(-recentCount)) {
      const r = await timed(
        world,
        u.seed,
        userRequest("GET", "/v1/me", {
          token: sessionTokenFor(u.id),
          ip: u.ip,
        }),
      );
      recent.push(r.sample);
      if (r.sample.status !== 200) {
        violations.push(`seed ${u.seed}: revisit → HTTP ${r.sample.status}`);
      }
    }
    const recentHits = recent.filter((s) => s.auth === 0).length;

    const oldest: Sample[] = [];
    const oldestCount = users.length > 6_000
      ? Math.min(500, users.length - 5_000)
      : 0;
    for (const u of users.slice(0, oldestCount)) {
      const r = await timed(
        world,
        u.seed,
        userRequest("GET", "/v1/me", {
          token: sessionTokenFor(u.id),
          ip: u.ip,
        }),
      );
      oldest.push(r.sample);
    }
    const oldestEvicted = oldest.filter((s) => s.auth === 1).length;
    const heapEnd = heapUsed();

    const report = {
      campaign: "load.session",
      baseSeed: BASE_SEED,
      distinctUsers: STRESS_USERS,
      distinctIpPool: 65_536,
      gcAvailable,
      heap: {
        before: heapBefore,
        afterFill: heapAfterFill,
        peakSampled: heapPeak,
        end: heapEnd,
        growthBytes: heapAfterFill - heapBefore,
        bytesPerUserIfUnbounded: round(
          (heapAfterFill - heapBefore) / STRESS_USERS,
          1,
        ),
        trail: heapTrail,
      },
      firstVisit: summarize(first),
      revisitRecent: {
        ...summarize(recent),
        l1Hits: recentHits,
        l1HitRate: round(recentHits / Math.max(1, recent.length)),
      },
      revisitOldest: {
        ...summarize(oldest),
        evicted: oldestEvicted,
        sampled: oldest.length,
      },
      violations,
      samples: first,
    };
    const path = await writeReport("load_session_cache", report);
    console.log(
      `[stress load/session] ${STRESS_USERS} distinct users: p50=${report.firstVisit.latencyMs.p50_ms}ms p95=${report.firstVisit.latencyMs.p95_ms}ms rt=${
        JSON.stringify(report.firstVisit.supabaseRoundTrips.histogram)
      }; heap ${heapBefore}→${heapAfterFill} (+${report.heap.growthBytes} B, gc=${gcAvailable}); recent L1 hit ${recentHits}/${recent.length}; oldest evicted ${oldestEvicted}/${oldest.length}; ${violations.length} violations → ${path}`,
    );
    assertEquals(violations, []);
    assertEquals(
      recentHits,
      recent.length,
      "the most recent sessions are served from L1 (0 Auth round trips)",
    );
    if (oldest.length > 0) {
      assertEquals(
        oldestEvicted,
        oldest.length,
        "sessions past the L1 cap were evicted (cache is bounded)",
      );
    }
    // 20k distinct sessions must not pin 20k entries: with the 5k L1 cap and
    // the 20k rate-limit window cap the retained working set is a few MB.
    // The bound below is deliberately loose (isolate noise, test bookkeeping).
    if (gcAvailable && STRESS_USERS >= 10_000) {
      assert(
        report.heap.growthBytes < 64 * 1024 * 1024,
        `heap grew ${report.heap.growthBytes} bytes over ${STRESS_USERS} users`,
      );
    }
  } finally {
    world.uninstall();
  }
});

Deno.test("stress/externalAccounts load: C. delete-confirm (Apple revoke + RevenueCat + Auth delete) latency and round trips", async () => {
  const world = await loadWorld();
  try {
    const samples: Sample[] = [];
    const violations: string[] = [];
    for (let i = 0; i < DELETIONS; i += 1) {
      const seed = seedFor("load.delete", i);
      const rng = new Prng(seed);
      const isApple = i % 4 !== 3;
      const id = userIdFor(rng, isApple ? "apple" : "google");
      const ip = ipFor(rng, 4096);
      const refreshToken = `rt_${rng.uuid().replace(/-/g, "")}`;
      if (isApple) await storeAppleCredential(world, id, refreshToken);
      const challenge = seedDeletionChallenge(world, id, rng);
      const r = await timed(
        world,
        seed,
        deleteConfirmRequest(id, ip, challenge),
      );
      samples.push(r.sample);
      if (r.sample.status !== 200) {
        violations.push(
          `seed ${seed}: delete-confirm → HTTP ${r.sample.status} ${
            JSON.stringify(r.body).slice(0, 120)
          }`,
        );
        continue;
      }
      if (!world.deletedUsers.has(id)) {
        violations.push(`seed ${seed}: Auth user not deleted`);
      }
      if (isApple) {
        if (
          world.revokedAppleTokens.filter((t) => t === refreshToken).length !==
            1
        ) violations.push(`seed ${seed}: Apple revoke count != 1`);
        if (r.body.appleAuthorizationRevocation !== "revoked") {
          violations.push(
            `seed ${seed}: appleAuthorizationRevocation=${r.body.appleAuthorizationRevocation}`,
          );
        }
      } else if (r.sample.apple !== 0) {
        violations.push(`seed ${seed}: Google deletion called Apple`);
      }
      if (world.revenueCatDeleted.filter((u) => u === id).length !== 1) {
        violations.push(`seed ${seed}: RevenueCat delete count != 1`);
      }
      // A second confirm must be refused (session gone) with no further side effects.
      const again = await timed(
        world,
        seed,
        deleteConfirmRequest(id, ip, challenge),
      );
      if (again.sample.status !== 401) {
        violations.push(
          `seed ${seed}: replayed delete-confirm after deletion → HTTP ${again.sample.status} (expected 401)`,
        );
      }
      if (again.sample.apple + again.sample.revenuecat !== 0) {
        violations.push(
          `seed ${seed}: replayed delete-confirm reached Apple/RevenueCat`,
        );
      }
    }
    const report = {
      campaign: "load.delete",
      baseSeed: BASE_SEED,
      requests: DELETIONS,
      note:
        "delete-confirm is NOT a hot path (5/h per user); its round-trip count is reported, not budgeted",
      summary: summarize(samples),
      violations,
      samples,
    };
    const path = await writeReport("load_delete_confirm", report);
    console.log(
      `[stress load/delete] ${DELETIONS} deletions: p50=${report.summary.latencyMs.p50_ms}ms p95=${report.summary.latencyMs.p95_ms}ms rt=${
        JSON.stringify(report.summary.supabaseRoundTrips.histogram)
      }; ${violations.length} violations → ${path}`,
    );
    assertEquals(violations, []);
  } finally {
    world.uninstall();
  }
});
