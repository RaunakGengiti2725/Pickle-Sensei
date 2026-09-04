/**
 * BOUNDARY / MALFORMED-INPUT stress harness for the `mod-training` unit
 * (`src/training/api.ts`, `src/training/store.ts`, `src/training/types.ts`).
 *
 * Everything here is deterministic: a `Rng` is seeded per iteration and the
 * table row for that iteration records the seed, the mutation ops applied and
 * the outcome, so any failing row can be replayed with
 *   STRESS_ONLY=<campaign>:<seed> npx jest __tests__/stress/modTrainingBoundary
 *
 * The generators cover the lens checklist: malformed / truncated JSON, wrong
 * types, prototype-pollution keys, numeric overflow / NaN / Infinity / -0,
 * null bytes, 64 KB+ strings (byte / code point / grapheme inflations),
 * path traversal in ids and slugs, future schema versions, empty arrays and
 * objects, and unicode normalization pairs.
 *
 * Validators are written independently from the parsers, from the contract in
 * `types.ts`, so an "accepted" outcome is checked against the declared shape
 * and not against the parser's own opinion of itself.
 */
import type {
  CatalogDrill,
  TrainingFetch,
  TrainingApiConfig,
} from '../../src/training/api';
import {
  TrainingError,
  type DrillCompletion,
  type DrillDetail,
  type DrillMapping,
  type InstructionalMedia,
  type SavedDrill,
  type TrainingErrorState,
  type TrainingPlan,
  type TrainingPlanItem,
} from '../../src/training/types';

// Node built-ins for the raw artifacts. The mobile tsconfig excludes node
// typings, so the shims stay local (same pattern as __tests__/matrix).
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a |= 0;
    this.a = (this.a + 0x6d2b79f5) | 0;
    let t = Math.imul(this.a ^ (this.a >>> 15), 1 | this.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty pool');
    return items[Math.floor(this.next() * items.length)] as T;
  }
}

