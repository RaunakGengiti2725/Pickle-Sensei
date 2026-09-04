/**
 * STRESS HARNESS — unit `cmp-consistency-ui`, lens `boundary-i18n-a11y`.
 *
 * Components under test: AchievementsShowcase, ConsistencyCard,
 * DaySecuredBanner, FlameIcon/AnimatedFlame, MilestoneBadge,
 * StreakCelebration (apps/mobile/src/consistency/*).
 *
 * Every variant is generated from a 32-bit seed by a deterministic RNG
 * (mulberry32) and is replayable on its own. The campaign is a grid over
 * component × font scale × window width (54 cells) with the remaining
 * dimensions (locale, snapshot zone, string corpus, numeric corpus, reduced
 * motion, safe-area inset, …) drawn from the variant's RNG.
 *
 *   Default campaign (fast enough for the suite; 180 variants):
 *     cd apps/mobile && npx jest --ci __tests__/stress/cmpConsistencyUi.boundaryI18nA11y.stress.test.tsx
 *   Bigger campaign / other base seed:
 *     STRESS_ITER=1000 STRESS_SEED=7 npx jest --ci __tests__/stress/cmpConsistencyUi.boundaryI18nA11y.stress.test.tsx
 *   Replay ONE variant by its seed (as printed in the results table):
 *     STRESS_REPLAY=123456789 npx jest --ci __tests__/stress/cmpConsistencyUi.boundaryI18nA11y.stress.test.tsx
 *   Device time zone — Jest sandboxes `process.env`, so the DEVICE zone is a
 *   per-process property (see adjudicateXcUxA11yI18nLocale.test.ts); the
 *   SNAPSHOT zone is varied in-process. Run the campaign once per zone:
 *     TZ=Pacific/Kiritimati npx jest --ci __tests__/stress/cmpConsistencyUi.boundaryI18nA11y.stress.test.tsx
 *   Results table (seed → outcome) is written as JSON to STRESS_OUT when set:
 *     STRESS_OUT=/tmp/cmp-consistency-ui.json npx jest --ci …
 *
 * Outcome vocabulary (per variant row):
 *   HELD   — every hard invariant passed (rendered, no throw, every pressable
 *            has role + non-empty label, no `NaN`/`undefined`/`null` leaked
 *            into visible copy or labels for in-contract inputs, declared
 *            target ≥ 44pt, dismissal paths work, day labels are
 *            device-zone independent).
 *   BROKEN — a hard invariant failed (the jest test for that seed fails).
 *   Additionally each row carries `observations`: MODEL-based signals that
 *   Linux/Jest cannot prove (text overflow of `numberOfLines={1}` copy, the
 *   modal's vertical budget, iOS live-region semantics). They never fail the
 *   suite; they are evidence for the report, labelled INFERRED.
 *
 * Nothing here mutates production code or existing tests.
 */
import React from 'react';
import {
  AccessibilityInfo,
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';

// The consistency store persists through SQLite; the native module is absent
// under jest and this harness drives overlays through store state only.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

let mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return {
    SafeAreaView: View,
    useSafeAreaInsets: () => mockInsets,
    initialWindowMetrics: null,
  };
});

let mockWindow = { width: 375, height: 667, scale: 3, fontScale: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => mockWindow,
}));

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => {
  const actual = jest.requireActual<
    typeof import('../../src/design/components')
  >('../../src/design/components');
  return { ...actual, useReducedMotion: () => mockReducedMotion };
});

import { AchievementsShowcase } from '../../src/consistency/AchievementsShowcase';
import { ConsistencyCard } from '../../src/consistency/ConsistencyCard';
import { DaySecuredBanner } from '../../src/consistency/DaySecuredBanner';
import {
  AnimatedFlame,
  FlameIcon,
  type FlameIntensity,
} from '../../src/consistency/FlameIcon';
import {
  MilestoneBadge,
  type BadgeGlyph,
} from '../../src/consistency/MilestoneBadge';
import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from '../../src/consistency/engine';
import {
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  type AchievementRarity,
} from '../../src/consistency/milestones';
import {
  useConsistencyStore,
  type ConsistencyCelebration,
  type DaySecuredMoment,
} from '../../src/consistency/store';
import { space, type } from '../../src/design/tokens';
import { setActiveDataOwner } from '../../src/data/accountScope';

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { dirname } = require('path') as { dirname: (path: string) => string };

// ---------------------------------------------------------------------------
// Campaign configuration
// ---------------------------------------------------------------------------

const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904) >>> 0;
const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 180));
const REPLAY = process.env.STRESS_REPLAY
  ? Number(process.env.STRESS_REPLAY) >>> 0
  : null;
const OUT_PATH = process.env.STRESS_OUT ?? null;
const DEVICE_TZ = process.env.TZ ?? '(process default)';

const COMPONENTS = [
  'AchievementsShowcase',
  'ConsistencyCard',
  'DaySecuredBanner',
  'FlameIcon',
  'MilestoneBadge',
  'StreakCelebration',
] as const;
type ComponentName = (typeof COMPONENTS)[number];

/** iOS Dynamic Type proxies: Large (default), AX1-ish, AX3-ish. */
const FONT_SCALES = [1, 1.5, 2.35] as const;
/** iPhone SE / 13 mini / 16 Pro Max portrait points. */
const WINDOWS = [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 430, height: 932 },
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

/** Snapshot zones: UTC, the ±extremes, half/quarter-hour offsets and DST
 * edge zones with `asOf` instants that sit on their 2026 transitions. */
const ZONES: ReadonlyArray<{ tz: string; asOfIso: string; note: string }> = [
  { tz: 'UTC', asOfIso: '2026-03-10T18:00:00.000Z', note: 'reference' },
  {
    tz: 'Pacific/Kiritimati',
    asOfIso: '2026-03-10T10:30:00.000Z',
    note: 'UTC+14 — already tomorrow',
  },
  {
    tz: 'Etc/GMT+12',
    asOfIso: '2026-03-10T11:30:00.000Z',
    note: 'UTC-12 — still yesterday',
  },
  {
    tz: 'America/New_York',
    asOfIso: '2026-03-08T07:30:00.000Z',
    note: 'DST start 02:00→03:00 local, 30 min after the jump',
  },
  {
    tz: 'Europe/Berlin',
    asOfIso: '2026-03-29T00:59:30.000Z',
    note: 'DST start, 30 s before the jump',
  },
  {
    tz: 'Australia/Sydney',
    asOfIso: '2026-04-04T16:30:00.000Z',
    note: 'DST end 03:00→02:00 local, inside the repeated hour',
  },
  {
    tz: 'America/Santiago',
    asOfIso: '2026-04-05T03:00:00.000Z',
    note: 'southern DST end at local midnight (day boundary moves)',
  },
  {
    tz: 'Asia/Kathmandu',
    asOfIso: '2026-03-10T18:14:59.000Z',
    note: 'UTC+5:45 — 1 s before local midnight',
  },
];

/** Hostile / boundary string corpus. `contract: 'in'` strings are values the
 * production data model can actually produce (milestone copy, shot-type
 * details); `'out'` strings are pure boundary probes. */
