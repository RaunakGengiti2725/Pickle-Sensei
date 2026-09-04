import { SeededRng } from "./rng.js";

/**
 * Seeded boundary/malformed input generators for @pickle/queue.
 *
 * Two attack surfaces:
 *  - WIRE bodies (`genRawBody`): what a broker may hand `SqsJobQueue.receive`
 *    as `Message.Body` — truncated/garbage JSON, non-object JSON, wrong-typed
 *    envelope fields, prototype-pollution keys, numeric overflow, huge and
 *    hostile strings, future schema versions, empty containers.
 *  - PRODUCER values (`genJsValue`, `genKind`): what a caller may pass to
 *    `enqueue(kind, payload)` — values JSON cannot represent (BigInt, Symbol,
 *    function, circular, throwing toJSON/getters/Proxy), lossy values (NaN,
 *    Infinity, -0, undefined, Date, Map), hostile strings, deep/wide shapes.
 *
 * Nothing here is a fixture with a label; every value is synthesized from the
 * seed so a failing iteration is replayable by seed alone.
 */

export interface GeneratedRawBody {
  category: string;
  body: string | undefined;
  /** Kind the harness EXPECTS after decode, when the body is a well-formed envelope. */
  expectedKind?: string;
  /** JSON.parse(body) is expected to succeed (so `__malformed__` must NOT be reported). */
  parses: boolean;
}

export interface GeneratedValue {
  category: string;
  value: unknown;
  /** JSON.stringify is expected to throw for this value (BigInt, circular, throwing hooks). */
  unserializable: boolean;
}

const HOSTILE_STRINGS: ReadonlyArray<readonly [string, string]> = [
  ["path-traversal", "../../../../etc/passwd"],
  ["path-traversal-encoded", "..%2F..%2F..%2Fetc%2Fpasswd"],
  ["path-traversal-backslash", "..\\..\\windows\\system32"],
  ["path-traversal-null", "../../etc/passwd%00.png"],
  ["null-byte", "asset\u0000id"],
  ["control-chars", "\u0001\u0002\u0003\u001f\u007f"],
  ["lone-high-surrogate", "\ud800"],
  ["lone-low-surrogate", "\udc00"],
  ["surrogate-reversed", "\udc00\ud800"],
  ["bom-prefix", "\ufeffmedia.process"],
  ["nfc", "caf\u00e9"],
  ["nfd", "cafe\u0301"],
  ["rtl-override", "\u202eevil\u202c"],
  ["zero-width", "me\u200bdia\u200c.\u200dprocess"],
  ["zwj-emoji", "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}"],
  ["fullwidth", "\uff4d\uff45\uff44\uff49\uff41"],
  ["sql-ish", "'; DROP TABLE media_asset; --"],
  ["template", "{{constructor.constructor('return 1')()}}"],
  ["format-string", "%s%s%s%n%x"],
  ["url", "https://example.invalid/../%2e%2e/"],
  ["json-in-string", '{"kind":"media.process"}'],
  ["whitespace-only", " \t\r\n"],
  ["empty", ""],
  ["max-codepoint", "\u{10FFFF}"],
  ["noncharacter", "\ufffe\uffff"],
  ["private-use", "\ue000\uf8ff"],
  ["kind-lookalike", "media.process\u0000"],
  ["homoglyph-kind", "medi\u0430.process"],
];

const BOUNDARY_NUMBERS: ReadonlyArray<readonly [string, number]> = [
  ["zero", 0],
  ["neg-zero", -0],
  ["one", 1],
  ["two", 2],
  ["ten", 10],
  ["eleven", 11],
  ["neg-one", -1],
  ["nan", Number.NaN],
  ["pos-inf", Number.POSITIVE_INFINITY],
  ["neg-inf", Number.NEGATIVE_INFINITY],
  ["frac", 1.5],
  ["sub-one", 0.9999],
  ["int32-max", 2147483647],
  ["int32-overflow", 2147483648],
  ["uint32-overflow", 4294967296],
  ["safe-int-max", Number.MAX_SAFE_INTEGER],
  ["unsafe-int", Number.MAX_SAFE_INTEGER + 2],
  ["max-value", Number.MAX_VALUE],
  ["min-value", Number.MIN_VALUE],
  ["epsilon", Number.EPSILON],
  ["billion", 1e9],
];

