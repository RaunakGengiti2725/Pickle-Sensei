// STRESS — POST /v1/account/bootstrap — per-isolate (L1) memory under many
// distinct users (lens failure-load).
//
// Without Upstash the edge function keeps its rate-limit windows in the
// isolate (rateLimit.ts, MEMORY_WINDOW_MAX = 20 000 entries). Every bootstrap
// touches two windows (client IP pre-auth, canonical user post-auth), so
// STRESS_USERS distinct users from distinct IPs create 2 × STRESS_USERS
// windows and cross the cap. This campaign drives the REAL handler through
// that many distinct identities, samples the heap (with a forced GC when the
// runtime exposes one) as the map grows, and watches a canary user that was
// rate-limited BEFORE the spray: the moment the canary is admitted again, the
// isolate evicted live windows (`windows.clear()`), i.e. the limit failed
// open. bootstrap never touches the cache.ts L1 (no session is cached — every
// bootstrap is a fresh id_token exchange), which the Redis-mode load campaign
// pins by inspecting the issued commands.
//
//   STRESS_USERS  distinct users (default 2 000; campaign ≥ 20 000)
//   STRESS_SEED   campaign seed
//   STRESS_OUT_DIR  where memory.json is written
//
// Replay:  STRESS_SEED=<seed> STRESS_USERS=<n> deno test -A --no-check \
//            --v8-flags=--expose-gc --config deno.json \
//            stress_bootstrap_memory.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  bootstrapRequest,
  captureConsole,
  type Harness,
  latencyStats,
  loadHarness,
  observe,
  providerIdToken,
  STRESS_SEED,
  STRESS_USERS,
  writeReport,
} from "./stress_bootstrap_harness.ts";

const GENERAL_USER_LIMIT = 240;
const SAMPLE_EVERY = Math.max(500, Math.floor(STRESS_USERS / 10));

function forceGc(): boolean {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g !== "function") return false;
  g();
  return true;
}

function freezeClock(): () => void {
  const realNow = Date.now;
  const base = realNow();
  Date.now = () => base;
  return () => {
    Date.now = realNow;
  };
}

function heapUsed(): number {
  return Deno.memoryUsage().heapUsed;
}

