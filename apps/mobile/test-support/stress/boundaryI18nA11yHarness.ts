/**
 * BOUNDARY / I18N / A11Y stress harness for the analysis feedback + progress
 * surfaces (AnalysisFeedbackPrompt, AnalysisProgressBar, UncertaintyNote).
 *
 * What lives here:
 *   - a seeded RNG (mulberry32) so every variant is replayable from its seed;
 *   - a hostile string corpus (200+ chars, CJK, Arabic RTL + bidi controls,
 *     ZWJ emoji, combining marks, German compounds, Thai, Devanagari, empty /
 *     whitespace, lone surrogates, format-string bait);
 *   - the Dynamic Type × device-width grid;
 *   - a single-line text measurer that reads REAL advance widths from the
 *     Manrope files the app ships (assets/fonts) and falls back to a
 *     documented per-script heuristic for glyphs Manrope lacks (iOS
 *     substitutes a system font for those — the fallback is an estimate);
 *   - a Yoga-free model of the two flex rows under test (progress label row,
 *     chip row) — exact for the styles those components declare;
 *   - rendered-tree utilities: text collection, pressable audit (role,
 *     label, ≥44pt), progressbar semantics, copy lint;
 *   - JSON artifact writer.
 *
 * Provenance labels used in results: layout numbers are MODELLED (Manrope
 * advances are exact, fallback scripts + wrapping are estimates); accessibility
 * props and text are read from the rendered tree (VERIFIED in the jest
 * renderer, which is not an iOS runtime).
 */
import { StyleSheet } from 'react-native';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import { parseTtf, type TtfMetrics } from './ttfAdvance';

// Node built-ins for reading the font files and writing artifacts. The mobile
// tsconfig excludes node typings, so the shims stay local (same pattern as
// __tests__/matrix/networkAuthMatrix.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const fs = require('fs') as {
  readFileSync: (path: string) => Uint8Array;
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const path = require('path') as { join: (...parts: string[]) => string };

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

/** mulberry32 — tiny, fast, good enough for replayable test data. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(public readonly seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/** FNV-1a so string seeds ("cjk:3") map to a stable 32-bit RNG seed. */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ---------------------------------------------------------------------------
// Environment grid: locales, timezones, Dynamic Type, widths
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

/** IANA zones covering UTC±14, half/quarter-hour offsets and DST edges. */
export const TIMEZONES = [
  { id: 'Pacific/Kiritimati', note: 'UTC+14, no DST' },
  { id: 'Etc/GMT+12', note: 'UTC-12, no DST' },
  { id: 'America/New_York', note: 'UTC-5/-4, US DST' },
  { id: 'Europe/Berlin', note: 'UTC+1/+2, EU DST' },
  { id: 'Australia/Lord_Howe', note: 'UTC+10:30/+11, 30-minute DST shift' },
  { id: 'Pacific/Chatham', note: 'UTC+12:45/+13:45, quarter-hour + DST' },
  { id: 'Asia/Kolkata', note: 'UTC+5:30, no DST' },
  { id: 'UTC', note: 'UTC' },
] as const;

/** Wall-clock instants straddling 2026 DST transitions (ms since epoch). */
export const DST_EDGE_INSTANTS_MS = [
  Date.UTC(2026, 2, 8, 6, 59, 59, 999), // US spring forward (07:00Z) - 1ms
  Date.UTC(2026, 2, 8, 7, 0, 0, 0),
  Date.UTC(2026, 2, 29, 0, 59, 59, 999), // EU spring forward (01:00Z) - 1ms
  Date.UTC(2026, 2, 29, 1, 0, 0, 0),
  Date.UTC(2026, 9, 3, 15, 59, 59, 999), // Lord Howe DST start (02:00 local)
  Date.UTC(2026, 9, 3, 16, 0, 0, 0),
  Date.UTC(2026, 10, 1, 5, 59, 59, 999), // US fall back (06:00Z) - 1ms
  Date.UTC(2026, 10, 1, 6, 0, 0, 0),
] as const;

/**
 * iOS Dynamic Type multipliers as React Native reports them through
 * `PixelRatio.getFontScale()` (RCTAccessibilityManager's multiplier table):
 * Large (default) = 1.0, xxxLarge = 1.353 (largest non-accessibility size),
 * AX5 = 3.571 (largest accessibility size). INFERRED from the RN source.
 */
