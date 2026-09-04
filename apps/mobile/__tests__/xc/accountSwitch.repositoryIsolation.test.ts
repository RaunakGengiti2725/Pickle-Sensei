/**
 * xc-journey-account-switch — repository-level isolation on ONE real SQLite
 * database shared by two mocked canonical identities (A, B), the device
 * guest bucket and the signed-out state.
 *
 * Production `getDb()` runs its real migrations against a real engine; every
 * repository reader/writer is exercised exactly as the app calls it, and the
 * physical tables are inspected owner-agnostically afterwards so a leak that
 * hides behind a correct-looking reader cannot pass.
 *
 * Sequential journey (jest runs the `it`s in order, sharing the database):
 *   A seeds everything → B sees nothing → signed-out sees nothing & cannot
 *   write → B seeds SAME ids → A unchanged → cross-owner mutations are no-ops
 *   → outbox drains per owner → purge(A) leaves B whole → matrices to disk.
 */
import type { CapturedClip } from '../../src/camera/capture';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';
import {
  OWNER_SCOPED_KV_NAMESPACES,
  finishSession,
  getAnalysis,
  getCaptureTargetSeed,
  getKv,
  getPendingCapture,
  getShotOutboxStatus,
  hasShotSyncReceipt,
  listActivityShots,
  listAnalysisRecords,
  listCaptureHistory,
  listLiveSessionHistory,
  listPendingCaptures,
  listRealAnalysisFacts,
  listScoredCheckpointFacts,
  listShots,
  markCaptureAnalyzed,
  purgeOwnerData,
  recentScores,
  saveAnalysis,
  saveAnalysisRecord,
  saveLocalOnlyAnalysis,
  savePendingCapture,
  saveSession,
  setCaptureTargetSeed,
  setDeclaredStroke,
  setKv,
  updateCaptureClipPayload,
} from '../../src/data/repository';
import { drainOutbox, type SyncTransport } from '../../src/data/sync';
import { PENDING_ONBOARDING_PROFILE_KV_KEY } from '../../src/state/appStore';
import {
  IDENTITY_A,
  IDENTITY_B,
  OWNER_A,
  OWNER_B,
  PERMIT_A,
  PERMIT_B,
  assertNoSecretMaterial,
  buildAbstainedAnalysis,
  buildAnalysis,
  buildAnalysisRecord,
  buildClip,
  buildProfile,
  heapNumbers,
  ownerSnapshot,
  ownershipMatrix,
  writeEvidence,
} from '../../testing/xc-account-switch/fixtures';
import {
  openRealSqlite,
  type RealSqliteHandle,
} from '../../testing/xc-account-switch/realSqlite';

let mockHandle: RealSqliteHandle | null = null;
jest.mock('@op-engineering/op-sqlite', () => ({
  open: () => {
    if (!mockHandle) throw new Error('real sqlite handle not opened');
    return mockHandle;
  },
}));

// ─── Shared ids: A and B use the SAME ids for every entity on purpose ───────
const SHOT_SCORED = 'shot-scored-0001';
const SHOT_ABSTAINED = 'shot-abstained-0002';
const SHOT_SYNCED = 'shot-synced-0003';
const SESSION_LIVE = 'session-live-0001';
const SESSION_PRACTICE = 'session-practice-0002';
const CAPTURE_PENDING = 'capture-pending-0001';
const CAPTURE_ANALYZED = 'capture-analyzed-0002';
const RECORD_1 = 'record-0001';

type Reader = {
  name: string;
  run: () => Promise<{ count: number; ids: string[]; detail?: unknown }>;
};

const evidence: {
  engine: string | null;
  readerMatrix: Record<string, Record<string, unknown>>;
  steps: Array<{ step: string; ok: boolean; detail?: unknown }>;
  matrices: Record<string, unknown>;
  heap: Record<string, unknown>;
} = {
  engine: null,
  readerMatrix: {},
  steps: [],
  matrices: {},
  heap: {},
};

function handle(): RealSqliteHandle {
  if (!mockHandle) throw new Error('handle missing');
  return mockHandle;
}

