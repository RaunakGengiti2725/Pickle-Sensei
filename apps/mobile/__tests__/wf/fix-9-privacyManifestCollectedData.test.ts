/**
 * PrivacyInfo.xcprivacy must disclose every data category the shipping
 * backend collects (supabase/functions/api/legal.ts §1) whenever the build
 * points at a live API origin. Xcode's generated privacy report — the source
 * for the App Store nutrition labels — reads exactly this manifest, so an
 * empty NSPrivacyCollectedDataTypes with apiBaseUrl set understates
 * collection (release manifest step `privacy_disclosure_sync`).
 */
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// Node built-ins for reading the checked-in manifest. The mobile tsconfig
// deliberately excludes node typings, so the shims stay local.
declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const MANIFEST_PATH = join(
  __dirname,
  '..',
  '..',
  'ios',
  'PickleSensei',
  'PrivacyInfo.xcprivacy',
);

interface CollectedDataType {
  type: string;
  linked: boolean;
  tracking: boolean;
  purposes: string[];
}

function sliceArray(xml: string, key: string): string {
  const keyIndex = xml.indexOf(`<key>${key}</key>`);
  if (keyIndex < 0) throw new Error(`missing <key>${key}</key>`);
  const rest = xml.slice(keyIndex + `<key>${key}</key>`.length).trimStart();
  if (rest.startsWith('<array/>')) return '';
  if (!rest.startsWith('<array>')) throw new Error(`${key} is not an array`);
  let depth = 0;
  let cursor = 0;
  const tagPattern = /<(\/?)array>/g;
  let match: RegExpExecArray | null;
  while ((match = tagPattern.exec(rest)) !== null) {
    depth += match[1] === '/' ? -1 : 1;
    if (depth === 0) {
      cursor = match.index;
      break;
    }
  }
  if (depth !== 0) throw new Error(`${key} array never closes`);
  return rest.slice('<array>'.length, cursor);
}

function readString(dict: string, key: string): string {
  const match = new RegExp(
    `<key>${key}</key>\\s*<string>([^<]*)</string>`,
  ).exec(dict);
  if (!match || match[1] === undefined) {
    throw new Error(`missing string ${key}`);
  }
  return match[1];
}

function readBool(dict: string, key: string): boolean {
  const match = new RegExp(`<key>${key}</key>\\s*<(true|false)/>`).exec(dict);
  if (!match) throw new Error(`missing boolean ${key}`);
  return match[1] === 'true';
}

function parseCollectedDataTypes(xml: string): CollectedDataType[] {
  const body = sliceArray(xml, 'NSPrivacyCollectedDataTypes');
  const dicts = body.match(/<dict>[\s\S]*?<\/dict>/g) ?? [];
  return dicts.map(dict => ({
    type: readString(dict, 'NSPrivacyCollectedDataType'),
    linked: readBool(dict, 'NSPrivacyCollectedDataTypeLinked'),
    tracking: readBool(dict, 'NSPrivacyCollectedDataTypeTracking'),
    purposes: Array.from(
      sliceArray(dict, 'NSPrivacyCollectedDataTypePurposes').matchAll(
        /<string>([^<]*)<\/string>/g,
      ),
      m => m[1] ?? '',
    ),
  }));
}

/** legal.ts §1 → Apple privacy-manifest data categories. */
const DISCLOSED_BY_PRIVACY_POLICY = [
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeFitness',
  'NSPrivacyCollectedDataTypeOtherDataTypes',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeOtherUsageData',
];

const KNOWN_PURPOSES = new Set([
  'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  'NSPrivacyCollectedDataTypePurposeAnalytics',
  'NSPrivacyCollectedDataTypePurposeProductPersonalization',
  'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
  'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
  'NSPrivacyCollectedDataTypePurposeOther',
]);

describe('PrivacyInfo.xcprivacy collected-data disclosure (fix-9)', () => {
  const xml = readFileSync(MANIFEST_PATH, 'utf8');
  const collected = parseCollectedDataTypes(xml);

  it('declares every category the privacy policy says the backend collects when a live API origin ships', () => {
    const { apiBaseUrl } = getRuntimePublicConfig();
    expect(apiBaseUrl).not.toBeNull();
    const declared = collected.map(entry => entry.type);
    for (const type of DISCLOSED_BY_PRIVACY_POLICY) {
      expect(declared).toContain(type);
    }
    expect(new Set(declared).size).toBe(declared.length);
  });

  it('every entry is linked to the account, never used for tracking, and carries a known purpose', () => {
    expect(collected.length).toBeGreaterThan(0);
    for (const entry of collected) {
      expect(entry.linked).toBe(true);
      expect(entry.tracking).toBe(false);
      expect(entry.purposes.length).toBeGreaterThan(0);
      for (const purpose of entry.purposes) {
        expect(KNOWN_PURPOSES.has(purpose)).toBe(true);
      }
    }
  });

  it('matches the App Store Connect purpose matrix exactly', () => {
    const purposesByType = Object.fromEntries(
      collected.map(entry => [entry.type, new Set(entry.purposes)]),
    );
    const appFunctionality =
      'NSPrivacyCollectedDataTypePurposeAppFunctionality';
    const analytics = 'NSPrivacyCollectedDataTypePurposeAnalytics';
    const personalization =
      'NSPrivacyCollectedDataTypePurposeProductPersonalization';
    expect(purposesByType).toEqual({
      NSPrivacyCollectedDataTypeEmailAddress: new Set([appFunctionality]),
      NSPrivacyCollectedDataTypeName: new Set([
        appFunctionality,
        personalization,
      ]),
      NSPrivacyCollectedDataTypeUserID: new Set([appFunctionality, analytics]),
      NSPrivacyCollectedDataTypeFitness: new Set([
        appFunctionality,
        personalization,
        analytics,
      ]),
      NSPrivacyCollectedDataTypeOtherDataTypes: new Set([
        appFunctionality,
        personalization,
      ]),
      NSPrivacyCollectedDataTypePurchaseHistory: new Set([
        appFunctionality,
        analytics,
      ]),
      NSPrivacyCollectedDataTypeOtherUsageData: new Set([
        analytics,
        appFunctionality,
      ]),
    });
  });

  it('claims no advertising purpose and keeps NSPrivacyTracking false (policy §2: no ad profiles, no data sale)', () => {
    for (const entry of collected) {
      expect(entry.purposes).not.toContain(
        'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
      );
      expect(entry.purposes).not.toContain(
        'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
      );
    }
    expect(readBool(xml, 'NSPrivacyTracking')).toBe(false);
  });

  it('keeps the accessed-API declarations the distribution check already asserts', () => {
    expect(sliceArray(xml, 'NSPrivacyAccessedAPITypes')).toContain(
      'NSPrivacyAccessedAPICategoryUserDefaults',
    );
  });
});
