import { create } from 'zustand';
import { getDb } from '../data/db';
import { getKv, listActivityShots, setKv } from '../data/repository';
import {
  getActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import {
  buildConsistencySnapshot,
  type ConsistencySnapshot,
  type TrainingActivityInput,
} from './engine';
import {
  streakMilestoneById,
  VOLUME_ACHIEVEMENTS,
  type StreakMilestone,
} from './milestones';

/**
 * Consistency state — the owner-scoped source of truth for streaks,
 * Momentum XP, shields, and achievements. Same architecture as the
 * notification store: durable copies in the SQLite kv
 * (`consistency:<owner>`), derived state recomputed from evidence on every
 * hydrate/refresh so nothing can drift.
 *
 * What is PERSISTED (the ledger) is only what cannot be derived:
 *   - drill completions (server-backed elsewhere, mirrored here so a drill
 *     day counts offline and for guests),
 *   - which milestones have already been celebrated (one ceremony each),
 *   - which day's "Day N secured" moment has been shown.
 * Streaks/XP/shields are always REPLAYED from the full activity history by
 * the pure engine — the same replay-from-facts rule as playerRank.
 */

export interface ConsistencyDrillRecord {
  id: string;
  slug: string;
  title: string;
  completedAtIso: string;
}

interface ConsistencyLedger {
  version: 1;
  drills: ConsistencyDrillRecord[];
  /** milestone/achievement id → day it was celebrated. */
  celebrated: Record<string, string>;
  /** Local day whose "Day N secured" moment has been consumed. */
  daySecuredShownDay: string | null;
}

const EMPTY_LEDGER: ConsistencyLedger = {
  version: 1,
  drills: [],
  celebrated: {},
  daySecuredShownDay: null,
};

const MAX_LEDGER_DRILLS = 2000;

export function consistencyKeyForOwner(owner: string): string {
  return `consistency:${owner}`;
}

export function parseConsistencyLedger(raw: string | null): ConsistencyLedger {
  if (!raw) return { ...EMPTY_LEDGER, drills: [], celebrated: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ...EMPTY_LEDGER, drills: [], celebrated: {} };
    }
    const record = parsed as Record<string, unknown>;
    const drills = Array.isArray(record['drills'])
      ? (record['drills'] as unknown[])
          .filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === 'object',
          )
          .map(entry => ({
            id: String(entry['id'] ?? ''),
            slug: String(entry['slug'] ?? ''),
            title: String(entry['title'] ?? ''),
            completedAtIso: String(entry['completedAtIso'] ?? ''),
          }))
          .filter(entry => entry.id && entry.completedAtIso)
      : [];
    const celebratedRaw = record['celebrated'];
    const celebrated: Record<string, string> = {};
    if (
      celebratedRaw &&
      typeof celebratedRaw === 'object' &&
      !Array.isArray(celebratedRaw)
    ) {
      for (const [key, value] of Object.entries(
        celebratedRaw as Record<string, unknown>,
      )) {
        if (typeof value === 'string') celebrated[key] = value;
      }
    }
    const shown = record['daySecuredShownDay'];
    return {
      version: 1,
      drills,
      celebrated,
      daySecuredShownDay: typeof shown === 'string' ? shown : null,
    };
  } catch {
    return { ...EMPTY_LEDGER, drills: [], celebrated: {} };
  }
}

export interface ConsistencyCelebration {
  kind: 'streak' | 'volume';
  achievementId: string;
  title: string;
  blurb: string;
  reward: string;
  rarity: StreakMilestone['rarity'];
  /** Streak length for streak milestones; threshold for volume. */
  value: number;
  streakAtCelebration: number;
  detail?: string;
}

export interface DaySecuredMoment {
  day: string;
  streak: number;
  xpToday: number;
  shieldsAvailable: number;
  nextMilestone: { title: string; daysAway: number } | null;
}

interface ConsistencyState {
  hydrated: boolean;
  ownerKey: string | null;
  snapshot: ConsistencySnapshot | null;
  celebration: ConsistencyCelebration | null;
  /** Pending "Day N secured" moment; consumed once by the result surface. */
  daySecured: DaySecuredMoment | null;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  recordDrillCompletion: (record: ConsistencyDrillRecord) => Promise<void>;
  /** Returns the pending moment (if it is still today's) exactly once. */
  consumeDaySecured: () => DaySecuredMoment | null;
  dismissCelebration: () => void;
}

