/**
 * FAILURE-INJECTION campaign — the production `NotifeeScheduler` adapter
 * and `subscribeToNotificationPresses` in service.ts against a fault-
 * injecting `react-native-notify-kit` native module and `Linking`.
 *
 * Every native call the adapter makes (getNotificationSettings,
 * requestPermission, getTriggerNotificationIds, cancelTriggerNotification,
 * createTriggerNotification, getInitialNotification, onForegroundEvent) and
 * `Linking.openSettings` can throw / reject / time out / be slow / never
 * resolve / hand back malformed data / do half the job. Invariants:
 *
 *   settled-or-never     adapter promises settle within 60 s of fake time
 *                        unless a native call literally never resolves
 *   no-sync-throw        adapter methods never throw synchronously (a
 *                        rejected promise is the contract)
 *   permission-domain    permissionState/requestPermission resolve only to
 *                        'granted' | 'denied' | 'undetermined'
 *   no-fake-permission   'granted' only when the OS status was AUTHORIZED /
 *                        PROVISIONAL / EPHEMERAL (1..3); a malformed status
 *                        (NaN, string, null, out of range) must not read as
 *                        granted
 *   apply-exact          a resolved applyPlan leaves the OS holding exactly
 *                        the plan (ids, timestamps, repeat) — nothing stale
 *   no-fake-success      a native failure inside applyPlan/cancelAllPlanned
 *                        /openSystemSettings surfaces as a rejection
 *   foreign-intact       ids not under `ps.` are never cancelled
 *   press-routing        navigate() is only ever called with 'Home' |
 *                        'Performance', never on malformed payloads, and a
 *                        failed cold-start read never throws
 *
 * Scale:   STRESS_ITER=<n>   iterations (default 48)
 * Replay:  STRESS_ONLY=<seed>[,<seed>...]
 */
import { Linking } from 'react-native';
import { buildNotificationPlan } from '../../src/notifications/plan';
import type { PlannedNotification } from '../../src/notifications/types';
import { SeededRng } from '../../test-support/stress/notifications/seededRng';
import {
  FaultJournal,
  runFault,
  settleWithin,
  type FaultMode,
} from '../../test-support/stress/notifications/faults';
import {
  FaultNotifee,
  NOTIFEE_CONSTANTS,
  VALID_STATUSES,
  type NativeOp,
} from '../../test-support/stress/notifications/faultNotifee';
import {
  NO_SPINNER_BUDGET_MS,
  campaignSeeds,
  describeCampaignFailure,
  knownFindingIds,
  planDefects,
  randomContext,
  replayCommand,
  summarizeRows,
  unexplainedViolations,
  writeResultTable,
  type IterationRow,
  type Violation,
} from '../../test-support/stress/notifications/campaign';

let mockNative: FaultNotifee;

jest.mock('react-native-notify-kit', () => ({
  __esModule: true,
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  RepeatFrequency: { NONE: -1, HOURLY: 0, DAILY: 1, WEEKLY: 2 },
  TriggerType: { TIMESTAMP: 0, INTERVAL: 1 },
  EventType: { DISMISSED: 0, PRESS: 1, DELIVERED: 3 },
  default: {
    getNotificationSettings: () => mockNative.api.getNotificationSettings(),
    requestPermission: () => mockNative.api.requestPermission(),
    createChannel: () => mockNative.api.createChannel(),
    createTriggerNotification: (
      notification: { id?: unknown; data?: unknown },
      trigger: {
        type?: unknown;
        timestamp?: unknown;
        repeatFrequency?: unknown;
      },
    ) => mockNative.api.createTriggerNotification(notification, trigger),
    getTriggerNotificationIds: () => mockNative.api.getTriggerNotificationIds(),
    cancelTriggerNotification: (id: unknown) =>
      mockNative.api.cancelTriggerNotification(id),
    openNotificationSettings: () => mockNative.api.openNotificationSettings(),
    getInitialNotification: () => mockNative.api.getInitialNotification(),
    onForegroundEvent: (listener: (event: unknown) => void) =>
      mockNative.api.onForegroundEvent(listener),
    onBackgroundEvent: () => mockNative.api.onBackgroundEvent(),
  },
}));

import {
  getScheduler,
  subscribeToNotificationPresses,
} from '../../src/notifications/service';

const SUITE = 'notificationServiceFailureInjection';

