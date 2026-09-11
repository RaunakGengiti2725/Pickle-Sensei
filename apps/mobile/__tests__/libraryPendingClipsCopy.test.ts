// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure copy exports under test never touch it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import {
  PENDING_SECTION_LABEL,
  PENDING_SECTION_NOTE,
  PENDING_SECTION_PILL,
  formatClipDuration,
  pendingCaptureActionLabel,
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

  it('distinguishes saved-confirmation reopening from read-only clips without promising an automatic rating', () => {
    expect(PENDING_SECTION_LABEL).not.toMatch(/ready/i);
    expect(PENDING_SECTION_NOTE).toBe(
      'Saved technique confirmations and interrupted analyses reopen the same clip. Other pending clips remain read-only. Opening a clip never starts a rating.',
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

  it('never says "has not run yet" beside a row action that reopens a saved analysis', () => {
    for (const overrides of [
      { hasOriginalOperation: true },
      { techniqueConfirmation: 'ready' },
      { techniqueConfirmation: 'release_pending' },
      { techniqueConfirmation: 'blocked' },
    ] as const) {
      const copy = pendingEvidenceCopy(capture({ clip: null, ...overrides }));
      expect(copy).toBe('Analysis started — not scored yet');
      expect(copy).not.toMatch(/has not run/i);
    }
  });

  it('keeps the measured evidence line even when the row has an action', () => {
    const withEvidence = capture({
      hasOriginalOperation: true,
      clip: {
        captureEvidence: { poseFrameCount: 54, meanJointCoverage: 1 },
      } as unknown as PendingCapture['clip'],
    });
    expect(pendingEvidenceCopy(withEvidence)).toBe(
      '54 pose frames · 100% joint coverage',
    );
  });
});

describe('pendingCaptureActionLabel', () => {
  it('is null for read-only clips so the row renders without a tap affordance', () => {
    expect(pendingCaptureActionLabel(capture({}))).toBeNull();
    expect(
      pendingCaptureActionLabel(capture({ hasOriginalOperation: false })),
    ).toBeNull();
  });

  it('names the reopen action by saved state', () => {
    expect(
      pendingCaptureActionLabel(capture({ hasOriginalOperation: true })),
    ).toBe('Review saved analysis');
    expect(
      pendingCaptureActionLabel(capture({ techniqueConfirmation: 'ready' })),
    ).toBe('Confirm technique');
    expect(
      pendingCaptureActionLabel(
        capture({ techniqueConfirmation: 'release_pending' }),
      ),
    ).toBe('Recover confirmation');
    expect(
      pendingCaptureActionLabel(capture({ techniqueConfirmation: 'blocked' })),
    ).toBe('Review saved capture');
  });

  it('prefers the technique confirmation over a plain original operation', () => {
    expect(
      pendingCaptureActionLabel(
        capture({ techniqueConfirmation: 'ready', hasOriginalOperation: true }),
      ),
    ).toBe('Confirm technique');
  });
});

describe('formatClipDuration', () => {
  it('renders seconds compactly and switches to m:ss at a minute', () => {
    expect(formatClipDuration(4200)).toBe('4s');
    expect(formatClipDuration(23_400)).toBe('23s');
    expect(formatClipDuration(59_400)).toBe('59s');
    expect(formatClipDuration(60_000)).toBe('1:00');
    expect(formatClipDuration(65_000)).toBe('1:05');
    expect(formatClipDuration(754_000)).toBe('12:34');
  });

  it('never rounds a real clip down to nothing and never invents a length', () => {
    expect(formatClipDuration(400)).toBe('<1s');
    expect(formatClipDuration(0)).toBe('<1s');
    expect(formatClipDuration(Number.NaN)).toBe('—');
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