function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Shots + drill ledger → engine inputs. Exported for the notification
 * planner, which needs the same facts without mounting the store. */
export async function loadConsistencyActivities(): Promise<{
  activities: TrainingActivityInput[];
  ledger: ConsistencyLedger;
  owner: string;
}> {
  const owner = getActiveDataOwner();
  const db = getDb();
  const shots =
    owner === SIGNED_OUT_DATA_OWNER ? [] : await listActivityShots(db);
  let ledger: ConsistencyLedger = {
    ...EMPTY_LEDGER,
    drills: [],
    celebrated: {},
  };
  if (owner !== SIGNED_OUT_DATA_OWNER) {
    try {
      ledger = parseConsistencyLedger(
        await getKv(db, consistencyKeyForOwner(owner)),
      );
    } catch {
      // Unreadable ledger: derive from shots alone rather than failing.
    }
  }
  const activities: TrainingActivityInput[] = shots.map(shot => ({
    kind: shot.sessionId ? 'session_stroke' : 'stroke',
    atIso: shot.capturedAt,
    shotType: shot.shotType,
    overallScore: shot.overallScore,
    resultKind: shot.resultKind,
  }));
  for (const drill of ledger.drills) {
    activities.push({
      kind: 'drill',
      atIso: drill.completedAtIso,
      label: drill.title || drill.slug,
    });
  }
  return { activities, ledger, owner };
}

export async function computeConsistencySnapshot(): Promise<ConsistencySnapshot> {
  const { activities } = await loadConsistencyActivities();
  return buildConsistencySnapshot(activities, {
    asOfIso: new Date().toISOString(),
    timeZone: deviceTimeZone(),
  });
}

function celebrationFor(
  snapshot: ConsistencySnapshot,
  celebrated: Record<string, string>,
): { celebration: ConsistencyCelebration | null; markCelebrated: string[] } {
  const markCelebrated: string[] = [];
  let best: { milestone: StreakMilestone } | null = null;
  for (const earned of snapshot.earned) {
    if (celebrated[earned.id]) continue;
    const milestone = streakMilestoneById(earned.id);
    if (milestone) {
      markCelebrated.push(earned.id);
      if (!best || milestone.days > best.milestone.days) best = { milestone };
      continue;
    }
    // Volume achievements celebrate too, but streak moments outrank them.
    markCelebrated.push(earned.id);
  }
  if (best) {
    return {
      celebration: {
        kind: 'streak',
        achievementId: best.milestone.id,
        title: best.milestone.title,
        blurb: best.milestone.blurb,
        reward: best.milestone.reward,
        rarity: best.milestone.rarity,
        value: best.milestone.days,
        streakAtCelebration: snapshot.currentStreak,
      },
      markCelebrated,
    };
  }
  const volume = snapshot.earned.find(
    earned =>
      !celebrated[earned.id] &&
      (earned.id === VOLUME_ACHIEVEMENTS.sessions100.id ||
        earned.id === VOLUME_ACHIEVEMENTS.specialist.id),
  );
  if (volume) {
    const definition =
      volume.id === VOLUME_ACHIEVEMENTS.sessions100.id
        ? VOLUME_ACHIEVEMENTS.sessions100
        : VOLUME_ACHIEVEMENTS.specialist;
    return {
      celebration: {
        kind: 'volume',
        achievementId: definition.id,
        title:
          volume.detail && definition.id === VOLUME_ACHIEVEMENTS.specialist.id
            ? `${volume.detail} Specialist`
            : definition.title,
        blurb: definition.blurb,
        reward: definition.reward,
        rarity: definition.rarity,
        value: definition.threshold,
        streakAtCelebration: snapshot.currentStreak,
        ...(volume.detail ? { detail: volume.detail } : {}),
      },
      markCelebrated,
    };
  }
  return { celebration: null, markCelebrated };
}

let refreshQueue: Promise<void> = Promise.resolve();

