// Seeded boundary/malformed-input generators + JSON result table for the
// externalAccounts.ts stress campaign (stress_external_accounts_*.test.ts).
//
// Every scenario is replayable from (family, seed): the generator is a pure
// function of a Prng seeded with the scenario seed, so a failing row in the
// JSON table can be re-run with STRESS_SEED=<seed> STRESS_ONLY=<family>.
//
//   STRESS_ITER      iterations per family (default 120 — fast enough for the suite)
//   STRESS_SEED      campaign base seed (default 20260904)
//   STRESS_ONLY      run one family only (exact name)
//   STRESS_OUT_DIR   where the JSON tables land (default ../../../../artifacts/stress-external-accounts)

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
  int(minInclusive: number, maxInclusive: number): number {
    return minInclusive +
      Math.floor(this.next() * (maxInclusive - minInclusive + 1));
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)];
  }
  uuid(): string {
    const hex = () => this.int(0, 15).toString(16);
    const h = (n: number) => Array.from({ length: n }, hex).join("");
    return `${h(8)}-${h(4)}-4${h(3)}-${"89ab"[this.int(0, 3)]}${h(3)}-${h(12)}`;
  }
  bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) out[i] = this.int(0, 255);
    return out;
  }
}

export function envInt(name: string, fallback: number): number {
  const raw = Deno.env.get(name);
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export const STRESS_ITER = envInt("STRESS_ITER", 120);
export const STRESS_SEED = envInt("STRESS_SEED", 20260904);
export const STRESS_ONLY = Deno.env.get("STRESS_ONLY") ?? "";

/** Scenario seed for iteration `i` of `family` — stable across families so
 * the same index in two families never shares a seed. */
export function scenarioSeed(family: string, index: number): number {
  let h = STRESS_SEED >>> 0;
  for (const ch of family) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return (h + index * 2654435761) >>> 0;
}

export function familySelected(family: string): boolean {
  return STRESS_ONLY === "" || STRESS_ONLY === family;
}

export function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

export function b64std(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ─── string generators ───────────────────────────────────────────────────────

/** Unicode normalization pairs: NFC form vs NFD form of the same text. */
export const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["\u00e9", "e\u0301"], // é
  ["\u00f1", "n\u0303"], // ñ
  ["\u1e69", "s\u0323\u0307"], // ṩ
  ["\ufb01", "fi"], // ligature (NFKC only)
  ["\u212b", "\u00c5"], // ANGSTROM SIGN vs Å
  ["\u2126", "\u03a9"], // OHM SIGN vs Ω
];

export const GRAPHEME_CLUSTERS: readonly string[] = [
  "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}", // family ZWJ sequence (25 UTF-8 bytes, 1 grapheme)
  "\u{1F1FA}\u{1F1F8}", // flag (2 code points)
  "\u{1F3FD}", // skin-tone modifier alone
  "a\u0301\u0302\u0303\u0304", // stacked combining marks
  "\u{1F600}", // astral plane, 2 UTF-16 units
  "\u0000", // NUL
  "\ufeff", // BOM
  "\u200b", // zero-width space
  "\u202e", // RTL override
  "\ud800", // lone high surrogate (invalid UTF-16 → U+FFFD on encode)
  "\udfff", // lone low surrogate
];

export const TRAVERSAL_SLUGS: readonly string[] = [
  "../../etc/passwd",
  "..%2f..%2fetc%2fpasswd",
  "..\\..\\windows",
  "/v1/subscribers/../../admin",
  "id?select=*",
  "id#fragment",
  "id/../other",
  "%00",
  "%2e%2e%2f",
  "a;drop table x;--",
  "' or 1=1 --",
  "${jndi:ldap://x}",
  "{{7*7}}",
  "\\u0000",
  "user_id=eq.11111111-1111-4111-8111-111111111111",
];

export const PROTO_KEYS: readonly string[] = [
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
  "hasOwnProperty",
];

export const WEIRD_NUMERIC_JSON: readonly string[] = [
  "1e309",
  "-1e309",
  "9007199254740993",
  "-0",
  "0.1e-400",
  "1" + "0".repeat(400),
  "18446744073709551616",
  "-9223372036854775809",
];

export const WEIRD_NUMBERS: readonly number[] = [
  NaN,
  Infinity,
  -Infinity,
  -0,
  0,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MIN_VALUE,
  Number.MAX_VALUE,
  2 ** 53,
  -(2 ** 31),
];

export function randomAscii(rng: Prng, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(rng.int(0x21, 0x7e));
  }
  return out;
}

