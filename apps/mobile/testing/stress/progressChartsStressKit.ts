/**
 * Shared kit for the `cmp-progress-charts` boundary / i18n / a11y stress
 * suites (`__tests__/stress/progressCharts*.stress.test.tsx`).
 *
 * Everything here is deterministic: a scenario is fully determined by its
 * seed, so any row of the emitted JSON table can be replayed with
 * `STRESS_SEED=<seed> npx jest --ci progressChartsBoundaryI18nA11y`.
 *
 * Two classes of checks exist and the result table keeps them apart:
 * - VERIFIED: facts read from the rendered React tree (crash-freedom,
 *   accessibility props, text content, geometry emitted as style props).
 * - INFERRED (`layout-model`): arithmetic over the emitted style props plus
 *   a glyph-width heuristic. react-test-renderer has no Yoga, so nothing
 *   here measures real pixels — the model only flags cases where the
 *   component's own fixed constants cannot fit the scaled text.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — small, fast, replayable.
// ---------------------------------------------------------------------------

export interface Rng {
  readonly seed: number;
  next(): number;
  int(minInclusive: number, maxInclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(probability: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

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
    int(minInclusive, maxInclusive) {
      return (
        minInclusive + Math.floor(next() * (maxInclusive - minInclusive + 1))
      );
    },
    pick(items) {
      if (items.length === 0) throw new Error('pick() on empty list');
      return items[Math.floor(next() * items.length)]!;
    },
    chance(probability) {
      return next() < probability;
    },
    shuffle(items) {
      const out = [...items];
      for (let index = out.length - 1; index > 0; index -= 1) {
        const swap = Math.floor(next() * (index + 1));
        const tmp = out[index]!;
        out[index] = out[swap]!;
        out[swap] = tmp;
      }
      return out;
    },
  };
}

/** Campaign size: small default so the suite stays fast; STRESS_ITER scales it. */
export function campaignIterations(defaultCount: number): number {
  const raw = process.env.STRESS_ITER;
  if (!raw) return defaultCount;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`STRESS_ITER must be a positive integer, got ${raw}`);
  }
  return parsed;
}

/** Replay a single seed (STRESS_SEED=<n>) instead of the whole campaign. */
export function replaySeed(): number | null {
  const raw = process.env.STRESS_SEED;
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`STRESS_SEED must be an integer, got ${raw}`);
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// String corpus — every class the lens names, all ≥ 1 sample of ≥ 200 chars.
// ---------------------------------------------------------------------------

export type StringClass =
  | 'empty'
  | 'whitespace'
  | 'ascii'
  | 'long-ascii'
  | 'cjk'
  | 'long-cjk'
  | 'arabic-rtl'
  | 'long-arabic-rtl'
  | 'hebrew-rtl'
  | 'zwj-emoji'
  | 'combining-marks'
  | 'german-compound'
  | 'thai-no-spaces'
  | 'devanagari'
  | 'cyrillic'
  | 'turkish-dotted'
  | 'bidi-controls'
  | 'unbroken-token'
  | 'mixed-script';

const ZWJ = '\u200d';
const FAMILY = `👨${ZWJ}👩${ZWJ}👧${ZWJ}👦`;
const FLAGS = '🏳️‍🌈🇩🇪🇯🇵🇧🇷🇮🇳🇸🇦';
const COMBINING =
  'Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319\u0324\u031e\u0349\u035a\u032f\u031e\u0320\u034dA\u036b\u0357\u0334\u0362\u0335\u031c\u0330\u0354L\u0368\u0367\u0369\u0358\u0320G\u0311\u0357\u030e\u0305\u035b\u0341\u0334\u033b\u0348\u034d\u0354\u0339O\u0342\u030c\u030c\u0358\u0328\u0335\u0339\u033b\u031d\u0333';
const GERMAN =
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft Kraftfahrzeughaftpflichtversicherung';
const ARABIC =
  'تحليل حركة الضربة الأمامية في كرة البيكل مع تقييم وضعية الجسم والتوازن والاتصال بالكرة';
const HEBREW = 'ניתוח תנועת מחבט בפיקלבול עם ציון טכניקה';
const CJK =
  '正手击球技术分析：身体姿态、重心转移、击球点与随挥动作的评估报告，包含每次挥拍的分数与趋势。';
const JAPANESE =
  'フォアハンドドライブの技術分析：姿勢・体重移動・打点・フォロースルーの評価と各スイングのスコア推移。';
