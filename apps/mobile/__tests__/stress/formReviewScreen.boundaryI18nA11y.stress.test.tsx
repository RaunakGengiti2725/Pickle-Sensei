/**
 * STRESS — FormReviewScreen · boundary / i18n / a11y lens.
 *
 * Renders the REAL screen inside the REAL app shell the product uses:
 * SafeAreaProvider → QueryClientProvider → NavigationContainer (same theme
 * and screenOptions as RootNavigator) → native-stack → FormReviewScreen,
 * with the real Zustand-free data path (getDb() → LOCAL_MIGRATIONS →
 * repository → loadStrokeResultEvidence → loadReviewPoseSequence with the
 * real SHA-256 gate and strict pose parse) over a REAL SQLite database
 * (node:sqlite behind the op-sqlite native seam, the pattern
 * dbMigrationMalformedOutbox.test.ts established). Doubles are limited to
 * native seams: op-sqlite, the PickleVideoCapture artifact reader,
 * react-native-safe-area-context's native provider and react-native-svg.
 *
 * Every variant derives from one seed (mulberry32) and is replayable:
 *   STRESS_ONLY=<seed[,seed]>  replay exactly these seeds
 *   STRESS_ITER=<n>            campaign size (default 12; the lens asks ≥150)
 *   STRESS_SEED=<n>            base seed (default 20260904)
 *   STRESS_REPEAT=<n>          run every seed n× (flake-rate probing)
 *   STRESS_OUT=<dir>           results table + rendered-tree evidence
 *
 * Oracles (rendered-tree level — Jest has no layout engine, so anything
 * called ESTIMATE below is an INFERRED glyph-width bound, never a measured
 * truth; everything else is asserted on the rendered host tree):
 *   R1  render completes without throwing and reaches the state the seeded
 *       evidence predicts (ready ↔ a usable analysis exists, else missing);
 *   R2  no boundary token leaks into visible text, a11y labels or hints
 *       (undefined / null / NaN / Infinity / [object / e+NN exponents);
 *   R3  no persisted string (ids, slugs, keys, versions, uris — every one is
 *       stamped with a per-seed marker) reaches the rendered tree;
 *   R4  every interactive host node has an interactive accessibilityRole and
 *       a non-empty accessibilityLabel (or text content);
 *   R5  every interactive host node's touch box (style height/minHeight or
 *       the tallest fixed-height descendant, plus hitSlop) is ≥ 44pt — nodes
 *       whose box is layout-derived (flex) are reported as unmeasured;
 *   R6  no interactive host node is nested inside another one;
 *   R7  no style or prop on any host node carries NaN / ±Infinity;
 *   R8  absolutely positioned children of the (overflow: hidden) stage stay
 *       inside the stage box after their onLayout is fed (CLIP evidence);
 *   R9  numberOfLines={1} texts whose ESTIMATED glyph width exceeds the
 *       available column at the variant's font scale are recorded (INFERRED);
 *   R10 visible copy honours the dossier vocabulary ban;
 *   R11 controls work through the real navigator: Back / Close pop the
 *       route, Re-analyze pushes Analyze {source:'camera'} and arms a
 *       handoff whose declaredStroke is a canonical slug or null;
 *   R12 no locale-sensitive formatting API runs during the render, so the
 *       output cannot depend on the device locale (the 12-locale × 8-zone
 *       matrix is driven by scripts/stress-form-review-screen.mjs, which
 *       starts one Jest process per (locale, zone) cell with LANG/LC_ALL/TZ
 *       set, replays the same seeds and compares text digests).
 */
import React from 'react';
import { Dimensions, I18nManager, StyleSheet, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  ReactTestInstance,
  ReactTestRenderer,
  ReactTestRendererJSON,
} from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createNavigationContainerRef,
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SHOT_TYPES } from '@pickle/shared-types';
import { sha256Hex } from '@pickle/swing-domain';

// apps/mobile types only `jest` (no @types/node); the exact Node surface this
// harness drives is declared here, as dbMigrationMalformedOutbox.test.ts does.
declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
declare const __dirname: string;

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
  run(...params: (string | number | null)[]): unknown;
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}
interface NodeFs {
  mkdirSync(path: string, options: { recursive: boolean }): void;
  writeFileSync(path: string, data: string): void;
}
interface NodePath {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};
const fs = require('fs') as NodeFs;
const nodePath = require('path') as NodePath;

// ─── Native seams (the ONLY doubles) ─────────────────────────────────────────

// One in-memory database for the whole file: the production getDb()
// singleton runs its migrations once, so variants wipe rows rather than swap
// files (exactly what a device does between sessions).
const mockSqlite: { db: DatabaseSync | null } = { db: null };

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const run = (sql: string, params: unknown[] = []) => {
      const db = mockSqlite.db;
      if (!db) throw new Error('stress harness: database not opened');
      const bound = params.map(value =>
        typeof value === 'boolean' ? Number(value) : value,
      ) as (string | number | null)[];
      const statement = db.prepare(sql);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(sql)) {
        return { rows: statement.all(...bound) };
      }
      statement.run(...bound);
      return { rows: [] };
    };
    return {
      executeSync: run,
      execute: async (sql: string, params: unknown[] = []) => run(sql, params),
      close: () => {},
    };
  },
}));

// The private capture-artifact reader (native PickleVideoCapture module).
const mockArtifacts = new Map<string, string>();
jest.mock('react-native', () => {
  const rn = jest.requireActual('react-native') as {
    NativeModules: Record<string, unknown>;
  };
  rn.NativeModules.PickleVideoCapture = {
    readTextFile: async (uri: string) => {
      const body = mockArtifacts.get(uri);
      if (body === undefined) throw new Error(`ENOENT ${uri}`);
      return body;
    },
  };
  return rn;
});

jest.mock(
  'react-native-safe-area-context',
  () =>
    (
      jest.requireActual('react-native-safe-area-context/jest/mock') as {
        default: unknown;
      }
    ).default,
);

jest.mock('react-native-svg', () => {
  const ReactLib = jest.requireActual('react') as typeof React;
  const { View: RNView } = jest.requireActual('react-native') as {
    View: React.ComponentType<Record<string, unknown>>;
  };
  const Mock = (props: Record<string, unknown>) =>
    ReactLib.createElement(RNView, props);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});

// Imported AFTER the seams above are declared (jest hoists the mocks).
import { FormReviewScreen } from '../../src/screens/FormReviewScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';
import {
  GUEST_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import type { RootStackParams } from '../../src/navigation/params';
import { color } from '../../src/design/tokens';

// ─── Seeded RNG ──────────────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
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
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
}

// ─── Lens dimensions ─────────────────────────────────────────────────────────

const LOCALES = [
  'de-DE',
  'fr-FR',
  'ar-EG',
  'hi-IN',
  'ja-JP',
  'pt-BR',
  'tr-TR',
  'ru-RU',
  'th-TH',
  'zh-CN',
  'en-IN',
  'es-419',
] as const;

/** UTC-12 … UTC+14 plus the DST-observing edges (one per hemisphere, one
 * half-hour, one 45-minute zone). */
const TIME_ZONES = [
  'Etc/GMT+12',
  'Pacific/Kiritimati',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'America/Santiago',
] as const;

/** Wall-clock anchors: DST transitions, year edges, a leap-day boundary. */
const CLOCK_ANCHORS = [
  '2026-03-08T07:00:00.000Z',
  '2026-11-01T05:59:59.000Z',
  '2026-03-29T00:59:59.000Z',
  '2026-10-25T01:00:00.000Z',
  '2026-04-05T15:59:59.000Z',
  '2026-01-01T00:00:00.000Z',
  '2026-12-31T23:59:59.999Z',
  '2028-02-29T23:59:59.000Z',
] as const;

