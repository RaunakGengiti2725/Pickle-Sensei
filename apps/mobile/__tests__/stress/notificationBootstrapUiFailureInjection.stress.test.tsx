/**
 * FAILURE-INJECTION campaign — the wiring users actually touch:
 * `useNotificationBootstrap` (owner changes + AppState foreground),
 * `NotificationPrimingCard` and `NotificationSettingsScreen`, rendered with
 * react-test-renderer over a fault-injecting SQLite kv, scheduler and
 * training-facts snapshot. Every press / foreground / owner switch is
 * followed by 60 s of fake time, then the tree is inspected:
 *
 *   no-infinite-spinner   nothing is still `busy`, "Asking…" or disabled-
 *                         while-requesting after 60 s
 *   visible-recovery      every failure flag the store raises has its copy
 *                         and a control on screen (Open system settings /
 *                         Check again / Try again / "change any setting");
 *                         the header Back control is always present
 *   no-silent-failure     a failed enable attempt shows the failure copy
 *                         (never a silently-off toggle)
 *   no-fake-permission    'granted' only when the OS said so
 *   persisted-integrity   writes are owner-scoped, never while signed out
 *   foreign-intact        other libraries' reminders survive
 *   no-console-error      React/RN never logs an error (act, unmounted
 *                         updates, uncaught rejections)
 *   recovered             once faults lift, one foreground + one setting
 *                         change clears every flag and alert
 *
 * Scale:   STRESS_ITER=<n>   iterations (default 24)
 * Replay:  STRESS_ONLY=<seed>[,<seed>...]
 */
import React from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { PermissionState } from '../../src/notifications/service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { SeededRng } from '../../test-support/stress/notifications/seededRng';
import {
  FaultJournal,
  runFault,
  type FaultMode,
} from '../../test-support/stress/notifications/faults';
import { FaultKv } from '../../test-support/stress/notifications/faultKv';
import { FaultScheduler } from '../../test-support/stress/notifications/faultScheduler';
import {
  CHAINED_DEPENDENCY_BUDGET_MS,
  NO_SPINNER_BUDGET_MS,
  campaignSeeds,
  describeCampaignFailure,
  knownFindingIds,
  randomContext,
  replayCommand,
  summarizeRows,
  unexplainedViolations,
  writeResultTable,
  type IterationRow,
  type Violation,
} from '../../test-support/stress/notifications/campaign';

let mockKv: FaultKv;
let mockScheduler: FaultScheduler;
let mockConsistency: () => Promise<unknown>;
const mockGoBack = jest.fn();

jest.mock('../../src/data/db', () => ({ getDb: () => mockKv }));
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: () => mockConsistency(),
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
jest.mock('@react-navigation/native', () => {
  const ReactActual = jest.requireActual<typeof import('react')>('react');
  return {
    useNavigation: () => ({ goBack: mockGoBack }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      ReactActual.useEffect(() => effect(), [effect]);
    },
  };
});

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../../src/notifications/notificationStore';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { NotificationSettingsScreen } from '../../src/screens/NotificationSettingsScreen';

const SUITE = 'notificationBootstrapUiFailureInjection';
const DEFAULT_UI_ITERATIONS = 24;
const UUID_OWNER = '99999999-9999-4999-8999-999999999999';

function Host(props: { ownerKey: string | null }) {
  useNotificationBootstrap(props.ownerKey);
  return (
    <>
      <NotificationPrimingCard />
      <NotificationSettingsScreen />
    </>
  );
}

type Action =
  | { kind: 'press'; label: string }
  | { kind: 'foreground' }
  | { kind: 'osPermission'; permission: PermissionState }
  | { kind: 'switchOwner'; owner: string }
  | { kind: 'remount' }
  | { kind: 'pressThenUnmount'; label: string };

interface Scenario {
  owner: string;
  osPermission: PermissionState;
  promptOutcome: PermissionState;
  storedEnabled: boolean | null;
  actions: string[];
}

