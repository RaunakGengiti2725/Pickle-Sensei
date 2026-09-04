/**
 * Adversarial follow-up to networkAuthAdversarial.test.ts A1 (fix candidate
 * 15a7b9e5, cluster xc-matrix::XC-ADJ-AUTH-2).
 *
 * The fix paces rotations from SKEWED_EXPIRY_FLOOR_MS only when the rotated
 * bearer's lead (expiresAt − now − REFRESH_LEAD_MS) is ≤ 0. A device clock
 * that runs ahead of the server by a little LESS than the full skew A1 uses
 * leaves every rotated bearer with a small positive lead (a few seconds):
 * `scheduleAfterRotation` then takes the "healthy" branch, resets the skew
 * counter, and schedules the next rotation `lead` milliseconds out — the
 * original ~1 Hz refresh loop, merely a few seconds slower. The A1 contract
 * (≤ 5 refreshes in 120 s, AUTH_REFRESH_LIMIT is 30/min per IP) is violated
 * for every skew in a ~25 s band below A1's.
 *
 * Written to FAIL on the candidate: it pins A1's own bound for skews that
 * leave 62 s and 66 s of bearer life instead of 0 s.
 */
import { AppState } from 'react-native';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  API_BASE,
  CANONICAL_ID,
} from '../../test-support/matrix/networkAuthHarness';

interface Seen {
  atMs: number;
  url: string;
}

function scriptedFetch(
  startMs: number,
  handler: (seen: Seen) => { status: number; body: unknown; latencyMs: number },
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    const entry: Seen = { atMs: Date.now() - startMs, url };
    seen.push(entry);
    const reply = handler(entry);
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({
          ok: reply.status >= 200 && reply.status < 300,
          status: reply.status,
          statusText: String(reply.status),
          json: async () => reply.body,
          text: async () => JSON.stringify(reply.body),
        } as unknown as Response);
      }, reply.latencyMs);
      init?.signal?.addEventListener('abort', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const error = new Error('Aborted');
        error.name = 'AbortError';
        reject(error);
      });
    });
  };
  return { fetch: impl as unknown as typeof fetch, seen };
}

const START = Date.UTC(2026, 8, 4, 12, 0, 0);
const SERVER_LIFETIME_MS = 3_600_000;

function begin() {
  jest.useFakeTimers();
  jest.setSystemTime(START);
  setActiveDataOwner(CANONICAL_ID);
  establishApiSession({
    apiBaseUrl: API_BASE,
    bearerToken: 'B0',
    canonicalAppUserId: CANONICAL_ID,
    provider: 'apple',
    refreshToken: 'R0',
    bearerExpiresAtMs: START + SERVER_LIFETIME_MS,
  });
  setApiUnauthorizedListener(expired => {
    if (expired.refreshToken) refreshSessionNow();
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation(
      () =>
        ({ remove: () => {} }) as ReturnType<typeof AppState.addEventListener>,
    );
}

function end() {
  stopSessionKeeper();
  setApiUnauthorizedListener(null);
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
  jest.useRealTimers();
}

/** Runs the keeper for 120 s against a server whose clock trails the device
 * by `SERVER_LIFETIME_MS − lifeOnDeviceMs`: every rotated bearer reads as
 * having `lifeOnDeviceMs` of life the moment it is issued. */
async function refreshesIn120s(lifeOnDeviceMs: number) {
  let gen = 0;
  let revoked = 0;
  const rotated: number[] = [];
  const { fetch, seen } = scriptedFetch(START, entry => {
    if (!entry.url.endsWith('/v1/auth/refresh')) {
      return { status: 404, body: null, latencyMs: 10 };
    }
    gen += 1;
    return {
      status: 200,
      body: {
        session: {
          accessToken: `B${gen}`,
          refreshToken: `R${gen}`,
          expiresAt: Math.floor((Date.now() + lifeOnDeviceMs) / 1000),
        },
      },
      latencyMs: 50,
    };
  });
  startSessionKeeper({
    apiBaseUrl: API_BASE,
    refreshToken: 'R0',
    bearerExpiresAtMs: null,
    fetchFn: fetch as unknown as Parameters<
      typeof startSessionKeeper
    >[0]['fetchFn'],
    onRotated: tokens => {
      rotated.push(Date.now() - START);
      const current = getApiSession();
      if (current?.canonicalAppUserId !== CANONICAL_ID) return;
      establishApiSession({
        ...current,
        bearerToken: tokens.bearerToken,
        refreshToken: tokens.refreshToken,
        bearerExpiresAtMs: tokens.bearerExpiresAtMs,
      });
    },
    onRevoked: () => {
      revoked += 1;
      clearApiSession();
    },
  });
  await jest.advanceTimersByTimeAsync(120_000);
  const refreshes = seen.filter(s => s.url.endsWith('/v1/auth/refresh'));
  const gaps = refreshes.slice(1).map((s, i) => s.atMs - refreshes[i]!.atMs);
  return {
    lifeOnDeviceMs,
    deviceClockAheadMs: SERVER_LIFETIME_MS - lifeOnDeviceMs,
    refreshRequestsIn120s: refreshes.length,
    rotations: rotated.length,
    minGapMs: gaps.length ? Math.min(...gaps) : null,
    revoked,
  };
}

describe('NETWORK × AUTH adversarial: skew band just below A1', () => {
  beforeEach(begin);
  afterEach(end);

  it.each([
    [66_000, '≈ 6 s lead → a refresh every ≈ 6 s'],
    [62_000, '≈ 2 s lead → a refresh every ≈ 2 s'],
  ])(
    'a bearer that arrives with %d ms of life on the device (device clock ahead of the server by a little under an hour) must not turn the keeper into a refresh loop (%s)',
    async lifeOnDeviceMs => {
      const observed = await refreshesIn120s(lifeOnDeviceMs);
      console.log(`[adjudicate] ${JSON.stringify(observed)}`);
      expect(observed.revoked).toBe(0);
      // A1's contract, verbatim: ≤ 5 refreshes in 120 s.
      expect(observed.refreshRequestsIn120s).toBeLessThanOrEqual(5);
    },
  );
});
