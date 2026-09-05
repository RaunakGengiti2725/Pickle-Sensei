/**
 * Seeded campaigns for the two remaining concurrency surfaces of the unit:
 *
 * 1. deviceContext — `getAccountBootstrapEnvironment` is synchronous, but it
 *    reads three independent OS sources (Intl, Platform.OS, Platform.constants)
 *    that can change between calls (locale/timezone change, an OS update
 *    landing mid-session). A burst of calls interleaved with seeded mutations
 *    of those sources must return snapshots that are each internally
 *    consistent with the source state at the instant of the call (no torn
 *    reads, no caching of a previous device state, no shared mutable output).
 *
 * 2. Clock skew — the deletion and consent clients enforce a 15 s deadline.
 *    The wall clock (`Date.now()`) is jumped by up to ±1 h while requests are
 *    in flight; the deadline must fire on the timer wheel exactly 15 s after
 *    issue regardless, and every outcome must be identical to the un-skewed
 *    run of the same seed.
 *
 * Scale: STRESS_ITER (default 40 per campaign); replay: STRESS_SEED=<seed>.
 */
import { Platform } from 'react-native';
import type { ApiSession } from '../../../src/account/apiSession';
import {
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../../src/account/deletion';
import {
  fetchConsentStatus,
  grantModelTrainingConsent,
} from '../../../src/account/consentApi';
import { getAccountBootstrapEnvironment } from '../../../src/account/deviceContext';
import type { RuntimePublicConfig } from '../../../src/config/runtimeConfig';
import {
  CLIENT_DEADLINE_MS,
  ScheduledTransport,
  campaignSeeds,
  chance,
  drain,
  errorMessage,
  pick,
  planReply,
  randomInt,
  runIteration,
  track,
  type ReplyPlan,
  type Rng,
} from '../../../testing/stress/concurrency';

const SUITE = 'deviceContextAndClockSkew';

/* ---------------------------- deviceContext ----------------------------- */

interface DeviceSource {
  locale: string;
  timeZone: string;
  os: 'ios' | 'android' | 'web';
  constants: Record<string, string | undefined>;
  version: string | number;
}

const LOCALES = ['en-US', 'en-GB', 'es-MX', 'ja-JP', '  fr-CA  ', ''];
const ZONES = [
  'America/Los_Angeles',
  'Europe/Berlin',
  'Asia/Tokyo',
  ' UTC ',
  '',
];

function randomSource(rng: Rng): DeviceSource {
  const os = pick(rng, ['ios', 'ios', 'ios', 'android', 'web'] as const);
  const constants: Record<string, string | undefined> =
    os === 'android'
      ? {
          Manufacturer: pick(rng, ['Google', ' Samsung ', undefined]),
          Model: pick(rng, ['Pixel 8', 'SM-S928B', undefined]),
          Release: pick(rng, ['14', ' 15 ', '', undefined]),
        }
      : {
          osVersion: pick(rng, ['17.5', '18.0', '18.1']),
          systemName: pick(rng, ['iOS', 'iPadOS']),
          interfaceIdiom: pick(rng, ['phone', 'pad']),
        };
  return {
    locale: pick(rng, LOCALES),
    timeZone: pick(rng, ZONES),
    os,
    constants,
    version:
      os === 'android' ? randomInt(rng, 30, 35) : pick(rng, ['17.5', '18.0']),
  };
}

function expectedFor(source: DeviceSource, config: RuntimePublicConfig) {
  const locale = source.locale.trim();
  const timezone = source.timeZone.trim();
  if (!locale || !timezone) {
    return {
      error:
        'This device did not provide a locale and timezone for account setup.',
    };
  }
  if (source.os === 'android') {
    return {
      value: {
        locale,
        timezone,
        device: {
          platform: 'android',
          osVersion:
            source.constants['Release']?.trim() || String(source.version),
          appVersion: config.appVersion,
          model: [
            source.constants['Manufacturer']?.trim(),
            source.constants['Model']?.trim(),
          ]
            .filter(Boolean)
            .join(' '),
        },
      },
    };
  }
  if (source.os === 'ios') {
    return {
      value: {
        locale,
        timezone,
        device: {
          platform: 'ios',
          osVersion: source.constants['osVersion'],
          appVersion: config.appVersion,
          model: [
            source.constants['systemName'],
            source.constants['interfaceIdiom'],
          ]
            .filter(Boolean)
            .join(' '),
        },
      },
    };
  }
  return { error: `Unsupported account platform: ${source.os}` };
}

const CONFIG: RuntimePublicConfig = {
  appVersion: '9.9.9-stress',
} as RuntimePublicConfig;

describe('deviceContext — bursts against mutating OS sources', () => {
  const originalResolved = Intl.DateTimeFormat.prototype.resolvedOptions;
  const platformDescriptors = {
    OS: Object.getOwnPropertyDescriptor(Platform, 'OS'),
    Version: Object.getOwnPropertyDescriptor(Platform, 'Version'),
    constants: Object.getOwnPropertyDescriptor(Platform, 'constants'),
  };
  let source: DeviceSource = randomSource(() => 0);

  beforeAll(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
      return {
        ...originalResolved.call(this),
        locale: source.locale,
        timeZone: source.timeZone,
      };
    };
    Object.defineProperty(Platform, 'OS', {
      get: () => source.os,
      configurable: true,
    });
    Object.defineProperty(Platform, 'Version', {
      get: () => source.version,
      configurable: true,
    });
    Object.defineProperty(Platform, 'constants', {
      get: () => source.constants,
      configurable: true,
    });
  });
  afterAll(() => {
    Intl.DateTimeFormat.prototype.resolvedOptions = originalResolved;
    for (const [key, descriptor] of Object.entries(platformDescriptors)) {
      if (descriptor) Object.defineProperty(Platform, key, descriptor);
    }
  });

  const seeds = campaignSeeds(`${SUITE}/device`, 40);
  const totals = { calls: 0, mutations: 0, errors: 0 };

  it.each(seeds)(
    'seed %i: every snapshot matches the source at call time',
    async seed => {
      await runIteration(SUITE, 'device', seed, async rng => {
        const steps = randomInt(rng, 5, 40);
        const results: Array<{
          expected: ReturnType<typeof expectedFor>;
          actual: { value?: unknown; error?: string };
        }> = [];
        let mutations = 0;
        source = randomSource(rng);
        for (let i = 0; i < steps; i += 1) {
          if (chance(rng, 0.4)) {
            source = randomSource(rng);
            mutations += 1;
          }
          // Burst: several synchronous calls between two source mutations
          // must all see the same source; a microtask boundary between them
          // (as when several bootstrap paths race) must not change that.
          const burst = randomInt(rng, 1, 4);
          const snapshot = source;
          const promises: Array<Promise<{ value?: unknown; error?: string }>> =
            [];
          for (let b = 0; b < burst; b += 1) {
            promises.push(
              Promise.resolve().then(() => {
                try {
                  return { value: getAccountBootstrapEnvironment(CONFIG) };
                } catch (error) {
                  return { error: errorMessage(error) };
                }
              }),
            );
          }
          const actuals = await Promise.all(promises);
          for (const actual of actuals) {
            results.push({ expected: expectedFor(snapshot, CONFIG), actual });
          }
        }
        return {
          plan: { steps },
          observed: {
            calls: results.length,
            mutations,
            errors: results.filter(r => r.actual.error !== undefined).length,
          },
          check: () => {
            totals.calls += results.length;
            totals.mutations += mutations;
            totals.errors += results.filter(
              r => r.actual.error !== undefined,
            ).length;
            for (const { expected, actual } of results) {
              if ('error' in expected) {
                expect(actual).toEqual({ error: expected.error });
              } else {
                expect(actual).toEqual({ value: expected.value });
              }
            }
            // Distinct calls never share an output object (no cached env).
            const values = results
              .map(r => r.actual.value)
              .filter((v): v is object => typeof v === 'object' && v !== null);
            expect(new Set(values).size).toBe(values.length);
          },
        };
      });
    },
  );

  it('records campaign totals', () => {
    expect(totals.calls).toBeGreaterThan(0);
    expect(totals.errors).toBeGreaterThan(0);
  });
});

