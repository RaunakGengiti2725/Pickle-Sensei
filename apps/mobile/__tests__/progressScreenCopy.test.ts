// ProgressScreen's module graph reaches the SQLite db binding; the pure
// display helpers under test never touch it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import {
  captureSourceDetail,
  displayCaptureTitle,
  excludedCapturesNote,
  percent,
} from '../src/screens/ProgressScreen';
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

  it('falls back to the user’s declared stroke before the generic label', () => {
    const declared = {
      clip: { recognition: { status: 'unknown', reason: 'analysis_not_run' } },
      declaredStroke: 'backhand_dink',
    } as unknown as CaptureHistoryEntry;
    expect(displayCaptureTitle(declared)).toBe('backhand dink');
    // A live recognition still outranks the declaration.
    const both = {
      clip: { recognition: { status: 'recognized', shotType: 'serve' } },
      declaredStroke: 'backhand_dink',
    } as unknown as CaptureHistoryEntry;
    expect(displayCaptureTitle(both)).toBe('serve');
  });
});

describe('captureSourceDetail', () => {
  it('names the path the clip took', () => {
    expect(
      captureSourceDetail({
        durationMs: 3_900,
        fps: 59.94,
        clip: { captureMode: 'automatic_pose_trigger' },
      } as unknown as CaptureHistoryEntry),
    ).toBe('3.9s saved clip · 60 recorded fps');
    expect(
      captureSourceDetail({
        durationMs: 2_000,
        fps: 30,
        clip: { captureMode: 'imported_video' },
      } as unknown as CaptureHistoryEntry),
    ).toBe('2.0s imported clip · pose sequence measured');
  });
});

describe('excludedCapturesNote', () => {
  it('is silent at zero and count-correct otherwise', () => {
    expect(excludedCapturesNote(0)).toBeNull();
    expect(excludedCapturesNote(1)).toBe(
      '1 saved clip without measured pose evidence is not counted.',
    );
    expect(excludedCapturesNote(3)).toBe(
      '3 saved clips without measured pose evidence are not counted.',
    );
  });
});
