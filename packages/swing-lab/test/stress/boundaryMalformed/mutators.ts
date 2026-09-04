/**
 * Malformation library for the boundary/malformed lens.
 *
 * Every mutator takes a VALID payload (deep-cloned by the caller) plus the
 * iteration RNG and returns the malformed payload together with a
 * classification of what was done and whether a correct validator MUST
 * reject the result. "Must reject" is deliberately conservative: it is only
 * set when the mutation makes the payload unambiguously invalid for the
 * target surface (top-level not an object, a known non-free-text field
 * replaced by a wrong type or a non-finite number, a future schema
 * version, a traversal path in a field the surface documents as a path).
 * Everything else is recorded as "observe" so the results table can be
 * mined for length caps / control characters / normalization behaviour
 * without turning an absent cap into a fabricated failure.
 */
import type { Rng } from "./rng.js";

export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export const MUTATION_CATEGORIES = [
  "truncated_json",
  "malformed_json_text",
  "wrong_type",
  "prototype_pollution",
  "numeric_extreme",
  "null_bytes",
  "oversized_string",
  "path_traversal",
  "future_schema",
  "empty_container",
  "unicode_normalization",
  "deep_nesting",
  "top_level_shape",
  "duplicate_or_reordered",
  "sparse_array",
  "date_boundary",
] as const;
export type MutationCategory = (typeof MUTATION_CATEGORIES)[number];

export interface SurfaceShapeHints {
  /** Paths (joined with ".") whose STRING content is free text: any string
   * value is legitimately acceptable there. Regexps are tested against the
   * dotted path with array indices replaced by "[]". */
  freeTextPaths: readonly RegExp[];
  /** Paths whose value is a schema/version discriminator. */
  schemaVersionPaths: readonly RegExp[];
  /** Paths the surface documents as filesystem paths / slugs / ids used to
   * address storage. Traversal payloads here MUST be rejected. */
  pathLikePaths: readonly RegExp[];
  /** Paths that are ISO-8601 timestamps. */
  isoDatePaths: readonly RegExp[];
  /** Paths that may legitimately hold ANY JSON (opaque blobs); wrong-type
   * mutations there are "observe", never "must reject". */
  opaquePaths: readonly RegExp[];
}

export const NO_HINTS: SurfaceShapeHints = {
  freeTextPaths: [],
  schemaVersionPaths: [/(^|\.)(schemaVersion|version|bundleVersion|policyVersion)$/],
  pathLikePaths: [],
  isoDatePaths: [/Iso$/, /^dateIso$/],
  opaquePaths: [],
};

export interface Mutation {
  category: MutationCategory;
  /** Human-readable description of exactly what was changed. */
  detail: string;
  /** Dotted path (indices as [n]) of the touched field, or "$" for the root. */
  path: string;
  /** Whether a correct validator MUST reject the mutated payload. */
  mustReject: boolean;
  /** Sub-kind of numeric/string extreme used, for aggregation. */
  variant: string;
}

export interface MutatedPayload {
  payload: unknown;
  mutations: Mutation[];
}

interface PathEntry {
  segments: Array<string | number>;
  value: JsonValue;
  container: boolean;
}

