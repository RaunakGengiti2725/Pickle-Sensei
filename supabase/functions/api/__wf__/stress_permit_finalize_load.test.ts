/**
 * stress · load — POST /v1/analysis-permits/:id/finalize
 *
 * Drives the REAL handler (in-process, Redis configured, healthy fakes) with
 * a seeded mix of the route's request shapes — fresh release, duplicate
 * delivery of a finalized permit, conflicting replay, direct `scored`,
 * invalid outcome, unknown permit, another user's permit — and records for
 * EVERY request its latency and its upstream round trips (GoTrue, PostgREST,
 * Upstash). Then a same-permit burst (N concurrent finalizations with mixed
 * outcomes) pins the conditional-update race: exactly one outcome lands.
 *
 * Reported: p50/p95/p99 latency overall and per scenario, Supabase round
 * trips (GoTrue + PostgREST) per request — the warm success path must not
 * exceed 3 and the cold one 4 — status/code histograms, and the burst's
 * outcome. STRESS_ITER (default 150) sets the sequential iteration count,
 * STRESS_BURST (default 32) the burst width, STRESS_UPSTREAM_MS (default 0)
 * a seeded per-upstream-call latency so the distribution reflects round
 * trips rather than pure CPU.
 *
 *   STRESS_ITER=1200 STRESS_SEED=20260904 deno test -A --no-check --config deno.json \
 *     stress_permit_finalize_load.test.ts
 */
import { assert, assertEquals } from "@std/assert";
import { Prng } from "./xc_concurrency_harness.ts";
import {
  envInt,
  type FakeSession,
  type FakeUser,
  heapSnapshot,
  histogram,
  latencySummary,
  loadStressHarness,
  RELEASABLE_OUTCOMES,
  STRESS_SEED,
  type StressHarness,
  writeArtifact,
} from "./stress_permit_finalize_harness.ts";

const ITER = envInt("STRESS_ITER", 150);
const BURST = envInt("STRESS_BURST", 32);
const UPSTREAM_MS = envInt("STRESS_UPSTREAM_MS", 0);

type Scenario =
  | "fresh_release"
  | "duplicate_delivery"
  | "conflicting_replay"
  | "scored_direct"
  | "invalid_outcome"
  | "missing_permit"
  | "foreign_permit";

const MIX: Array<[Scenario, number]> = [
  ["fresh_release", 55],
  ["duplicate_delivery", 15],
  ["conflicting_replay", 8],
  ["scored_direct", 7],
  ["invalid_outcome", 5],
  ["missing_permit", 5],
  ["foreign_permit", 5],
];

function pickScenario(rng: Prng): Scenario {
  const total = MIX.reduce((a, [, w]) => a + w, 0);
  let roll = rng.int(1, total);
  for (const [scenario, weight] of MIX) {
    roll -= weight;
    if (roll <= 0) return scenario;
  }
  return "fresh_release";
}

interface Actor {
  user: FakeUser;
  session: FakeSession;
  ip: string;
  finalized: Array<{ id: string; outcome: string; updatedAt: string }>;
  authWarm: boolean;
}

interface RequestRow {
  i: number;
  scenario: Scenario;
  actor: number;
  authWarm: boolean;
  status: number;
  code: string | null;
  latencyMs: number;
  gotrue: number;
  postgrest: number;
  redis: number;
  supabaseRoundTrips: number;
  problems: string[];
}

const EXPECTED: Record<Scenario, { status: number; code: string | null }> = {
  fresh_release: { status: 200, code: null },
  duplicate_delivery: { status: 200, code: null },
  conflicting_replay: { status: 409, code: "access.permit_already_finalized" },
  scored_direct: { status: 400, code: "validation.analysis_permit_finalize" },
  invalid_outcome: { status: 400, code: "validation.analysis_permit_finalize" },
  missing_permit: { status: 404, code: "access.permit_not_found" },
  foreign_permit: { status: 404, code: "access.permit_not_found" },
};

/** Supabase (GoTrue + PostgREST) round trips the route needs per shape. */
const ROUND_TRIP_BUDGET: Record<Scenario, { warm: number; cold: number }> = {
  fresh_release: { warm: 3, cold: 4 }, // select, update, access_state (+ getUser)
  duplicate_delivery: { warm: 2, cold: 3 }, // select, access_state
  conflicting_replay: { warm: 1, cold: 2 }, // select
  scored_direct: { warm: 0, cold: 1 }, // validation before any query
  invalid_outcome: { warm: 0, cold: 1 },
  missing_permit: { warm: 1, cold: 2 },
  foreign_permit: { warm: 1, cold: 2 },
};

