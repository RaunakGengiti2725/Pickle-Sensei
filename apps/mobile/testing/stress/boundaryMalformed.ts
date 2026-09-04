/**
 * boundary-malformed stress harness — shared plumbing for the seeded
 * malformed-input campaigns under `__tests__/stress/`.
 *
 * Every iteration is replayable from `(campaign, seed)`: the seed drives a
 * mulberry32 PRNG that picks the strategy, the mutated paths and the poison
 * values, so `STRESS_REPLAY=<campaign>:<seed> npx jest <suite>` re-executes
 * exactly one recorded input. Scale is `STRESS_ITER` (iterations per
 * campaign; small default so the suites stay cheap in CI) and the base seed
 * is `STRESS_SEED`. Each campaign appends a JSON table (seed → outcome) to
 * `artifacts/stress/mod-capture-boundary-malformed/<STRESS_RUN_ID>/`.
 *
 * Node built-ins: the mobile tsconfig excludes node typings, so the shims
 * stay local (same convention as testing/xcBehavioral/evidence.ts).
 */
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export const STRESS_ITER = Math.max(
  1,
  Number(process.env['STRESS_ITER'] ?? '60') || 60,
);
export const STRESS_SEED = Number(process.env['STRESS_SEED'] ?? '1590069508');
const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';
const REPLAY = process.env['STRESS_REPLAY'];

/** mulberry32 — deterministic, replayable from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/** Iteration seeds for a campaign (or the single replayed seed). */
export function campaignSeeds(campaign: string): number[] {
  if (REPLAY !== undefined && REPLAY !== '') {
    const [name, seed] = REPLAY.split(':');
    if (name !== campaign) return [];
    return [Number(seed) >>> 0];
  }
  const base = (fnv1a(campaign) ^ (STRESS_SEED >>> 0)) >>> 0;
  const seeds: number[] = [];
  for (let i = 0; i < STRESS_ITER; i += 1) {
    seeds.push((base + Math.imul(i + 1, 0x9e3779b1)) >>> 0);
  }
  return seeds;
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined && items.length === 0) {
    throw new Error('pick() from an empty pool');
  }
  return item as T;
}

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

// ---------------------------------------------------------------------------
// Value pools. Each entry has a stable `id` so the JSON table stays readable
// (a 64KB payload is recorded as its id, not its bytes) and a `kind` the
// oracles use to decide whether acceptance is ever legitimate.
// ---------------------------------------------------------------------------

export type PoolKind =
  | 'poison_number' // NaN / ±Infinity / bigint / boolean / symbol / function…
  | 'boundary_number' // -0, 0, negatives, 2^53±1, denormals, 1e308…
  | 'poison_string' // '', whitespace, null bytes, 'NaN', '[object Object]'
  | 'oversize_string' // ≥ 64KB / 65_537 code points / grapheme clusters
  | 'traversal_string' // ../, %2e%2e, file:///../, file:\0
  | 'unicode_string' // NFC/NFD pairs, RTL override, ZWJ sequences
  | 'loose_iso' // Date.parse-able but not an ISO-8601 UTC instant
  | 'strict_iso'
  | 'container' // [], {}, [[]], {a:{}}, sparse arrays, Object.create(null)
  | 'nullish'
  | 'future_schema';

export interface PoolValue {
  id: string;
  kind: PoolKind;
  value: unknown;
}

const BIG = 'A'.repeat(65_536);
const BIG_MULTIBYTE = '\u{1F3D3}'.repeat(65_537); // 4-byte code points
const BIG_GRAPHEMES = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'.repeat(20_000);

