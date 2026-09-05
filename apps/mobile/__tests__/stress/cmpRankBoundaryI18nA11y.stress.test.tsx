/**
 * Seeded boundary / i18n / a11y stress campaign for the `cmp-rank` unit:
 * PlayerRankBanner, PlayerRankCard, RankIcon and RankUpCelebration.
 *
 * Every iteration is derived from ONE 32-bit seed (mulberry32) and is
 * replayable: `STRESS_SEED=<seed> npx jest cmpRankBoundaryI18nA11y` re-runs
 * exactly that variant. `STRESS_ITER` (default 40 per component → 160
 * rendered variants) scales the campaign; `STRESS_OUT=<dir>` writes the
 * seed → outcome JSON table plus rendered-tree evidence for every non-HELD
 * iteration.
 *
 * What is VERIFIED here (react-test-renderer host tree, no Yoga):
 *  - render never throws / never logs a React error for any generated input
 *  - visible copy never leaks NaN/undefined/null/Infinity/[object Object]
 *  - every interactive host node carries an accessibility role + label
 *  - the same props render identical copy under 12 locales
 *  - the same facts render identical copy when the process TZ differs
 *    (the TZ dimension is driven by `run-cmp-rank-matrix.sh`; the sandbox
 *    copies process.env so TZ can only change per jest process)
 * What is a PROXY (labelled `proxy` in the table): text clipping and
 * touch-target size are estimated from flattened styles and a per-script
 * glyph-advance table under 3 font scales × 3 viewport widths. The renderer
 * has no layout engine, so those numbers are evidence for a human to
 * confirm on a device, never a device measurement.
 */
import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { AccessibilityInfo, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PlayerRankSummary,
  PlayerRankTierKey,
} from '@pickle/shared-types';
import { PLAYER_RANK_TIERS } from '@pickle/shared-types';

jest.mock('react-native-linear-gradient', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const MockGradient = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return { __esModule: true, default: MockGradient };
});

const mockGetApiSession = jest.fn<unknown, []>(() => null);
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockFetchPlayerRank = jest.fn<Promise<unknown>, unknown[]>(
  async () => null,
);
jest.mock('../../src/progress/playerRank', () => {
  const actual = jest.requireActual<
    typeof import('../../src/progress/playerRank')
  >('../../src/progress/playerRank');
  return {
    ...actual,
    fetchPlayerRank: (...args: unknown[]) => mockFetchPlayerRank(...args),
  };
});

// The celebration store persists through SQLite; the native module is absent
// under jest and the store swallows the failure.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { PlayerRankBanner } from '../../src/components/PlayerRankBanner';
import { PlayerRankCard } from '../../src/components/PlayerRankCard';
import { RankIcon } from '../../src/components/RankIcon';
import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import type { RealAnalysisFact } from '../../src/data/repository';
import {
  parsePlayerRank,
  rankFromFacts,
  summaryFromServer,
} from '../../src/progress/playerRank';
import type {
  PlayerRankFactLike,
  ServerPlayerRank,
} from '../../src/progress/playerRank';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';

// ---------------------------------------------------------------------------
// Campaign knobs
// ---------------------------------------------------------------------------

const ITER = Math.max(1, Number(process.env.STRESS_ITER ?? '40') || 40);
const REPLAY_SEED =
  process.env.STRESS_SEED !== undefined && process.env.STRESS_SEED !== ''
    ? Number(process.env.STRESS_SEED) >>> 0
    : null;
const CAMPAIGN_SEED = Number(process.env.STRESS_CAMPAIGN_SEED ?? '20260904');
const OUT_DIR = process.env.STRESS_OUT ?? null;
const RUN_TZ = process.env.TZ ?? 'unset';

const COMPONENTS = ['banner', 'card', 'icon', 'celebration'] as const;
type ComponentName = (typeof COMPONENTS)[number];

const FONT_SCALES = [1, 1.35, 2.0] as const;
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

const TARGET_MIN_PT = 44;
const TEXT_LEAK =
  /\b(NaN|undefined|null|Infinity|-Infinity)\b|\[object Object\]/;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every draw for an iteration comes from its seed.
// ---------------------------------------------------------------------------

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
}

function seedFor(component: ComponentName, index: number): number {
  const rng = new Rng(
    (CAMPAIGN_SEED ^ (COMPONENTS.indexOf(component) * 0x9e3779b9)) >>> 0,
  );
  let seed = 0;
  for (let i = 0; i <= index; i += 1) seed = Math.floor(rng.next() * 2 ** 32);
  return seed >>> 0;
}

// ---------------------------------------------------------------------------
// String / numeric corpora
// ---------------------------------------------------------------------------

const CORPUS = {
  ascii: 'third_shot_drop',
  asciiSpaced: 'forehand drive',
  long200: 'ultra_long_technique_label_'.repeat(9), // 243 chars
  long64: 'x'.repeat(64), // server cap (index.ts: shotType max 64)
  long65: 'y'.repeat(65),
  cjk: '第三拍吊球技术分析结果非常详细的描述文字和更多的说明',
  cjkLong: '第三拍吊球技术分析'.repeat(24), // 216 chars
  japanese: 'サードショットドロップ',
  arabic: 'ضربة الإسقاط الثالثة مع تحليل مفصل',
  arabicBidi: 'dink \u202Bالإسقاط\u202C drive',
  hindi: 'तृतीय शॉट ड्रॉप',
  thai: 'ทักษะการตีลูกดิงค์',
  russian: 'Третий удар с подрезкой',
  turkish: 'İyi dinkler ışık',
  zwjEmoji: '👨‍👩‍👧‍👦🏓🏳️‍🌈👩🏽‍🦽',
  emojiLong: '🏓'.repeat(120),
  combining: 'e\u0301'.repeat(60),
  zalgo: 'Z\u0351\u036b\u0343\u036a\u0302\u036b\u033d\u034f\u0334\u0319'.repeat(
    12,
  ),
  german: 'Rückhandunterschnittvolleytechnikbewertungsverfahren',
  empty: '',
  whitespace: '   ',
  underscores: '___',
  control: 'a\u0000b\u200bc\td\ne',
  rtlOverride: 'abc\u202Edef\u202C',
} as const;
type CorpusKey = keyof typeof CORPUS;
const CORPUS_KEYS = Object.keys(CORPUS) as CorpusKey[];

