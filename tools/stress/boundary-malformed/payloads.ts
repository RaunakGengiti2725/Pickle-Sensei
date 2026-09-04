import { Rng } from "./rng.js";

/**
 * Boundary / malformed-input payload generators.
 *
 * Every payload is expressed as a list of `Mutation`s applied on top of a
 * known-valid base object, so a failing case can be minimized by removing
 * mutations one at a time while the failure signature persists. Generators
 * are pure functions of the `Rng`, which makes every case replayable.
 */

export const CATEGORIES = [
  "malformed-json",
  "wrong-type",
  "proto-pollution",
  "numeric-edge",
  "null-byte",
  "huge-string",
  "path-traversal",
  "future-schema",
  "empty",
  "unicode-normalization",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type PathSegment = string | number;

export type Mutation =
  | { op: "set"; path: PathSegment[]; value: unknown; label: string }
  | { op: "delete"; path: PathSegment[]; label: string }
  /** Applied to the serialized JSON text, after all set/delete mutations. */
  | { op: "text"; label: string; apply: (text: string, rng: Rng) => string; seed: number };

/* ------------------------------------------------------------------------ */
/* Primitive pools                                                           */
/* ------------------------------------------------------------------------ */

/** Values JSON can carry; safe for file-backed and direct-call targets. */
export const WRONG_TYPE_JSON: readonly unknown[] = [
  null,
  true,
  false,
  0,
  1,
  -1,
  "",
  "x",
  "true",
  "null",
  "1",
  [],
  [1],
  [null],
  [[]],
  {},
  { a: 1 },
  { length: 1 },
  "[object Object]",
];

/** Values only reachable through a direct (non-JSON) call. */
export const WRONG_TYPE_EXOTIC: readonly (() => unknown)[] = [
  () => undefined,
  () => Symbol("stress"),
  () => 10n,
  () => new Date(0),
  () => new Date(Number.NaN),
  () => /re/,
  () => new Map(),
  () => new Set([1]),
  () => () => "fn",
  () => Object.create(null),
  () => new Proxy({}, {}),
  () => new Uint8Array(4),
  () => new Error("as-value"),
  () => new String("boxed"),
  () => new Number(1),
];

export const NUMERIC_EDGES: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  -1,
  1.5,
  -1.5,
  0.1 + 0.2,
  2 ** 31,
  2 ** 32,
  2 ** 53,
  2 ** 53 + 1,
  -(2 ** 53) - 1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  1e21,
  1e-7,
  -1e300,
];

/** Raw JSON number tokens that JSON.parse maps to surprising values. */
export const NUMERIC_TEXT_TOKENS: readonly string[] = [
  "1e999",
  "-1e999",
  "-0",
  "1E+2",
  "123456789012345678901234567890",
  "0.1e-400",
  "9007199254740993",
  "-9007199254740993",
  "1.7976931348623157e309",
];

export const PROTO_KEYS = ["__proto__", "constructor", "prototype"] as const;
export const PROTO_VALUES: readonly unknown[] = [
  { polluted: "stress" },
  { prototype: { polluted: "stress" } },
  "stress",
  null,
  [],
];

export const NULL_BYTE_STRINGS: readonly string[] = [
  "\u0000",
  "a\u0000b",
  "\u0000abc",
  "abc\u0000",
  "\u0000".repeat(8),
  "rec-6e06a3157947\u0000.json",
  "hc-000001\u0000",
  "P0\u0000",
  "new\u0000",
];

export const PATH_TRAVERSAL_STRINGS: readonly string[] = [
  "../../../../etc/passwd",
  "..\\..\\..\\windows\\system32\\config\\sam",
  "/etc/passwd",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//etc/passwd",
  "file:///etc/passwd",
  "hc-000001/../hc-000002",
  "..%c0%af..%c0%afetc/passwd",
  "C:\\..\\..\\boot.ini",
  "~/.ssh/id_rsa",
  "//server/share/secret",
  ".",
  "..",
  "./",
  "../",
  "\u2025\u2025/\u2025\u2025/etc/passwd",
  "id\u0000../../etc/passwd",
  "\\\\?\\C:\\Windows",
];

