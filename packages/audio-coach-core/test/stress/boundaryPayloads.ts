import { CHECKPOINTS, FAULT_DIRECTIONS } from "@pickle/shared-types";
import type {
  CoachState,
  CueRules,
  LiveCheckpointObservation,
  LiveCoachSessionState,
  LiveCueRules,
  LiveRepObservation,
  RepObservation,
} from "../../src/index.js";
import { SeededRng } from "./seededRng.js";

/**
 * Boundary / malformed payload generators for the cue engines.
 *
 * Every generator is a pure function of a SeededRng, so a scenario is fully
 * described by its seed. Generators start from a VALID, in-range observation
 * and then apply one or more mutations drawn from the lens pools below; the
 * mutation kinds applied are recorded so a row in the seed table says what
 * class of input produced the outcome.
 */

export type MutationKind =
  | "numeric-boundary"
  | "wrong-type"
  | "proto-pollution"
  | "string-boundary"
  | "structural"
  | "future-schema"
  | "rules-boundary";

export interface Mutated<T> {
  value: T;
  mutations: MutationKind[];
  /** Short human-readable description of what was mutated. */
  notes: string[];
}

// ─── Value pools ────────────────────────────────────────────────────────────

export const NUMERIC_BOUNDARY: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  1e308,
  -1e308,
  1e21,
  -1e21,
  5e-324,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MIN_SAFE_INTEGER,
  2 ** 53,
  2 ** 31,
  -(2 ** 31),
  -1,
  -0.04,
  0.1 + 0.2,
  10.0000001,
  11,
  100.5,
  101,
  1e-7,
  -1e-7,
];

const LONG_ASCII = "x".repeat(65536);
const LONG_ASCII_PLUS = "y".repeat(70001);
const LONG_EMOJI = "👨‍👩‍👧‍👦".repeat(4096); // 4096 graphemes, 28672 code units
const LONG_BISMILLAH = "﷽".repeat(16384); // 1 codepoint each, wide glyphs

export const STRING_BOUNDARY: readonly string[] = [
  "",
  " ",
  "\u0000",
  "a\u0000b",
  "\u0000".repeat(1024),
  LONG_ASCII,
  LONG_ASCII_PLUS,
  LONG_EMOJI,
  LONG_BISMILLAH,
  "\u00e9", // é NFC
  "e\u0301", // é NFD
  "\uFB01", // ﬁ ligature (NFKC → fi)
  "Å",
  "A\u030A",
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2f",
  "/etc/passwd\u0000.json",
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "\u202Eevil\u202C",
  "\uFEFFcontact_position",
  "contact_position ",
  " contact_position",
  "Contact_Position",
  "contact_position\n",
  "contact-position",
  "contact_position\u0000",
  "𝔠𝔬𝔫𝔱𝔞𝔠𝔱",
  "<script>alert(1)</script>",
  '{"a":1}',
  "[]",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "1e999",
  "7.5",
  "0x10",
  "true",
  "scored",
  "low_confidence",
  "abstained",
  "SCORED",
  "late",
  "none",
  "\uD800", // lone high surrogate
  "\uDC00", // lone low surrogate
  "\uD83D\uDE00", // 😀 as a proper pair
  "\uFFFF",
  "\u{10FFFF}",
];

/** Wrong-type substitutes that JSON can carry (plus undefined, which JSON drops). */
export const WRONG_TYPE: readonly unknown[] = [
  null,
  undefined,
  true,
  false,
  0,
  1,
  -1,
  "7",
  "7.5",
  "scored",
  "",
  [],
  [1, 2, 3],
  [null],
  {},
  { a: 1 },
  { length: 3 },
  { toFixed: 1 },
  { valueOf: 7 },
];

export const PROTO_KEYS: readonly string[] = ["__proto__", "constructor", "prototype"];

export const FUTURE_SCHEMA_EXTRAS: readonly Record<string, unknown>[] = [
  { schemaVersion: 2 },
  { schemaVersion: "99.0.0" },
  { version: 2, migratedFrom: 1 },
  { $schema: "https://example.invalid/live-coach-state/v7" },
  { kind: "scored", extra: { nested: { deeply: [1, 2, 3] } } },
  { checkpointsV2: [{ key: "athletic_base", score: 50 }] },
  { _meta: { producedBy: "future-build", ts: 1e15 } },
  { "": "empty key" },
  { "\u0000": "null-byte key" },
  { ["x".repeat(65536)]: 1 },
];

// ─── Valid base values ──────────────────────────────────────────────────────

export function validCheckpoint(rng: SeededRng): LiveCheckpointObservation {
  return {
    key: rng.pick(CHECKPOINTS),
    score: rng.chance(0.15) ? null : Math.round(rng.float(0, 100)),
    direction: rng.pick(FAULT_DIRECTIONS),
    severity: Math.round(rng.float(0, 1) * 100) / 100,
    applicable: rng.chance(0.85),
  };
}

