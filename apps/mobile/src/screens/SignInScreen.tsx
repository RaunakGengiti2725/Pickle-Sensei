import React from 'react';
import {
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
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
  adaptive: boolean;
  fontScale: number;
}) {
  const markSize = 28 * Math.max(1, props.fontScale);
  return (
    <PressableScale
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={[
        styles.providerButton,
        props.dark && styles.providerButtonDark,
        props.adaptive && styles.providerButtonAdaptive,
      ]}
    >
      <View
        style={[
          styles.providerInner,
          props.adaptive && styles.providerInnerAdaptive,
        ]}
      >
        <View
          style={[
            styles.providerMark,
            props.adaptive && {
              width: markSize,
              height: markSize,
              borderRadius: markSize / 2,
            },
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
            props.adaptive && styles.providerLabelAdaptive,
            { color: props.dark ? color.onDark : color.ink },
          ]}
        >
          {props.label}
        </Text>
        {!props.adaptive ? <View style={{ width: 28 }} /> : null}
      </View>
    </PressableScale>
  );
}

export function SignInScreen(props: { onBack: () => void }) {
  const insets = useReliableSafeAreaInsets();
  const { height, fontScale } = useWindowDimensions();
  const adaptive = height < 760 || fontScale > 1.3;
  const { busy, error, signInWithApple, signInWithGoogle, clearError } =
    useAuthStore();

  const body = (
    <View style={[styles.body, adaptive && styles.bodyAdaptive]}>
      {adaptive ? (
        <View style={styles.adaptiveBrand}>
          <BrandMark compact />
          <Text accessible={false} style={[type.h3, styles.brandName]}>
            Pickle Sensei
          </Text>
        </View>
      ) : (
        <BrandMark />
      )}
      <Text style={[type.hero, styles.title]}>
        Your ratings,{`\n`}tied to you.
      </Text>
      <Text style={styles.sub}>
        A connected account is required for free ratings, membership, and
        server-verified coaching. Synced progress stays with that account.
      </Text>

      <View style={styles.providers} testID="signin-providers">
        {Platform.OS === 'ios' ? (
          <ProviderButton
            adaptive={adaptive}
            fontScale={fontScale}
            label="Continue with Apple"
            mark=""
            dark
            disabled={busy}
            onPress={() => void signInWithApple()}
          />
        ) : null}
        <ProviderButton
          adaptive={adaptive}
          fontScale={fontScale}
          label="Continue with Google"
          mark="G"
          disabled={busy}
          onPress={() => void signInWithGoogle()}
        />
      </View>

      {busy ? (
        <View style={styles.busyRow}>
          <BrandSpinner color={color.court} />
          <Text
            style={[
              type.caption,
              { color: color.inkSoft },
              adaptive && styles.flexibleText,
            ]}
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
              : 'SIGN-IN FAILED'}
          </Text>
          <Text style={[type.caption, { color: color.ink, marginTop: 4 }]}>
            {error.message}
          </Text>
        </PressableScale>
      ) : null}
    </View>
  );
  const footer = (
    <View style={styles.footer}>
      <View style={styles.trustRow}>
        <Icon name="shield" color={color.court} size={17} />
        <Text style={styles.trustCopy} testID="signin-trust-copy">
          Your existing on-device reads stay here when you connect.
        </Text>
      </View>
    </View>
  );
  return (
    <View
      style={[
        styles.screen,
        { paddingTop: insets.top, paddingBottom: insets.bottom },
      ]}
    >
      <ScreenHeader onBack={props.onBack} />
      {adaptive ? (
        <ScrollView
          style={styles.contentScroll}
          contentContainerStyle={styles.scrollContent}
          testID="signin-content-scroll"
        >
          {body}
          {footer}
        </ScrollView>
      ) : (
        <>
          {body}
          {footer}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  contentScroll: { flex: 1, minHeight: 0 },
  scrollContent: { flexGrow: 1, paddingBottom: space.sm },
  bodyAdaptive: { flex: 0 },
  adaptiveBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
  },
  brandName: { color: color.ink, flexShrink: 1 },
  providerButtonAdaptive: { borderRadius: radius.lg },
  providerInnerAdaptive: { gap: space.sm, paddingVertical: space.sm },
  providerLabelAdaptive: { flex: 1, textAlign: 'center' },
  flexibleText: { flexShrink: 1 },
  body: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.lg },
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
  letterMark: {
    fontFamily: font.bold,
    fontWeight: Platform.OS === 'ios' ? '700' : 'normal',
  },
  appleMark: { fontFamily: 'System', fontSize: 18, lineHeight: 20 },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
  },
  errorCard: {
    minHeight: 44,
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
