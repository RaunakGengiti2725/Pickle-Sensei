/**
 * STRESS — consistency ledger parser, lens: boundary / malformed input.
 *
 * `parseConsistencyLedger` is the ONLY door between the SQLite kv row and
 * the consistency store. Whatever a corrupt, truncated, downgraded or
 * hostile row contains, it must come back as a well-typed ledger: never a
 * throw, never a prototype-polluting key, never a non-string field, and
 * the result must be stable under the store's own rewrite
 * (`JSON.stringify` → parse again yields the same ledger, so a refresh can
 * never drift the persisted state).
 *
 * Seeded (mulberry32): every iteration is replayable from its seed.
 *   STRESS_ITER=<n>   iterations per campaign (default 150, CI-fast)
 *   STRESS_OUT=<dir>  write the seed → outcome table as JSON
 */
import * as fs from 'fs';
import * as path from 'path';

// The parser is pure; the store module merely imports the SQLite bridge.
jest.mock('../../src/data/db', () => ({ getDb: () => ({}) }));
jest.mock('../../src/data/repository', () => ({
  getKv: async () => null,
  setKv: async () => undefined,
  listActivityShots: async () => [],
}));

import { parseConsistencyLedger } from '../../src/consistency/store';

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 150));
const OUT_DIR = process.env['STRESS_OUT'];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}
function int(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

interface Row {
  seed: number;
  strategy: string;
  rawLength: number;
  outcome: 'HELD' | 'BROKEN';
  detail?: string;
}
const table: Row[] = [];
afterAll(() => {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'ledger-boundary.json'),
    JSON.stringify(
      {
        campaign: 'consistency-ledger-boundary',
        iterations: table.length,
        broken: table.filter(r => r.outcome === 'BROKEN').length,
        rows: table,
      },
      null,
      1,
    ),
  );
});

// ─── Payload atoms ──────────────────────────────────────────────────────────

const BIG = 'x'.repeat(70_000);
const HOSTILE_STRINGS: readonly string[] = [
  '',
  ' ',
  '\u0000',
  'a\u0000b',
  '\uFEFF',
  BIG,
  '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'.repeat(2_000),
  '👨‍👩‍👧‍👦'.repeat(5_000),
  '\u00e9',
  'e\u0301',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '../../etc/passwd',
  '..\\..\\windows',
  'consistency:../other-owner',
  '%2e%2e%2f',
  '2026-03-10T10:00:00.000Z',
  '2026-02-30T10:00:00.000Z',
  '0099-01-01T00:00:00.000Z',
  '+010000-01-01T00:00:00.000Z',
  '12345',
  'not-a-date',
  '\ud800',
  '\udfff\ud800',
];
const HOSTILE_SCALARS: readonly unknown[] = [
  null,
  true,
  false,
  0,
  -0,
  1,
  -1,
  1e308,
  -1e308,
  5e-324,
  2 ** 53,
  2 ** 53 + 1,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_SAFE_INTEGER,
  [],
  {},
  [[]],
  { a: 1 },
  [null],
];

function hostileValue(rng: () => number, depth = 0): unknown {
  const roll = rng();
  if (roll < 0.35) return pick(rng, HOSTILE_STRINGS);
  if (roll < 0.7) return pick(rng, HOSTILE_SCALARS);
  if (depth > 3) return null;
  if (roll < 0.85) {
    return Array.from({ length: int(rng, 4) }, () =>
      hostileValue(rng, depth + 1),
    );
  }
  const obj: Record<string, unknown> = {};
  for (let i = 0; i < int(rng, 4); i += 1) {
    obj[pick(rng, HOSTILE_STRINGS)] = hostileValue(rng, depth + 1);
  }
  return obj;
}

function validDrill(rng: () => number, index: number) {
  return {
    id: `drill-${index}-${int(rng, 1_000_000)}`,
    slug: pick(rng, ['contact-shadow', 'dink-ladder', 'reset-wall']),
    title: pick(rng, ['Contact Shadow Reps', 'Dink Ladder', 'Reset Wall']),
    completedAtIso: `2026-0${1 + int(rng, 9)}-${String(
      1 + int(rng, 28),
    ).padStart(2, '0')}T1${int(rng, 10)}:00:00.000Z`,
  };
}

