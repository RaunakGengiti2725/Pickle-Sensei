// RevenueCat webhook delivery semantics (XC-RS-04): RevenueCat retries a
// delivery only on a non-2xx answer, so the status code IS the retry
// contract. A verdict that could not be persisted must NOT be acknowledged.
//
//   200 → handled to completion (verdict persisted, audit row written)
//   401 → definitive rejection (bad Authorization) — no verification, no retry
//   503 → transient failure (verdict not persisted) — RevenueCat retries; no
//         audit row so the retry is fully re-processed, never short-circuited
//         as a duplicate

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  loadHarness,
  RC_URL,
  TEST_USER_ID,
  webhookRequest,
} from "./routesHarness.ts";

/** Wraps the harness fetch so PostgREST writes to billing_entitlements fail
 * with `failure` (a thrown network error, or a PostgREST error response). */
async function withBillingPersistFailing<T>(
  failure: Error | Response,
  fn: () => Promise<T>,
): Promise<T> {
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/rest/v1/billing_entitlements")) {
      return failure instanceof Response
        ? Promise.resolve(failure.clone())
        : Promise.reject(failure);
    }
    return stubbedFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = stubbedFetch;
  }
}

async function captureErrorLogs<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const logs: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    logs.push(
      args.map((a) => (typeof a === "string" ? a : (JSON.stringify(a) ?? String(a)))).join(" "),
    );
  };
  try {
    return { result: await fn(), logs };
  } finally {
    console.error = original;
  }
}

Deno.test(
  "revenuecat webhook: persisted verdict → 200 verified:true with an audit row",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest({ id: "evt-rc-ok", type: "INITIAL_PURCHASE", app_user_id: TEST_USER_ID }),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: true });
    const persisted = h.callsTo("/rest/v1/billing_entitlements").filter((c) => c.method === "POST");
    assertEquals(persisted.length, 1);
    const audit = h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST");
    assertEquals(audit.length, 1);
  },
);

Deno.test(
  "revenuecat webhook: invalid Authorization → 401 before any RevenueCat or database work (no retry path)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await h.handler(
      webhookRequest(
        { id: "evt-rc-bad-auth", type: "RENEWAL", app_user_id: TEST_USER_ID },
        { authorization: "not-the-secret" },
      ),
    );
    assertEquals(res.status, 401);
    assertEquals(h.calls.filter((c) => c.url.startsWith(RC_URL)).length, 0);
    assertEquals(h.callsTo("/rest/v1/").length, 0);
  },
);

Deno.test(
  "revenuecat webhook: persistence throws → 503 (RevenueCat retries), no audit row, failure logged with the event id",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res, logs } = await captureErrorLogs(() =>
      withBillingPersistFailing(new TypeError("error sending request: connection reset"), () =>
        h.handler(
          webhookRequest({
            id: "evt-rc-persist-throws",
            type: "RENEWAL",
            app_user_id: TEST_USER_ID,
          }),
        ),
      ),
    );
    const body = await res.json();
    assertEquals(res.status, 503, `got ${res.status} ${JSON.stringify(body)}`);
    assertEquals(body.received, undefined);
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
    const failureLog = logs.find((line) => line.includes("webhook verdict persist failed"));
    assert(failureLog, `no persist-failure log; logs=${JSON.stringify(logs)}`);
    assertStringIncludes(failureLog, "evt-rc-persist-throws");
  },
);

Deno.test(
  "revenuecat webhook: PostgREST 5xx on persist → 503 with a generic body (detail only in logs)",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res, logs } = await captureErrorLogs(() =>
      withBillingPersistFailing(
        new Response(
          JSON.stringify({
            code: "57P01",
            message: "terminating connection due to administrator command",
          }),
          { status: 503, headers: { "Content-Type": "application/json" } },
        ),
        () =>
          h.handler(
            webhookRequest({ id: "evt-rc-pg-5xx", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 503);
    const text = await res.text();
    assert(!text.includes("57P01") && !text.includes("terminating connection"), text);
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
    assert(
      logs.some((line) => line.includes("evt-rc-pg-5xx")),
      JSON.stringify(logs),
    );
  },
);

Deno.test(
  "revenuecat webhook: subscriber without an account row (FK violation) is definitive → 200 verified:false, audited, no retry",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const { result: res } = await captureErrorLogs(() =>
      withBillingPersistFailing(
        new Response(
          JSON.stringify({
            code: "23503",
            message:
              'insert or update on table "billing_entitlements" violates foreign key constraint',
          }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
        () =>
          h.handler(
            webhookRequest({ id: "evt-rc-no-profile", type: "RENEWAL", app_user_id: TEST_USER_ID }),
          ),
      ),
    );
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { received: true, verified: false });
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 1);
  },
);
