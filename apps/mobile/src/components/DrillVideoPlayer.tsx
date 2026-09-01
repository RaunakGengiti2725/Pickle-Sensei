import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { useReliableSafeAreaInsets } from '../design/safeArea';
import { color, radius, space, type } from '../design/tokens';
import type {
  EmbeddedInstructionalMedia,
  InstructionalMedia,
} from '../training/types';

/**
 * Full-screen in-app player for a drill's instructional video.
 *
 * YouTube requires every embedded player to identify its embedder through
 * the HTTP Referer header; a request without one is refused with error 153
 * ("Video player configuration error"). A WebView pointed straight at an
 * /embed/ URL sends no referer, so YouTube playback runs through a local
 * HTML shell hosting the official IFrame Player API, loaded with `baseUrl`
 * set to the app's https identity (YouTube's documented referer format for
 * apps: https://<bundle id>). The shell reports player lifecycle events back
 * to React Native.
 *
 * Playback is never a dead end. Every failure automatically falls forward:
 *
 *   1. embed  — referer-correct IFrame API player (autoplay, inline).
 *   2. watch  — any player error (embed-disabled videos, API outages, the
 *               watchdog below) swaps the WebView to the video's canonical
 *               watch page, which YouTube serves without embed restrictions.
 *   3. failed — only if the WebView itself cannot load (e.g. offline): an
 *               explicit error card with retry and an external escape hatch.
 *
 * The creator name and license attribution are always rendered below the
 * player — attribution is a license obligation — and a source link keeps
 * the original page one tap away in every stage.
 */

/**
 * The app's https identity, sent as the embedding referer/origin. YouTube's
 * required-minimum-functionality policy asks API clients to identify
 * themselves as `https://<bundle id>`; this matches PRODUCT_BUNDLE_IDENTIFIER
 * (iOS) and applicationId (Android). Never load a bare /embed/ URL without
 * it — that is exactly what produces error 153.
 */
export const VIDEO_EMBED_REFERER = 'https://com.picklesensei';

/**
 * How long the YouTube shell may stay silent (no ready, no error) before the
 * watch page takes over. Generous enough for slow cell networks; short
 * enough that a wedged player never strands the user on a black box.
 */
export const EMBED_READY_TIMEOUT_MS = 12000;

/** In-app playback stages, in strictly forward order. */
type Stage = 'embed' | 'watch' | 'failed';

function isYoutubeEmbed(
  media: InstructionalMedia,
): media is EmbeddedInstructionalMedia & { provider: 'youtube' } {
  return media.kind === 'embed' && media.provider === 'youtube';
}

/**
 * Local shell for the official YouTube IFrame Player API. The player keeps
 * the server contract's privacy-enhanced host (youtube-nocookie.com) and
 * posts `{ kind: 'ready' }` / `{ kind: 'error', code }` messages so failures
 * can fall forward instead of dead-ending in YouTube's error card.
 */
function youtubeEmbedHtml(videoId: string): string {
  // YouTube ids are strictly [A-Za-z0-9_-]; enforcing that here keeps the
  // interpolation below inert no matter what the server sent.
  const safeId = videoId.replace(/[^0-9A-Za-z_-]/g, '');
  return `<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
  #player { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: 0; }
</style>
</head>
<body>
<div id="player"></div>
<script>
  function send(payload) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(payload));
    }
  }
  window.onYouTubeIframeAPIReady = function () {
    var vars = { playsinline: 1, rel: 0, autoplay: 1 };
    if (window.location.protocol.indexOf('http') === 0) {
      vars.origin = window.location.origin;
    }
    new YT.Player('player', {
      width: '100%',
      height: '100%',
      videoId: ${JSON.stringify(safeId)},
      host: 'https://www.youtube-nocookie.com',
      playerVars: vars,
      events: {
        onReady: function (event) {
          send({ kind: 'ready' });
          event.target.playVideo();
        },
        onError: function (event) {
          send({ kind: 'error', code: event.data });
        }
      }
    });
  };
  var api = document.createElement('script');
  api.src = 'https://www.youtube.com/iframe_api';
  api.onerror = function () { send({ kind: 'error', code: 'api-load-failed' }); };
  document.head.appendChild(api);
</script>
</body>
</html>`;
}

