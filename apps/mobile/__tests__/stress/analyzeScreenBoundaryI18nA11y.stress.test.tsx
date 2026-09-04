/**
 * STRESS — `scr-analyzescreen` × lens `boundary-i18n-a11y`.
 *
 * Renders the REAL `AnalyzeScreen` inside a real `NavigationContainer` +
 * native-stack navigator (route params, `navigation.replace/navigate/
 * goBack/popToTop` are the genuine implementations; the Result / Paywall /
 * Tabs destinations are recording stubs so a hand-off is observable). Stores,
 * hooks, capture pipeline, permit client, and SQL writers are the production
 * modules; only the native seams (camera bridge, SQLite driver, safe-area,
 * `fetch`) are replaced — exactly the seam `analyzeScreenFullFlowE2E` uses.
 *
 * Every iteration is derived from ONE integer seed (mulberry32) and can be
 * replayed alone:
 *
 *   cd apps/mobile && STRESS_SEED=<seed> STRESS_ITER=1 \
 *     npx jest --ci __tests__/stress/analyzeScreenBoundaryI18nA11y.stress.test.tsx
 *
 * Default (no env): a small STRESS_ITER so the suite stays fast. The
 * campaign runner (`runAnalyzeScreenStressCampaign.sh`) fans the seed space out
 * across the 12 locales × 8 time zones by spawning one jest process per
 * (LC_ALL, TZ) cell — Jest sandboxes `process.env`, so zone and locale are
 * process-level facts here, recorded per row from `Intl`.
 *
 * Every row records: the variant (font scale, viewport, locale, zone, RTL,
 * boundary payloads, phase reached), the a11y audit of the rendered host
 * tree (role/label presence, ≥44pt target model, forbidden literals, text
 * truncation / vertical-overflow model), and its outcome. The results table
 * is written as JSON to STRESS_OUT (default apps/mobile/artifacts/stress/).
 *
 * Layout claims are MODEL-BASED (flattened styles + typography tokens +
 * per-script glyph-width factors), not measured on a device; each violation
 * says so in its `basis` field. Role/label/literal checks are exact reads of
 * the rendered host tree.
 */
import React from 'react';
import {
  Dimensions,
  I18nManager,
  StyleSheet,
  Text,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { NavigationContainer } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import type {
  CameraEvent,
  CapturedClip,
  ImportedPoseExtraction,
} from '../../src/camera/capture';
import type { RootStackParams } from '../../src/navigation/params';
import type { CanonicalAccessState } from '../../src/billing/types';

// Node built-ins for the raw artifacts (mobile tsconfig has no node typings).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

// ─── Environment seams (native modules + fetch only) ─────────────────────────

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: unknown }>(
    'react-native-safe-area-context/jest/mock',
  );
  return mock.default;
});

let mockDb: LocalDb = {
  async execute() {
    return { rows: [] };
  },
  close() {},
};
jest.mock('../../src/data/db', () => ({ getDb: () => mockDb }));

type CameraListener = (event: CameraEvent) => void;
const mockCameraListeners = new Set<CameraListener>();
let mockCaptureImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('capture mock not configured'));
let mockImportImpl: () => Promise<CapturedClip> = () =>
  Promise.reject(new Error('import mock not configured'));
let mockReadArtifact: (uri: string) => Promise<string> = () =>
  Promise.reject(new Error('readCaptureArtifact mock not configured'));
const mockExtractImpl: () => Promise<ImportedPoseExtraction> = () =>
  Promise.reject(new Error('extract mock not configured'));

jest.mock('../../src/camera/capture', () => {
  const actual = jest.requireActual<typeof import('../../src/camera/capture')>(
    '../../src/camera/capture',
  );
  return {
    ...actual,
    // The stubs replace only the native call; the production validation gate
    // (`assertCapturedClip`) still runs, exactly as it does for the bridge.
    captureStrokeVideo: () =>
      mockCaptureImpl().then(clip =>
        actual.assertCapturedClip(clip, 'automatic_pose_trigger'),
      ),
    importStrokeVideo: () =>
      mockImportImpl().then(clip =>
        actual.assertCapturedClip(clip, 'imported_video'),
      ),
    cancelCameraOperation: () => undefined,
    subscribeToCameraEvents: (listener: CameraListener) => {
      mockCameraListeners.add(listener);
      return () => mockCameraListeners.delete(listener);
    },
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
    extractImportedPoseSequence: () => mockExtractImpl(),
  };
});

import {
  AnalyzeScreen,
  READINESS_COPY,
  freeAnalysesPhrase,
} from '../../src/screens/AnalyzeScreen';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { useAccessStore } from '../../src/state/accessStore';

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

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
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ─── Lens corpus ─────────────────────────────────────────────────────────────

const FONT_SCALES = [1, 1.235, 2.35] as const; // iOS default, L, AX3
const VIEWPORTS = [
  { width: 320, height: 568, name: 'iPhone SE1' },
  { width: 375, height: 667, name: 'iPhone SE3' },
  { width: 430, height: 932, name: 'iPhone 15 Pro Max' },
] as const;
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
/** IANA zones the campaign runner cycles through (UTC+14 … UTC−12, half-
 * and quarter-hour offsets, northern + southern DST). */
export const TIME_ZONES = [
  'Pacific/Kiritimati', // UTC+14, no DST
  'Etc/GMT+12', // UTC−12, no DST
  'America/New_York', // northern DST
  'Europe/Berlin', // northern DST
  'Asia/Kolkata', // +5:30
  'Australia/Lord_Howe', // +10:30 / +11 (30-minute DST shift)
  'Pacific/Chatham', // +12:45 / +13:45
  'America/Santiago', // southern DST
] as const;
/** Instants at or across DST edges, used as event/clip timestamps. */
const DST_EDGE_INSTANTS = [
  '2026-03-08T06:59:59.000Z', // US spring-forward, 1s before
  '2026-03-08T07:00:00.000Z', // US spring-forward
  '2026-11-01T05:59:59.000Z', // US fall-back
  '2026-03-29T00:59:59.000Z', // EU spring-forward
  '2026-10-25T00:59:59.000Z', // EU fall-back
  '2026-04-04T15:00:00.000Z', // Lord Howe DST end
  '2026-09-05T22:00:00.000Z', // Santiago DST start
  '2026-04-05T14:45:00.000Z', // Chatham DST end
  '1970-01-01T00:00:00.000Z',
  '2038-01-19T03:14:07.000Z',
  '2026-03-08T02:30:00-05:00', // non-existent US local time, explicit offset
  '2026-08-29T18:00:00.000Z',
] as const;

const LONG_LATIN =
  'The camera could not finish the recording because the on-device pose tracker lost the player for longer than the retained window allows, so the clip was closed without a stroke and nothing was scored or uploaded; nothing about this attempt used a rating.';
const CJK_LONG =
  '無法完成錄製，因為裝置上的姿勢追蹤器在保留視窗允許的時間內失去了球員的位置，所以剪輯已關閉且未偵測到擊球，沒有任何內容被評分或上傳；此次嘗試沒有使用任何評分額度。請重新錄製並確保整個身體和球拍側都清楚地在畫面中。';
const JA_LONG =
  'デバイス上の姿勢トラッカーが許容時間を超えてプレーヤーを見失ったため、録画を完了できませんでした。クリップはストロークなしで閉じられ、スコアもアップロードも行われていません。この試行では評価枠は使用されていません。';
const ARABIC_RTL =
  'تعذّر على الكاميرا إكمال التسجيل لأن متتبّع الوضعية على الجهاز فقد اللاعب لفترة أطول من النافذة المسموح بها، لذلك أُغلق المقطع دون ضربة ولم يُسجَّل أو يُرفع أي شيء؛ لم تستخدم هذه المحاولة أي تقييم.';
const HINDI_LONG =
  'कैमरा रिकॉर्डिंग पूरी नहीं कर सका क्योंकि डिवाइस पर पोज़ ट्रैकर ने खिलाड़ी को अनुमत समय से अधिक समय तक खो दिया, इसलिए क्लिप बिना किसी स्ट्रोक के बंद कर दी गई और कुछ भी स्कोर या अपलोड नहीं किया गया।';
