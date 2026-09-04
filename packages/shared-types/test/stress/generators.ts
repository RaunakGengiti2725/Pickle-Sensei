/**
 * Hostile-input generators for the `boundary-malformed` lens. Every generator
 * is a pure function of the Rng so a generated input is replayable from its
 * seed. Each value is tagged with the lens category it exercises so the
 * results table can prove coverage per category.
 */
import type { Rng } from "./prng.js";

export const HOSTILE_CATEGORIES = [
  "malformed_json",
  "truncated_json",
  "wrong_type",
  "proto_pollution",
  "numeric_overflow",
  "nan",
  "infinity",
  "negative_zero",
  "null_byte",
  "huge_string",
  "cap_boundary",
  "path_traversal",
  "future_schema",
  "empty_array",
  "empty_object",
  "unicode_normalization",
] as const;
export type HostileCategory = (typeof HOSTILE_CATEGORIES)[number];

export interface Hostile<T = unknown> {
  category: HostileCategory;
  value: T;
}

/** 64 KiB of UTF-16 code units — the "64KB+" cap probe. */
export const HUGE_LENGTH = 64 * 1024;

const POLLUTION_KEYS = ["__proto__", "constructor", "prototype", "hasOwnProperty", "toString"];

const PATH_TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "/../../../",
  "..%252f..%252f",
  "shots/../../admin",
  "\u2025/\u2025/",
  "....//....//",
  "file:///etc/hosts",
  "C:\\..\\..\\",
];

/** (NFC, NFD) pairs that are canonically equivalent but different strings. */
const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"], // é
  ["\u00c5", "A\u030a"], // Å
  ["\u1e69", "s\u0323\u0307"], // ṩ
  ["\ufb01", "fi"], // ligature vs compatibility decomposition (NFKC only)
  ["\u212b", "\u00c5"], // ANGSTROM SIGN vs Å (singleton)
  ["\u2126", "\u03a9"], // OHM SIGN vs Ω
  ["\u1e9b\u0323", "\u1e9b\u0323"], // already-NFC ṩ variant with long s
  ["dink\u00e9", "dinke\u0301"],
  ["serv\u00e9", "serve\u0301"],
];

/** Grapheme clusters that are many code units/bytes but ONE user-perceived character. */
const MULTI_UNIT_GRAPHEMES = [
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", // family ZWJ sequence, 11 code units
  "\u{1F3F3}\uFE0F\u200D\u{1F308}", // rainbow flag, 6 code units
  "\u{1F1FA}\u{1F1F8}", // regional indicator pair, 4 code units
  "e\u0301\u0302\u0303\u0304", // e + 4 combining marks
  "\u0E01\u0E49\u0E33", // Thai cluster
  "\u{1F44D}\u{1F3FD}", // thumbs up + skin tone
];

function repeatTo(unit: string, codeUnits: number): string {
  const times = Math.ceil(codeUnits / unit.length);
  return unit.repeat(times).slice(0, codeUnits);
}

export function hugeString(rng: Rng): Hostile<string> {
  const flavor = rng.int(0, 5);
  const length = rng.pick([HUGE_LENGTH, HUGE_LENGTH + 1, HUGE_LENGTH * 2, 100_000, 1_000_000]);
  switch (flavor) {
    case 0:
      return { category: "huge_string", value: "a".repeat(length) };
    case 1:
      // 2 bytes per code unit in UTF-8 → byte length is 2× code-unit length.
      return { category: "huge_string", value: "\u00e9".repeat(length) };
    case 2:
      // 3-byte CJK → byte length is 3× code-unit length.
      return { category: "huge_string", value: "\u4e2d".repeat(length) };
    case 3:
      // Surrogate pairs: code units = 2 × code points.
      return { category: "huge_string", value: repeatTo("\u{1F600}", length) };
    case 4:
      return { category: "huge_string", value: repeatTo(rng.pick(MULTI_UNIT_GRAPHEMES), length) };
    default:
      return { category: "huge_string", value: repeatTo("dink ", length) };
  }
}

/**
 * Strings sitting exactly at / just over a cap measured in UTF-16 code units,
 * code points, UTF-8 bytes or grapheme clusters — the four ways a "max 160"
 * can be counted disagree for non-ASCII input.
 */