export const FONT_SCALES = [
  { name: 'L (default)', scale: 1 },
  { name: 'XXXL', scale: 1.353 },
  { name: 'AX5', scale: 3.571 },
] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/**
 * Content widths the progress bar actually gets: the analyzing surface pads
 * `space.xl` (32pt) on each side (StrokeResult.tsx `analyzingWrap`) and the
 * bar caps itself at `maxWidth: 340`. Feedback/uncertainty rows sit in the
 * result card with `space.md`-ish insets; the same three widths are a fair
 * lower bound for them.
 */
export const CONTAINER_WIDTHS = [
  { device: 'iPhone SE (1st gen) 320pt', width: 320 - 2 * 32 },
  { device: 'iPhone 13 mini / SE (3rd gen) 375pt', width: 375 - 2 * 32 },
  { device: 'iPhone 15 Pro Max 430pt (bar maxWidth 340)', width: 340 },
] as const;
export type ContainerWidth = (typeof CONTAINER_WIDTHS)[number];

// ---------------------------------------------------------------------------
// Hostile string corpus
// ---------------------------------------------------------------------------

export const STRING_CATEGORIES = [
  'ascii-long',
  'cjk',
  'arabic-rtl',
  'bidi-controls',
  'zwj-emoji',
  'combining-marks',
  'german-compound',
  'thai',
  'devanagari',
  'cyrillic',
  'empty',
  'whitespace',
  'newlines',
  'lone-surrogate',
  'format-bait',
  'digits-huge',
] as const;
export type StringCategory = (typeof STRING_CATEGORIES)[number];

const ASCII_WORDS = [
  'verifying',
  'capture',
  'evidence',
  'reading',
  'player',
  'movement',
  'measuring',
  'swing',
  'saving',
  'result',
  'usually',
  'under',
  'seconds',
  'contact',
  'stroke',
  'wrist',
  'timeline',
  'estimate',
];
const CJK_POOL =
  '分析中の映像を確認しています選手の動きを読み取り中スイングを計測結果を保存中通常十秒以内接触推定手首速度基準位置不確実性注意事項評価';
const ARABIC_WORDS = [
  'جارٍ',
  'التحقق',
  'من',
  'أدلة',
  'التسجيل',
  'قراءة',
  'حركة',
  'اللاعب',
  'قياس',
  'الضربة',
  'حفظ',
  'النتيجة',
  'عادةً',
  'أقل',
  'ثوانٍ',
  '١٢٣٤٥٦٧٨٩٠',
];
const ZWJ_SEQUENCES = ['👨‍👩‍👧‍👦', '🏳️‍🌈', '👩🏽‍💻', '🧑🏿‍🤝‍🧑🏻', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '❤️‍🔥', '🇯🇵', '🏓'];
const COMBINING = [
  '\u0301',
  '\u0308',
  '\u0327',
  '\u0334',
  '\u0336',
  '\u035c',
  '\u0361',
  '\u20d7',
  '\u0489',
];
const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitän',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherung',
  'Schlagbewegungsauswertungsergebnis',
  'Straßenverkehrsordnungsänderungsverordnung',
];
const THAI_POOL =
  'กำลังตรวจสอบหลักฐานการบันทึกกำลังอ่านการเคลื่อนไหวของผู้เล่นกำลังวัดวงสวิงกำลังบันทึกผลลัพธ์โดยปกติไม่เกินสิบวินาที';
const DEVANAGARI_WORDS = [
  'कैप्चर',
  'साक्ष्य',
  'सत्यापित',
  'खिलाड़ी',
  'गतिविधि',
  'स्विंग',
  'मापन',
  'परिणाम',
  'सहेजा',
  'सामान्यतः',
  'सेकंड',
  'क्ष्म्य',
];
const CYRILLIC_WORDS = [
  'Проверка',
  'записи',
  'чтение',
  'движения',
  'игрока',
  'измерение',
  'замаха',
  'сохранение',
  'результата',
  'обычно',
  'секунд',
];
const BIDI_CONTROLS = [
  '\u202e', // RLO
  '\u202d', // LRO
  '\u200f', // RLM
  '\u200e', // LRM
  '\u2066', // LRI
  '\u2067', // RLI
  '\u2069', // PDI
  '\u202c', // PDF
];
const FORMAT_BAIT = [
  '%s %d %n %%',
  '{0} {analysisId} ${label}',
  '<b>bold</b> &amp; </Text>',
  '\\u0000 \\n \\r',
  '"quoted" \'single\' `tick`',
  '${{7*7}} {{label}}',
];

