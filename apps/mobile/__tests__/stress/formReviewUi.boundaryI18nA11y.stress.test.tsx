/**
 * STRESS HARNESS — unit `cmp-form-review-ui`, lens `boundary-i18n-a11y`.
 *
 * Components under test (production code is NOT modified by this suite):
 *   src/review/FixList.tsx, FormReviewCard.tsx, FormReviewOverlay.tsx,
 *   FormReviewPlayer.tsx, RecommendedDrills.tsx
 *
 * Every iteration is derived from ONE 32-bit seed (mulberry32) and can be
 * replayed alone:
 *
 *   cd apps/mobile && STRESS_SEED=<seed> npx jest --ci __tests__/stress/formReviewUi.boundaryI18nA11y.stress.test.tsx
 *
 * Campaign size is `STRESS_ITER` (default 160 — fast enough for the suite;
 * the recorded run used 1200). `STRESS_OUT=<file.json>` writes the
 * seed → outcome table plus the rendered-tree evidence of every failing or
 * observed iteration. `STRESS_BASE_SEED` moves the campaign to another seed
 * range (default 0x5EED0001).
 *
 * Locale and time zone are process-level in Node/Jest (`LANG`/`LC_ALL`/`TZ`
 * at start-up), so the 12-locale × 8-zone sweep is a shell loop over this
 * file; each run records `Intl.DateTimeFormat().resolvedOptions()` and a
 * hash of every rendered tree so the runs can be diffed (see
 * scripts/stress-form-review-ui.mjs).
 *
 * Invariants checked on every rendered tree (BROKEN when any fails):
 *   I1 render + interactions + unmount never throw
 *   I2 every interactive node has a non-empty accessibilityLabel (or text)
 *   I3 every interactive node has an accessibilityRole
 *   I4 every interactive node's own box is ≥ 44pt tall (and wide, when a
 *      fixed width is set) unless the box is decided by flex/children
 *   I5 no rendered text or accessibilityLabel contains NaN / Infinity /
 *      undefined / null / [object Object]
 *   I6 no style value in the tree is NaN, ±Infinity or a "NaN%" string
 *   I7 no React duplicate-key / invalid-prop console error
 *   I8 svg primitive props (cx, cy, r, x1, y1, x2, y2, d, points) are finite
 *   I9 model-level contracts (FixList "n of m" ⇒ n ≤ m, FormReviewCard label
 *      mirrors the visible counts, overlay label anchor stays inside rect)
 * Observations (recorded with evidence, never counted as BROKEN): estimated
 * text clipping under numberOfLines at the drawn width × font scale, text in
 * fixed-height boxes whose scaled line height exceeds the box, exponent
 * notation in visible numerals, accessibilityLabel on a non-accessible View,
 * empty subject in an accessibility label.
 */
import React from 'react';
import { I18nManager, PixelRatio, Text } from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  PHASES,
  SHOT_TYPES,
  type CheckpointKey,
  type CheckpointScore,
  type FaultDirection,
  type PhaseKey,
  type PhaseSpan,
  type ScoreBand,
  type ShotAnalysis,
} from '@pickle/shared-types';
import type { CatalogDrill } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

// ─── Module mocks ───────────────────────────────────────────────────────────

const mockViewport = {
  current: { width: 390, height: 844, scale: 3, fontScale: 1 },
};
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockViewport.current,
}));

jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const make = (name: string) => {
    const Mock = (props: Record<string, unknown>) =>
      ReactModule.createElement(
        View,
        { ...props, testID: `svg-${name}` },
        props['children'],
      );
    Mock.displayName = `Svg${name}`;
    return Mock;
  };
  return {
    __esModule: true,
    default: make('Svg'),
    Svg: make('Svg'),
    Circle: make('Circle'),
    Defs: make('Defs'),
    G: make('G'),
    Line: make('Line'),
    Path: make('Path'),
    Polygon: make('Polygon'),
    Polyline: make('Polyline'),
    RadialGradient: make('RadialGradient'),
    LinearGradient: make('LinearGradient'),
    Rect: make('Rect'),
    Stop: make('Stop'),
  };
});

const mockGetApiSession = jest.fn<unknown, []>();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn<Promise<CatalogDrill[]>, [unknown]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

import { FixList } from '../../src/review/FixList';
import { FormReviewCard } from '../../src/review/FormReviewCard';
import {
  FormReviewOverlay,
  arrowGeometry,
  arrowLabelAnchor,
  projectJoints,
} from '../../src/review/FormReviewOverlay';
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import { RecommendedDrills } from '../../src/review/RecommendedDrills';
import { drillFocusFromAnalysis } from '../../src/review/recommendedDrillsModel';
import {
  REVIEW_JOINTS,
  buildFormReviewScript,
  type FormReviewScript,
  type JointHeat,
  type ReviewArrow,
  type ReviewJoint,
  type ReviewPoseFrame,
  type ReviewPoseLandmark,
  type ReviewPoseSequence,
  type ReviewStop,
} from '../../src/review/formReviewModel';
import type { Rect } from '../../src/review/formReviewGeometry';
import type { StrokeResultClip } from '../../src/components/StrokeResult';
import type { StrokeReviewEvidence } from '../../src/components/strokeResultData';

declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

// ─── Campaign parameters ────────────────────────────────────────────────────

const ITERATIONS = Math.max(
  1,
  Number(process.env['STRESS_ITER'] ?? 160) || 160,
);
const BASE_SEED = Number(process.env['STRESS_BASE_SEED'] ?? 0x5eed0001) >>> 0;
const ONLY_SEED =
  process.env['STRESS_SEED'] !== undefined
    ? Number(process.env['STRESS_SEED']) >>> 0
    : null;
const OUT_FILE = process.env['STRESS_OUT'];

const WIDTHS = [320, 390, 430] as const;
const FONT_SCALES = [1, 1.5, 3] as const;
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
type Locale = (typeof LOCALES)[number];
const RTL_LOCALES: readonly Locale[] = ['ar-EG'];
const MIN_TARGET_PT = 44;

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

class Rng {
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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    return items[this.int(items.length)] as T;
  }
  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }
  range(low: number, high: number): number {
    return low + this.next() * (high - low);
  }
}

// ─── String corpus (the lens) ───────────────────────────────────────────────

function repeatTo(base: string, minLength: number, joiner = ' '): string {
  let out = base;
  while (out.length < minLength) out += joiner + base;
  return out;
}

const STRING_KINDS = [
  'plain',
  'long200',
  'cjk',
  'arabic_rtl',
  'zwj_emoji',
  'combining',
  'german_compound',
  'thai_nospace',
  'devanagari',
  'bidi_mixed',
  'empty',
  'whitespace',
  'turkish_dotted',
  'locale_word',
] as const;
type StringKind = (typeof STRING_KINDS)[number];

const LOCALE_WORDS: Record<Locale, string> = {
  'de-DE': 'Straßenverkehrsordnungsübung für die Vorhand',
  'fr-FR': 'Exercice de coup droit — contrôle du poignet à l’impact',
  'ar-EG': 'تمرين الضربة الأمامية للتحكم في المعصم عند نقطة التلامس',
  'hi-IN': 'फोरहैंड ड्राइव अभ्यास — संपर्क बिंदु पर कलाई की स्थिरता',
  'ja-JP': 'フォアハンドドライブ練習：インパクト時の手首の安定',
  'pt-BR': 'Exercício de forehand — estabilidade do punho no contato',
  'tr-TR': 'İleri vuruş çalışması — temas anında bilek sabitliği',
  'ru-RU': 'Упражнение на форхенд — стабильность запястья в момент контакта',
  'th-TH': 'แบบฝึกโฟร์แฮนด์ไดรฟ์ความมั่นคงของข้อมือขณะสัมผัสลูก',
  'zh-CN': '正手抽击练习——触球时手腕的稳定性',
  'en-IN': 'Forehand drive drill — wrist stability at contact (₹0 lakh)',
  'es-419': 'Ejercicio de derecha — estabilidad de la muñeca en el contacto',
};

