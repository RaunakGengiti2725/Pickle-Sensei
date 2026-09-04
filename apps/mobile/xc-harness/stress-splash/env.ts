/**
 * Deterministic scenario space for the SplashScreen boundary / i18n / a11y
 * stress campaign (`__tests__/stress/splashScreen.*.stress.test.tsx`).
 *
 * Every table here is a pure function of a 32-bit seed so any row of the
 * emitted JSON tables can be replayed from `seed` alone:
 *
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/splashScreen.boundaryI18nA11y
 *
 * Nothing is random at import time.
 */
import { makePrng, pick } from '../lifecycle-persistence/seeds';

export { makePrng, pick };

// ─── Environment dimensions ──────────────────────────────────────────────────

/** Dynamic Type multipliers: default, xxLarge (largest non-AX), AX3, AX5. */
export const FONT_SCALES = [1, 1.235, 2.35, 3.12] as const;
/** The three the lens asks for (3 × 3 fixed matrix); AX5 is extra coverage. */
export const PRIMARY_FONT_SCALES = [1, 1.235, 2.35] as const;

export interface Viewport {
  name: string;
  width: number;
  height: number;
  scale: number;
}
/** Narrowest, most common, widest iPhone widths the app ships to (pt). */
export const VIEWPORTS: readonly Viewport[] = [
  { name: 'iphone-se1-320', width: 320, height: 568, scale: 2 },
  { name: 'iphone-se3-375', width: 375, height: 667, scale: 2 },
  { name: 'iphone-pro-max-430', width: 430, height: 932, scale: 3 },
];

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

export function isRtlLocale(locale: string): boolean {
  return /^(ar|he|fa|ur)\b/.test(locale);
}

export interface TimezoneCase {
  name: string;
  /** IANA id, or Etc/GMT±N for the extreme fixed offsets. */
  tz: string;
  /** Wall-clock instant the fake clock starts at (DST edges: 30 s before). */
  startIso: string;
  note: string;
}
export const TIMEZONES: readonly TimezoneCase[] = [
  {
    name: 'utc',
    tz: 'UTC',
    startIso: '2026-03-01T09:00:00.000Z',
    note: 'baseline',
  },
  {
    name: 'utc+14',
    tz: 'Pacific/Kiritimati',
    startIso: '2026-12-31T10:00:00.000Z',
    note: 'UTC+14, local date already next year',
  },
  {
    name: 'utc-12',
    tz: 'Etc/GMT+12',
    startIso: '2026-01-01T11:59:30.000Z',
    note: 'UTC-12, local date still previous year',
  },
  {
    name: 'us-spring-forward',
    tz: 'America/New_York',
    startIso: '2026-03-08T06:59:30.000Z',
    note: '30 s before 02:00 → 03:00 EST→EDT',
  },
  {
    name: 'us-fall-back',
    tz: 'America/New_York',
    startIso: '2026-11-01T05:59:30.000Z',
    note: '30 s before 02:00 → 01:00 EDT→EST (repeated hour)',
  },
  {
    name: 'eu-spring-forward',
    tz: 'Europe/Berlin',
    startIso: '2026-03-29T00:59:30.000Z',
    note: '30 s before 02:00 → 03:00 CET→CEST',
  },
  {
    name: 'lord-howe-30min-dst',
    tz: 'Australia/Lord_Howe',
    startIso: '2026-04-04T14:59:30.000Z',
    note: '30-minute DST step, 30 s before the transition',
  },
  {
    name: 'chatham-+12:45',
    tz: 'Pacific/Chatham',
    startIso: '2026-09-26T13:59:30.000Z',
    note: 'quarter-hour offset, 30 s before DST start',
  },
];

// ─── Hostile text corpus ─────────────────────────────────────────────────────

export interface TextCase {
  name: string;
  value: string;
}
const ZWJ_FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}';
const COMBINING =
  'Z\u0351\u036B\u0343\u034A\u0345a\u0317\u0332\u0349l\u0357\u0339g\u0326o\u035A';

export const TEXT_CASES: readonly TextCase[] = [
  { name: 'latin-200', value: 'Pat '.repeat(50).trim() + 'X'.repeat(4) },
  { name: 'latin-nospace-260', value: 'Q'.repeat(260) },
  {
    name: 'cjk-220',
    value: '網球拍子技術教練評估分析結果'.repeat(16) + '球拍',
  },
  {
    name: 'ja-mixed-210',
    value: 'ピックルボール・コーチング分析'.repeat(14),
  },
  {
    name: 'arabic-rtl-230',
    value: 'مدرب تقنية كرة المضرب تحليل حركة اللاعب '.repeat(6),
  },
  {
    name: 'hindi-devanagari-200',
    value: 'पिकलबॉल कोचिंग तकनीक विश्लेषण '.repeat(7),
  },
  {
    name: 'thai-no-spaces-210',
    value: 'การวิเคราะห์เทคนิคการเล่นพิกเคิลบอล'.repeat(6),
  },
  { name: 'zwj-emoji-40', value: ZWJ_FAMILY.repeat(40) },
  { name: 'zalgo-combining', value: COMBINING.repeat(12) },
  {
    name: 'german-compound-84',
    value:
      'Donaudampfschifffahrtsgesellschaftskapitänsanwärterausbildungsverordnung',
  },
  { name: 'bidi-override', value: '\u202Eevil\u202C normal \u2067RTL\u2069' },
  { name: 'nul-and-controls', value: 'a\u0000b\u0007c\u001Bd\u200B\uFEFF' },
  { name: 'empty', value: '' },
  { name: 'whitespace', value: ' \n\t\u00A0\u3000 ' },
  { name: 'newlines-30', value: 'a\n'.repeat(30) },
  { name: 'turkish-dotless', value: 'Iİıi TÜRKÇE ışık'.repeat(10) },
];

