// Hostile-input generators for the edge fuzz harness. Everything is driven by
// a `Prng` so a (seed, index) pair reproduces the exact bytes.

import type { Prng } from "./prng.ts";

// ─── String corpora ──────────────────────────────────────────────────────────

/** Unicode edge cases: control chars, null bytes, bidi/RTL, zero-width,
 * emoji (incl. ZWJ sequences + flags), combining marks, normalization forms,
 * astral planes, lone surrogates (JSON-escaped so they survive encoding). */
export const UNICODE_ATOMS: readonly string[] = [
  "\u0000", // NUL
  "\u0000\u0000\u0000",
  "a\u0000b",
  "\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0008",
  "\u000b\u000c\u000e\u000f\u0010\u001f",
  "\u007f",
  "\u0080\u0085\u009f",
  "\u00a0", // NBSP
  "\u00ad", // soft hyphen
  "\u034f", // combining grapheme joiner
  "\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307", // combining marks
  "Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319\u0324\u031e\u0349\u035a\u032f\u031e\u0320\u034d", // zalgo
  "\u05d0\u05d1\u05d2", // Hebrew
  "\u0627\u0644\u0639\u0631\u0628\u064a\u0629", // Arabic
  "\u202e", // RLO
  "\u202d", // LRO
  "\u202a\u202b\u202c", // LRE/RLE/PDF
  "\u2066\u2067\u2068\u2069", // isolates
  "\u200f\u200e", // RLM/LRM
  "abc\u202edef\u202c", // RTL override sandwich
  "\u200b\u200c\u200d", // zero-width space/non-joiner/joiner
  "\u2060\u2061\u2062\u2063\u2064", // word joiner + invisible operators
  "\ufeff", // BOM
  "\ufffe\uffff", // noncharacters
  "\ufffd", // replacement char
  "\u{1f600}", // emoji
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}", // ZWJ family
  "\u{1f1fa}\u{1f1f8}", // flag
  "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}", // tag sequence flag
  "\u{1f44d}\u{1f3fd}", // skin tone modifier
  "\u{10ffff}", // max code point
  "\u{e0000}", // tag space
  "\u{fff0}",
  "\u{1d400}\u{1d401}\u{1d402}", // math bold
  "\u212a", // Kelvin sign (case-folds to k)
  "\u0130\u0131", // Turkish dotted/dotless i
  "\u00df", // sharp s
  "\ufb01", // fi ligature
  "\u2028\u2029", // line/paragraph separators (JS line terminators)
  "\u1680\u180e\u2000\u200a\u205f\u3000", // exotic spaces
  "\uff1c\uff1e\uff02\uff07", // fullwidth <>"'
  "\u0000\u202e\u200b\u{1f600}", // mixed
  "%00", // percent-encoded NUL
  "%2e%2e%2f",
  "%c0%ae%c0%ae%c0%af", // overlong UTF-8 dot-dot-slash
  "%e2%80%ae", // encoded RLO
  "\\u0000",
  "\\ud800",
  "\\x00",
  "\r\n",
  "\n",
  "\t",
  "\r",
  "\\r\\n\\r\\n",
];

/** Injection-flavoured strings: path traversal, SQL/PostgREST filter grammar,
 * NoSQL/JSON-ish, template, shell, header splitting, prototype keys. */
