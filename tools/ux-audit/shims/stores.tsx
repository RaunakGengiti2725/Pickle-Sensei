/**
 * Store aliases for `src/state/appStore`, `src/auth/authStore` and
 * `src/notifications/notificationStore`. The screens only read a handful of
 * fields and call async actions; the harness supplies those values from the
 * scenario so busy/error states can be rendered deterministically without
 * SQLite, Keychain or the network.
 */
import { useSyncExternalStore } from "react";

export { focusForGoal } from "../../../apps/mobile/src/state/profile";
export type { Gender, Profile } from "../../../apps/mobile/src/state/profile";

export interface AuthError {
  code: string;
  message: string;
}

export interface HarnessStoreState {
  app: {
    onboardingBusy: boolean;
    onboardingError: string | null;
  };
  auth: {
    busy: boolean;
    error: AuthError | null;
  };
}

let state: HarnessStoreState = {
  app: { onboardingBusy: false, onboardingError: null },
  auth: { busy: false, error: null },
};
const listeners = new Set<() => void>();

export function __setStoreState(next: HarnessStoreState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const calls: Array<{ store: string; action: string; args: unknown[] }> = [];

function record(store: string, action: string) {
  return async (...args: unknown[]) => {
    calls.push({ store, action, args });
    return action === "completePreAuthOnboarding" ? false : undefined;
  };
}

interface AppStoreView {
  onboardingBusy: boolean;
  onboardingError: string | null;
  completeOnboarding: (profile: unknown) => Promise<void>;
  completePreAuthOnboarding: (profile: unknown) => Promise<boolean>;
}

// Actions are created once: useSyncExternalStore requires selector results
// to be referentially stable while the store has not changed.
const appActions = {
  completeOnboarding: record("app", "completeOnboarding") as (profile: unknown) => Promise<void>,
  completePreAuthOnboarding: record("app", "completePreAuthOnboarding") as (
    profile: unknown,
  ) => Promise<boolean>,
};

function appView(): AppStoreView {
  return {
    onboardingBusy: state.app.onboardingBusy,
    onboardingError: state.app.onboardingError,
    ...appActions,
  };
}

export function useAppStore<T>(selector: (s: AppStoreView) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(appView()),
    () => selector(appView()),
  );
}

interface AuthStoreView {
  busy: boolean;
  error: AuthError | null;
  signInWithApple: () => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  clearError: () => void;
  signOut: () => Promise<void>;
}

const authActions = {
  signInWithApple: record("auth", "signInWithApple") as () => Promise<void>,
  signInWithGoogle: record("auth", "signInWithGoogle") as () => Promise<void>,
  clearError: () => {
    calls.push({ store: "auth", action: "clearError", args: [] });
    __setStoreState({ ...state, auth: { ...state.auth, error: null } });
  },
  signOut: record("auth", "signOut") as () => Promise<void>,
};

function authView(): AuthStoreView {
  return { busy: state.auth.busy, error: state.auth.error, ...authActions };
}

// Selector memoisation: `useAuthStore()` with no selector returns the whole
// view, so the snapshot must be referentially stable between store writes.
let authSnapshot = authView();
let authSnapshotState = state;
function authSnapshotFor(): AuthStoreView {
  if (authSnapshotState !== state) {
    authSnapshot = authView();
    authSnapshotState = state;
  }
  return authSnapshot;
}

export function useAuthStore(): AuthStoreView;
export function useAuthStore<T>(selector: (s: AuthStoreView) => T): T;
export function useAuthStore<T>(selector?: (s: AuthStoreView) => T): T | AuthStoreView {
  const pick = () => (selector ? selector(authSnapshotFor()) : authSnapshotFor());
  return useSyncExternalStore(subscribe, pick, pick);
}

export type NotificationOnboardingChoice = "enable" | "not_now";

interface NotificationStoreView {
  completeOnboardingStep: (choice: NotificationOnboardingChoice) => Promise<void>;
}

const notificationView: NotificationStoreView = {
  completeOnboardingStep: record("notifications", "completeOnboardingStep") as (
    choice: NotificationOnboardingChoice,
  ) => Promise<void>,
};

export function useNotificationStore<T>(selector: (s: NotificationStoreView) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(notificationView),
    () => selector(notificationView),
  );
}
