/**
 * Stress lens: BOUNDARY / MALFORMED INPUT for `src/state/consentStore.ts`.
 *
 * Everything the store consumes from the outside is generated adversarially
 * from a seeded PRNG and pushed through `hydrate()` / `setModelTrainingConsent()`
 * with a mock transport (no network, no timers, no native modules):
 *
 *   transport  – fetch rejects/throws (Error, TypeError, string, undefined,
 *                abort-like), response is not an object, `json` is missing /
 *                throws synchronously / returns a non-promise / rejects,
 *                `ok` is a non-boolean
 *   payload    – valid ledger status with 0..4 random mutations: wrong types,
 *                NaN/Infinity/-0/2^53+1/BigInt, null bytes, 64 KiB+ strings
 *                (bytes vs code points vs grapheme clusters), path traversal,
 *                header/HTML/template injection markers, prototype-pollution
 *                keys (`__proto__`, `constructor.prototype`), future schema
 *                fields and unknown scopes, duplicate rows, empty/sparse/huge/
 *                array-like `scopes`, throwing getters and Proxies, unicode
 *                normalization pairs and homoglyph confusables of scope names
 *   json text  – valid JSON text truncated / corrupted / with `__proto__`
 *                keys / 1e999 / deep nesting / BOM / NUL, parsed exactly like
 *                `Response.json()` (reject on syntax error)
 *   arguments  – hostile session fields (apiBaseUrl, bearerToken,
 *                canonicalAppUserId) and non-boolean `granted`
 *
 * Every iteration is checked against an INDEPENDENT strict oracle of the
 * consent-status contract (consentApi.ts parseStatus is not consulted) and a
 * fixed set of invariants that must hold no matter what arrives:
 *
 *   I1  neither action ever rejects/throws out of the store
 *   I2  `busy` is false afterwards; `availability` is one of the four values
 *   I3  `modelTrainingActive` is a strict boolean and is `true` ONLY when the
 *       oracle says the payload was a valid status whose first model_training
 *       row has `active === true` (default OFF, never a guessed grant)
 *   I4  `error` is null or one of the store's fixed copy strings — never a
 *       fragment of the payload (no reflected server text)
 *   I5  no write: hydrate issues exactly one GET to /v1/me/consent/status;
 *       setModelTrainingConsent issues exactly one POST to grant|withdraw
 *       with a well-formed body; no session → no request at all
 *   I6  store shape is unchanged (no injected keys) and Object/Array
 *       prototypes are not polluted
 *   I7  valid payload → state mirrors the oracle exactly (availability
 *       'ready', active, lastActionAt); invalid payload → hydrate reports
 *       'unavailable' with OFF, set keeps the pre-write state
 *
 * Scale:   STRESS_ITER=<n>        iterations per campaign (default 300 → 1500)
 * Replay:  STRESS_SEED=<n>        campaign base seed (default 20260904)
 *          STRESS_ONLY=<iterSeed> run a single iteration verbosely
 * Output:  STRESS_OUT=<dir>       JSON tables (default artifacts/stress/…)
 */

import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import {
  useConsentStore,
  type ConsentAvailability,
} from '../../src/state/consentStore';

// Node built-ins, typed the way __tests__/matrix/networkAuthMatrix.test.ts
// does (the RN tsconfig ships no node types).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITER = Number(process.env.STRESS_ITER ?? 300);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const OUT_DIR =
  process.env.STRESS_OUT ??
  join(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'consent-store-boundary-malformed',
  );

// ─── Seeded PRNG (mulberry32) ────────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iterSeed(campaign: number, index: number): number {
  // Deterministic per-iteration seed so a single case replays alone.
  let h = (BASE_SEED ^ (campaign * 0x9e3779b9) ^ (index * 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ─── Hostile value catalogue ─────────────────────────────────────────────────

/** Every generated string carries this marker so reflection is detectable. */
const MARK = 'INJ\u{1F952}';

const KIB64 = 65_536;
const BIG_ASCII = 'A'.repeat(KIB64) + MARK; // 64 KiB+ bytes
const BIG_ASTRAL = '\u{1D538}'.repeat(KIB64) + MARK; // 64 K code points (256 KiB)
const BIG_GRAPHEMES =
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}'.repeat(16_384) +
  MARK; // 16 K grapheme clusters, 114 K code points
const BIG_NUL = '\u0000'.repeat(KIB64) + MARK;

const HOSTILE_STRINGS: readonly string[] = [
  '',
  ' ',
  '\t\n\r',
  'true',
  'false',
  'null',
  'undefined',
  '0',
  '1',
  '-0',
  'NaN',
  `${MARK}\u0000after-nul`,
  `\u0000${MARK}`,
  BIG_ASCII,
  BIG_ASTRAL,
  BIG_GRAPHEMES,
  BIG_NUL,
  `../../../etc/passwd${MARK}`,
  `..\\..\\windows\\system32${MARK}`,
  `%2e%2e%2f%2e%2e%2f${MARK}`,
  `file:///etc/passwd#${MARK}`,
  `javascript:alert(1)//${MARK}`,
  `<script>alert('${MARK}')</script>`,
  `\${${MARK}}`,
  `{{${MARK}}}`,
  `' OR 1=1 -- ${MARK}`,
  `\r\nX-Injected: ${MARK}`,
  `Bearer ${MARK}`,
  `\u202E${MARK}`, // RTL override
  `\uFEFF${MARK}`, // BOM
  `\uD800${MARK}`, // lone surrogate
  `\uDFFF${MARK}`,
  'e\u0301', // NFD é
  '\u00E9', // NFC é
  '\uFB01', // ﬁ ligature (NFKC → fi)
  `${MARK}`.normalize('NFD'),
  '2026-08-29T00:00:00.000Z',
  '2026-13-45T99:99:99Z',
  '0000-00-00',
  '9999999999999999999999999',
  'model_training',
  'MODEL_TRAINING',
  'model_training ',
  ' model_training',
  'model_training\u0000',
  'model-training',
  'modeltraining',
  'model_trainin',
  'model_trainingg',
  'video_analysis',
  'evaluation_telemetry',
  'granted',
  'withdrawn',
  'grant',
  'withdraw',
  'Granted',
  'revoked',
  MODEL_TRAINING_CONSENT_VERSION,
  'model-training-v2',
  'model-training-v999',
];

const HOSTILE_NUMBERS: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -0,
  0,
  1,
  -1,
  2 ** 31 - 1,
  2 ** 31,
  2 ** 32,
  2 ** 53,
  2 ** 53 + 1,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.EPSILON,
  0.1 + 0.2,
  1e21,
  -1e-7,
  1756425600000, // epoch ms — a plausible schema drift for lastActionAt
  1756425600, // epoch s
];

