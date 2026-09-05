import type { Prng } from "./prng.js";

/**
 * Edge-value catalogue and generic JSON mutators for the boundary/malformed
 * lens. Everything here is a pure function of the PRNG so a payload is fully
 * determined by its seed.
 */

export type JsonPath = Array<string | number>;

export const EDGE_NUMBERS_NON_FINITE = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

export const EDGE_NUMBERS_FINITE = [
  -0,
  0,
  -1,
  1.5,
  -1.5,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Number.MIN_VALUE,
  5e-324,
  1e-320,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER,
  2 ** 31,
  -(2 ** 31),
  2 ** 32,
  2 ** 53,
  1e21,
  0.1 + 0.2,
  Number.EPSILON,
  999,
  42,
];

/** Literal number tokens for JSON *text* mutation (valid and invalid). */
export const EDGE_NUMBER_TOKENS = [
  "1e999",
  "-1e999",
  "1E400",
  "-0",
  "0.1e-999",
  "1e-400",
  "9".repeat(400),
  "-" + "9".repeat(400),
  "9007199254740993",
  "1.7976931348623157e308",
  "01",
  "NaN",
  "Infinity",
  "-Infinity",
  ".5",
  "1.",
  "0x10",
  "-",
  "1e",
  "+1",
  "1_000",
  "0b1",
  "",
  "null",
  "true",
  '"1"',
  "[]",
  "{}",
];

export const PROTO_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "toString",
  "valueOf",
];

export const PATH_TRAVERSAL_STRINGS = [
  "../../../etc/passwd",
  "..\\..\\windows\\system32",
  "/etc/passwd",
  "a/b",
  "a\\b",
  "..",
  ".",
  "./x",
  "%2e%2e%2f%2e%2e%2fetc",
  "..%2f..%2f",
  "\u2025/\u2025",
  "x/../../y",
  "C:\\x",
  "\\\\server\\share",
  "file:///etc/passwd",
  "-rf",
  "--out-dir",
  "$HOME",
  "`id`",
  "$(id)",
];

/** NFC / NFD pairs — same grapheme, different code point sequences. */
export const UNICODE_NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"],
  ["\u00c5", "A\u030a"],
  ["\u1e69", "s\u0323\u0307"],
  ["\ufb01", "fi"],
  ["\u212b", "\u00c5"],
  ["\u2126", "\u03a9"],
  ["\u00f1", "n\u0303"],
  ["\u1e0b\u0323", "d\u0323\u0307"],
];

export function makeLongString(units: number, atom = "a"): string {
  return atom.repeat(Math.ceil(units / atom.length));
}

/** Strings around byte / code point / grapheme caps and other nasties. */
export function edgeString(rng: Prng): string {
  const kind = rng.int(0, 22);
  switch (kind) {
    case 0:
      return "";
    case 1:
      return "\u0000";
    case 2:
      return `abc\u0000def`;
    case 3:
      return makeLongString(64 * 1024);
    case 4:
      return makeLongString(64 * 1024 + 1);
    case 5:
      // 4-byte UTF-8 code points: 64 Ki code points = 256 KiB UTF-8, 128 Ki UTF-16 units.
      return "\u{1F3D3}".repeat(64 * 1024);
    case 6:
      // 16 Ki graphemes of a 4-code-point family emoji ZWJ sequence.
      return "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}".repeat(16 * 1024);
    case 7:
      // Lone surrogate — not valid UTF-16, JSON.stringify escapes it.
      return "\ud800";
    case 8:
      return "\udc00abc";
    case 9:
      return rng.pick(PATH_TRAVERSAL_STRINGS);
    case 10:
      return rng.pick(UNICODE_NORMALIZATION_PAIRS)[rng.int(0, 1)]!;
    case 11:
      return rng.pick(PROTO_KEYS);
    case 12:
      return "\u202e\u0644\u0627\u0631"; // RTL override
    case 13:
      return "\u200b\u200c\u200d\ufeff"; // zero-width + BOM
    case 14:
      return " ";
    case 15:
      return "\n\r\t";
    case 16:
      return "2026-13-45T99:99:99Z";
    case 17:
      return "1";
    case 18:
      return "0".repeat(1024);
    case 19:
      return "a".repeat(128);
    case 20:
      return "a".repeat(129);
    case 21:
      return "\u0000".repeat(4096);
    default:
      return String.fromCodePoint(safeCodePoint(rng));
  }
}

