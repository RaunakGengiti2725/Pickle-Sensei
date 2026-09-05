/**
 * Seeded generator of boundary / malformed inputs for the stress suites under
 * `__tests__/stress/`. Every payload is reproducible from `(seed, index)`
 * alone; the description string is what goes into the JSON result table so
 * a 64 KiB string is recorded by length + hash, never inline.
 *
 * Categories (lens `boundary-malformed`):
 *   json        malformed / truncated JSON text and parsed-but-hostile JSON
 *   type        wrong primitive / wrapper / exotic types
 *   proto       prototype-pollution shaped objects and keys
 *   numeric     NaN / ±Infinity / -0 / overflow / BigInt / precision edges
 *   bytes       null bytes, control characters, invalid surrogates, BOMs
 *   huge        64 KiB+ strings measured in bytes vs code points vs graphemes
 *   path        traversal / injection shaped ids and slugs
 *   schema      future / negative / non-numeric schema versions
 *   empty       empty arrays, objects, strings, holes, frozen shells
 *   unicode     NFC/NFD pairs, confusables, case / whitespace variants of the
 *               real stage literals, zero-width joiners
 *   hostile     proxies, throwing getters/toString, revoked proxies,
 *               self-referential structures, symbols, functions, promises
 */

export type PayloadCategory =
  | 'json'
  | 'type'
  | 'proto'
  | 'numeric'
  | 'bytes'
  | 'huge'
  | 'path'
  | 'schema'
  | 'empty'
  | 'unicode'
  | 'hostile';

export const PAYLOAD_CATEGORIES: readonly PayloadCategory[] = [
  'json',
  'type',
  'proto',
  'numeric',
  'bytes',
  'huge',
  'path',
  'schema',
  'empty',
  'unicode',
  'hostile',
];

export interface Payload {
  category: PayloadCategory;
  /** Short, JSON-safe description for the result table. */
  describe: string;
  value: unknown;
  /** True when `JSON.stringify(value)` is safe and meaningful (mutation check). */
  jsonSafe: boolean;
}

/** mulberry32 — the same tiny PRNG the other mobile stress suites use. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick(): empty list');
  return item;
}

export function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

/** FNV-1a over UTF-16 code units — stable fingerprint for huge strings. */
export function fingerprint(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export const STAGE_LITERALS = ['welcome', 'onboarding', 'signin'] as const;

const CONFUSABLES: Record<string, string[]> = {
  a: ['\u0430', '\u00e0', 'a\u0301'],
  e: ['\u0435', '\u00e9', 'e\u0301'],
  i: ['\u0456', '\u0131', 'l', '1', '\u00ed'],
  o: ['\u043e', '0', '\u00f6', 'o\u0308'],
  n: ['\u0578', 'n\u0303'],
  s: ['\u0455', '\u017f', '5'],
  g: ['\u0261', '9'],
  w: ['\u051d', 'vv'],
};

function confusable(rng: () => number, literal: string): string {
  const index = intBetween(rng, 0, literal.length - 1);
  const ch = literal[index] ?? '';
  const swaps = CONFUSABLES[ch];
  if (!swaps)
    return (
      literal.slice(0, index) + ch.toUpperCase() + literal.slice(index + 1)
    );
  return literal.slice(0, index) + pick(rng, swaps) + literal.slice(index + 1);
}

const ZERO_WIDTH = ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff'];
const WHITESPACE = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\u00a0',
  '\u2003',
  '\u3000',
  '\u0085',
];
const CONTROL = [
  '\u0000',
  '\u0001',
  '\u0007',
  '\u0008',
  '\u001b',
  '\u007f',
  '\u009f',
];
const TRAVERSAL = [
  '../',
  '..\\',
  '%2e%2e/',
  '..%2f',
  '....//',
  '/etc/passwd',
  'C:\\Windows\\system32',
  'file:///',
  '\u0000/../',
];

function hugeString(rng: () => number): Payload {
  const mode = pick(rng, ['ascii', 'bmp2', 'astral', 'grapheme', 'literalRun']);
  const targetBytes = pick(rng, [65536, 65537, 131072, 1048576]);
  let text: string;
  let unit: string;
  switch (mode) {
    case 'ascii':
      text = 'a'.repeat(targetBytes);
      unit = '1 byte/cp';
      break;
    case 'bmp2':
      text = '\u00e9'.repeat(targetBytes / 2);
      unit = '2 bytes/cp';
      break;
    case 'astral':
      text = '\u{1F3D3}'.repeat(targetBytes / 4);
      unit = '4 bytes/cp, 2 code units';
      break;
    case 'grapheme':
      text = '\u{1F468}\u200d\u{1F469}\u200d\u{1F467}'.repeat(
        Math.ceil(targetBytes / 18),
      );
      unit = 'zwj grapheme cluster';
      break;
    default:
      text = pick(rng, STAGE_LITERALS).repeat(Math.ceil(targetBytes / 6));
      unit = 'stage literal run';
  }
  return {
    category: 'huge',
    describe: `huge:${mode}:${unit}:len=${text.length}:fnv=${fingerprint(text)}`,
    value: text,
    jsonSafe: false,
  };
}

