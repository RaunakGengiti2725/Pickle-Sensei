import { describeValue, pickPoison, type Poison } from "./poison.js";
import type { Prng } from "./prng.js";

/** A single mutation applied to a base value, described for the result table. */
export interface Mutation {
  kind: string;
  /** JSON-pointer-ish path for object mutations, byte offset for text mutations. */
  at: string;
  detail: string;
}

export interface Mutated<T> {
  value: T;
  mutations: Mutation[];
}

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Deep clone that preserves NaN/±Infinity/-0/undefined (JSON round-trips lose them). */
export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => clone(item)) as unknown as T;
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out as T;
  }
  return value;
}

/** Structural equality with Object.is semantics for primitives (NaN === NaN, -0 !== 0). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Enumerate every assignable path in a JSON-like tree (objects + arrays). */
export function paths(value: unknown, prefix = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      out.push(`${prefix}/${i}`, ...paths(item, `${prefix}/${i}`));
    });
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      out.push(`${prefix}/${key}`, ...paths(value[key], `${prefix}/${key}`));
    }
  }
  return out;
}

function splitPath(path: string): string[] {
  return path.split("/").slice(1);
}

function setAt(root: unknown, path: string, value: unknown): void {
  const segments = splitPath(path);
  const last = segments.pop();
  if (last === undefined) return;
  let cursor: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (isObject(cursor)) cursor = cursor[segment];
    else return;
  }
  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else if (isObject(cursor)) cursor[last] = value;
}

function deleteAt(root: unknown, path: string): void {
  const segments = splitPath(path);
  const last = segments.pop();
  if (last === undefined) return;
  let cursor: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (isObject(cursor)) cursor = cursor[segment];
    else return;
  }
  if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
  else if (isObject(cursor)) delete cursor[last];
}

export type ObjectMutationKind =
  | "set-poison"
  | "delete-key"
  | "add-unknown-key"
  | "proto-key"
  | "replace-root"
  | "duplicate-element"
  | "empty-container";

/**
 * Applies 1–3 seeded structural/type mutations to a deep clone of `base`.
 * `applyLimit` truncates the sequence AFTER the count has been drawn, so the
 * first k mutations of a seed are identical for every limit ≥ k — that is
 * what makes prefix minimization of a failing seed exact.
 * Root replacement is deliberately rare (it yields the least informative
 * rejections) but present because null/array/primitive roots ARE the classic
 * "malformed JSON document" boundary.
 */
export function mutateObject<T>(
  base: T,
  rng: Prng,
  maxMutations = 3,
  applyLimit = Number.POSITIVE_INFINITY,
): Mutated<unknown> {
  let value: unknown = clone(base);
  const mutations: Mutation[] = [];
  const count = Math.min(1 + rng.int(maxMutations), applyLimit);
  for (let i = 0; i < count; i += 1) {
    const allPaths = paths(value);
    const roll = rng.next();
    if (roll < 0.03 || allPaths.length === 0) {
      const poison = pickPoison(rng);
      value = poison.value;
      mutations.push({ kind: "replace-root", at: "", detail: poison.tag });
      break;
    }
    const path = rng.pick(allPaths);
    if (roll < 0.6) {
      const poison = pickPoison(rng);
      setAt(value, path, clone(poison.value));
      mutations.push({ kind: "set-poison", at: path, detail: poison.tag });
    } else if (roll < 0.72) {
      deleteAt(value, path);
      mutations.push({ kind: "delete-key", at: path, detail: "" });
    } else if (roll < 0.8) {
      const poison = pickPoison(rng);
      setAt(value, `${path}/unknown_${rng.int(1000)}`, clone(poison.value));
      mutations.push({ kind: "add-unknown-key", at: path, detail: poison.tag });
    } else if (roll < 0.88) {
      const key = rng.pick(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]);
      const target = rng.pick(["/", path]);
      const parent = target === "/" ? value : getAt(value, target);
      if (isObject(parent)) {
        Object.defineProperty(parent, key, {
          value: { polluted: true },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        mutations.push({ kind: "proto-key", at: target, detail: key });
      }
    } else if (roll < 0.94) {
      const target = getAt(value, path);
      const parentPath = path.slice(0, path.lastIndexOf("/"));
      const parent = parentPath === "" ? value : getAt(value, parentPath);
      if (Array.isArray(parent)) {
        parent.push(clone(target));
        mutations.push({ kind: "duplicate-element", at: path, detail: "" });
      } else {
        setAt(value, path, Array.isArray(target) ? [] : isObject(target) ? {} : "");
        mutations.push({ kind: "empty-container", at: path, detail: "" });
      }
    } else {
      const target = getAt(value, path);
      setAt(value, path, Array.isArray(target) ? [] : isObject(target) ? {} : "");
      mutations.push({ kind: "empty-container", at: path, detail: "" });
    }
  }
  return { value, mutations };
}

export function getAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const segment of splitPath(path)) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (isObject(cursor)) cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
}