function validLedger(rng: () => number) {
  return {
    version: 1,
    drills: Array.from({ length: int(rng, 12) }, (_, i) => validDrill(rng, i)),
    celebrated: Object.fromEntries(
      Array.from({ length: int(rng, 5) }, () => [
        pick(rng, [
          'streak.1',
          'streak.3',
          'streak.7',
          'volume.sessions100',
          'volume.specialist',
        ]),
        `2026-03-${String(1 + int(rng, 28)).padStart(2, '0')}`,
      ]),
    ),
    daySecuredShownDay: rng() < 0.5 ? '2026-03-10' : null,
  };
}

// ─── Generation strategies ─────────────────────────────────────────────────

type Strategy = (rng: () => number) => string;

const STRATEGIES: Record<string, Strategy> = {
  junkBytes: rng => {
    const length = int(rng, 200);
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += String.fromCharCode(int(rng, rng() < 0.7 ? 128 : 0x10000));
    }
    return out;
  },
  truncated: rng => {
    const raw = JSON.stringify(validLedger(rng));
    return raw.slice(0, int(rng, raw.length));
  },
  mutated: rng => {
    const chars = [...JSON.stringify(validLedger(rng))];
    const edits = 1 + int(rng, 5);
    for (let i = 0; i < edits && chars.length > 0; i += 1) {
      const at = int(rng, chars.length);
      const op = rng();
      const glyph = pick(rng, [
        '"',
        '{',
        '}',
        '[',
        ']',
        ',',
        ':',
        '\\',
        'n',
        '0',
        '\u0000',
        'é',
      ]);
      if (op < 0.34) chars[at] = glyph;
      else if (op < 0.67) chars.splice(at, 0, glyph);
      else chars.splice(at, 1);
    }
    return chars.join('');
  },
  wrongTypes: rng => {
    const ledger: Record<string, unknown> = validLedger(rng);
    for (const key of [
      'version',
      'drills',
      'celebrated',
      'daySecuredShownDay',
    ]) {
      if (rng() < 0.5) ledger[key] = hostileValue(rng);
    }
    if (rng() < 0.3) ledger[pick(rng, HOSTILE_STRINGS)] = hostileValue(rng);
    return JSON.stringify(ledger);
  },
  wrongDrillFields: rng => {
    const ledger = validLedger(rng);
    const drills: unknown[] = ledger.drills.map(drill => {
      const record: Record<string, unknown> = { ...drill };
      for (const key of ['id', 'slug', 'title', 'completedAtIso']) {
        if (rng() < 0.4) record[key] = hostileValue(rng);
        if (rng() < 0.1) delete record[key];
      }
      return record;
    });
    for (let i = 0; i < int(rng, 4); i += 1) drills.push(hostileValue(rng));
    return JSON.stringify({ ...ledger, drills });
  },
  protoPollution: rng => {
    const payload = pick(rng, [
      '{"__proto__":{"polluted":"yes"},"drills":[]}',
      '{"constructor":{"prototype":{"polluted":"yes"}},"drills":[]}',
      '{"drills":[{"__proto__":{"polluted":"yes"},"id":"a","completedAtIso":"2026-03-10T10:00:00.000Z"}]}',
      '{"celebrated":{"__proto__":"2026-03-10","constructor":"2026-03-11","polluted":"2026-03-12"}}',
      '{"celebrated":{"__proto__":{"polluted":"yes"}}}',
      '{"drills":{"__proto__":[{"id":"a","completedAtIso":"x"}],"length":1}}',
      '{"version":{"__proto__":null},"drills":[],"celebrated":{"hasOwnProperty":"2026-03-10"}}',
    ]);
    return payload;
  },
  futureSchema: rng => {
    const ledger = validLedger(rng);
    return JSON.stringify({
      ...ledger,
      version: pick(rng, [
        2,
        3,
        99,
        '1',
        '2',
        -1,
        1.5,
        Number.POSITIVE_INFINITY,
        null,
      ]),
      drills: ledger.drills.map(drill => ({
        ...drill,
        futureField: hostileValue(rng),
        completedAtIso:
          rng() < 0.3 ? { iso: drill.completedAtIso } : drill.completedAtIso,
      })),
      shields: hostileValue(rng),
      celebratedV2: hostileValue(rng),
    });
  },
  oversized: rng => {
    const ledger = validLedger(rng);
    const mode = int(rng, 4);
    if (mode === 0) {
      return JSON.stringify({
        ...ledger,
        drills: Array.from({ length: 5_000 }, (_, i) => validDrill(rng, i)),
      });
    }
    if (mode === 1) {
      return JSON.stringify({
        ...ledger,
        drills: [{ id: BIG, slug: BIG, title: BIG, completedAtIso: BIG }],
      });
    }
    if (mode === 2) {
      const depth = 2_000 + int(rng, 3_000);
      return `{"drills":${'['.repeat(depth)}${']'.repeat(depth)}}`;
    }
    return JSON.stringify({
      ...ledger,
      celebrated: Object.fromEntries(
        Array.from({ length: 3_000 }, (_, i) => [`k${i}`, BIG.slice(0, 100)]),
      ),
    });
  },
  notAnObject: rng =>
    pick(rng, [
      '[]',
      '[1,2]',
      '"string"',
      '42',
      'null',
      'true',
      '1e999',
      '-0',
      '[{"drills":[]}]',
      '{}',
      '{"drills":null}',
      '  {"drills":[]}  ',
      '\uFEFF{"drills":[]}',
      '{"drills":[]}\u0000',
      'NaN',
      'undefined',
      '{"drills":[],}',
      "{'drills':[]}",
    ]),
  unicodeNormalization: rng => {
    const nfc = 'caf\u00e9';
    const nfd = 'cafe\u0301';
    const ledger = validLedger(rng);
    return JSON.stringify({
      ...ledger,
      drills: [
        {
          id: nfc,
          slug: nfc,
          title: nfc,
          completedAtIso: '2026-03-10T10:00:00.000Z',
        },
        {
          id: nfd,
          slug: nfd,
          title: nfd,
          completedAtIso: '2026-03-10T11:00:00.000Z',
        },
        ...ledger.drills,
      ],
      celebrated: {
        ...ledger.celebrated,
        [nfc]: '2026-03-10',
        [nfd]: '2026-03-11',
      },
    });
  },
};
const STRATEGY_NAMES = Object.keys(STRATEGIES);