export function genBoundaryNumber(rng: SeededRng): { category: string; value: number } {
  const [category, value] = rng.pick(BOUNDARY_NUMBERS);
  return { category, value };
}

export function genHostileString(rng: SeededRng): { category: string; value: string } {
  const [category, value] = rng.pick(HOSTILE_STRINGS);
  return { category, value };
}

/** Strings at and past byte / code-unit / grapheme caps. */
export function genLongString(rng: SeededRng): { category: string; value: string } {
  const variant = rng.int(6);
  switch (variant) {
    case 0:
      return { category: "long-64k-ascii", value: "x".repeat(65536) };
    case 1:
      return { category: "long-64k+1-ascii", value: "y".repeat(65537) };
    case 2:
      // 65,536 code units but 4 bytes each in UTF-8 -> 262,144 bytes on the wire
      // before JSON quoting: the byte cap and the code-unit cap disagree here.
      return { category: "long-64k-cjk-4byte", value: "\u{20000}".repeat(32768) };
    case 3:
      return { category: "long-256k+1-ascii", value: "z".repeat(262145) };
    case 4:
      // ~20k graphemes but 140k code units (ZWJ family emoji).
      return {
        category: "long-grapheme-cluster",
        value: "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}".repeat(20000),
      };
    default:
      return { category: "long-300k-nul", value: "\u0000".repeat(300000) };
  }
}

function jsonNumberLiteral(rng: SeededRng): { category: string; literal: string } {
  return rng.pick<{ category: string; literal: string }>([
    { category: "num-overflow-1e400", literal: "1e400" },
    { category: "num-neg-overflow", literal: "-1e400" },
    { category: "num-neg-zero", literal: "-0" },
    { category: "num-neg-zero-frac", literal: "-0.0" },
    { category: "num-unsafe-int", literal: "9007199254740993" },
    { category: "num-huge-int", literal: "123456789012345678901234567890" },
    { category: "num-underflow", literal: "1e-400" },
    { category: "num-max-value", literal: "1.7976931348623157e308" },
    { category: "num-leading-zero", literal: "007" },
    { category: "num-hex", literal: "0x1f" },
    { category: "num-nan-literal", literal: "NaN" },
    { category: "num-inf-literal", literal: "Infinity" },
    { category: "num-plus-prefix", literal: "+1" },
    { category: "num-trailing-dot", literal: "1." },
    { category: "num-exp-only", literal: "1e" },
  ]);
}