/* ------------------------------ clock skew ------------------------------ */

const API = 'https://api.example.test/functions/v1/api';
const SESSION: ApiSession = {
  apiBaseUrl: API,
  bearerToken: 'bearer-skew',
  canonicalAppUserId: '33333333-3333-4333-8333-333333333333',
  provider: 'apple',
};

type SkewCall =
  'delete_request' | 'delete_confirm' | 'consent_status' | 'consent_grant';

interface SkewPlan {
  calls: Array<{ id: string; kind: SkewCall; reply: ReplyPlan }>;
  jumps: Array<{ atMs: number; deltaMs: number }>;
}

function okBody(kind: SkewCall): unknown {
  switch (kind) {
    case 'delete_request':
      return { challenge: 'c', expiresAt: '2026-09-05T03:00:00.000Z' };
    case 'delete_confirm':
      return { deleted: true, appleAuthorizationRevocation: 'revoked' };
    default:
      return {
        subjectPseudonym: null,
        scopes: [
          {
            scope: 'model_training',
            active: kind === 'consent_grant',
            consentVersion: null,
            lastAction: null,
            lastActionAt: null,
          },
        ],
      };
  }
}

function planSkew(rng: Rng): SkewPlan {
  const count = randomInt(rng, 2, 8);
  const calls: SkewPlan['calls'] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = pick<SkewCall>(rng, [
      'delete_request',
      'delete_confirm',
      'consent_status',
      'consent_grant',
    ]);
    calls.push({
      id: `s${i}`,
      kind,
      // Bias toward hangs/late replies so the deadline is what decides.
      reply: planReply(rng, () => okBody(kind), {
        hang: 35,
        late_ignores_abort: 15,
      }),
    });
  }
  const jumps: SkewPlan['jumps'] = [];
  const jumpCount = randomInt(rng, 1, 4);
  for (let i = 0; i < jumpCount; i += 1) {
    jumps.push({
      atMs: randomInt(rng, 1, CLIENT_DEADLINE_MS - 1),
      deltaMs: pick(
        rng,
        [-3_600_000, -900_000, -1_000, 1_000, 900_000, 3_600_000],
      ),
    });
  }
  return { calls, jumps };
}

