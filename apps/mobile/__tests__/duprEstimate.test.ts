import {
  DUPR_ESTIMATE_NOTE,
  duprEstimate,
  formatDuprEstimate,
} from '../src/progress/duprEstimate';

/**
 * The DUPR-style estimate is a fixed linear rescale of the 0–10 Technique
 * Score onto a 1–7 span, one decimal, always presented as an estimate.
 * These tests pin the mapping so a display tweak can't silently change what
 * number users see.
 */

describe('duprEstimate', () => {
  it('maps the 0–10 span linearly onto 1–7', () => {
    expect(duprEstimate(0)).toBe(1.0);
    expect(duprEstimate(5)).toBe(4.0);
    expect(duprEstimate(10)).toBe(7.0);
    expect(duprEstimate(7.5)).toBe(5.5);
  });

  it('rounds to one decimal — two would imply unearned precision', () => {
    expect(duprEstimate(7.62)).toBe(5.6);
    expect(duprEstimate(3.33)).toBe(3.0);
  });

  it('clamps scores outside the valid range', () => {
    expect(duprEstimate(-2)).toBe(1.0);
    expect(duprEstimate(14)).toBe(7.0);
  });

  it('formats as a parenthetical marked as approximate', () => {
    expect(formatDuprEstimate(7.62)).toBe('(≈ DUPR 5.6)');
    expect(formatDuprEstimate(0)).toBe('(≈ DUPR 1.0)');
  });

  it('ships a disclaimer that names the limitation', () => {
    expect(DUPR_ESTIMATE_NOTE).toContain('estimate');
    expect(DUPR_ESTIMATE_NOTE).toContain('technique doesn’t directly transfer');
  });
});
