/**
 * Boundary / i18n corpus for rendered-tree stress campaigns.
 *
 * Every string here is real Unicode the product may receive from the server
 * catalog (titles, descriptions, coach and creator names, attribution) or
 * from the user's keyboard (search). Locales are the twelve required by the
 * boundary-i18n-a11y lens; each carries sample text in its script plus a
 * width class the clip estimator uses (no layout engine runs under jest).
 */

export type ScriptWidth = 'latin' | 'wide' | 'arabic' | 'indic' | 'thai';

export interface LocaleSample {
  tag: string;
  rtl: boolean;
  width: ScriptWidth;
  /** Short single-line catalog title. */
  title: string;
  /** A sentence-length description fragment. */
  sentence: string;
  /** A person name for coach / creator fields. */
  name: string;
  /** A search query that is an exact substring of `title`. */
  querySubstring: string;
}

export const LOCALES: readonly LocaleSample[] = [
  {
    tag: 'de-DE',
    rtl: false,
    width: 'latin',
    title: 'Rückhandschlagvorbereitungsübung',
    sentence:
      'Grundlinienschlagwiederholungstraining mit Geschwindigkeitsbegrenzungsübungen für Fortgeschrittene.',
    name: 'Jürgen Straßenberger',
    querySubstring: 'Rückhand',
  },
  {
    tag: 'fr-FR',
    rtl: false,
    width: 'latin',
    title: 'Exercice de volée contrôlée à l’épaule',
    sentence:
      'Répétez l’enchaînement jusqu’à ce que le mouvement devienne complètement naturel et régulier.',
    name: 'Éloïse Bœuf-Léautaud',
    querySubstring: 'volée',
  },
  {
    tag: 'ar-EG',
    rtl: true,
    width: 'arabic',
    title: 'تمرين الضربة الخلفية السريعة ١٢٣',
    sentence:
      'كرر الحركة ببطء ثم زد السرعة تدريجيًا مع الحفاظ على وضعية الجسم الصحيحة طوال التمرين.',
    name: 'محمد عبد الرحمن الشرقاوي',
    querySubstring: 'الضربة',
  },
  {
    tag: 'hi-IN',
    rtl: false,
    width: 'indic',
    title: 'बैकहैंड ड्रॉप शॉट अभ्यास',
    sentence:
      'धीरे-धीरे गति बढ़ाते हुए हर बार सही मुद्रा बनाए रखें और पैडल को स्थिर रखें।',
    name: 'श्रीनिवास कृष्णमूर्ति',
    querySubstring: 'ड्रॉप',
  },
  {
    tag: 'ja-JP',
    rtl: false,
    width: 'wide',
    title: 'ディンク練習：キッチンライン反復',
    sentence:
      '姿勢を崩さずにゆっくりと繰り返し、徐々にテンポを上げて安定した接触位置を身につけます。',
    name: '佐々木 陽向',
    querySubstring: 'キッチン',
  },
  {
    tag: 'pt-BR',
    rtl: false,
    width: 'latin',
    title: 'Exercício de saque profundo com rotação',
    sentence:
      'Repita a sequência mantendo a posição atlética e acompanhe a bola até o contato.',
    name: 'João Conceição Araújo',
    querySubstring: 'saque',
  },
  {
    tag: 'tr-TR',
    rtl: false,
    width: 'latin',
    title: 'DİNK İçin Işık Hızında Vole Çalışması',
    sentence:
      'Işığı takip ederken İstanbul kortlarında öğrendiğimiz duruşu koruyun ve sakin kalın.',
    name: 'Işıl Çağlayan Gümüş',
    querySubstring: 'Işık',
  },
  {
    tag: 'ru-RU',
    rtl: false,
    width: 'latin',
    title: 'Упражнение на короткий укороченный удар',
    sentence:
      'Повторяйте движение медленно, сохраняя устойчивую стойку и контролируя положение ракетки.',
    name: 'Ярослав Щербаков-Дмитриевский',
    querySubstring: 'укороченный',
  },
  {
    tag: 'th-TH',
    rtl: false,
    width: 'thai',
    title: 'การฝึกตีลูกดิงก์ที่เส้นครัวอย่างต่อเนื่อง',
    sentence:
      'ทำซ้ำอย่างช้าๆโดยรักษาท่าทางให้มั่นคงและค่อยๆเพิ่มความเร็วเมื่อควบคุมได้ดีขึ้น',
    name: 'ศุภกิตติ์ วัฒนไพศาลกุล',
    querySubstring: 'ดิงก์',
  },
  {
    tag: 'zh-CN',
    rtl: false,
    width: 'wide',
    title: '厨房线小球连续对练训练',
    sentence: '保持运动姿态，缓慢重复动作，逐步提高节奏，直到击球点稳定为止。',
    name: '欧阳靓颢',
    querySubstring: '小球',
  },
  {
    tag: 'en-IN',
    rtl: false,
    width: 'latin',
    title: 'Third-shot drop ladder (₹0 equipment)',
    sentence:
      'Repeat the ladder 1,00,000 times if you must — consistency at the kitchen line wins rallies.',
    name: 'Priyanka Venkatasubramanian',
    querySubstring: 'ladder',
  },
  {
    tag: 'es-419',
    rtl: false,
    width: 'latin',
    title: 'Ejercicio de volea con ñandú y ¿pregunta?',
    sentence:
      'Repite la secuencia manteniendo la posición atlética y sigue la pelota hasta el contacto.',
    name: 'María José Peñaloza Ñúñez',
    querySubstring: 'ñandú',
  },
];