async function runIteration(
  h: StressHarness,
  rng: Prng,
  actors: Actor[],
  i: number,
): Promise<RequestRow> {
  const actorIndex = rng.int(0, actors.length - 1);
  const actor = actors[actorIndex];
  let scenario = pickScenario(rng);
  if (
    (scenario === "duplicate_delivery" || scenario === "conflicting_replay") &&
    actor.finalized.length === 0
  ) {
    scenario = "fresh_release";
  }
  const outcome =
    RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)];
  const problems: string[] = [];
  let permitId: string;
  let body: unknown = { outcome, ratingId: null };
  let before:
    | { status: string; outcome: string | null; updatedAt: string }
    | null = null;

  switch (scenario) {
    case "fresh_release": {
      permitId = h.addPermit(rng, actor.user.id).id;
      break;
    }
    case "duplicate_delivery": {
      const prior = actor.finalized[rng.int(0, actor.finalized.length - 1)];
      permitId = prior.id;
      body = { outcome: prior.outcome, ratingId: null };
      const row = h.permits.get(prior.id)!;
      before = {
        status: row.status,
        outcome: row.outcome,
        updatedAt: row.updated_at,
      };
      break;
    }
    case "conflicting_replay": {
      const prior = actor.finalized[rng.int(0, actor.finalized.length - 1)];
      permitId = prior.id;
      const other = RELEASABLE_OUTCOMES.find((o) => o !== prior.outcome)!;
      body = { outcome: other, ratingId: null };
      const row = h.permits.get(prior.id)!;
      before = {
        status: row.status,
        outcome: row.outcome,
        updatedAt: row.updated_at,
      };
      break;
    }
    case "scored_direct": {
      const row = h.addPermit(rng, actor.user.id);
      permitId = row.id;
      body = { outcome: "scored", ratingId: rng.uuid() };
      before = {
        status: row.status,
        outcome: row.outcome,
        updatedAt: row.updated_at,
      };
      break;
    }
    case "invalid_outcome": {
      const row = h.addPermit(rng, actor.user.id);
      permitId = row.id;
      body = {
        outcome: ["expired", "", 7, null, "LOW_CONFIDENCE"][rng.int(0, 4)],
        ratingId: null,
      };
      before = {
        status: row.status,
        outcome: row.outcome,
        updatedAt: row.updated_at,
      };
      break;
    }
    case "missing_permit": {
      permitId = rng.uuid();
      break;
    }
    case "foreign_permit": {
      const victim = actors[
        (actorIndex + 1 + rng.int(0, actors.length - 2)) % actors.length
      ];
      const row = h.addPermit(rng, victim.user.id);
      permitId = row.id;
      before = {
        status: row.status,
        outcome: row.outcome,
        updatedAt: row.updated_at,
      };
      break;
    }
  }

  const authWarm = actor.authWarm;
  const result = await h.send(
    h.finalizeRequest(permitId, actor.session.accessToken, body, actor.ip),
  );
  actor.authWarm = true;

  const expected = EXPECTED[scenario];
  if (result.status !== expected.status) {
    problems.push(`status ${result.status} ≠ ${expected.status}`);
  }
  if (result.code !== expected.code) {
    problems.push(`code ${result.code} ≠ ${expected.code}`);
  }
  if (!result.requestId) problems.push("no X-Request-Id");

  const row = h.permits.get(permitId);
  if (scenario === "fresh_release") {
    if (!row || row.status !== "finalized" || row.outcome !== outcome) {
      problems.push(
        `permit not finalized as ${outcome}: ${row?.status}/${row?.outcome}`,
      );
    } else if (result.status === 200) {
      actor.finalized.push({
        id: permitId,
        outcome,
        updatedAt: row.updated_at,
      });
    }
  } else if (before && row) {
    if (
      row.status !== before.status || row.outcome !== before.outcome ||
      row.updated_at !== before.updatedAt
    ) {
      problems.push(
        `permit mutated by ${scenario}: ${before.status}/${before.outcome} → ${row.status}/${row.outcome}`,
      );
    }
  }
  if (scenario === "foreign_permit" && result.status === 200) {
    problems.push("foreign permit finalized");
  }

  const budget = ROUND_TRIP_BUDGET[scenario][authWarm ? "warm" : "cold"];
  const supabaseRoundTrips = result.trace.gotrue + result.trace.postgrest;
  if (supabaseRoundTrips > budget) {
    problems.push(
      `${supabaseRoundTrips} Supabase round trips > budget ${budget} (${
        authWarm ? "warm" : "cold"
      })`,
    );
  }
  if (result.trace.revenuecat !== 0) problems.push("RevenueCat consulted");

  return {
    i,
    scenario,
    actor: actorIndex,
    authWarm,
    status: result.status,
    code: result.code,
    latencyMs: Math.round(result.latencyMs * 1000) / 1000,
    gotrue: result.trace.gotrue,
    postgrest: result.trace.postgrest,
    redis: result.trace.redis,
    supabaseRoundTrips,
    problems,
  };
}