function isPlainObject(value: unknown): value is { [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function enumeratePaths(value: JsonValue, prefix: Array<string | number> = []): PathEntry[] {
  const out: PathEntry[] = [];
  if (Array.isArray(value)) {
    out.push({ segments: prefix, value, container: true });
    value.forEach((item, index) => out.push(...enumeratePaths(item, [...prefix, index])));
  } else if (isPlainObject(value)) {
    out.push({ segments: prefix, value, container: true });
    for (const [key, item] of Object.entries(value)) {
      out.push(...enumeratePaths(item, [...prefix, key]));
    }
  } else {
    out.push({ segments: prefix, value, container: false });
  }
  return out;
}

export function dottedPath(segments: ReadonlyArray<string | number>): string {
  if (segments.length === 0) return "$";
  return segments.map((segment) => (typeof segment === "number" ? "[]" : segment)).join(".");
}

function matchesAny(path: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function setAtPath(
  root: JsonValue,
  segments: ReadonlyArray<string | number>,
  value: JsonValue,
): JsonValue {
  if (segments.length === 0) return value;
  let cursor: JsonValue = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index] as string | number;
    if (Array.isArray(cursor) && typeof segment === "number") {
      cursor = cursor[segment] as JsonValue;
    } else if (isPlainObject(cursor) && typeof segment === "string") {
      cursor = cursor[segment] as JsonValue;
    } else {
      return root;
    }
  }
  const last = segments[segments.length - 1] as string | number;
  if (Array.isArray(cursor) && typeof last === "number") cursor[last] = value;
  else if (isPlainObject(cursor) && typeof last === "string") cursor[last] = value;
  return root;
}

/* ------------------------------------------------------------------------ *
 * Payload atoms
 * ------------------------------------------------------------------------ */

export const NUMERIC_EXTREMES: ReadonlyArray<{ name: string; value: number }> = [
  { name: "NaN", value: Number.NaN },
  { name: "+Infinity", value: Number.POSITIVE_INFINITY },
  { name: "-Infinity", value: Number.NEGATIVE_INFINITY },
  { name: "-0", value: -0 },
  { name: "MAX_SAFE_INTEGER+2", value: Number.MAX_SAFE_INTEGER + 2 },
  { name: "-MAX_SAFE_INTEGER-2", value: -Number.MAX_SAFE_INTEGER - 2 },
  { name: "MAX_VALUE", value: Number.MAX_VALUE },
  { name: "-MAX_VALUE", value: -Number.MAX_VALUE },
  { name: "MIN_VALUE(denormal)", value: Number.MIN_VALUE },
  { name: "2^53", value: 2 ** 53 },
  { name: "1e21", value: 1e21 },
  { name: "-1", value: -1 },
  { name: "1.0000000000000002", value: 1.0000000000000002 },
  { name: "0.30000000000000004", value: 0.1 + 0.2 },
];

/** Non-finite extremes are the only ones that are unconditionally invalid
 * wherever a finite number is expected. */
const NON_FINITE = new Set(["NaN", "+Infinity", "-Infinity"]);

const TRAVERSAL_PAYLOADS: readonly string[] = [
  "../../../etc/passwd",
  "..%2F..%2Fetc%2Fpasswd",
  "wave-c/../../../.ssh/id_rsa",
  "/etc/shadow",
  "\\\\server\\share\\x",
  "..\\..\\windows\\system32",
  "C:\\Windows\\system32\\drivers\\etc\\hosts",
  "file:///etc/passwd",
  "%00../../x",
  "..\u2215..\u2215x", // U+2215 DIVISION SLASH look-alike
  "\u2025/\u2025/x", // U+2025 TWO DOT LEADER look-alike
  "./././../x",
  "x/..",
  "..",
  ".",
  "",
  " ",
  "a//b",
  "~/.bashrc",
  "$HOME/.profile",
  "datasets/../datasets/pickleball/registry.json",
];

const WRONG_TYPE_VALUES: ReadonlyArray<{ name: string; make: (rng: Rng) => JsonValue }> = [
  { name: "null", make: () => null },
  { name: "true", make: () => true },
  { name: "false", make: () => false },
  { name: "0", make: () => 0 },
  { name: "1", make: () => 1 },
  { name: "-1", make: () => -1 },
  { name: "empty_string", make: () => "" },
  { name: "numeric_string", make: () => "1" },
  { name: "string", make: () => "not-what-you-expect" },
  { name: "empty_array", make: () => [] },
  { name: "array_of_nulls", make: () => [null, null] },
  { name: "empty_object", make: () => ({}) },
  { name: "object", make: () => ({ unexpected: true }) },
  { name: "nested_array", make: () => [[[]]] },
  { name: "boolean_string", make: () => "true" },
  { name: "float", make: (rng) => rng.next() * 10 - 5 },
];

const CONTROL_CHAR_INSERTS: readonly string[] = [
  "\u0000",
  "\u0000\u0000",
  "a\u0000b",
  "\u0000".repeat(64),
  "\u0001\u0002\u0003",
  "\u007f",
  "\u200b", // zero width space
  "\u200d", // ZWJ
  "\u202e", // RTL override
  "\ufeff", // BOM
  "\ud800", // lone high surrogate
  "\udfff", // lone low surrogate
  "\r\n",
  "\t",
];

/** NFC / NFD pairs plus confusables for enum-like fields. */
export const NORMALIZATION_PAIRS: ReadonlyArray<{ name: string; a: string; b: string }> = [
  { name: "e-acute", a: "\u00e9", b: "e\u0301" },
  { name: "angstrom", a: "\u00c5", b: "A\u030a" },
  { name: "ohm-vs-omega", a: "\u2126", b: "\u03a9" },
  { name: "kelvin-K", a: "\u212a", b: "K" },
  { name: "fullwidth-A", a: "\uff21", b: "A" },
  { name: "cyrillic-a", a: "\u0430", b: "a" },
  { name: "turkish-dotless-i", a: "\u0131", b: "i" },
  { name: "ligature-fi", a: "\ufb01", b: "fi" },
  { name: "hangul-composed", a: "\ud55c", b: "\u1112\u1161\u11ab" },
  { name: "zwj-family", a: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67", b: "\ud83d\udc68" },
];

function oversizedString(rng: Rng): { value: string; variant: string } {
  const variant = rng.pick([
    "ascii_65537",
    "ascii_131072",
    "two_byte_65537cp",
    "four_byte_65537cp",
    "grapheme_zwj_16384",
    "combining_marks_65537",
    "ascii_1048577",
  ]);
  switch (variant) {
    case "ascii_65537":
      return { variant, value: "x".repeat(65_537) };
    case "ascii_131072":
      return { variant, value: "y".repeat(131_072) };
    case "two_byte_65537cp":
      return { variant, value: "\u00e9".repeat(65_537) }; // 131_074 bytes UTF-8
    case "four_byte_65537cp":
      return { variant, value: "\ud83c\udfd3".repeat(65_537) }; // ping-pong paddle; 262_148 bytes
    case "grapheme_zwj_16384":
      // one grapheme = 7 code units, 3 code points, 18 bytes → 16_384 graphemes ≈ 294 KB
      return { variant, value: "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67".repeat(16_384) };
    case "combining_marks_65537":
      return { variant, value: `a${"\u0301".repeat(65_537)}` }; // ONE grapheme, 65_538 code points
    case "ascii_1048577":
    default:
      return { variant, value: "z".repeat(1_048_577) };
  }
}

const DATE_BOUNDARIES: readonly string[] = [
  "2026-02-30T00:00:00.000Z", // impossible day (Date.parse accepts in V8)
  "2026-13-01T00:00:00.000Z",
  "2026-08-29T24:00:00.000Z",
  "2026-08-29T23:59:60.000Z", // leap second
  "+275760-09-13T00:00:00.000Z", // max Date
  "+275760-09-13T00:00:00.001Z", // overflow → Invalid Date
  "-271821-04-20T00:00:00.000Z", // min Date
  "0000-00-00T00:00:00Z",
  "1970-01-01T00:00:00.000Z",
  "2026-08-29",
  "2026-08-29T00:00:00",
  "2026-08-29T00:00:00+25:00",
  "Fri, 29 Aug 2026 00:00:00 GMT",
  "1756425600000",
  "now",
  "2026-08-29T00:00:00.000Z\u0000",
  " 2026-08-29T00:00:00.000Z",
  "２０２６-08-29T00:00:00.000Z", // fullwidth digits
  "2026\u201308\u201329T00:00:00.000Z", // en dashes
];

/* ------------------------------------------------------------------------ *
 * Mutators
 * ------------------------------------------------------------------------ */

type Mutator = (
  payload: JsonValue,
  rng: Rng,
  hints: SurfaceShapeHints,
) => { payload: unknown; mutation: Mutation } | null;

function pickLeaf(
  payload: JsonValue,
  rng: Rng,
  filter: (entry: PathEntry, dotted: string) => boolean = () => true,
): { entry: PathEntry; dotted: string } | null {
  const candidates = enumeratePaths(payload)
    .filter((entry) => entry.segments.length > 0)
    .map((entry) => ({ entry, dotted: dottedPath(entry.segments) }))
    .filter(({ entry, dotted }) => filter(entry, dotted));
  if (candidates.length === 0) return null;
  return rng.pick(candidates);
}

const truncatedJson: Mutator = (payload, rng) => {
  const text = JSON.stringify(payload);
  const cut = rng.int(0, Math.max(0, text.length - 1));
  const truncated = text.slice(0, cut);
  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(truncated);
    parsedOk = true;
  } catch {
    parsed = truncated;
  }
  return {
    payload: parsed,
    mutation: {
      category: "truncated_json",
      detail: parsedOk
        ? `JSON text truncated at ${cut}/${text.length} still parsed (fed the parsed value)`
        : `JSON text truncated at ${cut}/${text.length} — unparseable; fed the raw string`,
      path: "$",
      variant: parsedOk ? "parsed" : "raw_string",
      // A raw string is never a valid record. A truncation that still
      // parses is only a prefix of the original when it is a primitive.
      mustReject: !parsedOk || typeof parsed !== "object" || parsed === null,
    },
  };
};

const malformedJsonText: Mutator = (payload, rng) => {
  const text = JSON.stringify(payload);
  const variant = rng.pick([
    "trailing_comma",
    "single_quotes",
    "unquoted_key",
    "nan_literal",
    "infinity_literal",
    "comment",
    "leading_bom",
    "duplicate_key",
    "hex_number",
    "leading_zero",
    "control_in_string",
    "concatenated_documents",
  ]);
  let mutated: string;
  switch (variant) {
    case "trailing_comma":
      mutated = text.replace(/}$/, ",}");
      break;
    case "single_quotes":
      mutated = text.replace(/"/g, "'");
      break;
    case "unquoted_key":
      mutated = text.replace(/"([A-Za-z_]+)":/, "$1:");
      break;
    case "nan_literal":
      mutated = text.replace(/:\s*-?\d+(\.\d+)?/, ":NaN");
      break;
    case "infinity_literal":
      mutated = text.replace(/:\s*-?\d+(\.\d+)?/, ":Infinity");
      break;
    case "comment":
      mutated = `/* stress */${text}`;
      break;
    case "leading_bom":
      mutated = `\ufeff${text}`;
      break;
    case "duplicate_key": {
      const firstKey = /"([A-Za-z_]+)":/.exec(text)?.[1];
      mutated = firstKey ? text.replace(/^\{/, `{"${firstKey}":null,`) : `${text}}`;
      break;
    }
    case "hex_number":
      mutated = text.replace(/:\s*-?\d+(\.\d+)?/, ":0x10");
      break;
    case "leading_zero":
      mutated = text.replace(/:\s*-?\d+(\.\d+)?/, ":007");
      break;
    case "control_in_string":
      mutated = text.replace(/"([^"]*)"/, '"$1\u0001"');
      break;
    case "concatenated_documents":
    default:
      mutated = `${text}${text}`;
      break;
  }
  let parsed: unknown;
  let parsedOk = false;
  try {
    parsed = JSON.parse(mutated);
    parsedOk = true;
  } catch {
    parsed = mutated;
  }
  return {
    payload: parsed,
    mutation: {
      category: "malformed_json_text",
      detail: parsedOk
        ? `${variant}: text still parsed under JSON.parse (duplicate keys last-wins / BOM); fed parsed value`
        : `${variant}: JSON.parse rejected; fed the raw text as the payload`,
      path: "$",
      variant,
      // duplicate_key with null first then real value → last-wins → still valid record.
      mustReject: !parsedOk,
    },
  };
};

const wrongType: Mutator = (payload, rng, hints) => {
  const target = pickLeaf(payload, rng);
  if (!target) return null;
  const choice = rng.pick(WRONG_TYPE_VALUES);
  const replacement = choice.make(rng);
  const sameKind =
    (typeof replacement === typeof target.entry.value &&
      Array.isArray(replacement) === Array.isArray(target.entry.value) &&
      (replacement === null) === (target.entry.value === null)) ||
    replacement === target.entry.value;
  const opaque = matchesAny(target.dotted, hints.opaquePaths);
  const freeText =
    matchesAny(target.dotted, hints.freeTextPaths) && typeof replacement === "string";
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, replacement),
    mutation: {
      category: "wrong_type",
      detail: `${target.dotted}: ${describeValue(target.entry.value)} → ${choice.name}`,
      path: target.dotted,
      variant: choice.name,
      // Same JS type (e.g. string → other string, number → other number) is
      // a VALUE change, not a type confusion — observe only. Null replacing
      // a field that may be nullable is also observe-only.
      mustReject: !sameKind && !opaque && !freeText && replacement !== null,
    },
  };
};

