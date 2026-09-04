/**
 * STRESS — ProgressScreen · lens `boundary-i18n-a11y`.
 *
 * Renders the REAL ProgressScreen inside the real SafeAreaProvider →
 * NavigationContainer → native stack → bottom tabs (with the app's own
 * PremiumTabBar) on top of the real db/repository/stores, with a real
 * in-memory SQLite (node:sqlite) standing in for the op-sqlite native module.
 * Only native modules (op-sqlite, safe-area-context) and `fetch` are faked.
 *
 * Every variant is derived from ONE seed (mulberry32) and is replayable:
 *   STRESS_SEED=<seed> STRESS_ITER=1 npx jest --ci __tests__/stress/progressScreenBoundaryI18nA11y
 * Campaign scale is controlled by STRESS_ITER (default keeps the suite fast).
 * Locale and time zone are process-level facts (LANG / TZ must be set before
 * node starts); the harness records what it actually observed. The 12-locale
 * × 8-time-zone campaign is driven by ./progressScreenMatrix.runner.mjs, which
 * launches one jest process per cell.
 * STRESS_OUT=<path.json> writes the seed → outcome table (plus rendered-tree
 * evidence for every failing seed next to it).
 */
import React from 'react';
import { Dimensions, I18nManager } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as {
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
};
const pathMod = require('path') as {
  resolve(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string, ext?: string): string;
};

/** The one in-memory database the production db layer talks to. `failing`
 * makes every statement throw so the screen's ErrorState path is exercised. */
