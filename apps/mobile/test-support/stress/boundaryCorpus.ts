/**
 * Boundary / i18n corpus for component stress campaigns.
 *
 * Every generator is a pure function of the seeded RNG so a variant is fully
 * described by (campaign seed, iteration). String classes cover the
 * `boundary-i18n-a11y` lens: 200+ char runs, CJK, Arabic RTL + bidi mixing,
 * ZWJ emoji, stacked combining marks, German compounds, Thai (no word
 * spaces), Devanagari conjuncts, zero-width/control characters, empty and
 * whitespace-only values.
 */
import type { SeededRng } from './seededRng';

export type StringClass =
  | 'empty'
  | 'whitespace'
  | 'latin-short'
  | 'latin-200-words'
  | 'latin-240-unbroken'
  | 'cjk-200'
  | 'arabic-rtl-200'
  | 'bidi-mixed'
  | 'zwj-emoji'
  | 'combining-marks'
  | 'german-compound'
  | 'thai-200'
  | 'devanagari'
  | 'zero-width-control'
  | 'numeric-like';

export const STRING_CLASSES: readonly StringClass[] = [
  'empty',
  'whitespace',
  'latin-short',
  'latin-200-words',
  'latin-240-unbroken',
  'cjk-200',
  'arabic-rtl-200',
  'bidi-mixed',
  'zwj-emoji',
  'combining-marks',
  'german-compound',
  'thai-200',
  'devanagari',
  'zero-width-control',
  'numeric-like',
];

const LATIN_WORDS = [
  'Third',
  'shot',
  'drop',
  'ladder',
  'kitchen',
  'line',
  'reset',
  'dink',
  'crosscourt',
  'transition',
  'paddle',
  'footwork',
  'soft',
  'hands',
  'volley',
  'reposition',
];

const CJK_RUN =
  '第三球放短练习强调从底线向厨房线的过渡，保持手腕稳定，击球点位于身体前方，落点控制在对方非截击区内。' +
  '日本語の練習では手首を固定し、身体の前でボールを捉えることを意識してください。';

const ARABIC_RUN =
  'تمرين الضربة الثالثة الناعمة يركز على الانتقال من خط القاعدة إلى منطقة المطبخ مع الحفاظ على ثبات المعصم ونقطة التلامس أمام الجسم وتوجيه الكرة إلى المنطقة غير القابلة للضرب الطائرة عند الخصم';

const THAI_RUN =
  'การฝึกตีลูกที่สามแบบนุ่มนวลเน้นการเคลื่อนที่จากเส้นหลังไปยังเส้นครัวโดยรักษาข้อมือให้มั่นคงและจุดสัมผัสอยู่ด้านหน้าลำตัวพร้อมควบคุมให้ลูกตกในเขตห้ามวอลเลย์ของฝ่ายตรงข้าม';

const DEVANAGARI_RUN =
  'तीसरे शॉट ड्रॉप अभ्यास में बेसलाइन से किचन लाइन तक संक्रमण पर ध्यान दें, कलाई स्थिर रखें और संपर्क बिंदु शरीर के सामने रखें; गेंद को प्रतिद्वंद्वी के नॉन-वॉली ज़ोन में गिराएँ।';

const GERMAN_COMPOUNDS = [
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Donaudampfschifffahrtselektrizitätenhauptbetriebswerkbauunterbeamtengesellschaft',
  'Kraftfahrzeughaftpflichtversicherung',
  'Grundstücksverkehrsgenehmigungszuständigkeitsübertragungsverordnung',
];

const ZWJ_EMOJI = ['👨‍👩‍👧‍👦', '👩🏽‍🔬', '🏳️‍🌈', '🧑🏿‍🤝‍🧑🏻', '🇺🇳', '🏓', '1️⃣', '👁️‍🗨️', '🫱🏼‍🫲🏾'];

const COMBINING_MARKS = [
  '\u0300',
  '\u0301',
  '\u0302',
  '\u0303',
  '\u0308',
  '\u030C',
  '\u0316',
  '\u0317',
  '\u031F',
  '\u0324',
  '\u0334',
  '\u035C',
  '\u0360',
  '\u0489',
];

function repeatToLength(run: string, minLength: number): string {
  let out = run;
  while ([...out].length < minLength) out += run;
  return out;
}