/** Stable 32-bit seed for (campaign, index) so rows are replayable. */
export function seedFor(campaign: string, index: number): number {
  let h = 2166136261 >>> 0;
  const text = `${campaign}#${index}`;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

// ─── Hostile value pools ─────────────────────────────────────────────────────

export const KB64 = 64 * 1024;

export const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

/** Object.prototype member names the server slug regex would accept. */
export const INHERITED_SLUGS = [
  'constructor',
  'toString',
  'toLocaleString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
] as const;

export const HOSTILE_STRINGS: readonly string[] = [
  '',
  ' ',
  '\t\n\r',
  '\u0000',
  'a\u0000b',
  '\u0000'.repeat(64),
  'x'.repeat(KB64),
  'x'.repeat(KB64 + 1),
  '\u00e9'.repeat(KB64 / 2 + 1), // > 64 KB in UTF-8, < 64 KB code points
  '\ud83d\ude00'.repeat(KB64 / 4 + 1), // > 64 KB bytes via astral pairs
  '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67'.repeat(6000), // graphemes
  '\ufffd',
  '\ud800', // lone high surrogate
  '\udc00', // lone low surrogate
  'caf\u00e9', // NFC
  'cafe\u0301', // NFD
  '\u212b', // ANGSTROM SIGN → NFC 'Å'
  '\u00c5',
  'ﬁ', // ligature (NFKC → 'fi')
  '\u202eevil', // RTL override
  '\u200b\u200b', // zero-width spaces only
  '../../etc/passwd',
  '..',
  '.',
  '/',
  '//',
  '..%2F..%2Fme',
  '%2e%2e',
  '%00',
  '%',
  '%zz',
  'a/b',
  'a?b=c#d',
  '#',
  '?',
  '&',
  '=',
  ...INHERITED_SLUGS,
  '__proto__',
  'prototype',
  'NaN',
  'Infinity',
  '-Infinity',
  '1e309',
  '0x10',
  '1_000',
  ' 42 ',
  'true',
  'false',
  'null',
  'undefined',
  '[object Object]',
  '<script>alert(1)</script>',
  "'; DROP TABLE user_saved_drills; --",
  '{"__proto__":{"polluted":true}}',
  'https://',
  'https:/x',
  'HTTPS://api.pickle.test/x',
  'http://www.youtube-nocookie.com/embed/x',
  'https://evil.example/https://www.youtube-nocookie.com/embed/x',
  'javascript:alert(1)',
  'data:text/html,<b>x</b>',
  'file:///etc/passwd',
  '80184be3-3e97-4eaf-8d8e-55fa214fe6de', // valid v4 uuid
  '80184BE3-3E97-4EAF-8D8E-55FA214FE6DE',
  '80184be3-3e97-0eaf-8d8e-55fa214fe6de', // version 0
  '80184be3-3e97-4eaf-0d8e-55fa214fe6de', // bad variant
  '80184be3-3e97-4eaf-8d8e-55fa214fe6d', // 35 chars
  '80184be3-3e97-4eaf-8d8e-55fa214fe6dee', // 37 chars
  '80184be33e974eaf8d8e55fa214fe6de', // no dashes
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '2026-08-27T18:00:00.000Z',
  '2026-08-27T18:00:00',
  '2026-08-27',
  '2026-13-45T99:99:99Z',
  '0',
  '1',
  'Tuesday',
  '+275760-09-13T00:00:00.000Z', // max Date
  '+275760-09-13T00:00:00.001Z', // beyond max Date
  '1970-01-01T00:00:00.000Z',
  '-000001-01-01T00:00:00.000Z',
  'warmup',
  'targeted',
  'reassessment',
  'WARMUP',
  'active',
  'completed',
  'superseded',
  'hosted',
  'embed',
  'youtube',
  'vimeo',
  'UNVALIDATED',
  'VALIDATED',
];

export const HOSTILE_NUMBERS: readonly number[] = [
  0,
  -0,
  1,
  -1,
  0.5,
  -0.5,
  0.1 + 0.2,
  1e-7,
  5e-324,
  -5e-324,
  1e15,
  1e21,
  1e300,
  1.7976931348623157e308,
  -1.7976931348623157e308,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2,
  Number.MIN_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER - 1,
  2 ** 31,
  2 ** 31 - 1,
  -(2 ** 31),
  2 ** 32,
  2 ** 53,
  4294967295,
  65535,
  65536,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

export function pollutedViaJson(): unknown {
  return JSON.parse('{"__proto__":{"polluted":"via-json"}}');
}

export function nested(depth: number, leaf: unknown = 1): unknown {
  let value: unknown = leaf;
  for (let i = 0; i < depth; i++) value = i % 2 === 0 ? [value] : { v: value };
  return value;
}

export function hostileString(rng: Rng): string {
  return rng.pick(HOSTILE_STRINGS);
}

export function hostileNumber(rng: Rng): number {
  return rng.pick(HOSTILE_NUMBERS);
}

/** Any JSON-ish value, biased toward type confusion. */
export function hostileValue(rng: Rng, depth = 0): unknown {
  const roll = rng.int(0, 15);
  switch (roll) {
    case 0:
      return null;
    case 1:
      return undefined;
    case 2:
      return rng.bool();
    case 3:
    case 4:
      return hostileNumber(rng);
    case 5:
    case 6:
    case 7:
      return hostileString(rng);
    case 8:
      return [];
    case 9:
      return {};
    case 10:
      return depth > 2 ? [null] : [hostileValue(rng, depth + 1)];
    case 11:
      return depth > 2
        ? { k: 1 }
        : { [hostileString(rng)]: hostileValue(rng, depth + 1) };
    case 12:
      return pollutedViaJson();
    case 13:
      return { constructor: { prototype: { polluted: 'via-ctor' } } };
    case 14:
      return nested(rng.int(1, 64));
    default:
      return Object.create(null);
  }
}

// ─── Mutation engine ─────────────────────────────────────────────────────────

type Path = Array<string | number>;

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = clone((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }
  return value;
}

function paths(value: unknown, prefix: Path = [], out: Path[] = []): Path[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push([...prefix, index]);
      paths(item, [...prefix, index], out);
    });
  } else if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out.push([...prefix, key]);
      paths((value as Record<string, unknown>)[key], [...prefix, key], out);
    }
  }
  return out;
}

function getAt(root: unknown, path: Path): unknown {
  let cursor: unknown = root;
  for (const step of path) {
    if (cursor === null || typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  return cursor;
}

function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (parent === null || typeof parent !== 'object' || last === undefined)
    return;
  (parent as Record<string | number, unknown>)[last] = value;
}

function deleteAt(root: unknown, path: Path): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (parent === null || typeof parent !== 'object' || last === undefined)
    return;
  if (Array.isArray(parent) && typeof last === 'number') {
    parent.splice(last, 1);
  } else {
    delete (parent as Record<string | number, unknown>)[last];
  }
}

function pathLabel(path: Path): string {
  return path.length === 0 ? '$' : `$.${path.join('.')}`;
}

export type MutationOp =
  | 'delete-key'
  | 'wrong-type'
  | 'proto-key'
  | 'future-schema'
  | 'empty-container'
  | 'string-nullbyte'
  | 'string-inflate-bytes'
  | 'string-inflate-codepoints'
  | 'string-inflate-graphemes'
  | 'string-nfd'
  | 'string-traversal'
  | 'string-lone-surrogate'
  | 'number-nan'
  | 'number-infinity'
  | 'number-negzero'
  | 'number-overflow'
  | 'number-negative'
  | 'number-fraction'
  | 'number-as-string'
  | 'number-as-bool'
  | 'array-dup'
  | 'array-hole'
  | 'array-to-object'
  | 'wrap-in-array'
  | 'key-case'
  | 'swap-siblings'
  | 'deep-nest'
  | 'replace-root';

