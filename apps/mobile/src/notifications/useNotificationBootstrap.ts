import { useEffect } from 'react';
import { AppState } from 'react-native';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import { useConsistencyStore } from '../consistency/store';
import { useNotificationStore } from './notificationStore';

function reminderActivityKey(
  state: ReturnType<typeof useConsistencyStore.getState>,
): string | null {
  const snapshot = state.snapshot;
  if (!snapshot || state.loadError) return null;
  return JSON.stringify([
    state.ownerKey,
    snapshot.asOfDay,
    snapshot.timeZone,
    snapshot.totalActivities,
    snapshot.currentStreak,
    snapshot.trainedToday,
    snapshot.shieldsAvailable,
    snapshot.nextStreakMilestone?.daysAway,
    snapshot.nextStreakMilestone?.days,
    snapshot.nextStreakMilestone?.title,
  ]);
}

/**
 * Keeps the on-device reminder schedule truthful for the active account:
 *   - (re)hydrates preferences whenever the data owner changes (sign-in,
 *     sign-out, guest), cancelling everything for a signed-out process;
 *   - re-syncs on every return to the foreground, which pushes the
 *     inactivity ladder forward and re-evaluates streak facts.
 *
 * `ownerKey` is the resolved data-owner (or null while auth hydrates).
 */
export function useNotificationBootstrap(ownerKey: string | null): void {
  const hydrate = useNotificationStore(s => s.hydrate);
  const refreshPermission = useNotificationStore(s => s.refreshPermission);
  const syncNow = useNotificationStore(s => s.syncNow);
  const ownerGeneration =
    ownerKey &&
    ownerKey !== SIGNED_OUT_DATA_OWNER &&
    ownerKey === getActiveDataOwner()
      ? captureDataOwnerContext().generation
      : null;

  useEffect(() => {
    if (!ownerKey || ownerKey !== getActiveDataOwner()) return;
    const ownerContext =
      ownerKey === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
    let active = true;
    let foreground = AppState.currentState === 'active';
    let foregroundRevision = 0;
    let running = true;
    let pending = false;
    let permissionCheck = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const isCurrent = () =>
      active &&
      ownerKey === getActiveDataOwner() &&
      (ownerContext === null || isDataOwnerContextCurrent(ownerContext));
    const canSync = () => isCurrent() && foreground;
    const clearTimer = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const queueSync = (refresh = false) => {
      if (!canSync()) return;
      pending = true;
      permissionCheck ||= refresh;
      if (running || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        void drain();
      }, 0);
    };
    const drain = async () => {
      if (!pending || !canSync()) return;
      running = true;
      pending = false;
      const refresh = permissionCheck;
      permissionCheck = false;
      const revision = foregroundRevision;
      const deps = {
        expectedOwnerKey: ownerKey,
        isCurrent: () => canSync() && revision === foregroundRevision,
      };
      try {
        if (refresh) await refreshPermission(deps);
        if (deps.isCurrent()) await syncNow(deps);
      } catch {
        return;
      } finally {
        running = false;
        if (pending) queueSync();
      }
    };
    const unsubscribe = useConsistencyStore.subscribe((state, previous) => {
      if (
        state.ownerKey !== ownerKey ||
        !state.snapshot ||
        state.loadError ||
        state.snapshot === previous.snapshot ||
        reminderActivityKey(state) === reminderActivityKey(previous)
      )
        return;
      queueSync();
    });
    const subscription = AppState.addEventListener('change', nextState => {
      foreground = nextState === 'active';
      if (foreground) {
        queueSync(true);
      } else {
        foregroundRevision += 1;
        pending = false;
        permissionCheck = false;
        clearTimer();
      }
    });
    void hydrate({ expectedOwnerKey: ownerKey, isCurrent })
      .catch(() => {})
      .finally(() => {
        running = false;
        if (pending) queueSync();
      });
    return () => {
      active = false;
      clearTimer();
      unsubscribe();
      subscription.remove();
    };
  }, [hydrate, ownerGeneration, ownerKey, refreshPermission, syncNow]);
}
