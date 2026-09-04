/**
 * `react-native-video` alias. Renders the MP4 in a <video> element (muted,
 * paused at a mid frame) and drives the callbacks the SplashScreen depends on
 * from the scenario's `video` mode:
 *   'progress' — fires onLoad then onProgress(currentTime=1.5) so the Skip
 *                control becomes visible (SKIP_AFTER_S = 1).
 *   'error'    — fires onError immediately (missing/corrupt asset path).
 *   'stall'    — never fires anything (watchdog path).
 */
import React, { useEffect, useRef } from "react";
import { View } from "./react-native";

export interface OnProgressData {
  currentTime: number;
  playableDuration: number;
  seekableDuration: number;
}

export type VideoMode = "progress" | "error" | "stall";

let mode: VideoMode = "progress";
export function __setVideoMode(next: VideoMode): void {
  mode = next;
}

function Video(props: {
  source?: unknown;
  style?: unknown;
  testID?: string;
  onLoad?: (event: unknown) => void;
  onProgress?: (event: OnProgressData) => void;
  onEnd?: () => void;
  onError?: (event: unknown) => void;
}) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (mode === "error") {
      if (ref.current) ref.current.dataset.uxVideoState = "error-forced";
      props.onError?.({ error: { code: "ux-audit-forced" } });
      return;
    }
    if (mode === "stall") return;
    const timer = setTimeout(() => {
      props.onLoad?.({ duration: 4 });
      props.onProgress?.({
        currentTime: 1.5,
        playableDuration: 4,
        seekableDuration: 4,
      });
    }, 30);
    return () => clearTimeout(timer);
  }, []);
  const uri =
    typeof props.source === "string"
      ? props.source
      : ((props.source as { uri?: string } | undefined)?.uri ?? "");
  return (
    <View testID={props.testID} style={props.style as never}>
      <video
        ref={ref}
        src={uri}
        muted
        playsInline
        preload="auto"
        data-ux-video={uri}
        onLoadedData={(event) => {
          const el = event.currentTarget;
          if (!el.dataset.uxVideoState) el.dataset.uxVideoState = "loaded";
          try {
            el.currentTime = Math.min(1.5, el.duration || 1.5);
          } catch {
            // Seeking is best effort for the screenshot only.
          }
        }}
        onError={(event) => {
          event.currentTarget.dataset.uxVideoState = "error";
        }}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "contain",
          display: "block",
        }}
      />
    </View>
  );
}

export default Video;
