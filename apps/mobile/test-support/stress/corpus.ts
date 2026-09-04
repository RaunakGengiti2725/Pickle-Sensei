/**
 * Boundary / i18n / a11y corpus for the technique-intent + walkthrough
 * stress suites. Everything here is plain data so a failing seed can be
 * reproduced byte-for-byte from the campaign table.
 */

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

/**
 * Eight IANA zones covering both extremes of the UTC offset range and DST
 * transitions (`process.env.TZ` is honoured by Node at runtime).
 */
export const TIMEZONES = [
  'UTC',
  'Pacific/Kiritimati', // UTC+14, the eastern extreme
  'Etc/GMT+12', // UTC−12, the western extreme
  'America/New_York', // US DST (2026-03-08 / 2026-11-01)
  'Europe/Berlin', // EU DST (2026-03-29 / 2026-10-25)
  'Australia/Lord_Howe', // 30-minute DST shift
  'Asia/Kolkata', // +05:30, no DST
  'Pacific/Chatham', // +12:45 / +13:45
] as const;
export type Timezone = (typeof TIMEZONES)[number];

/** Instants sitting on DST edges (and one plain one) for the clock axis. */
export const DST_EDGE_INSTANTS = [
  '2026-03-08T06:59:59.000Z', // one second before US spring-forward
  '2026-03-08T07:00:00.000Z', // US spring-forward
  '2026-10-25T00:59:59.000Z', // one second before EU fall-back
  '2026-10-25T01:00:00.000Z', // EU fall-back
  '2026-04-05T15:00:00.000Z', // Lord Howe fall-back window
  '2026-09-27T14:45:00.000Z', // Chatham spring-forward window
  '2026-01-01T00:00:00.000Z',
  '2026-06-30T12:00:00.000Z',
] as const;

/** iOS Dynamic Type content-size multipliers: Large (default), xxxLarge,
 *  and AX2 (≈200 %, the "Larger Text" bar quoted in the store dossier). */
export const FONT_SCALES = [1, 1.353, 2.143] as const;
export type FontScale = (typeof FONT_SCALES)[number];

/** Three portrait iPhone windows, narrowest to widest. */
export const VIEWPORTS = [
  { name: 'iphone-se1-320', width: 320, height: 568 },
  { name: 'iphone-se3-375', width: 375, height: 667 },
  { name: 'iphone-pro-max-430', width: 430, height: 932 },
] as const;
export type Viewport = (typeof VIEWPORTS)[number];

/** Characters that push text shaping: ZWJ emoji, combining marks, RTL. */
export const ZWJ_FAMILY = '👨‍👩‍👧‍👦';
export const ZWJ_FLAG = '🏴󠁧󠁢󠁳󠁣󠁴󠁿';
export const ZALGO_DINK =
  'd\u0301\u0327i\u0308\u0334n\u0302\u0361k\u0303\u0316';
export const RTL_OVERRIDE = '\u202e';
export const ARABIC_LETTER_MARK = '\u061c';
export const NBSP = '\u00a0';
export const ZWSP = '\u200b';

/** 200+ character payloads per script (each ≥ 200 UTF-16 code units). */
export const LONG_STRINGS = {
  latinTechniqueSpam: 'backhand dink forehand drive third shot drop '.repeat(6),
  cjk: '正手抽球反手轻挑发球接发球第三拍吊球截击半截击高压球挑球放小球'.repeat(
    8,
  ),
  arabic:
    'ضربة أمامية ضربة خلفية إرسال إرجاع الإرسال الضربة الثالثة كرة طائرة '.repeat(
      4,
    ),
  emojiZwj: `${ZWJ_FAMILY}${ZWJ_FLAG}🏓‍♀️🎾‍♂️`.repeat(12),
  combining: ZALGO_DINK.repeat(20),
  germanCompound:
    'Rückhandvolleyschlagtechnikverbesserungstrainingseinheit Vorhandaufschlagrückgabegrundlinienschlagkombination Donaudampfschifffahrtsgesellschaftskapitänsschlägerhaltung',
  thaiNoSpaces:
    'ตีลูกโฟร์แฮนด์ตีลูกแบ็คแฮนด์เสิร์ฟรับลูกเสิร์ฟดิงค์วอลเลย์ลูกที่สามลูกตบลูกโยน'.repeat(
      4,
    ),
  devanagari:
    'फोरहैंड ड्राइव बैकहैंड डिंक सर्व रिटर्न थर्ड शॉट ड्रॉप वॉली ओवरहेड लॉब '.repeat(
      4,
    ),
  cyrillic:
    'форхенд драйв бэкхенд динк подача приём третий удар дроп воллей смэш '.repeat(
      4,
    ),
} as const;

