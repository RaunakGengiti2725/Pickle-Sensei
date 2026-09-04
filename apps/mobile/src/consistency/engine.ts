import {
  momentumLevelForXp,
  SHIELD_EARN_EVERY_DAYS,
  SHIELD_MAX_HELD,
  STREAK_MILESTONES,
  VOLUME_ACHIEVEMENTS,
  XP_EXTRA_ACTIVITY_CAP,
  XP_PER_EXTRA_ACTIVITY,
  XP_PER_TRAINED_DAY,
  type MomentumLevelState,
  type StreakMilestone,
} from './milestones';

/**
 * The consistency engine — pure and deterministic. A calendar day counts
 * ONLY when the player did something meaningful: completed a stroke
 * analysis (scored or honestly abstained — the swing happened), a session
 * analysis stroke, or a prescribed drill. App opens never count.
 *
 * Everything here is derived from the full activity history on every run
 * (no incremental mutation), so the streak, shields, XP, and milestones can
 * never drift from the underlying evidence — the same replay-from-facts
 * philosophy as playerRank.
 *
 * Streak Shields: every 7 consecutive trained days banks one (holding at
 * most 2). A missed day consumes one automatically and the run survives —
 * a flight or a fever does not erase 90 honest days. Misses beyond the
 * banked shields break the run. Shielded days add no XP and do not grow
 * the streak count; they only bridge it.
 *
 * All day math is LOCAL calendar days via the same Intl day-key approach as
 * practiceHistory.ts — streaks belong to the player's clock.
 */

export type TrainingActivityKind = 'stroke' | 'session_stroke' | 'drill';

export interface TrainingActivityInput {
  kind: TrainingActivityKind;
  /** ISO-8601 instant the activity happened. */
  atIso: string;
  /** Stroke/session activities: the technique. Drills: undefined. */
  shotType?: string;
  /** 0-10 score when the analysis scored; null/undefined otherwise. */
  overallScore?: number | null;
  /** 'scored' | 'low_confidence' | … for analyses. */
  resultKind?: string;
  /** Drill title for the day detail list. */
  label?: string;
}

export interface ConsistencyDayActivity {
  kind: TrainingActivityKind;
  label: string;
  score: number | null;
  atIso: string;
}

export interface ConsistencyDay {
  day: string;
  /** True when this day was bridged by a Streak Shield (not trained). */
  shielded: boolean;
  strokeCount: number;
  sessionStrokeCount: number;
  drillCount: number;
  scoredCount: number;
  /** Mean of the day's scored analyses, 1 decimal; null when none scored. */
  scoreAvg: number | null;
  activities: ConsistencyDayActivity[];
  /** Momentum XP earned on this day (0 for shielded days). */
  xp: number;
}

export interface EarnedAchievement {
  id: string;
  earnedOnDay: string;
  /** e.g. the technique name behind a Specialist crest. */
  detail?: string;
}

export interface ConsistencySnapshot {
  asOfDay: string;
  timeZone: string;
  /** Trained and shielded days only, keyed by YYYY-MM-DD. */
  days: Record<string, ConsistencyDay>;
  trainedToday: boolean;
  /** Consecutive trained days in the current (possibly shield-bridged) run. */
  currentStreak: number;
  /** True when a live run has nothing logged today yet. */
  atRisk: boolean;
  longestStreak: number;
  shieldsAvailable: number;
  shieldsEarnedTotal: number;
  shieldedDayCount: number;
  momentumXp: number;
  momentum: MomentumLevelState;
  /** Momentum XP earned during the current run. */
  runXp: number;
  /** Trained days among the most recent 7 calendar days (today inclusive). */
  trainedLast7: number;
  totalTrainedDays: number;
  totalActivities: number;
  scoredAnalysisCount: number;
  earned: EarnedAchievement[];
  /** The next streak milestone the current run can reach. */
  nextStreakMilestone: (StreakMilestone & { daysAway: number }) | null;
}

export interface ConsistencyEngineOptions {
  asOfIso: string;
  timeZone: string;
}

const DAY_MS = 86_400_000;

function makeDayFormatter(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
}

function dayForInstant(
  timestampMs: number,
  formatter: Intl.DateTimeFormat,
): string {
  let year = '';
  let month = '';
  let day = '';
  for (const part of formatter.formatToParts(new Date(timestampMs))) {
    if (part.type === 'year') year = part.value;
    else if (part.type === 'month') month = part.value;
    else if (part.type === 'day') day = part.value;
  }
  return `${year}-${month}-${day}`;
}

export function dayOrdinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

