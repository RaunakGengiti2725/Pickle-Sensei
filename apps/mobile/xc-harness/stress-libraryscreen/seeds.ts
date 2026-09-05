/**
 * Seeded variant generator for the LibraryScreen boundary / i18n / a11y
 * stress campaign. Everything a scenario needs is derived from ONE integer
 * seed through a deterministic PRNG, so any row in the results table replays
 * with `STRESS_SEED=<seed>`.
 */

export const STRESS_LOCALES = [
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
export type StressLocale = (typeof STRESS_LOCALES)[number];

/** Eight zones: the two extremes (UTC±14/−12), UTC, three DST-observing
 * zones, and two odd offsets (+05:30, +12:45/+13:45 with DST). */
export const STRESS_TIMEZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Pacific/Chatham',
] as const;
export type StressTimezone = (typeof STRESS_TIMEZONES)[number];

export const FONT_SCALES = [1, 1.5, 2] as const;
export const WINDOW_WIDTHS = [320, 390, 430] as const;

/** Instants that sit on DST transitions somewhere in the zone list, plus a
 * plain mid-year instant and epoch/far-future extremes. */
export const CAPTURED_AT_CORPUS = [
  // Plain, no transition anywhere.
  '2026-06-15T12:00:00.000Z',
  // Europe DST start (Berlin 02:00 → 03:00 at 01:00Z).
  '2026-03-29T00:59:59.000Z',
  '2026-03-29T01:00:00.000Z',
  // Europe DST end (Berlin 03:00 → 02:00 at 01:00Z).
  '2026-10-25T00:59:59.000Z',
  // US DST end (New York 02:00 → 01:00 at 06:00Z).
  '2026-11-01T05:59:59.000Z',
  '2026-11-01T06:00:00.000Z',
  // Lord Howe (30-minute shift) DST start, first Sunday of October 02:00 local.
  '2026-10-03T15:00:00.000Z',
  // Chatham DST end (last Sunday in April 03:45 local = 14:45Z Saturday).
  '2026-04-04T14:45:00.000Z',
  // Date-line extremes: local date differs by two calendar days between
  // Kiritimati and Etc/GMT+12.
  '2026-01-01T00:00:00.000Z',
  '2026-12-31T23:59:59.000Z',
  // Epoch and far future.
  '1970-01-01T00:00:00.000Z',
  '2099-12-31T11:59:59.000Z',
] as const;

/** Values the local SQLite store can hold in `captured_at` that are NOT ISO
 * instants (an older build, a corrupted row). */
export const INVALID_CAPTURED_AT = ['not-a-date', '', '2026-13-45T99:99:99Z'];

const LATIN_200 =
  'Forehand drive with an early unit turn, compact backswing, a stable non-dominant hand, paddle face square through contact, and a full follow-through finishing above the opposite shoulder while recovering to the ready position before the next ball arrives';
const CJK_200 =
  '第三種接近遭遇の技術的検証における反復的練習曲線と、前腕回内運動の最適化、体幹回旋の連動、非利き手の安定化、打点の高さの一貫性、フォロースルーの完了、次球への構え直しを含む総合的な技術評価項目の全体像を示す長い日本語の文章です。'.repeat(
    2,
  );
const ARABIC_200 =
  'ضربة أمامية قوية مع دوران علوي وخطوة متقدمة نحو الشبكة ثم استعادة وضع الاستعداد قبل وصول الكرة التالية مع الحفاظ على استقرار الجذع واليد غير المسيطرة وزاوية المضرب المربعة عند نقطة التلامس '.repeat(
    2,
  );
const HINDI_200 =
  'फोरहैंड ड्राइव में शरीर का प्रारंभिक घुमाव, संक्षिप्त बैकस्विंग, स्थिर गैर-प्रमुख हाथ, संपर्क पर वर्गाकार पैडल फेस और विपरीत कंधे के ऊपर पूर्ण फॉलो-थ्रू शामिल है '.repeat(
    2,
  );
const THAI_200 =
  'การตีลูกโฟร์แฮนด์ด้วยการหมุนตัวตั้งแต่ต้น สวิงกลับสั้นกะทัดรัด มือข้างที่ไม่ถนัดนิ่ง หน้าไม้ตั้งฉากตอนกระทบ และการตามลูกจนสุดเหนือไหล่ตรงข้าม '.repeat(
    3,
  );
