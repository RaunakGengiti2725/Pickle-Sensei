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
 * Ownership invariants:
 *   - `ownerKey` is the owner the in-memory state belongs to. The moment a
 *     different owner hydrates, the state is reset to that owner's defaults
 *     and marked un-hydrated; nothing of the previous owner is ever read or
 *     written under the new key.
 *   - `hydrated` means the in-memory prefs ARE the owner's durable prefs.
 *     Until then the defaults are placeholders: they are never persisted over
 *     the owner's row and never used to cancel what the owner has scheduled.
 *   - A write that arrives before the owner's row was read is kept as
 *     `pendingWrite` and merged on top of the row once it is read.
 *   - Every scheduler operation is decided from the prefs current at the
 *     moment it is issued, never from prefs captured before an await.
 */

export interface NotificationStoreDeps {
  scheduler?: SchedulerPort;
  loadContext?: () => Promise<NotificationPlanContext>;
  expectedOwnerKey?: string;
}

export type NotificationOnboardingChoice = 'enable' | 'not_now';
export const PENDING_NOTIFICATION_ONBOARDING_KV_KEY =
  'onboarding.pending-notifications';

type NotificationPrefsPatch = Partial<Omit<NotificationPrefs, 'version'>>;

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
  /** The owner's saved prefs could not be read. The store stays un-hydrated
   *  (the defaults shown are placeholders, not the owner's choices) and the
   *  next sync or write retries the read. */
  hydrateFailed: boolean;
  /** Preference changes made before the owner's row was read; merged on top
   *  of the row and persisted by the hydrate that reads it. */
  pendingWrite: NotificationPrefsPatch | null;
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
    patch: NotificationPrefsPatch,
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

