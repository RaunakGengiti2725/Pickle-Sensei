// Round-trip pin for every routed scenario of the Edge Function perf harness:
// ONE measured request per scenario (auth cache warm where the scenario says
// so), asserting the exact upstream call matrix — Supabase Auth, PostgREST,
// RevenueCat — that the real handler in ../../index.ts performs today.
//
// Run:  (cd supabase/functions/api/__wf__ && deno task test)   # picked up by .
//   or  deno test -A --no-check --config deno.json perf/perf_round_trips.test.ts
//
// The numbers below are the OBSERVED baseline at 4d812e1a. A change that
// adds a round trip to a route fails this test on purpose — update the pin
// consciously (and note the reason) rather than working around it. Routes
// exceeding the >3-round-trip hot-path budget are flagged in `OVER_BUDGET`
// so the test stays honest about them instead of hiding them in the matrix.

import { assert, assertEquals } from "@std/assert";
import { distribution, runScenario } from "./perf_edge_latency_bench.ts";
import { bootPerfHarness, ZERO_LATENCY } from "./perfHarness.ts";
import { SCENARIOS, type Scenario } from "./perfScenarios.ts";

interface Pin {
  status: number;
  auth: number;
  rest: number;
  revenuecat: number;
}

/** scenario id → expected status + per-class upstream calls for ONE request. */
const PINS: Record<string, Pin> = {
  healthz: { status: 200, auth: 0, rest: 0, revenuecat: 0 },
  privacy: { status: 200, auth: 0, rest: 0, revenuecat: 0 },
  "account-bootstrap": { status: 200, auth: 1, rest: 1, revenuecat: 0 },
  "auth-refresh": { status: 200, auth: 1, rest: 0, revenuecat: 0 },
  "auth-logout": { status: 204, auth: 1, rest: 0, revenuecat: 0 },
  me: { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "me-missing-profile": { status: 503, auth: 0, rest: 2, revenuecat: 0 },
  onboarding: { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  access: { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "access-auth-cold-session": { status: 200, auth: 1, rest: 1, revenuecat: 0 },
  "access-auth-cold-google": { status: 200, auth: 1, rest: 1, revenuecat: 0 },
  "billing-sync": { status: 200, auth: 0, rest: 2, revenuecat: 1 },
  "permits-reserve": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "permits-finalize": { status: 200, auth: 0, rest: 3, revenuecat: 0 },
  "shots-sync-1": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "shots-sync-10": { status: 200, auth: 0, rest: 11, revenuecat: 0 },
  "shots-sync-50": { status: 200, auth: 0, rest: 51, revenuecat: 0 },
  "shots-sync-200": { status: 200, auth: 0, rest: 201, revenuecat: 0 },
  "shots-sync-replay-10": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "sessions-create": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "sessions-finalize": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "evaluation-trials-1": { status: 200, auth: 0, rest: 3, revenuecat: 0 },
  "evaluation-trials-10": { status: 200, auth: 0, rest: 21, revenuecat: 0 },
  "evaluation-trials-50": { status: 200, auth: 0, rest: 101, revenuecat: 0 },
  "evaluation-trials-200": { status: 200, auth: 0, rest: 401, revenuecat: 0 },
  "analysis-feedback": { status: 201, auth: 0, rest: 3, revenuecat: 0 },
  "progress-cache-hit": { status: 200, auth: 0, rest: 0, revenuecat: 0 },
  "progress-cache-miss": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "progress-cache-miss-2500": { status: 200, auth: 0, rest: 4, revenuecat: 0 },
  "rank-cache-hit": { status: 200, auth: 0, rest: 0, revenuecat: 0 },
  "rank-cache-miss": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  // Redis is OFF in this pin, so an "L2 hit" degrades to the DB miss path.
  "progress-cache-l2-hit": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "rank-cache-l2-hit": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "consent-status": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "consent-grant": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "consent-withdraw": { status: 200, auth: 0, rest: 3, revenuecat: 0 },
  "catalog-drills": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "catalog-drill-detail": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "saved-drills-list-0": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "saved-drills-list-20": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "saved-drill-put": { status: 200, auth: 0, rest: 2, revenuecat: 0 },
  "saved-drill-delete": { status: 204, auth: 0, rest: 1, revenuecat: 0 },
  "training-plan-current": { status: 200, auth: 0, rest: 0, revenuecat: 0 },
  "delete-request": { status: 200, auth: 0, rest: 1, revenuecat: 0 },
  "delete-request-survey": { status: 200, auth: 0, rest: 4, revenuecat: 0 },
  "delete-confirm": { status: 200, auth: 1, rest: 3, revenuecat: 1 },
  "webhook-revenuecat": { status: 200, auth: 0, rest: 3, revenuecat: 1 },
};

/** Hot-path scenarios KNOWN to exceed the 3-round-trip budget at 4d812e1a
 * (N+1 per shot / per trial). Listed so the budget assertion below is
 * explicit about what it tolerates; shrinking this set is the goal. */
const OVER_BUDGET = new Set<string>([
  "shots-sync-10",
  "shots-sync-50",
  "shots-sync-200",
  "evaluation-trials-10",
  "evaluation-trials-50",
  "evaluation-trials-200",
  "progress-cache-miss-2500",
]);

const HOT_BUDGET = 3;

Deno.test("perf harness: every scenario has a pin and every pin has a scenario", () => {
  const ids = SCENARIOS.map((scenario) => scenario.id);
  assertEquals(new Set(ids).size, ids.length, "duplicate scenario id");
  assertEquals(ids.sort(), Object.keys(PINS).sort());
  for (const id of OVER_BUDGET) assert(id in PINS, `OVER_BUDGET lists unknown scenario ${id}`);
});

Deno.test("perf harness: distribution() percentiles are nearest-rank on sorted input", () => {
  const dist = distribution([5, 1, 4, 2, 3]);
  assertEquals(dist.min, 1);
  assertEquals(dist.max, 5);
  assertEquals(dist.p50, 3);
  assertEquals(dist.p95, 5);
  assertEquals(dist.mean, 3);
  assertEquals(distribution([]).p50, 0);
});

Deno.test("round-trip pin: one request per route reproduces the upstream call matrix", async () => {
  const harness = await bootPerfHarness({ redis: false, latency: ZERO_LATENCY });
  harness.setQuiet(true);
  const seed = "perf-round-trips-pin";
  const mismatches: string[] = [];
  const overBudgetSeen = new Set<string>();

  for (const scenario of SCENARIOS as Scenario[]) {
    const pin = PINS[scenario.id];
    const ctx = {
      seed: scenario.users === "unique" ? `${seed}:${scenario.id}` : seed,
      requests: 1,
    };
    const result = await runScenario(harness, scenario, ctx, 1);
    const observed: Pin = {
      status: Number(Object.keys(result.statuses)[0]),
      auth: result.roundTrips.byClass.supabase_auth.p50,
      rest: result.roundTrips.byClass.supabase_rest.p50,
      revenuecat: result.roundTrips.byClass.revenuecat.p50,
    };
    if (JSON.stringify(observed) !== JSON.stringify(pin)) {
      mismatches.push(
        `${scenario.id}: expected ${JSON.stringify(pin)} observed ${JSON.stringify(observed)} ` +
          `labels=${JSON.stringify(result.roundTrips.labels)}`,
      );
    }
    assertEquals(
      result.roundTrips.byClass.other.max,
      0,
      `${scenario.id}: unexpected outbound fetch`,
    );
    if (scenario.hotPath && result.roundTrips.hot.p50 > HOT_BUDGET) {
      overBudgetSeen.add(scenario.id);
    }
  }
  harness.setQuiet(false);

  assertEquals(mismatches, [], `round-trip matrix drifted:\n${mismatches.join("\n")}`);
  assertEquals(
    [...overBudgetSeen].sort(),
    [...OVER_BUDGET].sort(),
    "set of hot-path scenarios over the 3-round-trip budget changed",
  );
});