function step(name: string, detail?: unknown): void {
  evidence.steps.push({ step: name, ok: true, detail });
}

/** Every owner-bound reader the app has, run as the CURRENT active owner. */
function readers(): Reader[] {
  const db = getDb();
  const owner = getActiveDataOwner();
  return [
    {
      name: 'listShots',
      run: async () => {
        const rows = await listShots(db);
        return { count: rows.length, ids: rows.map(r => r.id) };
      },
    },
    {
      name: 'listActivityShots',
      run: async () => {
        const rows = await listActivityShots(db);
        return { count: rows.length, ids: rows.map(r => r.id) };
      },
    },
    {
      name: `getAnalysis(${SHOT_SCORED})`,
      run: async () => {
        const row = await getAnalysis(db, SHOT_SCORED);
        return {
          count: row ? 1 : 0,
          ids: row ? [row.id] : [],
          detail: row?.overallScore ?? null,
        };
      },
    },
    {
      name: 'recentScores(null)',
      run: async () => {
        const scores = await recentScores(db, null);
        return { count: scores.length, ids: scores.map(String) };
      },
    },
    {
      name: 'listRealAnalysisFacts',
      run: async () => {
        const facts = await listRealAnalysisFacts(db);
        return { count: facts.length, ids: facts.map(f => f.id) };
      },
    },
    {
      name: 'listScoredCheckpointFacts',
      run: async () => {
        const facts = await listScoredCheckpointFacts(db);
        return { count: facts.length, ids: facts.map(f => f.id) };
      },
    },
    {
      name: 'listPendingCaptures',
      run: async () => {
        const rows = await listPendingCaptures(db);
        return { count: rows.length, ids: rows.map(r => r.id) };
      },
    },
    {
      name: 'listCaptureHistory',
      run: async () => {
        const rows = await listCaptureHistory(db);
        return {
          count: rows.length,
          ids: rows.map(r => `${r.id}:${r.status}`),
        };
      },
    },
    {
      name: `getPendingCapture(${CAPTURE_PENDING})`,
      run: async () => {
        const row = await getPendingCapture(db, CAPTURE_PENDING);
        return {
          count: row ? 1 : 0,
          ids: row ? [row.id] : [],
          detail: row?.clip?.uri ?? null,
        };
      },
    },
    {
      name: `getCaptureTargetSeed(${CAPTURE_PENDING})`,
      run: async () => {
        const seed = await getCaptureTargetSeed(db, CAPTURE_PENDING);
        return { count: seed ? 1 : 0, ids: [], detail: seed };
      },
    },
    {
      name: `listAnalysisRecords(${CAPTURE_ANALYZED})`,
      run: async () => {
        const rows = await listAnalysisRecords(db, CAPTURE_ANALYZED);
        return { count: rows.length, ids: rows.map(r => r.id) };
      },
    },
    {
      name: 'listLiveSessionHistory',
      run: async () => {
        const rows = await listLiveSessionHistory(db);
        return {
          count: rows.length,
          ids: rows.map(r => r.id),
          detail: rows.map(r => r.summary),
        };
      },
    },
    {
      name: `hasShotSyncReceipt(${SHOT_SYNCED})`,
      run: async () => {
        const has = await hasShotSyncReceipt(db, SHOT_SYNCED);
        return { count: has ? 1 : 0, ids: has ? [SHOT_SYNCED] : [] };
      },
    },
    {
      name: `getShotOutboxStatus(${SHOT_SCORED})`,
      run: async () => {
        const status = await getShotOutboxStatus(db, SHOT_SCORED);
        return {
          count: status.state === 'absent' ? 0 : 1,
          ids: [],
          detail: status,
        };
      },
    },
    ...OWNER_SCOPED_KV_NAMESPACES.map(namespace => ({
      name: `kv:${namespace}`,
      run: async () => {
        const raw = await getKv(db, `${namespace}:${owner}`);
        return { count: raw ? 1 : 0, ids: [], detail: raw };
      },
    })),
  ];
}

