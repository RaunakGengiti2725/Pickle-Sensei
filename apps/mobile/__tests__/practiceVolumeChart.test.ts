import { compactPracticeBuckets } from '../src/progress/PracticeVolumeChart';

describe('practice volume chart bucketing', () => {
  it('leaves shared readonly daily values intact and keeps every grouped endpoint and count', () => {
    const source = Object.freeze(
      Array.from({ length: 365 }, (_, index) =>
        Object.freeze({
          key: `day-${index}`,
          label: `Day ${index + 1}`,
          count: index % 5,
        }),
      ),
    );
    const compacted = compactPracticeBuckets(source);
    expect(compacted).toHaveLength(13);
    compacted.forEach((value, index) => {
      const group = source.slice(index * 29, (index + 1) * 29);
      expect(value).toEqual({
        key: `${group[0]!.key}:${group.at(-1)!.key}`,
        firstLabel: group[0]!.label,
        lastLabel: group.at(-1)!.label,
        count: group.reduce((sum, day) => sum + day.count, 0),
      });
    });
    expect(source.map(value => value.count)).toEqual(
      Array.from({ length: 365 }, (_, index) => index % 5),
    );
  });

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