const OPS: readonly MutationOp[] = [
  'delete-key',
  'wrong-type',
  'wrong-type',
  'proto-key',
  'future-schema',
  'empty-container',
  'string-nullbyte',
  'string-inflate-bytes',
  'string-inflate-codepoints',
  'string-inflate-graphemes',
  'string-nfd',
  'string-traversal',
  'string-lone-surrogate',
  'number-nan',
  'number-infinity',
  'number-negzero',
  'number-overflow',
  'number-negative',
  'number-fraction',
  'number-as-string',
  'number-as-bool',
  'array-dup',
  'array-hole',
  'array-to-object',
  'wrap-in-array',
  'key-case',
  'swap-siblings',
  'deep-nest',
  'replace-root',
];

export interface Mutation {
  op: MutationOp;
  path: string;
  detail?: string;
}

function pickPathWhere(
  rng: Rng,
  root: unknown,
  predicate: (value: unknown, path: Path) => boolean,
): Path | null {
  const candidates = paths(root).filter(p => predicate(getAt(root, p), p));
  return candidates.length === 0 ? null : rng.pick(candidates);
}

function summarize(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 40
      ? `"${value.slice(0, 20)}…"(len=${value.length})`
      : JSON.stringify(value);
  }
  if (typeof value === 'number')
    return Object.is(value, -0) ? '-0' : `${value}`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    return proto === null ? 'object(null-proto)' : 'object';
  }
  return String(value);
}

/**
 * Applies `count` random mutation operators to a deep clone of `payload`.
 * Returns the mutated value plus the ops that were applied (for the table).
 */
export function mutate(
  payload: unknown,
  rng: Rng,
  count: number,
): { value: unknown; ops: Mutation[] } {
  let value: unknown = clone(payload);
  const ops: Mutation[] = [];
  for (let i = 0; i < count; i++) {
    const op = rng.pick(OPS);
    const applied = applyOp(op, value, rng);
    if (applied === null) continue;
    if (applied.root !== undefined) value = applied.root;
    ops.push(applied.mutation);
  }
  return { value, ops };
}

