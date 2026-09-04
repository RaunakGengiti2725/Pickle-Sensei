// Adjudication reproductions for POST /webhooks/revenuecat on 4d812e1a.
//
// Independent of the auditor branches: a STATEFUL PostgREST fake is layered
// over routesHarness (whose POST/PATCH never persist) so replay / idempotency
// / partial-persistence behaviour is observable. Every "ADJ-*" test asserts
// the EXPECTED contract, so a failure here == the defect reproduces on the
// commit under test. "ADJ-NEG-*" tests pin behaviour that was evaluated and
// found acceptable (they pass on 4d812e1a).
//
// Named *.repro.ts on purpose: it is NOT picked up by `deno task test` (the
// ADJ-* cases fail by design until the defects are fixed). Run explicitly:
//   deno test -A --no-check --config deno.json webhook_adjudication.repro.ts

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import {
  activeSubscriber,
  type Harness,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  SUPABASE_URL,
  TEST_USER_ID,
  webhookRequest,
} from "./routesHarness.ts";

type Row = Record<string, unknown>;

interface Stateful {
  events: Map<string, Row>;
  entitlements: Map<string, Row>;
  entitlementUpserts: Row[];
  /** Return a PostgREST error response for the Nth (0-based) entitlement upsert. */
  failEntitlementUpsert: (n: number) => Response | null;
  failEventLookup: (() => Response) | null;
  failEventUpsert: (() => Response) | null;
  rcStatus: number | null;
  rcUrls: string[];
  restore: () => void;
}

