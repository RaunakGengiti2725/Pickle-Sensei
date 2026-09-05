/**
 * Boundary / i18n / a11y corpus for the StreakCalendarScreen stress campaign.
 *
 * Strings are the ones a real device can put in front of the screen through
 * the LOCAL store: `local_shot.shot_type` and drill titles in the consistency
 * ledger are plain TEXT columns that older builds, sync, or a hostile backup
 * could have written — the screen renders them as day-detail activity labels
 * and the engine folds them into the Specialist crest title. Numerics are
 * the same: `overall_score REAL` accepts anything SQLite will store.
 */

export interface HostileString {
  id: string;
  text: string;
  /** Code points, not UTF-16 length. */
  codePoints: number;
}

function hs(id: string, text: string): HostileString {
  return { id, text, codePoints: [...text].length };
}

const CJK_SEED =
  '東京都渋谷区のピックルボール練習場で毎朝ディンクとサードショットドロップを繰り返す選手たちは、忍耐と集中を鍛える。';
const ARABIC_SEED =
  'تدريب البيكلبول الصباحي في القاهرة يركز على ضربة الدينك وضربة الإسقاط الثالثة مع ٢٥ تكراراً لكل تمرين.';
const ZWJ_FAMILY = '👨‍👩‍👧‍👦';
const ZWJ_FLAG = '🏳️‍🌈';
const ZWJ_WORKER = '👩🏽‍🔧';
const COMBINING_STACK =
  'Z\u0351\u036b\u0343\u036a\u0302\u036ba\u0315\u0300\u0301\u0302\u0303l\u0334\u0309\u0325\u0346g\u030b\u0350\u0303o\u0304\u0334\u0301';

function repeatTo(seed: string, minCodePoints: number): string {
  let out = '';
  while ([...out].length < minCodePoints) out += seed;
  return out;
}

export const HOSTILE_STRINGS: readonly HostileString[] = [
  hs('ascii-240', repeatTo('third_shot_drop_transition_footwork_', 240)),
  hs('cjk-220', repeatTo(CJK_SEED, 220)),
  hs('arabic-rtl-210', repeatTo(ARABIC_SEED, 210)),
  hs('zwj-emoji-200', repeatTo(`${ZWJ_FAMILY}${ZWJ_FLAG}${ZWJ_WORKER} `, 200)),
  hs('combining-marks-200', repeatTo(`${COMBINING_STACK} `, 200)),
  hs(
    'german-compound',
    'Donaudampfschifffahrtsgesellschaftskapitänsanwärterausbildungsverordnung',
  ),
  hs('german-compound-ss', 'Straßenaufschlagsübungsgroßmeisterin'),
  hs('thai-no-spaces', repeatTo('การฝึกซ้อมพิกเคิลบอลตอนเช้าที่กรุงเทพ', 200)),
  hs('hindi-conjuncts', repeatTo('प्रशिक्षण संक्षिप्त क्षत्रिय ज्ञान ', 200)),
  hs('turkish-dotless', 'ıstanbul ışıklı ilk idman İİİ'),
  hs('bidi-override', 'dink\u202Eexecute\u202Cdrop \u200Fmixed 123\u200E'),
  hs('empty', ''),
  hs('whitespace-only', '   \u00a0\u2003  '),
  hs('newlines-tabs', 'line one\nline two\ttabbed\r\nline three'),
  hs('sql-ish', "'; DROP TABLE local_shot; --"),
  hs('format-specifiers', '%s %d %n %@ {0} ${label} <b>bold</b>'),
  hs('single-emoji', '🥒'),
  hs('surrogate-heavy', repeatTo('𝔘𝔫𝔦𝔠𝔬𝔡𝔢 𝕄𝕒𝕥𝕙 ', 200)),
];

export interface HostileScore {
  id: string;
  /** Value written to `overall_score REAL` (SQLite type affinity applies). */
  value: number | string | null;
  resultKind: string;
}

