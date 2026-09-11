import assert from "node:assert/strict";
import { OFFLINE_SIGNED_GRANT_SCHEMA_VERSION } from "../../../packages/shared-types/src/offlineAuthorization.ts";
import {
  CanonicalDigestError,
  OFFLINE_CANONICAL_JSON_LIMITS,
  OFFLINE_DIGEST_TRUST_BOUNDARY,
  canonicalizeOfflineJson,
  digestCanonicalOfflineJson,
  digestOfflineGrantTransport,
} from "./canonicalDigest.ts";

Deno.test("RFC8785 section 3.2.2: primitives, rounding, escaping and property sorting", () => {
  const input = JSON.parse(String.raw`{
    "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
    "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
    "literals": [null, true, false]
  }`);
  assert.equal(
    canonicalizeOfflineJson(input),
    String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
  );
});

Deno.test("RFC8785 section 3.2.3: raw UTF-16 ordering, not code-point or locale ordering", () => {
  const input = {
    "\u20ac": "Euro Sign",
    "\r": "Carriage Return",
    "\ufb33": "Hebrew Letter Dalet With Dagesh",
    "1": "One",
    "\ud83d\ude00": "Supplementary Character",
    "\u0080": "Control",
    "\u00f6": "Latin Small Letter O With Diaeresis",
  };
  const ordered = ["\r", "1", "\u0080", "\u00f6", "\u20ac", "\ud83d\ude00", "\ufb33"];
  const expected = `{${ordered
    .map((key) => `${JSON.stringify(key)}:${JSON.stringify(input[key as keyof typeof input])}`)
    .join(",")}}`;
  assert.equal(canonicalizeOfflineJson(input), expected);
});

const NUMBER_VECTORS: readonly (readonly [string, string | null])[] = [
  ["0000000000000000", "0"],
  ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"],
  ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"],
  ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"],
  ["c340000000000000", "-9007199254740992"],
  ["4430000000000000", "295147905179352830000"],
  ["7fffffffffffffff", null],
  ["7ff0000000000000", null],
  ["44b52d02c7e14af5", "9.999999999999997e+22"],
  ["44b52d02c7e14af6", "1e+23"],
  ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000"],
  ["444b1ae4d6e2ef4f", "999999999999999900000"],
  ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
  ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"],
  ["41b3de4355555554", "333333333.33333325"],
  ["41b3de4355555555", "333333333.3333333"],
  ["41b3de4355555556", "333333333.3333334"],
  ["41b3de4355555557", "333333333.33333343"],
  ["becbf647612f3696", "-0.0000033333333333333333"],
  ["43143ff3c1cb0959", "1424953923781206.2"],
];

for (const [hex, expected] of NUMBER_VECTORS) {
  Deno.test(`RFC8785 Appendix B binary64 vector ${hex}`, () => {
    const bits = new DataView(new ArrayBuffer(8));
    bits.setBigUint64(0, BigInt(`0x${hex}`));
    const number = bits.getFloat64(0);
    if (expected === null) {
      assert.throws(() => canonicalizeOfflineJson(number), CanonicalDigestError);
    } else {
      assert.equal(canonicalizeOfflineJson(number), expected);
    }
  });
}

Deno.test(
  "canonical JSON sorts integer-looking keys lexically and recurses without sorting arrays",
  () => {
    assert.equal(
      canonicalizeOfflineJson({ "2": [{ z: false, a: null }, "not-a-number"], "10": 3, "1": 2 }),
      '{"1":2,"10":3,"2":[{"a":null,"z":false},"not-a-number"]}',
    );
    assert.notEqual(canonicalizeOfflineJson([1, 2]), canonicalizeOfflineJson([2, 1]));
  },
);