function pgError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ code, message, details: null, hint: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stateful(_h: Harness): Stateful {
  const base = globalThis.fetch;
  const s: Stateful = {
    events: new Map(),
    entitlements: new Map(),
    entitlementUpserts: [],
    failEntitlementUpsert: () => null,
    failEventLookup: null,
    failEventUpsert: null,
    rcStatus: null,
    rcUrls: [],
    restore: () => {
      globalThis.fetch = base;
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    if (url.startsWith(RC_URL)) {
      s.rcUrls.push(url);
      if (s.rcStatus !== null) {
        return new Response(JSON.stringify({ code: 7225, message: "Invalid API key." }), {
          status: s.rcStatus,
          headers: { "Content-Type": "application/json" },
        });
      }
      return base(request);
    }
    if (url.startsWith(`${SUPABASE_URL}/rest/v1/webhook_events`)) {
      if (request.method === "GET") {
        if (s.failEventLookup) return s.failEventLookup();
        const id = new URL(url).searchParams.get("id") ?? "";
        const key = id.startsWith("eq.") ? id.slice(3) : id;
        const row = s.events.get(key);
        const accept = request.headers.get("accept") ?? "";
        if (accept.includes("vnd.pgrst.object+json")) {
          if (!row) {
            // maybeSingle(): PostgREST answers 406/PGRST116 for 0 rows; the
            // client folds that into data:null, error:null.
            return pgError(406, "PGRST116", "0 rows");
          }
          return new Response(JSON.stringify({ id: row.id }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(row ? [{ id: row.id }] : []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (request.method === "POST") {
        if (s.failEventUpsert) return s.failEventUpsert();
        const row = JSON.parse(await request.text()) as Row;
        if (!s.events.has(String(row.id))) s.events.set(String(row.id), row);
        return new Response(null, { status: 201 });
      }
    }
    if (
      url.startsWith(`${SUPABASE_URL}/rest/v1/billing_entitlements`) &&
      request.method === "POST"
    ) {
      const n = s.entitlementUpserts.length;
      const row = JSON.parse(await request.text()) as Row;
      s.entitlementUpserts.push(row);
      const fail = s.failEntitlementUpsert(n);
      if (fail) return fail;
      s.entitlements.set(String(row.user_id), row);
      return new Response(null, { status: 201 });
    }
    return base(request);
  }) as typeof fetch;
  return s;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  return {
    lines,
    restore: () => {
      console.error = origError;
      console.warn = origWarn;
    },
  };
}

const TRANSIENT_DB = () => pgError(503, "57P03", "the database system is starting up");

// ── ADJ-A: transient persistence failure is acknowledged (200) and made
//    permanent by the idempotency row → verified verdict lost forever ─────────

Deno.test(
  "ADJ-A1: transient billing_entitlements failure must NOT be acknowledged 200 nor create the idempotency row",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.failEntitlementUpsert = () => TRANSIENT_DB();
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-a1",
          type: "INITIAL_PURCHASE",
          app_user_id: TEST_USER_ID,
        }),
      );
      const body = await res.json();
      console.log(
        `[ADJ-A1] first delivery → HTTP ${res.status} ${JSON.stringify(
          body,
        )}; audit rows=${s.events.size}; entitlement rows=${s.entitlements.size}; log=${JSON.stringify(
          log.lines,
        )}`,
      );

      // Expected contract: retryable failure (5xx) and no audit row, so RevenueCat
      // re-delivers and the verdict is eventually persisted.
      assertEquals(s.entitlements.size, 0, "precondition: nothing was persisted");
      assert(res.status >= 500 && res.status < 600, `expected retryable 5xx, got ${res.status}`);
      assertEquals(s.events.has("evt-adj-a1"), false, "no idempotency row after a failed delivery");
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-A2: the redelivery of a failed event must re-verify and persist (not short-circuit as duplicate)",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.failEntitlementUpsert = (n) => (n === 0 ? TRANSIENT_DB() : null);
      const first = await h.handler(
        webhookRequest({
          id: "evt-adj-a2",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const firstBody = await first.json();
      const rcAfterFirst = s.rcUrls.length;

      // DB healthy again; RevenueCat redelivers the same event id.
      const second = await h.handler(
        webhookRequest({
          id: "evt-adj-a2",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const secondBody = await second.json();
      console.log(
        `[ADJ-A2] first → ${first.status} ${JSON.stringify(
          firstBody,
        )}; redelivery → ${second.status} ${JSON.stringify(
          secondBody,
        )}; RC calls first=${rcAfterFirst} total=${s.rcUrls.length}; entitlement rows=${s.entitlements.size}; audit rows=${s.events.size}`,
      );

      assertEquals(
        secondBody.duplicate,
        undefined,
        "redelivery must not be treated as a duplicate",
      );
      assertEquals(s.rcUrls.length, rcAfterFirst + 1, "redelivery re-verifies against RevenueCat");
      assertEquals(
        s.entitlements.get(TEST_USER_ID)?.premium,
        true,
        "verdict persisted on redelivery",
      );
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-A3: TRANSFER — a failed transferred_to write must not leave the source revoked with the destination unwritten AND the event marked processed",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      // subject order = transferred_from first, transferred_to second
      s.failEntitlementUpsert = (n) => (n === 1 ? TRANSIENT_DB() : null);
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-a3",
          type: "TRANSFER",
          app_user_id: null,
          transferred_from: [TEST_USER_ID],
          transferred_to: [OTHER_USER_ID],
        }),
      );
      const body = await res.json();
      console.log(
        `[ADJ-A3] TRANSFER → ${res.status} ${JSON.stringify(body)}; upserts=${JSON.stringify(
          s.entitlementUpserts.map((r) => [r.user_id, r.premium]),
        )}; persisted=${JSON.stringify([...s.entitlements.keys()])}; audit rows=${s.events.size}`,
      );

      assertEquals(s.entitlementUpserts.length, 2, "precondition: both sides attempted");
      assertEquals(
        s.entitlements.has(OTHER_USER_ID),
        false,
        "precondition: destination write failed",
      );
      // Expected: either both persisted or the delivery is retryable with no audit row.
      assert(res.status >= 500 && res.status < 600, `expected retryable 5xx, got ${res.status}`);
      assertEquals(
        s.events.has("evt-adj-a3"),
        false,
        "no idempotency row when persistence was partial",
      );
    } finally {
      log.restore();
      s.restore();
    }
  },
);

// ── ADJ-E: RevenueCat auth/rate-limit failures (401/403/429) leave no
//    diagnostic — indistinguishable from a network outage ───────────────────

for (const status of [401, 403, 429]) {
  Deno.test(
    `ADJ-E: RevenueCat ${status} must be logged with its status (not a silent 503)`,
    async () => {
      const h = await loadHarness();
      const s = stateful(h);
      const log = captureConsole();
      try {
        s.rcStatus = status;
        const res = await h.handler(
          webhookRequest({
            id: `evt-adj-e-${status}`,
            type: "RENEWAL",
            app_user_id: TEST_USER_ID,
          }),
        );
        const body = await res.json();
        console.log(
          `[ADJ-E ${status}] → HTTP ${res.status} ${JSON.stringify(
            body,
          )}; console.error/warn lines=${JSON.stringify(log.lines)}`,
        );
        assertEquals(res.status, 503, "precondition: upstream failure is surfaced as 503");
        const diagnostic = log.lines.find(
          (l) => l.includes(String(status)) && /revenuecat/i.test(l),
        );
        assert(
          diagnostic,
          `expected a console diagnostic mentioning RevenueCat ${status}; got ${JSON.stringify(
            log.lines,
          )}`,
        );
      } finally {
        log.restore();
        s.restore();
      }
    },
  );
}

// ── ADJ-F: uppercase-hex uuid subject — sent verbatim to RevenueCat (a
//    DIFFERENT app_user_id there) but folded onto the lowercase Postgres row ─

Deno.test(
  "ADJ-F: uppercase uuid app_user_id must be canonicalised before RevenueCat lookup and before the entitlement upsert",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    try {
      // RevenueCat auto-creates the unknown subject → honest premium:false.
      h.subscriber = {
        entitlements: {},
        subscriptions: {},
      } as unknown as typeof h.subscriber;
      // A hex-letter uuid (TEST_USER_ID is all digits, so case is invisible there).
      const canonical = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const upper = canonical.toUpperCase();
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-f",
          type: "CANCELLATION",
          app_user_id: upper,
        }),
      );
      const body = await res.json();
      console.log(
        `[ADJ-F] → ${res.status} ${JSON.stringify(body)}; RC url=${
          s.rcUrls[0]
        }; upsert user_id=${s.entitlementUpserts[0]?.user_id} premium=${
          s.entitlementUpserts[0]?.premium
        }`,
      );
      assertEquals(res.status, 200);
      assertEquals(s.entitlementUpserts.length, 1, "precondition: subject accepted and persisted");
      assertNotEquals(
        s.rcUrls[0].includes(upper),
        true,
        "uppercase variant must never reach RevenueCat",
      );
      assertStringIncludes(
        s.rcUrls[0],
        canonical,
        "RevenueCat must be asked about the canonical (lowercase) subscriber",
      );
      assertEquals(
        s.entitlementUpserts[0].user_id,
        canonical,
        "row key must be the canonical uuid text",
      );
    } finally {
      s.restore();
    }
  },
);

