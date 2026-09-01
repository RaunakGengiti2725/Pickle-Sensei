import { AppState } from 'react-native';
import type { ApiSession } from '../account/apiSession';
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
const runningGenerations = new Set<number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let triggerForGeneration: (() => Promise<void>) | null = null;

/** Stops future work synchronously. An already-issued request remains bound to
 * its original owner and bearer, so it cannot upload another account's rows. */
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
  const transport = createTransport({
    baseUrl: session.apiBaseUrl,
    token: session.bearerToken,
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
      runningGenerations.has(configuredGeneration)
    ) {
      return;
    }
    if (getActiveDataOwner() !== owner) {
      schedule();
      return;
    }
    runningGenerations.add(configuredGeneration);
    try {
      const result = await drainOutbox(getDb(), transport);
      consecutiveFailures = result.failed > 0 ? consecutiveFailures + 1 : 0;
    } catch {
      // Outbox rows remain durable with their attempt history. The foreground
      // event or the backed-off timer retries without inventing a receipt.
      consecutiveFailures += 1;
    } finally {
      runningGenerations.delete(configuredGeneration);
      schedule();
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
