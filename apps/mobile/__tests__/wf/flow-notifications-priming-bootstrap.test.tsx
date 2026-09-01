import React from 'react';
import { AppState, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  NOTIFICATION_ID_PREFIX,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { buildNotificationPlan } from '../../src/notifications/plan';
import {
  COMEBACK_COPY,
  practiceReminderCopy,
  streakDefenseCopy,
  weeklyRecapCopy,
} from '../../src/notifications/copy';

/**
 * The rest of the reminder flow a real user meets outside the settings
 * page: the Home priming card ("Turn on" / "Not now" with grant, deny and
 * failure branches), the App.tsx bootstrap hook (owner change → hydrate,
 * foreground → permission re-check + re-sync, sign-out → cancel), and the
 * AGENTS.md invariants: master off by default, `ps.` id prefix, lock-screen
 * safe copy, streak-defense copy only scheduled while true.
 */

const mockKvTable = new Map<string, string>();

jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'undetermined';
  requestResult: PermissionState = 'granted';
  requestError: Error | null = null;
  appliedPlans: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  requestCalls = 0;
  permissionStateCalls = 0;
  openSettingsCalls = 0;

  async permissionState(): Promise<PermissionState> {
    this.permissionStateCalls += 1;
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.requestCalls += 1;
    if (this.requestError) throw this.requestError;
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.appliedPlans.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {
    this.openSettingsCalls += 1;
  }
}

const mockScheduler = new FakeScheduler();
jest.mock('../../src/notifications/service', () => ({
  getScheduler: () => mockScheduler,
}));

const mockSnapshot = {
  currentStreak: 3,
  trainedToday: false,
  totalActivities: 9,
  shieldsAvailable: 1,
  nextStreakMilestone: null as null | {
    title: string;
    days: number;
    daysAway: number;
  },
};
jest.mock('../../src/consistency/store', () => ({
  computeConsistencySnapshot: async () => mockSnapshot,
}));

import { useNotificationStore } from '../../src/notifications/notificationStore';
import { NotificationPrimingCard } from '../../src/notifications/NotificationPrimingCard';
import { useNotificationBootstrap } from '../../src/notifications/useNotificationBootstrap';

const owner = '66666666-6666-4666-8666-666666666666';

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
  });
}

function resetScheduler() {
  mockScheduler.permission = 'undetermined';
  mockScheduler.requestResult = 'granted';
  mockScheduler.requestError = null;
  mockScheduler.appliedPlans = [];
  mockScheduler.cancelAllCalls = 0;
  mockScheduler.requestCalls = 0;
  mockScheduler.permissionStateCalls = 0;
  mockScheduler.openSettingsCalls = 0;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>(resolve => setTimeout(() => resolve(), 0));
  });
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
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

async function press(node: TestRenderer.ReactTestInstance | null) {
  expect(node).not.toBeNull();
  await act(async () => {
    node!.props.onPress();
  });
  await flush();
}

function cardVisible(renderer: TestRenderer.ReactTestRenderer): boolean {
  return (
    renderer.root.findAll(
      node => node.props.testID === 'notification-priming-card',
    ).length > 0
  );
}