export const INJECTION_ATOMS: readonly string[] = [
  "../",
  "../../../../../../etc/passwd",
  "..\\..\\..\\windows\\win.ini",
  "....//....//",
  "%2e%2e/%2e%2e/",
  "..%2f..%2f",
  "..%5c..%5c",
  "/etc/passwd%00.json",
  "\\\\?\\C:\\",
  "file:///etc/passwd",
  "' OR 1=1 --",
  '"; DROP TABLE shots; --',
  "1; SELECT pg_sleep(10)",
  "eq.1,or.user_id.eq.00000000-0000-4000-8000-000000000000",
  "id=in.(1,2),user_id=eq.*",
  "*",
  "*,shots(*)",
  "not.is.null",
  "or=(id.eq.1,id.eq.2)",
  "select=*",
  "Prefer: return=representation",
  "${7*7}",
  "{{7*7}}",
  "#{7*7}",
  "<%= 7*7 %>",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "javascript:alert(1)",
  "&lt;script&gt;",
  "$(id)",
  "`id`",
  "| id",
  "; id",
  "&& id",
  "%0d%0aSet-Cookie:%20x=y",
  "\r\nSet-Cookie: x=y",
  "__proto__",
  "constructor",
  "prototype",
  "constructor.prototype.polluted",
  "__proto__.polluted",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "__defineGetter__",
  "$where",
  "$gt",
  '{"$gt":""}',
  "[object Object]",
  "undefined",
  "null",
  "NaN",
  "Infinity",
  "-Infinity",
  "true",
  "false",
  "0x41414141",
  "0b1010",
  "0o777",
  "1e309",
  "-1e309",
  "9007199254740993",
  "1_000",
  "%s%s%s%s%s%n",
  "%x%x%x%x",
  "AAAA%08x.%08x.%08x",
  "..%c0%af..%c0%af",
  "%",
  "%%",
  "%zz",
  "%E0%A4%A",
  "%ff%fe",
  "+",
  " ",
  "",
  ".",
  "..",
  "...",
  "/",
  "//",
  "\\",
  "?",
  "#",
  "&",
  "=",
  ";",
  ",",
  "(",
  ")",
  "()",
  "[]",
  "{}",
  "{",
  "}",
  '"',
  "'",
  "`",
  "@",
  "!",
  "~",
  "^",
  "|",
  ":",
  "::",
  "0",
  "-0",
  "-1",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
  "FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF",
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "11111111-1111-4111-8111-11111111111", // 35 chars
  "11111111-1111-4111-8111-1111111111111", // 37 chars
  "11111111111141118111111111111111", // no dashes
  "{11111111-1111-4111-8111-111111111111}",
  "urn:uuid:11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-111111111111 ",
  " 11111111-1111-4111-8111-111111111111",
  "11111111-1111-4111-8111-111111111111\u0000",
  "11111111-1111-4111-8111-11111111111\u0661", // Arabic-Indic digit one
  "１１１１１１１１-1111-4111-8111-111111111111", // fullwidth digits
  "11111111-1111-9111-8111-111111111111", // bad version nibble
  "11111111-1111-4111-c111-111111111111", // bad variant nibble
  "2026-09-04T00:00:00.000Z",
  "2026-13-45T99:99:99Z",
  "0000-00-00T00:00:00Z",
  "+275760-09-13T00:00:00.000Z", // max Date
  "+275760-09-13T00:00:00.001Z", // beyond max Date
  "-271821-04-20T00:00:00.000Z",
  "1970-01-01",
  "Thu, 01 Jan 1970 00:00:00 GMT",
  "12345678901234567890",
  "now()",
  "epoch",
  "infinity",
  "-infinity",
];

export const PROTO_KEYS = ["__proto__", "constructor", "prototype"] as const;

// ─── Primitive generators ────────────────────────────────────────────────────

/** Repeat `unit` until the output is at least `bytes` long (UTF-16 units). */
export function repeatTo(unit: string, length: number): string {
  if (unit.length === 0) unit = "a";
  return unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
}

export interface HostileStringOptions {
  /** Upper bound on generated length (UTF-16 units). */
  maxLength?: number;
  /** Allow multi-megabyte strings. */
  huge?: boolean;
}

