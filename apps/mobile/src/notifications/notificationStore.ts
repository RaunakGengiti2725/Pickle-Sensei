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
 * Concurrency model — the in-memory prefs are only ever a COMMITTED read of
 * the active owner's durable row:
 *   - every hydrate opens a new epoch; an owner change invalidates the
 *     committed state synchronously, and any older pass that resumes after
 *     an await sees it is no longer current and stops without writing;
 *   - a write that arrives while the active owner's row is not in memory
 *     (switch in flight, read failed, never read) is HELD and re-based onto
 *     the row once a read commits — a patch carries the player's absolute
 *     choice, so it applies identically on top of whatever the row holds;
 *   - every scheduler-facing pass takes a sequence number and OS ops run on
 *     one ordered lane; a pass superseded by a newer one is dropped at the
 *     lane, so the last OS op always reflects the newest prefs;
 *   - a failed durable read leaves the store unhydrated with `readFailed`
 *     set — defaults are never presented (or persisted) as truth.
 */

export interface NotificationStoreDeps {
  scheduler?: SchedulerPort;
  loadContext?: () => Promise<NotificationPlanContext>;
  expectedOwnerKey?: string;
}

export type NotificationOnboardingChoice = 'enable' | 'not_now';
export type NotificationPrefsPatch = Partial<
  Omit<NotificationPrefs, 'version'>
>;
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
  /** The active owner's durable prefs could not be read; the store stays
   *  unhydrated and holds writes until a read succeeds. */
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
    patch: NotificationPrefsPatch,
    deps?: NotificationStoreDeps,
  ) => Promise<void>;
  dismissPrompt: (deps?: NotificationStoreDeps) => Promise<void>;
  /** Recomputes the plan from current facts and applies it to the OS. */
  syncNow: (deps?: NotificationStoreDeps) => Promise<void>;
}

type LaneOutcome = 'applied' | 'superseded';

let hydrateEpoch = 0;
let syncSequence = 0;
let hydrateInFlight: { owner: string; promise: Promise<void> } | null = null;
let heldPatches: { owner: string; patch: NotificationPrefsPatch }[] = [];
let schedulerLane: Promise<unknown> = Promise.resolve();

function takeHeldPatches(owner: string): NotificationPrefsPatch[] {
  const mine = heldPatches.filter(h => h.owner === owner).map(h => h.patch);
  heldPatches = heldPatches.filter(h => h.owner !== owner);
  return mine;
}

/** Runs one OS-facing op in order; a pass that is no longer the newest by
 *  the time its op reaches the lane is dropped so it cannot land after the
 *  op that reflects the newer prefs. */
