/**
 * Deterministic input pools + generators for the `mod-repository`
 * boundary/malformed stress lens (data/repository.ts + data/accountScope.ts).
 *
 * Every generator is a pure function of a 32-bit seed (mulberry32 via
 * `makePrng`), so any row in the emitted JSON table replays from
 * `<family>:<seed>` alone. Nothing here is random at import time and nothing
 * here touches production code — the suite under __tests__/stress/ drives
 * the real repository against a real `node:sqlite` database opened through
 * the production migrations.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { makePrng, pick } from '../lifecycle-persistence/seeds';
import { fs, nodeProcess, path } from '../lifecycle-persistence/nodeShim';

declare const __dirname: string;

export const STRESS_ITER_DEFAULT = 300;

/** Total scenario budget: `STRESS_ITER` (default small so the suite stays fast). */
export function stressIterations(): number {
  const raw = nodeProcess.env['STRESS_ITER'];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : STRESS_ITER_DEFAULT;
}

/** `STRESS_ONLY=<family>:<seed>` replays exactly one scenario. */
export function replayTarget(): { family: string; seed: number } | null {
  const raw = nodeProcess.env['STRESS_ONLY'];
  if (!raw) return null;
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const seed = Number(raw.slice(idx + 1));
  if (!Number.isSafeInteger(seed)) return null;
  return { family: raw.slice(0, idx), seed };
}

export function artifactDir(): string {
  const configured = nodeProcess.env['STRESS_ARTIFACT_DIR'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/stress/mod-repository-boundary-malformed',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJsonArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return file;
}

// ---------------------------------------------------------------------------
// Scenario rows

export interface StressRow {
  family: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  ok: boolean;
  failed: string[];
  durationMs: number;
}

export function finishRow(
  family: string,
  seed: number,
  startedAt: number,
  inputs: Record<string, unknown>,
  observed: Record<string, unknown>,
  invariants: Record<string, boolean>,
): StressRow {
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    family,
    seed,
    inputs: compactForJson(inputs) as Record<string, unknown>,
    observed: compactForJson(observed) as Record<string, unknown>,
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - startedAt,
  };
}

export function summarize(rows: StressRow[]): Record<string, unknown> {
  const failed = rows.filter(row => !row.ok);
  const byFamily: Record<string, { scenarios: number; failed: number }> = {};
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  for (const row of rows) {
    const fam = (byFamily[row.family] ??= { scenarios: 0, failed: 0 });
    fam.scenarios += 1;
    if (!row.ok) fam.failed += 1;
    for (const [name, held] of Object.entries(row.invariants)) {
      const key = `${row.family}.${name}`;
      const slot = (byInvariant[key] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
  }
  return {
    scenarios: rows.length,
    passed: rows.length - failed.length,
    failed: failed.length,
    byFamily,
    byInvariant,
    failedScenarios: failed.map(row => ({
      replay: `${row.family}:${row.seed}`,
      failed: row.failed,
      inputs: row.inputs,
      observed: row.observed,
    })),
  };
}

/**
 * JSON-safe, size-bounded view of arbitrary runtime values (the row table must
 * stay readable: a 1 MiB string becomes `<string len=1048576 sha=…>`).
 */
export function compactForJson(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 160
      ? `<string len=${value.length} head=${JSON.stringify(value.slice(0, 40))} fnv=${fnv1a(value)}>`
      : value;
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '<NaN>';
    if (value === Infinity) return '<Infinity>';
    if (value === -Infinity) return '<-Infinity>';
    if (value === 0 && 1 / value < 0) return '<-0>';
    return value;
  }
  if (typeof value === 'bigint') return `<bigint ${value.toString()}>`;
  if (typeof value === 'symbol') return `<symbol ${value.description ?? ''}>`;
  if (typeof value === 'function') return '<function>';
  if (typeof value === 'undefined') return '<undefined>';
  if (value === null) return null;
  if (value instanceof Error) {
    return { error: value.constructor.name, message: value.message };
  }
  if (value instanceof Date) return `<Date ${value.toISOString()}>`;
  if (depth > 6) return '<depth>';
  if (Array.isArray(value)) {
    const head = value
      .slice(0, 12)
      .map(item => compactForJson(item, depth + 1));
    return value.length > 12 ? [...head, `<+${value.length - 12} more>`] : head;
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>);
    for (const key of keys.slice(0, 40)) {
      out[key] = compactForJson(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    }
    if (keys.length > 40) out['<more>'] = keys.length - 40;
    return out;
  }
  return String(value);
}

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Owners

export const OWNER_A = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const OWNER_B = '0b4d1f9e-3c2a-4b8e-9f1d-2a6c7e8b9d01';
export const OWNER_C = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Strict oracle for the account-scope UUID rule (ASCII only, no flags). */
export const STRICT_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function uuidFromSeed(rng: () => number): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const part = (n: number) => Array.from({ length: n }, hex).join('');
  const version = pick(rng, ['1', '2', '3', '4', '5', '6', '7', '8']);
  const variant = pick(rng, ['8', '9', 'a', 'b']);
  return `${part(8)}-${part(4)}-${version}${part(3)}-${variant}${part(3)}-${part(12)}`;
}

