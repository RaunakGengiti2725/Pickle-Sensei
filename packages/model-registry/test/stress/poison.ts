import type { Prng } from "./prng.js";

/**
 * Boundary / malformed value pool for the boundary-malformed lens. Every
 * value is either JSON-representable or one of the JS-only numerics the lens
 * names explicitly (NaN, ±Infinity, -0, undefined). Each entry carries a
 * stable tag so result tables stay readable without dumping 64 KB strings.
 */
export interface Poison {
  tag: string;
  value: unknown;
}

const BIG = 65_537;

const protoPolluted = (): unknown => JSON.parse('{"__proto__":{"polluted":true}}');
const ctorPolluted = (): unknown => JSON.parse('{"constructor":{"prototype":{"polluted":true}}}');

export const POISONS: readonly Poison[] = [
  { tag: "undefined", value: undefined },
  { tag: "null", value: null },
  { tag: "zero", value: 0 },
  { tag: "neg-zero", value: -0 },
  { tag: "one", value: 1 },
  { tag: "neg-one", value: -1 },
  { tag: "float", value: 1.5 },
  { tag: "NaN", value: NaN },
  { tag: "Infinity", value: Infinity },
  { tag: "-Infinity", value: -Infinity },
  { tag: "unsafe-int", value: Number.MAX_SAFE_INTEGER + 2 },
  { tag: "huge-float", value: 1e308 },
  { tag: "tiny-float", value: 5e-324 },
  { tag: "empty-string", value: "" },
  { tag: "space", value: " " },
  { tag: "alias-latest", value: "latest" },
  { tag: "alias-latest-padded", value: " LATEST\t" },
  { tag: "alias-latest-zwsp", value: "latest\u200b" },
  { tag: "alias-latest-fullwidth", value: "\uff4c\uff41\uff54\uff45\uff53\uff54" },
  { tag: "string-null", value: "null" },
  { tag: "string-undefined", value: "undefined" },
  { tag: "string-zero", value: "0" },
  { tag: "string-one", value: "1" },
  { tag: "string-true", value: "true" },
  { tag: "string-NaN", value: "NaN" },
  { tag: "traversal-posix", value: "../../../etc/passwd" },
  { tag: "traversal-win", value: "..\\..\\windows\\system32" },
  { tag: "traversal-encoded", value: "%2e%2e%2f%2e%2e%2fetc" },
  { tag: "absolute-path", value: "/etc/passwd" },
  { tag: "file-url", value: "file:///etc/passwd" },
  { tag: "at-sign", value: "a@b" },
  { tag: "at-sign-double", value: "@@" },
  { tag: "null-byte-mid", value: "a\u0000b" },
  { tag: "null-byte-only", value: "\u0000" },
  { tag: "newline-injection", value: "ok\nEntry x@y cannot be its own rollback predecessor." },
  { tag: "crlf", value: "a\r\nb" },
  { tag: "big-ascii-64k", value: "x".repeat(BIG) },
  { tag: "big-multibyte-64k", value: "\u00e9".repeat(BIG) },
  {
    tag: "big-grapheme-64k",
    value: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67".repeat(8_000),
  },
  { tag: "lone-high-surrogate", value: "\ud800" },
  { tag: "lone-low-surrogate", value: "\udc00" },
  { tag: "nfc-cafe", value: "caf\u00e9" },
  { tag: "nfd-cafe", value: "cafe\u0301" },
  { tag: "ligature-fi", value: "\ufb01le" },
  { tag: "fullwidth-A", value: "\uff21" },
  { tag: "rtl-override", value: "\u202eevil" },
  { tag: "bom", value: "\ufeffv1" },
  { tag: "sha-uppercase", value: "A".repeat(64) },
  { tag: "sha-63", value: "a".repeat(63) },
  { tag: "sha-65", value: "a".repeat(65) },
  { tag: "sha-nonhex", value: "g".repeat(64) },
  { tag: "sha-ok", value: "0".repeat(64) },
  { tag: "version-ok", value: "v1" },
  { tag: "version-v1.2.3", value: "v1.2.3" },
  { tag: "version-v-trailing-dot", value: "v1." },
  { tag: "version-no-v", value: "1" },
  { tag: "version-vv", value: "vv1" },
  { tag: "version-negative", value: "v-1" },
  { tag: "iso-ok", value: "2026-08-29T00:00:00.000Z" },
  { tag: "iso-garbage", value: "not a date" },
  { tag: "iso-year-only", value: "2026" },
  { tag: "iso-feb-30", value: "2026-02-30T00:00:00Z" },
  { tag: "iso-far-future", value: "+275760-09-13T00:00:00.000Z" },
  { tag: "iso-beyond-range", value: "+275760-09-13T00:00:00.001Z" },
  { tag: "empty-array", value: [] },
  { tag: "empty-object", value: {} },
  { tag: "array-null", value: [null] },
  { tag: "array-undefined", value: [undefined] },
  { tag: "array-nested-empty", value: [[]] },
  { tag: "array-numbers", value: [1, 2, 3] },
  { tag: "array-strings", value: ["ios", "android"] },
  { tag: "array-mixed", value: ["ios", 1, null] },
  { tag: "object-a1", value: { a: 1 } },
  { tag: "object-proto-polluted", value: protoPolluted() },
  { tag: "object-ctor-polluted", value: ctorPolluted() },
  { tag: "object-sessions-string", value: { sessions: "abc" } },
  { tag: "true", value: true },
  { tag: "false", value: false },
];

export function pickPoison(rng: Prng): Poison {
  return rng.pick(POISONS);
}

/** Short, table-safe rendering of an arbitrary value. */
export function describeValue(value: unknown): string {
  if (typeof value === "string") {
    const shown = value.length > 40 ? `${value.slice(0, 37)}...` : value;
    const escaped = Array.from(shown, (c) => {
      const code = c.codePointAt(0) ?? 0;
      const invisible =
        code <= 0x1f ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x200b ||
        code === 0x202e ||
        code === 0xfeff;
      return invisible ? `\\u${code.toString(16).padStart(4, "0")}` : c;
    }).join("");
    return `"${escaped}"(len=${value.length})`;
  }
  if (typeof value === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") return `object(keys=${Object.keys(value).join(",")})`;
  return String(value);
}
