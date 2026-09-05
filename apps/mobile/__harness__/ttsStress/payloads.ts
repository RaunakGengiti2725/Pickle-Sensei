/**
 * Boundary / malformed payload generators for `tts.speak(text)`.
 *
 * `tts.speak` is typed `(text: string) => void`, but the bridge argument is
 * forwarded untouched, so the campaign feeds it every shape a JS caller (or a
 * caller through `as never`) could produce: wrong types, hostile objects,
 * prototype-pollution shapes, oversized / malformed / unnormalized text.
 *
 * Every generator is a pure function of the RNG so a payload is replayable
 * from its iteration seed.
 */

import type { Rng } from './rng';

export type PayloadCategory =
  | 'plain-cue'
  | 'empty-or-whitespace'
  | 'null-bytes'
  | 'control-chars'
  | 'oversize-ascii'
  | 'oversize-multibyte'
  | 'oversize-combining'
  | 'unicode-normalization'
  | 'lone-surrogates'
  | 'emoji-zwj'
  | 'malformed-json-text'
  | 'path-traversal'
  | 'injection-markup'
  | 'numeric-boundary'
  | 'numeric-string'
  | 'bigint'
  | 'nullish'
  | 'boolean'
  | 'symbol'
  | 'function'
  | 'object-shape'
  | 'hostile-object'
  | 'prototype-pollution'
  | 'future-schema'
  | 'empty-collection'
  | 'repeated-cue-burst'
  | 'mixed-script-rtl'
  | 'homoglyph';

export const PAYLOAD_CATEGORIES: readonly PayloadCategory[] = [
  'plain-cue',
  'empty-or-whitespace',
  'null-bytes',
  'control-chars',
  'oversize-ascii',
  'oversize-multibyte',
  'oversize-combining',
  'unicode-normalization',
  'lone-surrogates',
  'emoji-zwj',
  'malformed-json-text',
  'path-traversal',
  'injection-markup',
  'numeric-boundary',
  'numeric-string',
  'bigint',
  'nullish',
  'boolean',
  'symbol',
  'function',
  'object-shape',
  'hostile-object',
  'prototype-pollution',
  'future-schema',
  'empty-collection',
  'repeated-cue-burst',
  'mixed-script-rtl',
  'homoglyph',
];

export interface GeneratedPayload {
  category: PayloadCategory;
  /** The value handed to `tts.speak`. */
  value: unknown;
  /** Short, JSON-safe description for the results table. */
  describe: string;
  /**
   * Whether the payload is a plain data value whose JSON snapshot can be
   * compared before/after the call to detect mutation by the wrapper.
   */
  snapshotable: boolean;
}

const CUES = [
  'Paddle up',
  'Bend your knees',
  'Soft hands',
  'Step in',
  'Contact out front',
  'Nice dink',
  'Reset',
  'Stay low through the shot',
  'Follow through to the target',
  'Eyes on the ball',
];

const ASCII_WORDS = ['paddle', 'dink', 'volley', 'reset', 'kitchen', 'serve'];

function repeatTo(unit: string, targetUtf16Length: number): string {
  if (unit.length === 0) throw new Error('repeatTo: empty unit');
  const reps = Math.ceil(targetUtf16Length / unit.length);
  return unit.repeat(reps).slice(0, targetUtf16Length);
}

function jsonSafe(text: string, max = 48): string {
  const head = text.length > max ? `${text.slice(0, max)}…` : text;
  return JSON.stringify(head).slice(1, -1);
}

function describeString(text: string): string {
  return `str(len=${text.length}) "${jsonSafe(text)}"`;
}

function str(
  category: PayloadCategory,
  value: string,
  describe?: string,
): GeneratedPayload {
  return {
    category,
    value,
    describe: describe ?? describeString(value),
    snapshotable: true,
  };
}

function nonString(
  category: PayloadCategory,
  value: unknown,
  describe: string,
  snapshotable = false,
): GeneratedPayload {
  return { category, value, describe, snapshotable };
}

const SIZE_TIERS: readonly number[] = [
  64 * 1024,
  64 * 1024 + 1,
  100_000,
  256 * 1024,
  1024 * 1024,
];