const mockSqlite: { real: DatabaseSync; failing: boolean } = {
  real: new DatabaseSync(':memory:'),
  failing: false,
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const run = (sql: string, params: unknown[] = []) => {
      if (mockSqlite.failing) throw new Error('stress: sqlite io failure');
      return {
        rows: mockSqlite.real
          .prepare(sql)
          .all(...(params as (string | number | null)[])),
      };
    };
    return {
      executeSync: run,
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => {},
    };
  },
}));
jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      require('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

import {
  createNavigationContainerRef,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SHOT_TYPES } from '@pickle/shared-types';
import { ProgressScreen } from '../../src/screens/ProgressScreen';
import { PremiumTabBar } from '../../src/navigation/PremiumTabBar';
import type {
  MainTabParams,
  RootStackParams,
} from '../../src/navigation/params';
import { getDb } from '../../src/data/db';
import {
  canonicalDataOwner,
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { listCaptureHistory } from '../../src/data/repository';
import { useAppStore } from '../../src/state/appStore';
import {
  consistencyKeyForOwner,
  useConsistencyStore,
} from '../../src/consistency/store';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

// ─── seeded RNG ─────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float() {
    return this.next();
  }
  int(maxExclusive: number) {
    return Math.floor(this.next() * maxExclusive);
  }
  chance(p: number) {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

// ─── hostile corpus ─────────────────────────────────────────────────────────

const HOSTILE_STRINGS: Record<string, string> = {
  long_latin: 'Long_technique_checkpoint_name_'.repeat(8),
  cjk_ja:
    '肘の高さを一定に保ちながらパドルを前方へ運ぶ動作の反復練習と接触位置の安定化'.repeat(
      4,
    ),
  cjk_zh: '击球前准备姿势保持稍蹲身体重心前移手腕固定'.repeat(6),
  arabic_rtl:
    'تمرين ثابت على مستوى الكوع مع تثبيت المعصم أثناء الضربة ١٢٣٤٥ '.repeat(4),
  hebrew_rtl: 'שמירה על גובה המרפק במהלך תנועת המחבט ',
  zwj_emoji: '👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🦽🧑🏿‍🤝‍🧑🏻🫱🏼‍🫲🏾'.repeat(4),
  combining:
    'c\u0327\u0301o\u0308\u0304m\u0301b\u0323i\u0307\u0301n\u0303i\u0308n\u0329g\u0300\u0301\u0302\u0303'.repeat(
      8,
    ),
  german_compound:
    'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz Donaudampfschifffahrtsgesellschaftskapitänswitwe',
  thai_no_spaces:
    'การฝึกซ้อมท่าทางการตีลูกให้มีความสม่ำเสมอโดยรักษาระดับข้อศอกให้คงที่'.repeat(
      3,
    ),
  hindi:
    'कोहनी की ऊँचाई स्थिर रखते हुए पैडल को आगे की ओर ले जाने का अभ्यास '.repeat(
      3,
    ),
  turkish_dotless: 'ıİşğüçöIiIİ ıIİi diyarbakır ISPARTA',
  bidi_controls: 'left\u202Eright\u202C \u2066iso\u2069 \u200F\u200E mixed 123',
  control_chars: 'tab\tnl\ncr\rnull\u0000bell\u0007',
  whitespace_only: '   \u3000\u00a0  ',
  empty: '',
  format_tokens: '%s %d {0} ${x} \\n <b>%1$s</b>',
  html_script: '<script>alert(1)</script><img src=x onerror=alert(1)>',
  numeric_looking: 'NaN',
  extreme_ascii: '!'.repeat(260),
};
const HOSTILE_VALUES = Object.values(HOSTILE_STRINGS);
const HOSTILE_KEYS = Object.keys(HOSTILE_STRINGS);

const HOSTILE_NUMBERS = [
  0,
  -0,
  -1,
  -5,
  11,
  10.0000001,
  100,
  -1e9,
  1e21,
  1e308,
  Number.MAX_SAFE_INTEGER + 2,
  1e-7,
  0.1 + 0.2,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE,
  5.55,
  7,
] as const;

const DST_EDGE_INSTANTS = [
  '2026-03-08T09:59:59.000Z', // US spring-forward (PST) -1s
  '2026-03-08T10:00:00.000Z', // US spring-forward
  '2026-11-01T08:59:59.000Z', // US fall-back (PDT) -1s
  '2026-11-01T09:00:00.000Z',
  '2026-03-29T00:59:59.000Z', // EU spring-forward -1s
  '2026-03-29T01:00:00.000Z',
  '2026-10-25T00:59:59.000Z', // EU fall-back -1s
  '2026-10-25T01:00:00.000Z',
  '2026-04-05T15:59:59.000Z', // AU (Sydney) fall-back -1s
  '2026-10-04T16:00:00.000Z', // AU spring-forward
  '2026-09-27T14:00:00.000Z', // NZ / Chatham spring-forward
];

const WEIRD_TIMESTAMPS = [
  '1970-01-01T00:00:00.000Z',
  '0001-01-01T00:00:00.000Z',
  '9999-12-31T23:59:59.999Z',
  '2028-02-29T12:00:00.000Z',
  '2026-09-04T12:00:00+14:00',
  '2026-09-04T12:00:00-12:00',
  '2026-09-04', // date-only → UTC midnight
  '2026-09-04T12:00:00', // zone-less → local
  '2026-12-31T23:59:59.999Z',
  '2027-01-01T00:00:00.000Z',
];
const CORRUPT_TIMESTAMPS = [
  'not-a-date',
  '',
  '2026-13-45T99:99:99Z',
  '1700000000000',
  'null',
  'Thu, 01 Jan 1970',
];

/** Fixed "now" instants; DST / year boundaries included so the day-key math
 * runs against them under every TZ the campaign is launched with. */
const NOW_INSTANTS = [
  '2026-09-04T23:10:00.000Z',
  '2026-03-08T10:00:00.000Z',
  '2026-11-01T09:00:00.000Z',
  '2026-03-29T01:00:00.000Z',
  '2026-10-25T01:00:00.000Z',
  '2026-12-31T23:59:59.000Z',
  '2027-01-01T00:00:00.000Z',
  '2028-02-29T12:00:00.000Z',
];

const WIDTHS = [320, 375, 430] as const;
const FONT_SCALES = [1, 1.235, 2.35] as const;

// ─── variant model ──────────────────────────────────────────────────────────

interface Variant {
  seed: number;
  width: number;
  fontScale: number;
  rtl: boolean;
  nowIso: string;
  signedIn: boolean;
  dbFailsFirstLoad: boolean;
  profileSkillLevel: string | null;
  factCount: number;
  captureCount: number;
  corruptFactCount: number;
  corruptCaptureCount: number;
  legacyCaptureCount: number;
  hostileKeys: string[];
  progressResponse:
    | 'valid'
    | 'hostile'
    | 'duplicate_checkpoints'
    | 'http_500'
    | 'network_error'
    | 'invalid_json'
    | 'nan_payload';
  rankResponse: 'valid' | 'hostile' | 'null_rank' | 'http_500';
  drillCount: number;
}

function buildVariant(seed: number, index: number): Variant {
  const rng = new Rng(seed);
  const hostileKeys = rng.shuffle(HOSTILE_KEYS).slice(0, 3 + rng.int(4));
  // Seed-derived so that any contiguous seed range walks the 3×3 grid;
  // `index` keeps a short campaign from repeating a cell.
  const grid = (seed + index) % 9;
  return {
    seed,
    width: WIDTHS[grid % 3]!,
    fontScale: FONT_SCALES[Math.floor(grid / 3)]!,
    rtl: rng.chance(0.3),
    nowIso: rng.pick(NOW_INSTANTS),
    signedIn: rng.chance(0.6),
    dbFailsFirstLoad: rng.chance(0.1),
    profileSkillLevel: rng.chance(0.2)
      ? null
      : HOSTILE_STRINGS[rng.pick(hostileKeys)]!,
    factCount: rng.pick([0, 1, 2, 6, 25, 80]),
    captureCount: rng.pick([0, 1, 3, 12, 40]),
    corruptFactCount: rng.pick([0, 0, 1, 3]),
    corruptCaptureCount: rng.pick([0, 0, 1, 2]),
    legacyCaptureCount: rng.pick([0, 0, 1]),
    hostileKeys,
    progressResponse: rng.pick([
      'valid',
      'valid',
      'hostile',
      'hostile',
      'duplicate_checkpoints',
      'http_500',
      'network_error',
      'invalid_json',
      'nan_payload',
    ]),
    rankResponse: rng.pick([
      'valid',
      'valid',
      'hostile',
      'null_rank',
      'http_500',
    ]),
    drillCount: rng.pick([0, 0, 1, 4, 30]),
  };
}

// ─── data seeding (real schema via the production db layer) ────────────────

const ANALYSIS_CHECKPOINTS = [
  'preparation',
  'paddle_set',
  'contact_position',
  'sequencing',
  'follow_through',
  'balance',
];

function hostile(rng: Rng, variant: Variant): string {
  return HOSTILE_STRINGS[rng.pick(variant.hostileKeys)]!;
}

function isoDaysBefore(nowIso: string, days: number, hours: number) {
  const t = Date.parse(nowIso) - days * 86_400_000 - hours * 3_600_000;
  return new Date(t).toISOString();
}

function pickTimestamp(rng: Rng, variant: Variant): string {
  const roll = rng.float();
  if (roll < 0.6) {
    return isoDaysBefore(variant.nowIso, rng.int(120), rng.int(24));
  }
  if (roll < 0.75) return rng.pick(DST_EDGE_INSTANTS);
  if (roll < 0.9) return rng.pick(WEIRD_TIMESTAMPS);
  return isoDaysBefore(variant.nowIso, -rng.int(3), rng.int(24)); // future
}

function pickScore(rng: Rng): number | null {
  if (rng.chance(0.15)) return null;
  if (rng.chance(0.3)) return rng.pick(HOSTILE_NUMBERS);
  return Math.round(rng.float() * 100) / 10;
}

function shotTypeFor(rng: Rng, variant: Variant): string {
  return rng.chance(0.8) ? rng.pick(SHOT_TYPES) : hostile(rng, variant);
}

function analysisPayload(
  rng: Rng,
  variant: Variant,
  id: string,
  capturedAtIso: string,
) {
  const shotType = shotTypeFor(rng, variant);
  const resultKind = rng.chance(0.8) ? 'scored' : 'low_confidence';
  const overallScore = resultKind === 'scored' ? pickScore(rng) : null;
  const checkpoints = ANALYSIS_CHECKPOINTS.map(key => ({
    key: rng.chance(0.1) ? hostile(rng, variant) : key,
    applicable: rng.chance(0.85),
    score: pickScore(rng),
  }));
  return {
    id,
    sessionId: rng.chance(0.5) ? null : hostile(rng, variant),
    shotType,
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 0, contactMs: 500, endMs: 1200 },
    phases: [],
    measurements: [],
    checkpoints,
    overallScore,
    analysisConfidence: rng.chance(0.2)
      ? rng.pick(HOSTILE_NUMBERS)
      : Math.round(rng.float() * 100) / 100,
    resultKind,
    guidance: rng.chance(0.3) ? hostile(rng, variant) : null,
    priorityFix: rng.chance(0.5)
      ? {
          checkpoint: rng.chance(0.3)
            ? hostile(rng, variant)
            : rng.pick(ANALYSIS_CHECKPOINTS),
          message: hostile(rng, variant),
        }
      : null,
    versionVector: {
      scoringModelVersion: rng.chance(0.2) ? hostile(rng, variant) : 'model-2',
      shotConfigVersion: rng.chance(0.2) ? hostile(rng, variant) : 'config-1',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
    source: 'real',
  };
}

function captureClip(
  rng: Rng,
  variant: Variant,
  id: string,
  capturedAtIso: string,
) {
  const imported = rng.chance(0.4);
  const durationMs = rng.pick([1_900, 3_000, 3_900, 60_000, 1e12]);
  const fps = rng.pick([0, 24, 30, 60, 240, 1e6]);
  const width = rng.pick([1, 1_080, 3_840, 1e9]);
  const height = rng.pick([1, 1_920, 2_160, 1e9]);
  const uri = `file:///captures/${id}.mov`;
  const base = { uri, capturedAtIso, durationMs, fps, width, height };
  const recognized = rng.chance(0.4);
  const recognition = recognized
    ? {
        status: 'recognized',
        shotType: rng.pick(SHOT_TYPES),
        confidence: 0.5 + rng.float() * 0.5,
        modelVersion: rng.chance(0.3) ? hostile(rng, variant) || 'm' : 'clf-1',
      }
    : {
        status: rng.chance(0.5) ? 'unknown' : 'abstained',
        reason: hostile(rng, variant) || 'validated_classifier_unavailable',
      };
  const declaredStroke = rng.chance(0.5)
    ? rng.pick(SHOT_TYPES)
    : rng.chance(0.5)
      ? hostile(rng, variant)
      : null;
  const clip = imported
    ? {
        ...base,
        captureMode: 'imported_video',
        recognition: recognized
          ? recognition
          : { status: 'unknown', reason: 'analysis_not_run' },
        ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
        ...(rng.chance(0.7)
          ? {
              poseSequence: {
                schemaVersion: 1,
                format: 'pickle.pose-sequence.v1',
                uri: `file:///captures/${id}.pose.json`,
                frameCount: rng.pick([1, 117, 1e9]),
                sha256: 'c'.repeat(64),
                coordinateSystem: 'normalized_image_top_left',
                poseModelVersion: 'apple-vision-bodypose-1',
              },
            }
          : {}),
      }
    : {
        ...base,
        captureMode: 'automatic_pose_trigger',
        recognition,
        trigger: {
          startMs: 1_000,
          endMs: 1_800,
          peakMotionMs: 1_500,
          confidence: 0.82,
          source: 'temporal_pose_motion',
          modelVersion: 'temporal-stroke-heuristic-2',
        },
        captureEvidence: {
          schemaVersion: 1,
          window: 'detected_motion',
          poseSource: 'apple_vision_body_pose',
          poseModelVersion: 'apple-vision-bodypose-1',
          triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
          motionUnit: 'normalized_image_units_per_second',
          poseFrameCount: 4,
          poseMissingFrameCount: 1,
          analysisInputFrameCount: 5,
          trackedDurationMs: 300,
          meanCanonicalJointVisibility: 0.8,
          meanJointCoverage: 0.75,
          minimumJointCoverage: 0.6,
          fullBodyVisibleFrameCount: 2,
          jointMotion: [
            {
              joint: 'right_wrist',
              sampleCount: 2,
              meanNormalizedPerSecond: 0.8,
              peakNormalizedPerSecond: 1.2,
            },
          ],
        },
        ballSpeed: {
          status: 'unavailable',
          reason: 'calibrated_ball_tracker_unavailable',
        },
        preRollMs: 1_000,
        postRollMs: 100,
      };
  return { ...base, declaredStroke, clip };
}

function sqlRun(sql: string, params: (string | number | null)[]) {
  mockSqlite.real.prepare(sql).all(...params);
}

const TABLES_TO_WIPE = [
  'local_shot',
  'local_capture',
  'local_session',
  'local_analysis_record',
  'kv',
];

function wipeDatabase() {
  const tables = mockSqlite.real
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(row => String(row['name']));
  for (const table of TABLES_TO_WIPE) {
    if (tables.includes(table)) mockSqlite.real.exec(`DELETE FROM ${table}`);
  }
}

interface SeedSummary {
  ownerKey: string;
  validCaptures: number;
  insertedFacts: number;
  insertedCaptures: number;
  /** captured_at of every non-corrupt capture row, for replaying failures. */
  captureTimestamps: string[];
}

function userIdFor(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0').slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
}

async function seedDatabase(rng: Rng, variant: Variant): Promise<SeedSummary> {
  const ownerKey = variant.signedIn
    ? canonicalDataOwner(userIdFor(variant.seed))
    : GUEST_DATA_OWNER;
  setActiveDataOwner(ownerKey);
  getDb(); // runs the production migrations against the in-memory database
  wipeDatabase();

  let insertedFacts = 0;
  for (let i = 0; i < variant.factCount; i += 1) {
    const id = `fact-${variant.seed}-${i}`;
    const capturedAt = pickTimestamp(rng, variant);
    const payload = analysisPayload(rng, variant, id, capturedAt);
    sqlRun(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'real', 0, ?)`,
      [
        ownerKey,
        id,
        payload.sessionId,
        payload.shotType,
        capturedAt,
        payload.overallScore,
        payload.analysisConfidence,
        payload.resultKind,
        JSON.stringify(payload),
      ],
    );
    insertedFacts += 1;
  }
  for (let i = 0; i < variant.corruptFactCount; i += 1) {
    const id = `fact-corrupt-${variant.seed}-${i}`;
    const capturedAt = rng.pick(CORRUPT_TIMESTAMPS);
    const payload = rng.pick([
      '{not json',
      'null',
      '[]',
      JSON.stringify({ id, shotType: 'dink', overallScore: 'seven' }),
      JSON.stringify({
        ...analysisPayload(rng, variant, id, capturedAt),
        capturedAtIso: capturedAt,
      }),
    ]);
    sqlRun(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, ?, NULL, 'dink', ?, 7, 0.9, 'scored', 'real', 0, ?)`,
      [ownerKey, id, capturedAt, payload],
    );
  }

  let insertedCaptures = 0;
  const captureTimestamps: string[] = [];
  for (let i = 0; i < variant.captureCount; i += 1) {
    const id = `cap-${variant.seed}-${i}`;
    const capturedAt = pickTimestamp(rng, variant);
    captureTimestamps.push(capturedAt);
    const row = captureClip(rng, variant, id, capturedAt);
    sqlRun(
      `INSERT INTO local_capture (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
       VALUES (?, ?, ?, 'unrecognized', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ownerKey,
        id,
        row.uri,
        row.declaredStroke,
        capturedAt,
        row.durationMs,
        row.fps,
        row.width,
        row.height,
        rng.chance(0.8) ? 'analyzed' : 'awaiting_model',
        JSON.stringify(row.clip),
      ],
    );
    insertedCaptures += 1;
  }
  for (let i = 0; i < variant.corruptCaptureCount; i += 1) {
    const id = `cap-corrupt-${variant.seed}-${i}`;
    const capturedAt = rng.pick(CORRUPT_TIMESTAMPS);
    sqlRun(
      `INSERT INTO local_capture (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
       VALUES (?, ?, ?, 'unrecognized', ?, ?, ?, ?, ?, ?, 'analyzed', ?)`,
      [
        ownerKey,
        id,
        `file:///captures/${id}.mov`,
        hostile(rng, variant),
        capturedAt,
        rng.pick([-1, 0, 1e21]),
        rng.pick([-30, 1e9]),
        rng.pick([0, -1]),
        0,
        rng.pick(['{broken', '[]', JSON.stringify({ captureMode: 'nope' })]),
      ],
    );
  }
  for (let i = 0; i < variant.legacyCaptureCount; i += 1) {
    const id = `cap-legacy-${variant.seed}-${i}`;
    sqlRun(
      `INSERT INTO local_capture (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
       VALUES (?, ?, ?, 'unrecognized', NULL, ?, 3000, 60, 1080, 1920, 'analyzed', NULL)`,
      [
        ownerKey,
        id,
        `file:///captures/${id}.mov`,
        isoDaysBefore(variant.nowIso, 3, 1),
      ],
    );
  }

  if (variant.drillCount > 0) {
    const drills = Array.from({ length: variant.drillCount }, (_, i) => ({
      id: `drill-${variant.seed}-${i}`,
      slug: rng.chance(0.3) ? hostile(rng, variant) : 'shadow-swing',
      title: hostile(rng, variant),
      completedAtIso: pickTimestamp(rng, variant),
    }));
    sqlRun('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)', [
      consistencyKeyForOwner(ownerKey),
      JSON.stringify({ version: 1, drills, celebrated: {} }),
    ]);
  }

  const validCaptures = (await listCaptureHistory(getDb(), null)).filter(
    entry => entry.evidenceStatus === 'valid',
  ).length;
  return {
    ownerKey,
    validCaptures,
    insertedFacts,
    insertedCaptures,
    captureTimestamps,
  };
}

// ─── fetch double (the ONLY network) ────────────────────────────────────────

interface FetchLog {
  calls: string[];
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function progressBody(rng: Rng, variant: Variant, dayKeys: string[]) {
  const mode = variant.progressResponse;
  const point = (hostileRow: boolean) => ({
    day:
      hostileRow && rng.chance(0.3) ? hostile(rng, variant) : rng.pick(dayKeys),
    shot_type: hostileRow ? shotTypeFor(rng, variant) : rng.pick(SHOT_TYPES),
    scoring_model_version: hostileRow ? hostile(rng, variant) : 'model-2',
    shot_count: hostileRow ? rng.pick(HOSTILE_NUMBERS) : 1 + rng.int(9),
    avg_score: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(101),
    best_score: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(101),
  });
  // A conforming server never repeats a checkpoint; only the hostile and
  // duplicate_checkpoints modes do.
  const trends = (hostileRow: boolean, key: 'delta' | 'avg') => {
    const n = rng.pick([0, 1, 2, 5]);
    const checkpoints = hostileRow
      ? Array.from({ length: n }, () => hostile(rng, variant))
      : rng.shuffle(ANALYSIS_CHECKPOINTS).slice(0, n);
    return checkpoints.map(checkpoint => ({
      checkpoint,
      [key]: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.float() * 2 - 1,
    }));
  };
  const hostileRow = mode === 'hostile' || mode === 'nan_payload';
  const count = rng.pick([0, 1, 5, 40]);
  const body = {
    series: Array.from({ length: count }, () => point(hostileRow)),
    improving: trends(hostileRow, 'delta'),
    needsAttention: trends(hostileRow, 'avg'),
    streak: {
      currentDays: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(400),
      longestDays: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(400),
      practicedToday: rng.chance(0.5),
      lastPracticeDate: rng.chance(0.3) ? null : rng.pick(dayKeys),
    },
  };
  if (mode === 'duplicate_checkpoints') {
    const dup = { checkpoint: 'preparation', delta: 0.4 };
    body.improving = [dup, { ...dup }, { ...dup, delta: 0.1 }];
    body.needsAttention = [
      { checkpoint: 'balance', avg: 4 },
      { checkpoint: 'balance', avg: 3 },
    ];
  }
  if (mode === 'nan_payload') {
    body.streak.currentDays = Number.NaN;
    body.series.push({ ...point(false), avg_score: Number.POSITIVE_INFINITY });
  }
  return body;
}

function rankBody(rng: Rng, variant: Variant) {
  if (variant.rankResponse === 'null_rank') return { rank: null };
  const hostileRow = variant.rankResponse === 'hostile';
  return {
    rank: {
      rating: hostileRow
        ? rng.pick([0, 10, 9.999, -0, 3.3333333])
        : rng.float() * 10,
      tier: hostileRow ? hostile(rng, variant) : 'bronze',
      techniqueCount: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(9),
      scoredShotCount: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.int(500),
      updatedAt: hostileRow ? hostile(rng, variant) : variant.nowIso,
      // The deployed rank view is `distinct on (shot_type)`; only the hostile
      // mode is allowed to repeat a technique.
      techniques: (hostileRow
        ? Array.from({ length: rng.pick([0, 1, 8, 20]) }, () =>
            shotTypeFor(rng, variant),
          )
        : rng.shuffle(SHOT_TYPES).slice(0, rng.pick([0, 1, SHOT_TYPES.length]))
      ).map(shotType => ({
        shot_type: shotType,
        score: hostileRow ? rng.pick(HOSTILE_NUMBERS) : rng.float() * 10,
        captured_at: hostileRow ? rng.pick(WEIRD_TIMESTAMPS) : variant.nowIso,
        sampled_count: hostileRow ? rng.pick(HOSTILE_NUMBERS) : 1 + rng.int(20),
      })),
    },
  };
}

function installFetch(rng: Rng, variant: Variant, log: FetchLog) {
  const dayKeys = Array.from({ length: 30 }, (_, i) =>
    isoDaysBefore(variant.nowIso, i, 0).slice(0, 10),
  );
  const fetchImpl = async (input: unknown): Promise<Response> => {
    const url = String(input);
    log.calls.push(url);
    if (url.endsWith('/v1/progress')) {
      switch (variant.progressResponse) {
        case 'http_500':
          return jsonResponse(500, { error: 'boom' });
        case 'network_error':
          throw new TypeError('Network request failed');
        case 'invalid_json':
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          } as unknown as Response;
        default:
          return jsonResponse(200, progressBody(rng, variant, dayKeys));
      }
    }
    if (url.endsWith('/v1/rank')) {
      if (variant.rankResponse === 'http_500') {
        return jsonResponse(500, { error: 'boom' });
      }
      return jsonResponse(200, rankBody(rng, variant));
    }
    return jsonResponse(404, { error: 'not found' });
  };
  (globalThis as { fetch: unknown }).fetch = fetchImpl;
}

// ─── rendered-tree inspection ───────────────────────────────────────────────

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface HostNode {
  type: string;
  props: Record<string, unknown>;
  children: (HostNode | string)[];
}

/** Host-only view of a test instance subtree (composites flattened away),
 * i.e. what the native layer would actually receive. */
function hostChildren(
  instance: TestRenderer.ReactTestInstance,
): (HostNode | string)[] {
  const out: (HostNode | string)[] = [];
  for (const child of instance.children) {
    if (typeof child === 'string') {
      out.push(child);
    } else if (typeof child.type === 'string') {
      out.push({
        type: child.type,
        props: child.props as Record<string, unknown>,
        children: hostChildren(child),
      });
    } else {
      out.push(...hostChildren(child));
    }
  }
  return out;
}

function flattenStyle(style: unknown): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, item) => ({ ...acc, ...flattenStyle(item) }),
      {},
    );
  }
  return typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Lower bound of a node's rendered height from explicit style facts:
 * height/minHeight, else vertical padding + stacked/side-by-side children
 * (Text = lineHeight × lines, fontScale 1). Unknown → null (unmeasurable). */
