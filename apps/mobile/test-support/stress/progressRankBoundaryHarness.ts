/**
 * BOUNDARY / MALFORMED-INPUT stress harness for the progress + rank module
 * (`src/progress/playerRank.ts`, `rankCelebration.ts`, `gameplayProgression.ts`,
 * `duprEstimate.ts`, `techniqueDashboard.ts`).
 *
 * Pure, deterministic and replayable: every scenario is a function of
 * `(seed, module)` through a mulberry32 stream, so any row of the results
 * table can be re-run with `STRESS_ONLY=<seed>` (see the driver test in
 * `__tests__/stress/progressRankBoundaryMalformed.stress.test.ts`).
 *
 * Two classes of checks are recorded per scenario:
 *   - HARD invariants  → `violations`. The suite fails on any of these:
 *       never an untyped throw out of a parser/builder, never a prototype
 *       write, never a non-finite number where the type says `number`,
 *       structural consistency of every output (counts match arrays, sorted
 *       order, bounded bucket count, …), and the exact independent oracle
 *       for which live-session summaries may become progression.
 *   - SPEC probes      → `specNotes`. Documented contract deviations that do
 *       not crash anything but contradict a doc comment / product intent
 *       (e.g. `scoredShotCount: null` coerced to 0). They are counted and
 *       surfaced in the JSON table, and each one is pinned by a `test.failing`
 *       block in the driver so a fix flips the pin instead of hiding it.
 */
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import type { ApiSession } from '../../src/account/apiSession';
import type {
  LiveSessionHistoryRow,
  RealAnalysisFact,
} from '../../src/data/repository';
import {
  duprEstimate,
  formatDuprEstimate,
} from '../../src/progress/duprEstimate';
import {
  buildGameplayProgression,
  sessionDayLabel,
} from '../../src/progress/gameplayProgression';
import {
  fetchPlayerRank,
  parsePlayerRank,
  PlayerRankApiError,
  rankFromFacts,
  resolvePlayerRank,
  summaryFromServer,
  type PlayerRankFactLike,
  type PlayerRankFetch,
  type ServerPlayerRank,
} from '../../src/progress/playerRank';
import {
  evaluateRankTransition,
  rankCelebrationKeyForOwner,
  tierIndex,
} from '../../src/progress/rankCelebration';
import {
  buildTechniqueDashboard,
  formatSignedDelta,
  vsPriorLabel,
  type TechniqueDashboardOptions,
} from '../../src/progress/techniqueDashboard';
import type { PracticeHistoryRangeKey } from '../../src/progress/practiceHistory';

// ─────────────────────────────────────────────────────────────────────────────
// Seeded RNG (same generator the existing stress suites use).
// ─────────────────────────────────────────────────────────────────────────────

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

function int(rng: Rng, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Adversarial value pools. Everything here is JSON-representable or a value
// the mobile runtime can genuinely hand these functions (undefined = absent
// key; NaN / ±Infinity / -0 = arithmetic on corrupt rows).
// ─────────────────────────────────────────────────────────────────────────────

const KB64 = 'A'.repeat(65_536);
const CODEPOINTS_30K = 'é'.repeat(30_000); // 60 KB UTF-8, 30 000 code points
const GRAPHEMES_4K = '👨‍👩‍👧‍👦'.repeat(4_000); // 4 000 graphemes, 44 000 UTF-16 units
const BIDI_20K = '﷽'.repeat(20_000);
export const NFC_E_ACUTE = '\u00e9';
export const NFD_E_ACUTE = 'e\u0301';

const WEIRD_NUMBERS: readonly unknown[] = [
  0,
  -0,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e308,
  -1e308,
  Number.MAX_VALUE,
  Number.MIN_VALUE,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_SAFE_INTEGER + 1,
  2 ** 53,
  -(2 ** 53),
  1e21,
  10,
  10.000000001,
  9.999999999,
  -1e-9,
  0.1 + 0.2,
  7.25,
  '7',
  '7.5',
  '',
  ' ',
  '1e3',
  '0x1A',
  'Infinity',
  '-Infinity',
  'NaN',
  '-0',
  '1_000',
  null,
  undefined,
  true,
  false,
  [],
  [5],
  [1, 2],
  {},
  { value: 5 },
];

const WEIRD_STRINGS: readonly unknown[] = [
  '',
  ' ',
  '\t\n',
  'dink',
  'forehand_drive',
  'Dink',
  '\u0000',
  'a\u0000b',
  'dink\u0000',
  KB64,
  CODEPOINTS_30K,
  GRAPHEMES_4K,
  BIDI_20K,
  '../../etc/passwd',
  '..\\..\\windows\\system32',
  '/etc/passwd%00.json',
  '....//....//',
  'dink/../serve',
  NFC_E_ACUTE,
  NFD_E_ACUTE,
  '\uFEFF',
  '\uD800', // lone surrogate
  '<script>alert(1)</script>',
  '${jndi:ldap://x}',
  "'; DROP TABLE kv; --",
  'null',
  'undefined',
  'NaN',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
  '{"a":1',
  '[object Object]',
  123,
  0,
  null,
  undefined,
  true,
  [],
  ['dink'],
  {},
  { shotType: 'dink' },
];

const WEIRD_ISO: readonly unknown[] = [
  '2026-08-01T10:00:00.000Z',
  '2026-08-01T10:00:00Z',
  '2026-08-01T10:00:00',
  '2026-08-01',
  '2026-08-01 10:00',
  '+275760-09-13T00:00:00.000Z', // max representable instant
  '+275760-09-13T00:00:00.001Z', // one ms past → invalid date
  '-271821-04-20T00:00:00.000Z', // min representable instant
  '-271821-04-19T23:59:59.999Z', // one ms before → invalid date
  '0000-01-01T00:00:00.000Z',
  '1970-01-01T00:00:00.000Z',
  '1969-12-31T23:59:59.999Z',
  '2026-02-30T00:00:00.000Z',
  '2026-13-01T00:00:00.000Z',
  '2026-08-01T25:00:00.000Z',
  '2026-08-01T10:00:00.000+99:00',
  '2026-08-01T10:00:00.000-00:00',
  '2026-08-01T10:00:00.000Z\u0000',
  'not a date',
  '',
  ' ',
  '1e12',
  '1756720000000',
  'Infinity',
  'NaN',
  'Tue Aug 01 2026',
  '2026-08-01T10:00:00.000Z'.repeat(2000),
  12345,
  0,
  -1,
  Number.NaN,
  null,
  undefined,
  true,
  {},
  [],
];

const POLLUTION_KEYS = ['__proto__', 'constructor', 'prototype'] as const;

const VALID_SHOTS = [
  'dink',
  'serve',
  'forehand_drive',
  'backhand_drive',
  'overhead',
  'third_shot_drop',
  'volley',
  'lob',
] as const;

const VALID_TIERS = PLAYER_RANK_TIERS.map(tier => tier.key);

const VALID_TIMEZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Pacific/Kiritimati',
  'Pacific/Chatham',
  'Etc/GMT+12',
  'Australia/Lord_Howe',
] as const;

const INVALID_TIMEZONES = [
  'Not/AZone',
  '',
  ' ',
  '../../etc/localtime',
  'UTC\u0000',
  'America/Los Angeles',
  KB64,
  'GMT+99',
  '12345',
] as const;

const VALID_RANGES: readonly PracticeHistoryRangeKey[] = ['7d', '28d', '90d'];
const INVALID_RANGES: readonly unknown[] = [
  '',
  '7D',
  '7 d',
  '1d',
  '365d',
  'all',
  '__proto__',
  KB64,
  7,
  null,
  undefined,
  [],
  {},
];

function validIso(rng: Rng): string {
  // 2020-01-01 … 2030-12-31, millisecond precision.
  const start = Date.UTC(2020, 0, 1);
  const end = Date.UTC(2030, 11, 31, 23, 59, 59, 999);
  return new Date(start + Math.floor(rng() * (end - start))).toISOString();
}

