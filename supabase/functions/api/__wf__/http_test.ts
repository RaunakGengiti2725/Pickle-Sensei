// Unit evidence for supabase/functions/api/http.ts.
//   deno test --allow-all --no-check --node-modules-dir=none supabase/functions/api/__wf__/

import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BROWSER_HARDENING_HEADERS,
  clientIp,
  constantTimeEqual,
  JSON_SECURITY_HEADERS,
  legalTextResponse,
  isSupabaseEndpointRequest,
  sanitizeUserText,
  withBrowserHardening,
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

Deno.test("Supabase service targets retain exact origin and their own endpoint namespace", () => {
  const base = "https://supabase.test";
  for (const path of [
    "/auth/v1/token?grant_type=refresh_token",
    "/auth/v1/logout?scope=local",
    "/auth/v1/admin/users/user-id",
  ]) {
    assert(isSupabaseEndpointRequest(base + path, base, "auth"));
    assert(!isSupabaseEndpointRequest(base + path, base, "rest"));
  }
  assert(isSupabaseEndpointRequest(base + "/rest/v1/rpc/access_state", base + "/", "rest"));
  assert(
    isSupabaseEndpointRequest(
      "http://127.0.0.1:54321/auth/v1/token",
      "http://127.0.0.1:54321",
      "auth",
    ),
  );
  assert(isSupabaseEndpointRequest(base + "/prefix/auth/v1/user", base + "/prefix/", "auth"));
});

const rejectedAuthTargets = [
  "https://other.test/auth/v1/token",
  "https://supabase.test.other.test/auth/v1/token",
  "https://supabase.test:444/auth/v1/token",
  "http://supabase.test/auth/v1/token",
  "https://supabase.test/rest/v1/users",
  "https://supabase.test/storage/v1/object",
  "https://supabase.test/auth/v1-other/user",
  "https://supabase.test/auth/v1/../../rest/v1/users",
  "https://supabase.test/auth/v1/%2e%2e/%2e%2e/rest/v1/users",
  "https://supabase.test/auth/v1/%2f..%2frest/v1/users",
  "https://supabase.test/auth/v1/%5c..%5crest/v1/users",
  "https://supabase.test/auth/v1/%252f..%252frest/v1/users",
  "https://embedded-user:fixture-only@supabase.test/auth/v1/user",
  "https://supabase.test/auth/v1/token#unexpected",
  "/auth/v1/token",
  "not a URL",
];
for (const [index, target] of rejectedAuthTargets.entries()) {
  Deno.test(`Supabase auth target boundary rejects case ${index + 1}`, () => {
    assert(!isSupabaseEndpointRequest(target, "https://supabase.test", "auth"));
  });
}

Deno.test("Supabase target boundary rejects malformed trusted configuration", () => {
  assert(!isSupabaseEndpointRequest("https://supabase.test/auth/v1/user", "not a URL", "auth"));
  assert(
    !isSupabaseEndpointRequest(
      "https://supabase.test/auth/v1/user",
      "https://embedded-user:fixture-only@supabase.test",
      "auth",
    ),
  );
});

Deno.test("constantTimeEqual compares byte-wise and rejects length mismatch", () => {
  assert(constantTimeEqual("secret", "secret"));
  assert(!constantTimeEqual("secret", "secreT"));
  assert(!constantTimeEqual("secret", "secret2"));
  assert(!constantTimeEqual("", "a"));
});

Deno.test(
  "BROWSER_HARDENING_HEADERS deny scripts, framing, and plaintext downgrade (OWASP REST cheat sheet)",
  () => {
    assertEquals(BROWSER_HARDENING_HEADERS, {
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    });
  },
);

Deno.test(
  "JSON_SECURITY_HEADERS pin content-type, nosniff, no-store, no-referrer + browser hardening",
  () => {
    assertEquals(JSON_SECURITY_HEADERS, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      ...BROWSER_HARDENING_HEADERS,
    });
  },
);

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

