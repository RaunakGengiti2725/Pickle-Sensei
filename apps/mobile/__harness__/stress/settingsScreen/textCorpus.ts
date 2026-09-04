import type { SeededRng } from './seededRng';

/**
 * Boundary/i18n string corpus for user-controlled text (display names,
 * onboarding first names, e-mail addresses). Each class exercises one
 * rendering hazard: line breaking, RTL, grapheme clusters wider than one
 * UTF-16 code unit, combining marks, unbroken compounds, empty/whitespace.
 */
export type TextClass =
  | 'latin_short'
  | 'latin_200'
  | 'german_compound'
  | 'cjk_ja'
  | 'cjk_zh'
  | 'arabic_rtl'
  | 'arabic_rtl_200'
  | 'hindi_combining'
  | 'thai_unspaced'
  | 'cyrillic'
  | 'turkish_dotless'
  | 'zwj_emoji'
  | 'emoji_leading'
  | 'astral_leading'
  | 'combining_leading'
  | 'zalgo'
  | 'bidi_override'
  | 'whitespace_only'
  | 'newline_embedded'
  | 'empty';

export const TEXT_CLASSES: readonly TextClass[] = [
  'latin_short',
  'latin_200',
  'german_compound',
  'cjk_ja',
  'cjk_zh',
  'arabic_rtl',
  'arabic_rtl_200',
  'hindi_combining',
  'thai_unspaced',
  'cyrillic',
  'turkish_dotless',
  'zwj_emoji',
  'emoji_leading',
  'astral_leading',
  'combining_leading',
  'zalgo',
  'bidi_override',
  'whitespace_only',
  'newline_embedded',
  'empty',
];

const LATIN_WORDS = [
  'Alexandra',
  'Montgomery',
  'Featherstonehaugh',
  'Villanueva',
  'Oyelaran',
  'Bartholomew',
  'Kristiansen',
  'Papadopoulos',
];
const GERMAN_COMPOUNDS = [
  'Donaudampfschifffahrtsgesellschaftskapitän',
  'Rindfleischetikettierungsüberwachungsaufgabenübertragungsgesetz',
  'Kraftfahrzeughaftpflichtversicherung',
  'Straßenverkehrszulassungsordnung',
];
const JA = [
  '山田太郎',
  '佐藤ゆかり',
  'ピックルボール選手',
  '東京都新宿区西新宿二丁目',
];
const ZH = ['王小明', '陳嘉欣', '匹克球教练', '北京市朝阳区建国路'];
const AR = ['محمد الأحمد', 'فاطمة الزهراء', 'لاعب بيكل بول', 'القاهرة الجديدة'];
const HI = ['अनन्या शर्मा', 'क्षितिज', 'प्रतिज्ञा', 'श्रीनिवास'];
const TH = ['สมชายใจดี', 'นักกีฬาพิคเกิลบอล', 'กรุงเทพมหานคร'];
const RU = ['Александра Петрова', 'Дмитрий Иванов', 'Екатеринбург'];
const TR = ['Işıl Yıldırım', 'İbrahim Çelik', 'ılık'];
const ZWJ = ['👨‍👩‍👧‍👦 Family', '🏳️‍🌈 Sam', '🧑🏽‍🦱 Jordan', '👩‍💻 Priya'];
const ASTRAL = ['𠮷野家', '𝔄𝔩𝔢𝔵', '😀 Casey'];

function repeatTo(
  rng: SeededRng,
  words: readonly string[],
  min: number,
): string {
  let out = rng.pick(words);
  while (out.length < min) out += ` ${rng.pick(words)}`;
  return out;
}

function zalgo(rng: SeededRng, base: string): string {
  const marks = [0x0301, 0x0308, 0x0327, 0x0330, 0x0336, 0x035c, 0x0363];
  let out = '';
  for (const ch of base) {
    out += ch;
    const count = rng.int(1, 4);
    for (let i = 0; i < count; i += 1) {
      out += String.fromCharCode(rng.pick(marks));
    }
  }
  return out;
}

