// stress-edge-http — seeded fuzz of the http.ts helpers (unit `edge-http`).
//
//   sanitizeUserText   unicode / control / bidi / zero-width / lone surrogate /
//                      whitespace / header-injection payloads, size caps
//   clientIp           x-forwarded-for / cf-connecting-ip shapes
//   resolveRequestId   never echoes a non-conforming client value
//   routeTemplate      ids collapse, segment count preserved
//   constantTimeEqual  equality ⇔ string identity across unicode
//   errorCodeOf        never throws on malformed bodies
//
// Every iteration is replayable: STRESS_SEED (default 20260905) seeds the
// generator, STRESS_ITER scales the campaign (default 1 → ≈2k payloads,
// STRESS_ITER=10 → ≈20k). Each campaign writes a JSON table
// (seed → outcome) to STRESS_OUT_DIR (default artifacts/stress-edge-http/latest/).
//
// Tests titled `REPRO:` pin behaviour that is OBSERVED today and reported as a
// finding in the stress report; they are not endorsements of that behaviour.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  clientIp,
  constantTimeEqual,
  errorCodeOf,
  resolveRequestId,
  routeTemplate,
  sanitizeUserText,
} from "../http.ts";
import {
  envInt,
  histogram,
  Rng,
  STRESS_ITER,
  STRESS_SEED,
  writeArtifact,
} from "./stress_harness.ts";

// ── Seeded payload generator ─────────────────────────────────────────────────

/** Code-point palettes, each a distinct failure hypothesis. */
const PALETTE: Record<string, string[]> = {
  ascii: Array.from({ length: 95 }, (_, i) => String.fromCodePoint(0x20 + i)),
  c0_controls: [
    ...Array.from({ length: 32 }, (_, i) => String.fromCodePoint(i)),
    "\u007f",
  ],
  c1_controls: Array.from(
    { length: 32 },
    (_, i) => String.fromCodePoint(0x80 + i),
  ),
  crlf_injection: [
    "\r\n",
    "\r",
    "\n",
    "\r\nX-Injected: 1",
    "\nSet-Cookie: a=b",
    "\r\n\r\n<html>",
    "%0d%0a",
    "\u000d\u000a",
    "\u2028",
    "\u2029",
    "\u0085",
  ],
  zero_width_bidi: [
    "\u200b",
    "\u200c",
    "\u200d",
    "\u200e",
    "\u200f",
    "\u202a",
    "\u202b",
    "\u202c",
    "\u202d",
    "\u202e",
    "\u2066",
    "\u2067",
    "\u2068",
    "\u2069",
    "\ufeff",
  ],
  // Default-ignorable / invisible code points the sanitizer does NOT list.
  invisible_unlisted: [
    "\u00ad", // soft hyphen
    "\u034f", // combining grapheme joiner
    "\u061c", // arabic letter mark
    "\u115f", // hangul choseong filler
    "\u1160", // hangul jungseong filler
    "\u180e", // mongolian vowel separator
    "\u2060", // word joiner
    "\u2061",
    "\u2062",
    "\u2063",
    "\u2064",
    "\u206a",
    "\u206f",
    "\u3164", // hangul filler
    "\ufe0f", // VS16
    "\uffa0", // halfwidth hangul filler
    "\ufff9",
    "\ufffa",
    "\ufffb",
    "\u{e0001}", // language tag
    "\u{e0041}", // tag latin A
    "\u{e007f}", // cancel tag
    "\u{e0100}", // variation selector supplement
  ],
  whitespace: [
    "\t",
    "\v",
    "\f",
    " ",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2007",
    "\u200a",
    "\u3000",
  ],
  surrogate_pairs: [
    "😀",
    "🏓",
    "👨‍👩‍👧‍👦",
    "🇺🇸",
    "𝔘𝔫𝔦",
    "\u{1f3f3}\ufe0f\u200d\u{1f308}",
    "\u{10ffff}",
  ],
  lone_surrogates: ["\ud800", "\udbff", "\udc00", "\udfff", "\ud83d", "\ude00"],
  combining: [
    "e\u0301",
    "a\u0300\u0301\u0302\u0303\u0304\u0305",
    "\u0301",
    "Z\u0335\u0336\u0337",
  ],
  scripts: [
    "日本語",
    "한국어",
    "العربية",
    "עברית",
    "हिन्दी",
    "Ελληνικά",
    "Кириллица",
    "ไทย",
  ],
  homoglyphs: ["Α", "а", "ο", "ѕ", "ⅼ", "ǀ", "𝐀", "ﬁ"],
  json_meta: [
    '"',
    "\\",
    "{",
    "}",
    "[",
    "]",
    "\u0000",
    "</script>",
    "${x}",
    "{{x}}",
  ],
  sql_meta: ["'", "--", ";", "/*", "*/", "\\x00"],
};
const PALETTE_KEYS = Object.keys(PALETTE);