for (const value of [
  "ordinary nonnumeric text",
  "00004",
  "1e400",
  "NaN",
  "Infinity",
  "\u00e9",
  "e\u0301",
  "\ud834\udd1e",
  '\u0000\b\t\n\f\r"\\/',
  "",
]) {
  Deno.test(
    `canonical JSON preserves nonnumeric/string Unicode data ${JSON.stringify(value)}`,
    () => {
      assert.equal(canonicalizeOfflineJson(value), JSON.stringify(value));
    },
  );
}

Deno.test("canonical JSON does not normalize Unicode or parse strings as source JSON", async () => {
  assert.notEqual(
    await digestCanonicalOfflineJson("\u00e9"),
    await digestCanonicalOfflineJson("e\u0301"),
  );
  assert.equal(
    canonicalizeOfflineJson('{"duplicate":1,"duplicate":2}'),
    '"{\\"duplicate\\":1,\\"duplicate\\":2}"',
  );
  assert.match(OFFLINE_DIGEST_TRUST_BOUNDARY, /rejecting duplicate member names/);
});

const MALFORMED_VALUES: readonly (readonly [string, unknown])[] = [
  ["undefined", undefined],
  ["function", () => 1],
  ["symbol", Symbol("not-json")],
  ["bigint", 1n],
  ["NaN", NaN],
  ["Infinity", Infinity],
  ["negative Infinity", -Infinity],
  ["Date", new Date(0)],
  ["Map", new Map()],
  ["Set", new Set()],
  ["RegExp", /data/],
  ["boxed number", Object(1)],
  ["boxed string", Object("data")],
  ["boxed boolean", Object(false)],
  ["Uint8Array", new Uint8Array([1])],
  ["ArrayBuffer", new ArrayBuffer(1)],
  ["custom prototype", Object.create({ inherited: 1 })],
  ["lone high surrogate", "\ud800"],
  ["lone low surrogate", "\udfff"],
  ["high surrogate followed by ASCII", "\ud800x"],
  ["trailing high surrogate", "x\ud800"],
  ["reversed surrogate pair", "\udc00\ud800"],
  ["two high surrogates", "\ud800\ud801"],
  ["surrogate property name", { ["\udead"]: 1 }],
];

for (const [name, value] of MALFORMED_VALUES) {
  Deno.test(
    `canonical JSON rejects ${name} at root and nested positions without lossy coercion`,
    async () => {
      for (const input of [value, [value], { nested: value }]) {
        assert.throws(() => canonicalizeOfflineJson(input), CanonicalDigestError);
        await assert.rejects(digestCanonicalOfflineJson(input), CanonicalDigestError);
      }
    },
  );
}

Deno.test("canonical JSON rejects accessors and toJSON without executing caller code", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "value", {
    enumerable: true,
    get() {
      calls += 1;
      return 1;
    },
  });
  const withToJson = {
    toJSON: () => {
      calls += 1;
      return {};
    },
  };
  assert.throws(() => canonicalizeOfflineJson(accessor), CanonicalDigestError);
  assert.throws(() => canonicalizeOfflineJson(withToJson), CanonicalDigestError);
  assert.equal(calls, 0);
});

Deno.test("canonical JSON rejects sparse, accessor, subclass and decorated arrays", () => {
  class NonDataArray extends Array {}
  const arrays = [
    new Array(1),
    Object.assign([1], { extra: true }),
    Object.assign([1], { [Symbol("extra")]: true }),
    Object.defineProperty([1], "0", { get: () => 1 }),
    Object.defineProperty([1], "0", { enumerable: false }),
    new NonDataArray(1),
  ];
  for (const value of arrays)
    assert.throws(() => canonicalizeOfflineJson(value), CanonicalDigestError);
});

Deno.test(
  "canonical JSON rejects symbol and hidden object properties rather than dropping them",
  () => {
    assert.throws(() => canonicalizeOfflineJson({ [Symbol("hidden")]: 1 }), CanonicalDigestError);
    assert.throws(
      () => canonicalizeOfflineJson(Object.defineProperty({}, "hidden", { value: 1 })),
      CanonicalDigestError,
    );
  },
);

