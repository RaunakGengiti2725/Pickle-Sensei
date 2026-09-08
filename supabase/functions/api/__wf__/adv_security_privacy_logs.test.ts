// INT-security-privacy adversary — edge function logs, error bodies, request
// ids and input sanitisation under hostile input (integration head 30a40650).
//
// Every scenario drives the REAL outer handler captured from Deno.serve
// (routesHarness) with a distinctive marker planted in every client-controlled
// channel (path, query, bearer, x-request-id, body, forwarded IP, cookie,
// user agent) and in every upstream failure channel (PostgREST error shapes,
// GoTrue error bodies, thrown fetch errors). It then sweeps EVERY console
// level plus the structured access log for the marker, the bearer, the user
// id, the client IP, the e-mail and any free text, and checks that error
// bodies stay generic and every response carries the hardening headers.
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adv_security_privacy_logs.test.ts

import { assert, assertEquals, assertMatch, assertNotEquals } from "@std/assert";
import { failureDetail, resolveRequestId, sanitizeUserText } from "../http.ts";
import {
  captureConsole,
  fakeGoogleIdToken,
  fakeSupabaseAccessToken,
  type Harness,
  loadHarness,
  TEST_USER_ID,
  userRequest,
} from "./routesHarness.ts";

const MARKER = "ADVSECMARKER";
const HOSTILE_EMAIL = `${MARKER.toLowerCase()}@example.com`;
const HOSTILE_TEXT = `${MARKER} free text about a coach`;
const HOSTILE_IP = "198.51.100.231";
const HOSTILE_COOKIE = `session=${MARKER}cookie`;
const HOSTILE_UA = `PickleSensei/1.0 (${MARKER})`;

const ACCESS_LOG_KEYS = ["evt", "requestId", "method", "route", "status", "durationMs", "code"];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let ipCounter = 0;
/** Unique per-scenario IP so the in-memory rate limiter never turns a probe into a 429. */
const nextIp = () => `198.51.100.${(ipCounter++ % 200) + 1}`;

interface Sweep {
  response: Response;
  body: string;
  output: string;
  accessLogs: string[];
}

async function sweep(h: Harness, request: Request): Promise<Sweep> {
  const { result: response, output, accessLogs } = await captureConsole(() => h.handler(request));
  const body = await response.text();
  return { response, body, output, accessLogs };
}

function assertHardened(response: Response, label: string) {
  assertEquals(response.headers.get("X-Frame-Options"), "DENY", `${label}: X-Frame-Options`);
  assertEquals(
    response.headers.get("Content-Security-Policy"),
    "default-src 'none'; frame-ancestors 'none'",
    `${label}: CSP`,
  );
  assertEquals(
    response.headers.get("Strict-Transport-Security"),
    "max-age=63072000; includeSubDomains",
    `${label}: HSTS`,
  );
  if (response.status >= 400) {
    assertEquals(response.headers.get("X-Content-Type-Options"), "nosniff", `${label}: nosniff`);
    assertEquals(response.headers.get("Cache-Control"), "no-store", `${label}: no-store`);
  }
}

function assertNoLeak(sweepResult: Sweep, bearer: string, label: string) {
  const haystacks = [sweepResult.output, ...sweepResult.accessLogs];
  for (const needle of [MARKER, HOSTILE_EMAIL, HOSTILE_IP, HOSTILE_TEXT, bearer, TEST_USER_ID]) {
    for (const haystack of haystacks) {
      assertEquals(
        haystack.includes(needle),
        false,
        `${label}: "${needle.slice(0, 24)}" reached the function logs: ${haystack.slice(0, 300)}`,
      );
    }
  }
  assertEquals(sweepResult.accessLogs.length, 1, `${label}: exactly one access log line`);
  const entry = JSON.parse(sweepResult.accessLogs[0]) as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    assert(ACCESS_LOG_KEYS.includes(key), `${label}: unexpected access log field ${key}`);
  }
  assertEquals(entry.evt, "api_request");
  assertEquals(typeof entry.requestId, "string");
  assertEquals(typeof entry.route, "string");
  assertEquals((entry.route as string).includes("?"), false, `${label}: query string in route`);
  assertEquals(
    /[0-9a-f]{8}-[0-9a-f]{4}-/i.test(entry.route as string),
    false,
    `${label}: identifier in route`,
  );
  if (entry.code !== undefined) {
    assertMatch(
      String(entry.code),
      /^[a-z0-9_.]{1,64}$/,
      `${label}: access log code is categorical`,
    );
  }
  for (const needle of [MARKER, HOSTILE_EMAIL, bearer]) {
    assertEquals(
      sweepResult.body.includes(needle),
      false,
      `${label}: "${needle.slice(0, 24)}" in body`,
    );
  }
  assertHardened(sweepResult.response, label);
}

