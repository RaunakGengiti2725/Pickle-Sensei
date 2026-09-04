// db-rls-matrix / boundary-malformed — seeded hostile-input generator.
//
// Every case is a pure function of (masterSeed, index): the same pair always
// yields the same actor, target, family and payload, so any row of the
// results table can be replayed with STRESS_SEED=<master> STRESS_REPLAY=<index>.
//
// Families (each mutation records whether the payload MUST be refused by the
// database — `mustReject` — or is a boundary-valid input that may be stored):
//   malformed_json    truncated / corrupted JSON text handed to the jsonb RPC
//   wrong_type        scalars swapped for arrays/objects/bools, objects for strings
//   proto_pollution   __proto__ / constructor / prototype keys at every depth
//   numeric_edge      NaN, ±Infinity, -0, 1e400, int32/int53/int64 edges, rounding
//   null_bytes        real NUL in jsonb strings and text parameters
//   long_strings      64 KiB+ / 1 MiB payloads; byte vs codepoint vs grapheme caps
//   path_traversal    ../ %2e%2e uuid/slug/key smuggling, SQL-ish fragments
//   future_schema     unknown versions, unknown enum members, extra schema keys
//   empty_containers  {} [] "" null at every position
//   unicode_norm      NFC/NFD pairs, homoglyphs, bidi/zero-width, lone surrogates
//   dup_keys          duplicate / case-variant JSON keys (jsonb last-wins)
//   deep_nesting      arrays nested 2^6 .. 2^17 deep
//   huge_arrays       thousands of phases / checkpoints in one RPC call
//   timestamp_edge    infinity, out-of-range years, epoch numbers, relative words
//   cross_user        user_id / row ids of the OTHER user
//   grant_sweep       anon / null-sub / malformed-sub against every table + function
//   control_valid     a well-formed write — MUST be accepted (harness self-check)