/**
 * What a player in each locale might type or dictate into the technique
 * field: native-language technique names, transliterations, mixed-script
 * phrases, and locale-specific casing traps.
 */
export const LOCALE_INPUTS: Record<Locale, readonly string[]> = {
  'de-DE': [
    'Rückhand-Volley',
    'Vorhand Drive',
    'Aufschlag',
    LONG_STRINGS.germanCompound,
    'Ich weiß nicht',
    'dritter Schlag Drop',
  ],
  'fr-FR': [
    'revers volée',
    'coup droit',
    'service',
    'je ne sais pas',
    'dink du revers',
    'troisième coup amorti',
  ],
  'ar-EG': [
    'ضربة خلفية',
    'إرسال',
    `${ARABIC_LETTER_MARK}سيرف serve`,
    LONG_STRINGS.arabic,
    `${RTL_OVERRIDE}dink`,
    'لا أعرف',
  ],
  'hi-IN': [
    'बैकहैंड डिंक',
    'सर्व',
    'फोरहैंड ड्राइव',
    LONG_STRINGS.devanagari,
    'pata nahi',
    'backhand डिंक',
  ],
  'ja-JP': [
    'バックハンドディンク',
    'サーブ',
    'フォアハンドドライブ',
    LONG_STRINGS.cjk,
    'わからない',
    'ｂａｃｋｈａｎｄ　ｄｉｎｋ',
  ],
  'pt-BR': [
    'saque',
    'voleio de esquerda',
    'direita',
    'não sei',
    'terceira bola curta',
    'dink de esquerda',
  ],
  'tr-TR': [
    'DİNK',
    'SERVİS',
    'BACKHAND DİNK',
    'bilmiyorum',
    'ıI dink',
    'FOREHAND DRIVE',
  ],
  'ru-RU': [
    'бэкхенд динк',
    'подача',
    'форхенд драйв',
    LONG_STRINGS.cyrillic,
    'не знаю',
    'dink бэкхенд',
  ],
  'th-TH': [
    'เสิร์ฟ',
    'ดิงค์',
    LONG_STRINGS.thaiNoSpaces,
    'ไม่รู้',
    'แบ็คแฮนด์ dink',
    'ลูกที่สาม',
  ],
  'zh-CN': [
    '反手轻挑',
    '发球',
    '正手抽球',
    LONG_STRINGS.cjk,
    '不知道',
    '反手 dink',
  ],
  'en-IN': [
    'backhand dink yaar',
    'third shot drop na',
    'serve only',
    'not sure ya',
    'forehand drive bhai',
    'dink',
  ],
  'es-419': [
    'saque',
    'revés',
    'derecha volea',
    'no sé',
    'dink de revés',
    'tercer tiro corto',
  ],
};

