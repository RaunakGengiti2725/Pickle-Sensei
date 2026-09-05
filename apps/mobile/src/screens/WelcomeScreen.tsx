import React from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { BrandMark, Button, Pill, PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';

function CourtStory(props: { adaptive: boolean }) {
  return (
    <View
      style={[styles.courtStory, props.adaptive && styles.courtStoryAdaptive]}
      testID="welcome-court-story"
    >
      <Svg
        width="100%"
        height="100%"
        viewBox="0 0 340 300"
        style={props.adaptive ? StyleSheet.absoluteFill : undefined}
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
      <View style={[styles.readout, props.adaptive && styles.readoutAdaptive]}>
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
      <View
        style={[styles.livePill, props.adaptive && styles.livePillAdaptive]}
      >
        <View style={styles.privateIcon} />
        <Text
          style={[
            type.micro,
            { color: color.onDark },
            props.adaptive && styles.flexibleText,
          ]}
        >
          ON-DEVICE
        </Text>
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
  const { height, fontScale } = useWindowDimensions();
  const adaptive = height < 760 || fontScale > 1.2;
  const freeCopy = (
    <Text style={styles.privacy} testID="welcome-free-copy">
      Two scored technique reads free · Unscored attempts don’t count
    </Text>
  );
  const content = (
    <>
      <View style={[styles.topBar, adaptive && styles.topBarAdaptive]}>
        {adaptive ? (
          <View style={styles.adaptiveBrand}>
            <BrandMark light compact />
            <Text accessible={false} style={[type.h3, styles.brandName]}>
              Pickle Sensei
            </Text>
          </View>
        ) : (
          <BrandMark light />
        )}
        {adaptive ? (
          <View style={styles.privacyBadge}>
            <Text style={[type.micro, { color: color.onDark }]}>
              PRIVATE BY DEFAULT
            </Text>
          </View>
        ) : (
          <Pill label="PRIVATE BY DEFAULT" tone="dark" />
        )}
      </View>

      <View style={styles.heroCopy}>
        <Text style={[type.hero, { color: color.onDark }]}>
          See the stroke.{`\n`}Know the fix.
        </Text>
        <Text style={styles.tagline}>
          A private technique coach that guides each capture and turns scored
          technique reads into one clear next step.
        </Text>
      </View>

      <CourtStory adaptive={adaptive} />
      {adaptive ? <View style={styles.freeCopyContent}>{freeCopy}</View> : null}
    </>
  );
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      {adaptive ? (
        <ScrollView
          style={styles.contentScroll}
          contentContainerStyle={styles.scrollContent}
          indicatorStyle="white"
          testID="welcome-content-scroll"
        >
          {content}
        </ScrollView>
      ) : (
        content
      )}
      <View
        style={[styles.footer, adaptive && styles.footerAdaptive]}
        testID="welcome-actions"
      >
        {adaptive ? (
          <PressableScale
            accessibilityLabel="Start your first read"
            onPress={props.onGetStarted}
            style={styles.primaryAdaptive}
          >
            <Text style={[type.bodyBold, styles.primaryLabel]}>
              Start your first read
            </Text>
            <Icon name="arrow" size={18} color={color.onVolt} />
          </PressableScale>
        ) : (
          <Button
            label="Start your first read"
            variant="volt"
            onPress={props.onGetStarted}
          />
        )}
        {props.onSignIn ? (
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="I already have an account"
            accessibilityHint="Sign in to an existing account"
            onPress={props.onSignIn}
            style={styles.signInLink}
          >
            <Text
              style={[
                type.bodyBold,
                { color: color.onDarkMuted },
                adaptive && styles.centeredText,
              ]}
            >
              I already have an account
            </Text>
          </PressableScale>
        ) : null}
        {!adaptive ? freeCopy : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  contentScroll: { flex: 1, minHeight: 0 },
  scrollContent: { paddingBottom: space.lg },
  topBarAdaptive: { flexWrap: 'wrap', gap: space.sm },
  adaptiveBrand: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    maxWidth: '100%',
  },
  brandName: { color: color.onDark, flexShrink: 1 },
  privacyBadge: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: space.sm,
    paddingVertical: space.xs,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
  },
  courtStoryAdaptive: { flex: 0, padding: space.lg },
  readoutAdaptive: { position: 'relative', top: 0, left: 0 },
  livePillAdaptive: {
    position: 'relative',
    right: 0,
    bottom: 0,
    marginTop: space.lg,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  flexibleText: { flexShrink: 1 },
  centeredText: { textAlign: 'center' },
  footerAdaptive: { flexShrink: 0 },
  primaryAdaptive: {
    minHeight: 56,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderRadius: radius.lg,
    backgroundColor: color.volt,
  },
  primaryLabel: { color: color.onVolt, flex: 1, textAlign: 'center' },
  freeCopyContent: { paddingHorizontal: space.lg },
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