function applyOp(
  op: MutationOp,
  root: unknown,
  rng: Rng,
): { mutation: Mutation; root?: unknown } | null {
  const isStr = (v: unknown): v is string => typeof v === 'string';
  const isNum = (v: unknown): v is number => typeof v === 'number';
  const isArr = Array.isArray;
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  const any = () => true;
  const withPath = (
    predicate: (value: unknown, path: Path) => boolean,
    apply: (path: Path, current: unknown) => string | undefined,
  ) => {
    const path = pickPathWhere(rng, root, predicate);
    if (path === null) return null;
    const detail = apply(path, getAt(root, path));
    return { mutation: { op, path: pathLabel(path), detail } };
  };
  switch (op) {
    case 'delete-key':
      return withPath(any, path => {
        deleteAt(root, path);
        return undefined;
      });
    case 'wrong-type':
      return withPath(any, path => {
        const replacement = hostileValue(rng);
        setAt(root, path, replacement);
        return summarize(replacement);
      });
    case 'proto-key':
      return withPath(isObj, path => {
        const key = rng.pick(PROTO_KEYS);
        const parent = getAt(root, path) as Record<string, unknown>;
        // Own-property definition, exactly what JSON.parse produces.
        Object.defineProperty(parent, key, {
          value: rng.bool()
            ? { polluted: 'own-key' }
            : { prototype: { polluted: 'own-key' } },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        return key;
      });
    case 'future-schema':
      return withPath(isObj, path => {
        const parent = getAt(root, path) as Record<string, unknown>;
        const key = rng.pick([
          'schemaVersion',
          'schema_version',
          '_v',
          'version',
          '$type',
          'kind2',
          'items_v2',
        ]);
        parent[key] = rng.pick([99, '2.0', { major: 2 }, null, [], true]);
        return key;
      });
    case 'empty-container':
      return withPath(
        v => isArr(v) || isObj(v),
        (path, current) => {
          setAt(root, path, isArr(current) ? [] : {});
          return undefined;
        },
      );
    case 'string-nullbyte':
      return withPath(isStr, (path, current) => {
        const s = current as string;
        const variant = rng.int(0, 2);
        setAt(
          root,
          path,
          variant === 0
            ? `\u0000${s}`
            : variant === 1
              ? `${s}\u0000`
              : '\u0000',
        );
        return `variant=${variant}`;
      });
    case 'string-inflate-bytes':
      return withPath(isStr, path => {
        setAt(root, path, 'x'.repeat(KB64 + rng.int(0, 16)));
        return undefined;
      });
    case 'string-inflate-codepoints':
      return withPath(isStr, path => {
        setAt(root, path, '\u00e9'.repeat(KB64 / 2 + rng.int(1, 8)));
        return undefined;
      });
    case 'string-inflate-graphemes':
      return withPath(isStr, path => {
        setAt(
          root,
          path,
          '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67'.repeat(
            KB64 / 8 + rng.int(1, 4),
          ),
        );
        return undefined;
      });
    case 'string-nfd':
      return withPath(isStr, (path, current) => {
        const s = current as string;
        const decorated = rng.bool() ? `${s}\u00e9` : `caf\u00e9-${s}`;
        setAt(root, path, decorated.normalize('NFD'));
        return undefined;
      });
    case 'string-traversal':
      return withPath(isStr, path => {
        const t = rng.pick([
          '..',
          '.',
          '../..',
          '../../me',
          'a/../b',
          '/',
          '%2e%2e',
        ]);
        setAt(root, path, t);
        return t;
      });
    case 'string-lone-surrogate':
      return withPath(isStr, (path, current) => {
        setAt(root, path, `${current as string}\ud800`);
        return undefined;
      });
    case 'number-nan':
      return withPath(isNum, path => {
        setAt(root, path, Number.NaN);
        return undefined;
      });
    case 'number-infinity':
      return withPath(isNum, path => {
        const v = rng.bool() ? Infinity : -Infinity;
        setAt(root, path, v);
        return `${v}`;
      });
    case 'number-negzero':
      return withPath(isNum, path => {
        setAt(root, path, -0);
        return undefined;
      });
    case 'number-overflow':
      return withPath(isNum, path => {
        const v = rng.pick([
          Number.MAX_SAFE_INTEGER + 1,
          2 ** 53,
          1e21,
          1.7976931348623157e308,
          -(2 ** 53),
        ]);
        setAt(root, path, v);
        return `${v}`;
      });
    case 'number-negative':
      return withPath(isNum, (path, current) => {
        setAt(root, path, -Math.abs(current as number) - rng.int(0, 3));
        return undefined;
      });
    case 'number-fraction':
      return withPath(isNum, (path, current) => {
        setAt(root, path, (current as number) + 0.5);
        return undefined;
      });
    case 'number-as-string':
      return withPath(isNum, (path, current) => {
        const s = rng.pick([
          `${current as number}`,
          ` ${current as number} `,
          '0x10',
          '',
        ]);
        setAt(root, path, s);
        return JSON.stringify(s);
      });
    case 'number-as-bool':
      return withPath(isNum, path => {
        const b = rng.bool();
        setAt(root, path, b);
        return `${b}`;
      });
    case 'array-dup':
      return withPath(
        v => isArr(v) && v.length > 0,
        (path, current) => {
          const arr = current as unknown[];
          const times = rng.int(1, 4);
          const out = [...arr];
          for (let i = 0; i < times; i++) out.push(clone(rng.pick(arr)));
          setAt(root, path, out);
          return `+${times}`;
        },
      );
    case 'array-hole':
      return withPath(isArr, (path, current) => {
        // `response.json()` can never yield a sparse array; the wire form of a
        // "hole" is an explicit null element (JSON.stringify of a hole).
        const arr = [...(current as unknown[])];
        const holes = rng.int(1, 3);
        for (let i = 0; i < holes; i++)
          arr.splice(rng.int(0, arr.length), 0, null);
        setAt(root, path, arr);
        return `nulls=${holes}`;
      });
    case 'array-to-object':
      return withPath(isArr, (path, current) => {
        const arr = current as unknown[];
        const obj: Record<string, unknown> = {};
        arr.forEach((item, index) => {
          obj[String(index)] = item;
        });
        obj['length'] = arr.length;
        setAt(root, path, obj);
        return undefined;
      });
    case 'wrap-in-array':
      return withPath(any, (path, current) => {
        setAt(root, path, [current]);
        return undefined;
      });
    case 'key-case':
      return withPath(
        (_v, path) => typeof path[path.length - 1] === 'string',
        (path, current) => {
          const key = path[path.length - 1] as string;
          const swapped = key.includes('_')
            ? key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase())
            : /[A-Z]/.test(key)
              ? key.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
              : key.toUpperCase();
          if (swapped === key) return undefined;
          deleteAt(root, path);
          setAt(root, [...path.slice(0, -1), swapped], current);
          return `${key}→${swapped}`;
        },
      );
    case 'swap-siblings':
      return withPath(
        v => isObj(v) && Object.keys(v).length >= 2,
        (path, current) => {
          const obj = current as Record<string, unknown>;
          const keys = Object.keys(obj);
          const a = rng.pick(keys);
          const b = rng.pick(keys.filter(k => k !== a));
          const tmp = obj[a];
          obj[a] = obj[b];
          obj[b] = tmp;
          return `${a}⇄${b}`;
        },
      );
    case 'deep-nest':
      return withPath(any, path => {
        const depth = rng.int(8, 256);
        setAt(root, path, nested(depth, hostileValue(rng)));
        return `depth=${depth}`;
      });
    case 'replace-root': {
      const replacement = hostileValue(rng);
      return {
        mutation: { op, path: '$', detail: summarize(replacement) },
        root: replacement,
      };
    }
    default:
      return null;
  }
}

/**
 * Serialises `value` and corrupts the TEXT (truncation, byte deletion, junk
 * insertion) so `JSON.parse` may fail the way a cut connection does.
 */
export function corruptJsonText(
  value: unknown,
  rng: Rng,
): { text: string; detail: string } {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'undefined';
  } catch {
    text = '{"circular":';
  }
  const variant = rng.int(0, 6);
  switch (variant) {
    case 0: {
      const cut = rng.int(0, Math.max(0, text.length - 1));
      return { text: text.slice(0, cut), detail: `truncate@${cut}` };
    }
    case 1: {
      const at = rng.int(0, Math.max(0, text.length - 1));
      return {
        text: `${text.slice(0, at)}${text.slice(at + 1)}`,
        detail: `drop-byte@${at}`,
      };
    }
    case 2: {
      const at = rng.int(0, text.length);
      const junk = rng.pick([
        '\u0000',
        'NaN',
        'undefined',
        "'",
        '\\u',
        ',,',
        '\ufeff',
      ]);
      return {
        text: `${text.slice(0, at)}${junk}${text.slice(at)}`,
        detail: `insert@${at}:${JSON.stringify(junk)}`,
      };
    }
    case 3:
      return { text: `${text}${text}`, detail: 'doubled' };
    case 4:
      return { text: '', detail: 'empty-body' };
    case 5:
      return { text: `\ufeff${text}`, detail: 'bom' };
    default:
      return { text, detail: 'intact' };
  }
}

