/**
 * AUDIT PROBE (mobile-ios-config, structural pass 1 / auditor #2).
 *
 * Suspected defect: `src/design/tokens.ts` sets `fontFamily` to the Google
 * Fonts FILE stems ('Manrope_400Regular', ...). iOS resolves `fontFamily`
 * through `UIFont(name:)` / `fontNamesForFamilyName:` which only know a font
 * by its family name (name id 1/16), full name (id 4) or PostScript name
 * (id 6) — never by the .ttf file stem. React Native's
 * `RCTFontUtils.mm` / `RCTFont.mm` then log "Unrecognized font family" and
 * fall back to the system font, so every JS text on iOS renders in SF Pro
 * although the Manrope files are bundled via UIAppFonts. The native Swift
 * overlay (`GuidedCaptureViewController.swift:34`) uses the correct
 * PostScript name `Manrope-<Weight>`, so JS and native disagree.
 *
 * This test reads the real name tables of the bundled .ttf files and checks
 * that every token font name is a name iOS can resolve.
 */
import { font } from '../../../src/design/tokens';

// Node built-ins typed by hand: the RN tsconfig ships no node types (same
// convention as __tests__/wf/be-mobile-security-secrets.test.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
interface NameBuffer {
  readUInt16BE(offset: number): number;
  readUInt32BE(offset: number): number;
  toString(encoding: 'ascii' | 'utf16le', start?: number, end?: number): string;
  subarray(start: number, end: number): NameBuffer;
  swap16(): NameBuffer;
}
const fs = require('fs') as {
  existsSync: (p: string) => boolean;
  readFileSync: ((p: string, encoding: 'utf8') => string) &
    ((p: string) => NameBuffer);
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

const iosDir = path.resolve(__dirname, '../../../ios');
const infoPlist = fs.readFileSync(
  path.join(iosDir, 'PickleSensei/Info.plist'),
  'utf8',
);
const fontsDir = path.resolve(__dirname, '../../../assets/fonts');

type NameTable = {
  family: string[];
  fullName: string[];
  postScript: string[];
};

function readNameTable(file: string): NameTable {
  const buf = fs.readFileSync(file);
  const numTables = buf.readUInt16BE(4);
  const out: NameTable = { family: [], fullName: [], postScript: [] };
  for (let i = 0; i < numTables; i += 1) {
    const rec = 12 + 16 * i;
    const tag = buf.toString('ascii', rec, rec + 4);
    if (tag !== 'name') {
      continue;
    }
    const off = buf.readUInt32BE(rec + 8);
    const count = buf.readUInt16BE(off + 2);
    const strOff = buf.readUInt16BE(off + 4);
    for (let j = 0; j < count; j += 1) {
      const r = off + 6 + 12 * j;
      const platformId = buf.readUInt16BE(r);
      const encodingId = buf.readUInt16BE(r + 2);
      const nameId = buf.readUInt16BE(r + 6);
      const length = buf.readUInt16BE(r + 8);
      const offset = buf.readUInt16BE(r + 10);
      if (platformId !== 3 || encodingId !== 1) {
        continue;
      }
      const start = off + strOff + offset;
      const value = buf
        .subarray(start, start + length)
        .swap16()
        .toString('utf16le');
      if (nameId === 1 || nameId === 16) {
        out.family.push(value);
      } else if (nameId === 4) {
        out.fullName.push(value);
      } else if (nameId === 6) {
        out.postScript.push(value);
      }
    }
  }
  return out;
}

function uiAppFonts(): string[] {
  const m = infoPlist.match(
    /<key>UIAppFonts<\/key>\s*<array>([\s\S]*?)<\/array>/,
  );
  if (!m || !m[1]) {
    return [];
  }
  return [...m[1].matchAll(/<string>([^<]+)<\/string>/g)].map(x => x[1] ?? '');
}

describe('audit probe: token fontFamily values resolve on iOS', () => {
  const bundled = uiAppFonts();
  const resolvable = new Set<string>();
  for (const file of bundled) {
    const table = readNameTable(path.join(fontsDir, file));
    for (const n of [...table.family, ...table.fullName, ...table.postScript]) {
      resolvable.add(n);
    }
  }

  test('precondition: Manrope files are declared in UIAppFonts and exist', () => {
    expect(bundled.length).toBeGreaterThan(0);
    for (const file of bundled) {
      expect(fs.existsSync(path.join(fontsDir, file))).toBe(true);
    }
  });

  test.each(Object.entries(font))(
    'font.%s = %p is a family / full / PostScript name iOS can resolve',
    (_role, familyName) => {
      expect([...resolvable].sort()).toContain(familyName);
    },
  );
});