function validScore(rng: Rng): number {
  // One-decimal 0–10 scores, the domain contract, plus exact boundaries.
  const roll = rng();
  if (roll < 0.05) return 0;
  if (roll < 0.1) return 10;
  return Math.round(rng() * 100) / 10;
}

function weirdNumber(rng: Rng): unknown {
  return pick(rng, WEIRD_NUMBERS);
}

function weirdString(rng: Rng): unknown {
  return pick(rng, WEIRD_STRINGS);
}

function weirdIso(rng: Rng): unknown {
  return pick(rng, WEIRD_ISO);
}

/** Injects prototype-pollution keys into a record (own properties, as
 * `JSON.parse('{"__proto__":…}')` produces them). */
function pollute(rng: Rng, target: Record<string, unknown>): void {
  const key = pick(rng, POLLUTION_KEYS);
  Object.defineProperty(target, key, {
    value: { polluted: true, rating: 9.99, tier: 'diamond' },
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Short, JSON-safe description of an input for the results table. */
export function describeInput(value: unknown, max = 240): string {
  let text: string;
  try {
    text = JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === 'number' && !Number.isFinite(item))
        return `<${String(item)}>`;
      if (typeof item === 'number' && Object.is(item, -0)) return '<-0>';
      if (item === undefined) return '<undefined>';
      if (typeof item === 'string' && item.length > 48) {
        return `<string len=${item.length} head=${JSON.stringify(item.slice(0, 12))}>`;
      }
      return item;
    });
  } catch {
    text = String(value);
  }
  if (text === undefined) text = '<undefined>';
  return text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prototype-pollution sentinel: a fresh object must never gain properties as
// a side effect of any scenario.
// ─────────────────────────────────────────────────────────────────────────────

const OBJECT_PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype)
  .sort()
  .join(',');
const ARRAY_PROTO_KEYS = Object.getOwnPropertyNames(Array.prototype)
  .sort()
  .join(',');

