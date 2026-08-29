/**
 * Offline / weak-network handling (workstream i28).
 *
 * Logic-level proof over the real sync engine, API client and session state
 * machine that poor network cannot cause:
 *   - lost attempts (durable outbox rows survive every transient failure),
 *   - infinite spinners (bounded request timeout; queue status derived only
 *     from durable rows; session events never stick in 'processing'),
 *   - duplicate analyses (client UUIDs + idempotent upserts make ambiguous
 *     retries duplicate-safe),
 *   - corrupt sessions (receipt/delete is transactional; a mid-write failure
 *     rolls back and the row stays queued).
 *
 * HONEST LIMIT: REAL device network-loss testing (airplane mode mid-upload,
 * radio flapping) is BLOCKED_EXTERNAL — see REAL_DEVICE_NETWORK_TESTING.
 */
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../src/data/db';
import {
  drainOutbox,
  isPermanentSyncFailure,
  OUTBOX_MAX_ATTEMPTS,
} from '../src/data/sync';
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createTransport,
} from '../src/data/api';
import {
  capabilitiesByDependency,
  capabilityDependency,
  deriveUploadQueueStatus,
  OFFLINE_CAPABILITY_MAP_V1,
  REAL_DEVICE_NETWORK_TESTING,
  type CapabilityId,
} from '../src/data/offlineCapabilities';
import {
  createPendingStubAnalysisProvider,
  DEV_REPLAY_RALLY,
  LiveSessionFlow,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  type SessionEventAnalysisProvider,
} from '../src/flow/session';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

// ─── Fake durable store (same contract the sqlite driver satisfies) ────────

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