function safeCodePoint(rng: Prng): number {
  let cp = rng.int(0x80, 0x10ffff);
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0x41;
  return cp;
}

export function wrongTypeValue(rng: Prng, current: unknown): unknown {
  const candidates: unknown[] = [
    "string",
    42,
    -1,
    true,
    false,
    null,
    undefined,
    [],
    {},
    [1, 2, 3],
    { a: 1 },
    () => 0,
    Symbol("s"),
    10n,
    new Date(0),
    /re/,
  ];
  const type = typeOf(current);
  const filtered = candidates.filter((candidate) => typeOf(candidate) !== type);
  return rng.pick(filtered);
}

export function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Enumerate every container and leaf path in a JSON-ish document. */
export function enumeratePaths(
  doc: unknown,
  prefix: JsonPath = [],
  out: JsonPath[] = [],
): JsonPath[] {
  out.push(prefix);
  if (Array.isArray(doc)) {
    doc.forEach((item, index) => enumeratePaths(item, [...prefix, index], out));
  } else if (typeof doc === "object" && doc !== null) {
    for (const key of Object.keys(doc)) {
      enumeratePaths((doc as Record<string, unknown>)[key], [...prefix, key], out);
    }
  }
  return out;
}

export function getAt(doc: unknown, path: JsonPath): unknown {
  let cursor: unknown = doc;
  for (const key of path) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return cursor;
}

/** Returns a new root when `path` is empty, otherwise mutates in place. */
export function setAt(doc: unknown, path: JsonPath, value: unknown): unknown {
  if (path.length === 0) return value;
  const parent = getAt(doc, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (parent === null || typeof parent !== "object") return doc;
  if (typeof last === "string" && PROTO_KEYS.includes(last)) {
    // Create an OWN property (like JSON.parse does) instead of hitting the setter.
    Object.defineProperty(parent, last, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else {
    (parent as Record<string | number, unknown>)[last] = value;
  }
  return doc;
}

export function deleteAt(doc: unknown, path: JsonPath): unknown {
  if (path.length === 0) return doc;
  const parent = getAt(doc, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (Array.isArray(parent) && typeof last === "number") {
    parent.splice(last, 1);
  } else if (parent !== null && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[String(last)];
  }
  return doc;
}

export function deepNestedArray(depth: number): unknown {
  let value: unknown = 0;
  for (let index = 0; index < depth; index += 1) value = [value];
  return value;
}

export function deepNestedObject(depth: number): unknown {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor.a = next;
    cursor = next;
  }
  return root;
}

/**
 * Structured clone for JSON-ish documents that preserves NaN/±Infinity/-0
 * (JSON.stringify would turn them into null / "0") and own `__proto__` keys.
 */
export function cloneJsonish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonish);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const child = cloneJsonish((value as Record<string, unknown>)[key]);
      if (PROTO_KEYS.includes(key)) {
        Object.defineProperty(out, key, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else {
        out[key] = child;
      }
    }
    return out;
  }
  return value;
}

/** Deterministic, cycle-free description of any value for fingerprints/logs. */
export function describeValue(value: unknown, depth = 0): string {
  if (depth > 6) return "…";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") {
    const shown = value.length > 48 ? `${value.slice(0, 40)}…(${value.length} units)` : value;
    return JSON.stringify(shown);
  }
  if (value === null) return "null";
  if (value instanceof Date) return `Date(${value.getTime()})`;
  if (value instanceof RegExp) return value.toString();
  if (Array.isArray(value)) {
    if (value.length > 8) return `[array ×${value.length}]`;
    return `[${value.map((item) => describeValue(item, depth + 1)).join(",")}]`;
  }
  const keys = Object.keys(value);
  if (keys.length > 12) return `{object ×${keys.length} keys}`;
  return `{${keys
    .map(
      (key) =>
        `${JSON.stringify(key)}:${describeValue((value as Record<string, unknown>)[key], depth + 1)}`,
    )
    .join(",")}}`;
}
