// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure copy exports under test never touch it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import {
  PENDING_SECTION_LABEL,
  PENDING_SECTION_NOTE,
  PENDING_SECTION_PILL,
  pendingCaptureTitle,
  pendingEvidenceCopy,
} from '../src/screens/LibraryScreen';
import type { PendingCapture } from '../src/data/repository';

/**
 * Library pending-clips copy audit. Historically the section claimed the
 * clips were "AWAITING MODEL" while valid rows said "Validated evidence is
 * unavailable" — a contradiction for clips that are simply not analyzed yet.
 * These tests pin the honest replacements.
 */

function capture(overrides: Partial<PendingCapture>): PendingCapture {
  return {
    id: 'cap-1',
    shotType: 'unrecognized',
    declaredStroke: null,
    uri: 'file:///captures/cap-1.mov',
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    durationMs: 4200,
    fps: 59.94,
    width: 720,
    height: 1280,
    clip: null,
    evidenceStatus: 'valid',
    ...overrides,
  };
}

describe('pending section header', () => {
  it('describes saved clips without implying a model is coming for them', () => {
    expect(PENDING_SECTION_LABEL).toBe('SAVED CLIPS · NOT ANALYZED');
    expect(PENDING_SECTION_LABEL).not.toMatch(/awaiting/i);
    expect(PENDING_SECTION_PILL).toBe('NOT SCORED');
  });

  it('never promises an analyze action the library cannot perform', () => {
    expect(PENDING_SECTION_LABEL).not.toMatch(/ready/i);
    expect(PENDING_SECTION_NOTE).toBe(
      'Saved clips aren’t scored from the library. Record a new stroke to get a score.',
    );
  });
});

describe('pendingEvidenceCopy', () => {
  it('keeps the measured evidence line for valid clips with capture evidence', () => {
    const withEvidence = capture({
      clip: {
        captureEvidence: { poseFrameCount: 6, meanJointCoverage: 0.93 },
        // Only the two fields above are read by the copy helper.
      } as unknown as PendingCapture['clip'],
    });
    expect(pendingEvidenceCopy(withEvidence)).toBe(
      '6 pose frames · 93% joint coverage',
    );
  });

  it('says a valid clip simply has not been analyzed — not that evidence is unavailable', () => {
    const copy = pendingEvidenceCopy(capture({ clip: null }));
    expect(copy).toBe('Clip saved — analysis has not run yet');
    expect(copy).not.toMatch(/validated evidence is unavailable/i);
  });

  it('explains legacy, mismatched, and corrupt evidence as unscorable', () => {
    expect(pendingEvidenceCopy(capture({ evidenceStatus: 'legacy' }))).toBe(
      'Recorded by an older app version — can’t be scored',
    );
    expect(
      pendingEvidenceCopy(capture({ evidenceStatus: 'metadata_mismatch' })),
    ).toBe('Evidence doesn’t match this video — can’t be scored');
    expect(pendingEvidenceCopy(capture({ evidenceStatus: 'corrupt' }))).toBe(
      'Saved evidence could not be verified — can’t be scored',
    );
  });
});

describe('pendingCaptureTitle', () => {
  it('uses the declared stroke when the player declared one', () => {
    expect(
      pendingCaptureTitle(capture({ declaredStroke: 'forehand_drive' })),
    ).toBe('Forehand Drive · auto capture');
  });

  it('falls back to the recognized shot type when there is no declaration', () => {
    expect(pendingCaptureTitle(capture({ shotType: 'backhand_dink' }))).toBe(
      'Backhand Dink · auto capture',
    );
  });

  it('labels an unrecognized clip plainly as an auto capture', () => {
    expect(pendingCaptureTitle(capture({}))).toBe('Auto capture');
  });

  it('prefers the declaration over the stored shot type', () => {
    expect(
      pendingCaptureTitle(
        capture({ declaredStroke: 'serve', shotType: 'backhand_dink' }),
      ),
    ).toBe('Serve · auto capture');
  });
});
