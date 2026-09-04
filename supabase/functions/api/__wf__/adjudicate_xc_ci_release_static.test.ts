// Adjudication repros for cluster xc-ci-release-static (XC-RS-04, XC-RS-05).
//
//   cd supabase/functions/api/__wf__
//   deno test -A --no-check --config deno.json --filter 'WEBHOOK-1' adjudicate_xc_ci_release_static.test.ts
//   deno test -A --no-check --config deno.json --filter 'COPY-1'    adjudicate_xc_ci_release_static.test.ts

import { assert, assertEquals } from "@std/assert";
import { PRIVACY_POLICY_TEXT, SUPPORT_TEXT, TERMS_TEXT } from "../legal.ts";
import { activeSubscriber, loadHarness, TEST_USER_ID, webhookRequest } from "./routesHarness.ts";

/** Runs `fn` with PostgREST rejecting every billing_entitlements write the
 * way a transient outage does (the fetch itself throws). */
async function withBillingPersistThrowing<T>(fn: () => Promise<T>): Promise<T> {
  const stubbedFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/rest/v1/billing_entitlements")) {
      return Promise.reject(new TypeError("connection reset by peer"));
    }
    return stubbedFetch(input, init);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = stubbedFetch;
  }
}

Deno.test(
  "WEBHOOK-1: a valid RevenueCat event whose verdict cannot be persisted is answered 503 (RevenueCat retries), never 200",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const res = await withBillingPersistThrowing(() =>
      h.handler(
        webhookRequest({
          id: "evt-persist-throws",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      ),
    );
    const body = await res.json();
    assertEquals(
      res.status,
      503,
      `expected 503 so RevenueCat retries; got ${res.status} ${JSON.stringify(body)}`,
    );
    // No audit row: the event was NOT handled to completion, so the retry
    // must be fully re-processed rather than short-circuited as a duplicate.
    assertEquals(h.callsTo("/rest/v1/webhook_events").filter((c) => c.method === "POST").length, 0);
  },
);

const FORBIDDEN_STORE_COPY =
  /Android|Google Play|Play Store|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA/gi;

function forbiddenHits(name: string, text: string): string[] {
  const hits: string[] = [];
  text.split("\n").forEach((line, index) => {
    for (const match of line.matchAll(FORBIDDEN_STORE_COPY)) {
      hits.push(`${name}:${index + 1} "${match[0]}"`);
    }
  });
  return hits;
}

Deno.test(
  "COPY-1: store-facing legal copy (/privacy, /terms, /support) contains no forbidden term (APP_STORE_SUBMISSION.md §0 rule 4)",
  () => {
    const hits = [
      ...forbiddenHits("PRIVACY_POLICY_TEXT", PRIVACY_POLICY_TEXT),
      ...forbiddenHits("TERMS_TEXT", TERMS_TEXT),
      ...forbiddenHits("SUPPORT_TEXT", SUPPORT_TEXT),
    ];
    assert(hits.length === 0, `forbidden-term hits:\n  ${hits.join("\n  ")}`);
  },
);