// ── Negative controls (behaviour judged acceptable / P3 on 4d812e1a) ─────────

Deno.test(
  "ADJ-NEG-1: replay of a fully processed event is acknowledged as duplicate without a RevenueCat round trip",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      const first = await h.handler(
        webhookRequest({
          id: "evt-adj-neg1",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(first.status, 200);
      assertEquals((await first.json()).verified, true);
      const rc = s.rcUrls.length;
      const second = await h.handler(
        webhookRequest({
          id: "evt-adj-neg1",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(second.status, 200);
      assertEquals((await second.json()).duplicate, true);
      assertEquals(s.rcUrls.length, rc);
      assertEquals(s.entitlementUpserts.length, 1);
    } finally {
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-NEG-2: RevenueCat 5xx / unreachable → 503 and no audit row (delivery is retried)",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = null; // harness answers 500
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-neg2",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      assertEquals(res.status, 503);
      await res.text();
      assertEquals(s.events.size, 0);
      assertEquals(s.entitlementUpserts.length, 0);
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-OBS-C: webhook_events lookup failure → processing continues (re-verify + idempotent upsert), no wrong verdict",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.failEventLookup = () => pgError(503, "57P03", "the database system is starting up");
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-c",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const body = await res.json();
      console.log(
        `[ADJ-OBS-C] → ${res.status} ${JSON.stringify(
          body,
        )}; RC calls=${s.rcUrls.length}; upsert premium=${
          s.entitlementUpserts[0]?.premium
        }; log=${JSON.stringify(log.lines)}`,
      );
      assertEquals(res.status, 200);
      assertEquals(body.verified, true);
      assertEquals(s.entitlementUpserts[0]?.premium, true);
      assert(log.lines.some((l) => l.includes("webhook event lookup failed")));
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-OBS-D: audit-row write failure → still 200 after a SUCCESSFUL persist; replay is re-processed (idempotent)",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      s.failEventUpsert = () => pgError(503, "57P03", "the database system is starting up");
      const res = await h.handler(
        webhookRequest({
          id: "evt-adj-d",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const body = await res.json();
      s.failEventUpsert = null;
      const replay = await h.handler(
        webhookRequest({
          id: "evt-adj-d",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const replayBody = await replay.json();
      console.log(
        `[ADJ-OBS-D] first → ${res.status} ${JSON.stringify(
          body,
        )} audit rows=${s.events.size}; replay → ${replay.status} ${JSON.stringify(
          replayBody,
        )}; upserts=${s.entitlementUpserts.length}; log=${JSON.stringify(log.lines)}`,
      );
      assertEquals(res.status, 200);
      assertEquals(s.entitlements.get(TEST_USER_ID)?.premium, true);
      assertEquals(replayBody.duplicate, undefined);
      assertEquals(s.entitlementUpserts.length, 2);
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-OBS-G: two overlapping deliveries for one user — the slower (older) RevenueCat read is persisted last (last-writer-wins)",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    try {
      // RC answers: first request (premium:true) is held until the second
      // (premium:false, i.e. RevenueCat state moved on) has been fully persisted.
      const base = globalThis.fetch;
      let release: (() => void) | null = null;
      const held = new Promise<void>((r) => (release = r));
      let rcCalls = 0;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (request.url.startsWith(RC_URL)) {
          rcCalls += 1;
          if (rcCalls === 1) {
            // Read #1 observes RevenueCat state A (active) NOW; its response is
            // delivered only after read #2 (state B, lapsed) has been persisted.
            h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
            const response = await base(request);
            await held;
            return response;
          }
          h.subscriber = activeSubscriber(new Date(Date.now() - 1000).toISOString()); // lapsed
        }
        return base(request);
      }) as typeof fetch;
      const p1 = h.handler(
        webhookRequest({
          id: "evt-adj-g-1",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      await new Promise((r) => setTimeout(r, 5));
      const r2 = await h.handler(
        webhookRequest({
          id: "evt-adj-g-2",
          type: "EXPIRATION",
          app_user_id: TEST_USER_ID,
        }),
      );
      await r2.text();
      const afterSecond = s.entitlements.get(TEST_USER_ID)?.premium;
      release!();
      const r1 = await p1;
      await r1.text();
      const final = s.entitlements.get(TEST_USER_ID);
      console.log(
        `[ADJ-OBS-G] after EXPIRATION persisted premium=${afterSecond}; after the older RENEWAL read landed premium=${final?.premium} verified_at=${final?.verified_at}; upserts=${JSON.stringify(
          s.entitlementUpserts.map((r) => [r.premium, r.verified_at]),
        )}`,
      );
      assertEquals(afterSecond, false);
      // Observed on 4d812e1a: the stale read overwrites the newer verdict. Window
      // = one RevenueCat round trip; self-heals on the next sync/webhook → P3.
      assertEquals(final?.premium, true);
      globalThis.fetch = base;
    } finally {
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-OBS-J: 4000-byte event id — accepted, persisted verdict correct; audit insert failure (btree limit) only costs the dedupe short-circuit",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    const log = captureConsole();
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      // Real Postgres rejects a 4000-byte btree key (54000 "index row size exceeds maximum").
      s.failEventUpsert = () =>
        pgError(
          400,
          "54000",
          "index row size 4016 exceeds btree version 4 maximum 2704 for index webhook_events_pkey",
        );
      const res = await h.handler(
        webhookRequest({
          id: "x".repeat(4000),
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        }),
      );
      const body = await res.json();
      console.log(
        `[ADJ-OBS-J] → ${res.status} ${JSON.stringify(
          body,
        )}; audit rows=${s.events.size}; premium persisted=${
          s.entitlements.get(TEST_USER_ID)?.premium
        }; log=${JSON.stringify(log.lines)}`,
      );
      assertEquals(res.status, 200);
      assertEquals(body.verified, true);
      assertEquals(s.entitlements.get(TEST_USER_ID)?.premium, true);
    } finally {
      log.restore();
      s.restore();
    }
  },
);

Deno.test(
  "ADJ-NEG-3: concurrent same-id deliveries (check-then-act) — observed behaviour recorded",
  async () => {
    const h = await loadHarness();
    const s = stateful(h);
    try {
      h.subscriber = activeSubscriber(new Date(Date.now() + 86_400_000).toISOString());
      const mk = () =>
        webhookRequest({
          id: "evt-adj-neg3",
          type: "RENEWAL",
          app_user_id: TEST_USER_ID,
        });
      const results = await Promise.all([h.handler(mk()), h.handler(mk()), h.handler(mk())]);
      const bodies = await Promise.all(results.map((r) => r.json()));
      console.log(
        `[ADJ-NEG-3] statuses=${results.map((r) => r.status)} bodies=${JSON.stringify(
          bodies,
        )} RC calls=${s.rcUrls.length} upserts=${s.entitlementUpserts.length} audit rows=${s.events.size}`,
      );
      // Every delivery converges on the same verified verdict; the only cost is
      // redundant RevenueCat reads + idempotent upserts (ignoreDuplicates on the
      // audit row). Not a correctness defect → P3.
      for (const r of results) assertEquals(r.status, 200);
      assertEquals(s.events.size, 1);
      for (const row of s.entitlementUpserts) assertEquals(row.premium, true);
    } finally {
      s.restore();
    }
  },
);
