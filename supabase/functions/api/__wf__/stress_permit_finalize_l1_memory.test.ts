/**
 * stress · L1 memory — POST /v1/analysis-permits/:id/finalize under many
 * distinct users, NO Upstash (the per-isolate fallback: cache.ts `memory`
 * Map for verified sessions, rateLimit.ts `windows` Map for budgets).
 *
 * STRESS_USERS distinct users (default 400; the campaign runs 20 000) each
 * finalize one permit cold from a distinct IP. Measured, not inferred:
 *   · heap after the fixtures vs after the campaign (gc'd when the isolate
 *     was started with --v8-flags=--expose-gc), bytes per distinct user
 *   · GoTrue verifications = users (every cold request verifies once)
 *   · the auth L1 bound: the 5 000-entry cap evicts the OLDEST third, so
 *     the earliest users re-verify (cold) while the latest stay warm
 *   · the rate-limit window bound: a user who exhausted the 240/min budget
 *     probes it again after the crowd — the pinned fallback wipes every
 *     window once 20 000 distinct keys are live, so past that scale the
 *     exhausted user is admitted again (recorded + flagged, asserted either
 *     way so the table never lies about what happened)
 *
 *   STRESS_USERS=20000 deno test -A --no-check --v8-flags=--expose-gc \
 *     --config deno.json stress_permit_finalize_l1_memory.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  envInt,
  heapSnapshot,
  histogram,
  latencySummary,
  loadStressHarness,
  RELEASABLE_OUTCOMES,
  STRESS_SEED,
  writeArtifact,
} from "./stress_permit_finalize_harness.ts";

const USERS = envInt("STRESS_USERS", 400);
const PROBE = 200;
const GENERAL_USER_LIMIT = 240;
const AUTH_L1_MAX_ENTRIES = 5_000;
const RATE_LIMIT_WINDOW_MAX = 20_000;

function gc(): boolean {
  const g = (globalThis as { gc?: () => void }).gc;
  if (typeof g !== "function") return false;
  g();
  g();
  return true;
}

Deno.test(`stress l1 memory: ${USERS} distinct users, no Upstash — heap growth, auth L1 eviction, rate-limit window bound`, async () => {
  const h = await loadStressHarness({ redis: false });
  const rng = new Prng(STRESS_SEED ^ 0x1e1);
  const ipOf = (k: number) => `203.0.${(k >> 8) & 255}.${(k & 255) || 1}`;

  // ── exhausted-budget probe user (its own IP so the IP budget is untouched)
  const probe = h.seedCase(rng);
  const probeIp = "192.0.2.240";
  const probeStatuses: number[] = [];
  for (let k = 0; k < GENERAL_USER_LIMIT + 1; k++) {
    const r = await h.send(
      h.finalizeRequest(rng.uuid(), probe.session.accessToken, {
        outcome: "cancelled",
        ratingId: null,
      }, probeIp),
    );
    probeStatuses.push(r.status);
  }
  const probeHistogram = histogram(probeStatuses);
  assertEquals(
    probeHistogram,
    { "404": GENERAL_USER_LIMIT, "429": 1 },
    "probe user exhausts 240/min exactly",
  );

  // ── fixtures
  const fixtures: Array<{ token: string; permitId: string; outcome: string }> =
    [];
  for (let k = 0; k < USERS; k++) {
    const user = h.addUser(rng);
    const session = h.mintSession(rng, user.id);
    const permit = h.addPermit(rng, user.id);
    fixtures.push({
      token: session.accessToken,
      permitId: permit.id,
      outcome: RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)],
    });
  }
  const gcAvailable = gc();
  const heapFixtures = heapSnapshot();
  const totalsBefore = { ...h.totals };

  // ── campaign: one cold finalize per distinct user from a distinct IP
  const latencies: number[] = [];
  const statuses: number[] = [];
  let supabaseRoundTripsMax = 0;
  const startedAt = performance.now();
  for (let k = 0; k < USERS; k++) {
    const f = fixtures[k];
    const r = await h.send(
      h.finalizeRequest(f.permitId, f.token, {
        outcome: f.outcome,
        ratingId: null,
      }, ipOf(k)),
    );
    latencies.push(r.latencyMs);
    statuses.push(r.status);
    supabaseRoundTripsMax = Math.max(
      supabaseRoundTripsMax,
      r.trace.gotrue + r.trace.postgrest,
    );
  }
  const durationMs = performance.now() - startedAt;
  gc();
  const heapAfter = heapSnapshot();
  const gotrueDuringCampaign = h.totals.gotrue - totalsBefore.gotrue;

  // ── L1 bound: earliest users evicted (cold again), latest still warm
  const reverify = async (indexes: number[]) => {
    let gotrue = 0;
    let ok = 0;
    for (const k of indexes) {
      const f = fixtures[k];
      const r = await h.send(
        h.finalizeRequest(f.permitId, f.token, {
          outcome: f.outcome,
          ratingId: null,
        }, ipOf(k)),
      );
      gotrue += r.trace.gotrue;
      if (r.status === 200) ok += 1;
    }
    return { requests: indexes.length, gotrue, ok };
  };
  const probeN = Math.min(PROBE, USERS);
  const earliest = await reverify(Array.from({ length: probeN }, (_, i) => i));
  const latest = await reverify(
    Array.from({ length: probeN }, (_, i) => USERS - probeN + i),
  );
  const expectEarliestEvicted = USERS > AUTH_L1_MAX_ENTRIES;

  // ── rate-limit window bound: does the exhausted probe user stay exhausted?
  const probeAgain = await h.send(
    h.finalizeRequest(rng.uuid(), probe.session.accessToken, {
      outcome: "cancelled",
      ratingId: null,
    }, probeIp),
  );
  // keys live in `windows`: probe (ip + user) + per campaign user (ip + user)
  const windowKeysCreated = 2 + 2 * USERS;
  const expectWindowsWiped = windowKeysCreated > RATE_LIMIT_WINDOW_MAX;

  const heapDelta = heapAfter.heapUsed - heapFixtures.heapUsed;
  const report = {
    campaign: "stress_permit_finalize_l1_memory",
    plane:
      "in-process real handler (index.ts @ Deno) over healthy fakes; NO Upstash (per-isolate L1 + memory rate limits)",
    seed: STRESS_SEED ^ 0x1e1,
    users: USERS,
    gcAvailable,
    heap: {
      fixtures: heapFixtures,
      afterCampaign: heapAfter,
      heapUsedDeltaBytes: heapDelta,
      heapUsedDeltaPerUserBytes: Math.round(heapDelta / USERS),
      rssDeltaBytes: heapAfter.rss - heapFixtures.rss,
    },
    campaign_requests: {
      n: USERS,
      durationMs: Math.round(durationMs),
      latency: latencySummary(latencies),
      status: histogram(statuses),
      gotrueVerifications: gotrueDuringCampaign,
      supabaseRoundTripsMax,
    },
    authL1: {
      maxEntries: AUTH_L1_MAX_ENTRIES,
      earliestUsersReverified: earliest,
      latestUsersReverified: latest,
      expectEarliestEvicted,
    },
    rateLimitWindows: {
      maxEntries: RATE_LIMIT_WINDOW_MAX,
      windowKeysCreated,
      probeUserBeforeCrowd: probeHistogram,
      probeUserAfterCrowd: { status: probeAgain.status, code: probeAgain.code },
      expectWindowsWiped,
      flag: expectWindowsWiped
        ? "rateLimit.ts memoryIncr(): once 20 000 live keys exist and none expired, windows.clear() drops EVERY budget on this isolate — the exhausted user is admitted again within the same minute (fallback path only: Upstash absent or failing)"
        : "",
    },
    replay:
      `STRESS_USERS=${USERS} STRESS_SEED=${STRESS_SEED} deno test -A --no-check --v8-flags=--expose-gc --config deno.json stress_permit_finalize_l1_memory.test.ts`,
  };
  const path = await writeArtifact(`l1_memory_${USERS}.json`, report);
  console.log(
    `[stress l1] ${USERS} users · heapUsed Δ ${
      (heapDelta / 1024 / 1024).toFixed(1)
    } MiB (${report.heap.heapUsedDeltaPerUserBytes} B/user, gc=${gcAvailable}) · gotrue ${gotrueDuringCampaign} · earliest re-verify gotrue ${earliest.gotrue}/${probeN} · latest ${latest.gotrue}/${probeN} · probe after crowd ${probeAgain.status} → ${path}`,
  );

  assertEquals(
    histogram(statuses),
    { "200": USERS },
    "every distinct user finalized once",
  );
  assertEquals(
    gotrueDuringCampaign,
    USERS,
    "one GoTrue verification per cold user",
  );
  assert(
    supabaseRoundTripsMax <= 4,
    `cold path ${supabaseRoundTripsMax} Supabase round trips`,
  );
  assertEquals(earliest.ok, probeN);
  assertEquals(latest.ok, probeN);
  assertEquals(latest.gotrue, 0, "latest users still served from L1");
  assertEquals(
    earliest.gotrue,
    expectEarliestEvicted ? probeN : 0,
    "oldest third evicted past the 5 000 cap",
  );
  assertEquals(
    probeAgain.status,
    expectWindowsWiped ? 404 : 429,
    "rate-limit window bound behaves as pinned",
  );
  // bounded structures: growth must not scale with users past the caps
  assert(heapDelta < 96 * 1024 * 1024, `heapUsed grew ${heapDelta} bytes`);
});
