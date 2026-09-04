// Seeded boundary / malformed-input generators for the db-deletion-consent
// stress harness. Every generator is a pure function of the supplied RNG, so
// a case is fully replayable from its seed (see db_deletion_consent_boundary.ts).
//
// Each generated value carries the ORACLE expectation the migration chain
// promises for it (accept / reject), derived only from the declared column
// contract: codepoint caps (`length(col) <= N`), enum checks, uuid syntax,
// integer range/sign, boolean syntax, timestamptz syntax. JSONB size caps are
// oracled live by the DB (`pg_column_size($1::jsonb)`) because the binary
// size is not computable from the text form.

export type Expect = "accept" | "reject";

export interface Gen<T = string | null> {
  value: T;
  /** Short human label of the variant (recorded in the results table). */
  kind: string;
  expect: Expect;
  /** True when the JS string contains a lone surrogate — the wire encoder
   * (UTF-8) replaces it with U+FFFD, so a stored value that differs from the
   * sent value is expected, not a silent DB mutation. */
  loneSurrogate?: boolean;
}

// ─── RNG ─────────────────────────────────────────────────────────────────────

export type Rng = () => number;

/** mulberry32 — same PRNG the __wf__ audit tests use. */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derives a stable per-iteration seed from the campaign seed + index. */
export function iterationSeed(campaignSeed: number, index: number): number {
  let h = (campaignSeed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (index + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)];
export const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
export const chance = (rng: Rng, p: number) => rng() < p;

/** Re-draws until the generator yields a contract-valid value (still fully
 * seeded — every draw consumes the same rng). */
export function valid(g: () => Gen): Gen {
  for (let i = 0; i < 500; i++) {
    const v = g();
    if (v.expect === "accept" && !v.loneSurrogate) return v;
  }
  throw new Error("valid(): generator never produced an accepted value");
}

/** Per-row fault injection plan. Half the rows are "single-fault": every
 * field is contract-valid except at most one — that is what exercises the
 * accept path (caps at the boundary, round-trip, false rejections). The
 * other half draw every field adversarially (multi-fault). */
export function faultPlan(
  rng: Rng,
  fields: number,
): { mode: string; field: (i: number, g: () => Gen) => Gen } {
  const single = rng() < 0.5;
  const faultIdx = single ? int(rng, -1, fields - 1) : -2;
  return {
    mode: !single ? "multi-fault" : faultIdx < 0 ? "all-valid" : `single-fault@${faultIdx}`,
    field: (i, g) => (single && i !== faultIdx ? valid(g) : g()),
  };
}

// ─── Codepoint helpers ───────────────────────────────────────────────────────

export const codepoints = (s: string) => Array.from(s).length;
const rep = (unit: string, n: number) => unit.repeat(n);

/** Atoms with interesting UTF-8 / grapheme shapes. cp = codepoints per atom. */
const ATOMS: ReadonlyArray<{ s: string; cp: number; name: string }> = [
  { s: "a", cp: 1, name: "ascii" },
  { s: "é", cp: 1, name: "latin1-nfc" },
  { s: "e\u0301", cp: 2, name: "latin1-nfd" },
  { s: "€", cp: 1, name: "3byte" },
  { s: "😀", cp: 1, name: "4byte-emoji" },
  { s: "👨‍👩‍👧‍👦", cp: 7, name: "zwj-family(1 grapheme,7cp)" },
  { s: "🇺🇸", cp: 2, name: "flag(1 grapheme,2cp)" },
  { s: "\u0dc1\u0dca\u200d\u0dbb\u0dd3", cp: 5, name: "sinhala-cluster" },
  { s: "ﬃ", cp: 1, name: "nfkc-ligature" },
  { s: "Ａ", cp: 1, name: "fullwidth" },
];

/** Build a string with EXACTLY `cp` codepoints from one atom (padding with
 * ascii when the atom size does not divide evenly). */
function exactly(atom: { s: string; cp: number }, cp: number): string {
  const n = Math.floor(cp / atom.cp);
  const rest = cp - n * atom.cp;
  return rep(atom.s, n) + rep("x", rest);
}

const TRAVERSAL = [
  "../../etc/passwd",
  "..\\..\\windows\\system32",
  "%2e%2e%2f%2e%2e%2fetc%2fpasswd",
  "/proc/self/environ",
  "file:///etc/shadow",
  "\u2025/\u2025/etc/passwd",
];
const INJECTION = [
  "'; drop table public.consent_records; --",
  '" or 1=1 --',
  "$1::uuid",
  "${jndi:ldap://x}",
  "{{7*7}}",
  "<script>alert(1)</script>",
  "\\x00\\x00",
  "%00",
  "\\u0000",
  "NULL",
  "null",
  "undefined",
  "[object Object]",
  "__proto__",
  "constructor.prototype.polluted",
];
const CONTROL = ["\u0000", "\u0001", "\u0007", "\u001b[31m", "\u007f", "\u009f", "\r\n", "\t"];
const SPOOF = ["\u200b", "\u200e", "\u202e", "\u2066", "\ufeff", "\u00ad"];

/**
 * Text column with a codepoint cap. `nullable` columns also yield null.
 * The oracle: reject iff (codepoints > cap) OR (contains U+0000 — PG never
 * stores NUL in text, SQLSTATE 22021) OR (null on a NOT NULL column).
 */
export function genText(rng: Rng, cap: number, nullable: boolean): Gen {
  const roll = rng();
  const atom = pick(rng, ATOMS);
  let value: string;
  let kind: string;
  let loneSurrogate = false;
  if (nullable && roll < 0.05) {
    return { value: null, kind: "null", expect: "accept" };
  } else if (roll < 0.1) {
    value = "";
    kind = "empty";
  } else if (roll < 0.14) {
    value = pick(rng, [" ", "   ", "\t\n", "\u00a0", "\u3000"]);
    kind = "whitespace-only";
  } else if (roll < 0.3) {
    value = exactly(atom, cap);
    kind = `at-cap(${atom.name})`;
  } else if (roll < 0.46) {
    value = exactly(atom, cap + 1);
    kind = `cap+1(${atom.name})`;
  } else if (roll < 0.52) {
    value = exactly(atom, cap - 1);
    kind = `cap-1(${atom.name})`;
  } else if (roll < 0.58) {
    value = exactly(atom, int(rng, 1, Math.max(1, cap)));
    kind = `in-cap(${atom.name})`;
  } else if (roll < 0.63) {
    value = exactly(atom, cap * 2 + int(rng, 0, 50));
    kind = `cap*2(${atom.name})`;
  } else if (roll < 0.68) {
    value = exactly(atom, 65536 + int(rng, 1, 2048));
    kind = `64KB+(${atom.name})`;
  } else if (roll < 0.7) {
    value = exactly(atom, 262144 + int(rng, 1, 64));
    kind = `256KB+(${atom.name})`;
  } else if (roll < 0.75) {
    // One grapheme, many codepoints (base + N combining marks).
    const marks = int(rng, 1, cap + 5);
    value = "e" + rep("\u0301", marks);
    kind = `combining-run(${1 + marks}cp)`;
  } else if (roll < 0.8) {
    const c = pick(rng, CONTROL);
    const body = exactly(atom, int(rng, 0, Math.max(0, cap - 4)));
    value = body + c + "x";
    kind = c === "\u0000" ? "nul-byte" : `control(${JSON.stringify(c)})`;
  } else if (roll < 0.84) {
    value = pick(rng, SPOOF) + exactly(atom, int(rng, 1, Math.max(1, cap - 2))) + pick(rng, SPOOF);
    kind = "zero-width/bidi";
  } else if (roll < 0.88) {
    value = pick(rng, TRAVERSAL);
    kind = "path-traversal";
  } else if (roll < 0.92) {
    value = pick(rng, INJECTION);
    kind = "injection-ish";
  } else if (roll < 0.95) {
    value = pick(rng, ["\ud800", "x\udfffy", "\ud83d"]);
    kind = "lone-surrogate";
    loneSurrogate = true;
  } else if (roll < 0.975) {
    value = pick(rng, ["1.0.0", "v999.999.999", "2099-12-31", "schema:v2:future", "9".repeat(cap)]);
    kind = "future-version";
  } else {
    value = pick(rng, ["\u0041\u030a", "\u00c5", "\u212b"]); // Å in NFD / NFC / Angstrom sign
    kind = "unicode-normalization-pair";
  }
  const cp = codepoints(value);
  const hasNul = value.includes("\u0000");
  const expect: Expect = cp <= cap && !hasNul ? "accept" : "reject";
  return { value, kind, expect, loneSurrogate };
}

/** Enum-like text column (CHECK (col in (...))). */
export function genEnum(rng: Rng, allowed: readonly string[], cap: number): Gen {
  const roll = rng();
  const good = pick(rng, allowed);
  if (roll < 0.4) return { value: good, kind: "valid", expect: "accept" };
  let value: string;
  let kind: string;
  if (roll < 0.5) {
    value = good.toUpperCase();
    kind = "case-variant";
  } else if (roll < 0.58) {
    value = pick(rng, [` ${good}`, `${good} `, `${good}\n`, `\u200b${good}`]);
    kind = "padded";
  } else if (roll < 0.66) {
    value = good.replace("a", "\u0430").replace("o", "\u043e"); // Cyrillic homoglyphs
    if (value === good) value = "\u0435" + good.slice(1);
    kind = "homoglyph";
  } else if (roll < 0.72) {
    value = Array.from(good)
      .map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0))
      .join("");
    kind = "fullwidth";
  } else if (roll < 0.8) {
    value = pick(rng, ["granted", "withdrawn", "revoke", "GRANT ALL", "grant;", "grant--", ""]);
    kind = "wrong-vocabulary";
  } else if (roll < 0.88) {
    value = good + "\u0000";
    kind = "nul-suffix";
  } else if (roll < 0.94) {
    value = rep(good, Math.ceil((cap + 1) / good.length));
    kind = "cap+1";
  } else {
    value = pick(rng, TRAVERSAL.concat(INJECTION));
    kind = "traversal/injection";
  }
  return { value, kind, expect: allowed.includes(value) ? "accept" : "reject" };
}

