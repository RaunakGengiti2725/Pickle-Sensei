import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pipeline from '@pickle/analysis-pipeline';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import {
  recoverAnalysisJournals,
  runJournal,
} from '../../src/analysis/runJournal';
import { createAnalysisPermitClient } from '../../src/data/api';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listRealAnalysisFacts,
  listShots,
} from '../../src/data/repository';
import { drainOutbox } from '../../src/data/sync';
import { getApiSession } from '../../src/account/apiSession';
import { closeSqliteTestDatabases } from '../../testSupport/sqlite';
import {
  ADV_API_ORIGIN,
  ADV_OWNER_A,
  ADV_OWNER_B,
  advCaptureRequest,
  advFixture,
  advOpenDb,
  advRows,
  advSeedCapture,
  advServer,
  advSignIn,
  advSignOut,
  advTransport,
  deferred,
  type AdvStore,
} from '../../testSupport/advJourneyHarness';

/**
 * ATTACK AREA: sign-in -> capture/import -> analysis -> result -> sync ->
 * relaunch -> history, with network loss at the sync step, a lost server
 * acknowledgement, process death between reservation and inference, and an
 * account switch in the middle of the journey.
 *
 * "Relaunch" is a real close + reopen of a file-backed SQLite database, so
 * every startup migration and cleanup statement runs against the persisted
 * state exactly as it would on the device.
 */

jest.mock('@pickle/analysis-pipeline', () => {
  const actual = jest.requireActual('@pickle/analysis-pipeline');
  return { ...actual, analyzeCapture: jest.fn(actual.analyzeCapture) };
});
jest.mock('../../src/camera/capture', () => ({
  ...jest.requireActual('../../src/camera/capture'),
  readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
}));

const CAPTURE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const originalFetch = globalThis.fetch;
let mockReadArtifact: (uri: string) => Promise<string>;
let dir: string;
let dbPath: string;

function permitPort(owner: string) {
  const scope = { ownerKey: owner, apiOrigin: ADV_API_ORIGIN };
  return {
    scope,
    port: {
      ...scope,
      ...createAnalysisPermitClient({
        baseUrl: ADV_API_ORIGIN,
        get token() {
          const session = getApiSession();
          return session?.canonicalAppUserId === owner
            ? session.bearerToken
            : null;
        },
      }),
    },
  };
}

async function relaunch(store: AdvStore): Promise<AdvStore> {
  store.close();
  return advOpenDb(dbPath);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'adv-journey-'));
  dbPath = join(dir, 'pickle.sqlite');
  jest
    .mocked(pipeline.analyzeCapture)
    .mockReset()
    .mockImplementation(
      jest.requireActual<typeof pipeline>('@pickle/analysis-pipeline')
        .analyzeCapture,
    );
});
afterEach(() => {
  advSignOut();
  globalThis.fetch = originalFetch;
  closeSqliteTestDatabases();
  rmSync(dir, { recursive: true, force: true });
});

