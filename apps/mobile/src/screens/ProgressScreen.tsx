import React, { useCallback, useMemo, useState } from 'react';
import {
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import LinearGradient from 'react-native-linear-gradient';
import { SHOT_TYPES } from '@pickle/shared-types';
import {
  Card,
  ErrorState,
  LoadingState,
  Pill,
  PressableScale,
  TrendChart,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import {
  listCaptureHistory,
  listRealAnalysisFacts,
  type CaptureHistoryEntry,
  type RealAnalysisFact,
} from '../data/repository';
import { useAppStore } from '../state/appStore';
import { getApiSession } from '../account/apiSession';
import {
  fetchCanonicalProgress,
  type CanonicalProgress,
} from '../progress/api';
import {
  buildPracticeHistory,
  isVerifiedPracticeCapture,
  PRACTICE_HISTORY_RANGES,
  type PracticeHistoryRangeKey,
} from '../progress/practiceHistory';
import {
  MATCH_RATING_ESTIMATE_NOTE,
  formatMatchRatingEstimate,
} from '../progress/matchRatingEstimate';
import { DashSectionHeader } from '../progress/DashSectionHeader';
import { PracticeSetCard } from '../progress/PracticeSetCard';
import { latestPracticeSet } from '../progress/practiceSetProgress';
import { PracticeVolumeChart } from '../progress/PracticeVolumeChart';
import { ScoreTrendChart } from '../progress/ScoreTrendChart';
import { StatDeltaRow } from '../progress/StatDeltaRow';
import {
  buildTechniqueDashboard,
  formatSignedDelta,
  vsPriorLabel,
} from '../progress/techniqueDashboard';
import { PlayerRankCard } from '../components/PlayerRankCard';
import { AchievementsShowcase } from '../consistency/AchievementsShowcase';
import { ConsistencyCard } from '../consistency/ConsistencyCard';
import { useConsistencyStore } from '../consistency/store';
import type { RootStackParams } from '../navigation/params';
import { plural } from '../util/plural';

/**
 * PROGRESS — a WHOOP-style dark performance dashboard (MOBBIN: WHOOP
 * overview/recovery statistics, Strava progress). Every number keeps this
 * page's founding rule: practice activity and technique scores stay separate,
 * comparisons only exist when a real prior window exists, and nothing is
 * interpolated. The dopamine comes from honest deltas, not invented ones.
 */

type ProgressSection = 'practice' | 'technique';

const RANGE_LABELS: Record<PracticeHistoryRangeKey, string> = {
  '7d': '7D',
  '28d': '4W',
  '90d': '3M',
};

function average(values: number[]) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function spread(values: number[]) {
  const mean = average(values);
  if (mean === null || values.length < 2) return null;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function signed(value: number) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`;
}

function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function makeDayFormatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

function dayKey(value: string, formatter: Intl.DateTimeFormat) {
  // A corrupt timestamp must exclude the row, never crash the screen:
  // formatToParts throws a RangeError on an Invalid Date. The empty string
  // sorts below every real day key, so range filters drop the fact.
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(new Date(parsed))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

function formatTrackedTime(milliseconds: number) {
  const seconds = milliseconds / 1_000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = Math.round(seconds % 60);
  return `${minutes}m ${remaining}s`;
}

/** Calendar day ("2026-08-30") → short label ("Aug 30") in the device zone. */
function shortDayLabel(day: string) {
  const parsed = new Date(`${day}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export function percent(value: number | null) {
  if (value === null) return '—';
  // Defensive display clamp: a rate can only be 0–100%, so out-of-range
  // input never renders as an impossible percentage.
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

export function displayCaptureTitle(capture: CaptureHistoryEntry) {
  const recognition = capture.clip?.recognition;
  if (recognition?.status === 'recognized') {
    return recognition.shotType.replace(/_/g, ' ');
  }
  // The user's own declaration is the next-best honest label (imports carry
  // no live recognition at all); it is their statement, never a prediction.
  if (capture.declaredStroke) return capture.declaredStroke.replace(/_/g, ' ');
  return 'Practice clip';
}

/** Row detail: how the clip got here and what it measures. */
export function captureSourceDetail(capture: CaptureHistoryEntry) {
  const seconds = (capture.durationMs / 1_000).toFixed(1);
  return capture.clip?.captureMode === 'imported_video'
    ? `${seconds}s imported clip · pose sequence measured`
    : `${seconds}s saved clip · ${Math.round(capture.fps)} recorded fps`;
}

/** Discloses stored clips the chart refuses to count; empty when none. */
export function excludedCapturesNote(count: number) {
  if (count <= 0) return null;
  return `${count} saved ${plural(count, 'clip')} without measured pose evidence ${
    count === 1 ? 'is' : 'are'
  } not counted.`;
}

/** Count-correct label for a stroke card's comparison basis. */
function basisLabel(count: number, basis: 'daily averages' | 'scored reads') {
  return basis === 'daily averages'
    ? plural(count, 'daily average', 'daily averages')
    : plural(count, 'scored read', 'scored reads');
}

function EvidenceMetric(props: {
  label: string;
  value: number | null;
  detail: string;
}) {
  return (
    <View
      accessibilityLabel={`${props.label}: ${percent(props.value)}. ${
        props.detail
      }`}
      style={styles.evidenceMetric}
    >
      <Text style={[type.micro, styles.evidenceLabel]}>{props.label}</Text>
      <Text style={styles.evidenceValue}>{percent(props.value)}</Text>
      <View style={styles.evidenceTrack}>
        {props.value !== null ? (
          <View
            style={[
              styles.evidenceFill,
              { width: `${Math.max(0, Math.min(100, props.value * 100))}%` },
            ]}
          />
        ) : null}
      </View>
      <Text style={[type.caption, styles.evidenceDetail]}>{props.detail}</Text>
    </View>
  );
}

export function ProgressScreen() {
  const { width } = useWindowDimensions();
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(state => state.profile);
  const consistency = useConsistencyStore(state => state.snapshot);
  const refreshConsistency = useConsistencyStore(state => state.refresh);
  const timeZone = useMemo(deviceTimeZone, []);
  const dayFormatter = useMemo(() => makeDayFormatter(timeZone), [timeZone]);
  const [section, setSection] = useState<ProgressSection>('technique');
  const [range, setRange] = useState<PracticeHistoryRangeKey>('28d');
  const [captures, setCaptures] = useState<CaptureHistoryEntry[]>([]);
  const [facts, setFacts] = useState<RealAnalysisFact[]>([]);
  const [canonical, setCanonical] = useState<CanonicalProgress | null>(null);
  const [asOfIso, setAsOfIso] = useState(() => new Date().toISOString());
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      void (async () => {
        try {
          const db = getDb();
          const apiSession = getApiSession();
          const [localFacts, localCaptures, accountProgress] =
            await Promise.all([
              listRealAnalysisFacts(db, null),
              listCaptureHistory(db, null),
              apiSession
                ? fetchCanonicalProgress(apiSession).catch(() => null)
                : Promise.resolve(null),
            ]);
          if (!active) return;
          setFacts(localFacts);
          setCaptures(localCaptures);
          setCanonical(accountProgress);
          setAsOfIso(new Date().toISOString());
          setLoadError(null);
        } catch {
          if (!active) return;
          setLoadError(
            'Your saved camera history could not be opened. No empty values were substituted.',
          );
        } finally {
          if (active) setLoaded(true);
        }
      })();
      void refreshConsistency();
      return () => {
        active = false;
      };
    }, [loadRevision, refreshConsistency]),
  );

  const practice = useMemo(
    () => buildPracticeHistory(captures, { asOfIso, timeZone, range }),
    [asOfIso, captures, range, timeZone],
  );
  const dashboard = useMemo(
    () => buildTechniqueDashboard(facts, { asOfIso, timeZone, range }),
    [asOfIso, facts, range, timeZone],
  );
  // The sitting the player just had: shown only when it holds two or more
  // comparable reads landed within the last day (nothing older masquerades
  // as "this set"). Independent of the selected range on purpose.
  const practiceSet = useMemo(
    () => latestPracticeSet(facts, { asOfIso }),
    [asOfIso, facts],
  );
  const selectedDefinition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === range,
  )!;
  const selectedStartDay = practice.buckets[0]?.key ?? '9999-12-31';
  const selectedEndDay = practice.buckets.at(-1)?.key ?? '0000-01-01';
  const factDays = useMemo(
    () => facts.map(fact => dayKey(fact.capturedAt, dayFormatter)),
    [dayFormatter, facts],
  );
  const selectedFacts = useMemo(
    () =>
      facts.filter((_, index) => {
        const day = factDays[index]!;
        return day >= selectedStartDay && day <= selectedEndDay;
      }),
    [factDays, facts, selectedEndDay, selectedStartDay],
  );
  const selectedSeries = useMemo(
    () =>
      canonical?.series.filter(
        point => point.day >= selectedStartDay && point.day <= selectedEndDay,
      ),
    [canonical, selectedEndDay, selectedStartDay],
  );
  const latestLocal = useMemo(
    () =>
      facts.find(
        fact => fact.resultKind === 'scored' && fact.overallScore !== null,
      ) ?? null,
    [facts],
  );
  const latestSynced = useMemo(
    () =>
      canonical?.series.reduce<CanonicalProgress['series'][number] | null>(
        (latest, point) => (!latest || point.day > latest.day ? point : latest),
        null,
      ),
    [canonical],
  );
  const latestScore =
    latestLocal?.overallScore ?? latestSynced?.avgScore ?? null;
  const latestLabel = latestLocal
    ? latestLocal.shotType.replace(/_/g, ' ')
    : latestSynced
      ? `${latestSynced.shotType.replace(/_/g, ' ')} daily average`
      : null;

  const byShot = useMemo(() => {
    return SHOT_TYPES.map(shotType => {
      const syncedForShot = (selectedSeries ?? [])
        .filter(point => point.shotType === shotType)
        .sort((left, right) => left.day.localeCompare(right.day));
      if (syncedForShot.length) {
        const newest = syncedForShot.at(-1)!;
        const comparable = syncedForShot.filter(
          point => point.scoringModelVersion === newest.scoringModelVersion,
        );
        const points = comparable.map(point => point.avgScore);
        return {
          shotType,
          points,
          movement: points.length >= 2 ? points.at(-1)! - points[0]! : null,
          spread: spread(points.slice(-10)),
          repCount: comparable.reduce((sum, point) => sum + point.shotCount, 0),
          basis: 'daily averages' as const,
        };
      }
      const allForShot = selectedFacts.filter(
        fact => fact.shotType === shotType,
      );
      const newest = allForShot[0];
      if (!newest) return null;
      const comparable = allForShot
        .filter(
          fact =>
            fact.resultKind === 'scored' &&
            fact.overallScore !== null &&
            fact.scoringModelVersion === newest.scoringModelVersion &&
            fact.shotConfigVersion === newest.shotConfigVersion,
        )
        .reverse();
      const points = comparable.map(fact => fact.overallScore as number);
      return {
        shotType,
        points,
        movement: points.length >= 2 ? points.at(-1)! - points[0]! : null,
        spread: spread(points.slice(-10)),
        repCount: points.length,
        basis: 'scored reads' as const,
      };
    }).filter((item): item is NonNullable<typeof item> => Boolean(item));
  }, [selectedFacts, selectedSeries]);

  // The SAME rule the aggregation applies, so the list and the count can
  // never disagree about what is verified practice.
  const eligibleRecentCaptures = useMemo(
    () => captures.filter(isVerifiedPracticeCapture).slice(0, 4),
    [captures],
  );
  const excludedNote = excludedCapturesNote(practice.excludedCaptureCount);
  const previousCaptureCount =
    practice.captureCount - practice.priorPeriodDelta.captureCount;
  const comparisonCopy =
    previousCaptureCount === 0
      ? practice.captureCount === 0
        ? 'Your first verified capture starts this chart.'
        : 'First measured period on this device.'
      : `${practice.priorPeriodDelta.captureCount >= 0 ? '+' : ''}${
          practice.priorPeriodDelta.captureCount
        } captures versus the prior ${selectedDefinition.label.toLowerCase()}.`;
  const chartWidth = Math.max(210, Math.min(292, width - 112));

  // Prior-window values for the WHOOP-style practice rows. A first measured
  // period (zero prior captures) hides every comparison instead of faking 0s.
  const practiceHasPrior = previousCaptureCount > 0;
  const previousActiveDays =
    practice.activeDays - practice.priorPeriodDelta.activeDays;
  const previousTrackedMs =
    practice.trackedDurationMs - practice.priorPeriodDelta.trackedDurationMs;
  // Pose duration is guided-camera instrumentation. With no camera capture
  // in the window there is nothing measured — "—", never a fabricated 0.0s.
  const hasCameraEvidence = practice.cameraCaptureCount > 0;
  const trackedTimeCopy = hasCameraEvidence
    ? formatTrackedTime(practice.trackedDurationMs)
    : '—';

  const reps = dashboard.scoredReps;
  const repsDelta =
    reps.previous === null ? null : reps.current - reps.previous;
  const scoredDays = dashboard.scoredDays;
  const scoredDaysDelta =
    scoredDays.previous === null
      ? null
      : scoredDays.current - scoredDays.previous;
  const avgScore = dashboard.avgScore;
  const avgDelta =
    avgScore.current !== null && avgScore.previous !== null
      ? avgScore.current - avgScore.previous
      : null;
  const bestScore = dashboard.bestScore;
  const bestDelta =
    bestScore.current !== null && bestScore.previous !== null
      ? bestScore.current - bestScore.previous
      : null;

  if (!loaded) return <LoadingState dark label="Loading measured progress…" />;

  if (loadError) {
    return (
      <ErrorState
        dark
        title="Progress couldn’t load"
        detail={loadError}
        onRetry={() => {
          setLoaded(false);
          setLoadError(null);
          setLoadRevision(value => value + 1);
        }}
      />
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="light-content" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[type.hero, styles.pageTitle]}>Progress</Text>
          <Text style={[type.body, styles.pageSubtitle]}>
            Practice activity and technique scores stay separate, so every
            number has a clear source.
          </Text>
        </View>

        <View accessibilityRole="tablist" style={styles.sectionBar}>
          {(
            [
              ['technique', 'TECHNIQUE'],
              ['practice', 'PRACTICE'],
            ] as const
          ).map(([key, label]) => {
            const active = section === key;
            return (
              <PressableScale
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${label.toLowerCase()} progress`}
                containerStyle={styles.sectionSlot}
                onPress={() => setSection(key)}
                style={styles.sectionOption}
              >
                <Text
                  style={[
                    type.micro,
                    styles.sectionLabel,
                    active && styles.sectionLabelActive,
                  ]}
                >
                  {label}
                </Text>
                <View
                  style={[
                    styles.sectionUnderline,
                    active && styles.sectionUnderlineActive,
                  ]}
                />
              </PressableScale>
            );
          })}
        </View>

        <View accessibilityRole="tablist" style={styles.rangeBar}>
          {PRACTICE_HISTORY_RANGES.map(option => {
            const active = option.key === range;
            return (
              <PressableScale
                key={option.key}
                accessibilityLabel={`${option.label} range`}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                containerStyle={styles.rangeSlot}
                onPress={() => setRange(option.key)}
                style={[styles.rangeOption, active && styles.rangeOptionActive]}
              >
                <Text
                  style={[
                    type.micro,
                    styles.rangeLabel,
                    active && styles.rangeLabelActive,
                  ]}
                >
                  {RANGE_LABELS[option.key]}
                </Text>
              </PressableScale>
            );
          })}
        </View>

        {section === 'practice' ? (
          <>
            <ConsistencyCard
              snapshot={consistency}
              onPress={() => navigation.navigate('StreakCalendar')}
            />
            <View style={styles.practiceHero}>
              <LinearGradient
                colors={[color.courtDeep, color.surfaceDark]}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                pointerEvents="none"
                style={StyleSheet.absoluteFill}
              />
              <View style={styles.practiceHeroTop}>
                <View style={styles.practiceHeroHeading}>
                  <Text style={[type.micro, styles.heroEyebrow]}>
                    VERIFIED PRACTICE
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[type.caption, styles.heroSource]}
                  >
                    On this device · camera captures and measured imports
                  </Text>
                </View>
              </View>

              {practice.captureCount === 0 ? (
                <View style={styles.captureZeroStage}>
                  <View style={styles.captureZeroIcon}>
                    <Icon name="spark" color={color.volt} size={20} />
                  </View>
                  <View style={styles.captureZeroCopy}>
                    <Text style={[type.h3, { color: color.onDark }]}>
                      This chart is waiting on you.
                    </Text>
                    <Text style={[type.caption, styles.captureZeroDetail]}>
                      Step into frame or import a clip — every measured swing
                      lands here.
                    </Text>
                  </View>
                </View>
              ) : (
                <>
                  <View style={styles.captureStage}>
                    <View style={styles.captureCountRow}>
                      <Text style={styles.captureCount}>
                        {practice.captureCount}
                      </Text>
                      <View style={styles.captureCountCopy}>
                        <Text style={[type.h3, { color: color.onDark }]}>
                          captured
                        </Text>
                        <Text
                          style={[type.caption, { color: color.onDarkSubtle }]}
                        >
                          in {selectedDefinition.label.toLowerCase()}
                          {practice.importedCaptureCount > 0
                            ? ` · ${practice.importedCaptureCount} imported`
                            : ''}
                        </Text>
                      </View>
                    </View>
                    <View
                      accessibilityLabel={`${practice.currentStreak} day verified capture streak`}
                      style={styles.streakChip}
                    >
                      <View style={styles.streakIcon}>
                        <Icon name="flame" color={color.flame} size={19} />
                      </View>
                      <View>
                        <Text style={styles.streakValue}>
                          {practice.currentStreak}
                        </Text>
                        <Text style={styles.streakLabel}>DAY STREAK</Text>
                      </View>
                    </View>
                  </View>
                  <Text style={[type.caption, styles.comparisonCopy]}>
                    {comparisonCopy}
                  </Text>
                </>
              )}
              {excludedNote ? (
                <Text
                  style={[type.caption, styles.excludedNote]}
                  testID="practice-excluded-note"
                >
                  {excludedNote}
                </Text>
              ) : null}

              <PracticeVolumeChart
                activeDays={practice.activeDays}
                buckets={practice.buckets}
                rangeLabel={selectedDefinition.label}
              />

              <View style={styles.practiceFooter}>
                <View style={styles.practiceFooterItem}>
                  <Text style={styles.footerValue}>{practice.activeDays}</Text>
                  <Text style={styles.footerLabel}>active days</Text>
                </View>
                <View style={styles.practiceDivider} />
                <View style={styles.practiceFooterItem}>
                  <Text style={styles.footerValue}>{trackedTimeCopy}</Text>
                  <Text style={styles.footerLabel}>pose tracked</Text>
                </View>
                <View style={styles.practiceDivider} />
                <View style={styles.practiceFooterItem}>
                  <Text style={styles.footerValue}>
                    {practice.longestStreak}
                  </Text>
                  <Text style={styles.footerLabel}>best streak</Text>
                </View>
              </View>
            </View>

            <DashSectionHeader
              title="KEY STATISTICS"
              right={vsPriorLabel(range)}
            />
            <View style={styles.statRows}>
              <StatDeltaRow
                icon="camera"
                label="CAPTURES"
                value={String(practice.captureCount)}
                previous={
                  practiceHasPrior ? String(previousCaptureCount) : null
                }
                delta={
                  practiceHasPrior
                    ? practice.priorPeriodDelta.captureCount
                    : null
                }
                testID="practice-stat-captures"
              />
              <StatDeltaRow
                icon="check"
                label="ACTIVE DAYS"
                value={String(practice.activeDays)}
                previous={practiceHasPrior ? String(previousActiveDays) : null}
                delta={
                  practiceHasPrior ? practice.priorPeriodDelta.activeDays : null
                }
                testID="practice-stat-active-days"
              />
              <StatDeltaRow
                icon="person"
                label="POSE TRACKED"
                value={trackedTimeCopy}
                previous={
                  practiceHasPrior && hasCameraEvidence
                    ? formatTrackedTime(previousTrackedMs)
                    : null
                }
                delta={
                  practiceHasPrior && hasCameraEvidence
                    ? practice.priorPeriodDelta.trackedDurationMs
                    : null
                }
                testID="practice-stat-pose-tracked"
              />
            </View>

            <DashSectionHeader
              title="CAPTURE EVIDENCE"
              right={selectedDefinition.label.toUpperCase()}
            />
            <View style={styles.evidenceGrid}>
              <EvidenceMetric
                label="POSE AVAILABILITY"
                value={practice.meanPoseAvailability}
                detail="pose-producing input frames"
              />
              <EvidenceMetric
                label="JOINT COVERAGE"
                value={practice.meanJointCoverage}
                detail="key joints per pose frame"
              />
            </View>
            <View style={styles.evidenceDisclosure}>
              <Icon name="shield" color={color.mint} size={18} />
              <Text style={[type.caption, styles.evidenceDisclosureCopy]}>
                These are camera-read measurements, not form scores. Pose
                tracking and coverage come from guided captures only; imported
                clips count toward captures and days once their pose sequence
                has been measured. Corrupt evidence and unverified legacy clips
                never enter the chart.
              </Text>
            </View>

            <DashSectionHeader
              title="RECENT CAPTURES"
              right={
                eligibleRecentCaptures.length
                  ? `LATEST ${eligibleRecentCaptures.length}`
                  : undefined
              }
            />
            {eligibleRecentCaptures.length === 0 ? (
              <Card tone="dark" style={styles.emptyPractice}>
                <View style={styles.emptyPracticeIcon}>
                  <Icon name="camera" color={color.mint} size={22} />
                </View>
                <View style={styles.flex}>
                  <Text style={[type.bodyBold, { color: color.onDark }]}>
                    No measured captures yet
                  </Text>
                  <Text style={[type.caption, styles.emptyPracticeCopy]}>
                    Open Coach and record with the guided camera or import a
                    clip. Every swing with a measured pose sequence lands here.
                  </Text>
                </View>
              </Card>
            ) : (
              <View style={styles.captureList}>
                {eligibleRecentCaptures.map(capture => (
                  <View key={capture.id} style={styles.captureRow}>
                    <View style={styles.captureGlyph}>
                      <Icon name="person" color={color.mint} size={20} />
                    </View>
                    <View style={styles.flex}>
                      <Text style={[type.bodyBold, styles.captureTitle]}>
                        {displayCaptureTitle(capture)}
                      </Text>
                      <Text style={[type.caption, styles.captureMeta]}>
                        {captureSourceDetail(capture)}
                      </Text>
                      <Text style={[type.caption, styles.captureDate]}>
                        {new Date(capture.capturedAtIso).toLocaleString(
                          undefined,
                          {
                            month: 'short',
                            day: 'numeric',
                            hour: 'numeric',
                            minute: '2-digit',
                          },
                        )}
                      </Text>
                    </View>
                    <View style={styles.captureStatus}>
                      <Text style={styles.captureStatusText}>
                        {capture.status === 'analyzed' ? 'ANALYZED' : 'SAVED'}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}
          </>
        ) : (
          <>
            <PlayerRankCard facts={facts} />

            <Card tone="dark" style={styles.techniqueHero}>
              <View style={styles.techniqueHeroTop}>
                <View style={styles.flex}>
                  <Text style={[type.micro, { color: color.volt }]}>
                    LATEST VALIDATED TECHNIQUE
                  </Text>
                  <Text style={[type.caption, styles.techniqueHeroDetail]}>
                    {latestLabel ?? 'No scored technique yet'}
                  </Text>
                </View>
                {latestScore !== null ? (
                  <Pill label="SCORED DATA" tone="volt" />
                ) : null}
              </View>
              {latestScore === null ? (
                <View style={styles.techniqueEmpty}>
                  <View style={styles.techniqueEmptyIcon}>
                    <Icon name="lock" size={22} color={color.volt} />
                  </View>
                  <View style={styles.flex}>
                    <Text style={[type.h3, { color: color.onDark }]}>
                      No score is being estimated.
                    </Text>
                    <Text style={[type.caption, styles.techniqueEmptyCopy]}>
                      Your camera captures still count toward Practice. A score
                      appears only after validated analysis completes.
                    </Text>
                  </View>
                </View>
              ) : (
                <View style={styles.techniqueScoreRow}>
                  <Text style={styles.techniqueScore}>
                    {latestScore.toFixed(1)}
                  </Text>
                  <Text style={[type.body, styles.techniqueScale]}>/ 10</Text>
                  <Text style={[type.caption, styles.techniqueMatchRating]}>
                    {formatMatchRatingEstimate(latestScore)}
                  </Text>
                </View>
              )}
            </Card>

            {practiceSet ? (
              <PracticeSetCard
                summary={practiceSet}
                onOpenAttempt={analysisId =>
                  navigation.navigate('Result', { analysisId })
                }
              />
            ) : null}

            <DashSectionHeader
              title="KEY STATISTICS"
              right={vsPriorLabel(range)}
            />
            <View style={styles.statRows}>
              <StatDeltaRow
                icon="spark"
                label="SCORED REPS"
                value={String(reps.current)}
                previous={reps.previous === null ? null : String(reps.previous)}
                delta={repsDelta}
                testID="technique-stat-reps"
              />
              <StatDeltaRow
                icon="progress"
                label="AVG SCORE"
                value={
                  avgScore.current === null ? '—' : avgScore.current.toFixed(1)
                }
                previous={
                  avgScore.previous === null
                    ? null
                    : avgScore.previous.toFixed(1)
                }
                delta={avgDelta}
                testID="technique-stat-avg"
              />
              <StatDeltaRow
                icon="star"
                label="BEST SCORE"
                value={
                  bestScore.current === null
                    ? '—'
                    : bestScore.current.toFixed(1)
                }
                previous={
                  bestScore.previous === null
                    ? null
                    : bestScore.previous.toFixed(1)
                }
                delta={bestDelta}
                testID="technique-stat-best"
              />
              <StatDeltaRow
                icon="check"
                label="SCORED DAYS"
                value={String(scoredDays.current)}
                previous={
                  scoredDays.previous === null
                    ? null
                    : String(scoredDays.previous)
                }
                delta={scoredDaysDelta}
                testID="technique-stat-days"
              />
            </View>

            <DashSectionHeader
              title="SCORE TREND"
              right={selectedDefinition.label.toUpperCase()}
            />
            <Card tone="dark" style={styles.trendCard}>
              <View style={styles.trendCardTop}>
                <Text style={[type.micro, { color: color.volt }]}>
                  DAILY AVG · ALL TECHNIQUES
                </Text>
                <Text style={[type.micro, styles.trendScale]}>0–10</Text>
              </View>
              {reps.current === 0 ? (
                <View style={styles.trendEmpty}>
                  <Text style={[type.caption, styles.trendEmptyCopy]}>
                    No comparable scored reads in this window yet. Your next
                    validated analysis starts this chart.
                  </Text>
                </View>
              ) : (
                <ScoreTrendChart buckets={dashboard.buckets} />
              )}
              {dashboard.insight ? (
                <Text style={[type.caption, styles.trendInsight]}>
                  {dashboard.insight}
                </Text>
              ) : null}
            </Card>

            {dashboard.personalBest ? (
              <Card
                tone="dark"
                style={styles.pbCard}
                testID="personal-best-card"
              >
                <View style={styles.pbIcon}>
                  <Icon name="star" color={color.volt} size={20} />
                </View>
                <View style={styles.flex}>
                  <Text style={[type.micro, { color: color.volt }]}>
                    NEW PERSONAL BEST
                  </Text>
                  <Text style={[type.h3, styles.pbName]}>
                    {dashboard.personalBest.shotType.replace(/_/g, ' ')}
                  </Text>
                  <Text style={[type.caption, styles.pbDetail]}>
                    Beats your previous best{' '}
                    {dashboard.personalBest.previousBest.toFixed(1)} ·{' '}
                    {shortDayLabel(dashboard.personalBest.day)}
                  </Text>
                </View>
                <Text style={styles.pbScore}>
                  {dashboard.personalBest.score.toFixed(1)}
                </Text>
              </Card>
            ) : null}

            <DashSectionHeader title="BY STROKE" />
            {byShot.length === 0 ? (
              <Card tone="dark" style={styles.strokeEmpty}>
                <Icon name="progress" size={22} color={color.mint} />
                <View style={styles.flex}>
                  <Text style={[type.bodyBold, { color: color.onDark }]}>
                    Comparable trends start after scoring
                  </Text>
                  <Text style={[type.caption, styles.strokeEmptyCopy]}>
                    Reads are compared only within the same stroke and model
                    version.
                  </Text>
                </View>
              </Card>
            ) : (
              byShot.map(item => {
                const current = item.points.at(-1) ?? null;
                return (
                  <Card
                    key={item.shotType}
                    tone="dark"
                    style={styles.strokeCard}
                  >
                    <View style={styles.strokeTop}>
                      <View style={styles.flex}>
                        <Text style={[type.h3, styles.strokeName]}>
                          {item.shotType.replace(/_/g, ' ')}
                        </Text>
                        <Text style={[type.caption, styles.strokeBasis]}>
                          {item.repCount} accepted reps · {item.points.length}{' '}
                          {basisLabel(item.points.length, item.basis)}
                        </Text>
                      </View>
                      <View style={styles.strokeScoreWrap}>
                        <Text style={styles.strokeScore}>
                          {current?.toFixed(1)}
                        </Text>
                        {item.movement !== null ? (
                          <Text
                            style={[
                              type.micro,
                              {
                                color:
                                  item.movement >= 0 ? color.mint : color.flame,
                              },
                            ]}
                          >
                            {signed(item.movement)} SERIES
                          </Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={styles.chartWrap}>
                      <TrendChart
                        dark
                        points={item.points}
                        width={chartWidth}
                        height={66}
                      />
                    </View>
                    <View style={styles.strokeMeta}>
                      <Text style={[type.caption, styles.strokeMetaLabel]}>
                        Last {Math.min(10, item.points.length)}{' '}
                        {basisLabel(
                          Math.min(10, item.points.length),
                          item.basis,
                        )}{' '}
                        standard deviation
                      </Text>
                      <Text style={[type.bodyBold, { color: color.onDark }]}>
                        {item.spread === null
                          ? 'Need 2'
                          : `±${item.spread.toFixed(1)}`}
                      </Text>
                    </View>
                  </Card>
                );
              })
            )}

            {canonical &&
            (canonical.improving.length || canonical.needsAttention.length) ? (
              <>
                <DashSectionHeader
                  title="OBSERVED SCORE SIGNALS"
                  right="LAST 30 DAYS"
                />
                <Card tone="dark" style={styles.signalCard}>
                  {canonical.improving.slice(0, 2).map(signal => (
                    <View
                      key={`up-${signal.checkpoint}`}
                      style={styles.signalRow}
                    >
                      <View style={styles.flex}>
                        <Text style={[type.bodyBold, styles.signalName]}>
                          {signal.checkpoint.replace(/_/g, ' ')}
                        </Text>
                        <Text style={[type.micro, { color: color.mint }]}>
                          RECENT READS HIGHER
                        </Text>
                      </View>
                      <Text style={[styles.signalValue, { color: color.mint }]}>
                        {formatSignedDelta(signal.delta)}
                      </Text>
                    </View>
                  ))}
                  {canonical.needsAttention.slice(0, 2).map(signal => (
                    <View
                      key={`focus-${signal.checkpoint}`}
                      style={styles.signalRow}
                    >
                      <View style={styles.flex}>
                        <Text style={[type.bodyBold, styles.signalName]}>
                          {signal.checkpoint.replace(/_/g, ' ')}
                        </Text>
                        <Text style={[type.micro, { color: color.flame }]}>
                          LOWER RECENT AVG
                        </Text>
                      </View>
                      <Text
                        style={[styles.signalValue, { color: color.flame }]}
                      >
                        {signal.avg.toFixed(1)}
                      </Text>
                    </View>
                  ))}
                  <Text style={[type.caption, styles.signalDisclosure]}>
                    Server observations compare accepted scored reads from the
                    last 30 days. They are not a player rating.
                  </Text>
                </Card>
              </>
            ) : null}

            <ConsistencyCard
              snapshot={consistency}
              onPress={() => navigation.navigate('StreakCalendar')}
            />

            {consistency && consistency.totalActivities > 0 ? (
              <>
                <DashSectionHeader title="ACHIEVEMENTS" />
                <AchievementsShowcase dark snapshot={consistency} />
              </>
            ) : null}

            <View style={styles.levelContext}>
              <View style={styles.levelIcon}>
                <Icon name="person" color={color.mint} size={20} />
              </View>
              <View style={styles.flex}>
                <Text style={[type.micro, { color: color.onDarkFaint }]}>
                  SELF-REPORTED PLAYING LEVEL
                </Text>
                <Text style={[type.h3, styles.levelValue]}>
                  {profile?.skillLevel ?? 'Not set'}
                </Text>
              </View>
            </View>
            <Text style={styles.ratingDisclosure}>
              Technique Score is coaching feedback, not a verified match or
              player rating. {MATCH_RATING_ESTIMATE_NOTE}
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: color.surfaceDark },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.xl,
    paddingBottom: space.xxxl + 28,
  },
  pageHeader: { maxWidth: 380 },
  pageTitle: { color: color.onDark },
  pageSubtitle: {
    color: color.onDarkSubtle,
    marginTop: space.sm,
    maxWidth: 340,
  },
  // WHOOP-style underline tabs (MOBBIN: WHOOP OVERVIEW/SLEEP/RECOVERY/STRAIN).
  sectionBar: {
    flexDirection: 'row',
    marginTop: space.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineDark,
  },
  sectionSlot: { flex: 1 },
  sectionOption: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingTop: 12,
  },
  sectionLabel: { color: color.onDarkFaint, letterSpacing: 1.2 },
  sectionLabelActive: { color: color.onDark },
  sectionUnderline: {
    alignSelf: 'stretch',
    height: 2,
    borderRadius: 1,
    marginTop: 10,
    backgroundColor: 'transparent',
  },
  sectionUnderlineActive: { backgroundColor: color.volt },
  rangeBar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 3,
    marginTop: space.md,
    borderRadius: radius.pill,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  rangeSlot: { width: 64 },
  rangeOption: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  rangeOptionActive: { backgroundColor: color.volt },
  rangeLabel: { color: color.onDarkMuted },
  rangeLabelActive: { color: color.onVolt },
  statRows: { gap: 8 },
  practiceHero: {
    marginTop: space.md,
    borderRadius: radius.xl,
    padding: space.lg,
    paddingBottom: space.lg + 4,
    backgroundColor: color.surfaceDark,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    overflow: 'hidden',
  },
  practiceHeroTop: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  practiceHeroHeading: { flex: 1, minWidth: 0 },
  heroEyebrow: { color: color.volt },
  heroSource: { color: color.onDarkSubtle, marginTop: 4 },
  // Sized by its content — a fixed width truncated "DAY STREAK" to
  // "DAY STR…" the moment the digits took any room.
  streakChip: {
    flexShrink: 0,
    minHeight: 50,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.pill,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrongDark,
  },
  streakIcon: {
    width: 31,
    height: 31,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,155,66,0.14)',
  },
  streakValue: {
    ...type.h3,
    color: color.onDark,
    lineHeight: 19,
    fontVariant: ['tabular-nums'],
  },
  streakLabel: {
    ...type.micro,
    color: color.onDarkFaint,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.5,
  },
  // The count column must own the shrinkable space (flex: 1 + minWidth: 0):
  // without it the row's intrinsic width pushed the streak chip past the
  // card edge, clipping "DAY STREAK".
  captureCountRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
  },
  captureStage: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 10,
    marginTop: space.xl,
  },
  captureCount: {
    ...type.display,
    color: color.onDark,
    fontSize: 64,
    lineHeight: 66,
  },
  captureCountCopy: { flexShrink: 1, minWidth: 0, paddingBottom: 7 },
  captureZeroStage: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xl,
    padding: space.md,
    borderRadius: radius.md,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
  },
  captureZeroIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.12)',
  },
  captureZeroCopy: { flex: 1, minWidth: 0 },
  captureZeroDetail: { color: color.onDarkSubtle, marginTop: 3 },
  comparisonCopy: { color: color.onDarkSubtle, marginTop: 3 },
  excludedNote: { color: color.onDarkFaint, marginTop: space.sm },
  practiceFooter: {
    minHeight: 58,
    flexDirection: 'row',
    alignItems: 'stretch',
    marginTop: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineMutedDark,
    paddingBottom: 4,
  },
  practiceFooterItem: { flex: 1, alignItems: 'center' },
  practiceDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.lineMutedDark,
    marginHorizontal: space.sm,
  },
  footerValue: {
    ...type.h3,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  footerLabel: {
    ...type.caption,
    color: color.onDarkFaint,
    marginTop: 2,
    textAlign: 'center',
  },
  evidenceGrid: { flexDirection: 'row', gap: 10 },
  evidenceMetric: {
    flex: 1,
    minHeight: 160,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  evidenceLabel: { color: color.onDarkMuted },
  evidenceValue: {
    ...type.score,
    color: color.onDark,
    fontSize: 34,
    lineHeight: 39,
    marginTop: 8,
  },
  evidenceTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: color.onDarkTint,
    overflow: 'hidden',
    marginTop: 9,
  },
  evidenceFill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: color.mint,
  },
  evidenceDetail: { color: color.onDarkSubtle, marginTop: 10 },
  evidenceDisclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 10,
    paddingHorizontal: space.sm,
  },
  evidenceDisclosureCopy: { color: color.onDarkSubtle, flex: 1 },
  emptyPractice: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  emptyPracticeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(83,217,155,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPracticeCopy: { color: color.onDarkSubtle, marginTop: 4 },
  captureList: {
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
    paddingHorizontal: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  captureRow: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.lineDark,
  },
  captureGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(83,217,155,0.12)',
  },
  captureTitle: { color: color.onDark, textTransform: 'capitalize' },
  captureMeta: { color: color.onDarkSubtle, marginTop: 2 },
  captureDate: { color: color.onDarkFaint, marginTop: 1 },
  captureStatus: {
    minHeight: 26,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
  },
  captureStatusText: {
    ...type.micro,
    color: color.volt,
    fontSize: 9,
    lineHeight: 12,
    letterSpacing: 0.45,
  },
  techniqueHero: { marginTop: space.md, minHeight: 174 },
  techniqueHeroTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  techniqueHeroDetail: {
    color: color.onDarkFaint,
    marginTop: 5,
    textTransform: 'capitalize',
  },
  techniqueEmpty: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.xl,
  },
  techniqueEmptyIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
  },
  techniqueEmptyCopy: { color: color.onDarkSubtle, marginTop: 4 },
  techniqueScoreRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginTop: space.xl,
  },
  techniqueScore: {
    ...type.display,
    color: color.onDark,
    fontSize: 72,
    lineHeight: 74,
  },
  techniqueScale: { color: color.onDarkSubtle, marginLeft: 8 },
  techniqueMatchRating: { color: color.onDarkFaint, marginLeft: 8 },
  trendCard: { paddingBottom: space.md },
  trendCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  trendScale: { color: color.onDarkFaint },
  trendEmpty: { minHeight: 96, justifyContent: 'center' },
  trendEmptyCopy: { color: color.onDarkSubtle, maxWidth: 300 },
  trendInsight: {
    color: color.onDarkSubtle,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  pbCard: {
    marginTop: space.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    borderWidth: 1,
    borderColor: 'rgba(215,250,69,0.35)',
  },
  pbIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(215,250,69,0.12)',
  },
  pbName: { color: color.onDark, marginTop: 2, textTransform: 'capitalize' },
  pbDetail: { color: color.onDarkSubtle, marginTop: 2 },
  pbScore: {
    ...type.score,
    color: color.volt,
    fontSize: 34,
    lineHeight: 38,
  },
  signalCard: { gap: space.md },
  signalRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  signalName: {
    color: color.onDark,
    textTransform: 'capitalize',
  },
  signalValue: {
    ...type.h3,
    fontVariant: ['tabular-nums'],
  },
  signalDisclosure: {
    color: color.onDarkSubtle,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  strokeEmpty: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  strokeEmptyCopy: { color: color.onDarkSubtle, marginTop: 4 },
  strokeCard: { marginBottom: 10, padding: space.lg },
  strokeTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  strokeName: { color: color.onDark, textTransform: 'capitalize' },
  strokeBasis: { color: color.onDarkSubtle, marginTop: 3 },
  strokeScoreWrap: { alignItems: 'flex-end' },
  strokeScore: {
    ...type.score,
    color: color.onDark,
    fontSize: 30,
    lineHeight: 34,
  },
  chartWrap: { marginTop: space.md, alignItems: 'center', overflow: 'hidden' },
  strokeMeta: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
  },
  strokeMetaLabel: { color: color.onDarkSubtle, flex: 1 },
  levelContext: {
    minHeight: 82,
    borderRadius: radius.lg,
    backgroundColor: color.inkElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineDark,
    paddingHorizontal: space.md,
    marginTop: space.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  levelIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(83,217,155,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelValue: { color: color.onDark, marginTop: 3 },
  ratingDisclosure: {
    ...type.caption,
    color: color.onDarkFaint,
    marginTop: 8,
    paddingHorizontal: space.sm,
  },
});