const STRINGS: ReadonlyArray<{
  id: string;
  value: string;
  contract: 'in' | 'out';
}> = [
  { id: 'milestone', value: 'Fortnight Form', contract: 'in' },
  { id: 'specialistTitle', value: 'forehand_drive', contract: 'in' },
  {
    id: 'long220',
    value:
      'Consistency compounds quietly until one morning the whole court feels smaller and every dink lands where you meant it to land, which is exactly what two hundred and twenty characters of reward copy looks like in practice today.',
    contract: 'out',
  },
  {
    id: 'cjk',
    value:
      '連続トレーニング百日達成おめでとうございます。継続は力なり。毎日の練習が技術を磨き、コートでの自信を育てます。',
    contract: 'out',
  },
  {
    id: 'arabicRtl',
    value: 'تهانينا! لقد حافظت على سلسلة التدريب لمدة ثلاثين يومًا متواصلة',
    contract: 'out',
  },
  { id: 'zwjEmoji', value: '👨‍👩‍👧‍👦🏳️‍🌈🧑🏽‍🚀🏓🔥', contract: 'out' },
  {
    id: 'combining',
    value: 'Z̷̢̈́a̶̡̮͝l̸̰̃g̴̭̈o̷͎̓ S̴t̷r̸e̶a̵k̶ Ǫ̈ ệ ṩ',
    contract: 'out',
  },
  {
    id: 'germanCompound',
    value:
      'Donaudampfschifffahrtsgesellschaftskapitänsstreakauszeichnungsverleihung',
    contract: 'out',
  },
  {
    id: 'thai',
    value: 'ยินดีด้วยคุณฝึกซ้อมติดต่อกันครบสามสิบวัน',
    contract: 'out',
  },
  { id: 'hindi', value: 'लगातार तीस दिन प्रशिक्षण पूरा हुआ', contract: 'out' },
  { id: 'russian', value: 'Тридцать дней подряд тренировок', contract: 'out' },
  { id: 'bidiMixed', value: 'Day 30 — ثلاثون يومًا — done', contract: 'out' },
  { id: 'bidiControl', value: '\u202Ereversed\u202C label', contract: 'out' },
  { id: 'empty', value: '', contract: 'out' },
  { id: 'whitespace', value: '   ', contract: 'out' },
];

/** Numeric corpus. `in` = producible by the engine (non-negative finite
 * integers); `out` = negative, fractional, huge or non-finite probes. */
const NUMERICS: ReadonlyArray<{
  id: string;
  value: number;
  contract: 'in' | 'out';
}> = [
  { id: 'zero', value: 0, contract: 'in' },
  { id: 'one', value: 1, contract: 'in' },
  { id: 'seven', value: 7, contract: 'in' },
  { id: 'thirty', value: 30, contract: 'in' },
  { id: 'year', value: 365, contract: 'in' },
  { id: 'big', value: 100000, contract: 'in' },
  { id: 'maxSafe', value: Number.MAX_SAFE_INTEGER, contract: 'in' },
  { id: 'negOne', value: -1, contract: 'out' },
  { id: 'negBig', value: -999999, contract: 'out' },
  { id: 'fraction', value: 0.5, contract: 'out' },
  { id: 'exp', value: 1e21, contract: 'out' },
  { id: 'nan', value: Number.NaN, contract: 'out' },
  { id: 'inf', value: Number.POSITIVE_INFINITY, contract: 'out' },
];

const RARITIES: readonly AchievementRarity[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
];
const GLYPHS: readonly BadgeGlyph[] = [
  'spark',
  'triFlame',
  'shieldFlame',
  'paddles',
  'laurel',
  'comet',
  'crown',
  'phoenix',
  'medal',
  'target',
];
const BADGE_SIZES = [0, 1, 8, 24, 64, 72, 148, 1000] as const;
const FLAME_SIZES = [0, 1, 13, 22, 26, 34, 500] as const;

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

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

