import { recordClock } from '../src/util/recordClock';

const T0 = Date.parse('2026-09-08T12:00:00.000Z');

function ticking(...readings: number[]): () => number {
  let index = 0;
  return () => readings[Math.min(index++, readings.length - 1)]!;
}

describe('recordClock', () => {
  it('reads the wall clock when nothing constrains it', () => {
    const now = recordClock([], ticking(T0, T0 + 5));
    expect(now()).toBe(new Date(T0).toISOString());
    expect(now()).toBe(new Date(T0 + 5).toISOString());
  });

  it('never hands out an instant earlier than the floors it was given', () => {
    const captured = new Date(T0 + 3_600_000).toISOString();
    const selected = new Date(T0 + 10_000).toISOString();
    const now = recordClock([captured, null, selected, undefined], ticking(T0));
    expect(now()).toBe(captured);
  });

  it('is monotonic: a clock that steps back between two reads repeats the later instant', () => {
    const now = recordClock([], ticking(T0 + 1_000, T0, T0 + 2_000));
    expect(now()).toBe(new Date(T0 + 1_000).toISOString());
    expect(now()).toBe(new Date(T0 + 1_000).toISOString());
    expect(now()).toBe(new Date(T0 + 2_000).toISOString());
  });

  it('resumes following the wall clock once it passes the floor', () => {
    const captured = new Date(T0 + 500).toISOString();
    const now = recordClock([captured], ticking(T0, T0 + 500, T0 + 900));
    expect(now()).toBe(captured);
    expect(now()).toBe(captured);
    expect(now()).toBe(new Date(T0 + 900).toISOString());
  });

  it('ignores floors that are not parseable instants', () => {
    const now = recordClock(['not-a-date', ''], ticking(T0));
    expect(now()).toBe(new Date(T0).toISOString());
  });
});
