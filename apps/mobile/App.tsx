import React, { useEffect, useState } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { LoadingState } from './src/design/components';
import { useAppStore } from './src/state/appStore';
import { useAuthStore } from './src/auth/authStore';

const queryClient = new QueryClient();

/** Launch → account (Apple/Google/guest) → onboarding → app (spec p. 5). */
function Gate() {
  const appHydrated = useAppStore(s => s.hydrated);
  const profile = useAppStore(s => s.profile);
  const hydrateApp = useAppStore(s => s.hydrate);
  const authHydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);
  const hydrateAuth = useAuthStore(s => s.hydrate);
  const [showSignIn, setShowSignIn] = useState(false);

  useEffect(() => {
    void hydrateApp();
    void hydrateAuth();
  }, [hydrateApp, hydrateAuth]);

  if (!appHydrated || !authHydrated)
    return <LoadingState label="Starting up…" />;
  if (!session) {
    return showSignIn ? (
      <SignInScreen onBack={() => setShowSignIn(false)} />
    ) : (
      <WelcomeScreen onGetStarted={() => setShowSignIn(true)} />
    );
  }
  if (!profile) return <OnboardingScreen />;
  return <RootNavigator />;
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