export function randomUnicode(rng: Prng, codePoints: number): string {
  let out = "";
  for (let i = 0; i < codePoints; i += 1) {
    const bucket = rng.int(0, 5);
    if (bucket === 0) out += String.fromCodePoint(rng.int(0x80, 0x7ff));
    else if (bucket === 1) out += String.fromCodePoint(rng.int(0x800, 0xd7ff));
    else if (bucket === 2) {
      out += String.fromCodePoint(rng.int(0x10000, 0x10ffff));
    } else if (bucket === 3) out += rng.pick(GRAPHEME_CLUSTERS);
    else if (bucket === 4) out += rng.pick(NORMALIZATION_PAIRS)[rng.int(0, 1)];
    else out += String.fromCharCode(rng.int(0x20, 0x7e));
  }
  return out;
}

/** A string sized to probe byte/codepoint/grapheme caps around `cap`. */
export function boundaryString(
  rng: Prng,
  cap: number,
): { value: string; kind: string } {
  const kind = rng.pick([
    "ascii-at-cap",
    "ascii-cap+1",
    "ascii-64k",
    "ascii-1m",
    "astral-half-cap", // cap UTF-16 units, cap/2 code points, 2*cap bytes
    "astral-cap-codepoints", // 2*cap UTF-16 units
    "cjk-at-cap", // cap UTF-16 units, 3*cap bytes
    "zwj-family-at-cap",
    "combining-at-cap",
    "nul-padded",
    "whitespace-only",
    "whitespace-wrapped",
    "empty",
  ]);
  switch (kind) {
    case "ascii-at-cap":
      return { value: randomAscii(rng, cap), kind };
    case "ascii-cap+1":
      return { value: randomAscii(rng, cap + 1), kind };
    case "ascii-64k":
      return { value: randomAscii(rng, 65_536 + rng.int(0, 64)), kind };
    case "ascii-1m":
      return { value: "A".repeat(1_048_576), kind };
    case "astral-half-cap":
      return { value: "\u{1F600}".repeat(Math.floor(cap / 2)), kind };
    case "astral-cap-codepoints":
      return { value: "\u{1F600}".repeat(cap), kind };
    case "cjk-at-cap":
      return { value: "\u4e2d".repeat(cap), kind };
    case "zwj-family-at-cap":
      return {
        value: GRAPHEME_CLUSTERS[0].repeat(
          Math.ceil(cap / GRAPHEME_CLUSTERS[0].length),
        ),
        kind,
      };
    case "combining-at-cap":
      return { value: "a" + "\u0301".repeat(cap - 1), kind };
    case "nul-padded":
      return {
        value: randomAscii(rng, rng.int(1, 40)) +
          "\u0000".repeat(rng.int(1, 8)),
        kind,
      };
    case "whitespace-only":
      return {
        value: rng.pick([" ", "\t", "\n", "\r\n", "\u00a0", "\u2003", "\u3000"])
          .repeat(rng.int(1, 12)),
        kind,
      };
    case "whitespace-wrapped":
      return { value: ` \t${randomAscii(rng, rng.int(1, 30))}\n\r`, kind };
    default:
      return { value: "", kind };
  }
}

