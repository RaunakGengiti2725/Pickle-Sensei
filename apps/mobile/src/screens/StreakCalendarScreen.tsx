import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import LinearGradient from 'react-native-linear-gradient';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Button,
  Card,
  PressableScale,
  RevealFill,
  ScreenHeader,
  SectionTitle,
} from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import type { RootStackParams } from '../navigation/params';
import {
  dayFromOrdinal,
  dayHeatLevel,
  dayOrdinal,
  flameIntensityForStreak,
  formatDayKey,
  type ConsistencyDay,
  type ConsistencySnapshot,
} from '../consistency/engine';
import { AnimatedFlame, FlameIcon } from '../consistency/FlameIcon';
import { AchievementsShowcase } from '../consistency/AchievementsShowcase';
import {
  badgeArtFor,
  MilestoneBadge,
  RARITY_PALETTE,
} from '../consistency/MilestoneBadge';
import {
  SHIELD_MAX_HELD,
  streakMilestoneById,
} from '../consistency/milestones';
import { useConsistencyStore } from '../consistency/store';
import { plural } from '../util/plural';

/**
 * THE CONSISTENCY PAGE — the streak's home. A GitHub-squares-meets-Liven
 * training calendar: every trained day burns, shielded days show the shield
 * that saved them, consecutive days fuse into a run capsule. Tapping a day
 * opens exactly what was trained — the streak as a history of improvement,
 * not a vanity counter.
 *
 * Below the calendar: the trophy rail (earned + honestly-locked badges) and
 * the Century Club advert while it is still unearned. Nothing here touches
 * the skill rating — discipline and ability stay separate on purpose.
 */

const WEEKDAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

