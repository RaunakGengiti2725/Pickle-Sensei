/**
 * Payload corpus for lens `boundary-i18n-a11y`: hostile strings by script
 * class, the locale/time-zone matrix, the responsive window matrix and the
 * numeric extremes injected into every numeric field the components print.
 *
 * The product ships English-only copy (docs/APP_STORE_SUBMISSION.md §3.1),
 * so "locale" here means two verifiable things: (1) the process-level ICU
 * locale/zone the harness driver starts jest under (recorded per run from
 * `Intl.DateTimeFormat().resolvedOptions()`), and (2) locale-tagged hostile
 * content pushed through every free-string prop the components render.
 */

export type StringClass =
  | 'ascii_long_200'
  | 'ascii_long_1000'
  | 'cjk_ja'
  | 'cjk_zh'
  | 'arabic_rtl'
  | 'arabic_rtl_bidi_marks'
  | 'hebrew_rtl'
  | 'zwj_emoji'
  | 'emoji_flags_skin_tones'
  | 'combining_marks_zalgo'
  | 'devanagari_conjuncts'
  | 'thai_no_spaces'
  | 'german_compound'
  | 'turkish_dotless_i'
  | 'cyrillic'
  | 'bidi_override_control'
  | 'whitespace_only'
  | 'newlines_tabs'
  | 'empty'
  | 'nul_and_control'
  | 'unpaired_surrogate'
  | 'nbsp_and_zero_width';

const REPEAT = (unit: string, minLength: number): string => {
  let out = '';
  while (out.length < minLength) out += unit;
  return out;
};

const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitän',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherung',
  'Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung',
];

export const STRING_CORPUS: Record<StringClass, readonly string[]> = {
  ascii_long_200: [
    REPEAT('temporal-stroke-heuristic-', 220),
    REPEAT('A very long pose model version identifier without any break ', 240),
    REPEAT('x', 256),
  ],
  ascii_long_1000: [REPEAT('apple-vision-bodypose-', 1024)],
  cjk_ja: [
    '姿勢推定モデルのバージョン識別子は非常に長くなる可能性がありますので注意してください',
    REPEAT('東京特許許可局', 210),
  ],
  cjk_zh: [
    '骨骼关键点检测器版本标识符',
    REPEAT('摄像机运动检测算法版本号', 205),
  ],
  arabic_rtl: [
    'نموذج تقدير الوضعية الإصدار الثاني',
    REPEAT('خوارزمية اكتشاف حركة الضربة ', 210),
  ],
  arabic_rtl_bidi_marks: [
    '\u200fالإصدار\u200f 2.1 \u200fمن النموذج\u200f',
    '\u202bversion\u202c 3 \u202bمرحبا\u202c',
  ],
  hebrew_rtl: ['גרסת מודל זיהוי תנוחה 2', REPEAT('שלום עולם ', 205)],
  zwj_emoji: ['👨‍👩‍👧‍👦👩‍❤️‍💋‍👩🧑🏽‍🦽🏳️‍🌈🏴󠁧󠁢󠁳󠁣󠁴󠁿', REPEAT('👨‍👩‍👧‍👦', 60)],
  emoji_flags_skin_tones: ['🇯🇵🇩🇪🇧🇷🇮🇳👍🏻👍🏼👍🏽👍🏾👍🏿', REPEAT('🇺🇳🏓', 110)],
  combining_marks_zalgo: [
    'Z̶̗̘̙̜̝̞̟̠̤̥̦̩̪̫̬̭a͛l̥g̎o̊ ṁ̈́ơ̧̨̜̗ḑ̳̠̤ȅ̝̞̟l̙̜̝',
    REPEAT('e\u0301\u0302\u0303\u0304\u0305\u0306', 60),
  ],
  devanagari_conjuncts: [
    'क्षत्रिय संस्कृत द्वितीय प्रतिबिम्ब',
    REPEAT('श्रीमद्भगवद्गीता ', 205),
  ],
  thai_no_spaces: [
    'กรุงเทพมหานครอมรรัตนโกสินทร์มหินทรายุธยา',
    REPEAT('เวอร์ชันโมเดลตรวจจับท่าทาง', 205),
  ],
  german_compound: GERMAN_COMPOUNDS,
  turkish_dotless_i: ['İSTANBUL ıi İı Iİ', REPEAT('dİYARBAKIR ', 205)],
  cyrillic: [
    'Версия модели оценки позы',
    REPEAT('Алгоритм обнаружения удара ', 205),
  ],
  bidi_override_control: [
    '\u202eabc def\u202c',
    'A\u202eB\u202dC\u2066D\u2069',
  ],
  whitespace_only: ['   ', '\u3000\u3000', '\u00a0'],
  newlines_tabs: ['line one\nline two\r\nline\tthree', '\n\n\n'],
  empty: [''],
  nul_and_control: ['\u0000nul\u0001\u0002', 'bell\u0007\u001b[31mred'],
  unpaired_surrogate: ['\ud83d', 'a\udc00b'],
  nbsp_and_zero_width: ['a\u200bb\u200cc\u200dd\ufeffe', '\u00a0\u00a0x\u00a0'],
};

