// Adversarial variants against candidate ff26c54a (XC-RS-04 fix): the
// RevenueCat webhook must answer 503 for ANY transient persistence failure —
// in any position of a TRANSFER pair, whatever shape PostgREST's failure takes
// — and a retry after a 503 must be fully re-processed (no audit row, both
// verdicts re-persisted).
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json attack_fix_ff26c54a_webhook_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  activeSubscriber,
  loadHarness,
  OTHER_USER_ID,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

type Failure = Error | Response;

/** Fails billing_entitlements writes, optionally only for one user_id. */
async function withPersistFailing<T>(
  failure: Failure,
  fn: () => Promise<T>,
  onlyUserId?: string,
): Promise<T> {
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/rest/v1/billing_entitlements")) {
      let userId: unknown = undefined;
      try {
        const raw = init?.body;
        if (typeof raw === "string") userId = JSON.parse(raw).user_id;
      } catch {
        // not JSON → treat as matching
      }
      if (!onlyUserId || userId === onlyUserId) {
        return failure instanceof Response
          ? Promise.resolve(failure.clone())
          : Promise.reject(failure);
      }
    }
    return stubbedFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = stubbedFetch;
  }
}

function silenced<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = original;
  });
}

const fkViolation = () =>
  new Response(
    JSON.stringify({
      code: "23503",
      message: 'insert or update on table "billing_entitlements" violates foreign key constraint',
    }),
    { status: 409, headers: { "Content-Type": "application/json" } },
  );

function transferEvent(id: string) {
  return {
    id,
    type: "TRANSFER",
    transferred_from: [TEST_USER_ID],
    transferred_to: [OTHER_USER_ID],
  };
}

Deno.test(
  "ATTACK W-01: TRANSFER pair, the SECOND verdict's persist throws → 503, no audit row; the retry re-persists BOTH and answers 200",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const first = await silenced(() =>
      withPersistFailing(
        new TypeError("error sending request: connection reset"),
        () => h.handler(webhookRequest(transferEvent("evt-transfer-partial"))),
        OTHER_USER_ID,
      ),
    );
    assertEquals(first.status, 503, await first.text());
    // The harness records only calls that reached it: the first side's upsert
    // succeeded (partial persistence), the second was rejected by the wrapper.
    const persistedFirst = h
      .callsTo("/rest/v1/billing_entitlements")
      .filter((c) => c.method === "POST");
    assertEquals(
      persistedFirst.map((c) => (c.body as { user_id: string }).user_id),
      [TEST_USER_ID],
    );
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);

    // RevenueCat retries the same event id; nothing was audited so the
    // duplicate short-circuit must not fire and both verdicts are re-written.
    h.calls = [];
    const retry = await h.handler(webhookRequest(transferEvent("evt-transfer-partial")));
    assertEquals(retry.status, 200);
    assertEquals(await retry.json(), { received: true, verified: true });
    const persistedRetry = h
      .callsTo("/rest/v1/billing_entitlements")
      .filter((c) => c.method === "POST");
    assertEquals(
      persistedRetry.map((c) => (c.body as { user_id: string }).user_id).sort(),
      [TEST_USER_ID, OTHER_USER_ID].sort(),
    );
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 1);
  },
);

Deno.test(
  "ATTACK W-02: TRANSFER pair, FIRST verdict hits the definitive FK path and the SECOND is transient → 503 (transient wins over the acknowledged FK skip)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await silenced(() =>
      withPersistFailing(
        fkViolation(),
        () =>
          withPersistFailing(
            new TypeError("connection reset"),
            () => h.handler(webhookRequest(transferEvent("evt-transfer-fk-then-transient"))),
            OTHER_USER_ID,
          ),
        TEST_USER_ID,
      ),
    );
    assertEquals(res.status, 503, await res.text());
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
  },
);

Deno.test(
  "ATTACK W-03: PostgREST gateway failure with a NON-JSON body (HTML 502) → 503, never 200",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await silenced(() =>
      withPersistFailing(
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 502,
          headers: { "Content-Type": "text/html" },
        }),
        () =>
          h.handler(
            webhookRequest({ id: "evt-html-502", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 503, await res.text());
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
  },
);

Deno.test(
  "ATTACK W-04: insufficient_privilege (42501, a grant regression) is NOT acknowledged as handled → 503 so the event is not silently dropped",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await silenced(() =>
      withPersistFailing(
        new Response(
          JSON.stringify({
            code: "42501",
            message: "permission denied for table billing_entitlements",
          }),
          { status: 403, headers: { "Content-Type": "application/json" } },
        ),
        () =>
          h.handler(
            webhookRequest({ id: "evt-grant-42501", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 503);
    const text = await res.text();
    assert(!text.includes("42501") && !text.includes("permission denied"), text);
  },
);

Deno.test(
  "ATTACK W-05: FK violation for BOTH sides of a TRANSFER pair → 200 verified:false with exactly one audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await silenced(() =>
      withPersistFailing(fkViolation(), () =>
        h.handler(webhookRequest(transferEvent("evt-transfer-fk-both"))),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 1);
  },
);

Deno.test(
  "ATTACK W-07 (neighbourhood): POST /v1/billing/sync keeps answering 503 with a generic body for every persist failure shape after the return-type change",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.rpcs["access_state"] = [{ premium: false, scored_count: 0, reserved_count: 0 }];
    for (const [label, failure] of [
      ["thrown", new TypeError("error sending request: connection reset")],
      ["fk", fkViolation()],
      [
        "pg-5xx",
        new Response(JSON.stringify({ code: "57P01", message: "terminating connection" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ],
    ] as Array<[string, Failure]>) {
      const res = await silenced(() =>
        withPersistFailing(failure, () =>
          h.handler(userRequest("POST", "/v1/billing/sync", { ip: `198.51.100.${label.length}` })),
        ),
      );
      assertEquals(res.status, 503, label);
      const text = await res.text();
      assert(
        !text.includes("57P01") && !text.includes("terminating") && !text.includes("foreign key"),
        `${label}: ${text}`,
      );
    }
  },
);

Deno.test(
  "ATTACK W-06: an event already audited is acknowledged as duplicate without re-verifying, even when persistence would fail now",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    h.tables["webhook_events"] = [{ id: "evt-already-seen" }];
    const res = await silenced(() =>
      withPersistFailing(new TypeError("connection reset"), () =>
        h.handler(
          webhookRequest({ id: "evt-already-seen", type: "RENEWAL", app_user_id: TEST_USER_ID }),
        ),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, duplicate: true });
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
  },
);
