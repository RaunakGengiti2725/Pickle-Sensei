// stress — smoke: the fault harness boots the real handler and a plain
// withdraw round-trips through the stateful PostgREST fake.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json stress_consent_withdraw_smoke.test.ts

import { assert, assertEquals } from "@std/assert";
import {
  loadStressHarness,
  observe,
  Prng,
  scopesOf,
  STRESS_SEED,
  withdrawRequest,
} from "./stress_consent_withdraw_harness.ts";

Deno.test("smoke: withdraw model_training folds to withdrawn with exactly auth + read + insert + read", async () => {
  const h = await loadStressHarness();
  const prng = new Prng(STRESS_SEED);
  const userId = prng.uuid();
  const session = h.mintSession(userId);
  const observed = await observe(
    h.handler,
    withdrawRequest(session.accessToken, {
      scope: "model_training",
      source: "mobile_settings",
      device: "iPhone17,1 iOS 26.0",
    }),
  );
  assertEquals(observed.status, 200, JSON.stringify(observed.body));
  const scopes = scopesOf(observed.body);
  assert(scopes);
  const mt = scopes.find((s) => s.scope === "model_training")!;
  assertEquals(mt.active, false);
  assertEquals(mt.lastAction, "withdrawn");
  assertEquals(h.callsTo("auth").length, 1);
  assertEquals(h.callsTo("postgrest", "GET").length, 2);
  assertEquals(h.callsTo("postgrest", "POST").length, 1);
  assertEquals(h.callsTo("redis").length, 0);
  assertEquals(h.callsTo("revenuecat").length, 0);
  assertEquals(h.callsTo("other").length, 0);
  assertEquals(h.rowsFor(userId).length, 1);
  assertEquals(h.rowsFor(userId)[0].device, "iPhone17,1 iOS 26.0");
  assert(observed.requestId);
});
