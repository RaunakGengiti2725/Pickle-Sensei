// W11-01 adversarial tests — attacks that BREAK the candidate (54243f11).
//
// Each test asserts the behaviour the candidate promises (rateLimit.ts header
// comment + implementer summary) and FAILS on the candidate. The failure
// message states what was observed.
//
//   B1  local refusals leak in-flight admissions: an expired session bearer
//       replayed 31 times inside the 15 s in-flight TTL is 429, not 401.
//   B2  a vouch marker evicted from L1 (memory pressure) while the auth-cache
//       row survives makes every CACHED hit an unsettled admission: a valid,
//       verified session is 429 after thirty requests inside 15 s.
//   B3  an Auth outage (503) leaks admissions the same way: a valid bearer
//       retried 31 times is 429 with a window-long Retry-After instead of
//       503 + the short Retry-After the outage path promises.
//   B4  forged novelty is NOT bounded to the budget upstream under
//       concurrency: 120 distinct forged bearers in parallel all reach Auth.
//   B5  replays multiply upstream verdicts: 29 distinct guesses x 30 replays
//       = 870 Auth calls per egress per window (BASE allowed 30).
//   B6  valid peers this isolate has never seen (sessions minted before an
//       isolate restart, or on another isolate without Redis) are 429 for the
//       whole window once a co-tenant has spent the egress's stuffing signal
//       — the venue lockout the package set out to remove.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack_w11_01_nat_breaks.test.ts

import { assert, assertEquals } from "./harness.ts";
import { cacheSet } from "../cache.ts";
import {
  BUDGET,
  expiredSessionBearer,
  forgedBearer,
  frozenClock,
  pinnedClock,
  wire,
} from "./attack_w11_01_harness.ts";

Deno.test(
  "B1 local refusal x31 inside the in-flight TTL: an expired session bearer must stay 401 (local refusals charge nothing)",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.201.1";
      const expired = expiredSessionBearer();
      const statuses: number[] = [];
      for (let i = 0; i < BUDGET.limit + 1; i += 1) {
        statuses.push((await probe(ip, expired)).status);
      }
      assertEquals(auth.userChecks, 0, "an expired bearer never reaches Auth");
      const deferred = statuses.filter((s) => s === 429).length;
      assertEquals(
        statuses,
        Array.from({ length: BUDGET.limit + 1 }, () => 401),
        `observed ${deferred} x 429 among ${statuses.length} local refusals: ${statuses.join(",")}`,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "B2 corrupt/partial persisted state: vouch marker evicted from L1 while the auth-cache row survives — a verified, cached session must keep answering 200",
  async () => {
    const clock = pinnedClock();
    try {
      const { auth, bootstrap, probe } = await wire();
      const ip = "100.64.202.1";
      const peer = await bootstrap(ip);
      assertEquals((await probe(ip, peer.accessToken)).status, 200, "verified and cached");
      // A busy isolate: other rows land after the peer's vouch marker.
      for (let i = 0; i < 2_000; i += 1) await cacheSet(`attack-b2-fill-a-${i}`, "x", 3_600);
      // The auth-cache row (<= 10 min) ages out, the vouch (exp + 5 min) does not;
      // the next request re-verifies: the vouch is refreshed IN PLACE, the cache
      // row is re-inserted at the tail.
      clock.advance(11 * 60_000);
      const checks = auth.userChecks;
      assertEquals((await probe(ip, peer.accessToken)).status, 200, "re-verified");
      assertEquals(auth.userChecks, checks + 1);
      // L1 reaches its cap: the oldest third is dropped — the vouch marker
      // among it, the young auth-cache row not.
      for (let i = 0; i < 3_100; i += 1) await cacheSet(`attack-b2-fill-b-${i}`, "x", 3_600);

      const statuses: number[] = [];
      for (let i = 0; i < BUDGET.limit + 1; i += 1) {
        statuses.push((await probe(ip, peer.accessToken)).status);
      }
      assertEquals(auth.userChecks, checks + 1, "served from the auth cache");
      const deferred = statuses.filter((s) => s === 429).length;
      assertEquals(
        statuses,
        Array.from({ length: BUDGET.limit + 1 }, () => 200),
        `observed ${deferred} x 429 for a valid cached session: ${statuses.join(",")}`,
      );
    } finally {
      clock.restore();
    }
  },
);

Deno.test(
  "B3 Auth outage (503) x31: a valid never-seen bearer must keep hearing 503 + the outage Retry-After, never a window-long 429",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.203.1";
      const valid = auth.mint();
      auth.userStatus = 503;
      const answers: Array<{ status: number; retryAfter: string | null }> = [];
      for (let i = 0; i < BUDGET.limit + 1; i += 1) {
        answers.push(await probe(ip, valid.access_token));
      }
      const deferred = answers.filter((a) => a.status === 429);
      assertEquals(
        answers.map((a) => a.status),
        Array.from({ length: BUDGET.limit + 1 }, () => 503),
        `observed ${deferred.length} x 429 (Retry-After ${deferred[0]?.retryAfter ?? "-"}s) during an Auth outage; upstream saw ${auth.userChecks} of ${answers.length}`,
      );
      // Once Auth is back the same bearer is verified and served.
      auth.userStatus = 200;
      assertEquals((await probe(ip, valid.access_token)).status, 200);
    } finally {
      restore();
    }
  },
);

