import React from 'react';
import { Dimensions, I18nManager, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationContainer,
  DefaultTheme,
  StackActions,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import type {
  MainTabParams,
  RootStackParams,
} from '../../../src/navigation/params';
import { SettingsScreen } from '../../../src/screens/SettingsScreen';
import { useAuthStore } from '../../../src/auth/authStore';
import { useAppStore } from '../../../src/state/appStore';
import { useConsentStore } from '../../../src/state/consentStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../../src/consistency/store';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../../src/state/accessStore';
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';
import type { CanonicalAccessState } from '../../../src/billing/types';
import type { SettingsFixture } from './settingsVariants';

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<MainTabParams>();

function Stub({ route }: { route: { name: string } }) {
  return (
    <View>
      <Text>{`stub:${route.name}`}</Text>
    </View>
  );
}

/** The app's MainTabs shape (RootNavigator.tsx) with the real Settings tab. */
function MainTabs() {
  return (
    <Tabs.Navigator
      initialRouteName="Settings"
      screenOptions={{ headerShown: false, tabBarHideOnKeyboard: true }}
    >
      <Tabs.Screen name="Home" component={Stub} />
      <Tabs.Screen name="Library" component={Stub} />
      <Tabs.Screen name="Add" component={Stub} />
      <Tabs.Screen name="Performance" component={Stub} />
      <Tabs.Screen name="Settings" component={SettingsScreen} />
    </Tabs.Navigator>
  );
}

export interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  navigationRef: ReturnType<
    typeof createNavigationContainerRef<RootStackParams>
  >;
  /** Composite instance of the real SettingsScreen (audit scope). */
  screen: () => TestRenderer.ReactTestInstance;
  currentRoute: () => { name: string; params?: object } | undefined;
  /** Pop every pushed stack route and land back on the Settings tab. */
  returnToSettings: () => Promise<void>;
  flush: () => Promise<void>;
  signOut: jest.Mock;
  refreshAccessCalls: () => number;
  consentFetchCalls: () => number;
  unmount: () => void;
}

export interface EnvironmentHandle {
  restore: () => void;
}

/** Device environment: window width, Dynamic Type scale, RTL flag, timezone. */
export function applyEnvironment(options: {
  width: number;
  fontScale: number;
  rtl: boolean;
  timeZone: string;
}): EnvironmentHandle {
  const previousWindow = Dimensions.get('window');
  const previousScreen = Dimensions.get('screen');
  const previousTz = process.env.TZ;
  const constants = I18nManager.getConstants();
  const previousRtl = constants.isRTL;
  const window = {
    width: options.width,
    height: Math.round(options.width * 2.16),
    scale: 3,
    fontScale: options.fontScale,
  };
  Dimensions.set({ window, screen: window });
  constants.isRTL = options.rtl;
  process.env.TZ = options.timeZone;
  return {
    restore: () => {
      Dimensions.set({ window: previousWindow, screen: previousScreen });
      constants.isRTL = previousRtl;
      if (previousTz === undefined) delete process.env.TZ;
      else process.env.TZ = previousTz;
    },
  };
}

