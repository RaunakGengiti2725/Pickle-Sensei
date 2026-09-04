/**
 * Rapid/concurrent-interaction stress campaign for the design-system unit
 * (`src/design`: components, BrandNotice, MascotMoment, icons, safeArea,
 * tokens).
 *
 * Every iteration is a seeded burst script (double/triple taps, press held
 * across a re-render, taps through the real responder path AND the
 * accessibility-click path, touch cancellation, back during async work,
 * dialog/notice dismiss spam, prop churn mid-animation) driven against
 * consumer hosts that wire the primitives the way the app's screens do.
 * After each burst the harness asserts:
 *   - one side effect per intent (one request per enabled tap, one
 *     navigation per back tap, toggle parity),
 *   - no orphan loading state once every async completes,
 *   - never more than one modal surface in the tree,
 *   - no console errors (act() warnings, key warnings, ...),
 *   - no unhandled promise rejections,
 *   - no timers left behind after unmount.
 *
 * Knobs (all optional):
 *   STRESS_ITER=<n>       iterations (default 24 — cheap enough for the suite)
 *   STRESS_SEED_BASE=<n>  first seed (default 1000; seed i = base + i)
 *   STRESS_SEED=<n>       replay exactly one seed
 *   STRESS_REPEAT=<n>     run each seed n times (flake rate for one seed)
 *   STRESS_OUT=<path>     write the seed → outcome JSON table here
 *
 * The scenario family is `seed % SCENARIOS.length`, everything else derives
 * from mulberry32(seed), so a seed alone replays an iteration exactly.
 */
jest.mock('react-native-svg', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Line: Mock,
    Path: Mock,
    Polyline: Mock,
    Rect: Mock,
    Defs: Mock,
    LinearGradient: Mock,
    Stop: Mock,
  };
});
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const { View } = require('react-native');
  const SafeAreaView = (props: { children?: React.ReactNode }) =>
    React.createElement(View, null, props.children);
  return {
    __esModule: true,
    SafeAreaView,
    useSafeAreaInsets: jest.fn(() => ({
      top: 0,
      bottom: 0,
      left: 0,
      right: 0,
    })),
    initialWindowMetrics: { insets: { top: 0, bottom: 0, left: 0, right: 0 } },
  };
});

import * as fs from 'fs';
import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Image, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import TestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer,
} from 'react-test-renderer';
import {
  BrandDialog,
  BrandToggle,
  Button,
  CheckpointRow,
  EmptyState,
  ErrorState,
  LoadingState,
  Pill,
  PressableScale,
  RevealFill,
  ScoreRing,
  ScreenHeader,
  Stat,
} from '../../src/design/components';
import { BrandNoticeHost, showBrandNotice } from '../../src/design/BrandNotice';
import {
  MASCOT_SOURCES,
  MascotMoment,
  MascotStage,
  type MascotPose,
  type MascotTone,
} from '../../src/design/MascotMoment';
import { Icon, type IconName } from '../../src/design/icons';
import { useReliableSafeAreaInsets } from '../../src/design/safeArea';
import { bandColor, color } from '../../src/design/tokens';

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration replays from its seed alone.
// ---------------------------------------------------------------------------

class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.int(0, items.length - 1)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
}

// ---------------------------------------------------------------------------
// Test-renderer plumbing shared by every scenario.
// ---------------------------------------------------------------------------

function render(element: React.ReactElement): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Host views wired by Pressability (what the OS actually dispatches to). */
function pressableHosts(renderer: ReactTestRenderer): ReactTestInstance[] {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.onClick === 'function' &&
      typeof n.props.onStartShouldSetResponder === 'function',
  );
}

function hostByLabel(
  renderer: ReactTestRenderer,
  label: string,
): ReactTestInstance | null {
  const hosts = pressableHosts(renderer).filter(
    h => h.props.accessibilityLabel === label,
  );
  if (hosts.length > 1) {
    throw new Error(`duplicate pressable "${label}" (${hosts.length})`);
  }
  return hosts[0] ?? null;
}

function isDisabled(host: ReactTestInstance): boolean {
  return host.props.accessibilityState?.disabled === true;
}

function touchEvent(host: ReactTestInstance, at: number) {
  return {
    persist: () => {},
    currentTarget: { measure: () => {} },
    target: host,
    nativeEvent: {
      pageX: 12,
      pageY: 12,
      locationX: 6,
      locationY: 6,
      timestamp: at,
      identifier: 1,
      touches: [],
      changedTouches: [],
    },
    touchHistory: {
      touchBank: [],
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: at,
    },
  };
}

/** Accessibility click (VoiceOver double-tap / Switch Control). */
function click(host: ReactTestInstance): void {
  act(() => {
    host.props.onClick({ currentTarget: host, target: host, nativeEvent: {} });
  });
}

/** Finger down through the responder system; false when the view refused. */
function grant(host: ReactTestInstance): boolean {
  let granted = false;
  act(() => {
    granted = host.props.onStartShouldSetResponder() === true;
    if (granted) host.props.onResponderGrant(touchEvent(host, Date.now()));
  });
  return granted;
}

function release(host: ReactTestInstance): void {
  act(() => {
    host.props.onResponderRelease(touchEvent(host, Date.now()));
  });
}

/** The responder was taken away (a scroll view stole the touch). */
function terminate(host: ReactTestInstance): void {
  act(() => {
    host.props.onResponderTerminate(touchEvent(host, Date.now()));
  });
}

function advance(ms: number): void {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

function flushAll(): void {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  act(() => {
    jest.runOnlyPendingTimers();
  });
}

function countBy(
  renderer: ReactTestRenderer,
  predicate: (node: ReactTestInstance) => boolean,
): number {
  return renderer.root.findAll(n => typeof n.type === 'string' && predicate(n))
    .length;
}

function modalSurfaces(renderer: ReactTestRenderer): number {
  return countBy(renderer, n => n.props.accessibilityViewIsModal === true);
}

function loadingSurfaces(renderer: ReactTestRenderer): number {
  return countBy(
    renderer,
    n =>
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.endsWith('Keep Pickle Sensei open.'),
  );
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  settled: boolean;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const d: Deferred = {
    settled: false,
    resolve: () => {},
    reject: () => {},
    promise: new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    }),
  };
  d.resolve = () => {
    if (d.settled) return;
    d.settled = true;
    resolve();
  };
  d.reject = (error: Error) => {
    if (d.settled) return;
    d.settled = true;
    reject(error);
  };
  return d;
}

