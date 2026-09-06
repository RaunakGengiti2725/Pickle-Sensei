// GET /v1/catalog/drills[/:slug], GET/PUT/DELETE /v1/me/saved-drills,
// POST /v1/billing/sync, GET /healthz — through the real handler.
//
// Run: deno test -A --no-check --config deno.json   (inside __wf__/)

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import { captureAccessLog } from "../http.ts";
import {
  activeSubscriber,
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";
import { simulate } from "./webhookSim.ts";

const ACCESS_ROW = [{ premium: false, scored_count: 0, reserved_count: 0 }];

// ── drills ───────────────────────────────────────────────────────────────────

Deno.test(
  "catalog list: whole static catalog, cursor null, ONE saved-slug query, saved flags merged",
  async () => {
    const h = await loadHarness();
    const catalog = await drillCatalog();
    h.tables["user_saved_drills"] = [{ slug: catalog[0].slug }];
    const res = await h.handler(userRequest("GET", "/v1/catalog/drills", { ip: "198.51.100.1" }));
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assertEquals(body.cursor, null);
    assertEquals(body.items.length, catalog.length);
    assertEquals(body.items[0].saved, true);
    assertEquals(body.items[1].saved, false);
    assert(
      body.items.every((item: Record<string, unknown>) => item.validation_state === "PUBLISHED"),
    );
    const dbCalls = h.callsTo("/rest/v1/user_saved_drills");
    assertEquals(dbCalls.length, 1);
    assert(dbCalls[0].url.includes(`user_id=eq.${TEST_USER_ID}`));
  },
);

Deno.test(
  "catalog list: q/family filters narrow the static catalog; unknown family → empty items (not an error)",
  async () => {
    const h = await loadHarness();
    const catalog = await drillCatalog();
    const family = catalog[0].families[0];
    const byFamily = await h.handler(
      userRequest("GET", `/v1/catalog/drills?family=${encodeURIComponent(family)}`, {
        ip: "198.51.100.2",
      }),
    );
    const items = (await byFamily.json()).items as Array<{ families: string[] }>;
    assert(items.length > 0 && items.length < catalog.length);
    assert(items.every((item) => item.families.includes(family)));

    const none = await h.handler(
      userRequest("GET", "/v1/catalog/drills?family=no-such-family", {
        ip: "198.51.100.2",
      }),
    );
    assertEquals(none.status, 200);
    assertEquals((await none.json()).items, []);

    const byQ = await h.handler(
      userRequest(
        "GET",
        `/v1/catalog/drills?q=${encodeURIComponent(catalog[0].title.slice(0, 8))}`,
        {
          ip: "198.51.100.2",
        },
      ),
    );
    const qItems = (await byQ.json()).items as Array<{ slug: string }>;
    assert(qItems.some((item) => item.slug === catalog[0].slug));
  },
);

Deno.test(
  "catalog detail: drill + empty mappings + youtube-nocookie embed media; unknown slug → 404 coded",
  async () => {
    const h = await loadHarness();
    const catalog = await drillCatalog();
    const withMedia = (
      await Promise.all(
        catalog.map(async (d) => ({
          d,
          media: await drillInstructionalMedia(d.slug),
        })),
      )
    ).find((x) => x.media.length > 0)!;
    const res = await h.handler(
      userRequest("GET", `/v1/catalog/drills/${withMedia.d.slug}`, {
        ip: "198.51.100.3",
      }),
    );
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.drill.slug, withMedia.d.slug);
    assertEquals(body.drill.saved, false);
    assertEquals(body.mappings, []);
    assertEquals(body.instructionalMedia.length, withMedia.media.length);
    for (const media of body.instructionalMedia) {
      assert(String(media.embedUrl).startsWith("https://www.youtube-nocookie.com/embed/"));
      assertEquals(media.provider, "youtube");
      assert(media.attribution.length > 0 && media.creatorName.length > 0);
    }

    const missing = await h.handler(
      userRequest("GET", "/v1/catalog/drills/not-a-real-drill", {
        ip: "198.51.100.3",
      }),
    );
    assertEquals(missing.status, 404);
    assertEquals((await missing.json()).error.code, "drill.not_found");
    // The 404 short-circuits before any DB query.
    assertEquals(h.callsTo("/rest/v1/user_saved_drills").length, 1);
  },
);

