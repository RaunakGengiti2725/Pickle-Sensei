// stress-edge-http / boundary-malformed — shared generator + report plumbing.
//
// Every campaign in stress_http_*.test.ts / stress_edge_http_*.test.ts derives
// one Prng per iteration from (STRESS_SEED, iteration index), so any single
// row of the emitted JSON table replays with
//   STRESS_SEED=<seed> STRESS_ITER=1 STRESS_START=<i> deno test ... --filter "<campaign>"
// or, more directly, from the row's `seed` via `iterationPrng(seed)`.
//
// Knobs (all optional):
//   STRESS_SEED     campaign seed (default 20260905)
//   STRESS_ITER     iterations per campaign (default 200 — fast enough to live
//                   in `deno task test`; the reported runs used ≥ 3000)
//   STRESS_START    first iteration index (default 0) — replay a slice
//   STRESS_OUT_DIR  directory for <campaign>.json seed→outcome tables (default
//                   artifacts/stress-edge-http/latest/, gitignored)

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export const STRESS_SEED = envInt("STRESS_SEED", 20260905);
export const STRESS_ITER = envInt("STRESS_ITER", 200);
export const STRESS_START = envInt("STRESS_START", 0);
export const STRESS_OUT_DIR =
  Deno.env.get("STRESS_OUT_DIR") ??
  new URL("../../../../artifacts/stress-edge-http/latest/", import.meta.url).pathname;

/** mulberry32 — deterministic, tiny, replayable from a 32-bit seed. */
export class Prng {
  private state: number;
  constructor(public readonly seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  /** Weighted pick: [[weight, value], ...]. */
  weighted<T>(items: ReadonlyArray<readonly [number, T]>): T {
    const total = items.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of items) {
      roll -= w;
      if (roll < 0) return value;
    }
    return items[items.length - 1][1];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  ip(): string {
    return `10.${this.int(0, 255)}.${this.int(0, 255)}.${this.int(1, 254)}`;
  }
}

export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The per-iteration seed: stable across campaigns for a given (campaign, i). */
export function iterationSeed(campaign: string, i: number, base = STRESS_SEED): number {
  return fnv1a(`${campaign}:${base}:${i}`);
}

export function iterationPrng(seed: number): Prng {
  return new Prng(seed);
}

// ── String atoms ─────────────────────────────────────────────────────────────

/** What sanitizeUserText documents it strips (http.ts CONTROL_AND_SPOOFING_CHARS;
 * the whitespace controls U+0009–U+000D normalise to a space instead) — plus
 * those whitespace controls, which must never survive either. */
/** Character-class source shared by the oracles below (built with `new RegExp`
 * so the control-character ranges are explicit escapes, not raw bytes). */
export const C0_CLASS = "\\u0000-\\u001f";
/** C0 minus the whitespace controls U+0009–U+000D (which `\s+` folds). */
export const NON_WS_C0_CLASS = "\\u0000-\\u0008\\u000e-\\u001f";
export const C1_CLASS = "\\u007f-\\u009f";
export const SPOOF_CLASS = "\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff";
export const STRIPPED_RE = new RegExp(`[${C0_CLASS}${C1_CLASS}${SPOOF_CLASS}]`, "u");
export const STRIPPED_RE_G = new RegExp(STRIPPED_RE.source, "gu");

/** Invisible / format characters that are NOT in the strip list (observed, not
 * asserted — reported as a metric). */
/** Code-point ranges (inclusive) of the kept invisibles, as data. */
export const INVISIBLE_KEPT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180e],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfff9, 0xfffb],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
  [0x1d173, 0x1d17a],
];
const hex = (cp: number) => `\\u{${cp.toString(16)}}`;
export const INVISIBLE_KEPT_RE = new RegExp(
  `[${INVISIBLE_KEPT_RANGES.map(([lo, hi]) => (lo === hi ? hex(lo) : `${hex(lo)}-${hex(hi)}`)).join("")}]`,
  "u",
);

