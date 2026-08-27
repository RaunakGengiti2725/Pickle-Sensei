import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color, radius, space, type } from '../design/tokens';
import { useAuthStore } from '../auth/authStore';

/**
 * Account screen (spec p. 5): Continue with Apple / Google, plus a local
 * trial account. Configuration gaps surface as explicit states — a sign-in
 * method that cannot work is labeled, never simulated.
 */

function ProviderButton(props: {
  label: string;
  glyph: string;
  onPress: () => void;
  variant: 'apple' | 'google';
  disabled?: boolean;
}) {
  const isApple = props.variant === 'apple';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.providerButton,
        isApple ? styles.appleButton : styles.googleButton,
        { opacity: props.disabled ? 0.5 : pressed ? 0.85 : 1 },
      ]}
    >
      <Text
        style={[
          styles.providerGlyph,
          { color: isApple ? color.onDark : color.ink },
        ]}
      >
        {props.glyph}
      </Text>
      <Text
        style={[type.bodyBold, { color: isApple ? color.onDark : color.ink }]}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function SignInScreen(props: { onBack: () => void }) {
  const {
    busy,
    error,
    signInWithApple,
    signInWithGoogle,
    continueAsGuest,
    clearError,
  } = useAuthStore();

  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={props.onBack}
          hitSlop={12}
        >
          <Text style={[type.h2, { color: color.inkSoft }]}>‹</Text>
        </Pressable>
      </View>

      <View style={styles.body}>
        <Text style={[type.h1, { color: color.ink }]}>
          Your coach,{'\n'}your account.
        </Text>
        <Text
          style={[type.body, { color: color.inkSoft, marginTop: space.sm }]}
        >
          Sign in so your reps, scores, and progress follow you across devices.
        </Text>

        <View style={{ marginTop: space.xl, gap: space.sm }}>
          <ProviderButton
            label="Continue with Apple"
            glyph=""
            variant="apple"
            disabled={busy}
            onPress={() => void signInWithApple()}
          />
          <ProviderButton
            label="Continue with Google"
            glyph="G"
            variant="google"
            disabled={busy}
            onPress={() => void signInWithGoogle()}
          />
        </View>

        {busy && (
          <View style={styles.busyRow}>
            <ActivityIndicator color={color.court} />
            <Text
              style={[
                type.caption,
                { color: color.inkSoft, marginLeft: space.sm },
              ]}
            >
              Signing in…
            </Text>
          </View>
        )}

        {error && error.code !== 'auth.canceled' && (
          <Pressable
            onPress={clearError}
            style={styles.errorCard}
            accessibilityRole="button"
          >
            <Text style={[type.micro, { color: color.bad }]}>
              {error.code === 'auth.not_configured'
                ? 'NOT CONFIGURED YET'
                : 'SIGN-IN FAILED'}
            </Text>
            <Text style={[type.caption, { color: color.ink, marginTop: 4 }]}>
              {error.message}
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          onPress={() => void continueAsGuest()}
          hitSlop={8}
        >
          <Text
            style={[type.bodyBold, { color: color.court, textAlign: 'center' }]}
          >
            Try it without an account
          </Text>
        </Pressable>
        <Text
          style={[
            type.caption,
            { color: color.inkSoft, textAlign: 'center', marginTop: space.sm },
          ]}
        >
          Guest sessions live on this device. Sign in later to sync them.
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  header: { paddingHorizontal: space.lg, paddingTop: space.sm },
  body: { flex: 1, paddingHorizontal: space.lg, paddingTop: space.lg },
  providerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 52,
    borderRadius: radius.md,
    gap: space.sm,
  },
  appleButton: { backgroundColor: '#000000' },
  googleButton: {
    backgroundColor: color.surface,
    borderWidth: 1.5,
    borderColor: color.line,
  },
  providerGlyph: { fontSize: 18, fontWeight: '700' },
  busyRow: { flexDirection: 'row', alignItems: 'center', marginTop: space.md },
  errorCard: {
    marginTop: space.md,
    backgroundColor: '#FEF2F2',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: '#FECACA',
    padding: space.md,
  },
  footer: { padding: space.lg, paddingBottom: space.xl },
});