async function readerMatrixFor(
  label: string,
): Promise<Record<string, { count: number; ids: string[]; detail?: unknown }>> {
  const out: Record<
    string,
    { count: number; ids: string[]; detail?: unknown }
  > = {};
  for (const reader of readers()) {
    out[reader.name] = await reader.run();
  }
  evidence.readerMatrix[label] = out;
  return out;
}

function expectEmptyMatrix(
  matrix: Record<string, { count: number; ids: string[] }>,
): void {
  const leaks = Object.entries(matrix)
    .filter(([, value]) => value.count !== 0)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`);
  expect(leaks).toEqual([]);
}

async function seedOwnerBucket(
  label: 'A' | 'B',
  permit: string,
  clipUri: string,
): Promise<void> {
  const db = getDb();
  const owner = getActiveDataOwner();
  const score = label === 'A' ? 7.8 : 4.2;
  const capturedAt =
    label === 'A' ? '2026-08-27T18:00:00.000Z' : '2026-08-28T09:30:00.000Z';
  await saveSession(db, {
    id: SESSION_LIVE,
    mode: 'live_court',
    shotType: null,
    focusCheckpoint: null,
    startedAt: capturedAt,
  });
  await finishSession(db, SESSION_LIVE, { rallies: label === 'A' ? 12 : 3 });
  await saveSession(db, {
    id: SESSION_PRACTICE,
    mode: 'practice',
    shotType: 'forehand_drive',
    focusCheckpoint: 'contact_position',
    startedAt: capturedAt,
  });
  await saveAnalysis(
    db,
    buildAnalysis({
      id: SHOT_SCORED,
      sessionId: SESSION_PRACTICE,
      capturedAtIso: capturedAt,
      overallScore: score,
      checkpoints: [
        {
          key: 'contact_position',
          score: score * 10,
          confidence: 0.9,
          band: 'green',
          direction: 'none',
          severity: 0,
          applicable: true,
        },
      ],
    }),
    permit,
  );
  await saveLocalOnlyAnalysis(
    db,
    buildAbstainedAnalysis({
      id: SHOT_ABSTAINED,
      capturedAtIso: capturedAt,
    }),
  );
  await saveAnalysis(
    db,
    buildAnalysis({
      id: SHOT_SYNCED,
      capturedAtIso: capturedAt,
      overallScore: score,
    }),
    permit,
  );
  const clip = buildClip({ uri: clipUri, capturedAtIso: capturedAt });
  await savePendingCapture(
    db,
    CAPTURE_PENDING,
    'forehand_drive',
    clip,
    'forehand_drive',
  );
  await setCaptureTargetSeed(db, CAPTURE_PENDING, {
    point: { x: label === 'A' ? 0.25 : 0.75, y: 0.5 },
    selectedAtIso: capturedAt,
  });
  // local_capture is UNIQUE(owner_key, uri): a second clip needs its own file.
  await savePendingCapture(
    db,
    CAPTURE_ANALYZED,
    'forehand_drive',
    buildClip({
      uri: clipUri.replace('.mov', '-analyzed.mov'),
      capturedAtIso: capturedAt,
    }),
  );
  await saveAnalysisRecord(
    db,
    buildAnalysisRecord({
      id: RECORD_1,
      captureId: CAPTURE_ANALYZED,
      result: buildAnalysis({ id: SHOT_SCORED, overallScore: score }),
      createdAtIso: capturedAt,
    }),
  );
  await markCaptureAnalyzed(db, CAPTURE_ANALYZED);
  for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
    await setKv(
      db,
      `${namespace}:${owner}`,
      namespace === 'profile'
        ? JSON.stringify(
            buildProfile({
              firstName: label === 'A' ? 'Ada' : 'Bo',
              goal: label === 'A' ? 'dinks' : 'serve',
              focusCheckpoint:
                label === 'A' ? 'contact_position' : 'sequencing',
            }),
          )
        : JSON.stringify({ owner: label, namespace }),
    );
  }
  // One synced shot: the server accepts SHOT_SYNCED only.
  const transport: SyncTransport = {
    async syncShots(shots) {
      const ids = shots.map(s => String((s as { id: unknown }).id));
      return {
        acceptedIds: ids.filter(id => id === SHOT_SYNCED),
        rejected: ids
          .filter(id => id !== SHOT_SYNCED)
          .map(id => ({
            id,
            code: 'shot.write_failed',
            message: 'transient for the harness',
          })),
      };
    },
    async createSession() {},
    async finalizeSession() {},
  };
  await drainOutbox(db, transport);
}

describe('xc account switch — repository isolation on one real SQLite db', () => {
  beforeAll(() => {
    mockHandle = openRealSqlite();
    evidence.engine = mockHandle.engine;
    evidence.heap['start'] = heapNumbers();
  });

  afterAll(() => {
    evidence.heap['end'] = heapNumbers();
    evidence.matrices['final'] = ownershipMatrix(handle());
    const path = writeEvidence('repository-isolation.json', evidence);
    console.log(`[xc] repository evidence → ${path}`);
    handle().close();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  });

  it('opens the production schema on a real engine', async () => {
    const db = getDb();
    const { rows } = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = rows.map(r => String(r['name']));
    expect(names).toEqual(
      expect.arrayContaining([
        'local_shot',
        'local_session',
        'local_capture',
        'local_analysis_record',
        'outbox',
        'sync_receipt',
        'kv',
      ]),
    );
    step('schema', { engine: mockHandle?.engine, tables: names });
  });

  it('A seeds a full bucket (shots, sessions, captures, records, outbox, receipt, all kv namespaces)', async () => {
    setActiveDataOwner(OWNER_A);
    // Device-level pre-auth stash exists on this phone; it is NOT owner data.
    await setKv(
      getDb(),
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: buildProfile({ goal: 'drops' }) }),
    );
    await setKv(getDb(), PENDING_ONBOARDING_PROFILE_KV_KEY, '');
    await seedOwnerBucket('A', PERMIT_A, 'file:///private/captures/a.mov');

    const matrix = await readerMatrixFor('A after seeding A');
    expect(matrix['listShots']?.ids.sort()).toEqual(
      [SHOT_ABSTAINED, SHOT_SCORED, SHOT_SYNCED].sort(),
    );
    expect(matrix[`getAnalysis(${SHOT_SCORED})`]?.detail).toBe(7.8);
    expect(matrix['listPendingCaptures']?.ids).toEqual([CAPTURE_PENDING]);
    expect(matrix['listCaptureHistory']?.ids.sort()).toEqual(
      [
        `${CAPTURE_ANALYZED}:analyzed`,
        `${CAPTURE_PENDING}:awaiting_model`,
      ].sort(),
    );
    expect(matrix[`listAnalysisRecords(${CAPTURE_ANALYZED})`]?.ids).toEqual([
      RECORD_1,
    ]);
    expect(matrix['listLiveSessionHistory']?.ids).toEqual([SESSION_LIVE]);
    expect(matrix[`hasShotSyncReceipt(${SHOT_SYNCED})`]?.count).toBe(1);
    expect(matrix[`getShotOutboxStatus(${SHOT_SCORED})`]?.detail).toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'shot.write_failed: transient for the harness',
    });
    for (const namespace of OWNER_SCOPED_KV_NAMESPACES) {
      expect(matrix[`kv:${namespace}`]?.count).toBe(1);
    }
    evidence.matrices['after A seed'] = ownershipMatrix(handle());
    step('seed A', evidence.matrices['after A seed']);
  });

  it('B (fresh sign-in on the same device) reads an EMPTY bucket through every reader', async () => {
    setActiveDataOwner(OWNER_B);
    const matrix = await readerMatrixFor('B after seeding A');
    expectEmptyMatrix(matrix);
    // The profile key B would read is physically distinct from A's.
    expect(profileKeyForOwner(OWNER_B)).not.toBe(profileKeyForOwner(OWNER_A));
    expect(await getKv(getDb(), profileKeyForOwner(OWNER_B))).toBeNull();
    step('B reads empty');
  });

  it('device guest bucket never inherits a signed-in account\u2019s rows', async () => {
    setActiveDataOwner(GUEST_DATA_OWNER);
    const matrix = await readerMatrixFor('guest after seeding A');
    expectEmptyMatrix(matrix);
    step('guest reads empty');
  });

  it('signed-out: every reader is empty and every product writer is refused without touching a row', async () => {
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const db = getDb();
    const matrix = await readerMatrixFor('signed-out after seeding A');
    expectEmptyMatrix(matrix);

    const before = ownershipMatrix(handle());
    const clip = buildClip();
    const writers: Array<[string, () => Promise<unknown>]> = [
      [
        'saveAnalysis',
        () => saveAnalysis(db, buildAnalysis({ id: 'so-shot' }), PERMIT_A),
      ],
      [
        'saveLocalOnlyAnalysis',
        () =>
          saveLocalOnlyAnalysis(db, buildAbstainedAnalysis({ id: 'so-shot' })),
      ],
      [
        'savePendingCapture',
        () => savePendingCapture(db, 'so-cap', 'forehand_drive', clip),
      ],
      [
        'saveAnalysisRecord',
        () =>
          saveAnalysisRecord(
            db,
            buildAnalysisRecord({
              id: 'so-rec',
              captureId: CAPTURE_ANALYZED,
              result: null,
            }),
          ),
      ],
      [
        'setDeclaredStroke',
        () => setDeclaredStroke(db, CAPTURE_PENDING, 'backhand_drive'),
      ],
      [
        'setCaptureTargetSeed',
        () =>
          setCaptureTargetSeed(db, CAPTURE_PENDING, {
            point: { x: 0, y: 0 },
            selectedAtIso: 'x',
          }),
      ],
      [
        'updateCaptureClipPayload',
        () => updateCaptureClipPayload(db, CAPTURE_PENDING, clip),
      ],
      ['markCaptureAnalyzed', () => markCaptureAnalyzed(db, CAPTURE_PENDING)],
      [
        'saveSession',
        () =>
          saveSession(db, {
            id: 'so-session',
            mode: 'practice',
            shotType: null,
            focusCheckpoint: null,
            startedAt: '2026-08-27T00:00:00.000Z',
          }),
      ],
      ['finishSession', () => finishSession(db, SESSION_LIVE, {})],
    ];
    const outcomes: Record<string, string> = {};
    for (const [name, write] of writers) {
      await expect(write()).rejects.toThrow(
        'Sign in or continue locally before saving product data.',
      );
      outcomes[name] = 'refused';
    }
    const after = ownershipMatrix(handle());
    expect(after).toEqual(before);
    expect(after['local_shot']?.[SIGNED_OUT_DATA_OWNER]).toBeUndefined();
    step('signed-out writers refused', outcomes);
  });

  it('B seeds the SAME ids: A\u2019s rows are byte-for-byte unchanged and each owner reads only their own content', async () => {
    setActiveDataOwner(OWNER_A);
    const aBefore = ownerSnapshot(handle(), OWNER_A);

    setActiveDataOwner(OWNER_B);
    await seedOwnerBucket('B', PERMIT_B, 'file:///private/captures/b.mov');
    const bMatrix = await readerMatrixFor('B after seeding B');
    expect(bMatrix[`getAnalysis(${SHOT_SCORED})`]?.detail).toBe(4.2);
    expect(bMatrix[`getPendingCapture(${CAPTURE_PENDING})`]?.detail).toBe(
      'file:///private/captures/b.mov',
    );
    expect(bMatrix[`getCaptureTargetSeed(${CAPTURE_PENDING})`]?.detail).toEqual(
      { point: { x: 0.75, y: 0.5 }, selectedAtIso: '2026-08-28T09:30:00.000Z' },
    );
    expect(bMatrix['listLiveSessionHistory']?.detail).toEqual([
      JSON.stringify({ rallies: 3 }),
    ]);
    expect(JSON.parse(String(bMatrix['kv:profile']?.detail)).firstName).toBe(
      'Bo',
    );

    setActiveDataOwner(OWNER_A);
    const aAfter = ownerSnapshot(handle(), OWNER_A);
    expect(aAfter).toEqual(aBefore);
    const aMatrix = await readerMatrixFor('A after seeding B');
    expect(aMatrix[`getAnalysis(${SHOT_SCORED})`]?.detail).toBe(7.8);
    expect(aMatrix[`getPendingCapture(${CAPTURE_PENDING})`]?.detail).toBe(
      'file:///private/captures/a.mov',
    );
    expect(aMatrix['listLiveSessionHistory']?.detail).toEqual([
      JSON.stringify({ rallies: 12 }),
    ]);
    expect(JSON.parse(String(aMatrix['kv:profile']?.detail)).firstName).toBe(
      'Ada',
    );

    // Physical: two rows per shared id, one per owner, never merged.
    const shots = handle().dumpTable('local_shot');
    const byId = new Map<string, string[]>();
    for (const row of shots) {
      const id = String(row['id']);
      byId.set(id, [...(byId.get(id) ?? []), String(row['owner_key'])]);
    }
    for (const id of [SHOT_SCORED, SHOT_ABSTAINED, SHOT_SYNCED]) {
      expect(byId.get(id)?.sort()).toEqual([OWNER_A, OWNER_B].sort());
    }
    evidence.matrices['after B seed'] = ownershipMatrix(handle());
    step('same-id collision', evidence.matrices['after B seed']);
  });

  it('B\u2019s mutations aimed at shared ids touch zero A rows (UPDATEs are owner-qualified)', async () => {
    const db = getDb();
    const aBefore = ownerSnapshot(handle(), OWNER_A);
    setActiveDataOwner(OWNER_B);
    const hostile: CapturedClip = buildClip({
      uri: 'file:///private/captures/b.mov',
      capturedAtIso: '2026-08-28T09:30:00.000Z',
      durationMs: 1,
    });
    await setDeclaredStroke(db, CAPTURE_PENDING, 'backhand_drive');
    await setCaptureTargetSeed(db, CAPTURE_PENDING, {
      point: { x: 0.99, y: 0.99 },
      selectedAtIso: '2026-08-28T10:00:00.000Z',
    });
    await updateCaptureClipPayload(db, CAPTURE_PENDING, hostile);
    await markCaptureAnalyzed(db, CAPTURE_PENDING);
    await finishSession(db, SESSION_PRACTICE, { hijack: true });
    await setKv(
      db,
      profileKeyForOwner(OWNER_B),
      JSON.stringify(buildProfile({ firstName: 'Bo2' })),
    );

    const aAfter = ownerSnapshot(handle(), OWNER_A);
    expect(aAfter).toEqual(aBefore);

    setActiveDataOwner(OWNER_A);
    const pending = await getPendingCapture(db, CAPTURE_PENDING);
    expect(pending?.declaredStroke).toBe('forehand_drive');
    expect(pending?.clip?.durationMs).toBe(3900);
    expect((await listPendingCaptures(db)).map(r => r.id)).toEqual([
      CAPTURE_PENDING,
    ]);
    expect(await getCaptureTargetSeed(db, CAPTURE_PENDING)).toEqual({
      point: { x: 0.25, y: 0.5 },
      selectedAtIso: '2026-08-27T18:00:00.000Z',
    });
    const raw = await getKv(db, profileKeyForOwner(OWNER_A));
    expect(JSON.parse(String(raw)).firstName).toBe('Ada');
    step('cross-owner mutations are no-ops for A');
  });

  it('drainOutbox under B sends ONLY B\u2019s rows and writes receipts ONLY for B', async () => {
    const db = getDb();
    setActiveDataOwner(OWNER_B);
    const sent: { shots: string[]; sessions: string[]; finalized: string[] } = {
      shots: [],
      sessions: [],
      finalized: [],
    };
    const transport: SyncTransport = {
      async syncShots(shots) {
        const ids = shots.map(s => String((s as { id: unknown }).id));
        sent.shots.push(...ids);
        return { acceptedIds: ids, rejected: [] };
      },
      async createSession(session) {
        sent.sessions.push(String((session as { id: unknown }).id));
      },
      async finalizeSession(id) {
        sent.finalized.push(id);
      },
    };
    const outboxBefore = handle().dumpTable('outbox');
    const aRowsBefore = outboxBefore.filter(r => r['owner_key'] === OWNER_A);
    const result = await drainOutbox(db, transport);
    const outboxAfter = handle().dumpTable('outbox');
    const aRowsAfter = outboxAfter.filter(r => r['owner_key'] === OWNER_A);

    // Everything B had queued went out; nothing of A's did, and A's queue is
    // physically identical.
    expect(result.failed).toBe(0);
    expect(outboxAfter.filter(r => r['owner_key'] === OWNER_B)).toEqual([]);
    expect(aRowsAfter).toEqual(aRowsBefore);
    expect(aRowsBefore.length).toBeGreaterThan(0);
    // Payload provenance: every shot B pushed carries B's permit, never A's.
    for (const row of outboxBefore.filter(
      r => r['owner_key'] === OWNER_B && r['kind'] === 'shot.sync',
    )) {
      expect(String(row['payload'])).toContain(PERMIT_B);
      expect(String(row['payload'])).not.toContain(PERMIT_A);
    }
    const receipts = handle().dumpTable('sync_receipt');
    expect(
      receipts
        .filter(r => r['owner_key'] === OWNER_B)
        .map(r => String(r['entity_id']))
        .sort(),
    ).toEqual([SHOT_SCORED, SHOT_SYNCED].sort());
    expect(
      receipts
        .filter(r => r['owner_key'] === OWNER_A)
        .map(r => String(r['entity_id'])),
    ).toEqual([SHOT_SYNCED]);

    setActiveDataOwner(OWNER_A);
    expect(await hasShotSyncReceipt(db, SHOT_SCORED)).toBe(false);
    expect(await getShotOutboxStatus(db, SHOT_SCORED)).toMatchObject({
      state: 'queued',
    });
    step('drain under B', { sent, result });
  });

  it('purgeOwnerData(A) removes every A row and kv namespace while B\u2019s bucket and device-level kv stay intact', async () => {
    const db = getDb();
    await setKv(
      db,
      PENDING_ONBOARDING_PROFILE_KV_KEY,
      JSON.stringify({ version: 1, profile: buildProfile({ goal: 'drops' }) }),
    );
    const bBefore = ownerSnapshot(handle(), OWNER_B);
    const deviceBefore = await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY);

    await purgeOwnerData(db, OWNER_A);

    const matrix = ownershipMatrix(handle());
    for (const table of Object.keys(matrix)) {
      expect(matrix[table]?.[OWNER_A]).toBeUndefined();
    }
    expect(ownerSnapshot(handle(), OWNER_B)).toEqual(bBefore);
    expect(await getKv(db, PENDING_ONBOARDING_PROFILE_KV_KEY)).toBe(
      deviceBefore,
    );
    setActiveDataOwner(OWNER_A);
    expectEmptyMatrix(await readerMatrixFor('A after purge(A)'));
    setActiveDataOwner(OWNER_B);
    const bMatrix = await readerMatrixFor('B after purge(A)');
    expect(bMatrix[`getAnalysis(${SHOT_SCORED})`]?.detail).toBe(4.2);
    evidence.matrices['after purge A'] = matrix;
    step('purge A', matrix);
  });

  it('no token or credential material ever reached SQLite', () => {
    const everything = JSON.stringify({
      tables: Object.fromEntries(
        [
          'local_shot',
          'local_session',
          'local_capture',
          'local_analysis_record',
          'outbox',
          'sync_receipt',
          'kv',
        ].map(t => [t, handle().dumpTable(t)]),
      ),
      statements: handle().statementLog,
    });
    assertNoSecretMaterial(everything, 'sqlite');
    expect(everything).not.toContain(IDENTITY_A.email);
    expect(everything).not.toContain(IDENTITY_B.email);
    step('no secrets in sqlite', {
      statements: handle().statementLog.length,
    });
  });
});
