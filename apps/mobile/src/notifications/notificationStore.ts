import { create } from 'zustand';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
  type DataOwnerContext,
} from '../data/accountScope';
import { computeConsistencySnapshot } from '../consistency/store';
import { claimSurface } from '../flow/ceremonyRequest';
import { buildNotificationPlan, type NotificationPlanContext } from './plan';
import {
  getScheduler,
  type PermissionState,
  type SchedulerPort,
} from './service';
import {
  DEFAULT_NOTIFICATION_PREFS,
  notificationPrefsKeyForOwner,
  parseNotificationPrefs,
  type NotificationPrefs,
} from './types';

/**
 * Reminder preferences + scheduling state. Durable copies live in the
 * owner-scoped SQLite kv (same pattern as the profile); the schedule itself
 * is reconciled against the OS on every hydrate/sync so preferences, streak
 * facts, and what is actually queued can never drift apart.
 *
 * A signed-out process gets everything cancelled — reminders never outlive
 * the account context that asked for them.
 */

export interface NotificationStoreDeps {
  scheduler?: SchedulerPort;
  loadContext?: () => Promise<NotificationPlanContext>;
  expectedOwnerKey?: string;
  isCurrent?: () => boolean;
}

export type NotificationOnboardingChoice = 'enable' | 'not_now';
export const PENDING_NOTIFICATION_ONBOARDING_KV_KEY =
  'onboarding.pending-notifications';

interface NotificationState {
  hydrated: boolean;
  ownerKey: string | null;
  prefs: NotificationPrefs;
  permission: PermissionState | 'unknown';
  /** The last preference write to the device kv failed; in-memory prefs
   *  drive this session but will not survive a restart until a write lands. */
  persistFailed: boolean;
  /** The last reconcile against the OS scheduler failed; what is queued may
   *  not match the preferences until the next successful sync. */
  scheduleFailed: boolean;
  hydrate: (deps?: NotificationStoreDeps) => Promise<void>;
  refreshPermission: (deps?: NotificationStoreDeps) => Promise<void>;
  /** System prompt → on grant, flips the master switch on and schedules. */
  requestPermissionAndEnable: (
    deps?: NotificationStoreDeps,
  ) => Promise<boolean>;
  completeOnboardingStep: (
    choice: NotificationOnboardingChoice,
    deps?: NotificationStoreDeps,
  ) => Promise<boolean>;
  setPrefs: (
    patch: Partial<Omit<NotificationPrefs, 'version'>>,
    deps?: NotificationStoreDeps,
  ) => Promise<void>;
  dismissPrompt: (deps?: NotificationStoreDeps) => Promise<void>;
  /** Recomputes the plan from current facts and applies it to the OS. */
  syncNow: (deps?: NotificationStoreDeps) => Promise<void>;
}

async function defaultLoadContext(): Promise<NotificationPlanContext> {
  const nowMs = Date.now();
  try {
    // The consistency engine's streak — meaningful training days (analyses,
    // sessions, drills), the same number every streak surface shows. Streak
    // defense therefore defends something the player actually cares about.
    const snapshot = await computeConsistencySnapshot();
    return {
      nowMs,
      streakDays: snapshot.currentStreak,
      practicedToday: snapshot.trainedToday,
      hasAnyHistory: snapshot.totalActivities > 0,
      shieldsAvailable: snapshot.shieldsAvailable,
      milestoneEve:
        snapshot.nextStreakMilestone &&
        snapshot.nextStreakMilestone.daysAway === 1
          ? {
              title: snapshot.nextStreakMilestone.title,
              days: snapshot.nextStreakMilestone.days,
            }
          : null,
    };
  } catch {
    // Without readable history the plan degrades to fact-free reminders
    // (practice nudge + comeback ladder) instead of failing the sync.
    return {
      nowMs,
      streakDays: 0,
      practicedToday: false,
      hasAnyHistory: false,
    };
  }
}

function parsePendingOnboardingChoice(
  raw: string | null,
): { enabled: boolean } | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const record = value as Record<string, unknown>;
    return record['version'] === 1 && typeof record['enabled'] === 'boolean'
      ? { enabled: record['enabled'] }
      : null;
  } catch {
    return null;
  }
}

async function persistPrefs(
  owner: string,
  prefs: NotificationPrefs,
): Promise<void> {
  await setKv(
    getDb(),
    notificationPrefsKeyForOwner(owner),
    JSON.stringify(prefs),
  );
}

function ownerIsCurrent(
  owner: string,
  context: DataOwnerContext | null,
  deps?: NotificationStoreDeps,
): boolean {
  return (
    getActiveDataOwner() === owner &&
    (context === null || isDataOwnerContextCurrent(context)) &&
    (deps?.isCurrent?.() ?? true)
  );
}

let scheduleRevision = 0;
let scheduleQueue: Promise<void> = Promise.resolve();

