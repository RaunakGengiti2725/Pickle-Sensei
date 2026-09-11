import React, {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { Linking, Text, View } from 'react-native';
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
import { color, space, type } from '../design/tokens';
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
import { Button, LoadingState, ScreenHeader } from '../design/components';
import { useAccessStore } from '../state/accessStore';
import { useAuthStore } from '../auth/authStore';
import { getRuntimePublicConfig } from '../config/runtimeConfig';
import { showBrandNotice } from '../design/BrandNotice';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  getDataOwnerSnapshot,
  isDataOwnerContextCurrent,
  subscribeToDataOwner,
} from '../data/accountScope';
import { getApiSession, useApiSessionStore } from '../account/apiSession';
import { getDb } from '../data/db';
import {
  isSavedCaptureId,
  loadSavedTechniqueConfirmation,
  type SavedTechniqueConfirmationLoad,
} from '../analysis/savedTechniqueConfirmation';
import { runJournal } from '../analysis/runJournal';
import {
  loadSavedOriginalAnalysis,
  type SavedOriginalAnalysisEntry,
} from '../analysis/originalAnalysisOperations';
import { clearTryAgainHandoff } from '../screens/tryAgainHandoff';
import { CaptureEvidenceCard } from '../camera/CaptureEvidenceCard';

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

