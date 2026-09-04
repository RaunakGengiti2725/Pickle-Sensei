/**
 * Workflow audit — offline / network-error resilience (data + store layer).
 *
 * Drives the real API client, sync engine, and the consent / access stores
 * through the failure classes a real user hits: airplane mode (fetch
 * rejects), a hung backend (timeout), 401 expired session, 429 + Retry-After,
 * generic 5xx bodies. Every operation must settle to a typed result with
 * user-visible copy — never an unresolved await, never an invented success.
 *
 * HONEST LIMIT: real airplane-mode / radio-flapping runs need a physical
 * device build (REAL_DEVICE_NETWORK_TESTING is BLOCKED_EXTERNAL).
 */
jest.mock('../../src/account/apiSession', () => {
  let session: unknown = null;
  return {
    getApiSession: () => session,
    reportApiUnauthorized: jest.fn(),
    __setSession: (next: unknown) => {
      session = next;
    },
  };
});

import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createAnalysisPermitClient,
  createTransport,
} from '../../src/data/api';
import {
  drainOutbox,
  isPermanentSyncFailure,
  OUTBOX_MAX_ATTEMPTS,
  type SyncTransport,
} from '../../src/data/sync';
import {
  deriveUploadQueueStatus,
  OFFLINE_CAPABILITY_MAP_V1,
  type OutboxRowStatus,
  REAL_DEVICE_NETWORK_TESTING,
} from '../../src/data/offlineCapabilities';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useConsentStore } from '../../src/state/consentStore';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';
import type {
  BillingAccessDependencies,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';
import * as apiSessionModule from '../../src/account/apiSession';

const setSession = (
  apiSessionModule as unknown as { __setSession: (s: unknown) => void }
).__setSession;

// ─── Fake fetch responses ──────────────────────────────────────────────────

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}

const offlineFetch = jest.fn(async () => {
  throw new TypeError('Network request failed');
});

