// STRUCTURAL AUDIT #1 (edge-auth-cache-ratelimit) — http.ts helper probes.
// `[defect]` tests assert what the helper's own doc comment promises and
// FAIL on 4d812e1a; untagged tests pass and pin verified behaviour.
//
// Run: (cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json audit_s1_http_test.ts)

import { assert, assertEquals } from "@std/assert";
import {
  accessLogEntry,
  clientIp,
  constantTimeEqual,
  errorCodeOf,
  resolveRequestId,
  routeTemplate,
  sanitizeUserText,
  withRequestId,
} from "../http.ts";

// ─── sanitizeUserText ────────────────────────────────────────────────────────

Deno.test("[defect] sanitizeUserText: invisible/bidi format characters outside the strip class survive (U+061C, U+2060, U+180E, U+00AD, TAG chars)", () => {
  // The doc comment promises to strip "zero-width/bidi characters that enable
  // spoofing". These are Unicode Default_Ignorable / Bidi_Control code points
  // with exactly that property and they pass through untouched.
  const probes: Array<[string, string]> = [
    ["U+061C ARABIC LETTER MARK (Bidi_Control)", "Ann\u061Ca"],
    ["U+2060 WORD JOINER (zero width)", "An\u2060na"],
    ["U+2061..U+2064 invisible operators", "An\u2061\u2062\u2063\u2064na"],
    ["U+180E MONGOLIAN VOWEL SEPARATOR", "An\u180Ena"],
    ["U+00AD SOFT HYPHEN (invisible)", "An\u00ADna"],
    [
      "U+FFF9..U+FFFB interlinear annotation controls",
      "An\uFFF9\uFFFA\uFFFBna",
    ],
    [
      "U+E0001 / U+E0020..E007F TAG characters",
      "Anna\u{E0001}\u{E0041}\u{E007F}",
    ],
  ];
  const leaked = probes
    .filter(([, input]) => sanitizeUserText(input, 64) !== "Anna")
    .map(([label, input]) =>
      `${label} → ${JSON.stringify(sanitizeUserText(input, 64))}`
    );
  assertEquals(
    leaked,
    [],
    "format characters that enable spoofing must be stripped",
  );
});

Deno.test("[defect] sanitizeUserText: stripping U+200D breaks legitimate emoji ZWJ sequences into their parts", () => {
  // 👩‍💻 (woman technologist) = U+1F469 U+200D U+1F4BB. Removing the joiner
  // renders two separate emoji instead of one glyph; 👨‍👩‍👧 becomes three
  // people. Names and notes with such emoji are silently altered.
  const technologist = "\u{1F469}\u200D\u{1F4BB}";
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";
  assertEquals(
    sanitizeUserText(`Sam ${technologist}`, 64),
    `Sam ${technologist}`,
  );
  assertEquals(sanitizeUserText(family, 64), family);
});

Deno.test("sanitizeUserText: C0/C1 controls, bidi overrides, BOM, ZWSP and lone surrogates are removed; whitespace collapses", () => {
  assertEquals(
    sanitizeUserText(
      "\u0000A\u0007n\u009Fn\u202Ea\uFEFF\u200B  \t\n b\ud800c",
      64,
    ),
    "Anna bc",
  );
});

Deno.test("sanitizeUserText: cap counts code points and never splits a surrogate pair", () => {
  const out = sanitizeUserText("ab\u{1F600}cd", 3);
  assertEquals(out, "ab\u{1F600}");
  assert(!/[\ud800-\udbff]$/.test(out), "no dangling high surrogate");
});

Deno.test("sanitizeUserText: trailing whitespace produced by the cut is trimmed", () => {
  assertEquals(sanitizeUserText("abc def", 4), "abc");
});

Deno.test("sanitizeUserText: Unicode line/paragraph separators (U+2028/2029) and NBSP collapse to one space", () => {
  assertEquals(sanitizeUserText("a\u2028b\u2029c\u00A0d", 64), "a b c d");
});

// ─── clientIp ────────────────────────────────────────────────────────────────

Deno.test("clientIp: whitespace-only cf-connecting-ip falls through to the LAST x-forwarded-for hop", () => {
  const request = new Request("http://x", {
    headers: {
      "cf-connecting-ip": "   ",
      "x-forwarded-for": "1.1.1.1, 2.2.2.2 ,, 3.3.3.3",
    },
  });
  assertEquals(clientIp(request), "3.3.3.3");
});

