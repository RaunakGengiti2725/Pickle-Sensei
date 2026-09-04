/**
 * STRESS · cmp-progress-charts · lens rapid-interaction (1/3)
 *
 * PracticeSetCard attempt pills under rapid / concurrent touch. Every burst
 * is scripted from a seed and drives the REAL `Pressable` responder handlers
 * (test-support/stress/pressDriver.ts) under fake timers, so Pressability's
 * long-press / min-press-duration timers, PressableScale's scale animation
 * and React's batching are all in play.
 *
 * Invariants asserted per burst:
 *   - one `onOpenAttempt` call per completed tap, with the id of the pill
 *     that was under the finger at grant time — never more, never fewer;
 *   - a touch that slides off the pill, is terminated, or lands on a
 *     handler-less card fires nothing;
 *   - after a handler swap, no stale handler is ever invoked;
 *   - no act() warning, console.error/warn, or unhandled rejection;
 *   - once the card unmounts NO timer is left armed (no orphan press-out /
 *     long-press / animation work).
 *
 * Replay:  STRESS_ONLY=<seed> npx jest __tests__/stress/practiceSetCardRapidTaps.stress.test.tsx
 * Scale:   STRESS_ITER=<n>   (default 40)
 */
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PracticeSetCard } from '../../src/progress/PracticeSetCard';
import type { PracticeSetSummary } from '../../src/progress/practiceSetProgress';
import {
  campaignConfig,
  genPracticeSetSummary,
  guardFailures,
  mutateSummary,
  ResultTable,
  Rng,
  seedsFor,
  withGuards,
  type IterationRow,
} from '../../test-support/stress/progressChartsRapidInteraction';
import {
  click,
  findAllPressableHosts,
  findPressableHost,
  grant,
  move,
  OFF_TARGET,
  release,
  responderEvent,
  tap,
  terminate,
  type FakeResponderEvent,
} from '../../test-support/stress/pressDriver';

const CONFIG = campaignConfig('practiceSetCardRapidTaps', 40);
const TABLE = new ResultTable(CONFIG);

type Scenario =
  | 'double-tap'
  | 'triple-tap'
  | 'simultaneous-pills'
  | 'tap-during-rerender'
  | 'finger-down-across-rerender'
  | 'handler-swap-mid-burst'
  | 'handler-removed-mid-burst'
  | 'slide-off-and-terminate'
  | 'unmount-mid-press'
  | 'reduced-motion-flip-mid-press'
  | 'a11y-click-storm'
  | 'compact-toggle-storm';

const SCENARIOS: readonly Scenario[] = [
  'double-tap',
  'triple-tap',
  'simultaneous-pills',
  'tap-during-rerender',
  'finger-down-across-rerender',
  'handler-swap-mid-burst',
  'handler-removed-mid-burst',
  'slide-off-and-terminate',
  'unmount-mid-press',
  'reduced-motion-flip-mid-press',
  'a11y-click-storm',
  'compact-toggle-storm',
];

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  summary: PracticeSetSummary;
  handler: jest.Mock<void, [string]> | undefined;
  compact: boolean;
  /** Every (handler, id) the script INTENDED to fire, in order. */
  intended: Array<{ handler: jest.Mock<void, [string]>; id: string }>;
  actions: number;
  mounted: boolean;
}

function render(h: Harness): void {
  const element = (
    <PracticeSetCard
      summary={h.summary}
      onOpenAttempt={h.handler}
      compact={h.compact}
    />
  );
  act(() => {
    if (h.mounted) h.renderer.update(element);
    else h.renderer = TestRenderer.create(element);
  });
  h.mounted = true;
  h.actions += 1;
}

function unmount(h: Harness): void {
  act(() => {
    h.renderer.unmount();
  });
  h.mounted = false;
  h.actions += 1;
}

function pillHost(h: Harness, id: string) {
  return findPressableHost(h.renderer, `practice-set-attempt-${id}`);
}

function flushTimers(h: Harness, ms?: number): void {
  act(() => {
    if (ms === undefined) jest.runOnlyPendingTimers();
    else jest.advanceTimersByTime(ms);
  });
  h.actions += 1;
}

function reducedMotionListener(): ((value: boolean) => void) | null {
  const calls = (AccessibilityInfo.addEventListener as unknown as jest.Mock)
    .mock.calls as Array<[string, (value: boolean) => void]>;
  const call = calls.find(c => c[0] === 'reduceMotionChanged');
  return call ? call[1] : null;
}

function structuralFailures(h: Harness): string[] {
  if (!h.mounted) return [];
  const failures: string[] = [];
  const hosts = findAllPressableHosts(h.renderer);
  const ids = hosts.map(n => String(n.props.testID));
  if (h.handler) {
    if (hosts.length !== h.summary.attempts.length) {
      failures.push(
        `pressable count ${hosts.length} != attempts ${h.summary.attempts.length}`,
      );
    }
    if (new Set(ids).size !== ids.length)
      failures.push(`duplicate pill testIDs: ${ids}`);
    for (const a of h.summary.attempts) {
      if (!ids.includes(`practice-set-attempt-${a.id}`))
        failures.push(`missing pill for ${a.id}`);
    }
  } else if (hosts.length !== 0) {
    failures.push(`handler-less card still has ${hosts.length} pressables`);
  }
  return failures;
}

