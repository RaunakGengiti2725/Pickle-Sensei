import React, { useEffect } from 'react';
import { StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from '../../../src/navigation/RootNavigator';
import { ErrorState, LoadingState } from '../../../src/design/components';
import { color } from '../../../src/design/tokens';
import { useAppStore } from '../../../src/state/appStore';
import { useAuthStore } from '../../../src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
} from '../../../src/data/accountScope';
import { useConsistencyBootstrap } from '../../../src/consistency/useConsistencyBootstrap';
import { StreakCelebration } from '../../../src/consistency/StreakCelebration';

/**
 * The App.tsx composition the shipping app mounts around RootNavigator,
 * reproduced statement-for-statement for the parts that own the consistency
 * lifecycle: the auth→owner derivation, the appStore hydrate + `ready` gate
 * that unmounts the navigator while an owner change re-hydrates, the
 * consistency bootstrap (hydrate per owner + AppState foreground refresh),
 * the global StreakCelebration overlay and the root error boundary.
 *
 * Deliberately NOT reproduced (outside this unit, all need native mocks of
 * their own): SplashScreen, Welcome/Onboarding/SignIn pre-auth screens, the
 * notification bootstrap, the first-run walkthrough, stability telemetry.
 *
 * This module is meant to be `require`d inside `jest.isolateModules` so a
 * kill/relaunch step gets a genuinely fresh process: fresh zustand stores,
 * fresh module-level refresh queue, fresh navigation container ref.
 */
const queryClient = new QueryClient();

export interface BoundaryHooks {
  onCaught: (error: unknown) => void;
}

export class HarnessErrorBoundary extends React.Component<
  { children: React.ReactNode; hooks: BoundaryHooks },
  { caught: boolean }
> {
  state = { caught: false };

  static getDerivedStateFromError() {
    return { caught: true };
  }

  componentDidCatch(error: unknown) {
    this.props.hooks.onCaught(error);
  }

  private readonly retry = () => this.setState({ caught: false });

  render() {
    if (this.state.caught) {
      return (
        <ErrorState
          dark
          title="Something went wrong"
          detail="Pickle Sensei hit an unexpected problem on this screen. Try again to reload it."
          onRetry={this.retry}
        />
      );
    }
    return this.props.children;
  }
}

function Gate() {
  const appHydrated = useAppStore(s => s.hydrated);
  const appOwnerKey = useAppStore(s => s.ownerKey);
  const profile = useAppStore(s => s.profile);
  const hydrateError = useAppStore(s => s.hydrateError);
  const hydrateApp = useAppStore(s => s.hydrate);
  const authHydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);

  const desiredOwner = !authHydrated
    ? null
    : session?.provider === 'guest'
      ? GUEST_DATA_OWNER
      : session?.canonicalAppUserId
        ? canonicalDataOwner(session.canonicalAppUserId)
        : SIGNED_OUT_DATA_OWNER;

  useEffect(() => {
    if (!desiredOwner) return;
    void hydrateApp();
  }, [desiredOwner, hydrateApp]);

  useConsistencyBootstrap(desiredOwner);

  const ready =
    authHydrated &&
    Boolean(desiredOwner) &&
    appHydrated &&
    appOwnerKey === desiredOwner;

  const content = !ready ? (
    <LoadingState
      dark
      label={session ? 'Loading your account' : 'Getting things ready'}
    />
  ) : !session ? (
    <Text testID="stress-welcome">Welcome (signed out)</Text>
  ) : !profile && hydrateError ? (
    <ErrorState
      dark
      title="Your coaching profile couldn’t load"
      detail={hydrateError}
      onRetry={() => void hydrateApp()}
    />
  ) : !profile ? (
    <Text testID="stress-onboarding">Onboarding (no profile)</Text>
  ) : (
    <RootNavigator />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surfaceDark }}>
      {content}
      <StreakCelebration />
    </View>
  );
}

export function StressApp(props: { hooks: BoundaryHooks }) {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar barStyle="dark-content" />
        <HarnessErrorBoundary hooks={props.hooks}>
          <Gate />
        </HarnessErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
