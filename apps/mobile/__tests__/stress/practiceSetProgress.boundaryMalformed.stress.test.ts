// The repository module is imported directly against a fake LocalDb; the
// SQLite-backed db module never loads under jest.
jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { setActiveDataOwner } from '../../src/data/accountScope';
import type { LocalDb } from '../../src/data/db';
import {
  listRealAnalysisFacts,
  type RealAnalysisFact,
} from '../../src/data/repository';
import {
  checkpointPhrase,
  fixedCheckpointsBetween,
  FIXED_CHECKPOINT_FROM_BELOW,
  FIXED_CHECKPOINT_TO_AT_LEAST,
  formatTenthsDelta,
  latestPracticeSet,
  practiceSetHeadline,
  practiceSetInsight,
  PRACTICE_SET_TREND_THRESHOLD_TENTHS,
  scoreTenths,
  summarizePracticeSet,
  type PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';

/**
 * Seeded boundary/malformed-input campaign for the practice-set surface.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_ITER=<n>        iterations (default 200; the campaign run uses 1500)
 *   STRESS_SEED=<base>     base seed (default 0x53455421)
 *   STRESS_REPLAY=<s1,s2>  run exactly these iteration seeds
 *   STRESS_OUT=<dir>       write the seed → outcome JSON table there
 *
 * Facts reach the module exactly the way the Progress screen gets them: raw
 * `local_shot.payload` JSON text is read through the real
 * `listRealAnalysisFacts` (fake LocalDb), so every fact shape here is one the
 * repository can actually hand to `latestPracticeSet` / `summarizePracticeSet`.
 *
 * Oracle: the documented option grammar of `latestPracticeSet` (asOfIso must
 * parse, maxAgeMs finite and >= 0), plus an independent re-derivation of the
 * set that must be summarized and structural invariants on the summary and
 * the copy helpers (no NaN/undefined/Infinity in user-facing text, a real
 * minus sign, chronological attempts, exact tenths arithmetic).
 */

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 200;
const BASE_SEED =
  Number.parseInt(process.env.STRESS_SEED ?? '', 10) || 0x53455421;
const REPLAY = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(part => Number.parseInt(part, 10))
  .filter(seed => Number.isFinite(seed));
const OUT_DIR = process.env.STRESS_OUT;

const OWNER = '55555555-5555-4555-8555-555555555555';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iterationSeeds(): number[] {
  if (REPLAY.length > 0) return REPLAY;
  return Array.from(
    { length: ITERATIONS },
    (_, index) => (BASE_SEED + index * 0x9e3779b9) >>> 0,
  );
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      const held = copy[index] as T;
      copy[index] = copy[swap] as T;
      copy[swap] = held;
    }
    return copy;
  }
}

function fakeDb(rows: Record<string, unknown>[]): LocalDb {
  return {
    async execute() {
      return { rows };
    },
    close() {},
  };
}

// ---------------------------------------------------------------------------
// Pools
// ---------------------------------------------------------------------------

const SHOT_TYPES = [
  'dink',
  'forehand_drive',
  'backhand_drive',
  'serve',
  'volley',
];
const CHECKPOINT_KEYS = [
  'contact_position',
  'athletic_base',
  'paddle_face',
  'follow_through',
  'ready_position',
];
const HOSTILE_KEYS = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'valueOf',
  '__defineGetter__',
  '',
  ' ',
  '\u0000',
  '../../etc/passwd',
  '\u00e9',
  'e\u0301',
  '\ufb01',
  'fi',
  '\ud83d\udc4b',
  'x'.repeat(70_000),
  'contact_position\u0000',
  'CONTACT_POSITION',
  '\u202econtact_position',
];
const HOSTILE_INSTANTS = [
  '',
  ' ',
  'now',
  'Z',
  '2026-08-27',
  '2026-08-27T10:00:00',
  '2026-08-27T24:00:00Z',
  '2026-08-27T23:59:60Z',
  '2026-02-30T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '1970-01-01T00:00:00Z',
  '1969-12-31T23:59:59.999Z',
  '0001-01-01T00:00:00.000Z',
  '0000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00Z',
  '+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00Z',
  '+010000-01-01T00:00:00Z',
  '\u0000Z',
  '２０２６-08-27T10:00:00Z',
  'Thu, 27 Aug 2026 10:00:00 GMT',
  '1756288800000',
  'NaN',
  `${'9'.repeat(70_000)}Z`,
];
const HOSTILE_SESSIONS = [
  '',
  ' ',
  '\u0000',
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  '../../sessions',
  '\u00e9',
  'e\u0301',
  'x'.repeat(66_000),
  '0',
  'null',
  'undefined',
];
const HOSTILE_SCORE_TEXT = [
  'null',
  '-0',
  '0',
  '10',
  '10.05',
  '9.95',
  '-1',
  '11',
  '1e400',
  '-1e400',
  '1e-400',
  '5e-324',
  '9007199254740993',
  '1.7976931348623157e308',
  '"7.5"',
  '"NaN"',
  'true',
  '[]',
  '{}',
  '[7.5]',
  '"Infinity"',
  '0.30000000000000004',
  '7.25',
  '7.35',
  '7.45',
  '7.55',
];

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Payload generation (raw local_shot.payload text)
// ---------------------------------------------------------------------------

