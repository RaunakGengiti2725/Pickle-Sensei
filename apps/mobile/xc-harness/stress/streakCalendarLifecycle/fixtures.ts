import type { ShotRow } from './fakeDb';

/**
 * Three device accounts with DISTINCT training histories so any snapshot the
 * store or screen holds can be attributed to exactly one owner:
 *
 *   alpha  — canonical account, trained today and the two days before
 *            (3-day live streak, earns streak.1 + streak.3)
 *   bravo  — canonical account, trained the six days before today but not
 *            today (6-day streak at risk, earns streak.1 + streak.3)
 *   guest  — device-local account, one analysis 10 days ago (no live run)
 *
 * All instants are 14:00 UTC; the harness pins the system clock to
 * 2026-03-10T15:00:00Z and the Jest process runs in UTC, so a calendar day
 * key equals the UTC date of the instant.
 */
export type OwnerTag = 'alpha' | 'bravo' | 'guest' | 'signed-out';

export const OWNER_IDS: Record<Exclude<OwnerTag, 'signed-out'>, string> = {
  alpha: '0a0a0a0a-1111-4111-8111-0a0a0a0a0a0a',
  bravo: '0b0b0b0b-2222-4222-8222-0b0b0b0b0b0b',
  guest: 'device-guest',
};

export const LAUNCH_INSTANT = '2026-03-10T15:00:00.000Z';

export function isoDaysAgo(days: number, base: number = Date.now()): string {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(14, 0, 0, 0);
  return d.toISOString();
}

/** Trained-day offsets (days before the launch day) per owner. */
export const TRAINED_DAYS_AGO: Record<
  Exclude<OwnerTag, 'signed-out'>,
  readonly number[]
> = {
  alpha: [0, 1, 2],
  bravo: [1, 2, 3, 4, 5, 6],
  guest: [10],
};

export function shotRowsFor(
  owner: Exclude<OwnerTag, 'signed-out'>,
  launchMs: number,
): ShotRow[] {
  return TRAINED_DAYS_AGO[owner].map((daysAgo, index) => ({
    id: `${owner}-shot-${index}`,
    sessionId: null,
    shotType: index % 2 === 0 ? 'forehand_drive' : 'dink',
    capturedAt: isoDaysAgo(daysAgo, launchMs),
    overallScore: 6 + (index % 3),
    resultKind: 'scored',
  }));
}

export const PROFILE_JSON = JSON.stringify({
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'dinks',
  biggestProblem: 'consistency',
  focusCheckpoint: 'contact_position',
});

export interface HarnessSession {
  provider: 'apple' | 'google' | 'guest';
  subject: string;
  canonicalAppUserId: string | null;
  localOnly: boolean;
  displayName: string | null;
  email: string | null;
  /** Harness-only: distinguishes a rotated bearer from the same account. */
  tokenGeneration: number;
}

export function sessionFor(
  owner: Exclude<OwnerTag, 'signed-out'>,
  tokenGeneration = 0,
): HarnessSession {
  if (owner === 'guest') {
    return {
      provider: 'guest',
      subject: 'local-only',
      canonicalAppUserId: null,
      localOnly: true,
      displayName: null,
      email: null,
      tokenGeneration,
    };
  }
  return {
    provider: owner === 'alpha' ? 'apple' : 'google',
    subject: OWNER_IDS[owner],
    canonicalAppUserId: OWNER_IDS[owner],
    localOnly: false,
    displayName: owner === 'alpha' ? 'Alpha Tester' : 'Bravo Tester',
    email: `${owner}@example.com`,
    tokenGeneration,
  };
}
