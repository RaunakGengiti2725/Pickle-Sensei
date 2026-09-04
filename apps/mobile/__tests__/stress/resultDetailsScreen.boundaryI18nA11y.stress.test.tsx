/**
 * STRESS — ResultDetailsScreen · lens `boundary-i18n-a11y`.
 *
 * Renders `ResultDetailsScreen` through the REAL React Navigation native
 * stack (`Tabs → Result → ResultDetails`, `index: 2`), the real
 * `SafeAreaProvider` + `QueryClientProvider` composition from App.tsx, the
 * real evidence hook (`useStrokeResultEvidence` → SQLite repository), the
 * real pose-sidecar verifier (SHA-256 over the artifact bridge) and the real
 * zustand training store. Only native seams are replaced:
 *   - `@op-engineering/op-sqlite`      → Node 22 `node:sqlite` in memory;
 *   - `NativeModules.PickleVideoCapture` → in-memory artifact map;
 *   - training `fetch`                 → deterministic per-variant responder.
 *
 * Every variant is derived from ONE integer seed (mulberry32). Replay one:
 *   STRESS_SEEDS=<seed> npx jest --ci __tests__/stress/resultDetailsScreen
 * Run the campaign (default is a fast 6-variant smoke):
 *   STRESS_ITER=160 STRESS_OUT=/tmp/stress npx jest --ci __tests__/stress/…
 *
 * Hard invariants (a failing seed fails the suite):
 *   H1 no render/effect crash, no unhandled rejection, no console.error;
 *   H2 the correct branch renders (breakdown / missing) for the seeded data;
 *   H3 every interactive host node exposes an accessibilityRole AND a label
 *      (explicit accessibilityLabel or descendant text);
 *   H4 no malformed text (undefined/null/NaN/[object Object]/U+FFFD/lone
 *      surrogate) reaches a Text node; injected strings survive verbatim;
 *   H5 navigation actions land on the expected route + params;
 *   H6 unmount is clean (no state update after unmount).
 * Soft signals (recorded in the JSON table, never asserted, because the
 * test renderer has no layout engine): declared target size < 44pt,
 * numberOfLines clip-risk estimates, absolute overlays.
 */
import React from 'react';
import {
  Dimensions,
  I18nManager,
  NativeModules,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import { DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import type { NavigationContainerRef } from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { sha256Hex } from '@pickle/swing-domain';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { RootStackParams } from '../../src/navigation/params';
import type { CapturedClip } from '../../src/camera/capture';

declare const require: (id: string) => unknown;
declare const process: {
  env: Record<string, string | undefined>;
  cwd(): string;
};

// ─── Native seams ───────────────────────────────────────────────────────────

interface SqliteStatement {
  all(...params: (string | number | null)[]): Record<string, unknown>[];
}
interface DatabaseSync {
  prepare(sql: string): SqliteStatement;
  close(): void;
}
const mockSqlite = require('node:sqlite') as {
  DatabaseSync: new (location: string) => DatabaseSync;
};

jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    const db = new mockSqlite.DatabaseSync(':memory:');
    return {
      executeSync: (sql: string) => ({ rows: db.prepare(sql).all() }),
      execute: async (sql: string, params: unknown[] = []) => ({
        rows: db.prepare(sql).all(...(params as (string | number | null)[])),
      }),
      close: () => db.close(),
    };
  },
}));

const artifactStore = new Map<string, string>();
Object.assign(NativeModules, {
  PickleVideoCapture: {
    readTextFile: async (uri: string): Promise<string> => {
      const text = artifactStore.get(uri);
      if (text === undefined) throw new Error(`artifact unreadable: ${uri}`);
      return text;
    },
  },
});

// App modules are required AFTER the native seam is installed because
// `src/camera/capture.ts` snapshots `NativeModules.PickleVideoCapture` at
// module-evaluation time.
const { ResultDetailsScreen } =
  require('../../src/screens/ResultDetailsScreen') as typeof import('../../src/screens/ResultDetailsScreen');
const { getDb } =
  require('../../src/data/db') as typeof import('../../src/data/db');
const { setActiveDataOwner } =
  require('../../src/data/accountScope') as typeof import('../../src/data/accountScope');
const repository =
  require('../../src/data/repository') as typeof import('../../src/data/repository');
const { OUTBOX_MAX_ATTEMPTS } =
  require('../../src/data/sync') as typeof import('../../src/data/sync');
const { clearTrainingStoreConfiguration, configureTrainingStore } =
  require('../../src/training/store') as typeof import('../../src/training/store');
const { createTrainingApi } =
  require('../../src/training/api') as typeof import('../../src/training/api');
const { clearTryAgainHandoff, peekTryAgainHandoff } =
  require('../../src/screens/tryAgainHandoff') as typeof import('../../src/screens/tryAgainHandoff');

const fs = require('node:fs') as typeof import('node:fs');
const path = require('node:path') as typeof import('node:path');

