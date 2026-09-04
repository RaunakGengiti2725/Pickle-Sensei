/**
 * xc-failure-injection-mobile — CLOCK JUMPS.
 *
 * The device clock is moved forward / backward (relative to the server clock
 * that stamps `expiresAt`, and relative to the monotonic timer queue) through
 * the seams that accept a clock: `sessionKeeper` (`now`), the pure
 * notification planner (`nowMs`), the consistency engine (`asOfIso`), and
 * `Date.now`-based modules under `jest.setSystemTime`.
 *
 * Invariants (assignment): no infinite timer loops, no unbounded delays,
 * foreground refresh stays bounded and recoverable.
 */
import { AppState } from 'react-native';
import {
  startSessionKeeper,
  stopSessionKeeper,
  refreshSessionNow,
} from '../../../src/account/sessionKeeper';
import type { SessionFetch } from '../../../src/account/sessionLifecycle';
import { buildNotificationPlan } from '../../../src/notifications/plan';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';
import {
  buildConsistencySnapshot,
  type TrainingActivityInput,
} from '../../../src/consistency/engine';
import {
  armTryAgain,
  consumeTryAgainHandoff,
  clearTryAgainHandoff,
  TRY_AGAIN_HANDOFF_TTL_MS,
} from '../../../src/screens/tryAgainHandoff';
import {
  runScenario,
  seededRng,
  verdictFor,
  type Invariants,
} from '../../../scripts/failure-injection/recorder';

const SUITE = 'clock';
const FILES = {
  scheduleAhead: 'apps/mobile/src/account/sessionKeeper.ts:98-100',
  schedule: 'apps/mobile/src/account/sessionKeeper.ts:86-96',
  minDelay: 'apps/mobile/src/account/sessionKeeper.ts:41',
  foreground: 'apps/mobile/src/account/sessionKeeper.ts:136-146',
  refreshNow: 'apps/mobile/src/account/sessionKeeper.ts:66-68',
  unauthorized: 'apps/mobile/src/auth/authStore.ts:500-514',
  planner: 'apps/mobile/src/notifications/plan.ts:60-78',
  engineAsOf: 'apps/mobile/src/consistency/engine.ts:219-241',
  handoffTtl: 'apps/mobile/src/screens/tryAgainHandoff.ts:53-60',
};

const API = 'https://api.example.test';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Server wall clock, fixed: 2026-08-29T18:00:00Z. */
const SERVER_T0 = Date.UTC(2026, 7, 29, 18, 0, 0);

/**
 * A server whose own clock advances with fake time and always issues a
 * bearer valid for `bearerLifeMs` from ITS clock, regardless of the device.
 */
function makeServer(bearerLifeMs = HOUR) {
  const state = { calls: 0, serverNow: SERVER_T0 };
  const fetchFn: SessionFetch = async () => {
    state.calls += 1;
    const expiresAt = Math.floor((state.serverNow + bearerLifeMs) / 1000);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        session: {
          accessToken: `access-${state.calls}`,
          refreshToken: `refresh-${state.calls}`,
          expiresAt,
        },
      }),
    } as unknown as Response;
  };
  return { state, fetchFn };
}

/** Advances fake timers and both clocks (server, device) together. */
async function advance(
  ms: number,
  clocks: { serverNow: number }[],
  device: { skewMs: number; base: number },
  step = 1_000,
): Promise<void> {
  let remaining = ms;
  while (remaining > 0) {
    const chunk = Math.min(step, remaining);
    for (const clock of clocks) clock.serverNow += chunk;
    device.base += chunk;
    await jest.advanceTimersByTimeAsync(chunk);
    remaining -= chunk;
  }
}

function foregroundHandler(): (state: string) => void {
  const appState = AppState as unknown as { addEventListener: jest.Mock };
  const handlers = appState.addEventListener.mock.calls
    .filter(([event]) => event === 'change')
    .map(([, handler]) => handler as (state: string) => void);
  const handler = handlers[handlers.length - 1];
  if (!handler) throw new Error('keeper did not subscribe to AppState');
  return handler;
}

beforeEach(() => {
  jest.useFakeTimers();
  stopSessionKeeper();
  clearTryAgainHandoff();
});

afterEach(() => {
  stopSessionKeeper();
  clearTryAgainHandoff();
  jest.useRealTimers();
});