// ─── Assertions ────────────────────────────────────────────────────────────

const ISO_KEY = /^\d{4}-\d{2}-\d{2}$/;

function checkLedger(raw: string): string | null {
  let ledger: ReturnType<typeof parseConsistencyLedger>;
  try {
    ledger = parseConsistencyLedger(raw);
  } catch (error) {
    return `threw: ${String(error)}`;
  }
  if (!ledger || typeof ledger !== 'object') return 'not an object';
  if (ledger.version !== 1) return `version ${String(ledger.version)}`;
  if (!Array.isArray(ledger.drills)) return 'drills not array';
  if (Object.getPrototypeOf(ledger.celebrated) !== Object.prototype) {
    return 'celebrated prototype replaced';
  }
  if (Object.prototype.hasOwnProperty.call(ledger.celebrated, '__proto__')) {
    return 'celebrated has own __proto__';
  }
  for (const drill of ledger.drills) {
    if (Object.getPrototypeOf(drill) !== Object.prototype)
      return 'drill prototype replaced';
    for (const key of ['id', 'slug', 'title', 'completedAtIso'] as const) {
      if (typeof drill[key] !== 'string') return `drill.${key} not string`;
    }
    if (!drill.id) return 'empty drill id kept';
    if (!drill.completedAtIso) return 'empty completedAtIso kept';
    if (Object.keys(drill).length !== 4) return 'drill carries extra keys';
  }
  for (const [key, value] of Object.entries(ledger.celebrated)) {
    if (typeof value !== 'string') return `celebrated[${key}] not string`;
  }
  if (
    ledger.daySecuredShownDay !== null &&
    typeof ledger.daySecuredShownDay !== 'string'
  ) {
    return 'daySecuredShownDay wrong type';
  }
  // Prototype pollution: nothing leaked onto Object.prototype.
  if ('polluted' in {} || Object.keys(Object.prototype).length > 0) {
    return 'Object.prototype polluted';
  }
  // Rewrite stability: the store persists JSON.stringify(ledger); parsing
  // that back must reproduce the same ledger (otherwise refresh drifts).
  const roundTrip = parseConsistencyLedger(JSON.stringify(ledger));
  if (JSON.stringify(roundTrip) !== JSON.stringify(ledger)) {
    return 'rewrite is not idempotent';
  }
  void ISO_KEY;
  return null;
}

