import { AppState } from 'react-native';
import { bearerTokenFor, type ApiSession } from '../account/apiSession';
import { canonicalDataOwner, getActiveDataOwner } from './accountScope';
import { createTransport } from './api';
import { getDb } from './db';
import { drainOutbox } from './sync';

/** Cadence while the outbox is healthy or empty. */
export const SYNC_RETRY_BASE_MS = 30_000;
/** Ceiling for the doubling back-off after consecutive failed drains. */
export const SYNC_RETRY_MAX_MS = 5 * 60_000;
/** ±20% jitter so many devices recovering from one outage do not retry in
 * lockstep against the same backend. */
export const SYNC_RETRY_JITTER_RATIO = 0.2;

/**
 * Delay before the next timer-driven drain. `consecutiveFailures` counts
 * drains in a row that left failed rows behind or threw; a clean drain resets
 * it. Exported for tests; `random` defaults to Math.random.
 */
export function nextSyncRetryDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures, 10));
  const base = Math.min(SYNC_RETRY_BASE_MS * 2 ** exponent, SYNC_RETRY_MAX_MS);
  const jitter = base * SYNC_RETRY_JITTER_RATIO * (random() * 2 - 1);
  return Math.round(base + jitter);
}

let generation = 0;
/** Generations with a drain running or waiting for its turn: a second
 * trigger of the same generation coalesces into it. */
const activeGenerations = new Set<number>();
/** The drain in flight per data owner, across generations: a runtime
 * configured while the previous runtime's drain for the same owner still
 * awaits the server waits for it instead of draining interleaved. */
const drainsByOwner = new Map<string, Promise<void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let triggerForGeneration: (() => Promise<void>) | null = null;

/** Stops future work synchronously. An already-issued request remains bound to
 * its original owner: its bearer resolves only while that owner's session is
 * current, so it cannot upload another account's rows. */
export function clearSyncRuntime(): void {
  generation += 1;
  triggerForGeneration = null;
  if (timer) clearTimeout(timer);
  timer = null;
  removeAppStateListener?.();
  removeAppStateListener = null;
}

export function configureSyncRuntime(session: ApiSession): void {
  clearSyncRuntime();
  const configuredGeneration = generation;
  const owner = canonicalDataOwner(session.canonicalAppUserId);
  // The bearer is resolved per request so a rotated access token is used
  // without rebuilding the runtime.
  const transport = createTransport({
    baseUrl: session.apiBaseUrl,
    get token() {
      return bearerTokenFor(session.canonicalAppUserId);
    },
  });
  let consecutiveFailures = 0;

  const schedule = () => {
    if (configuredGeneration !== generation) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => void trigger(),
      nextSyncRetryDelayMs(consecutiveFailures),
    );
  };

  const trigger = async () => {
    if (
      configuredGeneration !== generation ||
      activeGenerations.has(configuredGeneration)
    ) {
      return;
    }
    if (getActiveDataOwner() !== owner) {
      schedule();
      return;
    }
    activeGenerations.add(configuredGeneration);
    try {
      let inFlight = drainsByOwner.get(owner);
      while (inFlight !== undefined) {
        await inFlight;
        inFlight = drainsByOwner.get(owner);
      }
      if (configuredGeneration !== generation) return;
      if (getActiveDataOwner() !== owner) {
        schedule();
        return;
      }
      let settled: () => void = () => {};
      drainsByOwner.set(
        owner,
        new Promise<void>(resolve => {
          settled = resolve;
        }),
      );
      try {
        const result = await drainOutbox(getDb(), transport);
        consecutiveFailures = result.failed > 0 ? consecutiveFailures + 1 : 0;
      } catch {
        // Outbox rows remain durable with their attempt history. The foreground
        // event or the backed-off timer retries without inventing a receipt.
        consecutiveFailures += 1;
      } finally {
        drainsByOwner.delete(owner);
        settled?.();
        schedule();
      }
    } finally {
      activeGenerations.delete(configuredGeneration);
    }
  };

  triggerForGeneration = trigger;
  const subscription = AppState.addEventListener('change', nextState => {
    if (nextState === 'active') void trigger();
  });
  removeAppStateListener = () => subscription.remove();
  void trigger();
}

/** Called after a new local result enters the durable outbox. */
export function triggerOutboxSync(): void {
  void triggerForGeneration?.();
}