function estimateHeight(node: HostNode | string): number | null {
  if (typeof node === 'string') return null;
  const style = flattenStyle(node.props['style']);
  const fixed = num(style['height']) ?? num(style['minHeight']);
  if (fixed !== null) return fixed;
  if (node.type === 'Text') {
    const lineHeight = num(style['lineHeight']) ?? num(style['fontSize']);
    if (lineHeight === null) return null;
    const lines = num(node.props['numberOfLines']) ?? 1;
    return lineHeight * Math.max(1, lines);
  }
  const padding =
    (num(style['paddingTop']) ??
      num(style['paddingVertical']) ??
      num(style['padding']) ??
      0) +
    (num(style['paddingBottom']) ??
      num(style['paddingVertical']) ??
      num(style['padding']) ??
      0);
  const childHeights = node.children
    .map(estimateHeight)
    .filter((h): h is number => h !== null);
  if (childHeights.length === 0) return padding > 0 ? padding : null;
  const row =
    style['flexDirection'] === 'row' ||
    style['flexDirection'] === 'row-reverse';
  const gap = num(style['gap']) ?? num(style['rowGap']) ?? 0;
  const content = row
    ? Math.max(...childHeights)
    : childHeights.reduce((a, b) => a + b, 0) + gap * (childHeights.length - 1);
  return padding + content;
}