async function bootstrapOnce(
  h: Harness,
  sub: string,
  ip: string,
): Promise<{ status: number; durationMs: number }> {
  const started = performance.now();
  const response = await h.handler(
    bootstrapRequest({ token: providerIdToken("google", sub), ip }),
  );
  const obs = await observe(response);
  return {
    status: obs.status,
    durationMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

Deno.test({
  name:
    "stress/bootstrap memory: in-isolate rate-limit windows under STRESS_USERS distinct users",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async (t) => {
    const h = await loadHarness({ redis: false, apple: false });
    h.reset(STRESS_SEED);
    h.recordCalls = false;
    // GoTrue provisions unknown subjects; the fake keeps one user + one
    // profile row per identity (that is the fake's own footprint — sampled
    // separately below so it can be subtracted).
    h.autoProvision = true;
    const console_ = captureConsole();
    const gcAvailable = forceGc();
    const report: Record<string, unknown> = {
      unit: "route-post-v1-account-bootstrap",
      lens: "failure-load",
      seed: STRESS_SEED,
      users: STRESS_USERS,
      gcAvailable,
      replay:
        `STRESS_SEED=${STRESS_SEED} STRESS_USERS=${STRESS_USERS} deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_bootstrap_memory.test.ts`,
    };
    const samples: Array<{
      users: number;
      heapUsedBytes: number;
      fakeUsers: number;
      canary: number;
    }> = [];
    let executed = 0;
    let canaryReadmittedAt: number | null = null;
    const durations: number[] = [];
    // Frozen clock: the canary's 60 s bucket must not roll over during the
    // spray, otherwise re-admission would be the clock, not eviction.
    const unfreeze = freezeClock();
    try {
      // ── Canary: exhaust one user's per-minute budget first ─────────────
      const canarySub = "canary-user";
      const canaryIp = "198.51.100.7";
      await t.step(
        `canary: ${GENERAL_USER_LIMIT + 1} bootstraps → 429`,
        async () => {
          let last = 0;
          for (let i = 0; i <= GENERAL_USER_LIMIT; i++) {
            last = (await bootstrapOnce(h, canarySub, canaryIp)).status;
            executed += 1;
          }
          assertEquals(last, 429, "canary is throttled before the spray");
        },
      );

      const baseline = {
        heapUsedBytes: (forceGc(), heapUsed()),
        fakeUsers: h.users.size,
      };
      report.baseline = baseline;

      // ── Spray STRESS_USERS distinct identities from distinct IPs ───────
      await t.step(
        `${STRESS_USERS} distinct users, one bootstrap each`,
        async () => {
          let non200 = 0;
          for (let i = 1; i <= STRESS_USERS; i++) {
            const sub = `mem-${STRESS_SEED.toString(16)}-${i}`;
            const ip = `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
            const r = await bootstrapOnce(h, sub, ip);
            executed += 1;
            if (r.status !== 200) non200 += 1;
            if (durations.length < 5_000) durations.push(r.durationMs);
            if (i % SAMPLE_EVERY === 0 || i === STRESS_USERS) {
              forceGc();
              const canary = (await bootstrapOnce(h, canarySub, canaryIp))
                .status;
              executed += 1;
              if (canary === 200 && canaryReadmittedAt === null) {
                canaryReadmittedAt = i;
              }
              samples.push({
                users: i,
                heapUsedBytes: heapUsed(),
                fakeUsers: h.users.size,
                canary,
              });
            }
          }
          report.non200 = non200;
          assertEquals(non200, 0, "every distinct user bootstraps");
        },
      );

      // ── Footprint of the fake itself (to subtract) ─────────────────────
      const usersBefore = h.users.size;
      const profilesBefore = h.profiles.size;
      h.users.clear();
      h.profiles.clear();
      forceGc();
      const heapWithoutFake = heapUsed();
      const last = samples[samples.length - 1];
      const fakeBytes = last ? last.heapUsedBytes - heapWithoutFake : 0;
      report.fake = {
        users: usersBefore,
        profiles: profilesBefore,
        bytes: fakeBytes,
      };
      report.samples = samples;
      report.windowsTouched = 2 * STRESS_USERS + 2;
      report.memoryWindowMax = 20_000;
      report.canaryReadmittedAt = canaryReadmittedAt;
      report.heapGrowthBytes = last
        ? last.heapUsedBytes - baseline.heapUsedBytes
        : 0;
      report.heapGrowthExcludingFakeBytes = last
        ? heapWithoutFake - baseline.heapUsedBytes
        : 0;
      report.latencyMs = latencyStats(durations);
    } finally {
      unfreeze();
      console_.restore();
      report.scenariosExecuted = executed;
      const path = await writeReport("memory", report);
      console.log(
        `[stress] memory: ${executed} bootstraps over ${STRESS_USERS} users; heap +${
          Math.round(((report.heapGrowthBytes as number) ?? 0) / 1024)
        } KiB (fake ${
          Math.round(
            ((report.fake as { bytes: number } | undefined)?.bytes ?? 0) / 1024,
          )
        } KiB); canary re-admitted at ${
          canaryReadmittedAt ?? "never"
        } → ${path}`,
      );
    }

    // The cap must hold: past MEMORY_WINDOW_MAX live windows the isolate
    // clears the map, so a throttled client is admitted again — pinned here
    // as the observable consequence (fail-open by design, rateLimit.ts).
    if (2 * STRESS_USERS + 2 > 20_000) {
      assert(
        canaryReadmittedAt !== null &&
          canaryReadmittedAt <= Math.ceil(20_000 / 2) + SAMPLE_EVERY,
        `canary re-admitted at ${canaryReadmittedAt}: windows.clear() did not fire near the 20 000-entry cap`,
      );
    } else {
      assertEquals(
        canaryReadmittedAt,
        null,
        "below the cap a throttled client stays throttled",
      );
    }
  },
});