/** A hostile string drawn from the corpora, possibly stretched or mixed. */
export function hostileString(rng: Prng, options: HostileStringOptions = {}): string {
  const maxLength = options.maxLength ?? 4_096;
  const kind = rng.weighted<string>([
    [22, "unicode"],
    [22, "injection"],
    [10, "mixed"],
    [10, "long"],
    [6, "digits"],
    [6, "whitespace"],
    [5, "quotes"],
    [4, "repeatAtom"],
    [3, "empty"],
    [options.huge ? 8 : 0, "huge"],
    [4, "random"],
  ]);
  switch (kind) {
    case "unicode":
      return rng.pick(UNICODE_ATOMS);
    case "injection":
      return rng.pick(INJECTION_ATOMS);
    case "mixed": {
      const parts = rng.int(2, 6);
      let out = "";
      for (let i = 0; i < parts; i += 1) {
        out += rng.bool() ? rng.pick(UNICODE_ATOMS) : rng.pick(INJECTION_ATOMS);
      }
      return out.slice(0, maxLength);
    }
    case "long":
      return repeatTo(
        rng.pick(["a", "A", "0", "\u{1f600}", "\u0000", "\u202e", " ", "%", "\\"]),
        rng.int(65, Math.max(65, maxLength)),
      );
    case "digits":
      return rng.pick([
        "0",
        "-0",
        "1",
        "-1",
        "2147483647",
        "2147483648",
        "-2147483649",
        "4294967295",
        "9007199254740991",
        "9007199254740992",
        "9007199254740993",
        "18446744073709551615",
        "1e309",
        "1e-400",
        "0.1e-9999",
        "1".repeat(400),
        "9".repeat(4_000),
        "١٢٣", // Arabic-Indic
        "１２３", // fullwidth
      ]);
    case "whitespace":
      return rng.pick([
        " ",
        "  ",
        "\t",
        "\n",
        "\r\n",
        "\u00a0",
        "\u3000",
        "\u2028",
        " \t\r\n ",
        "\u200b",
      ]);
    case "quotes":
      return rng.pick(['"', "'", "`", '""', '"\\"', "\\", "\\\\", '\\"', '{"a":1}', "[1,2]"]);
    case "repeatAtom":
      return repeatTo(rng.pick(UNICODE_ATOMS), rng.int(2, Math.min(maxLength, 512)));
    case "empty":
      return "";
    case "huge":
      return repeatTo(
        rng.pick(["x", "\u{1f600}", "\u0000", "\\", '"', "\u202e"]),
        rng.int(200_000, 1_200_000),
      );
    default: {
      const length = rng.int(1, 64);
      let out = "";
      for (let i = 0; i < length; i += 1) {
        out += String.fromCharCode(rng.int(0x20, 0x7e));
      }
      return out;
    }
  }
}

/** Numeric edge cases as they will appear AFTER JSON.parse (non-finite
 * literals are impossible in JSON; the raw-body generator covers those). */
export function hostileNumber(rng: Prng): number {
  return rng.pick([
    0,
    -0,
    1,
    -1,
    0.5,
    -0.5,
    1.0000000000000002,
    0.1 + 0.2,
    10,
    10.000000001,
    11,
    100,
    100.5,
    101,
    -100,
    255,
    256,
    32767,
    32768,
    65535,
    65536,
    2147483647,
    2147483648,
    -2147483648,
    -2147483649,
    4294967295,
    4294967296,
    9007199254740991,
    9007199254740992,
    -9007199254740991,
    1e15,
    1e16,
    1e21,
    1e300,
    1.7976931348623157e308,
    5e-324,
    2.2250738585072014e-308,
    1e-7,
    1.2345678901234568e29,
    0.30000000000000004,
    3.4028235e38,
    Number.MAX_SAFE_INTEGER + 2,
  ]);
}

/** Numeric literals that only exist at the JSON TEXT layer (non-finite,
 * malformed digits, giant exponents, leading zeros, hex...). */
export const RAW_NUMBER_LITERALS: readonly string[] = [
  "1e309",
  "-1e309",
  "1e99999",
  "-1e99999",
  "1e-99999",
  "NaN",
  "Infinity",
  "-Infinity",
  "0x41",
  "0b1",
  "0o7",
  "01",
  "00",
  "-",
  "+1",
  ".5",
  "5.",
  "1_000",
  "1e",
  "1e+",
  "--1",
  "1.2.3",
  "9".repeat(10_000),
  "0." + "0".repeat(10_000) + "1",
  "1e" + "9".repeat(1_000),
  "-0",
  "1E5",
];

/** A JSON-representable value of a random type (for type confusion). */
export function hostileValue(rng: Prng, depth = 0): unknown {
  const kind = rng.weighted<string>([
    [20, "string"],
    [15, "number"],
    [8, "null"],
    [8, "bool"],
    [depth < 3 ? 10 : 0, "array"],
    [depth < 3 ? 10 : 0, "object"],
    [5, "emptyString"],
    [4, "emptyArray"],
    [4, "emptyObject"],
    [4, "protoObject"],
    [3, "bigArray"],
    [3, "deepNest"],
  ]);
  switch (kind) {
    case "string":
      return hostileString(rng, { maxLength: 8_192 });
    case "number":
      return hostileNumber(rng);
    case "null":
      return null;
    case "bool":
      return rng.bool();
    case "array": {
      const length = rng.int(1, 6);
      const out: unknown[] = [];
      for (let i = 0; i < length; i += 1) out.push(hostileValue(rng, depth + 1));
      return out;
    }
    case "object": {
      const length = rng.int(1, 6);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < length; i += 1) {
        out[hostileKey(rng)] = hostileValue(rng, depth + 1);
      }
      return out;
    }
    case "emptyString":
      return "";
    case "emptyArray":
      return [];
    case "emptyObject":
      return {};
    case "protoObject":
      return protoPollutionObject(rng);
    case "bigArray": {
      const length = rng.int(1_000, 50_000);
      const filler = rng.pick([0, "", null, "a", Infinity, {}, []]);
      return new Array(length).fill(filler);
    }
    default:
      return deepNested(rng.int(50, 5_000), rng.bool());
  }
}