function makeProxy(rng: () => number): Payload {
  const flavour = pick(rng, [
    'throwGet',
    'throwHas',
    'revoked',
    'lying',
    'stageMask',
  ]);
  if (flavour === 'revoked') {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    return {
      category: 'hostile',
      describe: 'proxy:revoked',
      value: proxy,
      jsonSafe: false,
    };
  }
  const handler: ProxyHandler<Record<string, unknown>> = {};
  if (flavour === 'throwGet') {
    handler.get = () => {
      throw new Error('hostile getter');
    };
  } else if (flavour === 'throwHas') {
    handler.has = () => {
      throw new Error('hostile has');
    };
    handler.ownKeys = () => {
      throw new Error('hostile ownKeys');
    };
  } else if (flavour === 'lying') {
    handler.get = (_t, key) =>
      key === Symbol.toPrimitive ? () => 'signin' : 'signin';
  } else {
    handler.get = (_t, key) =>
      key === 'toString' ? () => 'signin' : undefined;
  }
  return {
    category: 'hostile',
    describe: `proxy:${flavour}`,
    value: new Proxy<Record<string, unknown>>({}, handler),
    jsonSafe: false,
  };
}

/** Deterministic hostile payload for `(rng, category)`. */
export function generatePayload(
  rng: () => number,
  category: PayloadCategory = pick(rng, PAYLOAD_CATEGORIES),
): Payload {
  switch (category) {
    case 'json': {
      const variants: Array<[string, unknown, boolean]> = [
        ['truncated-object', '{"stage":"sig', true],
        ['truncated-array', '["welcome",', true],
        ['trailing-comma', '{"stage":"signin",}', true],
        ['single-quotes', "{'stage':'signin'}", true],
        ['nan-literal', '{"v":NaN}', true],
        ['bare-word', 'signin', true],
        ['deep-nesting', '['.repeat(5000), true],
        ['bom-prefixed', '\ufeff{"stage":"signin"}', true],
        [
          'parsed-hostile',
          JSON.parse('{"__proto__":{"stage":"signin"}}'),
          true,
        ],
        ['parsed-array-of-stages', JSON.parse('["signin","onboarding"]'), true],
        [
          'parsed-nested-stage',
          JSON.parse('{"stage":{"stage":"signin"}}'),
          true,
        ],
        ['dup-keys', JSON.parse('{"stage":"welcome","stage":"signin"}'), true],
      ];
      const [name, value, jsonSafe] = pick(rng, variants);
      return { category, describe: `json:${name}`, value, jsonSafe };
    }
    case 'type': {
      const variants: Array<[string, unknown, boolean]> = [
        ['undefined', undefined, false],
        ['null', null, true],
        ['true', true, true],
        ['false', false, true],
        ['String-object', new String('signin'), false],
        ['Number-object', new Number(1), false],
        ['Boolean-object', new Boolean(false), false],
        ['Date', new Date(0), false],
        ['Date-invalid', new Date(NaN), false],
        ['RegExp', /signin/g, false],
        ['Map', new Map([['stage', 'signin']]), false],
        ['Set', new Set(['signin']), false],
        ['ArrayBuffer', new ArrayBuffer(8), false],
        ['Uint8Array', new Uint8Array([115, 105, 103, 110, 105, 110]), false],
        ['Error', new Error('signin'), false],
        [
          'class-instance',
          new (class Stage {
            stage = 'signin';
          })(),
          false,
        ],
      ];
      const [name, value, jsonSafe] = pick(rng, variants);
      return { category, describe: `type:${name}`, value, jsonSafe };
    }
    case 'proto': {
      const key = pick(rng, [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
      ]);
      const flavour = pick(rng, [
        'object',
        'nested',
        'nullProto',
        'keyString',
        'ctorProto',
      ]);
      if (flavour === 'keyString') {
        return {
          category,
          describe: `proto:key:${key}`,
          value: key,
          jsonSafe: true,
        };
      }
      if (flavour === 'nullProto') {
        const value = Object.create(null) as Record<string, unknown>;
        value['stage'] = 'signin';
        return {
          category,
          describe: 'proto:null-prototype-object',
          value,
          jsonSafe: true,
        };
      }
      if (flavour === 'ctorProto') {
        const value = JSON.parse(
          '{"constructor":{"prototype":{"stage":"signin"}}}',
        );
        return {
          category,
          describe: 'proto:constructor.prototype',
          value,
          jsonSafe: true,
        };
      }
      const inner = { stage: 'signin', skipOnboarding: true, onboarded: true };
      const value = JSON.parse(
        flavour === 'nested'
          ? `{"a":{"b":{${JSON.stringify(key)}:${JSON.stringify(inner)}}}}`
          : `{${JSON.stringify(key)}:${JSON.stringify(inner)}}`,
      );
      return {
        category,
        describe: `proto:${flavour}:${key}`,
        value,
        jsonSafe: true,
      };
    }
    case 'numeric': {
      const variants: Array<[string, unknown, boolean]> = [
        ['NaN', NaN, false],
        ['+Infinity', Infinity, false],
        ['-Infinity', -Infinity, false],
        ['-0', -0, false],
        ['MAX_SAFE+1', Number.MAX_SAFE_INTEGER + 1, true],
        ['MIN_SAFE-1', Number.MIN_SAFE_INTEGER - 1, true],
        ['MAX_VALUE', Number.MAX_VALUE, true],
        ['EPSILON', Number.EPSILON, true],
        ['2^31', 2 ** 31, true],
        ['2^53', 2 ** 53, true],
        ['1e309-string', '1e309', true],
        ['0x-string', '0xdeadbeef', true],
        ['BigInt', BigInt('9'.repeat(40)), false],
        ['negative-zero-string', '-0', true],
        ['0.1+0.2', 0.1 + 0.2, true],
      ];
      const [name, value, jsonSafe] = pick(rng, variants);
      return { category, describe: `numeric:${name}`, value, jsonSafe };
    }
    case 'bytes': {
      const base = pick(rng, STAGE_LITERALS);
      const flavour = pick(rng, [
        'nul-mid',
        'nul-lead',
        'nul-trail',
        'control',
        'lone-high',
        'lone-low',
        'bom',
        'rtl-override',
      ]);
      let value: string;
      switch (flavour) {
        case 'nul-mid':
          value = base.slice(0, 3) + '\u0000' + base.slice(3);
          break;
        case 'nul-lead':
          value = '\u0000' + base;
          break;
        case 'nul-trail':
          value = base + '\u0000';
          break;
        case 'control':
          value = base + pick(rng, CONTROL);
          break;
        case 'lone-high':
          value = base + '\ud83c';
          break;
        case 'lone-low':
          value = '\udfd3' + base;
          break;
        case 'bom':
          value = '\ufeff' + base;
          break;
        default:
          value = '\u202e' + base;
      }
      return {
        category,
        describe: `bytes:${flavour}:${base}`,
        value,
        jsonSafe: true,
      };
    }
    case 'huge':
      return hugeString(rng);
    case 'path': {
      const base = pick(rng, STAGE_LITERALS);
      const flavour = pick(rng, [
        'prefix',
        'suffix',
        'both',
        'sql',
        'template',
        'url',
      ]);
      const traversal = pick(rng, TRAVERSAL);
      let value: string;
      switch (flavour) {
        case 'prefix':
          value = traversal + base;
          break;
        case 'suffix':
          value = base + '/' + traversal;
          break;
        case 'both':
          value = traversal + base + traversal;
          break;
        case 'sql':
          value = `${base}'; DROP TABLE kv; --`;
          break;
        case 'template':
          value = `\${${base}}{{${base}}}`;
          break;
        default:
          value = `picklesensei://${base}?stage=signin#skip`;
      }
      return { category, describe: `path:${flavour}`, value, jsonSafe: true };
    }
    case 'schema': {
      const version = pick(rng, [
        2,
        999,
        2 ** 31,
        -1,
        0,
        1.5,
        '1',
        'latest',
        null,
        NaN,
      ]);
      const stagePick = pick(rng, [
        ...STAGE_LITERALS,
        'skip',
        'main',
        '<absent>',
      ]);
      const stage = stagePick === '<absent>' ? undefined : stagePick;
      const value: Record<string, unknown> = { version, stage };
      if (rng() < 0.5) value['skipOnboarding'] = true;
      if (rng() < 0.3) value['profile'] = { firstName: 'x'.repeat(4096) };
      return {
        category,
        describe: `schema:v=${String(version)}:stage=${String(stage)}`,
        value,
        jsonSafe: typeof version === 'number' ? Number.isFinite(version) : true,
      };
    }
    case 'empty': {
      const variants: Array<[string, unknown, boolean]> = [
        ['empty-string', '', true],
        ['empty-array', [], true],
        ['empty-object', {}, true],
        ['sparse-array', Array(1000), true],
        ['frozen-empty', Object.freeze({}), true],
        ['sealed-stage', Object.seal({ stage: undefined }), true],
        ['empty-Map', new Map(), false],
        [
          'whitespace-only',
          pick(rng, WHITESPACE).repeat(intBetween(rng, 1, 64)),
          true,
        ],
        [
          'zero-width-only',
          pick(rng, ZERO_WIDTH).repeat(intBetween(rng, 1, 16)),
          true,
        ],
      ];
      const [name, value, jsonSafe] = pick(rng, variants);
      return { category, describe: `empty:${name}`, value, jsonSafe };
    }
    case 'unicode': {
      const base = pick(rng, STAGE_LITERALS);
      const flavour = pick(rng, [
        'nfd',
        'nfkc-fullwidth',
        'confusable',
        'upper',
        'title',
        'padded',
        'zw-inject',
        'turkish-i',
      ]);
      let value: string;
      switch (flavour) {
        case 'nfd':
          value = (base + '\u00e9').normalize('NFD');
          break;
        case 'nfkc-fullwidth':
          value = Array.from(base, ch =>
            String.fromCharCode(ch.charCodeAt(0) + 0xfee0),
          ).join('');
          break;
        case 'confusable':
          value = confusable(rng, base);
          break;
        case 'upper':
          value = base.toUpperCase();
          break;
        case 'title':
          value = base[0]!.toUpperCase() + base.slice(1);
          break;
        case 'padded':
          value = pick(rng, WHITESPACE) + base + pick(rng, WHITESPACE);
          break;
        case 'zw-inject': {
          const at = intBetween(rng, 0, base.length);
          value = base.slice(0, at) + pick(rng, ZERO_WIDTH) + base.slice(at);
          break;
        }
        default:
          value = base.replace('i', '\u0130').toLocaleLowerCase('tr');
      }
      return {
        category,
        describe: `unicode:${flavour}:${base}`,
        value,
        jsonSafe: true,
      };
    }
    case 'hostile': {
      const flavour = pick(rng, [
        'proxy',
        'throwingToString',
        'throwingValueOf',
        'throwingGetter',
        'cyclic',
        'symbol',
        'function',
        'promise',
        'generator',
        'weakref',
        'bigArray',
      ]);
      switch (flavour) {
        case 'proxy':
          return makeProxy(rng);
        case 'throwingToString':
          return {
            category,
            describe: 'hostile:throwingToString',
            value: {
              toString() {
                throw new Error('hostile toString');
              },
            },
            jsonSafe: false,
          };
        case 'throwingValueOf':
          return {
            category,
            describe: 'hostile:throwingValueOf',
            value: {
              valueOf() {
                throw new Error('hostile valueOf');
              },
              [Symbol.toPrimitive]() {
                throw new Error('hostile toPrimitive');
              },
            },
            jsonSafe: false,
          };
        case 'throwingGetter': {
          const value = {};
          Object.defineProperty(value, 'stage', {
            enumerable: true,
            get() {
              throw new Error('hostile stage getter');
            },
          });
          return {
            category,
            describe: 'hostile:throwingGetter',
            value,
            jsonSafe: false,
          };
        }
        case 'cyclic': {
          const value: Record<string, unknown> = { stage: 'signin' };
          value['self'] = value;
          return {
            category,
            describe: 'hostile:cyclic',
            value,
            jsonSafe: false,
          };
        }
        case 'symbol':
          return {
            category,
            describe: 'hostile:symbol',
            value: Symbol('signin'),
            jsonSafe: false,
          };
        case 'function':
          return {
            category,
            describe: 'hostile:function',
            value: () => 'signin',
            jsonSafe: false,
          };
        case 'promise':
          return {
            category,
            describe: 'hostile:promise',
            value: Promise.resolve('signin'),
            jsonSafe: false,
          };
        case 'generator':
          return {
            category,
            describe: 'hostile:generator',
            value: (function* stages() {
              yield 'signin';
            })(),
            jsonSafe: false,
          };
        case 'weakref':
          return {
            category,
            describe: 'hostile:weakref',
            value: new WeakRef({ stage: 'signin' }),
            jsonSafe: false,
          };
        default:
          return {
            category,
            describe: 'hostile:bigArray',
            value: new Array(intBetween(rng, 10000, 100000)).fill('signin'),
            jsonSafe: false,
          };
      }
    }
  }
}

/** A `this` binding as hostile as the arguments. */
export function generateThisArg(rng: () => number): Payload {
  const flavour = pick(rng, ['undefined', 'null', 'globalThis', 'payload']);
  if (flavour === 'undefined') {
    return {
      category: 'type',
      describe: 'this:undefined',
      value: undefined,
      jsonSafe: false,
    };
  }
  if (flavour === 'null') {
    return {
      category: 'type',
      describe: 'this:null',
      value: null,
      jsonSafe: false,
    };
  }
  if (flavour === 'globalThis') {
    return {
      category: 'hostile',
      describe: 'this:globalThis',
      value: globalThis,
      jsonSafe: false,
    };
  }
  const payload = generatePayload(rng);
  return { ...payload, describe: `this:${payload.describe}` };
}
