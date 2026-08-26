import React, { useEffect } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { LoadingState } from './src/design/components';
import { useAppStore } from './src/state/appStore';

const queryClient = new QueryClient();

function Gate() {
  const hydrated = useAppStore(s => s.hydrated);
  const profile = useAppStore(s => s.profile);
  const hydrate = useAppStore(s => s.hydrate);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) return <LoadingState label="Starting up…" />;
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
