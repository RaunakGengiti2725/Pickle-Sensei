import { AppState } from 'react-native';
import {
  bearerTokenFor,
  getApiSession,
  type ApiSession,
} from '../account/apiSession';
import type { CanonicalAccessState } from '../billing/types';
import { canonicalDataOwner, getActiveDataOwner } from './accountScope';
import {
  ApiError,
  createAnalysisPermitClient,
  createOfflineGrantClient,
  createTransport,
  type OfflineAttestationEnvironment,
  type OfflineGrantClient,
} from './api';
import { recoverAnalysisJournals, runJournal } from '../analysis/runJournal';
import { getDb, type LocalDb } from './db';
import { installationKey } from './installationKey';
import {
  offlineGrantPullNeeded,
  offlinePaidOperationIds,
  readOfflineAllocation,
  requestOfflineGrant,
} from './offlineCapabilities';
import { reconcileOfflineWallet } from './offlineWallet';
import { drainOutbox } from './sync';
import { trustedTime, type TrustedTimeReading } from './trustedTime';
import { useAccessStore } from '../state/accessStore';

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

/** Tickets the app asks the server for: two for a free account (the lifetime
 * allowance the server clamps against what is already scored, reserved or
 * held), none for Pro (a lease authorizes without tickets). The app holds
 * and displays only what the server actually issued. */
export function offlineGrantRequestedTickets(
  access: CanonicalAccessState | null,
): 0 | 2 {
  return access?.premium === true ? 0 : 2;
}

/** The access snapshot a refusal was given under. A refusal is recorded
 * against this key and the pull is not retried until the server-authoritative
 * access state reads differently (an upgrade, a settled reservation, a
 * changed entitlement). */
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

/** A verdict the route itself wrote about the request — paywall, entitlement,
 * allowance exhausted, invalid input, a device the server will not register.
 * 401 (sign in again), 408/429 (try later) and every 5xx or intermediary
 * answer are transport-class and follow the sync backoff instead. */
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
  'idle' | 'held' | 'refused' | 'no_identity' | 'failed';

function attestationEnvironment(): OfflineAttestationEnvironment {
  return __DEV__ ? 'development' : 'production';
}

type AsyncMethod = (...args: never[]) => Promise<unknown>;

/** How a request ended, as online evidence: `answered` — it reached the route
 * and came back readable; `transport` — it left the device and ended in an
 * HTTP-class transport failure (429, 5xx, a redirect or unreadable page the
 * api maps to 502, a 408 awaiting the answer) that the sync back-off
 * retries; `none` — a verdict the route wrote (recorded, not retried) or a
 * request the network stack refused outright (radio gone, no route), which
 * says nothing about the server. */
export type RequestEvidence = 'answered' | 'transport' | 'none';

export function requestEvidence(error: unknown): RequestEvidence {
  if (!(error instanceof ApiError)) return 'none';
  return error.status === 408 || error.status === 429 || error.status >= 500
    ? 'transport'
    : 'none';
}

/** Wraps every method of an API client so the runtime learns, per request,
 * how it ended. Failures are re-thrown unchanged. */
function observingServerAnswers<T extends object>(
  client: T,
  observe: (evidence: RequestEvidence) => void,
): T {
  const observed: Record<string, unknown> = {};
  for (const key of Object.keys(client) as Array<keyof T & string>) {
    const member: unknown = client[key];
    if (typeof member !== 'function') {
      observed[key] = member;
      continue;
    }
    const method = member as AsyncMethod;
    observed[key] = async (...args: never[]) => {
      try {
        const result = await method.apply(client, args);
        observe('answered');
        return result;
      } catch (error) {
        observe(requestEvidence(error));
        throw error;
      }
    };
  }
  return observed as T;
}

let generation = 0;
const runningGenerations = new Map<number, Promise<void>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let removeAppStateListener: (() => void) | null = null;
let removeAccessListener: (() => void) | null = null;
let triggerForGeneration: (() => Promise<void>) | null = null;

/** Owner → the access key a definitive grant refusal was recorded under.
 * Process-wide on purpose: the memo outlives the runtime instance, so a
 * relaunch, a re-sign-in or a re-installed api session under unchanged
 * access does not ask again. */
const refusedOfflineGrants = new Map<string, string>();

