/**
 * Seeded boundary/malformed input generators for the outbox drain.
 *
 * Three layers, each a pure function of the `Rng`:
 *   - `mutateValue`      wrong-typed / hostile replacements for any JSON slot
 *   - `mutateShotObject` structured corruption of a valid outbox payload
 *   - `corruptRawJson`   text-level corruption of the stored payload string
 * plus `malformedResponse` (server body shapes) and `hostileThrowable`
 * (values a transport may throw). Every generator returns the `label` that
 * names the category so the JSON table can be aggregated by category.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import { ApiError } from '../../../src/data/api';
import type { Rng } from './rng';
import { seededUuid } from './rng';

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface Labelled<T> {
  label: string;
  value: T;
}

export function validAnalysis(rng: Rng, id = seededUuid(rng)): ShotAnalysis {
  return {
    id,
    sessionId: rng.chance(0.5) ? seededUuid(rng) : null,
    shotType: rng.pick(['forehand_drive', 'dink', 'third_shot_drop', 'serve']),
    cameraView: rng.pick(['side', 'rear_oblique']),
    handedness: rng.pick(['right', 'left']),
    capturedAtIso: '2026-08-26T18:00:00.000Z',
    timestamps: { startMs: 0, contactMs: rng.int(200, 3000), endMs: 4000 },
    phases: [],
    measurements: [],
    checkpoints: [
      {
        key: 'contact_position',
        score: rng.int(0, 100),
        confidence: 0.8,
        band: 'green',
        direction: 'none',
        severity: 0,
        applicable: true,
      },
    ],
    overallScore: rng.int(0, 100) / 10,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'test-native-1',
      poseModelVersion: 'test-pose-1',
      paddleModelVersion: 'test-paddle-1',
      strokeDetectorVersion: 'test-stroke-1',
      phaseModelVersion: 'test-phase-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
  };
}

export function validShotPayload(
  rng: Rng,
  id = seededUuid(rng),
): Record<string, unknown> {
  return { ...validAnalysis(rng, id), analysisPermitId: seededUuid(rng) };
}

export function validSessionPayload(
  rng: Rng,
  id = seededUuid(rng),
): Record<string, unknown> {
  return {
    id,
    startedAt: '2026-08-26T18:00:00.000Z',
    shotType: 'forehand_drive',
    cameraView: 'side',
  };
}

export function validTrialPayload(
  rng: Rng,
  trialId = seededUuid(rng),
): Record<string, unknown> {
  return {
    trialId,
    shotType: 'forehand_drive',
    outcome: 'scored',
    capturedAt: '2026-08-26T18:00:00.000Z',
  };
}

// ─── hostile scalar/string material ─────────────────────────────────────────

export const KB64 = 64 * 1024;

/** Unicode pairs that are canonically equivalent but differ code-point-wise. */
export const NORMALIZATION_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['\u00e9', 'e\u0301'], // é NFC vs NFD
  ['\u00c5', 'A\u030a'], // Å
  ['\u1e0b\u0323', '\u1e0d\u0307'], // ḍ̇ ordering of combining marks
  ['\ufb01', 'fi'], // ﬁ ligature (NFKC only)
  ['\u2126', '\u03a9'], // OHM SIGN vs OMEGA (singleton)
  ['\u212b', '\u00c5'], // ANGSTROM SIGN vs Å
];

const TRAVERSAL_IDS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2fetc%2fpasswd',
  '/v1/shots/../../admin',
  '....//....//',
  'shot\u0000.json',
  '..%c0%af..%c0%afetc',
  'file:///etc/passwd',
];