/** Variant seed for iteration `i` of a campaign rooted at `base`. */
function variantSeed(base: number, i: number): number {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (i + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  bool(pTrue = 0.5): boolean {
    return this.next() < pTrue;
  }
}

// ---------------------------------------------------------------------------
// Variant model
// ---------------------------------------------------------------------------

interface Variant {
  seed: number;
  index: number;
  component: ComponentName;
  fontScale: number;
  window: { width: number; height: number };
  locale: string;
  zone: (typeof ZONES)[number];
  reducedMotion: boolean;
  bottomInset: number;
  dark: boolean;
  string: (typeof STRINGS)[number];
  numeric: (typeof NUMERICS)[number];
  numeric2: (typeof NUMERICS)[number];
  rarity: AchievementRarity;
  glyph: BadgeGlyph;
  badgeSize: number;
  flameSize: number;
  intensity: FlameIntensity;
  earned: boolean;
  /** Streak length used to build engine snapshots (0 = fresh account). */
  streakLen: number;
  /** Which shape of snapshot/moment the component receives. */
  shape: 'null' | 'engine' | 'synthetic';
}

const STREAK_LENGTHS = [
  0, 1, 2, 3, 6, 7, 13, 14, 29, 30, 59, 60, 99, 100, 364, 365, 400,
] as const;

function makeVariant(seed: number, index: number): Variant {
  const rng = new Rng(seed);
  const cell =
    index % (COMPONENTS.length * FONT_SCALES.length * WINDOWS.length);
  const component = COMPONENTS[cell % COMPONENTS.length]!;
  const fontScale =
    FONT_SCALES[Math.floor(cell / COMPONENTS.length) % FONT_SCALES.length]!;
  const window =
    WINDOWS[
      Math.floor(cell / (COMPONENTS.length * FONT_SCALES.length)) %
        WINDOWS.length
    ]!;
  const shapeRoll = rng.int(10);
  return {
    seed,
    index,
    component,
    fontScale,
    window,
    locale: rng.pick(LOCALES),
    zone: rng.pick(ZONES),
    reducedMotion: rng.bool(0.35),
    bottomInset: rng.pick([0, 20, 34] as const),
    dark: rng.bool(),
    string: rng.pick(STRINGS),
    numeric: rng.pick(NUMERICS),
    numeric2: rng.pick(NUMERICS),
    rarity: rng.pick(RARITIES),
    glyph: rng.pick(GLYPHS),
    badgeSize: rng.pick(BADGE_SIZES),
    flameSize: rng.pick(FLAME_SIZES),
    intensity: rng.int(6) as FlameIntensity,
    earned: rng.bool(),
    streakLen: rng.pick(STREAK_LENGTHS),
    shape: shapeRoll < 1 ? 'null' : shapeRoll < 6 ? 'engine' : 'synthetic',
  };
}

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

function flatten(style: StyleProp<ViewStyle | TextStyle>) {
  return (StyleSheet.flatten(style) ?? {}) as ViewStyle & TextStyle;
}

function textOf(node: ReactTestInstance): string {
  const collect = (child: unknown): string => {
    if (child == null || typeof child === 'boolean') return '';
    if (typeof child === 'string' || typeof child === 'number')
      return String(child);
    if (Array.isArray(child)) return child.map(collect).join('');
    return '';
  };
  return collect(node.props.children);
}

function allTexts(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAllByType(Text);
}

function visibleCopy(root: ReactTestInstance): string {
  return allTexts(root).map(textOf).join(' | ').replace(/\s+/g, ' ');
}

/** Interactive host nodes: RN's Pressable renders a host `View` carrying the
 * pressability responder handlers plus the RESOLVED accessibility props and
 * style — exactly what the native accessibility tree sees. */
function pressables(root: ReactTestInstance): ReactTestInstance[] {
  return root.findAll(
    node =>
      typeof node.type === 'string' &&
      (typeof node.props?.onClick === 'function' ||
        typeof node.props?.onResponderRelease === 'function'),
  );
}

/** Innermost composite per pressable (RN's `Pressable` element, which
 * carries the resolved testID/label/onPress); one per host pressable, in
 * the same document order as `pressables()`. */
function pressTargets(root: ReactTestInstance): ReactTestInstance[] {
  const found = root.findAll(
    node =>
      typeof node.props?.onPress === 'function' &&
      typeof node.type !== 'string',
  );
  return found.filter(
    node =>
      node.findAll(
        child =>
          child !== node &&
          typeof child.type !== 'string' &&
          child.props?.onPress === node.props.onPress,
      ).length === 0,
  );
}

/** Style-declared minimum tap dimension (points) or null when nothing in the
 * style pins it (the target is then content-sized — see the per-component
 * models below). */
function declaredMinDimension(style: StyleProp<ViewStyle>): number | null {
  const flat = flatten(style);
  const dims = [flat.width, flat.height, flat.minHeight, flat.minWidth].filter(
    (v): v is number => typeof v === 'number',
  );
  if (dims.length === 0) return null;
  return Math.min(...dims);
}

const LEAK_RE = /\b(NaN|undefined|null|Infinity|-Infinity)\b|\[object Object\]/;

// ---------------------------------------------------------------------------
// Text-width model (INFERRED; Linux cannot rasterize Manrope). Widths are
// per-code-point em fractions — deliberately on the NARROW side so that a
// model overflow is a conservative signal.
// ---------------------------------------------------------------------------

function glyphEm(cp: number): number {
  if (cp === 0x20) return 0.26;
  if (cp === 0x200d || cp === 0x200c || cp === 0xfe0f) return 0; // ZWJ/ZWNJ/VS16
  if (cp >= 0x202a && cp <= 0x202e) return 0; // bidi controls
  if (cp >= 0x0300 && cp <= 0x036f) return 0; // combining diacriticals
  if (cp >= 0x1ab0 && cp <= 0x1aff) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
  if (cp >= 0x0e31 && cp <= 0x0e3a) return 0; // Thai vowels/tone marks above/below
  if (cp >= 0x0e47 && cp <= 0x0e4e) return 0;
  if (cp >= 0x093c && cp <= 0x094d) return 0; // Devanagari signs
  if (cp >= 0x1f300 && cp <= 0x1faff) return 1.2; // emoji
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 1.2;
  if (cp >= 0x2600 && cp <= 0x27bf) return 1.0;
  if (cp >= 0x1100 && cp <= 0x11ff) return 1.0; // Hangul Jamo
  if (cp >= 0x2e80 && cp <= 0x9fff) return 1.0; // CJK
  if (cp >= 0xac00 && cp <= 0xd7af) return 1.0;
  if (cp >= 0xf900 && cp <= 0xfaff) return 1.0;
  if (cp >= 0xff00 && cp <= 0xff60) return 1.0; // fullwidth forms
  if (cp >= 0x0600 && cp <= 0x06ff) return 0.5; // Arabic
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 0.5; // Thai base
  if (cp >= 0x0900 && cp <= 0x097f) return 0.55; // Devanagari base
  if (cp >= 0x0400 && cp <= 0x04ff) return 0.52; // Cyrillic
  if (cp >= 0x30 && cp <= 0x39) return 0.55; // digits
  if (cp >= 0x41 && cp <= 0x5a) return 0.6; // Latin caps
  if (cp === 0x2014 || cp === 0x2013) return 0.7; // em/en dash
  if (cp === 0x2e || cp === 0x2c || cp === 0x27 || cp === 0x3a) return 0.25;
  if (cp === 0x69 || cp === 0x6c || cp === 0x6a || cp === 0x74 || cp === 0x66)
    return 0.28; // i l j t f
  if (cp === 0x6d || cp === 0x77) return 0.75; // m w
  return 0.5; // other Latin lowercase / punctuation
}

function modelTextWidth(
  text: string,
  fontSize: number,
  letterSpacing: number,
  fontScale: number,
): number {
  let em = 0;
  let glyphs = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const w = glyphEm(cp);
    em += w;
    if (w > 0) glyphs += 1;
  }
  return em * fontSize * fontScale + Math.max(0, glyphs - 1) * letterSpacing;
}

// ---------------------------------------------------------------------------
// Locale shim — a device whose default locale is `locale`. Production code
// formats earned days with `toLocaleDateString(undefined, …)` (engine
// formatDayKey), i.e. the platform default; Node's ICU stands in for Hermes.
// ---------------------------------------------------------------------------

let currentLocale: string = 'en-US';
const originalToLocaleDateString = Date.prototype.toLocaleDateString;

beforeAll(() => {
  // A signed-in local owner: `consumeDaySecured` returns null when signed out.
  setActiveDataOwner('7f3d2c1b-0a9e-4f8d-8c7b-6a5e4d3c2b1a');
  Date.prototype.toLocaleDateString = function shimmed(
    this: Date,
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ) {
    return originalToLocaleDateString.call(
      this,
      locales ?? currentLocale,
      options,
    );
  } as typeof Date.prototype.toLocaleDateString;
});

afterAll(() => {
  Date.prototype.toLocaleDateString = originalToLocaleDateString;
});

// ---------------------------------------------------------------------------
// Snapshot / moment builders
// ---------------------------------------------------------------------------

const SHOT_TYPES = ['dink', 'forehand_drive', 'serve', 'third_shot_drop'];

/** `streakLen` consecutive trained days ending on the snapshot's `asOf` day
 * (in the snapshot zone), plus `extraSameDay` more activities on the last
 * day. Activities land at a random local hour so the day-bucketing is the
 * engine's job, not the harness's. */
function engineSnapshot(v: Variant, rng: Rng): ConsistencySnapshot {
  const asOfMs = Date.parse(v.zone.asOfIso);
  const activities: TrainingActivityInput[] = [];
  const shot = SHOT_TYPES[rng.int(SHOT_TYPES.length)]!;
  // 30%: the run ended yesterday → live streak, nothing today (`atRisk`).
  const atRisk = v.streakLen > 0 && rng.bool(0.3);
  const firstDay = atRisk ? 1 : 0;
  for (let d = firstDay; d < v.streakLen + firstDay; d += 1) {
    // Anchor each day 24h earlier; jitter ±5h keeps it inside the same
    // local day for every zone in ZONES except at the transitions we WANT
    // to probe (that is the point).
    const jitterMs = (rng.int(11) - 5) * 3_600_000;
    const atMs = asOfMs - d * 86_400_000 + jitterMs;
    activities.push({
      kind: 'stroke',
      atIso: new Date(atMs).toISOString(),
      shotType: rng.bool(0.7) ? shot : SHOT_TYPES[rng.int(SHOT_TYPES.length)],
      overallScore: 5 + rng.int(5),
      resultKind: 'scored',
    });
  }
  const extra = atRisk ? 0 : rng.int(4);
  for (let k = 0; k < extra; k += 1) {
    activities.push({
      kind: 'drill',
      atIso: new Date(asOfMs - k * 60_000).toISOString(),
      label: v.string.value,
    });
  }
  if (v.streakLen >= 30 && rng.bool(0.5)) {
    // Push a technique past the Specialist threshold.
    for (let k = 0; k < 26; k += 1) {
      activities.push({
        kind: 'stroke',
        atIso: new Date(
          asOfMs - firstDay * 86_400_000 - k * 120_000,
        ).toISOString(),
        shotType: shot,
        overallScore: 7,
        resultKind: 'scored',
      });
    }
  }
  return buildConsistencySnapshot(activities, {
    asOfIso: v.zone.asOfIso,
    timeZone: v.zone.tz,
  });
}