/** Wire-level bodies for the decode path. */
export function genRawBody(rng: SeededRng): GeneratedRawBody {
  const bucket = rng.int(12);
  switch (bucket) {
    case 0: {
      // Truncated well-formed envelope at a seeded cut point.
      const full = JSON.stringify({ kind: "media.process", payload: { mediaAssetId: "a1" } });
      const cut = 1 + rng.int(full.length - 1);
      return { category: "json-truncated", body: full.slice(0, cut), parses: false };
    }
    case 1: {
      const [category, body] = rng.pick<readonly [string, string]>([
        ["json-garbage-braces", "{not json"],
        ["json-unbalanced", '{"kind":"k","payload":[1,2}'],
        ["json-trailing-comma", '{"kind":"k",}'],
        ["json-single-quotes", "{'kind':'k'}"],
        ["json-comment", '{"kind":"k"} // c'],
        ["json-bom", '\ufeff{"kind":"k"}'],
        ["json-concatenated", '{"kind":"a"}{"kind":"b"}'],
        ["json-nul-byte", '{"kind":"k\u0000"}'],
        ["json-raw-newline-in-string", '{"kind":"k\n"}'],
        ["json-unquoted-key", '{kind:"k"}'],
        ["json-undefined-literal", '{"kind":undefined}'],
        ["json-nan-literal", '{"kind":"k","payload":NaN}'],
        ["json-hex-escape", '{"kind":"\\x41"}'],
        ["json-bad-unicode-escape", '{"kind":"\\uZZZZ"}'],
        ["json-lone-surrogate-escape", '{"kind":"\\ud800","payload":1}'],
        ["json-binary", "\u0000\u0001\u0002\u00ff\u00fe"],
        ["json-xml", "<kind>media.process</kind>"],
        ["json-yaml", "kind: media.process\npayload: 1"],
        ["json-base64", "eyJraW5kIjoia2luZCJ9"],
        ["json-form", "kind=media.process&payload=1"],
      ]);
      // "\ud800" as a JSON escape parses fine (lone surrogate string).
      const parses = category === "json-lone-surrogate-escape";
      return { category, body, parses, ...(parses ? { expectedKind: "\ud800" } : {}) };
    }
    case 2: {
      // Non-object JSON documents.
      const [category, body] = rng.pick<readonly [string, string]>([
        ["json-nonobject-null", "null"],
        ["json-nonobject-number", "123"],
        ["json-nonobject-negzero", "-0"],
        ["json-nonobject-string", '"media.process"'],
        ["json-nonobject-true", "true"],
        ["json-nonobject-false", "false"],
        ["json-nonobject-array-empty", "[]"],
        ["json-nonobject-array", '[{"kind":"k"}]'],
        ["json-nonobject-string-empty", '""'],
        ["json-nonobject-overflow", "1e400"],
      ]);
      return { category, body, parses: true };
    }
    case 3: {
      // Envelope shape violations.
      const shapes: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
        ["shape-empty-object", {}],
        ["shape-missing-kind", { payload: { a: 1 } }],
        ["shape-missing-payload", { kind: "media.process" }],
        ["shape-kind-null", { kind: null, payload: 1 }],
        ["shape-kind-number", { kind: 5, payload: 1 }],
        ["shape-kind-bool", { kind: true, payload: 1 }],
        ["shape-kind-object", { kind: { nested: "media.process" }, payload: 1 }],
        ["shape-kind-array", { kind: ["media.process"], payload: 1 }],
        ["shape-kind-empty", { kind: "", payload: 1 }],
        ["shape-kind-whitespace", { kind: "   ", payload: 1 }],
        ["shape-future-schema-v2", { schemaVersion: 2, kind: "media.process", payload: 1 }],
        ["shape-future-schema-v99", { v: 99, type: "media.process", body: { a: 1 } }],
        ["shape-extra-keys", { kind: "media.process", payload: 1, attempt: 999, id: "spoof" }],
        ["shape-payload-null", { kind: "media.process", payload: null }],
        ["shape-payload-array-empty", { kind: "media.process", payload: [] }],
        ["shape-payload-object-empty", { kind: "media.process", payload: {} }],
        ["shape-kind-attempt-negative", { kind: "media.process", payload: 1, attempt: -1 }],
        ["shape-kind-ack-spoof", { kind: "media.process", payload: 1, ack: "function" }],
      ];
      const [category, shape] = rng.pick(shapes);
      const kind = shape["kind"];
      return {
        category,
        body: JSON.stringify(shape),
        parses: true,
        ...(typeof kind === "string" ? { expectedKind: kind } : {}),
      };
    }
    case 4: {
      // Prototype pollution attempts through the parsed envelope and payload.
      const [category, body] = rng.pick<readonly [string, string]>([
        ["proto-top", '{"__proto__":{"polluted":"yes"},"kind":"media.process","payload":1}'],
        ["proto-payload", '{"kind":"media.process","payload":{"__proto__":{"polluted":"yes"}}}'],
        [
          "proto-constructor",
          '{"kind":"media.process","payload":{"constructor":{"prototype":{"polluted":"yes"}}}}',
        ],
        ["proto-kind", '{"kind":"__proto__","payload":1}'],
        ["proto-nested-deep", '{"kind":"media.process","payload":{"a":{"__proto__":{"b":1}}}}'],
        ["proto-array", '{"kind":"media.process","payload":[{"__proto__":{"polluted":"yes"}}]}'],
        ["proto-tostring", '{"kind":"toString","payload":{"toString":"x","valueOf":"y"}}'],
        ["proto-hasown", '{"kind":"hasOwnProperty","payload":{"hasOwnProperty":1}}'],
      ]);
      const parsed = JSON.parse(body) as { kind: unknown };
      return {
        category,
        body,
        parses: true,
        ...(typeof parsed.kind === "string" ? { expectedKind: parsed.kind } : {}),
      };
    }
    case 5: {
      const { category, literal } = jsonNumberLiteral(rng);
      const body = `{"kind":"media.process","payload":${literal}}`;
      let parses = true;
      try {
        JSON.parse(body);
      } catch {
        parses = false;
      }
      return {
        category: `payload-${category}`,
        body,
        parses,
        ...(parses ? { expectedKind: "media.process" } : {}),
      };
    }
    case 6: {
      const { category, value } = genHostileString(rng);
      const asKind = rng.chance(0.5);
      const body = asKind
        ? JSON.stringify({ kind: value, payload: 1 })
        : JSON.stringify({ kind: "media.process", payload: { mediaAssetId: value } });
      return {
        category: `${asKind ? "kind" : "payload"}-${category}`,
        body,
        parses: true,
        expectedKind: asKind ? value : "media.process",
      };
    }
    case 7: {
      const { category, value } = genLongString(rng);
      const asKind = rng.chance(0.3);
      const body = asKind
        ? JSON.stringify({ kind: value, payload: 1 })
        : JSON.stringify({ kind: "media.process", payload: value });
      return {
        category: `${asKind ? "kind" : "payload"}-${category}`,
        body,
        parses: true,
        expectedKind: asKind ? value : "media.process",
      };
    }
    case 8: {
      // Deep nesting: bounded depth parses; pathological depth must be rejected
      // gracefully (RangeError inside JSON.parse is still "malformed").
      const depth = rng.pick([64, 512, 4096, 100000]);
      const open = "[".repeat(depth);
      const close = "]".repeat(depth);
      const body = `{"kind":"media.process","payload":${open}${close}}`;
      let parses = true;
      try {
        JSON.parse(body);
      } catch {
        parses = false;
      }
      return {
        category: `payload-deep-${depth}`,
        body,
        parses,
        ...(parses ? { expectedKind: "media.process" } : {}),
      };
    }
    case 9: {
      const [category, body] = rng.pick<readonly [string, string | undefined]>([
        ["body-undefined", undefined],
        ["body-empty", ""],
        ["body-space", " "],
        ["body-newline", "\n"],
        ["body-nul", "\u0000"],
        ["body-tab", "\t"],
        ["body-crlf", "\r\n"],
      ]);
      // `Body ?? "{}"` makes an absent body parse as an empty envelope.
      return { category, body, parses: body === undefined };
    }
    case 10: {
      // Wide objects / arrays.
      const width = rng.pick([1000, 10000, 50000]);
      const arr = new Array<number>(width).fill(0);
      const wideObject: Record<string, number> = {};
      for (let index = 0; index < width; index += 1) wideObject[`k${index}`] = index;
      const useArray = rng.chance(0.5);
      return {
        category: `payload-wide-${useArray ? "array" : "object"}-${width}`,
        body: JSON.stringify({ kind: "media.process", payload: useArray ? arr : wideObject }),
        parses: true,
        expectedKind: "media.process",
      };
    }
    default: {
      // Random byte soup of seeded length: never valid JSON with overwhelming
      // probability; the harness checks the ground truth with JSON.parse.
      const length = 1 + rng.int(48);
      let body = "";
      for (let index = 0; index < length; index += 1) body += String.fromCharCode(rng.int(0x10000));
      let parses = true;
      try {
        JSON.parse(body);
      } catch {
        parses = false;
      }
      return { category: "byte-soup", body, parses };
    }
  }
}