interface Payload {
  seed: number;
  text: string;
  maxLength: number;
  palettes: string[];
}

function genPayload(seed: number): Payload {
  const rng = new Rng(seed);
  const paletteCount = rng.int(1, 4);
  const palettes: string[] = [];
  for (let i = 0; i < paletteCount; i += 1) {
    palettes.push(rng.pick(PALETTE_KEYS));
  }
  const pieces = rng.int(0, 64);
  let text = "";
  for (let i = 0; i < pieces; i += 1) {
    const palette = PALETTE[rng.pick(palettes)];
    text += rng.pick(palette);
    if (rng.chance(0.15)) text += rng.pick(PALETTE.ascii);
  }
  if (rng.chance(0.05)) text = text.repeat(rng.int(2, 40));
  const maxLength = rng.pick([1, 2, 3, 8, 24, 60, 120, 200, 500, 2000]);
  return { seed, text, maxLength, palettes };
}

// ── Invariant checks ─────────────────────────────────────────────────────────

const CONTROL_AND_SPOOFING_CHARS =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
const HEADER_DELIMS = /[\r\n\u0000]/;
const INVISIBLE_UNLISTED = new Set(
  PALETTE.invisible_unlisted.map((s) => s.codePointAt(0)),
);

function codePointMultiset(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    out.set(cp, (out.get(cp) ?? 0) + 1);
  }
  return out;
}

interface SanitizeOutcome {
  seed: number;
  palettes: string[];
  inLen: number;
  maxLength: number;
  outLen: number;
  violations: string[];
  invisibleResidue: number;
  /** Code points in the output that were not in the input: two lone
   * surrogate halves re-paired once the control char between them went. */
  synthesized: string[];
}

function checkSanitize(payload: Payload): SanitizeOutcome {
  const out = sanitizeUserText(payload.text, payload.maxLength);
  const violations: string[] = [];
  if (CONTROL_AND_SPOOFING_CHARS.test(out)) {
    violations.push("listed control/spoofing char survived");
  }
  if (HEADER_DELIMS.test(out)) {
    violations.push("CR/LF/NUL survived (header injection)");
  }
  if (/[\t\v\f\u0085\u2028\u2029\u00a0\u1680\u2000-\u200a\u3000]/.test(out)) {
    violations.push("non-space whitespace survived");
  }
  if (!out.isWellFormed()) {
    violations.push("lone surrogate survived (not JSON/UTF-8 safe)");
  }
  if (Array.from(out).length > payload.maxLength) {
    violations.push("code-point cap exceeded");
  }
  if (out !== out.trim()) violations.push("not trimmed");
  if (/ {2}/.test(out)) violations.push("double space survived");
  if (sanitizeUserText(out, payload.maxLength) !== out) {
    violations.push("not idempotent");
  }
  if (JSON.parse(JSON.stringify({ v: out })).v !== out) {
    violations.push("JSON round-trip changed");
  }
  try {
    new TextEncoder().encode(out);
  } catch {
    violations.push("TextEncoder threw");
  }
  if (new TextEncoder().encode(out).byteLength > 4 * payload.maxLength) {
    violations.push("UTF-8 byte length > 4×cap");
  }
  // No invented characters: every non-space code point in the output came
  // from the input, with multiplicity.
  const inSet = codePointMultiset(payload.text);
  const synthesized: string[] = [];
  for (const [cp, n] of codePointMultiset(out)) {
    if (cp === 0x20) continue;
    if ((inSet.get(cp) ?? 0) < n) {
      const label = `U+${cp.toString(16)}`;
      // A supplementary code point that was two lone halves in the input is
      // the known re-pairing behaviour (REPRO test below); anything else is
      // a genuine violation.
      const hi = 0xd800 + ((cp - 0x10000) >> 10);
      const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
      if (cp >= 0x10000 && inSet.has(hi) && inSet.has(lo)) {
        synthesized.push(label);
      } else violations.push(`invented code point ${label}`);
    }
  }
  let invisibleResidue = 0;
  for (const ch of out) {
    if (INVISIBLE_UNLISTED.has(ch.codePointAt(0)!)) invisibleResidue += 1;
  }
  return {
    seed: payload.seed,
    palettes: payload.palettes,
    inLen: payload.text.length,
    maxLength: payload.maxLength,
    outLen: out.length,
    violations,
    invisibleResidue,
    synthesized,
  };
}

