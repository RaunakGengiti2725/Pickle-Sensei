// INT-security-privacy adversary — input sanitization + bounded body attacks
// against HEAD 2994371e (integration head).
//
//   cd supabase/functions/api/__wf__ && deno test -A --no-check --config deno.json adv_secprv_input_sanitization.test.ts

import { assert, assertEquals } from "@std/assert";
import { sanitizeUserText } from "../http.ts";
import { captureConsole, fakeGoogleIdToken, loadHarness, userRequest } from "./routesHarness.ts";

const codePoints = (value: string): string =>
  Array.from(value)
    .map((char) => "U+" + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"))
    .join(" ");

// Invisible / direction-control characters outside the stripped ranges. Every
// one of them is a spoofing or zero-width primitive of the same class as the
// U+200B–U+200F / U+202A–U+202E / U+2066–U+2069 set the sanitizer removes.
const INVISIBLE_SPOOFING: Array<[string, string]> = [
  ["U+061C ARABIC LETTER MARK (bidi control)", "\u061C"],
  ["U+2060 WORD JOINER", "\u2060"],
  ["U+2061 FUNCTION APPLICATION", "\u2061"],
  ["U+2062 INVISIBLE TIMES", "\u2062"],
  ["U+2063 INVISIBLE SEPARATOR", "\u2063"],
  ["U+2064 INVISIBLE PLUS", "\u2064"],
  ["U+00AD SOFT HYPHEN", "\u00AD"],
  ["U+180E MONGOLIAN VOWEL SEPARATOR", "\u180E"],
  ["U+FFF9 INTERLINEAR ANNOTATION ANCHOR", "\uFFF9"],
  ["U+FFFA INTERLINEAR ANNOTATION SEPARATOR", "\uFFFA"],
  ["U+FFFB INTERLINEAR ANNOTATION TERMINATOR", "\uFFFB"],
  ["U+FFFE NONCHARACTER", "\uFFFE"],
  ["U+FFFF NONCHARACTER", "\uFFFF"],
  ["U+E0041 TAG LATIN CAPITAL LETTER A (invisible tag)", "\u{E0041}"],
  ["U+E007F CANCEL TAG", "\u{E007F}"],
];

Deno.test("sanitizeUserText strips every invisible/bidi spoofing primitive, not only the U+200x/U+202x sets", () => {
  const leaked: string[] = [];
  for (const [label, char] of INVISIBLE_SPOOFING) {
    const out = sanitizeUserText(`Sam${char}antha`, 40);
    if (out !== "Samantha") leaked.push(`${label} survived → ${codePoints(out)}`);
  }
  assertEquals(
    leaked,
    [],
    `invisible characters kept after sanitizeUserText:\n${leaked.join("\n")}`,
  );
});

Deno.test("sanitizeUserText does not corrupt legitimate ZWJ sequences (Sinhala conjuncts, emoji families)", () => {
  // U+200D ZERO WIDTH JOINER is a *required* grapheme component in Sinhala,
  // Malayalam and Bengali conjuncts and in ZWJ emoji sequences; it is not a
  // spoofing primitive when it joins two visible base characters.
  const sinhala = "\u0DC1\u0DCA\u200D\u0DBB\u0DD3"; // ශ්‍රී
  const family = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // 👨‍👩‍👧
  assertEquals(
    codePoints(sanitizeUserText(sinhala, 40)),
    codePoints(sinhala),
    "Sinhala conjunct lost its joiner (renders as a different word)",
  );
  assertEquals(
    codePoints(sanitizeUserText(family, 40)),
    codePoints(family),
    "ZWJ emoji sequence split into three separate emoji",
  );
});

Deno.test("sanitizeUserText refuses names made only of blank/filler glyphs", () => {
  const blanks: Array<[string, string]> = [
    ["U+3164 HANGUL FILLER ×3", "\u3164\u3164\u3164"],
    ["U+2800 BRAILLE PATTERN BLANK ×3", "\u2800\u2800\u2800"],
    ["U+115F/U+1160 HANGUL CHOSEONG/JUNGSEONG FILLER", "\u115F\u1160"],
    ["U+FE0F VARIATION SELECTOR ×3", "\uFE0F\uFE0F\uFE0F"],
    ["U+0300 COMBINING GRAVE ×3 (no base)", "\u0300\u0300\u0300"],
  ];
  const accepted: string[] = [];
  for (const [label, value] of blanks) {
    const out = sanitizeUserText(value, 40);
    if (out.length > 0) accepted.push(`${label} → ${codePoints(out)}`);
  }
  assertEquals(
    accepted,
    [],
    `blank-only inputs accepted as non-empty text:\n${accepted.join("\n")}`,
  );
});

Deno.test("PUT /v1/me/onboarding: the stored firstName carries no invisible spoofing characters", async () => {
  const h = await loadHarness();
  let patched: Record<string, unknown> | null = null;
  h.respond = (call) => {
    if (call.method === "PATCH" && call.url.includes("/rest/v1/profiles")) {
      patched = call.body as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          skill_level: "beginner",
          handedness: "right",
          primary_goal: "consistency",
          biggest_problem: "x",
          focus_checkpoint: "contact_position",
          first_name: String(patched.first_name ?? ""),
          gender: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return null;
  };
  const hostileName = "Sam\u061C\u2060\u00AD\u{E0041}antha\u200E";
  const { result } = await captureConsole(() =>
    h.handler(
      userRequest("PUT", "/v1/me/onboarding", {
        body: {
          handedness: "right",
          skillLevel: "beginner",
          goal: "consistency",
          biggestProblem: "Late contact",
          firstName: hostileName,
        },
      }),
    )
  );
  const body = await result.text();
  assertEquals(result.status, 200, body);
  assert(patched !== null, "profile PATCH was not issued");
  const stored = String((patched as Record<string, unknown>).first_name);
  assertEquals(
    codePoints(stored),
    codePoints("Samantha"),
    `stored first_name still carries invisible characters: ${codePoints(stored)}`,
  );
});

Deno.test("bounded body: chunked (no Content-Length) body over the small-route cap is refused with 413, no leak", async () => {
  const h = await loadHarness();
  const chunk = new TextEncoder().encode('{"firstName":"' + "A".repeat(8_191) + '",');
  let sent = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= 200_000) {
        controller.close();
        return;
      }
      sent += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  const init: RequestInit & { duplex: "half" } = {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${fakeGoogleIdToken()}`,
      "x-forwarded-for": "203.0.113.20",
      "Content-Type": "application/json",
    },
    body: stream,
    duplex: "half",
  };
  const request = new Request("http://edge.test/functions/v1/api/v1/me/onboarding", init);
  const { result, output } = await captureConsole(() => h.handler(request));
  const body = await result.text();
  assertEquals(result.status, 413, body);
  assert(cancelled || sent <= 200_000, "the reader kept draining after the cap");
  assert(!body.includes("AAAA"), "413 body echoed request content");
  assert(!output.includes("AAAA"), "logs echoed request content");
});

Deno.test("bounded body: advisory Content-Length far above the cap is refused before reading; hostile values do not crash", async () => {
  const h = await loadHarness();
  for (
    const declared of ["99999999999", "1e12", "Infinity", "-5", "NaN", "0x7fffffff", "5000001"]
  ) {
    h.reset();
    const request = new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${fakeGoogleIdToken()}`,
        "x-forwarded-for": "203.0.113.20",
        "Content-Type": "application/json",
        "content-length": declared,
      },
      body: '{"handedness":"right"}',
    });
    const { result, accessLogs } = await captureConsole(() => h.handler(request));
    const body = await result.text();
    assert(result.status !== 500, `content-length=${declared} → 500: ${body}`);
    assert(
      result.status >= 400 && result.status < 500,
      `content-length=${declared} → ${result.status}`,
    );
    assertEquals(accessLogs.length, 1);
  }
});