// ─── Deterministic RNG ──────────────────────────────────────────────────────

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
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function uuidFrom(rng: () => number): string {
  const hex = '0123456789abcdef';
  let out = '';
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(rng() * 16)];
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-8${out.slice(17, 20)}-${out.slice(20, 32)}`;
}

// ─── Campaign dimensions ────────────────────────────────────────────────────

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

/** IANA has no UTC−14 zone: the real minimum is UTC−12 (`Etc/GMT+12`);
 * `Pacific/Kiritimati` is UTC+14. The rest are DST-edge / odd-offset zones. */
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

const FONT_SCALES = [0.85, 1, 2.35] as const;
const WIDTHS = [320, 375, 430] as const;

/** Instants sitting on DST transitions plus epoch/2038 edges and an invalid
 * ISO string (stored rows are unvalidated JSON). */
const CAPTURED_AT = [
  '2026-03-08T06:59:59.000Z', // US spring-forward second before
  '2026-03-29T01:00:00.000Z', // EU spring-forward instant
  '2026-10-25T00:59:59.500Z', // EU fall-back, ambiguous local hour
  '2026-11-01T05:30:00.000Z', // US fall-back, ambiguous local hour
  '2026-04-05T15:30:00.000Z', // Lord Howe 30-min DST end
  '2026-09-06T03:00:00.000Z', // Santiago DST start
  '1970-01-01T00:00:00.000Z',
  '2038-01-19T03:14:07.000Z',
  'not-a-date',
] as const;

const STRING_CLASSES = [
  'ascii_200',
  'cjk',
  'arabic_rtl',
  'zwj_emoji',
  'combining_marks',
  'german_compound',
  'thai_no_spaces',
  'empty',
  'whitespace',
  'mixed_bidi',
] as const;
type StringClass = (typeof STRING_CLASSES)[number];

const NUMERIC_CLASSES = [
  'nominal',
  'zero',
  'negative',
  'huge',
  'tiny',
] as const;
type NumericClass = (typeof NUMERIC_CLASSES)[number];

const TOPOLOGIES = [
  'scored_full',
  'scored_disagreement',
  'scored_predicted_l3',
  'scored_shot_type_injected',
  'record_only_abstained',
  'record_result_embedded',
  'legacy_record_no_intent',
  'heterogeneous_nulls',
  'local_only_unscored',
  'capture_corrupt',
  'capture_zero_duration',
  'missing',
] as const;
type Topology = (typeof TOPOLOGIES)[number];

const SYNC_STATES = [
  'synced',
  'queued',
  'rejected',
  'exhausted',
  'absent',
] as const;
type SyncState = (typeof SYNC_STATES)[number];

const TRAINING_STATES = [
  'unconfigured',
  'plan_for_this_read',
  'plan_for_this_read_completed_items',
  'plan_other_read',
  'completed_by_this_read',
  'no_plan',
  'server_error',
  'malformed_plan',
  'network_down',
] as const;
type TrainingState = (typeof TRAINING_STATES)[number];

const SIDECAR_STATES = [
  'valid',
  'hash_mismatch',
  'unreadable',
  'absent',
] as const;
type SidecarState = (typeof SIDECAR_STATES)[number];

const ID_CLASSES = ['uuid', 'unicode_long'] as const;
type IdClass = (typeof ID_CLASSES)[number];

const ACTIONS = [
  'none',
  'header_back',
  'attempt_chip',
  'form_review',
  'fix_item_review',
  'capture_new_read',
  'training_retry',
  'scrubber_increment',
] as const;
type Action = (typeof ACTIONS)[number];

interface VariantSpec {
  seed: number;
  locale: (typeof LOCALES)[number];
  timeZone: (typeof TIME_ZONES)[number];
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  rtl: boolean;
  stringClass: StringClass;
  numericClass: NumericClass;
  topology: Topology;
  sync: SyncState;
  training: TrainingState;
  sidecar: SidecarState;
  idClass: IdClass;
  attempts: number;
  capturedAtIso: (typeof CAPTURED_AT)[number];
  action: Action;
}

function specFor(seed: number): VariantSpec {
  const rng = mulberry32(seed);
  const locale = pick(rng, LOCALES);
  return {
    seed,
    locale,
    timeZone: pick(rng, TIME_ZONES),
    fontScale: pick(rng, FONT_SCALES),
    width: pick(rng, WIDTHS),
    rtl: locale === 'ar-EG',
    stringClass: pick(rng, STRING_CLASSES),
    numericClass: pick(rng, NUMERIC_CLASSES),
    topology: pick(rng, TOPOLOGIES),
    sync: pick(rng, SYNC_STATES),
    training: pick(rng, TRAINING_STATES),
    sidecar: pick(rng, SIDECAR_STATES),
    idClass: pick(rng, ID_CLASSES),
    attempts: pick(rng, [0, 1, 2, 3, 7, 25] as const),
    capturedAtIso: pick(rng, CAPTURED_AT),
    action: pick(rng, ACTIONS),
  };
}

// ─── Payload strings (dossier-safe: no product claims, no forbidden terms) ──

function payloadString(cls: StringClass, rng: () => number): string {
  const salt = Math.floor(rng() * 1e6).toString(36);
  switch (cls) {
    case 'ascii_200':
      return (
        `Long drill name ${salt} ` +
        'keeps the paddle face steady through the contact window and repeats '.repeat(
          3,
        ) +
        'until the motion feels smooth and unhurried every single rep'
      );
    case 'cjk':
      return `正面のドライブでは接触の瞬間まで${salt}パドル面を安定させ、体の前で打点を迎える練習を繰り返します。`.repeat(
        4,
      );
    case 'arabic_rtl':
      return `تمرين الضربة الأمامية ${salt} يركّز على ثبات وجه المضرب حتى لحظة التلامس ويكرّر الحركة بهدوء `.repeat(
        3,
      );
    case 'zwj_emoji':
      return `👨‍👩‍👧‍👦🏳️‍🌈🧑🏽‍🦽👩🏿‍🚀 ${salt} 🏓🇺🇸🇧🇷 `.repeat(6);
    case 'combining_marks':
      return `Z̴̡̛͚a̷̢̯̮l̶̬͈̲g̸̥̭o̴̢̗ ${salt} c̶̡̢͖̲̲͙̥o̷̡̢̧̡̼̦n̸̡̢̛̙͚̯t̶̢̧̛͖̲a̸̢̨̛̙͚c̷̡̢̧̼̦t̶̡̢̛͖̲ `.repeat(6);
    case 'german_compound':
      return `Rückhandschlagvorbereitungsübungsprogramm${salt}Donaudampfschifffahrtsgesellschaftskapitänsmützenschirm`.repeat(
        3,
      );
    case 'thai_no_spaces':
      return `การฝึกตีลูกโฟร์แฮนด์${salt}ให้หน้าไม้นิ่งจนถึงจุดสัมผัสและทำซ้ำอย่างสบาย`.repeat(
        5,
      );
    case 'empty':
      return '';
    case 'whitespace':
      return ' \t\n\u00a0\u2003 ';
    case 'mixed_bidi':
      return `Drive ${salt} ضربة أمامية — vorbereitung 準備 ‏‮reversed‬ ‎ltr`.repeat(
        4,
      );
    default:
      return salt;
  }
}

interface NumericSet {
  overallScore: number;
  checkpointScore: number;
  confidence: number;
  startMs: number;
  contactMs: number;
  endMs: number;
  durationMs: number;
  baselineScore: number;
  scoreDelta: number;
  restSeconds: number;
  targetSets: number;
  targetReps: number;
  severity: number;
}

function numericSet(cls: NumericClass): NumericSet {
  switch (cls) {
    case 'zero':
      return {
        overallScore: 0,
        checkpointScore: 0,
        confidence: 0,
        startMs: 0,
        contactMs: 0,
        endMs: 0,
        durationMs: 0,
        baselineScore: 0,
        scoreDelta: 0,
        restSeconds: 0,
        targetSets: 0,
        targetReps: 0,
        severity: 0,
      };
    case 'negative':
      return {
        overallScore: -3.5,
        checkpointScore: -50,
        confidence: -0.2,
        startMs: -500,
        contactMs: -100,
        endMs: -1,
        durationMs: -3400,
        baselineScore: -7,
        scoreDelta: -12.5,
        restSeconds: -30,
        targetSets: -1,
        targetReps: -8,
        severity: -1,
      };
    case 'huge':
      return {
        overallScore: 1e21,
        checkpointScore: 1e9,
        confidence: 1e6,
        startMs: 0,
        contactMs: 2 ** 53,
        endMs: 1e15,
        durationMs: 1e15,
        baselineScore: 1e308,
        scoreDelta: 1e21,
        restSeconds: 2 ** 31,
        targetSets: 1e9,
        targetReps: 2 ** 53,
        severity: 1e6,
      };
    case 'tiny':
      return {
        overallScore: 1e-7,
        checkpointScore: 1e-9,
        confidence: 1e-12,
        startMs: 0.0001,
        contactMs: 0.5,
        endMs: 0.75,
        durationMs: 1,
        baselineScore: 1e-7,
        scoreDelta: -1e-7,
        restSeconds: 1e-3,
        targetSets: 1e-3,
        targetReps: 0.5,
        severity: 1e-9,
      };
    default:
      return {
        overallScore: 7.1,
        checkpointScore: 61,
        confidence: 0.84,
        startMs: 0,
        contactMs: 1900,
        endMs: 3200,
        durationMs: 3400,
        baselineScore: 7.4,
        scoreDelta: 1.2,
        restSeconds: 20,
        targetSets: 3,
        targetReps: 8,
        severity: 0.52,
      };
  }
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  confidence: number,
): PhaseSpan {
  return {
    key,
    startMs,
    representativeMs: startMs + (endMs - startMs) / 2,
    endMs,
    confidence,
  };
}

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  n: NumericSet,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: n.confidence,
    band,
    direction,
    severity: score === null ? 0 : n.severity,
    applicable: true,
    ...overrides,
  };
}

function buildAnalysis(input: {
  id: string;
  sessionId: string | null;
  capturedAtIso: string;
  n: NumericSet;
  resultKind: 'scored' | 'low_confidence';
  shotType: string;
}): ShotAnalysis {
  const { n } = input;
  const c = n.checkpointScore;
  const span = n.endMs - n.startMs;
  const at = (fraction: number) => n.startMs + span * fraction;
  return {
    id: input.id,
    sessionId: input.sessionId,
    shotType: input.shotType as ShotAnalysis['shotType'],
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: input.capturedAtIso,
    timestamps: { startMs: n.startMs, contactMs: n.contactMs, endMs: n.endMs },
    phases: [
      phase('ready', at(0), at(0.28), n.confidence),
      phase('prepare', at(0.28), at(0.47), n.confidence),
      phase('accelerate', at(0.47), at(0.59), n.confidence),
      phase('contact', at(0.59), at(0.6), n.confidence),
      phase('follow_through', at(0.6), at(0.75), n.confidence),
      phase('recover', at(0.75), at(1), n.confidence),
    ],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', c, 'green', 'none', n),
      checkpoint('athletic_base', c, 'yellow', 'narrow', n),
      checkpoint('preparation', c, 'green', 'none', n),
      checkpoint('paddle_set', c, 'green', 'none', n),
      checkpoint('swing_length', null, 'unscored', 'none', n),
      checkpoint('sequencing', c, 'green', 'none', n),
      checkpoint('paddle_path', c, 'red', 'low', n),
      checkpoint('contact_position', c, 'red', 'late', n),
      checkpoint('face_wrist_stability', c, 'red', 'unstable', n, {
        applicable: false,
      }),
      checkpoint('follow_through', c, 'green', 'short', n),
      checkpoint('recovery', c, 'green', 'none', n),
    ],
    overallScore: input.resultKind === 'scored' ? n.overallScore : null,
    analysisConfidence: n.confidence,
    resultKind: input.resultKind,
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: n.severity,
      confidence: n.confidence,
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
  };
}

const LANDMARKS = [
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

function sidecarJson(frameCount: number): string {
  const frames = [];
  for (let i = 0; i < frameCount; i += 1) {
    const sweep = i / Math.max(1, frameCount - 1);
    frames.push({
      i,
      t: i * 40,
      c: 0.9,
      l: LANDMARKS.map(name => ({
        n: name,
        x: name === 'right_wrist' ? 0.3 + 0.4 * sweep : 0.5,
        y: name === 'head' ? 0.18 : 0.5,
        v: 0.95,
      })),
    });
  }
  return JSON.stringify({
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
    video: { w: 1080, h: 1920, fps: 30 },
    frames,
  });
}

function importedClip(input: {
  uri: string;
  durationMs: number;
  capturedAtIso: string;
  sidecar: { uri: string; sha256: string; frameCount: number } | null;
}): CapturedClip {
  const clip = {
    captureMode: 'imported_video',
    uri: input.uri,
    durationMs: input.durationMs,
    fps: 30,
    width: 1080,
    height: 1920,
    capturedAtIso: input.capturedAtIso,
    posterUri: `${input.uri}.poster.jpg`,
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(input.sidecar
      ? {
          poseSequence: {
            schemaVersion: 1,
            format: 'pickle.pose-sequence.v1',
            uri: input.sidecar.uri,
            frameCount: input.sidecar.frameCount,
            sha256: input.sidecar.sha256,
            coordinateSystem: 'normalized_image_top_left',
            poseModelVersion: 'apple-vision-bodypose-1',
          },
        }
      : {}),
  };
  return clip as unknown as CapturedClip;
}

interface SeededWorld {
  owner: string;
  analysisId: string;
  captureId: string;
  sessionId: string;
  payload: string;
  otherAttemptIds: string[];
  /** Strings the rendered tree MUST contain verbatim (H4 integrity). */
  mustContain: string[];
  /** Same, compared lower-cased (titleCase path). */
  mustContainLower: string[];
  expectBranch: 'breakdown' | 'missing';
  scoredReal: boolean;
  planCompletedAt: string | null;
}

async function seedWorld(spec: VariantSpec): Promise<SeededWorld> {
  const rng = mulberry32(spec.seed ^ 0x5eed);
  const owner = uuidFrom(rng);
  setActiveDataOwner(owner);
  const db = getDb();
  const payload = payloadString(spec.stringClass, rng);
  const idBase = uuidFrom(rng);
  const analysisId =
    spec.idClass === 'unicode_long'
      ? `id-${payload.length > 0 ? payload.slice(0, 220) : 'empty'}-${idBase}`
      : idBase;
  const captureId = `cap-${idBase}`;
  const sessionId = `set-${idBase}`;
  const n = numericSet(spec.numericClass);
  const capturedAtIso = spec.capturedAtIso;
  // Capture rows validate their own ISO stamp; the analysis row keeps the
  // possibly-invalid one so the surface is exercised with it.
  const captureIso = Number.isNaN(Date.parse(capturedAtIso))
    ? '2026-09-01T10:00:00.000Z'
    : capturedAtIso;
  const mustContain: string[] = [];
  const mustContainLower: string[] = [];
  const otherAttemptIds: string[] = [];

  const shotType =
    spec.topology === 'scored_shot_type_injected' && payload.trim().length > 0
      ? payload
      : 'forehand_drive';
  const hasLocalShot =
    spec.topology !== 'record_only_abstained' &&
    spec.topology !== 'record_result_embedded' &&
    spec.topology !== 'missing' &&
    spec.topology !== 'heterogeneous_nulls';
  const scoredKind: 'scored' | 'low_confidence' =
    spec.topology === 'local_only_unscored' ? 'low_confidence' : 'scored';
  const analysis = buildAnalysis({
    id: analysisId,
    sessionId,
    capturedAtIso,
    n,
    resultKind: scoredKind,
    shotType,
  });

  if (hasLocalShot) {
    if (scoredKind === 'scored') {
      await repository.saveAnalysis(db, analysis, `permit-${idBase}`);
    } else {
      await repository.saveLocalOnlyAnalysis(db, analysis);
    }
    for (let i = 0; i < spec.attempts; i += 1) {
      const otherId = `${idBase}-attempt-${i}`;
      otherAttemptIds.push(otherId);
      const other = buildAnalysis({
        id: otherId,
        sessionId,
        capturedAtIso: `2026-09-01T0${(i % 9) + 1}:${String(i % 60).padStart(2, '0')}:00.000Z`,
        n: numericSet('nominal'),
        resultKind: 'scored',
        shotType: 'forehand_drive',
      });
      await repository.saveAnalysis(db, other, `permit-${otherId}`);
    }
  }

  // Sync evidence (owner-scoped receipt / outbox rows).
  if (hasLocalShot && scoredKind === 'scored') {
    switch (spec.sync) {
      case 'synced':
        await db.execute(
          `INSERT INTO sync_receipt (owner_key, kind, entity_id) VALUES (?, 'shot.sync', ?)`,
          [owner, analysisId],
        );
        break;
      case 'rejected':
        await db.execute(
          `UPDATE outbox SET attempts = 1, last_error = ? WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
          [payload.length > 0 ? payload : 'server refused', owner, analysisId],
        );
        break;
      case 'exhausted':
        await db.execute(
          `UPDATE outbox SET attempts = ?, last_error = ? WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
          [OUTBOX_MAX_ATTEMPTS, payload, owner, analysisId],
        );
        break;
      case 'absent':
        await db.execute(
          `DELETE FROM outbox WHERE owner_key = ? AND json_extract(payload, '$.id') = ?`,
          [owner, analysisId],
        );
        break;
      default:
        break;
    }
  }

  // Capture row + sidecar artifact.
  const clipUri = `file:///captures/${idBase}.mov`;
  const sidecarUri = `file:///captures/${idBase}.pose.json`;
  const frameCount = 81;
  const sidecarText = sidecarJson(frameCount);
  const wantsCapture =
    spec.topology !== 'missing' && spec.topology !== 'legacy_record_no_intent';
  let sidecarRef: { uri: string; sha256: string; frameCount: number } | null =
    null;
  if (spec.sidecar !== 'absent') {
    const trueHash = sha256Hex(sidecarText);
    sidecarRef = {
      uri: sidecarUri,
      frameCount,
      sha256: spec.sidecar === 'hash_mismatch' ? 'ab'.repeat(32) : trueHash,
    };
    if (spec.sidecar !== 'unreadable')
      artifactStore.set(sidecarUri, sidecarText);
  }
  if (wantsCapture) {
    const durationMs =
      spec.topology === 'capture_zero_duration'
        ? 0
        : Math.max(1, Math.min(n.durationMs, 1e15)) || 3400;
    if (spec.topology === 'capture_corrupt') {
      await db.execute(
        `INSERT INTO local_capture
          (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
         VALUES (?, ?, ?, 'forehand_drive', 'forehand_drive', ?, 3400, 30, 1080, 1920, 'analyzed', ?)`,
        [
          owner,
          captureId,
          clipUri,
          captureIso,
          '{"captureMode":"imported_video",',
        ],
      );
    } else if (spec.topology === 'capture_zero_duration') {
      await db.execute(
        `INSERT INTO local_capture
          (owner_key, id, uri, shot_type, declared_stroke, captured_at, duration_ms, fps, width, height, status, payload)
         VALUES (?, ?, ?, 'forehand_drive', 'forehand_drive', ?, 0, 30, 1080, 1920, 'analyzed', NULL)`,
        [owner, captureId, clipUri, captureIso],
      );
    } else {
      await repository.savePendingCapture(
        db,
        captureId,
        'forehand_drive',
        importedClip({
          uri: clipUri,
          durationMs,
          capturedAtIso: captureIso,
          sidecar: sidecarRef,
        }),
        'forehand_drive',
      );
    }
  }

  // Analysis record (heterogeneous JSON, exactly as stored rows are).
  const baseIntent = {
    declaredStroke: 'forehand_drive',
    predictedStroke: null,
    resolutionBasis: 'declared',
    resolvedProfileId: 'FOREHAND_DRIVE',
    resolvedProfileVersion: 'technique-profile-v1',
    disagreement: null,
  };
  const uncertainty = {
    analysisConfidence: n.confidence,
    presentation: 'normal',
    limitingFactors: [
      'paddle_track_unavailable',
      'ball_track_unavailable',
      'court_geometry_unavailable',
      ...(payload.trim().length > 0 ? [payload] : []),
    ],
  };
  let record: Record<string, unknown> | null = {
    id: analysisId,
    captureId,
    createdAtIso: captureIso,
    strokeIntent: baseIntent,
    result: null,
    uncertainty,
  };
  switch (spec.topology) {
    case 'scored_disagreement':
      record.strokeIntent = {
        ...baseIntent,
        disagreement: {
          declared: payload.trim().length > 0 ? payload : 'forehand_drive',
          predictedLabel: payload.trim().length > 0 ? payload : 'BACKHAND',
        },
      };
      // Labels pass through strokeResultModel `humanizeToken` (underscores →
      // spaces, trimmed) and `titleCase`; the oracle applies the same shape.
      if (payload.trim().length > 0)
        mustContainLower.push(payload.replace(/_/g, ' ').trim().toLowerCase());
      break;
    case 'scored_predicted_l3':
      record.strokeIntent = {
        ...baseIntent,
        declaredStroke: null,
        resolutionBasis: 'predicted_l3',
        predictedStroke: {
          label: 'FOREHAND',
          leaf: payload.trim().length > 0 ? payload : 'forehand_drive',
          confidence: n.confidence,
        },
      };
      if (payload.trim().length > 0)
        mustContainLower.push(payload.replace(/_/g, ' ').trim().toLowerCase());
      break;
    case 'record_only_abstained':
      record.strokeIntent = {
        ...baseIntent,
        declaredStroke: null,
        resolutionBasis: 'abstained',
      };
      record.temporalPhasesV2 = {
        status: 'abstained',
        reason: payload.trim().length > 0 ? payload : 'insufficient_motion',
      };
      break;
    case 'record_result_embedded':
      record.result = analysis;
      break;
    case 'legacy_record_no_intent':
      record = { id: analysisId };
      break;
    case 'heterogeneous_nulls':
      record = {
        id: analysisId,
        captureId,
        strokeIntent: null,
        result: null,
        uncertainty: { limitingFactors: undefined },
        contact: null,
        temporalPhasesV2: null,
        captureEnvelope: null,
      };
      break;
    case 'missing':
      record = null;
      break;
    default:
      break;
  }
  if (record) {
    await db.execute(
      `INSERT INTO local_analysis_record
        (owner_key, id, capture_id, created_at, engine_version, scoring_model_version, record)
       VALUES (?, ?, ?, ?, 'stress-engine', 'sm-v1', ?)`,
      [owner, analysisId, captureId, captureIso, JSON.stringify(record)],
    );
  }

  const analysisVisible =
    hasLocalShot || spec.topology === 'record_result_embedded';
  const expectBranch: SeededWorld['expectBranch'] =
    spec.topology === 'missing' ? 'missing' : 'breakdown';
  // `heterogeneous_nulls` has a record row but no analysis → still breakdown.
  const scoredReal = analysisVisible && scoredKind === 'scored';

  // Training store.
  clearTryAgainHandoff();
  let planCompletedAt: string | null = null;
  if (spec.training === 'unconfigured') {
    clearTrainingStoreConfiguration();
  } else {
    const planId = uuidFrom(rng);
    const drillTitle =
      payload.trim().length > 0 ? payload : 'Contact Shadow Reps';
    const drill = {
      slug: 'contact-shadow',
      title: drillTitle,
      description:
        payload.trim().length > 0
          ? payload
          : 'A coach-reviewed contact prescription.',
      coachName: payload.trim().length > 0 ? payload : 'Coach Rivera',
      equipment: ['paddle'],
      saved: false,
    };
    const completion =
      spec.training === 'plan_for_this_read_completed_items'
        ? {
            id: uuidFrom(rng),
            completedAt: captureIso,
            actualRepetitions: n.targetReps,
            actualDurationSeconds: null,
            qualifiesForStreak: true,
          }
        : null;
    if (completion) planCompletedAt = completion.completedAt;
    const items = [1, 2, 3].map(position => ({
      id: uuidFrom(rng),
      position,
      kind: position === 1 ? 'warmup' : 'targeted',
      drill: { ...drill, slug: `${drill.slug}-${position}` },
      cueText:
        payload.trim().length > 0
          ? payload
          : 'Meet the ball comfortably in front.',
      targetSets: n.targetSets,
      targetRepetitionsPerSet: n.targetReps,
      targetDurationSeconds: null,
      restSeconds: n.restSeconds,
      completion,
    }));
    items.push({
      id: uuidFrom(rng),
      position: 4,
      kind: 'reassessment',
      drill: null as unknown as typeof drill,
      cueText: null as unknown as string,
      targetSets: null as unknown as number,
      targetRepetitionsPerSet: null as unknown as number,
      targetDurationSeconds: null,
      restSeconds: null as unknown as number,
      completion: null,
    });
    const isCompletedByThisRead = spec.training === 'completed_by_this_read';
    const plan = {
      id: planId,
      status: isCompletedByThisRead ? 'completed' : 'active',
      algorithmVersion: 'reviewed-plan-v1',
      // The server only ever returns UUID shot ids, so a non-UUID local id
      // can never be a plan's source: those variants degrade to "other read".
      sourceShotId:
        spec.training === 'plan_other_read' ||
        isCompletedByThisRead ||
        spec.idClass !== 'uuid'
          ? uuidFrom(rng)
          : analysisId,
      shotType: shotType,
      priorityCheckpoint: 'contact_position',
      priorityDirection: 'late',
      baselineScore: n.baselineScore,
      baselineCheckpointScore: n.checkpointScore,
      reassessmentShotId: isCompletedByThisRead ? analysisId : null,
      scoreDelta: isCompletedByThisRead ? n.scoreDelta : null,
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: isCompletedByThisRead ? captureIso : null,
      items,
    };
    // The plan is only rendered for a scored, real analysis whose id is the
    // plan's source shot: then its drill copy must survive verbatim.
    if (
      (spec.training === 'plan_for_this_read' ||
        spec.training === 'plan_for_this_read_completed_items') &&
      spec.idClass === 'uuid' &&
      scoredReal &&
      payload.trim().length > 0
    ) {
      mustContain.push(payload);
    }
    if (spec.idClass !== 'uuid') planCompletedAt = null;
    const responder = async (input: string): Promise<Response> => {
      const url = new URL(input);
      const body = (status: number, json: unknown): Response =>
        ({
          ok: status >= 200 && status < 300,
          status,
          statusText: status === 200 ? 'OK' : 'Error',
          json: async () => json,
        }) as Response;
      if (spec.training === 'network_down')
        throw new TypeError('Network request failed');
      if (url.pathname === '/v1/training-plans/current') {
        switch (spec.training) {
          case 'no_plan':
            return body(200, { plan: null });
          case 'server_error':
            return body(500, {
              error: { code: 'training.request_failed', message: payload },
            });
          case 'malformed_plan':
            return body(200, {
              plan: { ...plan, status: payload, items: 'nope' },
            });
          default:
            return body(200, { plan });
        }
      }
      return body(404, { error: { code: 'not_found', message: 'no route' } });
    };
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://stress.invalid',
        token: 'stress-token',
        fetchFn: responder,
      }),
    );
  }

  return {
    owner,
    analysisId,
    captureId,
    sessionId,
    payload,
    otherAttemptIds,
    mustContain,
    mustContainLower,
    expectBranch,
    scoredReal,
    planCompletedAt,
  };
}