const SCORE_POOL = [
  0, 0.01, 3.49, 3.5, 4.99, 5, 6.49, 6.5, 7.49, 7.5, 9.99, 10,
];
const SCORE_BOUNDARY_POOL = [
  ...SCORE_POOL,
  -1,
  -0,
  10.01,
  11,
  1e9,
  1e21,
  -1e21,
  Number.MAX_SAFE_INTEGER,
  Number.EPSILON,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
/** Streaks the app can hold: locally computed day counts, or any FINITE
 * number an account payload can carry (src/progress/api.ts:111 only checks
 * finiteness — negative and fractional streaks are reachable). */
const STREAK_POOL = [
  0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 365, 9999, 1e9, 1e21, -1, -365, 1.5, -0,
];
const STREAK_POOL_RAW = [
  ...STREAK_POOL,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
];
const COUNT_POOL = [0, 1, 2, 5, 6, 7, 64, 500, -1, 1e9, 1.5, Number.NaN];

// 8 time-zone flavoured capturedAt payloads: explicit ±14:00 offsets, DST
// gaps/overlaps (with and without zone), extreme dates and garbage.
const CAPTURED_AT_POOL = [
  '2026-08-10T10:00:00Z',
  '2026-08-11T10:00:00.000Z',
  '2026-08-12T23:59:59+14:00',
  '2026-08-12T00:00:00-12:00',
  '2026-03-08T02:30:00', // America/New_York spring-forward gap (no zone)
  '2026-11-01T01:30:00', // America/New_York fall-back overlap (no zone)
  '2026-03-29T02:30:00', // Europe/Berlin spring-forward gap (no zone)
  '2026-10-04T02:15:00', // Australia/Lord_Howe 30-minute DST edge (no zone)
  '2026-04-05T02:45:00+12:45', // Pacific/Chatham
  '+275760-09-13T00:00:00.000Z', // max Date
  '-271821-04-20T00:00:00.000Z', // min Date
  '0000-01-01T00:00:00Z',
  '1970-01-01T00:00:00Z',
  '',
  'not-a-date',
  '2026-13-45T99:99:99Z',
  '2026-08-10 10:00:00',
  '1754820000000',
];

const TIERS: readonly PlayerRankTierKey[] = PLAYER_RANK_TIERS.map(t => t.key);
const INVALID_TIERS = ['', 'GOLD', 'gold ', CORPUS.cjk, 'unranked', 'wood'];

// ---------------------------------------------------------------------------
// Host-tree helpers
// ---------------------------------------------------------------------------

type HostNode = {
  type: string;
  props: Record<string, unknown>;
  children: Array<HostNode | string> | null;
};

function hostTree(renderer: TestRenderer.ReactTestRenderer): HostNode[] {
  const json = renderer.toJSON();
  if (json === null) return [];
  return (Array.isArray(json) ? json : [json]) as HostNode[];
}

function walk(nodes: Array<HostNode | string>, visit: (n: HostNode) => void) {
  for (const node of nodes) {
    if (typeof node === 'string') continue;
    visit(node);
    if (node.children) walk(node.children, visit);
  }
}

function textOf(node: HostNode | string): string {
  if (typeof node === 'string') return node;
  return (node.children ?? []).map(textOf).join('');
}

function allText(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => {
      const children = node.props.children as unknown;
      return (Array.isArray(children) ? children.flat(4) : [children])
        .filter(
          (child): child is string | number =>
            typeof child === 'string' || typeof child === 'number',
        )
        .map(String)
        .join('');
    })
    .filter(s => s.length > 0);
}

type Style = Record<string, unknown>;
function flattenStyle(style: unknown, into: Style = {}): Style {
  if (!style) return into;
  if (Array.isArray(style)) {
    for (const item of style) flattenStyle(item, into);
    return into;
  }
  if (typeof style === 'object') Object.assign(into, style as Style);
  return into;
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// ---------------------------------------------------------------------------
// Layout proxy: glyph advances per script × font scale, box estimate per node
// ---------------------------------------------------------------------------

function advanceEm(cp: number): number {
  if (cp === 0x200d || cp === 0x200b || cp === 0xfe0f) return 0; // ZWJ/ZWSP/VS16
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacritics
  if (cp >= 0x202a && cp <= 0x202e) return 0; // bidi controls
  if (cp < 0x20) return 0;
  if (cp === 0x20) return 0.28;
  if (cp >= 0x30 && cp <= 0x39) return 0.58;
  if ("iljtfrI.:;,'|!".includes(String.fromCodePoint(cp))) return 0.3;
  if (cp >= 0x41 && cp <= 0x5a) return 0.66;
  if (cp < 0x7f) return 0.55;
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.5; // Arabic
  if (cp >= 0x0900 && cp <= 0x097f) return 0.6; // Devanagari
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.6; // Thai
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.6; // Cyrillic
  if (cp >= 0x3000 && cp <= 0x9fff) return 1.0; // CJK + kana
  if (cp >= 0x1f000) return 1.25; // emoji
  return 0.6;
}

function textAdvancePx(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) em += advanceEm(ch.codePointAt(0) ?? 0);
  return em * fontSize;
}

type Box = { width: number; height: number };
type LayoutIssue = {
  kind: 'clip' | 'overflow';
  node: string;
  detail: string;
  text?: string;
};

function pad(style: Style, side: 'Left' | 'Right' | 'Top' | 'Bottom') {
  const axis = side === 'Left' || side === 'Right' ? 'Horizontal' : 'Vertical';
  return num(
    style[`padding${side}`],
    num(style[`padding${axis}`], num(style.padding, 0)),
  );
}

/**
 * Conservative box estimate. Returns the LOWER bound of a node's height (a
 * single wrapped Text can only grow) and the natural content width, which
 * is what clipping / hit-target checks need.
 */
