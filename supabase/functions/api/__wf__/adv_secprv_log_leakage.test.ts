// INT-security-privacy adversary — Edge log / error-body leakage attacks
// against HEAD 2994371e (integration head).
//
// Every attack plants a distinctive canary in a client-controlled or
// upstream-controlled field and asserts the canary never appears in
//   (a) the response body / headers handed back to the client, or
//   (b) any console line the function emits (access log or otherwise),
// and that exactly ONE structured access-log record is produced per request.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adv_secprv_log_leakage.test.ts

import { assert, assertEquals, assertMatch, assertStringIncludes } from "@std/assert";
import {
  captureConsole,
  loadHarness,
  TEST_USER_ID,
  userRequest,
  webhookRequest,
} from "./routesHarness.ts";

const CANARY = "XCANARY_LEAK_7f3a9";
const CANARY_EMAIL = `${CANARY.toLowerCase()}@leak.example`;
const CANARY_PATH = `/Users/${CANARY}/Movies/backhand.mov`;
const CANARY_TOKEN = `eyJ${CANARY}.eyJzdWIiOiIxIn0.sig${CANARY}`;

interface AccessRecord {
  evt: string;
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
}

function parseAccess(lines: string[]): AccessRecord {
  assertEquals(lines.length, 1, `exactly one access-log record expected, got ${lines.length}`);
  const record = JSON.parse(lines[0]) as AccessRecord;
  assertEquals(record.evt, "api_request");
  assertEquals(
    Object.keys(record).sort(),
    ["code", "durationMs", "evt", "method", "requestId", "route", "status"].filter(
      (key) => key !== "code" || record.code !== undefined,
    ).sort(),
  );
  assertMatch(record.route, /^\/[A-Za-z0-9:_\-/]*$/);
  return record;
}

async function responseText(response: Response): Promise<string> {
  const headers: string[] = [];
  response.headers.forEach((value, key) => headers.push(`${key}: ${value}`));
  return `${headers.join("\n")}\n${await response.text()}`;
}

Deno.test("hostile path segments never reach the access log: email, path, token, newline, traversal", async () => {
  const h = await loadHarness();
  const hostilePaths = [
    `/v1/me/${encodeURIComponent(CANARY_EMAIL)}`,
    `/v1/sessions/${encodeURIComponent(CANARY_PATH)}/shots`,
    `/v1/sessions/${CANARY_TOKEN}`,
    `/v1/me/%0A%5Bapi%5D%20FORGED%20${CANARY}`,
    `/v1/me/../../${CANARY}/etc/passwd`,
    `/v1/analyses/${CANARY}?access_token=${CANARY_TOKEN}&email=${CANARY_EMAIL}`,
  ];
  for (const path of hostilePaths) {
    h.reset();
    const { result, logs, accessLogs, output } = await captureConsole(() =>
      h.handler(userRequest("GET", path))
    );
    await result.text();
    assert(result.status >= 400 && result.status < 500, `${path} → ${result.status}`);
    const record = parseAccess(accessLogs);
    assert(!accessLogs[0].includes(CANARY), `access log leaked canary: ${accessLogs[0]}`);
    assert(!accessLogs[0].includes("@"), `access log carries an email: ${accessLogs[0]}`);
    assert(!accessLogs[0].includes("?"), `access log carries a query string: ${accessLogs[0]}`);
    assert(!/\n/.test(accessLogs[0].slice(0, -1)), "access log record must be one line");
    assert(!output.includes(CANARY), `console output leaked canary: ${output}`);
    assertEquals(logs.length, 0, `unexpected non-access console output for ${path}: ${output}`);
    assertMatch(record.requestId, /^[0-9a-f-]{36}$/);
  }
});

Deno.test("4xx bodies do not reflect the raw request path (unknown-endpoint echo)", async () => {
  const h = await loadHarness();
  const hostilePaths = [
    `/v1/sessions/${encodeURIComponent(CANARY_PATH)}/shots`,
    `/v1/sessions/${CANARY_TOKEN}`,
    `/v1/nope/${encodeURIComponent(CANARY_EMAIL)}`,
    `/v1/${"A".repeat(4_000)}${CANARY}`,
  ];
  for (const path of hostilePaths) {
    h.reset();
    const { result } = await captureConsole(() => h.handler(userRequest("GET", path)));
    const body = await result.text();
    assert(result.status >= 400 && result.status < 500, `${path} → ${result.status}`);
    assert(
      !body.includes(CANARY),
      `response reflected the raw request path (${body.length} bytes) for ${path.slice(0, 80)}…: ${
        body.slice(0, 200)
      }`,
    );
  }
});

