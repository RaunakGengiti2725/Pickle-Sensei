// Shared Unicode corpus + seeded generators for the cross-cutting i18n
// harness (`xc_i18n_*_test.ts`). Deterministic: every generated string is a
// pure function of (seed, index) so a failing case can be replayed from the
// JSON artifact alone.
//
// Unit conventions used across the harness:
//   u16       → JavaScript `string.length` (UTF-16 code units)
//   cp        → `Array.from(s).length` (Unicode code points; DB char_length)
//   graphemes → `Intl.Segmenter(granularity: "grapheme")` (what a person sees)
//   bytes     → UTF-8 byte length (what the request-body cap counts)

export interface Rng {
  next(): number; // [0, 1)
  int(maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
}

/** mulberry32 — small, fast, deterministic, good enough for corpus mixing. */
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (maxExclusive) => Math.floor(next() * maxExclusive),
    pick: (items) => items[Math.floor(next() * items.length)],
  };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const utf8 = new TextEncoder();

export const count = {
  u16: (s: string): number => s.length,
  cp: (s: string): number => Array.from(s).length,
  graphemes: (s: string): number => {
    let n = 0;
    for (const _ of segmenter.segment(s)) n += 1;
    return n;
  },
  bytes: (s: string): number => utf8.encode(s).byteLength,
};

export function codePointsOf(s: string): string[] {
  return Array.from(s).map(
    (c) => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0"),
  );
}

// ─── Named single-grapheme clusters (each entry is exactly ONE grapheme) ─────

export interface NamedCluster {
  name: string;
  text: string;
  /** Characters the sanitizer is known to strip live inside this cluster. */
  containsStripped: boolean;
}

export const CLUSTERS: readonly NamedCluster[] = [
  { name: "latin_a", text: "a", containsStripped: false },
  { name: "latin_e_acute_nfc", text: "\u00e9", containsStripped: false },
  { name: "latin_e_acute_nfd", text: "e\u0301", containsStripped: false },
  {
    name: "zalgo_Z_3marks",
    text: "Z\u0336\u0301\u0327",
    containsStripped: false,
  },
  {
    name: "zalgo_a_12marks",
    text: "a\u0300\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309\u030a\u030b",
    containsStripped: false,
  },
  { name: "hangul_han_nfc", text: "\ud55c", containsStripped: false },
  {
    name: "hangul_han_nfd_jamo",
    text: "\u1112\u1161\u11ab",
    containsStripped: false,
  },
  {
    name: "devanagari_ksha_conjunct",
    text: "\u0915\u094d\u0937",
    containsStripped: false,
  },
  {
    name: "devanagari_ksha_with_zwj",
    text: "\u0915\u094d\u200d\u0937",
    containsStripped: true,
  },
  {
    name: "sinhala_shri_with_zwj",
    text: "\u0dc1\u0dca\u200d\u0dbb\u0dd3",
    containsStripped: true,
  },
  {
    name: "thai_ko_kai_sara_am",
    text: "\u0e01\u0e33",
    containsStripped: false,
  },
  { name: "arabic_alef", text: "\u0627", containsStripped: false },
  {
    name: "arabic_lam_shadda_fatha",
    text: "\u0644\u0651\u064e",
    containsStripped: false,
  },
  {
    name: "hebrew_shin_dagesh_shin_dot",
    text: "\u05e9\u05bc\u05c1",
    containsStripped: false,
  },
  { name: "cjk_ideograph", text: "\u6f22", containsStripped: false },
  { name: "cjk_ext_b_astral", text: "\u{20000}", containsStripped: false },
  { name: "emoji_grinning", text: "\u{1f600}", containsStripped: false },
  {
    name: "emoji_thumbs_up_skin_tone",
    text: "\u{1f44d}\u{1f3fd}",
    containsStripped: false,
  },
  { name: "emoji_heart_vs16", text: "\u2764\ufe0f", containsStripped: false },
  { name: "emoji_keycap_1", text: "1\ufe0f\u20e3", containsStripped: false },
  {
    name: "emoji_flag_jp_regional_indicators",
    text: "\u{1f1ef}\u{1f1f5}",
    containsStripped: false,
  },
  {
    name: "emoji_flag_england_tag_sequence",
    text: "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
    containsStripped: false,
  },
  {
    name: "emoji_flag_scotland_tag_sequence",
    text: "\u{1f3f4}\u{e0067}\u{e0062}\u{e0073}\u{e0063}\u{e0074}\u{e007f}",
    containsStripped: false,
  },
  {
    name: "emoji_flag_wales_tag_sequence",
    text: "\u{1f3f4}\u{e0067}\u{e0062}\u{e0077}\u{e006c}\u{e0073}\u{e007f}",
    containsStripped: false,
  },
  {
    name: "emoji_family_zwj_4",
    text: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
    containsStripped: true,
  },
  {
    name: "emoji_kiss_zwj_skin_tones",
    text: "\u{1f469}\u{1f3fd}\u200d\u2764\ufe0f\u200d\u{1f48b}\u200d\u{1f468}\u{1f3ff}",
    containsStripped: true,
  },
  {
    name: "emoji_woman_technologist_zwj",
    text: "\u{1f469}\u200d\u{1f4bb}",
    containsStripped: true,
  },
  {
    name: "emoji_rainbow_flag_zwj",
    text: "\u{1f3f3}\ufe0f\u200d\u{1f308}",
    containsStripped: true,
  },
];