const FONT_SCALES = [1, 1.35, 3.12] as const;
const VIEWPORTS = [
  { width: 320, height: 568 },
  { width: 375, height: 812 },
  { width: 430, height: 932 },
] as const;

const STRING_KITS = {
  latinLong:
    'The paddle must be set early and the hips must lead the shoulders through the strike zone so the face stays square and the wrist stays quiet until the ball has left the paddle and the recovery step begins again ',
  cjk: '第一の準備姿勢はパドルを胸の高さに保ち膝を柔らかく曲げて体重を前足に乗せることから始まります腰の回転が肩を導き手首は静かに保たれます',
  arabic:
    'وضعية الاستعداد تبدأ بثني الركبتين وتوزيع الوزن على مقدمة القدمين مع رفع المضرب إلى مستوى الصدر ثم يقود الورك الكتفين خلال منطقة الضرب',
  zwj: '👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🚀🧑🏿‍🤝‍🧑🏻🏴󠁧󠁢󠁳󠁣󠁴󠁿',
  combining:
    'Z\u0335\u0324\u0341a\u0336\u0301l\u0338\u0329g\u0335\u0302o\u0338\u032e',
  german:
    'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft',
  thai: 'ท่าเตรียมพร้อมเริ่มจากการย่อเข่าและถ่ายน้ำหนักไปยังปลายเท้าพร้อมยกไม้ขึ้นระดับอก',
  devanagari:
    'तैयारी की मुद्रा घुटनों को मोड़कर और वज़न को पंजों पर रखकर शुरू होती है',
  bidiControl: '\u202Eevird dnaherof\u202C \u200F\u200E',
  whitespace: '   \t\n  ',
  empty: '',
} as const;
type StringKit = keyof typeof STRING_KITS;
const STRING_KIT_KEYS = Object.keys(STRING_KITS) as StringKit[];

function longString(kit: StringKit, marker: string): string {
  const base = STRING_KITS[kit];
  if (base.length === 0 || kit === 'whitespace') return base;
  let out = marker;
  while (out.length < 220) out += base;
  return out;
}

/** Scores / severities / timestamps the persisted record can never be
 * trusted to keep in range. */
const NUMERIC_EXTREMES = [
  0,
  -0,
  -1,
  -1e9,
  100,
  100.4999,
  101,
  250,
  1e21,
  1e308,
  5e-324,
  0.5,
  99.999,
  Number.MAX_SAFE_INTEGER,
  -Number.MAX_SAFE_INTEGER,
] as const;

const CHECKPOINT_KEYS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'paddle_set',
  'swing_length',
  'sequencing',
  'paddle_path',
  'contact_position',
  'face_wrist_stability',
  'follow_through',
  'recovery',
] as const;
const PHASE_KEYS = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
] as const;
const BANDS = ['green', 'yellow', 'red', 'unscored'] as const;
const DIRECTIONS = [
  'none',
  'narrow',
  'wide',
  'low',
  'high',
  'late',
  'early',
  'short',
  'long',
  'unstable',
] as const;