/** Object keys that stress parsers and lookups. */
export function hostileKey(rng: Prng): string {
  return rng.weighted<string>([
    [25, rng.pick(PROTO_KEYS)],
    [15, rng.pick(UNICODE_ATOMS)],
    [15, rng.pick(INJECTION_ATOMS)],
    [10, ""],
    [10, repeatTo("k", rng.int(100, 10_000))],
    [
      10,
      rng.pick([
        "length",
        "0",
        "-1",
        "1e3",
        "toJSON",
        "then",
        "catch",
        "hasOwnProperty",
        "__lookupGetter__",
      ]),
    ],
    [15, `k${rng.hex(6)}`],
  ]);
}

/** `{"__proto__":{"polluted":...},"constructor":{"prototype":{...}}}` shapes. */
export function protoPollutionObject(rng: Prng): Record<string, unknown> {
  const payload = { polluted: `FUZZ_POLLUTED_${rng.hex(8)}`, isAdmin: true, premium: true };
  const shape = rng.int(0, 5);
  switch (shape) {
    case 0:
      return { __proto__: payload } as Record<string, unknown>;
    case 1:
      return { constructor: { prototype: payload } };
    case 2:
      return { __proto__: payload, constructor: { prototype: payload }, prototype: payload };
    case 3:
      return { a: { b: { __proto__: payload } } } as Record<string, unknown>;
    case 4:
      return JSON.parse(
        `{"__proto__":{"polluted":"FUZZ_POLLUTED_${rng.hex(8)}","toString":"x"},"__proto__":{"y":1}}`,
      ) as Record<string, unknown>;
    default:
      return { ["__pro" + "to__"]: payload, ["cons" + "tructor"]: { ["proto" + "type"]: payload } };
  }
}

/** Nested arrays/objects `depth` levels deep (JSON.parse recursion stress). */
export function deepNested(depth: number, arrays: boolean): unknown {
  let value: unknown = arrays ? [] : {};
  for (let i = 0; i < depth; i += 1) {
    value = arrays ? [value] : { a: value };
  }
  return value;
}

/** Text of a deeply nested JSON document without materialising it. */
export function deepNestedText(depth: number, arrays: boolean): string {
  return arrays
    ? "[".repeat(depth) + "]".repeat(depth)
    : '{"a":'.repeat(depth) + "0" + "}".repeat(depth);
}

// ─── Raw (text-layer) body generators ────────────────────────────────────────

export interface RawBody {
  description: string;
  text: string;
}

