// AnalyzeScreen imports the SQLite-backed data layer, whose native module does
// not exist under jest. The pure copy helper under test never touches it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { freeAnalysesPhrase } from '../src/screens/AnalyzeScreen';
import { FREE_RATING_LIMIT } from '../src/billing/freeRatings';

describe('freeAnalysesPhrase (free-limit dialog wording)', () => {
  it('words the shipping allowance of one as a single free analysis', () => {
    expect(FREE_RATING_LIMIT).toBe(1);
    expect(freeAnalysesPhrase(1)).toBe('your free analysis');
  });

  it('says "both" only while the server-declared allowance is exactly 2', () => {
    expect(freeAnalysesPhrase(2)).toBe('both free analyses');
  });

  it('derives "all N" from any larger allowance instead of hardcoding a count', () => {
    expect(freeAnalysesPhrase(3)).toBe('all 3 free analyses');
    expect(freeAnalysesPhrase(5)).toBe('all 5 free analyses');
  });
});
