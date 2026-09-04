/**
 * Seeded rapid-interaction stress campaign for
 * `src/walkthrough/FirstRunWalkthrough.tsx` + `src/walkthrough/targets.ts`.
 *
 * Every seed builds a target-measurement world (each of the four walkthrough
 * targets resolves immediately, resolves late, resolves off-screen, resolves
 * null, rejects, answers after a timer, or is not registered at all) and then
 * drives the tour through a burst script from `mulberry32(seed)`: double/
 * triple/quad Next taps, Next+Skip+backdrop+hardware-back in the SAME act()
 * (the batched shape of a fast thumb), taps fired while a measurement is
 * still in flight, partial timer advances mid-transition, and re-raising the
 * tour after it was dismissed.
 *
 * Oracle: the retry contract read off the component (≤6 attempts × 120ms per
 * step; a step that never measures visibly is skipped; a skip past the last
 * step dismisses) predicts the settled step for any starting index.
 * Invariants asserted after every act():
 *
 *   - one side effect per intent: N Next taps on one rendered callout advance
 *     exactly ONE step (they share the render's `index`); N dismiss taps
 *     dismiss once and the tour never re-appears by itself
 *   - no duplicate modal / callout: at most one `Modal`, at most one
 *     `walkthrough-advance`, one `walkthrough-skip`, one backdrop, and the
 *     dot count/active dot match the rendered step
 *   - no orphan loading state: once timers are exhausted the tour is either
 *     showing a spotlight for the predicted step or fully dismissed — never
 *     mounted-with-no-callout, and never a scrim over an unmeasured target
 *   - the step index never moves backwards, and `Skip` is offered on exactly
 *     the non-final steps
 *   - dismissal is terminal: after it, `visible === false`, the stage is
 *     unmounted, and flushing every pending measurement timer changes nothing
 *   - no console.error / console.warn (act(), unmounted-update) and no
 *     unhandled rejections — including for measurers that reject after the
 *     tour is gone
 *
 * Replay one seed:  STRESS_SEED=<seed> npx jest --ci firstRunWalkthrough.rapidInteraction
 * Widen campaign:   STRESS_ITER=2000 STRESS_OUT=/tmp/stress npx jest --ci firstRunWalkthrough.rapidInteraction
 */
import React from 'react';
import { Dimensions, Modal } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// The walkthrough store persists through SQLite; the native module is absent
// under jest and this campaign drives store state directly.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import {
  FirstRunWalkthrough,
  WALKTHROUGH_STEPS,
} from '../../src/walkthrough/FirstRunWalkthrough';
import {
  registerWalkthroughMeasurer,
  type TargetRect,
  type WalkthroughTargetKey,
} from '../../src/walkthrough/targets';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';
import {
  campaignSeeds,
  ConsoleGuard,
  makeRng,
  ResultTable,
  runSeed,
  type Rng,
  type Trace,
} from '../../__harness__/stress/rapidInteraction';

type Renderer = TestRenderer.ReactTestRenderer;

const DEFAULT_ITERATIONS = 300;
const LAST_INDEX = WALKTHROUGH_STEPS.length - 1;
/** Component constants: 6 attempts, 120ms between them. */
const MAX_ATTEMPTS = 6;
const RETRY_WAIT_MS = 120;
/** Enough to exhaust the retry budget of every remaining step in the chain. */
const FULL_SETTLE_MS =
  WALKTHROUGH_STEPS.length * (MAX_ATTEMPTS * RETRY_WAIT_MS + 400) + 500;

const window = Dimensions.get('window');
const ON_SCREEN: TargetRect = {
  x: Math.round(window.width * 0.2),
  y: Math.round(window.height * 0.3),
  width: 64,
  height: 64,
};
/** Center below the viewport ⇒ `rectVisibleInWindow` rejects it. */
const OFF_SCREEN: TargetRect = {
  x: Math.round(window.width * 0.2),
  y: window.height + 200,
  width: 64,
  height: 64,
};