export const FUTURE_SCHEMA_VALUES: readonly unknown[] = [
  2,
  3,
  999,
  "1",
  "2",
  1.0000001,
  -1,
  0,
  "v2",
  null,
  [1],
  { version: 1 },
  "consent-ledger-export-v3",
  "consent-ledger-export-v99",
  "rollout-health-frozen-v2",
  "first-party-intake-v2",
];

export const EMPTY_VALUES: readonly unknown[] = [
  {},
  [],
  "",
  " ",
  "\n",
  "\t",
  [[]],
  [{}],
  { records: [] },
  { records: {} },
  { metrics: [] },
  { timeline: [] },
  { transitions: [] },
  { stageGates: [] },
];

/** Pairs that are canonically equivalent (or visually confusable) but differ by code points. */
export const UNICODE_PAIRS: readonly (readonly [string, string, string])[] = [
  ["nfc-nfd-e-acute", "caf\u00e9", "cafe\u0301"],
  ["nfc-nfd-angstrom", "\u00c5ngstr\u00f6m", "\u212bngstro\u0308m"],
  ["nfkc-ligature-fi", "\ufb01le", "file"],
  ["fullwidth-ascii", "\uff21\uff22\uff23", "ABC"],
  ["turkish-dotted-i", "\u0130stanbul", "i\u0307stanbul"],
  ["cyrillic-latin-a", "p\u0430ddle", "paddle"],
  ["zero-width-space", "pad\u200bdle", "paddle"],
  ["zero-width-joiner", "pad\u200ddle", "paddle"],
  ["rtl-override", "\u202epaddle", "paddle"],
  ["bom-prefix", "\ufeffpaddle", "paddle"],
  ["german-sharp-s", "stra\u00dfe", "strasse"],
  ["hangul-composed-decomposed", "\ud55c", "\u1112\u1161\u11ab"],
  ["combining-ring", "a\u030a", "\u00e5"],
  ["soft-hyphen", "pad\u00addle", "paddle"],
  ["nbsp-space", "hard\u00a0case", "hard case"],
  ["homoglyph-digit", "hc-00000\u0661", "hc-000001"],
];

export function hugeString(rng: Rng): { value: string; label: string } {
  const kind = rng.int(0, 8);
  switch (kind) {
    case 0:
      return { value: "a".repeat(65_536), label: "ascii 65536 bytes (=64KiB)" };
    case 1:
      return { value: "a".repeat(65_535), label: "ascii 65535 bytes (64KiB-1)" };
    case 2:
      return { value: "a".repeat(65_537), label: "ascii 65537 bytes (64KiB+1)" };
    case 3:
      return {
        value: "\u00e9".repeat(32_768),
        label: "2-byte cp x32768: 65536 bytes / 32768 cps / 32768 graphemes",
      };
    case 4:
      return {
        value: "\u{1f600}".repeat(16_384),
        label: "4-byte cp x16384: 65536 bytes / 16384 cps / 32768 utf16 units",
      };
    case 5:
      return {
        value: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}".repeat(2_622),
        label: "ZWJ family x2622: 65550 bytes / 18354 cps / 2622 graphemes",
      };
    case 6:
      return {
        value: `a${"\u0301".repeat(32_768)}`,
        label: "one grapheme with 32768 combining marks: 65537 bytes",
      };
    case 7:
      return { value: "a".repeat(1_048_576), label: "ascii 1 MiB" };
    default:
      return { value: "\u4e2d".repeat(21_846), label: "3-byte cp x21846: 65538 bytes" };
  }
}

/* ------------------------------------------------------------------------ */
/* Value generator by category                                               */
/* ------------------------------------------------------------------------ */

export interface GeneratedValue {
  value: unknown;
  label: string;
}

