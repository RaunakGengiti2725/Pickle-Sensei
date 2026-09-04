// Adjudication regressions for area xc-ci-release-static (commit 4d812e1a).
//
// ROUTES-1 pins the mobile → edge route inventory: every `/v1/...` path the
// shipping training client (apps/mobile/src/training/api.ts) can request must
// be routed by this function. The inventory below is checked BOTH ways against
// the mobile source — a path added to the client without a server route, or a
// stale entry here, fails the test — so the shipping build can never target
// the router's "Unknown endpoint" fallthrough.
//
// Run:  cd supabase/functions/api/__wf__ && deno test -A --no-check \
//         --config deno.json adjudicate_xc_ci_release_static.test.ts

import { assert, assertEquals } from "@std/assert";
import { loadHarness, SUPABASE_URL, TEST_USER_ID } from "./routesHarness.ts";

const MOBILE_TRAINING_API = new URL("../../../../apps/mobile/src/training/api.ts", import.meta.url);

const b64url = (value: string): string =>
  btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A syntactically valid Supabase-issued ACCESS token (iss ends in /auth/v1). */
function fakeSupabaseAccessToken(sub = TEST_USER_ID, salt = ""): string {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({
      iss: `${SUPABASE_URL}/auth/v1`,
      sub,
      aud: "authenticated",
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
      salt,
    }),
  );
  return `${header}.${payload}.sig`;
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const healthyUser = () => ({
  id: TEST_USER_ID,
  aud: "authenticated",
  role: "authenticated",
  email: "user@example.com",
  app_metadata: { provider: "apple", providers: ["apple"] },
  user_metadata: {},
  created_at: new Date().toISOString(),
});

/** Route Supabase Auth's user lookup to a healthy user for the duration of `run`. */
async function withHealthyAuth<T>(run: () => Promise<T>): Promise<T> {
  const base = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.startsWith(`${SUPABASE_URL}/auth/v1/user`)) {
      return Promise.resolve(jsonResponse(200, healthyUser()));
    }
    return base(request);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = base;
  }
}

async function probe(
  handler: (request: Request) => Promise<Response>,
  init: { method: string; path: string; bearer: string; body?: unknown },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {
    "x-forwarded-for": "10.6.0.1",
    "content-type": "application/json",
    Authorization: `Bearer ${init.bearer}`,
  };
  const response = await handler(
    new Request(`http://edge.test${init.path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return { status: response.status, body: await response.text() };
}

/**
 * Every `/v1/...` string or template literal in the mobile training client,
 * with each `${...}` interpolation (query suffix, encoded path segment)
 * collapsed to `*`. Template scanning is brace-aware so nested literals such
 * as `${cond ? `?${query}` : ''}` collapse to a single `*`.
 */
function mobileTrainingPathTemplates(source: string): Set<string> {
  const templates = new Set<string>();
  const open = /['`]\/v1\//g;
  let match: RegExpExecArray | null;
  while ((match = open.exec(source)) !== null) {
    const quote = match[0][0];
    let index = match.index + 1;
    let depth = 0;
    let template = "";
    while (index < source.length) {
      const char = source[index];
      if (depth === 0 && char === quote) break;
      if (quote === "`" && char === "$" && source[index + 1] === "{") {
        if (depth === 0) template += "*";
        depth += 1;
        index += 2;
        continue;
      }
      if (depth > 0) {
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
        index += 1;
        continue;
      }
      template += char;
      index += 1;
    }
    templates.add(template);
    open.lastIndex = index;
  }
  return templates;
}

const REASSESSMENT_PLAN_ID = "00000000-0000-4000-8000-000000000000";
const UNROUTED = "Unknown endpoint";

Deno.test(
  "ROUTES-1 every mobile training client path is routed by the edge fn (never the Unknown-endpoint fallthrough)",
  async () => {
    const source = await Deno.readTextFile(MOBILE_TRAINING_API);
    const templates = mobileTrainingPathTemplates(source);

    const h = await loadHarness();
    const bearer = fakeSupabaseAccessToken(TEST_USER_ID, "routes-1");
    const results: Record<string, number> = {};

    await withHealthyAuth(async () => {
      const catalog = await probe(h.handler, {
        method: "GET",
        path: "/v1/catalog/drills",
        bearer,
      });
      assertEquals(catalog.status, 200, catalog.body);
      const items = (JSON.parse(catalog.body) as { items: Array<{ slug: string }> }).items;
      assert(items.length > 0, "catalog seed must expose at least one drill slug");
      const slug = encodeURIComponent(items[0].slug);

      // template (as it appears in training/api.ts, `${...}` → `*`) → the
      // concrete requests the client issues for it.
      const inventory: Record<string, Array<{ method: string; path: string; body?: unknown }>> = {
        "/v1/catalog/drills*": [{ method: "GET", path: "/v1/catalog/drills" }],
        "/v1/catalog/drills/*": [{ method: "GET", path: `/v1/catalog/drills/${slug}` }],
        "/v1/me/saved-drills": [{ method: "GET", path: "/v1/me/saved-drills" }],
        "/v1/me/saved-drills/*": [
          { method: "PUT", path: `/v1/me/saved-drills/${slug}` },
          { method: "DELETE", path: `/v1/me/saved-drills/${slug}` },
        ],
        "/v1/training-plans/current": [{ method: "GET", path: "/v1/training-plans/current" }],
        "/v1/training-plans": [{ method: "POST", path: "/v1/training-plans", body: {} }],
        "/v1/drill-completions": [{ method: "POST", path: "/v1/drill-completions", body: {} }],
        "/v1/training-plans/*/reassessment": [
          {
            method: "POST",
            path: `/v1/training-plans/${REASSESSMENT_PLAN_ID}/reassessment`,
            body: {},
          },
        ],
      };

      assertEquals(
        [...templates].sort(),
        Object.keys(inventory).sort(),
        "apps/mobile/src/training/api.ts path inventory drifted from this test — add the route to the edge fn (or remove it from the client) and update the inventory",
      );

      for (const requests of Object.values(inventory)) {
        for (const request of requests) {
          const r = await probe(h.handler, { ...request, bearer });
          results[`${request.method} ${request.path}`] = r.status;
          assert(
            !(r.status === 404 && r.body.includes(UNROUTED)),
            `${request.method} ${request.path} is not routed by the edge fn: ${r.body}`,
          );
        }
      }
    });
    console.log(`  [ROUTES-1] ${JSON.stringify(results)}`);

    // Plans stay honestly unavailable until coach-validated content is
    // published: the current plan is null, and every plan write — creation,
    // drill completion, reassessment — is refused with the same 409, never a 404.
    assertEquals(results["GET /v1/training-plans/current"], 200);
    assertEquals(results["POST /v1/training-plans"], 409);
    assertEquals(results["POST /v1/drill-completions"], 409);
    assertEquals(results[`POST /v1/training-plans/${REASSESSMENT_PLAN_ID}/reassessment`], 409);
  },
);