// ── Campaign: sanitizeUserText ───────────────────────────────────────────────

Deno.test("stress/http: sanitizeUserText seeded fuzz — well-formed, capped, delimiter-free", async () => {
  const iterations = 2_000 * STRESS_ITER;
  const outcomes: SanitizeOutcome[] = [];
  const failed: SanitizeOutcome[] = [];
  const started = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + i * 7919) >>> 0;
    const outcome = checkSanitize(genPayload(seed));
    outcomes.push(outcome);
    if (outcome.violations.length) failed.push(outcome);
  }
  const elapsedMs = Math.round(performance.now() - started);
  const residueSeeds = outcomes.filter((o) => o.invisibleResidue > 0);
  const synthesizedSeeds = outcomes.filter((o) => o.synthesized.length > 0);
  const table = {
    campaign: "sanitizeUserText",
    seedBase: STRESS_SEED,
    seedFormula: "seed_i = (STRESS_SEED + i*7919) >>> 0",
    iterations,
    elapsedMs,
    failed: failed.length,
    failedSeeds: failed.map((o) => ({
      seed: o.seed,
      violations: o.violations,
    })),
    paletteMix: histogram(outcomes.flatMap((o) => o.palettes)),
    invisibleResidue: {
      note:
        "payloads whose sanitized output still carries default-ignorable code points the sanitizer does not list (U+00AD, U+2060-2064, U+E0000-E007F tags, …); tracked as a finding, not a violation of the documented contract",
      count: residueSeeds.length,
      sampleSeeds: residueSeeds.slice(0, 10).map((o) => o.seed),
    },
    surrogateRepairing: {
      note:
        "payloads where two lone surrogate halves, separated only by stripped control/format chars, re-paired into a supplementary code point absent from the input (REPRO test below)",
      count: synthesizedSeeds.length,
      sample: synthesizedSeeds.slice(0, 10).map((o) => ({
        seed: o.seed,
        synthesized: o.synthesized,
      })),
    },
    outcomes: outcomes.slice(0, 200),
  };
  const path = await writeArtifact("http_sanitize_fuzz.json", table);
  console.log(
    `[stress/http] sanitizeUserText ${iterations} payloads, ${failed.length} violations → ${path}`,
  );
  assertEquals(
    failed,
    [],
    `violations (seeds): ${JSON.stringify(failed.slice(0, 5))}`,
  );
});

Deno.test("stress/http: sanitizeUserText targeted header-injection & mixed payloads", () => {
  const cases: Array<[string, number]> = [
    ["Pat\r\nX-Injected: yes", 60],
    ["Pat\nSet-Cookie: a=b; Path=/", 60],
    ["\r\n\r\n<html>", 60],
    ["\u000d\u000aLocation: https://evil.example", 60],
    ["Pat\u2028Two\u2029Lines\u0085", 60],
    ["\u202eevil\u202c", 60],
    ["\ufeff\u200b\u200c\u200d\u200e\u200fX", 60],
    ["\ud800\ud800\udc00\udc00", 60],
    ["😀\ud83d", 1],
    ["\ud83d😀", 1],
    ["a\u0000b\u0001c\u001fd\u007fe\u009ff", 60],
    ["   many\t\t\tspaces \u00a0 here   ", 60],
    ["👨‍👩‍👧‍👦👨‍👩‍👧‍👦", 3],
  ];
  for (const [text, max] of cases) {
    const out = sanitizeUserText(text, max);
    assert(!HEADER_DELIMS.test(out), `CR/LF/NUL in ${JSON.stringify(out)}`);
    assert(out.isWellFormed(), `lone surrogate in ${JSON.stringify(out)}`);
    assert(
      Array.from(out).length <= max,
      `cap exceeded for ${JSON.stringify(text)}`,
    );
    assert(!CONTROL_AND_SPOOFING_CHARS.test(out));
    assertEquals(sanitizeUserText(out, max), out);
  }
  assertEquals(
    sanitizeUserText("Pat\r\nX-Injected: yes", 60),
    "Pat X-Injected: yes",
  );
  assertEquals(sanitizeUserText("\u202eevil\u202c", 60), "evil");
  assertEquals(sanitizeUserText("😀\ud83d", 1), "😀");
  assertEquals(sanitizeUserText("\ud83d😀", 1), "😀");
});

