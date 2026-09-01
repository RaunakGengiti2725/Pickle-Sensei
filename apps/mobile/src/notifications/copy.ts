/**
 * Reminder copy. Written for a lock screen: short, personal-data-free, and in
 * the app's coaching voice — direct, warm, never guilt-tripping and never
 * inventing facts (a reminder can say "your streak is alive", because it is
 * only scheduled while that is true; it never claims scores or results).
 *
 * Daily/weekly lines rotate deterministically by day so two consecutive
 * reminders read differently without any randomness to test around.
 */

export interface NotificationCopy {
  title: string;
  body: string;
}

const PRACTICE_VARIANTS: NotificationCopy[] = [
  {
    title: 'Court time.',
    body: 'One stroke in front of the camera keeps your technique honest.',
  },
  {
    title: 'Your paddle is warm.',
    body: 'A two-minute read today beats a long session someday.',
  },
  {
    title: 'Quick read?',
    body: 'Set the phone down, hit one stroke, and see the score.',
  },
  {
    title: 'Small reps, real rank.',
    body: 'Every scored analysis moves your player rating.',
  },
];

const STREAK_VARIANTS: NotificationCopy[] = [
  {
    title: 'Your streak is alive.',
    body: 'No training yet today — one analysis before midnight keeps it.',
  },
  {
    title: 'Keep the run going.',
    body: 'One stroke analysis tonight extends your training streak.',
  },
];

/** Honest facts the streak-defense reminder may state. Only ever passed for
 * a delivery time at which they are guaranteed true (plan.ts schedules the
 * reminder solely for days whose streak state is already known). */
export interface StreakDefenseFacts {
  /** The live streak being defended (trained days in the current run). */
  streakDays: number;
  /** Banked Streak Shields at schedule time. */
  shieldsAvailable: number;
  /** Set when completing the defended day reaches a milestone. */
  milestoneEve: { title: string; days: number } | null;
}

const WEEKLY_VARIANTS: NotificationCopy[] = [
  {
    title: 'Your week on court is in.',
    body: 'Open Progress to see captures, streak, and technique movement.',
  },
  {
    title: 'Week wrapped.',
    body: 'Your practice history and player rank are waiting in Progress.',
  },
];

export const COMEBACK_COPY: readonly NotificationCopy[] = [
  {
    title: 'The court missed you.',
    body: 'Three days since your last visit — one stroke gets you back in.',
  },
  {
    title: 'A week off the radar.',
    body: 'Your court is exactly where you left it.',
  },
  {
    title: 'Still here when you are.',
    body: 'Two weeks away. One capture restarts the habit — no catch-up owed.',
  },
] as const;

function dayIndex(timestampMs: number): number {
  return Math.floor(timestampMs / 86_400_000);
}

function pick(
  variants: readonly NotificationCopy[],
  timestampMs: number,
): NotificationCopy {
  const index = dayIndex(timestampMs) % variants.length;
  return variants[index] ?? variants[0]!;
}

export function practiceReminderCopy(deliveryMs: number): NotificationCopy {
  return pick(PRACTICE_VARIANTS, deliveryMs);
}

export function streakDefenseCopy(
  deliveryMs: number,
  facts?: StreakDefenseFacts,
): NotificationCopy {
  if (!facts || facts.streakDays <= 0) {
    return pick(STREAK_VARIANTS, deliveryMs);
  }
  // Milestone eve outranks everything: tonight's session unlocks a reward.
  if (facts.milestoneEve) {
    return {
      title: `${facts.milestoneEve.title} is one session away.`,
      body: `Train tonight and day ${facts.milestoneEve.days} unlocks it. One analysis is enough.`,
    };
  }
  const run = `${facts.streakDays} ${
    facts.streakDays === 1 ? 'day' : 'days'
  } strong`;
  const variants: NotificationCopy[] = [
    {
      title: `${run} 🔥`,
      body: 'Complete one analysis tonight to keep it alive.',
    },
    {
      title: 'Your streak is alive.',
      body: `${run} — one stroke analysis before midnight keeps it that way.`,
    },
  ];
  if (facts.shieldsAvailable > 0) {
    variants.push({
      title: `${run} 🔥`,
      body: 'A Streak Shield has your back tonight — training keeps it banked for when you really need it.',
    });
  }
  return pick(variants, deliveryMs);
}

export function weeklyRecapCopy(deliveryMs: number): NotificationCopy {
  return pick(WEEKLY_VARIANTS, deliveryMs);
}