Deno.test(`stress load: ${ITER} seeded finalize requests — p50/p95, Supabase round trips ≤3 warm / ≤4 cold, no 5xx/429`, async () => {
  const h = await loadStressHarness({ redis: true });
  h.upstreamLatencyMs = UPSTREAM_MS;
  const rng = new Prng(STRESS_SEED);
  // ≤ 20 requests per user per campaign keeps every user under the 240/min
  // budget and every IP under 1200/min, so a 429 here is a real finding.
  const actorCount = Math.max(8, Math.ceil(ITER / 20));
  const actors: Actor[] = [];
  for (let k = 0; k < actorCount; k++) {
    const user = h.addUser(rng);
    actors.push({
      user,
      session: h.mintSession(rng, user.id),
      ip: `198.51.${(k >> 8) & 255}.${(k & 255) || 1}`,
      finalized: [],
      authWarm: false,
    });
  }

  const heapBefore = heapSnapshot();
  const startedAt = performance.now();
  const rows: RequestRow[] = [];
  for (let i = 0; i < ITER; i++) {
    rows.push(await runIteration(h, rng, actors, i));
  }
  const durationMs = performance.now() - startedAt;

  const byScenario: Record<string, unknown> = {};
  for (const [scenario] of MIX) {
    const subset = rows.filter((r) => r.scenario === scenario);
    if (!subset.length) continue;
    byScenario[scenario] = {
      n: subset.length,
      latency: latencySummary(subset.map((r) => r.latencyMs)),
      supabaseRoundTrips: histogram(
        subset.map((r) =>
          `${r.authWarm ? "warm" : "cold"}:${r.supabaseRoundTrips}`
        ),
      ),
      redisPipelines: histogram(subset.map((r) => r.redis)),
      status: histogram(subset.map((r) => r.status)),
    };
  }
  const warmSuccess = rows.filter((r) =>
    r.scenario === "fresh_release" && r.authWarm
  );
  const failing = rows.filter((r) => r.problems.length);
  const report = {
    campaign: "stress_permit_finalize_load",
    route: "POST /v1/analysis-permits/:id/finalize",
    plane:
      "in-process real handler (index.ts @ Deno) over healthy fakes; Redis configured",
    seed: STRESS_SEED,
    iterations: rows.length,
    actors: actorCount,
    upstreamLatencyMs: UPSTREAM_MS,
    durationMs: Math.round(durationMs),
    throughputRps: Math.round((rows.length / durationMs) * 1000 * 10) / 10,
    latency: latencySummary(rows.map((r) => r.latencyMs)),
    hotPath: {
      scenario: "fresh_release (auth warm)",
      n: warmSuccess.length,
      latency: latencySummary(warmSuccess.map((r) => r.latencyMs)),
      supabaseRoundTrips: histogram(
        warmSuccess.map((r) => r.supabaseRoundTrips),
      ),
      maxSupabaseRoundTrips: Math.max(
        0,
        ...warmSuccess.map((r) => r.supabaseRoundTrips),
      ),
      redisPipelines: histogram(warmSuccess.map((r) => r.redis)),
    },
    maxSupabaseRoundTripsAnyRequest: Math.max(
      ...rows.map((r) => r.supabaseRoundTrips),
    ),
    status: histogram(rows.map((r) => r.status)),
    codes: histogram(rows.map((r) => r.code ?? "-")),
    byScenario,
    totals: { ...h.totals, calls: undefined },
    failing: failing.map((r) => ({
      i: r.i,
      scenario: r.scenario,
      status: r.status,
      problems: r.problems,
    })),
    heap: { before: heapBefore, after: heapSnapshot() },
    replay:
      `STRESS_ITER=${ITER} STRESS_BURST=${BURST} STRESS_UPSTREAM_MS=${UPSTREAM_MS} STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_permit_finalize_load.test.ts`,
    requests: rows,
  };
  const path = await writeArtifact(
    `load_${ITER}_${UPSTREAM_MS}ms.json`,
    report,
  );
  console.log(
    `[stress load] ${rows.length} req in ${
      Math.round(durationMs)
    }ms · p50 ${report.latency.p50Ms}ms p95 ${report.latency.p95Ms}ms · hot-path Supabase round trips ${
      JSON.stringify(report.hotPath.supabaseRoundTrips)
    } · status ${JSON.stringify(report.status)} → ${path}`,
  );

  assertEquals(
    failing.map((r) => `#${r.i} ${r.scenario}: ${r.problems.join("; ")}`),
    [],
  );
  assertEquals(rows.filter((r) => r.status >= 500).length, 0, "no 5xx");
  assertEquals(rows.filter((r) => r.status === 429).length, 0, "no 429");
  assert(
    report.hotPath.maxSupabaseRoundTrips <= 3,
    `hot path ${report.hotPath.maxSupabaseRoundTrips} > 3`,
  );
  assert(
    report.maxSupabaseRoundTripsAnyRequest <= 4,
    `cold path ${report.maxSupabaseRoundTripsAnyRequest} > 4`,
  );
});

