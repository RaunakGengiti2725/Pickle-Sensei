/**
 * cmp-players / boundary-i18n-a11y — shared harness for the ClipPlayer and
 * DrillVideoPlayer stress suites under `__tests__/stress/`.
 *
 * Every rendered variant is derived from a 32-bit seed through mulberry32,
 * so any row of the JSON evidence table can be replayed with
 * `STRESS_SEED=<seed> npx jest __tests__/stress/<suite>`. Scale is set by
 * `STRESS_ITER` (seeded variants per campaign; small default so the suite
 * stays fast) and every run writes its seed → outcome table under
 * `artifacts/stress/cmp-players/<STRESS_RUN_ID>/` (repo-root relative,
 * git-ignored).
 *
 * What the Linux renderer can and cannot prove:
 *   - react-test-renderer produces the real element tree with the real
 *     props/styles, so roles, labels, testIDs, style-derived target sizes,
 *     verbatim string propagation and lifecycle behaviour are VERIFIED here.
 *   - There is no Yoga/CoreText on this plane. Geometry claims are an
 *     explicit arithmetic column model (`modelErrorCard`,
 *     `modelAttributionBlock`) built from the rendered style props; they are
 *     labelled MODEL in the evidence and are not iOS pixel truth.
 */
import { StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

// Node built-ins for the evidence sink. The mobile tsconfig deliberately
// excludes node typings, so the shims stay local (same convention as
// testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};
declare const Intl: {
  Segmenter: new (
    locale: string,
    options: { granularity: 'grapheme' },
  ) => { segment: (text: string) => Iterable<unknown> };
};

// ---------------------------------------------------------------------------
// Seeded randomness
// ---------------------------------------------------------------------------

/** mulberry32 — deterministic, replayable from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  if (items.length === 0) throw new Error('pick: empty list');
  return items[randomInt(random, 0, items.length - 1)] as T;
}

export const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';
export const STRESS_ITER = Math.max(
  1,
  Number(process.env['STRESS_ITER'] ?? 160) || 160,
);
export const STRESS_SEED: number | null = process.env['STRESS_SEED']
  ? Number(process.env['STRESS_SEED'])
  : null;
/** Campaign base seed; every variant i uses `baseSeed + i` unless pinned. */
export const BASE_SEED = Number(process.env['STRESS_BASE_SEED'] ?? 20260904);
/** When set, the arithmetic layout model becomes a hard assertion. */
export const STRICT_LAYOUT = process.env['STRESS_STRICT_LAYOUT'] === '1';

export function seedsFor(count: number): number[] {
  if (STRESS_SEED !== null) return [STRESS_SEED];
  return Array.from({ length: count }, (_, i) => BASE_SEED + i);
}

// ---------------------------------------------------------------------------
// String corpus — boundary / i18n classes
// ---------------------------------------------------------------------------

export type StringClass =
  | 'ascii-long'
  | 'cjk'
  | 'arabic-rtl'
  | 'zwj-emoji'
  | 'combining-marks'
  | 'german-compound'
  | 'thai'
  | 'devanagari'
  | 'cyrillic'
  | 'mixed-bidi'
  | 'control-chars'
  | 'whitespace'
  | 'single-char'
  | 'empty';

export const STRING_CLASSES: readonly StringClass[] = [
  'ascii-long',
  'cjk',
  'arabic-rtl',
  'zwj-emoji',
  'combining-marks',
  'german-compound',
  'thai',
  'devanagari',
  'cyrillic',
  'mixed-bidi',
  'control-chars',
  'whitespace',
  'single-char',
  'empty',
];

const ASCII_WORDS = [
  'dink',
  'kitchen',
  'paddle',
  'third-shot',
  'drop',
  'volley',
  'footwork',
  'reset',
  'transition',
  'crosscourt',
  'attribution',
  'creator',
  'license',
];
const CJK_POOL =
  '匹克球技术训练视频教程网球拍击球脚步移动截击反手正手发球接发球东京大阪京都ピクルボール練習動画コーチ한국어피클볼훌련영상';
const ARABIC_WORDS = [
  'تدريب',
  'مضرب',
  'كرة',
  'المطبخ',
  'حركة',
  'القدمين',
  'ضربة',
  'الإسقاط',
  'الثالثة',
  'مدرب',
  'فيديو',
  'ترخيص',
];
const ZWJ_EMOJI = ['👨‍👩‍👧‍👦', '🏳️‍🌈', '👩🏾‍🦽‍➡️', '🧑🏻‍🤝‍🧑🏿', '🏓', '👨‍🏫', '🇪🇬', '🇯🇵', '❤️‍🔥', '😶‍🌫️'];
const COMBINING = [
  '\u0301',
  '\u0308',
  '\u0327',
  '\u0334',
  '\u0336',
  '\u0361',
  '\u0489',
  '\u20DD',
  '\u1AB0',
  '\u0316',
];
const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitänsmützenhalterung',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherungsgesellschaft',
  'Schlittschuhlaufplatzbeleuchtungsanlage',
];
const THAI_POOL =
  'การฝึกซ้อมพิกเกิลบอลไม้ตีลูกบอลการเคลื่อนไหวเท้าวิดีโอสอนโค้ชใบอนุญาต';
