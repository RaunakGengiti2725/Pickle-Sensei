// Adversarial pass 3 — S1/S2: POST /v1/auth/refresh against the real edge
// handler with GoTrue stubbed at the fetch layer.
//
//   S1  GoTrue answers 429 on the refresh grant → the edge must answer 503
//       (retryable for sessionKeeper), never 401 (sessionKeeper signs out on
//       401/403 — apps/mobile/src/account/sessionLifecycle.ts).
//   S2  Malformed bodies → 400 validation.refresh; a 6 MB+1 chunked body →
//       413; in both cases GoTrue is never called.
//
// Tests titled "REPRO" pin the behaviour observed on 4d812e1a (defect open)
// and state the required behaviour; `ATTACK3_ASSERT_FIXED=1` flips them to
// assert the required behaviour (see assertRepro in attack3_harness.ts).
// Run: cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json attack3_refresh_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  assertRepro,
  authFailCount,
  chunkedBody,
  edgeRequest,
  errorCodeOf,
  errorMessageOf,
  jsonResponse,
  loadAttack3,
  readJson,
} from "./attack3_harness.ts";

const REFRESH_GRANT = "/auth/v1/token";

function refreshRequest(
  ip: string,
  body: BodyInit | null,
  headers: Record<string, string> = {},
) {
  return edgeRequest("POST", "/v1/auth/refresh", {
    ip,
    body,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

Deno.test(
  "S1 REPRO: GoTrue 429 on refresh is answered 401 + authfail charge (required: 503, no charge — sessionKeeper signs out on 401)",
  async () => {
    const attack = await loadAttack3();
    const ip = "198.51.100.11";
    attack.setOverride((request, url) => {
      if (request.method === "POST" && url.pathname === REFRESH_GRANT) {
        return jsonResponse(
          429,
          {
            code: 429,
            error_code: "over_request_rate_limit",
            msg: "Request rate limit reached",
          },
          { "Retry-After": "7" },
        );
      }
      return null;
    });

    const before = await authFailCount(ip);
    const response = await attack.harness.handler(
      refreshRequest(ip, JSON.stringify({ refreshToken: "rt-live-device" })),
    );
    const body = await readJson(response);
    const grants = attack.upstreamTo(
      `${REFRESH_GRANT}?grant_type=refresh_token`,
    );
    const after = await authFailCount(ip);

    assertEquals(grants.length, 1, "exactly one refresh grant reaches GoTrue");
    console.log(
      JSON.stringify({
        s1: "GoTrue 429 on refresh",
        edgeStatus: response.status,
        edgeBody: body,
        authFailCharged: after - before,
      }),
    );
    // sessionLifecycle.refreshApiSession treats 401/403 as 'session revoked'
    // (non-retryable → the ONE implicit sign-out); any other failure is retried.
    assertRepro(
      response.status,
      { observed: 401, required: 503 },
      "edge status for an upstream 429 on the refresh grant",
    );
    assertRepro(
      after - before,
      { observed: 1, required: 0 },
      "auth-failure charge to the client IP for an upstream throttle",
    );
    assertEquals(
      errorMessageOf(body),
      response.status === 401
        ? "The session could not be refreshed. Sign in again."
        : "Session refresh is temporarily unavailable. Please try again.",
    );
  },
);

Deno.test(
  "S1b REPRO: GoTrue 429 with a text/plain body on refresh is answered 401 (required: 503)",
  async () => {
    const attack = await loadAttack3();
    const ip = "198.51.100.12";
    attack.setOverride((request, url) => {
      if (request.method === "POST" && url.pathname === REFRESH_GRANT) {
        return new Response("Too Many Requests", {
          status: 429,
          headers: { "Content-Type": "text/plain", "Retry-After": "3" },
        });
      }
      return null;
    });
    const response = await attack.harness.handler(
      refreshRequest(ip, JSON.stringify({ refreshToken: "rt-live-device" })),
    );
    await response.body?.cancel();
    assertRepro(
      response.status,
      { observed: 401, required: 503 },
      "edge status for a text/plain upstream 429",
    );
  },
);

Deno.test("S1 control HELD: GoTrue 503 on refresh is answered 503 and not charged as an auth failure", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.13";
  let attempts = 0;
  attack.setOverride((request, url) => {
    if (request.method === "POST" && url.pathname === REFRESH_GRANT) {
      attempts += 1;
      return jsonResponse(503, { code: 503, msg: "service unavailable" });
    }
    return null;
  });
  // supabase-js retries retryable (5xx) errors with 200·2^n ms backoff for up
  // to ~25 s of wall clock. Collapse the sleeps so the control stays fast; the
  // real latency/amplification is measured by attack3_refresh_outage_probe.ts.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout =
    ((handler: () => void, _timeout?: number, ...args: unknown[]) => {
      queueMicrotask(() => {
        if (typeof handler === "function") {
          (handler as (...a: unknown[]) => void)(...args);
        }
      });
      return 0;
    }) as unknown as typeof setTimeout;
  const before = await authFailCount(ip);
  let response: Response;
  try {
    response = await attack.harness.handler(
      refreshRequest(ip, JSON.stringify({ refreshToken: "rt-live-device" })),
    );
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  const body = await readJson(response);
  assert(attempts >= 2, `supabase-js retried the 503 (attempts=${attempts})`);
  assertEquals(
    response.status,
    503,
    `status ${response.status} ${JSON.stringify(body)}`,
  );
  assertEquals(
    (await authFailCount(ip)) - before,
    0,
    "outage is not an auth failure",
  );
});

Deno.test("S2 HELD: refresh bodies that are not {refreshToken: string} → 400 validation.refresh, no GoTrue call", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.21";
  const bodies: Array<[string, string]> = [
    ["a JSON string", JSON.stringify("just a string")],
    ["an empty array", JSON.stringify([])],
    ["a numeric refreshToken", JSON.stringify({ refreshToken: 123 })],
    ["a blank refreshToken", JSON.stringify({ refreshToken: "  " })],
    ["an empty body", ""],
    ["malformed JSON", "{refreshToken:"],
    [
      "a unicode-whitespace refreshToken",
      JSON.stringify({ refreshToken: "\u00a0\u2003" }),
    ],
    [
      "a nested refreshToken",
      JSON.stringify({ refreshToken: { value: "rt" } }),
    ],
    ["a null refreshToken", JSON.stringify({ refreshToken: null })],
  ];
  for (const [label, body] of bodies) {
    const response = await attack.harness.handler(refreshRequest(ip, body));
    const json = await readJson(response);
    assertEquals(
      response.status,
      400,
      `${label}: status ${response.status} ${JSON.stringify(json)}`,
    );
    assertEquals(
      errorCodeOf(json),
      "validation.refresh",
      `${label}: error.code`,
    );
    assertEquals(
      errorMessageOf(json),
      "refreshToken is required.",
      `${label}: error.message`,
    );
  }
  assertEquals(
    attack.upstreamTo(REFRESH_GRANT).length,
    0,
    "GoTrue was never called for invalid bodies",
  );
  assertEquals(
    await authFailCount(ip),
    0,
    "validation failures are not auth failures",
  );
});

Deno.test("S2 HELD: a 6 MB+1 chunked refresh body (no Content-Length) → 413, no GoTrue call", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.22";
  const response = await attack.harness.handler(
    refreshRequest(ip, chunkedBody(6 * 1024 * 1024 + 1)),
  );
  const json = await readJson(response);
  assertEquals(
    response.status,
    413,
    `status ${response.status} ${JSON.stringify(json)}`,
  );
  assertEquals(errorMessageOf(json), "Request body is too large.");
  assert(response.headers.get("x-request-id"), "413 carries x-request-id");
  assertEquals(
    attack.upstreamTo(REFRESH_GRANT).length,
    0,
    "GoTrue was never called",
  );
  assertEquals(await authFailCount(ip), 0, "413 is not an auth failure");
});

Deno.test("S2 HELD: a chunked body exactly at the 5 000 000-byte cap is read; one byte more is 413", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.23";
  const atCap = await attack.harness.handler(
    refreshRequest(ip, chunkedBody(5_000_000)),
  );
  const atCapJson = await readJson(atCap);
  // Whitespace-only JSON is unparseable → {} → validation error, not 413.
  assertEquals(
    atCap.status,
    400,
    `at cap: ${atCap.status} ${JSON.stringify(atCapJson)}`,
  );
  const overCap = await attack.harness.handler(
    refreshRequest(ip, chunkedBody(5_000_001)),
  );
  assertEquals(overCap.status, 413, "5 000 001 bytes");
  await overCap.body?.cancel();
  assertEquals(attack.upstreamTo(REFRESH_GRANT).length, 0);
});