// ---------------------------------------------------------------------------
// Runtime (wrong-type / boundary) values that can reach a TS boundary at
// runtime. Keyed by name so a row's `inputs` stays readable.

const CYCLIC: Record<string, unknown> = { kind: 'cyclic' };
CYCLIC['self'] = CYCLIC;

export const RUNTIME_VALUES: Record<string, unknown> = {
  undefined,
  null: null,
  nan: NaN,
  'pos-infinity': Infinity,
  'neg-infinity': -Infinity,
  'neg-zero': -0,
  zero: 0,
  one: 1,
  'neg-one': -1,
  'max-safe': Number.MAX_SAFE_INTEGER,
  'max-safe-plus-one': 2 ** 53 + 1,
  'max-value': Number.MAX_VALUE,
  'min-value': Number.MIN_VALUE,
  half: 0.5,
  'float-noise': 0.1 + 0.2,
  'neg-float': -3.75,
  'bool-true': true,
  'bool-false': false,
  'empty-string': '',
  whitespace: ' \t\n\r',
  'nbsp-zwsp': '\u00a0\u200b\u2003',
  'nul-only': '\u0000',
  'nul-embedded': 'shot\u0000-01',
  'numeric-string': '42',
  'json-string': '{"id":"x"}',
  'string-64k': 'a'.repeat(64 * 1024 + 1),
  'string-256k-multibyte': '\u{1F3D3}'.repeat(64 * 1024 + 1),
  'string-graphemes':
    '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(2048),
  'path-traversal': '../../../etc/passwd',
  'path-traversal-encoded': '..%2F..%2F..%2Fetc%2Fpasswd',
  'file-uri-traversal': 'file:///private/../../etc/passwd',
  'sql-injection': "'; DROP TABLE local_shot; --",
  'sql-injection-union': "x' UNION SELECT payload FROM local_shot --",
  'nfc-e-acute': '\u00e9',
  'nfd-e-acute': 'e\u0301',
  'nfc-hangul': '\ud55c',
  'nfd-hangul': '\u1112\u1161\u11ab',
  'rtl-override': '\u202e' + 'abc' + '\u202c',
  'bom-prefixed': '\ufeffshot-1',
  'lone-surrogate': '\ud83d',
  'fullwidth-digits': '\uff14\uff12',
  bigint: BigInt(1),
  symbol: Symbol('shot'),
  function: () => 1,
  date: new Date(0),
  'empty-array': [],
  'empty-object': {},
  'nested-empty': [[[]], {}],
  'proto-pollution-parsed': JSON.parse('{"__proto__":{"polluted":true}}'),
  'constructor-pollution-parsed': JSON.parse(
    '{"constructor":{"prototype":{"polluted":true}}}',
  ),
  'object-to-string-uuid': {
    toString: () => OWNER_A,
  },
  cyclic: CYCLIC,
  'array-of-uuid': [OWNER_A],
  'future-schema-marker': { schemaVersion: 99, id: 'future' },
};

export const RUNTIME_VALUE_NAMES = Object.keys(RUNTIME_VALUES);

// ---------------------------------------------------------------------------
// Raw persisted payload texts (what SQLite may hand back after corruption).