/** Exported for tests: the memo is process-wide by design. */
export function resetOfflineGrantRefusals(): void {
  refusedOfflineGrants.clear();
}

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
  removeAccessListener?.();
  removeAccessListener = null;
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
  // Online evidence for the pass in progress: true only while the LAST
  // request this pass made was answered by the server, when the pass was
  // started by a server answer the billing lifecycle just received, or when
  // the previous pass ended in an HTTP-class transport failure this one is
  // the backed-off retry of. A pass with nothing to send and nothing to
  // retry has none — an empty outbox draining cleanly and an anchored
  // trusted-time reading are both indistinguishable from a device whose
  // radio is gone.
  let serverAnswered = false;
  let retryPending = false;
  let rerunAnswered = false;
  const observe = (evidence: RequestEvidence) => {
    serverAnswered = evidence === 'answered';
    if (evidence === 'transport') retryPending = true;
  };
  const transport = observingServerAnswers(createTransport(apiConfig), observe);
  const permits = {
    ...scope,
    ...observingServerAnswers(createAnalysisPermitClient(apiConfig), observe),
  };
  const offlineGrants: OfflineGrantClient = observingServerAnswers(
    createOfflineGrantClient(apiConfig),
    observe,
  );
  let consecutiveFailures = 0;
  const current = () =>
    configuredGeneration === generation && getActiveDataOwner() === owner;

  /** Asks the server for a grant when the wallet holds no executable one.
   * Runs only at the end of a clean pass with online evidence, under an
   * anchored trusted-time reading, for the configured and still-active
   * owner, and never while a refusal stands for the current access state.
   * Register (idempotent) then issue; the server-issued grant is held as-is.
   * Nothing is spent, released or reclaimed here. */
  const pullOfflineGrant = async (
    db: LocalDb,
    reading: TrustedTimeReading,
  ): Promise<OfflineGrantPullOutcome> => {
    if (!serverAnswered) return 'idle';
    if (reading.authority !== 'anchored' || reading.rollbackDetected) {
      return 'idle';
    }
    const access = useAccessStore.getState().canonicalAccess;
    const accessKey = offlineGrantAccessKey(access);
    if (refusedOfflineGrants.get(owner) === accessKey) return 'idle';
    if (!offlineGrantPullNeeded(await readOfflineAllocation(db, reading))) {
      return 'idle';
    }
    const installationKeyId = await installationKey.read();
    if (!installationKeyId) return 'no_identity';
    if (!current()) return 'idle';
    try {
      await offlineGrants.registerDevice({
        installationKeyId,
        attestationEnvironment: attestationEnvironment(),
      });
      if (!current()) return 'idle';
      await requestOfflineGrant(db, offlineGrants, {
        installationKeyId,
        requestedTickets: offlineGrantRequestedTickets(access),
      });
      refusedOfflineGrants.delete(owner);
      return 'held';
    } catch (error) {
      if (isOfflineGrantRefusal(error)) {
        refusedOfflineGrants.set(owner, accessKey);
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

  const pass = async (answered: boolean): Promise<void> => {
    serverAnswered = answered || retryPending;
    retryPending = false;
    try {
      const db = getDb();
      const recovered = await recoverAnalysisJournals(db, scope, permits, {
        excludeOperationIds: runJournal.activeOperationIds(scope),
      });
      if (!current()) return;
      const result = await drainOutbox(db, transport);
      if (!current()) return;
      // Offline consumption receipts are presented after the results they
      // paid for. A verdict the server withholds keeps the receipt queued
      // and this drain counts as unfinished, so the timer backs off.
      const reading = await trustedTime.read();
      const receipts = await reconcileOfflineWallet(db, offlineGrants, reading);
      const unfinished = recovered.items.filter(
        item => item.kind === 'pending' || item.kind === 'held',
      );
      // A run paid for offline is settled by its receipt, not by a permit:
      // its held journal row is not unfinished recovery work.
      const paidOffline = await offlinePaidOperationIds(
        db,
        scope.ownerKey,
        unfinished.map(item => item.operationId),
      );
      const pendingRecovery =
        recovered.unknownStorage ||
        unfinished.some(item => !paidOffline.has(item.operationId));
      const clean =
        result.failed === 0 && !pendingRecovery && receipts.pending === 0;
      const pull =
        clean && current() ? await pullOfflineGrant(db, reading) : 'idle';
      // A clean pass that never reached the server says nothing about an
      // outage the previous pass hit: the back-off is kept, not reset.
      if (!clean || pull === 'failed') consecutiveFailures += 1;
      else if (serverAnswered || pull === 'refused') consecutiveFailures = 0;
    } catch {
      // Outbox rows remain durable with their attempt history. The foreground
      // event or the backed-off timer retries without inventing a receipt.
      consecutiveFailures += 1;
    }
  };

  const trigger = (answered = false): Promise<void> => {
    if (configuredGeneration !== generation) return Promise.resolve();
    const running = runningGenerations.get(configuredGeneration);
    if (running) {
      if (answered) rerunAnswered = true;
      return running;
    }
    if (getActiveDataOwner() !== owner) {
      schedule();
      return Promise.resolve();
    }
    const operation = (async () => {
      try {
        // A server answer that arrives mid-pass reached a pass that had
        // already decided without it: run once more before settling.
        let startAnswered = answered;
        do {
          rerunAnswered = false;
          await pass(startAnswered);
          startAnswered = true;
        } while (rerunAnswered && current());
      } finally {
        runningGenerations.delete(configuredGeneration);
        schedule();
      }
    })();
    runningGenerations.set(configuredGeneration, operation);
    return operation;
  };

  triggerForGeneration = () => trigger();
  const subscription = AppState.addEventListener('change', nextState => {
    if (nextState === 'active') void trigger();
  });
  removeAppStateListener = () => subscription.remove();
  // The billing lifecycle publishes every server answer to the access check
  // as a new canonical snapshot: the server was just reached, so a pass
  // started by it carries online evidence of its own.
  removeAccessListener = useAccessStore.subscribe((state, previous) => {
    if (
      state.canonicalAccess !== null &&
      state.canonicalAccess !== previous.canonicalAccess &&
      configuredGeneration === generation &&
      getActiveDataOwner() === owner &&
      apiConfig.token !== null
    ) {
      void trigger(true);
    }
  });
  void trigger();
}

/** Called after a new local result enters the durable outbox. */
export async function triggerOutboxSync(): Promise<void> {
  await triggerForGeneration?.();
}