function hasControlOrBidi(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (
      code <= 0x08 || (code >= 0x0e && code <= 0x1f) || (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e)
    ) return true;
  }
  return false;
}

function hostileHeaders(
  bearer: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${bearer}`,
    "x-forwarded-for": `${HOSTILE_IP}, ${nextIp()}`,
    "x-request-id": `<${MARKER}>\u0001`,
    cookie: HOSTILE_COOKIE,
    "user-agent": HOSTILE_UA,
    "x-real-ip": HOSTILE_IP,
    ...extra,
  };
}

function hostileBody(): Record<string, unknown> {
  return {
    email: HOSTILE_EMAIL,
    note: HOSTILE_TEXT,
    uri: `ph://${MARKER}/L0/001`,
    token: `Bearer ${MARKER}`,
    skillLevel: HOSTILE_TEXT,
    handedness: "right",
    goal: HOSTILE_TEXT,
    biggestProblem: HOSTILE_TEXT,
    firstName: MARKER,
  };
}

// ─── A. hostile client channels never reach logs or error bodies ────────────

Deno.test("A1: unknown route carrying a marker in every client channel logs nothing but the template", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  const request = new Request(
    `http://edge.test/functions/v1/api/v1/${MARKER}/11111111-1111-4111-8111-111111111111/${HOSTILE_EMAIL}?access_token=${MARKER}&email=${HOSTILE_EMAIL}`,
    { method: "POST", headers: hostileHeaders(bearer), body: JSON.stringify(hostileBody()) },
  );
  const result = await sweep(h, request);
  assertEquals(result.response.status, 404);
  assertEquals(
    [MARKER, HOSTILE_EMAIL, TEST_USER_ID].filter((needle) => result.body.includes(needle)),
    [],
    `A1: the 404 body reflects client-controlled path input: ${result.body.slice(0, 200)}`,
  );
  assertNoLeak(result, bearer, "A1");
  const entry = JSON.parse(result.accessLogs[0]) as { route: string; requestId: string };
  assertEquals(entry.route, "/functions/v1/api/v1/:id/:id/:id");
  assertMatch(entry.requestId, UUID_RE, "hostile x-request-id must be replaced, not echoed");
  assertEquals(result.response.headers.get("x-request-id"), entry.requestId);
});

Deno.test("A2: malformed JSON, invalid UTF-8 and a failing body stream are 400s with clean logs", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  const cases: Array<[string, BodyInit]> = [
    ["malformed json", `{"email":"${HOSTILE_EMAIL}", ${MARKER}`],
    ["invalid utf-8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
    ["json array", JSON.stringify([hostileBody()])],
    [
      "stream error",
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`{"email":"${HOSTILE_EMAIL}"`));
          controller.error(new Error(`${MARKER} stream failure ${HOSTILE_EMAIL}`));
        },
      }),
    ],
  ];
  for (const [label, body] of cases) {
    const request = new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
      method: "PUT",
      headers: hostileHeaders(bearer, { "Content-Type": "application/json" }),
      body,
    });
    const result = await sweep(h, request);
    assertEquals(result.response.status, 400, `${label}: status ${result.body}`);
    assertNoLeak(result, bearer, `A2 ${label}`);
    assertEquals(h.callsTo("/rest/v1/profiles").length, 0, `${label}: nothing persisted`);
    h.reset();
  }
});