const THAI =
  'การวิเคราะห์เทคนิคการตีลูกโฟร์แฮนด์ในกีฬาพิกเกิลบอลพร้อมคะแนนและแนวโน้มของแต่ละครั้ง';
const DEVANAGARI =
  'फोरहैंड ड्राइव तकनीक विश्लेषण: शरीर की मुद्रा, भार स्थानांतरण, संपर्क बिंदु और फॉलो-थ्रू का मूल्यांकन।';
const CYRILLIC =
  'Анализ техники удара форхенд: положение тела, перенос веса, точка контакта и завершение движения с оценкой каждого удара.';
const TURKISH = 'İSTANBUL ışık ılık DİNK VURUŞU ÇALIŞMASI ŞİŞLİ ĞÜNEŞ';
const BIDI =
  '\u202eDNIK\u202c \u2067ضربة\u2069 \u200fdink\u200e \u2066AB\u2069';

function repeatTo(base: string, minLength: number): string {
  let out = base;
  while (out.length < minLength) out += ` ${base}`;
  return out;
}

export const STRING_CLASSES: readonly StringClass[] = [
  'empty',
  'whitespace',
  'ascii',
  'long-ascii',
  'cjk',
  'long-cjk',
  'arabic-rtl',
  'long-arabic-rtl',
  'hebrew-rtl',
  'zwj-emoji',
  'combining-marks',
  'german-compound',
  'thai-no-spaces',
  'devanagari',
  'cyrillic',
  'turkish-dotted',
  'bidi-controls',
  'unbroken-token',
  'mixed-script',
];