function estimateBox(
  node: HostNode | string,
  availWidth: number,
  fontScale: number,
  issues: LayoutIssue[],
  pathLabel: string,
): Box {
  if (typeof node === 'string') return { width: 0, height: 0 };
  const style = flattenStyle(node.props.style);
  if (node.type === 'RNSVGSvgView') {
    return {
      width: num(node.props.width, num(style.width, 0)),
      height: num(node.props.height, num(style.height, 0)),
    };
  }
  if (node.type === 'Text') {
    const fontSize = num(style.fontSize, 14) * fontScale;
    const lineHeight =
      num(style.lineHeight, num(style.fontSize, 14) * 1.2) * fontScale;
    const text = textOf(node);
    const advance =
      textAdvancePx(text, fontSize) +
      Math.max(0, num(style.letterSpacing, 0)) * text.length;
    const inner = Math.max(
      1,
      availWidth - pad(style, 'Left') - pad(style, 'Right'),
    );
    const numberOfLines = num(node.props.numberOfLines, 0);
    const lines = Math.max(1, Math.ceil(advance / inner));
    if (numberOfLines > 0 && lines > numberOfLines && text.trim().length > 0) {
      issues.push({
        kind: 'clip',
        node: pathLabel,
        text: text.slice(0, 80),
        detail: `numberOfLines=${numberOfLines} needs≈${lines} lines (advance≈${Math.round(advance)}px, avail≈${Math.round(inner)}px, fontScale=${fontScale})`,
      });
    }
    const shownLines =
      numberOfLines > 0 ? Math.min(lines, numberOfLines) : lines;
    return {
      width:
        Math.min(advance, inner) + pad(style, 'Left') + pad(style, 'Right'),
      height:
        shownLines * lineHeight + pad(style, 'Top') + pad(style, 'Bottom'),
    };
  }
  const row =
    style.flexDirection === 'row' || style.flexDirection === 'row-reverse';
  const wrap = style.flexWrap === 'wrap';
  const gap = num(style.gap, 0);
  const columnGap = num(style.columnGap, gap);
  const rowGap = num(style.rowGap, gap);
  const fixedWidth = typeof style.width === 'number' ? style.width : null;
  const inner = Math.max(
    1,
    (fixedWidth ?? availWidth) - pad(style, 'Left') - pad(style, 'Right'),
  );
  const flow = (node.children ?? []).filter(
    child =>
      typeof child === 'string' ||
      flattenStyle(child.props.style).position !== 'absolute',
  );
  let width = 0;
  let height = 0;
  if (row && !wrap) {
    const boxes = flow.map((child, i) =>
      estimateBox(child, inner, fontScale, issues, `${pathLabel}/${i}`),
    );
    width =
      boxes.reduce((sum, b) => sum + b.width, 0) +
      Math.max(0, boxes.length - 1) * columnGap;
    height = boxes.reduce((max, b) => Math.max(max, b.height), 0);
    // Yoga's default flexShrink is 0 in React Native, so a row only yields
    // when a child opts in with `flex` or `flexShrink`.
    const shrinkable = flow.some(child => {
      if (typeof child === 'string') return false;
      const s = flattenStyle(child.props.style);
      return num(s.flex, 0) > 0 || num(s.flexShrink, 0) > 0;
    });
    if (width > inner + 0.5 && !shrinkable && boxes.length > 1) {
      issues.push({
        kind: 'overflow',
        node: pathLabel,
        detail: `row content≈${Math.round(width)}px exceeds avail≈${Math.round(inner)}px with no flex/flexShrink child (fontScale=${fontScale})`,
      });
    }
  } else if (row && wrap) {
    let lineWidth = 0;
    let lineHeight = 0;
    let lines = 0;
    let maxLine = 0;
    for (const [i, child] of flow.entries()) {
      const box = estimateBox(
        child,
        inner,
        fontScale,
        issues,
        `${pathLabel}/${i}`,
      );
      if (lineWidth > 0 && lineWidth + columnGap + box.width > inner) {
        height += lineHeight + (lines > 0 ? rowGap : 0);
        lines += 1;
        maxLine = Math.max(maxLine, lineWidth);
        lineWidth = 0;
        lineHeight = 0;
      }
      lineWidth += (lineWidth > 0 ? columnGap : 0) + box.width;
      lineHeight = Math.max(lineHeight, box.height);
    }
    height += lineHeight + (lines > 0 ? rowGap : 0);
    width = Math.max(maxLine, lineWidth);
  } else {
    const boxes = flow.map((child, i) =>
      estimateBox(child, inner, fontScale, issues, `${pathLabel}/${i}`),
    );
    height =
      boxes.reduce((sum, b) => sum + b.height, 0) +
      Math.max(0, boxes.length - 1) * rowGap;
    width = boxes.reduce((max, b) => Math.max(max, b.width), 0);
  }
  width += pad(style, 'Left') + pad(style, 'Right');
  height += pad(style, 'Top') + pad(style, 'Bottom');
  if (fixedWidth !== null) width = fixedWidth;
  if (typeof style.height === 'number') height = style.height;
  height = Math.max(height, num(style.minHeight, 0));
  width = Math.max(width, num(style.minWidth, 0));
  return { width, height };
}

// ---------------------------------------------------------------------------
// Accessibility audit over interactive host nodes
// ---------------------------------------------------------------------------

type A11yRecord = {
  testID: string | null;
  role: string | null;
  label: string | null;
  hasVisibleText: boolean;
  disabled: boolean;
  hitSlop: unknown;
  proxyBox: Box;
  proxyTargetOk: boolean | 'n/a';
  unlabeled: boolean;
};

const RESPONDER_PROPS = [
  'onClick',
  'onPress',
  'onResponderGrant',
  'onResponderRelease',
  'onStartShouldSetResponder',
];

function isInteractive(node: HostNode): boolean {
  return RESPONDER_PROPS.some(prop => typeof node.props[prop] === 'function');
}

function auditA11y(
  roots: HostNode[],
  width: number,
  fontScale: number,
): { records: A11yRecord[]; layout: LayoutIssue[] } {
  const records: A11yRecord[] = [];
  const layout: LayoutIssue[] = [];
  // Whole-tree layout proxy (clips / overflow anywhere).
  roots.forEach((root, i) =>
    estimateBox(root, width, fontScale, layout, `root${i}`),
  );
  walk(roots, node => {
    if (!isInteractive(node)) return;
    const role =
      typeof node.props.accessibilityRole === 'string'
        ? node.props.accessibilityRole
        : null;
    const label =
      typeof node.props.accessibilityLabel === 'string'
        ? node.props.accessibilityLabel
        : null;
    const state = node.props.accessibilityState as
      { disabled?: boolean } | undefined;
    const visible = textOf(node).trim();
    const nodeStyle = flattenStyle(node.props.style);
    // A backdrop pinned to all four edges is the whole screen; a 44pt floor
    // is meaningless for it.
    const fullScreen =
      nodeStyle.position === 'absolute' &&
      [nodeStyle.top, nodeStyle.left, nodeStyle.right, nodeStyle.bottom].every(
        edge => edge === 0,
      );
    // A control sized by the flex layout (`flex: 1`, e.g. the celebration's
    // dismiss backdrop) has no size a static tree can know: Yoga never ran
    // here. Recording it as a 44pt failure would be fabricated evidence, so
    // it is 'n/a' and belongs to the Apple plane.
    const flexSized =
      num(nodeStyle.flex, 0) > 0 || num(nodeStyle.flexGrow, 0) > 0;
    const unsizable =
      nodeStyle.width === undefined &&
      nodeStyle.height === undefined &&
      (fullScreen || flexSized);
    const box = estimateBox(node, width, fontScale, [], 'target');
    const hitSlop = node.props.hitSlop;
    const slopH = typeof hitSlop === 'number' ? hitSlop * 2 : 0;
    const proxyTargetOk: boolean | 'n/a' = unsizable
      ? 'n/a'
      : box.height + slopH >= TARGET_MIN_PT &&
        box.width + slopH >= TARGET_MIN_PT;
    records.push({
      testID: typeof node.props.testID === 'string' ? node.props.testID : null,
      role,
      label,
      hasVisibleText: visible.length > 0,
      disabled: state?.disabled === true,
      hitSlop: hitSlop ?? null,
      proxyBox: {
        width: Math.round(box.width),
        height: Math.round(box.height),
      },
      proxyTargetOk,
      unlabeled:
        role === null || ((label ?? '').trim() === '' && visible.length === 0),
    });
  });
  return { records, layout };
}

// ---------------------------------------------------------------------------
// Variant generators
// ---------------------------------------------------------------------------

type Variant = {
  component: ComponentName;
  seed: number;
  fontScale: number;
  width: number;
  locale: (typeof LOCALES)[number];
  reducedMotion: boolean;
  corpus: CorpusKey[];
  /** `unicode` = adversarial technique labels; `real` = the eight shipping
   * `SHOT_TYPES` slugs, i.e. what the API can actually return. */
  payload: 'unicode' | 'real';
  /**
   * `parsed` (the mainline campaign) pushes every account payload through
   * the REAL `parsePlayerRank` and derives summaries with the real
   * `summaryFromServer` / `rankFromFacts`, so only values the shipping app
   * can actually hold reach the components. `raw` skips those guards and
   * hands the components hand-built props (non-finite ratings, garbage tier
   * strings, NaN counts) — reachable only if a parser regresses.
   */
  gate: 'parsed' | 'raw';
};

function pickCorpus(rng: Rng): CorpusKey {
  return rng.pick(CORPUS_KEYS);
}

/** The eight real slugs (`@pickle/shared-types` SHOT_TYPES) — what the API
 * can actually return for `shot_type`. */
