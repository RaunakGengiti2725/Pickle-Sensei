// Unit evidence for supabase/functions/api/http.ts.
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  clientIp,
  constantTimeEqual,
  JSON_SECURITY_HEADERS,
  legalTextResponse,
  sanitizeUserText,
} from "../http.ts";

Deno.test("sanitizeUserText strips C0/C1 controls, zero-width, bidi overrides, BOM", () => {
  const input = "\u0000A\u0007l\u007fi\u009f\u200b\u200f\u202a\u202e\u2066\u2069\ufeffce";
  assertEquals(sanitizeUserText(input, 64), "Alice");
});

Deno.test(
  "sanitizeUserText removes CR/LF (header/log injection vector) and collapses spaces",
  () => {
    assertEquals(sanitizeUserText("  a  b   c  ", 64), "a b c");
    assert(!/[\r\n]/.test(sanitizeUserText("a\r\nSet-Cookie: x", 64)));
  },
);

Deno.test(
  "[defect-pin] sanitizeUserText deletes \\n \\r \\t as control chars BEFORE collapsing whitespace, gluing words together",
  () => {
    // http.ts:42 strips \u0000-\u001f (which includes \t \n \r) and only then
    // http.ts:43 collapses \s+ — so a line break between words is lost, not
    // turned into a space.
    assertEquals(sanitizeUserText("lose\nmy\tdinks\r\nfast", 64), "losemydinksfast");
  },
);

Deno.test("sanitizeUserText truncates to maxLength in UTF-16 code units", () => {
  assertEquals(sanitizeUserText("x".repeat(600), 512).length, 512);
});

Deno.test(
  "[defect-pin] sanitizeUserText can end on an unpaired high surrogate → invalid JSON/UTF-8 string",
  () => {
    const out = sanitizeUserText("a".repeat(511) + "😀", 512);
    assertEquals(out.length, 512);
    const last = out.charCodeAt(out.length - 1);
    assert(last >= 0xd800 && last <= 0xdbff, "last code unit is a lone high surrogate");
    assert(!out.isWellFormed(), "String is not well-formed UTF-16");
    // JSON.stringify emits "\ud83d" (an escaped lone surrogate) — PostgreSQL's
    // json/jsonb parser rejects it: "Unicode low surrogate must follow a high
    // surrogate." (verified against postgres:16 in this audit).
    assert(JSON.stringify(out).endsWith('\\ud83d"'));
  },
);

Deno.test("clientIp trusts the first X-Forwarded-For hop verbatim", () => {
  const req = new Request("http://x/", {
    headers: { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1", "cf-connecting-ip": "198.51.100.1" },
  });
  assertEquals(clientIp(req), "203.0.113.9");
  assertEquals(clientIp(new Request("http://x/")), "unknown");
});

Deno.test("constantTimeEqual compares byte-wise and rejects length mismatch", () => {
  assert(constantTimeEqual("secret", "secret"));
  assert(!constantTimeEqual("secret", "secreT"));
  assert(!constantTimeEqual("secret", "secret2"));
  assert(!constantTimeEqual("", "a"));
});

Deno.test("JSON_SECURITY_HEADERS pin content-type, nosniff, no-store, no-referrer", () => {
  assertEquals(JSON_SECURITY_HEADERS, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
});

Deno.test("Headers API rejects CR/LF so a hostile value cannot split response headers", () => {
  let threw = false;
  try {
    new Headers({ "X-Test": "a\r\nSet-Cookie: pwned=1" });
  } catch {
    threw = true;
  }
  assert(threw);
});

Deno.test("legalTextResponse is text/plain, nosniff, publicly cacheable for 1h", () => {
  const res = legalTextResponse("hello");
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assertEquals(res.headers.get("x-content-type-options"), "nosniff");
  assertEquals(res.headers.get("cache-control"), "public, max-age=3600");
});