interface Draw {
  asOfIso: string;
  asOfMs: number;
  maxAgeMs: number | undefined;
  sessionIds: string[];
  payloads: string[];
  shapes: string[];
}

function instant(rng: Rng, ms: number): string {
  const iso = new Date(ms).toISOString();
  const roll = rng.float();
  if (roll < 0.7) return iso;
  if (roll < 0.8) return iso.replace('.000Z', 'Z');
  if (roll < 0.9) return iso.replace('Z', '+00:00');
  return iso.slice(0, 19); // no zone — Date.parse treats it as local time
}

function scoreText(rng: Rng): string {
  if (rng.chance(0.7)) return (rng.int(101) / 10).toFixed(1);
  return rng.pick(HOSTILE_SCORE_TEXT);
}

function checkpointJson(rng: Rng, index: number): string {
  const key = rng.chance(0.85)
    ? JSON.stringify(CHECKPOINT_KEYS[index % CHECKPOINT_KEYS.length])
    : JSON.stringify(rng.pick(HOSTILE_KEYS));
  const score = rng.chance(0.75)
    ? String(
        rng.pick([
          FIXED_CHECKPOINT_FROM_BELOW - 1,
          FIXED_CHECKPOINT_FROM_BELOW,
          FIXED_CHECKPOINT_FROM_BELOW - 1e-9,
          FIXED_CHECKPOINT_TO_AT_LEAST,
          FIXED_CHECKPOINT_TO_AT_LEAST - 1e-9,
          0,
          100,
          rng.int(101),
        ]),
      )
    : rng.pick([...HOSTILE_SCORE_TEXT, '64.5', '79.5', '100.5', '-0.5']);
  const applicable = rng.chance(0.85)
    ? 'true'
    : rng.pick(['false', 'null', '1', '"true"', '[]']);
  return `{"key":${key},"score":${score},"applicable":${applicable}}`;
}