const REAL_SLUGS = [
  'serve',
  'return',
  'forehand_drive',
  'backhand_drive',
  'third_shot_drop',
  'dink',
  'volley',
  'overhead',
] as const;

/**
 * Technique labels for one payload. `unique` mirrors the server contract
 * (`public.player_technique_rating` groups by `(user_id, shot_type)`, so a
 * `shot_type` cannot repeat); the components key their chips by `shotType`,
 * and a deliberately duplicated key is exercised by its own test below
 * instead of polluting every seed with React's duplicate-key error.
 */
function techniqueLabels(
  rng: Rng,
  count: number,
  used: CorpusKey[],
  mode: 'unicode' | 'real',
): string[] {
  if (mode === 'real') {
    return REAL_SLUGS.slice(0, Math.min(count, REAL_SLUGS.length)).map(s => s);
  }
  const pool = [...CORPUS_KEYS];
  const labels: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (pool.length === 0) {
      // More rows than distinct corpus entries: keep keys unique with a
      // numeric suffix so the payload still respects the server contract.
      labels.push(`${CORPUS.ascii}-${i}`);
      continue;
    }
    const key = pool.splice(rng.int(pool.length), 1)[0] as CorpusKey;
    used.push(key);
    labels.push(CORPUS[key]);
  }
  return labels;
}

function makeFact(
  rng: Rng,
  index: number,
  used: CorpusKey[],
): RealAnalysisFact {
  const corpusKey = rng.bool(0.5) ? 'ascii' : pickCorpus(rng);
  used.push(corpusKey);
  const kindPool = [
    'scored',
    'scored',
    'scored',
    'abstained',
    'failed',
    '',
  ] as const;
  const scorePool = rng.bool(0.75) ? SCORE_POOL : SCORE_BOUNDARY_POOL;
  const overallScore = rng.bool(0.1) ? null : rng.pick(scorePool);
  return {
    id: rng.bool(0.9) ? `fact-${index}` : '',
    shotType: CORPUS[corpusKey],
    capturedAt: rng.pick(CAPTURED_AT_POOL),
    overallScore,
    confidence: rng.pick([0, 0.5, 0.9, 1, -1, Number.NaN]),
    // '' is deliberately off-contract: the parsers must treat it as unscored.
    resultKind: rng.pick(kindPool) as RealAnalysisFact['resultKind'],
    scoringModelVersion: 'model-stress',
    shotConfigVersion: 'config-stress',
    sessionId: null,
    priorityCheckpoint: null,
    checkpointScores: {},
  };
}

function makeFacts(
  rng: Rng,
  used: CorpusKey[],
  mode: 'unicode' | 'real' = 'unicode',
): RealAnalysisFact[] {
  const countPool = [0, 1, 2, 3, 8, 9, 16, 40, 200];
  const count = rng.pick(countPool);
  const facts: RealAnalysisFact[] = [];
  for (let i = 0; i < count; i += 1) {
    const fact = makeFact(rng, i, used);
    facts.push(
      mode === 'real'
        ? {
            ...fact,
            shotType: rng.pick(REAL_SLUGS),
            resultKind: 'scored',
            overallScore: rng.pick(SCORE_POOL),
            capturedAt: `2026-08-${String(10 + (i % 19)).padStart(2, '0')}T10:00:00Z`,
          }
        : fact,
    );
  }
  return facts;
}

function makeServerRank(
  rng: Rng,
  used: CorpusKey[],
  mode: 'unicode' | 'real' = 'unicode',
): ServerPlayerRank {
  const techniqueTotal = rng.pick([0, 1, 3, 6, 7, 12, 64, 300]);
  const techniques: ServerPlayerRank['techniques'] = [];
  for (const shotType of techniqueLabels(rng, techniqueTotal, used, mode)) {
    techniques.push({
      shotType,
      score: rng.pick(rng.bool(0.7) ? SCORE_POOL : SCORE_BOUNDARY_POOL),
      capturedAt: rng.pick(CAPTURED_AT_POOL),
      ...(rng.bool(0.5) ? { sampledCount: rng.pick(COUNT_POOL) } : {}),
    });
  }
  return {
    rating: rng.pick(SCORE_POOL),
    tier: rng.bool(0.8) ? rng.pick(TIERS) : rng.pick(INVALID_TIERS),
    techniqueCount: rng.pick(COUNT_POOL),
    scoredShotCount: rng.bool(0.5) ? null : rng.pick(COUNT_POOL),
    updatedAt: rng.bool(0.5) ? null : rng.pick(CAPTURED_AT_POOL),
    techniques,
  };
}