export function dayFromOrdinal(ordinal: number): string {
  return new Date(ordinal * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Renders a YYYY-MM-DD day key as THAT calendar date in the device locale.
 * The key is anchored at noon UTC and formatted in UTC, so the label can
 * never drift to a neighbouring day in the device zone (a UTC+13 device
 * would otherwise read 12:00Z as 01:00 of the next morning).
 */
export function formatDayKey(
  day: string,
  options: Omit<Intl.DateTimeFormatOptions, 'timeZone'>,
): string {
  const parsed = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return day;
  return parsed.toLocaleDateString(undefined, { ...options, timeZone: 'UTC' });
}

interface MutableDay {
  day: string;
  strokeCount: number;
  sessionStrokeCount: number;
  drillCount: number;
  scoredCount: number;
  scoreSum: number;
  activities: ConsistencyDayActivity[];
}

function humanizeShotType(value: string): string {
  return value.replace(/_/g, ' ');
}

export function specialistTitle(detail: string): string {
  const technique = humanizeShotType(detail)
    .split(' ')
    .filter(word => word.length > 0)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(' ');
  return `${technique} Specialist`;
}

function activityLabel(input: TrainingActivityInput): string {
  if (input.label) return input.label;
  if (input.shotType) return humanizeShotType(input.shotType);
  return input.kind === 'drill' ? 'Drill' : 'Stroke analysis';
}

/** Empty snapshot for a player with no history yet. */
function emptySnapshot(asOfDay: string, timeZone: string): ConsistencySnapshot {
  return {
    asOfDay,
    timeZone,
    days: {},
    trainedToday: false,
    currentStreak: 0,
    atRisk: false,
    longestStreak: 0,
    shieldsAvailable: 0,
    shieldsEarnedTotal: 0,
    shieldedDayCount: 0,
    momentumXp: 0,
    momentum: momentumLevelForXp(0),
    runXp: 0,
    trainedLast7: 0,
    totalTrainedDays: 0,
    totalActivities: 0,
    scoredAnalysisCount: 0,
    earned: [],
    nextStreakMilestone:
      STREAK_MILESTONES.length > 0
        ? { ...STREAK_MILESTONES[0]!, daysAway: STREAK_MILESTONES[0]!.days }
        : null,
  };
}

export function buildConsistencySnapshot(
  activities: readonly TrainingActivityInput[],
  options: ConsistencyEngineOptions,
): ConsistencySnapshot {
  const formatter = makeDayFormatter(options.timeZone);
  const timeZone = formatter.resolvedOptions().timeZone;
  const asOfMs = Date.parse(options.asOfIso);
  const asOfDay = dayForInstant(
    Number.isFinite(asOfMs) ? asOfMs : Date.now(),
    formatter,
  );
  const asOfOrdinal = dayOrdinal(asOfDay);

  // ---- Bucket every valid activity into its local calendar day. ----------
  const byDay = new Map<string, MutableDay>();
  let totalActivities = 0;
  let scoredAnalysisCount = 0;
  const scoredByTechnique = new Map<string, number>();
  for (const input of activities) {
    const atMs = Date.parse(input.atIso);
    if (!Number.isFinite(atMs) || atMs > (asOfMs || Number.POSITIVE_INFINITY)) {
      continue;
    }
    const day = dayForInstant(atMs, formatter);
    if (dayOrdinal(day) > asOfOrdinal) continue;
    let bucket = byDay.get(day);
    if (!bucket) {
      bucket = {
        day,
        strokeCount: 0,
        sessionStrokeCount: 0,
        drillCount: 0,
        scoredCount: 0,
        scoreSum: 0,
        activities: [],
      };
      byDay.set(day, bucket);
    }
    totalActivities += 1;
    if (input.kind === 'stroke') bucket.strokeCount += 1;
    else if (input.kind === 'session_stroke') bucket.sessionStrokeCount += 1;
    else bucket.drillCount += 1;
    const scored =
      input.resultKind === 'scored' &&
      typeof input.overallScore === 'number' &&
      Number.isFinite(input.overallScore);
    if (scored) {
      bucket.scoredCount += 1;
      bucket.scoreSum += input.overallScore as number;
      scoredAnalysisCount += 1;
      if (input.shotType) {
        scoredByTechnique.set(
          input.shotType,
          (scoredByTechnique.get(input.shotType) ?? 0) + 1,
        );
      }
    }
    bucket.activities.push({
      kind: input.kind,
      label: activityLabel(input),
      score: scored ? (input.overallScore as number) : null,
      atIso: input.atIso,
    });
  }

  if (byDay.size === 0) return emptySnapshot(asOfDay, timeZone);

  const trainedOrdinals = [...byDay.keys()]
    .map(dayOrdinal)
    .sort((a, b) => a - b);
  const firstOrdinal = trainedOrdinals[0]!;

  // ---- Chronological walk: streaks, shields, XP, milestone unlock days. --
  const days: Record<string, ConsistencyDay> = {};
  let run = 0;
  let longestStreak = 0;
  let shieldsAvailable = 0;
  let shieldsEarnedTotal = 0;
  let shieldedDayCount = 0;
  let momentumXp = 0;
  let runXp = 0;
  let totalTrainedDays = 0;
  let cumulativeActivities = 0;
  const awardedXpMilestones = new Set<number>();
  const earned: EarnedAchievement[] = [];
  const earnedIds = new Set<string>();
  let sessions100Done = false;

  for (let ordinal = firstOrdinal; ordinal <= asOfOrdinal; ordinal += 1) {
    const day = dayFromOrdinal(ordinal);
    const bucket = byDay.get(day);
    if (bucket) {
      run += 1;
      totalTrainedDays += 1;
      if (run > longestStreak) longestStreak = run;

      const extraActivities = bucket.activities.length - 1;
      let xp =
        XP_PER_TRAINED_DAY +
        Math.min(
          extraActivities * XP_PER_EXTRA_ACTIVITY,
          XP_EXTRA_ACTIVITY_CAP,
        );
      for (const milestone of STREAK_MILESTONES) {
        if (
          run === milestone.days &&
          !awardedXpMilestones.has(milestone.days)
        ) {
          awardedXpMilestones.add(milestone.days);
          xp += milestone.bonusXp;
        }
        if (run === milestone.days && !earnedIds.has(milestone.id)) {
          earnedIds.add(milestone.id);
          earned.push({ id: milestone.id, earnedOnDay: day });
        }
      }
      momentumXp += xp;
      runXp = run === 1 ? xp : runXp + xp;

      if (run % SHIELD_EARN_EVERY_DAYS === 0) {
        shieldsEarnedTotal += 1;
        shieldsAvailable = Math.min(shieldsAvailable + 1, SHIELD_MAX_HELD);
      }

      cumulativeActivities += bucket.activities.length;
      if (
        !sessions100Done &&
        cumulativeActivities >= VOLUME_ACHIEVEMENTS.sessions100.threshold
      ) {
        sessions100Done = true;
        earned.push({
          id: VOLUME_ACHIEVEMENTS.sessions100.id,
          earnedOnDay: day,
        });
      }

      days[day] = {
        day,
        shielded: false,
        strokeCount: bucket.strokeCount,
        sessionStrokeCount: bucket.sessionStrokeCount,
        drillCount: bucket.drillCount,
        scoredCount: bucket.scoredCount,
        scoreAvg:
          bucket.scoredCount > 0
            ? Math.round((bucket.scoreSum / bucket.scoredCount) * 10) / 10
            : null,
        activities: [...bucket.activities].sort(
          (a, b) =>
            (a.atIso < b.atIso ? -1 : a.atIso > b.atIso ? 1 : 0) ||
            a.label.localeCompare(b.label),
        ),
        xp,
      };
      continue;
    }

    // An untrained day. Today is never a miss — the day is still open.
    if (ordinal === asOfOrdinal) break;
    if (run === 0) continue;
    if (shieldsAvailable > 0) {
      shieldsAvailable -= 1;
      shieldedDayCount += 1;
      days[day] = {
        day,
        shielded: true,
        strokeCount: 0,
        sessionStrokeCount: 0,
        drillCount: 0,
        scoredCount: 0,
        scoreAvg: null,
        activities: [],
        xp: 0,
      };
    } else {
      run = 0;
      runXp = 0;
    }
  }

  // Specialist: first technique to cross the scored threshold, alphabetical
  // tie-break for determinism. (Unlock day is coarse — the technique proves
  // the work; the calendar detail is not needed for an accomplishment.)
  const specialist = [...scoredByTechnique.entries()]
    .filter(([, count]) => count >= VOLUME_ACHIEVEMENTS.specialist.threshold)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  if (specialist) {
    earned.push({
      id: VOLUME_ACHIEVEMENTS.specialist.id,
      earnedOnDay: asOfDay,
      detail: humanizeShotType(specialist[0]),
    });
  }

  const trainedToday = byDay.has(asOfDay);
  let trainedLast7 = 0;
  for (let ordinal = asOfOrdinal - 6; ordinal <= asOfOrdinal; ordinal += 1) {
    if (byDay.has(dayFromOrdinal(ordinal))) trainedLast7 += 1;
  }

  const nextMilestone =
    STREAK_MILESTONES.find(milestone => milestone.days > run) ?? null;

  return {
    asOfDay,
    timeZone,
    days,
    trainedToday,
    currentStreak: run,
    atRisk: run > 0 && !trainedToday,
    longestStreak,
    shieldsAvailable,
    shieldsEarnedTotal,
    shieldedDayCount,
    momentumXp,
    momentum: momentumLevelForXp(momentumXp),
    runXp,
    trainedLast7,
    totalTrainedDays,
    totalActivities,
    scoredAnalysisCount,
    earned,
    nextStreakMilestone: nextMilestone
      ? { ...nextMilestone, daysAway: nextMilestone.days - run }
      : null,
  };
}

/** Flame intensity ladder for UI surfaces (0 = no flame … 5 = inferno). */
export function flameIntensityForStreak(streak: number): 0 | 1 | 2 | 3 | 4 | 5 {
  if (streak <= 0) return 0;
  if (streak < 3) return 1;
  if (streak < 7) return 2;
  if (streak < 14) return 3;
  if (streak < 30) return 4;
  return 5;
}

/** Calendar cell heat by that day's activity volume (GitHub-square style). */
export function dayHeatLevel(day: ConsistencyDay | undefined): 0 | 1 | 2 | 3 {
  if (!day || day.shielded) return 0;
  const total = day.strokeCount + day.sessionStrokeCount + day.drillCount;
  if (total <= 0) return 0;
  if (total === 1) return 1;
  if (total <= 3) return 2;
  return 3;
}