function payloadFor(
  rng: Rng,
  index: number,
  sessionId: string,
  shotType: string,
  versions: { scoring: string; config: string },
  capturedAtMs: number,
): { text: string; shape: string } {
  const capturedAtIso = rng.chance(0.85)
    ? instant(rng, capturedAtMs)
    : rng.pick(HOSTILE_INSTANTS);
  const resultKind = rng.chance(0.8)
    ? 'scored'
    : rng.pick(['abstained', 'low_confidence', 'SCORED', '', 'unknown']);
  const checkpointCount = rng.chance(0.1) ? 0 : rng.range(1, 5);
  const checkpoints = Array.from({ length: checkpointCount }, (_, i) =>
    checkpointJson(rng, i),
  );
  const priorityRoll = rng.float();
  const priorityFix =
    priorityRoll < 0.6
      ? `{"checkpoint":${JSON.stringify(rng.pick(CHECKPOINT_KEYS))}}`
      : priorityRoll < 0.75
        ? 'null'
        : priorityRoll < 0.9
          ? `{"checkpoint":${JSON.stringify(rng.pick(HOSTILE_KEYS))}}`
          : rng.pick(['{}', '{"checkpoint":42}', '"contact_position"', '[]']);
  const idText = rng.chance(0.9)
    ? JSON.stringify(`shot-${index}-${rng.int(1e9)}`)
    : rng.pick(['42', 'null', '""', JSON.stringify(rng.pick(HOSTILE_KEYS))]);
  const shotTypeText = rng.chance(0.9)
    ? JSON.stringify(shotType)
    : rng.pick(['null', '7', '""', JSON.stringify(rng.pick(HOSTILE_KEYS))]);
  const sessionText = JSON.stringify(sessionId);
  const versionVector = rng.chance(0.92)
    ? `{"scoringModelVersion":${JSON.stringify(versions.scoring)},"shotConfigVersion":${JSON.stringify(versions.config)}}`
    : rng.pick([
        'null',
        '{}',
        '{"scoringModelVersion":1,"shotConfigVersion":2}',
        `{"scoringModelVersion":${JSON.stringify('x'.repeat(65_536))},"shotConfigVersion":"c"}`,
        '"v1"',
      ]);
  const source = rng.chance(0.93)
    ? '"real"'
    : rng.pick(['"REAL"', '"synthetic"', 'null', '"real\\u0000"']);
  const fields = [
    `"id":${idText}`,
    `"shotType":${shotTypeText}`,
    `"capturedAtIso":${JSON.stringify(capturedAtIso)}`,
    `"source":${source}`,
    `"resultKind":${JSON.stringify(resultKind)}`,
    `"overallScore":${scoreText(rng)}`,
    `"analysisConfidence":${rng.pick(['0.9', '1', '0', 'null', '"high"', '1e400'])}`,
    `"versionVector":${versionVector}`,
    `"sessionId":${sessionText}`,
    `"priorityFix":${priorityFix}`,
    `"checkpoints":${rng.chance(0.93) ? `[${checkpoints.join(',')}]` : rng.pick(['null', '{}', '"none"', '[null,1,"x"]', '[[]]'])}`,
  ];
  let text = `{${fields.join(',')}}`;
  let shape = 'wellFormed';
  const shapeRoll = rng.int(16);
  switch (shapeRoll) {
    case 0:
      text = text.slice(0, rng.int(text.length));
      shape = 'truncatedJson';
      break;
    case 1:
      text = rng.pick([
        '',
        'null',
        '[]',
        '{}',
        '0',
        '"real"',
        'undefined',
        '\u0000',
        '{"source":"real"}',
      ]);
      shape = 'replacedJson';
      break;
    case 2:
      text = text.replace(
        /^\{/,
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
      );
      shape = 'prototypeKeys';
      break;
    case 3:
      text = text.replace(
        /^\{/,
        '{"schemaVersion":99,"futureField":{"nested":[1,2,3]},',
      );
      shape = 'futureSchema';
      break;
    case 4:
      text = text.replace(
        /^\{/,
        `{"note":${JSON.stringify('n'.repeat(70_000))},`,
      );
      shape = 'hugeStringField';
      break;
    case 5:
      // Duplicate key: last one wins in JSON.parse.
      text = text.replace(
        /\}$/,
        `,"overallScore":${rng.pick(HOSTILE_SCORE_TEXT)}}`,
      );
      shape = 'duplicateOverallScore';
      break;
    case 6:
      text = text.replace(
        /\}$/,
        `,"sessionId":${rng.pick(['null', '""', '7', '[]', '{}'])}}`,
      );
      shape = 'sessionIdWrongType';
      break;
    case 7:
      text = text.replace(
        /\}$/,
        `,"capturedAtIso":${rng.pick(['null', '1756288800000', '[]', 'true'])}}`,
      );
      shape = 'capturedAtWrongType';
      break;
    default:
      break;
  }
  return { text, shape };
}

function draw(rng: Rng): Draw {
  const asOfMs = Date.UTC(2026, 7, 27, 10) + rng.int(365 * DAY_MS);
  const asOfIso = rng.chance(0.8)
    ? instant(rng, asOfMs)
    : rng.pick(HOSTILE_INSTANTS);
  const ageRoll = rng.float();
  const maxAgeMs =
    ageRoll < 0.5
      ? undefined
      : ageRoll < 0.8
        ? rng.pick([0, 1, 60_000, DAY_MS, 7 * DAY_MS, Number.MAX_SAFE_INTEGER])
        : rng.pick<number>([
            -1,
            -0,
            Number.NaN,
            Number.POSITIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            0.5,
            '86400000' as unknown as number,
            null as unknown as number,
          ]);
  const sessionCount = rng.range(1, 4);
  const sessionIds = Array.from({ length: sessionCount }, (_, i) =>
    rng.chance(0.8) ? `set-${i}-${rng.int(1e6)}` : rng.pick(HOSTILE_SESSIONS),
  );
  const factCount = rng.chance(0.05) ? rng.range(40, 120) : rng.int(20);
  const payloads: string[] = [];
  const shapes: string[] = [];
  const versionsBySession = sessionIds.map(() => ({
    scoring: rng.pick(['sm-v1', 'sm-v2']),
    config: rng.pick(['cfg-1', 'cfg-2']),
  }));
  for (let index = 0; index < factCount; index += 1) {
    const sessionIndex = rng.int(sessionIds.length);
    const sessionId = sessionIds[sessionIndex] as string;
    const base = versionsBySession[sessionIndex] as {
      scoring: string;
      config: string;
    };
    const versions = rng.chance(0.85)
      ? base
      : {
          scoring: rng.pick(['sm-v1', 'sm-v2', 'sm-v9']),
          config: rng.pick(['cfg-1', 'cfg-2', '']),
        };
    const shotType = rng.chance(0.8)
      ? (SHOT_TYPES[sessionIndex % SHOT_TYPES.length] as string)
      : rng.pick(SHOT_TYPES);
    // Mostly inside the 24h window, some far older, some in the future.
    const spreadRoll = rng.float();
    const offset =
      spreadRoll < 0.7
        ? rng.int(DAY_MS)
        : spreadRoll < 0.85
          ? DAY_MS + rng.int(30 * DAY_MS)
          : -rng.int(2 * DAY_MS);
    const built = payloadFor(
      rng,
      index,
      sessionId,
      shotType,
      versions,
      asOfMs - offset,
    );
    payloads.push(built.text);
    shapes.push(built.shape);
  }
  return { asOfIso, asOfMs, maxAgeMs, sessionIds, payloads, shapes };
}

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