// ─── Device / locale simulation ─────────────────────────────────────────────

const nativeDateProto = Date.prototype;
const nativeNumberProto = Number.prototype;
const origToLocaleDateString = nativeDateProto.toLocaleDateString;
const origToLocaleTimeString = nativeDateProto.toLocaleTimeString;
const origToLocaleString = nativeDateProto.toLocaleString;
const origNumberToLocaleString = nativeNumberProto.toLocaleString;
const OrigDateTimeFormat = Intl.DateTimeFormat;
const OrigNumberFormat = Intl.NumberFormat;

function installDeviceLocale(locale: string): void {
  type L = string | string[] | undefined;
  nativeDateProto.toLocaleDateString = function (
    this: Date,
    l?: L,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return origToLocaleDateString.call(this, l ?? locale, o);
  };
  nativeDateProto.toLocaleTimeString = function (
    this: Date,
    l?: L,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return origToLocaleTimeString.call(this, l ?? locale, o);
  };
  nativeDateProto.toLocaleString = function (
    this: Date,
    l?: L,
    o?: Intl.DateTimeFormatOptions,
  ) {
    return origToLocaleString.call(this, l ?? locale, o);
  };
  nativeNumberProto.toLocaleString = function (
    this: number,
    l?: L,
    o?: Intl.NumberFormatOptions,
  ) {
    return origNumberToLocaleString.call(this, l ?? locale, o);
  };
  const defaulting = <T extends object>(Target: T): T =>
    new Proxy(Target, {
      construct(target, args: unknown[], newTarget) {
        return Reflect.construct(
          target as unknown as new (...a: unknown[]) => object,
          [args[0] ?? locale, args[1]],
          newTarget,
        );
      },
      apply(target, thisArg, args: unknown[]) {
        return Reflect.apply(
          target as unknown as (...a: unknown[]) => unknown,
          thisArg,
          [args[0] ?? locale, args[1]],
        );
      },
    });
  Intl.DateTimeFormat = defaulting(OrigDateTimeFormat);
  Intl.NumberFormat = defaulting(OrigNumberFormat);
}