function estimateWidth(node: HostNode): number | null | 'stretch' {
  const style = flattenStyle(node.props['style']);
  const fixed = num(style['width']) ?? num(style['minWidth']);
  if (fixed !== null) return fixed;
  if (num(style['flex']) !== null || style['alignSelf'] === 'stretch')
    return 'stretch';
  return null;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'tab',
  'link',
  'switch',
  'checkbox',
  'radio',
  'menuitem',
  'adjustable',
  'togglebutton',
]);

interface InteractiveReport {
  path: string;
  role: string | null;
  label: string | null;
  textFallback: string;
  minHeight: number | null;
  width: number | null | 'stretch';
  hitSlop: number;
}

function textOf(node: HostNode | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(textOf).join('');
}

function collectInteractive(
  node: HostNode | string,
  path: string,
  out: InteractiveReport[],
  /** Set while inside a parent that already announced itself as one target. */
  ancestorIsTarget: boolean,
) {
  if (typeof node === 'string') return;
  const role =
    typeof node.props['accessibilityRole'] === 'string'
      ? (node.props['accessibilityRole'] as string)
      : null;
  const pressable =
    typeof node.props['onPress'] === 'function' ||
    typeof node.props['onClick'] === 'function' ||
    typeof node.props['onResponderRelease'] === 'function' ||
    typeof node.props['onStartShouldSetResponder'] === 'function';
  const isTarget = pressable || (role !== null && INTERACTIVE_ROLES.has(role));
  const disabled =
    node.props['accessibilityState'] !== null &&
    typeof node.props['accessibilityState'] === 'object' &&
    (node.props['accessibilityState'] as { disabled?: boolean }).disabled ===
      true;
  if (isTarget && !ancestorIsTarget && !disabled) {
    const hitSlopRaw = node.props['hitSlop'];
    const hitSlop =
      typeof hitSlopRaw === 'number'
        ? hitSlopRaw * 2
        : hitSlopRaw && typeof hitSlopRaw === 'object'
          ? (num((hitSlopRaw as Record<string, unknown>)['top']) ?? 0) +
            (num((hitSlopRaw as Record<string, unknown>)['bottom']) ?? 0)
          : 0;
    out.push({
      path,
      role,
      label:
        typeof node.props['accessibilityLabel'] === 'string'
          ? (node.props['accessibilityLabel'] as string)
          : null,
      textFallback: textOf(node).trim(),
      minHeight: estimateHeight(node),
      width: estimateWidth(node),
      hitSlop,
    });
  }
  node.children.forEach((child, i) =>
    collectInteractive(
      child,
      `${path}/${typeof child === 'string' ? '#text' : child.type}[${i}]`,
      out,
      ancestorIsTarget || isTarget,
    ),
  );
}