const DOCUMENTED_ERRORS = [
  'asOfIso must be a parseable ISO timestamp.',
  'maxAgeMs must be a non-negative number.',
];

function optionsValid(asOfIso: string, maxAgeMs: number | undefined): boolean {
  if (!Number.isFinite(Date.parse(asOfIso))) return false;
  // `??` semantics: an absent (undefined/null) age means the default.
  if (maxAgeMs === undefined || (maxAgeMs as unknown) === null) return true;
  return (
    typeof maxAgeMs === 'number' && Number.isFinite(maxAgeMs) && maxAgeMs >= 0
  );
}

function isScored(fact: RealAnalysisFact): boolean {
  return (
    fact.resultKind === 'scored' &&
    typeof fact.overallScore === 'number' &&
    Number.isFinite(fact.overallScore) &&
    Number.isFinite(Date.parse(fact.capturedAt))
  );
}

/** Which session (if any) the module must summarize, derived independently. */
function referenceChoice(
  facts: readonly RealAnalysisFact[],
  asOfMs: number,
  maxAgeMs: number,
): { sessionId: string; attempts: number } | null {
  const visible = facts.filter(fact => {
    const ms = Date.parse(fact.capturedAt);
    return Number.isFinite(ms) && ms <= asOfMs;
  });
  const latestBySession = new Map<string, number>();
  for (const fact of visible) {
    if (fact.sessionId === null || !isScored(fact)) continue;
    const ms = Date.parse(fact.capturedAt);
    const previous = latestBySession.get(fact.sessionId);
    if (previous === undefined || ms > previous)
      latestBySession.set(fact.sessionId, ms);
  }
  const candidates = [...latestBySession.entries()]
    .filter(([, ms]) => asOfMs - ms <= maxAgeMs)
    .sort(([a, aMs], [b, bMs]) => bMs - aMs || (a < b ? -1 : a > b ? 1 : 0));
  for (const [sessionId] of candidates) {
    if (sessionId === '') continue;
    const scored = visible
      .filter(fact => fact.sessionId === sessionId && isScored(fact))
      .sort(
        (a, b) =>
          Date.parse(a.capturedAt) - Date.parse(b.capturedAt) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    const newest = scored[scored.length - 1];
    if (!newest) continue;
    const comparable = scored.filter(
      fact =>
        fact.shotType === newest.shotType &&
        fact.scoringModelVersion === newest.scoringModelVersion &&
        fact.shotConfigVersion === newest.shotConfigVersion,
    );
    if (comparable.length >= 2)
      return { sessionId, attempts: comparable.length };
  }
  return null;
}

const BAD_TEXT = /NaN|Infinity|undefined|\[object |null/;

function summaryViolations(
  summary: PracticeSetSummary,
  asOfMs: number,
  maxAgeMs: number,
): string[] {
  const out: string[] = [];
  const attempts = summary.attempts;
  if (attempts.length < 2) out.push('fewer than two attempts');
  if (summary.first !== attempts[0]) out.push('first is not attempts[0]');
  if (summary.latest !== attempts[attempts.length - 1])
    out.push('latest is not last attempt');
  let previousMs = Number.NEGATIVE_INFINITY;
  let bestTenths = Number.NEGATIVE_INFINITY;
  let expectedBest = attempts[0];
  for (const attempt of attempts) {
    const ms = Date.parse(attempt.capturedAt);
    if (!Number.isFinite(ms))
      out.push(`attempt ${attempt.id} unparseable capturedAt`);
    if (ms < previousMs) out.push('attempts not chronological');
    previousMs = ms;
    if (ms > asOfMs) out.push('attempt after asOf');
    if (!Number.isFinite(attempt.overallScore))
      out.push('attempt overallScore not finite');
    for (const [key, value] of Object.entries(attempt.checkpointScores)) {
      if (!Number.isFinite(value))
        out.push(`checkpointScores[${key}] not finite`);
    }
    const tenths = scoreTenths(attempt.overallScore);
    if (tenths >= bestTenths) {
      bestTenths = tenths;
      expectedBest = attempt;
    }
  }
  if (summary.best !== expectedBest)
    out.push('best is not the max-tenths (ties → latest) attempt');
  const latest = attempts[attempts.length - 1];
  const first = attempts[0];
  if (latest && first) {
    const expectedDelta =
      scoreTenths(latest.overallScore) - scoreTenths(first.overallScore);
    if (
      !Object.is(summary.deltaTenths, expectedDelta) &&
      summary.deltaTenths !== expectedDelta
    ) {
      out.push(`deltaTenths ${summary.deltaTenths} != ${expectedDelta}`);
    }
    if (!Number.isFinite(summary.deltaTenths))
      out.push('deltaTenths not finite');
    if (!Number.isSafeInteger(summary.deltaTenths))
      out.push('deltaTenths not an integer');
    const expectedTrend =
      summary.deltaTenths >= PRACTICE_SET_TREND_THRESHOLD_TENTHS
        ? 'improved'
        : summary.deltaTenths <= -PRACTICE_SET_TREND_THRESHOLD_TENTHS
          ? 'slipped'
          : 'held';
    if (summary.trend !== expectedTrend)
      out.push(`trend ${summary.trend} != ${expectedTrend}`);
    const expectedFixed = Object.entries(first.checkpointScores)
      .filter(([key, before]) => {
        const after = latest.checkpointScores[key];
        return (
          after !== undefined &&
          before < FIXED_CHECKPOINT_FROM_BELOW &&
          after >= FIXED_CHECKPOINT_TO_AT_LEAST
        );
      })
      .map(([key]) => key);
    if (
      JSON.stringify(summary.fixedCheckpoints) !== JSON.stringify(expectedFixed)
    )
      out.push('fixedCheckpoints mismatch');
    if (
      JSON.stringify(fixedCheckpointsBetween(first, latest)) !==
      JSON.stringify(expectedFixed)
    ) {
      out.push('fixedCheckpointsBetween mismatch');
    }
    if (
      summary.startedAt !== first.capturedAt ||
      summary.endedAt !== latest.capturedAt
    )
      out.push('startedAt/endedAt');
    const endedMs = Date.parse(summary.endedAt);
    if (asOfMs - endedMs > maxAgeMs) out.push('set outside the max-age window');
    if (summary.stillOpen !== latest.priorityCheckpoint)
      out.push('stillOpen != latest.priorityCheckpoint');
  }
  if (!Number.isSafeInteger(summary.excludedCount) || summary.excludedCount < 0)
    out.push('excludedCount');
  if (summary.sessionId === '') out.push('empty sessionId summarized');
  return out.map(violation => `${summaryTag(summary)} ${violation}`);
}

/** `set=<id> scores=[…]` — enough to replay a violation by hand. */
function summaryTag(summary: PracticeSetSummary): string {
  const scores = summary.attempts.map(attempt =>
    Object.is(attempt.overallScore, -0) ? '-0' : String(attempt.overallScore),
  );
  return `set=${JSON.stringify(describe80(summary.sessionId))} scores=[${scores.join(',')}]`;
}

function copyViolations(summary: PracticeSetSummary): string[] {
  const out: string[] = [];
  const headline = practiceSetHeadline(summary);
  const insight = practiceSetInsight(summary);
  if (BAD_TEXT.test(headline))
    out.push(`${summaryTag(summary)} headline leaks: ${headline.slice(0, 80)}`);
  if (BAD_TEXT.test(insight))
    out.push(`${summaryTag(summary)} insight leaks: ${insight.slice(0, 80)}`);
  if (summary.trend === 'held' && headline !== 'Held steady in this set')
    out.push('held headline');
  if (summary.trend !== 'held') {
    const expected = `${formatTenthsDelta(summary.deltaTenths)} in this set`;
    if (headline !== expected) out.push('delta headline');
    if (summary.deltaTenths < 0 && !headline.startsWith('\u2212'))
      out.push('negative delta without U+2212');
    if (headline.startsWith('-')) out.push('hyphen-minus in headline');
  }
  if (!insight.startsWith(`${summary.attempts.length} attempt`))
    out.push('insight count clause');
  if (!insight.includes(`best ${summary.best.overallScore.toFixed(1)}`))
    out.push('insight best clause');
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      sameValue(leftKeys, rightKeys) &&
      leftKeys.every(key => sameValue(left[key], right[key]))
    );
  }
  return false;
}

