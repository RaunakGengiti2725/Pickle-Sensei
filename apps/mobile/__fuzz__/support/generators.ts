/**
 * Payload generators for persisted-state fuzzing. Each generator turns a
 * VALID template record into one adversarial input: random bytes, truncated
 * JSON, wrong field types, future schema versions, hostile JSON shapes, and
 * (for SQLite-backed surfaces) non-string column values of the kinds a typed
 * driver such as op-sqlite can hand back (numbers, NULL, blobs).
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createHash } = require('crypto') as {
  createHash: (algorithm: string) => {
    update: (
      data: string,
      encoding: string,
    ) => { digest: (encoding: string) => string };
  };
};
import type { Rng } from './prng';

export type Json =
  null | boolean | number | string | Json[] | { [key: string]: Json };

export type GeneratedInput =
  | { kind: 'string'; value: string }
  | { kind: 'typed'; value: unknown; describe: string };

export type Generator = (rng: Rng, template: Json) => GeneratedInput;

const str = (value: string): GeneratedInput => ({ kind: 'string', value });

function isObject(value: Json): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clone<T extends Json>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const SCALAR_POOL: Json[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1.5,
  1e308,
  -1e308,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER + 1,
  Number.MAX_SAFE_INTEGER + 2,
  '',
  ' ',
  '0',
  'null',
  'undefined',
  'true',
  'NaN',
  '[object Object]',
  '\u0000',
  '\ud800',
  '__proto__',
  'a'.repeat(300),
];

export function randomJsonValue(rng: Rng, depth = 0): Json {
  const roll = rng.next();
  if (depth >= 3 || roll < 0.55) {
    if (rng.bool(0.3)) return rng.pick(SCALAR_POOL);
    if (rng.bool(0.5))
      return rng.int(-1_000_000, 1_000_000) / (rng.bool() ? 1 : 7);
    return rng.bool()
      ? rng.ascii(rng.int(0, 24))
      : rng.codeUnits(rng.int(0, 12));
  }
  if (roll < 0.78) {
    const out: Json[] = [];
    const length = rng.int(0, 4);
    for (let i = 0; i < length; i++) out.push(randomJsonValue(rng, depth + 1));
    return out;
  }
  const out: { [key: string]: Json } = {};
  const length = rng.int(0, 4);
  for (let i = 0; i < length; i++) {
    out[
      rng.bool(0.8)
        ? rng.ascii(rng.int(1, 8))
        : rng.pick(['__proto__', 'constructor', 'version', ''])
    ] = randomJsonValue(rng, depth + 1);
  }
  return out;
}

type Path = Array<string | number>;

function collectPaths(value: Json, prefix: Path, out: Path[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push([...prefix, index]);
      collectPaths(item, [...prefix, index], out);
    });
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      out.push([...prefix, key]);
      collectPaths(value[key] as Json, [...prefix, key], out);
    }
  }
}

function jsonTypeOf(value: Json): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A value whose JSON type differs from `current`. */
function differentlyTyped(rng: Rng, current: Json): Json {
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = randomJsonValue(rng);
    if (jsonTypeOf(candidate) !== jsonTypeOf(current)) return candidate;
  }
  return current === null ? 1 : null;
}

function setAtPath(root: Json, path: Path, value: Json | undefined): Json {
  if (path.length === 0) return value === undefined ? null : value;
  let cursor: Json = root;
  for (let i = 0; i < path.length - 1; i++) {
    const step = path[i] as string | number;
    cursor = (cursor as { [key: string]: Json })[step as string] as Json;
  }
  const last = path[path.length - 1] as string | number;
  if (Array.isArray(cursor)) {
    if (value === undefined) cursor.splice(Number(last), 1);
    else cursor[Number(last)] = value;
  } else if (isObject(cursor)) {
    if (value === undefined) delete cursor[String(last)];
    else cursor[String(last)] = value;
  }
  return root;
}

