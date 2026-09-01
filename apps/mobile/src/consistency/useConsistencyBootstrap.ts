import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useConsistencyStore } from './store';

/**
 * Owner-scoped consistency state: hydrates per account and re-derives the
 * streak on every return to the foreground — the moment midnight passes or
 * a background sync lands, the flame is honest again. Mirrors
 * useNotificationBootstrap so App.tsx wires both the same way.
 */
export function useConsistencyBootstrap(ownerKey: string | null): void {
  const hydrate = useConsistencyStore(s => s.hydrate);
  const refresh = useConsistencyStore(s => s.refresh);

  useEffect(() => {
    if (!ownerKey) return;
    void hydrate();
  }, [hydrate, ownerKey]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState !== 'active') return;
      void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
}