Deno.test(`stress load: ${BURST}-wide same-permit burst — exactly one outcome lands, losers see 409, duplicates see 200`, async () => {
  const h = await loadStressHarness({ redis: true });
  h.upstreamLatencyMs = Math.max(UPSTREAM_MS, 3); // interleave the racers' select/update
  const rng = new Prng(STRESS_SEED ^ 0xb00b1e5);
  const { user, session, permit } = h.seedCase(rng);
  const ip = "198.51.200.7";
  // warm auth so the burst measures the route, not GoTrue
  const warm = await h.send(
    h.finalizeRequest(rng.uuid(), session.accessToken, {
      outcome: "cancelled",
      ratingId: null,
    }, ip),
  );
  assertEquals(warm.status, 404);

  const outcomes = Array.from(
    { length: BURST },
    () => RELEASABLE_OUTCOMES[rng.int(0, RELEASABLE_OUTCOMES.length - 1)],
  );
  const totalsBefore = { ...h.totals };
  const startedAt = performance.now();
  const results = await Promise.all(
    outcomes.map((outcome) =>
      h.send(
        h.finalizeRequest(permit.id, session.accessToken, {
          outcome,
          ratingId: null,
        }, ip),
      )
    ),
  );
  const durationMs = performance.now() - startedAt;
  const row = h.permits.get(permit.id)!;
  const winners = results.filter((r) => r.status === 200);
  const losers = results.filter((r) => r.status === 409);
  const problems: string[] = [];
  if (row.status !== "finalized" || !row.outcome) {
    problems.push(`permit ${row.status}/${row.outcome}`);
  }
  results.forEach((r, k) => {
    if (outcomes[k] === row.outcome) {
      if (r.status !== 200) {
        problems.push(
          `racer ${k} (${outcomes[k]} = winner) → ${r.status} ${r.code}`,
        );
      } else if (
        (r.body as { permit: { outcome: string } }).permit.outcome !==
          row.outcome
      ) problems.push(`racer ${k} view mismatch`);
    } else if (
      r.status !== 409 || r.code !== "access.permit_already_finalized"
    ) {
      problems.push(`racer ${k} (${outcomes[k]}) → ${r.status} ${r.code}`);
    }
  });
  if (winners.length !== outcomes.filter((o) => o === row.outcome).length) {
    problems.push("winner count");
  }
  if (winners.length + losers.length !== BURST) {
    problems.push(
      `statuses ${JSON.stringify(histogram(results.map((r) => r.status)))}`,
    );
  }

  // Duplicate delivery of the winning outcome, all at once: every copy 200.
  const dupes = await Promise.all(
    Array.from(
      { length: BURST },
      () =>
        h.send(
          h.finalizeRequest(permit.id, session.accessToken, {
            outcome: row.outcome,
            ratingId: null,
          }, ip),
        ),
    ),
  );
  if (dupes.some((r) => r.status !== 200)) {
    problems.push(
      `duplicate burst ${
        JSON.stringify(histogram(dupes.map((r) => r.status)))
      }`,
    );
  }
  if (h.permits.get(permit.id)!.updated_at !== row.updated_at) {
    problems.push("duplicate burst rewrote the row");
  }

  const report = {
    campaign: "stress_permit_finalize_burst",
    seed: STRESS_SEED ^ 0xb00b1e5,
    burst: BURST,
    outcomes: histogram(outcomes),
    winningOutcome: row.outcome,
    statuses: histogram(results.map((r) => r.status)),
    duplicateStatuses: histogram(dupes.map((r) => r.status)),
    durationMs: Math.round(durationMs),
    supabaseRoundTripsTotal: (h.totals.gotrue - totalsBefore.gotrue) +
      (h.totals.postgrest - totalsBefore.postgrest),
    perRacerLatency: latencySummary(results.map((r) => r.latencyMs)),
    problems,
    replay:
      `STRESS_BURST=${BURST} STRESS_SEED=${STRESS_SEED} deno test -A --no-check --config deno.json stress_permit_finalize_load.test.ts`,
  };
  const path = await writeArtifact(`burst_${BURST}.json`, report);
  console.log(
    `[stress burst] ${BURST} racers → ${
      JSON.stringify(report.statuses)
    } winner=${row.outcome} → ${path}`,
  );
  assertEquals(problems, []);
});
