import type { Rng } from "./rng.js";

/**
 * Malformed-input vocabulary for the boundary lens. Every generator is a pure
 * function of the RNG so a (scenario, seed) pair replays the exact payload.
 *
 * Only JSON-representable wrong types are produced (null, string, boolean,
 * array, object, number) plus `undefined` (a missing key): the package's real
 * ingress is the pose-sequence sidecar JSON, which cannot carry functions,
 * symbols or BigInts.
 */

export const SPECIAL_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  -1,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 2,
  -Number.MAX_SAFE_INTEGER,
  2 ** 31,
  -(2 ** 31),
  2 ** 53,
  1e-9,
  1 + Number.EPSILON,
  0.1 + 0.2,
];

export const POLLUTION_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
] as const;

export const PATH_TRAVERSAL_STRINGS = [
  "../../../etc/passwd",
  "..\\..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "/etc/passwd\u0000.json",
  "file:///etc/passwd",
  "....//....//etc/shadow",
  "pose.json/../../secrets",
] as const;

/** NFC/NFD/NFKC pairs that compare unequal as strings but render identically. */
export const UNICODE_NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"],
  ["\u00c5", "A\u030a"],
  ["\ufb01", "fi"],
  ["\u2126", "\u03a9"],
  ["\u1e9b\u0323", "\u1e9b\u0323".normalize("NFD")],
  ["normalized_image_top_left", "normalized_image_top_left".normalize("NFD")],
  ["pickle.pose-sequence.v1", "pickle.pose-sequence.v1\u200b"],
];

export const HOSTILE_SHORT_STRINGS = [
  "",
  " ",
  "\u0000",
  "a\u0000b",
  "\ufeff",
  "\u202e",
  "\u200d",
  "\ud800",
  "\udfff",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "-0",
  "1e999",
  "{}",
  "[]",
  "<script>alert(1)</script>",
  "'; DROP TABLE shots; --",
  "${jndi:ldap://x}",
  "%s%s%s%n",
  ...POLLUTION_KEYS,
  ...PATH_TRAVERSAL_STRINGS,
  ...UNICODE_NORMALIZATION_PAIRS.flat(),
];

/** ≥ 64 KiB of ASCII: byte cap == codepoint cap == grapheme cap. */
export function hugeAsciiString(bytes = 64 * 1024 + 17): string {
  return "a".repeat(bytes);
}

/** 64 KiB+ of 2-byte codepoints: byte cap trips, codepoint cap may not. */
export function hugeMultibyteString(codepoints = 40 * 1024): string {
  return "\u00e9".repeat(codepoints);
}

/** ZWJ family emoji: 7 codepoints / 25 bytes per grapheme; grapheme cap ≠ codepoint cap. */
export function hugeGraphemeString(graphemes = 4 * 1024): string {
  return "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}".repeat(graphemes);
}

export function hostileString(r: Rng): string {
  const roll = r.next();
  if (roll < 0.08) return hugeAsciiString();
  if (roll < 0.12) return hugeMultibyteString();
  if (roll < 0.16) return hugeGraphemeString();
  return r.pick(HOSTILE_SHORT_STRINGS);
}

export type JsonLike =
  null | boolean | number | string | JsonLike[] | { [key: string]: JsonLike | undefined };

export function malformedNumber(r: Rng): number {
  const roll = r.next();
  if (roll < 0.6) return r.pick(SPECIAL_NUMBERS);
  if (roll < 0.75) return (r.next() - 0.5) * 10 ** r.int(-30, 30);
  if (roll < 0.9) return r.int(-1_000_000, 1_000_000) + (r.chance(0.5) ? 0.5 : 0);
  return r.next() * 10 ** r.int(300, 308) * (r.chance(0.5) ? -1 : 1);
}