describe('journey: sign-in -> analysis -> sync (network lost) -> relaunch -> history', () => {
  it('keeps the rated shot queued across a relaunch when the sync request never reaches the server, then syncs it exactly once', async () => {
    advSignIn(ADV_OWNER_A);
    const { clip, sidecar } = advFixture();
    mockReadArtifact = async () => sidecar;
    const http = advServer();
    globalThis.fetch = http.fetchPort;
    let store = advOpenDb(dbPath);
    advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);

    const result = await runCaptureAnalysis(
      advCaptureRequest(store.db, clip, CAPTURE, { operationId: OPERATION }),
    );
    expect(result.kind).toBe('scored');
    if (result.kind !== 'scored') throw new Error(JSON.stringify(result));
    const shotId = result.analysisId;

    // Network loss at the sync step.
    http.knobs.networkDown = /shots:sync/;
    const offline = await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(offline).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(http.acceptedShots).toEqual([]);

    // Process death + relaunch: the local result and its queue row survive.
    store = await relaunch(store);
    expect(await listShots(store.db)).toHaveLength(1);
    expect((await listShots(store.db))[0]?.id).toBe(shotId);
    expect(await listRealAnalysisFacts(store.db)).toHaveLength(1);
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    expect(await hasShotSyncReceipt(store.db, shotId)).toBe(false);

    // Network returns after relaunch.
    http.knobs.networkDown = null;
    const online = await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(online).toEqual({ synced: 1, failed: 0, remaining: 0 });
    expect(http.acceptedShots).toEqual([shotId]);
    expect(await hasShotSyncReceipt(store.db, shotId)).toBe(true);
    expect(await getShotOutboxStatus(store.db, shotId)).toEqual({
      state: 'absent',
    });
    expect(http.charged).toBe(1);

    // A further drain (foreground / timer) must not re-send anything.
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_A))).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    expect(http.acceptedShots).toEqual([shotId]);
  });

  it('replays a shot whose acknowledgement was lost without duplicating the local shot or receipt', async () => {
    advSignIn(ADV_OWNER_A);
    const { clip, sidecar } = advFixture();
    mockReadArtifact = async () => sidecar;
    const http = advServer();
    globalThis.fetch = http.fetchPort;
    let store = advOpenDb(dbPath);
    advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);
    const result = await runCaptureAnalysis(
      advCaptureRequest(store.db, clip, CAPTURE, { operationId: OPERATION }),
    );
    if (result.kind !== 'scored') throw new Error(JSON.stringify(result));
    const shotId = result.analysisId;

    // Server applied the write, response lost on the wire.
    http.knobs.loseResponseOnce = /shots:sync/;
    const lost = await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(lost).toEqual({ synced: 0, failed: 1, remaining: 1 });
    expect(http.acceptedShots).toEqual([shotId]);
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    store = await relaunch(store);
    const replay = await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(replay).toEqual({ synced: 1, failed: 0, remaining: 0 });
    // Idempotent server upsert: same id twice, one local shot, one receipt.
    expect(http.acceptedShots).toEqual([shotId, shotId]);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(1);
    expect(advRows(store, 'sync_receipt', ADV_OWNER_A)).toHaveLength(1);
    expect(http.charged).toBe(1);
  });

  it('does not lose a locally rated shot when the server keeps rejecting it: it stays visible in history and is excluded from drains only after the bounded budget', async () => {
    advSignIn(ADV_OWNER_A);
    const { clip, sidecar } = advFixture();
    mockReadArtifact = async () => sidecar;
    const http = advServer();
    globalThis.fetch = http.fetchPort;
    let store = advOpenDb(dbPath);
    advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);
    const result = await runCaptureAnalysis(
      advCaptureRequest(store.db, clip, CAPTURE, { operationId: OPERATION }),
    );
    if (result.kind !== 'scored') throw new Error(JSON.stringify(result));
    const shotId = result.analysisId;

    // Slow server: 5xx/timeouts do not burn budget.
    http.knobs.statusOnce = {
      match: /shots:sync/,
      status: 503,
      body: { error: { code: 'server.unavailable', message: 'Retry later' } },
    };
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_A))).toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });
    // 429 back-pressure is transient too.
    http.knobs.statusOnce = {
      match: /shots:sync/,
      status: 429,
      body: { error: { code: 'rate_limited', message: 'Slow down' } },
    };
    await drainOutbox(store.db, advTransport(ADV_OWNER_A));
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    // Permanent 4xx verdicts spend the bounded budget, one per drain.
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      http.knobs.statusOnce = {
        match: /shots:sync/,
        status: 422,
        body: { error: { code: 'shot.invalid', message: 'Rejected' } },
      };
      const drained = await drainOutbox(store.db, advTransport(ADV_OWNER_A));
      expect(drained).toEqual({ synced: 0, failed: 1, remaining: 1 });
      expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
        state: attempt >= 8 ? 'exhausted' : 'rejected',
        attempts: attempt,
      });
      if (attempt === 4) store = await relaunch(store);
    }
    // Exhausted rows are excluded from future drains but never deleted.
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_A))).toEqual({
      synced: 0,
      failed: 0,
      remaining: 1,
    });
    expect(http.requests(/shots:sync/)).toHaveLength(10);
    store = await relaunch(store);
    expect(await listShots(store.db)).toHaveLength(1);
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'exhausted',
      attempts: 8,
    });
    expect(http.charged).toBe(0);
  });
});

