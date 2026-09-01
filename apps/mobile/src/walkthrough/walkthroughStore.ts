import { create } from 'zustand';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';

/**
 * First-run walkthrough state. The tour is raised exactly once per DEVICE,
 * the first time a signed-in account lands on the main app — the moment the
 * tab bar, the Coach button, and the home surface all appear at once with no
 * explanation. It teaches four things and gets out of the way: what Home is,
 * how a read starts, that abstention is honest behavior (and free), and that
 * video stays on the phone.
 *
 * Device-level like `onboarding.device-complete` (the walkthrough teaches the
 * human holding the phone, not an account), and following the celebration
 * stores' crash-safety rule: the durable "seen" record is written BEFORE the
 * overlay is shown, so a crash loop can never replay a blocking overlay at
 * every launch. A missed tour is recoverable — Settings → About offers a
 * replay — a launch-blocking loop is not.
 */

export const WALKTHROUGH_KV_KEY = 'walkthrough.device-complete';
export const WALKTHROUGH_SEEN_VALUE = JSON.stringify({ version: 1 });

interface WalkthroughState {
  visible: boolean;
  /** Raise the tour once per device; safe to call from every main-app mount. */
  maybeShowFirstRun: () => Promise<void>;
  /** Settings → "App walkthrough · Replay". Never touches the seen record. */
  replay: () => void;
  dismiss: () => void;
}

/** Serialized: concurrent mounts (gate re-renders) must not race the KV
 * read-then-write into a double show. */
let evaluationQueue: Promise<void> = Promise.resolve();

export const useWalkthroughStore = create<WalkthroughState>((set, get) => ({
  visible: false,

  maybeShowFirstRun: async () => {
    const run = async () => {
      if (get().visible) return;
      let seen: string | null;
      try {
        seen = await getKv(getDb(), WALKTHROUGH_KV_KEY);
      } catch {
        // Unreadable state: skip rather than risk showing on every launch.
        return;
      }
      if (seen !== null) return;
      try {
        await setKv(getDb(), WALKTHROUGH_KV_KEY, WALKTHROUGH_SEEN_VALUE);
      } catch {
        // If the record cannot be persisted, do not show: an overlay that
        // replays forever is worse than a missed tour (Settings can replay).
        return;
      }
      set({ visible: true });
    };
    evaluationQueue = evaluationQueue.then(run, run);
    await evaluationQueue;
  },

  replay: () => set({ visible: true }),

  dismiss: () => set({ visible: false }),
}));