/** uuid column. `own` is the acting user's id; `other` a different real user. */
export function genUuid(
  rng: Rng,
  own: string,
  other: string,
  opts: { nullable?: boolean; nullExpect?: Expect; otherExpect?: Expect } = {},
): Gen {
  const roll = rng();
  if (roll < 0.3) return { value: own, kind: "own", expect: "accept" };
  if (roll < 0.36) {
    return { value: own.toUpperCase(), kind: "own-upper", expect: "accept" };
  }
  if (roll < 0.42) {
    return { value: `{${own}}`, kind: "own-braces", expect: "accept" };
  }
  if (roll < 0.48) {
    return {
      value: own.replaceAll("-", ""),
      kind: "own-nohyphen",
      expect: "accept",
    };
  }
  if (roll < 0.58) {
    return {
      value: other,
      kind: "other-user",
      expect: opts.otherExpect ?? "reject",
    };
  }
  if (roll < 0.64) {
    return {
      value: "00000000-0000-0000-0000-000000000000",
      kind: "nil-uuid",
      expect: "reject",
    };
  }
  if (roll < 0.7) {
    return { value: null, kind: "null", expect: opts.nullExpect ?? "reject" };
  }
  if (roll < 0.76) {
    return { value: randomUuid(rng), kind: "random-unknown", expect: "reject" };
  }
  const malformed = pick(rng, [
    own.slice(0, 35),
    own + "0",
    own.replace("4", "g"),
    "urn:uuid:" + own,
    "'" + own + "'",
    own + "\u0000",
    ...TRAVERSAL,
    ...INJECTION,
    "",
    " ",
    "NaN",
    "-0",
    "1e308",
    rep("f", 65537),
    "\ud800",
  ]);
  return { value: malformed, kind: "malformed-uuid", expect: "reject" };
}