const prototypePollution: Mutator = (payload, rng) => {
  const containers = enumeratePaths(payload).filter((entry) => isPlainObject(entry.value));
  if (containers.length === 0) return null;
  const target = rng.pick(containers);
  const key = rng.pick(["__proto__", "constructor", "prototype"]);
  const variant = rng.pick(["via_json_parse", "via_assignment", "nested_constructor_prototype"]);
  const marker = { polluted: `seed-marker`, isAdmin: true };
  const clone = structuredClone(payload);
  let injected: JsonValue;
  if (variant === "via_json_parse") {
    // JSON.parse creates an OWN property named __proto__ (does not set the prototype).
    injected = JSON.parse(`{"${key}": ${JSON.stringify(marker)}}`) as JsonValue;
    const targetObject = getAtPath(clone, target.segments);
    if (isPlainObject(targetObject) && isPlainObject(injected)) {
      for (const [k, v] of Object.entries(injected)) {
        Object.defineProperty(targetObject, k, {
          value: v,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
  } else if (variant === "via_assignment") {
    const targetObject = getAtPath(clone, target.segments);
    if (isPlainObject(targetObject)) {
      // Plain assignment of "__proto__" on a normal object SETS the prototype
      // of that object (not Object.prototype) — records a pollution attempt.
      (targetObject as Record<string, unknown>)[key] = marker;
    }
  } else {
    const targetObject = getAtPath(clone, target.segments);
    if (isPlainObject(targetObject)) {
      Object.defineProperty(targetObject, "constructor", {
        value: { prototype: marker },
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return {
    payload: clone,
    mutation: {
      category: "prototype_pollution",
      detail: `${dottedPath(target.segments)}: injected "${key}" (${variant})`,
      path: dottedPath(target.segments),
      variant: `${key}:${variant}`,
      // Extra keys are not required to be rejected; the invariant checked
      // by the runner is that Object.prototype is untouched afterwards.
      mustReject: false,
    },
  };
};

function getAtPath(
  root: JsonValue,
  segments: ReadonlyArray<string | number>,
): JsonValue | undefined {
  let cursor: JsonValue | undefined = root;
  for (const segment of segments) {
    if (Array.isArray(cursor) && typeof segment === "number") cursor = cursor[segment];
    else if (isPlainObject(cursor) && typeof segment === "string") cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
}

const numericExtreme: Mutator = (payload, rng, hints) => {
  const target = pickLeaf(payload, rng, (entry) => typeof entry.value === "number");
  if (!target) return null;
  const extreme = rng.pick(NUMERIC_EXTREMES);
  const clone = structuredClone(payload);
  const opaque = matchesAny(target.dotted, hints.opaquePaths);
  return {
    payload: setAtPath(clone, target.entry.segments, extreme.value),
    mutation: {
      category: "numeric_extreme",
      detail: `${target.dotted}: ${String(target.entry.value)} → ${extreme.name}`,
      path: target.dotted,
      variant: extreme.name,
      mustReject: NON_FINITE.has(extreme.name) && !opaque,
    },
  };
};

const nullBytes: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng, (entry) => typeof entry.value === "string");
  if (!target) return null;
  const insert = rng.pick(CONTROL_CHAR_INSERTS);
  const original = target.entry.value as string;
  const position = rng.int(0, original.length);
  const mutated = `${original.slice(0, position)}${insert}${original.slice(position)}`;
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, mutated),
    mutation: {
      category: "null_bytes",
      detail: `${target.dotted}: inserted ${JSON.stringify(insert)} at ${position}`,
      path: target.dotted,
      variant: JSON.stringify(insert),
      // Enum / version / date fields with an inserted control char are no
      // longer the enum value → must reject. Free text: observe.
      mustReject: false,
    },
  };
};

const oversized: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng, (entry) => typeof entry.value === "string");
  if (!target) return null;
  const big = oversizedString(rng);
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, big.value),
    mutation: {
      category: "oversized_string",
      detail: `${target.dotted}: replaced ${(target.entry.value as string).length}-char string with ${big.variant} (${big.value.length} UTF-16 units)`,
      path: target.dotted,
      variant: big.variant,
      mustReject: false,
    },
  };
};

const pathTraversal: Mutator = (payload, rng, hints) => {
  const target = pickLeaf(
    payload,
    rng,
    (entry, dotted) =>
      typeof entry.value === "string" &&
      (matchesAny(dotted, hints.pathLikePaths) ||
        /(id|Id|ref|Ref|path|slug|bundle|case)/.test(dotted)),
  );
  if (!target) return null;
  const traversal = rng.pick(TRAVERSAL_PAYLOADS);
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, traversal),
    mutation: {
      category: "path_traversal",
      detail: `${target.dotted}: → ${JSON.stringify(traversal)}`,
      path: target.dotted,
      variant: traversal,
      mustReject:
        matchesAny(target.dotted, hints.pathLikePaths) &&
        (traversal.startsWith("/") || traversal.split("/").includes("..")),
    },
  };
};