function makeSummary(
  rng: Rng,
  used: CorpusKey[],
  mode: 'unicode' | 'real' = 'unicode',
): PlayerRankSummary {
  const tier = rng.pick(TIERS);
  const tierIndex = TIERS.indexOf(tier);
  const next = PLAYER_RANK_TIERS[tierIndex + 1] ?? null;
  const labelKey = rng.bool(0.6) ? null : pickCorpus(rng);
  if (labelKey) used.push(labelKey);
  const tierLabel = labelKey
    ? CORPUS[labelKey]
    : PLAYER_RANK_TIERS[tierIndex]!.label;
  const rating = rng.pick(rng.bool(0.7) ? SCORE_POOL : SCORE_BOUNDARY_POOL);
  const techniqueTotal = rng.pick([0, 1, 3, 6, 12, 64]);
  const techniques: PlayerRankSummary['techniques'] = [];
  for (const shotType of techniqueLabels(rng, techniqueTotal, used, mode)) {
    techniques.push({
      shotType,
      score: rng.pick(SCORE_BOUNDARY_POOL),
      capturedAt: rng.pick(CAPTURED_AT_POOL),
      sampledCount: rng.pick(COUNT_POOL),
    });
  }
  return {
    rating,
    tier,
    tierLabel,
    division: rng.pick([1, 2, 3, 0, -1, 4, Number.NaN] as const) as 1 | 2 | 3,
    divisionLabel: (rng.bool(0.7)
      ? rng.pick(['I', 'II', 'III'] as const)
      : CORPUS[pickCorpus(rng)]) as PlayerRankSummary['divisionLabel'],
    techniqueCount: rng.pick(COUNT_POOL),
    scoredAnalysisCount: rng.pick(COUNT_POOL),
    techniques,
    nextTier:
      next && rng.bool(0.8)
        ? {
            key: next.key,
            label: rng.bool(0.7) ? next.label : CORPUS[pickCorpus(rng)],
            minRating: next.minRating,
            pointsNeeded: rng.pick([0.01, 0.5, 1.49, 0, -1, 1e9, Number.NaN]),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Locale forcing: any locale-sensitive API a component calls would now
// produce locale-specific output, so identical copy across the 12 locales
// proves the surfaces do not depend on device locale.
// ---------------------------------------------------------------------------

type Restore = () => void;
function forceLocale(locale: string, counter: { calls: number }): Restore {
  const origCompare = String.prototype.localeCompare;
  const origNumber = Number.prototype.toLocaleString;
  const origDate = Date.prototype.toLocaleString;
  const origDateDate = Date.prototype.toLocaleDateString;
  const origDateTime = Date.prototype.toLocaleTimeString;
  const OrigNumberFormat = Intl.NumberFormat;
  const OrigDateTimeFormat = Intl.DateTimeFormat;
  String.prototype.localeCompare = function (
    this: string,
    other: string,
    _l?: string | string[],
    opts?: Intl.CollatorOptions,
  ) {
    counter.calls += 1;
    return origCompare.call(this, other, locale, opts);
  };
  Number.prototype.toLocaleString = function (
    this: number,
    _l?: string | string[],
    opts?: Intl.NumberFormatOptions,
  ) {
    counter.calls += 1;
    return origNumber.call(this, locale, opts);
  };
  Date.prototype.toLocaleString = function (
    this: Date,
    _l?: string | string[],
    opts?: Intl.DateTimeFormatOptions,
  ) {
    counter.calls += 1;
    return origDate.call(this, locale, opts);
  };
  Date.prototype.toLocaleDateString = function (
    this: Date,
    _l?: string | string[],
    opts?: Intl.DateTimeFormatOptions,
  ) {
    counter.calls += 1;
    return origDateDate.call(this, locale, opts);
  };
  Date.prototype.toLocaleTimeString = function (
    this: Date,
    _l?: string | string[],
    opts?: Intl.DateTimeFormatOptions,
  ) {
    counter.calls += 1;
    return origDateTime.call(this, locale, opts);
  };
  const NumberFormatForced = function (
    _l?: string | string[],
    opts?: Intl.NumberFormatOptions,
  ) {
    counter.calls += 1;
    return new OrigNumberFormat(locale, opts);
  } as unknown as typeof Intl.NumberFormat;
  const DateTimeFormatForced = function (
    _l?: string | string[],
    opts?: Intl.DateTimeFormatOptions,
  ) {
    counter.calls += 1;
    return new OrigDateTimeFormat(locale, opts);
  } as unknown as typeof Intl.DateTimeFormat;
  Intl.NumberFormat = NumberFormatForced;
  Intl.DateTimeFormat = DateTimeFormatForced;
  return () => {
    String.prototype.localeCompare = origCompare;
    Number.prototype.toLocaleString = origNumber;
    Date.prototype.toLocaleString = origDate;
    Date.prototype.toLocaleDateString = origDateDate;
    Date.prototype.toLocaleTimeString = origDateTime;
    Intl.NumberFormat = OrigNumberFormat;
    Intl.DateTimeFormat = OrigDateTimeFormat;
  };
}

// ---------------------------------------------------------------------------
// One iteration
// ---------------------------------------------------------------------------

type Outcome = {
  seed: number;
  component: ComponentName;
  gate: 'parsed' | 'raw';
  tz: string;
  locale: string;
  fontScale: number;
  width: number;
  reducedMotion: boolean;
  corpus: string[];
  input: Record<string, unknown>;
  status: 'HELD' | 'BROKEN';
  categories: string[];
  crash: string | null;
  consoleErrors: string[];
  textLeaks: string[];
  a11y: A11yRecord[];
  proxyLayout: LayoutIssue[];
  localeCalls: number;
  textCount: number;
  hostNodes: number;
  renderMs: number;
  visibleText: string[];
};

const SESSION = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'stress-bearer',
  canonicalAppUserId: 'aaaaaaaa-0000-4000-8000-0000000000aa',
  provider: 'apple' as const,
};

/** Round-trips a generated account rank through the shipping parser (the
 * payload shape `GET /v1/rank` returns). `null` = the parser refused it. */
function parseOrNull(server: ServerPlayerRank): ServerPlayerRank | null {
  const payload = {
    rank: {
      rating: server.rating,
      tier: server.tier,
      techniqueCount: server.techniqueCount,
      scoredShotCount: server.scoredShotCount,
      updatedAt: server.updatedAt,
      techniques: server.techniques.map(t => ({
        shot_type: t.shotType,
        score: t.score,
        captured_at: t.capturedAt,
        ...(t.sampledCount === undefined
          ? {}
          : { sampled_count: t.sampledCount }),
      })),
    },
  };
  try {
    return parsePlayerRank(payload);
  } catch {
    return null;
  }
}

/** A rank summary the shipping app can really produce: derived from a
 * parser-accepted account payload, or computed from local facts by the same
 * `rankFromFacts` the screens use. */
function reachableSummary(
  rng: Rng,
  used: CorpusKey[],
  mode: 'unicode' | 'real',
): PlayerRankSummary {
  const parsed = parseOrNull(makeServerRank(rng, used, mode));
  if (parsed) return summaryFromServer(parsed);
  const fromFacts = rankFromFacts(
    makeFacts(rng, used, mode) as readonly PlayerRankFactLike[],
  );
  if (fromFacts) return fromFacts;
  // Neither source produced a rank (no scored facts, payload refused): fall
  // back to a minimal payload the parser definitely accepts, so the
  // celebration still renders parser-shaped data.
  return summaryFromServer({
    rating: rng.pick(SCORE_POOL),
    tier: rng.pick(TIERS),
    techniqueCount: 1,
    scoredShotCount: 1,
    updatedAt: '2026-08-10T10:00:00Z',
    techniques: [
      {
        shotType: rng.pick(REAL_SLUGS),
        score: rng.pick(SCORE_POOL),
        capturedAt: '2026-08-10T10:00:00Z',
        sampledCount: 1,
      },
    ],
  });
}

/**
 * `useReducedMotion` (src/design/components.tsx:41-55) asks
 * `isReduceMotionEnabled` ONCE per module lifetime and afterwards follows
 * only the `reduceMotionChanged` listener, so a per-variant
 * `mockResolvedValue` would bind the very first mount and silently ignore
 * every later variant. Capture that listener and drive it before each render
 * so the `reducedMotion` axis is honoured for the whole campaign.
 */
let reduceMotionListener: ((value: boolean) => void) | null = null;
jest
  .spyOn(AccessibilityInfo, 'addEventListener')
  .mockImplementation((event, handler) => {
    if (event === 'reduceMotionChanged') {
      reduceMotionListener = handler as (value: boolean) => void;
    }
    return { remove: () => {} };
  });

async function driveReducedMotion(value: boolean): Promise<void> {
  if (!reduceMotionListener) return;
  const listener = reduceMotionListener;
  await act(async () => {
    listener(value);
  });
}

function pressableByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  id: string,
) {
  return renderer.root.findAll(
    node =>
      node.props.testID === id && typeof node.props.onPress === 'function',
  )[0];
}

async function renderVariant(variant: Variant): Promise<Outcome> {
  const rng = new Rng(variant.seed ^ 0x5bd1e995);
  const used: CorpusKey[] = [...variant.corpus];
  const consoleErrors: string[] = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 300),
      );
    });
  const warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        '[warn] ' +
          args
            .map(a => String(a))
            .join(' ')
            .slice(0, 300),
      );
    });
  const reduceSpy = jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockResolvedValue(variant.reducedMotion);
  await driveReducedMotion(variant.reducedMotion);
  const localeCounter = { calls: 0 };
  const restoreLocale = forceLocale(variant.locale, localeCounter);
  const announceSpy = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let crash: string | null = null;
  const input: Record<string, unknown> = {};
  const started = Date.now();
  let visibleText: string[] = [];
  let roots: HostNode[] = [];
  let textCount = 0;
  let hostNodes = 0;
  const a11yAll: A11yRecord[] = [];
  const layoutAll: LayoutIssue[] = [];

  const snapshot = (phase: string) => {
    if (!renderer) return;
    roots = hostTree(renderer);
    walk(roots, () => {
      hostNodes += 1;
    });
    const texts = allText(renderer);
    textCount += texts.length;
    visibleText = visibleText.concat(
      texts.map(t => `${phase}:${t.slice(0, 120)}`),
    );
    const audit = auditA11y(roots, variant.width, variant.fontScale);
    a11yAll.push(
      ...audit.records.map(r => ({
        ...r,
        testID: `${phase}:${r.testID ?? '-'}`,
      })),
    );
    layoutAll.push(
      ...audit.layout.map(l => ({ ...l, node: `${phase}:${l.node}` })),
    );
  };

  try {
    mockGetApiSession.mockImplementation(() => null);
    mockFetchPlayerRank.mockImplementation(async () => null);
    useRankCelebrationStore.setState({ current: null });

    if (variant.component === 'banner' || variant.component === 'card') {
      const facts = makeFacts(rng, used, variant.payload);
      const useServer = rng.bool(0.5);
      let server: ServerPlayerRank | null = null;
      if (useServer) {
        const generated = rng.bool(0.85)
          ? makeServerRank(rng, used, variant.payload)
          : null;
        // Mainline: the payload must survive the shipping parser, exactly as
        // it would coming off GET /v1/rank.
        server =
          variant.gate === 'parsed' && generated
            ? parseOrNull(generated)
            : generated;
        input.parserRejected =
          variant.gate === 'parsed' && generated !== null && server === null;
        mockGetApiSession.mockImplementation(() => SESSION);
        const reject = rng.bool(0.15);
        mockFetchPlayerRank.mockImplementation(async () => {
          if (reject) throw new Error('stress: rank fetch rejected');
          return server;
        });
        input.serverReject = reject;
      }
      input.facts = facts.length;
      input.factSample = facts.slice(0, 3);
      input.server = server;
      if (variant.component === 'banner') {
        // `streakDays` is `consistency.currentStreak` at the one call site
        // (HomeScreen.tsx:274) — computed locally, or parsed with
        // `finiteNumber` in src/progress/api.ts:111. Non-finite values are
        // therefore raw-gate only; negative and fractional ones are NOT
        // (the parser accepts any finite number).
        const streakDays = rng.pick(
          variant.gate === 'raw' ? STREAK_POOL_RAW : STREAK_POOL,
        );
        const streakAtRisk = rng.pick([true, false, undefined]);
        const onPressStreak = rng.bool(0.7) ? jest.fn() : undefined;
        input.streakDays = String(streakDays);
        input.streakAtRisk = streakAtRisk;
        input.onPressStreak = onPressStreak !== undefined;
        await act(async () => {
          renderer = TestRenderer.create(
            <PlayerRankBanner
              shots={facts as readonly PlayerRankFactLike[]}
              streakDays={streakDays}
              {...(streakAtRisk === undefined ? {} : { streakAtRisk })}
              {...(onPressStreak ? { onPressStreak } : {})}
            />,
          );
        });
        snapshot('folded');
        const toggle = renderer
          ? pressableByTestId(renderer, 'player-rank-banner-toggle')
          : undefined;
        if (toggle) {
          await act(async () => {
            toggle.props.onPress();
          });
          snapshot('expanded');
          const streak = renderer
            ? pressableByTestId(renderer, 'player-rank-banner-streak')
            : undefined;
          if (streak) {
            await act(async () => {
              streak.props.onPress();
            });
            input.streakPressCalls = onPressStreak
              ? onPressStreak.mock.calls.length
              : 'no-handler';
          }
          await act(async () => {
            toggle.props.onPress();
          });
          snapshot('refolded');
        }
      } else {
        await act(async () => {
          renderer = TestRenderer.create(<PlayerRankCard facts={facts} />);
        });
        snapshot('card');
        // Prop churn: a new facts identity re-runs the fetch path.
        await act(async () => {
          renderer?.update(<PlayerRankCard facts={[...facts]} />);
        });
        snapshot('card-refetch');
      }
    } else if (variant.component === 'icon') {
      const tier = rng.bool(0.7)
        ? rng.pick([...TIERS, null])
        : (rng.pick([
            ...INVALID_TIERS,
            undefined,
          ]) as unknown as PlayerRankTierKey);
      const size =
        rng.bool(0.6) || variant.gate === 'parsed'
          ? rng.pick([44, 46, 96, 120, 18, undefined])
          : rng.pick([
              0,
              -1,
              1,
              0.5,
              1e4,
              Number.NaN,
              Number.POSITIVE_INFINITY,
              undefined,
            ]);
      input.tier = tier === undefined ? 'undefined' : tier;
      input.size = size === undefined ? 'undefined' : String(size);
      await act(async () => {
        renderer = TestRenderer.create(
          <RankIcon tier={tier} {...(size === undefined ? {} : { size })} />,
        );
      });
      snapshot('icon');
      const svg = roots.find(r => r.type === 'RNSVGSvgView');
      input.svgLabel = svg?.props.accessibilityLabel ?? null;
      input.svgRole = svg?.props.accessibilityRole ?? null;
      if (svg && typeof svg.props.accessibilityLabel !== 'string') {
        layoutAll.push({
          kind: 'overflow',
          node: 'icon',
          detail: 'RNSVGSvgView has no accessibilityLabel',
        });
      }
    } else {
      const generated = makeSummary(rng, used, variant.payload);
      // Mainline: only summaries the app can actually hold — either derived
      // from a parser-accepted account payload or computed from local facts.
      const summary =
        variant.gate === 'raw'
          ? generated
          : reachableSummary(rng, used, variant.payload);
      const fromTier = rng.bool(0.5) ? null : rng.pick(TIERS);
      // `fromRating` comes from the stored rank record, which
      // `parseStoredRecord` (src/progress/rankCelebration.ts:72) accepts only
      // when it is a finite number — so non-finite values are raw-gate only.
      const ratingPool =
        variant.gate === 'raw' ? SCORE_BOUNDARY_POOL : SCORE_POOL;
      const fromRating =
        fromTier === null
          ? rng.bool(0.8)
            ? null
            : rng.pick(ratingPool)
          : rng.pick(ratingPool);
      input.summary = summary;
      input.fromTier = fromTier;
      input.fromRating = String(fromRating);
      useRankCelebrationStore.setState({
        current: { fromTier, toTier: summary.tier, fromRating, summary },
      });
      await act(async () => {
        renderer = TestRenderer.create(<RankUpCelebration />);
      });
      snapshot('celebration');
      input.announcements = announceSpy.mock.calls.map(c => String(c[0]));
      const dismissVia = rng.pick([
        'continue',
        'backdrop',
        'requestClose',
      ] as const);
      input.dismissVia = dismissVia;
      if (renderer) {
        const r: TestRenderer.ReactTestRenderer = renderer;
        if (dismissVia === 'continue') {
          const cta = pressableByTestId(r, 'rank-up-continue');
          if (cta)
            await act(async () => {
              cta.props.onPress();
            });
        } else if (dismissVia === 'backdrop') {
          const backdrop = r.root.findAll(
            n =>
              n.props.accessibilityLabel === 'Dismiss rank celebration' &&
              typeof n.props.onPress === 'function',
          )[0];
          if (backdrop)
            await act(async () => {
              backdrop.props.onPress();
            });
        } else {
          const modal = r.root.findAll(
            n => typeof n.props.onRequestClose === 'function',
          )[0];
          if (modal)
            await act(async () => {
              modal.props.onRequestClose();
            });
        }
        input.dismissed = useRankCelebrationStore.getState().current === null;
        snapshot('dismissed');
      }
    }
  } catch (error) {
    crash =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  } finally {
    try {
      if (renderer) {
        const r: TestRenderer.ReactTestRenderer = renderer;
        await act(async () => {
          r.unmount();
        });
      }
    } catch (error) {
      crash =
        crash ??
        `unmount: ${error instanceof Error ? error.message : String(error)}`;
    }
    restoreLocale();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    reduceSpy.mockRestore();
    announceSpy.mockRestore();
    useRankCelebrationStore.setState({ current: null });
  }
  const renderMs = Date.now() - started;

  const textLeaks = visibleText.filter(t => TEXT_LEAK.test(t));
  const reactErrors = consoleErrors.filter(
    m => !m.includes('not wrapped in act') && !m.startsWith('[warn]'),
  );
  const categories: string[] = [];
  if (crash) categories.push('crash');
  if (reactErrors.length) categories.push('console-error');
  if (textLeaks.length) categories.push('text-leak');
  if (a11yAll.some(r => r.unlabeled)) categories.push('a11y-unlabeled');
  if (a11yAll.some(r => r.proxyTargetOk === false))
    categories.push('a11y-target-proxy');
  if (layoutAll.some(l => l.kind === 'clip')) categories.push('clip-proxy');
  if (layoutAll.some(l => l.kind === 'overflow'))
    categories.push('overflow-proxy');
  const fatal = ['crash', 'console-error', 'a11y-unlabeled'];
  // A text leak only counts as BROKEN when the props went through the real
  // parsers, i.e. when the shipping app could hold those values.
  const broken = categories.some(
    c => fatal.includes(c) || (c === 'text-leak' && variant.gate === 'parsed'),
  );

  return {
    seed: variant.seed,
    component: variant.component,
    gate: variant.gate,
    tz: RUN_TZ,
    locale: variant.locale,
    fontScale: variant.fontScale,
    width: variant.width,
    reducedMotion: variant.reducedMotion,
    corpus: Array.from(new Set(used)),
    input,
    status: broken ? 'BROKEN' : 'HELD',
    categories,
    crash,
    consoleErrors,
    textLeaks,
    a11y: a11yAll,
    proxyLayout: layoutAll,
    localeCalls: localeCounter.calls,
    textCount,
    hostNodes,
    renderMs,
    visibleText,
  };
}