class ThrowingGetterError extends Error {
  constructor() {
    super(`getter ${MARK}`);
    this.name = 'ThrowingGetterError';
  }
}

function throwingGetterObject(keys: readonly string[]): object {
  const target: Record<string, unknown> = {};
  for (const key of keys) {
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        throw new ThrowingGetterError();
      },
    });
  }
  return target;
}

function throwingProxy(): object {
  return new Proxy(
    {},
    {
      get() {
        throw new ThrowingGetterError();
      },
      has() {
        throw new ThrowingGetterError();
      },
      ownKeys() {
        throw new ThrowingGetterError();
      },
    },
  );
}

/** Own `__proto__` key exactly as JSON.parse produces it (no pollution). */
function ownProtoObject(): object {
  return JSON.parse(`{"__proto__":{"polluted":"${MARK}"},"x":1}`) as object;
}

function hostileValue(rng: Rng): unknown {
  const roll = rng();
  if (roll < 0.3) return pick(rng, HOSTILE_STRINGS);
  if (roll < 0.5) return pick(rng, HOSTILE_NUMBERS);
  if (roll < 0.55) return pick(rng, [null, undefined]);
  if (roll < 0.62) return pick(rng, [true, false]);
  if (roll < 0.66) return BigInt('1' + '0'.repeat(int(rng, 1, 40)));
  if (roll < 0.7) return pick(rng, [[], [[]], [null], [MARK], [0]]);
  if (roll < 0.78) {
    return pick(rng, [
      {},
      { scopes: [] },
      { scope: 'model_training', active: true },
      Object.create(null) as object,
      ownProtoObject(),
      { constructor: { prototype: { polluted: MARK } } },
      new Date(0),
      new Date(Number.NaN),
      /model_training/,
      new Map([['scope', 'model_training']]),
      new Set(['model_training']),
    ]);
  }
  if (roll < 0.82) return Object(true); // boxed Boolean, typeof 'object'
  if (roll < 0.85) return Object('model_training'); // boxed String
  if (roll < 0.88) return Symbol(MARK);
  if (roll < 0.91) return () => MARK;
  if (roll < 0.95) return throwingGetterObject(['scope', 'active', 'scopes']);
  return throwingProxy();
}

// ─── Unicode confusables of the scope name ───────────────────────────────────

const HOMOGLYPHS: Record<string, readonly string[]> = {
  a: ['\u0430', '\u03B1', '\uFF41'], // Cyrillic а, Greek α, fullwidth ａ
  e: ['\u0435', '\u212F', '\uFF45'],
  o: ['\u043E', '\u03BF', '\uFF4F'],
  i: ['\u0456', '\u0131', '\uFF49'],
  n: ['\u0578', '\uFF4E'],
  g: ['\u0261', '\uFF47'],
  _: ['\uFF3F', '\u2017', '-', ' '],
};

function confusableScope(rng: Rng): { value: string; identical: boolean } {
  const base = 'model_training';
  const roll = rng();
  if (roll < 0.1) return { value: base, identical: true };
  if (roll < 0.2) {
    const form = pick(rng, ['NFC', 'NFD', 'NFKC', 'NFKD'] as const);
    const value = base.normalize(form);
    return { value, identical: value === base };
  }
  if (roll < 0.35) {
    const at = int(rng, 0, base.length);
    const zw = pick(rng, ['\u200B', '\u200C', '\u200D', '\u2060', '\uFEFF']);
    return { value: base.slice(0, at) + zw + base.slice(at), identical: false };
  }
  if (roll < 0.6) {
    const chars = [...base];
    const candidates = chars
      .map((c, i) => (HOMOGLYPHS[c] ? i : -1))
      .filter(i => i >= 0);
    const i = pick(rng, candidates);
    const original = chars[i] as string;
    chars[i] = pick(rng, HOMOGLYPHS[original] as readonly string[]);
    return { value: chars.join(''), identical: false };
  }
  if (roll < 0.7) return { value: base.toUpperCase(), identical: false };
  if (roll < 0.8) {
    const value = pick(rng, [
      ` ${base}`,
      `${base} `,
      `${base}\u0000`,
      `\t${base}`,
    ]);
    return { value, identical: false };
  }
  if (roll < 0.9) {
    return {
      value: pick(rng, ['video_analysis', 'evaluation_telemetry']),
      identical: false,
    };
  }
  const value = pick(rng, HOSTILE_STRINGS);
  return { value, identical: value === base };
}

// ─── Valid payload factory + mutation catalogue ──────────────────────────────

type Row = Record<string, unknown>;
type Payload = Record<string, unknown>;

const SCOPES = [
  'video_analysis',
  'model_training',
  'evaluation_telemetry',
] as const;

function validRow(rng: Rng, scope: string): Row {
  const action = pick(rng, [null, 'granted', 'withdrawn'] as const);
  const active = action === 'granted' && rng() < 0.9;
  return {
    scope,
    active,
    consentVersion:
      action === null
        ? null
        : pick(rng, [MODEL_TRAINING_CONSENT_VERSION, 'v0']),
    lastAction: action,
    lastActionAt:
      action === null
        ? null
        : pick(rng, ['2026-08-29T00:00:00.000Z', '2026-09-04T21:00:00Z']),
  };
}

function validPayload(rng: Rng): Payload {
  const scopes: Row[] = [];
  // Any subset/order of the three scopes is a valid ledger snapshot.
  for (const scope of SCOPES)
    if (rng() < 0.85) scopes.push(validRow(rng, scope));
  for (let i = scopes.length - 1; i > 0; i--) {
    const j = int(rng, 0, i);
    const tmp = scopes[i] as Row;
    scopes[i] = scopes[j] as Row;
    scopes[j] = tmp;
  }
  return {
    subjectPseudonym:
      rng() < 0.5 ? null : 'b0000000-0000-0000-0000-000000000002',
    scopes,
  };
}

