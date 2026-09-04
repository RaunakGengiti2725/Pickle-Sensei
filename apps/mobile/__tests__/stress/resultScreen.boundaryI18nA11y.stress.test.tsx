/**
 * STRESS — ResultScreen × boundary / i18n / a11y (unit `scr-resultscreen`).
 *
 * Every iteration is one seeded variant of the FULL screen mounted inside a
 * real `NavigationContainer` + native stack (the `Result` route is the real
 * `ResultScreen`; the routes it navigates to are inert markers so every
 * `navigate`/`replace`/`goBack`/`popToTop` is a real navigation action). The
 * training, api-session, consistency and try-again stores are the real ones;
 * only the native/data boundaries are replaced: the SQLite driver (`getDb`),
 * the SQLite read helpers (`strokeResultData`, `repository`), `fetch` (served
 * by an in-memory training API), safe-area, svg, reanimated (repo auto-mock).
 *
 * Dimensions drawn from the seed (mulberry32, replayable with STRESS_SEED):
 *   kind        × 9   result shapes (scored clean/faulted/signed-in, legacy
 *                     sparse payload, foreign shot type, low-confidence with
 *                     guidance, abstained, missing, still loading, outbox
 *                     exhausted)
 *   text        × 7   200+ char ASCII, CJK, Arabic RTL, ZWJ emoji, combining
 *                     marks, unbreakable German compound, empty/whitespace
 *   numeric     × 7   nominal / zero / negative / huge / tiny / above-range /
 *                     null-score checkpoint
 *   fontScale   × 3   1.0 / 1.75 / 3.0 (RN iOS Dynamic Type)
 *   width       × 3   320 / 375 / 430 pt
 *   locale      × 12  de-DE fr-FR ar-EG hi-IN ja-JP pt-BR tr-TR ru-RU th-TH
 *                     zh-CN en-IN es-419 (localized server strings + RTL flag)
 *   timezone    × 8   UTC, +14, -12, +13:45, +5:30, US/EU DST, Lord Howe
 *   clock       × 6   DST transition instants (US, EU, Lord Howe) + nominal
 *
 * Per variant the harness walks every guide page (Next … Done / Go back) and
 * checks: no thrown render error, no console.error, every pressable has a
 * role + label (or text), target ≥ 44 pt (height/minHeight + hitSlop, from
 * the rendered style), progressbar value coherent, no "undefined"/"NaN"/
 * "[object Object]"/exponent leaks in visible text, injected strings survive
 * intact where the screen renders them, navigation reaches the expected
 * route. Layout is NOT computed by react-test-renderer, so clipping/overlap
 * are estimated proxies (labelled `proxy` in the JSON) — real Yoga/iOS
 * layout truth belongs to the Mac plane.
 *
 * STRESS_ITER (default 24) variants run per invocation; STRESS_SEED replays
 * one seed; STRESS_BASE_SEED changes the campaign start. Results go to
 * `artifacts/stress/scr-resultscreen-boundary-i18n-a11y/` (git-ignored) as a
 * seed → outcome JSON table plus rendered trees for every BROKEN seed.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import {
  Dimensions,
  I18nManager,
  PixelRatio,
  StyleSheet,
  View,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { CheckpointScore, ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidence } from '../../src/components/strokeResultData';
import type {
  RealAnalysisFact,
  ShotOutboxStatus,
  ActivityShotRow,
} from '../../src/data/repository';
import type { RootStackParams } from '../../src/navigation/params';

// ─── Native / data boundary mocks ───────────────────────────────────────────

jest.mock('../../src/data/db', () => ({
  getDb: jest.fn(() => ({
    execute: jest.fn(async () => ({ rows: [] })),
    close() {},
  })),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const insets = { top: 0, bottom: 0, left: 0, right: 0 };
  const frame = { x: 0, y: 0, width: 375, height: 812 };
  return {
    SafeAreaInsetsContext: ReactActual.createContext(insets),
    SafeAreaFrameContext: ReactActual.createContext(frame),
    SafeAreaProvider: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(RNView, null, props.children),
    SafeAreaView: (props: { children?: React.ReactNode; testID?: string }) =>
      ReactActual.createElement(
        RNView,
        { testID: props.testID },
        props.children,
      ),
    useSafeAreaInsets: () => insets,
    useSafeAreaFrame: () => frame,
    initialWindowMetrics: null,
  };
});

jest.mock('react-native-svg', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  const { View: RNView } =
    jest.requireActual<typeof import('react-native')>('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactActual.createElement(RNView, null, props.children);
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

/** Mutable data-boundary state (the `mock` prefix lets hoisted factories
 * reference it); every variant resets it before mounting. */
const mockBoundary = {
  pendingForever: new Promise<StrokeResultEvidence>(() => {}),
  evidence: 'pending' as StrokeResultEvidence | 'pending',
  outbox: { state: 'absent' } as ShotOutboxStatus,
  syncReceipt: false,
  facts: [] as RealAnalysisFact[],
  activityShots: [] as ActivityShotRow[],
  kv: new Map<string, string>(),
};
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: async () =>
    mockBoundary.evidence === 'pending'
      ? mockBoundary.pendingForever
      : mockBoundary.evidence,
}));
jest.mock('../../src/data/repository', () => ({
  hasShotSyncReceipt: async () => mockBoundary.syncReceipt,
  getShotOutboxStatus: async () => mockBoundary.outbox,
  listRealAnalysisFacts: async () => mockBoundary.facts,
  listActivityShots: async () => mockBoundary.activityShots,
  getKv: async (_db: unknown, key: string) => mockBoundary.kv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockBoundary.kv.set(key, value);
  },
}));

import { ResultScreen } from '../../src/screens/ResultScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
} from '../../src/training/store';
import { setActiveDataOwner } from '../../src/data/accountScope';
import { consumeTryAgainHandoff } from '../../src/screens/tryAgainHandoff';
import { useConsistencyStore } from '../../src/consistency/store';

// ─── Seeded RNG ─────────────────────────────────────────────────────────────

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

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty choice set');
  return item;
}

// ─── Variant space ──────────────────────────────────────────────────────────

const KINDS = [
  'scored_clean',
  'scored_faulted',
  'scored_faulted_signed_in',
  'scored_legacy_sparse',
  'scored_foreign_shot_type',
  'low_confidence_guidance',
  'abstained',
  'missing',
  'loading',
  'sync_exhausted',
] as const;
type Kind = (typeof KINDS)[number];

const TEXT_CLASSES = [
  'ascii200',
  'cjk',
  'arabic_rtl',
  'zwj_emoji',
  'combining',
  'german_compound',
  'empty_whitespace',
] as const;
type TextClass = (typeof TEXT_CLASSES)[number];

const NUMERIC_PROFILES = [
  'nominal',
  'zero',
  'negative',
  'huge',
  'tiny',
  'above_range',
  'null_score_checkpoint',
] as const;
type NumericProfile = (typeof NUMERIC_PROFILES)[number];

const FONT_SCALES = [1, 1.75, 3] as const;
const WIDTHS = [320, 375, 430] as const;
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