/** Clusters that survive `sanitizeUserText` unchanged (no ZWJ/ZWNJ inside). */
export const SAFE_CLUSTERS: readonly NamedCluster[] = CLUSTERS.filter((c) => !c.containsStripped);

/** Safe clusters that are ONE grapheme but ≥ 12 UTF-16 code units (tag-sequence
 * flags, heavily-marked letters): three of them can exceed a 40-unit check. */
export const WIDE_SAFE_CLUSTERS: readonly NamedCluster[] = SAFE_CLUSTERS.filter(
  (c) => c.text.length >= 12,
);

// ─── Whole strings: real-world names and free text ───────────────────────────

export interface NamedText {
  name: string;
  text: string;
  /** Whether the sanitizer is expected (by its own contract) to leave it unchanged. */
  expectUnchanged: boolean;
  note?: string;
}

export const NAMES: readonly NamedText[] = [
  { name: "ascii", text: "Alice", expectUnchanged: true },
  {
    name: "latin_diacritics_nfc",
    text: "Zo\u00eb Fran\u00e7ois",
    expectUnchanged: true,
  },
  {
    name: "latin_diacritics_nfd",
    text: "Zoe\u0308 Franc\u0327ois",
    expectUnchanged: true,
  },
  {
    name: "vietnamese",
    text: "Nguy\u1ec5n Th\u1ecb H\u1ecdng",
    expectUnchanged: true,
  },
  {
    name: "turkish_dotless_i",
    text: "I\u0307smail Yıldırım",
    expectUnchanged: true,
  },
  { name: "polish", text: "Grażyna Łukaszewicz", expectUnchanged: true },
  { name: "greek", text: "Ἀλέξανδρος", expectUnchanged: true },
  { name: "cyrillic", text: "Ярослав", expectUnchanged: true },
  { name: "hebrew_rtl", text: "יהונתן", expectUnchanged: true },
  {
    name: "hebrew_with_points",
    text: "\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd",
    expectUnchanged: true,
  },
  { name: "arabic_rtl", text: "محمد", expectUnchanged: true },
  { name: "arabic_with_harakat", text: "مُحَمَّد", expectUnchanged: true },
  {
    name: "persian_alireza_with_zwnj",
    text: "علی\u200cرضا",
    expectUnchanged: true,
    note: "U+200C ZWNJ is orthographic in Persian; removing it changes the rendered word.",
  },
  { name: "urdu", text: "فاطمہ", expectUnchanged: true },
  {
    name: "mixed_rtl_ltr_name",
    text: "David \u05d3\u05d5\u05d3",
    expectUnchanged: true,
  },
  {
    name: "arabic_letter_mark_prefix",
    text: "\u061cعلي",
    expectUnchanged: true,
    note: "U+061C ALM is a bidi format char not in the strip set",
  },
  { name: "devanagari", text: "अक्षय", expectUnchanged: true },
  {
    name: "devanagari_explicit_zwj_conjunct",
    text: "क्\u200dष",
    expectUnchanged: true,
    note: "ZWJ requests the half-form; stripping changes the glyph",
  },
  { name: "sinhala_shri_lanka_zwj", text: "ශ්\u200dරී", expectUnchanged: true },
  { name: "bengali", text: "সৌরভ", expectUnchanged: true },
  { name: "tamil", text: "விஜய்", expectUnchanged: true },
  { name: "thai", text: "สมชาย", expectUnchanged: true },
  { name: "korean_nfc", text: "김민준", expectUnchanged: true },
  {
    name: "korean_nfd_jamo",
    text: "\u1100\u1175\u1106\u1102\u1175\u11ab\u110c\u116e\u11ab",
    expectUnchanged: true,
  },
  { name: "japanese_kanji_kana", text: "山田 たろう", expectUnchanged: true },
  {
    name: "japanese_ideographic_space",
    text: "山田\u3000たろう",
    expectUnchanged: false,
    note: "U+3000 is \\s → collapsed to ASCII space",
  },
  { name: "chinese", text: "王小明", expectUnchanged: true },
  { name: "cjk_ext_b", text: "\u{20000}\u{20001}", expectUnchanged: true },
  {
    name: "emoji_only_3",
    text: "\u{1f600}\u{1f3d3}\u{1f3d3}",
    expectUnchanged: true,
  },
  {
    name: "emoji_family_zwj",
    text: "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}",
    expectUnchanged: true,
  },
  {
    name: "emoji_flags_3_england",
    text: "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}".repeat(3),
    expectUnchanged: true,
  },
  {
    name: "emoji_kiss_x3",
    text: "\u{1f469}\u{1f3fd}\u200d\u2764\ufe0f\u200d\u{1f48b}\u200d\u{1f468}\u{1f3ff}".repeat(3),
    expectUnchanged: true,
  },
  { name: "apostrophe_hyphen", text: "O'Neil-Smith", expectUnchanged: true },
  {
    name: "typographic_apostrophe",
    text: "D\u2019Angelo",
    expectUnchanged: true,
  },
  {
    name: "nbsp_inside",
    text: "Ana\u00a0Maria",
    expectUnchanged: false,
    note: "NBSP is \\s → ASCII space",
  },
  {
    name: "bidi_override_attack",
    text: "\u202eecilA",
    expectUnchanged: false,
    note: "RLO must be stripped",
  },
  {
    name: "zero_width_space_inside",
    text: "Al\u200bice",
    expectUnchanged: false,
  },
  { name: "bom_prefix", text: "\ufeffAlice", expectUnchanged: false },
  { name: "nul_inside", text: "Al\u0000ice", expectUnchanged: false },
  { name: "c1_controls", text: "Al\u0085\u009fice", expectUnchanged: false },
  { name: "lone_high_surrogate", text: "Al\ud83dice", expectUnchanged: false },
  { name: "lone_low_surrogate", text: "Al\ude00ice", expectUnchanged: false },
  { name: "crlf_tabs", text: "Al\r\n\tice", expectUnchanged: false },
  {
    name: "invisible_word_joiner_only",
    text: "\u2060",
    expectUnchanged: true,
    note: "U+2060 WJ is not in the strip set",
  },
  {
    name: "invisible_hangul_filler_only",
    text: "\u3164",
    expectUnchanged: true,
    note: "U+3164 renders blank; not in strip set",
  },
  { name: "invisible_soft_hyphen_only", text: "\u00ad", expectUnchanged: true },
  { name: "invisible_cgj_only", text: "\u034f", expectUnchanged: true },
  {
    name: "invisible_mongolian_vowel_sep_only",
    text: "\u180e",
    expectUnchanged: true,
  },
  {
    name: "invisible_tag_chars_only",
    text: "\u{e0041}\u{e0042}",
    expectUnchanged: true,
  },
  { name: "nbsp_only", text: "\u00a0\u00a0", expectUnchanged: false },
];

