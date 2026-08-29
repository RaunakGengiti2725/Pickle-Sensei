import React, { useCallback, useEffect, useState } from 'react';
import { AppState, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SplashScreen } from './src/screens/SplashScreen';
import { color } from './src/design/tokens';
import { useAppStore } from './src/state/appStore';
import { useAuthStore } from './src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
} from './src/data/accountScope';
import {
  UNASSIGNED_STABILITY_USER_KEY,
  stabilitySlo,
} from './src/analysis/stabilityTelemetry';
import { makeUuid } from './src/util/uuid';

const queryClient = new QueryClient();

// One stability session per app run (stability-slo-v1). Started once at
// module load so the session exists before any screen can fail; a
// background transition is the observable clean end of the run.
const stabilitySessionKey = makeUuid();
stabilitySlo.setContext({
  userKey: UNASSIGNED_STABILITY_USER_KEY,
  sessionKey: stabilitySessionKey,
});
stabilitySlo.record({ kind: 'session_started' });

/** Launch → account (Apple/Google/guest) → onboarding → app (spec p. 5). */
function Gate() {
  const appHydrated = useAppStore(s => s.hydrated);
  const appOwnerKey = useAppStore(s => s.ownerKey);
  const profile = useAppStore(s => s.profile);
  const hydrateApp = useAppStore(s => s.hydrate);
  const authHydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);
  const hydrateAuth = useAuthStore(s => s.hydrate);
  const [showSignIn, setShowSignIn] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashFinished = useCallback(() => setSplashDone(true), []);

  useEffect(() => {
    void hydrateAuth();
  }, [hydrateAuth]);

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

  // Stamp stability events with the pseudonymous data-owner key (never an
  // email or device id) once it is known; the session key stays the run's.
  useEffect(() => {
    if (!desiredOwner) return;
    stabilitySlo.setContext({
      userKey: desiredOwner,
      sessionKey: stabilitySessionKey,
    });
  }, [desiredOwner]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (nextState === 'background') {
        stabilitySlo.record({ kind: 'session_ended_clean' });
      }
    });
    return () => subscription.remove();
  }, []);

  const ready =
    authHydrated &&
    Boolean(desiredOwner) &&
    appHydrated &&
    appOwnerKey === desiredOwner;

  // Rendered under the splash so the first screen is already painted by the
  // time the overlay clears — the handoff is a fade, not a swap.
  const content = !ready ? null : !session ? (
    showSignIn ? (
      <SignInScreen onBack={() => setShowSignIn(false)} />
    ) : (
      <WelcomeScreen onGetStarted={() => setShowSignIn(true)} />
    )
  ) : !profile ? (
    <OnboardingScreen />
  ) : (
    <RootNavigator />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surfaceDark }}>
      {content}
      {splashDone ? null : (
        <SplashScreen ready={ready} onFinished={handleSplashFinished} />
      )}
    </View>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <StatusBar barStyle="dark-content" />
        <Gate />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
