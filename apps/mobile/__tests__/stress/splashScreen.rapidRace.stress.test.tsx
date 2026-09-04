import React from 'react';
import { AccessibilityInfo, Animated, StatusBar, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  EXIT_MS,
  SKIP_AFTER_S,
  SplashScreen,
  WATCHDOG_MS,
} from '../../src/screens/SplashScreen';
import {
  NoiseGuard,
  appendStressRecord,
  chance,
  mixSeed,
  pick,
  randomInt,
  seededRandom,
  sortEvents,
  stressCampaign,
  summarizeViolations,
  type TimedEvent,
} from '../../testing/stress/rapidInteraction';

/**
 * STRESS / rapid-interaction — SplashScreen race matrix (component level).
 *
 * The overlay's whole contract is "one handoff, exactly once, only after
 * `ready`": skip taps, the player's onEnd/onError, the 8s watchdog and the
 * hydration flag all converge on one exit animation. This campaign generates
 * seeded, replayable interleavings of every one of those inputs — double /
 * triple / quintuple Skip taps (with pressIn/pressOut), taps landing during
 * the exit fade, onEnd + onError + Skip in the same frame, `ready` flapping
 * true → false → true, reduce-motion flipping mid-animation, unmount while
 * the fade is running — and asserts:
 *   - onFinished fires at most once, exactly once when the model says it
 *     must, and at the modelled time (first moment ready && trigger + EXIT_MS)
 *   - never more than one splash-screen / splash-video / splash-skip node
 *   - the player's props stay sane (paused=false, repeat=false, finite
 *     volume in [0, 1], monotonically non-increasing once the fade started)
 *   - the StatusBar stack holds exactly one overlay entry while mounted and
 *     none after unmount (no leaked / duplicated entries across `ready`
 *     re-pushes)
 *   - no console.error / console.warn (act() warnings, state updates on an
 *     unmounted component, …) and no unhandled rejections
 *   - every timer the screen armed is gone once it unmounted after a
 *     completed handoff (no orphan watchdog / animation frames)
 *
 * Replay: STRESS_SEED=<seed> npx jest __tests__/stress/splashScreen.rapidRace
 * Scale:  STRESS_ITER=300 npx jest __tests__/stress/splashScreen.rapidRace
 */

const SUITE = 'splashScreen.rapidRace';
const SEED_BASE = 41_000;
const DEFAULT_ITERATIONS = 40;
const HORIZON_MS = 10_000;
/** Natural unmount: every animation armed by a ≤ HORIZON event has settled. */
const SETTLE_MS = HORIZON_MS + 1_000;
const TICK_MS = 10;
// Wall clock captured before fake timers replace Date.
const realNow: () => number = Date.now.bind(Date);

type Kind =
  'ready' | 'progress' | 'end' | 'error' | 'skip' | 'reduceMotion' | 'unmount';

interface Plan {
  seed: number;
  videoEndMs: number | null;
  errorAtMs: number | null;
  progressEveryMs: number;
  progressStalls: boolean;
  events: TimedEvent<Kind>[];
}

function quantize(ms: number): number {
  return Math.round(ms / TICK_MS) * TICK_MS;
}

