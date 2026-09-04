// Structural audit #2 (mobile-training-drills) — edge-function side.
//
// The mobile TrainingApi (apps/mobile/src/training/api.ts) calls two routes
// the handler never dispatches, and lists saved drills whose orphaned
// placeholder is re-minted with a fresh random id per response. These tests
// pin what the real handler answers today so the mobile side can be judged
// against it. REPRO tests are EXPECTED TO FAIL on 4d812e1a; VERIFY tests hold.
//
// Run: deno test -A --no-check --config deno.json audit_structural2_training_routes.test.ts

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { drillCatalog } from "../drills.ts";
import { loadHarness, userRequest } from "./routesHarness.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.test(
  "REPRO: POST /v1/drill-completions (called by TrainingApi.completeDrill) is dispatched with a coded error, not the generic unknown-endpoint 404",
  async () => {
    const h = await loadHarness();
    const res = await h.handler(
      userRequest("POST", "/v1/drill-completions", {
        ip: "198.51.100.41",
        body: {
          id: crypto.randomUUID(),
          drillSlug: "contact-shadow",
          trainingPlanItemId: crypto.randomUUID(),
          completedAt: new Date().toISOString(),
          actualRepetitions: 10,
          actualDurationSeconds: null,
        },
      }),
    );
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    // A client-facing contract needs a code the mobile client can branch on;
    // "Unknown endpoint" means the route simply does not exist server-side.
    assertEquals(
      {
        status: res.status,
        code: body.error?.code ?? null,
        unknownEndpoint: /Unknown endpoint/.test(body.error?.message ?? ""),
      },
      {
        status: res.status,
        code: "training.completion_unavailable",
        unknownEndpoint: false,
      },
    );
  },
);

Deno.test(
  "REPRO: POST /v1/training-plans/:id/reassessment (called by TrainingApi.reassessPlan) is dispatched with a coded error, not the generic unknown-endpoint 404",
  async () => {
    const h = await loadHarness();
    const planId = crypto.randomUUID();
    const res = await h.handler(
      userRequest("POST", `/v1/training-plans/${planId}/reassessment`, {
        ip: "198.51.100.42",
        body: { shotId: crypto.randomUUID() },
      }),
    );
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
    };
    assertEquals(
      {
        status: res.status,
        code: body.error?.code ?? null,
        unknownEndpoint: /Unknown endpoint/.test(body.error?.message ?? ""),
      },
      {
        status: res.status,
        code: "training.plan_unavailable",
        unknownEndpoint: false,
      },
    );
  },
);

Deno.test(
  "VERIFY: the two unrouted training routes answer a JSON 404 whose body has error.message but NO error.code (what the mobile client must tolerate)",
  async () => {
    const h = await loadHarness();
    for (
      const [path, ip] of [
        ["/v1/drill-completions", "198.51.100.43"],
        [
          `/v1/training-plans/${crypto.randomUUID()}/reassessment`,
          "198.51.100.44",
        ],
      ] as const
    ) {
      const res = await h.handler(userRequest("POST", path, { ip, body: {} }));
      assertEquals(res.status, 404);
      const body = (await res.json()) as { error: Record<string, unknown> };
      assertEquals(typeof body.error.message, "string");
      assertEquals("code" in body.error, false);
    }
  },
);

Deno.test(
  "REPRO: an orphaned bookmark keeps ONE stable id across list responses (the client-visible id of a saved entry changes on every refresh; index.ts savedDrillEntry mints crypto.randomUUID per call)",
  async () => {
    const h = await loadHarness();
    h.tables["user_saved_drills"] = [
      { slug: "retired-drill", saved_at: new Date().toISOString() },
    ];
    const ids = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const res = await h.handler(
        userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.45" }),
      );
      assertEquals(res.status, 200);
      const items = (await res.json()).items as Array<
        { id: string; slug: string }
      >;
      assertEquals(items.length, 1);
      assertEquals(items[0].slug, "retired-drill");
      assert(
        UUID_RE.test(items[0].id),
        "placeholder id is a well-formed UUID (mobile parser accepts it)",
      );
      ids.add(items[0].id);
    }
    assertEquals(ids.size, 1);
  },
);

Deno.test(
  "VERIFY: an orphaned bookmark's detail is a coded 404 (drill.not_found) — the mobile card can never load it, so Retry can never succeed",
  async () => {
    const h = await loadHarness();
    h.tables["user_saved_drills"] = [
      { slug: "retired-drill", saved_at: new Date().toISOString() },
    ];
    const list = await h.handler(
      userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.46" }),
    );
    assertEquals(list.status, 200);
    const detail = await h.handler(
      userRequest("GET", "/v1/catalog/drills/retired-drill", {
        ip: "198.51.100.46",
      }),
    );
    assertEquals(detail.status, 404);
    const body = (await detail.json()) as { error: { code: string } };
    assertEquals(body.error.code, "drill.not_found");
  },
);

Deno.test(
  "VERIFY: a catalog bookmark keeps the catalog entry's fixed id across list responses",
  async () => {
    const h = await loadHarness();
    const [entry] = await drillCatalog();
    h.tables["user_saved_drills"] = [{
      slug: entry.slug,
      saved_at: new Date().toISOString(),
    }];
    const a = (await (await h.handler(
      userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.47" }),
    )).json()).items[0] as { id: string };
    const b = (await (await h.handler(
      userRequest("GET", "/v1/me/saved-drills", { ip: "198.51.100.47" }),
    )).json()).items[0] as { id: string };
    assertEquals(a.id, entry.id);
    assertEquals(a.id, b.id);
    assertNotEquals(a.id, "");
  },
);