/** Wrong-type / malformed JSON values as parsed JS values. */
export function wrongTypeValue(rng: Prng): { value: unknown; kind: string } {
  const kind = rng.pick([
    "null",
    "true",
    "false",
    "number",
    "weird-number",
    "empty-array",
    "array-of-strings",
    "empty-object",
    "nested-object",
    "proto-object",
    "deep-nesting",
    "huge-array",
  ]);
  switch (kind) {
    case "null":
      return { value: null, kind };
    case "true":
      return { value: true, kind };
    case "false":
      return { value: false, kind };
    case "number":
      return { value: rng.int(-1_000_000, 1_000_000), kind };
    case "weird-number":
      return { value: rng.pick(WEIRD_NUMBERS), kind };
    case "empty-array":
      return { value: [], kind };
    case "array-of-strings":
      return { value: [randomAscii(rng, 8), randomAscii(rng, 8)], kind };
    case "empty-object":
      return { value: {}, kind };
    case "nested-object":
      return { value: { appleAuthorizationCode: randomAscii(rng, 12) }, kind };
    case "proto-object": {
      const out: Record<string, unknown> = {};
      out[rng.pick(PROTO_KEYS)] = { polluted: true };
      return { value: out, kind };
    }
    case "deep-nesting": {
      let v: unknown = randomAscii(rng, 4);
      for (let i = 0; i < 200; i += 1) v = [v];
      return { value: v, kind };
    }
    default:
      return { value: Array.from({ length: 10_000 }, (_, i) => i), kind };
  }
}

/** Raw request-body texts: malformed/truncated JSON, prototype pollution as
 * text, numeric literals JSON.parse cannot represent, BOMs, NULs. */
export function rawBodyText(
  rng: Prng,
  field: string,
  good: string,
): { text: string; kind: string } {
  const validObject = JSON.stringify({ [field]: good });
  const kind = rng.pick([
    "truncated",
    "trailing-garbage",
    "single-quotes",
    "unquoted-key",
    "trailing-comma",
    "bom-prefixed",
    "nul-inside",
    "proto-text",
    "numeric-overflow-field",
    "bare-string",
    "bare-number",
    "bare-null",
    "array-top",
    "empty",
    "whitespace",
    "duplicate-key-last-wins",
    "duplicate-key-first-good",
    "unicode-escape-lone-surrogate",
    "deep-nesting-100k",
    "comment",
    "nan-literal",
    "infinity-literal",
    "hex-literal",
  ]);
  switch (kind) {
    case "truncated":
      return {
        text: validObject.slice(0, rng.int(1, validObject.length - 1)),
        kind,
      };
    case "trailing-garbage":
      return {
        text: validObject + rng.pick(["x", "}", "]", ",", "{}", "\u0000"]),
        kind,
      };
    case "single-quotes":
      return { text: `{'${field}': '${good}'}`, kind };
    case "unquoted-key":
      return { text: `{${field}: "${good}"}`, kind };
    case "trailing-comma":
      return { text: `{"${field}": "${good}",}`, kind };
    case "bom-prefixed":
      return { text: "\ufeff" + validObject, kind };
    case "nul-inside":
      return {
        text: validObject.slice(0, 3) + "\u0000" + validObject.slice(3),
        kind,
      };
    case "proto-text":
      return {
        text:
          `{"__proto__": {"${field}": "${good}"}, "constructor": {"prototype": {"${field}": "${good}"}}}`,
        kind,
      };
    case "numeric-overflow-field":
      return { text: `{"${field}": ${rng.pick(WEIRD_NUMERIC_JSON)}}`, kind };
    case "bare-string":
      return { text: JSON.stringify(good), kind };
    case "bare-number":
      return { text: rng.pick(WEIRD_NUMERIC_JSON), kind };
    case "bare-null":
      return { text: "null", kind };
    case "array-top":
      return { text: `[${validObject}]`, kind };
    case "empty":
      return { text: "", kind };
    case "whitespace":
      return { text: " \n\t ", kind };
    case "duplicate-key-last-wins":
      return { text: `{"${field}": "${good}", "${field}": 12345}`, kind };
    case "duplicate-key-first-good":
      return { text: `{"${field}": "${good}", "${field}": null}`, kind };
    case "unicode-escape-lone-surrogate":
      return { text: `{"${field}": "\\ud800${good}"}`, kind };
    case "deep-nesting-100k":
      return { text: "[".repeat(100_000), kind };
    case "comment":
      return { text: `{"${field}": "${good}" /* c */}`, kind };
    case "nan-literal":
      return { text: `{"${field}": NaN}`, kind };
    case "infinity-literal":
      return { text: `{"${field}": Infinity}`, kind };
    default:
      return { text: `{"${field}": 0x10}`, kind };
  }
}