function runScenario(rng: Rng, scenario: Scenario, h: Harness): void {
  const ids = () => h.summary.attempts.map(a => a.id);
  const intend = (id: string) => {
    if (h.handler) h.intended.push({ handler: h.handler, id });
  };
  const tapPill = (id: string) => {
    const host = pillHost(h, id);
    if (!host) throw new Error(`no pill host for ${id}`);
    act(() => tap(host));
    h.actions += 1;
    intend(id);
  };

  switch (scenario) {
    case 'double-tap':
    case 'triple-tap': {
      const id = rng.pick(ids());
      const taps = scenario === 'double-tap' ? 2 : 3;
      const host = pillHost(h, id)!;
      // All taps land inside ONE act: React batches, Pressability does not.
      act(() => {
        for (let i = 0; i < taps; i += 1) {
          tap(host);
          intend(id);
          h.actions += 1;
        }
      });
      if (rng.chance(0.5)) flushTimers(h, rng.int(1, 129));
      flushTimers(h);
      break;
    }
    case 'simultaneous-pills': {
      const chosen = rng
        .shuffle(ids())
        .slice(0, rng.int(2, Math.min(4, ids().length)));
      const hosts = chosen.map(id => pillHost(h, id)!);
      act(() => {
        // Two fingers down at once, then lifted in seeded order.
        hosts.forEach((host, i) =>
          grant(host, { pageX: 110 + i * 60, pageY: 420 }),
        );
        const order = rng.shuffle(hosts.map((_, i) => i));
        for (const i of order) {
          release(hosts[i]!, { pageX: 110 + i * 60, pageY: 420 });
          intend(chosen[i]!);
          h.actions += 1;
        }
      });
      flushTimers(h);
      break;
    }
    case 'tap-during-rerender': {
      // Tap, rerender with mutated data in the SAME act, tap the fresh tree.
      const before = rng.pick(ids());
      const hostBefore = pillHost(h, before)!;
      act(() => {
        tap(hostBefore);
        intend(before);
        h.actions += 1;
        h.summary = mutateSummary(rng, h.summary);
        h.renderer.update(
          <PracticeSetCard
            summary={h.summary}
            onOpenAttempt={h.handler}
            compact={h.compact}
          />,
        );
        h.actions += 1;
      });
      const after = rng.pick(ids());
      tapPill(after);
      flushTimers(h);
      break;
    }
    case 'finger-down-across-rerender': {
      // Finger goes down on a pill, the set updates underneath it (the pill
      // keeps its key), the finger lifts: exactly one press for that pill.
      const id = rng.pick(ids());
      const host = pillHost(h, id)!;
      act(() => grant(host));
      h.actions += 1;
      flushTimers(h, rng.int(0, 120));
      const mutated = mutateSummary(rng, h.summary);
      const survives = mutated.attempts.some(a => a.id === id);
      h.summary = mutated;
      render(h);
      const hostAfter = pillHost(h, id) ?? host;
      act(() => release(hostAfter));
      h.actions += 1;
      // Pressability is per Pressable instance: if the pill survived, the
      // release completes a press; if it was removed, the instance is gone
      // and the stale release fires on a reset pressability -> nothing.
      if (survives) intend(id);
      flushTimers(h);
      break;
    }
    case 'handler-swap-mid-burst': {
      const first = rng.pick(ids());
      tapPill(first);
      const oldHandler = h.handler;
      h.handler = jest.fn<void, [string]>();
      render(h);
      const second = rng.pick(ids());
      tapPill(second);
      if (rng.chance(0.5)) tapPill(rng.pick(ids()));
      flushTimers(h);
      if (oldHandler && oldHandler.mock.calls.length !== 1) {
        throw new Error(
          `stale handler received ${oldHandler.mock.calls.length} calls (want 1)`,
        );
      }
      break;
    }
    case 'handler-removed-mid-burst': {
      tapPill(rng.pick(ids()));
      const removed = h.handler;
      h.handler = undefined;
      render(h);
      // No pressables should remain; any leftover host would be a bug.
      const leftovers = findAllPressableHosts(h.renderer);
      if (leftovers.length > 0) {
        act(() => leftovers.forEach(host => tap(host)));
        h.actions += leftovers.length;
      }
      flushTimers(h);
      h.handler = removed;
      render(h);
      tapPill(rng.pick(ids()));
      flushTimers(h);
      break;
    }
    case 'slide-off-and-terminate': {
      const id = rng.pick(ids());
      const host = pillHost(h, id)!;
      // Slide off: down, move outside the pill, up -> no press.
      act(() => {
        grant(host);
        move(host, OFF_TARGET);
        release(host, OFF_TARGET);
      });
      h.actions += 3;
      // Terminate: the scroll view steals the responder -> no press.
      act(() => {
        grant(host);
        terminate(host);
      });
      h.actions += 2;
      // Then a clean tap still works.
      tapPill(id);
      flushTimers(h);
      break;
    }
    case 'unmount-mid-press': {
      const id = rng.pick(ids());
      const host = pillHost(h, id)!;
      const releaseFirst = rng.chance(0.5);
      // The responder system holds Pressability's handler, not the fiber;
      // a late touch-up reaches the (reset) instance after unmount.
      const lateRelease = host.props.onResponderRelease as (
        e: FakeResponderEvent,
      ) => void;
      act(() => {
        grant(host);
        if (releaseFirst) {
          release(host);
          intend(id);
        }
      });
      h.actions += releaseFirst ? 2 : 1;
      // Back / navigation away while the finger is down or the press-out
      // delay (130ms) is still pending.
      flushTimers(h, rng.int(0, 60));
      unmount(h);
      if (!releaseFirst) {
        // Finger lifts after the screen is gone.
        act(() => lateRelease(responderEvent()));
        h.actions += 1;
      }
      break;
    }
    case 'reduced-motion-flip-mid-press': {
      const id = rng.pick(ids());
      const host = pillHost(h, id)!;
      const listener = reducedMotionListener();
      if (!listener)
        throw new Error('reduceMotionChanged listener not registered');
      act(() => grant(host));
      h.actions += 1;
      act(() => listener(true));
      h.actions += 1;
      flushTimers(h, rng.int(0, 200));
      act(() => release(host));
      intend(id);
      h.actions += 1;
      act(() => listener(false));
      h.actions += 1;
      tapPill(rng.pick(ids()));
      flushTimers(h);
      break;
    }
    case 'a11y-click-storm': {
      // VoiceOver activations bypass the responder system entirely.
      const id = rng.pick(ids());
      const host = pillHost(h, id)!;
      const n = rng.int(2, 6);
      act(() => {
        for (let i = 0; i < n; i += 1) {
          click(host);
          intend(id);
          h.actions += 1;
        }
      });
      flushTimers(h);
      break;
    }
    case 'compact-toggle-storm': {
      // Result <-> Progress surface toggles with taps in between.
      const n = rng.int(2, 5);
      for (let i = 0; i < n; i += 1) {
        h.compact = !h.compact;
        render(h);
        tapPill(rng.pick(ids()));
      }
      flushTimers(h);
      break;
    }
  }
}