// ─── Valid fixtures (server wire shapes) ─────────────────────────────────────

export const FIX = {
  uuid: {
    saved: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
    plan: '78a7815a-176a-4487-a736-66eb2cc04455',
    shot: 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7',
    item1: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
    item2: 'e8d1a7c2-0f9b-4c3d-9a1e-5b6c7d8e9f01',
    item3: '391b4bf2-c9d6-45bb-b471-250651e4e226',
    media: '4ecbd9d8-c2d6-4663-8561-3dbf81961a64',
    media2: '5fdce0e9-d3e7-4774-9672-4ecf92a72b75',
    completion: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
  },
  slug: 'contact-shadow',
} as const;

export function catalogDrillWire(
  slug: string = FIX.slug,
): Record<string, unknown> {
  return {
    id: FIX.uuid.saved,
    slug,
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coach_name: 'Coach Rivera',
    equipment: ['paddle'],
    difficulty_min: '2.5',
    difficulty_max: '4.5',
    families: ['forehand_drive'],
    validation_state: 'UNVALIDATED',
    saved: false,
  };
}

export function savedDrillWire(
  slug: string = FIX.slug,
): Record<string, unknown> {
  return {
    id: FIX.uuid.saved,
    slug,
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coach_name: 'Coach Rivera',
    equipment: ['paddle'],
    difficulty_min: '2.5',
    difficulty_max: '4.5',
    saved_at: '2026-08-27T18:00:00.000Z',
  };
}

export function drillDetailWire(
  slug: string = FIX.slug,
): Record<string, unknown> {
  return {
    drill: {
      id: FIX.uuid.saved,
      slug,
      title: 'Contact Shadow Reps',
      description: 'A coach-reviewed contact prescription.',
      coach_name: 'Coach Rivera',
      equipment: ['paddle'],
      difficulty_min: '2.5',
      difficulty_max: null,
      saved: true,
    },
    mappings: [
      {
        checkpoint: 'contact_position',
        shot_type: 'forehand_drive',
        plan_role: 'targeted',
        fault_directions: ['late'],
        cue_text: 'Meet the ball comfortably in front.',
        target_sets: 3,
        target_repetitions_per_set: 8,
        target_duration_seconds: null,
        rest_seconds: 20,
      },
      {
        checkpoint: 'contact_position',
        shot_type: 'forehand_drive',
        plan_role: 'warmup',
        fault_directions: [],
        cue_text: 'Shadow the swing path.',
        target_sets: 1,
        target_repetitions_per_set: null,
        target_duration_seconds: 60,
        rest_seconds: null,
      },
    ],
    instructionalMedia: [
      {
        id: FIX.uuid.media,
        kind: 'embed',
        provider: 'youtube',
        videoId: 'abcDEF12345',
        embedUrl: 'https://www.youtube-nocookie.com/embed/abcDEF12345',
        sourceUrl: 'https://www.youtube.com/watch?v=abcDEF12345',
        creatorName: 'Coach Rivera',
        licenseName: 'Published with permission',
        licenseUrl: null,
        attribution: 'Coach Rivera instructional video',
      },
      {
        id: FIX.uuid.media2,
        kind: 'hosted',
        playbackUrl: 'https://media.pickle.test/clip.m3u8',
        expiresAt: '2026-08-28T18:00:00.000Z',
        sourceUrl: 'https://media.pickle.test/clip',
        creatorName: 'Pickle Sensei',
        licenseName: 'CC BY 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
        attribution: 'Pickle Sensei training clip',
      },
    ],
  };
}