/** Any JSON-representable value of the wrong type (or `undefined` = missing). */
export function wrongTypedValue(r: Rng): JsonLike | undefined {
  return r.pick<JsonLike | undefined>([
    null,
    undefined,
    "",
    "0",
    "1",
    "true",
    true,
    false,
    [],
    {},
    [null],
    [[]],
    { length: 3 },
    { x: 0, y: 0 },
    { __proto__: { polluted: true } } as unknown as JsonLike,
    0,
    -0,
    Number.NaN,
  ]);
}

export function pollutedObject(): JsonLike {
  return JSON.parse(
    '{"__proto__":{"stressPolluted":true},"constructor":{"prototype":{"stressPolluted":true}}}',
  ) as JsonLike;
}

export type MutationOp =
  | "number_special"
  | "wrong_type"
  | "delete_key"
  | "pollution_key"
  | "hostile_string"
  | "empty_array"
  | "empty_object"
  | "truncate_array"
  | "duplicate_array_items"
  | "reverse_array"
  | "shuffle_array"
  | "negate_numbers"
  | "poison_all_numbers";

export const ALL_MUTATIONS: readonly MutationOp[] = [
  "number_special",
  "wrong_type",
  "delete_key",
  "pollution_key",
  "hostile_string",
  "empty_array",
  "empty_object",
  "truncate_array",
  "duplicate_array_items",
  "reverse_array",
  "shuffle_array",
  "negate_numbers",
  "poison_all_numbers",
];

const WHOLE_TREE_OPS: ReadonlySet<MutationOp> = new Set<MutationOp>([
  "negate_numbers",
  "poison_all_numbers",
]);

/**
 * Ops that produce a value the TypeScript signature of the callee forbids
 * (wrong primitive type / missing required key / foreign property). A throw on
 * such input is a type-contract violation by the CALLER, not a defect of the
 * pure typed function — the JSON ingress (`parsePoseSequence`) is where these
 * must be rejected, and the wire scenario asserts exactly that.
 */
export const TYPE_VIOLATING_OPS: ReadonlySet<MutationOp> = new Set<MutationOp>([
  "wrong_type",
  "delete_key",
  "empty_object",
]);

export function violatesStaticTypes(mutations: readonly Mutation[]): boolean {
  return mutations.some((mutation) => TYPE_VIOLATING_OPS.has(mutation.op));
}

interface Site {
  parent: Record<string, unknown> | unknown[];
  key: string | number;
  value: unknown;
  path: string;
}

function collectSites(value: unknown, path: string, sites: Site[], depth: number): void {
  if (depth > 12 || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      sites.push({ parent: value, key: index, value: item, path: `${path}[${index}]` });
      collectSites(item, `${path}[${index}]`, sites, depth + 1);
    });
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    sites.push({ parent: record, key, value: record[key], path: `${path}.${key}` });
    collectSites(record[key], `${path}.${key}`, sites, depth + 1);
  }
}

function setSite(site: Site, next: unknown): void {
  if (Array.isArray(site.parent)) site.parent[site.key as number] = next;
  else site.parent[site.key as string] = next;
}

export interface Mutation {
  op: MutationOp;
  path: string;
  detail: string;
}

/**
 * Applies `count` random structural/value mutations to a deep copy of `value`
 * and reports exactly what changed (for the replay table). Site sampling is
 * capped so 100k-element arrays do not dominate the choice.
 */
export function mutateTree<T>(
  value: T,
  r: Rng,
  options: { count: number; ops?: readonly MutationOp[]; maxSites?: number } = { count: 1 },
): { value: T; mutations: Mutation[] } {
  const copy = deepCopy(value);
  const ops = options.ops ?? ALL_MUTATIONS;
  const mutations: Mutation[] = [];
  for (let step = 0; step < options.count; step += 1) {
    const sites: Site[] = [];
    collectSites(copy, "$", sites, 0);
    if (sites.length === 0) break;
    const sampled =
      sites.length > (options.maxSites ?? 600)
        ? Array.from({ length: options.maxSites ?? 600 }, () => r.pick(sites))
        : sites;
    const op = r.pick(ops);
    // Whole-tree ops must see every site, otherwise "all numbers" is a lie.
    const applied = applyMutation(op, WHOLE_TREE_OPS.has(op) ? sites : sampled, r);
    if (applied) mutations.push(applied);
  }
  return { value: copy, mutations };
}