export function stringFor(cls: StringClass, rng: Rng): string {
  switch (cls) {
    case 'empty':
      return '';
    case 'whitespace':
      return rng.pick([' ', '   ', '\t', '\n', '\u00a0', '\u3000']);
    case 'ascii':
      return rng.pick(['7 days', '4 weeks', '90 days', 'CAPTURES', 'Aug 30']);
    case 'long-ascii':
      return repeatTo(
        'Forehand drive technique window with body posture, weight transfer, contact point and follow-through review',
        200 + rng.int(0, 120),
      );
    case 'cjk':
      return rng.pick([CJK, JAPANESE, '正手', 'スコア']);
    case 'long-cjk':
      return repeatTo(rng.pick([CJK, JAPANESE]), 200 + rng.int(0, 120));
    case 'arabic-rtl':
      return rng.pick([ARABIC, 'ضربة', '٩٠ يومًا']);
    case 'long-arabic-rtl':
      return repeatTo(ARABIC, 200 + rng.int(0, 120));
    case 'hebrew-rtl':
      return HEBREW;
    case 'zwj-emoji':
      return repeatTo(`${FAMILY} ${FLAGS} 🏓${ZWJ}🥒`, rng.int(8, 260));
    case 'combining-marks':
      return repeatTo(COMBINING, rng.int(40, 260));
    case 'german-compound':
      return repeatTo(GERMAN, rng.int(60, 260));
    case 'thai-no-spaces':
      return repeatTo(THAI, rng.int(40, 260)).replace(/ /g, '');
    case 'devanagari':
      return repeatTo(DEVANAGARI, rng.int(40, 260));
    case 'cyrillic':
      return repeatTo(CYRILLIC, rng.int(40, 260));
    case 'turkish-dotted':
      return TURKISH;
    case 'bidi-controls':
      return BIDI;
    case 'unbroken-token':
      return 'W'.repeat(200 + rng.int(0, 100));
    case 'mixed-script':
      return `${CJK.slice(0, 12)} ${ARABIC.slice(0, 12)} ${FAMILY} ${COMBINING.slice(0, 20)} ${GERMAN.slice(0, 30)} Aug 30`;
    default: {
      const exhaustive: never = cls;
      throw new Error(`unknown string class ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Locale / timezone corpus.
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

export interface TimeZoneCase {
  zone: string;
  /** Why the zone is in the matrix. */
  note: string;
  /** UTC instants worth landing captures around (DST edges, day rollovers). */
  edgesIso: readonly string[];
}

export const TIME_ZONES: readonly TimeZoneCase[] = [
  {
    zone: 'Pacific/Kiritimati',
    note: 'UTC+14 — furthest ahead of UTC, no DST',
    edgesIso: ['2026-09-04T10:00:00.000Z', '2026-12-31T10:00:00.000Z'],
  },
  {
    zone: 'Etc/GMT+12',
    note: 'UTC-12 — furthest behind UTC, no DST',
    edgesIso: ['2026-09-04T12:00:00.000Z', '2027-01-01T12:00:00.000Z'],
  },
  {
    zone: 'America/New_York',
    note: 'US DST: spring forward 2026-03-08 07:00Z, fall back 2026-11-01 06:00Z',
    edgesIso: ['2026-03-08T07:00:00.000Z', '2026-11-01T06:00:00.000Z'],
  },
  {
    zone: 'Europe/Berlin',
    note: 'EU DST: 2026-03-29 01:00Z and 2026-10-25 01:00Z',
    edgesIso: ['2026-03-29T01:00:00.000Z', '2026-10-25T01:00:00.000Z'],
  },
  {
    zone: 'Australia/Lord_Howe',
    note: '30-minute DST shift (+10:30 ↔ +11), 2026-04-05 and 2026-10-04',
    edgesIso: ['2026-04-04T15:00:00.000Z', '2026-10-03T15:30:00.000Z'],
  },
  {
    zone: 'Pacific/Chatham',
    note: '+12:45 / +13:45 quarter-hour offset with DST',
    edgesIso: ['2026-04-04T14:00:00.000Z', '2026-09-26T14:00:00.000Z'],
  },
  {
    zone: 'Asia/Kolkata',
    note: '+05:30 half-hour offset, no DST',
    edgesIso: ['2026-09-04T18:30:00.000Z', '2026-09-05T18:29:59.999Z'],
  },
  {
    zone: 'America/Santiago',
    note: 'Southern-hemisphere DST: 2026-04-05 03:00Z and 2026-09-06 04:00Z',
    edgesIso: ['2026-04-05T03:00:00.000Z', '2026-09-06T04:00:00.000Z'],
  },
];

export function localizedNumber(locale: Locale, value: number): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(
    value,
  );
}

export function localizedDate(
  locale: Locale,
  zone: string,
  ms: number,
): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(ms));
}

// ---------------------------------------------------------------------------
// Numeric corpus.
// ---------------------------------------------------------------------------

export interface NumericCase {
  value: number;
  /** True when the value lies outside every producer's documented domain
   * (scores are 0–10 finite; counts are non-negative safe integers). */
  outOfDomain: boolean;
  label: string;
}

export const NUMERIC_CASES: readonly NumericCase[] = [
  { value: 0, outOfDomain: false, label: 'zero' },
  { value: -0, outOfDomain: false, label: 'negative-zero' },
  { value: 1, outOfDomain: false, label: 'one' },
  { value: 7.35, outOfDomain: false, label: 'fraction' },
  { value: 9.95, outOfDomain: false, label: 'rounds-to-10.0' },
  { value: 10, outOfDomain: false, label: 'ten' },
  { value: 0.1 + 0.2, outOfDomain: false, label: 'float-drift' },
  { value: 1e-7, outOfDomain: false, label: 'tiny' },
  { value: 12345, outOfDomain: false, label: 'large-count' },
  { value: -1, outOfDomain: true, label: 'negative' },
  { value: -100, outOfDomain: true, label: 'very-negative' },
  { value: 10.05, outOfDomain: true, label: 'just-over-ten' },
  { value: 100, outOfDomain: true, label: 'hundred' },
  { value: 1e21, outOfDomain: true, label: 'exponent-notation' },
  { value: Number.MAX_SAFE_INTEGER, outOfDomain: true, label: 'max-safe-int' },
  { value: Number.POSITIVE_INFINITY, outOfDomain: true, label: 'infinity' },
  { value: Number.NEGATIVE_INFINITY, outOfDomain: true, label: 'neg-infinity' },
  { value: Number.NaN, outOfDomain: true, label: 'nan' },
];

export const IN_DOMAIN_NUMERICS = NUMERIC_CASES.filter(c => !c.outOfDomain);

// ---------------------------------------------------------------------------
// Font scale × width matrix (iOS Dynamic Type multipliers, iPhone widths).
// ---------------------------------------------------------------------------

export const FONT_SCALES = [
  { scale: 1, label: 'Large (default)' },
  { scale: 1.35, label: 'xxxLarge (largest non-accessibility)' },
  { scale: 3.12, label: 'AX5 (largest accessibility)' },
] as const;

export const WIDTHS = [
  { width: 320, label: 'iPhone SE (1st gen) / zoomed display' },
  { width: 390, label: 'iPhone 14/15' },
  { width: 430, label: 'iPhone 15 Pro Max' },
] as const;

// ---------------------------------------------------------------------------
// Rendered-tree helpers.
// ---------------------------------------------------------------------------

export type Style = Record<string, unknown>;

export function flatStyle(style: unknown): Style {
  const out: Style = {};
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.assign(out, value);
  };
  walk(style);
  return out;
}

export function hostNodes(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(node => typeof node.type === 'string');
}

export function hostType(node: ReactTestInstance): string {
  return typeof node.type === 'string' ? node.type : '';
}

/** Every string/number child of every host Text node, in tree order. */
export function visibleTexts(renderer: ReactTestRenderer): string[] {
  return visibleTextsUnder(renderer.root);
}

export function visibleTextsUnder(root: ReactTestInstance): string[] {
  const out: string[] = [];
  for (const node of root.findAll(n => typeof n.type === 'string')) {
    if (hostType(node) !== 'Text') continue;
    const children = Array.isArray(node.props.children)
      ? node.props.children
      : [node.props.children];
    for (const child of children.flat()) {
      if (typeof child === 'string' || typeof child === 'number') {
        out.push(String(child));
      }
    }
  }
  return out;
}

export function numericStyle(style: Style, key: string): number | null {
  const value = style[key];
  return typeof value === 'number' ? value : null;
}

/** Serialize the host tree with only the props the audits rely on. */
export function evidenceTree(renderer: ReactTestRenderer): unknown {
  const json = renderer.toJSON();
  const prune = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(prune);
    if (!node || typeof node !== 'object') return node;
    const host = node as {
      type: string;
      props: Record<string, unknown>;
      children: unknown[] | null;
    };
    const props: Record<string, unknown> = {};
    for (const key of [
      'accessible',
      'accessibilityLabel',
      'accessibilityRole',
      'accessibilityHint',
      'accessibilityState',
      'importantForAccessibility',
      'testID',
      'numberOfLines',
      'allowFontScaling',
      'maxFontSizeMultiplier',
      'hitSlop',
    ]) {
      if (host.props[key] !== undefined) props[key] = host.props[key];
    }
    if (isInteractiveHost(host.props, host.type)) props.interactive = true;
    const style = flatStyle(host.props.style);
    const geometry: Style = {};
    for (const key of [
      'width',
      'height',
      'minWidth',
      'minHeight',
      'maxWidth',
      'top',
      'left',
      'marginLeft',
      'lineHeight',
      'fontSize',
      'flex',
      'flexShrink',
      'position',
    ]) {
      if (style[key] !== undefined) geometry[key] = style[key];
    }
    if (Object.keys(geometry).length > 0) props.style = geometry;
    return {
      type: host.type,
      props,
      children: host.children ? host.children.map(prune) : undefined,
    };
  };
  return prune(json);
}

// ---------------------------------------------------------------------------
// Accessibility audit (VERIFIED from tree props).
// ---------------------------------------------------------------------------

export interface AuditIssue {
  code:
    | 'crash'
    | 'a11y-missing-label'
    | 'a11y-empty-label'
    | 'a11y-label-leak'
    | 'a11y-interactive-no-role'
    | 'a11y-interactive-no-label'
    | 'a11y-target-too-small'
    | 'text-leak'
    | 'text-empty-node'
    | 'geometry-nonfinite'
    | 'geometry-negative-size'
    | 'content-mismatch'
    | 'layout-model-vertical-overflow'
    | 'layout-model-horizontal-overflow'
    | 'layout-model-label-overlap'
    | 'layout-model-no-shrink';
  /** VERIFIED = read from the tree; INFERRED = layout arithmetic. */
  basis: 'VERIFIED' | 'INFERRED';
  detail: string;
}

/** Strings a UI must never print — every one signals a formatting fault. */
export const LEAK_TOKENS = ['NaN', 'undefined', 'null', 'Infinity', '[object'];

export function leakToken(text: string): string | null {
  for (const token of LEAK_TOKENS) {
    if (text.includes(token)) return token;
  }
  return null;
}

export const MIN_TARGET_PT = 44;

/** A host View produced by Pressable/Touchable carries responder handlers
 * (`onClick`, `onResponderGrant`…) rather than the composite's `onPress`. */
export function isInteractiveHost(
  props: Record<string, unknown>,
  hostType: string,
): boolean {
  // Scroll containers carry responder handlers for scrolling, not for a tap.
  if (/Scroll/.test(hostType)) return false;
  return (
    typeof props.onClick === 'function' ||
    typeof props.onResponderGrant === 'function' ||
    typeof props.onStartShouldSetResponder === 'function' ||
    typeof props.onPress === 'function' ||
    props.accessibilityRole === 'button' ||
    props.accessibilityRole === 'link'
  );
}

function targetSize(
  node: ReactTestInstance,
  axis: 'width' | 'height',
): number | null {
  // Walk up through the pressable's wrapper chain: the size may sit on the
  // Pressable itself or on the container PressableScale wraps it in.
  let current: ReactTestInstance | null = node;
  let hops = 0;
  while (current && hops < 3) {
    const style = flatStyle(current.props.style);
    const min = numericStyle(
      style,
      axis === 'width' ? 'minWidth' : 'minHeight',
    );
    const fixed = numericStyle(style, axis);
    const best = Math.max(min ?? 0, fixed ?? 0);
    if (best > 0) return best;
    current = current.parent;
    hops += 1;
  }
  return null;
}

export function auditAccessibility(renderer: ReactTestRenderer): AuditIssue[] {
  const issues: AuditIssue[] = [];
  for (const node of hostNodes(renderer)) {
    const props = node.props;
    const interactive = isInteractiveHost(props, String(node.type));
    const label = props.accessibilityLabel;

    if (props.accessible === true || interactive) {
      if (label === undefined || label === null) {
        issues.push({
          code: interactive
            ? 'a11y-interactive-no-label'
            : 'a11y-missing-label',
          basis: 'VERIFIED',
          detail: `${node.type}${props.testID ? `#${props.testID}` : ''} accessible without accessibilityLabel`,
        });
      } else if (typeof label !== 'string' || label.trim().length === 0) {
        issues.push({
          code: 'a11y-empty-label',
          basis: 'VERIFIED',
          detail: `${node.type}${props.testID ? `#${props.testID}` : ''} accessibilityLabel is empty/non-string`,
        });
      } else {
        const token = leakToken(label);
        if (token) {
          issues.push({
            code: 'a11y-label-leak',
            basis: 'VERIFIED',
            detail: `accessibilityLabel contains "${token}": ${JSON.stringify(label.slice(0, 160))}`,
          });
        }
      }
    }

    if (interactive) {
      if (!props.accessibilityRole) {
        issues.push({
          code: 'a11y-interactive-no-role',
          basis: 'VERIFIED',
          detail: `${node.type}#${String(props.testID)} is pressable but has no accessibilityRole`,
        });
      }
      const hitSlop =
        typeof props.hitSlop === 'number'
          ? props.hitSlop
          : props.hitSlop && typeof props.hitSlop === 'object'
            ? Math.min(
                ...Object.values(props.hitSlop as Record<string, number>),
              )
            : 0;
      for (const axis of ['width', 'height'] as const) {
        const size = targetSize(node, axis);
        const effective = (size ?? 0) + 2 * hitSlop;
        if (effective < MIN_TARGET_PT) {
          issues.push({
            code: 'a11y-target-too-small',
            basis: 'VERIFIED',
            detail: `${node.type}#${String(props.testID)} ${axis} target ${size ?? 'unsized'}pt (+hitSlop ${hitSlop}) < ${MIN_TARGET_PT}pt`,
          });
        }
      }
    }
  }

  for (const text of visibleTexts(renderer)) {
    const token = leakToken(text);
    if (token) {
      issues.push({
        code: 'text-leak',
        basis: 'VERIFIED',
        detail: `visible text contains "${token}": ${JSON.stringify(text.slice(0, 160))}`,
      });
    }
  }

  for (const node of hostNodes(renderer)) {
    const style = flatStyle(node.props.style);
    for (const key of ['top', 'left', 'width', 'height', 'marginLeft']) {
      const value = style[key];
      if (typeof value === 'number' && !Number.isFinite(value)) {
        issues.push({
          code: 'geometry-nonfinite',
          basis: 'VERIFIED',
          detail: `${node.type} style.${key} = ${String(value)}`,
        });
      }
      if (
        (key === 'width' || key === 'height') &&
        typeof value === 'number' &&
        value < 0
      ) {
        issues.push({
          code: 'geometry-negative-size',
          basis: 'VERIFIED',
          detail: `${node.type} style.${key} = ${value}`,
        });
      }
    }
  }
  return issues;
}