export const PAYLOAD_TEXTS: Record<string, string> = {
  empty: '',
  whitespace: '   \n',
  'json-null': 'null',
  'json-true': 'true',
  'json-number': '42',
  'json-negative-zero': '-0',
  'json-huge-exponent': '1e999',
  'json-string': '"payload"',
  'json-empty-array': '[]',
  'json-empty-object': '{}',
  'truncated-array': '[1,2',
  'truncated-object': '{"id":"a","source":"real"',
  'truncated-mid-string': '{"id":"a","sour',
  'trailing-comma': '{"id":"a",}',
  'single-quotes': "{'id':'a'}",
  'js-undefined': 'undefined',
  'js-nan': 'NaN',
  'bom-prefixed': '\ufeff{"id":"a","source":"real"}',
  'nul-prefixed': '\u0000{"id":"a"}',
  'nul-inside-string': '{"id":"a\u0000b","source":"real"}',
  'proto-pollution': '{"__proto__":{"polluted":true},"source":"real"}',
  'constructor-pollution':
    '{"constructor":{"prototype":{"polluted":true}},"source":"real"}',
  'deep-nesting-5k': '['.repeat(5000) + ']'.repeat(5000),
  'deep-nesting-100k': '['.repeat(100_000) + ']'.repeat(100_000),
  'huge-string-field': `{"id":"${'x'.repeat(64 * 1024 + 1)}","source":"real"}`,
  'duplicate-keys': '{"id":"a","id":"b","source":"real","source":"fake"}',
  'future-schema': '{"schemaVersion":99,"id":"future","source":"real"}',
  'source-fake': '{"id":"a","source":"fake"}',
  'source-number': '{"id":"a","source":1}',
  'not-json': 'definitely not json',
  html: '<script>alert(1)</script>',
  sql: "'; DROP TABLE local_shot; --",
  'lone-surrogate-escape': '{"id":"\\ud83d","source":"real"}',
  'unicode-escape-nul': '{"id":"\\u0000","source":"real"}',
  'array-with-real': '[{"id":"a","source":"real"}]',
  'minimal-real': '{"source":"real"}',
};

export const PAYLOAD_TEXT_NAMES = Object.keys(PAYLOAD_TEXTS);

// ---------------------------------------------------------------------------
// A valid ShotAnalysis and seeded field mutations of it.

export function validAnalysis(
  id: string,
  capturedAtIso: string,
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'dink',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 400, endMs: 900 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: 72,
        confidence: 0.9,
        band: 'green',
        direction: 'none',
        severity: 0.1,
        applicable: true,
      },
      {
        key: 'face_wrist_stability',
        score: null,
        confidence: 0.2,
        band: 'unscored',
        direction: 'none',
        severity: 0,
        applicable: false,
      },
    ],
    overallScore: 7.2,
    analysisConfidence: 0.86,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'contact_position_late',
      severity: 0.4,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '1.0.0',
      modelBundleVersion: 'bundle-v1',
      poseModelVersion: 'pose-v1',
      paddleModelVersion: 'paddle-v1',
      strokeDetectorVersion: 'stroke-v1',
      phaseModelVersion: 'phase-v1',
      scoringModelVersion: 'score-v1',
      shotConfigVersion: 'shots-v1',
    },
    source: 'real',
    ...overrides,
  };
}

/** Field paths a corrupt/hostile writer could disturb. */
export const ANALYSIS_FIELD_PATHS: readonly string[] = [
  'id',
  'sessionId',
  'shotType',
  'capturedAtIso',
  'overallScore',
  'analysisConfidence',
  'resultKind',
  'source',
  'guidance',
  'checkpoints',
  'checkpoints.0',
  'checkpoints.0.key',
  'checkpoints.0.score',
  'checkpoints.0.applicable',
  'checkpoints.1.score',
  'priorityFix',
  'priorityFix.checkpoint',
  'versionVector',
  'versionVector.scoringModelVersion',
  'versionVector.shotConfigVersion',
  'timestamps',
  'timestamps.contactMs',
  'phases',
  'measurements',
  'schemaVersion',
  '__proto__',
  'constructor',
  'extraUnknownField',
];

export function setPath(
  target: Record<string, unknown>,
  dotted: string,
  value: unknown,
): void {
  const parts = dotted.split('.');
  let cursor: unknown = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cursor === null || typeof cursor !== 'object') return;
    cursor = (cursor as Record<string, unknown>)[parts[i] as string];
  }
  if (cursor === null || typeof cursor !== 'object') return;
  const last = parts[parts.length - 1] as string;
  Object.defineProperty(cursor, last, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

export function deleteAtPath(
  target: Record<string, unknown>,
  dotted: string,
): void {
  const parts = dotted.split('.');
  let cursor: unknown = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cursor === null || typeof cursor !== 'object') return;
    cursor = (cursor as Record<string, unknown>)[parts[i] as string];
  }
  if (cursor === null || typeof cursor !== 'object') return;
  delete (cursor as Record<string, unknown>)[parts[parts.length - 1] as string];
}

export interface AnalysisMutation {
  kind: 'set' | 'delete';
  path: string;
  valueName?: string;
}