export function hostileString(rng: Rng): Labelled<string> {
  const family = rng.int(0, 15);
  switch (family) {
    case 0:
      return { label: 'str.empty', value: '' };
    case 1:
      return {
        label: 'str.whitespace',
        value: rng.pick([' ', '\t\n', '\u00a0', '\u2003']),
      };
    case 2:
      return { label: 'str.nul', value: `abc\u0000${seededUuid(rng)}\u0000` };
    case 3:
      return { label: 'str.traversal', value: rng.pick(TRAVERSAL_IDS) };
    case 4:
      return { label: 'str.64kb', value: 'x'.repeat(KB64 + rng.int(0, 64)) };
    case 5:
      // 64 KiB measured in bytes ≠ code points ≠ graphemes.
      return {
        label: 'str.64kb-multibyte',
        value: '\u{1F3D3}'.repeat(Math.ceil(KB64 / 4) + 1),
      };
    case 6:
      return {
        label: 'str.grapheme-cluster',
        value: '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(
          rng.int(1, 4096),
        ),
      };
    case 7: {
      const pair = rng.pick(NORMALIZATION_PAIRS);
      return {
        label: 'str.nfc-nfd',
        value: rng.chance(0.5) ? pair[0] : pair[1],
      };
    }
    case 8:
      return {
        label: 'str.bidi',
        value: '\u202e' + seededUuid(rng) + '\u202c',
      };
    case 9:
      return { label: 'str.lone-surrogate', value: 'a\ud800b' };
    case 10:
      return { label: 'str.uuid-upper', value: seededUuid(rng).toUpperCase() };
    case 11:
      return { label: 'str.uuid-padded', value: ` ${seededUuid(rng)} ` };
    case 12:
      return {
        label: 'str.single-char',
        value: rng.pick(['a', '0', '-', '\u0000']),
      };
    case 13:
      return { label: 'str.sql', value: "'; DROP TABLE outbox; --" };
    case 14:
      return { label: 'str.html', value: '<script>alert(1)</script>' };
    default:
      return {
        label: 'str.proto',
        value: rng.pick(['__proto__', 'constructor', 'prototype']),
      };
  }
}

/** Numbers JSON can carry (JSON.parse turns `1e999` into Infinity). */
export function hostileNumber(rng: Rng): Labelled<number> {
  return rng.pick<Labelled<number>>([
    { label: 'num.neg-zero', value: -0 },
    { label: 'num.overflow', value: Number.POSITIVE_INFINITY },
    { label: 'num.neg-overflow', value: Number.NEGATIVE_INFINITY },
    { label: 'num.unsafe-int', value: Number.MAX_SAFE_INTEGER + 2 },
    { label: 'num.max', value: Number.MAX_VALUE },
    { label: 'num.min-subnormal', value: 5e-324 },
    { label: 'num.negative', value: -1 },
    { label: 'num.huge-neg', value: -(2 ** 53) },
    { label: 'num.fraction', value: 0.1 + 0.2 },
  ]);
}