function variantFor(component: ComponentName, seed: number): Variant {
  const rng = new Rng(seed);
  return {
    component,
    seed,
    fontScale: rng.pick(FONT_SCALES),
    width: rng.pick(WIDTHS),
    locale: rng.pick(LOCALES),
    reducedMotion: rng.bool(0.3),
    corpus: [],
    payload: 'unicode',
    gate: 'parsed',
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const outcomes: Outcome[] = [];

function writeArtifacts() {
  if (!OUT_DIR) return;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(
    OUT_DIR,
    `cmp-rank-${RUN_TZ.replace(/[^A-Za-z0-9]+/g, '_')}-${process.pid}.json`,
  );
  const summary = {
    unit: 'cmp-rank',
    lens: 'boundary-i18n-a11y',
    tz: RUN_TZ,
    campaignSeed: CAMPAIGN_SEED,
    iterPerComponent: ITER,
    replaySeed: REPLAY_SEED,
    executed: outcomes.length,
    broken: outcomes.filter(o => o.status === 'BROKEN').length,
    categories: outcomes.reduce<Record<string, number>>((acc, o) => {
      for (const c of o.categories) acc[c] = (acc[c] ?? 0) + 1;
      return acc;
    }, {}),
    table: outcomes.map(o => ({
      seed: o.seed,
      component: o.component,
      gate: o.gate,
      status: o.status,
      categories: o.categories,
      fontScale: o.fontScale,
      width: o.width,
      locale: o.locale,
      tz: o.tz,
      reducedMotion: o.reducedMotion,
      corpus: o.corpus,
      renderMs: o.renderMs,
      hostNodes: o.hostNodes,
      textCount: o.textCount,
      localeCalls: o.localeCalls,
      crash: o.crash,
      textLeaks: o.textLeaks,
      consoleErrors: o.consoleErrors.slice(0, 3),
      a11y: o.a11y,
      proxyLayout: o.proxyLayout.slice(0, 12),
      input: o.input,
      replay: `STRESS_SEED=${o.seed} STRESS_ITER=1 npx jest --ci cmpRankBoundaryI18nA11y -t "${o.component}"`,
      proxyTargets: o.a11y.map(
        r =>
          `${r.testID}:${r.proxyBox.width}x${r.proxyBox.height}:${String(r.proxyTargetOk)}`,
      ),
    })),
    evidence: outcomes
      .filter(o => o.status === 'BROKEN' || o.categories.length > 0)
      .slice(0, 400)
      .map(o => ({
        seed: o.seed,
        component: o.component,
        categories: o.categories,
        visibleText: o.visibleText,
        input: o.input,
      })),
  };
  fs.writeFileSync(file, JSON.stringify(summary, null, 1));
}

afterAll(() => {
  writeArtifacts();
});

function hardErrors(outcome: Outcome): string[] {
  return outcome.consoleErrors.filter(
    m => !m.includes('not wrapped in act') && !m.startsWith('[warn]'),
  );
}

for (const component of COMPONENTS) {
  describe(`${component} seeded boundary/i18n/a11y campaign`, () => {
    const seeds =
      REPLAY_SEED !== null
        ? [REPLAY_SEED]
        : Array.from({ length: ITER }, (_, i) => seedFor(component, i));
    for (const seed of seeds) {
      it(`${component} seed=${seed} renders without crash, React error, text leak or unlabeled control`, async () => {
        const outcome = await renderVariant(variantFor(component, seed));
        outcomes.push(outcome);
        expect({
          seed,
          crash: outcome.crash,
          consoleErrors: hardErrors(outcome),
          textLeaks: outcome.textLeaks,
          unlabeled: outcome.a11y.filter(r => r.unlabeled),
        }).toEqual({
          seed,
          crash: null,
          consoleErrors: [],
          textLeaks: [],
          unlabeled: [],
        });
      });
    }
  });
}

/**
 * Parser-bypass campaign: the same generators, but the props are handed to
 * the components WITHOUT `parsePlayerRank` / `summaryFromServer` in front of
 * them — non-finite ratings, NaN technique counts, garbage tier strings.
 * Nothing here is reachable while the parsers hold (they reject non-finite
 * numbers and out-of-range ratings), so a raw-mode leak is defense-in-depth
 * evidence, not a shipping defect: the assertion is that the surfaces still
 * do not CRASH, log a React error, or lose a control's role/label. Any
 * NaN/Infinity copy is recorded in the artifact and pinned by the dedicated
 * test below.
 */
for (const component of COMPONENTS) {
  describe(`${component} parser-bypass (raw props) campaign`, () => {
    const seeds =
      REPLAY_SEED !== null
        ? [REPLAY_SEED]
        : Array.from({ length: Math.max(1, Math.round(ITER / 2)) }, (_, i) =>
            seedFor(component, i + 1000),
          );
    for (const seed of seeds) {
      it(`${component} raw seed=${seed} survives unparsed props with every control labelled`, async () => {
        const outcome = await renderVariant({
          ...variantFor(component, seed),
          gate: 'raw',
        });
        outcomes.push(outcome);
        expect({
          seed,
          crash: outcome.crash,
          consoleErrors: hardErrors(outcome),
          unlabeled: outcome.a11y.filter(r => r.unlabeled),
        }).toEqual({ seed, crash: null, consoleErrors: [], unlabeled: [] });
      });
    }
  });
}

/**
 * The rank surfaces render no locale-formatted number or date, so with the
 * shipping `SHOT_TYPES` slugs the copy the user sees must be identical under
 * every locale — including the order, because ASCII slugs collate the same
 * way in all twelve. (Technique lists ARE sorted through
 * `shotType.localeCompare(...)` — `packages/shared-types/src/playerRank.ts`
 * and `src/progress/playerRank.ts` `summaryFromServer` — so a non-ASCII
 * label CAN reorder or, past the banner's `slice(0, 6)`, change which chips
 * appear.)
 */
describe('locale invariance (12 locales)', () => {
  it('banner + card + celebration render the same copy under every locale', async () => {
    const seed = REPLAY_SEED ?? seedFor('banner', 0);
    const byLocale: Record<string, string[]> = {};
    for (const locale of LOCALES) {
      const texts: string[] = [];
      for (const component of ['banner', 'card', 'celebration'] as const) {
        const variant: Variant = {
          ...variantFor(component, seed),
          locale,
          fontScale: 1,
          width: 375,
          payload: 'real',
          gate: 'parsed',
        };
        const outcome = await renderVariant(variant);
        outcomes.push(outcome);
        texts.push(...outcome.visibleText);
      }
      byLocale[locale] = texts;
    }
    const referenceLocale = LOCALES[0];
    const reference = byLocale[referenceLocale] ?? [];
    for (const locale of LOCALES) {
      const texts = byLocale[locale] ?? [];
      expect({ locale, copy: texts }).toEqual({ locale, copy: reference });
    }
  });
});

/**
 * Non-finite numerics reach the copy verbatim once the parsers are bypassed:
 * a NaN `techniqueCount` prints "across NaN techniques"
 * (RankUpCelebration.tsx:430) and a non-finite technique score prints
 * "Infinity" in a chip (PlayerRankCard.tsx:179, PlayerRankBanner.tsx:354).
 * `parsePlayerRank` (src/progress/playerRank.ts:83-119) refuses those values
 * and `computePlayerRank` only ever produces finite ones, so this is a
 * guard-depth note, pinned so a parser regression shows up as user-visible
 * copy rather than passing silently.
 */
describe('non-finite numerics in unparsed props', () => {
  it('prints NaN/Infinity in copy when a summary bypasses the parsers', async () => {
    const summary: PlayerRankSummary = {
      rating: Number.POSITIVE_INFINITY,
      tier: 'diamond',
      tierLabel: 'Diamond',
      division: 3,
      divisionLabel: 'III',
      techniqueCount: Number.NaN,
      scoredAnalysisCount: Number.NaN,
      techniques: [
        {
          shotType: 'dink',
          score: Number.POSITIVE_INFINITY,
          capturedAt: '2026-08-10T10:00:00Z',
          sampledCount: 3,
        },
      ],
      nextTier: null,
    };
    // Reduce-motion decides what the rating numeral shows on first paint:
    // the final value (Infinity) when reduced, `fromRating ?? 0` while the
    // count-up is still pending otherwise. Both branches are driven
    // explicitly rather than inherited from whatever mounted first.
    const leaksFor = async (reduced: boolean): Promise<string[]> => {
      const spy = jest
        .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
        .mockResolvedValue(reduced);
      await driveReducedMotion(reduced);
      useRankCelebrationStore.setState({
        current: {
          fromTier: null,
          toTier: 'diamond',
          fromRating: null,
          summary,
        },
      });
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(<RankUpCelebration />);
      });
      const copy = allText(renderer);
      await act(async () => {
        renderer.unmount();
      });
      useRankCelebrationStore.setState({ current: null });
      spy.mockRestore();
      return copy.filter(t => TEXT_LEAK.test(t));
    };
    const NAN_COPY =
      'Your current form across NaN techniques — recent swings count most.';
    expect({
      reduced: await leaksFor(true),
      animated: await leaksFor(false),
    }).toEqual({
      reduced: ['Infinity', NAN_COPY],
      animated: [NAN_COPY],
    });
  });
});