export function validLiveRep(rng: SeededRng, repIndex: number): LiveRepObservation {
  const kind = rng.pick(["scored", "scored", "scored", "low_confidence", "abstained"] as const);
  const count = rng.int(0, 6);
  const checkpoints: LiveCheckpointObservation[] = [];
  for (let i = 0; i < count; i += 1) checkpoints.push(validCheckpoint(rng));
  return {
    repIndex,
    kind,
    overallScore: kind === "scored" ? Math.round(rng.float(0, 10) * 10) / 10 : null,
    checkpoints,
  };
}

export function validLiveState(rng: SeededRng): LiveCoachSessionState {
  const scores: Record<string, number | null> = {};
  for (const key of CHECKPOINTS) {
    if (rng.chance(0.5)) scores[key] = rng.chance(0.2) ? null : Math.round(rng.float(0, 100));
  }
  const category = rng.pick([
    "CORRECTION",
    "REPEAT_CORRECTION",
    "IMPROVEMENT",
    "PERSONAL_BEST",
    "PRAISE",
    "NO_READ",
    "SETUP_GUIDANCE",
  ] as const);
  return {
    bestOverall: rng.chance(0.3) ? null : Math.round(rng.float(0, 10) * 10) / 10,
    lastSpoken: rng.chance(0.25)
      ? null
      : {
          category,
          checkpoint: rng.chance(0.3) ? null : rng.pick(CHECKPOINTS),
          direction: rng.chance(0.3) ? null : rng.pick(FAULT_DIRECTIONS),
        },
    previousCheckpointScores: scores,
    praiseCounter: rng.int(0, 40),
    noReadCounter: rng.int(0, 40),
    noReadStreak: rng.int(0, 2),
  };
}

export function validLiveRules(rng: SeededRng): LiveCueRules {
  return {
    correctionSeverity: Math.round(rng.float(0.05, 0.9) * 100) / 100,
    improvementDelta: rng.int(1, 30),
    personalBestMinRep: rng.int(1, 6),
    setupGuidanceAfter: rng.int(1, 6),
    announceScores: rng.chance(0.7),
  };
}

export function validRep(rng: SeededRng, repIndex: number): RepObservation {
  const resultKind = rng.pick(["scored", "scored", "scored", "low_confidence"] as const);
  return {
    repIndex,
    resultKind,
    overallScore: resultKind === "scored" ? Math.round(rng.float(0, 10) * 10) / 10 : null,
    focusCheckpoint: rng.pick(CHECKPOINTS),
    focusScore: resultKind === "scored" && rng.chance(0.85) ? Math.round(rng.float(0, 100)) : null,
    focusDirection: rng.pick(FAULT_DIRECTIONS),
    focusSeverity: Math.round(rng.float(0, 1) * 100) / 100,
  };
}

export function validCoachState(rng: SeededRng): CoachState {
  return {
    lastSpokenRepIndex: rng.chance(0.3) ? null : rng.int(0, 50),
    consecutiveCorrections: rng.int(0, 3),
    lastCorrection: rng.chance(0.4)
      ? null
      : { checkpoint: rng.pick(CHECKPOINTS), direction: rng.pick(FAULT_DIRECTIONS) },
    previousFocusScore: rng.chance(0.3) ? null : rng.int(0, 100),
    previousWasCorrection: rng.chance(0.5),
    lowConfidenceStreak: rng.int(0, 3),
    bestOverallScore: rng.chance(0.3) ? null : Math.round(rng.float(0, 10) * 10) / 10,
    lastStableRepIndex: rng.chance(0.5) ? null : rng.int(0, 50),
  };
}

export function validRules(rng: SeededRng): CueRules {
  return {
    correctionSeverity: Math.round(rng.float(0.05, 0.9) * 100) / 100,
    stableSeverity: Math.round(rng.float(0, 0.3) * 100) / 100,
    improvementDelta: rng.int(1, 30),
    maxConsecutiveCorrections: rng.int(1, 4),
    stableCooldownReps: rng.int(1, 8),
    lowConfidenceGuidanceAfter: rng.int(1, 6),
    personalBestMinRep: rng.int(1, 6),
  };
}

// ─── Generic mutation engine ────────────────────────────────────────────────

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Enumerate every leaf path of a plain-object/array tree (own keys only). */
function leafPaths(value: unknown, prefix: string[] = []): string[][] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((item, index) => leafPaths(item, [...prefix, String(index)]));
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [prefix];
    return keys.flatMap((key) => leafPaths(value[key], [...prefix, key]));
  }
  return [prefix];
}

