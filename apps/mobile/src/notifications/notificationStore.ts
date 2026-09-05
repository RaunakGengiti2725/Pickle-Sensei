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
 * Owner isolation: the in-memory state belongs to exactly one owner
 * (`ownerKey`) and is only ever `hydrated` for that owner. Starting the
 * hydrate of a different owner clears it synchronously, before the new row
 * is read, so nothing of the previous account is visible or writable in
 * between. A preference change made for an owner whose row has not been
 * read yet is HELD as a patch (`heldPatch`) rather than merged into whatever
 * prefs are in memory, and is re-based onto the real row the moment that
 * owner's hydrate commits — a switch can never copy one account's opt-in or
 * reminder time into another's row.
 */

export interface NotificationStoreDeps {
  scheduler?: SchedulerPort;
  loadContext?: () => Promise<NotificationPlanContext>;
  expectedOwnerKey?: string;
}

export type NotificationPrefsPatch = Partial<
  Omit<NotificationPrefs, 'version'>
>;

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
  /** A preference change for `owner` made before that owner's durable row
   *  was read. Persisted (on top of the row) when the owner's hydrate
   *  commits; dropped if the active owner changes first. */
  heldPatch: { owner: string; patch: NotificationPrefsPatch } | null;
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

/** State for an owner whose row has not been read: nothing of any other
 * owner, plus whatever this owner has already asked for on top of defaults. */
function unreadStateFor(
  owner: string,
  held: NotificationState['heldPatch'],
): Pick<
  NotificationState,
  | 'hydrated'
  | 'ownerKey'
  | 'prefs'
  | 'persistFailed'
  | 'scheduleFailed'
  | 'heldPatch'
> {
  const kept = held?.owner === owner ? held : null;
  return {
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS, ...kept?.patch, version: 1 },
    persistFailed: false,
    scheduleFailed: false,
    heldPatch: kept,
  };
}

/** Owners whose hydrate is currently between its start and its commit (or
 * abandonment). A write for such an owner only has to hold its patch; the
 * hydrate already in flight will persist it. */
const hydratesInFlight = new Map<string, number>();

function hydrateStarted(owner: string): void {
  hydratesInFlight.set(owner, (hydratesInFlight.get(owner) ?? 0) + 1);
}

function hydrateFinished(owner: string): void {
  const left = (hydratesInFlight.get(owner) ?? 1) - 1;
  if (left > 0) hydratesInFlight.set(owner, left);
  else hydratesInFlight.delete(owner);
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  prefs: { ...DEFAULT_NOTIFICATION_PREFS },
  permission: 'unknown',
  persistFailed: false,
  scheduleFailed: false,
  heldPatch: null,

  hydrate: async deps => {
    const owner = deps?.expectedOwnerKey ?? getActiveDataOwner();
    if (getActiveDataOwner() !== owner) return;
    if (get().ownerKey !== owner) {
      // Synchronous, before the first await: from here on no reader sees the
      // previous owner's prefs and no writer can build on them.
      set(unreadStateFor(owner, get().heldPatch));
    }
    hydrateStarted(owner);
    try {
      await hydrateOwner(owner, deps, set, get);
    } finally {
      hydrateFinished(owner);
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
    const state = get();
    if (!state.hydrated || state.ownerKey !== owner) {
      // This owner's row has not been read: whatever is in memory is not a
      // base to write from. Hold the intent (shown optimistically on top of
      // defaults) and let the owner's hydrate re-base it onto the real row.
      const held = state.heldPatch?.owner === owner ? state.heldPatch : null;
      const merged: NotificationPrefsPatch = { ...held?.patch, ...patch };
      set({
        ...unreadStateFor(owner, { owner, patch: merged }),
        persistFailed: state.persistFailed,
        scheduleFailed: state.scheduleFailed,
      });
      if (hydratesInFlight.has(owner)) return;
      await get().hydrate({ ...deps, expectedOwnerKey: owner });
      return;
    }
    const prefs: NotificationPrefs = { ...state.prefs, ...patch, version: 1 };
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
    const scheduler = deps?.scheduler ?? getScheduler();
    const owner = getActiveDataOwner();
    const { ownerKey, prefs, permission } = get();
    try {
      if (
        owner === SIGNED_OUT_DATA_OWNER ||
        ownerKey !== owner ||
        !prefs.enabled ||
        permission !== 'granted'
      ) {
        await scheduler.cancelAllPlanned();
        set({ scheduleFailed: false });
        return;
      }
      const loadContext = deps?.loadContext ?? defaultLoadContext;
      const plan = buildNotificationPlan(prefs, await loadContext());
      if (getActiveDataOwner() !== owner || get().ownerKey !== owner) return;
      await scheduler.applyPlan(plan);
      set({ scheduleFailed: false });
    } catch {
      // Scheduling is best-effort by design: a failed sync never breaks the
      // app, and the next foreground pass retries with fresh facts.
      set({ scheduleFailed: true });
    }
  },
}));

type Set = (partial: Partial<NotificationState>) => void;
type Get = () => NotificationState;

/** Reads `owner`'s durable row and commits it — with any patch held for
 * that owner persisted on top — unless the active owner moved on meanwhile,
 * in which case nothing is committed and the held patch stays for the
 * hydrate that does commit (or is dropped by the next owner's start). */
async function hydrateOwner(
  owner: string,
  deps: NotificationStoreDeps | undefined,
  set: Set,
  get: Get,
): Promise<void> {
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
      heldPatch: null,
    });
    return;
  }
  let prefs: NotificationPrefs;
  try {
    const db = getDb();
    const raw = await getKv(db, notificationPrefsKeyForOwner(owner));
    prefs = parseNotificationPrefs(raw);
    const pendingRaw = await getKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
    const pending = parsePendingOnboardingChoice(pendingRaw);
    if (getActiveDataOwner() !== owner) return;
    if (pending) {
      if (!raw) {
        prefs = {
          ...prefs,
          enabled: pending.enabled,
          promptDismissed: true,
        };
        await persistPrefs(owner, prefs);
        if (getActiveDataOwner() !== owner) return;
      }
      await setKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY, '');
    }
  } catch {
    prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  }
  if (getActiveDataOwner() !== owner) return;
  const held = get().heldPatch;
  const replay = held?.owner === owner ? held.patch : null;
  set({ hydrated: true, ownerKey: owner, prefs, heldPatch: null });
  if (replay) {
    // Now that the row is the base, the held change is an ordinary write.
    await get().setPrefs(replay, deps);
    if (getActiveDataOwner() !== owner || get().ownerKey !== owner) return;
  }
  await get().refreshPermission(deps);
  if (getActiveDataOwner() !== owner || get().ownerKey !== owner) return;
  await get().syncNow(deps);
}