const REVIEW_JOINTS = [
  'head',
  'left_shoulder',
  'right_shoulder',
  'left_elbow',
  'right_elbow',
  'left_wrist',
  'right_wrist',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

// ─── Variant model ───────────────────────────────────────────────────────────

type Family =
  | 'scored'
  | 'poseless'
  | 'clipless'
  | 'legacy-capture'
  | 'corrupt-shot-json'
  | 'corrupt-record-json'
  | 'corrupt-both'
  | 'missing-rows'
  | 'record-result-only'
  | 'record-result-empty-object'
  | 'no-phases'
  | 'all-unscored'
  | 'empty-checkpoints'
  | 'garbage-keys'
  | 'numeric-extremes'
  | 'sidecar-hash-mismatch'
  | 'sidecar-not-json'
  | 'sidecar-extreme-landmarks'
  | 'sidecar-single-frame'
  | 'capture-zero-dimensions'
  | 'capture-metadata-mismatch';

const FAMILIES: readonly Family[] = [
  'scored',
  'poseless',
  'clipless',
  'legacy-capture',
  'corrupt-shot-json',
  'corrupt-record-json',
  'corrupt-both',
  'missing-rows',
  'record-result-only',
  'record-result-empty-object',
  'no-phases',
  'all-unscored',
  'empty-checkpoints',
  'garbage-keys',
  'numeric-extremes',
  'sidecar-hash-mismatch',
  'sidecar-not-json',
  'sidecar-extreme-landmarks',
  'sidecar-single-frame',
  'capture-zero-dimensions',
  'capture-metadata-mismatch',
];

type AnalysisIdKind = 'plain' | 'long-cjk' | 'zwj' | 'bidi' | 'whitespace';
type PhaseParamKind =
  'absent' | 'valid' | 'unknown' | 'long-string' | 'empty' | 'null' | 'number';
type Cta = 'back' | 'header-close' | 'reanalyze' | 'none';

interface Variant {
  seed: number;
  family: Family;
  locale: (typeof LOCALES)[number];
  rtl: boolean;
  timeZone: (typeof TIME_ZONES)[number];
  clockIso: (typeof CLOCK_ANCHORS)[number];
  fontScale: (typeof FONT_SCALES)[number];
  viewport: (typeof VIEWPORTS)[number];
  stringKit: StringKit;
  analysisIdKind: AnalysisIdKind;
  phaseParam: PhaseParamKind;
  cta: Cta;
  /** Transport presses before the CTA (bit flags: speed, next, prev, play, autopause). */
  transport: number;
  marker: string;
}

function variantFor(seed: number): Variant {
  const rng = new Rng(seed);
  const locale = rng.pick(LOCALES);
  return {
    seed,
    family: rng.pick(FAMILIES),
    locale,
    rtl: locale === 'ar-EG',
    timeZone: rng.pick(TIME_ZONES),
    clockIso: rng.pick(CLOCK_ANCHORS),
    fontScale: rng.pick(FONT_SCALES),
    viewport: rng.pick(VIEWPORTS),
    stringKit: rng.pick(STRING_KIT_KEYS),
    analysisIdKind: rng.pick<AnalysisIdKind>([
      'plain',
      'plain',
      'long-cjk',
      'zwj',
      'bidi',
      'whitespace',
    ]),
    phaseParam: rng.pick<PhaseParamKind>([
      'absent',
      'absent',
      'valid',
      'unknown',
      'long-string',
      'empty',
      'null',
      'number',
    ]),
    cta: rng.pick<Cta>(['back', 'header-close', 'reanalyze', 'none']),
    transport: rng.int(32),
    marker: `\u24C8${seed.toString(36)}\u24C8`,
  };
}

// ─── Seeded evidence (written the way a device's SQLite ends up) ────────────

interface SeededEvidence {
  analysisId: string;
  /** What the production loader must conclude from these rows. */
  expectReady: boolean;
  /** True when the sidecar must survive hash + strict parse. */
  expectSequence: boolean;
  /** True when a clip row with duration > 0 exists. */
  expectClip: boolean;
  /** Phase keys the built script can stop on (for the `phase` param). */
  measuredPhases: readonly string[];
  declaredStroke: string | null;
  shotType: unknown;
}

function analysisIdFor(kind: AnalysisIdKind, marker: string): string {
  switch (kind) {
    case 'plain':
      return `analysis-${marker}`;
    case 'long-cjk':
      return longString('cjk', marker);
    case 'zwj':
      return longString('zwj', marker);
    case 'bidi':
      return `${marker}${STRING_KITS.bidiControl}`;
    case 'whitespace':
      return `${marker}${STRING_KITS.whitespace}`;
  }
}

function buildAnalysis(v: Variant, rng: Rng, analysisId: string) {
  const junk = longString(v.stringKit, v.marker);
  const extreme = () => rng.pick(NUMERIC_EXTREMES);
  const garbage = v.family === 'garbage-keys';
  const extremes = v.family === 'numeric-extremes';

  const phaseBounds: [number, number][] = [
    [0, 900],
    [900, 1500],
    [1500, 1900],
    [1880, 1920],
    [1920, 2400],
    [2400, 3200],
  ];
  const phases =
    v.family === 'no-phases'
      ? []
      : PHASE_KEYS.map((key, index) => {
          const [startMs, endMs] = phaseBounds[index] ?? [0, 0];
          const span: Record<string, unknown> = {
            key: garbage && rng.chance(0.5) ? `${junk}${key}` : key,
            startMs: extremes && rng.chance(0.3) ? extreme() : startMs,
            endMs: extremes && rng.chance(0.3) ? extreme() : endMs,
            representativeMs:
              extremes && rng.chance(0.3) ? extreme() : (startMs + endMs) / 2,
            confidence: extremes ? extreme() : 0.8,
          };
          return span;
        });

  const checkpoints =
    v.family === 'empty-checkpoints'
      ? []
      : CHECKPOINT_KEYS.map(key => {
          const unscored = v.family === 'all-unscored' || rng.chance(0.15);
          const score = unscored
            ? null
            : extremes
              ? extreme()
              : Math.round(rng.float() * 100);
          const cp: Record<string, unknown> = {
            key: garbage && rng.chance(0.4) ? `${key}${junk}` : key,
            score,
            confidence: extremes ? extreme() : 0.8,
            band: garbage && rng.chance(0.3) ? junk : rng.pick(BANDS),
            direction: garbage && rng.chance(0.3) ? junk : rng.pick(DIRECTIONS),
            severity: extremes
              ? extreme()
              : score === null
                ? 0
                : (100 - score) / 100,
            applicable: rng.chance(0.9),
          };
          if (garbage && rng.chance(0.2)) delete cp['direction'];
          if (garbage && rng.chance(0.2)) cp['score'] = junk;
          return cp;
        });

  const shotType = garbage
    ? rng.pick([junk, '', null, 42])
    : rng.pick(SHOT_TYPES);
  const analysis: Record<string, unknown> = {
    id: analysisId,
    sessionId: rng.chance(0.5) ? null : `set-${v.marker}`,
    shotType,
    cameraView: garbage ? junk : rng.pick(['side', 'front', 'back']),
    handedness: garbage ? junk : rng.pick(['right', 'left']),
    capturedAtIso: garbage ? junk : v.clockIso,
    timestamps: extremes
      ? { startMs: extreme(), contactMs: extreme(), endMs: extreme() }
      : garbage && rng.chance(0.3)
        ? junk
        : { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: garbage && rng.chance(0.2) ? junk : phases,
    measurements: [],
    checkpoints: garbage && rng.chance(0.2) ? junk : checkpoints,
    overallScore: extremes ? extreme() : 7.1,
    analysisConfidence: extremes ? extreme() : 0.84,
    resultKind: 'scored',
    guidance: garbage ? junk : null,
    priorityFix: {
      checkpoint: garbage ? junk : 'contact_position',
      reasonKey: 'lowest_score',
      severity: extremes ? extreme() : 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: junk,
      modelBundleVersion: junk,
      poseModelVersion: junk,
      paddleModelVersion: junk,
      strokeDetectorVersion: junk,
      phaseModelVersion: junk,
      scoringModelVersion: junk,
      shotConfigVersion: junk,
    },
    source: 'real',
  };
  return { analysis, shotType, phases };
}

function buildSidecar(v: Variant, rng: Rng, marker: string): string {
  const extremeLandmarks = v.family === 'sidecar-extreme-landmarks';
  const single = v.family === 'sidecar-single-frame';
  const frames: Record<string, unknown>[] = [];
  const step = single ? 3200 : 40;
  const bodyX = (base: number) =>
    extremeLandmarks
      ? rng.pick([base, 0, 1, -5, 1e6, 1e308, -1e308])
      : base + (rng.float() - 0.5) * 0.02;
  let index = 0;
  for (let t = 0; t <= 3200; t += step) {
    const sweep = t / 3200;
    const joints: Record<string, { x: number; y: number }> = {
      head: { x: bodyX(0.5), y: 0.18 },
      left_shoulder: { x: bodyX(0.45), y: 0.3 },
      right_shoulder: { x: bodyX(0.55), y: 0.3 },
      left_elbow: { x: bodyX(0.4), y: 0.42 },
      right_elbow: { x: bodyX(0.62), y: 0.42 },
      left_wrist: { x: bodyX(0.38), y: 0.52 },
      right_wrist: { x: bodyX(0.3 + 0.4 * sweep), y: 0.5 },
      left_hip: { x: bodyX(0.46), y: 0.55 },
      right_hip: { x: bodyX(0.54), y: 0.55 },
      left_knee: { x: bodyX(0.46), y: 0.72 },
      right_knee: { x: bodyX(0.54), y: 0.72 },
      left_ankle: { x: bodyX(0.45), y: 0.9 },
      right_ankle: { x: bodyX(0.55), y: 0.9 },
    };
    frames.push({
      i: index,
      t,
      c: 0.9,
      l: REVIEW_JOINTS.map((name): Record<string, unknown> => ({
        n: name,
        x: joints[name]?.x ?? 0.5,
        y: extremeLandmarks
          ? rng.pick([joints[name]?.y ?? 0.5, 0, 1, -5, 1e6, 1e308])
          : (joints[name]?.y ?? 0.5),
        v: extremeLandmarks ? rng.pick([0.95, 0.35, 0.349, 0, 1, 2, -1]) : 0.95,
      })).concat([{ n: `${marker}unknown_joint`, x: 0.5, y: 0.5, v: 1 }]),
    });
    index += 1;
  }
  return JSON.stringify({
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: `${marker}pose-model`,
    video: extremeLandmarks
      ? { w: rng.pick([1, 1080, 1e9]), h: rng.pick([1, 1920, 1e9]), fps: 30 }
      : { w: 1080, h: 1920, fps: 30 },
    frames,
  });
}

async function seedEvidence(v: Variant): Promise<SeededEvidence> {
  const rng = new Rng(v.seed ^ 0x5eed);
  const db = getDb();
  const owner = GUEST_DATA_OWNER;
  const analysisId = analysisIdFor(v.analysisIdKind, v.marker);
  const captureId = `capture-${v.marker}`;
  const clipUri = `file:///captures/${v.seed}/clip.mov`;
  const sidecarUri = `file:///captures/${v.seed}/clip.pose.json`;
  const { analysis, shotType, phases } = buildAnalysis(v, rng, analysisId);
  const junk = longString(v.stringKit, v.marker);

  const family = v.family;
  const shotRowPresent = !(
    family === 'missing-rows' ||
    family === 'record-result-only' ||
    family === 'record-result-empty-object'
  );
  const shotJsonValid = !(
    family === 'corrupt-shot-json' || family === 'corrupt-both'
  );
  const recordRowPresent = family !== 'missing-rows';
  const recordJsonValid = !(
    family === 'corrupt-record-json' || family === 'corrupt-both'
  );
  const recordCarriesResult =
    family === 'record-result-only' ||
    family === 'record-result-empty-object' ||
    (family === 'corrupt-shot-json' && rng.chance(0.5));
  // getAnalysis() returns whatever JSON.parse yields and the screen only
  // asks "truthy?": a payload of `[]` is therefore a usable analysis, `0`
  // and `null` are not, and non-JSON throws into the `.catch(() => null)`.
  const corruptShotPayload = shotJsonValid
    ? null
    : rng.pick(['{"id":', junk, '', 'null', '[]', '0']);
  const corruptShotParsesTruthy = corruptShotPayload === '[]';

  if (shotRowPresent) {
    await db.execute(
      `INSERT INTO local_shot (owner_key, id, session_id, shot_type, captured_at,
         overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'real', 0, ?)`,
      [
        owner,
        analysisId,
        (analysis['sessionId'] as string | null) ?? null,
        typeof shotType === 'string' ? shotType : 'forehand_drive',
        v.clockIso,
        7.1,
        0.84,
        'scored',
        corruptShotPayload ?? JSON.stringify(analysis),
      ],
    );
  }

  const declaredStroke = rng.chance(0.6)
    ? rng.pick(SHOT_TYPES)
    : rng.pick([null, junk, undefined]);
  const record: Record<string, unknown> = {
    id: analysisId,
    captureId,
    createdAtIso: v.clockIso,
    strokeIntent: rng.chance(0.8)
      ? {
          declaredStroke,
          predictedStroke: null,
          resolutionBasis: 'declared',
          resolvedProfileId: junk,
          resolvedProfileVersion: junk,
          disagreement: null,
        }
      : null,
    result:
      family === 'record-result-empty-object'
        ? {}
        : recordCarriesResult
          ? analysis
          : null,
    uncertainty: { analysisConfidence: 0.84, presentation: junk },
  };
  if (recordRowPresent) {
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        owner,
        analysisId,
        captureId,
        v.clockIso,
        junk,
        junk,
        recordJsonValid ? JSON.stringify(record) : rng.pick(['{', junk, '']),
      ],
    );
  }

  // Capture row (the clip + sidecar pointer).
  const captureAbsent = family === 'clipless' && rng.chance(0.5);
  const durationMs = family === 'clipless' ? rng.pick([0, -1, -3400]) : 3400;
  const zeroDims = family === 'capture-zero-dimensions';
  const width = zeroDims ? rng.pick([0, -1]) : 1080;
  const height = zeroDims ? rng.pick([0, -1]) : 1920;
  const sidecarWanted = !(
    family === 'poseless' ||
    family === 'legacy-capture' ||
    family === 'clipless' ||
    captureAbsent
  );
  const sidecarBody = buildSidecar(v, rng, v.marker);
  const sidecarRef = sidecarWanted
    ? {
        schemaVersion: 1,
        format: 'pickle.pose-sequence.v1',
        uri: sidecarUri,
        frameCount: family === 'sidecar-single-frame' ? 2 : 81,
        sha256:
          family === 'sidecar-hash-mismatch'
            ? 'ab'.repeat(32)
            : sha256Hex(sidecarBody),
        coordinateSystem: 'normalized_image_top_left',
        poseModelVersion: `${v.marker}pose-model`,
      }
    : undefined;
  if (sidecarWanted) {
    mockArtifacts.set(
      sidecarUri,
      family === 'sidecar-not-json' ? `${junk}{not json` : sidecarBody,
    );
  }
  const clipPayload: Record<string, unknown> = {
    captureMode: 'imported_video',
    uri: clipUri,
    durationMs: family === 'capture-metadata-mismatch' ? 9999 : durationMs,
    fps: 30,
    width,
    height,
    capturedAtIso: v.clockIso,
    // `reason` is validated as a non-blank string by the clip parser, so a
    // blank kit would silently drop the whole clip payload (and the sidecar
    // ref with it) — that path is covered by the corrupt/legacy families.
    recognition: {
      status: 'unknown',
      reason: junk.trim().length ? junk : 'no_stroke',
    },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(sidecarRef ? { poseSequence: sidecarRef } : {}),
    ...(rng.chance(0.5) ? { posterUri: `${clipUri}.poster.jpg` } : {}),
  };
  if (!captureAbsent) {
    await db.execute(
      `INSERT INTO local_capture (owner_key, id, uri, shot_type, captured_at,
         duration_ms, fps, width, height, status, payload, declared_stroke)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'analyzed', ?, ?)`,
      [
        owner,
        captureId,
        clipUri,
        typeof shotType === 'string' && shotType.length > 0
          ? shotType
          : 'forehand_drive',
        v.clockIso,
        durationMs,
        30,
        width,
        height,
        family === 'legacy-capture' ? null : JSON.stringify(clipPayload),
        typeof declaredStroke === 'string' ? declaredStroke : null,
      ],
    );
  }

  const shotUsable =
    shotRowPresent && (shotJsonValid || corruptShotParsesTruthy);
  const recordUsable = recordRowPresent && recordJsonValid;
  const expectReady = shotUsable || (recordUsable && recordCarriesResult);
  // The sidecar survives only when the record names the capture, the capture
  // row parses as a valid clip (metadata must match the columns), the ref's
  // hash matches the bytes and the strict parse accepts every landmark.
  const captureParses =
    !captureAbsent &&
    family !== 'legacy-capture' &&
    !zeroDims &&
    family !== 'capture-metadata-mismatch' &&
    durationMs > 0;
  const expectSequence =
    expectReady &&
    recordUsable &&
    captureParses &&
    sidecarWanted &&
    family !== 'sidecar-hash-mismatch' &&
    family !== 'sidecar-not-json';
  const measuredPhases = Array.isArray(phases)
    ? phases
        .map(span => span['key'])
        .filter(
          (key): key is string =>
            typeof key === 'string' &&
            (PHASE_KEYS as readonly string[]).includes(key),
        )
    : [];
  return {
    analysisId,
    expectReady,
    expectSequence,
    expectClip: expectReady && recordUsable && !captureAbsent && durationMs > 0,
    measuredPhases,
    declaredStroke: typeof declaredStroke === 'string' ? declaredStroke : null,
    shotType,
  };
}