const THAI_NO_SPACES =
  'กล้องไม่สามารถบันทึกให้เสร็จได้เนื่องจากตัวติดตามท่าทางบนอุปกรณ์สูญเสียผู้เล่นนานกว่าที่กำหนดดังนั้นคลิปจึงถูกปิดโดยไม่มีการตีและไม่มีการให้คะแนนหรืออัปโหลดใดๆความพยายามนี้ไม่ได้ใช้การให้คะแนน';
const GERMAN_COMPOUND =
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz Donaudampfschifffahrtsgesellschaftskapitänsmützenherstellungsanleitung Kraftfahrzeughaftpflichtversicherungsbeitragsrückerstattungsanspruch';
const ZWJ_EMOJI = '👨‍👩‍👧‍👦👩🏽‍🚀🏳️‍🌈🧑🏿‍🤝‍🧑🏻👨‍❤️‍💋‍👨🏴󠁧󠁢󠁷󠁬󠁳󠁿🤾🏻‍♀️🏓🏓🏓👨‍👩‍👧‍👦👩🏽‍🚀🏳️‍🌈🧑🏿‍🤝‍🧑🏻👨‍❤️‍💋‍👨🏴󠁧󠁢󠁷󠁬󠁳󠁿🤾🏻‍♀️';
const COMBINING_MARKS = 'Ṫ̸̡̢̛̝̙̞̭̯̜͇̪͚͙̪̫̬̠̥̌̓̒̽̊̆̑̑͐̌͊̊̊ḧ̶̨̧̜̭̬̤̳̻̰͚̼̱̮̜́̑̈́̎͗̋͒̅̀̀͘͜ȩ̷̢̡̛̛̙͖̜̯̗̭̲̬͈̳̯̊̑͊̉̈͐̊̈́͘͜͝ ̵̡̝̯̖͙̪̲̱̠̙̬͓̺̀̍̈̏͛̅̈͗͌̊͛͝c̴̨̢̨̛̘̜̮̤̫̩̥̘͇̠̗̬̲͖̉̍̉̓̑̈̆̒̏́̅̄̊͐͘̚ą̶̧̢̙̪̙̞̜̟̙̯̼̯̳̮̳̲̪̀̆̎̍̀̈̅̊̐̔̎̊̈́͊͘̚ͅm̷̨̧̛̛̘̘̜̥̝̯̳̼̗̭̻̮̠̠̻̲͙̖̈́̋̓͐̐̆̎̌̆̒̅̀̌͜͝ȩ̸̢̛̘̘̟̙̜̯̭̜͙̼̮̬̙̰̗͖͈̲̮̈́̉̉̔̅̊̽͛̒̌̑̎̈͘͜͝͝ŗ̶̡̢̧̛̙̞̭̯̜͇̪͚͙̪̫̬̠̥̌̓̒̽̊̆̑̑͐̌͊̊̊ą̵̢̡̛̝̙̞̭̯̜͇̪͚͙̪̫̬̠̥̌̓̒̽̊̆̑̑͐̌͊̊̊';

interface BoundaryString {
  id: string;
  value: string;
  script: 'latin' | 'cjk' | 'arabic' | 'devanagari' | 'thai' | 'emoji';
}
const BOUNDARY_STRINGS: readonly BoundaryString[] = [
  { id: 'latin-200+', value: LONG_LATIN, script: 'latin' },
  { id: 'cjk-zh-200+', value: CJK_LONG, script: 'cjk' },
  { id: 'cjk-ja', value: JA_LONG, script: 'cjk' },
  { id: 'arabic-rtl', value: ARABIC_RTL, script: 'arabic' },
  { id: 'hindi-conjuncts', value: HINDI_LONG, script: 'devanagari' },
  { id: 'thai-no-spaces', value: THAI_NO_SPACES, script: 'thai' },
  { id: 'german-compound', value: GERMAN_COMPOUND, script: 'latin' },
  { id: 'zwj-emoji', value: ZWJ_EMOJI, script: 'emoji' },
  { id: 'combining-marks', value: COMBINING_MARKS, script: 'latin' },
  {
    id: 'bidi-mixed',
    value: `Fehler: ${ARABIC_RTL.slice(0, 60)} — retry`,
    script: 'arabic',
  },
  { id: 'empty', value: '', script: 'latin' },
  { id: 'whitespace', value: '   \n\t  ', script: 'latin' },
  { id: 'single-char', value: 'x', script: 'latin' },
  { id: 'rlo-override', value: '\u202Eretry\u202C ok', script: 'latin' },
];

/** Non-Error rejection values a bridge could surface (String(error) path). */
const NON_ERROR_REJECTIONS: readonly { id: string; value: unknown }[] = [
  { id: 'null', value: null },
  { id: 'undefined', value: undefined },
  { id: 'empty-object', value: {} },
  { id: 'number-0', value: 0 },
  { id: 'string-empty', value: '' },
];

// Mixed: values the clip gate rejects (0, negative, non-integer dimensions)
// and values it ADMITS but that are extreme (1, 1e9, 1e21, 0.001).
const NUMERICS = [
  0, -1, -1080, 1, 1e9, 1e21, 0.001, 60, 1080, 2500, 7680, 240,
] as const;
const UNIT_FRACTIONS = [0, -0.5, 1, 2, 1e9, 0.9, 0.123456789] as const;
// Values `assertCapturedClip` admits (positive finite duration, positive
// integer pixels, finite fps >= 0) at their extremes.
const ADMITTED_DURATIONS_MS = [1, 0.001, 240, 5470, 1e9, 1e15] as const;
const ADMITTED_FPS = [0, 1, 24, 240, 1e6] as const;
const ADMITTED_PIXELS = [1, 1080, 7680, 1e9] as const;

// Literals that must never appear as rendered text on a user surface.
const FORBIDDEN_LITERALS = [
  'NaN',
  'Infinity',
  'undefined',
  'null',
  '[object Object]',
  'e+21',
  'e+9',
  '-0 ',
] as const;

type Scenario =
  | 'ready'
  | 'ready-typed'
  | 'ready-declared'
  | 'working-guidance'
  | 'working-unknown-readiness'
  | 'error-capture'
  | 'error-non-error-rejection'
  | 'error-permit-server'
  | 'saved-guided'
  | 'saved-imported'
  | 'saved-imported-target'
  | 'gate-hostile-guided'
  | 'gate-hostile-imported'
  | 'scored-result'
  | 'scored-free-limit'
  | 'library-import-failure';
const SCENARIOS: readonly Scenario[] = [
  'ready',
  'ready-typed',
  'ready-declared',
  'working-guidance',
  'working-unknown-readiness',
  'error-capture',
  'error-non-error-rejection',
  'error-permit-server',
  'saved-guided',
  'saved-imported',
  'saved-imported-target',
  'gate-hostile-guided',
  'gate-hostile-imported',
  'scored-result',
  'scored-free-limit',
  'library-import-failure',
];

interface Variant {
  seed: number;
  scenario: Scenario;
  fontScale: number;
  viewport: (typeof VIEWPORTS)[number];
  locale: string; // requested (campaign cell); actual read from Intl per row
  rtl: boolean;
  boundary: BoundaryString;
  nonError: (typeof NON_ERROR_REJECTIONS)[number];
  numerics: {
    durationMs: number;
    fps: number;
    width: number;
    height: number;
    coverage: number;
    confidence: number;
    poseFrameCount: number;
    progress: number;
  };
  /** Extreme values the clip gate ADMITS — what the saved surface formats. */
  admitted: { durationMs: number; fps: number; width: number; height: number };
  eventInstant: string;
  recognitionReason: string;
  readinessState: string;
  freeLimit: number;
}

