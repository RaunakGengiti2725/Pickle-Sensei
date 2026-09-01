import {
  MIN_FOCUS_SAMPLES,
  checkpointDisplayName,
  computeLibraryFocus,
  familyDisplayLabel,
  focusEvidenceLine,
  recommendDrills,
  type LibraryFocus,
  type ScoredCheckpointFact,
} from '../src/library/libraryFocus';

/**
 * Pins the drill library's personalization math: the focus is the weakest
 * sufficiently-evidenced checkpoint over each technique's recent form
 * window, computed only from scored evidence the caller actually has. No
 * evidence → null, never an invented pick; recommendations match by
 * technique family only.
 */

let counter = 0;

function fact(
  shotType: string,
  capturedAt: string,
  checkpoints: [string, number | null][],
  options?: { inapplicable?: string[] },
): ScoredCheckpointFact {
  counter += 1;
  return {
    id: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    shotType,
    capturedAt,
    checkpoints: [
      ...checkpoints.map(([key, score]) => ({
        key,
        score,
        applicable: true,
      })),
      ...(options?.inapplicable ?? []).map(key => ({
        key,
        score: 40 as number | null,
        applicable: false,
      })),
    ],
  };
}

describe('computeLibraryFocus', () => {
  it('returns null with no evidence at all', () => {
    expect(computeLibraryFocus([])).toBeNull();
  });

  it('returns null when no checkpoint reaches the evidence minimum', () => {
    // One scored read per technique: every checkpoint has one sample, which
    // is below MIN_FOCUS_SAMPLES — a single read is never a diagnosis.
    expect(MIN_FOCUS_SAMPLES).toBe(2);
    const focus = computeLibraryFocus([
      fact('dink', '2026-08-01T10:00:00.000Z', [['contact_position', 30]]),
      fact('serve', '2026-08-02T10:00:00.000Z', [['sequencing', 20]]),
    ]);
    expect(focus).toBeNull();
  });

  it('names the weakest evidenced checkpoint and its drill family', () => {
    const focus = computeLibraryFocus([
      fact('dink', '2026-08-02T10:00:00.000Z', [
        ['contact_position', 50],
        ['athletic_base', 80],
      ]),
      fact('dink', '2026-08-01T10:00:00.000Z', [
        ['contact_position', 60],
        ['athletic_base', 82],
      ]),
    ]);
    expect(focus).not.toBeNull();
    expect(focus!.shotType).toBe('dink');
    expect(focus!.checkpoint).toBe('contact_position');
    expect(focus!.family).toBe('dink');
    expect(focus!.sampleCount).toBe(2);
    // Linear recency weights, newest heaviest: (2·50 + 1·60) / 3 ≈ 53.
    expect(focus!.averageScore).toBe(53);
  });

  it('ignores inapplicable and unscored checkpoints', () => {
    const focus = computeLibraryFocus([
      fact(
        'dink',
        '2026-08-02T10:00:00.000Z',
        [
          ['contact_position', 70],
          ['paddle_path', null],
        ],
        { inapplicable: ['recovery'] },
      ),
      fact(
        'dink',
        '2026-08-01T10:00:00.000Z',
        [
          ['contact_position', 70],
          ['paddle_path', null],
        ],
        { inapplicable: ['recovery'] },
      ),
    ]);
    // recovery (inapplicable, would be 40) and paddle_path (unscored) can
    // never outrank the honestly observed checkpoint.
    expect(focus!.checkpoint).toBe('contact_position');
  });

  it('weights the newest reads heaviest within the form window', () => {
    // The player fixed their contact: old reads were 20, the recent two are
    // 90. Follow-through sits flat at 60. Recency weighting must let the
    // improvement win (flat 60 becomes the weaker checkpoint).
    const facts = [
      fact('dink', '2026-08-09T10:00:00.000Z', [
        ['contact_position', 90],
        ['follow_through', 60],
      ]),
      fact('dink', '2026-08-08T10:00:00.000Z', [
        ['contact_position', 90],
        ['follow_through', 60],
      ]),
      fact('dink', '2026-08-07T10:00:00.000Z', [
        ['contact_position', 20],
        ['follow_through', 60],
      ]),
    ];
    const focus = computeLibraryFocus(facts);
    expect(focus!.checkpoint).toBe('follow_through');
  });

  it('caps each technique at its form window of recent reads', () => {
    // Nine dink reads: the oldest one (score 1 on athletic_base) must fall
    // outside the 8-read window and leave athletic_base at a healthy 90,
    // while contact_position stays the honest weak spot at 50.
    const facts = [
      ...Array.from({ length: 8 }, (_, i) =>
        fact('dink', `2026-08-1${i}T10:00:00.000Z`, [
          ['athletic_base', 90],
          ['contact_position', 50],
        ]),
      ),
      fact('dink', '2026-08-01T10:00:00.000Z', [['athletic_base', 1]]),
    ];
    const focus = computeLibraryFocus(facts);
    expect(focus!.checkpoint).toBe('contact_position');
    expect(focus!.averageScore).toBe(50);
  });

  it('maps drive techniques onto the drive family and overhead onto global', () => {
    const drive = computeLibraryFocus([
      fact('backhand_drive', '2026-08-02T10:00:00.000Z', [['sequencing', 40]]),
      fact('backhand_drive', '2026-08-01T10:00:00.000Z', [['sequencing', 45]]),
    ]);
    expect(drive!.family).toBe('drive');
    const overhead = computeLibraryFocus([
      fact('overhead', '2026-08-02T10:00:00.000Z', [['paddle_set', 40]]),
      fact('overhead', '2026-08-01T10:00:00.000Z', [['paddle_set', 45]]),
    ]);
    expect(overhead!.family).toBe('global');
  });

  it('is deterministic across input order', () => {
    const facts = [
      fact('dink', '2026-08-02T10:00:00.000Z', [['contact_position', 50]]),
      fact('dink', '2026-08-01T10:00:00.000Z', [['contact_position', 60]]),
      fact('serve', '2026-08-02T10:00:00.000Z', [['sequencing', 55]]),
      fact('serve', '2026-08-01T10:00:00.000Z', [['sequencing', 55]]),
    ];
    const forward = computeLibraryFocus(facts);
    const reversed = computeLibraryFocus([...facts].reverse());
    expect(forward).toEqual(reversed);
  });
});