/** Retypes, deletes or replaces 1–4 random nodes of the template. */
export function mutateTypes(rng: Rng, template: Json): Json {
  let mutated = clone(template);
  const initialPaths: Path[] = [];
  collectPaths(mutated, [], initialPaths);
  if (initialPaths.length === 0) return differentlyTyped(rng, mutated);
  const mutations = rng.int(1, Math.min(4, initialPaths.length));
  for (let i = 0; i < mutations; i++) {
    // Re-walk after every mutation: a deleted or retyped node invalidates
    // the paths beneath it.
    const paths: Path[] = [];
    collectPaths(mutated, [], paths);
    if (paths.length === 0) break;
    const path = rng.pick(paths);
    const action = rng.next();
    let current: Json = mutated;
    for (const step of path) {
      current = (current as { [key: string]: Json })[step as string] as Json;
    }
    if (action < 0.6) {
      mutated = setAtPath(
        mutated,
        path,
        differentlyTyped(rng, current ?? null),
      );
    } else if (action < 0.85) {
      mutated = setAtPath(mutated, path, undefined);
    } else {
      mutated = setAtPath(mutated, path, randomJsonValue(rng));
    }
  }
  return mutated;
}

const FUTURE_VERSIONS: Json[] = [
  2,
  3,
  99,
  1000000,
  '2',
  '1',
  1.5,
  -1,
  0,
  null,
  true,
  {},
  [],
  'v2',
];

export function futureVersion(rng: Rng, template: Json): Json {
  const base = isObject(template)
    ? clone(template)
    : { legacy: clone(template) };
  const versionKey =
    'version' in base ? 'version' : rng.pick(['version', 'schemaVersion', 'v']);
  base[versionKey] = rng.pick(FUTURE_VERSIONS);
  const extras = rng.int(1, 3);
  for (let i = 0; i < extras; i++) {
    base[`future_${rng.ascii(rng.int(1, 10)).replace(/[^a-zA-Z0-9]/g, '_')}`] =
      randomJsonValue(rng);
  }
  if (rng.bool(0.35)) {
    const keys = Object.keys(base).filter(key => key !== versionKey);
    if (keys.length > 0) {
      const key = rng.pick(keys);
      base[`${key}V2`] = base[key] as Json;
      delete base[key];
    }
  }
  if (rng.bool(0.25)) {
    // A future release nests today's record under an envelope.
    return {
      version: rng.pick(FUTURE_VERSIONS),
      record: base,
      migratedFrom: 1,
    };
  }
  return base;
}

const JSON_SCALAR_TEXTS = [
  'null',
  'true',
  'false',
  '0',
  '-0',
  '1',
  '-1',
  '1e999',
  '-1e999',
  '9007199254740993',
  '""',
  '"str"',
  '"0"',
  '"null"',
  '"[object Object]"',
  '[]',
  '{}',
  '[null]',
  '[{}]',
  '{"":""}',
  '{"version":1}',
  '{"version":"1"}',
  '{"profile":null}',
  '{"profile":[]}',
  '{"profile":"x"}',
  '{"record":{}}',
  '"\\ud800"',
  '"\\u0000"',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
];

export function truncated(rng: Rng, text: string): string {
  if (text.length <= 1) return '';
  return text.slice(0, rng.int(0, text.length - 1));
}

export function byteFlip(rng: Rng, text: string): string {
  if (text.length === 0) return rng.ascii(1);
  const chars = Array.from(text);
  const flips = rng.int(1, Math.min(5, chars.length));
  for (let i = 0; i < flips; i++) {
    const index = rng.int(0, chars.length - 1);
    const mode = rng.next();
    if (mode < 0.5) chars[index] = rng.ascii(1);
    else if (mode < 0.8)
      chars[index] = rng.pick([
        '"',
        '{',
        '}',
        '[',
        ']',
        ',',
        ':',
        '\\',
        '\u0000',
        '\ud800',
      ]);
    else chars[index] = rng.codeUnits(1);
  }
  return chars.join('');
}