Deno.test("x-request-id: email/path/token-shaped and oversize ids are replaced, never echoed", async () => {
  const h = await loadHarness();
  const bearer = "session-bearer-canary-" + CANARY;
  const ids = [
    CANARY_EMAIL,
    CANARY_PATH,
    `Bearer ${CANARY}`,
    CANARY_TOKEN + "x".repeat(70),
    "a".repeat(65),
    "short",
    bearer,
    // 43-char base64url (32 random bytes) — the shape of a refresh/secret token.
    "A".repeat(42) + "Q",
  ];
  for (const id of ids) {
    h.reset();
    const { result, accessLogs } = await captureConsole(() =>
      h.handler(
        userRequest("GET", "/v1/me/access", {
          token: bearer,
          headers: { "x-request-id": id },
        }),
      )
    );
    await result.text();
    const echoed = result.headers.get("x-request-id") ?? "";
    assert(echoed !== id.trim(), `request id echoed verbatim: ${JSON.stringify(id)}`);
    assertMatch(echoed, /^[0-9a-f-]{36}$/);
    const record = parseAccess(accessLogs);
    assertEquals(record.requestId, echoed);
  }
});

Deno.test("x-request-id: provider-key-shaped ids (sk_live_/ghp_/AKIA/appl_) are not echoed into logs", async () => {
  const h = await loadHarness();
  const secretShaped = [
    `sk_live_${CANARY}ABCDEFGH`,
    `ghp_${CANARY}0123456789abcdef`,
    `AKIA${CANARY}EXAMPLE`,
    `appl_${CANARY}PublicKey`,
    `sbp_${CANARY}0123456789`,
    // A compact JWT (header.payload.signature) that fits the 64-char budget.
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc123XYZ",
  ];
  for (const id of secretShaped) {
    h.reset();
    const { result, accessLogs } = await captureConsole(() =>
      h.handler(userRequest("GET", "/v1/me/access", { headers: { "x-request-id": id } }))
    );
    await result.text();
    const echoed = result.headers.get("x-request-id") ?? "";
    const record = parseAccess(accessLogs);
    assert(
      echoed !== id && record.requestId !== id,
      `secret-shaped request id echoed into access log + response: ${id}`,
    );
  }
});

