import React from 'react';
import { AccessibilityInfo, Animated, View } from 'react-native';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import {
  ANALYSIS_DURATION_HINT,
  ANALYSIS_STAGE_LABELS,
  AnalysisProgressBar,
  analysisStageProgress,
  extractionEtaSeconds,
  extractionProgress,
  extractionSublabel,
  observeExtractionProgress,
  type AnalysisProgressUi,
  type ExtractionEtaState,
} from '../../src/components/AnalysisProgress';
import {
  NoiseRecorder,
  SeededRng,
  campaignConfig,
  describe as describeValue,
  flushMicrotasks,
  iterationSeeds,
  summarise,
  writeTable,
  type ScenarioOutcome,
} from '../../test-support/stress/rapidInteraction';

/**
 * STRESS LENS `rapid-interaction` — AnalysisProgressBar + the ETA math.
 *
 * The bar has no controls; its "interactions" are the prop storms the
 * Analyze screen produces while a run flips between stages: bursts of
 * native progress events (forward, stalled, regressing, out-of-range),
 * indeterminate ⇄ determinate transitions in one tick, reduced-motion
 * toggling mid-animation, unmount mid-animation (back during async) and
 * immediate remount. Per seed:
 *
 *   P1 honest-value        accessibilityValue.now is present iff the stage
 *                          is determinate, and equals round(fraction·100)
 *   P2 honest-label        accessibilityLabel is `label` or `label. sublabel`
 *   P3 single-fill         exactly one fill node while mounted
 *   P4 no-invented-percent rendered text contains '%' only when the caller's
 *                          sublabel does
 *   P5 eta-math            ETA is null before 2 events / at completion,
 *                          otherwise a safe integer ≥ 1; sublabel matches
 *   P6 no-leaked-animation after any ≥16ms of fake time at most one frame
 *                          per live animation is pending (stopped timings
 *                          leave no re-arming frame), and after unmount the
 *                          count drains back to the renderer's own baseline
 *                          (no orphan loop). The baseline is measured per
 *                          seed by mounting/unmounting a bare <View/>:
 *                          React/RN's jest plumbing keeps one idle timer
 *                          alive that is not the component's.
 *   P7 quiet               no console.error/warn, no unhandled rejections
 *
 * Replays: STRESS_SEEDS=<seed[,seed]> STRESS_ITER=<n> STRESS_OUT=<json path>.
 */

type Op =
  | { kind: 'event'; deltaMs: number; progress: number }
  | { kind: 'stage'; stage: 'verifying' | 'measuring' | 'saving' }
  | { kind: 'resetExtraction' }
  | { kind: 'advance'; ms: number }
  | { kind: 'reducedMotion'; value: boolean }
  | { kind: 'toggleDark' }
  | { kind: 'unmount' }
  | { kind: 'remount' };

function generateScript(rng: SeededRng): Op[] {
  const length = rng.int(8, 30);
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted({
      event: 34,
      stage: 14,
      resetExtraction: 6,
      advance: 22,
      reducedMotion: 8,
      toggleDark: 4,
      unmount: 6,
      remount: 6,
    });
    switch (kind) {
      case 'event': {
        const shape = rng.weighted({
          forward: 55,
          stall: 15,
          regress: 10,
          overshoot: 8,
          garbage: 12,
        });
        const progress =
          shape === 'forward'
            ? rng.float()
            : shape === 'stall'
              ? -1 // sentinel: reuse previous fraction
              : shape === 'regress'
                ? rng.float() * 0.3
                : shape === 'overshoot'
                  ? 1 + rng.float() * 2
                  : rng.pick([Number.NaN, Infinity, -Infinity, -0.5, 2]);
        ops.push({
          kind: 'event',
          deltaMs: Number(
            rng.weighted({ '0': 15, '1': 15, '50': 30, '400': 25, '3000': 15 }),
          ),
          progress,
        });
        break;
      }
      case 'stage':
        ops.push({
          kind: 'stage',
          stage: rng.pick(['verifying', 'measuring', 'saving'] as const),
        });
        break;
      case 'resetExtraction':
        ops.push({ kind: 'resetExtraction' });
        break;
      case 'advance':
        ops.push({
          kind: 'advance',
          ms: rng.pick([0, 16, 100, 240, 720, 1440, 5000]),
        });
        break;
      case 'reducedMotion':
        ops.push({ kind: 'reducedMotion', value: rng.chance(0.5) });
        break;
      case 'toggleDark':
        ops.push({ kind: 'toggleDark' });
        break;
      case 'unmount':
        ops.push({ kind: 'unmount' });
        break;
      case 'remount':
        ops.push({ kind: 'remount' });
        break;
    }
  }
  return ops;
}