export function textFor(rng: SeededRng, textClass: TextClass): string {
  switch (textClass) {
    case 'latin_short':
      return rng.pick(LATIN_WORDS);
    case 'latin_200':
      return repeatTo(rng, LATIN_WORDS, 200);
    case 'german_compound':
      return rng.pick(GERMAN_COMPOUNDS);
    case 'cjk_ja':
      return rng.chance(0.5) ? rng.pick(JA) : repeatTo(rng, JA, 200);
    case 'cjk_zh':
      return rng.chance(0.5) ? rng.pick(ZH) : repeatTo(rng, ZH, 200);
    case 'arabic_rtl':
      return rng.pick(AR);
    case 'arabic_rtl_200':
      return repeatTo(rng, AR, 200);
    case 'hindi_combining':
      return rng.pick(HI);
    case 'thai_unspaced':
      return rng.chance(0.5) ? rng.pick(TH) : TH.join('').repeat(6);
    case 'cyrillic':
      return rng.pick(RU);
    case 'turkish_dotless':
      return rng.pick(TR);
    case 'zwj_emoji':
      return rng.pick(ZWJ);
    case 'emoji_leading':
      return `${rng.pick(['🎾', '🥒', '🏓', '👋🏾'])} ${rng.pick(LATIN_WORDS)}`;
    case 'astral_leading':
      return rng.pick(ASTRAL);
    case 'combining_leading':
      // NFD "é" + name: the base letter and the accent are separate code units.
      return `e\u0301${rng.pick(['mile', 'lodie', 'tienne'])}`;
    case 'zalgo':
      return zalgo(rng, rng.pick(LATIN_WORDS));
    case 'bidi_override':
      return `\u202E${rng.pick(LATIN_WORDS)}\u202C`;
    case 'whitespace_only':
      return rng.pick([' ', '   ', '\u00a0', '\u3000']);
    case 'newline_embedded':
      return `${rng.pick(LATIN_WORDS)}\n${rng.pick(LATIN_WORDS)}\n${rng.pick(LATIN_WORDS)}`;
    case 'empty':
      return '';
  }
}

/** `Intl.Segmenter` exists in Node 22 but the RN tsconfig lib stops at es2022.string. */
interface GraphemeSegmenter {
  segment(text: string): Iterable<{ segment: string }>;
}
const IntlWithSegmenter = Intl as unknown as {
  Segmenter: new (
    locale: string | undefined,
    options: { granularity: 'grapheme' },
  ) => GraphemeSegmenter;
};

/** Grapheme clusters as VoiceOver/iOS would segment them. */
export function graphemes(text: string): string[] {
  const segmenter = new IntlWithSegmenter.Segmenter(undefined, {
    granularity: 'grapheme',
  });
  return Array.from(segmenter.segment(text), s => s.segment);
}

const ZERO_WIDTH =
  /^(?:[\u200b-\u200f\u202a-\u202e\u2060-\u206f]|\ufe0e|\ufe0f|\p{Mn})$/u;
const WIDE =
  /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}|\p{Extended_Pictographic}/u;

/**
 * Approximate advance width (in em) of one grapheme in a humanist sans such
 * as Manrope. Used only to ESTIMATE line counts — there is no layout engine
 * under Jest, so every estimate is reported as INFERRED, never VERIFIED.
 */
export function graphemeEm(grapheme: string): number {
  if (ZERO_WIDTH.test(grapheme)) return 0;
  if (WIDE.test(grapheme)) return 1.0;
  if (/^\s$/u.test(grapheme)) return 0.28;
  if (/^[A-ZÀ-ÞĀ-ŽА-Я]$/u.test(grapheme)) return 0.66;
  if (/^[0-9]$/u.test(grapheme)) return 0.6;
  if (/^[iljtfr.,:;'!|]$/u.test(grapheme)) return 0.3;
  if (/^[mw]$/u.test(grapheme)) return 0.85;
  return 0.55;
}

export function estimateTextWidthPt(text: string, fontSizePt: number): number {
  return graphemes(text).reduce(
    (sum, g) => sum + graphemeEm(g) * fontSizePt,
    0,
  );
}

/**
 * Estimated wrapped line count of `text` in a box `widthPt` wide. Single
 * words longer than the box are broken by character (React Native/UIKit
 * behaviour), so the bound is ceil(totalWidth / boxWidth) per paragraph.
 */
export function estimateLines(
  text: string,
  fontSizePt: number,
  widthPt: number,
): number {
  if (widthPt <= 0) return Number.POSITIVE_INFINITY;
  return text.split('\n').reduce((lines, paragraph) => {
    const width = estimateTextWidthPt(paragraph, fontSizePt);
    return lines + Math.max(1, Math.ceil(width / widthPt));
  }, 0);
}
