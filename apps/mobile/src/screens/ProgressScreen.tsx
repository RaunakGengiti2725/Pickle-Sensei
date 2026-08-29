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
import { useFocusEffect } from '@react-navigation/native';
import LinearGradient from 'react-native-linear-gradient';
import { SHOT_TYPES } from '@pickle/shared-types';
import {
  Card,
  ErrorState,
  LoadingState,
  Pill,
  PressableScale,
  SectionTitle,
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
  PRACTICE_HISTORY_RANGES,
  type PracticeHistoryRangeKey,
} from '../progress/practiceHistory';
import { PracticeVolumeChart } from '../progress/PracticeVolumeChart';

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
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(new Date(value))) {
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

function percent(value: number | null) {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function displayCaptureTitle(capture: CaptureHistoryEntry) {
  const recognition = capture.clip?.recognition;
  return recognition?.status === 'recognized'
    ? recognition.shotType.replace(/_/g, ' ')
    : 'Unlabeled motion';
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
  const profile = useAppStore(state => state.profile);
  const timeZone = useMemo(deviceTimeZone, []);
  const dayFormatter = useMemo(() => makeDayFormatter(timeZone), [timeZone]);
  const [section, setSection] = useState<ProgressSection>('practice');
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
      return () => {
        active = false;
      };
    }, [loadRevision]),
  );

  const practice = useMemo(
    () => buildPracticeHistory(captures, { asOfIso, timeZone, range }),
    [asOfIso, captures, range, timeZone],
  );
  const selectedDefinition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === range,
  )!;
  const selectedStartDay = practice.buckets[0]?.key ?? '9999-12-31';
  const selectedEndDay = practice.buckets.at(-1)?.key ?? '0000-01-01';
  const selectedFacts = facts.filter(fact => {
    const day = dayKey(fact.capturedAt, dayFormatter);
    return day >= selectedStartDay && day <= selectedEndDay;
  });
  const selectedSeries = canonical?.series.filter(
    point => point.day >= selectedStartDay && point.day <= selectedEndDay,
  );
  const allScored = facts.filter(
    fact => fact.resultKind === 'scored' && fact.overallScore !== null,
  );
  const selectedScored = selectedFacts.filter(
    fact => fact.resultKind === 'scored' && fact.overallScore !== null,
  );
  const latestLocal = allScored[0] ?? null;
  const latestSynced = canonical?.series.reduce<
    CanonicalProgress['series'][number] | null
  >(
    (latest, point) => (!latest || point.day > latest.day ? point : latest),
    null,
  );
  const latestScore =
    latestLocal?.overallScore ?? latestSynced?.avgScore ?? null;
  const latestLabel = latestLocal
    ? latestLocal.shotType.replace(/_/g, ' ')
    : latestSynced
    ? `${latestSynced.shotType.replace(/_/g, ' ')} daily average`
    : null;
  const rangeRatedReps =
    selectedSeries?.reduce((sum, point) => sum + point.shotCount, 0) ??
    selectedScored.length;
  const scoredDays = new Set(
    selectedScored.map(fact => dayKey(fact.capturedAt, dayFormatter)),
  ).size;

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

  const eligibleRecentCaptures = captures
    .filter(
      capture =>
        capture.evidenceStatus === 'valid' &&
        capture.clip?.captureMode === 'automatic_pose_trigger',
    )
    .slice(0, 4);
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

  if (!loaded) return <LoadingState label="Loading measured progress…" />;

  if (loadError) {
    return (
      <ErrorState
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
      <StatusBar barStyle="dark-content" />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[type.h1, styles.pageTitle]}>Progress</Text>
          <Text style={[type.body, styles.pageSubtitle]}>
            Practice activity and technique scores stay separate, so every
            number has a clear source.
          </Text>
        </View>

        <View accessibilityRole="tablist" style={styles.sectionBar}>
          {(
            [
              ['practice', 'Practice'],
              ['technique', 'Technique'],
            ] as const
          ).map(([key, label]) => {
            const active = section === key;
            return (
              <PressableScale
                key={key}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                accessibilityLabel={`${label} progress`}
                containerStyle={styles.sectionSlot}
                onPress={() => setSection(key)}
                style={[
                  styles.sectionOption,
                  active && styles.sectionOptionActive,
                ]}
              >
                <Text
                  style={[
                    type.bodyBold,
                    styles.sectionLabel,
                    active && styles.sectionLabelActive,
                  ]}
                >
                  {label}
                </Text>
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
            <LinearGradient
              colors={[color.courtDeep, color.surfaceDark]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.practiceHero}
            >
              <View style={styles.practiceHeroTop}>
                <View style={styles.practiceHeroHeading}>
                  <Text style={[type.micro, styles.heroEyebrow]}>
                    VERIFIED CAMERA PRACTICE
                  </Text>
                  <Text
                    numberOfLines={2}
                    style={[type.caption, styles.heroSource]}
                  >
                    On this device · automatic captures only
                  </Text>
                </View>
              </View>

              <View style={styles.captureStage}>
                <View style={styles.captureCountRow}>
                  <Text style={styles.captureCount}>
                    {practice.captureCount}
                  </Text>
                  <View style={styles.captureCountCopy}>
                    <Text style={[type.h3, { color: color.onDark }]}>
                      captured
                    </Text>
                    <Text style={[type.caption, { color: color.onDarkSubtle }]}>
                      in {selectedDefinition.label.toLowerCase()}
                    </Text>
                  </View>
                </View>
                <View
                  accessibilityLabel={`${practice.currentStreak} day automatic capture streak`}
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
                  <Text style={styles.footerValue}>
                    {formatTrackedTime(practice.trackedDurationMs)}
                  </Text>
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
            </LinearGradient>

            <SectionTitle title="Capture evidence" />
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
              <Icon name="shield" color={color.court} size={18} />
              <Text style={[type.caption, styles.evidenceDisclosureCopy]}>
                These are camera-read measurements, not form scores. Imports,
                corrupt evidence, and unverified legacy clips never enter the
                chart.
              </Text>
            </View>

            <SectionTitle
              title="Recent camera evidence"
              right={
                eligibleRecentCaptures.length ? (
                  <Text style={[type.caption, { color: color.inkSoft }]}>
                    Latest {eligibleRecentCaptures.length}
                  </Text>
                ) : undefined
              }
            />
            {eligibleRecentCaptures.length === 0 ? (
              <Card tone="soft" style={styles.emptyPractice}>
                <View style={styles.emptyPracticeIcon}>
                  <Icon name="camera" color={color.court} size={22} />
                </View>
                <View style={styles.flex}>
                  <Text style={[type.bodyBold, { color: color.ink }]}>
                    No verified motion captured yet
                  </Text>
                  <Text style={[type.caption, styles.emptyPracticeCopy]}>
                    Open Coach, step fully into frame, and the camera will save
                    a motion window automatically.
                  </Text>
                </View>
              </Card>
            ) : (
              <View style={styles.captureList}>
                {eligibleRecentCaptures.map(capture => (
                  <View key={capture.id} style={styles.captureRow}>
                    <View style={styles.captureGlyph}>
                      <Icon name="person" color={color.court} size={20} />
                    </View>
                    <View style={styles.flex}>
                      <Text style={[type.bodyBold, styles.captureTitle]}>
                        {displayCaptureTitle(capture)}
                      </Text>
                      <Text style={[type.caption, styles.captureMeta]}>
                        {(capture.durationMs / 1_000).toFixed(1)}s saved clip ·{' '}
                        {Math.round(capture.fps)} recorded fps
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
                </View>
              )}
            </Card>

            <SectionTitle title={selectedDefinition.label} />
            <View style={styles.techniqueStats}>
              <View style={styles.techniqueStat}>
                <Text style={styles.techniqueStatValue}>{rangeRatedReps}</Text>
                <Text style={[type.caption, styles.techniqueStatLabel]}>
                  accepted scored reps
                </Text>
              </View>
              <View style={styles.techniqueStatDivider} />
              <View style={styles.techniqueStat}>
                <Text style={styles.techniqueStatValue}>{scoredDays}</Text>
                <Text style={[type.caption, styles.techniqueStatLabel]}>
                  scored days on device
                </Text>
              </View>
            </View>

            {canonical &&
            (canonical.improving.length || canonical.needsAttention.length) ? (
              <>
                <SectionTitle title="Observed score signals" />
                <Card tone="soft" style={styles.signalCard}>
                  {canonical.improving.slice(0, 2).map(signal => (
                    <View
                      key={`up-${signal.checkpoint}`}
                      style={styles.signalRow}
                    >
                      <Pill label="RECENT READS HIGHER" tone="good" />
                      <Text style={[type.bodyBold, styles.signalName]}>
                        {signal.checkpoint.replace(/_/g, ' ')}
                      </Text>
                      <Text style={[type.bodyBold, { color: color.good }]}>
                        {`+${signal.delta.toFixed(1)}`}
                      </Text>
                    </View>
                  ))}
                  {canonical.needsAttention.slice(0, 2).map(signal => (
                    <View
                      key={`focus-${signal.checkpoint}`}
                      style={styles.signalRow}
                    >
                      <Pill label="LOWER RECENT AVG" tone="warn" />
                      <Text style={[type.bodyBold, styles.signalName]}>
                        {signal.checkpoint.replace(/_/g, ' ')}
                      </Text>
                      <Text style={[type.bodyBold, { color: color.warn }]}>
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

            <SectionTitle title="By stroke" />
            {byShot.length === 0 ? (
              <Card tone="soft" style={styles.strokeEmpty}>
                <Icon name="progress" size={22} color={color.court} />
                <View style={styles.flex}>
                  <Text style={[type.bodyBold, { color: color.ink }]}>
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
                  <Card key={item.shotType} style={styles.strokeCard}>
                    <View style={styles.strokeTop}>
                      <View style={styles.flex}>
                        <Text style={[type.h3, styles.strokeName]}>
                          {item.shotType.replace(/_/g, ' ')}
                        </Text>
                        <Text style={[type.caption, styles.strokeBasis]}>
                          {item.repCount} accepted reps · {item.points.length}{' '}
                          {item.basis}
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
                                  item.movement >= 0 ? color.good : color.warn,
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
                        points={item.points}
                        width={chartWidth}
                        height={66}
                      />
                    </View>
                    <View style={styles.strokeMeta}>
                      <Text style={[type.caption, { color: color.inkSoft }]}>
                        Last {Math.min(10, item.points.length)} {item.basis}{' '}
                        standard deviation
                      </Text>
                      <Text style={[type.bodyBold, { color: color.ink }]}>
                        {item.spread === null
                          ? 'Need 2'
                          : `±${item.spread.toFixed(1)}`}
                      </Text>
                    </View>
                  </Card>
                );
              })
            )}

            <View style={styles.levelContext}>
              <View style={styles.levelIcon}>
                <Icon name="person" color={color.court} size={20} />
              </View>
              <View style={styles.flex}>
                <Text style={[type.micro, { color: color.inkSoft }]}>
                  SELF-REPORTED PLAYING LEVEL
                </Text>
                <Text style={[type.h3, styles.levelValue]}>
                  {profile?.skillLevel ?? 'Not set'}
                </Text>
              </View>
            </View>
            <Text style={styles.ratingDisclosure}>
              Technique Score is coaching feedback, not a DUPR or verified match
              rating.
            </Text>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingTop: space.lg,
    paddingBottom: space.xxxl + 28,
  },
  pageHeader: { maxWidth: 380 },
  pageTitle: { color: color.ink },
  pageSubtitle: { color: color.inkSoft, marginTop: space.sm, maxWidth: 360 },
  sectionBar: {
    flexDirection: 'row',
    padding: 4,
    marginTop: space.lg,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  sectionSlot: { flex: 1 },
  sectionOption: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  sectionOptionActive: { backgroundColor: color.ink },
  sectionLabel: { color: color.inkSoft },
  sectionLabelActive: { color: color.onDark },
  rangeBar: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: 3,
    marginTop: 12,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  rangeSlot: { width: 64 },
  rangeOption: {
    minHeight: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  rangeOptionActive: { backgroundColor: color.courtSoft },
  rangeLabel: { color: color.inkSoft },
  rangeLabelActive: { color: color.courtDeep },
  practiceHero: {
    marginTop: space.md,
    borderRadius: radius.xl,
    padding: space.lg,
    paddingBottom: space.lg + 4,
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
  captureCountRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 12,
    flexShrink: 1,
  },
  captureStage: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 10,
    marginTop: space.xl,
  },
  captureCount: {
    ...type.display,
    color: color.onDark,
    fontSize: 72,
    lineHeight: 72,
  },
  captureCountCopy: { paddingBottom: 7 },
  comparisonCopy: { color: color.onDarkSubtle, marginTop: 3 },
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
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  evidenceLabel: { color: color.inkSoft },
  evidenceValue: {
    ...type.score,
    color: color.ink,
    fontSize: 34,
    lineHeight: 39,
    marginTop: 8,
  },
  evidenceTrack: {
    height: 5,
    borderRadius: 3,
    backgroundColor: color.surfaceAlt,
    overflow: 'hidden',
    marginTop: 9,
  },
  evidenceFill: {
    height: 5,
    borderRadius: 3,
    backgroundColor: color.court,
  },
  evidenceDetail: { color: color.inkSoft, marginTop: 10 },
  evidenceDisclosure: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 10,
    paddingHorizontal: space.sm,
  },
  evidenceDisclosureCopy: { color: color.inkSoft, flex: 1 },
  emptyPractice: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  emptyPracticeIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPracticeCopy: { color: color.inkSoft, marginTop: 4 },
  captureList: {
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    paddingHorizontal: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  captureRow: {
    minHeight: 88,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.line,
  },
  captureGlyph: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  captureTitle: { color: color.ink, textTransform: 'capitalize' },
  captureMeta: { color: color.inkSoft, marginTop: 2 },
  captureDate: { color: color.inkSoft, marginTop: 1 },
  captureStatus: {
    minHeight: 26,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  captureStatusText: {
    ...type.micro,
    color: color.courtDeep,
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
    backgroundColor: color.inkTint,
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
  techniqueStats: {
    minHeight: 108,
    flexDirection: 'row',
    alignItems: 'stretch',
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  techniqueStat: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  techniqueStatDivider: {
    width: StyleSheet.hairlineWidth,
    backgroundColor: color.line,
    marginHorizontal: space.md,
  },
  techniqueStatValue: {
    ...type.score,
    color: color.ink,
    fontSize: 34,
    lineHeight: 38,
  },
  techniqueStatLabel: {
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: 3,
  },
  signalCard: { gap: space.md },
  signalRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  signalName: { color: color.ink, flex: 1, textTransform: 'capitalize' },
  signalDisclosure: {
    color: color.inkSoft,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  strokeEmpty: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  strokeEmptyCopy: { color: color.inkSoft, marginTop: 4 },
  strokeCard: { marginBottom: 10, padding: space.lg },
  strokeTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  strokeName: { color: color.ink, textTransform: 'capitalize' },
  strokeBasis: { color: color.inkSoft, marginTop: 3 },
  strokeScoreWrap: { alignItems: 'flex-end' },
  strokeScore: {
    ...type.score,
    color: color.ink,
    fontSize: 30,
    lineHeight: 33,
  },
  chartWrap: { marginTop: space.md, alignItems: 'center', overflow: 'hidden' },
  strokeMeta: {
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space.md,
  },
  levelContext: {
    minHeight: 82,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
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
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  levelValue: { color: color.ink, marginTop: 3 },
  ratingDisclosure: {
    ...type.caption,
    color: color.inkSoft,
    marginTop: 8,
    paddingHorizontal: space.sm,
  },
});