/** JSON-level values a stored `first_name` slot might hold besides strings. */
export const NON_STRING_NAME_VALUES: Readonly<Record<string, unknown>> = {
  null: null,
  'number-0': 0,
  'number-negative': -1,
  'number-huge': 1e308,
  'number-nan-string': 'NaN',
  bool: true,
  array: ['a', 'b'],
  object: { nested: 'x' },
};

// ─── Boundary prop values (SplashScreen has exactly two props) ───────────────

export interface PropCase {
  name: string;
  ready: unknown;
  onFinished: unknown;
  /**
   * The TypeScript contract (`onFinished: () => void`) forbids this value;
   * a throw when the handoff fires is the JS-level consequence. Rows still
   * record BROKEN honestly — the flag only tells the Jest assertion which
   * outcome the campaign has classified (see the P3 finding in the report).
   */
  typeForbiddenCallback?: boolean;
}
export const PROP_CASES: readonly PropCase[] = [
  { name: 'ready-undefined', ready: undefined, onFinished: 'fn' },
  { name: 'ready-null', ready: null, onFinished: 'fn' },
  { name: 'ready-0', ready: 0, onFinished: 'fn' },
  { name: 'ready-negative', ready: -1, onFinished: 'fn' },
  { name: 'ready-huge', ready: 1e308, onFinished: 'fn' },
  { name: 'ready-nan', ready: Number.NaN, onFinished: 'fn' },
  { name: 'ready-empty-string', ready: '', onFinished: 'fn' },
  { name: 'ready-long-string', ready: 'x'.repeat(240), onFinished: 'fn' },
  { name: 'ready-object', ready: { ready: false }, onFinished: 'fn' },
  {
    name: 'onFinished-undefined',
    ready: true,
    onFinished: undefined,
    typeForbiddenCallback: true,
  },
  {
    name: 'onFinished-null',
    ready: true,
    onFinished: null,
    typeForbiddenCallback: true,
  },
  {
    name: 'onFinished-string',
    ready: true,
    onFinished: 'not-a-function',
    typeForbiddenCallback: true,
  },
  {
    name: 'onFinished-number',
    ready: true,
    onFinished: 42,
    typeForbiddenCallback: true,
  },
  {
    name: 'onFinished-throws',
    ready: true,
    onFinished: 'throws',
    typeForbiddenCallback: true,
  },
];

// ─── Player event stream ─────────────────────────────────────────────────────

export type PlayerEventKind =
  | 'progress'
  | 'end'
  | 'error'
  | 'skip'
  | 'skip-double'
  | 'ready-true'
  | 'ready-false'
  | 'reduced-motion-on'
  | 'reduced-motion-off'
  | 'new-onFinished'
  | 'unmount';

export interface PlayerEvent {
  /** ms after mount on the fake clock (strictly non-decreasing). */
  atMs: number;
  kind: PlayerEventKind;
  /** progress payload seconds — deliberately hostile values included. */
  currentTime?: number;
}

/** Hostile `currentTime` values react-native-video could conceivably emit. */
export const PROGRESS_TIMES: readonly number[] = [
  -1,
  -0,
  0,
  0.5,
  0.999,
  1,
  1.001,
  3.7,
  59.9,
  1e9,
  Number.MAX_SAFE_INTEGER,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
];

export interface Scenario {
  seed: number;
  fontScale: number;
  viewport: Viewport;
  locale: Locale;
  timezone: TimezoneCase;
  reducedMotion: boolean;
  /** `ready` prop value at mount. */
  readyAtMount: boolean;
  events: PlayerEvent[];
  /** ms to advance after the last event before the final assertions. */
  settleMs: number;
}

export function scenarioFromSeed(seed: number): Scenario {
  const rng = makePrng(seed);
  const eventCount = 1 + Math.floor(rng() * 6);
  const events: PlayerEvent[] = [];
  let at = 0;
  const kinds: readonly PlayerEventKind[] = [
    'progress',
    'progress',
    'progress',
    'end',
    'error',
    'skip',
    'skip-double',
    'ready-true',
    'ready-false',
    'reduced-motion-on',
    'reduced-motion-off',
    'new-onFinished',
    'unmount',
  ];
  for (let i = 0; i < eventCount; i += 1) {
    at += Math.floor(rng() * 2500);
    const kind = pick(rng, kinds);
    events.push(
      kind === 'progress'
        ? { atMs: at, kind, currentTime: pick(rng, PROGRESS_TIMES) }
        : { atMs: at, kind },
    );
    if (kind === 'unmount') break;
  }
  return {
    seed,
    fontScale: pick(rng, FONT_SCALES),
    viewport: pick(rng, VIEWPORTS),
    locale: pick(rng, LOCALES),
    timezone: pick(rng, TIMEZONES),
    reducedMotion: rng() < 0.3,
    readyAtMount: rng() < 0.5,
    events,
    settleMs: pick(rng, [0, 100, 520, 600, 1000, 9000]),
  };
}

/** Integer iteration budget from an env var with a small default. */
export function iterationBudget(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Optional single-seed replay filter. */
export function seedFilter(
  env: Record<string, string | undefined>,
): number | null {
  const raw = env['STRESS_SEED'];
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
