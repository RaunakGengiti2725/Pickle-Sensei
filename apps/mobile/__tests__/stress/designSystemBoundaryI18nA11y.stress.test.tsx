/**
 * STRESS — unit `cmp-design-system`, lens `boundary-i18n-a11y`.
 *
 * Seeded, replayable render campaign over `src/design` (components,
 * MascotMoment, BrandNotice, icons, tokens): every iteration derives ALL of
 * its inputs (component, string corpus/locale, numeric class, Dynamic Type
 * scale, viewport width, time zone) from one 32-bit seed, renders through
 * react-test-renderer, and records a seed → outcome row in a JSON table.
 *
 * What is PROVABLE on Linux (asserted):
 *  - rendering never throws and never logs a React/RN console error;
 *  - every supplied string survives verbatim into a Text node (no mangling of
 *    CJK, Arabic, ZWJ emoji, combining marks, German compounds, 200+ chars);
 *  - every interactive host node carries an accessibilityRole, a non-empty
 *    accessibilityLabel, and a ≥ 44 pt target (styles + hitSlop + a
 *    line-height model for content-sized rows);
 *  - no NaN / ±Infinity / negative geometry reaches an SVG primitive or a
 *    percentage style (garbage-in must not become undefined native input);
 *  - the rendered tree is identical across all 8 time zones for the same
 *    seed (the unit is time-zone independent).
 *
 * What is a MODEL (recorded per row, asserted in its own `it`, confirmed only
 * on the M4 runner): clipping / overlap. Calibrated against facebook/yoga
 * 3.2.1 (the flexbox engine RN embeds): a Text in a row is measured against
 * the space its fixed-size siblings leave, so it wraps rather than overflows
 * — it is only lost when that remaining space cannot hold even one grapheme.
 * A fixed-size box (ScoreRing: width = height = size) does NOT scale with
 * Dynamic Type while its numeral/caption line heights do, so the content
 * grows past the ring stroke. Widths use per-script glyph-advance estimates
 * (see `estimateTextWidth`).
 *
 * Run (default 300 iterations, ~seconds):
 *   cd apps/mobile && npx jest --ci __tests__/stress/designSystemBoundaryI18nA11y.stress.test.tsx
 * Scale up:            STRESS_ITER=2000
 * Replay exact seeds:  STRESS_SEEDS=123,456
 * Flake rate:          STRESS_SEEDS=123 STRESS_REPEAT=10
 * Rendered trees:      STRESS_TREES=1 (adds toJSON() per row — evidence dumps)
 * Artifacts:           STRESS_OUT=<dir> (default <rootDir>/artifacts/stress)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';
import {
  BrandDialog,
  BrandMark,
  BrandSpinner,
  BrandToggle,
  Button,
  CheckpointRow,
  EmptyState,
  ErrorState,
  LoadingState,
  Pill,
  ScoreRing,
  ScreenHeader,
  SectionTitle,
  Stat,
  TrendChart,
} from '../../src/design/components';
import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';
import {
  MASCOT_SOURCES,
  MascotMoment,
  MascotStage,
} from '../../src/design/MascotMoment';
import type { MascotPose, MascotTone } from '../../src/design/MascotMoment';
import { Icon, type IconName } from '../../src/design/icons';
import { space } from '../../src/design/tokens';

jest.mock('react-native-safe-area-context', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  return {
    SafeAreaView: (props: { children?: React.ReactNode }) =>
      ReactActual.createElement(View, null, props.children),
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    initialWindowMetrics: {
      frame: { x: 0, y: 0, width: 375, height: 667 },
      insets: { top: 0, bottom: 0, left: 0, right: 0 },
    },
  };
});
// SVG primitives become host Views tagged with `svgTag` and keep every prop so
// geometry (r, points, strokeDashoffset, width/height) is inspectable.
jest.mock('react-native-svg', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const tag = (name: string) => (props: Record<string, unknown>) =>
    ReactActual.createElement(View, { ...props, svgTag: name }, props.children);
  return {
    __esModule: true,
    default: tag('Svg'),
    Svg: tag('Svg'),
    Circle: tag('Circle'),
    Ellipse: tag('Ellipse'),
    G: tag('G'),
    Line: tag('Line'),
    Path: tag('Path'),
    Polygon: tag('Polygon'),
    Polyline: tag('Polyline'),
    Rect: tag('Rect'),
    Defs: tag('Defs'),
    LinearGradient: tag('LinearGradient'),
    Stop: tag('Stop'),
  };
});

// ───────────────────────────── seeded RNG ─────────────────────────────

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

function deriveSeed(base: number, i: number) {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ i, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
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
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from empty list');
    // Lists deliberately contain `undefined`/`null` members (prop omission).
    return items[this.int(items.length)] as T;
  }
  bool(p = 0.5) {
    return this.next() < p;
  }
}

// ───────────────────────────── corpus ─────────────────────────────

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

const LOCALE_SAMPLES: Record<Locale, readonly string[]> = {
  'de-DE': [
    'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
    'Donaudampfschifffahrtsgesellschaftskapitänsmützenhersteller',
    'Straßenbahnhaltestellenbeschilderung überprüfen',
  ],
  'fr-FR': [
    'Réglages d’accessibilité : élève œuvrant au cœur du jeu',
    'Aperçu de la trajectoire — à mi‑court',
  ],
  'ar-EG': [
    'مرحبًا بك في بيكل سينسي، مدرّب تقنية الدينك الخاص بك',
    'نتيجة التقنية ٧٫٥ من ١٠',
  ],
  'hi-IN': ['तकनीक स्कोर की प्रगति', 'क्षत्रिय ज्ञान और श्रद्धा'],
  'ja-JP': ['テクニックスコアの推移を確認する', 'ディンクの練習セット'],
  'pt-BR': ['Configurações de privacidade — ação necessária'],
  'tr-TR': ['İstanbul’da iğne ışığı diyaloğu', 'Kısıtlı ölçüm'],
  'ru-RU': ['Оценка техники за последнюю неделю'],
  'th-TH': ['คะแนนเทคนิคของคุณในสัปดาห์นี้', 'ตั้งค่าการเข้าถึง'],
  'zh-CN': ['技术评分趋势与练习计划', '隐私设置'],
  'en-IN': ['₹1,00,000 saved across 12 rallies'],
  'es-419': ['¿Configuración de accesibilidad? ¡Sí, ahora!'],
};

/** Real CTA / label copy shipped in apps/mobile/src (grep `label="…"`). */
const APP_COPY = [
  'Start your first read',
  'I already have an account',
  'Try again',
  'Continue',
  'Connect account',
  'Upgrade to Pro',
  'Open system settings',
  'Skip — pick automatically',
  'Re-analyze this stroke',
  'Use my feedback to improve scoring',
  'Rate Pickle Sensei',
  'Got it',
] as const;