interface TextReport {
  strings: string[];
  truncatedCandidates: Array<{
    path: string;
    numberOfLines: number;
    length: number;
    sample: string;
  }>;
}

function collectText(node: HostNode | string, path: string, out: TextReport) {
  if (typeof node === 'string') {
    out.strings.push(node);
    return;
  }
  if (node.type === 'Text') {
    const lines = num(node.props['numberOfLines']);
    const text = textOf(node);
    if (lines !== null && text.length > 24 * lines) {
      out.truncatedCandidates.push({
        path,
        numberOfLines: lines,
        length: text.length,
        sample: text.slice(0, 60),
      });
    }
  }
  node.children.forEach((child, i) =>
    collectText(
      child,
      `${path}/${typeof child === 'string' ? '#text' : child.type}[${i}]`,
      out,
    ),
  );
}

/** User-visible text that is never a legitimate rendering of a score/date. */
const FORBIDDEN_TEXT =
  /\b(NaN|undefined|null|\[object Object\]|Infinity)\b|\d+e\+\d+|(^|[^\d.])-0(?![\d.])/;

function findProgressSubtree(
  renderer: TestRenderer.ReactTestRenderer,
): HostNode | null {
  const screen = renderer.root.findAllByType(ProgressScreen)[0];
  if (!screen) return null;
  return {
    type: 'ProgressScreenRoot',
    props: {},
    children: hostChildren(screen),
  };
}

