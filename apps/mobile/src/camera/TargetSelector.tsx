import React, { useCallback, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  TouchableWithoutFeedback,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { Button } from '../design/components';
import { color, radius, space, type } from '../design/tokens';

/**
 * "Tap yourself" — product-assisted perception.
 *
 * The hardest inference in the analysis stack is *which person on court is the
 * user*. The user knows the answer, so we ask for it once with a single tap on
 * a still frame from their own capture.
 *
 * The tap is an INITIALIZATION SEED, not a boundary: analysis locks onto the
 * physical person under the tap and then follows them wherever they move
 * (across the centerline, to the kitchen, behind their partner).
 */

export interface TargetSelection {
  /** Normalized image coordinates in [0,1], origin top-left. */
  point: { x: number; y: number };
  selectedAtIso: string;
}

export function TargetSelector(props: {
  /** file:// URI of a still frame (or the clip's poster) to tap on. */
  frameUri: string;
  onConfirm: (selection: TargetSelection) => void;
  onSkip: () => void;
}) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  const handleTap = useCallback(
    (locationX: number, locationY: number) => {
      if (!size || size.width <= 0 || size.height <= 0) return;
      setPoint({
        x: Math.min(1, Math.max(0, locationX / size.width)),
        y: Math.min(1, Math.max(0, locationY / size.height)),
      });
    },
    [size],
  );

  return (
    <View style={styles.wrap}>
      <Text style={[type.h3, styles.title]}>Which player are you?</Text>
      <Text style={[type.caption, styles.subtitle]}>
        Tap yourself once. We'll follow you for the whole clip — even if you
        cross to the other side.
      </Text>

      <TouchableWithoutFeedback
        accessibilityRole="button"
        accessibilityLabel="Tap yourself in the frame"
        onPress={event =>
          handleTap(event.nativeEvent.locationX, event.nativeEvent.locationY)
        }
      >
        <View style={styles.frame} onLayout={onLayout}>
          <Image
            source={{ uri: props.frameUri }}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
          />
          {point && size ? (
            <Svg style={StyleSheet.absoluteFill}>
              <Circle
                cx={point.x * size.width}
                cy={point.y * size.height}
                r={26}
                stroke={color.courtDeep}
                strokeWidth={3}
                fill="rgba(255,255,255,0.18)"
              />
            </Svg>
          ) : null}
        </View>
      </TouchableWithoutFeedback>

      <Text style={[type.micro, styles.status]}>
        {point ? 'Player selected' : 'Tap the player to analyze'}
      </Text>

      <Button
        label="Analyze this player"
        disabled={point === null}
        onPress={() => {
          if (!point) return;
          props.onConfirm({ point, selectedAtIso: new Date().toISOString() });
        }}
      />
      <Button
        label="Skip — pick automatically"
        variant="ghost"
        onPress={props.onSkip}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  title: { color: color.ink },
  subtitle: { color: color.inkSoft },
  frame: {
    width: '100%',
    aspectRatio: 9 / 16,
    maxHeight: 380,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.cameraSurface,
  },
  status: { color: color.inkSoft, textAlign: 'center' },
});