function NewAnalyzeRoute({
  navigation,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  const allowed = useRatingRouteGate(navigation, 'rating');
  return allowed ? (
    <AnalyzeScreen />
  ) : (
    <LoadingState label="Checking access…" />
  );
}

const SAVED_CONFIRMATION_COPY = {
  missing: 'This saved capture could not be found in the current account.',
  legacy:
    'This older capture has no complete immutable confirmation proof. The saved clip has been retained, but it cannot be continued from guessed settings.',
  corrupt:
    'The saved analysis could not be verified. The clip is retained and no new rating was started.',
  evidence_changed:
    'The saved video, pose evidence, or original selection has changed or is missing. Nothing will be reconstructed or rated from it.',
  origin_mismatch:
    'This capture belongs to a different rating-service address. Reconnect its original service before continuing.',
  account_changed:
    'The account changed. Reopen the saved capture from the current account’s library.',
  superseded:
    'A newer analysis has replaced this confirmation. Reopen the saved capture to view its current state.',
  cancelled:
    'Opening this saved capture was cancelled. It remains in your library.',
} as const;
const SAVED_ORIGINAL_COPY = {
  ...SAVED_CONFIRMATION_COPY,
  legacy:
    'This clip has no complete original-analysis record. Keep it in Library or capture another stroke; the app cannot recover its original settings.',
  superseded:
    'The saved analysis changed while you opened it. Reload the capture to check its current state.',
};
type SavedAnalysisLoad =
  | SavedTechniqueConfirmationLoad
  | { kind: 'original_ready'; saved: SavedOriginalAnalysisEntry };

function SavedAnalyzeRoute({
  navigation,
  route,
}: NativeStackScreenProps<RootStackParams, 'Analyze'>) {
  const owner = useSyncExternalStore(
    subscribeToDataOwner,
    getDataOwnerSnapshot,
    getDataOwnerSnapshot,
  );
  const apiBaseUrl =
    useApiSessionStore(state => state.session?.apiBaseUrl) ??
    getRuntimePublicConfig().apiBaseUrl ??
    '';
  const sessionOwner = useApiSessionStore(
    state => state.session?.canonicalAppUserId,
  );
  const captureId = route.params?.captureId;
  const originalMode = Object.prototype.hasOwnProperty.call(
    route.params ?? {},
    'mode',
  );
  const validParams =
    isSavedCaptureId(captureId) &&
    route.params?.source === undefined &&
    (!originalMode || route.params?.mode === 'original') &&
    Object.keys(route.params ?? {}).every(
      param => param === 'captureId' || param === 'source' || param === 'mode',
    );
  let apiOrigin = '';
  try {
    apiOrigin = runJournal.scope({
      ownerKey: owner.ownerKey,
      apiOrigin: apiBaseUrl,
    }).apiOrigin;
  } catch {
    // An invalid saved binding remains unavailable; it never opens a new capture.
  }
  const [revision, setRevision] = useState(0);
  const key = JSON.stringify([
    route.key,
    typeof captureId === 'string' ? captureId : null,
    originalMode,
    route.params?.mode,
    validParams,
    owner.ownerKey,
    owner.generation,
    apiOrigin,
    sessionOwner,
    revision,
  ]);
  const boundary = useRef<{
    key: string;
    closed: boolean;
    controller?: AbortController;
  }>({ key, closed: false });
  if (boundary.current.key !== key) {
    boundary.current.closed = true;
    boundary.current = { key, closed: false };
  }
  const bound = boundary.current;
  const [loaded, setLoaded] = useState<{
    bound: typeof bound;
    result: SavedAnalysisLoad;
  } | null>(null);
  const serviceCurrent = () => {
    const session = getApiSession();
    if (session?.canonicalAppUserId !== sessionOwner) return false;
    if (!apiOrigin) return true; // Invalid saved bindings still have a safe Close action.
    try {
      return (
        runJournal.scope({
          ownerKey: owner.ownerKey,
          apiOrigin:
            session?.apiBaseUrl ?? getRuntimePublicConfig().apiBaseUrl ?? '',
        }).apiOrigin === apiOrigin
      );
    } catch {
      return false;
    }
  };
  const routeCurrent = () =>
    boundary.current === bound &&
    !bound.closed &&
    getDataOwnerSnapshot() === owner &&
    navigation.isFocused?.() !== false &&
    serviceCurrent();
  const isCurrent = () => {
    if (
      !routeCurrent() ||
      !validParams ||
      !isDataOwnerContextCurrent(owner) ||
      !apiOrigin ||
      bound.controller?.signal.aborted
    )
      return false;
    const session = getApiSession();
    if (session && session.canonicalAppUserId !== owner.ownerKey) return false;
    try {
      return (
        runJournal.scope({
          ownerKey: owner.ownerKey,
          apiOrigin:
            session?.apiBaseUrl ?? getRuntimePublicConfig().apiBaseUrl ?? '',
        }).apiOrigin === apiOrigin
      );
    } catch {
      return false;
    }
  };
  useEffect(() => {
    clearTryAgainHandoff();
    const blur = navigation.addListener?.('blur', () => {
      boundary.current.closed = true;
      boundary.current.controller?.abort();
      setRevision(value => value + 1);
    });
    const focus = navigation.addListener?.('focus', () =>
      setRevision(value => value + 1),
    );
    return () => {
      blur?.();
      focus?.();
    };
  }, [navigation]);
  useEffect(() => {
    const controller = new AbortController();
    bound.controller = controller;
    const unsubscribe = useApiSessionStore.subscribe(() => {
      if (boundary.current !== bound || bound.closed || serviceCurrent())
        return;
      // Invalidate synchronously, including service A→B→A before React has
      // rendered. Ordinary bearer rotation keeps the same owner/service.
      bound.closed = true;
      controller.abort();
      setRevision(value => value + 1);
    });
    if (isCurrent() && isSavedCaptureId(captureId)) {
      void Promise.resolve()
        .then(async (): Promise<SavedAnalysisLoad> => {
          const request = {
            db: getDb(),
            ownerContext: owner,
            captureId,
            apiOrigin,
            signal: controller.signal,
            assertCurrent: () => {
              if (!isCurrent()) throw new Error('Saved capture route changed.');
            },
          };
          if (originalMode) {
            const original = await loadSavedOriginalAnalysis(request);
            request.assertCurrent();
            if (original.kind === 'ready')
              return { kind: 'original_ready', saved: original.saved };
            if (original.kind !== 'load_result') return original;
          }
          return loadSavedTechniqueConfirmation(request);
        })
        .then(
          result => {
            if (isCurrent()) setLoaded({ bound, result });
          },
          () => {
            if (isCurrent())
              setLoaded({
                bound,
                result: { kind: 'unavailable', reason: 'corrupt' },
              });
          },
        );
    }
    return () => {
      unsubscribe();
      bound.closed = true;
      controller.abort();
    };
  }, [bound]);
  const close = () => {
    if (!routeCurrent()) return;
    bound.closed = true;
    bound.controller?.abort();
    navigation.goBack();
  };
  const result = loaded?.bound === bound && isCurrent() ? loaded.result : null;
  if (result?.kind === 'original_ready') {
    return (
      <AnalyzeScreen
        key={`${key}:${result.saved.reference.operationId}`}
        savedOriginalAnalysis={result.saved}
        isSavedConfirmationCurrent={isCurrent}
        savedConfirmationSignal={bound.controller?.signal}
      />
    );
  }
  if (
    result &&
    (result.kind === 'ready' ||
      result.kind === 'release_pending' ||
      result.kind === 'recovery_blocked')
  ) {
    return (
      <AnalyzeScreen
        key={`${key}:${result.saved.record.id}`}
        savedTechniqueConfirmation={result.saved}
        savedConfirmationStatus={result.kind}
        isSavedConfirmationCurrent={isCurrent}
        savedConfirmationSignal={bound.controller?.signal}
      />
    );
  }
  const unavailableReason = !validParams
    ? 'missing'
    : !isDataOwnerContextCurrent(owner)
      ? 'account_changed'
      : !apiOrigin ||
          (sessionOwner !== undefined && sessionOwner !== owner.ownerKey)
        ? 'origin_mismatch'
        : result?.kind === 'unavailable'
          ? result.reason
          : null;
  return (
    <SafeAreaView
      edges={['top', 'bottom']}
      style={{ flex: 1, backgroundColor: color.surface }}
    >
      <ScreenHeader title="Saved capture" onClose={close} />
      <View style={{ padding: space.xl, gap: space.lg }}>
        {result?.kind === 'already_completed' ? (
          <>
            <Text style={[type.h1, { color: color.ink }]}>
              This capture already has a result.
            </Text>
            <Text style={[type.body, { color: color.inkSoft }]}>
              Opening it does not start another rating.
            </Text>
            <Button
              label="Open saved result"
              variant="dark"
              onPress={() => {
                if (isCurrent())
                  navigation.replace('Result', {
                    analysisId: result.analysisId,
                  });
              }}
            />
          </>
        ) : unavailableReason ? (
          <>
            <Text style={[type.h1, { color: color.ink }]}>
              Your clip stays saved.
            </Text>
            <Text
              accessibilityRole="alert"
              style={[type.body, { color: color.inkSoft }]}
            >
              {
                (originalMode ? SAVED_ORIGINAL_COPY : SAVED_CONFIRMATION_COPY)[
                  unavailableReason
                ]
              }
            </Text>
            {result?.kind === 'unavailable' && result.clip ? (
              <CaptureEvidenceCard clip={result.clip} />
            ) : null}
            {validParams ? (
              <Button
                label="Reload saved capture"
                variant="dark"
                onPress={() => {
                  if (routeCurrent()) setRevision(value => value + 1);
                }}
              />
            ) : null}
          </>
        ) : (
          <LoadingState label="Opening saved capture…" />
        )}
        <Button label="Close" variant="ghost" onPress={close} />
      </View>
    </SafeAreaView>
  );
}

export function AnalyzeRoute(
  props: NativeStackScreenProps<RootStackParams, 'Analyze'>,
) {
  const params = props.route.params;
  const objectParams =
    typeof params === 'object' && params !== null && !Array.isArray(params);
  const saved =
    objectParams && Object.prototype.hasOwnProperty.call(params, 'captureId');
  const validNew =
    params === undefined ||
    (objectParams &&
      !saved &&
      Object.keys(params).every(param => param === 'source') &&
      (params.source === undefined ||
        params.source === 'camera' ||
        params.source === 'library'));
  return saved || !validNew ? (
    <SavedAnalyzeRoute {...props} />
  ) : (
    <NewAnalyzeRoute
      key={`${props.route.key}:${params?.source ?? 'camera'}`}
      {...props}
    />
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
