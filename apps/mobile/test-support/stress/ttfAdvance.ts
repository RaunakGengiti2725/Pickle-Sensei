/**
 * Minimal TrueType reader: per-code-point horizontal advances from the
 * font files the app ships (`assets/fonts/Manrope_*.ttf`). Reads only the
 * `head`, `hhea`, `hmtx` and `cmap` (formats 4 + 12) tables — enough to
 * measure a single-line string at a given point size without kerning or
 * shaping. Code points the font lacks return `null` so the caller can fall
 * back to a system-font heuristic (iOS substitutes PingFang / Geeza Pro /
 * Thonburi / Apple Color Emoji … for those glyphs).
 *
 * Test-support only. Not a production dependency.
 */

export interface TtfMetrics {
  unitsPerEm: number;
  glyphCount: number;
  /** code point → glyph id (0 = .notdef) */
  glyphFor(codePoint: number): number;
  /** glyph id → advance width in font units */
  advanceOf(glyphId: number): number;
}

function u16(buf: Uint8Array, at: number): number {
  return ((buf[at] ?? 0) << 8) | (buf[at + 1] ?? 0);
}
function u32(buf: Uint8Array, at: number): number {
  return (
    (((buf[at] ?? 0) << 24) |
      ((buf[at + 1] ?? 0) << 16) |
      ((buf[at + 2] ?? 0) << 8) |
      (buf[at + 3] ?? 0)) >>>
    0
  );
}
function tag(buf: Uint8Array, at: number): string {
  return String.fromCharCode(
    buf[at] ?? 0,
    buf[at + 1] ?? 0,
    buf[at + 2] ?? 0,
    buf[at + 3] ?? 0,
  );
}

export function parseTtf(bytes: Uint8Array): TtfMetrics {
  const numTables = u16(bytes, 4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    tables.set(tag(bytes, rec), {
      offset: u32(bytes, rec + 8),
      length: u32(bytes, rec + 12),
    });
  }
  const need = (name: string) => {
    const t = tables.get(name);
    if (!t) throw new Error(`ttf: missing table ${name}`);
    return t;
  };
  const head = need('head');
  const hhea = need('hhea');
  const hmtx = need('hmtx');
  const maxp = need('maxp');
  const cmap = need('cmap');

  const unitsPerEm = u16(bytes, head.offset + 18);
  const numberOfHMetrics = u16(bytes, hhea.offset + 34);
  const glyphCount = u16(bytes, maxp.offset + 4);

  const advances = new Uint16Array(numberOfHMetrics);
  for (let g = 0; g < numberOfHMetrics; g += 1) {
    advances[g] = u16(bytes, hmtx.offset + g * 4);
  }
  const lastAdvance = advances[numberOfHMetrics - 1] ?? 0;

  // Prefer a Unicode full-repertoire subtable (format 12), else BMP (format 4).
  const cmapCount = u16(bytes, cmap.offset + 2);
  let format4: number | null = null;
  let format12: number | null = null;
  for (let i = 0; i < cmapCount; i += 1) {
    const rec = cmap.offset + 4 + i * 8;
    const platform = u16(bytes, rec);
    const encoding = u16(bytes, rec + 2);
    const sub = cmap.offset + u32(bytes, rec + 4);
    const format = u16(bytes, sub);
    const unicodeish =
      platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicodeish) continue;
    if (format === 12) format12 = sub;
    if (format === 4 && format4 === null) format4 = sub;
  }
  if (format4 === null && format12 === null) {
    throw new Error('ttf: no unicode cmap subtable');
  }

  const glyphFrom4 = (sub: number, cp: number): number => {
    if (cp > 0xffff) return 0;
    const segCountX2 = u16(bytes, sub + 6);
    const segCount = segCountX2 / 2;
    const ends = sub + 14;
    const starts = ends + segCountX2 + 2;
    const deltas = starts + segCountX2;
    const rangeOffsets = deltas + segCountX2;
    for (let s = 0; s < segCount; s += 1) {
      const end = u16(bytes, ends + s * 2);
      if (cp > end) continue;
      const start = u16(bytes, starts + s * 2);
      if (cp < start) return 0;
      const delta = u16(bytes, deltas + s * 2);
      const rangeOffset = u16(bytes, rangeOffsets + s * 2);
      if (rangeOffset === 0) return (cp + delta) & 0xffff;
      const glyphAt = rangeOffsets + s * 2 + rangeOffset + (cp - start) * 2;
      const g = u16(bytes, glyphAt);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };
  const glyphFrom12 = (sub: number, cp: number): number => {
    const nGroups = u32(bytes, sub + 12);
    for (let g = 0; g < nGroups; g += 1) {
      const rec = sub + 16 + g * 12;
      const start = u32(bytes, rec);
      const end = u32(bytes, rec + 4);
      if (cp < start) return 0;
      if (cp <= end) return u32(bytes, rec + 8) + (cp - start);
    }
    return 0;
  };

  return {
    unitsPerEm,
    glyphCount,
    glyphFor(cp) {
      if (format12 !== null) {
        const g = glyphFrom12(format12, cp);
        if (g !== 0) return g;
      }
      return format4 !== null ? glyphFrom4(format4, cp) : 0;
    },
    advanceOf(glyphId) {
      if (glyphId >= glyphCount) return 0;
      return glyphId < numberOfHMetrics
        ? (advances[glyphId] ?? 0)
        : lastAdvance;
    },
  };
}