/** Boundary snapshot: engine shape with hostile numerics/strings injected.
 * `contract: 'out'` when any injected value is outside what the engine can
 * produce. */
function syntheticSnapshot(v: Variant): {
  snapshot: ConsistencySnapshot;
  contract: 'in' | 'out';
} {
  const n = v.numeric.value;
  const m = v.numeric2.value;
  const base = buildConsistencySnapshot([], {
    asOfIso: v.zone.asOfIso,
    timeZone: v.zone.tz,
  });
  const nextTitle = v.string.value;
  const snapshot: ConsistencySnapshot = {
    ...base,
    currentStreak: n,
    longestStreak: n,
    trainedToday: v.earned,
    atRisk: !v.earned && n > 0,
    totalActivities: m,
    trainedLast7: Math.min(
      7,
      Math.max(0, Math.round(Number.isFinite(m) ? m : 0)),
    ),
    shieldsAvailable: v.numeric.id === 'zero' ? 0 : 2,
    momentumXp: m,
    momentum: { level: n, xpIntoLevel: m, xpForNextLevel: n },
    earned: v.earned
      ? [
          { id: 'streak.1', earnedOnDay: base.asOfDay },
          { id: 'streak.3', earnedOnDay: '' },
          {
            id: 'volume.specialist',
            earnedOnDay: 'not-a-day',
            detail: v.string.value,
          },
        ]
      : [],
    nextStreakMilestone: {
      ...STREAK_MILESTONES[2]!,
      title: nextTitle,
      daysAway: m,
    },
  };
  return {
    snapshot,
    contract:
      v.numeric.contract === 'in' &&
      v.numeric2.contract === 'in' &&
      v.string.contract === 'in' &&
      !v.earned
        ? 'in'
        : 'out',
  };
}

function daySecuredMoment(v: Variant): {
  moment: DaySecuredMoment;
  contract: 'in' | 'out';
} {
  const realistic = v.shape !== 'synthetic';
  const moment: DaySecuredMoment = realistic
    ? {
        day: '2026-03-10',
        streak: v.streakLen,
        xpToday: 20 + (v.streakLen % 4) * 5,
        shieldsAvailable: v.streakLen >= 7 ? 1 : 0,
        nextMilestone:
          STREAK_MILESTONES.find(mm => mm.days > v.streakLen) === undefined
            ? null
            : {
                title: STREAK_MILESTONES.find(mm => mm.days > v.streakLen)!
                  .title,
                daysAway:
                  STREAK_MILESTONES.find(mm => mm.days > v.streakLen)!.days -
                  v.streakLen,
              },
      }
    : {
        day: '2026-03-10',
        streak: v.numeric.value,
        xpToday: v.numeric2.value,
        shieldsAvailable: 0,
        nextMilestone:
          v.string.id === 'empty' && v.earned
            ? null
            : { title: v.string.value, daysAway: v.numeric2.value },
      };
  return {
    moment,
    contract: realistic
      ? 'in'
      : v.numeric.contract === 'in' &&
          v.numeric2.contract === 'in' &&
          v.string.contract === 'in'
        ? 'in'
        : 'out',
  };
}