// ─── harness ────────────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function Placeholder() {
  return null;
}

function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Performance"
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={Placeholder} />
      <Tabs.Screen name="Library" component={Placeholder} />
      <Tabs.Screen name="Add" component={Placeholder} />
      <Tabs.Screen name="Performance" component={ProgressScreen} />
      <Tabs.Screen name="Settings" component={Placeholder} />
    </Tabs.Navigator>
  );
}

function Harness() {
  return (
    <SafeAreaProvider>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Tabs" component={MainTabs} />
          <Stack.Screen name="StreakCalendar" component={Placeholder} />
          <Stack.Screen name="Result" component={Placeholder} />
          <Stack.Screen name="Analyze" component={Placeholder} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    jest.runOnlyPendingTimers();
    await Promise.resolve();
  });
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
}

/** Composite elements carrying the `onPress` the user would trigger (host
 * views only expose responder plumbing). First match per label. */
function pressablesByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (label: string) => boolean,
) {
  const seen = new Set<string>();
  return renderer.root
    .findAll(
      n =>
        typeof n.props.accessibilityLabel === 'string' &&
        predicate(n.props.accessibilityLabel) &&
        typeof n.props.onPress === 'function',
    )
    .filter(n => {
      const label = n.props.accessibilityLabel as string;
      if (seen.has(label)) return false;
      seen.add(label);
      return true;
    });
}

async function press(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = pressablesByLabel(renderer, l => l === label);
  if (!node) throw new Error(`stress: no pressable host labeled "${label}"`);
  await act(async () => {
    (node.props.onPress as () => void)();
  });
  await flush();
}

function currentRouteName(): string | null {
  if (!navigationRef.isReady()) return null;
  return navigationRef.getCurrentRoute()?.name ?? null;
}

interface Failure {
  check: string;
  detail: string;
}

interface Snapshot {
  phase: string;
  interactive: number;
  /** `role | label | minHeight | width` per interactive host node. */
  interactiveItems: string[];
  unlabeled: InteractiveReport[];
  smallTargets: InteractiveReport[];
  forbiddenText: string[];
  truncatedCandidates: TextReport['truncatedCandidates'];
  textChars: number;
  hostNodes: number;
}

function countNodes(node: HostNode | string): number {
  if (typeof node === 'string') return 0;
  return 1 + node.children.reduce((acc, child) => acc + countNodes(child), 0);
}