export function randomUuid(rng: Rng): string {
  const h = () => Math.floor(rng() * 16).toString(16);
  const s = (n: number) => Array.from({ length: n }, h).join("");
  return `${s(8)}-${s(4)}-4${s(3)}-${pick(rng, ["8", "9", "a", "b"])}${s(3)}-${s(12)}`;
}

/** Integer spellings whose acceptance depends on the server major version:
 * PostgreSQL 16+ int4in accepts non-decimal literals (0x/0o/0b) and single
 * underscore digit separators; 15 and below reject them with 22P02. The
 * campaign resolves these with a live `select $1::text::int` oracle. */
export const PG_VERSION_DEPENDENT_INT_KINDS: ReadonlySet<string> = new Set([
  "hex",
  "octal",
  "binary",
  "underscore",
  "underscore-hex",
]);

/** integer column with CHECK (col is null or col >= 0). Values are sent as
 * TEXT and cast server-side so the PG integer parser is the boundary. */
export function genNonNegInt(rng: Rng): Gen {
  const cases: Array<[string | null, string, Expect]> = [
    [null, "null", "accept"],
    ["0", "zero", "accept"],
    ["-0", "neg-zero", "accept"],
    ["+7", "plus-sign", "accept"],
    ["007", "leading-zeros", "accept"],
    ["  12  ", "whitespace-padded", "accept"],
    ["2147483647", "int32-max", "accept"],
    ["2147483648", "int32-max+1", "reject"],
    ["-1", "negative", "reject"],
    ["-2147483648", "int32-min", "reject"],
    ["-2147483649", "int32-min-1", "reject"],
    ["9223372036854775807", "int64-max", "reject"],
    ["18446744073709551616", "2^64", "reject"],
    ["1e3", "exponent", "reject"],
    ["1.5", "fraction", "reject"],
    ["1.0", "fraction-zero", "reject"],
    ["NaN", "NaN", "reject"],
    ["Infinity", "Infinity", "reject"],
    ["-Infinity", "-Infinity", "reject"],
    ["0x10", "hex", "reject"],
    ["0o17", "octal", "reject"],
    ["0b11", "binary", "reject"],
    ["0x_1_0", "underscore-hex", "reject"],
    ["1__000", "double-underscore", "reject"],
    ["_1000", "leading-underscore", "reject"],
    ["1000_", "trailing-underscore", "reject"],
    ["0x", "hex-prefix-only", "reject"],
    ["0x80000000", "hex-int32-max+1", "reject"],
    ["１２", "fullwidth-digits", "reject"],
    ["", "empty", "reject"],
    ["12abc", "trailing-garbage", "reject"],
    ["1_000", "underscore", "reject"],
    ["1,000", "comma", "reject"],
    ["true", "boolean-word", "reject"],
    ["null", "null-word", "reject"],
    [rep("9", 70000), "64KB-digits", "reject"],
    ["12\u0000", "nul", "reject"],
  ];
  const [value, kind, expect] = pick(rng, cases);
  return { value, kind, expect };
}