Deno.test(
  "canonical JSON rejects cycles but accepts repeated noncyclic values and null prototypes",
  () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    assert.throws(() => canonicalizeOfflineJson(cyclic), CanonicalDigestError);
    const array: unknown[] = [];
    array.push({ array });
    assert.throws(() => canonicalizeOfflineJson(array), CanonicalDigestError);
    const shared = { a: false };
    assert.equal(canonicalizeOfflineJson([shared, shared]), '[{"a":false},{"a":false}]');
    const plain = Object.assign(Object.create(null), { toJSON: "data", a: null });
    Object.defineProperty(plain, "__proto__", { enumerable: true, value: "also data" });
    assert.equal(
      canonicalizeOfflineJson(plain),
      '{"__proto__":"also data","a":null,"toJSON":"data"}',
    );
  },
);

Deno.test("canonical JSON enforces depth and node limits at the exact boundary", () => {
  let nested: unknown = 0;
  for (let depth = 0; depth < OFFLINE_CANONICAL_JSON_LIMITS.maxDepth; depth += 1) nested = [nested];
  assert.doesNotThrow(() => canonicalizeOfflineJson(nested));
  assert.throws(() => canonicalizeOfflineJson([nested]), { code: "json_too_large" });
  assert.doesNotThrow(() =>
    canonicalizeOfflineJson(new Array(OFFLINE_CANONICAL_JSON_LIMITS.maxNodes - 1).fill(0)),
  );
  assert.throws(
    () => canonicalizeOfflineJson(new Array(OFFLINE_CANONICAL_JSON_LIMITS.maxNodes).fill(0)),
    { code: "json_too_large" },
  );
});

Deno.test(
  "canonical JSON enforces UTF-8 byte limits including escaping and non-ASCII expansion",
  () => {
    const limit = OFFLINE_CANONICAL_JSON_LIMITS.maxUtf8Bytes;
    assert.equal(
      new TextEncoder().encode(canonicalizeOfflineJson("a".repeat(limit - 2))).length,
      limit,
    );
    for (const value of [
      "a".repeat(limit - 1),
      "a".repeat(limit + 1),
      "\u00e9".repeat(limit / 2),
      "\u0000".repeat(limit / 4),
    ]) {
      assert.throws(() => canonicalizeOfflineJson(value), { code: "json_too_large" });
    }
  },
);

const DIGEST_VECTORS: readonly (readonly [unknown, string])[] = [
  [{}, "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
  [null, "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"],
  [{ b: 2, a: 1 }, "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"],
];
for (const [value, expected] of DIGEST_VECTORS) {
  Deno.test(`canonical SHA-256 fixed vector ${JSON.stringify(value)}`, async () => {
    assert.equal(await digestCanonicalOfflineJson(value), expected);
  });
}

Deno.test("canonical digest snapshots the data before asynchronous hashing", async () => {
  const input = { b: 2, a: 1 };
  const pending = digestCanonicalOfflineJson(input);
  input.b = 3;
  assert.equal(await pending, DIGEST_VECTORS[2][1]);
});

Deno.test(
  "compact digest hashes exact ASCII transport and explicitly does not prove a signature",
  async () => {
    const transport = {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: `e30.e30.${"A".repeat(86)}`,
    };
    assert.equal(
      await digestOfflineGrantTransport(transport),
      "64023db672a20b3f387f3ad52d7de99a5ba869f484395e39da57d760cbcfb330",
    );
    assert.notEqual(
      await digestOfflineGrantTransport(transport),
      await digestCanonicalOfflineJson(transport.compactJws),
    );
    assert.match(OFFLINE_DIGEST_TRUST_BOUNDARY, /not the signature/);
    for (const invalid of [
      transport.compactJws,
      { ...transport, compactJws: `${transport.compactJws}=` },
      { ...transport, extra: true },
    ]) {
      await assert.rejects(digestOfflineGrantTransport(invalid), { code: "invalid_compact_grant" });
    }
  },
);
