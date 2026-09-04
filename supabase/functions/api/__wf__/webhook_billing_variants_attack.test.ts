// Adversarial variants of the XCM-08/09/10 pins (attack on a1b2c248).
//
// Each test kills a mutant added to mutation/mutants.ts that SURVIVES the
// permanent suite at a1b2c248 (`--mode existing`), i.e. a neighbourhood the
// promoted pins in webhook_billing_invariants.test.ts do not cover:
//
//   SEC-10  the webhook budget is charged only AFTER the secret matches —
//           wrong-secret guessing is unlimited (the "pre-auth" budget is gone
//           while the 241-authenticated-deliveries pin still passes).
//   BODY-15 a 4xx from RevenueCat (401 rotated key / 403 / 404 / 429) is
//           folded as "no entitlements" and persisted — premium revoked for
//           every subscriber the webhook touches during a key rotation or a
//           RevenueCat rate-limit — while the 5xx / malformed-2xx pins pass.
//   BODY-16 with no RevenueCat API key configured the WEBHOOK path answers
//           premium:false and persists it, instead of 503 unavailable (the
//           SYNC-05 pin only covers POST /v1/billing/sync).
//
//   deno run -A mutation/run_mutations.ts --mode existing \
//     --only SEC-10-rate-limit-only-after-secret,BODY-15-rc-4xx-as-empty,BODY-16-no-rc-key-as-empty
//   → 3 SURVIVED at a1b2c248;  --mode all → 3 KILLED (this file).

import { assert, assertEquals } from "@std/assert";
import {
  loadAttackHarness,
  withEnvUnset,
  withFrozenRateLimitWindow,
  type AttackHarness,
} from "./attackHarness.ts";
import {
  RC_URL,
  TEST_USER_ID,
  WEBHOOK_SECRET,
  activeSubscriber,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const ENTITLEMENTS = "/rest/v1/billing_entitlements";
const AUDIT = "/rest/v1/webhook_events";
const auditWrites = (h: AttackHarness) => h.callsTo(AUDIT).filter((c) => c.method === "POST");

Deno.test(
  "webhook attack[SEC-10]: the per-IP webhook budget is charged PRE-auth — 240 wrong-secret guesses exhaust it, the 241st guess is 429 (not 401) and the correct secret from that address is 429 too",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    const ip = "198.51.100.79";
    await withFrozenRateLimitWindow(60, async () => {
      for (let i = 0; i < 240; i += 1) {
        const guess = await h.handler(
          webhookRequest(
            { id: `evt-guess-${i}`, type: "RENEWAL", app_user_id: TEST_USER_ID },
            { ip, authorization: `${WEBHOOK_SECRET}-guess-${i}` },
          ),
        );
        assertEquals(guess.status, 401, `guess ${i + 1}`);
        await guess.text();
      }
      const exhausted = await h.handler(
        webhookRequest(
          { id: "evt-guess-241", type: "RENEWAL", app_user_id: TEST_USER_ID },
          { ip, authorization: `${WEBHOOK_SECRET}-guess-241` },
        ),
      );
      assertEquals(exhausted.status, 429, "241st wrong-secret guess must hit the budget");
      assertEquals(exhausted.headers.get("retry-after"), "60");
      await exhausted.text();

      // The budget is per source address, not per outcome: a correct delivery
      // from the exhausted address waits for the window too …
      const genuine = await h.handler(
        webhookRequest({ id: "evt-guess-ok", type: "RENEWAL", app_user_id: TEST_USER_ID }, { ip }),
      );
      assertEquals(genuine.status, 429);
      await genuine.text();
      // … while another address is unaffected.
      const other = await h.handler(
        webhookRequest(
          { id: "evt-guess-other", type: "RENEWAL", app_user_id: TEST_USER_ID },
          { ip: "198.51.100.80" },
        ),
      );
      assertEquals(other.status, 200);
      await other.text();
    });
    assertEquals(h.callsTo(RC_URL).length, 1, "only the other address was verified");
  },
);

Deno.test(
  "webhook attack[BODY-15]: a 4xx from RevenueCat is 'unavailable' — webhook 503 with nothing persisted and no audit row; sync 502 billing_unavailable",
  async () => {
    const h = await loadAttackHarness();
    h.rpcs["access_state"] = [{ premium: true, scored_count: 0, reserved_count: 0 }];
    const statuses = [401, 403, 404, 429];
    for (const status of statuses) {
      h.override((request) =>
        request.url.startsWith(RC_URL)
          ? new Response(JSON.stringify({ code: 7225, message: `rc ${status}` }), {
              status,
              headers: { "Content-Type": "application/json" },
            })
          : null,
      );
      const hook = await h.handler(
        webhookRequest({ id: `evt-rc-${status}`, type: "RENEWAL", app_user_id: TEST_USER_ID }),
      );
      assertEquals(hook.status, 503, `webhook on RevenueCat ${status}`);
      assertEquals(await hook.json(), {
        error: { message: "Verification is temporarily unavailable." },
      });

      const sync = await h.handler(
        userRequest("POST", "/v1/billing/sync", {
          ip: `198.51.100.${100 + statuses.indexOf(status)}`,
        }),
      );
      assertEquals(sync.status, 502, `sync on RevenueCat ${status}`);
      const body = await sync.json();
      assertEquals(body.error.code, "billing_unavailable");
      assertEquals(body.billing, undefined);
    }
    assertEquals(h.callsTo(RC_URL).length, statuses.length * 2);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0, "a 4xx must never persist premium:false");
    assertEquals(auditWrites(h).length, 0, "a 503'd delivery leaves no audit row");
    h.override(null);
  },
);

Deno.test(
  "webhook attack[BODY-16]: with no RevenueCat API key the webhook is 503 unavailable — no RevenueCat call, nothing persisted, no audit row (RevenueCat retries once the key is set)",
  async () => {
    const h = await loadAttackHarness();
    h.subscriber = activeSubscriber();
    h.tables["billing_entitlements"] = [
      { user_id: TEST_USER_ID, premium: true, product_key: "pickle_sensei_pro_monthly" },
    ];
    await withEnvUnset(["REVENUECAT_SECRET_API_KEY", "REVENUECAT_PUBLIC_SDK_KEY"], async () => {
      const res = await h.handler(
        webhookRequest({ id: "evt-no-rc-key", type: "EXPIRATION", app_user_id: TEST_USER_ID }),
      );
      assertEquals(res.status, 503);
      assertEquals(await res.json(), {
        error: { message: "Verification is temporarily unavailable." },
      });
    });
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo(ENTITLEMENTS).length, 0, "misconfiguration must not revoke premium");
    assertEquals(auditWrites(h).length, 0);
    assert(
      h.callsTo(AUDIT).every((c) => c.method === "GET"),
      "only the dedupe lookup may touch webhook_events",
    );
  },
);