export function capBoundaryString(rng: Rng, cap: number): Hostile<string> {
  const flavor = rng.int(0, 6);
  switch (flavor) {
    case 0:
      return { category: "cap_boundary", value: "x".repeat(cap) };
    case 1:
      return { category: "cap_boundary", value: "x".repeat(cap + 1) };
    case 2:
      // cap code points, 2×cap bytes.
      return { category: "cap_boundary", value: "\u00e9".repeat(cap) };
    case 3:
      // cap code points, 3×cap bytes.
      return { category: "cap_boundary", value: "\u4e2d".repeat(cap) };
    case 4:
      // cap/2 code points but cap code units.
      return { category: "cap_boundary", value: repeatTo("\u{1F600}", cap) };
    case 5: {
      // cap graphemes, far more code units.
      const g = rng.pick(MULTI_UNIT_GRAPHEMES);
      return { category: "cap_boundary", value: g.repeat(cap) };
    }
    default:
      // one past the cap by a single combining mark.
      return { category: "cap_boundary", value: "x".repeat(cap) + "\u0301" };
  }
}

export function nullByteString(rng: Rng): Hostile<string> {
  const variants = [
    "\u0000",
    "a\u0000b",
    "\u0000".repeat(rng.int(1, 64)),
    "dink\u0000; drop table shots",
    "model-training-v1\u0000",
    "%00",
    "\\u0000",
    "\u0000" + "x".repeat(rng.int(0, 200)),
  ];
  return { category: "null_byte", value: rng.pick(variants) };
}

export function pathTraversalString(rng: Rng): Hostile<string> {
  const base = rng.pick(PATH_TRAVERSAL);
  const decorated = rng.int(0, 3);
  const value =
    decorated === 0
      ? base
      : decorated === 1
        ? `${base}${rng.int(0, 999)}`
        : decorated === 2
          ? base.repeat(rng.int(2, 20))
          : `11111111-1111-4111-8111-111111111111/${base}`;
  return { category: "path_traversal", value };
}

export function unicodeNormalizationString(rng: Rng): Hostile<string> {
  const pair = rng.pick(NORMALIZATION_PAIRS);
  const value = rng.bool() ? pair[0] : pair[1];
  const wrapped = rng.int(0, 3);
  return {
    category: "unicode_normalization",
    value:
      wrapped === 0
        ? value
        : wrapped === 1
          ? `${value} forehand dink`
          : wrapped === 2
            ? `\u202e${value}` // RTL override prefix
            : `\ufeff${value}`, // BOM prefix
  };
}

export function normalizationPair(rng: Rng): readonly [string, string] {
  return rng.pick(NORMALIZATION_PAIRS);
}

/** Numbers at the edges: overflow, NaN, ±Infinity, -0, subnormals, unsafe ints. */
export function hostileNumber(rng: Rng): Hostile<number> {
  const choice = rng.int(0, 13);
  switch (choice) {
    case 0:
      return { category: "nan", value: Number.NaN };
    case 1:
      return { category: "infinity", value: Number.POSITIVE_INFINITY };
    case 2:
      return { category: "infinity", value: Number.NEGATIVE_INFINITY };
    case 3:
      return { category: "negative_zero", value: -0 };
    case 4:
      return { category: "numeric_overflow", value: Number.MAX_VALUE };
    case 5:
      return { category: "numeric_overflow", value: Number.MAX_SAFE_INTEGER + 1 };
    case 6:
      return { category: "numeric_overflow", value: 2 ** 53 + 2 };
    case 7:
      return { category: "numeric_overflow", value: -(2 ** 63) };
    case 8:
      return { category: "numeric_overflow", value: Number.MIN_VALUE };
    case 9:
      return { category: "numeric_overflow", value: 1e308 * 10 }; // Infinity by overflow
    case 10:
      return { category: "numeric_overflow", value: 1e21 };
    case 11:
      return { category: "numeric_overflow", value: -1 };
    case 12:
      return { category: "numeric_overflow", value: 0.1 + 0.2 };
    default:
      return { category: "numeric_overflow", value: rng.float() * 1e12 - 5e11 };
  }
}

