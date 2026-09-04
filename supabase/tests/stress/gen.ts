/**
 * Seeded generators for the boundary/malformed-input stress harness.
 *
 * Every value is derived from a `Prng` seeded per iteration, so a failing
 * iteration replays from its seed alone. Each candidate carries an ORACLE
 * (`expect`): what the schema is supposed to do with it —
 *   "accept"  the value is inside the documented contract
 *   "reject"  the value violates a documented constraint / type
 *   "either"  the contract does not say (only graceful handling is asserted)
 * plus `tags` naming the lens category the value exercises.
 */

export type Expect = "accept" | "reject" | "either";

export interface Candidate<T = string | null> {
  value: T;
  expect: Expect;
  tags: string[];
  /** Human-readable summary (values may be 64 KiB+; never log them raw). */
  note: string;
  /** Set when the value is accepted by the schema but violates a stricter
   * contract enforced elsewhere (edge parser / product intent). Recorded as a
   * policy gap, never as a schema break. */
  policyGap?: string;
}

/** splitmix32 — small, fast, and good enough for replayable fuzzing. */
export class Prng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    this.s = (this.s + 0x9e3779b9) >>> 0;
    let z = this.s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    z = (z ^ (z >>> 15)) >>> 0;
    return z / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(0, arr.length - 1)];
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  hex(n: number): string {
    let out = "";
    for (let i = 0; i < n; i++) out += this.int(0, 15).toString(16);
    return out;
  }
  uuid(): string {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 + this.int(0, 3)).toString(
      16,
    )}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