Deno.test(
  "failureDetail projects only bounded diagnostics, never message/stack/body/identity",
  async () => {
    const { failureDetail } = await import("../http.ts");
    const secret =
      "FAKE-token FAKE-email@example.test https://FAKE-private.test/clip?token=FAKE-token";
    const error = Object.assign(new TypeError(secret, { cause: secret }), {
      code: "23514",
      status: 409,
      details: secret,
      hint: secret,
      userId: secret,
      operation: secret,
      provider: secret,
      headers: { Authorization: secret },
      body: secret,
      toJSON: () => {
        throw new Error("must not serialize the error");
      },
    });
    Object.defineProperties(error, {
      message: {
        get() {
          throw new Error("must not read message");
        },
      },
      stack: {
        get() {
          throw new Error("must not read stack");
        },
      },
    });
    assertEquals(failureDetail(error), { name: "TypeError", code: "23514", status: 409 });
    assertEquals(
      failureDetail({ name: "AuthApiError", code: "over_request_rate_limit", status: 429 }),
      {
        name: "AuthApiError",
        code: "over_request_rate_limit",
        status: 429,
      },
    );
    assertEquals(failureDetail({ code: "PGRST202" }, 404), {
      name: "unknown",
      code: "PGRST202",
      status: 404,
    });
    assertEquals(failureDetail({ name: "InvalidSessionResponse" }, 200), {
      name: "InvalidSessionResponse",
      code: "unknown",
      status: 200,
    });
    assertEquals(
      failureDetail({
        name: "ExternalAccountError",
        kind: "configuration",
        provider: "apple",
        status: 503,
      }),
      {
        name: "ExternalAccountError",
        code: "unknown",
        status: 503,
        kind: "configuration",
        provider: "apple",
      },
    );
    assertEquals(failureDetail({ name: "ExternalAccountError", kind: secret, provider: secret }), {
      name: "ExternalAccountError",
      code: "unknown",
      status: null,
    });
    for (const value of [secret, new String("23514"), null, undefined, [], 42]) {
      assertEquals(failureDetail(value), { name: "unknown", code: "unknown", status: null });
    }
    for (const status of [secret, "503", 0, 99, 600, -1, 500.5, NaN, Infinity]) {
      assertEquals(failureDetail({ name: secret, code: secret, status }), {
        name: "unknown",
        code: "unknown",
        status: null,
      });
    }
    for (const code of [
      "23514\n",
      "PGRST202\r\n",
      "23514\nFAKE-token",
      "23514-extra",
      "pgrst202",
      "PGRST20",
      "FAKE-token",
      23514,
    ]) {
      assertEquals(failureDetail({ code }).code, "unknown");
    }
    assertEquals(
      failureDetail({
        get code() {
          throw new Error(secret);
        },
      }),
      {
        name: "unknown",
        code: "unknown",
        status: null,
      },
    );
  },
);

Deno.test(
  "failure logging sink inventory covers every first-party shipping Edge module",
  async () => {
    const sinks: Record<string, number> = {};
    for await (const entry of Deno.readDir(new URL("..", import.meta.url))) {
      if (!entry.isFile || !entry.name.endsWith(".ts")) continue;
      const source = await Deno.readTextFile(new URL(`../${entry.name}`, import.meta.url));
      const matches = source.match(/\bconsole\s*(?:\.|\[)/g) ?? [];
      if (matches.length) sinks[entry.name] = matches.length;
    }
    assertEquals(sinks, { "http.ts": 2, "index.ts": 20 });
    const deletion = await Deno.readTextFile(
      new URL("../accountDeletionOperations.ts", import.meta.url),
    );
    assert(deletion.includes("dependencies.onFailure?.(failureCode, boundedFailureStatus(error))"));
  },
);
Deno.test("legalTextResponse carries CSP, frame denial, and HSTS like the JSON routes", () => {
  const res = legalTextResponse("hello");
  for (const [name, value] of Object.entries(BROWSER_HARDENING_HEADERS)) {
    assertEquals(res.headers.get(name), value);
  }
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
});

Deno.test(
  "withBrowserHardening adds the missing headers to bare responses (204, 429)",
  async () => {
    const empty = withBrowserHardening(new Response(null, { status: 204 }));
    assertEquals(empty.status, 204);
    assertEquals(empty.body, null);
    for (const [name, value] of Object.entries(BROWSER_HARDENING_HEADERS)) {
      assertEquals(empty.headers.get(name), value);
    }

    const limited = withBrowserHardening(
      new Response(JSON.stringify({ error: { code: "rate_limited" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": "7" },
      }),
    );
    assertEquals(limited.status, 429);
    assertEquals(limited.headers.get("retry-after"), "7");
    assertEquals(limited.headers.get("content-type"), "application/json");
    for (const [name, value] of Object.entries(BROWSER_HARDENING_HEADERS)) {
      assertEquals(limited.headers.get(name), value);
    }
    assertEquals((await limited.json()).error.code, "rate_limited");
  },
);

Deno.test("withBrowserHardening never overrides a header the route already set", () => {
  const res = withBrowserHardening(
    new Response("x", { headers: { "Content-Security-Policy": "default-src 'self'" } }),
  );
  assertEquals(res.headers.get("content-security-policy"), "default-src 'self'");
  assertEquals(res.headers.get("x-frame-options"), "DENY");
});
