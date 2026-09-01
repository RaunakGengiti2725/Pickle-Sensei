/**
 * The consistency reward ladder. Streak milestones are IDENTITY rewards —
 * badges, crests, celebration effects — never rating points: a
 * 6.2 player who shows up every day is a dedicated 6.2 player, not a 7.1.
 * (The skill rating lives in playerRank and only ever moves on evidence.)
 *
 * Rarity is the advertising language: the further tiers exist to be WANTED.
 * Locked previews (AchievementsShowcase) surface the next one or two with
 * honest "N days away" copy — subtle, persistent, never a popup.
 */

export type AchievementRarity =
  'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'mythic';

export const RARITY_LABEL: Record<AchievementRarity, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  epic: 'Epic',
  legendary: 'Legendary',
  mythic: 'Mythic',
};

export interface StreakMilestone {
  id: string;
  /** Consecutive trained days required. */
  days: number;
  title: string;
  /** One-line celebration copy. */
  blurb: string;
  /** What the milestone unlocks, in reward language. */
  reward: string;
  rarity: AchievementRarity;
  /** One-time Momentum XP bonus granted when a run first reaches it. */
  bonusXp: number;
}

export const STREAK_MILESTONES: readonly StreakMilestone[] = [
  {
    id: 'streak.1',
    days: 1,
    title: 'First Spark',
    blurb: 'Momentum begins with one honest session.',
    reward: 'Momentum XP unlocked',
    rarity: 'common',
    bonusXp: 10,
  },
  {
    id: 'streak.3',
    days: 3,
    title: 'Kindling',
    blurb: 'Three straight days. The flame catches.',
    reward: 'First streak badge',
    rarity: 'common',
    bonusXp: 30,
  },
  {
    id: 'streak.7',
    days: 7,
    title: 'Week One',
    blurb: 'A full week of real training.',
    reward: 'Streak Shield earned',
    rarity: 'uncommon',
    bonusXp: 70,
  },
  {
    id: 'streak.14',
    days: 14,
    title: 'Fortnight Form',
    blurb: 'Two weeks without letting go.',
    reward: 'Rare crossed-paddles badge',
    rarity: 'rare',
    bonusXp: 140,
  },
  {
    id: 'streak.30',
    days: 30,
    title: '30 Day Club',
    blurb: 'A month of showing up. Very few do this.',
    reward: 'Epic laurel badge',
    rarity: 'epic',
    bonusXp: 300,
  },
  {
    id: 'streak.60',
    days: 60,
    title: 'Sixty Deep',
    blurb: 'Two months. This is who you are now.',
    reward: 'Rare celebration effect',
    rarity: 'legendary',
    bonusXp: 600,
  },
  {
    id: 'streak.100',
    days: 100,
    title: 'Century Club',
    blurb: 'One hundred consecutive days of training.',
    reward: 'Permanent Century badge',
    rarity: 'legendary',
    bonusXp: 1000,
  },
  {
    id: 'streak.365',
    days: 365,
    title: 'Eternal Flame',
    blurb: 'A full year. Permanent. Almost nobody owns this.',
    reward: 'Permanent Eternal Flame crest',
    rarity: 'mythic',
    bonusXp: 3650,
  },
] as const;

export function streakMilestoneById(id: string): StreakMilestone | null {
  return STREAK_MILESTONES.find(milestone => milestone.id === id) ?? null;
}

export function streakMilestoneForDays(days: number): StreakMilestone | null {
  return STREAK_MILESTONES.find(milestone => milestone.days === days) ?? null;
}

/** Volume achievements — accomplishment, not consistency. Derived from the
 * same activity history so they can never claim unverified work. */
export const VOLUME_ACHIEVEMENTS = {
  sessions100: {
    id: 'volume.sessions100',
    threshold: 100,
    title: '100 Sessions',
    blurb: 'One hundred logged training activities.',
    reward: 'Volume badge',
    rarity: 'rare' as AchievementRarity,
  },
  specialist: {
    id: 'volume.specialist',
    threshold: 25,
    title: 'Specialist',
    blurb: 'Twenty-five scored analyses of a single stroke.',
    reward: 'Technique crest',
    rarity: 'rare' as AchievementRarity,
  },
} as const;

/** Momentum XP: daily value for showing up, small bonus for volume. */
export const XP_PER_TRAINED_DAY = 20;
export const XP_PER_EXTRA_ACTIVITY = 5;
export const XP_EXTRA_ACTIVITY_CAP = 15;

/** Streak Shields: earned every 7 consecutive trained days, held up to 2.
 * A missed day consumes one automatically and the streak survives. */
export const SHIELD_EARN_EVERY_DAYS = 7;
export const SHIELD_MAX_HELD = 2;

const LEVEL_BASE_COST = 40;
const LEVEL_COST_STEP = 15;
const LEVEL_COST_CAP = 300;

/** XP required to go from level `level` to `level + 1`. */
export function xpCostForLevel(level: number): number {
  const cost = LEVEL_BASE_COST + LEVEL_COST_STEP * (level - 1);
  return Math.min(cost, LEVEL_COST_CAP);
}

export interface MomentumLevelState {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number;
}

export function momentumLevelForXp(totalXp: number): MomentumLevelState {
  let level = 1;
  let remaining = Math.max(0, Math.floor(totalXp));
  for (;;) {
    const cost = xpCostForLevel(level);
    if (remaining < cost) {
      return { level, xpIntoLevel: remaining, xpForNextLevel: cost };
    }
    remaining -= cost;
    level += 1;
  }
}
