// Adversarial pass 3 — own probes: cancellation mid-flight, corrupt / stalled
// request bodies, clock skew on the cache horizon, refresh burst budget.
//
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack3_midflight_test.ts

import { assert, assertEquals } from "@std/assert";
import { cacheGet, sha256Hex } from "../cache.ts";
import {
  edgeRequest,
  errorCodeOf,
  jsonResponse,
  loadAttack3,
  readJson,
  supabaseBearer,
  withClock,
} from "./attack3_harness.ts";

const ROUTE = "/v1/attack3/nowhere";

Deno.test("M1 HELD: client aborts while getUser is in flight — the handler still settles cleanly and the verdict is cached", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.10";
  const token = supabaseBearer("dddddddd-0000-4000-8000-000000000001", {
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
  let releaseUpstream!: () => void;
  const gate = new Promise<void>((resolve) => (releaseUpstream = resolve));
  attack.setOverride(async (request, url) => {
    if (request.method === "GET" && url.pathname === "/auth/v1/user") {
      await gate;
      return null; // fall through to the default verdict once released
    }
    return null;
  });

  const controller = new AbortController();
  const request = new Request(`http://edge.test/functions/v1/api${ROUTE}`, {
    method: "GET",
    headers: { "x-forwarded-for": ip, Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  const pending = attack.harness.handler(request);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort(new DOMException("client went away", "AbortError"));
  releaseUpstream();
  const response = await pending;
  await response.body?.cancel();
  assertEquals(response.status, 404, "handler completed despite the abort");
  assertEquals(attack.getUserCalls().length, 1);
  assert(
    (await cacheGet(`auth:${await sha256Hex(token)}`)) !== null,
    "verdict cached for the next request",
  );
});

Deno.test("M2 HELD: refresh body stream that ERRORS mid-way → non-2xx, no GoTrue call, handler does not hang", async () => {
  const attack = await loadAttack3();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"refreshToken":"rt-'));
      controller.error(new Error("connection reset"));
    },
  });
  const response = await attack.harness.handler(
    edgeRequest("POST", "/v1/auth/refresh", {
      ip: "198.51.100.11",
      body,
      headers: { "Content-Type": "application/json" },
    }),
  );
  const json = await readJson(response);
  console.log(
    JSON.stringify({
      m2: "errored body stream",
      status: response.status,
      body: json,
    }),
  );
  assert(
    response.status >= 400 && response.status < 600,
    `status ${response.status}`,
  );
  assert(response.headers.get("x-request-id"));
  assertEquals(
    attack.upstreamTo("/auth/v1/token").length,
    0,
    "GoTrue never called for a broken body",
  );
});

Deno.test({
  name:
    "M3 P3 (characterisation): a refresh body that STALLS is awaited indefinitely by the handler (no body-read timeout; platform wall-clock is the only bound)",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const attack = await loadAttack3();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"refreshToken":"rt-'));
        // never closes, never errors
      },
      cancel() {
        cancelled = true;
      },
    });
    const pending = attack.harness.handler(
      edgeRequest("POST", "/v1/auth/refresh", {
        ip: "198.51.100.12",
        body,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const settled = await Promise.race([
      pending.then(() => "settled" as const),
      new Promise<"still-pending">((r) =>
        setTimeout(() => r("still-pending"), 1_500)
      ),
    ]);
    console.log(
      JSON.stringify({
        m3: "stalled body stream",
        afterMs: 1_500,
        settled,
        streamCancelled: cancelled,
      }),
    );
    assertEquals(
      settled,
      "still-pending",
      "characterisation: no server-side body-read deadline on 4d812e1a",
    );
    assertEquals(attack.upstreamTo("/auth/v1/token").length, 0);
    // The handler stays parked on reader.read(); the stream is locked so it
    // cannot be cancelled from here — the promise is left dangling on purpose
    // (sanitizers disabled for this test).
  },
});