export function completionWire(): Record<string, unknown> {
  return {
    id: FIX.uuid.completion,
    completedAt: '2026-08-27T19:00:00.000Z',
    actualRepetitions: 24,
    actualDurationSeconds: null,
    qualifiesForStreak: true,
  };
}

export function planWire(slug: string = FIX.slug): Record<string, unknown> {
  const drill = {
    slug,
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coachName: 'Coach Rivera',
    equipment: ['paddle'],
    saved: true,
  };
  return {
    id: FIX.uuid.plan,
    status: 'active',
    algorithmVersion: 'reviewed-plan-v1',
    sourceShotId: FIX.uuid.shot,
    shotType: 'forehand_drive',
    priorityCheckpoint: 'contact_position',
    priorityDirection: 'late',
    baselineScore: 7.4,
    baselineCheckpointScore: 58,
    reassessmentShotId: null,
    scoreDelta: null,
    createdAt: '2026-08-27T18:00:00.000Z',
    completedAt: null,
    items: [
      {
        id: FIX.uuid.item1,
        position: 1,
        kind: 'warmup',
        drill: { ...drill, slug: `${slug}-warmup` },
        cueText: null,
        targetSets: 1,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: 60,
        restSeconds: null,
        completion: completionWire(),
      },
      {
        id: FIX.uuid.item2,
        position: 2,
        kind: 'targeted',
        drill,
        cueText: 'Meet the ball comfortably in front.',
        targetSets: 3,
        targetRepetitionsPerSet: 8,
        targetDurationSeconds: null,
        restSeconds: 20,
        completion: null,
      },
      {
        id: FIX.uuid.item3,
        position: 3,
        kind: 'reassessment',
        drill: null,
        cueText: null,
        targetSets: null,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: null,
        restSeconds: null,
        completion: null,
      },
    ],
  };
}

// ─── Independent structural validators (from types.ts, not from api.ts) ──────

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const str = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const nstr = (v: unknown): v is string | null =>
  v === null || typeof v === 'string';
const fin = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v);
const nfin = (v: unknown): v is number | null => v === null || fin(v);
const iso = (v: unknown): v is string => str(v) && !Number.isNaN(Date.parse(v));
const plain = (v: unknown): v is Record<string, unknown> =>
  v !== null &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.getPrototypeOf(v) === Object.prototype;

export function validCatalogDrill(v: unknown): v is CatalogDrill {
  return (
    plain(v) &&
    UUID.test(String(v['id'])) &&
    str(v['slug']) &&
    str(v['title']) &&
    str(v['description']) &&
    str(v['coachName']) &&
    Array.isArray(v['equipment']) &&
    v['equipment'].every(str) &&
    nstr(v['difficultyMin']) &&
    nstr(v['difficultyMax']) &&
    Array.isArray(v['families']) &&
    v['families'].every(str) &&
    str(v['validationState']) &&
    typeof v['saved'] === 'boolean'
  );
}

export function validSavedDrill(v: unknown): v is SavedDrill {
  return (
    plain(v) &&
    UUID.test(String(v['id'])) &&
    str(v['slug']) &&
    str(v['title']) &&
    str(v['description']) &&
    str(v['coachName']) &&
    Array.isArray(v['equipment']) &&
    nstr(v['difficultyMin']) &&
    nstr(v['difficultyMax']) &&
    iso(v['savedAt'])
  );
}

function validMapping(v: unknown): v is DrillMapping {
  return (
    plain(v) &&
    str(v['checkpoint']) &&
    str(v['shotType']) &&
    (v['planRole'] === 'warmup' || v['planRole'] === 'targeted') &&
    Array.isArray(v['faultDirections']) &&
    v['faultDirections'].every(str) &&
    str(v['cueText']) &&
    Number.isSafeInteger(v['targetSets']) &&
    (v['targetSets'] as number) >= 1 &&
    nfin(v['targetRepetitionsPerSet']) &&
    nfin(v['targetDurationSeconds']) &&
    nfin(v['restSeconds'])
  );
}

function https(v: unknown): v is string {
  return str(v) && v.startsWith('https://');
}

function validMedia(v: unknown): v is InstructionalMedia {
  if (
    !plain(v) ||
    !UUID.test(String(v['id'])) ||
    !https(v['sourceUrl']) ||
    !str(v['creatorName']) ||
    !str(v['licenseName']) ||
    !(v['licenseUrl'] === null || https(v['licenseUrl'])) ||
    !str(v['attribution'])
  ) {
    return false;
  }
  if (v['kind'] === 'hosted') {
    return https(v['playbackUrl']) && iso(v['expiresAt']);
  }
  if (v['kind'] === 'embed') {
    return (
      (v['provider'] === 'youtube' || v['provider'] === 'vimeo') &&
      str(v['videoId']) &&
      https(v['embedUrl']) &&
      (v['provider'] === 'youtube'
        ? v['embedUrl'] ===
          `https://www.youtube-nocookie.com/embed/${v['videoId']}`
        : v['embedUrl'] === `https://player.vimeo.com/video/${v['videoId']}`)
    );
  }
  return false;
}