Deno.test("clientIp: no address headers → the literal 'unknown' (one shared limiter identity)", () => {
  assertEquals(clientIp(new Request("http://x")), "unknown");
  assertEquals(
    clientIp(
      new Request("http://x", { headers: { "x-forwarded-for": " , , " } }),
    ),
    "unknown",
  );
});

Deno.test("clientIp: cf-connecting-ip is used verbatim — no shape validation, an arbitrary token becomes the limiter key", () => {
  const request = new Request("http://x", {
    headers: { "cf-connecting-ip": "not-an-ip-" + "x".repeat(200) },
  });
  const ip = clientIp(request);
  assertEquals(ip.length, 210);
});

// ─── constantTimeEqual ───────────────────────────────────────────────────────

Deno.test("constantTimeEqual: equal strings true; different length / content false; empty vs empty true", () => {
  assert(constantTimeEqual("secret", "secret"));
  assert(!constantTimeEqual("secret", "secreT"));
  assert(!constantTimeEqual("secret", "secret1"));
  assert(!constantTimeEqual("", "a"));
  assert(constantTimeEqual("", ""));
  assert(constantTimeEqual("ünï", "ünï"));
});

// ─── request id / access log ─────────────────────────────────────────────────

Deno.test("resolveRequestId: 8–64 chars of [A-Za-z0-9._-] echoed (trimmed); anything else minted as UUID", () => {
  const ok = "abc.DEF_123-xyz";
  assertEquals(
    resolveRequestId(
      new Request("http://x", { headers: { "x-request-id": `  ${ok}  ` } }),
    ),
    ok,
  );
  for (
    const bad of [
      "short",
      "a".repeat(65),
      "has space",
      "semi;colon",
      "ünïcode-1234",
      "00000000;",
    ]
  ) {
    const minted = resolveRequestId(
      new Request("http://x", { headers: { "x-request-id": bad } }),
    );
    assert(
      /^[0-9a-f-]{36}$/.test(minted),
      `${JSON.stringify(bad)} → ${minted}`,
    );
  }
});

Deno.test("routeTemplate: UUIDs and ≥4-digit runs collapse to :id; short digits and words stay", () => {
  assertEquals(
    routeTemplate(
      "/v1/shots/3f2504e0-4f89-11d3-9a0c-0305e82c3301/details/12345/x/123",
    ),
    "/v1/shots/:id/details/:id/x/123",
  );
});

Deno.test("accessLogEntry: categorical fields only (no url, query, ip, bearer)", async () => {
  const request = new Request("http://x/v1/me?token=secret&q=1", {
    headers: { Authorization: "Bearer aaaa", "x-forwarded-for": "9.9.9.9" },
  });
  const response = new Response(
    JSON.stringify({ error: { code: "validation.x", message: "m" } }),
    {
      status: 400,
      headers: { "Content-Type": "application/json" },
    },
  );
  const code = await errorCodeOf(response);
  const entry = accessLogEntry(
    request,
    response,
    "req-id-12345678",
    performance.now(),
    code,
  );
  const line = JSON.stringify(entry);
  assertEquals(Object.keys(entry).sort(), [
    "code",
    "durationMs",
    "evt",
    "method",
    "requestId",
    "route",
    "status",
  ]);
  assert(
    !line.includes("secret") && !line.includes("9.9.9.9") &&
      !line.includes("aaaa") && !line.includes("?"),
  );
  // The response the client receives is still readable after errorCodeOf().
  assertEquals(
    ((await response.json()) as { error: { code: string } }).error.code,
    "validation.x",
  );
});

Deno.test("withRequestId: null-body statuses (204/304) survive re-wrapping; header set exactly once", () => {
  for (const status of [204, 304]) {
    const out = withRequestId(new Response(null, { status }), "rid-00000001");
    assertEquals(out.status, status);
    assertEquals(out.headers.get("x-request-id"), "rid-00000001");
  }
  const dup = withRequestId(
    new Response("x", { headers: { "x-request-id": "client-supplied-1" } }),
    "server-id-01",
  );
  assertEquals(dup.headers.get("x-request-id"), "server-id-01");
});

Deno.test("errorCodeOf: 2xx → undefined; non-JSON 4xx → undefined; malformed JSON 5xx → undefined", async () => {
  assertEquals(
    await errorCodeOf(new Response("{}", { status: 200 })),
    undefined,
  );
  assertEquals(
    await errorCodeOf(new Response("plain", { status: 404 })),
    undefined,
  );
  assertEquals(
    await errorCodeOf(
      new Response("{not json", {
        status: 503,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    undefined,
  );
});