export function generateString(rng: SeededRng, cls: StringClass): string {
  switch (cls) {
    case 'empty':
      return '';
    case 'whitespace':
      return ' '.repeat(rng.int(1, 12));
    case 'latin-short': {
      const n = rng.int(1, 4);
      const words: string[] = [];
      for (let i = 0; i < n; i += 1) words.push(rng.pick(LATIN_WORDS));
      return words.join(' ');
    }
    case 'latin-200-words': {
      const words: string[] = [];
      let length = 0;
      const target = rng.int(200, 320);
      while (length < target) {
        const w = rng.pick(LATIN_WORDS);
        words.push(w);
        length += w.length + 1;
      }
      return words.join(' ');
    }
    case 'latin-240-unbroken': {
      let out = '';
      const target = rng.int(240, 300);
      while (out.length < target) out += rng.pick(LATIN_WORDS);
      return out;
    }
    case 'cjk-200':
      return repeatToLength(CJK_RUN, rng.int(200, 260));
    case 'arabic-rtl-200':
      return '\u200F' + repeatToLength(ARABIC_RUN, rng.int(200, 260));
    case 'bidi-mixed':
      return `${rng.pick(LATIN_WORDS)} ${ARABIC_RUN.slice(0, 40)} 3×10 ${rng.pick(
        LATIN_WORDS,
      )} \u0661\u0662\u0663 ${ARABIC_RUN.slice(41, 80)} (v2)`;
    case 'zwj-emoji': {
      const parts: string[] = [];
      const n = rng.int(20, 60);
      for (let i = 0; i < n; i += 1) parts.push(rng.pick(ZWJ_EMOJI));
      return parts.join('');
    }
    case 'combining-marks': {
      let out = '';
      const bases = 'Pickle Sensei drill';
      const target = rng.int(200, 320);
      while ([...out].length < target) {
        for (const base of bases) {
          out += base;
          if (base !== ' ') {
            const marks = rng.int(1, 6);
            for (let i = 0; i < marks; i += 1) out += rng.pick(COMBINING_MARKS);
          }
        }
      }
      return out;
    }
    case 'german-compound': {
      let out = '';
      while (out.length < 200) out += rng.pick(GERMAN_COMPOUNDS);
      return out;
    }
    case 'thai-200':
      return repeatToLength(THAI_RUN, rng.int(200, 260));
    case 'devanagari':
      return repeatToLength(DEVANAGARI_RUN, rng.int(120, 240));
    case 'zero-width-control':
      return `Soft\u200Bhands\u200C\u200D\uFEFF\treset\n\nline\u2028two\u00A0end\u061C`;
    case 'numeric-like':
      return rng.pick([
        '0',
        '-1',
        '1e308',
        '٣ × ١٠',
        '12345678901234567890123456789012345678901234567890',
        'NaN',
        'null',
        'undefined',
      ]);
    default: {
      const exhaustive: never = cls;
      throw new Error(`unknown string class ${String(exhaustive)}`);
    }
  }
}

/** Nullable numeric boundary pools per training field (DB CHECK domain noted). */
export const NUMERIC_POOLS = {
  // DB: 1..20
  targetSets: [
    null,
    0,
    -0,
    -1,
    1,
    3,
    20,
    21,
    500,
    1_000_000,
    2.5,
    NaN,
    Infinity,
  ],
  // DB: 1..500
  targetReps: [null, 0, -5, 1, 10, 500, 501, 1_000_000_000, 2.5, NaN],
  // DB: 10..7200
  targetDuration: [null, 0, -30, 10, 45, 60, 3600, 7200, 7201, 1_000_000_000],
  // DB: 0..900
  rest: [null, 0, -1, 30, 900, 901, 1_000_000, Number.MAX_SAFE_INTEGER],
  // DB: 1..20
  position: [0, -1, 1, 3, 4, 9, 10, 20, 21, 100, 1_000_000, NaN],
} as const;

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

/** 8 zones: UTC+14 / UTC-12 extremes, DST zones (US, EU, southern 30-min), odd offsets, UTC. */
export const TIMEZONES = [
  'Pacific/Kiritimati',
  'Etc/GMT+12',
  'America/New_York',
  'Europe/Berlin',
  'Australia/Lord_Howe',
  'Asia/Kolkata',
  'Pacific/Chatham',
  'UTC',
] as const;
export type TimeZone = (typeof TIMEZONES)[number];

/** Instants that straddle a calendar day or a DST transition in the zones above. */
export const EDGE_INSTANTS = [
  '2026-03-08T07:00:00.000Z', // US spring-forward (02:00 EST does not exist)
  '2026-03-29T01:00:00.000Z', // EU spring-forward
  '2026-11-01T06:00:00.000Z', // US fall-back (01:00 EST happens twice)
  '2026-10-25T01:00:00.000Z', // EU fall-back
  '2026-04-05T15:00:00.000Z', // Lord Howe DST end (30-minute shift)
  '2026-06-15T10:00:00.000Z', // 16 Jun at UTC+14, 14 Jun at UTC-12
  '1970-01-01T00:00:00.000Z',
  '2038-01-19T03:14:08.000Z',
] as const;

export const FONT_SCALES = [1, 1.353, 3.118] as const; // iOS Large, xxxLarge, AX5
export const DEVICE_WIDTHS = [320, 375, 430] as const; // iPhone SE, 13/14, 15 Pro Max