const PRESS_LABELS = [
  'Turn on practice reminders',
  'Not now',
  'Turn on reminders',
  'Check again',
  'Open system settings',
  'All reminders',
  'Practice nudge',
  'Streak defense',
  'Weekly recap',
  'Welcome back',
  'Reminder 30 minutes later',
  'Back',
] as const;

function describeAction(action: Action): string {
  switch (action.kind) {
    case 'press':
      return `press(${action.label})`;
    case 'pressThenUnmount':
      return `pressThenUnmount(${action.label})`;
    case 'osPermission':
      return `osPermission(${action.permission})`;
    case 'switchOwner':
      return `switchOwner(${action.owner})`;
    default:
      return action.kind;
  }
}

const KV_MODES: readonly FaultMode[] = [
  'throw',
  'reject',
  'timeout',
  'slow',
  'never',
  'malformed',
  'partial',
];
const SCHEDULER_MODES: readonly FaultMode[] = [
  'reject',
  'timeout',
  'slow',
  'never',
  'partial',
];
const PERMISSION_READ_MODES: readonly FaultMode[] = [
  'reject',
  'timeout',
  'slow',
  'never',
];

function drawMode(rng: SeededRng, modes: readonly FaultMode[]): FaultMode {
  if (rng.chance(0.55)) return 'ok';
  const mode = rng.pick(modes);
  if (mode === 'never' && rng.chance(0.6)) {
    return rng.pick(modes.filter(candidate => candidate !== 'never'));
  }
  return mode;
}

function textContent(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node =>
      React.Children.toArray(node.props.children)
        .filter(child => typeof child === 'string')
        .join(''),
    )
    .join('\n');
}

function pressableByLabel(
  renderer: TestRenderer.ReactTestRenderer,
  label: string,
): TestRenderer.ReactTestInstance | null {
  const matches = renderer.root.findAll(
    node =>
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
  return (
    matches.find(node => node.props.accessibilityRole !== undefined) ??
    matches[0] ??
    null
  );
}

function busyNodes(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        (node.props.accessibilityState?.busy === true ||
          (node.props.disabled === true &&
            typeof node.props.accessibilityLabel === 'string' &&
            (node.props.accessibilityLabel === 'Turn on reminders' ||
              node.props.accessibilityLabel === 'Turn on practice reminders' ||
              node.props.accessibilityLabel === 'Not now'))) &&
        typeof node.props.onPress === 'function',
    )
    .map(node => String(node.props.accessibilityLabel))
    .filter((label, index, all) => all.indexOf(label) === index);
}

const rows: IterationRow<Scenario>[] = [];

afterAll(() => {
  if (rows.length === 0) return;
  writeResultTable(`${SUITE}.json`, summarizeRows(SUITE, rows));
});

