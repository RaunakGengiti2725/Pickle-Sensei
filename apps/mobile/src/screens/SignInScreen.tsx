import React, { useCallback, useEffect, useRef } from 'react';
import {
  BackHandler,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  BrandMark,
  BrandSpinner,
  Button,
  PressableScale,
  ScreenHeader,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, font, radius, space, type } from '../design/tokens';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { useAuthStore } from '../auth/authStore';
import type { ReturningSessionReason } from '../auth/sessionMigration';

const returningSessionCopy: Record<ReturningSessionReason, string> = {
  legacy_credentials_missing:
    'An earlier version couldn’t keep your sign-in on this device. Please sign in once more.',
  credentials_missing:
    'This device no longer has the credentials needed to restore your sign-in.',
  revoked:
    'Your previous sign-in is no longer valid. Please sign in again to reconnect.',
};

function ProviderButton(props: {
  label: string;
  mark: string;
  onPress: () => void;
  dark?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressableScale
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[styles.providerButton, props.dark && styles.providerButtonDark]}
    >
      <View style={styles.providerInner}>
        <View
          style={[
            styles.providerMark,
            props.dark && { borderColor: color.lineStrongDark },
          ]}
        >
          <Text
            style={[
              styles.providerMarkText,
              props.mark === '' ? styles.appleMark : styles.letterMark,
              { color: props.dark ? color.onDark : color.ink },
            ]}
          >
            {props.mark}
          </Text>
        </View>
        <Text
          style={[
            styles.providerLabel,
            { color: props.dark ? color.onDark : color.ink },
          ]}
        >
          {props.label}
        </Text>
        <View style={{ width: 28 }} />
      </View>
    </PressableScale>
  );
}

export function SignInScreen(props: {
  onBack: () => void;
  gateActive?: boolean;
}) {
  const insets = useReliableSafeAreaInsets();
  const {
    busy,
    error,
    session,
    restoreState,
    signInWithApple,
    signInWithGoogle,
    clearError,
  } = useAuthStore();
  const returning =
    session === null && restoreState?.status === 'reauth_required'
      ? restoreState
      : null;
  const active = props.gateActive !== false;
  const activeRef = useRef(active);

  useEffect(() => {
    activeRef.current = active;
    return () => {
      activeRef.current = false;
    };
  }, [active]);

  const acknowledgeNotice = useCallback(() => {
    if (!activeRef.current || !returning?.noticePending) return;
    const current = useAuthStore.getState();
    if (current.session !== null || current.restoreState !== returning) return;
    void current.acknowledgeReturningSession();
  }, [returning]);

  const handleBack = useCallback(() => {
    if (!activeRef.current) return;
    acknowledgeNotice();
    props.onBack();
  }, [acknowledgeNotice, props.onBack]);

  useEffect(() => {
    if (!props.gateActive) return;
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        handleBack();
        return true;
      },
    );
    return () => subscription.remove();
  }, [props.gateActive, handleBack]);

  const previousAccount = returning?.provider
    ? `the same ${returning.provider === 'apple' ? 'Apple' : 'Google'} account`
    : 'the account you used before';

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <ScreenHeader onBack={handleBack} />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.body}>
          <BrandMark />
          <Text style={[type.hero, styles.title]}>
            {returning ? 'Sign in again.' : 'Your ratings,\ntied to you.'}
          </Text>
          <Text style={styles.sub}>
            {returning
              ? `Use ${previousAccount} to check for a saved coaching profile and synced progress.`
              : 'A connected account is required for free ratings, membership, and server-verified coaching. Synced progress stays with that account.'}
          </Text>

          {active && returning?.noticePending ? (
            <View
              testID="returning-session-notice"
              accessibilityLiveRegion="polite"
              style={styles.returningNotice}
            >
              <Text style={[type.micro, { color: color.courtDeep }]}>
                ONE MORE SIGN-IN
              </Text>
              <Text style={[type.body, styles.noticeCopy]}>
                {returningSessionCopy[returning.reason]}
              </Text>
              <View style={{ marginTop: space.md }}>
                <Button
                  label="Got it"
                  variant="secondary"
                  onPress={acknowledgeNotice}
                />
              </View>
            </View>
          ) : null}

          <View style={styles.providers}>
            {Platform.OS === 'ios' ? (
              <ProviderButton
                label="Continue with Apple"
                mark=""
                dark
                disabled={busy || !active}
                onPress={() => void signInWithApple()}
              />
            ) : null}
            <ProviderButton
              label="Continue with Google"
              mark="G"
              disabled={busy || !active}
              onPress={() => void signInWithGoogle()}
            />
          </View>

          {busy ? (
            <View style={styles.busyRow}>
              <BrandSpinner color={color.court} />
              <Text
                style={[type.caption, { color: color.inkSoft, flexShrink: 1 }]}
              >
                Signing in securely…
              </Text>
            </View>
          ) : null}

          {error && error.code !== 'auth.canceled' ? (
            <PressableScale
              onPress={clearError}
              accessibilityLabel="Dismiss sign-in error"
              accessibilityHint={error.message}
              accessibilityLiveRegion="assertive"
              style={styles.errorCard}
            >
              <Text style={[type.micro, { color: color.bad }]}>
                {error.code === 'auth.not_configured'
                  ? 'NOT CONFIGURED YET'
                  : error.code === 'auth.storage_unavailable'
                    ? 'STORAGE UNAVAILABLE'
                    : 'SIGN-IN FAILED'}
              </Text>
              <Text style={[type.caption, { color: color.ink, marginTop: 4 }]}>
                {error.message}
              </Text>
            </PressableScale>
          ) : null}
        </View>

        <View style={styles.footer}>
          <View style={styles.trustRow}>
            <Icon name="shield" color={color.court} size={17} />
            <Text style={styles.trustCopy}>
              {returning
                ? 'Any saved profile stays private until the matching account is verified.'
                : 'Your existing on-device reads stay here when you connect.'}
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  scrollContent: { flexGrow: 1 },
  body: {
    flexGrow: 1,
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.lg,
  },
  title: { color: color.ink, marginTop: space.xl },
  sub: {
    ...type.body,
    color: color.inkSoft,
    marginTop: space.sm,
    maxWidth: 340,
  },
  returningNotice: {
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.courtSoft,
  },
  noticeCopy: { color: color.ink, marginTop: space.sm },
  providers: { marginTop: space.xl, gap: 12 },
  providerLabel: { ...type.bodyBold, flexShrink: 1, textAlign: 'center' },
  providerButton: {
    minHeight: 58,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    overflow: 'hidden',
  },
  providerButtonDark: { backgroundColor: color.ink, borderColor: color.ink },
  providerInner: {
    minHeight: 58,
    paddingHorizontal: 15,
    paddingVertical: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  providerMark: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: color.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  providerMarkText: { ...type.caption },
  letterMark: { fontFamily: font.bold },
  appleMark: { fontFamily: 'System', fontSize: 18, lineHeight: 20 },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  errorCard: {
    marginTop: space.md,
    backgroundColor: color.badSoft,
    borderRadius: radius.md,
    padding: space.md,
  },
  footer: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  trustCopy: { ...type.caption, color: color.inkSoft, flex: 1 },
});