function throughSchedulerLane(
  sequence: number,
  op: () => Promise<void>,
): Promise<LaneOutcome> {
  const run = schedulerLane.then(async (): Promise<LaneOutcome> => {
    if (sequence !== syncSequence) return 'superseded';
    await op();
    return 'applied';
  });
  schedulerLane = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
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
  /** The committed state belongs to exactly one owner. Anything else in
   *  memory is invalidated the moment a different owner becomes active. */
  const invalidateFor = (owner: string) => {
    if (get().ownerKey === owner) return;
    set({
      hydrated: false,
      ownerKey: owner,
      prefs: { ...DEFAULT_NOTIFICATION_PREFS },
      persistFailed: false,
      scheduleFailed: false,
      readFailed: false,
    });
  };

  const hydrateOwner = async (
    owner: string,
    deps?: NotificationStoreDeps,
  ): Promise<void> => {
    const epoch = ++hydrateEpoch;
    // Any pass still in flight was built on an older view of the store.
    syncSequence += 1;
    const current = () =>
      epoch === hydrateEpoch && getActiveDataOwner() === owner;
    heldPatches = heldPatches.filter(h => h.owner === owner);
    invalidateFor(owner);

    if (owner === SIGNED_OUT_DATA_OWNER) {
      // No readable owner: nothing may stay scheduled.
      set({
        hydrated: true,
        ownerKey: owner,
        prefs: { ...DEFAULT_NOTIFICATION_PREFS },
        persistFailed: false,
        scheduleFailed: false,
        readFailed: false,
      });
      await get().syncNow(deps);
      return;
    }

    let db: ReturnType<typeof getDb>;
    let raw: string | null;
    let pendingRaw: string | null;
    try {
      db = getDb();
      raw = await getKv(db, notificationPrefsKeyForOwner(owner));
      pendingRaw = await getKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY);
    } catch {
      if (!current()) return;
      // An already-committed view of this owner stays authoritative; an
      // uncommitted one must not be mistaken for defaults.
      if (!(get().hydrated && get().ownerKey === owner)) {
        set({ hydrated: false, ownerKey: owner, readFailed: true });
      }
      return;
    }
    if (!current()) return;

    let prefs = parseNotificationPrefs(raw);
    let dirty = false;
    const pending = parsePendingOnboardingChoice(pendingRaw);
    if (pending && !raw) {
      prefs = { ...prefs, enabled: pending.enabled, promptDismissed: true };
      dirty = true;
    }
    const held = takeHeldPatches(owner);
    for (const patch of held) {
      prefs = { ...prefs, ...patch, version: 1 };
      dirty = true;
    }

    let persistFailed = false;
    if (dirty) {
      try {
        await persistPrefs(owner, prefs);
      } catch {
        persistFailed = true;
      }
      if (!current()) {
        if (persistFailed) {
          heldPatches.push(...held.map(patch => ({ owner, patch })));
        }
        return;
      }
    }
    if (pending) {
      // One-shot marker. If clearing fails it is re-read next hydrate and
      // ignored once the owner's row exists, so nothing is lost or doubled.
      try {
        await setKv(db, PENDING_NOTIFICATION_ONBOARDING_KV_KEY, '');
      } catch {
        /* see above */
      }
      if (!current()) return;
    }

    set({
      hydrated: true,
      ownerKey: owner,
      prefs,
      persistFailed,
      readFailed: false,
    });
    await get().refreshPermission(deps);
    if (!current() || get().ownerKey !== owner) return;
    await get().syncNow(deps);
  };

  return {
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
      const promise = hydrateOwner(owner, deps);
      const entry = { owner, promise };
      hydrateInFlight = entry;
      try {
        await promise;
      } finally {
        if (hydrateInFlight === entry) hydrateInFlight = null;
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
        // This owner's row is not in memory: hold the choice and re-base it
        // onto the row when a read commits. The in-memory view (once it is
        // this owner's) reflects the tap right away.
        heldPatches.push({ owner, patch });
        invalidateFor(owner);
        set({ prefs: { ...get().prefs, ...patch, version: 1 } });
        const inFlight = hydrateInFlight;
        if (inFlight && inFlight.owner === owner) {
          await inFlight.promise;
        } else {
          await get().hydrate(deps);
        }
        return;
      }
      const prefs: NotificationPrefs = { ...state.prefs, ...patch, version: 1 };
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
      const sequence = ++syncSequence;
      const state = get();
      const cancelAll = () => scheduler.cancelAllPlanned();

      if (
        owner !== SIGNED_OUT_DATA_OWNER &&
        !(state.hydrated && state.ownerKey === owner)
      ) {
        if (state.hydrated) {
          // Committed for a previous owner: their plan must not outlive them.
          try {
            if ((await throughSchedulerLane(sequence, cancelAll)) === 'applied')
              set({ scheduleFailed: false });
          } catch {
            if (sequence === syncSequence) set({ scheduleFailed: true });
          }
          return;
        }
        // This owner's prefs are unknown: a read decides, never a guess.
        if (hydrateInFlight?.owner === owner) return;
        await get().hydrate(deps);
        return;
      }

      try {
        if (
          owner === SIGNED_OUT_DATA_OWNER ||
          !state.prefs.enabled ||
          state.permission !== 'granted'
        ) {
          if ((await throughSchedulerLane(sequence, cancelAll)) === 'applied')
            set({ scheduleFailed: false });
          return;
        }
        const loadContext = deps?.loadContext ?? defaultLoadContext;
        const context = await loadContext();
        if (sequence !== syncSequence) return;
        if (getActiveDataOwner() !== owner || get().ownerKey !== owner) return;
        // Re-read after the await: the plan must reflect what the player
        // chose by now, not what they had chosen when the pass started.
        const fresh = get();
        const op =
          !fresh.prefs.enabled || fresh.permission !== 'granted'
            ? cancelAll
            : () =>
                scheduler.applyPlan(
                  buildNotificationPlan(fresh.prefs, context),
                );
        if ((await throughSchedulerLane(sequence, op)) === 'applied')
          set({ scheduleFailed: false });
      } catch {
        // Scheduling is best-effort by design: a failed sync never breaks the
        // app, and the next foreground pass retries with fresh facts. A pass
        // that was superseded leaves the flag to the newer one.
        if (sequence === syncSequence) set({ scheduleFailed: true });
      }
    },
  };
});