const ZWJ_200 = '👨‍👩‍👧‍👦🏳️‍🌈👩🏽‍💻🧑🏿‍🦽👨🏻‍🍳🏴󠁧󠁢󠁳󠁣󠁴󠁿'.repeat(12);
const COMBINING_200 = 'Z̷̢̈́a̶̛͐l̸̙̒g̴̈́o̷̅ ̧̈́f̵̗̄o̶͙͐r̴̈́e̶̛͐h̸̙̒ä̴́n̷̅ḑ̈́ ̵̗̄d̶͙͐r̴̈́i̶̛͐v̸̙̒ë̴́ '.repeat(8);
const GERMAN_COMPOUND =
  'Rückhandtopspinschlagtechnikverbesserungsprogrammdurchführungsverordnung';
const GERMAN_200 = `${GERMAN_COMPOUND} Vorhandunterschnittschlagvorbereitungsphasenanalyse ${GERMAN_COMPOUND} Schlägerkopfbeschleunigungsmessverfahren`;
const RTL_MIXED = 'ضربة forehand_drive أمامية 123 topspin ١٢٣';
const WHITESPACE_ONLY = '   ';
const NO_BREAK_LATIN_200 =
  'forehanddrivewithanearlyunitturncompactbackswingstablenondominanthandpaddlefacesquarethroughcontactandafullfollowthroughfinishingabovetheoppositeshoulderwhilerecoveringtothereadypositionbeforethenextballarrivesx';

export interface TextCase {
  id: string;
  value: string;
}

/** Strings that reach the screen through the local store or the training
 * API. `unrecognized`/`forehand_drive` are the realistic in-domain values;
 * the rest are boundary payloads. */
export const SHOT_TYPE_CORPUS: TextCase[] = [
  { id: 'domain_forehand_drive', value: 'forehand_drive' },
  { id: 'domain_third_shot_drop', value: 'third_shot_drop' },
  { id: 'domain_unrecognized', value: 'unrecognized' },
  { id: 'empty', value: '' },
  { id: 'whitespace', value: WHITESPACE_ONLY },
  { id: 'underscores_only', value: '____' },
  { id: 'latin_200', value: LATIN_200 },
  { id: 'latin_nobreak_200', value: NO_BREAK_LATIN_200 },
  { id: 'cjk_200', value: CJK_200 },
  { id: 'arabic_200', value: ARABIC_200 },
  { id: 'hindi_200', value: HINDI_200 },
  { id: 'thai_200', value: THAI_200 },
  { id: 'zwj_emoji_200', value: ZWJ_200 },
  { id: 'combining_200', value: COMBINING_200 },
  { id: 'german_compound_200', value: GERMAN_200 },
  { id: 'rtl_mixed', value: RTL_MIXED },
  { id: 'literal_null', value: 'null' },
  { id: 'literal_undefined', value: 'undefined' },
  { id: 'literal_nan', value: 'NaN' },
  { id: 'html_like', value: '<b>forehand</b> & "drive"' },
];

export interface ScoreCase {
  id: string;
  /** Bound value for the REAL column; string variants exercise SQLite's
   * dynamic typing (a TEXT value survives in a REAL-affinity column). */
  value: number | string | null;
}

export const SCORE_CORPUS: ScoreCase[] = [
  { id: 'null', value: null },
  { id: 'zero', value: 0 },
  { id: 'negative_zero', value: -0 },
  { id: 'negative', value: -3.25 },
  { id: 'unit', value: 7.85 },
  { id: 'max', value: 10 },
  { id: 'over_max', value: 10.04 },
  { id: 'tiny', value: 1e-7 },
  { id: 'large', value: 123456789.5 },
  { id: 'huge_1e21', value: 1e21 },
  { id: 'max_safe', value: Number.MAX_SAFE_INTEGER },
  { id: 'text_abc', value: 'abc' },
  { id: 'text_inf', value: 'Infinity' },
];

export const DURATION_CORPUS: ScoreCase[] = [
  { id: 'zero', value: 0 },
  { id: 'negative', value: -4200 },
  { id: 'normal', value: 4200 },
  { id: 'half_second', value: 499 },
  { id: 'huge', value: 1e24 },
  { id: 'text_abc', value: 'abc' },
];