describe('recommendDrills', () => {
  const focus: LibraryFocus = {
    shotType: 'dink',
    checkpoint: 'contact_position',
    averageScore: 53,
    sampleCount: 2,
    family: 'dink',
  };
  const catalog = [
    { slug: 'volley-wall', families: ['volley'] },
    { slug: 'dink-ladder', families: ['dink'] },
    { slug: 'shadow-swings', families: ['global'] },
    { slug: 'dink-crosscourt', families: ['dink'] },
  ];

  it('puts family matches first, fills with global, keeps catalog order', () => {
    expect(recommendDrills(catalog, focus).map(d => d.slug)).toEqual([
      'dink-ladder',
      'dink-crosscourt',
      'shadow-swings',
    ]);
  });

  it('never recommends unrelated families', () => {
    const slugs = recommendDrills(catalog, focus, 4).map(d => d.slug);
    expect(slugs).not.toContain('volley-wall');
  });

  it('does not double-fill when the focus family is global itself', () => {
    const globalFocus: LibraryFocus = { ...focus, family: 'global' };
    expect(recommendDrills(catalog, globalFocus).map(d => d.slug)).toEqual([
      'shadow-swings',
    ]);
  });
});

describe('display helpers', () => {
  it('uses canonical checkpoint names with a humanized fallback', () => {
    expect(checkpointDisplayName('contact_position')).toBe('Contact position');
    expect(checkpointDisplayName('contact_height')).toBe('Contact height');
  });

  it('labels families for humans without renaming the filter slugs', () => {
    expect(familyDisplayLabel('drop_reset')).toBe('Drops & resets');
    expect(familyDisplayLabel('global')).toBe('Fundamentals');
    expect(familyDisplayLabel('unknown_family')).toBe('Unknown family');
  });

  it('states the exact evidence behind the focus', () => {
    expect(
      focusEvidenceLine({
        shotType: 'third_shot_drop',
        checkpoint: 'contact_position',
        averageScore: 53,
        sampleCount: 6,
        family: 'drop_reset',
      }),
    ).toBe('Third shot drop · from 6 recent scored reads');
  });
});
