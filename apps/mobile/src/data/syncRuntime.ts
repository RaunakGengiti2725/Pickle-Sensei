import { AppState } from 'react-native';
import { bearerTokenFor, type ApiSession } from '../account/apiSession';
import { canonicalDataOwner, getActiveDataOwner } from './accountScope';
import { createTransport } from './api';
import { getDb } from './db';
import { drainOutbox } from './sync';

const RETRY_INTERVAL_MS = 30_000;

let generation = 0;
const runningGenerations = new Set<number>();
let interval: ReturnType<typeof setInterval> | null = null;
let removeAppStateListener: (() => void) | null = null;
let triggerForGeneration: (() => Promise<void>) | null = null;

/** Stops future work synchronously. An already-issued request remains bound to
 * its original owner: its bearer resolves only while that owner's session is
 * current, so it cannot upload another account's rows. */
export function clearSyncRuntime(): void {
  generation += 1;
  triggerForGeneration = null;
  if (interval) clearInterval(interval);
  interval = null;
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

  const trigger = async () => {
    if (
      configuredGeneration !== generation ||
      runningGenerations.has(configuredGeneration) ||
      getActiveDataOwner() !== owner
    ) {
      return;
    }
    runningGenerations.add(configuredGeneration);
    try {
      await drainOutbox(getDb(), transport);
    } catch {
      // Outbox rows remain durable with their attempt history. The foreground
      // event or bounded timer retries without inventing a successful receipt.
    } finally {
      runningGenerations.delete(configuredGeneration);
    }
  };

  triggerForGeneration = trigger;
  interval = setInterval(() => void trigger(), RETRY_INTERVAL_MS);
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