/** Producer-side JS values (what a caller can hand `enqueue`). */
export function genJsValue(rng: SeededRng): GeneratedValue {
  const bucket = rng.int(10);
  switch (bucket) {
    case 0:
      return rng.pick<GeneratedValue>([
        { category: "js-bigint", value: 10n, unserializable: true },
        { category: "js-bigint-nested", value: { n: 2n ** 64n }, unserializable: true },
        { category: "js-symbol", value: Symbol("s"), unserializable: false },
        { category: "js-symbol-nested", value: { s: Symbol("s") }, unserializable: false },
        { category: "js-function", value: () => 1, unserializable: false },
        { category: "js-function-nested", value: { f() {} }, unserializable: false },
      ]);
    case 1: {
      const circular: { a: number; self?: unknown } = { a: 1 };
      circular.self = circular;
      const arrayCycle: unknown[] = [1];
      arrayCycle.push(arrayCycle);
      return rng.pick<GeneratedValue>([
        { category: "js-circular-object", value: circular, unserializable: true },
        { category: "js-circular-array", value: arrayCycle, unserializable: true },
        {
          category: "js-toJSON-throws",
          value: {
            toJSON() {
              throw new Error("toJSON boom");
            },
          },
          unserializable: true,
        },
        {
          category: "js-getter-throws",
          value: Object.defineProperty({}, "x", {
            enumerable: true,
            get() {
              throw new Error("getter boom");
            },
          }),
          unserializable: true,
        },
        {
          category: "js-proxy-throws",
          value: new Proxy(
            {},
            {
              ownKeys() {
                throw new Error("proxy boom");
              },
            },
          ),
          unserializable: true,
        },
        {
          category: "js-toJSON-returns-bigint",
          value: { toJSON: () => 1n },
          unserializable: true,
        },
      ]);
    }
    case 2:
      return rng.pick<GeneratedValue>([
        { category: "js-nan", value: Number.NaN, unserializable: false },
        { category: "js-pos-inf", value: Number.POSITIVE_INFINITY, unserializable: false },
        { category: "js-neg-inf", value: Number.NEGATIVE_INFINITY, unserializable: false },
        { category: "js-neg-zero", value: -0, unserializable: false },
        {
          category: "js-numeric-mix",
          value: { n: Number.NaN, i: Number.POSITIVE_INFINITY, z: -0, m: Number.MAX_VALUE },
          unserializable: false,
        },
        { category: "js-unsafe-int", value: 2 ** 53 + 1, unserializable: false },
        { category: "js-min-value", value: Number.MIN_VALUE, unserializable: false },
      ]);
    case 3:
      return rng.pick<GeneratedValue>([
        { category: "js-undefined", value: undefined, unserializable: false },
        { category: "js-null", value: null, unserializable: false },
        { category: "js-undefined-nested", value: { a: undefined, b: 1 }, unserializable: false },
        {
          category: "js-sparse-array",
          value: Object.assign(new Array<number>(3), { 0: 1, 2: 3 }),
          unserializable: false,
        },
        { category: "js-array-holes-only", value: new Array(5), unserializable: false },
        { category: "js-empty-object", value: {}, unserializable: false },
        { category: "js-empty-array", value: [], unserializable: false },
        { category: "js-empty-string", value: "", unserializable: false },
        { category: "js-false", value: false, unserializable: false },
        { category: "js-zero", value: 0, unserializable: false },
      ]);
    case 4:
      return rng.pick<GeneratedValue>([
        { category: "js-date", value: new Date(0), unserializable: false },
        { category: "js-invalid-date", value: new Date(Number.NaN), unserializable: false },
        { category: "js-map", value: new Map([["a", 1]]), unserializable: false },
        { category: "js-set", value: new Set([1, 2]), unserializable: false },
        { category: "js-regexp", value: /x/g, unserializable: false },
        { category: "js-error", value: new Error("e"), unserializable: false },
        { category: "js-uint8array", value: new Uint8Array([1, 2, 3]), unserializable: false },
        {
          category: "js-arraybuffer",
          value: new ArrayBuffer(8),
          unserializable: false,
        },
        { category: "js-boxed-number", value: new Number(1), unserializable: false },
        { category: "js-boxed-string", value: new String("s"), unserializable: false },
        { category: "js-null-proto", value: Object.create(null), unserializable: false },
        {
          category: "js-class-instance",
          value: new (class Job {
            public readonly id = "x";
          })(),
          unserializable: false,
        },
      ]);
    case 5: {
      const { category, value } = genHostileString(rng);
      return rng.chance(0.5)
        ? { category: `js-string-${category}`, value, unserializable: false }
        : {
            category: `js-string-nested-${category}`,
            value: { mediaAssetId: value },
            unserializable: false,
          };
    }
    case 6: {
      const { category, value } = genLongString(rng);
      return { category: `js-${category}`, value, unserializable: false };
    }
    case 7: {
      const polluted: Record<string, unknown> = JSON.parse(
        '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}}}',
      ) as Record<string, unknown>;
      return rng.pick<GeneratedValue>([
        { category: "js-proto-own-key", value: polluted, unserializable: false },
        {
          category: "js-proto-nested",
          value: { a: { ["__proto__"]: { polluted: "yes" } } },
          unserializable: false,
        },
        {
          category: "js-prototype-key",
          value: { prototype: { polluted: "yes" } },
          unserializable: false,
        },
      ]);
    }
    case 8: {
      const depth = rng.pick([64, 512, 4096, 20000]);
      let nested: unknown = 1;
      for (let index = 0; index < depth; index += 1) nested = [nested];
      // JSON.stringify recurses; past a few thousand levels V8 throws RangeError.
      let unserializable = false;
      try {
        JSON.stringify(nested);
      } catch {
        unserializable = true;
      }
      return { category: `js-deep-${depth}`, value: nested, unserializable };
    }
    default: {
      const width = rng.pick([1000, 10000, 50000]);
      const wide: Record<string, number> = {};
      for (let index = 0; index < width; index += 1) wide[`k${index}`] = index;
      return { category: `js-wide-${width}`, value: wide, unserializable: false };
    }
  }
}