type Action =
  | { kind: 'permissionState' }
  | { kind: 'requestPermission' }
  | { kind: 'applyPlan'; plan: PlannedNotification[] }
  | { kind: 'cancelAllPlanned' }
  | { kind: 'openSystemSettings' }
  | { kind: 'subscribePresses'; events: number };

interface Scenario {
  clockIso: string;
  status: unknown;
  promptStatus: unknown;
  preloadedOwnIds: string[];
  actions: string[];
}

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'applyPlan':
      return `applyPlan([${action.plan.map(item => item.id).join(',')}])`;
    case 'subscribePresses':
      return `subscribePresses(events=${action.events})`;
    default:
      return action.kind;
  }
}

const ASYNC_OPS: readonly FaultMode[] = [
  'throw',
  'reject',
  'timeout',
  'slow',
  'never',
  'malformed',
  'partial',
];

function drawMode(rng: SeededRng, op: NativeOp | 'linking'): FaultMode {
  if (rng.chance(0.5)) return 'ok';
  let modes: readonly FaultMode[] = ASYNC_OPS;
  if (op === 'onForegroundEvent') modes = ['throw'];
  if (op === 'getInitialNotification') {
    // Called outside any async wrapper: a sync throw here is the caller's
    // own crash, not something the adapter promises to absorb.
    modes = ['reject', 'timeout', 'slow', 'never', 'malformed'];
  }
  if (
    op === 'cancelTriggerNotification' ||
    op === 'createTriggerNotification'
  ) {
    modes = ['throw', 'reject', 'timeout', 'slow', 'never'];
  }
  if (op === 'linking') modes = ['throw', 'reject', 'timeout', 'slow', 'never'];
  const mode = rng.pick(modes);
  if (mode === 'never' && rng.chance(0.6)) {
    return rng.pick(modes.filter(candidate => candidate !== 'never'));
  }
  return mode;
}

function randomPlan(rng: SeededRng, nowMs: number): PlannedNotification[] {
  const prefs = {
    version: 1 as const,
    enabled: true,
    practiceReminder: rng.chance(0.8),
    practiceReminderMinutes: rng.int(0, 47) * 30,
    streakDefense: rng.chance(0.7),
    weeklyRecap: rng.chance(0.7),
    comeback: rng.chance(0.7),
    promptDismissed: true,
  };
  const context = randomContext(rng, nowMs);
  return buildNotificationPlan(prefs, context);
}

const MALFORMED_PRESS_EVENTS: ReadonlyArray<() => unknown> = [
  () => ({ type: 1 }),
  () => ({ type: 1, detail: {} }),
  () => ({ type: 1, detail: { notification: null } }),
  () => ({ type: 1, detail: { notification: { data: null } } }),
  () => ({
    type: 1,
    detail: { notification: { data: { screen: 'Paywall' } } },
  }),
  () => ({ type: 1, detail: { notification: { data: { screen: ['Home'] } } } }),
  () => ({ type: 1, detail: { notification: { data: { screen: 0 } } } }),
  () => ({ type: 0, detail: { notification: { data: { screen: 'Home' } } } }),
  () => ({
    type: 3,
    detail: { notification: { data: { screen: 'Performance' } } },
  }),
  () => ({
    type: 'PRESS',
    detail: { notification: { data: { screen: 'Home' } } },
  }),
];

const rows: IterationRow<Scenario>[] = [];

afterAll(() => {
  if (rows.length === 0) return;
  writeResultTable(`${SUITE}.json`, summarizeRows(SUITE, rows));
});