function applyMutation(op: MutationOp, sites: Site[], r: Rng): Mutation | null {
  const numeric = sites.filter((site) => typeof site.value === "number");
  const strings = sites.filter((site) => typeof site.value === "string");
  const arrays = sites.filter((site) => Array.isArray(site.value));
  const objects = sites.filter(
    (site) => site.value !== null && typeof site.value === "object" && !Array.isArray(site.value),
  );
  const objectSites = sites.filter((site) => !Array.isArray(site.parent));
  switch (op) {
    case "number_special": {
      if (numeric.length === 0) return null;
      const site = r.pick(numeric);
      const next = malformedNumber(r);
      setSite(site, next);
      return { op, path: site.path, detail: describeValue(next) };
    }
    case "wrong_type": {
      const site = r.pick(sites);
      const next = wrongTypedValue(r);
      setSite(site, next);
      return { op, path: site.path, detail: describeValue(next) };
    }
    case "delete_key": {
      if (objectSites.length === 0) return null;
      const site = r.pick(objectSites);
      delete (site.parent as Record<string, unknown>)[site.key as string];
      return { op, path: site.path, detail: "deleted" };
    }
    case "pollution_key": {
      if (objects.length === 0) return null;
      const site = r.pick(objects);
      const key = r.pick(POLLUTION_KEYS);
      const payload = r.chance(0.5) ? { stressPolluted: true } : r.pick(SPECIAL_NUMBERS);
      Object.defineProperty(site.value as object, key, {
        value: payload,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return { op, path: `${site.path}.${key}`, detail: describeValue(payload) };
    }
    case "hostile_string": {
      if (strings.length === 0) return null;
      const site = r.pick(strings);
      const next = hostileString(r);
      setSite(site, next);
      return { op, path: site.path, detail: describeValue(next) };
    }
    case "empty_array": {
      if (arrays.length === 0) return null;
      const site = r.pick(arrays);
      setSite(site, []);
      return { op, path: site.path, detail: "[]" };
    }
    case "empty_object": {
      if (objects.length === 0) return null;
      const site = r.pick(objects);
      setSite(site, {});
      return { op, path: site.path, detail: "{}" };
    }
    case "truncate_array": {
      if (arrays.length === 0) return null;
      const site = r.pick(arrays);
      const items = site.value as unknown[];
      const keep = r.int(0, Math.min(items.length, 5));
      items.length = keep;
      return { op, path: site.path, detail: `length=${keep}` };
    }
    case "duplicate_array_items": {
      if (arrays.length === 0) return null;
      const site = r.pick(arrays);
      const items = site.value as unknown[];
      if (items.length === 0) return null;
      const index = r.int(0, items.length - 1);
      const copies = r.int(1, 3);
      for (let count = 0; count < copies; count += 1)
        items.splice(index, 0, deepCopy(items[index]));
      return { op, path: `${site.path}[${index}]`, detail: `x${copies + 1}` };
    }
    case "reverse_array": {
      if (arrays.length === 0) return null;
      const site = r.pick(arrays);
      (site.value as unknown[]).reverse();
      return { op, path: site.path, detail: "reversed" };
    }
    case "shuffle_array": {
      if (arrays.length === 0) return null;
      const site = r.pick(arrays);
      const items = site.value as unknown[];
      const shuffled = r.shuffle(items);
      items.splice(0, items.length, ...shuffled);
      return { op, path: site.path, detail: "shuffled" };
    }
    case "negate_numbers": {
      if (numeric.length === 0) return null;
      for (const site of numeric) setSite(site, -(site.value as number));
      return { op, path: "$..number", detail: `negated ${numeric.length}` };
    }
    case "poison_all_numbers": {
      if (numeric.length === 0) return null;
      const poison = r.pick([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
      for (const site of numeric) setSite(site, poison);
      return { op, path: "$..number", detail: `all -> ${describeValue(poison)}` };
    }
    default:
      return null;
  }
}

/** Deep copy with every numeric leaf replaced by `poison` (minimized KG repro helper). */
export function poisonNumbers<T>(value: T, poison: number): T {
  const copy = deepCopy(value);
  const sites: Site[] = [];
  collectSites(copy, "$", sites, 0);
  for (const site of sites) if (typeof site.value === "number") setSite(site, poison);
  return copy;
}

export function deepCopy<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => deepCopy(item)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as object)) {
    out[key] = deepCopy((value as Record<string, unknown>)[key]);
  }
  return out as T;
}

export function describeValue(value: unknown): string {
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === 0 && 1 / value < 0) return "-0";
    return String(value);
  }
  if (typeof value === "string") {
    if (value.length > 64) return `string(len=${value.length},bytes=${byteLength(value)})`;
    return JSON.stringify(value);
  }
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (value !== null && typeof value === "object") return `object(${Object.keys(value).length})`;
  return String(value);
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Deterministic serialization that survives NaN/±Infinity/-0/undefined (which
 * JSON.stringify silently rewrites) so determinism and input-mutation checks
 * compare what actually happened.
 */