export type SessionKind = 'signed_out' | 'local_only' | 'synced';
export type ReadsShape =
  'empty' | 'single' | 'few' | 'many' | 'load_failure' | 'captures_only';
export type SavedShape =
  | 'unconfigured'
  | 'api_error'
  | 'empty'
  | 'drills'
  | 'drills_with_plan'
  | 'drills_unverified'
  | 'mutation_error';

export interface ShotSeed {
  id: string;
  shotType: TextCase;
  capturedAt: string;
  capturedAtValid: boolean;
  score: ScoreCase;
  resultKind: 'scored' | 'low_confidence';
}

export interface CaptureSeed {
  id: string;
  shotType: TextCase;
  declaredStroke: string | null;
  capturedAt: string;
  capturedAtValid: boolean;
  duration: ScoreCase;
  payload: 'null' | 'corrupt' | 'valid' | 'mismatch';
}

export interface DrillSeed {
  slug: string;
  title: TextCase;
  description: TextCase;
  coachName: TextCase;
  withMedia: boolean;
  /** Detail fetch fails → entry is held back with honest copy. */
  detailFails: boolean;
}

export interface PlanSeed {
  shotType: TextCase;
  priorityCheckpoint: TextCase;
  priorityDirection: TextCase;
  items: number;
  completed: number;
}

export interface Variant {
  seed: number;
  locale: StressLocale;
  timezone: StressTimezone;
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WINDOW_WIDTHS)[number];
  rtl: boolean;
  session: SessionKind;
  tab: 'reads' | 'saved';
  reads: ReadsShape;
  saved: SavedShape;
  shots: ShotSeed[];
  captures: CaptureSeed[];
  drills: DrillSeed[];
  plan: PlanSeed | null;
  /** Server-side error message surfaced by the training API (boundary
   * strings reach the inline error / offline card verbatim). */
  apiErrorMessage: TextCase;
  /** Which interactive element the scenario presses after the first render
   * (real navigation into the stack) — null presses nothing. */
  interaction:
    'first_row' | 'explore' | 'plan' | 'connect' | 'empty_cta' | null;
}

/** mulberry32 — small, fast, deterministic. */
export function makePrng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('pick from empty list');
  return item;
}

function pickCapturedAt(rng: () => number): {
  value: string;
  valid: boolean;
} {
  if (rng() < 0.15)
    return { value: pick(rng, INVALID_CAPTURED_AT), valid: false };
  return { value: pick(rng, CAPTURED_AT_CORPUS), valid: true };
}

