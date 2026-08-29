import React, { useEffect, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Button, Card, Pill, ScreenHeader } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import {
  CLOSE_REASON_LABEL,
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  createPendingStubAnalysisProvider,
  formatSessionClock,
  nativeSessionMotionFeedAvailability,
  timelineSegments,
  type LiveSessionSnapshot,
  type SessionEventView,
  type TechniqueFamily,
} from '../flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionAnalysisProvider,
  createNativeSessionEventClipSource,
  type SessionMotionFeedConnection,
} from '../flow/sessionNative';
import {
  startSessionCapture,
  stopSessionCapture,
} from '../camera/capture';
import { getDb } from '../data/db';
import { getApiSession } from '../account/apiSession';
import { useAppStore } from '../state/appStore';
import { makeUuid } from '../util/uuid';
import type { RootStackParams } from '../navigation/params';

/**
 * LIVE COURT — session mode UI (MOBBIN brief §3), driven by the canonical
 * SessionEventEngine through LiveSessionFlow. Honest states throughout:
 *  - when the native session capture surface exists, sessions run LIVE:
 *    continuous wrist-motion samples stream in and each closed event's clip
 *    is cut from the rolling recording and analyzed (declared-null AUTO);
 *  - without it (Gap 1 unavailable), sessions run as a clearly labeled
 *    replay of a recorded dev rally, never presented as live, and every
 *    event card keeps its honest PENDING state — no fake scores.
 */

const FAMILY_COLOR: Record<TechniqueFamily, string> = {
  drive: color.volt,
  dink: color.mint,
  volley: color.flame,
  serve: color.court,
  return: color.courtSoft,
  drop: color.good,
  reset: color.onDarkMuted,
  overhead: color.warn,
  speedup: color.badSoft,
};

function familyColor(family: TechniqueFamily | null): string {
  return family === null ? color.lineStrongDark : FAMILY_COLOR[family];
}

const STATE_PILL: Record<
  SessionEventView['state'],
  { label: string; tone: 'neutral' | 'good' | 'warn' | 'volt' | 'dark' }
> = {
  pending: { label: 'PENDING', tone: 'dark' },
  processing: { label: 'PROCESSING', tone: 'volt' },
  ready: { label: 'READY', tone: 'good' },
  abstained: { label: 'ABSTAINED', tone: 'warn' },
};

function SetupGraphic() {
  return (
    <View style={styles.setupGraphic}>
      <Svg width="100%" height="100%" viewBox="0 0 340 205">
        <Rect
          x="70"
          y="30"
          width="58"
          height="105"
          rx="12"
          fill="none"
          stroke={color.onDark}
          strokeWidth="2"
        />
        <Circle cx="99" cy="46" r="4" fill={color.volt} />
        <Line
          x1="34"
          y1="158"
          x2="306"
          y2="158"
          stroke={color.lineDark}
          strokeWidth="2"
        />
        <Line
          x1="170"
          y1="158"
          x2="170"
          y2="112"
          stroke={color.lineDark}
          strokeWidth="2"
        />
        <Path d="M139 158h62l-15-30h-32Z" fill={color.courtDeep} />
        <Path
          d="M205 126c10-35 30-57 61-68M217 134c13-25 31-41 54-48M230 142c12-15 25-25 40-30"
          stroke={color.volt}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
        <Path
          d="m260 51 8 7-10 3"
          stroke={color.volt}
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
      <View style={styles.distancePill}>
        <Text style={[type.micro, { color: color.onDark }]}>
          8–10 FT · SIDE VIEW
        </Text>
      </View>
    </View>
  );
}

function SetupRow(props: {
  icon: 'camera' | 'spark' | 'lock';
  label: string;
  value: string;
  status: 'ready' | 'blocked';
}) {
  return (
    <View style={styles.setupRow}>
      <View style={styles.setupRowIcon}>
        <Icon name={props.icon} size={18} color={color.volt} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[type.micro, { color: color.onDarkFaint }]}>
          {props.label}
        </Text>
        <Text style={[type.bodyBold, { color: color.onDark, marginTop: 2 }]}>
          {props.value}
        </Text>
      </View>
      <Pill
        label={props.status === 'ready' ? 'READY' : 'BLOCKED'}
        tone={props.status === 'ready' ? 'volt' : 'warn'}
      />
    </View>
  );
}