// ---------------------------------------------------------------------------
// Target world
// ---------------------------------------------------------------------------

type Behavior =
  | { kind: 'ok' }
  | { kind: 'delayedOk'; delayMs: number }
  | { kind: 'lateOk'; failAttempts: number }
  | { kind: 'null' }
  | { kind: 'reject' }
  | { kind: 'offscreen' }
  | { kind: 'zeroSize' }
  | { kind: 'unregistered' };

function describeBehavior(behavior: Behavior): string {
  switch (behavior.kind) {
    case 'delayedOk':
      return `delayedOk(${behavior.delayMs}ms)`;
    case 'lateOk':
      return `lateOk(after ${behavior.failAttempts})`;
    default:
      return behavior.kind;
  }
}

function pickBehavior(rng: Rng): Behavior {
  const roll = rng.next();
  if (roll < 0.4) return { kind: 'ok' };
  if (roll < 0.55)
    return { kind: 'delayedOk', delayMs: rng.pick([0, 30, 120, 240]) };
  if (roll < 0.68)
    return { kind: 'lateOk', failAttempts: rng.int(1, MAX_ATTEMPTS - 1) };
  if (roll < 0.76) return { kind: 'null' };
  if (roll < 0.84) return { kind: 'reject' };
  if (roll < 0.92) return { kind: 'offscreen' };
  if (roll < 0.96) return { kind: 'zeroSize' };
  return { kind: 'unregistered' };
}

/**
 * Does this behavior ever hand the component a rect it accepts within the
 * 6-attempt budget? `lateOk` is generated inside the budget on purpose so the
 * prediction stays independent of how many attempts earlier visits consumed.
 */
function behaviorEventuallyMeasures(behavior: Behavior): boolean {
  switch (behavior.kind) {
    case 'ok':
    case 'delayedOk':
      return true;
    case 'lateOk':
      return behavior.failAttempts < MAX_ATTEMPTS;
    // measureWalkthroughTarget passes a degenerate rect straight through;
    // `rectVisibleInWindow` only tests the center, so a 0×0 rect on screen
    // is a legitimate (if ugly) spotlight — the component shows the step.
    case 'zeroSize':
      return true;
    default:
      return false;
  }
}

interface World {
  behaviors: Record<WalkthroughTargetKey, Behavior>;
  cleanup: Array<() => void>;
  attempts: Record<WalkthroughTargetKey, number>;
}

function buildWorld(rng: Rng): World {
  const keys = WALKTHROUGH_STEPS.map(step => step.targetKey);
  const behaviors = {} as Record<WalkthroughTargetKey, Behavior>;
  const attempts = {} as Record<WalkthroughTargetKey, number>;
  for (const key of keys) {
    behaviors[key] = pickBehavior(rng);
    attempts[key] = 0;
  }
  // At least one step must be reachable on most seeds, otherwise every
  // iteration would degenerate into "dismisses immediately".
  if (!keys.some(key => behaviorEventuallyMeasures(behaviors[key]))) {
    if (rng.chance(0.7)) behaviors[rng.pick(keys)] = { kind: 'ok' };
  }

  const cleanup: Array<() => void> = [];
  for (const key of keys) {
    const behavior = behaviors[key];
    if (behavior.kind === 'unregistered') continue;
    cleanup.push(
      registerWalkthroughMeasurer(key, () => {
        const attempt = attempts[key]++;
        switch (behavior.kind) {
          case 'ok':
            return Promise.resolve(ON_SCREEN);
          case 'delayedOk':
            return new Promise<TargetRect>(resolve =>
              setTimeout(() => resolve(ON_SCREEN), behavior.delayMs),
            );
          case 'lateOk':
            return Promise.resolve(
              attempt >= behavior.failAttempts ? ON_SCREEN : null,
            );
          case 'null':
            return Promise.resolve(null);
          case 'reject':
            return Promise.reject(new Error(`measure failed: ${key}`));
          case 'offscreen':
            return Promise.resolve(OFF_SCREEN);
          case 'zeroSize':
            return Promise.resolve({ ...ON_SCREEN, width: 0, height: 0 });
        }
      }),
    );
  }
  return { behaviors, cleanup, attempts };
}