/** Malformed / non-object / hostile JSON texts. */
export function rawMalformedBody(rng: Prng, validJson: string): RawBody {
  const kind = rng.weighted<string>([
    [10, "truncated"],
    [6, "trailingGarbage"],
    [6, "nonObject"],
    [6, "rawNumber"],
    [5, "bom"],
    [5, "singleQuotes"],
    [5, "trailingComma"],
    [5, "comments"],
    [5, "duplicateKeys"],
    [5, "deepNest"],
    [5, "nulBytes"],
    [4, "unescapedControl"],
    [4, "loneSurrogateEscape"],
    [4, "invalidEscape"],
    [4, "empty"],
    [4, "whitespaceOnly"],
    [4, "binary"],
    [3, "formEncoded"],
    [3, "multipart"],
    [3, "xml"],
    [3, "jsonLines"],
    [3, "concatenated"],
    [3, "hugeKeyCount"],
    [3, "hugeString"],
    [2, "invalidUtf8Marker"],
    [2, "protoTextual"],
  ]);
  switch (kind) {
    case "truncated": {
      const cut = rng.int(0, Math.max(0, validJson.length - 1));
      return { description: `truncated at ${cut}`, text: validJson.slice(0, cut) };
    }
    case "trailingGarbage":
      return {
        description: "trailing garbage",
        text: validJson + rng.pick(["x", "}", "]", "{}", "\u0000", " garbage", ",", "//"]),
      };
    case "nonObject":
      return {
        description: "non-object JSON",
        text: rng.pick([
          "[]",
          "[{}]",
          '"string"',
          "123",
          "null",
          "true",
          "false",
          "[1,2,3]",
          '""',
          "-0",
          "[[[[]]]]",
        ]),
      };
    case "rawNumber": {
      const literal = rng.pick(RAW_NUMBER_LITERALS);
      return {
        description: `raw numeric literal ${literal.slice(0, 32)}`,
        text: validJson.replace(/:(\s*)(\d[\d.eE+-]*|"[^"]*")/, `:$1${literal}`),
      };
    }
    case "bom":
      return { description: "UTF-8 BOM prefix", text: "\ufeff" + validJson };
    case "singleQuotes":
      return { description: "single-quoted JSON", text: validJson.replace(/"/g, "'") };
    case "trailingComma":
      return { description: "trailing comma", text: validJson.replace(/\}$/, ",}") };
    case "comments":
      return { description: "JSON with comments", text: `/* c */ ${validJson} // c` };
    case "duplicateKeys": {
      const inner = validJson.slice(1, -1);
      return { description: "duplicate keys (last wins)", text: `{${inner},${inner}}` };
    }
    case "deepNest": {
      const depth = rng.pick([100, 1_000, 10_000, 100_000, 500_000]);
      return { description: `nested ${depth} deep`, text: deepNestedText(depth, rng.bool()) };
    }
    case "nulBytes":
      return {
        description: "literal NUL bytes inside JSON",
        text: validJson.replace(/"/, '"\u0000'),
      };
    case "unescapedControl":
      return {
        description: "unescaped control char in string",
        text: validJson.replace(/"([^"]*)"/, '"$1\u0001\n"'),
      };
    case "loneSurrogateEscape":
      return {
        description: "lone surrogate escape",
        text: validJson.replace(/"([^"]*)"/, '"$1\\ud800"'),
      };
    case "invalidEscape":
      return {
        description: "invalid escape",
        text: validJson.replace(/"([^"]*)"/, '"$1\\x41\\q"'),
      };
    case "empty":
      return { description: "empty body", text: "" };
    case "whitespaceOnly":
      return {
        description: "whitespace-only body",
        text: rng.pick([" ", "\n", "\t\t", "\r\n\r\n", "\u00a0", "\u2028"]),
      };
    case "binary": {
      let out = "";
      const length = rng.int(1, 4_096);
      for (let i = 0; i < length; i += 1) out += String.fromCharCode(rng.int(0, 255));
      return { description: `binary garbage ${length} bytes`, text: out };
    }
    case "formEncoded":
      return {
        description: "form-encoded body",
        text: "shots=1&id=../../&__proto__[polluted]=1&trials[]=x",
      };
    case "multipart":
      return {
        description: "multipart body",
        text: '--b\r\nContent-Disposition: form-data; name="f"; filename="../../x"\r\n\r\n{}\r\n--b--',
      };
    case "xml":
      return {
        description: "XML body with entity",
        text: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>',
      };
    case "jsonLines":
      return { description: "JSON lines", text: `${validJson}\n${validJson}\n` };
    case "concatenated":
      return { description: "concatenated documents", text: validJson + validJson };
    case "hugeKeyCount": {
      const count = rng.int(10_000, 100_000);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) parts.push(`"k${i}":${i}`);
      return { description: `${count} keys`, text: `{${parts.join(",")}}` };
    }
    case "hugeString": {
      const length = rng.int(1_000_000, 4_500_000);
      return {
        description: `single ${length}-char string field`,
        text: `{"shots":"${repeatTo("a", length)}"}`,
      };
    }
    case "invalidUtf8Marker":
      // The Request body encodes text as UTF-8, so invalid sequences cannot
      // be expressed as a string; the bytes variant below covers it.
      return {
        description: "replacement chars",
        text: validJson.replace(/"([^"]*)"/, '"$1\ufffd\ufffd"'),
      };
    default:
      return {
        description: "textual __proto__ pollution",
        text: `{"__proto__":{"polluted":"FUZZ_TEXT"},"constructor":{"prototype":{"polluted":"FUZZ_TEXT"}},${validJson.slice(1)}`,
      };
  }
}

