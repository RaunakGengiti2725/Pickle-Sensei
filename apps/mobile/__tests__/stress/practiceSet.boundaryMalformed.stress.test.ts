/**
 * STRESS — unit `mod-run-capture-analysis` (practiceSet half), lens
 * `boundary-malformed`.
 *
 * Seeded campaign against `practiceSet.ts` with malformed / boundary input at
 * the two seams it reads:
 *
 *   P. the persisted kv record (`practice.set:<owner>`) — truncated / broken
 *      JSON, wrong root and field types, prototype-pollution keys, NaN /
 *      Infinity / -0 / overflow, null bytes, 64KB+ strings, path traversal in
 *      ids, future schema fields, empty arrays/objects, unicode normalization
 *      pairs, unparseable / future-dated / boundary timestamps;
 *   Q. caller input — `shotType`, `preferredSessionId`, `nowIso` and the
 *      active data owner (signed-out / guest / uuid);
 *   R. commit / note paths — a plan committed with boundary values, an
 *      owner change between plan and commit, an unparseable clock at commit
 *      time, concurrent plans/commits/notes racing on one kv record.
 *
 * Invariants asserted for EVERY iteration:
 *   - `planPracticeSet` / `currentPracticeSetId` never throw on a corrupt
 *     record and never write (read-only: no INSERT / BEGIN);
 *   - a corrupt or expired record yields a FRESH set (`resumed: false`,
 *     new uuid) — garbage is never repaired into a sitting;
 *   - `preferredSessionId` always wins and is echoed verbatim;
 *   - an unparseable `nowIso` is the ONE typed throw
 *     (`'nowIso must be a parseable ISO timestamp.'`) and happens BEFORE any
 *     write; every other throw out of the module is a violation;
 *   - signed-out owner: null / no-op and ZERO db calls;
 *   - a committed new set writes exactly one `local_session` row + one
 *     `session.create` outbox row inside one transaction, plus the kv record;
 *     a resumed set writes only the kv record;
 *   - the kv record is written under the PLAN's owner key only;
 *   - `Object.prototype` is never polluted by a parsed record.
 *
 * Replay: every iteration derives from `STRESS_SEED` (default 20260905) and
 * its campaign/index; `STRESS_REPLAY=P:17` runs exactly one iteration.
 * Scale: `STRESS_ITER=<n>` iterations per campaign (default 40 keeps the
 * suite fast). `STRESS_OUT=<dir>` writes the seed → outcome JSON table.
 */
import * as fs from 'fs';
import * as path from 'path';
import { SHOT_TYPES, type ShotTypeSlug } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  commitPracticeSet,
  currentPracticeSetId,
  notePracticeSetAnalysis,
  planPracticeSet,
  PRACTICE_SET_IDLE_TIMEOUT_MS,
  PRACTICE_SET_MODE,
  practiceSetKeyForOwner,
  resumeOrStartPracticeSet,
  type PracticeSetPlan,
} from '../../src/analysis/practiceSet';

// ─── Seeded RNG (mulberry32; identical stream for identical seed) ───────────

function hashSeed(label: string): number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}

// ─── Boundary vocabularies ──────────────────────────────────────────────────

const BIG = 64 * 1024;
const NULL_BYTE = '\u0000';
const NFC_E = '\u00e9';
const NFD_E = 'e\u0301';
const HANGUL_NFC = '\uD55C';
const HANGUL_NFD = '\u1112\u1161\u11AB';
const ZALGO = 'a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308';
const FAMILY = '\uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67';
const LONE_SURROGATE = '\uD800';
const RTL_OVERRIDE = '\u202Eabc\u202C';
const TRAVERSALS = [
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '%2e%2e%2f%2e%2e%2fetc',
  '/etc/passwd',
  'a/b/../../c',
  '....//....//',
];
const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'];

function bigString(rng: Rng): string {
  const unit = rng.pick(['a', NFC_E, NFD_E, FAMILY, ZALGO, NULL_BYTE, ' ']);
  const repeat = Math.ceil((BIG + rng.int(0, 4096)) / unit.length);
  return unit.repeat(repeat);
}

function weirdString(rng: Rng): string {
  return rng.pick<string>([
    '',
    ' ',
    '\n\t\r',
    NULL_BYTE,
    `id${NULL_BYTE}`,
    NFC_E,
    NFD_E,
    HANGUL_NFC,
    HANGUL_NFD,
    ZALGO,
    FAMILY,
    LONE_SURROGATE,
    RTL_OVERRIDE,
    '\uFEFF',
    rng.pick(TRAVERSALS),
    rng.pick(POLLUTION_KEYS),
    "'; DROP TABLE kv; --",
    '<script>alert(1)</script>',
    'NaN',
    'Infinity',
    '-0',
    'null',
    'undefined',
    '[object Object]',
    '0',
    '-1',
    bigString(rng),
  ]);
}

function weirdNumber(rng: Rng): number {
  return rng.pick<number>([
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    -1,
    1e308,
    5e-324,
    Number.MAX_SAFE_INTEGER + 2,
    2 ** 32,
    0.1 + 0.2,
  ]);
}

/** JSON-representable wrong-typed value. */
function wrongJsonType(rng: Rng): unknown {
  return rng.pick<unknown>([
    null,
    true,
    false,
    -1,
    0,
    1.5,
    1e308,
    weirdString(rng),
    [],
    {},
    [null],
    { [rng.pick(POLLUTION_KEYS)]: { polluted: true } },
  ]);
}

/** Runtime wrong-typed value (for typed parameters). */
function wrongType(rng: Rng): unknown {
  return rng.pick<unknown>([
    null,
    undefined,
    true,
    weirdNumber(rng),
    weirdString(rng),
    [],
    {},
    Object.create(null),
    () => 'fn',
    new Date(NaN),
  ]);
}