function protoSnapshot(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype).sort(),
    Object.getOwnPropertyNames(Array.prototype).sort(),
    Object.getOwnPropertyNames(Function.prototype).sort(),
  ]);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Outcome {
  seed: number;
  asOfIso: string;
  maxAgeMs: string;
  payloadCount: number;
  factCount: number;
  shapes: Record<string, number>;
  oracle: 'valid' | 'invalid';
  latest: 'summary' | 'null' | 'rejected_typed' | 'escaped';
  message?: string;
  minimized?: string;
  referenceSession: string | null;
  chosenSession: string | null;
  /** overallScore of every attempt in the chosen summary (minimization aid). */
  summaryScores: number[] | null;
  violations: string[];
  deterministic: boolean;
  orderIndependent: boolean;
  inputsMutated: boolean;
  prototypePolluted: boolean;
  class:
    | 'ok'
    | 'rejected'
    | 'escaped_error'
    | 'invariant_violation'
    | 'over_reject'
    | 'under_reject';
}

function describe80(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…(${value.length})` : value;
}

function escapeMessage(run: () => void): string | null {
  try {
    run();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return DOCUMENTED_ERRORS.includes(message)
      ? null
      : `${error instanceof Error ? error.name : 'throw'}: ${message}`;
  }
}

function exerciseAll(
  facts: readonly RealAnalysisFact[],
  asOfIso: string,
  maxAgeMs: number | undefined,
  sessionIds: readonly string[],
): void {
  const summary = latestPracticeSet(
    facts,
    maxAgeMs === undefined ? { asOfIso } : { asOfIso, maxAgeMs },
  );
  if (summary) {
    practiceSetHeadline(summary);
    practiceSetInsight(summary);
  }
  for (const sessionId of sessionIds) {
    const direct = summarizePracticeSet(facts, sessionId);
    if (direct) {
      practiceSetHeadline(direct);
      practiceSetInsight(direct);
    }
  }
}

function minimizeEscape(
  facts: readonly RealAnalysisFact[],
  asOfIso: string,
  maxAgeMs: number | undefined,
  sessionIds: readonly string[],
): string {
  const optionsOnly = escapeMessage(() =>
    exerciseAll([], asOfIso, maxAgeMs, sessionIds),
  );
  if (optionsOnly)
    return `options-only asOfIso=${JSON.stringify(describe80(asOfIso))} maxAgeMs=${String(maxAgeMs)} → ${optionsOnly}`;
  // Pairs: a summary needs two comparable facts, so try every pair.
  for (let a = 0; a < facts.length; a += 1) {
    for (let b = a + 1; b < facts.length; b += 1) {
      const pair = [facts[a] as RealAnalysisFact, facts[b] as RealAnalysisFact];
      const message = escapeMessage(() =>
        exerciseAll(pair, asOfIso, maxAgeMs, sessionIds),
      );
      if (message) {
        return `pair sessionId=${JSON.stringify(describe80(String(pair[0]?.sessionId)))} priority=${JSON.stringify(describe80(String(pair[1]?.priorityCheckpoint)))}/${JSON.stringify(describe80(String(pair[0]?.priorityCheckpoint)))} scores=${String(pair[0]?.overallScore)},${String(pair[1]?.overallScore)} checkpointKeys=${JSON.stringify(
          Object.keys(pair[0]?.checkpointScores ?? {})
            .concat(Object.keys(pair[1]?.checkpointScores ?? {}))
            .map(describe80),
        )} → ${message}`;
      }
    }
  }
  return 'needs-more-than-two-facts';
}

async function runIteration(seed: number): Promise<Outcome> {
  const rng = new Rng(seed);
  const drawn = draw(rng);
  const rows = drawn.payloads.map(payload => ({ payload }));
  const facts = await listRealAnalysisFacts(fakeDb(rows), null);
  const shapes: Record<string, number> = {};
  for (const shape of drawn.shapes) shapes[shape] = (shapes[shape] ?? 0) + 1;

  const inputSnapshot = JSON.stringify(facts);
  const protoBefore = protoSnapshot();
  const valid = optionsValid(drawn.asOfIso, drawn.maxAgeMs);
  const asOfMs = Date.parse(drawn.asOfIso);
  const effectiveMaxAge = drawn.maxAgeMs ?? 24 * 60 * 60_000;
  const options =
    drawn.maxAgeMs === undefined
      ? { asOfIso: drawn.asOfIso }
      : { asOfIso: drawn.asOfIso, maxAgeMs: drawn.maxAgeMs };

  let latest: Outcome['latest'];
  let message: string | undefined;
  let summary: PracticeSetSummary | null = null;
  try {
    summary = latestPracticeSet(facts, options);
    latest = summary ? 'summary' : 'null';
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    latest =
      error instanceof Error && DOCUMENTED_ERRORS.includes(text)
        ? 'rejected_typed'
        : 'escaped';
    message = error instanceof Error ? `${error.name}: ${text}` : text;
  }

  const violations: string[] = [];
  let deterministic = true;
  let orderIndependent = true;
  let reference: { sessionId: string; attempts: number } | null = null;
  if (latest === 'summary' || latest === 'null') {
    reference = referenceChoice(facts, asOfMs, effectiveMaxAge);
    if ((reference === null) !== (summary === null)) {
      violations.push(
        `reference ${reference ? 'expects' : 'expects no'} summary, module returned ${summary ? 'one' : 'null'}`,
      );
    } else if (reference && summary) {
      if (reference.sessionId !== summary.sessionId)
        violations.push('module chose a different session than reference');
      if (reference.attempts !== summary.attempts.length)
        violations.push(
          `attempt count ${summary.attempts.length} != reference ${reference.attempts}`,
        );
    }
    if (summary) {
      violations.push(...summaryViolations(summary, asOfMs, effectiveMaxAge));
      const copyEscape = escapeMessage(() =>
        violations.push(...copyViolations(summary as PracticeSetSummary)),
      );
      if (copyEscape) {
        latest = 'escaped';
        message = copyEscape;
      }
    }
    // Direct summaries for every drawn session id (including hostile ones).
    for (const sessionId of drawn.sessionIds) {
      const directEscape = escapeMessage(() => {
        const direct = summarizePracticeSet(facts, sessionId);
        if (direct) {
          if (direct.sessionId !== sessionId)
            violations.push('direct summary sessionId echo');
          violations.push(
            ...summaryViolations(
              direct,
              Number.POSITIVE_INFINITY,
              Number.POSITIVE_INFINITY,
            ),
          );
          violations.push(...copyViolations(direct));
        }
      });
      if (directEscape) {
        latest = 'escaped';
        message = directEscape;
      }
    }
    try {
      deterministic = sameValue(summary, latestPracticeSet(facts, options));
      orderIndependent = sameValue(
        summary,
        latestPracticeSet(rng.shuffle(facts), options),
      );
    } catch (error) {
      violations.push(
        `re-run threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  let minimized: string | undefined;
  if (latest === 'escaped')
    minimized = minimizeEscape(
      facts,
      drawn.asOfIso,
      drawn.maxAgeMs,
      drawn.sessionIds,
    );

  const inputsMutated = JSON.stringify(facts) !== inputSnapshot;
  const prototypePolluted =
    protoSnapshot() !== protoBefore ||
    ({} as Record<string, unknown>)['polluted'] !== undefined;

  let cls: Outcome['class'];
  if (latest === 'escaped') cls = 'escaped_error';
  else if (latest === 'rejected_typed')
    cls = valid ? 'over_reject' : 'rejected';
  else if (!valid) cls = 'under_reject';
  else if (
    violations.length > 0 ||
    !deterministic ||
    !orderIndependent ||
    inputsMutated ||
    prototypePolluted
  )
    cls = 'invariant_violation';
  else cls = 'ok';
  if (cls === 'rejected' && (inputsMutated || prototypePolluted))
    cls = 'invariant_violation';

  return {
    seed,
    asOfIso: describe80(drawn.asOfIso),
    maxAgeMs: Object.is(drawn.maxAgeMs, -0) ? '-0' : String(drawn.maxAgeMs),
    payloadCount: drawn.payloads.length,
    factCount: facts.length,
    shapes,
    oracle: valid ? 'valid' : 'invalid',
    latest,
    message,
    minimized,
    referenceSession: reference ? describe80(reference.sessionId) : null,
    chosenSession: summary ? describe80(summary.sessionId) : null,
    summaryScores: summary
      ? summary.attempts.map(attempt => attempt.overallScore)
      : null,
    violations,
    deterministic,
    orderIndependent,
    inputsMutated,
    prototypePolluted,
    class: cls,
  };
}