/** Horizontal event timeline: stroke-family colored segments on the session
 * time axis (MOBBIN §3.2). Unclassified events use a neutral segment. */
function TimelineStrip(props: { snapshot: LiveSessionSnapshot }) {
  const segments = timelineSegments(
    props.snapshot.events,
    props.snapshot.durationMs,
  );
  return (
    <View>
      <View style={styles.timelineTrack} accessibilityLabel="Event timeline">
        {segments.map(segment => (
          <View
            key={segment.eventId}
            style={[
              styles.timelineSegment,
              {
                left: `${segment.startFraction * 100}%`,
                width: `${Math.max(
                  1.5,
                  (segment.endFraction - segment.startFraction) * 100,
                )}%`,
                backgroundColor: familyColor(segment.family),
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.timelineScale}>
        <Text style={[type.micro, { color: color.onDarkFaint }]}>0:00</Text>
        <Text style={[type.micro, { color: color.onDarkFaint }]}>
          {formatSessionClock(props.snapshot.durationMs)}
        </Text>
      </View>
    </View>
  );
}

function EventCard(props: {
  event: SessionEventView;
  expanded: boolean;
  onToggle: () => void;
  onOpenAnalysis: (analysisId: string) => void;
}) {
  const { event } = props;
  const statePill = STATE_PILL[event.state];
  const canOpenAnalysis = event.state === 'ready' && event.analysis !== null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Stroke event ${event.index + 1}, ${statePill.label.toLowerCase()}`}
      onPress={() => {
        if (canOpenAnalysis && event.analysis) {
          props.onOpenAnalysis(event.analysis.id);
        } else {
          props.onToggle();
        }
      }}
      style={styles.eventCard}
      testID={`session-event-${event.eventId}`}
    >
      <View style={styles.eventTop}>
        <View
          style={[
            styles.eventBadge,
            { borderColor: familyColor(event.family) },
          ]}
        >
          <Text style={[type.micro, { color: color.onDark }]}>
            {event.eventId}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[type.bodyBold, { color: color.onDark }]}>
            {event.family
              ? event.family.charAt(0).toUpperCase() + event.family.slice(1)
              : 'Stroke event'}
          </Text>
          <Text style={[type.caption, { color: color.onDarkSubtle }]}>
            {formatSessionClock(event.startMs)}–{formatSessionClock(event.endMs)}
            {' · '}
            {Math.round(event.durationMs)}ms ·{' '}
            {CLOSE_REASON_LABEL[event.closeReason]}
          </Text>
        </View>
        <Pill label={statePill.label} tone={statePill.tone} />
        {canOpenAnalysis ? (
          <Icon name="arrow" size={16} color={color.onDarkFaint} />
        ) : null}
      </View>
      {event.boundaryUncertain || event.retroSuppressed ? (
        <View style={styles.eventFlags}>
          {event.boundaryUncertain ? (
            <Pill label="BOUNDS UNCERTAIN · STOPPED MID-MOTION" tone="warn" />
          ) : null}
          {event.retroSuppressed ? (
            <Pill label="WEAK VS LATER STROKES" tone="dark" />
          ) : null}
        </View>
      ) : null}
      {event.state === 'pending' ? (
        <Text style={[type.caption, styles.eventNote]}>
          {event.pendingReason === NATIVE_CLIP_EXTRACTION_NOT_BUILT
            ? 'Waiting on per-event video: this build cannot cut a clip for one stroke yet, so no analysis ran. Nothing was scored or guessed.'
            : 'Analysis has not started for this event yet.'}
        </Text>
      ) : null}
      {event.state === 'abstained' && event.abstainReason ? (
        <Text style={[type.caption, styles.eventNote]}>
          Analysis abstained: {event.abstainReason}
        </Text>
      ) : null}
      {props.expanded ? (
        <View style={styles.eventDetail}>
          <DetailRow
            label="MOVEMENT WINDOW"
            value={`${Math.round(event.startMs)}–${Math.round(event.endMs)}ms`}
          />
          <DetailRow
            label="PEAK WRIST SPEED"
            value={`${event.peakSpeed.toFixed(2)} u/s at ${Math.round(event.peakMs)}ms`}
          />
          <DetailRow
            label="PADDLE CONFIRMED"
            value={event.paddleConfirmed ? 'Yes' : 'No'}
          />
          <DetailRow
            label="CLOSED"
            value={`${Math.round(event.closedAtMs)}ms (${CLOSE_REASON_LABEL[event.closeReason].toLowerCase()})`}
          />
          <Text
            style={[type.micro, { color: color.onDarkFaint, marginTop: space.sm }]}
          >
            MEASURED SEGMENTATION EVIDENCE — MOTION IS NORMALIZED UNITS, NOT
            PHYSICAL SPEED
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function DetailRow(props: { label: string; value: string }) {
  return (
    <View style={styles.detailRow}>
      <Text style={[type.micro, { color: color.onDarkFaint }]}>
        {props.label}
      </Text>
      <Text style={[type.caption, { color: color.onDark }]}>{props.value}</Text>
    </View>
  );
}

export function LiveCourtScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [snapshot, setSnapshot] = useState<LiveSessionSnapshot | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<string | null>(null);
  const flowRef = useRef<LiveSessionFlow | null>(null);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const motionFeed = useRef<SessionMotionFeedConnection | null>(null);
  const sessionCaptureId = useRef<string | null>(null);
  const [liveStartError, setLiveStartError] = useState<string | null>(null);
  const profile = useAppStore(s => s.profile);
  const liveFeed = nativeSessionMotionFeedAvailability();

  useEffect(
    () => () => {
      if (replayTimer.current) clearInterval(replayTimer.current);
      motionFeed.current?.disconnect();
      const activeCapture = sessionCaptureId.current;
      if (activeCapture) void stopSessionCapture(activeCapture).catch(() => {});
    },
    [],
  );

  const startLiveSession = async () => {
    setLiveStartError(null);
    let captureId: string;
    try {
      captureId = (await startSessionCapture()).sessionCaptureId;
    } catch (error) {
      setLiveStartError(
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    sessionCaptureId.current = captureId;
    const apiSession = getApiSession();
    const flow = new LiveSessionFlow({
      sessionId: makeUuid(),
      source: 'live',
      startedAtIso: new Date().toISOString(),
      provider: createNativeSessionAnalysisProvider({
        db: getDb(),
        apiConfig: {
          baseUrl: apiSession?.apiBaseUrl ?? '',
          token: apiSession?.bearerToken ?? null,
        },
        appVersion: '0.1.0',
        handedness: profile?.handedness ?? 'right',
        cameraView: 'side',
      }),
      clipSource: createNativeSessionEventClipSource(captureId),
      onUpdate: next => setSnapshot(next),
    });
    flowRef.current = flow;
    setExpandedEventId(null);
    setSnapshot(flow.snapshot());
    motionFeed.current = connectNativeSessionMotionFeed(flow, {
      sessionCaptureId: captureId,
    });
  };

  const startReplaySession = () => {
    if (replayTimer.current) clearInterval(replayTimer.current);
    const flow = new LiveSessionFlow({
      sessionId: makeUuid(),
      source: 'replay',
      startedAtIso: new Date().toISOString(),
      provider: createPendingStubAnalysisProvider(),
      onUpdate: next => setSnapshot(next),
    });
    flowRef.current = flow;
    setExpandedEventId(null);
    setSnapshot(flow.snapshot());
    // Real-time pacing on the recorded sample clock: events appear exactly
    // when the engine closes them — progressive, append-only arrival.
    const startedAt = Date.now();
    let cursor = 0;
    replayTimer.current = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      while (cursor < DEV_REPLAY_RALLY.samples.length) {
        const sample = DEV_REPLAY_RALLY.samples[cursor];
        if (!sample || sample.tMs > elapsedMs) break;
        flow.pushSample(sample);
        cursor += 1;
      }
      if (cursor >= DEV_REPLAY_RALLY.samples.length && replayTimer.current) {
        clearInterval(replayTimer.current);
        replayTimer.current = null;
      }
    }, 33);
  };

  const endSession = () => {
    if (replayTimer.current) {
      clearInterval(replayTimer.current);
      replayTimer.current = null;
    }
    motionFeed.current?.disconnect();
    motionFeed.current = null;
    const activeCapture = sessionCaptureId.current;
    sessionCaptureId.current = null;
    if (activeCapture) void stopSessionCapture(activeCapture).catch(() => {});
    const flow = flowRef.current;
    if (!flow) return;
    const final = flow.end();
    flowRef.current = null;
    setSnapshot(null);
    navigation.navigate('LiveSummary', { sessionId: final.sessionId });
  };

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScreenHeader
        dark
        title="Live Court"
        onClose={() => navigation.goBack()}
        right={
          snapshot ? <Pill label="REPLAY · DEV RALLY" tone="volt" /> : undefined
        }
      />
      {snapshot === null ? (
        <ScrollView
          contentContainerStyle={styles.setupContent}
          showsVerticalScrollIndicator={false}
        >
          <Text style={[type.hero, { color: color.onDark }]}>
            Sessions are{`\n`}segmented now.
          </Text>
          <Text
            style={[
              type.body,
              { color: color.onDarkSubtle, marginTop: space.sm },
            ]}
          >
            The session engine splits continuous play into stroke events —
            E1, E2, E3 — while recording never stops.{' '}
            {liveFeed.available
              ? 'This build streams live wrist motion and analyzes each event from the rolling recording.'
              : 'Live camera streaming is not built in this build, so you can watch it run on a recorded rally.'}
          </Text>
          <SetupGraphic />
          <Card tone="dark" style={styles.setupCard}>
            <SetupRow
              icon="spark"
              label="SESSION ENGINE"
              value="Replay-validated"
              status="ready"
            />
            <SetupRow
              icon="camera"
              label="LIVE WRIST-SPEED STREAM"
              value={
                liveFeed.available
                  ? 'Native session capture'
                  : 'Not built in this build'
              }
              status={liveFeed.available ? 'ready' : 'blocked'}
            />
            <SetupRow
              icon="lock"
              label="PER-EVENT ANALYSIS"
              value={
                liveFeed.available
                  ? 'Clips cut from rolling recording'
                  : 'Needs per-event clips'
              }
              status={liveFeed.available ? 'ready' : 'blocked'}
            />
          </Card>
          {liveFeed.available ? (
            <Button
              label="Start live session"
              variant="volt"
              icon="play"
              onPress={() => void startLiveSession()}
            />
          ) : null}
          {liveStartError !== null ? (
            <Text style={[type.caption, { color: color.warn }]}>
              Could not start the native session capture: {liveStartError}
            </Text>
          ) : null}
          <Button
            label="Replay a recorded rally"
            variant={liveFeed.available ? 'dark' : 'volt'}
            icon="play"
            onPress={startReplaySession}
          />
          <View style={styles.trustNote}>
            <Icon name="shield" size={17} color={color.onDarkFaint} />
            <Text style={styles.setupDisclosure}>
              {liveFeed.available ? '' : liveFeed.detail} The replay uses the
              recorded rally “{DEV_REPLAY_RALLY.runId}” (dev split) and is
              always labeled as a replay. No camera opens and nothing is
              scored.
            </Text>
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.sessionContent}
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.statsRow}>
            <View style={styles.statCell}>
              <Text style={[type.score, { color: color.onDark }]}>
                {formatSessionClock(snapshot.durationMs)}
              </Text>
              <Text style={[type.caption, { color: color.onDarkSubtle }]}>
                session time
              </Text>
            </View>
            <View style={styles.statDivider} />
            <View style={styles.statCell}>
              <Text style={[type.score, { color: color.volt }]}>
                {snapshot.strokeCount}
              </Text>
              <Text style={[type.caption, { color: color.onDarkSubtle }]}>
                stroke events
              </Text>
            </View>
          </View>
          <View style={styles.chipsRow}>
            {snapshot.distribution.length === 0 ? (
              <Pill label="LISTENING FOR STROKES…" tone="dark" />
            ) : (
              snapshot.distribution.map(chip => (
                <Pill
                  key={chip.label}
                  label={`${chip.label.toUpperCase()} · ${chip.count}`}
                  tone={chip.family === null ? 'dark' : 'volt'}
                />
              ))
            )}
          </View>
          <TimelineStrip snapshot={snapshot} />
          <View style={styles.eventList}>
            {snapshot.events.length === 0 ? (
              <Card tone="dark" style={styles.emptyEvents}>
                <Text style={[type.body, { color: color.onDarkSubtle }]}>
                  Events appear here the moment the engine closes them —
                  play continues while earlier strokes are segmented.
                </Text>
              </Card>
            ) : (
              snapshot.events.map(event => (
                <EventCard
                  key={event.eventId}
                  event={event}
                  expanded={expandedEventId === event.eventId}
                  onToggle={() =>
                    setExpandedEventId(current =>
                      current === event.eventId ? null : event.eventId,
                    )
                  }
                  onOpenAnalysis={analysisId =>
                    navigation.navigate('Result', { analysisId })
                  }
                />
              ))
            )}
          </View>
          <Button label="End session" variant="volt" onPress={endSession} />
          <View style={styles.trustNote}>
            <Icon name="shield" size={17} color={color.onDarkFaint} />
            <Text style={styles.setupDisclosure}>
              Every event above is real segmentation from the session engine
              on the recorded rally. Per-event video analysis is not built in
              this build, so events stay Pending — no score or technique is
              invented.
            </Text>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  setupContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  sessionContent: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
    paddingBottom: space.xl,
  },
  setupGraphic: {
    height: 205,
    borderRadius: radius.xl,
    backgroundColor: color.inkElevated,
    marginTop: space.lg,
    overflow: 'hidden',
  },
  distancePill: {
    position: 'absolute',
    right: 14,
    bottom: 13,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceDark,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  setupCard: { marginVertical: 12, paddingVertical: 4 },
  setupRow: {
    minHeight: 67,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineDark,
  },
  setupRowIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: color.surfaceDark,
    alignItems: 'center',
    justifyContent: 'center',
  },
  trustNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'center',
    gap: space.sm,
    marginTop: space.md,
    paddingHorizontal: space.sm,
  },
  setupDisclosure: {
    ...type.caption,
    flex: 1,
    color: color.onDarkDisabled,
  },
  statsRow: {
    minHeight: 96,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.inkElevated,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
  statCell: { flex: 1 },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 46,
    backgroundColor: color.lineDark,
    marginHorizontal: space.md,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.md,
  },
  timelineTrack: {
    height: 34,
    borderRadius: radius.sm,
    backgroundColor: color.inkElevated,
    marginTop: space.md,
    overflow: 'hidden',
  },
  timelineSegment: {
    position: 'absolute',
    top: 5,
    bottom: 5,
    borderRadius: 6,
    minWidth: 4,
  },
  timelineScale: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: space.xs,
  },
  eventList: { marginTop: space.md, marginBottom: space.md, gap: space.sm },
  emptyEvents: { minHeight: 88, justifyContent: 'center' },
  eventCard: {
    borderRadius: radius.md,
    backgroundColor: color.inkElevated,
    padding: space.md,
  },
  eventTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  eventBadge: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventFlags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginTop: space.sm,
  },
  eventNote: { color: color.onDarkSubtle, marginTop: space.sm },
  eventDetail: {
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 28,
  },
});