const T0 = '2026-09-02T17:00:00.000Z';
const T0_MS = Date.parse(T0);
function plus(ms: number, from = T0): string {
  return new Date(Date.parse(from) + ms).toISOString();
}

/** ISO-ish timestamps at and around the parse/idle boundaries. */
function boundaryIso(rng: Rng): string {
  return rng.pick<string>([
    T0,
    plus(-1),
    plus(-PRACTICE_SET_IDLE_TIMEOUT_MS),
    plus(-PRACTICE_SET_IDLE_TIMEOUT_MS - 1),
    plus(-PRACTICE_SET_IDLE_TIMEOUT_MS + 1),
    plus(1), // future by 1ms
    plus(60_000), // future
    '2026-09-02T17:00:00Z',
    '2026-09-02T17:00:00.000+00:00',
    '2026-09-02T17:00:00.000+05:30',
    '2026-09-02', // date only (UTC midnight)
    '2026-09-02T17:00', // no seconds
    '2026-13-45T99:99:99.000Z',
    '0000-01-01T00:00:00.000Z',
    '+275760-09-13T00:00:00.000Z', // max Date
    '+275760-09-13T00:00:00.001Z', // > max Date → NaN
    '1e3',
    '1756832400000', // epoch millis as string
    'now',
    'Invalid Date',
    'NaN',
    '',
    ' ',
    NULL_BYTE,
    `${T0}${NULL_BYTE}`,
    `${T0} `,
    ` ${T0}`,
    RTL_OVERRIDE,
    bigString(rng),
  ]);
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ─── Recording fake LocalDb ─────────────────────────────────────────────────

interface RecordedCall {
  sql: string;
  params: unknown[];
}

interface FakeDb {
  db: LocalDb;
  kv: Map<string, string>;
  calls: RecordedCall[];
  sessions: Array<{
    owner: string;
    id: string;
    mode: string;
    shotType: unknown;
    startedAt: unknown;
  }>;
  outbox: Array<{ owner: string; kind: string; payload: string }>;
  unhandled: string[];
}

function fakeDb(seedKv: Record<string, string> = {}): FakeDb {
  const kv = new Map<string, string>(Object.entries(seedKv));
  const calls: RecordedCall[] = [];
  const sessions: FakeDb['sessions'] = [];
  const outbox: FakeDb['outbox'] = [];
  const unhandled: string[] = [];
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      calls.push({ sql, params });
      const s = sql.trim();
      if (s === 'BEGIN IMMEDIATE' || s === 'COMMIT' || s === 'ROLLBACK')
        return { rows: [] };
      if (s.startsWith('SELECT value FROM kv')) {
        const value = kv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (s.startsWith('INSERT OR REPLACE INTO kv')) {
        kv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (s.includes('INSERT OR REPLACE INTO local_session')) {
        sessions.push({
          owner: String(params[0]),
          id: String(params[1]),
          mode: String(params[2]),
          shotType: params[3],
          startedAt: params[5],
        });
        return { rows: [] };
      }
      if (s.includes('INSERT INTO outbox')) {
        outbox.push({
          owner: String(params[0]),
          kind: /'([a-z.]+)'/.exec(s)?.[1] ?? 'unknown',
          payload: String(params[1]),
        });
        return { rows: [] };
      }
      unhandled.push(s.slice(0, 80));
      return { rows: [] };
    },
    close() {},
  };
  return { db, kv, calls, sessions, outbox, unhandled };
}

function writes(f: FakeDb): number {
  return f.calls.filter(c => !c.sql.trim().startsWith('SELECT')).length;
}

// ─── Seeds / replay / output ────────────────────────────────────────────────

const STRESS_SEED = Number(process.env.STRESS_SEED ?? '20260905') || 20260905;
const STRESS_ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '') || 40);
const STRESS_OUT = process.env.STRESS_OUT ?? null;
const REPLAY = process.env.STRESS_REPLAY ?? null;

function seedFor(campaign: string, index: number): number {
  return hashSeed(`${STRESS_SEED}:practiceSet:${campaign}:${index}`);
}

function indexesFor(campaign: string): number[] {
  if (REPLAY) {
    const [c, i] = REPLAY.split(':');
    return c === campaign && i !== undefined ? [Number(i)] : [];
  }
  return Array.from({ length: STRESS_ITER }, (_, i) => i);
}

/** `test.each` over the campaign's indexes; a campaign excluded by
 * `STRESS_REPLAY` becomes one skipped test (jest rejects an empty table). */
function campaignTest(
  campaign: string,
): (name: string, fn: (index: number) => Promise<void>) => void {
  const idx = indexesFor(campaign);
  return idx.length > 0 ? test.each(idx) : test.skip.each([-1]);
}

interface IterationRow {
  id: string;
  seed: number;
  campaign: string;
  ops: string[];
  outcome: string;
  writes: number;
  durationMs: number;
  violations: string[];
  observations: string[];
  rejected: string | null;
  payloadBytes: number;
  invocations: number;
}

const rows: IterationRow[] = [];

function recordRow(row: IterationRow): void {
  rows.push(row);
  if (row.violations.length > 0) {
    throw new Error(
      `[${row.id} seed=${row.seed}] ops=${row.ops.join('+')} outcome=${row.outcome} violations:\n  - ${row.violations.join('\n  - ')}`,
    );
  }
}

afterAll(() => {
  if (!STRESS_OUT) return;
  fs.mkdirSync(STRESS_OUT, { recursive: true });
  const byCampaign: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const c = (byCampaign[r.campaign] ??= {});
    c[r.outcome] = (c[r.outcome] ?? 0) + 1;
  }
  fs.writeFileSync(
    path.join(STRESS_OUT, 'practiceSet.boundaryMalformed.results.json'),
    JSON.stringify(
      {
        unit: 'mod-run-capture-analysis/practiceSet',
        lens: 'boundary-malformed',
        baseSeed: STRESS_SEED,
        iterPerCampaign: STRESS_ITER,
        executed: rows.length,
        invocations: rows.reduce((n, r) => n + r.invocations, 0),
        violations: rows.filter(r => r.violations.length > 0).length,
        observations: rows.filter(r => r.observations.length > 0).length,
        observationSeeds: rows
          .filter(r => r.observations.length > 0)
          .map(r => ({ id: r.id, seed: r.seed, observations: r.observations })),
        byCampaign,
        maxDurationMs: Math.max(0, ...rows.map(r => r.durationMs)),
        rows,
      },
      null,
      1,
    ),
  );
});