function storedPrefs(forOwner = owner) {
  return parseNotificationPrefs(
    mockKvTable.get(notificationPrefsKeyForOwner(forOwner)) ?? null,
  );
}

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'setImmediate',
      'clearImmediate',
      'nextTick',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
  jest.setSystemTime(new Date(2026, 7, 25, 10, 0, 0));
  mockKvTable.clear();
  resetScheduler();
  resetStore();
  mockSnapshot.trainedToday = false;
  mockSnapshot.currentStreak = 3;
  mockSnapshot.nextStreakMilestone = null;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('Home priming card', () => {
  async function renderCard() {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<NotificationPrimingCard />);
    });
    await flush();
    return renderer;
  }

  it('is hidden until the store hydrated, then offers the choice with both buttons wired + labelled', async () => {
    setActiveDataOwner(owner);
    const renderer = await renderCard();
    expect(cardVisible(renderer)).toBe(false);

    await act(async () => {
      await useNotificationStore.getState().hydrate();
    });
    await flush();
    expect(cardVisible(renderer)).toBe(true);
    const body = textContent(renderer);
    expect(body).toContain('A nudge on practice days?');
    expect(body).toContain('Scheduled on this phone only.');

    const turnOn = pressableByLabel(renderer, 'Turn on practice reminders');
    const notNow = pressableByLabel(renderer, 'Not now');
    expect(turnOn?.props.accessibilityRole).toBe('button');
    expect(turnOn?.props.accessibilityHint).toBe(
      'Request notification permission and schedule reminders',
    );
    expect(notNow?.props.accessibilityRole).toBe('button');
    expect(notNow?.props.accessibilityHint).toBe('Dismiss this reminder offer');
    // Card never asks the OS on its own — only a tap does.
    expect(mockScheduler.requestCalls).toBe(0);
    await unmount(renderer);
  });

  it('"Turn on" → grant: enables, schedules, persists, card goes away', async () => {
    setActiveDataOwner(owner);
    await useNotificationStore.getState().hydrate();
    const renderer = await renderCard();
    await press(pressableByLabel(renderer, 'Turn on practice reminders'));

    expect(mockScheduler.requestCalls).toBe(1);
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(storedPrefs().enabled).toBe(true);
    expect(storedPrefs().promptDismissed).toBe(true);
    expect(mockScheduler.appliedPlans.length).toBe(1);
    expect(cardVisible(renderer)).toBe(false);
    await unmount(renderer);
  });

  it('"Turn on" → deny: nothing scheduled, card hides (no re-nag), Settings remains the recovery path', async () => {
    setActiveDataOwner(owner);
    mockScheduler.requestResult = 'denied';
    await useNotificationStore.getState().hydrate();
    const renderer = await renderCard();
    await press(pressableByLabel(renderer, 'Turn on practice reminders'));

    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(mockScheduler.appliedPlans).toEqual([]);
    expect(cardVisible(renderer)).toBe(false);
    await unmount(renderer);
  });

  it('"Turn on" → prompt throws: stays visible and tappable, nothing enabled', async () => {
    setActiveDataOwner(owner);
    mockScheduler.requestError = new Error('boom');
    await useNotificationStore.getState().hydrate();
    const renderer = await renderCard();
    await press(pressableByLabel(renderer, 'Turn on practice reminders'));

    expect(useNotificationStore.getState().permission).toBe('unknown');
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(cardVisible(renderer)).toBe(true);
    mockScheduler.requestError = null;
    await press(pressableByLabel(renderer, 'Turn on practice reminders'));
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(cardVisible(renderer)).toBe(false);
    await unmount(renderer);
  });

  it('"Not now" dismisses durably without touching the OS prompt; survives re-hydrate', async () => {
    setActiveDataOwner(owner);
    await useNotificationStore.getState().hydrate();
    const renderer = await renderCard();
    await press(pressableByLabel(renderer, 'Not now'));

    expect(mockScheduler.requestCalls).toBe(0);
    expect(useNotificationStore.getState().prefs.promptDismissed).toBe(true);
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
    expect(storedPrefs().promptDismissed).toBe(true);
    expect(cardVisible(renderer)).toBe(false);

    await act(async () => {
      resetStore();
      await useNotificationStore.getState().hydrate();
    });
    await flush();
    expect(cardVisible(renderer)).toBe(false);
    await unmount(renderer);
  });

  it('never shows for a denied permission or an already-enabled user', async () => {
    setActiveDataOwner(owner);
    mockScheduler.permission = 'denied';
    await useNotificationStore.getState().hydrate();
    await useNotificationStore.getState().refreshPermission();
    const renderer = await renderCard();
    expect(cardVisible(renderer)).toBe(false);

    mockScheduler.permission = 'granted';
    await act(async () => {
      await useNotificationStore.getState().refreshPermission();
    });
    await flush();
    expect(cardVisible(renderer)).toBe(true);
    await act(async () => {
      await useNotificationStore.getState().setPrefs({ enabled: true });
    });
    await flush();
    expect(cardVisible(renderer)).toBe(false);
    await unmount(renderer);
  });
});