const NUMERIC_TOKENS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "1e309",
  "-1e309",
  "1e-400",
  "01",
  "0x10",
  ".5",
  "1.",
  "9007199254740993",
  "1.7976931348623157e309",
  "-",
  "+1",
];

const STRING_TOKENS = [
  '"__proto__"',
  '"constructor"',
  '"latest"',
  '""',
  '"\\u0000"',
  '"\\ud800"',
  '"\\x41"',
  '"\\u00zz"',
  '"unterminated',
  '"../../../etc/passwd"',
  `"${"x".repeat(70_000)}"`,
  `"${"\\u00e9".repeat(12_000)}"`,
  '"\u0000raw-null"',
  '"tab\there"',
  '"\n"',
];

const INSERT_CHARS = [
  "{",
  "}",
  "[",
  "]",
  '"',
  ",",
  ":",
  "\\",
  "\u0000",
  "\ufeff",
  "\u2028",
  "'",
  "/",
  "#",
];

export type TextMutationKind =
  | "truncate"
  | "delete-char"
  | "insert-char"
  | "swap-number"
  | "swap-string"
  | "inject-proto"
  | "inject-ctor"
  | "duplicate-key"
  | "prefix-bom"
  | "trailing-garbage"
  | "comment"
  | "single-quotes"
  | "trailing-comma"
  | "deep-nest"
  | "whitespace-flood"
  | "future-schema"
  | "root-swap";

