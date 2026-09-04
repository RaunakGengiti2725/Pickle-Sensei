/**
 * Adjudication pins — area `mobile-ios-config`, confirmed finding
 * IOSCFG-2: the `font` design tokens name fonts by their bundled *file stem*
 * (`Manrope_400Regular`, …) while iOS resolves `fontFamily` against the
 * OpenType name table (family "Manrope", PostScript "Manrope-Regular", …).
 * None of the four tokens matches any family / full / PostScript name of the
 * TTFs registered under UIAppFonts, so every Text falls back to the system
 * font on device.
 *
 * Fails at 4d812e1a by design; static and Linux-runnable (parses the TTF
 * `name` tables directly — no fonttools dependency).
 */

import { font } from '../../src/design/tokens';

declare const require: (id: string) => unknown;
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync: {
    (p: string): Uint8Array;
    (p: string, encoding: 'utf8'): string;
  };
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const MOBILE_ROOT = path.resolve(__dirname, '..', '..');
const INFO_PLIST = path.join(MOBILE_ROOT, 'ios', 'PickleSensei', 'Info.plist');
const FONT_DIR = path.join(MOBILE_ROOT, 'assets', 'fonts');

const NAME_ID = { family: 1, full: 4, postscript: 6, typoFamily: 16 } as const;

interface OpenTypeNames {
  file: string;
  names: Set<string>;
}

function decodeName(
  bytes: Uint8Array,
  platformId: number,
  encodingId: number,
): string {
  const utf16 = platformId === 0 || platformId === 3;
  if (utf16) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
      out += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!);
    }
    return out;
  }
  if (platformId === 1 && encodingId === 0) {
    let out = '';
    for (const b of bytes) out += String.fromCharCode(b);
    return out;
  }
  return '';
}

/** Family / full / PostScript / typographic-family names from a TTF `name` table. */
function openTypeNames(file: string): OpenTypeNames {
  const buf = fs.readFileSync(file);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numTables = view.getUint16(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + i * 16;
    const tag = String.fromCharCode(
      buf[rec]!,
      buf[rec + 1]!,
      buf[rec + 2]!,
      buf[rec + 3]!,
    );
    if (tag === 'name') nameOffset = view.getUint32(rec + 8);
  }
  if (nameOffset < 0) throw new Error(`${file}: no OpenType name table`);
  const count = view.getUint16(nameOffset + 2);
  const stringOffset = nameOffset + view.getUint16(nameOffset + 4);
  const wanted = new Set<number>(Object.values(NAME_ID));
  const names = new Set<string>();
  for (let i = 0; i < count; i += 1) {
    const rec = nameOffset + 6 + i * 12;
    const platformId = view.getUint16(rec);
    const encodingId = view.getUint16(rec + 2);
    const nameId = view.getUint16(rec + 6);
    if (!wanted.has(nameId)) continue;
    const length = view.getUint16(rec + 8);
    const offset = view.getUint16(rec + 10);
    const start = stringOffset + offset;
    const text = decodeName(
      buf.subarray(start, start + length),
      platformId,
      encodingId,
    );
    if (text !== '') names.add(text);
  }
  return { file, names };
}

const uiAppFonts = Array.from(
  (
    /<key>UIAppFonts<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(
      fs.readFileSync(INFO_PLIST, 'utf8'),
    )?.[1] ?? ''
  ).matchAll(/<string>([^<]+)<\/string>/g),
  m => m[1]!,
);

const bundled = uiAppFonts.map(f => openTypeNames(path.join(FONT_DIR, f)));
const resolvable = new Set(bundled.flatMap(b => Array.from(b.names)));

describe('IOSCFG-2: design font tokens resolve against the bundled Manrope faces', () => {
  it('registers four Manrope faces under UIAppFonts', () => {
    expect(uiAppFonts).toHaveLength(4);
    expect(bundled.every(b => b.names.size > 0)).toBe(true);
  });

  it.each(Object.entries(font))(
    'font.%s = %p is a family, full or PostScript name of a bundled face',
    (_token, family) => {
      // iOS: [UIFont fontNamesForFamilyName:] / [UIFont fontWithName:] only
      // know these names; a file stem such as "Manrope_400Regular" resolves
      // to nil and React Native silently substitutes the system font.
      expect(Array.from(resolvable)).toContain(family);
    },
  );

  it('uses one family name for every weight so fontWeight can select faces', () => {
    // Manrope_500Medium/600SemiBold ship with family "Manrope Medium" /
    // "Manrope SemiBold" (not "Manrope"); the fix must either rename the
    // tokens to the PostScript names or re-export the faces under one family.
    const families = new Set(Object.values(font));
    for (const family of families) {
      expect(bundled.some(b => b.names.has(family))).toBe(true);
    }
  });
});
