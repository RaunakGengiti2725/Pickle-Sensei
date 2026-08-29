import { compactPracticeBuckets } from '../src/progress/PracticeVolumeChart';

describe('practice volume chart bucketing', () => {
  it('preserves every real capture while keeping long ranges readable', () => {
    const source = Array.from({ length: 90 }, (_, index) => ({
      key: `2026-06-${String(index + 1).padStart(2, '0')}`,
      label: `Day ${index + 1}`,
      count: index % 5,
    }));

    const compacted = compactPracticeBuckets(source, 13);

    expect(compacted.length).toBeLessThanOrEqual(13);
    expect(compacted[0]).toMatchObject({
      firstLabel: 'Day 1',
      lastLabel: 'Day 7',
    });
    expect(compacted.at(-1)?.lastLabel).toBe('Day 90');
    expect(compacted.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(
      source.reduce((sum, bucket) => sum + bucket.count, 0),
    );
  });

  it('keeps short ranges at day-level resolution', () => {
    const source = [
      { key: '2026-08-25', label: 'Aug 25', count: 0 },
      { key: '2026-08-26', label: 'Aug 26', count: 2 },
      { key: '2026-08-27', label: 'Aug 27', count: 1 },
    ];

    expect(compactPracticeBuckets(source)).toEqual([
      {
        key: '2026-08-25:2026-08-25',
        firstLabel: 'Aug 25',
        lastLabel: 'Aug 25',
        count: 0,
      },
      {
        key: '2026-08-26:2026-08-26',
        firstLabel: 'Aug 26',
        lastLabel: 'Aug 26',
        count: 2,
      },
      {
        key: '2026-08-27:2026-08-27',
        firstLabel: 'Aug 27',
        lastLabel: 'Aug 27',
        count: 1,
      },
    ]);
  });
});