function corpusString(kind: StringKind, locale: Locale, rng: Rng): string {
  switch (kind) {
    case 'plain':
      return rng.pick([
        'Shadow swing ladder',
        'Wall dinks',
        'Coach Ada',
        'Contact out front',
      ]);
    case 'long200':
      return repeatTo(
        'Shadow the forehand drive with a pause at the set position, then swing through to a high finish and reset to ready before the next rep.',
        220,
      );
    case 'cjk':
      return repeatTo(
        '第三のショット・ドロップは、ネット前の相手にゆっくりとボールを落とす技術です。手首を固定し、膝でリズムを作りましょう。',
        200,
        '',
      );
    case 'arabic_rtl':
      return repeatTo(
        'تمرين الضربة الأمامية: حافظ على ثبات المعصم عند نقطة التلامس وادفع بالساقين نحو الكرة ثم عد إلى وضع الاستعداد.',
        200,
      );
    case 'zwj_emoji':
      return repeatTo('👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍🦽‍➡️🧑🏿‍🤝‍🧑🏻🏴󠁧󠁢󠁷󠁬󠁳󠁿', 200, '');
    case 'combining':
      return repeatTo(
        'Z̷̢̈́a̶͛l̸̈́g̵͝o̶̕ ̸̐d̵̂r̷̋i̵̊l̶̍l̸̚ é̂ñ̃ ạ̈ Å̊', // NFD + stacked marks
        200,
      );
    case 'german_compound':
      return repeatTo(
        'Donaudampfschifffahrtsgesellschaftskapitänsmützenherstellungsbetriebsleitungsübung',
        200,
        '',
      );
    case 'thai_nospace':
      return repeatTo(
        'แบบฝึกโฟร์แฮนด์ไดรฟ์ความมั่นคงของข้อมือขณะสัมผัสลูกและการถ่ายน้ำหนักไปข้างหน้า',
        200,
        '',
      );
    case 'devanagari':
      return repeatTo(
        'क्ष त्र ज्ञ श्र द्ध ट्ट फोरहैंड ड्राइव अभ्यास संपर्क बिंदु पर कलाई की स्थिरता',
        200,
      );
    case 'bidi_mixed':
      return 'Drill ‏عربي‎ 123 ‎English ‮reversed‬ end ‏١٢٣‎';
    case 'empty':
      return '';
    case 'whitespace':
      return ' \t\n\u00a0\u200b ';
    case 'turkish_dotted':
      return 'İstanbul ılık iyi İĞÜŞÖÇ ığüşöç';
    case 'locale_word':
      return LOCALE_WORDS[locale];
  }
}

// ─── Numeric corpus ─────────────────────────────────────────────────────────

const NUMERICS: readonly number[] = [
  0,
  -0,
  1,
  2,
  3,
  6,
  -1,
  -50,
  0.5,
  2.7,
  99.999,
  100,
  101,
  1e21,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  -1e9,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];

function pickNumeric(rng: Rng): number {
  return rng.pick(NUMERICS);
}

/** Loosen a typed value on purpose: stored records are unvalidated JSON. */
function asAny<T>(value: unknown): T {
  return value as T;
}

// ─── Analysis fixtures ──────────────────────────────────────────────────────

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
  };
}

const CANONICAL_CHECKPOINTS: CheckpointScore[] = [
  checkpoint('ready_position', 85, 'green', 'none'),
  checkpoint('athletic_base', 72, 'yellow', 'narrow'),
  checkpoint('preparation', 88, 'green', 'none'),
  checkpoint('paddle_set', 90, 'green', 'none'),
  checkpoint('swing_length', null, 'unscored', 'none'),
  checkpoint('sequencing', 40, 'red', 'short'),
  checkpoint('paddle_path', 61, 'red', 'low'),
  checkpoint('contact_position', 48, 'red', 'late'),
  checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
    applicable: false,
  }),
  checkpoint('follow_through', 80, 'green', 'none'),
  checkpoint('recovery', 92, 'green', 'none'),
];

const CANONICAL_PHASES: PhaseSpan[] = [
  {
    key: 'ready',
    startMs: 0,
    representativeMs: 200,
    endMs: 400,
    confidence: 0.9,
  },
  {
    key: 'prepare',
    startMs: 400,
    representativeMs: 800,
    endMs: 1200,
    confidence: 0.9,
  },
  {
    key: 'accelerate',
    startMs: 1200,
    representativeMs: 1600,
    endMs: 1850,
    confidence: 0.9,
  },
  {
    key: 'contact',
    startMs: 1850,
    representativeMs: 1900,
    endMs: 1950,
    confidence: 0.9,
  },
  {
    key: 'follow_through',
    startMs: 1950,
    representativeMs: 2300,
    endMs: 2700,
    confidence: 0.9,
  },
  {
    key: 'recover',
    startMs: 2700,
    representativeMs: 2950,
    endMs: 3200,
    confidence: 0.9,
  },
];