describe('App bootstrap (owner changes + foreground)', () => {
  let appStateHandler: ((state: string) => void) | null = null;
  let removed = 0;

  function Host({ ownerKey }: { ownerKey: string | null }) {
    useNotificationBootstrap(ownerKey);
    return null;
  }

  beforeEach(() => {
    appStateHandler = null;
    removed = 0;
    jest
      .spyOn(AppState, 'addEventListener')
      .mockImplementation((_event, handler) => {
        appStateHandler = handler as (state: string) => void;
        return { remove: () => (removed += 1) } as ReturnType<
          typeof AppState.addEventListener
        >;
      });
  });

  async function renderHost(ownerKey: string | null) {
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Host ownerKey={ownerKey} />);
    });
    await flush();
    return renderer;
  }

  it('waits for auth (null owner), then hydrates the real owner OFF by default with nothing scheduled', async () => {
    const renderer = await renderHost(null);
    expect(useNotificationStore.getState().hydrated).toBe(false);

    setActiveDataOwner(owner);
    await act(async () => {
      renderer.update(<Host ownerKey={owner} />);
    });
    await flush();
    const state = useNotificationStore.getState();
    expect(state.hydrated).toBe(true);
    expect(state.ownerKey).toBe(owner);
    expect(state.prefs).toEqual(DEFAULT_NOTIFICATION_PREFS);
    expect(state.prefs.enabled).toBe(false);
    expect(mockScheduler.appliedPlans).toEqual([]);
    await unmount(renderer);
  });

  it('foreground → re-reads permission then re-syncs (revocation cancels, re-grant re-arms)', async () => {
    setActiveDataOwner(owner);
    mockScheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate();
    await useNotificationStore.getState().setPrefs({ enabled: true });
    mockScheduler.appliedPlans = [];
    mockScheduler.cancelAllCalls = 0;
    const renderer = await renderHost(owner);
    expect(appStateHandler).not.toBeNull();
    // Mount hydrates (and re-arms) once; from here only foregrounds count.
    mockScheduler.appliedPlans = [];
    mockScheduler.cancelAllCalls = 0;

    const checksBefore = mockScheduler.permissionStateCalls;
    // Background transitions do nothing.
    await act(async () => {
      appStateHandler!('background');
      appStateHandler!('inactive');
    });
    await flush();
    expect(mockScheduler.permissionStateCalls).toBe(checksBefore);
    expect(mockScheduler.appliedPlans).toEqual([]);

    await act(async () => {
      appStateHandler!('active');
    });
    await flush();
    expect(mockScheduler.permissionStateCalls).toBe(checksBefore + 1);
    expect(mockScheduler.appliedPlans.length).toBe(1);

    mockScheduler.permission = 'denied';
    await act(async () => {
      appStateHandler!('active');
    });
    await flush();
    expect(useNotificationStore.getState().permission).toBe('denied');
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);
    expect(mockScheduler.appliedPlans.length).toBe(1);

    mockScheduler.permission = 'granted';
    await act(async () => {
      appStateHandler!('active');
    });
    await flush();
    expect(useNotificationStore.getState().permission).toBe('granted');
    expect(mockScheduler.appliedPlans.length).toBe(2);

    await unmount(renderer);
    expect(removed).toBeGreaterThan(0);
  });

  it('sign-out (owner → signed-out) cancels every planned reminder and resets prefs in memory, keeping the durable copy', async () => {
    setActiveDataOwner(owner);
    mockScheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate();
    await useNotificationStore.getState().setPrefs({ enabled: true });
    const renderer = await renderHost(owner);
    mockScheduler.cancelAllCalls = 0;
    mockScheduler.appliedPlans = [];

    // authStore.signOut flips the owner synchronously before App re-renders.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await act(async () => {
      renderer.update(<Host ownerKey={SIGNED_OUT_DATA_OWNER} />);
    });
    await flush();

    const state = useNotificationStore.getState();
    expect(state.ownerKey).toBe(SIGNED_OUT_DATA_OWNER);
    expect(state.prefs.enabled).toBe(false);
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);
    expect(mockScheduler.appliedPlans).toEqual([]);
    // The user's choice is still on disk for their next sign-in.
    expect(storedPrefs().enabled).toBe(true);

    // A foreground while signed out must not schedule anything.
    mockScheduler.cancelAllCalls = 0;
    await act(async () => {
      appStateHandler!('active');
    });
    await flush();
    expect(mockScheduler.appliedPlans).toEqual([]);
    expect(mockScheduler.cancelAllCalls).toBeGreaterThan(0);

    // Signing back in re-hydrates that owner's prefs and re-arms.
    setActiveDataOwner(owner);
    await act(async () => {
      renderer.update(<Host ownerKey={owner} />);
    });
    await flush();
    expect(useNotificationStore.getState().prefs.enabled).toBe(true);
    expect(mockScheduler.appliedPlans.length).toBe(1);
    await unmount(renderer);
  });

  it('a guest owner is scoped like any other: prefs never leak across owners', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    mockScheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate();
    await useNotificationStore.getState().setPrefs({ enabled: true });
    expect(storedPrefs(GUEST_DATA_OWNER).enabled).toBe(true);
    expect(mockKvTable.has(notificationPrefsKeyForOwner(owner))).toBe(false);

    setActiveDataOwner(owner);
    resetStore();
    await useNotificationStore.getState().hydrate();
    expect(useNotificationStore.getState().prefs.enabled).toBe(false);
  });
});