/** The WebView source for a stage. Every request identifies the app. */
function stageSource(media: InstructionalMedia, stage: Stage) {
  if (stage === 'watch') {
    // The provider's canonical watch page: plays even when the owner has
    // disabled embedding, which no embed surface can promise.
    return {
      uri: media.sourceUrl,
      headers: { Referer: VIDEO_EMBED_REFERER },
    };
  }
  if (media.kind === 'embed') {
    if (media.provider === 'youtube') {
      return {
        html: youtubeEmbedHtml(media.videoId),
        baseUrl: VIDEO_EMBED_REFERER,
      };
    }
    return {
      uri: `${media.embedUrl}?playsinline=1`,
      headers: { Referer: VIDEO_EMBED_REFERER },
    };
  }
  return { uri: media.playbackUrl };
}

/** Human name of the original host, used by the source-link affordances. */
function sourceName(media: InstructionalMedia): string {
  if (media.kind === 'embed') {
    return media.provider === 'youtube' ? 'YouTube' : 'Vimeo';
  }
  return 'the original source';
}

export function DrillVideoPlayer(props: {
  media: InstructionalMedia | null;
  onClose: () => void;
}) {
  const { media, onClose } = props;
  const { width, height } = useWindowDimensions();
  const insets = useReliableSafeAreaInsets();
  const [stage, setStage] = useState<Stage>('embed');
  const [embedReady, setEmbedReady] = useState(false);

  // A newly opened video must not inherit the previous one's progress
  // through the fallback ladder.
  const mediaId = media?.id ?? null;
  useEffect(() => {
    setStage('embed');
    setEmbedReady(false);
  }, [mediaId]);

  const youtube = media !== null && isYoutubeEmbed(media);

  // Watchdog: a YouTube shell that never reports ready falls forward to the
  // watch page instead of stranding the user on a black box.
  useEffect(() => {
    if (!youtube || stage !== 'embed' || embedReady) return;
    const timer = setTimeout(() => setStage('watch'), EMBED_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [embedReady, mediaId, stage, youtube]);

  // Any player-level error (embed disabled, video removed, API outage…)
  // falls forward to the watch page.
  const onEmbedMessage = useCallback((event: WebViewMessageEvent) => {
    let payload: { kind?: unknown } | null = null;
    try {
      payload = JSON.parse(event.nativeEvent.data) as { kind?: unknown };
    } catch {
      return;
    }
    if (payload?.kind === 'ready') setEmbedReady(true);
    else if (payload?.kind === 'error') setStage('watch');
  }, []);

  // Main-document load failures step one rung down the ladder: embeds get
  // the watch page, everything else (and the watch page itself) gets the
  // explicit error card.
  const embedKind = media?.kind;
  const onWebViewFailure = useCallback(() => {
    setStage(prev =>
      prev === 'embed' && embedKind === 'embed' ? 'watch' : 'failed',
    );
  }, [embedKind]);

  // HTTP errors also fire for subresources (a watch page's blocked ad call
  // must not kill playback), so only the stage's own document counts.
  const onWebViewHttpError = useCallback(
    (event: { nativeEvent: { url?: string } }) => {
      if (!media) return;
      const mainUrl =
        stage === 'watch'
          ? media.sourceUrl
          : media.kind === 'embed'
          ? media.embedUrl
          : media.playbackUrl;
      const failedUrl = event.nativeEvent.url;
      if (failedUrl && failedUrl.startsWith(mainUrl.split('?')[0] ?? mainUrl)) {
        onWebViewFailure();
      }
    },
    [media, onWebViewFailure, stage],
  );

  const retry = useCallback(() => {
    setEmbedReady(false);
    setStage('embed');
  }, []);

  const openSource = useCallback(() => {
    if (media) void Linking.openURL(media.sourceUrl);
  }, [media]);

  if (!media) return null;

  // 16:9 box that fits both dimensions (landscape included), leaving room
  // for the close button above and the attribution block below.
  const maxBoxWidth = width - space.lg * 2;
  const maxBoxHeight = Math.max(height - insets.top - insets.bottom - 220, 180);
  const boxWidth = Math.min(maxBoxWidth, (maxBoxHeight * 16) / 9);
  const boxHeight = (boxWidth * 9) / 16;

  return (
    <Modal
      visible
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop} testID="drill-video-player">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss video"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <PressableScale
          testID="drill-video-close"
          accessibilityLabel="Close video player"
          onPress={onClose}
          hitSlop={8}
          containerStyle={[
            styles.closeContainer,
            { top: insets.top + space.sm },
          ]}
          style={styles.closeButton}
        >
          <Icon name="close" size={20} color={color.onDark} />
        </PressableScale>
        <View pointerEvents="box-none" style={styles.centerColumn}>
          <View
            style={[styles.playerBox, { width: boxWidth, height: boxHeight }]}
          >
            {stage === 'failed' ? (
              <View style={styles.errorWrap} testID="drill-video-error">
                <Text style={[type.bodyBold, styles.errorTitle]}>
                  This video could not load in the app.
                </Text>
                <PressableScale
                  testID="drill-video-open-source"
                  accessibilityLabel={`Open on ${sourceName(media)}`}
                  onPress={openSource}
                  containerStyle={styles.errorButtonContainer}
                  style={styles.errorButton}
                >
                  <Text style={[type.bodyBold, { color: color.onVolt }]}>
                    {`Open on ${sourceName(media)}`}
                  </Text>
                </PressableScale>
                <PressableScale
                  testID="drill-video-retry"
                  accessibilityLabel="Try loading the video again"
                  onPress={retry}
                  containerStyle={styles.errorButtonContainer}
                  style={styles.retryButton}
                >
                  <Text style={[type.bodyBold, { color: color.onDark }]}>
                    Try again
                  </Text>
                </PressableScale>
              </View>
            ) : (
              <>
                <WebView
                  key={`${media.id}:${stage}`}
                  testID="drill-video-webview"
                  source={stageSource(media, stage)}
                  style={styles.webview}
                  allowsInlineMediaPlayback
                  mediaPlaybackRequiresUserAction={false}
                  javaScriptEnabled
                  domStorageEnabled
                  allowsFullscreenVideo
                  startInLoadingState
                  renderLoading={() => (
                    <View style={styles.loadingWrap}>
                      <ActivityIndicator size="large" color={color.volt} />
                    </View>
                  )}
                  onMessage={onEmbedMessage}
                  onError={onWebViewFailure}
                  onHttpError={onWebViewHttpError}
                />
                {youtube && stage === 'embed' && !embedReady ? (
                  <View
                    pointerEvents="none"
                    style={styles.loadingWrap}
                    testID="drill-video-embed-loading"
                  >
                    <ActivityIndicator size="large" color={color.volt} />
                  </View>
                ) : null}
              </>
            )}
          </View>
          <View style={styles.attributionBlock} pointerEvents="box-none">
            <Text style={[type.bodyBold, styles.creatorName]}>
              {media.creatorName}
            </Text>
            {/* Attribution is a license obligation: always shown verbatim. */}
            <Text style={[type.caption, styles.attribution]}>
              {media.attribution}
            </Text>
            <PressableScale
              testID="drill-video-source-link"
              accessibilityLabel={`Watch on ${sourceName(media)}`}
              onPress={openSource}
              containerStyle={styles.sourceLinkContainer}
              style={styles.sourceLink}
            >
              <Text style={[type.caption, styles.sourceLinkText]}>
                {`Watch on ${sourceName(media)}`}
              </Text>
              <Icon name="arrow" size={14} color={color.volt} />
            </PressableScale>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: color.overlayDeep },
  closeContainer: {
    position: 'absolute',
    right: space.lg,
    width: 44,
    borderRadius: 22,
    zIndex: 2,
  },
  closeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.onDarkTint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerColumn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  playerBox: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: color.surfaceDark,
  },
  webview: { flex: 1, backgroundColor: color.surfaceDark },
  loadingWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceDark,
  },
  errorWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.md,
    padding: space.lg,
  },
  errorTitle: { color: color.onDark, textAlign: 'center' },
  errorButtonContainer: { alignSelf: 'center', borderRadius: radius.pill },
  errorButton: {
    minHeight: 48,
    borderRadius: radius.pill,
    backgroundColor: color.volt,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButton: {
    minHeight: 48,
    borderRadius: radius.pill,
    backgroundColor: color.onDarkTint,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attributionBlock: {
    alignSelf: 'stretch',
    alignItems: 'center',
    marginTop: space.lg,
    paddingHorizontal: space.md,
  },
  creatorName: { color: color.onDark, textAlign: 'center' },
  attribution: {
    color: color.onDarkMuted,
    textAlign: 'center',
    marginTop: space.xs,
  },
  sourceLinkContainer: { alignSelf: 'center', marginTop: space.sm },
  sourceLink: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: space.sm,
  },
  sourceLinkText: { color: color.volt },
});