Deno.test("M4 HELD: clock skew — a bearer exp far in the future is cached for the 600 s cap, not for its own lifetime", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.13";
  const t0 = Date.now();
  await withClock(t0, async () => {
    const farFuture = supabaseBearer("dddddddd-0000-4000-8000-000000000002", {
      exp: 32_503_680_000,
    }); // year 3000
    const response = await attack.harness.handler(
      edgeRequest("GET", ROUTE, { authorization: `Bearer ${farFuture}`, ip }),
    );
    await response.body?.cancel();
    assertEquals(response.status, 404);
    const raw = await cacheGet(`auth:${await sha256Hex(farFuture)}`);
    assert(raw);
    assertEquals(
      (JSON.parse(raw) as { expiresAtMs: number }).expiresAtMs,
      t0 + 600_000,
    );

    // exp given in MILLISECONDS by mistake (a common skew bug) is treated as
    // seconds → far future → same cap applies.
    const msExp = supabaseBearer("dddddddd-0000-4000-8000-000000000003", {
      exp: t0 + 3_600_000,
    });
    const r2 = await attack.harness.handler(
      edgeRequest("GET", ROUTE, { authorization: `Bearer ${msExp}`, ip }),
    );
    await r2.body?.cancel();
    assertEquals(r2.status, 404);
    const raw2 = await cacheGet(`auth:${await sha256Hex(msExp)}`);
    assert(raw2);
    assertEquals(
      (JSON.parse(raw2) as { expiresAtMs: number }).expiresAtMs,
      t0 + 600_000,
    );

    // exp exactly "now" (skewed client) → refused before GoTrue.
    const nowExp = supabaseBearer("dddddddd-0000-4000-8000-000000000004", {
      exp: Math.floor(t0 / 1000),
    });
    const r3 = await attack.harness.handler(
      edgeRequest("GET", ROUTE, { authorization: `Bearer ${nowExp}`, ip }),
    );
    const j3 = await readJson(r3);
    assertEquals(r3.status, 401, JSON.stringify(j3));
    assertEquals(attack.getUserCalls().length, 2);
  });
});

Deno.test("M5 HELD: refresh burst — 30 refreshes/min per IP; the 31st is 429 (RateLimit-Limit 30, Retry-After ≤ 60) and never reaches GoTrue", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.14";
  attack.setOverride((request, url) =>
    request.method === "POST" && url.pathname === "/auth/v1/token"
      ? jsonResponse(200, {
        access_token: supabaseBearer("dddddddd-0000-4000-8000-000000000005", {
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
        refresh_token: "rt-next",
        token_type: "bearer",
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: "dddddddd-0000-4000-8000-000000000005",
          aud: "authenticated",
          role: "authenticated",
          email: "d@example.com",
          app_metadata: { provider: "google", providers: ["google"] },
          user_metadata: {},
        },
      })
      : null
  );
  const t0 = Date.now();
  await withClock(t0, async () => {
    const responses = await Promise.all(
      Array.from({ length: 31 }, (_, i) =>
        attack.harness.handler(
          edgeRequest("POST", "/v1/auth/refresh", {
            ip,
            body: JSON.stringify({ refreshToken: `rt-${i}` }),
            headers: { "Content-Type": "application/json" },
          }),
        )),
    );
    const statuses = await Promise.all(responses.map(async (r) => {
      await r.body?.cancel();
      return r.status;
    }));
    assertEquals(
      statuses.filter((s) => s === 200).length,
      30,
      JSON.stringify(statuses),
    );
    assertEquals(statuses.filter((s) => s === 429).length, 1);
    const refused = responses[statuses.indexOf(429)];
    assertEquals(refused.headers.get("RateLimit-Limit"), "30");
    assert(Number(refused.headers.get("Retry-After")) <= 60);
    assertEquals(
      attack.upstreamTo("/auth/v1/token").length,
      30,
      "the refused refresh never reached GoTrue",
    );
  });
});

Deno.test("M6 HELD: refresh with a refresh token that is 100 KB of unicode is forwarded verbatim (trimmed) and a GoTrue 400 maps to 401", async () => {
  const attack = await loadAttack3();
  attack.setOverride((request, url) =>
    request.method === "POST" && url.pathname === "/auth/v1/token"
      ? jsonResponse(400, {
        code: 400,
        error_code: "refresh_token_not_found",
        msg: "Invalid Refresh Token: Refresh Token Not Found",
      })
      : null
  );
  const weird = ` ${"🥒ü".repeat(25_000)}\u200b `;
  const response = await attack.harness.handler(
    edgeRequest("POST", "/v1/auth/refresh", {
      ip: "198.51.100.15",
      body: JSON.stringify({ refreshToken: weird }),
      headers: { "Content-Type": "application/json" },
    }),
  );
  const json = await readJson(response);
  assertEquals(response.status, 401, JSON.stringify(json).slice(0, 200));
  assertEquals(errorCodeOf(json), "");
  const calls = attack.upstreamTo("/auth/v1/token");
  assertEquals(calls.length, 1);
  const forwarded = JSON.parse(calls[0].bodyText) as { refresh_token: string };
  assertEquals(forwarded.refresh_token, weird.trim());
});