Deno.test("stress/http: sanitizeUserText size caps — 1 MiB and 5 MB inputs are linear-time", () => {
  const rng = new Rng(STRESS_SEED ^ 0x5a5a);
  const chunk = Array.from(
    { length: 1024 },
    () =>
      rng.pick([
        ...PALETTE.ascii,
        ...PALETTE.scripts,
        ...PALETTE.surrogate_pairs,
        ...PALETTE.zero_width_bidi,
        "\r\n",
      ]),
  ).join("");
  const timings: Array<
    { inputChars: number; maxLength: number; ms: number; outChars: number }
  > = [];
  for (
    const [repeat, max] of [[64, 200], [1024, 200], [1024, 2_000_000], [
      4096,
      200,
    ]] as const
  ) {
    const input = chunk.repeat(repeat);
    const started = performance.now();
    const out = sanitizeUserText(input, max);
    const ms = Math.round((performance.now() - started) * 100) / 100;
    timings.push({
      inputChars: input.length,
      maxLength: max,
      ms,
      outChars: out.length,
    });
    assert(Array.from(out).length <= max);
    assert(out.isWellFormed());
    assert(!HEADER_DELIMS.test(out));
  }
  console.log(`[stress/http] size caps: ${JSON.stringify(timings)}`);
  // ≈4.6M chars must sanitize well inside one request budget.
  const worst = timings[timings.length - 1];
  assert(worst.ms < 2_000, `4 MiB sanitize took ${worst.ms} ms`);
});

Deno.test(
  "REPRO: sanitizeUserText keeps default-ignorable invisibles it does not list (soft hyphen, word joiner, TAG chars)",
  () => {
    // Observed today: only the listed ranges (C0/C1, U+200B-200F, U+202A-202E,
    // U+2066-2069, U+FEFF) are stripped. Other invisible code points pass
    // through and count against the cap. Reported as P3 in the stress report.
    assertEquals(sanitizeUserText("P\u00adat", 60), "P\u00adat");
    assertEquals(sanitizeUserText("P\u2060at", 60), "P\u2060at");
    assertEquals(
      sanitizeUserText("Pat\u{e0041}\u{e0042}\u{e007f}", 60),
      "Pat\u{e0041}\u{e0042}\u{e007f}",
    );
    assertEquals(
      sanitizeUserText("\u2060".repeat(60) + "Pat", 60),
      "\u2060".repeat(60),
    );
  },
);

Deno.test(
  "REPRO: sanitizeUserText re-pairs lone surrogate halves across a stripped control char into a new code point",
  () => {
    // Observed today: CONTROL_AND_SPOOFING_CHARS is applied BEFORE
    // LONE_SURROGATES, so "\ud83d" + NUL + "\ude00" becomes "😀" — a code
    // point the input never contained — instead of "". Well-formed output
    // either way; reported as P3 in the stress report.
    assertEquals(sanitizeUserText("\ud83d\u0000\ude00", 10), "😀");
    assertEquals(sanitizeUserText("\udb40\u200b\udc41", 10), "\u{e0041}"); // TAG LATIN CAPITAL A
    assertEquals(sanitizeUserText("\ud83d\ude00", 10), "😀");
    assertEquals(sanitizeUserText("\ud83d", 10), "");
  },
);

// ── clientIp ─────────────────────────────────────────────────────────────────