function celebration(v: Variant): {
  celebration: ConsistencyCelebration;
  contract: 'in' | 'out';
} {
  if (v.shape !== 'synthetic') {
    const milestone =
      STREAK_MILESTONES[v.streakLen % STREAK_MILESTONES.length]!;
    const volume = v.earned;
    if (volume) {
      const specialist = v.streakLen % 2 === 0;
      return {
        contract: 'in',
        celebration: {
          kind: 'volume',
          achievementId: specialist
            ? VOLUME_ACHIEVEMENTS.specialist.id
            : VOLUME_ACHIEVEMENTS.sessions100.id,
          title: specialist
            ? VOLUME_ACHIEVEMENTS.specialist.title
            : VOLUME_ACHIEVEMENTS.sessions100.title,
          blurb: specialist
            ? VOLUME_ACHIEVEMENTS.specialist.blurb
            : VOLUME_ACHIEVEMENTS.sessions100.blurb,
          reward: specialist
            ? VOLUME_ACHIEVEMENTS.specialist.reward
            : VOLUME_ACHIEVEMENTS.sessions100.reward,
          rarity: 'rare',
          value: specialist ? 25 : 100,
          streakAtCelebration: v.streakLen,
          ...(specialist ? { detail: 'forehand drive' } : {}),
        },
      };
    }
    return {
      contract: 'in',
      celebration: {
        kind: 'streak',
        achievementId: milestone.id,
        title: milestone.title,
        blurb: milestone.blurb,
        reward: milestone.reward,
        rarity: milestone.rarity,
        value: milestone.days,
        streakAtCelebration: milestone.days,
      },
    };
  }
  return {
    contract:
      v.numeric.contract === 'in' && v.string.contract === 'in' ? 'in' : 'out',
    celebration: {
      kind: v.earned ? 'volume' : 'streak',
      achievementId: v.earned ? VOLUME_ACHIEVEMENTS.specialist.id : 'streak.30',
      title: v.string.value,
      blurb: v.string.value,
      reward: v.string.value,
      rarity: v.rarity,
      value: v.numeric.value,
      streakAtCelebration: v.numeric.value,
      ...(v.earned ? { detail: v.string.value } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Result rows
// ---------------------------------------------------------------------------

interface Observation {
  kind:
    | 'textOverflowModel'
    | 'modalVerticalBudgetModel'
    | 'iosLiveRegionOnly'
    | 'labelTrailingSpace'
    | 'outOfContractLeak'
    | 'pressableUnsizedByStyle';
  detail: string;
}

interface Row {
  seed: number;
  index: number;
  component: ComponentName;
  fontScale: number;
  window: { width: number; height: number };
  locale: string;
  snapshotZone: string;
  deviceZone: string;
  reducedMotion: boolean;
  bottomInset: number;
  inputs: Record<string, unknown>;
  contract: 'in' | 'out';
  outcome: 'HELD' | 'BROKEN';
  failures: string[];
  observations: Observation[];
  pressables: Array<{
    role: string | undefined;
    label: string | undefined;
    declaredMinDimension: number | null;
    modelledMinDimension: number;
  }>;
  copy: string;
  /** Compact rendered tree (author-level composites removed) for evidence. */
  tree: string;
}

const rows: Row[] = [];

function compactTree(renderer: TestRenderer.ReactTestRenderer): string {
  const json = renderer.toJSON();
  const walk = (node: unknown, depth: number): string[] => {
    if (node == null) return [];
    if (typeof node === 'string') return [`${'  '.repeat(depth)}"${node}"`];
    if (Array.isArray(node)) return node.flatMap(n => walk(n, depth));
    const el = node as {
      type: string;
      props: Record<string, unknown>;
      children: unknown[] | null;
    };
    const keep = [
      'accessibilityRole',
      'accessibilityLabel',
      'accessibilityState',
      'accessibilityLiveRegion',
      'accessible',
      'accessibilityViewIsModal',
      'pointerEvents',
      'numberOfLines',
      'testID',
    ];
    const props = keep
      .filter(k => el.props[k] !== undefined)
      .map(k => `${k}=${JSON.stringify(el.props[k])}`)
      .join(' ');
    const line = `${'  '.repeat(depth)}<${el.type}${props ? ' ' + props : ''}>`;
    return [line, ...(el.children ?? []).flatMap(c => walk(c, depth + 1))];
  };
  return walk(json, 0).join('\n');
}

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

// ---------------------------------------------------------------------------
// Per-component drivers. Each returns the failures (hard invariants) and
// observations (model signals) for one rendered variant.
// ---------------------------------------------------------------------------

interface Drive {
  renderer: TestRenderer.ReactTestRenderer;
  contract: 'in' | 'out';
  inputs: Record<string, unknown>;
  failures: string[];
  observations: Observation[];
  pressables: Row['pressables'];
  /** Tree captured before a driver mutates the UI (e.g. dismisses a modal). */
  tree?: string;
}

function checkPressables(
  root: ReactTestInstance,
  modelledMinDimension: (node: ReactTestInstance) => number,
  failures: string[],
  observations: Observation[],
): Row['pressables'] {
  return pressables(root).map(node => {
    const role = node.props.accessibilityRole as string | undefined;
    const label = node.props.accessibilityLabel as string | undefined;
    const declared = declaredMinDimension(node.props.style);
    const modelled = modelledMinDimension(node);
    if (!role) failures.push(`pressable without accessibilityRole (${label})`);
    if (!label || label.trim().length === 0)
      failures.push(`pressable without accessibilityLabel (role=${role})`);
    if (label && /\s$/.test(label))
      observations.push({
        kind: 'labelTrailingSpace',
        detail: `label ends with whitespace: ${JSON.stringify(label)}`,
      });
    if (declared === null)
      observations.push({
        kind: 'pressableUnsizedByStyle',
        detail: `no width/height/min* in style; content model = ${modelled}pt (${label})`,
      });
    if (Math.min(declared ?? Infinity, modelled) < 44)
      failures.push(
        `tap target < 44pt (declared=${declared}, modelled=${modelled}) for ${label}`,
      );
    return {
      role,
      label,
      declaredMinDimension: declared,
      modelledMinDimension: modelled,
    };
  });
}

function checkLeaks(
  copy: string,
  labels: Array<string | undefined>,
  contract: 'in' | 'out',
  failures: string[],
  observations: Observation[],
) {
  const hay = [copy, ...labels.filter((l): l is string => !!l)].join(' || ');
  const leak = LEAK_RE.exec(hay);
  if (!leak) return;
  if (contract === 'in')
    failures.push(`leaked ${leak[0]} into copy/label: ${hay.slice(0, 200)}`);
  else
    observations.push({
      kind: 'outOfContractLeak',
      detail: `out-of-contract input surfaced as ${leak[0]}: ${hay.slice(0, 160)}`,
    });
}

/** numberOfLines={1} texts vs the width the surrounding layout gives them. */
function checkSingleLineOverflow(
  root: ReactTestInstance,
  availableWidthFor: (node: ReactTestInstance) => number,
  fontScale: number,
  observations: Observation[],
) {
  for (const t of allTexts(root)) {
    if (t.props.numberOfLines !== 1) continue;
    const style = flatten(t.props.style);
    const fontSize = typeof style.fontSize === 'number' ? style.fontSize : 14;
    const ls =
      typeof style.letterSpacing === 'number' ? style.letterSpacing : 0;
    const text = textOf(t);
    const modelled = modelTextWidth(text, fontSize, ls, fontScale);
    const avail = availableWidthFor(t);
    const ratio = modelled / Math.max(1, avail);
    if (ratio > 1) {
      observations.push({
        kind: 'textOverflowModel',
        detail: `numberOfLines=1 text needs ~${Math.round(modelled)}pt of ${Math.round(avail)}pt (×${ratio.toFixed(2)}, fontSize ${fontSize}×${fontScale}): ${JSON.stringify(text)}`,
      });
    }
  }
}

function driveAchievementsShowcase(v: Variant, rng: Rng): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  let snapshot: ConsistencySnapshot;
  let contract: 'in' | 'out' = 'in';
  if (v.shape === 'synthetic') {
    const s = syntheticSnapshot(v);
    snapshot = s.snapshot;
    contract = s.contract;
  } else {
    snapshot = engineSnapshot(v, rng);
  }
  const renderer = render(
    <AchievementsShowcase snapshot={snapshot} dark={v.dark} />,
  );
  const root = renderer.root;
  // Badge cell: width 92 declared; height = paddingV 8+8 + art 64 + title
  // (7 + 14·fs) + meta (2 + 14·fs).
  const cellModel = () => Math.min(92, 16 + 64 + 9 + 28 * v.fontScale);
  const pressed = checkPressables(root, cellModel, failures, observations);
  if (pressed.length !== 10)
    failures.push(`expected 10 badge buttons, found ${pressed.length}`);
  const copy = visibleCopy(root);
  checkLeaks(
    copy,
    pressed.map(p => p.label),
    contract,
    failures,
    observations,
  );
  // Badge title/meta live in an 92pt cell with 4pt horizontal padding.
  checkSingleLineOverflow(root, () => 92 - 8, v.fontScale, observations);

  // Earned-day labels must name the SAME calendar day as the key regardless
  // of the device zone (the process TZ): the label for key YYYY-MM-DD must be
  // that date formatted in UTC in the device locale (engine.formatDayKey
  // contract; the defect fixed on this branch read 12:00Z in the device zone).
  for (const earned of snapshot.earned) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(earned.earnedOnDay)) continue;
    const expected = new Intl.DateTimeFormat(v.locale, {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${earned.earnedOnDay}T12:00:00Z`));
    if (!pressed.some(p => p.label?.includes(`Earned ${expected}`)))
      failures.push(
        `earned-day label drifted: key ${earned.earnedOnDay} should read "Earned ${expected}" (${v.locale}) under device TZ ${DEVICE_TZ}; labels: ${pressed
          .map(p => JSON.stringify(p.label))
          .join(', ')}`,
      );
  }

  // Tap a random badge: selection toggles, the detail panel appears, the
  // live-region is declared (Android-only — observed), second tap closes.
  const liveRegions = () =>
    root.findAll(
      n =>
        typeof n.type === 'string' &&
        n.props?.accessibilityLiveRegion === 'polite',
    );
  const targets = pressTargets(root);
  const first = targets[rng.int(targets.length)]!;
  const labelBefore = pressables(root)[targets.indexOf(first)]?.props
    .accessibilityLabel as string | undefined;
  act(() => first.props.onPress());
  if (liveRegions().length !== 1)
    failures.push(`detail panel count ${liveRegions().length} after press`);
  const selectedNow = pressables(root).filter(
    n => n.props.accessibilityState?.selected === true,
  );
  if (selectedNow.length !== 1)
    failures.push(`selected badges after press: ${selectedNow.length}`);
  const labelAfter = selectedNow[0]?.props.accessibilityLabel as
    string | undefined;
  if (labelAfter !== undefined && labelAfter === labelBefore) {
    observations.push({
      kind: 'iosLiveRegionOnly',
      detail:
        'badge label unchanged after selection; the detail panel relies on accessibilityLiveRegion (Android-only per RN ViewAccessibility.d.ts) and nothing calls announceForAccessibility — VoiceOver gets no feedback beyond `selected`',
    });
  }
  act(() => first.props.onPress());
  if (liveRegions().length !== 0)
    failures.push('detail panel did not close on second press');

  return {
    renderer,
    contract,
    failures,
    observations,
    pressables: pressed,
    inputs: {
      shape: v.shape,
      streakLen: v.streakLen,
      earned: snapshot.earned.map(e => e.id),
      currentStreak: snapshot.currentStreak,
      asOfDay: snapshot.asOfDay,
      string: v.string.id,
      numeric: v.numeric.id,
      numeric2: v.numeric2.id,
    },
  };
}

function driveConsistencyCard(v: Variant, rng: Rng): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  let snapshot: ConsistencySnapshot | null = null;
  let contract: 'in' | 'out' = 'in';
  if (v.shape === 'engine') snapshot = engineSnapshot(v, rng);
  else if (v.shape === 'synthetic') {
    const s = syntheticSnapshot(v);
    snapshot = s.snapshot;
    contract = s.contract;
  }
  const onPress = jest.fn();
  const renderer = render(
    <ConsistencyCard snapshot={snapshot} onPress={onPress} />,
  );
  const root = renderer.root;
  const W = v.window.width;
  // ProgressScreen content padding space.lg each side → card width W-48;
  // card height ≥ 2·md + header(14·fs) + mainRow(52) + momentum row.
  const cardModel = () =>
    Math.min(W - 2 * space.lg, 32 + 14 * v.fontScale + 10 + 52 + 16 + 6);
  const pressed = checkPressables(root, cardModel, failures, observations);
  if (pressed.length !== 1)
    failures.push(`expected 1 card button, found ${pressed.length}`);
  const copy = visibleCopy(root);
  checkLeaks(
    copy,
    pressed.map(p => p.label),
    contract,
    failures,
    observations,
  );
  // Status line lives in `body` (flex:1): W - 48 (screen) - 32 (card pad)
  // - 52 (flame) - 12 (gap) - 16 (chevron) - 12 (gap).
  checkSingleLineOverflow(
    root,
    () => W - 48 - 32 - 52 - 12 - 16 - 12,
    v.fontScale,
    observations,
  );
  const card = pressTargets(root).find(
    n => n.props.testID === 'consistency-card',
  );
  if (!card) failures.push('consistency-card testID missing');
  else {
    act(() => card.props.onPress());
    if (onPress.mock.calls.length !== 1) failures.push('onPress not forwarded');
  }
  return {
    renderer,
    contract,
    failures,
    observations,
    pressables: pressed,
    inputs: {
      shape: v.shape,
      streakLen: v.streakLen,
      currentStreak: snapshot?.currentStreak ?? null,
      trainedToday: snapshot?.trainedToday ?? null,
      atRisk: snapshot?.atRisk ?? null,
      nextTitle: snapshot?.nextStreakMilestone?.title ?? null,
      numeric: v.numeric.id,
      numeric2: v.numeric2.id,
      string: v.string.id,
    },
  };
}

function driveDaySecuredBanner(v: Variant): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  const { moment, contract } = daySecuredMoment(v);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  announce.mockClear();
  useConsistencyStore.setState({ daySecured: moment });
  const renderer = render(<DaySecuredBanner />);
  const root = renderer.root;
  const banner = root.findAll(
    n => typeof n.type === 'string' && n.props?.testID === 'day-secured-banner',
  );
  if (banner.length === 0)
    failures.push('banner did not render for a pending moment');
  if (useConsistencyStore.getState().daySecured !== null)
    failures.push('pending moment was not consumed');
  const copy = visibleCopy(root);
  const label = banner[0]?.props.accessibilityLabel as string | undefined;
  checkLeaks(copy, [label], contract, failures, observations);
  if (!label || label.trim().length === 0)
    failures.push('banner has no accessibilityLabel');
  const pressed = checkPressables(root, () => 0, failures, observations);
  if (pressed.length !== 0) failures.push('banner must not be interactive');
  // Meta line: W - 2·lg (left/right) - 2·md (padding) - 42 (flame) - 10 (gap).
  checkSingleLineOverflow(
    root,
    () => v.window.width - 48 - 32 - 42 - 10,
    v.fontScale,
    observations,
  );
  if (banner[0]) {
    const b = banner[0];
    if (
      b.props.accessibilityLiveRegion === 'polite' &&
      b.props.accessible !== true &&
      announce.mock.calls.length === 0
    ) {
      observations.push({
        kind: 'iosLiveRegionOnly',
        detail: `banner relies on accessibilityLiveRegion (Android-only per RN ViewAccessibility.d.ts), is not \`accessible\`, is pointerEvents="none" and announceForAccessibility was never called — label ${JSON.stringify(label)} is unreachable for VoiceOver before the ${3600}ms auto-dismiss`,
      });
    }
  }
  return {
    renderer,
    contract,
    failures,
    observations,
    pressables: pressed,
    inputs: {
      shape: v.shape,
      streak: moment.streak,
      xpToday: moment.xpToday,
      nextMilestone: moment.nextMilestone,
      string: v.string.id,
      numeric: v.numeric.id,
      numeric2: v.numeric2.id,
    },
  };
}