Deno.test("drill ids are deterministic across calls (catalog + media)", async () => {
  const a = await drillCatalog();
  const b = await drillCatalog();
  assertEquals(
    a.map((d) => d.id),
    b.map((d) => d.id),
  );
  const m1 = await drillInstructionalMedia(a[0].slug);
  const m2 = await drillInstructionalMedia(a[0].slug);
  assertEquals(m1, m2);
});

Deno.test(
  "saved drills list: catalog entries hydrated in-memory, no per-row DB queries",
  async () => {
    const h = await loadHarness();
    const catalog = await drillCatalog();
    h.tables["user_saved_drills"] = catalog.slice(0, 5).map((d, i) => ({
      slug: d.slug,
      saved_at: new Date(Date.now() - i * 1000).toISOString(),
    }));
    const res = await h.handler(userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.4" }));
    assertEquals(res.status, 200);
    const items = (await res.json()).items as Array<Record<string, unknown>>;
    assertEquals(items.length, 5);
    assertEquals(items[0].id, catalog[0].id);
    assertEquals(h.callsTo("/rest/v1/user_saved_drills").length, 1);
  },
);

Deno.test(
  "PUT /v1/me/saved-drills/:slug refuses noncatalog slugs with 404 and no write",
  async () => {
    const h = await loadHarness();
    h.tables["user_saved_drills"] = [
      {
        slug: "not-a-real-drill",
        saved_at: new Date().toISOString(),
      },
    ];
    const res = await h.handler(
      userRequest("PUT", "/v1/me/saved-drills/not-a-real-drill", {
        ip: "198.51.100.5",
      }),
    );
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error.code, "drill.not_found");
    // The row was actually written.
    const writes = h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "POST");
    assertEquals(writes.length, 0);
  },
);

