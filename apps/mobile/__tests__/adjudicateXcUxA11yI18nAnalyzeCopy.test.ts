/**
 * XC-UAI-09 — the Analyze landing's privacy note must agree with the App
 * Store dossier (docs/APP_STORE_SUBMISSION.md) and the Settings privacy
 * card: clips are processed and kept on the device and never uploaded, and
 * no cloud video feature exists. App Review compares in-app privacy
 * statements with the privacy label, so a promise about an "opt-in cloud
 * video sync" that the product does not have is a release-relevant defect.
 */

// The mobile tsconfig has no Node types (matches importedRealFootageAnalysis);
// the shims must stay module-local, so this file is explicitly a module.
export {};
declare const require: (id: string) => unknown;
declare const __dirname: string;
type Fs = { readFileSync: (path: string, encoding: 'utf8') => string };
const { readFileSync } = require('fs') as Fs;
const { join } = require('path') as { join: (...parts: string[]) => string };

const MOBILE_ROOT = join(__dirname, '..');
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');

const analyzeSource = readFileSync(
  join(MOBILE_ROOT, 'src', 'screens', 'AnalyzeScreen.tsx'),
  'utf8',
);
const dossier = readFileSync(
  join(REPO_ROOT, 'docs', 'APP_STORE_SUBMISSION.md'),
  'utf8',
);

/** The JSX text of the shield-icon privacy note on the camera landing. */
function privacyNote(): string {
  const shieldIndex = analyzeSource.indexOf('<Icon name="shield"');
  expect(shieldIndex).toBeGreaterThan(-1);
  const noteStart = analyzeSource.indexOf('<Text', shieldIndex);
  const noteEnd = analyzeSource.indexOf('</Text>', noteStart);
  expect(noteStart).toBeGreaterThan(shieldIndex);
  expect(noteEnd).toBeGreaterThan(noteStart);
  return analyzeSource
    .slice(noteStart, noteEnd)
    .replace(/^<Text[^>]*>/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('XC-UAI-09 — Analyze privacy copy matches the dossier', () => {
  it('the dossier still states clips stay on the phone with no cloud video feature', () => {
    expect(dossier).toMatch(/never uploaded/);
    expect(dossier).toMatch(/there is no cloud video feature/);
  });

  it('never promises a cloud video option anywhere on the Analyze screen', () => {
    expect(analyzeSource).not.toMatch(/cloud video/i);
    expect(analyzeSource).not.toMatch(/cloud sync/i);
  });

  it('the privacy note says clips stay on this device and are never uploaded', () => {
    const note = privacyNote();
    expect(note).toMatch(/stay on this device/);
    expect(note).toMatch(/never uploaded/);
    expect(note).not.toMatch(/unless/i);
    expect(note).not.toMatch(/enable/i);
  });
});