export const FREE_TEXT: readonly NamedText[] = [
  {
    name: "ascii_paragraph",
    text: "My dinks keep popping up. I think I swing too much from the elbow.",
    expectUnchanged: true,
  },
  {
    name: "arabic_paragraph_rtl",
    text: "أحتاج إلى تحسين ضربة الدينك الخاصة بي عند الشبكة",
    expectUnchanged: true,
  },
  {
    name: "hebrew_paragraph_rtl",
    text: "אני רוצה לשפר את הדינק שלי ליד הרשת",
    expectUnchanged: true,
  },
  {
    name: "mixed_bidi_with_numbers",
    text: "הדינק שלי 3rd shot drop לא עקבי 100%",
    expectUnchanged: true,
  },
  {
    name: "japanese_paragraph",
    text: "ディンクが浮いてしまいます。手首を使いすぎているかもしれません。",
    expectUnchanged: true,
  },
  {
    name: "emoji_heavy_no_zwj",
    text: "dink \u{1f3d3}\u{1f525}\u{1f4aa}\u{1f3fd} \u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
    expectUnchanged: true,
  },
  {
    name: "emoji_family_zwj_in_text",
    text: "dink \u{1f3d3} \u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
    expectUnchanged: false,
    note: "REPRO: ZWJ stripped → family emoji rendered as three separate people",
  },
  {
    name: "combining_heavy_zalgo",
    text: "d\u0336\u0301i\u0336\u0301n\u0336\u0301k\u0336\u0301",
    expectUnchanged: true,
  },
  {
    name: "multiline_feedback",
    text: "Line one\nLine two\n\nLine four",
    expectUnchanged: false,
    note: "newlines collapse to single space by contract",
  },
];