const ROW_FIELDS = [
  'scope',
  'active',
  'consentVersion',
  'lastAction',
  'lastActionAt',
] as const;

function describeValue(value: unknown): string {
  try {
    return String(value).slice(0, 24);
  } catch {
    return '<unprintable>';
  }
}

/** Applies one random mutation; returns its name (for the results table). */
function mutatePayload(rng: Rng, payload: Payload): string {
  // An earlier mutation may have installed a throwing getter or replaced the
  // payload; a mutation that collides with it is recorded as a no-op.
  try {
    return applyMutation(rng, payload);
  } catch {
    return 'noop(collided with earlier mutation)';
  }
}

function applyMutation(rng: Rng, payload: Payload): string {
  const scopes = payload['scopes'];
  const rows = Array.isArray(scopes) ? (scopes as Row[]) : [];
  const row = rows.length > 0 ? pick(rng, rows) : null;
  const which = int(rng, 0, 22);
  switch (which) {
    case 0:
      delete payload['scopes'];
      return 'delete scopes';
    case 1:
      payload['scopes'] = hostileValue(rng);
      return 'scopes=hostile';
    case 2:
      payload['subjectPseudonym'] = hostileValue(rng);
      return 'subjectPseudonym=hostile';
    case 3:
      Object.defineProperty(payload, '__proto__', {
        value: { polluted: MARK, scopes: [] },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      return 'own __proto__ key';
    case 4:
      payload['constructor'] = { prototype: { polluted: MARK } };
      return 'constructor.prototype key';
    case 5:
      payload['schemaVersion'] = pick(rng, [2, '2.0', 999, MARK]);
      payload[`future_${int(rng, 0, 9)}`] = hostileValue(rng);
      return 'future schema fields';
    case 6:
      rows.push({
        ...validRow(rng, pick(rng, ['coach_feedback', 'video_sharing', MARK])),
      });
      payload['scopes'] = rows;
      return 'unknown future scope row';
    case 7:
      if (row) {
        const field = pick(rng, ROW_FIELDS);
        row[field] = hostileValue(rng);
        return `row.${field}=hostile`;
      }
      return 'noop(no row)';
    case 8:
      if (row) {
        const field = pick(rng, ROW_FIELDS);
        delete row[field];
        return `delete row.${field}`;
      }
      return 'noop(no row)';
    case 9: {
      const dup = validRow(rng, 'model_training');
      dup['active'] = rng() < 0.5;
      rows.splice(int(rng, 0, rows.length), 0, dup);
      payload['scopes'] = rows;
      return 'duplicate model_training row';
    }
    case 10:
      if (rows.length > 0) {
        rows[int(rng, 0, rows.length - 1)] = hostileValue(rng) as Row;
        payload['scopes'] = rows;
        return 'row=hostile';
      }
      return 'noop(no row)';
    case 11:
      payload['scopes'] = [];
      return 'scopes=[]';
    case 12: {
      const sparse: Row[] = [];
      sparse[int(rng, 1, 50)] = validRow(rng, 'model_training');
      payload['scopes'] = sparse;
      return 'scopes=sparse';
    }
    case 13: {
      const huge: Row[] = [];
      for (let i = 0; i < 5000; i++)
        huge.push(validRow(rng, pick(rng, SCOPES)));
      payload['scopes'] = huge;
      return 'scopes=5000 rows';
    }
    case 14:
      payload['scopes'] = { length: 1, 0: validRow(rng, 'model_training') };
      return 'scopes=array-like';
    case 15:
      if (row) {
        const c = confusableScope(rng);
        row['scope'] = c.value;
        return `row.scope=confusable(${c.identical ? 'identical' : 'different'})`;
      }
      return 'noop(no row)';
    case 16:
      if (row) {
        row['active'] = pick(rng, [
          'true',
          'false',
          1,
          0,
          -0,
          Number.NaN,
          Object(true),
          Object(false),
          null,
          undefined,
          {},
          [],
          'yes',
        ]);
        return 'row.active=non-boolean';
      }
      return 'noop(no row)';
    case 17:
      if (row) {
        row['lastActionAt'] = pick(rng, [
          1756425600000,
          1756425600,
          new Date(0),
          { $date: '2026-08-29T00:00:00.000Z' },
          BIG_ASCII,
          `../../${MARK}`,
          '',
        ]);
        return 'row.lastActionAt=non-iso';
      }
      return 'noop(no row)';
    case 18:
      if (row) {
        Object.defineProperty(row, pick(rng, ROW_FIELDS), {
          enumerable: true,
          get() {
            throw new ThrowingGetterError();
          },
        });
        return 'row throwing getter';
      }
      return 'noop(no row)';
    case 19:
      Object.defineProperty(payload, 'scopes', {
        enumerable: true,
        get() {
          throw new ThrowingGetterError();
        },
      });
      return 'payload.scopes throwing getter';
    case 20: {
      const bare = Object.create(null) as Payload;
      for (const key of Object.keys(payload)) bare[key] = payload[key];
      payload['__replace__'] = bare;
      return 'payload=null-prototype copy';
    }
    case 21:
      payload['__replace__'] = hostileValue(rng);
      return 'payload=hostile';
    case 22:
      payload['__replace__'] = [payload['scopes']];
      return 'payload=array';
    default:
      return 'noop';
  }
}

/** `__replace__` lets a mutation swap the whole payload object. */
function finalizePayload(payload: Payload): unknown {
  if (Object.prototype.hasOwnProperty.call(payload, '__replace__')) {
    return payload['__replace__'];
  }
  return payload;
}

// ─── Independent strict oracle of the consent-status contract ────────────────

type Oracle =
  | { kind: 'valid'; active: boolean; lastActionAt: string | null }
  | { kind: 'invalid'; reason: string };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === 'object' &&
    !Array.isArray(value)
  );
}