Deno.test("REPRO (defect): orphaned bookmark gets a NEW random id on every list call", async () => {
  const h = await loadHarness();
  h.tables["user_saved_drills"] = [
    {
      slug: "not-a-real-drill",
      saved_at: new Date().toISOString(),
    },
  ];
  const first = (
    await (
      await h.handler(userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.6" }))
    ).json()
  ).items[0];
  const second = (
    await (
      await h.handler(userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.6" }))
    ).json()
  ).items[0];
  assertEquals(first.slug, "not-a-real-drill");
  assertNotEquals(first.id, second.id);
});

Deno.test(
  "malformed percent-encoding in a slug path is a JSON 400 from the handler, never an uncaught URIError 500",
  async () => {
    const h = await loadHarness();
    const bad = userRequest("GET", "/v1/catalog/drills/%E0%A4%A", {
      ip: "198.51.100.7",
    });
    const direct = await h.handler(bad);
    assertEquals(direct.status, 400);
    assertEquals(
      ((await direct.json()) as { error: { message: string } }).error.message,
      "Malformed path segment.",
    );

    const server = h.realServe({ port: 0, hostname: "127.0.0.1", onListen() {} }, h.handler);
    try {
      const res = await h.realFetch(
        `http://127.0.0.1:${server.addr.port}/functions/v1/api/v1/catalog/drills/%E0%A4%A`,
        {
          headers: {
            Authorization: `Bearer ${fakeGoogleIdToken()}`,
            "x-forwarded-for": "198.51.100.7",
          },
        },
      );
      assertEquals(res.status, 400);
      assertStringIncludes(res.headers.get("content-type") ?? "", "application/json");
      await res.text();
      const put = await h.realFetch(
        `http://127.0.0.1:${server.addr.port}/functions/v1/api/v1/me/saved-drills/%ZZ`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${fakeGoogleIdToken()}`,
            "x-forwarded-for": "198.51.100.7",
          },
        },
      );
      assertEquals(put.status, 400);
      assertStringIncludes(put.headers.get("content-type") ?? "", "application/json");
      await put.text();
    } finally {
      await server.shutdown();
    }
  },
);

// ── billing sync ─────────────────────────────────────────────────────────────

Deno.test(
  "billing sync: RevenueCat verdict persisted via service role and returned with access",
  async () => {
    const h = await loadHarness();
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    h.subscriber = activeSubscriber(expires, "pickle_sensei_pro_annual");
    h.rpcs["access_state"] = [
      {
        premium: false,
        scored_count: 2,
        reserved_count: 0,
      },
    ];
    const res = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.8" }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.billing.premium, true);
    assertEquals(body.billing.productKey, "pickle_sensei_pro_annual");
    assertEquals(body.billing.expiresAt, expires);
    // Verified verdict overrides the (stale) DB premium=false from access_state.
    assertEquals(body.access.premium, true);
    assertEquals(body.access.canStartRating, true);
    assert(body.access.entitlements.includes("pickle_sensei_pro"));

    const rc = h.callsTo(RC_URL);
    assertEquals(rc.length, 1);
    assert(
      rc[0].url.endsWith(encodeURIComponent(TEST_USER_ID)),
      "verifies the AUTHENTICATED user only",
    );
    const row = h.callsTo("/rest/v1/billing_entitlements")[0];
    assertEquals(row.headers["apikey"], "service-role-test-key");
    assertEquals((row.body as Record<string, unknown>).user_id, TEST_USER_ID);
  },
);

Deno.test(
  "billing sync: lapsed entitlement revokes premium; RevenueCat outage → 502 billing_unavailable",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber(new Date(Date.now() - 1000).toISOString());
    h.rpcs["access_state"] = ACCESS_ROW;
    const lapsed = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.9" }));
    assertEquals(lapsed.status, 200);
    assertEquals((await lapsed.json()).billing.premium, false);
    assertEquals(
      (h.callsTo("/rest/v1/billing_entitlements")[0].body as Record<string, unknown>).premium,
      false,
    );

    h.subscriber = null;
    const outage = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.9" }));
    assertEquals(outage.status, 502);
    assertEquals((await outage.json()).error.code, "billing_unavailable");
  },
);

Deno.test("billing sync: per-user budget 10/min → 11th call is 429 with Retry-After", async () => {
  const h = await loadHarness();
  h.subscriber = activeSubscriber();
  h.rpcs["access_state"] = ACCESS_ROW;
  const token = fakeGoogleIdToken(OTHER_USER_ID);
  let last: Response | null = null;
  for (let i = 0; i < 11; i += 1) {
    last = await h.handler(userRequest("POST", "/v1/billing/sync", { ip: "198.51.100.10", token }));
    if (i < 10) assertEquals(last.status, 200, `call ${i + 1}`);
    await last.text();
  }
  assertEquals(last!.status, 429);
  assert(Number(last!.headers.get("retry-after")) > 0);
  assertEquals(h.callsTo(RC_URL).length, 10);
  assertEquals(h.callsTo("/rest/v1/rpc/is_api_session_active").length, 10);
});

// ── healthz ──────────────────────────────────────────────────────────────────

Deno.test("healthz: 200 {ok:true} with no-store/nosniff, no auth, no DB", async () => {
  const h = await loadHarness();
  const res = await h.handler(
    new Request("http://edge.test/functions/v1/api/healthz", {
      headers: { "x-forwarded-for": "198.51.100.11" },
    }),
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: true });
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(h.calls.length, 0);
});

Deno.test(
  "monitor bearer is rejected before any Auth exchange, session creation or DB call",
  async () => {
    const h = await loadHarness();
    const response = await h.handler(
      new Request("http://edge.test/functions/v1/api/v1/me", {
        headers: {
          Authorization: "Bearer launch-monitor-deliberately-invalid-not-a-jwt",
          "x-forwarded-for": "198.51.100.69",
        },
      }),
    );
    assertEquals(response.status, 401);
    assertStringIncludes((await response.json()).error.message, "Bearer token is not");
    assertEquals(h.calls.length, 0);
  },
);

Deno.test(
  "healthz readiness: fresh bounded service-only RPC, coalescing and private failures",
  async (t) => {
    const h = await loadHarness();
    const originalNow = Date.now;
    const originalTimeout = globalThis.setTimeout;
    const originalFetch = globalThis.fetch;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const lines: string[] = [];
    const restoreLogs = captureAccessLog((line) => lines.push(line));
    const key = "a1".repeat(32);
    let now = originalNow();
    Date.now = () => now;
    globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
      originalTimeout(callback, delay === 2_000 ? 20 : delay, ...args)) as typeof setTimeout;
    const request = (query = "?readiness=1", method = "GET", ip = "198.51.100.70") =>
      new Request(`http://edge.test/functions/v1/api/healthz${query}`, {
        method,
        headers: { "x-forwarded-for": ip, Authorization: "Bearer never-forward-this-input" },
      });
    const verdict = async (response: Response, ready: boolean) => {
      assertEquals(response.status, ready ? 200 : 503);
      assertEquals(response.headers.get("cache-control"), "no-store");
      assertEquals(response.headers.get("x-content-type-options"), "nosniff");
      assertEquals(await response.json(), { ok: ready, readiness: { database: ready } });
    };
    const step = (name: string, run: () => Promise<void>) =>
      t.step(name, async () => {
        now += 30_001;
        h.reset();
        h.rpcs.get_api_request_key = key;
        try {
          await run();
        } finally {
          globalThis.fetch = originalFetch;
          Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
        }
      });
    try {
      await step("GET and HEAD liveness are unchanged and only readiness=1 opts in", async () => {
        for (const method of ["GET", "HEAD"]) {
          for (const query of ["", "?readiness=0", "?readiness=true"]) {
            const response = await h.handler(request(query, method));
            assertEquals(response.status, 200);
            assertEquals(await response.json(), { ok: true });
          }
        }
        assertEquals(h.calls.length, 0);
        await verdict(await h.handler(request()), true);
        assertEquals(h.calls.length, 1);
        const rpc = h.calls[0];
        assertEquals(new URL(rpc.url).pathname, "/rest/v1/rpc/get_api_request_key");
        assertEquals(new URL(rpc.url).search, "");
        assertEquals(rpc.method, "GET");
        assertEquals(rpc.headers.authorization, `Bearer ${serviceRoleKey}`);
        assertEquals(rpc.headers.apikey, serviceRoleKey);
        assertEquals(rpc.body, null);
        await verdict(await h.handler(request("?readiness=1", "HEAD")), true);
        assertEquals(h.calls.length, 1);
      });
      await step("successful and failed verdicts cache for at most 30 seconds", async () => {
        await verdict(await h.handler(request()), true);
        h.rpcErrors.get_api_request_key = 500;
        now += 29_999;
        await verdict(await h.handler(request()), true);
        assertEquals(h.calls.length, 1);
        now += 1;
        await verdict(await h.handler(request()), false);
        assertEquals(h.calls.length, 2);
        delete h.rpcErrors.get_api_request_key;
        for (let i = 0; i < 10; i += 1) {
          await verdict(await h.handler(request("?readiness=1", "GET", `198.51.101.${i}`)), false);
        }
        assertEquals(h.calls.length, 2);
        now += 30_000;
        await verdict(await h.handler(request()), true);
        assertEquals(h.calls.length, 3);
      });
      await step("clock rollback does not extend a cached success", async () => {
        await verdict(await h.handler(request()), true);
        h.rpcErrors.get_api_request_key = 503;
        now -= 1;
        await verdict(await h.handler(request()), false);
        assertEquals(h.calls.length, 2);
      });
      await step("missing service configuration fails without touching the network", async () => {
        Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
        await verdict(await h.handler(request()), false);
        assertEquals(h.calls.length, 0);
        const live = await h.handler(request(""));
        assertEquals(live.status, 200);
        assertEquals(await live.json(), { ok: true });
      });
      for (const status of [401, 403, 404, 429, 500, 503]) {
        await step(
          `RPC HTTP ${status}, including an undeployed migration, is unavailable`,
          async () => {
            h.rpcErrors.get_api_request_key = status;
            await verdict(await h.handler(request()), false);
            assertEquals(h.calls.length, 1);
          },
        );
      }
      for (const value of [null, true, {}, [], "", "wrong-shape", "g".repeat(64)]) {
        await step(`invalid RPC value ${JSON.stringify(value)} is unavailable`, async () => {
          h.rpcs.get_api_request_key = value;
          await verdict(await h.handler(request()), false);
          assertEquals(h.calls.length, 1);
        });
      }
      await step("concurrent probes share one in-flight read across IPs", async () => {
        let finish: (response: Response) => void = () => {};
        const gate = new Promise<Response>((resolve) => (finish = resolve));
        let count = 0;
        globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
          count += 1;
          assertEquals(init?.redirect, "error");
          assert(init?.signal);
          return gate;
        }) as typeof fetch;
        const pending = Promise.all(
          Array.from({ length: 20 }, (_, i) =>
            h.handler(request("?readiness=1", "GET", `198.51.102.${i}`)),
          ),
        );
        try {
          await new Promise((resolve) => originalTimeout(resolve, 0));
          assertEquals(count, 1);
        } finally {
          finish(
            new Response(JSON.stringify(key), { headers: { "content-type": "application/json" } }),
          );
        }
        for (const response of await pending) await verdict(response, true);
        assertEquals(count, 1);
      });
      await step(
        "timeout aborts and a non-cooperative fetch cannot start a probe storm or revive success",
        async () => {
          let finish: (response: Response) => void = () => {};
          const gate = new Promise<Response>((resolve) => (finish = resolve));
          let count = 0;
          let signal: AbortSignal | null | undefined;
          globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
            count += 1;
            signal = init?.signal;
            return gate;
          }) as typeof fetch;
          try {
            const responses = await Promise.all(
              Array.from({ length: 20 }, (_, i) =>
                h.handler(request("?readiness=1", "GET", `198.51.103.${i}`)),
              ),
            );
            for (const response of responses) await verdict(response, false);
            assertEquals(signal?.aborted, true);
            now += 30_001;
            await verdict(await h.handler(request()), false);
            assertEquals(count, 1);
          } finally {
            finish(
              new Response(JSON.stringify(key), {
                headers: { "content-type": "application/json" },
              }),
            );
            await gate;
            await new Promise((resolve) => originalTimeout(resolve, 0));
          }
          globalThis.fetch = originalFetch;
          h.rpcErrors.get_api_request_key = 500;
          await verdict(await h.handler(request()), false);
          assertEquals(h.calls.length, 1);
        },
      );
      await step(
        "whole-body deadline cancels a stalled response even if cancellation stalls",
        async () => {
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify(key)));
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => {});
            },
          });
          globalThis.fetch = (() =>
            Promise.resolve(
              new Response(body, { headers: { "content-type": "application/json" } }),
            )) as typeof fetch;
          await verdict(await h.handler(request()), false);
          assertEquals(cancelled, true);
          assertEquals(body.locked, false);
        },
      );
      for (const declared of [true, false]) {
        await step(`RPC body bound applies with content-length=${declared}`, async () => {
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              if (!declared) controller.enqueue(new Uint8Array(129));
            },
            cancel() {
              cancelled = true;
            },
          });
          globalThis.fetch = (() =>
            Promise.resolve(
              new Response(body, {
                headers: {
                  "content-type": "application/json",
                  ...(declared ? { "content-length": "129" } : {}),
                },
              }),
            )) as typeof fetch;
          await verdict(await h.handler(request()), false);
          assertEquals(cancelled, true);
          assertEquals(body.locked, false);
        });
      }
      await step("redirects and thrown errors stay private", async () => {
        globalThis.fetch = (() =>
          Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: "https://example.invalid/never-forward-this-input" },
            }),
          )) as typeof fetch;
        await verdict(await h.handler(request()), false);
        now += 30_001;
        globalThis.fetch = (() => {
          throw new Error(`never-forward-this-input ${key} ${serviceRoleKey}`);
        }) as typeof fetch;
        await verdict(await h.handler(request()), false);
      });
      await step("readiness and liveness retain the same shared public rate budget", async () => {
        for (let i = 0; i < 60; i += 1) {
          const response = await h.handler(
            request(i % 2 ? "?readiness=1" : "", "GET", "198.51.100.75"),
          );
          assertEquals(response.status, 200);
          await response.text();
        }
        const denied = await h.handler(request("?readiness=1", "HEAD", "198.51.100.75"));
        assertEquals(denied.status, 429);
        assert(Number(denied.headers.get("retry-after")) > 0);
        await denied.text();
        assertEquals(h.calls.length, 1);
      });
      assert(lines.length > 0);
      const logged = lines.join("\n");
      for (const forbidden of [key, serviceRoleKey, "never-forward-this-input", "readiness=1"]) {
        assertEquals(logged.includes(forbidden), false);
      }
    } finally {
      Date.now = originalNow;
      globalThis.setTimeout = originalTimeout;
      globalThis.fetch = originalFetch;
      Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceRoleKey);
      restoreLogs();
    }
  },
);