function deepNesting(rng: Rng): string {
  const depth = rng.pick([32, 256, 2048, 10000, 60000]);
  const style = rng.int(0, 2);
  if (style === 0) return '['.repeat(depth) + ']'.repeat(depth);
  if (style === 1) return '{"a":'.repeat(depth) + '1' + '}'.repeat(depth);
  return '[' + '{"v":['.repeat(depth) + ']}'.repeat(depth) + ']';
}

function hugeString(rng: Rng, template: Json): string {
  const size = rng.pick([64 * 1024, 512 * 1024, 2 * 1024 * 1024]);
  const filler = rng.bool(0.5)
    ? 'a'.repeat(size)
    : rng
        .ascii(Math.min(size, 65536))
        .repeat(Math.ceil(size / 65536))
        .slice(0, size);
  if (isObject(template) && rng.bool(0.6)) {
    const keys = Object.keys(template);
    if (keys.length > 0) {
      const copy = clone(template);
      copy[rng.pick(keys)] = filler;
      return JSON.stringify(copy);
    }
  }
  return JSON.stringify(filler);
}

function protoKeys(rng: Rng, template: Json): string {
  const base = isObject(template) ? clone(template) : {};
  const entries = Object.entries(base).map(
    ([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`,
  );
  const poison = [
    '"__proto__":{"polluted":true,"version":1}',
    '"constructor":{"prototype":{"polluted":true}}',
    '"prototype":{"polluted":true}',
  ];
  entries.push(rng.pick(poison));
  if (rng.bool(0.5)) entries.push(rng.pick(poison));
  return `{${entries.join(',')}}`;
}

function unicodeNoise(rng: Rng, template: Json): string {
  const text = JSON.stringify(template);
  const noise = rng.int(0, 4);
  if (noise === 0) return '\ufeff' + text;
  if (noise === 1) return '\u200b' + text + '\u200e';
  if (noise === 2) return text.replace(/"/, '"\u2028');
  if (noise === 3) return text.replace(/:/, ':\u0000');
  return text.replace(/"([^"]*)"/, '"\\ud800$1\\udfff"');
}

function wrapped(rng: Rng, template: Json): string {
  const mode = rng.int(0, 3);
  if (mode === 0) return JSON.stringify([template]);
  if (mode === 1) return JSON.stringify({ data: template });
  if (mode === 2) return JSON.stringify(JSON.stringify(template));
  return JSON.stringify(template) + JSON.stringify(template);
}

function looselyValid(rng: Rng, template: Json): string {
  const text = JSON.stringify(template);
  if (!isObject(template)) return text;
  const mode = rng.int(0, 2);
  if (mode === 0) return JSON.stringify(template, null, rng.int(1, 4));
  if (mode === 1) {
    const keys = Object.keys(template);
    for (let i = keys.length - 1; i > 0; i--) {
      const j = rng.int(0, i);
      [keys[i], keys[j]] = [keys[j] as string, keys[i] as string];
    }
    const shuffled: { [key: string]: Json } = {};
    for (const key of keys) shuffled[key] = template[key] as Json;
    return JSON.stringify(shuffled);
  }
  return `\n\t ${text} \n`;
}

/**
 * The string generators, keyed by report name. `valid` is the harness's
 * sanity check: a surface that rejects it is a broken harness or a broken
 * reader, and is reported as a violation either way.
 */
export const STRING_GENERATORS: Record<string, Generator> = {
  valid: (rng, template) => str(looselyValid(rng, template)),
  random_bytes: rng =>
    str(
      rng.bool(0.5)
        ? rng.codeUnits(rng.int(0, 300))
        : rng.bytesLatin1(rng.int(0, 300)),
    ),
  random_ascii: rng => str(rng.ascii(rng.int(0, 300))),
  truncated_json: (rng, template) =>
    str(truncated(rng, JSON.stringify(template))),
  byte_flip: (rng, template) => str(byteFlip(rng, JSON.stringify(template))),
  wrong_types: (rng, template) =>
    str(JSON.stringify(mutateTypes(rng, template))),
  future_version: (rng, template) =>
    str(JSON.stringify(futureVersion(rng, template))),
  json_scalars: rng => str(rng.pick(JSON_SCALAR_TEXTS)),
  deep_nesting: rng => str(deepNesting(rng)),
  huge_string: (rng, template) => str(hugeString(rng, template)),
  proto_keys: (rng, template) => str(protoKeys(rng, template)),
  unicode_noise: (rng, template) => str(unicodeNoise(rng, template)),
  wrapped: (rng, template) => str(wrapped(rng, template)),
  empty_whitespace: rng =>
    str(rng.pick(['', ' ', '\n', '\t', '\r\n', '\u00a0'])),
};

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function randomBytes(rng: Rng, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = rng.int(0, 255);
  return out;
}

/** Non-string column values a typed SQLite driver can return. */
export const typedValue: Generator = (rng, template) => {
  const mode = rng.int(0, 11);
  switch (mode) {
    case 0:
      return { kind: 'typed', value: null, describe: 'null' };
    case 1:
      return { kind: 'typed', value: undefined, describe: 'undefined' };
    case 2: {
      const value = rng.pick([
        0,
        1,
        -1,
        1.5,
        Number.MAX_SAFE_INTEGER,
        Number.NaN,
        Number.POSITIVE_INFINITY,
      ]);
      return { kind: 'typed', value, describe: `number:${String(value)}` };
    }
    case 3:
      return { kind: 'typed', value: rng.bool(), describe: 'boolean' };
    case 4: {
      const bytes = randomBytes(rng, rng.int(0, 64));
      return {
        kind: 'typed',
        value: bytes.buffer,
        describe: `ArrayBuffer:${hex(bytes)}`,
      };
    }
    case 5: {
      const bytes = randomBytes(rng, rng.int(0, 64));
      return {
        kind: 'typed',
        value: bytes,
        describe: `Uint8Array:${hex(bytes)}`,
      };
    }
    case 6:
      return {
        kind: 'typed',
        value: clone(template),
        describe: 'object:template-not-stringified',
      };
    case 7:
      return {
        kind: 'typed',
        value: [clone(template)],
        describe: 'array:[template]',
      };
    case 8:
      return { kind: 'typed', value: {}, describe: 'object:{}' };
    case 9:
      return {
        kind: 'typed',
        value: new Date(rng.int(0, 2_000_000_000_000)),
        describe: 'Date',
      };
    case 10: {
      const value = randomJsonValue(rng);
      return {
        kind: 'typed',
        value,
        describe: `json:${JSON.stringify(value)}`,
      };
    }
    default: {
      const value = BigInt(rng.int(-1_000_000, 1_000_000));
      return { kind: 'typed', value, describe: `bigint:${value.toString()}` };
    }
  }
};

export const STRING_GENERATOR_NAMES: readonly string[] =
  Object.keys(STRING_GENERATORS);

export const ALL_GENERATORS: Record<string, Generator> = {
  ...STRING_GENERATORS,
  typed_value: typedValue,
};

export interface SerializedInput {
  kind: 'string' | 'typed';
  length: number;
  sha256: string;
  preview: string;
  /** Present when the whole input fits the report budget (replayable
   * verbatim); otherwise replay via the recorded seed. */
  full?: string;
  describe?: string;
}

const FULL_INPUT_BUDGET = 8 * 1024;

export function serializeInput(input: GeneratedInput): SerializedInput {
  if (input.kind === 'string') {
    const text = input.value;
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    const preview = JSON.stringify(
      text.length > 240 ? `${text.slice(0, 240)}…` : text,
    );
    return {
      kind: 'string',
      length: text.length,
      sha256,
      preview,
      ...(text.length <= FULL_INPUT_BUDGET ? { full: text } : {}),
    };
  }
  const sha256 = createHash('sha256')
    .update(input.describe, 'utf8')
    .digest('hex');
  return {
    kind: 'typed',
    length: input.describe.length,
    sha256,
    preview: input.describe.slice(0, 240),
    describe: input.describe,
  };
}