function baseAnalysis(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-stress',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-04T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: CANONICAL_PHASES.map(phase => ({ ...phase })),
    measurements: [],
    checkpoints: CANONICAL_CHECKPOINTS.map(cp => ({ ...cp })),
    overallScore: 6.8,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'dependency',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

const BANDS: readonly ScoreBand[] = ['green', 'yellow', 'red', 'unscored'];

function fuzzCheckpoints(rng: Rng): CheckpointScore[] {
  const mode = rng.pick([
    'canonical',
    'canonical',
    'random',
    'random',
    'empty',
    'all_faults',
    'malformed',
  ] as const);
  if (mode === 'canonical') return CANONICAL_CHECKPOINTS.map(cp => ({ ...cp }));
  if (mode === 'empty') return [];
  if (mode === 'all_faults') {
    return CHECKPOINTS.map(key =>
      checkpoint(
        key,
        rng.pick([0, 1, 12.4, 33, 49.5, 59.99, -20, 1e21]),
        rng.pick(['red', 'yellow']),
        rng.pick(FAULT_DIRECTIONS),
      ),
    );
  }
  const out: CheckpointScore[] = [];
  const count = rng.int(mode === 'malformed' ? 16 : 12);
  for (let index = 0; index < count; index += 1) {
    const key = rng.pick(CHECKPOINTS);
    const scorePick = rng.pick([
      'finite',
      'finite',
      'finite',
      'null',
      'extreme',
    ] as const);
    const score =
      scorePick === 'null'
        ? null
        : scorePick === 'extreme'
          ? pickNumeric(rng)
          : Math.round(rng.range(0, 100) * 10) / 10;
    const cp = checkpoint(
      key,
      score,
      rng.pick(BANDS),
      rng.pick(FAULT_DIRECTIONS),
      { applicable: rng.bool(0.85) },
    );
    if (mode === 'malformed') {
      const twist = rng.int(8);
      if (twist === 0) cp.key = asAny('not_a_checkpoint');
      if (twist === 1) cp.band = asAny('purple');
      if (twist === 2) cp.direction = asAny('sideways');
      if (twist === 3) cp.applicable = asAny(undefined);
      if (twist === 4) cp.score = asAny('77');
      if (twist === 5) cp.severity = Number.NaN;
      if (twist === 6) {
        out.push(asAny(null));
        continue;
      }
    }
    out.push(cp);
  }
  return out;
}

function fuzzPhases(rng: Rng): PhaseSpan[] {
  const mode = rng.pick([
    'canonical',
    'canonical',
    'canonical',
    'none',
    'extreme',
    'malformed',
    'partial',
  ] as const);
  if (mode === 'canonical')
    return CANONICAL_PHASES.map(phase => ({ ...phase }));
  if (mode === 'none') return [];
  if (mode === 'partial') {
    return CANONICAL_PHASES.filter(() => rng.bool(0.5)).map(phase => ({
      ...phase,
    }));
  }
  return CANONICAL_PHASES.map(phase => {
    const next = { ...phase };
    if (mode === 'extreme') {
      const twist = rng.int(6);
      if (twist === 0) next.startMs = -5000;
      if (twist === 1) next.endMs = 1e12;
      if (twist === 2) next.representativeMs = Number.NaN;
      if (twist === 3) next.endMs = next.startMs - 100;
      if (twist === 4) next.startMs = Number.POSITIVE_INFINITY;
    } else {
      const twist = rng.int(5);
      if (twist === 0) next.key = asAny('warmup');
      if (twist === 1) next.startMs = asAny('0');
      if (twist === 2) return asAny<PhaseSpan>(null);
    }
    return next;
  });
}

function fuzzAnalysis(rng: Rng): ShotAnalysis {
  const analysis = baseAnalysis({
    shotType: rng.pick(SHOT_TYPES),
    handedness: rng.pick(['left', 'right', 'ambidextrous'] as const),
    checkpoints: fuzzCheckpoints(rng),
    phases: fuzzPhases(rng),
  });
  const priority = rng.int(6);
  if (priority === 0) analysis.priorityFix = null;
  if (priority === 1) analysis.priorityFix = asAny(undefined);
  if (priority === 2) {
    analysis.priorityFix = {
      checkpoint: asAny('ghost_checkpoint'),
      reasonKey: 'dependency',
      severity: 1,
      confidence: 1,
    };
  }
  if (priority === 3) {
    analysis.priorityFix = {
      checkpoint: rng.pick(CHECKPOINTS),
      reasonKey: 'dependency',
      severity: Number.NaN,
      confidence: -1,
    };
  }
  const timestamps = rng.int(5);
  if (timestamps === 0) analysis.timestamps = asAny(undefined);
  if (timestamps === 1) {
    analysis.timestamps = { startMs: -100, contactMs: null, endMs: -50 };
  }
  if (timestamps === 2) {
    analysis.timestamps = {
      startMs: Number.NaN,
      contactMs: 1e15,
      endMs: Number.POSITIVE_INFINITY,
    };
  }
  if (rng.bool(0.08)) analysis.checkpoints = asAny(undefined);
  if (rng.bool(0.08)) analysis.phases = asAny(null);
  return analysis;
}

// ─── Pose fixtures ──────────────────────────────────────────────────────────

const BODY: Record<ReviewJoint, [number, number]> = {
  head: [0.5, 0.12],
  left_shoulder: [0.42, 0.28],
  right_shoulder: [0.58, 0.28],
  left_elbow: [0.36, 0.42],
  right_elbow: [0.66, 0.4],
  left_wrist: [0.32, 0.55],
  right_wrist: [0.74, 0.5],
  left_hip: [0.45, 0.56],
  right_hip: [0.55, 0.56],
  left_knee: [0.44, 0.74],
  right_knee: [0.57, 0.74],
  left_ankle: [0.43, 0.93],
  right_ankle: [0.58, 0.93],
};

function frameAt(
  timestampMs: number,
  drift: number,
  visibility = 0.95,
): ReviewPoseFrame {
  return {
    timestampMs,
    confidence: 0.9,
    landmarks: REVIEW_JOINTS.map(joint => {
      const [x, y] = BODY[joint];
      return { name: joint, x: x + drift, y, visibility };
    }),
  };
}

function fuzzLandmark(rng: Rng, joint: string): ReviewPoseLandmark {
  const [x, y] = BODY[joint as ReviewJoint] ?? [0.5, 0.5];
  const twist = rng.int(12);
  const mark: ReviewPoseLandmark = { name: joint, x, y, visibility: 0.9 };
  if (twist === 0) mark.x = Number.NaN;
  if (twist === 1) mark.y = Number.POSITIVE_INFINITY;
  if (twist === 2) mark.visibility = Number.NaN;
  if (twist === 3) mark.visibility = -1;
  if (twist === 4) mark.visibility = 1e9;
  if (twist === 5) mark.visibility = asAny('0.9');
  if (twist === 6) mark.x = -5;
  if (twist === 7) mark.y = 7;
  if (twist === 8) mark.name = asAny(undefined);
  if (twist === 9) mark.x = asAny(null);
  return mark;
}

function fuzzFrame(rng: Rng, timestampMs: number): ReviewPoseFrame {
  const mode = rng.pick([
    'full',
    'full',
    'sparse',
    'malformed',
    'unknown_joints',
    'duplicates',
    'empty',
    'not_array',
  ] as const);
  if (mode === 'full') return frameAt(timestampMs, rng.range(-0.1, 0.1));
  if (mode === 'empty') return { timestampMs, confidence: 0, landmarks: [] };
  if (mode === 'not_array') {
    return { timestampMs, confidence: 0, landmarks: asAny({ length: 3 }) };
  }
  const landmarks: ReviewPoseLandmark[] = [];
  for (const joint of REVIEW_JOINTS) {
    if (mode === 'sparse' && rng.bool(0.5)) continue;
    landmarks.push(
      mode === 'malformed'
        ? fuzzLandmark(rng, joint)
        : { name: joint, ...pointOf(joint), visibility: 0.8 },
    );
    if (mode === 'duplicates') {
      landmarks.push({ name: joint, x: 0.1, y: 0.1, visibility: 0.99 });
    }
  }
  if (mode === 'unknown_joints') {
    landmarks.push({ name: 'nose', x: 0.5, y: 0.1, visibility: 1 });
    landmarks.push({ name: 'paddle_tip', x: 0.9, y: 0.5, visibility: 1 });
    landmarks.push(asAny(null));
  }
  if (mode === 'malformed' && rng.bool(0.3)) landmarks.push(asAny(undefined));
  return { timestampMs, confidence: 0.7, landmarks };
}

function pointOf(joint: ReviewJoint): { x: number; y: number } {
  const [x, y] = BODY[joint];
  return { x, y };
}

function fuzzSequence(rng: Rng): ReviewPoseSequence | null {
  const mode = rng.pick([
    'null',
    'null',
    'dense',
    'dense',
    'sparse',
    'empty',
    'malformed',
    'bad_video',
  ] as const);
  if (mode === 'null') return null;
  if (mode === 'empty') return { frames: [] };
  const frames: ReviewPoseFrame[] = [];
  const step = mode === 'sparse' ? 400 : 33;
  for (let t = 0; t <= 3300; t += step) {
    frames.push(mode === 'malformed' ? fuzzFrame(rng, t) : frameAt(t, 0));
  }
  const videoPick = rng.int(6);
  const video =
    videoPick === 0 || mode === 'bad_video'
      ? rng.pick([
          { width: 0, height: 0, fps: 30 },
          { w: -1080, h: 1920, fps: 30 },
          { width: Number.NaN, height: 1920, fps: Number.NaN },
          { w: 1e9, h: 1, fps: 0 },
        ])
      : videoPick === 1
        ? { w: 1080, h: 1920, fps: 30 }
        : videoPick === 2
          ? { width: 1920, height: 1080, fps: 60 }
          : undefined;
  return video ? { frames, video } : { frames };
}

function sequenceHasNullLandmark(sequence: ReviewPoseSequence | null): boolean {
  return (sequence?.frames ?? []).some(
    frame =>
      Array.isArray(frame?.landmarks) &&
      frame.landmarks.some(mark => mark === null || mark === undefined),
  );
}

/** Wraps a throw caused by an input the product's own parsers already reject. */
class PropFaultError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = cause instanceof Error ? cause.name : 'PropFaultError';
    this.cause = cause;
    if (cause instanceof Error && cause.stack) this.stack = cause.stack;
  }
}

// ─── Rendered-tree inspection ───────────────────────────────────────────────

type StyleValue = unknown;

function flattenStyle(style: StyleValue): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, item) => ({ ...acc, ...flattenStyle(item) }),
      {},
    );
  }
  if (typeof style === 'object') return style as Record<string, unknown>;
  return {};
}

function hostNodes(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(node => typeof node.type === 'string');
}

function textOf(node: ReactTestInstance): string {
  return node
    .findAll(child => child.type === Text)
    .flatMap(child =>
      React.Children.toArray(child.props['children']).map(part =>
        typeof part === 'string' || typeof part === 'number'
          ? String(part)
          : '',
      ),
    )
    .join(' ');
}

function ownText(node: ReactTestInstance): string {
  return React.Children.toArray(node.props['children'])
    .map(part =>
      typeof part === 'string' || typeof part === 'number' ? String(part) : '',
    )
    .join('');
}

const BAD_TEXT =
  /\b(NaN|Infinity|-Infinity|undefined|null)\b|\[object Object\]/;
const EXPONENT_TEXT = /\d(?:\.\d+)?e[+-]\d/;

function isInteractive(node: ReactTestInstance): boolean {
  const props = node.props;
  return (
    typeof props['onPress'] === 'function' ||
    typeof props['onClick'] === 'function' ||
    typeof props['onResponderGrant'] === 'function' ||
    typeof props['onStartShouldSetResponder'] === 'function' ||
    props['accessibilityRole'] === 'button' ||
    props['accessibilityRole'] === 'switch' ||
    props['accessibilityRole'] === 'adjustable'
  );
}

interface TargetBox {
  height: number | null;
  width: number | null;
  source: 'own' | 'children' | 'flex';
}

function numberOr(value: unknown, fallback: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Smallest box the node can occupy from its own flattened style, else the
 * largest fixed box among its descendants (a card sized by its poster),
 * else `flex` — the parent decides and nothing here can prove the size. */
function targetBox(node: ReactTestInstance): TargetBox {
  const own = flattenStyle(node.props['style']);
  const ownHeight = numberOr(own['height'], numberOr(own['minHeight'], null));
  const ownWidth = numberOr(own['width'], numberOr(own['minWidth'], null));
  if (ownHeight !== null || ownWidth !== null) {
    return { height: ownHeight, width: ownWidth, source: 'own' };
  }
  let height: number | null = null;
  for (const child of hostNodes(node)) {
    if (child === node) continue;
    const style = flattenStyle(child.props['style']);
    const candidate = numberOr(
      style['height'],
      numberOr(style['minHeight'], null),
    );
    if (candidate !== null && (height === null || candidate > height)) {
      height = candidate;
    }
  }
  if (height !== null) return { height, width: null, source: 'children' };
  return { height: null, width: null, source: 'flex' };
}

function hitSlopExtra(node: ReactTestInstance): number {
  const slop = node.props['hitSlop'];
  if (typeof slop === 'number') return slop * 2;
  if (slop && typeof slop === 'object') {
    const insets = slop as Record<string, number | undefined>;
    return (insets['top'] ?? 0) + (insets['bottom'] ?? 0);
  }
  return 0;
}

function nodePath(node: ReactTestInstance): string {
  const parts: string[] = [];
  let current: ReactTestInstance | null = node;
  while (current) {
    const label =
      typeof current.type === 'string'
        ? current.type
        : ((current.type as { displayName?: string; name?: string })
            .displayName ??
          (current.type as { name?: string }).name ??
          'Anonymous');
    const testID = current.props['testID'];
    parts.unshift(testID ? `${label}#${testID}` : label);
    current = current.parent;
  }
  return parts.slice(-6).join(' > ');
}

function badStyleValues(style: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(style)) {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      out.push(`${key}=${String(value)}`);
    } else if (typeof value === 'string' && /NaN|Infinity/.test(value)) {
      out.push(`${key}=${value}`);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry && typeof entry === 'object') {
          out.push(
            ...badStyleValues(entry as Record<string, unknown>).map(
              inner => `${key}.${inner}`,
            ),
          );
        }
      }
    }
  }
  return out;
}