/**
 * Settled state the component must reach from `index` once timers are
 * exhausted: the first forward step whose target measures visibly, or
 * dismissal when none does.
 */
function settledFrom(
  world: World,
  index: number,
): { visible: true; index: number } | { visible: false } {
  for (let i = index; i <= LAST_INDEX; i++) {
    const key = WALKTHROUGH_STEPS[i]!.targetKey;
    if (behaviorEventuallyMeasures(world.behaviors[key])) {
      return { visible: true, index: i };
    }
  }
  return { visible: false };
}

// ---------------------------------------------------------------------------
// Tree access
// ---------------------------------------------------------------------------

function stageMounted(renderer: Renderer): boolean {
  return (
    renderer.root.findAll(n => n.props.testID === 'first-run-walkthrough')
      .length > 0
  );
}

function modals(renderer: Renderer) {
  return renderer.root.findAllByType(Modal);
}

/**
 * Host (native) nodes only. A pressable is a composite chain
 * (Button → PressableScale → Pressable) over ONE host view, so counting hosts
 * is what "exactly one Skip button on screen" actually means.
 */
function hostsWith(
  renderer: Renderer,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  return renderer.root.findAll(
    n => typeof n.type === 'string' && predicate(n.props),
  );
}

function backdrops(renderer: Renderer) {
  return hostsWith(
    renderer,
    props => props.accessibilityLabel === 'Dismiss walkthrough',
  );
}

function hostsByTestId(renderer: Renderer, testID: string) {
  return hostsWith(renderer, props => props.testID === testID);
}

/** The outermost node carrying the press handler for `testID`. */
function pressTarget(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    n => n.props.testID === testID && typeof n.props.onPress === 'function',
  )[0];
}

function pressBackdrop(renderer: Renderer) {
  return renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === 'Dismiss walkthrough' &&
      typeof n.props.onPress === 'function',
  )[0];
}

function advanceLabels(renderer: Renderer): string[] {
  return hostsByTestId(renderer, 'walkthrough-advance').map(
    n => n.props.accessibilityLabel as string,
  );
}

function textContent(renderer: Renderer): string {
  return renderer.root
    .findAll(n => String(n.type) === 'Text')
    .map(n => React.Children.toArray(n.props.children).join(''))
    .join('\n');
}