function restoreDeviceLocale(): void {
  nativeDateProto.toLocaleDateString = origToLocaleDateString;
  nativeDateProto.toLocaleTimeString = origToLocaleTimeString;
  nativeDateProto.toLocaleString = origToLocaleString;
  nativeNumberProto.toLocaleString = origNumberToLocaleString;
  Intl.DateTimeFormat = OrigDateTimeFormat;
  Intl.NumberFormat = OrigNumberFormat;
}

const originalTz = process.env.TZ;
const originalDims = Dimensions.get('window');

function installDevice(spec: VariantSpec): void {
  process.env.TZ = spec.timeZone;
  installDeviceLocale(spec.locale);
  const window = {
    width: spec.width,
    height: Math.round(spec.width * 2.16),
    scale: 3,
    fontScale: spec.fontScale,
  };
  Dimensions.set({ window, screen: window });
  const i18n = I18nManager as unknown as { isRTL: boolean };
  i18n.isRTL = spec.rtl;
}

function restoreDevice(): void {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
  restoreDeviceLocale();
  Dimensions.set({ window: originalDims, screen: originalDims });
  (I18nManager as unknown as { isRTL: boolean }).isRTL = false;
}

// ─── Real navigator + providers ─────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();

function SentinelRoute() {
  return <View testID="stress-sentinel-route" />;
}

