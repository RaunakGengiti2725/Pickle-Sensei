// Adjudication reproductions (stress area edge-account-drills-4, baseline
// 1fb0efd7). Every test here pins CURRENT behaviour that the adjudicator
// reproduced from the tester branches, in the same "REPRO (defect)" style as
// drills_billing_healthz.test.ts: the test passes while the defect exists and
// fails loudly once the route is fixed — remove or invert it then.
//
// Nothing here touches production; Supabase Auth / PostgREST are the
// routesHarness fetch stubs, with the fault injected per test. The
// PUT/DELETE read-back race was ALSO reproduced against a disposable local
// Postgres (tester branch stress-route-put-v1-me-saved-drills-slug-concurrency,
// case SD3-pg); the in-memory model below replays the exact PostgREST
// interleaving (upsert 201 → read-back []).
import { assert, assertEquals } from "@std/assert";
import { configureRedis, fakeUpstash, loadIsolate } from "./harness.ts";
import { fakeGoogleIdToken, loadHarness, SUPABASE_URL, userRequest } from "./routesHarness.ts";

const uid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;

/** Run one request through the real handler with `fault` layered over the
 * harness's Supabase stubs (fault returns null to fall through). */
async function withFault(
  fault: (request: Request) => Promise<Response | null> | Response | null,
  request: Request,
): Promise<Response> {
  const harness = await loadHarness();
  const harnessFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const injected = await fault(req.clone());
    return injected ?? harnessFetch(input, init);
  }) as typeof fetch;
  try {
    return await harness.handler(request);
  } finally {
    globalThis.fetch = harnessFetch;
  }
}

const isGoTrueToken = (req: Request) => req.url.startsWith(`${SUPABASE_URL}/auth/v1/token`);
const isSavedDrills = (req: Request) =>
  req.url.startsWith(`${SUPABASE_URL}/rest/v1/user_saved_drills`);

/** Resolves "pending" if `p` has not settled after `ms`. */
function settledWithin<T>(p: Promise<T>, ms: number): Promise<T | "pending"> {
  return Promise.race([
    p,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

// ─── A: transitional provider-token path folds every GoTrue failure into 401 ─

Deno.test(
  "REPRO (defect): provider ID token + GoTrue 503 → 401 'could not be verified' (should be 503)",
  async () => {
    const res = await withFault(
      (req) =>
        isGoTrueToken(req)
          ? new Response(JSON.stringify({ code: 503, msg: "service unavailable" }), {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": "2",
              },
            })
          : null,
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(uid(1)),
        ip: "10.44.0.1",
      }),
    );
    const body = await res.json();
    console.log(`[adjudicate A] GoTrue 503 -> edge ${res.status} ${JSON.stringify(body)}`);
    assertEquals(res.status, 401);
    assertEquals(body.error.message, "The identity token could not be verified.");
  },
);

Deno.test(
  "REPRO (defect): provider ID token + GoTrue network throw → 401 (should be 503)",
  async () => {
    const res = await withFault(
      (req) => {
        if (isGoTrueToken(req)) {
          throw new TypeError("error sending request: connection reset");
        }
        return null;
      },
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(uid(2)),
        ip: "10.44.0.2",
      }),
    );
    await res.text();
    console.log(`[adjudicate A] GoTrue connect failure -> edge ${res.status}`);
    assertEquals(res.status, 401);
  },
);

Deno.test(
  "REPRO (defect): provider ID token + GoTrue hang → request has no deadline (still pending after 2.5s)",
  async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const pending = withFault(
      async (req) => {
        if (!isGoTrueToken(req)) return null;
        await gate;
        return new Response(JSON.stringify({ code: 504, msg: "timeout" }), {
          status: 504,
          headers: { "Content-Type": "application/json" },
        });
      },
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(uid(3)),
        ip: "10.44.0.3",
      }),
    );
    const outcome = await settledWithin(pending, 2_500);
    console.log(
      `[adjudicate A] GoTrue hang -> after 2.5s: ${
        outcome === "pending" ? "pending" : outcome.status
      }`,
    );
    assertEquals(outcome, "pending");
    release();
    await (await pending).text();
  },
);

