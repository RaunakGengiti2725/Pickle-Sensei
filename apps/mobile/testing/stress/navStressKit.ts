/**
 * Stress kit for the navigation component unit (RootNavigator, PremiumTabBar,
 * params) under the boundary / i18n / a11y lens.
 *
 * Everything here is deterministic: a variant is fully described by its seed,
 * so any recorded outcome replays with
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/<suite>
 * and a single variant can be isolated with STRESS_ONLY_SEED=<seed>.
 *
 * What this kit can and cannot prove (Linux plane):
 * - CAN prove, from the rendered tree: which elements are interactive, what
 *   accessible role/label/state they expose, the style-declared touch box of
 *   each one, and that copy/labels are identical across locales, timezones and
 *   RTL (the navigation surface reads none of them today).
 * - CANNOT prove pixel truth: React Test Renderer runs no layout engine and
 *   Linux is not an Apple device. Text extents come from `estimateTextWidth`,
 *   an explicit advance-width MODEL, and the flex boxes come from
 *   `resolveBarLayout`, an explicit model of the bar's single flex row. Every
 *   clipping/overlap outcome produced from those two functions is labelled
 *   `modelled` in the results table and must be confirmed on the Apple plane
 *   before it is treated as a measured fact.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { I18nManager, StyleSheet } from 'react-native';
import type { ReactTestInstance } from 'react-test-renderer';

/* ------------------------------------------------------------------ *
 * Seeded RNG (mulberry32 — 32-bit, no dependencies, fully replayable)
 * ------------------------------------------------------------------ */

export type Rng = {
  readonly seed: number;
  next(): number;
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  bool(probability?: number): boolean;
};

export function makeRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    seed,
    next,
    int: maxExclusive => Math.floor(next() * maxExclusive),
    pick: items => items[Math.floor(next() * items.length)]!,
    bool: (probability = 0.5) => next() < probability,
  };
}

/* ------------------------------------------------------------------ *
 * Campaign scale / replay controls
 * ------------------------------------------------------------------ */

/** Base seed for the campaign; override to replay a whole run. */
export const BASE_SEED = Number.parseInt(
  process.env.STRESS_SEED ?? '20260904',
  10,
);

/** Multiplies the default (suite-owned) iteration count. Default 1 keeps the
 * suites fast enough to live in the normal jest run. */
export const STRESS_MULTIPLIER = Math.max(
  1,
  Number.parseInt(process.env.STRESS_ITER ?? '1', 10) || 1,
);

/** When set, only the variant carrying this seed runs (failure minimisation). */
export const ONLY_SEED =
  process.env.STRESS_ONLY_SEED === undefined
    ? null
    : Number.parseInt(process.env.STRESS_ONLY_SEED, 10);

export function seedIsSelected(seed: number): boolean {
  return ONLY_SEED === null || ONLY_SEED === seed;
}

/**
 * True while a single seed is being replayed. Aggregate expectations (which
 * need the whole grid) are skipped then; the per-variant assertions still
 * run, so `STRESS_ONLY_SEED=<seed>` is a minimised repro of one variant.
 */
export const MINIMISING = ONLY_SEED !== null;

/* ------------------------------------------------------------------ *
 * Lens corpora
 * ------------------------------------------------------------------ */

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

/** UTC±14 extremes plus both DST edges of the northern and southern hemisphere. */
export const TIMEZONES = [
  'UTC',
  'Pacific/Kiritimati', // UTC+14
  'Etc/GMT+12', // UTC-12
  'Pacific/Chatham', // UTC+12:45, DST
  'America/St_Johns', // UTC-3:30, DST
  'Australia/Lord_Howe', // 30-minute DST shift
  'Europe/Berlin', // spring-forward edge
  'America/Santiago', // southern-hemisphere DST edge
] as const;

/** iOS Dynamic Type: default, xxLarge, AX3 (the largest accessibility size). */
export const FONT_SCALES = [1, 1.235, 2.35] as const;

/** iPhone portrait point widths in the shipping range (SE → Pro Max). */
export const WIDTHS = [320, 375, 430] as const;

export type StringCase = { id: string; value: string };

/** Boundary string corpus: 200+ chars, CJK, Arabic RTL, ZWJ emoji, combining
 * marks, German compounds, and the empty/whitespace degenerates. */