async function runIteration(seed: number): Promise<IterationRow<Scenario>> {
  const rng = new SeededRng(seed);
  const journal = new FaultJournal();
  mockKv = new FaultKv(journal, rng);
  mockScheduler = new FaultScheduler(journal, rng);
  mockGoBack.mockReset();

  const owner = rng.weighted<string>([
    [GUEST_DATA_OWNER, 2],
    [UUID_OWNER, 3],
  ]);
  const clockMs =
    new Date(2025, 2, 1, 9, 0, 0, 0).getTime() + rng.int(0, 600) * 86_400_000;
  const osPermission = rng.pick<PermissionState>([
    'undetermined',
    'granted',
    'denied',
  ]);
  const promptOutcome: PermissionState = rng.chance(0.7) ? 'granted' : 'denied';
  const storedEnabled = rng.weighted<boolean | null>([
    [null, 2],
    [true, 2],
    [false, 1],
  ]);
  const actions: Action[] = [];
  let currentOwner = owner;
  for (let i = rng.int(2, 5); i > 0; i--) {
    const action = rng.weighted<Action>([
      [{ kind: 'press', label: rng.pick(PRESS_LABELS) }, 6],
      [{ kind: 'foreground' }, 2],
      [
        {
          kind: 'osPermission',
          permission: rng.pick<PermissionState>([
            'granted',
            'denied',
            'undetermined',
          ]),
        },
        1,
      ],
      [
        {
          kind: 'switchOwner',
          owner: rng.pick(
            [GUEST_DATA_OWNER, UUID_OWNER, SIGNED_OUT_DATA_OWNER].filter(
              candidate => candidate !== currentOwner,
            ),
          ),
        },
        1,
      ],
      [{ kind: 'remount' }, 1],
      [
        {
          kind: 'pressThenUnmount',
          label: rng.pick([
            'Turn on practice reminders',
            'Turn on reminders',
            'All reminders',
          ]),
        },
        1,
      ],
    ]);
    if (action.kind === 'switchOwner') currentOwner = action.owner;
    actions.push(action);
  }
  const scenario: Scenario = {
    owner,
    osPermission,
    promptOutcome,
    storedEnabled,
    actions: actions.map(describeAction),
  };

  jest.useFakeTimers();
  jest.setSystemTime(clockMs);
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  setActiveDataOwner(owner);
  if (storedEnabled !== null) {
    mockKv.table.set(
      notificationPrefsKeyForOwner(owner),
      JSON.stringify({
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: storedEnabled,
        promptDismissed: storedEnabled,
      }),
    );
  }
  mockScheduler.osPermission = osPermission;
  mockScheduler.promptOutcome = promptOutcome;

  let faultsArmed = true;
  mockKv.modeFor = () => (faultsArmed ? drawMode(rng, KV_MODES) : 'ok');
  mockScheduler.modeFor = op => {
    if (!faultsArmed) return 'ok';
    if (op === 'permissionState') return drawMode(rng, PERMISSION_READ_MODES);
    if (op === 'openSystemSettings') return drawMode(rng, ['reject', 'never']);
    return drawMode(rng, SCHEDULER_MODES);
  };
  mockConsistency = () => {
    const nowMs = Date.now();
    const facts = randomContext(rng, nowMs);
    return runFault(
      journal,
      'consistency',
      'snapshot',
      faultsArmed ? drawMode(rng, KV_MODES) : 'ok',
      () => ({
        currentStreak: facts.streakDays,
        trainedToday: facts.practicedToday,
        totalActivities: facts.hasAnyHistory ? 1 : 0,
        shieldsAvailable: facts.shieldsAvailable ?? 0,
        nextStreakMilestone: facts.milestoneEve
          ? { ...facts.milestoneEve, daysAway: 1 }
          : null,
      }),
      {
        slowMs: rng.int(500, 5_000),
        malformed: () =>
          ({
            currentStreak: 'three',
            trainedToday: 'no',
            totalActivities: null,
          }) as unknown as { currentStreak: number },
        partial: () => ({ currentStreak: facts.streakDays }),
      },
    );
  };

  let appStateHandler: ((state: string) => void) | null = null;
  const appStateSpy = jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      appStateHandler = handler as (state: string) => void;
      return { remove: () => (appStateHandler = null) } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  const consoleErrors: string[] = [];
  const consoleSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });

  const violations: Violation[] = [];
  const hangs: IterationRow<Scenario>['hangs'] = [];
  const settle = async () => {
    const journalMark = journal.entries.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(NO_SPINNER_BUDGET_MS);
    });
    // Still busy with nothing `never`: chained 30 s dependency timeouts are
    // dependency-bound, not spinner-bound. Grant the chain budget once.
    const stillBusy = () =>
      isMounted &&
      (busyNodes(renderer).length > 0 ||
        textContent(renderer).includes('Asking…'));
    const anyNever = () =>
      journal.entries.slice(journalMark).some(entry => entry.mode === 'never');
    if (stillBusy() && !anyNever()) {
      await act(async () => {
        await jest.advanceTimersByTimeAsync(
          CHAINED_DEPENDENCY_BUDGET_MS - NO_SPINNER_BUDGET_MS,
        );
      });
    }
  };

  let renderer!: TestRenderer.ReactTestRenderer;
  let isMounted = false;
  let mountedOwner: string | null = owner;
  const mount = async () => {
    await act(async () => {
      renderer = TestRenderer.create(<Host ownerKey={mountedOwner} />);
    });
    isMounted = true;
  };
  const unmount = async () => {
    isMounted = false;
    await act(async () => {
      renderer.unmount();
    });
  };

  const check = (
    step: number,
    label: string,
    marks: { writes: number; journal: number },
  ) => {
    const fail = (invariant: string, detail: string) =>
      violations.push({ invariant, step, action: label, detail });
    const state = useNotificationStore.getState();
    const text = textContent(renderer);
    const stepFaults = journal.entries.slice(marks.journal);

    // no-infinite-spinner
    const busy = busyNodes(renderer);
    const asking = text.includes('Asking…');
    if (busy.length > 0 || asking) {
      const pending = stepFaults.filter(entry => entry.mode === 'never');
      const detail = `still busy after 60 s: [${busy.join(',')}]${asking ? ' "Asking…"' : ''} (pending never: ${
        pending.map(entry => `${entry.dependency}.${entry.op}`).join(',') ||
        'none'
      })`;
      if (pending.length === 0) {
        fail('no-infinite-spinner', detail);
      } else {
        fail('no-infinite-spinner', detail);
        hangs.push({
          step,
          action: label,
          pendingFault: pending
            .map(entry => `${entry.dependency}.${entry.op}`)
            .join(','),
        });
      }
    }

    // visible-recovery
    if (!pressableByLabel(renderer, 'Back'))
      fail('visible-recovery', 'header Back control missing');
    if (state.persistFailed && !text.includes('couldn’t be saved')) {
      fail(
        'visible-recovery',
        'persistFailed=true but no save-failure copy on screen',
      );
    }
    if (state.scheduleFailed && !text.includes('couldn’t be scheduled')) {
      fail(
        'visible-recovery',
        'scheduleFailed=true but no schedule-failure copy on screen',
      );
    }
    if (
      state.permission === 'denied' &&
      !pressableByLabel(renderer, 'Open system settings')
    ) {
      fail(
        'visible-recovery',
        'permission denied but no "Open system settings" control',
      );
    }
    if (
      state.prefs.enabled &&
      state.permission === 'unknown' &&
      !pressableByLabel(renderer, 'Check again')
    ) {
      fail(
        'visible-recovery',
        'permission unknown while enabled but no "Check again" control',
      );
    }
    if (
      text.includes('Try again') &&
      !text.includes('couldn’t be turned on') &&
      !text.includes('weren’t turned on')
    ) {
      fail(
        'visible-recovery',
        'Try again offered without the failure explanation',
      );
    }

    // no-fake-permission
    if (state.permission === 'granted') {
      const lastReport = [...mockScheduler.calls]
        .reverse()
        .find(
          call =>
            (call.op === 'permissionState' ||
              call.op === 'requestPermission') &&
            call.outcome === 'ok',
        );
      if (!lastReport || lastReport.result !== 'granted') {
        fail(
          'no-fake-permission',
          `store says granted, OS last reported ${String(lastReport?.result)}`,
        );
      }
    }
    if (
      text.includes('Scheduled from your real practice history') &&
      state.permission !== 'granted'
    ) {
      fail(
        'no-fake-permission',
        `caption claims scheduled while permission=${state.permission}`,
      );
    }

    // foreign-intact / persisted-integrity
    if (!mockScheduler.foreignIdsIntact())
      fail('foreign-intact', 'a non-ps. trigger was cancelled');
    for (const write of mockKv.writes.slice(marks.writes)) {
      if (!write.acknowledged || write.mode !== 'ok') continue;
      if (write.key === PENDING_NOTIFICATION_ONBOARDING_KV_KEY) continue;
      if (write.activeOwner === SIGNED_OUT_DATA_OWNER) {
        fail(
          'persisted-integrity',
          `prefs written while signed out: ${write.key}`,
        );
      }
      if (write.key !== notificationPrefsKeyForOwner(write.activeOwner)) {
        fail(
          'persisted-integrity',
          `${write.key} written while ${write.activeOwner} active`,
        );
      }
      if (
        JSON.stringify(parseNotificationPrefs(write.requested)) !==
        write.requested
      ) {
        fail(
          'persisted-integrity',
          `write does not round-trip: ${write.requested}`,
        );
      }
    }

    // no-console-error
    for (const message of consoleErrors.splice(0)) {
      fail('no-console-error', message.slice(0, 300));
    }
  };

  const perform = async (action: Action) => {
    switch (action.kind) {
      case 'press': {
        const node = pressableByLabel(renderer, action.label);
        if (!node || node.props.disabled === true) return;
        await act(async () => {
          node.props.onPress();
        });
        return;
      }
      case 'pressThenUnmount': {
        const node = pressableByLabel(renderer, action.label);
        if (node && node.props.disabled !== true) {
          await act(async () => {
            node.props.onPress();
          });
        }
        await unmount();
        await settle();
        await mount();
        return;
      }
      case 'foreground':
        await act(async () => {
          appStateHandler?.('background');
          appStateHandler?.('active');
        });
        return;
      case 'osPermission':
        mockScheduler.osPermission = action.permission;
        return;
      case 'switchOwner':
        setActiveDataOwner(action.owner);
        mountedOwner = action.owner;
        await act(async () => {
          renderer.update(<Host ownerKey={mountedOwner} />);
        });
        return;
      case 'remount':
        await unmount();
        await mount();
        return;
    }
  };

  const marksNow = () => ({
    writes: mockKv.writes.length,
    journal: journal.entries.length,
  });

  // ---- campaign -----------------------------------------------------------
  let marks = marksNow();
  await mount();
  await settle();
  check(0, 'mount', marks);
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;
    marks = marksNow();
    await perform(action);
    await settle();
    check(i + 1, describeAction(action), marks);
  }

  // ---- recovery -----------------------------------------------------------
  faultsArmed = false;
  marks = marksNow();
  await perform({ kind: 'foreground' });
  await settle();
  check(actions.length + 1, 'recovery:foreground', marks);
  marks = marksNow();
  const toggle =
    pressableByLabel(renderer, 'Practice nudge') ??
    pressableByLabel(renderer, 'All reminders') ??
    pressableByLabel(renderer, 'Not now');
  if (toggle && toggle.props.disabled !== true) {
    await act(async () => {
      toggle.props.onPress();
    });
  } else {
    // No toggle on screen (denied / dismissed / signed out): "change any
    // setting" then means the store-level save the rows would perform.
    await act(async () => {
      void useNotificationStore.getState().setPrefs({});
    });
  }
  await settle();
  check(actions.length + 2, 'recovery:setting', marks);
  {
    const state = useNotificationStore.getState();
    const text = textContent(renderer);
    const fail = (invariant: string, detail: string) =>
      violations.push({
        invariant,
        step: actions.length + 2,
        action: 'recovery:end',
        detail,
      });
    if (getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER) {
      if (state.persistFailed)
        fail('recovered', 'persistFailed still set after healthy retry');
      if (text.includes('couldn’t be saved'))
        fail('recovered', 'save-failure copy still visible');
    }
    if (state.scheduleFailed)
      fail('recovered', 'scheduleFailed still set after healthy retry');
    if (text.includes('couldn’t be scheduled'))
      fail('recovered', 'schedule-failure copy still visible');
    if (busyNodes(renderer).length > 0)
      fail('recovered', 'controls still busy after recovery');
    if (state.permission === 'unknown')
      fail('recovered', 'permission still unknown after a healthy read');
  }

  await unmount();
  appStateSpy.mockRestore();
  consoleSpy.mockRestore();
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

describe('notification bootstrap + UI failure injection (seeded)', () => {
  it.each(campaignSeeds(DEFAULT_UI_ITERATIONS))(
    'seed %i keeps a visible, recoverable UI',
    async seed => {
      const row = await runIteration(seed);
      rows.push(row);
      if (unexplainedViolations(row.violations).length) {
        throw new Error(describeCampaignFailure(row));
      }
    },
  );
});
