export const TRAINING_PLAN_ALGORITHM_VERSION = "priority-checkpoint-v1";

export interface PracticeStreak {
  currentDays: number;
  longestDays: number;
  practicedToday: boolean;
  lastPracticeDate: string | null;
}

const DAY_MS = 86_400_000;

function dateToDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / DAY_MS) : null;
}

/**
 * Computes a timezone-local practice streak from already-localized ISO dates.
 * A streak remains current until the end of the day after the last practice,
 * which avoids showing zero before an athlete has had today's opportunity.
 */
export function computePracticeStreak(
  practiceDates: readonly string[],
  today: string,
): PracticeStreak {
  const todayDay = dateToDay(today);
  if (todayDay === null) throw new Error(`Invalid local date: ${today}`);

  const uniqueDays = [
    ...new Set(practiceDates.map(dateToDay).filter((d): d is number => d !== null)),
  ]
    .filter((d) => d <= todayDay)
    .sort((a, b) => a - b);
  if (uniqueDays.length === 0) {
    return { currentDays: 0, longestDays: 0, practicedToday: false, lastPracticeDate: null };
  }

  let longestDays = 1;
  let run = 1;
  for (let i = 1; i < uniqueDays.length; i += 1) {
    if (uniqueDays[i] === uniqueDays[i - 1]! + 1) {
      run += 1;
      longestDays = Math.max(longestDays, run);
    } else {
      run = 1;
    }
  }

  const latestDay = uniqueDays[uniqueDays.length - 1]!;
  let currentDays = 0;
  if (latestDay === todayDay || latestDay === todayDay - 1) {
    currentDays = 1;
    for (let i = uniqueDays.length - 2; i >= 0; i -= 1) {
      const newer = uniqueDays[i + 1]!;
      const older = uniqueDays[i]!;
      if (older !== newer - 1) break;
      currentDays += 1;
    }
  }

  return {
    currentDays,
    longestDays,
    practicedToday: latestDay === todayDay,
    lastPracticeDate: new Date(latestDay * DAY_MS).toISOString().slice(0, 10),
  };
}

export interface PrescriptionCandidate {
  drillId: string;
  slug: string;
  planRole: "warmup" | "targeted";
  faultDirections: string[];
  priority: number;
  difficultyMin: string | null;
  difficultyMax: string | null;
}

function numericSkill(value: string | null): number | null {
  if (value === null || !/^\d(?:\.\d)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function skillCompatible(candidate: PrescriptionCandidate, athleteSkill: string | null): boolean {
  const user = numericSkill(athleteSkill);
  if (user === null) return true;
  const min = numericSkill(candidate.difficultyMin);
  const max = numericSkill(candidate.difficultyMax);
  return (min === null || user >= min) && (max === null || user <= max);
}

/** Stable ranking makes a source shot + reviewed catalog deterministically
 * produce one warm-up and two targeted drills. */
export function selectPlanPrescriptions(
  candidates: readonly PrescriptionCandidate[],
  faultDirection: string,
  athleteSkill: string | null,
): PrescriptionCandidate[] | null {
  const ranked = candidates
    .filter((candidate) => {
      const directionMatches =
        candidate.faultDirections.length === 0 ||
        candidate.faultDirections.includes(faultDirection);
      return directionMatches && skillCompatible(candidate, athleteSkill);
    })
    .sort((a, b) => {
      const aExact = a.faultDirections.includes(faultDirection) ? 1 : 0;
      const bExact = b.faultDirections.includes(faultDirection) ? 1 : 0;
      return (
        bExact - aExact ||
        b.priority - a.priority ||
        (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0)
      );
    });

  const warmup = ranked.find((candidate) => candidate.planRole === "warmup");
  const targeted = ranked.filter((candidate) => candidate.planRole === "targeted").slice(0, 2);
  if (!warmup || targeted.length !== 2) return null;
  return [warmup, ...targeted];
}

export interface CompletionTarget {
  targetSets: number;
  targetRepetitionsPerSet: number | null;
  targetDurationSeconds: number | null;
}

export function meetsCompletionTarget(
  target: CompletionTarget,
  actualRepetitions: number | null,
  actualDurationSeconds: number | null,
): boolean {
  if (target.targetRepetitionsPerSet !== null) {
    return (
      actualRepetitions !== null &&
      actualRepetitions >= target.targetSets * target.targetRepetitionsPerSet
    );
  }
  if (target.targetDurationSeconds !== null) {
    return (
      actualDurationSeconds !== null &&
      actualDurationSeconds >= target.targetSets * target.targetDurationSeconds
    );
  }
  return false;
}

export type ExternalVideoProvider = "youtube" | "vimeo";

export function validateExternalVideoSource(
  provider: ExternalVideoProvider,
  sourceUrl: string,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(sourceUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return provider === "youtube"
    ? ["youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com"].includes(host)
    : ["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(host);
}

export function externalEmbedUrl(provider: ExternalVideoProvider, videoId: string): string | null {
  if (provider === "youtube" && /^[A-Za-z0-9_-]{6,32}$/.test(videoId)) {
    return `https://www.youtube-nocookie.com/embed/${videoId}`;
  }
  if (provider === "vimeo" && /^\d{5,20}$/.test(videoId)) {
    return `https://player.vimeo.com/video/${videoId}`;
  }
  return null;
}
