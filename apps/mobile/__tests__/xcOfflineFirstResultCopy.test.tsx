/**
 * XC journey-offline-first — user-visible reconciliation over REAL durable
 * state. The existing fix-12 suite pins the Result copy against a hand-built
 * fake outbox row; here the rows are whatever the production repository +
 * sync engine actually left in a real SQLite database after the journey
 * (offline flush, partial server rejection, exhaustion, replay), and the
 * `ResultDetails` surface is rendered on top of that database.
 *
 *   cd apps/mobile && npx jest __tests__/xcOfflineFirstResultCopy.test.tsx
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';

import type { LocalDb } from '../src/data/db';

const dbHolder: { current: LocalDb | null } = { current: null };
jest.mock('../src/data/db', () => ({
  getDb: () => {
    if (!dbHolder.current) throw new Error('xc: no db opened');
    return dbHolder.current;
  },
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
let mockAnalysisId = 'unset';
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
    popTo: jest.fn(),
    popToTop: jest.fn(),
    replace: jest.fn(),
  }),
  useRoute: () => ({ params: { analysisId: mockAnalysisId } }),
}));

const evidenceHolder: { analysis: ShotAnalysis | null } = { analysis: null };
jest.mock('../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: async () => ({
    analysis: evidenceHolder.analysis,
    record: null,
    clip: null,
    review: null,
    attempts: [],
  }),
}));

const mockTrainingState = {
  planStatus: 'ready',
  currentPlan: null,
  planError: null,
  mutation: 'idle',
  mutationError: null,
  drillDetails: {},
  loadCurrentPlan: jest.fn(async () => {}),
  createPlan: jest.fn(async () => {}),
  reassessCurrentPlan: jest.fn(async () => {}),
  setDrillSaved: jest.fn(async () => {}),
  completePlanItem: jest.fn(async () => {}),
  clearMutationError: jest.fn(),
};
jest.mock('../src/training/store', () => ({
  useTrainingStore: (selector: (s: typeof mockTrainingState) => unknown) =>
    selector(mockTrainingState),
}));
jest.mock('../src/consistency/store', () => {
  const state = { refresh: jest.fn(async () => {}) };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../src/components/AnalysisFeedbackPrompt', () => ({
  AnalysisFeedbackPrompt: () => null,
}));

import { setActiveDataOwner } from '../src/data/accountScope';
import { createTransport } from '../src/data/api';
import {
  finishSession,
  getShotOutboxStatus,
  saveAnalysis,
  saveSession,
} from '../src/data/repository';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../src/data/sync';
import { ResultDetailsScreen } from '../src/screens/ResultDetailsScreen';
import { FakeSyncServer } from '../harness/xcOfflineFirst/fakeSyncServer';
import {
  API_BASE_URL,
  makeAnalysis,
  makeRng,
} from '../harness/xcOfflineFirst/journeyScenario';
import {
  nodeFs,
  nodePath,
  nodeProcess,
} from '../harness/xcOfflineFirst/nodeRuntime';
import {
  openSqliteLocalDb,
  snapshotLocalState,
  type SqliteLocalDb,
} from '../harness/xcOfflineFirst/sqliteLocalDb';

declare const __dirname: string;

const ARTIFACT_DIR = nodePath.resolve(
  nodeProcess.env.XC_OFFLINE_ARTIFACT_DIR ??
    nodePath.join(
      __dirname,
      '..',
      '..',
      '..',
      'artifacts',
      'xc-offline-first',
      'jest',
    ),
);
nodeFs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const OWNER = '0000a11e-c0de-4f00-8000-0000000000c0';

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object' && 'children' in node) {
      walk((node as { children: unknown }).children);
    }
  };
  walk(renderer.toJSON());
  return out.join(' ');
}

async function renderResult(): Promise<TestRenderer.ReactTestRenderer> {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ResultDetailsScreen />);
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

interface Journey {
  db: SqliteLocalDb;
  server: FakeSyncServer;
  restore: () => void;
  transport: ReturnType<typeof createTransport>;
  analysis: ShotAnalysis;
  shotId: string;
  sessionId: string;
}

async function startJourney(
  seed: number,
  fault?: Parameters<FakeSyncServer['faults']['set']>[1],
): Promise<Journey> {
  const db = openSqliteLocalDb();
  dbHolder.current = db;
  const server = new FakeSyncServer({ userId: OWNER });
  const restore = server.install();
  setActiveDataOwner(OWNER);
  const rng = makeRng(seed);
  const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
  const sessionId = rng.uuid();
  const shotId = rng.uuid();
  const analysis = makeAnalysis(rng, {
    id: shotId,
    sessionId,
    capturedAtIso: '2026-09-04T12:00:00.000Z',
    resultKind: 'scored',
  });
  if (fault) server.faults.set(shotId, fault);
  await saveAnalysis(db, analysis, server.reservePermit(rng.uuid()));
  await saveSession(db, {
    id: sessionId,
    mode: 'practice_set',
    shotType: 'forehand_drive',
    focusCheckpoint: null,
    startedAt: '2026-09-04T12:00:00.000Z',
  });
  await finishSession(db, sessionId, { shots: 1 });
  evidenceHolder.analysis = analysis;
  mockAnalysisId = shotId;
  return { db, server, restore, transport, analysis, shotId, sessionId };
}

const copyLog: Array<{
  case: string;
  outboxStatus: unknown;
  outbox: unknown;
  receipts: unknown;
  renderedText: string;
}> = [];

async function renderAndLog(j: Journey, label: string) {
  jest.useFakeTimers();
  const renderer = await renderResult();
  const rendered = textOf(renderer).replace(/\s+/g, ' ');
  act(() => renderer.unmount());
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  const state = snapshotLocalState(j.db);
  copyLog.push({
    case: label,
    outboxStatus: await getShotOutboxStatus(j.db, j.shotId),
    outbox: state.outbox.map(r => ({
      kind: r['kind'],
      attempts: r['attempts'],
      lastError: r['last_error'],
    })),
    receipts: state.receipts,
    renderedText: rendered.slice(rendered.indexOf('Personalized training')),
  });
  return rendered;
}

describe('XC journey-offline-first — Result copy over real durable state', () => {
  let journey: Journey | null = null;

  afterEach(() => {
    journey?.restore();
    journey?.db.close();
    journey = null;
    dbHolder.current = null;
  });

  afterAll(() => {
    nodeFs.writeFileSync(
      nodePath.join(ARTIFACT_DIR, 'result-copy-log.json'),
      JSON.stringify(copyLog, null, 2),
    );
  });

  it('offline flush → pending copy; the score is still local and unsent', async () => {
    journey = await startJourney(101);
    journey.server.setModeFor(() => 'offline');
    await drainOutbox(journey.db, journey.transport);
    await drainOutbox(journey.db, journey.transport);
    const text = await renderAndLog(journey, 'offline_pending');
    expect(text).toContain('Sync this read first.');
    expect(text).toContain('still in the secure outbox');
    expect(text).not.toContain('refused');
    expect(snapshotLocalState(journey.db).localShots).toHaveLength(1);
    expect(journey.server.shots.size).toBe(0);
  });

  it('reconnect → accepted → the plan gate opens (synced)', async () => {
    journey = await startJourney(102);
    journey.server.setModeFor(() => 'offline');
    await drainOutbox(journey.db, journey.transport);
    journey.server.setModeFor(() => 'online');
    await drainOutbox(journey.db, journey.transport);
    const text = await renderAndLog(journey, 'accepted_synced');
    expect(text).toContain('Turn this read into a plan.');
    expect(text).not.toContain('secure outbox');
    expect(snapshotLocalState(journey.db).receipts).toHaveLength(1);
  });

  it('reconnect → paywall rejection → refusal copy carries the server response and the retry budget', async () => {
    journey = await startJourney(103, {
      kind: 'permanent',
      code: 'access.paywall_required',
    });
    await drainOutbox(journey.db, journey.transport);
    const text = await renderAndLog(journey, 'rejected_1_of_8');
    expect(text).toContain(
      `The server refused this read 1 of ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(text).toContain(
      'access.paywall_required: Both lifetime free ratings have been used.',
    );
    expect(text).toContain('will be retried');
    expect(text).not.toContain('still in the secure outbox');
    // Local data intact; nothing on the server.
    expect(snapshotLocalState(journey.db).localShots).toHaveLength(1);
    expect(journey.server.shots.size).toBe(0);
  });

  it('a permanent refusal followed by an offline pass: copy still says "refused" but quotes the network error as the server response', async () => {
    journey = await startJourney(104, {
      kind: 'permanent',
      code: 'access.paywall_required',
    });
    await drainOutbox(journey.db, journey.transport);
    journey.server.setModeFor(() => 'offline');
    await drainOutbox(journey.db, journey.transport);
    const status = await getShotOutboxStatus(journey.db, journey.shotId);
    const text = await renderAndLog(journey, 'rejected_then_offline');
    // Deterministic characterization of what the user is shown (finding).
    expect(status).toEqual({
      state: 'rejected',
      attempts: 1,
      lastError: 'TypeError: Network request failed',
    });
    expect(text).toContain(
      `The server refused this read 1 of ${OUTBOX_MAX_ATTEMPTS} times (last response: TypeError: Network request failed)`,
    );
    expect(text).not.toContain('access.paywall_required');
  });

  it('exhausted after 8 refusals → "will not be sent again" + Capture a new read; local row retained', async () => {
    journey = await startJourney(105, { kind: 'permit_expired' });
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i++) {
      await drainOutbox(journey.db, journey.transport);
    }
    const text = await renderAndLog(journey, 'exhausted');
    expect(text).toContain('The server did not accept this read.');
    expect(text).toContain(
      `Sync was refused ${OUTBOX_MAX_ATTEMPTS} times and this read will not be sent again`,
    );
    expect(text).toContain(
      'It stays on this device; capture a new read to build training.',
    );
    expect(text).not.toContain('secure outbox');
    // Characterization (finding): the first verdict was access.permit_expired
    // (the permit was then released), every later retry answered
    // access.permit_not_reserved, and only that last code reaches the user.
    const codes = journey.server
      .requestsFor(journey.shotId)
      .map(r => r.rejected?.map(x => x.code).join(',') ?? '');
    expect(codes[0]).toBe('access.permit_expired');
    expect(new Set(codes.slice(1))).toEqual(
      new Set(['access.permit_not_reserved']),
    );
    expect(text).toContain(
      '(last response: access.permit_not_reserved: Analysis permit is no longer reserved.)',
    );
    expect(text).not.toContain('access.permit_expired');
    expect(journey.server.requestsFor(journey.shotId)).toHaveLength(
      OUTBOX_MAX_ATTEMPTS,
    );
    const state = snapshotLocalState(journey.db);
    expect(state.localShots).toHaveLength(1);
    expect(state.receipts).toHaveLength(0);
    expect(state.outbox.filter(r => r['kind'] === 'shot.sync')).toHaveLength(1);
  });

  it('commit-then-drop replay → one server row, one receipt, synced copy', async () => {
    journey = await startJourney(106);
    journey.server.setModeFor(() => 'commit_then_drop');
    await drainOutbox(journey.db, journey.transport);
    expect(journey.server.shots.size).toBe(1);
    expect(snapshotLocalState(journey.db).receipts).toHaveLength(0);
    journey.server.setModeFor(() => 'online');
    await drainOutbox(journey.db, journey.transport);
    const text = await renderAndLog(journey, 'commit_then_drop_replay');
    expect(text).toContain('Turn this read into a plan.');
    expect(journey.server.shots.size).toBe(1);
    expect(journey.server.requestsFor(journey.shotId)).toHaveLength(2);
    expect(snapshotLocalState(journey.db).receipts).toHaveLength(1);
  });

  it('starved behind 49 stuck rows: copy promises acceptance-gated unlock while the row is never accepted', async () => {
    // Set A: 49 shots bound to a session the server owns under another
    // account (create → 409 permanent; shots → session_not_found transient).
    const db = openSqliteLocalDb();
    dbHolder.current = db;
    const server = new FakeSyncServer({ userId: OWNER });
    const restore = server.install();
    setActiveDataOwner(OWNER);
    const rng = makeRng(107);
    const transport = createTransport({ baseUrl: API_BASE_URL, token: 't' });
    const setA = rng.uuid();
    server.seedForeignSession(setA);
    const persist = async (sessionId: string) => {
      const id = rng.uuid();
      const analysis = makeAnalysis(rng, {
        id,
        sessionId,
        capturedAtIso: '2026-09-04T12:00:00.000Z',
        resultKind: 'scored',
      });
      await saveAnalysis(db, analysis, server.reservePermit(rng.uuid()));
      return { id, analysis };
    };
    await persist(setA);
    await saveSession(db, {
      id: setA,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-09-04T11:00:00.000Z',
    });
    for (let i = 1; i < 49; i++) await persist(setA);
    const setB = rng.uuid();
    const b = await persist(setB);
    await saveSession(db, {
      id: setB,
      mode: 'practice_set',
      shotType: 'forehand_drive',
      focusCheckpoint: null,
      startedAt: '2026-09-04T12:00:00.000Z',
    });
    for (let i = 0; i < 20; i++) await drainOutbox(db, transport);
    evidenceHolder.analysis = b.analysis;
    mockAnalysisId = b.id;
    journey = {
      db,
      server,
      restore,
      transport,
      analysis: b.analysis,
      shotId: b.id,
      sessionId: setB,
    };
    const text = await renderAndLog(journey, 'starved_pending_forever');
    expect(server.shots.has(b.id)).toBe(false);
    expect(
      server.requests.filter(
        r => r.path === '/v1/sessions' && r.entityIds.includes(setB),
      ),
    ).toHaveLength(0);
    expect(await getShotOutboxStatus(db, b.id)).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'shot.session_not_found: Session not found or not yours.',
    });
    expect(text).toContain(
      'This real score is still in the secure outbox. Personalized training unlocks after the server accepts the shot.',
    );
  });
});