function buildPlan(seed: number): Plan {
  const random = seededRandom(mixSeed(seed));
  const events: TimedEvent<Kind>[] = [];

  // Hydration: usually flips true somewhere on the timeline, sometimes flaps.
  let readyTrueAt: number | null = null;
  if (chance(random, 0.92)) {
    readyTrueAt = quantize(randomInt(random, 0, 9_000));
    events.push({ t: readyTrueAt, kind: 'ready', detail: { value: true } });
    if (chance(random, 0.3)) {
      const flaps = randomInt(random, 1, 3);
      let cursor = readyTrueAt;
      for (let i = 0; i < flaps; i += 1) {
        cursor = quantize(cursor + randomInt(random, 0, 900));
        events.push({ t: cursor, kind: 'ready', detail: { value: false } });
        cursor = quantize(cursor + randomInt(random, 0, 900));
        events.push({ t: cursor, kind: 'ready', detail: { value: true } });
      }
    }
  }

  // Playback: progress ticks, then end / error / stall (watchdog).
  const progressStalls = chance(random, 0.12);
  const progressEveryMs = pick(random, [250, 250, 500, 100]);
  const outcome = pick(random, [
    'end',
    'end',
    'end',
    'error',
    'stall',
    'endAndError',
    'endBurst',
  ] as const);
  const videoEndMs =
    outcome === 'stall' ? null : quantize(randomInt(random, 1_200, 7_000));
  let errorAtMs: number | null = null;
  if (!progressStalls) {
    const until = videoEndMs ?? HORIZON_MS;
    for (let t = progressEveryMs; t < until; t += progressEveryMs) {
      events.push({
        t,
        kind: 'progress',
        detail: { currentTime: t / 1000 },
      });
    }
  }
  if (videoEndMs !== null) {
    if (outcome === 'end' || outcome === 'endAndError') {
      events.push({ t: videoEndMs, kind: 'end', detail: { burst: 1 } });
    }
    if (outcome === 'endBurst') {
      events.push({
        t: videoEndMs,
        kind: 'end',
        detail: { burst: randomInt(random, 2, 4) },
      });
    }
    if (outcome === 'error') {
      errorAtMs = videoEndMs;
      events.push({ t: videoEndMs, kind: 'error', detail: {} });
    }
    if (outcome === 'endAndError') {
      errorAtMs = videoEndMs;
      events.push({ t: videoEndMs, kind: 'error', detail: {} });
    }
  }

  // Skip bursts: 0–4 bursts of 1–5 taps, some with pressIn/pressOut.
  const bursts = randomInt(random, 0, 4);
  for (let i = 0; i < bursts; i += 1) {
    events.push({
      t: quantize(randomInt(random, 300, 9_500)),
      kind: 'skip',
      detail: {
        taps: randomInt(random, 1, 5),
        pressCycle: chance(random, 0.5),
        // A second burst a few ms later models a triple-tap spanning frames.
        gapMs: pick(random, [0, 0, 10, 20]),
      },
    });
  }

  if (chance(random, 0.2)) {
    events.push({
      t: quantize(randomInt(random, 0, 9_500)),
      kind: 'reduceMotion',
      detail: { value: true },
    });
    if (chance(random, 0.5)) {
      events.push({
        t: quantize(randomInt(random, 0, 9_500)),
        kind: 'reduceMotion',
        detail: { value: false },
      });
    }
  }

  const unmountAt = chance(random, 0.15)
    ? quantize(randomInt(random, 0, 9_500))
    : SETTLE_MS;
  events.push({ t: unmountAt, kind: 'unmount', detail: {} });

  return {
    seed,
    videoEndMs,
    errorAtMs,
    progressEveryMs,
    progressStalls,
    events: sortEvents(events).filter(e => e.t <= unmountAt),
  };
}

type Renderer = TestRenderer.ReactTestRenderer;