Deno.test("healthz: 60/min per IP, then 429 + Retry-After", async () => {
  const h = await loadHarness();
  let last: Response | null = null;
  for (let i = 0; i < 61; i += 1) {
    last = await h.handler(
      new Request("http://edge.test/functions/v1/api/healthz", {
        headers: { "x-forwarded-for": "198.51.100.12" },
      }),
    );
    await last.text();
  }
  assertEquals(last!.status, 429);
  assert(Number(last!.headers.get("retry-after")) > 0);
});

Deno.test(
  "per-IP limits key on the edge-authoritative address, so rotating the client-controlled first x-forwarded-for hop cannot buy a fresh budget",
  async () => {
    // Behind Cloudflare (the supabase.co gateway answers with server: cloudflare)
    // a client-supplied X-Forwarded-For is preserved and the real IP is
    // APPENDED, so the first hop is attacker-chosen while cf-connecting-ip is
    // authoritative.
    const h = await loadHarness();
    const real = "203.0.113.99";
    const req = (spoofed: string) =>
      new Request("http://edge.test/functions/v1/api/healthz", {
        headers: {
          "x-forwarded-for": `${spoofed}, ${real}`,
          "cf-connecting-ip": real,
        },
      });
    for (let i = 0; i < 60; i += 1) {
      await (await h.handler(req("10.0.0.1"))).text();
    }
    const exhausted = await h.handler(req("10.0.0.1"));
    assertEquals(exhausted.status, 429);
    await exhausted.text();
    const bypass = await h.handler(req("10.0.0.2"));
    assertEquals(bypass.status, 429, "same real IP, new spoofed first hop → still exhausted");
    await bypass.text();
  },
);