const futureSchema: Mutator = (payload, rng, hints) => {
  const target = pickLeaf(payload, rng, (_entry, dotted) =>
    matchesAny(dotted, hints.schemaVersionPaths),
  );
  if (!target) return null;
  const current = target.entry.value;
  const variants: Array<{ name: string; value: JsonValue }> =
    typeof current === "number"
      ? [
          { name: "+1", value: current + 1 },
          { name: "999", value: 999 },
          { name: "MAX_SAFE_INTEGER", value: Number.MAX_SAFE_INTEGER },
          { name: "as_string", value: String(current) },
          { name: "fractional", value: current + 0.5 },
          { name: "negative", value: -current },
          { name: "zero", value: 0 },
          { name: "null", value: null },
        ]
      : [
          { name: "suffix_v99", value: `${String(current)}-v99` },
          {
            name: "bumped_digits",
            value: String(current).replace(/\d+/, (d) => String(Number(d) + 1)),
          },
          { name: "uppercased", value: String(current).toUpperCase() },
          { name: "trailing_space", value: `${String(current)} ` },
          { name: "nfd", value: String(current).normalize("NFD") },
          { name: "numeric", value: 2 },
          { name: "null", value: null },
          { name: "empty", value: "" },
        ];
  const chosen = rng.pick(variants);
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, chosen.value),
    mutation: {
      category: "future_schema",
      detail: `${target.dotted}: ${JSON.stringify(current)} → ${chosen.name}`,
      path: target.dotted,
      variant: chosen.name,
      // "uppercased"/"nfd" of an all-lowercase ASCII version string may be identical.
      mustReject: JSON.stringify(chosen.value) !== JSON.stringify(current),
    },
  };
};