function variantFor(seed: number): Variant {
  const rng = new Rng(seed);
  const locale = LOCALES[seed % LOCALES.length] ?? 'en-IN';
  return {
    seed,
    scenario: rng.pick(SCENARIOS),
    fontScale: rng.pick(FONT_SCALES),
    viewport: rng.pick(VIEWPORTS),
    locale,
    rtl: locale.startsWith('ar') || rng.chance(0.1),
    boundary: rng.pick(BOUNDARY_STRINGS),
    nonError: rng.pick(NON_ERROR_REJECTIONS),
    numerics: {
      durationMs: rng.pick(NUMERICS),
      fps: rng.pick(NUMERICS),
      width: rng.pick(NUMERICS),
      height: rng.pick(NUMERICS),
      coverage: rng.pick(UNIT_FRACTIONS),
      confidence: rng.pick(UNIT_FRACTIONS),
      poseFrameCount: rng.pick([0, -1, 1, 1e12, 240] as const),
      progress: rng.pick([...UNIT_FRACTIONS, Number.NaN] as const),
    },
    admitted: {
      durationMs: rng.pick(ADMITTED_DURATIONS_MS),
      fps: rng.pick(ADMITTED_FPS),
      width: rng.pick(ADMITTED_PIXELS),
      height: rng.pick(ADMITTED_PIXELS),
    },
    eventInstant: rng.pick(DST_EDGE_INSTANTS),
    recognitionReason: rng.pick([
      'validated_classifier_unavailable',
      'no_stroke_detected',
      'unsupported_stroke',
      'some_new_native_reason_code',
      '',
      'constructor',
      'toString',
      '__proto__',
    ] as const),
    readinessState: rng.pick([
      'no_person',
      'move_closer',
      'hold_still',
      'ready',
      'brand_new_state',
      '',
      'constructor',
      'hasOwnProperty',
    ] as const),
    freeLimit: 2,
  };
}

// ─── Host-tree audit ─────────────────────────────────────────────────────────

interface Violation {
  kind:
    | 'render_error'
    | 'unlabeled_interactive'
    | 'missing_role'
    | 'small_target'
    | 'forbidden_literal'
    | 'empty_message'
    | 'nan_style'
    | 'text_truncated'
    | 'vertical_overflow'
    | 'unreachable_control';
  node: string;
  detail: string;
  basis: 'host-tree' | 'layout-model';
}

interface Row {
  seed: number;
  scenario: Scenario;
  fontScale: number;
  viewport: string;
  localeRequested: string;
  localeActual: string;
  timeZone: string;
  rtl: boolean;
  boundary: string;
  nonError: string;
  numerics: Variant['numerics'];
  eventInstant: string;
  recognitionReason: string;
  readinessState: string;
  phaseReached: string;
  navigatedTo: string | null;
  interactiveCount: number;
  textNodeCount: number;
  /** Every rendered Text node's content, in tree order (the evidence). */
  texts: string[];
  violations: Violation[];
  outcome: 'HELD' | 'BROKEN';
  durationMs: number;
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'radio',
  'link',
  'switch',
  'checkbox',
  'togglebutton',
  'adjustable',
  'combobox',
  'menuitem',
  'tab',
]);

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

function hostChildren(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  const walk = (n: ReactTestInstance) => {
    for (const child of n.children) {
      if (typeof child === 'string') continue;
      if (isHost(child)) out.push(child);
      else walk(child);
    }
  };
  walk(node);
  return out;
}

function hostParent(node: ReactTestInstance): ReactTestInstance | null {
  let p = node.parent;
  while (p && !isHost(p)) p = p.parent;
  return p;
}

function textContent(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: ReactTestInstance) => {
    for (const child of n.children) {
      if (typeof child === 'string') parts.push(child);
      else walk(child);
    }
  };
  walk(node);
  return parts.join('');
}

function flat(node: ReactTestInstance): ViewStyle & TextStyle {
  const style = (node.props as { style?: unknown }).style;
  return (StyleSheet.flatten(style as never) ?? {}) as ViewStyle & TextStyle;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function isInteractive(node: ReactTestInstance): boolean {
  if (!isHost(node)) return false;
  const p = node.props as Record<string, unknown>;
  if (String(node.type) === 'TextInput') return true;
  if (typeof p.onClick === 'function' || typeof p.onPress === 'function')
    return true;
  if (typeof p.onStartShouldSetResponder === 'function') return true;
  const role = p.accessibilityRole;
  return typeof role === 'string' && INTERACTIVE_ROLES.has(role);
}

function describe_(node: ReactTestInstance): string {
  const p = node.props as Record<string, unknown>;
  const label =
    typeof p.accessibilityLabel === 'string' ? p.accessibilityLabel : '';
  const text = textContent(node).slice(0, 40);
  return (
    `${String(node.type)}[role=${String(p.accessibilityRole ?? '-')}]` +
    `[label=${JSON.stringify(label.slice(0, 40))}]` +
    (text ? `[text=${JSON.stringify(text)}]` : '') +
    (typeof p.testID === 'string' ? `[testID=${p.testID}]` : '')
  );
}

// ── Layout model ────────────────────────────────────────────────────────────

const SCRIPT_GLYPH_FACTOR: Record<string, number> = {
  latin: 0.52,
  cjk: 1.0,
  arabic: 0.55,
  devanagari: 0.7,
  thai: 0.75,
  emoji: 1.2,
};

function glyphFactor(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // combining marks: zero advance
  if (cp === 0x200d || cp === 0xfe0f || (cp >= 0xe0020 && cp <= 0xe007f))
    return 0; // ZWJ / VS16 / tag sequence
  if (cp >= 0x4e00 && cp <= 0x9fff) return SCRIPT_GLYPH_FACTOR.cjk ?? 1;
  if (cp >= 0x3040 && cp <= 0x30ff) return SCRIPT_GLYPH_FACTOR.cjk ?? 1;
  if (cp >= 0xac00 && cp <= 0xd7af) return SCRIPT_GLYPH_FACTOR.cjk ?? 1;
  if (cp >= 0x600 && cp <= 0x6ff) return SCRIPT_GLYPH_FACTOR.arabic ?? 0.55;
  if (cp >= 0x900 && cp <= 0x97f) return SCRIPT_GLYPH_FACTOR.devanagari ?? 0.7;
  if (cp >= 0xe00 && cp <= 0xe7f) return SCRIPT_GLYPH_FACTOR.thai ?? 0.75;
  if (cp >= 0x1f000) return SCRIPT_GLYPH_FACTOR.emoji ?? 1.2;
  if (ch === ' ') return 0.28;
  if (/[A-Z0-9]/.test(ch)) return 0.62;
  return SCRIPT_GLYPH_FACTOR.latin ?? 0.52;
}

interface TextMetrics {
  lines: number;
  widestLine: number;
  lineHeight: number;
}

function measureText(
  text: string,
  style: TextStyle,
  fontScale: number,
  availWidth: number,
  allowFontScaling: boolean,
  maxFontSizeMultiplier: number | undefined,
): TextMetrics {
  const fontSize = num(style.fontSize) ?? 14;
  let scale = allowFontScaling ? fontScale : 1;
  if (maxFontSizeMultiplier !== undefined && maxFontSizeMultiplier > 0)
    scale = Math.min(scale, maxFontSizeMultiplier);
  const scaledFont = fontSize * scale;
  const lineHeight = (num(style.lineHeight) ?? fontSize * 1.25) * scale;
  const letter = (num(style.letterSpacing) ?? 0) * scale;
  const upper = style.textTransform === 'uppercase';
  const source = upper ? text.toUpperCase() : text;
  const avail = Math.max(1, availWidth);
  // Greedy word wrap; words wider than the line break mid-word (RN/UIKit
  // behavior). Thai/CJK have no spaces → per-glyph wrapping.
  let lines = 1;
  let lineW = 0;
  let widest = 0;
  const words = source.split(/(\s+)/);
  for (const word of words) {
    if (word.length === 0) continue;
    if (/^\s+$/.test(word)) {
      if (word.includes('\n')) {
        widest = Math.max(widest, lineW);
        lines += 1;
        lineW = 0;
      } else {
        lineW += glyphFactor(' ') * scaledFont * word.length;
      }
      continue;
    }
    const glyphs = Array.from(word).map(
      ch => glyphFactor(ch) * scaledFont + (glyphFactor(ch) > 0 ? letter : 0),
    );
    const wordW = glyphs.reduce((a, b) => a + b, 0);
    if (lineW + wordW <= avail) {
      lineW += wordW;
      continue;
    }
    if (wordW <= avail) {
      widest = Math.max(widest, lineW);
      lines += 1;
      lineW = wordW;
      continue;
    }
    // mid-word break
    for (const g of glyphs) {
      if (lineW + g > avail && lineW > 0) {
        widest = Math.max(widest, lineW);
        lines += 1;
        lineW = 0;
      }
      lineW += g;
    }
  }
  widest = Math.max(widest, lineW);
  return { lines, widestLine: widest, lineHeight };
}

interface Box {
  width: number;
  height: number;
  /** True when a size came only from content estimation. */
  estimated: boolean;
}

interface MeasureContext {
  fontScale: number;
  viewportWidth: number;
  viewportHeight: number;
  violations: Violation[];
  scrollDepth: number;
}

function resolveLength(value: unknown, basis: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.endsWith('%')) {
    const pct = Number(value.slice(0, -1));
    return Number.isFinite(pct) ? (pct / 100) * basis : undefined;
  }
  return undefined;
}