export const POISON_NUMBERS: readonly PoolValue[] = [
  { id: 'NaN', kind: 'poison_number', value: NaN },
  { id: '+Infinity', kind: 'poison_number', value: Infinity },
  { id: '-Infinity', kind: 'poison_number', value: -Infinity },
  { id: 'bigint:1n', kind: 'poison_number', value: BigInt(1) },
  { id: 'bool:true', kind: 'poison_number', value: true },
  { id: 'bool:false', kind: 'poison_number', value: false },
  { id: 'symbol', kind: 'poison_number', value: Symbol('poison') },
  { id: 'function', kind: 'poison_number', value: () => 1 },
  { id: 'numeric-string:"1"', kind: 'poison_number', value: '1' },
  { id: 'numeric-string:"720"', kind: 'poison_number', value: '720' },
  { id: 'Number-object', kind: 'poison_number', value: new Number(1) },
  { id: 'Date-object', kind: 'poison_number', value: new Date(0) },
];

export const BOUNDARY_NUMBERS: readonly PoolValue[] = [
  { id: '-0', kind: 'boundary_number', value: -0 },
  { id: '0', kind: 'boundary_number', value: 0 },
  { id: '-1', kind: 'boundary_number', value: -1 },
  { id: '1', kind: 'boundary_number', value: 1 },
  { id: '0.5', kind: 'boundary_number', value: 0.5 },
  { id: '1.0000001', kind: 'boundary_number', value: 1.0000001 },
  { id: '5e-324', kind: 'boundary_number', value: 5e-324 },
  { id: '1e-9', kind: 'boundary_number', value: 1e-9 },
  { id: '0.1+0.2', kind: 'boundary_number', value: 0.1 + 0.2 },
  { id: '2^31', kind: 'boundary_number', value: 2 ** 31 },
  { id: '2^32', kind: 'boundary_number', value: 2 ** 32 },
  { id: 'MAX_SAFE', kind: 'boundary_number', value: Number.MAX_SAFE_INTEGER },
  {
    id: 'MAX_SAFE+1',
    kind: 'boundary_number',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
  { id: '2^53+2', kind: 'boundary_number', value: 2 ** 53 + 2 },
  { id: '1e308', kind: 'boundary_number', value: 1e308 },
  { id: 'MAX_VALUE', kind: 'boundary_number', value: Number.MAX_VALUE },
  { id: '-MAX_VALUE', kind: 'boundary_number', value: -Number.MAX_VALUE },
  { id: 'MIN_VALUE', kind: 'boundary_number', value: Number.MIN_VALUE },
  { id: '59.94', kind: 'boundary_number', value: 59.94 },
  { id: '239.76', kind: 'boundary_number', value: 239.76 },
  { id: '1e6', kind: 'boundary_number', value: 1e6 },
];

export const POISON_STRINGS: readonly PoolValue[] = [
  { id: 'empty', kind: 'poison_string', value: '' },
  { id: 'space', kind: 'poison_string', value: ' ' },
  { id: 'whitespace', kind: 'poison_string', value: '\t\n\r ' },
  { id: 'nul', kind: 'poison_string', value: '\u0000' },
  { id: 'nul-padded', kind: 'poison_string', value: 'x\u0000y' },
  { id: '"NaN"', kind: 'poison_string', value: 'NaN' },
  { id: '"undefined"', kind: 'poison_string', value: 'undefined' },
  { id: '"null"', kind: 'poison_string', value: 'null' },
  { id: '"[object Object]"', kind: 'poison_string', value: '[object Object]' },
  { id: 'nbsp', kind: 'poison_string', value: '\u00a0' },
  { id: 'zero-width', kind: 'poison_string', value: '\u200b' },
];

export const OVERSIZE_STRINGS: readonly PoolValue[] = [
  { id: 'ascii-65536', kind: 'oversize_string', value: BIG },
  { id: 'codepoints-65537x4B', kind: 'oversize_string', value: BIG_MULTIBYTE },
  { id: 'graphemes-20000-zwj', kind: 'oversize_string', value: BIG_GRAPHEMES },
  { id: 'file-uri-65536', kind: 'oversize_string', value: `file:///${BIG}` },
];

export const TRAVERSAL_STRINGS: readonly PoolValue[] = [
  { id: 'dotdot', kind: 'traversal_string', value: '../../etc/passwd' },
  {
    id: 'file-dotdot',
    kind: 'traversal_string',
    value: 'file:///../../../etc/passwd',
  },
  {
    id: 'file-encoded-dotdot',
    kind: 'traversal_string',
    value: 'file:///%2e%2e/%2e%2e/private/var/mobile',
  },
  { id: 'file-nul', kind: 'traversal_string', value: 'file:///a\u0000.mov' },
  { id: 'file-bare', kind: 'traversal_string', value: 'file:' },
  { id: 'FILE-upper', kind: 'traversal_string', value: 'FILE:///clip.mov' },
  { id: 'http', kind: 'traversal_string', value: 'http://evil.example/x.mov' },
  { id: 'file-space', kind: 'traversal_string', value: ' file:///clip.mov' },
  {
    id: 'file-backslash',
    kind: 'traversal_string',
    value: 'file:\\..\\..\\clip.mov',
  },
  { id: 'slug-slash', kind: 'traversal_string', value: 'dink/../serve' },
];

export const UNICODE_STRINGS: readonly PoolValue[] = [
  { id: 'nfc-e-acute', kind: 'unicode_string', value: '\u00e9' },
  { id: 'nfd-e-acute', kind: 'unicode_string', value: 'e\u0301' },
  { id: 'nfc-angstrom', kind: 'unicode_string', value: '\u212b' },
  { id: 'nfd-angstrom', kind: 'unicode_string', value: 'A\u030a' },
  { id: 'rtl-override', kind: 'unicode_string', value: '\u202eevil\u202c' },
  {
    id: 'zwj-family',
    kind: 'unicode_string',
    value: '\u{1F468}\u200D\u{1F469}',
  },
  { id: 'lone-surrogate', kind: 'unicode_string', value: '\ud800' },
  { id: 'bom', kind: 'unicode_string', value: '\ufeffdink' },
  {
    id: 'fullwidth-dink',
    kind: 'unicode_string',
    value: '\uff44\uff49\uff4e\uff4b',
  },
];

export const LOOSE_ISO: readonly PoolValue[] = [
  { id: 'iso-no-Z', kind: 'loose_iso', value: '2026-08-27T18:00:00.000' },
  { id: 'iso-offset', kind: 'loose_iso', value: '2026-08-27T18:00:00+02:00' },
  { id: 'iso-date-only', kind: 'loose_iso', value: '2026-08-27' },
  { id: 'us-date', kind: 'loose_iso', value: '12/31/2026' },
  { id: 'year-only', kind: 'loose_iso', value: '1' },
  { id: 'rfc2822', kind: 'loose_iso', value: 'Thu, 27 Aug 2026 18:00:00 GMT' },
  { id: 'year-2100', kind: 'loose_iso', value: '2100-01-01T00:00:00.000Z' },
  { id: 'year-1999', kind: 'loose_iso', value: '1999-12-31T23:59:59.000Z' },
  {
    id: 'feb-30-rollover',
    kind: 'loose_iso',
    value: '2026-02-30T00:00:00.000Z',
  },
  {
    id: 'iso-lowercase-t',
    kind: 'loose_iso',
    value: '2026-08-27t18:00:00.000z',
  },
  {
    id: 'iso-10-frac',
    kind: 'loose_iso',
    value: '2026-08-27T18:00:00.0000000000Z',
  },
];

export const STRICT_ISO: readonly PoolValue[] = [
  { id: 'iso-ms', kind: 'strict_iso', value: '2026-08-27T18:00:00.000Z' },
  { id: 'iso-sec', kind: 'strict_iso', value: '2026-08-27T18:00:00Z' },
  { id: 'iso-us', kind: 'strict_iso', value: '2026-08-27T18:00:00.123456Z' },
];

export const CONTAINERS: readonly PoolValue[] = [
  { id: '[]', kind: 'container', value: [] },
  { id: '{}', kind: 'container', value: {} },
  { id: '[[]]', kind: 'container', value: [[]] },
  { id: '{a:{}}', kind: 'container', value: { a: {} } },
  { id: 'sparse[3]', kind: 'container', value: new Array(3) },
  { id: 'null-proto', kind: 'container', value: Object.create(null) },
  { id: 'Map', kind: 'container', value: new Map() },
  { id: 'Set', kind: 'container', value: new Set() },
  { id: 'RegExp', kind: 'container', value: /x/ },
  { id: 'Uint8Array', kind: 'container', value: new Uint8Array(4) },
  { id: 'Promise', kind: 'container', value: Promise.resolve(1) },
];

export const NULLISH: readonly PoolValue[] = [
  { id: 'null', kind: 'nullish', value: null },
  { id: 'undefined', kind: 'nullish', value: undefined },
];

export const FUTURE_SCHEMA: readonly PoolValue[] = [
  { id: 'schema:2', kind: 'future_schema', value: 2 },
  { id: 'schema:"1"', kind: 'future_schema', value: '1' },
  { id: 'schema:1.5', kind: 'future_schema', value: 1.5 },
  { id: 'schema:0', kind: 'future_schema', value: 0 },
  { id: 'schema:-1', kind: 'future_schema', value: -1 },
  { id: 'schema:1e0', kind: 'future_schema', value: 1 },
  {
    id: 'schema:v2-string',
    kind: 'future_schema',
    value: 'pickle.device-bench.v2',
  },
];

export const ALL_POOL: readonly PoolValue[] = [
  ...POISON_NUMBERS,
  ...BOUNDARY_NUMBERS,
  ...POISON_STRINGS,
  ...OVERSIZE_STRINGS,
  ...TRAVERSAL_STRINGS,
  ...UNICODE_STRINGS,
  ...LOOSE_ISO,
  ...STRICT_ISO,
  ...CONTAINERS,
  ...NULLISH,
  ...FUTURE_SCHEMA,
];

/** Roots that are not plain records — the validator must reject every one. */
export const GARBAGE_ROOTS: readonly PoolValue[] = [
  ...NULLISH,
  ...POISON_NUMBERS,
  ...BOUNDARY_NUMBERS.slice(0, 4),
  ...POISON_STRINGS.slice(0, 3),
  ...CONTAINERS,
  {
    id: 'json-string-of-clip',
    kind: 'poison_string',
    value: '{"uri":"file:///x"}',
  },
];

// ---------------------------------------------------------------------------
// Deep paths + structural clones. Fixtures are plain JSON, so structured
// cloning through JSON is lossless and yields fresh objects per iteration.
// ---------------------------------------------------------------------------

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function leafPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    const out: string[] = [];
    value.forEach((item, index) => {
      out.push(...leafPaths(item, `${prefix}[${index}]`));
    });
    return out.length > 0 ? out : [prefix];
  }
  if (typeof value === 'object' && value !== null) {
    const out: string[] = [];
    for (const key of Object.keys(value)) {
      out.push(
        ...leafPaths(
          (value as Record<string, unknown>)[key],
          prefix === '' ? key : `${prefix}.${key}`,
        ),
      );
    }
    return out.length > 0 ? out : [prefix];
  }
  return [prefix];
}