function driveFlameIcon(v: Variant): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  const renderer = render(
    <>
      <FlameIcon intensity={v.intensity} size={v.flameSize} />
      <AnimatedFlame intensity={v.intensity} size={v.flameSize} />
      <FlameIcon intensity={v.intensity} />
    </>,
  );
  const root = renderer.root;
  const svgs = root.findAll(
    n => n.props?.viewBox === '0 0 24 24' && typeof n.type !== 'string',
  );
  if (svgs.length !== 3)
    failures.push(`expected 3 flame svgs, found ${svgs.length}`);
  for (const [i, svg] of svgs.entries()) {
    const expected = i === 2 ? 22 : v.flameSize;
    if (svg.props.width !== expected || svg.props.height !== expected)
      failures.push(
        `svg ${i} size ${svg.props.width}×${svg.props.height}, expected ${expected}`,
      );
  }
  const paths = root.findAll(
    n => typeof n.props?.d === 'string' && typeof n.type === 'string',
  );
  // Outer body path always; the inner core path only when lit.
  const expectedPaths = v.intensity === 0 ? 3 : 6;
  if (paths.length !== expectedPaths)
    failures.push(
      `expected ${expectedPaths} paths for intensity ${v.intensity}, found ${paths.length}`,
    );
  const gradientIds = root
    .findAll(n => typeof n.props?.id === 'string' && typeof n.type !== 'string')
    .map(n => n.props.id as string);
  if (!gradientIds.every(id => id === `flameBody${v.intensity}`))
    failures.push(`gradient ids ${gradientIds.join(',')}`);
  const pressed = checkPressables(root, () => 0, failures, observations);
  if (pressed.length !== 0) failures.push('flame must not be interactive');
  return {
    renderer,
    contract: v.flameSize <= 0 ? 'out' : 'in',
    failures,
    observations,
    pressables: pressed,
    inputs: {
      intensity: v.intensity,
      size: v.flameSize,
      reducedMotion: v.reducedMotion,
    },
  };
}