const STRING_CLASSES = [
  'app-copy',
  'locale',
  'empty',
  'whitespace',
  'long-latin',
  'long-cjk',
  'long-german-compound',
  'rtl-arabic-long',
  'zwj-emoji',
  'combining-marks',
  'bidi-mixed',
  'newlines',
  'undefined-cast',
  'null-cast',
] as const;
type StringClass = (typeof STRING_CLASSES)[number];

function repeatTo(base: string, minLength: number) {
  let out = '';
  while (out.length < minLength) out += base;
  return out;
}

/** `null`/`undefined` are returned as-is (cast at the call site) to probe the
 * `string`-typed props with the values a defensive component must survive. */
function makeString(
  cls: StringClass,
  locale: Locale,
  rng: Rng,
): string | null | undefined {
  switch (cls) {
    case 'app-copy':
      return rng.pick(APP_COPY);
    case 'locale':
      return rng.pick(LOCALE_SAMPLES[locale]);
    case 'empty':
      return '';
    case 'whitespace':
      return '   \u00a0\u2009 ';
    case 'long-latin':
      return repeatTo('The quick brown fox jumps over the lazy dog. ', 260);
    case 'long-cjk':
      return repeatTo('技术评分趋势与练习计划テクニックスコア', 220);
    case 'long-german-compound':
      return repeatTo('Rindfleischetikettierungsüberwachungsaufgaben', 230);
    case 'rtl-arabic-long':
      return repeatTo('مرحبًا بك في بيكل سينسي مدرّب تقنية الدينك ', 240);
    case 'zwj-emoji':
      return repeatTo('👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍💻🧑🏿‍🦽', 48);
    case 'combining-marks':
      return 'Z\u0336\u0317\u0318\u0312a\u0321\u0319\u030bl\u0352g\u0300\u0305o\u0337 क्ष त्र ज्ञ श्र';
    case 'bidi-mixed':
      return 'Score 7.5 — النتيجة 7.5 — 評分 7.5 \u202eRTL override\u202c';
    case 'newlines':
      return 'Line one\nLine two\n\nLine four after blank';
    case 'undefined-cast':
      return undefined;
    case 'null-cast':
      return null;
  }
}

const NUMERIC_CLASSES = [
  0,
  -1,
  -7.25,
  1e-9,
  9.95,
  10,
  10.05,
  11,
  100,
  150,
  1e9,
  -1e9,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  null,
] as const;

const FONT_SCALES = [1, 1.235, 2.35] as const; // default, xxLarge, AX3
const WIDTHS = [320, 375, 430] as const; // SE-class, 6.1", Pro Max
const TIME_ZONES = [
  'Etc/GMT+12', // UTC−12
  'Pacific/Kiritimati', // UTC+14
  'Pacific/Pago_Pago', // UTC−11
  'America/New_York', // DST (US)
  'Europe/Berlin', // DST (EU)
  'Asia/Kolkata', // UTC+5:30
  'Australia/Lord_Howe', // 30-minute DST shift
  'Pacific/Chatham', // UTC+12:45 / +13:45
] as const;
/** Instants at DST edges — pinned as Date.now() so any hidden Date use in the
 * unit would surface as a tree difference across zones. */
const DST_EDGE_INSTANTS = [
  Date.UTC(2026, 2, 29, 0, 59, 59), // EU spring forward
  Date.UTC(2026, 9, 25, 1, 0, 0), // EU fall back
  Date.UTC(2026, 2, 8, 6, 59, 59), // US spring forward
  Date.UTC(2026, 10, 1, 6, 0, 0), // US fall back
] as const;

const COMPONENTS = [
  'Button',
  'BrandToggle',
  'ScreenHeader',
  'BrandDialog',
  'BrandNoticeHost',
  'MascotMoment',
  'MascotStage',
  'ScoreRing',
  'CheckpointRow',
  'TrendChart',
  'Pill',
  'Stat',
  'SectionTitle',
  'EmptyState',
  'ErrorState',
  'LoadingState',
  'BrandSpinner',
  'BrandMark',
  'Icon',
] as const;
type ComponentName = (typeof COMPONENTS)[number];

const ICON_NAMES: readonly IconName[] = [
  'home',
  'library',
  'progress',
  'settings',
  'plus',
  'camera',
  'upload',
  'court',
  'arrow',
  'chevron',
  'back',
  'close',
  'check',
  'pause',
  'play',
  'lock',
  'person',
  'volume',
  'shield',
  'flame',
  'bookmark',
  'crown',
  'spark',
  'star',
  'bell',
];

// ───────────────────────────── text width model ─────────────────────────────

/** Approximate advance (em) of one grapheme cluster by script. */
function graphemeEm(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (/^\s$/u.test(g)) return 0.28;
  if (/\p{Extended_Pictographic}/u.test(g)) return 1.25;
  if (cp >= 0x2e80 && cp <= 0x9fff) return 1.0; // CJK
  if (cp >= 0xac00 && cp <= 0xd7af) return 1.0; // Hangul
  if (cp >= 0xff00 && cp <= 0xffef) return 1.0; // fullwidth
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.55; // Arabic
  if (cp >= 0x0900 && cp <= 0x097f) return 0.65; // Devanagari
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.55; // Thai
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.58; // Cyrillic
  if (/\p{Lu}/u.test(g)) return 0.66;
  if (/\p{Nd}/u.test(g)) return 0.56;
  return 0.52; // Latin lowercase / punctuation
}

/** Grapheme-cluster approximation: combining marks, ZWJ, variation selectors,
 * skin-tone modifiers and anything joined by a ZWJ attach to the previous
 * cluster (so a family emoji is one cluster, Zalgo text is its base letters). */
function graphemes(text: string): string[] {
  const out: string[] = [];
  let joinNext = false;
  for (const cp of Array.from(text)) {
    const code = cp.codePointAt(0) ?? 0;
    const attaches =
      joinNext ||
      /\p{M}/u.test(cp) ||
      code === 0x200d ||
      code === 0xfe0f ||
      (code >= 0x1f3fb && code <= 0x1f3ff);
    if (attaches && out.length > 0) {
      out[out.length - 1] += cp;
    } else {
      out.push(cp);
    }
    joinNext = code === 0x200d;
  }
  return out;
}

