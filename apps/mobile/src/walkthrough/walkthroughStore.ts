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
 *
 * The tour never overlaps another full-screen ceremony: while a registered
 * one (see `walkthroughYieldsTo`) is showing, the tour queues and raises the
 * moment that ceremony is dismissed.
 */

export const WALKTHROUGH_KV_KEY = 'walkthrough.device-complete';
export const WALKTHROUGH_SEEN_VALUE = JSON.stringify({ version: 1 });

export interface WalkthroughYieldTarget {
  isShowing: () => boolean;
  subscribe: (listener: () => void) => () => void;
}

const yieldTargets: WalkthroughYieldTarget[] = [];

function anotherCeremonyShowing(): boolean {
  return yieldTargets.some(target => target.isShowing());
}

/** Registers a blocking overlay the tour must wait for; returns unsubscribe. */
export function walkthroughYieldsTo(
  target: WalkthroughYieldTarget,
): () => void {
  yieldTargets.push(target);
  const unsubscribe = target.subscribe(() => {
    if (!useWalkthroughStore.getState().queued) return;
    if (anotherCeremonyShowing()) return;
    useWalkthroughStore.setState({ queued: false, visible: true });
  });
  return () => {
    unsubscribe();
    const index = yieldTargets.indexOf(target);
    if (index >= 0) yieldTargets.splice(index, 1);
  };
}

interface WalkthroughState {
  visible: boolean;
  /** Ready to show, waiting for another ceremony to be dismissed. */
  queued: boolean;
  /** Raise the tour once per device; safe to call from every main-app mount. */
  maybeShowFirstRun: () => Promise<void>;
  /** Settings → "App walkthrough · Replay". Never touches the seen record. */
  replay: () => void;
  dismiss: () => void;
}

/** Serialized: concurrent mounts (gate re-renders) must not race the KV
 * read-then-write into a double show. */
let evaluationQueue: Promise<void> = Promise.resolve();

export const useWalkthroughStore = create<WalkthroughState>((set, get) => {
  const raise = () => {
    if (anotherCeremonyShowing()) set({ queued: true });
    else set({ queued: false, visible: true });
  };

  return {
    visible: false,
    queued: false,

    maybeShowFirstRun: async () => {
      const run = async () => {
        if (get().visible || get().queued) return;
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
        raise();
      };
      evaluationQueue = evaluationQueue.then(run, run);
      await evaluationQueue;
    },

    replay: () => raise(),

    dismiss: () => set({ visible: false, queued: false }),
  };
});
