import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * STRESS SUITE — rapid / concurrent interaction on the Home notification
 * priming card (`src/notifications/NotificationPrimingCard.tsx`) driven
 * through the REAL `notificationStore` (owner-scoped kv + SchedulerPort seam
 * mocked at the boundary, exactly like `wf/NotificationPrimingCard.buttons`).
 *
 * A seeded generator scripts interaction bursts: double/triple taps,
 * same-tick taps (two onPress calls before React re-renders), taps while the
 * permission request is in flight, simultaneous "Turn on" + "Not now",
 * unmount/remount mid-request ("back during async"), spam mount cycles, and
 * external store changes (Settings toggled reminders on, OS permission became
 * denied, owner re-hydration) — under fake timers with scripted scheduler
 * latency, grant/deny/undetermined/reject outcomes, kv write failures, and
 * applyPlan failures.
 *
 * Every iteration is replayable from its seed:
 *   STRESS_SEEDS=123,456 npx jest --ci __tests__/stress/notificationPrimingCard.rapidInteraction
 * Campaign size: STRESS_ITER (default 300). Results table: STRESS_OUT=<file>.
 * Tap model: STRESS_TAP_MODEL=touch (default) | same-tick (see below).
 * Hand-minimized scenarios: STRESS_SCENARIO_FILE=<json array of Scenario>.
 * Step trace to stderr: STRESS_DEBUG=1.
 *
 * Invariants asserted per iteration (the "one side effect per intent" lens):
 *   I1  scheduler.requestPermission calls == accepted "Turn on" intents (a tap
 *       that landed while THIS instance had no request in flight);
 *   I2  every kv write is one setPrefs, and every setPrefs reconciles the OS
 *       exactly once (applyPlan + cancelAllPlanned == kv writes);
 *   I3  kv writes == accepted dismiss intents + granted requests (owner present);
 *   I4  no orphan loading state once everything settled (no "Asking…", no
 *       disabled buttons, busy=false while the card is visible);
 *   I5  rendered visibility == store predicate; at most one card, at most one
 *       failure caption, exactly 0 or 2 buttons;
 *   I6  failure caption shown iff the last settled request on the live
 *       instance failed without denial and the card is still visible;
 *   I7  kv mirrors in-memory prefs whenever the last write succeeded;
 *   I8  no console.error / console.warn (act() warnings, setState-after-
 *       unmount), no unhandled rejections, no thrown step.
 *
 * Two tap models exist for the generated `sameTick` bursts:
 *   - `touch`     (default): every onPress is its own event — React commits
 *                   between taps and a tap on a `disabled` Pressable is
 *                   dropped. This is what RN's responder system delivers for
 *                   real touches (one discrete event per release, flushed
 *                   synchronously), so it is the model the suite gates on.
 *   - `same-tick` : N onPress calls inside ONE act() with no commit between
 *                   them (two press dispatches in a single batch, or a
 *                   programmatic double-invoke of a stale handler). Opt in
 *                   with STRESS_TAP_MODEL=same-tick; it is a diagnostic
 *                   campaign and is expected to expose the stale-closure
 *                   `if (pending) return` guard (see the stress report).
 * The model used is recorded per iteration so a failure names its model.
 */

// ---------------------------------------------------------------- mocks ----

const mockKvTable = new Map<string, string>();
let mockKvWriteFailure: Error | null = null;
let mockKvWrites = 0;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvWrites += 1;
        if (mockKvWriteFailure) throw mockKvWriteFailure;
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

const mockScheduler = {
  permissionState: jest.fn<Promise<PermissionState>, []>(),
  requestPermission: jest.fn<Promise<PermissionState>, []>(),
  applyPlan: jest.fn<Promise<void>, [readonly PlannedNotification[]]>(),
  cancelAllPlanned: jest.fn<Promise<void>, []>(),
  openSystemSettings: jest.fn<Promise<void>, []>(),
};

jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => ({
    currentStreak: 2,
    trainedToday: false,
    totalActivities: 3,
    shieldsAvailable: 0,
    nextStreakMilestone: null,
  }),
}));

import type { PermissionState } from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../../src/notifications/types';
import { useNotificationStore } from '../../src/notifications/notificationStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { PressableScale } from '../../src/design/components';