function nodesByTestId(renderer: Renderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

/** The innermost Pressable carrying the Skip handlers (host views drop onPress). */
function skipControl(renderer: Renderer) {
  const matches = renderer.root.findAll(
    node =>
      node.props.testID === 'splash-skip' &&
      typeof node.props.onPress === 'function',
  );
  return matches.find(
    node =>
      !matches.some(other => {
        if (other === node) return false;
        let cursor = other.parent;
        while (cursor) {
          if (cursor === node) return true;
          cursor = cursor.parent;
        }
        return false;
      }),
  );
}

function reduceMotionHandler(): ((value: boolean) => void) | null {
  const calls = (
    AccessibilityInfo.addEventListener as unknown as jest.Mock<
      unknown,
      [string, (value: boolean) => void]
    >
  ).mock.calls;
  const call = calls.find(([event]) => event === 'reduceMotionChanged');
  return call ? call[1] : null;
}

function statusStack(): unknown[] {
  return (StatusBar as unknown as { _propsStack: unknown[] })._propsStack;
}

interface Outcome {
  observed: Record<string, unknown>;
  violations: string[];
}

/**
 * jest.getTimerCount() also sees React's scheduler and RN's Animated
 * bookkeeping (a bare Animated.View leaves timers behind on unmount). The
 * leak check therefore compares against an idle Animated.View driven through
 * the exact same unmount → +100ms → +20s protocol in the same fake-timer
 * environment: anything above that baseline is the screen's own.
 */
async function calibrateIdleTimers(): Promise<{
  short: number;
  long: number;
}> {
  const value = new Animated.Value(0);
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <Animated.View
        style={{
          opacity: value.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
          }),
        }}
      >
        <View />
      </Animated.View>,
    );
  });
  await act(async () => {
    jest.advanceTimersByTime(250);
  });
  await act(async () => {
    renderer.unmount();
  });
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  const short = jest.getTimerCount();
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });
  return { short, long: jest.getTimerCount() };
}