function wipeRows(): void {
  const db = mockSqlite.db;
  if (!db) return;
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all()
    .map(row => String(row['name']));
  for (const table of tables) db.exec(`DELETE FROM "${table}"`);
  mockArtifacts.clear();
}

// ─── App shell (the real navigator, the real providers) ─────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: color.surface,
    primary: color.court,
  },
};

function StubScreen() {
  return <View testID="stress-stub-screen" />;
}

function phaseParamFor(
  v: Variant,
  seeded: SeededEvidence,
): Record<string, unknown> {
  switch (v.phaseParam) {
    case 'absent':
      return {};
    case 'valid':
      return { phase: seeded.measuredPhases[0] ?? 'contact' };
    case 'unknown':
      return { phase: `${v.marker}nope` };
    case 'long-string':
      return { phase: longString(v.stringKit, v.marker) };
    case 'empty':
      return { phase: '' };
    case 'null':
      return { phase: null };
    case 'number':
      return { phase: 42 };
  }
}

function Shell(props: {
  navRef: ReturnType<typeof createNavigationContainerRef<RootStackParams>>;
  params: Record<string, unknown>;
  queryClient: QueryClient;
}) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={props.queryClient}>
        <NavigationContainer
          ref={props.navRef}
          theme={theme}
          initialState={{
            routes: [
              { name: 'Tabs' },
              { name: 'Result', params: { analysisId: 'previous' } },
              { name: 'FormReview', params: props.params },
            ],
          }}
        >
          <Stack.Navigator
            screenOptions={{
              headerShown: false,
              animation: 'fade_from_bottom',
              contentStyle: { backgroundColor: color.surface },
            }}
          >
            <Stack.Screen name="Tabs" component={StubScreen} />
            <Stack.Screen name="Result" component={StubScreen} />
            <Stack.Screen name="Analyze" component={StubScreen} />
            <Stack.Screen
              name="FormReview"
              component={FormReviewScreen}
              options={{
                title: 'Form review',
                contentStyle: { backgroundColor: color.surfaceDark },
              }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Rendered-tree oracles ───────────────────────────────────────────────────

type HostNode = ReactTestRendererJSON;

function hostChildren(node: HostNode): HostNode[] {
  return (node.children ?? []).filter(
    (child): child is HostNode => typeof child !== 'string',
  );
}

function walk(
  node: HostNode | HostNode[] | null,
  visit: (n: HostNode, depth: number, parents: HostNode[]) => void,
  depth = 0,
  parents: HostNode[] = [],
): void {
  if (node === null) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, depth, parents);
    return;
  }
  visit(node, depth, parents);
  for (const child of hostChildren(node)) {
    walk(child, visit, depth + 1, [...parents, node]);
  }
}