/** Lets a settled deferred's continuations run inside act. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Outcome bookkeeping.
// ---------------------------------------------------------------------------

interface Outcome {
  seed: number;
  scenario: string;
  steps: string[];
  counters: Record<string, number>;
  violations: string[];
  consoleErrors: string[];
  unhandledRejections: string[];
  ok: boolean;
}

const consoleErrors: string[] = [];
const unhandledRejections: string[] = [];
const outcomes: Outcome[] = [];

function onUnhandled(reason: unknown): void {
  unhandledRejections.push(
    reason instanceof Error ? reason.message : `${reason}`,
  );
}

function formatConsoleArgs(args: unknown[]): string {
  return args
    .map(a => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
    .join(' ')
    .slice(0, 300);
}

interface Trace {
  steps: string[];
  counters: Record<string, number>;
  violations: string[];
}

function newTrace(): Trace {
  return { steps: [], counters: {}, violations: [] };
}

function bump(trace: Trace, key: string, by = 1): void {
  trace.counters[key] = (trace.counters[key] ?? 0) + by;
}

function check(trace: Trace, ok: boolean, message: string): void {
  if (!ok) trace.violations.push(message);
}

// ---------------------------------------------------------------------------
// Scenario 1 — async request screen: Button (request) + ScreenHeader back
// (navigation) + BrandToggle (simultaneous control) + LoadingState.
// ---------------------------------------------------------------------------

interface RequestLog {
  requests: number;
  navigations: number;
  toggles: boolean[];
  pending: Deferred[];
}

function AsyncRequestScreen(props: {
  log: RequestLog;
  onNavigateAway: () => void;
  initialToggle: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [toggle, setToggle] = useState(props.initialToggle);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const start = () => {
    props.log.requests += 1;
    setBusy(true);
    const d = deferred();
    props.log.pending.push(d);
    d.promise
      .catch(() => {})
      .then(() => {
        if (mounted.current) setBusy(false);
      });
  };

  return (
    <View>
      <ScreenHeader
        title="Rate my shot"
        onBack={() => {
          props.log.navigations += 1;
          props.onNavigateAway();
        }}
      />
      <BrandToggle
        label="Sound cues"
        value={toggle}
        onValueChange={next => {
          props.log.toggles.push(next);
          setToggle(next);
        }}
      />
      {busy ? (
        <LoadingState label="Scoring your shot" />
      ) : (
        <Button label="Rate my shot" onPress={start} disabled={busy} />
      )}
    </View>
  );
}

function Navigator(props: {
  log: RequestLog;
  initialToggle: boolean;
  onUnmountScreen: () => void;
}) {
  const [screen, setScreen] = useState(true);
  return screen ? (
    <AsyncRequestScreen
      log={props.log}
      initialToggle={props.initialToggle}
      onNavigateAway={() => {
        props.onUnmountScreen();
        setScreen(false);
      }}
    />
  ) : (
    <Text>Home</Text>
  );
}

async function scenarioAsyncRequest(
  seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  const log: RequestLog = {
    requests: 0,
    navigations: 0,
    toggles: [],
    pending: [],
  };
  const initialToggle = rng.bool();
  let screenMounted = true;
  const renderer = render(
    <Navigator
      log={log}
      initialToggle={initialToggle}
      onUnmountScreen={() => {
        screenMounted = false;
      }}
    />,
  );

  let expectedRequests = 0;
  let expectedNavigations = 0;
  let toggleTaps = 0;
  let held: { label: string; host: ReactTestInstance } | null = null;
  const steps = rng.int(6, 22);

  for (let i = 0; i < steps; i += 1) {
    const action = rng.pick([
      'tapRate',
      'tapRate',
      'tapRate',
      'tapBack',
      'tapToggle',
      'toggleBurst',
      'holdRate',
      'releaseHeld',
      'cancelHeld',
      'resolve',
      'reject',
      'wait',
    ]);
    if (
      action === 'tapRate' ||
      action === 'tapToggle' ||
      action === 'tapBack'
    ) {
      const label =
        action === 'tapRate'
          ? 'Rate my shot'
          : action === 'tapToggle'
            ? 'Sound cues'
            : 'Back';
      const host = hostByLabel(renderer, label);
      if (!host) {
        trace.steps.push(`${action}:absent`);
        continue;
      }
      const enabled = !isDisabled(host);
      // A second finger on the view that already owns the touch is folded
      // into that touch by the responder system; only an a11y click can
      // reach the control while it is held.
      const useTouch = held?.host === host ? false : rng.bool(0.6);
      const taps = rng.pick([1, 1, 2, 2, 3]);
      for (let t = 0; t < taps; t += 1) {
        const live = hostByLabel(renderer, label);
        if (!live) break;
        const liveEnabled = !isDisabled(live);
        if (useTouch) {
          if (held && held.host !== live) {
            // A new touch on another view wins the responder negotiation
            // (Pressable is cancelable) and the held press is terminated.
            const heldLive = hostByLabel(renderer, held.label);
            if (heldLive === held.host) terminate(heldLive);
            held = null;
            trace.steps.push('held:terminated-by-new-touch');
          }
          const granted = grant(live);
          check(
            trace,
            granted === liveEnabled,
            `${label}: responder grant ${granted} while enabled=${liveEnabled}`,
          );
          if (granted) {
            advance(rng.int(0, 180));
            const stillLive = hostByLabel(renderer, label);
            if (stillLive === live) release(live);
            else {
              trace.steps.push(`${label}:unmounted-under-finger`);
              continue;
            }
          }
        } else {
          click(live);
        }
        if (liveEnabled) {
          if (label === 'Rate my shot') expectedRequests += 1;
          if (label === 'Back') expectedNavigations += 1;
          if (label === 'Sound cues') toggleTaps += 1;
        }
      }
      trace.steps.push(
        `${action}x${taps}:${useTouch ? 'touch' : 'click'}:${enabled ? 'enabled' : 'disabled'}`,
      );
    } else if (action === 'toggleBurst') {
      // Two controls in the same frame: toggle + header back.
      const toggleHost = hostByLabel(renderer, 'Sound cues');
      const backHost = hostByLabel(renderer, 'Back');
      if (toggleHost && backHost) {
        act(() => {
          toggleHost.props.onClick({
            currentTarget: toggleHost,
            target: toggleHost,
            nativeEvent: {},
          });
          backHost.props.onClick({
            currentTarget: backHost,
            target: backHost,
            nativeEvent: {},
          });
        });
        toggleTaps += 1;
        expectedNavigations += 1;
        trace.steps.push('toggleBurst:toggle+back');
      } else {
        trace.steps.push('toggleBurst:absent');
      }
    } else if (action === 'holdRate') {
      const host = hostByLabel(renderer, 'Rate my shot');
      if (host && !held) {
        const granted = grant(host);
        if (granted) held = { label: 'Rate my shot', host };
        trace.steps.push(`holdRate:${granted ? 'held' : 'refused'}`);
      } else {
        trace.steps.push('holdRate:skip');
      }
    } else if (action === 'releaseHeld') {
      if (held) {
        // The finger lifts on the instance that was granted; if that instance
        // unmounted meanwhile the release reaches nothing.
        const live = hostByLabel(renderer, held.label);
        if (live && live === held.host) {
          const enabledAtRelease = !isDisabled(live);
          release(live);
          if (enabledAtRelease) expectedRequests += 1;
          else bump(trace, 'releaseWhileDisabled');
          trace.steps.push(
            `releaseHeld:${enabledAtRelease ? 'enabled' : 'disabled'}`,
          );
        } else {
          trace.steps.push('releaseHeld:unmounted');
        }
        held = null;
      } else {
        trace.steps.push('releaseHeld:none');
      }
    } else if (action === 'cancelHeld') {
      if (held) {
        const live = hostByLabel(renderer, held.label);
        if (live && live === held.host) {
          terminate(live);
          trace.steps.push('cancelHeld');
        } else {
          trace.steps.push('cancelHeld:unmounted');
        }
        held = null;
      } else {
        trace.steps.push('cancelHeld:none');
      }
    } else if (action === 'resolve' || action === 'reject') {
      const open = log.pending.filter(d => !d.settled);
      if (open.length > 0) {
        const d = rng.pick(open);
        if (action === 'resolve') d.resolve();
        else d.reject(new Error(`seed ${seed} rejected request`));
        await settle();
        trace.steps.push(action);
      } else {
        trace.steps.push(`${action}:none`);
      }
    } else {
      const ms = rng.int(1, 400);
      advance(ms);
      trace.steps.push(`wait:${ms}`);
    }
    check(
      trace,
      modalSurfaces(renderer) <= 1,
      `step ${i}: ${modalSurfaces(renderer)} modal surfaces`,
    );
  }

  if (held) {
    const live = hostByLabel(renderer, held.label);
    if (live && live === held.host) {
      const enabledAtRelease = !isDisabled(live);
      release(live);
      if (enabledAtRelease) expectedRequests += 1;
      else bump(trace, 'releaseWhileDisabled');
    }
    held = null;
  }
  for (const d of log.pending) d.resolve();
  await settle();
  flushAll();

  const releasedWhileDisabled = trace.counters.releaseWhileDisabled ?? 0;
  bump(trace, 'requests', log.requests);
  bump(trace, 'expectedRequests', expectedRequests);
  bump(trace, 'navigations', log.navigations);
  bump(trace, 'expectedNavigations', expectedNavigations);
  bump(trace, 'toggleTaps', toggleTaps);
  // A press that started on an enabled button and ended after the host
  // disabled it still reaches the consumer (RN Pressability only gates the
  // touch start); those are tallied separately so the contract test below
  // owns that verdict rather than every seed.
  check(
    trace,
    log.requests >= expectedRequests &&
      log.requests <= expectedRequests + releasedWhileDisabled,
    `requests ${log.requests} vs expected ${expectedRequests} (+${releasedWhileDisabled} disabled-at-release)`,
  );
  check(
    trace,
    log.navigations === expectedNavigations,
    `navigations ${log.navigations} vs expected ${expectedNavigations}`,
  );
  check(
    trace,
    log.toggles.length === toggleTaps,
    `toggle callbacks ${log.toggles.length} vs taps ${toggleTaps}`,
  );
  const finalToggle = log.toggles[log.toggles.length - 1] ?? initialToggle;
  check(
    trace,
    finalToggle === (toggleTaps % 2 === 1 ? !initialToggle : initialToggle),
    `toggle parity broke: ${initialToggle} after ${toggleTaps} taps → ${finalToggle}`,
  );
  const toggleHost = hostByLabel(renderer, 'Sound cues');
  if (toggleHost) {
    check(
      trace,
      toggleHost.props.accessibilityState?.checked === finalToggle,
      `toggle a11y checked=${toggleHost.props.accessibilityState?.checked} but value=${finalToggle}`,
    );
  }
  check(
    trace,
    loadingSurfaces(renderer) === 0,
    `orphan loading state after every request settled (${loadingSurfaces(renderer)})`,
  );
  if (screenMounted) {
    check(
      trace,
      hostByLabel(renderer, 'Rate my shot') !== null,
      'rate button never came back after async settled',
    );
  } else {
    check(
      trace,
      pressableHosts(renderer).length === 0,
      `${pressableHosts(renderer).length} pressables survived navigation away`,
    );
  }
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 2 — decision dialog: BrandDialog confirm/cancel/close/backdrop/
// hardware-back spam with the two consumer patterns the app uses.
// ---------------------------------------------------------------------------

type DialogPattern = 'closeSync' | 'busyUntilSettled';

interface DialogLog {
  confirms: number;
  cancels: number;
  dismisses: number;
  pending: Deferred[];
}

function DecisionScreen(props: { log: DialogLog; pattern: DialogPattern }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const confirm = () => {
    props.log.confirms += 1;
    if (props.pattern === 'closeSync') {
      setOpen(false);
      return;
    }
    setBusy(true);
    const d = deferred();
    props.log.pending.push(d);
    d.promise
      .catch(() => {})
      .then(() => {
        if (!mounted.current) return;
        setBusy(false);
        setOpen(false);
      });
  };
  const dismiss = () => {
    props.log.dismisses += 1;
    setOpen(false);
  };

  return (
    <View>
      <Button label="Replace plan" onPress={() => setOpen(true)} />
      <BrandDialog
        visible={open}
        title="Replace your plan?"
        detail="Your current plan will be replaced."
        tone="danger"
        eyebrow="Confirm action"
        onDismiss={busy ? undefined : dismiss}
        testID="decision-dialog"
        actions={[
          {
            label: 'Keep current plan',
            variant: 'dark',
            disabled: busy,
            onPress: () => {
              props.log.cancels += 1;
              setOpen(false);
            },
          },
          {
            label: 'Replace',
            variant: 'danger',
            disabled: busy,
            onPress: confirm,
          },
        ]}
      />
    </View>
  );
}

function dialogVisible(renderer: ReactTestRenderer): boolean {
  return countBy(renderer, n => n.props.testID === 'decision-dialog') > 0;
}

async function scenarioDialog(
  seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  const pattern: DialogPattern = rng.pick(['closeSync', 'busyUntilSettled']);
  trace.steps.push(`pattern:${pattern}`);
  const log: DialogLog = { confirms: 0, cancels: 0, dismisses: 0, pending: [] };
  const renderer = render(<DecisionScreen log={log} pattern={pattern} />);

  let expectedConfirms = 0;
  let expectedCancels = 0;
  let expectedDismisses = 0;
  let openCycles = 1;
  const steps = rng.int(6, 24);

  for (let i = 0; i < steps; i += 1) {
    const action = rng.pick([
      'confirm',
      'confirm',
      'cancel',
      'close',
      'backdrop',
      'hardwareBack',
      'reopen',
      'resolve',
      'reject',
      'wait',
      'confirmAndCancelSameFrame',
    ]);
    const dialogRoot = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'decision-dialog',
    )[0];
    if (action === 'confirm' || action === 'cancel' || action === 'close') {
      const label =
        action === 'confirm'
          ? 'Replace'
          : action === 'cancel'
            ? 'Keep current plan'
            : 'Close dialog';
      const taps = rng.pick([1, 2, 2, 3]);
      const useTouch = rng.bool(0.5);
      let fired = 0;
      for (let t = 0; t < taps; t += 1) {
        const live = hostByLabel(renderer, label);
        if (!live) break;
        const enabled = !isDisabled(live);
        if (useTouch) {
          if (grant(live)) {
            advance(rng.int(0, 120));
            const still = hostByLabel(renderer, label);
            if (still) release(still);
          }
        } else {
          click(live);
        }
        if (enabled) fired += 1;
      }
      if (label === 'Replace') expectedConfirms += fired;
      if (label === 'Keep current plan') expectedCancels += fired;
      if (label === 'Close dialog') expectedDismisses += fired;
      trace.steps.push(
        `${action}x${taps}:${useTouch ? 'touch' : 'click'}:fired${fired}`,
      );
    } else if (action === 'confirmAndCancelSameFrame') {
      const confirmHost = hostByLabel(renderer, 'Replace');
      const cancelHost = hostByLabel(renderer, 'Keep current plan');
      if (confirmHost && cancelHost && !isDisabled(confirmHost)) {
        act(() => {
          confirmHost.props.onClick({
            currentTarget: confirmHost,
            target: confirmHost,
            nativeEvent: {},
          });
          cancelHost.props.onClick({
            currentTarget: cancelHost,
            target: cancelHost,
            nativeEvent: {},
          });
        });
        // Both handlers run before React re-renders: the consumer sees both
        // intents. The dialog must still collapse to a single closed state.
        expectedConfirms += 1;
        expectedCancels += 1;
        trace.steps.push('confirmAndCancelSameFrame');
      } else {
        trace.steps.push('confirmAndCancelSameFrame:skip');
      }
    } else if (action === 'backdrop') {
      // The scrim is the only pressable without a label inside the dialog root.
      const scrim = dialogRoot
        ? pressableHosts(renderer).find(
            h =>
              h.props.accessibilityLabel === undefined &&
              h.props.accessible === false,
          )
        : undefined;
      if (scrim) {
        const enabled = scrim.props.onStartShouldSetResponder() === true;
        if (grant(scrim)) {
          const stillScrim = pressableHosts(renderer).find(
            h => h.props.accessible === false,
          );
          if (stillScrim) release(stillScrim);
        }
        if (enabled) expectedDismisses += 1;
        trace.steps.push(`backdrop:${enabled ? 'enabled' : 'disabled'}`);
      } else {
        trace.steps.push('backdrop:absent');
      }
    } else if (action === 'hardwareBack') {
      const modal = renderer.root.findAll(
        n =>
          typeof n.props.onRequestClose !== 'undefined' &&
          n.props.visible === true,
      )[0];
      const handler = modal?.props.onRequestClose;
      if (typeof handler === 'function') {
        act(() => {
          handler();
        });
        expectedDismisses += 1;
        trace.steps.push('hardwareBack');
      } else {
        trace.steps.push('hardwareBack:noop');
      }
    } else if (action === 'reopen') {
      const host = hostByLabel(renderer, 'Replace plan');
      if (host && !dialogVisible(renderer)) {
        click(host);
        openCycles += 1;
        trace.steps.push('reopen');
      } else {
        trace.steps.push('reopen:skip');
      }
    } else if (action === 'resolve' || action === 'reject') {
      const open = log.pending.filter(d => !d.settled);
      if (open.length > 0) {
        const d = rng.pick(open);
        if (action === 'resolve') d.resolve();
        else d.reject(new Error(`seed ${seed} rejected confirm`));
        await settle();
        trace.steps.push(action);
      } else {
        trace.steps.push(`${action}:none`);
      }
    } else {
      const ms = rng.int(1, 300);
      advance(ms);
      trace.steps.push(`wait:${ms}`);
    }
    const surfaces = modalSurfaces(renderer);
    check(trace, surfaces <= 1, `step ${i}: ${surfaces} modal surfaces`);
    const confirmHosts = pressableHosts(renderer).filter(
      h => h.props.accessibilityLabel === 'Replace',
    ).length;
    check(
      trace,
      confirmHosts <= 1,
      `step ${i}: ${confirmHosts} confirm buttons`,
    );
  }

  const confirmStillPending = log.pending.some(d => !d.settled);
  for (const d of log.pending) d.resolve();
  await settle();
  flushAll();

  bump(trace, 'confirms', log.confirms);
  bump(trace, 'expectedConfirms', expectedConfirms);
  bump(trace, 'cancels', log.cancels);
  bump(trace, 'dismisses', log.dismisses);
  bump(trace, 'openCycles', openCycles);
  check(
    trace,
    log.confirms === expectedConfirms,
    `confirms ${log.confirms} vs expected ${expectedConfirms}`,
  );
  check(
    trace,
    log.confirms <= openCycles,
    `confirmed ${log.confirms} times across ${openCycles} dialog openings`,
  );
  check(
    trace,
    log.cancels === expectedCancels,
    `cancels ${log.cancels} vs expected ${expectedCancels}`,
  );
  check(
    trace,
    log.dismisses === expectedDismisses,
    `dismisses ${log.dismisses} vs expected ${expectedDismisses}`,
  );
  if (confirmStillPending) {
    check(
      trace,
      !dialogVisible(renderer),
      'dialog still open after its confirm settled (orphan busy state)',
    );
  }
  const busyButtons = pressableHosts(renderer).filter(
    h =>
      (h.props.accessibilityLabel === 'Replace' ||
        h.props.accessibilityLabel === 'Keep current plan') &&
      isDisabled(h),
  ).length;
  check(
    trace,
    busyButtons === 0,
    `${busyButtons} dialog actions still disabled after every confirm settled`,
  );
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 3 — BrandNotice: imperative notices fired from several sources
// before/while/after the host is mounted, dismissed every way at once.
// ---------------------------------------------------------------------------

function NoticeApp(props: { hostMounted: boolean }) {
  return (
    <View>
      <Text>App</Text>
      {props.hostMounted ? <BrandNoticeHost /> : null}
    </View>
  );
}

function noticeVisible(renderer: ReactTestRenderer): number {
  return countBy(renderer, n => n.props.testID === 'brand-notice');
}

function noticeTitle(renderer: ReactTestRenderer): string | null {
  const dialog = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === 'brand-notice',
  )[0];
  if (!dialog) return null;
  const texts = dialog
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string');
  return texts.find(t => t.startsWith('Notice ')) ?? null;
}

async function scenarioNotice(
  seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  let hostMounted = rng.bool(0.7);
  const renderer = render(<NoticeApp hostMounted={hostMounted} />);
  let shown = 0;
  const presentedTitles = new Set<string>();
  let lastShownTitle: string | null = null;
  const steps = rng.int(6, 24);

  const observe = () => {
    const title = noticeTitle(renderer);
    if (title) presentedTitles.add(title);
  };

  for (let i = 0; i < steps; i += 1) {
    const action = rng.pick([
      'show',
      'show',
      'showBurst',
      'dismissAction',
      'dismissClose',
      'dismissBackdrop',
      'dismissBack',
      'toggleHost',
      'wait',
    ]);
    if (action === 'show' || action === 'showBurst') {
      const n = action === 'show' ? 1 : rng.int(2, 4);
      act(() => {
        for (let k = 0; k < n; k += 1) {
          shown += 1;
          lastShownTitle = `Notice ${shown}`;
          showBrandNotice({
            title: lastShownTitle,
            detail: `Detail for notice ${shown}`,
            tone: rng.pick(['neutral', 'danger', 'success']),
            eyebrow: rng.bool() ? 'Link unavailable' : undefined,
            actionLabel: rng.bool() ? 'Got it' : undefined,
          });
        }
      });
      observe();
      if (hostMounted) {
        check(
          trace,
          noticeTitle(renderer) === lastShownTitle,
          `after ${action}: showing ${noticeTitle(renderer)} not ${lastShownTitle}`,
        );
      }
      trace.steps.push(`${action}x${n}:${hostMounted ? 'mounted' : 'pending'}`);
    } else if (
      action === 'dismissAction' ||
      action === 'dismissClose' ||
      action === 'dismissBackdrop' ||
      action === 'dismissBack'
    ) {
      const taps = rng.pick([1, 2, 3]);
      let fired = 0;
      for (let t = 0; t < taps; t += 1) {
        if (action === 'dismissBack') {
          const modal = renderer.root.findAll(
            n =>
              typeof n.props.onRequestClose === 'function' &&
              n.props.visible === true,
          )[0];
          if (!modal) break;
          act(() => {
            modal.props.onRequestClose();
          });
          fired += 1;
          continue;
        }
        let host: ReactTestInstance | undefined;
        if (action === 'dismissAction') {
          host = pressableHosts(renderer).find(
            h =>
              h.props.accessibilityLabel === 'Got it' &&
              noticeVisible(renderer) > 0,
          );
        } else if (action === 'dismissClose') {
          host = hostByLabel(renderer, 'Close dialog') ?? undefined;
        } else {
          host = pressableHosts(renderer).find(
            h => h.props.accessible === false,
          );
        }
        if (!host) break;
        if (rng.bool()) {
          click(host);
        } else if (grant(host)) {
          advance(rng.int(0, 100));
          const still = pressableHosts(renderer).find(h => h === host);
          if (still) release(still);
        }
        fired += 1;
      }
      trace.steps.push(`${action}x${taps}:fired${fired}`);
      if (fired > 0) {
        check(
          trace,
          noticeVisible(renderer) === 0,
          `notice still visible after ${action}`,
        );
      }
    } else if (action === 'toggleHost') {
      hostMounted = !hostMounted;
      act(() => {
        renderer.update(<NoticeApp hostMounted={hostMounted} />);
      });
      observe();
      trace.steps.push(`toggleHost:${hostMounted ? 'mount' : 'unmount'}`);
    } else {
      const ms = rng.int(1, 300);
      advance(ms);
      trace.steps.push(`wait:${ms}`);
    }
    const visible = noticeVisible(renderer);
    check(trace, visible <= 1, `step ${i}: ${visible} notices visible at once`);
    check(
      trace,
      modalSurfaces(renderer) <= 1,
      `step ${i}: ${modalSurfaces(renderer)} modal surfaces`,
    );
    if (!hostMounted) {
      check(trace, visible === 0, `step ${i}: notice rendered without a host`);
    }
  }

  // Drain: whatever is pending must surface exactly once on the next mount,
  // then the module-level slot must be empty for the next seed.
  if (!hostMounted) {
    hostMounted = true;
    act(() => {
      renderer.update(<NoticeApp hostMounted />);
    });
    observe();
  }
  if (shown > 0 && lastShownTitle) {
    const visibleTitle = noticeTitle(renderer);
    check(
      trace,
      visibleTitle === null || visibleTitle === lastShownTitle,
      `stale notice ${visibleTitle} surfaced instead of ${lastShownTitle}`,
    );
  }
  let guard = 0;
  while (noticeVisible(renderer) > 0 && guard < 5) {
    const closeHost = hostByLabel(renderer, 'Close dialog');
    if (!closeHost) break;
    click(closeHost);
    guard += 1;
  }
  check(trace, noticeVisible(renderer) === 0, 'notice could not be dismissed');
  act(() => {
    renderer.update(<NoticeApp hostMounted={false} />);
  });
  act(() => {
    renderer.update(<NoticeApp hostMounted />);
  });
  check(
    trace,
    noticeVisible(renderer) === 0,
    'a dismissed notice re-surfaced on host remount',
  );
  flushAll();
  bump(trace, 'shown', shown);
  bump(trace, 'presentedDistinct', presentedTitles.size);
  bump(trace, 'dropped', Math.max(0, shown - presentedTitles.size));
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 4 — ScoreRing / RevealFill / CheckpointRow churn mid-animation,
// including reduce-motion flips through the observer the module registered.
// ---------------------------------------------------------------------------

function reduceMotionListener(): ((value: boolean) => void) | null {
  const call = (
    AccessibilityInfo.addEventListener as jest.Mock
  ).mock.calls.find(c => c[0] === 'reduceMotionChanged');
  const listener = call?.[1];
  return typeof listener === 'function' ? listener : null;
}

function ringScoreText(renderer: ReactTestRenderer): string | null {
  const texts = renderer.root
    .findAllByType(Text)
    .map(t => t.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string');
  return texts.find(t => /^\d\.\d$|^\d\d\.\d$|^—$/.test(t)) ?? null;
}

async function scenarioScoreChurn(
  _seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  const scores: (number | null)[] = [null, 0, 2.5, 4.9, 7.3, 8.8, 10, 12.4];
  let score = rng.pick(scores);
  let dark = rng.bool();
  let checkpointTaps = 0;
  let checkpointCalls = 0;
  const tree = () => (
    <View>
      <ScoreRing score={score} dark={dark} label="Technique" />
      <RevealFill style={{ width: 120 }} />
      <CheckpointRow
        name="Paddle prep"
        score={score === null ? null : Math.min(100, score * 10)}
        band={score === null ? 'unscored' : score >= 7 ? 'green' : 'yellow'}
        onPress={() => {
          checkpointCalls += 1;
        }}
        revealDelay={rng.int(0, 400)}
      />
    </View>
  );
  const renderer = render(tree());
  const steps = rng.int(8, 24);
  let reducedNow = false;
  // The count-up is driven by requestAnimationFrame, so the number may keep
  // the previous value until the first frame (~16ms) after a score change.
  let shownAtChange: number | null = null;
  let msSinceChange = Number.POSITIVE_INFINITY;

  for (let i = 0; i < steps; i += 1) {
    const action = rng.pick([
      'changeScore',
      'changeScore',
      'frame',
      'frame',
      'toggleDark',
      'reduceMotion',
      'tapCheckpoint',
      'remount',
    ]);
    if (action === 'changeScore') {
      const before = ringScoreText(renderer);
      shownAtChange = before === null || before === '—' ? null : Number(before);
      msSinceChange = 0;
      score = rng.pick(scores);
      act(() => {
        renderer.update(tree());
      });
      trace.steps.push(`score:${score}`);
    } else if (action === 'frame') {
      const ms = rng.int(1, 500);
      advance(ms);
      msSinceChange += ms;
      trace.steps.push(`frame:${ms}`);
    } else if (action === 'toggleDark') {
      dark = !dark;
      act(() => {
        renderer.update(tree());
      });
      trace.steps.push('toggleDark');
    } else if (action === 'reduceMotion') {
      const listener = reduceMotionListener();
      check(trace, listener !== null, 'reduce-motion observer not registered');
      if (listener) {
        reducedNow = !reducedNow;
        act(() => {
          listener(reducedNow);
        });
      }
      trace.steps.push(`reduceMotion:${reducedNow}`);
    } else if (action === 'tapCheckpoint') {
      const hosts = pressableHosts(renderer);
      check(trace, hosts.length === 1, `step ${i}: ${hosts.length} pressables`);
      const host = hosts[0];
      if (host) {
        const expectedLabel = `Paddle prep, ${
          score === null
            ? 'not read'
            : `${Math.round(Math.min(100, score * 10))} out of 100`
        }`;
        check(
          trace,
          host.props.accessibilityLabel === expectedLabel,
          `step ${i}: checkpoint label ${host.props.accessibilityLabel}`,
        );
        const taps = rng.pick([1, 2, 3]);
        for (let t = 0; t < taps; t += 1) click(host);
        checkpointTaps += taps;
        trace.steps.push(`tapCheckpointx${taps}`);
      } else {
        trace.steps.push('tapCheckpoint:absent');
      }
    } else {
      act(() => {
        renderer.update(<View />);
      });
      act(() => {
        renderer.update(tree());
      });
      shownAtChange = null;
      msSinceChange = Number.POSITIVE_INFINITY;
      trace.steps.push('remount');
    }
    const text = ringScoreText(renderer);
    check(trace, text !== null, `step ${i}: score text missing`);
    if (score === null) {
      check(trace, text === '—', `step ${i}: null score rendered ${text}`);
    } else if (text !== null) {
      const shown = Number(text);
      const inRange =
        Number.isFinite(shown) && shown >= -0.05 && shown <= score + 0.05;
      const oneFrameStale =
        msSinceChange < 16 && shownAtChange !== null && shown === shownAtChange;
      check(
        trace,
        inRange || oneFrameStale,
        `step ${i}: displayed ${text} outside [0, ${score}] (${msSinceChange}ms after change)`,
      );
    }
  }

  // Let the count-up land.
  advance(1_200);
  flushAll();
  const finalText = ringScoreText(renderer);
  const expectedText = score === null ? '—' : score.toFixed(1);
  check(
    trace,
    finalText === expectedText,
    `final score text ${finalText} vs ${expectedText}`,
  );
  const ring = renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.startsWith('Technique score'),
  )[0];
  if (score !== null) {
    check(
      trace,
      ring?.props.accessibilityLabel ===
        `Technique score ${score.toFixed(1)} out of 10`,
      `ring a11y label ${ring?.props.accessibilityLabel}`,
    );
  }
  check(
    trace,
    checkpointCalls === checkpointTaps,
    `checkpoint onPress ${checkpointCalls} vs taps ${checkpointTaps}`,
  );
  bump(trace, 'checkpointTaps', checkpointTaps);
  if (reducedNow) {
    const listener = reduceMotionListener();
    if (listener) {
      act(() => {
        listener(false);
      });
    }
  }
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 5 — static surfaces under prop churn: MascotMoment/MascotStage,
// every Icon, Pill, Stat, EmptyState, ErrorState retry spam, safe-area hook.
// ---------------------------------------------------------------------------

const ICON_NAMES: readonly IconName[] = [
  'home',
  'library',
  'progress',
  'settings',
  'camera',
  'upload',
  'back',
  'close',
  'check',
  'chevron',
  'arrow',
  'play',
  'pause',
  'plus',
  'court',
  'person',
  'volume',
  'flame',
  'bookmark',
  'shield',
  'spark',
  'bell',
  'star',
  'lock',
  'crown',
];

const POSES = Object.keys(MASCOT_SOURCES) as MascotPose[];
const TONES: readonly MascotTone[] = ['volt', 'court', 'warn', 'danger'];

/** The mocked module object: `safeArea.ts` reads `initialWindowMetrics`
 * through the module namespace on every call, so swapping it here is what
 * the hook observes. */
