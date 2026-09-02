import React from 'react';
import {
  Image,
  StyleSheet,
  UIManager,
  View,
  requireNativeComponent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

/**
 * Inline player for the on-device captured clip.
 *
 * Backed by the PickleClipPlayerView native view (AVPlayer on iOS,
 * MediaPlayer on Android) rendering REAL frames from the private capture
 * file. On builds without the native view (or in tests) it degrades to the
 * clip's poster still — never a fabricated frame.
 */

interface ClipProgressEvent {
  nativeEvent: { positionMs: number };
}

interface ClipLoadEvent {
  nativeEvent: { durationMs: number };
}

/** How the video fills its view: 'cover' crops to fill (the replay card
 * default), 'contain' letterboxes so every pixel — and every overlay drawn
 * in video coordinates — stays visible. */
export type ClipResizeMode = 'cover' | 'contain';

interface NativeClipPlayerProps {
  sourceUri: string;
  playing: boolean;
  /** Seek request in clip ms; negative means "no request". */
  seekMs: number;
  resizeMode: ClipResizeMode;
  /** Playback rate; 1 is real time, 0.5 / 0.25 are slow motion. */
  rate: number;
  style?: StyleProp<ViewStyle>;
  onClipProgress?: (event: ClipProgressEvent) => void;
  onClipLoad?: (event: ClipLoadEvent) => void;
  onClipEnd?: () => void;
}

const NATIVE_COMPONENT = 'PickleClipPlayerView';

const NativeClipPlayer = (() => {
  try {
    const config = UIManager.getViewManagerConfig?.(NATIVE_COMPONENT);
    return config != null
      ? requireNativeComponent<NativeClipPlayerProps>(NATIVE_COMPONENT)
      : null;
  } catch {
    return null;
  }
})();

/** True when this build can render real video frames in-app. */
export function clipPlaybackAvailable(): boolean {
  return NativeClipPlayer !== null;
}

/** Rates the native players accept; anything else falls back to real time. */
function sanitizeRate(rate: number | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
    ? rate
    : 1;
}

export function ClipPlayer(props: {
  uri: string;
  posterUri?: string;
  playing: boolean;
  seekMs: number;
  /** Defaults to 'cover' — the historical replay-card behavior. */
  resizeMode?: ClipResizeMode;
  /** Defaults to 1 (real time). */
  rate?: number;
  onProgress?: (positionMs: number) => void;
  onLoad?: (durationMs: number) => void;
  onEnd?: () => void;
}) {
  const resizeMode: ClipResizeMode = props.resizeMode ?? 'cover';
  if (!NativeClipPlayer) {
    // Honest degradation: the real poster still (when one was captured)
    // or the dark camera surface. No synthetic frames.
    return props.posterUri ? (
      <Image
        source={{ uri: props.posterUri }}
        resizeMode={resizeMode}
        style={StyleSheet.absoluteFill}
        accessibilityLabel="Captured clip poster"
      />
    ) : (
      <View style={StyleSheet.absoluteFill} />
    );
  }
  return (
    <NativeClipPlayer
      sourceUri={props.uri}
      playing={props.playing}
      seekMs={props.seekMs}
      resizeMode={resizeMode}
      rate={sanitizeRate(props.rate)}
      style={StyleSheet.absoluteFill}
      onClipProgress={event => props.onProgress?.(event.nativeEvent.positionMs)}
      onClipLoad={event => props.onLoad?.(event.nativeEvent.durationMs)}
      onClipEnd={() => props.onEnd?.()}
    />
  );
}