function consentResponse(active: boolean): Response {
  const body = JSON.stringify({
    subjectPseudonym: 'stress-subject',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: '2026-01',
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Seeds every store the screen reads. Stores stay REAL: access goes through
 * `configureAccessStore` (the app's own dependency seam) so `refreshAccess`
 * runs its real path against a fake backend, and consent hydrates through
 * the real API client against a mocked `fetch`. Hostile numerics come back
 * from the fake backend already parsed, i.e. they bypass the wire parser
 * (see `SettingsFixture.accessInjectedRaw`).
 */
export function seedStores(fixture: SettingsFixture): {
  signOut: jest.Mock;
  refreshAccessCalls: () => number;
  consentFetchCalls: () => number;
  restore: () => void;
} {
  const signOut = jest.fn(() => Promise.resolve());
  let getAccessCalls = 0;
  let consentFetchCalls = 0;

  useAuthStore.setState({
    hydrated: true,
    session: fixture.session,
    busy: false,
    error: null,
    signOut,
  });
  useAppStore.setState({ hydrated: true, profile: fixture.profile });

  const synced = fixture.session !== null && !fixture.session.localOnly;
  if (synced && fixture.session && fixture.session.canonicalAppUserId) {
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'stress-bearer',
      canonicalAppUserId: fixture.session.canonicalAppUserId,
      provider: fixture.session.provider === 'apple' ? 'apple' : 'google',
    });
  } else {
    clearApiSession();
  }

  const previousFetch = globalThis.fetch;
  const consentCase = synced ? fixture.variant.consent : 'signed_out';
  globalThis.fetch = jest.fn((input: RequestInfo | URL) => {
    consentFetchCalls += 1;
    const url = String(input);
    if (!url.endsWith('/v1/me/consent/status')) {
      return Promise.reject(
        new Error(`unexpected fetch in stress harness: ${url}`),
      );
    }
    switch (consentCase) {
      case 'ready_on':
        return Promise.resolve(consentResponse(true));
      case 'ready_off':
        return Promise.resolve(consentResponse(false));
      case 'unavailable':
        return Promise.resolve(new Response('{}', { status: 503 }));
      case 'loading':
        return new Promise<Response>(() => undefined);
      case 'signed_out':
        return Promise.reject(new Error('consent fetch while signed out'));
    }
  }) as typeof fetch;
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });

  useNotificationStore.setState({
    prefs: fixture.notificationPrefs,
    permission: fixture.notificationPermission,
  });
  useConsistencyStore.setState({ snapshot: fixture.consistency });

  {
    const access = fixture.access;
    configureAccessStore({
      store: {
        configure: () => Promise.resolve(),
        loadPlans: () =>
          Promise.reject(new Error('not used by SettingsScreen')),
        purchase: () => Promise.reject(new Error('not used by SettingsScreen')),
        restore: () => Promise.reject(new Error('not used by SettingsScreen')),
        readEntitlement: () =>
          Promise.reject(new Error('not used by SettingsScreen')),
      },
      backend: {
        getAccess: (): Promise<CanonicalAccessState> => {
          getAccessCalls += 1;
          return access === null
            ? Promise.reject(new Error('access backend unavailable'))
            : Promise.resolve(access);
        },
        syncBilling: () =>
          Promise.reject(new Error('not used by SettingsScreen')),
      },
    });
    // A stale snapshot from a previous screen: the row must keep showing it
    // until the focus refresh lands, then show the fresh server value.
    useAccessStore.setState({ canonicalAccess: access, status: 'ready' });
  }
  useWalkthroughStore.setState({ visible: false, queued: false });

  return {
    signOut,
    refreshAccessCalls: () => getAccessCalls,
    consentFetchCalls: () => consentFetchCalls,
    restore: () => {
      globalThis.fetch = previousFetch;
      clearApiSession();
      clearAccessStoreConfiguration();
    },
  };
}

export async function renderSettings(
  fixture: SettingsFixture,
): Promise<Harness> {
  const seeded = seedStores(fixture);
  const navigationRef = createNavigationContainerRef<RootStackParams>();
  const queryClient = new QueryClient();
  let renderer!: TestRenderer.ReactTestRenderer;
  const initialMetrics = {
    frame: {
      x: 0,
      y: 0,
      width: fixture.variant.width,
      height: Math.round(fixture.variant.width * 2.16),
    },
    insets: { top: 59, left: 0, right: 0, bottom: 34 },
  };
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaProvider initialMetrics={initialMetrics}>
        <QueryClientProvider client={queryClient}>
          <NavigationContainer ref={navigationRef} theme={DefaultTheme}>
            <Stack.Navigator screenOptions={{ headerShown: false }}>
              <Stack.Screen name="Tabs" component={MainTabs} />
              <Stack.Screen name="Analyze" component={Stub} />
              <Stack.Screen name="Result" component={Stub} />
              <Stack.Screen name="ResultDetails" component={Stub} />
              <Stack.Screen name="FormReview" component={Stub} />
              <Stack.Screen name="DrillLibrary" component={Stub} />
              <Stack.Screen name="StreakCalendar" component={Stub} />
              <Stack.Screen name="ConnectAccount" component={Stub} />
              <Stack.Screen name="ManageAccount" component={Stub} />
              <Stack.Screen name="ConsentSettings" component={Stub} />
              <Stack.Screen name="NotificationSettings" component={Stub} />
              <Stack.Screen name="Paywall" component={Stub} />
            </Stack.Navigator>
          </NavigationContainer>
        </QueryClientProvider>
      </SafeAreaProvider>,
    );
  });
  const flush = async () => {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      });
    }
  };
  await flush();
  return {
    renderer,
    navigationRef,
    screen: () => renderer.root.findByType(SettingsScreen),
    currentRoute: () => navigationRef.getCurrentRoute(),
    returnToSettings: async () => {
      await act(async () => {
        if (navigationRef.canGoBack())
          navigationRef.dispatch(StackActions.popToTop());
        navigationRef.navigate('Tabs', { screen: 'Settings' });
      });
      await flush();
    },
    flush,
    signOut: seeded.signOut,
    refreshAccessCalls: seeded.refreshAccessCalls,
    consentFetchCalls: seeded.consentFetchCalls,
    unmount: () => {
      act(() => renderer.unmount());
      queryClient.clear();
      seeded.restore();
    },
  };
}
