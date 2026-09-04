/**
 * ADVERSARIAL PASS 3 — mobile-ios-config — S2 (screen copy half)
 *
 * The native rejections replayed in s2 must map to DISTINCT, honest user copy
 * in AnalyzeScreen: `camera.import_too_long` → trim guidance, the empty-media
 * rejection → its own message, and corrupt / code-less / unicode-only inputs
 * → the generic fallback, never an invented cause or a leaked contract code.
 *
 * Read-only: no production file is touched.
 */

// AnalyzeScreen is imported ONLY for its pure failure-copy helper; the
// SQLite-backed db module behind it has no native binding under jest.
jest.mock('../../../src/data/db', () => ({ getDb: jest.fn() }));

import { importedPoseExtractionFailureMessage } from '../../../src/screens/AnalyzeScreen';

const GENERIC = 'Reading player movement from this video failed.';

function nativeTooLongRejection(seconds: number): Error & { code: string } {
  return Object.assign(
    new Error(
      `This video is ${Math.round(seconds)} seconds long. Trim it to under 60 seconds and import it again.`,
    ),
    { code: 'camera.import_too_long' },
  );
}

function nativeEmptyMediaRejection(): Error & { code: string } {
  return Object.assign(new Error('The video duration could not be read.'), {
    code: 'camera.invalid_media',
  });
}

describe('S2b — imported-video failure copy (attack)', () => {
  it('61 s → trim guidance; copy is store-safe', () => {
    const message = importedPoseExtractionFailureMessage(
      nativeTooLongRejection(61),
    );
    expect(message).toMatch(/too long/i);
    expect(message).toMatch(/\bTrim\b/);
    expect(message).not.toMatch(
      /camera\.import_too_long|Android|Google Play|DUPR|guest|Live Court|\d+%/i,
    );
  });

  it('0 s → the native empty-media message, distinct from the trim guidance', () => {
    const empty = importedPoseExtractionFailureMessage(
      nativeEmptyMediaRejection(),
    );
    const tooLong = importedPoseExtractionFailureMessage(
      nativeTooLongRejection(61),
    );
    expect(empty).toBe('The video duration could not be read.');
    expect(empty).not.toMatch(/too long|Trim/i);
    expect(empty).not.toBe(tooLong);
  });

  it('JS-side invalid clip error (0 s caught before native) passes through verbatim', () => {
    const jsInvalid = new Error(
      'The native camera returned an invalid or incomplete video result.',
    );
    expect(importedPoseExtractionFailureMessage(jsInvalid)).toBe(
      jsInvalid.message,
    );
  });

  it('code-only / message-less / blank / unicode-blank inputs fall back honestly', () => {
    expect(
      importedPoseExtractionFailureMessage({ code: 'camera.import_too_long' }),
    ).toMatch(/Trim/);
    expect(
      importedPoseExtractionFailureMessage({ code: 'camera.import_no_person' }),
    ).toMatch(/person|player/i);
    expect(importedPoseExtractionFailureMessage(null)).toBe(GENERIC);
    expect(importedPoseExtractionFailureMessage(undefined)).toBe(GENERIC);
    expect(importedPoseExtractionFailureMessage('   ')).toBe(GENERIC);
    expect(importedPoseExtractionFailureMessage(new Error('   '))).toBe(
      GENERIC,
    );
    expect(importedPoseExtractionFailureMessage(new Error(''))).toBe(GENERIC);
    expect(importedPoseExtractionFailureMessage({ code: 42 })).toBe(GENERIC);
    expect(
      importedPoseExtractionFailureMessage({
        code: 'camera.import_too_long\u0000',
      }),
    ).toBe(GENERIC);
    expect(
      importedPoseExtractionFailureMessage({
        code: 'camera.import_too_long',
        message: 12345,
      }),
    ).toMatch(/Trim/);
  });

  it('a huge message is passed through unchanged (no truncation surprise, no crash)', () => {
    const huge = 'x'.repeat(1_000_000);
    expect(importedPoseExtractionFailureMessage(new Error(huge))).toBe(huge);
  });
});
