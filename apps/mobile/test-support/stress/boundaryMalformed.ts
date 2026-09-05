import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Seeded boundary / malformed-input generators for the notification module
 * stress campaigns (`__tests__/stress/`). Every value is a pure function of
 * a 32-bit seed, so any table row replays exactly from its seed.
 *
 * Knobs (all optional):
 *   STRESS_ITER   iterations per campaign (default small so the suite stays fast)
 *   STRESS_SEED   base seed (default 1)
 *   STRESS_ONLY   replay a single row: `<campaign>:<index>`
 *   STRESS_OUT    directory for the JSON result table (default apps/mobile/artifacts/stress)
 */

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  bool(): boolean {
    return this.next() < 0.5;
  }
}

export const STRESS_ITER_DEFAULT = 40;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : STRESS_ITER_DEFAULT;
}

export function stressBaseSeed(): number {
  const raw = process.env['STRESS_SEED'];
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 0 ? n : 1;
}

export function rowSeed(
  baseSeed: number,
  campaignIndex: number,
  iteration: number,
): number {
  return (
    (Math.imul(baseSeed + 1, 0x9e3779b1) ^
      Math.imul(campaignIndex + 1, 0x85ebca77) ^
      (iteration + 0x1000)) >>>
    0
  );
}

export type Outcome = 'held' | 'broken';

export interface StressRow {
  campaign: string;
  index: number;
  seed: number;
  category: string;
  payload: string;
  outcome: Outcome;
  violations: string[];
  note?: string;
}

/** Which rows of a campaign to run (all, or one replay index). */
export function iterationPlan(campaign: string): number[] {
  const only = process.env['STRESS_ONLY'];
  const total = stressIterations();
  if (!only) return Array.from({ length: total }, (_, i) => i);
  const [name, idx] = only.split(':');
  if (name !== campaign) return [];
  const i = Number(idx);
  return Number.isInteger(i) && i >= 0 ? [i] : [];
}

export function preview(value: unknown, max = 160): string {
  let text: string;
  try {
    text =
      typeof value === 'string'
        ? JSON.stringify(value)
        : (JSON.stringify(value, (_k, v) => {
            if (typeof v === 'bigint') return `<bigint ${v.toString()}>`;
            if (typeof v === 'symbol') return `<symbol ${v.description ?? ''}>`;
            if (typeof v === 'function') return '<function>';
            if (typeof v === 'number' && !Number.isFinite(v)) return `<${v}>`;
            if (typeof v === 'number' && Object.is(v, -0)) return '<-0>';
            if (v === undefined) return '<undefined>';
            return v;
          }) ?? String(value));
  } catch {
    // Hostile getters/proxies may throw from any reflective access,
    // including Object.prototype.toString; only `typeof` is safe.
    text = `<unserializable ${typeof value}>`;
  }
  return text.length > max
    ? `${text.slice(0, max)}…(+${text.length - max} chars)`
    : text;
}