/** `kind` argument: mostly hostile strings, sometimes the wrong type entirely. */
export function genKind(rng: SeededRng): { category: string; value: unknown } {
  if (rng.chance(0.55)) {
    const { category, value } = genHostileString(rng);
    return { category: `kind-${category}`, value };
  }
  if (rng.chance(0.3)) {
    return { category: "kind-valid", value: rng.pick(["media.process", "media.purge", "k"]) };
  }
  return rng.pick<{ category: string; value: unknown }>([
    { category: "kind-null", value: null },
    { category: "kind-undefined", value: undefined },
    { category: "kind-number", value: 5 },
    { category: "kind-nan", value: Number.NaN },
    { category: "kind-object", value: { a: 1 } },
    { category: "kind-array", value: ["media.process"] },
    { category: "kind-bool", value: true },
    { category: "kind-bigint", value: 1n },
    { category: "kind-symbol", value: Symbol("k") },
    { category: "kind-long-64k", value: "k".repeat(65536) },
  ]);
}

/** Compact, never-throwing description of any JS value for the results table. */
export function describeValue(value: unknown, limit = 160): string {
  let text: string;
  try {
    const seen = new WeakSet<object>();
    text = JSON.stringify(value, (_key, inner: unknown) => {
      if (typeof inner === "bigint") return `${inner.toString()}n`;
      if (typeof inner === "symbol") return inner.toString();
      if (typeof inner === "function") return "[Function]";
      if (typeof inner === "number" && !Number.isFinite(inner)) return String(inner);
      if (typeof inner === "number" && Object.is(inner, -0)) return "-0";
      if (inner !== null && typeof inner === "object") {
        if (seen.has(inner)) return "[Circular]";
        seen.add(inner);
      }
      return inner;
    });
    if (text === undefined) text = String(value);
  } catch (error) {
    text = `[unstringifiable: ${error instanceof Error ? error.message : String(error)}]`;
  }
  return text.length > limit ? `${text.slice(0, limit)}…(${text.length} chars)` : text;
}
