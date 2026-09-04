import React from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { BrandMark, Button, Pill, PressableScale } from '../design/components';
import { color, radius, space, type } from '../design/tokens';

/**
 * Illustration card. Its copy is laid out in flow so the card is never
 * shorter than its own text at any Dynamic Type size; the court drawing
 * floats behind it, and when the column has room the card grows and the
 * caption row settles at its bottom edge.
 */
function CourtStory() {
  return (
    <View style={styles.courtStory} testID="welcome-court-story">
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 340 300"
        style={styles.courtDrawing}
        pointerEvents="none"
      >
        <Path
          d="M35 42h270v216H35z"
          stroke={color.lineDark}
          strokeWidth="1.5"
          fill="none"
        />
        <Line
          x1="170"
          y1="42"
          x2="170"
          y2="258"
          stroke={color.lineDark}
          strokeWidth="1.5"
        />
        <Line
          x1="35"
          y1="120"
          x2="305"
          y2="120"
          stroke={color.lineDark}
          strokeWidth="1.5"
        />
        <Line
          x1="35"
          y1="180"
          x2="305"
          y2="180"
          stroke={color.lineDark}
          strokeWidth="1.5"
        />
        <Path
          d="M84 221c35-72 80-87 147-109"
          stroke={color.volt}
          strokeWidth="2.5"
          fill="none"
          strokeDasharray="4 7"
          strokeLinecap="round"
        />
        <Circle cx="84" cy="221" r="8" fill={color.volt} />
        <Circle cx="231" cy="112" r="5" fill={color.onDark} />
      </Svg>
      <Text style={[type.micro, { color: color.volt }]}>POSE-GUIDED</Text>
      <Text style={[type.h1, styles.readoutTitle]}>
        Automatic{`\n`}capture.
      </Text>
      <View style={styles.readoutSpacer} />
      <View style={styles.readoutRow}>
        <Text style={styles.readoutCaption}>No shot picker. No timer.</Text>
        <View style={styles.livePill}>
          <View style={styles.privateIcon} />
          <Text style={[type.micro, { color: color.onDark }]}>ON-DEVICE</Text>
        </View>
      </View>
    </View>
  );
}

export function WelcomeScreen(props: {
  onGetStarted: () => void;
  /** Straight to sign-in for returning players. Setup itself is never
   * skipped: an account that hasn't finished it lands in the in-account
   * questionnaire after signing in. */
  onSignIn?: () => void;
}) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      {/* The body scrolls only when it genuinely overflows (small phones,
          large Dynamic Type); the footer below stays pinned so the primary
          action is reachable without scrolling. */}
      <ScrollView
        style={styles.body}
        contentContainerStyle={styles.bodyContent}
        alwaysBounceVertical={false}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.topBar}>
          <BrandMark light />
          <Pill label="PRIVATE BY DEFAULT" tone="dark" />
        </View>

        <View style={styles.heroCopy}>
          <Text style={[type.hero, { color: color.onDark }]}>
            See the stroke.{`\n`}Know the fix.
          </Text>
          <Text style={styles.tagline}>
            A private technique coach that guides each capture and turns
            validated reads into one clear next step.
          </Text>
        </View>

        <CourtStory />
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label="Start your first read"
          variant="volt"
          onPress={props.onGetStarted}
        />
        {props.onSignIn ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="I already have an account"
            accessibilityHint="Sign in to an existing account"
            onPress={props.onSignIn}
            style={styles.signInLink}
          >
            <Text style={[type.bodyBold, { color: color.onDarkMuted }]}>
              I already have an account
            </Text>
          </PressableScale>
        ) : null}
        <Text style={styles.privacy}>
          Two successful validated ratings free · Unscored attempts don’t count
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  body: { flex: 1 },
  bodyContent: { flexGrow: 1 },
  topBar: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  heroCopy: { paddingHorizontal: space.lg, paddingTop: space.xl },
  tagline: {
    ...type.body,
    color: color.onDarkMuted,
    marginTop: space.sm,
    maxWidth: 340,
  },
  courtStory: {
    flexGrow: 1,
    marginHorizontal: space.lg,
    marginTop: space.lg,
    paddingTop: 28,
    paddingLeft: 28,
    paddingRight: 20,
    paddingBottom: 20,
    borderRadius: radius.xl,
    backgroundColor: color.inkElevated,
    overflow: 'hidden',
  },
  courtDrawing: { position: 'absolute', top: 0, left: 0 },
  readoutTitle: { color: color.onDark, marginTop: space.sm },
  readoutSpacer: { flexGrow: 1 },
  readoutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    marginTop: 5,
  },
  readoutCaption: {
    ...type.caption,
    color: color.onDarkMuted,
    flexShrink: 1,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: color.overlayDarkSoft,
  },
  privateIcon: {
    width: 8,
    height: 8,
    borderRadius: 3,
    borderWidth: 2,
    borderColor: color.volt,
    transform: [{ rotate: '45deg' }],
  },
  footer: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.sm,
  },
  // A quiet full-width text action under the primary CTA: 44pt minimum
  // touch height, no competing button chrome.
  signInLink: {
    minHeight: 44,
    marginTop: space.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privacy: {
    ...type.caption,
    color: color.onDarkFaint,
    textAlign: 'center',
    marginTop: space.md,
  },
});