export const useNotificationStore = create<NotificationState>((set, get) => {
  /** The hydrate currently reading an owner's row, if any. Writes and syncs
   *  that arrive meanwhile leave the durable work to it instead of racing. */
  let inFlightHydrate: { owner: string; done: Promise<void> } | null = null;
  /** Bumped by every persisted write so a hydrate that started earlier can
   *  tell its row read is older than the in-memory prefs. */
  let writeSeq = 0;

  const ownsCurrentState = (owner: string): boolean =>
    getActiveDataOwner() === owner && get().ownerKey === owner;

  const resetForOwner = (owner: string): void => {
    set({
      hydrated: false,
      ownerKey: owner,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      persistFailed: false,
      scheduleFailed: false,
      hydrateFailed: false,
      pendingWrite: null,
    });
  };

  /** Reads the owner's row (adopting a pre-auth onboarding choice and any
   *  pending write) and commits it as the hydrated state. Returns whether
   *  the store is hydrated for `owner` afterwards. */
  const readOwnerPrefs = async (owner: string): Promise<boolean> => {
    const writesBefore = writeSeq;
    let raw: string | null;
    let pendingRaw: string | null;
    try {
      const db = getDb();
      raw = await getKv(db, notificationPrefsKeyForOwner(owner));
      pendingRaw = await getKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
    } catch {
      if (ownsCurrentState(owner)) {
        set({
          hydrated: false,
          hydrateFailed: true,
          persistFailed: get().pendingWrite !== null,
        });
      }
      return false;
    }
    if (!ownsCurrentState(owner)) return false;

    let prefs = parseNotificationPrefs(raw);
    let persistFailed = false;
    const pendingChoice = parsePendingOnboardingChoice(pendingRaw);
    if (pendingChoice) {
      if (!raw) {
        prefs = {
          ...prefs,
          enabled: pendingChoice.enabled,
          promptDismissed: true,
        };
        try {
          await persistPrefs(owner, prefs);
        } catch {
          // The stash stays for the next hydrate; this session runs on the
          // adopted choice like any other unsaved preference change.
          persistFailed = true;
        }
        if (!ownsCurrentState(owner)) return false;
      }
      if (!persistFailed) {
        try {
          await setKv(getDb(), PENDING_NOTIFICATION_ONBOARDING_KV_KEY, '');
        } catch {
          // A row now exists, so the stash is ignored and re-cleared later.
        }
        if (!ownsCurrentState(owner)) return false;
      }
    }

    if (writeSeq !== writesBefore && get().hydrated) {
      // A write committed while the row was being read; the in-memory prefs
      // are newer than what was read.
      prefs = get().prefs;
      persistFailed = get().persistFailed;
    }
    // Writes made while the row was unknown land on top of it. Each persist
    // awaits, so keep draining until no further write arrived meanwhile.
    for (
      let pending = get().pendingWrite;
      pending;
      pending = get().pendingWrite
    ) {
      prefs = { ...prefs, ...pending, version: 1 };
      set({ pendingWrite: null });
      try {
        await persistPrefs(owner, prefs);
        persistFailed = false;
      } catch {
        persistFailed = true;
      }
      if (!ownsCurrentState(owner)) return false;
    }

    set({
      hydrated: true,
      ownerKey: owner,
      prefs,
      persistFailed,
      hydrateFailed: false,
      pendingWrite: null,
    });
    return true;
  };

  const hydrateOwner = async (
    owner: string,
    deps: NotificationStoreDeps | undefined,
  ): Promise<void> => {
    const scheduler = deps?.scheduler ?? getScheduler();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      // No readable owner: nothing may stay scheduled.
      await scheduler.cancelAllPlanned().catch(() => {});
      if (getActiveDataOwner() !== owner) return;
      set({
        hydrated: true,
        ownerKey: owner,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        permission: get().permission,
        persistFailed: false,
        scheduleFailed: false,
        hydrateFailed: false,
        pendingWrite: null,
      });
      return;
    }
    if (!(await readOwnerPrefs(owner))) return;
    await get().refreshPermission(deps);
    if (!ownsCurrentState(owner)) return;
    await get().syncNow(deps);
  };

  /** Re-reads the owner's row unless a hydrate is already doing so. */
  const ensureHydrated = async (
    owner: string,
    deps: NotificationStoreDeps | undefined,
  ): Promise<void> => {
    if (inFlightHydrate?.owner === owner) return;
    await get().hydrate({ ...deps, expectedOwnerKey: owner });
  };

  return {
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
    hydrateFailed: false,
    pendingWrite: null,

    hydrate: async deps => {
      const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
      if (getActiveDataOwner() !== owner) return;
      if (get().ownerKey !== owner) resetForOwner(owner);
      const done = hydrateOwner(owner, deps);
      const record = { owner, done };
      inFlightHydrate = record;
      try {
        await done;
      } finally {
        if (inFlightHydrate === record) inFlightHydrate = null;
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
      if (get().ownerKey !== owner) resetForOwner(owner);
      const current = get();
      if (!current.hydrated) {
        // The owner's row is not known yet: the choice drives this session
        // now and is merged onto the row when it is read — never written
        // over it from defaults.
        set({
          prefs: { ...current.prefs, ...patch, version: 1 },
          pendingWrite: { ...current.pendingWrite, ...patch },
        });
        await ensureHydrated(owner, deps);
        return;
      }
      const prefs: NotificationPrefs = {
        ...current.prefs,
        ...patch,
        version: 1,
      };
      writeSeq += 1;
      set({ prefs });
      try {
        await persistPrefs(owner, prefs);
        if (ownsCurrentState(owner)) set({ persistFailed: false });
      } catch {
        // The in-memory prefs still drive this session; the next successful
        // save persists them. Scheduling below reflects what the user chose.
        if (ownsCurrentState(owner)) set({ persistFailed: true });
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
      const state = get();
      try {
        if (owner === SIGNED_OUT_DATA_OWNER || state.ownerKey !== owner) {
          await scheduler.cancelAllPlanned();
          set({ scheduleFailed: false });
          return;
        }
        if (!state.hydrated) {
          // The owner's real prefs are unknown; cancelling on the defaults
          // would disarm reminders the owner saved. Read the row instead
          // (the hydrate syncs once it has).
          await ensureHydrated(owner, deps);
          return;
        }
        if (!state.prefs.enabled || state.permission !== 'granted') {
          await scheduler.cancelAllPlanned();
          set({ scheduleFailed: false });
          return;
        }
        const loadContext = deps?.loadContext ?? defaultLoadContext;
        const context = await loadContext();
        if (!ownsCurrentState(owner)) return;
        // Prefs or permission may have moved while the facts loaded; the
        // schedule must reflect the owner's latest choice, not the captured one.
        const latest = get();
        if (!latest.hydrated) return;
        if (!latest.prefs.enabled || latest.permission !== 'granted') {
          await scheduler.cancelAllPlanned();
          set({ scheduleFailed: false });
          return;
        }
        await scheduler.applyPlan(buildNotificationPlan(latest.prefs, context));
        set({ scheduleFailed: false });
      } catch {
        // Scheduling is best-effort by design: a failed sync never breaks the
        // app, and the next foreground pass retries with fresh facts.
        set({ scheduleFailed: true });
      }
    },
  };
});