Deno.test("bounded body: invalid UTF-8, non-object JSON and __proto__ keys yield generic 400s", async () => {
  const h = await loadHarness();
  const cases: Array<[string, BodyInit]> = [
    ["invalid utf-8", new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d])],
    ["array body", "[1,2,3]"],
    ["string body", '"just a string"'],
    ["truncated json", '{"handedness":'],
    ["proto pollution", '{"__proto__":{"handedness":"right"},"constructor":{"prototype":{"x":1}}}'],
    ["deeply nested", "[".repeat(20_000) + "]".repeat(20_000)],
  ];
  for (const [label, payload] of cases) {
    h.reset();
    const request = new Request("http://edge.test/functions/v1/api/v1/me/onboarding", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${fakeGoogleIdToken()}`,
        "x-forwarded-for": "203.0.113.20",
        "Content-Type": "application/json",
      },
      body: payload,
    });
    const { result, output } = await captureConsole(() => h.handler(request));
    const body = await result.text();
    assertEquals(result.status, 400, `${label}: ${result.status} ${body}`);
    assert(
      !/SyntaxError|Unexpected token|at position/.test(body),
      `${label}: parser detail in body: ${body}`,
    );
    assert(
      !/Unexpected token|at position/.test(output),
      `${label}: parser detail in logs: ${output}`,
    );
  }
  assertEquals(
    ({} as Record<string, unknown>).handedness,
    undefined,
    "Object.prototype was polluted",
  );
});