function Harness(props: {
  analysisId: string;
  width: number;
  navRef: React.RefObject<NavigationContainerRef<RootStackParams> | null>;
  queryClient: QueryClient;
}) {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: {
          x: 0,
          y: 0,
          width: props.width,
          height: Math.round(props.width * 2.16),
        },
        insets: { top: 47, bottom: 34, left: 0, right: 0 },
      }}
    >
      <QueryClientProvider client={props.queryClient}>
        <NavigationContainer
          ref={props.navRef}
          theme={DefaultTheme}
          initialState={{
            index: 2,
            routes: [
              { name: 'Tabs' },
              { name: 'Result', params: { analysisId: props.analysisId } },
              {
                name: 'ResultDetails',
                params: { analysisId: props.analysisId },
              },
            ],
          }}
        >
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={SentinelRoute} />
            <Stack.Screen name="Result" component={SentinelRoute} />
            <Stack.Screen name="Analyze" component={SentinelRoute} />
            <Stack.Screen name="FormReview" component={SentinelRoute} />
            <Stack.Screen
              name="ResultDetails"
              component={ResultDetailsScreen}
              options={{ title: 'Full breakdown' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

// ─── Tree inspection ────────────────────────────────────────────────────────

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'tab',
  'adjustable',
  'switch',
  'checkbox',
  'radio',
  'combobox',
  'menuitem',
  'slider',
  'spinbutton',
  'togglebutton',
  'imagebutton',
  'search',
]);

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostType(node: ReactTestInstance): string | null {
  return typeof node.type === 'string' ? node.type : null;
}

function hostChildrenText(node: ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (child: ReactTestInstance | string | number) => {
    if (typeof child === 'string' || typeof child === 'number') {
      parts.push(String(child));
      return;
    }
    for (const grand of child.children) visit(grand);
  };
  visit(node);
  return parts.join('');
}

interface Flat {
  width?: number;
  height?: number;
  minWidth?: number;
  minHeight?: number;
  position?: string;
  overflow?: string;
  fontSize?: number;
}

function flat(style: StyleProp<ViewStyle>): Flat {
  return (StyleSheet.flatten(style) ?? {}) as Flat;
}

interface InteractiveNode {
  type: string;
  testID: string | null;
  role: string | null;
  label: string | null;
  derivedLabel: string | null;
  hitSlop: number;
  declaredHeight: number | null;
  declaredWidth: number | null;
  effectiveHeight: number | null;
  effectiveWidth: number | null;
  undersized: boolean;
  unmeasured: boolean;
}

