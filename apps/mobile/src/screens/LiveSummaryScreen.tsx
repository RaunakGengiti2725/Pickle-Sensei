import React, { useEffect, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  LoadingState,
  Pill,
  ScreenHeader,
  SectionTitle,
  Stat,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import {
  CLOSE_REASON_LABEL,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  formatSessionClock,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventView,
} from '../flow/session';
import type { RootStackParams } from '../navigation/params';

interface StoredSummary {
  validReps: number;
  lowConfidenceReps: number;
  startScore: number | null;
  endScore: number | null;
  bestScore: number | null;
  focusCheckpoint: string;
  focusStart: number | null;
  focusEnd: number | null;
  cuesSpoken: number;
}

const EVENT_STATE_PILL: Record<
  SessionEventView['state'],
  { label: string; tone: 'neutral' | 'good' | 'warn' | 'volt' | 'dark' }
> = {
  pending: { label: 'PENDING', tone: 'neutral' },
  processing: { label: 'PROCESSING', tone: 'volt' },
  ready: { label: 'READY', tone: 'good' },
  abstained: { label: 'ABSTAINED', tone: 'warn' },
};

/** Session summary straight from the engine snapshot (MOBBIN brief §3.1):
 * duration, stroke count, count-only technique distribution, per-event
 * states — and an honest account of what was NOT analyzed. */
function EngineSessionSummary(props: {
  snapshot: LiveSessionSnapshot;
  onClose: () => void;
  onOpenAnalysis: (analysisId: string) => void;
}) {
  const { snapshot } = props;
  const pendingCount = snapshot.events.filter(
    event => event.state === 'pending',
  ).length;
  const readyCount = snapshot.events.filter(
    event => event.state === 'ready',
  ).length;
  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader title="Session summary" onClose={props.onClose} />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Card tone="dark" style={styles.hero}>
          <View style={styles.heroTop}>
            <Pill label="SESSION COMPLETE" tone="volt" />
            <Icon name="check" size={24} color={color.volt} />
          </View>
          <Text
            style={[type.hero, { color: color.onDark, marginTop: space.xl }]}
          >
            {snapshot.strokeCount === 1
              ? '1 stroke,'
              : `${snapshot.strokeCount} strokes,`}
            {`\n`}segmented live.
          </Text>
          <Text
            style={[
              type.body,
              { color: color.onDarkSubtle, marginTop: space.sm },
            ]}
          >
            Recording never stopped — each event closed on its own evidence
            {snapshot.source === 'replay'
              ? ' (recorded-rally replay, not a live camera).'
              : '.'}
          </Text>
        </Card>

        <View style={styles.statsCard}>
          <Stat
            value={formatSessionClock(snapshot.durationMs)}
            label="session time"
          />
          <View style={styles.statDivider} />
          <Stat
            value={String(snapshot.strokeCount)}
            label="stroke events"
            accent
          />
          <View style={styles.statDivider} />
          <Stat value={String(readyCount)} label="analyzed" />
        </View>

        <SectionTitle title="Technique mix" />
        <Card style={styles.blockCard}>
          <View style={styles.chipsRow}>
            {snapshot.distribution.length === 0 ? (
              <Text style={[type.body, { color: color.inkSoft }]}>
                No stroke events were detected in this session.
              </Text>
            ) : (
              snapshot.distribution.map(chip => (
                <Pill
                  key={chip.label}
                  label={`${chip.label.toUpperCase()} · ${chip.count}`}
                  tone={chip.family === null ? 'neutral' : 'good'}
                />
              ))
            )}
          </View>
          <Text
            style={[
              type.caption,
              { color: color.inkSoft, marginTop: space.md },
            ]}
          >
            Counts only — techniques are never ranked against each other, and
            unclassified strokes are counted, not hidden.
          </Text>
        </Card>

        <SectionTitle title="Events" />
        <Card style={styles.blockCard}>
          {snapshot.events.map((event, index) => {
            const analysisId =
              event.state === 'ready' && event.analysis !== null
                ? event.analysis.id
                : null;
            const row = (
              <>
                <Text style={[type.bodyBold, { color: color.ink, width: 42 }]}>
                  {event.eventId}
                </Text>
                <View style={{ flex: 1 }}>
                  <Text style={[type.caption, { color: color.ink }]}>
                    {formatSessionClock(event.startMs)}–
                    {formatSessionClock(event.endMs)} ·{' '}
                    {CLOSE_REASON_LABEL[event.closeReason]}
                  </Text>
                  {event.boundaryUncertain ? (
                    <Text
                      style={[type.micro, { color: color.warn, marginTop: 2 }]}
                    >
                      BOUNDS UNCERTAIN — SESSION ENDED MID-MOTION
                    </Text>
                  ) : null}
                </View>
                <Pill
                  label={EVENT_STATE_PILL[event.state].label}
                  tone={EVENT_STATE_PILL[event.state].tone}
                />
                {analysisId !== null ? (
                  <Icon name="chevron" size={16} color={color.inkSoft} />
                ) : null}
              </>
            );
            const rowStyle = [
              styles.eventRow,
              index === 0 && ({ borderTopWidth: 0 } as const),
            ];
            return analysisId !== null ? (
              <Pressable
                key={event.eventId}
                style={rowStyle}
                accessibilityRole="button"
                accessibilityLabel={`Open analysis for event ${event.eventId}`}
                onPress={() => props.onOpenAnalysis(analysisId)}
              >
                {row}
              </Pressable>
            ) : (
              <View key={event.eventId} style={rowStyle}>
                {row}
              </View>
            );
          })}
          {snapshot.events.length === 0 ? (
            <Text style={[type.body, { color: color.inkSoft }]}>
              The engine stayed on for the whole session and closed nothing — no
              motion crossed the stroke-proposal floor.
            </Text>
          ) : null}
        </Card>

        {pendingCount > 0 ? (
          <Card tone="soft" style={{ marginTop: space.md }}>
            <Text style={[type.bodyBold, { color: color.ink }]}>
              Why{' '}
              {pendingCount === snapshot.strokeCount
                ? 'every'
                : `${pendingCount}`}{' '}
              event{pendingCount === 1 ? ' is' : 's are'} still pending
            </Text>
            <Text
              style={[
                type.caption,
                { color: color.inkSoft, marginTop: space.sm },
              ]}
            >
              {snapshot.events.some(
                event =>
                  event.pendingReason === NATIVE_CLIP_EXTRACTION_NOT_BUILT,
              )
                ? 'This build cannot cut per-event video or pose data for a ' +
                  'single stroke yet, so no analysis ran. The segmentation ' +
                  'above is real; scores and techniques were not invented ' +
                  'to fill the gap.'
                : 'Per-event analysis has not completed for these events.'}
            </Text>
          </Card>
        ) : null}

        {snapshot.qualityNotes.length > 0 ? (
          <>
            <SectionTitle title="Engine notes" />
            <Card style={styles.blockCard}>
              {snapshot.qualityNotes.map(note => (
                <Text
                  key={note}
                  style={[type.caption, { color: color.inkSoft, marginTop: 4 }]}
                >
                  {note}
                </Text>
              ))}
            </Card>
          </>
        ) : null}

        <View style={styles.actions}>
          <Button label="Back to Home" variant="dark" onPress={props.onClose} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

export function LiveSummaryScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, 'LiveSummary'>>();
  const [summary, setSummary] = useState<StoredSummary | null | undefined>(
    undefined,
  );
  // Engine-run sessions (Live Court session mode) register their final
  // snapshot in memory; legacy rep-loop sessions store a summary row in the
  // local DB. The engine snapshot wins when present.
  const engineSession = getCompletedSession(route.params.sessionId);

  useEffect(() => {
    if (engineSession) return;
    getDb()
      .execute(`SELECT summary FROM local_session WHERE id = ?`, [
        route.params.sessionId,
      ])
      .then(({ rows }) => {
        const raw = rows[0]?.['summary'];
        setSummary(raw ? (JSON.parse(String(raw)) as StoredSummary) : null);
      })
      .catch(() => setSummary(null));
  }, [route.params.sessionId, engineSession]);

  if (engineSession) {
    return (
      <EngineSessionSummary
        snapshot={engineSession}
        onClose={() => navigation.popToTop()}
        onOpenAnalysis={analysisId =>
          navigation.navigate('Result', { analysisId })
        }
      />
    );
  }

  if (summary === undefined) {
    return (
      <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Session summary"
          onClose={() => navigation.popToTop()}
        />
        <LoadingState label="Wrapping up the session…" />
      </SafeAreaView>
    );
  }

  const focusDelta =
    summary?.focusStart != null && summary?.focusEnd != null
      ? Math.round((summary.focusEnd - summary.focusStart) * 10) / 10
      : null;
  const scoreDelta =
    summary?.startScore != null && summary?.endScore != null
      ? Math.round((summary.endScore - summary.startScore) * 10) / 10
      : null;

  return (
    <SafeAreaView edges={['top', 'bottom']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader
        title="Session summary"
        onClose={() => navigation.popToTop()}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <Card tone="dark" style={styles.hero}>
          <View style={styles.heroTop}>
            <Pill label="SESSION COMPLETE" tone="volt" />
            <Icon name="check" size={24} color={color.volt} />
          </View>
          <Text
            style={[type.hero, { color: color.onDark, marginTop: space.xl }]}
          >
            Good work.{`\n`}Keep the cue.
          </Text>
          <Text
            style={[
              type.body,
              { color: color.onDarkSubtle, marginTop: space.sm },
            ]}
          >
            Progress comes from making the same useful correction easier to
            repeat.
          </Text>
        </Card>

        {summary === null ? (
          <Card tone="soft" style={{ marginTop: space.md }}>
            <Text style={[type.body, { color: color.inkSoft }]}>
              This session ended safely, but its detailed summary is
              unavailable.
            </Text>
          </Card>
        ) : (
          <>
            <View style={styles.statsCard}>
              <Stat value={String(summary.validReps)} label="scored reps" />
              <View style={styles.statDivider} />
              <Stat
                value={summary.bestScore?.toFixed(1) ?? '—'}
                label="best read"
                accent
              />
              <View style={styles.statDivider} />
              <Stat value={String(summary.cuesSpoken)} label="cues spoken" />
            </View>

            <SectionTitle title="What changed" />
            <Card style={styles.changeCard}>
              <View style={styles.changeTop}>
                <View>
                  <Text style={[type.micro, { color: color.inkSoft }]}>
                    SESSION SCORE
                  </Text>
                  <Text
                    style={[
                      type.h1,
                      {
                        color: color.ink,
                        marginTop: space.sm,
                        fontVariant: ['tabular-nums'],
                      },
                    ]}
                  >
                    {summary.startScore?.toFixed(1) ?? '—'}{' '}
                    <Text style={{ color: color.inkSoft }}>→</Text>{' '}
                    {summary.endScore?.toFixed(1) ?? '—'}
                  </Text>
                </View>
                {scoreDelta !== null ? (
                  <Pill
                    label={`${scoreDelta >= 0 ? '+' : ''}${scoreDelta}`}
                    tone={scoreDelta >= 0 ? 'good' : 'warn'}
                  />
                ) : null}
              </View>
              <View style={styles.focusChange}>
                <View style={styles.focusIcon}>
                  <Icon name="spark" size={18} color={color.court} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[type.micro, { color: color.inkSoft }]}>
                    FOCUS MOVEMENT
                  </Text>
                  <Text
                    style={[
                      type.h3,
                      {
                        color: color.ink,
                        textTransform: 'capitalize',
                        marginTop: 4,
                      },
                    ]}
                  >
                    {summary.focusCheckpoint.replace(/_/g, ' ')}
                  </Text>
                </View>
                <Text
                  style={[
                    type.h2,
                    {
                      color:
                        focusDelta != null && focusDelta >= 0
                          ? color.good
                          : color.ink,
                      fontVariant: ['tabular-nums'],
                    },
                  ]}
                >
                  {focusDelta === null
                    ? '—'
                    : `${focusDelta >= 0 ? '+' : ''}${focusDelta}`}
                </Text>
              </View>
              {summary.lowConfidenceReps > 0 ? (
                <Text
                  style={[
                    type.caption,
                    { color: color.inkSoft, marginTop: space.md },
                  ]}
                >
                  {summary.lowConfidenceReps} rep
                  {summary.lowConfidenceReps === 1 ? '' : 's'} stayed unscored
                  because the camera read was not reliable.
                </Text>
              ) : null}
            </Card>

            <SectionTitle title="Next session" />
            <View style={styles.nextCard}>
              <View style={styles.nextNumber}>
                <Text style={[type.micro, { color: color.onVolt }]}>01</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    type.h3,
                    { color: color.onDark, textTransform: 'capitalize' },
                  ]}
                >
                  {summary.focusCheckpoint.replace(/_/g, ' ')}
                </Text>
                <Text
                  style={[
                    type.caption,
                    { color: color.onDarkSubtle, marginTop: 4 },
                  ]}
                >
                  Keep the focus. Make the movement automatic.
                </Text>
              </View>
            </View>
          </>
        )}

        <View style={styles.actions}>
          <Button
            label="Back to Home"
            variant="dark"
            onPress={() => navigation.popToTop()}
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xl,
  },
  hero: { minHeight: 285, justifyContent: 'center' },
  heroTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  statsCard: {
    minHeight: 104,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: color.surfaceElevated,
    borderRadius: radius.lg,
    padding: space.lg,
    marginTop: 12,
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    height: 50,
    backgroundColor: color.line,
    marginHorizontal: space.md,
  },
  blockCard: { padding: space.lg },
  chipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  eventRow: {
    minHeight: 52,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  changeCard: { padding: space.lg },
  changeTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  focusChange: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  focusIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nextCard: {
    minHeight: 96,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.courtDeep,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  nextNumber: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actions: { marginTop: space.xl },
});