/** Raw bytes that are NOT valid UTF-8 (TextDecoder replaces them). */
export function invalidUtf8Bytes(rng: Prng, validJson: string): Uint8Array {
  const prefix = new TextEncoder().encode(validJson.slice(0, -1) + ',"junk":"');
  const bad = rng.pick([
    [0xff, 0xfe, 0xfd],
    [0xc0, 0x80], // overlong NUL
    [0xc0, 0xaf], // overlong '/'
    [0xed, 0xa0, 0x80], // encoded surrogate
    [0xf4, 0x90, 0x80, 0x80], // > U+10FFFF
    [0xe0, 0x80, 0x80],
    [0x80, 0x80, 0x80, 0x80],
    [0xf8, 0x88, 0x80, 0x80, 0x80],
  ]);
  const suffix = new TextEncoder().encode('"}');
  const out = new Uint8Array(prefix.length + bad.length + suffix.length);
  out.set(prefix, 0);
  out.set(bad, prefix.length);
  out.set(suffix, prefix.length + bad.length);
  return out;
}

// ─── Path segment generators ─────────────────────────────────────────────────

/** Hostile id/slug for a parameterised route. Returned RAW (the request
 * builder decides whether to percent-encode). */
export function hostilePathSegment(rng: Prng): {
  raw: string;
  encode: boolean;
  description: string;
} {
  const kind = rng.weighted<string>([
    [20, "traversal"],
    [15, "unicode"],
    [15, "injection"],
    [10, "uuidLike"],
    [10, "percent"],
    [8, "long"],
    [6, "proto"],
    [6, "slugLike"],
    [4, "empty"],
    [6, "random"],
  ]);
  switch (kind) {
    case "traversal":
      return {
        raw: rng.pick([
          "..",
          "../",
          "../..",
          "../../../etc/passwd",
          "..%2f..%2f..%2fetc%2fpasswd",
          "%2e%2e%2f%2e%2e%2f",
          "..%c0%af..%c0%af",
          "..%5c..%5c",
          "%2e%2e",
          "%2e",
          "....//",
          "..;/",
          ";../",
          "%252e%252e%252f",
          "..\u2215..\u2215", // division slash
          "..\uff0f..\uff0f", // fullwidth solidus
          "\\..\\..\\",
          "C:\\Windows\\system32",
          "/absolute/path",
          "//host/share",
        ]),
        encode: false,
        description: "path traversal",
      };
    case "unicode":
      return { raw: rng.pick(UNICODE_ATOMS), encode: rng.bool(), description: "unicode segment" };
    case "injection":
      return {
        raw: rng.pick(INJECTION_ATOMS),
        encode: rng.bool(),
        description: "injection segment",
      };
    case "uuidLike": {
      const base = rng.uuid();
      const variant = rng.int(0, 9);
      const raw = [
        base.toUpperCase(),
        base.replace(/-/g, ""),
        `{${base}}`,
        `${base}\u0000`,
        `${base}%00`,
        `${base}/`,
        `${base}.json`,
        base.slice(0, 35),
        `${base}a`,
        base.replace(/1/g, "\u0661"),
      ][variant];
      return { raw, encode: false, description: `uuid variant ${variant}` };
    }
    case "percent":
      return {
        raw: rng.pick([
          "%",
          "%%",
          "%zz",
          "%2",
          "%G0",
          "%00",
          "%0a%0d",
          "%ff",
          "%E0%A4%A",
          "%u0041",
          "%2f",
          "%252f",
          "%3f",
          "%23",
          "%26",
          "%3d",
        ]),
        encode: false,
        description: "malformed percent-encoding",
      };
    case "long":
      return {
        raw: repeatTo(rng.pick(["a", "1", "-", ".", "%41", "\u{1f600}"]), rng.int(121, 20_000)),
        encode: false,
        description: "very long segment",
      };
    case "proto":
      return { raw: rng.pick(PROTO_KEYS), encode: false, description: "prototype key segment" };
    case "slugLike":
      return {
        raw: rng.pick([
          "third-shot-drop",
          "DINK-CONSISTENCY",
          "a".repeat(120),
          "a".repeat(121),
          "-leading-dash",
          "_leading_underscore",
          "trailing-dash-",
          "slug with space",
          "slug/with/slash",
          "slug%20encoded",
          "slug.with.dots",
          "0",
          "a",
          "ünïcödé-slug",
          "slug\u200b",
        ]),
        encode: false,
        description: "slug-like",
      };
    case "empty":
      return { raw: "", encode: false, description: "empty segment" };
    default: {
      let out = "";
      const length = rng.int(1, 40);
      for (let i = 0; i < length; i += 1) out += String.fromCharCode(rng.int(0x21, 0x7e));
      return { raw: out, encode: rng.bool(), description: "random printable" };
    }
  }
}

