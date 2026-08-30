import type { ApiSession } from '../src/account/apiSession';
import {
  fetchCanonicalProgress,
  type ProgressFetch,
} from '../src/progress/api';

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'real-token',
  refreshToken: 'refresh-token-1',
  bearerExpiresAtMs: Date.now() + 3_600_000,
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'google',
};

describe('canonical progress API', () => {
  it('parses server-authoritative series and practice streaks', async () => {
    const fetchFn: ProgressFetch = async (_url, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: 'Bearer real-token',
      });
      return new Response(
        JSON.stringify({
          series: [
            {
              day: '2026-08-27',
              shot_type: 'forehand_drive',
              scoring_model_version: 'sm-v1',
              shot_count: 3,
              avg_score: '76.0',
              best_score: '83.0',
            },
          ],
          improving: [{ checkpoint: 'preparation', delta: 4.2 }],
          needsAttention: [{ checkpoint: 'contact_position', avg: 61.5 }],
          streak: {
            currentDays: 4,
            longestDays: 9,
            practicedToday: true,
            lastPracticeDate: '2026-08-27',
          },
        }),
        { status: 200 },
      );
    };

    await expect(fetchCanonicalProgress(session, fetchFn)).resolves.toEqual({
      series: [
        {
          day: '2026-08-27',
          shotType: 'forehand_drive',
          scoringModelVersion: 'sm-v1',
          shotCount: 3,
          avgScore: 7.6,
          bestScore: 8.3,
        },
      ],
      improving: [{ checkpoint: 'preparation', delta: 4.2 }],
      needsAttention: [{ checkpoint: 'contact_position', avg: 61.5 }],
      streak: {
        currentDays: 4,
        longestDays: 9,
        practicedToday: true,
        lastPracticeDate: '2026-08-27',
      },
    });
  });

  it('rejects malformed metrics rather than filling them with guesses', async () => {
    const fetchFn: ProgressFetch = async () =>
      new Response(
        JSON.stringify({
          series: [{ shot_count: 'not-a-number' }],
          improving: [],
          needsAttention: [],
          streak: {},
        }),
        { status: 200 },
      );
    await expect(fetchCanonicalProgress(session, fetchFn)).rejects.toThrow(
      'Invalid progress series.',
    );
  });
});