const JS_WHITESPACE = [
  " ",
  "\t",
  "\n",
  "\v",
  "\f",
  "\r",
  "\u00a0",
  "\u1680",
  "\u2000",
  "\u2001",
  "\u2002",
  "\u2003",
  "\u2004",
  "\u2005",
  "\u2006",
  "\u2007",
  "\u2008",
  "\u2009",
  "\u200a",
  "\u2028",
  "\u2029",
  "\u202f",
  "\u205f",
  "\u3000",
  "\ufeff",
];

const ZERO_WIDTH_BIDI = [
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
];

const INVISIBLE_KEPT = [
  "\u00ad",
  "\u034f",
  "\u061c",
  "\u115f",
  "\u1160",
  "\u180e",
  "\u2060",
  "\u2061",
  "\u2062",
  "\u2063",
  "\u2064",
  "\u206a",
  "\u206f",
  "\u3164",
  "\ufe0f",
  "\ufff9",
  "\ufffa",
  "\ufffb",
  "\uffa0",
  "\u{E0001}",
  "\u{E0020}",
  "\u{E0041}",
  "\u{E007F}",
];

const EMOJI = [
  "😀",
  "🏓",
  "🥒",
  "👨‍👩‍👧‍👦",
  "👍🏽",
  "🇺🇸",
  "🇯🇵",
  "🏳️‍🌈",
  "❤️",
  "✌🏿",
  "🧑🏾‍💻",
  "\u{1F468}\u200d\u{1F4BB}",
];

const COMBINING = ["\u0301", "\u0308", "\u0327", "\u20dd", "\u0338", "\u0e31", "\u094d", "\u0653"];

/** [NFC, NFD] pairs — same grapheme, different code point count. */
export const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"],
  ["\u00f1", "n\u0303"],
  ["\u1e69", "s\u0323\u0307"],
  ["\uac00", "\u1100\u1161"],
  ["\u00c5", "A\u030a"],
  ["\u212b", "A\u030a"],
  ["\ufb01", "fi"],
  ["\u2126", "\u03a9"],
];

const INJECTION_SNIPPETS = [
  "\r\nSet-Cookie: a=b",
  "\r\nX-Injected: 1\r\n\r\n",
  "%0d%0aX-Injected:%201",
  "<script>alert(1)</script>",
  "'; drop table profiles; --",
  "{{7*7}}",
  "${jndi:ldap://x}",
  "../../etc/passwd",
  "..%2f..%2f",
  "%00",
  "\u0000",
  "__proto__",
  "constructor",
  "prototype",
  "\\u0000",
  "\u2028\u2029",
  "1e400",
  "-0",
  "NaN",
  "Infinity",
];

const SCRIPTS = [
  "abcXYZ019",
  "Ünïcödé",
  "日本語テキスト",
  "العربية",
  "עברית",
  "हिन्दी",
  "Ελληνικά",
  "Кириллица",
  "ＦＵＬＬＷＩＤＴＨ",
  "ﬁﬂ",
  "ǅǈ",
  "İı",
  "ß",
  "𝔘𝔫𝔦𝔠𝔬𝔡𝔢",
  "𐍈",
  "\u{10FFFF}",
  "\u{1F600}\u{1F600}",
];

export type AtomKind =
  | "ascii"
  | "c0"
  | "c1"
  | "del"
  | "zwbidi"
  | "invisible_kept"
  | "whitespace"
  | "emoji"
  | "combining"
  | "nfc"
  | "nfd"
  | "lone_high"
  | "lone_low"
  | "nul"
  | "injection"
  | "script"
  | "surrogate_pair_split";

export const ATOM_KINDS: readonly AtomKind[] = [
  "ascii",
  "c0",
  "c1",
  "del",
  "zwbidi",
  "invisible_kept",
  "whitespace",
  "emoji",
  "combining",
  "nfc",
  "nfd",
  "lone_high",
  "lone_low",
  "nul",
  "injection",
  "script",
  "surrogate_pair_split",
];