export const useConsistencyStore = create<ConsistencyState>((set, get) => ({
  hydrated: false,
  ownerKey: null,
  snapshot: null,
  celebration: null,
  daySecured: null,

  hydrate: async () => {
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      set({
        hydrated: true,
        ownerKey: owner,
        snapshot: null,
        celebration: null,
        daySecured: null,
      });
      return;
    }
    set({ ownerKey: owner });
    await get().refresh();
    set({ hydrated: true });
  },

  refresh: async () => {
    const run = async () => {
      const owner = getActiveDataOwner();
      if (owner === SIGNED_OUT_DATA_OWNER) {
        set({ ownerKey: owner, snapshot: null, daySecured: null });
        return;
      }
      let activities: TrainingActivityInput[];
      let ledger: ConsistencyLedger;
      try {
        const loaded = await loadConsistencyActivities();
        activities = loaded.activities;
        ledger = loaded.ledger;
      } catch {
        return;
      }
      const snapshot = buildConsistencySnapshot(activities, {
        asOfIso: new Date().toISOString(),
        timeZone: deviceTimeZone(),
      });

      // One ceremony per milestone, durable-before-shown (rankCelebration
      // rule: persist first so a race can never duplicate a ceremony).
      const { celebration, markCelebrated } = celebrationFor(
        snapshot,
        ledger.celebrated,
      );
      if (markCelebrated.length > 0) {
        const celebrated = { ...ledger.celebrated };
        for (const id of markCelebrated) celebrated[id] = snapshot.asOfDay;
        const nextLedger: ConsistencyLedger = { ...ledger, celebrated };
        try {
          if (getActiveDataOwner() !== owner) return;
          await setKv(
            getDb(),
            consistencyKeyForOwner(owner),
            JSON.stringify(nextLedger),
          );
          ledger = nextLedger;
        } catch {
          // Could not persist: skip the ceremony rather than risk replaying
          // it forever. The next successful refresh retries.
          if (getActiveDataOwner() !== owner) return;
          set({ ownerKey: owner, snapshot });
          return;
        }
      }

      // "Day N secured" — armed the first time today becomes a trained day.
      const today = snapshot.asOfDay;
      const todayLog = snapshot.days[today];
      const daySecured: DaySecuredMoment | null =
        snapshot.trainedToday && ledger.daySecuredShownDay !== today
          ? {
              day: today,
              streak: snapshot.currentStreak,
              xpToday: todayLog?.xp ?? 0,
              shieldsAvailable: snapshot.shieldsAvailable,
              nextMilestone: snapshot.nextStreakMilestone
                ? {
                    title: snapshot.nextStreakMilestone.title,
                    daysAway: snapshot.nextStreakMilestone.daysAway,
                  }
                : null,
            }
          : null;

      if (getActiveDataOwner() !== owner) return;
      set(state => ({
        ownerKey: owner,
        snapshot,
        daySecured,
        celebration: state.celebration ?? celebration,
      }));
    };
    refreshQueue = refreshQueue.then(run, run);
    await refreshQueue;
  },

  recordDrillCompletion: async record => {
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) return;
    try {
      const db = getDb();
      const ledger = parseConsistencyLedger(
        await getKv(db, consistencyKeyForOwner(owner)),
      );
      if (ledger.drills.some(existing => existing.id === record.id)) return;
      const drills = [...ledger.drills, record].slice(-MAX_LEDGER_DRILLS);
      if (getActiveDataOwner() !== owner) return;
      await setKv(
        db,
        consistencyKeyForOwner(owner),
        JSON.stringify({ ...ledger, drills }),
      );
    } catch {
      // A drill that could not be recorded still completed server-side; the
      // streak simply cannot count it. Never block the training flow.
    }
    await get().refresh();
  },

  consumeDaySecured: () => {
    const pending = get().daySecured;
    if (!pending) return null;
    set({ daySecured: null });
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) return null;
    // Persist the consumption so the moment shows once per day, ever.
    void (async () => {
      try {
        const db = getDb();
        const ledger = parseConsistencyLedger(
          await getKv(db, consistencyKeyForOwner(owner)),
        );
        if (getActiveDataOwner() !== owner) return;
        await setKv(
          db,
          consistencyKeyForOwner(owner),
          JSON.stringify({ ...ledger, daySecuredShownDay: pending.day }),
        );
      } catch {
        // Worst case the moment could repeat after a restart — harmless.
      }
    })();
    return pending;
  },

  dismissCelebration: () => set({ celebration: null }),
}));
