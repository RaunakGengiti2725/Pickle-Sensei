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
import { useNotificationBootstrap } from './src/notifications/useNotificationBootstrap';
import { useConsistencyBootstrap } from './src/consistency/useConsistencyBootstrap';
import { RankUpCelebration } from './src/components/RankUpCelebration';
import { StreakCelebration } from './src/consistency/StreakCelebration';
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  type PreAuthStage,
} from './src/flow/launchGate';
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

/**
 * Launch → onboarding (device-once, pre-auth) → account (Apple/Google)
 * → app. The questionnaire runs BEFORE the login flow; its answers wait in
 * the appStore pre-auth stash and are adopted by the owner that signs in
 * (launchGate.ts pins the ordering). Signed-in accounts that still lack a
 * profile — e.g. an existing account on a new device whose pre-auth answers
 * were superseded or could not sync — fall back to the in-account
 * OnboardingScreen exactly as before.
 */
function Gate() {
  const appHydrated = useAppStore(s => s.hydrated);
  const appOwnerKey = useAppStore(s => s.ownerKey);
  const profile = useAppStore(s => s.profile);
  const preAuthOnboarded = useAppStore(s => s.preAuthOnboarded);
  const hydrateApp = useAppStore(s => s.hydrate);
  const authHydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);
  const hydrateAuth = useAuthStore(s => s.hydrate);
  const [preAuthStage, setPreAuthStage] = useState<PreAuthStage>('welcome');
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

  // Owner-scoped reminder schedule: hydrates per account, cancels everything
  // for a signed-out process, re-syncs on each return to the foreground.
  useNotificationBootstrap(desiredOwner);

  // Owner-scoped consistency state (streak, momentum, milestones): hydrates
  // per account and re-derives on every foreground so the flame stays honest.
  useConsistencyBootstrap(desiredOwner);

  const ready =
    authHydrated &&
    Boolean(desiredOwner) &&
    appHydrated &&
    appOwnerKey === desiredOwner;

  // Rendered under the splash so the first screen is already painted by the
  // time the overlay clears — the handoff is a fade, not a swap.
  const content = !ready ? null : !session ? (
    preAuthStage === 'signin' ? (
      <SignInScreen onBack={() => setPreAuthStage('welcome')} />
    ) : preAuthStage === 'onboarding' ? (
      <OnboardingScreen
        mode="preauth"
        onFinished={() => setPreAuthStage(stageAfterOnboarding())}
        onExitToSignIn={() => setPreAuthStage(stageAfterOnboarding())}
      />
    ) : (
      <WelcomeScreen
        onGetStarted={() =>
          setPreAuthStage(stageAfterGetStarted(preAuthOnboarded))
        }
        onSignIn={() => setPreAuthStage('signin')}
      />
    )
  ) : !profile ? (
    <OnboardingScreen />
  ) : (
    <RootNavigator />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surfaceDark }}>
      {content}
      {/* Global rank-up overlay: any screen that resolves a higher tier
          raises it through the celebration store. */}
      <RankUpCelebration />
      {/* Global streak-milestone overlay: the consistency store raises one
          durable ceremony per earned milestone. */}
      <StreakCelebration />
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
