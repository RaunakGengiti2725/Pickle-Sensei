import type { NotificationPlanContext } from '../src/notifications/plan';
import type {
  PermissionState,
  SchedulerPort,
} from '../src/notifications/service';
import type { PlannedNotification } from '../src/notifications/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
} from '../src/notifications/types';
import { buildNotificationPlan } from '../src/notifications/plan';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Throwaway execution probe (audit pass 2, mobile-settings-account).
 * Each `it` states a hypothesis about a failure mode; a FAILING test here
 * means the hypothesis was REFUTED (code behaves well); a PASSING test
 * means the failure mode was REPRODUCED. Assertions are written so that
 * "expect(<bad thing>)" passes when the bug exists.
 */

const mockKvTable = new Map<string, string>();
let mockKvWriteFails = false;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockKvWriteFails) throw new Error('disk full');
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import {
  PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
  useNotificationStore,
} from '../src/notifications/notificationStore';

type Op = { kind: 'apply'; ids: string[] } | { kind: 'cancel' };

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  ops: Op[] = [];
  requestResult: PermissionState = 'granted';
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    this.permission = this.requestResult;
    return this.requestResult;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.ops.push({ kind: 'apply', ids: plan.map(p => p.id) });
  }
  async cancelAllPlanned(): Promise<void> {
    this.ops.push({ kind: 'cancel' });
  }
  async openSystemSettings(): Promise<void> {}
}

const ctx: NotificationPlanContext = {
  nowMs: new Date(2026, 7, 25, 10, 0, 0).getTime(),
  streakDays: 2,
  practicedToday: false,
  hasAnyHistory: true,
};

const owner = '33333333-3333-4333-8333-333333333333';
const otherOwner = '44444444-4444-4444-8444-444444444444';

function resetStore() {
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvWriteFails = false;
  resetStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});
afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('probe: notificationStore', () => {
  it('H1 REPRO: enable→disable race leaves reminders scheduled (last op is apply, prefs.enabled=false)', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    await useNotificationStore.getState().hydrate({
      scheduler,
      loadContext: async () => ctx,
    });
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const slowDeps = {
      scheduler,
      loadContext: async () => {
        await gate;
        return ctx;
      },
    };
    const fastDeps = { scheduler, loadContext: async () => ctx };
    scheduler.ops = [];
    const enable = useNotificationStore
      .getState()
      .setPrefs({ enabled: true, promptDismissed: true }, slowDeps);
    // Wait until the slow sync is blocked in loadContext, then disable.
    await new Promise(r => setTimeout(r, 0));
    await useNotificationStore.getState().setPrefs({ enabled: false }, fastDeps);
    release();
    await enable;
    const state = useNotificationStore.getState();
    const last = scheduler.ops.at(-1)!;
    // eslint-disable-next-line no-console
    console.log('H1 ops', JSON.stringify(scheduler.ops), 'enabled', state.prefs.enabled);
    expect(state.prefs.enabled).toBe(false);
    expect(last.kind).toBe('apply');
    expect((last as { ids: string[] }).ids.length).toBeGreaterThan(0);
  });

  it('H2 REPRO: persistFailed from owner A survives hydrate() for owner B', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    const deps = { scheduler, loadContext: async () => ctx };
    await useNotificationStore.getState().hydrate(deps);
    mockKvWriteFails = true;
    await useNotificationStore.getState().setPrefs({ enabled: true }, deps);
    expect(useNotificationStore.getState().persistFailed).toBe(true);
    mockKvWriteFails = false;
    setActiveDataOwner(otherOwner);
    await useNotificationStore.getState().hydrate(deps);
    const s = useNotificationStore.getState();
    // eslint-disable-next-line no-console
    console.log('H2', { ownerKey: s.ownerKey, persistFailed: s.persistFailed });
    expect(s.ownerKey).toBe(otherOwner);
    expect(s.persistFailed).toBe(true);
  });

  it('H3 REPRO: signed-out onboarding "enable" reports true although the pending choice was not persisted', async () => {
    const scheduler = new FakeScheduler();
    mockKvWriteFails = true;
    const result = await useNotificationStore
      .getState()
      .completeOnboardingStep('enable', {
        scheduler,
        loadContext: async () => ctx,
      });
    // eslint-disable-next-line no-console
    console.log('H3', { result, stored: mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY) });
    expect(result).toBe(true);
    expect(mockKvTable.get(PENDING_NOTIFICATION_ONBOARDING_KV_KEY)).toBeUndefined();
  });

  it('H4 REPRO (TZ-dependent): reminder planned on a DST-transition day lands at the wrong wall-clock time', () => {
    // Run with TZ=America/New_York; DST ends 2026-11-01 02:00 local.
    const tz = process.env.TZ;
    const now = new Date(2026, 10, 1, 8, 0, 0).getTime();
    const plan = buildNotificationPlan(
      {
        ...DEFAULT_NOTIFICATION_PREFS,
        enabled: true,
        practiceReminder: true,
        practiceReminderMinutes: 17 * 60 + 30,
        streakDefense: false,
        weeklyRecap: false,
        comeback: false,
      },
      { ...ctx, nowMs: now },
    );
    const practice = plan.find(p => p.id === 'ps.reminder.practice')!;
    const at = new Date(practice.timestampMs);
    // eslint-disable-next-line no-console
    console.log('H4', { tz, offsetAtNow: new Date(now).getTimezoneOffset(), planned: at.toString() });
    expect(at.getHours() * 60 + at.getMinutes()).not.toBe(17 * 60 + 30);
  });

  it('H5 REPRO: owner prefs from a previous owner leak into the KV of a new owner via a pending-choice path? (expect refuted)', async () => {
    setActiveDataOwner(owner);
    const scheduler = new FakeScheduler();
    const deps = { scheduler, loadContext: async () => ctx };
    await useNotificationStore.getState().hydrate(deps);
    await useNotificationStore.getState().setPrefs({ enabled: true, practiceReminderMinutes: 6 * 60 }, deps);
    setActiveDataOwner(otherOwner);
    await useNotificationStore.getState().hydrate(deps);
    const s = useNotificationStore.getState();
    // eslint-disable-next-line no-console
    console.log('H5', s.prefs, mockKvTable.get(notificationPrefsKeyForOwner(otherOwner)));
    expect(s.prefs.enabled).toBe(true);
  });
});