const emptyContainer: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng, (entry) => entry.container);
  if (!target) return null;
  const replacement: JsonValue = Array.isArray(target.entry.value) ? [] : {};
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, replacement),
    mutation: {
      category: "empty_container",
      detail: `${target.dotted}: emptied ${Array.isArray(target.entry.value) ? "array" : "object"}`,
      path: target.dotted,
      variant: Array.isArray(target.entry.value) ? "[]" : "{}",
      // Empty arrays are often legitimate (no faults, no history). Empty
      // objects replacing required records are not, but which records are
      // required is surface-specific → observe.
      mustReject: false,
    },
  };
};

const unicodeNormalization: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng, (entry) => typeof entry.value === "string");
  if (!target) return null;
  const pair = rng.pick(NORMALIZATION_PAIRS);
  const original = target.entry.value as string;
  const variant = rng.pick([
    "replace_first_char",
    "append_a",
    "append_b",
    "nfd_whole",
    "nfkc_whole",
  ]);
  let mutated: string;
  switch (variant) {
    case "replace_first_char":
      mutated = original.length > 0 ? `${pair.a}${original.slice(1)}` : pair.a;
      break;
    case "append_a":
      mutated = `${original}${pair.a}`;
      break;
    case "append_b":
      mutated = `${original}${pair.b}`;
      break;
    case "nfd_whole":
      mutated = original.normalize("NFD");
      break;
    case "nfkc_whole":
    default:
      mutated = original.normalize("NFKC");
      break;
  }
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, mutated),
    mutation: {
      category: "unicode_normalization",
      detail: `${target.dotted}: ${variant} (${pair.name})${mutated === original ? " — no-op on ASCII" : ""}`,
      path: target.dotted,
      variant: `${variant}:${pair.name}`,
      mustReject: false,
    },
  };
};

