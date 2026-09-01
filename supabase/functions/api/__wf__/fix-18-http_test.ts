import { assertEquals } from "jsr:@std/assert@1";
import { clientIp, sanitizeUserText } from "../http.ts";

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

Deno.test("sanitizeUserText never splits a surrogate pair at the length cap", () => {
  const out = sanitizeUserText("a".repeat(511) + "😀", 512);
  assertEquals(out, "a".repeat(511) + "😀");
  assertEquals(isWellFormed(out), true);
  assertEquals(JSON.parse(JSON.stringify(out)), out);

  const cut = sanitizeUserText("a".repeat(511) + "😀😀", 512);
  assertEquals(cut, "a".repeat(511) + "😀");
  assertEquals(isWellFormed(cut), true);
});

Deno.test("sanitizeUserText caps in code points and matches the DB char_length caps", () => {
  const emoji = "😀".repeat(10);
  assertEquals(sanitizeUserText(emoji, 3), "😀😀😀");
  assertEquals(Array.from(sanitizeUserText(emoji, 3)).length, 3);
  assertEquals(sanitizeUserText("abc", 3), "abc");
  assertEquals(sanitizeUserText("abcd", 3), "abc");
});

Deno.test("sanitizeUserText drops lone surrogates present in the input", () => {
  const out = sanitizeUserText("dink\ud83dshot\udc00", 64);
  assertEquals(out, "dinkshot");
  assertEquals(isWellFormed(out), true);
  assertEquals(sanitizeUserText("\udc00😀\ud83d", 64), "😀");
});

Deno.test("sanitizeUserText normalises line breaks and tabs to a single space", () => {
  assertEquals(sanitizeUserText("lose\nmy\tdinks\r\nfast", 64), "lose my dinks fast");
  assertEquals(sanitizeUserText("  third\u000b\u000cshot  drop\n", 64), "third shot drop");
});

Deno.test("sanitizeUserText still strips non-whitespace control and spoofing characters", () => {
  assertEquals(sanitizeUserText("a\u0000b\u0007c\u001bd\u007fe\u0085f", 64), "abcdef");
  assertEquals(sanitizeUserText("Ra\u200bun\u202eak\ufeff", 64), "Raunak");
});

Deno.test("sanitizeUserText leaves no trailing whitespace after truncation", () => {
  assertEquals(sanitizeUserText("dink shot", 5), "dink");
});

Deno.test("clientIp prefers cf-connecting-ip over any x-forwarded-for hop", () => {
  const request = new Request("https://example.test/healthz", {
    headers: {
      "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3",
      "cf-connecting-ip": "203.0.113.9",
    },
  });
  assertEquals(clientIp(request), "203.0.113.9");
});

Deno.test("clientIp ignores the client-controlled leading x-forwarded-for hops", () => {
  const spoofed = new Request("https://example.test/healthz", {
    headers: { "x-forwarded-for": "9.9.9.9, 203.0.113.9" },
  });
  const spoofedAgain = new Request("https://example.test/healthz", {
    headers: { "x-forwarded-for": "8.8.8.8 , 203.0.113.9" },
  });
  assertEquals(clientIp(spoofed), "203.0.113.9");
  assertEquals(clientIp(spoofedAgain), "203.0.113.9");
  assertEquals(clientIp(spoofed), clientIp(spoofedAgain));
});

Deno.test("clientIp uses the only x-forwarded-for hop when the edge header is absent", () => {
  const request = new Request("https://example.test/healthz", {
    headers: { "x-forwarded-for": " 198.51.100.4 " },
  });
  assertEquals(clientIp(request), "198.51.100.4");
});

Deno.test("clientIp falls back to 'unknown' without any client address", () => {
  assertEquals(clientIp(new Request("https://example.test/healthz")), "unknown");
  assertEquals(
    clientIp(
      new Request("https://example.test/healthz", {
        headers: { "x-forwarded-for": " , ,", "cf-connecting-ip": "  " },
      }),
    ),
    "unknown",
  );
});