/** UTC-12 (Etc/GMT+12) is the most negative real IANA offset; +14 is
 * Kiritimati. Lord Howe shifts 30 min for DST; Chatham is +13:45. */
const TIMEZONES = [
  'UTC',
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'Pacific/Chatham',
  'Asia/Kolkata',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
] as const;

/** System clock instants: 30 s before a DST transition and the nominal. */
const CLOCKS = [
  { id: 'nominal', iso: '2026-08-30T10:30:00.000Z' },
  { id: 'us_spring_forward', iso: '2026-03-08T06:59:30.000Z' },
  { id: 'us_fall_back', iso: '2026-11-01T05:59:30.000Z' },
  { id: 'eu_spring_forward', iso: '2026-03-29T00:59:30.000Z' },
  { id: 'eu_fall_back', iso: '2026-10-25T00:59:30.000Z' },
  { id: 'lord_howe_spring_forward', iso: '2026-10-03T15:59:30.000Z' },
] as const;

interface Variant {
  seed: number;
  kind: Kind;
  text: TextClass;
  numeric: NumericProfile;
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  locale: Locale;
  timeZone: (typeof TIMEZONES)[number];
  clock: (typeof CLOCKS)[number];
  /** Whether the seeded save-toggle press is answered with a server error. */
  saveFails: boolean;
}

function variantFor(seed: number): Variant {
  const rng = mulberry32(seed);
  return {
    seed,
    kind: pick(rng, KINDS),
    text: pick(rng, TEXT_CLASSES),
    numeric: pick(rng, NUMERIC_PROFILES),
    fontScale: pick(rng, FONT_SCALES),
    width: pick(rng, WIDTHS),
    locale: pick(rng, LOCALES),
    timeZone: pick(rng, TIMEZONES),
    clock: pick(rng, CLOCKS),
    saveFails: rng() < 0.5,
  };
}

// ─── Text corpus ────────────────────────────────────────────────────────────

function repeatTo(unit: string, minLength: number): string {
  let out = '';
  while (out.length < minLength) out += unit;
  return out;
}

const CORPUS: Record<TextClass, string> = {
  ascii200: repeatTo(
    'Keep the paddle face square through contact and let the hips lead the hands; finish the swing toward the target line. ',
    220,
  ),
  cjk: repeatTo(
    '接触時にパドル面をスクエアに保ち、腰から先に回転させて、目標線に向かってスイングを終える。保持球拍面垂直，髋部带动双手，完成挥拍指向目标线。',
    210,
  ),
  arabic_rtl: repeatTo(
    'حافظ على وجه المضرب مستقيمًا عند نقطة التلامس ودَع الوركين يقودان اليدين، ثم أنهِ الضربة نحو خط الهدف ١٢٣. ',
    210,
  ),
  zwj_emoji: repeatTo('👨‍👩‍👧‍👦🏳️‍🌈👍🏽🇺🇸🧑🏾‍🦽‍➡️🏓', 210),
  combining: repeatTo(
    'e\u0301a\u0300o\u0302u\u0308n\u0303 Z\u0334\u0351\u0336a\u0317\u0355l\u0353g\u0324o\u0331 क्ष त्र ज्ञ ก็ต้องเป็น ',
    210,
  ),
  german_compound: repeatTo(
    'Donaudampfschifffahrtsgesellschaftskapitänsmützenherstellungsverordnungsänderungsbeschlussvorlage',
    210,
  ),
  empty_whitespace: '   ',
};

/** Code-point-safe prefix (never splits a surrogate pair). */
function headCodePoints(text: string, count: number): string {
  return Array.from(text).slice(0, count).join('');
}

/** The free text a variant injects through its data sink (empty for the
 * whitespace class). Sinks cap length, so the SAME string is expected back. */
function injectedText(v: Variant, maxCodePoints = 240): string {
  return v.text === 'empty_whitespace'
    ? CORPUS[v.text]
    : headCodePoints(CORPUS[v.text], maxCodePoints);
}

/** Localized server strings (drill titles as a catalog would deliver them). */
const LOCALIZED: Record<Locale, { title: string; coach: string }> = {
  'de-DE': {
    title: 'Schattenschwünge mit Hüftrotation',
    coach: 'Trainer Jürgen Straße',
  },
  'fr-FR': {
    title: 'Frappes contre le mur — préparation précoce',
    coach: 'Coach Éloïse',
  },
  'ar-EG': { title: 'تمرين الضربة الأمامية ضد الحائط', coach: 'المدرب أحمد' },
  'hi-IN': {
    title: 'दीवार के सामने फोरहैंड ड्राइव अभ्यास',
    coach: 'कोच प्रिया',
  },
  'ja-JP': { title: '壁打ちフォアハンドドライブ', coach: 'コーチ 田中' },
  'pt-BR': {
    title: 'Golpes de sombra com rotação do quadril',
    coach: 'Treinador João',
  },
  'tr-TR': {
    title: 'İçe dönüşlü gölge vuruşları ılık ısınma',
    coach: 'Koç İlker Işık',
  },
  'ru-RU': { title: 'Теневые замахи с вращением бёдер', coach: 'Тренер Ольга' },
  'th-TH': { title: 'ฝึกตีโฟร์แฮนด์กับกำแพง', coach: 'โค้ชสมชาย' },
  'zh-CN': { title: '对墙正手抽击练习', coach: '王教练' },
  'en-IN': {
    title: 'Wall drive with early prep (₹0 equipment)',
    coach: 'Coach Aditya',
  },
  'es-419': {
    title: 'Golpes de sombra con rotación de cadera',
    coach: 'Entrenador Ñoño',
  },
};

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ANALYSIS_ID = 'stress-analysis-1';