const DEVANAGARI_WORDS = [
  'प्रशिक्षण',
  'पिकलबॉल',
  'क्रीड़ा',
  'वीडियो',
  'कोच',
  'अनुज्ञप्ति',
  'श्रेय',
  'क्षत्रिय',
  'द्वितीय',
];
const CYRILLIC_WORDS = [
  'тренировка',
  'пиклбол',
  'ракетка',
  'видео',
  'лицензия',
  'тренер',
  'движение',
  'удар',
  'кухня',
];
const CONTROL_CHARS = [
  '\u0000',
  '\u200B',
  '\u200E',
  '\u200F',
  '\u202E',
  '\u2028',
  '\u2029',
  '\uFEFF',
  '\u00AD',
  '\t',
  '\r',
];

function repeatWords(
  random: () => number,
  pool: readonly string[],
  minLength: number,
  separator: string,
): string {
  let out = '';
  while (out.length < minLength) {
    out += (out ? separator : '') + pick(random, pool);
  }
  return out;
}

function repeatChars(
  random: () => number,
  pool: string,
  minLength: number,
): string {
  const chars = Array.from(pool);
  let out = '';
  while (out.length < minLength) out += pick(random, chars);
  return out;
}

/** A string of the given class; long classes are always ≥ `minLength`. */
export function stringOfClass(
  random: () => number,
  cls: StringClass,
  minLength = 200,
): string {
  switch (cls) {
    case 'ascii-long':
      return repeatWords(random, ASCII_WORDS, minLength, ' ');
    case 'cjk':
      return repeatChars(random, CJK_POOL, minLength);
    case 'arabic-rtl':
      return '\u200F' + repeatWords(random, ARABIC_WORDS, minLength, ' ');
    case 'zwj-emoji':
      return repeatWords(random, ZWJ_EMOJI, minLength, '');
    case 'combining-marks': {
      let out = '';
      while (out.length < minLength) {
        out += pick(random, Array.from('pickle'));
        const marks = randomInt(random, 1, 12);
        for (let i = 0; i < marks; i += 1) out += pick(random, COMBINING);
      }
      return out;
    }
    case 'german-compound':
      return repeatWords(random, GERMAN_COMPOUNDS, minLength, '');
    case 'thai':
      return repeatChars(random, THAI_POOL, minLength);
    case 'devanagari':
      return repeatWords(random, DEVANAGARI_WORDS, minLength, ' ');
    case 'cyrillic':
      return repeatWords(random, CYRILLIC_WORDS, minLength, ' ');
    case 'mixed-bidi': {
      let out = '';
      while (out.length < minLength) {
        out += `${pick(random, ASCII_WORDS)} ${pick(random, ARABIC_WORDS)} ${randomInt(random, 0, 9999)} `;
      }
      return out;
    }
    case 'control-chars': {
      let out = '';
      while (out.length < minLength) {
        out += pick(random, ASCII_WORDS) + pick(random, CONTROL_CHARS);
      }
      return out;
    }
    case 'whitespace':
      return ' \t\n\u00A0\u2003 ';
    case 'single-char':
      return pick(random, ['a', '中', 'ع', '👨‍👩‍👧', 'ß', 'İ']);
    case 'empty':
      return '';
  }
}