export function atom(p: Prng, kind: AtomKind): string {
  switch (kind) {
    case "ascii":
      return String.fromCharCode(p.int(0x21, 0x7e));
    case "c0":
      return String.fromCharCode(p.int(0x01, 0x1f));
    case "c1":
      return String.fromCharCode(p.int(0x80, 0x9f));
    case "del":
      return "\u007f";
    case "zwbidi":
      return p.pick(ZERO_WIDTH_BIDI);
    case "invisible_kept":
      return p.pick(INVISIBLE_KEPT);
    case "whitespace":
      return p.pick(JS_WHITESPACE);
    case "emoji":
      return p.pick(EMOJI);
    case "combining":
      return p.pick(COMBINING);
    case "nfc":
      return p.pick(NORMALIZATION_PAIRS)[0];
    case "nfd":
      return p.pick(NORMALIZATION_PAIRS)[1];
    case "lone_high":
      return String.fromCharCode(p.int(0xd800, 0xdbff));
    case "lone_low":
      return String.fromCharCode(p.int(0xdc00, 0xdfff));
    case "nul":
      return "\u0000";
    case "injection":
      return p.pick(INJECTION_SNIPPETS);
    case "script":
      return p.pick(SCRIPTS);
    case "surrogate_pair_split": {
      // a real astral char with a lone surrogate glued to either side
      const astral = String.fromCodePoint(p.int(0x10000, 0x10ffff));
      return p.chance(0.5)
        ? String.fromCharCode(p.int(0xd800, 0xdbff)) + astral
        : astral + String.fromCharCode(p.int(0xdc00, 0xdfff));
    }
  }
}

export type LengthClass = "empty" | "one" | "short" | "medium" | "cap_edge" | "large" | "huge";

export interface StringSpec {
  lengthClass: LengthClass;
  /** atom kinds drawn from (weights) */
  kinds: ReadonlyArray<readonly [number, AtomKind]>;
  /** for cap_edge: the cap (code points) the string is built around */
  cap?: number;
}

const DEFAULT_KINDS: ReadonlyArray<readonly [number, AtomKind]> = [
  [30, "ascii"],
  [4, "c0"],
  [3, "c1"],
  [1, "del"],
  [5, "zwbidi"],
  [3, "invisible_kept"],
  [8, "whitespace"],
  [8, "emoji"],
  [4, "combining"],
  [3, "nfc"],
  [3, "nfd"],
  [2, "lone_high"],
  [2, "lone_low"],
  [2, "nul"],
  [4, "injection"],
  [6, "script"],
  [2, "surrogate_pair_split"],
];

export function pickLengthClass(p: Prng): LengthClass {
  return p.weighted<LengthClass>([
    [3, "empty"],
    [5, "one"],
    [30, "short"],
    [30, "medium"],
    [16, "cap_edge"],
    [12, "large"],
    [2, "huge"],
  ]);
}

/** Build a fuzz string. `large` ≈ 4K–80K code points (crosses 64 KiB when
 * multi-byte), `huge` ≈ 300K–1.2M code points. */
export function genString(p: Prng, spec: Partial<StringSpec> = {}): string {
  const lengthClass = spec.lengthClass ?? pickLengthClass(p);
  const kinds = spec.kinds ?? DEFAULT_KINDS;
  const cap = spec.cap ?? 64;
  let target: number;
  switch (lengthClass) {
    case "empty":
      return "";
    case "one":
      target = 1;
      break;
    case "short":
      target = p.int(2, 16);
      break;
    case "medium":
      target = p.int(17, 300);
      break;
    case "cap_edge":
      target = Math.max(0, cap + p.int(-2, 2));
      break;
    case "large":
      target = p.int(4_000, 80_000);
      break;
    case "huge":
      target = p.int(300_000, 1_200_000);
      break;
  }
  // Atoms are 1..n code points; assemble until the target is reached and
  // then trim to exactly `target` code points so cap_edge is exact.
  const parts: string[] = [];
  let count = 0;
  if (target > 4_000) {
    // bulk fill: repeat a small seeded pattern so huge strings are cheap to build
    const pattern = Array.from({ length: 64 }, () => atom(p, p.weighted(kinds))).join("");
    const patternPoints = Array.from(pattern).length || 1;
    const reps = Math.ceil(target / patternPoints);
    parts.push(pattern.repeat(reps));
    count = patternPoints * reps;
  } else {
    while (count < target) {
      const a = atom(p, p.weighted(kinds));
      parts.push(a);
      count += Array.from(a).length;
    }
  }
  const joined = parts.join("");
  if (lengthClass === "cap_edge") {
    // exact code-point length (Array.from splits well-formed pairs correctly;
    // lone surrogates count as one each, which is what the cap counts too)
    return Array.from(joined).slice(0, target).join("");
  }
  return joined;
}

