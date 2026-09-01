import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useNotificationStore } from './notificationStore';

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

  useEffect(() => {
    if (!ownerKey) return;
    void hydrate();
  }, [hydrate, ownerKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') return;
      void refreshPermission().then(() => syncNow());
    });
    return () => subscription.remove();
  }, [refreshPermission, syncNow]);
}