// ------------------------------------------------------------ seeded rng ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  weighted<T extends string>(table: Record<T, number>): T {
    const entries = Object.entries(table) as [T, number][];
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
  weightedNumber(table: Record<string, number>): number {
    return Number(this.weighted(table));
  }
}

// ------------------------------------------------------------- scenario ----

type RequestOutcome = 'granted' | 'denied' | 'undetermined' | 'reject';

type Step =
  | { kind: 'tap'; target: 'turnOn' | 'notNow'; times: number }
  | { kind: 'sameTick'; targets: ('turnOn' | 'notNow')[] }
  | { kind: 'advance'; ms: number }
  | { kind: 'flush' }
  | { kind: 'unmount' }
  | { kind: 'remount' }
  | { kind: 'rerender' }
  | { kind: 'spamMount'; cycles: number }
  | {
      kind: 'external';
      change:
        | 'permissionDenied'
        | 'permissionGranted'
        | 'enabledFromSettings'
        | 'rehydrateDefaults'
        | 'hydratedFalse'
        | 'signOut'
        | 'signIn';
    };

interface Scenario {
  seed: number;
  initialPermission: PermissionState | 'unknown';
  initialOwner: 'guest' | 'signedOut';
  /** Outcome + latency per requestPermission call (cycled if exhausted). */
  requests: { outcome: RequestOutcome; latencyMs: number }[];
  kvWriteFails: boolean;
  applyPlanRejects: boolean;
  steps: Step[];
}

function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  const requests: Scenario['requests'] = [];
  const requestCount = rng.range(1, 6);
  for (let i = 0; i < requestCount; i += 1) {
    requests.push({
      outcome: rng.weighted<RequestOutcome>({
        granted: 4,
        denied: 2,
        undetermined: 2,
        reject: 2,
      }),
      latencyMs: rng.weightedNumber({
        '0': 3,
        '1': 2,
        '20': 3,
        '250': 2,
        '3000': 1,
      }),
    });
  }
  const steps: Step[] = [];
  const stepCount = rng.range(2, 14);
  for (let i = 0; i < stepCount; i += 1) {
    const kind = rng.weighted({
      tap: 30,
      sameTick: 12,
      advance: 18,
      flush: 8,
      unmount: 5,
      remount: 6,
      rerender: 3,
      spamMount: 3,
      external: 8,
    });
    switch (kind) {
      case 'tap':
        steps.push({
          kind,
          target: rng.chance(0.65) ? 'turnOn' : 'notNow',
          times: rng.weightedNumber({ '1': 5, '2': 4, '3': 2, '5': 1 }),
        });
        break;
      case 'sameTick': {
        const n = rng.range(2, 4);
        const targets: ('turnOn' | 'notNow')[] = [];
        for (let k = 0; k < n; k += 1) {
          targets.push(rng.chance(0.6) ? 'turnOn' : 'notNow');
        }
        steps.push({ kind, targets });
        break;
      }
      case 'advance':
        steps.push({ kind, ms: rng.pick([0, 1, 25, 300, 5000]) });
        break;
      case 'flush':
        steps.push({ kind });
        break;
      case 'unmount':
        steps.push({ kind });
        break;
      case 'remount':
        steps.push({ kind });
        break;
      case 'rerender':
        steps.push({ kind });
        break;
      case 'spamMount':
        steps.push({ kind, cycles: rng.range(2, 6) });
        break;
      case 'external':
        steps.push({
          kind,
          change: rng.weighted({
            permissionDenied: 3,
            permissionGranted: 2,
            enabledFromSettings: 3,
            rehydrateDefaults: 2,
            hydratedFalse: 1,
            signOut: 1,
            signIn: 2,
          }),
        });
        break;
    }
  }
  return {
    seed,
    initialPermission: rng.weighted({
      undetermined: 5,
      unknown: 2,
      granted: 2,
      denied: 1,
    }) as PermissionState | 'unknown',
    initialOwner: rng.chance(0.9) ? 'guest' : 'signedOut',
    requests,
    kvWriteFails: rng.chance(0.15),
    applyPlanRejects: rng.chance(0.15),
    steps,
  };
}

// -------------------------------------------------------------- harness ----

