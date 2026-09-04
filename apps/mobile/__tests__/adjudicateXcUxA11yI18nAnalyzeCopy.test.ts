/**
 * Adjudication reproduction for area xc-ux-a11y-i18n (Analyze privacy copy).
 *
 *  G1 — AnalyzeScreen's privacy note says clips stay on device "unless you
 *       explicitly enable cloud video sync". docs/APP_STORE_SUBMISSION.md
 *       (authoritative) states "there is no cloud video feature" and
 *       SettingsScreen reports "Cloud video upload · Not configured". The
 *       Analyze copy therefore describes an opt-in that does not exist.
 *
 * Run: cd apps/mobile && npx jest --ci __tests__/adjudicateXcUxA11yI18nAnalyzeCopy.test.ts
 */
export {};

declare const require: (id: string) => unknown;
declare const __dirname: string;
const { readFileSync } = require('fs') as {
  readFileSync: (path: string, encoding: 'utf8') => string;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ROOT = join(__dirname, '..', '..', '..');
const ANALYZE = join(ROOT, 'apps/mobile/src/screens/AnalyzeScreen.tsx');
const SETTINGS = join(ROOT, 'apps/mobile/src/screens/SettingsScreen.tsx');
const DOSSIER = join(ROOT, 'docs/APP_STORE_SUBMISSION.md');

describe('G1 — Analyze privacy note promises a cloud video sync opt-in that does not exist', () => {
  const analyze = readFileSync(ANALYZE, 'utf8').replace(/\s+/g, ' ');
  const settings = readFileSync(SETTINGS, 'utf8').replace(/\s+/g, ' ');
  const dossier = readFileSync(DOSSIER, 'utf8').replace(/\s+/g, ' ');

  test('control: the dossier and Settings say there is no cloud video feature', () => {
    expect(dossier).toContain('there is no cloud video feature');
    expect(settings).toContain('Cloud video upload');
    expect(settings).toContain('Not configured');
  });

  test('reproduction: Analyze copy says "unless you explicitly enable cloud video sync"', () => {
    expect(analyze).toContain(
      'stay on this device unless you explicitly enable cloud video sync.',
    );
  });

  test.failing(
    'expected: Analyze copy does not describe a cloud video sync opt-in',
    () => {
      expect(analyze).not.toMatch(/cloud video sync/i);
    },
  );
});
