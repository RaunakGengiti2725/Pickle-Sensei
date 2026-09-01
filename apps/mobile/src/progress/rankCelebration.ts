import { create } from 'zustand';
import {
  PLAYER_RANK_TIERS,
  type PlayerRankSummary,
  type PlayerRankTierKey,
} from '@pickle/shared-types';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  getActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';

/**
 * Rank-shift detection. Every surface that resolves the player's rank
 * (Home banner, Progress card) reports it here; this module compares it to
 * the last tier this account has SEEN celebrated (durable, owner-scoped kv)
 * and raises exactly one celebration per upward tier change:
 *
 *   - first ever resolved rank  → a placement celebration (from: null);
 *   - tier above the recorded one → a promotion celebration (from → to);
 *   - same or lower tier → no ceremony, but the record follows the honest
 *     rating down so climbing BACK to a tier celebrates again.
 *
 * The record is written before the overlay is shown, so a race between two
 * screens can never produce a duplicate ceremony.
 */

export interface RankCelebration {
  /** Null when this is the account's first resolved rank (placement). */
  fromTier: PlayerRankTierKey | null;
  toTier: PlayerRankTierKey;
  /** Rating the count-up starts from; null counts up from 0. */
  fromRating: number | null;
  summary: PlayerRankSummary;
}

interface StoredRankRecord {
  version: 1;
  tier: PlayerRankTierKey;
  rating: number;
}

export function rankCelebrationKeyForOwner(owner: string): string {
  return `rank.celebrated:${owner}`;
}

export function tierIndex(tier: string): number {
  return PLAYER_RANK_TIERS.findIndex(candidate => candidate.key === tier);
}

function parseStoredRecord(raw: string | null): StoredRankRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const tier = record['tier'];
    const rating = record['rating'];
    if (typeof tier !== 'string' || tierIndex(tier) < 0) return null;
    if (typeof rating !== 'number' || !Number.isFinite(rating)) return null;
    return { version: 1, tier: tier as PlayerRankTierKey, rating };
  } catch {
    return null;
  }
}

/** Pure decision: what does seeing `summary` mean given the stored record? */
export function evaluateRankTransition(
  stored: StoredRankRecord | null,
  summary: PlayerRankSummary,
): RankCelebration | null {
  const toIndex = tierIndex(summary.tier);
  if (toIndex < 0) return null;
  if (!stored) {
    return {
      fromTier: null,
      toTier: summary.tier,
      fromRating: null,
      summary,
    };
  }
  if (toIndex > tierIndex(stored.tier)) {
    return {
      fromTier: stored.tier,
      toTier: summary.tier,
      fromRating: stored.rating,
      summary,
    };
  }
  return null;
}

interface RankCelebrationState {
  current: RankCelebration | null;
  /** Serialized: concurrent reports from multiple screens queue up. */
  maybeCelebrate: (summary: PlayerRankSummary) => Promise<void>;
  dismiss: () => void;
}

let evaluationQueue: Promise<void> = Promise.resolve();

export const useRankCelebrationStore = create<RankCelebrationState>(
  (set, get) => ({
    current: null,

    maybeCelebrate: async summary => {
      const run = async () => {
        const owner = getActiveDataOwner();
        if (owner === SIGNED_OUT_DATA_OWNER) return;
        let stored: StoredRankRecord | null;
        try {
          stored = parseStoredRecord(
            await getKv(getDb(), rankCelebrationKeyForOwner(owner)),
          );
        } catch {
          // Unreadable state: skip rather than risk a duplicate ceremony.
          return;
        }
        const record: StoredRankRecord = {
          version: 1,
          tier: summary.tier,
          rating: summary.rating,
        };
        const changed =
          !stored ||
          stored.tier !== record.tier ||
          stored.rating !== record.rating;
        if (changed) {
          try {
            if (getActiveDataOwner() !== owner) return;
            await setKv(
              getDb(),
              rankCelebrationKeyForOwner(owner),
              JSON.stringify(record),
            );
          } catch {
            // If the record cannot be persisted, do not celebrate: a crash
            // loop replaying the same ceremony would be worse than missing
            // one. The next successful resolve retries.
            return;
          }
        }
        const celebration = evaluateRankTransition(stored, summary);
        if (celebration && !get().current) set({ current: celebration });
      };
      evaluationQueue = evaluationQueue.then(run, run);
      await evaluationQueue;
    },

    dismiss: () => set({ current: null }),
  }),
);
