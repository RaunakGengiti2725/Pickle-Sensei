import React, { useCallback, useRef, useState } from 'react';
import {
  RefreshControl,
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
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import { listShots, type LocalShotRow } from '../data/repository';
import type { RootStackParams } from '../navigation/params';
import { useTabBarContentInset } from '../navigation/tabBarLayout';
import { useTabScrollDock } from '../navigation/tabBarDock';
import { DuprReadout } from '../progress/DuprReadout';
import { duprAccessibilityLabel } from '../progress/duprEstimate';
import { PlayerRankBanner } from '../components/PlayerRankBanner';
import { flameIntensityForStreak } from '../consistency/engine';
import { FlameIcon } from '../consistency/FlameIcon';
import { useConsistencyStore } from '../consistency/store';
import { useWalkthroughTarget } from '../walkthrough/targets';
import { plural } from '../util/plural';

export function HomeScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const rankBannerTarget = useWalkthroughTarget('rank-banner');
  const streakTarget = useWalkthroughTarget('home-streak');
  const largeText = useWindowDimensions().fontScale >= 1.5;
  const tabBarInset = useTabBarContentInset();
  const tabBarDock = useTabScrollDock('Home');
  const profile = useAppStore(s => s.profile);
  const ownerKey = useAppStore(s => s.ownerKey);
  const activeOwner = getActiveDataOwner();
  const ownerGeneration =
    activeOwner === SIGNED_OUT_DATA_OWNER
      ? null
      : captureDataOwnerContext().generation;
  const consistency = useConsistencyStore(s => s.snapshot);
  const refreshConsistency = useConsistencyStore(s => s.refresh);
  const [recent, setRecent] = useState<LocalShotRow[]>([]);
  const [allShots, setAllShots] = useState<LocalShotRow[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadedOwner, setLoadedOwner] = useState<{
    ownerKey: string;
    generation: number | null;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const focused = useRef(false);
  const loadRevision = useRef(0);

  const load = useCallback(async () => {
    if (!focused.current) return;
    const revision = ++loadRevision.current;
    const owner = getActiveDataOwner();
    const context =
      owner === SIGNED_OUT_DATA_OWNER ? null : captureDataOwnerContext();
    const isCurrent = () =>
      focused.current &&
      loadRevision.current === revision &&
      getActiveDataOwner() === owner &&
      (context === null || isDataOwnerContextCurrent(context));
    try {
      const shots = await listShots(getDb(), 250);
      if (!isCurrent()) return;
      setRecent(shots.slice(0, 5));
      setAllShots(shots);
      setLoadError(null);
    } catch {
      if (!isCurrent()) return;
      setLoadError(
        'Your saved reads could not be opened. Try again to load your real court history.',
      );
    } finally {
      if (isCurrent()) {
        setLoadedOwner({
          ownerKey: owner,
          generation: context?.generation ?? null,
        });
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      void load();
      void refreshConsistency();
      return () => {
        focused.current = false;
        loadRevision.current += 1;
      };
    }, [activeOwner, load, ownerGeneration, ownerKey, refreshConsistency]),
  );

  // The product streak: meaningful training days (analyses, sessions,
  // drills) from the consistency engine — never mere app opens or captures.
  const trainingStreak = consistency?.currentStreak ?? 0;

  if (
    !loaded ||
    loadedOwner?.ownerKey !== activeOwner ||
    loadedOwner.generation !== ownerGeneration
  ) {
    return (
      <View style={[styles.screen, { paddingBottom: tabBarInset }]}>
        <LoadingState label="Loading your court…" />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={[styles.screen, { paddingBottom: tabBarInset }]}>
        <ErrorState
          title="Your court couldn’t load"
          detail={loadError}
          onRetry={() => {
            setLoadError(null);
            setLoaded(false);
            void load();
          }}
        />
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScrollView
        {...tabBarDock}
        contentContainerStyle={[styles.content, { paddingBottom: tabBarInset }]}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            tintColor={color.court}
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void load();
            }}
          />
        }
      >
        <View
          style={[styles.topBar, largeText && styles.topBarStacked]}
          testID="home-top-bar"
        >
          <BrandMark />
          <View style={styles.topBadges} testID="home-top-badges">
            <Pill
              multiline
              label={
                profile?.skillLevel
                  ? `SELF · ${profile.skillLevel}`
                  : 'NEW PLAYER'
              }
              tone="neutral"
            />
            {/* Walkthrough anchor: the daily-streak step spotlights the real
                flame chip (collapsable={false} keeps the view measurable). */}
            <View
              ref={streakTarget}
              collapsable={false}
              style={styles.streakBadgeSlot}
            >
              <PressableScale
                accessibilityRole="button"
                accessibilityLabel={`${trainingStreak} ${plural(
                  trainingStreak,
                  'day',
                )} training streak. Opens the consistency calendar.`}
                onPress={() => navigation.navigate('StreakCalendar')}
                hitSlop={6}
                containerStyle={styles.streakBadgeSlot}
                style={[
                  styles.streakBadge,
                  largeText && styles.streakBadgeLarge,
                ]}
                testID="home-streak-badge"
              >
                <FlameIcon
                  intensity={flameIntensityForStreak(trainingStreak)}
                  size={17}
                />
                <Text style={[type.caption, styles.streakValue]}>
                  {trainingStreak}
                </Text>
              </PressableScale>
            </View>
          </View>
        </View>

        {/* Walkthrough anchor: the honest-ratings step spotlights the real
            rank banner (collapsable={false} keeps the view measurable). */}
        <View ref={rankBannerTarget} collapsable={false}>
          <PlayerRankBanner
            shots={allShots}
            streakDays={trainingStreak}
            streakAtRisk={consistency?.atRisk ?? false}
            onPressStreak={() => navigation.navigate('StreakCalendar')}
          />
        </View>

        <Text style={[type.h1, styles.welcome]}>
          {profile?.firstName
            ? `Ready when you are, ${profile.firstName}.`
            : 'Ready when you are.'}
        </Text>

        {/* Stroke Analysis is the flagship: one movement, deepest feedback,
            zero-touch capture. The second card routes to guided practice in
            the Drill Library. */}
        <View style={styles.modeRow}>
          <PressableScale
            accessibilityRole="button"
            accessibilityLabel="Stroke Analysis. Analyze one movement with fast, detailed feedback."
            containerStyle={styles.modeCardSlot}
            style={[styles.modeCardShell, styles.modeCardPrimary]}
            onPress={() => navigation.navigate('Analyze', { source: 'camera' })}
          >
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
            accessibilityLabel="Drill Library. Guided drills you can search."
            containerStyle={styles.modeCardSlot}
            style={[styles.modeCardShell, styles.modeCardSecondary]}
            onPress={() => navigation.navigate('DrillLibrary')}
          >
            <View style={styles.modeCardInner}>
              <View style={styles.modeCardTop}>
                <View style={[styles.modeIconChip, styles.modeIconChipLight]}>
                  <Icon name="library" color={color.courtDeep} size={20} />
                </View>
                <Icon name="arrow" color={color.inkSoft} size={17} />
              </View>
              <View>
                <Text style={[type.bodyBold, styles.modeTitleLight]}>
                  Drill Library
                </Text>
                <Text style={[type.caption, styles.modeCaptionLight]}>
                  Guided practice, searchable
                </Text>
              </View>
            </View>
          </PressableScale>
        </View>

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
                No reads yet
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
              )} result${
                shot.overallScore === null
                  ? ''
                  : `, ${duprAccessibilityLabel(shot.overallScore)}`
              }`}
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
              {shot.overallScore === null ? (
                <Text style={[type.score, styles.recentScore]}>—</Text>
              ) : (
                <DuprReadout
                  score={shot.overallScore}
                  valueStyle={[type.score, styles.recentScore]}
                  accessible={false}
                  style={styles.recentRating}
                />
              )}
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
  },
  topBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  topBarStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
    gap: space.sm,
  },
  topBadges: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 7,
    maxWidth: '100%',
    minWidth: 0,
  },
  streakBadgeSlot: { maxWidth: '100%', flexShrink: 1, alignSelf: 'center' },
  streakBadge: {
    minHeight: 32,
    minWidth: 48,
    paddingHorizontal: 9,
    paddingVertical: space.xs,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    backgroundColor: color.surfaceElevated,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  streakBadgeLarge: {
    height: 'auto',
    minHeight: 44,
    paddingVertical: space.xs,
  },
  streakValue: {
    color: color.ink,
    fontVariant: ['tabular-nums'],
    flexShrink: 1,
    minWidth: 0,
  },
  welcome: { color: color.ink, marginTop: space.xl, marginBottom: space.lg },
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
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.line,
    paddingHorizontal: space.md,
    marginBottom: 9,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
  },
  recentDate: { width: 38 },
  recentScore: {
    color: color.ink,
    marginLeft: 2,
  },
  recentRating: { flexShrink: 0 },
});