function padH(s: ViewStyle): number {
  return (
    (num(s.paddingLeft) ?? num(s.paddingHorizontal) ?? num(s.padding) ?? 0) +
    (num(s.paddingRight) ?? num(s.paddingHorizontal) ?? num(s.padding) ?? 0) +
    (num(s.borderLeftWidth) ?? num(s.borderWidth) ?? 0) +
    (num(s.borderRightWidth) ?? num(s.borderWidth) ?? 0)
  );
}
function padV(s: ViewStyle): number {
  return (
    (num(s.paddingTop) ?? num(s.paddingVertical) ?? num(s.padding) ?? 0) +
    (num(s.paddingBottom) ?? num(s.paddingVertical) ?? num(s.padding) ?? 0) +
    (num(s.borderTopWidth) ?? num(s.borderWidth) ?? 0) +
    (num(s.borderBottomWidth) ?? num(s.borderWidth) ?? 0)
  );
}
function marginH(s: ViewStyle): number {
  return (
    (num(s.marginLeft) ?? num(s.marginHorizontal) ?? num(s.margin) ?? 0) +
    (num(s.marginRight) ?? num(s.marginHorizontal) ?? num(s.margin) ?? 0)
  );
}
function marginV(s: ViewStyle): number {
  return (
    (num(s.marginTop) ?? num(s.marginVertical) ?? num(s.margin) ?? 0) +
    (num(s.marginBottom) ?? num(s.marginVertical) ?? num(s.margin) ?? 0)
  );
}

const SCROLL_TYPES = new Set([
  'RCTScrollView',
  'ScrollView',
  'RCTScrollContentView',
]);

/**
 * Estimates the laid-out box of a host node given the width available to it.
 * Column flow sums children; row flow adds them (with wrapping when
 * `flexWrap: 'wrap'`). Absolutely positioned children are excluded from the
 * flow. Text is measured by the per-script glyph model above.
 */
function measure(
  node: ReactTestInstance,
  availWidth: number,
  ctx: MeasureContext,
): Box {
  const s = flat(node);
  const p = node.props as Record<string, unknown>;
  const type = String(node.type);
  const explicitW = resolveLength(s.width, availWidth);
  const explicitH = resolveLength(s.height, ctx.viewportHeight);
  const maxW = resolveLength(s.maxWidth, availWidth);
  const minW = resolveLength(s.minWidth, availWidth);
  const minH = resolveLength(s.minHeight, ctx.viewportHeight);
  const maxH = resolveLength(s.maxHeight, ctx.viewportHeight);

  for (const key of [
    'width',
    'height',
    'minHeight',
    'minWidth',
    'top',
    'left',
    'flex',
  ] as const) {
    const v = (s as Record<string, unknown>)[key];
    if (typeof v === 'number' && !Number.isFinite(v)) {
      ctx.violations.push({
        kind: 'nan_style',
        node: describe_(node),
        detail: `style.${key}=${String(v)}`,
        basis: 'host-tree',
      });
    }
  }

  let innerAvail = Math.max(
    0,
    Math.min(
      explicitW ?? Number.POSITIVE_INFINITY,
      maxW ?? Number.POSITIVE_INFINITY,
      availWidth,
    ) - padH(s),
  );
  if (!Number.isFinite(innerAvail)) innerAvail = availWidth - padH(s);

  let contentW = 0;
  let contentH = 0;
  let estimated = false;

  if (type === 'Text') {
    const text = textContent(node);
    const metrics = measureText(
      text,
      s,
      ctx.fontScale,
      innerAvail,
      p.allowFontScaling !== false,
      num(p.maxFontSizeMultiplier),
    );
    const nol = num(p.numberOfLines);
    if (nol !== undefined && nol > 0 && metrics.lines > nol) {
      ctx.violations.push({
        kind: 'text_truncated',
        node: describe_(node),
        detail:
          `needs ~${metrics.lines} lines at fontScale ${ctx.fontScale} in ${Math.round(innerAvail)}pt, numberOfLines=${nol}` +
          ` (text ${JSON.stringify(text.slice(0, 60))}${text.length > 60 ? '…' : ''})`,
        basis: 'layout-model',
      });
    }
    const shownLines =
      nol !== undefined && nol > 0
        ? Math.min(nol, metrics.lines)
        : metrics.lines;
    contentW = Math.min(metrics.widestLine, innerAvail);
    contentH = shownLines * metrics.lineHeight;
    estimated = true;
  } else if (type === 'TextInput') {
    const metrics = measureText(
      'Xg',
      s,
      ctx.fontScale,
      innerAvail,
      true,
      undefined,
    );
    contentW = innerAvail;
    contentH = metrics.lineHeight;
    estimated = true;
  } else if (type.startsWith('RNSVG') || type === 'Image') {
    contentW = num(p.width) ?? 0;
    contentH = num(p.height) ?? 0;
  } else {
    const isScroll = SCROLL_TYPES.has(type) || type === 'RCTScrollView';
    if (isScroll) ctx.scrollDepth += 1;
    const children = hostChildren(node).filter(
      c => flat(c).position !== 'absolute',
    );
    const row = s.flexDirection === 'row' || s.flexDirection === 'row-reverse';
    const gap = num(s.gap) ?? 0;
    const rowGap = num(s.rowGap) ?? gap;
    const colGap = num(s.columnGap) ?? gap;
    if (row) {
      // Fixed-width siblings claim their width first; flexible children
      // share the remainder.
      const boxes: Box[] = [];
      const childStyles = children.map(flat);
      let fixed = 0;
      childStyles.forEach(cs => {
        const w = resolveLength(cs.width, innerAvail);
        if (w !== undefined) fixed += w + marginH(cs);
      });
      const flexibleCount = childStyles.filter(
        cs => resolveLength(cs.width, innerAvail) === undefined,
      ).length;
      const remaining = Math.max(
        0,
        innerAvail - fixed - colGap * Math.max(0, children.length - 1),
      );
      const share = flexibleCount > 0 ? remaining / flexibleCount : remaining;
      children.forEach((c, i) => {
        const cs = childStyles[i] ?? {};
        const w = resolveLength(cs.width, innerAvail);
        // A flexible child in a row gets a share, but a non-flex child only
        // takes its content width (up to the remaining space).
        const avail =
          w !== undefined ? w : (num(cs.flex) ?? 0) > 0 ? share : remaining;
        boxes.push(measure(c, avail, ctx));
      });
      if (s.flexWrap === 'wrap') {
        let lineW = 0;
        let lineH = 0;
        let total = 0;
        let lines = 0;
        boxes.forEach((b, i) => {
          const cs = childStyles[i] ?? {};
          const w = b.width + marginH(cs);
          if (lineW > 0 && lineW + colGap + w > innerAvail) {
            total += lineH;
            lines += 1;
            lineW = 0;
            lineH = 0;
          }
          lineW += (lineW > 0 ? colGap : 0) + w;
          lineH = Math.max(lineH, b.height + marginV(cs));
        });
        total += lineH;
        contentH = total + rowGap * Math.max(0, lines);
        contentW = innerAvail;
      } else {
        contentW =
          boxes.reduce(
            (a, b, i) => a + b.width + marginH(childStyles[i] ?? {}),
            0,
          ) +
          colGap * Math.max(0, boxes.length - 1);
        contentH = boxes.reduce(
          (a, b, i) => Math.max(a, b.height + marginV(childStyles[i] ?? {})),
          0,
        );
      }
      estimated = boxes.some(b => b.estimated);
    } else {
      let y = 0;
      children.forEach((c, i) => {
        const cs = flat(c);
        const childAvail = Math.max(0, innerAvail - marginH(cs));
        const b = measure(c, childAvail, ctx);
        if (i > 0) y += rowGap;
        y += b.height + marginV(cs);
        contentW = Math.max(contentW, b.width + marginH(cs));
        estimated = estimated || b.estimated;
      });
      contentH = y;
    }
    if (isScroll) ctx.scrollDepth -= 1;
  }

  let width =
    explicitW ??
    Math.min(
      contentW + padH(s),
      Number.isFinite(availWidth) ? availWidth : contentW + padH(s),
    );
  // Column children stretch by default (alignItems: stretch) unless the
  // parent centers/aligns them or they align themselves.
  if (explicitW === undefined) {
    const parent = hostParent(node);
    const ps = parent ? flat(parent) : {};
    const parentRow =
      ps.flexDirection === 'row' || ps.flexDirection === 'row-reverse';
    const stretch =
      !parentRow &&
      (ps.alignItems === undefined || ps.alignItems === 'stretch') &&
      (s.alignSelf === undefined ||
        s.alignSelf === 'stretch' ||
        s.alignSelf === 'auto');
    if (stretch && type !== 'Text' && Number.isFinite(availWidth))
      width = availWidth;
    if (s.alignSelf === 'stretch' && Number.isFinite(availWidth))
      width = availWidth;
  }
  if (maxW !== undefined) width = Math.min(width, maxW);
  if (minW !== undefined) width = Math.max(width, minW);
  let height = explicitH ?? contentH + padV(s);
  if (minH !== undefined) height = Math.max(height, minH);
  if (maxH !== undefined) height = Math.min(height, maxH);
  return { width, height, estimated: explicitH === undefined && estimated };
}