function oracleParse(payload: unknown): Oracle {
  try {
    if (!isPlainRecord(payload))
      return { kind: 'invalid', reason: 'not object' };
    const scopes = payload['scopes'];
    if (!Array.isArray(scopes)) return { kind: 'invalid', reason: 'scopes' };
    const pseudonym = payload['subjectPseudonym'];
    if (!(pseudonym === null || typeof pseudonym === 'string')) {
      return { kind: 'invalid', reason: 'subjectPseudonym' };
    }
    let training: { active: boolean; lastActionAt: string | null } | null =
      null;
    // Holes cannot come from JSON.parse, so a sparse array is not a ledger
    // snapshot; rejecting it is the graceful outcome.
    for (let i = 0; i < scopes.length; i++) {
      if (!(i in scopes)) return { kind: 'invalid', reason: 'sparse array' };
      const row: unknown = scopes[i];
      if (!isPlainRecord(row)) return { kind: 'invalid', reason: 'row' };
      const scope = row['scope'];
      if (!(
        scope === 'video_analysis' ||
        scope === 'model_training' ||
        scope === 'evaluation_telemetry'
      )) {
        return { kind: 'invalid', reason: 'scope' };
      }
      const active = row['active'];
      if (active !== true && active !== false) {
        return { kind: 'invalid', reason: 'active' };
      }
      const lastAction = row['lastAction'];
      if (!(
        lastAction === null ||
        lastAction === 'granted' ||
        lastAction === 'withdrawn'
      )) {
        return { kind: 'invalid', reason: 'lastAction' };
      }
      const lastActionAt = row['lastActionAt'];
      if (!(lastActionAt === null || typeof lastActionAt === 'string')) {
        return { kind: 'invalid', reason: 'lastActionAt' };
      }
      const consentVersion = row['consentVersion'];
      if (!(consentVersion === null || typeof consentVersion === 'string')) {
        return { kind: 'invalid', reason: 'consentVersion' };
      }
      if (scope === 'model_training' && training === null) {
        training = { active, lastActionAt };
      }
    }
    return {
      kind: 'valid',
      active: training?.active ?? false,
      lastActionAt: training?.lastActionAt ?? null,
    };
  } catch {
    return { kind: 'invalid', reason: 'getter threw' };
  }
}

// ─── Transport envelope ──────────────────────────────────────────────────────

interface Envelope {
  name: string;
  fetchFn: ConsentFetch;
  /** Whether a well-formed payload could reach the parser through it. */
  transparent: boolean;
  calls: { input: string; init: RequestInit | undefined }[];
}

function makeEnvelope(rng: Rng, payload: unknown, jsonText?: string): Envelope {
  const calls: Envelope['calls'] = [];
  const record = (input: string, init?: RequestInit) => {
    calls.push({ input, init });
  };
  const okResponse = (): Response =>
    ({
      ok: true,
      status: 200,
      json: () =>
        jsonText === undefined
          ? Promise.resolve(payload)
          : (() => {
              try {
                return Promise.resolve(JSON.parse(jsonText) as unknown);
              } catch (error) {
                return Promise.reject(error);
              }
            })(),
    }) as unknown as Response;
  const roll = rng();
  if (roll < 0.6) {
    return {
      name: 'ok+json',
      transparent: true,
      calls,
      fetchFn: (input, init) => {
        record(input, init);
        return Promise.resolve(okResponse());
      },
    };
  }
  const variants: { name: string; fetchFn: ConsentFetch }[] = [
    {
      name: 'reject Error',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.reject(new Error(`net ${MARK}`))
      ),
    },
    {
      name: 'reject TypeError',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.reject(new TypeError('Network request failed'))
      ),
    },
    {
      name: 'reject abort-like',
      fetchFn: (i, n) => {
        record(i, n);
        const abort = new Error('Aborted');
        abort.name = 'AbortError';
        return Promise.reject(abort);
      },
    },
    {
      name: 'reject string',
      fetchFn: (i, n) => (record(i, n), Promise.reject(MARK)),
    },
    {
      name: 'reject undefined',
      fetchFn: (i, n) => (record(i, n), Promise.reject(undefined)),
    },
    {
      name: 'throw sync',
      fetchFn: (i, n) => {
        record(i, n);
        throw new TypeError(`Invalid header ${MARK}`);
      },
    },
    {
      name: 'resolve null',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve(null as unknown as Response)
      ),
    },
    {
      name: 'resolve undefined',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve(undefined as unknown as Response)
      ),
    },
    {
      name: 'resolve string',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve(MARK as unknown as Response)
      ),
    },
    {
      name: 'ok=false',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: false,
          status: pick(rng, [400, 401, 403, 429, 500, 503]),
          json: () => Promise.resolve(payload),
        } as unknown as Response)
      ),
    },
    {
      name: 'ok=false json rejects',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new SyntaxError('bad gateway html')),
        } as unknown as Response)
      ),
    },
    {
      name: 'json missing',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({ ok: true } as unknown as Response)
      ),
    },
    {
      name: 'json throws sync',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: true,
          json: () => {
            throw new TypeError(`body used ${MARK}`);
          },
        } as unknown as Response)
      ),
    },
    {
      name: 'json returns payload (non-promise)',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: true,
          json: () => payload,
        } as unknown as Response)
      ),
    },
    {
      name: 'json returns undefined',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: true,
          json: () => undefined,
        } as unknown as Response)
      ),
    },
    {
      name: 'json rejects SyntaxError',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: true,
          json: () => Promise.reject(new SyntaxError('Unexpected token <')),
        } as unknown as Response)
      ),
    },
    {
      name: 'ok non-boolean truthy',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: pick(rng, ['false', 1, {}, [], -1]),
          json: () => Promise.resolve(payload),
        } as unknown as Response)
      ),
    },
    {
      name: 'ok non-boolean falsy',
      fetchFn: (i, n) => (
        record(i, n),
        Promise.resolve({
          ok: pick(rng, [0, '', null, undefined, Number.NaN]),
          json: () => Promise.resolve(payload),
        } as unknown as Response)
      ),
    },
  ];
  const v = pick(rng, variants);
  return {
    name: v.name,
    transparent: v.name === 'ok non-boolean truthy',
    calls,
    fetchFn: v.fetchFn,
  };
}

// ─── JSON-text corruption (campaign 3) ───────────────────────────────────────