Deno.test(
  "catalog saves still work and historical orphan bookmarks remain listable and removable",
  async () => {
    const h = await loadHarness();
    const catalog = await drillCatalog();
    const savedAt = new Date().toISOString();
    h.tables.user_saved_drills = [{ slug: catalog[0].slug, saved_at: savedAt }];
    const saved = await h.handler(
      userRequest("PUT", `/v1/me/saved-drills/${catalog[0].slug}`, { ip: "198.51.100.13" }),
    );
    assertEquals(saved.status, 200);
    assertEquals(await saved.json(), { slug: catalog[0].slug, saved: true, savedAt });
    h.tables.user_saved_drills = [{ slug: "not-a-real-drill", saved_at: savedAt }];
    const list = await h.handler(
      userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.13" }),
    );
    assertEquals(list.status, 200);
    assertEquals((await list.json()).items[0].slug, "not-a-real-drill");
    const removed = await h.handler(
      userRequest("DELETE", "/v1/me/saved-drills/not-a-real-drill", { ip: "198.51.100.13" }),
    );
    assertEquals(removed.status, 204);
    assertEquals(
      h.callsTo("/rest/v1/user_saved_drills").filter((call) => call.method === "DELETE").length,
      1,
    );
  },
);

Deno.test(
  "webhooks reject more than 16 distinct subscriber subjects before RevenueCat or audit",
  async () => {
    const h = await loadHarness();
    h.subscriber = activeSubscriber();
    const ids = Array.from(
      { length: 17 },
      (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, "0")}`,
    );
    const response = await h.handler(
      webhookRequest({
        id: "too-many-subjects",
        type: "TRANSFER",
        app_user_id: ids[0],
        transferred_from: ids.slice(0, 9),
        transferred_to: ids.slice(8),
      }),
    );
    assertEquals(response.status, 400);
    await response.text();
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/rest/v1/webhook_events").length, 0);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
  },
);

Deno.test(
  "webhooks accept 16 distinct subjects and deduplicate repeated transfer ids",
  async () => {
    const sim = await simulate();
    try {
      const h = sim.h;
      const ids = Array.from(
        { length: 16 },
        (_, i) => `bbbbbbbb-bbbb-4bbb-8bbb-${String(i).padStart(12, "0")}`,
      );
      const response = await h.handler(
        webhookRequest({
          id: "sixteen-subjects",
          type: "TRANSFER",
          app_user_id: ids[0],
          transferred_from: ids,
          transferred_to: ids,
        }),
      );
      assertEquals(response.status, 200);
      await response.text();
      assertEquals(h.callsTo(RC_URL).length, 16);
      assertEquals(
        h.callsTo("/rest/v1/webhook_events").filter((call) => call.method === "POST").length,
        1,
      );
      assert(sim.auditRows.get("sixteen-subjects")?.processed_at);
    } finally {
      sim.restore();
    }
  },
);

Deno.test("webhook JSON has a 512 KiB cap, not the 64 KiB small-route cap", async () => {
  const sim = await simulate();
  try {
    const h = sim.h;
    const allowed = await h.handler(
      webhookRequest({ id: "large-but-bounded", pad: "x".repeat(100_000) }),
    );
    assertEquals(allowed.status, 200);
    await allowed.text();
    assert(sim.auditRows.get("large-but-bounded")?.processed_at);
    h.reset();
    const denied = await h.handler(
      webhookRequest({ id: "oversize-webhook", pad: "x".repeat(524_288) }),
    );
    assertEquals(denied.status, 413);
    await denied.text();
    assertEquals(h.calls.length, 0);
  } finally {
    sim.restore();
  }
});

Deno.test(
  "small JSON writes cap at 64 KiB; shot sync and evaluation trials keep their 5 MB override",
  async () => {
    const h = await loadHarness();
    const pad = "x".repeat(100_000);
    const small = await h.handler(
      userRequest("POST", "/v1/analysis-permits", {
        body: { idempotencyKey: "k", pad },
        ip: "198.51.100.40",
      }),
    );
    assertEquals(small.status, 413);
    await small.text();
    assertEquals(h.callsTo("/rest/v1/rpc/reserve_analysis_permit").length, 0);
    for (const [path, body, code] of [
      ["/v1/shots:sync", { shots: [], pad }, "validation.shots_sync"],
      ["/v1/me/evaluation/trials", { trials: [], pad }, "validation.evaluation_trials"],
    ] as const) {
      const response = await h.handler(userRequest("POST", path, { body, ip: "198.51.100.40" }));
      assertEquals(response.status, 400);
      assertEquals((await response.json()).error.code, code);
    }
  },
);

Deno.test(
  "revoked warm sessions cannot serve cached rank/progress or reach billing side effects",
  async () => {
    const h = await loadHarness();
    h.rpcs.access_state = ACCESS_ROW;
    h.subscriber = activeSubscriber();
    const token = fakeSupabaseAccessToken("77777777-7777-4777-8777-777777777777");
    const ip = "198.51.100.50";
    for (const path of ["/v1/me/access", "/v1/rank", "/v1/progress"]) {
      const warm = await h.handler(userRequest("GET", path, { token, ip }));
      assertEquals(warm.status, 200, path);
      await warm.text();
    }
    assertEquals(h.callsTo("/auth/v1/user").length, 1);
    assertEquals(h.callsTo("/rest/v1/player_technique_rating").length, 1);
    h.rpcs.is_api_session_active = false;
    h.calls = [];
    for (const [method, path] of [
      ["POST", "/v1/billing/sync"],
      ["GET", "/v1/rank"],
      ["GET", "/v1/progress"],
      ["GET", "/v1/me/access"],
      ["GET", "/v1/catalog/drills"],
    ]) {
      const denied = await h.handler(userRequest(method, path, { token, ip }));
      assertEquals(denied.status, 401, path);
      await denied.text();
    }
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(
      h.callsTo("/rest/v1/").filter((call) => !call.url.includes("/rpc/is_api_session_active"))
        .length,
      0,
    );
    assertEquals(h.callsTo("/rest/v1/rpc/is_api_session_active").length, 5);
    h.rpcs.is_api_session_active = true;
    const recovered = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(recovered.status, 200);
    await recovered.text();
    assertEquals(h.callsTo("/auth/v1/user").length, 5);
  },
);

Deno.test(
  "session RPC outages block billing with 503 while keeping the verified bearer cache",
  async () => {
    const h = await loadHarness();
    h.rpcs.access_state = ACCESS_ROW;
    const token = fakeGoogleIdToken("88888888-8888-4888-8888-888888888888");
    const ip = "198.51.100.51";
    const warm = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(warm.status, 200);
    await warm.text();
    h.rpcErrors.is_api_session_active = 500;
    const response = await h.handler(userRequest("POST", "/v1/billing/sync", { token, ip }));
    assertEquals(response.status, 503);
    assertEquals((await response.text()).includes("injected rpc failure"), false);
    assertEquals(h.callsTo(RC_URL).length, 0);
    assertEquals(h.callsTo("/rest/v1/billing_entitlements").length, 0);
    delete h.rpcErrors.is_api_session_active;
    const recovered = await h.handler(userRequest("GET", "/v1/me/access", { token, ip }));
    assertEquals(recovered.status, 200);
    await recovered.text();
    assertEquals(h.callsTo("/auth/v1/token").length, 1);
  },
);