const outcomes: Outcome[] = [];

/** Direct probes of the copy helper with every hostile checkpoint key. */
function checkpointPhraseProbes(): string[] {
  const failures: string[] = [];
  for (const key of HOSTILE_KEYS) {
    const escape = escapeMessage(() => {
      const phrase = checkpointPhrase(key);
      if (typeof phrase !== 'string')
        failures.push(
          `checkpointPhrase(${JSON.stringify(describe80(key))}) returned ${typeof phrase}`,
        );
    });
    if (escape)
      failures.push(
        `checkpointPhrase(${JSON.stringify(describe80(key))}) ${escape}`,
      );
  }
  return failures;
}

beforeAll(async () => {
  setActiveDataOwner(OWNER);
  for (const seed of iterationSeeds()) {
    outcomes.push(await runIteration(seed));
  }
  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true });
    const counts: Record<string, number> = {};
    for (const outcome of outcomes)
      counts[outcome.class] = (counts[outcome.class] ?? 0) + 1;
    writeFileSync(
      join(OUT_DIR, 'practiceSetProgress.boundaryMalformed.json'),
      JSON.stringify(
        {
          unit: 'progress/practiceSetProgress via data/repository.listRealAnalysisFacts',
          lens: 'boundary-malformed',
          baseSeed: BASE_SEED,
          iterations: outcomes.length,
          counts,
          checkpointPhraseProbes: checkpointPhraseProbes(),
          outcomes,
        },
        null,
        2,
      ),
    );
  }
}, 600_000);

