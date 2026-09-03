import type { ApiSession } from '../../src/account/apiSession';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';
import {
  fetchPlayerRank,
  type PlayerRankFetch,
} from '../../src/progress/playerRank';

const SESSION: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token',
  canonicalAppUserId: 'user-1',
  provider: 'google',
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchPlayerRank X-Client-Version header', () => {
  it('sends the shipped app version from runtime config, not a stale literal', async () => {
    const fetchFn = jest.fn(async () =>
      jsonResponse(200, { rank: null }),
    ) as unknown as jest.MockedFunction<PlayerRankFetch>;

    await fetchPlayerRank(SESSION, fetchFn);

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.test/v1/rank');
    const headers = init?.headers as Record<string, string>;
    expect(headers['X-Client-Version']).toBe(
      getRuntimePublicConfig().appVersion,
    );
    expect(headers['X-Client-Version']).toBe('1.0');
    expect(headers['X-Client-Version']).not.toBe('0.1.0');
  });
});