function inspect(
  renderer: TestRenderer.ReactTestRenderer,
  phase: string,
  failures: Failure[],
): Snapshot {
  const tree = findProgressSubtree(renderer);
  if (!tree) {
    failures.push({
      check: 'mounted',
      detail: `${phase}: ProgressScreen not in tree`,
    });
    return {
      phase,
      interactive: 0,
      interactiveItems: [],
      unlabeled: [],
      smallTargets: [],
      forbiddenText: [],
      truncatedCandidates: [],
      textChars: 0,
      hostNodes: 0,
    };
  }
  const interactive: InteractiveReport[] = [];
  collectInteractive(tree, tree.type, interactive, false);
  const text: TextReport = { strings: [], truncatedCandidates: [] };
  collectText(tree, tree.type, text);

  const unlabeled = interactive.filter(
    item =>
      item.role === null || !((item.label ?? '').trim() || item.textFallback),
  );
  const smallTargets = interactive.filter(item => {
    const height =
      item.minHeight === null ? null : item.minHeight + item.hitSlop;
    const widthTooSmall =
      typeof item.width === 'number' && item.width + item.hitSlop < 44;
    return (height !== null && height < 44) || widthTooSmall;
  });
  const unmeasurable = interactive.filter(item => item.minHeight === null);
  // Verbatim echoes of an injected hostile string are the input, not a
  // formatting defect (e.g. the literal word "null" inside control_chars).
  const forbiddenText = text.strings.filter(
    s =>
      FORBIDDEN_TEXT.test(s) &&
      !HOSTILE_VALUES.some(h => h.length > 0 && s.includes(h)),
  );

  for (const item of unlabeled) {
    failures.push({
      check: 'a11y-label-role',
      detail: `${phase}: ${item.path} role=${item.role} label=${JSON.stringify(item.label)} text=${JSON.stringify(item.textFallback.slice(0, 40))}`,
    });
  }
  for (const item of smallTargets) {
    failures.push({
      check: 'a11y-target-44',
      detail: `${phase}: ${item.path} label=${JSON.stringify(item.label)} minHeight=${item.minHeight} width=${String(item.width)} hitSlop=${item.hitSlop}`,
    });
  }
  for (const item of unmeasurable) {
    failures.push({
      check: 'a11y-target-unmeasurable',
      detail: `${phase}: ${item.path} label=${JSON.stringify(item.label)} has no explicit height/minHeight/padding+text facts`,
    });
  }
  for (const s of forbiddenText) {
    failures.push({
      check: 'text-numeric-format',
      detail: `${phase}: ${JSON.stringify(s.slice(0, 120))}`,
    });
  }
  return {
    phase,
    interactive: interactive.length,
    interactiveItems: interactive.map(
      item =>
        `${item.role} | ${item.label ?? item.textFallback.slice(0, 40)} | ${item.minHeight} | ${String(item.width)}`,
    ),
    unlabeled,
    smallTargets,
    forbiddenText,
    truncatedCandidates: text.truncatedCandidates,
    textChars: text.strings.reduce((acc, s) => acc + s.length, 0),
    hostNodes: countNodes(tree),
  };
}

interface Outcome {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  variant: Omit<Variant, 'seed'>;
  observed: {
    locale: string;
    timeZone: string;
    offsetMinutesAtNow: number;
    validCaptures: number;
    insertedFacts: number;
    insertedCaptures: number;
    captureTimestamps: string[];
    fetchCalls: number;
    interactions: number;
    routesVisited: string[];
    consoleErrors: string[];
  };
  phases: Snapshot[];
  failures: Failure[];
}

async function runVariant(
  variant: Variant,
): Promise<{ outcome: Outcome; tree: Json }> {
  const rng = new Rng(variant.seed ^ 0x9e3779b9);
  const failures: Failure[] = [];
  const consoleErrors: string[] = [];
  const routesVisited: string[] = [];
  const fetchLog: FetchLog = { calls: [] };
  let interactions = 0;

  // React's async-act "without await" probe is a queueMicrotask chain; faking
  // it would fire that probe from runOnlyPendingTimers() mid-act.
  jest.useFakeTimers({
    now: Date.parse(variant.nowIso),
    doNotFake: ['queueMicrotask'],
  });
  Dimensions.set({
    window: {
      width: variant.width,
      height: 844,
      scale: 3,
      fontScale: variant.fontScale,
    },
    screen: {
      width: variant.width,
      height: 844,
      scale: 3,
      fontScale: variant.fontScale,
    },
  });
  (I18nManager as unknown as { isRTL: boolean }).isRTL = variant.rtl;

  const seeded = await seedDatabase(rng, variant);
  if (variant.signedIn) {
    establishApiSession({
      apiBaseUrl: 'https://stress.invalid',
      bearerToken: `token-${variant.seed}`,
      canonicalAppUserId: userIdFor(variant.seed),
      provider: 'apple',
    });
  } else {
    clearApiSession();
  }
  useAppStore.setState({
    hydrated: true,
    ownerKey: seeded.ownerKey,
    profile:
      variant.profileSkillLevel === null
        ? null
        : {
            skillLevel: variant.profileSkillLevel,
            handedness: 'right',
            goal: 'dinks',
            biggestProblem: 'consistency',
            focusCheckpoint: 'contact_position',
          },
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
  });
  installFetch(rng, variant, fetchLog);

  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    const text = args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .slice(0, 400);
    consoleErrors.push(
      process.env.STRESS_TRACE ? `${text}\n${new Error().stack}` : text,
    );
  };

  const resolved = Intl.DateTimeFormat().resolvedOptions();
  const phases: Snapshot[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let lastTree: Json = null;
  try {
    mockSqlite.failing = variant.dbFailsFirstLoad;
    await act(async () => {
      renderer = TestRenderer.create(<Harness />);
    });
    await flush();
    const r = renderer!;
    routesVisited.push(currentRouteName() ?? 'unknown');

    if (variant.dbFailsFirstLoad) {
      const alerts = r.root.findAll(
        n =>
          typeof n.type === 'string' && n.props.accessibilityRole === 'alert',
      );
      if (alerts.length === 0) {
        failures.push({
          check: 'error-state',
          detail: 'db failure did not render an alert ErrorState',
        });
      }
      phases.push(inspect(r, 'error-state', failures));
      mockSqlite.failing = false;
      await press(r, 'Try again');
      interactions += 1;
    }

    phases.push(inspect(r, 'technique', failures));
    await press(r, 'practice progress');
    interactions += 1;
    phases.push(inspect(r, 'practice', failures));
    for (const range of rng.shuffle([
      '7 days range',
      '4 weeks range',
      '90 days range',
    ])) {
      await press(r, range);
      interactions += 1;
      phases.push(inspect(r, `practice:${range}`, failures));
    }
    await press(r, 'technique progress');
    interactions += 1;

    const consistency = pressablesByLabel(r, l => l.startsWith('Consistency'));
    if (consistency[0]) {
      await act(async () => {
        (consistency[0]!.props.onPress as () => void)();
      });
      await flush();
      interactions += 1;
      const route = currentRouteName();
      routesVisited.push(route ?? 'unknown');
      if (route !== 'StreakCalendar') {
        failures.push({
          check: 'navigation',
          detail: `consistency card navigated to ${route}, expected StreakCalendar`,
        });
      }
      await act(async () => {
        if (navigationRef.isReady() && navigationRef.canGoBack())
          navigationRef.goBack();
      });
      await flush();
      routesVisited.push(currentRouteName() ?? 'unknown');
      phases.push(inspect(r, 'after-streak-roundtrip', failures));
    }

    const badge = pressablesByLabel(r, l =>
      /^(Earned|Locked)\b|achievement/i.test(l),
    )[0];
    if (badge) {
      await act(async () => {
        (badge.props.onPress as () => void)();
      });
      await flush();
      interactions += 1;
      phases.push(inspect(r, 'badge-selected', failures));
    }

    const attempt = pressablesByLabel(r, l =>
      /attempt|Open .*result|analysis/i.test(l),
    )[0];
    if (attempt) {
      await act(async () => {
        (attempt.props.onPress as () => void)();
      });
      await flush();
      interactions += 1;
      const route = currentRouteName();
      routesVisited.push(route ?? 'unknown');
      if (route === 'Tabs') {
        failures.push({
          check: 'navigation',
          detail: `attempt press "${String(attempt.props.accessibilityLabel)}" did not navigate`,
        });
      }
      await act(async () => {
        if (navigationRef.isReady() && navigationRef.canGoBack())
          navigationRef.goBack();
      });
      await flush();
    }

    lastTree = (findProgressSubtree(r) as unknown as Json) ?? null;
  } catch (error) {
    failures.push({
      check: 'render',
      detail: `threw: ${
        error instanceof Error
          ? `${error.name}: ${error.message}\n${(error.stack ?? '')
              .split('\n')
              .filter(line => !/node_modules/.test(line))
              .slice(0, 12)
              .join('\n')}`
          : String(error)
      }`,
    });
  } finally {
    console.error = originalError;
    mockSqlite.failing = false;
    if (renderer) {
      const r = renderer as TestRenderer.ReactTestRenderer;
      await act(async () => {
        r.unmount();
      });
    }
    await act(async () => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  }
  for (const message of consoleErrors) {
    failures.push({
      check: /same key/.test(message) ? 'react-duplicate-key' : 'console-error',
      detail: message,
    });
  }

  const nowDate = new Date(variant.nowIso);
  const { seed, ...rest } = variant;
  return {
    outcome: {
      seed,
      outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
      variant: rest,
      observed: {
        locale: resolved.locale,
        timeZone: resolved.timeZone,
        offsetMinutesAtNow: -nowDate.getTimezoneOffset(),
        validCaptures: seeded.validCaptures,
        insertedFacts: seeded.insertedFacts,
        insertedCaptures: seeded.insertedCaptures,
        captureTimestamps: seeded.captureTimestamps,
        fetchCalls: fetchLog.calls.length,
        interactions,
        routesVisited,
        consoleErrors,
      },
      phases,
      failures,
    },
    tree: lastTree,
  };
}

// ─── campaign ───────────────────────────────────────────────────────────────

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? '12') || 12);
const BASE_SEED = Number(process.env.STRESS_SEED ?? '') || 20260904;
const OUT = process.env.STRESS_OUT;