function checkpoint(
  key: CheckpointScore['key'],
  score: number | null,
  band: CheckpointScore['band'],
  direction: CheckpointScore['direction'],
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

function numbers(profile: NumericProfile): {
  overall: number;
  fixScore: number;
  heldScore: number;
  extraCheckpoint: CheckpointScore | null;
  attemptsCount: number;
  syncAttempts: number;
} {
  switch (profile) {
    case 'nominal':
      return {
        overall: 7.4,
        fixScore: 48,
        heldScore: 85,
        extraCheckpoint: null,
        attemptsCount: 2,
        syncAttempts: 3,
      };
    case 'zero':
      return {
        overall: 0,
        fixScore: 0,
        heldScore: 0,
        extraCheckpoint: null,
        attemptsCount: 0,
        syncAttempts: 0,
      };
    case 'negative':
      return {
        overall: -1.5,
        fixScore: -20,
        heldScore: -5,
        extraCheckpoint: null,
        attemptsCount: 1,
        syncAttempts: -1,
      };
    case 'huge':
      return {
        overall: 1e21,
        fixScore: 1e9,
        heldScore: 1e15,
        extraCheckpoint: null,
        attemptsCount: 40,
        syncAttempts: 2147483647,
      };
    case 'tiny':
      return {
        overall: 1e-7,
        fixScore: 0.000001,
        heldScore: 99.99999,
        extraCheckpoint: null,
        attemptsCount: 3,
        syncAttempts: 1,
      };
    case 'above_range':
      return {
        overall: 10.05,
        fixScore: 100.5,
        heldScore: 101,
        extraCheckpoint: null,
        attemptsCount: 12,
        syncAttempts: 5,
      };
    case 'null_score_checkpoint':
      return {
        overall: 6.2,
        fixScore: 55,
        heldScore: 80,
        extraCheckpoint: checkpoint('swing_length', null, 'unscored', 'none'),
        attemptsCount: 2,
        syncAttempts: 3,
      };
  }
}

interface BuiltEvidence {
  evidence: StrokeResultEvidence | 'pending';
  /** Free text the screen is expected to render verbatim (null = none). */
  expectVisibleText: string | null;
  /** Where the injected text was placed, for the JSON table. */
  textSink: string;
}

function baseAnalysis(v: Variant): ShotAnalysis {
  const n = numbers(v.numeric);
  return {
    id: ANALYSIS_ID,
    sessionId: 's1',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
    phases: [],
    measurements: [
      {
        metricKey: 'elbow_extension',
        value: 0.42,
        confidence: 0.8,
        unit: 'ratio',
        source: 'real',
      },
      {
        metricKey: 'swing_duration',
        value: 700,
        confidence: 0.9,
        unit: 'ms',
        source: 'real',
      },
    ],
    checkpoints: [],
    overallScore: n.overall,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  };
}

function faultedCheckpoints(v: Variant): {
  checkpoints: CheckpointScore[];
  priorityFix: ShotAnalysis['priorityFix'];
} {
  const n = numbers(v.numeric);
  const checkpoints = [
    checkpoint('ready_position', n.heldScore, 'green', 'none'),
    checkpoint('contact_position', n.fixScore, 'red', 'late'),
  ];
  if (n.extraCheckpoint) checkpoints.push(n.extraCheckpoint);
  return {
    checkpoints,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
  };
}

const declaredEnvelope = {
  declaredStroke: 'forehand_drive',
  predictedStroke: null,
  resolutionBasis: 'declared',
  resolvedProfileId: 'FOREHAND_DRIVE',
  resolvedProfileVersion: 'technique-profile-v1',
  disagreement: null,
};

function recordJson(overrides: Record<string, unknown> = {}) {
  return {
    id: ANALYSIS_ID,
    captureId: 'capture-1',
    strokeIntent: declaredEnvelope,
    result: null,
    uncertainty: {
      analysisConfidence: 0.82,
      presentation: 'normal',
      limitingFactors: [],
    },
    contact: {
      status: 'estimated',
      estimatedContactMs: 2400,
      confidence: 0.7,
      ballConfirmed: true,
      paddleConfirmed: false,
      limitingFactors: [],
      supportingEvidence: [],
    },
    ...overrides,
  };
}

function attempts(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    analysisId: index === 0 ? ANALYSIS_ID : `stress-analysis-${index + 1}`,
    capturedAtIso: new Date(
      Date.parse('2026-08-30T10:00:00.000Z') + index * 5 * 60_000,
    ).toISOString(),
    sessionId: 's1',
  }));
}

/**
 * The ONE data-boundary cast of the harness, mirroring production:
 * `repository.getAnalysis` returns `JSON.parse(payload) as ShotAnalysis`
 * (src/data/repository.ts:291) with no validation, so an older app reading a
 * newer/foreign/sparse record sees exactly this shape.
 */
function fromStorage(value: unknown): StrokeResultEvidence {
  return JSON.parse(JSON.stringify(value)) as StrokeResultEvidence;
}