function joinToLength(
  rng: Rng,
  pool: readonly string[],
  target: number,
  sep: string,
): string {
  let out = '';
  while (out.length < target) out += (out ? sep : '') + rng.pick(pool);
  return out;
}

/** Generate a string of the given category; deterministic per (category, seed). */
export function hostileString(category: StringCategory, seed: number): string {
  const rng = new Rng(seed);
  switch (category) {
    case 'ascii-long':
      return joinToLength(rng, ASCII_WORDS, rng.int(200, 320), ' ');
    case 'cjk': {
      let out = '';
      const n = rng.int(200, 260);
      for (let i = 0; i < n; i += 1) {
        out += CJK_POOL.charAt(rng.int(0, CJK_POOL.length - 1));
      }
      return out;
    }
    case 'arabic-rtl':
      return joinToLength(rng, ARABIC_WORDS, rng.int(200, 260), ' ');
    case 'bidi-controls': {
      const words = joinToLength(rng, ASCII_WORDS, rng.int(40, 80), ' ').split(
        ' ',
      );
      return words
        .map(w => (rng.chance(0.5) ? rng.pick(BIDI_CONTROLS) + w : w))
        .join(' ')
        .concat(rng.pick(ARABIC_WORDS));
    }
    case 'zwj-emoji':
      return joinToLength(rng, ZWJ_SEQUENCES, rng.int(200, 240), '');
    case 'combining-marks': {
      const base = joinToLength(rng, ASCII_WORDS, rng.int(40, 60), ' ');
      let out = '';
      for (const ch of base) {
        out += ch;
        if (ch !== ' ') {
          const marks = rng.int(1, 6);
          for (let i = 0; i < marks; i += 1) out += rng.pick(COMBINING);
        }
      }
      return out;
    }
    case 'german-compound':
      return joinToLength(rng, GERMAN_COMPOUNDS, rng.int(200, 260), ' ');
    case 'thai': {
      let out = '';
      const n = rng.int(200, 260);
      for (let i = 0; i < n; i += 1) {
        out += THAI_POOL.charAt(rng.int(0, THAI_POOL.length - 1));
      }
      return out;
    }
    case 'devanagari':
      return joinToLength(rng, DEVANAGARI_WORDS, rng.int(200, 260), ' ');
    case 'cyrillic':
      return joinToLength(rng, CYRILLIC_WORDS, rng.int(200, 260), ' ');
    case 'empty':
      return '';
    case 'whitespace':
      return rng.pick([' ', '   ', '\t', '\u00a0\u00a0', '\u3000', '\u200b']);
    case 'newlines':
      return joinToLength(rng, ASCII_WORDS, rng.int(60, 120), '\n');
    case 'lone-surrogate':
      return rng.pick(['\ud83d', '\ude00', 'ab\ud83dcd', '\udc00\ud800']);
    case 'format-bait':
      return joinToLength(rng, FORMAT_BAIT, rng.int(60, 200), ' ');
    case 'digits-huge':
      return rng.pick([
        String(Number.MAX_SAFE_INTEGER),
        '1e+308',
        '-0',
        String(Number.MIN_VALUE),
        '٩٩٩٩٩٩٩٩٩٩٩٩',
        '१२३४५६७८९०१२३४५६७८९०',
        '999,999,999,999.999',
        '1.234.567,89',
      ]);
  }
}

