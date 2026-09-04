// Adversarial pass 3 — S3: 5 001 distinct verified Supabase bearers through
// authenticate() on ONE isolate. cache.ts caps the L1 map at
// MEMORY_MAX_ENTRIES = 5 000 and, when full, drops the oldest third
// (ceil(5000/3) = 1 667 entries) in insertion order. Expected: the 1st bearer
// is re-verified (evicted) on its next request, the 5 000th is still served
// from cache, and eviction really happened (i.e. the map did not grow past
// the cap).
//
// The L1 map is module-private, so the cap is observed through the same
// module instance the handler uses: `cacheGet` from ../cache.ts (a read has no
// side effects on the map) plus GET /auth/v1/user call counts.
//
// deno test runs every module of a directory in one isolate, so entries left
// by other test files (K of them, K ≪ 1 667) shift the eviction boundary by K;
// the assertions below are exact when the file runs alone and remain valid
// (bounded) inside the full suite. The observed boundary is logged.
//
// Run alone: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack3_cache_eviction_test.ts

import { assert, assertEquals } from "@std/assert";
import { cacheGet, sha256Hex } from "../cache.ts";
import {
  edgeRequest,
  ipFor,
  loadAttack3,
  supabaseBearer,
} from "./attack3_harness.ts";

const TOTAL = 5_001;
const CAP = 5_000;
const DROP = Math.ceil(CAP / 3); // 1 667

function userIdFor(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `aaaaaaaa-0000-4000-8000-${hex}`;
}

Deno.test("S3 HELD: 5 001 distinct verified bearers — 1st evicted & re-verified, 5 000th still cached, cap enforced", async () => {
  const attack = await loadAttack3();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const tokens: string[] = [];
  for (let i = 1; i <= TOTAL; i++) {
    tokens.push(supabaseBearer(userIdFor(i), { exp }));
  }

  // Distinct users AND distinct client IPs so no per-user (240/min) or
  // per-IP (1 200/min) budget interferes: only the auth cache is under test.
  const statuses = new Map<number, number>();
  for (let i = 0; i < TOTAL; i++) {
    const response = await attack.harness.handler(
      edgeRequest("GET", "/v1/attack3/nowhere", {
        authorization: `Bearer ${tokens[i]}`,
        ip: ipFor(i + 1),
      }),
    );
    await response.body?.cancel();
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
  }
  // Every bearer was verified upstream exactly once (routing 404 happens AFTER auth).
  assertEquals(
    statuses.get(404),
    TOTAL,
    `status histogram ${JSON.stringify([...statuses])}`,
  );
  assertEquals(
    attack.getUserCalls().length,
    TOTAL,
    "one GET /auth/v1/user per distinct bearer",
  );

  // Read the L1 map through the handler's own module instance (no writes).
  const present: boolean[] = [];
  for (const token of tokens) {
    present.push((await cacheGet(`auth:${await sha256Hex(token)}`)) !== null);
  }
  const evicted = present.filter((p) => !p).length;
  const firstCachedIndex = present.indexOf(true); // 0-based
  console.log(
    JSON.stringify({
      s3: "l1 auth cache after 5 001 inserts",
      evicted,
      cached: TOTAL - evicted,
      firstCachedBearer: firstCachedIndex + 1,
      expectedEvictedWhenAlone: DROP,
      dropCount: DROP,
    }),
  );

  assertEquals(present[0], false, "the 1st bearer was evicted");
  assertEquals(present[CAP - 1], true, "the 5 000th bearer is still cached");
  assertEquals(present[TOTAL - 1], true, "the 5 001st bearer is cached");
  // Exactly one drop-oldest-third round: between 1 and DROP of OUR entries went
  // (DROP minus whatever older entries other test files had left in the map).
  assert(
    evicted >= 1 && evicted <= DROP,
    `evicted ${evicted} not in [1, ${DROP}]`,
  );
  // Eviction is a prefix in insertion order — nothing newer than the boundary is missing.
  for (let i = firstCachedIndex; i < TOTAL; i++) {
    assert(
      present[i],
      `bearer #${i + 1} missing after the eviction boundary (#${
        firstCachedIndex + 1
      })`,
    );
  }
  // The map never exceeded the cap: 5 001 inserts into a 5 000-entry map with
  // no eviction would have left all 5 001 present (evicted === 0), which the
  // assertions above exclude; after the drop it holds TOTAL - evicted ≤ CAP.
  assert(TOTAL - evicted <= CAP, `map would hold ${TOTAL - evicted} > cap`);

  // Behavioural confirmation through the handler.
  attack.reset();
  const again1 = await attack.harness.handler(
    edgeRequest("GET", "/v1/attack3/nowhere", {
      authorization: `Bearer ${tokens[0]}`,
      ip: ipFor(1),
    }),
  );
  await again1.body?.cancel();
  assertEquals(again1.status, 404);
  assertEquals(
    attack.getUserCalls().length,
    1,
    "bearer #1 was re-verified upstream (evicted)",
  );

  attack.reset();
  const again5000 = await attack.harness.handler(
    edgeRequest("GET", "/v1/attack3/nowhere", {
      authorization: `Bearer ${tokens[CAP - 1]}`,
      ip: ipFor(CAP),
    }),
  );
  await again5000.body?.cancel();
  assertEquals(again5000.status, 404);
  assertEquals(
    attack.getUserCalls().length,
    0,
    "bearer #5000 was served from the L1 cache",
  );
});