/**
 * A malformed replacement value for `category`. `jsonOnly` restricts the pool
 * to values JSON can represent (file-backed targets).
 */
export function valueFor(category: Category, rng: Rng, jsonOnly: boolean): GeneratedValue {
  switch (category) {
    case "wrong-type": {
      if (!jsonOnly && rng.chance(0.4)) {
        const make = rng.pick(WRONG_TYPE_EXOTIC);
        const value = make();
        return { value, label: `exotic ${describeValue(value)}` };
      }
      const value = rng.pick(WRONG_TYPE_JSON);
      return { value, label: `json ${describeValue(value)}` };
    }
    case "numeric-edge": {
      const value = rng.pick(NUMERIC_EDGES);
      return { value, label: describeValue(value) };
    }
    case "proto-pollution": {
      const key = rng.pick(PROTO_KEYS);
      const inner = rng.pick(PROTO_VALUES);
      const value = ownKeyObject(key, inner);
      return { value, label: `object with own key ${key}=${describeValue(inner)}` };
    }
    case "null-byte": {
      const value = rng.pick(NULL_BYTE_STRINGS);
      return { value, label: describeValue(value) };
    }
    case "huge-string": {
      const huge = hugeString(rng);
      return { value: huge.value, label: huge.label };
    }
    case "path-traversal": {
      const value = rng.pick(PATH_TRAVERSAL_STRINGS);
      return { value, label: describeValue(value) };
    }
    case "future-schema": {
      const value = rng.pick(FUTURE_SCHEMA_VALUES);
      return { value, label: describeValue(value) };
    }
    case "empty": {
      const value = rng.pick(EMPTY_VALUES);
      return { value, label: describeValue(value) };
    }
    case "unicode-normalization": {
      const pair = rng.pick(UNICODE_PAIRS);
      const value = rng.chance(0.5) ? pair[1] : pair[2];
      return { value, label: `${pair[0]} ${describeValue(value)}` };
    }
    case "malformed-json":
      // Text-level corruption is expressed as a `text` mutation, not a value.
      return { value: "{", label: "unterminated object text" };
  }
}

/** Creates an object carrying `key` as an OWN data property (as JSON.parse does). */
export function ownKeyObject(key: string, value: unknown): Record<string, unknown> {
  const target: Record<string, unknown> = {};
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return target;
}

/* ------------------------------------------------------------------------ */
/* Text corruptions (malformed / truncated JSON)                             */
/* ------------------------------------------------------------------------ */