export function stableStringify(value: unknown, depth = 0): string {
  if (depth > 40) return '"<depth>"';
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "number") return describeValue(value);
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value === "string") {
    return value.length > 256 ? `"<string len=${value.length}>"` : JSON.stringify(value);
  }
  if (typeof value === "boolean") return String(value);
  if (typeof value === "function") return '"<function>"';
  if (typeof value === "symbol") return '"<symbol>"';
  if (Array.isArray(value)) {
    if (value.length > 2000) {
      return `[${value
        .slice(0, 50)
        .map((item) => stableStringify(item, depth + 1))
        .join(",")},"<+${value.length - 50} items>"]`;
    }
    return `[${value.map((item) => stableStringify(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], depth + 1)}`)
    .join(",")}}`;
}

/** Every path in `value` holding NaN or ±Infinity. */
export function nonFinitePaths(
  value: unknown,
  path = "$",
  out: string[] = [],
  depth = 0,
): string[] {
  if (depth > 40) return out;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) out.push(`${path}=${describeValue(value)}`);
    return out;
  }
  if (value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    value.forEach((item, index) => nonFinitePaths(item, `${path}[${index}]`, out, depth + 1));
    return out;
  }
  for (const key of Object.keys(value as object)) {
    nonFinitePaths((value as Record<string, unknown>)[key], `${path}.${key}`, out, depth + 1);
  }
  return out;
}

const GUARDED_PROTOTYPES: ReadonlyArray<readonly [string, object]> = [
  ["Object", Object.prototype],
  ["Array", Array.prototype],
  ["Function", Function.prototype],
  ["Number", Number.prototype],
  ["String", String.prototype],
];

export function prototypeSnapshot(): string {
  return GUARDED_PROTOTYPES.map(
    ([name, proto]) => `${name}:${Reflect.ownKeys(proto).map(String).sort().join(",")}`,
  ).join("|");
}

/** True when some code path wrote onto a shared prototype (pollution). */
export function prototypesPolluted(before: string): string | null {
  const after = prototypeSnapshot();
  if (after !== before) return `prototype key set changed: ${diffSnapshot(before, after)}`;
  const probe = {} as Record<string, unknown>;
  if (probe.stressPolluted !== undefined) return "Object.prototype.stressPolluted is set";
  if (([] as unknown as Record<string, unknown>).stressPolluted !== undefined) {
    return "Array.prototype.stressPolluted is set";
  }
  return null;
}

function diffSnapshot(before: string, after: string): string {
  const a = new Set(before.split(/[|,:]/));
  const b = new Set(after.split(/[|,:]/));
  const added = [...b].filter((key) => !a.has(key));
  const removed = [...a].filter((key) => !b.has(key));
  return `added=[${added.join(",")}] removed=[${removed.join(",")}]`;
}