/** A wrong-typed replacement for any JSON slot. */
export function mutateValue(rng: Rng, depth = 0): Labelled<unknown> {
  const family = rng.int(0, depth > 1 ? 7 : 10);
  switch (family) {
    case 0:
      return { label: 'val.null', value: null };
    case 1:
      return { label: 'val.bool', value: rng.chance(0.5) };
    case 2:
      return hostileNumber(rng);
    case 3:
      return hostileString(rng);
    case 4:
      return { label: 'val.empty-array', value: [] };
    case 5:
      return { label: 'val.empty-object', value: {} };
    case 6:
      return { label: 'val.array-of-null', value: [null, null] };
    case 7:
      return { label: 'val.array-of-num', value: [1, 2, 3] };
    case 8: {
      const inner = mutateValue(rng, depth + 1);
      return { label: `val.wrapped[${inner.label}]`, value: [inner.value] };
    }
    case 9: {
      const inner = mutateValue(rng, depth + 1);
      const key = rng.pick(['__proto__', 'constructor', 'prototype', 'k']);
      const obj: Record<string, unknown> = {};
      Object.defineProperty(obj, key, {
        value: inner.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return { label: `val.obj[${key}:${inner.label}]`, value: obj };
    }
    default:
      return {
        label: 'val.future-schema',
        value: { schemaVersion: 99, v: '9.9.9' },
      };
  }
}

/** Structured corruption of a valid payload object; `idKey` names the id slot. */
export function mutateShotObject(
  rng: Rng,
  base: Record<string, unknown>,
  idKey: string,
): Labelled<unknown> {
  const family = rng.int(0, 11);
  const copy: Record<string, unknown> = { ...base };
  switch (family) {
    case 0: {
      const v = mutateValue(rng);
      copy['analysisPermitId'] = v.value;
      return { label: `permit:${v.label}`, value: copy };
    }
    case 1:
      delete copy['analysisPermitId'];
      return { label: 'permit:missing', value: copy };
    case 2: {
      const v = mutateValue(rng);
      copy['checkpoints'] = v.value;
      return { label: `checkpoints:${v.label}`, value: copy };
    }
    case 3: {
      const v = mutateValue(rng);
      copy[idKey] = v.value;
      return { label: `${idKey}:${v.label}`, value: copy };
    }
    case 4: {
      const key = rng.pick([
        'sessionId',
        'shotType',
        'cameraView',
        'timestamps',
        'overallScore',
        'analysisConfidence',
        'resultKind',
        'source',
        'phases',
        'versionVector',
        'capturedAtIso',
      ]);
      const v = mutateValue(rng);
      copy[key] = v.value;
      return { label: `${key}:${v.label}`, value: copy };
    }
    case 5: {
      const v = mutateValue(rng);
      const key = rng.pick(['__proto__', 'constructor', 'prototype']);
      Object.defineProperty(copy, key, {
        value: v.value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return { label: `proto-key:${key}[${v.label}]`, value: copy };
    }
    case 6:
      return { label: 'shape:empty-object', value: {} };
    case 7:
      return { label: 'shape:array-wrapped', value: [copy] };
    case 8: {
      const v = mutateValue(rng);
      return { label: `shape:scalar[${v.label}]`, value: v.value };
    }
    case 9: {
      for (let i = 0; i < 500; i += 1) copy[`future_${i}`] = i;
      copy['schemaVersion'] = 99;
      return { label: 'shape:future-schema-500-keys', value: copy };
    }
    case 10: {
      copy['checkpoints'] = Array.from({ length: 10_000 }, () => ({
        key: 'k',
        score: hostileNumber(rng).value,
      }));
      return { label: 'checkpoints:10k-entries', value: copy };
    }
    default: {
      // checkpoints array holding one hostile entry
      const v = mutateValue(rng);
      copy['checkpoints'] = [
        { key: 'ok', score: 1, confidence: 1, band: 'good', applicable: true },
        v.value,
      ];
      return { label: `checkpoint-entry:${v.label}`, value: copy };
    }
  }
}

/** Text-level corruption of the stored JSON string. */
export function corruptRawJson(rng: Rng, valid: string): Labelled<string> {
  const family = rng.int(0, 13);
  switch (family) {
    case 0: {
      const cut = rng.int(0, Math.max(0, valid.length - 1));
      return { label: 'raw.truncated', value: valid.slice(0, cut) };
    }
    case 1:
      return { label: 'raw.trailing-garbage', value: `${valid}}}}]garbage` };
    case 2:
      return {
        label: 'raw.not-json',
        value: rng.pick([
          'definitely not json',
          'undefined',
          'NaN',
          '{a:1}',
          "{'a':1}",
        ]),
      };
    case 3:
      return { label: 'raw.empty', value: '' };
    case 4:
      return { label: 'raw.whitespace', value: '  \n\t ' };
    case 5:
      return {
        label: 'raw.scalar-json',
        value: rng.pick([
          'null',
          'true',
          'false',
          '42',
          '"str"',
          '-0',
          '1e999',
        ]),
      };
    case 6:
      return {
        label: 'raw.empty-container',
        value: rng.pick(['[]', '{}', '[[]]', '[{}]']),
      };
    case 7: {
      const pos = rng.int(0, valid.length);
      return {
        label: 'raw.nul-inserted',
        value: `${valid.slice(0, pos)}\u0000${valid.slice(pos)}`,
      };
    }
    case 8: {
      const depth = rng.int(1000, 20_000);
      return {
        label: 'raw.deep-nesting',
        value: '['.repeat(depth) + ']'.repeat(depth),
      };
    }
    case 9:
      return { label: 'raw.bom-prefixed', value: `\ufeff${valid}` };
    case 10:
      return {
        label: 'raw.nan-literal',
        value: valid.replace(
          /"overallScore":[^,}]+/,
          `"overallScore":${rng.pick(['NaN', 'Infinity', '-Infinity', '0x10', '.5', '1.'])}`,
        ),
      };
    case 11:
      return {
        label: 'raw.proto-first-key',
        value: `{"__proto__":{"polluted":true},${valid.slice(1)}`,
      };
    case 12:
      return {
        label: 'raw.escaped-lone-surrogate',
        value: valid.replace(/"id":"[^"]*"/, '"id":"\\ud800\\udbff"'),
      };
    default: {
      const huge = 'x'.repeat(rng.pick([KB64, 256 * 1024, 1024 * 1024]));
      return {
        label: 'raw.huge-field',
        value: valid.replace(/"shotType":"[^"]*"/, `"shotType":"${huge}"`),
      };
    }
  }
}

// ─── server response shapes ─────────────────────────────────────────────────

export interface MalformedResponse {
  label: string;
  value: unknown;
}

function mutateId(rng: Rng, id: string): Labelled<unknown> {
  return rng.pick<Labelled<unknown>>([
    { label: 'id.upper', value: id.toUpperCase() },
    { label: 'id.padded', value: ` ${id}` },
    { label: 'id.nul-suffix', value: `${id}\u0000` },
    { label: 'id.object', value: { id } },
    { label: 'id.array', value: [id] },
    { label: 'id.number', value: 42 },
    { label: 'id.null', value: null },
    { label: 'id.nfd', value: `${id}\u0301` },
    { label: 'id.proto', value: '__proto__' },
    { label: 'id.foreign', value: seededUuid(rng) },
  ]);
}

/**
 * A server body for `syncShots`/`uploadEvaluationTrials`, given the ids
 * actually sent. `idField` is `id` for shots and `trialId` for trials;
 * `acceptedField` is `acceptedIds` / `acceptedTrialIds`.
 */
export function malformedResponse(
  rng: Rng,
  sentIds: string[],
  idField: 'id' | 'trialId',
  acceptedField: 'acceptedIds' | 'acceptedTrialIds',
): MalformedResponse {
  const family = rng.int(0, 15);
  const body = (
    accepted: unknown,
    rejected: unknown,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    out[acceptedField] = accepted;
    out['rejected'] = rejected;
    return out;
  };
  const properRejection = (id: unknown) => {
    const entry: Record<string, unknown> = {};
    entry[idField] = id;
    entry['code'] = 'shot.invalid';
    entry['message'] = 'rejected';
    return entry;
  };
  switch (family) {
    case 0:
      return { label: 'resp.null', value: null };
    case 1:
      return { label: 'resp.undefined', value: undefined };
    case 2:
      return {
        label: 'resp.scalar',
        value: rng.pick<unknown>(['ok', 42, true, -0]),
      };
    case 3:
      return { label: 'resp.array', value: sentIds };
    case 4:
      return { label: 'resp.empty-object', value: {} };
    case 5:
      return { label: 'resp.accepted-null', value: body(null, []) };
    case 6:
      return {
        label: 'resp.accepted-string',
        value: body(rng.pick([...sentIds, 'a', '']), []),
      };
    case 7:
      return {
        label: 'resp.accepted-object',
        value: body({ 0: sentIds[0] }, []),
      };
    case 8: {
      const mutated = sentIds.map(id => mutateId(rng, id));
      return {
        label: `resp.accepted-mutated[${mutated.map(m => m.label).join(',')}]`,
        value: body(
          mutated.map(m => m.value),
          [],
        ),
      };
    }
    case 9:
      return { label: 'resp.rejected-missing', value: body([], undefined) };
    case 10:
      return {
        label: 'resp.rejected-scalar',
        value: body([], rng.pick<unknown>([null, 'x', 7, {}])),
      };
    case 11:
      return {
        label: 'resp.rejected-null-entries',
        value: body([], [null, undefined, 1]),
      };
    case 12: {
      const code = mutateValue(rng);
      const entry = properRejection(sentIds[0]);
      entry['code'] = code.value;
      entry['message'] = rng.chance(0.5) ? undefined : hostileString(rng).value;
      return {
        label: `resp.rejected-code[${code.label}]`,
        value: body([], [entry]),
      };
    }
    case 13:
      return {
        label: 'resp.accepted-and-rejected',
        value: body(sentIds, sentIds.map(properRejection)),
      };
    case 14: {
      const extra = Array.from({ length: rng.int(1, 5000) }, () =>
        seededUuid(rng),
      );
      return {
        label: 'resp.accepted-extra-ids',
        value: body([...sentIds, ...extra, '__proto__'], []),
      };
    }
    default: {
      const entries = sentIds.map(id => {
        const entry: Record<string, unknown> = {};
        Object.defineProperty(entry, '__proto__', {
          value: { polluted: true },
          enumerable: true,
          configurable: true,
          writable: true,
        });
        entry[idField] = id;
        entry['code'] = 'shot.write_failed';
        entry['message'] = 'x'.repeat(KB64);
        return entry;
      });
      return {
        label: 'resp.rejected-proto-transient-64kb',
        value: body([], entries),
      };
    }
  }
}

// ─── throwables ─────────────────────────────────────────────────────────────

export interface Throwable {
  label: string;
  value: unknown;
  /** What `isPermanentSyncFailure` is expected to say, per its contract. */
  permanent: boolean;
  /** Can `String(value)` be evaluated without throwing? */
  stringifiable: boolean;
}

const API_STATUSES = [
  400,
  401,
  403,
  404,
  408,
  409,
  413,
  422,
  429,
  450,
  499,
  500,
  502,
  503,
  0,
  -1,
  399,
  399.5,
  499.5,
  600,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  2 ** 31,
];

export function hostileThrowable(rng: Rng): Throwable {
  const family = rng.int(0, 12);
  switch (family) {
    case 0:
    case 1:
    case 2:
    case 3: {
      const status = rng.pick(API_STATUSES);
      const code = rng.chance(0.8) ? 'shot.invalid' : hostileString(rng).value;
      const message = rng.chance(0.8) ? 'rejected' : hostileString(rng).value;
      return {
        label: `throw.ApiError[${status}]`,
        value: new ApiError(status, code, message),
        permanent:
          status >= 400 &&
          status < 500 &&
          status !== 401 &&
          status !== 408 &&
          status !== 429,
        stringifiable: true,
      };
    }
    case 4:
      return {
        label: 'throw.Error',
        value: new Error('boom'),
        permanent: false,
        stringifiable: true,
      };
    case 5:
      return {
        label: 'throw.TypeError',
        value: new TypeError('x is not a function'),
        permanent: false,
        stringifiable: true,
      };
    case 6:
      return {
        label: 'throw.string',
        value: hostileString(rng).value,
        permanent: false,
        stringifiable: true,
      };
    case 7:
      return {
        label: 'throw.null',
        value: rng.chance(0.5) ? null : undefined,
        permanent: false,
        stringifiable: true,
      };
    case 8:
      return {
        label: 'throw.number',
        value: hostileNumber(rng).value,
        permanent: false,
        stringifiable: true,
      };
    case 9:
      return {
        label: 'throw.null-proto-object',
        value: Object.create(null) as unknown,
        permanent: false,
        stringifiable: false,
      };
    case 10:
      return {
        label: 'throw.toString-throws',
        value: {
          toString: () => {
            throw new Error('nope');
          },
        },
        permanent: false,
        stringifiable: false,
      };
    case 11:
      return {
        label: 'throw.symbol',
        value: Symbol('s'),
        permanent: false,
        stringifiable: true,
      };
    default: {
      // Duck-typed ApiError (not an instance): must be treated as transient.
      return {
        label: 'throw.duck-ApiError',
        value: {
          status: 400,
          code: 'shot.invalid',
          message: 'duck',
          name: 'ApiError',
        },
        permanent: false,
        stringifiable: true,
      };
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Compact, safe preview of any value for the JSON table. */
export function preview(value: unknown, max = 160): string {
  let text: string;
  try {
    text =
      typeof value === 'string'
        ? JSON.stringify(value)
        : typeof value === 'symbol'
          ? value.toString()
          : typeof value === 'bigint'
            ? `${value}n`
            : value instanceof Error
              ? `${value.name}(${value.message})`
              : (JSON.stringify(value) ?? String(value));
  } catch {
    text = '<unstringifiable>';
  }
  if (text === undefined) text = String(value);
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

/** Is `value` a fully valid shot payload as far as `drainOutbox` requires? */
export function isDrainableShotPayload(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['analysisPermitId'] !== 'string') return false;
  if (!(obj['analysisPermitId'] as string).trim()) return false;
  const checkpoints = obj['checkpoints'];
  if (!Array.isArray(checkpoints)) return false;
  return checkpoints.every(c => c !== null && c !== undefined);
}
