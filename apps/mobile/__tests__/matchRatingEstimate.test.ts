import {
  MATCH_RATING_ESTIMATE_NOTE,
  matchRatingEstimate,
  formatMatchRatingEstimate,
} from '../src/progress/matchRatingEstimate';

/**
 * The match-rating estimate is a fixed linear rescale of the 0–10 Technique
 * Score onto a 1–7 span, one decimal, always presented as an estimate under
 * a generic label (no third-party rating trademark — the app's user-facing
 * copy rules forbid it). These tests pin the mapping and the label so a
 * display tweak can't silently change what number — or what name — users
 * see.
 */

describe('matchRatingEstimate', () => {
  it('maps the 0–10 span linearly onto 1–7', () => {
    expect(matchRatingEstimate(0)).toBe(1.0);
    expect(matchRatingEstimate(5)).toBe(4.0);
    expect(matchRatingEstimate(10)).toBe(7.0);
    expect(matchRatingEstimate(7.5)).toBe(5.5);
  });

  it('rounds to one decimal — two would imply unearned precision', () => {
    expect(matchRatingEstimate(7.62)).toBe(5.6);
    expect(matchRatingEstimate(3.33)).toBe(3.0);
  });

  it('clamps scores outside the valid range', () => {
    expect(matchRatingEstimate(-2)).toBe(1.0);
    expect(matchRatingEstimate(14)).toBe(7.0);
  });

  it('formats as a parenthetical marked as approximate', () => {
    expect(formatMatchRatingEstimate(7.62)).toBe('(≈ match rating 5.6)');
    expect(formatMatchRatingEstimate(0)).toBe('(≈ match rating 1.0)');
  });

  it('ships a disclaimer that names the limitation', () => {
    expect(MATCH_RATING_ESTIMATE_NOTE).toContain('estimate');
    expect(MATCH_RATING_ESTIMATE_NOTE).toContain(
      'technique doesn’t directly transfer',
    );
  });

  it('never names a third-party rating trademark', () => {
    expect(formatMatchRatingEstimate(7.62)).not.toMatch(/DUPR/);
    expect(MATCH_RATING_ESTIMATE_NOTE).not.toMatch(/DUPR/);
  });
});