/** Every path (including the root) whose value is an array. */
function arrayPaths(value: unknown, prefix: string[] = []): string[][] {
  if (Array.isArray(value)) {
    return [
      prefix,
      ...value.flatMap((item, index) => arrayPaths(item, [...prefix, String(index)])),
    ];
  }
  if (isPlainObject(value)) {
    return Object.keys(value).flatMap((key) => arrayPaths(value[key], [...prefix, key]));
  }
  return [];
}

function setPath(root: unknown, path: string[], replacement: unknown): unknown {
  if (path.length === 0) return replacement;
  const [head, ...rest] = path;
  if (head === undefined) return replacement;
  if (Array.isArray(root)) {
    const copy = [...root];
    copy[Number(head)] = setPath(copy[Number(head)], rest, replacement);
    return copy;
  }
  if (isPlainObject(root)) {
    const copy: PlainObject = { ...root };
    copy[head] = setPath(copy[head], rest, replacement);
    return copy;
  }
  return replacement;
}

function deletePath(root: unknown, path: string[]): unknown {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  if (head === undefined) return root;
  if (Array.isArray(root)) {
    const copy = [...root];
    if (rest.length === 0) copy.splice(Number(head), 1);
    else copy[Number(head)] = deletePath(copy[Number(head)], rest);
    return copy;
  }
  if (isPlainObject(root)) {
    const copy: PlainObject = { ...root };
    if (rest.length === 0) delete copy[head];
    else copy[head] = deletePath(copy[head], rest);
    return copy;
  }
  return root;
}

function getPath(root: unknown, path: string[]): unknown {
  let cursor: unknown = root;
  for (const segment of path) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (isPlainObject(cursor)) cursor = cursor[segment];
    else return undefined;
  }
  return cursor;
}

const NUMERIC_SLOT =
  /score|best|average|index|counter|streak|severity|delta|count|after|reps|rep$/i;

/** A `number | null` slot: a boundary number there is in-type, not a wrong type. */
function isNumericSlot(current: unknown, path: string[]): boolean {
  if (typeof current === "number") return true;
  if (current !== null) return false;
  const leaf = path.at(-1);
  return leaf !== undefined && NUMERIC_SLOT.test(leaf);
}

/**
 * Apply `count` random mutations to a valid value. Mutations are chosen from
 * the lens pools; the kinds applied are returned so outcomes can be bucketed.
 */
export function mutate<T>(rng: SeededRng, base: T, count: number): Mutated<unknown> {
  let value: unknown = base;
  const mutations: MutationKind[] = [];
  const notes: string[] = [];

  for (let i = 0; i < count; i += 1) {
    const paths = leafPaths(value);
    const path = rng.pick(paths);
    const label = path.join(".") || "<root>";
    const current = getPath(value, path);
    const roll = rng.next();

    if (roll < 0.34) {
      const replacement = rng.pick(NUMERIC_BOUNDARY);
      value = setPath(value, path, replacement);
      mutations.push(isNumericSlot(current, path) ? "numeric-boundary" : "wrong-type");
      notes.push(`${label}=${describeNumber(replacement)}`);
    } else if (roll < 0.52) {
      const replacement = rng.pick(WRONG_TYPE);
      value = setPath(value, path, replacement);
      mutations.push("wrong-type");
      notes.push(`${label}=${describeValue(replacement)}`);
    } else if (roll < 0.7) {
      const replacement = rng.pick(STRING_BOUNDARY);
      value = setPath(value, path, replacement);
      mutations.push(typeof current === "string" ? "string-boundary" : "wrong-type");
      notes.push(`${label}=${describeValue(replacement)}`);
    } else if (roll < 0.78) {
      const key = rng.pick(PROTO_KEYS);
      if (isPlainObject(value)) {
        const target = rng.chance(0.5) ? [] : path.slice(0, -1);
        const container = getPath(value, target);
        if (isPlainObject(container)) {
          const payload = rng.chance(0.5) ? { polluted: true } : key;
          value = setPath(value, target, { ...container, [key]: payload });
          mutations.push("proto-pollution");
          notes.push(`${target.join(".") || "<root>"}[${key}]=${describeValue(payload)}`);
          continue;
        }
      }
      value = setPath(value, path, key);
      mutations.push("proto-pollution");
      notes.push(`${label}=${key}`);
    } else if (roll < 0.9) {
      const variant = rng.int(0, 3);
      if (variant === 0) {
        value = deletePath(value, path);
        notes.push(`delete ${label}`);
      } else if (variant === 1 && Array.isArray(current)) {
        value = setPath(value, path, []);
        notes.push(`${label}=[]`);
      } else if (variant === 2 && isPlainObject(current)) {
        value = setPath(value, path, {});
        notes.push(`${label}={}`);
      } else {
        const candidates = arrayPaths(value);
        const arrayPath = candidates.length === 0 ? undefined : rng.pick(candidates);
        if (arrayPath === undefined) {
          value = deletePath(value, path);
          notes.push(`delete ${label}`);
        } else {
          const size = rng.pick([0, 1, 257, 4096, 20000]);
          const filler = rng.pick([null, undefined, 0, "", {}, [], "athletic_base"]);
          value = setPath(value, arrayPath, new Array<unknown>(size).fill(filler));
          notes.push(`${arrayPath.join(".")}=Array(${size}).fill(${describeValue(filler)})`);
        }
      }
      mutations.push("structural");
    } else {
      const extra = rng.pick(FUTURE_SCHEMA_EXTRAS);
      if (isPlainObject(value)) {
        value = { ...value, ...extra };
        notes.push(`extras ${Object.keys(extra).map(shortKey).join(",")}`);
      } else {
        value = setPath(value, path, extra);
        notes.push(`${label}=${describeValue(extra)}`);
      }
      mutations.push("future-schema");
    }
  }

  return { value, mutations, notes };
}