function runIteration(seed: number): IterationRow {
  const rng = new Rng(seed);
  const scenario = rng.pick(SCENARIOS);
  const h: Harness = {
    renderer: null as unknown as TestRenderer.ReactTestRenderer,
    summary: genPracticeSetSummary(rng),
    handler: jest.fn<void, [string]>(),
    compact: rng.chance(0.3),
    intended: [],
    actions: 0,
    mounted: false,
  };
  const failures: string[] = [];
  let detail = '';

  const { report } = withGuards(() => {
    try {
      render(h);
      flushTimers(h);
      runScenario(rng, scenario, h);
      failures.push(...structuralFailures(h));
      if (h.mounted) unmount(h);
      act(() => {
        jest.runOnlyPendingTimers();
      });
    } catch (error) {
      failures.push(
        `threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (h.mounted) {
        try {
          unmount(h);
        } catch {
          // already torn down
        }
      }
    }
  });

  // One side effect per intent, in order, on the handler current at tap time.
  const byHandler = new Map<jest.Mock<void, [string]>, string[]>();
  for (const { handler, id } of h.intended) {
    byHandler.set(handler, [...(byHandler.get(handler) ?? []), id]);
  }
  const handlers = new Set<jest.Mock<void, [string]>>([
    ...byHandler.keys(),
    ...(h.handler ? [h.handler] : []),
  ]);
  let effects = 0;
  for (const handler of handlers) {
    const want = byHandler.get(handler) ?? [];
    const got = handler.mock.calls.map(c => c[0]);
    effects += got.length;
    if (got.length !== want.length || got.some((id, i) => id !== want[i])) {
      failures.push(
        `effects ${JSON.stringify(got)} != intents ${JSON.stringify(want)}`,
      );
    }
  }
  const pending = jest.getTimerCount();
  if (pending !== 0)
    failures.push(`${pending} timer(s) still armed after unmount`);
  failures.push(...guardFailures(report));
  detail = `attempts=${h.summary.attempts.length} compact=${h.compact}`;

  return {
    seed,
    scenario,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    actions: h.actions,
    intents: h.intended.length,
    effects,
    detail,
    failures,
  };
}

beforeEach(() => {
  // Macrotasks only: `jest.getTimerCount()` then measures armed timers /
  // animation frames, not React's own microtask bookkeeping.
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(() => {
  act(() => {
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

describe('PracticeSetCard rapid-interaction bursts', () => {
  const seeds = seedsFor(CONFIG);
  it.each(seeds.map(seed => [seed] as const))('seed %d holds', seed => {
    const row = runIteration(seed);
    TABLE.push(row);
    expect({ seed, scenario: row.scenario, failures: row.failures }).toEqual({
      seed,
      scenario: row.scenario,
      failures: [],
    });
  });
});