const NOW_ISO_ERROR = 'nowIso must be a parseable ISO timestamp.';

function describeRejected(rejected: unknown): string {
  return rejected instanceof Error
    ? `${rejected.name}: ${rejected.message.slice(0, 200)}`
    : String(rejected).slice(0, 200);
}

async function settle<T>(
  fn: () => Promise<T>,
): Promise<{ value: T | null; rejected: unknown; ms: number }> {
  const t = Date.now();
  try {
    const value = await fn();
    return { value, rejected: null, ms: Date.now() - t };
  } catch (error) {
    return {
      value: null,
      rejected: error ?? new Error('rejected with null/undefined'),
      ms: Date.now() - t,
    };
  }
}

function checkPollution(v: string[]): void {
  const proto = Object.prototype as unknown as Record<string, unknown>;
  if ('polluted' in proto || proto['polluted'] !== undefined)
    v.push('Object.prototype polluted');
  if (({} as Record<string, unknown>)['polluted'] !== undefined)
    v.push('fresh object inherits pollution');
}

// ─── Campaign P: corrupt stored record ──────────────────────────────────────

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

interface StoredMutation {
  raw: string;
  ops: string[];
  /**
   * What a correct parser+liveness check yields for this record: the live
   * sessionId it must resume, or null when the record must read as "no set".
   * `unknown` when the generator cannot say (free-form JSON), in which case
   * only the never-throw/never-write invariants apply.
   */
  expectLive: string | null | 'unknown';
}

function validStored(
  rng: Rng,
  sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
) {
  return {
    sessionId,
    shotType: rng.pick<ShotTypeSlug | null>([...SHOT_TYPES, null]),
    startedAtIso: plus(-60_000),
    lastActivityAtIso: plus(-rng.int(0, PRACTICE_SET_IDLE_TIMEOUT_MS)),
  };
}

function isLiveStamp(iso: unknown): boolean {
  if (typeof iso !== 'string') return false;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return false;
  const idle = T0_MS - ms;
  return idle >= 0 && idle <= PRACTICE_SET_IDLE_TIMEOUT_MS;
}