// ─── Fake durable store (same contract the sqlite driver satisfies) ────────

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function statusRows(rows: readonly OutboxRow[]): OutboxRowStatus[] {
  return rows.map(row => ({
    kind: row.kind,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}

function fakeDb() {
  const outbox: OutboxRow[] = [];
  const receipts: string[] = [];
  let nextId = 1;
  let pendingReceipts: string[] = [];
  let pendingDeletes: number[] = [];
  let inTx = false;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE') {
        inTx = true;
        pendingReceipts = [];
        pendingDeletes = [];
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        inTx = false;
        receipts.push(...pendingReceipts);
        for (const id of pendingDeletes) {
          const idx = outbox.findIndex(row => row.id === id);
          if (idx >= 0) outbox.splice(idx, 1);
        }
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        inTx = false;
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        if (inTx) pendingReceipts.push(String(params[1]));
        else receipts.push(String(params[1]));
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('DELETE FROM outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (row) {
          if (inTx) pendingDeletes.push(row.id);
          else outbox.splice(outbox.indexOf(row), 1);
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (sql.startsWith('SELECT ls.id AS id FROM local_session')) {
        // No local_session rows exist in this fake: no parked set to re-queue.
        return { rows: [] };
      }
      if (sql.startsWith('SELECT count(*)')) {
        return {
          rows: [
            { n: outbox.filter(row => row.owner_key === params[0]).length },
          ],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  const push = (payload: unknown) => {
    outbox.push({
      id: nextId++,
      owner_key: GUEST_DATA_OWNER,
      kind: 'shot.sync',
      payload: JSON.stringify(payload),
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox, receipts };
}

const analysis: ShotAnalysis & { analysisPermitId: string } = {
  id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
  analysisPermitId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
};

function failingTransport(error: unknown): SyncTransport {
  return {
    syncShots: jest.fn(async () => {
      throw error;
    }),
    createSession: jest.fn(async () => {}),
    finalizeSession: jest.fn(async () => {}),
  };
}

// ─── API client ────────────────────────────────────────────────────────────

describe('API client: every request settles to a typed result', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('hung backend → typed 408 network.timeout with user-visible copy, never an unresolved await', async () => {
    jest.useFakeTimers();
    globalThis.fetch = jest.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('Aborted')),
          );
        }),
    ) as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'tok',
    });
    const pending = transport.syncShots([]);
    const settled = jest.fn();
    pending.then(settled, settled);
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).rejects.toMatchObject({
      status: 408,
      code: 'network.timeout',
    });
    const error = settled.mock.calls[0]![0] as ApiError;
    expect(error.message).toContain('Your work is saved on this device');
  });

  it('airplane mode → the transport rejects with the fetch error (no invented acceptance)', async () => {
    globalThis.fetch = offlineFetch as unknown as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'tok',
    });
    await expect(transport.syncShots([analysis])).rejects.toThrow(
      'Network request failed',
    );
  });

  it('429 + Retry-After and generic 5xx bodies become typed ApiErrors carrying the server copy', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResponse(
        429,
        {
          error: {
            code: 'rate_limited',
            message: 'Too many requests. Try again shortly.',
          },
        },
        { 'retry-after': '7' },
      ),
    ) as unknown as typeof fetch;
    const transport = createTransport({
      baseUrl: 'https://api.test',
      token: 'tok',
    });
    await expect(transport.syncShots([analysis])).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests. Try again shortly.',
    });

    globalThis.fetch = jest.fn(async () =>
      jsonResponse(503, {
        error: {
          code: 'service_unavailable',
          message: 'The service is temporarily unavailable. Please retry.',
        },
      }),
    ) as unknown as typeof fetch;
    await expect(
      createTransport({ baseUrl: 'https://api.test', token: 'tok' }).syncShots([
        analysis,
      ]),
    ).rejects.toMatchObject({ status: 503, code: 'service_unavailable' });
  });

  it('401 expired session surfaces as a typed 401 with the server message', async () => {
    globalThis.fetch = jest.fn(async () =>
      jsonResponse(401, {
        error: { message: 'The identity token could not be verified.' },
      }),
    ) as unknown as typeof fetch;
    const permits = createAnalysisPermitClient({
      baseUrl: 'https://api.test',
      token: 'expired',
    });
    await expect(permits.reserve('idem-1')).rejects.toMatchObject({
      status: 401,
      message: 'The identity token could not be verified.',
    });
  });

  it('permit reservation without a session fails closed with auth.required copy, without touching the network', async () => {
    const fetchSpy = jest.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    const permits = createAnalysisPermitClient({
      baseUrl: 'https://api.test',
      token: null,
    });
    await expect(permits.reserve('idem-2')).rejects.toMatchObject({
      status: 401,
      code: 'auth.required',
      message: 'Sign in before reserving an analysis rating.',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─── Sync engine ───────────────────────────────────────────────────────────

describe('outbox: retry classification and durability', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('offline, timeout, 401, 429 and 5xx are transient; ordinary 4xx is permanent', () => {
    expect(
      isPermanentSyncFailure(new TypeError('Network request failed')),
    ).toBe(false);
    expect(
      isPermanentSyncFailure(new ApiError(408, 'network.timeout', '')),
    ).toBe(false);
    expect(isPermanentSyncFailure(new ApiError(401, 'unknown', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(429, 'rate_limited', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(503, 'unavailable', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(400, 'bad_request', ''))).toBe(
      true,
    );
    expect(isPermanentSyncFailure(new ApiError(422, 'invalid', ''))).toBe(true);
  });

  it('a 429 never burns the retry budget: the row stays queued with the error recorded', async () => {
    const { db, push, outbox } = fakeDb();
    push(analysis);
    const transport = failingTransport(
      new ApiError(429, 'rate_limited', 'Too many requests'),
    );
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i++) {
      const result = await drainOutbox(db, transport);
      expect(result).toMatchObject({ synced: 0, failed: 1 });
    }
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('Too many requests');
    expect(deriveUploadQueueStatus(statusRows(outbox))).toEqual({
      state: 'queued',
      pending: 1,
    });
  });

  it('a 401 expired session is transient: nothing is dropped, the row waits for a fresh session', async () => {
    const { db, push, outbox, receipts } = fakeDb();
    push(analysis);
    await drainOutbox(
      db,
      failingTransport(
        new ApiError(
          401,
          'unknown',
          'The identity token could not be verified.',
        ),
      ),
    );
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.attempts).toBe(0);
    expect(receipts).toHaveLength(0);
  });

  it('a permanent 4xx burns exactly one attempt per drain and stops at the cap', async () => {
    const { db, push, outbox } = fakeDb();
    push(analysis);
    const transport = failingTransport(new ApiError(400, 'bad', 'rejected'));
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS; i++) {
      await drainOutbox(db, transport);
      expect(outbox[0]!.attempts).toBe(i + 1);
    }
    const afterCap = await drainOutbox(db, transport);
    // The exhausted row is skipped but still counted as remaining evidence.
    expect(afterCap).toEqual({ synced: 0, failed: 0, remaining: 1 });
    expect(transport.syncShots).toHaveBeenCalledTimes(OUTBOX_MAX_ATTEMPTS);
    expect(deriveUploadQueueStatus(statusRows(outbox))).toEqual({
      state: 'needs_attention',
      pending: 0,
      exhausted: 1,
    });
  });

  it('a retry after an ambiguous failure resends the SAME client id, so the server upsert cannot duplicate', async () => {
    const { db, push, outbox, receipts } = fakeDb();
    push(analysis);
    const seen: string[] = [];
    let calls = 0;
    const transport: SyncTransport = {
      syncShots: jest.fn(async (shots: unknown[]) => {
        calls += 1;
        for (const shot of shots) seen.push((shot as { id: string }).id);
        if (calls === 1) throw new TypeError('Network request failed');
        return {
          acceptedIds: shots.map(shot => (shot as { id: string }).id),
          rejected: [],
        };
      }),
      createSession: jest.fn(async () => {}),
      finalizeSession: jest.fn(async () => {}),
    };
    await drainOutbox(db, transport);
    expect(outbox).toHaveLength(1);
    const second = await drainOutbox(db, transport);
    expect(second).toMatchObject({ synced: 1, failed: 0 });
    expect(new Set(seen)).toEqual(new Set([analysis.id]));
    expect(receipts).toEqual([analysis.id]);
    expect(outbox).toHaveLength(0);
  });

  it('records the real-device network test as externally blocked and documents every server-touching capability', () => {
    expect(REAL_DEVICE_NETWORK_TESTING.status).toBe('BLOCKED_EXTERNAL');
    expect(
      OFFLINE_CAPABILITY_MAP_V1['analysis.permitReservation'].degradation,
    ).toBe('unavailable_offline');
    expect(OFFLINE_CAPABILITY_MAP_V1['sync.shotUpload'].degradation).toBe(
      'queues_durably',
    );
  });
});

// ─── Consent store ─────────────────────────────────────────────────────────

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'tok',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple' as const,
};

describe('consent store: no silent toggle failure', () => {
  beforeEach(() => {
    setSession(session);
    useConsentStore.setState({
      availability: 'loading',
      modelTrainingActive: false,
      lastActionAt: null,
      busy: false,
      error: null,
    });
  });
  afterEach(() => setSession(null));

  it('offline hydrate → unavailable with visible copy, consent stays off', async () => {
    await useConsentStore.getState().hydrate(offlineFetch);
    const state = useConsentStore.getState();
    expect(state.availability).toBe('unavailable');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toBe('Consent settings are temporarily unavailable.');
  });

  it('a 5xx on grant keeps the ledger truth (off), clears busy and shows copy', async () => {
    await useConsentStore
      .getState()
      .hydrate(async () =>
        jsonResponse(200, { subjectPseudonym: null, scopes: [] }),
      );
    expect(useConsentStore.getState().availability).toBe('ready');
    await useConsentStore
      .getState()
      .setModelTrainingConsent(true, async () =>
        jsonResponse(503, { error: { message: 'generic' } }),
      );
    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toBe('Consent settings are temporarily unavailable.');
  });

  it('double-tapping the toggle sends exactly one request', async () => {
    let resolveFetch!: (r: Response) => void;
    const fetchFn = jest.fn(
      () =>
        new Promise<Response>(resolve => {
          resolveFetch = resolve;
        }),
    );
    const first = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    const second = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    expect(useConsentStore.getState().busy).toBe(true);
    resolveFetch(
      jsonResponse(200, {
        subjectPseudonym: null,
        scopes: [
          {
            scope: 'model_training',
            active: true,
            consentVersion: 'model-training-v1',
            lastAction: 'granted',
            lastActionAt: '2026-09-01T00:00:00.000Z',
          },
        ],
      }),
    );
    await Promise.all([first, second]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: true,
    });
  });

  it('signed out → toggling is a no-op that never touches the network', async () => {
    setSession(null);
    const fetchFn = jest.fn();
    await useConsentStore.getState().hydrate(fetchFn);
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(useConsentStore.getState().availability).toBe('signed_out');
  });
});

// ─── Access store ──────────────────────────────────────────────────────────

const freeAccess: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  },
  canStartRating: true,
  paywallRequired: false,
};

