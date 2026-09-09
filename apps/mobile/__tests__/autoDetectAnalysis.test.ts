// AnalyzeScreen pulls in the SQLite-backed db, whose native binding does not
// exist under jest. The presentation helper under test never touches it.
jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

import { generateSwingSequence } from '@pickle/evaluation';
import { serializePoseSequence, sha256Hex } from '@pickle/swing-domain';
import type { LocalDb } from '../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  captureDataOwnerContext,
  getDataOwnerSnapshot,
  subscribeToDataOwner,
  setActiveDataOwner,
} from '../src/data/accountScope';
import type { CapturedClip } from '../src/camera/capture';
import { runCaptureAnalysis } from '../src/analysis/runCaptureAnalysis';
import {
  activeReleaseAuthority,
  isReleasePolicyRequest,
} from '../testSupport/releasePolicyFixture';
import { API_REQUEST_TIMEOUT_MS } from '../src/data/api';
import { runJournal } from '../src/analysis/runJournal';
import { loadSavedTechniqueConfirmation } from '../src/analysis/savedTechniqueConfirmation';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import {
  closeSqliteTestDatabases,
  createSqliteTestDb,
  seedSqliteCapture,
} from '../testSupport/sqlite';
import { strokeIntentPresentation } from '../src/screens/AnalyzeScreen';
import {
  listAnalysisRecords,
  listPendingCaptures,
} from '../src/data/repository';
import { createFusionProviders } from '../src/vision/providers';
import { ENVELOPE_DIMENSIONS, type ShotTypeSlug } from '@pickle/shared-types';
import { finalizeAcknowledgement } from '../__harness__/analysisPermitRoute';

jest.mock('../src/vision/providers', () => ({
  ...jest.requireActual('../src/vision/providers'),
  createFusionProviders: jest.fn((...args) =>
    jest
      .requireActual('../src/vision/providers')
      .createFusionProviders(...args),
  ),
}));

/**
 * AUTO DETECT end to end (W4): declared-null runs route through the REAL
 * ported hierarchical classifier and the fusion resolution ladder.
 *
 * Hard rules locked here:
 *  - declared and predicted stay separate (an AUTO run never writes a
 *    declaration, a family read never becomes a leaf slug);
 *  - abstention/family outcomes release the analysis permit — they must
 *    never burn the user's rating allowance — and render honest copy;
 *  - the declared path is byte-for-byte unchanged;
 *  - imported videos still require a declared technique and are refused
 *    before any stroke routing or permit reservation.
 */

jest.mock('../src/camera/capture', () => {
  const actual = jest.requireActual('../src/camera/capture');
  return {
    ...actual,
    readCaptureArtifact: (uri: string) => mockReadArtifact(uri),
  };
});

let mockReadArtifact: (uri: string) => Promise<string> = async () => {
  throw new Error('readCaptureArtifact mock not configured');
};

const owner = '22222222-2222-4222-8222-222222222222';

function recordingDb() {
  return createSqliteTestDb();
}

function permitServer(): { fetchMock: jest.Mock; finalized: unknown[] } {
  const finalized: unknown[] = [];
  let reservations = 0;
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/v1/analysis-permits')) {
      reservations += 1;
      return jsonResponse({
        permit: {
          id:
            reservations === 1
              ? '66666666-6666-4666-8666-666666666666'
              : `66666666-6666-4666-8666-${String(reservations).padStart(12, '0')}`,
          accessSource: 'free',
          status: 'reserved',
          expiresAt: '2026-08-27T20:00:00.000Z',
        },
      });
    }
    if (url.includes('/finalize')) {
      const body: unknown = JSON.parse(String(init?.body));
      finalized.push(body);
      return jsonResponse(finalizeAcknowledgement(url, body));
    }
    if (isReleasePolicyRequest(url))
      return jsonResponse(activeReleaseAuthority());
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { fetchMock, finalized };
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as unknown as Response;
}