// ─── result table ─────────────────────────────────────────────────────────────

export type Verdict = "HELD" | "BROKEN";

export interface ScenarioRow {
  family: string;
  index: number;
  seed: number;
  input: string;
  outcome: string;
  expected: string;
  verdict: Verdict;
  note?: string;
}

export interface FamilyReport {
  family: string;
  iterations: number;
  held: number;
  broken: number;
  outcomes: Record<string, number>;
  brokenSeeds: number[];
  rows: ScenarioRow[];
  replay: string;
}

export function outDir(): string {
  const configured = Deno.env.get("STRESS_OUT_DIR");
  const dir = configured && configured.trim() !== "" ? configured : new URL(
    "../../../../artifacts/stress-external-accounts/",
    import.meta.url,
  ).pathname;
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

export function replayCommand(
  family: string,
  seed: number,
  file: string,
): string {
  return `STRESS_ITER=1 STRESS_SEED=${seed} STRESS_ONLY=${family} STRESS_REPLAY_SEED=${seed} deno test -A --no-check --config deno.json ${file} --filter "${family}"`;
}

/** Truncate long inputs for the JSON table while keeping them identifiable. */
export function describeInput(value: unknown, max = 160): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (typeof value === "number") {
    text = Object.is(value, -0) ? "-0" : String(value);
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > max) return `${text.slice(0, max)}…(len=${text.length})`;
  return text;
}

export class Campaign {
  readonly rows: ScenarioRow[] = [];
  readonly outcomes: Record<string, number> = {};
  constructor(readonly family: string, readonly file: string) {}

  record(row: Omit<ScenarioRow, "family">): void {
    this.rows.push({ family: this.family, ...row });
    this.outcomes[row.outcome] = (this.outcomes[row.outcome] ?? 0) + 1;
  }

  report(): FamilyReport {
    const broken = this.rows.filter((row) => row.verdict === "BROKEN");
    return {
      family: this.family,
      iterations: this.rows.length,
      held: this.rows.length - broken.length,
      broken: broken.length,
      outcomes: this.outcomes,
      brokenSeeds: broken.map((row) => row.seed),
      rows: this.rows,
      replay: this.replay(),
    };
  }

  replay(seed?: number): string {
    return replayCommand(this.family, seed ?? STRESS_SEED, this.file);
  }

  write(): { path: string; report: FamilyReport } {
    const report = this.report();
    const path = `${outDir()}/${this.family}.json`;
    Deno.writeTextFileSync(path, JSON.stringify(report, null, 2));
    return { path, report };
  }
}

/** Iterate seeds for a family. STRESS_REPLAY_SEED pins a single scenario. */
export function seedsFor(
  family: string,
): Array<{ index: number; seed: number }> {
  const replay = Deno.env.get("STRESS_REPLAY_SEED");
  if (replay && replay.trim() !== "") {
    return [{ index: -1, seed: Number(replay) >>> 0 }];
  }
  return Array.from(
    { length: STRESS_ITER },
    (_, index) => ({ index, seed: scenarioSeed(family, index) }),
  );
}

export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `non-error thrown: ${describeInput(error, 80)}`;
}

/** Strings a generic 5xx/4xx body must never carry (internal detail leak). */
export const LEAK_MARKERS: readonly string[] = [
  "atob",
  "InvalidCharacter",
  "account_external_credentials",
  "    at ",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "OperationError",
  "APPLE_TOKEN_ENCRYPTION_KEY",
  "APPLE_SIGN_IN",
  "service-role",
  "sk_test",
  "PGRST",
  "supabase.test",
];

export function leakedDetail(text: string): string | null {
  for (const marker of LEAK_MARKERS) if (text.includes(marker)) return marker;
  return null;
}
