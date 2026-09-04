/**
 * Seeded boundary / malformed-input generator for apply_synced_shot(jsonb).
 *
 * Pure: no I/O. Every iteration is a deterministic function of
 * (campaignSeed, iteration) → `iterSeed`, and `generate(iterSeed, fixture)`
 * rebuilds the exact payload text, the target user/role and the expectation
 * class, so any row of the results table replays from its seed alone.
 *
 * Output is the RAW TEXT that will be bound as the jsonb argument, not a JS
 * object — the lens includes malformed / truncated JSON, `NaN` / `Infinity`
 * literals, duplicate keys, `\u0000` escapes and lone surrogates, none of
 * which survive JSON.stringify.
 */

// ---------------------------------------------------------------- PRNG ----

/** mulberry32 — small, fast, good enough for replayable fuzzing. */
export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
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
  chance(p: number): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(16).toString(16);
    return out;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + this.int(4)).toString(
      16,
    )}${h.slice(17, 20)}-${h.slice(20, 32)}`;
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

/** iteration → seed, so a campaign is a sequence of independent seeds. */
export function iterSeed(campaignSeed: number, iteration: number): number {
  return fnv1a(`${campaignSeed}:${iteration}`);
}

// ------------------------------------------------------------ fixtures ----

export interface FixtureUser {
  name: "alice" | "bob" | "carol" | "dave";
  id: string;
  /** live reserved permit (created now) */
  livePermit: string;
  /** reserved permit backdated 25h (must return access.permit_expired) */
  expiredPermit: string;
  /** finalized permit (must return access.permit_not_reserved) */
  spentPermit: string;
  /** a session the user owns */
  sessionId: string;
  /** a committed shot id the user already owns (replay → accepted, no write) */
  ownedShotId: string;
  premium: boolean;
  /** committed scored shots before the campaign (lifetime count) */
  scoredBefore: number;
}

export interface Fixture {
  users: Record<FixtureUser["name"], FixtureUser>;
}

export const VERSION_VECTOR = {
  appVersion: "1.0.0",
  modelBundleVersion: "bundle-1",
  poseModelVersion: "pose-1",
  paddleModelVersion: "paddle-1",
  strokeDetectorVersion: "stroke-1",
  phaseModelVersion: "phase-1",
  scoringModelVersion: "scoring-1",
  shotConfigVersion: "config-1",
};

// ------------------------------------------------------------- poisons ----

const S64 = "k".repeat(64);
const S65 = "k".repeat(65);
const E_ACUTE_NFC = "\u00e9"; // é as one code point
const E_ACUTE_NFD = "e\u0301"; // é as base + combining mark
const ANGSTROM_SIGN = "\u212b"; // Å (U+212B) — NFC → U+00C5
const A_RING = "\u00c5";
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"; // 5 code points, 1 grapheme
const TENNIS = "\u{1F3BE}"; // astral, 2 UTF-16 units, 1 code point

/** Strings sized against the 64-char caps in three different units. */
export const CAP_STRINGS: Record<string, string> = {
  "64-ascii": S64,
  "65-ascii": S65,
  "64-nfc-latin": E_ACUTE_NFC.repeat(64), // 64 cp / 128 bytes
  "64-nfd-latin": E_ACUTE_NFD.repeat(64), // 128 cp / 64 graphemes
  "32-nfd-latin": E_ACUTE_NFD.repeat(32), // 64 cp / 32 graphemes
  "64-astral": TENNIS.repeat(64), // 64 cp / 128 UTF-16 / 256 bytes
  "33-astral": TENNIS.repeat(33), // 33 cp / 66 UTF-16
  "13-family-zwj": FAMILY.repeat(13), // 65 cp / 13 graphemes
  "12-family-zwj": FAMILY.repeat(12), // 60 cp / 12 graphemes
  "64-with-bom": "\ufeff" + "k".repeat(63),
  "64-with-zwsp": "\u200b".repeat(64),
  "64-rtl": "\u202e" + "k".repeat(63),
  empty: "",
  space: " ",
  "spaces-64": " ".repeat(64),
  "tab-newline": "\t\n\r",
};

export const BIG_STRING_SIZES = [65_536, 131_072, 262_144, 1_048_576] as const;

export const PATH_TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "/etc/passwd",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "....//....//etc/passwd",
  "file:///etc/passwd",
  "\\\\?\\C:\\Windows",
  "shots/../../permits",
  "'; drop table public.shots; --",
  '" or 1=1 --',
  "${jndi:ldap://x.example/a}",
  "{{7*7}}",
  "<script>alert(1)</script>",
  "%00.txt",
  "id\u0000hidden",
];

export const UUID_VARIANTS = (rng: Prng, real: string): string[] => [
  real.toUpperCase(),
  `{${real}}`,
  `urn:uuid:${real}`,
  real.replace(/-/g, ""), // PG accepts undashed
  ` ${real}`,
  `${real} `,
  `${real}\n`,
  real.slice(0, 35),
  real + "0",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "not-a-uuid",
  "../../etc/passwd",
  rng.uuid(), // random, unowned
  "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
  real.replace(/-/g, "_"),
  "0x" + real.replace(/-/g, ""),
];

export const TIMESTAMPS = [
  "infinity",
  "-infinity",
  "now",
  "today",
  "tomorrow",
  "yesterday",
  "epoch",
  "allballs",
  "J2451545",
  "2026-02-30T00:00:00Z",
  "2026-13-01T00:00:00Z",
  "2026-01-01T24:00:00Z", // PG accepts 24:00:00
  "2026-01-01T23:60:00Z",
  "2026-01-01T00:00:60Z", // leap-second syntax → PG rolls over
  "0000-01-01T00:00:00Z",
  "0001-01-01T00:00:00Z BC",
  "294277-01-01T00:00:00Z",
  "4714-11-24T00:00:00Z BC",
  "2026-01-01T00:00:00+99:00",
  "2026-01-01T00:00:00+14:00",
  "2026-01-01 00:00:00",
  "2026-01-01",
  "20260101T000000Z",
  "2026-01-01T00:00:00.123456789Z",
  "2026-01-01T00:00:00.1234567890123Z",
  "1690000000000",
  "1690000000",
  "0",
  "-1",
  "",
  " ",
  "2026-01-01T00:00:00Z\u0000",
  "2026-01-01T00:00:00Z; drop table shots",
  "Sat Jan 01 2026 00:00:00 GMT+0000",
  "01/02/2026",
  "2026-1-1T0:0:0Z",
  "1e10",
];

export const NUMERIC_STRINGS = [
  "NaN",
  "nan",
  "Infinity",
  "-Infinity",
  "inf",
  "-inf",
  "-0",
  "-0.0",
  "0.0",
  "1e999",
  "-1e999",
  "1e-999",
  "1e400",
  "0x10",
  "0b11",
  "1_000",
  " 1",
  "1 ",
  "+1",
  "1.",
  ".5",
  "1e",
  "1..2",
  "1,5",
  "١٢٣", // Arabic-Indic digits
  "１２３", // fullwidth digits
  "2147483647",
  "2147483648",
  "-2147483648",
  "-2147483649",
  "9007199254740993",
  "9223372036854775807",
  "9223372036854775808",
  "99999999999999999999999999999999999999",
  "10",
  "10.00",
  "10.001",
  "10.004",
  "10.005",
  "9.999",
  "9.9949",
  "9.995",
  "1.0001",
  "1.00004",
  "1.00005",
  "0.99999",
  "0.999949",
  "100",
  "100.001",
  "100.4",
  "100.5",
  "-0.00001",
  "-0.000001",
  "-0.004",
  "-0.005",
  "0.1e1",
  "1E1",
  "true",
  "",
];

export const NUMERIC_LITERALS = [
  0,
  -0,
  -1,
  1,
  0.5,
  1.5,
  10,
  10.001,
  10.005,
  100,
  100.5,
  -0.000001,
  -0.005,
  0.1 + 0.2,
  1e21,
  1e300,
  1.7976931348623157e308,
  5e-324,
  2147483647,
  2147483648,
  -2147483649,
  4294967296,
  9007199254740991,
  Number.MAX_SAFE_INTEGER + 2,
  1e-7,
  123456789012345680000,
];

/** JSON *text* number tokens JSON.stringify cannot produce. */
export const RAW_NUMBER_TOKENS = [
  "NaN",
  "Infinity",
  "-Infinity",
  "-0",
  "-0.0",
  "1e999",
  "-1e999",
  "1e-999",
  "1e131072",
  "1e131073",
  "1e100000000",
  "0.1e-500",
  "1" + "0".repeat(200),
  "1" + "0".repeat(5000),
  "0." + "0".repeat(5000) + "1",
  "007",
  "0x1F",
  "1.",
  ".5",
  "+1",
  "1e",
  "--1",
  "1__0",
];

export const ENUM_VARIANTS: Record<string, string[]> = {
  cameraView: [
    "side",
    "rear_oblique",
    "Side",
    "SIDE",
    "side ",
    " side",
    "rear-oblique",
    "front",
    "",
    "side\u0000",
    "sıde",
  ],
  resultKind: [
    "scored",
    "low_confidence",
    "Scored",
    "SCORED",
    "scored ",
    "low-confidence",
    "lowConfidence",
    "",
    "abstain",
    "unknown",
    "scored\u0000",
  ],
  shotType: [
    "dink",
    "drive",
    "serve",
    "Dink",
    "dink ",
    "",
    "../../etc/passwd",
    S64,
    S65,
    "dink\u0000",
    "\u0000",
    "drop_shot",
    "third_shot_drop",
  ],
  band: ["green", "yellow", "red", "unscored", "Green", "GREEN", "amber", "", "green ", "gray"],
  direction: ["up", "down", "", S64, S65, "../..", "\u0000"],
  key: [
    "ready",
    "backswing",
    "contact",
    "follow_through",
    "",
    S64,
    S65,
    "../../etc/passwd",
    "__proto__",
    "constructor",
    "prototype",
    "ready\u0000",
    E_ACUTE_NFC,
    E_ACUTE_NFD,
    ANGSTROM_SIGN,
    A_RING,
    FAMILY,
    "\ufeff",
    "\u200b",
  ],
};

export const POLLUTION_KEYS = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "$where",
  "$gt",
  "",
  " ",
  "\u0000",
  "id\u0000",
  "a".repeat(10_000),
];

// ------------------------------------------------------------- payload ----

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface BasePayloadOpts {
  id: string;
  analysisPermitId: string;
  sessionId: string | null;
  resultKind: "scored" | "low_confidence";
  phases?: number;
  checkpoints?: number;
}

export function basePayload(o: BasePayloadOpts): { [k: string]: Json } {
  const phases: Json[] = [];
  const phaseKeys = ["ready", "backswing", "contact", "follow_through"];
  for (let i = 0; i < (o.phases ?? 2); i++) {
    phases.push({
      key: phaseKeys[i % phaseKeys.length] + (i >= phaseKeys.length ? `_${i}` : ""),
      startMs: i * 50,
      representativeMs: i * 50 + 25,
      endMs: i * 50 + 50,
      confidence: 0.8,
    });
  }
  const checkpoints: Json[] = [];
  for (let i = 0; i < (o.checkpoints ?? 2); i++) {
    checkpoints.push({
      key: `cp_${i}`,
      score: 70 + i,
      confidence: 0.7,
      band: "green",
      direction: "up",
      severity: 0.2,
      applicable: true,
    });
  }
  const scored = o.resultKind === "scored";
  return {
    id: o.id,
    analysisPermitId: o.analysisPermitId,
    sessionId: o.sessionId,
    shotType: "dink",
    cameraView: "side",
    capturedAt: "2026-09-01T10:00:00.000Z",
    startMs: 0,
    contactMs: 100,
    endMs: 200,
    overallScore: scored ? 7.25 : null,
    confidence: scored ? 0.9 : 0.3,
    resultKind: o.resultKind,
    phases,
    checkpoints,
    versionVector: { ...VERSION_VECTOR },
  };
}

// ---------------------------------------------------------- scenarios ----

export type RoleMode = "authenticated" | "anon" | "authenticated-no-sub" | "service_role";

export type PermitChoice =
  "live" | "expired" | "spent" | "other-user-live" | "random" | "nil" | "malformed";

export type IdChoice = "fresh" | "owned-replay" | "other-user-owned" | "malformed";

export type SessionChoice = "own" | "none" | "empty-string" | "other-user" | "random" | "malformed";

/** How the payload text is finally produced. */
export type TextClass =
  | "json-object" // JSON.stringify of a (possibly mutated) object
  | "raw-token-number" // a numeric field replaced by a raw JSON token (NaN, 1e999, …)
  | "raw-escape-string" // a string field replaced by a raw escape (\u0000, lone surrogate)
  | "duplicate-key" // the object text with a duplicated top-level key (last wins in jsonb)
  | "truncated" // valid JSON cut at a random byte
  | "garbage" // structurally broken JSON (unbalanced, trailing comma, comments, single quotes)
  | "non-object-root" // [], "str", 123, true, null, [{}], deep nesting
  | "huge"; // 64KB+ strings / 10k keys / long arrays

export interface Mutation {
  /** JSON-pointer-ish path, e.g. `/phases/1/confidence` */
  path: string;
  /** short label of the poison used */
  poison: string;
}

export interface Scenario {
  iterSeed: number;
  user: FixtureUser["name"];
  role: RoleMode;
  resultKind: "scored" | "low_confidence";
  permit: PermitChoice;
  id: IdChoice;
  session: SessionChoice;
  textClass: TextClass;
  mutations: Mutation[];
  /** the shot id in the payload when it is a real uuid (for post-checks) */
  shotId: string | null;
  /** the permit id in the payload when it is a real fixture permit (for post-checks) */
  permitId: string | null;
  permitStatusBefore: "reserved" | "finalized" | "released" | null;
  /** raw text bound as the jsonb argument */
  text: string;
  textBytes: number;
  textSha: string;
}

type Obj = { [k: string]: Json };

function setPath(root: Obj, path: string[], value: Json): void {
  let cur: Json = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next: Json = (cur as Obj)[path[i]];
    if (next === null || typeof next !== "object") return;
    cur = next;
  }
  (cur as Obj)[path[path.length - 1]] = value;
}

function deletePath(root: Obj, path: string[]): void {
  let cur: Json = root;
  for (let i = 0; i < path.length - 1; i++) {
    const next: Json = (cur as Obj)[path[i]];
    if (next === null || typeof next !== "object") return;
    cur = next;
  }
  if (Array.isArray(cur)) cur.splice(Number(path[path.length - 1]), 1);
  else delete (cur as Obj)[path[path.length - 1]];
}

const TOP_STRING_FIELDS = ["shotType", "cameraView", "capturedAt", "resultKind"] as const;
const TOP_NUMBER_FIELDS = ["startMs", "contactMs", "endMs", "overallScore", "confidence"] as const;
const VV_FIELDS = Object.keys(VERSION_VECTOR);
const PHASE_NUMBER_FIELDS = ["startMs", "representativeMs", "endMs", "confidence"];
const CP_NUMBER_FIELDS = ["score", "confidence", "severity"];
const CP_STRING_FIELDS = ["key", "band", "direction"];

function wrongTypeValue(rng: Prng, forNumber: boolean): [Json, string] {
  const pool: [Json, string][] = forNumber
    ? [
        ["12", "string-number"],
        ["twelve", "string-word"],
        [true, "bool"],
        [false, "bool"],
        [null, "null"],
        [[], "empty-array"],
        [{}, "empty-object"],
        [[1], "array-1"],
        [{ v: 1 }, "object"],
        [[[[[]]]], "nested-arrays"],
      ]
    : [
        [12, "number"],
        [-0, "neg-zero"],
        [1e300, "huge-number"],
        [true, "bool"],
        [null, "null"],
        [[], "empty-array"],
        [{}, "empty-object"],
        [["side"], "array-of-valid"],
        [{ value: "side" }, "object-wrapping-valid"],
        [[[[[]]]], "nested-arrays"],
      ];
  const [v, label] = rng.pick(pool);
  return [
    Array.isArray(v) || (v && typeof v === "object") ? structuredClone(v) : v,
    `wrong-type:${label}`,
  ];
}

function numericPoison(rng: Prng): [Json, string] {
  if (rng.chance(0.5)) {
    const s = rng.pick(NUMERIC_STRINGS);
    return [s, `numstr:${JSON.stringify(s)}`];
  }
  const n = rng.pick(NUMERIC_LITERALS);
  return [n, `numlit:${Object.is(n, -0) ? "-0" : String(n)}`];
}

function stringPoison(rng: Prng, field: string): [Json, string] {
  const r = rng.next();
  if (r < 0.3) {
    const k = rng.pick(Object.keys(CAP_STRINGS));
    return [CAP_STRINGS[k], `cap:${k}`];
  }
  if (r < 0.5) {
    const s = rng.pick(PATH_TRAVERSAL);
    return [s, `traversal:${JSON.stringify(s).slice(0, 40)}`];
  }
  if (r < 0.75 && ENUM_VARIANTS[field]) {
    const s = rng.pick(ENUM_VARIANTS[field]);
    return [s, `enum:${JSON.stringify(s).slice(0, 40)}`];
  }
  if (r < 0.85) {
    const pair = rng.pick([
      [E_ACUTE_NFC, "nfc-e-acute"],
      [E_ACUTE_NFD, "nfd-e-acute"],
      [ANGSTROM_SIGN, "angstrom-sign"],
      [A_RING, "a-ring"],
      [FAMILY, "family-zwj"],
      ["\u0130", "capital-i-dot"],
      ["\u0131", "dotless-i"],
      ["\ufb01", "fi-ligature"],
    ] as const);
    return [pair[0], `unicode:${pair[1]}`];
  }
  return wrongTypeValue(rng, false);
}

function timestampPoison(rng: Prng): [Json, string] {
  if (rng.chance(0.75)) {
    const s = rng.pick(TIMESTAMPS);
    return [s, `ts:${JSON.stringify(s).slice(0, 40)}`];
  }
  return wrongTypeValue(rng, false);
}

interface MutateResult {
  obj: Obj;
  mutations: Mutation[];
}

/** Apply 1..k value-level mutations at random targets. */
function mutateObject(rng: Prng, obj: Obj, k: number): MutateResult {
  const mutations: Mutation[] = [];
  for (let m = 0; m < k; m++) {
    const target = rng.int(15);
    switch (target) {
      case 0:
      case 14: {
        // top-level string field
        const f = rng.pick(TOP_STRING_FIELDS);
        const [v, label] = f === "capturedAt" ? timestampPoison(rng) : stringPoison(rng, f);
        setPath(obj, [f], v);
        mutations.push({ path: `/${f}`, poison: label });
        break;
      }
      case 1:
      case 2: {
        // top-level number field
        const f = rng.pick(TOP_NUMBER_FIELDS);
        const [v, label] = rng.chance(0.7) ? numericPoison(rng) : wrongTypeValue(rng, true);
        setPath(obj, [f], v);
        mutations.push({ path: `/${f}`, poison: label });
        break;
      }
      case 3: {
        // version vector field
        const f = rng.pick(VV_FIELDS);
        const [v, label] = stringPoison(rng, f);
        setPath(obj, ["versionVector", f], v);
        mutations.push({ path: `/versionVector/${f}`, poison: label });
        break;
      }
      case 4: {
        // version vector shape
        const [v, label] = rng.pick<[Json, string]>([
          [null, "null"],
          ["1.0.0", "string"],
          [[], "empty-array"],
          [{}, "empty-object"],
          [[VERSION_VECTOR], "array-wrapped"],
          [{ ...VERSION_VECTOR, appVersion: null }, "appVersion-null"],
          [{ ...VERSION_VECTOR, schemaVersion: 99 }, "extra-key"],
        ]);
        setPath(obj, ["versionVector"], structuredClone(v));
        mutations.push({ path: "/versionVector", poison: `shape:${label}` });
        break;
      }
      case 5: {
        // phases element field
        const phases = obj.phases;
        if (Array.isArray(phases) && phases.length > 0) {
          const i = rng.int(phases.length);
          if (rng.chance(0.6)) {
            const f = rng.pick(PHASE_NUMBER_FIELDS);
            const [v, label] = rng.chance(0.7) ? numericPoison(rng) : wrongTypeValue(rng, true);
            setPath(obj, ["phases", String(i), f], v);
            mutations.push({ path: `/phases/${i}/${f}`, poison: label });
          } else {
            const [v, label] = stringPoison(rng, "key");
            setPath(obj, ["phases", String(i), "key"], v);
            mutations.push({ path: `/phases/${i}/key`, poison: label });
          }
        } else {
          setPath(
            obj,
            ["phases"],
            [{ key: "ready", startMs: 0, representativeMs: 0, endMs: 1, confidence: 0.5 }],
          );
          mutations.push({ path: "/phases", poison: "reset-1" });
        }
        break;
      }
      case 6: {
        // checkpoints element field
        const cps = obj.checkpoints;
        if (Array.isArray(cps) && cps.length > 0) {
          const i = rng.int(cps.length);
          const r = rng.next();
          if (r < 0.45) {
            const f = rng.pick(CP_NUMBER_FIELDS);
            const [v, label] = rng.chance(0.7) ? numericPoison(rng) : wrongTypeValue(rng, true);
            setPath(obj, ["checkpoints", String(i), f], v);
            mutations.push({ path: `/checkpoints/${i}/${f}`, poison: label });
          } else if (r < 0.85) {
            const f = rng.pick(CP_STRING_FIELDS);
            const [v, label] = stringPoison(rng, f);
            setPath(obj, ["checkpoints", String(i), f], v);
            mutations.push({ path: `/checkpoints/${i}/${f}`, poison: label });
          } else {
            const [v, label] = rng.pick<[Json, string]>([
              ["true", "string-true"],
              ["yes", "string-yes"],
              ["1", "string-1"],
              ["t", "string-t"],
              ["on", "string-on"],
              ["maybe", "string-maybe"],
              [1, "number-1"],
              [0, "number-0"],
              [null, "null"],
              [[], "empty-array"],
              [{}, "empty-object"],
            ]);
            setPath(obj, ["checkpoints", String(i), "applicable"], v);
            mutations.push({ path: `/checkpoints/${i}/applicable`, poison: `bool:${label}` });
          }
        } else {
          setPath(
            obj,
            ["checkpoints"],
            [
              {
                key: "cp",
                score: 1,
                confidence: 0.5,
                band: "green",
                direction: "up",
                severity: 0.1,
                applicable: true,
              },
            ],
          );
          mutations.push({ path: "/checkpoints", poison: "reset-1" });
        }
        break;
      }
      case 7: {
        // phases / checkpoints container shape
        const f = rng.pick(["phases", "checkpoints"]);
        const [v, label] = rng.pick<[Json, string]>([
          [null, "null"],
          ["[]", "string-array"],
          [{}, "empty-object"],
          [{ key: "ready" }, "object-not-array"],
          [[], "empty-array"],
          [[null], "array-null"],
          [[1, 2, 3], "array-numbers"],
          [["ready"], "array-strings"],
          [[[]], "array-array"],
          [[{}], "array-empty-object"],
          [[{ key: "ready" }, { key: "ready" }], "duplicate-keys"],
          [[{ key: "a" }, { key: "A" }], "case-variant-keys"],
          [[{ key: E_ACUTE_NFC }, { key: E_ACUTE_NFD }], "nfc-nfd-key-pair"],
          [1, "number"],
          [true, "bool"],
        ]);
        setPath(obj, [f], structuredClone(v));
        mutations.push({ path: `/${f}`, poison: `container:${label}` });
        break;
      }
      case 8: {
        // delete a field
        const candidates = [
          ["shotType"],
          ["cameraView"],
          ["capturedAt"],
          ["startMs"],
          ["endMs"],
          ["contactMs"],
          ["overallScore"],
          ["confidence"],
          ["resultKind"],
          ["versionVector"],
          ["phases"],
          ["checkpoints"],
          ["sessionId"],
          ["versionVector", rng.pick(VV_FIELDS)],
          ["phases", "0", "key"],
          ["checkpoints", "0", "key"],
          ["checkpoints", "0", "applicable"],
        ];
        const p = rng.pick(candidates);
        deletePath(obj, p);
        mutations.push({ path: "/" + p.join("/"), poison: "deleted" });
        break;
      }
      case 9: {
        // prototype pollution / unknown keys / future schema
        const r = rng.next();
        if (r < 0.5) {
          const k = rng.pick(POLLUTION_KEYS);
          const [v] = rng.pick<[Json, string]>([
            [{ polluted: true }, "o"],
            ["x", "s"],
            [1, "n"],
            [null, "null"],
          ]);
          const where = rng.pick(["top", "versionVector", "phase", "checkpoint"]);
          if (where === "top") setPath(obj, [k], v);
          else if (where === "versionVector") setPath(obj, ["versionVector", k], v);
          else if (where === "phase") setPath(obj, ["phases", "0", k], v);
          else setPath(obj, ["checkpoints", "0", k], v);
          mutations.push({
            path: `${where}/${JSON.stringify(k).slice(0, 30)}`,
            poison: "pollution-key",
          });
        } else if (r < 0.8) {
          const sv = rng.pick<Json>([2, 99, "2.0", "9999", -1, null, { major: 2 }, [2]]);
          setPath(obj, [rng.pick(["schemaVersion", "version", "v", "$schema", "__v"])], sv);
          mutations.push({ path: "/schemaVersion", poison: `future-schema:${JSON.stringify(sv)}` });
        } else {
          const n = rng.pick([10, 100, 1000]);
          for (let i = 0; i < n; i++) setPath(obj, [`extra_${i}`], i);
          mutations.push({ path: "/extra_*", poison: `unknown-keys:${n}` });
        }
        break;
      }
      case 10: {
        // resultKind vs score coherence
        const [rk, score, label] = rng.pick<[Json, Json, string]>([
          ["scored", null, "scored-null-score"],
          ["low_confidence", 7, "lowconf-with-score"],
          ["low_confidence", 0, "lowconf-zero-score"],
          ["scored", 10, "scored-max"],
          ["scored", 10.004, "scored-round-under"],
          ["scored", 10.005, "scored-round-over"],
          ["scored", -0.004, "scored-neg-round"],
          ["scored", "7", "scored-string-score"],
          [null, 7, "null-kind"],
          [1, 7, "number-kind"],
        ]);
        setPath(obj, ["resultKind"], rk);
        setPath(obj, ["overallScore"], score);
        mutations.push({ path: "/resultKind+/overallScore", poison: `coherence:${label}` });
        break;
      }
      case 11: {
        // ms ordering / bounds
        const [s, c, e, label] = rng.pick<[Json, Json, Json, string]>([
          [200, 100, 0, "reversed"],
          [0, null, 0, "zero-length"],
          [-1, 0, 1, "negative-start"],
          [0, 2147483647, 2147483647, "int-max"],
          [0, 2147483648, 2147483648, "int-overflow"],
          [0, 0.5, 1, "fractional-contact"],
          [0, 100.5, 200, "fractional-ms"],
          ["0", "100", "200", "string-ms"],
          [0, null, null, "null-end"],
          [1e10, 1e10, 1e10, "1e10"],
        ]);
        setPath(obj, ["startMs"], s);
        setPath(obj, ["contactMs"], c);
        setPath(obj, ["endMs"], e);
        mutations.push({ path: "/startMs+/contactMs+/endMs", poison: `ms:${label}` });
        break;
      }
      case 12: {
        // many detail rows
        const f = rng.pick(["phases", "checkpoints"]);
        const n = rng.pick([50, 200, 1000]);
        const arr: Json[] = [];
        for (let i = 0; i < n; i++) {
          arr.push(
            f === "phases"
              ? { key: `p${i}`, startMs: i, representativeMs: i, endMs: i + 1, confidence: 0.5 }
              : {
                  key: `c${i}`,
                  score: 50,
                  confidence: 0.5,
                  band: "green",
                  direction: "up",
                  severity: 0.1,
                  applicable: true,
                },
          );
        }
        setPath(obj, [f], arr);
        mutations.push({ path: `/${f}`, poison: `many:${n}` });
        break;
      }
      default: {
        // whole nested object replaced by deep nesting
        let deep: Json = {};
        const depth = rng.pick([50, 500, 5000]);
        for (let i = 0; i < depth; i++) deep = rng.chance(0.5) ? [deep] : { d: deep };
        const f = rng.pick(["phases", "checkpoints", "versionVector", "shotType", "extra"]);
        setPath(obj, [f], deep);
        mutations.push({ path: `/${f}`, poison: `deep-nesting:${depth}` });
      }
    }
  }
  return { obj, mutations };
}

// ------------------------------------------------- raw-text mutations ----

function rawNumberToken(
  rng: Prng,
  text: string,
  obj: Obj,
): { text: string; mutation: Mutation } | null {
  // Replace the JSON text of one top-level numeric field with a raw token.
  const numFields = TOP_NUMBER_FIELDS.filter((f) => typeof obj[f] === "number");
  if (numFields.length === 0) return null;
  const f = rng.pick(numFields);
  const token = rng.pick(RAW_NUMBER_TOKENS);
  const needle = `"${f}":${JSON.stringify(obj[f])}`;
  if (!text.includes(needle)) return null;
  return {
    text: text.replace(needle, `"${f}":${token}`),
    mutation: {
      path: `/${f}`,
      poison: `raw-token:${token.length > 20 ? token.slice(0, 12) + "…" : token}`,
    },
  };
}

function rawEscapeString(
  rng: Prng,
  text: string,
  obj: Obj,
): { text: string; mutation: Mutation } | null {
  const f = rng.pick([
    "shotType",
    "cameraView",
    "resultKind",
    "id",
    "analysisPermitId",
    "capturedAt",
  ]);
  const cur = obj[f];
  if (typeof cur !== "string") return null;
  const needle = `"${f}":${JSON.stringify(cur)}`;
  if (!text.includes(needle)) return null;
  const [esc, label] = rng.pick<[string, string]>([
    ["\\u0000", "nul-escape"],
    ["a\\u0000b", "embedded-nul-escape"],
    ["\\ud800", "lone-high-surrogate"],
    ["\\udc00", "lone-low-surrogate"],
    ["\\ud83c\\udfbe", "valid-surrogate-pair"],
    ["\\uD83C", "lone-high-upper"],
    ["\\x41", "hex-escape"],
    ["\\a", "unknown-escape"],
    ["\\", "trailing-backslash"],
    ["\\u00", "short-unicode-escape"],
    ["\\uZZZZ", "bad-unicode-escape"],
    ["\u0007", "raw-control-bel"],
    ["\t", "raw-tab"],
    ["\n", "raw-newline"],
  ]);
  return {
    text: text.replace(needle, `"${f}":"${esc}"`),
    mutation: { path: `/${f}`, poison: `raw-escape:${label}` },
  };
}

function duplicateKey(rng: Prng, text: string): { text: string; mutation: Mutation } {
  const f = rng.pick([
    "id",
    "analysisPermitId",
    "resultKind",
    "overallScore",
    "sessionId",
    "shotType",
    "confidence",
  ]);
  const [v, label] = rng.pick<[Json, string]>([
    [rng.uuid(), "random-uuid"],
    ["scored", "scored"],
    ["low_confidence", "low_confidence"],
    [null, "null"],
    [99, "99"],
    ["../../x", "traversal"],
    [{}, "empty-object"],
  ]);
  // Prepend the duplicate so the ORIGINAL wins under "last wins" — or append
  // so the poison wins. Both orders are exercised.
  const dup = `"${f}":${JSON.stringify(v)}`;
  const first = rng.chance(0.5);
  const body = text.slice(1, -1);
  const out = first ? `{${dup},${body}}` : `{${body},${dup}}`;
  return {
    text: out,
    mutation: { path: `/${f}`, poison: `dup-key:${label}:${first ? "first" : "last"}` },
  };
}

function garbage(rng: Prng, text: string): { text: string; mutation: Mutation } {
  const [t, label] = rng.pick<[string, string]>([
    [text.slice(0, -1), "missing-close-brace"],
    [text + "}", "extra-close-brace"],
    [text.replace(/,/, ",,"), "double-comma"],
    [text.replace(/}$/, ",}"), "trailing-comma"],
    [text.replace(/"/g, "'"), "single-quotes"],
    ["// c\n" + text, "line-comment"],
    ["/* c */" + text, "block-comment"],
    ["\ufeff" + text, "bom-prefix"],
    [text + text, "concatenated-twice"],
    [text + "\u0000", "trailing-nul-char"],
    ["\u0000" + text, "leading-nul-char"],
    [text.replace(/:/, "="), "equals-not-colon"],
    [text.replace(/"id"/, "id"), "unquoted-key"],
    [text.replace(/\{/, "["), "brace-bracket-mismatch"],
    [text.replace(/null/, "undefined"), "undefined-literal"],
    [text.replace(/true/, "True"), "python-true"],
    [text.replace(/null/, "None"), "python-none"],
    ["", "empty-text"],
    [" ", "whitespace-only"],
    ["{", "lone-open-brace"],
    ["}", "lone-close-brace"],
    ["{}{}", "two-objects"],
    ['{"a":1}\n{"b":2}', "ndjson"],
    ["\u2028" + text, "line-separator-prefix"],
    [text.replace(/"shotType"/, '"shot\\\nType"'), "escaped-newline-in-key"],
  ]);
  return { text: t, mutation: { path: "", poison: `garbage:${label}` } };
}

function nonObjectRoot(rng: Prng): { text: string; mutation: Mutation } {
  const [t, label] = rng.pick<[string, string]>([
    ["[]", "empty-array"],
    ["{}", "empty-object"],
    ["null", "null"],
    ["true", "true"],
    ["false", "false"],
    ["0", "zero"],
    ["-0", "neg-zero"],
    ["1e999", "1e999"],
    ["NaN", "NaN"],
    ['""', "empty-string"],
    ['"str"', "string"],
    ['"{\\"id\\":\\"x\\"}"', "stringified-object"],
    ["[{}]", "array-of-empty-object"],
    ["[[[[]]]]", "nested-arrays"],
    ["[null]", "array-null"],
    ["[1,2,3]", "array-numbers"],
    ["[" + "[".repeat(10_000) + "]".repeat(10_000) + "]", "nesting-10k"],
    ["{" + '"a":{'.repeat(10_000) + "}".repeat(10_000) + "}", "object-nesting-10k"],
    ['{"__proto__":{"polluted":true}}', "proto-only"],
    ['{"id":null}', "id-null"],
    ['{"id":""}', "id-empty"],
    ['{"id":[]}', "id-array"],
    ['{"id":{}}', "id-object"],
    ['{"analysisPermitId":"../../etc/passwd"}', "permit-traversal"],
  ]);
  return { text: t, mutation: { path: "", poison: `root:${label}` } };
}

function huge(rng: Prng, obj: Obj): { obj: Obj; mutation: Mutation } {
  const size = rng.pick(BIG_STRING_SIZES);
  const [f, label] = rng.pick<[string[], string]>([
    [["shotType"], "shotType"],
    [["versionVector", "appVersion"], "versionVector.appVersion"],
    [["phases", "0", "key"], "phases[0].key"],
    [["checkpoints", "0", "key"], "checkpoints[0].key"],
    [["checkpoints", "0", "direction"], "checkpoints[0].direction"],
    [["cameraView"], "cameraView"],
    [["resultKind"], "resultKind"],
    [["capturedAt"], "capturedAt"],
    [["id"], "id"],
    [["analysisPermitId"], "analysisPermitId"],
    [["sessionId"], "sessionId"],
    [["overallScore"], "overallScore"],
    [["unknownBlob"], "unknownBlob"],
  ]);
  const kind = rng.pick(["ascii", "multibyte", "astral", "digits"]);
  let s: string;
  if (kind === "ascii") s = "k".repeat(size);
  else if (kind === "multibyte")
    s = E_ACUTE_NFC.repeat(size / 2); // size bytes
  else if (kind === "astral")
    s = TENNIS.repeat(size / 4); // size bytes
  else s = "9".repeat(size);
  setPath(obj, f, s);
  return { obj, mutation: { path: "/" + f.join("/"), poison: `huge:${label}:${kind}:${size}` } };
}

// ----------------------------------------------------------- generate ----

export function generate(seed: number, fx: Fixture): Scenario {
  const rng = new Prng(seed);
  const userName = rng.pick(["alice", "alice", "bob", "bob", "carol", "dave"] as const);
  const user = fx.users[userName];
  const otherName = rng.pick(
    (["alice", "bob", "carol", "dave"] as const).filter((n) => n !== userName),
  );
  const other = fx.users[otherName];

  const roleRoll = rng.next();
  const role: RoleMode =
    roleRoll < 0.9
      ? "authenticated"
      : roleRoll < 0.94
        ? "anon"
        : roleRoll < 0.97
          ? "authenticated-no-sub"
          : "service_role";

  const resultKind = rng.chance(0.6) ? "scored" : "low_confidence";

  const permitRoll = rng.next();
  const permit: PermitChoice =
    permitRoll < 0.6
      ? "live"
      : permitRoll < 0.68
        ? "expired"
        : permitRoll < 0.76
          ? "spent"
          : permitRoll < 0.84
            ? "other-user-live"
            : permitRoll < 0.9
              ? "random"
              : permitRoll < 0.94
                ? "nil"
                : "malformed";

  const idRoll = rng.next();
  const id: IdChoice =
    idRoll < 0.72
      ? "fresh"
      : idRoll < 0.82
        ? "owned-replay"
        : idRoll < 0.9
          ? "other-user-owned"
          : "malformed";

  const sessRoll = rng.next();
  const session: SessionChoice =
    sessRoll < 0.45
      ? "own"
      : sessRoll < 0.7
        ? "none"
        : sessRoll < 0.78
          ? "empty-string"
          : sessRoll < 0.86
            ? "other-user"
            : sessRoll < 0.93
              ? "random"
              : "malformed";

  const freshId = rng.uuid();
  let shotId: string | null = freshId;
  let idValue: string = freshId;
  if (id === "owned-replay") idValue = shotId = user.ownedShotId;
  else if (id === "other-user-owned") idValue = shotId = other.ownedShotId;
  else if (id === "malformed") {
    idValue = rng.pick(UUID_VARIANTS(rng, freshId));
    shotId = null;
  }

  let permitId: string | null = user.livePermit;
  let permitValue: string = user.livePermit;
  let permitStatusBefore: Scenario["permitStatusBefore"] = "reserved";
  switch (permit) {
    case "expired":
      permitId = permitValue = user.expiredPermit;
      permitStatusBefore = "reserved";
      break;
    case "spent":
      permitId = permitValue = user.spentPermit;
      permitStatusBefore = "finalized";
      break;
    case "other-user-live":
      permitId = permitValue = other.livePermit;
      permitStatusBefore = "reserved";
      break;
    case "random":
      permitValue = rng.uuid();
      permitId = null;
      permitStatusBefore = null;
      break;
    case "nil":
      permitValue = "00000000-0000-0000-0000-000000000000";
      permitId = null;
      permitStatusBefore = null;
      break;
    case "malformed":
      permitValue = rng.pick(UUID_VARIANTS(rng, user.livePermit));
      permitId = null;
      permitStatusBefore = null;
      break;
  }

  let sessionValue: Json = user.sessionId;
  if (session === "none") sessionValue = null;
  else if (session === "empty-string") sessionValue = "";
  else if (session === "other-user") sessionValue = other.sessionId;
  else if (session === "random") sessionValue = rng.uuid();
  else if (session === "malformed") {
    sessionValue = rng.pick<Json>([
      ...UUID_VARIANTS(rng, user.sessionId),
      1,
      true,
      [],
      {},
      [user.sessionId],
    ]);
  }

  let obj = basePayload({
    id: idValue,
    analysisPermitId: permitValue,
    sessionId: sessionValue as string | null,
    resultKind,
    phases: rng.pick([0, 1, 2, 4]),
    checkpoints: rng.pick([0, 1, 2, 3]),
  });
  if (session === "malformed" && typeof sessionValue !== "string" && sessionValue !== null) {
    obj.sessionId = sessionValue;
  }

  const classRoll = rng.next();
  const textClass: TextClass =
    classRoll < 0.58
      ? "json-object"
      : classRoll < 0.66
        ? "raw-token-number"
        : classRoll < 0.72
          ? "raw-escape-string"
          : classRoll < 0.78
            ? "duplicate-key"
            : classRoll < 0.85
              ? "truncated"
              : classRoll < 0.91
                ? "garbage"
                : classRoll < 0.95
                  ? "non-object-root"
                  : "huge";

  let mutations: Mutation[] = [];
  let text: string;

  // Value-level mutations first (0..3), for every class except non-object-root.
  if (textClass !== "non-object-root") {
    const k = textClass === "json-object" ? rng.pick([0, 1, 1, 2, 2, 3]) : rng.pick([0, 0, 1]);
    const r = mutateObject(rng, obj, k);
    obj = r.obj;
    mutations = r.mutations;
  }

  switch (textClass) {
    case "json-object":
      text = JSON.stringify(obj);
      break;
    case "raw-token-number": {
      const base = JSON.stringify(obj);
      const r = rawNumberToken(rng, base, obj);
      if (r) {
        text = r.text;
        mutations.push(r.mutation);
      } else {
        text = base;
      }
      break;
    }
    case "raw-escape-string": {
      const base = JSON.stringify(obj);
      const r = rawEscapeString(rng, base, obj);
      if (r) {
        text = r.text;
        mutations.push(r.mutation);
      } else {
        text = base;
      }
      break;
    }
    case "duplicate-key": {
      const r = duplicateKey(rng, JSON.stringify(obj));
      text = r.text;
      mutations.push(r.mutation);
      break;
    }
    case "truncated": {
      const base = JSON.stringify(obj);
      const cut = 1 + rng.int(Math.max(1, base.length - 1));
      text = base.slice(0, cut);
      mutations.push({ path: "", poison: `truncated:${cut}/${base.length}` });
      break;
    }
    case "garbage": {
      const r = garbage(rng, JSON.stringify(obj));
      text = r.text;
      mutations.push(r.mutation);
      break;
    }
    case "non-object-root": {
      const r = nonObjectRoot(rng);
      text = r.text;
      mutations.push(r.mutation);
      shotId = null;
      permitId = null;
      permitStatusBefore = null;
      break;
    }
    case "huge": {
      const r = huge(rng, obj);
      obj = r.obj;
      mutations.push(r.mutation);
      text = JSON.stringify(obj);
      if (/huge:(id|analysisPermitId):/.test(r.mutation.poison)) {
        shotId = null;
        permitId = null;
        permitStatusBefore = null;
      }
      break;
    }
  }

  const textBytes = new TextEncoder().encode(text).length;
  return {
    iterSeed: seed,
    user: userName,
    role,
    resultKind,
    permit,
    id,
    session,
    textClass,
    mutations,
    shotId,
    permitId,
    permitStatusBefore,
    text,
    textBytes,
    textSha: fnv1a(text).toString(16).padStart(8, "0"),
  };
}