function fakeDb(options?: { failReceiptWrites?: () => boolean }) {
  const outbox: OutboxRow[] = [];
  const receipts: Array<{ owner: string; entityId: string }> = [];
  let nextId = 1;
  let inTransaction = false;
  let transactionReceipts: Array<{ owner: string; entityId: string }> = [];
  let transactionDeletes: number[] = [];
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      if (sql === 'BEGIN IMMEDIATE') {
        inTransaction = true;
        transactionReceipts = [];
        transactionDeletes = [];
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        inTransaction = false;
        receipts.push(...transactionReceipts);
        for (const id of transactionDeletes) {
          const idx = outbox.findIndex(row => row.id === id);
          if (idx >= 0) outbox.splice(idx, 1);
        }
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        inTransaction = false;
        transactionReceipts = [];
        transactionDeletes = [];
        return { rows: [] };
      }
      if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
        if (options?.failReceiptWrites?.()) {
          throw new Error('disk I/O error');
        }
        const receipt = {
          owner: String(params[0]),
          entityId: String(params[1]),
        };
        if (inTransaction) transactionReceipts.push(receipt);
        else receipts.push(receipt);
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
          if (inTransaction) transactionDeletes.push(row.id);
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
  const push = (kind: string, payload: unknown) => {
    outbox.push({
      id: nextId++,
      owner_key: GUEST_DATA_OWNER,
      kind,
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

/** Fake server with real idempotent-upsert semantics: accepting the same
 * client UUID twice stores exactly one record — the contract the API's
 * /v1/shots:sync upsert provides. */
function idempotentServer() {
  const stored = new Set<string>();
  let uploads = 0;
  return {
    stored,
    uploadCount: () => uploads,
    accept(shots: unknown[]): string[] {
      uploads += 1;
      const ids = shots.map(shot => (shot as { id: string }).id);
      for (const id of ids) stored.add(id);
      return ids;
    },
  };
}

describe('offline capability map', () => {
  it('classifies every capability with a consistent offline degradation', () => {
    const entries = Object.values(OFFLINE_CAPABILITY_MAP_V1);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(OFFLINE_CAPABILITY_MAP_V1[entry.id]).toBe(entry);
      expect(entry.implementedBy.length).toBeGreaterThan(0);
      expect(entry.offlineBehavior.length).toBeGreaterThan(0);
      if (entry.dependency === 'on-device') {
        // On-device work never degrades offline and never queues.
        expect(entry.degradation).toBe('works_offline');
      } else {
        // Anything touching the server must degrade explicitly — nothing
        // may claim full offline function.
        expect(entry.degradation).not.toBe('works_offline');
      }
      if (entry.degradation === 'queues_durably') {
        expect(entry.dependency).toBe('server-dependent');
      }
    }
  });

  it('labels the load-bearing capabilities as the code implements them', () => {
    expect(capabilityDependency('capture.recordClip')).toBe('on-device');
    expect(capabilityDependency('session.livePlay')).toBe('on-device');
    expect(capabilityDependency('history.browse')).toBe('on-device');
    expect(capabilityDependency('sync.shotUpload')).toBe('server-dependent');
    expect(capabilityDependency('auth.signIn')).toBe('server-dependent');
    // Scoring is HYBRID: inference is local but the permit gate is not.
    expect(capabilityDependency('analysis.strokeScoring')).toBe('hybrid');
    expect(capabilityDependency('billing.entitlement')).toBe('hybrid');
  });

  it('partitions capabilities exhaustively across the three dependencies', () => {
    const all = [
      ...capabilitiesByDependency('on-device'),
      ...capabilitiesByDependency('server-dependent'),
      ...capabilitiesByDependency('hybrid'),
    ].map(entry => entry.id);
    const ids = Object.keys(OFFLINE_CAPABILITY_MAP_V1) as CapabilityId[];
    expect(all.sort()).toEqual([...ids].sort());
  });

  it('records real device network-loss testing as BLOCKED_EXTERNAL', () => {
    expect(REAL_DEVICE_NETWORK_TESTING.status).toBe('BLOCKED_EXTERNAL');
  });
});

describe('no lost attempts under sustained transient failure', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('a row survives more transient failures than the permanent attempt cap', async () => {
    const { db, push, outbox } = fakeDb();
    push('shot.sync', analysis);
    const offline = {
      syncShots: async (): Promise<never> => {
        throw new TypeError('Network request failed');
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 3; i++) {
      const result = await drainOutbox(db, offline);
      expect(result.remaining).toBe(1);
    }
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.attempts).toBe(0);
    expect(outbox[0]!.last_error).toContain('Network request failed');
    // The row is still eligible: back online, it syncs and clears.
    const server = idempotentServer();
    const recovered = await drainOutbox(db, {
      syncShots: async shots => ({
        acceptedIds: server.accept(shots),
        rejected: [],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(recovered).toMatchObject({ synced: 1, remaining: 0 });
  });

  it('timeouts, 5xx, 401 and 429 are transient; 4xx contract errors are permanent', () => {
    expect(
      isPermanentSyncFailure(new ApiError(408, 'network.timeout', 'timeout')),
    ).toBe(false);
    expect(isPermanentSyncFailure(new ApiError(503, 'server.down', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(401, 'auth.expired', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new ApiError(429, 'rate.limited', ''))).toBe(
      false,
    );
    expect(isPermanentSyncFailure(new TypeError('offline'))).toBe(false);
    expect(isPermanentSyncFailure(new ApiError(422, 'shot.invalid', ''))).toBe(
      true,
    );
  });
});

describe('no duplicate analyses across ambiguous retries', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('a response lost in transit re-sends the same UUID; the upsert stores one record', async () => {
    const { db, push, outbox, receipts } = fakeDb();
    push('shot.sync', analysis);
    const server = idempotentServer();
    // Upload 1: the server RECEIVES and stores the shot, but the response is
    // lost on the way back — the client cannot distinguish this from a
    // request that never arrived.
    await drainOutbox(db, {
      syncShots: async shots => {
        server.accept(shots);
        throw new TypeError('Network request failed');
      },
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(outbox).toHaveLength(1);
    expect(outbox[0]!.attempts).toBe(0);
    // Upload 2 (reconnect): the SAME client UUID goes up; the idempotent
    // upsert acknowledges without creating a second record.
    const result = await drainOutbox(db, {
      syncShots: async shots => ({
        acceptedIds: server.accept(shots),
        rejected: [],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    });
    expect(result).toMatchObject({ synced: 1, remaining: 0 });
    expect(server.uploadCount()).toBe(2);
    expect(server.stored.size).toBe(1);
    expect(receipts).toEqual([
      { owner: GUEST_DATA_OWNER, entityId: analysis.id },
    ]);
  });
});

describe('no corrupt local state when acknowledgement handling fails', () => {
  beforeEach(() => setActiveDataOwner(GUEST_DATA_OWNER));
  afterAll(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it('a failed receipt write rolls back atomically; the row stays queued and later syncs cleanly', async () => {
    let fail = true;
    const { db, push, outbox, receipts } = fakeDb({
      failReceiptWrites: () => fail,
    });
    push('shot.sync', analysis);
    const server = idempotentServer();
    const transport = {
      syncShots: async (shots: unknown[]) => ({
        acceptedIds: server.accept(shots),
        rejected: [],
      }),
      createSession: async () => {},
      finalizeSession: async () => {},
    };
    // The server accepted, but the local receipt write dies mid-transaction.
    // Neither half applies: no receipt, and the row is NOT deleted.
    const broken = await drainOutbox(db, transport);
    expect(broken.synced).toBe(0);
    expect(receipts).toHaveLength(0);
    expect(outbox).toHaveLength(1);
    // Recovery drains the same row; idempotency absorbs the re-send.
    fail = false;
    const recovered = await drainOutbox(db, transport);
    expect(recovered).toMatchObject({ synced: 1, remaining: 0 });
    expect(receipts).toEqual([
      { owner: GUEST_DATA_OWNER, entityId: analysis.id },
    ]);
    expect(server.stored.size).toBe(1);
  });
});

describe('no infinite spinners', () => {
  it('the API layer aborts a hung request at the bounded timeout with a typed retryable error', async () => {
    jest.useFakeTimers();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('aborted')),
        );
      })) as typeof fetch;
    try {
      const transport = createTransport({
        baseUrl: 'https://api.test',
        token: 'token',
      });
      const pending = transport.syncShots([]);
      const settled = pending.then(
        () => 'resolved' as const,
        error => error as unknown,
      );
      jest.advanceTimersByTime(API_REQUEST_TIMEOUT_MS + 1);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(ApiError);
      const apiError = outcome as ApiError;
      expect(apiError.status).toBe(408);
      expect(apiError.code).toBe('network.timeout');
      // The timeout is transient: the queued row keeps its retry budget.
      expect(isPermanentSyncFailure(apiError)).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      jest.useRealTimers();
    }
  });

  it('upload queue status derives from durable rows only — there is no uploading state to get stuck in', () => {
    expect(deriveUploadQueueStatus([])).toEqual({ state: 'idle' });
    expect(
      deriveUploadQueueStatus([
        { kind: 'shot.sync', attempts: 0, lastError: 'offline' },
        { kind: 'session.create', attempts: 0, lastError: null },
      ]),
    ).toEqual({ state: 'queued', pending: 2 });
    expect(
      deriveUploadQueueStatus([
        { kind: 'shot.sync', attempts: 0, lastError: 'offline' },
        {
          kind: 'shot.sync',
          attempts: OUTBOX_MAX_ATTEMPTS,
          lastError: 'shot.invalid: bad payload',
        },
      ]),
    ).toEqual({ state: 'needs_attention', pending: 1, exhausted: 1 });
  });
});

describe('session state machine under network failure', () => {
  it('an unavailable provider leaves every event honestly pending — never processing', async () => {
    const flow = new LiveSessionFlow({
      sessionId: 'offline-session-1',
      source: 'replay',
      provider: createPendingStubAnalysisProvider(),
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    const snapshot = flow.end();
    await flow.settled();
    expect(snapshot.events.length).toBeGreaterThan(0);
    for (const event of flow.snapshot().events) {
      expect(event.state).toBe('pending');
      expect(event.pendingReason).toBe(NATIVE_CLIP_EXTRACTION_NOT_BUILT);
    }
  });

  it('a provider that dies mid-flight terminates the event honestly instead of leaving it processing', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-network-failing-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => {
        throw new TypeError('Network request failed');
      },
    };
    const flow = new LiveSessionFlow({
      sessionId: 'offline-session-2',
      source: 'replay',
      provider,
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const events = flow.snapshot().events;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.state).toBe('abstained');
      expect(event.abstainReason).toContain('ANALYSIS_DISPATCH_FAILED');
      expect(event.abstainReason).toContain('Network request failed');
    }
  });

  it('a provider reporting it cannot start reverts the event to pending with the reason', async () => {
    const provider: SessionEventAnalysisProvider = {
      providerId: 'test-offline-pending-provider',
      availability: () => ({ status: 'available' }),
      analyzeEvent: async () => ({
        status: 'pending',
        pendingReason: 'DEVICE_OFFLINE_PERMIT_UNAVAILABLE',
      }),
    };
    const flow = new LiveSessionFlow({
      sessionId: 'offline-session-3',
      source: 'replay',
      provider,
    });
    for (const sample of DEV_REPLAY_RALLY.samples) flow.pushSample(sample);
    flow.end();
    await flow.settled();
    const events = flow.snapshot().events;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.state).toBe('pending');
      expect(event.pendingReason).toBe('DEVICE_OFFLINE_PERMIT_UNAVAILABLE');
    }
  });
});