// ─── Header value generators ─────────────────────────────────────────────────

/** Header values must be ByteStrings without NUL/CR/LF; UTF-8 bytes of
 * non-Latin-1 text are mapped 1:1 into Latin-1 chars (what the wire carries). */
export function toHeaderSafe(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x00 || byte === 0x0a || byte === 0x0d) continue;
    out += String.fromCharCode(byte);
  }
  return out;
}

export function hostileHeaderValue(rng: Prng): string {
  const kind = rng.weighted<string>([
    [30, "corpus"],
    [15, "long"],
    [10, "numbers"],
    [10, "tabs"],
    [10, "highBytes"],
    [10, "list"],
    [15, "random"],
  ]);
  switch (kind) {
    case "corpus":
      return toHeaderSafe(rng.bool() ? rng.pick(UNICODE_ATOMS) : rng.pick(INJECTION_ATOMS));
    case "long":
      return repeatTo(rng.pick(["a", "Bearer ", ",", ";", "\t", "\u00ff"]), rng.int(1_000, 64_000));
    case "numbers":
      return rng.pick([
        "-1",
        "0",
        "-0",
        "1e309",
        "NaN",
        "Infinity",
        "4999999",
        "5000000",
        "5000001",
        "99999999999999999999",
        "0x10",
        "1,2",
        " 42 ",
        "+7",
        "７",
      ]);
    case "tabs":
      return rng.pick(["\t", " \t ", "a\tb", "\x0b", "\x0c", "\x7f", "\x1b[31m"]);
    case "highBytes": {
      let out = "";
      const length = rng.int(1, 64);
      for (let i = 0; i < length; i += 1) out += String.fromCharCode(rng.int(0x80, 0xff));
      return out;
    }
    case "list": {
      const count = rng.int(2, 200);
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1)
        parts.push(
          rng.pick([
            "1.1.1.1",
            "unknown",
            "::1",
            "0.0.0.0",
            "203.0.113.9",
            "\u00ff",
            "999.999.999.999",
            "127.0.0.1",
            " ",
            "",
          ]),
        );
      return parts.join(",");
    }
    default: {
      let out = "";
      const length = rng.int(1, 200);
      for (let i = 0; i < length; i += 1) {
        const c = rng.int(0x01, 0xff);
        if (c === 0x0a || c === 0x0d) continue;
        out += String.fromCharCode(c);
      }
      return out;
    }
  }
}