function opLabel(op: Op): string {
  switch (op.kind) {
    case 'event':
      return `event(+${op.deltaMs}ms → ${op.progress === -1 ? 'stall' : String(op.progress)})`;
    case 'stage':
      return `stage(${op.stage})`;
    case 'advance':
      return `advance(${op.ms}ms)`;
    case 'reducedMotion':
      return `reducedMotion(${op.value})`;
    default:
      return op.kind;
  }
}

function textOf(renderer: ReactTestRenderer): string {
  const json = renderer.toJSON();
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    (node as { children?: unknown[] | null }).children?.forEach(walk);
  };
  walk(json);
  return parts.join('');
}

function reducedMotionHandler(): ((value: boolean) => void) | null {
  const calls = (AccessibilityInfo.addEventListener as jest.Mock).mock.calls as
    Array<[string, (value: boolean) => void]> | undefined;
  const call = calls?.find(([event]) => event === 'reduceMotionChanged');
  return call ? call[1] : null;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

async function runScenario(seed: number): Promise<ScenarioOutcome> {
  const rng = new SeededRng(seed);
  const script = generateScript(rng);
  const violations: Record<string, string> = {};
  const counters = {
    events: 0,
    renders: 0,
    maxTimers: 0,
    baselineTimers: 0,
    remounts: 0,
    unmounts: 0,
    reducedToggles: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    unhandledRejections: 0,
  };
  const noise = new NoiseRecorder();
  let renderer = null as ReactTestRenderer | null;
  let eta: ExtractionEtaState | null = null;
  let clockMs = 10_000;
  let dark = false;
  let ui: AnalysisProgressUi = analysisStageProgress('verifying');
  let threw: string | null = null;

  const violate = (id: string, message: string) => {
    if (!(id in violations)) violations[id] = message;
  };

  const element = () => (
    <AnalysisProgressBar
      dark={dark}
      progress={ui.progress}
      label={ui.label}
      sublabel={ui.sublabel}
    />
  );

  const check = (when: string) => {
    counters.maxTimers = Math.max(counters.maxTimers, jest.getTimerCount());
    if (!renderer) return;
    const bars = renderer.root.findAll(
      node =>
        node.props.testID === 'analysis-progress' &&
        typeof node.type === 'string',
    );
    if (bars.length !== 1) {
      violate('P3_single_fill', `${when}: ${bars.length} progress roots`);
      return;
    }
    const [bar] = bars;
    if (!bar) return;
    const fills = renderer.root.findAll(
      node =>
        node.props.testID === 'analysis-progress-fill' &&
        typeof node.type === 'string',
    );
    if (fills.length !== 1) {
      violate('P3_single_fill', `${when}: ${fills.length} host fill nodes`);
    }
    const value = bar.props.accessibilityValue as {
      min: number;
      max: number;
      now?: number;
    };
    if (ui.progress === null) {
      if (value.now !== undefined) {
        violate(
          'P1_honest_value',
          `${when}: indeterminate but now=${value.now}`,
        );
      }
    } else {
      const expected = Math.round(clamp01(ui.progress) * 100);
      if (value.now !== expected) {
        violate(
          'P1_honest_value',
          `${when}: now=${String(value.now)} expected ${expected}`,
        );
      }
    }
    const expectedLabel = ui.sublabel
      ? `${ui.label}. ${ui.sublabel}`
      : ui.label;
    if (bar.props.accessibilityLabel !== expectedLabel) {
      violate(
        'P2_honest_label',
        `${when}: a11y label ${String(bar.props.accessibilityLabel)}`,
      );
    }
    const text = textOf(renderer);
    const callerHasPercent = (ui.sublabel ?? '').includes('%');
    if (text.includes('%') !== callerHasPercent) {
      violate('P4_no_invented_percent', `${when}: rendered "${text}"`);
    }
    if (!text.includes(ui.label)) {
      violate('P2_honest_label', `${when}: label missing from "${text}"`);
    }
  };

  const checkEta = (when: string) => {
    const seconds = extractionEtaSeconds(eta);
    if (eta === null) {
      if (seconds !== null)
        violate('P5_eta_math', `${when}: eta without state`);
      if (extractionSublabel(eta) !== null) {
        violate('P5_eta_math', `${when}: sublabel without state`);
      }
      return;
    }
    if (eta.lastProgress < 0 || eta.lastProgress > 1) {
      violate('P5_eta_math', `${when}: lastProgress=${eta.lastProgress}`);
    }
    if (eta.smoothedRatePerMs !== null && !(eta.smoothedRatePerMs > 0)) {
      violate('P5_eta_math', `${when}: rate=${eta.smoothedRatePerMs}`);
    }
    if (eta.eventCount < 2 || eta.lastProgress >= 1) {
      if (seconds !== null) {
        violate(
          'P5_eta_math',
          `${when}: eta=${seconds} with ${eta.eventCount} events at ${eta.lastProgress}`,
        );
      }
    } else if (
      seconds !== null &&
      (!Number.isSafeInteger(seconds) || seconds < 1)
    ) {
      violate('P5_eta_math', `${when}: eta=${seconds}`);
    }
    const percent = `${Math.round(eta.lastProgress * 100)}%`;
    const sublabel = extractionSublabel(eta);
    const expected =
      seconds === null ? percent : `${percent} · ~${seconds}s left`;
    if (sublabel !== expected) {
      violate(
        'P5_eta_math',
        `${when}: sublabel "${sublabel}" expected "${expected}"`,
      );
    }
    if (sublabel !== null && /~0s|~-|NaN|Infinity/.test(sublabel)) {
      violate('P5_eta_math', `${when}: dishonest sublabel "${sublabel}"`);
    }
  };

  const mount = async () => {
    await act(async () => {
      renderer = TestRenderer.create(element());
      await flushMicrotasks();
    });
    counters.renders += 1;
  };

  const rerender = async () => {
    if (!renderer) return;
    const current = renderer;
    await act(async () => {
      current.update(element());
    });
    counters.renders += 1;
  };

  const unmount = async () => {
    if (!renderer) return;
    const current = renderer;
    counters.unmounts += 1;
    await act(async () => {
      current.unmount();
    });
    renderer = null;
  };

  noise.start();
  let baselineTimers = 0;
  try {
    await act(async () => {
      const probe = TestRenderer.create(<View />);
      probe.unmount();
      jest.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    baselineTimers = jest.getTimerCount();
    counters.baselineTimers = baselineTimers;
    await mount();
    check('after mount');
    for (const op of script) {
      switch (op.kind) {
        case 'event': {
          counters.events += 1;
          clockMs += op.deltaMs;
          const progress =
            op.progress === -1 ? (eta ? eta.lastProgress : 0) : op.progress;
          eta = observeExtractionProgress(eta, clockMs, progress);
          checkEta(`after ${opLabel(op)}`);
          ui = extractionProgress(eta);
          await rerender();
          check(`after ${opLabel(op)}`);
          break;
        }
        case 'stage':
          ui = analysisStageProgress(op.stage);
          await rerender();
          check(`after ${opLabel(op)}`);
          break;
        case 'resetExtraction':
          eta = null;
          ui = extractionProgress(eta);
          checkEta('after resetExtraction');
          await rerender();
          check('after resetExtraction');
          break;
        case 'advance':
          await act(async () => {
            jest.advanceTimersByTime(op.ms);
            await flushMicrotasks();
          });
          check(`after ${opLabel(op)}`);
          // Once a frame has elapsed every stopped animation's last rAF has
          // fired; only the live loop/timing (≤ 1 frame each) may remain.
          if (op.ms >= 16 && jest.getTimerCount() > baselineTimers + 2) {
            violate(
              'P6_no_leaked_animation',
              `after ${opLabel(op)}: ${jest.getTimerCount()} pending timers (baseline ${baselineTimers}) while mounted=${renderer !== null}`,
            );
          }
          break;
        case 'reducedMotion': {
          const handler = reducedMotionHandler();
          if (!handler) {
            violate(
              'P7_quiet',
              'reduceMotionChanged listener never registered',
            );
            break;
          }
          counters.reducedToggles += 1;
          await act(async () => {
            handler(op.value);
            await flushMicrotasks();
          });
          check(`after ${opLabel(op)}`);
          break;
        }
        case 'toggleDark':
          dark = !dark;
          await rerender();
          check('after toggleDark');
          break;
        case 'unmount':
          await unmount();
          break;
        case 'remount':
          await unmount();
          counters.remounts += 1;
          await mount();
          check('after remount');
          break;
      }
    }
    await unmount();
    await act(async () => {
      jest.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    const remaining = jest.getTimerCount();
    if (remaining > baselineTimers) {
      violate(
        'P6_no_leaked_animation',
        `${remaining} timers pending after unmount (baseline ${baselineTimers})`,
      );
    }
  } catch (error) {
    threw = describeValue(error);
    try {
      await unmount();
    } catch {
      // already torn down
    }
  } finally {
    noise.stop();
  }
  if (noise.consoleErrors.length) {
    violate('P7_quiet', `console.error: ${noise.consoleErrors[0]}`);
  }
  if (noise.consoleWarnings.length) {
    violate('P7_quiet', `console.warn: ${noise.consoleWarnings[0]}`);
  }
  if (noise.unhandledRejections.length) {
    violate('P7_quiet', `unhandledRejection: ${noise.unhandledRejections[0]}`);
  }
  counters.consoleErrors = noise.consoleErrors.length;
  counters.consoleWarnings = noise.consoleWarnings.length;
  counters.unhandledRejections = noise.unhandledRejections.length;
  return { seed, script: script.map(opLabel), violations, counters, threw };
}

describe('AnalysisProgressBar — rapid-interaction stress', () => {
  const config = campaignConfig({ iterations: 40, baseSeed: 0x5eed0002 });
  const seeds = iterationSeeds(config);
  const rows: ScenarioOutcome[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    writeTable(config, summarise('AnalysisProgressBar', config, rows));
  });

  it.each(seeds.map(seed => [seed]))(
    'seed %d: honest value/label, single fill, no leaked animation, quiet',
    async seed => {
      const row = await runScenario(seed);
      rows.push(row);
      expect(row.threw).toBeNull();
      expect(row.violations).toEqual({});
    },
  );

  it('stage labels never carry a percentage and the hint is the honest one', () => {
    for (const stage of ['verifying', 'measuring', 'saving'] as const) {
      const ui = analysisStageProgress(stage);
      expect(ui.progress).toBeNull();
      expect(ui.label).toBe(ANALYSIS_STAGE_LABELS[stage]);
      expect(ui.sublabel).toBe(ANALYSIS_DURATION_HINT);
      expect(ui.sublabel).not.toContain('%');
    }
  });

  it('harness sensitivity: an orphan Animated.loop is visible to the P6 timer check', async () => {
    // A deliberately leaky sibling: starts the same kind of pulse loop the
    // bar uses but never stops it on unmount. The baseline/drain probe the
    // campaign relies on must see the orphan frame re-arming after unmount.
    function LeakyPulse() {
      const value = React.useRef(new Animated.Value(0)).current;
      React.useEffect(() => {
        Animated.loop(
          Animated.timing(value, {
            toValue: 1,
            duration: 720,
            useNativeDriver: false,
          }),
        ).start();
      }, [value]);
      return <Animated.View style={{ opacity: value }} />;
    }
    await act(async () => {
      const probe = TestRenderer.create(<View />);
      probe.unmount();
      jest.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    const baseline = jest.getTimerCount();
    let renderer = null as ReactTestRenderer | null;
    await act(async () => {
      renderer = TestRenderer.create(<LeakyPulse />);
    });
    await act(async () => {
      renderer?.unmount();
      jest.advanceTimersByTime(10_000);
      await flushMicrotasks();
    });
    expect(jest.getTimerCount()).toBeGreaterThan(baseline);
    jest.clearAllTimers();
  });
});
