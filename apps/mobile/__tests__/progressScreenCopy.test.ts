// ProgressScreen's module graph reaches the SQLite db binding; the pure
// display helpers under test never touch it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { displayCaptureTitle, percent } from '../src/screens/ProgressScreen';
import type { CaptureHistoryEntry } from '../src/data/repository';

describe('percent', () => {
  it('formats in-range rates as whole percentages', () => {
    expect(percent(0)).toBe('0%');
    expect(percent(0.874)).toBe('87%');
    expect(percent(1)).toBe('100%');
  });

  it('keeps the honest em dash for missing values', () => {
    expect(percent(null)).toBe('—');
  });

  it('clamps out-of-range input so an impossible rate can never render', () => {
    expect(percent(1.6)).toBe('100%');
    expect(percent(-0.4)).toBe('0%');
  });
});

describe('displayCaptureTitle', () => {
  function entry(clip: { recognition?: unknown } | null): CaptureHistoryEntry {
    // Only clip.recognition is read by the title helper.
    return { clip } as unknown as CaptureHistoryEntry;
  }

  it('keeps recognized stroke labels as-is', () => {
    expect(
      displayCaptureTitle(
        entry({
          recognition: { status: 'recognized', shotType: 'forehand_drive' },
        }),
      ),
    ).toBe('forehand drive');
  });

  it('labels unrecognized captures as a practice clip, not "Unlabeled motion"', () => {
    const unrecognized = displayCaptureTitle(
      entry({
        recognition: {
          status: 'unknown',
          reason: 'validated_classifier_unavailable',
        },
      }),
    );
    expect(unrecognized).toBe('Practice clip');
    expect(displayCaptureTitle(entry(null))).toBe('Practice clip');
    expect(unrecognized).not.toMatch(/unlabeled motion/i);
  });
});