export const STRING_CLASSES = Object.keys(STRING_CORPUS) as StringClass[];

/** The 12 requested locales, each tagged with the string classes it exercises. */
export const LOCALES: ReadonlyArray<{
  tag: string;
  posix: string;
  classes: readonly StringClass[];
}> = [
  {
    tag: 'de-DE',
    posix: 'de_DE.UTF-8',
    classes: ['german_compound', 'ascii_long_200'],
  },
  {
    tag: 'fr-FR',
    posix: 'fr_FR.UTF-8',
    classes: ['combining_marks_zalgo', 'nbsp_and_zero_width'],
  },
  {
    tag: 'ar-EG',
    posix: 'ar_EG.UTF-8',
    classes: ['arabic_rtl', 'arabic_rtl_bidi_marks', 'bidi_override_control'],
  },
  {
    tag: 'hi-IN',
    posix: 'hi_IN.UTF-8',
    classes: ['devanagari_conjuncts', 'combining_marks_zalgo'],
  },
  { tag: 'ja-JP', posix: 'ja_JP.UTF-8', classes: ['cjk_ja', 'zwj_emoji'] },
  {
    tag: 'pt-BR',
    posix: 'pt_BR.UTF-8',
    classes: ['emoji_flags_skin_tones', 'ascii_long_1000'],
  },
  {
    tag: 'tr-TR',
    posix: 'tr_TR.UTF-8',
    classes: ['turkish_dotless_i', 'whitespace_only'],
  },
  {
    tag: 'ru-RU',
    posix: 'ru_RU.UTF-8',
    classes: ['cyrillic', 'newlines_tabs'],
  },
  { tag: 'th-TH', posix: 'th_TH.UTF-8', classes: ['thai_no_spaces', 'empty'] },
  {
    tag: 'zh-CN',
    posix: 'zh_CN.UTF-8',
    classes: ['cjk_zh', 'nul_and_control'],
  },
  {
    tag: 'en-IN',
    posix: 'en_IN.UTF-8',
    classes: ['devanagari_conjuncts', 'unpaired_surrogate'],
  },
  {
    tag: 'es-419',
    posix: 'es_MX.UTF-8',
    classes: ['ascii_long_200', 'hebrew_rtl'],
  },
];

/**
 * Time zones the driver starts jest under (jest sandboxes process.env, so a
 * zone cannot be switched in-process). Etc/GMT-14 is fixed UTC+14 and
 * Etc/GMT+12 fixed UTC−12 (the westernmost real offset; no IANA zone sits at
 * UTC−14). The DST zones pair with the instants below.
 */