Deno.test("hostile PostgREST error details never reach the client body or the function logs", async () => {
  const h = await loadHarness();
  h.respond = (call) => {
    if (call.url.includes("/rest/v1/rpc/access_state")) {
      return new Response(
        JSON.stringify({
          code: `42P01\n[api] FORGED ${CANARY}`,
          message: `relation for ${CANARY_EMAIL} at ${CANARY_PATH} bearer ${CANARY_TOKEN}`,
          details: `details ${CANARY}`,
          hint: `hint ${CANARY}`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    return null;
  };
  const { result, accessLogs, output } = await captureConsole(() =>
    h.handler(userRequest("GET", "/v1/me/access"))
  );
  const body = await responseText(result);
  assert(result.status >= 500, `expected a 5xx, got ${result.status}: ${body}`);
  assert(!body.includes(CANARY), `client body leaked upstream detail: ${body}`);
  assert(
    !body.includes("relation") && !body.includes("hint"),
    `client body carries SQL detail: ${body}`,
  );
  assert(!output.includes(CANARY), `function logs leaked upstream detail: ${output}`);
  assert(!output.includes("@"), `function logs carry an email: ${output}`);
  const record = parseAccess(accessLogs);
  assert(record.status >= 500);
});

Deno.test("an unhandled throw with hostile name/message/code/stack is logged categorically only", async () => {
  const h = await loadHarness();
  h.respond = (call) => {
    if (call.url.includes("/rest/v1/rpc/access_state")) {
      const error = new Error(`boom ${CANARY_EMAIL} ${CANARY_PATH}`);
      error.name = `Hostile\n${CANARY}`;
      Object.assign(error, {
        code: `X${CANARY}`,
        status: 7_000_000,
        details: CANARY,
        hint: CANARY_TOKEN,
        provider: CANARY,
        kind: CANARY,
      });
      throw error;
    }
    return null;
  };
  const { result, accessLogs, output } = await captureConsole(() =>
    h.handler(userRequest("GET", "/v1/me/access"))
  );
  const body = await responseText(result);
  assert(result.status >= 500, `expected 5xx, got ${result.status}: ${body}`);
  assert(!body.includes(CANARY), `client body leaked thrown detail: ${body}`);
  assert(!output.includes(CANARY), `function logs leaked thrown detail: ${output}`);
  parseAccess(accessLogs);
});

Deno.test("RevenueCat webhook: hostile event ids, aliases, product ids and secrets never surface", async () => {
  const h = await loadHarness();
  const event = {
    id: `${CANARY}\n[api] forged`,
    type: "INITIAL_PURCHASE",
    app_user_id: CANARY_EMAIL,
    aliases: [CANARY_EMAIL, TEST_USER_ID, `${CANARY_PATH}`],
    original_app_user_id: CANARY_TOKEN,
    product_id: `pickle_${CANARY}`,
    subscriber_attributes: { $email: { value: CANARY_EMAIL } },
    store: CANARY,
  };
  const { result, accessLogs, output } = await captureConsole(() =>
    h.handler(webhookRequest(event))
  );
  const body = await responseText(result);
  assert(!body.includes(CANARY), `webhook response echoed event data: ${body}`);
  assert(!output.includes(CANARY), `webhook logs leaked event data: ${output}`);
  assert(!output.includes("wf-test-webhook-secret"), "webhook secret in logs");
  assert(!body.includes("wf-test-webhook-secret"), "webhook secret in response");
  const record = parseAccess(accessLogs);
  assertEquals(record.route, "/functions/v1/api/webhooks/revenuecat");
  // A rejected webhook credential must be a generic 401 with no hint.
  h.reset();
  const rejected = await captureConsole(() =>
    h.handler(webhookRequest(event, { authorization: `Bearer ${CANARY}` }))
  );
  const rejectedBody = await responseText(rejected.result);
  assertEquals(rejected.result.status, 401);
  assert(!rejectedBody.includes(CANARY), `401 body echoed credential: ${rejectedBody}`);
  assert(!rejected.output.includes(CANARY), `401 logs echoed credential: ${rejected.output}`);
});

Deno.test("client IP / forwarded headers never appear in logs or responses", async () => {
  const h = await loadHarness();
  const ip = "198.51.100.77";
  const { result, accessLogs, output } = await captureConsole(() =>
    h.handler(
      userRequest("GET", "/v1/me/access", {
        ip,
        headers: {
          "cf-connecting-ip": "203.0.113.99",
          "x-real-ip": "192.0.2.5",
          "user-agent": `PickleSensei/1.0 (${CANARY}; ${CANARY_EMAIL})`,
          referer: `https://leak.example/${CANARY}`,
          cookie: `session=${CANARY}`,
        },
      }),
    )
  );
  const body = await responseText(result);
  for (const needle of [ip, "203.0.113.99", "192.0.2.5", CANARY]) {
    assert(!body.includes(needle), `response leaked ${needle}: ${body}`);
    assert(!output.includes(needle), `logs leaked ${needle}: ${output}`);
    assert(!accessLogs.join("").includes(needle), `access log leaked ${needle}`);
  }
  parseAccess(accessLogs);
});

Deno.test("public and 5xx responses carry browser hardening + generic bodies; no stack/edge internals", async () => {
  const h = await loadHarness();
  h.rpcErrors.access_state = 500;
  const { result } = await captureConsole(() => h.handler(userRequest("GET", "/v1/me/access")));
  const body = await result.text();
  assert(result.status >= 500);
  assertEquals(result.headers.get("X-Frame-Options"), "DENY");
  assertStringIncludes(result.headers.get("Content-Security-Policy") ?? "", "default-src 'none'");
  assert(!/at .*\.ts:\d+/.test(body), `stack frame in body: ${body}`);
  assert(!/injected rpc failure|XX000/.test(body), `upstream detail in body: ${body}`);
});