export function genBool(rng: Rng): Gen {
  const cases: Array<[string | null, string, Expect]> = [
    [null, "null", "accept"],
    ["true", "true", "accept"],
    ["false", "false", "accept"],
    ["t", "t", "accept"],
    ["f", "f", "accept"],
    ["yes", "yes", "accept"],
    ["no", "no", "accept"],
    ["on", "on", "accept"],
    ["off", "off", "accept"],
    ["1", "1", "accept"],
    ["0", "0", "accept"],
    ["TRUE", "TRUE", "accept"],
    ["  true ", "padded", "accept"],
    ["tr", "prefix-tr", "accept"],
    ["maybe", "maybe", "reject"],
    ["2", "two", "reject"],
    ["-1", "minus-one", "reject"],
    ["", "empty", "reject"],
    ["null", "null-word", "reject"],
    ["ｔｒｕｅ", "fullwidth", "reject"],
    ["true\u0000", "nul", "reject"],
    ["[object Object]", "object", "reject"],
  ];
  const [value, kind, expect] = pick(rng, cases);
  return { value, kind, expect };
}

/** timestamptz column (client-writable created_at / expires_at). */
export function genTimestamp(rng: Rng, nullable: boolean): Gen {
  const cases: Array<[string | null, string, Expect]> = [
    ["2026-09-04T12:00:00Z", "iso", "accept"],
    ["2026-09-04 12:00:00+00", "pg-format", "accept"],
    ["1970-01-01T00:00:00Z", "epoch", "accept"],
    ["epoch", "epoch-word", "accept"],
    ["now", "now-word", "accept"],
    ["today", "today-word", "accept"],
    ["tomorrow", "tomorrow-word", "accept"],
    ["infinity", "infinity", "accept"],
    ["-infinity", "-infinity", "accept"],
    ["4713-01-01 BC", "min-date", "accept"],
    ["294276-12-31T23:59:59Z", "max-year", "accept"],
    ["294277-01-01T00:00:00Z", "max-year+1", "reject"],
    ["0000-01-01T00:00:00Z", "year-zero", "reject"],
    ["2026-02-30T00:00:00Z", "feb-30", "reject"],
    ["2026-13-01T00:00:00Z", "month-13", "reject"],
    ["2026-09-04T25:00:00Z", "hour-25", "reject"],
    ["1700000000", "unix-seconds", "reject"],
    ["1700000000000", "unix-millis", "reject"],
    ["NaN", "NaN", "reject"],
    ["Infinity", "js-Infinity", "accept"],
    ["", "empty", "reject"],
    ["garbage", "garbage", "reject"],
    ["allballs", "time-only-word", "reject"],
    ["2026-09-04T12:00:00Z\u0000", "nul", "reject"],
    ["Invalid Date", "js-invalid-date", "reject"],
    ["2026-09-04T12:00:00.1234567890Z", "excess-fraction", "accept"],
    ["9999-12-31T23:59:59.999999Z", "y9999", "accept"],
    [rep("2", 70000), "64KB-digits", "reject"],
  ];
  if (nullable) cases.push([null, "null", "accept"]);
  const [value, kind, expect] = pick(rng, cases);
  return { value, kind, expect };
}