// ─── B: PostgREST client has no deadline and no body-shape guard ─────────────

Deno.test(
  "REPRO (defect): GET /v1/me/saved-drills with PostgREST 200 {} (object body) → 500 (should be 503)",
  async () => {
    const res = await withFault(
      (req) =>
        isSavedDrills(req) && req.method === "GET"
          ? new Response("{}", {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : null,
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(uid(4)),
        ip: "10.44.0.4",
      }),
    );
    const body = await res.json();
    console.log(`[adjudicate B] PostgREST 200 {} -> edge ${res.status} ${JSON.stringify(body)}`);
    assertEquals(res.status, 500);
  },
);

Deno.test(
  "REPRO (defect): GET /v1/me/saved-drills with PostgREST hang → request has no deadline (still pending after 2.5s)",
  async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const pending = withFault(
      async (req) => {
        if (!(isSavedDrills(req) && req.method === "GET")) return null;
        await gate;
        return new Response("[]", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
      userRequest("GET", "/v1/me/saved-drills", {
        token: fakeGoogleIdToken(uid(5)),
        ip: "10.44.0.5",
      }),
    );
    const outcome = await settledWithin(pending, 2_500);
    console.log(
      `[adjudicate B] PostgREST hang -> after 2.5s: ${
        outcome === "pending" ? "pending" : outcome.status
      }`,
    );
    assertEquals(outcome, "pending");
    release();
    await (await pending).text();
  },
);

// ─── C: PUT upsert → read-back is two statements; a concurrent DELETE lands
//        between them and the PUT answers 503 although its write succeeded ──

Deno.test(
  "REPRO (defect): PUT /v1/me/saved-drills/:slug read-back finds no row (DELETE raced in) → 503 'Drill save'",
  async () => {
    const res = await withFault(
      (req) => {
        if (!isSavedDrills(req)) return null;
        if (req.method === "POST") return new Response(null, { status: 201 });
        if (req.method === "GET") {
          return new Response("[]", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return null;
      },
      userRequest("PUT", "/v1/me/saved-drills/dink-consistency", {
        token: fakeGoogleIdToken(uid(6)),
        ip: "10.44.0.6",
      }),
    );
    const body = await res.json();
    console.log(
      `[adjudicate C] upsert 201 + read-back [] -> edge ${res.status} ${JSON.stringify(body)}`,
    );
    assertEquals(res.status, 503);
    assertEquals(body.error.message, "Drill save is temporarily unavailable. Please try again.");
  },
);

// ─── D: in-memory rate limiter drops EVERY live window once 20,000 distinct
//        keys are live (windows.clear()) — a distinct-IP flood resets budgets ─

Deno.test(
  "REPRO (defect): 20,000 distinct live rate-limit keys → exhausted budget for an unrelated key resets to 0",
  async () => {
    configureRedis(false);
    const redis = fakeUpstash();
    try {
      const iso = await loadIsolate();
      const limit = 5;
      for (let i = 0; i < limit; i++) {
        await iso.rateLimit.enforceRateLimit("authfail", "victim-ip", limit, 300);
      }
      const before = await iso.rateLimit.peekRateLimit("authfail", "victim-ip", limit, 300);
      assertEquals(before.allowed, false, "budget exhausted before the flood");
      for (let i = 0; i < 20_000; i++) {
        await iso.rateLimit.enforceRateLimit(
          "ip",
          `198.18.${(i >> 8) & 255}.${i & 255}-${i}`,
          120,
          60,
        );
      }
      const after = await iso.rateLimit.peekRateLimit("authfail", "victim-ip", limit, 300);
      console.log(
        `[adjudicate D] victim remaining before=${before.remaining} after=${after.remaining} allowed=${after.allowed}`,
      );
      assertEquals(after.allowed, true);
      assertEquals(after.remaining, limit);
      assert(redis.calls === 0, "memory fallback only");
    } finally {
      redis.restore();
    }
  },
);