/** mulberry32 — the same PRNG the __wf__ concurrency harness replays with. */
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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(16).toString(16);
    return out;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(
      20,
      32,
    )}`;
  }
}

/** splitmix-style mix so per-iteration seeds are decorrelated from the index. */
export function caseSeed(masterSeed: number, index: number): number {
  let z = (masterSeed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
  return (z ^ (z >>> 16)) >>> 0;
}

export const ALICE = "00000000-0000-4000-8000-00000000000a";
export const BOB = "00000000-0000-4000-8000-00000000000b";

export interface UserFixture {
  id: string;
  sessionId: string;
  permitId: string; // a live `reserved` permit
  shotId: string; // an existing scored shot
  premium: boolean;
}
export interface Fixture {
  alice: UserFixture;
  bob: UserFixture;
}

export type Actor = "alice" | "bob" | "anon" | "nullsub" | "badsub";
export type Family =
  | "control_valid"
  | "malformed_json"
  | "wrong_type"
  | "proto_pollution"
  | "numeric_edge"
  | "null_bytes"
  | "long_strings"
  | "path_traversal"
  | "future_schema"
  | "empty_containers"
  | "unicode_norm"
  | "dup_keys"
  | "deep_nesting"
  | "huge_arrays"
  | "timestamp_edge"
  | "cross_user"
  | "grant_sweep";

export const FAMILIES: readonly Family[] = [
  "control_valid",
  "malformed_json",
  "wrong_type",
  "proto_pollution",
  "numeric_edge",
  "null_bytes",
  "long_strings",
  "path_traversal",
  "future_schema",
  "empty_containers",
  "unicode_norm",
  "dup_keys",
  "deep_nesting",
  "huge_arrays",
  "timestamp_edge",
  "cross_user",
  "grant_sweep",
];

export type Op =
  | { kind: "rpc_apply"; jsonText: string }
  | { kind: "rpc_reserve"; key: string | null }
  | { kind: "rpc_reserve_pair"; keys: [string, string] }
  | { kind: "rpc_call"; fn: string; argSql: string; params: string[] }
  | { kind: "insert"; table: string; row: Record<string, unknown> }
  | {
      kind: "update";
      table: string;
      set: Record<string, unknown>;
      whereCol: string;
      whereCast: string;
      whereParam: string;
    }
  | { kind: "delete"; table: string; whereCol: string; whereCast: string; whereParam: string }
  | { kind: "select"; table: string; whereCol: string; whereCast: string; whereParam: string };

export interface Case {
  index: number;
  seed: number;
  actor: Actor;
  family: Family;
  target: string;
  /** The payload is NOT a valid client write: any stored row is BROKEN. */
  mustReject: boolean;
  /** Only for control_valid: the RPC / statement must succeed. */
  mustAccept: boolean;
  /** Set when a stored row for the actor is legitimate (boundary-valid). */
  note: string;
  op: Op;
  /** Marker embedded in hostile strings; an RPC error echoing it = hygiene fail. */
  canary: string;
}

// ────────────────────────────── string material ──────────────────────────────

const ASCII = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-";
export function asciiString(prng: Prng, n: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) parts.push(ASCII[prng.int(ASCII.length)]);
  return parts.join("");
}

const EMOJI = ["😀", "🏓", "🎾", "🥒", "🤖", "🧪", "🔥", "💥"]; // 4-byte codepoints
const COMBINING = "\u0301"; // acute accent (one grapheme = 2 codepoints)
const ZWJ_FAMILY = "👨\u200d👩\u200d👧\u200d👦"; // 1 grapheme, 7 codepoints, 25 bytes

export interface CapString {
  value: string;
  codepoints: number;
  bytes: number;
  graphemes: number;
  kind: string;
}

/** Strings at the byte/codepoint/grapheme edges of a `length(col) <= cap` check. */
export function capEdge(prng: Prng, cap: number): CapString {
  const roll = prng.int(10);
  const enc = new TextEncoder();
  const mk = (value: string, graphemes: number, kind: string): CapString => ({
    value,
    codepoints: [...value].length,
    bytes: enc.encode(value).length,
    graphemes,
    kind,
  });
  switch (roll) {
    case 0:
      return mk(asciiString(prng, cap), cap, "ascii=cap");
    case 1:
      return mk(asciiString(prng, cap + 1), cap + 1, "ascii=cap+1");
    case 2: {
      const e = prng.pick(EMOJI);
      return mk(e.repeat(cap), cap, "emoji=cap (bytes=4*cap)");
    }
    case 3: {
      const e = prng.pick(EMOJI);
      return mk(e.repeat(cap + 1), cap + 1, "emoji=cap+1");
    }
    case 4: {
      // cap graphemes, each 2 codepoints → 2*cap codepoints (over the cap)
      return mk(("e" + COMBINING).repeat(cap), cap, "grapheme=cap, codepoints=2*cap");
    }
    case 5: {
      // half the cap in graphemes, exactly cap codepoints (valid)
      return mk(
        ("e" + COMBINING).repeat(Math.floor(cap / 2)),
        Math.floor(cap / 2),
        "grapheme=cap/2, codepoints=cap",
      );
    }
    case 6:
      return mk(
        ZWJ_FAMILY.repeat(Math.ceil(cap / 7) + 1),
        Math.ceil(cap / 7) + 1,
        "zwj graphemes, codepoints>cap",
      );
    case 7:
      return mk(asciiString(prng, 65536 + prng.int(1024)), 0, "ascii 64KiB+");
    case 8:
      return mk("\u00e9".repeat(65536), 65536, "2-byte cps 64Ki (128KiB)");
    default:
      return mk(asciiString(prng, 1 << 20), 1 << 20, "ascii 1MiB");
  }
}

const TRAVERSALS = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//",
  "/etc/passwd%00.png",
  "file:///etc/passwd",
  "..;/admin",
  "' or 1=1 --",
  '"; drop table public.shots; --',
  "${jndi:ldap://x}",
  "{{7*7}}",
  "<script>alert(1)</script>",
  "$where",
  "%s%s%s%n",
  "\\\\?\\C:\\",
];
export function traversal(prng: Prng, base: string): string {
  switch (prng.int(6)) {
    case 0:
      return prng.pick(TRAVERSALS);
    case 1:
      return `${base}/../${prng.uuid()}`;
    case 2:
      return `../${base}`;
    case 3:
      return `${base}%2f..%2f`;
    case 4:
      return `${base};${prng.pick(TRAVERSALS)}`;
    default:
      return `${prng.pick(TRAVERSALS)}${base}`;
  }
}

const NFC_NFD_PAIRS: ReadonlyArray<[string, string]> = [
  ["caf\u00e9", "cafe\u0301"],
  ["\u00c5ngstr\u00f6m", "A\u030angstro\u0308m"],
  ["\uac00", "\u1100\u1161"], // Hangul syllable vs jamo
  ["\u1e69", "s\u0323\u0307"],
  ["\ufb01", "fi"], // ligature (NFKC only)
  ["\u2126", "\u03a9"], // Ohm sign vs Omega (NFC)
  ["\u212b", "\u00c5"], // Angstrom sign vs Å
];
export function normPair(prng: Prng): [string, string] {
  return prng.pick(NFC_NFD_PAIRS);
}
const UNICODE_ODDITIES = [
  "\u202eevil\u202c", // RTL override
  "a\u200bb\u200cc\u200dd", // zero-width
  "\ufeffbom",
  "\u0130stanbul",
  "ﬃ",
  "Ｄink", // fullwidth
  "dink\u0000", // NUL (belongs to null_bytes too)
  "\ud83c\udff3\ufe0f\u200d\ud83c\udf08", // flag with ZWJ
  "\u0000",
  "\u2028\u2029",
  "\u00ad", // soft hyphen
  "ǅ", // titlecase digraph
];
export function unicodeOddity(prng: Prng): string {
  return prng.pick(UNICODE_ODDITIES);
}

// ─────────────────────────────── shot payloads ───────────────────────────────

export interface ShotBase {
  id: string;
  analysisPermitId: string;
  sessionId: string | null;
  shotType: string;
  cameraView: "side" | "rear_oblique";
  capturedAt: string;
  startMs: number;
  contactMs: number;
  endMs: number;
  overallScore: number | null;
  confidence: number;
  resultKind: "scored" | "low_confidence";
  phases: Array<Record<string, unknown>>;
  checkpoints: Array<Record<string, unknown>>;
  versionVector: Record<string, string>;
}

export function validShot(prng: Prng, u: UserFixture, canary: string): ShotBase {
  const scored = prng.bool(0.7);
  return {
    id: prng.uuid(),
    analysisPermitId: u.permitId,
    sessionId: prng.bool(0.7) ? u.sessionId : null,
    shotType: prng.pick(["dink", "drive", "serve", "third_shot_drop", "volley"]),
    cameraView: prng.pick(["side", "rear_oblique"] as const),
    capturedAt: `2026-0${1 + prng.int(9)}-1${prng.int(9)}T1${prng.int(9)}:00:00.000Z`,
    startMs: 0,
    contactMs: 300 + prng.int(400),
    endMs: 1000 + prng.int(1000),
    overallScore: scored ? Math.round(prng.next() * 1000) / 100 : null,
    confidence: scored ? 0.6 + Math.round(prng.next() * 3999) / 10000 : 0.1 + prng.int(4) / 10,
    resultKind: scored ? "scored" : "low_confidence",
    phases: [
      { key: "prep", startMs: 0, representativeMs: 100, endMs: 250, confidence: 0.9 },
      { key: "contact", startMs: 250, representativeMs: 300, endMs: 400, confidence: 0.85 },
    ],
    checkpoints: [
      {
        key: "paddle_face",
        score: 71.5,
        confidence: 0.8,
        band: "yellow",
        direction: "open more",
        severity: 0.3,
        applicable: true,
      },
    ],
    versionVector: {
      appVersion: `1.0.${prng.int(9)}-${canary}`,
      modelBundleVersion: "bundle-1",
      poseModelVersion: "pose-1",
      paddleModelVersion: "paddle-1",
      strokeDetectorVersion: "stroke-1",
      phaseModelVersion: "phase-1",
      scoringModelVersion: "score-1",
      shotConfigVersion: "cfg-1",
    },
  };
}

const SHOT_TEXT_FIELDS = [
  "shotType",
  "cameraView",
  "capturedAt",
  "id",
  "analysisPermitId",
  "sessionId",
  "resultKind",
] as const;
const SHOT_NUM_FIELDS = ["startMs", "contactMs", "endMs", "overallScore", "confidence"] as const;
const VV_FIELDS = [
  "appVersion",
  "modelBundleVersion",
  "poseModelVersion",
  "paddleModelVersion",
  "strokeDetectorVersion",
  "phaseModelVersion",
  "scoringModelVersion",
  "shotConfigVersion",
] as const;

interface Mutation {
  json: string;
  mustReject: boolean;
  note: string;
}

/** Raw JSON text with a NaN/Infinity/etc token that JSON.stringify cannot emit. */
function withRawToken(obj: Record<string, unknown>, field: string, token: string): string {
  const marker = `__RAW_${field}__`;
  const copy: Record<string, unknown> = { ...obj, [field]: marker };
  return JSON.stringify(copy).replace(`"${marker}"`, token);
}

interface NumericEdge {
  raw: string; // JSON token
  mustReject: (field: string) => boolean;
  note: string;
}
const INT_FIELDS = new Set(["startMs", "contactMs", "endMs"]);
const SCORE_FIELDS = new Set(["overallScore"]); // numeric, CHECK 0..10
const CONF_FIELDS = new Set(["confidence"]); // numeric, CHECK 0..1
const NUMERIC_EDGES: NumericEdge[] = [
  { raw: "NaN", mustReject: () => true, note: "raw NaN token (invalid JSON)" },
  { raw: "Infinity", mustReject: () => true, note: "raw Infinity token" },
  { raw: "-Infinity", mustReject: () => true, note: "raw -Infinity token" },
  { raw: '"NaN"', mustReject: () => true, note: '"NaN" string → numeric NaN / int fail' },
  { raw: '"Infinity"', mustReject: () => true, note: '"Infinity" string' },
  { raw: '"-Infinity"', mustReject: () => true, note: '"-Infinity" string' },
  { raw: "-0", mustReject: () => false, note: "-0 (valid zero)" },
  { raw: "-0.0", mustReject: () => false, note: "-0.0" },
  { raw: "1e308", mustReject: () => true, note: "1e308 overflow" },
  { raw: "1e400", mustReject: () => true, note: "1e400 (jsonb numeric ok, casts overflow)" },
  { raw: "-1e400", mustReject: () => true, note: "-1e400" },
  {
    raw: "1e-400",
    mustReject: (f) => INT_FIELDS.has(f),
    note: "1e-400 (400-digit decimal text; int refuses, numeric rounds to 0)",
  },
  { raw: "2147483647", mustReject: (f) => !INT_FIELDS.has(f), note: "int32 max" },
  { raw: "2147483648", mustReject: () => true, note: "int32 max + 1" },
  {
    raw: "-2147483648",
    mustReject: (f) => !INT_FIELDS.has(f),
    note: "int32 min (negative ms accepted by schema)",
  },
  { raw: "-2147483649", mustReject: () => true, note: "int32 min - 1" },
  { raw: "9007199254740993", mustReject: () => true, note: "2^53+1" },
  { raw: "-9223372036854775808", mustReject: () => true, note: "int64 min" },
  { raw: "18446744073709551616", mustReject: () => true, note: "2^64" },
  { raw: "99999999999999999999999999999999", mustReject: () => true, note: "32-digit" },
  // score/confidence columns are unconstrained `numeric`: no rounding rescues
  // a value that is out of range by a hair.
  {
    raw: "10.005",
    mustReject: () => true,
    note: "10.005 (just above the 0..10 score range; int refuses decimals)",
  },
  { raw: "10.004", mustReject: () => true, note: "10.004 (just above 10)" },
  {
    raw: "1.00005",
    mustReject: (f) => INT_FIELDS.has(f) || CONF_FIELDS.has(f),
    note: "1.00005 (just above the 0..1 confidence range)",
  },
  { raw: "0.99995", mustReject: (f) => INT_FIELDS.has(f), note: "0.99995 (just inside 0..1)" },
  { raw: "-0.004", mustReject: () => true, note: "-0.004 (just below 0)" },
  { raw: "100", mustReject: (f) => !INT_FIELDS.has(f), note: "100 (out of score/conf range)" },
  { raw: "-1", mustReject: (f) => !INT_FIELDS.has(f), note: "-1" },
  // PostgreSQL 16 int/numeric input accepts hex and digit separators
  {
    raw: '"0x10"',
    mustReject: (f) => !INT_FIELDS.has(f),
    note: '"0x10" hex string (PG16 reads 16; out of score/conf range)',
  },
  {
    raw: '"1_000"',
    mustReject: (f) => !INT_FIELDS.has(f),
    note: '"1_000" separator (PG16 reads 1000; out of score/conf range)',
  },
  {
    raw: '" 12 "',
    mustReject: (f) => !INT_FIELDS.has(f),
    note: '" 12 " padded numeric string (int accepts)',
  },
  { raw: '"12abc"', mustReject: () => true, note: '"12abc"' },
  { raw: '"١٢"', mustReject: () => true, note: "arabic-indic digits" },
  { raw: '"１２"', mustReject: () => true, note: "fullwidth digits" },
  {
    raw: '"1e2"',
    mustReject: (f) => INT_FIELDS.has(f) || CONF_FIELDS.has(f) || SCORE_FIELDS.has(f),
    note: '"1e2" exponent string (int rejects, numeric=100 out of range)',
  },
  { raw: "true", mustReject: () => true, note: "boolean for numeric" },
  { raw: "[1]", mustReject: () => true, note: "array for numeric" },
  { raw: '{"$gt":0}', mustReject: () => true, note: "operator object for numeric" },
  { raw: "0", mustReject: () => false, note: "0" },
  { raw: "01", mustReject: () => true, note: "leading zero (invalid JSON)" },
  { raw: ".5", mustReject: () => true, note: ".5 (invalid JSON)" },
  { raw: "5.", mustReject: () => true, note: "5. (invalid JSON)" },
  { raw: "+5", mustReject: () => true, note: "+5 (invalid JSON)" },
];

/** checkpoint score (numeric, CHECK 0..100): tokens that land inside the range. */
const CP_SCORE_OK = [
  "-0",
  "-0.0",
  "1e-400",
  "10.005",
  "10.004",
  "1.00005",
  "0.99995",
  "100",
  "0",
  '" 12 "',
  '"1e2"',
  '"0x10"',
];

function numericEdgeCase(prng: Prng, base: ShotBase): Mutation {
  const edge = prng.pick(NUMERIC_EDGES);
  const where = prng.int(3);
  if (where === 0) {
    const field = prng.pick(SHOT_NUM_FIELDS);
    const obj = { ...base } as Record<string, unknown>;
    // A scored shot needs a score; keep the payload otherwise valid so the
    // numeric edge is the ONLY reason to refuse.
    let mustReject = edge.mustReject(field);
    if (field === "overallScore" && base.resultKind === "low_confidence") {
      // low_confidence ⇒ overall_score must be null (NOT VALID table invariant)
      mustReject = true;
    }
    return { json: withRawToken(obj, field, edge.raw), mustReject, note: `${field}=${edge.note}` };
  }
  if (where === 1) {
    const field = prng.pick(["startMs", "representativeMs", "endMs", "confidence"]);
    const phases = base.phases.map((p) => ({ ...p }));
    const marker = "__RAW__";
    phases[0][field] = marker;
    const f = field === "confidence" ? "confidence" : "startMs";
    return {
      json: JSON.stringify({ ...base, phases }).replace(`"${marker}"`, edge.raw),
      mustReject: edge.mustReject(f),
      note: `phases[0].${field}=${edge.note}`,
    };
  }
  const field = prng.pick(["score", "confidence", "severity"]);
  const checkpoints = base.checkpoints.map((c) => ({ ...c }));
  const marker = "__RAW__";
  checkpoints[0][field] = marker;
  // score: numeric 0..100 → 100 valid, 10.005 valid; confidence/severity 0..1
  let mustReject: boolean;
  if (field === "score") {
    mustReject = !CP_SCORE_OK.includes(edge.raw);
  } else {
    mustReject = edge.mustReject("confidence");
  }
  return {
    json: JSON.stringify({ ...base, checkpoints }).replace(`"${marker}"`, edge.raw),
    mustReject,
    note: `checkpoints[0].${field}=${edge.note}`,
  };
}

function malformedJsonCase(prng: Prng, base: ShotBase): Mutation {
  const text = JSON.stringify(base);
  const roll = prng.int(14);
  switch (roll) {
    case 0: {
      const cut = 1 + prng.int(text.length - 1);
      return {
        json: text.slice(0, cut),
        mustReject: true,
        note: `truncated at ${cut}/${text.length}`,
      };
    }
    case 1: {
      const at = prng.int(text.length);
      const junk = prng.pick([
        "\\",
        "{",
        "}",
        "[",
        "]",
        ":",
        ",",
        "\u0000",
        '"',
        "'",
        "\n",
        "\u2028",
      ]);
      return {
        json: text.slice(0, at) + junk + text.slice(at),
        mustReject: true,
        note: `junk ${JSON.stringify(junk)} at ${at}`,
      };
    }
    case 2:
      return { json: text.replace(/"/g, "'"), mustReject: true, note: "single quotes" };
    case 3:
      return { json: text.replace(/,"/, ',,"'), mustReject: true, note: "double comma" };
    case 4:
      return { json: text.slice(0, -1) + ",}", mustReject: true, note: "trailing comma" };
    case 5:
      return { json: "\ufeff" + text, mustReject: true, note: "BOM prefix" };
    case 6:
      return { json: text + text, mustReject: true, note: "two concatenated documents" };
    case 7:
      return { json: text.replace(/"id":/, "id:"), mustReject: true, note: "unquoted key" };
    case 8:
      return { json: "// c\n" + text, mustReject: true, note: "line comment" };
    case 9:
      return { json: "", mustReject: true, note: "empty string" };
    case 10:
      return {
        json: prng.pick(["null", "true", "1", '"x"', "[]", "{}"]),
        mustReject: true,
        note: "scalar/empty document",
      };
    case 11:
      return {
        json: text.replace(/"startMs":\d+/, '"startMs":NaN'),
        mustReject: true,
        note: "NaN token",
      };
    case 12:
      return {
        json: text.replace(/"resultKind":"[a-z_]+"/, '"resultKind":"scored\\u0000"'),
        mustReject: true,
        note: "\\u0000 escape in string (jsonb 22P05)",
      };
    default:
      return {
        json: text.replace(/"shotType":"/, '"shotType":"\\ud800'),
        mustReject: true,
        note: "lone high surrogate escape",
      };
  }
}

function wrongTypeCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const replacements: Array<[unknown, string]> = [
    [[1, 2], "array"],
    [{ a: 1 }, "object"],
    [true, "true"],
    [false, "false"],
    [null, "null"],
    [12, "number"],
    ["12", '"12" string'],
    ["true", '"true" string'],
  ];
  const [value, vnote] = prng.pick(replacements);
  const where = prng.int(4);
  if (where === 0) {
    const field = prng.pick([...SHOT_TEXT_FIELDS, ...SHOT_NUM_FIELDS]);
    obj[field] = value;
    let mustReject = true;
    // ->> coerces JSON scalars to text: a numeric string still casts, a
    // number still becomes text for text columns. Those are boundary-valid.
    if ((SHOT_NUM_FIELDS as readonly string[]).includes(field)) {
      if (vnote === '"12" string' || vnote === "number") {
        mustReject = field === "overallScore" || field === "confidence"; // 12 > 10 / > 1
        if (field === "overallScore" && base.resultKind === "low_confidence") mustReject = true;
      }
      if (vnote === "null") {
        // contact_ms nullable; start/end not null; score null ok only for low_confidence
        mustReject = !(
          field === "contactMs" ||
          (field === "overallScore" && base.resultKind === "low_confidence")
        );
      }
    } else if (field === "shotType") {
      // ->> renders every non-null JSON value as text (arrays/objects as their
      // JSON text) — a text column stores it; only null violates NOT NULL.
      mustReject = vnote === "null";
    } else if (field === "sessionId") {
      mustReject = vnote !== "null";
    }
    return { json: JSON.stringify(obj), mustReject, note: `${field} := ${vnote}` };
  }
  if (where === 1) {
    obj.versionVector = value;
    // versionVector must be an object with every key; anything else → nulls → 23502
    return { json: JSON.stringify(obj), mustReject: true, note: `versionVector := ${vnote}` };
  }
  if (where === 2) {
    obj.phases = value;
    // null → coalesce('[]') → valid; object → 22023; scalar → 22023; array of scalars → ->> on scalar
    const mustReject = vnote !== "null";
    return { json: JSON.stringify(obj), mustReject, note: `phases := ${vnote}` };
  }
  obj.checkpoints = value;
  const mustReject = vnote !== "null";
  return { json: JSON.stringify(obj), mustReject, note: `checkpoints := ${vnote}` };
}

const POLLUTERS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
  "__defineGetter__",
  "$where",
  "$gt",
  "constructor.prototype",
  "then",
];
function protoPollutionCase(prng: Prng, base: ShotBase): Mutation {
  const key = prng.pick(POLLUTERS);
  const payload = prng.pick<unknown>([
    { polluted: true },
    { isAdmin: true },
    [],
    "x",
    1,
    null,
    { toString: null },
  ]);
  const where = prng.int(4);
  const obj = { ...base } as Record<string, unknown>;
  if (where === 0) {
    obj[key] = payload;
    return {
      json: JSON.stringify(obj),
      mustReject: false,
      note: `top-level ${key} (must be ignored)`,
    };
  }
  if (where === 1) {
    obj.versionVector = { ...base.versionVector, [key]: payload };
    return { json: JSON.stringify(obj), mustReject: false, note: `versionVector.${key} (ignored)` };
  }
  if (where === 2) {
    obj.phases = base.phases.map((p) => ({ ...p, [key]: payload }));
    return { json: JSON.stringify(obj), mustReject: false, note: `phases[].${key} (ignored)` };
  }
  // the required key itself renamed to a polluter → missing id → 22P02 null?  (shot->>'id' null → null::uuid → v_id null → permit_not_found path)
  delete obj.id;
  obj[key] = base.id;
  return { json: JSON.stringify(obj), mustReject: true, note: `id renamed to ${key}` };
}

function nullByteCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const roll = prng.int(5);
  if (roll === 0) {
    obj.shotType = `dink\u0000${asciiString(prng, 3)}`;
    return {
      json: JSON.stringify(obj),
      mustReject: true,
      note: "NUL inside shotType (JSON \\u0000)",
    };
  }
  if (roll === 1) {
    obj.versionVector = { ...base.versionVector, appVersion: "1.0.0\u0000" };
    return { json: JSON.stringify(obj), mustReject: true, note: "NUL in versionVector.appVersion" };
  }
  if (roll === 2) {
    // NUL in an IGNORED key's value still poisons the whole jsonb cast
    obj.ignored = "\u0000";
    return {
      json: JSON.stringify(obj),
      mustReject: true,
      note: "NUL in ignored key (whole document must fail cast)",
    };
  }
  if (roll === 3) {
    obj.shotType = prng.pick(["dink%00", "dink\\0", "dink\\x00", "dink\\u0000"]);
    return {
      json: JSON.stringify(obj),
      mustReject: false,
      note: `escaped-looking NUL ${JSON.stringify(obj.shotType)} (plain text, valid)`,
    };
  }
  obj.phases = [{ ...base.phases[0], key: "prep\u0000" }];
  return { json: JSON.stringify(obj), mustReject: true, note: "NUL in phases[0].key" };
}

function longStringCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const where = prng.int(4);
  if (where === 0) {
    const s = capEdge(prng, 64);
    obj.shotType = s.value;
    return {
      json: JSON.stringify(obj),
      mustReject: s.codepoints > 64,
      note: `shotType ${s.kind} cps=${s.codepoints} bytes=${s.bytes}`,
    };
  }
  if (where === 1) {
    const field = prng.pick(VV_FIELDS);
    const s = capEdge(prng, 64);
    obj.versionVector = { ...base.versionVector, [field]: s.value };
    return {
      json: JSON.stringify(obj),
      mustReject: s.codepoints > 64,
      note: `versionVector.${field} ${s.kind} cps=${s.codepoints}`,
    };
  }
  if (where === 2) {
    const s = capEdge(prng, 64);
    obj.checkpoints = [{ ...base.checkpoints[0], [prng.pick(["key", "direction"])]: s.value }];
    return {
      json: JSON.stringify(obj),
      mustReject: s.codepoints > 64,
      note: `checkpoint text ${s.kind} cps=${s.codepoints}`,
    };
  }
  const s = capEdge(prng, 64);
  obj.phases = [{ ...base.phases[0], key: s.value }];
  return {
    json: JSON.stringify(obj),
    mustReject: s.codepoints > 64,
    note: `phases[0].key ${s.kind} cps=${s.codepoints}`,
  };
}

function pathTraversalCase(prng: Prng, base: ShotBase, other: UserFixture): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const field = prng.pick(["id", "analysisPermitId", "sessionId", "shotType"] as const);
  if (field === "shotType") {
    const t = traversal(prng, "dink");
    obj.shotType = t;
    return {
      json: JSON.stringify(obj),
      mustReject: [...t].length > 64,
      note: `shotType traversal ${JSON.stringify(t)} (opaque text — stored verbatim, never interpreted)`,
    };
  }
  const baseVal =
    field === "id" ? base.id : field === "analysisPermitId" ? other.permitId : other.sessionId;
  obj[field] = traversal(prng, baseVal);
  return {
    json: JSON.stringify(obj),
    mustReject: true,
    note: `${field} traversal ${JSON.stringify(obj[field])}`,
  };
}

function futureSchemaCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const roll = prng.int(8);
  switch (roll) {
    case 0:
      obj.versionVector = {
        ...base.versionVector,
        appVersion: prng.pick([
          "99.99.99",
          "v3",
          "3.0.0-beta.1+exp.sha.5114f85",
          "∞",
          "2026.09.04",
        ]),
      };
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: `future appVersion ${obj.versionVector && (obj.versionVector as Record<string, string>).appVersion}`,
      };
    case 1:
      obj.schemaVersion = prng.pick([2, 99, "2.0", { major: 9 }]);
      obj.$schema = "https://example.invalid/shot/v9";
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: "extra schemaVersion/$schema keys (ignored)",
      };
    case 2:
      obj.resultKind = prng.pick([
        "scored_v2",
        "SCORED",
        "Scored",
        "abstained",
        "unknown",
        "low-confidence",
      ]);
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: `future resultKind ${obj.resultKind}`,
      };
    case 3:
      obj.cameraView = prng.pick(["front", "overhead", "SIDE", "rear-oblique", "side "]);
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: `future cameraView ${obj.cameraView}`,
      };
    case 4:
      obj.checkpoints = [
        { ...base.checkpoints[0], band: prng.pick(["blue", "GREEN", "amber", ""]) },
      ];
      return { json: JSON.stringify(obj), mustReject: true, note: "future checkpoint band" };
    case 5:
      obj.phases = base.phases.map((p) => ({ ...p, futureField: { nested: [1, 2, 3] } }));
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: "phases[] extra futureField (ignored)",
      };
    case 6:
      obj.versionVector = { ...base.versionVector, futureModelVersion: "9.9.9" };
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: "versionVector extra future key (ignored)",
      };
    default: {
      const vv = { ...base.versionVector } as Record<string, string>;
      delete vv[prng.pick(VV_FIELDS)];
      obj.versionVector = vv;
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: "versionVector missing one required key (23502)",
      };
    }
  }
}

function emptyContainersCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const roll = prng.int(10);
  switch (roll) {
    case 0:
      return { json: "{}", mustReject: true, note: "shot = {}" };
    case 1:
      return { json: "[]", mustReject: true, note: "shot = []" };
    case 2:
      obj.versionVector = {};
      return { json: JSON.stringify(obj), mustReject: true, note: "versionVector = {}" };
    case 3:
      obj.phases = [];
      obj.checkpoints = [];
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: "phases=[] checkpoints=[] (valid)",
      };
    case 4:
      obj.phases = [{}];
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: "phases=[{}] (null key → 23502)",
      };
    case 5:
      obj.checkpoints = [[]];
      return { json: JSON.stringify(obj), mustReject: true, note: "checkpoints=[[]]" };
    case 6:
      obj.id = "";
      return { json: JSON.stringify(obj), mustReject: true, note: 'id = ""' };
    case 7:
      obj.sessionId = "";
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: 'sessionId = "" (nullif → null, valid)',
      };
    case 8:
      obj.shotType = "";
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: 'shotType = "" (schema allows empty; edge does not)',
      };
    default:
      obj.phases = {};
      return { json: JSON.stringify(obj), mustReject: true, note: "phases = {} (object, 22023)" };
  }
}

function unicodeNormCase(prng: Prng, base: ShotBase): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const roll = prng.int(5);
  if (roll === 0) {
    const [nfc, nfd] = normPair(prng);
    obj.shotType = prng.bool() ? nfc : nfd;
    return {
      json: JSON.stringify(obj),
      mustReject: false,
      note: `shotType normalization form ${JSON.stringify(obj.shotType)} (stored verbatim)`,
    };
  }
  if (roll === 1) {
    // Cyrillic 'а' (U+0430) / fullwidth digit inside a uuid; the fallback
    // fullwidth-maps the first hex digit so the mutation always applies
    const id = /a|1/.test(base.id)
      ? base.id.replace(/a/, "\u0430").replace(/1/, "\uff11")
      : base.id.replace(/[0-9a-f]/, (ch) => String.fromCodePoint(ch.codePointAt(0)! + 0xfee0));
    obj.id = id;
    return { json: JSON.stringify(obj), mustReject: true, note: "homoglyph inside uuid" };
  }
  if (roll === 2) {
    const odd = unicodeOddity(prng);
    obj.shotType = odd;
    return {
      json: JSON.stringify(obj),
      mustReject: odd.includes("\u0000"),
      note: `shotType oddity ${JSON.stringify(odd)}`,
    };
  }
  if (roll === 3) {
    obj.resultKind = prng.pick(["ѕcored", "scored\u200b", "\ufeffscored", "scored\u00ad"]);
    return {
      json: JSON.stringify(obj),
      mustReject: true,
      note: `resultKind homoglyph/zero-width ${JSON.stringify(obj.resultKind)}`,
    };
  }
  obj.versionVector = { ...base.versionVector, appVersion: unicodeOddity(prng) };
  return {
    json: JSON.stringify(obj),
    mustReject: (obj.versionVector as Record<string, string>).appVersion.includes("\u0000"),
    note: "versionVector.appVersion unicode oddity",
  };
}

function dupKeysCase(prng: Prng, base: ShotBase, other: UserFixture): Mutation {
  const text = JSON.stringify(base);
  const roll = prng.int(5);
  switch (roll) {
    case 0:
      // valid id first, hostile id last → jsonb keeps the LAST → reject
      return {
        json: text.replace(/\}$/, `,"id":"../${base.id}"}`),
        mustReject: true,
        note: "duplicate id: valid then traversal (last wins)",
      };
    case 1:
      return {
        json: text.replace(/^\{/, `{"id":"not-a-uuid",`),
        mustReject: false,
        note: "duplicate id: hostile first, valid last (last wins → valid)",
      };
    case 2:
      return {
        json: text.replace(/^\{/, `{"resultKind":"scored","RESULTKIND":"scored",`),
        mustReject: false,
        note: "case-variant duplicate keys (case-sensitive, ignored)",
      };
    case 3:
      return {
        json: text.replace(/^\{/, `{"analysisPermitId":"${other.permitId}",`),
        mustReject: false,
        note: "duplicate analysisPermitId: other user's first, own last",
      };
    default:
      return {
        json: text.slice(0, -1) + `,"analysisPermitId":"${other.permitId}"}`,
        mustReject: true,
        note: "duplicate analysisPermitId: own first, OTHER user's last (must be permit_not_found)",
      };
  }
}

export function nestedArray(depth: number): string {
  return "[".repeat(depth) + "]".repeat(depth);
}
function deepNestingCase(prng: Prng, base: ShotBase): Mutation {
  const depth = prng.pick([64, 512, 4096, 32768, 131072]);
  const where = prng.int(3);
  const text = JSON.stringify(base);
  if (where === 0) {
    return {
      json: text.slice(0, -1) + `,"extra":${nestedArray(depth)}}`,
      mustReject: false,
      note: `ignored key nested ${depth} deep`,
    };
  }
  if (where === 1) {
    return {
      json: text.replace(
        /"phases":\[.*?\],"checkpoints"/,
        `"phases":${nestedArray(depth)},"checkpoints"`,
      ),
      mustReject: true,
      note: `phases nested ${depth} deep (array of arrays → ->> on array)`,
    };
  }
  // ->> renders the array as JSON text (2*depth chars) → length(app_version) > 64
  return {
    json: text.replace(/"appVersion":"[^"]*"/, `"appVersion":${nestedArray(depth)}`),
    mustReject: true,
    note: `versionVector.appVersion := array nested ${depth} deep (text of ${2 * depth} chars > 64)`,
  };
}

function hugeArraysCase(prng: Prng, base: ShotBase): Mutation {
  const n = prng.pick([256, 1024, 2048]);
  const obj = { ...base } as Record<string, unknown>;
  if (prng.bool()) {
    const phases = [];
    for (let i = 0; i < n; i++) {
      phases.push({ key: `p${i}`, startMs: i, representativeMs: i, endMs: i + 1, confidence: 0.5 });
    }
    obj.phases = phases;
    return {
      json: JSON.stringify(obj),
      mustReject: false,
      note: `${n} distinct phases (edge caps 32; schema has no cardinality cap)`,
    };
  }
  const checkpoints = [];
  for (let i = 0; i < n; i++) {
    checkpoints.push({
      key: `c${i}`,
      score: 50,
      confidence: 0.5,
      band: "yellow",
      direction: "x",
      severity: 0.1,
      applicable: true,
    });
  }
  obj.checkpoints = checkpoints;
  return {
    json: JSON.stringify(obj),
    mustReject: false,
    note: `${n} distinct checkpoints (edge caps 64; schema has no cardinality cap)`,
  };
}

const TIMESTAMPS: Array<[string, boolean, string]> = [
  ["infinity", true, "infinity"],
  ["-infinity", true, "-infinity"],
  ["9999-12-31T23:59:59Z", true, "year 9999"],
  ["2100-01-01T00:00:00Z", true, "2100-01-01 (upper bound, exclusive)"],
  ["2099-12-31T23:59:59.999999Z", false, "just under upper bound"],
  ["2000-01-01T00:00:00Z", false, "lower bound inclusive"],
  ["1999-12-31T23:59:59.999Z", true, "just under lower bound"],
  ["0001-01-01T00:00:00Z", true, "year 1"],
  ["1970-01-01T00:00:00Z", true, "epoch"],
  ["1700000000", true, "unix seconds as string"],
  ["now", false, "'now' (postgres accepts)"],
  ["yesterday", false, "'yesterday' (postgres accepts)"],
  ["epoch", true, "'epoch'"],
  ["allballs", true, "'allballs' (time-only word)"],
  ["2026-13-45T00:00:00Z", true, "month 13"],
  ["2026-02-30T00:00:00Z", true, "Feb 30"],
  ["2026-06-15T24:00:00Z", false, "24:00:00 (postgres normalizes to next day)"],
  ["2026-06-15T25:61:61Z", true, "25:61:61"],
  ["2026-06-15 10:00:00+25", true, "tz +25"],
  ["2026-06-15T10:00:00+05:30", false, "tz +05:30"],
  ["", true, "empty string"],
  ["2026-06-15T10:00:00Z\u0000", true, "NUL suffix"],
  ["١٤٤٧-٠١-٠١", true, "arabic-indic date"],
  ["2026-06-15T10:00:00.1234567890123Z", false, "13 fractional digits (truncated to µs)"],
  ["June 15, 2026 10:00 AM", false, "english date"],
  ["15/06/2026", true, "DD/MM/YYYY under DateStyle ISO, MDY"],
  ["06/15/2026", false, "MM/DD/YYYY"],
  ["294277-01-01T00:00:00Z", true, "beyond timestamp range"],
];
/** Inputs postgres' timestamptz parser refuses outright (bounds aside). */
const TS_PARSE_FAILS = [
  "1700000000",
  "allballs",
  "2026-13-45T00:00:00Z",
  "2026-02-30T00:00:00Z",
  "2026-06-15T25:61:61Z",
  "2026-06-15 10:00:00+25",
  "",
  "2026-06-15T10:00:00Z\u0000",
  "١٤٤٧-٠١-٠١",
  "15/06/2026",
  "294277-01-01T00:00:00Z",
];

function timestampEdgeCase(prng: Prng, base: ShotBase): Mutation {
  const [value, mustReject, note] = prng.pick(TIMESTAMPS);
  const obj = { ...base, capturedAt: value } as Record<string, unknown>;
  return { json: JSON.stringify(obj), mustReject, note: `capturedAt ${note}` };
}

function crossUserApplyCase(prng: Prng, base: ShotBase, other: UserFixture): Mutation {
  const obj = { ...base } as Record<string, unknown>;
  const roll = prng.int(4);
  switch (roll) {
    case 0:
      obj.analysisPermitId = other.permitId;
      return { json: JSON.stringify(obj), mustReject: true, note: "other user's live permit" };
    case 1:
      obj.sessionId = other.sessionId;
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: "other user's session id (FK under RLS → permit ok but session invisible)",
      };
    case 2:
      obj.id = other.shotId;
      return {
        json: JSON.stringify(obj),
        mustReject: true,
        note: "replay of OTHER user's existing shot id (PK collision must not be 'accepted')",
      };
    default:
      obj.userId = other.id;
      obj.user_id = other.id;
      return {
        json: JSON.stringify(obj),
        mustReject: false,
        note: "userId/user_id keys naming the other user (ignored; row must land under caller)",
      };
  }
}

// ─────────────────────────── table rows (PostgREST shape) ────────────────────

export const CLIENT_TABLES = [
  "profiles",
  "sessions",
  "shots",
  "shot_phases",
  "shot_measurements",
  "shot_checkpoints",
  "captures",
  "analysis_permits",
  "consent_records",
  "evaluation_trials",
  "analysis_feedback",
  "user_saved_drills",
  "billing_entitlements",
  "player_rank_state",
  "account_deletion_requests",
  "account_deletion_feedback",
  "account_external_credentials",
  "free_rating_ledger",
  "webhook_events",
] as const;
export const VIEWS = ["progress_daily", "practice_days", "player_technique_rating"] as const;
export type Table = (typeof CLIENT_TABLES)[number] | (typeof VIEWS)[number];

/** Tables the edge function inserts into as the user (grant present). */
export const INSERTABLE = new Set<string>([
  "sessions",
  "shots",
  "shot_phases",
  "shot_measurements",
  "shot_checkpoints",
  "analysis_permits",
  "consent_records",
  "evaluation_trials",
  "analysis_feedback",
  "user_saved_drills",
  "account_deletion_requests",
  "account_deletion_feedback",
]);

export function validRow(
  prng: Prng,
  table: string,
  u: UserFixture,
  canary: string,
): Record<string, unknown> {
  switch (table) {
    case "sessions":
      return {
        id: prng.uuid(),
        user_id: u.id,
        kind: prng.pick(["practice", "game"]),
        started_at: "2026-05-01T10:00:00Z",
        notes: `n-${canary}`,
      };
    case "shots":
      // a low_confidence row needs no permit (trigger gate only guards scored)
      return {
        id: prng.uuid(),
        user_id: u.id,
        session_id: u.sessionId,
        shot_type: "dink",
        camera_view: "side",
        captured_at: "2026-05-01T10:00:00Z",
        start_ms: 0,
        contact_ms: 300,
        end_ms: 900,
        overall_score: null,
        analysis_confidence: 0.2,
        result_kind: "low_confidence",
        app_version: `1.0.0-${canary}`,
        model_bundle_version: "b",
        pose_model_version: "p",
        paddle_model_version: "pd",
        stroke_detector_version: "s",
        phase_model_version: "ph",
        scoring_model_version: "sc",
        shot_config_version: "c",
      };
    case "shot_phases":
      return {
        shot_id: u.shotId,
        user_id: u.id,
        phase_key: `k-${canary}`,
        start_ms: 0,
        representative_ms: 1,
        end_ms: 2,
        confidence: 0.5,
      };
    case "shot_measurements":
      return {
        shot_id: u.shotId,
        user_id: u.id,
        metric_key: `m-${canary}`,
        value: 1.5,
        confidence: 0.5,
        unit: "ms",
      };
    case "shot_checkpoints":
      return {
        shot_id: u.shotId,
        user_id: u.id,
        checkpoint_key: `c-${canary}`,
        score: 50,
        confidence: 0.5,
        band: "green",
        direction: "x",
        severity: 0.1,
        applicable: true,
      };
    case "analysis_permits":
      return { user_id: u.id, idempotency_key: `k-${canary}`, status: "reserved" };
    case "consent_records":
      return {
        user_id: u.id,
        scope: "video",
        consent_version: "1",
        action: "grant",
        source: "app",
        device: { model: canary },
      };
    case "evaluation_trials":
      return { id: prng.uuid(), user_id: u.id, payload: { trial: canary } };
    case "analysis_feedback":
      return {
        user_id: u.id,
        analysis_id: prng.uuid(),
        rating: "up",
        category: canary.slice(0, 40),
      };
    case "user_saved_drills":
      return { user_id: u.id, slug: `drill-${canary}` };
    case "account_deletion_requests":
      return { user_id: u.id };
    case "account_deletion_feedback":
      return { user_id: u.id, reason: "other", details: canary, platform: "ios" };
    case "captures":
      return {
        id: prng.uuid(),
        user_id: u.id,
        captured_at: "2026-05-01T10:00:00Z",
        duration_ms: 1000,
        fps: 30,
        capture_mode: "imported_video",
        evidence_status: "valid",
      };
    case "profiles":
      return { id: u.id, provider: "google", skill_level: canary };
    case "billing_entitlements":
      return { user_id: u.id, premium: true };
    case "player_rank_state":
      return { user_id: u.id, rating: 5, tier: "silver", technique_count: 1, scored_shot_count: 1 };
    case "account_external_credentials":
      return { user_id: u.id };
    case "free_rating_ledger":
      return { identity_hash: "0".repeat(64), scored_count: 0 };
    case "webhook_events":
      return { id: canary, payload: {} };
    default:
      return { user_id: u.id };
  }
}

/** Text columns with a `length(col) <= cap` check, per insertable table. */
export const TEXT_CAPS: Record<string, Record<string, number>> = {
  sessions: { notes: 4000 },
  shots: {
    shot_type: 64,
    declared_stroke: 64,
    guidance: 2000,
    priority_fix_checkpoint: 100,
    priority_fix_reason: 1000,
    app_version: 64,
  },
  shot_phases: { phase_key: 64 },
  shot_measurements: { metric_key: 64 },
  shot_checkpoints: { checkpoint_key: 64, direction: 64 },
  analysis_permits: { idempotency_key: 128, outcome: 50 },
  consent_records: { scope: 50, consent_version: 50, source: 100, capture_mode: 50 },
  analysis_feedback: { rating: 50, category: 50 },
  account_deletion_feedback: {
    reason: 50,
    details: 1000,
    provider: 50,
    platform: 20,
    app_version: 64,
    wanted: 50,
  },
  profiles: {
    skill_level: 100,
    focus_checkpoint: 100,
    primary_goal: 200,
    biggest_problem: 500,
    first_name: 80,
  },
};
export const ENUM_COLS: Record<string, Record<string, string[]>> = {
  sessions: { kind: ["practice", "game"] },
  shots: {
    camera_view: ["side", "rear_oblique"],
    result_kind: ["scored", "low_confidence"],
    handedness: ["right", "left"],
    source: ["real"],
  },
  shot_measurements: { unit: ["normalized", "ratio", "degrees", "ms", "count"] },
  shot_checkpoints: { band: ["green", "yellow", "red", "unscored"] },
  analysis_permits: { status: ["reserved", "finalized", "released"] },
  consent_records: { action: ["grant", "withdraw"] },
  profiles: {
    gender: ["female", "male", "nonbinary", "prefer_not_to_say"],
    handedness: ["right", "left"],
    onboarding_state: ["pending", "complete"],
  },
};
export const UUID_COLS: Record<string, string[]> = {
  sessions: ["id", "user_id"],
  shots: ["id", "user_id", "session_id"],
  shot_phases: ["shot_id", "user_id"],
  shot_measurements: ["shot_id", "user_id"],
  shot_checkpoints: ["shot_id", "user_id"],
  analysis_permits: ["id", "user_id"],
  consent_records: ["id", "user_id"],
  evaluation_trials: ["id", "user_id"],
  analysis_feedback: ["id", "user_id", "analysis_id"],
  user_saved_drills: ["user_id"],
  account_deletion_requests: ["user_id", "challenge"],
  account_deletion_feedback: ["id", "user_id"],
};

interface RowMutation {
  row: Record<string, unknown>;
  mustReject: boolean;
  note: string;
}

export function mutateRow(
  prng: Prng,
  family: Family,
  table: string,
  base: Record<string, unknown>,
  other: UserFixture,
  canary: string,
): RowMutation {
  const row = { ...base };
  const caps = TEXT_CAPS[table] ?? {};
  const enums = ENUM_COLS[table] ?? {};
  const uuids = UUID_COLS[table] ?? [];
  const textCols = Object.keys(caps);
  switch (family) {
    case "long_strings": {
      if (textCols.length === 0) return { row, mustReject: false, note: "no capped text column" };
      const col = prng.pick(textCols);
      const s = capEdge(prng, caps[col]);
      row[col] = s.value;
      return {
        row,
        mustReject: s.codepoints > caps[col],
        note: `${col} ${s.kind} cps=${s.codepoints} bytes=${s.bytes} cap=${caps[col]}`,
      };
    }
    case "null_bytes": {
      const col = textCols.length > 0 ? prng.pick(textCols) : "user_id";
      row[col] = `x\u0000${canary}`;
      return { row, mustReject: true, note: `${col} contains NUL` };
    }
    case "path_traversal": {
      if (table === "user_saved_drills") {
        row.slug = traversal(prng, "drill");
        return {
          row,
          mustReject: true,
          note: `slug traversal ${JSON.stringify(row.slug)} (regex must refuse)`,
        };
      }
      const col = prng.pick(
        uuids.length > 0 && prng.bool(0.6) ? uuids : textCols.length > 0 ? textCols : uuids,
      );
      row[col] = traversal(prng, String(base[col] ?? prng.uuid()));
      const isUuid = uuids.includes(col);
      const val = String(row[col]);
      return {
        row,
        mustReject: isUuid || [...val].length > (caps[col] ?? Infinity),
        note: `${col} traversal ${JSON.stringify(val)}${isUuid ? "" : " (opaque text)"}`,
      };
    }
    case "wrong_type": {
      const cols = Object.keys(base);
      const col = prng.pick(cols);
      const [value, vnote] = prng.pick<[unknown, string]>([
        [[1], "array"],
        [{ a: 1 }, "object"],
        [true, "bool"],
        ["12", '"12"'],
        [12, "number"],
        [null, "null"],
      ]);
      row[col] = value;
      // json_populate_record: array/object into a scalar → 22P02/22023; ANY
      // non-null value into a text column is stored as its JSON text.
      let mustReject = true;
      const NON_TEXT = new Set([
        ...uuids,
        "value",
        "confidence",
        "score",
        "severity",
        "start_ms",
        "representative_ms",
        "end_ms",
        "contact_ms",
        "overall_score",
        "analysis_confidence",
        "event_count",
        "account_age_days",
        "scored_count",
        "applicable",
        "premium",
        "payload",
        "device",
        "captured_at",
        "started_at",
        "ended_at",
        "created_at",
        "updated_at",
        "requested_at",
        "expires_at",
        "day",
      ]);
      if (vnote !== "null" && !NON_TEXT.has(col)) {
        const asText = typeof value === "string" ? value : JSON.stringify(value);
        if (enums[col]) mustReject = !enums[col].includes(asText);
        else if (col === "slug") mustReject = !/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/.test(asText);
        else mustReject = false;
      }
      if (vnote === "null")
        mustReject = [
          "user_id",
          "id",
          "shot_id",
          "scope",
          "action",
          "reason",
          "rating",
          "analysis_id",
          "slug",
          "idempotency_key",
          "started_at",
          "kind",
          "phase_key",
          "metric_key",
          "checkpoint_key",
          "value",
          "unit",
          "confidence",
          "band",
          "direction",
          "severity",
          "applicable",
          "start_ms",
          "representative_ms",
          "end_ms",
          "payload",
          "shot_type",
          "captured_at",
          "analysis_confidence",
          "result_kind",
          "app_version",
          "model_bundle_version",
          "pose_model_version",
          "paddle_model_version",
          "stroke_detector_version",
          "phase_model_version",
          "scoring_model_version",
          "shot_config_version",
        ].includes(col);
      if (
        vnote === "number" &&
        [
          "value",
          "confidence",
          "score",
          "severity",
          "start_ms",
          "representative_ms",
          "end_ms",
          "contact_ms",
        ].includes(col)
      )
        mustReject = col === "confidence" || col === "severity"; // 12 > 1
      if (
        vnote === '"12"' &&
        ["value", "start_ms", "representative_ms", "end_ms", "contact_ms", "score"].includes(col)
      )
        mustReject = false;
      // jsonb columns take any non-null JSON value, scalars included
      if (vnote !== "null" && ["payload", "device"].includes(col)) mustReject = false;
      if (vnote === "bool" && ["applicable", "premium"].includes(col)) mustReject = false;
      if (vnote === "bool" && enums[col]) mustReject = true;
      if (vnote === "number" && enums[col]) mustReject = true;
      if (vnote === '"12"' && enums[col]) mustReject = true;
      return { row, mustReject, note: `${col} := ${vnote}` };
    }
    case "proto_pollution": {
      const key = prng.pick(POLLUTERS);
      row[key] = { polluted: true };
      // PostgREST: unknown column → PGRST204 (400). json_populate_record ignores
      // it but the column list references it → 42703.
      return {
        row,
        mustReject: true,
        note: `unknown column ${key} (must be 42703 / PGRST204, never stored)`,
      };
    }
    case "numeric_edge": {
      const numCols: Record<string, string[]> = {
        sessions: ["event_count"],
        shots: ["start_ms", "contact_ms", "end_ms", "overall_score", "analysis_confidence"],
        shot_phases: ["start_ms", "representative_ms", "end_ms", "confidence"],
        shot_measurements: ["value", "confidence"],
        shot_checkpoints: ["score", "confidence", "severity"],
        account_deletion_feedback: ["account_age_days", "scored_count"],
      };
      const cols = numCols[table];
      if (!cols) return { row, mustReject: false, note: "no numeric column" };
      const col = prng.pick(cols);
      const edge = prng.pick(NUMERIC_EDGES);
      const marker = `__RAW_${col}__`;
      row[col] = marker;
      // resolved by the executor: the marker is replaced in the JSON text
      row.__rawToken__ = edge.raw;
      row.__rawCol__ = col;
      const isInt = [
        "event_count",
        "start_ms",
        "contact_ms",
        "end_ms",
        "representative_ms",
        "account_age_days",
        "scored_count",
      ].includes(col);
      const isDouble = col === "value";
      const isConf = ["confidence", "severity", "analysis_confidence"].includes(col);
      const isScore = col === "overall_score";
      const isCpScore = col === "score";
      const nonNeg = ["event_count", "account_age_days", "scored_count"].includes(col);
      let mustReject: boolean;
      if (isDouble) {
        // double precision has no range check; huge magnitudes are fine, but a
        // NaN / ±Infinity measurement is not a value the app ever produces and
        // must not be stored (float8 input would otherwise accept the words).
        mustReject = [
          "NaN",
          "Infinity",
          "-Infinity",
          '"NaN"',
          '"Infinity"',
          '"-Infinity"',
          "true",
          "[1]",
          '{"$gt":0}',
          "01",
          ".5",
          "5.",
          "+5",
          '"1_000"',
          '"12abc"',
          '"١٢"',
          '"１２"',
          "1e400",
          "-1e400",
        ].includes(edge.raw);
      } else if (isInt) {
        mustReject = edge.mustReject("startMs");
        if (nonNeg && ["-1", "-2147483648"].includes(edge.raw)) mustReject = true;
        if (table === "shots" && col === "overall_score") mustReject = true;
      } else if (isConf) {
        mustReject = edge.mustReject("confidence");
      } else if (isScore) {
        mustReject = true; // low_confidence row: any non-null score is refused
      } else if (isCpScore) {
        mustReject = !CP_SCORE_OK.includes(edge.raw);
      } else {
        mustReject = true;
      }
      return { row, mustReject, note: `${col}=${edge.note}` };
    }
    case "future_schema": {
      const enumCols = Object.keys(enums);
      if (enumCols.length > 0 && prng.bool(0.7)) {
        const col = prng.pick(enumCols);
        row[col] = prng.pick([`${enums[col][0]}_v2`, enums[col][0].toUpperCase(), "future", ""]);
        return {
          row,
          mustReject: true,
          note: `${col} future enum member ${JSON.stringify(row[col])}`,
        };
      }
      row.schema_version = 99;
      return { row, mustReject: true, note: "unknown column schema_version (42703 / PGRST204)" };
    }
    case "empty_containers": {
      const roll = prng.int(4);
      if (roll === 0)
        return { row: {}, mustReject: true, note: "empty row {} (no user_id → 23502 / RLS 42501)" };
      if (roll === 1 && (table === "consent_records" || table === "evaluation_trials")) {
        row[table === "consent_records" ? "device" : "payload"] = prng.pick([{}, []]);
        return { row, mustReject: false, note: "empty jsonb container (valid)" };
      }
      if (textCols.length > 0) {
        const col = prng.pick(textCols);
        row[col] = "";
        return {
          row,
          mustReject: table === "user_saved_drills",
          note: `${col} = "" (schema allows; slug regex refuses)`,
        };
      }
      row[prng.pick(Object.keys(base).filter((k) => k !== "payload" && k !== "device"))] = [];
      return { row, mustReject: true, note: "scalar column := []" };
    }
    case "unicode_norm": {
      if (table === "user_saved_drills") {
        const [nfc, nfd] = normPair(prng);
        row.slug = prng.bool() ? nfc : nfd;
        return {
          row,
          mustReject: true,
          note: `slug non-ASCII ${JSON.stringify(row.slug)} (regex must refuse)`,
        };
      }
      if (textCols.length === 0) return { row, mustReject: false, note: "no text column" };
      const col = prng.pick(textCols);
      const [nfc, nfd] = normPair(prng);
      const v = prng.bool(0.5) ? (prng.bool() ? nfc : nfd) : unicodeOddity(prng);
      row[col] = v;
      return {
        row,
        mustReject: v.includes("\u0000"),
        note: `${col} ${JSON.stringify(v)} (stored verbatim)`,
      };
    }
    case "deep_nesting": {
      const depth = prng.pick([64, 512, 4096, 32768, 131072]);
      const col =
        table === "consent_records" ? "device" : table === "evaluation_trials" ? "payload" : null;
      if (!col) {
        // a uuid column: JSON arrays never cast → 22P02 whatever the depth
        row.__rawToken__ = nestedArray(depth);
        row.__rawCol__ = prng.pick(uuids);
        row[row.__rawCol__ as string] = `__RAW_${row.__rawCol__}__`;
        return { row, mustReject: true, note: `${row.__rawCol__} := array nested ${depth} deep` };
      }
      row.__rawToken__ = nestedArray(depth);
      row.__rawCol__ = col;
      row[col] = `__RAW_${col}__`;
      // jsonb size caps (4096 B device / 256 KiB payload) decide; a stack-depth
      // error (54001 → PostgREST 500) is what this family hunts.
      return {
        row,
        mustReject: false,
        note: `${col} := array nested ${depth} deep (pg_column_size cap decides)`,
      };
    }
    case "timestamp_edge": {
      const tsCols: Record<string, string[]> = {
        sessions: ["started_at", "ended_at"],
        shots: ["captured_at"],
        captures: ["captured_at"],
        consent_records: ["created_at"],
        analysis_permits: ["created_at"],
        user_saved_drills: ["saved_at"],
      };
      const cols = tsCols[table];
      if (!cols) return { row, mustReject: false, note: "no timestamp column" };
      const col = prng.pick(cols);
      const [value, mustRejectBounded, note] = prng.pick(TIMESTAMPS);
      row[col] = value;
      // only shots.captured_at / captures.captured_at have range bounds; the
      // others accept anything postgres parses (infinity included)
      const bounded = col === "captured_at";
      const parseFails = TS_PARSE_FAILS.includes(value);
      return { row, mustReject: bounded ? mustRejectBounded : parseFails, note: `${col} ${note}` };
    }
    case "cross_user": {
      const roll = prng.int(3);
      if (roll === 0) {
        row.user_id = other.id;
        return { row, mustReject: true, note: "user_id = OTHER user (RLS with check → 42501)" };
      }
      if (
        roll === 1 &&
        (table === "shot_phases" || table === "shot_measurements" || table === "shot_checkpoints")
      ) {
        row.shot_id = other.shotId;
        return {
          row,
          mustReject: true,
          note: "shot_id = OTHER user's shot (FK invisible under RLS → 23503)",
        };
      }
      if (table === "shots" || table === "sessions") {
        row.session_id = other.sessionId;
        if (table === "sessions") row.id = other.sessionId;
        return {
          row,
          mustReject: true,
          note:
            table === "shots"
              ? "session_id = OTHER user's session (23503)"
              : "id = OTHER user's session id (23505 PK collision)",
        };
      }
      row.user_id = other.id;
      return { row, mustReject: true, note: "user_id = OTHER user" };
    }
    default:
      return { row, mustReject: false, note: "valid row" };
  }
}

// ──────────────────────────────── case builder ───────────────────────────────

const RESERVE_KEYS: Array<(prng: Prng, canary: string) => [string | null, boolean, string]> = [
  (p, c) => [asciiString(p, 128 - c.length) + c, false, "key = 128 (cap)"],
  (p, c) => [
    asciiString(p, 129 - c.length) + c,
    true,
    "key = 129 (cap+1 → 23514 raised, no typed result)",
  ],
  (p, c) => [asciiString(p, 65536) + c, true, "key 64KiB"],
  (_p, c) => ["\u00e9".repeat(128) + c, true, "128 two-byte cps + canary (> cap)"],
  (_p, _c) => ["\u00e9".repeat(128), false, "128 two-byte cps = 256 bytes (cap is codepoints)"],
  (_p, _c) => [EMOJI[0].repeat(128), false, "128 emoji = 512 bytes"],
  (_p, c) => [`k\u0000${c}`, true, "NUL byte in text parameter (22021)"],
  (_p, _c) => ["", false, "empty key (schema allows; edge refuses)"],
  (_p, _c) => ["   ", false, "whitespace-only key"],
  (_p, _c) => [null, true, "NULL key (23502)"],
  (p, c) => [traversal(p, c), false, "traversal-looking key (opaque, stored verbatim)"],
  (_p, c) => [
    `{"__proto__":{"admin":true},"k":"${c}"}`,
    false,
    "JSON-looking key with __proto__ (opaque text)",
  ],
  (p, c) => {
    const v = unicodeOddity(p) + c;
    return [v, v.includes("\u0000"), `unicode oddity ${JSON.stringify(v.slice(0, 12))}… + canary`];
  },
  (_p, c) => [`k-${c}\u202e`, false, "RTL override suffix"],
];

export function buildCase(index: number, masterSeed: number, fx: Fixture): Case {
  const seed = caseSeed(masterSeed, index);
  const prng = new Prng(seed);
  const canary = `XCANARY${seed.toString(16)}`;
  const actorRoll = prng.next();
  const actor: Actor =
    actorRoll < 0.45
      ? "alice"
      : actorRoll < 0.86
        ? "bob"
        : actorRoll < 0.93
          ? "anon"
          : actorRoll < 0.98
            ? "nullsub"
            : "badsub";
  const me = actor === "bob" ? fx.bob : fx.alice;
  const other = actor === "bob" ? fx.alice : fx.bob;
  const isAuthed = actor === "alice" || actor === "bob";

  const familyRoll = prng.next();
  let family: Family;
  if (!isAuthed) family = "grant_sweep";
  else if (familyRoll < 0.06) family = "control_valid";
  else {
    const pool: Family[] = [
      "malformed_json",
      "wrong_type",
      "proto_pollution",
      "numeric_edge",
      "null_bytes",
      "long_strings",
      "path_traversal",
      "future_schema",
      "empty_containers",
      "unicode_norm",
      "dup_keys",
      "deep_nesting",
      "huge_arrays",
      "timestamp_edge",
      "cross_user",
    ];
    const weights = [9, 10, 6, 12, 6, 9, 8, 7, 7, 8, 4, 3, 2, 6, 6];
    const total = weights.reduce((a, b) => a + b, 0);
    let r = prng.next() * total;
    family = pool[pool.length - 1];
    for (let i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r < 0) {
        family = pool[i];
        break;
      }
    }
  }
  const base = validShot(prng, me, canary);
  const mk = (
    target: string,
    op: Op,
    mustReject: boolean,
    note: string,
    mustAccept = false,
  ): Case => ({
    index,
    seed,
    actor,
    family,
    target,
    mustReject,
    mustAccept,
    note,
    op,
    canary,
  });

  if (family === "grant_sweep") {
    // anon / null-sub / malformed-sub: every table, view and function
    const roll = prng.int(10);
    if (roll < 6) {
      const table = prng.pick([...CLIENT_TABLES, ...VIEWS]);
      const opKind = prng.pick(["select", "insert", "update", "delete"] as const);
      const row = validRow(prng, table, fx.alice, canary);
      if (opKind === "insert")
        return mk(
          `table.${table}.insert`,
          { kind: "insert", table, row },
          true,
          `${actor} insert into ${table}`,
        );
      if (opKind === "update")
        return mk(
          `table.${table}.update`,
          {
            kind: "update",
            table,
            set: Object.fromEntries(Object.entries(row).slice(1, 2)),
            whereCol:
              table === "profiles"
                ? "id"
                : table === "free_rating_ledger"
                  ? "identity_hash"
                  : table === "webhook_events"
                    ? "id"
                    : "user_id",
            whereCast:
              table === "free_rating_ledger" || table === "webhook_events" ? "text" : "uuid",
            whereParam:
              table === "free_rating_ledger"
                ? "0".repeat(64)
                : table === "webhook_events"
                  ? canary
                  : fx.alice.id,
          },
          true,
          `${actor} update ${table}`,
        );
      if (opKind === "delete")
        return mk(
          `table.${table}.delete`,
          {
            kind: "delete",
            table,
            whereCol:
              table === "profiles"
                ? "id"
                : table === "free_rating_ledger"
                  ? "identity_hash"
                  : table === "webhook_events"
                    ? "id"
                    : "user_id",
            whereCast:
              table === "free_rating_ledger" || table === "webhook_events" ? "text" : "uuid",
            whereParam:
              table === "free_rating_ledger"
                ? "0".repeat(64)
                : table === "webhook_events"
                  ? canary
                  : fx.alice.id,
          },
          true,
          `${actor} delete from ${table}`,
        );
      return mk(
        `table.${table}.select`,
        {
          kind: "select",
          table,
          whereCol:
            table === "profiles"
              ? "id"
              : table === "free_rating_ledger"
                ? "identity_hash"
                : table === "webhook_events"
                  ? "id"
                  : "user_id",
          whereCast: table === "free_rating_ledger" || table === "webhook_events" ? "text" : "uuid",
          whereParam:
            table === "free_rating_ledger"
              ? "0".repeat(64)
              : table === "webhook_events"
                ? canary
                : fx.alice.id,
        },
        true,
        `${actor} select from ${table}`,
      );
    }
    if (roll < 8) {
      const shot = validShot(prng, fx.alice, canary);
      return mk(
        "rpc.apply_synced_shot",
        { kind: "rpc_apply", jsonText: JSON.stringify(shot) },
        true,
        `${actor} apply_synced_shot with alice's permit`,
      );
    }
    if (roll === 8) {
      return mk(
        "rpc.reserve_analysis_permit",
        { kind: "rpc_reserve", key: `k-${canary}` },
        true,
        `${actor} reserve_analysis_permit`,
      );
    }
    const fn = prng.pick([
      ["access_state", "", []],
      ["lifetime_scored_count", "", []],
      ["identity_scored_count", "", []],
      ["complete_onboarding", "", []],
      ["access_lock_key", "$1::uuid", [fx.alice.id]],
      ["access_lock_key", "$1::uuid", [traversal(prng, fx.alice.id)]],
      ["recompute_player_rank", "$1::uuid", [fx.alice.id]],
      ["free_rating_identity_hash", "$1::text, $2::text", ["google", "google-sub-alice"]],
      ["player_rank_tier", "$1::numeric", ["5"]],
      ["enforce_scored_shot_permit", "", []],
    ] as Array<[string, string, string[]]>);
    return mk(
      `fn.${fn[0]}`,
      { kind: "rpc_call", fn: fn[0], argSql: fn[1], params: fn[2] },
      true,
      `${actor} calls ${fn[0]}(${fn[1]})`,
    );
  }

  // Authenticated actor: pick a target surface.
  const targetRoll = prng.next();
  if (family === "control_valid") {
    if (targetRoll < 0.5)
      return mk(
        "rpc.apply_synced_shot",
        { kind: "rpc_apply", jsonText: JSON.stringify(base) },
        false,
        "valid shot (must be accepted)",
        true,
      );
    if (targetRoll < 0.7)
      return mk(
        "rpc.reserve_analysis_permit",
        { kind: "rpc_reserve", key: `k-${canary}` },
        false,
        "valid reserve (must be accepted or paywall)",
        true,
      );
    const table = prng.pick([...INSERTABLE]);
    return mk(
      `table.${table}.insert`,
      { kind: "insert", table, row: validRow(prng, table, me, canary) },
      false,
      `valid ${table} row (must be stored)`,
      true,
    );
  }

  if (targetRoll < 0.5) {
    // apply_synced_shot jsonb payload
    let m: Mutation;
    switch (family) {
      case "malformed_json":
        m = malformedJsonCase(prng, base);
        break;
      case "wrong_type":
        m = wrongTypeCase(prng, base);
        break;
      case "proto_pollution":
        m = protoPollutionCase(prng, base);
        break;
      case "numeric_edge":
        m = numericEdgeCase(prng, base);
        break;
      case "null_bytes":
        m = nullByteCase(prng, base);
        break;
      case "long_strings":
        m = longStringCase(prng, base);
        break;
      case "path_traversal":
        m = pathTraversalCase(prng, base, other);
        break;
      case "future_schema":
        m = futureSchemaCase(prng, base);
        break;
      case "empty_containers":
        m = emptyContainersCase(prng, base);
        break;
      case "unicode_norm":
        m = unicodeNormCase(prng, base);
        break;
      case "dup_keys":
        m = dupKeysCase(prng, base, other);
        break;
      case "deep_nesting":
        m = deepNestingCase(prng, base);
        break;
      case "huge_arrays":
        m = hugeArraysCase(prng, base);
        break;
      case "timestamp_edge":
        m = timestampEdgeCase(prng, base);
        break;
      default:
        m = crossUserApplyCase(prng, base, other);
    }
    return mk(
      "rpc.apply_synced_shot",
      { kind: "rpc_apply", jsonText: m.json },
      m.mustReject,
      m.note,
    );
  }

  if (
    targetRoll < 0.62 &&
    [
      "long_strings",
      "null_bytes",
      "path_traversal",
      "unicode_norm",
      "empty_containers",
      "proto_pollution",
      "wrong_type",
    ].includes(family)
  ) {
    if (family === "unicode_norm" && prng.bool(0.5)) {
      const [nfc, nfd] = normPair(prng);
      return mk(
        "rpc.reserve_analysis_permit",
        { kind: "rpc_reserve_pair", keys: [`${nfc}-${canary}`, `${nfd}-${canary}`] },
        false,
        "NFC then NFD idempotency key (opaque → two permits or paywall; never a merge)",
      );
    }
    const [key, mustReject, note] = prng.pick(RESERVE_KEYS)(prng, canary);
    return mk("rpc.reserve_analysis_permit", { kind: "rpc_reserve", key }, mustReject, note);
  }

  if (targetRoll < 0.9) {
    // PostgREST-shaped table insert
    const table = prng.pick([...INSERTABLE]);
    const baseRow = validRow(prng, table, me, canary);
    const m = mutateRow(prng, family, table, baseRow, other, canary);
    return mk(`table.${table}.insert`, { kind: "insert", table, row: m.row }, m.mustReject, m.note);
  }

  // updates / deletes / selects with hostile filters and values
  const roll = prng.int(6);
  if (roll === 0) {
    const s = capEdge(prng, 100);
    return mk(
      "table.profiles.update",
      {
        kind: "update",
        table: "profiles",
        set: { skill_level: s.value },
        whereCol: "id",
        whereCast: "uuid",
        whereParam: me.id,
      },
      s.codepoints > 100,
      `profiles.skill_level ${s.kind} cps=${s.codepoints}`,
    );
  }
  if (roll === 1) {
    return mk(
      "table.profiles.update",
      {
        kind: "update",
        table: "profiles",
        set: { email: `${canary}@evil.example` },
        whereCol: "id",
        whereCast: "uuid",
        whereParam: me.id,
      },
      true,
      "profiles.email (column not granted → 42501)",
    );
  }
  if (roll === 2) {
    const s = capEdge(prng, 50);
    return mk(
      "table.analysis_permits.update",
      {
        kind: "update",
        table: "analysis_permits",
        set: { status: "finalized", outcome: s.value },
        whereCol: "id",
        whereCast: "uuid",
        whereParam: me.permitId,
      },
      s.codepoints > 50,
      `analysis_permits.outcome ${s.kind} cps=${s.codepoints}`,
    );
  }
  if (roll === 3) {
    return mk(
      "table.analysis_permits.update",
      {
        kind: "update",
        table: "analysis_permits",
        set: { status: "finalized" },
        whereCol: "id",
        whereCast: "uuid",
        whereParam: other.permitId,
      },
      true,
      "finalize OTHER user's permit (RLS → 0 rows)",
    );
  }
  if (roll === 4) {
    const filt = prng.pick([traversal(prng, other.shotId), other.shotId, unicodeOddity(prng), ""]);
    return mk(
      "table.shots.select",
      { kind: "select", table: "shots", whereCol: "id", whereCast: "uuid", whereParam: filt },
      true,
      `select shots where id = ${JSON.stringify(filt)} (other user's / hostile → 0 rows or 22P02)`,
    );
  }
  return mk(
    "table.shots.delete",
    {
      kind: "delete",
      table: "shots",
      whereCol: "id",
      whereCast: "uuid",
      whereParam: prng.bool() ? me.shotId : other.shotId,
    },
    true,
    "delete a shot (no client DELETE grant → 42501)",
  );
}
