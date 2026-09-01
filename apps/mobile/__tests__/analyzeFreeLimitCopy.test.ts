// The screen module pulls in the SQLite-backed db, whose native binding does
// not exist under jest. The pure copy helper under test never touches it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { freeAnalysesPhrase } from '../src/screens/AnalyzeScreen';

describe('freeAnalysesPhrase (free-limit dialog wording)', () => {
  it('says "both" only while the server-declared allowance is exactly 2', () => {
    expect(freeAnalysesPhrase(2)).toBe('both');
  });

  it('derives "all N" from any other allowance instead of hardcoding "both"', () => {
    expect(freeAnalysesPhrase(3)).toBe('all 3');
    expect(freeAnalysesPhrase(5)).toBe('all 5');
    expect(freeAnalysesPhrase(1)).toBe('all 1');
  });
});