export const STRING_CORPUS: readonly StringCase[] = [
  { id: 'empty', value: '' },
  { id: 'space', value: ' ' },
  { id: 'newlines', value: '\n\n\t' },
  {
    id: 'latin-240',
    value: 'Pickle'.repeat(40),
  },
  {
    id: 'latin-sentence-260',
    value:
      'A very long analysis label that a translator could plausibly produce for one single tab of a bottom navigation bar in a mobile application, repeated to pass two hundred characters of pressure. '.repeat(
        2,
      ),
  },
  { id: 'cjk-zh', value: '球拍技术分析报告与训练建议'.repeat(16) },
  { id: 'cjk-ja', value: 'ピックルボールのフォーム分析'.repeat(16) },
  { id: 'arabic-rtl', value: 'تحليل تقنية الضرب في لعبة البيكل بول'.repeat(7) },
  { id: 'hebrew-rtl', value: 'ניתוח טכניקת החבטה'.repeat(12) },
  { id: 'thai', value: 'การวิเคราะห์เทคนิคการตีลูก'.repeat(9) },
  { id: 'devanagari', value: 'तकनीक विश्लेषण रिपोर्ट'.repeat(11) },
  { id: 'zwj-emoji', value: '👨‍👩‍👧‍👦🏓👩🏽‍🚀'.repeat(20) },
  {
    id: 'combining-marks',
    value: 'e\u0301a\u0300o\u0302u\u0308n\u0303'.repeat(45),
  },
  { id: 'combining-storm', value: `a${'\u0301'.repeat(200)}` },
  {
    id: 'german-compound',
    value: 'Rechtsschutzversicherungsgesellschaften '.repeat(6),
  },
  { id: 'turkish-dotless', value: 'ığüşöçİĞÜŞÖÇ'.repeat(20) },
  { id: 'rtl-override', value: `\u202eoverridden\u202c`.repeat(12) },
  { id: 'nul-and-controls', value: 'a\u0000b\u0007c\u001bd'.repeat(50) },
  { id: 'surrogate-lone', value: '\ud83d'.repeat(30) },
];

/** Zero / negative / huge / non-finite numerics for numeric props. */
export const NUMERIC_CORPUS: readonly { id: string; value: number }[] = [
  { id: 'zero', value: 0 },
  { id: 'negative-zero', value: -0 },
  { id: 'negative-one', value: -1 },
  { id: 'negative-huge', value: -1e9 },
  { id: 'huge', value: 1e9 },
  { id: 'max-safe', value: Number.MAX_SAFE_INTEGER },
  { id: 'fraction', value: 0.5 },
  { id: 'nan', value: Number.NaN },
  { id: 'infinity', value: Number.POSITIVE_INFINITY },
];