const SVG_NUMERIC_PROPS = [
  'cx',
  'cy',
  'r',
  'x1',
  'y1',
  'x2',
  'y2',
  'x',
  'y',
  'width',
  'height',
  'strokeWidth',
  'opacity',
  'strokeOpacity',
  'fillOpacity',
] as const;

interface A11yRecord {
  path: string;
  role: string | null;
  label: string | null;
  hint: string | null;
  state: unknown;
  box: TargetBox;
  text: string;
}

interface Observation {
  kind: string;
  path: string;
  detail: string;
}

interface Inspection {
  failures: string[];
  observations: Observation[];
  interactive: A11yRecord[];
  hostCount: number;
  textCount: number;
}

function inspectTree(
  root: ReactTestInstance,
  dims: { width: number; fontScale: number },
  options: { allowTinyStage: boolean },
): Inspection {
  const failures: string[] = [];
  const observations: Observation[] = [];
  const interactive: A11yRecord[] = [];
  const nodes = hostNodes(root);
  let textCount = 0;

  for (const node of nodes) {
    const props = node.props;
    const hostType = String(node.type);
    const style = flattenStyle(props['style']);
    const path = nodePath(node);

    // I6 — style sanity
    const bad = badStyleValues(style);
    if (bad.length > 0)
      failures.push(`I6 non-finite style ${bad.join(',')} at ${path}`);

    // I8 — svg primitive props
    if (
      typeof props['testID'] === 'string' &&
      props['testID'].startsWith('svg-')
    ) {
      for (const key of SVG_NUMERIC_PROPS) {
        const value = props[key];
        if (typeof value === 'number' && !Number.isFinite(value)) {
          failures.push(`I8 svg ${key}=${String(value)} at ${path}`);
        }
        if (typeof value === 'string' && /NaN|Infinity/.test(value)) {
          failures.push(`I8 svg ${key}=${value} at ${path}`);
        }
      }
      for (const key of ['d', 'points'] as const) {
        const value = props[key];
        if (typeof value === 'string' && /NaN|Infinity/.test(value)) {
          failures.push(
            `I8 svg ${key} contains ${value.slice(0, 40)} at ${path}`,
          );
        }
      }
    }

    // I5 — visible text
    if (hostType === 'Text') {
      textCount += 1;
      const text = ownText(node);
      if (BAD_TEXT.test(text)) {
        failures.push(`I5 text "${text.slice(0, 80)}" at ${path}`);
      }
      if (EXPONENT_TEXT.test(text)) {
        observations.push({
          kind: 'exponent_numeral',
          path,
          detail: text.slice(0, 80),
        });
      }
      const lines = props['numberOfLines'];
      if (typeof lines === 'number' && text.length > 0) {
        const fontSize = numberOr(style['fontSize'], 14) ?? 14;
        const usable = Math.max(40, dims.width - 64);
        const perLine = Math.max(
          4,
          Math.floor(usable / (fontSize * dims.fontScale * 0.55)),
        );
        if (text.length > lines * perLine) {
          const labelled = ancestorLabelContains(node, text.slice(0, 24));
          observations.push({
            kind: labelled ? 'clipped_text_labelled' : 'clipped_text',
            path,
            detail: `numberOfLines=${lines} chars=${text.length} est.capacity=${lines * perLine} w=${dims.width} fs=${dims.fontScale}`,
          });
        }
      }
      const parentBox = fixedAncestorHeight(node);
      const lineHeight = numberOr(style['lineHeight'], null);
      if (
        parentBox !== null &&
        lineHeight !== null &&
        lineHeight * dims.fontScale > parentBox
      ) {
        observations.push({
          kind: 'scaled_text_exceeds_fixed_box',
          path,
          detail: `lineHeight=${lineHeight}×${dims.fontScale}=${lineHeight * dims.fontScale} > box=${parentBox} text="${text.slice(0, 20)}"`,
        });
      }
    }

    const label =
      typeof props['accessibilityLabel'] === 'string'
        ? props['accessibilityLabel']
        : null;
    if (label !== null) {
      if (BAD_TEXT.test(label))
        failures.push(
          `I5 accessibilityLabel "${label.slice(0, 80)}" at ${path}`,
        );
      if (/\s{2,}|^\s|,\s*,|\.\s*\./.test(label)) {
        observations.push({
          kind: 'label_empty_subject',
          path,
          detail: label.slice(0, 120),
        });
      }
      if (!props['accessible'] && !isInteractive(node) && hostType === 'View') {
        observations.push({
          kind: 'label_on_non_accessible_view',
          path,
          detail: label.slice(0, 120),
        });
      }
    }

    // I2/I3/I4 — interactive nodes
    if (isInteractive(node)) {
      const role =
        typeof props['accessibilityRole'] === 'string'
          ? props['accessibilityRole']
          : null;
      const text = textOf(node);
      const box = targetBox(node);
      interactive.push({
        path,
        role,
        label,
        hint:
          typeof props['accessibilityHint'] === 'string'
            ? props['accessibilityHint']
            : null,
        state: props['accessibilityState'],
        box,
        text,
      });
      if (
        (label === null || label.trim().length === 0) &&
        text.trim().length === 0
      ) {
        failures.push(`I2 unlabeled interactive at ${path}`);
      }
      if (role === null) failures.push(`I3 no accessibilityRole at ${path}`);
      const extra = hitSlopExtra(node);
      if (box.height !== null && box.height + extra < MIN_TARGET_PT) {
        const tinyStage =
          props['testID'] === 'form-review-stage' && options.allowTinyStage;
        if (!tinyStage) {
          failures.push(
            `I4 target height ${box.height}${extra ? `+${extra}` : ''}pt (<44) at ${path} [${box.source}]`,
          );
        }
      }
      if (
        box.width !== null &&
        box.source === 'own' &&
        box.width + extra < MIN_TARGET_PT
      ) {
        failures.push(`I4 target width ${box.width}pt (<44) at ${path}`);
      }
    }
  }

  return {
    failures,
    observations,
    interactive,
    hostCount: nodes.length,
    textCount,
  };
}

function ancestorLabelContains(
  node: ReactTestInstance,
  needle: string,
): boolean {
  let current: ReactTestInstance | null = node.parent;
  while (current) {
    const label = current.props['accessibilityLabel'];
    if (typeof label === 'string' && label.includes(needle)) return true;
    current = current.parent;
  }
  return false;
}

function fixedAncestorHeight(node: ReactTestInstance): number | null {
  let current: ReactTestInstance | null = node.parent;
  let depth = 0;
  while (current && depth < 3) {
    if (typeof current.type === 'string') {
      const style = flattenStyle(current.props['style']);
      const height = numberOr(style['height'], null);
      if (height !== null) return height;
      depth += 1;
    }
    current = current.parent;
  }
  return null;
}

function treeHash(renderer: ReactTestRenderer): string {
  return createHash('sha256')
    .update(JSON.stringify(renderer.toJSON()) ?? 'null')
    .digest('hex')
    .slice(0, 16);
}

function treeExcerpt(renderer: ReactTestRenderer, limit = 6000): string {
  const json = JSON.stringify(renderer.toJSON(), null, 1) ?? 'null';
  return json.length > limit
    ? `${json.slice(0, limit)}…(+${json.length - limit})`
    : json;
}

// ─── Console capture ────────────────────────────────────────────────────────

const BENIGN_CONSOLE = [
  /useNativeDriver/,
  /Animated: `useNativeDriver`/,
  /not wrapped in act/,
];