describe('xc-failure-injection — clock jumps', () => {
  it('CLK-00 control: device clock == server clock, 1h bearer → one rotation per ~59 min, no storm', async () => {
    await runScenario(
      {
        id: 'CLK-00',
        failureClass: 'clock',
        suite: SUITE,
        title: 'aligned clocks baseline',
        seed: 80,
        inputs: { skewMs: 0, bearerLifeMs: HOUR, fakeTimeMs: 6 * HOUR },
        files: [FILES.scheduleAhead],
      },
      async () => {
        const server = makeServer();
        const device = { skewMs: 0, base: SERVER_T0 };
        const rotated: number[] = [];
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-0',
          bearerExpiresAtMs: null,
          onRotated: t => {
            rotated.push(t.bearerExpiresAtMs);
          },
          onRevoked: jest.fn(),
          fetchFn: server.fetchFn,
          now: () => device.base + device.skewMs,
        });
        await advance(6 * HOUR, [server.state], device, 60_000);
        // t=0, then every 59 min → 1 + floor(6h / 59min) = 7
        expect(server.state.calls).toBe(7);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `${server.state.calls} refreshes in 6h.`,
          expected: '7 refreshes (launch + one per 59 min).',
        };
      },
    );
  });

  it('CLK-01 device clock 2h AHEAD of the server: every fresh 1h bearer already looks expired → refresh every MIN_DELAY (1s) — a refresh storm', async () => {
    await runScenario(
      {
        id: 'CLK-01',
        failureClass: 'clock',
        suite: SUITE,
        title: 'device clock ahead of server by more than the bearer lifetime',
        seed: 81,
        inputs: { skewMs: 2 * HOUR, bearerLifeMs: HOUR, fakeTimeMs: 60_000 },
        files: [FILES.scheduleAhead, FILES.schedule, FILES.minDelay],
      },
      async () => {
        const server = makeServer();
        const device = { skewMs: 2 * HOUR, base: SERVER_T0 };
        const onRevoked = jest.fn();
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-0',
          bearerExpiresAtMs: null,
          onRotated: jest.fn(),
          onRevoked,
          fetchFn: server.fetchFn,
          now: () => device.base + device.skewMs,
        });
        await advance(60_000, [server.state], device, 1_000);
        expect(server.state.calls).toBeGreaterThanOrEqual(55);
        expect(onRevoked).not.toHaveBeenCalled();
        const invariants: Invariants = {
          noInfiniteSpinner: 'fail',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `${server.state.calls} /v1/auth/refresh calls in 60s fake time (≈1/s). Each success computes delay = expiresAt(server) − now(device) − 60s < 0 → clamped to MIN_DELAY_MS=1000 → refresh again. Session stays signed in; the loop is invisible to the user until the per-IP refresh budget answers 429 (retryable → backoff, then the storm resumes on the next 200).`,
          expected:
            'A bearer that is "already expired" on arrival should be detected (expiresAt − now ≤ lead) and the next rotation deferred by a sane floor (e.g. half the server-reported lifetime), or the skew reported.',
        };
      },
    );
  });

  it('CLK-02 device clock jumps BACKWARD 1 day after launch: keeper goes blind (no rotation for >2h while the bearer dies at 1h), foreground does not refresh, refreshSessionNow() recovers', async () => {
    await runScenario(
      {
        id: 'CLK-02',
        failureClass: 'clock',
        suite: SUITE,
        title: 'backward jump of 24h between rotation and reschedule',
        seed: 82,
        inputs: { jumpMs: -DAY, bearerLifeMs: HOUR, fakeTimeMs: 2 * HOUR },
        files: [
          FILES.scheduleAhead,
          FILES.foreground,
          FILES.refreshNow,
          FILES.unauthorized,
        ],
      },
      async () => {
        const server = makeServer();
        const device = { skewMs: 0, base: SERVER_T0 };
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-0',
          bearerExpiresAtMs: null,
          onRotated: jest.fn(),
          onRevoked: jest.fn(),
          fetchFn: server.fetchFn,
          now: () => device.base + device.skewMs,
        });
        await advance(10_000, [server.state], device);
        expect(server.state.calls).toBe(1);
        // The launch rotation already scheduled its timer against the aligned
        // clock; the jump lands BEFORE that timer fires and the timer itself
        // is monotonic, so the first rotation still happens on time...
        device.skewMs = -DAY;
        await advance(HOUR, [server.state], device, 60_000);
        const afterFirstHour = server.state.calls;
        // ...but the reschedule after it is computed against the jumped
        // clock: delay = (serverNow+1h) − (deviceNow−1d) − 60s ≈ 1d+59min.
        await advance(2 * HOUR, [server.state], device, 60_000);
        const afterThreeHours = server.state.calls;
        expect(afterFirstHour).toBe(2);
        expect(afterThreeHours).toBe(2);
        // Foreground: expires − now ≈ 1 day ≫ FOREGROUND_LEAD → no refresh.
        foregroundHandler()('active');
        await jest.advanceTimersByTimeAsync(0);
        expect(server.state.calls).toBe(2);
        // Recovery path: an API route answering 401 → handleApiUnauthorized →
        // refreshSessionNow() (authStore.ts:512).
        refreshSessionNow();
        await jest.advanceTimersByTimeAsync(0);
        expect(server.state.calls).toBe(3);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `calls: launch=1, after 1h=${afterFirstHour}, after 3h=${afterThreeHours} (bearer dead for 2h, no rotation, foreground did nothing), refreshSessionNow → ${server.state.calls}.`,
          expected:
            'Bounded blind window; the first 401 on an API route triggers refreshSessionNow, so recoverable but every request in the window fails once first.',
        };
      },
    );
  });

  it('CLK-03 device clock jumps FORWARD 3h while suspended: the next foreground refreshes exactly once and reschedules normally', async () => {
    await runScenario(
      {
        id: 'CLK-03',
        failureClass: 'clock',
        suite: SUITE,
        title: 'forward jump past expiry, then foreground',
        seed: 83,
        inputs: { jumpMs: 3 * HOUR, bearerLifeMs: HOUR },
        files: [FILES.foreground],
      },
      async () => {
        const server = makeServer();
        const device = { skewMs: 0, base: SERVER_T0 };
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-0',
          bearerExpiresAtMs: SERVER_T0 + HOUR,
          onRotated: jest.fn(),
          onRevoked: jest.fn(),
          fetchFn: server.fetchFn,
          now: () => device.base + device.skewMs,
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(server.state.calls).toBe(0);
        // Suspended: timers do not fire; both clocks move 3h.
        device.base += 3 * HOUR;
        server.state.serverNow += 3 * HOUR;
        const handler = foregroundHandler();
        handler('active');
        handler('active');
        await jest.advanceTimersByTimeAsync(0);
        expect(server.state.calls).toBe(1);
        await advance(50 * 60_000, [server.state], device, 60_000);
        expect(server.state.calls).toBe(1);
        await advance(10 * 60_000, [server.state], device, 60_000);
        expect(server.state.calls).toBe(2);
        const invariants: Invariants = {
          noInfiniteSpinner: 'pass',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'foreground → 1 refresh (duplicate event collapsed by inflight guard); next rotation at +59min.',
          expected: 'One bounded refresh on foreground; normal cadence after.',
        };
      },
    );
  });

  it('CLK-04 backward jump of 30 days: the computed delay (~30d) exceeds the 32-bit timer range; under Node/WebIDL timer semantics (mirrored by Jest fake timers) setTimeout clamps it to 1ms → a 1ms refresh storm', async () => {
    await runScenario(
      {
        id: 'CLK-04',
        failureClass: 'clock',
        suite: SUITE,
        title: 'delay > 2^31-1 ms handed to setTimeout',
        seed: 84,
        inputs: { jumpMs: -30 * DAY, bearerLifeMs: HOUR, fakeTimeMs: 2_000 },
        files: [FILES.schedule, FILES.scheduleAhead],
      },
      async () => {
        const server = makeServer();
        const device = { skewMs: -30 * DAY, base: SERVER_T0 };
        const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
        startSessionKeeper({
          apiBaseUrl: API,
          refreshToken: 'rt-0',
          bearerExpiresAtMs: null,
          onRotated: jest.fn(),
          onRevoked: jest.fn(),
          fetchFn: server.fetchFn,
          now: () => device.base + device.skewMs,
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(server.state.calls).toBe(1);
        const delays = setTimeoutSpy.mock.calls
          .map(([, delay]) => Number(delay))
          .filter(d => Number.isFinite(d) && d > 0);
        const maxDelay = Math.max(...delays);
        setTimeoutSpy.mockRestore();
        expect(maxDelay).toBeGreaterThan(2 ** 31 - 1);
        // @sinonjs/fake-timers (Jest modern timers) mirrors Node/WebIDL:
        // `timer.delay > 2^31-1 ? 1 : delay` — so this is what Node does.
        await advance(2_000, [server.state], device, 100);
        expect(server.state.calls).toBeGreaterThan(500);
        const invariants: Invariants = {
          noInfiniteSpinner: 'fail',
          noSilentFailure: 'fail',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: 'degraded',
          observed: `setTimeout received delay=${maxDelay}ms (> 2147483647) → clamped to 1ms by Node/WebIDL timer semantics → ${server.state.calls} refreshes in 2s of fake time. Whether RN's JSTimers/RCTTiming (double-precision native timers) clamps the same way is Apple-runtime truth: UNKNOWN from Linux.`,
          expected:
            'Delay clamped to a sane upper bound (e.g. the server-reported lifetime) before setTimeout.',
        };
      },
    );
  });

  it('CLK-05 notification planner across clock jumps (×64 seeded nowMs incl. far past/future, DST edges): every timestamp strictly in the future, never throws', async () => {
    const prefs = {
      ...DEFAULT_NOTIFICATION_PREFS,
      enabled: true,
      practiceReminder: true,
      streakDefense: true,
      weeklyRecap: true,
      comeback: true,
    };
    const rng = seededRng(85);
    const nows: number[] = [
      SERVER_T0,
      SERVER_T0 - 365 * DAY,
      SERVER_T0 + 365 * DAY,
      Date.UTC(2000, 0, 1, 0, 0, 0),
      Date.UTC(2099, 11, 31, 23, 59, 0),
      Date.UTC(2026, 2, 8, 9, 30, 0), // US DST spring-forward day
      Date.UTC(2026, 10, 1, 8, 30, 0), // US DST fall-back day
      0,
    ];
    while (nows.length < 64) {
      nows.push(SERVER_T0 + Math.floor((rng() - 0.5) * 4 * 365 * DAY));
    }
    await runScenario(
      {
        id: 'CLK-05',
        failureClass: 'clock',
        suite: SUITE,
        title: 'buildNotificationPlan over 64 nowMs values',
        seed: 85,
        inputs: { count: nows.length, sample: nows.slice(0, 8) },
        files: [FILES.planner],
      },
      () => {
        let planned = 0;
        for (const nowMs of nows) {
          for (const practicedToday of [false, true]) {
            const plan = buildNotificationPlan(prefs, {
              nowMs,
              streakDays: 3,
              practicedToday,
              hasAnyHistory: true,
              shieldsAvailable: 1,
              milestoneEve: null,
            });
            for (const item of plan) {
              expect(Number.isFinite(item.timestampMs)).toBe(true);
              expect(item.timestampMs).toBeGreaterThan(nowMs);
              planned += 1;
            }
          }
        }
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `${planned} planned notifications across ${nows.length * 2} contexts, all strictly future.`,
          expected: 'Planner is pure in nowMs; never schedules in the past.',
        };
      },
    );
  });

  it('CLK-06 consistency engine with asOf BEHIND the newest activity (backward jump) and asOf FAR AHEAD (forward jump): future rows skipped, streak honest, invalid asOf falls back, no throw', async () => {
    const activities: TrainingActivityInput[] = [0, 1, 2].map(daysAgo => ({
      kind: 'stroke',
      atIso: new Date(SERVER_T0 - daysAgo * DAY).toISOString(),
      shotType: 'forehand_drive',
      overallScore: 6.5,
      resultKind: 'scored',
    }));
    await runScenario(
      {
        id: 'CLK-06',
        failureClass: 'clock',
        suite: SUITE,
        title: 'buildConsistencySnapshot under asOf jumps',
        seed: 86,
        inputs: { activities: 3, jumps: ['-2d', '+30d', 'invalid', '0'] },
        files: [FILES.engineAsOf],
      },
      () => {
        const tz = 'America/Los_Angeles';
        const aligned = buildConsistencySnapshot(activities, {
          asOfIso: new Date(SERVER_T0).toISOString(),
          timeZone: tz,
        });
        const backward = buildConsistencySnapshot(activities, {
          asOfIso: new Date(SERVER_T0 - 2 * DAY).toISOString(),
          timeZone: tz,
        });
        const forward = buildConsistencySnapshot(activities, {
          asOfIso: new Date(SERVER_T0 + 30 * DAY).toISOString(),
          timeZone: tz,
        });
        jest.setSystemTime(SERVER_T0);
        const invalid = buildConsistencySnapshot(activities, {
          asOfIso: 'not-a-date',
          timeZone: tz,
        });
        expect(aligned.currentStreak).toBe(3);
        expect(backward.totalActivities).toBe(1);
        expect(backward.currentStreak).toBe(1);
        expect(forward.currentStreak).toBe(0);
        expect(forward.totalActivities).toBe(3);
        expect(invalid.totalActivities).toBe(3);
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed: `aligned streak=${aligned.currentStreak}; backward(-2d) total=${backward.totalActivities} streak=${backward.currentStreak}; forward(+30d) streak=${forward.currentStreak} total=${forward.totalActivities}; invalid asOf → total=${invalid.totalActivities}.`,
          expected:
            'Future-dated rows excluded; streak reflects the asOf day; no throw.',
        };
      },
    );
  });

  it('CLK-07 try-again handoff TTL under Date.now jumps: backward jump keeps it alive (age negative), forward jump expires it, never throws', async () => {
    await runScenario(
      {
        id: 'CLK-07',
        failureClass: 'clock',
        suite: SUITE,
        title: 'tryAgainHandoff TTL with setSystemTime jumps',
        seed: 87,
        inputs: { ttlMs: TRY_AGAIN_HANDOFF_TTL_MS, jumps: ['-1d', '+31s'] },
        files: [FILES.handoffTtl],
      },
      () => {
        const handoff = {
          source: 'camera' as const,
          declaredStroke: 'forehand_drive' as const,
          declaredCanonical: null,
          auto: false,
          sessionId: null,
        };
        jest.setSystemTime(SERVER_T0);
        armTryAgain(handoff);
        jest.setSystemTime(SERVER_T0 - DAY);
        const afterBackward = consumeTryAgainHandoff();
        expect(afterBackward).toEqual(handoff);
        jest.setSystemTime(SERVER_T0);
        armTryAgain(handoff);
        jest.setSystemTime(SERVER_T0 + TRY_AGAIN_HANDOFF_TTL_MS + 1_000);
        const afterForward = consumeTryAgainHandoff();
        expect(afterForward).toBeNull();
        const invariants: Invariants = {
          noInfiniteSpinner: 'n/a',
          noSilentFailure: 'pass',
          noStoreCrash: 'pass',
        };
        return {
          invariants,
          verdict: verdictFor(invariants),
          observed:
            'backward jump → handoff still consumed (age < 0 < TTL); forward jump +31s → null.',
          expected:
            'Wall-clock TTL; a backward jump extends the window but the handoff is single-shot so it cannot leak into a later capture.',
        };
      },
    );
  });

  it('CLK-08 seeded sweep ×32: random device skew in [−20d, +20d] vs server (10-min bearers, 30 min fake time); classifies each run as storm / blind / normal', async () => {
    const matrix: Record<string, string> = {};
    let storms = 0;
    let blind = 0;
    const LIFE = 10 * 60_000;
    const WINDOW = 30 * 60_000;
    for (let seed = 800; seed < 832; seed += 1) {
      const rng = seededRng(seed);
      const skewMs = Math.round((rng() - 0.5) * 40 * DAY);
      await runScenario(
        {
          id: `CLK-08/${seed}`,
          failureClass: 'clock',
          suite: SUITE,
          title: 'random device/server skew',
          seed,
          inputs: { skewMs, bearerLifeMs: LIFE, fakeTimeMs: WINDOW },
          files: [FILES.scheduleAhead, FILES.minDelay],
        },
        async () => {
          stopSessionKeeper();
          const server = makeServer(LIFE);
          const device = { skewMs, base: SERVER_T0 };
          const onRevoked = jest.fn();
          startSessionKeeper({
            apiBaseUrl: API,
            refreshToken: 'rt-0',
            bearerExpiresAtMs: null,
            onRotated: jest.fn(),
            onRevoked,
            fetchFn: server.fetchFn,
            now: () => device.base + device.skewMs,
          });
          await advance(WINDOW, [server.state], device, 30_000);
          stopSessionKeeper();
          expect(onRevoked).not.toHaveBeenCalled();
          const calls = server.state.calls;
          // normal: launch + one per 9 min → 4; storm: ≈1/s → 1800
          const cls = calls > 10 ? 'storm' : calls <= 1 ? 'blind' : 'normal';
          if (cls === 'storm') storms += 1;
          if (cls === 'blind') blind += 1;
          matrix[String(seed)] = `${cls}:${calls}`;
          const invariants: Invariants = {
            noInfiniteSpinner: cls === 'storm' ? 'fail' : 'pass',
            noSilentFailure: cls === 'normal' ? 'pass' : 'fail',
            noStoreCrash: 'pass',
          };
          return {
            invariants,
            verdict: cls === 'normal' ? 'safe' : 'degraded',
            observed: `skew=${(skewMs / HOUR).toFixed(1)}h → ${calls} refreshes in 30min → ${cls}`,
            expected: 'normal (4 refreshes) regardless of skew.',
          };
        },
      );
      // Ahead by more than (life − lead) storms; behind by more than the
      // window goes blind after the launch rotation.
      const cls = matrix[String(seed)]!.split(':')[0];
      if (skewMs > LIFE) expect(cls).toBe('storm');
      if (skewMs < -WINDOW) expect(cls).toBe('blind');
      if (Math.abs(skewMs) < 60_000) expect(cls).toBe('normal');
    }
    expect(storms).toBeGreaterThan(0);
    expect(blind).toBeGreaterThan(0);
  }, 180_000);
});
