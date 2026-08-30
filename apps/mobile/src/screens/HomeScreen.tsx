import React, { useCallback, useMemo, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LinearGradient from 'react-native-linear-gradient';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  BrandMark,
  Card,
  ErrorState,
  LoadingState,
  Pill,
  PressableScale,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { useAppStore } from '../state/appStore';
import { getDb } from '../data/db';
import {
  listCaptureHistory,
  listShots,
  type CaptureHistoryEntry,
  type LocalShotRow,
} from '../data/repository';
import type { RootStackParams } from '../navigation/params';
import { getApiSession } from '../account/apiSession';
import {
  fetchCanonicalProgress,
  type CanonicalProgress,
} from '../progress/api';
import { buildPracticeHistory } from '../progress/practiceHistory';
import { PracticeVolumeChart } from '../progress/PracticeVolumeChart';
import { PlayerRankBanner } from '../components/PlayerRankBanner';

function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function formatTrackedTime(milliseconds: number) {
  const seconds = milliseconds / 1_000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function HomeScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(s => s.profile);
  const [recent, setRecent] = useState<LocalShotRow[]>([]);
  const [allShots, setAllShots] = useState<LocalShotRow[]>([]);
  const [latestScored, setLatestScored] = useState<LocalShotRow | null>(null);
  const [captures, setCaptures] = useState<CaptureHistoryEntry[]>([]);
  const [asOfIso, setAsOfIso] = useState(() => new Date().toISOString());
  const [canonicalProgress, setCanonicalProgress] =
    useState<CanonicalProgress | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const db = getDb();
      const [shots, captureHistory] = await Promise.all([
        listShots(db, 250),
        listCaptureHistory(db, null),
      ]);
      setRecent(shots.slice(0, 5));
      setAllShots(shots);
      setLatestScored(
        shots.find(
          shot => shot.resultKind === 'scored' && shot.overallScore !== null,
        ) ?? null,
      );
      setCaptures(captureHistory);
      setAsOfIso(new Date().toISOString());
      const apiSession = getApiSession();
      if (apiSession) {
        try {
          const progress = await fetchCanonicalProgress(apiSession);
          setCanonicalProgress(progress);
        } catch {
          setCanonicalProgress(null);
        }
      } else {
        setCanonicalProgress(null);
      }
      setLoadError(null);
    } catch {
      setLoadError(
        'Your saved reads could not be opened. Try again to load your real court history.',
      );
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const timeZone = useMemo(deviceTimeZone, []);
  const practice = useMemo(
    () =>
      buildPracticeHistory(captures, {
        asOfIso,
        timeZone,
        range: '7d',
      }),
    [asOfIso, captures, timeZone],
  );
  const latestSynced = canonicalProgress?.series.reduce<
    CanonicalProgress['series'][number] | null
  >(
    (latest, point) =>
      !latest || new Date(point.day) > new Date(latest.day) ? point : latest,
    null,
  );
  const displayedScore =
    latestScored?.overallScore ?? latestSynced?.avgScore ?? null;
  const displayedStroke = latestScored
    ? latestScored.shotType.replace(/_/g, ' ')
    : latestSynced
      ? `${latestSynced.shotType.replace(/_/g, ' ')} daily average`
      : null;
  const focus = profile?.focusCheckpoint
    ? profile.focusCheckpoint.replace(/_/g, ' ')
    : null;

  if (!loaded) return <LoadingState label="Loading your court…" />;

  if (loadError) {
    return (
      <ErrorState
        title="Your court couldn’t load"
        detail={loadError}
        onRetry={() => {
          setLoadError(null);
          setLoaded(false);
          void load();
        }}
      />
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            tintColor={color.court}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load().finally(() => setRefreshing(false));
            }}
          />
        }
      >
        <View style={styles.topBar}>
          <BrandMark />
          <View style={styles.topBadges}>
            <Pill
              label={
                profile?.skillLevel
                  ? `SELF · ${profile.skillLevel}`
                  : 'NEW PLAYER'
              }
              tone="neutral"
            />
            <View
              accessibilityLabel={`${practice.currentStreak} day automatic capture streak`}
              style={styles.streakBadge}
            >
              <Icon name="flame" color={color.flame} size={17} />
              <Text style={[type.caption, styles.streakValue]}>
                {practice.currentStreak}
              </Text>
            </View>
          </View>
        </View>

        <PlayerRankBanner
          shots={allShots}
          streakDays={practice.currentStreak}
          onPress={() => navigation.navigate('Tabs', { screen: 'Performance' })}
        />

        <Text style={[type.h1, styles.welcome]}>Ready when you are.</Text>

        {/* Two analysis modes. Stroke Analysis is the flagship: one movement,
            deepest feedback, zero-touch capture. Session Analysis follows a
            full live session with many strokes. */}
        <View style={styles.modeRow}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Stroke Analysis. Analyze one movement with fast, detailed feedback."
            containerStyle={styles.modeCardSlot}
            style={[styles.modeCardShell, styles.modeCardPrimary]}
            onPress={() => navigation.navigate('Analyze', { source: 'camera' })}
          >
            <LinearGradient
              colors={[color.courtDeep, color.surfaceDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 0.9, y: 1 }}
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
            />
            <View style={styles.modeCardInner}>
              <View style={styles.modeCardTop}>
                <View style={[styles.modeIconChip, styles.modeIconChipDark]}>
                  <Icon name="camera" color={color.volt} size={20} />
                </View>
                <Icon name="arrow" color={color.onDarkMuted} size={17} />
              </View>
              <View>
                <Text style={[type.bodyBold, styles.modeTitleDark]}>
                  Stroke Analysis
                </Text>
                <Text style={[type.caption, styles.modeCaptionDark]}>
                  One movement, deep feedback
                </Text>
              </View>
            </View>
          </PressableScale>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Session Analysis. Follow a live session with multiple strokes."
            containerStyle={styles.modeCardSlot}
            style={[styles.modeCardShell, styles.modeCardSecondary]}
            onPress={() => navigation.navigate('LiveCourt')}
          >
            <View style={styles.modeCardInner}>
              <View style={styles.modeCardTop}>
                <View style={[styles.modeIconChip, styles.modeIconChipLight]}>
                  <Icon name="court" color={color.courtDeep} size={20} />
                </View>
                <Icon name="arrow" color={color.inkSoft} size={17} />
              </View>
              <View>
                <Text style={[type.bodyBold, styles.modeTitleLight]}>
                  Session Analysis
                </Text>
                <Text style={[type.caption, styles.modeCaptionLight]}>
                  Rallies, stroke by stroke
                </Text>
              </View>
            </View>
          </PressableScale>
        </View>

        <View style={styles.practiceCard}>
          <LinearGradient
            colors={[color.courtDeep, color.surfaceDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.practiceCardTop}>
            <View style={{ flex: 1 }}>
              <Text style={[type.micro, { color: color.volt }]}>THIS WEEK</Text>
              <Text style={[type.caption, styles.practiceCardSource]}>
                Verified automatic camera captures
              </Text>
            </View>
            <Pill label="ON DEVICE" tone="dark" />
          </View>
          {practice.captureCount === 0 ? (
            <View style={styles.practiceZeroStage}>
              <View style={styles.practiceZeroIcon}>
                <Icon name="spark" color={color.volt} size={20} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={[type.h3, styles.practiceZeroTitle]}>
                  Your court is ready.
                </Text>
                <Text style={[type.caption, styles.practiceZeroCopy]}>
                  The first verified capture starts this record.
                </Text>
              </View>
            </View>
          ) : (
            <View style={styles.practiceCountRow}>
              <Text style={styles.practiceCount}>{practice.captureCount}</Text>
              <Text style={[type.h3, styles.practiceCountLabel]}>
                camera {practice.captureCount === 1 ? 'capture' : 'captures'}
              </Text>
            </View>
          )}
          <PracticeVolumeChart
            activeDays={practice.activeDays}
            buckets={practice.buckets}
            rangeLabel="Seven day"
          />
          <View style={styles.practiceFooter}>
            <View style={styles.practiceFooterItem}>
              <Text style={styles.practiceFooterValue}>
                {practice.activeDays}
              </Text>
              <Text style={styles.practiceFooterLabel}>active days</Text>
            </View>
            <View style={styles.practiceFooterDivider} />
            <View style={styles.practiceFooterItem}>
              <Text style={styles.practiceFooterValue}>
                {formatTrackedTime(practice.trackedDurationMs)}
              </Text>
              <Text style={styles.practiceFooterLabel}>pose tracked</Text>
            </View>
            <View style={styles.practiceFooterDivider} />
            <View style={styles.practiceFooterItem}>
              <Text style={styles.practiceFooterValue}>
                {practice.currentStreak}
              </Text>
              <Text style={styles.practiceFooterLabel}>day streak</Text>
            </View>
          </View>
        </View>

        <SectionTitle title="Latest technique" />
        <Card tone="soft" style={styles.techniqueSummary}>
          <View style={styles.techniqueSummaryIcon}>
            <Icon
              name={displayedScore === null ? 'lock' : 'progress'}
              color={color.court}
              size={21}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[type.bodyBold, styles.techniqueSummaryTitle]}>
              {displayedStroke ?? 'No scored technique yet'}
            </Text>
            <Text style={[type.caption, styles.techniqueSummaryCopy]}>
              {displayedScore === null
                ? 'Camera practice still counts. Scores appear only after validated analysis.'
                : latestScored
                  ? 'Latest validated scored stroke on this device'
                  : 'Latest synced daily average'}
            </Text>
          </View>
          <Text style={styles.techniqueSummaryScore}>
            {displayedScore === null ? '—' : displayedScore.toFixed(1)}
          </Text>
        </Card>

        {focus ? (
          <>
            <SectionTitle title="Chosen focus" />
            <View
              accessibilityLabel={`Self-selected focus: ${focus}`}
              style={styles.focusCard}
            >
              <View style={styles.focusIndex}>
                <Text style={[type.micro, { color: color.onVolt }]}>01</Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    type.h2,
                    { color: color.onDark, textTransform: 'capitalize' },
                  ]}
                >
                  {focus}
                </Text>
                <Text
                  style={[
                    type.caption,
                    { color: color.onDarkMuted, marginTop: 5 },
                  ]}
                >
                  Your onboarding choice. A reviewed plan can replace it after a
                  validated scored read.
                </Text>
              </View>
              <View style={styles.focusStatus}>
                <Text style={[type.micro, { color: color.onVolt }]}>
                  SELF SET
                </Text>
              </View>
            </View>
          </>
        ) : null}

        <SectionTitle
          title="Recent reads"
          right={
            recent.length ? (
              <Text style={[type.caption, { color: color.court }]}>
                {recent.length} latest
              </Text>
            ) : undefined
          }
        />
        {recent.length === 0 ? (
          <Card tone="soft" style={styles.emptyRecent}>
            <View style={styles.emptyIcon}>
              <Icon name="camera" color={color.court} size={21} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.bodyBold, { color: color.ink }]}>
                Your first read starts here
              </Text>
              <Text
                style={[type.caption, { color: color.inkSoft, marginTop: 3 }]}
              >
                Set the phone once. Pickle Sensei guides the rest.
              </Text>
            </View>
          </Card>
        ) : (
          recent.map(shot => (
            <PressableScale
              key={shot.id}
              accessibilityLabel={`Open ${shot.shotType.replace(
                /_/g,
                ' ',
              )} result`}
              onPress={() =>
                navigation.navigate('Result', { analysisId: shot.id })
              }
              style={styles.recentCard}
            >
              <View style={styles.recentDate}>
                <Text style={[type.micro, { color: color.inkSoft }]}>
                  {new Date(shot.capturedAt)
                    .toLocaleDateString(undefined, {
                      month: 'short',
                      day: 'numeric',
                    })
                    .toUpperCase()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={[
                    type.bodyBold,
                    { color: color.ink, textTransform: 'capitalize' },
                  ]}
                >
                  {shot.shotType.replace(/_/g, ' ')}
                </Text>
                <Text
                  style={[type.caption, { color: color.inkSoft, marginTop: 2 }]}
                >
                  {new Date(shot.capturedAt).toLocaleTimeString(undefined, {
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              <Text style={[type.score, styles.recentScore]}>
                {shot.overallScore === null
                  ? '—'
                  : shot.overallScore.toFixed(1)}
              </Text>
              <Icon name="chevron" color={color.inkSoft} size={17} />
            </PressableScale>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  modeRow: { flexDirection: 'row', gap: space.sm + 2, marginTop: space.sm },
  // Row layout must live on PressableScale's OUTER container (containerStyle):
  // the inner Pressable's flex cannot size the wrapper, which previously let
  // the two mode cards overflow the screen edge.
  modeCardSlot: { flex: 1 },
  modeCardShell: {
    flex: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  modeCardPrimary: { backgroundColor: color.courtDeep },
  modeCardSecondary: {
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  modeCardInner: {
    flex: 1,
    minHeight: 148,
    padding: space.md,
    justifyContent: 'space-between',
    gap: space.md,
  },
  modeCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modeIconChip: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  modeIconChipDark: { backgroundColor: color.onDarkTint },
  modeIconChipLight: { backgroundColor: color.courtSoft },
  modeTitleDark: { color: color.onDark },
  modeCaptionDark: { color: color.onDarkSubtle, marginTop: 2 },
  modeTitleLight: { color: color.ink },
  modeCaptionLight: { color: color.inkSoft, marginTop: 2 },
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    paddingBottom: space.xxxl + 28,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  topBadges: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  streakBadge: {
    height: 32,
    minWidth: 48,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  streakValue: { color: color.ink, fontVariant: ['tabular-nums'] },
  welcome: { color: color.ink, marginTop: space.xl, marginBottom: space.lg },
  practiceCard: {
    marginTop: space.md,
    borderRadius: radius.xl,
    padding: space.lg,
    backgroundColor: color.surfaceDark,
    overflow: 'hidden',
  },
  practiceZeroStage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.lg,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
  },
  practiceZeroIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.12)',
  },
  practiceZeroTitle: { color: color.onDark },
  practiceZeroCopy: { color: color.onDarkSubtle, marginTop: 2 },
  practiceCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  practiceCardSource: { color: color.onDarkSubtle, marginTop: 4 },
  practiceCountRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 11,
    marginTop: space.lg,
  },
  practiceCount: {
    ...type.display,
    color: color.onDark,
    fontSize: 64,
    lineHeight: 66,
  },
  practiceCountLabel: { color: color.onDark, paddingBottom: 7 },
  practiceFooter: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: space.lg,
    paddingTop: space.md,
    paddingBottom: 4,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineMutedDark,
  },
  practiceFooterItem: { flex: 1, alignItems: 'center' },
  practiceFooterDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.lineMutedDark,
    marginHorizontal: space.sm,
  },
  practiceFooterValue: {
    ...type.h3,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  practiceFooterLabel: {
    ...type.caption,
    color: color.onDarkFaint,
    marginTop: 2,
    textAlign: 'center',
  },
  techniqueSummary: {
    minHeight: 100,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  techniqueSummaryIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  techniqueSummaryTitle: { color: color.ink, textTransform: 'capitalize' },
  techniqueSummaryCopy: { color: color.inkSoft, marginTop: 3 },
  techniqueSummaryScore: {
    ...type.score,
    color: color.ink,
    fontSize: 30,
    lineHeight: 34,
  },
  scoreCard: { padding: space.lg, minHeight: 358 },
  scoreCardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
  },
  scoreStage: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space.md,
  },
  scoreFooter: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  scoreFooterItem: { flex: 1 },
  scoreDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.lineDark,
    marginHorizontal: space.md,
  },
  scoreMeta: {
    ...type.bodyBold,
    color: color.onDark,
    textTransform: 'capitalize',
  },
  scoreMetaLabel: { ...type.caption, color: color.onDarkFaint, marginTop: 2 },
  focusCard: {
    minHeight: 112,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceDark,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  focusIndex: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  focusStatus: {
    minHeight: 28,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.volt,
  },
  emptyRecent: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  emptyIcon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  recentCard: {
    minHeight: 76,
    borderRadius: radius.md,
    backgroundColor: color.surfaceElevated,
    paddingHorizontal: space.md,
    marginBottom: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  recentDate: { width: 38 },
  recentScore: {
    color: color.ink,
    fontSize: 25,
    lineHeight: 29,
    marginLeft: 2,
  },
});