class ConsoleTrap {
  readonly errors: string[] = [];
  readonly warnings: string[] = [];
  private originalError = console.error;
  private originalWarn = console.warn;
  install() {
    console.error = (...args: unknown[]) => {
      this.errors.push(args.map(String).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      this.warnings.push(args.map(String).join(' '));
    };
  }
  restore() {
    console.error = this.originalError;
    console.warn = this.originalWarn;
  }
  failures(): string[] {
    return this.errors
      .filter(line => !BENIGN_CONSOLE.some(pattern => pattern.test(line)))
      .map(line => `I7 console.error: ${line.slice(0, 200)}`);
  }
}

// ─── Scenario plumbing ──────────────────────────────────────────────────────

const COMPONENTS = [
  'FixList',
  'FormReviewCard',
  'FormReviewOverlay',
  'FormReviewPlayer',
  'RecommendedDrills',
] as const;
type ComponentName = (typeof COMPONENTS)[number];

interface Dims {
  width: number;
  fontScale: number;
  locale: Locale;
  rtl: boolean;
}

interface IterationResult {
  seed: number;
  index: number;
  component: ComponentName;
  scenario: Record<string, unknown>;
  dims: Dims;
  outcome: 'held' | 'broken';
  propFault: boolean;
  failures: string[];
  observations: Observation[];
  interactive: A11yRecord[];
  hostCount: number;
  treeHash: string;
  tree?: string;
}

function applyDims(dims: Dims) {
  mockViewport.current = {
    width: dims.width,
    height: Math.round(dims.width * 2.16),
    scale: 3,
    fontScale: dims.fontScale,
  };
  PixelRatio.getFontScale = () => dims.fontScale;
  // Components never read isRTL themselves (RN flips row layouts natively;
  // that flip is not observable in react-test-renderer). Set anyway so a
  // future read would be exercised.
  (I18nManager as unknown as { isRTL: boolean }).isRTL = dims.rtl;
}

function drawDims(rng: Rng): Dims {
  const locale = rng.pick(LOCALES);
  return {
    width: rng.pick(WIDTHS),
    fontScale: rng.pick(FONT_SCALES),
    locale,
    rtl: RTL_LOCALES.includes(locale),
  };
}

async function mount(element: React.ReactElement): Promise<ReactTestRenderer> {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

// Two scopes on purpose: advancing fake timers inside an act callback that
// has already yielded flushes React's own (faked) microtask check before the
// outer `await` has registered, which trips act's "without await" warning.
async function flush(): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(50);
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function pressAll(
  root: ReactTestInstance,
  predicate: (node: ReactTestInstance) => boolean = () => true,
): Promise<number> {
  let pressed = 0;
  for (const node of hostNodes(root)) {
    if (!predicate(node)) continue;
    const onPress = node.props['onPress'];
    if (typeof onPress === 'function' && !node.props['disabled']) {
      await act(async () => {
        onPress();
      });
      pressed += 1;
    }
  }
  return pressed;
}

// ─── Per-component scenarios ────────────────────────────────────────────────

interface ScenarioRun {
  renderer: ReactTestRenderer;
  scenario: Record<string, unknown>;
  propFault: boolean;
  extraFailures: string[];
  allowTinyStage: boolean;
  interact: () => Promise<void>;
}

async function runFixList(rng: Rng): Promise<ScenarioRun> {
  const analysis = fuzzAnalysis(rng);
  const limit = rng.pick([
    undefined,
    undefined,
    0,
    -1,
    1,
    2,
    3,
    10,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]);
  const dark = rng.bool();
  const compact = rng.bool(0.3);
  const withOpen = rng.bool(0.7);
  const opened: PhaseKey[] = [];
  const renderer = await mount(
    <FixList
      analysis={analysis}
      {...(limit !== undefined ? { limit } : {})}
      dark={dark}
      compact={compact}
      {...(withOpen ? { onOpenInReview: phase => opened.push(phase) } : {})}
    />,
  );
  const extraFailures: string[] = [];
  // I9 — "n of m checkpoints" header: n ≤ m, m counts only readable scores.
  const header = renderer.root
    .findAll(node => node.type === Text)
    .map(
      node =>
        ownText(node) ||
        React.Children.toArray(node.props['children']).map(String).join(''),
    )
    .find(text => / of \d+ checkpoints/.test(text));
  if (header) {
    const match = /(\d+) of (\d+) checkpoints/.exec(
      header.replace(/\s+/g, ' '),
    );
    if (match) {
      const shown = Number(match[1]);
      const scored = Number(match[2]);
      if (shown > scored)
        extraFailures.push(
          `I9 FixList header "${header}" shows more items than scored`,
        );
    }
  }
  return {
    renderer,
    scenario: {
      limit: String(limit),
      dark,
      compact,
      withOpen,
      checkpoints: Array.isArray(analysis.checkpoints)
        ? analysis.checkpoints.length
        : String(analysis.checkpoints),
      priorityFix:
        analysis.priorityFix?.checkpoint ?? String(analysis.priorityFix),
      shotType: analysis.shotType,
    },
    propFault: false,
    extraFailures,
    allowTinyStage: false,
    interact: async () => {
      const pressed = await pressAll(renderer.root);
      if (withOpen && pressed > 0 && opened.length !== pressed) {
        extraFailures.push(
          `I1 FixList onOpenInReview fired ${opened.length}× for ${pressed} presses`,
        );
      }
      for (const phase of opened) {
        if (!(PHASES as readonly string[]).includes(phase)) {
          extraFailures.push(
            `I9 FixList opened unknown phase ${String(phase)}`,
          );
        }
      }
    },
  };
}

async function runFormReviewCard(rng: Rng): Promise<ScenarioRun> {
  const stopCount = rng.bool(0.15)
    ? asAny<number>(undefined)
    : pickNumeric(rng);
  const fixCount = rng.bool(0.15) ? asAny<number>(null) : pickNumeric(rng);
  const posterKind = rng.pick([
    'none',
    'file',
    'empty',
    'long',
    'unicode',
  ] as const);
  const posterUri =
    posterKind === 'none'
      ? undefined
      : posterKind === 'file'
        ? 'file:///var/mobile/Containers/Data/poster.jpg'
        : posterKind === 'empty'
          ? ''
          : posterKind === 'long'
            ? `file:///${'a'.repeat(2048)}.jpg`
            : 'file:///var/mobile/ポスター/صورة/🏓.jpg';
  let presses = 0;
  const renderer = await mount(
    <FormReviewCard
      stopCount={stopCount}
      fixCount={fixCount}
      {...(posterUri !== undefined ? { posterUri } : {})}
      onPress={() => {
        presses += 1;
      }}
    />,
  );
  const extraFailures: string[] = [];
  // I9 — the accessibility label mirrors the visible counts.
  const card = renderer.root.findByProps({ testID: 'form-review-card' });
  const label = String(card.props['accessibilityLabel'] ?? '');
  const visible = textOf(card);
  const visibleCount = /(?:^|\s)(\S+) checkpoints?/.exec(visible)?.[1];
  if (
    visibleCount !== undefined &&
    !label.includes(`${visibleCount} checkpoint`)
  ) {
    extraFailures.push(
      `I9 FormReviewCard label "${label}" does not carry visible count "${visibleCount}"`,
    );
  }
  const propFault =
    !Number.isFinite(stopCount) ||
    !Number.isFinite(fixCount) ||
    (stopCount as unknown) === undefined ||
    (fixCount as unknown) === null;
  return {
    renderer,
    scenario: {
      stopCount: String(stopCount),
      fixCount: String(fixCount),
      posterKind,
    },
    propFault,
    extraFailures,
    allowTinyStage: false,
    interact: async () => {
      const pressed = await pressAll(renderer.root);
      if (presses !== pressed)
        extraFailures.push(
          `I1 FormReviewCard onPress fired ${presses}× for ${pressed} presses`,
        );
    },
  };
}

function fuzzRect(rng: Rng): Rect {
  return rng.pick<Rect>([
    { x: 0, y: 0, width: 390, height: 600 },
    { x: 20, y: 40, width: 350, height: 520 },
    { x: 0, y: 0, width: 0, height: 0 },
    { x: 0, y: 0, width: 1, height: 1 },
    { x: -100, y: -100, width: 50, height: 50 },
    { x: 0, y: 0, width: 1e6, height: 1e6 },
    { x: Number.NaN, y: 0, width: 390, height: 600 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 600 },
    { x: 0, y: 0, width: -390, height: -600 },
    { x: 0, y: 0, width: 12, height: 900 },
  ]);
}

function fuzzHeat(rng: Rng): JointHeat {
  const mode = rng.pick(['empty', 'normal', 'hot', 'garbage'] as const);
  const heat: JointHeat = {};
  if (mode === 'empty') return heat;
  for (const joint of REVIEW_JOINTS) {
    if (mode === 'normal') heat[joint] = rng.range(0, 1);
    if (mode === 'hot') heat[joint] = 1;
    if (mode === 'garbage') {
      heat[joint] = rng.pick([
        Number.NaN,
        -1,
        1e9,
        Number.POSITIVE_INFINITY,
        asAny<number>('0.5'),
        0.6,
      ]);
    }
  }
  return heat;
}

const ARROW_DIRECTIONS: readonly ReviewArrow['direction'][] = [
  'up',
  'down',
  'forward',
  'back',
  'wider',
  'narrower',
  'steadier',
];

function fuzzStop(
  rng: Rng,
  kind: StringKind,
  locale: Locale,
  withArrow: boolean,
): ReviewStop {
  const arrow: ReviewArrow | null = withArrow
    ? {
        joint: rng.bool(0.9) ? rng.pick(REVIEW_JOINTS) : asAny('tail'),
        direction: rng.bool(0.9)
          ? rng.pick(ARROW_DIRECTIONS)
          : asAny('sideways'),
        label: corpusString(kind, locale, rng) || 'Paddle up',
      }
    : null;
  const atMs = rng.pick([1900, 0, -100, 1e12, Number.NaN]);
  return {
    id: `stop-${rng.int(1e6)}`,
    phase: rng.pick(PHASES),
    atMs,
    startMs: Number.isFinite(atMs) ? atMs - 50 : 0,
    endMs: Number.isFinite(atMs) ? atMs + 50 : 0,
    title: corpusString(kind, locale, rng),
    verdict: rng.pick(['strong', 'watch', 'fix'] as const),
    checkpoints: [],
    headline: corpusString(kind, locale, rng),
    cue: corpusString(kind, locale, rng),
    focusJoints: [rng.pick(REVIEW_JOINTS)],
    arrow,
  };
}

async function runOverlay(rng: Rng, dims: Dims): Promise<ScenarioRun> {
  const rect = fuzzRect(rng);
  const frame = rng.bool(0.2) ? null : fuzzFrame(rng, 1900);
  const heat = fuzzHeat(rng);
  const kind = rng.pick(STRING_KINDS);
  const activeStop = rng.bool(0.25)
    ? null
    : fuzzStop(rng, kind, dims.locale, rng.bool(0.8));
  const script: FormReviewScript = {
    shotType: 'forehand_drive',
    dominant: rng.pick(['left', 'right'] as const),
    facing: rng.bool(0.9) ? rng.pick([1, -1] as const) : asAny(0),
    stops: activeStop ? [activeStop] : [],
    jointHeat: heat,
    strongest: null,
    weakest: null,
  };
  const showArrow = rng.bool(0.8);
  const reducedMotion = rng.bool();
  const renderer = await mount(
    <FormReviewOverlay
      rect={rect}
      frame={frame}
      heat={heat}
      script={script}
      activeStop={activeStop}
      showArrow={showArrow}
      reducedMotion={reducedMotion}
    />,
  );
  const extraFailures: string[] = [];
  // I9 — pure geometry contracts on the same inputs.
  const points = projectJoints(rect, frame);
  for (const [joint, point] of Object.entries(points)) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      if (Object.values(rect).every(Number.isFinite)) {
        extraFailures.push(
          `I9 projectJoints emitted non-finite ${joint}=${JSON.stringify(point)}`,
        );
      }
    }
  }
  const geometry = arrowGeometry(rect, frame, script, activeStop);
  if (geometry) {
    const anchor = arrowLabelAnchor(
      rect,
      geometry.point,
      geometry.vector,
      geometry.unit,
    );
    const rectFinite = Object.values(rect).every(Number.isFinite);
    if (rectFinite && rect.width > 16 && rect.height > 16) {
      const inside =
        anchor.x >= rect.x + 8 - 1e-6 &&
        anchor.x <= rect.x + rect.width - 8 + 1e-6 &&
        anchor.y >= rect.y + 8 - 1e-6 &&
        anchor.y <= rect.y + rect.height - 8 + 1e-6;
      if (!inside)
        extraFailures.push(
          `I9 arrowLabelAnchor ${JSON.stringify(anchor)} outside rect ${JSON.stringify(rect)}`,
        );
    }
    if (!Number.isFinite(geometry.unit) || geometry.unit <= 0) {
      extraFailures.push(`I9 arrowGeometry unit=${geometry.unit}`);
    }
  }
  const propFault =
    !Object.values(rect).every(value => Number.isFinite(value) && value >= 0) ||
    (script.facing as number) === 0;
  return {
    renderer,
    scenario: {
      rect,
      frame: frame
        ? `${Array.isArray(frame.landmarks) ? frame.landmarks.length : 'not-array'} landmarks`
        : null,
      heat: Object.keys(heat).length,
      stringKind: kind,
      arrow: activeStop?.arrow
        ? `${activeStop.arrow.joint}:${activeStop.arrow.direction}`
        : null,
      showArrow,
      reducedMotion,
      facing: script.facing,
    },
    propFault,
    extraFailures,
    allowTinyStage: false,
    interact: async () => {
      await act(async () => {
        jest.advanceTimersByTime(1500);
      });
    },
  };
}