const deepNesting: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng);
  if (!target) return null;
  const depth = rng.pick([64, 512, 4096, 32_768]);
  const kind = rng.pick(["array", "object"]);
  let nested: JsonValue = target.entry.value;
  for (let index = 0; index < depth; index += 1) {
    nested = kind === "array" ? [nested] : { n: nested };
  }
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, nested),
    mutation: {
      category: "deep_nesting",
      detail: `${target.dotted}: wrapped in ${depth} nested ${kind}s`,
      path: target.dotted,
      variant: `${kind}:${depth}`,
      mustReject: false,
    },
  };
};

const topLevelShape: Mutator = (_payload, rng) => {
  const choice = rng.pick([
    { name: "undefined", value: undefined as unknown },
    { name: "null", value: null },
    { name: "empty_object", value: {} },
    { name: "empty_array", value: [] },
    { name: "array_wrapping_valid", value: "WRAP" },
    { name: "string", value: "{}" },
    { name: "number", value: 42 },
    { name: "NaN", value: Number.NaN },
    { name: "true", value: true },
    { name: "function", value: () => undefined },
    { name: "symbol", value: Symbol("stress") },
    { name: "bigint", value: BigInt(1) },
    { name: "Date", value: new Date(0) },
    { name: "Map", value: new Map() },
    { name: "null_prototype_object", value: Object.create(null) as object },
    { name: "frozen_valid", value: "FREEZE" },
    { name: "proxy_throwing_getter", value: "PROXY" },
    { name: "getter_object", value: "GETTER" },
  ]);
  let value: unknown = choice.value;
  if (choice.value === "WRAP") value = [structuredClone(_payload)];
  if (choice.value === "FREEZE") value = deepFreeze(structuredClone(_payload));
  if (choice.value === "PROXY") {
    value = new Proxy(structuredClone(_payload) as object, {
      get(target, property, receiver) {
        if (property === "schemaVersion" || property === "version") {
          throw new Error("stress: hostile getter");
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }
  if (choice.value === "GETTER") {
    const base = structuredClone(_payload) as Record<string, unknown>;
    let reads = 0;
    Object.defineProperty(base, "schemaVersion", {
      enumerable: true,
      configurable: true,
      get() {
        reads += 1;
        return reads === 1 ? 1 : 999; // TOCTOU: valid on first read, invalid after
      },
    });
    value = base;
  }
  return {
    payload: value,
    mutation: {
      category: "top_level_shape",
      detail: `root replaced with ${choice.name}`,
      path: "$",
      variant: choice.name,
      // Frozen valid input is still valid; a hostile proxy is allowed to
      // surface ITS error (it is the caller's object misbehaving).
      mustReject: !["frozen_valid", "proxy_throwing_getter", "getter_object"].includes(choice.name),
    },
  };
};

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

const duplicateOrReordered: Mutator = (payload, rng) => {
  const target = pickLeaf(
    payload,
    rng,
    (entry) => Array.isArray(entry.value) && entry.value.length > 0,
  );
  if (!target) return null;
  const array = target.entry.value as JsonValue[];
  const variant = rng.pick(["duplicate_first", "reverse", "shuffle", "repeat_x50"]);
  let mutated: JsonValue[];
  switch (variant) {
    case "duplicate_first":
      mutated = [array[0] as JsonValue, ...array];
      break;
    case "reverse":
      mutated = [...array].reverse();
      break;
    case "shuffle":
      mutated = rng.shuffle(array);
      break;
    case "repeat_x50":
    default:
      mutated = Array.from({ length: 50 }, () => structuredClone(array)).flat();
      break;
  }
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, mutated),
    mutation: {
      category: "duplicate_or_reordered",
      detail: `${target.dotted}: ${variant} (${array.length} → ${mutated.length})`,
      path: target.dotted,
      variant,
      mustReject: false,
    },
  };
};

const sparseArray: Mutator = (payload, rng) => {
  const target = pickLeaf(payload, rng, (entry) => Array.isArray(entry.value));
  if (!target) return null;
  const array = target.entry.value as JsonValue[];
  const variant = rng.pick([
    "hole_at_end",
    "hole_in_middle",
    "length_1e6_holes",
    "undefined_element",
  ]);
  const clone = structuredClone(payload);
  const mutated: unknown[] = [...array];
  switch (variant) {
    case "hole_at_end":
      mutated.length = array.length + 3;
      break;
    case "hole_in_middle":
      mutated.splice(Math.floor(array.length / 2), 0);
      delete mutated[Math.floor(array.length / 2)];
      break;
    case "length_1e6_holes":
      mutated.length = 1_000_000;
      break;
    case "undefined_element":
    default:
      mutated.push(undefined);
      break;
  }
  return {
    payload: setAtPath(clone, target.entry.segments, mutated as JsonValue),
    mutation: {
      category: "sparse_array",
      detail: `${target.dotted}: ${variant}`,
      path: target.dotted,
      variant,
      mustReject: false,
    },
  };
};

const dateBoundary: Mutator = (payload, rng, hints) => {
  const target = pickLeaf(
    payload,
    rng,
    (entry, dotted) => typeof entry.value === "string" && matchesAny(dotted, hints.isoDatePaths),
  );
  if (!target) return null;
  const value = rng.pick(DATE_BOUNDARIES);
  const clone = structuredClone(payload);
  return {
    payload: setAtPath(clone, target.entry.segments, value),
    mutation: {
      category: "date_boundary",
      detail: `${target.dotted}: → ${JSON.stringify(value)}`,
      path: target.dotted,
      variant: value,
      // Only the values that Date.parse itself rejects are unconditional.
      mustReject: Number.isNaN(Date.parse(value)),
    },
  };
};

const MUTATORS: Record<MutationCategory, Mutator> = {
  truncated_json: truncatedJson,
  malformed_json_text: malformedJsonText,
  wrong_type: wrongType,
  prototype_pollution: prototypePollution,
  numeric_extreme: numericExtreme,
  null_bytes: nullBytes,
  oversized_string: oversized,
  path_traversal: pathTraversal,
  future_schema: futureSchema,
  empty_container: emptyContainer,
  unicode_normalization: unicodeNormalization,
  deep_nesting: deepNesting,
  top_level_shape: topLevelShape,
  duplicate_or_reordered: duplicateOrReordered,
  sparse_array: sparseArray,
  date_boundary: dateBoundary,
};

function describeValue(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object(${Object.keys(value).length})`;
  if (typeof value === "string") return `string(${value.length})`;
  return `${typeof value}:${String(value)}`;
}

/** Categories after which the payload is no longer a plain JSON tree that
 * further mutators (which structuredClone / JSON.stringify it) can process. */
const TERMINAL_CATEGORIES: ReadonlySet<MutationCategory> = new Set<MutationCategory>([
  "truncated_json",
  "malformed_json_text",
  "top_level_shape",
  "deep_nesting",
  "sparse_array",
  "prototype_pollution",
]);

/**
 * Apply 1–3 mutations from the selected categories. Root-replacing
 * categories (truncated/malformed text, top-level shape) are terminal: once
 * the payload is no longer a JSON tree nothing else can be applied.
 */
export function mutatePayload(
  valid: JsonValue,
  rng: Rng,
  hints: SurfaceShapeHints,
  categories: readonly MutationCategory[] = MUTATION_CATEGORIES,
): MutatedPayload {
  const count = rng.chance(0.7) ? 1 : rng.int(2, 3);
  let payload: unknown = structuredClone(valid);
  const mutations: Mutation[] = [];
  for (let index = 0; index < count; index += 1) {
    if (typeof payload !== "object" || payload === null) break;
    const category = rng.pick(categories);
    const result = MUTATORS[category](payload as JsonValue, rng, hints);
    if (result === null) continue;
    payload = result.payload;
    mutations.push(result.mutation);
    if (TERMINAL_CATEGORIES.has(category)) break;
  }
  if (mutations.length === 0) {
    // Guarantee that every iteration exercises SOMETHING.
    const result = topLevelShape(valid, rng, hints);
    if (result) {
      payload = result.payload;
      mutations.push(result.mutation);
    }
  }
  return { payload, mutations };
}