/** Intl.Segmenter surface (ES2022 lib; the mobile tsconfig targets an older lib). */
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
interface IntlWithSegmenter {
  Segmenter?: new (
    locale: string | undefined,
    options: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
}

/** Grapheme clusters (Intl.Segmenter, Node ≥ 16 / Hermes ICU). */
export function graphemes(text: string): string[] {
  const Segmenter = (Intl as IntlWithSegmenter).Segmenter;
  if (!Segmenter) {
    throw new Error('Intl.Segmenter unavailable — Node ≥ 16 required');
  }
  const seg = new Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(seg.segment(text), s => s.segment);
}

// ---------------------------------------------------------------------------
// Text measurement (Manrope advances + per-script fallback)
// ---------------------------------------------------------------------------

export type FontFile =
  | 'Manrope_400Regular'
  | 'Manrope_500Medium'
  | 'Manrope_600SemiBold'
  | 'Manrope_700Bold';

const fontCache = new Map<FontFile, TtfMetrics>();
export function loadFont(file: FontFile): TtfMetrics {
  const cached = fontCache.get(file);
  if (cached) return cached;
  const fontPath = path.join(
    __dirname,
    '..',
    '..',
    'assets',
    'fonts',
    `${file}.ttf`,
  );
  const metrics = parseTtf(fs.readFileSync(fontPath));
  fontCache.set(file, metrics);
  return metrics;
}

const RE_MARK = /\p{M}/u;
const RE_CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff00-\uffef\u3000-\u303f]/u;
const RE_EMOJI = /\p{Extended_Pictographic}/u;
const RE_ARABIC = /\p{Script=Arabic}/u;
const RE_DEVANAGARI = /\p{Script=Devanagari}/u;
const RE_THAI = /\p{Script=Thai}/u;
const RE_CYRILLIC = /\p{Script=Cyrillic}/u;
const RE_FORMAT = /[\p{Cf}\u200b]/u; // ZWJ, ZWNJ, bidi controls, VS, tags, ZWSP
const RE_REGIONAL = /[\u{1f1e6}-\u{1f1ff}]/u;

/**
 * Fallback em-widths for glyphs Manrope lacks (iOS falls back to PingFang SC /
 * Hiragino / Geeza Pro / Kohinoor / Thonburi / Apple Color Emoji). ESTIMATES —
 * flagged as such in results.
 */
export function fallbackEm(codePoint: number): number | null {
  const ch = String.fromCodePoint(codePoint);
  if (RE_FORMAT.test(ch)) return 0;
  if (RE_MARK.test(ch)) return 0;
  if (RE_CJK.test(ch)) return 1.0;
  if (RE_REGIONAL.test(ch)) return 0.625; // pairs render as one 1.25em flag
  if (RE_EMOJI.test(ch)) return 1.25;
  if (RE_ARABIC.test(ch)) return 0.5;
  if (RE_DEVANAGARI.test(ch)) return 0.62;
  if (RE_THAI.test(ch)) return 0.55;
  if (RE_CYRILLIC.test(ch)) return 0.58;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return 0.6; // lone surrogate → tofu
  return null;
}

export interface Measurement {
  /** Advance width in points at the requested size (no kerning/shaping). */
  widthPt: number;
  /** Code points measured from the real Manrope file. */
  manropeGlyphs: number;
  /** Code points estimated via the fallback table. */
  fallbackGlyphs: number;
  /** Code points with no advance at all (marks, format controls). */
  zeroWidth: number;
  graphemeCount: number;
}

/**
 * Measure a string as ONE line at `fontSizePt × fontScale`. Newlines are
 * treated as breaks: the widest line is returned (matches numberOfLines={1}
 * truncation behaviour, which shows the first line only — see caller).
 */
export function measureSingleLine(
  text: string,
  font: FontFile,
  fontSizePt: number,
  fontScale: number,
): Measurement {
  const metrics = loadFont(font);
  const px = (fontSizePt * fontScale) / metrics.unitsPerEm;
  let manropeGlyphs = 0;
  let fallbackGlyphs = 0;
  let zeroWidth = 0;
  let widest = 0;
  for (const line of text.split('\n')) {
    let width = 0;
    for (const ch of line) {
      const cp = ch.codePointAt(0) ?? 0;
      const fb = fallbackEm(cp);
      if (fb === 0) {
        zeroWidth += 1;
        continue;
      }
      const glyph = metrics.glyphFor(cp);
      if (glyph !== 0) {
        manropeGlyphs += 1;
        width += metrics.advanceOf(glyph) * px;
        continue;
      }
      fallbackGlyphs += 1;
      width += (fb ?? 0.6) * fontSizePt * fontScale;
    }
    widest = Math.max(widest, width);
  }
  return {
    widthPt: widest,
    manropeGlyphs,
    fallbackGlyphs,
    zeroWidth,
    graphemeCount: graphemes(text).length,
  };
}

// ---------------------------------------------------------------------------
// Flex row models (exact for the declared styles)
// ---------------------------------------------------------------------------

export interface LabelRowLayout {
  containerWidth: number;
  gap: number;
  labelNatural: number;
  sublabelNatural: number;
  /** Width the sublabel takes: its natural width, clamped to the row. */
  sublabelAllocated: number;
  /** Width the label actually gets (flexShrink: 1). */
  labelAllocated: number;
  /** numberOfLines={1} + label narrower than its text ⇒ ellipsis. */
  labelClipped: boolean;
  /** Label squeezed out entirely: nothing of the stage label is readable. */
  labelCollapsed: boolean;
  /** allocated / natural, 1 = fully visible, 0 = collapsed. */
  labelVisibleFraction: number;
  /** Label + gap + sublabel exceed the row before shrinking. */
  rowOverflows: boolean;
}

