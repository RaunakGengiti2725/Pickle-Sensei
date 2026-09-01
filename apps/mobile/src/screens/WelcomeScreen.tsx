import React from 'react';
import { StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { BrandMark, Button, Pill, PressableScale } from '../design/components';
import { color, radius, space, type } from '../design/tokens';

function CourtStory() {
  return (
    <View style={styles.courtStory}>
      <Svg width="100%" height="100%" viewBox="0 0 340 300">
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
      <View style={styles.readout}>
        <Text style={[type.micro, { color: color.volt }]}>POSE-GUIDED</Text>
        <Text style={[type.h1, styles.readoutTitle]}>
          Automatic{`\n`}capture.
        </Text>
        <Text
          style={[type.caption, { color: color.onDarkMuted, marginTop: 5 }]}
        >
          No shot picker. No timer.
        </Text>
      </View>
      <View style={styles.livePill}>
        <View style={styles.privateIcon} />
        <Text style={[type.micro, { color: color.onDark }]}>ON-DEVICE</Text>
      </View>
    </View>
  );
}

export function WelcomeScreen(props: {
  onGetStarted: () => void;
  /** Straight to sign-in — returning users skip the setup questionnaire. */
  onSignIn?: () => void;
}) {
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <View style={styles.topBar}>
        <BrandMark light />
        <Pill label="PRIVATE BY DEFAULT" tone="dark" />
      </View>

      <View style={styles.heroCopy}>
        <Text style={[type.hero, { color: color.onDark }]}>
          See the stroke.{`\n`}Know the fix.
        </Text>
        <Text style={styles.tagline}>
          A private technique coach that guides each capture and turns validated
          reads into one clear next step.
        </Text>
      </View>

      <CourtStory />

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
            accessibilityHint="Skip setup and go to sign-in"
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
    marginTop: space.md,
    maxWidth: 340,
  },
  courtStory: {
    flex: 1,
    marginHorizontal: space.lg,
    marginTop: space.lg,
    minHeight: 270,
    borderRadius: radius.xl,
    backgroundColor: color.inkElevated,
    overflow: 'hidden',
  },
  readout: { position: 'absolute', top: 28, left: 28 },
  readoutTitle: { color: color.onDark, marginTop: space.sm },
  livePill: {
    position: 'absolute',
    right: 20,
    bottom: 20,
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