describe('AGENTS.md invariants — ids, copy, honesty', () => {
  const allCopy = () => {
    const at = new Date(2026, 7, 25, 17, 30).getTime();
    const items = [
      ...COMEBACK_COPY,
      practiceReminderCopy(at),
      practiceReminderCopy(at + 86_400_000),
      practiceReminderCopy(at + 2 * 86_400_000),
      weeklyRecapCopy(at),
      streakDefenseCopy(at),
      streakDefenseCopy(at, {
        streakDays: 1,
        shieldsAvailable: 0,
        milestoneEve: null,
      }),
      streakDefenseCopy(at, {
        streakDays: 6,
        shieldsAvailable: 2,
        milestoneEve: null,
      }),
      streakDefenseCopy(at, {
        streakDays: 6,
        shieldsAvailable: 0,
        milestoneEve: { title: 'Week One', days: 7 },
      }),
    ];
    return items;
  };

  it('every planned id lives under the `ps.` prefix and targets a real tab', () => {
    const plan = buildNotificationPlan(
      { ...DEFAULT_NOTIFICATION_PREFS, enabled: true },
      {
        nowMs: new Date(2026, 7, 25, 10, 0).getTime(),
        streakDays: 3,
        practicedToday: false,
        hasAnyHistory: true,
      },
    );
    expect(plan.length).toBe(6);
    for (const item of plan) {
      expect(item.id.startsWith(NOTIFICATION_ID_PREFIX)).toBe(true);
      expect(['Home', 'Performance']).toContain(item.screen);
      expect(item.title.trim().length).toBeGreaterThan(0);
      expect(item.body.trim().length).toBeGreaterThan(0);
    }
    expect(plan.find(item => item.id === 'ps.reminder.weekly')?.screen).toBe(
      'Performance',
    );
  });

  it('master off (the default) plans nothing at all', () => {
    expect(
      buildNotificationPlan(DEFAULT_NOTIFICATION_PREFS, {
        nowMs: Date.now(),
        streakDays: 30,
        practicedToday: false,
        hasAnyHistory: true,
      }),
    ).toEqual([]);
  });

  it('reminder copy is lock-screen safe: no score values, clip refs, emails, or unresolved placeholders', () => {
    // A rating like "7.4", a clip/video mention, an @handle, or a leaked
    // template token would all be personal or broken on a lock screen.
    const forbidden = /\{|\}|\$\{|undefined|null|NaN|\d\.\d|clip|video|@/i;
    for (const copy of allCopy()) {
      expect(copy.title).not.toMatch(forbidden);
      expect(copy.body).not.toMatch(forbidden);
      expect(copy.title.length).toBeLessThanOrEqual(60);
    }
  });

  it('streak defense is only scheduled while its claim holds (no streak → none; past 7:30 PM untrained → none)', () => {
    const prefs = { ...DEFAULT_NOTIFICATION_PREFS, enabled: true };
    const noStreak = buildNotificationPlan(prefs, {
      nowMs: new Date(2026, 7, 25, 10, 0).getTime(),
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: true,
    });
    expect(noStreak.map(item => item.id)).not.toContain('ps.reminder.streak');

    const lateUntrained = buildNotificationPlan(prefs, {
      nowMs: new Date(2026, 7, 25, 21, 0).getTime(),
      streakDays: 4,
      practicedToday: false,
      hasAnyHistory: true,
    });
    expect(lateUntrained.map(item => item.id)).not.toContain(
      'ps.reminder.streak',
    );

    const trainedToday = buildNotificationPlan(prefs, {
      nowMs: new Date(2026, 7, 25, 21, 0).getTime(),
      streakDays: 4,
      practicedToday: true,
      hasAnyHistory: true,
    });
    const streak = trainedToday.find(item => item.id === 'ps.reminder.streak');
    expect(streak).toBeDefined();
    expect(new Date(streak!.timestampMs).getDate()).toBe(26);
    expect(streak!.repeat).toBeNull();

    // Weekly recap needs real history to talk about.
    const noHistory = buildNotificationPlan(prefs, {
      nowMs: new Date(2026, 7, 25, 10, 0).getTime(),
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    });
    expect(noHistory.map(item => item.id)).not.toContain('ps.reminder.weekly');
  });

  it('a plan sync recomputes facts fresh: trained-today moves streak defense to tomorrow', async () => {
    setActiveDataOwner(owner);
    mockScheduler.permission = 'granted';
    await useNotificationStore.getState().hydrate();
    await useNotificationStore.getState().setPrefs({ enabled: true });
    let streak = mockScheduler.appliedPlans
      .at(-1)!
      .find(item => item.id === 'ps.reminder.streak')!;
    expect(new Date(streak.timestampMs).getDate()).toBe(25);

    mockSnapshot.trainedToday = true;
    await useNotificationStore.getState().syncNow();
    streak = mockScheduler.appliedPlans
      .at(-1)!
      .find(item => item.id === 'ps.reminder.streak')!;
    expect(new Date(streak.timestampMs).getDate()).toBe(26);
  });
});