Deno.test("stress/http: clientIp seeded fuzz — cf-connecting-ip wins, else last non-empty XFF hop, else unknown", async () => {
  const iterations = 1_000 * STRESS_ITER;
  const hops = [
    "203.0.113.9",
    "10.0.0.1",
    "2001:db8::1",
    "unknown",
    "",
    " ",
    "  198.51.100.4  ",
    "1.2.3.4:5678",
    "not an ip",
    "\u200b",
    "日本",
    "a".repeat(300),
  ];
  const failures: Array<
    { seed: number; xff: string; cf: string | null; got: string }
  > = [];
  let unvalidated = 0;
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + 31 * i) >>> 0;
    const rng = new Rng(seed);
    const n = rng.int(0, 5);
    const parts: string[] = [];
    for (let k = 0; k < n; k += 1) parts.push(rng.pick(hops));
    const xff = parts.join(rng.pick([",", ", ", " ,", ",,"]));
    const cf = rng.chance(0.3) ? rng.pick(hops) : null;
    const headers = new Headers();
    // Header values are ByteStrings: Latin-1 only, so non-Latin-1 hops are
    // dropped here — the fuzz exercises what a gateway CAN put on the wire.
    const latin1 = (s: string) =>
      /^[\x00-\xff]*$/.test(s) && !/[\r\n\0]/.test(s);
    const xffWire = latin1(xff) ? xff : "";
    if (xffWire) headers.set("x-forwarded-for", xffWire);
    if (cf !== null && latin1(cf)) headers.set("cf-connecting-ip", cf);
    const request = new Request(
      "http://edge.stress.test/functions/v1/api/v1/me",
      { headers },
    );
    const got = clientIp(request);
    const cfTrim = (cf !== null && latin1(cf) ? cf : "").trim();
    let expected: string;
    if (cfTrim) expected = cfTrim;
    else {
      const nonEmpty = xffWire.split(",").map((s) => s.trim()).filter(Boolean);
      expected = nonEmpty.length ? nonEmpty[nonEmpty.length - 1] : "unknown";
    }
    if (got !== expected || !got || /,/.test(got)) {
      failures.push({ seed, xff: xffWire, cf, got });
    }
    // The helper trims but does not validate: whatever the gateway put in
    // the last hop becomes the rate-limit key verbatim (spaces included).
    if (/\s/.test(got) || got.length > 45) unvalidated += 1;
  }
  await writeArtifact("http_clientip_fuzz.json", {
    iterations,
    unvalidated,
    failures,
  });
  assertEquals(failures, []);
});

// ── resolveRequestId / withRequestId ─────────────────────────────────────────

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;
const SAFE_ID_CHARS = [..."abcXYZ0189._-"];
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

Deno.test("stress/http: resolveRequestId seeded fuzz — never echoes a non-conforming client value", async () => {
  const iterations = 2_000 * STRESS_ITER;
  const alphabet = [
    ..."abcXYZ0189._-",
    " ",
    "\t",
    "/",
    ":",
    "\u00e9",
    "\u00ff",
    "\x7f",
    "\x01",
    "%0d",
    "<",
    ">",
    '"',
  ];
  const failures: Array<{ seed: number; header: string; got: string }> = [];
  let honoured = 0;
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + 101 * i) >>> 0;
    const rng = new Rng(seed);
    const len = rng.pick([0, 1, 7, 8, 9, 32, 63, 64, 65, 200, 4000]);
    const safeOnly = rng.chance(0.3);
    let header = "";
    for (let k = 0; k < len; k += 1) {
      header += rng.pick(safeOnly ? SAFE_ID_CHARS : alphabet);
    }
    const request = new Request(
      "http://edge.stress.test/functions/v1/api/v1/me",
      {
        headers: { "x-request-id": header },
      },
    );
    const got = resolveRequestId(request);
    const conforming = REQUEST_ID_RE.test(header.trim());
    if (conforming) honoured += 1;
    const ok = conforming ? got === header.trim() : UUID_RE.test(got);
    if (!ok || !REQUEST_ID_RE.test(got)) failures.push({ seed, header, got });
    // withRequestId must be able to carry it on any response.
    const out = new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const carried = new Response(out.body, out);
    carried.headers.set("x-request-id", got);
    assertEquals(carried.headers.get("x-request-id"), got);
  }
  await writeArtifact("http_requestid_fuzz.json", {
    iterations,
    honoured,
    failures,
  });
  assertEquals(failures, []);
  assert(
    honoured > 0,
    "fuzz never produced a conforming id — generator broken",
  );
});

// ── routeTemplate / accessLogEntry ───────────────────────────────────────────