function seedsOf(predicate: (outcome: Outcome) => boolean): string[] {
  return outcomes
    .filter(predicate)
    .map(
      outcome =>
        `${outcome.seed}:asOf=${outcome.asOfIso}:maxAge=${outcome.maxAgeMs}:scores=${JSON.stringify(outcome.summaryScores)}:${outcome.minimized ?? outcome.message ?? outcome.violations.slice(0, 3).join('|')}`,
    );
}

describe('practice set boundary/malformed campaign', () => {
  it('ran every scheduled iteration', () => {
    expect(outcomes.length).toBe(iterationSeeds().length);
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('never throws anything but the documented option errors (summaries, headline, insight, phrases)', () => {
    expect(seedsOf(outcome => outcome.class === 'escaped_error')).toEqual([]);
  });

  it('checkpointPhrase returns a string for every hostile key (prototype names, empty, null byte, 64KiB+)', () => {
    expect(checkpointPhraseProbes()).toEqual([]);
  });

  it('refuses every invalid option set with a documented error and accepts every valid one', () => {
    expect(seedsOf(outcome => outcome.class === 'under_reject')).toEqual([]);
    expect(seedsOf(outcome => outcome.class === 'over_reject')).toEqual([]);
  });

  it('summarizes exactly the set the reference derivation expects, with exact tenths arithmetic', () => {
    expect(seedsOf(outcome => outcome.class === 'invariant_violation')).toEqual(
      [],
    );
  });

  it('is deterministic and independent of fact order', () => {
    expect(
      seedsOf(outcome => !outcome.deterministic || !outcome.orderIndependent),
    ).toEqual([]);
  });

  it('never mutates its inputs or any prototype', () => {
    expect(
      seedsOf(outcome => outcome.inputsMutated || outcome.prototypePolluted),
    ).toEqual([]);
  });

  it('covers every required malformed category at least once', () => {
    const shapes = new Set(
      outcomes.flatMap(outcome => Object.keys(outcome.shapes)),
    );
    for (const needle of [
      'truncatedJson',
      'replacedJson',
      'prototypeKeys',
      'futureSchema',
      'hugeStringField',
      'duplicateOverallScore',
      'sessionIdWrongType',
      'capturedAtWrongType',
      'wellFormed',
    ]) {
      expect(shapes.has(needle)).toBe(true);
    }
    expect(outcomes.some(outcome => outcome.latest === 'summary')).toBe(true);
    expect(outcomes.some(outcome => outcome.oracle === 'invalid')).toBe(true);
  });
});