const plans: StorePlans = {
  offeringId: 'default',
  annual: {
    id: 'annual',
    productId: 'pickle_sensei_pro_annual',
    period: 'annual',
    price: 59.99,
    priceString: '$59.99',
    pricePerMonthString: '$5.00',
    freeTrial: null,
  },
  monthly: {
    id: 'monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly',
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: {
    id: 'lifetime',
    productId: 'pickle_sensei_pro_lifetime',
    period: 'lifetime',
    price: 159.99,
    priceString: '$159.99',
    pricePerMonthString: null,
    freeTrial: null,
  },
};

function billingDeps(
  getAccess: () => Promise<CanonicalAccessState>,
): BillingAccessDependencies {
  return {
    store: {
      configure: jest.fn(async () => undefined),
      loadPlans: jest.fn(async () => plans),
      purchase: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      restore: jest.fn(async () => ({
        premium: true,
        productId: 'pickle_sensei_pro_annual',
        expirationDate: null,
      })),
      readEntitlement: jest.fn(async () => ({
        premium: false,
        productId: null,
        expirationDate: null,
      })),
    },
    backend: {
      getAccess: jest.fn(getAccess),
      syncBilling: jest.fn(async () => {
        throw new Error('not exercised');
      }),
    },
  };
}

describe('access store: billing fails closed with visible copy', () => {
  beforeEach(() => clearAccessStoreConfiguration());

  it('offline access check → status error, canonicalAccess null, operation idle, retryable copy', async () => {
    const deps = billingDeps(async () => {
      throw new TypeError('Network request failed');
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const state = useAccessStore.getState();
    expect(state.status).toBe('error');
    expect(state.operation).toBe('idle');
    expect(state.canonicalAccess).toBeNull();
    expect(state.error?.message).toBe(
      'Membership verification is temporarily unavailable.',
    );
    expect(state.error?.retryable).toBe(true);
  });

  it('purchase is refused (false, no store call) while server access is unverified, and never leaves operation busy', async () => {
    const deps = billingDeps(async () => {
      throw new TypeError('Network request failed');
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    const verified = await useAccessStore.getState().purchaseSelected();
    expect(verified).toBe(false);
    expect(deps.store.purchase).not.toHaveBeenCalled();
    expect(useAccessStore.getState().operation).toBe('idle');
    expect(useAccessStore.getState().error).not.toBeNull();
  });

  it('retrying after the network returns recovers to ready', async () => {
    let online = false;
    const deps = billingDeps(async () => {
      if (!online) throw new TypeError('Network request failed');
      return freeAccess;
    });
    configureAccessStore(deps);
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState().status).toBe('error');
    online = true;
    await useAccessStore.getState().initialize();
    expect(useAccessStore.getState()).toMatchObject({
      status: 'ready',
      canonicalAccess: freeAccess,
      error: null,
    });
  });
});