type Renderer = TestRenderer.ReactTestRenderer;

interface Violation {
  invariant: string;
  detail: string;
}

interface IterationResult {
  seed: number;
  outcome: 'HELD' | 'BROKEN';
  violations: Violation[];
  tapModelsUsed: ('touch' | 'same-tick')[];
  counters: {
    requestPermissionCalls: number;
    expectedRequests: number;
    duplicateTapsDropped: number;
    sameTickTurnOnFired: number;
    crossInstanceConcurrentRequests: number;
    kvWrites: number;
    expectedKvWrites: number;
    applyPlanCalls: number;
    cancelAllPlannedCalls: number;
    mounts: number;
    stepsRun: number;
  };
  scenario: Scenario;
  error?: string;
}

const CARD_TEST_ID = 'notification-priming-card';
const FAILURE_TEST_ID = 'notification-priming-failure';
const TURN_ON_LABEL = 'Turn on practice reminders';
const NOT_NOW_LABEL = 'Not now';

const consoleErrors: string[] = [];
const consoleWarns: string[] = [];
const unhandled: string[] = [];
const onUnhandled = (reason: unknown) => {
  unhandled.push(String(reason instanceof Error ? reason.message : reason));
};

function pressables(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      node.type !== PressableScale &&
      typeof node.props.onPress === 'function' &&
      typeof node.props.accessibilityLabel === 'string',
  );
}

function findPressable(renderer: Renderer, label: string) {
  const matches = pressables(renderer).filter(
    node => node.props.accessibilityLabel === label,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function cardNodes(renderer: Renderer) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === CARD_TEST_ID,
  );
}

function failureNodes(renderer: Renderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' && node.props.testID === FAILURE_TEST_ID,
  );
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function storedPrefs(): unknown {
  const raw = mockKvTable.get(notificationPrefsKeyForOwner(GUEST_DATA_OWNER));
  return raw === undefined ? null : (JSON.parse(raw) as unknown);
}

function storeVisiblePredicate(): boolean {
  const s = useNotificationStore.getState();
  return (
    s.hydrated &&
    !s.prefs.enabled &&
    !s.prefs.promptDismissed &&
    s.permission !== 'denied'
  );
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
  });
}

type TapModel = 'touch' | 'same-tick';

