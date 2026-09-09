import { AppState } from 'react-native';
import {
  bearerTokenFor,
  getApiSession,
  type ApiSession,
} from '../account/apiSession';
import { canonicalDataOwner, getActiveDataOwner } from './accountScope';
import {
  createAnalysisPermitClient,
  createOfflineGrantClient,
  createTransport,
} from './api';
import { recoverAnalysisJournals, runJournal } from '../analysis/runJournal';
import { getDb } from './db';
import { reconcileOfflineWallet } from './offlineWallet';
import { drainOutbox } from './sync';
import { trustedTime } from './trustedTime';

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
const runningGenerations = new Map<number, Promise<void>>();
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
  const scope = runJournal.scope({
    ownerKey: owner,
    apiOrigin: session.apiBaseUrl,
  });
  // The bearer is resolved per request so a rotated access token is used
  // without rebuilding the runtime.
  const apiConfig = {
    baseUrl: scope.apiOrigin,
    get token() {
      const current = getApiSession();
      if (!current) return null;
      try {
        const binding = runJournal.scope({
          ownerKey: current.canonicalAppUserId,
          apiOrigin: current.apiBaseUrl,
        });
        return binding.ownerKey === scope.ownerKey &&
          binding.apiOrigin === scope.apiOrigin
          ? bearerTokenFor(current.canonicalAppUserId)
          : null;
      } catch {
        return null;
      }
    },
  };
  const transport = createTransport(apiConfig);
  const permits = { ...scope, ...createAnalysisPermitClient(apiConfig) };
  const offlineGrants = createOfflineGrantClient(apiConfig);
  let consecutiveFailures = 0;

  const schedule = () => {
    if (configuredGeneration !== generation) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => void trigger(),
      nextSyncRetryDelayMs(consecutiveFailures),
    );
  };

  const trigger = (): Promise<void> => {
    if (configuredGeneration !== generation) return Promise.resolve();
    const running = runningGenerations.get(configuredGeneration);
    if (running) return running;
    if (getActiveDataOwner() !== owner) {
      schedule();
      return Promise.resolve();
    }
    const operation = (async () => {
      try {
        const db = getDb();
        const recovered = await recoverAnalysisJournals(db, scope, permits, {
          excludeOperationIds: runJournal.activeOperationIds(scope),
        });
        if (
          configuredGeneration !== generation ||
          getActiveDataOwner() !== owner
        )
          return;
        const result = await drainOutbox(db, transport);
        if (
          configuredGeneration !== generation ||
          getActiveDataOwner() !== owner
        )
          return;
        // Offline consumption receipts are presented after the results they
        // paid for. A verdict the server withholds keeps the receipt queued
        // and this drain counts as unfinished, so the timer backs off.
        const receipts = await reconcileOfflineWallet(
          db,
          offlineGrants,
          await trustedTime.read(),
        );
        const pendingRecovery =
          recovered.unknownStorage ||
          recovered.items.some(
            item => item.kind === 'pending' || item.kind === 'held',
          );
        consecutiveFailures =
          result.failed > 0 || pendingRecovery || receipts.pending > 0
            ? consecutiveFailures + 1
            : 0;
      } catch {
        // Outbox rows remain durable with their attempt history. The foreground
        // event or the backed-off timer retries without inventing a receipt.
        consecutiveFailures += 1;
      } finally {
        runningGenerations.delete(configuredGeneration);
        schedule();
      }
    })();
    runningGenerations.set(configuredGeneration, operation);
    return operation;
  };

  triggerForGeneration = trigger;
  const subscription = AppState.addEventListener('change', nextState => {
    if (nextState === 'active') void trigger();
  });
  removeAppStateListener = () => subscription.remove();
  void trigger();
}

/** Called after a new local result enters the durable outbox. */
export async function triggerOutboxSync(): Promise<void> {
  await triggerForGeneration?.();
}