export function prototypeIntegrityViolations(): string[] {
  const violations: string[] = [];
  const probe: Record<string, unknown> = {};
  if ('polluted' in probe || 'rating' in probe || 'tier' in probe) {
    violations.push('prototype-pollution: fresh object gained injected keys');
  }
  if (
    Object.getOwnPropertyNames(Object.prototype).sort().join(',') !==
    OBJECT_PROTO_KEYS
  ) {
    violations.push('prototype-pollution: Object.prototype own keys changed');
  }
  if (
    Object.getOwnPropertyNames(Array.prototype).sort().join(',') !==
    ARRAY_PROTO_KEYS
  ) {
    violations.push('prototype-pollution: Array.prototype own keys changed');
  }
  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Results model
// ─────────────────────────────────────────────────────────────────────────────

export const STRESS_MODULES = [
  'parsePlayerRank',
  'fetchPlayerRank',
  'rankResolve',
  'gameplayProgression',
  'techniqueDashboard',
  'scalars',
] as const;
export type StressModule = (typeof STRESS_MODULES)[number];

export type Outcome = 'HELD' | 'REJECTED_TYPED' | 'BROKEN';

export interface ScenarioResult {
  seed: number;
  module: StressModule;
  /** Generator family (what kind of input this seed produced). */
  family: string;
  /** HELD = accepted and every hard invariant held; REJECTED_TYPED = the
   * documented typed error was thrown (a graceful rejection); BROKEN = a hard
   * invariant failed (an untyped throw, a non-finite output, …). */
  outcome: Outcome;
  violations: string[];
  /** Documented spec deviations that are not crashes (see file header). */
  specNotes: string[];
  input: string;
  ms: number;
}

interface Probe {
  violations: string[];
  specNotes: string[];
  family: string;
  input: unknown;
  typedRejection: boolean;
}

function errorKind(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return `non-Error throw: ${describeInput(error, 80)}`;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 1 — parsePlayerRank: the network boundary.
// ─────────────────────────────────────────────────────────────────────────────

type Transport = 'object' | 'json' | 'text';

function validTechniqueRow(rng: Rng): Record<string, unknown> {
  return {
    shot_type: pick(rng, VALID_SHOTS),
    score: validScore(rng),
    captured_at: validIso(rng),
    ...(chance(rng, 0.5) ? { sampled_count: int(rng, 1, 8) } : {}),
  };
}

function validRankPayload(rng: Rng): Record<string, unknown> {
  const techniques = Array.from({ length: int(rng, 1, 5) }, () =>
    validTechniqueRow(rng),
  );
  return {
    rank: {
      rating: Math.round(rng() * 1000) / 100,
      tier: pick(rng, VALID_TIERS),
      techniqueCount: techniques.length,
      scoredShotCount: chance(rng, 0.2)
        ? null
        : int(rng, techniques.length, 500),
      updatedAt: chance(rng, 0.2) ? null : validIso(rng),
      techniques,
    },
  };
}

/** Generates the payload `response.json()` would resolve to. */
export function generateRankPayload(rng: Rng): {
  payload: unknown;
  family: string;
} {
  const roll = rng();
  if (roll < 0.08) {
    // Non-object roots.
    const root = pick(rng, [
      null,
      undefined,
      1,
      'rank',
      '',
      true,
      [],
      [{ rank: {} }],
      KB64,
      Number.NaN,
    ]);
    return { payload: root, family: 'root:non-object' };
  }
  if (roll < 0.14) {
    // Missing / wrong-typed `rank`.
    const rank = pick(rng, [undefined, 1, 'ranked', [], [{}], true, '', KB64]);
    const payload: Record<string, unknown> =
      rank === undefined ? { ranks: {} } : { rank };
    if (chance(rng, 0.3)) pollute(rng, payload);
    return { payload, family: 'rank:wrong-type' };
  }
  if (roll < 0.18) return { payload: { rank: null }, family: 'rank:null' };
  // Start from a valid payload and mutate.
  const payload = validRankPayload(rng);
  const rank = payload['rank'] as Record<string, unknown>;
  const mutations: string[] = [];
  const mutationCount = roll < 0.3 ? 0 : int(rng, 1, 3);
  for (let index = 0; index < mutationCount; index += 1) {
    const which = int(rng, 0, 9);
    switch (which) {
      case 0:
        rank['rating'] = weirdNumber(rng);
        mutations.push('rating');
        break;
      case 1:
        rank['tier'] = weirdString(rng);
        mutations.push('tier');
        break;
      case 2:
        rank['techniqueCount'] = weirdNumber(rng);
        mutations.push('techniqueCount');
        break;
      case 3:
        rank['scoredShotCount'] = weirdNumber(rng);
        mutations.push('scoredShotCount');
        break;
      case 4:
        rank['updatedAt'] = weirdIso(rng);
        mutations.push('updatedAt');
        break;
      case 5: {
        // Mutations stack, so `techniques` may already be a non-array and a
        // row may already be a primitive; only mutate a real record.
        const techniques = rank['techniques'];
        const row =
          Array.isArray(techniques) && techniques.length > 0
            ? (techniques[int(rng, 0, techniques.length - 1)] as unknown)
            : null;
        if (row !== null && typeof row === 'object') {
          const record = row as Record<string, unknown>;
          const field = pick(rng, [
            'shot_type',
            'score',
            'captured_at',
            'sampled_count',
          ] as const);
          record[field] =
            field === 'shot_type'
              ? weirdString(rng)
              : field === 'captured_at'
                ? weirdIso(rng)
                : weirdNumber(rng);
          mutations.push(`technique.${field}`);
        }
        break;
      }
      case 6:
        rank['techniques'] = pick(rng, [
          [],
          {},
          null,
          'techniques',
          [null],
          [1],
          ['dink'],
          [[]],
          [{}],
          Array.from({ length: 5000 }, () => validTechniqueRow(rng)),
          [validTechniqueRow(rng), Object.create(null)],
        ]);
        mutations.push('techniques');
        break;
      case 7:
        pollute(rng, rank);
        mutations.push('pollute:rank');
        break;
      case 8: {
        const techniques = rank['techniques'];
        const first = Array.isArray(techniques)
          ? (techniques[0] as unknown)
          : null;
        if (first !== null && typeof first === 'object')
          pollute(rng, first as Record<string, unknown>);
        mutations.push('pollute:technique');
        break;
      }
      default:
        rank['rating'] = pick(rng, [-0.01, 10.01, -0, 10, 0, 1e-320, 9.995]);
        mutations.push('rating:edge');
    }
  }
  return {
    payload,
    family: mutations.length === 0 ? 'valid' : `mutate:${mutations.join('+')}`,
  };
}

/** Applies a transport model: raw JS object, JSON round-trip, or a JSON text
 * that is truncated / byte-flipped and then parsed like `response.json()`
 * (parse failure → null, exactly as fetchPlayerRank's `.catch(() => null)`). */
function applyTransport(
  rng: Rng,
  payload: unknown,
  transport: Transport,
): unknown {
  if (transport === 'object') return payload;
  let text: string;
  try {
    text = JSON.stringify(payload) ?? 'undefined';
  } catch {
    return payload;
  }
  if (transport === 'text') {
    const roll = rng();
    if (roll < 0.5) {
      text = text.slice(0, int(rng, 0, Math.max(0, text.length - 1)));
    } else if (roll < 0.8) {
      const at = int(rng, 0, Math.max(0, text.length - 1));
      const glyph = pick(rng, [
        '\u0000',
        '"',
        '{',
        ']',
        ',',
        'é',
        '\uD800',
        ' ',
        '9',
      ]);
      text = `${text.slice(0, at)}${glyph}${text.slice(at + 1)}`;
    } else {
      text = `${text}${pick(rng, ['}', ']', ',', 'null', '\u0000', KB64])}`;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function checkServerRankShape(
  rank: ServerPlayerRank,
  violations: string[],
  specNotes: string[],
): void {
  if (!isFiniteNumber(rank.rating) || rank.rating < 0 || rank.rating > 10) {
    violations.push(`accepted rating out of contract: ${String(rank.rating)}`);
  }
  if (typeof rank.tier !== 'string')
    violations.push('accepted non-string tier');
  if (!isFiniteNumber(rank.techniqueCount))
    violations.push('accepted non-finite techniqueCount');
  if (rank.scoredShotCount !== null && !isFiniteNumber(rank.scoredShotCount)) {
    violations.push('accepted non-finite scoredShotCount');
  }
  if (rank.updatedAt !== null && typeof rank.updatedAt !== 'string') {
    violations.push('accepted non-string updatedAt');
  }
  if (!Array.isArray(rank.techniques)) {
    violations.push('techniques is not an array');
    return;
  }
  for (const technique of rank.techniques) {
    if (typeof technique.shotType !== 'string')
      violations.push('technique.shotType not a string');
    if (!isFiniteNumber(technique.score))
      violations.push('technique.score not finite');
    if (typeof technique.capturedAt !== 'string')
      violations.push('technique.capturedAt not a string');
    if (
      technique.sampledCount !== undefined &&
      !isFiniteNumber(technique.sampledCount)
    ) {
      violations.push('technique.sampledCount not finite');
    }
    if (
      isFiniteNumber(technique.score) &&
      (technique.score < 0 || technique.score > 10)
    ) {
      specNotes.push(
        `S3:technique.score outside 0–10 accepted (${technique.score})`,
      );
    }
  }
  if (
    isFiniteNumber(rank.techniqueCount) &&
    (rank.techniqueCount < 0 || !Number.isInteger(rank.techniqueCount))
  ) {
    specNotes.push(
      `S3:techniqueCount not a non-negative integer (${rank.techniqueCount})`,
    );
  }
}

function checkSummaryShape(
  summary: PlayerRankSummary,
  violations: string[],
  label: string,
): void {
  if (!isFiniteNumber(summary.rating))
    violations.push(`${label}: rating not finite`);
  if (tierIndex(summary.tier) < 0)
    violations.push(`${label}: tier not a known tier key`);
  if (typeof summary.tierLabel !== 'string' || summary.tierLabel === '') {
    violations.push(`${label}: empty tierLabel`);
  }
  if (typeof summary.divisionLabel !== 'string')
    violations.push(`${label}: divisionLabel not a string`);
  if (!isFiniteNumber(summary.techniqueCount))
    violations.push(`${label}: techniqueCount not finite`);
  if (!isFiniteNumber(summary.scoredAnalysisCount)) {
    violations.push(`${label}: scoredAnalysisCount not finite`);
  }
  if (!Array.isArray(summary.techniques)) {
    violations.push(`${label}: techniques not an array`);
  } else {
    for (let index = 1; index < summary.techniques.length; index += 1) {
      const previous = summary.techniques[index - 1]!;
      const current = summary.techniques[index]!;
      if (
        previous.score < current.score ||
        (previous.score === current.score &&
          previous.shotType.localeCompare(current.shotType) > 0)
      ) {
        violations.push(
          `${label}: techniques not sorted score desc / shotType asc`,
        );
        break;
      }
    }
  }
  if (summary.nextTier !== null) {
    if (!isFiniteNumber(summary.nextTier.pointsNeeded)) {
      violations.push(`${label}: nextTier.pointsNeeded not finite`);
    }
    if (!isFiniteNumber(summary.nextTier.minRating)) {
      violations.push(`${label}: nextTier.minRating not finite`);
    }
  }
}

function probeParsePlayerRank(rng: Rng): Probe {
  const { payload: generated, family } = generateRankPayload(rng);
  const transport = pick(rng, ['object', 'json', 'json', 'text'] as const);
  const payload = applyTransport(rng, generated, transport);
  const violations: string[] = [];
  const specNotes: string[] = [];
  let typedRejection = false;
  const rawRank =
    payload !== null && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)['rank']
      : undefined;
  try {
    const parsed = parsePlayerRank(payload);
    if (parsed !== null) {
      checkServerRankShape(parsed, violations, specNotes);
      // Downstream consumers must accept anything the parser accepts.
      try {
        const summary = summaryFromServer(parsed);
        checkSummaryShape(summary, violations, 'summaryFromServer');
        const resolved = resolvePlayerRank([], parsed);
        if (!resolved || resolved.source !== 'account') {
          violations.push(
            'resolvePlayerRank([], server) must choose the account rank',
          );
        }
      } catch (error) {
        violations.push(
          `summaryFromServer/resolvePlayerRank threw on parser-accepted rank: ${errorKind(error)}`,
        );
      }
      // Spec probes (documented contract, no crash).
      if (rawRank && typeof rawRank === 'object' && !Array.isArray(rawRank)) {
        const raw = rawRank as Record<string, unknown>;
        if (
          raw['scoredShotCount'] === null &&
          parsed.scoredShotCount !== null
        ) {
          specNotes.push(
            `S1:scoredShotCount null coerced to ${String(parsed.scoredShotCount)}`,
          );
        }
        if (typeof raw['rating'] !== 'number') {
          specNotes.push(
            `S2:non-number rating ${describeInput(raw['rating'], 40)} accepted as ${parsed.rating}`,
          );
        }
      }
    } else if (rawRank !== null) {
      violations.push(
        'parser returned null for a payload whose rank is not null',
      );
    }
  } catch (error) {
    if (error instanceof PlayerRankApiError) {
      typedRejection = true;
      if (
        !error.message.startsWith(
          'The rank server returned an invalid response.',
        ) &&
        error.message !== 'Invalid rank technique row.'
      ) {
        violations.push(
          `typed error carries unexpected message: ${error.message}`,
        );
      }
    } else {
      violations.push(
        `untyped throw out of parsePlayerRank: ${errorKind(error)}`,
      );
    }
  }
  return {
    violations,
    specNotes,
    family: `${transport}:${family}`,
    input: payload,
    typedRejection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 2 — fetchPlayerRank: status codes, body failures, transport throws.
// The two user-facing messages are the ONLY strings allowed to escape; no
// server detail may ride along.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_FETCH_MESSAGES = new Set([
  'Your account rank is temporarily unavailable.',
  'The rank server returned an invalid response.',
  'Invalid rank technique row.',
]);

const SESSION: ApiSession = {
  apiBaseUrl: 'https://api.stress.invalid',
  bearerToken: 'stress-token',
  canonicalAppUserId: 'stress-user',
  provider: 'google',
};

const SERVER_DETAIL = 'STRESS_SERVER_DETAIL_MARKER';

export async function probeFetchPlayerRank(rng: Rng): Promise<Probe> {
  const status = pick(
    rng,
    [
      200, 200, 200, 201, 204, 400, 401, 403, 404, 429, 500, 502, 503, 0, -1,
      999,
    ],
  );
  const bodyMode = pick(rng, [
    'payload',
    'payload',
    'reject',
    'throw-sync',
    'detail',
  ] as const);
  const transportThrows = chance(rng, 0.1);
  const { payload: generated, family } = generateRankPayload(rng);
  const payload = applyTransport(
    rng,
    generated,
    pick(rng, ['object', 'json'] as const),
  );
  const detailBody = {
    error: SERVER_DETAIL,
    stack: `at ${SERVER_DETAIL}`,
    rank: SERVER_DETAIL,
  };
  const fetchFn: PlayerRankFetch = async () => {
    if (transportThrows)
      throw new TypeError(`Network request failed ${SERVER_DETAIL}`);
    const response = {
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (bodyMode === 'reject')
          throw new SyntaxError(`Unexpected token ${SERVER_DETAIL}`);
        if (bodyMode === 'throw-sync') throw new Error(SERVER_DETAIL);
        if (bodyMode === 'detail') return detailBody;
        return payload;
      },
    };
    return response as unknown as Response;
  };
  const violations: string[] = [];
  const specNotes: string[] = [];
  let typedRejection = false;
  try {
    const rank = await fetchPlayerRank(SESSION, fetchFn);
    if (!(status >= 200 && status < 300)) {
      violations.push(`non-2xx status ${status} resolved instead of rejecting`);
    }
    if (rank !== null) checkServerRankShape(rank, violations, specNotes);
    if (bodyMode !== 'payload' && rank !== null) {
      violations.push(`body mode ${bodyMode} produced a rank`);
    }
  } catch (error) {
    if (error instanceof PlayerRankApiError) {
      typedRejection = true;
      if (!ALLOWED_FETCH_MESSAGES.has(error.message)) {
        violations.push(
          `fetch error message not in the allowed set: ${error.message}`,
        );
      }
      if (error.message.includes(SERVER_DETAIL)) {
        violations.push('server detail leaked through PlayerRankApiError');
      }
    } else {
      violations.push(
        `untyped rejection out of fetchPlayerRank: ${errorKind(error)}`,
      );
    }
  }
  return {
    violations,
    specNotes,
    family: `status=${status};body=${bodyMode};${transportThrows ? 'transport-throw;' : ''}${family}`,
    input: { status, bodyMode, transportThrows, payload },
    typedRejection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 3 — rankFromFacts / resolvePlayerRank over corrupt local rows.
// `listRealAnalysisFacts` casts the stored JSON without field validation
// (repository.ts), so the rank must tolerate any JSON-shaped field.
// ─────────────────────────────────────────────────────────────────────────────

function validFact(rng: Rng, index: number): RealAnalysisFact {
  const shotType = pick(rng, VALID_SHOTS);
  return {
    id: `fact-${index}-${Math.floor(rng() * 1e9).toString(16)}`,
    shotType,
    capturedAt: validIso(rng),
    overallScore: validScore(rng),
    confidence: Math.round(rng() * 100) / 100,
    resultKind: 'scored',
    scoringModelVersion: pick(rng, ['sm-v1', 'sm-v2']),
    shotConfigVersion: `${shotType}@${pick(rng, ['1', '2'])}`,
    sessionId: chance(rng, 0.5) ? null : `session-${int(rng, 1, 20)}`,
    priorityCheckpoint: chance(rng, 0.5) ? null : 'paddle_ready',
    checkpointScores: chance(rng, 0.5)
      ? {}
      : { paddle_ready: int(rng, 0, 100) },
  };
}

/** A fact whose fields may carry any JSON-shaped garbage a corrupt
 * `local_shot.payload` could hold (typed via cast, so `unknown` here). */
function corruptFact(
  rng: Rng,
  index: number,
  corruption: number,
): Record<string, unknown> {
  const fact: Record<string, unknown> = { ...validFact(rng, index) };
  if (chance(rng, corruption)) fact['id'] = weirdString(rng);
  if (chance(rng, corruption)) fact['shotType'] = weirdString(rng);
  if (chance(rng, corruption)) fact['capturedAt'] = weirdIso(rng);
  if (chance(rng, corruption)) fact['overallScore'] = weirdNumber(rng);
  if (chance(rng, corruption)) fact['confidence'] = weirdNumber(rng);
  if (chance(rng, corruption)) {
    fact['resultKind'] = pick(rng, [
      'scored',
      'low_confidence',
      'no_read',
      'SCORED',
      '',
      null,
      undefined,
      1,
      {},
    ]);
  }
  if (chance(rng, corruption)) fact['scoringModelVersion'] = weirdString(rng);
  if (chance(rng, corruption)) fact['shotConfigVersion'] = weirdString(rng);
  if (chance(rng, corruption)) fact['sessionId'] = weirdString(rng);
  if (chance(rng, corruption)) {
    fact['checkpointScores'] = pick(rng, [
      null,
      undefined,
      [],
      'x',
      { __proto__: { a: 1 } },
      { a: Number.NaN },
    ]);
  }
  if (chance(rng, corruption))
    fact['source'] = pick(rng, ['real', 'fixture', 'demo', '', null, 1]);
  if (chance(rng, corruption * 0.3)) pollute(rng, fact);
  return fact;
}

function factHistory(rng: Rng): { facts: unknown[]; family: string } {
  const roll = rng();
  if (roll < 0.05) return { facts: [], family: 'empty' };
  const huge = roll < 0.09;
  const length = huge ? int(rng, 4000, 8000) : int(rng, 1, 40);
  const corruption = roll < 0.35 ? 0 : pick(rng, [0.1, 0.3, 0.7, 1]);
  const facts: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    facts.push(
      corruption === 0
        ? validFact(rng, index)
        : corruptFact(rng, index, corruption),
    );
  }
  // Same-instant duplicates and duplicate ids stress the tie-breaks.
  if (facts.length > 1 && chance(rng, 0.3)) {
    const source = facts[0] as Record<string, unknown>;
    facts.push({
      ...source,
      id: chance(rng, 0.5) ? source['id'] : `${String(source['id'])}-dup`,
    });
  }
  return {
    facts,
    family: `${huge ? 'huge' : 'small'}:${corruption === 0 ? 'typed' : `corrupt@${corruption}`}`,
  };
}

function probeRankResolve(rng: Rng): Probe {
  const { facts, family } = factHistory(rng);
  const violations: string[] = [];
  const specNotes: string[] = [];
  // The server side goes through the real parser, so only parser-accepted
  // ranks reach resolvePlayerRank — as in production.
  let server: ServerPlayerRank | null = null;
  let serverFamily = 'server:none';
  if (chance(rng, 0.6)) {
    const generated = generateRankPayload(rng);
    try {
      server = parsePlayerRank(applyTransport(rng, generated.payload, 'json'));
      serverFamily = `server:${server ? 'accepted' : 'null'}`;
    } catch {
      serverFamily = 'server:rejected';
    }
  }
  const typedFacts = facts as PlayerRankFactLike[];
  try {
    const local = rankFromFacts(typedFacts);
    if (local !== null) {
      checkSummaryShape(local, violations, 'rankFromFacts');
      if (local.techniques.length !== local.techniqueCount) {
        violations.push('rankFromFacts: techniqueCount != techniques.length');
      }
      if (local.scoredAnalysisCount < local.techniqueCount) {
        violations.push('rankFromFacts: scoredAnalysisCount < techniqueCount');
      }
      if (local.rating < 0 || local.rating > 10) {
        violations.push(`rankFromFacts: rating outside 0–10 (${local.rating})`);
      }
      for (const technique of local.techniques) {
        if (technique.score < 0 || technique.score > 10) {
          violations.push(
            `rankFromFacts: technique score outside 0–10 (${technique.score})`,
          );
        }
      }
      // Countability oracle: a countable row is (scored, finite 0–10 number,
      // non-empty string shotType, source absent or 'real').
      const countable = typedFacts.filter(
        fact =>
          fact.resultKind === 'scored' &&
          typeof fact.overallScore === 'number' &&
          Number.isFinite(fact.overallScore) &&
          fact.overallScore >= 0 &&
          fact.overallScore <= 10 &&
          typeof fact.shotType === 'string' &&
          fact.shotType.length > 0 &&
          (fact.source === undefined || fact.source === 'real'),
      );
      if (local.scoredAnalysisCount !== countable.length) {
        violations.push(
          `rankFromFacts: scoredAnalysisCount ${local.scoredAnalysisCount} != countable rows ${countable.length}`,
        );
      }
      if (
        new Set(countable.map(fact => fact.shotType)).size !==
        local.techniqueCount
      ) {
        violations.push(
          'rankFromFacts: techniqueCount != distinct countable shot types',
        );
      }
      // Order independence: the same rows shuffled must yield the same summary.
      const shuffled = [...typedFacts].sort(() => rng() - 0.5);
      const again = rankFromFacts(shuffled);
      if (JSON.stringify(again) !== JSON.stringify(local)) {
        violations.push('rankFromFacts: result depends on input order');
      }
    } else {
      const anyCountable = typedFacts.some(
        fact =>
          fact.resultKind === 'scored' &&
          typeof fact.overallScore === 'number' &&
          Number.isFinite(fact.overallScore) &&
          fact.overallScore >= 0 &&
          fact.overallScore <= 10 &&
          typeof fact.shotType === 'string' &&
          fact.shotType.length > 0 &&
          (fact.source === undefined || fact.source === 'real'),
      );
      if (anyCountable)
        violations.push('rankFromFacts: null despite countable rows');
    }
    const resolved = resolvePlayerRank(typedFacts, server);
    if (resolved === null) {
      if (local !== null || server !== null)
        violations.push('resolvePlayerRank: null although a source exists');
    } else {
      checkSummaryShape(
        resolved.summary,
        violations,
        `resolvePlayerRank[${resolved.source}]`,
      );
      if (resolved.source !== 'account' && resolved.source !== 'device') {
        violations.push('resolvePlayerRank: unknown source');
      }
      if (server && local) {
        const account = summaryFromServer(server);
        const expected =
          account.scoredAnalysisCount >= local.scoredAnalysisCount
            ? 'account'
            : 'device';
        if (resolved.source !== expected)
          violations.push('resolvePlayerRank: arbitration mismatch');
      }
    }
  } catch (error) {
    violations.push(
      `untyped throw out of rankFromFacts/resolvePlayerRank: ${errorKind(error)}`,
    );
  }
  return {
    violations,
    specNotes,
    family: `${family};${serverFamily}`,
    input: {
      facts:
        facts.length <= 6
          ? facts
          : { length: facts.length, head: facts.slice(0, 3) },
      server,
    },
    typedRejection: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 4 — buildGameplayProgression over stored summary JSON.
// ─────────────────────────────────────────────────────────────────────────────

function validSummaryRecord(rng: Rng): Record<string, unknown> {
  const scoredCount = int(rng, 0, 40);
  return {
    version: 1,
    engineVersion: 'engine-1',
    source: chance(rng, 0.8) ? 'live' : 'replay',
    durationMs: int(rng, 0, 3_600_000),
    strokeCount: scoredCount + int(rng, 0, 10),
    scoredCount,
    noReadCount: int(rng, 0, 5),
    pendingCount: int(rng, 0, 5),
    startAverage: scoredCount ? validScore(rng) : null,
    endAverage: scoredCount ? validScore(rng) : null,
    delta: scoredCount ? Math.round((rng() * 4 - 2) * 10) / 10 : null,
    bestScore: scoredCount ? validScore(rng) : null,
    sessionAverage: scoredCount ? validScore(rng) : null,
    cuesSpoken: int(rng, 0, 20),
    topCorrection: chance(rng, 0.5) ? null : 'paddle_ready',
    correctionsByCheckpoint: chance(rng, 0.5)
      ? {}
      : { paddle_ready: int(rng, 0, 9) },
  };
}

const NUMERIC_SUMMARY_FIELDS = [
  'durationMs',
  'strokeCount',
  'scoredCount',
  'noReadCount',
  'pendingCount',
  'startAverage',
  'endAverage',
  'delta',
  'bestScore',
  'sessionAverage',
  'cuesSpoken',
] as const;

function generateSummaryJson(rng: Rng): {
  summary: string | null;
  family: string;
} {
  const roll = rng();
  if (roll < 0.06) return { summary: null, family: 'null' };
  if (roll < 0.12) {
    return {
      summary: pick(rng, [
        '',
        ' ',
        '{',
        '{"version":1',
        '{"version":1,"source":"live"',
        '[]',
        '[1]',
        '1',
        '"live"',
        'null',
        'true',
        'undefined',
        'NaN',
        '{"version":1,"source":"live"}\u0000',
        KB64,
        `{"version":1,"source":"live","topCorrection":"${'x'.repeat(70_000)}"}`,
        '{"__proto__":{"polluted":true},"version":1,"source":"live"}',
        '{"constructor":{"prototype":{"polluted":true}},"version":1,"source":"live"}',
        '{"version":1,"source":"live","correctionsByCheckpoint":{"__proto__":1,"constructor":2}}',
        '{"version":1,"source":"live","scoredCount":1e400}',
        '{"version":1,"source":"live","scoredCount":-0}',
        '{"version":1,"source":"live","sessionAverage":-0,"scoredCount":1}',
      ]),
      family: 'raw-text',
    };
  }
  const record = validSummaryRecord(rng);
  const mutations: string[] = [];
  if (roll < 0.45) {
    // Typed-valid record.
  } else {
    const count = int(rng, 1, 4);
    for (let index = 0; index < count; index += 1) {
      const which = int(rng, 0, 5);
      if (which === 0) {
        record['version'] = pick(rng, [
          1,
          '1',
          1.0,
          2,
          99,
          0,
          -1,
          null,
          undefined,
          true,
          [1],
          {},
          Number.MAX_SAFE_INTEGER,
        ]);
        mutations.push('version');
      } else if (which === 1) {
        record['source'] = pick(rng, [
          'live',
          'replay',
          'demo',
          'LIVE',
          'Live',
          'live\u0000',
          '',
          null,
          undefined,
          1,
          ['live'],
        ]);
        mutations.push('source');
      } else if (which === 2) {
        const field = pick(rng, NUMERIC_SUMMARY_FIELDS);
        record[field] = weirdNumber(rng);
        mutations.push(field);
      } else if (which === 3) {
        record['topCorrection'] = weirdString(rng);
        mutations.push('topCorrection');
      } else if (which === 4) {
        record['correctionsByCheckpoint'] = pick(rng, [
          null,
          [],
          'x',
          1,
          { a: 1.5 },
          { a: Number.NaN },
          { a: Number.POSITIVE_INFINITY },
          { '': 1 },
        ]);
        if (
          chance(rng, 0.5) &&
          record['correctionsByCheckpoint'] &&
          typeof record['correctionsByCheckpoint'] === 'object'
        ) {
          pollute(
            rng,
            record['correctionsByCheckpoint'] as Record<string, unknown>,
          );
        }
        mutations.push('correctionsByCheckpoint');
      } else {
        pollute(rng, record);
        mutations.push('pollute');
      }
    }
  }
  let text = JSON.stringify(record);
  let truncated = false;
  if (chance(rng, 0.15)) {
    text = text.slice(0, int(rng, 0, text.length - 1));
    truncated = true;
  }
  return {
    summary: text,
    family: `${mutations.length ? `mutate:${mutations.join('+')}` : 'typed'}${truncated ? ';truncated' : ''}`,
  };
}

/** Independent oracle: which rows must become sessions. */
function expectedSession(summary: string | null): boolean {
  if (summary === null) return false;
  let raw: unknown;
  try {
    raw = JSON.parse(summary);
  } catch {
    return false;
  }
  if (typeof raw !== 'object' || raw === null) return false;
  const record = raw as Record<string, unknown>;
  return record['version'] === 1 && record['source'] === 'live';
}

function probeGameplayProgression(rng: Rng): Probe {
  const roll = rng();
  const length =
    roll < 0.05 ? 0 : roll < 0.09 ? int(rng, 10_000, 20_000) : int(rng, 1, 30);
  const rows: LiveSessionHistoryRow[] = [];
  const families = new Set<string>();
  for (let index = 0; index < length; index += 1) {
    const { summary, family } = generateSummaryJson(rng);
    families.add(family.split(':')[0] ?? family);
    rows.push({
      id: chance(rng, 0.1) ? (weirdString(rng) as string) : `session-${index}`,
      startedAt: chance(rng, 0.2) ? (weirdIso(rng) as string) : validIso(rng),
      endedAt: chance(rng, 0.2)
        ? (weirdIso(rng) as string | null)
        : chance(rng, 0.2)
          ? null
          : validIso(rng),
      summary,
    });
  }
  const violations: string[] = [];
  const specNotes: string[] = [];
  try {
    const progression = buildGameplayProgression(rows);
    const expectedIds = rows
      .filter(row => expectedSession(row.summary))
      .map(row => row.id);
    const actualIds = progression.sessions.map(session => session.sessionId);
    if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      violations.push(
        `session inclusion differs from oracle (expected ${expectedIds.length}, got ${actualIds.length})`,
      );
    }
    for (const session of progression.sessions) {
      for (const field of ['average', 'delta', 'best'] as const) {
        const value = session[field];
        if (value !== null && !isFiniteNumber(value))
          violations.push(`session.${field} not finite/null`);
      }
      for (const field of [
        'scoredCount',
        'strokeCount',
        'cuesSpoken',
      ] as const) {
        const value = session[field];
        if (!Number.isSafeInteger(value) || value < 0)
          violations.push(`session.${field} not a non-negative safe integer`);
      }
      if (
        session.topCorrection !== null &&
        typeof session.topCorrection !== 'string'
      ) {
        violations.push('session.topCorrection not string/null');
      }
    }
    const scored = progression.sessions.filter(
      session => session.average !== null && session.scoredCount > 0,
    );
    if (scored.length !== progression.scoredSessions.length)
      violations.push('scoredSessions count mismatch');
    if (progression.trendPoints.length !== scored.length)
      violations.push('trendPoints length mismatch');
    if (!progression.trendPoints.every(isFiniteNumber))
      violations.push('trendPoints contain non-finite values');
    if (progression.firstAverage !== (progression.trendPoints[0] ?? null))
      violations.push('firstAverage mismatch');
    if (progression.latestAverage !== (progression.trendPoints.at(-1) ?? null))
      violations.push('latestAverage mismatch');
    if (progression.overallDelta !== null) {
      if (progression.trendPoints.length < 2)
        violations.push('overallDelta present with < 2 scored sessions');
      if (!isFiniteNumber(progression.overallDelta)) {
        // `latest - first` overflows to ±Infinity only when a persisted
        // sessionAverage sits near ±MAX_VALUE (a real average is 0..10).
        const first = progression.firstAverage ?? 0;
        const latest = progression.latestAverage ?? 0;
        const inRange = (value: number) => value >= 0 && value <= 10;
        if (inRange(first) && inRange(latest))
          violations.push('overallDelta not finite');
        else
          specNotes.push(
            `S6:overallDelta ${String(progression.overallDelta)} from persisted averages ${String(first)} → ${String(latest)}`,
          );
      }
    } else if (progression.trendPoints.length >= 2) {
      violations.push('overallDelta null despite 2+ scored sessions');
    }
    if ((progression.bestSession === null) !== (scored.length === 0))
      violations.push('bestSession presence mismatch');
    if (progression.bestSession) {
      const best = Math.max(
        ...scored.map(session => session.average as number),
      );
      if (progression.bestSession.average !== best)
        violations.push('bestSession is not the maximum average');
    }
    // Sums of per-session safe integers may exceed 2^53 when a corrupt row
    // claims MAX_SAFE_INTEGER swings; they must still be finite integers ≥ 0.
    if (
      !Number.isInteger(progression.totalScoredSwings) ||
      progression.totalScoredSwings < 0
    ) {
      violations.push('totalScoredSwings not a non-negative integer');
    }
    if (
      !Number.isInteger(progression.totalStrokeEvents) ||
      progression.totalStrokeEvents < 0
    ) {
      violations.push('totalStrokeEvents not a non-negative integer');
    }
    if (progression.improvedSessions > progression.sessions.length)
      violations.push('improvedSessions > sessions');
    for (const row of rows) {
      if (typeof row.startedAt !== 'string') continue;
      try {
        const label = sessionDayLabel(row.startedAt);
        if (typeof label !== 'string')
          violations.push('sessionDayLabel returned a non-string');
      } catch (error) {
        violations.push(`sessionDayLabel threw: ${errorKind(error)}`);
      }
    }
  } catch (error) {
    violations.push(
      `untyped throw out of buildGameplayProgression: ${errorKind(error)}`,
    );
  }
  return {
    violations,
    specNotes,
    family: `${length === 0 ? 'empty' : length > 1000 ? 'huge' : 'small'}:${[...families].sort().join('+') || 'none'}`,
    input:
      rows.length <= 4 ? rows : { length: rows.length, head: rows.slice(0, 2) },
    typedRejection: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 5 — buildTechniqueDashboard.
// ─────────────────────────────────────────────────────────────────────────────

const DASHBOARD_ERRORS = new Set([
  'Unsupported technique dashboard range.',
  'asOfIso must be a parseable ISO timestamp.',
  'timeZone must be a supported IANA timezone.',
]);

function dashboardOptions(rng: Rng): {
  options: TechniqueDashboardOptions;
  valid: boolean;
  family: string;
} {
  const roll = rng();
  if (roll < 0.7) {
    return {
      options: {
        asOfIso: validIso(rng),
        timeZone: pick(rng, VALID_TIMEZONES),
        range: pick(rng, VALID_RANGES),
      },
      valid: true,
      family: 'options:valid',
    };
  }
  const broken = pick(rng, ['range', 'asOfIso', 'timeZone'] as const);
  const options = {
    asOfIso: broken === 'asOfIso' ? weirdIso(rng) : validIso(rng),
    timeZone:
      broken === 'timeZone'
        ? pick(rng, INVALID_TIMEZONES)
        : pick(rng, VALID_TIMEZONES),
    range:
      broken === 'range' ? pick(rng, INVALID_RANGES) : pick(rng, VALID_RANGES),
  } as unknown as TechniqueDashboardOptions;
  // A weird ISO may still parse (e.g. '2026-08-01', or a number that
  // `Date.parse` stringifies) and a weird range never does; validity is
  // decided by the same predicates the builder documents.
  const rangeOk = VALID_RANGES.includes(options.range);
  const asOfOk = Number.isFinite(Date.parse(options.asOfIso));
  const zoneOk = (() => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: options.timeZone });
      return true;
    } catch {
      return false;
    }
  })();
  return {
    options,
    valid: rangeOk && asOfOk && zoneOk,
    family: `options:broken-${broken}`,
  };
}

function probeTechniqueDashboard(rng: Rng): Probe {
  const { facts, family: factsFamily } = factHistory(rng);
  const {
    options,
    valid: optionsValid,
    family: optionsFamily,
  } = dashboardOptions(rng);
  const typedFacts = facts as RealAnalysisFact[];
  const corrupt = factsFamily.includes('corrupt');
  const violations: string[] = [];
  const specNotes: string[] = [];
  let typedRejection = false;
  try {
    const dashboard = buildTechniqueDashboard(typedFacts, options);
    if (!optionsValid)
      violations.push('invalid options accepted without a typed error');
    if (typeof options.asOfIso !== 'string') {
      specNotes.push(
        `S7:non-string asOfIso ${describeInput(options.asOfIso)} coerced by Date.parse`,
      );
    }
    const reads = dashboard.reads;
    const soft = corrupt ? specNotes : violations;
    if (dashboard.scoredReps.current !== reads.length)
      violations.push('scoredReps.current != reads.length');
    if (dashboard.buckets.length > 13)
      violations.push(`buckets.length ${dashboard.buckets.length} > 13`);
    // The day grid is keyed by `YYYY-MM-DD` from Intl's unpadded year; an asOf
    // whose LOCAL year is not four digits (year 0 → "1", 999, 10000, +275760)
    // cannot be keyed and yields an empty grid. Unreachable from a device
    // clock, recorded as an informational note rather than a failure.
    const localYear = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: options.timeZone,
      year: 'numeric',
    }).format(new Date(Date.parse(options.asOfIso)));
    if (dashboard.buckets.length === 0) {
      if (localYear.length === 4) violations.push('no buckets');
      else
        specNotes.push(
          `N1:asOf local year "${localYear}" is not four digits → empty bucket grid`,
        );
    }
    let bucketCount = 0;
    for (const bucket of dashboard.buckets) {
      bucketCount += bucket.count;
      if (bucket.avg !== null && !isFiniteNumber(bucket.avg))
        soft.push('S4:bucket.avg not finite');
      if ((bucket.avg === null) !== (bucket.count === 0))
        violations.push('bucket avg/count disagree');
      if (typeof bucket.label !== 'string' || bucket.label === '')
        violations.push('bucket label empty');
    }
    if (bucketCount !== reads.length)
      violations.push('bucket counts do not sum to reads');
    for (let index = 1; index < reads.length; index += 1) {
      const previous = reads[index - 1]!;
      const current = reads[index]!;
      if (
        previous.capturedAtMs > current.capturedAtMs ||
        (previous.capturedAtMs === current.capturedAtMs &&
          typeof previous.id === 'string' &&
          typeof current.id === 'string' &&
          previous.id.localeCompare(current.id) > 0)
      ) {
        violations.push('reads not ascending by time then id');
        break;
      }
    }
    const scoreOk = (value: number | null) =>
      value === null || isFiniteNumber(value);
    if (
      !scoreOk(dashboard.avgScore.current) ||
      !scoreOk(dashboard.avgScore.previous)
    ) {
      soft.push('S4:avgScore not finite/null');
    }
    if (
      !scoreOk(dashboard.bestScore.current) ||
      !scoreOk(dashboard.bestScore.previous)
    ) {
      soft.push('S4:bestScore not finite/null');
    }
    if ((dashboard.avgScore.current === null) !== (reads.length === 0))
      violations.push('avgScore.current presence mismatch');
    if (dashboard.scoredDays.current > reads.length)
      violations.push('scoredDays > reads');
    if (
      dashboard.scoredReps.previous !== null &&
      dashboard.scoredReps.previous < 0
    )
      violations.push('negative previous reps');
    if (dashboard.personalBest) {
      if (
        !(dashboard.personalBest.score > dashboard.personalBest.previousBest)
      ) {
        soft.push('S4:personalBest does not strictly beat previousBest');
      }
    }
    if (dashboard.insight !== null && typeof dashboard.insight !== 'string')
      violations.push('insight not string/null');
    if (dashboard.insight !== null && /NaN|Infinity/.test(dashboard.insight)) {
      soft.push(`S4:insight renders a non-finite number: ${dashboard.insight}`);
    }
    for (const read of reads) {
      if (!isFiniteNumber(read.score)) soft.push('S4:read.score not finite');
      if (!Number.isFinite(Date.parse(`${read.day}T00:00:00.000Z`)))
        violations.push(`read.day not a calendar day: ${read.day}`);
      if (read.capturedAtMs > Date.parse(options.asOfIso))
        violations.push('read after asOf included');
    }
    if (!corrupt) {
      // Typed facts: every comparable read must be scored, in the window,
      // and never after asOf — check the count against an independent filter.
      const asOfMs = Date.parse(options.asOfIso);
      const eligible = typedFacts.filter(
        fact =>
          fact.resultKind === 'scored' &&
          fact.overallScore !== null &&
          Number.isFinite(Date.parse(fact.capturedAt)) &&
          Date.parse(fact.capturedAt) <= asOfMs,
      );
      if (reads.length > eligible.length)
        violations.push('more reads than eligible scored facts');
    }
  } catch (error) {
    if (error instanceof Error && DASHBOARD_ERRORS.has(error.message)) {
      typedRejection = true;
      if (optionsValid)
        violations.push(
          `typed options error thrown for valid options: ${error.message}`,
        );
    } else if (corrupt) {
      specNotes.push(
        `S4:corrupt local row crashes buildTechniqueDashboard: ${errorKind(error)}`,
      );
    } else {
      violations.push(
        `untyped throw out of buildTechniqueDashboard: ${errorKind(error)}`,
      );
    }
  }
  return {
    violations,
    specNotes,
    family: `${factsFamily};${optionsFamily}`,
    input: {
      options,
      facts:
        facts.length <= 4
          ? facts
          : { length: facts.length, head: facts.slice(0, 2) },
    },
    typedRejection,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Module 6 — scalar helpers: duprEstimate / formatDuprEstimate /
// formatSignedDelta / vsPriorLabel / sessionDayLabel / tierIndex /
// rankCelebrationKeyForOwner / evaluateRankTransition.
// ─────────────────────────────────────────────────────────────────────────────

const DUPR_FORMAT = /^\(≈ DUPR \d\.\d\)$/;

function fuzzSummary(rng: Rng, corruption: number): PlayerRankSummary {
  const rating = chance(rng, corruption)
    ? (weirdNumber(rng) as number)
    : Math.round(rng() * 1000) / 100;
  const tier = chance(rng, corruption)
    ? (weirdString(rng) as PlayerRankSummary['tier'])
    : pick(rng, VALID_TIERS);
  return {
    rating,
    tier,
    tierLabel: 'X',
    division: 'I',
    divisionLabel: 'I',
    techniqueCount: 1,
    scoredAnalysisCount: 1,
    techniques: [],
    nextTier: null,
  } as unknown as PlayerRankSummary;
}

function probeScalars(rng: Rng): Probe {
  const violations: string[] = [];
  const specNotes: string[] = [];
  const inputs: Record<string, unknown> = {};

  // duprEstimate over any `number` (the type admits NaN and ±Infinity).
  const score = pick(rng, [
    ...WEIRD_NUMBERS.filter(
      (value): value is number => typeof value === 'number',
    ),
    validScore(rng),
    rng() * 20 - 5,
  ]);
  inputs['score'] = score;
  try {
    const estimate = duprEstimate(score);
    const formatted = formatDuprEstimate(score);
    if (!isFiniteNumber(estimate) || estimate < 1 || estimate > 7) {
      if (Number.isNaN(score))
        specNotes.push(
          `S5:duprEstimate(NaN) = ${String(estimate)} → "${formatted}"`,
        );
      else
        violations.push(
          `duprEstimate(${String(score)}) = ${String(estimate)} outside 1–7`,
        );
    }
    if (!DUPR_FORMAT.test(formatted) && !Number.isNaN(score)) {
      violations.push(`formatDuprEstimate(${String(score)}) = ${formatted}`);
    }
  } catch (error) {
    violations.push(`duprEstimate threw: ${errorKind(error)}`);
  }

  // formatSignedDelta: -0 must never print "-0.0"; finite input must print a sign.
  const delta = pick(rng, [
    ...WEIRD_NUMBERS.filter(
      (value): value is number => typeof value === 'number',
    ),
    rng() * 4 - 2,
    -0.04,
    -0.05,
    0.05,
  ]);
  const decimals = pick(rng, [undefined, 0, 1, 2, 3]);
  inputs['delta'] = delta;
  inputs['decimals'] = decimals;
  try {
    const text =
      decimals === undefined
        ? formatSignedDelta(delta)
        : formatSignedDelta(delta, decimals);
    if (!/^[+-]/.test(text))
      violations.push(
        `formatSignedDelta(${String(delta)}) lacks a sign: ${text}`,
      );
    if (/^-0(\.0+)?$/.test(text))
      violations.push(`formatSignedDelta printed negative zero: ${text}`);
    // toFixed switches to exponent notation at |x| ≥ 1e21 — still signed.
    if (Number.isFinite(delta) && !/^[+-]\d+(\.\d+)?(e\+\d+)?$/.test(text)) {
      violations.push(
        `formatSignedDelta(${String(delta)}, ${String(decimals)}) = ${text}`,
      );
    }
  } catch (error) {
    violations.push(`formatSignedDelta threw: ${errorKind(error)}`);
  }

  // vsPriorLabel over any string.
  const range = chance(rng, 0.5)
    ? pick(rng, VALID_RANGES)
    : pick(rng, INVALID_RANGES);
  inputs['range'] = range;
  try {
    const label = vsPriorLabel(range as PracticeHistoryRangeKey);
    if (typeof label !== 'string' || !label.startsWith('VS. PRIOR'))
      violations.push(`vsPriorLabel = ${describeInput(label)}`);
  } catch (error) {
    violations.push(`vsPriorLabel threw: ${errorKind(error)}`);
  }

  // sessionDayLabel over any string (render path — must never throw).
  const iso = weirdIso(rng);
  inputs['iso'] = iso;
  if (typeof iso === 'string') {
    try {
      const label = sessionDayLabel(iso);
      if (typeof label !== 'string')
        violations.push('sessionDayLabel returned a non-string');
      // The documented fallback echoes the raw prefix, so "NaN" in → "NaN" out is
      // correct; only a computed NaN/undefined is a failure.
      if (
        /NaN|undefined/.test(label) &&
        !label.split('').every(glyph => iso.includes(glyph))
      ) {
        violations.push(
          `sessionDayLabel("${describeInput(iso, 30)}") = ${label}`,
        );
      }
    } catch (error) {
      violations.push(`sessionDayLabel threw: ${errorKind(error)}`);
    }
  }

  // tierIndex / rankCelebrationKeyForOwner over any string.
  const owner = weirdString(rng);
  inputs['owner'] = owner;
  if (typeof owner === 'string') {
    try {
      const index = tierIndex(owner);
      if (
        !Number.isInteger(index) ||
        index < -1 ||
        index >= PLAYER_RANK_TIERS.length
      ) {
        violations.push(`tierIndex out of range: ${index}`);
      }
      const key = rankCelebrationKeyForOwner(owner);
      if (key !== `rank.celebrated:${owner}`)
        violations.push('rankCelebrationKeyForOwner changed the owner');
    } catch (error) {
      violations.push(
        `tierIndex/rankCelebrationKeyForOwner threw: ${errorKind(error)}`,
      );
    }
  }

  // evaluateRankTransition over fuzzed records.
  const stored = chance(rng, 0.3)
    ? null
    : ({
        version: 1,
        tier: chance(rng, 0.4) ? weirdString(rng) : pick(rng, VALID_TIERS),
        rating: chance(rng, 0.4)
          ? weirdNumber(rng)
          : Math.round(rng() * 1000) / 100,
      } as unknown as Parameters<typeof evaluateRankTransition>[0]);
  const summary = fuzzSummary(rng, 0.4);
  inputs['stored'] = stored;
  inputs['summary'] = { tier: summary.tier, rating: summary.rating };
  try {
    const celebration = evaluateRankTransition(stored, summary);
    if (celebration !== null) {
      if (tierIndex(celebration.toTier) < 0)
        violations.push('celebration.toTier is not a known tier');
      if (celebration.toTier !== summary.tier)
        violations.push('celebration.toTier != summary.tier');
      if (stored === null) {
        if (celebration.fromTier !== null || celebration.fromRating !== null)
          violations.push('placement carries a fromTier');
      } else {
        if (celebration.fromTier !== stored.tier)
          violations.push('promotion fromTier != stored.tier');
        if (!(tierIndex(celebration.toTier) > tierIndex(stored.tier)))
          violations.push('celebration without an upward move');
      }
    } else if (
      tierIndex(summary.tier) >= 0 &&
      (stored === null || tierIndex(summary.tier) > tierIndex(stored.tier))
    ) {
      violations.push('upward move produced no celebration');
    }
  } catch (error) {
    violations.push(`evaluateRankTransition threw: ${errorKind(error)}`);
  }

  return {
    violations,
    specNotes,
    family: 'scalars',
    input: inputs,
    typedRejection: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver
// ─────────────────────────────────────────────────────────────────────────────

/** Module-specific sub-seed so each module's stream is independent of the
 * others yet fully determined by `(seed, module)`. */
export function subSeed(seed: number, module: StressModule): number {
  const offset = STRESS_MODULES.indexOf(module) + 1;
  return (Math.imul(seed, 0x9e3779b1) ^ Math.imul(offset, 0x85ebca6b)) >>> 0;
}

export async function runScenario(
  seed: number,
  module: StressModule,
): Promise<ScenarioResult> {
  const rng = mulberry32(subSeed(seed, module));
  const started = Date.now();
  let probe: Probe;
  try {
    switch (module) {
      case 'parsePlayerRank':
        probe = probeParsePlayerRank(rng);
        break;
      case 'fetchPlayerRank':
        probe = await probeFetchPlayerRank(rng);
        break;
      case 'rankResolve':
        probe = probeRankResolve(rng);
        break;
      case 'gameplayProgression':
        probe = probeGameplayProgression(rng);
        break;
      case 'techniqueDashboard':
        probe = probeTechniqueDashboard(rng);
        break;
      case 'scalars':
        probe = probeScalars(rng);
        break;
    }
  } catch (error) {
    // The harness itself must never mask a scenario: a generator crash is a
    // broken scenario, reported with the seed.
    probe = {
      violations: [`harness error: ${errorKind(error)}`],
      specNotes: [],
      family: 'harness',
      input: null,
      typedRejection: false,
    };
  }
  probe.violations.push(...prototypeIntegrityViolations());
  const outcome: Outcome =
    probe.violations.length > 0
      ? 'BROKEN'
      : probe.typedRejection
        ? 'REJECTED_TYPED'
        : 'HELD';
  return {
    seed,
    module,
    family: probe.family,
    outcome,
    violations: probe.violations,
    specNotes: probe.specNotes,
    input: describeInput(probe.input),
    ms: Date.now() - started,
  };
}