export const HOSTILE_SCORES: readonly HostileScore[] = [
  { id: 'score-zero', value: 0, resultKind: 'scored' },
  { id: 'score-negative', value: -4.5, resultKind: 'scored' },
  { id: 'score-max', value: 10, resultKind: 'scored' },
  { id: 'score-over-max', value: 10.55, resultKind: 'scored' },
  { id: 'score-huge', value: 1e308, resultKind: 'scored' },
  { id: 'score-huge-negative', value: -1e308, resultKind: 'scored' },
  { id: 'score-tiny', value: 1e-7, resultKind: 'scored' },
  { id: 'score-nan-text', value: 'NaN', resultKind: 'scored' },
  { id: 'score-garbage-text', value: 'garbage', resultKind: 'scored' },
  { id: 'score-null-scored', value: null, resultKind: 'scored' },
  {
    id: 'score-null-low-confidence',
    value: null,
    resultKind: 'low_confidence',
  },
  { id: 'score-normal', value: 7.3, resultKind: 'scored' },
];

export interface HostileInstant {
  id: string;
  /** Written verbatim to `captured_at TEXT`. */
  capturedAt: string;
}

export const HOSTILE_INSTANTS: readonly HostileInstant[] = [
  { id: 'iso-invalid-text', capturedAt: 'not-a-date' },
  { id: 'iso-empty', capturedAt: '' },
  { id: 'iso-feb-30', capturedAt: '2026-02-30T10:00:00.000Z' },
  { id: 'iso-year-0', capturedAt: '0000-01-01T00:00:00.000Z' },
  { id: 'iso-year-275760', capturedAt: '+275760-09-13T00:00:00.000Z' },
  { id: 'iso-epoch', capturedAt: '1970-01-01T00:00:00.000Z' },
  { id: 'iso-far-future', capturedAt: '2999-12-31T23:59:59.000Z' },
];

/** The 12 device locales the lens names (BCP-47 as a device reports them). */
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

/** POSIX LANG values that make Node resolve the same default locale. */
export const LOCALE_TO_LANG: Record<Locale, string> = {
  'de-DE': 'de_DE.UTF-8',
  'fr-FR': 'fr_FR.UTF-8',
  'ar-EG': 'ar_EG.UTF-8',
  'hi-IN': 'hi_IN.UTF-8',
  'ja-JP': 'ja_JP.UTF-8',
  'pt-BR': 'pt_BR.UTF-8',
  'tr-TR': 'tr_TR.UTF-8',
  'ru-RU': 'ru_RU.UTF-8',
  'th-TH': 'th_TH.UTF-8',
  'zh-CN': 'zh_CN.UTF-8',
  'en-IN': 'en_IN.UTF-8',
  'es-419': 'es_419.UTF-8',
};

/** 8 device zones: UTC+14, UTC-12, three DST zones (north, south, +12:45),
 * a 45-minute offset, UTC, and a zone with a recent offset change. */
export const TIME_ZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'Pacific/Chatham',
  'America/Los_Angeles',
  'Europe/Berlin',
  'America/Santiago',
  'Asia/Kathmandu',
  'UTC',
] as const;
export type TimeZone = (typeof TIME_ZONES)[number];

export interface ClockEdge {
  id: string;
  /** The device zone this edge is meaningful in. */
  timeZone: TimeZone;
  /** The instant `new Date()` reports during the render. */
  nowIso: string;
}

/** DST transitions (2026) and day-boundary instants per zone. Each instant is
 * within 90 minutes of a clock discontinuity or a local midnight. */