function corruptJsonText(
  rng: Rng,
  text: string,
): { text: string; name: string } {
  const which = int(rng, 0, 13);
  switch (which) {
    case 0:
      return {
        text: text.slice(0, int(rng, 0, text.length - 1)),
        name: 'truncate',
      };
    case 1: {
      const at = int(rng, 0, text.length);
      return {
        text: text.slice(0, at) + '\u0000' + text.slice(at),
        name: 'insert NUL',
      };
    }
    case 2: {
      const at = int(rng, 0, text.length - 1);
      return {
        text:
          text.slice(0, at) +
          pick(rng, ['}', '{', ']', '[', '"', ',', ':']) +
          text.slice(at + 1),
        name: 'swap structural char',
      };
    }
    case 3:
      return { text: '\uFEFF' + text, name: 'BOM prefix' };
    case 4:
      return {
        text: text + pick(rng, ['garbage', '{}', ',', ']', '\u0000']),
        name: 'trailing garbage',
      };
    case 5:
      return {
        text: text.replace('{', `{"__proto__":{"polluted":"${MARK}"},`),
        name: '__proto__ key in text',
      };
    case 6:
      return {
        text: text.replace(
          '{',
          `{"constructor":{"prototype":{"polluted":"${MARK}"}},`,
        ),
        name: 'constructor key in text',
      };
    case 7:
      return {
        text: text.replace(
          /"active":(true|false)/,
          `"active":${pick(rng, ['1e999', '-1e999', '-0', '1E400', '9007199254740993'])}`,
        ),
        name: 'active=numeric overflow literal',
      };
    case 8:
      return {
        text: text.replace(
          /"active":(true|false)/,
          `"active":${pick(rng, ['NaN', 'Infinity', 'undefined', '0x10', '.5', '01'])}`,
        ),
        name: 'active=invalid literal',
      };
    case 9: {
      const depth = int(rng, 100, 5000);
      return {
        text: text.replace(
          '"scopes":[',
          `"scopes":[${'['.repeat(depth)}${']'.repeat(depth)},`,
        ),
        name: `deep nesting ${depth}`,
      };
    }
    case 10:
      return {
        text: text.replace(
          /"scopes":/,
          `"scopes":${JSON.stringify(BIG_ASCII)},"scopes":`,
        ),
        name: 'duplicate key (last wins)',
      };
    case 11:
      return {
        text: pick(rng, [
          '',
          'null',
          '[]',
          '""',
          '0',
          'true',
          '<html>',
          'undefined',
          '{',
        ]),
        name: 'non-object document',
      };
    case 12:
      return {
        text: text.replace(
          /"lastActionAt":"[^"]*"/,
          `"lastActionAt":${JSON.stringify(BIG_NUL)}`,
        ),
        name: 'lastActionAt=64K NUL',
      };
    default: {
      const at = int(rng, 0, Math.max(0, text.length - 1));
      const flip = String.fromCharCode(int(rng, 0, 0x7f));
      return {
        text: text.slice(0, at) + flip + text.slice(at + 1),
        name: 'flip byte',
      };
    }
  }
}

// ─── Fixtures & invariants ───────────────────────────────────────────────────

const SESSION: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple',
};

const KNOWN_ERRORS = new Set<string>([
  'The consent server returned an invalid response.',
  'Consent settings are temporarily unavailable.',
  'Your consent change could not be saved. Nothing was changed.',
  'Sign in to change this setting. Nothing was changed.',
]);

const AVAILABILITIES: readonly ConsentAvailability[] = [
  'loading',
  'ready',
  'signed_out',
  'unavailable',
];

const STORE_KEYS = [
  'availability',
  'busy',
  'error',
  'hydrate',
  'lastActionAt',
  'modelTrainingActive',
  'setModelTrainingConsent',
];

const OBJECT_PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype).sort();
const ARRAY_PROTO_KEYS = Object.getOwnPropertyNames(Array.prototype).sort();

