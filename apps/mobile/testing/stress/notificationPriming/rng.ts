/**
 * stress-cmp-notification-priming — seeded generation.
 *
 * Every campaign iteration is derived from ONE 32-bit seed, so any outcome in
 * the JSON seed table can be replayed with
 *   cd apps/mobile && STRESS_SEED=<seed> npx jest --ci <suite>
 */

/** mulberry32 — small, fast, and stable across Node versions. */
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

export interface Rng {
  next: () => number;
  int: (maxExclusive: number) => number;
  pick: <T>(items: readonly T[]) => T;
  bool: (probability?: number) => boolean;
}

export function rngFor(seed: number): Rng {
  const next = mulberry32(seed);
  const int = (maxExclusive: number) => Math.floor(next() * maxExclusive);
  return {
    next,
    int,
    // `undefined` is a legitimate corpus member (hostile props), so only an
    // empty corpus is an error.
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error('empty corpus');
      return items[int(items.length)] as T;
    },
    bool: (probability = 0.5) => next() < probability,
  };
}

/** The 12 locales named by the lens. */
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

export interface ZoneCase {
  /** IANA zone (or a fixed-offset label for the UTC±14 extremes). */
  zone: string;
  /** Why this zone is in the matrix. */
  why: string;
  /** UTC offset in minutes at `atIso`. */
  offsetMinutes: number;
  /** An instant of interest inside that zone (DST edge / date-line edge). */
  atIso: string;
}

/** 8 timezone cases: the UTC±14 extremes plus DST/date-line edges. */
export const ZONE_CASES: readonly ZoneCase[] = [
  {
    zone: 'Pacific/Kiritimati',
    why: 'UTC+14, earliest date on earth',
    offsetMinutes: 840,
    atIso: '2026-03-08T09:59:59.999Z',
  },
  {
    zone: 'Pacific/Apia',
    why: 'UTC+13 (DST), date-line jump neighbourhood',
    offsetMinutes: 780,
    atIso: '2026-01-01T10:30:00.000Z',
  },
  {
    zone: 'Pacific/Auckland',
    why: 'southern-hemisphere DST end (clocks back 1h)',
    offsetMinutes: 780,
    atIso: '2026-04-04T14:00:00.000Z',
  },
  {
    zone: 'Australia/Lord_Howe',
    why: '30-minute DST shift, :30 offset',
    offsetMinutes: 660,
    atIso: '2026-04-04T15:30:00.000Z',
  },
  {
    zone: 'Asia/Kolkata',
    why: 'permanent :30 offset, no DST',
    offsetMinutes: 330,
    atIso: '2026-06-21T18:30:00.000Z',
  },
  {
    zone: 'Europe/Berlin',
    why: 'EU DST start (02:00 → 03:00, 02:30 does not exist)',
    offsetMinutes: 60,
    atIso: '2026-03-29T01:00:00.000Z',
  },
  {
    zone: 'America/Los_Angeles',
    why: 'US DST end (01:00–02:00 happens twice)',
    offsetMinutes: -480,
    atIso: '2026-11-01T08:30:00.000Z',
  },
  {
    zone: 'Etc/GMT+12',
    why: 'UTC-12, latest date on earth',
    offsetMinutes: -720,
    atIso: '2026-12-31T11:59:59.999Z',
  },
];

/** iOS Dynamic Type multipliers (react-native RCTAccessibilityManager.mm). */
export const FONT_SCALES = [
  { name: 'large (default)', scale: 1.0 },
  { name: 'xxxLarge', scale: 1.353 },
  { name: 'accessibilityLarge', scale: 2.143 },
] as const;

/** iPhone logical widths supported by the app (portrait only, iOS 15.1+). */
export const SCREEN_WIDTHS = [
  { name: 'iPhone SE (1st gen)', width: 320 },
  { name: 'iPhone SE (3rd gen) / 13 mini', width: 375 },
  { name: 'iPhone 15 Pro Max', width: 430 },
] as const;

/**
 * Hostile strings: 200+ chars, CJK, Arabic RTL, ZWJ emoji, combining marks,
 * German compounds, plus the empty/whitespace/control degenerate cases.
 */
export const HOSTILE_STRINGS: Record<string, string> = {
  empty: '',
  space: ' ',
  newlines: '\n\n\t',
  zeroWidth: '\u200b\u200e\u202e',
  long240: 'Streak'.repeat(40),
  longNoSpaces: 'a'.repeat(256),
  cjkHan: '连续训练一百天的里程碑就在今晚等着你完成一次挥拍分析'.repeat(4),
  japaneseMixed: '連続記録は今夜のワンショット分析で守れます。ピクルセンセイ',
  arabicRtl:
    'سلسلة التدريب الخاصة بك على وشك الانتهاء الليلة قم بتحليل ضربة واحدة',
  hebrewRtl: 'רצף האימונים שלך בסכנה הלילה',
  thaiNoSpaces: 'สถิติการฝึกซ้อมต่อเนื่องของคุณกำลังจะสิ้นสุดลงในคืนนี้',
  devanagari: 'आपकी लगातार अभ्यास श्रृंखला आज रात समाप्त हो सकती है',
  zwjEmoji: '👨‍👩‍👧‍👦🏳️‍🌈🧑🏽‍🚀🔥',
  combining: 'e\u0301\u0327\u0316a\u0301\u0301\u0301\u0301\u0301\u0301',
  germanCompound:
    'Trainingsserienverteidigungsbenachrichtigungseinstellungen und Rechtschreibungsprüfungsfehler',
  turkishDotless: 'Iıİi antrenman serisi',
  rtlOverride: '\u202eGnorts syad 7\u202c',
  surrogatePair: '𝕊𝕥𝕣𝕖𝕒𝕜 𝟟 𝕕𝕒𝕪𝕤',
  quotesAndPercent: '100% "streak" \u2014 don\u2019t {0} %s %@ ${x}',
};

/** Zero / negative / huge / non-finite numerics. */
export const HOSTILE_NUMBERS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  minusOne: -1,
  minusHuge: -1e9,
  fractional: 1.5,
  epsilon: Number.EPSILON,
  bigDays: 99999,
  maxSafe: Number.MAX_SAFE_INTEGER,
  beyondMaxSafe: 2 ** 60,
  maxValue: Number.MAX_VALUE,
  infinity: Number.POSITIVE_INFINITY,
  minusInfinity: Number.NEGATIVE_INFINITY,
  notANumber: Number.NaN,
  minusZero: -0,
};

/** Boundary delivery instants (ms since epoch) for the copy rotation. */
export const HOSTILE_TIMESTAMPS: Record<string, number> = {
  epoch: 0,
  beforeEpoch: -1,
  deepPast: -62135596800000,
  dayBoundaryExact: 86400000,
  dayBoundaryMinusOne: 86399999,
  y2038: 2147483648000,
  maxDate: 8640000000000000,
  beyondMaxDate: 8640000000000001,
  maxSafeMs: Number.MAX_SAFE_INTEGER,
  nan: Number.NaN,
  infinity: Number.POSITIVE_INFINITY,
};