Deno.test("stress/http: routeTemplate seeded fuzz — ids collapse, segments preserved, log line stays single-line", async () => {
  const iterations = 2_000 * STRESS_ITER;
  const failures: Array<{ seed: number; path: string; got: string }> = [];
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + 13 * i) >>> 0;
    const rng = new Rng(seed);
    const segments: string[] = [];
    const n = rng.int(1, 7);
    for (let k = 0; k < n; k += 1) {
      segments.push(
        rng.pick([
          "v1",
          "me",
          "shots",
          crypto.randomUUID(),
          crypto.randomUUID().toUpperCase(),
          String(rng.int(0, 999)),
          String(rng.int(1000, 99_999_999)),
          "abc123",
          "%2F%0D%0A",
          "..",
          "",
          "日本",
          "a".repeat(200),
        ]),
      );
    }
    const path = "/" + segments.join("/");
    const url = new URL(`http://edge.stress.test${path}`);
    const got = routeTemplate(url.pathname);
    const gotSegments = got.split("/");
    const inSegments = url.pathname.split("/");
    let ok = gotSegments.length === inSegments.length;
    for (let k = 0; ok && k < inSegments.length; k += 1) {
      const seg = inSegments[k];
      const isId =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          seg,
        ) || /^\d{4,}$/.test(seg);
      ok = isId ? gotSegments[k] === ":id" : gotSegments[k] === seg;
    }
    const line = JSON.stringify({ evt: "api_request", route: got });
    if (!ok || /[\r\n]/.test(line)) {
      failures.push({ seed, path: url.pathname, got });
    }
  }
  await writeArtifact("http_routetemplate_fuzz.json", { iterations, failures });
  assertEquals(failures, []);
});

// ── constantTimeEqual ────────────────────────────────────────────────────────

Deno.test("stress/http: constantTimeEqual seeded fuzz — equality ⇔ identity, unicode-safe", () => {
  const iterations = 3_000 * STRESS_ITER;
  const pool = [
    ...PALETTE.ascii,
    ...PALETTE.scripts,
    ...PALETTE.surrogate_pairs,
    ...PALETTE.combining,
    ...PALETTE.homoglyphs,
    ...PALETTE.lone_surrogates,
  ];
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + 17 * i) >>> 0;
    const rng = new Rng(seed);
    const len = rng.int(0, 40);
    let a = "";
    for (let k = 0; k < len; k += 1) a += rng.pick(pool);
    let b = a;
    const mode = rng.int(0, 3);
    if (mode === 1 && a.length) {
      const at = rng.int(0, a.length - 1);
      b = a.slice(0, at) + rng.pick(pool) + a.slice(at + 1);
    } else if (mode === 2) b = a + rng.pick(pool);
    else if (mode === 3) b = a.normalize("NFD");
    assertEquals(constantTimeEqual(a, b), a === b, `seed ${seed}`);
    assertEquals(constantTimeEqual(b, a), a === b, `seed ${seed}`);
  }
  assertEquals(constantTimeEqual("", ""), true);
  assertEquals(constantTimeEqual("e\u0301", "\u00e9"), false);
});

// ── errorCodeOf ──────────────────────────────────────────────────────────────

Deno.test("stress/http: errorCodeOf seeded fuzz — never throws, code only when a string", async () => {
  const iterations = 1_000 * STRESS_ITER;
  const bodies = [
    "",
    "null",
    "[]",
    "{}",
    '{"error":null}',
    '{"error":"x"}',
    '{"error":{"code":1}}',
    '{"error":{"code":"a.b"}}',
    '{"error":{"code":"' + "x".repeat(10_000) + '"}}',
    "{not json",
    "\ufeff{}",
    "<html>",
    '{"error":{"code":"\ud800"}}',
  ];
  for (let i = 0; i < iterations; i += 1) {
    const seed = (STRESS_SEED + 23 * i) >>> 0;
    const rng = new Rng(seed);
    const status = rng.pick([200, 204, 400, 401, 403, 404, 413, 429, 500, 503]);
    const contentType = rng.pick([
      "application/json",
      "application/json; charset=utf-8",
      "text/plain",
      "",
      "text/html",
    ]);
    const body = rng.pick(bodies);
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    const response = new Response(status === 204 ? null : body, {
      status,
      headers,
    });
    const code = await errorCodeOf(response);
    let expected: string | undefined;
    if (
      status >= 400 && contentType.includes("application/json") &&
      status !== 204
    ) {
      try {
        const parsed = JSON.parse(body);
        const c = parsed?.error?.code;
        expected = typeof c === "string" ? c : undefined;
      } catch {
        expected = undefined;
      }
    }
    assertEquals(code, expected, `seed ${seed}`);
    // The client body is still readable after the peek.
    if (status !== 204) assertEquals(await response.text(), body);
  }
});

Deno.test("stress/http: campaign sizes recorded", () => {
  assertStringIncludes(String(envInt("STRESS_ITER", 1)), String(STRESS_ITER));
});