/** A value of a deliberately wrong JS type for whatever slot receives it. */
export function wrongTypeValue(rng: Rng): Hostile<unknown> {
  const choice = rng.int(0, 15);
  switch (choice) {
    case 0:
      return { category: "wrong_type", value: null };
    case 1:
      return { category: "wrong_type", value: undefined };
    case 2:
      return { category: "wrong_type", value: true };
    case 3:
      return { category: "wrong_type", value: false };
    case 4:
      return { category: "wrong_type", value: "1" };
    case 5:
      return { category: "wrong_type", value: "" };
    case 6:
      return { category: "wrong_type", value: rng.int(-1000, 1000) };
    case 7:
      return { category: "empty_array", value: [] };
    case 8:
      return { category: "empty_object", value: {} };
    case 9:
      return { category: "wrong_type", value: [[]] };
    case 10:
      return { category: "wrong_type", value: { a: {} } };
    case 11:
      return { category: "wrong_type", value: () => undefined };
    case 12:
      return { category: "wrong_type", value: Symbol("hostile") };
    case 13:
      return { category: "wrong_type", value: BigInt(rng.int(0, 1_000_000)) };
    case 14:
      return { category: "wrong_type", value: new Date(rng.int(0, 2_000_000_000) * 1000) };
    default:
      return { category: "wrong_type", value: Object.create(null) as object };
  }
}

/** Any hostile scalar-ish value (string flavours + numbers + wrong types). */
export function hostileScalar(rng: Rng): Hostile<unknown> {
  const choice = rng.int(0, 9);
  switch (choice) {
    case 0:
      return hostileNumber(rng);
    case 1:
    case 2:
      return wrongTypeValue(rng);
    case 3:
      return hugeString(rng);
    case 4:
      return nullByteString(rng);
    case 5:
      return pathTraversalString(rng);
    case 6:
      return unicodeNormalizationString(rng);
    case 7:
      return capBoundaryString(rng, rng.pick([50, 60, 64, 128, 160, 200]));
    case 8:
      return { category: "proto_pollution", value: rng.pick(POLLUTION_KEYS) };
    default:
      return hostileString(rng);
  }
}

/** Hostile strings only (for string-typed entry points). */
export function hostileString(rng: Rng): Hostile<string> {
  const choice = rng.int(0, 9);
  switch (choice) {
    case 0:
      return hugeString(rng);
    case 1:
      return nullByteString(rng);
    case 2:
      return pathTraversalString(rng);
    case 3:
      return unicodeNormalizationString(rng);
    case 4:
      return capBoundaryString(rng, rng.pick([50, 60, 64, 160]));
    case 5:
      return { category: "proto_pollution", value: rng.pick(POLLUTION_KEYS) };
    case 6:
      return { category: "future_schema", value: futureVersionString(rng) };
    case 7:
      return { category: "nan", value: rng.pick(["NaN", "Infinity", "-Infinity", "-0", "1e309"]) };
    case 8:
      return { category: "wrong_type", value: rng.pick(["", " ", "\t\n", "null", "undefined"]) };
    default:
      return { category: "malformed_json", value: malformedJsonText(rng, '{"a":1}') };
  }
}

export function futureVersionString(rng: Rng): string {
  const bases = [
    "evaluation-trial",
    "consent-ledger-export",
    "model-training",
    "video-analysis",
    "evaluation-telemetry",
    "quality-dashboard",
    "stability-slo",
    "voice-intent",
    "technique-intent",
  ];
  const base = rng.pick(bases);
  const suffix = rng.int(0, 7);
  switch (suffix) {
    case 0:
      return `${base}-v${rng.int(2, 99)}`;
    case 1:
      return `${base}-v1.${rng.int(1, 9)}`;
    case 2:
      return `${base}-v${rng.int(1, 9)}-beta`;
    case 3:
      return `${base}-v0${rng.int(1, 9)}`; // zero-padded major
    case 4:
      return `${base}-v${"9".repeat(rng.int(16, 40))}`; // beyond 2^53
    case 5:
      return `${base}-v${"9".repeat(rng.int(300, 400))}`; // beyond Number range
    case 6:
      return `${base}-V${rng.int(1, 9)}`; // case
    default:
      return `${base}-v${rng.int(1, 9)} `; // trailing space
  }
}

/**
 * Attach prototype-pollution keys as OWN properties (exactly what
 * JSON.parse produces for {"__proto__": …}) to a copy of `base`.
 */