/** Every path (leaf AND container) so mutations can also replace subtrees. */
export function allPaths(value: unknown, prefix = ''): string[] {
  const out: string[] = [];
  if (prefix !== '') out.push(prefix);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      out.push(...allPaths(item, `${prefix}[${index}]`));
    });
  } else if (typeof value === 'object' && value !== null) {
    for (const key of Object.keys(value)) {
      out.push(
        ...allPaths(
          (value as Record<string, unknown>)[key],
          prefix === '' ? key : `${prefix}.${key}`,
        ),
      );
    }
  }
  return out;
}

function segments(path: string): Array<string | number> {
  const parts: Array<string | number> = [];
  for (const match of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (match[2] !== undefined) parts.push(Number(match[2]));
    else if (match[1] !== undefined) parts.push(match[1]);
  }
  return parts;
}

export function getAt(root: unknown, path: string): unknown {
  let cursor: unknown = root;
  for (const seg of segments(path)) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Record<string | number, unknown>)[seg];
  }
  return cursor;
}

/** Sets (or deletes, when `value` is the DELETE sentinel) a deep path. */
export const DELETE = Symbol('delete');

export function setAt(root: unknown, path: string, value: unknown): void {
  const parts = segments(path);
  const last = parts.pop();
  if (last === undefined) return;
  let cursor: unknown = root;
  for (const seg of parts) {
    if (typeof cursor !== 'object' || cursor === null) return;
    cursor = (cursor as Record<string | number, unknown>)[seg];
  }
  if (typeof cursor !== 'object' || cursor === null) return;
  const target = cursor as Record<string | number, unknown>;
  if (value === DELETE) {
    delete target[last];
  } else {
    target[last] = value;
  }
}