/** Longest line width in points at `fontSize` (pre-scale). */
function estimateTextWidth(text: string, fontSize: number, scale: number) {
  const lines = text.split('\n');
  let widest = 0;
  for (const line of lines) {
    const em = graphemes(line).reduce((sum, g) => sum + graphemeEm(g), 0);
    widest = Math.max(widest, em * fontSize * scale);
  }
  return widest;
}

// ───────────────────────────── tree helpers ─────────────────────────────

type Style = Record<string, unknown>;

function flat(node: ReactTestInstance): Style {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Style;
}

function num(style: Style, key: string): number | undefined {
  const v = style[key];
  return typeof v === 'number' ? v : undefined;
}

function isHost(node: ReactTestInstance) {
  return typeof node.type === 'string';
}

function isTextHost(node: ReactTestInstance) {
  return (node.type as unknown) === 'Text';
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

function textOf(node: ReactTestInstance): string | null {
  if (!isTextHost(node)) return null;
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

function allTexts(root: ReactTestInstance): string[] {
  return root
    .findAll(n => isTextHost(n))
    .map(n => textOf(n))
    .filter((s): s is string => s !== null);
}

function isInteractive(node: ReactTestInstance) {
  const p = node.props as Record<string, unknown>;
  return (
    isHost(node) &&
    (typeof p.onClick === 'function' ||
      typeof p.onResponderRelease === 'function' ||
      typeof p.onStartShouldSetResponder === 'function')
  );
}

/** Parent chain (host nodes only), nearest first. */
function hostAncestors(node: ReactTestInstance): ReactTestInstance[] {
  const out: ReactTestInstance[] = [];
  let cur = node.parent;
  while (cur) {
    if (isHost(cur)) out.push(cur);
    cur = cur.parent;
  }
  return out;
}

// ───────────────────────────── height model (≥44 pt) ─────────────────────────────

function lineCount(
  text: string,
  fontSize: number,
  scale: number,
  width: number,
) {
  if (width <= 0) return 1;
  return text.split('\n').reduce((n, line) => {
    const w = estimateTextWidth(line, fontSize, 1) * scale;
    return n + Math.max(1, Math.ceil(w / width));
  }, 0);
}

function estimateHeight(
  node: ReactTestInstance,
  scale: number,
  width: number,
): number {
  const style = flat(node);
  const fixed = num(style, 'height');
  if (fixed !== undefined) return fixed;
  const padV =
    (num(style, 'paddingVertical') ?? num(style, 'padding') ?? 0) * 2 +
    (num(style, 'paddingTop') ?? 0) +
    (num(style, 'paddingBottom') ?? 0);
  const border =
    (num(style, 'borderWidth') ?? 0) * 2 +
    (num(style, 'borderTopWidth') ?? 0) +
    (num(style, 'borderBottomWidth') ?? 0);
  const marginV =
    (num(style, 'marginVertical') ?? 0) * 2 +
    (num(style, 'marginTop') ?? 0) +
    (num(style, 'marginBottom') ?? 0);
  let content = 0;
  if (isTextHost(node)) {
    const fontSize = num(style, 'fontSize') ?? 14;
    const lineHeight = num(style, 'lineHeight') ?? fontSize * 1.2;
    const text = textOf(node) ?? '';
    const lines =
      typeof node.props.numberOfLines === 'number'
        ? Math.min(
            node.props.numberOfLines,
            lineCount(text, fontSize, scale, width),
          )
        : lineCount(text, fontSize, scale, width);
    content = lineHeight * scale * Math.max(1, lines);
  } else {
    const kids = hostChildren(node).filter(
      k => !(StyleSheet.flatten(k.props.style) as Style | undefined)?.position,
    );
    const heights = kids.map(k => estimateHeight(k, scale, width));
    const gap = num(style, 'gap') ?? 0;
    content =
      style.flexDirection === 'row'
        ? Math.max(0, ...heights)
        : heights.reduce((a, b) => a + b, 0) +
          gap * Math.max(0, kids.length - 1);
  }
  const minH = num(style, 'minHeight') ?? 0;
  return Math.max(minH, content + padV + border) + marginV;
}

// ───────────────────────────── case generation ─────────────────────────────

interface Case {
  seed: number;
  component: ComponentName;
  locale: Locale;
  stringClass: StringClass;
  numeric: number | null;
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  timeZone: (typeof TIME_ZONES)[number];
  altTimeZone: (typeof TIME_ZONES)[number];
  dstInstant: number;
  variant: Record<string, unknown>;
  strings: string[];
  /** Strings that the component is documented to upper-case before display. */
  upperCased: string[];
  /** Strings exposed only through accessibilityLabel (no visible Text). */
  spokenOnly: string[];
  /** The primary string prop was '', whitespace, null or undefined. */
  primaryBlank: boolean;
  /** Any injected string prop was '', whitespace, null or undefined. */
  anyBlank: boolean;
  /** A nullish value was injected into some string-typed prop. */
  nullishInjected: boolean;
  element: React.ReactElement;
}

function asString(v: string | null | undefined) {
  return v as unknown as string;
}

function buildCase(seed: number): Case {
  const rng = new Rng(seed);
  const component = rng.pick(COMPONENTS);
  const locale = rng.pick(LOCALES);
  const stringClass = rng.pick(STRING_CLASSES);
  const numeric = rng.pick(NUMERIC_CLASSES);
  const fontScale = rng.pick(FONT_SCALES);
  const width = rng.pick(WIDTHS);
  const tzIndex = rng.int(TIME_ZONES.length);
  const timeZone = TIME_ZONES[tzIndex]!;
  const altTimeZone =
    TIME_ZONES[
      (tzIndex + 1 + rng.int(TIME_ZONES.length - 1)) % TIME_ZONES.length
    ]!;
  const dstInstant = rng.pick(DST_EDGE_INSTANTS);
  const s1 = makeString(stringClass, locale, rng);
  const s2 = makeString(rng.pick(STRING_CLASSES), locale, rng);
  const s3 = makeString(rng.pick(STRING_CLASSES), locale, rng);
  // Strings the component under test is documented to display verbatim.
  const strings: string[] = [];
  const visible = (...ss: (string | null | undefined)[]) => {
    for (const s of ss)
      if (typeof s === 'string' && s.length > 0) strings.push(s);
  };
  const upperCased: string[] = [];
  // Strings the component exposes ONLY through accessibilityLabel (no Text).
  const spokenOnly: string[] = [];
  const isBlank = (s: string | null | undefined) =>
    typeof s !== 'string' || s.trim().length === 0;
  const primaryBlank = isBlank(s1);
  const anyBlank = [s1, s2, s3].some(isBlank);
  const nullishInjected = [s1, s2, s3].some(s => s === null || s === undefined);
  const noop = () => {};

  let variant: Record<string, unknown> = {};
  let element: React.ReactElement;
  switch (component) {
    case 'Button': {
      const variantName = rng.pick([
        'primary',
        'secondary',
        'ghost',
        'danger',
        'volt',
        'dark',
      ] as const);
      const icon = rng.bool(0.4) ? rng.pick(ICON_NAMES) : undefined;
      const compact = rng.bool(0.3);
      const disabled = rng.bool(0.2);
      variant = { variantName, icon, compact, disabled };
      visible(s1);
      element = (
        <Button
          label={asString(s1)}
          onPress={noop}
          variant={variantName}
          icon={icon}
          compact={compact}
          disabled={disabled}
        />
      );
      break;
    }
    case 'BrandToggle': {
      const value = rng.bool();
      const disabled = rng.bool(0.2);
      variant = { value, disabled };
      if (typeof s1 === 'string' && s1.length > 0) spokenOnly.push(s1);
      element = (
        <BrandToggle
          label={asString(s1)}
          value={value}
          onValueChange={noop}
          disabled={disabled}
        />
      );
      break;
    }
    case 'ScreenHeader': {
      const action = rng.pick(['back', 'close', 'none'] as const);
      const dark = rng.bool();
      const withRight = rng.bool(0.4);
      variant = { action, dark, withRight };
      visible(s1);
      if (withRight) visible(s3);
      if (typeof s2 === 'string' && s2.length > 0) {
        upperCased.push(s2);
      }
      element = (
        <ScreenHeader
          title={asString(s1)}
          eyebrow={asString(s2)}
          onBack={action === 'back' ? noop : undefined}
          onClose={action === 'close' ? noop : undefined}
          dark={dark}
          right={withRight ? <Pill label={asString(s3)} /> : undefined}
        />
      );
      break;
    }
    case 'BrandDialog': {
      const tone = rng.pick(['neutral', 'danger', 'success'] as const);
      const dismissible = rng.bool(0.6);
      const actionCount = rng.int(4);
      const duplicateLabels = actionCount > 1 && rng.bool(0.3);
      const actionLabels = Array.from({ length: actionCount }, (_, i) =>
        i === 0 || duplicateLabels ? asString(s3) : `${asString(s3)} ${i}`,
      );
      variant = { tone, dismissible, actionCount, duplicateLabels };
      visible(s1, s2);
      if (actionCount > 0) visible(s3);
      if (typeof s2 === 'string' && s2.length > 0) {
        upperCased.push(s2);
      }
      element = (
        <BrandDialog
          visible
          title={asString(s1)}
          detail={asString(s2)}
          eyebrow={asString(s2)}
          tone={tone}
          onDismiss={dismissible ? noop : undefined}
          actions={actionLabels.map((label, i) => ({
            label,
            onPress: noop,
            variant: i === 0 ? 'primary' : 'secondary',
            disabled: i === 2,
          }))}
        />
      );
      break;
    }
    case 'BrandNoticeHost': {
      const tone = rng.pick([
        'neutral',
        'danger',
        'success',
        undefined,
      ] as const);
      const customAction = rng.bool(0.5);
      variant = { tone, customAction };
      visible(s1, s2);
      if (typeof s3 === 'string' && s3.length > 0) {
        upperCased.push(s3);
      }
      showBrandNotice({
        title: asString(s1),
        detail: asString(s2),
        eyebrow: asString(s3),
        tone,
        actionLabel: customAction ? asString(s2) : undefined,
      });
      element = <BrandNoticeHost />;
      break;
    }
    case 'MascotMoment': {
      const pose = rng.pick(Object.keys(MASCOT_SOURCES) as MascotPose[]);
      const tone = rng.pick([
        'volt',
        'court',
        'warn',
        'danger',
      ] as MascotTone[]);
      const compact = rng.bool();
      const dark = rng.bool();
      const labeled = rng.bool();
      variant = { pose, tone, compact, dark, labeled };
      visible(s1, s2);
      element = (
        <MascotMoment
          pose={pose}
          tone={tone}
          compact={compact}
          dark={dark}
          eyebrow={asString(s1)}
          caption={asString(s2)}
          accessibilityLabel={labeled ? asString(s3) : undefined}
        />
      );
      break;
    }
    case 'MascotStage': {
      const pose = rng.pick(Object.keys(MASCOT_SOURCES) as MascotPose[]);
      const tone = rng.pick([
        'volt',
        'court',
        'warn',
        'danger',
      ] as MascotTone[]);
      const compact = rng.bool();
      const dark = rng.bool();
      variant = { pose, tone, compact, dark };
      element = (
        <MascotStage
          pose={pose}
          tone={tone}
          compact={compact}
          dark={dark}
          accessibilityLabel={asString(s1)}
        />
      );
      break;
    }
    case 'ScoreRing': {
      const size = rng.pick([154, 190, 96, 0, -20, 4000] as const);
      const dark = rng.bool();
      const labeled = rng.bool(0.7);
      variant = { size, dark, labeled };
      if (labeled) visible(s1);
      element = (
        <ScoreRing
          score={numeric}
          size={size}
          dark={dark}
          label={labeled ? asString(s1) : undefined}
        />
      );
      break;
    }
    case 'CheckpointRow': {
      const band = rng.pick(['green', 'yellow', 'red', 'unscored'] as const);
      const pressable = rng.bool();
      variant = { band, pressable };
      visible(s1);
      element = (
        <CheckpointRow
          name={asString(s1)}
          score={numeric}
          band={band}
          onPress={pressable ? noop : undefined}
        />
      );
      break;
    }
    case 'TrendChart': {
      const count = rng.pick([0, 1, 2, 3, 7, 60, 1000] as const);
      const points = Array.from({ length: count }, (_, i) =>
        i === 0 && numeric !== null ? numeric : rng.float() * 10,
      );
      const max = rng.pick([10, 0, -5, 100, undefined] as const);
      const chartWidth = rng.pick([310, 0, -10, 2000, undefined] as const);
      variant = { count, max, chartWidth, firstPoint: String(numeric) };
      element = (
        <TrendChart
          points={points}
          max={max}
          width={chartWidth}
          dark={rng.bool()}
        />
      );
      break;
    }
    case 'Pill': {
      const tone = rng.pick([
        'neutral',
        'good',
        'warn',
        'bad',
        'volt',
        'dark',
      ] as const);
      variant = { tone };
      visible(s1);
      element = <Pill label={asString(s1)} tone={tone} />;
      break;
    }
    case 'Stat': {
      const dark = rng.bool();
      const accent = rng.bool();
      variant = { dark, accent };
      // `value` is a string prop: the caller formats numbers, so only finite
      // numerics are meaningful input here.
      const value =
        numeric === null || !Number.isFinite(numeric)
          ? asString(s1)
          : String(numeric);
      visible(value, s2);
      element = (
        <Stat value={value} label={asString(s2)} dark={dark} accent={accent} />
      );
      break;
    }
    case 'SectionTitle': {
      const withRight = rng.bool(0.6);
      variant = { withRight };
      visible(s1);
      if (withRight) visible(s2);
      element = (
        <SectionTitle
          title={asString(s1)}
          dark={rng.bool()}
          right={
            withRight ? <Pill label={asString(s2)} tone="volt" /> : undefined
          }
        />
      );
      break;
    }
    case 'EmptyState': {
      const withAction = rng.bool();
      variant = { withAction };
      visible(s1, s2);
      if (withAction) visible(s3);
      element = (
        <EmptyState
          title={asString(s1)}
          body={asString(s2)}
          dark={rng.bool()}
          action={
            withAction ? (
              <Button label={asString(s3)} onPress={noop} variant="secondary" />
            ) : undefined
          }
        />
      );
      break;
    }
    case 'ErrorState': {
      const withRetry = rng.bool(0.7);
      const customRetry = withRetry && rng.bool();
      variant = { withRetry, customRetry };
      visible(s1, s2);
      if (customRetry) visible(s3);
      element = (
        <ErrorState
          title={asString(s1)}
          detail={asString(s2)}
          dark={rng.bool()}
          onRetry={withRetry ? noop : undefined}
          retryLabel={customRetry ? asString(s3) : undefined}
        />
      );
      break;
    }
    case 'LoadingState': {
      variant = {};
      visible(s1);
      element = <LoadingState label={asString(s1)} dark={rng.bool()} />;
      break;
    }
    case 'BrandSpinner': {
      const size = rng.pick([24, 16, 0, -8, 400, undefined] as const);
      const labeled = rng.bool();
      variant = { size, labeled };
      element = (
        <BrandSpinner
          size={size}
          accessibilityLabel={labeled ? asString(s1) : undefined}
        />
      );
      break;
    }
    case 'BrandMark': {
      const compact = rng.bool(0.3);
      const light = rng.bool();
      const size = rng.pick([32, 0, -4, 512, undefined] as const);
      variant = { compact, light, size };
      element = <BrandMark compact={compact} light={light} size={size} />;
      break;
    }
    case 'Icon': {
      const name = rng.pick(ICON_NAMES);
      const size = rng.pick([18, 0, -6, 1e6, undefined] as const);
      const strokeWidth = rng.pick([1.75, 0, -1, undefined] as const);
      variant = { name, size, strokeWidth };
      element = <Icon name={name} size={size} strokeWidth={strokeWidth} />;
      break;
    }
  }

  return {
    seed,
    component,
    locale,
    stringClass,
    numeric,
    fontScale,
    width,
    timeZone,
    altTimeZone,
    dstInstant,
    variant,
    strings,
    upperCased,
    spokenOnly,
    primaryBlank,
    anyBlank,
    nullishInjected,
    element,
  };
}

// ───────────────────────────── checks ─────────────────────────────

interface Issue {
  check:
    | 'throw'
    | 'console'
    | 'text-integrity'
    | 'a11y-role'
    | 'a11y-label'
    | 'a11y-label-blank-input'
    | 'a11y-target'
    | 'nullish-leak'
    | 'numeric-leak'
    | 'geometry'
    | 'tz-determinism'
    | 'model-clip'
    | 'model-overlap';
  detail: string;
  node?: string;
}

interface Row {
  seed: number;
  component: ComponentName;
  locale: Locale;
  stringClass: StringClass;
  numeric: string;
  fontScale: number;
  width: number;
  timeZone: string;
  altTimeZone: string;
  variant: Record<string, unknown>;
  outcome: 'HELD' | 'BROKEN' | 'MODEL_FLAG';
  issues: Issue[];
  /** Deliberate single-line truncation (numberOfLines={1}) on long input. */
  truncatedByDesign: string[];
  textNodes: number;
  interactiveNodes: number;
  /** Full host tree (react-test-renderer toJSON) when STRESS_TREES=1. */
  tree?: unknown;
}

function describeNode(node: ReactTestInstance) {
  const p = node.props as Record<string, unknown>;
  const style = flat(node);
  return JSON.stringify({
    type: node.type,
    svgTag: p.svgTag,
    accessibilityRole: p.accessibilityRole,
    accessibilityLabel: p.accessibilityLabel,
    accessible: p.accessible,
    numberOfLines: p.numberOfLines,
    hitSlop: p.hitSlop,
    style,
    text: textOf(node),
  });
}

/** Screen-level horizontal budget: page padding on both sides. */
function pageInnerWidth(width: number) {
  return width - 2 * space.lg;
}

function checkTree(
  root: ReactTestInstance,
  c: Case,
  issues: Issue[],
  truncated: string[],
) {
  // 1. Text integrity — every supplied non-empty string must be visible.
  const texts = allTexts(root);
  for (const s of c.strings) {
    const expectUpper = c.upperCased.includes(s);
    const ok = texts.some(t => t === s || t.includes(s));
    const okUpper = expectUpper && texts.some(t => t === s.toUpperCase());
    if (!ok && !okUpper) {
      issues.push({
        check: 'text-integrity',
        detail: `string of class ${c.stringClass} (${graphemes(s).length} graphemes) not found verbatim in any Text node`,
      });
    }
  }

  const labels = root
    .findAll(n => typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel as string);
  for (const s of c.spokenOnly) {
    if (!labels.some(l => l === s || l.includes(s))) {
      issues.push({
        check: 'text-integrity',
        detail: `string of class ${c.stringClass} (${graphemes(s).length} graphemes) not found verbatim in any accessibilityLabel`,
      });
    }
  }

  // 2. Interactive elements: role + label + ≥44pt.
  const interactives = root.findAll(isInteractive);
  for (const node of interactives) {
    const p = node.props as Record<string, unknown>;
    if (p.accessible === false) continue; // deliberate: dialog backdrop
    if (typeof p.accessibilityRole !== 'string') {
      issues.push({
        check: 'a11y-role',
        detail: 'interactive host node without accessibilityRole',
        node: describeNode(node),
      });
    }
    const label = p.accessibilityLabel;
    const hasText = allTexts(node).some(t => t.trim().length > 0);
    if (!(typeof label === 'string' && label.trim().length > 0) && !hasText) {
      issues.push({
        check: c.anyBlank ? 'a11y-label-blank-input' : 'a11y-label',
        detail: `interactive host node without accessibilityLabel and without text content (label prop class: ${c.stringClass})`,
        node: describeNode(node),
      });
    }
    const style = flat(node);
    const slop = p.hitSlop;
    const slopV = typeof slop === 'number' ? slop * 2 : 0;
    const slopH = slopV;
    const height =
      estimateHeight(node, c.fontScale, pageInnerWidth(c.width)) + slopV;
    const explicitWidth = num(style, 'width');
    const containerStyle =
      node.parent && isHost(node.parent) ? flat(node.parent) : {};
    const containerWidth = num(containerStyle, 'width');
    const stretches =
      explicitWidth === undefined &&
      (containerWidth === undefined || containerWidth >= 44 - slopH);
    const widthOk = stretches || (explicitWidth ?? 0) + slopH >= 44;
    if (height < 44 || !widthOk) {
      issues.push({
        check: 'a11y-target',
        detail: `target ${explicitWidth ?? containerWidth ?? 'stretch'}×${height.toFixed(1)} (incl. hitSlop) < 44`,
        node: describeNode(node),
      });
    }
  }

  // 2b. Injected garbage must not leak into copy or screen-reader labels.
  const spoken = [...texts, ...labels];
  if (c.nullishInjected) {
    for (const s of spoken) {
      if (/\b(undefined|null)\b/.test(s)) {
        issues.push({
          check: 'nullish-leak',
          detail: `"${s.slice(0, 80)}" contains the literal ${s.match(/undefined|null/)?.[0]}`,
        });
      }
    }
  }
  if (c.numeric !== null && !Number.isFinite(c.numeric)) {
    for (const s of spoken) {
      if (/NaN|Infinity/.test(s)) {
        issues.push({
          check: 'numeric-leak',
          detail: `"${s.slice(0, 80)}" shows ${s.match(/NaN|-?Infinity/)?.[0]} for score ${c.numeric}`,
        });
      }
    }
  }

  // 3. Geometry: no NaN/Infinity/negative reaching SVG or percent styles.
  for (const node of root.findAll(n => isHost(n))) {
    const p = node.props as Record<string, unknown>;
    if (typeof p.svgTag === 'string') {
      for (const key of [
        'r',
        'cx',
        'cy',
        'width',
        'height',
        'strokeWidth',
        'strokeDashoffset',
        'x1',
        'x2',
        'y1',
        'y2',
      ]) {
        const v = p[key];
        if (
          typeof v === 'number' &&
          (!Number.isFinite(v) || (key !== 'strokeDashoffset' && v < 0))
        ) {
          issues.push({
            check: 'geometry',
            detail: `<${p.svgTag} ${key}=${v}>`,
            node: describeNode(node),
          });
        }
      }
      if (typeof p.points === 'string' && /NaN|Infinity/.test(p.points)) {
        issues.push({
          check: 'geometry',
          detail: `<${p.svgTag} points> contains ${p.points.match(/NaN|-?Infinity/)?.[0]}`,
          node: describeNode(node),
        });
      }
      const animated = p.animatedProps as
        { strokeDashoffset?: number } | undefined;
      if (
        animated &&
        typeof animated.strokeDashoffset === 'number' &&
        !Number.isFinite(animated.strokeDashoffset)
      ) {
        issues.push({
          check: 'geometry',
          detail: `<${p.svgTag} animatedProps.strokeDashoffset=${animated.strokeDashoffset}>`,
          node: describeNode(node),
        });
      }
    }
    const style = flat(node);
    for (const [key, v] of Object.entries(style)) {
      if (
        typeof v === 'string' &&
        /%$/.test(v) &&
        !/^-?\d+(\.\d+)?%$/.test(v)
      ) {
        issues.push({
          check: 'geometry',
          detail: `style.${key}="${v}" is not a finite percentage`,
          node: describeNode(node),
        });
      }
      if (typeof v === 'number' && !Number.isFinite(v)) {
        issues.push({
          check: 'geometry',
          detail: `style.${key}=${v}`,
          node: describeNode(node),
        });
      }
    }
  }

  // 4. Layout model — Text in a row beside fixed-size siblings. Yoga
  // measures the Text against the space the siblings leave (verified with
  // facebook/yoga 3.2.1: a 2-line label + 18pt arrow never overflows the
  // Button row at 320pt/AX3), so the text is only lost when that space
  // cannot hold its widest grapheme — then iOS spills it and an
  // `overflow: 'hidden'` ancestor clips it.
  const textNodes = root.findAll(n => isTextHost(n));
  for (const node of textNodes) {
    const text = textOf(node) ?? '';
    if (text.length === 0) continue;
    const style = flat(node);
    const fontSize = num(style, 'fontSize') ?? 14;
    if (typeof node.props.numberOfLines === 'number') {
      const est = estimateTextWidth(text, fontSize, c.fontScale);
      if (est > pageInnerWidth(c.width)) truncated.push(text.slice(0, 40));
      continue;
    }
    const shrink = num(style, 'flexShrink') ?? 0;
    const flex = num(style, 'flex') ?? 0;
    if (shrink > 0 || flex > 0) continue;
    const parent = node.parent;
    if (!parent) continue;
    const rowParent = hostAncestors(node).find(
      a => flat(a).flexDirection === 'row',
    );
    if (!rowParent) continue;
    // Only rows where this Text is a direct host child with siblings matter.
    const rowKids = hostChildren(rowParent).filter(
      k => !(flat(k).position === 'absolute'),
    );
    if (!rowKids.includes(node) || rowKids.length < 2) continue;
    const rowStyle = flat(rowParent);
    const rowPad =
      (num(rowStyle, 'paddingHorizontal') ?? num(rowStyle, 'padding') ?? 0) * 2;
    const gap = (num(rowStyle, 'gap') ?? 0) * (rowKids.length - 1);
    // Siblings with flex/flexShrink give way (Yoga shrinks them first), so
    // they contribute nothing to the fixed width this Text must fit beside.
    const siblingWidths = rowKids
      .filter(k => k !== node)
      .map(k => {
        const ks = flat(k);
        if ((num(ks, 'flex') ?? 0) > 0 || (num(ks, 'flexShrink') ?? 0) > 0) {
          return 0;
        }
        const w = num(ks, 'width');
        if (w !== undefined) return w;
        const kt = textOf(k);
        if (kt !== null) {
          const kfs = num(ks, 'fontSize') ?? 14;
          return Math.min(
            estimateTextWidth(kt, kfs, c.fontScale),
            pageInnerWidth(c.width) / 2,
          );
        }
        const svgW = (k.props as Record<string, unknown>).width;
        return typeof svgW === 'number' ? svgW : 24;
      })
      .reduce((a, b) => a + b, 0);
    const inner = pageInnerWidth(c.width) - rowPad;
    const remaining = inner - siblingWidths - gap;
    const widestGrapheme = graphemes(text)
      .map(g => estimateTextWidth(g, fontSize, c.fontScale))
      .reduce((a, b) => Math.max(a, b), 0);
    if (remaining + 0.5 < widestGrapheme) {
      const clippedBy = hostAncestors(node).find(
        a => flat(a).overflow === 'hidden',
      );
      issues.push({
        check: 'model-clip',
        detail: `${clippedBy ? 'CLIPPED' : 'OVERFLOWS'} row: siblings ${siblingWidths.toFixed(0)} + gap ${gap} leave ${remaining.toFixed(0)}pt of inner ${inner.toFixed(0)} < widest grapheme ${widestGrapheme.toFixed(0)}pt @ scale ${c.fontScale}, width ${c.width}${clippedBy ? ' (ancestor overflow:hidden)' : ''}`,
        node: describeNode(node),
      });
    }
  }

  // 5. ScoreRing numeral vs ring inner diameter (overlap model).
  if (c.component === 'ScoreRing') {
    const size = c.variant.size as number;
    if (size > 0) {
      const stroke = Math.max(8, size * 0.065);
      const innerDiameter = size - 2 * stroke;
      const numeral = textNodes.find(n => {
        const s = flat(n);
        return num(s, 'fontSize') === size * 0.29;
      });
      const text = numeral ? (textOf(numeral) ?? '') : '';
      if (numeral && text) {
        const est = estimateTextWidth(text, size * 0.29, c.fontScale);
        if (est > innerDiameter) {
          issues.push({
            check: 'model-overlap',
            detail: `numeral "${text}" ≈${est.toFixed(0)}pt wide > ring inner ${innerDiameter.toFixed(0)}pt @ scale ${c.fontScale} (size ${size})`,
            node: describeNode(numeral),
          });
        }
        // RN scales lineHeight with fontScale; the box (width = height =
        // size) does not. Numeral + caption line heights stacked in a
        // `justifyContent: 'center'` column must fit inside the stroke.
        const caption = textNodes.find(n => n !== numeral);
        const captionLh =
          caption === undefined
            ? 0
            : (num(flat(caption), 'lineHeight') ?? 18) * c.fontScale;
        const stack = size * 0.33 * c.fontScale + captionLh;
        if (stack > innerDiameter + 0.5) {
          issues.push({
            check: 'model-overlap',
            detail: `numeral + caption line heights ≈${stack.toFixed(0)}pt tall > ring inner ${innerDiameter.toFixed(0)}pt @ scale ${c.fontScale} (size ${size})`,
            node: describeNode(numeral),
          });
        }
      }
    }
  }
}

// ───────────────────────────── runner ─────────────────────────────

function withEnvironment<T>(tz: string, nowMs: number, fn: () => T): T {
  const prevTz = process.env.TZ;
  const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    nowSpy.mockRestore();
    if (prevTz === undefined) delete process.env.TZ;
    else process.env.TZ = prevTz;
  }
}

function renderOnce(
  c: Case,
  tz: string,
): {
  renderer: ReactTestRenderer | null;
  error: string | null;
  consoleErrors: string[];
} {
  const consoleErrors: string[] = [];
  const errSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' '),
      );
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' '),
      );
    });
  let renderer: ReactTestRenderer | null = null;
  let error: string | null = null;
  try {
    withEnvironment(tz, c.dstInstant, () => {
      act(() => {
        renderer = TestRenderer.create(c.element);
      });
    });
  } catch (e) {
    error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  } finally {
    errSpy.mockRestore();
    warnSpy.mockRestore();
  }
  return { renderer, error, consoleErrors };
}