// ─── Alphabets for random generation ────────────────────────────────────────

export type AlphabetName =
  | "ascii"
  | "latin_marks"
  | "rtl"
  | "indic"
  | "cjk"
  | "hangul_jamo"
  | "emoji"
  | "emoji_zwj_parts"
  | "invisibles"
  | "controls_bidi"
  | "whitespace"
  | "surrogates_raw";

const range = (from: number, to: number): string[] => {
  const out: string[] = [];
  for (let c = from; c <= to; c += 1) out.push(String.fromCodePoint(c));
  return out;
};

export const ALPHABETS: Record<AlphabetName, readonly string[]> = {
  ascii: [...range(0x41, 0x5a), ...range(0x61, 0x7a), "'", "-", " "],
  latin_marks: [...range(0x61, 0x7a), ...range(0x0300, 0x036f), "\u00e9", "\u00f1", "\u1ec5"],
  rtl: [
    ...range(0x0627, 0x064a),
    ...range(0x064b, 0x0652),
    ...range(0x05d0, 0x05ea),
    "\u05bc",
    "\u05b8",
    " ",
  ],
  indic: [
    ...range(0x0915, 0x0939),
    "\u094d",
    "\u093e",
    "\u093f",
    "\u0940",
    ...range(0x0e01, 0x0e2e),
    "\u0e33",
    "\u0e48",
  ],
  cjk: [
    ...range(0x4e00, 0x4e40),
    ...range(0x3041, 0x3060),
    ...range(0xac00, 0xac30),
    "\u{20000}",
    "\u{2a6d6}",
  ],
  hangul_jamo: [...range(0x1100, 0x1112), ...range(0x1161, 0x1175), ...range(0x11a8, 0x11c2)],
  emoji: [
    "\u{1f600}",
    "\u{1f3d3}",
    "\u{1f44d}",
    "\u{1f469}",
    "\u{1f468}",
    "\u{1f3fb}",
    "\u{1f3fd}",
    "\u{1f3ff}",
    "\ufe0f",
    "\u2764",
    "\u{1f1ef}",
    "\u{1f1f5}",
    "\u{1f3f4}",
    "\u{e0067}",
    "\u{e007f}",
    "\u20e3",
  ],
  emoji_zwj_parts: [
    "\u{1f469}",
    "\u{1f468}",
    "\u{1f467}",
    "\u{1f466}",
    "\u200d",
    "\u2764",
    "\ufe0f",
    "\u{1f48b}",
    "\u{1f4bb}",
    "\u{1f3fd}",
  ],
  invisibles: [
    "\u2060",
    "\u2061",
    "\u2062",
    "\u2063",
    "\u2064",
    "\u3164",
    "\u00ad",
    "\u034f",
    "\u180e",
    "\u115f",
    "\u1160",
    "\uffa0",
    "\u061c",
    "\u{e0041}",
    "\ufff9",
    "\ufffa",
    "\ufffb",
  ],
  controls_bidi: [
    ...range(0x00, 0x08),
    ...range(0x0e, 0x1f),
    "\u007f",
    ...range(0x80, 0x9f),
    ...range(0x200b, 0x200f),
    ...range(0x202a, 0x202e),
    ...range(0x2066, 0x2069),
    "\ufeff",
  ],
  whitespace: [
    " ",
    "\t",
    "\n",
    "\r",
    "\u000b",
    "\u000c",
    "\u00a0",
    "\u1680",
    "\u2000",
    "\u2003",
    "\u2028",
    "\u2029",
    "\u202f",
    "\u205f",
    "\u3000",
  ],
  surrogates_raw: ["\ud800", "\ud83d", "\udbff", "\udc00", "\ude00", "\udfff"],
};