// ---------------------------------------------------------------------------
// Prototype-pollution sentinels.
// ---------------------------------------------------------------------------

const PROTO_KEYS = ['polluted', 'uri', 'captureMode', 'schemaVersion'];

export function prototypeSnapshot(): string {
  const own = Object.getOwnPropertyNames(Object.prototype).sort();
  const arr = Object.getOwnPropertyNames(Array.prototype).sort();
  const leaked = PROTO_KEYS.filter(key => key in {}).join(',');
  return JSON.stringify({ own, arr, leaked });
}

/** Payload shapes that try to reach the prototype chain. */
export function pollutionPayloads(base: Record<string, unknown>): PoolValue[] {
  const viaJson = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}',
  ) as Record<string, unknown>;
  const inherited = Object.create(base) as Record<string, unknown>;
  // JSON text with an OWN "__proto__" key first — JSON.parse never walks
  // the prototype chain, so this is a plain data key, not a setter.
  const withProtoKey = JSON.parse(
    `{"__proto__":{"polluted":true},${JSON.stringify(base).slice(1)}`,
  ) as Record<string, unknown>;
  const mergedJson = JSON.parse(
    `${JSON.stringify(base).slice(0, -1)},"__proto__":{"polluted":true},"prototype":{"x":1},"constructor":"x"}`,
  ) as Record<string, unknown>;
  return [
    { id: 'proto:json-only', kind: 'container', value: viaJson },
    { id: 'proto:inherited-fields', kind: 'container', value: inherited },
    { id: 'proto:json-proto-key', kind: 'container', value: withProtoKey },
    { id: 'proto:json-merged', kind: 'container', value: mergedJson },
    {
      id: 'proto:literal-proto-setter',
      kind: 'container',
      value: (() => {
        const o: Record<string, unknown> = { ...base };
        Object.setPrototypeOf(o, { polluted: true });
        return o;
      })(),
    },
    {
      id: 'proto:null-prototype-copy',
      kind: 'container',
      value: Object.assign(Object.create(null), base) as Record<
        string,
        unknown
      >,
    },
  ];
}