function driveMilestoneBadge(v: Variant): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  // Production values are short numerals (badgeArtFor): '3'…'365', '100', '25'.
  const value =
    v.string.id === 'milestone'
      ? '365'
      : v.string.id === 'specialistTitle'
        ? '25'
        : v.string.value;
  const contract: 'in' | 'out' =
    v.string.contract === 'in' && v.badgeSize > 0 && v.badgeSize <= 148
      ? 'in'
      : 'out';
  const renderer = render(
    <>
      <MilestoneBadge
        glyph={v.glyph}
        value={value}
        rarity={v.rarity}
        earned={v.earned}
        size={v.badgeSize}
      />
      <MilestoneBadge glyph={v.glyph} rarity={v.rarity} earned={!v.earned} />
    </>,
  );
  const root = renderer.root;
  const svgs = root.findAll(
    n => n.props?.viewBox === '0 0 96 96' && typeof n.type !== 'string',
  );
  if (svgs.length !== 2)
    failures.push(`expected 2 badge svgs, found ${svgs.length}`);
  if (
    svgs[0] &&
    (svgs[0].props.width !== v.badgeSize ||
      svgs[0].props.height !== v.badgeSize)
  )
    failures.push(
      `badge svg size ${svgs[0].props.width}, expected ${v.badgeSize}`,
    );
  if (svgs[1] && svgs[1].props.width !== 72)
    failures.push('default badge size is not 72');
  const texts = allTexts(root);
  const expectTexts = value ? 1 : 0;
  if (texts.length !== expectTexts)
    failures.push(`expected ${expectTexts} value texts, found ${texts.length}`);
  if (texts[0]) {
    const fs = flatten(texts[0].props.style).fontSize;
    const expected = v.badgeSize * (value.length > 2 ? 0.2 : 0.24);
    if (fs !== expected)
      failures.push(`value fontSize ${fs}, expected ${expected}`);
    // Value overlay has no numberOfLines and no overflow clip: model width
    // against the hexagon's inner width (~0.65·size).
    const modelled = modelTextWidth(value, expected, -0.5, v.fontScale);
    const avail = v.badgeSize * 0.65;
    if (modelled > avail && v.badgeSize > 0)
      observations.push({
        kind: 'textOverflowModel',
        detail: `badge value needs ~${Math.round(modelled)}pt of ~${Math.round(avail)}pt inner hex (×${(modelled / avail).toFixed(2)}): ${JSON.stringify(value.slice(0, 40))}`,
      });
  }
  const gradientIds = root
    .findAll(n => typeof n.props?.id === 'string' && typeof n.type !== 'string')
    .map(n => n.props.id as string);
  if (gradientIds.length !== 2 || gradientIds[0] === gradientIds[1])
    failures.push(
      `gradient ids ${gradientIds.join(',')} (earned/locked pair must differ)`,
    );
  checkLeaks(visibleCopy(root), [], contract, failures, observations);
  const pressed = checkPressables(root, () => 0, failures, observations);
  if (pressed.length !== 0) failures.push('badge must not be interactive');
  return {
    renderer,
    contract,
    failures,
    observations,
    pressables: pressed,
    inputs: {
      glyph: v.glyph,
      rarity: v.rarity,
      earned: v.earned,
      size: v.badgeSize,
      value: v.string.id,
    },
  };
}

function driveStreakCelebration(v: Variant, rng: Rng): Drive {
  const failures: string[] = [];
  const observations: Observation[] = [];
  const { celebration: c, contract } = celebration(v);
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  announce.mockClear();
  useConsistencyStore.setState({ celebration: c });
  const renderer = render(<StreakCelebration />);
  const root = renderer.root;
  const modal = root.findAllByType(Modal)[0];
  if (!modal || modal.props.visible !== true)
    failures.push('modal not visible');
  const stage = root.findAll(
    n => typeof n.type === 'string' && n.props?.testID === 'streak-celebration',
  );
  if (stage.length === 0) failures.push('stage did not render');
  const W = v.window.width;
  const H = v.window.height;
  const pressed = checkPressables(
    root,
    node =>
      node.props.testID === 'streak-celebration-continue'
        ? Math.min(W - 2 * space.xl, 56)
        : Math.min(W, H), // backdrop: flex:1 inside an absoluteFill
    failures,
    observations,
  );
  const labels = pressed.map(p => p.label);
  if (!labels.includes('Dismiss milestone celebration'))
    failures.push('backdrop dismiss button missing');
  if (!labels.includes('Keep training'))
    failures.push('continue button missing');
  const copy = visibleCopy(root);
  checkLeaks(copy, labels, contract, failures, observations);
  if (announce.mock.calls.length !== 1)
    failures.push(
      `announceForAccessibility calls: ${announce.mock.calls.length}`,
    );
  else {
    const said = String(announce.mock.calls[0]![0]);
    if (contract === 'in' && LEAK_RE.test(said))
      failures.push(`announcement leaked: ${said}`);
    if (c.reward.trim().length > 0 && !said.includes(c.reward.trim()))
      failures.push('announcement omits the reward');
  }
  const modalViews = root.findAll(
    n =>
      typeof n.type === 'string' && n.props?.accessibilityViewIsModal === true,
  );
  if (modalViews.length !== 1)
    failures.push(`accessibilityViewIsModal count ${modalViews.length}`);
  if (c.reward.trim().length > 0 && !copy.includes(c.reward.trim()))
    failures.push('reward copy missing');

  // Vertical budget model (INFERRED): the content column is absolute-fill,
  // centered, NOT scrollable. Sum the fixed pieces at this font scale/width.
  const fs = v.fontScale;
  const textW = W - 2 * space.xl;
  const titleText = allTexts(root).find(
    t => flatten(t.props.style).fontSize === type.h1.fontSize,
  );
  const blurbText = allTexts(root).find(
    t => flatten(t.props.style).fontSize === type.body.fontSize,
  );
  const lines = (
    t: ReactTestInstance | undefined,
    avail: number,
    size: number,
    ls: number,
  ) =>
    t
      ? Math.max(1, Math.ceil(modelTextWidth(textOf(t), size, ls, fs) / avail))
      : 1;
  const titleLines = lines(
    titleText,
    textW,
    type.h1.fontSize,
    type.h1.letterSpacing,
  );
  const blurbLines = lines(
    blurbText,
    Math.min(300, textW),
    type.body.fontSize,
    0,
  );
  const total =
    type.micro.lineHeight * fs + // eyebrow
    space.md +
    236 + // stage
    space.sm +
    titleLines * type.h1.lineHeight * fs +
    space.sm +
    blurbLines * type.body.lineHeight * fs +
    space.sm +
    type.caption.lineHeight * fs +
    space.lg +
    18 +
    type.caption.lineHeight * fs + // reward pill
    space.xl +
    Math.max(56, type.bodyBold.lineHeight * fs + 8); // CTA
  if (total > H)
    observations.push({
      kind: 'modalVerticalBudgetModel',
      detail: `content column ~${Math.round(total)}pt > window ${H}pt at fontScale ${fs} (title ${titleLines} line(s), blurb ${blurbLines} line(s)); no ScrollView — "Keep training" CTA pushed below the fold by ~${Math.round(total - H)}pt`,
    });

  const tree = compactTree(renderer);
  // Dismissal: random choice between the CTA and the backdrop.
  const target = rng.bool()
    ? pressTargets(root).find(
        n => n.props.testID === 'streak-celebration-continue',
      )
    : pressTargets(root).find(
        n => n.props.accessibilityLabel === 'Dismiss milestone celebration',
      );
  if (!target) failures.push('no dismiss target found');
  else {
    act(() => target.props.onPress());
    if (useConsistencyStore.getState().celebration !== null)
      failures.push('celebration not dismissed');
    if (
      root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props?.testID === 'streak-celebration',
      ).length !== 0
    )
      failures.push('stage still mounted after dismiss');
  }
  return {
    renderer,
    contract,
    failures,
    observations,
    pressables: pressed,
    tree,
    inputs: {
      shape: v.shape,
      kind: c.kind,
      achievementId: c.achievementId,
      rarity: c.rarity,
      value: c.value,
      string: v.string.id,
      numeric: v.numeric.id,
      titleLines,
      blurbLines,
      modelledColumnHeight: Math.round(total),
    },
  };
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const variants: Variant[] =
  REPLAY !== null
    ? [makeVariant(REPLAY, Number(process.env.STRESS_REPLAY_INDEX ?? 0))]
    : Array.from({ length: ITERATIONS }, (_, i) =>
        makeVariant(variantSeed(BASE_SEED, i), i),
      );