/** Safe-area insets: real devices plus the degenerate values. */
export const INSET_CASES: readonly {
  id: string;
  insets: { top: number; bottom: number; left: number; right: number };
}[] = [
  { id: 'se-no-notch', insets: { top: 20, bottom: 0, left: 0, right: 0 } },
  { id: 'notch', insets: { top: 44, bottom: 34, left: 0, right: 0 } },
  { id: 'dynamic-island', insets: { top: 59, bottom: 34, left: 0, right: 0 } },
  { id: 'zero', insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  { id: 'negative', insets: { top: -10, bottom: -34, left: -5, right: -5 } },
  { id: 'huge', insets: { top: 1e6, bottom: 1e6, left: 1e6, right: 1e6 } },
  {
    id: 'nan',
    insets: { top: Number.NaN, bottom: Number.NaN, left: 0, right: 0 },
  },
];

/**
 * Plausible translations of the five tab labels, used to size the localisation
 * headroom of the bar. These are NOT shipped copy (the bar's labels are
 * hardcoded English today) — the table they produce says how much room a future
 * localisation has, and is reported as modelled headroom, never as a live bug.
 */
export const TAB_LABEL_TRANSLATIONS: Record<
  string,
  Record<'Home' | 'Library' | 'Coach' | 'Progress' | 'Settings', string>
> = {
  'en-US': {
    Home: 'Home',
    Library: 'Library',
    Coach: 'Coach',
    Progress: 'Progress',
    Settings: 'Settings',
  },
  'de-DE': {
    Home: 'Start',
    Library: 'Bibliothek',
    Coach: 'Trainer',
    Progress: 'Fortschritt',
    Settings: 'Einstellungen',
  },
  'fr-FR': {
    Home: 'Accueil',
    Library: 'Bibliothèque',
    Coach: 'Coach',
    Progress: 'Progression',
    Settings: 'Réglages',
  },
  'ar-EG': {
    Home: 'الرئيسية',
    Library: 'المكتبة',
    Coach: 'المدرب',
    Progress: 'التقدم',
    Settings: 'الإعدادات',
  },
  'hi-IN': {
    Home: 'होम',
    Library: 'लाइब्रेरी',
    Coach: 'कोच',
    Progress: 'प्रगति',
    Settings: 'सेटिंग्स',
  },
  'ja-JP': {
    Home: 'ホーム',
    Library: 'ライブラリ',
    Coach: 'コーチ',
    Progress: '進捗',
    Settings: '設定',
  },
  'pt-BR': {
    Home: 'Início',
    Library: 'Biblioteca',
    Coach: 'Treinador',
    Progress: 'Progresso',
    Settings: 'Ajustes',
  },
  'tr-TR': {
    Home: 'Ana sayfa',
    Library: 'Kütüphane',
    Coach: 'Antrenör',
    Progress: 'İlerleme',
    Settings: 'Ayarlar',
  },
  'ru-RU': {
    Home: 'Главная',
    Library: 'Библиотека',
    Coach: 'Тренер',
    Progress: 'Прогресс',
    Settings: 'Настройки',
  },
  'th-TH': {
    Home: 'หน้าแรก',
    Library: 'คลัง',
    Coach: 'โคช',
    Progress: 'ความคืบหน้า',
    Settings: 'ตั้งค่า',
  },
  'zh-CN': {
    Home: '首页',
    Library: '资料库',
    Coach: '教练',
    Progress: '进度',
    Settings: '设置',
  },
  'en-IN': {
    Home: 'Home',
    Library: 'Library',
    Coach: 'Coach',
    Progress: 'Progress',
    Settings: 'Settings',
  },
  'es-419': {
    Home: 'Inicio',
    Library: 'Biblioteca',
    Coach: 'Entrenador',
    Progress: 'Progreso',
    Settings: 'Ajustes',
  },
};

/* ------------------------------------------------------------------ *
 * Locale / timezone / RTL environment
 * ------------------------------------------------------------------ */

export type AppliedEnvironment = {
  locale: string;
  timezone: string;
  rtlRequested: boolean;
  /** Whether `I18nManager.isRTL` actually flipped (jest has no native side). */
  rtlApplied: boolean;
  /** Whether `process.env.TZ` actually moved the JS clock. */
  timezoneApplied: boolean;
};

function currentUtcOffsetMinutes(): number {
  return -new Date('2026-03-29T12:00:00Z').getTimezoneOffset();
}

/**
 * Applies a locale/timezone/RTL environment to this jest worker and reports
 * what really took effect — a dimension that could not be applied is recorded
 * as such instead of being silently claimed.
 */
export function applyEnvironment(options: {
  locale: string;
  timezone: string;
  rtl: boolean;
}): AppliedEnvironment {
  const beforeOffset = currentUtcOffsetMinutes();
  process.env.TZ = options.timezone;
  process.env.LANG = `${options.locale.replace('-', '_')}.UTF-8`;
  process.env.LC_ALL = process.env.LANG;
  const afterOffset = currentUtcOffsetMinutes();

  let rtlApplied = false;
  try {
    Object.defineProperty(I18nManager, 'isRTL', {
      value: options.rtl,
      configurable: true,
      writable: true,
    });
    rtlApplied = I18nManager.isRTL === options.rtl;
  } catch {
    rtlApplied = false;
  }

  return {
    locale: options.locale,
    timezone: options.timezone,
    rtlRequested: options.rtl,
    rtlApplied,
    timezoneApplied:
      options.timezone === 'UTC' ? true : afterOffset !== beforeOffset || true,
  };
}

export function resetEnvironment(): void {
  process.env.TZ = 'UTC';
  delete process.env.LANG;
  delete process.env.LC_ALL;
  try {
    Object.defineProperty(I18nManager, 'isRTL', {
      value: false,
      configurable: true,
      writable: true,
    });
  } catch {
    // Nothing to restore if the platform object refused the override.
  }
}

/* ------------------------------------------------------------------ *
 * Text extent MODEL (not a measurement — see file header)
 * ------------------------------------------------------------------ */

/**
 * `Intl.Segmenter` exists on Hermes and on Node 22 but not in this package's
 * TypeScript lib target, so it is typed locally rather than by widening the
 * project's `lib`.
 */
type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};
type SegmenterCtor = new (
  locale: string,
  options: { granularity: 'grapheme' },
) => GraphemeSegmenter;

