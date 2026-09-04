// Adjudication reproductions ADJ-A1/A2/A3 (finding WEBHOOK-P1-PERSIST-ACK),
// PLUMBING-ADAPTED for the insert-first webhook_events protocol on the
// integrated head: the original stateful fake (branch
// devin/adjudicate-edge-billing-webhook, 00fca1a4) answered the webhook_events
// POST with a bodiless 201 regardless of `Prefer: return=representation`,
// which the insert-first reservation reads as "lost the reservation" and
// times out as 503 "in flight" with ZERO RevenueCat calls — i.e. the persist
// step under test was never reached. The fake is replaced by the in-tree
// PostgREST stand-in (webhookSim.ts). The ASSERTIONS are the original ones,
// verbatim; only the fault injection plumbing changed.
//
// Run explicitly:
//   deno test -A --no-check --config deno.json --filter 'ADJ-A' webhook_adjudication.repro.ts

import { assert, assertEquals } from "@std/assert";
import { activeSubscriber, OTHER_USER_ID, TEST_USER_ID, webhookRequest } from "./routesHarness.ts";
import { ENTITLEMENTS_URL, simulate } from "./webhookSim.ts";

const TRANSIENT_DB = {
  status: 503,
  body: { code: "57P03", message: "the database system is starting up" },
};

Deno.test(
  "ADJ-A1: transient billing_entitlements failure must NOT be acknowledged 200 nor create the idempotency row",
  async () => {
    const s = await simulate();
    try {
      s.h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...TRANSIENT_DB,
        times: Number.MAX_SAFE_INTEGER,
      });
      const res = await s.h.handler(
        webhookRequest({ id: "evt-adj-a1", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID }),
      );
      const body = await res.json();
      const observed = {
        status: res.status,
        body,
        auditRows: s.auditRows.size,
        entitlementRows: s.entitlementRows.size,
        rcCalls: s.rcCalls(),
        upsertAttempts: s.entitlementUpserts(),
        log: s.errors,
      };
      console.log(`[ADJ-A1] ${JSON.stringify(observed)}`);

      assertEquals(s.entitlementRows.size, 0, "precondition: nothing was persisted");
      assertEquals(s.entitlementUpserts(), 1, "precondition: the persist step was reached");
      assert(res.status >= 500 && res.status < 600, `expected retryable 5xx, got ${res.status}`);
      assertEquals(
        s.auditRows.has("evt-adj-a1"),
        false,
        "no idempotency row after a failed delivery",
      );
    } finally {
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-A2: the redelivery of a failed event must re-verify and persist (not short-circuit as duplicate)",
  async () => {
    const s = await simulate();
    try {
      s.h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.faults.push({
        match: (m, u) => m === "POST" && u.startsWith(ENTITLEMENTS_URL),
        ...TRANSIENT_DB,
        times: 1,
      });
      const event = { id: "evt-adj-a2", type: "RENEWAL", app_user_id: TEST_USER_ID };
      const first = await s.h.handler(webhookRequest(event));
      const firstBody = await first.json();
      const rcAfterFirst = s.rcCalls();

      const second = await s.h.handler(webhookRequest(event));
      const secondBody = await second.json();
      const observed = {
        first: first.status,
        firstBody,
        redelivery: second.status,
        secondBody,
        rcCallsFirst: rcAfterFirst,
        rcCallsTotal: s.rcCalls(),
        entitlementRows: s.entitlementRows.size,
        auditRows: s.auditRows.size,
      };
      console.log(`[ADJ-A2] ${JSON.stringify(observed)}`);

      assertEquals(rcAfterFirst, 1, "precondition: first delivery reached RevenueCat");
      assertEquals(
        secondBody.duplicate,
        undefined,
        "redelivery must not be treated as a duplicate",
      );
      assertEquals(s.rcCalls(), rcAfterFirst + 1, "redelivery re-verifies against RevenueCat");
      assertEquals(
        s.entitlementRows.get(TEST_USER_ID)?.premium,
        true,
        "verdict persisted on redelivery",
      );
    } finally {
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-A3: TRANSFER — a failed transferred_to write must not leave the source revoked with the destination unwritten AND the event marked processed",
  async () => {
    const s = await simulate();
    try {
      s.h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      // subject order = transferred_from first, transferred_to second
      s.faults.push({
        match: (m, u) =>
          m === "POST" && u.startsWith(ENTITLEMENTS_URL) && s.entitlementUpserts() === 2,
        ...TRANSIENT_DB,
        times: 1,
      });
      const res = await s.h.handler(
        webhookRequest({
          id: "evt-adj-a3",
          type: "TRANSFER",
          app_user_id: null,
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      const body = await res.json();
      const observed = {
        status: res.status,
        body,
        upsertAttempts: s.entitlementUpserts(),
        persisted: [...s.entitlementRows.keys()],
        auditRows: s.auditRows.size,
      };
      console.log(`[ADJ-A3] ${JSON.stringify(observed)}`);

      assertEquals(s.entitlementUpserts(), 2, "precondition: both sides attempted");
      assertEquals(
        s.entitlementRows.has(OTHER_USER_ID),
        false,
        "precondition: destination write failed",
      );
      assert(res.status >= 500 && res.status < 600, `expected retryable 5xx, got ${res.status}`);
      assertEquals(
        s.auditRows.has("evt-adj-a3"),
        false,
        "no idempotency row when persistence was partial",
      );
    } finally {
      s.restore();
    }
  },
);