export const LOCALE_TAGS = LOCALES.map(locale => locale.tag);

/** Family emoji built from ZWJ sequences plus flags and a skin-tone modifier. */
export const ZWJ_EMOJI = '👨‍👩‍👧‍👦🏓👍🏽🇧🇷🇯🇵🧑‍🦽‍➡️';

/** Latin letters with stacked combining marks (NFD + "zalgo" stacks). */
export const COMBINING_MARKS =
  'De\u0301fe\u0302nse\u0308 dr\u0330i\u0335l\u0336l\u0338 Z\u0341\u0342\u0343\u0344\u0345a\u0346\u0347\u0348l\u0349\u034ag\u034b\u034c\u034do\u034e\u034f';

/** Bidi controls and invisible code points the product may receive. */
export const BIDI_MIX =
  'Drill \u202Eevird\u202C · ١٢٣ سريع · \u200Fkitchen\u200E';

/** Only zero-width characters: passes a `trim().length > 0` check, renders blank. */
export const ZERO_WIDTH_ONLY = '\u200B\u200C\u200D\u2060';

export const GERMAN_COMPOUND =
  'Donaudampfschifffahrtsgesellschaftskapitänsschlägertrainingsprogramm';

/** 220+ chars, no break opportunity anywhere. */
export const UNBREAKABLE_220 = 'X'.repeat(220);

export const HOSTILE_MARKUP =
  '<script>alert(1)</script> %s %d {{title}} ${title} \\u0000 \u0000 -- ; DROP TABLE drills;';

export const WHITESPACE_PADDED = '   padded   title   ';

export const NEWLINES_INSIDE = 'line one\nline two\r\nline three\ttabbed';

export const CJK_400 = '厨房线小球连续对练训练姿态稳定'.repeat(27);

/** Builds a ≥ 200-char string in the locale's script by repeating its sentence. */
export function longText(locale: LocaleSample, minLength = 200): string {
  let text = locale.sentence;
  while (text.length < minLength) text += ` ${locale.sentence}`;
  return text;
}

export type TitleShape =
  | 'short'
  | 'long200'
  | 'zwj'
  | 'combining'
  | 'bidi'
  | 'german'
  | 'unbreakable'
  | 'hostile'
  | 'padded'
  | 'newlines'
  | 'cjk400'
  | 'zeroWidth';

export const TITLE_SHAPES: readonly TitleShape[] = [
  'short',
  'long200',
  'zwj',
  'combining',
  'bidi',
  'german',
  'unbreakable',
  'hostile',
  'padded',
  'newlines',
  'cjk400',
  'zeroWidth',
];

export function titleFor(locale: LocaleSample, shape: TitleShape): string {
  switch (shape) {
    case 'short':
      return locale.title;
    case 'long200':
      return longText(locale, 200);
    case 'zwj':
      return `${ZWJ_EMOJI} ${locale.title} ${ZWJ_EMOJI}`;
    case 'combining':
      return `${COMBINING_MARKS} ${locale.title}`;
    case 'bidi':
      return `${BIDI_MIX} ${locale.title}`;
    case 'german':
      return `${GERMAN_COMPOUND} ${locale.title}`;
    case 'unbreakable':
      return UNBREAKABLE_220;
    case 'hostile':
      return `${HOSTILE_MARKUP} ${locale.title}`;
    case 'padded':
      return `${WHITESPACE_PADDED}${locale.title}`;
    case 'newlines':
      return `${NEWLINES_INSIDE} ${locale.title}`;
    case 'cjk400':
      return CJK_400;
    case 'zeroWidth':
      return ZERO_WIDTH_ONLY;
  }
}