// ---------------------------------------------------------------------------
// Locale / timezone dimensions
// ---------------------------------------------------------------------------

export const LOCALES = [
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
export type Locale = (typeof LOCALES)[number];

/** Script class a locale's creator/attribution strings are drawn from. */
export const LOCALE_SCRIPT: Record<Locale, StringClass> = {
  'de-DE': 'german-compound',
  'fr-FR': 'ascii-long',
  'ar-EG': 'arabic-rtl',
  'hi-IN': 'devanagari',
  'ja-JP': 'cjk',
  'pt-BR': 'ascii-long',
  'tr-TR': 'mixed-bidi',
  'ru-RU': 'cyrillic',
  'th-TH': 'thai',
  'zh-CN': 'cjk',
  'en-IN': 'ascii-long',
  'es-419': 'combining-marks',
};

/** Locale-flavoured decorations layered onto the script strings. */
export const LOCALE_DECOR: Record<Locale, string> = {
  'de-DE': 'Straße „Übungs-Video“ 1.234,56 €',
  'fr-FR': 'Cœur d’entraînement « vidéo » 1 234,56 €',
  'ar-EG': 'التمرين رقم ١٢٣٤ ٫٥٦',
  'hi-IN': 'प्रशिक्षण ₹1,23,456.78',
  'ja-JP': '練習ビデオ　１２３４円',
  'pt-BR': 'Treinamento de ação R$ 1.234,56',
  'tr-TR': 'İstanbul ışık DİNK ₺1.234,56',
  'ru-RU': 'Тренировка «видео» 1 234,56 ₽',
  'th-TH': 'การฝึก ๑๒๓๔ ฿',
  'zh-CN': '训练视频 ¥1,234.56',
  'en-IN': 'Training video ₹1,23,456.78',
  'es-419': 'Entrenamiento ¿vídeo? $1.234,56',
};

export interface TimezoneCase {
  name: string;
  /** ISO offset used in `expiresAt` strings. */
  offset: string;
  /** A local wall-clock instant on a DST edge (or arbitrary when none). */
  edgeLocal: string;
  note: string;
}

export const TIMEZONES: readonly TimezoneCase[] = [
  {
    name: 'Pacific/Kiritimati',
    offset: '+14:00',
    edgeLocal: '2026-12-31T23:59:59',
    note: 'UTC+14, the eastern-most offset',
  },
  {
    name: 'Etc/GMT+12',
    offset: '-12:00',
    edgeLocal: '2026-01-01T00:00:00',
    note: 'UTC-12, the western-most offset',
  },
  {
    name: 'Pacific/Pago_Pago',
    offset: '-11:00',
    edgeLocal: '2026-06-30T23:59:60',
    note: 'UTC-11 with a leap-second wall clock',
  },
  {
    name: 'America/New_York',
    offset: '-05:00',
    edgeLocal: '2026-03-08T02:30:00',
    note: 'spring-forward gap (02:30 does not exist locally)',
  },
  {
    name: 'Europe/Berlin',
    offset: '+02:00',
    edgeLocal: '2026-10-25T02:30:00',
    note: 'fall-back overlap (02:30 occurs twice)',
  },
  {
    name: 'Australia/Lord_Howe',
    offset: '+10:30',
    edgeLocal: '2026-04-05T02:00:00',
    note: '30-minute DST shift',
  },
  {
    name: 'Asia/Kathmandu',
    offset: '+05:45',
    edgeLocal: '2026-07-01T12:00:00',
    note: 'quarter-hour offset',
  },
  {
    name: 'UTC',
    offset: 'Z',
    edgeLocal: '1970-01-01T00:00:00',
    note: 'epoch',
  },
];

export function expiresAtFor(tz: TimezoneCase): string {
  return `${tz.edgeLocal}${tz.offset}`;
}

// ---------------------------------------------------------------------------
// Viewport / font-scale dimensions
// ---------------------------------------------------------------------------

export interface Viewport {
  name: string;
  width: number;
  height: number;
  insets: { top: number; bottom: number };
}

/** Three widths, paired with the device heights they ship on. */
export const VIEWPORTS: readonly Viewport[] = [
  {
    name: 'iPhone SE 1st gen',
    width: 320,
    height: 568,
    insets: { top: 20, bottom: 0 },
  },
  {
    name: 'iPhone SE 3rd gen',
    width: 375,
    height: 667,
    insets: { top: 20, bottom: 0 },
  },
  {
    name: 'iPhone 15 Pro Max',
    width: 430,
    height: 932,
    insets: { top: 59, bottom: 34 },
  },
];

/** iOS Dynamic Type: default, xxxLarge, AX5 (largest accessibility size). */
export const FONT_SCALES = [1.0, 1.35, 3.12] as const;
export type FontScale = (typeof FONT_SCALES)[number];

// ---------------------------------------------------------------------------
// Rendered-tree inspection
// ---------------------------------------------------------------------------

function isHost(node: ReactTestInstance): boolean {
  return typeof node.type === 'string';
}

/** All string leaves rendered under `root`, in tree order. */
export function collectText(root: ReactTestInstance): string[] {
  const out: string[] = [];
  const visit = (node: ReactTestInstance) => {
    for (const child of node.children) {
      if (typeof child === 'string') out.push(child);
      else visit(child);
    }
  };
  visit(root);
  return out;
}

function flatten(style: unknown): Record<string, unknown> {
  const flat = StyleSheet.flatten(style as never) as
    Record<string, unknown> | null | undefined;
  return flat ?? {};
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export interface InteractiveAudit {
  testID: string | null;
  role: string | null;
  label: string | null;
  /** Style-derived minimum extent; null when the style leaves it to content. */
  minWidth: number | null;
  minHeight: number | null;
  hitSlop: { horizontal: number; vertical: number };
  /** True when the node is absolutely positioned to fill its parent. */
  fillsParent: boolean;
  /** Effective minimum touch extent including hitSlop (null = unbounded). */
  effectiveWidth: number | null;
  effectiveHeight: number | null;
  problems: string[];
}

/** Total touch extension (both sides summed) a hitSlop prop adds. */
function hitSlopOf(value: unknown): { horizontal: number; vertical: number } {
  if (typeof value === 'number') {
    return { horizontal: value * 2, vertical: value * 2 };
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    return {
      horizontal: numberOr(v.left, 0) + numberOr(v.right, 0),
      vertical: numberOr(v.top, 0) + numberOr(v.bottom, 0),
    };
  }
  return { horizontal: 0, vertical: 0 };
}

/**
 * Every host node that reacts to touches (Pressable installs the responder
 * handlers on its host View) must expose an accessible role + label and a
 * ≥ 44pt target. Text-only labels (a Text child) count as a label.
 */
export function auditInteractive(
  root: ReactTestInstance,
  minTarget = 44,
): InteractiveAudit[] {
  const nodes = root.findAll(
    node =>
      isHost(node) &&
      (typeof node.props.onResponderGrant === 'function' ||
        typeof node.props.onClick === 'function' ||
        typeof node.props.onPress === 'function' ||
        node.props.accessibilityRole === 'button' ||
        node.props.accessibilityRole === 'link'),
  );
  return nodes.map(node => {
    const style = flatten(node.props.style);
    const role =
      typeof node.props.accessibilityRole === 'string'
        ? node.props.accessibilityRole
        : null;
    const explicitLabel =
      typeof node.props.accessibilityLabel === 'string'
        ? node.props.accessibilityLabel
        : null;
    const textLabel = collectText(node).join(' ').trim();
    const label = explicitLabel ?? (textLabel ? textLabel : null);
    const minWidth =
      typeof style.width === 'number'
        ? style.width
        : typeof style.minWidth === 'number'
          ? style.minWidth
          : null;
    const minHeight =
      typeof style.height === 'number'
        ? style.height
        : typeof style.minHeight === 'number'
          ? style.minHeight
          : null;
    const fillsParent =
      style.position === 'absolute' &&
      numberOr(style.top, NaN) === 0 &&
      numberOr(style.left, NaN) === 0 &&
      numberOr(style.right, NaN) === 0 &&
      numberOr(style.bottom, NaN) === 0;
    const hitSlop = hitSlopOf(node.props.hitSlop);
    const effectiveWidth =
      minWidth === null ? null : minWidth + hitSlop.horizontal;
    const effectiveHeight =
      minHeight === null ? null : minHeight + hitSlop.vertical;
    const problems: string[] = [];
    if (role !== 'button' && role !== 'link') problems.push('missing-role');
    if (!label || !label.trim()) problems.push('missing-label');
    if (!fillsParent) {
      if (effectiveHeight === null) problems.push('height-unbounded-by-style');
      else if (effectiveHeight < minTarget)
        problems.push(`height<${minTarget}`);
      if (effectiveWidth !== null && effectiveWidth < minTarget) {
        problems.push(`width<${minTarget}`);
      }
    }
    return {
      testID: typeof node.props.testID === 'string' ? node.props.testID : null,
      role,
      label,
      minWidth,
      minHeight,
      hitSlop,
      fillsParent,
      effectiveWidth,
      effectiveHeight,
      problems,
    };
  });
}

/** Copy the dossier forbids anywhere user-facing (APP_STORE_SUBMISSION.md). */
const FORBIDDEN_COPY = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision/i,
  /pb vision/i,
  /selkirk/i,
  /joola/i,
  /\d+\s?%/,
];

export function forbiddenCopyHits(text: string): string[] {
  return FORBIDDEN_COPY.filter(re => re.test(text)).map(re => re.source);
}

// ---------------------------------------------------------------------------
// Arithmetic layout model (MODEL, not pixel truth)
// ---------------------------------------------------------------------------

const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

export function graphemeCount(text: string): number {
  let n = 0;
  for (const _ of segmenter.segment(text)) n += 1;
  return n;
}

/** Average advance width in em for a string's dominant script. */
export function advanceEm(text: string): number {
  if (
    /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(
      text,
    )
  )
    return 1.0;
  if (/\p{Extended_Pictographic}/u.test(text)) return 1.15;
  if (/\p{Script=Thai}|\p{Script=Devanagari}/u.test(text)) return 0.62;
  if (/\p{Script=Arabic}/u.test(text)) return 0.5;
  return 0.54;
}

/** Code points that occupy no advance width. */
const ZERO_ADVANCE = new Set([
  '\u200B',
  '\u200E',
  '\u200F',
  '\u202E',
  '\uFEFF',
  '\u00AD',
  '\u0000',
]);

/**
 * Lines a single Text takes at `fontSize × fontScale` in `widthPt`. Long
 * unbreakable runs (German compounds, CJK) break at glyph boundaries, which
 * RN also does when a word is wider than the line.
 */
export function modelLines(
  text: string,
  widthPt: number,
  fontSize: number,
  fontScale: number,
): number {
  if (widthPt <= 0) return Number.POSITIVE_INFINITY;
  const explicit = text.split(/\r\n|\r|\n|\u2028|\u2029/);
  const glyphPt = fontSize * fontScale * advanceEm(text);
  const perLine = Math.max(1, Math.floor(widthPt / glyphPt));
  return explicit.reduce((sum, line) => {
    const n = graphemeCount(
      Array.from(line)
        .filter(ch => !ZERO_ADVANCE.has(ch))
        .join(''),
    );
    return sum + Math.max(1, Math.ceil(n / perLine));
  }, 0);
}

export interface ErrorCardModel {
  boxWidth: number;
  boxHeight: number;
  /** Minimum content height with the title on one line (style-derived). */
  styleFloorPt: number;
  /** Modelled content height including title wrapping and text growth. */
  contentPt: number;
  overflowPt: number;
  clipsButtons: boolean;
}

/**
 * The error card (`errorWrap`) is a centered column inside the 16:9
 * `playerBox` (overflow hidden): padding 24 ×2, title (bodyBold 22pt line
 * height), gap 16, "Open on …" button (minHeight 48 or its text), gap 16,
 * "Try again" button (minHeight 48 or its text). Text scales with the OS
 * font scale (no maxFontSizeMultiplier is set anywhere in the app).
 */
export function modelErrorCard(
  boxWidth: number,
  boxHeight: number,
  fontScale: number,
  titleText: string,
  openLabel: string,
): ErrorCardModel {
  const bodyLine = 22 * fontScale;
  const padding = 24 * 2;
  const gap = 16;
  const innerWidth = boxWidth - 24 * 2;
  const titleLines = modelLines(titleText, innerWidth, 16, fontScale);
  const buttonInner = innerWidth - 24 * 2;
  const openLines = modelLines(openLabel, buttonInner, 16, fontScale);
  const retryLines = modelLines('Try again', buttonInner, 16, fontScale);
  const openButton = Math.max(48, openLines * bodyLine);
  const retryButton = Math.max(48, retryLines * bodyLine);
  const styleFloorPt = padding + bodyLine + gap + 48 + gap + 48;
  const contentPt =
    padding + titleLines * bodyLine + gap + openButton + gap + retryButton;
  const overflowPt = Math.max(0, contentPt - boxHeight);
  return {
    boxWidth,
    boxHeight,
    styleFloorPt,
    contentPt,
    overflowPt,
    clipsButtons: overflowPt > 0,
  };
}

export interface AttributionModel {
  columnWidth: number;
  creatorLines: number;
  attributionLines: number;
  /** Modelled height of box + attribution block (+ error line). */
  contentPt: number;
  /** Space the center column actually has (screen minus insets). */
  availablePt: number;
  overflowPt: number;
}

/**
 * The center column stacks the player box and the attribution block
 * (creatorName bodyBold, attribution caption 18pt lines, source link 44pt,
 * optional alert caption). Nothing scrolls and no Text sets numberOfLines,
 * so overflow is clipped by the screen edge.
 */
export function modelAttributionBlock(args: {
  width: number;
  height: number;
  insets: { top: number; bottom: number };
  boxHeight: number;
  fontScale: number;
  creatorName: string;
  attribution: string;
  sourceError: string | null;
}): AttributionModel {
  const columnWidth = args.width - 24 * 2 - 16 * 2;
  const creatorLines = modelLines(
    args.creatorName,
    columnWidth,
    16,
    args.fontScale,
  );
  const attributionLines = modelLines(
    args.attribution,
    columnWidth,
    13,
    args.fontScale,
  );
  const errorLines = args.sourceError
    ? modelLines(args.sourceError, columnWidth, 13, args.fontScale)
    : 0;
  const block =
    24 +
    creatorLines * 22 * args.fontScale +
    4 +
    attributionLines * 18 * args.fontScale +
    8 +
    Math.max(44, 18 * args.fontScale) +
    (errorLines ? 4 + errorLines * 18 * args.fontScale : 0);
  const contentPt = args.boxHeight + block;
  const availablePt = args.height - args.insets.top - args.insets.bottom;
  return {
    columnWidth,
    creatorLines,
    attributionLines,
    contentPt,
    availablePt,
    overflowPt: Math.max(0, contentPt - availablePt),
  };
}

// ---------------------------------------------------------------------------
// Evidence sink
// ---------------------------------------------------------------------------

function repoRoot(): string {
  // apps/mobile/testing/stress → repo root
  return path.resolve(__dirname, '..', '..', '..', '..');
}

export function evidenceDir(): string {
  return path.join(repoRoot(), 'artifacts', 'stress', 'cmp-players', RUN_ID);
}

export function writeEvidence(name: string, data: unknown): string {
  fs.mkdirSync(evidenceDir(), { recursive: true });
  const file = path.join(evidenceDir(), name);
  fs.writeFileSync(file, `${JSON.stringify(data, replacer, 2)}\n`);
  return file;
}

/** JSON cannot carry NaN/±Infinity/-0; keep them legible in the table. */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'NaN';
    if (value === Number.POSITIVE_INFINITY) return 'Infinity';
    if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
    if (Object.is(value, -0)) return '-0';
  }
  return value;
}

/** Short, JSON-safe preview of a possibly huge / control-laden string. */
export function preview(value: unknown, max = 48): string {
  if (typeof value !== 'string') return String(value);
  const escaped = JSON.stringify(value);
  return escaped.length > max
    ? `${escaped.slice(0, max)}…(${value.length})`
    : escaped;
}