const NORMALIZATION_PAIRS: readonly (readonly [string, string])[] = [
  ['\u00e9', 'e\u0301'], // é NFC vs NFD
  ['\u00f1', 'n\u0303'], // ñ
  ['\u1e69', 's\u0323\u0307'], // ṩ
  ['\ud55c', '\u1112\u1161\u11ab'], // 한 precomposed vs jamo
  ['\ufb01', 'fi'], // ﬁ ligature (NFKC)
  ['\u2126', '\u03a9'], // OHM SIGN vs OMEGA (singleton)
  ['\u212b', '\u00c5'], // ANGSTROM SIGN vs Å
  ['\uff11\uff12', '12'], // fullwidth digits (NFKC)
  ['\u00bd', '1\u20442'], // ½ (NFKC)
  ['\u0041\u030a', '\u00c5'], // A + ring vs Å
];

const CONTROL_CHARS = [
  '\u0000',
  '\u0001',
  '\u0007',
  '\u0008',
  '\u000b',
  '\u000c',
  '\u001b',
  '\u001f',
  '\u007f',
  '\u0085',
  '\u009f',
  '\u200b',
  '\u200c',
  '\u200d',
  '\u200e',
  '\u200f',
  '\u202a',
  '\u202e',
  '\u2028',
  '\u2029',
  '\u2066',
  '\u2069',
  '\ufeff',
  '\ufff9',
  '\ufffb',
  '\ufffe',
  '\uffff',
];

const EMOJI_SEQUENCES = [
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66', // family ZWJ
  '\ud83c\udff3\ufe0f\u200d\ud83c\udf08', // rainbow flag
  '\ud83d\udc4d\ud83c\udffd', // thumbs up medium skin tone
  '\ud83c\uddfa\ud83c\uddf8', // US flag
  '\u2764\ufe0f', // heart VS16
  '\ud83e\uddd1\u200d\ud83e\udd1d\u200d\ud83e\uddd1', // people holding hands
  '\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc73\udb40\udc63\udb40\udc74\udb40\udc7f', // Scotland tag sequence
  '\u0023\ufe0f\u20e3', // keycap #
];

const TRAVERSALS = [
  '../../../../etc/passwd',
  '..\\..\\..\\windows\\system32\\drivers\\etc\\hosts',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '..%252f..%252fetc%252fshadow',
  'file:///etc/passwd',
  '/var/mobile/Containers/Data/../../../etc/hosts',
  'C:\\..\\..\\boot.ini',
  'cue\u0000.wav',
  '....//....//etc/passwd',
  '\u2025/\u2025/etc/passwd',
  '~/../../root/.ssh/id_rsa',
  'con.txt',
  'AUX',
  '\\\\?\\C:\\Windows',
];

const INJECTIONS = [
  '<speak><break time="3600s"/>Paddle up</speak>',
  '<prosody rate="x-slow" pitch="-100%">Paddle up</prosody>',
  '<say-as interpret-as="characters">ABC</say-as>',
  '<script>alert(1)</script>',
  '${process.env.HOME}',
  '{{constructor.constructor("return process")()}}',
  '%s%s%s%n%n%x',
  '$(rm -rf /)',
  '`touch /tmp/pwned`',
  "' OR 1=1 --",
  '"; DROP TABLE shots; --',
  '\r\nSet-Cookie: x=y',
  '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><x>&xxe;</x>',
  '[[ $(id) ]]',
  '\\u0000\\x00%00',
];

const MIXED_SCRIPTS = [
  'Paddle up \u0639\u0631\u0628\u064a Paddle',
  '\u05e9\u05dc\u05d5\u05dd Paddle \u05e2\u05d5\u05dc\u05dd',
  '\u30d1\u30c9\u30eb\u3092\u4e0a\u3052\u3066 Paddle up',
  '\u092a\u0948\u0921\u0932 \u0909\u092a\u0930',
  '\u0e1e\u0e32\u0e22\u0e02\u0e36\u0e49\u0e19',
  '\u202eevoba elddaP\u202c',
  '\u2067Paddle\u2069 \u0645\u0636\u0631\u0628',
  'Pa\u200bdd\u200ble u\u200bp',
  '\u0928\u092e\u0938\u094d\u0924\u0947 \ud83c\udfd3',
];