function inspectInteractive(root: ReactTestInstance): InteractiveNode[] {
  const nodes = root.findAll(
    node =>
      isHost(node) &&
      hostType(node) !== 'RCTScrollView' &&
      (typeof node.props.onClick === 'function' ||
        typeof node.props.onPress === 'function' ||
        INTERACTIVE_ROLES.has(String(node.props.accessibilityRole ?? '')) ||
        Array.isArray(node.props.accessibilityActions)),
  );
  return nodes.map(node => {
    const props = node.props as Record<string, unknown>;
    const f = flat(props.style as StyleProp<ViewStyle>);
    const slop = props.hitSlop;
    const slopV =
      typeof slop === 'number'
        ? slop * 2
        : slop && typeof slop === 'object'
          ? Number((slop as { top?: number }).top ?? 0) +
            Number((slop as { bottom?: number }).bottom ?? 0)
          : 0;
    const slopH =
      typeof slop === 'number'
        ? slop * 2
        : slop && typeof slop === 'object'
          ? Number((slop as { left?: number }).left ?? 0) +
            Number((slop as { right?: number }).right ?? 0)
          : 0;
    const h = f.height ?? f.minHeight ?? null;
    const w = f.width ?? f.minWidth ?? null;
    const label =
      typeof props.accessibilityLabel === 'string' &&
      props.accessibilityLabel.trim().length > 0
        ? props.accessibilityLabel
        : null;
    const derived = hostChildrenText(node).trim();
    const effH = h === null ? null : h + slopV;
    const effW = w === null ? null : w + slopH;
    return {
      type: String(node.type),
      testID: typeof props.testID === 'string' ? props.testID : null,
      role:
        typeof props.accessibilityRole === 'string'
          ? props.accessibilityRole
          : null,
      label,
      derivedLabel: derived.length > 0 ? derived.slice(0, 80) : null,
      hitSlop: Math.max(slopV, slopH) / 2,
      declaredHeight: h,
      declaredWidth: w,
      effectiveHeight: effH,
      effectiveWidth: effW,
      // A declared height is authoritative; a declared width alone is not
      // (buttons stretch), so width only counts when height is also known.
      undersized:
        (effH !== null && effH < 44) ||
        (effH !== null && effW !== null && effW < 44),
      unmeasured: effH === null,
    };
  });
}

const MALFORMED =
  /undefined|\bnull\b|\bNaN\b|\[object Object\]|\uFFFD|Infinity/;
const LONE_SURROGATE =
  /(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/;

interface TextFinding {
  text: string;
  reason: string;
}

interface ClipRisk {
  text: string;
  numberOfLines: number;
  fontSize: number;
  estimatedLinesNeeded: number;
}

function inspectText(
  root: ReactTestInstance,
  spec: VariantSpec,
): {
  texts: string[];
  joined: string;
  malformed: TextFinding[];
  clipRisks: ClipRisk[];
} {
  const textNodes = root.findAll(node => hostType(node) === 'Text');
  const texts: string[] = [];
  const all: string[] = [];
  const malformed: TextFinding[] = [];
  const clipRisks: ClipRisk[] = [];
  for (const node of textNodes) {
    // `texts` counts leaf-most Text hosts only (nested Text is common);
    // `joined` keeps every host's full text so split strings still match.
    const nestedText = node.children.some(
      child => typeof child !== 'string' && hostType(child) === 'Text',
    );
    const text = hostChildrenText(node);
    all.push(text);
    if (!nestedText) texts.push(text);
    if (MALFORMED.test(text))
      malformed.push({ text: text.slice(0, 160), reason: 'malformed-token' });
    if (LONE_SURROGATE.test(text))
      malformed.push({ text: text.slice(0, 160), reason: 'lone-surrogate' });
    const lines = node.props.numberOfLines;
    if (typeof lines === 'number' && lines > 0 && text.length > 0) {
      const f = flat(node.props.style as StyleProp<ViewStyle>);
      const fontSize = (f.fontSize ?? 14) * spec.fontScale;
      const usable = Math.max(120, spec.width - 2 * 44);
      const charsPerLine = Math.max(4, Math.floor(usable / (fontSize * 0.52)));
      const needed = Math.ceil(text.length / charsPerLine);
      if (needed > lines) {
        clipRisks.push({
          text: text.slice(0, 120),
          numberOfLines: lines,
          fontSize,
          estimatedLinesNeeded: needed,
        });
      }
    }
  }
  return { texts, joined: all.join('\n'), malformed, clipRisks };
}

// ─── Records ────────────────────────────────────────────────────────────────

interface VariantRecord {
  seed: number;
  spec: VariantSpec;
  world: Omit<SeededWorld, 'payload'> & {
    payloadLength: number;
    payloadPreview: string;
  };
  outcome: 'HELD' | 'BROKEN';
  branch: 'breakdown' | 'missing' | 'loading' | 'unknown';
  durationMs: number;
  interactive: InteractiveNode[];
  unlabeled: InteractiveNode[];
  unroled: InteractiveNode[];
  undersized: InteractiveNode[];
  unmeasuredCount: number;
  textCount: number;
  malformed: TextFinding[];
  missingInjected: string[];
  clipRisks: ClipRisk[];
  absoluteOverlays: number;
  consoleErrors: string[];
  actionResult: { action: Action; ok: boolean | null; detail: string };
  rtlApplied: boolean;
  resolvedTimeZone: string;
  loggedDateSample: string | null;
  crash: string | null;
  failures: string[];
  /** Host tree snapshot (react-test-renderer toJSON) — kept for BROKEN seeds. */
  tree: unknown;
}

const records: VariantRecord[] = [];
const outDir = process.env.STRESS_OUT;

function seedList(): number[] {
  const explicit = process.env.STRESS_SEEDS;
  if (explicit && explicit.trim().length > 0) {
    return explicit
      .split(',')
      .map(s => Number.parseInt(s.trim(), 10))
      .filter(n => Number.isFinite(n));
  }
  const base = Number.parseInt(process.env.STRESS_SEED ?? '20260904', 10);
  const iterations = Number.parseInt(process.env.STRESS_ITER ?? '6', 10);
  return Array.from({ length: iterations }, (_, i) => base + i);
}

async function tick(renderer: ReactTestRenderer | null): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(20);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  void renderer;
}

function textOf(root: ReactTestInstance): string {
  return root
    .findAll(node => hostType(node) === 'Text')
    .map(hostChildrenText)
    .join(' | ');
}

function pressableNode(
  root: ReactTestInstance,
  predicate: (props: Record<string, unknown>) => boolean,
): ReactTestInstance | null {
  const [node] = root.findAll(
    candidate =>
      typeof candidate.props.onPress === 'function' &&
      predicate(candidate.props as Record<string, unknown>),
  );
  return node ?? null;
}