function runCase(seed: number): Row {
  const c = buildCase(seed);
  const issues: Issue[] = [];
  const truncated: string[] = [];
  let textNodes = 0;
  let interactiveNodes = 0;
  let tree: unknown;

  const primary = renderOnce(c, c.timeZone);
  if (primary.error) {
    issues.push({ check: 'throw', detail: primary.error });
  }
  for (const msg of primary.consoleErrors) {
    issues.push({ check: 'console', detail: msg.slice(0, 400) });
  }
  if (primary.renderer) {
    const root = primary.renderer.root;
    textNodes = root.findAll(n => isTextHost(n)).length;
    interactiveNodes = root.findAll(isInteractive).length;
    checkTree(root, c, issues, truncated);
    const primaryJson = JSON.stringify(primary.renderer.toJSON());
    if (process.env.STRESS_TREES === '1') tree = JSON.parse(primaryJson);
    // Unmount first: BrandNoticeHost registers a module-level presenter, and
    // the replay must re-queue its notice for a fresh host, not the old one.
    act(() => primary.renderer?.unmount());

    // Time-zone independence: same seed under a different zone → same tree.
    const replay = buildCase(seed);
    const secondary = renderOnce(replay, c.altTimeZone);
    if (secondary.error) {
      issues.push({
        check: 'throw',
        detail: `alt tz ${c.altTimeZone}: ${secondary.error}`,
      });
    } else if (secondary.renderer) {
      const b = JSON.stringify(secondary.renderer.toJSON());
      if (primaryJson !== b) {
        issues.push({
          check: 'tz-determinism',
          detail: `tree differs between ${c.timeZone} and ${c.altTimeZone}`,
        });
      }
      act(() => secondary.renderer?.unmount());
    }
  }

  // The same defect is often visible through several nodes; keep one per
  // (check, detail) so the seed table stays readable.
  const seen = new Set<string>();
  const deduped = issues.filter(i => {
    const k = `${i.check}|${i.detail}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  issues.length = 0;
  issues.push(...deduped);

  const hard = issues.some(i => !i.check.startsWith('model-'));
  return {
    seed,
    component: c.component,
    locale: c.locale,
    stringClass: c.stringClass,
    numeric: String(c.numeric),
    fontScale: c.fontScale,
    width: c.width,
    timeZone: c.timeZone,
    altTimeZone: c.altTimeZone,
    variant: c.variant,
    outcome: hard ? 'BROKEN' : issues.length > 0 ? 'MODEL_FLAG' : 'HELD',
    issues,
    truncatedByDesign: truncated,
    textNodes,
    interactiveNodes,
    ...(tree === undefined ? {} : { tree }),
  };
}

const DEFAULT_ITER = 300;
const baseSeed = Number(process.env.STRESS_SEED ?? 20260904);
const iterations = Math.max(1, Number(process.env.STRESS_ITER ?? DEFAULT_ITER));
const repeat = Math.max(1, Number(process.env.STRESS_REPEAT ?? 1));
const explicitSeeds = (process.env.STRESS_SEEDS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const seeds =
  explicitSeeds.length > 0
    ? explicitSeeds
    : Array.from({ length: iterations }, (_, i) => deriveSeed(baseSeed, i));
const outDir =
  process.env.STRESS_OUT ??
  path.join(__dirname, '..', '..', 'artifacts', 'stress');

const rows: Row[] = [];

function summarize(rowsIn: Row[]) {
  const byOutcome: Record<string, number> = {};
  const byCheck: Record<string, number> = {};
  const byComponent: Record<
    string,
    { rendered: number; broken: number; flagged: number }
  > = {};
  for (const r of rowsIn) {
    byOutcome[r.outcome] = (byOutcome[r.outcome] ?? 0) + 1;
    const comp = (byComponent[r.component] ??= {
      rendered: 0,
      broken: 0,
      flagged: 0,
    });
    comp.rendered += 1;
    if (r.outcome === 'BROKEN') comp.broken += 1;
    if (r.outcome === 'MODEL_FLAG') comp.flagged += 1;
    for (const i of r.issues) byCheck[i.check] = (byCheck[i.check] ?? 0) + 1;
  }
  return { byOutcome, byCheck, byComponent };
}

beforeAll(() => {
  for (const seed of seeds) {
    for (let k = 0; k < repeat; k += 1) rows.push(runCase(seed));
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(outDir, `design-boundary-i18n-a11y-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        unit: 'cmp-design-system',
        lens: 'boundary-i18n-a11y',
        node: process.version,
        platform: `${os.platform()} ${os.arch()}`,
        baseSeed,
        iterations: rows.length,
        distinctSeeds: new Set(rows.map(r => r.seed)).size,
        rendersPerIteration: 2,
        dimensions: {
          components: COMPONENTS,
          locales: LOCALES,
          stringClasses: STRING_CLASSES,
          numericClasses: NUMERIC_CLASSES.map(String),
          fontScales: FONT_SCALES,
          widths: WIDTHS,
          timeZones: TIME_ZONES,
          dstEdgeInstants: DST_EDGE_INSTANTS.map(t =>
            new Date(t).toISOString(),
          ),
        },
        summary: summarize(rows),
        rows,
      },
      null,
      2,
    ),
  );
  console.log(`[stress] ${rows.length} iterations → ${file}`);
});