export function validDrillDetail(v: unknown): v is DrillDetail {
  return (
    plain(v) &&
    UUID.test(String(v['id'])) &&
    str(v['slug']) &&
    str(v['title']) &&
    str(v['description']) &&
    str(v['coachName']) &&
    Array.isArray(v['equipment']) &&
    nstr(v['difficultyMin']) &&
    nstr(v['difficultyMax']) &&
    typeof v['saved'] === 'boolean' &&
    Array.isArray(v['mappings']) &&
    v['mappings'].every(validMapping) &&
    Array.isArray(v['instructionalMedia']) &&
    v['instructionalMedia'].every(validMedia)
  );
}

export function validCompletion(v: unknown): v is DrillCompletion {
  return (
    plain(v) &&
    UUID.test(String(v['id'])) &&
    iso(v['completedAt']) &&
    nfin(v['actualRepetitions']) &&
    nfin(v['actualDurationSeconds']) &&
    typeof v['qualifiesForStreak'] === 'boolean'
  );
}

function validPlanItem(v: unknown): v is TrainingPlanItem {
  if (!plain(v)) return false;
  const kind = v['kind'];
  if (kind !== 'warmup' && kind !== 'targeted' && kind !== 'reassessment')
    return false;
  const drill = v['drill'];
  const drillOk =
    drill === null ||
    (plain(drill) &&
      str(drill['slug']) &&
      str(drill['title']) &&
      str(drill['description']) &&
      str(drill['coachName']) &&
      Array.isArray(drill['equipment']) &&
      typeof drill['saved'] === 'boolean');
  return (
    UUID.test(String(v['id'])) &&
    Number.isSafeInteger(v['position']) &&
    drillOk &&
    (kind === 'reassessment') === (drill === null) &&
    nstr(v['cueText']) &&
    nfin(v['targetSets']) &&
    nfin(v['targetRepetitionsPerSet']) &&
    nfin(v['targetDurationSeconds']) &&
    nfin(v['restSeconds']) &&
    (v['completion'] === null || validCompletion(v['completion']))
  );
}

export function validPlan(v: unknown): v is TrainingPlan {
  return (
    plain(v) &&
    UUID.test(String(v['id'])) &&
    (v['status'] === 'active' ||
      v['status'] === 'completed' ||
      v['status'] === 'superseded') &&
    str(v['algorithmVersion']) &&
    UUID.test(String(v['sourceShotId'])) &&
    str(v['shotType']) &&
    str(v['priorityCheckpoint']) &&
    str(v['priorityDirection']) &&
    fin(v['baselineScore']) &&
    nfin(v['baselineCheckpointScore']) &&
    (v['reassessmentShotId'] === null ||
      UUID.test(String(v['reassessmentShotId']))) &&
    nfin(v['scoreDelta']) &&
    iso(v['createdAt']) &&
    (v['completedAt'] === null || iso(v['completedAt'])) &&
    Array.isArray(v['items']) &&
    v['items'].every(validPlanItem)
  );
}

export function validErrorState(v: unknown): v is TrainingErrorState {
  return (
    plain(v) &&
    typeof v['code'] === 'string' &&
    typeof v['message'] === 'string' &&
    typeof v['retryable'] === 'boolean' &&
    (v['status'] === null || fin(v['status']))
  );
}

/** A rejection is "typed" only when it is a real TrainingError instance. */
export function isTypedRejection(error: unknown): error is TrainingError {
  return (
    error instanceof TrainingError &&
    typeof error.code === 'string' &&
    typeof error.message === 'string' &&
    typeof error.retryable === 'boolean' &&
    (error.status === null || fin(error.status))
  );
}

// ─── Fake transport ──────────────────────────────────────────────────────────

export interface Recorded {
  url: string;
  method: string;
  body: string | undefined;
}

export function fakeResponse(
  status: number,
  body: { json: unknown } | { text: string },
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () =>
      'text' in body ? (JSON.parse(body.text) as unknown) : body.json,
  } as unknown as Response;
}

export function recordingFetch(
  handler: (recorded: Recorded) => Response | Promise<Response>,
): { fetchFn: TrainingFetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchFn: TrainingFetch = async (input, init) => {
    const recorded: Recorded = {
      url: input,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(recorded);
    return handler(recorded);
  };
  return { fetchFn, calls };
}

export const BASE_URL = 'https://api.pickle.test';

export function apiConfig(
  fetchFn: TrainingFetch,
  onUnauthorized?: () => void,
): TrainingApiConfig {
  return { baseUrl: BASE_URL, token: 'stress-token', fetchFn, onUnauthorized };
}

// ─── Global prototype-pollution sentinel ─────────────────────────────────────

const PROTO_BASELINE = new Set(Object.getOwnPropertyNames(Object.prototype));
const ARRAY_BASELINE = new Set(Object.getOwnPropertyNames(Array.prototype));

export function globalPollution(): string | null {
  const probe = {} as Record<string, unknown>;
  if (probe['polluted'] !== undefined) return 'Object.prototype.polluted';
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    if (!PROTO_BASELINE.has(name)) return `Object.prototype.${name}`;
  }
  for (const name of Object.getOwnPropertyNames(Array.prototype)) {
    if (!ARRAY_BASELINE.has(name)) return `Array.prototype.${name}`;
  }
  return null;
}