afterEach(() => {
  useConsistencyStore.setState({ celebration: null, daySecured: null });
  jest.restoreAllMocks();
});

afterAll(() => {
  const held = rows.filter(r => r.outcome === 'HELD').length;
  const broken = rows.filter(r => r.outcome === 'BROKEN');
  const summary = {
    unit: 'cmp-consistency-ui',
    lens: 'boundary-i18n-a11y',
    baseSeed: BASE_SEED,
    iterations: rows.length,
    deviceZone: DEVICE_TZ,
    held,
    broken: broken.length,
    brokenSeeds: broken.map(r => r.seed),
    observationCounts: rows
      .flatMap(r => r.observations.map(o => o.kind))
      .reduce<Record<string, number>>(
        (acc, k) => ({ ...acc, [k]: (acc[k] ?? 0) + 1 }),
        {},
      ),
    coverage: {
      components: [...new Set(rows.map(r => r.component))].length,
      fontScales: [...new Set(rows.map(r => r.fontScale))].length,
      widths: [...new Set(rows.map(r => r.window.width))].length,
      locales: [...new Set(rows.map(r => r.locale))].length,
      snapshotZones: [...new Set(rows.map(r => r.snapshotZone))].length,
    },
    rows,
  };
  if (OUT_PATH) {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  }
});

describe(`cmp-consistency-ui × boundary-i18n-a11y (base seed ${BASE_SEED}, ${variants.length} variants, device TZ ${DEVICE_TZ})`, () => {
  test.each(variants.map(v => [v.seed, v.index, v.component, v] as const))(
    'seed %d #%d %s',
    (seed, index, component, v) => {
      const rng = new Rng(seed ^ 0x5bd1e995);
      currentLocale = v.locale;
      mockReducedMotion = v.reducedMotion;
      mockInsets = { top: 47, bottom: v.bottomInset, left: 0, right: 0 };
      mockWindow = { ...v.window, scale: 3, fontScale: v.fontScale };

      let drive: Drive | null = null;
      let thrown: unknown = null;
      try {
        switch (component) {
          case 'AchievementsShowcase':
            drive = driveAchievementsShowcase(v, rng);
            break;
          case 'ConsistencyCard':
            drive = driveConsistencyCard(v, rng);
            break;
          case 'DaySecuredBanner':
            drive = driveDaySecuredBanner(v);
            break;
          case 'FlameIcon':
            drive = driveFlameIcon(v);
            break;
          case 'MilestoneBadge':
            drive = driveMilestoneBadge(v);
            break;
          case 'StreakCelebration':
            drive = driveStreakCelebration(v, rng);
            break;
        }
      } catch (error) {
        thrown = error;
      }

      const failures = drive ? [...drive.failures] : [];
      if (thrown)
        failures.push(`threw: ${String((thrown as Error)?.message ?? thrown)}`);
      const row: Row = {
        seed,
        index,
        component,
        fontScale: v.fontScale,
        window: v.window,
        locale: v.locale,
        snapshotZone: v.zone.tz,
        deviceZone: DEVICE_TZ,
        reducedMotion: v.reducedMotion,
        bottomInset: v.bottomInset,
        inputs: drive?.inputs ?? { string: v.string.id, numeric: v.numeric.id },
        contract: drive?.contract ?? 'out',
        outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
        failures,
        observations: drive?.observations ?? [],
        pressables: drive?.pressables ?? [],
        copy: drive ? visibleCopy(drive.renderer.root).slice(0, 600) : '',
        tree: drive
          ? (drive.tree ?? compactTree(drive.renderer)).slice(0, 4000)
          : '',
      };
      rows.push(row);
      if (drive) act(() => drive!.renderer.unmount());

      expect(failures).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// Coverage pin for the default campaign: every locale, every snapshot zone,
// every component × font scale × width cell must have been exercised at
// least once (only meaningful when the whole campaign ran).
// ---------------------------------------------------------------------------

describe('campaign coverage', () => {
  const enabled = REPLAY === null && ITERATIONS >= 150 ? test : test.skip;
  enabled(
    'covers 6 components × 3 font scales × 3 widths, 12 locales, 8 zones',
    () => {
      const cells = new Set(
        variants.map(v => `${v.component}|${v.fontScale}|${v.window.width}`),
      );
      expect(cells.size).toBe(
        COMPONENTS.length * FONT_SCALES.length * WINDOWS.length,
      );
      expect(new Set(variants.map(v => v.locale)).size).toBe(LOCALES.length);
      expect(new Set(variants.map(v => v.zone.tz)).size).toBe(ZONES.length);
      expect(new Set(variants.map(v => v.string.id)).size).toBe(STRINGS.length);
      expect(new Set(variants.map(v => v.numeric.id)).size).toBe(
        NUMERICS.length,
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Deterministic contract probes (not seeded; documented behaviour at the
// edges of the TypeScript contract). These are OBSERVATIONS, not failures —
// the engine never produces these values — kept here so the behaviour is
// recorded next to the campaign and any change is visible.
// ---------------------------------------------------------------------------

describe('contract-edge probes', () => {
  test('FlameIcon with an out-of-union intensity throws (palette lookup has no fallback)', () => {
    const bad = 6 as unknown as FlameIntensity;
    expect(() => render(<FlameIcon intensity={bad} />)).toThrow();
  });

  test('ScrollView rail is labelled with the earned count', () => {
    const snapshot = buildConsistencySnapshot([], {
      asOfIso: '2026-03-10T18:00:00.000Z',
      timeZone: 'UTC',
    });
    const renderer = render(<AchievementsShowcase snapshot={snapshot} />);
    const rail = renderer.root.findAllByType(ScrollView)[0]!;
    expect(rail.props.accessibilityLabel).toBe('Achievements: 0 of 10 earned.');
    act(() => renderer.unmount());
  });
});