const safeAreaModule = jest.requireMock('react-native-safe-area-context') as {
  initialWindowMetrics: {
    insets: { top: number; bottom: number; left: number; right: number };
  } | null;
};

function SafeAreaProbe(props: {
  onInsets: (top: number, bottom: number) => void;
}) {
  const insets = useReliableSafeAreaInsets();
  props.onInsets(insets.top, insets.bottom);
  return null;
}

async function scenarioStaticChurn(
  _seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  let retries = 0;
  let retryTaps = 0;
  let probeTop = -1;
  let probeBottom = -1;
  let liveTop = 0;
  let liveBottom = 0;
  // null = the native side reported no launch metrics (iOS fallbacks apply).
  const initialRef: { current: { top: number; bottom: number } | null } = {
    current: null,
  };

  const mockedInsets = useSafeAreaInsets as jest.Mock;
  const setInsets = (top: number, bottom: number) => {
    liveTop = top;
    liveBottom = bottom;
    mockedInsets.mockReturnValue({ top, bottom, left: 0, right: 0 });
  };
  const setInitial = (next: { top: number; bottom: number } | null) => {
    initialRef.current = next;
    safeAreaModule.initialWindowMetrics = next
      ? { insets: { top: next.top, bottom: next.bottom, left: 0, right: 0 } }
      : null;
  };
  const randomInitial = () =>
    rng.bool(0.3)
      ? null
      : { top: rng.pick([0, 20, 44, 47, 59]), bottom: rng.pick([0, 21, 34]) };
  setInsets(rng.pick([0, 20, 44, 47, 59]), rng.pick([0, 21, 34]));
  setInitial(randomInitial());

  const tree = () => (
    <View>
      <MascotMoment
        pose={rng.pick(POSES)}
        tone={rng.pick(TONES)}
        dark={rng.bool()}
        compact={rng.bool()}
        eyebrow="Coach tip"
        caption="Keep your paddle up between shots."
        accessibilityLabel="Coach tip banner"
        testID="mascot-moment"
      />
      <MascotStage
        pose={rng.pick(POSES)}
        tone={rng.pick(TONES)}
        dark={rng.bool()}
        compact={rng.bool()}
        testID="mascot-stage"
      />
      {ICON_NAMES.filter(() => rng.bool(0.5)).map(name => (
        <Icon key={name} name={name} size={rng.pick([16, 18, 22, 28])} />
      ))}
      <Pill
        label="Validated"
        tone={rng.pick(['neutral', 'good', 'warn', 'bad'])}
      />
      <Stat label="Sessions" value={String(rng.int(0, 999))} />
      <EmptyState
        title="No shots yet"
        body="Record a rally to see your first breakdown."
        dark={rng.bool()}
      />
      <ErrorState
        title="Could not load"
        detail="Check your connection and try again."
        onRetry={() => {
          retries += 1;
        }}
      />
      <SafeAreaProbe
        onInsets={(top, bottom) => {
          probeTop = top;
          probeBottom = bottom;
        }}
      />
    </View>
  );

  const renderer = render(tree());
  const steps = rng.int(6, 20);
  for (let i = 0; i < steps; i += 1) {
    const action = rng.pick([
      'churn',
      'churn',
      'retry',
      'insets',
      'remount',
      'wait',
    ]);
    if (action === 'churn') {
      act(() => {
        renderer.update(tree());
      });
      trace.steps.push('churn');
    } else if (action === 'retry') {
      const host = hostByLabel(renderer, 'Try again');
      if (host) {
        const taps = rng.pick([1, 2, 3]);
        for (let t = 0; t < taps; t += 1) {
          if (rng.bool()) click(host);
          else if (grant(host)) {
            advance(rng.int(0, 150));
            release(host);
          }
        }
        retryTaps += taps;
        trace.steps.push(`retryx${taps}`);
      }
    } else if (action === 'insets') {
      setInsets(rng.pick([0, 20, 44, 47, 59]), rng.pick([0, 21, 34]));
      if (rng.bool(0.4)) setInitial(randomInitial());
      act(() => {
        renderer.update(tree());
      });
      trace.steps.push(
        `insets:${liveTop}/${liveBottom}:${initialRef.current ? `${initialRef.current.top}/${initialRef.current.bottom}` : 'null'}`,
      );
    } else if (action === 'remount') {
      act(() => {
        renderer.update(<View />);
      });
      act(() => {
        renderer.update(tree());
      });
      trace.steps.push('remount');
    } else {
      advance(rng.int(1, 300));
      trace.steps.push('wait');
    }

    const images = renderer.root.findAllByType(Image);
    check(
      trace,
      images.length >= 2 && images.every(img => img.props.source !== undefined),
      `step ${i}: mascot images ${images.length}, all sourced=${images.every(
        img => img.props.source !== undefined,
      )}`,
    );
    const moment = renderer.root.findAll(
      n => typeof n.type === 'string' && n.props.testID === 'mascot-moment',
    );
    check(
      trace,
      moment.length === 1,
      `step ${i}: ${moment.length} mascot moments`,
    );
    check(
      trace,
      moment[0]?.props.accessibilityLabel === 'Coach tip banner',
      `step ${i}: mascot a11y label ${moment[0]?.props.accessibilityLabel}`,
    );
    const initial = initialRef.current;
    const expectedTop = Math.max(liveTop, initial ? initial.top : 44);
    const expectedBottom = Math.max(liveBottom, initial ? initial.bottom : 34);
    check(
      trace,
      probeTop === expectedTop && probeBottom === expectedBottom,
      `step ${i}: safe area ${probeTop}/${probeBottom} vs ${expectedTop}/${expectedBottom}`,
    );
  }
  check(trace, retries === retryTaps, `retry ${retries} vs taps ${retryTaps}`);
  bump(trace, 'retryTaps', retryTaps);
  for (const band of ['green', 'yellow', 'red', 'unscored'] as const) {
    check(trace, typeof bandColor(band) === 'string', `bandColor(${band})`);
  }
  check(trace, bandColor('unscored') === color.inkSoft, 'unscored band color');
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
  setInsets(0, 0);
  setInitial({ top: 0, bottom: 0 });
}