// ─── Outcome classification & artifacts ──────────────────────────────────────

export type Outcome =
  | { kind: 'accepted' }
  | { kind: 'rejected'; code: string; status: number | null }
  | { kind: 'BROKEN'; invariant: string; detail: string };

export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.constructor.name}: ${error.message.slice(0, 160)}`;
  }
  return `non-Error rejection: ${summarize(error)}`;
}

/**
 * Classifies one settled api call: accepted values must satisfy the
 * independent validator; rejections must be TrainingError instances.
 */
export function classifySettled(
  settled: PromiseSettledResult<unknown>,
  validator: (value: unknown) => boolean,
): Outcome {
  if (settled.status === 'fulfilled') {
    return validator(settled.value)
      ? { kind: 'accepted' }
      : {
          kind: 'BROKEN',
          invariant: 'accepted-invalid-shape',
          detail: summarize(settled.value),
        };
  }
  if (isTypedRejection(settled.reason)) {
    const code = settled.reason.code;
    return {
      kind: 'rejected',
      code:
        code.length > 64 ? `${code.slice(0, 32)}…(len=${code.length})` : code,
      status: settled.reason.status,
    };
  }
  return {
    kind: 'BROKEN',
    invariant: 'untyped-rejection',
    detail: describeError(settled.reason),
  };
}

export interface TableRow {
  campaign: string;
  seed: number;
  index: number;
  scenario: string;
  mutations: Mutation[] | string;
  outcome: Outcome;
  known?: string;
}

export function outDir(): string {
  return (
    process.env['STRESS_OUT'] ??
    join(__dirname, '..', '..', 'artifacts', 'stress', 'mod-training')
  );
}
declare const __dirname: string;

export function writeTable(
  name: string,
  rows: TableRow[],
  extra: Record<string, unknown>,
): { path: string; summary: Record<string, unknown> } {
  const dir = outDir();
  mkdirSync(dir, { recursive: true });
  const byOutcome: Record<string, number> = {};
  const byInvariant: Record<string, number> = {};
  const byScenario: Record<string, { executed: number; broken: number }> = {};
  for (const row of rows) {
    const key =
      row.outcome.kind === 'BROKEN'
        ? `BROKEN:${row.outcome.invariant}`
        : row.outcome.kind === 'rejected'
          ? `rejected:${row.outcome.code}`
          : 'accepted';
    byOutcome[key] = (byOutcome[key] ?? 0) + 1;
    if (row.outcome.kind === 'BROKEN') {
      byInvariant[row.outcome.invariant] =
        (byInvariant[row.outcome.invariant] ?? 0) + 1;
    }
    const s = (byScenario[row.scenario] ??= { executed: 0, broken: 0 });
    s.executed += 1;
    if (row.outcome.kind === 'BROKEN') s.broken += 1;
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    campaign: name,
    executed: rows.length,
    broken: rows.filter(r => r.outcome.kind === 'BROKEN').length,
    knownBroken: rows.filter(r => r.outcome.kind === 'BROKEN' && r.known)
      .length,
    unexpectedBroken: rows.filter(r => r.outcome.kind === 'BROKEN' && !r.known)
      .length,
    byOutcome,
    byInvariant,
    byScenario,
    ...extra,
  };
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      { summary, rows: rows.map(r => ({ ...r, mutations: compact(r) })) },
      null,
      1,
    ),
  );
  return { path, summary };
}

function compact(row: TableRow): unknown {
  if (typeof row.mutations === 'string') return row.mutations;
  return row.mutations.map(m =>
    m.detail === undefined
      ? `${m.op}@${m.path}`
      : `${m.op}@${m.path}=${m.detail}`,
  );
}

export function iterations(defaultCount: number): number {
  const raw = process.env['STRESS_ITER'];
  const n = raw === undefined ? defaultCount : Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return n;
}

/** `STRESS_ONLY=<campaign>:<seed>` replays exactly one row. */
export function onlySeed(campaign: string): number | null {
  const raw = process.env['STRESS_ONLY'];
  if (!raw) return null;
  const [name, seed] = raw.split(':');
  if (name !== campaign) return null;
  const n = Number(seed);
  if (!Number.isInteger(n)) {
    throw new Error(`STRESS_ONLY must be <campaign>:<seed>, got ${raw}`);
  }
  return n >>> 0;
}
