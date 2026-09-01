import { plural } from '../src/util/plural';

describe('plural', () => {
  it('returns the singular form for exactly 1', () => {
    expect(plural(1, 'day')).toBe('day');
    expect(plural(1, 'active day')).toBe('active day');
    expect(plural(1, 'clip')).toBe('clip');
  });

  it('returns the default plural (singular + s) for every other count', () => {
    expect(plural(0, 'day')).toBe('days');
    expect(plural(2, 'read')).toBe('reads');
    expect(plural(37, 'active day')).toBe('active days');
  });

  it('uses an explicit irregular plural form when provided', () => {
    expect(plural(1, 'daily average', 'daily averages')).toBe('daily average');
    expect(plural(4, 'daily average', 'daily averages')).toBe('daily averages');
    expect(plural(2, 'entry is', 'entries are')).toBe('entries are');
  });
});