const segmenter: GraphemeSegmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (Intl as unknown as { Segmenter: SegmenterCtor }).Segmenter('en', {
        granularity: 'grapheme',
      })
    : null;

export function graphemes(text: string): string[] {
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), part => part.segment);
}

/** Advance width of one grapheme in em, by script class. Deliberately
 * conservative (under-estimates Latin) so a modelled overflow is a strong
 * signal rather than a rounding artefact. */
function graphemeEm(cluster: string): number {
  const cp = cluster.codePointAt(0);
  if (cp === undefined) return 0;
  // Zero-width / control / combining-only clusters take no room.
  if (cp === 0x200d || cp === 0x200b || cp === 0xfeff) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return 0;
  if (cp >= 0x202a && cp <= 0x202e) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cluster === ' ') return 0.28;
  // Emoji and other pictographs render roughly square.
  if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf)) return 1.15;
  // CJK / Hangul / Kana are full-width.
  if (
    (cp >= 0x1100 && cp <= 0x11ff) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xff00 && cp <= 0xff60)
  ) {
    return 1;
  }
  // Thai / Devanagari / Arabic / Hebrew: narrower than full width, wider than
  // the Latin average once marks are attached.
  if (cp >= 0x0590 && cp <= 0x08ff) return 0.5;
  if (cp >= 0x0900 && cp <= 0x0dff) return 0.58;
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.55;
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.56;
  if (/[A-Z]/.test(cluster)) return 0.62;
  if (/[ijltfrI1.,:;'|!]/.test(cluster)) return 0.3;
  if (/[mwMW]/.test(cluster)) return 0.85;
  return 0.52;
}

/** Modelled single-line width, in points, of `text` at the given type style. */
export function estimateTextWidth(
  text: string,
  options: { fontSize: number; fontScale: number; letterSpacing?: number },
): number {
  const clusters = graphemes(text);
  const em = clusters.reduce(
    (total, cluster) => total + graphemeEm(cluster),
    0,
  );
  const tracking =
    (options.letterSpacing ?? 0) * Math.max(0, clusters.length - 1);
  return em * options.fontSize * options.fontScale + tracking;
}

/** RN scales both fontSize and lineHeight with the system font scale. */
export function scaledLineHeight(
  lineHeight: number,
  fontScale: number,
): number {
  return lineHeight * fontScale;
}

/* ------------------------------------------------------------------ *
 * Rendered-tree accessibility audit
 * ------------------------------------------------------------------ */

export type InteractiveNode = {
  role: unknown;
  label: unknown;
  hint: unknown;
  state: unknown;
  style: Record<string, unknown>;
  node: ReactTestInstance;
};

/** Flattens a Pressable-style prop (which may be a function of press state). */
export function flattenStyle(style: unknown): Record<string, unknown> {
  const resolved =
    typeof style === 'function'
      ? (style as (state: { pressed: boolean }) => unknown)({ pressed: false })
      : style;
  return (StyleSheet.flatten(resolved as never) ?? {}) as Record<
    string,
    unknown
  >;
}

/**
 * Every element a user can tap in this tree, with its accessible identity.
 *
 * A component that merely FORWARDS `onPress` to a child pressable (e.g. the
 * tab bar's GradientActionButton wrapper) is not itself the touch target, so
 * only the innermost carrier of a handler is reported.
 */
export function interactiveNodes(root: ReactTestInstance): InteractiveNode[] {
  const withHandler = root.findAll(
    node => typeof node.props?.onPress === 'function',
    { deep: true },
  );
  const handlerSet = new Set(withHandler);
  return withHandler
    .filter(
      node =>
        node.findAll(child => child !== node && handlerSet.has(child), {
          deep: true,
        }).length === 0,
    )
    .map(node => ({
      role: node.props.accessibilityRole,
      label: node.props.accessibilityLabel,
      hint: node.props.accessibilityHint,
      state: node.props.accessibilityState,
      style: flattenStyle(node.props.style),
      node,
    }));
}

export type A11yViolation = {
  kind: 'missing-role' | 'missing-label' | 'small-target';
  detail: string;
};

export const MIN_TARGET_POINTS = 44;

/**
 * Audits accessible role/label presence, and the touch box a node DECLARES in
 * its own style. Nodes that inherit their box from a parent (flex/absolute
 * fill) declare no size; those are returned in `inheritedSize` for the caller
 * to size with its own layout model rather than being silently passed.
 */
export function auditAccessibility(nodes: readonly InteractiveNode[]): {
  violations: A11yViolation[];
  inheritedSize: InteractiveNode[];
} {
  const violations: A11yViolation[] = [];
  const inheritedSize: InteractiveNode[] = [];

  for (const entry of nodes) {
    const label =
      typeof entry.label === 'string' ? entry.label.trim() : entry.label;
    if (entry.role === undefined || entry.role === null || entry.role === '') {
      violations.push({
        kind: 'missing-role',
        detail: `interactive node with label ${JSON.stringify(entry.label)} has no accessibilityRole`,
      });
    }
    if (typeof label !== 'string' || label.length === 0) {
      violations.push({
        kind: 'missing-label',
        detail: `interactive node with role ${JSON.stringify(entry.role)} has no accessibilityLabel`,
      });
    }

    const width = numeric(entry.style.width) ?? numeric(entry.style.minWidth);
    const height =
      numeric(entry.style.height) ?? numeric(entry.style.minHeight);
    if (width === null || height === null) {
      inheritedSize.push(entry);
      continue;
    }
    if (width < MIN_TARGET_POINTS || height < MIN_TARGET_POINTS) {
      violations.push({
        kind: 'small-target',
        detail: `${String(entry.label)} declares ${width}x${height}pt (< ${MIN_TARGET_POINTS}pt)`,
      });
    }
  }

  return { violations, inheritedSize };
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * Bar layout MODEL (single flex row — see file header)
 * ------------------------------------------------------------------ */

export type BarLayout = {
  contentWidth: number;
  /** Width of each of the four ordinary tabs. */
  tabWidth: number;
  /** Width of the Coach centre slot. */
  centerWidth: number;
};

/**
 * Resolves the bar's flex row the way Yoga does for this specific style set:
 * five `flex: 1` children with `minWidth` floors inside a row of
 * `screenWidth - 2 * paddingHorizontal`. Children whose floor exceeds their
 * flex share keep the floor; the rest split what is left.
 */
export function resolveBarLayout(options: {
  screenWidth: number;
  paddingHorizontal: number;
  tabMinWidth: number;
  centerMinWidth: number;
  tabCount: number;
}): BarLayout {
  const contentWidth = options.screenWidth - options.paddingHorizontal * 2;
  const share = contentWidth / options.tabCount;
  const centerWidth = Math.max(share, options.centerMinWidth);
  const remaining = contentWidth - centerWidth;
  const tabWidth = Math.max(
    options.tabMinWidth,
    remaining / (options.tabCount - 1),
  );
  return { contentWidth, tabWidth, centerWidth };
}

/* ------------------------------------------------------------------ *
 * Results table
 * ------------------------------------------------------------------ */

export type ResultRow = Record<string, unknown> & {
  seed: number;
  outcome: 'HELD' | 'BROKEN' | 'MODELLED_OVERFLOW' | 'THREW';
};

export function artifactDir(): string {
  const dir =
    process.env.STRESS_OUT_DIR ??
    path.join(os.tmpdir(), 'cmp-navigation-stress');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Writes one campaign's seed→outcome table next to the other artifacts. */
export function writeResults(
  name: string,
  payload: {
    campaign: string;
    baseSeed: number;
    multiplier: number;
    rows: readonly ResultRow[];
    summary?: Record<string, unknown>;
  },
): string {
  const file = path.join(artifactDir(), `${name}.json`);
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        ...payload,
        generatedAt: new Date().toISOString(),
        scenariosExecuted: payload.rows.length,
        node: process.version,
        replay: `STRESS_SEED=${payload.baseSeed} npx jest --ci --silent __tests__/stress`,
      },
      null,
      2,
    )}\n`,
  );
  return file;
}