function writeArtifacts(results: Outcome[], trees: Map<number, Json>) {
  if (!OUT) return;
  fs.mkdirSync(pathMod.dirname(OUT), { recursive: true });
  fs.writeFileSync(
    OUT,
    JSON.stringify(
      {
        unit: 'scr-progressscreen',
        lens: 'boundary-i18n-a11y',
        baseSeed: BASE_SEED,
        iterations: ITERATIONS,
        env: {
          LANG: process.env.LANG ?? null,
          TZ: process.env.TZ ?? null,
          observedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
          observedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        executed: results.length,
        held: results.filter(r => r.outcome === 'HELD').length,
        broken: results.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
        results,
      },
      null,
      1,
    ),
  );
  const treeDir = pathMod.resolve(
    pathMod.dirname(OUT),
    `${pathMod.basename(OUT, '.json')}-trees`,
  );
  for (const result of results) {
    if (result.outcome !== 'BROKEN') continue;
    const tree = trees.get(result.seed);
    if (tree === undefined) continue;
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(
      pathMod.resolve(treeDir, `seed-${result.seed}.json`),
      JSON.stringify(tree, null, 1),
    );
  }
}

describe('ProgressScreen stress · boundary-i18n-a11y (real navigator/providers)', () => {
  jest.setTimeout(20 * 60_000);

  test('the seed corpus reaches the real capture parser (harness sanity)', async () => {
    // A harness that fed only rejected rows would "pass" vacuously.
    const probe: Variant = {
      ...buildVariant(BASE_SEED, 0),
      captureCount: 40,
      corruptCaptureCount: 0,
      legacyCaptureCount: 0,
    };
    const summary = await seedDatabase(new Rng(probe.seed ^ 0x9e3779b9), probe);
    expect(summary.insertedCaptures).toBe(40);
    expect(summary.validCaptures).toBeGreaterThan(0);
  });

  test(`${ITERATIONS} seeded render variants hold every boundary/i18n/a11y invariant`, async () => {
    const results: Outcome[] = [];
    const trees = new Map<number, Json>();
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = BASE_SEED + i;
      const { outcome, tree } = await runVariant(buildVariant(seed, i));
      results.push(outcome);
      trees.set(seed, tree);
    }
    writeArtifacts(results, trees);

    const broken = results.filter(r => r.outcome === 'BROKEN');
    const report = broken
      .map(
        r =>
          `seed ${r.seed}: ` +
          r.failures
            .slice(0, 6)
            .map(f => `[${f.check}] ${f.detail}`)
            .join(' | '),
      )
      .join('\n');
    expect({
      executed: results.length,
      brokenSeeds: broken.map(r => r.seed),
      report,
    }).toEqual({
      executed: ITERATIONS,
      brokenSeeds: [],
      report: '',
    });
  });
});