/** Width available to `node`, derived by walking up the host ancestors. */
function availableWidth(node: ReactTestInstance, ctx: MeasureContext): number {
  const chain: ReactTestInstance[] = [];
  let p = hostParent(node);
  while (p) {
    chain.unshift(p);
    p = hostParent(p);
  }
  let avail = ctx.viewportWidth;
  for (let i = 0; i < chain.length; i += 1) {
    const anc = chain[i];
    if (!anc) continue;
    const s = flat(anc);
    const explicitW = resolveLength(s.width, avail);
    const maxW = resolveLength(s.maxWidth, avail);
    avail = Math.min(explicitW ?? avail, maxW ?? avail) - padH(s);
    const child = chain[i + 1] ?? node;
    const cs = flat(child);
    avail -= marginH(cs);
    if (s.flexDirection === 'row' || s.flexDirection === 'row-reverse') {
      const siblings = hostChildren(anc).filter(
        c => c !== child && flat(c).position !== 'absolute',
      );
      const gap = num(s.columnGap) ?? num(s.gap) ?? 0;
      let taken = gap * siblings.length;
      for (const sib of siblings) {
        const ss = flat(sib);
        const w = resolveLength(ss.width, avail);
        if (w !== undefined) taken += w + marginH(ss);
        else if (
          String(sib.type).startsWith('RNSVG') ||
          String(sib.type) === 'Image'
        )
          taken += num((sib.props as Record<string, unknown>).width) ?? 0;
      }
      avail -= taken;
    }
  }
  return Math.max(0, avail);
}

function insideScroll(node: ReactTestInstance): boolean {
  let p = hostParent(node);
  while (p) {
    if (SCROLL_TYPES.has(String(p.type))) return true;
    p = hostParent(p);
  }
  return false;
}

function auditTree(
  root: ReactTestInstance,
  fontScale: number,
  viewportWidth: number,
  viewportHeight: number,
): {
  violations: Violation[];
  interactiveCount: number;
  textNodeCount: number;
} {
  const violations: Violation[] = [];
  const ctx: MeasureContext = {
    fontScale,
    viewportWidth,
    viewportHeight,
    violations,
    scrollDepth: 0,
  };
  const hosts = root.findAll(isHost);
  let interactiveCount = 0;
  let textNodeCount = 0;

  for (const node of hosts) {
    const p = node.props as Record<string, unknown>;
    if (String(node.type) === 'Text') {
      textNodeCount += 1;
      const text = textContent(node);
      // This screen never renders a decorative blank Text: a Text host with
      // no content is a message slot whose copy went missing (empty error
      // message, or a copy-map lookup that returned a non-string).
      if (text.trim().length === 0) {
        const parent = hostParent(node);
        const pp = (parent?.props ?? {}) as Record<string, unknown>;
        const region =
          pp.accessibilityRole ?? pp.accessibilityLiveRegion ?? 'unlabeled';
        violations.push({
          kind: 'empty_message',
          node: describe_(node),
          detail: `blank Text inside ${String(region)} region`,
          basis: 'host-tree',
        });
      }
      for (const literal of FORBIDDEN_LITERALS) {
        // Standalone tokens only: "null" inside a longer word is not a leak.
        const re = new RegExp(
          `(^|[^A-Za-z])${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`,
        );
        if (re.test(text)) {
          violations.push({
            kind: 'forbidden_literal',
            node: describe_(node),
            detail: `rendered text contains ${JSON.stringify(literal)}: ${JSON.stringify(text.slice(0, 120))}`,
            basis: 'host-tree',
          });
        }
      }
    }
    if (!isInteractive(node)) continue;
    interactiveCount += 1;
    const label =
      typeof p.accessibilityLabel === 'string'
        ? p.accessibilityLabel.trim()
        : '';
    const fallback = textContent(node).trim();
    const placeholder =
      typeof p.placeholder === 'string' ? p.placeholder.trim() : '';
    if (!label && !fallback && !placeholder) {
      violations.push({
        kind: 'unlabeled_interactive',
        node: describe_(node),
        detail: 'no accessibilityLabel and no text content',
        basis: 'host-tree',
      });
    }
    const role = p.accessibilityRole;
    if (
      String(node.type) !== 'TextInput' &&
      (typeof role !== 'string' || !INTERACTIVE_ROLES.has(role))
    ) {
      violations.push({
        kind: 'missing_role',
        node: describe_(node),
        detail: `accessibilityRole=${String(role)}`,
        basis: 'host-tree',
      });
    }
    // ≥44pt target: explicit style first, content model otherwise; hitSlop
    // extends the touch target on both axes.
    const avail = availableWidth(node, ctx);
    const scratch: MeasureContext = { ...ctx, violations: [] };
    const box = measure(node, avail, scratch);
    const hs = p.hitSlop;
    let slopW = 0;
    let slopH = 0;
    if (typeof hs === 'number') {
      slopW = hs * 2;
      slopH = hs * 2;
    } else if (hs && typeof hs === 'object') {
      const o = hs as {
        top?: number;
        bottom?: number;
        left?: number;
        right?: number;
      };
      slopW = (o.left ?? 0) + (o.right ?? 0);
      slopH = (o.top ?? 0) + (o.bottom ?? 0);
    }
    const w = box.width + slopW;
    const h = box.height + slopH;
    if (w < 44 || h < 44) {
      violations.push({
        kind: 'small_target',
        node: describe_(node),
        detail: `estimated ${w.toFixed(1)}×${h.toFixed(1)}pt (avail ${avail.toFixed(0)}pt, fontScale ${fontScale}, ${box.estimated ? 'content-estimated' : 'explicit style'})`,
        basis: box.estimated ? 'layout-model' : 'host-tree',
      });
    }
  }

  // Vertical overflow of NON-scrolling surfaces: the top-level host column
  // (the SafeAreaView) and every Modal root are the viewport-bounded frames.
  const frames: ReactTestInstance[] = [];
  const topHosts = hostChildren(root);
  frames.push(...topHosts);
  for (const node of hosts) {
    if (
      String(node.type) === 'Modal' ||
      String(node.type) === 'RCTModalHostView'
    )
      frames.push(...hostChildren(node));
  }
  for (const frame of frames) {
    const fctx: MeasureContext = { ...ctx, violations: [] };
    const box = measure(frame, viewportWidth, fctx);
    // Text truncation notes come from the frame walk (each node once).
    violations.push(
      ...fctx.violations.filter(
        v => v.kind === 'text_truncated' || v.kind === 'nan_style',
      ),
    );
    if (box.height > viewportHeight + 0.5) {
      // Which controls fall below the fold? Walk the column flow.
      const below = controlsBelowFold(
        frame,
        viewportWidth,
        viewportHeight,
        ctx,
      );
      violations.push({
        kind: 'vertical_overflow',
        node: describe_(frame),
        detail: `content ≈${Math.round(box.height)}pt > viewport ${viewportHeight}pt at fontScale ${fontScale} (no ScrollView bounds this frame)`,
        basis: 'layout-model',
      });
      for (const c of below) {
        violations.push({
          kind: 'unreachable_control',
          node: describe_(c.node),
          detail: `top ≈${Math.round(c.top)}pt ≥ viewport ${viewportHeight}pt; no scroll ancestor`,
          basis: 'layout-model',
        });
      }
    }
  }
  return { violations: dedupe(violations), interactiveCount, textNodeCount };
}