/**
 * Reads the resolved value an Animated interpolation will settle on. The
 * charts animate `height` from 4 → target via `reveal.interpolate`; on a
 * mounted tree with timers flushed the AnimatedNode reports `__getValue()`.
 */
export function animatedNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const node = value as { __getValue?: () => unknown };
    if (typeof node.__getValue === 'function') {
      const resolved = node.__getValue();
      return typeof resolved === 'number' ? resolved : null;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Layout model (INFERRED) — glyph-width heuristic + the components' constants.
// ---------------------------------------------------------------------------

/** Rough advance width in em for a code point in a semibold UI face. */
function glyphEm(codePoint: number): number {
  if (codePoint === 0x200d || codePoint === 0xfe0f) return 0; // ZWJ / VS16
  if (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x0610 && codePoint <= 0x061a) ||
    (codePoint >= 0x064b && codePoint <= 0x065f) ||
    (codePoint >= 0x0e31 && codePoint <= 0x0e3a) ||
    (codePoint >= 0x0e47 && codePoint <= 0x0e4e) ||
    (codePoint >= 0x093c && codePoint <= 0x094d) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  ) {
    return 0; // combining marks / bidi controls
  }
  if (codePoint >= 0x1f000) return 1.25; // emoji base
  if (
    (codePoint >= 0x3000 && codePoint <= 0x9fff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af) ||
    (codePoint >= 0xff00 && codePoint <= 0xffef)
  ) {
    return 1.0; // CJK full-width
  }
  if (codePoint >= 0x0600 && codePoint <= 0x06ff) return 0.5; // Arabic
  if (codePoint >= 0x0900 && codePoint <= 0x097f) return 0.6; // Devanagari
  if (codePoint >= 0x0e00 && codePoint <= 0x0e7f) return 0.55; // Thai
  if (codePoint >= 0x0400 && codePoint <= 0x04ff) return 0.62; // Cyrillic
  if (codePoint === 0x20 || codePoint === 0xa0) return 0.28;
  if (codePoint >= 0x30 && codePoint <= 0x39) return 0.58; // digits
  if (codePoint >= 0x41 && codePoint <= 0x5a) return 0.66; // A–Z
  if (codePoint === 0x57 || codePoint === 0x4d) return 0.9; // W, M
  if (codePoint >= 0x61 && codePoint <= 0x7a) return 0.52; // a–z
  return 0.55;
}

