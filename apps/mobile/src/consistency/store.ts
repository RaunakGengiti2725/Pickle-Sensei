import { create } from 'zustand';
import { getDb } from '../data/db';
import { identifyCeremony } from '../flow/ceremonyRequest';
import { getKv, listActivityShots, setKv } from '../data/repository';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
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

export function parseConsistencyLedger(
  raw: string | null,
): ConsistencyLedger | null {
  if (raw === null) return { ...EMPTY_LEDGER, drills: [], celebrated: {} };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const celebratedRaw = record['celebrated'];
    const shown = record['daySecuredShownDay'];
    const isDay = (value: unknown): value is string =>
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value;
    if (
      record['version'] !== 1 ||
      !Array.isArray(record['drills']) ||
      !celebratedRaw ||
      typeof celebratedRaw !== 'object' ||
      Array.isArray(celebratedRaw) ||
      (shown !== null && !isDay(shown))
    ) {
      return null;
    }
    const drills: ConsistencyDrillRecord[] = [];
    for (const entry of record['drills'] as unknown[]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      const { id, slug, title, completedAtIso } = entry as Record<
        string,
        unknown
      >;
      if (
        typeof id !== 'string' ||
        !id ||
        typeof slug !== 'string' ||
        typeof title !== 'string' ||
        typeof completedAtIso !== 'string' ||
        !Number.isFinite(Date.parse(completedAtIso))
      ) {
        return null;
      }
      drills.push({ id, slug, title, completedAtIso });
    }
    const entries = Object.entries(celebratedRaw);
    if (entries.some(([, value]) => !isDay(value))) {
      return null;
    }
    return {
      version: 1,
      drills,
      celebrated: Object.fromEntries(entries) as Record<string, string>,
      daySecuredShownDay: shown,
    };
  } catch {
    return null;
  }
}

async function readConsistencyLedger(
  db: ReturnType<typeof getDb>,
  owner: string,
): Promise<ConsistencyLedger> {
  const ledger = parseConsistencyLedger(
    await getKv(db, consistencyKeyForOwner(owner), { preserveEmpty: true }),
  );
  if (!ledger) throw new Error('Consistency ledger could not be read.');
  return ledger;
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
  /** True when the last refresh could not read the activity history or ledger. */
  loadError: boolean;
  celebration: ConsistencyCelebration | null;
  queuedCelebrations: ConsistencyCelebration[];
  /** Pending "Day N secured" moment; consumed once by the result surface. */
  daySecured: DaySecuredMoment | null;
  hydrate: () => Promise<void>;
  refresh: () => Promise<void>;
  recordDrillCompletion: (record: ConsistencyDrillRecord) => Promise<void>;
  /** Returns the pending moment (if it is still today's) exactly once. */
  consumeDaySecured: () => DaySecuredMoment | null;
  dismissCelebration: (expected?: ConsistencyCelebration) => void;
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
    // Unreadable ledger: fail without replacing unknown history or markers.
    ledger = await readConsistencyLedger(db, owner);
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
  loadError: false,
  celebration: null,
  queuedCelebrations: [],
  daySecured: null,

  hydrate: async () => {
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      set({
        hydrated: true,
        ownerKey: owner,
        snapshot: null,
        loadError: false,
        celebration: null,
        queuedCelebrations: get().celebration
          ? [...get().queuedCelebrations, get().celebration!]
          : get().queuedCelebrations,
        daySecured: null,
      });
      return;
    }
    const context = captureDataOwnerContext();
    if (get().ownerKey !== owner) {
      set({
        ownerKey: owner,
        hydrated: false,
        snapshot: null,
        loadError: false,
        daySecured: null,
      });
    }
    await get().refresh();
    if (isDataOwnerContextCurrent(context)) set({ hydrated: true });
  },

  refresh: async () => {
    const owner = getActiveDataOwner();
    if (owner === SIGNED_OUT_DATA_OWNER) {
      set({
        ownerKey: owner,
        snapshot: null,
        loadError: false,
        daySecured: null,
      });
      return;
    }
    const context = captureDataOwnerContext();
    const run = async () => {
      if (!isDataOwnerContextCurrent(context)) return;
      let activities: TrainingActivityInput[];
      let ledger: ConsistencyLedger;
      try {
        const loaded = await loadConsistencyActivities();
        activities = loaded.activities;
        ledger = loaded.ledger;
      } catch {
        if (!isDataOwnerContextCurrent(context)) return;
        set(state => ({
          ownerKey: owner,
          loadError: true,
          snapshot: state.ownerKey === owner ? state.snapshot : null,
          daySecured: state.ownerKey === owner ? state.daySecured : null,
        }));
        return;
      }
      if (!isDataOwnerContextCurrent(context)) return;
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
          if (!isDataOwnerContextCurrent(context)) return;
          await setKv(
            getDb(),
            consistencyKeyForOwner(owner),
            JSON.stringify(nextLedger),
          );
          ledger = nextLedger;
        } catch {
          // Could not persist: skip the ceremony rather than risk replaying
          // it forever. The next successful refresh retries.
          if (!isDataOwnerContextCurrent(context)) return;
          set({ ownerKey: owner, snapshot, loadError: false });
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

      if (celebration) identifyCeremony(celebration, owner);
      if (!isDataOwnerContextCurrent(context)) {
        if (celebration) {
          set(state => ({
            queuedCelebrations: [...state.queuedCelebrations, celebration],
          }));
        }
        return;
      }
      set(state => ({
        ownerKey: owner,
        snapshot,
        loadError: false,
        daySecured,
        celebration: state.celebration ?? celebration,
        queuedCelebrations:
          state.celebration && celebration
            ? [...state.queuedCelebrations, celebration]
            : state.queuedCelebrations,
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
      const ledger = await readConsistencyLedger(db, owner);
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
        const ledger = await readConsistencyLedger(db, owner);
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

  dismissCelebration: expected => {
    const target = expected ?? get().celebration;
    if (!target) return;
    set(state => ({
      celebration: state.celebration === target ? null : state.celebration,
      queuedCelebrations: state.queuedCelebrations.filter(
        celebration => celebration !== target,
      ),
    }));
  },
}));