Deno.test("A3: bearer-shaped, hostile and body-equal x-request-id values are never echoed into logs", async () => {
  const h = await loadHarness();
  const bearer = fakeSupabaseAccessToken();
  const refreshToken = "rt_" + "Q".repeat(45); // opaque, 48 chars, matches the request-id grammar
  const attempts: Array<[string, string]> = [
    ["bearer as request id", bearer],
    ["bearer segment", bearer.split(".")[1]],
    ["43-char base64url token", "a".repeat(42) + "A"],
    ["refresh token from the body", refreshToken],
    ["email-like", `${MARKER.toLowerCase()}.example.com`],
    ["overlong", "x".repeat(65)],
    ["too short", "abc1234"],
  ];
  const leaked: string[] = [];
  for (const [label, requestId] of attempts) {
    const request = new Request("http://edge.test/functions/v1/api/v1/auth/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": nextIp(),
        "x-request-id": requestId,
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify({ refreshToken }),
    });
    const result = await sweep(h, request);
    const entry = JSON.parse(result.accessLogs[0]) as { requestId: string };
    for (const secret of [bearer, bearer.split(".")[1], refreshToken]) {
      if (entry.requestId.includes(secret) || secret.includes(entry.requestId)) {
        leaked.push(
          `${label}: credential-derived request id logged (${entry.requestId.slice(0, 12)}…)`,
        );
      }
    }
    if (result.output.includes(refreshToken)) leaked.push(`${label}: refresh token in console`);
    if (result.output.includes(bearer)) leaked.push(`${label}: bearer in console`);
    h.reset();
  }
  assertEquals(leaked, []);
});

// ─── B. upstream failure channels are bounded before they reach logs ───────

Deno.test("B1: PostgREST error message/details/hint carrying PII never reach logs or the 5xx body", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  h.respond = (call) =>
    call.url.includes("/rest/v1/rpc/access_state")
      ? new Response(
        JSON.stringify({
          code: `XX000\n[api] FORGED ${MARKER}`,
          message: `duplicate key ${HOSTILE_EMAIL} ${MARKER}`,
          details: `Key (user_id)=(${TEST_USER_ID}) ${MARKER}`,
          hint: `token=${bearer}`,
          name: `PostgrestError ${MARKER}`,
          status: 500,
          stack: `at ${MARKER} (/var/task/index.ts:1:1)`,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      )
      : null;
  const result = await sweep(
    h,
    userRequest("GET", "/v1/me/access", {
      token: bearer,
      ip: nextIp(),
      headers: hostileHeaders(bearer),
    }),
  );
  assert(
    result.response.status >= 500,
    `expected 5xx, got ${result.response.status} ${result.body}`,
  );
  assertNoLeak(result, bearer, "B1");
  const parsed = JSON.parse(result.body) as { error: { message: string } };
  assertMatch(parsed.error.message, /temporarily unavailable|Something went wrong/);
});

Deno.test("B2: an upstream fetch that throws with PII in message/name/code/stack yields a generic 5xx and bounded log", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  h.respond = (call) => {
    if (!call.url.includes("/rest/v1/")) return null;
    const error = new Error(`connect ECONNREFUSED ${HOSTILE_IP} ${MARKER} ${HOSTILE_EMAIL}`);
    error.name = `TypeError ${MARKER}`;
    (error as Error & { code: string }).code = `ECONNREFUSED ${MARKER}`;
    (error as Error & { status: string }).status = `500 ${MARKER}`;
    throw error;
  };
  const result = await sweep(
    h,
    userRequest("GET", "/v1/me/access", {
      token: bearer,
      ip: nextIp(),
      headers: hostileHeaders(bearer),
    }),
  );
  assert(
    result.response.status >= 500,
    `expected 5xx, got ${result.response.status} ${result.body}`,
  );
  assertNoLeak(result, bearer, "B2");
});

Deno.test("B3: GoTrue rejections with PII in the error body are generic 401/5xx with clean logs", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  for (const status of [400, 401, 403, 422, 429, 500, 502, 503]) {
    h.reset();
    h.respond = (call) =>
      call.url.includes("/auth/v1/token")
        ? new Response(
          JSON.stringify({
            code: `${MARKER}_code`,
            error_code: `${MARKER}_error_code`,
            msg: `Token for ${HOSTILE_EMAIL} rejected ${MARKER}`,
            error: MARKER,
            error_description: `${MARKER} ${TEST_USER_ID}`,
            user: { email: HOSTILE_EMAIL, id: TEST_USER_ID },
          }),
          { status, headers: { "Content-Type": "application/json", "Retry-After": "7" } },
        )
        : null;
    const result = await sweep(
      h,
      userRequest("GET", "/v1/me/access", {
        token: bearer,
        ip: nextIp(),
        headers: hostileHeaders(bearer),
      }),
    );
    assert(
      result.response.status === 401 || result.response.status >= 500 ||
        result.response.status === 429,
      `GoTrue ${status}: got ${result.response.status} ${result.body}`,
    );
    assertNoLeak(result, bearer, `B3 GoTrue ${status}`);
  }
});

