import { create } from 'zustand';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  getActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import { computeConsistencySnapshot } from '../consistency/store';
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
 *
 * Two invariants make the async paths safe:
 * - The in-memory state describes exactly ONE owner. Observing a different
 *   active owner invalidates it (unhydrated, default prefs) and a write made
 *   before that owner's durable row has been read is held and rebased onto it,
 *   so no account can inherit another account's opt-in or reminder time.
 * - Scheduler passes are sequenced. Only the newest pass may touch the OS
 *   queue or the scheduling flags, so a sync that resumes after an await can
 *   never apply prefs the user has since changed nor mask a newer failure.
 */

export interface NotificationStoreDeps {
  scheduler?: SchedulerPort;
  loadContext?: () => Promise<NotificationPlanContext>;
  expectedOwnerKey?: string;
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
  /** The durable preferences could not be read; defaults are NOT the truth
   *  for this owner, so nothing is presented or written until a read lands. */
  readFailed: boolean;
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

/** Newest hydrate pass; older passes must not commit anything. */
let hydratePass = 0;
/** Hydrates that have not settled yet; one of them will adopt a held write. */
let hydratesInFlight = 0;
/** Newest scheduler pass; older passes must not touch the queue or flags. */
let schedulerPass = 0;
/** A write made before its owner's durable row was read, rebased on hydrate. */
let deferredWrite: {
  owner: string;
  patch: Partial<Omit<NotificationPrefs, 'version'>>;
} | null = null;

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

export const useNotificationStore = create<NotificationState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'unknown',
  persistFailed: false,
  scheduleFailed: false,
  readFailed: false,

  hydrate: async deps => {
    const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
    if (getActiveDataOwner() !== owner) return;
    const pass = ++hydratePass;
    const live = () => pass === hydratePass && getActiveDataOwner() === owner;
    if (get().ownerKey !== owner) {
      // The state describes another owner: it stops being the truth for this
      // process the moment the switch is observed, not when the read lands.
      set({
        hydrated: false,
        ownerKey: null,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        permission: get().permission,
        persistFailed: false,
        scheduleFailed: false,
        readFailed: false,
      });
    }
    if (deferredWrite && deferredWrite.owner !== owner) deferredWrite = null;
    hydratesInFlight += 1;
    try {
      const scheduler = deps?.scheduler ?? getScheduler();
      if (owner === SIGNED_OUT_DATA_OWNER) {
        // No readable owner: nothing may stay scheduled.
        await scheduler.cancelAllPlanned().catch(() => {});
        if (!live()) return;
        set({
          hydrated: true,
          ownerKey: owner,
          prefs: { ...DEFAULT_NOTIFICATION_PREFS },
          permission: get().permission,
          persistFailed: false,
          scheduleFailed: false,
          readFailed: false,
        });
        return;
      }

      let raw: string | null;
      let pendingRaw: string | null;
      try {
        const db = getDb();
        raw = await getKv(db, notificationPrefsKeyForOwner(owner));
        pendingRaw = await getKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
      } catch {
        // The read failed: defaults are not this owner's preferences. Staying
        // unhydrated keeps the saved row intact until a read succeeds.
        if (!live()) return;
        set({ readFailed: true });
        return;
      }
      if (!live()) return;
      let prefs = parseNotificationPrefs(raw);
      const pending = parsePendingOnboardingChoice(pendingRaw);
      if (pending) {
        if (!raw) {
          prefs = { ...prefs, enabled: pending.enabled, promptDismissed: true };
        }
        try {
          if (!raw) await persistPrefs(owner, prefs);
          await setKv(getDb(), PENDING_NOTIFICATION_ONBOARDING_KV_KEY, '');
          if (!live()) return;
          set({ persistFailed: false });
        } catch {
          if (!live()) return;
          set({ persistFailed: true });
        }
      }
      if (!live()) return;
      set({ hydrated: true, ownerKey: owner, prefs, readFailed: false });
      await get().refreshPermission(deps);
      if (!live() || get().ownerKey !== owner) return;
      const held = deferredWrite?.owner === owner ? deferredWrite.patch : null;
      deferredWrite = null;
      if (held) {
        // Rebased on this owner's real prefs, then persisted and scheduled.
        await get().setPrefs(held, deps);
        return;
      }
      await get().syncNow(deps);
    } finally {
      hydratesInFlight -= 1;
    }
  },

  refreshPermission: async deps => {
    const scheduler = deps?.scheduler ?? getScheduler();
    try {
      set({ permission: await scheduler.permissionState() });
    } catch {
      set({ permission: 'unknown' });
    }
  },

  requestPermissionAndEnable: async deps => {
    const scheduler = deps?.scheduler ?? getScheduler();
    let state: PermissionState;
    try {
      state = await scheduler.requestPermission();
    } catch {
      set({ permission: 'unknown' });
      return false;
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
      try {
        const state = await scheduler.requestPermission();
        set({ permission: state });
        enabled = state === 'granted';
      } catch {
        set({ permission: 'unknown' });
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
    const { hydrated, ownerKey } = get();
    if (!hydrated || ownerKey !== owner) {
      // This owner's durable row has not been read yet: the in-memory prefs
      // belong to nobody, so hold the patch for the hydrate that rebases it
      // instead of writing another owner's values under this owner's key.
      deferredWrite = {
        owner,
        patch: {
          ...(deferredWrite?.owner === owner ? deferredWrite.patch : {}),
          ...patch,
        },
      };
      // A hydrate already in flight will adopt it; otherwise read now so the
      // choice still lands on this owner's real preferences.
      if (hydratesInFlight === 0) await get().hydrate(deps);
      return;
    }
    const prefs: NotificationPrefs = { ...get().prefs, ...patch, version: 1 };
    set({ prefs });
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
    const scheduler = deps?.scheduler ?? getScheduler();
    const owner = getActiveDataOwner();
    const pass = ++schedulerPass;
    const newest = () => pass === schedulerPass;
    const { ownerKey, prefs, permission } = get();
    try {
      if (
        owner === SIGNED_OUT_DATA_OWNER ||
        ownerKey !== owner ||
        !prefs.enabled ||
        permission !== 'granted'
      ) {
        await scheduler.cancelAllPlanned();
        if (!newest()) return;
        set({ scheduleFailed: false });
        return;
      }
      const loadContext = deps?.loadContext ?? defaultLoadContext;
      const plan = buildNotificationPlan(prefs, await loadContext());
      // A newer pass has already reconciled the OS queue against newer
      // preferences; this plan is stale and may neither be applied nor
      // report success over the newer pass's result.
      if (!newest() || getActiveDataOwner() !== owner) return;
      if (get().ownerKey !== owner) return;
      await scheduler.applyPlan(plan);
      if (!newest()) return;
      set({ scheduleFailed: false });
    } catch {
      // Scheduling is best-effort by design: a failed sync never breaks the
      // app, and the next foreground pass retries with fresh facts.
      if (!newest()) return;
      set({ scheduleFailed: true });
    }
  },
}));