interface SkewRun {
  outcomes: Array<{
    id: string;
    status: string;
    detail: string;
    settledMonoMs: number;
  }>;
  aborts: Array<{
    id: string;
    abortedMonoMs: number | null;
    issuedMonoMs: number;
  }>;
}

async function runSkew(plan: SkewPlan, applyJumps: boolean): Promise<SkewRun> {
  let mono = 0;
  const transport = new ScheduledTransport(() => mono);
  const settled: Array<
    Promise<{
      id: string;
      status: string;
      detail: string;
      settledMonoMs: number;
    }>
  > = [];
  for (const call of plan.calls) {
    const fetchFn = transport.fetchFor(call.id, () => call.reply);
    const promise: Promise<unknown> = (() => {
      switch (call.kind) {
        case 'delete_request':
          return requestAccountDeletion(SESSION, null, fetchFn);
        case 'delete_confirm':
          return confirmAccountDeletion(SESSION, 'c', fetchFn);
        case 'consent_status':
          return fetchConsentStatus(SESSION, fetchFn);
        case 'consent_grant':
          return grantModelTrainingConsent(SESSION, 'device', fetchFn);
      }
    })();
    settled.push(
      track(promise).then(result => ({
        id: call.id,
        status: result.status,
        detail:
          result.status === 'fulfilled'
            ? JSON.stringify(result.value)
            : errorMessage(result.reason),
        settledMonoMs: mono,
      })),
    );
  }
  const jumpTimers: ReturnType<typeof setTimeout>[] = [];
  if (applyJumps) {
    for (const jump of plan.jumps) {
      jumpTimers.push(
        setTimeout(
          () => jest.setSystemTime(Date.now() + jump.deltaMs),
          jump.atMs,
        ),
      );
    }
  }
  let done = false;
  const all = Promise.all(settled).then(r => {
    done = true;
    return r;
  });
  await drain(
    () => done,
    CLIENT_DEADLINE_MS + 6_000,
    50,
    e => {
      mono = e;
    },
  );
  expect(done).toBe(true);
  // Jumps scheduled after the last call settled are the harness's own timers.
  for (const timer of jumpTimers) clearTimeout(timer);
  const outcomes = await all;
  return {
    outcomes,
    aborts: transport.requests.map(r => ({
      id: r.callId,
      abortedMonoMs: r.abortedAtMs,
      issuedMonoMs: r.issuedAtMs,
    })),
  };
}

describe('deletion + consent deadlines under wall-clock skew', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-05T02:00:00.000Z') });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  const seeds = campaignSeeds(`${SUITE}/skew`, 40);
  const totals = { calls: 0, jumps: 0, hung: 0 };

  it.each(seeds)(
    'seed %i: outcomes and deadlines are identical with and without skew',
    async seed => {
      await runIteration(SUITE, 'skew', seed, async rng => {
        const plan = planSkew(rng);
        const baseline = await runSkew(plan, false);
        jest.setSystemTime(new Date('2026-09-05T02:00:00.000Z'));
        const skewed = await runSkew(plan, true);
        const hung = plan.calls.filter(c => c.reply.kind === 'hang').length;
        return {
          plan: plan as unknown as Record<string, unknown>,
          observed: {
            calls: plan.calls.length,
            jumps: plan.jumps.length,
            hung,
            timersLeft: jest.getTimerCount(),
          },
          check: () => {
            totals.calls += plan.calls.length;
            totals.jumps += plan.jumps.length;
            totals.hung += hung;
            expect(jest.getTimerCount()).toBe(0);
            expect(skewed.outcomes).toEqual(baseline.outcomes);
            expect(skewed.aborts).toEqual(baseline.aborts);
            for (const abort of skewed.aborts) {
              const call = plan.calls.find(c => c.id === abort.id);
              if (
                call?.reply.kind === 'hang' ||
                call?.reply.kind === 'late_ignores_abort'
              ) {
                expect(abort.abortedMonoMs).toBe(
                  abort.issuedMonoMs + CLIENT_DEADLINE_MS,
                );
              } else {
                expect(abort.abortedMonoMs).toBeNull();
              }
            }
          },
        };
      });
    },
  );

  it('records campaign totals', () => {
    expect(totals.hung).toBeGreaterThan(0);
    expect(totals.jumps).toBeGreaterThan(0);
  });
});