async function runIteration(plan: Plan): Promise<Outcome> {
  const violations: string[] = [];
  const guard = new NoiseGuard();
  guard.install();

  const finishedAt: number[] = [];
  let now = 0;
  let ready = false;
  let reducedMotion = false;
  let exitDuration: number | null = null;
  // Attributed on the fake clock (exact fire time), not the model's chunked
  // `now`; `fakeEpoch` is captured right before mount so both agree at 0.
  let fakeEpoch = 0;
  const onFinished = jest.fn(() => {
    finishedAt.push(Date.now() - fakeEpoch);
  });

  // Reference model (sticky triggers, like the component's state).
  let skipUnlockedAt: number | null = null; // first progress >= SKIP_AFTER_S
  let triggerAt: number | null = null; // first end/error/watchdog/valid skip
  let armedAt: number | null = null; // first moment ready && triggered
  let mounted = true;
  let unmountedAt: number | null = null;
  let exitSeenAt: number | null = null;
  let lastVolume = 1;
  let skipTapsDelivered = 0;
  let skipTapsWhileHidden = 0;
  let skipTapsDuringExit = 0;
  const statusMax = { mounted: 0 };

  const arm = () => {
    if (armedAt === null && ready && triggerAt !== null) {
      armedAt = now;
      exitDuration = reducedMotion ? 0 : EXIT_MS;
    }
  };
  const trigger = () => {
    if (triggerAt === null) triggerAt = now;
    arm();
  };

  const idle = await calibrateIdleTimers();
  fakeEpoch = Date.now();
  let renderer!: Renderer;
  const render = (nextReady: boolean) => (
    <SplashScreen ready={nextReady} onFinished={onFinished} />
  );
  await act(async () => {
    renderer = TestRenderer.create(render(false));
  });

  const checkTree = (label: string) => {
    if (!mounted) return;
    const screens = nodesByTestId(renderer, 'splash-screen');
    const videos = nodesByTestId(renderer, 'splash-video');
    const skips = nodesByTestId(renderer, 'splash-skip');
    if (screens.length !== 1) {
      violations.push(`${label}@${now}: ${screens.length} splash-screen nodes`);
    }
    if (videos.length !== 1) {
      violations.push(`${label}@${now}: ${videos.length} splash-video nodes`);
    }
    if (skips.length > 1) {
      violations.push(`${label}@${now}: ${skips.length} splash-skip nodes`);
    }
    const video = videos[0];
    if (video) {
      const volume = video.props.volume as unknown;
      if (
        typeof volume !== 'number' ||
        !Number.isFinite(volume) ||
        volume < 0 ||
        volume > 1
      ) {
        violations.push(`${label}@${now}: volume=${String(volume)}`);
      } else {
        if (exitSeenAt !== null && volume > lastVolume + 1e-9) {
          violations.push(
            `${label}@${now}: volume rose ${lastVolume} → ${volume} during exit`,
          );
        }
        lastVolume = volume;
      }
      if (video.props.paused !== false || video.props.repeat !== false) {
        violations.push(
          `${label}@${now}: paused=${String(video.props.paused)} repeat=${String(video.props.repeat)}`,
        );
      }
    }
    const screen = screens[0];
    if (
      screen &&
      screen.props.pointerEvents === 'none' &&
      exitSeenAt === null
    ) {
      exitSeenAt = now;
    }
    const stack = statusStack();
    statusMax.mounted = Math.max(statusMax.mounted, stack.length);
    if (stack.length !== 1) {
      violations.push(`${label}@${now}: StatusBar stack has ${stack.length}`);
    }
  };

  const advanceTo = async (t: number) => {
    // Step in bounded chunks so timer-scheduled callbacks (watchdog, fade
    // frames, listener-driven setVolume) interleave with microtasks the way
    // they do on device, and the model's `now` tracks every callback.
    while (now < t) {
      // Land exactly on the watchdog deadline so the model's trigger time
      // matches the timer's.
      const toWatchdog = now < WATCHDOG_MS ? WATCHDOG_MS - now : 250;
      const step = Math.min(250, t - now, toWatchdog);
      now += step;
      await act(async () => {
        jest.advanceTimersByTime(step);
      });
      if (now >= WATCHDOG_MS && mounted) trigger();
      checkTree('tick');
    }
  };

  const videoProps = () => nodesByTestId(renderer, 'splash-video')[0]?.props;

  checkTree('mount');
  for (const event of plan.events) {
    await advanceTo(event.t);
    if (!mounted) break;
    switch (event.kind) {
      case 'ready': {
        ready = event.detail.value as boolean;
        await act(async () => {
          renderer.update(render(ready));
        });
        arm();
        break;
      }
      case 'progress': {
        const currentTime = event.detail.currentTime as number;
        await act(async () => {
          videoProps()?.onProgress({
            currentTime,
            playableDuration: 8,
            seekableDuration: 8,
          });
        });
        if (currentTime >= SKIP_AFTER_S && skipUnlockedAt === null) {
          skipUnlockedAt = now;
        }
        break;
      }
      case 'end': {
        const burst = event.detail.burst as number;
        await act(async () => {
          for (let i = 0; i < burst; i += 1) videoProps()?.onEnd();
        });
        trigger();
        break;
      }
      case 'error': {
        await act(async () => {
          videoProps()?.onError({ error: { code: 1, domain: 'stress' } });
        });
        trigger();
        break;
      }
      case 'skip': {
        const taps = event.detail.taps as number;
        const pressCycle = event.detail.pressCycle as boolean;
        const gapMs = event.detail.gapMs as number;
        for (let i = 0; i < taps; i += 1) {
          const skip = skipControl(renderer);
          if (!skip) {
            skipTapsWhileHidden += 1;
            continue;
          }
          const screen = nodesByTestId(renderer, 'splash-screen')[0];
          if (screen?.props.pointerEvents === 'none') skipTapsDuringExit += 1;
          await act(async () => {
            if (pressCycle) {
              skip.props.onPressIn?.();
              skip.props.onPressOut?.();
            }
            skip.props.onPress();
          });
          skipTapsDelivered += 1;
          // The screen honours a tap the moment Skip is on screen (it is
          // rendered only once progress crossed SKIP_AFTER_S).
          trigger();
          if (gapMs > 0 && i < taps - 1) {
            now += gapMs;
            await act(async () => {
              jest.advanceTimersByTime(gapMs);
            });
          }
        }
        break;
      }
      case 'reduceMotion': {
        const handler = reduceMotionHandler();
        if (handler) {
          reducedMotion = event.detail.value as boolean;
          await act(async () => {
            handler(reducedMotion);
          });
        }
        break;
      }
      case 'unmount': {
        mounted = false;
        unmountedAt = now;
        await act(async () => {
          renderer.unmount();
        });
        break;
      }
    }
    checkTree(event.kind);
  }

  if (mounted) {
    mounted = false;
    unmountedAt = now;
    await act(async () => {
      renderer.unmount();
    });
  }

  // Post-unmount: the stack must be empty and, after a completed handoff,
  // nothing the screen armed may still be pending.
  const stackAfter = statusStack().length;
  if (stackAfter !== 0) {
    violations.push(`after unmount: StatusBar stack has ${stackAfter}`);
  }

  const expectedFinishAt =
    armedAt === null ? null : armedAt + (exitDuration ?? EXIT_MS);
  const finishedBeforeUnmount =
    expectedFinishAt !== null &&
    unmountedAt !== null &&
    expectedFinishAt <= unmountedAt;
  const naturalUnmount = unmountedAt === SETTLE_MS;
  // Early unmount with no handoff armed and no Skip fade in flight: the only
  // timer the screen could still own is the watchdog, which must be cleared.
  const quietEarlyUnmount =
    !naturalUnmount &&
    armedAt === null &&
    unmountedAt !== null &&
    unmountedAt < WATCHDOG_MS &&
    (skipUnlockedAt === null || unmountedAt > skipUnlockedAt + 1_000);
  await act(async () => {
    jest.advanceTimersByTime(100);
  });
  const timersShort = jest.getTimerCount();
  await act(async () => {
    jest.advanceTimersByTime(20_000);
  });
  const timersLong = jest.getTimerCount();
  if ((naturalUnmount || quietEarlyUnmount) && timersShort > idle.short) {
    violations.push(
      `after unmount: ${timersShort} timers pending vs idle baseline ${idle.short} (leaked watchdog/animation)`,
    );
  }
  if (timersLong > idle.long) {
    violations.push(
      `20s after unmount: ${timersLong} timers pending vs idle baseline ${idle.long} (recurring loop)`,
    );
  }
  // Counted after the 20s flush so a second callback landing after unmount
  // (an animation still running against a dead component) is caught too.
  if (finishedAt.length > 1) {
    violations.push(`onFinished fired ${finishedAt.length}×: ${finishedAt}`);
  }
  const finishedAfterUnmount =
    unmountedAt !== null && finishedAt.some(at => at >= unmountedAt);
  if (finishedBeforeUnmount) {
    if (finishedAt.length !== 1) {
      violations.push(
        `onFinished fired ${finishedAt.length}× but handoff armed at ${armedAt} (expected 1 by ${expectedFinishAt})`,
      );
    } else {
      const at = finishedAt[0]!;
      // Jest's NativeAnimatedModule mock completes native-driver animations
      // 16ms after start regardless of duration, and the JS fade lands on the
      // first rAF frame (16ms) past EXIT_MS.
      const slack = 2 * 16;
      if (at < expectedFinishAt! || at > expectedFinishAt! + slack) {
        violations.push(
          `onFinished at ${at}, expected within [${expectedFinishAt}, ${expectedFinishAt! + slack}]`,
        );
      }
    }
    if (exitSeenAt === null || exitSeenAt > armedAt! + 250) {
      violations.push(
        `pointerEvents never went 'none' by ${armedAt! + 250} (exitSeenAt=${exitSeenAt})`,
      );
    }
  } else if (armedAt === null && finishedAt.length !== 0) {
    violations.push(
      `onFinished fired without ready && trigger (ready=${ready}, trigger=${triggerAt})`,
    );
  }
  if (armedAt === null && exitSeenAt !== null) {
    violations.push(`exit started at ${exitSeenAt} without ready && trigger`);
  }

  guard.uninstall();
  violations.push(...guard.violations());

  return {
    violations,
    observed: {
      reducedMotionAtEnd: reducedMotion,
      exitDuration,
      naturalUnmount,
      onFinishedCount: finishedAt.length,
      finishedAt,
      expectedFinishAt,
      armedAt,
      triggerAt,
      skipUnlockedAt,
      exitSeenAt,
      unmountedAt,
      finishedBeforeUnmount,
      finishedAfterUnmount,
      quietEarlyUnmount,
      skipTapsDelivered,
      skipTapsWhileHidden,
      skipTapsDuringExit,
      statusStackMaxWhileMounted: statusMax.mounted,
      idleTimerBaseline: idle,
      timersAfterUnmount: { short: timersShort, long: timersLong },
      consoleErrors: guard.errors.length,
      consoleWarnings: guard.warnings.length,
      unhandledRejections: guard.rejections.length,
    },
  };
}