function mutateStored(rng: Rng): StoredMutation {
  const ops: string[] = [];
  const mode = rng.pick([
    'truncate',
    'brokenJson',
    'rootType',
    'fieldType',
    'timestamp',
    'idBoundary',
    'extraKeys',
    'pollution',
    'huge',
    'valid',
  ]);
  ops.push(mode);
  const base = validStored(rng);
  const fullJson = JSON.stringify(base);
  switch (mode) {
    case 'truncate': {
      const cut = rng.int(0, fullJson.length - 1);
      ops.push(`cut@${cut}`);
      const raw = fullJson.slice(0, cut);
      // A truncated JSON document never parses (cut < full length), except
      // cut=0 which is the empty string → "no record".
      return { raw, ops, expectLive: null };
    }
    case 'brokenJson': {
      const raw = rng.pick([
        '{',
        '}',
        '[',
        '{"sessionId":',
        '{"sessionId": "x", }',
        "{'sessionId': 'x'}",
        'undefined',
        'NaN',
        'Infinity',
        '-0',
        '1e999',
        '{"sessionId":"x","shotType":null,"startedAtIso":"","lastActivityAtIso":""}garbage',
        `\uFEFF${fullJson}`, // BOM prefix
        `${fullJson}${NULL_BYTE}`,
        fullJson.replace(/"/g, '\u201C'), // smart quotes
        fullJson.replace(/,/g, ';'),
        `${fullJson}\n${fullJson}`,
      ]);
      ops.push(`raw:${JSON.stringify(raw.slice(0, 24))}`);
      let parsesToValid = false;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        parsesToValid =
          !!parsed &&
          typeof parsed === 'object' &&
          !Array.isArray(parsed) &&
          typeof parsed['sessionId'] === 'string' &&
          parsed['sessionId'] !== '';
      } catch {
        parsesToValid = false;
      }
      return {
        raw,
        ops,
        expectLive: parsesToValid
          ? isLiveStamp(base.lastActivityAtIso)
            ? base.sessionId
            : null
          : null,
      };
    }
    case 'rootType': {
      const root = rng.pick<unknown>([
        null,
        true,
        false,
        0,
        -0,
        1e308,
        '',
        'string',
        [],
        [base],
        {},
        [[]],
      ]);
      ops.push(
        `root:${Array.isArray(root) ? 'array' : root === null ? 'null' : typeof root}`,
      );
      return { raw: JSON.stringify(root), ops, expectLive: null };
    }
    case 'fieldType': {
      const field = rng.pick([
        'sessionId',
        'shotType',
        'startedAtIso',
        'lastActivityAtIso',
      ] as const);
      const value = rng.chance(0.2) ? undefined : wrongJsonType(rng);
      const record: Record<string, unknown> = { ...base };
      if (value === undefined) delete record[field];
      else record[field] = value;
      ops.push(
        `${field}:${value === undefined ? 'missing' : (JSON.stringify(value)?.slice(0, 24) ?? typeof value)}`,
      );
      // Mirror the module's own rules to know whether the record is valid.
      const valid =
        typeof record['sessionId'] === 'string' &&
        (record['sessionId'] as string).length > 0 &&
        typeof record['startedAtIso'] === 'string' &&
        typeof record['lastActivityAtIso'] === 'string' &&
        (record['shotType'] === null || typeof record['shotType'] === 'string');
      const live = valid && isLiveStamp(record['lastActivityAtIso']);
      return {
        raw: JSON.stringify(record),
        ops,
        expectLive: live ? (record['sessionId'] as string) : null,
      };
    }
    case 'timestamp': {
      const which = rng.pick([
        'lastActivityAtIso',
        'startedAtIso',
        'both',
      ] as const);
      const iso = boundaryIso(rng);
      const record: Record<string, unknown> = { ...base };
      if (which !== 'startedAtIso') record['lastActivityAtIso'] = iso;
      if (which !== 'lastActivityAtIso') record['startedAtIso'] = iso;
      ops.push(`${which}:${JSON.stringify(iso.slice(0, 32))}`);
      const live = isLiveStamp(record['lastActivityAtIso']);
      return {
        raw: JSON.stringify(record),
        ops,
        expectLive: live ? base.sessionId : null,
      };
    }
    case 'idBoundary': {
      const id = rng.pick<string>([
        '',
        ' ',
        NULL_BYTE,
        `${base.sessionId}${NULL_BYTE}`,
        rng.pick(TRAVERSALS),
        rng.pick(POLLUTION_KEYS),
        NFC_E,
        NFD_E,
        HANGUL_NFC,
        HANGUL_NFD,
        FAMILY,
        LONE_SURROGATE,
        RTL_OVERRIDE,
        base.sessionId.toUpperCase(),
        bigString(rng),
        "'; DROP TABLE kv; --",
      ]);
      ops.push(`sessionId:${JSON.stringify(id.slice(0, 24))}`);
      const record = { ...base, sessionId: id };
      const live = id.length > 0 && isLiveStamp(record.lastActivityAtIso);
      return { raw: JSON.stringify(record), ops, expectLive: live ? id : null };
    }
    case 'extraKeys': {
      const record: Record<string, unknown> = {
        ...base,
        schemaVersion: rng.pick([2, 99, '3.0', null, 1e308]),
        [weirdString(rng).slice(0, 32) || 'k']: wrongJsonType(rng),
        nested: { deep: { deeper: [1, 2, { x: NaN }] } },
      };
      ops.push('extraKeys');
      const live = isLiveStamp(record['lastActivityAtIso']);
      return {
        raw: JSON.stringify(record),
        ops,
        expectLive: live ? base.sessionId : null,
      };
    }
    case 'pollution': {
      const key = rng.pick(POLLUTION_KEYS);
      const record: Record<string, unknown> = { ...base };
      const raw = rng.pick([
        `{"${key}":{"polluted":true},${fullJson.slice(1)}`,
        `{"sessionId":"${base.sessionId}","shotType":null,"startedAtIso":"${T0}","lastActivityAtIso":"${T0}","${key}":{"polluted":true}}`,
        `{"${key}":{"polluted":true}}`,
        JSON.stringify({ ...record, shotType: { [key]: { polluted: true } } }),
      ]);
      ops.push(`pollution:${key}`);
      let expectLive: StoredMutation['expectLive'] = 'unknown';
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const valid =
          typeof parsed['sessionId'] === 'string' &&
          parsed['sessionId'] !== '' &&
          typeof parsed['startedAtIso'] === 'string' &&
          typeof parsed['lastActivityAtIso'] === 'string' &&
          (parsed['shotType'] === null ||
            typeof parsed['shotType'] === 'string');
        expectLive =
          valid && isLiveStamp(parsed['lastActivityAtIso'])
            ? (parsed['sessionId'] as string)
            : null;
      } catch {
        expectLive = null;
      }
      return { raw, ops, expectLive };
    }
    case 'huge': {
      const field = rng.pick([
        'sessionId',
        'shotType',
        'startedAtIso',
        'lastActivityAtIso',
        'padding',
      ] as const);
      const big = bigString(rng);
      const record: Record<string, unknown> = { ...base, [field]: big };
      ops.push(`huge:${field}:${big.length}`);
      const live =
        field === 'lastActivityAtIso'
          ? false
          : isLiveStamp(base.lastActivityAtIso);
      return {
        raw: JSON.stringify(record),
        ops,
        expectLive: live
          ? field === 'sessionId'
            ? big
            : base.sessionId
          : null,
      };
    }
    default: {
      ops.push('valid');
      return {
        raw: fullJson,
        ops,
        expectLive: isLiveStamp(base.lastActivityAtIso) ? base.sessionId : null,
      };
    }
  }
}

