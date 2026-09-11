import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AppState,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RootNavigator } from './src/navigation/RootNavigator';
import { OnboardingScreen } from './src/screens/OnboardingScreen';
import { WelcomeScreen } from './src/screens/WelcomeScreen';
import { SignInScreen } from './src/screens/SignInScreen';
import { SplashScreen } from './src/screens/SplashScreen';
import {
  Button,
  ErrorState,
  LoadingState,
  PressableScale,
} from './src/design/components';
import { color, radius, space, type } from './src/design/tokens';
import { refreshSessionNow } from './src/account/sessionKeeper';
import { getApiSession, subscribeToApiSession } from './src/account/apiSession';
import { useAppStore } from './src/state/appStore';
import {
  useAuthStore,
  type AuthError,
  type AuthRestoreState,
  type AuthSession,
} from './src/auth/authStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
} from './src/data/accountScope';
import {
  UNASSIGNED_STABILITY_USER_KEY,
  stabilitySlo,
} from './src/analysis/stabilityTelemetry';
import { useNotificationBootstrap } from './src/notifications/useNotificationBootstrap';
import { useConsistencyBootstrap } from './src/consistency/useConsistencyBootstrap';
import { RankUpCelebration } from './src/components/RankUpCelebration';
import { StreakCelebration } from './src/consistency/StreakCelebration';
import { FirstRunWalkthrough } from './src/walkthrough/FirstRunWalkthrough';
import { CeremonyHost } from './src/flow/CeremonyHost';
import { useWalkthroughStore } from './src/walkthrough/walkthroughStore';
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
  type PreAuthStage,
} from './src/flow/launchGate';
import { makeUuid } from './src/util/uuid';
import { BrandNoticeHost } from './src/design/BrandNotice';
import {
  captureBoundaryError,
  resetDiagnosticsScope,
} from './src/diagnostics/sentry';

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