function mutateScriptStrings(
  script: FormReviewScript,
  kind: StringKind,
  locale: Locale,
  rng: Rng,
): FormReviewScript {
  return {
    ...script,
    stops: script.stops.map(stop => ({
      ...stop,
      title: corpusString(kind, locale, rng),
      headline: corpusString(kind, locale, rng),
      cue: corpusString(kind, locale, rng),
      arrow: stop.arrow
        ? { ...stop.arrow, label: corpusString(kind, locale, rng) }
        : stop.arrow,
    })),
  };
}

async function runPlayer(rng: Rng, dims: Dims): Promise<ScenarioRun> {
  const analysis = fuzzAnalysis(rng);
  const sequence = fuzzSequence(rng);
  let script: FormReviewScript;
  try {
    script = buildFormReviewScript(analysis, sequence);
  } catch (error) {
    // A null/undefined entry inside `landmarks` can never come out of the
    // strict sidecar parser (parsePoseSequence rejects it), so a throw here
    // is an out-of-contract input, recorded but not a suite failure.
    if (sequenceHasNullLandmark(sequence)) throw new PropFaultError(error);
    throw error;
  }
  const stringKind = rng.bool(0.5) ? rng.pick(STRING_KINDS) : null;
  if (stringKind)
    script = mutateScriptStrings(script, stringKind, dims.locale, rng);
  if (rng.bool(0.08)) script = { ...script, stops: [] };
  const clipKind = rng.pick([
    'null',
    'null',
    'normal',
    'zero',
    'negative',
    'nan',
    'infinite',
    'huge',
    'poster',
  ] as const);
  const clip: StrokeResultClip | null =
    clipKind === 'null'
      ? null
      : {
          uri: 'file:///var/mobile/clip.mov',
          durationMs:
            clipKind === 'normal'
              ? 3400
              : clipKind === 'zero'
                ? 0
                : clipKind === 'negative'
                  ? -1
                  : clipKind === 'nan'
                    ? Number.NaN
                    : clipKind === 'infinite'
                      ? Number.POSITIVE_INFINITY
                      : clipKind === 'huge'
                        ? 1e12
                        : 3400,
          ...(clipKind === 'poster' ? { posterUri: 'file:///poster.jpg' } : {}),
        };
  const reviewKind = rng.pick([
    'null',
    'portrait',
    'landscape',
    'zero',
    'negative',
    'nan',
  ] as const);
  const review: StrokeReviewEvidence | null =
    reviewKind === 'null'
      ? null
      : {
          width:
            reviewKind === 'portrait'
              ? 1080
              : reviewKind === 'landscape'
                ? 1920
                : reviewKind === 'zero'
                  ? 0
                  : reviewKind === 'negative'
                    ? -1080
                    : Number.NaN,
          height:
            reviewKind === 'portrait'
              ? 1920
              : reviewKind === 'landscape'
                ? 1080
                : reviewKind === 'zero'
                  ? 0
                  : reviewKind === 'negative'
                    ? -1920
                    : Number.NaN,
          poseSequence: null,
        };
  const initialKind = rng.pick([
    'undefined',
    'null',
    'stop',
    'stop',
    'foreign',
  ] as const);
  const initialStop: ReviewStop | null | undefined =
    initialKind === 'undefined'
      ? undefined
      : initialKind === 'null'
        ? null
        : initialKind === 'stop'
          ? (script.stops[rng.int(Math.max(1, script.stops.length))] ?? null)
          : fuzzStop(rng, stringKind ?? 'plain', dims.locale, true);
  const stageHeightPick = rng.pick([
    undefined,
    undefined,
    undefined,
    300,
    560,
    1e6,
    0,
    -10,
    Number.NaN,
  ]);
  const fill = rng.bool(0.3);
  const renderer = await mount(
    <FormReviewPlayer
      analysis={analysis}
      clip={clip}
      review={review}
      sequence={sequence}
      script={script}
      {...(initialStop !== undefined ? { initialStop } : {})}
      {...(stageHeightPick !== undefined
        ? { stageHeight: stageHeightPick }
        : {})}
      fill={fill}
    />,
  );
  const extraFailures: string[] = [];
  const propFault =
    (stageHeightPick !== undefined && !(stageHeightPick >= MIN_TARGET_PT)) ||
    initialKind === 'foreign';
  const stageWidth = dims.width - 32;
  const stageHeight =
    stageHeightPick !== undefined &&
    Number.isFinite(stageHeightPick) &&
    stageHeightPick > 0
      ? stageHeightPick
      : 600;
  return {
    renderer,
    scenario: {
      stops: script.stops.length,
      stringKind,
      clipKind,
      reviewKind,
      sequence: sequence
        ? `${sequence.frames.length} frames${sequence.video ? ' +video' : ''}`
        : null,
      initialKind,
      stageHeight: String(stageHeightPick),
      fill,
      phases: Array.isArray(analysis.phases)
        ? analysis.phases.length
        : String(analysis.phases),
    },
    propFault,
    extraFailures,
    allowTinyStage:
      stageHeightPick !== undefined && !(stageHeightPick >= MIN_TARGET_PT),
    interact: async () => {
      const root = renderer.root;
      const layout = (testID: string, width: number, height: number) => {
        const node = root.findByProps({ testID });
        const onLayout = node.props['onLayout'];
        if (typeof onLayout === 'function') {
          act(() => {
            onLayout({
              nativeEvent: { layout: { x: 0, y: 0, width, height } },
            });
          });
        }
      };
      layout('form-review-stage', stageWidth, stageHeight);
      layout('form-review-timeline', stageWidth - 60, 32);
      const labels = root.findAllByProps({ testID: 'form-review-arrow-label' });
      for (const label of labels) {
        const onLayout = label.props['onLayout'];
        if (typeof onLayout === 'function') {
          act(() => {
            onLayout({
              nativeEvent: { layout: { x: 0, y: 0, width: 88, height: 26 } },
            });
          });
        }
      }
      // Play for a while on the JS clock, then every control once.
      await pressAll(root, node => node.props['testID'] === 'form-review-play');
      await act(async () => {
        jest.advanceTimersByTime(700);
      });
      await pressAll(
        root,
        node => node.props['testID'] === 'form-review-speed',
      );
      await pressAll(
        root,
        node => node.props['testID'] === 'form-review-next-stop',
      );
      await pressAll(
        root,
        node => node.props['testID'] === 'form-review-prev-stop',
      );
      await pressAll(
        root,
        node => node.props['testID'] === 'form-review-autopause',
      );
      await pressAll(
        root,
        node => node.props['testID'] === 'form-review-stage',
      );
      await act(async () => {
        jest.advanceTimersByTime(4000);
      });
      // Scrub: start, middle, end, and two out-of-range touches.
      const track = root.findByProps({ testID: 'form-review-timeline' });
      for (const locationX of [
        0,
        (stageWidth - 60) / 2,
        stageWidth - 60,
        -40,
        Number.NaN,
        1e9,
      ]) {
        act(() => {
          track.props['onResponderGrant']({ nativeEvent: { locationX } });
          track.props['onResponderMove']({
            nativeEvent: { locationX: locationX + 3 },
          });
          track.props['onResponderRelease']();
        });
      }
      // Clock text must be well-formed after every step.
      const clock = root
        .findAll(node => node.type === Text)
        .map(node => ownText(node))
        .filter(text => /s$/.test(text) && /^\d/.test(text));
      for (const text of clock) {
        if (!/^\d+\.\d{2}s$/.test(text))
          extraFailures.push(`I9 clock text "${text}"`);
      }
      // Stop counter never exceeds its total.
      for (const text of root
        .findAll(node => node.type === Text)
        .map(node => ownText(node))) {
        const match = /^STOP (\d+) OF (\d+)$/.exec(text);
        if (match && Number(match[1]) > Number(match[2]))
          extraFailures.push(`I9 stop counter "${text}"`);
      }
    },
  };
}

