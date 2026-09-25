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
import { SHOT_TYPES } from '@pickle/shared-types';
import {
  Button,
  Card,
  ErrorState,
  LoadingState,
  PressableScale,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import { getDb } from '../data/db';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import {
  listRealAnalysisFacts,
  type RealAnalysisFact,
} from '../data/repository';
import { useAppStore } from '../state/appStore';
import { getApiSession } from '../account/apiSession';
import {
  fetchCanonicalProgress,
  type CanonicalProgress,
} from '../progress/api';
import {
  PRACTICE_HISTORY_RANGES,
  type PracticeHistoryRangeKey,
} from '../progress/practiceHistory';
import { DuprReadout } from '../progress/DuprReadout';
import {
  DUPR_ESTIMATE_LABEL,
  DUPR_ESTIMATE_NOTE,
  duprAccessibilityLabel,
  duprDelta,
  formatDuprDistance,
} from '../progress/duprEstimate';
import { ScoreTrendChart } from '../progress/ScoreTrendChart';
import { buildTechniqueDashboard } from '../progress/techniqueDashboard';
import { PlayerRankCard } from '../components/PlayerRankCard';
import { ConsistencyCard } from '../consistency/ConsistencyCard';
import { useConsistencyStore } from '../consistency/store';
import type { RootStackParams } from '../navigation/params';
import { useTabBarContentInset } from '../navigation/tabBarLayout';
import { useTabScrollDock } from '../navigation/tabBarDock';
import { plural } from '../util/plural';

/**
 * PROGRESS — one calm page (owner request 2026-09-24; MOBBIN: Cal AI
 * progress, Alma trends, Bevel exercise lists): the player's level, their
 * streak, one estimated-DUPR trend and each stroke's latest read. The
 * honesty rules are unchanged: comparisons only exist when a real prior
 * window exists, and nothing is interpolated.
 */

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

/** Count-correct label for a stroke's comparison basis. */
function basisLabel(count: number, basis: 'daily averages' | 'scored reads') {
  return basis === 'daily averages'
    ? plural(count, 'daily average', 'daily averages')
    : plural(count, 'scored read', 'scored reads');
}

/** One plain-language line about a stroke's movement inside the window. */
function strokeTrend(
  points: readonly number[],
  basis: 'daily averages' | 'scored reads',
  rangePhrase: string,
): { copy: string; tone: string } {
  const first = points[0]!;
  const latest = points.at(-1)!;
  if (points.length < 2) {
    return {
      copy: `${points.length} ${basisLabel(points.length, basis)} in ${rangePhrase}`,
      tone: color.inkSoft,
    };
  }
  const delta = duprDelta(first, latest);
  if (delta === 0) {
    return { copy: `No change in ${rangePhrase}`, tone: color.inkSoft };
  }
  return {
    copy: `${delta > 0 ? 'Up' : 'Down'} ${formatDuprDistance(
      first,
      latest,
    )} in ${rangePhrase}`,
    tone: delta > 0 ? color.good : color.bad,
  };
}

export function ProgressScreen() {
  // Large text: each stroke row stacks its DUPR under the name so neither
  // column is squeezed into a word-per-line strip.
  const stackedRows = useWindowDimensions().fontScale > 1.3;
  const tabBarInset = useTabBarContentInset();
  const tabBarDock = useTabScrollDock('Performance');
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const ownerKey = useAppStore(state => state.ownerKey);
  const activeOwner = getActiveDataOwner();
  const ownerGeneration =
    activeOwner === SIGNED_OUT_DATA_OWNER
      ? null
      : captureDataOwnerContext().generation;
  const consistency = useConsistencyStore(state => state.snapshot);
  const refreshConsistency = useConsistencyStore(state => state.refresh);
  const timeZone = useMemo(deviceTimeZone, []);
  const dayFormatter = useMemo(() => makeDayFormatter(timeZone), [timeZone]);
  const [range, setRange] = useState<PracticeHistoryRangeKey>('28d');
  const [facts, setFacts] = useState<RealAnalysisFact[]>([]);
  const [canonical, setCanonical] = useState<CanonicalProgress | null>(null);
  const [asOfIso, setAsOfIso] = useState(() => new Date().toISOString());
  const [loaded, setLoaded] = useState(false);
  const [loadedOwner, setLoadedOwner] = useState<{
    ownerKey: string;
    generation: number | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const owner = getActiveDataOwner();
      const context =
        owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
      const isCurrent = () =>
        active &&
        getActiveDataOwner() === owner &&
        (context === null || isDataOwnerContextCurrent(context));
      void (async () => {
        try {
          const localFacts = await listRealAnalysisFacts(getDb(), null);
          if (!isCurrent()) return;
          setFacts(localFacts);
          setCanonical(null);
          setAsOfIso(new Date().toISOString());
          setLoadError(null);
          // Local technique data is usable even while the network is
          // unavailable. A later canonical response may enrich this focus
          // only; it cannot publish after blur, retry, or an owner change.
          const apiSession = getApiSession();
          if (apiSession?.canonicalAppUserId === owner) {
            void fetchCanonicalProgress(apiSession)
              .then(accountProgress => {
                if (isCurrent()) setCanonical(accountProgress);
              })
              .catch(() => {
                if (isCurrent()) setCanonical(null);
              });
          }
        } catch {
          if (!isCurrent()) return;
          setLoadError(
            'Your saved camera history could not be opened. No empty values were substituted.',
          );
        } finally {
          if (isCurrent()) {
            setLoadedOwner({
              ownerKey: owner,
              generation: context?.generation ?? null,
            });
            setLoaded(true);
          }
        }
      })();
      void refreshConsistency();
      return () => {
        active = false;
      };
    }, [
      activeOwner,
      loadRevision,
      ownerGeneration,
      ownerKey,
      refreshConsistency,
    ]),
  );

  const dashboard = useMemo(
    () => buildTechniqueDashboard(facts, { asOfIso, timeZone, range }),
    [asOfIso, facts, range, timeZone],
  );
  const selectedDefinition = PRACTICE_HISTORY_RANGES.find(
    candidate => candidate.key === range,
  )!;
  const rangePhrase = selectedDefinition.label.toLowerCase();
  // The window's first and last calendar day, from the dashboard's buckets.
  const selectedStartDay =
    dashboard.buckets[0]?.key.split(':')[0] ?? '9999-12-31';
  const selectedEndDay =
    dashboard.buckets.at(-1)?.key.split(':').at(-1) ?? '0000-01-01';
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

  const byShot = useMemo(() => {
    return SHOT_TYPES.map(shotType => {
      const syncedForShot = (selectedSeries ?? [])
        .filter(point => point.shotType === shotType)
        .sort((left, right) => left.day.localeCompare(right.day));
      if (syncedForShot.length) {
        const newest = syncedForShot.at(-1)!;
        const points = syncedForShot
          .filter(
            point => point.scoringModelVersion === newest.scoringModelVersion,
          )
          .map(point => point.avgScore);
        return { shotType, points, basis: 'daily averages' as const };
      }
      const allForShot = selectedFacts.filter(
        fact => fact.shotType === shotType,
      );
      const newest = allForShot[0];
      if (!newest) return null;
      const points = allForShot
        .filter(
          fact =>
            fact.resultKind === 'scored' &&
            fact.overallScore !== null &&
            fact.scoringModelVersion === newest.scoringModelVersion &&
            fact.shotConfigVersion === newest.shotConfigVersion,
        )
        .reverse()
        .map(fact => fact.overallScore as number);
      return { shotType, points, basis: 'scored reads' as const };
    }).filter(
      (item): item is NonNullable<typeof item> =>
        item !== null && item.points.length > 0,
    );
  }, [selectedFacts, selectedSeries]);

  const hasScores =
    facts.some(
      fact => fact.resultKind === 'scored' && fact.overallScore !== null,
    ) || Boolean(canonical?.series.length);

  if (
    !loaded ||
    loadedOwner?.ownerKey !== activeOwner ||
    loadedOwner.generation !== ownerGeneration
  ) {
    return (
      <View style={[styles.screen, { paddingBottom: tabBarInset }]}>
        <LoadingState label="Loading measured progress…" />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[styles.screen, { paddingBottom: tabBarInset }]}>
        <ErrorState
          title="Progress couldn’t load"
          detail={loadError}
          onRetry={() => {
            setLoaded(false);
            setLoadError(null);
            setLoadRevision(value => value + 1);
          }}
        />
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        {...tabBarDock}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <Text style={[type.hero, styles.pageTitle]}>Progress</Text>
          <Text style={[type.body, styles.pageSubtitle]}>
            Your level, streak and stroke trends.
          </Text>
        </View>

        <PlayerRankCard facts={facts} />
        <ConsistencyCard
          snapshot={consistency}
          onPress={() => navigation.navigate('StreakCalendar')}
        />

        {hasScores ? (
          <>
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
                    style={[
                      styles.rangeOption,
                      active && styles.rangeOptionActive,
                    ]}
                  >
                    <Text
                      style={[
                        type.caption,
                        styles.rangeLabel,
                        active && styles.rangeLabelActive,
                      ]}
                    >
                      {option.label}
                    </Text>
                  </PressableScale>
                );
              })}
            </View>

            <Card tone="dark" style={styles.trendCard} testID="progress-trend">
              <Text style={[type.micro, styles.trendEyebrow]}>
                {`${DUPR_ESTIMATE_LABEL} · ${selectedDefinition.label.toUpperCase()}`}
              </Text>
              {dashboard.scoredReps.current === 0 ? (
                <Text style={[type.body, styles.trendEmpty]}>
                  {`No scored swings in the last ${rangePhrase}.`}
                </Text>
              ) : (
                <ScoreTrendChart buckets={dashboard.buckets} />
              )}
              {dashboard.insight ? (
                <Text style={[type.caption, styles.trendInsight]}>
                  {dashboard.insight}
                </Text>
              ) : null}
            </Card>

            {byShot.length > 0 ? (
              <>
                <SectionTitle title="Strokes" />
                <View style={styles.strokeList}>
                  {byShot.map((item, index) => {
                    const latest = item.points.at(-1)!;
                    const name = item.shotType.replace(/_/g, ' ');
                    const trend = strokeTrend(
                      item.points,
                      item.basis,
                      rangePhrase,
                    );
                    return (
                      <View
                        key={item.shotType}
                        accessible
                        accessibilityLabel={`${name}. ${duprAccessibilityLabel(
                          latest,
                        )}. ${trend.copy}.`}
                        style={[
                          styles.strokeRow,
                          stackedRows && styles.strokeRowStacked,
                          index > 0 && styles.strokeRowDivider,
                        ]}
                        testID={`stroke-row-${item.shotType}`}
                      >
                        <View
                          style={
                            stackedRows ? styles.strokeTextStacked : styles.flex
                          }
                        >
                          <Text style={[type.bodyBold, styles.strokeName]}>
                            {name}
                          </Text>
                          <Text
                            style={[
                              type.caption,
                              styles.strokeTrend,
                              { color: trend.tone },
                            ]}
                          >
                            {trend.copy}
                          </Text>
                        </View>
                        <DuprReadout
                          accessible={false}
                          align={stackedRows ? 'flex-start' : 'flex-end'}
                          score={latest}
                          valueStyle={styles.strokeScore}
                          testID={`stroke-rating-${item.shotType}`}
                        />
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}

            <Text style={styles.footnote} testID="progress-dupr-note">
              {DUPR_ESTIMATE_NOTE}
            </Text>
          </>
        ) : (
          <Card style={styles.emptyCard} testID="progress-empty">
            <View style={styles.emptyIcon}>
              <Icon name="progress" color={color.court} size={22} />
            </View>
            <Text style={[type.h3, styles.emptyTitle]}>
              Get your first score
            </Text>
            <Text style={[type.body, styles.emptyCopy]}>
              Analyze one stroke and your trend and stroke scores show up here.
            </Text>
            <View style={styles.emptyAction}>
              <Button
                label="Analyze your first stroke"
                variant="dark"
                icon="camera"
                onPress={() => navigation.navigate('Analyze')}
              />
            </View>
          </Card>
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
    paddingTop: space.xl,
  },
  pageHeader: { maxWidth: 380 },
  pageTitle: { color: color.ink },
  pageSubtitle: {
    color: color.inkSoft,
    marginTop: space.sm,
    maxWidth: 340,
  },
  rangeBar: {
    flexDirection: 'row',
    padding: 3,
    marginTop: space.xl,
    borderRadius: radius.pill,
    backgroundColor: color.surfaceAlt,
  },
  rangeSlot: { flex: 1 },
  rangeOption: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  rangeOptionActive: {
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
  },
  rangeLabel: { color: color.inkSoft },
  rangeLabelActive: { color: color.ink },
  trendCard: { marginTop: space.md },
  trendEyebrow: { color: color.volt },
  trendEmpty: { color: color.onDarkSubtle, marginTop: space.md },
  trendInsight: {
    color: color.onDarkSubtle,
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineDark,
  },
  strokeList: {
    borderRadius: radius.lg,
    backgroundColor: color.surfaceElevated,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.md,
  },
  strokeRow: {
    minHeight: 76,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
  },
  strokeRowStacked: {
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space.sm,
  },
  strokeTextStacked: { alignSelf: 'stretch' },
  strokeRowDivider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  strokeName: { color: color.ink, textTransform: 'capitalize' },
  strokeTrend: { marginTop: 2 },
  strokeScore: {
    ...type.score,
    color: color.ink,
  },
  footnote: {
    ...type.caption,
    color: color.inkSoft,
    marginTop: space.lg,
    paddingHorizontal: space.sm,
  },
  emptyCard: { marginTop: space.md },
  emptyIcon: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  emptyTitle: { color: color.ink, marginTop: space.md },
  emptyCopy: { color: color.inkSoft, marginTop: space.xs },
  emptyAction: { marginTop: space.lg },
});