export function mutateAnalysis(
  rng: () => number,
  base: ShotAnalysis,
  count: number,
): { analysis: ShotAnalysis; mutations: AnalysisMutation[] } {
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  const mutations: AnalysisMutation[] = [];
  for (let i = 0; i < count; i += 1) {
    const fieldPath = pick(rng, ANALYSIS_FIELD_PATHS);
    if (rng() < 0.15) {
      deleteAtPath(clone, fieldPath);
      mutations.push({ kind: 'delete', path: fieldPath });
    } else {
      const valueName = pick(rng, RUNTIME_VALUE_NAMES);
      setPath(clone, fieldPath, RUNTIME_VALUES[valueName]);
      mutations.push({ kind: 'set', path: fieldPath, valueName });
    }
  }
  return { analysis: clone as unknown as ShotAnalysis, mutations };
}

/**
 * Serializes like JSON.stringify but lets NaN/±Infinity/-0/2^53+1 leak as raw
 * tokens (what a non-JS writer or a hand-edited row could contain).
 */
export function looseStringify(value: unknown): string {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Infinity) return '1e999';
    if (value === -Infinity) return '-1e999';
    if (value === 0 && 1 / value < 0) return '-0';
    return String(value);
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'undefined' || typeof value === 'function') {
    return 'undefined';
  }
  if (typeof value === 'symbol') return '"<symbol>"';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map(item => looseStringify(item)).join(',')}]`;
  }
  const seen = new Set<unknown>();
  const walk = (obj: Record<string, unknown>): string => {
    if (seen.has(obj)) return '"<cycle>"';
    seen.add(obj);
    const body = Object.keys(obj)
      .map(key => {
        const item = obj[key];
        const encoded =
          item !== null && typeof item === 'object' && !Array.isArray(item)
            ? item instanceof Date
              ? JSON.stringify(item.toISOString())
              : walk(item as Record<string, unknown>)
            : looseStringify(item);
        return `${JSON.stringify(key)}:${encoded}`;
      })
      .join(',');
    return `{${body}}`;
  };
  return walk(value as Record<string, unknown>);
}

export type TextCorruption =
  | 'none'
  | 'truncate'
  | 'insert-nul'
  | 'flip-byte'
  | 'prepend-bom'
  | 'append-garbage'
  | 'drop-close-brace';

export const TEXT_CORRUPTIONS: readonly TextCorruption[] = [
  'none',
  'none',
  'none',
  'truncate',
  'insert-nul',
  'flip-byte',
  'prepend-bom',
  'append-garbage',
  'drop-close-brace',
];

export function corruptText(
  rng: () => number,
  text: string,
  corruption: TextCorruption,
): string {
  if (text.length === 0) return text;
  const at = Math.floor(rng() * text.length);
  switch (corruption) {
    case 'none':
      return text;
    case 'truncate':
      return text.slice(0, at);
    case 'insert-nul':
      return text.slice(0, at) + '\u0000' + text.slice(at);
    case 'flip-byte': {
      const code = text.charCodeAt(at) ^ (1 << Math.floor(rng() * 7));
      return text.slice(0, at) + String.fromCharCode(code) + text.slice(at + 1);
    }
    case 'prepend-bom':
      return '\ufeff' + text;
    case 'append-garbage':
      return text + pick(rng, ['}', ']', 'x', '\u0000', ',', '{"a":1}']);
    case 'drop-close-brace': {
      const idx = text.lastIndexOf('}');
      return idx < 0 ? text : text.slice(0, idx) + text.slice(idx + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Account-scope identifier generator.

export interface OwnerCandidate {
  value: unknown;
  recipe: string[];
}

export function ownerCandidate(rng: () => number): OwnerCandidate {
  const recipe: string[] = [];
  if (rng() < 0.12) {
    const name = pick(rng, RUNTIME_VALUE_NAMES);
    recipe.push(`runtime:${name}`);
    return { value: RUNTIME_VALUES[name], recipe };
  }
  let text =
    rng() < 0.1 ? pick(rng, ['device-guest', 'signed-out']) : uuidFromSeed(rng);
  recipe.push(`base:${text}`);
  const steps = Math.floor(rng() * 3);
  for (let i = 0; i < steps; i += 1) {
    const step = pick(rng, OWNER_MUTATIONS);
    recipe.push(step);
    text = applyOwnerMutation(rng, text, step);
  }
  return { value: text, recipe };
}

const OWNER_MUTATIONS = [
  'upper-all',
  'upper-some',
  'trim-space-around',
  'nbsp-around',
  'zwsp-inside',
  'newline-after',
  'tab-before',
  'version-0',
  'version-9',
  'version-f',
  'variant-0',
  'variant-7',
  'variant-c',
  'variant-f',
  'fullwidth-digit',
  'cyrillic-a',
  'kelvin-sign',
  'turkish-dotted-i',
  'nul-inside',
  'drop-char',
  'extra-char',
  'braces',
  'urn-prefix',
  'no-dashes',
  'traversal-suffix',
  'sql-suffix',
  'double-uuid',
  'g-hex',
  'nfd-accent',
  'empty',
] as const;

type OwnerMutation = (typeof OWNER_MUTATIONS)[number];

function applyOwnerMutation(
  rng: () => number,
  text: string,
  step: OwnerMutation,
): string {
  const at = Math.floor(rng() * Math.max(text.length, 1));
  const replaceAt = (index: number, replacement: string) =>
    text.slice(0, index) + replacement + text.slice(index + 1);
  switch (step) {
    case 'upper-all':
      return text.toUpperCase();
    case 'upper-some':
      return text
        .split('')
        .map(ch => (rng() < 0.5 ? ch.toUpperCase() : ch))
        .join('');
    case 'trim-space-around':
      return `  ${text} `;
    case 'nbsp-around':
      return `\u00a0${text}\u00a0`;
    case 'zwsp-inside':
      return text.slice(0, at) + '\u200b' + text.slice(at);
    case 'newline-after':
      return `${text}\n`;
    case 'tab-before':
      return `\t${text}`;
    case 'version-0':
      return text.length > 14 ? replaceAt(14, '0') : text;
    case 'version-9':
      return text.length > 14 ? replaceAt(14, '9') : text;
    case 'version-f':
      return text.length > 14 ? replaceAt(14, 'f') : text;
    case 'variant-0':
      return text.length > 19 ? replaceAt(19, '0') : text;
    case 'variant-7':
      return text.length > 19 ? replaceAt(19, '7') : text;
    case 'variant-c':
      return text.length > 19 ? replaceAt(19, 'c') : text;
    case 'variant-f':
      return text.length > 19 ? replaceAt(19, 'f') : text;
    case 'fullwidth-digit':
      return replaceAt(at, '\uff10');
    case 'cyrillic-a':
      return replaceAt(at, '\u0430');
    case 'kelvin-sign':
      return replaceAt(at, '\u212a');
    case 'turkish-dotted-i':
      return replaceAt(at, '\u0130');
    case 'nul-inside':
      return text.slice(0, at) + '\u0000' + text.slice(at);
    case 'drop-char':
      return text.slice(0, at) + text.slice(at + 1);
    case 'extra-char':
      return (
        text.slice(0, at) + pick(rng, ['0', 'a', '-', 'z']) + text.slice(at)
      );
    case 'braces':
      return `{${text}}`;
    case 'urn-prefix':
      return `urn:uuid:${text}`;
    case 'no-dashes':
      return text.replace(/-/g, '');
    case 'traversal-suffix':
      return `${text}/../..`;
    case 'sql-suffix':
      return `${text}' OR 1=1 --`;
    case 'double-uuid':
      return `${text}${text}`;
    case 'g-hex':
      return replaceAt(at, 'g');
    case 'nfd-accent':
      return text.slice(0, at) + 'e\u0301' + text.slice(at);
    case 'empty':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Limits

export const LIMIT_VALUES: Record<string, unknown> = {
  null: null,
  undefined,
  zero: 0,
  one: 1,
  five: 5,
  'neg-one': -1,
  'neg-zero': -0,
  half: 0.5,
  'one-point-five': 1.5,
  nan: NaN,
  'pos-infinity': Infinity,
  'neg-infinity': -Infinity,
  'max-safe': Number.MAX_SAFE_INTEGER,
  'max-safe-plus-one': 2 ** 53 + 1,
  'max-value': Number.MAX_VALUE,
  'two-to-63': 2 ** 63,
  'two-to-64': 2 ** 64,
  'neg-two-to-63': -(2 ** 63),
  'numeric-string': '3',
  'empty-string': '',
  'sql-string': '1; DROP TABLE local_shot',
  'bool-true': true,
  'bool-false': false,
  'empty-array': [],
  'empty-object': {},
  bigint: BigInt(3),
  'bigint-huge': BigInt('18446744073709551616'),
};

export const LIMIT_VALUE_NAMES = Object.keys(LIMIT_VALUES);

export function seededRng(family: string, seed: number): () => number {
  return makePrng((seed ^ (fnv1aNumber(family) >>> 0)) >>> 0);
}

function fnv1aNumber(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