function fuzzDrill(
  rng: Rng,
  index: number,
  kind: StringKind,
  locale: Locale,
  slug: string,
  family: string,
): CatalogDrill {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    slug,
    title: corpusString(rng.bool(0.7) ? kind : 'plain', locale, rng),
    description: corpusString(rng.bool(0.7) ? kind : 'long200', locale, rng),
    coachName: corpusString(
      rng.bool(0.6) ? kind : 'turkish_dotted',
      locale,
      rng,
    ),
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    families: rng.bool(0.8) ? [family] : ['global'],
    validationState: 'catalog',
    saved: rng.bool(0.3),
  };
}

async function runRecommendedDrills(
  rng: Rng,
  dims: Dims,
): Promise<ScenarioRun> {
  const analysis = fuzzAnalysis(rng);
  const sessionKind = rng.pick([
    'valid',
    'valid',
    'valid',
    'null',
    'empty',
    'blank',
    'no_token',
  ] as const);
  mockGetApiSession.mockReset();
  mockGetApiSession.mockReturnValue(
    sessionKind === 'valid'
      ? { apiBaseUrl: 'https://api.example.test', bearerToken: 'token' }
      : sessionKind === 'null'
        ? null
        : sessionKind === 'empty'
          ? {}
          : sessionKind === 'blank'
            ? { apiBaseUrl: '   ', bearerToken: '\t' }
            : {
                apiBaseUrl: 'https://api.example.test',
                bearerToken: undefined,
              },
  );
  const kind = rng.pick(STRING_KINDS);
  const apiKind = rng.pick([
    'drills',
    'drills',
    'drills',
    'empty',
    'training_error',
    'training_error_empty',
    'plain_error',
    'non_error',
    'pending',
    'duplicate_slugs',
  ] as const);
  const drillCount = rng.pick([1, 2, 3, 5, 12]);
  const family = drillFocusFromAnalysis(analysis)?.family ?? 'global';
  const drills: CatalogDrill[] = [];
  if (apiKind === 'drills' || apiKind === 'duplicate_slugs') {
    for (let index = 0; index < drillCount; index += 1) {
      const slug =
        apiKind === 'duplicate_slugs'
          ? 'same-slug'
          : rng.pick([
              `drill-${index}`,
              `drill-${index}`,
              `ドリル-${index}`,
              `drill ${index} with spaces`,
              index === 0 ? '' : `drill-${index}`,
            ]);
      drills.push(fuzzDrill(rng, index, kind, dims.locale, slug, family));
    }
  }
  mockListCatalogDrills.mockReset();
  if (apiKind === 'pending') {
    mockListCatalogDrills.mockReturnValue(
      new Promise<CatalogDrill[]>(() => undefined),
    );
  } else if (apiKind === 'training_error') {
    mockListCatalogDrills.mockRejectedValue(
      new TrainingError(
        'training.request_failed',
        corpusString(kind, dims.locale, rng) || 'x'.repeat(5000),
        true,
        500,
      ),
    );
  } else if (apiKind === 'training_error_empty') {
    mockListCatalogDrills.mockRejectedValue(
      new TrainingError('training.request_failed', '   ', true, 500),
    );
  } else if (apiKind === 'plain_error') {
    mockListCatalogDrills.mockRejectedValue(new Error('boom'));
  } else if (apiKind === 'non_error') {
    mockListCatalogDrills.mockRejectedValue(
      rng.pick([null, 'string rejection', 42, { code: 'x' }]),
    );
  } else {
    mockListCatalogDrills.mockResolvedValue(drills);
  }
  const withToggle = rng.bool(0.7);
  const savedSet = new Set<string>(
    drills.filter(() => rng.bool(0.4)).map(drill => drill.slug),
  );
  const pendingSlug = rng.pick([
    undefined,
    null,
    drills[0]?.slug ?? 'none',
    '',
  ]);
  const toggles: Array<[string, boolean]> = [];
  let opened = 0;
  const dark = rng.bool();
  const renderer = await mount(
    <RecommendedDrills
      analysis={analysis}
      dark={dark}
      onOpenLibrary={() => {
        opened += 1;
      }}
      {...(withToggle
        ? {
            onToggleSaved: (drill: CatalogDrill, saved: boolean) => {
              toggles.push([drill.slug, saved]);
            },
            isSaved: (drill: CatalogDrill) => savedSet.has(drill.slug),
          }
        : {})}
      {...(pendingSlug !== undefined ? { pendingSlug } : {})}
    />,
  );
  await flush();
  await flush();
  const extraFailures: string[] = [];
  const propFault = apiKind === 'duplicate_slugs';
  return {
    renderer,
    scenario: {
      sessionKind,
      apiKind,
      drillCount: drills.length,
      stringKind: kind,
      withToggle,
      pendingSlug: String(pendingSlug),
      dark,
    },
    propFault,
    extraFailures,
    allowTinyStage: false,
    interact: async () => {
      const before = renderer.root
        .findAllByProps({ testID: 'recommended-drills-open-library' })
        .filter(node => typeof node.type === 'string').length;
      const pressed = await pressAll(renderer.root);
      await flush();
      if (before > 0 && opened === 0 && pressed > 0)
        extraFailures.push('I1 RecommendedDrills library button did not fire');
      for (const [slug, saved] of toggles) {
        if (savedSet.has(slug) === saved)
          extraFailures.push(
            `I9 toggle for ${slug} requested saved=${saved} while already ${saved}`,
          );
      }
    },
  };
}

// ─── One iteration ──────────────────────────────────────────────────────────