describe('journey: process death between reservation and inference', () => {
  it('releases the orphaned reservation on relaunch, never fabricates a shot, and charges exactly one permit for the eventual rating', async () => {
    advSignIn(ADV_OWNER_A);
    const { clip, sidecar } = advFixture();
    mockReadArtifact = async () => sidecar;
    const http = advServer();
    globalThis.fetch = http.fetchPort;
    let store = advOpenDb(dbPath);
    advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);

    // The dying process is a separate module registry: its in-memory
    // "active operation" bookkeeping disappears with it, exactly like a
    // real process death, while the SQLite file keeps the reserved journal.
    const dying = await new Promise<{
      runner: typeof import('../../src/analysis/runCaptureAnalysis');
      scope: typeof import('../../src/data/accountScope');
      api: typeof import('../../src/account/apiSession');
      pipe: typeof pipeline;
    }>(resolve =>
      jest.isolateModules(() =>
        resolve({
          runner: jest.requireActual('../../src/analysis/runCaptureAnalysis'),
          scope: jest.requireActual('../../src/data/accountScope'),
          api: jest.requireActual('../../src/account/apiSession'),
          pipe: jest.requireMock('@pickle/analysis-pipeline'),
        }),
      ),
    );
    dying.scope.setActiveDataOwner(ADV_OWNER_A);
    dying.api.establishApiSession({
      canonicalAppUserId: ADV_OWNER_A,
      apiBaseUrl: ADV_API_ORIGIN,
      bearerToken: 'bearer-A',
      provider: 'apple',
    });
    // Inference never returns in that process: the app dies mid-analysis.
    const hang = deferred<never>();
    jest
      .mocked(dying.pipe.analyzeCapture)
      .mockImplementationOnce(() => hang.promise);
    const abandoned = dying.runner.runCaptureAnalysis({
      ...advCaptureRequest(store.db, clip, CAPTURE, { operationId: OPERATION }),
      ownerContext: dying.scope.captureDataOwnerContext(),
    });
    for (let index = 0; index < 200 && http.reservations.size === 0; index += 1)
      await new Promise(resolve => setTimeout(resolve, 5));
    expect(http.reservations.size).toBe(1);
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
    const journalBefore = advRows(store, 'analysis_run_journal', ADV_OWNER_A);
    expect(journalBefore).toHaveLength(1);
    expect(journalBefore[0]?.state).toBe('reserved');
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    void abandoned;

    // Relaunch: startup recovery runs before any drain.
    store = await relaunch(store);
    const { scope, port } = permitPort(ADV_OWNER_A);
    expect(advRows(store, 'analysis_run_journal', ADV_OWNER_A)).toHaveLength(1);
    expect(runJournal.activeOperationIds(scope)).not.toContain(OPERATION);
    const recovered = await recoverAnalysisJournals(store.db, scope, port, {
      excludeOperationIds: runJournal.activeOperationIds(scope),
    });
    expect(recovered.unknownStorage).toBe(false);
    expect(recovered.items.map(item => item.kind)).toEqual(['released']);
    expect(http.released).toBe(1);
    expect(http.charged).toBe(0);
    expect(advRows(store, 'local_shot', ADV_OWNER_A)).toHaveLength(0);
    expect(await listShots(store.db)).toEqual([]);

    // The user rates again after relaunch: a new operation, one charge.
    const retried = await runCaptureAnalysis(
      advCaptureRequest(store.db, clip, CAPTURE, {
        operationId: '55555555-5555-4555-8555-555555555555',
      }),
    );
    expect(retried.kind).toBe('scored');
    expect(http.reservations.size).toBe(2);
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_A))).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    expect(http.charged).toBe(1);
    expect(http.released).toBe(1);
    expect(await listShots(store.db)).toHaveLength(1);
  });
});

describe('journey: account switch mid-way (A rates, B signs in before sync, A returns)', () => {
  it('never shows or uploads A rows under B, and A resumes its own queued sync with its own bearer after returning', async () => {
    advSignIn(ADV_OWNER_A, 'bearer-A');
    const { clip, sidecar } = advFixture();
    mockReadArtifact = async () => sidecar;
    const http = advServer();
    globalThis.fetch = http.fetchPort;
    let store = advOpenDb(dbPath);
    advSeedCapture(store, ADV_OWNER_A, CAPTURE, clip);
    const rated = await runCaptureAnalysis(
      advCaptureRequest(store.db, clip, CAPTURE, { operationId: OPERATION }),
    );
    if (rated.kind !== 'scored') throw new Error(JSON.stringify(rated));
    const shotId = rated.analysisId;
    const transportA = advTransport(ADV_OWNER_A);

    // Device is offline; A signs out and B signs in; process restarts.
    advSignOut();
    store = await relaunch(store);
    advSignIn(ADV_OWNER_B, 'bearer-B');
    expect(await listShots(store.db)).toEqual([]);
    expect(await listRealAnalysisFacts(store.db)).toEqual([]);
    expect(await getShotOutboxStatus(store.db, shotId)).toEqual({
      state: 'absent',
    });
    expect(await hasShotSyncReceipt(store.db, shotId)).toBe(false);
    // B's own sync runtime drains B's (empty) queue only.
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_B))).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    // A stale A-bound transport (e.g. a timer armed before the switch) sees
    // only the active owner's queue and never uploads A's row with B's bearer.
    expect(await drainOutbox(store.db, transportA)).toEqual({
      synced: 0,
      failed: 0,
      remaining: 0,
    });
    expect(http.requests(/shots:sync/)).toHaveLength(0);
    for (const call of http.calls)
      expect(call.bearer).not.toBe('Bearer bearer-B');
    expect(advRows(store, 'outbox', ADV_OWNER_A)).toHaveLength(1);

    // B signs out, A returns (new generation) — A's queue is intact.
    advSignOut();
    store = await relaunch(store);
    advSignIn(ADV_OWNER_A, 'bearer-A-again');
    expect(await listShots(store.db)).toHaveLength(1);
    expect(await getShotOutboxStatus(store.db, shotId)).toMatchObject({
      state: 'queued',
    });
    expect(await drainOutbox(store.db, advTransport(ADV_OWNER_A))).toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    const upload = http.requests(/shots:sync/);
    expect(upload).toHaveLength(1);
    expect(upload[0]?.bearer).toBe('Bearer bearer-A-again');
    expect(http.acceptedShots).toEqual([shotId]);
    expect(await hasShotSyncReceipt(store.db, shotId)).toBe(true);
    expect(advRows(store, 'sync_receipt', ADV_OWNER_B)).toHaveLength(0);
    expect(advRows(store, 'local_shot', ADV_OWNER_B)).toHaveLength(0);
  });
});
