import { AppState } from 'react-native';
import {
  bearerTokenFor,
  getApiSession,
  type ApiSession,
} from '../account/apiSession';
import { canonicalDataOwner, getActiveDataOwner } from './accountScope';
import {
  ApiError,
  createAnalysisPermitClient,
  createOfflineGrantClient,
  createTransport,
  type OfflineGrantClient,
} from './api';
import { recoverAnalysisJournals, runJournal } from '../analysis/runJournal';
import type { CanonicalAccessState } from '../billing/types';
import { useAccessStore } from '../state/accessStore';
import { getDb, type LocalDb } from './db';
import { installationKey } from './installationKey';
import {
  offlineGrantPullNeeded,
  readOfflineAllocation,
  requestOfflineGrant,
} from './offlineCapabilities';
import { reconcileOfflineWallet } from './offlineWallet';
import { drainOutbox } from './sync';
import { trustedTime, type TrustedTimeReading } from './trustedTime';

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

/** What the app asks the server for: two free tickets unless the
 * server-authoritative access snapshot says Pro, whose lease carries none.
 * The server clamps either way; the wallet shows only what it issued. */
export function offlineGrantRequestedTickets(
  access: CanonicalAccessState | null,
): 0 | 2 {
  return access?.premium === true ? 0 : 2;
}

/** The access facts a grant refusal was recorded under. A refusal is not
 * retried until this changes — a paywall answer does not become a grant by
 * asking again, only by access changing (a purchase, a restored
 * entitlement, a reconciled allowance). */
export function offlineGrantAccessKey(
  access: CanonicalAccessState | null,
): string {
  if (!access) return 'unknown';
  return [
    access.premium ? 'pro' : 'free',
    access.freeRatings.used,
    access.freeRatings.reserved,
    access.freeRatings.remaining,
    access.freeRatings.availableToReserve,
    ...access.entitlements,
  ].join(':');
}

/** A definitive server answer to a registration or grant request (paywall,
 * entitlement, allowance exhausted, unattested or unknown device, refused
 * input): recorded, never retried on the backoff. Auth expiry, timeouts,
 * rate limits and 5xx are transport conditions the ordinary pass retries. */
export function isOfflineGrantRefusal(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

export type OfflineGrantPullOutcome =
  'held' | 'idle' | 'no_identity' | 'refused' | 'failed';

/** The attestation environment this build registers under. The server
 * refuses an environment change for a known installation, so it must be a
 * property of the build, never of the moment. */
function attestationEnvironment(): 'production' | 'development' {
  return __DEV__ ? 'development' : 'production';
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
  let refusedUnderAccess: string | null = null;

  // Runs only at the end of a CLEAN pass (every request reached the server,
  // nothing pending) under an anchored trusted-time reading: that is the
  // app's signal. Allocation only — it never spends, releases or reclaims.
  const pullOfflineGrant = async (
    db: LocalDb,
    client: OfflineGrantClient,
    reading: TrustedTimeReading,
  ): Promise<OfflineGrantPullOutcome> => {
    if (reading.authority !== 'anchored' || reading.rollbackDetected) {
      return 'idle';
    }
    const access = useAccessStore.getState().canonicalAccess;
    const accessKey = offlineGrantAccessKey(access);
    if (refusedUnderAccess === accessKey) return 'idle';
    if (!offlineGrantPullNeeded(await readOfflineAllocation(db, reading))) {
      return 'idle';
    }
    const installationKeyId = await installationKey.read();
    if (!installationKeyId) return 'no_identity';
    if (configuredGeneration !== generation || getActiveDataOwner() !== owner)
      return 'idle';
    try {
      await client.registerDevice({
        installationKeyId,
        attestationEnvironment: attestationEnvironment(),
      });
      if (configuredGeneration !== generation || getActiveDataOwner() !== owner)
        return 'idle';
      await requestOfflineGrant(db, client, {
        installationKeyId,
        requestedTickets: offlineGrantRequestedTickets(access),
      });
      refusedUnderAccess = null;
      return 'held';
    } catch (error) {
      if (isOfflineGrantRefusal(error)) {
        refusedUnderAccess = accessKey;
        return 'refused';
      }
      return 'failed';
    }
  };

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
        const reading = await trustedTime.read();
        const receipts = await reconcileOfflineWallet(
          db,
          offlineGrants,
          reading,
        );
        const pendingRecovery =
          recovered.unknownStorage ||
          recovered.items.some(
            item => item.kind === 'pending' || item.kind === 'held',
          );
        const clean =
          result.failed === 0 && !pendingRecovery && receipts.pending === 0;
        const pull =
          clean &&
          configuredGeneration === generation &&
          getActiveDataOwner() === owner
            ? await pullOfflineGrant(db, offlineGrants, reading)
            : 'idle';
        consecutiveFailures =
          clean && pull !== 'failed' ? 0 : consecutiveFailures + 1;
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