function controlsBelowFold(
  frame: ReactTestInstance,
  viewportWidth: number,
  viewportHeight: number,
  ctx: MeasureContext,
): { node: ReactTestInstance; top: number }[] {
  const out: { node: ReactTestInstance; top: number }[] = [];
  const walk = (node: ReactTestInstance, top: number, avail: number) => {
    const s = flat(node);
    if (SCROLL_TYPES.has(String(node.type))) return; // scroll content is reachable
    const inner = Math.max(
      0,
      (resolveLength(s.width, avail) ?? avail) - padH(s),
    );
    const children = hostChildren(node).filter(
      c => flat(c).position !== 'absolute',
    );
    const row = s.flexDirection === 'row' || s.flexDirection === 'row-reverse';
    const gap = num(s.rowGap) ?? num(s.gap) ?? 0;
    let y =
      top +
      (num(s.paddingTop) ?? num(s.paddingVertical) ?? num(s.padding) ?? 0);
    // Centered columns (justifyContent center) shift content so overflow
    // is split top/bottom; the bottom controls still fall below the fold.
    if (!row && s.justifyContent === 'center') {
      const scratch: MeasureContext = { ...ctx, violations: [] };
      const total = measure(node, avail, scratch).height;
      const frameH =
        resolveLength(s.height, viewportHeight) ??
        (s.flex ? viewportHeight - top : total);
      if (total > frameH)
        y =
          top -
          (total - frameH) / 2 +
          (num(s.paddingTop) ?? num(s.paddingVertical) ?? num(s.padding) ?? 0);
    }
    for (const child of children) {
      const cs = flat(child);
      const scratch: MeasureContext = { ...ctx, violations: [] };
      const b = measure(child, Math.max(0, inner - marginH(cs)), scratch);
      const childTop =
        y +
        (num(cs.marginTop) ?? num(cs.marginVertical) ?? num(cs.margin) ?? 0);
      if (
        isInteractive(child) &&
        childTop >= viewportHeight &&
        !insideScroll(child)
      ) {
        out.push({ node: child, top: childTop });
      } else if (!isInteractive(child)) {
        walk(child, childTop, Math.max(0, inner - marginH(cs)));
      }
      if (!row)
        y =
          childTop +
          b.height +
          (num(cs.marginBottom) ??
            num(cs.marginVertical) ??
            num(cs.margin) ??
            0) +
          gap;
    }
  };
  walk(frame, 0, viewportWidth);
  return out;
}