interface MonthCell {
  day: string | null;
  dayOfMonth: number | null;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/** Monday-first weekday index for a YYYY-MM-DD key (zone-independent:
 * ordinal 0 is 1970-01-01, a Thursday). */
function mondayIndex(day: string): number {
  return (((dayOrdinal(day) + 3) % 7) + 7) % 7;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function buildMonthGrid(year: number, month: number): MonthCell[][] {
  const total = daysInMonth(year, month);
  const cells: MonthCell[] = [];
  const lead = mondayIndex(`${year}-${pad2(month + 1)}-01`);
  for (let i = 0; i < lead; i += 1) cells.push({ day: null, dayOfMonth: null });
  for (let dayOfMonth = 1; dayOfMonth <= total; dayOfMonth += 1) {
    cells.push({
      day: `${year}-${pad2(month + 1)}-${pad2(dayOfMonth)}`,
      dayOfMonth,
    });
  }
  while (cells.length % 7 !== 0) cells.push({ day: null, dayOfMonth: null });
  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function addMonths(
  year: number,
  month: number,
  delta: number,
): { year: number; month: number } {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

function prevDayKey(day: string): string {
  return dayFromOrdinal(dayOrdinal(day) - 1);
}

function nextDayKey(day: string): string {
  return dayFromOrdinal(dayOrdinal(day) + 1);
}

/** Today's YYYY-MM-DD in the device zone — the same clock the engine keys
 * days by. */
function localTodayKey(now: Date): string {
  try {
    const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    let year = '';
    let month = '';
    let day = '';
    for (const part of formatter.formatToParts(now)) {
      if (part.type === 'year') year = part.value;
      else if (part.type === 'month') month = part.value;
      else if (part.type === 'day') day = part.value;
    }
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall through to the UTC key below.
  }
  return now.toISOString().slice(0, 10);
}

function monthOf(day: string): { year: number; month: number } {
  return { year: Number(day.slice(0, 4)), month: Number(day.slice(5, 7)) - 1 };
}

const HEAT_TINTS = [
  'transparent',
  'rgba(255,155,66,0.14)',
  'rgba(255,155,66,0.24)',
  'rgba(255,131,41,0.34)',
] as const;

function DayCell(props: {
  cell: MonthCell;
  log: ConsistencyDay | undefined;
  isToday: boolean;
  isFuture: boolean;
  selected: boolean;
  runsLeft: boolean;
  runsRight: boolean;
  onPress: (day: string) => void;
}) {
  const { cell, log } = props;
  if (!cell.day) return <View style={styles.dayCell} />;
  const counted = Boolean(log);
  const heat = dayHeatLevel(log);
  const label = `${cell.day}${
    log
      ? log.shielded
        ? ', shield protected'
        : `, trained, ${log.activities.length} ${plural(
            log.activities.length,
            'activity',
            'activities',
          )}`
      : props.isFuture
        ? ''
        : ', not trained'
  }`;
  return (
    <View style={styles.dayCell}>
      {counted && (props.runsLeft || props.runsRight) ? (
        <View
          pointerEvents="none"
          style={[
            styles.runBand,
            props.runsLeft && styles.runBandLeft,
            props.runsRight && styles.runBandRight,
          ]}
        />
      ) : null}
      <PressableScale
        accessibilityLabel={label}
        accessibilityState={{ selected: props.selected }}
        disabled={!counted}
        onPress={() => props.onPress(cell.day as string)}
        containerStyle={styles.dayPressable}
        style={[
          styles.dayInner,
          counted && !log?.shielded
            ? { backgroundColor: HEAT_TINTS[heat] }
            : null,
          log?.shielded ? styles.dayShielded : null,
          props.isToday ? styles.dayToday : null,
          props.selected ? styles.daySelected : null,
        ]}
      >
        {log ? (
          log.shielded ? (
            <Icon name="shield" color={color.mint} size={15} />
          ) : (
            <FlameIcon
              intensity={heat === 1 ? 1 : heat === 2 ? 2 : 3}
              size={heat === 1 ? 15 : heat === 2 ? 17 : 19}
            />
          )
        ) : (
          <View
            style={[styles.dayDot, props.isFuture && styles.dayDotFuture]}
          />
        )}
        <Text
          style={[
            styles.dayNumber,
            props.isFuture && styles.dayNumberFuture,
            props.isToday && styles.dayNumberToday,
          ]}
        >
          {cell.dayOfMonth}
        </Text>
      </PressableScale>
    </View>
  );
}

function ShieldRow(props: { available: number }) {
  return (
    <View style={styles.shieldRow}>
      {Array.from({ length: SHIELD_MAX_HELD }, (_, index) => (
        <View
          key={index}
          style={[
            styles.shieldSlot,
            index < props.available && styles.shieldSlotFull,
          ]}
        >
          <Icon
            name="shield"
            color={index < props.available ? color.mint : color.onDarkFaint}
            size={14}
          />
        </View>
      ))}
    </View>
  );
}

/** The subtle Century Club advert — a permanent badge worth wanting. */
function CenturyAdvert(props: { snapshot: ConsistencySnapshot }) {
  const milestone = streakMilestoneById('streak.100');
  if (!milestone) return null;
  if (props.snapshot.earned.some(e => e.id === 'streak.100')) return null;
  const daysAway = milestone.days - props.snapshot.currentStreak;
  const art = badgeArtFor('streak.100');
  const palette = RARITY_PALETTE[milestone.rarity];
  return (
    <View
      accessibilityLabel={`Century Club: ${daysAway} days away. Permanent badge.`}
      style={styles.centuryCard}
    >
      <LinearGradient
        colors={[color.surfaceDark, '#152a1f']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      />
      <MilestoneBadge
        glyph={art.glyph}
        {...(art.value !== undefined ? { value: art.value } : {})}
        rarity={milestone.rarity}
        earned={false}
        size={54}
      />
      <View style={styles.centuryBody}>
        <Text style={[type.micro, { color: palette.accent }]}>
          {daysAway} {plural(daysAway, 'DAY').toUpperCase()} AWAY
        </Text>
        <Text style={[type.bodyBold, { color: color.onDark, marginTop: 2 }]}>
          Century Club
        </Text>
        <Text style={[type.caption, styles.centuryCopy]}>
          100 straight days. Permanent badge — it never expires, and almost
          nobody has it.
        </Text>
      </View>
    </View>
  );
}

export function StreakCalendarScreen() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const snapshot = useConsistencyStore(s => s.snapshot);
  const loadError = useConsistencyStore(s => s.loadError);
  const refresh = useConsistencyStore(s => s.refresh);

  useFocusEffect(
    useCallback(() => {
      void refresh();
    }, [refresh]),
  );

  const asOfDay = snapshot?.asOfDay ?? localTodayKey(new Date());
  const [visible, setVisible] = useState(() => monthOf(asOfDay));
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);

  // Anchor the month and open today's log once the first snapshot lands —
  // after that the month and the selection belong to the user (deselecting
  // must stay deselected).
  useEffect(() => {
    if (autoSelected || !snapshot) return;
    setAutoSelected(true);
    setVisible(monthOf(snapshot.asOfDay));
    if (snapshot.trainedToday) setSelectedDay(snapshot.asOfDay);
  }, [autoSelected, snapshot]);

  const weeks = useMemo(
    () => buildMonthGrid(visible.year, visible.month),
    [visible],
  );
  const earliestDay = useMemo(() => {
    if (!snapshot) return asOfDay;
    const keys = Object.keys(snapshot.days);
    return keys.length > 0 ? keys.reduce((a, b) => (a < b ? a : b)) : asOfDay;
  }, [asOfDay, snapshot]);
  const currentMonth = monthOf(asOfDay);
  const earliestMonth = monthOf(earliestDay);
  const atCurrentMonth =
    visible.year === currentMonth.year && visible.month === currentMonth.month;
  const atEarliestMonth =
    visible.year === earliestMonth.year &&
    visible.month === earliestMonth.month;

  const streak = snapshot?.currentStreak ?? 0;
  const intensity = flameIntensityForStreak(streak);
  const selectedLog = selectedDay ? snapshot?.days[selectedDay] : undefined;
  const next = snapshot?.nextStreakMilestone ?? null;
  const momentum = snapshot?.momentum ?? {
    level: 1,
    xpIntoLevel: 0,
    xpForNextLevel: 40,
  };
  const levelFraction = Math.min(
    1,
    momentum.xpForNextLevel > 0
      ? momentum.xpIntoLevel / momentum.xpForNextLevel
      : 0,
  );

  const statusLine =
    !snapshot || snapshot.totalActivities === 0
      ? 'Your first analysis lights the flame.'
      : snapshot.atRisk
        ? 'No training yet today — one analysis keeps the flame alive.'
        : snapshot.trainedToday
          ? `Day ${streak} secured. You trained ${snapshot.trainedLast7} of the last 7 days.`
          : `You trained ${snapshot.trainedLast7} of the last 7 days.`;

  if (!snapshot && loadError) {
    return (
      <SafeAreaView edges={['top']} style={styles.screen}>
        <StatusBar barStyle="dark-content" />
        <ScreenHeader
          title="Consistency"
          eyebrow="Training streak"
          onBack={() => navigation.goBack()}
        />
        <View style={styles.content}>
          <Card
            tone="light"
            style={styles.loadErrorCard}
            testID="streak-load-error"
          >
            <View accessibilityRole="alert" accessibilityLiveRegion="assertive">
              <Text style={[type.h3, { color: color.ink }]}>
                Couldn’t load your training history
              </Text>
              <Text style={[type.caption, styles.loadErrorCopy]}>
                Your streak and calendar are stored on this device and could not
                be read just now. Your streak is not shown until it can be.
              </Text>
            </View>
            <View style={{ marginTop: space.md }}>
              <Button
                label="Try again"
                variant="secondary"
                onPress={() => void refresh()}
              />
            </View>
          </Card>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <StatusBar barStyle="dark-content" />
      <ScreenHeader
        title="Consistency"
        eyebrow="Training streak"
        onBack={() => navigation.goBack()}
      />
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* ---- Streak hero ---------------------------------------------- */}
        <View style={styles.hero} testID="streak-hero">
          <LinearGradient
            colors={[color.courtDeep, color.surfaceDark]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            pointerEvents="none"
            style={StyleSheet.absoluteFill}
          />
          <View style={styles.heroTop}>
            <View style={styles.heroFlame}>
              <AnimatedFlame intensity={intensity} size={54} />
            </View>
            <View style={styles.heroCount}>
              <Text style={styles.heroStreak}>{streak}</Text>
              <Text style={[type.h3, styles.heroStreakLabel]}>
                {plural(streak, 'DAY', 'DAY')} STREAK
              </Text>
            </View>
          </View>
          <Text style={[type.caption, styles.heroStatus]}>{statusLine}</Text>

          <View style={styles.momentumBlock}>
            <View style={styles.momentumHeader}>
              <Text style={[type.micro, { color: color.volt }]}>
                MOMENTUM LEVEL {momentum.level}
              </Text>
              <Text style={[type.micro, styles.momentumXp]}>
                {snapshot?.momentumXp ?? 0} XP
              </Text>
            </View>
            <View style={styles.momentumTrack}>
              <RevealFill
                style={[
                  styles.momentumFill,
                  { width: `${Math.max(4, levelFraction * 100)}%` },
                ]}
              />
            </View>
            <Text style={[type.micro, styles.momentumNext]}>
              {momentum.xpForNextLevel - momentum.xpIntoLevel} XP TO LEVEL{' '}
              {momentum.level + 1}
            </Text>
          </View>

          <View style={styles.heroStats}>
            <View style={styles.heroStat}>
              <Text style={styles.heroStatValue}>
                {snapshot?.longestStreak ?? 0}
              </Text>
              <Text style={styles.heroStatLabel}>LONGEST</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <ShieldRow available={snapshot?.shieldsAvailable ?? 0} />
              <Text style={styles.heroStatLabel}>SHIELDS</Text>
            </View>
            <View style={styles.heroStatDivider} />
            <View style={styles.heroStat}>
              <Text style={styles.heroStatValue}>
                {snapshot?.totalTrainedDays ?? 0}
              </Text>
              <Text style={styles.heroStatLabel}>DAYS TRAINED</Text>
            </View>
          </View>

          {next ? (
            <View style={styles.nextReward}>
              <MilestoneBadge
                glyph={badgeArtFor(next.id).glyph}
                {...(badgeArtFor(next.id).value !== undefined
                  ? { value: badgeArtFor(next.id).value }
                  : {})}
                rarity={next.rarity}
                earned={false}
                size={40}
              />
              <Text style={[type.caption, styles.nextRewardText]}>
                Next reward: {next.title} — {next.daysAway}{' '}
                {plural(next.daysAway, 'day')} away
              </Text>
            </View>
          ) : null}
        </View>

        {/* ---- Calendar -------------------------------------------------- */}
        <SectionTitle title="Calendar" />
        <Card style={styles.calendarCard}>
          <View style={styles.monthNav}>
            <PressableScale
              accessibilityLabel="Previous month"
              disabled={atEarliestMonth}
              hitSlop={6}
              onPress={() => setVisible(v => addMonths(v.year, v.month, -1))}
              style={[
                styles.monthArrow,
                atEarliestMonth && styles.monthArrowDisabled,
              ]}
            >
              <Icon name="back" color={color.ink} size={17} />
            </PressableScale>
            <Text style={[type.h3, { color: color.ink }]}>
              {MONTH_NAMES[visible.month]} {visible.year}
            </Text>
            <PressableScale
              accessibilityLabel="Next month"
              disabled={atCurrentMonth}
              hitSlop={6}
              onPress={() => setVisible(v => addMonths(v.year, v.month, 1))}
              style={[
                styles.monthArrow,
                atCurrentMonth && styles.monthArrowDisabled,
              ]}
            >
              <Icon name="arrow" color={color.ink} size={17} />
            </PressableScale>
          </View>
          <View style={styles.weekdayRow}>
            {WEEKDAY_LABELS.map((label, index) => (
              <Text key={index} style={[type.micro, styles.weekdayLabel]}>
                {label}
              </Text>
            ))}
          </View>
          {weeks.map((week, weekIndex) => (
            <View key={weekIndex} style={styles.weekRow}>
              {week.map((cell, cellIndex) => {
                const log = cell.day ? snapshot?.days[cell.day] : undefined;
                const counted = Boolean(log);
                const leftDay = cell.day ? prevDayKey(cell.day) : null;
                const rightDay = cell.day ? nextDayKey(cell.day) : null;
                return (
                  <DayCell
                    key={cellIndex}
                    cell={cell}
                    log={log}
                    isToday={cell.day === asOfDay}
                    isFuture={Boolean(cell.day && cell.day > asOfDay)}
                    selected={Boolean(cell.day && cell.day === selectedDay)}
                    runsLeft={
                      counted &&
                      cellIndex > 0 &&
                      Boolean(leftDay && snapshot?.days[leftDay])
                    }
                    runsRight={
                      counted &&
                      cellIndex < 6 &&
                      Boolean(rightDay && snapshot?.days[rightDay])
                    }
                    onPress={day =>
                      setSelectedDay(current => (current === day ? null : day))
                    }
                  />
                );
              })}
            </View>
          ))}
          <View style={styles.legendRow}>
            <View style={styles.legendItem}>
              <FlameIcon intensity={2} size={13} />
              <Text style={[type.micro, styles.legendLabel]}>TRAINED</Text>
            </View>
            <View style={styles.legendItem}>
              <Icon name="shield" color={color.mint} size={13} />
              <Text style={[type.micro, styles.legendLabel]}>SHIELDED</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={styles.dayDot} />
              <Text style={[type.micro, styles.legendLabel]}>REST</Text>
            </View>
          </View>
        </Card>

        {/* ---- Selected day detail --------------------------------------- */}
        {selectedDay ? (
          <Card
            tone={selectedLog ? 'soft' : 'light'}
            style={styles.dayDetail}
            testID="streak-day-detail"
          >
            <Text style={[type.h3, { color: color.ink }]}>
              {formatDayKey(selectedDay, {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
            </Text>
            {selectedLog ? (
              selectedLog.shielded ? (
                <View style={styles.shieldNote}>
                  <Icon name="shield" color={color.court} size={18} />
                  <Text
                    style={[type.caption, { color: color.inkSoft, flex: 1 }]}
                  >
                    A Streak Shield protected this day. No training logged — the
                    run survived.
                  </Text>
                </View>
              ) : (
                <>
                  <View style={styles.dayChips}>
                    <Text style={[type.micro, styles.dayChip]}>
                      {selectedLog.activities.length}{' '}
                      {plural(
                        selectedLog.activities.length,
                        'ACTIVITY',
                        'ACTIVITIES',
                      )}
                    </Text>
                    {selectedLog.scoreAvg !== null ? (
                      <Text style={[type.micro, styles.dayChip]}>
                        AVG {selectedLog.scoreAvg.toFixed(1)}
                      </Text>
                    ) : null}
                    <Text style={[type.micro, styles.dayChipVolt]}>
                      +{selectedLog.xp} XP
                    </Text>
                  </View>
                  {selectedLog.activities.map((activity, index) => (
                    <View key={index} style={styles.activityRow}>
                      <View style={styles.activityIcon}>
                        <Icon
                          name={
                            activity.kind === 'drill'
                              ? 'library'
                              : activity.kind === 'session_stroke'
                                ? 'court'
                                : 'camera'
                          }
                          color={color.court}
                          size={15}
                        />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text
                          numberOfLines={1}
                          style={[type.bodyBold, styles.activityLabel]}
                        >
                          {activity.label}
                        </Text>
                        <Text style={[type.micro, styles.activityTime]}>
                          {new Date(activity.atIso).toLocaleTimeString(
                            undefined,
                            { hour: 'numeric', minute: '2-digit' },
                          )}
                          {activity.kind === 'session_stroke'
                            ? ' · SESSION'
                            : activity.kind === 'drill'
                              ? ' · DRILL'
                              : ''}
                        </Text>
                      </View>
                      <Text style={styles.activityScore}>
                        {activity.score === null
                          ? '—'
                          : activity.score.toFixed(1)}
                      </Text>
                    </View>
                  ))}
                </>
              )
            ) : (
              <Text style={[type.caption, { color: color.inkSoft }]}>
                No training logged this day.
              </Text>
            )}
          </Card>
        ) : null}

        {/* ---- Achievements ---------------------------------------------- */}
        <SectionTitle title="Achievements" />
        {snapshot ? <AchievementsShowcase snapshot={snapshot} /> : null}
        {snapshot ? <CenturyAdvert snapshot={snapshot} /> : null}

        <Text style={[type.caption, styles.footnote]}>
          A day counts when you complete a stroke analysis, a session stroke, or
          a prescribed drill — opening the app never counts. Streaks earn
          identity and Momentum XP only; your skill rating moves on scored
          evidence alone.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: color.surface },
  content: {
    paddingHorizontal: space.lg,
    paddingBottom: space.xxxl,
  },
  hero: {
    borderRadius: radius.xl,
    padding: space.lg,
    backgroundColor: color.surfaceDark,
    overflow: 'hidden',
    marginTop: space.sm,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroFlame: {
    width: 84,
    height: 84,
    borderRadius: 42,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,155,66,0.12)',
  },
  heroCount: { flex: 1 },
  heroStreak: {
    ...type.display,
    color: color.onDark,
    fontSize: 56,
    lineHeight: 60,
  },
  heroStreakLabel: { color: color.onDarkMuted, letterSpacing: 2 },
  heroStatus: { color: color.onDarkSubtle, marginTop: space.md },
  momentumBlock: { marginTop: space.md },
  momentumHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  momentumXp: { color: color.onDarkSubtle },
  momentumTrack: {
    height: 8,
    borderRadius: 4,
    backgroundColor: color.onDarkTint,
    marginTop: 7,
    overflow: 'hidden',
  },
  momentumFill: {
    height: '100%',
    borderRadius: 4,
    backgroundColor: color.volt,
  },
  momentumNext: { color: color.onDarkFaint, marginTop: 6, letterSpacing: 0.8 },
  heroStats: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: space.md,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.lineMutedDark,
  },
  heroStat: { flex: 1, alignItems: 'center', gap: 3 },
  heroStatDivider: {
    width: StyleSheet.hairlineWidth,
    height: 30,
    backgroundColor: color.lineMutedDark,
  },
  heroStatValue: {
    ...type.h2,
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  heroStatLabel: {
    ...type.micro,
    color: color.onDarkFaint,
    fontSize: 10,
    letterSpacing: 1,
  },
  shieldRow: { flexDirection: 'row', gap: 5, paddingVertical: 4 },
  shieldSlot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
  },
  shieldSlotFull: { backgroundColor: 'rgba(83,217,155,0.18)' },
  nextReward: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginTop: space.md,
    padding: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineMutedDark,
  },
  nextRewardText: { color: color.onDarkMuted, flex: 1 },
  calendarCard: { paddingHorizontal: space.md, paddingVertical: space.md },
  monthNav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: space.sm,
  },
  monthArrow: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.surfaceAlt,
  },
  monthArrowDisabled: { opacity: 0.35 },
  loadErrorCard: { marginTop: space.sm },
  loadErrorCopy: { color: color.inkSoft, marginTop: space.sm },
  weekdayRow: { flexDirection: 'row', marginBottom: 4 },
  weekdayLabel: {
    flex: 1,
    textAlign: 'center',
    color: color.inkSoft,
    letterSpacing: 1,
  },
  weekRow: { flexDirection: 'row', marginTop: 4 },
  dayCell: { flex: 1, aspectRatio: 0.86, position: 'relative' },
  runBand: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: '14%',
    height: '58%',
    backgroundColor: 'rgba(255,155,66,0.1)',
  },
  runBandLeft: { left: -2 },
  runBandRight: { right: -2 },
  dayPressable: { flex: 1 },
  dayInner: {
    flex: 1,
    margin: 1.5,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingVertical: 3,
  },
  dayShielded: { backgroundColor: 'rgba(83,217,155,0.14)' },
  dayToday: {
    borderWidth: 1.6,
    borderColor: color.court,
  },
  daySelected: { backgroundColor: color.courtSoft },
  dayDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    backgroundColor: color.line,
  },
  dayDotFuture: { backgroundColor: 'transparent' },
  dayNumber: {
    ...type.micro,
    color: color.inkSoft,
    fontSize: 10,
    fontVariant: ['tabular-nums'],
  },
  dayNumberFuture: { color: color.line },
  dayNumberToday: { color: color.court },
  legendRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: space.md,
    marginTop: space.md,
    paddingTop: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendLabel: { color: color.inkSoft, fontSize: 10, letterSpacing: 0.8 },
  dayDetail: { marginTop: space.md },
  dayChips: { flexDirection: 'row', gap: 7, marginTop: space.sm },
  dayChip: {
    color: color.court,
    backgroundColor: color.courtSoft,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    letterSpacing: 0.6,
  },
  dayChipVolt: {
    color: color.onVolt,
    backgroundColor: color.volt,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: radius.pill,
    overflow: 'hidden',
    letterSpacing: 0.6,
  },
  shieldNote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.sm,
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm + 2,
    marginTop: space.sm + 2,
  },
  activityIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.courtSoft,
  },
  activityLabel: { color: color.ink, textTransform: 'capitalize' },
  activityTime: { color: color.inkSoft, marginTop: 1, letterSpacing: 0.5 },
  activityScore: {
    ...type.h3,
    color: color.ink,
    fontVariant: ['tabular-nums'],
  },
  centuryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    backgroundColor: color.surfaceDark,
    overflow: 'hidden',
  },
  centuryBody: { flex: 1, minWidth: 0 },
  centuryCopy: { color: color.onDarkSubtle, marginTop: 3 },
  footnote: {
    color: color.inkSoft,
    marginTop: space.lg,
    lineHeight: 17,
  },
});