export const CLOCK_EDGES: readonly ClockEdge[] = [
  // Europe/Berlin: 2026-03-29 01:00Z (+1 → +2), 2026-10-25 01:00Z (+2 → +1)
  {
    id: 'berlin-spring-forward+30m',
    timeZone: 'Europe/Berlin',
    nowIso: '2026-03-29T01:30:00.000Z',
  },
  {
    id: 'berlin-spring-forward-30m',
    timeZone: 'Europe/Berlin',
    nowIso: '2026-03-29T00:30:00.000Z',
  },
  {
    id: 'berlin-fall-back-repeat-hour',
    timeZone: 'Europe/Berlin',
    nowIso: '2026-10-25T00:30:00.000Z',
  },
  {
    id: 'berlin-fall-back+30m',
    timeZone: 'Europe/Berlin',
    nowIso: '2026-10-25T01:30:00.000Z',
  },
  {
    id: 'berlin-local-midnight-1m',
    timeZone: 'Europe/Berlin',
    nowIso: '2026-06-14T21:59:00.000Z',
  },
  // America/Los_Angeles: 2026-03-08 10:00Z (-8 → -7), 2026-11-01 09:00Z (-7 → -8)
  {
    id: 'la-spring-forward+30m',
    timeZone: 'America/Los_Angeles',
    nowIso: '2026-03-08T10:30:00.000Z',
  },
  {
    id: 'la-fall-back-repeat-hour',
    timeZone: 'America/Los_Angeles',
    nowIso: '2026-11-01T08:30:00.000Z',
  },
  {
    id: 'la-fall-back+30m',
    timeZone: 'America/Los_Angeles',
    nowIso: '2026-11-01T09:30:00.000Z',
  },
  {
    id: 'la-local-midnight+1m',
    timeZone: 'America/Los_Angeles',
    nowIso: '2026-07-04T07:01:00.000Z',
  },
  // America/Santiago (southern hemisphere): 2026-04-05 03:00Z (-3 → -4), 2026-09-06 04:00Z (-4 → -3)
  {
    id: 'santiago-fall-back',
    timeZone: 'America/Santiago',
    nowIso: '2026-04-05T02:30:00.000Z',
  },
  {
    id: 'santiago-spring-forward',
    timeZone: 'America/Santiago',
    nowIso: '2026-09-06T04:30:00.000Z',
  },
  // Pacific/Chatham (+12:45 / +13:45): 2026-04-05 01:45Z (→ +12:45), 2026-09-27 01:45Z (→ +13:45)
  {
    id: 'chatham-fall-back',
    timeZone: 'Pacific/Chatham',
    nowIso: '2026-04-05T01:15:00.000Z',
  },
  {
    id: 'chatham-spring-forward',
    timeZone: 'Pacific/Chatham',
    nowIso: '2026-09-27T02:15:00.000Z',
  },
  {
    id: 'chatham-local-midnight-1m',
    timeZone: 'Pacific/Chatham',
    nowIso: '2026-01-14T10:14:00.000Z',
  },
  // UTC+14: local midnight is 10:00Z the previous UTC day.
  {
    id: 'kiritimati-local-midnight-1m',
    timeZone: 'Pacific/Kiritimati',
    nowIso: '2026-03-08T09:59:00.000Z',
  },
  {
    id: 'kiritimati-local-midnight+1m',
    timeZone: 'Pacific/Kiritimati',
    nowIso: '2026-03-08T10:01:00.000Z',
  },
  {
    id: 'kiritimati-new-year',
    timeZone: 'Pacific/Kiritimati',
    nowIso: '2026-12-31T10:30:00.000Z',
  },
  // UTC-12: local midnight is 12:00Z the same UTC day.
  {
    id: 'gmt-12-local-midnight-1m',
    timeZone: 'Etc/GMT+12',
    nowIso: '2026-03-01T11:59:00.000Z',
  },
  {
    id: 'gmt-12-local-midnight+1m',
    timeZone: 'Etc/GMT+12',
    nowIso: '2026-03-01T12:01:00.000Z',
  },
  {
    id: 'gmt-12-leap-day',
    timeZone: 'Etc/GMT+12',
    nowIso: '2028-02-29T11:30:00.000Z',
  },
  // Asia/Kathmandu (+05:45): local midnight is 18:15Z.
  {
    id: 'kathmandu-local-midnight-1m',
    timeZone: 'Asia/Kathmandu',
    nowIso: '2026-05-20T18:14:00.000Z',
  },
  {
    id: 'kathmandu-local-midnight+1m',
    timeZone: 'Asia/Kathmandu',
    nowIso: '2026-05-20T18:16:00.000Z',
  },
  // UTC: month/year boundaries.
  {
    id: 'utc-new-year-1m',
    timeZone: 'UTC',
    nowIso: '2026-12-31T23:59:00.000Z',
  },
  {
    id: 'utc-new-year+1m',
    timeZone: 'UTC',
    nowIso: '2027-01-01T00:01:00.000Z',
  },
  {
    id: 'utc-feb-end-leap',
    timeZone: 'UTC',
    nowIso: '2028-02-29T12:00:00.000Z',
  },
];

/** iPhone widths the lens asks for: SE (320), 13/14 (390 rounded to the
 * 375 design width), Pro Max (430). */
export const WIDTHS = [320, 375, 430] as const;

/** RN iOS `fontScale` multipliers (RCTAccessibilityManager.mm): Large,
 * ExtraExtraLarge, AccessibilityExtraExtraExtraLarge. */
export const FONT_SCALES = [1, 1.235, 3.571] as const;

/** Apple HIG minimum tappable target. */
export const MIN_TARGET_PT = 44;
