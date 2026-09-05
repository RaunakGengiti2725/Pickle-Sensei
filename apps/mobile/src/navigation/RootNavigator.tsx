import React, { useCallback, useEffect, useRef } from 'react';
import { Linking, View } from 'react-native';
import {
  NavigationContainer,
  DefaultTheme,
  createNavigationContainerRef,
} from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, space } from '../design/tokens';
import type { MainTabParams, RootStackParams } from './params';
import { HomeScreen } from '../screens/HomeScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { ProgressScreen } from '../screens/ProgressScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { AnalyzeScreen } from '../screens/AnalyzeScreen';
import { DrillLibraryScreen } from '../screens/DrillLibraryScreen';
import { ResultScreen } from '../screens/ResultScreen';
import { ResultDetailsScreen } from '../screens/ResultDetailsScreen';
import { FormReviewScreen } from '../screens/FormReviewScreen';
import { StreakCalendarScreen } from '../screens/StreakCalendarScreen';
import { PaywallScreen } from '../screens/PaywallScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { ManageAccountScreen } from '../screens/ManageAccountScreen';
import { ConsentSettingsScreen } from '../screens/ConsentSettingsScreen';
import { NotificationSettingsScreen } from '../screens/NotificationSettingsScreen';
import { PremiumTabBar } from './PremiumTabBar';
import { Button, ErrorState, LoadingState } from '../design/components';
import { useAccessStore } from '../state/accessStore';
import { useAuthStore } from '../auth/authStore';
import { getActiveDataOwner } from '../data/accountScope';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { showBrandNotice } from '../design/BrandNotice';

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function MainTabs() {
  return (
    <Tabs.Navigator
      tabBar={props => <PremiumTabBar {...props} />}
      screenOptions={{
        headerShown: false,
        tabBarHideOnKeyboard: true,
      }}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="Library" component={LibraryScreen} />
      <Tabs.Screen name="Add" component={CoachActionPortal} />
      <Tabs.Screen name="Performance" component={ProgressScreen} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

function CoachActionPortal() {
  return <View />;
}

async function openLegalPage(label: string, url: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    showBrandNotice({
      title: `${label} could not be opened`,
      detail: `Your phone could not open the page. You can read it in a browser at ${url}`,
      tone: 'danger',
      eyebrow: 'LINK UNAVAILABLE',
    });
  }
}

function PaywallRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Paywall'>) {
  // Subscription paywalls must link to functional Terms of Use and Privacy
  // Policy pages (App Review 3.1.2). Served by the API function (legal.ts).
  const { legalTermsUrl, legalPrivacyUrl } = getRuntimePublicConfig();
  return (
    <PaywallScreen
      onClose={() => navigation.goBack()}
      onPurchased={() => navigation.goBack()}
      {...(legalTermsUrl
        ? {
            onOpenTerms: () =>
              void openLegalPage('Terms of use', legalTermsUrl),
          }
        : {})}
      {...(legalPrivacyUrl
        ? {
            onOpenPrivacy: () =>
              void openLegalPage('Privacy policy', legalPrivacyUrl),
          }
        : {})}
    />
  );
}

function ConnectAccountRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'ConnectAccount'>) {
  const provider = useAuthStore(state => state.session?.provider);

  useEffect(() => {
    if (provider && provider !== 'guest') navigation.goBack();
  }, [navigation, provider]);

  return <SignInScreen onBack={() => navigation.goBack()} />;
}

function useRatingRouteGate<RouteName extends keyof RootStackParams>(
  navigation: NativeStackNavigationProp<RootStackParams, RouteName>,
  source: 'rating',
) {
  const status = useAccessStore(state => state.status);
  const operation = useAccessStore(state => state.operation);
  const canonicalAccess = useAccessStore(state => state.canonicalAccess);
  const error = useAccessStore(state => state.error);
  const initialize = useAccessStore(state => state.initialize);
  const session = useAuthStore(state => state.session);
  const localOnly = !session || session.localOnly;
  const owner = getActiveDataOwner();
  const startedFor = useRef({ owner, session });
  const active = useRef(true);
  const exited = useRef(false);
  const sameSession =
    startedFor.current.owner === owner &&
    startedFor.current.session === session;
  const pending = status === 'idle' || status === 'loading';
  const requiresPaywall =
    canonicalAccess?.canStartRating === false &&
    canonicalAccess.paywallRequired;

  const isCurrent = useCallback(
    () =>
      active.current &&
      !exited.current &&
      startedFor.current.owner === getActiveDataOwner() &&
      startedFor.current.session === useAuthStore.getState().session,
    [],
  );

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (!isCurrent()) return;
    if (localOnly) {
      exited.current = true;
      navigation.replace('ConnectAccount');
      return;
    }
    if (status === 'idle') {
      if (operation === 'idle') void initialize();
      return;
    }
    if (status !== 'loading' && requiresPaywall) {
      exited.current = true;
      navigation.replace('Paywall', { source });
    }
  }, [
    initialize,
    isCurrent,
    localOnly,
    navigation,
    operation,
    requiresPaywall,
    source,
    status,
    session,
  ]);

  const retry = useCallback(() => {
    if (!isCurrent() || localOnly) return;
    const access = useAccessStore.getState();
    if (access.status === 'loading' || access.operation !== 'idle') return;
    void access.refreshAccess();
  }, [isCurrent, localOnly]);

  const cancel = useCallback(() => {
    if (!active.current || exited.current) return;
    exited.current = true;
    navigation.goBack();
  }, [navigation]);

  return {
    allowed:
      sameSession &&
      active.current &&
      !exited.current &&
      !localOnly &&
      !pending &&
      canonicalAccess?.canStartRating === true,
    checking:
      sameSession &&
      (!active.current ||
        exited.current ||
        localOnly ||
        pending ||
        requiresPaywall),
    detail: !sameSession
      ? 'Your account changed. Go back and start a new rating.'
      : (error?.message ??
        'Your rating access could not be verified. Check your connection and try again. No rating has started.'),
    retry: sameSession && operation === 'idle' ? retry : undefined,
    cancel,
  };
}

function AnalyzeRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  const gate = useRatingRouteGate(navigation, 'rating');
  if (gate.allowed) return <AnalyzeScreen />;
  return (
    <SafeAreaView
      edges={['bottom']}
      style={{ flex: 1, backgroundColor: color.surface }}
    >
      {gate.checking ? (
        <LoadingState label="Checking access…" />
      ) : (
        <ErrorState
          title="Rating access couldn’t be checked"
          detail={gate.detail}
          {...(gate.retry ? { onRetry: gate.retry } : {})}
          retryLabel="Retry access check"
        />
      )}
      <View style={{ padding: space.lg }}>
        <Button label="Cancel" variant="secondary" onPress={gate.cancel} />
      </View>
    </SafeAreaView>
  );
}

const theme = {
  ...DefaultTheme,
  colors: {
    ...DefaultTheme.colors,
    background: color.surface,
    primary: color.court,
  },
};

const navigationRef = createNavigationContainerRef<RootStackParams>();

/** Routes a pressed reminder to its declared tab once navigation is live. */
function useNotificationPressRouting() {
  useEffect(() => {
    // Lazy require keeps the notification native module out of module
    // evaluation (and out of any environment that merely imports this file).
    const { subscribeToNotificationPresses } =
      require('../notifications/service') as typeof import('../notifications/service');
    const unsubscribe = subscribeToNotificationPresses(target => {
      if (!navigationRef.isReady()) return;
      navigationRef.navigate('Tabs', {
        screen: target === 'Performance' ? 'Performance' : 'Home',
      });
    });
    return unsubscribe;
  }, []);
}

export function RootNavigator() {
  useNotificationPressRouting();
  return (
    <NavigationContainer ref={navigationRef} theme={theme}>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: 'fade_from_bottom',
          contentStyle: { backgroundColor: color.surface },
        }}
      >
        <Stack.Screen
          name="Tabs"
          component={MainTabs}
          options={{ headerShown: false, animation: 'none' }}
        />
        <Stack.Screen
          name="Analyze"
          component={AnalyzeRoute}
          options={{ title: 'Analyze Shot' }}
        />
        <Stack.Screen
          name="Result"
          component={ResultScreen}
          options={{
            title: 'Result',
            contentStyle: { backgroundColor: color.surfaceDark },
          }}
        />
        <Stack.Screen
          name="ResultDetails"
          component={ResultDetailsScreen}
          options={{
            title: 'Full breakdown',
            // Light sheet (the evidence cards' own surface) — the default
            // screen contentStyle already matches, stated here on purpose.
            contentStyle: { backgroundColor: color.surface },
          }}
        />
        <Stack.Screen
          name="FormReview"
          component={FormReviewScreen}
          options={{
            title: 'Form review',
            contentStyle: { backgroundColor: color.surfaceDark },
          }}
        />
        <Stack.Screen
          name="DrillLibrary"
          component={DrillLibraryScreen}
          options={{ title: 'Drill Library' }}
        />
        <Stack.Screen
          name="StreakCalendar"
          component={StreakCalendarScreen}
          options={{ title: 'Consistency' }}
        />
        <Stack.Screen
          name="Paywall"
          component={PaywallRoute}
          options={{
            animation: 'slide_from_bottom',
            presentation: 'fullScreenModal',
          }}
        />
        <Stack.Screen
          name="ManageAccount"
          component={ManageAccountScreen}
          options={{ title: 'Manage Account' }}
        />
        <Stack.Screen
          name="ConsentSettings"
          component={ConsentSettingsScreen}
          options={{ title: 'Data & Consent' }}
        />
        <Stack.Screen
          name="NotificationSettings"
          component={NotificationSettingsScreen}
          options={{ title: 'Notifications' }}
        />
        <Stack.Screen
          name="ConnectAccount"
          component={ConnectAccountRoute}
          options={{
            animation: 'slide_from_bottom',
            presentation: 'fullScreenModal',
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
