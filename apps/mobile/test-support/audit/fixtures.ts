import type { ShotAnalysis } from '@pickle/shared-types';
import type { SyncTransport } from '../../src/data/sync';

export const AUDIT_OWNER_A = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const AUDIT_PERMIT_ID = 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee';

export function auditUuid(n: number): string {
  const tail = n.toString(16).padStart(12, '0');
  return `aaaaaaaa-bbbb-4ccc-8ddd-${tail}`;
}

export function scoredAnalysis(
  overrides: Partial<ShotAnalysis> = {},
): ShotAnalysis {
  return {
    id: auditUuid(1),
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
    ...overrides,
  };
}

export type SyncShotsResponse = Awaited<ReturnType<SyncTransport['syncShots']>>;

/** Transport whose every call is recorded; behaviour is injected per test. */
export function recordingTransport(behaviour: {
  syncShots?: (
    shots: Array<Record<string, unknown>>,
  ) => Promise<SyncShotsResponse>;
  createSession?: (session: Record<string, unknown>) => Promise<void>;
  finalizeSession?: (id: string) => Promise<void>;
}) {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const transport: SyncTransport = {
    async syncShots(shots) {
      calls.push({ method: 'syncShots', payload: shots });
      if (!behaviour.syncShots) throw new Error('unexpected syncShots');
      return behaviour.syncShots(shots as Array<Record<string, unknown>>);
    },
    async createSession(session) {
      calls.push({ method: 'createSession', payload: session });
      if (!behaviour.createSession) throw new Error('unexpected createSession');
      return behaviour.createSession(session as Record<string, unknown>);
    },
    async finalizeSession(id) {
      calls.push({ method: 'finalizeSession', payload: id });
      if (!behaviour.finalizeSession)
        throw new Error('unexpected finalizeSession');
      return behaviour.finalizeSession(id);
    },
  };
  return { transport, calls };
}
