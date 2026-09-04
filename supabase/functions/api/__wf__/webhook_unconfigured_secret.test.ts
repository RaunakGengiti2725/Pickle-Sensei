// POST /webhooks/revenuecat must fail CLOSED when REVENUECAT_WEBHOOK_AUTH is
// not configured: 503, no RevenueCat call, no database write — even when the
// caller sends an Authorization header (an empty configured secret must never
// match an empty/any header).
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check webhook_unconfigured_secret.test.ts)

import { assertEquals } from "@std/assert";
import {
  loadHarness,
  WEBHOOK_SECRET,
  webhookRequest,
} from "./routesHarness.ts";

async function withoutWebhookSecret(fn: () => Promise<void>): Promise<void> {
  const previous = Deno.env.get("REVENUECAT_WEBHOOK_AUTH");
  Deno.env.delete("REVENUECAT_WEBHOOK_AUTH");
  try {
    await fn();
  } finally {
    if (previous !== undefined) {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", previous);
    }
  }
}

Deno.test("webhook: unset REVENUECAT_WEBHOOK_AUTH → 503 for every caller, nothing touched", async () => {
  const h = await loadHarness();
  await withoutWebhookSecret(async () => {
    for (const authorization of [null, "", WEBHOOK_SECRET, "Bearer anything"]) {
      h.reset();
      const res = await h.handler(
        webhookRequest({ id: "evt-unconfigured", type: "TEST" }, {
          authorization,
        }),
      );
      assertEquals(
        res.status,
        503,
        `authorization=${JSON.stringify(authorization)}`,
      );
      assertEquals(
        h.calls.length,
        0,
        "no RevenueCat/PostgREST call while unconfigured",
      );
    }
  });
});

Deno.test("webhook: empty-string REVENUECAT_WEBHOOK_AUTH is treated as unconfigured (503), not as a matchable secret", async () => {
  const h = await loadHarness();
  const previous = Deno.env.get("REVENUECAT_WEBHOOK_AUTH");
  Deno.env.set("REVENUECAT_WEBHOOK_AUTH", "");
  try {
    h.reset();
    const res = await h.handler(
      webhookRequest({ id: "evt-empty", type: "TEST" }, { authorization: "" }),
    );
    assertEquals(res.status, 503);
    assertEquals(h.calls.length, 0);
  } finally {
    if (previous !== undefined) {
      Deno.env.set("REVENUECAT_WEBHOOK_AUTH", previous);
    }
  }
});

Deno.test("webhook: with the secret configured, the exact value is accepted and near-misses are 401", async () => {
  const h = await loadHarness();
  // (Surrounding whitespace is not a near-miss: the Fetch Headers API strips
  // OWS from header values before the handler ever sees them.)
  for (
    const authorization of [
      WEBHOOK_SECRET.slice(0, -1),
      `${WEBHOOK_SECRET}x`,
      `Bearer ${WEBHOOK_SECRET}`,
      WEBHOOK_SECRET.toUpperCase(),
    ]
  ) {
    h.reset();
    const res = await h.handler(
      webhookRequest({ id: "evt-near-miss", type: "TEST" }, { authorization }),
    );
    assertEquals(
      res.status,
      401,
      `authorization=${JSON.stringify(authorization)}`,
    );
    assertEquals(h.calls.length, 0);
  }
});