export function iterSeed(campaignSeed: number, i: number): number {
  let h = (campaignSeed ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;
export const codepoints = (s: string): number => [...s].length;
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemes = (s: string): number => [...segmenter.segment(s)].length;

export function describe(s: string): string {
  const head = [...s].slice(0, 24).join("");
  return `${JSON.stringify(head)}${codepoints(s) > 24 ? "…" : ""} bytes=${utf8Bytes(s)} cp=${codepoints(
    s,
  )} gr=${graphemes(s)}`;
}

// ---------------------------------------------------------------- strings

const FAMILY = "👨‍👩‍👧‍👦"; // 7 codepoints, 1 grapheme
const FLAG = "🇺🇸"; // 2 codepoints, 1 grapheme
const E_NFC = "é"; // U+00E9
const E_NFD = "e\u0301"; // 2 codepoints, 1 grapheme
const ANGSTROM_PAIR = ["Å", "\u212b"]; // U+00C5 vs U+212B (NFC-equivalent)

const PATH_TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc",
  "/../../../",
  "....//....//",
  "..%c0%af..%c0%af",
];
const INJECTION = [
  "'; drop table public.sessions; --",
  '" or 1=1 --',
  "$1::text",
  "{{7*7}}",
  "${jndi:ldap://x}",
  "<script>alert(1)</script>",
  "\u202e\u0670practice",
];
const PROTO_KEYS = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"];

/** Strings for a `text` column whose documented cap is `cap` codepoints
 * (`length()` counts codepoints). `null` allowed when `nullable`. */
export function textFor(rng: Prng, cap: number, nullable: boolean): Candidate {
  const cases: Array<() => Candidate> = [
    () => ({ value: "ok", expect: "accept", tags: ["plain"], note: "plain ascii" }),
    () => ({ value: "", expect: "accept", tags: ["empty"], note: "empty string" }),
    () => ({
      value: "a".repeat(cap),
      expect: "accept",
      tags: ["cap", "at-cap"],
      note: `ascii at cap ${cap}`,
    }),
    () => ({
      value: "a".repeat(cap + 1),
      expect: "reject",
      tags: ["cap", "cap+1"],
      note: `ascii cap+1 ${cap + 1}`,
    }),
    () => ({
      value: "字".repeat(cap),
      expect: "accept",
      tags: ["cap", "bytes>cap", "cjk"],
      note: `cjk ${cap} codepoints = ${cap * 3} bytes (byte count exceeds cap, codepoints do not)`,
    }),
    () => ({
      value: E_NFD.repeat(Math.floor(cap / 2)),
      expect: "accept",
      tags: ["cap", "unicode-nfd", "graphemes<cap"],
      note: `NFD e+combining x${Math.floor(cap / 2)} = ${cap} codepoints, ${Math.floor(
        cap / 2,
      )} graphemes`,
    }),
    () => ({
      value: E_NFD.repeat(Math.floor(cap / 2) + 1),
      expect: "reject",
      tags: ["cap", "unicode-nfd", "cp>cap"],
      note: `NFD pairs ${cap + 2} codepoints (graphemes ${Math.floor(cap / 2) + 1} < cap)`,
    }),
    () => ({
      value: E_NFC.repeat(cap),
      expect: "accept",
      tags: ["cap", "unicode-nfc"],
      note: `NFC é x${cap}`,
    }),
    () => ({
      value: FAMILY.repeat(Math.ceil(cap / 7)),
      expect: Math.ceil(cap / 7) * 7 > cap ? "reject" : "accept",
      tags: ["cap", "grapheme-cluster", "zwj"],
      note: `family emoji x${Math.ceil(cap / 7)} (${Math.ceil(cap / 7) * 7} cp, ${Math.ceil(
        cap / 7,
      )} graphemes)`,
    }),
    () => ({
      value: FLAG.repeat(Math.floor(cap / 2)),
      expect: "accept",
      tags: ["cap", "grapheme-cluster", "flag"],
      note: `flag pairs at cap`,
    }),
    () => ({
      value: "x".repeat(65536),
      expect: "reject",
      tags: ["64k", "cap"],
      note: "64 KiB ascii",
    }),
    () => ({
      value: "x".repeat(65537),
      expect: "reject",
      tags: ["64k+1", "cap"],
      note: "64 KiB + 1 ascii",
    }),
    () => ({
      value: "字".repeat(65536),
      expect: "reject",
      tags: ["64k", "cjk", "cap"],
      note: "65536 cjk codepoints (196608 bytes)",
    }),
    () => ({
      value: rng.pick(PATH_TRAVERSAL),
      expect: "accept",
      tags: ["path-traversal"],
      note: "path traversal (free text column: stored verbatim by contract)",
    }),
    () => ({
      value: rng.pick(INJECTION),
      expect: "accept",
      tags: ["injection"],
      note: "injection-looking text (parameterised: stored verbatim)",
    }),
    () => ({
      value: rng.pick(PROTO_KEYS),
      expect: "accept",
      tags: ["proto-key"],
      note: "prototype-pollution key as text",
    }),
    () => ({
      value: rng.pick(ANGSTROM_PAIR),
      expect: "accept",
      tags: ["unicode-normalization"],
      note: "angstrom normalization pair",
    }),
    () => ({
      value: "\u0000",
      expect: "reject",
      tags: ["nul"],
      note: "lone NUL byte",
    }),
    () => ({
      value: `ok\u0000${rng.pick(["", "tail", "'; --"])}`,
      expect: "reject",
      tags: ["nul", "embedded"],
      note: "embedded NUL",
    }),
    () => ({
      value: "\u0001\u0002\u0003\u001f\u007f",
      expect: "accept",
      tags: ["control-chars"],
      note: "C0 control chars (valid UTF-8; postgres text accepts)",
    }),
    () => ({
      value: "\ufeff\u200b\u2060 ",
      expect: "accept",
      tags: ["invisible"],
      note: "BOM/ZWSP/WJ/space",
    }),
    () => ({
      value: "\ufffd\ufffe\uffff",
      expect: "accept",
      tags: ["noncharacters"],
      note: "U+FFFD/U+FFFE/U+FFFF",
    }),
    () => ({
      value: "\u{10ffff}".repeat(Math.min(cap, 8)),
      expect: "accept",
      tags: ["astral"],
      note: "U+10FFFF (4-byte)",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  }
  return rng.pick(cases)();
}

/** Text where the column is an enum-like CHECK (`allowed` values). */
export function enumFor(rng: Prng, allowed: readonly string[], nullable: boolean): Candidate {
  const good = rng.pick(allowed);
  const cases: Array<() => Candidate> = [
    () => ({ value: good, expect: "accept", tags: ["enum-valid"], note: `valid ${good}` }),
    () => ({
      value: good.toUpperCase(),
      expect: "reject",
      tags: ["enum-case"],
      note: `uppercase ${good}`,
    }),
    () => ({
      value: `${good} `,
      expect: "reject",
      tags: ["enum-trailing-space"],
      note: "trailing space",
    }),
    () => ({
      value: ` ${good}`,
      expect: "reject",
      tags: ["enum-leading-space"],
      note: "leading space",
    }),
    () => ({ value: `${good}\u0000`, expect: "reject", tags: ["enum", "nul"], note: "NUL suffix" }),
    () => ({
      value: `${good}\u200b`,
      expect: "reject",
      tags: ["enum", "invisible"],
      note: "ZWSP suffix",
    }),
    () => ({
      value: good.replace(/a/g, "\u0430"),
      expect: good.includes("a") ? "reject" : "accept",
      tags: ["enum", "homoglyph"],
      note: "cyrillic а homoglyph",
    }),
    () => ({ value: "", expect: "reject", tags: ["enum", "empty"], note: "empty" }),
    () => ({ value: "x".repeat(65536), expect: "reject", tags: ["enum", "64k"], note: "64 KiB" }),
    () => ({
      value: rng.pick(PATH_TRAVERSAL),
      expect: "reject",
      tags: ["enum", "path-traversal"],
      note: "traversal",
    }),
    () => ({
      value: rng.pick(PROTO_KEYS),
      expect: "reject",
      tags: ["enum", "proto-key"],
      note: "proto key",
    }),
    () => ({
      value: good.slice(0, -1),
      expect: "reject",
      tags: ["enum", "truncated"],
      note: "truncated",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  } else {
    cases.push(() => ({
      value: null,
      expect: "reject",
      tags: ["null", "not-null"],
      note: "NULL into NOT NULL",
    }));
  }
  return rng.pick(cases)();
}

// ---------------------------------------------------------------- uuids

export const NIL_UUID = "00000000-0000-0000-0000-000000000000";
export const MAX_UUID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

/** UUID-typed column input (text → `::uuid`). Fresh valid ids come from the
 * iteration prng so replays regenerate the same id. */
export function uuidFor(rng: Prng, nullable: boolean): Candidate {
  const fresh = rng.uuid();
  const cases: Array<() => Candidate> = [
    () => ({ value: fresh, expect: "accept", tags: ["uuid-valid"], note: "fresh v4" }),
    () => ({
      value: fresh.toUpperCase(),
      expect: "accept",
      tags: ["uuid-upper"],
      note: "uppercase (postgres accepts)",
    }),
    () => ({
      value: `{${fresh}}`,
      expect: "accept",
      tags: ["uuid-braces"],
      note: "braced (postgres accepts)",
    }),
    () => ({
      value: fresh.replace(/-/g, ""),
      expect: "accept",
      tags: ["uuid-nohyphen"],
      note: "32 hex no hyphens (postgres accepts)",
    }),
    () => ({ value: NIL_UUID, expect: "accept", tags: ["uuid-nil"], note: "nil uuid" }),
    () => ({ value: MAX_UUID, expect: "accept", tags: ["uuid-max"], note: "max uuid" }),
    () => ({
      value: fresh.slice(0, 35),
      expect: "reject",
      tags: ["uuid-truncated"],
      note: "35 chars",
    }),
    () => ({ value: `${fresh}0`, expect: "reject", tags: ["uuid-long"], note: "37 chars" }),
    () => ({
      value: `${fresh}/../${rng.hex(4)}`,
      expect: "reject",
      tags: ["uuid", "path-traversal"],
      note: "traversal suffix",
    }),
    () => ({
      value: `${fresh.slice(0, 20)}\u0000${fresh.slice(21)}`,
      expect: "reject",
      tags: ["uuid", "nul"],
      note: "NUL inside",
    }),
    () => ({
      value: "g".repeat(8) + fresh.slice(8),
      expect: "reject",
      tags: ["uuid-nonhex"],
      note: "non-hex chars",
    }),
    () => ({ value: "", expect: "reject", tags: ["uuid", "empty"], note: "empty" }),
    () => ({
      value: "null",
      expect: "reject",
      tags: ["uuid", "string-null"],
      note: "the string null",
    }),
    () => ({
      value: "undefined",
      expect: "reject",
      tags: ["uuid", "string-undefined"],
      note: "the string undefined",
    }),
    () => ({
      value: "[object Object]",
      expect: "reject",
      tags: ["uuid", "wrong-type"],
      note: "stringified object",
    }),
    () => ({ value: "1", expect: "reject", tags: ["uuid", "wrong-type"], note: "number" }),
    () => ({
      value: rng.pick(PROTO_KEYS),
      expect: "reject",
      tags: ["uuid", "proto-key"],
      note: "proto key",
    }),
    () => ({
      value: rng.pick(PATH_TRAVERSAL),
      expect: "reject",
      tags: ["uuid", "path-traversal"],
      note: "traversal",
    }),
    () => ({ value: "x".repeat(65536), expect: "reject", tags: ["uuid", "64k"], note: "64 KiB" }),
    () => ({
      value: ` ${fresh} `,
      expect: "reject",
      tags: ["uuid", "whitespace"],
      note: "surrounding whitespace (uuid_in does not trim)",
    }),
    () => ({
      value: fresh.replace(/-/g, "\u2010"),
      expect: "reject",
      tags: ["uuid", "unicode-hyphen"],
      note: "U+2010 hyphens",
    }),
    () => ({
      value: fresh.replace(/[0-9]/g, (d) => String.fromCodePoint(0xff10 + Number(d))),
      expect: "reject",
      tags: ["uuid", "fullwidth"],
      note: "fullwidth digits",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  } else {
    cases.push(() => ({
      value: null,
      expect: "reject",
      tags: ["null", "not-null"],
      note: "NULL into NOT NULL",
    }));
  }
  return rng.pick(cases)();
}

// ---------------------------------------------------------------- numbers

/** `integer` column input via `$n::int` with `min` lower CHECK bound. */
export function int4For(rng: Prng, min: number, nullable: boolean): Candidate {
  const cases: Array<() => Candidate> = [
    () => ({
      value: String(rng.int(min, 1000)),
      expect: "accept",
      tags: ["int-plain"],
      note: "in range",
    }),
    () => ({ value: "0", expect: min <= 0 ? "accept" : "reject", tags: ["int-zero"], note: "0" }),
    () => ({
      value: "-0",
      expect: min <= 0 ? "accept" : "reject",
      tags: ["neg-zero"],
      note: "-0 (int4 folds to 0)",
    }),
    () => ({ value: "2147483647", expect: "accept", tags: ["int-max"], note: "2^31-1" }),
    () => ({
      value: "2147483648",
      expect: "reject",
      tags: ["overflow", "int-max+1"],
      note: "2^31",
    }),
    () => ({
      value: "-2147483648",
      expect: min <= -2147483648 ? "accept" : "reject",
      tags: ["int-min"],
      note: "-2^31",
    }),
    () => ({
      value: "-2147483649",
      expect: "reject",
      tags: ["overflow", "int-min-1"],
      note: "-2^31-1",
    }),
    () => ({
      value: "9007199254740993",
      expect: "reject",
      tags: ["overflow", "2^53+1"],
      note: "2^53+1",
    }),
    () => ({
      value: "1e308",
      expect: "reject",
      tags: ["wrong-type", "exponent"],
      note: "1e308 (not int syntax)",
    }),
    () => ({
      value: "-1",
      expect: min <= -1 ? "accept" : "reject",
      tags: ["negative"],
      note: "-1",
    }),
    () => ({ value: "1.5", expect: "reject", tags: ["wrong-type", "float"], note: "1.5" }),
    () => ({ value: "1.0", expect: "reject", tags: ["wrong-type", "float"], note: "1.0" }),
    () => ({ value: "NaN", expect: "reject", tags: ["nan"], note: "NaN" }),
    () => ({ value: "Infinity", expect: "reject", tags: ["infinity"], note: "Infinity" }),
    () => ({ value: "-Infinity", expect: "reject", tags: ["infinity"], note: "-Infinity" }),
    () => ({ value: "", expect: "reject", tags: ["empty"], note: "empty" }),
    () => ({ value: " 42 ", expect: "accept", tags: ["whitespace"], note: "whitespace padded" }),
    () => ({ value: "+7", expect: "accept", tags: ["plus-sign"], note: "+7" }),
    () => ({
      value: "0x1A",
      expect: "accept",
      tags: ["hex-literal"],
      note: "hex literal = 26 (PG16 int4in accepts non-decimal literals)",
      policyGap: "pg16_nondecimal_literal_accepted",
    }),
    () => ({
      value: "1_000",
      expect: "accept",
      tags: ["underscore-literal"],
      note: "underscore digits = 1000 (PG16)",
      policyGap: "pg16_nondecimal_literal_accepted",
    }),
    () => ({ value: "٣", expect: "reject", tags: ["unicode-digit"], note: "arabic-indic digit" }),
    () => ({ value: "true", expect: "reject", tags: ["wrong-type", "bool"], note: "true" }),
    () => ({ value: "[]", expect: "reject", tags: ["wrong-type", "empty-array"], note: "[]" }),
    () => ({ value: "{}", expect: "reject", tags: ["wrong-type", "empty-object"], note: "{}" }),
    () => ({ value: "1\u0000", expect: "reject", tags: ["nul"], note: "NUL suffix" }),
    () => ({
      value: "9".repeat(65536),
      expect: "reject",
      tags: ["64k", "overflow"],
      note: "64 KiB of 9s",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  } else {
    cases.push(() => ({
      value: null,
      expect: "reject",
      tags: ["null", "not-null"],
      note: "NULL into NOT NULL",
    }));
  }
  return rng.pick(cases)();
}

/** `numeric(precision, scale)` column input with CHECK `>= 0` and optionally
 * `<= 1`. The declared scale ROUNDS the input before the CHECK runs, so a
 * value within half an ulp of a boundary legitimately lands on it ("either"),
 * and a declared precision refuses Infinity / too many integer digits. */
export function numericFor(
  rng: Prng,
  unitInterval: boolean,
  nullable: boolean,
  typmod: { precision: number; scale: number } = { precision: 6, scale: 2 },
): Candidate {
  const intDigits = typmod.precision - typmod.scale;
  const cases: Array<() => Candidate> = [
    () => ({
      value: unitInterval ? "0.5" : "29.97",
      expect: "accept",
      tags: ["numeric-plain"],
      note: "in range",
    }),
    () => ({ value: "0", expect: "accept", tags: ["numeric-zero"], note: "0" }),
    () => ({ value: "-0", expect: "accept", tags: ["neg-zero"], note: "-0 (numeric folds to 0)" }),
    () => ({ value: "-0.0", expect: "accept", tags: ["neg-zero"], note: "-0.0" }),
    () => ({ value: "1", expect: "accept", tags: ["numeric-one"], note: "1" }),
    () => ({
      value: "1.0000000000000000001",
      expect: unitInterval ? "either" : "accept",
      tags: ["numeric-eps", "scale-round"],
      note: `1+1e-19 (scale ${typmod.scale} rounds to 1)`,
    }),
    () => ({
      value: "-0.0000000000000000001",
      expect: "either",
      tags: ["numeric-neg-eps", "scale-round"],
      note: `-1e-19 (scale ${typmod.scale} rounds to 0)`,
    }),
    () => ({
      value: `${"9".repeat(intDigits)}.${"9".repeat(typmod.scale)}`,
      expect: unitInterval ? "reject" : "accept",
      tags: ["numeric-max"],
      note: `max representable for numeric(${typmod.precision},${typmod.scale})`,
    }),
    () => ({
      value: `1${"0".repeat(intDigits)}`,
      expect: "reject",
      tags: ["overflow", "precision"],
      note: `10^${intDigits} (one integer digit too many)`,
    }),
    () => ({
      value: `${"9".repeat(intDigits)}.${"9".repeat(typmod.scale)}5`,
      expect: "reject",
      tags: ["overflow", "scale-round"],
      note: "max + half ulp rounds up past precision",
    }),
    () => ({
      value: `0.${"0".repeat(typmod.scale)}5`,
      expect: "accept",
      tags: ["scale-round", "half-ulp"],
      note: "half ulp (rounds to 1 ulp, in range)",
    }),
    () => ({
      value: "1e308",
      expect: "reject",
      tags: ["big", "overflow"],
      note: "1e308 (precision overflow)",
    }),
    () => ({
      value: "1e-400",
      expect: "accept",
      tags: ["tiny", "scale-round"],
      note: "1e-400 (rounds to 0)",
    }),
    () => ({
      value: "1e200000",
      expect: "reject",
      tags: ["overflow"],
      note: "1e200000 (numeric overflow)",
    }),
    () => ({
      value: "NaN",
      expect: unitInterval ? "reject" : "accept",
      tags: ["nan"],
      note: unitInterval ? "NaN (NaN <= 1 is false)" : "NaN — numeric NaN >= 0 is TRUE in postgres",
      policyGap: unitInterval ? undefined : "numeric_nan_passes_ge0",
    }),
    () => ({
      value: "Infinity",
      expect: "reject",
      tags: ["infinity"],
      note: "Infinity (declared precision cannot hold it)",
    }),
    () => ({ value: "-Infinity", expect: "reject", tags: ["infinity"], note: "-Infinity" }),
    () => ({ value: "-1", expect: "reject", tags: ["negative"], note: "-1" }),
    () => ({
      value: "0x10",
      expect: unitInterval ? "reject" : "accept",
      tags: ["hex-literal"],
      note: unitInterval
        ? "hex = 16 (> 1)"
        : "hex literal = 16 (PG16 numeric_in accepts non-decimal literals)",
      policyGap: unitInterval ? undefined : "pg16_nondecimal_literal_accepted",
    }),
    () => ({ value: "", expect: "reject", tags: ["empty"], note: "empty" }),
    () => ({ value: "abc", expect: "reject", tags: ["wrong-type"], note: "abc" }),
    () => ({ value: "0.5\u0000", expect: "reject", tags: ["nul"], note: "NUL suffix" }),
    () => ({
      value: "9".repeat(65536),
      expect: "reject",
      tags: ["64k", "overflow"],
      note: "64 KiB of 9s (precision overflow)",
    }),
    () => ({
      value: "9".repeat(140000),
      expect: "reject",
      tags: ["overflow", "huge"],
      note: "140000 digits (numeric overflow)",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  } else {
    cases.push(() => ({
      value: null,
      expect: "reject",
      tags: ["null", "not-null"],
      note: "NULL into NOT NULL",
    }));
  }
  return rng.pick(cases)();
}

// ---------------------------------------------------------------- timestamps

/** `timestamptz` input. When `bounded`, the column carries the
 * `[2000-01-01, 2100-01-01)` CHECK; otherwise any parseable value is stored
 * and the out-of-policy ones are recorded as a policy gap. */
export function timestampFor(rng: Prng, bounded: boolean, nullable: boolean): Candidate {
  const parseable = (
    value: string,
    tags: string[],
    note: string,
    inPolicy: boolean,
  ): Candidate => ({
    value,
    expect: inPolicy ? "accept" : bounded ? "reject" : "accept",
    tags,
    note,
    policyGap: inPolicy || bounded ? undefined : "timestamp_outside_2000_2100",
  });
  const y = rng.int(2000, 2099);
  const m = String(rng.int(1, 12)).padStart(2, "0");
  const d = String(rng.int(1, 28)).padStart(2, "0");
  const cases: Array<() => Candidate> = [
    () => parseable(`${y}-${m}-${d}T10:00:00.000Z`, ["iso-valid"], "iso utc", true),
    () => parseable(`${y}-${m}-${d} 10:00:00+00`, ["iso-space"], "space separator", true),
    () =>
      parseable(
        `${y}-${m}-${d}T10:00:00.1234567Z`,
        ["iso-subµs"],
        "7 fractional digits (rounds to µs)",
        true,
      ),
    () =>
      parseable(
        `${y}-${m}-${d}T24:00:00Z`,
        ["hour-24"],
        "24:00:00 (postgres rolls to next day)",
        true,
      ),
    () => parseable(`${y}-${m}-${d}T10:00:00+15:59:59`, ["tz-max"], "max tz displacement", true),
    () => parseable("1999-12-31T23:59:59.999Z", ["bound", "below-2000"], "1 ms before 2000", false),
    () => parseable("2000-01-01T00:00:00Z", ["bound", "at-2000"], "exactly 2000-01-01", true),
    () =>
      parseable("2099-12-31T23:59:59.999999Z", ["bound", "last-µs-2099"], "last µs of 2099", true),
    () =>
      parseable(
        "2100-01-01T00:00:00Z",
        ["bound", "at-2100"],
        "exactly 2100-01-01 (exclusive)",
        false,
      ),
    () => parseable("infinity", ["infinity"], "infinity", false),
    () => parseable("-infinity", ["infinity"], "-infinity", false),
    () => parseable("epoch", ["special"], "epoch (1970)", false),
    () => parseable("0001-01-01T00:00:00Z", ["year-0001"], "year 1", false),
    () => parseable("4714-11-24 00:00:00+00 BC", ["bc-min"], "postgres min date", false),
    () => parseable("9999-12-31T23:59:59Z", ["year-9999"], "year 9999", false),
    () => parseable("294276-12-31T00:00:00Z", ["year-max"], "postgres max year", false),
    () => parseable("J2461000", ["julian"], "julian day (2025)", true),
    () => ({ value: "now", expect: "accept", tags: ["special-now"], note: "now" }),
    () => ({ value: "today", expect: "accept", tags: ["special-today"], note: "today" }),
    () => ({
      value: "294277-01-01T00:00:00Z",
      expect: "reject",
      tags: ["overflow", "year-max+1"],
      note: "beyond max year",
    }),
    () => ({
      value: `${y}-02-30T00:00:00Z`,
      expect: "reject",
      tags: ["calendar", "feb-30"],
      note: "feb 30",
    }),
    () => ({
      value: "2026-02-29T00:00:00Z",
      expect: "reject",
      tags: ["calendar", "non-leap"],
      note: "feb 29 non-leap",
    }),
    () => ({
      value: `${y}-13-01T00:00:00Z`,
      expect: "reject",
      tags: ["calendar", "month-13"],
      note: "month 13",
    }),
    () => ({
      value: `${y}-${m}-${d}T23:60:00Z`,
      expect: "reject",
      tags: ["calendar", "minute-60"],
      note: "minute 60",
    }),
    () => ({
      value: `${y}-${m}-${d}T10:00:00+16:00`,
      expect: "reject",
      tags: ["tz-overflow"],
      note: "tz +16:00",
    }),
    () => ({
      value: `${y}-${m}-${d}T10:00:00+25:00`,
      expect: "reject",
      tags: ["tz-overflow"],
      note: "tz +25:00",
    }),
    () => ({
      value: "1700000000",
      expect: "reject",
      tags: ["wrong-type", "epoch-seconds"],
      note: "epoch seconds as text",
    }),
    () => ({
      value: "1700000000000",
      expect: "reject",
      tags: ["wrong-type", "epoch-ms"],
      note: "epoch ms as text",
    }),
    () => ({ value: "", expect: "reject", tags: ["empty"], note: "empty" }),
    () => ({ value: "not a date", expect: "reject", tags: ["wrong-type"], note: "prose" }),
    () => ({ value: "NaN", expect: "reject", tags: ["nan"], note: "NaN" }),
    () => ({
      value: "allballs",
      expect: "reject",
      tags: ["special-time-only"],
      note: "time-only literal",
    }),
    () => ({
      value: `${y}-${m}-${d}T10:00:00Z\u0000`,
      expect: "reject",
      tags: ["nul"],
      note: "NUL suffix",
    }),
    () => ({
      value: `${y}-${m}-${d}T10:00:00Z`.replace(/[0-9]/g, (c) =>
        String.fromCodePoint(0xff10 + Number(c)),
      ),
      expect: "reject",
      tags: ["fullwidth"],
      note: "fullwidth digits",
    }),
    () => ({
      value: `${y}-${m}-${d}T10:00:00Z${" ".repeat(65536)}x`,
      expect: "reject",
      tags: ["64k"],
      note: "64 KiB padded + junk",
    }),
    () => ({ value: "x".repeat(65536), expect: "reject", tags: ["64k"], note: "64 KiB junk" }),
    () => ({
      value: "../../2026-01-01",
      expect: "reject",
      tags: ["path-traversal"],
      note: "traversal",
    }),
  ];
  if (nullable) {
    cases.push(() => ({ value: null, expect: "accept", tags: ["null"], note: "SQL NULL" }));
  } else {
    cases.push(() => ({
      value: null,
      expect: "reject",
      tags: ["null", "not-null"],
      note: "NULL into NOT NULL",
    }));
  }
  return rng.pick(cases)();
}

// ---------------------------------------------------------------- jsonb

export interface JsonCandidate extends Candidate<string> {
  /** JSON.stringify(...).length of the text as the edge would measure it
   * (UTF-16 code units); undefined for unparseable text. */
  textLength?: number;
  /** true when the text parses as JSON (so jsonb should accept unless a
   * size/depth limit fires). */
  parses: boolean;
  /** true when the intent is to probe the 262144-byte pg_column_size cap. */
  sizeProbe?: boolean;
}

function trialBase(rng: Prng, trialId: string): Record<string, unknown> {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId,
    captureId: rng.uuid(),
    analysisId: null,
    capturedAtIso: "2026-09-01T10:00:00.000Z",
    recordedAtIso: "2026-09-01T10:00:01.000Z",
    outcomeKind: "low_confidence",
    outcomeReason: null,
    envelopeOverall: null,
    latencyMs: rng.int(100, 5000),
    appVersion: "1.0.0",
    engineVersion: "engine-1",
    modelBundleVersion: "on-device-fusion-1",
    declaredStroke: "dink",
    claims: {},
    limitingFactors: [],
    userFlags: [],
    dims: { width: 1080, height: 1920 },
    consent: { scope: "evaluation_telemetry", consentVersion: "2026-08" },
  };
}

/** Numeric-heavy filler: every element is short as TEXT but ~12+ bytes as
 * jsonb (JEntry + numeric varlena). */
function numericFiller(rng: Prng, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(Math.round(rng.next() * 100) / 100);
  return out;
}

export function jsonFor(rng: Prng, trialId: string): JsonCandidate {
  const base = trialBase(rng, trialId);
  const ok = (
    obj: unknown,
    tags: string[],
    note: string,
    extra: Partial<JsonCandidate> = {},
  ): JsonCandidate => {
    const text = JSON.stringify(obj);
    return {
      value: text,
      expect: "accept",
      tags,
      note,
      parses: true,
      textLength: text.length,
      ...extra,
    };
  };
  const bad = (text: string, tags: string[], note: string): JsonCandidate => ({
    value: text,
    expect: "reject",
    tags,
    note,
    parses: false,
  });
  const cases: Array<() => JsonCandidate> = [
    () => ok(base, ["json-valid"], "well-formed trial"),
    () => ok({}, ["empty-object"], "{}"),
    () => ok([], ["empty-array"], "[]"),
    () =>
      ok(
        null,
        ["json-null"],
        "JSON null (jsonb accepts scalar null; column NOT NULL is satisfied)",
      ),
    () => ok("", ["json-scalar", "empty-string"], "scalar empty string"),
    () => ok(0, ["json-scalar"], "scalar 0"),
    () => ok(-0, ["neg-zero"], "JSON -0 (serialises as 0)"),
    () => ok(true, ["json-scalar", "wrong-type"], "scalar true"),
    () =>
      ok(
        { ...base, schemaVersion: "evaluation-trial-v999" },
        ["future-schema"],
        "future schemaVersion",
      ),
    () =>
      ok({ ...base, schemaVersion: 999 }, ["future-schema", "wrong-type"], "numeric schemaVersion"),
    () =>
      ok(
        { ...base, __proto__: { polluted: true }, constructor: { prototype: {} } },
        ["proto-key"],
        "__proto__/constructor keys (spread drops __proto__, constructor kept)",
      ),
    () => ({
      value: `{"__proto__":{"polluted":true},"constructor":{"prototype":{"x":1}},"trialId":"${trialId}"}`,
      expect: "accept",
      tags: ["proto-key", "raw"],
      note: "raw __proto__ key in text",
      parses: true,
      textLength: 90,
    }),
    () => ({
      value: `{"a":1,"a":2,"a":3,"trialId":"${trialId}"}`,
      expect: "accept",
      tags: ["duplicate-keys"],
      note: "duplicate keys (jsonb keeps last)",
      parses: true,
      textLength: 60,
    }),
    () => ok({ ...base, latencyMs: 1e308 }, ["big-number"], "1e308"),
    () => ({
      value: `{"n":1e400,"trialId":"${trialId}"}`,
      expect: "accept",
      tags: ["big-number", "overflow"],
      note: "1e400 (jsonb numeric holds it)",
      parses: true,
      textLength: 60,
    }),
    () => ({
      value: `{"n":1e1000000,"trialId":"${trialId}"}`,
      expect: "reject",
      tags: ["big-number", "overflow"],
      note: "1e1000000 (numeric overflow inside jsonb)",
      parses: true,
      textLength: 60,
    }),
    () => ({
      value: `{"n":-0,"m":-0.0,"trialId":"${trialId}"}`,
      expect: "accept",
      tags: ["neg-zero"],
      note: "-0 literals",
      parses: true,
      textLength: 60,
    }),
    () => bad(`{"n":NaN,"trialId":"${trialId}"}`, ["nan", "malformed"], "NaN literal"),
    () => bad(`{"n":Infinity}`, ["infinity", "malformed"], "Infinity literal"),
    () => bad(`{"n":-Infinity}`, ["infinity", "malformed"], "-Infinity literal"),
    () => bad(`{"n":01}`, ["malformed", "leading-zero"], "leading zero"),
    () => bad(`{"n":.5}`, ["malformed"], ".5"),
    () => bad(`{"n":+1}`, ["malformed"], "+1"),
    () => bad(`{"n":0x10}`, ["malformed", "hex-literal"], "0x10"),
    () => bad(`{'a':1}`, ["malformed", "single-quotes"], "single quotes"),
    () => bad(`{a:1}`, ["malformed", "unquoted-key"], "unquoted key"),
    () => bad(`{"a":1,}`, ["malformed", "trailing-comma"], "trailing comma"),
    () => bad(`[1,2,]`, ["malformed", "trailing-comma"], "trailing comma array"),
    () => bad(`{"a":undefined}`, ["malformed", "undefined"], "undefined"),
    () => bad(``, ["malformed", "empty"], "empty text"),
    () => bad(`   `, ["malformed", "whitespace"], "whitespace only"),
    () => bad(`{"a":1}{"b":2}`, ["malformed", "concatenated"], "two documents"),
    () => bad(`{"a":1} x`, ["malformed", "trailing-garbage"], "trailing garbage"),
    () => bad(`\ufeff{"a":1}`, ["malformed", "bom"], "BOM prefix"),
    () => bad(`{"a":"\u0000"}`, ["nul", "raw-control"], "raw NUL inside string"),
    () => bad(`{"a":"\\u0000"}`, ["nul", "escaped"], "\\u0000 escape (jsonb rejects, 22P05)"),
    () => bad(`{"a":"\\ud800"}`, ["lone-surrogate"], "lone high surrogate escape"),
    () => bad(`{"a":"\\udc00"}`, ["lone-surrogate"], "lone low surrogate escape"),
    () => bad(`{"a":"\\x41"}`, ["malformed", "bad-escape"], "\\x escape"),
    () => bad(`{"a":"tab\there"}`, ["raw-control"], "raw tab in string"),
    () => bad(`{"a":"nl\nhere"}`, ["raw-control"], "raw newline in string"),
    () => bad(`// c\n{"a":1}`, ["malformed", "comment"], "comment"),
    () => bad(`{"a":1 /* c */}`, ["malformed", "comment"], "block comment"),
    () => bad(`{"__proto__":`, ["truncated", "proto-key"], "truncated after proto key"),
    () => {
      const text = JSON.stringify(base);
      const cut = rng.int(1, text.length - 1);
      return bad(text.slice(0, cut), ["truncated"], `truncated at ${cut}/${text.length}`);
    },
    () => {
      const text = JSON.stringify(base);
      const at = rng.int(0, text.length - 1);
      const mutated =
        text.slice(0, at) +
        rng.pick(["\u0000", "\\", '"', "}", "{", ",", ":", "\ud83d"]) +
        text.slice(at + 1);
      let parses = true;
      try {
        JSON.parse(mutated);
      } catch {
        parses = false;
      }
      return {
        value: mutated,
        expect: parses ? "either" : "reject",
        tags: ["byte-flip"],
        note: `1-char flip at ${at} (${parses ? "still parses" : "broken"})`,
        parses,
        textLength: parses ? mutated.length : undefined,
      };
    },
    () =>
      ok(
        { ...base, notes: "\u00e9".repeat(1000) + "e\u0301".repeat(1000) },
        ["unicode-normalization"],
        "NFC + NFD é pairs",
      ),
    () => ok({ ...base, notes: "\u212b\u00c5" }, ["unicode-normalization"], "angstrom pair"),
    () => ok({ ...base, notes: FAMILY.repeat(2000) }, ["grapheme-cluster"], "2000 family emoji"),
    () => ok({ ...base, notes: "x".repeat(65536) }, ["64k"], "64 KiB string value"),
    () => ok({ ...base, ["k".repeat(65536)]: 1 }, ["64k", "long-key"], "64 KiB key"),
    () =>
      ok(
        { ...base, notes: "字".repeat(65536) },
        ["64k", "cjk"],
        "65536 cjk (196608 bytes) — under 256 KiB cap",
      ),
    () => {
      // depth probe: deeply nested arrays
      const depth = rng.pick([64, 512, 4096, 20000]);
      return {
        value: "[".repeat(depth) + "]".repeat(depth),
        expect: "either",
        tags: ["deep-nesting", `depth-${depth}`],
        note: `nested arrays depth ${depth} (jsonb parser is recursive; 54001 acceptable)`,
        parses: true,
        textLength: depth * 2,
      };
    },
    () => {
      // wide object: many keys
      const n = rng.pick([1000, 10000]);
      const o: Record<string, number> = {};
      for (let i = 0; i < n; i++) o[`k${i}`] = i;
      return ok(o, ["wide-object", `keys-${n}`], `${n} keys`);
    },
    () => {
      // SIZE PROBE — text length just under the edge's 250000 cap, but
      // numeric-heavy so the jsonb binary is larger than the text.
      const numbers = rng.pick([20000, 30000, 45000, 60000]);
      const obj = { ...base, samples: numericFiller(rng, numbers) };
      const text = JSON.stringify(obj);
      return {
        value: text,
        expect: "either",
        tags: ["size-probe", "edge-cap-vs-db-cap"],
        note: `numeric-heavy trial: text ${text.length} chars (${utf8Bytes(text)} bytes)`,
        parses: true,
        textLength: text.length,
        sizeProbe: true,
      };
    },
    () => {
      // SIZE PROBE — ascii string padding straddling the 262144-byte cap.
      const pad = rng.pick([200000, 249000, 261000, 262000, 262144, 263000, 300000]);
      const obj = { ...base, pad: "a".repeat(pad) };
      const text = JSON.stringify(obj);
      return {
        value: text,
        expect: "either",
        tags: ["size-probe", "ascii-pad"],
        note: `ascii pad ${pad}: text ${text.length} chars`,
        parses: true,
        textLength: text.length,
        sizeProbe: true,
      };
    },
    () => {
      // SIZE PROBE — multi-byte: text length under 250000 UTF-16 units but
      // bytes well over 262144.
      const n = rng.pick([90000, 120000, 200000]);
      const obj = { ...base, pad: "字".repeat(n) };
      const text = JSON.stringify(obj);
      return {
        value: text,
        expect: "either",
        tags: ["size-probe", "multibyte", "edge-cap-vs-db-cap"],
        note: `cjk pad ${n}: text ${text.length} chars, ${utf8Bytes(text)} bytes`,
        parses: true,
        textLength: text.length,
        sizeProbe: true,
      };
    },
  ];
  return rng.pick(cases)();
}

// ---------------------------------------------------------------- raw bytes

/** Invalid UTF-8 byte sequences, delivered hex-encoded and decoded
 * server-side with convert_from(decode($1,'hex'),'UTF8') so the client
 * library cannot "helpfully" repair them. Always expected to reject (22021). */
export function invalidUtf8Hex(rng: Prng): Candidate {
  const cases: Array<Candidate> = [
    { value: "00", expect: "reject", tags: ["bytes", "nul"], note: "0x00" },
    { value: "6f6b00", expect: "reject", tags: ["bytes", "nul"], note: "ok\\0" },
    { value: "c328", expect: "reject", tags: ["bytes", "invalid-continuation"], note: "0xC3 0x28" },
    { value: "a0a1", expect: "reject", tags: ["bytes", "stray-continuation"], note: "0xA0 0xA1" },
    { value: "e228a1", expect: "reject", tags: ["bytes", "invalid-3byte"], note: "0xE2 0x28 0xA1" },
    {
      value: "f0288cbc",
      expect: "reject",
      tags: ["bytes", "invalid-4byte"],
      note: "0xF0 0x28 0x8C 0xBC",
    },
    {
      value: "c080",
      expect: "reject",
      tags: ["bytes", "overlong-nul"],
      note: "overlong NUL C0 80",
    },
    {
      value: "eda080",
      expect: "reject",
      tags: ["bytes", "surrogate"],
      note: "encoded surrogate ED A0 80",
    },
    {
      value: "f4908080",
      expect: "reject",
      tags: ["bytes", "above-10ffff"],
      note: "F4 90 80 80 (> U+10FFFF)",
    },
    { value: "ff", expect: "reject", tags: ["bytes", "ff"], note: "0xFF" },
    { value: "fe", expect: "reject", tags: ["bytes", "fe"], note: "0xFE" },
    {
      value: "e0",
      expect: "reject",
      tags: ["bytes", "truncated-seq"],
      note: "truncated 3-byte lead",
    },
  ];
  return rng.pick(cases);
}