/**
 * AnalysisProgressBar `labelRow`: flexDirection row, gap 8, label
 * `flexShrink: 1` + `numberOfLines={1}`, sublabel default `flexShrink: 0` +
 * `numberOfLines={1}`.
 *
 * Yoga model: both children are text nodes measured against the row's inner
 * width, so a single-line sublabel wider than the row measures to the row
 * width (it ellipsizes rather than painting outside). The sublabel does not
 * shrink, so it keeps that width and the label — the only shrinkable item —
 * is squeezed to (row - gap - sublabel), floored at 0. MODELLED, not an iOS
 * measurement.
 */
export function modelLabelRow(
  containerWidth: number,
  labelNatural: number,
  sublabelNatural: number | null,
  gap = 8,
): LabelRowLayout {
  const g = sublabelNatural === null ? 0 : gap;
  const sub = Math.min(sublabelNatural ?? 0, Math.max(0, containerWidth - g));
  const rowOverflows =
    labelNatural + g + (sublabelNatural ?? 0) > containerWidth + 1e-6;
  const labelAllocated = Math.min(
    labelNatural,
    Math.max(0, containerWidth - g - sub),
  );
  return {
    containerWidth,
    gap: g,
    labelNatural,
    sublabelNatural: sublabelNatural ?? 0,
    sublabelAllocated: sub,
    labelAllocated,
    labelClipped: labelAllocated + 1e-6 < labelNatural,
    labelCollapsed: labelAllocated <= 1e-6 && labelNatural > 0,
    labelVisibleFraction:
      labelNatural > 0 ? Math.min(1, labelAllocated / labelNatural) : 1,
    rowOverflows,
  };
}

// ---------------------------------------------------------------------------
// Rendered-tree utilities
// ---------------------------------------------------------------------------

export type RenderedJson =
  | string
  | {
      type: string;
      props: Record<string, unknown>;
      children: RenderedJson[] | null;
    };

/** All string leaves in document order. */
export function collectText(
  node: RenderedJson | RenderedJson[] | null,
): string[] {
  if (node === null) return [];
  if (Array.isArray(node)) return node.flatMap(collectText);
  if (typeof node === 'string') return [node];
  return collectText(node.children);
}

export function rendererText(renderer: ReactTestRenderer): string[] {
  return collectText(renderer.toJSON() as RenderedJson | RenderedJson[] | null);
}

export interface PressableAudit {
  testID: string | null;
  accessibilityRole: string | null;
  /** Explicit label, or the concatenated text content VoiceOver derives. */
  effectiveLabel: string;
  hasExplicitLabel: boolean;
  minHeight: number | null;
  height: number | null;
  justifyContent: string | null;
  /** Modelled chip width = paddingH*2 + border*2 + text advance. */
  modelledWidthPt: number | null;
  issues: string[];
}

function flatStyle(style: unknown): Record<string, unknown> {
  return (StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>;
}

function textOf(node: ReactTestInstance): string {
  const parts: string[] = [];
  const walk = (n: ReactTestInstance | string) => {
    if (typeof n === 'string') {
      parts.push(n);
      return;
    }
    for (const child of n.children) walk(child);
  };
  walk(node);
  return parts.join('');
}

/** Every element with an onPress handler (host or composite). */
export function findPressables(
  renderer: ReactTestRenderer,
): ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.props.onPress === 'function' && typeof node.type !== 'string',
  );
}

const MIN_TARGET = 44;

/**
 * Audit one interactive element: role present, a label (explicit or via
 * text content), a ≥44pt declared height, and — when `fontScale`/`font`
 * are given — a modelled ≥44pt width.
 */