export const TEXT_CORRUPTIONS: readonly {
  label: string;
  apply: (t: string, rng: Rng) => string;
}[] = [
  { label: "truncate at random offset", apply: (t, rng) => t.slice(0, rng.int(0, t.length - 1)) },
  { label: "truncate to empty", apply: () => "" },
  { label: "truncate to whitespace", apply: () => " \n\t " },
  { label: "drop last byte", apply: (t) => t.slice(0, -1) },
  {
    label: "insert garbage byte",
    apply: (t, rng) => {
      const at = rng.int(0, t.length);
      return `${t.slice(0, at)}${rng.pick(["\u0000", "\u00ff", "#", "'", "\\", "\ud800"])}${t.slice(at)}`;
    },
  },
  { label: "single quotes", apply: (t) => t.replace(/"/g, "'") },
  { label: "trailing comma before close", apply: (t) => t.replace(/([}\]])\s*$/, ",$1") },
  { label: "unbalanced extra close", apply: (t) => `${t}}` },
  { label: "unbalanced extra open", apply: (t) => `{${t}` },
  { label: "BOM prefix", apply: (t) => `\ufeff${t}` },
  { label: "NaN literal", apply: (t) => t.replace(/:\s*-?\d[\d.eE+-]*/, ": NaN") },
  { label: "Infinity literal", apply: (t) => t.replace(/:\s*-?\d[\d.eE+-]*/, ": Infinity") },
  { label: "undefined literal", apply: (t) => t.replace(/:\s*"[^"]*"/, ": undefined") },
  { label: "line comment", apply: (t) => `// stress\n${t}` },
  { label: "block comment", apply: (t) => `/* stress */${t}` },
  { label: "leading zero number", apply: (t) => t.replace(/:\s*(\d)/, ": 0$1") },
  { label: "plus-signed number", apply: (t) => t.replace(/:\s*(\d)/, ": +$1") },
  { label: "hex number", apply: (t) => t.replace(/:\s*-?\d[\d.eE+-]*/, ": 0x10") },
  {
    label: "numeric token edge",
    apply: (t, rng) => t.replace(/:\s*-?\d[\d.eE+-]*/, `: ${rng.pick(NUMERIC_TEXT_TOKENS)}`),
  },
  { label: "duplicate document", apply: (t) => `${t}${t}` },
  { label: "concatenated with null", apply: (t) => `${t}\u0000` },
  { label: "lone surrogate escape", apply: (t) => t.replace(/"([^"]*)"/, '"$1\\ud800"') },
  { label: "invalid escape", apply: (t) => t.replace(/"([^"]*)"/, '"$1\\x41"') },
  { label: "raw control char in string", apply: (t) => t.replace(/"([^"]*)"/, '"$1\u0001"') },
  { label: "deep nesting 100k", apply: () => `${"[".repeat(100_000)}${"]".repeat(100_000)}` },
  { label: "deep nesting 1M unclosed", apply: () => "[".repeat(1_000_000) },
  { label: "top-level scalar", apply: (_t, rng) => rng.pick(["1", "null", '"x"', "true"]) },
  { label: "top-level array wrapper", apply: (t) => `[${t}]` },
  {
    label: "duplicate key last-wins",
    apply: (t) => t.replace(/^\{/, '{"__dup__":1,"__dup__":2,'),
  },
  { label: "proto key text", apply: (t) => t.replace(/^\{/, '{"__proto__":{"polluted":"txt"},') },
];

export function textMutation(rng: Rng): Mutation {
  const corruption = rng.pick(TEXT_CORRUPTIONS);
  return {
    op: "text",
    label: `text: ${corruption.label}`,
    apply: corruption.apply,
    seed: rng.int(0, 0xffff_ffff),
  };
}

/* ------------------------------------------------------------------------ */
/* Mutation planning                                                         */
/* ------------------------------------------------------------------------ */

export type FieldKind = "string" | "number" | "boolean" | "object" | "array" | "enum";

export interface FieldSpec {
  path: PathSegment[];
  kind: FieldKind;
}

export interface PlanOptions {
  /** Restrict replacement values to JSON-representable ones (file-backed targets). */
  jsonOnly: boolean;
  /** Allow text-level (malformed JSON) corruption; only meaningful for file/text targets. */
  allowText: boolean;
  /** Paths that carry a schema/version marker (targeted by `future-schema`). */
  schemaPaths?: PathSegment[][];
  /** Object-valued paths where a polluting own key can be injected (root = []). */
  objectPaths?: PathSegment[][];
}

export interface Plan {
  category: Category;
  mutations: Mutation[];
}

function setMutation(path: PathSegment[], generated: GeneratedValue): Mutation {
  return { op: "set", path, value: generated.value, label: generated.label };
}

function fieldsOfKind(
  fields: readonly FieldSpec[],
  kinds: readonly FieldKind[],
): readonly FieldSpec[] {
  const matching = fields.filter((f) => kinds.includes(f.kind));
  return matching.length > 0 ? matching : fields;
}

/**
 * Plans 1–3 mutations for one iteration. The first mutation defines the
 * reported category; extra mutations (and an occasional field deletion) make
 * combined malformations reachable while minimization keeps repros small.
 */
export function planMutations(rng: Rng, fields: readonly FieldSpec[], options: PlanOptions): Plan {
  const categories = CATEGORIES.filter((c) => options.allowText || c !== "malformed-json");
  const category = rng.pick(categories);
  const extra = (rng.chance(0.35) ? 1 : 0) + (rng.chance(0.15) ? 1 : 0);
  const mutations: Mutation[] = [oneMutation(rng, fields, options, category)];
  for (let i = 0; i < extra; i += 1) {
    mutations.push(oneMutation(rng, fields, options, rng.pick(categories)));
  }
  if (fields.length > 0 && rng.chance(0.12)) {
    const field = rng.pick(fields);
    mutations.push({ op: "delete", path: field.path, label: "delete" });
  }
  return { category, mutations };
}

export function oneMutation(
  rng: Rng,
  fields: readonly FieldSpec[],
  options: PlanOptions,
  category: Category,
): Mutation {
  if (category === "malformed-json") return textMutation(rng);
  if (fields.length === 0) {
    return setMutation([], valueFor(category, rng, options.jsonOnly));
  }
  switch (category) {
    case "proto-pollution": {
      const objectPaths = options.objectPaths ?? [[]];
      if (rng.chance(0.5) && objectPaths.length > 0) {
        const parent = rng.pick(objectPaths);
        const key = rng.pick(PROTO_KEYS);
        const inner = rng.pick(PROTO_VALUES);
        return {
          op: "set",
          path: [...parent, key],
          value: inner,
          label: `own key ${describeValue(inner)}`,
        };
      }
      return setMutation(rng.pick(fields).path, valueFor(category, rng, options.jsonOnly));
    }
    case "future-schema": {
      const schemaPaths = options.schemaPaths ?? [];
      const path =
        schemaPaths.length > 0 && rng.chance(0.8) ? rng.pick(schemaPaths) : rng.pick(fields).path;
      return setMutation(path, valueFor(category, rng, options.jsonOnly));
    }
    case "empty": {
      const targets = rng.chance(0.3)
        ? [[] as PathSegment[], ...(options.objectPaths ?? [])]
        : fields.map((f) => f.path);
      return setMutation(rng.pick(targets), valueFor(category, rng, options.jsonOnly));
    }
    case "numeric-edge":
      return setMutation(
        rng.pick(fieldsOfKind(fields, ["number"])).path,
        valueFor(category, rng, options.jsonOnly),
      );
    case "huge-string":
    case "null-byte":
    case "path-traversal":
    case "unicode-normalization":
      return setMutation(
        rng.pick(fieldsOfKind(fields, ["string", "enum"])).path,
        valueFor(category, rng, options.jsonOnly),
      );
    case "wrong-type":
      return setMutation(rng.pick(fields).path, valueFor(category, rng, options.jsonOnly));
  }
}

/* ------------------------------------------------------------------------ */
/* Mutation application                                                      */
/* ------------------------------------------------------------------------ */

function isObjectLike(value: unknown): value is Record<PathSegment, unknown> {
  return typeof value === "object" && value !== null;
}

export function setAt(root: unknown, path: PathSegment[], value: unknown): unknown {
  if (path.length === 0) return value;
  if (!isObjectLike(root)) return root;
  let cursor: Record<PathSegment, unknown> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (segment === undefined) throw new Error("unreachable");
    const next = cursor[segment];
    if (!isObjectLike(next)) {
      const created: Record<PathSegment, unknown> =
        typeof path[i + 1] === "number" ? ([] as unknown as Record<PathSegment, unknown>) : {};
      cursor[segment] = created;
      cursor = created;
    } else {
      cursor = next;
    }
  }
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("unreachable");
  if (last === "__proto__" || last === "constructor" || last === "prototype") {
    Object.defineProperty(cursor, last, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    cursor[last] = value;
  }
  return root;
}

export function deleteAt(root: unknown, path: PathSegment[]): unknown {
  if (path.length === 0) return undefined;
  if (!isObjectLike(root)) return root;
  let cursor: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    if (segment === undefined) throw new Error("unreachable");
    if (!isObjectLike(cursor)) return root;
    cursor = cursor[segment];
  }
  const last = path[path.length - 1];
  if (last === undefined) throw new Error("unreachable");
  if (isObjectLike(cursor)) {
    if (Array.isArray(cursor) && typeof last === "number") cursor.splice(last, 1);
    else delete cursor[last];
  }
  return root;
}

/** Plain-JSON deep clone; bases are always plain JSON. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface Materialized {
  /** Base with set/delete mutations applied (may hold exotic values). */
  value: unknown;
  /** JSON text of `value` with text mutations applied; null when `value` cannot be stringified. */
  text: string | null;
}

/**
 * Applies `mutations` to a fresh clone of `base`. `set`/`delete` mutate the
 * object; `text` mutations corrupt the serialized JSON afterwards.
 */
export function materialize(base: unknown, mutations: readonly Mutation[]): Materialized {
  let value: unknown = cloneJson(base);
  for (const mutation of mutations) {
    if (mutation.op === "set") value = setAt(value, mutation.path, mutation.value);
    else if (mutation.op === "delete") value = deleteAt(value, mutation.path);
  }
  let text: string | null;
  try {
    const serialized = JSON.stringify(value, (_key, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    text = serialized === undefined ? null : serialized;
  } catch {
    text = null;
  }
  if (text !== null) {
    for (const mutation of mutations) {
      if (mutation.op === "text") {
        // Re-seeded per application so replay of text mutations is exact.
        text = mutation.apply(text, new Rng(mutation.seed));
      }
    }
  }
  return { value, text };
}

/* ------------------------------------------------------------------------ */
/* Descriptions (bounded, JSON-safe)                                         */
/* ------------------------------------------------------------------------ */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function stringMetrics(value: string): {
  utf16: number;
  bytes: number;
  codepoints: number;
  graphemes: number;
} {
  let codepoints = 0;
  for (const _cp of value) codepoints += 1;
  let graphemes = 0;
  for (const _g of segmenter.segment(value)) graphemes += 1;
  return { utf16: value.length, bytes: Buffer.byteLength(value, "utf8"), codepoints, graphemes };
}

/** Short, JSON-safe, deterministic description of any runtime value. */
export function describeValue(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (Object.is(value, -0)) return "-0";
    return String(value);
  }
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "boolean") return String(value);
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return "[function]";
  if (typeof value === "string") {
    if (value.length <= 48) return JSON.stringify(value);
    const m = stringMetrics(value);
    return `<string utf16=${m.utf16} bytes=${m.bytes} cps=${m.codepoints} graphemes=${m.graphemes} head=${JSON.stringify(value.slice(0, 12))}>`;
  }
  if (depth > 2) return "[…]";
  if (Array.isArray(value)) {
    if (value.length > 4) return `[array len=${value.length}]`;
    return `[${value.map((v) => describeValue(v, depth + 1)).join(",")}]`;
  }
  if (value instanceof Date)
    return `Date(${Number.isNaN(value.getTime()) ? "Invalid" : value.toISOString()})`;
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Map) return `Map(size=${value.size})`;
  if (value instanceof Set) return `Set(size=${value.size})`;
  if (value instanceof Error) return `Error(${value.name})`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.byteLength})`;
  if (value instanceof String || value instanceof Number) return `boxed ${String(value.valueOf())}`;
  const proto = Object.getPrototypeOf(value) as object | null;
  const keys = Object.getOwnPropertyNames(value);
  const head = keys
    .slice(0, 6)
    .map((k) => `${k}:${describeValue((value as Record<string, unknown>)[k], depth + 1)}`)
    .join(",");
  const tag = proto === null ? "nullproto " : "";
  return `{${tag}${head}${keys.length > 6 ? ",…" : ""}}`;
}

export function describeMutation(mutation: Mutation): string {
  if (mutation.op === "text") return mutation.label;
  const path = mutation.path.map(String).join(".");
  if (mutation.op === "delete") return `delete ${path}`;
  return `set ${path} = ${mutation.label}`;
}