/** Fuzz value for an HTTP header: Latin-1 only (the Fetch spec's ByteString —
 * a real wire value cannot carry anything else), no NUL/CR/LF (the Headers
 * constructor throws; the network stack rejects them before the handler). */
export function genHeaderValue(p: Prng, maxLen = 300): string {
  const len = p.weighted<number>([
    [5, 0],
    [10, p.int(1, 7)],
    [10, 8],
    [20, p.int(9, 63)],
    [10, 64],
    [10, 65],
    [20, p.int(66, maxLen)],
    [3, p.int(maxLen, 16_000)],
  ]);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += p.weighted<string>([
      [50, String.fromCharCode(p.int(0x21, 0x7e))],
      [10, " "],
      [3, "\t"],
      [3, "\u007f"],
      [8, String.fromCharCode(p.int(0x80, 0xff))],
      [6, p.pick([",", ".", "-", "_", ":", ";", "=", "/", "%", "\\", '"', "'"])],
    ]);
  }
  return out;
}

/** Fuzz raw JSON text (valid or not) built around `payload` (a valid body). */
export type RawBodyKind =
  | "valid"
  | "truncated"
  | "trailing_garbage"
  | "not_json"
  | "bom_prefixed"
  | "top_level_scalar"
  | "top_level_array"
  | "empty"
  | "whitespace_only"
  | "nan_literal"
  | "single_quotes"
  | "trailing_comma"
  | "duplicate_keys"
  | "deep_nesting"
  | "invalid_utf8"
  | "huge_whitespace"
  | "null_bytes"
  | "js_comment";

export const RAW_BODY_KINDS: readonly RawBodyKind[] = [
  "valid",
  "truncated",
  "trailing_garbage",
  "not_json",
  "bom_prefixed",
  "top_level_scalar",
  "top_level_array",
  "empty",
  "whitespace_only",
  "nan_literal",
  "single_quotes",
  "trailing_comma",
  "duplicate_keys",
  "deep_nesting",
  "invalid_utf8",
  "huge_whitespace",
  "null_bytes",
  "js_comment",
];