function resetStore(
  pre: Partial<{
    availability: ConsentAvailability;
    modelTrainingActive: boolean;
  }> = {},
) {
  useConsentStore.setState({
    availability: pre.availability ?? 'loading',
    modelTrainingActive: pre.modelTrainingActive ?? false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

function shapeViolations(): string[] {
  const out: string[] = [];
  const keys = Object.keys(useConsentStore.getState()).sort();
  if (keys.join(',') !== STORE_KEYS.join(','))
    out.push(`store keys ${keys.join(',')}`);
  if (
    Object.getOwnPropertyNames(Object.prototype).sort().join(',') !==
    OBJECT_PROTO_KEYS.join(',')
  ) {
    out.push('Object.prototype polluted');
  }
  if (
    Object.getOwnPropertyNames(Array.prototype).sort().join(',') !==
    ARRAY_PROTO_KEYS.join(',')
  ) {
    out.push('Array.prototype polluted');
  }
  if (({} as Record<string, unknown>)['polluted'] !== undefined)
    out.push('{} polluted');
  return out;
}

interface Observed {
  availability: ConsentAvailability;
  modelTrainingActive: unknown;
  lastActionAt: unknown;
  busy: unknown;
  error: unknown;
  threw: string | null;
  requests: { url: string; method: unknown; hasBody: boolean }[];
}

function observe(threw: string | null, calls: Envelope['calls']): Observed {
  const s = useConsentStore.getState();
  return {
    availability: s.availability,
    modelTrainingActive: s.modelTrainingActive,
    lastActionAt: s.lastActionAt,
    busy: s.busy,
    error: s.error,
    threw,
    requests: calls.map(c => ({
      url: c.input,
      method: c.init?.method,
      hasBody: c.init?.body !== undefined,
    })),
  };
}

function commonViolations(o: Observed): string[] {
  const v: string[] = [];
  if (o.threw !== null) v.push(`I1 threw: ${o.threw}`);
  if (o.busy !== false) v.push('I2 busy not false');
  if (!AVAILABILITIES.includes(o.availability))
    v.push(`I2 availability ${String(o.availability)}`);
  if (o.modelTrainingActive !== true && o.modelTrainingActive !== false) {
    v.push('I3 modelTrainingActive not strict boolean');
  }
  if (!(
    o.error === null ||
    (typeof o.error === 'string' && KNOWN_ERRORS.has(o.error))
  )) {
    v.push(`I4 error not fixed copy: ${JSON.stringify(o.error).slice(0, 80)}`);
  }
  if (typeof o.error === 'string' && o.error.includes(MARK))
    v.push('I4 reflected payload');
  if (!(o.lastActionAt === null || typeof o.lastActionAt === 'string')) {
    v.push('I7 lastActionAt type');
  }
  v.push(...shapeViolations());
  return v;
}

function expectedOutcome(env: Envelope, oracle: Oracle): Oracle {
  return env.transparent
    ? oracle
    : { kind: 'invalid', reason: `transport ${env.name}` };
}

interface Result {
  campaign: string;
  index: number;
  iterSeed: number;
  mutations: string[];
  envelope: string;
  expected: string;
  observed: Observed;
  violations: string[];
}

const results: Result[] = [];

function record(r: Result) {
  results.push(r);
  if (ONLY !== null) {
    console.log(
      JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v), 2),
    );
  }
}

function shouldRun(seed: number): boolean {
  return ONLY === null || ONLY === seed;
}

async function runHydrate(fetchFn: ConsentFetch): Promise<string | null> {
  try {
    await useConsentStore.getState().hydrate(fetchFn);
    return null;
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

async function runSet(
  granted: boolean,
  fetchFn: ConsentFetch,
): Promise<string | null> {
  try {
    await useConsentStore.getState().setModelTrainingConsent(granted, fetchFn);
    return null;
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

function hydrateViolations(o: Observed, expected: Oracle): string[] {
  const v = commonViolations(o);
  if (o.requests.length !== 1) v.push(`I5 ${o.requests.length} requests`);
  for (const r of o.requests) {
    if (r.url !== `${SESSION.apiBaseUrl}/v1/me/consent/status`)
      v.push(`I5 url ${r.url}`);
    if (r.method !== 'GET') v.push(`I5 method ${String(r.method)}`);
    if (r.hasBody) v.push('I5 GET with body');
  }
  if (expected.kind === 'valid') {
    if (o.availability !== 'ready') v.push(`I7 valid→${o.availability}`);
    if (o.modelTrainingActive !== expected.active)
      v.push('I3/I7 active mismatch');
    if (o.lastActionAt !== expected.lastActionAt)
      v.push('I7 lastActionAt mismatch');
    if (o.error !== null) v.push('I7 error on valid');
  } else {
    if (o.availability !== 'unavailable')
      v.push(`I7 invalid→${o.availability}`);
    if (o.modelTrainingActive !== false) v.push('I3 invalid but active');
    if (o.error === null) v.push('I7 invalid without error');
  }
  return v;
}

function setViolations(
  o: Observed,
  expected: Oracle,
  granted: boolean,
  pre: { availability: ConsentAvailability; modelTrainingActive: boolean },
): string[] {
  const v = commonViolations(o);
  if (o.requests.length !== 1) v.push(`I5 ${o.requests.length} requests`);
  for (const r of o.requests) {
    const path = granted ? '/v1/me/consent/grant' : '/v1/me/consent/withdraw';
    if (r.url !== `${SESSION.apiBaseUrl}${path}`) v.push(`I5 url ${r.url}`);
    if (r.method !== 'POST') v.push(`I5 method ${String(r.method)}`);
    if (!r.hasBody) v.push('I5 POST without body');
  }
  if (expected.kind === 'valid') {
    if (o.availability !== 'ready') v.push(`I7 valid→${o.availability}`);
    if (o.modelTrainingActive !== expected.active)
      v.push('I3/I7 active mismatch');
    if (o.lastActionAt !== expected.lastActionAt)
      v.push('I7 lastActionAt mismatch');
    if (o.error !== null) v.push('I7 error on valid');
  } else {
    if (o.error === null) v.push('I7 invalid without error');
    if (o.modelTrainingActive !== pre.modelTrainingActive)
      v.push('I7 invalid changed active');
    if (o.availability !== pre.availability)
      v.push('I7 invalid changed availability');
  }
  return v;
}

function bodyViolations(calls: Envelope['calls'], granted: boolean): string[] {
  const v: string[] = [];
  const init = calls[0]?.init;
  if (!init) return v;
  let body: unknown;
  try {
    body = JSON.parse(String(init.body)) as unknown;
  } catch {
    return ['I5 body not JSON'];
  }
  if (!isPlainRecord(body)) return ['I5 body not object'];
  if (body['scope'] !== 'model_training') v.push('I5 body.scope');
  if (granted && body['consentVersion'] !== MODEL_TRAINING_CONSENT_VERSION)
    v.push('I5 body.consentVersion');
  if (!granted && 'consentVersion' in body)
    v.push('I5 withdraw carries consentVersion');
  if (typeof body['device'] !== 'string') v.push('I5 body.device');
  const headers = init.headers as Record<string, string> | undefined;
  if (headers?.['Authorization'] !== `Bearer ${SESSION.bearerToken}`)
    v.push('I5 Authorization');
  return v;
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

describe('consentStore boundary/malformed stress', () => {
  beforeEach(() => {
    clearApiSession();
    resetStore();
  });

  afterAll(() => {
    const broken = results.filter(r => r.violations.length > 0);
    const byCampaign: Record<
      string,
      { executed: number; held: number; broken: number }
    > = {};
    for (const r of results) {
      const c = (byCampaign[r.campaign] ??= {
        executed: 0,
        held: 0,
        broken: 0,
      });
      c.executed++;
      if (r.violations.length > 0) c.broken++;
      else c.held++;
    }
    const summary = {
      unit: 'apps/mobile/src/state/consentStore.ts',
      lens: 'boundary-malformed',
      baseSeed: BASE_SEED,
      iterPerCampaign: ITER,
      executed: results.length,
      held: results.length - broken.length,
      broken: broken.length,
      byCampaign,
      replay:
        'STRESS_SEED=<baseSeed> STRESS_ONLY=<iterSeed> npx jest --ci __tests__/stress/consentStoreBoundaryMalformed.stress.test.ts',
      brokenSeeds: broken.map(r => ({
        campaign: r.campaign,
        iterSeed: r.iterSeed,
        mutations: r.mutations,
        envelope: r.envelope,
        violations: r.violations,
      })),
    };
    mkdirSync(OUT_DIR, { recursive: true });
    const safe = (_k: string, v: unknown) =>
      typeof v === 'bigint' ? `${v}n` : v;
    writeFileSync(
      join(OUT_DIR, 'summary.json'),
      JSON.stringify(summary, safe, 2),
    );
    writeFileSync(join(OUT_DIR, 'results.json'), JSON.stringify(results, safe));
  });

  it('C1 hydrate: mutated payloads through a hostile transport never break the invariants', async () => {
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(1, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const payload = validPayload(rng);
      const mutations: string[] = [];
      const count = int(rng, 0, 4);
      for (let m = 0; m < count; m++)
        mutations.push(mutatePayload(rng, payload));
      const finalPayload = finalizePayload(payload);
      const oracle = oracleParse(finalPayload);
      const env = makeEnvelope(rng, finalPayload);
      const expected = expectedOutcome(env, oracle);

      establishApiSession(SESSION);
      resetStore();
      const threw = await runHydrate(env.fetchFn);
      const observed = observe(threw, env.calls);
      record({
        campaign: 'C1-hydrate-payload',
        index,
        iterSeed: seed,
        mutations,
        envelope: env.name,
        expected:
          expected.kind === 'valid'
            ? `valid(active=${expected.active})`
            : `invalid(${expected.reason})`,
        observed,
        violations: hydrateViolations(observed, expected),
      });
    }
  });

  it('C2 setModelTrainingConsent: mutated write responses never break the invariants', async () => {
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(2, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const granted = rng() < 0.5;
      const pre = {
        availability: pick(rng, ['ready', 'loading', 'unavailable'] as const),
        modelTrainingActive: rng() < 0.5,
      };
      const payload = validPayload(rng);
      const mutations: string[] = [];
      const count = int(rng, 0, 4);
      for (let m = 0; m < count; m++)
        mutations.push(mutatePayload(rng, payload));
      const finalPayload = finalizePayload(payload);
      const oracle = oracleParse(finalPayload);
      const env = makeEnvelope(rng, finalPayload);
      const expected = expectedOutcome(env, oracle);

      establishApiSession(SESSION);
      resetStore(pre);
      const threw = await runSet(granted, env.fetchFn);
      const observed = observe(threw, env.calls);
      record({
        campaign: 'C2-set-payload',
        index,
        iterSeed: seed,
        mutations: [
          `granted=${granted}`,
          `pre=${pre.availability}/${pre.modelTrainingActive}`,
          ...mutations,
        ],
        envelope: env.name,
        expected:
          expected.kind === 'valid'
            ? `valid(active=${expected.active})`
            : `invalid(${expected.reason})`,
        observed,
        violations: [
          ...setViolations(observed, expected, granted, pre),
          ...bodyViolations(env.calls, granted),
        ],
      });
    }
  });

  it('C3 hydrate: corrupted JSON text parsed like Response.json() never breaks the invariants', async () => {
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(3, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const payload = validPayload(rng);
      let text = JSON.stringify(payload);
      const mutations: string[] = [];
      const count = int(rng, 1, 3);
      for (let m = 0; m < count; m++) {
        const c = corruptJsonText(rng, text);
        text = c.text;
        mutations.push(c.name);
      }
      let parsed: unknown;
      let syntaxError = false;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        syntaxError = true;
      }
      const oracle: Oracle = syntaxError
        ? { kind: 'invalid', reason: 'syntax' }
        : oracleParse(parsed);
      // The transport is always a 200 here — the corruption is the body.
      const env = makeEnvelope(mulberry32(0), parsed, text);
      const expected = expectedOutcome(env, oracle);

      establishApiSession(SESSION);
      resetStore();
      const threw = await runHydrate(env.fetchFn);
      const observed = observe(threw, env.calls);
      record({
        campaign: 'C3-hydrate-json-text',
        index,
        iterSeed: seed,
        mutations,
        envelope: env.name,
        expected:
          expected.kind === 'valid'
            ? `valid(active=${expected.active})`
            : `invalid(${expected.reason})`,
        observed,
        violations: hydrateViolations(observed, expected),
      });
    }
  });

  it('C4 hostile session fields and non-boolean `granted` never throw or leak', async () => {
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(4, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const session: ApiSession = {
        apiBaseUrl:
          rng() < 0.5
            ? SESSION.apiBaseUrl
            : (pick(rng, HOSTILE_STRINGS) as string),
        bearerToken:
          rng() < 0.5
            ? SESSION.bearerToken
            : (pick(rng, HOSTILE_STRINGS) as string),
        canonicalAppUserId:
          rng() < 0.5
            ? SESSION.canonicalAppUserId
            : (pick(rng, HOSTILE_STRINGS) as string),
        provider: pick(rng, ['apple', 'google'] as const),
        refreshToken:
          rng() < 0.3
            ? (hostileValue(rng) as string | null | undefined)
            : undefined,
        bearerExpiresAtMs:
          rng() < 0.3
            ? (hostileValue(rng) as number | null | undefined)
            : undefined,
      };
      const grantedRaw: unknown = rng() < 0.4 ? rng() < 0.5 : hostileValue(rng);
      const granted = grantedRaw as boolean;
      const payload = validPayload(rng);
      const oracle = oracleParse(payload);
      const env = makeEnvelope(mulberry32(0), payload);
      const useHydrate = rng() < 0.4;

      establishApiSession(session);
      resetStore({ availability: 'ready', modelTrainingActive: false });
      const threw = useHydrate
        ? await runHydrate(env.fetchFn)
        : await runSet(granted, env.fetchFn);
      const observed = observe(threw, env.calls);
      const v = commonViolations(observed);
      if (observed.requests.length !== 1)
        v.push(`I5 ${observed.requests.length} requests`);
      const expectedPath = useHydrate
        ? '/v1/me/consent/status'
        : grantedRaw
          ? '/v1/me/consent/grant'
          : '/v1/me/consent/withdraw';
      const req = observed.requests[0];
      if (req && req.url !== `${session.apiBaseUrl}${expectedPath}`)
        v.push('I5 url not base+path verbatim');
      const headers = env.calls[0]?.init?.headers as
        Record<string, string> | undefined;
      if (
        headers &&
        headers['Authorization'] !== `Bearer ${session.bearerToken}`
      ) {
        v.push('I5 Authorization not verbatim');
      }
      if (oracle.kind === 'valid') {
        if (observed.availability !== 'ready')
          v.push(`I7 valid→${observed.availability}`);
        if (observed.modelTrainingActive !== oracle.active)
          v.push('I3/I7 active mismatch');
      }
      // The current session is unchanged during the call, so a response is
      // never stale: the state must never fall back to signed_out.
      if (observed.availability === 'signed_out')
        v.push('I7 signed_out with live session');
      record({
        campaign: 'C4-arguments',
        index,
        iterSeed: seed,
        mutations: [
          useHydrate
            ? 'hydrate'
            : `set(granted=${typeof grantedRaw}:${describeValue(grantedRaw)})`,
          `apiBaseUrl.len=${session.apiBaseUrl.length}`,
          `bearer.len=${session.bearerToken.length}`,
          `uid.len=${session.canonicalAppUserId.length}`,
        ],
        envelope: env.name,
        expected:
          oracle.kind === 'valid'
            ? `valid(active=${oracle.active})`
            : `invalid(${oracle.reason})`,
        observed,
        violations: v,
      });
    }
  });

  it('C5 unicode normalization pairs and confusables of scope names are never accepted as model_training', async () => {
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(5, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const c = confusableScope(rng);
      const row = validRow(rng, c.value);
      row['active'] = true;
      const others = SCOPES.filter(s => s !== 'model_training').map(s =>
        validRow(rng, s),
      );
      const payload: Payload = {
        subjectPseudonym: null,
        scopes: rng() < 0.5 ? [row, ...others] : [...others, row],
      };
      const oracle = oracleParse(payload);
      const env = makeEnvelope(mulberry32(0), payload);

      establishApiSession(SESSION);
      resetStore();
      const threw = await runHydrate(env.fetchFn);
      const observed = observe(threw, env.calls);
      const v = hydrateViolations(observed, oracle);
      // Only the byte-identical scope name may switch consent ON.
      if (!c.identical && observed.modelTrainingActive !== false)
        v.push('I3 confusable accepted as model_training');
      if (c.identical && observed.modelTrainingActive !== true)
        v.push('I7 identical scope not applied');
      record({
        campaign: 'C5-unicode-scope',
        index,
        iterSeed: seed,
        mutations: [
          `scope=${JSON.stringify(c.value).slice(0, 60)}`,
          `identical=${c.identical}`,
        ],
        envelope: env.name,
        expected:
          oracle.kind === 'valid'
            ? `valid(active=${oracle.active})`
            : `invalid(${oracle.reason})`,
        observed,
        violations: v,
      });
    }
  });

  it('C7 single-field type coercion on the model_training row is never accepted', async () => {
    const coercible: readonly unknown[] = [
      'true',
      'false',
      'TRUE',
      '1',
      '0',
      '',
      1,
      0,
      -0,
      Number.NaN,
      BigInt(1),
      Object(true),
      Object(false),
      [true],
      [false],
      { valueOf: () => true },
      { toString: () => 'true' },
      null,
      undefined,
      Symbol.for('true'),
      () => true,
    ];
    const fields = [...ROW_FIELDS, 'subjectPseudonym'] as const;
    for (let index = 0; index < ITER; index++) {
      const seed = iterSeed(7, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const useHydrate = rng() < 0.5;
      const training = validRow(rng, 'model_training');
      const field = pick(rng, fields);
      const value = rng() < 0.6 ? pick(rng, coercible) : hostileValue(rng);
      const payload: Payload = {
        subjectPseudonym: rng() < 0.5 ? null : 'pseudo',
        scopes: [
          validRow(rng, 'video_analysis'),
          training,
          validRow(rng, 'evaluation_telemetry'),
        ],
      };
      if (field === 'subjectPseudonym') payload['subjectPseudonym'] = value;
      else training[field] = value;
      const oracle = oracleParse(payload);
      const env = makeEnvelope(mulberry32(0), payload);
      const granted = rng() < 0.5;
      const pre = {
        availability: 'ready' as const,
        modelTrainingActive: rng() < 0.5,
      };

      establishApiSession(SESSION);
      resetStore(useHydrate ? undefined : pre);
      const threw = useHydrate
        ? await runHydrate(env.fetchFn)
        : await runSet(granted, env.fetchFn);
      const observed = observe(threw, env.calls);
      record({
        campaign: 'C7-field-coercion',
        index,
        iterSeed: seed,
        mutations: [
          useHydrate
            ? 'hydrate'
            : `set(granted=${granted}) pre=${pre.availability}/${pre.modelTrainingActive}`,
          `model_training.${field}=${typeof value}:${describeValue(value)}`,
        ],
        envelope: env.name,
        expected:
          oracle.kind === 'valid'
            ? `valid(active=${oracle.active})`
            : `invalid(${oracle.reason})`,
        observed,
        violations: useHydrate
          ? hydrateViolations(observed, oracle)
          : setViolations(observed, oracle, granted, pre),
      });
    }
  });

  it('C6 no session: neither action performs a request, whatever arrives', async () => {
    const n = Math.max(1, Math.floor(ITER / 10));
    for (let index = 0; index < n; index++) {
      const seed = iterSeed(6, index);
      if (!shouldRun(seed)) continue;
      const rng = mulberry32(seed);
      const payload = finalizePayload(
        (() => {
          const p = validPayload(rng);
          mutatePayload(rng, p);
          return p;
        })(),
      );
      const env = makeEnvelope(rng, payload);
      const granted = hostileValue(rng) as boolean;
      clearApiSession();
      resetStore({ availability: 'ready', modelTrainingActive: true });
      const useHydrate = rng() < 0.5;
      const threw = useHydrate
        ? await runHydrate(env.fetchFn)
        : await runSet(granted, env.fetchFn);
      const observed = observe(threw, env.calls);
      const v = commonViolations(observed);
      if (observed.requests.length !== 0) v.push('I5 request without session');
      if (observed.availability !== 'signed_out')
        v.push(`I7 no session→${observed.availability}`);
      if (observed.modelTrainingActive !== false)
        v.push('I3 no session but active');
      if (useHydrate ? observed.error !== null : observed.error === null)
        v.push('I7 signed-out error copy');
      record({
        campaign: 'C6-no-session',
        index,
        iterSeed: seed,
        mutations: [useHydrate ? 'hydrate' : 'set'],
        envelope: env.name,
        expected: 'signed_out, no request',
        observed,
        violations: v,
      });
    }
  });

  it('every executed iteration HELD (see artifacts/stress/… for the seed table)', () => {
    const broken = results.filter(r => r.violations.length > 0);
    const preview = broken
      .slice(0, 10)
      .map(
        r =>
          `${r.campaign} seed=${r.iterSeed} [${r.mutations.join('; ')}] via ${r.envelope}: ${r.violations.join(' | ')}`,
      )
      .join('\n');
    expect(results.length).toBeGreaterThan(0);
    expect(`${broken.length} broken\n${preview}`).toBe('0 broken\n');
  });
});
