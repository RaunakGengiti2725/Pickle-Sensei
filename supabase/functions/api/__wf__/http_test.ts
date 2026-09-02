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
  "sanitizeUserText turns \\n \\r \\t between words into single spaces instead of gluing words together",
  () => {
    assertEquals(sanitizeUserText("lose\nmy\tdinks\r\nfast", 64), "lose my dinks fast");
  },
);

Deno.test("sanitizeUserText truncates to maxLength code points", () => {
  assertEquals(sanitizeUserText("x".repeat(600), 512).length, 512);
});

Deno.test(
  "sanitizeUserText never truncates inside a surrogate pair, so the result is valid UTF-16 / JSON",
  () => {
    const out = sanitizeUserText("a".repeat(511) + "😀", 512);
    assertEquals(Array.from(out).length, 512);
    assert(out.endsWith("😀"), "the emoji survives whole");
    assert(out.isWellFormed(), "String is well-formed UTF-16");
    assert(!JSON.stringify(out).includes("\\ud83d"));

    const cut = sanitizeUserText("a".repeat(512) + "😀", 512);
    assertEquals(cut, "a".repeat(512));
    assert(cut.isWellFormed());
  },
);

Deno.test(
  "clientIp prefers the edge's cf-connecting-ip and otherwise the LAST X-Forwarded-For hop",
  () => {
    const req = new Request("http://x/", {
      headers: { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1", "cf-connecting-ip": "198.51.100.1" },
    });
    assertEquals(clientIp(req), "198.51.100.1");
    assertEquals(
      clientIp(
        new Request("http://x/", { headers: { "x-forwarded-for": " 203.0.113.9 , 10.0.0.1" } }),
      ),
      "10.0.0.1",
    );
    assertEquals(clientIp(new Request("http://x/")), "unknown");
  },
);

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
