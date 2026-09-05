/**
 * STRESS — mod-sync-runtime, lens `boundary-malformed`.
 *
 * Seeded malformed/boundary inputs against the REAL sync runtime
 * (`configureSyncRuntime` / `triggerOutboxSync` / `drainOutbox`), the real
 * HTTP transport (`createTransport` over a mocked `fetch`) and the pure
 * offline-capability helpers, under Jest fake timers with an in-memory
 * LocalDb and a fake server.
 *
 * Campaigns (each runs STRESS_ITER seeds; default keeps the suite fast):
 *   retry-delay          nextSyncRetryDelayMs over in-domain boundary inputs
 *   app-state-flap       AppState storms with malformed state values +
 *                        reconnect (configure/clear) flaps
 *   outbox-malformed     outbox rows with malformed/truncated/wrong-type/
 *                        prototype-key/numeric-edge/null-byte/64KB/traversal/
 *                        future-schema/empty/unicode payloads drained to
 *                        quiescence next to well-formed control rows
 *   server-malformed     transport returning malformed shapes, typed 4xx/5xx,
 *                        non-Error throws, undefined
 *   transport-boundary   real createTransport + fetch mock: malformed ids in
 *                        URLs, malformed bodies, malformed response bodies
 *   queue-status         deriveUploadQueueStatus over numeric edge attempts
 *   capability-id        capabilityDependency / capabilitiesByDependency over
 *                        malformed ids
 *   configure-session    configureSyncRuntime over malformed ApiSession fields
 *
 * Invariants (hard asserts): no throw escapes a store/handler/trigger; no
 * unhandled rejection; Object.prototype is never polluted; an outbox row is
 * deleted only after the server accepted it (never a write for a malformed
 * row); attempts never exceed OUTBOX_MAX_ATTEMPTS; foreign-owner rows are
 * byte-identical after every drain; no orphaned transaction; ≤ 1 retry timer
 * armed; drains never overlap; well-formed control rows still sync next to
 * malformed siblings; no row is retried forever without burning its attempt
 * budget (except the by-design `shot.session_not_found` wait); the transport
 * only ever throws `ApiError` for a malformed server response.
 *
 * Env:
 *   STRESS_ITER=<n>      seeds per campaign (default 8)
 *   STRESS_SEED=<n>      replay exactly one seed in every campaign
 *   STRESS_CAMPAIGN=<c>  run only that campaign
 *   STRESS_RUN_ID=<id>   artifact dir under
 *                        artifacts/stress/mod-sync-runtime-boundary-malformed/
 *
 * Replay a failing line:
 *   STRESS_SEED=<seed> STRESS_CAMPAIGN=<campaign> \
 *     npx jest __tests__/stress/syncRuntimeBoundaryMalformed.stress
 *
 * Results: `<artifact dir>/events.ndjson` (one line per iteration, appended
 * as it runs) and `<artifact dir>/results.json` (seed → outcome table).
 */
import { AppState } from 'react-native';
import { getDb } from '../../src/data/db';
import { ApiError, createTransport } from '../../src/data/api';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
  drainOutbox,
  type SyncTransport,
} from '../../src/data/sync';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  nextSyncRetryDelayMs,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  OFFLINE_CAPABILITY_MAP_V1,
  capabilitiesByDependency,
  capabilityDependency,
  deriveUploadQueueStatus,
  type CapabilityId,
  type NetworkDependency,
  type OutboxRowStatus,
} from '../../src/data/offlineCapabilities';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  createFakeLocalDb,
  type FakeLocalDb,
  type OutboxRow,
} from '../../testing/xcBehavioral/fakeLocalDb';
import { randomInt, seededRandom } from '../../testing/xcBehavioral/evidence';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));
jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, createTransport: jest.fn() };
});

// ─── Node shims (mobile tsconfig excludes node typings) ─────────────────────
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  on(event: string, handler: (reason: unknown) => void): void;
  off(event: string, handler: (reason: unknown) => void): void;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Evidence sink ──────────────────────────────────────────────────────────
const SUITE = 'mod-sync-runtime-boundary-malformed';
const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';
const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? '8'));
/** `STRESS_SEED=123` or `STRESS_SEED=123,456` replays only those seeds. */
const PINNED_SEED = process.env['STRESS_SEED'];
/** `STRESS_CAMPAIGN=name` or `STRESS_CAMPAIGN=name1,name2`. */
const ONLY_CAMPAIGN = process.env['STRESS_CAMPAIGN'];
const ONLY_CAMPAIGNS: ReadonlySet<string> | null = ONLY_CAMPAIGN
  ? new Set(ONLY_CAMPAIGN.split(',').map(s => s.trim()))
  : null;

function artifactDir(): string {
  return path.join(
    path.resolve(__dirname, '..', '..', '..', '..'),
    'artifacts',
    'stress',
    SUITE,
    RUN_ID,
  );
}

type Outcome = 'HELD' | 'BROKEN';

interface IterationRecord {
  campaign: string;
  seed: number;
  outcome: Outcome;
  /** Seed-derived plan, enough to replay by hand. */
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  error?: string;
  durationMs: number;
}

const records: IterationRecord[] = [];