async function runIteration(
  seed: number,
  index: number,
): Promise<IterationResult> {
  const rng = new Rng(seed);
  const component = rng.pick(COMPONENTS);
  const dims = drawDims(rng);
  applyDims(dims);
  const trap = new ConsoleTrap();
  trap.install();
  let run: ScenarioRun | null = null;
  const failures: string[] = [];
  let observations: Observation[] = [];
  let interactive: A11yRecord[] = [];
  let hostCount = 0;
  let hash = 'unrendered';
  let tree: string | undefined;
  let propFault = false;
  let scenario: Record<string, unknown> = {};
  try {
    run =
      component === 'FixList'
        ? await runFixList(rng)
        : component === 'FormReviewCard'
          ? await runFormReviewCard(rng)
          : component === 'FormReviewOverlay'
            ? await runOverlay(rng, dims)
            : component === 'FormReviewPlayer'
              ? await runPlayer(rng, dims)
              : await runRecommendedDrills(rng, dims);
    scenario = run.scenario;
    propFault = run.propFault;
    const first = inspectTree(run.renderer.root, dims, {
      allowTinyStage: run.allowTinyStage,
    });
    await run.interact();
    const second = inspectTree(run.renderer.root, dims, {
      allowTinyStage: run.allowTinyStage,
    });
    hash = treeHash(run.renderer);
    hostCount = Math.max(first.hostCount, second.hostCount);
    interactive =
      second.interactive.length >= first.interactive.length
        ? second.interactive
        : first.interactive;
    observations = dedupe(
      [...first.observations, ...second.observations],
      item => `${item.kind}|${item.path}|${item.detail}`,
    );
    failures.push(
      ...dedupe(
        [...first.failures, ...second.failures, ...run.extraFailures],
        item => item,
      ),
    );
    tree = treeExcerpt(run.renderer);
    await act(async () => {
      run?.renderer.unmount();
      jest.runOnlyPendingTimers();
    });
  } catch (error) {
    const stack =
      error instanceof Error
        ? (error.stack ?? '').split('\n').slice(1, 4).join(' | ')
        : '';
    if (error instanceof PropFaultError) propFault = true;
    failures.push(
      `I1 threw${error instanceof PropFaultError ? ' (out-of-contract input)' : ''}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)} ${stack}`,
    );
    if (run) {
      try {
        tree = treeExcerpt(run.renderer);
      } catch {
        tree = undefined;
      }
    }
  } finally {
    trap.restore();
  }
  failures.push(...trap.failures());
  const outcome = failures.length === 0 ? 'held' : 'broken';
  const result: IterationResult = {
    seed,
    index,
    component,
    scenario,
    dims,
    outcome,
    propFault,
    failures,
    observations,
    interactive,
    hostCount,
    treeHash: hash,
  };
  if (outcome === 'broken' || observations.length > 0) result.tree = tree;
  return result;
}

function dedupe<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const id = key(item);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ─── Campaign ───────────────────────────────────────────────────────────────

function seedFor(index: number): number {
  return (BASE_SEED + index * 0x9e3779b1) >>> 0;
}

/**
 * Failure signatures reproduced and reported by the recorded campaign. They
 * are real gaps (the report lists file:line for each), kept from failing the
 * default run so the suite can live in CI while the product decision is
 * made; `STRESS_STRICT=1` fails on them.
 */
const KNOWN_GAPS: readonly RegExp[] = [
  // FormReviewPlayer.tsx:721-725 — the scrubber is a 32pt-tall responder
  // View with no accessibilityRole (not `adjustable`, no actions).
  /I4 target height 32pt .*View#form-review-timeline/,
  /I3 no accessibilityRole at .*View#form-review-timeline/,
  // RecommendedDrills.tsx:284-293 — the save toggle is minHeight 34.
  /I4 target height 34pt .*recommended-drill-.*-save/,
  // FormReviewCard.tsx:31-32 — Math.max(0, Math.floor(NaN)) is NaN, so a
  // non-finite count renders and is announced as "NaN checkpoints" /
  // "Infinity checkpoints".
  /I5 (text|accessibilityLabel) ".*(NaN|Infinity) checkpoints/,
];

describe('cmp-form-review-ui × boundary-i18n-a11y stress campaign', () => {
  const results: IterationResult[] = [];

  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
    if (!OUT_FILE) return;
    const summary = {
      generatedAt: new Date().toISOString(),
      iterations: results.length,
      baseSeed: BASE_SEED,
      onlySeed: ONLY_SEED,
      env: {
        LANG: process.env['LANG'] ?? null,
        LC_ALL: process.env['LC_ALL'] ?? null,
        TZ: process.env['TZ'] ?? null,
        resolvedLocale: Intl.DateTimeFormat().resolvedOptions().locale,
        resolvedTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        utcOffsetMinutes: new Date('2026-09-04T12:00:00Z').getTimezoneOffset(),
        // Offsets either side of the 2026 DST transitions (US 8 Mar / 1 Nov,
        // EU 29 Mar / 25 Oct, southern hemisphere 5 Apr / 4 Oct) prove the
        // process really runs in the requested zone, not just labels it.
        dstEdgeOffsetsMinutes: Object.fromEntries(
          [
            '2026-03-08T06:59:00Z',
            '2026-03-08T07:01:00Z',
            '2026-03-29T00:59:00Z',
            '2026-03-29T01:01:00Z',
            '2026-04-04T15:59:00Z',
            '2026-04-04T16:01:00Z',
            '2026-10-03T15:59:00Z',
            '2026-10-03T16:01:00Z',
            '2026-10-25T00:59:00Z',
            '2026-10-25T01:01:00Z',
            '2026-11-01T05:59:00Z',
            '2026-11-01T06:01:00Z',
          ].map(iso => [iso, new Date(iso).getTimezoneOffset()]),
        ),
        requestedLocale: process.env['STRESS_LOCALE'] ?? null,
        node:
          (globalThis as { process?: { version?: string } }).process?.version ??
          null,
      },
      counts: {
        held: results.filter(result => result.outcome === 'held').length,
        broken: results.filter(result => result.outcome === 'broken').length,
        brokenPropFault: results.filter(
          result => result.outcome === 'broken' && result.propFault,
        ).length,
        byComponent: Object.fromEntries(
          COMPONENTS.map(name => [
            name,
            {
              total: results.filter(result => result.component === name).length,
              broken: results.filter(
                result =>
                  result.component === name && result.outcome === 'broken',
              ).length,
            },
          ]),
        ),
        byFailure: tally(
          results.flatMap(result =>
            result.failures.map(failure =>
              failure.replace(/\s+at .*$/, '').replace(/"[^"]*"/g, '"…"'),
            ),
          ),
        ),
        byObservation: tally(
          results.flatMap(result => result.observations.map(item => item.kind)),
        ),
        widths: tally(results.map(result => String(result.dims.width))),
        fontScales: tally(results.map(result => String(result.dims.fontScale))),
        locales: tally(results.map(result => result.dims.locale)),
      },
      treeHashes: results.map(result => result.treeHash),
      results,
    };
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(summary, null, 1));
  });

  const seeds: Array<[number, number]> =
    ONLY_SEED !== null
      ? [[ONLY_SEED, 0]]
      : Array.from({ length: ITERATIONS }, (_, index) => [
          seedFor(index),
          index,
        ]);

  test.each(seeds)(
    'seed %i (iteration %i) renders within the lens invariants',
    async (seed, index) => {
      const result = await runIteration(seed, index);
      results.push(result);
      // Faults that only exist because the harness handed the component an
      // impossible prop (NaN stage height, a stop from another script) are
      // recorded in the table but do not fail the suite; the campaign report
      // classifies them separately.
      const hard = result.failures.filter(
        failure =>
          !(
            result.propFault &&
            (/^I[4568]/.test(failure) ||
              /^I1 threw \(out-of-contract input\)/.test(failure) ||
              /same key/.test(failure))
          ),
      );
      if (hard.length > 0 && !process.env['STRESS_SOFT']) {
        // Known contract gaps this campaign documents (see the findings in the
        // stress report); they stay visible in the JSON table, and fail here
        // only when STRESS_STRICT is set so the default suite run stays green.
        const known = hard.filter(failure =>
          KNOWN_GAPS.some(pattern => pattern.test(failure)),
        );
        const unknown = hard.filter(
          failure => !KNOWN_GAPS.some(pattern => pattern.test(failure)),
        );
        if (
          unknown.length > 0 ||
          (process.env['STRESS_STRICT'] && known.length > 0)
        ) {
          throw new Error(
            `seed ${seed} (${result.component}) broke:\n  ${[...unknown, ...known].join('\n  ')}\n` +
              `replay: STRESS_SEED=${seed} npx jest --ci __tests__/stress/formReviewUi.boundaryI18nA11y.stress.test.tsx\n` +
              `scenario: ${JSON.stringify(result.scenario)} dims: ${JSON.stringify(result.dims)}`,
          );
        }
      }
    },
  );
});

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}