const HOMOGLYPHS = [
  'P\u0430ddle up', // Cyrillic а
  '\u0420addle up', // Cyrillic Р
  'Paddl\u0435 up', // Cyrillic е
  'Paddle \u03c5p', // Greek upsilon
  '\uff30\uff41\uff44\uff44\uff4c\uff45 \uff55\uff50', // fullwidth
  'Pa\u0501dle up', // Cyrillic komi de
  '\u1d18\u1d00\u1d05\u1d05\u029f\u1d07 \u1d1c\u1d18', // small caps
];

const FUTURE_SCHEMAS: readonly (() => unknown)[] = [
  () => ({ schemaVersion: 2, text: 'Paddle up', voice: { id: 'x' } }),
  () => ({ schemaVersion: 99, cue: { text: 'Paddle up', ssml: true } }),
  () => ({ v: '3.0.0', cues: ['Paddle up', 'Reset'] }),
  () => ({ version: Number.MAX_SAFE_INTEGER, text: 'Paddle up' }),
  () => ({ version: -1, text: null }),
  () => ({ type: 'cue', payload: { type: 'cue', payload: { text: 'x' } } }),
];

function makeCircular(): unknown {
  const node: { self?: unknown; text: string } = { text: 'Paddle up' };
  node.self = node;
  return node;
}

function makeDeep(depth: number): unknown {
  let node: unknown = 'Paddle up';
  for (let i = 0; i < depth; i += 1) node = { n: node };
  return node;
}

