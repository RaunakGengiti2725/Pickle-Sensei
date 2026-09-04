// Seeded randomized state-machine campaign (xc_rsm_c) — one seed of the
// production campaign runs inside `deno task test` so the invariants that
// hold today stay pinned:
//
//   * every sequential request (phase A) matches the reference oracle bit for
//     bit (status, Retry-After, RateLimit-* headers, error code);
//   * 401 semantics — expired / forged / unknown-issuer / revoked-at-launch
//     bearers are always refused;
//   * 429 semantics — per-IP, auth-failure, per-user and refresh budgets close
//     at exactly `limit` hits and answer with the documented headers;
//   * a Supabase Auth 5xx / fetch failure behind authenticate() is an outage
//     (503 + Retry-After), never a 401 that charges the auth-failure budget
//     (deterministic form: xc_rsm_c/repros/upstream_5xx_repro.ts).
//
// REVOKED_SESSION_REFUSED ("the cache never serves a logged-out bearer") is
// NOT asserted here because index.ts currently violates it; the deterministic
// reproductions live in xc_rsm_c/repros/logout_cache_repro.ts and fail on
// purpose until the edge function is fixed. Once they pass, add
// REVOKED_SESSION_REFUSED to HARD_INVARIANTS below.
//
// Full campaign (seeds 3000-3099, >= 2000 requests per seed, artifacts):
//   deno run -A --no-check --config deno.json xc_rsm_c/scripts/run_campaign.ts --out /tmp/xc-rsm-c

import { assert, assertEquals } from "@std/assert";
import type { InvariantId } from "./campaign.ts";
import { runSeed, virtualClock } from "./runner.ts";

const HARD_INVARIANTS: InvariantId[] = [
  "MODEL_EXACT",
  "EXPIRED_BEARER_REFUSED",
  "UNKNOWN_BEARER_REFUSED",
  "RATE_LIMIT_RESPONSE_SHAPE",
  "IP_BUDGET",
  "AUTHFAIL_LOCK",
  "AUTHFAIL_BOUND",
  "USER_BUDGET",
  "REFRESH_BUDGET",
  "REFRESH_ROTATION",
  "UPSTREAM_5XX_NOT_AUTH_FAILURE",
];

Deno.test({
  name: "xc_rsm_c seed 3000: >= 2000 randomized requests satisfy the 401/429 oracle and rate-limit invariants",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    try {
      const result = await runSeed(3000);
      assert(result.requests >= 2000, `only ${result.requests} requests`);
      assert(
        result.perPhase.A > 0 && result.perPhase.B > 0 && result.perPhase.C > 0,
        JSON.stringify(result.perPhase),
      );
      assert(
        (result.statusCounts["429"] ?? 0) > 0,
        "the campaign must exhaust at least one budget",
      );
      assert(
        (result.statusCounts["401"] ?? 0) > 0,
        "the campaign must present refused credentials",
      );
      const offending = result.failures.filter((f) => HARD_INVARIANTS.includes(f.invariant));
      assertEquals(
        offending.map(
          (f) => `${f.invariant} seed=${f.seed} idx=${f.idx}: ${f.detail} — replay: ${f.replay}`,
        ),
        [],
      );
    } finally {
      virtualClock().restore();
    }
  },
});