/** Which step the rendered callout belongs to, or null while unmeasured. */
function renderedStepIndex(renderer: Renderer): number | null {
  if (hostsByTestId(renderer, 'walkthrough-advance').length === 0) return null;
  const content = textContent(renderer);
  const matches = WALKTHROUGH_STEPS.map((step, index) =>
    content.includes(step.headline) ? index : -1,
  ).filter(index => index >= 0);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one step headline on screen, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

// ---------------------------------------------------------------------------
// Campaign
// ---------------------------------------------------------------------------

const table = new ResultTable('firstRunWalkthrough.rapidInteraction');
const guard = new ConsoleGuard();

beforeEach(() => {
  jest.useFakeTimers();
  guard.arm();
});

afterEach(() => {
  guard.disarm();
  act(() => {
    useWalkthroughStore.setState({ visible: false, queued: false });
  });
  jest.useRealTimers();
});

afterAll(() => {
  table.flush();
});

type Press = 'advance' | 'skip' | 'backdrop' | 'hardwareBack';

async function runIteration(seed: number, trace: Trace): Promise<void> {
  const rng = makeRng(seed);
  const world = buildWorld(rng);
  trace.step(
    `world{${WALKTHROUGH_STEPS.map(
      step =>
        `${step.targetKey}=${describeBehavior(world.behaviors[step.targetKey])}`,
    ).join(',')}}`,
  );

  let actions = 0;
  let renderer!: Renderer;
  act(() => {
    useWalkthroughStore.setState({ visible: true, queued: false });
  });
  await act(async () => {
    renderer = TestRenderer.create(<FirstRunWalkthrough />);
  });

  // Model: null index = dismissed.
  let modelIndex: number | null = 0;
  let highWaterIndex = 0;

  const structuralCheck = (where: string) => {
    expect({ where, modals: modals(renderer).length }).toEqual({
      where,
      modals: 1,
    });
    const visible = useWalkthroughStore.getState().visible;
    expect({ where, stage: stageMounted(renderer) }).toEqual({
      where,
      stage: visible,
    });
    expect({ where, backdrops: backdrops(renderer).length }).toEqual({
      where,
      backdrops: visible ? 1 : 0,
    });
    // One callout, one CTA — the spotlight is either up or absent.
    const callouts = hostsWith(
      renderer,
      props => props.accessibilityViewIsModal === true,
    ).length;
    expect({
      where,
      callouts,
      advances: hostsByTestId(renderer, 'walkthrough-advance').length,
    }).toEqual({ where, callouts, advances: callouts });
    expect(callouts).toBeLessThanOrEqual(1);
    if (!visible) expect(callouts).toBe(0);
    const rendered = renderedStepIndex(renderer);
    if (rendered === null) {
      expect({
        where,
        skips: hostsByTestId(renderer, 'walkthrough-skip').length,
      }).toEqual({
        where,
        skips: 0,
      });
    } else {
      expect(visible).toBe(true);
      // Never travels backwards.
      expect(rendered).toBeGreaterThanOrEqual(highWaterIndex);
      highWaterIndex = rendered;
      const isLast = rendered === LAST_INDEX;
      expect({
        where,
        label: advanceLabels(renderer),
        skips: hostsByTestId(renderer, 'walkthrough-skip').length,
      }).toEqual({
        where,
        label: [isLast ? 'Got it' : 'Next'],
        skips: isLast ? 0 : 1,
      });
    }
    const diagnostics = guard.drain();
    expect({ where, diagnostics }).toEqual({ where, diagnostics: [] });
  };

  /**
   * Exhausts the measurement chain. A skipped step's `setIndex` only mounts
   * the next step's effect when the enclosing `act()` exits, so one timer
   * advance can never cover the whole chain under fake timers — advance
   * repeatedly until the tree stops changing (bounded by the step count).
   */
  const settleFully = async () => {
    for (let pass = 0; pass < WALKTHROUGH_STEPS.length + 3; pass++) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(FULL_SETTLE_MS);
      });
    }
  };

  const settledCheck = async (where: string) => {
    await settleFully();
    const expected =
      modelIndex === null
        ? ({ visible: false } as const)
        : settledFrom(world, modelIndex);
    expect({ where, visible: useWalkthroughStore.getState().visible }).toEqual({
      where,
      visible: expected.visible,
    });
    if (expected.visible) {
      // No orphan loading state: the spotlight for the predicted step is up.
      expect({ where, step: renderedStepIndex(renderer) }).toEqual({
        where,
        step: expected.index,
      });
      modelIndex = expected.index;
    } else {
      expect(stageMounted(renderer)).toBe(false);
      modelIndex = null;
    }
    structuralCheck(`${where} (settled)`);
  };

  await settledCheck('initial');

  const bursts = rng.int(1, 5);
  for (let b = 0; b < bursts; b++) {
    const available: Press[] = ['backdrop', 'hardwareBack'];
    if (hostsByTestId(renderer, 'walkthrough-advance').length > 0)
      available.push('advance', 'advance', 'advance');
    if (hostsByTestId(renderer, 'walkthrough-skip').length > 0)
      available.push('skip');
    if (modelIndex === null) {
      // Re-raise the tour and stress the fresh mount.
      trace.step('reRaise');
      act(() => {
        useWalkthroughStore.setState({ visible: true, queued: false });
      });
      modelIndex = 0;
      highWaterIndex = 0;
      await settledCheck(`burst ${b} re-raise`);
      continue;
    }

    const presses: Press[] = [];
    const count = rng.int(1, 4);
    for (let i = 0; i < count; i++) presses.push(rng.pick(available));
    const repeats = rng.chance(0.5) ? 1 : rng.int(2, 4);
    trace.step(`SIM[${presses.join(',')}]x${repeats}`);

    // Every handler comes from the tree rendered right now — the batched
    // shape of taps landing inside one frame.
    const dismissing = presses.some(press => press !== 'advance');
    const advancing = presses.includes('advance');
    const before: number = modelIndex;

    const advanceNode = pressTarget(renderer, 'walkthrough-advance');
    const skipNode = pressTarget(renderer, 'walkthrough-skip');
    const backdropNode = pressBackdrop(renderer);
    const modalNode = modals(renderer)[0];

    await act(async () => {
      for (let r = 0; r < repeats; r++) {
        for (const press of presses) {
          actions += 1;
          switch (press) {
            case 'advance':
              advanceNode!.props.onPress();
              break;
            case 'skip':
              skipNode!.props.onPress();
              break;
            case 'backdrop':
              backdropNode!.props.onPress();
              break;
            case 'hardwareBack':
              modalNode!.props.onRequestClose();
              break;
          }
        }
      }
    });

    if (dismissing) {
      // Dismissal is terminal regardless of how many taps landed with it.
      expect(useWalkthroughStore.getState().visible).toBe(false);
      modelIndex = null;
    } else if (advancing) {
      // One side effect per intent: N taps on one callout = ONE step.
      modelIndex = before >= LAST_INDEX ? null : before + 1;
      if (modelIndex === null) {
        expect(useWalkthroughStore.getState().visible).toBe(false);
      }
    }
    structuralCheck(`burst ${b} immediately after presses`);

    // Tap during the transition, before the next measurement resolves. (An
    // unregistered final target dismisses synchronously inside the same
    // act(), in which case there is no transition left to interrupt.)
    if (
      modelIndex !== null &&
      useWalkthroughStore.getState().visible &&
      rng.chance(0.5)
    ) {
      const midFlight = rng.pick(['backdrop', 'hardwareBack', 'partialSettle']);
      trace.step(`midFlight(${midFlight})`);
      if (midFlight === 'partialSettle') {
        await act(async () => {
          await jest.advanceTimersByTimeAsync(rng.int(0, 3 * RETRY_WAIT_MS));
        });
        structuralCheck(`burst ${b} mid-flight partial settle`);
      } else {
        actions += 1;
        await act(async () => {
          if (midFlight === 'backdrop')
            pressBackdrop(renderer)!.props.onPress();
          else modals(renderer)[0]!.props.onRequestClose();
        });
        expect(useWalkthroughStore.getState().visible).toBe(false);
        modelIndex = null;
        structuralCheck(`burst ${b} dismissed mid-flight`);
      }
    }

    await settledCheck(`burst ${b}`);
  }

  // Dismissal (or a final unmount) must leave nothing pending: flushing every
  // timer and microtask afterwards changes no state and warns about nothing.
  const wasVisible = useWalkthroughStore.getState().visible;
  act(() => {
    useWalkthroughStore.setState({ visible: false, queued: false });
  });
  await settleFully();
  expect(stageMounted(renderer)).toBe(false);
  expect(guard.drain()).toEqual([]);
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    await jest.advanceTimersByTimeAsync(FULL_SETTLE_MS);
    jest.runOnlyPendingTimers();
  });
  expect(guard.drain()).toEqual([]);

  for (const cleanup of world.cleanup) cleanup();
  trace.extra.actionCount = actions;
  trace.extra.endedVisible = wasVisible;
  trace.extra.measureAttempts = { ...world.attempts };
}

describe('FirstRunWalkthrough rapid-interaction stress (seeded)', () => {
  const seeds = campaignSeeds(DEFAULT_ITERATIONS);

  it.each(seeds)('seed %i holds every invariant', async seed => {
    await runSeed(table, seed, trace => runIteration(seed, trace));
  });
});