export const useNotificationStore = create<NotificationState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'unknown',
  persistFailed: false,
  scheduleFailed: false,

  hydrate: async deps => {
    const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
    if (getActiveDataOwner() !== owner) return;
    const context =
      owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
    const isCurrent = () => ownerIsCurrent(owner, context, deps);
    if (!isCurrent()) return;
    const scopedDeps = { ...deps, expectedOwnerKey: owner, isCurrent };
    if (owner === SIGNED_OUT_DATA_OWNER) {
      // No readable owner: nothing may stay scheduled.
      set({
        hydrated: true,
        ownerKey: owner,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        permission: get().permission,
        persistFailed: false,
        scheduleFailed: false,
      });
      await get().syncNow(scopedDeps);
      return;
    }
    let prefs: NotificationPrefs;
    try {
      const db = getDb();
      const raw = await getKv(db, notificationPrefsKeyForOwner(owner));
      prefs = parseNotificationPrefs(raw);
      const pendingRaw = await getKv(
        db,
        PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
      );
      const pending = parsePendingOnboardingChoice(pendingRaw);
      if (!isCurrent()) return;
      if (pending) {
        if (!raw) {
          prefs = {
            ...prefs,
            enabled: pending.enabled,
            promptDismissed: true,
          };
          await persistPrefs(owner, prefs);
          if (!isCurrent()) return;
        }
        await setKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY, '');
      }
    } catch {
      prefs = { ...DEFAULT_NOTIFICATION_PREFS };
    }
    if (!isCurrent()) return;
    set({ hydrated: true, ownerKey: owner, prefs });
    await get().refreshPermission(scopedDeps);
    if (!isCurrent() || get().ownerKey !== owner) return;
    await get().syncNow(scopedDeps);
  },

  refreshPermission: async deps => {
    const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
    if (getActiveDataOwner() !== owner) return;
    const context =
      owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
    const isCurrent = () => ownerIsCurrent(owner, context, deps);
    if (!isCurrent()) return;
    try {
      const scheduler = deps?.scheduler ?? getScheduler();
      const permission = await scheduler.permissionState();
      if (isCurrent()) set({ permission });
    } catch {
      if (isCurrent()) set({ permission: 'unknown' });
    }
  },

  requestPermissionAndEnable: async deps => {
    const scheduler = deps?.scheduler ?? getScheduler();
    let state: PermissionState;
    const sheet = claimSurface('permission');
    try {
      state = await scheduler.requestPermission();
    } catch {
      set({ permission: 'unknown' });
      return false;
    } finally {
      sheet.release();
    }
    set({ permission: state });
    if (state !== 'granted') return false;
    await get().setPrefs({ enabled: true, promptDismissed: true }, deps);
    return true;
  },

  completeOnboardingStep: async (choice, deps) => {
    const scheduler = deps?.scheduler ?? getScheduler();
    let enabled = false;
    if (choice === 'enable') {
      const sheet = claimSurface('permission');
      try {
        const state = await scheduler.requestPermission();
        set({ permission: state });
        enabled = state === 'granted';
      } catch {
        set({ permission: 'unknown' });
      } finally {
        sheet.release();
      }
    }
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      try {
        await setKv(
          getDb(),
          PENDING_NOTIFICATION_ONBOARDING_KV_KEY,
          JSON.stringify({ version: 1, enabled }),
        );
      } catch {
        return enabled;
      }
      return enabled;
    }
    await get().setPrefs({ enabled, promptDismissed: true }, deps);
    return enabled;
  },

  setPrefs: async (patch, deps) => {
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) return;
    const prefs: NotificationPrefs = { ...get().prefs, ...patch, version: 1 };
    set({ prefs, ownerKey: owner });
    try {
      await persistPrefs(owner, prefs);
      set({ persistFailed: false });
    } catch {
      // The in-memory prefs still drive this session; the next successful
      // save persists them. Scheduling below reflects what the user chose.
      set({ persistFailed: true });
    }
    await get().syncNow(deps);
  },

  dismissPrompt: async deps => {
    if (get().prefs.promptDismissed) return;
    await get().setPrefs({ promptDismissed: true }, deps);
  },

  syncNow: async deps => {
    const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
    if (getActiveDataOwner() !== owner) return;
    const context =
      owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
    if (!ownerIsCurrent(owner, context, deps)) return;
    const revision = ++scheduleRevision;
    const { ownerKey, prefs, permission } = get();
    const isCurrent = () =>
      revision === scheduleRevision &&
      ownerIsCurrent(owner, context, deps) &&
      get().ownerKey === ownerKey &&
      get().prefs === prefs &&
      get().permission === permission;
    try {
      const scheduler = deps?.scheduler ?? getScheduler();
      let plan: ReturnType<typeof buildNotificationPlan> | null = null;
      if (
        owner !== SIGNED_OUT_DATA_OWNER &&
        ownerKey === owner &&
        prefs.enabled &&
        permission === 'granted'
      ) {
        const loadContext = deps?.loadContext ?? defaultLoadContext;
        plan = buildNotificationPlan(prefs, await loadContext());
      }
      if (!isCurrent()) return;
      const apply = async () => {
        if (!isCurrent()) return;
        if (plan === null) await scheduler.cancelAllPlanned();
        else await scheduler.applyPlan(plan);
        if (isCurrent()) set({ scheduleFailed: false });
      };
      scheduleQueue = scheduleQueue.then(apply, apply);
      await scheduleQueue;
    } catch {
      // Scheduling is best-effort by design: a failed sync never breaks the
      // app, and the next foreground pass retries with fresh facts.
      if (isCurrent()) set({ scheduleFailed: true });
    }
  },
}));