// ─── Suite ──────────────────────────────────────────────────────────────────

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('practiceSet — boundary/malformed stress (seeded)', () => {
  test('replay contract: the same seed produces the same stored mutation', () => {
    const a = mutateStored(new Rng(seedFor('P', 3)));
    const b = mutateStored(new Rng(seedFor('P', 3)));
    expect(a.raw).toBe(b.raw);
    expect(a.ops).toEqual(b.ops);
  });

  describe('P. corrupt / boundary kv record', () => {
    campaignTest('P')('P:%i', async index => {
      const seed = seedFor('P', index);
      const rng = new Rng(seed);
      const mutation = mutateStored(rng);
      setActiveDataOwner(OWNER_A);
      const f = fakeDb({ [practiceSetKeyForOwner(OWNER_A)]: mutation.raw });
      const v: string[] = [];
      const obs: string[] = [];
      const shotType = rng.pick<ShotTypeSlug | null>([...SHOT_TYPES, null]);

      const plan = await settle(() =>
        planPracticeSet(f.db, { shotType, nowIso: T0 }),
      );
      const current = await settle(() => currentPracticeSetId(f.db, T0));
      let outcome = 'plan';
      if (plan.rejected !== null)
        v.push(`planPracticeSet threw: ${describeRejected(plan.rejected)}`);
      if (current.rejected !== null)
        v.push(
          `currentPracticeSetId threw: ${describeRejected(current.rejected)}`,
        );
      if (writes(f) > 0)
        v.push(`read-only plan/current performed ${writes(f)} write(s)`);
      if (f.unhandled.length > 0) v.push(`unexpected SQL: ${f.unhandled[0]}`);
      const p = plan.value;
      if (p) {
        if (typeof p.sessionId !== 'string' || p.sessionId.length === 0)
          v.push('plan without sessionId');
        if (p.owner !== OWNER_A) v.push(`plan owner ${p.owner} ≠ active owner`);
        if (p.nowIso !== T0) v.push(`plan.nowIso ${p.nowIso} ≠ injected clock`);
        if (mutation.expectLive === null) {
          outcome = 'fresh';
          if (p.resumed)
            v.push(
              `corrupt/expired record was resumed (${p.sessionId.slice(0, 40)})`,
            );
          if (!UUID_RE.test(p.sessionId))
            v.push(
              `fresh set id is not a v4 uuid: ${p.sessionId.slice(0, 40)}`,
            );
          if (p.startedAtIso !== T0) v.push('fresh set startedAt ≠ now');
          if (p.shotType !== shotType)
            v.push('fresh set did not take the caller shotType');
          if (current.value !== null)
            v.push(
              `currentPracticeSetId returned ${String(current.value).slice(0, 40)} for a dead record`,
            );
        } else if (mutation.expectLive !== 'unknown') {
          outcome = 'resumed';
          if (!p.resumed) v.push('live record was NOT resumed');
          if (p.sessionId !== mutation.expectLive)
            v.push('resumed a different sessionId than stored');
          if (current.value !== mutation.expectLive)
            v.push('currentPracticeSetId disagrees with plan');
          // Boundary values inside a syntactically valid live record are
          // accepted verbatim — observed, since sessionId/shotType are
          // string-typed, not validated against uuid / SHOT_TYPES.
          if (!UUID_RE.test(p.sessionId))
            obs.push(
              `resumed non-uuid sessionId (${p.sessionId.length} chars)`,
            );
          if (
            p.shotType !== null &&
            !(SHOT_TYPES as readonly string[]).includes(p.shotType)
          ) {
            obs.push('resumed non-slug shotType from kv');
          }
          if (!Number.isFinite(Date.parse(p.startedAtIso)))
            obs.push('resumed unparseable startedAtIso from kv');
        } else {
          outcome = p.resumed ? 'resumed' : 'fresh';
        }
      } else if (plan.rejected === null) {
        v.push('plan returned null for a signed-in owner');
      }
      checkPollution(v);
      recordRow({
        id: `P:${index}`,
        seed,
        campaign: 'P',
        ops: mutation.ops,
        outcome,
        writes: writes(f),
        durationMs: plan.ms + current.ms,
        violations: v,
        observations: obs,
        rejected:
          plan.rejected === null ? null : describeRejected(plan.rejected),
        payloadBytes: mutation.raw.length,
        invocations: 2,
      });
    });
  });

  describe('Q. caller input boundaries', () => {
    campaignTest('Q')('Q:%i', async index => {
      const seed = seedFor('Q', index);
      const rng = new Rng(seed);
      const ops: string[] = [];
      const ownerMode = rng.pick(['uuid', 'guest', 'signedOut'] as const);
      const owner =
        ownerMode === 'uuid'
          ? OWNER_A
          : ownerMode === 'guest'
            ? GUEST_DATA_OWNER
            : SIGNED_OUT_DATA_OWNER;
      setActiveDataOwner(owner);
      ops.push(`owner:${ownerMode}`);
      const stored = rng.chance(0.5) ? validStored(rng) : null;
      const f = fakeDb(
        stored
          ? { [practiceSetKeyForOwner(owner)]: JSON.stringify(stored) }
          : {},
      );
      ops.push(stored ? 'stored:live?' : 'stored:none');

      const shotType = rng.chance(0.5)
        ? rng.pick<ShotTypeSlug | null>([...SHOT_TYPES, null])
        : (wrongType(rng) as ShotTypeSlug);
      ops.push(`shotType:${typeof shotType}`);
      const nowMode = rng.pick([
        'valid',
        'boundary',
        'undefined',
        'wrongType',
      ] as const);
      const nowIso: unknown =
        nowMode === 'valid'
          ? T0
          : nowMode === 'boundary'
            ? boundaryIso(rng)
            : nowMode === 'undefined'
              ? undefined
              : wrongType(rng);
      ops.push(
        `nowIso:${nowMode}:${typeof nowIso === 'string' ? JSON.stringify(nowIso.slice(0, 24)) : typeof nowIso}`,
      );
      const preferredMode = rng.pick([
        'none',
        'null',
        'empty',
        'uuid',
        'stored',
        'weird',
        'big',
      ] as const);
      const preferred: unknown =
        preferredMode === 'none'
          ? undefined
          : preferredMode === 'null'
            ? null
            : preferredMode === 'empty'
              ? ''
              : preferredMode === 'uuid'
                ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
                : preferredMode === 'stored'
                  ? (stored?.sessionId ??
                    'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
                  : preferredMode === 'weird'
                    ? weirdString(rng)
                    : bigString(rng);
      ops.push(`preferred:${preferredMode}`);

      const input = {
        shotType,
        nowIso,
        preferredSessionId: preferred,
      } as unknown as Parameters<typeof planPracticeSet>[1];
      const v: string[] = [];
      const obs: string[] = [];
      const plan = await settle(() => planPracticeSet(f.db, input));
      const current = await settle(() =>
        currentPracticeSetId(f.db, nowIso as string | undefined),
      );

      // The ONLY legitimate throw: an unparseable clock string. `resolveNow`
      // uses `nowIso ?? new Date().toISOString()`, so null/undefined default
      // to the real clock; any other non-string is Date.parse'd.
      let clockMs = NaN;
      let clockParseThrows = false;
      try {
        clockMs =
          nowIso === undefined || nowIso === null
            ? Date.now()
            : Date.parse(nowIso as string);
      } catch {
        // `Date.parse` itself throws for a null-prototype object (no
        // toString) — a type violation of `nowIso?: string` the module
        // surfaces as the same TypeError; recorded, not asserted.
        clockParseThrows = true;
      }
      const clockThrows = !Number.isFinite(clockMs);
      let outcome: string;
      if (owner === SIGNED_OUT_DATA_OWNER) {
        outcome = 'signed_out';
        if (plan.rejected !== null)
          v.push(`signed-out plan threw: ${describeRejected(plan.rejected)}`);
        if (plan.value !== null) v.push('signed-out owner got a plan');
        if (current.value !== null)
          v.push('signed-out owner got a current set');
        if (current.rejected !== null)
          v.push(
            `signed-out current threw: ${describeRejected(current.rejected)}`,
          );
        if (f.calls.length > 0)
          v.push(`signed-out owner touched the db (${f.calls.length} call(s))`);
      } else if (clockThrows) {
        outcome = 'clock_rejected';
        for (const [name, r] of [
          ['plan', plan],
          ['current', current],
        ] as const) {
          if (r.rejected === null)
            v.push(`${name} accepted an unparseable clock`);
          else if (clockParseThrows) {
            obs.push(
              `type-violation nowIso (${typeof nowIso}) threw ${describeRejected(r.rejected)}`,
            );
          } else if (
            !(r.rejected instanceof Error) ||
            r.rejected.message !== NOW_ISO_ERROR
          ) {
            v.push(
              `${name} threw the wrong error: ${describeRejected(r.rejected)}`,
            );
          }
        }
        if (writes(f) > 0) v.push('unparseable clock still wrote');
        // The clock is validated before the kv read.
        if (f.calls.length > 0)
          v.push(
            `unparseable clock still read the db (${f.calls.length} call(s))`,
          );
      } else {
        if (plan.rejected !== null)
          v.push(`plan threw: ${describeRejected(plan.rejected)}`);
        if (current.rejected !== null)
          v.push(`current threw: ${describeRejected(current.rejected)}`);
        if (writes(f) > 0)
          v.push(`read-only plan/current performed ${writes(f)} write(s)`);
        const p = plan.value;
        if (!p) {
          outcome = 'null_plan';
          if (plan.rejected === null) v.push('signed-in owner got a null plan');
        } else {
          if (p.owner !== owner) v.push('plan owner ≠ active owner');
          const preferredStr =
            typeof preferred === 'string' && preferred.length > 0
              ? preferred
              : null;
          const liveStored =
            stored &&
            isLiveStamp(stored.lastActivityAtIso) &&
            Number.isFinite(clockMs) &&
            clockMs === T0_MS
              ? stored
              : null;
          if (preferredStr !== null) {
            outcome = 'preferred';
            if (p.sessionId !== preferredStr)
              v.push('preferredSessionId did not win');
            if (!p.resumed) v.push('preferred handoff not marked resumed');
            if (preferredStr.length > 4096)
              obs.push(
                `preferred id of ${preferredStr.length} chars echoed verbatim`,
              );
            if (preferredStr.includes(NULL_BYTE))
              obs.push('preferred id with null byte echoed verbatim');
          } else if (nowMode === 'valid' && liveStored) {
            outcome = 'resumed';
            if (!p.resumed || p.sessionId !== liveStored.sessionId)
              v.push('live stored set not resumed');
          } else if (nowMode === 'valid' && stored && !liveStored) {
            outcome = 'fresh';
            if (p.resumed) v.push('expired stored set resumed');
            if (!UUID_RE.test(p.sessionId)) v.push('fresh id not uuid');
          } else if (!stored) {
            outcome = 'fresh';
            if (p.resumed) v.push('resumed with nothing stored');
            if (!UUID_RE.test(p.sessionId)) v.push('fresh id not uuid');
          } else {
            // Boundary clock vs a stored record: liveness depends on the
            // relation of the parsed clock to the stamp; assert consistency
            // with `currentPracticeSetId` instead of recomputing.
            outcome = p.resumed ? 'resumed' : 'fresh';
            const cur = current.value;
            if (p.resumed && cur !== p.sessionId)
              v.push('plan resumed but current disagrees');
            if (!p.resumed && cur !== null)
              v.push('plan fresh but current names a live set');
          }
          if (typeof p.sessionId !== 'string' || p.sessionId.length === 0)
            v.push('plan without sessionId');
          if (typeof p.nowIso !== 'string') {
            // `resolveNow` passes a non-string clock through as-is once
            // Date.parse(String(x)) is finite — a type violation of
            // `nowIso?: string`, recorded rather than asserted.
            obs.push(
              `non-string nowIso (${typeof nowIso}) carried into plan.nowIso`,
            );
          } else if (!Number.isFinite(Date.parse(p.nowIso))) {
            v.push('plan.nowIso unparseable');
          }
          if (!p.resumed && p.shotType !== shotType)
            v.push('fresh plan dropped caller shotType');
          if (!p.resumed && typeof shotType !== 'string' && shotType !== null) {
            obs.push(
              `non-string shotType (${typeof shotType}) accepted into a plan`,
            );
          }
        }
      }
      checkPollution(v);
      recordRow({
        id: `Q:${index}`,
        seed,
        campaign: 'Q',
        ops,
        outcome,
        writes: writes(f),
        durationMs: plan.ms + current.ms,
        violations: v,
        observations: obs,
        rejected:
          plan.rejected === null ? null : describeRejected(plan.rejected),
        payloadBytes: typeof preferred === 'string' ? preferred.length : 0,
        invocations: 2,
      });
    });
  });

  describe('R. commit / note / concurrency', () => {
    campaignTest('R')('R:%i', async index => {
      const seed = seedFor('R', index);
      const rng = new Rng(seed);
      const ops: string[] = [];
      const v: string[] = [];
      const obs: string[] = [];
      const mode = rng.pick([
        'commitNew',
        'commitResumed',
        'commitBadClock',
        'ownerSwitch',
        'note',
        'concurrent',
        'resumeOrStart',
      ] as const);
      ops.push(mode);
      setActiveDataOwner(OWNER_A);
      const f = fakeDb();
      const outcome = mode;
      let invocations = 1;
      let ms = 0;

      const boundaryShot = rng.chance(0.5)
        ? rng.pick<ShotTypeSlug | null>([...SHOT_TYPES, null])
        : (weirdString(rng) as ShotTypeSlug);
      const boundaryId = rng.chance(0.5)
        ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        : weirdString(rng) || 'x';
      ops.push(
        `shotType:${typeof boundaryShot === 'string' ? JSON.stringify(boundaryShot.slice(0, 16)) : 'null'}`,
      );

      const plan: PracticeSetPlan = {
        sessionId: boundaryId,
        resumed: false,
        shotType: boundaryShot,
        startedAtIso: rng.chance(0.7) ? T0 : boundaryIso(rng),
        nowIso: T0,
        owner: OWNER_A,
      };

      switch (mode) {
        case 'commitNew': {
          const r = await settle(() => commitPracticeSet(f.db, plan));
          ms = r.ms;
          if (r.rejected !== null)
            v.push(`commit threw: ${describeRejected(r.rejected)}`);
          if (f.sessions.length !== 1)
            v.push(`new set wrote ${f.sessions.length} session rows`);
          if (f.outbox.filter(o => o.kind === 'session.create').length !== 1)
            v.push('new set outbox ≠ 1 session.create');
          const begins = f.calls.filter(
            c => c.sql.trim() === 'BEGIN IMMEDIATE',
          ).length;
          const commits = f.calls.filter(c => c.sql.trim() === 'COMMIT').length;
          if (begins !== 1 || commits !== 1)
            v.push(
              `session save not in one transaction (${begins}/${commits})`,
            );
          const kv = f.kv.get(practiceSetKeyForOwner(OWNER_A));
          if (!kv) v.push('kv record not written');
          else {
            const parsed = JSON.parse(kv) as Record<string, unknown>;
            if (parsed['sessionId'] !== boundaryId)
              v.push('kv sessionId ≠ plan');
            if (parsed['lastActivityAtIso'] !== T0)
              v.push('kv activity stamp ≠ commit clock');
          }
          if (f.sessions[0]?.owner !== OWNER_A)
            v.push('session row owner ≠ plan owner');
          if (f.sessions[0]?.mode !== PRACTICE_SET_MODE)
            v.push('session mode ≠ practice_set');
          if (
            typeof boundaryShot === 'string' &&
            !(SHOT_TYPES as readonly string[]).includes(boundaryShot)
          ) {
            obs.push('non-slug shotType persisted to local_session + outbox');
          }
          if (boundaryId.length > 4096)
            obs.push(`${boundaryId.length}-char sessionId persisted`);
          for (const o of f.outbox) {
            try {
              JSON.parse(o.payload);
            } catch {
              v.push('outbox payload is not valid JSON');
            }
          }
          break;
        }
        case 'commitResumed': {
          const resumed = { ...plan, resumed: true };
          const r = await settle(() => commitPracticeSet(f.db, resumed));
          ms = r.ms;
          if (r.rejected !== null)
            v.push(`resumed commit threw: ${describeRejected(r.rejected)}`);
          if (f.sessions.length !== 0)
            v.push('resumed set wrote a session row');
          if (f.outbox.length !== 0) v.push('resumed set wrote outbox');
          if (writes(f) !== 1)
            v.push(`resumed commit made ${writes(f)} write(s), want 1 (kv)`);
          break;
        }
        case 'commitBadClock': {
          const bad = rng.pick([
            'not a date',
            '',
            NULL_BYTE,
            'NaN',
            '2026-13-45T99:99:99.000Z',
            bigString(rng),
          ]);
          ops.push(`clock:${JSON.stringify(bad.slice(0, 16))}`);
          const r = await settle(() => commitPracticeSet(f.db, plan, bad));
          ms = r.ms;
          if (r.rejected === null)
            v.push('commit accepted an unparseable clock');
          else if (
            !(r.rejected instanceof Error) ||
            r.rejected.message !== NOW_ISO_ERROR
          )
            v.push(`wrong error: ${describeRejected(r.rejected)}`);
          if (f.calls.length > 0)
            v.push(
              `unparseable commit clock still touched the db (${f.calls.length})`,
            );
          break;
        }
        case 'ownerSwitch': {
          // Plan under A, commit while B (or nobody) is active.
          const next = rng.pick([
            OWNER_B,
            GUEST_DATA_OWNER,
            SIGNED_OUT_DATA_OWNER,
          ]);
          ops.push(`switchTo:${next === OWNER_B ? 'B' : next}`);
          setActiveDataOwner(next);
          const r = await settle(() =>
            commitPracticeSet(f.db, { ...plan, resumed: rng.chance(0.5) }),
          );
          ms = r.ms;
          const kvA = f.kv.get(practiceSetKeyForOwner(OWNER_A));
          const kvOther = [...f.kv.keys()].filter(
            k => k !== practiceSetKeyForOwner(OWNER_A),
          );
          if (kvOther.length > 0)
            v.push(`kv written under a non-plan owner key: ${kvOther[0]}`);
          if (next === SIGNED_OUT_DATA_OWNER) {
            if (r.rejected !== null && !(r.rejected instanceof Error))
              v.push('non-Error throw');
            // A new-set commit throws in saveSession (requireWritableDataOwner);
            // a resumed commit reaches the kv write with the PLAN owner.
            if (f.sessions.length > 0)
              v.push('signed-out commit wrote a session row');
            if (kvA)
              obs.push(
                'resumed-plan commit wrote kv for the plan owner while signed out',
              );
          } else {
            if (r.rejected !== null)
              v.push(
                `commit after owner switch threw: ${describeRejected(r.rejected)}`,
              );
            if (f.sessions.some(s => s.owner !== OWNER_A)) {
              obs.push(
                `session row saved under active owner ${f.sessions[0]?.owner === GUEST_DATA_OWNER ? 'guest' : 'B'} while kv names plan owner A`,
              );
            }
          }
          break;
        }
        case 'note': {
          const sid = rng.pick([
            '',
            boundaryId,
            weirdString(rng),
            bigString(rng),
          ]);
          ops.push(`note:${JSON.stringify(sid.slice(0, 16))}`);
          const clock = rng.chance(0.8) ? T0 : boundaryIso(rng);
          const r = await settle(() =>
            notePracticeSetAnalysis(f.db, sid, clock),
          );
          ms = r.ms;
          const clockOk = Number.isFinite(Date.parse(clock));
          if (sid.length === 0) {
            if (r.rejected !== null) v.push('empty sessionId note threw');
            if (f.calls.length > 0)
              v.push('empty sessionId note touched the db');
          } else if (!clockOk) {
            if (
              r.rejected === null ||
              !(r.rejected instanceof Error) ||
              r.rejected.message !== NOW_ISO_ERROR
            ) {
              v.push(
                `bad clock note: ${r.rejected === null ? 'accepted' : describeRejected(r.rejected)}`,
              );
            }
            if (f.calls.length > 0) v.push('bad clock note touched the db');
          } else {
            if (r.rejected !== null)
              v.push(`note threw: ${describeRejected(r.rejected)}`);
            if (writes(f) !== 1)
              v.push(`note made ${writes(f)} write(s), want 1`);
            const kv = f.kv.get(practiceSetKeyForOwner(OWNER_A));
            if (
              !kv ||
              (JSON.parse(kv) as { sessionId: string }).sessionId !== sid
            )
              v.push('note did not record the sessionId');
          }
          break;
        }
        case 'concurrent': {
          const n = rng.int(2, 8);
          invocations = n;
          const t = Date.now();
          const results = await Promise.all(
            Array.from({ length: n }, (_, i) =>
              settle(async () => {
                const kind = rng.pick([
                  'plan',
                  'resumeOrStart',
                  'note',
                  'current',
                ] as const);
                switch (kind) {
                  case 'plan':
                    return {
                      kind,
                      value: await planPracticeSet(f.db, {
                        shotType: null,
                        nowIso: T0,
                      }),
                    };
                  case 'resumeOrStart':
                    return {
                      kind,
                      value: await resumeOrStartPracticeSet(f.db, {
                        shotType: rng.pick(SHOT_TYPES),
                        nowIso: plus(i),
                      }),
                    };
                  case 'note':
                    return {
                      kind,
                      value: await notePracticeSetAnalysis(
                        f.db,
                        `s-${i}`,
                        plus(i),
                      ),
                    };
                  default:
                    return {
                      kind,
                      value: await currentPracticeSetId(f.db, T0),
                    };
                }
              }),
            ),
          );
          ms = Date.now() - t;
          ops.push(`n:${n}`);
          for (const r of results) {
            if (r.rejected !== null)
              v.push(`concurrent op threw: ${describeRejected(r.rejected)}`);
          }
          if (f.unhandled.length > 0)
            v.push(`unexpected SQL: ${f.unhandled[0]}`);
          const kv = f.kv.get(practiceSetKeyForOwner(OWNER_A));
          if (kv) {
            try {
              const parsed = JSON.parse(kv) as Record<string, unknown>;
              if (
                typeof parsed['sessionId'] !== 'string' ||
                !parsed['sessionId']
              )
                v.push('kv left without sessionId');
            } catch {
              v.push('kv left with invalid JSON');
            }
          }
          const created = results.filter(
            r => r.value?.kind === 'resumeOrStart',
          ).length;
          if (f.sessions.length > created)
            v.push(
              `more session rows (${f.sessions.length}) than resumeOrStart calls (${created})`,
            );
          if (
            f.sessions.length !==
            f.outbox.filter(o => o.kind === 'session.create').length
          ) {
            v.push('session rows ≠ session.create outbox rows');
          }
          if (f.sessions.length > 1)
            obs.push(
              `${f.sessions.length} sets created by ${created} concurrent resumeOrStart calls`,
            );
          break;
        }
        default: {
          const stored = rng.chance(0.5) ? validStored(rng) : null;
          if (stored)
            f.kv.set(practiceSetKeyForOwner(OWNER_A), JSON.stringify(stored));
          const r = await settle(() =>
            resumeOrStartPracticeSet(f.db, {
              shotType: boundaryShot,
              nowIso: T0,
            }),
          );
          ms = r.ms;
          if (r.rejected !== null)
            v.push(`resumeOrStart threw: ${describeRejected(r.rejected)}`);
          const live = stored && isLiveStamp(stored.lastActivityAtIso);
          if (r.value) {
            if (
              live &&
              (!r.value.resumed || r.value.sessionId !== stored.sessionId)
            )
              v.push('live set not resumed');
            if (
              !live &&
              (r.value.resumed || !UUID_RE.test(r.value.sessionId ?? ''))
            )
              v.push('expired/no set not started fresh');
            if (live && f.sessions.length !== 0)
              v.push('resumed set wrote a session row');
            if (!live && f.sessions.length !== 1)
              v.push(`fresh set wrote ${f.sessions.length} session rows`);
          }
          break;
        }
      }
      checkPollution(v);
      recordRow({
        id: `R:${index}`,
        seed,
        campaign: 'R',
        ops,
        outcome,
        writes: writes(f),
        durationMs: ms,
        violations: v,
        observations: obs,
        rejected: null,
        payloadBytes: 0,
        invocations,
      });
    });
  });
});