async function runIteration(
  scenario: Scenario,
  tapModel: TapModel,
): Promise<IterationResult> {
  // --- reset world
  mockKvTable.clear();
  mockKvWriteFailure = scenario.kvWriteFails ? new Error('disk full') : null;
  mockKvWrites = 0;
  consoleErrors.length = 0;
  consoleWarns.length = 0;
  unhandled.length = 0;
  mockScheduler.permissionState.mockReset().mockResolvedValue('undetermined');
  mockScheduler.applyPlan.mockReset();
  if (scenario.applyPlanRejects) {
    mockScheduler.applyPlan.mockRejectedValue(new Error('notifee down'));
  } else {
    mockScheduler.applyPlan.mockResolvedValue(undefined);
  }
  mockScheduler.cancelAllPlanned.mockReset().mockResolvedValue(undefined);
  mockScheduler.openSystemSettings.mockReset().mockResolvedValue(undefined);

  // Oracle bookkeeping for I1/I3.
  let requestCalls = 0;
  let inFlight = 0;
  /** Requests still pending per component instance (the component's own
   * `pending` flag is per instance; a remount starts fresh). */
  const inFlightByInstance = new Map<number, number>();
  const requestLog: {
    instance: number;
    outcome: RequestOutcome;
    ownerAtCall: string;
    ownerAtSettle: string;
    settled: boolean;
    settleOrder: number;
  }[] = [];
  let settleSequence = 0;
  let expectedRequests = 0;
  let expectedKvWrites = 0;
  let duplicateTapsDropped = 0;
  let sameTickTurnOnFired = 0;
  let crossInstanceConcurrentRequests = 0;
  let currentInstance = 0;
  let mounts = 0;
  let lastFailedOnInstance: number | null = null;
  const tapModelsUsed = new Set<'touch' | 'same-tick'>();

  mockScheduler.requestPermission.mockReset().mockImplementation(() => {
    const script = scenario.requests[requestCalls % scenario.requests.length]!;
    requestCalls += 1;
    inFlight += 1;
    inFlightByInstance.set(
      currentInstance,
      (inFlightByInstance.get(currentInstance) ?? 0) + 1,
    );
    const entry = {
      instance: currentInstance,
      outcome: script.outcome,
      ownerAtCall: getActiveDataOwner(),
      ownerAtSettle: '',
      settled: false,
      settleOrder: -1,
    };
    requestLog.push(entry);
    return new Promise<PermissionState>((resolve, reject) => {
      const settle = () => {
        entry.settled = true;
        entry.ownerAtSettle = getActiveDataOwner();
        settleSequence += 1;
        entry.settleOrder = settleSequence;
        inFlight -= 1;
        inFlightByInstance.set(
          entry.instance,
          (inFlightByInstance.get(entry.instance) ?? 1) - 1,
        );
        if (script.outcome === 'reject') {
          reject(new Error('native module unavailable'));
        } else {
          resolve(script.outcome);
        }
      };
      if (script.latencyMs === 0) settle();
      else setTimeout(settle, script.latencyMs);
    });
  });

  setActiveDataOwner(
    scenario.initialOwner === 'guest'
      ? GUEST_DATA_OWNER
      : SIGNED_OUT_DATA_OWNER,
  );
  act(() => {
    useNotificationStore.setState({
      hydrated: true,
      ownerKey: GUEST_DATA_OWNER,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      permission: scenario.initialPermission,
      persistFailed: false,
      scheduleFailed: false,
    });
  });

  let renderer: Renderer | null = null;
  const mount = () => {
    if (renderer) return;
    currentInstance += 1;
    mounts += 1;
    act(() => {
      renderer = TestRenderer.create(<NotificationPrimingCard />);
    });
  };
  const unmount = () => {
    if (!renderer) return;
    const r = renderer;
    renderer = null;
    act(() => r.unmount());
  };

  /** Realistic single tap: dropped when the Pressable is disabled. Returns
   * whether onPress fired. Caller wraps in act. */
  const fireTap = (target: 'turnOn' | 'notNow'): boolean => {
    if (!renderer) return false;
    const node = findPressable(
      renderer,
      target === 'turnOn' ? TURN_ON_LABEL : NOT_NOW_LABEL,
    );
    if (!node) return false; // card hidden: nothing to tap
    if (node.props.disabled) {
      duplicateTapsDropped += 1;
      return false;
    }
    // Oracle: account for the intent BEFORE the component reacts.
    if (target === 'turnOn') {
      if ((inFlightByInstance.get(currentInstance) ?? 0) > 0) {
        // A second "Turn on" on the same live instance while its request is
        // still pending: one intent, must NOT produce a second request.
      } else {
        // A fresh instance (remounted mid-request) legitimately asks again.
        if (inFlight > 0) crossInstanceConcurrentRequests += 1;
        expectedRequests += 1;
      }
    } else {
      const s = useNotificationStore.getState();
      if (
        !s.prefs.promptDismissed &&
        getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER
      ) {
        expectedKvWrites += 1;
      }
    }
    node.props.onPressIn?.();
    node.props.onPress();
    node.props.onPressOut?.();
    return true;
  };

  const violations: Violation[] = [];
  let stepsRun = 0;
  let error: string | undefined;

  const snapshot = (label: string) => {
    if (!DEBUG) return;
    const s = useNotificationStore.getState();
    debugLine(
      `[seed ${scenario.seed}] ${label} | requests=${requestCalls} inFlight=${inFlight} kv=${mockKvWrites} owner=${getActiveDataOwner()} perm=${s.permission} enabled=${s.prefs.enabled} dismissed=${s.prefs.promptDismissed} timers=${jest.getTimerCount()} text=${renderer ? JSON.stringify(allText(renderer)) : '<unmounted>'}`,
    );
  };

  try {
    mount();
    snapshot('mounted');
    for (const step of scenario.steps) {
      stepsRun += 1;
      switch (step.kind) {
        case 'tap': {
          tapModelsUsed.add('touch');
          for (let i = 0; i < step.times; i += 1) {
            // Each real tap is its own event: React re-renders in between.
            await act(async () => {
              fireTap(step.target);
            });
          }
          break;
        }
        case 'sameTick': {
          if (tapModel === 'touch') {
            // Same burst, but each press is its own discrete event.
            tapModelsUsed.add('touch');
            for (const target of step.targets) {
              await act(async () => {
                fireTap(target);
              });
            }
            break;
          }
          tapModelsUsed.add('same-tick');
          await act(async () => {
            let turnOnsFired = 0;
            for (const target of step.targets) {
              const fired = fireTap(target);
              if (fired && target === 'turnOn') turnOnsFired += 1;
            }
            if (turnOnsFired > 1) sameTickTurnOnFired += turnOnsFired - 1;
          });
          break;
        }
        case 'advance':
          // Async variant: promise continuations run between timers, as they
          // do on a real event loop (a 20ms grant settles before a 250ms
          // rejection, not in the same synchronous sweep).
          await act(async () => {
            await jest.advanceTimersByTimeAsync(step.ms);
          });
          await flushMicrotasks();
          break;
        case 'flush':
          await flushMicrotasks();
          break;
        case 'unmount':
          unmount();
          break;
        case 'remount':
          unmount();
          mount();
          break;
        case 'rerender':
          if (renderer) {
            act(() => renderer!.update(<NotificationPrimingCard />));
          }
          break;
        case 'spamMount':
          for (let c = 0; c < step.cycles; c += 1) {
            unmount();
            mount();
          }
          break;
        case 'external': {
          const s = useNotificationStore.getState();
          act(() => {
            switch (step.change) {
              case 'permissionDenied':
                useNotificationStore.setState({ permission: 'denied' });
                break;
              case 'permissionGranted':
                useNotificationStore.setState({ permission: 'granted' });
                break;
              case 'enabledFromSettings':
                useNotificationStore.setState({
                  prefs: { ...s.prefs, enabled: true },
                });
                break;
              case 'rehydrateDefaults':
                useNotificationStore.setState({
                  hydrated: true,
                  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
                });
                break;
              case 'hydratedFalse':
                useNotificationStore.setState({ hydrated: false });
                break;
              case 'signOut':
                setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
                break;
              case 'signIn':
                setActiveDataOwner(GUEST_DATA_OWNER);
                break;
            }
          });
          break;
        }
      }
      snapshot(`after ${JSON.stringify(step)}`);
    }

    // --- settle: drain every timer and continuation.
    snapshot('settling');
    for (let guard = 0; guard < 50 && jest.getTimerCount() > 0; guard += 1) {
      await act(async () => {
        await jest.runOnlyPendingTimersAsync();
      });
      await flushMicrotasks();
    }
    await flushMicrotasks();
    snapshot('settled');

    // Granted requests each produce one setPrefs (owner present at the time).
    const bySettleOrder = [...requestLog].sort(
      (a, b) => a.settleOrder - b.settleOrder,
    );
    for (const entry of bySettleOrder) {
      // setPrefs reads the owner when the request resolves, not when the
      // tap landed: a sign-out in between makes the write a no-op.
      if (
        entry.outcome === 'granted' &&
        entry.ownerAtSettle !== SIGNED_OUT_DATA_OWNER
      ) {
        expectedKvWrites += 1;
      }
      if (entry.instance === currentInstance && entry.outcome !== 'granted') {
        lastFailedOnInstance = currentInstance;
      } else if (entry.instance === currentInstance) {
        lastFailedOnInstance = null;
      }
    }

    // --- invariants
    if (requestCalls !== expectedRequests) {
      violations.push({
        invariant: 'I1 one permission request per Turn-on intent',
        detail: `requestPermission called ${requestCalls}x, expected ${expectedRequests} (same-tick extra fires: ${sameTickTurnOnFired})`,
      });
    }
    const applyPlanCalls = mockScheduler.applyPlan.mock.calls.length;
    const cancelCalls = mockScheduler.cancelAllPlanned.mock.calls.length;
    if (applyPlanCalls + cancelCalls !== mockKvWrites) {
      violations.push({
        invariant: 'I2 one OS reconcile per persisted preference write',
        detail: `applyPlan=${applyPlanCalls} cancelAllPlanned=${cancelCalls} kvWrites=${mockKvWrites}`,
      });
    }
    if (mockKvWrites !== expectedKvWrites) {
      violations.push({
        invariant: 'I3 kv writes == dismiss intents + granted requests',
        detail: `kvWrites=${mockKvWrites} expected=${expectedKvWrites}`,
      });
    }
    if (renderer) {
      const r: Renderer = renderer;
      const cards = cardNodes(r);
      const visible = cards.length > 0;
      if (visible !== storeVisiblePredicate()) {
        violations.push({
          invariant: 'I5 rendered visibility == store predicate',
          detail: `rendered=${visible} store=${storeVisiblePredicate()} state=${JSON.stringify(
            {
              hydrated: useNotificationStore.getState().hydrated,
              prefs: useNotificationStore.getState().prefs,
              permission: useNotificationStore.getState().permission,
            },
          )}`,
        });
      }
      if (cards.length > 1) {
        violations.push({
          invariant: 'I5 at most one card',
          detail: `${cards.length} cards rendered`,
        });
      }
      const failures = failureNodes(r);
      if (failures.length > 1) {
        violations.push({
          invariant: 'I5 at most one failure caption',
          detail: `${failures.length} captions`,
        });
      }
      const buttons = pressables(r);
      if (buttons.length !== (visible ? 2 : 0)) {
        violations.push({
          invariant: 'I5 exactly two buttons when visible',
          detail: `${buttons.length} buttons, visible=${visible}`,
        });
      }
      if (visible) {
        const text = allText(r);
        if (text.includes('Asking…')) {
          violations.push({
            invariant: 'I4 no orphan loading state',
            detail: 'label still "Asking…" after settle',
          });
        }
        for (const button of buttons) {
          if (button.props.disabled) {
            violations.push({
              invariant: 'I4 no orphan loading state',
              detail: `${button.props.accessibilityLabel} still disabled after settle`,
            });
          }
          if (button.props.accessibilityState?.busy) {
            violations.push({
              invariant: 'I4 no orphan loading state',
              detail: `${button.props.accessibilityLabel} still busy after settle`,
            });
          }
        }
        const shouldShowFailure = lastFailedOnInstance === currentInstance;
        if ((failures.length === 1) !== shouldShowFailure) {
          violations.push({
            invariant:
              'I6 failure caption iff last request on live instance failed',
            detail: `caption=${failures.length === 1} expected=${shouldShowFailure} text="${text}"`,
          });
        }
        if (shouldShowFailure && !text.includes('Try again')) {
          violations.push({
            invariant: 'I6 retry affordance after failure',
            detail: `text="${text}"`,
          });
        }
      }
    }
    if (
      !scenario.kvWriteFails &&
      mockKvWrites > 0 &&
      getActiveDataOwner() === GUEST_DATA_OWNER
    ) {
      const s = useNotificationStore.getState();
      const persisted = storedPrefs();
      if (JSON.stringify(persisted) !== JSON.stringify(s.prefs)) {
        // External Settings toggles in this harness bypass setPrefs on
        // purpose (they are store-level fakes), so only compare when no
        // external pref change happened after the last write.
        const externalPrefChange = scenario.steps.some(
          st =>
            st.kind === 'external' &&
            (st.change === 'enabledFromSettings' ||
              st.change === 'rehydrateDefaults'),
        );
        if (!externalPrefChange) {
          violations.push({
            invariant: 'I7 kv mirrors in-memory prefs after a successful write',
            detail: `kv=${JSON.stringify(persisted)} mem=${JSON.stringify(s.prefs)}`,
          });
        }
      }
    }
    if (consoleErrors.length > 0) {
      violations.push({
        invariant: 'I8 no console.error',
        detail: consoleErrors.slice(0, 3).join(' | '),
      });
    }
    if (consoleWarns.length > 0) {
      violations.push({
        invariant: 'I8 no console.warn',
        detail: consoleWarns.slice(0, 3).join(' | '),
      });
    }
    if (unhandled.length > 0) {
      violations.push({
        invariant: 'I8 no unhandled rejection',
        detail: unhandled.slice(0, 3).join(' | '),
      });
    }
  } catch (caught) {
    error =
      caught instanceof Error
        ? (caught.stack ?? caught.message)
        : String(caught);
    violations.push({ invariant: 'I8 step threw', detail: error });
  } finally {
    unmount();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  }

  return {
    seed: scenario.seed,
    outcome: violations.length === 0 ? 'HELD' : 'BROKEN',
    violations,
    tapModelsUsed: [...tapModelsUsed],
    counters: {
      requestPermissionCalls: requestCalls,
      expectedRequests,
      duplicateTapsDropped,
      sameTickTurnOnFired,
      crossInstanceConcurrentRequests,
      kvWrites: mockKvWrites,
      expectedKvWrites,
      applyPlanCalls: mockScheduler.applyPlan.mock.calls.length,
      cancelAllPlannedCalls: mockScheduler.cancelAllPlanned.mock.calls.length,
      mounts,
      stepsRun,
    },
    scenario,
    ...(error ? { error } : {}),
  };
}

