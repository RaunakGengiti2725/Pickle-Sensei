/**
 * C3 — an orphaned shot (its practice set's `session.create` row spent its
 * budget, so the server can never accept the shot; sync.ts settles it with
 * the `shot.session_orphaned` verdict) must be told to the user as a terminal
 * state on the Result surface, not left as "still in the secure outbox".
 *
 * Same harness as fix-12: the sync gate lives in the Personalized training
 * section of the full breakdown hosted by the `ResultDetails` route.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';

const mockExecute = jest.fn<
  Promise<{ rows: Record<string, unknown>[] }>,
  [string, unknown[]?]
>();
jest.mock('../../../src/data/db', () => ({
  getDb: () => ({ execute: mockExecute, close() {} }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } =
    jest.requireActual<typeof import('react-native')>('react-native');
  return { SafeAreaView: View };
});

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({
    navigate: mockNavigate,
    goBack: jest.fn(),
    popTo: jest.fn(),
    popToTop: jest.fn(),
    replace: jest.fn(),
  }),
  useRoute: () => ({ params: { analysisId: 'analysis-1' } }),
}));

const mockLoadEvidence = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../../src/components/strokeResultData', () => ({
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
jest.mock('../../../src/training/store', () => ({
  useTrainingStore: (selector: (s: typeof mockTrainingState) => unknown) =>
    selector(mockTrainingState),
}));

jest.mock('../../../src/consistency/store', () => {
  const state = { refresh: jest.fn(async () => {}) };
  return {
    useConsistencyStore: (selector: (s: typeof state) => unknown) =>
      selector(state),
  };
});
jest.mock('../../../src/consistency/DaySecuredBanner', () => ({
  DaySecuredBanner: () => null,
}));
jest.mock('../../../src/components/AnalysisFeedbackPrompt', () => ({
  AnalysisFeedbackPrompt: () => null,
}));

import { getShotOutboxStatus } from '../../../src/data/repository';
import { SESSION_ORPHANED_VERDICT } from '../../../src/data/sync';
import { ResultDetailsScreen } from '../../../src/screens/ResultDetailsScreen';
import { clearTryAgainHandoff } from '../../../src/screens/tryAgainHandoff';

const ORPHAN_VERDICT = `${SESSION_ORPHANED_VERDICT}: Session not found for this shot. Its practice set was refused for good (Error: Session id belongs to another user.).`;

function analysisFixture(): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: 'dddddddd-0000-4000-8000-000000000001',
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: { startMs: 2000, contactMs: null, endMs: 2700 },
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

function fakeDb(outboxRows: Record<string, unknown>[]) {
  return {
    execute: jest.fn<
      Promise<{ rows: Record<string, unknown>[] }>,
      [string, unknown[]?]
    >(async sql => {
      if (sql.includes('FROM outbox')) return { rows: outboxRows };
      if (sql.includes('FROM sync_receipt')) return { rows: [] };
      throw new Error(`fakeDb: unhandled sql ${sql}`);
    }),
    close() {},
  };
}

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
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

describe('C3: getShotOutboxStatus reports the orphan verdict', () => {
  it('is `orphaned` — a terminal state with the untouched attempt count', async () => {
    await expect(
      getShotOutboxStatus(
        fakeDb([{ attempts: 0, last_error: ORPHAN_VERDICT }]),
        'shot-1',
      ),
    ).resolves.toEqual({
      state: 'orphaned',
      attempts: 0,
      lastError: ORPHAN_VERDICT,
    });
    // A plain session_not_found (session row still queued) stays queued.
    await expect(
      getShotOutboxStatus(
        fakeDb([
          {
            attempts: 0,
            last_error: 'shot.session_not_found: Session not found.',
          },
        ]),
        'shot-1',
      ),
    ).resolves.toMatchObject({ state: 'queued', attempts: 0 });
  });
});

describe('C3: Result breakdown tells the truth about an orphaned shot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearTryAgainHandoff();
    mockExecute.mockReset();
    mockNavigate.mockClear();
    mockLoadEvidence.mockReset();
    mockLoadEvidence.mockResolvedValue({
      analysis: analysisFixture(),
      record: null,
      clip: null,
      review: null,
      attempts: [],
    });
    mockExecute.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM sync_receipt')) return { rows: [] };
      if (sql.includes('FROM outbox')) {
        return { rows: [{ attempts: 0, last_error: ORPHAN_VERDICT }] };
      }
      return { rows: [] };
    });
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  it('names the refused practice set, says the read will not be sent again, and offers a new read', async () => {
    const renderer = await renderResult();
    const text = textOf(renderer);

    expect(text).toContain('The server did not accept this read.');
    expect(text).toContain('practice set this read belongs to was refused');
    expect(text).toContain('will not be sent again');
    expect(text).toContain('Session id belongs to another user.');
    expect(text).not.toContain('still in the secure outbox');
    expect(text).not.toContain('will be retried');
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === 'Build reviewed plan',
      ),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        n =>
          n.props.accessibilityLabel === 'Capture a new read' &&
          typeof n.props.onPress === 'function',
      ).length,
    ).toBeGreaterThan(0);
    act(() => renderer.unmount());
  });
});