const campaign = stressCampaign(DEFAULT_ITERATIONS, SEED_BASE);

describe(`stress/rapid-interaction: SplashScreen race matrix (${campaign.seeds.length} seeds × ${campaign.repeat})`, () => {
  beforeEach(() => {
    jest.useFakeTimers();
    statusStack().length = 0;
    // useReducedMotion keeps a module-level value: reset it so every seed
    // starts from the same state regardless of the seeds run before it.
    reduceMotionHandler()?.(false);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  for (const seed of campaign.seeds) {
    for (let run = 1; run <= campaign.repeat; run += 1) {
      test(`seed ${seed}${campaign.repeat > 1 ? ` run ${run}` : ''}`, async () => {
        const plan = buildPlan(seed);
        const started = realNow();
        const outcome = await runIteration(plan);
        appendStressRecord({
          suite: SUITE,
          seed,
          run,
          plan: {
            videoEndMs: plan.videoEndMs,
            errorAtMs: plan.errorAtMs,
            progressEveryMs: plan.progressEveryMs,
            progressStalls: plan.progressStalls,
            events: plan.events,
          },
          observed: outcome.observed,
          violations: outcome.violations,
          verdict: outcome.violations.length === 0 ? 'pass' : 'fail',
          durationMs: realNow() - started,
          atIso: new Date(realNow()).toISOString(),
        });
        if (outcome.violations.length > 0) {
          throw new Error(
            `seed ${seed} violated ${outcome.violations.length} invariant(s):${summarizeViolations(outcome.violations)}\nreplay: STRESS_SEED=${seed} npx jest __tests__/stress/splashScreen.rapidRace`,
          );
        }
      });
    }
  }
});

/**
 * Known gap surfaced by the campaign (seeds 41024, 41294 in the 300-seed run):
 * the exit effect has no cleanup, so unmounting the overlay while the fade is
 * running lets the animation finish against a dead component and deliver
 * `onFinished` AFTER unmount. In production the Gate only unmounts the
 * overlay in response to that very callback, so this is a hazard (a
 * RootErrorBoundary reset mid-fade would call into a stale closure), not a
 * user-visible fault. `test.failing` pins the behaviour: it flips to a real
 * failure — delete it then — once the effect stops its animations on unmount.
 */
describe('stress/rapid-interaction: SplashScreen unmount mid-exit', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    statusStack().length = 0;
    reduceMotionHandler()?.(false);
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test.failing(
    'onFinished is not delivered after the overlay unmounted mid-fade (KNOWN GAP, P3)',
    async () => {
      const onFinished = jest.fn();
      let renderer!: Renderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <SplashScreen ready onFinished={onFinished} />,
        );
      });
      await act(async () => {
        nodesByTestId(renderer, 'splash-video')[0]!.props.onEnd();
      });
      await act(async () => {
        jest.advanceTimersByTime(EXIT_MS / 2);
      });
      expect(onFinished).not.toHaveBeenCalled();
      await act(async () => {
        renderer.unmount();
      });
      await act(async () => {
        jest.advanceTimersByTime(EXIT_MS * 2);
      });
      expect(onFinished).not.toHaveBeenCalled();
    },
  );
});