export function writeTable(
  campaign: string,
  rows: readonly StressRow[],
): string {
  const dir =
    process.env['STRESS_OUT'] ??
    path.join(__dirname, '..', '..', 'artifacts', 'stress');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${campaign}.json`);
  const broken = rows.filter(r => r.outcome === 'broken');
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        campaign,
        baseSeed: stressBaseSeed(),
        iterationsRequested: stressIterations(),
        executed: rows.length,
        held: rows.length - broken.length,
        broken: broken.length,
        brokenSeeds: broken.map(r => ({
          index: r.index,
          seed: r.seed,
          category: r.category,
          violations: r.violations,
        })),
        replay: `STRESS_ONLY=${campaign}:<index> STRESS_SEED=${stressBaseSeed()} npx jest --ci __tests__/stress`,
        rows,
      },
      null,
      0,
    ),
  );
  return file;
}

export function violationSummary(rows: readonly StressRow[]): string {
  const broken = rows.filter(r => r.outcome === 'broken');
  if (broken.length === 0) return '';
  return broken
    .slice(0, 12)
    .map(
      r =>
        `${r.campaign}:${r.index} seed=${r.seed} [${r.category}] ${r.violations.join('; ')} payload=${r.payload}`,
    )
    .join('\n');
}

// ---------------------------------------------------------------------------
// Primitive generators

const PROTO_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const PREF_KEYS = [
  'version',
  'enabled',
  'practiceReminder',
  'practiceReminderMinutes',
  'streakDefense',
  'weeklyRecap',
  'comeback',
  'promptDismissed',
] as const;

/** NFC / NFD / compatibility pairs, zero-width, bidi, homoglyph, surrogates. */
const UNICODE_PAIRS: readonly [string, string][] = [
  ['é', 'e\u0301'],
  ['ﬁ', 'fi'],
  ['Ω', 'Ω'],
  ['Å', 'A\u030a'],
  ['ｅｎａｂｌｅｄ', 'enabled'],
  ['еnabled', 'enabled'], // Cyrillic е
  ['en\u200babled', 'enabled'],
  ['\u202eenabled', 'enabled'],
  ['한', '\u1112\u1161\u11ab'],
  ['👨‍👩‍👧‍👦', '👨👩👧👦'],
];

export function unicodeVariant(rng: Rng): string {
  const pair = rng.pick(UNICODE_PAIRS);
  return rng.bool() ? pair[0] : pair[1];
}

export function bigString(rng: Rng): string {
  const unit = rng.pick([
    'a', // 1 byte / 1 cp / 1 grapheme
    'é', // 2 bytes / 1 cp
    'e\u0301', // 3 bytes / 2 cp / 1 grapheme
    '😀', // 4 bytes / 1 cp / 2 UTF-16 units
    '👨‍👩‍👧‍👦', // 25 bytes / 7 cp / 1 grapheme
    '\u0000',
    '\uffff',
  ]);
  const len = rng.pick([65_536, 65_537, 70_000, 131_072, 262_144]);
  return unit.repeat(Math.ceil(len / unit.length));
}

export function weirdString(rng: Rng): string {
  const kind = rng.int(0, 15);
  switch (kind) {
    case 0:
      return '';
    case 1:
      return '\u0000';
    case 2:
      return `ps.\u0000${rng.int(0, 99)}`;
    case 3:
      return '../../../etc/passwd';
    case 4:
      return '..\\..\\Windows\\system32';
    case 5:
      return '%2e%2e%2f%2e%2e%2fkv';
    case 6:
      return `ps.reminder.practice/../${rng.pick(['streak', 'weekly'])}`;
    case 7:
      return '\ud800'; // lone high surrogate
    case 8:
      return '\udfff'; // lone low surrogate
    case 9:
      return unicodeVariant(rng);
    case 10:
      return bigString(rng);
    case 11:
      return ' '.repeat(rng.int(1, 64));
    case 12:
      return `\ufeff${rng.pick(['Home', 'Performance'])}`;
    case 13:
      return rng.pick(['home', 'HOME', 'Home ', ' Home', 'Performance\n']);
    case 14:
      return "'; DROP TABLE kv; --";
    default:
      return Array.from({ length: rng.int(1, 24) }, () =>
        String.fromCharCode(rng.int(0, 0xffff)),
      ).join('');
  }
}

export function weirdNumber(rng: Rng): number {
  return rng.pick([
    NaN,
    Infinity,
    -Infinity,
    -0,
    0,
    -1,
    1439,
    1440,
    1441,
    1439.5,
    0.5,
    -0.5,
    1e21,
    -1e21,
    1e308,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 2,
    Number.MIN_VALUE,
    Number.EPSILON,
    2 ** 31,
    -(2 ** 31),
    2 ** 53,
    8.64e15,
    8.64e15 + 1,
    -8.64e15,
    rng.int(-100_000, 100_000),
    rng.next() * 1440,
  ]);
}

export interface WeirdValueOptions {
  /** Include getter/proxy traps that throw on property access (hostile callers). */
  traps?: boolean;
}

/** A runtime (non-JSON) value of an unexpected type. */
export function weirdValue(
  rng: Rng,
  depth = 0,
  options: WeirdValueOptions = {},
): unknown {
  const traps = options.traps ?? true;
  const kind = rng.int(0, 21);
  switch (kind) {
    case 0:
      return undefined;
    case 1:
      return null;
    case 2:
      return weirdNumber(rng);
    case 3:
      return weirdString(rng);
    case 4:
      return rng.bool();
    case 5:
      return [];
    case 6:
      return {};
    case 7:
      return Object.create(null);
    case 8:
      return Symbol('x');
    case 9:
      return BigInt(rng.int(0, 1_000_000));
    case 10:
      return () => 'Home';
    case 11:
      return new Date(weirdNumber(rng));
    case 12:
      return new Map([['screen', 'Home']]);
    case 13:
      return new String('Home');
    case 14:
      return new Boolean(true);
    case 15:
      return new Number(NaN);
    case 16:
      return depth < 2
        ? Array.from({ length: rng.int(0, 4) }, () =>
            weirdValue(rng, depth + 1, options),
          )
        : [];
    case 17:
      return depth < 2 ? weirdObject(rng, depth + 1, options) : {};
    case 18: {
      if (!traps) return { screen: weirdString(rng) };
      const o: Record<string, unknown> = {};
      Object.defineProperty(o, 'screen', {
        get() {
          throw new Error('getter trap');
        },
        enumerable: true,
      });
      return o;
    }
    case 19:
      if (!traps) return { title: weirdString(rng), days: weirdNumber(rng) };
      return new Proxy(
        {},
        {
          get() {
            throw new Error('proxy trap');
          },
        },
      );
    case 20:
      return Object.freeze({ screen: 'Home' });
    default:
      return new Uint8Array([0, 255]);
  }
}

export function weirdKey(rng: Rng): string {
  const kind = rng.int(0, 5);
  if (kind === 0) return rng.pick(PROTO_KEYS);
  if (kind === 1) return rng.pick(PREF_KEYS);
  if (kind === 2) return unicodeVariant(rng);
  if (kind === 3) return 'screen';
  if (kind === 4) return weirdString(rng).slice(0, 64);
  return `k${rng.int(0, 9)}`;
}

export function weirdObject(
  rng: Rng,
  depth = 0,
  options: WeirdValueOptions = {},
): Record<string, unknown> {
  const o: Record<string, unknown> = rng.chance(0.15)
    ? Object.create(null)
    : {};
  const n = rng.int(0, 6);
  for (let i = 0; i < n; i += 1) {
    const key = weirdKey(rng);
    const value = weirdValue(rng, depth + 1, options);
    if (key === '__proto__') {
      Object.defineProperty(o, key, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    } else {
      o[key] = value;
    }
  }
  return o;
}

// ---------------------------------------------------------------------------
// Prefs (stored JSON text) generators

function validPrefsObject(rng: Rng): Record<string, unknown> {
  return {
    version: 1,
    enabled: rng.bool(),
    practiceReminder: rng.bool(),
    practiceReminderMinutes: rng.int(0, 1439),
    streakDefense: rng.bool(),
    weeklyRecap: rng.bool(),
    comeback: rng.bool(),
    promptDismissed: rng.bool(),
  };
}

export function validPrefsJson(rng: Rng): string {
  return JSON.stringify(validPrefsObject(rng));
}

/** JSON-representable weird value (JSON.parse must be able to produce it). */
function jsonWeirdValue(rng: Rng, depth = 0): unknown {
  const kind = rng.int(0, 12);
  switch (kind) {
    case 0:
      return null;
    case 1:
      return rng.bool();
    case 2:
      return rng.pick([
        -0,
        0,
        -1,
        1439,
        1440,
        1441,
        1439.5,
        1e21,
        1e308,
        2 ** 53,
        -(2 ** 53),
      ]);
    case 3:
      return weirdString(rng);
    case 4:
      return [];
    case 5:
      return {};
    case 6:
      return rng.pick(['true', 'false', '1', '0', 'yes', 'null', 'NaN']);
    case 7:
      return depth < 3 ? [jsonWeirdValue(rng, depth + 1)] : [];
    case 8:
      return depth < 3 ? { nested: jsonWeirdValue(rng, depth + 1) } : {};
    case 9:
      return rng.int(-1_000_000, 1_000_000);
    case 10:
      return unicodeVariant(rng);
    default:
      return rng.next();
  }
}

export interface MalformedText {
  category: string;
  text: string;
}

export function malformedPrefsJson(rng: Rng): MalformedText {
  const kind = rng.int(0, 21);
  switch (kind) {
    case 0: {
      const full = validPrefsJson(rng);
      return {
        category: 'truncated',
        text: full.slice(0, rng.int(0, full.length - 1)),
      };
    }
    case 1:
      return {
        category: 'garbage-bytes',
        text: Array.from({ length: rng.int(0, 48) }, () =>
          String.fromCharCode(rng.int(0, 255)),
        ).join(''),
      };
    case 2:
      return {
        category: 'wrong-root-type',
        text: rng.pick([
          'null',
          'true',
          'false',
          '1',
          '"x"',
          '[]',
          '[{}]',
          '""',
        ]),
      };
    case 3: {
      const o = validPrefsObject(rng);
      const key = rng.pick(PREF_KEYS);
      o[key] = jsonWeirdValue(rng);
      return { category: `wrong-type:${key}`, text: JSON.stringify(o) };
    }
    case 4: {
      const o = validPrefsObject(rng);
      const key = rng.pick(PROTO_KEYS);
      const injected = rng.pick([
        '{"polluted":true}',
        '{"enabled":true}',
        '{"practiceReminderMinutes":99999}',
        'null',
        '[]',
      ]);
      const text = JSON.stringify(o).replace(
        /^\{/,
        `{${JSON.stringify(key)}:${injected},`,
      );
      return { category: `proto-key:${key}`, text };
    }
    case 5: {
      const o = validPrefsObject(rng);
      const literal = rng.pick([
        '1e309',
        '-1e309',
        '-0',
        '1439.0000000001',
        '1440',
        '-1',
        '9007199254740993',
        '1e21',
        '0.1e1',
        '1E3',
        '00',
        '.5',
        '+1',
        '0x10',
        'NaN',
        'Infinity',
      ]);
      const text = JSON.stringify(o).replace(
        /"practiceReminderMinutes":\d+/,
        `"practiceReminderMinutes":${literal}`,
      );
      return { category: `numeric-literal:${literal}`, text };
    }
    case 6: {
      const o = validPrefsObject(rng);
      (o as Record<string, unknown>)['note'] = `x\u0000y${rng.int(0, 9)}`;
      const text = rng.bool()
        ? JSON.stringify(o)
        : `${JSON.stringify(o).slice(0, -1)},"z":"\u0000"}`;
      return { category: 'null-byte', text };
    }
    case 7: {
      const o = validPrefsObject(rng);
      (o as Record<string, unknown>)[rng.pick(['pad', 'enabled', 'version'])] =
        bigString(rng);
      return { category: 'huge-string', text: JSON.stringify(o) };
    }
    case 8: {
      const o = validPrefsObject(rng);
      o['version'] = rng.pick([
        2,
        3,
        99,
        1.5,
        0,
        -1,
        '1',
        '2',
        null,
        true,
        [1],
        { major: 2 },
        Number.POSITIVE_INFINITY,
      ]);
      return { category: 'schema-version', text: JSON.stringify(o) };
    }
    case 9:
      return {
        category: 'empty-container',
        text: rng.pick(['{}', '[]', ' {} ']),
      };
    case 10: {
      const o = validPrefsObject(rng);
      const [a, b] = rng.pick(UNICODE_PAIRS);
      (o as Record<string, unknown>)[a] = true;
      (o as Record<string, unknown>)[b] = false;
      return {
        category: 'unicode-normalization-keys',
        text: JSON.stringify(o),
      };
    }
    case 11: {
      const o = validPrefsObject(rng);
      const text = JSON.stringify(o).replace(
        /^\{/,
        `{"enabled":${rng.pick(['"yes"', '1', 'null', '[]'])},`,
      );
      return { category: 'duplicate-key-last-wins', text };
    }
    case 12:
      return {
        category: 'bom-or-whitespace',
        text: rng.pick([
          `\ufeff${validPrefsJson(rng)}`,
          `  \n\t${validPrefsJson(rng)}\n`,
          '\ufeff',
          '\n',
          '   ',
        ]),
      };
    case 13:
      return {
        category: 'non-strict-json',
        text: rng.pick([
          "{'enabled':true}",
          '{enabled:true}',
          '{"enabled":true,}',
          '{"enabled":true}//c',
          '{"enabled":True}',
          '{"enabled":undefined}',
          '{"practiceReminderMinutes":0x10}',
          '{"a":1}{"b":2}',
          'undefined',
        ]),
      };
    case 14: {
      const depth = rng.pick([64, 512, 4096, 20_000]);
      return {
        category: `deep-nesting:${depth}`,
        text: `${'['.repeat(depth)}${']'.repeat(depth)}`,
      };
    }
    case 15: {
      const depth = rng.pick([64, 512, 4096]);
      return {
        category: `deep-object:${depth}`,
        text: `${'{"enabled":'.repeat(depth)}true${'}'.repeat(depth)}`,
      };
    }
    case 16:
      return {
        category: 'many-keys',
        text: `{${Array.from(
          { length: rng.pick([1000, 10_000]) },
          (_, i) => `"k${i}":${i}`,
        ).join(',')},"enabled":true}`,
      };
    case 17: {
      const o = validPrefsObject(rng);
      const text = JSON.stringify({ ...o, enabled: '\ud800' }).replace(
        '"\\ud800"',
        rng.pick([
          '"\\ud800"',
          '"\\udfff"',
          '"\\u0000"',
          '"\\uZZZZ"',
          '"\\x00"',
        ]),
      );
      return { category: 'escape-sequences', text };
    }
    case 18: {
      const o = validPrefsObject(rng);
      const text = JSON.stringify(o).replace(
        /"enabled":(true|false)/,
        `"enabled":${rng.pick(['"true"', '"false"', '1', '0', '"TRUE"'])}`,
      );
      return { category: 'stringly-boolean', text };
    }
    case 19: {
      const o = validPrefsObject(rng);
      for (const k of PREF_KEYS) {
        if (rng.chance(0.5)) delete o[k];
      }
      return { category: 'missing-keys', text: JSON.stringify(o) };
    }
    case 20:
      return {
        category: 'path-traversal-values',
        text: JSON.stringify({
          ...validPrefsObject(rng),
          owner: '../../signed-out',
          id: 'ps.reminder.practice/../../x',
        }),
      };
    default: {
      const o = weirdObject(rng);
      let text: string;
      try {
        text = JSON.stringify(o, (_k, v) =>
          typeof v === 'bigint' || typeof v === 'symbol' ? String(v) : v,
        );
      } catch {
        text = '{"cyclic":true}';
      }
      return { category: 'random-object', text: text ?? 'undefined' };
    }
  }
}

// ---------------------------------------------------------------------------
// Owner keys, patches, plan contexts, notification data

export function weirdOwnerKey(rng: Rng): string {
  return rng.pick([
    '',
    ' ',
    '\u0000',
    'signed-out',
    'SIGNED-OUT',
    'device-guest ',
    'device-guest/../x',
    '../signed-out',
    '00000000-0000-0000-0000-000000000000',
    '00000000-0000-0000-0000-00000000000', // 35 chars
    '00000000-0000-0000-0000-0000000000000', // 37 chars
    '00000000-0000-0000-0000-00000000000G',
    'ABCDEFAB-0000-4000-8000-000000000001',
    'abcdefab-0000-4000-8000-000000000001\u0000',
    weirdString(rng),
    bigString(rng).slice(0, 65_536),
  ]);
}

export function weirdPrefsPatch(rng: Rng): Record<string, unknown> {
  const kind = rng.int(0, 6);
  const patch: Record<string, unknown> = {};
  if (kind === 0) {
    patch[rng.pick(PREF_KEYS)] = weirdValue(rng, 0, { traps: false });
  } else if (kind === 1) {
    patch['practiceReminderMinutes'] = weirdNumber(rng);
  } else if (kind === 2) {
    patch['version'] = rng.pick([2, 0, -1, '1', null, NaN]);
  } else if (kind === 3) {
    const key = rng.pick(PROTO_KEYS);
    Object.defineProperty(patch, key, {
      value: { enabled: true, polluted: true },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  } else if (kind === 4) {
    patch[weirdKey(rng)] = weirdValue(rng, 0, { traps: false });
  } else if (kind === 5) {
    return weirdObject(rng, 0, { traps: false });
  } else {
    patch['enabled'] = rng.pick(['yes', 1, 0, null, [], {}, 'false']);
  }
  return patch;
}

export interface WeirdContextResult {
  category: string;
  context: Record<string, unknown>;
}

const REALISTIC_NOW_MIN = Date.UTC(2024, 0, 1);
const REALISTIC_NOW_MAX = Date.UTC(2037, 11, 31);

export function realisticNow(rng: Rng): number {
  return REALISTIC_NOW_MIN + rng.int(0, REALISTIC_NOW_MAX - REALISTIC_NOW_MIN);
}

export function validContext(rng: Rng): Record<string, unknown> {
  return {
    nowMs: realisticNow(rng),
    streakDays: rng.int(0, 400),
    practicedToday: rng.bool(),
    hasAnyHistory: rng.bool(),
    shieldsAvailable: rng.int(0, 5),
    milestoneEve: rng.chance(0.4)
      ? { title: `Day ${rng.int(1, 999)}`, days: rng.int(1, 999) }
      : null,
  };
}

export function weirdContext(rng: Rng): WeirdContextResult {
  const ctx = validContext(rng);
  const kind = rng.int(0, 7);
  switch (kind) {
    case 0:
      ctx['nowMs'] = weirdNumber(rng);
      return { category: 'nowMs:non-realistic', context: ctx };
    case 1:
      ctx['nowMs'] = weirdValue(rng, 0, { traps: false });
      return { category: 'nowMs:wrong-type', context: ctx };
    case 2:
      ctx['streakDays'] = weirdNumber(rng);
      return { category: 'streakDays:weird', context: ctx };
    case 3:
      ctx['milestoneEve'] = weirdValue(rng, 0, { traps: false });
      return { category: 'milestoneEve:wrong-type', context: ctx };
    case 4:
      ctx['milestoneEve'] = { title: weirdString(rng), days: weirdNumber(rng) };
      return { category: 'milestoneEve:weird-fields', context: ctx };
    case 5:
      ctx['practicedToday'] = weirdValue(rng, 0, { traps: false });
      ctx['hasAnyHistory'] = weirdValue(rng, 0, { traps: false });
      return { category: 'flags:wrong-type', context: ctx };
    case 6:
      return {
        category: 'context:random-object',
        context: weirdObject(rng, 0, { traps: false }),
      };
    default:
      ctx['shieldsAvailable'] = weirdNumber(rng);
      return { category: 'shields:weird', context: ctx };
  }
}

export function weirdNotificationData(rng: Rng): {
  category: string;
  data: unknown;
} {
  const kind = rng.int(0, 9);
  switch (kind) {
    case 0:
      return { category: 'primitive', data: weirdValue(rng) };
    case 1:
      return {
        category: 'screen:weird-string',
        data: { screen: weirdString(rng) },
      };
    case 2:
      return {
        category: 'screen:wrong-type',
        data: { screen: weirdValue(rng) },
      };
    case 3:
      return {
        category: 'screen:boxed',
        data: { screen: new String(rng.pick(['Home', 'Performance'])) },
      };
    case 4:
      return {
        category: 'screen:inherited',
        data: Object.create({ screen: rng.pick(['Home', 'Performance']) }),
      };
    case 5: {
      const o: Record<string, unknown> = {};
      const target = rng.pick(['Home', 'Performance']);
      Object.defineProperty(o, 'screen', {
        get: () => target,
        enumerable: false,
      });
      return { category: 'screen:getter', data: o };
    }
    case 6:
      return {
        category: 'screen:key-variant',
        data: {
          [rng.pick(['Screen', 'SCREEN', 'screen ', 'ｓｃｒｅｅｎ', 'scrеen'])]:
            'Home',
        },
      };
    case 7:
      return {
        category: 'screen:valid',
        data: {
          screen: rng.pick(['Home', 'Performance']),
          extra: weirdValue(rng),
        },
      };
    case 8:
      return { category: 'random-object', data: weirdObject(rng) };
    default:
      return { category: 'array', data: ['Home', { screen: 'Home' }] };
  }
}

export function weirdAppState(rng: Rng): unknown {
  return rng.pick<unknown>([
    'active',
    'active',
    'background',
    'inactive',
    'extension',
    'unknown',
    'ACTIVE',
    'active ',
    ' active',
    'аctive', // Cyrillic а
    '',
    null,
    undefined,
    42,
    {},
    [],
    { state: 'active' },
  ]);
}

export function weirdTriggerId(rng: Rng): string {
  return rng.pick([
    'ps',
    'ps.',
    'PS.reminder.practice',
    ' ps.reminder.practice',
    'ps．reminder.practice', // fullwidth dot
    'xps.reminder.practice',
    'other.ps.reminder',
    'ps.reminder.practice\u0000',
    'ps.\u0000',
    'ps.reminder.practice/../streak',
    '../ps.reminder.practice',
    'ps.comeback.1',
    'ps.reminder.weekly',
    'ps.unknown.future.id',
    weirdString(rng).slice(0, 128),
  ]);
}
