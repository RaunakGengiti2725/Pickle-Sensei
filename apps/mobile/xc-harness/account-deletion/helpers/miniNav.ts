/**
 * Two-route stand-in for the RootNavigator's native stack, used by the
 * full-tree UI harness so the REAL SettingsScreen and ManageAccountScreen
 * render under the REAL App.tsx Gate without react-native-screens.
 *
 * Dependency-free (zustand only) so it can be required from inside
 * `jest.mock` factories.
 */
import { create } from 'zustand';

export type MiniRoute = 'Settings' | 'ManageAccount';

interface MiniNavState {
  route: MiniRoute;
  history: MiniRoute[];
  navigate(route: MiniRoute): void;
  goBack(): void;
  reset(): void;
}

export const useMiniNav = create<MiniNavState>((set, get) => ({
  route: 'Settings',
  history: [],
  navigate: route => set({ route, history: [...get().history, get().route] }),
  goBack: () => {
    const history = [...get().history];
    const previous = history.pop();
    if (previous) set({ route: previous, history });
  },
  reset: () => set({ route: 'Settings', history: [] }),
}));