async function runVariant(seed: number): Promise<VariantRecord> {
  const spec = specFor(seed);
  const started = Date.now();
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (a instanceof Error ? a.message : String(a)))
          .join(' ')
          .slice(0, 400),
      );
    });
  const failures: string[] = [];
  let crash: string | null = null;
  let renderer: ReactTestRenderer | null = null;
  const navRef = React.createRef<NavigationContainerRef<RootStackParams>>();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  let world: SeededWorld | null = null;
  let branch: VariantRecord['branch'] = 'unknown';
  let interactive: InteractiveNode[] = [];
  let textReport = {
    texts: [] as string[],
    joined: '',
    malformed: [] as TextFinding[],
    clipRisks: [] as ClipRisk[],
  };
  let absoluteOverlays = 0;
  let missingInjected: string[] = [];
  const actionResult: VariantRecord['actionResult'] = {
    action: spec.action,
    ok: null,
    detail: 'not attempted',
  };
  let loggedDateSample: string | null = null;
  let tree: unknown = null;

  artifactStore.clear();
  installDevice(spec);
  const resolvedTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    world = await seedWorld(spec);
    await act(async () => {
      renderer = TestRenderer.create(
        <Harness
          analysisId={world!.analysisId}
          width={spec.width}
          navRef={navRef}
          queryClient={queryClient}
        />,
      );
    });
    const root = (renderer as unknown as ReactTestRenderer).root;
    // Settle: evidence → sidecar → sync → training all resolve in microtasks
    // over the in-memory database; bounded so a hang is a finding, not a hang.
    for (let i = 0; i < 60; i += 1) {
      await tick(renderer);
      const text = textOf(root);
      const loading =
        text.includes('Opening your result') ||
        text.includes('Checking reviewed training');
      if (!loading && i >= 6) break;
    }
    await tick(renderer);
    const text = textOf(root);
    if (
      root.findAll(n => isHost(n) && n.props.testID === 'result-details')
        .length > 0
    )
      branch = 'breakdown';
    else if (text.includes('Result missing')) branch = 'missing';
    else if (text.includes('Opening your result')) branch = 'loading';
    if (branch !== world.expectBranch)
      failures.push(`H2 branch: expected ${world.expectBranch}, got ${branch}`);
    const focused = navRef.current?.getCurrentRoute()?.name;
    if (focused !== 'ResultDetails')
      failures.push(`H2 focus: focused route is ${String(focused)}`);

    interactive = inspectInteractive(root);
    textReport = inspectText(root, spec);
    absoluteOverlays = root.findAll(
      n =>
        isHost(n) &&
        flat(n.props.style as StyleProp<ViewStyle>).position === 'absolute',
    ).length;
    const joined = textReport.joined;
    missingInjected = [
      ...world.mustContain
        .filter(s => !joined.includes(s))
        .map(s => `exact:${s.slice(0, 60)}`),
      ...world.mustContainLower
        .filter(s => !joined.toLowerCase().includes(s))
        .map(s => `lower:${s.slice(0, 60)}`),
    ];
    if (world.planCompletedAt && branch === 'breakdown' && world.scoredReal) {
      const expected = `Logged ${new Date(world.planCompletedAt).toLocaleDateString()}`;
      loggedDateSample = expected;
      if (
        spec.training === 'plan_for_this_read_completed_items' &&
        !joined.includes(expected)
      ) {
        failures.push(`H4 locale/tz: expected "${expected}" in tree`);
      }
    }
    for (const node of interactive) {
      if (!node.role)
        failures.push(
          `H3 role: ${node.testID ?? node.type} has no accessibilityRole`,
        );
      if (!node.label && !node.derivedLabel)
        failures.push(`H3 label: ${node.testID ?? node.type} has no label`);
    }
    for (const m of textReport.malformed)
      failures.push(`H4 ${m.reason}: ${m.text.slice(0, 80)}`);
    for (const m of missingInjected)
      failures.push(`H4 integrity: injected string not rendered (${m})`);

    // ── Navigation action (H5) ──
    const stateBefore = navRef.current?.getRootState();
    const runPress = async (
      node: ReactTestInstance | null,
      verify: () => string | null,
    ) => {
      if (!node) {
        actionResult.ok = null;
        actionResult.detail = 'target not present in this variant';
        return;
      }
      await act(async () => {
        (node.props as { onPress: () => void }).onPress();
      });
      for (let i = 0; i < 4; i += 1) await tick(renderer);
      const problem = verify();
      actionResult.ok = problem === null;
      actionResult.detail = problem ?? 'ok';
      if (problem) failures.push(`H5 ${spec.action}: ${problem}`);
    };
    const state = () => navRef.current?.getRootState();
    if (branch === 'breakdown' || branch === 'missing') {
      switch (spec.action) {
        case 'header_back':
          await runPress(
            pressableNode(
              root,
              p =>
                p.accessibilityLabel === 'Back' ||
                p.retryLabel === 'Go back' ||
                p.testID === 'error-state-retry',
            ),
            () => {
              const s = state();
              return s && s.index === 1 && s.routes[1]?.name === 'Result'
                ? null
                : `state=${JSON.stringify(s?.routes.map(r => r.name))} index=${s?.index}`;
            },
          );
          if (actionResult.ok === null && branch === 'missing') {
            // ErrorState's retry button is a labeled `Button` → label text.
            await runPress(
              pressableNode(
                root,
                p =>
                  p.accessibilityLabel === 'Go back' || p.label === 'Go back',
              ),
              () => {
                const s = state();
                return s && s.index === 1 ? null : `index=${s?.index}`;
              },
            );
          }
          break;
        case 'attempt_chip': {
          const chip = pressableNode(
            root,
            p =>
              p.accessibilityRole === 'tab' &&
              !(p.accessibilityState as { selected?: boolean } | undefined)
                ?.selected,
          );
          const target = chip
            ? String(
                (chip.props as { accessibilityLabel?: string })
                  .accessibilityLabel,
              )
            : null;
          await runPress(chip, () => {
            const s = state();
            const top = s?.routes[s.index];
            const params = top?.params as { analysisId?: string } | undefined;
            if (!s || s.index !== 1 || top?.name !== 'Result')
              return `expected popTo Result, got ${top?.name} index=${s?.index}`;
            if (
              !params?.analysisId ||
              !world!.otherAttemptIds.includes(params.analysisId)
            ) {
              return `popTo params ${JSON.stringify(params)} not an attempt id (chip ${target})`;
            }
            return null;
          });
          break;
        }
        case 'form_review':
          await runPress(
            pressableNode(
              root,
              p =>
                p.testID === 'form-review-card' ||
                String(p.testID ?? '').endsWith('-review'),
            ),
            () => {
              const s = state();
              const top = s?.routes[s.index];
              const params = top?.params as { analysisId?: string } | undefined;
              return top?.name === 'FormReview' &&
                params?.analysisId === world!.analysisId
                ? null
                : `expected FormReview(${world!.analysisId.slice(0, 24)}), got ${top?.name} ${JSON.stringify(params).slice(0, 80)}`;
            },
          );
          break;
        case 'fix_item_review': {
          const button = pressableNode(root, p =>
            /^fix-item-.*-review$/.test(String(p.testID ?? '')),
          );
          const key = button
            ? String(button.props.testID)
                .replace(/^fix-item-/, '')
                .replace(/-review$/, '')
            : null;
          await runPress(button, () => {
            const s = state();
            const top = s?.routes[s.index];
            const params = top?.params as
              { analysisId?: string; phase?: string } | undefined;
            return top?.name === 'FormReview' &&
              params?.analysisId === world!.analysisId &&
              typeof params.phase === 'string' &&
              params.phase.length > 0
              ? null
              : `expected FormReview(${world!.analysisId.slice(0, 24)}, phase) from ${key}, got ${top?.name} ${JSON.stringify(params).slice(0, 80)}`;
          });
          break;
        }
        case 'capture_new_read':
          await runPress(
            pressableNode(
              root,
              p => p.accessibilityLabel === 'Capture a new read',
            ),
            () => {
              const s = state();
              const top = s?.routes[s.index];
              const params = top?.params as { source?: string } | undefined;
              if (top?.name !== 'Analyze' || params?.source !== 'camera')
                return `expected Analyze(camera), got ${top?.name}`;
              return peekTryAgainHandoff()
                ? null
                : 'try-again handoff was not armed';
            },
          );
          break;
        case 'training_retry': {
          const [section] = root.findAll(
            n => isHost(n) && n.props.testID === 'training-plan-section',
          );
          const retry = section
            ? pressableNode(section, p => p.accessibilityLabel === 'Try again')
            : null;
          await runPress(retry, () => {
            const s = state();
            const t = textOf(root);
            if (s?.index !== 2) return 'training retry changed the route';
            if (t.includes('Checking reviewed training'))
              return 'training reload never settled';
            return t.includes('Personalized training')
              ? null
              : 'training section disappeared after retry';
          });
          break;
        }
        case 'scrubber_increment': {
          const [scrubber] = root.findAll(
            n => isHost(n) && n.props.testID === 'stroke-result-scrubber',
          );
          if (!scrubber) {
            actionResult.detail = 'target not present in this variant';
          } else {
            const before = String(
              scrubber.props.accessibilityValue?.text ?? '',
            );
            await act(async () => {
              scrubber.props.onAccessibilityAction?.({
                nativeEvent: { actionName: 'increment' },
              });
            });
            for (let i = 0; i < 3; i += 1) await tick(renderer);
            const [after] = root.findAll(
              n => isHost(n) && n.props.testID === 'stroke-result-scrubber',
            );
            const afterText = String(
              after?.props.accessibilityValue?.text ?? '',
            );
            const s = state();
            const ok = s?.index === 2 && afterText.length > 0;
            actionResult.ok = ok;
            actionResult.detail = ok
              ? `value ${before} → ${afterText}`
              : `value ${before} → ${afterText}, index=${s?.index}`;
            if (!ok)
              failures.push(`H5 scrubber_increment: ${actionResult.detail}`);
          }
          break;
        }
        default:
          actionResult.detail = 'no action for this variant';
      }
    }
    void stateBefore;
  } catch (error) {
    crash =
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? ''}`.slice(0, 2000)
        : String(error);
    failures.push(`H1 crash: ${crash.split('\n')[0]}`);
  } finally {
    if (failures.length > 0 || process.env.STRESS_TREES === '1') {
      try {
        tree = (renderer as ReactTestRenderer | null)?.toJSON() ?? null;
      } catch (error) {
        tree = `toJSON failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    try {
      await act(async () => {
        (renderer as ReactTestRenderer | null)?.unmount();
      });
      await tick(null);
    } catch (error) {
      failures.push(
        `H6 unmount: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    queryClient.clear();
    restoreDevice();
    errorSpy.mockRestore();
  }
  // React's "not wrapped in act" and "update on unmounted" both surface here.
  for (const line of consoleErrors)
    failures.push(`H1 console.error: ${line.slice(0, 200)}`);

  const record: VariantRecord = {
    seed,
    spec,
    world: world
      ? worldRecord(world)
      : ({
          owner: '',
          analysisId: '',
          captureId: '',
          sessionId: '',
          otherAttemptIds: [],
          mustContain: [],
          mustContainLower: [],
          expectBranch: 'breakdown',
          scoredReal: false,
          planCompletedAt: null,
          payloadLength: 0,
          payloadPreview: '',
        } as VariantRecord['world']),
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    branch,
    durationMs: Date.now() - started,
    interactive,
    unlabeled: interactive.filter(n => !n.label && !n.derivedLabel),
    unroled: interactive.filter(n => !n.role),
    undersized: interactive.filter(n => n.undersized),
    unmeasuredCount: interactive.filter(n => n.unmeasured).length,
    textCount: textReport.texts.length,
    malformed: textReport.malformed,
    missingInjected,
    clipRisks: textReport.clipRisks,
    absoluteOverlays,
    consoleErrors,
    actionResult,
    rtlApplied:
      (I18nManager as unknown as { isRTL: boolean }).isRTL === spec.rtl ||
      spec.rtl === false,
    resolvedTimeZone,
    loggedDateSample,
    crash,
    failures,
    tree,
  };
  return record;
}

function worldRecord(world: SeededWorld): VariantRecord['world'] {
  const { payload, ...rest } = world;
  return {
    ...rest,
    payloadLength: payload.length,
    payloadPreview: payload.slice(0, 48),
  };
}

// ─── Suite ──────────────────────────────────────────────────────────────────

const seeds = seedList();

describe('STRESS ResultDetailsScreen · boundary/i18n/a11y (real navigator + providers)', () => {
  beforeAll(() => {
    jest.useFakeTimers();
  });

  afterAll(() => {
    jest.useRealTimers();
    if (!outDir) return;
    fs.mkdirSync(outDir, { recursive: true });
    const summary = {
      generatedAt: new Date().toISOString(),
      revision: process.env.STRESS_REV ?? null,
      seeds: seeds.length,
      executed: records.length,
      held: records.filter(r => r.outcome === 'HELD').length,
      broken: records
        .filter(r => r.outcome === 'BROKEN')
        .map(r => ({ seed: r.seed, failures: r.failures })),
      branches: records.reduce<Record<string, number>>((acc, r) => {
        acc[r.branch] = (acc[r.branch] ?? 0) + 1;
        return acc;
      }, {}),
      coverage: {
        locales: [...new Set(records.map(r => r.spec.locale))].sort(),
        timeZones: [...new Set(records.map(r => r.spec.timeZone))].sort(),
        fontScales: [...new Set(records.map(r => r.spec.fontScale))].sort(),
        widths: [...new Set(records.map(r => r.spec.width))].sort(),
        stringClasses: [
          ...new Set(records.map(r => r.spec.stringClass)),
        ].sort(),
        numericClasses: [
          ...new Set(records.map(r => r.spec.numericClass)),
        ].sort(),
        topologies: [...new Set(records.map(r => r.spec.topology))].sort(),
        trainingStates: [...new Set(records.map(r => r.spec.training))].sort(),
        syncStates: [...new Set(records.map(r => r.spec.sync))].sort(),
        sidecarStates: [...new Set(records.map(r => r.spec.sidecar))].sort(),
        actions: [...new Set(records.map(r => r.spec.action))].sort(),
      },
      interactions: records.filter(r => r.actionResult.ok !== null).length,
      interactionsOk: records.filter(r => r.actionResult.ok === true).length,
      interactiveNodesInspected: records.reduce(
        (n, r) => n + r.interactive.length,
        0,
      ),
      unmeasuredInteractive: records.reduce((n, r) => n + r.unmeasuredCount, 0),
      undersizedByTestId: records
        .flatMap(r => r.undersized)
        .reduce<
          Record<
            string,
            {
              count: number;
              effectiveHeight: number | null;
              role: string | null;
              label: string | null;
            }
          >
        >((acc, n) => {
          const key =
            n.testID ?? `${n.type}:${n.label ?? n.derivedLabel ?? ''}`;
          acc[key] = {
            count: (acc[key]?.count ?? 0) + 1,
            effectiveHeight: n.effectiveHeight,
            role: n.role,
            label: n.label ?? n.derivedLabel,
          };
          return acc;
        }, {}),
      clipRiskVariants: records.filter(r => r.clipRisks.length > 0).length,
      clipRiskSamples: records
        .flatMap(r =>
          r.clipRisks.map(c => ({
            seed: r.seed,
            fontScale: r.spec.fontScale,
            width: r.spec.width,
            ...c,
          })),
        )
        .slice(0, 40),
      textNodesInspected: records.reduce((n, r) => n + r.textCount, 0),
      totalDurationMs: records.reduce((n, r) => n + r.durationMs, 0),
    };
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify(summary, null, 2),
    );
    fs.writeFileSync(
      path.join(outDir, 'seed-table.json'),
      JSON.stringify(
        records.map(r => ({
          seed: r.seed,
          outcome: r.outcome,
          branch: r.branch,
          locale: r.spec.locale,
          timeZone: r.spec.timeZone,
          fontScale: r.spec.fontScale,
          width: r.spec.width,
          rtl: r.spec.rtl,
          stringClass: r.spec.stringClass,
          numericClass: r.spec.numericClass,
          topology: r.spec.topology,
          sync: r.spec.sync,
          training: r.spec.training,
          sidecar: r.spec.sidecar,
          idClass: r.spec.idClass,
          attempts: r.spec.attempts,
          capturedAtIso: r.spec.capturedAtIso,
          action: r.spec.action,
          actionOk: r.actionResult.ok,
          actionDetail: r.actionResult.detail,
          interactive: r.interactive.length,
          undersized: r.undersized.length,
          unlabeled: r.unlabeled.length,
          unroled: r.unroled.length,
          textNodes: r.textCount,
          clipRisks: r.clipRisks.length,
          loggedDateSample: r.loggedDateSample,
          durationMs: r.durationMs,
          failures: r.failures,
        })),
        null,
        2,
      ),
    );
    fs.writeFileSync(
      path.join(outDir, 'records.json'),
      JSON.stringify(
        records.map(r => ({ ...r, tree: undefined })),
        null,
        1,
      ),
    );
  });

  test.each(seeds)(
    'seed %i renders ResultDetails inside the real stack and holds H1–H6',
    async seed => {
      const record = await runVariant(seed);
      records.push(record);
      if (outDir && record.outcome === 'BROKEN') {
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(
          path.join(outDir, `broken-${seed}.json`),
          JSON.stringify(record, null, 2),
        );
      }
      expect({ seed, spec: record.spec, failures: record.failures }).toEqual({
        seed,
        spec: record.spec,
        failures: [],
      });
    },
  );
});
