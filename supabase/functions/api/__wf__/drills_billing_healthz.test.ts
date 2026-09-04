// GET /v1/catalog/drills[/:slug], GET/PUT/DELETE /v1/me/saved-drills,
// POST /v1/billing/sync, GET /healthz — through the real handler.
//
// Run: deno test -A --no-check --config deno.json   (inside __wf__/)

import { assert, assertEquals, assertNotEquals, assertStringIncludes } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import { drillInstructionalMedia } from "../drillMedia.ts";
import {
  activeSubscriber,
  fakeGoogleIdToken,
  loadHarness,
  OTHER_USER_ID,
  RC_URL,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

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
  "REPRO (defect): PUT /v1/me/saved-drills/:slug accepts slugs that are not in the catalog",
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
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.saved, true);
    // The row was actually written.
    const writes = h.callsTo("/rest/v1/user_saved_drills").filter((c) => c.method === "POST");
    assertEquals(writes.length, 1);
    assertEquals((writes[0].body as Record<string, unknown>).slug, "not-a-real-drill");
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

// ── legal routes ─────────────────────────────────────────────────────────────

Deno.test(
  "GET /privacy and GET /terms: served bodies never mention Android, Google Play, guest mode, or Live Court (iPhone-only copy rules)",
  async () => {
    const h = await loadHarness();
    const forbidden = ["Google Play", "Android", "guest mode", "Live Court"];
    for (const path of ["privacy", "terms"]) {
      const res = await h.handler(
        new Request(`http://edge.test/functions/v1/api/${path}`, {
          headers: { "x-forwarded-for": "198.51.100.14" },
        }),
      );
      assertEquals(res.status, 200);
      assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
      const body = await res.text();
      assert(body.length > 10_000, `${path}: body too short (${body.length})`);
      const hits = forbidden.filter((term) => body.toLowerCase().includes(term.toLowerCase()));
      assertEquals(hits, [], `${path}: forbidden terms in served legal copy: ${hits.join(", ")}`);
    }
    assertEquals(h.calls.length, 0);
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
