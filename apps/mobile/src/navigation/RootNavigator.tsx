import React, { useEffect } from 'react';
import { View } from 'react-native';
import { NavigationContainer, DefaultTheme } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
  type NativeStackScreenProps,
} from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { color } from '../design/tokens';
import type { MainTabParams, RootStackParams } from './params';
import { HomeScreen } from '../screens/HomeScreen';
import { LibraryScreen } from '../screens/LibraryScreen';
import { ProgressScreen } from '../screens/ProgressScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { AnalyzeScreen } from '../screens/AnalyzeScreen';
import { ResultScreen } from '../screens/ResultScreen';
import { LiveCourtScreen } from '../screens/LiveCourtScreen';
import { LiveSummaryScreen } from '../screens/LiveSummaryScreen';
import { PaywallScreen } from '../screens/PaywallScreen';
import { SignInScreen } from '../screens/SignInScreen';
import { ConsentSettingsScreen } from '../screens/ConsentSettingsScreen';
import { PremiumTabBar } from './PremiumTabBar';
import { LoadingState } from '../design/components';
import { useAccessStore } from '../state/accessStore';
import { useAuthStore } from '../auth/authStore';

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

function PaywallRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Paywall'>) {
  return (
    <PaywallScreen
      onClose={() => navigation.goBack()}
      onPurchased={() => navigation.goBack()}
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

  return <SignInScreen allowGuest={false} onBack={() => navigation.goBack()} />;
}

function useRatingRouteGate<RouteName extends keyof RootStackParams>(
  navigation: NativeStackNavigationProp<RootStackParams, RouteName>,
  source: 'rating' | 'live_court',
) {
  const status = useAccessStore(state => state.status);
  const canonicalAccess = useAccessStore(state => state.canonicalAccess);
  const initialize = useAccessStore(state => state.initialize);
  const localOnly = useAuthStore(state => state.session?.localOnly === true);

  useEffect(() => {
    if (localOnly) {
      navigation.replace('ConnectAccount');
      return;
    }
    if (canonicalAccess?.canStartRating) return;
    if (status === 'idle') {
      void initialize();
      return;
    }
    if (
      canonicalAccess !== null ||
      status === 'ready' ||
      status === 'unconfigured' ||
      status === 'error'
    ) {
      navigation.replace('Paywall', { source });
    }
  }, [canonicalAccess, initialize, localOnly, navigation, source, status]);

  return canonicalAccess?.canStartRating === true;
}

function AnalyzeRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  const allowed = useRatingRouteGate(navigation, 'rating');
  return allowed ? (
    <AnalyzeScreen />
  ) : (
    <LoadingState label="Checking access…" />
  );
}

function LiveCourtRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'LiveCourt'>) {
  const allowed = useRatingRouteGate(navigation, 'live_court');
  return allowed ? (
    <LiveCourtScreen />
  ) : (
    <LoadingState label="Checking access…" />
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

export function RootNavigator() {
  return (
    <NavigationContainer theme={theme}>
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
          options={{ title: 'Result' }}
        />
        <Stack.Screen
          name="LiveCourt"
          component={LiveCourtRoute}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="LiveSummary"
          component={LiveSummaryScreen}
          options={{ title: 'Summary', headerBackVisible: false }}
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
          name="ConsentSettings"
          component={ConsentSettingsScreen}
          options={{ title: 'Data & Consent' }}
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