/** Difficulty strings the server may send (nullable free-form text). */
export const DIFFICULTY_VALUES: readonly (string | null)[] = [
  null,
  '2.0',
  '3.5',
  '0',
  '-1',
  '99999999999999999999',
  '1e308',
  'NaN',
  '٣.٥',
  '３．０',
  'Anfänger',
  ' ',
];

/** Rep / duration / rest values the parser accepts (finite numbers or null). */
export const NULLABLE_COUNTS: readonly (number | null)[] = [
  null,
  0,
  1,
  10,
  -5,
  -30,
  0.5,
  1e9,
  9007199254740991,
  1e300,
];

/** target_sets must be a safe integer ≥ 1. */
export const TARGET_SETS: readonly number[] = [1, 2, 3, 12, 9007199254740991];

/** Local checkpoint scores as persisted (the fact reader drops non-finite). */
export const LOCAL_SCORES: readonly number[] = [
  0, 1, 45, 55, 99, 100, -40, 250, 1e21,
];

export interface TimezoneCase {
  /** IANA zone the jest process is expected to run under (TZ=…). */
  zone: string;
  note: string;
}

/**
 * Eight zones covering UTC±14, half/quarter-hour offsets and both hemispheres'
 * DST edges. `TZ` cannot be switched inside a running jest worker, so the
 * campaign runner starts one process per zone; each scenario records the zone
 * it actually executed under.
 */
export const TIMEZONES: readonly TimezoneCase[] = [
  { zone: 'Etc/GMT-14', note: 'UTC+14 fixed' },
  { zone: 'Etc/GMT+12', note: 'UTC-12 fixed' },
  { zone: 'Pacific/Kiritimati', note: 'UTC+14 (historic -10:40)' },
  { zone: 'America/New_York', note: 'northern DST, spring forward' },
  { zone: 'Europe/Berlin', note: 'northern DST, fall back' },
  { zone: 'Australia/Lord_Howe', note: '30-minute DST shift' },
  { zone: 'Pacific/Chatham', note: '+12:45 / +13:45' },
  { zone: 'Asia/Kolkata', note: '+05:30 no DST' },
];

/**
 * Signed-URL expiry instants written with explicit offsets, chosen around
 * DST transitions and the ±14 extremes. Expiry is compared as an instant, so
 * every case has one unambiguous expected outcome relative to `now`.
 */
export interface ExpiryCase {
  expiresAt: string;
  /** Instant in ms; the harness sets Date.now() = instant - 60_000 for
   * "future" cases and instant + 60_000 for "past" cases. */
  instantMs: number;
  note: string;
}

function instant(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`bad ISO fixture ${iso}`);
  return ms;
}

export const EXPIRY_CASES: readonly ExpiryCase[] = [
  {
    expiresAt: '2026-03-08T02:30:00-05:00',
    instantMs: instant('2026-03-08T02:30:00-05:00'),
    note: 'US spring-forward gap hour (02:30 does not exist locally)',
  },
  {
    expiresAt: '2026-11-01T01:30:00-04:00',
    instantMs: instant('2026-11-01T01:30:00-04:00'),
    note: 'US fall-back repeated hour, first occurrence',
  },
  {
    expiresAt: '2026-10-25T02:30:00+01:00',
    instantMs: instant('2026-10-25T02:30:00+01:00'),
    note: 'EU fall-back repeated hour, second occurrence',
  },
  {
    expiresAt: '2026-01-01T00:00:00+14:00',
    instantMs: instant('2026-01-01T00:00:00+14:00'),
    note: 'UTC+14 midnight (still previous day in UTC)',
  },
  {
    expiresAt: '2026-01-01T00:00:00-12:00',
    instantMs: instant('2026-01-01T00:00:00-12:00'),
    note: 'UTC-12 midnight',
  },
  {
    expiresAt: '2026-04-05T01:45:00+11:00',
    instantMs: instant('2026-04-05T01:45:00+11:00'),
    note: 'Lord Howe 30-minute DST end',
  },
  {
    expiresAt: '2026-09-27T02:45:00+12:45',
    instantMs: instant('2026-09-27T02:45:00+12:45'),
    note: 'Chatham +12:45 DST start',
  },
  {
    expiresAt: '2026-06-15T12:00:00Z',
    instantMs: instant('2026-06-15T12:00:00Z'),
    note: 'plain UTC',
  },
];