function buildEvidence(v: Variant): BuiltEvidence {
  const text = injectedText(v);
  const n = numbers(v.numeric);
  const analysis = baseAnalysis(v);
  switch (v.kind) {
    case 'loading':
      return { evidence: 'pending', expectVisibleText: null, textSink: 'none' };
    case 'missing':
      return {
        evidence: fromStorage({
          analysis: null,
          record: null,
          clip: null,
          review: null,
          attempts: [],
        }),
        expectVisibleText: null,
        textSink: 'none',
      };
    case 'scored_clean':
      return {
        evidence: fromStorage({
          analysis,
          record: recordJson(),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        expectVisibleText: null,
        textSink: 'none (no free-text field reaches the clean guide)',
      };
    case 'scored_faulted':
    case 'scored_faulted_signed_in': {
      const faults = faultedCheckpoints(v);
      return {
        evidence: fromStorage({
          analysis: { ...analysis, ...faults },
          record: recordJson(),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        // Signed in: the catalog title carries the text (drills page).
        expectVisibleText:
          v.kind === 'scored_faulted_signed_in' && v.text !== 'empty_whitespace'
            ? text
            : null,
        textSink:
          v.kind === 'scored_faulted_signed_in'
            ? 'catalog drill title + description (GET /v1/catalog/drills)'
            : 'none',
      };
    }
    case 'scored_legacy_sparse': {
      // Older payload: optional-ish fields absent entirely, record row gone.
      const faults = faultedCheckpoints(v);
      const sparse: Record<string, unknown> = {
        ...analysis,
        checkpoints: faults.checkpoints,
        sessionId: null,
      };
      delete sparse['guidance'];
      delete sparse['priorityFix'];
      delete sparse['phases'];
      delete sparse['measurements'];
      return {
        evidence: fromStorage({
          analysis: sparse,
          record: null,
          clip: null,
          review: null,
          attempts: [],
        }),
        expectVisibleText: null,
        textSink:
          'none (fields removed: guidance, priorityFix, phases, measurements, record)',
      };
    }
    case 'scored_foreign_shot_type': {
      // A newer engine wrote a shot type this app build does not know; the
      // guide humanizes it into the kicker (`humanize(...).toUpperCase()`).
      const faults = faultedCheckpoints(v);
      const foreign =
        v.text === 'empty_whitespace' ? '' : headCodePoints(text, 120);
      return {
        evidence: fromStorage({
          analysis: { ...analysis, ...faults, shotType: foreign },
          record: recordJson(),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        expectVisibleText: null,
        textSink: 'analysis.shotType (unknown slug, 120 chars)',
      };
    }
    case 'low_confidence_guidance':
      return {
        evidence: fromStorage({
          analysis: {
            ...analysis,
            resultKind: 'low_confidence',
            overallScore: null,
            guidance: text,
            checkpoints: [],
          },
          record: recordJson({
            uncertainty: {
              analysisConfidence: 0.2,
              presentation: 'low_confidence',
              limitingFactors: ['paddle_track_missing'],
            },
          }),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        expectVisibleText: v.text === 'empty_whitespace' ? null : text,
        textSink: 'analysis.guidance (engine setup guidance)',
      };
    case 'abstained':
      return {
        evidence: fromStorage({
          analysis: null,
          record: recordJson({
            strokeIntent: {
              ...declaredEnvelope,
              declaredStroke: null,
              resolutionBasis: 'abstained',
              resolvedProfileId: null,
              resolvedProfileVersion: null,
            },
            uncertainty: {
              analysisConfidence: 0,
              presentation: 'abstain',
              // An unknown limiting-factor token is humanized verbatim.
              limitingFactors: [
                'paddle_track_missing',
                headCodePoints(text, 80),
              ],
            },
            contact: {
              status: 'abstained',
              reason: 'insufficient evidence mass',
              limitingFactors: ['insufficient_evidence_mass'],
            },
          }),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        expectVisibleText: null,
        textSink:
          'record.uncertainty.limitingFactors[1] (unknown token, 80 chars)',
      };
    case 'sync_exhausted': {
      const faults = faultedCheckpoints(v);
      return {
        evidence: fromStorage({
          analysis: { ...analysis, ...faults },
          record: recordJson(),
          clip: null,
          review: null,
          attempts: attempts(n.attemptsCount),
        }),
        expectVisibleText: null,
        textSink: 'outbox lastError (server response text)',
      };
    }
  }
}

// ─── In-memory training API served through global fetch ─────────────────────

const API_BASE = 'https://stress.invalid';
const DRILL_UUID = '3f1d2a8e-7c4b-4b6e-9a1f-0c5d7e8f9a10';
const DRILL_UUID_2 = '8a7b6c5d-4e3f-4a2b-9c1d-0e1f2a3b4c5d';
const OWNER_UUID = '0f9c4b2a-6d1e-4c3b-8a7f-5e4d3c2b1a09';

let fetchLog: string[] = [];

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetch(v: Variant, catalogTitle: string) {
  const localized = LOCALIZED[v.locale];
  const description = v.text === 'empty_whitespace' ? '' : catalogTitle;
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = init?.method ?? 'GET';
    fetchLog.push(`${method} ${url.replace(API_BASE, '')}`);
    const pathname = new URL(url).pathname;
    if (method === 'GET' && pathname === '/v1/catalog/drills') {
      return jsonResponse(200, {
        items: [
          {
            id: DRILL_UUID,
            slug: 'stress-drill-one',
            title: catalogTitle,
            description,
            coach_name: localized.coach,
            equipment: ['paddle', 'balls'],
            difficulty_min: null,
            difficulty_max: null,
            families: ['drive'],
            validation_state: 'UNVALIDATED',
            saved: false,
          },
          {
            id: DRILL_UUID_2,
            slug: 'stress-drill-two',
            title: localized.title,
            description: localized.title,
            coach_name: localized.coach,
            equipment: [],
            difficulty_min: null,
            difficulty_max: null,
            families: ['global'],
            validation_state: 'UNVALIDATED',
            saved: false,
          },
        ],
      });
    }
    if (method === 'GET' && pathname === '/v1/me/saved-drills') {
      return jsonResponse(200, { items: [] });
    }
    if (method === 'GET' && pathname === '/v1/training-plans/current') {
      return jsonResponse(200, { plan: null });
    }
    if (method === 'PUT' && pathname.startsWith('/v1/me/saved-drills/')) {
      const slug = decodeURIComponent(pathname.split('/').pop() ?? '');
      if (v.saveFails) {
        return jsonResponse(409, {
          error: {
            code: 'training.conflict',
            message:
              v.text === 'empty_whitespace'
                ? 'Library is read-only right now.'
                : headCodePoints(catalogTitle, 200),
          },
        });
      }
      return jsonResponse(200, { slug, saved: true });
    }
    if (method === 'DELETE' && pathname.startsWith('/v1/me/saved-drills/')) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, {
      error: { code: 'not_found', message: `No route ${method} ${pathname}` },
    });
  };
  globalThis.fetch = fetchMock;
}

// ─── Environment (font scale, width, locale/RTL, time zone, clock) ──────────

const originalTz = process.env['TZ'];
const originalIsRtl = I18nManager.isRTL;
let fontScaleSpy: jest.SpyInstance | null = null;
let dimensionsSpy: jest.SpyInstance | null = null;

function applyEnvironment(v: Variant) {
  process.env['TZ'] = v.timeZone;
  jest.useFakeTimers();
  jest.setSystemTime(new Date(v.clock.iso));
  fontScaleSpy = jest
    .spyOn(PixelRatio, 'getFontScale')
    .mockReturnValue(v.fontScale);
  const window = {
    width: v.width,
    height: Math.round(v.width * 2.16),
    scale: 3,
    fontScale: v.fontScale,
  };
  dimensionsSpy = jest.spyOn(Dimensions, 'get').mockReturnValue(window);
  I18nManager.isRTL = v.locale === 'ar-EG';
}

function restoreEnvironment() {
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
  I18nManager.isRTL = originalIsRtl;
  fontScaleSpy?.mockRestore();
  dimensionsSpy?.mockRestore();
  fontScaleSpy = null;
  dimensionsSpy = null;
  jest.useRealTimers();
}

// ─── Navigator host (real NavigationContainer + native stack) ───────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const navigationRef = createNavigationContainerRef<RootStackParams>();

function marker(name: string) {
  const Marker = () => (
    <View testID={`route-${name}`}>
      <Text>{`route:${name}`}</Text>
    </View>
  );
  Marker.displayName = `Route${name}`;
  return Marker;
}
const Tabs = marker('Tabs');
const Analyze = marker('Analyze');
const FormReview = marker('FormReview');
const DrillLibrary = marker('DrillLibrary');
const ResultDetails = marker('ResultDetails');

function Host(props: { analysisId: string }) {
  return (
    <NavigationContainer
      ref={navigationRef}
      initialState={{
        index: 1,
        routes: [
          { name: 'Tabs' },
          { name: 'Result', params: { analysisId: props.analysisId } },
        ],
      }}
    >
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Tabs" component={Tabs} />
        <Stack.Screen name="Result" component={ResultScreen} />
        <Stack.Screen name="Analyze" component={Analyze} />
        <Stack.Screen name="FormReview" component={FormReview} />
        <Stack.Screen name="DrillLibrary" component={DrillLibrary} />
        <Stack.Screen name="ResultDetails" component={ResultDetails} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

type Renderer = ReturnType<typeof TestRenderer.create>;

async function flush(turns = 6) {
  for (let i = 0; i < turns; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount(analysisId: string): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<Host analysisId={analysisId} />);
  });
  await flush();
  return renderer;
}

async function unmount(renderer: Renderer) {
  await act(async () => {
    renderer.unmount();
  });
}

async function press(node: ReactTestInstance) {
  await act(async () => {
    node.props.onPress();
  });
  await flush();
}

// ─── Rendered-tree inspection ───────────────────────────────────────────────

type Style = Record<string, unknown>;

function flat(style: unknown): Style {
  const resolved =
    typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Style;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isHost(node: ReactTestInstance, type: string): boolean {
  return node.type === type;
}

function pressables(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(node => {
    if (typeof node.type === 'string') return false;
    const type = node.type as { displayName?: string; name?: string };
    return (
      (type.displayName ?? type.name) === 'Pressable' &&
      typeof node.props.onPress === 'function'
    );
  });
}

function hostByTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance | null {
  const found = root.findAll(
    node => typeof node.type === 'string' && node.props.testID === testID,
  );
  return found[0] ?? null;
}

function pressableByTestId(
  root: ReactTestInstance,
  testID: string,
): ReactTestInstance | null {
  return pressables(root).find(node => node.props.testID === testID) ?? null;
}

/** Concatenated string content of every host Text under `node`. */
function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (child: ReactTestInstance | string) => {
    if (typeof child === 'string') {
      parts.push(child);
      return;
    }
    for (const grandChild of child.children) walk(grandChild);
  };
  walk(node);
  return parts.join('');
}

interface TextNodeInfo {
  text: string;
  fontSize: number;
  numberOfLines: number | null;
  adjustsFontSizeToFit: boolean;
}

/** Host Text nodes that are not nested inside another host Text. */
function topLevelTexts(root: ReactTestInstance): TextNodeInfo[] {
  const out: TextNodeInfo[] = [];
  const walk = (node: ReactTestInstance | string, insideText: boolean) => {
    if (typeof node === 'string') return;
    const isText = isHost(node, 'Text');
    if (isText && !insideText) {
      const style = flat(node.props.style);
      out.push({
        text: textOf(node),
        fontSize: num(style['fontSize']) ?? 14,
        numberOfLines: num(node.props.numberOfLines),
        adjustsFontSizeToFit: node.props.adjustsFontSizeToFit === true,
      });
    }
    for (const child of node.children) walk(child, insideText || isText);
  };
  walk(root, false);
  return out;
}

function hitSlopOf(value: unknown): {
  top: number;
  bottom: number;
  left: number;
  right: number;
} {
  if (typeof value === 'number') {
    return { top: value, bottom: value, left: value, right: value };
  }
  if (value && typeof value === 'object') {
    const slop = value as Record<string, unknown>;
    return {
      top: num(slop['top']) ?? 0,
      bottom: num(slop['bottom']) ?? 0,
      left: num(slop['left']) ?? 0,
      right: num(slop['right']) ?? 0,
    };
  }
  return { top: 0, bottom: 0, left: 0, right: 0 };
}

interface TargetInfo {
  testID: string | null;
  role: string | null;
  label: string | null;
  text: string;
  /** Declared height from style (height ?? minHeight) plus vertical hitSlop;
   * null when the style declares no vertical size (content-sized). */
  effectiveHeight: number | null;
  /** Declared width (width ?? minWidth) plus horizontal hitSlop; null when
   * the row/flex parent decides (no declared width). */
  effectiveWidth: number | null;
  disabled: boolean;
}

function inspectTarget(node: ReactTestInstance): TargetInfo {
  const style = flat(node.props.style);
  const slop = hitSlopOf(node.props.hitSlop);
  const height = num(style['height']) ?? num(style['minHeight']);
  const width = num(style['width']) ?? num(style['minWidth']);
  const label =
    typeof node.props.accessibilityLabel === 'string'
      ? node.props.accessibilityLabel
      : null;
  const state = node.props.accessibilityState as
    { disabled?: boolean } | undefined;
  return {
    testID: typeof node.props.testID === 'string' ? node.props.testID : null,
    role:
      typeof node.props.accessibilityRole === 'string'
        ? node.props.accessibilityRole
        : null,
    label,
    text: textOf(node),
    effectiveHeight: height === null ? null : height + slop.top + slop.bottom,
    effectiveWidth: width === null ? null : width + slop.left + slop.right,
    disabled: node.props.disabled === true || state?.disabled === true,
  };
}

/** Average advance width per code point in em, by script (proxy). */
function glyphEm(text: string): number {
  let total = 0;
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    count += 1;
    if (code >= 0x300 && code <= 0x36f) continue; // combining: zero advance
    if (code === 0x200d || code === 0xfe0f) continue; // ZWJ / VS16
    if (code >= 0x1f000)
      total += 1.0; // emoji
    else if (code >= 0x2e80 && code <= 0x9fff)
      total += 1.0; // CJK
    else if (code >= 0xac00 && code <= 0xd7af)
      total += 1.0; // Hangul
    else if (code >= 0x0600 && code <= 0x06ff)
      total += 0.55; // Arabic
    else if (code >= 0x0900 && code <= 0x0e7f)
      total += 0.6; // Indic/Thai
    else total += 0.52; // Latin/Cyrillic/Greek average
  }
  return count === 0 ? 0 : total;
}

interface ClipProxy {
  text: string;
  numberOfLines: number;
  estimatedLines: number;
  fontSize: number;
}

/** Text with `numberOfLines` whose estimated wrapped line count exceeds it
 * at this font scale and width — a clipping PROXY (no layout engine here). */
function clippingProxies(
  root: ReactTestInstance,
  width: number,
  fontScale: number,
): ClipProxy[] {
  const available = Math.max(80, width - 2 * 24 - 2 * 16);
  const out: ClipProxy[] = [];
  for (const info of topLevelTexts(root)) {
    if (info.numberOfLines === null || info.adjustsFontSizeToFit) continue;
    if (info.text.trim() === '') continue;
    const px = info.fontSize * fontScale;
    const estimatedWidth = glyphEm(info.text) * px;
    const estimatedLines = Math.max(1, Math.ceil(estimatedWidth / available));
    if (estimatedLines > info.numberOfLines) {
      out.push({
        text: info.text.slice(0, 80),
        numberOfLines: info.numberOfLines,
        estimatedLines,
        fontSize: px,
      });
    }
  }
  return out;
}

interface OverlapProxy {
  a: string;
  b: string;
}

/** Absolutely positioned siblings with fully numeric boxes that intersect
 * (overlap PROXY — only boxes the style itself declares can be compared). */
function overlapProxies(root: ReactTestInstance): OverlapProxy[] {
  const out: OverlapProxy[] = [];
  const walk = (node: ReactTestInstance | string) => {
    if (typeof node === 'string') return;
    const boxes: { id: string; l: number; t: number; r: number; b: number }[] =
      [];
    node.children.forEach((child, index) => {
      if (typeof child === 'string') return;
      const style = flat(child.props.style);
      if (style['position'] !== 'absolute') return;
      const l = num(style['left']);
      const t = num(style['top']);
      const w = num(style['width']);
      const h = num(style['height']);
      if (l === null || t === null || w === null || h === null) return;
      boxes.push({
        id: `${String(child.props.testID ?? child.type)}#${index}`,
        l,
        t,
        r: l + w,
        b: t + h,
      });
    });
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b) {
          out.push({ a: a.id, b: b.id });
        }
      }
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return out;
}

const LEAK_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'undefined', re: /\bundefined\b/ },
  { id: 'null', re: /\bnull\b/ },
  { id: 'NaN', re: /\bNaN\b/ },
  { id: 'Infinity', re: /\bInfinity\b/ },
  { id: 'object', re: /\[object Object\]/ },
  { id: 'exponent', re: /\d(?:\.\d+)?e[+-]\d+/ },
];

// ─── Per-variant campaign ───────────────────────────────────────────────────

interface Issue {
  check: string;
  page: string;
  detail: string;
  /** true when the check is a layout proxy rather than a rendered fact. */
  proxy: boolean;
}

interface VariantResult {
  seed: number;
  variant: Omit<Variant, 'seed'>;
  outcome: 'HELD' | 'BROKEN';
  pagesVisited: string[];
  pressablesInspected: number;
  textNodesInspected: number;
  fetchCalls: string[];
  textSink: string;
  injectedTextSeen: boolean | null;
  finalRoute: string | null;
  issues: Issue[];
  proxyNotes: Issue[];
  durationMs: number;
}

const OUT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress/scr-resultscreen-boundary-i18n-a11y',
);

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
}

function writeTree(seed: number, page: string, renderer: Renderer) {
  ensureOutDir();
  fs.writeFileSync(
    path.join(OUT_DIR, `tree-seed-${seed}-${page}.json`),
    JSON.stringify(renderer.toJSON(), null, 1),
  );
}

/** Focused route from the REAL navigation state (stack screens below the
 * top stay mounted, so the rendered tree alone cannot tell which is focused). */
function currentRoute(root: ReactTestInstance): string | null {
  const focused = navigationRef.isReady()
    ? navigationRef.getCurrentRoute()?.name
    : undefined;
  if (typeof focused !== 'string') return null;
  // Cross-check the focused marker exists in the rendered tree.
  if (focused !== 'Result' && !hostByTestId(root, `route-${focused}`)) {
    return `${focused}(not rendered)`;
  }
  return focused;
}

function pageName(root: ReactTestInstance): string {
  for (const step of ['score', 'problem', 'drills', 'next', 'abstained']) {
    if (hostByTestId(root, `result-guide-step-${step}`)) return step;
  }
  const text = textOf(root);
  if (text.includes('Opening your result')) return 'loading';
  if (text.includes('Result missing')) return 'missing';
  return 'unknown';
}

function inspectPage(
  root: ReactTestInstance,
  page: string,
  v: Variant,
  issues: Issue[],
  proxyNotes: Issue[],
  counters: { pressables: number; texts: number },
) {
  const targets = pressables(root);
  counters.pressables += targets.length;
  for (const node of targets) {
    const info = inspectTarget(node);
    const id = info.testID ?? info.label ?? info.text.slice(0, 40) ?? '?';
    if (info.role === null) {
      issues.push({
        check: 'a11y_role',
        page,
        detail: `pressable ${id} has no accessibilityRole`,
        proxy: false,
      });
    }
    if (
      (info.label === null || info.label.trim() === '') &&
      info.text.trim() === ''
    ) {
      issues.push({
        check: 'a11y_label',
        page,
        detail: `pressable ${id} has neither accessibilityLabel nor text content`,
        proxy: false,
      });
    }
    if (info.effectiveHeight !== null && info.effectiveHeight < 44) {
      issues.push({
        check: 'target_size',
        page,
        detail: `pressable ${id} declares height ${info.effectiveHeight}pt (< 44) incl. hitSlop`,
        proxy: false,
      });
    }
    if (info.effectiveWidth !== null && info.effectiveWidth < 44) {
      issues.push({
        check: 'target_size',
        page,
        detail: `pressable ${id} declares width ${info.effectiveWidth}pt (< 44) incl. hitSlop`,
        proxy: false,
      });
    }
    if (info.effectiveHeight === null) {
      proxyNotes.push({
        check: 'target_size_unbounded',
        page,
        detail: `pressable ${id} has no declared height (content-sized); needs layout truth`,
        proxy: true,
      });
    }
  }

  const progress = hostByTestId(root, 'result-guide-progress');
  if (progress) {
    const value = progress.props.accessibilityValue as
      { min?: number; max?: number; now?: number } | undefined;
    const label = String(progress.props.accessibilityLabel ?? '');
    const match = /Result step (\d+) of (\d+)/.exec(label);
    if (
      !value ||
      !match ||
      value.min !== 1 ||
      value.now !== Number(match[1]) ||
      value.max !== Number(match[2]) ||
      value.now > value.max
    ) {
      issues.push({
        check: 'progressbar_value',
        page,
        detail: `progress label "${label}" vs value ${JSON.stringify(value)}`,
        proxy: false,
      });
    }
    if (progress.props.accessibilityRole !== 'progressbar') {
      issues.push({
        check: 'progressbar_role',
        page,
        detail: `role ${String(progress.props.accessibilityRole)}`,
        proxy: false,
      });
    }
  }

  const texts = topLevelTexts(root);
  counters.texts += texts.length;
  const injected = injectedText(v);
  for (const info of texts) {
    // Injected corpus may legitimately contain anything; skip leak checks on
    // nodes that carry (part of) it.
    const carriesInjected =
      v.text !== 'empty_whitespace' &&
      (info.text.includes(injected.slice(0, 40)) ||
        injected.includes(info.text.trim().slice(0, 40)));
    if (carriesInjected) continue;
    for (const leak of LEAK_PATTERNS) {
      if (leak.re.test(info.text)) {
        issues.push({
          check: `text_leak_${leak.id}`,
          page,
          detail: `"${info.text.slice(0, 120)}"`,
          proxy: false,
        });
      }
    }
  }

  for (const clip of clippingProxies(root, v.width, v.fontScale)) {
    proxyNotes.push({
      check: 'clipping_proxy',
      page,
      detail: `numberOfLines=${clip.numberOfLines} but ~${clip.estimatedLines} lines at ${clip.fontSize}px/${v.width}pt: "${clip.text}"`,
      proxy: true,
    });
  }
  for (const overlap of overlapProxies(root)) {
    proxyNotes.push({
      check: 'overlap_proxy',
      page,
      detail: `absolute siblings intersect: ${overlap.a} × ${overlap.b}`,
      proxy: true,
    });
  }
}

async function runVariant(seed: number): Promise<VariantResult> {
  const started = Date.now();
  const v = variantFor(seed);
  const built = buildEvidence(v);
  const n = numbers(v.numeric);
  const issues: Issue[] = [];
  const proxyNotes: Issue[] = [];
  const pagesVisited: string[] = [];
  const counters = { pressables: 0, texts: 0 };
  let injectedTextSeen: boolean | null =
    built.expectVisibleText === null ? null : false;
  let finalRoute: string | null = null;
  const noteInjected = (root: ReactTestInstance) => {
    if (built.expectVisibleText !== null && injectedTextSeen === false) {
      injectedTextSeen = textOf(root).includes(built.expectVisibleText);
    }
  };
  // Rendered-tree evidence: snapshot the page on which new issues appeared.
  let snapshotted = 0;
  const snapshotIfNewIssues = (renderer: Renderer, page: string) => {
    if (issues.length > snapshotted) {
      writeTree(seed, page, renderer);
      snapshotted = issues.length;
    }
  };

  // Data boundary state for this variant.
  mockBoundary.evidence = built.evidence;
  mockBoundary.kv.clear();
  fetchLog = [];
  mockBoundary.syncReceipt =
    v.kind !== 'sync_exhausted' && v.kind !== 'abstained';
  mockBoundary.outbox =
    v.kind === 'sync_exhausted'
      ? {
          state: 'exhausted',
          attempts: n.syncAttempts,
          lastError:
            v.text === 'empty_whitespace'
              ? null
              : headCodePoints(injectedText(v), 200),
        }
      : v.kind === 'abstained'
        ? { state: 'absent' }
        : { state: 'queued', attempts: 0, lastError: null };
  mockBoundary.facts = [];
  // Consistency store: the same shots the screen's session names, captured at
  // instants that straddle the local midnight in the variant's time zone.
  mockBoundary.activityShots = attempts(Math.max(1, n.attemptsCount)).map(
    ref => ({
      id: ref.analysisId,
      sessionId: ref.sessionId,
      shotType: 'forehand_drive',
      capturedAt: ref.capturedAtIso,
      overallScore: 7.4,
      resultKind: 'scored',
    }),
  );
  mockBoundary.activityShots.push({
    id: 'today-shot',
    sessionId: null,
    shotType: 'dink',
    capturedAt: new Date(Date.parse(v.clock.iso) - 60_000).toISOString(),
    overallScore: 6.1,
    resultKind: 'scored',
  });

  const catalogTitle = v.text === 'empty_whitespace' ? '' : injectedText(v);
  installFetch(v, catalogTitle);
  setActiveDataOwner(OWNER_UUID);
  if (v.kind === 'scored_faulted_signed_in') {
    establishApiSession({
      apiBaseUrl: API_BASE,
      bearerToken: 'stress-token',
      canonicalAppUserId: OWNER_UUID,
      provider: 'apple',
    });
    configureTrainingStore(
      createTrainingApi({ baseUrl: API_BASE, token: 'stress-token' }),
    );
  } else {
    clearApiSession();
    clearTrainingStoreConfiguration();
  }
  consumeTryAgainHandoff();
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });

  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => String(a))
          .join(' ')
          .slice(0, 300),
      );
    });

  applyEnvironment(v);
  let renderer: Renderer | null = null;
  try {
    renderer = await mount(ANALYSIS_ID);
    await act(async () => {
      jest.advanceTimersByTime(50);
    });
    await flush();
    const root = renderer.root;

    let page = pageName(root);
    pagesVisited.push(page);
    inspectPage(root, page, v, issues, proxyNotes, counters);
    noteInjected(root);
    snapshotIfNewIssues(renderer, page);

    if (page === 'loading') {
      if (v.kind !== 'loading') {
        issues.push({
          check: 'state',
          page,
          detail: 'evidence resolved but the screen is still loading',
          proxy: false,
        });
      }
      const close =
        pressableByTestId(root, 'result-guide-close') ??
        pressables(root).find(p => p.props.accessibilityLabel === 'Close') ??
        null;
      if (!close) {
        issues.push({
          check: 'nav',
          page,
          detail: 'no Close control',
          proxy: false,
        });
      } else {
        await press(close);
        finalRoute = currentRoute(root);
        if (finalRoute !== 'Tabs') {
          issues.push({
            check: 'nav',
            page,
            detail: `Close → popToTop expected Tabs, got ${String(finalRoute)}`,
            proxy: false,
          });
        }
      }
    } else if (page === 'missing') {
      if (v.kind !== 'missing') {
        issues.push({
          check: 'state',
          page,
          detail: `kind ${v.kind} rendered the missing state`,
          proxy: false,
        });
      }
      const back = pressables(root).find(
        p => p.props.accessibilityLabel === 'Go back',
      );
      if (!back) {
        issues.push({
          check: 'nav',
          page,
          detail: 'no Go back control',
          proxy: false,
        });
      } else {
        await press(back);
        finalRoute = currentRoute(root);
        if (finalRoute !== 'Tabs') {
          issues.push({
            check: 'nav',
            page,
            detail: `Go back expected Tabs, got ${String(finalRoute)}`,
            proxy: false,
          });
        }
      }
    } else {
      // Guide: walk Next until Done appears (max 5 hops), inspecting each page.
      for (let hop = 0; hop < 5; hop += 1) {
        if (page === 'drills' && v.kind === 'scored_faulted_signed_in') {
          // Catalog lands after the fetch resolves.
          await flush(8);
          inspectPage(root, `${page}+catalog`, v, issues, proxyNotes, counters);
          noteInjected(root);
          snapshotIfNewIssues(renderer, `${page}-catalog`);
          const save = pressableByTestId(
            root,
            'recommended-drill-stress-drill-one-save',
          );
          if (!save) {
            const pageText = textOf(root);
            const rejected =
              v.text === 'empty_whitespace' &&
              pageText.includes('invalid response');
            issues.push({
              check: rejected ? 'catalog_empty_title_rejected' : 'state',
              page,
              detail: rejected
                ? 'one catalog item with an empty title/description makes the client reject the WHOLE catalog (training.invalid_response) — drills page shows the error state instead of the other drills'
                : `signed-in drills page shows no catalog save toggle (fetch: ${fetchLog.join(', ')})`,
              proxy: false,
            });
            snapshotIfNewIssues(renderer, `${page}-no-save-toggle`);
          } else {
            await press(save);
            await flush(8);
            inspectPage(root, `${page}+save`, v, issues, proxyNotes, counters);
            snapshotIfNewIssues(renderer, `${page}-save`);
            const errorCard = hostByTestId(root, 'training-mutation-error');
            if (v.saveFails && !errorCard) {
              issues.push({
                check: 'mutation_error',
                page,
                detail: 'server 409 on save but no mutation error card',
                proxy: false,
              });
            }
            if (!v.saveFails && errorCard) {
              issues.push({
                check: 'mutation_error',
                page,
                detail: `save succeeded but error card shown: ${textOf(errorCard).slice(0, 120)}`,
                proxy: false,
              });
            }
          }
        }
        const next = pressableByTestId(root, 'result-guide-next');
        if (!next) break;
        await press(next);
        page = pageName(root);
        pagesVisited.push(page);
        inspectPage(root, page, v, issues, proxyNotes, counters);
        noteInjected(root);
        snapshotIfNewIssues(renderer, page);
      }
      // Back once from the last page, then forward again (state round trip).
      const back = pressableByTestId(root, 'result-guide-back');
      if (back) {
        await press(back);
        const backPage = pageName(root);
        pagesVisited.push(`back:${backPage}`);
        const forward = pressableByTestId(root, 'result-guide-next');
        if (!forward) {
          issues.push({
            check: 'nav',
            page: backPage,
            detail: 'Back landed on a page without Next',
            proxy: false,
          });
        } else {
          await press(forward);
          pagesVisited.push(pageName(root));
        }
      }

      if (injectedTextSeen === false) {
        issues.push({
          check: 'text_integrity',
          page,
          detail: `injected text (${built.textSink}) not rendered intact`,
          proxy: false,
        });
      }

      const done = pressableByTestId(root, 'result-guide-done');
      const tryAgain = pressableByTestId(root, 'result-guide-try-again');
      const close = pressableByTestId(root, 'result-guide-close');
      // Exit path is seeded: Close (popToTop), Try again (Analyze handoff)
      // or Done (popToTop) so every exit action is exercised across a run.
      const exit =
        close && v.saveFails && v.kind === 'scored_clean'
          ? 'close'
          : tryAgain && v.saveFails
            ? 'try_again'
            : done
              ? 'done'
              : tryAgain
                ? 'try_again'
                : 'none';
      if (exit === 'close' && close) {
        await press(close);
        finalRoute = currentRoute(root);
        if (finalRoute !== 'Tabs') {
          issues.push({
            check: 'nav',
            page,
            detail: `Close expected Tabs, got ${String(finalRoute)}`,
            proxy: false,
          });
        }
      } else if (exit === 'done' && done) {
        await press(done);
        finalRoute = currentRoute(root);
        if (finalRoute !== 'Tabs') {
          issues.push({
            check: 'nav',
            page,
            detail: `Done expected Tabs, got ${String(finalRoute)}`,
            proxy: false,
          });
        }
      } else if (exit === 'try_again' && tryAgain) {
        await press(tryAgain);
        finalRoute = currentRoute(root);
        if (finalRoute !== 'Analyze') {
          issues.push({
            check: 'nav',
            page,
            detail: `Try again expected Analyze, got ${String(finalRoute)}`,
            proxy: false,
          });
        }
      } else {
        issues.push({
          check: 'nav',
          page,
          detail: 'last page has neither Done nor Try again',
          proxy: false,
        });
      }
    }
  } catch (error) {
    issues.push({
      check: 'render_error',
      page: pagesVisited[pagesVisited.length - 1] ?? 'mount',
      detail:
        error instanceof Error
          ? `${error.name}: ${error.message}`.slice(0, 400)
          : String(error),
      proxy: false,
    });
  } finally {
    if (renderer) {
      try {
        if (issues.length > 0) writeTree(seed, 'final', renderer);
        snapshotIfNewIssues(renderer, 'exit');
        await unmount(renderer);
      } catch (error) {
        issues.push({
          check: 'unmount_error',
          page: 'unmount',
          detail: error instanceof Error ? error.message : String(error),
          proxy: false,
        });
      }
    }
    errorSpy.mockRestore();
    restoreEnvironment();
    globalThis.fetch = originalFetch;
  }

  for (const message of consoleErrors) {
    issues.push({
      check: 'console_error',
      page: pagesVisited[pagesVisited.length - 1] ?? 'mount',
      detail: message,
      proxy: false,
    });
  }

  const variant: Omit<Variant, 'seed'> = {
    kind: v.kind,
    text: v.text,
    numeric: v.numeric,
    fontScale: v.fontScale,
    width: v.width,
    locale: v.locale,
    timeZone: v.timeZone,
    clock: v.clock,
    saveFails: v.saveFails,
  };
  const seen = new Set<string>();
  const uniqueIssues = issues.filter(issue => {
    const key = `${issue.check}|${issue.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    seed,
    variant,
    outcome: uniqueIssues.length === 0 ? 'HELD' : 'BROKEN',
    pagesVisited,
    pressablesInspected: counters.pressables,
    textNodesInspected: counters.texts,
    fetchCalls: fetchLog,
    textSink: built.textSink,
    injectedTextSeen,
    finalRoute,
    issues: uniqueIssues,
    proxyNotes,
    durationMs: Date.now() - started,
  };
}

// ─── Campaign ───────────────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

const BASE_SEED = intEnv('STRESS_BASE_SEED', 20260904);
const ITERATIONS = intEnv('STRESS_ITER', 24);
const REPLAY_SEED = process.env['STRESS_SEED'];
const SEEDS =
  REPLAY_SEED !== undefined && REPLAY_SEED.trim() !== ''
    ? [Number(REPLAY_SEED)]
    : Array.from({ length: ITERATIONS }, (_, i) => BASE_SEED + i);

const results: VariantResult[] = [];

afterAll(() => {
  ensureOutDir();
  const runId = `${BASE_SEED}-${SEEDS.length}-${Date.now()}`;
  const dims = {
    kinds: new Set<string>(),
    texts: new Set<string>(),
    numerics: new Set<string>(),
    fontScales: new Set<number>(),
    widths: new Set<number>(),
    locales: new Set<string>(),
    timeZones: new Set<string>(),
    clocks: new Set<string>(),
  };
  for (const r of results) {
    dims.kinds.add(r.variant.kind);
    dims.texts.add(r.variant.text);
    dims.numerics.add(r.variant.numeric);
    dims.fontScales.add(r.variant.fontScale);
    dims.widths.add(r.variant.width);
    dims.locales.add(r.variant.locale);
    dims.timeZones.add(r.variant.timeZone);
    dims.clocks.add(r.variant.clock.id);
  }
  const summary = {
    runId,
    baseSeed: BASE_SEED,
    seeds: SEEDS,
    executed: results.length,
    held: results.filter(r => r.outcome === 'HELD').length,
    broken: results.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    pressablesInspected: results.reduce((a, r) => a + r.pressablesInspected, 0),
    textNodesInspected: results.reduce((a, r) => a + r.textNodesInspected, 0),
    coverage: {
      kinds: [...dims.kinds].sort(),
      texts: [...dims.texts].sort(),
      numerics: [...dims.numerics].sort(),
      fontScales: [...dims.fontScales].sort((a, b) => a - b),
      widths: [...dims.widths].sort((a, b) => a - b),
      locales: [...dims.locales].sort(),
      timeZones: [...dims.timeZones].sort(),
      clocks: [...dims.clocks].sort(),
    },
    issuesByCheck: results
      .flatMap(r => r.issues)
      .reduce<Record<string, number>>((acc, issue) => {
        acc[issue.check] = (acc[issue.check] ?? 0) + 1;
        return acc;
      }, {}),
    proxyNotesByCheck: results
      .flatMap(r => r.proxyNotes)
      .reduce<Record<string, number>>((acc, note) => {
        acc[note.check] = (acc[note.check] ?? 0) + 1;
        return acc;
      }, {}),
  };
  fs.writeFileSync(
    path.join(OUT_DIR, `results-${runId}.json`),
    JSON.stringify({ summary, results }, null, 1),
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'latest-summary.json'),
    JSON.stringify(summary, null, 1),
  );
});

describe(`ResultScreen boundary/i18n/a11y stress (${SEEDS.length} seeded variants from ${BASE_SEED})`, () => {
  it.each(SEEDS)(
    'seed %d renders, walks and exposes an accessible guide',
    async seed => {
      const result = await runVariant(seed);
      results.push(result);
      if (result.outcome === 'BROKEN') {
        const lines = result.issues.map(
          issue => `[${issue.check} @ ${issue.page}] ${issue.detail}`,
        );
        throw new Error(
          `seed ${seed} BROKEN (${JSON.stringify(result.variant)}):\n${lines.join('\n')}`,
        );
      }
    },
  );
});