export function genRawBody(
  p: Prng,
  payload: Record<string, unknown>,
  kind: RawBodyKind,
): { bytes: Uint8Array; parsesToObject: boolean; kind: RawBodyKind } {
  const enc = new TextEncoder();
  const valid = JSON.stringify(payload);
  const bytes = (s: string) => enc.encode(s);
  switch (kind) {
    case "valid":
      return { bytes: bytes(valid), parsesToObject: true, kind };
    case "truncated": {
      const cut = p.int(0, Math.max(0, valid.length - 1));
      const text = valid.slice(0, cut);
      return { bytes: bytes(text), parsesToObject: parsesToRecord(text), kind };
    }
    case "trailing_garbage":
      return {
        bytes: bytes(valid + p.pick(["}", "]", "x", ",", "{}", "\u0000", " null"])),
        parsesToObject: false,
        kind,
      };
    case "not_json":
      return {
        bytes: bytes(
          p.pick([
            "<xml/>",
            "a=1&b=2",
            "--boundary\r\nContent-Disposition: form-data",
            genString(p, { lengthClass: "medium" }),
            "undefined",
            "{",
            "}",
          ]),
        ),
        parsesToObject: false,
        kind,
      };
    case "bom_prefixed":
      return { bytes: bytes("\ufeff" + valid), parsesToObject: false, kind };
    case "top_level_scalar":
      return {
        bytes: bytes(
          p.pick([
            "null",
            "true",
            "false",
            "0",
            "-0",
            "1e308",
            "1e400",
            '"string"',
            "123456789012345678901234567890",
          ]),
        ),
        parsesToObject: false,
        kind,
      };
    case "top_level_array":
      return {
        bytes: bytes(p.pick(["[]", `[${valid}]`, "[1,2,3]", "[[[[]]]]"])),
        parsesToObject: false,
        kind,
      };
    case "empty":
      return { bytes: new Uint8Array(0), parsesToObject: false, kind };
    case "whitespace_only":
      return { bytes: bytes(" \t\r\n".repeat(p.int(1, 64))), parsesToObject: false, kind };
    case "nan_literal": {
      const key = Object.keys(payload)[0] ?? "x";
      return {
        bytes: bytes(
          `{"${key}": ${p.pick(["NaN", "Infinity", "-Infinity", "0x10", ".5", "+1", "01"])}}`,
        ),
        parsesToObject: false,
        kind,
      };
    }
    case "single_quotes":
      return { bytes: bytes(valid.replace(/"/g, "'")), parsesToObject: false, kind };
    case "trailing_comma":
      return { bytes: bytes(valid.replace(/}$/, ",}")), parsesToObject: false, kind };
    case "duplicate_keys": {
      // JSON.parse keeps the LAST duplicate — the body the handler sees is
      // the second value, which is what the oracle must predict on.
      const key = Object.keys(payload)[0];
      if (!key) return { bytes: bytes(valid), parsesToObject: true, kind };
      const text = `{${JSON.stringify(key)}: 1, ${valid.slice(1)}`;
      return { bytes: bytes(text), parsesToObject: true, kind };
    }
    case "deep_nesting": {
      const depth = p.pick([1_000, 10_000, 100_000]);
      const open = p.chance(0.5) ? "[" : '{"a":';
      const close = open === "[" ? "]" : "}";
      return {
        bytes: bytes(open.repeat(depth) + close.repeat(depth)),
        parsesToObject: false,
        kind,
      };
    }
    case "invalid_utf8": {
      const raw = bytes(valid);
      const out = new Uint8Array(raw.length + 3);
      out.set(raw.slice(0, 1), 0);
      out.set([0xff, 0xfe, 0xc0], 1);
      out.set(raw.slice(1), 4);
      // TextDecoder replaces invalid bytes with U+FFFD INSIDE the object → the
      // text is `{\ufffd\ufffd\ufffd"key":...` which is not valid JSON.
      return { bytes: out, parsesToObject: false, kind };
    }
    case "huge_whitespace": {
      const pad = " ".repeat(p.int(70_000, 300_000));
      return { bytes: bytes(pad + valid + pad), parsesToObject: true, kind };
    }
    case "null_bytes": {
      const text = valid.slice(0, -1) + ',"z":"a\u0000b"}';
      // A raw (unescaped) NUL inside a JSON string is invalid JSON.
      return { bytes: bytes(text), parsesToObject: false, kind };
    }
    case "js_comment":
      return { bytes: bytes(`/* c */ ${valid} // c`), parsesToObject: false, kind };
  }
}

export function parsesToRecord(text: string): boolean {
  try {
    const v = JSON.parse(text);
    return Boolean(v) && typeof v === "object" && !Array.isArray(v);
  } catch {
    return false;
  }
}

/** JSON values of the wrong shape for a field expecting a string. */
export function genWrongType(p: Prng): unknown {
  return p.pick<unknown>([
    null,
    true,
    false,
    0,
    -0,
    1,
    -1,
    1e308,
    -1e308,
    5e-324,
    Number.MAX_SAFE_INTEGER + 2,
    [],
    [""],
    ["a"],
    {},
    { a: 1 },
    { __proto__: { polluted: true } },
    { constructor: { prototype: { polluted: true } } },
    { toString: 1 },
    { length: 1e9 },
    { schemaVersion: 99 },
    [[[[[]]]]],
  ]);
}

/** Path segment fuzz: traversal, encodings, NUL, malformed percent, unicode,
 * near-UUID shapes and very long segments. The returned string is inserted
 * RAW into the URL (the URL parser then normalizes it exactly as a client's
 * request line would be). */
export type PathKind =
  | "uuid"
  | "uuid_upper"
  | "uuid_nil"
  | "uuid_wrong_version"
  | "uuid_braced"
  | "uuid_urn"
  | "traversal"
  | "encoded_traversal"
  | "encoded_nul"
  | "malformed_percent"
  | "raw_unicode"
  | "encoded_unicode"
  | "long"
  | "empty"
  | "dot"
  | "slug"
  | "slug_bad"
  | "numeric"
  | "injection"
  | "backslash"
  | "semicolon";

export const PATH_KINDS: readonly PathKind[] = [
  "uuid",
  "uuid_upper",
  "uuid_nil",
  "uuid_wrong_version",
  "uuid_braced",
  "uuid_urn",
  "traversal",
  "encoded_traversal",
  "encoded_nul",
  "malformed_percent",
  "raw_unicode",
  "encoded_unicode",
  "long",
  "empty",
  "dot",
  "slug",
  "slug_bad",
  "numeric",
  "injection",
  "backslash",
  "semicolon",
];

export function genPathSegment(p: Prng, kind: PathKind): string {
  switch (kind) {
    case "uuid":
      return p.uuid();
    case "uuid_upper":
      return p.uuid().toUpperCase();
    case "uuid_nil":
      return "00000000-0000-0000-0000-000000000000";
    case "uuid_wrong_version": {
      const u = p.uuid();
      return u.slice(0, 14) + p.pick(["0", "9", "f", "a"]) + u.slice(15);
    }
    case "uuid_braced":
      return `{${p.uuid()}}`;
    case "uuid_urn":
      return `urn:uuid:${p.uuid()}`;
    case "traversal":
      return p.pick(["..", "...", "../..", "..%2F..", ".%2e", "%2e%2e", "..;", "..\\.."]);
    case "encoded_traversal":
      return p.pick(["%2e%2e%2f%2e%2e", "%252e%252e", "..%c0%af", "%2e%2e%5c", "%c0%ae%c0%ae"]);
    case "encoded_nul":
      return p.pick([`${p.uuid()}%00`, "%00", "a%00b", `%00${p.uuid()}`]);
    case "malformed_percent":
      return p.pick(["%", "%z", "%zz", "%2", "%%", "%G0", `${p.uuid()}%`, "%e0%80", "%ff%fe"]);
    case "raw_unicode":
      return p.pick([
        "日本",
        "😀",
        "\u00e9",
        "e\u0301",
        "\u202e",
        "\ufeff",
        "\u200b",
        "Ω",
        "ＡＢＣ",
      ]);
    case "encoded_unicode":
      return p.pick(["%E2%80%8B", "%EF%BB%BF", "%E2%80%AE", "%F0%9F%98%80", "%C3%A9", "%ED%A0%80"]);
    case "long":
      return "a".repeat(p.pick([121, 256, 1_024, 8_192, 65_536]));
    case "empty":
      return "";
    case "dot":
      return p.pick([".", "..", "...", "./"]);
    case "slug":
      return p.pick(["dink-ladder", "third-shot-drop", "Wall_Rally", "a", "0", "x".repeat(120)]);
    case "slug_bad":
      return p.pick([
        "-lead",
        "_lead",
        "sp ace",
        "slash/slug",
        "x".repeat(121),
        "é",
        "dink!",
        "*",
        "~",
      ]);
    case "numeric":
      return p.pick(["1", "123", "1234", "0000", "1e5", "-1", "9".repeat(40), "1.0"]);
    case "injection":
      return p.pick([
        "<script>",
        "%3Cscript%3E",
        "'or'1'='1",
        "%27or%271%27%3D%271",
        "{{7*7}}",
        "$%7B7*7%7D",
      ]);
    case "backslash":
      return p.pick(["a\\b", "..\\", "%5c..%5c"]);
    case "semicolon":
      return p.pick([`${p.uuid()};x=1`, ";", "a;b", "%3B"]);
  }
}

// ── Reference sanitizer (independent re-implementation of the documented
//    contract, used for differential checks) ─────────────────────────────────

export function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Mirrors the documented pass order (controls/spoofing first, THEN lone
 * surrogates): a high and a low surrogate separated only by stripped
 * characters therefore fuse into one astral code point — see the
 * `surrogateFusion` metric / directed test in stress_http_helpers_boundary. */
export function refSanitize(value: string, maxLength: number): string {
  const kept: string[] = [];
  const controlsStripped = value.replace(
    new RegExp(`[${NON_WS_C0_CLASS}${C1_CLASS}${SPOOF_CLASS}]`, "g"),
    "",
  );
  for (const ch of controlsStripped) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogate (Array.from yields it alone)
    kept.push(ch);
  }
  const joined = kept.join("").replace(/\s+/g, " ").trim();
  return Array.from(joined).slice(0, maxLength).join("").trimEnd();
}

// ── Reporting ────────────────────────────────────────────────────────────────

export interface IterationRow {
  i: number;
  seed: number;
  case: string;
  input: string;
  outcome: "HELD" | "BROKEN";
  detail?: string;
  metrics?: Record<string, unknown>;
}

export interface CampaignReport {
  campaign: string;
  commit: string;
  seedBase: number;
  iterations: number;
  start: number;
  executed: number;
  held: number;
  broken: number;
  brokenSeeds: number[];
  metrics: Record<string, unknown>;
  replay: string;
  durationMs: number;
  rows: IterationRow[];
}

/** Compact, JSON-safe preview of any value for the table (non-printables
 * escaped so the artifact stays greppable; long values are truncated with
 * their code-point length recorded). */
export function preview(value: unknown, max = 160): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const points = Array.from(text);
  const shown = points.slice(0, max).join("");
  const escaped = shown.replace(
    new RegExp(`[${C0_CLASS}${C1_CLASS}${SPOOF_CLASS}\\ud800-\\udfff]`, "g"),
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return points.length > max ? `${escaped}…(+${points.length - max} cp)` : escaped;
}

export function commitSha(): string {
  try {
    const out = new Deno.Command("git", {
      args: ["rev-parse", "HEAD"],
      stdout: "piped",
      stderr: "null",
    }).outputSync();
    return new TextDecoder().decode(out.stdout).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

export async function writeCampaign(report: CampaignReport): Promise<string> {
  await Deno.mkdir(STRESS_OUT_DIR, { recursive: true });
  const path = `${STRESS_OUT_DIR.replace(/\/?$/, "/")}${report.campaign}.json`;
  await Deno.writeTextFile(path, JSON.stringify(report, null, 1));
  return path;
}

export function replayCommand(campaign: string, filter: string, seedBase = STRESS_SEED): string {
  return `STRESS_SEED=${seedBase} STRESS_ITER=${STRESS_ITER} STRESS_START=${STRESS_START} deno test -A --no-check --config deno.json ${campaign} --filter "${filter}"`;
}

/** Runs `iterations` seeded iterations, collecting rows; never lets one
 * iteration's exception hide the rest (an exception IS a BROKEN row). */
export async function runCampaign(
  campaign: string,
  file: string,
  body: (
    p: Prng,
    i: number,
    seed: number,
  ) => Promise<Omit<IterationRow, "i" | "seed">> | Omit<IterationRow, "i" | "seed">,
  options: { iterations?: number; start?: number; metrics?: () => Record<string, unknown> } = {},
): Promise<CampaignReport> {
  const iterations = options.iterations ?? STRESS_ITER;
  const start = options.start ?? STRESS_START;
  const rows: IterationRow[] = [];
  const t0 = performance.now();
  for (let i = start; i < start + iterations; i++) {
    const seed = iterationSeed(campaign, i);
    const p = new Prng(seed);
    try {
      const row = await body(p, i, seed);
      rows.push({ i, seed, ...row });
    } catch (error) {
      rows.push({
        i,
        seed,
        case: "exception",
        input: "",
        outcome: "BROKEN",
        detail: `iteration threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
      });
    }
  }
  const broken = rows.filter((r) => r.outcome === "BROKEN");
  const report: CampaignReport = {
    campaign,
    commit: commitSha(),
    seedBase: STRESS_SEED,
    iterations,
    start,
    executed: rows.length,
    held: rows.length - broken.length,
    broken: broken.length,
    brokenSeeds: broken.map((r) => r.seed),
    metrics: options.metrics?.() ?? {},
    replay: replayCommand(file, campaign),
    durationMs: Math.round(performance.now() - t0),
    rows,
  };
  return report;
}

export function brokenSummary(report: CampaignReport, max = 10): string {
  return report.rows
    .filter((r) => r.outcome === "BROKEN")
    .slice(0, max)
    .map((r) => `#${r.i} seed=${r.seed} case=${r.case} ${r.detail ?? ""} input=${r.input}`)
    .join("\n");
}