// ---------------------------------------------------------------------------
// Truncated / corrupted JSON transport.
// ---------------------------------------------------------------------------

export interface CorruptedJson {
  id: string;
  parsed: unknown;
  parseError: string | null;
}

export function corruptJson(random: () => number, doc: unknown): CorruptedJson {
  const text = JSON.stringify(doc);
  const mode = pick(random, ['truncate', 'drop-char', 'swap-token', 'dup-key']);
  let mutated: string;
  let id: string;
  if (mode === 'truncate') {
    const at = randomInt(random, 0, text.length - 1);
    mutated = text.slice(0, at);
    id = `truncate@${at}`;
  } else if (mode === 'drop-char') {
    const at = randomInt(random, 0, text.length - 1);
    mutated = text.slice(0, at) + text.slice(at + 1);
    id = `drop@${at}`;
  } else if (mode === 'swap-token') {
    const replacements: Array<[RegExp, string]> = [
      [/:(\d+(\.\d+)?)/, ':"$1"'],
      [/:(\d+(\.\d+)?)/, ':-$1'],
      [/:(\d+(\.\d+)?)/, ':$1e400'],
      [/:(\d+(\.\d+)?)/, ':null'],
      [/:"([^"]*)"/, ':""'],
      [/:"([^"]*)"/, ':["$1"]'],
      [/:true|:false/, ':"true"'],
      [/:\{/, ':['],
    ];
    const [re, rep] = pick(random, replacements);
    mutated = text.replace(re, rep);
    id = `swap:${re.source}->${rep}`;
  } else {
    const key = pick(random, Object.keys(doc as Record<string, unknown>));
    mutated = `${text.slice(0, -1)},"${key}":null}`;
    id = `dup-key:${key}`;
  }
  try {
    return { id, parsed: JSON.parse(mutated) as unknown, parseError: null };
  } catch (error) {
    return {
      id,
      parsed: undefined,
      parseError: error instanceof Error ? error.constructor.name : 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// Outcome table.
// ---------------------------------------------------------------------------

export type Verdict = 'HELD' | 'BROKEN' | 'OBSERVATION';

export interface OutcomeRow {
  campaign: string;
  seed: number;
  strategy: string;
  input: string;
  outcome: string;
  verdict: Verdict;
  detail?: string;
}

export class OutcomeTable {
  readonly rows: OutcomeRow[] = [];

  constructor(readonly campaign: string) {}

  record(row: Omit<OutcomeRow, 'campaign'>): void {
    this.rows.push({ campaign: this.campaign, ...row });
  }

  broken(): OutcomeRow[] {
    return this.rows.filter(row => row.verdict === 'BROKEN');
  }

  observations(): OutcomeRow[] {
    return this.rows.filter(row => row.verdict === 'OBSERVATION');
  }

  summary(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const row of this.rows) {
      const key = `${row.verdict}:${row.outcome}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** Writes `<artifactDir>/<campaign>.json` and returns the path. */
  flush(): string {
    const dir = artifactDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${this.campaign}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          campaign: this.campaign,
          runId: RUN_ID,
          baseSeed: STRESS_SEED,
          iterations: this.rows.length,
          summary: this.summary(),
          broken: this.broken().map(row => row.seed),
          rows: this.rows,
        },
        null,
        1,
      ),
    );
    return file;
  }
}

export function artifactDir(): string {
  // apps/mobile/testing/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(
    root,
    'artifacts',
    'stress',
    'mod-capture-boundary-malformed',
    RUN_ID,
  );
}

export function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 40
      ? `string(len=${value.length})`
      : JSON.stringify(value);
  }
  if (typeof value === 'number')
    return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return 'symbol';
  if (typeof value === 'function') return 'function';
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `array(len=${value.length})`;
  return `object(${Object.keys(value as object).length} keys)`;
}

export function errorName(error: unknown): string {
  if (error instanceof Error)
    return `${error.constructor.name}:${error.message}`;
  return `non-error:${describeValue(error)}`;
}

/** Every number reachable from `value` is finite (no NaN/±Infinity leaked). */
export function allNumbersFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allNumbersFinite);
  if (typeof value === 'object' && value !== null) {
    return Object.values(value as Record<string, unknown>).every(
      allNumbersFinite,
    );
  }
  return true;
}

/** True when JSON serialization is lossless for the accepted object — the
 * clip is persisted as JSON, so anything that does not survive the round
 * trip (functions, symbols, bigint throws, sparse holes, inherited fields)
 * would be a silently different record on disk than in memory. */
export function jsonStable(value: unknown): { stable: boolean; why: string } {
  try {
    const text = JSON.stringify(value);
    if (text === undefined)
      return { stable: false, why: 'stringify→undefined' };
    const back = JSON.parse(text) as unknown;
    const again = JSON.stringify(back);
    if (again !== text) return { stable: false, why: 'round-trip drift' };
    return {
      stable: true,
      why: text.length > 0 ? `json(len=${text.length})` : '',
    };
  } catch (error) {
    return { stable: false, why: errorName(error) };
  }
}