/** Script-agnostic boundary payloads for the technique field. */
export const BOUNDARY_INPUTS: readonly { id: string; text: string }[] = [
  { id: 'empty', text: '' },
  { id: 'single-space', text: ' ' },
  { id: 'two-chars', text: 'di' },
  { id: 'three-spaces', text: '   ' },
  { id: 'literal-null', text: 'null' },
  { id: 'literal-undefined', text: 'undefined' },
  { id: 'nbsp-separated', text: `backhand${NBSP}dink` },
  { id: 'zwsp-inside-word', text: `din${ZWSP}k` },
  { id: 'curly-apostrophe-auto', text: 'I don’t know' },
  { id: 'straight-apostrophe-auto', text: "I don't know" },
  { id: 'curly-apostrophe-negation', text: 'don’t want the forehand drive' },
  { id: 'straight-apostrophe-negation', text: "don't want the forehand drive" },
  { id: 'fullwidth-latin', text: 'ｆｏｒｅｈａｎｄ ｄｒｉｖｅ' },
  { id: 'turkish-dotted-capital-i', text: 'DİNK' },
  { id: 'accented-latin', text: 'fórehand drívé' },
  { id: 'nfd-decomposed', text: 'fo\u0301rehand dri\u0301ve' },
  { id: 'zalgo', text: ZALGO_DINK },
  { id: 'zwj-family-then-dink', text: `${ZWJ_FAMILY} dink` },
  { id: 'zwj-flag-only', text: ZWJ_FLAG },
  { id: 'rtl-override-dink', text: `${RTL_OVERRIDE}dink` },
  { id: 'nb-hyphen-third-shot', text: 'third\u2011shot drop' },
  { id: 'en-dash-cross-court', text: 'cross–court dink' },
  { id: 'control-chars', text: 'back\u0000hand\u0007 dink\u001b' },
  { id: 'newline-inside', text: 'backhand\ndink' },
  { id: 'tab-inside', text: 'backhand\tdink' },
  { id: 'long-latin-280', text: LONG_STRINGS.latinTechniqueSpam },
  { id: 'long-cjk', text: LONG_STRINGS.cjk },
  { id: 'long-arabic', text: LONG_STRINGS.arabic },
  { id: 'long-emoji-zwj', text: LONG_STRINGS.emojiZwj },
  { id: 'long-combining', text: LONG_STRINGS.combining },
  { id: 'long-thai', text: LONG_STRINGS.thaiNoSpaces },
  { id: 'huge-latin-5k', text: 'forehand '.repeat(555) + 'drive' },
  { id: 'huge-noise-20k', text: 'x'.repeat(20000) },
  { id: 'negation-filler-flood', text: 'not ' + 'a '.repeat(3000) + 'x' },
  { id: 'negation-technique-flood', text: 'not ' + 'serve '.repeat(1500) },
];

/** Technique vocabulary the resolver understands, for the random generator. */
export const TECHNIQUE_WORDS = [
  'forehand',
  'backhand',
  'dink',
  'drive',
  'drop',
  'serve',
  'return',
  'volley',
  'third shot',
  'reset',
  'overhead',
  'lob',
  'smash',
  'half volley',
  'punch volley',
  'ernie',
  'atp',
  'speed up',
  'cross court',
  'top spin',
] as const;

export const NEGATION_WORDS = [
  'not',
  'no',
  "don't",
  'don’t',
  'never',
  'without',
  'except',
  'skip',
  'instead of',
  'rather than',
] as const;

export const AUTO_WORDS = [
  'auto',
  'not sure',
  "don't know",
  'don’t know',
  'no idea',
  'whatever',
  'surprise me',
  'anything',
] as const;

export const NOISE_TOKENS = [
  ZWJ_FAMILY,
  ZWJ_FLAG,
  ZALGO_DINK,
  RTL_OVERRIDE,
  ARABIC_LETTER_MARK,
  NBSP,
  ZWSP,
  '\u0000',
  '\n',
  '\t',
  'サーブ',
  'سيرف',
  'दिंक',
  'ดิงค์',
  '发球',
  'Rückhand',
  'İ',
  'ı',
  'ß',
  '’',
  '—',
  '“',
  '”',
  '…',
  '🏓',
] as const;
