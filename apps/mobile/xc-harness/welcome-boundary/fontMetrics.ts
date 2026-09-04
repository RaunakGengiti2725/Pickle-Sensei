/**
 * Advance widths straight from the font files the app ships
 * (assets/fonts/Manrope_*.ttf), so text-width modelling uses the real
 * per-glyph metrics instead of an average-em heuristic. Parses only the
 * TrueType tables needed for that: `head` (unitsPerEm), `hhea`
 * (numberOfHMetrics), `hmtx` (advances) and `cmap` (formats 4 and 12).
 * Kerning (`GPOS`/`kern`) is ignored — Manrope's pair adjustments are a few
 * font units either way, well inside the slack the audits require.
 *
 * Code points the font lacks (CJK, Arabic, Thai, Devanagari, emoji) fall back
 * to the system font on iOS; those are estimated with a per-script average
 * (1.0em for CJK / emoji-class, 0.55em otherwise).
 */
import { fs, path, resolveModule } from '../lifecycle-persistence/nodeShim';

/** The slice of Node's Buffer the parser uses (no @types/node here). */
interface NodeBuffer {
  readonly length: number;
  readUInt16BE(offset: number): number;
  readInt16BE(offset: number): number;
  readUInt32BE(offset: number): number;
  toString(encoding: 'latin1', start: number, end: number): string;
}

interface ParsedFont {
  unitsPerEm: number;
  advances: Uint16Array;
  cmap: Map<number, number>;
}

const FONT_FILES: Record<string, string> = {
  Manrope_400Regular: 'Manrope_400Regular.ttf',
  Manrope_500Medium: 'Manrope_500Medium.ttf',
  Manrope_600SemiBold: 'Manrope_600SemiBold.ttf',
  Manrope_700Bold: 'Manrope_700Bold.ttf',
};

const fontsDir = path.resolve(
  path.join(resolveModule('../../package.json'), '..', 'assets', 'fonts'),
);

const cache = new Map<string, ParsedFont | null>();

function readBinary(file: string): NodeBuffer {
  // readFileSync without an encoding returns a Buffer; the shim only types
  // the utf8 overload, so widen through unknown.
  const read = (fs as unknown as { readFileSync(file: string): NodeBuffer })
    .readFileSync;
  return read(file);
}

function parseCmap(buf: NodeBuffer, offset: number): Map<number, number> {
  const map = new Map<number, number>();
  const tableCount = buf.readUInt16BE(offset + 2);
  let best: { offset: number; format: number } | null = null;
  for (let i = 0; i < tableCount; i += 1) {
    const rec = offset + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const sub = offset + buf.readUInt32BE(rec + 4);
    const format = buf.readUInt16BE(sub);
    const unicode =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode) continue;
    if (format === 12) best = { offset: sub, format };
    else if (format === 4 && (best === null || best.format !== 12)) {
      best = { offset: sub, format };
    }
  }
  if (best === null) return map;
  if (best.format === 12) {
    const groups = buf.readUInt32BE(best.offset + 12);
    for (let g = 0; g < groups; g += 1) {
      const rec = best.offset + 16 + g * 12;
      const start = buf.readUInt32BE(rec);
      const end = buf.readUInt32BE(rec + 4);
      const startGlyph = buf.readUInt32BE(rec + 8);
      for (let cp = start; cp <= end; cp += 1) {
        map.set(cp, startGlyph + (cp - start));
      }
    }
    return map;
  }
  const segX2 = buf.readUInt16BE(best.offset + 6);
  const segCount = segX2 / 2;
  const endBase = best.offset + 14;
  const startBase = endBase + segX2 + 2;
  const deltaBase = startBase + segX2;
  const rangeBase = deltaBase + segX2;
  for (let s = 0; s < segCount; s += 1) {
    const end = buf.readUInt16BE(endBase + s * 2);
    const start = buf.readUInt16BE(startBase + s * 2);
    const delta = buf.readInt16BE(deltaBase + s * 2);
    const rangeOffset = buf.readUInt16BE(rangeBase + s * 2);
    if (start === 0xffff) continue;
    for (let cp = start; cp <= end; cp += 1) {
      let glyph: number;
      if (rangeOffset === 0) {
        glyph = (cp + delta) & 0xffff;
      } else {
        const addr = rangeBase + s * 2 + rangeOffset + (cp - start) * 2;
        const raw = buf.readUInt16BE(addr);
        glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
      }
      if (glyph !== 0) map.set(cp, glyph);
    }
  }
  return map;
}