Deno.test(
  "B4 concurrent forged novelty: 120 distinct forged bearers in parallel from one egress must reach Auth at most `limit` times (the bound claimed for forged novelty)",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.204.1";
      const responses = await Promise.all(
        Array.from({ length: 120 }, () => probe(ip, forgedBearer())),
      );
      const judged = responses.filter((r) => r.status === 401).length;
      const deferred = responses.filter((r) => r.status === 429).length;
      assertEquals(judged + deferred, 120);
      assert(
        auth.userChecks <= BUDGET.limit,
        `Auth judged ${auth.userChecks} distinct forged bearers in one parallel burst (bound claimed: ${BUDGET.limit}); 401=${judged} 429=${deferred}`,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "B5 replay amplification: 29 distinct forged bearers replayed 30x each must not exceed `limit` upstream verdicts per egress per window (BASE: 30)",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.205.1";
      const guesses = Array.from({ length: BUDGET.limit - 1 }, () => forgedBearer());
      let judged = 0;
      let deferred = 0;
      for (let replay = 0; replay < BUDGET.limit; replay += 1) {
        for (const guess of guesses) {
          const res = await probe(ip, guess);
          if (res.status === 401) judged += 1;
          else if (res.status === 429) deferred += 1;
        }
      }
      assert(
        auth.userChecks <= BUDGET.limit,
        `Auth judged ${auth.userChecks} presentations from one egress in one window (401=${judged} 429=${deferred}); BASE bounded this at ${BUDGET.limit}`,
      );
    } finally {
      restore();
    }
  },
);

Deno.test(
  "B6 process restart / never-seen peers: after a co-tenant spends the egress signal, valid sessions this isolate has not verified yet must still be judged by Auth and served — not 429 for the window",
  async () => {
    const restore = frozenClock();
    try {
      const { auth, probe } = await wire();
      const ip = "100.64.206.1";
      // Venue handsets signed in before this isolate started (or on another
      // isolate; no Redis): Auth knows them, this edge has never seen them.
      const venue = Array.from({ length: 5 }, () => auth.mint());
      for (let i = 0; i < BUDGET.limit; i += 1) {
        assertEquals((await probe(ip, forgedBearer())).status, 401);
      }
      const answers = [];
      for (const handset of venue) answers.push((await probe(ip, handset.access_token)).status);
      assertEquals(
        answers,
        venue.map(() => 200),
        `valid never-seen venue sessions behind the flooded egress answered ${answers.join(",")}`,
      );
    } finally {
      restore();
    }
  },
);