/**
 * Duplicate technique keys. The chips are keyed by `shotType`
 * (PlayerRankBanner.tsx:354, PlayerRankCard.tsx:179), and
 * `parsePlayerRank` does not de-duplicate. `public.player_technique_rating`
 * groups by `(user_id, shot_type)`, so the real API cannot emit a duplicate;
 * a hostile/garbled payload can, and React then logs a duplicate-key error
 * and may omit a row. This test records that behaviour rather than claiming
 * the surface is immune.
 */
describe('duplicate technique key from a malformed payload', () => {
  it('renders both duplicate chips but logs React duplicate-key errors', async () => {
    const errors: string[] = [];
    const errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        errors.push(String(args[0]));
      });
    const facts: RealAnalysisFact[] = [];
    const duplicated: ServerPlayerRank = {
      rating: 7.6,
      tier: 'diamond',
      techniqueCount: 2,
      scoredShotCount: 12,
      updatedAt: '2026-08-10T10:00:00Z',
      techniques: [
        { shotType: 'dink', score: 7.6, capturedAt: '2026-08-10T10:00:00Z' },
        { shotType: 'dink', score: 7.6, capturedAt: '2026-08-11T10:00:00Z' },
      ],
    };
    mockGetApiSession.mockImplementation(() => SESSION);
    mockFetchPlayerRank.mockImplementation(async () => duplicated);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<PlayerRankCard facts={facts} />);
    });
    const chips = allText(renderer).filter(t => t.includes('dink'));
    await act(async () => {
      renderer.unmount();
    });
    errorSpy.mockRestore();
    mockGetApiSession.mockImplementation(() => null);
    mockFetchPlayerRank.mockImplementation(async () => null);
    expect({
      chips: chips.length,
      duplicateKeyErrors: errors.filter(m => m.includes('same key')).length > 0,
    }).toEqual({ chips: 2, duplicateKeyErrors: true });
  });
});

describe('static i18n surface check', () => {
  it('the four rank components call no locale- or zone-sensitive formatting API', () => {
    const files = [
      'PlayerRankBanner.tsx',
      'PlayerRankCard.tsx',
      'RankIcon.tsx',
      'RankUpCelebration.tsx',
    ].map(f => path.join(__dirname, '..', '..', 'src', 'components', f));
    const forbidden =
      /toLocale(Date|Time)?String|Intl\.|localeCompare|getTimezoneOffset|toDateString|toTimeString/;
    const hits = files
      .map(f => ({
        f: path.basename(f),
        lines: fs
          .readFileSync(f, 'utf8')
          .split('\n')
          .map((l, i) => (forbidden.test(l) ? `${i + 1}: ${l.trim()}` : null))
          .filter(Boolean),
      }))
      .filter(h => h.lines.length > 0);
    expect(hits).toEqual([]);
  });
});
