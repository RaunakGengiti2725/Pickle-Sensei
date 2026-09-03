import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Video, { type OnProgressData } from 'react-native-video';
import { PressableScale, useReducedMotion } from '../design/components';
import { space, type } from '../design/tokens';

/**
 * Launch intro: the brand animation (`assets/brand/splash.mp4`, 9:16, with
 * its own sound) plays once over the already-rendered first screen, then the
 * overlay cross-fades away. A quiet "Skip" control fades in after the first
 * second of playback for anyone who has seen it before.
 *
 * The video is shown whole (`contain`) at its native 9:16 — never cropped or
 * stretched to the phone. Its edges are pure white in every frame, so the
 * white canvas around it on taller screens is indistinguishable from the
 * video itself. The native launch storyboard and window paint the same white,
 * which keeps process start → first video frame one continuous surface.
 */

const INTRO = require('../../assets/brand/splash.mp4');

/** Matches the video's own edge color; the letterbox must be invisible. */
const CANVAS = '#FFFFFF';
/** The intro's silhouette is pure black; the control matches it. */
const INK = '#000000';

/** Playback seconds before the skip control fades in. */
export const SKIP_AFTER_S = 1;
const SKIP_FADE_MS = 320;
/** Cross-fade of the overlay over the first screen. */
export const EXIT_MS = 520;
/** Volume levels the exit ramp steps through (1 → 0). */
const VOLUME_STEPS = 6;
/**
 * A player that neither ends nor errors (e.g. a decoder that stalls on this
 * device) is cut here so the app can never be stranded behind the intro.
 */
export const WATCHDOG_MS = 8000;

export function SplashScreen(props: {
  ready: boolean;
  onFinished: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { ready, onFinished } = props;

  // Overlay opacity runs on the native driver so the fade stays smooth while
  // the JS thread is busy painting the first screen.
  const exit = useRef(new Animated.Value(0)).current;
  // JS-driven twin of `exit`: its listener feeds the player's volume prop.
  const fade = useRef(new Animated.Value(0)).current;
  const skipOpacity = useRef(new Animated.Value(0)).current;
  const finished = useRef(false);
  const [playbackOver, setPlaybackOver] = useState(false);
  const [skipRequested, setSkipRequested] = useState(false);
  const [skipVisible, setSkipVisible] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [volume, setVolume] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setPlaybackOver(true), WATCHDOG_MS);
    return () => clearTimeout(timer);
  }, []);

  // RN's StatusBar gives priority to the entry pushed LAST. The first screen
  // mounts under this overlay once `ready` flips, and a dark one (Welcome,
  // Onboarding) would turn the bar white-on-white over the video. Re-push the
  // overlay's entry on every `ready` change: passive effects run after every
  // componentDidMount of the same commit, so it lands back on top.
  useEffect(() => {
    const entry = StatusBar.pushStackEntry({
      barStyle: 'dark-content',
      animated: true,
    });
    return () => StatusBar.popStackEntry(entry);
  }, [ready]);

  useEffect(() => {
    if (!skipVisible) return;
    Animated.timing(skipOpacity, {
      toValue: 1,
      duration: reducedMotion ? 0 : SKIP_FADE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [reducedMotion, skipOpacity, skipVisible]);

  // The handoff waits for BOTH the intro (ended, skipped, errored or timed
  // out) and hydration, so the fade always reveals a painted first screen.
  useEffect(() => {
    if (!ready || !(playbackOver || skipRequested) || finished.current) return;
    finished.current = true;
    setExiting(true);
    const duration = reducedMotion ? 0 : EXIT_MS;
    const easing = Easing.inOut(Easing.cubic);
    // Sound follows the picture down: a skip mid-intro tails off instead of
    // cutting. Stepped, because every volume change re-applies the player's
    // modifiers natively (audio session included) — a per-frame ramp would
    // do that ~30 times.
    const listener = fade.addListener(({ value }) =>
      setVolume(
        Math.max(0, Math.round((1 - value) * VOLUME_STEPS) / VOLUME_STEPS),
      ),
    );
    Animated.parallel([
      Animated.timing(exit, {
        toValue: 1,
        duration,
        easing,
        useNativeDriver: true,
      }),
      Animated.timing(fade, {
        toValue: 1,
        duration,
        easing,
        useNativeDriver: false,
      }),
    ]).start(() => {
      fade.removeListener(listener);
      onFinished();
    });
  }, [
    exit,
    fade,
    onFinished,
    playbackOver,
    ready,
    reducedMotion,
    skipRequested,
  ]);

  const onProgress = useCallback(
    (event: OnProgressData) => {
      if (!skipVisible && event.currentTime >= SKIP_AFTER_S) {
        setSkipVisible(true);
      }
    },
    [skipVisible],
  );
  const onPlaybackOver = useCallback(() => setPlaybackOver(true), []);
  const onSkip = useCallback(() => setSkipRequested(true), []);

  return (
    <Animated.View
      testID="splash-screen"
      pointerEvents={exiting ? 'none' : 'auto'}
      style={[
        StyleSheet.absoluteFill,
        styles.canvas,
        {
          opacity: exit.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
          }),
        },
      ]}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel="Pickle Sensei intro animation"
        style={StyleSheet.absoluteFill}
      >
        <Video
          testID="splash-video"
          source={INTRO}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
          paused={false}
          repeat={false}
          controls={false}
          volume={volume}
          // Launch sound is non-essential audio: honor the ring/silent switch
          // (ambient category, which also mixes over anything already
          // playing) and never steal Android audio focus from the user's music.
          ignoreSilentSwitch="obey"
          disableFocus
          playInBackground={false}
          shutterColor={CANVAS}
          progressUpdateInterval={100}
          onProgress={onProgress}
          onEnd={onPlaybackOver}
          onError={onPlaybackOver}
        />
      </View>
      {skipVisible ? (
        <Animated.View
          pointerEvents="box-none"
          style={[styles.skipZone, { opacity: skipOpacity }]}
        >
          <PressableScale
            testID="splash-skip"
            accessibilityLabel="Skip intro"
            onPress={onSkip}
            hitSlop={12}
            containerStyle={styles.skipContainer}
            style={styles.skipButton}
          >
            <Text style={[type.bodyBold, styles.skipLabel]}>Skip</Text>
          </PressableScale>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  canvas: { backgroundColor: CANVAS },
  // The control sits centered in the bottom 15% of the page.
  skipZone: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: '15%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  skipContainer: { alignSelf: 'center' },
  skipButton: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  skipLabel: {
    color: INK,
    textShadowColor: 'rgba(0, 0, 0, 0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
});