function textOf(node: HostNode): string {
  let out = '';
  for (const child of node.children ?? []) {
    out += typeof child === 'string' ? child : textOf(child);
  }
  return out;
}

function flat(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'switch',
  'adjustable',
  'checkbox',
  'radio',
  'togglebutton',
  'tab',
  'menuitem',
  'slider',
  'imagebutton',
  'combobox',
  'spinbutton',
]);

function isInteractive(node: HostNode): boolean {
  const p = node.props;
  return (
    typeof p['onClick'] === 'function' ||
    typeof p['onPress'] === 'function' ||
    typeof p['onResponderGrant'] === 'function' ||
    typeof p['onStartShouldSetResponder'] === 'function' ||
    (typeof p['accessibilityRole'] === 'string' &&
      INTERACTIVE_ROLES.has(p['accessibilityRole']))
  );
}

function fixedExtent(
  style: Record<string, unknown>,
  axis: 'height' | 'width',
): number | null {
  const min = style[axis === 'height' ? 'minHeight' : 'minWidth'];
  const exact = style[axis];
  const candidates = [exact, min].filter(
    (value): value is number =>
      typeof value === 'number' && Number.isFinite(value),
  );
  return candidates.length ? Math.max(...candidates) : null;
}

interface TargetBox {
  height: number | null;
  width: number | null;
  flex: boolean;
}

/** Touch box of an interactive host node from its OWN flattened style
 * (height/minHeight, width/minWidth) plus hitSlop on both sides. A box the
 * layout engine derives (flex, stretch) is reported as unmeasured, never
 * guessed from descendants. */
function targetBox(node: HostNode): TargetBox {
  const own = flat(node.props['style']);
  const height = fixedExtent(own, 'height');
  const width = fixedExtent(own, 'width');
  const flex = typeof own['flex'] === 'number' && own['flex'] > 0;
  const slop = node.props['hitSlop'];
  const slopValue =
    typeof slop === 'number'
      ? slop
      : slop && typeof slop === 'object'
        ? Math.min(
            Number((slop as Record<string, unknown>)['top'] ?? 0),
            Number((slop as Record<string, unknown>)['bottom'] ?? 0),
          )
        : 0;
  return {
    height: height === null ? null : height + 2 * slopValue,
    width: width === null ? null : width + 2 * slopValue,
    flex,
  };
}

const LEAK_TOKENS =
  /\bundefined\b|\bnull\b|\bNaN\b|Infinity|\[object |\d+e[+-]\d+/;
const DOSSIER_BAN =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s?% accur|best-in-class|world.class|#1\b/i;

interface Failure {
  oracle: string;
  detail: string;
}
interface Estimate {
  oracle: string;
  detail: string;
}

interface Outcome {
  seed: number;
  variant: Omit<Variant, 'marker'>;
  state: 'ready' | 'missing' | 'loading' | 'threw';
  expectReady: boolean;
  expectSequence: boolean;
  expectClip: boolean;
  interactive: {
    testID: string | null;
    role: string | null;
    label: string | null;
    box: TargetBox;
  }[];
  texts: string[];
  digest: string;
  localeApiCalls: number;
  failures: Failure[];
  estimates: Estimate[];
  durationMs: number;
}

function digestOf(texts: string[]): string {
  return sha256Hex(texts.join('\u0001')).slice(0, 16);
}

/** Glyph-width ESTIMATE (points) for a one-line label: 0.55em average Latin
 * advance, 1em for CJK/Thai/Devanagari ideographs, scaled by fontScale. */
function estimateWidth(
  text: string,
  fontSize: number,
  fontScale: number,
): number {
  let ems = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    ems +=
      code > 0x2e7f
        ? 1
        : /[MWmw@]/.test(ch)
          ? 0.8
          : /[il.,' ]/.test(ch)
            ? 0.3
            : 0.55;
  }
  return ems * fontSize * fontScale;
}

// ─── One iteration ───────────────────────────────────────────────────────────

const mounted: ReactTestRenderer[] = [];

async function flush(times = 1): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      jest.advanceTimersByTime(16);
    });
  }
}

function installLocaleSpies(): { count: () => number; restore: () => void } {
  let calls = 0;
  const bump = () => {
    calls += 1;
  };
  const dateProto = Date.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const numProto = Number.prototype as unknown as Record<
    string,
    (...a: unknown[]) => unknown
  >;
  const originals: [
    Record<string, (...a: unknown[]) => unknown>,
    string,
    (...a: unknown[]) => unknown,
  ][] = [];
  for (const name of [
    'toLocaleString',
    'toLocaleDateString',
    'toLocaleTimeString',
  ]) {
    const original = dateProto[name];
    if (!original) continue;
    originals.push([dateProto, name, original]);
    dateProto[name] = function (this: unknown, ...args: unknown[]) {
      bump();
      return original.apply(this, args);
    };
  }
  {
    const original = numProto['toLocaleString'];
    if (original) {
      originals.push([numProto, 'toLocaleString', original]);
      numProto['toLocaleString'] = function (
        this: unknown,
        ...args: unknown[]
      ) {
        bump();
        return original.apply(this, args);
      };
    }
  }
  const intl = Intl as unknown as Record<string, unknown>;
  const intlOriginals: [string, unknown][] = [];
  for (const name of [
    'DateTimeFormat',
    'NumberFormat',
    'RelativeTimeFormat',
    'PluralRules',
    'Collator',
  ]) {
    const Original = intl[name] as
      (new (...a: unknown[]) => unknown) | undefined;
    if (!Original) continue;
    intlOriginals.push([name, Original]);
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      bump();
      return new Original(...args);
    } as unknown as Record<string, unknown>;
    Object.setPrototypeOf(Wrapped, Original);
    Wrapped['prototype'] = Original.prototype;
    intl[name] = Wrapped;
  }
  return {
    count: () => calls,
    restore: () => {
      for (const [target, name, original] of originals) target[name] = original;
      for (const [name, Original] of intlOriginals) intl[name] = Original;
    },
  };
}

/** Real clock captured before jest.useFakeTimers() swaps Date/hrtime, so
 * durations are wall time rather than the seeded system time. */