describe('design system boundary/i18n/a11y stress campaign', () => {
  const failing = (check: Issue['check']) =>
    rows
      .filter(r => r.issues.some(i => i.check === check))
      .map(r => ({
        seed: r.seed,
        component: r.component,
        stringClass: r.stringClass,
        numeric: r.numeric,
        fontScale: r.fontScale,
        width: r.width,
        issues: r.issues.filter(i => i.check === check).map(i => i.detail),
      }));

  it('ran the campaign at scale with every dimension exercised', () => {
    expect(rows.length).toBeGreaterThanOrEqual(
      explicitSeeds.length > 0 ? 1 : 150,
    );
    if (explicitSeeds.length === 0 && iterations >= DEFAULT_ITER) {
      const components = new Set(rows.map(r => r.component));
      expect([...components].sort()).toEqual([...COMPONENTS].sort());
      expect(new Set(rows.map(r => r.locale)).size).toBe(LOCALES.length);
      expect(new Set(rows.map(r => r.fontScale)).size).toBe(FONT_SCALES.length);
      expect(new Set(rows.map(r => r.width)).size).toBe(WIDTHS.length);
      expect(new Set(rows.map(r => r.timeZone)).size).toBe(TIME_ZONES.length);
      expect(new Set(rows.map(r => r.stringClass)).size).toBe(
        STRING_CLASSES.length,
      );
    }
  });

  it('never throws while rendering any boundary variant', () => {
    expect(failing('throw')).toEqual([]);
  });

  it('never logs a React/RN console error or warning while rendering', () => {
    expect(failing('console')).toEqual([]);
  });

  it('keeps every supplied string verbatim in a Text node', () => {
    expect(failing('text-integrity')).toEqual([]);
  });

  it('gives every interactive element an accessibilityRole', () => {
    expect(failing('a11y-role')).toEqual([]);
  });

  it('gives every interactive element an accessible label or text', () => {
    expect(failing('a11y-label')).toEqual([]);
  });

  it('keeps interactive elements labeled when the label prop is blank/nullish', () => {
    expect(failing('a11y-label-blank-input')).toEqual([]);
  });

  it('never speaks or shows the literals "undefined"/"null" for nullish string props', () => {
    expect(failing('nullish-leak')).toEqual([]);
  });

  it('never speaks or shows NaN/Infinity for non-finite scores', () => {
    expect(failing('numeric-leak')).toEqual([]);
  });

  it('gives every interactive element a ≥44pt target at every scale/width', () => {
    expect(failing('a11y-target')).toEqual([]);
  });

  it('never passes NaN/Infinity/negative geometry to SVG or percentage styles', () => {
    expect(failing('geometry')).toEqual([]);
  });

  it('renders an identical tree in every time zone for the same seed', () => {
    expect(failing('tz-determinism')).toEqual([]);
  });

  it('layout model: every row leaves its text room for at least one grapheme', () => {
    expect(failing('model-clip')).toEqual([]);
  });

  it('layout model: the ScoreRing numeral and caption stay inside the ring', () => {
    expect(failing('model-overlap')).toEqual([]);
  });
});