export function generatePayload(
  rng: Rng,
  category: PayloadCategory,
): GeneratedPayload {
  switch (category) {
    case 'plain-cue':
      return str(category, rng.pick(CUES));

    case 'empty-or-whitespace': {
      const options = [
        '',
        ' ',
        '  ',
        '\n',
        '\t',
        '\r\n',
        '\u00a0',
        '\u2003',
        '\u3000',
        '\u200b',
        '\ufeff',
        ' \n\t\r\u000b\u000c ',
        ' '.repeat(rng.int(1, 4096)),
      ];
      return str(category, rng.pick(options));
    }

    case 'null-bytes': {
      const base = rng.pick(CUES);
      const pos = rng.int(0, base.length);
      const count = rng.int(1, 8);
      const injected =
        base.slice(0, pos) + '\u0000'.repeat(count) + base.slice(pos);
      return str(category, rng.bool(0.2) ? '\u0000' : injected);
    }

    case 'control-chars': {
      const base = rng.pick(CUES).split('');
      const n = rng.int(1, 6);
      for (let i = 0; i < n; i += 1) {
        const at = rng.int(0, base.length);
        base.splice(at, 0, rng.pick(CONTROL_CHARS));
      }
      return str(category, base.join(''));
    }

    case 'oversize-ascii': {
      const size = rng.pick(SIZE_TIERS);
      const unit = `${rng.pick(ASCII_WORDS)} `;
      return str(
        category,
        repeatTo(unit, size),
        `str(len=${size}) ascii "${unit.trim()}…"`,
      );
    }

    case 'oversize-multibyte': {
      const size = rng.pick(SIZE_TIERS);
      const unit = rng.pick(['\u00e9', '\u6f22', '\ud83c\udfd3', '\u0639']);
      const text = repeatTo(unit, size);
      return str(
        category,
        text,
        `str(len=${text.length}) multibyte unit=${jsonSafe(unit)}`,
      );
    }

    case 'oversize-combining': {
      // One base char + many combining marks: 1 grapheme, N code points.
      const marks = rng.int(1000, 70_000);
      const text = `e${'\u0301'.repeat(marks)}`;
      return str(
        category,
        text,
        `str(len=${text.length}) 1 grapheme, ${marks} combining marks`,
      );
    }

    case 'unicode-normalization': {
      const pair = rng.pick(NORMALIZATION_PAIRS);
      const side = rng.int(0, 1);
      const chosen = side === 0 ? pair[0] : pair[1];
      const text = rng.bool(0.5) ? `Paddle ${chosen}` : chosen;
      return str(
        category,
        text,
        `${describeString(text)} pair#${NORMALIZATION_PAIRS.indexOf(pair)}/${side}`,
      );
    }

    case 'lone-surrogates': {
      const options = [
        '\ud800',
        '\udbff',
        '\udc00',
        '\udfff',
        'Paddle \ud83c up',
        'Paddle \udfd3 up',
        '\udfd3\ud83c', // reversed pair
        'Paddle\ud800\ud800\ud800',
        '\ud83c\udfd3'.slice(0, 1),
        `${rng.pick(CUES)}\udc00`,
      ];
      return str(category, rng.pick(options));
    }

    case 'emoji-zwj': {
      const seq = rng.pick(EMOJI_SEQUENCES);
      const reps = rng.int(1, 64);
      return str(category, seq.repeat(reps));
    }

    case 'malformed-json-text': {
      const full = JSON.stringify({
        cue: rng.pick(CUES),
        rate: 0.5,
        tags: ['a', 'b'],
        nested: { deep: { deeper: true } },
      });
      const options = [
        full.slice(0, rng.int(1, full.length - 1)),
        '{"cue": "Paddle up",}',
        "{'cue': 'Paddle up'}",
        '{"cue": "Paddle up"',
        '[1, 2, 3,',
        '{"__proto__": {"polluted": true}}',
        '{"constructor": {"prototype": {"polluted": true}}}',
        '\ufeff{"cue":"Paddle up"}',
        '{"a":1e99999}',
        '{"a":-}',
        'NaN',
        'undefined',
        '{"cue":"\\ud800"}',
        '{"cue":"Paddle up"}\u0000',
        '{"a":"' + '\\'.repeat(rng.int(1, 9)) + '"}',
      ];
      return str(category, rng.pick(options));
    }

    case 'path-traversal':
      return str(category, rng.pick(TRAVERSALS));

    case 'injection-markup':
      return str(category, rng.pick(INJECTIONS));

    case 'numeric-boundary': {
      const options: readonly number[] = [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        -0,
        0,
        1,
        -1,
        0.5,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER + 1,
        Number.MIN_SAFE_INTEGER - 1,
        2 ** 53,
        2 ** 63,
        2 ** 64,
        Number.MAX_VALUE,
        Number.MIN_VALUE,
        Number.EPSILON,
        5e-324,
        1e308,
        -1e308,
        0.1 + 0.2,
        4294967295,
        4294967296,
        -2147483649,
        2147483648,
        rng.next() * 1e12,
      ];
      const value = rng.pick(options);
      return nonString(
        category,
        value,
        `number(${Object.is(value, -0) ? '-0' : String(value)})`,
        true,
      );
    }

    case 'numeric-string': {
      const options = [
        'NaN',
        'Infinity',
        '-Infinity',
        '-0',
        '1e999',
        '0x1F',
        '0b101',
        '0o17',
        '1_000',
        '١٢٣',
        '9007199254740993',
        '.5',
        '5.',
        '+5',
        '1e-400',
      ];
      return str(category, rng.pick(options));
    }

    case 'bigint': {
      const options: readonly bigint[] = [
        BigInt(0),
        BigInt(1),
        BigInt(-1),
        BigInt('18446744073709551616'),
        BigInt('-170141183460469231731687303715884105728'),
        BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1),
      ];
      const value = rng.pick(options);
      return nonString(category, value, `bigint(${value.toString()}n)`);
    }

    case 'nullish': {
      const value = rng.bool() ? null : undefined;
      return nonString(category, value, String(value), true);
    }

    case 'boolean': {
      const value = rng.bool();
      return nonString(category, value, `boolean(${value})`, true);
    }

    case 'symbol': {
      const options = [
        Symbol('cue'),
        Symbol.iterator,
        Symbol.for('Paddle up'),
        Symbol(''),
      ];
      const value = rng.pick(options);
      return nonString(category, value, `symbol(${value.description ?? ''})`);
    }

    case 'function': {
      const options: readonly (() => unknown)[] = [
        () => 'Paddle up',
        function named() {
          return 1;
        },
        () => {
          throw new Error('called');
        },
        Object.assign(() => 'x', { toString: () => 'Paddle up' }),
      ];
      const value = rng.pick(options);
      return nonString(category, value, `function(${value.name || 'anon'})`);
    }

    case 'object-shape': {
      const options: readonly (readonly [() => unknown, string, boolean])[] = [
        [() => ({}), '{}', true],
        [() => [], '[]', true],
        [() => [[]], '[[]]', true],
        [() => ({ text: 'Paddle up' }), '{text}', true],
        [() => ['Paddle up'], '["Paddle up"]', true],
        [() => new String('Paddle up'), 'String object', false],
        [() => new Number(0.5), 'Number object', false],
        [() => new Boolean(false), 'Boolean object', false],
        [() => new Date(0), 'Date(0)', false],
        [() => new Date(Number.NaN), 'Date(Invalid)', false],
        [() => /paddle/gi, 'RegExp', false],
        [() => new Map([['text', 'Paddle up']]), 'Map', false],
        [() => new Set(['Paddle up']), 'Set', false],
        [() => new ArrayBuffer(8), 'ArrayBuffer(8)', false],
        [() => new Uint8Array([80, 97, 100]), 'Uint8Array', false],
        [() => new Uint8Array(0), 'Uint8Array(0)', false],
        [() => Promise.resolve('Paddle up'), 'Promise', false],
        [() => new Error('Paddle up'), 'Error', false],
        [() => Object.create(null), 'Object.create(null)', false],
        [() => Object.freeze({ text: 'Paddle up' }), 'frozen {text}', true],
        [() => makeCircular(), 'circular object', false],
        [() => makeDeep(2000), 'object depth=2000', false],
        [() => new Array(1000).fill('Paddle up'), 'array(1000)', true],
        [() => new Array(5), 'sparse array(5)', false],
        [() => new (class Cue {})(), 'class instance', false],
        [() => new WeakMap(), 'WeakMap', false],
        [() => new Proxy({}, {}), 'transparent Proxy', false],
      ];
      const [make, describe, snapshotable] = rng.pick(options);
      return nonString(category, make(), `object(${describe})`, snapshotable);
    }

    case 'hostile-object': {
      const options: readonly (readonly [() => unknown, string])[] = [
        [
          () => ({
            toString() {
              throw new Error('hostile toString');
            },
          }),
          'toString throws',
        ],
        [
          () => ({
            valueOf() {
              throw new Error('hostile valueOf');
            },
            toString() {
              throw new Error('hostile toString');
            },
          }),
          'valueOf+toString throw',
        ],
        [
          () => ({
            [Symbol.toPrimitive]() {
              throw new Error('hostile toPrimitive');
            },
          }),
          'Symbol.toPrimitive throws',
        ],
        [
          () =>
            new Proxy(
              {},
              {
                get() {
                  throw new Error('hostile proxy get');
                },
                has() {
                  throw new Error('hostile proxy has');
                },
                ownKeys() {
                  throw new Error('hostile proxy ownKeys');
                },
                getOwnPropertyDescriptor() {
                  throw new Error('hostile proxy gopd');
                },
              },
            ),
          'Proxy throwing on every trap',
        ],
        [
          () => {
            const o: Record<string, unknown> = {};
            Object.defineProperty(o, 'text', {
              enumerable: true,
              get() {
                throw new Error('hostile getter');
              },
            });
            return o;
          },
          'enumerable throwing getter',
        ],
        [
          () => ({
            toString: () => 'Paddle up',
            length: Number.MAX_SAFE_INTEGER,
          }),
          'array-like with huge length',
        ],
        [
          () => ({
            toJSON() {
              throw new Error('hostile toJSON');
            },
          }),
          'toJSON throws',
        ],
        [
          () => ({
            toJSON: () => ({ text: 'Paddle up', nested: makeDeep(500) }),
          }),
          'toJSON deep',
        ],
        [
          () => {
            let calls = 0;
            return {
              toString() {
                calls += 1;
                return calls === 1 ? 'Paddle up' : 'DIFFERENT';
              },
            };
          },
          'non-idempotent toString',
        ],
      ];
      const [make, describe] = rng.pick(options);
      return nonString(category, make(), `hostile(${describe})`);
    }

    case 'prototype-pollution': {
      const options: readonly (readonly [() => unknown, string, boolean])[] = [
        [
          () => JSON.parse('{"__proto__":{"polluted":"tts"}}') as unknown,
          'JSON.parse __proto__',
          true,
        ],
        [
          () =>
            JSON.parse(
              '{"constructor":{"prototype":{"polluted":"tts"}}}',
            ) as unknown,
          'JSON.parse constructor.prototype',
          true,
        ],
        [
          () => ({ ['__proto__']: { polluted: 'tts' } }),
          'literal __proto__',
          false,
        ],
        [
          () => {
            const o: Record<string, unknown> = {};
            Object.defineProperty(o, '__proto__', {
              value: { polluted: 'tts' },
              enumerable: true,
              configurable: true,
              writable: true,
            });
            return o;
          },
          'own __proto__ data property',
          false,
        ],
        [() => '__proto__', 'string "__proto__"', true],
        [() => 'constructor', 'string "constructor"', true],
        [() => 'prototype', 'string "prototype"', true],
        [() => 'hasOwnProperty', 'string "hasOwnProperty"', true],
        [() => 'toString', 'string "toString"', true],
        [() => 'valueOf', 'string "valueOf"', true],
        [() => '__defineGetter__', 'string "__defineGetter__"', true],
        [
          () => ({ text: 'Paddle up', __proto__: null }),
          'null-prototype literal',
          false,
        ],
      ];
      const [make, describe, snapshotable] = rng.pick(options);
      return nonString(
        category,
        make(),
        `proto-pollution(${describe})`,
        snapshotable,
      );
    }

    case 'future-schema': {
      const make = rng.pick(FUTURE_SCHEMAS);
      const asText = rng.bool(0.5);
      const value = make();
      if (asText) return str(category, JSON.stringify(value));
      return nonString(
        category,
        value,
        `future-schema(${JSON.stringify(value).slice(0, 48)})`,
        true,
      );
    }

    case 'empty-collection': {
      const options: readonly (readonly [() => unknown, string, boolean])[] = [
        [() => [], '[]', true],
        [() => ({}), '{}', true],
        [() => [[], [], []], '[[],[],[]]', true],
        [() => ({ a: {}, b: [] }), '{a:{},b:[]}', true],
        [() => new Map(), 'Map()', false],
        [() => new Set(), 'Set()', false],
        [() => new Uint8Array(0), 'Uint8Array(0)', false],
        [() => new ArrayBuffer(0), 'ArrayBuffer(0)', false],
        [() => Object.create(null), 'Object.create(null)', false],
        [() => [undefined], '[undefined]', false],
        [() => [null], '[null]', true],
        [() => [''], '[""]', true],
      ];
      const [make, describe, snapshotable] = rng.pick(options);
      return nonString(category, make(), `empty(${describe})`, snapshotable);
    }

    case 'repeated-cue-burst': {
      const cue = rng.pick(CUES);
      const reps = rng.int(500, 20_000);
      const joiner = rng.pick([' ', '. ', '\n', '']);
      const text = new Array(reps).fill(cue).join(joiner);
      return str(
        category,
        text,
        `str(len=${text.length}) "${cue}" x${reps} joiner=${jsonSafe(joiner)}`,
      );
    }

    case 'mixed-script-rtl':
      return str(category, rng.pick(MIXED_SCRIPTS));

    case 'homoglyph':
      return str(category, rng.pick(HOMOGLYPHS));

    default: {
      const exhaustive: never = category;
      throw new Error(`unknown payload category ${String(exhaustive)}`);
    }
  }
}