Deno.test("B4: failureDetail refuses every hostile shape (getters, proxies, unlisted names, non-integer status)", () => {
  const throwing = new Proxy({}, {
    get() {
      throw new Error(MARKER);
    },
    ownKeys() {
      throw new Error(MARKER);
    },
  });
  assertEquals(failureDetail(throwing), { name: "unknown", code: "unknown", status: null });
  const withGetter = {};
  Object.defineProperty(withGetter, "name", {
    enumerable: true,
    get() {
      throw new Error(MARKER);
    },
  });
  assertEquals(failureDetail(withGetter), { name: "unknown", code: "unknown", status: null });
  const hostile = failureDetail(
    {
      name: `AuthApiError ${MARKER}`,
      code: `XX000 ${MARKER}`,
      status: 500.5,
      kind: MARKER,
      provider: MARKER,
      message: HOSTILE_EMAIL,
      stack: MARKER,
    },
    NaN,
  );
  assertEquals(hostile, { name: "unknown", code: "unknown", status: null });
  assertEquals(JSON.stringify(hostile).includes(MARKER), false);
  const external = failureDetail({
    name: "ExternalAccountError",
    code: "PGRST301",
    status: 403,
    kind: MARKER,
    provider: "google",
  });
  assertEquals(external, { name: "ExternalAccountError", code: "PGRST301", status: 403 });
  assertEquals(failureDetail([MARKER]), { name: "unknown", code: "unknown", status: null });
  assertEquals(failureDetail(MARKER), { name: "unknown", code: "unknown", status: null });
  assertEquals(failureDetail(null, 200), { name: "unknown", code: "unknown", status: 200 });
  assertEquals(failureDetail(undefined, 99), { name: "unknown", code: "unknown", status: null });
  assertEquals(failureDetail(undefined, 600), { name: "unknown", code: "unknown", status: null });
});

Deno.test("B5: resolveRequestId never derives an id from the Authorization header or hostile bytes", () => {
  const bearer = fakeSupabaseAccessToken();
  const build = (requestId: string, authorization = `Bearer ${bearer}`) =>
    new Request("http://edge.test/v1/x", {
      headers: { "x-request-id": requestId, Authorization: authorization },
    });
  const honoured: string[] = [];
  for (
    const hostile of [
      bearer,
      bearer.slice(0, 64),
      bearer.slice(-64),
      `  ${bearer.slice(0, 40)}  `,
      "a".repeat(42) + "A",
      "abc",
      "x".repeat(65),
      `${MARKER}\t${MARKER}`,
      `${MARKER}<script>`,
      "../../etc/passwd",
      `${MARKER}%0a`,
      `${MARKER} ${MARKER}`,
      "",
    ]
  ) {
    const id = resolveRequestId(build(hostile));
    if (!UUID_RE.test(id)) honoured.push(hostile.trim().slice(0, 16) + "…");
  }
  assertEquals(honoured, [], "hostile or credential-derived request ids were honoured");
  assertEquals(resolveRequestId(build("client-trace.0001")), "client-trace.0001");
  assertEquals(resolveRequestId(build("client-trace.0001", `bearer client-trace.0001`)).length, 36);
});

// ─── C. persisted free text is bounded and spoof-free ──────────────────────