export function auditPressable(
  node: ReactTestInstance,
  opts: { fontScale: number; fontSizePt: number; font: FontFile },
): PressableAudit {
  const style = flatStyle(node.props.style);
  const role =
    typeof node.props.accessibilityRole === 'string'
      ? (node.props.accessibilityRole as string)
      : typeof node.props.role === 'string'
        ? (node.props.role as string)
        : null;
  const explicit =
    typeof node.props.accessibilityLabel === 'string'
      ? (node.props.accessibilityLabel as string)
      : null;
  const text = textOf(node);
  const effectiveLabel = explicit ?? text;
  const minHeight =
    typeof style.minHeight === 'number' ? (style.minHeight as number) : null;
  const height =
    typeof style.height === 'number' ? (style.height as number) : null;
  const justifyContent =
    typeof style.justifyContent === 'string'
      ? (style.justifyContent as string)
      : null;
  const padH =
    typeof style.paddingHorizontal === 'number'
      ? (style.paddingHorizontal as number)
      : 0;
  const border =
    typeof style.borderWidth === 'number' ? (style.borderWidth as number) : 0;
  const modelledWidthPt =
    text.length > 0
      ? padH * 2 +
        border * 2 +
        measureSingleLine(text, opts.font, opts.fontSizePt, opts.fontScale)
          .widthPt
      : null;

  const issues: string[] = [];
  if (role === null) issues.push('missing accessibilityRole');
  if (effectiveLabel.trim().length === 0) {
    issues.push('no accessible label (no explicit label, no text content)');
  }
  const declaredHeight = minHeight ?? height;
  if (declaredHeight === null || declaredHeight < MIN_TARGET) {
    issues.push(`declared height ${declaredHeight ?? 'unset'} < ${MIN_TARGET}`);
  }
  if (modelledWidthPt !== null && modelledWidthPt < MIN_TARGET) {
    issues.push(`modelled width ${modelledWidthPt.toFixed(1)} < ${MIN_TARGET}`);
  }
  return {
    testID:
      typeof node.props.testID === 'string'
        ? (node.props.testID as string)
        : null,
    accessibilityRole: role,
    effectiveLabel,
    hasExplicitLabel: explicit !== null,
    minHeight,
    height,
    justifyContent,
    modelledWidthPt,
    issues,
  };
}

/** Rendered strings must never leak JS number/undefined formatting. */
export const LEAK_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: 'NaN', re: /\bNaN\b/ },
  { name: 'undefined', re: /\bundefined\b/ },
  { name: 'null', re: /\bnull\b/ },
  { name: 'Infinity', re: /Infinity/ },
  { name: 'scientific-notation', re: /\d[eE][+-]?\d/ },
  { name: 'object-Object', re: /\[object Object\]/ },
];

/**
 * APP_STORE_SUBMISSION.md copy rules: no Android/Google Play/guest mode/
 * Live Court/DUPR/competitors, no accuracy percentages or superlatives.
 * Only applied to copy the COMPONENT owns (not to injected hostile props).
 */
export const FORBIDDEN_COPY: ReadonlyArray<RegExp> = [
  /android/i,
  /google play/i,
  /guest mode/i,
  /live court/i,
  /\bDUPR\b/,
  /swingvision|pb vision|selkirk|joola/i,
  /\d+(\.\d+)?\s*%\s*accura/i,
  /\b(best|#1|most accurate|world[- ]class)\b/i,
];

export function leaksIn(text: string): string[] {
  return LEAK_PATTERNS.filter(p => p.re.test(text)).map(p => p.name);
}

export function forbiddenCopyIn(text: string): string[] {
  return FORBIDDEN_COPY.filter(re => re.test(text)).map(re => String(re));
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export function artifactDir(): string {
  return (
    process.env.STRESS_OUT ??
    path.join(__dirname, '..', '..', 'artifacts', 'stress')
  );
}

export function writeArtifact(name: string, data: unknown): string {
  const dir = artifactDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

/** Campaign size knobs shared by every stress suite. */
export function stressIterations(defaultCount: number): number {
  const raw = process.env.STRESS_ITER;
  if (raw === undefined || raw === '') return defaultCount;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`STRESS_ITER must be a non-negative integer, got ${raw}`);
  }
  return n;
}

export function stressOnlySeed(): number | null {
  const raw = process.env.STRESS_ONLY;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new Error(`STRESS_ONLY must be an integer seed, got ${raw}`);
  }
  return n;
}

export function envSnapshot(): {
  locale: string;
  timeZone: string;
  utcOffsetMinutesNow: number;
  node: string | undefined;
} {
  const resolved = Intl.DateTimeFormat().resolvedOptions();
  return {
    locale: resolved.locale,
    timeZone: resolved.timeZone,
    utcOffsetMinutesNow: -new Date().getTimezoneOffset(),
    node: process.env.NODE_VERSION,
  };
}