export interface TextMetrics {
  utf16Length: number;
  utf8Bytes: number;
  codePoints: number;
  graphemes: number | null;
  hasLoneSurrogate: boolean;
  isNfc: boolean;
}

interface GraphemeSegmenter {
  segment(text: string): Iterable<unknown>;
}

// Intl.Segmenter exists at runtime on Node >= 16 but is absent from the
// RN TypeScript lib target; resolve it structurally.
const segmenter: GraphemeSegmenter | null = (() => {
  const intl = Intl as unknown as {
    Segmenter?: new (
      locale: string,
      options: { granularity: 'grapheme' },
    ) => GraphemeSegmenter;
  };
  return typeof intl.Segmenter === 'function'
    ? new intl.Segmenter('en', { granularity: 'grapheme' })
    : null;
})();

export function textMetrics(text: string): TextMetrics {
  let codePoints = 0;
  let hasLoneSurrogate = false;
  for (const ch of text) {
    codePoints += 1;
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0xd800 && code <= 0xdfff) hasLoneSurrogate = true;
  }
  let graphemes: number | null = null;
  // Grapheme segmentation of a megabyte string is slow; cap the work.
  if (segmenter && text.length <= 128 * 1024) {
    graphemes = 0;
    for (const _ of segmenter.segment(text)) graphemes += 1;
  }
  return {
    utf16Length: text.length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    codePoints,
    graphemes,
    hasLoneSurrogate,
    isNfc: text.normalize('NFC') === text,
  };
}