// ─── Campaign ──────────────────────────────────────────────────────────────

describe('parseConsistencyLedger under boundary / malformed input', () => {
  it(`never throws, never pollutes, always yields a rewrite-stable typed ledger (${ITER} seeded cases)`, () => {
    const failures: Row[] = [];
    for (let iteration = 0; iteration < ITER; iteration += 1) {
      const seed = 7_000_000 + iteration;
      const rng = mulberry32(seed);
      const strategy = STRATEGY_NAMES[iteration % STRATEGY_NAMES.length]!;
      const raw = STRATEGIES[strategy]!(rng);
      const detail = checkLedger(raw);
      const row: Row = {
        seed,
        strategy,
        rawLength: raw.length,
        outcome: detail ? 'BROKEN' : 'HELD',
        ...(detail ? { detail } : {}),
      };
      table.push(row);
      if (detail) failures.push(row);
    }
    expect(failures).toEqual([]);
  });

  it('keeps every valid drill when a sibling entry is malformed (no collateral data loss)', () => {
    const rng = mulberry32(42);
    const good = Array.from({ length: 6 }, (_, i) => validDrill(rng, i));
    const junk = [
      null,
      42,
      'x',
      [],
      { id: 7 },
      { completedAtIso: 'x' },
      { id: '', completedAtIso: 'x' },
    ];
    const raw = JSON.stringify({
      version: 1,
      drills: [...junk, ...good, ...junk],
      celebrated: { 'streak.1': '2026-03-01', bad: 1 },
      daySecuredShownDay: 5,
    });
    const ledger = parseConsistencyLedger(raw);
    expect(ledger.drills).toEqual(good);
    expect(ledger.celebrated).toEqual({ 'streak.1': '2026-03-01' });
    expect(ledger.daySecuredShownDay).toBeNull();
  });

  it('treats the prototype-pollution corpus as inert', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 40; i += 1) {
      const raw = STRATEGIES['protoPollution']!(rng);
      expect(checkLedger(raw)).toBeNull();
    }
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('falls back to the empty ledger for null / empty / non-object payloads', () => {
    for (const raw of [null, '', 'null', '[]', '"x"', '0', 'true']) {
      expect(parseConsistencyLedger(raw)).toEqual({
        version: 1,
        drills: [],
        celebrated: {},
        daySecuredShownDay: null,
      });
    }
  });

  it('parses a 5,000-drill / 70KB-field ledger within budget', () => {
    const rng = mulberry32(99);
    const raw = JSON.stringify({
      version: 1,
      drills: Array.from({ length: 5_000 }, (_, i) => ({
        ...validDrill(rng, i),
        title: BIG,
      })),
      celebrated: {},
      daySecuredShownDay: null,
    });
    const startedAt = Date.now();
    const ledger = parseConsistencyLedger(raw);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(ledger.drills).toHaveLength(5_000);
  });
});
