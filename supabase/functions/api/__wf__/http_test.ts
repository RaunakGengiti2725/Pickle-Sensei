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

Deno.test(
  "sanitizeUserText keeps ZWNJ/ZWJ (U+200C/U+200D) that Persian, Indic and emoji sequences need",
  () => {
    const persian = "علی\u200cرضا";
    const sinhala = "ශ්\u200dරී";
    const family = "👨\u200d👩\u200d👧\u200d👦";
    assertEquals(sanitizeUserText(persian, 40), persian);
    assertEquals(sanitizeUserText(sinhala, 40), sinhala);
    assertEquals(sanitizeUserText(family, 40), family);
  },
);

Deno.test("sanitizeUserText still strips ZWSP and LRM/RLM around the kept joiners", () => {
  assertEquals(sanitizeUserText("a\u200bb\u200ec", 40), "abc");
  assertEquals(sanitizeUserText("a\u200fb\ufeffc", 40), "abc");
  assertEquals(sanitizeUserText("\u200dAli\u200c", 40), "Ali", "joiners without a join context go");
});

Deno.test("clientIp never returns an oversized or non-IP header value as the identity", () => {
  const raw8k = "x".repeat(8000);
  const oversized = clientIp(new Request("http://x/", { headers: { "cf-connecting-ip": raw8k } }));
  assert(oversized !== raw8k);
  assert(oversized.length <= 64, `bounded identity, got ${oversized.length} chars`);

  const junk = clientIp(new Request("http://x/", { headers: { "cf-connecting-ip": "not an ip" } }));
  assert(junk !== "not an ip");
  assert(junk !== "unknown", "junk is not pooled into the shared 'unknown' bucket");
  assertEquals(
    junk,
    clientIp(new Request("http://x/", { headers: { "cf-connecting-ip": "not an ip" } })),
    "the same junk maps to the same bounded identity",
  );
  assert(
    junk !== clientIp(new Request("http://x/", { headers: { "cf-connecting-ip": "other junk" } })),
  );

  // An invalid edge header falls through to the trusted last x-forwarded-for hop.
  assertEquals(
    clientIp(
      new Request("http://x/", {
        headers: { "cf-connecting-ip": raw8k, "x-forwarded-for": "9.9.9.9, 203.0.113.9" },
      }),
    ),
    "203.0.113.9",
  );
});

Deno.test("clientIp validates IPv4/IPv6 and normalises what it accepts", () => {
  const ip = (value: string) =>
    clientIp(new Request("http://x/", { headers: { "cf-connecting-ip": value } }));
  assertEquals(ip("203.0.113.9"), "203.0.113.9");
  assertEquals(ip("203.0.113.9:51234"), "203.0.113.9", "proxy-appended port is dropped");
  assertEquals(ip("2001:DB8::1"), "2001:db8::1", "IPv6 is lower-cased");
  assertEquals(ip("[2001:db8::1]:443"), "2001:db8::1");
  assertEquals(ip("::ffff:203.0.113.9"), "::ffff:203.0.113.9");
  assert(ip("256.1.1.1") !== "256.1.1.1", "out-of-range octet is not an IPv4");
  assert(ip("2001:db8::1::2") !== "2001:db8::1::2", "two '::' is not an IPv6");
  assert(ip("1.2.3") !== "1.2.3");
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