// ---------------------------------------------------------------------------
// Scenario 6 — bare PressableScale burst: N taps through both input paths
// with press-out transitions still in flight, plus a disabled flip.
// ---------------------------------------------------------------------------

function ToggleablePressable(props: {
  onPress: () => void;
  onDisabledRef: (set: (d: boolean) => void) => void;
}) {
  const [disabled, setDisabled] = useState(false);
  props.onDisabledRef(setDisabled);
  return (
    <PressableScale
      onPress={props.onPress}
      disabled={disabled}
      accessibilityLabel="Burst"
      testID="burst"
    >
      <Text>Burst</Text>
    </PressableScale>
  );
}

async function scenarioPressableBurst(
  _seed: number,
  rng: Rng,
  trace: Trace,
): Promise<void> {
  let presses = 0;
  let expected = 0;
  let setDisabled: (d: boolean) => void = () => {};
  const renderer = render(
    <ToggleablePressable
      onPress={() => {
        presses += 1;
      }}
      onDisabledRef={set => {
        setDisabled = set;
      }}
    />,
  );
  const steps = rng.int(10, 40);
  let holding = false;
  let releasedWhileDisabled = 0;
  for (let i = 0; i < steps; i += 1) {
    const host = hostByLabel(renderer, 'Burst');
    check(trace, host !== null, `step ${i}: pressable missing`);
    if (!host) break;
    const action = rng.pick([
      'click',
      'click',
      'tap',
      'tap',
      'tapNoWait',
      'down',
      'up',
      'cancel',
      'disable',
      'enable',
      'wait',
    ]);
    const enabled = !isDisabled(host);
    if (action === 'click') {
      click(host);
      if (enabled) expected += 1;
    } else if (action === 'tap' || action === 'tapNoWait') {
      if (holding) {
        trace.steps.push(`${action}:skip-holding`);
        continue;
      }
      if (grant(host)) {
        if (action === 'tap') advance(rng.int(1, 200));
        release(host);
        expected += 1;
      }
    } else if (action === 'down') {
      if (!holding && grant(host)) holding = true;
    } else if (action === 'up') {
      if (holding) {
        const nowEnabled = !isDisabled(host);
        release(host);
        holding = false;
        if (nowEnabled) expected += 1;
        else releasedWhileDisabled += 1;
      }
    } else if (action === 'cancel') {
      if (holding) {
        terminate(host);
        holding = false;
      }
    } else if (action === 'disable' || action === 'enable') {
      act(() => {
        setDisabled(action === 'disable');
      });
    } else {
      advance(rng.int(1, 300));
    }
    trace.steps.push(`${action}:${enabled ? 'en' : 'dis'}`);
  }
  if (holding) {
    const host = hostByLabel(renderer, 'Burst');
    if (host) {
      const nowEnabled = !isDisabled(host);
      release(host);
      if (nowEnabled) expected += 1;
      else releasedWhileDisabled += 1;
    }
  }
  flushAll();
  bump(trace, 'presses', presses);
  bump(trace, 'expected', expected);
  bump(trace, 'releaseWhileDisabled', releasedWhileDisabled);
  // A press released after the control became disabled is counted separately:
  // the dedicated contract test below pins that it still reaches onPress.
  check(
    trace,
    presses >= expected && presses <= expected + releasedWhileDisabled,
    `presses ${presses} vs expected ${expected} (+${releasedWhileDisabled} disabled-at-release)`,
  );
  act(() => renderer.unmount());
  flushAll();
  check(
    trace,
    jest.getTimerCount() === 0,
    `${jest.getTimerCount()} timers leaked after unmount`,
  );
}