export const TIMEZONES: readonly string[] = [
  'UTC',
  'Etc/GMT-14',
  'Etc/GMT+12',
  'Pacific/Kiritimati',
  'Europe/Berlin',
  'America/Los_Angeles',
  'Pacific/Auckland',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'Asia/Kathmandu',
  'America/St_Johns',
  'Pacific/Chatham',
];

/** Instants straddling 2026 DST transitions plus epoch/overflow edges. */
export const DST_EDGE_INSTANTS: ReadonlyArray<{ id: string; iso: string }> = [
  { id: 'berlin-spring-before', iso: '2026-03-29T00:59:59.999Z' },
  { id: 'berlin-spring-after', iso: '2026-03-29T01:00:00.000Z' },
  { id: 'berlin-fall-before', iso: '2026-10-25T00:59:59.999Z' },
  { id: 'berlin-fall-after', iso: '2026-10-25T01:00:00.000Z' },
  { id: 'la-spring-before', iso: '2026-03-08T09:59:59.999Z' },
  { id: 'la-spring-after', iso: '2026-03-08T10:00:00.000Z' },
  { id: 'la-fall-before', iso: '2026-11-01T08:59:59.999Z' },
  { id: 'la-fall-after', iso: '2026-11-01T09:00:00.000Z' },
  { id: 'auckland-spring', iso: '2026-09-26T14:00:00.000Z' },
  { id: 'auckland-fall', iso: '2026-04-04T14:00:00.000Z' },
  { id: 'lord-howe-spring', iso: '2026-10-03T15:00:00.000Z' },
  { id: 'chatham-spring', iso: '2026-09-26T14:45:00.000Z' },
  { id: 'kiritimati-newyear', iso: '2026-12-31T10:00:00.000Z' },
  { id: 'epoch', iso: '1970-01-01T00:00:00.000Z' },
  { id: 'y2038', iso: '2038-01-19T03:14:07.000Z' },
  { id: 'leap-day', iso: '2028-02-29T23:59:59.999Z' },
];

/** 3 widths × 3 font scales (the lens grid). */
export const GRID_WIDTHS: readonly number[] = [320, 375, 430];
export const GRID_FONT_SCALES: readonly number[] = [1, 1.35, 2.3];

/** Extra window samples for the seeded campaign: thresholds and outliers. */
export const CAMPAIGN_WIDTHS: readonly number[] = [
  0,
  1,
  200,
  319,
  320,
  349,
  350,
  351,
  375,
  390,
  409,
  410,
  411,
  430,
  744,
  1024,
  Number.MAX_SAFE_INTEGER,
];
export const CAMPAIGN_FONT_SCALES: readonly number[] = [
  0,
  0.5,
  0.85,
  1,
  1.1,
  1.15,
  1.151,
  1.2,
  1.201,
  1.35,
  1.6,
  2,
  2.3,
  3.1,
  4,
  10,
  Number.NaN,
];

/** Numeric extremes injected into numeric fields (as-typed, no coercion). */
export const NUMERIC_EXTREMES: readonly number[] = [
  0,
  -0,
  -1,
  -1e6,
  1e-9,
  0.4999999,
  0.5,
  0.99999999,
  1,
  1.0000001,
  255,
  65535,
  1e6,
  1e15,
  Number.MAX_SAFE_INTEGER,
  1e21,
  1e300,
  Number.MAX_VALUE,
  Number.EPSILON,
  Number.MIN_VALUE,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.NaN,
];

/** Store-policy words that must never appear in fixed product copy. */
export const FORBIDDEN_COPY_TERMS: readonly string[] = [
  'Android',
  'Google Play',
  'guest mode',
  'Live Court',
  'DUPR',
  'SwingVision',
  'PB Vision',
  'Selkirk',
  'JOOLA',
];

export function stringsForLocale(tag: string): readonly StringClass[] {
  const locale = LOCALES.find(l => l.tag === tag);
  return locale ? locale.classes : STRING_CLASSES;
}
