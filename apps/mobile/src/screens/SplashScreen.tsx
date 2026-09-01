import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Image, StatusBar, StyleSheet } from 'react-native';
import { useReducedMotion } from '../design/components';
import { color } from '../design/tokens';

/**
 * Branded launch overlay.
 *
 * Renders pixel-identical layers to the native launch storyboard (same glow
 * and lockup bitmaps, same geometry), so React taking over is invisible — one
 * composition from process start to first screen. The only motion is the glow
 * gently breathing behind the player; the overlay then fades out over the
 * already-rendered first screen.
 */

const GLOW = require('../../assets/brand/splash-glow.png');
const LOCKUP = require('../../assets/brand/splash-lockup.png');

/** Must mirror the storyboard constants exactly. */
const LOCKUP_W = 300;
const LOCKUP_H = 200;
const GLOW_SIZE = 340;
/** Glow centers on the figure, 40pt above the lockup center (storyboard: -40). */
const GLOW_OFFSET_Y = -40;

/** Held even when hydration is instant, so the mark never just blinks. */
const MIN_VISIBLE_MS = 1150;
const EXIT_MS = 380;

export function SplashScreen(props: {
  ready: boolean;
  onFinished: () => void;
}) {
  const reducedMotion = useReducedMotion();
  const { ready, onFinished } = props;

  const breath = useRef(new Animated.Value(0)).current;
  const exit = useRef(new Animated.Value(0)).current;
  const [minElapsed, setMinElapsed] = useState(false);
  const finished = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => setMinElapsed(true), MIN_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (reducedMotion) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(breath, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(breath, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [breath, reducedMotion]);

  useEffect(() => {
    if (!ready || !minElapsed || finished.current) return;
    finished.current = true;
    Animated.timing(exit, {
      toValue: 1,
      duration: reducedMotion ? 0 : EXIT_MS,
      easing: Easing.in(Easing.cubic),
      useNativeDriver: true,
    }).start(() => onFinished());
  }, [exit, minElapsed, onFinished, ready, reducedMotion]);

  return (
    <Animated.View
      pointerEvents="box-only"
      accessible
      accessibilityLabel="Pickle Sensei is starting"
      style={[
        StyleSheet.absoluteFill,
        styles.screen,
        {
          opacity: exit.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
          }),
        },
      ]}
    >
      <StatusBar barStyle="light-content" />
      <Animated.Image
        source={GLOW}
        style={[
          styles.glow,
          {
            opacity: breath.interpolate({
              inputRange: [0, 1],
              outputRange: [1, 0.72],
            }),
            transform: [
              { translateY: GLOW_OFFSET_Y },
              {
                scale: breath.interpolate({
                  inputRange: [0, 1],
                  outputRange: [1, 1.07],
                }),
              },
            ],
          },
        ]}
      />
      <Image source={LOCKUP} style={styles.lockup} resizeMode="contain" />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  screen: {
    backgroundColor: color.surfaceDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: { position: 'absolute', width: GLOW_SIZE, height: GLOW_SIZE },
  lockup: { width: LOCKUP_W, height: LOCKUP_H },
});
