/**
 * Adversarial pass 3 / scenarios 2, 3 and 5 — per-item rejection handling in
 * `drainOutbox` against a STATEFUL outbox/local_shot/sync_receipt store.
 *
 *  S2  `access.paywall_required` rejection → permanent, burns all 8 attempts,
 *      then the row is excluded from every later drain, and the Result
 *      breakdown copy for rejected/exhausted never claims "pending".
 *  S3  `shot.id_conflict` rejection → permanent while the `local_shot` row
 *      remains in history (server/local divergence is durable, not hidden).
 *  S5  `{acceptedIds: [], rejected: []}` → every row records
 *      `shot.sync_unacknowledged` with attempts+1 even though the server
 *      wrote nothing.
 *
 * The store mirrors the real SQL shapes used by sync.ts / repository.ts
 * (including `json_extract(payload, '$.id')`) and models BEGIN/COMMIT/
 * ROLLBACK with snapshots so a receipt+delete transaction is atomic.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  OUTBOX_MAX_ATTEMPTS,
  drainOutbox,
  isTransientSyncRejection,
  type SyncTransport,
} from '../../src/data/sync';
import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listShots,
  saveAnalysis,
} from '../../src/data/repository';

// ---------------------------------------------------------------------------
// Stateful fake of the SQLite tables the sync path touches.
// ---------------------------------------------------------------------------

interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}
interface LocalShotRow {
  owner_key: string;
  id: string;
  session_id: string | null;
  shot_type: string;
  captured_at: string;
  overall_score: number | null;
  confidence: number;
  result_kind: string;
  source: string;
  favorite: number;
  payload: string;
}
interface ReceiptRow {
  owner_key: string;
  kind: string;
  entity_id: string;
}

interface Store {
  outbox: OutboxRow[];
  localShot: LocalShotRow[];
  receipts: ReceiptRow[];
  nextId: number;
}

function jsonId(payload: string): string | null {
  try {
    const parsed = JSON.parse(payload) as { id?: unknown };
    return typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

function statefulDb(): { db: LocalDb; store: Store; log: string[] } {
  const store: Store = { outbox: [], localShot: [], receipts: [], nextId: 1 };
  const log: string[] = [];
  let snapshot: Store | null = null;
  const clone = (s: Store): Store => JSON.parse(JSON.stringify(s)) as Store;
  const norm = (sql: string) => sql.replace(/\s+/g, ' ').trim();

  const db: LocalDb = {
    async execute(rawSql, params = []) {
      const sql = norm(rawSql);
      log.push(sql);
      if (sql === 'BEGIN IMMEDIATE') {
        if (snapshot)
          throw new Error('cannot start a transaction within a transaction');
        snapshot = clone(store);
        return { rows: [] };
      }
      if (sql === 'COMMIT') {
        if (!snapshot)
          throw new Error('cannot commit - no transaction is active');
        snapshot = null;
        return { rows: [] };
      }
      if (sql === 'ROLLBACK') {
        if (!snapshot)
          throw new Error('cannot rollback - no transaction is active');
        Object.assign(store, snapshot);
        snapshot = null;
        return { rows: [] };
      }
      if (sql.startsWith('SELECT id, kind, payload, attempts FROM outbox')) {
        const [owner, cap] = params as [string, number];
        return {
          rows: store.outbox
            .filter(r => r.owner_key === owner && r.attempts < cap)
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({
              id: r.id,
              kind: r.kind,
              payload: r.payload,
              attempts: r.attempts,
            })),
        };
      }
      if (
        sql.startsWith(
          'UPDATE outbox SET attempts = attempts + 1, last_error = ?',
        )
      ) {
        const [err, owner, id] = params as [string, string, number];
        for (const r of store.outbox) {
          if (r.owner_key === owner && r.id === id) {
            r.attempts += 1;
            r.last_error = err;
          }
        }
        return { rows: [] };
      }
      if (sql.startsWith('UPDATE outbox SET last_error = ?')) {
        const [err, owner, id] = params as [string, string, number];
        for (const r of store.outbox) {
          if (r.owner_key === owner && r.id === id) r.last_error = err;
        }
        return { rows: [] };
      }
      if (sql.startsWith('DELETE FROM outbox WHERE owner_key = ? AND id = ?')) {
        const [owner, id] = params as [string, number];
        store.outbox = store.outbox.filter(
          r => !(r.owner_key === owner && r.id === id),
        );
        return { rows: [] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO sync_receipt')) {
        const [owner, entityId] = params as [string, string];
        store.receipts = store.receipts.filter(
          r =>
            !(
              r.owner_key === owner &&
              r.kind === 'shot.sync' &&
              r.entity_id === entityId
            ),
        );
        store.receipts.push({
          owner_key: owner,
          kind: 'shot.sync',
          entity_id: entityId,
        });
        return { rows: [] };
      }
      if (
        sql.startsWith('SELECT count(*) AS n FROM outbox WHERE owner_key = ?')
      ) {
        const [owner] = params as [string];
        return {
          rows: [{ n: store.outbox.filter(r => r.owner_key === owner).length }],
        };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO local_shot')) {
        const [
          owner_key,
          id,
          session_id,
          shot_type,
          captured_at,
          overall_score,
          confidence,
          result_kind,
          source,
          payload,
        ] = params as [
          string,
          string,
          string | null,
          string,
          string,
          number | null,
          number,
          string,
          string,
          string,
        ];
        store.localShot = store.localShot.filter(
          r => !(r.owner_key === owner_key && r.id === id),
        );
        store.localShot.push({
          owner_key,
          id,
          session_id,
          shot_type,
          captured_at,
          overall_score,
          confidence,
          result_kind,
          source,
          favorite: 0,
          payload,
        });
        return { rows: [] };
      }
      if (
        sql.startsWith(
          "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'shot.sync', ?)",
        )
      ) {
        const [owner, payload] = params as [string, string];
        store.outbox.push({
          id: store.nextId++,
          owner_key: owner,
          kind: 'shot.sync',
          payload,
          attempts: 0,
          last_error: null,
        });
        return { rows: [] };
      }
      if (
        sql.startsWith(
          'SELECT id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite FROM local_shot',
        )
      ) {
        const [owner, limit] = params as [string, number];
        return {
          rows: store.localShot
            .filter(r => r.owner_key === owner && r.source === 'real')
            .sort((a, b) => (a.captured_at < b.captured_at ? 1 : -1))
            .slice(0, limit)
            .map(r => ({ ...r })),
        };
      }
      if (sql.startsWith('SELECT attempts, last_error FROM outbox')) {
        const [owner, shotId] = params as [string, string];
        const rows = store.outbox
          .filter(
            r =>
              r.owner_key === owner &&
              r.kind === 'shot.sync' &&
              jsonId(r.payload) === shotId,
          )
          .sort((a, b) => b.id - a.id)
          .slice(0, 1)
          .map(r => ({ attempts: r.attempts, last_error: r.last_error }));
        return { rows };
      }
      if (sql.startsWith('SELECT 1 FROM sync_receipt')) {
        const [owner, shotId] = params as [string, string];
        const hit = store.receipts.some(
          r =>
            r.owner_key === owner &&
            r.kind === 'shot.sync' &&
            r.entity_id === shotId,
        );
        return { rows: hit ? [{ '1': 1 }] : [] };
      }
      throw new Error(`statefulDb: unhandled sql ${sql}`);
    },
    close() {},
  };
  return { db, store, log };
}

// ---------------------------------------------------------------------------
// ResultDetailsScreen harness (mirrors __tests__/wf/fix-12-result-outbox-status).
// The screen reads its outbox state through getDb(); the mock hands it the
// SAME stateful store the drain mutated so the copy is driven by real state.
// ---------------------------------------------------------------------------

let mockCurrentDb: LocalDb | null = null;
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockCurrentDb) throw new Error('mockCurrentDb not installed');
    return mockCurrentDb;
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});
const mockNavigate = jest.fn();
let mockRouteAnalysisId = 'shot-1';
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
    popTo: jest.fn(),
    popToTop: jest.fn(),
    replace: jest.fn(),
  }),
  useRoute: () => ({ params: { analysisId: mockRouteAnalysisId } }),
}));
const mockLoadEvidence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../src/components/strokeResultData', () => ({
  loadStrokeResultEvidence: (...args: unknown[]) => mockLoadEvidence(...args),
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
jest.mock('../../src/training/store', () => ({
  useTrainingStore: (selector: (s: typeof mockTrainingState) => unknown) =>
    selector(mockTrainingState),
}));
jest.mock('../../src/consistency/store', () => {
  const state = { refresh: jest.fn(async () => {}) };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../../src/components/AnalysisFeedbackPrompt', () => ({
  AnalysisFeedbackPrompt: () => null,
}));

import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';

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

async function renderResultDetails(analysis: ShotAnalysis) {
  mockRouteAnalysisId = analysis.id;
  mockLoadEvidence.mockResolvedValue({
    analysis,
    record: null,
    clip: null,
    review: null,
    attempts: [],
  });
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const owner = canonicalDataOwner(OWNER_ID);

function analysisFixture(
  id: string,
  capturedAtIso = '2026-08-30T10:00:00.000Z',
): ShotAnalysis {
  return {
    id,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso,
    timestamps: { startMs: 2000, contactMs: 2400, endMs: 2700 },
    phases: [],
    measurements: [],
    checkpoints: [],
    overallScore: 7.4,
    analysisConfidence: 0.82,
    resultKind: 'scored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  };
}

type SyncResponse = Awaited<ReturnType<SyncTransport['syncShots']>>;

function rejectingTransport(respond: (shots: unknown[]) => SyncResponse): {
  transport: SyncTransport;
  calls: unknown[][];
} {
  const calls: unknown[][] = [];
  const transport: SyncTransport = {
    async syncShots(shots) {
      calls.push(shots as unknown[]);
      return respond(shots as unknown[]);
    },
    async createSession() {
      throw new Error('unexpected createSession');
    },
    async finalizeSession() {
      throw new Error('unexpected finalizeSession');
    },
  };
  return { transport, calls };
}

beforeEach(() => {
  setActiveDataOwner(owner);
  mockNavigate.mockClear();
  mockLoadEvidence.mockReset();
});
afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockCurrentDb = null;
});

// ---------------------------------------------------------------------------
// S2 — access.paywall_required
// ---------------------------------------------------------------------------

describe('attack S2 — access.paywall_required per-item rejection', () => {
  it('is not in the transient set', () => {
    expect(isTransientSyncRejection('access.paywall_required')).toBe(false);
  });

  it('burns one attempt per drain, exactly 8 total, then the row is never offered to the transport again', async () => {
    const { db, store } = statefulDb();
    mockCurrentDb = db;
    const analysis = analysisFixture('shot-paywall');
    await saveAnalysis(db, analysis, 'permit-paywall');
    expect(store.outbox).toHaveLength(1);

    const { transport, calls } = rejectingTransport(shots => ({
      acceptedIds: [],
      rejected: (shots as Array<{ id: string }>).map(s => ({
        id: s.id,
        code: 'access.paywall_required',
        message:
          'Your free ratings are used up. Upgrade to Pro to keep rating.',
      })),
    }));

    for (let drain = 1; drain <= OUTBOX_MAX_ATTEMPTS; drain += 1) {
      const result = await drainOutbox(db, transport);
      expect(result).toEqual({ synced: 0, failed: 1, remaining: 1 });
      expect(store.outbox[0]!.attempts).toBe(drain);
      expect(store.outbox[0]!.last_error).toBe(
        'access.paywall_required: Your free ratings are used up. Upgrade to Pro to keep rating.',
      );
      const status = await getShotOutboxStatus(db, analysis.id);
      if (drain < OUTBOX_MAX_ATTEMPTS) {
        expect(status).toEqual({
          state: 'rejected',
          attempts: drain,
          lastError: expect.stringContaining('access.paywall_required'),
        });
      } else {
        expect(status.state).toBe('exhausted');
      }
    }
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);

    // Drains 9..12: the row is excluded by `attempts < OUTBOX_MAX_ATTEMPTS`;
    // no transport call, no further attempt burn, row still durable.
    for (let extra = 0; extra < 4; extra += 1) {
      const result = await drainOutbox(db, transport);
      expect(result).toEqual({ synced: 0, failed: 0, remaining: 1 });
    }
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(store.outbox[0]!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // No receipt was ever forged for a refused shot.
    await expect(hasShotSyncReceipt(db, analysis.id)).resolves.toBe(false);
    // The shot itself stays in local history.
    await expect(listShots(db)).resolves.toEqual([
      expect.objectContaining({ id: analysis.id, source: 'real' }),
    ]);
  });

  it('Result breakdown copy for a REJECTED paywall row never says pending', async () => {
    const { db } = statefulDb();
    mockCurrentDb = db;
    const analysis = analysisFixture('shot-paywall-rejected');
    await saveAnalysis(db, analysis, 'permit-1');
    const { transport } = rejectingTransport(shots => ({
      acceptedIds: [],
      rejected: (shots as Array<{ id: string }>).map(s => ({
        id: s.id,
        code: 'access.paywall_required',
        message: 'Your free ratings are used up.',
      })),
    }));
    await drainOutbox(db, transport);
    await drainOutbox(db, transport);
    await drainOutbox(db, transport);

    const renderer = await renderResultDetails(analysis);
    const text = textOf(renderer);
    expect(text).toContain(
      `The server refused this read 3 of ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(text).toContain('access.paywall_required');
    expect(text).toContain('will be retried');
    expect(text).not.toMatch(/pending/i);
    expect(text).not.toContain('still in the secure outbox');
    act(() => renderer.unmount());
  });

  it('Result breakdown copy for an EXHAUSTED paywall row never says pending and does not offer plan creation', async () => {
    const { db } = statefulDb();
    mockCurrentDb = db;
    const analysis = analysisFixture('shot-paywall-exhausted');
    await saveAnalysis(db, analysis, 'permit-1');
    const { transport } = rejectingTransport(shots => ({
      acceptedIds: [],
      rejected: (shots as Array<{ id: string }>).map(s => ({
        id: s.id,
        code: 'access.paywall_required',
        message: 'Your free ratings are used up.',
      })),
    }));
    for (let i = 0; i < OUTBOX_MAX_ATTEMPTS + 2; i += 1) {
      await drainOutbox(db, transport);
    }

    const renderer = await renderResultDetails(analysis);
    const text = textOf(renderer);
    expect(text).toContain('The server did not accept this read.');
    expect(text).toContain(`Sync was refused ${OUTBOX_MAX_ATTEMPTS} times`);
    expect(text).toContain('will not be sent again');
    expect(text).toContain('access.paywall_required');
    expect(text).not.toMatch(/pending/i);
    expect(text).not.toContain('still in the secure outbox');
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === 'Build reviewed plan',
      ),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});

// ---------------------------------------------------------------------------
// S3 — shot.id_conflict (server/local divergence)
// ---------------------------------------------------------------------------

describe('attack S3 — shot.id_conflict rejection', () => {
  it('is permanent and the local_shot row remains in history while the outbox row keeps the reason', async () => {
    const { db, store } = statefulDb();
    mockCurrentDb = db;
    const a = analysisFixture('shot-conflict', '2026-08-30T10:00:00.000Z');
    const b = analysisFixture('shot-fine', '2026-08-30T11:00:00.000Z');
    await saveAnalysis(db, a, 'permit-a');
    await saveAnalysis(db, b, 'permit-b');
    const { transport } = rejectingTransport(() => ({
      acceptedIds: ['shot-fine'],
      rejected: [
        {
          id: 'shot-conflict',
          code: 'shot.id_conflict',
          message: 'Shot id is already bound to a different user.',
        },
      ],
    }));

    expect(isTransientSyncRejection('shot.id_conflict')).toBe(false);
    const first = await drainOutbox(db, transport);
    expect(first).toEqual({ synced: 1, failed: 1, remaining: 1 });

    // Accepted sibling: receipt written, outbox row gone.
    await expect(hasShotSyncReceipt(db, 'shot-fine')).resolves.toBe(true);
    await expect(getShotOutboxStatus(db, 'shot-fine')).resolves.toEqual({
      state: 'absent',
    });

    // Conflicting shot: permanent (attempts+1), no receipt, still in history.
    expect(store.outbox).toEqual([
      expect.objectContaining({
        kind: 'shot.sync',
        attempts: 1,
        last_error:
          'shot.id_conflict: Shot id is already bound to a different user.',
      }),
    ]);
    await expect(hasShotSyncReceipt(db, 'shot-conflict')).resolves.toBe(false);
    await expect(getShotOutboxStatus(db, 'shot-conflict')).resolves.toEqual({
      state: 'rejected',
      attempts: 1,
      lastError:
        'shot.id_conflict: Shot id is already bound to a different user.',
    });
    const history = await listShots(db);
    expect(history.map(r => r.id)).toEqual(['shot-fine', 'shot-conflict']);
    expect(store.localShot.find(r => r.id === 'shot-conflict')?.payload).toBe(
      JSON.stringify(a),
    );

    // Exhaust it; history still holds the divergent shot afterwards.
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i += 1)
      await drainOutbox(db, transport);
    await expect(getShotOutboxStatus(db, 'shot-conflict')).resolves.toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError:
        'shot.id_conflict: Shot id is already bound to a different user.',
    });
    expect((await listShots(db)).map(r => r.id)).toEqual([
      'shot-fine',
      'shot-conflict',
    ]);
  });

  it('Result breakdown for the conflicting shot says refused/retry, never pending, and the accepted sibling is unaffected', async () => {
    const { db } = statefulDb();
    mockCurrentDb = db;
    const a = analysisFixture('shot-conflict-ui');
    await saveAnalysis(db, a, 'permit-a');
    const { transport } = rejectingTransport(() => ({
      acceptedIds: [],
      rejected: [
        {
          id: 'shot-conflict-ui',
          code: 'shot.id_conflict',
          message: 'Shot id is already bound to a different user.',
        },
      ],
    }));
    await drainOutbox(db, transport);
    const renderer = await renderResultDetails(a);
    const text = textOf(renderer);
    expect(text).toContain(
      `The server refused this read 1 of ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(text).toContain('shot.id_conflict');
    expect(text).not.toMatch(/pending/i);
    act(() => renderer.unmount());
  });
});

// ---------------------------------------------------------------------------
// S5 — server acknowledges nothing
// ---------------------------------------------------------------------------

describe('attack S5 — {acceptedIds: [], rejected: []}', () => {
  it('every submitted row records shot.sync_unacknowledged with attempts+1 (permanent) and no receipt', async () => {
    const { db, store } = statefulDb();
    mockCurrentDb = db;
    const ids = ['u-1', 'u-2', 'u-3'];
    for (const [i, id] of ids.entries()) {
      await saveAnalysis(
        db,
        analysisFixture(id, `2026-08-30T1${i}:00:00.000Z`),
        `permit-${id}`,
      );
    }
    const { transport, calls } = rejectingTransport(() => ({
      acceptedIds: [],
      rejected: [],
    }));

    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 0, failed: 3, remaining: 3 });
    expect(calls).toHaveLength(1);
    expect((calls[0] as Array<{ id: string }>).map(s => s.id)).toEqual(ids);
    for (const row of store.outbox) {
      expect(row.attempts).toBe(1);
      expect(row.last_error).toBe('shot.sync_unacknowledged');
    }
    for (const id of ids) {
      await expect(hasShotSyncReceipt(db, id)).resolves.toBe(false);
      await expect(getShotOutboxStatus(db, id)).resolves.toEqual({
        state: 'rejected',
        attempts: 1,
        lastError: 'shot.sync_unacknowledged',
      });
    }

    // Repeated silence exhausts the budget: after 8 drains the rows are
    // parked and the transport is never asked again.
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i += 1)
      await drainOutbox(db, transport);
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    await drainOutbox(db, transport);
    expect(calls).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    for (const row of store.outbox)
      expect(row.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // Local history is intact for every unacknowledged shot.
    expect((await listShots(db)).map(r => r.id).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it('partial acknowledgement: unlisted ids are unacknowledged (permanent), listed transient ids keep their budget', async () => {
    const { db, store } = statefulDb();
    mockCurrentDb = db;
    await saveAnalysis(
      db,
      analysisFixture('p-accepted', '2026-08-30T10:00:00.000Z'),
      'permit-1',
    );
    await saveAnalysis(
      db,
      analysisFixture('p-silent', '2026-08-30T11:00:00.000Z'),
      'permit-2',
    );
    await saveAnalysis(
      db,
      analysisFixture('p-transient', '2026-08-30T12:00:00.000Z'),
      'permit-3',
    );
    const { transport } = rejectingTransport(() => ({
      acceptedIds: ['p-accepted'],
      rejected: [
        { id: 'p-transient', code: 'shot.write_failed', message: 'try later' },
        // A rejection for an id the client never sent must be ignored.
        { id: 'p-phantom', code: 'shot.id_conflict', message: 'phantom' },
      ],
    }));
    const result = await drainOutbox(db, transport);
    expect(result).toEqual({ synced: 1, failed: 2, remaining: 2 });
    const byId = new Map(store.outbox.map(r => [jsonId(r.payload), r]));
    expect(byId.has('p-accepted')).toBe(false);
    expect(byId.get('p-silent')).toEqual(
      expect.objectContaining({
        attempts: 1,
        last_error: 'shot.sync_unacknowledged',
      }),
    );
    expect(byId.get('p-transient')).toEqual(
      expect.objectContaining({
        attempts: 0,
        last_error: 'shot.write_failed: try later',
      }),
    );
    await expect(hasShotSyncReceipt(db, 'p-accepted')).resolves.toBe(true);
    await expect(hasShotSyncReceipt(db, 'p-phantom')).resolves.toBe(false);
  });

  it('a receipt write that fails mid-transaction rolls back and leaves the outbox row for the next drain', async () => {
    const { db, store, log } = statefulDb();
    mockCurrentDb = db;
    await saveAnalysis(db, analysisFixture('rb-1'), 'permit-1');
    const { transport } = rejectingTransport(() => ({
      acceptedIds: ['rb-1'],
      rejected: [],
    }));
    const realExecute = db.execute.bind(db);
    let failOnce = true;
    const flaky: LocalDb = {
      async execute(sql, params) {
        if (failOnce && sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
          failOnce = false;
          throw new Error('SQLITE_FULL: database or disk is full');
        }
        return realExecute(sql, params);
      },
      close() {},
    };
    // OBSERVED (P3, sync.ts:224-265): the receipt/delete failure is rethrown
    // from the accepted branch but lands in the surrounding
    // `catch (error)` that was written for TRANSPORT failures, so drainOutbox
    // resolves instead of surfacing the local persistence fault, and the
    // row's `last_error` is stamped with the SQLite message as if the server
    // had answered with it. Durability itself holds (asserted below).
    await expect(drainOutbox(flaky, transport)).resolves.toEqual({
      synced: 0,
      failed: 1,
      remaining: 1,
    });
    expect(log.filter(s => s === 'ROLLBACK')).toHaveLength(1);
    // Nothing was committed: no receipt, row intact, no attempt burned.
    expect(store.receipts).toEqual([]);
    expect(store.outbox).toEqual([
      expect.objectContaining({
        attempts: 0,
        last_error: 'Error: SQLITE_FULL: database or disk is full',
      }),
    ]);
    await expect(getShotOutboxStatus(db, 'rb-1')).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'Error: SQLITE_FULL: database or disk is full',
    });
    // Next drain succeeds cleanly (server replay is idempotent).
    await expect(drainOutbox(flaky, transport)).resolves.toEqual({
      synced: 1,
      failed: 0,
      remaining: 0,
    });
    await expect(hasShotSyncReceipt(db, 'rb-1')).resolves.toBe(true);
  });

  it('a local receipt failure on the SECOND accepted row double-counts the first row as both synced and failed (observed)', async () => {
    const { db, store } = statefulDb();
    mockCurrentDb = db;
    await saveAnalysis(
      db,
      analysisFixture('dc-1', '2026-08-30T10:00:00.000Z'),
      'permit-1',
    );
    await saveAnalysis(
      db,
      analysisFixture('dc-2', '2026-08-30T11:00:00.000Z'),
      'permit-2',
    );
    const { transport } = rejectingTransport(() => ({
      acceptedIds: ['dc-1', 'dc-2'],
      rejected: [],
    }));
    const realExecute = db.execute.bind(db);
    let receipts = 0;
    const flaky: LocalDb = {
      async execute(sql, params) {
        if (sql.includes('INSERT OR REPLACE INTO sync_receipt')) {
          receipts += 1;
          if (receipts === 2) throw new Error('SQLITE_IOERR');
        }
        return realExecute(sql, params);
      },
      close() {},
    };
    const result = await drainOutbox(flaky, transport);
    // dc-1 committed (synced=1) yet the batch-level catch also marks BOTH
    // entries failed → failed=2 for a batch of two.
    expect(result).toEqual({ synced: 1, failed: 2, remaining: 1 });
    await expect(hasShotSyncReceipt(db, 'dc-1')).resolves.toBe(true);
    await expect(hasShotSyncReceipt(db, 'dc-2')).resolves.toBe(false);
    expect(store.outbox.map(r => jsonId(r.payload))).toEqual(['dc-2']);
    expect(store.outbox[0]!.last_error).toBe('Error: SQLITE_IOERR');
    expect(store.outbox[0]!.attempts).toBe(0);
  });
});