async function runIteration(seed: number): Promise<IterationRow<Scenario>> {
  const rng = new SeededRng(seed);
  const journal = new FaultJournal();
  const clockMs =
    new Date(2025, 5, 1, 12, 0, 0, 0).getTime() + rng.int(0, 400) * 86_400_000;
  jest.useFakeTimers();
  jest.setSystemTime(clockMs);
  mockNative = new FaultNotifee(journal, rng);
  const status = rng.weighted<unknown>([
    [-1, 3],
    [0, 2],
    [1, 3],
    [2, 1],
    [3, 1],
  ]);
  const promptStatus = rng.weighted<unknown>([
    [1, 5],
    [0, 3],
    [2, 1],
  ]);
  mockNative.status = status;
  mockNative.promptStatus = promptStatus;
  const preloaded = rng.chance(0.5)
    ? randomPlan(rng, clockMs - 86_400_000)
    : [];
  for (const item of preloaded) {
    mockNative.triggers.set(item.id, {
      notification: { id: item.id, data: { screen: item.screen } },
      trigger: { type: 0, timestamp: item.timestampMs },
    });
  }
  const actions: Action[] = [];
  for (let i = rng.int(3, 6); i > 0; i--) {
    actions.push(
      rng.weighted<Action>([
        [{ kind: 'permissionState' }, 3],
        [{ kind: 'requestPermission' }, 2],
        [{ kind: 'applyPlan', plan: randomPlan(rng, clockMs) }, 5],
        [{ kind: 'cancelAllPlanned' }, 2],
        [{ kind: 'openSystemSettings' }, 1],
        [{ kind: 'subscribePresses', events: rng.int(1, 4) }, 2],
      ]),
    );
  }
  const scenario: Scenario = {
    clockIso: new Date(clockMs).toISOString(),
    status,
    promptStatus,
    preloadedOwnIds: preloaded.map(item => item.id),
    actions: actions.map(describeAction),
  };

  let faultsArmed = true;
  mockNative.modeFor = op => (faultsArmed ? drawMode(rng, op) : 'ok');
  const linkingSpy = jest
    .spyOn(Linking, 'openSettings')
    .mockImplementation(() =>
      runFault(
        journal,
        'linking',
        'openSettings',
        faultsArmed ? drawMode(rng, 'linking') : 'ok',
        () => undefined,
      ),
    );

  const scheduler = getScheduler();
  const advance = (ms: number) => jest.advanceTimersByTimeAsync(ms);
  const violations: Violation[] = [];
  const hangs: IterationRow<Scenario>['hangs'] = [];
  const navigations: unknown[] = [];
  const unsubscribes: Array<() => void> = [];

  const perform = (action: Action): Promise<unknown> => {
    switch (action.kind) {
      case 'permissionState':
        return scheduler.permissionState();
      case 'requestPermission':
        return scheduler.requestPermission();
      case 'applyPlan':
        return scheduler.applyPlan(action.plan);
      case 'cancelAllPlanned':
        return scheduler.cancelAllPlanned();
      case 'openSystemSettings':
        return scheduler.openSystemSettings();
      case 'subscribePresses': {
        const unsubscribe = subscribeToNotificationPresses(screen => {
          navigations.push(screen);
        });
        unsubscribes.push(unsubscribe);
        for (let i = 0; i < action.events; i++) {
          const event = rng.chance(0.5)
            ? rng.pick(MALFORMED_PRESS_EVENTS)()
            : {
                type: 1,
                detail: {
                  notification: {
                    data: { screen: rng.pick(['Home', 'Performance']) },
                  },
                },
              };
          mockNative.emitForeground(event);
        }
        return Promise.resolve(unsubscribe);
      }
    }
  };

  const runStep = async (
    step: number,
    action: Action,
    phase: 'campaign' | 'recovery',
  ) => {
    const label = `${phase === 'recovery' ? 'recovery:' : ''}${describeAction(action)}`;
    const fail = (invariant: string, detail: string) =>
      violations.push({ invariant, step, action: label, detail });
    const callMark = mockNative.calls.length;
    const journalMark = journal.entries.length;
    const navMark = navigations.length;
    const linkingMark = linkingSpy.mock.calls.length;
    const cancelledMark = mockNative.cancelled.length;
    const listenerErrorMark = mockNative.listenerErrors.length;
    if (action.kind === 'subscribePresses') {
      mockNative.initialNotification = rng.weighted<unknown>([
        [null, 3],
        [{ notification: { data: { screen: 'Home' } } }, 2],
        [{ notification: { data: { screen: 'Performance' } } }, 2],
        [{ notification: { data: { screen: 'Analyze' } } }, 1],
        [{ notification: {} }, 1],
      ]);
    }

    let promise: Promise<unknown>;
    try {
      promise = perform(action);
    } catch (error) {
      const expectedSyncThrow =
        action.kind === 'subscribePresses' &&
        mockNative.calls
          .slice(callMark)
          .some(
            call => call.op === 'onForegroundEvent' && call.mode === 'throw',
          );
      if (!expectedSyncThrow) {
        fail('no-sync-throw', `threw synchronously: ${String(error)}`);
      }
      return;
    }
    const result = await settleWithin(promise, NO_SPINNER_BUDGET_MS, advance);
    const calls = mockNative.calls.slice(callMark);
    const injected = journal.entries
      .slice(journalMark)
      .filter(entry => entry.mode !== 'ok');
    // A native call that failed, or answered with garbage / half the truth:
    // the adapter may (must, for failures) surface that as a rejection.
    const nativeFailed = calls.some(
      call =>
        call.outcome === 'failed' ||
        call.mode === 'malformed' ||
        call.mode === 'partial',
    );
    const nativeErrored = calls.some(call => call.outcome === 'failed');
    const linkingFailed = journal.entries
      .slice(journalMark)
      .some(
        entry =>
          entry.dependency === 'linking' &&
          (entry.mode === 'throw' ||
            entry.mode === 'reject' ||
            entry.mode === 'timeout'),
      );

    if (!result.settled) {
      const pendingNever = injected.filter(entry => entry.mode === 'never');
      if (pendingNever.length === 0) {
        fail(
          'settled-or-never',
          'did not settle within 60 s and nothing was `never`',
        );
      } else {
        hangs.push({
          step,
          action: label,
          pendingFault: pendingNever
            .map(p => `${p.dependency}.${p.op}`)
            .join(','),
        });
      }
    }

    if (!mockNative.foreignIntact())
      fail('foreign-intact', 'a foreign trigger id was cancelled');
    for (const id of mockNative.cancelled.slice(cancelledMark)) {
      if (!id.startsWith('ps.'))
        fail('foreign-intact', `asked the OS to cancel ${id}`);
    }

    switch (action.kind) {
      case 'permissionState':
      case 'requestPermission': {
        if (!result.settled) break;
        if (result.ok) {
          const value = result.value;
          if (
            value !== 'granted' &&
            value !== 'denied' &&
            value !== 'undetermined'
          ) {
            fail('permission-domain', `resolved to ${JSON.stringify(value)}`);
          }
          const nativeCall = calls.find(
            call =>
              call.op ===
              (action.kind === 'permissionState'
                ? 'getNotificationSettings'
                : 'requestPermission'),
          );
          if (value === 'granted') {
            if (nativeCall?.mode === 'malformed') {
              fail(
                'no-fake-permission',
                'malformed native authorizationStatus (non-number / NaN / out of range) mapped to granted',
              );
            } else if (
              !(VALID_STATUSES as readonly unknown[]).includes(
                mockNative.status,
              ) ||
              mockNative.status === -1 ||
              mockNative.status === 0
            ) {
              fail(
                'no-fake-permission',
                `granted with OS status ${String(mockNative.status)}`,
              );
            }
          }
        } else if (!nativeFailed) {
          fail(
            'no-fake-success',
            `rejected without a native failure: ${String(result.error)}`,
          );
        }
        break;
      }
      case 'applyPlan': {
        if (!result.settled) break;
        if (result.ok) {
          if (nativeErrored) {
            fail(
              'no-fake-success',
              'applyPlan resolved although a native call failed',
            );
          }
          const own = mockNative.ownIds().sort();
          const wanted = action.plan.map(item => item.id).sort();
          if (JSON.stringify(own) !== JSON.stringify(wanted)) {
            fail(
              'apply-exact',
              `OS holds [${own.join(',')}] wanted [${wanted.join(',')}]`,
            );
          }
          for (const item of action.plan) {
            const stored = mockNative.triggers.get(item.id);
            if (!stored) continue;
            if (stored.trigger.timestamp !== item.timestampMs) {
              fail(
                'apply-exact',
                `${item.id} timestamp ${String(stored.trigger.timestamp)}`,
              );
            }
            if (
              stored.trigger.type !== NOTIFEE_CONSTANTS.TriggerType.TIMESTAMP
            ) {
              fail(
                'apply-exact',
                `${item.id} trigger type ${String(stored.trigger.type)}`,
              );
            }
            const repeat = stored.trigger.repeatFrequency;
            const wantRepeat =
              item.repeat === 'daily'
                ? NOTIFEE_CONSTANTS.RepeatFrequency.DAILY
                : item.repeat === 'weekly'
                  ? NOTIFEE_CONSTANTS.RepeatFrequency.WEEKLY
                  : undefined;
            if (repeat !== wantRepeat) {
              fail(
                'apply-exact',
                `${item.id} repeat ${String(repeat)} wanted ${String(wantRepeat)}`,
              );
            }
            const defects = planDefects([item], clockMs);
            if (defects.length) fail('plan-sanity', defects.join('; '));
          }
        } else if (!nativeFailed) {
          fail(
            'no-fake-success',
            `rejected without a native failure: ${String(result.error)}`,
          );
        }
        break;
      }
      case 'cancelAllPlanned': {
        if (!result.settled) break;
        if (result.ok) {
          if (nativeErrored)
            fail('no-fake-success', 'resolved although a native call failed');
          const idsCall = calls.find(
            call => call.op === 'getTriggerNotificationIds',
          );
          if (idsCall?.mode === 'ok' && mockNative.ownIds().length > 0) {
            fail(
              'no-fake-success',
              `resolved but OS still holds [${mockNative.ownIds().join(',')}]`,
            );
          }
        } else if (!nativeFailed) {
          fail(
            'no-fake-success',
            `rejected without a native failure: ${String(result.error)}`,
          );
        }
        break;
      }
      case 'openSystemSettings': {
        if (!result.settled) break;
        if (result.ok && linkingFailed)
          fail('no-fake-success', 'resolved although Linking failed');
        if (!result.ok && !linkingFailed) {
          fail(
            'no-fake-success',
            `rejected without a Linking failure: ${String(result.error)}`,
          );
        }
        if (linkingSpy.mock.calls.length === linkingMark) {
          fail('no-fake-success', 'never reached Linking.openSettings');
        }
        break;
      }
      case 'subscribePresses': {
        // Let the cold-start read run its course (slow/timeout paths).
        await advance(NO_SPINNER_BUDGET_MS);
        for (const target of navigations.slice(navMark)) {
          if (target !== 'Home' && target !== 'Performance') {
            fail('press-routing', `navigate(${JSON.stringify(target)})`);
          }
        }
        for (const { event, error } of mockNative.listenerErrors.slice(
          listenerErrorMark,
        )) {
          fail(
            'press-routing',
            `foreground press handler threw on ${JSON.stringify(event)}: ${String(error)}`,
          );
        }
        const initialCall = calls.find(
          call => call.op === 'getInitialNotification',
        );
        if (
          initialCall?.mode === 'ok' &&
          mockNative.initialNotification &&
          typeof mockNative.initialNotification === 'object'
        ) {
          const data = (
            mockNative.initialNotification as {
              notification?: { data?: { screen?: unknown } };
            }
          ).notification?.data;
          const screen = data?.screen;
          const expected =
            screen === 'Home' || screen === 'Performance' ? screen : null;
          const navigated = navigations.slice(navMark);
          if (expected && !navigated.includes(expected)) {
            fail('press-routing', `cold-start ${expected} press was dropped`);
          }
        }
        break;
      }
    }
  };

  for (let step = 0; step < actions.length; step++) {
    await runStep(step, actions[step]!, 'campaign');
  }

  // Recovery: faults lift; a fresh apply must leave the OS exactly right.
  faultsArmed = false;
  const recoveryPlan = randomPlan(rng, Date.now());
  await runStep(
    actions.length,
    { kind: 'applyPlan', plan: recoveryPlan },
    'recovery',
  );
  await runStep(actions.length + 1, { kind: 'permissionState' }, 'recovery');
  if (!mockNative.foreignIntact()) {
    violations.push({
      invariant: 'foreign-intact',
      step: actions.length + 1,
      action: 'recovery:end',
      detail: 'foreign trigger ids missing at the end',
    });
  }

  for (const unsubscribe of unsubscribes) unsubscribe();
  if (mockNative.foregroundListeners.length > 0) {
    violations.push({
      invariant: 'press-routing',
      step: actions.length + 1,
      action: 'recovery:end',
      detail: `${mockNative.foregroundListeners.length} foreground listener(s) leaked after unsubscribe`,
    });
  }
  linkingSpy.mockRestore();
  jest.useRealTimers();

  return {
    seed,
    outcome: violations.length ? 'BROKEN' : hangs.length ? 'HUNG' : 'HELD',
    knownFindings: knownFindingIds(violations),
    scenario,
    faultsInjected: journal.injected().length,
    faultsByMode: journal.byMode(),
    faultTrace: journal.trace(),
    violations,
    hangs,
    replay: replayCommand(SUITE, seed),
  };
}

describe('NotifeeScheduler adapter failure injection (seeded)', () => {
  it.each(campaignSeeds())(
    'seed %i holds every adapter invariant',
    async seed => {
      const row = await runIteration(seed);
      rows.push(row);
      if (unexplainedViolations(row.violations).length) {
        throw new Error(describeCampaignFailure(row));
      }
    },
  );
});