const realDateNow: () => number = Date.now.bind(Date);
function wallMs(): number {
  return realDateNow();
}

async function runVariant(v: Variant): Promise<Outcome> {
  const started = wallMs();
  const failures: Failure[] = [];
  const estimates: Estimate[] = [];
  wipeRows();
  clearTryAgainHandoff();
  setActiveDataOwner(GUEST_DATA_OWNER);

  jest.setSystemTime(new Date(v.clockIso));
  const dims = {
    width: v.viewport.width,
    height: v.viewport.height,
    scale: 3,
    fontScale: v.fontScale,
  };
  Dimensions.set({ window: dims, screen: dims });
  (I18nManager as unknown as { isRTL: boolean }).isRTL = v.rtl;

  let seeded: SeededEvidence;
  try {
    seeded = await seedEvidence(v);
  } catch (error) {
    // A fixture that the real schema refuses is a harness bug, recorded as
    // its own outcome so the seed is never silently dropped from the table.
    return {
      seed: v.seed,
      variant: omitMarker(v),
      state: 'threw',
      expectReady: false,
      expectSequence: false,
      expectClip: false,
      interactive: [],
      texts: [],
      digest: digestOf([]),
      localeApiCalls: 0,
      failures: [
        {
          oracle: 'HARNESS',
          detail: `seedEvidence threw: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      estimates: [],
      durationMs: wallMs() - started,
    };
  }
  const params: Record<string, unknown> = {
    analysisId: seeded.analysisId,
    ...phaseParamFor(v, seeded),
  };
  const navRef = createNavigationContainerRef<RootStackParams>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const spies = installLocaleSpies();

  let renderer: ReactTestRenderer | null = null;
  const fedLabel = { width: 0, height: 0 };
  let state: Outcome['state'] = 'loading';
  let texts: string[] = [];
  const interactive: Outcome['interactive'] = [];
  try {
    await act(async () => {
      renderer = TestRenderer.create(
        <Shell navRef={navRef} params={params} queryClient={queryClient} />,
      );
    });
    mounted.push(renderer!);
    // Evidence + sidecar promises settle over a few microtask turns.
    for (let i = 0; i < 40; i += 1) {
      await flush();
      const tree = renderer!.toJSON();
      const flatTexts = collectTexts(tree);
      if (flatTexts.some(t => t.includes('Preparing your form review')))
        continue;
      break;
    }
    const r = renderer!;

    // Stage + timeline + arrow-label layout, as the native view would report.
    const stageHeight = Math.round(
      Math.min(560, Math.max(300, v.viewport.height * 0.52)),
    );
    const stageWidth = v.viewport.width - 2 * 24;
    await feedLayout(r, 'form-review-stage', {
      width: stageWidth,
      height: stageHeight,
    });
    await feedLayout(r, 'form-review-timeline', {
      width: stageWidth - 8 - 44,
      height: 32,
    });
    const labelNode = r.root.findAll(
      n =>
        n.props.testID === 'form-review-arrow-label' &&
        typeof n.props.onLayout === 'function',
    )[0];
    if (labelNode) {
      const label = collectTexts(
        findHost(r.toJSON(), 'form-review-arrow-label'),
      ).join('');
      fedLabel.width = Math.round(estimateWidth(label, 11, v.fontScale) + 20);
      fedLabel.height = Math.round(14 * v.fontScale + 12);
      await act(async () => {
        labelNode.props.onLayout({
          nativeEvent: { layout: { x: 0, y: 0, ...fedLabel } },
        });
      });
    }

    // Transport interactions (bit flags), then the seeded CTA.
    const bits = v.transport;
    const pressIf = async (bit: number, testID: string) => {
      if (!(bits & bit)) return;
      const node = findPressable(r, testID);
      if (!node) return;
      await act(async () => {
        node.props.onPress();
      });
      await flush();
    };
    await pressIf(1, 'form-review-speed');
    await pressIf(2, 'form-review-next-stop');
    await pressIf(4, 'form-review-prev-stop');
    await pressIf(8, 'form-review-play');
    if (bits & 8) {
      act(() => {
        jest.advanceTimersByTime(700);
      });
    }
    await pressIf(16, 'form-review-autopause');

    const tree = r.toJSON();
    texts = collectTexts(tree);
    if (texts.some(t => t.includes('Preparing your form review')))
      state = 'loading';
    else if (texts.some(t => t.includes('Review unavailable')))
      state = 'missing';
    else if (findHost(tree, 'form-review-screen')) state = 'ready';
    else state = 'loading';

    // R1 — state matches what the seeded rows predict.
    if (state === 'loading') {
      failures.push({
        oracle: 'R1',
        detail: 'screen never left the loading state',
      });
    } else if ((state === 'ready') !== seeded.expectReady) {
      failures.push({
        oracle: 'R1',
        detail: `state ${state}, seeded evidence predicts ${seeded.expectReady ? 'ready' : 'missing'}`,
      });
    }
    if (state === 'ready') {
      const caption = texts.find(
        t =>
          t.startsWith('No clip file') ||
          t.startsWith('The clip file is gone') ||
          t.startsWith('No verified pose sequence'),
      );
      const captionSaysNoPose =
        caption !== undefined &&
        (caption.startsWith('No verified pose') ||
          caption.startsWith('No clip file'));
      if (seeded.expectSequence && captionSaysNoPose) {
        failures.push({
          oracle: 'R1',
          detail: `sidecar should have loaded but caption reads: ${caption}`,
        });
      }
      if (!seeded.expectSequence && caption === undefined) {
        failures.push({
          oracle: 'R1',
          detail:
            'sidecar cannot load (hash/parse/missing) yet no partial-evidence caption is shown',
        });
      }
    }

    // R2 / R3 / R10 — text, labels and hints.
    const spoken: string[] = [];
    walk(tree, node => {
      for (const key of ['accessibilityLabel', 'accessibilityHint']) {
        const value = node.props[key];
        if (typeof value === 'string') spoken.push(value);
      }
    });
    for (const s of [...texts, ...spoken]) {
      if (LEAK_TOKENS.test(s))
        failures.push({
          oracle: 'R2',
          detail: `boundary token leaked: ${JSON.stringify(s)}`,
        });
      if (s.includes(v.marker))
        failures.push({
          oracle: 'R3',
          detail: `persisted string reached the tree: ${JSON.stringify(s.slice(0, 80))}`,
        });
      if (DOSSIER_BAN.test(s))
        failures.push({
          oracle: 'R10',
          detail: `dossier vocabulary: ${JSON.stringify(s)}`,
        });
      // R13 — a checkpoint score is a 0–100 quantity; anything else on
      // screen is persisted data shown without a range check.
      for (const match of s.matchAll(/scored (-?[\d.e+]+)/g)) {
        const value = Number(match[1]);
        if (!Number.isFinite(value) || value < 0 || value > 100) {
          failures.push({
            oracle: 'R13',
            detail: `out-of-range score shown: ${JSON.stringify(s)}`,
          });
        }
      }
    }

    // R4 / R5 / R6 — interactive nodes.
    const interactiveNodes: { node: HostNode; parents: HostNode[] }[] = [];
    walk(tree, (node, _depth, parents) => {
      if (isInteractive(node)) interactiveNodes.push({ node, parents });
    });
    for (const { node, parents } of interactiveNodes) {
      const role =
        typeof node.props['accessibilityRole'] === 'string'
          ? node.props['accessibilityRole']
          : null;
      const label =
        typeof node.props['accessibilityLabel'] === 'string'
          ? node.props['accessibilityLabel']
          : null;
      const testID =
        typeof node.props['testID'] === 'string' ? node.props['testID'] : null;
      const box = targetBox(node);
      interactive.push({ testID, role, label, box });
      const name = testID ?? label ?? role ?? node.type;
      if (role === null || !INTERACTIVE_ROLES.has(role)) {
        failures.push({
          oracle: 'R4',
          detail: `${name}: interactive without an interactive accessibilityRole (role=${role})`,
        });
      }
      if (
        (label === null || label.trim().length === 0) &&
        textOf(node).trim().length === 0
      ) {
        failures.push({
          oracle: 'R4',
          detail: `${name}: interactive without accessibilityLabel or text`,
        });
      }
      if (box.height !== null && box.height < 44) {
        failures.push({
          oracle: 'R5',
          detail: `${name}: touch height ${box.height}pt < 44pt`,
        });
      }
      if (box.width !== null && box.width < 44) {
        failures.push({
          oracle: 'R5',
          detail: `${name}: touch width ${box.width}pt < 44pt`,
        });
      }
      if (box.height === null && !box.flex) {
        estimates.push({
          oracle: 'R5',
          detail: `${name}: touch height is layout-derived (unmeasured in Jest)`,
        });
      }
      if (parents.some(isInteractive)) {
        failures.push({
          oracle: 'R6',
          detail: `${name}: nested inside another interactive element`,
        });
      }
    }

    // R7 — non-finite numbers anywhere in host props/styles.
    walk(tree, node => {
      const bad = nonFinite(node.props);
      if (bad)
        failures.push({
          oracle: 'R7',
          detail: `${node.props['testID'] ?? node.type}: ${bad}`,
        });
    });

    // R8 — absolutely positioned stage children inside the stage box.
    const stage = findHost(tree, 'form-review-stage');
    if (stage) {
      walk(hostChildren(stage), child => {
        const s = flat(child.props['style']);
        if (
          s['position'] !== 'absolute' ||
          typeof child.props['testID'] !== 'string'
        )
          return;
        const id = String(child.props['testID']);
        const left = typeof s['left'] === 'number' ? s['left'] : null;
        const top = typeof s['top'] === 'number' ? s['top'] : null;
        // The arrow label's box is the width/height this harness FED to its
        // onLayout (a glyph-width ESTIMATE), so its edges are inferred.
        const isLabel = id === 'form-review-arrow-label';
        const w = isLabel
          ? fedLabel.width
          : typeof s['width'] === 'number'
            ? s['width']
            : null;
        const h = isLabel
          ? fedLabel.height
          : typeof s['height'] === 'number'
            ? s['height']
            : null;
        const sink = isLabel ? estimates : failures;
        const tag = isLabel ? ' (ESTIMATE: box = fed label layout)' : '';
        if (left !== null && left < 0) {
          sink.push({
            oracle: 'R8',
            detail: `${id}: left=${left} — clipped by stage overflow:hidden${tag}`,
          });
        }
        if (top !== null && top < 0) {
          sink.push({
            oracle: 'R8',
            detail: `${id}: top=${top} — clipped by stage overflow:hidden${tag}`,
          });
        }
        if (left !== null && w !== null && left + w > stageWidth) {
          sink.push({
            oracle: 'R8',
            detail: `${id}: right edge ${left + w} > stage width ${stageWidth}${tag}`,
          });
        }
        if (top !== null && h !== null && top + h > stageHeight) {
          sink.push({
            oracle: 'R8',
            detail: `${id}: bottom edge ${top + h} > stage height ${stageHeight}${tag}`,
          });
        }
      });
    }

    // R9 — one-line texts vs the column at this font scale (ESTIMATE).
    walk(tree, node => {
      if (node.type !== 'Text' || node.props['numberOfLines'] !== 1) return;
      const s = flat(node.props['style']);
      const fontSize = typeof s['fontSize'] === 'number' ? s['fontSize'] : 16;
      const text = textOf(node);
      const column = stageWidth;
      const width = estimateWidth(text, fontSize, v.fontScale);
      if (width > column) {
        estimates.push({
          oracle: 'R9',
          detail: `numberOfLines=1 text ≈${Math.round(width)}pt > ${column}pt column at ×${v.fontScale}: ${JSON.stringify(text)}`,
        });
      }
    });

    // R11 — controls through the real navigator.
    if (state !== 'loading') {
      const beforeTop = topRouteOf(navRef.getRootState());
      if (beforeTop !== 'FormReview') {
        failures.push({
          oracle: 'R11',
          detail: `navigator top route is ${beforeTop} before the CTA`,
        });
      }
      if (v.cta === 'back' || v.cta === 'header-close') {
        const node =
          v.cta === 'back'
            ? (findPressable(r, 'form-review-back') ??
              findPressableByLabel(r, 'Try again'))
            : (findPressableByLabel(r, 'Close') ??
              findPressableByLabel(r, 'Try again'));
        if (!node) {
          failures.push({
            oracle: 'R11',
            detail: `${v.cta}: no pressable found`,
          });
        } else {
          await act(async () => {
            node.props.onPress();
          });
          await flush(2);
          const top = topRouteOf(navRef.getRootState());
          if (top !== 'Result') {
            failures.push({
              oracle: 'R11',
              detail: `${v.cta}: expected Result on top after goBack, got ${top}`,
            });
          }
        }
      } else if (v.cta === 'reanalyze' && state === 'ready') {
        const node = findPressable(r, 'form-review-reanalyze');
        if (!node) {
          failures.push({
            oracle: 'R11',
            detail: 'reanalyze: no pressable found',
          });
        } else {
          await act(async () => {
            node.props.onPress();
          });
          await flush(2);
          const topRoute = topRouteEntry(navRef.getRootState());
          if (topRoute?.name !== 'Analyze') {
            failures.push({
              oracle: 'R11',
              detail: `reanalyze: expected Analyze on top, got ${topRoute?.name}`,
            });
          } else if (
            (topRoute.params as { source?: string } | undefined)?.source !==
            'camera'
          ) {
            failures.push({
              oracle: 'R11',
              detail: `reanalyze: Analyze params ${JSON.stringify(topRoute.params)}`,
            });
          }
          const handoff = peekTryAgainHandoff();
          if (!handoff) {
            failures.push({
              oracle: 'R11',
              detail: 'reanalyze: no try-again handoff armed',
            });
          } else if (
            handoff.declaredStroke !== null &&
            !(SHOT_TYPES as readonly string[]).includes(
              handoff.declaredStroke as string,
            )
          ) {
            failures.push({
              oracle: 'R11',
              detail: `reanalyze: handoff.declaredStroke is not a canonical slug: ${JSON.stringify(String(handoff.declaredStroke).slice(0, 60))}`,
            });
          }
        }
      }
    }
  } catch (error) {
    state = 'threw';
    failures.push({
      oracle: 'R1',
      detail: `threw: ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`,
    });
  } finally {
    spies.restore();
  }

  const outcome: Outcome = {
    seed: v.seed,
    variant: omitMarker(v),
    state,
    expectReady: seeded.expectReady,
    expectSequence: seeded.expectSequence,
    expectClip: seeded.expectClip,
    interactive,
    texts,
    digest: digestOf(texts),
    localeApiCalls: spies.count(),
    failures,
    estimates,
    durationMs: wallMs() - started,
  };
  if (spies.count() > 0) {
    outcome.failures.push({
      oracle: 'R12',
      detail: `${spies.count()} locale-sensitive formatting call(s) during render`,
    });
  }
  return outcome;
}

type NavRootState = NonNullable<
  ReturnType<
    ReturnType<
      typeof createNavigationContainerRef<RootStackParams>
    >['getRootState']
  >
>;

/** Top route entry of the container state, or null while the navigator has
 * not mounted yet (getRootState() is typed non-null but the reference is
 * unattached until the first render). */
function topRouteEntry(
  state: NavRootState | undefined,
): NavRootState['routes'][number] | null {
  if (!state) return null;
  return state.routes[state.routes.length - 1] ?? null;
}

function topRouteOf(state: NavRootState | undefined): string | null {
  return topRouteEntry(state)?.name ?? null;
}

function omitMarker(v: Variant): Omit<Variant, 'marker'> {
  const rest: Partial<Variant> = { ...v };
  delete rest.marker;
  return rest as Omit<Variant, 'marker'>;
}

function collectTexts(tree: HostNode | HostNode[] | null): string[] {
  const out: string[] = [];
  walk(tree, node => {
    if (node.type !== 'Text') return;
    // Only leaf Text (avoid double counting nested Text).
    if (hostChildren(node).some(c => c.type === 'Text')) return;
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    if (text.length) out.push(text);
  });
  return out;
}

function findHost(
  tree: HostNode | HostNode[] | null,
  testID: string,
): HostNode | null {
  let found: HostNode | null = null;
  walk(tree, node => {
    if (found === null && node.props['testID'] === testID) found = node;
  });
  return found;
}

function findPressable(
  r: ReactTestRenderer,
  testID: string,
): ReactTestInstance | null {
  return (
    r.root.findAll(
      n => n.props.testID === testID && typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}

function findPressableByLabel(
  r: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  return (
    r.root.findAll(
      n =>
        n.props.accessibilityLabel === label &&
        typeof n.props.onPress === 'function',
    )[0] ?? null
  );
}

async function feedLayout(
  r: ReactTestRenderer,
  testID: string,
  layout: { width: number; height: number },
): Promise<void> {
  const node = r.root.findAll(
    n => n.props.testID === testID && typeof n.props.onLayout === 'function',
  )[0];
  if (!node) return;
  await act(async () => {
    node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, ...layout } } });
  });
}

function nonFinite(value: unknown, path = 'props', depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? null : `${path}=${String(value)}`;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const bad = nonFinite(value[i], `${path}[${i}]`, depth + 1);
      if (bad) return bad;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (key === 'children') continue;
      if (typeof child === 'function') continue;
      const bad = nonFinite(child, `${path}.${key}`, depth + 1);
      if (bad) return bad;
    }
  }
  return null;
}

// ─── Campaign plumbing ───────────────────────────────────────────────────────

const env = process.env;
const BASE_SEED = Number(env['STRESS_SEED'] ?? 20260904);
const ITER = Math.max(1, Number(env['STRESS_ITER'] ?? 12));
const REPEAT = Math.max(1, Number(env['STRESS_REPEAT'] ?? 1));
const ONLY = (env['STRESS_ONLY'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_DIR =
  env['STRESS_OUT'] ??
  nodePath.resolve(
    __dirname,
    '..',
    '..',
    'artifacts',
    'stress',
    'formReviewScreen-boundary-i18n-a11y',
  );
const TAG = env['STRESS_TAG'] ?? 'run';

const seeds: number[] = ONLY.length
  ? ONLY
  : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);

const outcomes: Outcome[] = [];

beforeAll(() => {
  mockSqlite.db = new DatabaseSync(':memory:');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  jest.useFakeTimers();
});

afterEach(() => {
  for (const r of mounted.splice(0)) {
    try {
      act(() => {
        r.unmount();
      });
    } catch {
      // A renderer that already threw is not part of the evidence.
    }
  }
});

afterAll(() => {
  jest.useRealTimers();
  const table = outcomes.map(o => ({
    seed: o.seed,
    outcome: o.failures.length ? 'BROKEN' : 'HELD',
    state: o.state,
    expectReady: o.expectReady,
    expectSequence: o.expectSequence,
    family: o.variant.family,
    locale: o.variant.locale,
    rtl: o.variant.rtl,
    timeZone: o.variant.timeZone,
    clockIso: o.variant.clockIso,
    fontScale: o.variant.fontScale,
    viewport: `${o.variant.viewport.width}x${o.variant.viewport.height}`,
    stringKit: o.variant.stringKit,
    analysisIdKind: o.variant.analysisIdKind,
    phaseParam: o.variant.phaseParam,
    cta: o.variant.cta,
    transport: o.variant.transport,
    interactiveCount: o.interactive.length,
    digest: o.digest,
    localeApiCalls: o.localeApiCalls,
    failures: o.failures,
    estimates: o.estimates,
    durationMs: o.durationMs,
  }));
  const summary = {
    tag: TAG,
    baseSeed: BASE_SEED,
    iterations: outcomes.length,
    processTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    processLocale: Intl.DateTimeFormat().resolvedOptions().locale,
    broken: table.filter(t => t.outcome === 'BROKEN').map(t => t.seed),
    estimatesBySeed: table
      .filter(t => t.estimates.length)
      .map(t => ({ seed: t.seed, estimates: t.estimates })),
    coverage: coverage(outcomes),
  };
  fs.writeFileSync(
    nodePath.join(OUT_DIR, `${TAG}.results.json`),
    JSON.stringify({ summary, table }, null, 2),
  );
  fs.writeFileSync(
    nodePath.join(OUT_DIR, `${TAG}.interactive.json`),
    JSON.stringify(
      outcomes.map(o => ({
        seed: o.seed,
        state: o.state,
        interactive: o.interactive,
      })),
      null,
      2,
    ),
  );
});

function coverage(all: Outcome[]): Record<string, Record<string, number>> {
  const tally = (key: (o: Outcome) => string) => {
    const out: Record<string, number> = {};
    for (const o of all) out[key(o)] = (out[key(o)] ?? 0) + 1;
    return out;
  };
  return {
    family: tally(o => o.variant.family),
    locale: tally(o => o.variant.locale),
    timeZone: tally(o => o.variant.timeZone),
    fontScale: tally(o => String(o.variant.fontScale)),
    viewport: tally(
      o => `${o.variant.viewport.width}x${o.variant.viewport.height}`,
    ),
    stringKit: tally(o => o.variant.stringKit),
    phaseParam: tally(o => o.variant.phaseParam),
    cta: tally(o => o.variant.cta),
    state: tally(o => o.state),
  };
}

describe('FormReviewScreen · boundary / i18n / a11y stress (seeded, replayable)', () => {
  for (const seed of seeds) {
    for (let repeat = 0; repeat < REPEAT; repeat += 1) {
      const suffix = REPEAT > 1 ? ` #${repeat + 1}` : '';
      it(`seed ${seed}${suffix} renders inside the real navigator and holds every oracle`, async () => {
        const variant = variantFor(seed);
        const outcome = await runVariant(variant);
        outcomes.push(outcome);
        if (outcome.failures.length) {
          const tree = mounted[mounted.length - 1]?.toJSON() ?? null;
          fs.writeFileSync(
            nodePath.join(
              OUT_DIR,
              `${TAG}.seed-${seed}${REPEAT > 1 ? `-r${repeat + 1}` : ''}.tree.json`,
            ),
            JSON.stringify(
              { variant: omitMarker(variant), outcome, tree },
              null,
              2,
            ),
          );
        }
        expect(outcome.failures.map(f => `${f.oracle}: ${f.detail}`)).toEqual(
          [],
        );
      });
    }
  }
});