/** Seeded byte/token-level mutations of a JSON document. */
export function mutateJsonText(
  base: string,
  rng: Prng,
  maxMutations = 2,
  applyLimit = Number.POSITIVE_INFINITY,
): Mutated<string> {
  let text = base;
  const mutations: Mutation[] = [];
  const count = Math.min(1 + rng.int(maxMutations), applyLimit);
  for (let i = 0; i < count; i += 1) {
    const roll = rng.next();
    const at = rng.int(Math.max(1, text.length));
    if (roll < 0.14) {
      text = text.slice(0, at);
      mutations.push({ kind: "truncate", at: String(at), detail: "" });
      break;
    } else if (roll < 0.24) {
      text = text.slice(0, at) + text.slice(at + 1);
      mutations.push({ kind: "delete-char", at: String(at), detail: "" });
    } else if (roll < 0.34) {
      const ch = rng.pick(INSERT_CHARS);
      text = text.slice(0, at) + ch + text.slice(at);
      mutations.push({ kind: "insert-char", at: String(at), detail: describeValue(ch) });
    } else if (roll < 0.46) {
      const token = rng.pick(NUMERIC_TOKENS);
      const replaced = replaceNthMatch(text, /(?<=[:,[]\s*)-?\d+(\.\d+)?/g, rng, token);
      if (replaced !== null) {
        text = replaced.text;
        mutations.push({ kind: "swap-number", at: String(replaced.at), detail: token });
      }
    } else if (roll < 0.58) {
      const token = rng.pick(STRING_TOKENS);
      const replaced = replaceNthMatch(text, /(?<=[:,[]\s*)"(?:[^"\\]|\\.)*"/g, rng, token);
      if (replaced !== null) {
        text = replaced.text;
        mutations.push({
          kind: "swap-string",
          at: String(replaced.at),
          detail: token.length > 40 ? `${token.slice(0, 20)}...(len=${token.length})` : token,
        });
      }
    } else if (roll < 0.64) {
      const injected = '"__proto__":{"polluted":true},';
      const brace = nthIndexOf(text, "{", rng);
      text = text.slice(0, brace + 1) + injected + text.slice(brace + 1);
      mutations.push({ kind: "inject-proto", at: String(brace), detail: "" });
    } else if (roll < 0.68) {
      const injected = '"constructor":{"prototype":{"polluted":true}},';
      const brace = nthIndexOf(text, "{", rng);
      text = text.slice(0, brace + 1) + injected + text.slice(brace + 1);
      mutations.push({ kind: "inject-ctor", at: String(brace), detail: "" });
    } else if (roll < 0.73) {
      const key = rng.pick(['"schemaVersion":2,', '"entries":"nope",', '"version":"latest",']);
      const brace = nthIndexOf(text, "{", rng);
      text = text.slice(0, brace + 1) + key + text.slice(brace + 1);
      mutations.push({ kind: "duplicate-key", at: String(brace), detail: key });
    } else if (roll < 0.76) {
      text = `\ufeff${text}`;
      mutations.push({ kind: "prefix-bom", at: "0", detail: "" });
    } else if (roll < 0.8) {
      const garbage = rng.pick(["}", "]", "null", "// c", "\u0000", "{}", "x"]);
      text = `${text}${garbage}`;
      mutations.push({ kind: "trailing-garbage", at: String(text.length), detail: garbage });
    } else if (roll < 0.83) {
      text = text.slice(0, at) + rng.pick(["/* c */", "// c\n"]) + text.slice(at);
      mutations.push({ kind: "comment", at: String(at), detail: "" });
    } else if (roll < 0.86) {
      text = text.replace(/"/g, "'");
      mutations.push({ kind: "single-quotes", at: "*", detail: "" });
    } else if (roll < 0.89) {
      const bracket = text.lastIndexOf("]");
      if (bracket >= 0) {
        text = `${text.slice(0, bracket)},${text.slice(bracket)}`;
        mutations.push({ kind: "trailing-comma", at: String(bracket), detail: "" });
      }
    } else if (roll < 0.92) {
      const depth = rng.pick([1_000, 10_000, 100_000]);
      const nested = `${"[".repeat(depth)}${"]".repeat(depth)}`;
      const replaced = replaceNthMatch(text, /(?<=[:,[]\s*)(?:null|\[\])/g, rng, nested);
      text = replaced === null ? nested : replaced.text;
      mutations.push({ kind: "deep-nest", at: String(replaced?.at ?? 0), detail: String(depth) });
    } else if (roll < 0.95) {
      text = text.slice(0, at) + " ".repeat(70_000) + text.slice(at);
      mutations.push({ kind: "whitespace-flood", at: String(at), detail: "70000" });
    } else if (roll < 0.98) {
      const version = rng.pick([
        '"1"',
        "2",
        "1.0",
        "1.5",
        "-1",
        "999",
        "1e309",
        "true",
        "null",
        "[1]",
      ]);
      text = text.replace(/"schemaVersion":\s*1/, `"schemaVersion":${version}`);
      mutations.push({ kind: "future-schema", at: "schemaVersion", detail: version });
    } else {
      const root = rng.pick(["null", "[]", "{}", '""', "0", "true", "[{}]", '{"entries":[]}']);
      text = root;
      mutations.push({ kind: "root-swap", at: "", detail: root });
      break;
    }
  }
  return { value: text, mutations };
}

function nthIndexOf(text: string, needle: string, rng: Prng): number {
  const indexes: number[] = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) indexes.push(i);
  return indexes.length === 0 ? 0 : rng.pick(indexes);
}

function replaceNthMatch(
  text: string,
  pattern: RegExp,
  rng: Prng,
  replacement: string,
): { text: string; at: number } | null {
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) return null;
  const match = rng.pick(matches);
  const at = match.index;
  return {
    text: text.slice(0, at) + replacement + text.slice(at + match[0].length),
    at,
  };
}

export function describeMutations(mutations: Mutation[]): string {
  return mutations.map((m) => `${m.kind}@${m.at}${m.detail ? `=${m.detail}` : ""}`).join(" | ");
}

export type { Poison };
