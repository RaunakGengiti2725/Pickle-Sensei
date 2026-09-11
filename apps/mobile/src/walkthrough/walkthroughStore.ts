import { create } from 'zustand';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
  subscribeToDataOwner,
} from '../data/accountScope';
import { identifyCeremony } from '../flow/ceremonyRequest';
import {
  WALKTHROUGH_KV_NAMESPACE,
  WALKTHROUGH_SEEN_VALUE,
  walkthroughKeyForOwner,
} from './walkthroughKey';

export {
  WALKTHROUGH_KV_NAMESPACE,
  WALKTHROUGH_SEEN_VALUE,
  walkthroughKeyForOwner,
};

/**
 * First-run walkthrough state. The tour is raised exactly once per ACCOUNT,
 * the first time that signed-in account lands on the main app — the moment
 * the tab bar, the Coach button, and the home surface all appear at once with
 * no explanation. It teaches four things and gets out of the way: what Home
 * is, how a read starts, that abstention is honest behavior (and free), and
 * that video stays on the phone.
 *
 * Owner-scoped like `rank.celebrated` (kv `walkthrough.complete:<owner>`,
 * listed in repository.ts OWNER_SCOPED_KV_NAMESPACES so account deletion
 * purges it): a NEW account on a phone that already held one gets its own
 * tour, while the same account signing back in on this phone does not. It
 * follows the celebration stores' crash-safety rule: the durable "seen"
 * record is written BEFORE the overlay is shown, so a crash loop can never
 * replay a blocking overlay at every launch. A missed tour is recoverable —
 * Settings → About offers a replay — a launch-blocking loop is not.
 *
 * The tour never overlaps another full-screen ceremony: while a registered
 * one (see `walkthroughYieldsTo`) is showing, the tour queues and raises the
 * moment that ceremony is dismissed. A tour raised for one account is dropped
 * the moment the data owner changes, so the next account's evaluation never
 * finds the slot held by a stale request.
 */

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
  request: object | null;
  /** Ready to show, waiting for another ceremony to be dismissed. */
  queued: boolean;
  /** Raise the tour once per account; safe to call from every main-app mount. */
  maybeShowFirstRun: () => Promise<void>;
  /** Settings → "App walkthrough · Replay". Never touches the seen record. */
  replay: () => void;
  dismiss: (expected?: object | null) => void;
}

/** Serialized: concurrent mounts (gate re-renders) must not race the KV
 * read-then-write into a double show. */
let evaluationQueue: Promise<void> = Promise.resolve();

function activeOwnerOrNull(): string | null {
  const owner = getActiveDataOwner();
  return owner === SIGNED_OUT_DATA_OWNER ? null : owner;
}

export const useWalkthroughStore = create<WalkthroughState>((set, get) => {
  const raise = (owner: string | null) => {
    if (get().visible || get().queued) return;
    const request = {};
    identifyCeremony(request, owner);
    if (anotherCeremonyShowing()) set({ queued: true, request });
    else set({ queued: false, visible: true, request });
  };

  return {
    visible: false,
    queued: false,
    request: null,

    maybeShowFirstRun: async () => {
      if (getActiveDataOwner() === SIGNED_OUT_DATA_OWNER) return;
      const context = captureDataOwnerContext();
      const owner = context.ownerKey;
      const key = walkthroughKeyForOwner(owner);
      const run = async () => {
        if (!isDataOwnerContextCurrent(context)) return;
        if (get().visible || get().queued) return;
        let seen: string | null;
        try {
          seen = await getKv(getDb(), key);
        } catch {
          // Unreadable state: skip rather than risk showing on every launch.
          return;
        }
        if (seen !== null) return;
        // The account changed while we were reading: this record belongs to
        // the owner who left, and the one who arrived evaluates on its own.
        if (!isDataOwnerContextCurrent(context)) return;
        try {
          await setKv(getDb(), key, WALKTHROUGH_SEEN_VALUE);
        } catch {
          // If the record cannot be persisted, do not show: an overlay that
          // replays forever is worse than a missed tour (Settings can replay).
          return;
        }
        if (!isDataOwnerContextCurrent(context)) return;
        raise(owner);
      };
      evaluationQueue = evaluationQueue.then(run, run);
      await evaluationQueue;
    },

    replay: () => raise(activeOwnerOrNull()),

    dismiss: expected => {
      if (expected !== undefined && get().request !== expected) return;
      set({ visible: false, queued: false, request: null });
    },
  };
});

// A tour belongs to the account it was raised for. When the data owner
// changes (sign-out, a different account signing in) the request is dropped
// so it can neither be presented to the newcomer nor hold the single slot
// against the newcomer's own first-run evaluation.
subscribeToDataOwner(() => {
  const { request } = useWalkthroughStore.getState();
  if (!request) return;
  const { ownerKey } = identifyCeremony(request);
  if (ownerKey !== null && ownerKey !== getActiveDataOwner()) {
    useWalkthroughStore.setState({
      visible: false,
      queued: false,
      request: null,
    });
  }
});