/** Version-4-shaped UUID: the training API parser requires canonical UUIDs. */
export function uuidFrom(rng: () => number): string {
  const hex = () => Math.floor(rng() * 16).toString(16);
  const seg = (n: number) => Array.from({ length: n }, hex).join('');
  const variant = pick(rng, ['8', '9', 'a', 'b']);
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${variant}${seg(3)}-${seg(12)}`;
}

// src/training/api.ts `isString` rejects blank strings, so a catalog payload
// carrying a whitespace-only title/description/coach is an invalid response
// for the WHOLE saved list (savedStatus=error) and a plan carrying one is
// dropped by the parser (planStatus=error, no plan card).
const blank = (t: TextCase) => t.value.trim().length === 0;
const blankDrill = (d: DrillSeed) =>
  blank(d.title) || blank(d.description) || blank(d.coachName);

export function savedListRejected(
  variant: Pick<Variant, 'saved' | 'drills'>,
): boolean {
  return variant.saved !== 'api_error' && variant.drills.some(blankDrill);
}

export function planRejected(
  variant: Pick<Variant, 'plan' | 'drills'>,
): boolean {
  const plan = variant.plan;
  if (!plan) return false;
  return (
    blank(plan.shotType) ||
    blank(plan.priorityCheckpoint) ||
    blank(plan.priorityDirection) ||
    variant.drills.slice(0, Math.max(1, plan.items)).some(blankDrill)
  );
}

export function variantFromSeed(seed: number): Variant {
  const rng = makePrng(seed);
  const locale = pick(rng, STRESS_LOCALES);
  const session = pick(rng, [
    'signed_out',
    'local_only',
    'synced',
    'synced',
  ] as const);
  const tab = pick(rng, ['reads', 'saved'] as const);
  const reads = pick(rng, [
    'empty',
    'single',
    'few',
    'many',
    'load_failure',
    'captures_only',
  ] as const);
  const saved: SavedShape =
    session !== 'synced'
      ? 'unconfigured'
      : pick(rng, [
          'api_error',
          'empty',
          'drills',
          'drills_with_plan',
          'drills_unverified',
          'mutation_error',
        ] as const);

  const shotCount =
    reads === 'empty' || reads === 'load_failure' || reads === 'captures_only'
      ? 0
      : reads === 'single'
        ? 1
        : reads === 'few'
          ? 3
          : 25;
  const shots: ShotSeed[] = Array.from({ length: shotCount }, (_, i) => {
    const capturedAt = pickCapturedAt(rng);
    const resultKind = rng() < 0.2 ? 'low_confidence' : 'scored';
    return {
      id: `shot-${seed}-${i}`,
      shotType: pick(rng, SHOT_TYPE_CORPUS),
      capturedAt: capturedAt.value,
      capturedAtValid: capturedAt.valid,
      score: pick(rng, SCORE_CORPUS),
      resultKind,
    };
  });

  const captureCount =
    reads === 'captures_only'
      ? 1 + Math.floor(rng() * 4)
      : reads === 'empty' || reads === 'load_failure'
        ? 0
        : Math.floor(rng() * 3);
  const captures: CaptureSeed[] = Array.from(
    { length: captureCount },
    (_, i) => {
      const capturedAt = pickCapturedAt(rng);
      return {
        id: `capture-${seed}-${i}`,
        shotType: pick(rng, SHOT_TYPE_CORPUS),
        declaredStroke: rng() < 0.4 ? 'backhand_dink' : null,
        capturedAt: capturedAt.value,
        capturedAtValid: capturedAt.valid,
        duration: pick(rng, DURATION_CORPUS),
        payload: pick(rng, ['null', 'corrupt', 'valid', 'mismatch'] as const),
      };
    },
  );

  const drillCount =
    saved === 'drills' ||
    saved === 'drills_with_plan' ||
    saved === 'mutation_error'
      ? 1 + Math.floor(rng() * 4)
      : saved === 'drills_unverified'
        ? 1 + Math.floor(rng() * 2)
        : 0;
  const drills: DrillSeed[] = Array.from({ length: drillCount }, (_, i) => ({
    slug: `drill-${seed}-${i}`,
    title: pick(rng, SHOT_TYPE_CORPUS),
    description: pick(rng, SHOT_TYPE_CORPUS),
    coachName: pick(rng, SHOT_TYPE_CORPUS),
    withMedia: rng() < 0.6,
    detailFails: saved === 'drills_unverified',
  }));

  const plan: PlanSeed | null =
    saved === 'drills_with_plan'
      ? (() => {
          const items = Math.floor(rng() * 5);
          return {
            shotType: pick(rng, SHOT_TYPE_CORPUS),
            priorityCheckpoint: pick(rng, SHOT_TYPE_CORPUS),
            priorityDirection: pick(rng, SHOT_TYPE_CORPUS),
            items,
            completed: Math.floor(rng() * (items + 1)),
          };
        })()
      : null;

  const interactions: Variant['interaction'][] = [null];
  if (tab === 'reads' && shotCount > 0) interactions.push('first_row');
  if (
    tab === 'reads' &&
    shotCount === 0 &&
    captureCount === 0 &&
    reads !== 'load_failure'
  )
    interactions.push('empty_cta');
  if (tab === 'saved') interactions.push('explore');
  if (tab === 'saved' && plan && !planRejected({ plan, drills }))
    interactions.push('plan');
  if (tab === 'saved' && session === 'local_only') interactions.push('connect');

  return {
    seed,
    locale,
    timezone: pick(rng, STRESS_TIMEZONES),
    fontScale: pick(rng, FONT_SCALES),
    width: pick(rng, WINDOW_WIDTHS),
    rtl: locale === 'ar-EG',
    session,
    tab,
    reads,
    saved,
    shots,
    captures,
    drills,
    plan,
    apiErrorMessage: pick(rng, SHOT_TYPE_CORPUS),
    interaction: pick(rng, interactions),
  };
}