/**
 * Raw JSON text for a jsonb column. Expectation is decided LIVE by the DB
 * oracle (parse + `pg_column_size <= cap`), so `expect` here is provisional:
 * "reject" for text that is not valid JSON per RFC 8259 (PG must not parse
 * it), "accept" otherwise pending the size oracle.
 */
export function genJsonText(rng: Rng, sizeCap: number): Gen & { validJson: boolean } {
  const roll = rng();
  const out = (value: string | null, kind: string, validJson: boolean) => ({
    value,
    kind,
    validJson,
    expect: (validJson ? "accept" : "reject") as Expect,
  });
  if (roll < 0.05) return out(null, "null", true);
  if (roll < 0.15) {
    return out(
      pick(rng, [
        "{}",
        "[]",
        '""',
        "null",
        "0",
        "-0",
        "true",
        '{"model":"iPhone16,1","os":"18.0"}',
        "[1,2,3]",
        '{"a":{"b":{"c":[]}}}',
      ]),
      "valid-small",
      true,
    );
  }
  if (roll < 0.25) {
    return out(
      pick(rng, [
        '{"__proto__":{"admin":true}}',
        '{"constructor":{"prototype":{"polluted":1}}}',
        '{"__proto__":null,"toString":"x"}',
        '{"prototype":{"__proto__":{}}}',
        '{"__defineGetter__":"x"}',
      ]),
      "prototype-pollution-keys",
      true,
    );
  }
  if (roll < 0.35) {
    return out(
      pick(rng, [
        '{"n":1e308}',
        '{"n":1e309}',
        '{"n":1e400}',
        '{"n":-1e400}',
        '{"n":1e100000}',
        '{"n":1e1000000}',
        '{"n":9007199254740993}',
        '{"n":18446744073709551616}',
        '{"n":0.1e-400}',
        '{"n":-0}',
        '{"n":-0.0}',
        "1e999999999",
      ]),
      "numeric-overflow/-0",
      true,
    );
  }
  if (roll < 0.45) {
    return out(
      pick(rng, [
        "NaN",
        '{"n":NaN}',
        "Infinity",
        "-Infinity",
        '{"n":Infinity}',
        "undefined",
        '{"a":undefined}',
        "{'a':1}",
        '{"a":1,}',
        "[1,2,]",
        '{"a":',
        '{"a":1',
        '"unterminated',
        "[",
        "}",
        '{"a" 1}',
        '{"a":1}//c',
        "/*c*/{}",
        "\ufeff{}",
        "01",
        "+1",
        ".5",
        "0x10",
        "",
        " ",
        '{"a":1}{"b":2}',
        "\u0000",
      ]),
      "malformed/truncated",
      false,
    );
  }
  if (roll < 0.53) {
    return out(
      pick(rng, [
        '"\\u0000"',
        '{"\\u0000":1}',
        '{"a":"b\\u0000c"}',
        '"\\ud800"',
        '"\\udfff"',
        '"\\ud83d\\ude00"',
        '"\\uD83D"',
      ]),
      "unicode-escape-edge",
      true, // syntactically valid JSON; PG rejects \u0000 / lone surrogates (22P05)
    );
  }
  if (roll < 0.6) {
    const depth = pick(rng, [64, 512, 4096, 20000]);
    return out(rep("[", depth) + rep("]", depth), `deep-nesting(${depth})`, true);
  }
  if (roll < 0.67) {
    const dup = pick(rng, ['{"a":1,"a":2}', '{"a":1,"a":{"__proto__":1}}', '{"b":1,"a":2,"b":3}']);
    return out(dup, "duplicate-keys", true);
  }
  if (roll < 0.8) {
    // Around the byte cap. pg_column_size(jsonb) ≈ text length + small header
    // for a flat string; the DB oracle decides the exact side.
    const len = sizeCap + int(rng, -64, 64);
    return out(JSON.stringify(rep("a", Math.max(0, len))), `near-cap-string(${len})`, true);
  }
  if (roll < 0.86) {
    const n = pick(rng, [65536, 131072]);
    return out(JSON.stringify(rep("😀", n / 4)), `64KB+-string`, true);
  }
  if (roll < 0.92) {
    const n = pick(rng, [1000, 10000, 20000]);
    return out(
      "[" + Array.from({ length: n }, (_, i) => i).join(",") + "]",
      `big-array(${n})`,
      true,
    );
  }
  if (roll < 0.96) {
    const key = rep("k", 70000);
    return out(`{"${key}":1}`, "64KB-key", true);
  }
  return out(
    pick(rng, [
      '{"path":"../../etc/passwd"}',
      '{"id":"\'; drop table x; --"}',
      '"\\u202e\\u200b"',
      '"e\\u0301"',
      '"\\u00c5"',
      '{"schemaVersion":999,"future":true}',
      '[{},[],{"":[]}]',
    ]),
    "misc-edge",
    true,
  );
}

/** Deterministic human-safe summary of a value for the results table. */
export function summarize(v: unknown, max = 60): string {
  if (v === null || v === undefined) return "<null>";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const escaped = JSON.stringify(s.length > max ? s.slice(0, max) : s);
  return s.length > max ? `${escaped}…(len=${s.length},cp=${codepoints(s)})` : escaped;
}
