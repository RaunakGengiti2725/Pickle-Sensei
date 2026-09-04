import React from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  BrandMark,
  BrandSpinner,
  PressableScale,
  ScreenHeader,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, font, radius, space, type } from '../design/tokens';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { useAuthStore } from '../auth/authStore';

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
            type.bodyBold,
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

export function SignInScreen(props: { onBack: () => void }) {
  const insets = useReliableSafeAreaInsets();
  const { busy, error, signInWithApple, signInWithGoogle, clearError } =
    useAuthStore();

  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <ScreenHeader onBack={props.onBack} />
      {/* Everything under the header scrolls when it overflows (small
          phones, large Dynamic Type, a long provider error) so the
          providers and the trust note never stack over each other. */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.body} testID="sign-in-body">
          <BrandMark />
          <Text style={[type.hero, styles.title]}>
            Your ratings,{`\n`}tied to you.
          </Text>
          <Text style={styles.sub}>
            A connected account is required for free ratings, membership, and
            server-verified coaching. Synced progress stays with that account.
          </Text>

          <View style={styles.providers}>
            {Platform.OS === 'ios' ? (
              <ProviderButton
                label="Continue with Apple"
                mark=""
                dark
                disabled={busy}
                onPress={() => void signInWithApple()}
              />
            ) : null}
            <ProviderButton
              label="Continue with Google"
              mark="G"
              disabled={busy}
              onPress={() => void signInWithGoogle()}
            />
          </View>

          {busy ? (
            <View style={styles.busyRow}>
              <BrandSpinner color={color.court} />
              <Text style={[type.caption, { color: color.inkSoft }]}>
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
              Your existing on-device reads stay here when you connect.
            </Text>
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  scroll: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  body: { flexGrow: 1, paddingHorizontal: space.lg, paddingTop: space.lg },
  title: { color: color.ink, marginTop: space.xl },
  sub: {
    ...type.body,
    color: color.inkSoft,
    marginTop: space.sm,
    maxWidth: 340,
  },
  providers: { marginTop: space.xl, gap: 12 },
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
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