export function pollute<T extends object>(rng: Rng, base: T): Hostile<T> {
  const copy: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  const count = rng.int(1, 3);
  for (let i = 0; i < count; i += 1) {
    const key = rng.pick(POLLUTION_KEYS);
    const payload = rng.pick<unknown>([
      { polluted: true },
      { polluted: "yes", isAdmin: true },
      "polluted",
      1,
      null,
      [],
    ]);
    Object.defineProperty(copy, key, {
      value: payload,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { category: "proto_pollution", value: copy as T };
}

/** JSON text that produces an own `__proto__` key when parsed. */
export function pollutedJsonText(rng: Rng, innerJson: string): string {
  const key = rng.pick(POLLUTION_KEYS);
  const body = innerJson.startsWith("{") ? innerJson.slice(1) : `${innerJson}}`;
  return `{"${key}":{"polluted":true},${body.length > 1 ? body : "}"}`;
}

/** Truncate valid JSON text at a seeded offset (always strictly shorter). */
export function truncatedJsonText(rng: Rng, validJson: string): Hostile<string> {
  const cut = rng.int(0, Math.max(0, validJson.length - 1));
  return { category: "truncated_json", value: validJson.slice(0, cut) };
}

/** Syntactically broken or non-standard JSON text derived from valid text. */
export function malformedJsonText(rng: Rng, validJson: string): string {
  const flavor = rng.int(0, 13);
  const text = malformedJsonFlavor(flavor, rng, validJson);
  // A replace-based flavor whose pattern is absent leaves the text valid;
  // guarantee every returned text differs from the input.
  return text === validJson ? `${validJson}garbage` : text;
}

function malformedJsonFlavor(flavor: number, rng: Rng, validJson: string): string {
  switch (flavor) {
    case 0:
      return validJson.replace(/"/g, "'");
    case 1:
      return validJson.replace(/}\s*$/, ",}");
    case 2:
      return `${validJson}garbage`;
    case 3:
      return `\ufeff${validJson}`; // BOM
    case 4:
      return validJson.replace(/:\s*(-?\d+(\.\d+)?)/, ": NaN");
    case 5:
      return validJson.replace(/:\s*(-?\d+(\.\d+)?)/, ": Infinity");
    case 6:
      return validJson.replace(/:\s*(-?\d+(\.\d+)?)/, ": -0");
    case 7:
      return validJson.replace(/:\s*(-?\d+(\.\d+)?)/, ": 1e999");
    case 8:
      return `// comment\n${validJson}`;
    case 9:
      return "[".repeat(rng.int(1_000, 50_000));
    case 10:
      return validJson.replace(/"([a-zA-Z]+)":/, "$1:"); // unquoted key
    case 11:
      return validJson.replace(/\s*:\s*/, "=");
    case 12:
      return `${validJson.slice(0, -1)}, "\u0000": 1}`; // null-byte key
    default:
      return validJson.replace(/"([^"]{2,})"/, '"$1\u0000"'); // raw NUL inside string
  }
}

/** Describe a value compactly for the results table (never megabytes). */
export function describeValue(value: unknown): string {
  try {
    if (typeof value === "string") {
      const head = value.length > 80 ? `${value.slice(0, 80)}…` : value;
      return `string(len=${value.length}) ${JSON.stringify(head)}`;
    }
    if (typeof value === "number") {
      if (Object.is(value, -0)) return "number(-0)";
      return `number(${String(value)})`;
    }
    if (typeof value === "bigint") return `bigint(${value.toString()})`;
    if (typeof value === "symbol") return "symbol";
    if (typeof value === "function") return "function";
    if (value instanceof Date)
      return `Date(${Number.isNaN(value.getTime()) ? "invalid" : value.toISOString()})`;
    if (value === undefined) return "undefined";
    const text = JSON.stringify(value, (_k, v: unknown) =>
      typeof v === "number" && !Number.isFinite(v)
        ? `<${String(v)}>`
        : typeof v === "bigint"
          ? `<bigint ${v.toString()}>`
          : v,
    );
    if (text === undefined) return String(value);
    return text.length > 200 ? `${text.slice(0, 200)}… (len=${text.length})` : text;
  } catch {
    return "<undescribable>";
  }
}