function dedupe(items: Violation[]): Violation[] {
  const seen = new Set<string>();
  return items.filter(v => {
    const key = `${v.kind}|${v.node}|${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

function guidedClip(
  v: Variant,
  hostile: boolean,
): { clip: CapturedClip; sidecarJson: string } {
  const { sequence, window } = generateSwingSequence();
  const sidecarJson = serializePoseSequence(sequence);
  const n = v.numerics;
  const clip: CapturedClip = {
    uri: `file:///captures/${v.seed}.mov`,
    // Pre/post-roll must fit inside the clip for the gate to admit it.
    durationMs: hostile ? n.durationMs : 2000 + window.endMs + 1500,
    fps: hostile ? n.fps : 60,
    width: hostile ? n.width : 1080,
    height: hostile ? n.height : 1080,
    capturedAtIso: v.eventInstant,
    captureMode: 'automatic_pose_trigger',
    recognition: { status: 'unknown', reason: v.recognitionReason },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: hostile ? n.confidence : 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    targetSeed: { x: 0.5, y: 0.6, source: 'live_camera_tap' },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: hostile ? n.poseFrameCount : sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: hostile ? n.durationMs : window.endMs,
      // (tracked window stays the trigger window; the clip is longer)
      meanCanonicalJointVisibility: hostile ? n.coverage : 0.9,
      meanJointCoverage: hostile ? n.coverage : 0.9,
      minimumJointCoverage: hostile ? n.coverage : 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: hostile ? n.coverage : 0.6,
          peakNormalizedPerSecond: hostile ? n.coverage * 2 : 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///captures/${v.seed}.pose.json`,
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
  return { clip, sidecarJson };
}

function importedClip(v: Variant, hostile: boolean): CapturedClip {
  const n = hostile ? v.numerics : v.admitted;
  return {
    uri: `file:///imports/${v.seed}.mov`,
    durationMs: n.durationMs,
    fps: n.fps,
    width: n.width,
    height: n.height,
    capturedAtIso: v.eventInstant,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: v.recognitionReason },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'ERR',
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function freeAccess(limitAvailableToReserve: number): CanonicalAccessState {
  const used = 2 - limitAvailableToReserve;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining: limitAvailableToReserve,
      availableToReserve: limitAvailableToReserve,
    },
    canStartRating: limitAvailableToReserve > 0,
    paywallRequired: limitAvailableToReserve <= 0,
  };
}

/** Permit server: `mode` selects reserve behavior. */
function permitFetch(
  mode: 'free-remaining' | 'free-last' | 'paywall-402' | 'server-message',
  message: string,
): jest.Mock {
  let seq = 0;
  return jest.fn(async (url: string) => {
    if (url.endsWith('/v1/analysis-permits')) {
      seq += 1;
      if (mode === 'paywall-402') {
        return jsonResponse(402, {
          error: { code: 'paywall_required', message },
        });
      }
      if (mode === 'server-message') {
        return jsonResponse(503, { error: { code: 'unavailable', message } });
      }
      return jsonResponse(200, {
        permit: {
          id: `permit-${seq}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-29T20:00:00.000Z',
        },
        access: mode === 'free-last' ? freeAccess(0) : freeAccess(1),
      });
    }
    if (url.includes('/finalize')) return jsonResponse(200, { ok: true });
    if (url.includes('/v1/me/access'))
      return jsonResponse(200, { access: freeAccess(0) });
    return jsonResponse(200, { ok: true });
  });
}

// ─── Navigator host ──────────────────────────────────────────────────────────

const Stack = createNativeStackNavigator<RootStackParams>();
const nav: { current: { name: string; params: unknown } | null } = {
  current: null,
};

function navigatedName(): string | null {
  return nav.current?.name ?? null;
}

function RecordingRoute({ route }: { route: RouteProp<RootStackParams> }) {
  nav.current = { name: route.name, params: route.params };
  return <Text>{`stub:${route.name}`}</Text>;
}

async function renderNavigator(source: 'camera' | 'library') {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Analyze">
          <Stack.Screen
            name="Analyze"
            component={AnalyzeScreen}
            initialParams={{ source }}
          />
          <Stack.Screen name="Result" component={RecordingRoute} />
          <Stack.Screen name="Paywall" component={RecordingRoute} />
          <Stack.Screen name="Tabs" component={RecordingRoute} />
        </Stack.Navigator>
      </NavigationContainer>,
    );
  });
  return renderer;
}

async function flush() {
  await act(async () => {
    await new Promise(resolve => setTimeout(() => resolve(undefined), 0));
  });
}

async function waitFor(
  condition: () => boolean,
  what: string,
  timeoutMs = 15000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await act(async () => {
      await new Promise(resolve => setTimeout(() => resolve(undefined), 10));
    });
  }
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function emit(event: CameraEvent) {
  act(() => {
    for (const listener of mockCameraListeners) listener(event);
  });
}

function pressLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): boolean {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) return false;
  act(() => node.props.onPress());
  return true;
}

function pressButton(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): boolean {
  const candidates = renderer.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAll(t => t.type === Text && String(t.props.children) === label)
        .length > 0,
  );
  const node = candidates[candidates.length - 1];
  if (!node) return false;
  act(() => node.props.onPress());
  return true;
}

function deferred<T>() {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

const base = (v: Variant) => ({ emittedAtIso: v.eventInstant });
/** `state` is deliberately untyped: the native bridge is the producer and
 * the lens probes states the TypeScript union does not know about. */
function readiness(v: Variant, state: string, coverage: number): CameraEvent {
  const event = {
    ...base(v),
    type: 'readiness',
    state,
    poseConfidence: v.numerics.confidence,
    jointCoverage: coverage,
    stableForMs: 300,
    missingJoints: [],
    source: 'apple_vision_body_pose',
    modelVersion: 'apple-vision-bodypose-1',
  };
  return event as unknown as CameraEvent;
}
function session(
  v: Variant,
  state: 'configured' | 'observing' | 'armed' | 'interrupted',
): CameraEvent {
  return { ...base(v), type: 'session', state };
}
function permission(
  v: Variant,
  state: 'requesting' | 'granted' | 'denied',
): CameraEvent {
  return { ...base(v), type: 'permission', state };
}
function strokeDetected(v: Variant): CameraEvent {
  return {
    ...base(v),
    type: 'stroke_detected',
    startTimestampMs: 2000,
    endTimestampMs: 2700,
    peakMotionTimestampMs: 2400,
    confidence: 0.86,
    detectionModelVersion: 'temporal-stroke-heuristic-2',
    recognition: { status: 'unknown', reason: v.recognitionReason },
  };
}

function renderedTexts(renderer: TestRenderer.ReactTestRenderer): string[] {
  try {
    return renderer.root
      .findAll(n => String(n.type) === 'Text')
      .map(n => textContent(n));
  } catch {
    return [];
  }
}

function phaseOf(renderer: TestRenderer.ReactTestRenderer): string {
  const t = textOf(renderer);
  if (t.includes('stub:')) return `navigated:${nav.current?.name ?? '?'}`;
  if (t.includes('That was your last free analysis')) return 'free_limit';
  if (t.includes('Capture complete')) return 'saved';
  if (
    t.includes('Capture interrupted') ||
    t.includes('Analysis stopped') ||
    t.includes('Nothing was rated.')
  )
    return 'error';
  if (
    t.includes('AUTO-DETECTED') ||
    t.includes('RATING NOT CONSUMED') ||
    t.includes('DECLARED VS OBSERVED')
  )
    return 'analyzed';
  if (t.includes('Open automatic camera')) return 'ready';
  if (
    t.includes('Opening camera') ||
    t.includes('Opening video library') ||
    t.includes('progressbar') ||
    t.includes('Measuring') ||
    t.includes('Reading') ||
    t.includes('Auto Analyze') ||
    Object.values(READINESS_COPY).some(copy => t.includes(copy))
  )
    return 'working';
  return 'unknown';
}

// ─── One iteration ───────────────────────────────────────────────────────────

const owner = '22222222-2222-4222-8222-222222222222';

/** First-party frames only (src/ and __tests__/), for the evidence row. */
function ownFrames(stack: string | undefined): string {
  if (!stack) return '';
  const frames = stack
    .split('\n')
    .filter(
      line =>
        /\/(src|__tests__)\//.test(line) && !line.includes('node_modules'),
    )
    .slice(0, 6)
    .map(line => line.trim());
  return frames.length > 0 ? ` @ ${frames.join(' | ')}` : '';
}

async function runIteration(seed: number): Promise<Row> {
  const started = Date.now();
  const v = variantFor(seed);
  nav.current = null;
  mockCameraListeners.clear();
  const dbCalls: string[] = [];
  mockDb = {
    async execute(sql) {
      dbCalls.push(sql);
      return { rows: [] };
    },
    close() {},
  };
  Dimensions.set({
    window: {
      width: v.viewport.width,
      height: v.viewport.height,
      scale: 3,
      fontScale: v.fontScale,
    },
    screen: {
      width: v.viewport.width,
      height: v.viewport.height,
      scale: 3,
      fontScale: v.fontScale,
    },
  });
  (I18nManager as unknown as { isRTL: boolean }).isRTL = v.rtl;
  setActiveDataOwner(owner);
  establishApiSession({
    apiBaseUrl: 'https://api.test',
    bearerToken: 'token-1',
    canonicalAppUserId: owner,
    provider: 'apple',
  });
  useAccessStore.setState({ status: 'ready', canonicalAccess: freeAccess(1) });

  const boundary = v.boundary.value;
  const violations: Violation[] = [];
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let phaseReached = 'not-rendered';
  let step = 'render';

  const fetchMode =
    v.scenario === 'scored-free-limit'
      ? 'free-last'
      : v.scenario === 'error-permit-server'
        ? v.seed % 2 === 0
          ? 'paywall-402'
          : 'server-message'
        : 'free-remaining';
  (globalThis as { fetch?: unknown }).fetch = permitFetch(
    fetchMode,
    boundary || 'x',
  );

  try {
    const source: 'camera' | 'library' =
      v.scenario === 'saved-imported' ||
      v.scenario === 'saved-imported-target' ||
      v.scenario === 'gate-hostile-imported' ||
      v.scenario === 'library-import-failure'
        ? 'library'
        : 'camera';

    const capture = deferred<CapturedClip>();
    mockCaptureImpl = () => capture.promise;
    const imported = deferred<CapturedClip>();
    mockImportImpl = () => imported.promise;

    renderer = await renderNavigator(source);
    await flush();
    step = `scenario:${v.scenario}`;

    switch (v.scenario) {
      case 'ready':
        break;
      case 'ready-typed': {
        const [input] = renderer.root.findAll(
          n => String(n.type) === 'TextInput',
        );
        if (input) {
          act(() => input.props.onChangeText?.(boundary));
          act(() =>
            input.props.onSubmitEditing?.({ nativeEvent: { text: boundary } }),
          );
          await flush();
        }
        break;
      }
      case 'ready-declared':
        pressLabel(
          renderer,
          v.seed % 2 === 0 ? 'Forehand Drive' : 'Auto Detect',
        );
        break;
      case 'working-guidance': {
        pressButton(renderer, 'Open automatic camera');
        await flush();
        emit(permission(v, 'requesting'));
        emit(permission(v, 'granted'));
        emit(session(v, 'observing'));
        emit(readiness(v, 'no_person', 0));
        emit(readiness(v, 'move_closer', v.numerics.coverage));
        emit(readiness(v, 'hold_still', v.numerics.coverage));
        emit(session(v, 'armed'));
        emit(readiness(v, 'ready', v.numerics.coverage));
        break;
      }
      case 'working-unknown-readiness': {
        pressButton(renderer, 'Open automatic camera');
        await flush();
        emit(permission(v, 'granted'));
        emit(session(v, 'observing'));
        emit(readiness(v, v.readinessState, v.numerics.coverage));
        break;
      }
      case 'error-capture': {
        pressButton(renderer, 'Open automatic camera');
        await flush();
        capture.reject(new Error(boundary));
        await flush();
        break;
      }
      case 'error-non-error-rejection': {
        pressButton(renderer, 'Open automatic camera');
        await flush();
        capture.reject(v.nonError.value);
        await flush();
        break;
      }
      case 'library-import-failure': {
        // Library auto-launches after 160ms.
        await waitFor(
          () => textOf(renderer!).includes('Opening video library'),
          'library auto-launch',
        );
        imported.reject(
          Object.assign(new Error(boundary), {
            code: 'camera.import_no_person',
          }),
        );
        await flush();
        break;
      }
      case 'saved-guided':
      case 'gate-hostile-guided': {
        const hostile = v.scenario === 'gate-hostile-guided';
        pressButton(renderer, 'Open automatic camera');
        await flush();
        emit(permission(v, 'granted'));
        emit(session(v, 'observing'));
        emit(readiness(v, 'ready', 0.93));
        emit(strokeDetected(v));
        const { clip, sidecarJson } = guidedClip(v, hostile);
        // Auto Detect + an unrecognized clip with no pose sidecar cannot be
        // auto-scored, so the SAVED surface (declare-later) is what renders.
        // The hostile variant must instead be refused by the clip gate.
        const savedClip: CapturedClip = { ...clip, poseSequence: undefined };
        mockReadArtifact = async () => sidecarJson;
        act(() => capture.resolve(savedClip));
        await waitFor(
          () =>
            phaseOf(renderer!) === 'saved' ||
            phaseOf(renderer!).startsWith('navigated') ||
            phaseOf(renderer!) === 'error',
          'saved phase',
        );
        break;
      }
      case 'saved-imported':
      case 'saved-imported-target':
      case 'gate-hostile-imported': {
        await waitFor(
          () => textOf(renderer!).includes('Opening video library'),
          'library auto-launch',
        );
        act(() =>
          imported.resolve(
            importedClip(v, v.scenario === 'gate-hostile-imported'),
          ),
        );
        await waitFor(
          () =>
            phaseOf(renderer!) === 'saved' || phaseOf(renderer!) === 'error',
          'imported saved phase (or the clip gate refusing it)',
        );
        if (
          v.scenario === 'saved-imported-target' &&
          phaseOf(renderer) === 'saved'
        ) {
          step = 'declare-stroke-in-saved-phase';
          pressLabel(renderer, 'Forehand Drive');
          await flush();
          step = 'target-layout-and-tap';
          // The tap-yourself frame is present only once declared.
          const [frame] = renderer.root.findAll(
            n =>
              n.props.accessibilityLabel === 'Tap yourself in the frame' &&
              typeof n.props.onPress === 'function',
          );
          const [layoutHost] = renderer.root.findAll(
            n =>
              typeof n.props.onLayout === 'function' &&
              String(n.type) === 'View' &&
              flat(n).aspectRatio !== undefined,
          );
          if (layoutHost) {
            act(() =>
              layoutHost.props.onLayout({
                nativeEvent: {
                  layout: {
                    x: 0,
                    y: 0,
                    width: v.viewport.width - 48,
                    height: 380,
                  },
                },
              }),
            );
          }
          if (frame) {
            act(() =>
              frame.props.onPress({
                nativeEvent: {
                  locationX: v.numerics.width,
                  locationY: v.numerics.height,
                },
              }),
            );
            await flush();
          }
        }
        break;
      }
      case 'scored-result':
      case 'scored-free-limit': {
        pressLabel(renderer, 'Forehand Drive');
        pressButton(renderer, 'Open automatic camera');
        await flush();
        emit(permission(v, 'granted'));
        emit(session(v, 'observing'));
        emit(readiness(v, 'ready', 0.93));
        emit(strokeDetected(v));
        const { clip, sidecarJson } = guidedClip(v, false);
        mockReadArtifact = async () => sidecarJson;
        act(() => capture.resolve(clip));
        await waitFor(() => {
          const ph = phaseOf(renderer!);
          return (
            ph.startsWith('navigated') ||
            ph === 'free_limit' ||
            ph === 'error' ||
            ph === 'analyzed'
          );
        }, 'scoring outcome');
        break;
      }
      case 'error-permit-server': {
        pressLabel(renderer, 'Forehand Drive');
        pressButton(renderer, 'Open automatic camera');
        await flush();
        emit(permission(v, 'granted'));
        emit(session(v, 'observing'));
        emit(readiness(v, 'ready', 0.93));
        emit(strokeDetected(v));
        const { clip, sidecarJson } = guidedClip(v, false);
        mockReadArtifact = async () => sidecarJson;
        act(() => capture.resolve(clip));
        await waitFor(() => {
          const ph = phaseOf(renderer!);
          return ph === 'error' || ph.startsWith('navigated') || ph === 'saved';
        }, 'permit rejection surface');
        break;
      }
    }
    step = 'audit';
    await flush();
    phaseReached = phaseOf(renderer);
    const audit = auditTree(
      renderer.root,
      v.fontScale,
      v.viewport.width,
      v.viewport.height,
    );
    violations.push(...audit.violations);
    const texts = renderedTexts(renderer);
    const row: Row = {
      seed,
      scenario: v.scenario,
      fontScale: v.fontScale,
      viewport: `${v.viewport.width}x${v.viewport.height}`,
      localeRequested: v.locale,
      localeActual: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rtl: v.rtl,
      boundary: v.boundary.id,
      nonError: v.nonError.id,
      numerics: v.numerics,
      eventInstant: v.eventInstant,
      recognitionReason: v.recognitionReason,
      readinessState: v.readinessState,
      phaseReached,
      navigatedTo: navigatedName(),
      interactiveCount: audit.interactiveCount,
      textNodeCount: audit.textNodeCount,
      texts,
      violations,
      outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
      durationMs: Date.now() - started,
    };
    if (row.outcome === 'BROKEN') trees.set(seed, renderer.toJSON());
    return row;
  } catch (error) {
    violations.push({
      kind: 'render_error',
      node: 'AnalyzeScreen',
      detail:
        error instanceof Error
          ? `[step ${step}] ${error.name}: ${error.message}${ownFrames(error.stack)}`
          : `[step ${step}] ${String(error)}`,
      basis: 'host-tree',
    });
    if (renderer) {
      try {
        trees.set(seed, renderer.toJSON());
      } catch {
        trees.set(seed, null);
      }
    }
    return {
      seed,
      scenario: v.scenario,
      fontScale: v.fontScale,
      viewport: `${v.viewport.width}x${v.viewport.height}`,
      localeRequested: v.locale,
      localeActual: Intl.DateTimeFormat().resolvedOptions().locale,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rtl: v.rtl,
      boundary: v.boundary.id,
      nonError: v.nonError.id,
      numerics: v.numerics,
      eventInstant: v.eventInstant,
      recognitionReason: v.recognitionReason,
      readinessState: v.readinessState,
      phaseReached,
      navigatedTo: navigatedName(),
      interactiveCount: 0,
      textNodeCount: 0,
      texts: renderer ? renderedTexts(renderer) : [],
      violations,
      outcome: 'BROKEN',
      durationMs: Date.now() - started,
    };
  } finally {
    if (renderer) {
      await act(async () => {
        renderer!.unmount();
      });
    }
    await flush();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAccessStore.setState({ status: 'idle', canonicalAccess: null });
    (globalThis as { fetch?: unknown }).fetch = undefined;
    (I18nManager as unknown as { isRTL: boolean }).isRTL = false;
  }
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? 12));
const SEED_BASE = Number(process.env.STRESS_SEED ?? 1000);
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const CELL = process.env.STRESS_CELL ?? 'local';

const rows: Row[] = [];
/** Full host trees of BROKEN seeds (written beside the summary). */
const trees = new Map<number, unknown>();

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const summary = {
    unit: 'scr-analyzescreen',
    lens: 'boundary-i18n-a11y',
    cell: CELL,
    localeActual: Intl.DateTimeFormat().resolvedOptions().locale,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    seedBase: SEED_BASE,
    iterations: rows.length,
    held: rows.filter(r => r.outcome === 'HELD').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    byScenario: Object.fromEntries(
      SCENARIOS.map(s => [s, rows.filter(r => r.scenario === s).length]),
    ),
    violationKinds: Object.fromEntries(
      Array.from(new Set(rows.flatMap(r => r.violations.map(v => v.kind)))).map(
        k => [
          k,
          rows.flatMap(r => r.violations).filter(v => v.kind === k).length,
        ],
      ),
    ),
    rows,
  };
  writeFileSync(
    join(OUT_DIR, `analyzeScreen-boundary-i18n-a11y.${CELL}.${SEED_BASE}.json`),
    JSON.stringify(summary, null, 2),
  );
  for (const [seed, tree] of trees) {
    writeFileSync(
      join(
        OUT_DIR,
        `analyzeScreen-boundary-i18n-a11y.${CELL}.tree.${seed}.json`,
      ),
      JSON.stringify(tree, null, 1),
    );
  }
});

describe(`AnalyzeScreen × boundary/i18n/a11y (seeds ${SEED_BASE}…${SEED_BASE + ITER - 1}, cell ${CELL})`, () => {
  for (let i = 0; i < ITER; i += 1) {
    const seed = SEED_BASE + i;
    const v = variantFor(seed);
    it(`seed ${seed}: ${v.scenario} @${v.fontScale}× ${v.viewport.width}pt ${v.boundary.id}${v.rtl ? ' RTL' : ''}`, async () => {
      const row = await runIteration(seed);
      rows.push(row);
      const hard = row.violations.filter(x => x.basis === 'host-tree');
      const model = row.violations.filter(x => x.basis === 'layout-model');
      // Exact host-tree reads are hard failures; layout-model results are
      // reported in the same assertion so a BROKEN seed is never silent.
      expect({ seed, hard, model }).toEqual({ seed, hard: [], model: [] });
    }, 60000);
  }
});

describe('helper boundaries (pure)', () => {
  it('freeAnalysesPhrase over zero/negative/huge/non-integer limits never yields a forbidden literal (limit is server-pinned to 2)', () => {
    const phrases = [0, 1, 2, 3, -1, 2.5, 1e21].map(freeAnalysesPhrase);
    expect(phrases[2]).toBe('both');
    for (const phrase of phrases) {
      expect(phrase).not.toMatch(/NaN|undefined|Infinity/);
    }
  });
});