export const ALPHABET_NAMES = Object.keys(ALPHABETS) as AlphabetName[];

/** A random string mixing 1–3 alphabets; length is in *picks*, not code points. */
export function randomMixedString(
  rng: Rng,
  picks: number,
  alphabets: readonly AlphabetName[] = ALPHABET_NAMES,
): { text: string; alphabets: AlphabetName[] } {
  const chosen = new Set<AlphabetName>();
  const n = 1 + rng.int(3);
  for (let i = 0; i < n; i += 1) chosen.add(rng.pick(alphabets));
  const pools = [...chosen].map((a) => ALPHABETS[a]);
  let text = "";
  for (let i = 0; i < picks; i += 1) text += rng.pick(rng.pick(pools));
  return { text, alphabets: [...chosen] };
}

/** A string made of exactly `n` grapheme clusters drawn from `pool`. */
export function randomGraphemeName(
  rng: Rng,
  n: number,
  pool: readonly NamedCluster[] = CLUSTERS,
): { text: string; clusters: string[] } {
  const clusters: string[] = [];
  let text = "";
  for (let i = 0; i < n; i += 1) {
    const c = rng.pick(pool);
    clusters.push(c.name);
    text += c.text;
  }
  return { text, clusters };
}

/** Repeat `unit` until the UTF-8 encoding is at least `bytes` long, then cut
 * to *exactly* `bytes` code-point-safely (may be a few bytes under). */
export function stringOfBytes(unit: string, bytes: number): string {
  const unitBytes = count.bytes(unit);
  const reps = Math.ceil(bytes / unitBytes);
  let s = unit.repeat(reps);
  while (count.bytes(s) > bytes) s = Array.from(s).slice(0, -1).join("");
  return s;
}

export const KB64 = 64 * 1024;

export function measureHeap(): {
  heapUsed: number;
  rss: number;
  external: number;
} {
  const m = Deno.memoryUsage();
  return { heapUsed: m.heapUsed, rss: m.rss, external: m.external };
}

export function artifactDir(): string | null {
  const dir = Deno.env.get("XC_I18N_OUT");
  if (!dir) return null;
  Deno.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, data: unknown): string | null {
  const dir = artifactDir();
  if (!dir) return null;
  const path = `${dir}/${name}`;
  Deno.writeTextFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

export function seedFromEnv(defaultSeed: number): number {
  const raw = Deno.env.get("XC_I18N_SEED");
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) ? n >>> 0 : defaultSeed;
}

export function itersFromEnv(defaultIters: number): number {
  const raw = Deno.env.get("XC_I18N_ITERS");
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultIters;
}