function parseFont(file: string): ParsedFont {
  const buf = readBinary(file);
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), {
      offset: buf.readUInt32BE(rec + 8),
      length: buf.readUInt32BE(rec + 12),
    });
  }
  const head = tables.get('head');
  const hhea = tables.get('hhea');
  const hmtx = tables.get('hmtx');
  const cmap = tables.get('cmap');
  if (!head || !hhea || !hmtx || !cmap) {
    throw new Error(`${file}: missing head/hhea/hmtx/cmap`);
  }
  const unitsPerEm = buf.readUInt16BE(head.offset + 18);
  const numberOfHMetrics = buf.readUInt16BE(hhea.offset + 34);
  const advances = new Uint16Array(numberOfHMetrics);
  for (let g = 0; g < numberOfHMetrics; g += 1) {
    advances[g] = buf.readUInt16BE(hmtx.offset + g * 4);
  }
  return { unitsPerEm, advances, cmap: parseCmap(buf, cmap.offset) };
}

function fontFor(family: string | undefined): ParsedFont | null {
  const file = family ? FONT_FILES[family] : undefined;
  if (!file) return null;
  const cached = cache.get(file);
  if (cached !== undefined) return cached;
  let parsed: ParsedFont | null;
  try {
    parsed = parseFont(path.join(fontsDir, file));
  } catch {
    parsed = null;
  }
  cache.set(file, parsed);
  return parsed;
}

const CJK_OR_EMOJI_RE =
  /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|\p{Extended_Pictographic}/u;
const ZERO_WIDTH_RE =
  /[\p{Mn}\p{Me}\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/u;

export interface MeasureOptions {
  fontFamily?: string;
  fontSize: number;
  letterSpacing?: number;
}

export interface Measurement {
  widthPt: number;
  /** Code points the shipped font has no glyph for (system-font fallback). */
  fallbackGlyphs: number;
  measured: boolean;
}

/** Advance width of `text` (one line, no wrapping) in points. */
export function measureText(text: string, opts: MeasureOptions): Measurement {
  const font = fontFor(opts.fontFamily);
  const letter = opts.letterSpacing ?? 0;
  let width = 0;
  let fallback = 0;
  let glyphs = 0;
  for (const ch of Array.from(text)) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ZERO_WIDTH_RE.test(ch)) continue;
    glyphs += 1;
    const glyph = font?.cmap.get(cp);
    if (font && glyph !== undefined) {
      const idx = Math.min(glyph, font.advances.length - 1);
      width += ((font.advances[idx] ?? 0) / font.unitsPerEm) * opts.fontSize;
    } else {
      fallback += 1;
      width +=
        (CJK_OR_EMOJI_RE.test(ch) ? 1.0 : ch === ' ' ? 0.28 : 0.55) *
        opts.fontSize;
    }
  }
  width += Math.max(0, glyphs - 1) * letter;
  return { widthPt: width, fallbackGlyphs: fallback, measured: font !== null };
}

/**
 * Greedy word wrap the way UIKit breaks a paragraph: words that fit stay on
 * the line, a single word wider than the line is broken by glyph. Returns
 * the number of lines each `\n`-separated paragraph needs, summed.
 */
export function wrapLines(
  text: string,
  availableWidth: number,
  opts: MeasureOptions,
): number {
  const avail = Math.max(1, availableWidth);
  let total = 0;
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(' ');
    let lines = 1;
    let lineWidth = 0;
    const space = measureText(' ', opts).widthPt;
    for (const word of words) {
      const w = measureText(word, opts).widthPt;
      if (w > avail) {
        // Break the oversized word glyph by glyph.
        if (lineWidth > 0) {
          lines += 1;
          lineWidth = 0;
        }
        const glyphs = Array.from(word);
        for (const g of glyphs) {
          const gw = measureText(g, opts).widthPt;
          if (lineWidth > 0 && lineWidth + gw > avail) {
            lines += 1;
            lineWidth = 0;
          }
          lineWidth += gw;
        }
        continue;
      }
      const needed = lineWidth === 0 ? w : lineWidth + space + w;
      if (needed > avail) {
        lines += 1;
        lineWidth = w;
      } else {
        lineWidth = needed;
      }
    }
    total += lines;
  }
  return total;
}

/** True when the shipped font file for `family` was found and parsed. */
export function fontAvailable(family: string): boolean {
  return fontFor(family) !== null;
}