Deno.test("C1: onboarding persists sanitized, bounded text and logs none of it", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  h.tables["profiles"] = [];
  const hostileName = `\u202e${MARKER}\u0000\u200b\ud800 ${HOSTILE_EMAIL}`;
  const result = await sweep(
    h,
    userRequest("PUT", "/v1/me/onboarding", {
      token: bearer,
      ip: nextIp(),
      headers: hostileHeaders(bearer),
      body: {
        skillLevel: "beginner\u0007\u202e",
        handedness: "right",
        goal: "dinks",
        biggestProblem: `${HOSTILE_TEXT} ${"x".repeat(2_000)}`,
        firstName: hostileName,
      },
    }),
  );
  assert(
    [200, 400].includes(result.response.status),
    `status ${result.response.status} ${result.body}`,
  );
  assertEquals(result.output.includes(MARKER), false, "marker in console");
  assertEquals(result.output.includes(HOSTILE_EMAIL), false, "email in console");
  assertEquals(result.accessLogs.length, 1);
  assertEquals(result.accessLogs[0].includes(MARKER), false);
  assertHardened(result.response, "C1");
  const patches = h.callsTo("/rest/v1/profiles").filter((call) => call.method === "PATCH");
  for (const patch of patches) {
    const written = JSON.stringify(patch.body);
    assertEquals(hasControlOrBidi(written), false, "controls persisted");
    assertEquals(written.includes("\ud800"), false, "lone surrogate persisted");
    const body = patch.body as Record<string, unknown>;
    if (typeof body.first_name === "string") assert(body.first_name.length <= 40);
    if (typeof body.biggest_problem === "string") assert(body.biggest_problem.length <= 256);
  }
});

Deno.test("C2: sanitizeUserText strips every invisible/bidi format character, not only the listed ranges", () => {
  const invisible: Array<[string, string]> = [
    ["arabic letter mark (bidi)", "\u061c"],
    ["word joiner", "\u2060"],
    ["function application", "\u2061"],
    ["invisible times", "\u2062"],
    ["invisible separator", "\u2063"],
    ["invisible plus", "\u2064"],
    ["inhibit symmetric swapping", "\u206a"],
    ["national digit shapes", "\u206e"],
    ["nominal digit shapes", "\u206f"],
    ["soft hyphen", "\u00ad"],
    ["combining grapheme joiner", "\u034f"],
    ["mongolian vowel separator", "\u180e"],
    ["interlinear annotation anchor", "\ufff9"],
    ["interlinear annotation terminator", "\ufffb"],
    ["language tag", "\u{e0001}"],
    ["tag latin small letter a", "\u{e0061}"],
    ["cancel tag", "\u{e007f}"],
  ];
  const visible = "Al";
  const survived = invisible
    .filter(([, character]) =>
      sanitizeUserText(`${visible}${character}${visible}`, 40) !== `${visible}${visible}`
    )
    .map(([label, character]) => `${label} U+${character.codePointAt(0)!.toString(16)}`);
  assertEquals(survived, [], "invisible or bidi format characters survived sanitisation");
});

Deno.test("C3: sanitizeUserText bounds by code points even for hostile lengths and nested whitespace", () => {
  const long = "\u{1f3be}".repeat(500) + " ".repeat(500) + "\u2028".repeat(500) + "x".repeat(5_000);
  const cleaned = sanitizeUserText(long, 64);
  assertEquals(Array.from(cleaned).length <= 64, true);
  assertEquals(/\s\s/.test(cleaned), false);
  assertEquals(sanitizeUserText("\u0000\u0001\u200b\u202e\ufeff", 10), "");
  assertEquals(sanitizeUserText("  \t\n  ", 10), "");
  assertEquals(sanitizeUserText("\ud800\ud800\udc00\udc00", 10), "\ud800\udc00");
  assertNotEquals(sanitizeUserText("a".repeat(10), 5), "a".repeat(10));
});

// ─── D. query-string and cookie credentials are never authorisation ────────

Deno.test("D1: a token in the query string or cookie never authorises and never reaches the logs", async () => {
  const h = await loadHarness();
  const bearer = fakeGoogleIdToken();
  const request = new Request(
    `http://edge.test/functions/v1/api/v1/me/access?access_token=${bearer}&apikey=${MARKER}`,
    {
      method: "GET",
      headers: {
        "x-forwarded-for": `${HOSTILE_IP}, ${nextIp()}`,
        cookie: `sb-access-token=${bearer}; ${HOSTILE_COOKIE}`,
        "user-agent": HOSTILE_UA,
      },
    },
  );
  const result = await sweep(h, request);
  assertEquals(result.response.status, 401, result.body);
  assertNoLeak(result, bearer, "D1");
  assertEquals(
    h.callsTo("/auth/v1/").length,
    0,
    "query/cookie credential must not be forwarded to Auth",
  );
  assertEquals(
    h.callsTo("/rest/v1/").length,
    0,
    "query/cookie credential must not reach the database",
  );
});
