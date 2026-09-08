/**
 * Adversarial (P0-02): clock boundaries the session keeper was not
 * explicitly pinned for — a far-future expiry (beyond the 2^31-1 ms timer
 * ceiling), an expiry so large it becomes +Infinity after the seconds→ms
 * conversion, and a device clock that rolls BACKWARDS by a day after a
 * successful rotation.
 *
 * Invariant under attack (AGENTS.md "Auth sessions"): a successful rotation
 * never re-arms faster than MIN_ROTATION_GAP_MS, and nothing but a 401/403 on
 * the refresh route signs the user out. NOTE: setTimeout with a delay above
 * 2^31-1 ms fires after 1 ms under Node AND under @sinonjs/fake-timers; the
 * iOS timer bridge takes a double. Any storm seen here is therefore a
 * Node-semantics finding until reproduced on the M4 runner.
 */
import {
  MIN_ROTATION_GAP_MS,
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
  type SessionKeeperInput,
} from '../../src/account/sessionKeeper';

type Served = { requestedAtMs: number };

function keeperFor(
  expiresAtFor: () => number,
  hooks: Pick<SessionKeeperInput, 'onRotated' | 'onRevoked'>,
  bearerExpiresAtMs: number | null = null,
) {
  const served: Served[] = [];
  let n = 0;
  const fetchFn: NonNullable<SessionKeeperInput['fetchFn']> = async () => {
    n += 1;
    served.push({ requestedAtMs: Date.now() });
    return new Response(
      JSON.stringify({
        session: {
          accessToken: `access-${n}`,
          refreshToken: `refresh-${n}`,
          expiresAt: expiresAtFor(),
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  startSessionKeeper({
    apiBaseUrl: 'https://api.test',
    refreshToken: 'refresh-0',
    bearerExpiresAtMs,
    ...hooks,
    fetchFn,
  });
  return served;
}

/** Advances fake time in `steps` slices; stops early once `stop()` is true so
 * a storm of hundreds of thousands of refreshes is detected, not replayed. */
async function settle(
  advanceMs: number,
  steps: number,
  stop: () => boolean = () => false,
): Promise<void> {
  for (let i = 0; i < steps && !stop(); i += 1) {
    await jest.advanceTimersByTimeAsync(advanceMs / steps);
  }
}

const STORM_CAP = 1 + Math.ceil((10 * 60_000) / MIN_ROTATION_GAP_MS);

const DAY_S = 86_400;
const TEN_MINUTES_MS = 10 * 60_000;

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(new Date('2026-09-08T12:00:00Z'));
});

afterEach(() => {
  stopSessionKeeper();
  jest.useRealTimers();
});

describe('sessionKeeper clock boundaries (adversarial)', () => {
  it.each([
    ['expiry 30 days ahead (timer delay > 2^31-1 ms)', 30 * DAY_S],
    ['expiry 400 days ahead', 400 * DAY_S],
  ])(
    'a far-future bearer expiry does not become a refresh storm: %s',
    async (_label, lifeSeconds) => {
      const onRotated = jest.fn();
      const onRevoked = jest.fn();
      const served = keeperFor(
        () => Math.floor(Date.now() / 1000) + lifeSeconds,
        { onRotated, onRevoked },
      );
      await settle(TEN_MINUTES_MS, 600, () => served.length > STORM_CAP);
      // one launch refresh, then nothing until 60 s before the (far) expiry
      expect(served.length).toBeLessThanOrEqual(STORM_CAP);
      expect(onRevoked).not.toHaveBeenCalled();
      expect(onRotated).toHaveBeenCalledTimes(served.length);
    },
  );

  it('an expiry that overflows to +Infinity after *1000 does not storm or sign out', async () => {
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    // 1e306 s is finite, 1e306 * 1000 is +Infinity.
    const served = keeperFor(() => 1e306, { onRotated, onRevoked });
    await settle(TEN_MINUTES_MS, 600, () => served.length > STORM_CAP);
    expect(served.length).toBeLessThanOrEqual(STORM_CAP);
    expect(onRevoked).not.toHaveBeenCalled();
  });

  it('a device clock rolling back a day after rotation neither storms nor signs out, and the foreground check still refreshes an expired bearer', async () => {
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const served = keeperFor(() => Math.floor(Date.now() / 1000) + 3600, {
      onRotated,
      onRevoked,
    });
    await settle(1_000, 1);
    expect(served).toHaveLength(1);

    // Clock rolls back 24 h: the bearer now "expires" 25 h from the phone's
    // point of view.
    jest.setSystemTime(Date.now() - DAY_S * 1000);
    await settle(TEN_MINUTES_MS, 600);
    expect(served).toHaveLength(1);
    expect(onRevoked).not.toHaveBeenCalled();

    // The server's clock did not roll back: 3 h later the bearer is dead by
    // the server's clock; a rejected route asks for an immediate refresh.
    refreshSessionNow();
    await settle(1_000, 1);
    expect(served).toHaveLength(2);
    expect(onRevoked).not.toHaveBeenCalled();
    expect(onRotated).toHaveBeenCalledTimes(2);
  });

  it('a stored bearer whose expiry is NaN-free but far in the past refreshes exactly once at launch', async () => {
    const onRotated = jest.fn();
    const onRevoked = jest.fn();
    const served = keeperFor(
      () => Math.floor(Date.now() / 1000) + 3600,
      { onRotated, onRevoked },
      Date.now() - 365 * DAY_S * 1000,
    );
    await settle(TEN_MINUTES_MS, 600);
    expect(served).toHaveLength(1);
    expect(onRevoked).not.toHaveBeenCalled();
  });
});
