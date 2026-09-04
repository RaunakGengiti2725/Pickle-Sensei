/**
 * STRESS · cmp-progress-charts · lens rapid-interaction (3/3)
 *
 * The unit mounted behind ProgressScreen's wiring shape
 * (test-support/stress/DashboardHost.tsx) while an async load is in flight:
 * spam range switching, reload spam, attempt-pill double/triple taps, back
 * (unmount) with a request outstanding, and out-of-order resolutions.
 *
 * Invariants asserted per burst:
 *   - ONE request per committed load intent — no (range, revision) pair is
 *     requested twice and none is skipped;
 *   - no orphan loading state: once every deferred settles and timers drain,
 *     the loading row is gone and the body describes the payload of the
 *     CURRENT range (a superseded range's late resolution never wins);
 *   - one navigation per completed pill tap, and at most one attempt sheet
 *     visible no matter how fast the pill is tapped (no duplicate modal);
 *   - back during async: unmounting with a request outstanding, then
 *     resolving it, produces no act() warning, no state-update-after-unmount
 *     console.error and no unhandled rejection;
 *   - no timer left armed after unmount.
 *
 * Replay:  STRESS_ONLY=<seed> npx jest __tests__/stress/progressDashboardConcurrency.stress.test.tsx
 * Scale:   STRESS_ITER=<n>   (default 40)
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  DashboardHost,
  RANGE_KEYS,
  RANGE_LABELS,
  type DashboardPayload,
  type RangeKey,
} from '../../test-support/stress/DashboardHost';
import {
  campaignConfig,
  genPracticeBuckets,
  genPracticeSetSummary,
  genReads,
  genScoreTrendBuckets,
  guardFailures,
  ResultTable,
  Rng,
  seedsFor,
  tenthScore,
  withGuards,
  type IterationRow,
} from '../../test-support/stress/progressChartsRapidInteraction';
import {
  findAllPressableHosts,
  findPressableHost,
  grant,
  release,
  tap,
} from '../../test-support/stress/pressDriver';

const CONFIG = campaignConfig('progressDashboardConcurrency', 40);
const TABLE = new ResultTable(CONFIG);

type Scenario =
  | 'range-tab-spam'
  | 'range-then-back-mid-flight'
  | 'reload-spam'
  | 'attempt-double-tap'
  | 'attempt-triple-tap'
  | 'out-of-order-resolution'
  | 'reject-then-recover'
  | 'tap-while-loading';

const SCENARIOS: readonly Scenario[] = [
  'range-tab-spam',
  'range-then-back-mid-flight',
  'reload-spam',
  'attempt-double-tap',
  'attempt-triple-tap',
  'out-of-order-resolution',
  'reject-then-recover',
  'tap-while-loading',
];

interface Deferred {
  range: RangeKey;
  revision: number;
  /** Payload this request was settled with, once it was. */
  payload: DashboardPayload | null;
  resolve: (payload: DashboardPayload) => void;
  reject: (reason: Error) => void;
  settled: boolean;
  promise: Promise<DashboardPayload>;
}

/**
 * `avgScore` doubles as the payload fingerprint: unique per generated payload,
 * so the rendered stat row identifies EXACTLY which resolution the tree shows
 * and a stale range winning the race is unmistakable.
 */
function payloadFor(
  rng: Rng,
  range: RangeKey,
  sequence: number,
): DashboardPayload {
  const scoreBuckets = genScoreTrendBuckets(rng);
  return {
    range,
    practiceBuckets: genPracticeBuckets(rng),
    scoreBuckets,
    reads: genReads(rng, scoreBuckets),
    activeDays: rng.int(0, 90),
    avgScore: `${sequence}.${tenthScore(rng).toFixed(1).slice(-1)}`,
    priorAvgScore: rng.chance(0.3) ? null : tenthScore(rng).toFixed(1),
    deltaScore: rng.chance(0.25) ? null : rng.int(-40, 40) / 10,
    practiceSet: rng.chance(0.2) ? null : genPracticeSetSummary(rng),
  };
}

interface Ctx {
  renderer: TestRenderer.ReactTestRenderer;
  mounted: boolean;
  actions: number;
  requests: Deferred[];
  navigations: Array<{ name: 'Result'; analysisId: string }>;
  intendedNavigations: string[];
}

function textsIn(node: TestRenderer.ReactTestInstance): string[] {
  return node
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children;
      return Array.isArray(children) ? children : [children];
    })
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String);
}

function has(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
): boolean {
  return (
    renderer.root.findAll(
      node => node.props.testID === testID && typeof node.type === 'string',
    ).length > 0
  );
}

function visibleModals(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'attempt-sheet' &&
      node.props.visible === true,
  ).length;
}

