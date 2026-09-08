// ADVERSARIAL test for W11-01 at the rateLimit.ts level (candidate
// 0f4a541a1b587bd199543a19f746e99d089a0f26): per-credential shards are a
// NEW key space that an unauthenticated caller populates at will. Without
// Upstash (the documented per-isolate memory fallback) the window table is
// capped at MEMORY_WINDOW_MAX = 20 000 keys and, once full, every window
// that is not already present reads as Infinity — i.e. 429 for everyone.
//
// A "liveness" refusal charges only the shard (never the egress), so it never
// trips the budget that would otherwise stop the caller: GoTrue answers a
// forged signature with 403 bad_jwt, which the candidate classifies as
// liveness (see attack_w11_01_nat_budget.test.ts, attack 1). Four egresses at
// IP_LIMIT (1 200/min) create 24 000 shard keys inside one 300 s window.
//
// Runs in its own isolate (loadIsolate) so the poisoned table cannot leak
// into the rest of the suite.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json attack_w11_01_memory_cap.test.ts

import { assertEquals, configureRedis, loadIsolate } from "./harness.ts";

const AUTH_FAILURE_LIMIT = { limit: 30, windowSeconds: 300 };
const MEMORY_WINDOW_MAX = 20_000;

Deno.test(
  "attack: liveness refusals from 4 egresses fill the per-isolate window table and lock every newcomer out",
  async () => {
    configureRedis(false);
    const iso = await loadIsolate();
    const { chargeAuthFailure, peekAuthFailureBudget, enforceRateLimit, peekRateLimit } =
      iso.rateLimit;

    // A genuine player already inside the window keeps her budget …
    assertEquals((await enforceRateLimit("user", "player-inside", 240, 60)).allowed, true);

    const egresses = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];
    // 5 001 per egress over a 300 s window is ~1 000/min: under IP_LIMIT.
    const perEgress = Math.ceil((MEMORY_WINDOW_MAX + 1) / egresses.length);
    let refusals = 0;
    let firstDenied: { ip: string; refusals: number } | null = null;
    outer: for (const ip of egresses) {
      for (let i = 0; i < perEgress; i += 1) {
        const identity = `forged-${String(i).padStart(6, "0")}`;
        // The gate every request passes first. A liveness refusal never charges
        // the egress, so only the table itself can ever close it.
        const gate = await peekAuthFailureBudget(ip, identity, AUTH_FAILURE_LIMIT);
        if (!gate.allowed) {
          firstDenied = { ip, refusals };
          break outer;
        }
        await chargeAuthFailure(ip, identity, "liveness", AUTH_FAILURE_LIMIT);
        refusals += 1;
      }
    }

    // … but the rest of the world is now refused: a newcomer's first request
    // from a fresh egress, and a signed-in user's first request this minute.
    const newcomerEgress = await peekAuthFailureBudget("203.0.113.77", null, AUTH_FAILURE_LIMIT);
    const newcomerIp = await enforceRateLimit("ip", "203.0.113.77", 1_200, 60);
    const newUser = await enforceRateLimit("user", "player-next-minute", 240, 60);
    const observed = {
      newcomerAuthGate: newcomerEgress.allowed,
      newcomerIpBudget: newcomerIp.allowed,
      signedInUserBudget: newUser.allowed,
    };
    assertEquals(
      observed,
      { newcomerAuthGate: true, newcomerIpBudget: true, signedInUserBudget: true },
      `${refusals} liveness refusals spread over ${egresses.length} egresses must not deny service to unrelated clients; observed ${JSON.stringify(observed)}; the attacker itself was first refused at ${JSON.stringify(firstDenied)}`,
    );
    assertEquals((await peekRateLimit("user", "player-inside", 240, 60)).remaining, 239);
  },
);