export function mutateRules<T>(rng: SeededRng, base: T): Mutated<unknown> {
  const mutated = mutate(rng, base, rng.int(1, 3));
  return { ...mutated, mutations: ["rules-boundary", ...mutated.mutations] };
}

// ─── Malformed JSON text (hydration boundary) ───────────────────────────────

/** Produce a JSON *string* that a persistence layer might hand back. */
export function malformedJsonText(
  rng: SeededRng,
  validJson: string,
): { text: string; note: string } {
  const variant = rng.int(0, 15);
  switch (variant) {
    case 0: {
      const cut = rng.int(0, Math.max(0, validJson.length - 1));
      return { text: validJson.slice(0, cut), note: `truncated@${cut}` };
    }
    case 1:
      return { text: validJson.replace(/"/g, "'"), note: "single-quotes" };
    case 2:
      return { text: validJson.replace(/}$/, ",}"), note: "trailing-comma" };
    case 3:
      return { text: validJson.replace(/:\s*(-?\d)/, ": NaN"), note: "NaN-literal" };
    case 4:
      return {
        text: `{"__proto__":{"polluted":true},${validJson.slice(1)}`,
        note: "__proto__-key",
      };
    case 5:
      return {
        text: `{"constructor":{"prototype":{"polluted":true}},${validJson.slice(1)}`,
        note: "constructor.prototype",
      };
    case 6:
      return { text: `\uFEFF${validJson}`, note: "BOM-prefix" };
    case 7:
      return { text: validJson.replace(/"/, '"\u0000'), note: "null-byte-in-key" };
    case 8:
      return {
        text: `{"bestOverall":${"9".repeat(400)},${validJson.slice(1)}`,
        note: "400-digit-number",
      };
    case 9:
      return { text: `{"bestOverall":1e999,${validJson.slice(1)}`, note: "1e999" };
    case 10:
      return { text: `{"pad":"${"x".repeat(65536)}",${validJson.slice(1)}`, note: "64KB-string" };
    case 11: {
      const depth = rng.pick([64, 1024, 5000]);
      return {
        text: `{"lastSpoken":${"[".repeat(depth)}${"]".repeat(depth)},${validJson.slice(1)}`,
        note: `nested-depth-${depth}`,
      };
    }
    case 12:
      return { text: `${validJson}${validJson}`, note: "concatenated-twice" };
    case 13:
      return {
        text: rng.pick(["", "null", "[]", "42", '"state"', "true", "{}", "undefined", "NaN"]),
        note: "primitive-root",
      };
    case 14:
      return {
        text: `{"praiseCounter":-0,"noReadCounter":-0,${validJson.slice(1)}`,
        note: "negative-zero",
      };
    default:
      return {
        text: validJson.replace(/"praiseCounter":\d+/, '"praiseCounter":"3"'),
        note: "string-counter",
      };
  }
}

// ─── Descriptions for the seed table ────────────────────────────────────────

export function describeNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (Object.is(value, -0)) return "-0";
  return String(value);
}

function shortKey(key: string): string {
  return key.length > 24 ? `${key.slice(0, 12)}…(${key.length})` : JSON.stringify(key);
}

export function describeValue(value: unknown): string {
  if (typeof value === "number") return describeNumber(value);
  if (typeof value === "string") {
    if (value.length > 24) return `str(len=${value.length},${JSON.stringify(value.slice(0, 8))}…)`;
    return JSON.stringify(value);
  }
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (typeof value === "object") return `{${Object.keys(value).map(shortKey).join(",")}}`;
  return String(value);
}