function swingClipWithSidecar(
  overrides: Parameters<typeof generateSwingSequence>[0] = {},
): {
  clip: CapturedClip;
  sidecarJson: string;
} {
  const { sequence, window } = generateSwingSequence(overrides);
  const sidecarJson = serializePoseSequence(sequence);
  const clip: CapturedClip = {
    uri: 'file:///captures/stroke-auto.mov',
    durationMs: window.endMs,
    fps: sequence.video.fps,
    width: sequence.video.width,
    height: sequence.video.height,
    capturedAtIso: '2026-08-27T18:00:00.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: window.startMs,
      endMs: window.endMs,
      peakMotionMs: window.peakMs,
      confidence: 0.86,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: sequence.producedBy.modelVersion,
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: sequence.frames.length,
      poseFrameCount: sequence.frames.length,
      poseMissingFrameCount: 0,
      trackedDurationMs: window.endMs,
      meanCanonicalJointVisibility: 0.9,
      meanJointCoverage: 0.9,
      minimumJointCoverage: 0.8,
      fullBodyVisibleFrameCount: sequence.frames.length,
      jointMotion: [
        {
          joint: 'right_wrist',
          sampleCount: 4,
          meanNormalizedPerSecond: 0.6,
          peakNormalizedPerSecond: 1.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 400,
    postRollMs: 300,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: 'file:///captures/stroke-auto.pose.json',
      frameCount: sequence.frames.length,
      sha256: sha256Hex(sidecarJson),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: sequence.producedBy.modelVersion,
    },
  };
  return { clip, sidecarJson };
}

const importedClip: CapturedClip = {
  uri: 'file:///imports/rally.mov',
  durationMs: 5100,
  fps: 30,
  width: 1920,
  height: 1080,
  capturedAtIso: '2026-08-27T18:10:00.000Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
};

function request(
  db: LocalDb,
  clip: CapturedClip,
  declaredStroke: ShotTypeSlug | null,
  declaredCanonical: string | null = null,
) {
  const captureId = '77777777-7777-4777-8777-777777777777';
  seedSqliteCapture(db, owner, captureId, clip);
  return {
    db,
    captureId,
    clip,
    declaredStroke,
    declaredCanonical,
    handedness: 'right' as const,
    cameraView: 'side' as const,
    apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
    appVersion: '0.1.0',
  };
}

function confirmRequest(input: ReturnType<typeof request>, analysisId: string) {
  return {
    ...input,
    declaredStroke: 'dink' as const,
    declaredCanonical: 'BACKHAND_DINK',
    techniqueConfirmation: {
      analysisId,
      intent: {
        version: 'technique-intent-v1' as const,
        source: 'tap' as const,
        canonical: 'BACKHAND_DINK',
        legacySlug: 'dink' as const,
        confidence: 1,
      },
      confirmedAtIso: '2026-09-06T18:00:00.000Z',
    },
  };
}

async function pendingConfirmationFixture(releaseFailure?: number) {
  const store = recordingDb();
  const { clip, sidecarJson } = swingClipWithSidecar();
  mockReadArtifact = async () => sidecarJson;
  const http = permitServer();
  if (releaseFailure !== undefined) {
    const handle = http.fetchMock.getMockImplementation()!;
    http.fetchMock.mockImplementation((url: string, init?: RequestInit) =>
      url.includes('/finalize')
        ? Promise.resolve({
            ok: false,
            status: releaseFailure,
            json: async () => ({
              error: {
                code:
                  releaseFailure === 409
                    ? 'access.permit_already_finalized'
                    : 'server.unavailable',
                message: 'Release not confirmed',
              },
            }),
          } as Response)
        : handle(url, init),
    );
  }
  (globalThis as { fetch?: unknown }).fetch = http.fetchMock;
  const input = request(store.db, clip, null);
  const first = await runCaptureAnalysis(input);
  if (first.kind !== 'needs_technique_confirmation')
    throw new Error('Expected real pending confirmation');
  const load = (db = store.db) =>
    loadSavedTechniqueConfirmation({
      db,
      ownerContext: captureDataOwnerContext(),
      captureId: input.captureId,
      apiOrigin: input.apiConfig.baseUrl,
    });
  return { store, clip, sidecarJson, http, input, first, load };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('runCaptureAnalysis with AUTO DETECT (declared-null)', () => {
  beforeEach(() => {
    setActiveDataOwner(owner);
    establishApiSession({
      canonicalAppUserId: owner,
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      provider: 'apple',
    });
  });
  afterEach(() => {
    jest.useRealTimers();
    closeSqliteTestDatabases();
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (globalThis as { fetch?: unknown }).fetch = undefined;
  });

  it.each(
    [0, 1].flatMap(used =>
      ['503', '401', '429', 'offline', 'timeout', 'lost_ack'].map(
        releaseFailure => ({ used, releaseFailure }),
      ),
    ),
  )(
    'W03 durable continuation creates no second hold before original release: $used used / $releaseFailure',
    async ({ used, releaseFailure }) => {
      if (releaseFailure === 'timeout') jest.useFakeTimers();
      const store = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      mockReadArtifact = async () => sidecarJson;
      const reservations = new Map<string, { id: string; released: boolean }>();
      let releaseAvailable = false;
      let onReleaseStarted: (() => void) | undefined;
      const events: string[] = [];
      const server = jest.fn(async (url: string, init?: RequestInit) => {
        if (isReleasePolicyRequest(url))
          return jsonResponse(activeReleaseAuthority());
        const body = JSON.parse(String(init?.body));
        if (url.endsWith('/v1/analysis-permits')) {
          events.push('reserve');
          const existing = reservations.get(body.idempotencyKey);
          if (existing)
            return jsonResponse({
              permit: {
                ...existing,
                accessSource: 'free',
                status: existing.released ? 'released' : 'reserved',
                expiresAt: '2027-01-01T00:00:00.000Z',
              },
            });
          if (
            used +
              [...reservations.values()].filter(value => !value.released)
                .length >=
            2
          ) {
            return {
              ok: false,
              status: 402,
              json: async () => ({
                error: {
                  code: 'access.paywall_required',
                  message: 'No free ratings remain',
                },
              }),
            } as Response;
          }
          const permit = {
            id: `66666666-6666-4666-8666-${String(reservations.size + 1).padStart(12, '0')}`,
            released: false,
          };
          reservations.set(body.idempotencyKey, permit);
          return jsonResponse({
            permit: {
              ...permit,
              accessSource: 'free',
              status: 'reserved',
              expiresAt: '2027-01-01T00:00:00.000Z',
            },
          });
        }
        events.push('release');
        onReleaseStarted?.();
        const original = [...reservations.values()].find(value =>
          url.includes(value.id),
        );
        if (!original) throw new Error('Unknown test permit');
        if (!releaseAvailable) {
          if (releaseFailure === 'offline') throw new Error('offline');
          if (releaseFailure === 'timeout')
            return new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted')),
                { once: true },
              );
            });
          if (releaseFailure === 'lost_ack') original.released = true;
          return {
            ok: false,
            status:
              releaseFailure === 'lost_ack' ? 503 : Number(releaseFailure),
            json: async () => ({
              error: { code: 'server.unavailable', message: 'Try later' },
            }),
          } as Response;
        }
        original.released = true;
        return jsonResponse(finalizeAcknowledgement(url, body));
      });
      (globalThis as { fetch?: unknown }).fetch = server;
      const run = async (next: Parameters<typeof runCaptureAnalysis>[0]) => {
        const started = new Promise<void>(resolve => {
          onReleaseStarted = resolve;
        });
        const pending = runCaptureAnalysis(next);
        if (releaseFailure === 'timeout' && !releaseAvailable) {
          await started;
          await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS);
        }
        return pending;
      };
      const input = request(store.db, clip, null);
      const first = await run(input);
      expect(first.kind).toBe('needs_technique_confirmation');
      if (first.kind !== 'needs_technique_confirmation') return;
      const confirmed = confirmRequest(input, first.analysisId);
      const blocked = await run(confirmed);
      expect(blocked).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expect(reservations.size).toBe(1);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      expect(store.count('local_shot', owner)).toBe(0);
      releaseAvailable = true;
      events.length = 0;
      const result = await run(confirmed);
      expect(result.kind).toBe('scored');
      expect(events).toEqual(['release', 'reserve']);
      expect(store.count('local_shot', owner)).toBe(1);
      expect(
        store.native
          .prepare(
            'SELECT state FROM analysis_run_journal WHERE analysis_id = ?',
          )
          .get(first.analysisId)?.state,
      ).toBe('released');
    },
  );

  it('W03 durable continuation rejects a truthy but incomplete original intent before any new reservation', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    globalThis.fetch = fetchMock;
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    store.native
      .prepare('UPDATE local_analysis_record SET record = ? WHERE id = ?')
      .run(
        JSON.stringify({ ...first.record, strokeIntent: {} }),
        first.analysisId,
      );
    const calls = fetchMock.mock.calls.length;
    expect(
      await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
    ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    expect(store.count('analysis_run_journal', owner)).toBe(1);
  });

  it.each(['terminal', 'empty_recovery'])(
    'never accepts %s as original release proof',
    async state => {
      const fixture = await pendingConfirmationFixture(
        state === 'terminal' ? 409 : 503,
      );
      const { store, input, first, http } = fixture;
      const row = store.native
        .prepare('SELECT operation_id, state FROM analysis_run_journal')
        .get()!;
      expect(row.state).toBe(
        state === 'terminal' ? 'terminal' : 'release_pending',
      );
      const finish =
        state === 'empty_recovery'
          ? runJournal.startExecution({
              ownerKey: owner,
              apiOrigin: input.apiConfig.baseUrl,
              operationId: String(row.operation_id),
            })
          : () => {};
      const before = http.fetchMock.mock.calls.length;
      try {
        expect(
          await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
        ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
        expect(store.count('analysis_run_journal', owner)).toBe(1);
        expect(store.count('local_shot', owner)).toBe(0);
        expect(http.fetchMock).toHaveBeenCalledTimes(before);
      } finally {
        finish();
      }
    },
  );

  it('loads the newest confirmation read-only, without providers, HTTP, or persistence', async () => {
    const { store, http, first, load } = await pendingConfirmationFixture();
    const before = http.fetchMock.mock.calls.length;
    const providerCalls = (createFusionProviders as jest.Mock).mock.calls
      .length;
    const writes = store.calls.filter(call =>
      /^(INSERT|UPDATE|DELETE)/.test(call.sql.trim()),
    ).length;
    expect(await load()).toMatchObject({
      kind: 'ready',
      saved: { captureId: first.record.captureId, record: first.record },
      journal: { state: 'released' },
    });
    expect(http.fetchMock).toHaveBeenCalledTimes(before);
    expect(createFusionProviders).toHaveBeenCalledTimes(providerCalls);
    expect(
      store.calls.filter(call =>
        /^(INSERT|UPDATE|DELETE)/.test(call.sql.trim()),
      ),
    ).toHaveLength(writes);
    const pending = await listPendingCaptures(store.db);
    expect(pending[0]?.techniqueConfirmation).toBe('ready');
  });

  it.each([
    [
      'missing snapshot',
      (record: Record<string, unknown>) => {
        delete record.inputSelection;
      },
      'legacy',
    ],
    [
      'truthy intent',
      (record: Record<string, unknown>) => {
        record.strokeIntent = true;
      },
      'corrupt',
    ],
    [
      'empty intent',
      (record: Record<string, unknown>) => {
        record.strokeIntent = {};
      },
      'corrupt',
    ],
    [
      'unsupported schema',
      (record: Record<string, unknown>) => {
        record.schemaVersion = 2;
      },
      'corrupt',
    ],
    [
      'unknown reason',
      (record: Record<string, unknown>) => {
        record.confirmationReason = 'scored';
      },
      'corrupt',
    ],
    [
      'unknown kind',
      (record: Record<string, unknown>) => {
        record.kind = 'future_analysis';
      },
      'corrupt',
    ],
    [
      'missing confirmation kind',
      (record: Record<string, unknown>) => {
        delete record.kind;
      },
      'corrupt',
    ],
    [
      'missing envelope',
      (record: Record<string, unknown>) => {
        delete record.captureEnvelope;
      },
      'corrupt',
    ],
    [
      'truthy envelope',
      (record: Record<string, unknown>) => {
        record.captureEnvelope = true;
      },
      'corrupt',
    ],
    [
      'missing provenance',
      (record: Record<string, unknown>) => {
        delete record.provenance;
      },
      'corrupt',
    ],
    [
      'bad runs',
      (record: Record<string, unknown>) => {
        record.modelRuns = [{}];
      },
      'corrupt',
    ],
    [
      'wrong hash',
      (record: Record<string, unknown>) => {
        record.observationHash = 'b'.repeat(64);
      },
      'corrupt',
    ],
    [
      'row identity mismatch',
      (record: Record<string, unknown>) => {
        record.id = '88888888-8888-4888-8888-888888888888';
      },
      'corrupt',
    ],
    [
      'row timestamp mismatch',
      (record: Record<string, unknown>) => {
        record.createdAtIso = '2026-01-01T00:00:00.000Z';
      },
      'corrupt',
    ],
    [
      'row engine mismatch',
      (record: Record<string, unknown>) => {
        record.engineVersion = 'fusion-3';
      },
      'corrupt',
    ],
  ] as const)(
    'shares strict loader/replay/admission parsing: %s',
    async (_label, mutate, reason) => {
      const { store, input, first, http, load } =
        await pendingConfirmationFixture();
      const changed = JSON.parse(JSON.stringify(first.record)) as Record<
        string,
        unknown
      >;
      mutate(changed);
      store.native
        .prepare('UPDATE local_analysis_record SET record = ?')
        .run(JSON.stringify(changed));
      const calls = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject({ kind: 'unavailable', reason });
      expect(await runCaptureAnalysis(input)).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expect(
        await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
      ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(http.fetchMock).toHaveBeenCalledTimes(calls);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it.each([
    ["UPDATE local_capture SET target_seed = ''", [], 'corrupt'],
    [
      'UPDATE local_capture SET target_seed = ?',
      [
        JSON.stringify({
          point: { x: 1.1, y: 0.5 },
          selectedAtIso: '2026-08-29T12:00:00.000Z',
        }),
      ],
      'corrupt',
    ],
    [
      'UPDATE local_capture SET target_seed = ?',
      [
        JSON.stringify({
          point: { x: 0.5, y: 0.5 },
          selectedAtIso: '2026-02-30T12:00:00.000Z',
        }),
      ],
      'corrupt',
    ],
    [
      'UPDATE local_capture SET target_seed = ?',
      [
        JSON.stringify({
          point: { x: 0.5, y: 0.5 },
          selectedAtIso: '2026-08-29T12:00:00.000Z',
        }),
      ],
      'evidence_changed',
    ],
    [
      "UPDATE local_capture SET declared_stroke = 'dink'",
      [],
      'evidence_changed',
    ],
    ['UPDATE local_capture SET width = width + 1', [], 'evidence_changed'],
    ["UPDATE local_capture SET payload = '{'", [], 'corrupt'],
    ["UPDATE local_capture SET status = 'analyzed'", [], 'corrupt'],
  ] as const)(
    'holds changed/corrupt stored evidence without any repair: %s',
    async (sql, params, reason) => {
      const { store, input, first, http, load } =
        await pendingConfirmationFixture();
      store.native.prepare(sql).run(...params);
      const calls = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject({ kind: 'unavailable', reason });
      expect(
        await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
      ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(http.fetchMock).toHaveBeenCalledTimes(calls);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      expect(store.count('local_capture', owner)).toBe(1);
    },
  );

  it.each(['https://api.test/other', 'https://other-api.test'])(
    'rejects a changed host or API path without rewriting the original binding: %s',
    async apiOrigin => {
      const { input, first, http, store } = await pendingConfirmationFixture();
      const before = http.fetchMock.mock.calls.length;
      expect(
        await loadSavedTechniqueConfirmation({
          db: store.db,
          ownerContext: captureDataOwnerContext(),
          captureId: input.captureId,
          apiOrigin,
        }),
      ).toMatchObject({ kind: 'unavailable', reason: 'origin_mismatch' });
      const confirmed = confirmRequest(input, first.analysisId);
      expect(
        await runCaptureAnalysis({
          ...confirmed,
          apiConfig: { baseUrl: apiOrigin, token: null },
        }),
      ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it('never revives an older confirmation behind a corrupt newest record', async () => {
    const { store, input, first, load, http } =
      await pendingConfirmationFixture();
    store.native
      .prepare(
        'INSERT INTO local_analysis_record (owner_key,id,capture_id,created_at,engine_version,scoring_model_version,record) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        owner,
        '99999999-9999-4999-8999-999999999999',
        input.captureId,
        '2099-01-01T00:00:00.000Z',
        'fusion-2',
        'abstained',
        '{',
      );
    const before = http.fetchMock.mock.calls.length;
    expect(await load()).toMatchObject({
      kind: 'unavailable',
      reason: 'corrupt',
    });
    expect(
      await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
    ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
    expect(http.fetchMock).toHaveBeenCalledTimes(before);
    expect(store.count('analysis_run_journal', owner)).toBe(1);
  });

  it.each(['absent', 'changed'])(
    'holds %s pose sidecar evidence without extraction',
    async mode => {
      const { input, first, http, load } = await pendingConfirmationFixture();
      mockReadArtifact = async () => {
        if (mode === 'absent') throw new Error('missing file');
        return '{}';
      };
      const before = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject({
        kind: 'unavailable',
        reason: 'evidence_changed',
      });
      expect(
        (await runCaptureAnalysis(confirmRequest(input, first.analysisId)))
          .kind,
      ).toBe('unavailable');
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
    },
  );

  it.each(['missing', 'changed', 'relocated'])(
    'verifies the current saved pose reference rather than a stale snapshot URI: %s',
    async mode => {
      const { store, clip, sidecarJson, load, http } =
        await pendingConfirmationFixture();
      const currentUri = 'file:///relocated-captures/stroke-auto.pose.json';
      const changed = {
        ...clip,
        poseSequence: { ...clip.poseSequence!, uri: currentUri },
      };
      store.native
        .prepare('UPDATE local_capture SET payload = ?')
        .run(JSON.stringify(changed));
      const reads: string[] = [];
      mockReadArtifact = async uri => {
        reads.push(uri);
        if (uri !== currentUri) {
          if (mode === 'relocated')
            throw new Error('Old app container is gone');
          return sidecarJson;
        }
        if (mode === 'missing') throw new Error('Current sidecar is gone');
        return mode === 'changed' ? '{}' : sidecarJson;
      };
      const before = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject(
        mode === 'relocated'
          ? { kind: 'ready' }
          : { kind: 'unavailable', reason: 'evidence_changed' },
      );
      expect(reads).toEqual([currentUri]);
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
    },
  );

  it.each(['video', 'sidecar', 'container'])(
    'binds saved artifact identity while allowing container relocation: %s',
    async changed => {
      const { store, clip, input, first, load, http } =
        await pendingConfirmationFixture();
      const replacement: CapturedClip = {
        ...clip,
        uri:
          changed === 'video'
            ? 'file:///captures/other.mov'
            : 'file:///new-container/stroke-auto.mov',
        poseSequence: {
          ...clip.poseSequence!,
          uri:
            changed === 'sidecar'
              ? 'file:///captures/other.pose.json'
              : 'file:///new-container/stroke-auto.pose.json',
        },
      };
      store.native
        .prepare('UPDATE local_capture SET uri = ?, payload = ?')
        .run(replacement.uri, JSON.stringify(replacement));
      const before = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject(
        changed === 'container'
          ? { kind: 'ready' }
          : { kind: 'unavailable', reason: 'evidence_changed' },
      );
      if (changed !== 'container')
        expect(
          await runCaptureAnalysis({
            ...confirmRequest(input, first.analysisId),
            clip: replacement,
          }),
        ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it.each(['frame_count', 'pose_model', 'width', 'height', 'fps'])(
    'rejects mismatched sidecar %s before creating any journal or hold',
    async changed => {
      const store = recordingDb();
      const { clip, sidecarJson } = swingClipWithSidecar();
      if (changed === 'frame_count')
        clip.poseSequence = {
          ...clip.poseSequence!,
          frameCount: clip.poseSequence!.frameCount + 1,
        };
      if (changed === 'pose_model')
        clip.poseSequence = {
          ...clip.poseSequence!,
          poseModelVersion: 'unrelated-pose-producer',
        };
      if (changed === 'width') clip.width += 1;
      if (changed === 'height') clip.height += 1;
      if (changed === 'fps') clip.fps += 1;
      mockReadArtifact = async () => sidecarJson;
      const { fetchMock } = permitServer();
      globalThis.fetch = fetchMock;
      expect(
        await runCaptureAnalysis(request(store.db, clip, null)),
      ).toMatchObject({
        kind: 'unavailable',
        reason: expect.stringContaining('saved metadata'),
      });
      expect(store.count('analysis_run_journal', owner)).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(['pose', 'trigger'])(
    'binds %s provenance to the actual input producer, not merely its version string',
    async producer => {
      const { store, first, input, load, http } =
        await pendingConfirmationFixture();
      const record = JSON.parse(
        JSON.stringify(first.record),
      ) as typeof first.record;
      record.provenance.providerVersions =
        record.provenance.providerVersions.map(model =>
          model.providerId.startsWith(`${producer}.`)
            ? { ...model, providerId: `${producer}.unrelated` }
            : model,
        );
      store.native
        .prepare('UPDATE local_analysis_record SET record = ?')
        .run(JSON.stringify(record));
      const before = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      expect(
        await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
      ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it.each(['recovery', 'admission'])(
    'revalidates the complete immutable original across the %s boundary',
    async boundary => {
      const { store, first, input, http } = await pendingConfirmationFixture(
        boundary === 'recovery' ? 503 : undefined,
      );
      const mutateOriginal = () => {
        const record = JSON.parse(
          JSON.stringify(first.record),
        ) as typeof first.record;
        record.provenance.appVersion = 'changed-after-validation';
        store.native
          .prepare('UPDATE local_analysis_record SET record = ?')
          .run(JSON.stringify(record));
      };
      let changed = false;
      const db: LocalDb = {
        ...store.db,
        transaction: operation =>
          store.db.transaction!(async transaction => {
            if (boundary === 'admission' && !changed) {
              changed = true;
              mutateOriginal();
            }
            return operation(transaction);
          }),
      };
      if (boundary === 'recovery') {
        http.fetchMock.mockImplementation(
          async (url: string, init?: RequestInit) => {
            if (!url.includes('/finalize'))
              return jsonResponse({
                permit: {
                  id: '66666666-6666-4666-8666-000000000002',
                  status: 'reserved',
                  accessSource: 'free',
                  expiresAt: '2099-01-01T00:00:00.000Z',
                },
              });
            changed = true;
            mutateOriginal();
            return jsonResponse(
              finalizeAcknowledgement(url, JSON.parse(String(init?.body))),
            );
          },
        );
      }
      const before = http.fetchMock.mock.calls.length;
      expect(
        await runCaptureAnalysis({
          ...confirmRequest(input, first.analysisId),
          db,
        }),
      ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
      expect(changed).toBe(true);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      expect(store.count('local_shot', owner)).toBe(0);
      expect(
        http.fetchMock.mock.calls
          .slice(before)
          .every(([url]) => url.includes('/finalize')),
      ).toBe(true);
    },
  );

  it.each(['owner', 'aba', 'origin'])(
    'rolls back continuation creation if %s changes before its transaction commits',
    async change => {
      const { store, first, input, http } = await pendingConfirmationFixture();
      let reached = false;
      store.observeStatements(call => {
        if (call.sql.includes('INSERT INTO analysis_run_journal') && !reached) {
          reached = true;
          if (change === 'origin')
            establishApiSession({
              canonicalAppUserId: owner,
              apiBaseUrl: 'https://api.test/changed',
              bearerToken: 'new-origin-bearer',
              provider: 'apple',
            });
          else {
            setActiveDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
            if (change === 'aba') setActiveDataOwner(owner);
          }
        }
      });
      const before = http.fetchMock.mock.calls.length;
      expect(
        await runCaptureAnalysis(confirmRequest(input, first.analysisId)),
      ).toMatchObject({
        kind: 'unavailable',
        cause: change === 'origin' ? 'recovery_pending' : 'account_changed',
      });
      store.observeStatements(null);
      expect(reached).toBe(true);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      expect(store.count('local_shot', owner)).toBe(0);
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
    },
  );

  it.each(
    [
      'capture',
      'journal',
      'artifact',
      'recheck_capture',
      'recheck_journal',
    ].flatMap(boundary => [false, true].map(aba => ({ boundary, aba }))),
  )(
    'invalidates deferred loader work at $boundary, ABA=$aba',
    async ({ boundary, aba }) => {
      const { store, input, sidecarJson, load, http } =
        await pendingConfirmationFixture();
      const reached = deferred<void>();
      const resume = deferred<void>();
      let captures = 0;
      let journals = 0;
      const db: LocalDb = {
        async execute(sql, params) {
          const result = await store.db.execute(sql, params);
          const kind = sql.includes('SELECT c.*')
            ? ++captures === 1
              ? 'capture'
              : 'recheck_capture'
            : sql.includes('SELECT * FROM analysis_run_journal WHERE owner_key')
              ? ++journals === 1
                ? 'journal'
                : 'recheck_journal'
              : null;
          if (kind === boundary) {
            reached.resolve();
            await resume.promise;
          }
          return result;
        },
        close() {},
      };
      if (boundary === 'artifact')
        mockReadArtifact = async () => {
          reached.resolve();
          await resume.promise;
          return sidecarJson;
        };
      const before = http.fetchMock.mock.calls.length;
      const pending = loadSavedTechniqueConfirmation({
        db,
        ownerContext: captureDataOwnerContext(),
        captureId: input.captureId,
        apiOrigin: input.apiConfig.baseUrl,
      });
      await reached.promise;
      setActiveDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      if (aba) setActiveDataOwner(owner);
      resume.resolve();
      expect(await pending).toMatchObject({
        kind: 'unavailable',
        reason: 'account_changed',
      });
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
      setActiveDataOwner(owner);
      mockReadArtifact = async () => sidecarJson;
      expect(await load()).toMatchObject({ kind: 'ready' });
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it.each(
    [
      'query',
      'original_read',
      'attempt_write',
      'release_ack',
      'release_write',
      'revalidated_capture',
    ].flatMap(boundary => [false, true].map(aba => ({ boundary, aba }))),
  )(
    'holds original-only recovery across deferred $boundary, ABA=$aba',
    async ({ boundary, aba }) => {
      const { store, first, input, http, load } =
        await pendingConfirmationFixture(503);
      const reached = deferred<void>();
      const resume = deferred<void>();
      let enteredRecovery = false;
      let released = false;
      let paused = false;
      const pause = async (at: string) => {
        if (at !== boundary || paused) return;
        paused = true;
        reached.resolve();
        await resume.promise;
      };
      const db: LocalDb = {
        ...store.db,
        async execute(sql, params) {
          const result = await store.db.execute(sql, params);
          if (sql.includes('ORDER BY attempt_count ASC')) {
            enteredRecovery = true;
            await pause('query');
          } else if (
            enteredRecovery &&
            sql.includes('SELECT * FROM analysis_run_journal WHERE owner_key')
          )
            await pause('original_read');
          if (sql.includes('SET attempt_count = MIN'))
            await pause('attempt_write');
          if (sql.includes("SET state = 'released'")) {
            released = true;
            await pause('release_write');
          }
          if (released && sql.includes('SELECT c.*'))
            await pause('revalidated_capture');
          return result;
        },
      };
      const originalPermit = store.native
        .prepare(
          'SELECT permit_id FROM analysis_run_journal WHERE analysis_id = ?',
        )
        .get(first.analysisId)?.permit_id;
      http.fetchMock.mockImplementation(
        async (url: string, init?: RequestInit) => {
          expect(url).toBe(
            `${input.apiConfig.baseUrl}/v1/analysis-permits/${originalPermit}/finalize`,
          );
          expect(JSON.parse(String(init?.body))).toEqual({
            outcome: 'low_confidence',
            ratingId: null,
          });
          await pause('release_ack');
          return jsonResponse(
            finalizeAcknowledgement(url, JSON.parse(String(init?.body))),
          );
        },
      );
      const before = http.fetchMock.mock.calls.length;
      const pending = runCaptureAnalysis({
        ...confirmRequest(input, first.analysisId),
        db,
      });
      await reached.promise;
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      setActiveDataOwner('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      if (aba) setActiveDataOwner(owner);
      resume.resolve();
      expect(await pending).toMatchObject({
        kind: 'unavailable',
        cause: 'account_changed',
      });
      expect(store.count('analysis_run_journal', owner)).toBe(1);
      expect(
        store.count(
          'analysis_run_journal',
          'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        ),
      ).toBe(0);
      expect(store.count('local_shot', owner)).toBe(0);
      expect(store.count('outbox', owner)).toBe(0);
      expect(
        http.fetchMock.mock.calls
          .slice(before)
          .every(([url]) => url.includes(String(originalPermit))),
      ).toBe(true);
      setActiveDataOwner(owner);
      expect(['ready', 'release_pending']).toContain((await load()).kind);
    },
  );

  it('has a stable reactive owner epoch snapshot, including same-UUID ABA', () => {
    const first = getDataOwnerSnapshot();
    const listener = jest.fn();
    const unsubscribe = subscribeToDataOwner(listener);
    try {
      expect(getDataOwnerSnapshot()).toBe(first);
      setActiveDataOwner(owner);
      expect(getDataOwnerSnapshot()).toBe(first);
      expect(listener).not.toHaveBeenCalled();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      setActiveDataOwner(owner);
      expect(getDataOwnerSnapshot()).not.toBe(first);
      expect(getDataOwnerSnapshot().ownerKey).toBe(owner);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });

  it('pins concurrent and stale selections to one continuation and replays the committed result past its original', async () => {
    const { store, input, first, load, http } =
      await pendingConfirmationFixture();
    const confirmed = confirmRequest(input, first.analysisId);
    const competing = {
      ...confirmed,
      declaredCanonical: 'FOREHAND_DINK',
      techniqueConfirmation: {
        ...confirmed.techniqueConfirmation,
        intent: {
          ...confirmed.techniqueConfirmation.intent,
          canonical: 'FOREHAND_DINK',
        },
      },
    };
    const fusion = jest
      .requireActual<typeof import('../src/vision/providers')>(
        '../src/vision/providers',
      )
      .createFusionProviders('dink');
    if (fusion.kind !== 'real') throw new Error('Expected scorer');
    const started = deferred<void>();
    const resume = deferred<void>();
    const classifier = fusion.providers.autoStrokeClassifier!;
    const classify = classifier.classify.bind(classifier);
    classifier.classify = async next => {
      started.resolve();
      await resume.promise;
      return classify(next);
    };
    (createFusionProviders as jest.Mock).mockReturnValueOnce(fusion);
    const running = runCaptureAnalysis(confirmed);
    await started.promise;
    expect(await runCaptureAnalysis(competing)).toMatchObject({
      kind: 'unavailable',
      cause: 'recovery_pending',
    });
    resume.resolve();
    const scored = await running;
    expect(scored.kind).toBe('scored');
    if (scored.kind !== 'scored') return;
    expect(await runCaptureAnalysis(confirmed)).toMatchObject({
      kind: 'scored',
      analysisId: scored.analysisId,
      replayed: true,
    });
    expect(await runCaptureAnalysis(competing)).toMatchObject({
      kind: 'scored',
      analysisId: scored.analysisId,
      replayed: true,
    });
    expect(await load()).toMatchObject({
      kind: 'already_completed',
      analysisId: scored.analysisId,
      resultKind: 'scored',
    });
    expect(store.count('analysis_run_journal', owner)).toBe(2);
    expect(store.count('local_shot', owner)).toBe(1);
    expect(store.count('outbox', owner)).toBe(1);
    expect(
      http.fetchMock.mock.calls.filter(([url]) =>
        url.endsWith('/v1/analysis-permits'),
      ),
    ).toHaveLength(2);
  });

  it.each(['committed', 'uncertain'])(
    'consults the stable %s continuation before new input/model gates',
    async state => {
      const { store, input, first, http } = await pendingConfirmationFixture();
      const confirmed = confirmRequest(input, first.analysisId);
      if (state === 'uncertain')
        http.fetchMock.mockImplementation(
          async () =>
            ({
              ok: false,
              status: 503,
              json: async () => ({
                error: {
                  code: 'server.unavailable',
                  message: 'Reservation acknowledgement lost',
                },
              }),
            }) as Response,
        );
      const result = await runCaptureAnalysis(confirmed);
      expect(result.kind).toBe(
        state === 'committed' ? 'scored' : 'unavailable',
      );
      const reads = jest.fn(async () => {
        throw new Error('The original sidecar is unavailable');
      });
      mockReadArtifact = reads;
      const providers = jest.mocked(createFusionProviders);
      const create = providers.getMockImplementation()!;
      providers.mockImplementation(() => ({
        kind: 'unavailable',
        reason: 'Current model is unavailable',
      }));
      const before = http.fetchMock.mock.calls.length;
      const providerCalls = providers.mock.calls.length;
      try {
        const replay = await runCaptureAnalysis({
          ...confirmed,
          handedness: 'left',
          focusCheckpoint: 'changed-since-commit',
        });
        expect(replay).toMatchObject(
          result.kind === 'scored'
            ? {
                kind: 'scored',
                analysisId: result.analysisId,
                replayed: true,
                record: result.record,
              }
            : { kind: 'unavailable', cause: 'recovery_pending' },
        );
        expect(reads).not.toHaveBeenCalled();
        expect(providers).toHaveBeenCalledTimes(providerCalls);
        expect(http.fetchMock).toHaveBeenCalledTimes(before);
        expect(store.count('analysis_run_journal', owner)).toBe(2);
        expect(store.count('local_shot', owner)).toBe(
          state === 'committed' ? 1 : 0,
        );
        expect(store.count('outbox', owner)).toBe(
          state === 'committed' ? 1 : 0,
        );
      } finally {
        providers.mockImplementation(create);
      }
    },
  );

  it.each([
    'runs',
    'provenance',
    'intent',
    'selection',
    'result',
    'row',
    'product_payload',
    'product_metadata',
  ])(
    'holds a corrupt committed continuation instead of trusting a typed record: %s',
    async corruption => {
      const { store, first, input, http, load } =
        await pendingConfirmationFixture();
      const confirmed = confirmRequest(input, first.analysisId);
      const result = await runCaptureAnalysis(confirmed);
      if (result.kind !== 'scored')
        throw new Error('Expected committed continuation');
      const value = JSON.parse(JSON.stringify(result.record));
      if (corruption === 'runs') value.modelRuns = [{}];
      if (corruption === 'provenance')
        value.provenance.scoreVersion = 'unrelated';
      if (corruption === 'intent') value.strokeIntent = {};
      if (corruption === 'selection')
        value.inputSelection.definitionHash = '0'.repeat(64);
      if (corruption === 'result') value.result.phases = [true];
      if (corruption === 'row')
        store.native
          .prepare(
            "UPDATE local_analysis_record SET scoring_model_version = 'unrelated' WHERE id = ?",
          )
          .run(result.analysisId);
      if (corruption === 'product_payload')
        store.native
          .prepare("UPDATE local_shot SET payload = '{}' WHERE id = ?")
          .run(result.analysisId);
      if (corruption === 'product_metadata')
        store.native
          .prepare('UPDATE local_shot SET overall_score = 9.9 WHERE id = ?')
          .run(result.analysisId);
      store.native
        .prepare('UPDATE local_analysis_record SET record = ? WHERE id = ?')
        .run(JSON.stringify(value), result.analysisId);
      const before = http.fetchMock.mock.calls.length;
      expect(await load()).toMatchObject({
        kind: 'unavailable',
        reason: 'corrupt',
      });
      expect(await runCaptureAnalysis(confirmed)).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expect(http.fetchMock).toHaveBeenCalledTimes(before);
      expect(store.count('analysis_run_journal', owner)).toBe(2);
    },
  );

  it('rechecks a completed snapshot after deferred journal decoding before publishing latest-result success', async () => {
    const { store, first, input } = await pendingConfirmationFixture();
    const result = await runCaptureAnalysis(
      confirmRequest(input, first.analysisId),
    );
    if (result.kind !== 'scored')
      throw new Error('Expected committed continuation');
    const reached = deferred<void>();
    const resume = deferred<void>();
    let paused = false;
    const db: LocalDb = {
      ...store.db,
      async execute(sql, params) {
        const value = await store.db.execute(sql, params);
        if (
          !paused &&
          sql.includes('SELECT * FROM analysis_run_journal WHERE owner_key')
        ) {
          paused = true;
          reached.resolve();
          await resume.promise;
        }
        return value;
      },
    };
    const pending = loadSavedTechniqueConfirmation({
      db,
      ownerContext: captureDataOwnerContext(),
      captureId: input.captureId,
      apiOrigin: input.apiConfig.baseUrl,
    });
    await reached.promise;
    store.native
      .prepare(
        'INSERT INTO local_analysis_record (owner_key,id,capture_id,created_at,engine_version,scoring_model_version,record) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        owner,
        '99999999-9999-4999-8999-999999999999',
        input.captureId,
        '2099-01-01T00:00:00.000Z',
        'fusion-2',
        'abstained',
        '{',
      );
    resume.resolve();
    expect(await pending).toMatchObject({ kind: 'unavailable' });
  });

  it('opens a newest low-confidence continuation instead of reviving its original confirmation', async () => {
    const { store, first, input, http, load } =
      await pendingConfirmationFixture();
    const fusion = jest
      .requireActual<typeof import('../src/vision/providers')>(
        '../src/vision/providers',
      )
      .createFusionProviders('dink');
    if (fusion.kind !== 'real') throw new Error('Expected scorer');
    const score = fusion.providers.scorer.score.bind(fusion.providers.scorer);
    fusion.providers.scorer.score = async next => {
      const result = await score(next);
      return result.ok
        ? {
            ok: true,
            value: {
              ...result.value,
              presentation: 'abstain',
              overallScore: null,
              analysisConfidence: 0.2,
            },
          }
        : result;
    };
    (createFusionProviders as jest.Mock).mockReturnValueOnce(fusion);
    const confirmed = confirmRequest(input, first.analysisId);
    const result = await runCaptureAnalysis(confirmed);
    expect(result.kind).toBe('low_confidence');
    if (result.kind !== 'low_confidence') return;
    const before = http.fetchMock.mock.calls.length;
    expect(await load()).toMatchObject({
      kind: 'already_completed',
      analysisId: result.analysisId,
      resultKind: 'low_confidence',
    });
    expect(await runCaptureAnalysis(confirmed)).toMatchObject({
      kind: 'low_confidence',
      analysisId: result.analysisId,
      replayed: true,
    });
    expect(http.fetchMock).toHaveBeenCalledTimes(before);
    expect(store.count('local_analysis_record', owner)).toBe(2);
    expect(store.count('local_shot', owner)).toBe(1);
    expect(store.count('outbox', owner)).toBe(0);
    expect(
      store.native
        .prepare(
          'SELECT state, result_id FROM analysis_run_journal WHERE analysis_id = ?',
        )
        .get(result.analysisId),
    ).toMatchObject({ state: 'released', result_id: null });
  });

  it.each(['handedness', 'camera', 'focus', 'model', 'operation', 'envelope'])(
    'holds changed continuation %s instead of rotating identity',
    async changed => {
      const { input, first, http, store } = await pendingConfirmationFixture();
      const confirmed: Parameters<typeof runCaptureAnalysis>[0] =
        confirmRequest(input, first.analysisId);
      if (changed === 'handedness') confirmed.handedness = 'left';
      if (changed === 'camera') confirmed.cameraView = 'rear_oblique';
      if (changed === 'focus') confirmed.focusCheckpoint = 'swing_length';
      if (changed === 'operation')
        confirmed.operationId = '99999999-9999-4999-8999-999999999999';
      if (changed === 'envelope')
        confirmed.captureEnvelope = {
          thresholdsVersion: 'different-unmeasured-envelope',
          provisional: true,
          overall: 'SUPPORTED',
          overallWithCoverage: 'SUPPORTED_UNMEASURED',
          notMeasured: [...ENVELOPE_DIMENSIONS],
          dimensions: ENVELOPE_DIMENSIONS.map(dimension => ({
            dimension,
            status: 'NOT_MEASURED',
            measured: null,
            unit: 'unknown',
            thresholdId: 'not_measured',
          })),
        };
      if (changed === 'model') {
        const fusion = jest
          .requireActual<typeof import('../src/vision/providers')>(
            '../src/vision/providers',
          )
          .createFusionProviders('dink');
        if (fusion.kind !== 'real') throw new Error('Expected scorer');
        const scorer = fusion.providers.scorer;
        fusion.providers.scorer = {
          descriptor: { ...scorer.descriptor, modelVersion: 'changed-model' },
          score: scorer.score.bind(scorer),
        };
        (createFusionProviders as jest.Mock).mockReturnValueOnce(fusion);
      }
      const calls = http.fetchMock.mock.calls.length;
      expect(await runCaptureAnalysis(confirmed)).toMatchObject({
        kind: 'unavailable',
        cause: 'recovery_pending',
      });
      expect(http.fetchMock).toHaveBeenCalledTimes(calls);
      expect(store.count('analysis_run_journal', owner)).toBe(1);
    },
  );

  it('W03 persists a replayable confirmation without a shot, charge, or analyzed capture marker', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const input = request(store.db, clip, null);

    const outcome = await runCaptureAnalysis(input);
    expect(outcome.kind).toBe('needs_technique_confirmation');
    if (outcome.kind !== 'needs_technique_confirmation') return;
    expect(outcome.record.result).toBeNull();
    expect(outcome.record.strokeIntent.declaredStroke).toBeNull();
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(await listPendingCaptures(store.db)).toEqual([
      expect.objectContaining({ id: input.captureId }),
    ]);
    expect(
      store.native
        .prepare('SELECT state, release_outcome FROM analysis_run_journal')
        .get(),
    ).toMatchObject({
      state: 'released',
      release_outcome: 'low_confidence',
    });
    expect(finalized).toEqual([{ outcome: 'low_confidence', ratingId: null }]);
    const recordWrite = store.calls.find(call =>
      call.sql.includes('INSERT INTO local_analysis_record'),
    )!;
    const releaseWrite = store.calls.find(call =>
      call.sql.includes("SET state = 'release_pending'"),
    )!;
    expect(recordWrite.transaction).toBe(releaseWrite.transaction);
    expect(
      store.calls.some(call => call.sql.includes("SET status = 'analyzed'")),
    ).toBe(false);
    const beforeReplay = fetchMock.mock.calls.length;
    const replay = await runCaptureAnalysis(input);
    expect(replay).toMatchObject({
      kind: 'needs_technique_confirmation',
      replayed: true,
      analysisId: outcome.analysisId,
    });
    expect(fetchMock).toHaveBeenCalledTimes(beforeReplay);
    expect(await listAnalysisRecords(store.db, input.captureId)).toHaveLength(
      1,
    );
  });

  it('W03 confirms the same saved capture once and appends user intent without rewriting its prediction history', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    const original = JSON.stringify(first.record);
    const confirmed = confirmRequest(input, first.analysisId);
    const second = await runCaptureAnalysis(confirmed);
    expect(second.kind).toBe('scored');
    if (second.kind !== 'scored') return;
    expect(second.analysisId).not.toBe(first.analysisId);
    expect(second.record.captureId).toBe(first.record.captureId);
    expect(second.record.result?.shotType).toBe('dink');
    expect(second.record.strokeIntent).toMatchObject({
      declaredStroke: 'dink',
      resolvedProfileId: 'BACKHAND_DINK',
      confirmation: {
        ...confirmed.techniqueConfirmation,
        originalStrokeIntent: first.record.strokeIntent,
      },
      disagreement: {
        declared: 'dink',
        predictedLabel: 'FOREHAND',
        basis: 'side_vs_declared',
      },
    });
    expect(JSON.stringify(first.record)).toBe(original);
    const records = await listAnalysisRecords(store.db, input.captureId);
    expect(records).toHaveLength(2);
    expect(
      JSON.stringify(records.find(record => record.id === first.analysisId)),
    ).toBe(original);
    expect(store.count('local_shot', owner)).toBe(1);
    expect(store.count('outbox', owner)).toBe(1);
    expect(finalized).toHaveLength(1);
    const replay = await runCaptureAnalysis(confirmed);
    expect(replay).toMatchObject({
      kind: 'scored',
      replayed: true,
      analysisId: second.analysisId,
    });
    expect(store.count('local_shot', owner)).toBe(1);
    expect(finalized).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.endsWith('/v1/analysis-permits'),
      ),
    ).toHaveLength(2);
  });

  it('W03 refuses fabricated confirmations or references to another capture before reserving again', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    const confirmed = confirmRequest(input, first.analysisId);
    const before = fetchMock.mock.calls.length;
    for (const invalid of [
      { ...confirmed, declaredCanonical: 'FOREHAND_DRIVE' },
      { ...confirmed, captureId: '88888888-8888-4888-8888-888888888888' },
      {
        ...confirmed,
        techniqueConfirmation: {
          ...confirmed.techniqueConfirmation,
          analysisId: '99999999-9999-4999-8999-999999999999',
        },
      },
      {
        ...confirmed,
        techniqueConfirmation: {
          ...confirmed.techniqueConfirmation,
          intent: {
            ...confirmed.techniqueConfirmation.intent,
            source: 'auto' as const,
          },
        },
      },
    ]) {
      expect((await runCaptureAnalysis(invalid)).kind).toBe('unavailable');
    }
    const altered = swingClipWithSidecar({ contactForwardNorm: 0.3 });
    mockReadArtifact = async () => altered.sidecarJson;
    expect(
      (await runCaptureAnalysis({ ...confirmed, clip: altered.clip })).kind,
    ).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(before);
    expect(store.count('local_analysis_record', owner)).toBe(1);
    expect(store.count('local_shot', owner)).toBe(0);
  });

  it('W03 preserves the original prediction even if the independent confirmation run observes something else', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    const fusion = jest
      .requireActual<typeof import('../src/vision/providers')>(
        '../src/vision/providers',
      )
      .createFusionProviders('dink');
    if (fusion.kind !== 'real') throw new Error('Expected real test providers');
    fusion.providers.autoStrokeClassifier!.classify = async () => ({
      ok: true,
      value: {
        ...first.record.strokeIntent.predictedStroke!,
        label: 'BACKHAND',
        leaf: null,
        taxonomyDepth: 2,
      },
    });
    (createFusionProviders as jest.Mock).mockReturnValueOnce(fusion);
    const confirmed = confirmRequest(input, first.analysisId);
    const second = await runCaptureAnalysis({
      ...confirmed,
      techniqueConfirmation: {
        ...confirmed.techniqueConfirmation,
        intent: {
          ...confirmed.techniqueConfirmation.intent,
          source: 'voice',
          rawUserText: 'backhand dink',
        },
      },
    });
    expect(second.kind).toBe('scored');
    if (second.kind !== 'scored') return;
    expect(second.record.strokeIntent.predictedStroke?.label).toBe('BACKHAND');
    expect(second.record.strokeIntent.confirmation).toMatchObject({
      analysisId: first.analysisId,
      intent: { source: 'voice', rawUserText: 'backhand dink' },
      originalStrokeIntent: first.record.strokeIntent,
    });
    expect(first.record.strokeIntent.predictedStroke?.label).toBe('FOREHAND');
    expect(
      (await listAnalysisRecords(store.db, input.captureId)).find(
        record => record.id === first.analysisId,
      ),
    ).toEqual(first.record);
  });

  it('W03 retains a replayable pending capture when non-scored permit release is temporarily unavailable', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = jest.fn(
      async (url: string, init?: RequestInit) => {
        if (url.endsWith('/finalize'))
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: { code: 'server.unavailable', message: 'Try later' },
            }),
          } as Response;
        return fetchMock(url, init);
      },
    );
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    expect(
      store.native
        .prepare(
          'SELECT state, result_id, release_outcome FROM analysis_run_journal',
        )
        .get(),
    ).toMatchObject({
      state: 'release_pending',
      result_id: null,
      release_outcome: 'low_confidence',
    });
    expect(finalized).toHaveLength(0);
    expect(store.count('local_shot', owner)).toBe(0);
    expect(store.count('outbox', owner)).toBe(0);
    expect(await listPendingCaptures(store.db)).toHaveLength(1);
    expect(await runCaptureAnalysis(input)).toMatchObject({
      kind: 'needs_technique_confirmation',
      replayed: true,
    });
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.endsWith('/v1/analysis-permits'),
      ),
    ).toHaveLength(1);
  });

  it('W03 never releases a committed confirmation whose result is pending sync when cancellation wins publication', async () => {
    const store = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    const input = request(store.db, clip, null);
    const first = await runCaptureAnalysis(input);
    expect(first.kind).toBe('needs_technique_confirmation');
    if (first.kind !== 'needs_technique_confirmation') return;
    const confirmed = confirmRequest(input, first.analysisId);
    const controller = new AbortController();
    let scoreWritten = false;
    store.observeStatements(call => {
      if (call.sql.includes("SET state = 'committed'")) scoreWritten = true;
      if (scoreWritten && call.sql === 'COMMIT') controller.abort();
    });
    expect(
      await runCaptureAnalysis({ ...confirmed, signal: controller.signal }),
    ).toMatchObject({ kind: 'unavailable', cause: 'recovery_pending' });
    store.observeStatements(null);
    expect(finalized).toHaveLength(1);
    expect(store.count('local_shot', owner)).toBe(1);
    expect(store.count('outbox', owner)).toBe(1);
    expect(
      store.native
        .prepare(
          "SELECT state FROM analysis_run_journal WHERE state = 'committed'",
        )
        .get()?.state,
    ).toBe('committed');
    expect(await runCaptureAnalysis(confirmed)).toMatchObject({
      kind: 'scored',
      replayed: true,
    });
    expect(finalized).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(([url]) =>
        url.endsWith('/v1/analysis-permits'),
      ),
    ).toHaveLength(2);
  });

  it('keeps a clear family read unscored and asks for an exact technique on the saved capture', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip, null));
    expect(outcome.kind).toBe('needs_technique_confirmation');
    if (outcome.kind !== 'needs_technique_confirmation') return;

    // declared/predicted stay separate; the family read is not a leaf slug.
    const intent = outcome.record.strokeIntent;
    expect(intent.declaredStroke).toBeNull();
    expect(intent.resolutionBasis).toBe('predicted_family');
    expect(intent.resolvedProfileId).toBe('SHARED_FOREHAND_SWING');
    expect(intent.predictedStroke?.label).toBe('FOREHAND');
    expect(intent.predictedStroke?.leaf).toBeNull();
    expect(intent.disagreement).toBeNull();
    // The side's representative swing target set produced a real score
    // while the provenance stays family-level (no leaf claimed).
    expect(outcome.record.result).toBeNull();
    expect(outcome.record.confirmationReason).toBe('family_only');
    expect(outcome.record.strokeResolution.kind).toBe('unresolved');

    // Provenance: the classifier ran as a registry-governed model run.
    expect(
      outcome.record.modelRuns.some(
        run =>
          run.task === 'stroke_classification' &&
          run.model.providerId === 'stroke.heuristic-hierarchical',
      ),
    ).toBe(true);

    // Permit accounting: a scored run is consumed by the shot-sync
    // transaction (never released) and promoted to the product rating.
    expect(finalized).toEqual([{ outcome: 'low_confidence', ratingId: null }]);
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO local_shot')),
    ).toHaveLength(0);
    // The run is durably recorded for reprocessing history.
    expect(calls.some(call => call.sql.includes('local_analysis_record'))).toBe(
      true,
    );
  });

  it('abstains honestly on a midline contact: permit released and the result withheld, not guessed', async () => {
    const { db, calls } = recordingDb();
    // Contact exactly on the body midline — the heuristic refuses a side.
    const { clip, sidecarJson } = swingClipWithSidecar({
      contactForwardNorm: 0,
    });
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(request(db, clip, null));
    expect(outcome.kind).toBe('needs_technique_confirmation');
    if (outcome.kind !== 'needs_technique_confirmation') return;

    const intent = outcome.record.strokeIntent;
    expect(intent.resolutionBasis).toBe('abstained');
    expect(intent.resolvedProfileId).toBeNull();
    expect(intent.predictedStroke?.label).toBe('UNKNOWN');
    expect(outcome.record.result).toBeNull();

    // The abstention did NOT consume the user's rating allowance.
    expect(finalized).toHaveLength(1);
    expect(finalized[0]).toMatchObject({
      outcome: 'low_confidence',
      ratingId: null,
    });
    expect(
      calls.filter(call => call.sql.includes('INSERT INTO outbox')),
    ).toHaveLength(0);

    // Honest abstention copy, exactly as the product promises it.
    const presentation = strokeIntentPresentation(outcome.record);
    expect(presentation?.title).toBe('Confirm the technique for this capture.');
    expect(presentation?.eyebrow).toBe('RATING NOT CONSUMED');
    expect(presentation?.body).toContain('did not use a rating');
    expect(presentation?.showResult).toBe(false);
  });

  it('keeps the declared path unchanged: full chain on the declaration, permit consumed via sync', async () => {
    const { db, calls } = recordingDb();
    const { clip, sidecarJson } = swingClipWithSidecar();
    mockReadArtifact = async () => sidecarJson;
    const { fetchMock, finalized } = permitServer();
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const outcome = await runCaptureAnalysis(
      request(db, clip, 'forehand_drive', 'FOREHAND_DRIVE'),
    );
    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') return;
    expect(outcome.record.strokeResolution).toEqual({
      kind: 'declared',
      shotType: 'forehand_drive',
    });
    const intent = outcome.record.strokeIntent;
    expect(intent.declaredStroke).toBe('forehand_drive');
    expect(intent.resolutionBasis).toBe('declared');
    expect(intent.resolvedProfileId).toBe('FOREHAND_DRIVE');
    // The classifier's side read agrees with the declaration: no claim.
    expect(intent.disagreement).toBeNull();
    expect(outcome.record.result?.overallScore).not.toBeNull();

    // No honest-surface interruption: the clean declared run navigates
    // straight to the Result screen exactly as before this workstream.
    expect(strokeIntentPresentation(outcome.record)).toBeNull();

    const outboxInsert = calls.find(call =>
      call.sql.includes('INSERT INTO outbox'),
    );
    expect(outboxInsert).toBeDefined();
    expect(JSON.parse(String(outboxInsert!.params[1])).analysisPermitId).toBe(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(finalized).toHaveLength(0); // consumed by sync, never finalized
  });

  it('still refuses imported videos before stroke routing — declared or not, no permit is touched', async () => {
    const { db, calls } = recordingDb();
    const fetchSpy = jest.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchSpy;

    const outcome = await runCaptureAnalysis(request(db, importedClip, null));
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.reason).toContain('Imported videos');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });
});