/** Stable, stack-body-free fingerprint of a caught render error. */
function crashFingerprint(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}:${error.message}:${(error.stack ?? '').split('\n')[1]?.trim() ?? ''}`
      : String(error);
  let hash = 2166136261;
  for (let i = 0; i < message.length; i += 1) {
    hash ^= message.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Last line of defense: a render/effect throw anywhere below unmounts the
 * whole tree in Release and terminates the process. Catch it, record a
 * non-fatal crash for the stability SLO, and offer an honest retry that
 * remounts the gate instead of leaving a dead app.
 */
export class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { caught: boolean }
> {
  state = { caught: false };

  static getDerivedStateFromError() {
    return { caught: true };
  }

  componentDidCatch(error: unknown) {
    captureBoundaryError(error);
    stabilitySlo.record({
      kind: 'crash',
      fatal: false,
      fingerprint: crashFingerprint(error),
    });
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

const authRestoreRecoveryCopy: Record<
  Extract<AuthRestoreState, { status: 'unavailable' }>['reason'],
  { title: string; detail: string }
> = {
  vault_unavailable: {
    title: 'Your sign-in couldn’t be checked',
    detail:
      'This device’s secure storage is unavailable. Unlock your device and try again. Your saved sign-in has not been deleted.',
  },
  vault_invalid: {
    title: 'Your saved sign-in couldn’t be read',
    detail:
      'Try again. If this continues, make sure Pickle Sensei is up to date. Your saved sign-in has not been deleted.',
  },
  vault_unsupported: {
    title: 'Update Pickle Sensei',
    detail:
      'This version can’t read the newer saved sign-in format. Update the app, then try again. Your saved sign-in has not been deleted.',
  },
  local_storage_unavailable: {
    title: 'Your sign-in couldn’t be checked',
    detail:
      'This device’s saved app state couldn’t be read. Try again. Your account and any saved coaching profile have not been reset.',
  },
  legacy_restore_unavailable: {
    title: 'Your sign-in couldn’t be restored',
    detail:
      'We couldn’t check your previous sign-in right now. Connect to the internet and try again.',
  },
};

function SessionPersistenceWarning(props: {
  session: AuthSession;
  error: AuthError;
  ownerKey: string;
  retry: () => Promise<void>;
}) {
  const { height } = useWindowDimensions();
  const apiSession = useSyncExternalStore(
    subscribeToApiSession,
    getApiSession,
    getApiSession,
  );
  const mounted = useRef(false);
  const pending = useRef<symbol | null>(null);
  const [pendingId, setPendingId] = useState<symbol | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const attempt = useMemo(() => {
    const canonicalAppUserId = props.session.canonicalAppUserId;
    const provider = props.session.provider;
    if (
      !canonicalAppUserId ||
      !apiSession?.refreshToken?.trim() ||
      apiSession.canonicalAppUserId !== canonicalAppUserId ||
      apiSession.provider !== provider ||
      getActiveDataOwner() !== props.ownerKey
    )
      return null;
    const owner = captureDataOwnerContext();
    return {
      id: Symbol(),
      retry: props.retry,
      current: () => {
        const state = useAuthStore.getState();
        return (
          state.hydrated &&
          state.session === props.session &&
          props.session.canonicalAppUserId === canonicalAppUserId &&
          props.session.provider === provider &&
          state.error === props.error &&
          state.error?.code === 'auth.storage_unavailable' &&
          state.retrySessionPersistence === props.retry &&
          (state.restoreState === undefined ||
            state.restoreState.status === 'restored') &&
          getApiSession() === apiSession &&
          apiSession.canonicalAppUserId === canonicalAppUserId &&
          apiSession.provider === provider &&
          isDataOwnerContextCurrent(owner)
        );
      },
    };
  }, [apiSession, props.error, props.ownerKey, props.retry, props.session]);

  const retry = async () => {
    if (
      !attempt ||
      !mounted.current ||
      !attempt.current() ||
      pending.current === attempt.id
    )
      return;
    pending.current = attempt.id;
    setPendingId(attempt.id);
    try {
      await attempt.retry();
    } catch {
      return;
    } finally {
      if (
        mounted.current &&
        pending.current === attempt.id &&
        attempt.current()
      ) {
        pending.current = null;
        setPendingId(null);
      }
    }
  };

  if (!attempt) return null;
  const retrying = pendingId === attempt.id;

  return (
    <SafeAreaView
      testID="session-persistence-warning"
      edges={['top', 'left', 'right']}
      accessibilityLiveRegion="polite"
      style={persistenceWarningStyles.surface}
    >
      <ScrollView
        style={{ flexGrow: 0, maxHeight: Math.max(space.xxxl, height / 4) }}
        contentContainerStyle={persistenceWarningStyles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={persistenceWarningStyles.copy}>
          <Text
            accessibilityRole="header"
            style={[type.h3, { color: color.ink }]}
          >
            Save sign-in on this device
          </Text>
          <Text
            style={[type.caption, { color: color.ink, marginTop: space.xs }]}
          >
            {props.error.message}
          </Text>
        </View>
        <PressableScale
          testID="session-persistence-retry"
          accessibilityLabel="Retry saving sign-in"
          accessibilityHint="Keep using the app while this device retries saving your current sign-in."
          accessibilityState={{ busy: retrying }}
          disabled={retrying}
          onPress={retry}
          containerStyle={{ maxWidth: '100%', alignSelf: 'center' }}
          style={persistenceWarningStyles.retry}
        >
          <Text
            style={[
              type.bodyBold,
              { color: color.onDark, flexShrink: 1, textAlign: 'center' },
            ]}
          >
            {retrying ? 'Saving…' : 'Retry'}
          </Text>
        </PressableScale>
      </ScrollView>
    </SafeAreaView>
  );
}

const persistenceWarningStyles = StyleSheet.create({
  surface: {
    backgroundColor: color.warnSoft,
    borderBottomWidth: 1,
    borderColor: color.line,
  },
  content: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space.sm,
  },
  copy: { flexBasis: '65%', flexGrow: 1, flexShrink: 1 },
  retry: {
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.court,
    borderRadius: radius.pill,
  },
});

/**
 * Launch → onboarding (pre-auth) → account (Apple/Google) → app. The
 * questionnaire runs BEFORE the login flow and the primary CTA always leads
 * into it; its answers wait in the appStore pre-auth stash and are adopted
 * by the owner that signs in (launchGate.ts pins the ordering). The
 * questionnaire is required and cannot be skipped: its step-one back control
 * returns to Welcome, and only finishing it reaches sign-in. Returning
 * players use Welcome's "I already have an account" link; a signed-in
 * account that still lacks a profile — one that never finished setup, or
 * whose pre-auth answers could not sync — lands in the in-account
 * OnboardingScreen, whose only other exit is signing out.
 */
function Gate() {
  const appHydrated = useAppStore(s => s.hydrated);
  const appOwnerKey = useAppStore(s => s.ownerKey);
  const profile = useAppStore(s => s.profile);
  const hydrateError = useAppStore(s => s.hydrateError);
  const awaitingApiSession = useAppStore(s => s.awaitingApiSession);
  const hydrateApp = useAppStore(s => s.hydrate);
  const authHydrated = useAuthStore(s => s.hydrated);
  const session = useAuthStore(s => s.session);
  const hydrateAuth = useAuthStore(s => s.hydrate);
  const signOut = useAuthStore(s => s.signOut);
  const authBusy = useAuthStore(s => s.busy);
  const authError = useAuthStore(s => s.error);
  const restoreState = useAuthStore(s => s.restoreState);
  const retrySessionPersistence = useAuthStore(s => s.retrySessionPersistence);
  const [preAuthStage, setPreAuthStage] = useState<PreAuthStage>('welcome');
  const [returningBackedOut, setReturningBackedOut] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
  const handleSplashFinished = useCallback(() => setSplashDone(true), []);
  const returning = restoreState?.status === 'reauth_required';
  const handleSignInBack = useCallback(() => {
    if (returning) setReturningBackedOut(true);
    setPreAuthStage('welcome');
  }, [returning]);

  useEffect(() => {
    if (!returning || session) setReturningBackedOut(false);
  }, [returning, session]);

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
    resetDiagnosticsScope();
  }, [desiredOwner, session]);

  useEffect(() => {
    if (!desiredOwner) return;
    void hydrateApp();
  }, [desiredOwner, hydrateApp, session]);

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

  const signOutStorageError =
    session === null &&
    authError?.code === 'auth.storage_unavailable' &&
    (restoreState === undefined ||
      restoreState.status === 'signed_out' ||
      restoreState.status === 'restored' ||
      restoreState.status === 'guest');
  const authRecovery = signOutStorageError
    ? { title: 'Finish signing out', detail: authError.message }
    : session === null && restoreState?.status === 'unavailable'
      ? authRestoreRecoveryCopy[restoreState.reason]
      : null;
  const restoreResolved =
    restoreState === undefined ||
    (restoreState.status !== 'restoring' &&
      (signOutStorageError ||
        (session
          ? restoreState.status === 'restored' ||
            restoreState.status === 'guest'
          : restoreState.status === 'signed_out' ||
            restoreState.status === 'reauth_required' ||
            restoreState.status === 'unavailable')));
  const ready =
    authHydrated &&
    restoreResolved &&
    (Boolean(authRecovery) ||
      (Boolean(desiredOwner) && appHydrated && appOwnerKey === desiredOwner));

  const retryAuthRecovery = () => {
    const current = useAuthStore.getState();
    if (
      !splashDone ||
      current.busy ||
      !current.hydrated ||
      current.session !== null ||
      current.restoreState !== restoreState ||
      current.error !== authError ||
      getActiveDataOwner() !== SIGNED_OUT_DATA_OWNER ||
      getApiSession() !== null
    )
      return;
    if (signOutStorageError) void current.signOut();
    else if (restoreState?.status === 'unavailable') void current.hydrate();
  };

  // First-run walkthrough: raised the first time each ACCOUNT lands on the
  // main app (session + profile both present — the moment the tab bar and
  // Coach button appear with no explanation). The store's durable
  // owner-scoped KV record makes repeat calls no-ops, so this effect can fire
  // on every re-render of the signed-in state and on every owner change.
  const mainAppVisible = ready && Boolean(session) && Boolean(profile);
  const maybeShowWalkthrough = useWalkthroughStore(s => s.maybeShowFirstRun);
  useEffect(() => {
    if (!mainAppVisible) return;
    void maybeShowWalkthrough();
  }, [mainAppVisible, desiredOwner, maybeShowWalkthrough]);

  // Rendered under the splash so the first screen is already painted by the
  // time the overlay clears — the handoff is a fade, not a swap. Every later
  // owner change (sign-in, sign-out, guest) re-hydrates with the splash gone,
  // so the not-ready state must paint a real loading affordance, never a
  // bare surface.
  const content = !ready ? (
    <LoadingState
      dark
      label={session ? 'Loading your account' : 'Getting things ready'}
    />
  ) : authRecovery ? (
    <ErrorState
      dark
      title={authRecovery.title}
      detail={authRecovery.detail}
      onRetry={authBusy ? undefined : retryAuthRecovery}
    />
  ) : !session ? (
    preAuthStage === 'signin' || (returning && !returningBackedOut) ? (
      <SignInScreen onBack={handleSignInBack} gateActive={splashDone} />
    ) : preAuthStage === 'onboarding' ? (
      <OnboardingScreen
        mode="preauth"
        onFinished={() => setPreAuthStage(stageAfterOnboarding())}
        onBack={() => setPreAuthStage(stageWhenLeavingOnboarding())}
      />
    ) : (
      <WelcomeScreen
        onGetStarted={() => setPreAuthStage(stageAfterGetStarted())}
        onSignIn={() => setPreAuthStage('signin')}
      />
    )
  ) : !profile && (hydrateError || awaitingApiSession) ? (
    <View style={{ flex: 1 }}>
      <ErrorState
        dark
        title={
          awaitingApiSession
            ? 'Restoring your account'
            : 'Your coaching profile couldn’t load'
        }
        detail={
          hydrateError ??
          'You’re still signed in. Connect to the internet to load your coaching profile. Your saved answers will not be replaced.'
        }
        onRetry={() => {
          if (awaitingApiSession) refreshSessionNow();
          void hydrateApp();
        }}
      />
      <SafeAreaView
        edges={['bottom']}
        style={{ paddingHorizontal: space.xl, paddingBottom: space.md }}
      >
        <Button
          label="Sign out"
          variant="secondary"
          disabled={authBusy}
          onPress={() => void signOut()}
        />
      </SafeAreaView>
    </View>
  ) : !profile ? (
    <OnboardingScreen />
  ) : (
    <RootNavigator />
  );

  return (
    <View style={{ flex: 1, backgroundColor: color.surfaceDark }}>
      {splashDone &&
      authHydrated &&
      restoreResolved &&
      desiredOwner &&
      session?.canonicalAppUserId &&
      session.provider !== 'guest' &&
      session.localOnly === false &&
      authError?.code === 'auth.storage_unavailable' ? (
        <SessionPersistenceWarning
          session={session}
          error={authError}
          ownerKey={desiredOwner}
          retry={retrySessionPersistence}
        />
      ) : null}
      <View testID="gate-content" style={{ flex: 1 }}>
        {content}
      </View>
      <CeremonyHost
        ownerKey={desiredOwner}
        enabled={mainAppVisible && splashDone}
      >
        {/* Global rank-up overlay: any screen that resolves a higher tier
          raises it through the celebration store. */}
        <RankUpCelebration />
        {/* Global streak-milestone overlay: the consistency store raises one
          durable ceremony per earned milestone. */}
        <StreakCelebration />
        {/* First-run walkthrough: one tour per account, raised on that
          account's first signed-in landing; Settings → About replays it. */}
        <FirstRunWalkthrough />
      </CeremonyHost>
      {/* Product-owned notice surface for errors that can outlive the screen
          which raised them (for example after account deletion). */}
      <BrandNoticeHost />
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
        <RootErrorBoundary>
          <Gate />
        </RootErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