// ---------------------------------------------------------------------------
// Campaign driver.
// ---------------------------------------------------------------------------

const SCENARIOS: readonly {
  name: string;
  run: (seed: number, rng: Rng, trace: Trace) => Promise<void>;
}[] = [
  { name: 'async-request-screen', run: scenarioAsyncRequest },
  { name: 'decision-dialog', run: scenarioDialog },
  { name: 'brand-notice', run: scenarioNotice },
  { name: 'score-ring-churn', run: scenarioScoreChurn },
  { name: 'static-churn+safe-area', run: scenarioStaticChurn },
  { name: 'pressable-burst', run: scenarioPressableBurst },
];

function scenarioFor(seed: number) {
  const scenario = SCENARIOS[seed % SCENARIOS.length];
  if (!scenario) throw new Error('no scenario');
  return scenario;
}

async function runIteration(seed: number): Promise<Outcome> {
  const scenario = scenarioFor(seed);
  const rng = new Rng(seed);
  consoleErrors.length = 0;
  unhandledRejections.length = 0;
  const trace = newTrace();
  try {
    await scenario.run(seed, rng, trace);
  } catch (error) {
    trace.violations.push(
      `threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  await settle();
  const errors = [...consoleErrors];
  const rejections = [...unhandledRejections];
  if (errors.length > 0)
    trace.violations.push(`console.error x${errors.length}`);
  if (rejections.length > 0) {
    trace.violations.push(`unhandled rejections x${rejections.length}`);
  }
  return {
    seed,
    scenario: scenario.name,
    steps: trace.steps,
    counters: trace.counters,
    violations: trace.violations,
    consoleErrors: errors,
    unhandledRejections: rejections,
    ok: trace.violations.length === 0,
  };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

const ITERATIONS = envInt('STRESS_ITER', 24);
const SEED_BASE = envInt('STRESS_SEED_BASE', 1000);
const REPEAT = Math.max(1, envInt('STRESS_REPEAT', 1));
const ONLY_SEED = process.env.STRESS_SEED ? envInt('STRESS_SEED', 0) : null;
const OUT = process.env.STRESS_OUT;

const plan: [number, number][] = [];
if (ONLY_SEED !== null) {
  for (let r = 0; r < REPEAT; r += 1) plan.push([ONLY_SEED, r]);
} else {
  for (let i = 0; i < ITERATIONS; i += 1) {
    for (let r = 0; r < REPEAT; r += 1) plan.push([SEED_BASE + i, r]);
  }
}

let errorSpy: jest.SpyInstance | null = null;

beforeAll(() => {
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  if (OUT) {
    const table = {
      unit: 'cmp-design-system',
      lens: 'rapid-interaction',
      iterations: outcomes.length,
      failed: outcomes.filter(o => !o.ok).length,
      scenarios: Object.fromEntries(
        SCENARIOS.map(s => [
          s.name,
          {
            ran: outcomes.filter(o => o.scenario === s.name).length,
            failed: outcomes.filter(o => o.scenario === s.name && !o.ok).length,
          },
        ]),
      ),
      outcomes,
    };
    fs.writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`);
  }
});