export function estimateTextWidth(
  text: string,
  fontSize: number,
  letterSpacing: number,
  fontScale: number,
): number {
  let em = 0;
  let glyphs = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const width = glyphEm(cp);
    em += width;
    if (width > 0) glyphs += 1;
  }
  return em * fontSize * fontScale + Math.max(0, glyphs - 1) * letterSpacing;
}

// ---------------------------------------------------------------------------
// Result table.
// ---------------------------------------------------------------------------

export type Outcome = 'HELD' | 'BROKEN' | 'BROKEN_KNOWN';

export interface ResultRow {
  seed: number;
  campaign: string;
  component: string;
  variant: string;
  locale?: string;
  timeZone?: string;
  fontScale?: number;
  width?: number;
  outOfDomain?: boolean;
  outcome: Outcome;
  /** Finding ids (see the pinned `test.failing` cases) for BROKEN_KNOWN rows. */
  known?: string[];
  issues: AuditIssue[];
  textSample?: string[];
  durationMs: number;
}

export function resultsDir(): string {
  const configured = process.env.STRESS_OUT;
  if (configured) return configured;
  const repoLocal = path.resolve(__dirname, '..', '..', 'artifacts', 'stress');
  try {
    fs.mkdirSync(repoLocal, { recursive: true });
    return repoLocal;
  } catch {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'pickle-stress-'));
  }
}

export function writeResults(
  name: string,
  rows: readonly ResultRow[],
  extra: Record<string, unknown> = {},
): string {
  const dir = resultsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const summary = {
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    held: rows.filter(r => r.outcome === 'HELD').length,
    broken: rows.filter(r => r.outcome === 'BROKEN').length,
    brokenKnown: rows.filter(r => r.outcome === 'BROKEN_KNOWN').length,
    ...extra,
  };
  fs.writeFileSync(file, JSON.stringify({ summary, rows }, null, 1));
  return file;
}

export function writeEvidence(name: string, payload: unknown): string {
  const dir = path.join(resultsDir(), 'evidence');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 1));
  return file;
}