/** Authorization header values that must never authenticate. */
export function hostileAuthorization(
  rng: Prng,
  realJwt: () => string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const b64url = (value: string): string =>
    btoa(String.fromCharCode(...new TextEncoder().encode(value)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const jwt = (header: unknown, payload: unknown, sig = "sig"): string =>
    `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${sig}`;
  const kind = rng.weighted<string>([
    [10, "empty"],
    [10, "schemeOnly"],
    [10, "wrongScheme"],
    [15, "garbage"],
    [25, "badClaims"],
    [10, "segments"],
    [10, "issVariants"],
    [10, "mangledReal"],
  ]);
  switch (kind) {
    case "empty":
      return rng.pick(["", " ", "Bearer", "Bearer ", "Bearer  ", "bearer ", "BEARER x"]);
    case "schemeOnly":
      return rng.pick([
        "Bearer null",
        "Bearer undefined",
        "Bearer true",
        "Bearer 0",
        "Bearer -1",
        "Bearer ..",
        "Bearer ...",
        "Bearer a.b",
        "Bearer a.b.c.d",
        "Bearer .",
      ]);
    case "wrongScheme":
      return rng.pick([
        `Basic ${btoa("admin:admin")}`,
        "Digest x",
        "Token abc",
        "apikey anon",
        "Bearer: x",
        `Bearer,${realJwt()}`,
        `Bearer ${realJwt()} ${realJwt()}`,
      ]);
    case "garbage":
      return `Bearer ${toHeaderSafe(hostileString(rng, { maxLength: 8_192 }))}`;
    case "badClaims": {
      const sub = rng.pick([
        rng.uuid(),
        "",
        null,
        123,
        [],
        {},
        "\u0000",
        repeatTo("s", 5_000),
        "__proto__",
        { __proto__: { x: 1 } },
      ]);
      const exp = rng.pick([
        0,
        -1,
        1,
        nowSeconds - 1,
        nowSeconds + 3600,
        Number.MAX_SAFE_INTEGER,
        Infinity,
        "9999999999",
        "never",
        null,
        true,
        [],
        nowSeconds * 1_000_000,
      ]);
      const iss = rng.pick([
        "https://accounts.google.com",
        "accounts.google.com",
        "https://appleid.apple.com",
        "http://supabase.test/auth/v1",
        "https://ucqnaiwqwjtgvlduiuib.supabase.co/auth/v1",
      ]);
      return `Bearer ${jwt(rng.pick([{ alg: "RS256", typ: "JWT" }, { alg: "none" }, { alg: "HS256", kid: "../../etc/passwd" }, {}, [], null]), rng.pick([{ iss, sub, exp }, { iss, sub, exp, aud: "other" }, { iss, exp }, { sub, exp }, [iss, sub, exp], null, "string", 1, { iss, sub, exp, __proto__: { polluted: 1 } }]), rng.pick(["sig", "", "\u00ff", repeatTo("s", 10_000)]))}`;
    }
    case "segments": {
      const real = realJwt();
      const parts = real.split(".");
      return `Bearer ${rng.pick([
        parts[0],
        `${parts[0]}.${parts[1]}`,
        `${parts[0]}.${parts[1]}.`,
        `.${parts[1]}.`,
        `${parts[0]}..${parts[2]}`,
        `${parts[0]}.${parts[1]}.${parts[2]}.${parts[2]}`,
        `${parts[0]}.${parts[1]}!.${parts[2]}`,
        `${parts[0]}.${parts[1].slice(0, -3)}.${parts[2]}`,
        `${parts[0]}.${parts[1]}=.${parts[2]}`,
        `${parts[0]}.${parts[1].replace(/-/g, "+").replace(/_/g, "/")}.${parts[2]}`,
        `${parts[0]}.${parts[1]}${"A".repeat(40_000)}.${parts[2]}`,
      ])}`;
    }
    case "issVariants": {
      const iss = rng.pick([
        "https://accounts.google.com.evil.example",
        "https://evil.example/accounts.google.com",
        "https://accounts.google.com/",
        "https://ACCOUNTS.GOOGLE.COM",
        "http://accounts.google.com",
        "https://accounts.google.com\u0000",
        "https://accounts.google.com ",
        " https://accounts.google.com",
        "https://appleid.apple.com.evil.example",
        "https://appleid.apple.com/auth",
        "https://evil.example/auth/v1",
        "/auth/v1",
        "auth/v1",
        "https://evil.example#/auth/v1",
        "https://evil.example/auth/v1/",
        "https://accounts.g\u200boogle.com",
        "https://accounts.googIe.com",
        "https://xn--accounts-google.com",
        "",
        null,
        123,
        ["https://accounts.google.com"],
        { iss: "https://accounts.google.com" },
      ]);
      return `Bearer ${jwt({ alg: "RS256", typ: "JWT" }, { iss, sub: rng.uuid(), exp: nowSeconds + 6 * 3600 })}`;
    }
    default: {
      const real = realJwt();
      const position = rng.int(0, real.length - 1);
      const mutation = rng.pick(["\u00ff", "%", " ", "\t", "=", "/", "+", "\\", ".", "\u0000"]);
      return `Bearer ${toHeaderSafe(real.slice(0, position) + mutation + real.slice(position + 1))}`;
    }
  }
}

/** Reads ≥ 5,000,001 bytes so the streamed body cap must trip. */
export function oversizedBodyText(rng: Prng): { text: string; description: string } {
  const bytes = rng.pick([5_000_001, 5_000_002, 5_500_000, 6_000_000, 8_000_000]);
  const shape = rng.int(0, 3);
  switch (shape) {
    case 0:
      return {
        text: `{"shots":"${repeatTo("a", bytes)}"}`,
        description: `valid JSON ${bytes + 12} bytes`,
      };
    case 1:
      return { text: repeatTo(" ", bytes), description: `${bytes} bytes of whitespace` };
    case 2:
      return { text: `[${repeatTo("0,", bytes)}0]`, description: `~${bytes} byte array` };
    default:
      return { text: repeatTo("{", bytes), description: `${bytes} unclosed braces` };
  }
}