Deno.test("S2 HELD: a lying Content-Length (small) with a 6 MB chunked body is still 413", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.24";
  const response = await attack.harness.handler(
    refreshRequest(ip, chunkedBody(6 * 1024 * 1024 + 1), {
      "Content-Length": "10",
    }),
  );
  await response.body?.cancel();
  assertEquals(response.status, 413, `status ${response.status}`);
  assertEquals(attack.upstreamTo(REFRESH_GRANT).length, 0);
});

Deno.test("S2 HELD: a valid refresh body reaches GoTrue exactly once and rotates the session", async () => {
  const attack = await loadAttack3();
  const ip = "198.51.100.25";
  const response = await attack.harness.handler(
    refreshRequest(ip, JSON.stringify({ refreshToken: "  rt-with-padding  " })),
  );
  const json = await readJson(response);
  assertEquals(response.status, 200, JSON.stringify(json));
  const grants = attack.upstreamTo(`${REFRESH_GRANT}?grant_type=refresh_token`);
  assertEquals(grants.length, 1);
  assertEquals(
    JSON.parse(grants[0].bodyText).refresh_token,
    "rt-with-padding",
    "trimmed before forwarding",
  );
  const session = json.session as Record<string, unknown>;
  assertEquals(typeof session.accessToken, "string");
  assertEquals(typeof session.refreshToken, "string");
  assertEquals(typeof session.expiresAt, "number");
});