function campaignSeeds(campaign: string): number[] {
  if (ONLY_CAMPAIGNS && !ONLY_CAMPAIGNS.has(campaign)) return [];
  if (PINNED_SEED !== undefined && PINNED_SEED !== '') {
    return PINNED_SEED.split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isFinite(n));
  }
  let hash = 2166136261;
  for (const ch of `${SUITE}:${campaign}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < ITER; i += 1) {
    seeds.push((hash + i * 2654435761) >>> 0);
  }
  return seeds;
}

/** Truncate long strings so the evidence line stays readable; the seed is the
 * replay key, not the rendered input. */
function compact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > 80
      ? `${JSON.stringify(value.slice(0, 40))}…(len ${value.length})`
      : value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    return depth > 3
      ? `[array len ${value.length}]`
      : value.slice(0, 12).map(v => compact(v, depth + 1));
  }
  if (value && typeof value === 'object') {
    if (depth > 3) return '[object]';
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).slice(0, 24)) {
      out[key] = compact((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  return value;
}

/** Wall-clock that survives `jest.useFakeTimers()` (which fakes Date). */
const REAL_NOW: () => number = (() => {
  const realDateNow = Date.now.bind(Date);
  return () => realDateNow();
})();

async function runIteration(
  campaign: string,
  seed: number,
  inputs: Record<string, unknown>,
  body: (
    observe: (partial: Record<string, unknown>) => void,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<void> {
  const started = REAL_NOW();
  // Production code draws retry jitter from Math.random; pin it to the seed
  // so the whole iteration (including which timer fires under a partial
  // advance) replays byte-for-byte from `seed`.
  const jitterRandom = seededRandom((seed ^ 0x9e3779b9) >>> 0);
  const randomSpy = jest
    .spyOn(Math, 'random')
    .mockImplementation(() => jitterRandom());
  // `observe` lets a body record what it saw BEFORE asserting, so a BROKEN
  // line still carries the observation and not just the matcher message.
  let observed: Record<string, unknown> = {};
  let error: string | undefined;
  try {
    observed = {
      ...observed,
      ...(await body(partial => {
        observed = { ...observed, ...partial };
      })),
    };
  } catch (caught) {
    error =
      caught instanceof Error
        ? `${caught.name}: ${caught.message}`
        : String(caught);
    throw caught;
  } finally {
    randomSpy.mockRestore();
    const record: IterationRecord = {
      campaign,
      seed,
      outcome: error === undefined ? 'HELD' : 'BROKEN',
      inputs: compact(inputs) as Record<string, unknown>,
      observed: compact(observed) as Record<string, unknown>,
      ...(error !== undefined ? { error } : {}),
      durationMs: Math.round(REAL_NOW() - started),
    };
    records.push(record);
    fs.mkdirSync(artifactDir(), { recursive: true });
    fs.appendFileSync(
      path.join(artifactDir(), 'events.ndjson'),
      `${JSON.stringify(record)}\n`,
    );
  }
}

afterAll(() => {
  const byCampaign: Record<string, { held: number; broken: number }> = {};
  for (const r of records) {
    const bucket = (byCampaign[r.campaign] ??= { held: 0, broken: 0 });
    if (r.outcome === 'HELD') bucket.held += 1;
    else bucket.broken += 1;
  }
  fs.mkdirSync(artifactDir(), { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir(), 'results.json'),
    JSON.stringify(
      {
        suite: SUITE,
        runId: RUN_ID,
        iterPerCampaign: ITER,
        pinnedSeed: PINNED_SEED ?? null,
        onlyCampaign: ONLY_CAMPAIGN ?? null,
        executed: records.length,
        held: records.filter(r => r.outcome === 'HELD').length,
        broken: records.filter(r => r.outcome === 'BROKEN').length,
        byCampaign,
        failingSeeds: records
          .filter(r => r.outcome === 'BROKEN')
          .map(r => ({ campaign: r.campaign, seed: r.seed, error: r.error })),
        iterations: records.map(r => ({
          campaign: r.campaign,
          seed: r.seed,
          outcome: r.outcome,
          ...(r.error !== undefined ? { error: r.error } : {}),
          inputs: r.inputs,
          observed: r.observed,
          durationMs: r.durationMs,
        })),
      },
      null,
      2,
    ),
  );
});

// ─── Malformed input generators ─────────────────────────────────────────────
type Random = () => number;

function pick<T>(random: Random, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const OWNER_A = canonicalDataOwner(USER_A);
const OWNER_B = canonicalDataOwner(USER_B);

const NFC_E_ACUTE = '\u00e9';
const NFD_E_ACUTE = 'e\u0301';

const MALFORMED_STRINGS: ReadonlyArray<() => string> = [
  () => '',
  () => ' ',
  () => '\t\n\r',
  () => '\u0000',
  () => 'shot\u0000id',
  () => '\u0000'.repeat(64),
  () => '../../etc/passwd',
  () => '..%2F..%2Fadmin',
  () => '/v1/admin/finalize',
  () => 'x/../../y',
  () => '?redirect=1',
  () => '#fragment',
  () => 'a b',
  () => `${NFC_E_ACUTE}shot`,
  () => `${NFD_E_ACUTE}shot`,
  () => 'ﬁle',
  () => '\u202Eabc',
  () => '\u200b\u200c\u200d',
  () => '👨‍👩‍👧‍👦',
  () => '\uD800',
  () => '\uDFFF\uD800',
  () => '\uFEFFbom',
  () => 'a'.repeat(65_536),
  () => 'a'.repeat(65_537),
  () => 'é'.repeat(32_768),
  () => '𝔘'.repeat(16_384),
  () => '👨‍👩‍👧‍👦'.repeat(6_000),
  () => '__proto__',
  () => 'constructor',
  () => 'prototype',
  () => 'toString',
  () => 'hasOwnProperty',
  () => 'undefined',
  () => 'null',
  () => 'NaN',
  () => '1e999',
  () => '-0',
  () => '{"a":1}',
  () => '[]',
  () => "'; DROP TABLE outbox;--",
  () => USER_A.toUpperCase(),
  () => ` ${USER_A} `,
  () => '00000000-0000-0000-0000-000000000000',
  () => 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  () => '11111111-1111-4111-8111-11111111111',
  () => '11111111-1111-4111-8111-1111111111111',
  () => '%00',
  () => '%2e%2e%2f',
  () => 'shot-' + 'z'.repeat(250),
];

function malformedString(random: Random): string {
  return pick(random, MALFORMED_STRINGS)();
}

const EDGE_NUMBERS: readonly number[] = [
  NaN,
  Infinity,
  -Infinity,
  -0,
  0,
  -1,
  101,
  1e308,
  -1e308,
  2 ** 53,
  2 ** 53 + 1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE,
  5e-324,
  0.1 + 0.2,
  1e21,
  -1e21,
  2 ** 31,
  -(2 ** 31) - 1,
  4294967296,
  70.5,
];

function edgeNumber(random: Random): number {
  return pick(random, EDGE_NUMBERS);
}

/** Wrong-type / empty / nested replacement values. */
function wrongTypeValue(random: Random): unknown {
  return pick<() => unknown>(random, [
    () => null,
    () => undefined,
    () => true,
    () => false,
    () => [],
    () => ({}),
    () => [[]],
    () => [{}],
    () => [null],
    () => ({ nested: { deeper: { deepest: [1, 2, 3] } } }),
    () => edgeNumber(random),
    () => malformedString(random),
    () => ({ __proto__: { polluted: true } }),
    () => ({ constructor: { prototype: { polluted: true } } }),
    () => Array.from({ length: 1000 }, (_, i) => i),
  ])();
}

function validShot(id: string, sessionId: string | null) {
  return {
    id,
    sessionId,
    shotType: 'drive',
    cameraView: 'side',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { contactMs: 100 },
    overallScore: 70,
    analysisConfidence: 0.9,
    resultKind: 'scored',
    source: 'real',
    phases: [],
    checkpoints: [
      {
        key: 'paddle_prep',
        score: 70,
        confidence: 0.9,
        band: 'good',
        direction: null,
        severity: 'none',
        applicable: true,
      },
    ],
    versionVector: { model: 'm1', pipeline: 'p1', schema: 1 },
    analysisPermitId: `permit-${id}`,
  };
}

const SHOT_KEYS = Object.keys(validShot('k', null));

type PayloadStrategy =
  | 'valid'
  | 'field-wrong-type'
  | 'field-edge-number'
  | 'field-malformed-string'
  | 'field-deleted'
  | 'permit-malformed'
  | 'id-malformed'
  | 'checkpoints-malformed'
  | 'future-schema'
  | 'proto-key-text'
  | 'truncated'
  | 'null-byte-injected'
  | 'primitive-json'
  | 'empty-structure'
  | 'invalid-json'
  | 'oversized'
  | 'deep-nesting'
  | 'duplicate-id';

const PAYLOAD_STRATEGIES: readonly PayloadStrategy[] = [
  'valid',
  'valid',
  'valid',
  'field-wrong-type',
  'field-edge-number',
  'field-malformed-string',
  'field-deleted',
  'permit-malformed',
  'id-malformed',
  'checkpoints-malformed',
  'future-schema',
  'proto-key-text',
  'truncated',
  'null-byte-injected',
  'primitive-json',
  'empty-structure',
  'invalid-json',
  'oversized',
  'deep-nesting',
  'duplicate-id',
];

interface GeneratedRow {
  kind: string;
  strategy: string;
  /** Raw text stored in outbox.payload. */
  payload: string;
  /** Whether the row is a well-formed control row the server must accept. */
  control: boolean;
  /** The shot/session id embedded, when known. */
  id: string | null;
  sessionId: string | null;
}

function shotPayloadText(
  random: Random,
  strategy: PayloadStrategy,
  id: string,
  sessionId: string | null,
  previousId: string | null,
): { payload: string; id: string | null } {
  const base: Record<string, unknown> = validShot(id, sessionId);
  const key = pick(random, SHOT_KEYS);
  const embedded = () => (typeof base['id'] === 'string' ? base['id'] : null);
  switch (strategy) {
    case 'valid':
      return { payload: JSON.stringify(base), id };
    case 'field-wrong-type':
      base[key] = wrongTypeValue(random);
      return { payload: JSON.stringify(base), id: embedded() };
    case 'field-edge-number': {
      const n = edgeNumber(random);
      // Raw text so 1e999 / -0 survive (JSON.stringify would emit null / 0).
      const text = JSON.stringify(base).replace(
        `"${key}":${JSON.stringify(base[key])}`,
        `"${key}":${Number.isFinite(n) ? String(n) : n > 0 ? '1e999' : n < 0 ? '-1e999' : '-0'}`,
      );
      return { payload: text, id: key === 'id' ? null : id };
    }
    case 'field-malformed-string':
      base[key] = malformedString(random);
      return { payload: JSON.stringify(base), id: embedded() };
    case 'field-deleted':
      delete base[key];
      return { payload: JSON.stringify(base), id: embedded() };
    case 'permit-malformed':
      base['analysisPermitId'] = pick<unknown>(random, [
        '',
        '   ',
        null,
        undefined,
        7,
        [],
        {},
        malformedString(random),
      ]);
      return { payload: JSON.stringify(base), id };
    case 'id-malformed': {
      const bad = pick<unknown>(random, [
        malformedString(random),
        edgeNumber(random),
        null,
        [],
        {},
      ]);
      base['id'] = bad;
      return { payload: JSON.stringify(base), id: embedded() };
    }
    case 'checkpoints-malformed':
      base['checkpoints'] = pick<unknown>(random, [
        null,
        'checkpoints',
        {},
        [null],
        [1, 2, 3],
        [{ key: malformedString(random), score: edgeNumber(random) }],
        Array.from({ length: 500 }, () => ({})),
      ]);
      return { payload: JSON.stringify(base), id };
    case 'future-schema':
      base['versionVector'] = { model: 'm99', pipeline: 'p99', schema: 999 };
      base['schemaVersion'] = 999;
      base['unknownFutureField'] = { flag: true };
      return { payload: JSON.stringify(base), id };
    case 'proto-key-text': {
      const text = JSON.stringify(base);
      const injected = pick(random, [
        '"__proto__":{"polluted":true},',
        '"constructor":{"prototype":{"polluted":true}},',
        '"__proto__":null,',
        '"prototype":{"polluted":true},',
      ]);
      return { payload: `{${injected}${text.slice(1)}`, id };
    }
    case 'truncated': {
      const text = JSON.stringify(base);
      return {
        payload: text.slice(0, randomInt(random, 0, text.length - 1)),
        id: null,
      };
    }
    case 'null-byte-injected': {
      const text = JSON.stringify(base);
      const at = randomInt(random, 0, text.length);
      return {
        payload: `${text.slice(0, at)}\u0000${text.slice(at)}`,
        id: null,
      };
    }
    case 'primitive-json':
      return {
        payload: pick(random, [
          'null',
          '1',
          '"shot"',
          'true',
          '-0',
          '1e999',
          '0',
        ]),
        id: null,
      };
    case 'empty-structure':
      return {
        payload: pick(random, ['{}', '[]', '[{}]', '{"id":{}}']),
        id: null,
      };
    case 'invalid-json':
      return {
        payload: pick(random, [
          'NaN',
          'Infinity',
          '{id:1}',
          "{'id':'x'}",
          '{"id":"x",}',
          'undefined',
          '\uFEFF{}',
          '{"id":"x"} trailing',
          '{"a":1e}',
          '',
        ]),
        id: null,
      };
    case 'oversized':
      base[pick(random, ['source', 'phases', 'timestamps', 'shotType'])] = pick(
        random,
        [
          'a'.repeat(65_536),
          'é'.repeat(65_536),
          Array.from({ length: 5_000 }, (_, i) => `p${i}`),
        ],
      );
      return { payload: JSON.stringify(base), id };
    case 'deep-nesting': {
      // Spliced as text: V8's JSON.parse is iterative (any depth parses) but
      // JSON.stringify recurses and overflows the stack around depth ~4k.
      const depth = randomInt(random, 100, 20_000);
      const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
      const text = JSON.stringify(base).replace(
        '"phases":[]',
        `"phases":${nested}`,
      );
      return { payload: text, id };
    }
    case 'duplicate-id':
      if (previousId) base['id'] = previousId;
      base['analysisPermitId'] = `permit-${String(base['id'])}`;
      return { payload: JSON.stringify(base), id: String(base['id']) };
  }
}

const KIND_MUTATIONS: readonly string[] = [
  'shot.sync',
  'session.create',
  'session.finalize',
  'evaluation.trial',
  '',
  'unknown.kind',
  'SHOT.SYNC',
  'shot.sync\u0000',
  ' shot.sync',
  '__proto__',
  'constructor',
  'shot.sync/../session.create',
  'sh\u00f6t.sync',
];

function generateRows(random: Random, count: number): GeneratedRow[] {
  const rows: GeneratedRow[] = [];
  let previousShotId: string | null = null;
  let knownSession: string | null = null;
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    if (roll < 0.62) {
      const strategy = pick(random, PAYLOAD_STRATEGIES);
      const id = `shot-${i}`;
      const sessionId = knownSession && random() < 0.4 ? knownSession : null;
      const { payload, id: embedded } = shotPayloadText(
        random,
        strategy,
        id,
        sessionId,
        previousShotId,
      );
      rows.push({
        kind: 'shot.sync',
        strategy,
        payload,
        control: strategy === 'valid',
        id: embedded,
        sessionId,
      });
      if (strategy === 'valid') previousShotId = id;
    } else if (roll < 0.82) {
      const sessionKind =
        random() < 0.5 ? 'session.create' : 'session.finalize';
      const sessionId: string =
        sessionKind === 'session.finalize' && knownSession && random() < 0.6
          ? knownSession
          : `session-${i}`;
      const strategy = pick(random, [
        'valid',
        'valid',
        'id-malformed',
        'primitive-json',
        'empty-structure',
        'invalid-json',
        'truncated',
        'proto-key-text',
        'oversized',
      ] as const);
      let payload: string;
      let embedded: string | null = sessionId;
      switch (strategy) {
        case 'valid':
          payload = JSON.stringify({ id: sessionId, mode: 'practice_set' });
          break;
        case 'id-malformed': {
          const bad = pick<unknown>(random, [
            malformedString(random),
            edgeNumber(random),
            null,
            [],
            {},
          ]);
          payload = JSON.stringify({ id: bad, mode: 'practice_set' });
          embedded = typeof bad === 'string' ? bad : null;
          break;
        }
        case 'primitive-json':
          payload = pick(random, ['null', '1', '"session"', 'true', '-0']);
          embedded = null;
          break;
        case 'empty-structure':
          payload = pick(random, ['{}', '[]', '[{}]']);
          embedded = null;
          break;
        case 'invalid-json':
          payload = pick(random, ['{id:', '', 'NaN', '{"id":"s",}']);
          embedded = null;
          break;
        case 'truncated': {
          const text = JSON.stringify({ id: sessionId, mode: 'practice_set' });
          payload = text.slice(0, randomInt(random, 0, text.length - 1));
          embedded = null;
          break;
        }
        case 'proto-key-text':
          payload = `{"__proto__":{"polluted":true},"id":${JSON.stringify(sessionId)}}`;
          break;
        case 'oversized':
          payload = JSON.stringify({ id: sessionId, note: 'a'.repeat(65_536) });
          break;
      }
      const control =
        strategy === 'valid' &&
        (sessionKind === 'session.create' || sessionId === knownSession);
      if (strategy === 'valid' && sessionKind === 'session.create') {
        knownSession = sessionId;
      }
      rows.push({
        kind: sessionKind,
        strategy,
        payload,
        control,
        id: embedded,
        sessionId: null,
      });
    } else if (roll < 0.92) {
      const strategy = pick(random, [
        'valid',
        'id-malformed',
        'primitive-json',
        'invalid-json',
        'proto-key-text',
      ] as const);
      let trialId: string | null = `trial-${i}`;
      let payload: string;
      switch (strategy) {
        case 'valid':
          payload = JSON.stringify({ trialId, outcome: 'ok' });
          break;
        case 'id-malformed': {
          const bad = pick<unknown>(random, [
            malformedString(random),
            edgeNumber(random),
            null,
            [],
          ]);
          payload = JSON.stringify({ trialId: bad });
          trialId = typeof bad === 'string' ? bad : null;
          break;
        }
        case 'primitive-json':
          payload = pick(random, ['null', '0', '"t"']);
          trialId = null;
          break;
        case 'invalid-json':
          payload = pick(random, ['{trialId', '', 'Infinity']);
          trialId = null;
          break;
        case 'proto-key-text':
          payload = `{"__proto__":{"polluted":true},"trialId":${JSON.stringify(trialId)}}`;
          break;
      }
      rows.push({
        kind: 'evaluation.trial',
        strategy,
        payload,
        control: strategy === 'valid',
        id: trialId,
        sessionId: null,
      });
    } else {
      const kind = pick(
        random,
        KIND_MUTATIONS.filter(
          k =>
            k !== 'shot.sync' &&
            k !== 'session.create' &&
            k !== 'session.finalize' &&
            k !== 'evaluation.trial',
        ),
      );
      rows.push({
        kind,
        strategy: 'kind-malformed',
        payload: JSON.stringify(validShot(`shot-${i}`, null)),
        control: false,
        id: null,
        sessionId: null,
      });
    }
  }
  return rows;
}

// ─── Fake server ────────────────────────────────────────────────────────────
interface FakeServer {
  transport: SyncTransport;
  knownSessions: Set<string>;
  /** Shot ids the server accepted (only string ids can be accepted). */
  accepted: Set<string>;
  acceptedTrials: Set<string>;
  createdSessionCalls: unknown[];
  finalizedSessionIds: string[];
  received: unknown[];
  calls: number;
  inFlight: number;
  maxInFlight: number;
  /** Deterministic per-call behaviour override (server-malformed campaign). */
  nextBehaviour: (() => unknown) | null;
}

const MAX_ID_LENGTH = 256;

function isSaneId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    !value.includes('\u0000')
  );
}

/** Mirrors the edge function's contract shape: per-shot validation rejects
 * with a permanent code, an unknown session rejects with the transient code,
 * a batch never fails as a whole because of one bad entry. */
function fakeServer(): FakeServer {
  const server: FakeServer = {
    knownSessions: new Set(),
    accepted: new Set(),
    acceptedTrials: new Set(),
    createdSessionCalls: [],
    finalizedSessionIds: [],
    received: [],
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    nextBehaviour: null,
    transport: {
      async syncShots(shots) {
        server.calls += 1;
        server.inFlight += 1;
        server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
        try {
          if (server.nextBehaviour) {
            const behaviour = server.nextBehaviour;
            server.nextBehaviour = null;
            return behaviour() as Awaited<
              ReturnType<SyncTransport['syncShots']>
            >;
          }
          const acceptedIds: string[] = [];
          const rejected: Array<{ id: string; code: string; message: string }> =
            [];
          for (const raw of shots) {
            server.received.push(raw);
            const shot = raw as Record<string, unknown>;
            const id = isSaneId(shot['id']) ? shot['id'] : null;
            const score = shot['overallScore'];
            const valid =
              id !== null &&
              isSaneId(shot['analysisPermitId']) &&
              Array.isArray(shot['checkpoints']) &&
              (score === null ||
                (typeof score === 'number' &&
                  Number.isFinite(score) &&
                  score >= 0 &&
                  score <= 100)) &&
              (shot['sessionId'] === null || isSaneId(shot['sessionId']));
            if (!valid) {
              rejected.push({
                id: id ?? 'unknown',
                code: 'shot.invalid_payload',
                message: 'invalid',
              });
              continue;
            }
            if (
              typeof shot['sessionId'] === 'string' &&
              !server.knownSessions.has(shot['sessionId'])
            ) {
              rejected.push({
                id,
                code: SESSION_NOT_FOUND_REJECTION,
                message: 'unknown session',
              });
              continue;
            }
            acceptedIds.push(id);
            server.accepted.add(id);
          }
          return { acceptedIds, rejected };
        } finally {
          server.inFlight -= 1;
        }
      },
      async createSession(session) {
        server.createdSessionCalls.push(session);
        const record = session as Record<string, unknown> | null;
        if (!record || typeof record !== 'object' || !isSaneId(record['id'])) {
          throw new ApiError(400, 'validation.session', 'invalid session');
        }
        server.knownSessions.add(record['id']);
      },
      async finalizeSession(id) {
        server.finalizedSessionIds.push(id);
        if (!server.knownSessions.has(id)) {
          throw new ApiError(404, 'session.not_found', 'unknown session');
        }
      },
      async uploadEvaluationTrials(trials) {
        const acceptedTrialIds: string[] = [];
        const rejected: Array<{
          trialId: string;
          code: string;
          message: string;
        }> = [];
        for (const raw of trials) {
          const trial = raw as Record<string, unknown>;
          if (isSaneId(trial['trialId'])) {
            acceptedTrialIds.push(trial['trialId']);
            server.acceptedTrials.add(trial['trialId']);
          } else {
            rejected.push({
              trialId: String(trial['trialId']),
              code: 'evaluation.invalid_trial',
              message: 'invalid',
            });
          }
        }
        return { acceptedTrialIds, rejected };
      },
    },
  };
  return server;
}

function sessionFor(
  user: string,
  overrides: Partial<ApiSession> = {},
): ApiSession {
  return {
    apiBaseUrl: 'https://api.test',
    bearerToken: `bearer-${user.slice(0, 4)}`,
    canonicalAppUserId: user,
    provider: 'apple',
    ...overrides,
  };
}

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

async function advance(ms: number) {
  jest.advanceTimersByTime(ms);
  await flushMicrotasks();
}

/** Longest possible armed backoff: one advance always fires the retry. */
const ONE_BACKOFF_MS =
  Math.ceil(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO)) + 1;

const PROTOTYPE_KEYS_BEFORE = Object.getOwnPropertyNames(
  Object.prototype,
).sort();

function assertPrototypeClean() {
  expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(
    PROTOTYPE_KEYS_BEFORE,
  );
  expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  expect(
    ([] as unknown as Record<string, unknown>)['polluted'],
  ).toBeUndefined();
}

// ─── Shared runtime fixture ─────────────────────────────────────────────────
interface RuntimeFixture {
  fake: FakeLocalDb;
  server: FakeServer;
  appStateHandlers: Array<(state: unknown) => void>;
  listenersAdded: () => number;
  listenerRemovals: () => number;
  unhandled: unknown[];
}

function installRuntimeFixture(): RuntimeFixture {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  const fake = createFakeLocalDb();
  const server = fakeServer();
  const appStateHandlers: Array<(state: unknown) => void> = [];
  let added = 0;
  let removals = 0;
  (getDb as jest.Mock).mockReturnValue(fake.db);
  (createTransport as jest.Mock).mockImplementation(() => server.transport);
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      added += 1;
      appStateHandlers.push(handler as (state: unknown) => void);
      return {
        remove: () => {
          removals += 1;
        },
      } as ReturnType<typeof AppState.addEventListener>;
    });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);
  afterEachCleanups.push(() => process.off('unhandledRejection', onUnhandled));
  establishApiSession(sessionFor(USER_A));
  setActiveDataOwner(OWNER_A);
  return {
    fake,
    server,
    appStateHandlers,
    listenersAdded: () => added,
    listenerRemovals: () => removals,
    unhandled,
  };
}

const afterEachCleanups: Array<() => void> = [];

function teardownRuntimeFixture() {
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.clearAllTimers();
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const cleanup of afterEachCleanups.splice(0)) cleanup();
}

/** Store the payload TEXT verbatim (the fake's `push` JSON-encodes its
 * argument, which would hide truncation / invalid JSON / raw numerics). */
function pushRaw(
  fake: FakeLocalDb,
  kind: string,
  payloadText: string,
  owner: string,
): number {
  const id = fake.push(kind, null, owner);
  fake.outbox.find(row => row.id === id)!.payload = payloadText;
  return id;
}

function snapshotRows(rows: readonly OutboxRow[], owner: string): string {
  return JSON.stringify(rows.filter(r => r.owner_key === owner));
}

/** Rows the current owner has left in the outbox. */
function ownerRows(fake: FakeLocalDb, owner: string): OutboxRow[] {
  return fake.outbox.filter(r => r.owner_key === owner);
}

function drainCount(fake: FakeLocalDb) {
  return fake.statements.filter(s =>
    s.sql.startsWith('SELECT id, kind, payload'),
  ).length;
}

// ═══════════════════════════════════════════════════════════════════════════
describe('stress mod-sync-runtime boundary-malformed', () => {
  // ── retry-delay ──────────────────────────────────────────────────────────
  describe('retry-delay: nextSyncRetryDelayMs over boundary inputs', () => {
    for (const seed of campaignSeeds('retry-delay')) {
      it(`[retry-delay] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        // In-domain: the runtime only ever passes a non-negative integer
        // counter and Math.random() ∈ [0, 1).
        const failures = pick(random, [
          0,
          1,
          2,
          3,
          9,
          10,
          11,
          12,
          31,
          32,
          53,
          64,
          1023,
          1024,
          2 ** 31 - 1,
          2 ** 31,
          2 ** 53,
          Number.MAX_SAFE_INTEGER,
          randomInt(random, 0, 10_000),
        ]);
        const rand = pick(random, [
          0,
          Number.MIN_VALUE,
          0.25,
          0.5,
          0.75,
          1 - Number.EPSILON,
          0.9999999999999999,
          random(),
        ]);
        await runIteration('retry-delay', seed, { failures, rand }, () => {
          const delay = nextSyncRetryDelayMs(failures, () => rand);
          const exponent = Math.min(failures, 10);
          const base = Math.min(
            SYNC_RETRY_BASE_MS * 2 ** exponent,
            SYNC_RETRY_MAX_MS,
          );
          expect(Number.isInteger(delay)).toBe(true);
          expect(delay).toBeGreaterThanOrEqual(
            Math.floor(base * (1 - SYNC_RETRY_JITTER_RATIO)),
          );
          expect(delay).toBeLessThanOrEqual(
            Math.ceil(SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO)),
          );
          expect(delay).toBeGreaterThan(0);
          // Replay: same inputs, same output.
          expect(nextSyncRetryDelayMs(failures, () => rand)).toBe(delay);
          return { delay, base };
        });
      });
    }
  });

  // ── app-state-flap ───────────────────────────────────────────────────────
  describe('app-state-flap: malformed AppState values + reconnect flaps', () => {
    let fx: RuntimeFixture;
    beforeEach(() => {
      fx = installRuntimeFixture();
    });
    afterEach(teardownRuntimeFixture);

    const APP_STATES: ReadonlyArray<() => unknown> = [
      () => 'active',
      () => 'background',
      () => 'inactive',
      () => 'unknown',
      () => 'extension',
      () => 'Active',
      () => 'ACTIVE',
      () => 'active\u0000',
      () => ' active',
      () => 'active ',
      () => 'actíve',
      () => '\uFEFFactive',
      () => '',
      () => null,
      () => undefined,
      () => 0,
      () => 1,
      () => NaN,
      () => true,
      () => ({}),
      () => [],
      () => ['active'],
      () => ({ toString: () => 'active' }),
      () => '__proto__',
      () => 'a'.repeat(65_536),
      () => Symbol('active'),
    ];

    for (const seed of campaignSeeds('app-state-flap')) {
      it(`[app-state-flap] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const rowCount = randomInt(random, 0, 6);
        const stormLength = randomInt(random, 5, 60);
        const plan: string[] = [];
        for (let i = 0; i < stormLength; i += 1) {
          plan.push(
            pick(random, [
              'appstate',
              'appstate',
              'appstate',
              'trigger',
              'flush',
              'reconfigure',
              'clear',
              'advance',
            ]),
          );
        }
        const stateIndices = plan.map(() =>
          randomInt(random, 0, APP_STATES.length - 1),
        );
        const rows = generateRows(random, rowCount);
        await runIteration(
          'app-state-flap',
          seed,
          {
            rowCount,
            plan,
            stateIndices,
            strategies: rows.map(r => r.strategy),
          },
          async observe => {
            for (const row of rows)
              pushRaw(fx.fake, row.kind, row.payload, OWNER_A);
            // Foreign-owner row must stay byte-identical throughout.
            pushRaw(
              fx.fake,
              'shot.sync',
              JSON.stringify(validShot('foreign', null)),
              OWNER_B,
            );
            const foreignBefore = snapshotRows(fx.fake.outbox, OWNER_B);
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks();
            let configured = true;
            let exactActiveEvents = 0;
            let handlerThrows = 0;
            for (let i = 0; i < plan.length; i += 1) {
              const step = plan[i]!;
              if (step === 'appstate') {
                const value = APP_STATES[stateIndices[i]!]!();
                if (value === 'active') exactActiveEvents += 1;
                for (const handler of [...fx.appStateHandlers]) {
                  try {
                    handler(value);
                  } catch {
                    handlerThrows += 1;
                  }
                }
              } else if (step === 'trigger') {
                triggerOutboxSync();
              } else if (step === 'flush') {
                await flushMicrotasks(2);
              } else if (step === 'reconfigure') {
                configureSyncRuntime(sessionFor(USER_A));
                configured = true;
              } else if (step === 'clear') {
                clearSyncRuntime();
                configured = false;
              } else {
                await advance(randomInt(random, 0, ONE_BACKOFF_MS));
              }
            }
            await flushMicrotasks(10);
            observe({
              drains: drainCount(fx.fake),
              exactActiveEvents,
              handlerThrows,
              unhandled: fx.unhandled.length,
              serverCalls: fx.server.calls,
              maxInFlight: fx.server.maxInFlight,
              openTransactions: fx.fake.openTransactions(),
              timers: jest.getTimerCount(),
              liveListeners: fx.listenersAdded() - fx.listenerRemovals(),
              configured,
              reconfigures: plan.filter(s => s === 'reconfigure').length,
              clears: plan.filter(s => s === 'clear').length,
              ownerRows: ownerRows(fx.fake, OWNER_A).map(r => ({
                id: r.id,
                kind: r.kind,
                attempts: r.attempts,
                lastError: r.last_error,
              })),
              maxAttempts: Math.max(
                0,
                ...ownerRows(fx.fake, OWNER_A).map(r => r.attempts),
              ),
            });
            expect(handlerThrows).toBe(0);
            expect(fx.unhandled).toEqual([]);
            expect(fx.server.maxInFlight).toBeLessThanOrEqual(1);
            expect(fx.fake.openTransactions()).toBe(0);
            expect(jest.getTimerCount()).toBe(configured ? 1 : 0);
            // Every listener but the live one has been removed.
            expect(fx.listenersAdded() - fx.listenerRemovals()).toBe(
              configured ? 1 : 0,
            );
            expect(snapshotRows(fx.fake.outbox, OWNER_B)).toBe(foreignBefore);
            for (const row of ownerRows(fx.fake, OWNER_A)) {
              expect(row.attempts).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
            }
            assertPrototypeClean();
            return { remaining: ownerRows(fx.fake, OWNER_A).length };
          },
        );
      });
    }

    it('[app-state-flap] only the exact "active" string triggers a drain', async () => {
      await runIteration(
        'app-state-flap',
        0,
        { fixed: 'non-active values never drain' },
        async () => {
          pushRaw(
            fx.fake,
            'shot.sync',
            JSON.stringify(validShot('s', null)),
            OWNER_A,
          );
          configureSyncRuntime(sessionFor(USER_A));
          await flushMicrotasks();
          const drainsAfterConfigure = drainCount(fx.fake);
          for (const make of APP_STATES) {
            const value = make();
            if (value === 'active') continue;
            for (const handler of fx.appStateHandlers) handler(value);
            await flushMicrotasks(2);
          }
          expect(drainCount(fx.fake)).toBe(drainsAfterConfigure);
          for (const handler of fx.appStateHandlers) handler('active');
          await flushMicrotasks(2);
          expect(drainCount(fx.fake)).toBe(drainsAfterConfigure + 1);
          expect(jest.getTimerCount()).toBe(1);
          return { drainsAfterConfigure };
        },
      );
    });
  });

  // ── outbox-malformed ─────────────────────────────────────────────────────
  describe('outbox-malformed: malformed rows drained to quiescence', () => {
    let fx: RuntimeFixture;
    beforeEach(() => {
      fx = installRuntimeFixture();
    });
    afterEach(teardownRuntimeFixture);

    for (const seed of campaignSeeds('outbox-malformed')) {
      it(`[outbox-malformed] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const rowCount = randomInt(random, 1, 10);
        const rows = generateRows(random, rowCount);
        await runIteration(
          'outbox-malformed',
          seed,
          {
            rowCount,
            rows: rows.map(r => ({
              kind: r.kind,
              strategy: r.strategy,
              payload: r.payload,
            })),
          },
          async observe => {
            const ids = rows.map(row =>
              pushRaw(fx.fake, row.kind, row.payload, OWNER_A),
            );
            pushRaw(
              fx.fake,
              'shot.sync',
              JSON.stringify(validShot('foreign', null)),
              OWNER_B,
            );
            const foreignBefore = snapshotRows(fx.fake.outbox, OWNER_B);
            const byRowId = new Map<number, GeneratedRow>();
            rows.forEach((row, i) => byRowId.set(ids[i]!, row));

            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(10);
            // Quiescence: OUTBOX_MAX_ATTEMPTS + 2 backoff cycles park every
            // permanently-failing row and give transient rows their retries.
            for (let cycle = 0; cycle < OUTBOX_MAX_ATTEMPTS + 2; cycle += 1) {
              await advance(ONE_BACKOFF_MS);
              await flushMicrotasks(10);
            }

            const remaining = ownerRows(fx.fake, OWNER_A);
            observe({
              drains: drainCount(fx.fake),
              serverCalls: fx.server.calls,
              unhandled: fx.unhandled.length,
              maxInFlight: fx.server.maxInFlight,
              openTransactions: fx.fake.openTransactions(),
              timers: jest.getTimerCount(),
              remaining: remaining.map(r => ({
                rowId: r.id,
                kind: r.kind,
                strategy: byRowId.get(r.id)?.strategy,
                attempts: r.attempts,
                lastError: r.last_error,
              })),
              accepted: [...fx.server.accepted],
              receipts: fx.fake.receipts.length,
            });
            expect(fx.unhandled).toEqual([]);
            expect(fx.server.maxInFlight).toBeLessThanOrEqual(1);
            expect(fx.fake.openTransactions()).toBe(0);
            expect(jest.getTimerCount()).toBe(1);
            expect(snapshotRows(fx.fake.outbox, OWNER_B)).toBe(foreignBefore);
            assertPrototypeClean();

            const remainingIds = new Set(remaining.map(r => r.id));
            const stuck: Array<Record<string, unknown>> = [];
            for (const row of remaining) {
              expect(row.attempts).toBeLessThanOrEqual(OUTBOX_MAX_ATTEMPTS);
              const generated = byRowId.get(row.id)!;
              if (row.attempts < OUTBOX_MAX_ATTEMPTS) {
                // By design: a shot whose practice-set session the server has
                // never seen waits (transient) for that session row.
                let parsedSessionId: unknown = null;
                try {
                  parsedSessionId = (
                    JSON.parse(row.payload) as { sessionId?: unknown }
                  )?.sessionId;
                } catch {
                  parsedSessionId = null;
                }
                const byDesign =
                  row.kind === 'shot.sync' &&
                  typeof row.last_error === 'string' &&
                  row.last_error.startsWith(SESSION_NOT_FOUND_REJECTION) &&
                  typeof parsedSessionId === 'string' &&
                  !fx.server.knownSessions.has(parsedSessionId);
                if (!byDesign) {
                  stuck.push({
                    rowId: row.id,
                    kind: row.kind,
                    strategy: generated.strategy,
                    attempts: row.attempts,
                    lastError: row.last_error,
                    payload: row.payload,
                  });
                }
              }
            }
            // Deleted ⇒ the server acknowledged it (never a silent write).
            for (const [rowId, generated] of byRowId) {
              if (remainingIds.has(rowId)) continue;
              if (generated.kind === 'shot.sync') {
                expect(generated.id).not.toBeNull();
                expect(fx.server.accepted.has(generated.id!)).toBe(true);
                expect(
                  fx.fake.receipts.some(
                    r => r.owner === OWNER_A && r.entityId === generated.id,
                  ),
                ).toBe(true);
              } else if (generated.kind === 'session.create') {
                expect(generated.id).not.toBeNull();
                expect(fx.server.knownSessions.has(generated.id!)).toBe(true);
              } else if (generated.kind === 'session.finalize') {
                expect(generated.id).not.toBeNull();
                expect(fx.server.finalizedSessionIds).toContain(generated.id);
                expect(fx.server.knownSessions.has(generated.id!)).toBe(true);
              } else if (generated.kind === 'evaluation.trial') {
                expect(generated.id).not.toBeNull();
                expect(fx.server.acceptedTrials.has(generated.id!)).toBe(true);
              } else {
                throw new Error(
                  `row of unknown kind ${JSON.stringify(generated.kind)} was deleted`,
                );
              }
            }
            // Control shots and trials always sync next to malformed siblings.
            for (const generated of rows) {
              if (!generated.control) continue;
              if (generated.kind === 'shot.sync') {
                if (
                  generated.sessionId !== null &&
                  !fx.server.knownSessions.has(generated.sessionId)
                ) {
                  continue;
                }
                expect(fx.server.accepted.has(generated.id!)).toBe(true);
              } else if (generated.kind === 'evaluation.trial') {
                expect(fx.server.acceptedTrials.has(generated.id!)).toBe(true);
              } else if (generated.kind === 'session.create') {
                expect(fx.server.knownSessions.has(generated.id!)).toBe(true);
              }
            }
            // Malformed rows never reached a receipt.
            for (const receipt of fx.fake.receipts) {
              expect(receipt.owner).toBe(OWNER_A);
              expect(fx.server.accepted.has(receipt.entityId)).toBe(true);
            }
            observe({ stuck });
            expect(stuck).toEqual([]);
            return {};
          },
        );
      });
    }
  });

  // ── server-malformed ─────────────────────────────────────────────────────
  describe('server-malformed: transport returns malformed responses / typed errors', () => {
    let fx: RuntimeFixture;
    beforeEach(() => {
      fx = installRuntimeFixture();
    });
    afterEach(teardownRuntimeFixture);

    type Behaviour = {
      label: string;
      make: () => unknown;
      permanent: boolean | 'n/a';
    };
    const BEHAVIOURS: readonly Behaviour[] = [
      { label: 'null-response', make: () => null, permanent: false },
      { label: 'undefined-response', make: () => undefined, permanent: false },
      { label: 'empty-object', make: () => ({}), permanent: false },
      { label: 'string-response', make: () => 'ok', permanent: false },
      { label: 'number-response', make: () => 200, permanent: false },
      { label: 'array-response', make: () => [], permanent: false },
      // A 2xx whose acceptedIds is not an array leaves every entry
      // "unacknowledged", which sync.ts treats as a contract verdict
      // (permanent, attempts + 1) — documented there, so pinned as such.
      {
        label: 'acceptedIds-string',
        make: () => ({ acceptedIds: 'shot-0', rejected: [] }),
        permanent: true,
      },
      {
        label: 'acceptedIds-null',
        make: () => ({ acceptedIds: null, rejected: [] }),
        permanent: true,
      },
      {
        label: 'rejected-null',
        make: () => ({ acceptedIds: [], rejected: null }),
        permanent: false,
      },
      {
        label: 'rejected-object',
        make: () => ({ acceptedIds: [], rejected: {} }),
        permanent: false,
      },
      {
        label: 'rejected-items-null',
        make: () => ({ acceptedIds: [], rejected: [null] }),
        permanent: false,
      },
      {
        label: 'rejected-items-wrong-type',
        make: () => ({
          acceptedIds: [],
          rejected: [{ id: 5, code: 7, message: null }],
        }),
        permanent: 'n/a',
      },
      {
        label: 'rejected-unknown-ids',
        make: () => ({
          acceptedIds: [],
          rejected: [{ id: 'nope', code: 'x', message: 'y' }],
        }),
        permanent: 'n/a',
      },
      {
        label: 'accepted-unknown-ids',
        make: () => ({ acceptedIds: ['nope', 5, null], rejected: [] }),
        permanent: 'n/a',
      },
      {
        label: 'proto-response',
        make: () =>
          JSON.parse(
            '{"__proto__":{"polluted":true},"acceptedIds":[],"rejected":[]}',
          ),
        permanent: 'n/a',
      },
      {
        label: 'throw-400',
        make: () => {
          throw new ApiError(400, 'validation.shots_sync', 'bad');
        },
        permanent: true,
      },
      {
        label: 'throw-401',
        make: () => {
          throw new ApiError(401, 'auth.required', 'nope');
        },
        permanent: false,
      },
      {
        label: 'throw-408',
        make: () => {
          throw new ApiError(408, 'network.timeout', 'slow');
        },
        permanent: false,
      },
      {
        label: 'throw-413',
        make: () => {
          throw new ApiError(413, 'unknown', 'Request body is too large.');
        },
        permanent: true,
      },
      {
        label: 'throw-429',
        make: () => {
          throw new ApiError(429, 'rate_limited', 'slow down');
        },
        permanent: false,
      },
      {
        label: 'throw-500',
        make: () => {
          throw new ApiError(500, 'unknown', 'boom');
        },
        permanent: false,
      },
      {
        label: 'throw-503',
        make: () => {
          throw new ApiError(503, 'unknown', 'down');
        },
        permanent: false,
      },
      {
        label: 'throw-TypeError',
        make: () => {
          throw new TypeError('Network request failed');
        },
        permanent: false,
      },
      {
        label: 'throw-string',
        make: () => {
          throw 'offline';
        },
        permanent: false,
      },
      {
        label: 'throw-null',
        make: () => {
          throw null;
        },
        permanent: false,
      },
      {
        label: 'throw-undefined',
        make: () => {
          throw undefined;
        },
        permanent: false,
      },
      {
        label: 'throw-object',
        make: () => {
          throw { status: 500 };
        },
        permanent: false,
      },
      {
        label: 'throw-NaN-status',
        make: () => {
          throw new ApiError(NaN, 'unknown', '?');
        },
        permanent: false,
      },
      {
        label: 'throw-Infinity-status',
        make: () => {
          throw new ApiError(Infinity, 'unknown', '?');
        },
        permanent: false,
      },
      {
        label: 'throw-negative-status',
        make: () => {
          throw new ApiError(-1, 'unknown', '?');
        },
        permanent: false,
      },
      {
        label: 'throw-0-status',
        make: () => {
          throw new ApiError(0, 'unknown', '?');
        },
        permanent: false,
      },
      {
        label: 'throw-499',
        make: () => {
          throw new ApiError(499, 'unknown', 'client closed');
        },
        permanent: true,
      },
    ];

    for (const seed of campaignSeeds('server-malformed')) {
      it(`[server-malformed] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const shots = randomInt(random, 1, 5);
        const behaviour = pick(random, BEHAVIOURS);
        await runIteration(
          'server-malformed',
          seed,
          { shots, behaviour: behaviour.label },
          async () => {
            for (let i = 0; i < shots; i += 1) {
              pushRaw(
                fx.fake,
                'shot.sync',
                JSON.stringify(validShot(`shot-${i}`, null)),
                OWNER_A,
              );
            }
            pushRaw(
              fx.fake,
              'shot.sync',
              JSON.stringify(validShot('foreign', null)),
              OWNER_B,
            );
            const foreignBefore = snapshotRows(fx.fake.outbox, OWNER_B);
            fx.server.nextBehaviour = behaviour.make;
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(10);
            expect(fx.unhandled).toEqual([]);
            expect(fx.fake.openTransactions()).toBe(0);
            expect(jest.getTimerCount()).toBe(1);
            expect(fx.fake.receipts).toEqual([]);
            expect(snapshotRows(fx.fake.outbox, OWNER_B)).toBe(foreignBefore);
            assertPrototypeClean();
            const rows = ownerRows(fx.fake, OWNER_A);
            // A malformed response never deletes a row.
            expect(rows).toHaveLength(shots);
            for (const row of rows) {
              if (behaviour.permanent === true) expect(row.attempts).toBe(1);
              else if (behaviour.permanent === false)
                expect(row.attempts).toBe(0);
              else expect(row.attempts).toBeLessThanOrEqual(1);
              expect(typeof row.last_error).toBe('string');
            }
            // The next (healthy) drain recovers every row.
            await advance(ONE_BACKOFF_MS);
            await flushMicrotasks(10);
            expect(ownerRows(fx.fake, OWNER_A)).toHaveLength(0);
            expect(fx.fake.receipts).toHaveLength(shots);
            expect(jest.getTimerCount()).toBe(1);
            return {
              attemptsAfterFault: rows.map(r => r.attempts),
              lastErrors: rows.map(r => r.last_error),
              serverCalls: fx.server.calls,
            };
          },
        );
      });
    }
  });

  // ── transport-boundary ───────────────────────────────────────────────────
  describe('transport-boundary: real createTransport over a mocked fetch', () => {
    const realTransport =
      jest.requireActual<typeof import('../../src/data/api')>(
        '../../src/data/api',
      ).createTransport;
    type FetchMock = jest.Mock<
      Promise<unknown>,
      [string, Record<string, unknown>]
    >;
    let fetchMock: FetchMock;
    let previousFetch: unknown;
    const g = globalThis as unknown as Record<string, unknown>;

    beforeEach(() => {
      previousFetch = g['fetch'];
      fetchMock = jest.fn();
      g['fetch'] = fetchMock;
    });
    afterEach(() => {
      g['fetch'] = previousFetch;
    });

    function respond(status: number, body: string | (() => unknown)) {
      fetchMock.mockImplementationOnce(async () => ({
        ok: status >= 200 && status < 300,
        status,
        statusText: `status-${status}`,
        json: async () =>
          typeof body === 'string' ? JSON.parse(body) : body(),
      }));
    }

    const RESPONSE_BODIES: ReadonlyArray<{
      label: string;
      status: number;
      body: string | (() => unknown);
    }> = [
      { label: '200-invalid-json', status: 200, body: '{invalid' },
      { label: '200-empty', status: 200, body: '' },
      { label: '200-null', status: 200, body: 'null' },
      { label: '200-string', status: 200, body: '"ok"' },
      { label: '200-array', status: 200, body: '[]' },
      { label: '200-number', status: 200, body: '1e999' },
      {
        label: '200-proto',
        status: 200,
        body: '{"__proto__":{"polluted":true},"acceptedIds":[],"rejected":[]}',
      },
      {
        label: '200-64kb',
        status: 200,
        body: () => ({ acceptedIds: ['a'.repeat(65_536)], rejected: [] }),
      },
      { label: '204-empty', status: 204, body: '' },
      { label: '400-no-error', status: 400, body: '{}' },
      {
        label: '400-error-wrong-type',
        status: 400,
        body: '{"error":"string"}',
      },
      { label: '400-error-null', status: 400, body: '{"error":null}' },
      {
        label: '400-error-code-number',
        status: 400,
        body: '{"error":{"code":5,"message":7}}',
      },
      { label: '400-invalid-json', status: 400, body: 'nope' },
      {
        label: '413-generic',
        status: 413,
        body: '{"error":{"code":"unknown","message":"Request body is too large."}}',
      },
      { label: '429-empty', status: 429, body: '' },
      { label: '500-html', status: 500, body: '<html>boom</html>' },
      {
        label: '500-detail',
        status: 500,
        body: '{"error":{"code":"db","message":"relation shots does not exist"}}',
      },
      { label: '502-empty', status: 502, body: '' },
      { label: '599', status: 599, body: '{}' },
      { label: '0', status: 0, body: '' },
      { label: 'NaN-status', status: NaN, body: '{}' },
    ];

    type Call = 'finalize' | 'create' | 'sync' | 'trials';

    /** True when the (browser-normalized) request path no longer targets
     * `/v1/sessions/<id>/finalize` — i.e. the id rewrote the route. */
    function pathEscapesSessions(url: string): boolean | 'unparseable' {
      try {
        const { pathname } = new URL(url);
        return (
          !pathname.startsWith('/v1/sessions/') ||
          !pathname.endsWith('/finalize')
        );
      } catch {
        return 'unparseable';
      }
    }

    for (const seed of campaignSeeds('transport-boundary')) {
      it(`[transport-boundary] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const call = pick<Call>(random, [
          'finalize',
          'finalize',
          'create',
          'sync',
          'trials',
        ]);
        const id = malformedString(random);
        const responseIndex = randomInt(random, 0, RESPONSE_BODIES.length - 1);
        const response = RESPONSE_BODIES[responseIndex]!;
        const bodyValue = wrongTypeValue(random);
        await runIteration(
          'transport-boundary',
          seed,
          { call, id, response: response.label, bodyValue },
          async () => {
            const transport = realTransport({
              baseUrl: 'https://api.test',
              token: 'tok',
            });
            respond(response.status, response.body);
            let result:
              | { kind: 'resolved'; value: unknown }
              | { kind: 'rejected'; error: unknown };
            try {
              let value: unknown;
              if (call === 'finalize')
                value = await transport.finalizeSession(id);
              else if (call === 'create')
                value = await transport.createSession(bodyValue);
              else if (call === 'sync')
                value = await transport.syncShots([bodyValue, { id }]);
              else value = await transport.uploadEvaluationTrials!([bodyValue]);
              result = { kind: 'resolved', value };
            } catch (error) {
              result = { kind: 'rejected', error };
            }
            expect(fetchMock).toHaveBeenCalledTimes(1);
            const [url, init] = fetchMock.mock.calls[0]!;
            expect(typeof url).toBe('string');
            expect(url.startsWith('https://api.test/v1/')).toBe(true);
            // Body is always the JSON encoding of what the caller passed
            // (or absent) — never a thrown serialization error.
            if (init['body'] !== undefined)
              expect(typeof init['body']).toBe('string');
            const ok = response.status >= 200 && response.status < 300;
            if (ok) {
              // A 2xx with a malformed body resolves with whatever JSON
              // parsed (null for unparseable) — the caller classifies it.
              expect(result.kind).toBe('resolved');
            } else {
              // Every non-2xx is a typed ApiError with the wire status —
              // never a raw SyntaxError/TypeError escaping the transport.
              expect(result.kind).toBe('rejected');
              const error = (result as { error: unknown }).error;
              expect(error).toBeInstanceOf(ApiError);
              const apiError = error as ApiError;
              expect(apiError.status).toBe(response.status);
              expect(
                typeof apiError.code === 'string' ||
                  typeof apiError.code === 'number',
              ).toBe(true);
            }
            assertPrototypeClean();
            // Path-traversal / reserved characters in a session id: record
            // whether the id reached the URL verbatim (unencoded).
            let safelyEncodedId: string | null = null;
            try {
              safelyEncodedId = encodeURIComponent(id);
            } catch {
              safelyEncodedId = null; // lone surrogates: not encodable
            }
            const encoded =
              call === 'finalize'
                ? safelyEncodedId !== null &&
                  url ===
                    `https://api.test/v1/sessions/${safelyEncodedId}/finalize`
                : null;
            const verbatim =
              call === 'finalize'
                ? url === `https://api.test/v1/sessions/${id}/finalize`
                : null;
            return {
              url:
                url.length > 200
                  ? `${url.slice(0, 120)}…(len ${url.length})`
                  : url,
              urlLength: url.length,
              outcome: result.kind,
              status:
                result.kind === 'rejected' && result.error instanceof ApiError
                  ? result.error.status
                  : null,
              code:
                result.kind === 'rejected' && result.error instanceof ApiError
                  ? result.error.code
                  : null,
              idEncodedInUrl: encoded,
              idVerbatimInUrl: verbatim,
              // Verbatim `..` / `/` in the id rewrites the request path.
              pathEscapesSessions:
                call === 'finalize' ? pathEscapesSessions(url) : null,
            };
          },
        );
      });
    }
  });

  // ── queue-status ─────────────────────────────────────────────────────────
  describe('queue-status: deriveUploadQueueStatus over numeric edge attempts', () => {
    for (const seed of campaignSeeds('queue-status')) {
      it(`[queue-status] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const count = randomInt(random, 0, 12);
        const rows: OutboxRowStatus[] = Array.from({ length: count }, () => ({
          kind: pick(random, KIND_MUTATIONS),
          attempts: pick(random, [
            ...EDGE_NUMBERS,
            OUTBOX_MAX_ATTEMPTS - 1,
            OUTBOX_MAX_ATTEMPTS,
            OUTBOX_MAX_ATTEMPTS + 1,
            OUTBOX_MAX_ATTEMPTS - 0.5,
            OUTBOX_MAX_ATTEMPTS + 0.5,
            randomInt(random, 0, 20),
          ]),
          lastError: pick(random, [null, '', malformedString(random)]),
        }));
        await runIteration(
          'queue-status',
          seed,
          { rows: rows.map(r => ({ attempts: r.attempts, kind: r.kind })) },
          () => {
            const status = deriveUploadQueueStatus(rows);
            expect(['idle', 'queued', 'needs_attention']).toContain(
              status.state,
            );
            if (rows.length === 0) expect(status.state).toBe('idle');
            else expect(status.state).not.toBe('idle');
            if (status.state === 'queued') {
              expect(status.pending).toBe(rows.length);
            }
            if (status.state === 'needs_attention') {
              expect(status.exhausted).toBeGreaterThan(0);
              expect(status.pending).toBeGreaterThanOrEqual(0);
              expect(status.pending + status.exhausted).toBe(rows.length);
            }
            const expectedExhausted = rows.filter(
              r => r.attempts >= OUTBOX_MAX_ATTEMPTS,
            ).length;
            if (expectedExhausted > 0)
              expect(status.state).toBe('needs_attention');
            // Pure + replayable.
            expect(deriveUploadQueueStatus(rows)).toEqual(status);
            expect(deriveUploadQueueStatus([...rows].reverse())).toEqual(
              status,
            );
            return { status };
          },
        );
      });
    }
  });

  // ── capability-id ────────────────────────────────────────────────────────
  describe('capability-id: capability lookups over malformed ids', () => {
    const VALID_IDS = Object.keys(OFFLINE_CAPABILITY_MAP_V1) as CapabilityId[];
    for (const seed of campaignSeeds('capability-id')) {
      it(`[capability-id] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const useValid = random() < 0.3;
        const id = useValid ? pick(random, VALID_IDS) : malformedString(random);
        const dependency = pick<unknown>(random, [
          'on-device',
          'server-dependent',
          'hybrid',
          'ON-DEVICE',
          'on-device\u0000',
          '',
          null,
          undefined,
          0,
          {},
          '__proto__',
          malformedString(random),
        ]);
        await runIteration('capability-id', seed, { id, dependency }, () => {
          // capabilitiesByDependency: never throws, returns [] for garbage.
          const byDependency = capabilitiesByDependency(
            dependency as NetworkDependency,
          );
          expect(Array.isArray(byDependency)).toBe(true);
          if (
            !['on-device', 'server-dependent', 'hybrid'].includes(
              String(dependency),
            ) ||
            typeof dependency !== 'string'
          ) {
            expect(byDependency).toEqual([]);
          } else {
            expect(byDependency.length).toBeGreaterThan(0);
            for (const entry of byDependency)
              expect(entry.dependency).toBe(dependency);
          }
          // capabilityDependency: valid ids classify; malformed ids must not
          // leak a prototype member or a misclassification.
          let lookup:
            | { kind: 'value'; value: unknown }
            | { kind: 'throw'; error: string };
          try {
            lookup = {
              kind: 'value',
              value: capabilityDependency(id as CapabilityId),
            };
          } catch (error) {
            lookup = {
              kind: 'throw',
              error: error instanceof Error ? error.name : String(error),
            };
          }
          if (useValid) {
            expect(lookup).toEqual({
              kind: 'value',
              value: expect.any(String),
            });
            expect(['on-device', 'server-dependent', 'hybrid']).toContain(
              (lookup as { value: unknown }).value,
            );
          } else if (lookup.kind === 'value') {
            // Unknown id must never resolve to a real classification.
            expect(['on-device', 'server-dependent', 'hybrid']).not.toContain(
              lookup.value,
            );
          }
          // The map itself is untouched by lookups.
          expect(Object.keys(OFFLINE_CAPABILITY_MAP_V1)).toEqual(VALID_IDS);
          assertPrototypeClean();
          return { lookup, byDependencyCount: byDependency.length };
        });
      });
    }
  });

  // ── configure-session ────────────────────────────────────────────────────
  describe('configure-session: configureSyncRuntime over malformed ApiSession fields', () => {
    let fx: RuntimeFixture;
    beforeEach(() => {
      fx = installRuntimeFixture();
    });
    afterEach(teardownRuntimeFixture);

    for (const seed of campaignSeeds('configure-session')) {
      it(`[configure-session] seed ${seed}`, async () => {
        const random = seededRandom(seed);
        const field = pick(random, [
          'canonicalAppUserId',
          'apiBaseUrl',
          'bearerToken',
          'provider',
        ] as const);
        const value = pick<unknown>(random, [
          malformedString(random),
          edgeNumber(random),
          null,
          undefined,
          {},
          [],
          USER_A.toUpperCase(),
          ` ${USER_A}\n`,
          USER_B,
        ]);
        const preconfigured = random() < 0.5;
        await runIteration(
          'configure-session',
          seed,
          { field, value, preconfigured },
          async () => {
            pushRaw(
              fx.fake,
              'shot.sync',
              JSON.stringify(validShot('s', null)),
              OWNER_A,
            );
            if (preconfigured) {
              configureSyncRuntime(sessionFor(USER_A));
              await flushMicrotasks();
            }
            const drainsBefore = drainCount(fx.fake);
            const session = sessionFor(USER_A, {
              [field]: value,
            } as Partial<ApiSession>);
            let threw: string | null = null;
            let returned: unknown = 'not-called';
            try {
              returned = configureSyncRuntime(session);
            } catch (error) {
              threw =
                error instanceof Error
                  ? `${error.name}: ${error.message}`
                  : String(error);
            }
            await flushMicrotasks(10);
            expect(fx.unhandled).toEqual([]);
            // Never an async rejection: configure is synchronous in its
            // acceptance/rejection.
            expect(returned === undefined || returned === 'not-called').toBe(
              true,
            );
            let ownerValid = true;
            try {
              canonicalDataOwner(String(session.canonicalAppUserId));
            } catch {
              ownerValid = false;
            }
            if (field === 'canonicalAppUserId' && !ownerValid) {
              // Rejected synchronously (the throw kind is recorded); nothing
              // stays armed — authStore validates the owner before reaching
              // this call, so the pre-existing runtime being torn down first
              // is documented here, not reachable from sign-in.
              expect(threw).not.toBeNull();
              expect(jest.getTimerCount()).toBe(0);
              expect(fx.listenersAdded() - fx.listenerRemovals()).toBe(0);
              expect(drainCount(fx.fake)).toBe(drainsBefore);
              expect(fx.server.calls).toBe(preconfigured ? 1 : 0);
            } else {
              expect(threw).toBeNull();
              expect(jest.getTimerCount()).toBe(1);
              expect(fx.listenersAdded() - fx.listenerRemovals()).toBe(1);
              const owner = canonicalDataOwner(
                String(session.canonicalAppUserId),
              );
              if (owner === getActiveDataOwner()) {
                // Same owner (any casing/whitespace): drained immediately.
                expect(drainCount(fx.fake)).toBe(drainsBefore + 1);
              } else {
                // Foreign owner: no drain against another account's rows.
                expect(drainCount(fx.fake)).toBe(drainsBefore);
              }
            }
            expect(fx.fake.openTransactions()).toBe(0);
            assertPrototypeClean();
            // Recovery: a valid configure afterwards works.
            configureSyncRuntime(sessionFor(USER_A));
            await flushMicrotasks(10);
            expect(jest.getTimerCount()).toBe(1);
            expect(fx.listenersAdded() - fx.listenerRemovals()).toBe(1);
            return {
              threw,
              timersAfter: jest.getTimerCount(),
              drainsDelta: drainCount(fx.fake) - drainsBefore,
              serverCalls: fx.server.calls,
            };
          },
        );
      });
    }
  });

  // ── fixed minimized reproductions (seed-independent) ─────────────────────
  describe('minimized: drainOutbox direct malformed rows', () => {
    let fake: FakeLocalDb;
    let server: FakeServer;
    beforeEach(() => {
      fake = createFakeLocalDb();
      server = fakeServer();
      setActiveDataOwner(OWNER_A);
    });
    afterEach(() => {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    });

    it('[minimized] every JSON primitive / empty structure payload is parked within OUTBOX_MAX_ATTEMPTS drains for every kind', async () => {
      const payloads = [
        'null',
        '1',
        '"x"',
        'true',
        '-0',
        '1e999',
        '{}',
        '[]',
        '[{}]',
      ];
      const kinds = [
        'shot.sync',
        'session.create',
        'session.finalize',
        'evaluation.trial',
      ];
      const stuck: Array<{
        kind: string;
        payload: string;
        attempts: number;
        lastError: string | null;
      }> = [];
      await runIteration('minimized', 0, { payloads, kinds }, async observe => {
        for (const kind of kinds) {
          for (const payload of payloads) pushRaw(fake, kind, payload, OWNER_A);
        }
        for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
          const result = await drainOutbox(fake.db, server.transport);
          expect(result.synced).toBe(0);
        }
        for (const row of fake.outbox) {
          if (row.attempts < OUTBOX_MAX_ATTEMPTS) {
            stuck.push({
              kind: row.kind,
              payload: row.payload,
              attempts: row.attempts,
              lastError: row.last_error,
            });
          }
        }
        observe({
          rows: fake.outbox.length,
          receipts: fake.receipts.length,
          openTransactions: fake.openTransactions(),
          stuck,
        });
        expect(fake.receipts).toEqual([]);
        expect(fake.openTransactions()).toBe(0);
        assertPrototypeClean();
        expect(stuck).toEqual([]);
        return {};
      });
    });

    it('[minimized] a shot whose stored payload nests 6000 levels deep is parked (real transport must serialize it or reject it permanently)', async () => {
      const realTransport =
        jest.requireActual<typeof import('../../src/data/api')>(
          '../../src/data/api',
        ).createTransport;
      const g = globalThis as unknown as Record<string, unknown>;
      const previousFetch = g['fetch'];
      const fetchMock = jest.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'ok',
        json: async () => ({ acceptedIds: [], rejected: [] }),
      }));
      g['fetch'] = fetchMock;
      try {
        const depth = 6_000;
        const nested = `${'['.repeat(depth)}${']'.repeat(depth)}`;
        const text = JSON.stringify(validShot('deep', null)).replace(
          '"phases":[]',
          `"phases":${nested}`,
        );
        await runIteration('minimized', 1, { depth }, async observe => {
          pushRaw(fake, 'shot.sync', text, OWNER_A);
          pushRaw(
            fake,
            'shot.sync',
            JSON.stringify(validShot('healthy', null)),
            OWNER_A,
          );
          const transport = realTransport({
            baseUrl: 'https://api.test',
            token: 'tok',
          });
          const errors: string[] = [];
          for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
            await drainOutbox(fake.db, transport);
            const row = fake.outbox.find(r => r.payload === text);
            if (row?.last_error && !errors.includes(row.last_error))
              errors.push(row.last_error);
          }
          const deep = fake.outbox.find(r => r.payload === text);
          // The healthy sibling must not be held hostage by the deep row.
          const healthyStuck = fake.outbox.filter(r => r.payload !== text);
          observe({
            fetchCalls: fetchMock.mock.calls.length,
            deepAttempts: deep?.attempts ?? null,
            deepLastError: deep?.last_error ?? null,
            errors,
            healthyStuck: healthyStuck.map(r => ({
              attempts: r.attempts,
              lastError: r.last_error,
            })),
            receipts: fake.receipts.length,
          });
          expect(fake.openTransactions()).toBe(0);
          assertPrototypeClean();
          // The deep row itself must reach the cap (permanent) or be
          // delivered — never retried forever on a non-typed throw.
          expect(
            deep === undefined || deep.attempts >= OUTBOX_MAX_ATTEMPTS,
          ).toBe(true);
          expect(healthyStuck).toEqual([]);
          return {};
        });
      } finally {
        g['fetch'] = previousFetch;
      }
    });

    it('[minimized] same-owner configureSyncRuntime while a drain is in flight must not run two drains over the same rows', async () => {
      const fx = installRuntimeFixture();
      try {
        await runIteration('minimized', 2, {}, async observe => {
          pushRaw(fx.fake, 'shot.sync', '"malformed"', OWNER_A);
          pushRaw(
            fx.fake,
            'shot.sync',
            JSON.stringify(validShot('s', null)),
            OWNER_A,
          );
          configureSyncRuntime(sessionFor(USER_A));
          // Re-configure the SAME owner before the first drain settles.
          configureSyncRuntime(sessionFor(USER_A));
          await flushMicrotasks(20);
          await advance(ONE_BACKOFF_MS);
          await flushMicrotasks(20);
          const malformed = fx.fake.outbox.find(
            r => r.payload === '"malformed"',
          );
          const sendsOfS = fx.server.received.filter(
            raw => (raw as { id?: unknown }).id === 's',
          ).length;
          observe({
            malformedAttempts: malformed?.attempts ?? null,
            malformedLastError: malformed?.last_error ?? null,
            sendsOfS,
            drains: drainCount(fx.fake),
            maxInFlight: fx.server.maxInFlight,
            timers: jest.getTimerCount(),
          });
          expect(fx.fake.openTransactions()).toBe(0);
          expect(jest.getTimerCount()).toBe(1);
          expect(fx.server.maxInFlight).toBe(1);
          // The healthy shot must be sent exactly once: a second, stale
          // generation must not drain the same rows concurrently with the
          // live one (duplicate sends + double-counted attempts).
          expect(sendsOfS).toBe(1);
          expect(malformed?.attempts ?? 0).toBeLessThanOrEqual(2);
          return {};
        });
      } finally {
        teardownRuntimeFixture();
      }
    });

    it('[minimized] a session id containing path segments must not rewrite the finalize route', async () => {
      const realTransport =
        jest.requireActual<typeof import('../../src/data/api')>(
          '../../src/data/api',
        ).createTransport;
      const g = globalThis as unknown as Record<string, unknown>;
      const previousFetch = g['fetch'];
      const fetchMock = jest.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'ok',
        json: async () => ({}),
      }));
      g['fetch'] = fetchMock;
      try {
        const ids = ['../../admin', 'a/b', '..%2F..%2Fadmin', 'x?y=1#z'];
        await runIteration('minimized', 3, { ids }, async observe => {
          const transport = realTransport({
            baseUrl: 'https://api.test',
            token: 'tok',
          });
          const seen: Array<{ id: string; url: string; pathname: string }> = [];
          for (const id of ids) {
            fetchMock.mockClear();
            await transport.finalizeSession(id);
            const [url] = fetchMock.mock.calls[0] as unknown as [string];
            seen.push({ id, url, pathname: new URL(url).pathname });
          }
          observe({ seen });
          for (const entry of seen) {
            expect(entry.pathname.startsWith('/v1/sessions/')).toBe(true);
            expect(entry.pathname.endsWith('/finalize')).toBe(true);
            expect(entry.pathname.split('/').length).toBe(5);
          }
          return {};
        });
      } finally {
        g['fetch'] = previousFetch;
      }
    });

    it('[minimized] a 2xx whose acceptedIds is a string must not acknowledge (delete + receipt) any shot', async () => {
      await runIteration('minimized', 4, {}, async observe => {
        // Single-character shot id: `new Set('shot-0')` iterates code points.
        pushRaw(
          fake,
          'shot.sync',
          JSON.stringify(validShot('s', null)),
          OWNER_A,
        );
        server.nextBehaviour = () => ({ acceptedIds: 'shot-0', rejected: [] });
        const result = await drainOutbox(fake.db, server.transport);
        observe({
          synced: result.synced,
          rows: fake.outbox.length,
          receipts: fake.receipts.map(r => r.entityId),
          serverAccepted: [...server.accepted],
        });
        expect(server.accepted.has('s')).toBe(false);
        expect(result.synced).toBe(0);
        expect(fake.receipts).toEqual([]);
        expect(fake.outbox.length).toBe(1);
        return {};
      });
    });
  });
});
