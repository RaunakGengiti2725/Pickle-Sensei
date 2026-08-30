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
import { Icon } from '../design/icons';
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
  /** Normalized SOURCE-image coordinates in [0,1], origin top-left. */
  point: { x: number; y: number };
  selectedAtIso: string;
}

export interface CoverTransform {
  /** Uniform scale applied to the source so it covers the view. */
  scale: number;
  /** Scaled-source pixels cropped off the left edge (>= 0). */
  offsetX: number;
  /** Scaled-source pixels cropped off the top edge (>= 0). */
  offsetY: number;
}

/**
 * The transform `resizeMode="cover"` applies: uniform scale up to the larger
 * of the two axis ratios, then a centered crop of the overflow. Pure math so
 * the tap → source mapping is unit-testable without a renderer.
 */
export function coverTransform(
  view: { width: number; height: number },
  source: { width: number; height: number },
): CoverTransform {
  const scale = Math.max(
    view.width / source.width,
    view.height / source.height,
  );
  return {
    scale,
    offsetX: (source.width * scale - view.width) / 2,
    offsetY: (source.height * scale - view.height) / 2,
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Converts a tap in VIEW pixels into normalized SOURCE-image coordinates
 * (origin top-left, clamped to [0,1]) by inverting the cover transform.
 * Without real source dimensions there is nothing honest to invert, so the
 * point falls back to plain view-normalization (the pre-poster behavior).
 */
export function viewPointToSourcePoint(
  tap: { x: number; y: number },
  view: { width: number; height: number },
  source: { width: number; height: number } | null,
): { x: number; y: number } {
  if (
    !source ||
    !Number.isFinite(source.width) ||
    !Number.isFinite(source.height) ||
    source.width <= 0 ||
    source.height <= 0
  ) {
    return { x: clamp01(tap.x / view.width), y: clamp01(tap.y / view.height) };
  }
  const { scale, offsetX, offsetY } = coverTransform(view, source);
  return {
    x: clamp01((tap.x + offsetX) / (source.width * scale)),
    y: clamp01((tap.y + offsetY) / (source.height * scale)),
  };
}

export function TargetSelector(props: {
  /** file:// URI of a still frame (or the clip itself) to tap on. */
  frameUri: string;
  /** Preferred still-frame poster (file: URI) when the capture carries one. */
  posterUri?: string;
  /** Real pixel dimensions of the SOURCE image/video. When present, taps are
   * mapped through the cover-crop transform into source coordinates; when
   * absent, taps stay view-normalized exactly as before. */
  sourceWidth?: number;
  sourceHeight?: number;
  onConfirm: (selection: TargetSelection) => void;
  onSkip: () => void;
}) {
  // `view` is where the ring renders (what the user touched, in view px);
  // `source` is what analysis consumes (normalized source coordinates).
  const [tap, setTap] = useState<{
    view: { x: number; y: number };
    source: { x: number; y: number };
  } | null>(null);
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null,
  );
  const [previewFailed, setPreviewFailed] = useState(false);

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    setSize({ width, height });
  }, []);

  const { sourceWidth, sourceHeight } = props;
  const handleTap = useCallback(
    (locationX: number, locationY: number) => {
      if (!size || size.width <= 0 || size.height <= 0) return;
      const view = {
        x: Math.min(size.width, Math.max(0, locationX)),
        y: Math.min(size.height, Math.max(0, locationY)),
      };
      const source =
        sourceWidth !== undefined && sourceHeight !== undefined
          ? { width: sourceWidth, height: sourceHeight }
          : null;
      setTap({
        view,
        source: viewPointToSourcePoint(view, size, source),
      });
    },
    [size, sourceWidth, sourceHeight],
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
          {previewFailed ? (
            // Honest placeholder: the preview could not be decoded, so say
            // so instead of leaving a silent black frame under the tap.
            <View style={styles.previewFallback}>
              <Icon name="person" color={color.onDarkMuted} size={34} />
              <Text style={[type.caption, styles.previewFallbackCopy]}>
                Preview unavailable — tap where you are in the video
              </Text>
            </View>
          ) : (
            <Image
              source={{ uri: props.posterUri ?? props.frameUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
              onError={() => setPreviewFailed(true)}
            />
          )}
          {tap && size ? (
            <Svg style={StyleSheet.absoluteFill}>
              <Circle
                cx={tap.view.x}
                cy={tap.view.y}
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
        {tap ? 'Player selected' : 'Tap the player to analyze'}
      </Text>

      <Button
        label="Analyze this player"
        disabled={tap === null}
        onPress={() => {
          if (!tap) return;
          props.onConfirm({
            point: tap.source,
            selectedAtIso: new Date().toISOString(),
          });
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
  previewFallback: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.lg,
  },
  previewFallbackCopy: { color: color.onDarkMuted, textAlign: 'center' },
  status: { color: color.inkSoft, textAlign: 'center' },
});