beforeEach(() => {
  jest.useFakeTimers();
  errorSpy = jest.spyOn(console, 'error').mockImplementation((...args) => {
    consoleErrors.push(formatConsoleArgs(args));
  });
});

afterEach(() => {
  errorSpy?.mockRestore();
  errorSpy = null;
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('design-system rapid-interaction campaign', () => {
  it.each(plan)(
    'seed %i (run %i) holds every interaction invariant',
    async (seed, run) => {
      const outcome = await runIteration(seed);
      if (run > 0) outcome.scenario = `${outcome.scenario}#${run}`;
      outcomes.push(outcome);
      expect({
        seed,
        scenario: outcome.scenario,
        violations: outcome.violations,
        consoleErrors: outcome.consoleErrors,
        unhandledRejections: outcome.unhandledRejections,
      }).toEqual({
        seed,
        scenario: outcome.scenario,
        violations: [],
        consoleErrors: [],
        unhandledRejections: [],
      });
    },
  );
});

/**
 * Known gap, pinned with `it.failing` so the suite stays green today and
 * turns red the day it is fixed: `PressableScale` forwards `disabled` to
 * RN `Pressable`, whose Pressability only re-checks `disabled` for
 * accessibility clicks and for granting a new touch — a finger that went
 * down while enabled and lifts after the control was disabled still fires
 * `onPress` (react-native/Libraries/Pressability/Pressability.js,
 * RESPONDER_RELEASE branch of _performTransitionSideEffects).
 */
describe('design-system disabled contract under a held press', () => {
  it.failing(
    'a press that starts enabled and ends after the control was disabled does not reach onPress',
    () => {
      let presses = 0;
      let setDisabled: (d: boolean) => void = () => {};
      const renderer = render(
        <ToggleablePressable
          onPress={() => {
            presses += 1;
          }}
          onDisabledRef={set => {
            setDisabled = set;
          }}
        />,
      );
      const host = hostByLabel(renderer, 'Burst');
      expect(host).not.toBeNull();
      if (!host) return;
      expect(grant(host)).toBe(true);
      act(() => {
        setDisabled(true);
      });
      const live = hostByLabel(renderer, 'Burst');
      expect(live).not.toBeNull();
      if (!live) return;
      expect(isDisabled(live)).toBe(true);
      release(live);
      flushAll();
      expect(presses).toBe(0);
      act(() => renderer.unmount());
    },
  );
});