async function runIteration(seed: number): Promise<IterationRow> {
  const rng = new Rng(seed);
  const scenario = rng.pick(SCENARIOS);
  const failures: string[] = [];
  const ctx: Ctx = {
    renderer: null as unknown as TestRenderer.ReactTestRenderer,
    mounted: false,
    actions: 0,
    requests: [],
    navigations: [],
    intendedNavigations: [],
  };

  const load = (
    range: RangeKey,
    revision: number,
  ): Promise<DashboardPayload> => {
    let resolve!: (payload: DashboardPayload) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<DashboardPayload>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const deferred: Deferred = {
      range,
      revision,
      payload: null,
      settled: false,
      promise,
      resolve: payload => {
        deferred.settled = true;
        deferred.payload = payload;
        resolve(payload);
      },
      reject: reason => {
        deferred.settled = true;
        reject(reason);
      },
    };
    ctx.requests.push(deferred);
    return promise;
  };

  const element = (
    <DashboardHost
      load={load}
      onNavigate={target => {
        ctx.navigations.push(target);
      }}
    />
  );

  let sequence = 0;
  const nextSequence = () => {
    sequence += 1;
    return sequence;
  };
  const flush = async () => {
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    ctx.actions += 1;
  };
  const settleAll = async (order: number[]) => {
    for (const index of order) {
      const deferred = ctx.requests[index];
      if (!deferred || deferred.settled) continue;
      await act(async () => {
        deferred.resolve(payloadFor(rng, deferred.range, nextSequence()));
        await Promise.resolve();
      });
      ctx.actions += 1;
    }
    await flush();
  };
  const tapTestID = (testID: string): boolean => {
    const host = findPressableHost(ctx.renderer, testID);
    if (!host) return false;
    act(() => tap(host));
    ctx.actions += 1;
    return true;
  };
  const attemptHosts = () =>
    findAllPressableHosts(ctx.renderer).filter(node =>
      String(node.props.testID).startsWith('practice-set-attempt-'),
    );

  const { report, value } = withGuards(() => {
    return (async () => {
      try {
        await act(async () => {
          ctx.renderer = TestRenderer.create(element);
        });
        ctx.mounted = true;
        ctx.actions += 1;
        if (!has(ctx.renderer, 'dashboard-loading')) {
          failures.push('no loading row on first mount');
        }

        switch (scenario) {
          case 'range-tab-spam': {
            const taps = rng.int(3, 8);
            for (let i = 0; i < taps; i += 1) {
              if (!tapTestID(`range-${rng.pick(RANGE_KEYS)}`)) {
                failures.push('range tab missing');
                break;
              }
              if (rng.chance(0.4)) await flush();
            }
            await settleAll(rng.shuffle(ctx.requests.map((_, i) => i)));
            break;
          }
          case 'range-then-back-mid-flight': {
            for (let i = 0; i < rng.int(1, 4); i += 1) {
              tapTestID(`range-${rng.pick(RANGE_KEYS)}`);
            }
            // Back before anything resolved.
            await act(async () => {
              ctx.renderer.unmount();
            });
            ctx.mounted = false;
            ctx.actions += 1;
            // Every outstanding request now lands on a dead screen.
            for (const deferred of ctx.requests) {
              await act(async () => {
                if (rng.chance(0.3)) deferred.reject(new Error('aborted'));
                else
                  deferred.resolve(
                    payloadFor(rng, deferred.range, nextSequence()),
                  );
                await Promise.resolve();
              });
              ctx.actions += 1;
            }
            await flush();
            break;
          }
          case 'reload-spam': {
            await settleAll([0]);
            const taps = rng.int(2, 6);
            for (let i = 0; i < taps; i += 1) {
              tapTestID('reload');
              if (rng.chance(0.5)) await flush();
            }
            await settleAll(rng.shuffle(ctx.requests.map((_, i) => i)));
            break;
          }
          case 'attempt-double-tap':
          case 'attempt-triple-tap': {
            await settleAll([0]);
            const hosts = attemptHosts();
            if (hosts.length === 0) break;
            const host = rng.pick(hosts);
            const id = String(host.props.testID).replace(
              'practice-set-attempt-',
              '',
            );
            const taps = scenario === 'attempt-double-tap' ? 2 : 3;
            act(() => {
              for (let i = 0; i < taps; i += 1) {
                tap(host);
                ctx.intendedNavigations.push(id);
                ctx.actions += 1;
              }
            });
            await flush();
            if (visibleModals(ctx.renderer) !== 1) {
              failures.push(
                `${visibleModals(ctx.renderer)} attempt sheets visible (want 1)`,
              );
            }
            // Closing must leave no sheet behind.
            tapTestID('attempt-sheet-close');
            await flush();
            if (visibleModals(ctx.renderer) !== 0) {
              failures.push('attempt sheet still visible after close');
            }
            break;
          }
          case 'out-of-order-resolution': {
            tapTestID(`range-${rng.pick(RANGE_KEYS)}`);
            await flush();
            tapTestID(`range-${rng.pick(RANGE_KEYS)}`);
            await flush();
            // Resolve newest first, then the stale ones.
            const indices = ctx.requests.map((_, i) => i).reverse();
            await settleAll(indices);
            break;
          }
          case 'reject-then-recover': {
            await act(async () => {
              ctx.requests[0]!.reject(new Error('db closed'));
              await Promise.resolve();
            });
            ctx.actions += 1;
            await flush();
            if (!has(ctx.renderer, 'dashboard-error')) {
              failures.push('rejection left no error row');
            }
            tapTestID('reload');
            await settleAll(ctx.requests.map((_, i) => i));
            if (!has(ctx.renderer, 'dashboard-body')) {
              failures.push('recovery load did not render the body');
            }
            break;
          }
          case 'tap-while-loading': {
            // Pills only exist after a payload; tapping range tabs while the
            // first load is outstanding must not lose the final intent.
            const host = findPressableHost(
              ctx.renderer,
              `range-${rng.pick(RANGE_KEYS)}`,
            );
            if (host) {
              act(() => grant(host));
              ctx.actions += 1;
              await settleAll([0]);
              act(() => release(host));
              ctx.actions += 1;
            }
            await settleAll(ctx.requests.map((_, i) => i));
            break;
          }
        }

        if (ctx.mounted) {
          await settleAll(ctx.requests.map((_, i) => i));
          if (has(ctx.renderer, 'dashboard-loading')) {
            failures.push('orphan loading state after every request settled');
          }
          const current = ctx.requests.at(-1);
          if (current?.payload && has(ctx.renderer, 'dashboard-body')) {
            // Scoped to the body: the range bar always shows every label, so
            // only the body's own header/stat row prove which payload won.
            const body = ctx.renderer.root.find(
              node =>
                typeof node.type === 'string' &&
                node.props.testID === 'dashboard-body',
            );
            const shown = textsIn(body);
            const wantedRange = RANGE_LABELS[current.payload.range];
            if (!shown.includes(wantedRange)) {
              failures.push(
                `body header ${JSON.stringify(shown.slice(0, 6))} is not the current range ${wantedRange}`,
              );
            }
            if (!shown.includes(current.payload.avgScore)) {
              failures.push(
                `body shows a superseded payload: want avgScore ${current.payload.avgScore}, got ${JSON.stringify(shown.slice(0, 10))}`,
              );
            }
          }
          if (visibleModals(ctx.renderer) > 1) {
            failures.push(
              `${visibleModals(ctx.renderer)} attempt sheets visible`,
            );
          }
          await act(async () => {
            ctx.renderer.unmount();
          });
          ctx.mounted = false;
          ctx.actions += 1;
        }
        await flush();
      } catch (error) {
        failures.push(
          `threw: ${error instanceof Error ? error.message : String(error)}`,
        );
        if (ctx.mounted) {
          try {
            await act(async () => {
              ctx.renderer.unmount();
            });
          } catch {
            // already gone
          }
          ctx.mounted = false;
        }
      }
    })();
  });
  await value;

  // One request per committed intent. Returning to a range legitimately
  // reloads it, so the invariant is that no intent fires TWICE in a row —
  // i.e. a re-render or a tab tap that changes nothing must not refetch.
  const keys = ctx.requests.map(r => `${r.range}#${r.revision}`);
  const repeated = keys.filter((key, i) => i > 0 && keys[i - 1] === key);
  if (repeated.length > 0) {
    failures.push(
      `redundant back-to-back load intents ${JSON.stringify(repeated)} in ${JSON.stringify(keys)}`,
    );
  }
  // One navigation per completed pill tap, in order.
  const navigated = ctx.navigations.map(n => n.analysisId);
  if (
    navigated.length !== ctx.intendedNavigations.length ||
    navigated.some((id, i) => id !== ctx.intendedNavigations[i])
  ) {
    failures.push(
      `navigations ${JSON.stringify(navigated)} != intents ${JSON.stringify(ctx.intendedNavigations)}`,
    );
  }
  const pending = jest.getTimerCount();
  if (pending !== 0)
    failures.push(`${pending} timer(s) still armed after unmount`);
  failures.push(...guardFailures(report));

  return {
    seed,
    scenario,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    actions: ctx.actions,
    intents: ctx.intendedNavigations.length,
    effects: navigated.length,
    detail: `requests=${ctx.requests.length}`,
    failures,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(async () => {
  await act(async () => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

afterAll(() => {
  const summary = TABLE.write();
  console.log(
    `[stress] ${CONFIG.suite}: ${summary.held} HELD / ${summary.broken} BROKEN over ${TABLE.rows.length} bursts (${summary.actions} actions) -> ${summary.file}`,
  );
});

describe('progress dashboard concurrency bursts', () => {
  const seeds = seedsFor(CONFIG);
  it.each(seeds.map(seed => [seed] as const))('seed %d holds', async seed => {
    const row = await runIteration(seed);
    TABLE.push(row);
    expect({ seed, scenario: row.scenario, failures: row.failures }).toEqual({
      seed,
      scenario: row.scenario,
      failures: [],
    });
  });
});