// ---------------------------------------------------------------- suite ----

const ITERATIONS = Math.max(1, Number(process.env['STRESS_ITER'] ?? 300));
const SEED_BASE = Number(process.env['STRESS_SEED_BASE'] ?? 1_000);
const REPLAY_SEEDS = (process.env['STRESS_SEEDS'] ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(Number);
const OUT_FILE = process.env['STRESS_OUT'];
const SCENARIO_FILE = process.env['STRESS_SCENARIO_FILE'];
const DEBUG = process.env['STRESS_DEBUG'] === '1';
const TAP_MODEL: TapModel =
  process.env['STRESS_TAP_MODEL'] === 'same-tick' ? 'same-tick' : 'touch';

function debugLine(line: string): void {
  if (DEBUG) process.stderr.write(`${line}\n`);
}

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  warnSpy = jest
    .spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => {
      consoleWarns.push(args.map(String).join(' '));
    });
  process.on('unhandledRejection', onUnhandled);
});

afterAll(() => {
  process.off('unhandledRejection', onUnhandled);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  jest.useRealTimers();
});

describe('NotificationPrimingCard — rapid/concurrent interaction stress', () => {
  it(`holds every invariant across ${
    SCENARIO_FILE
      ? `scenario file ${SCENARIO_FILE}`
      : REPLAY_SEEDS.length > 0
        ? `replay seeds ${REPLAY_SEEDS.join(',')}`
        : `${ITERATIONS} seeded bursts`
  } (tap model: ${TAP_MODEL})`, async () => {
    const scenarios: Scenario[] = SCENARIO_FILE
      ? (JSON.parse(readFileSync(SCENARIO_FILE, 'utf8')) as Scenario[])
      : (REPLAY_SEEDS.length > 0
          ? REPLAY_SEEDS
          : Array.from({ length: ITERATIONS }, (_, i) => SEED_BASE + i)
        ).map(generateScenario);
    const results: IterationResult[] = [];
    for (const scenario of scenarios) {
      results.push(await runIteration(scenario, TAP_MODEL));
    }
    const broken = results.filter(r => r.outcome === 'BROKEN');
    const summary = {
      unit: 'cmp-notification-priming',
      lens: 'rapid-interaction',
      tapModel: TAP_MODEL,
      seedBase: REPLAY_SEEDS.length > 0 ? null : SEED_BASE,
      iterations: results.length,
      held: results.length - broken.length,
      broken: broken.length,
      stepsExecuted: results.reduce((n, r) => n + r.counters.stepsRun, 0),
      byInvariant: broken
        .flatMap(r => r.violations.map(v => v.invariant))
        .reduce<Record<string, number>>((acc, inv) => {
          acc[inv] = (acc[inv] ?? 0) + 1;
          return acc;
        }, {}),
      brokenSeeds: broken.map(r => r.seed),
      results,
    };
    if (OUT_FILE) {
      mkdirSync(dirname(OUT_FILE), { recursive: true });
      writeFileSync(OUT_FILE, JSON.stringify(summary, null, 2));
    }
    const report = broken
      .slice(0, 10)
      .map(
        r =>
          `seed ${r.seed}: ${r.violations
            .map(v => `${v.invariant} — ${v.detail}`)
            .join('; ')}`,
      )
      .join('\n');
    expect(
      broken.length === 0
        ? ''
        : `${broken.length}/${results.length} bursts broke an invariant:\n${report}`,
    ).toBe('');
  }, 600_000);
});
