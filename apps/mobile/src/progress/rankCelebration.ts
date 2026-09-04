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
  subscribeActiveDataOwner,
} from '../data/accountScope';
import {
  useWalkthroughStore,
  walkthroughYieldsTo,
} from '../walkthrough/walkthroughStore';

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
 * screens can never produce a duplicate ceremony. A ceremony that resolves
 * while another is already showing (or held) is skipped WITHOUT writing the
 * record, so the next resolve after dismissal raises it.
 *
 * The overlay never stacks on the first-run walkthrough: a ceremony that
 * resolves while the tour is showing is held as `pending` and raised the
 * moment the tour is dismissed, and the tour in turn waits for a showing
 * ceremony (`walkthroughYieldsTo`).
 *
 * Overlay state is owner-scoped. The overlay is mounted above the auth gate,
 * so a sign-out or account switch does not unmount it: the store drops its
 * showing and held ceremony the moment the active data owner changes, so one
 * account's ceremony is never shown to — or suppresses the placement of —
 * the next.
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
  /** Earned while the walkthrough was showing; raised once it dismisses. */
  pending: RankCelebration | null;
  /** Serialized: concurrent reports from multiple screens queue up. */
  maybeCelebrate: (summary: PlayerRankSummary) => Promise<void>;
  dismiss: () => void;
  /** Drops the showing and held ceremony: the account they belong to is no
   * longer the active owner. */
  reset: () => void;
}

let evaluationQueue: Promise<void> = Promise.resolve();

export const useRankCelebrationStore = create<RankCelebrationState>(
  (set, get) => ({
    current: null,
    pending: null,

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
        // The owner may have changed while the record was read.
        if (getActiveDataOwner() !== owner) return;
        const celebration = evaluateRankTransition(stored, summary);
        // Another ceremony is showing or held: leave the record alone so
        // this one is raised by the next resolve after dismissal.
        if (celebration && (get().current || get().pending)) return;
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
        // The owner may have changed while the record was written.
        if (!celebration || getActiveDataOwner() !== owner) return;
        if (useWalkthroughStore.getState().visible) {
          set({ pending: celebration });
        } else {
          set({ current: celebration });
        }
      };
      evaluationQueue = evaluationQueue.then(run, run);
      await evaluationQueue;
    },

    dismiss: () => set({ current: null }),

    reset: () => set({ current: null, pending: null }),
  }),
);

// Every account transition (sign-out, revoked session, account deletion,
// sign-in as someone else) moves the active owner; the previous owner's
// ceremony must not outlive it.
subscribeActiveDataOwner(() => useRankCelebrationStore.getState().reset());

useWalkthroughStore.subscribe(state => {
  if (state.visible) return;
  const { current, pending } = useRankCelebrationStore.getState();
  if (pending && !current) {
    useRankCelebrationStore.setState({ current: pending, pending: null });
  }
});

walkthroughYieldsTo({
  isShowing: () => useRankCelebrationStore.getState().current !== null,
  subscribe: listener => useRankCelebrationStore.subscribe(listener),
});
