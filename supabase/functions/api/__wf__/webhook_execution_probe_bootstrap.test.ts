// Execution probe (audit pass 2): the SUPABASE_SERVICE_ROLE_KEY-missing branch
// of POST /webhooks/revenuecat. billingAdminDb() caches the admin client on
// first use, so this branch is only reachable on the FIRST webhook call of a
// process — run this file ALONE (it is excluded from `deno task test`'s
// directory run only by virtue of being invoked explicitly here):
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json webhook_execution_probe_bootstrap.test.ts

import { assertEquals } from "@std/assert";
import { activeSubscriber, loadHarness, TEST_USER_ID, webhookRequest } from "./routesHarness.ts";

Deno.test(
  "probe(bootstrap): missing service-role key → 503 before RC; key restored → next call succeeds",
  async (t) => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const saved = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    await t.step("first call without the key is a 503 and touches nothing", async () => {
      Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
      try {
        const res = await h.handler(
          webhookRequest({ id: "evt-nosr", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(res.status, 503);
        assertEquals(await res.json(), {
          error: { message: "Webhook processing is not configured." },
        });
        assertEquals(h.calls.length, 0);
      } finally {
        Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", saved);
      }
    });

    await t.step(
      "with the key restored the lazy client is created and the event is processed",
      async () => {
        const res = await h.handler(
          webhookRequest({ id: "evt-nosr-2", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        );
        assertEquals(res.status, 200);
        assertEquals(await res.json(), { received: true, verified: true });
        assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 1);
      },
    );
  },
);
