/**
 * A shot whose outbox row was permanently rejected or spent its retry budget
 * is never drained again (sync.ts `attempts < OUTBOX_MAX_ATTEMPTS`). The
 * repository must expose that durable state and the Result surface must tell
 * the truth instead of promising the shot is "still in the secure outbox".
 *
 * The sync gate lives in the Personalized training section of the full
 * breakdown (`ResultBreakdownSheet`, hosted by the `ResultDetails` route);
 * the four-page Result guide keeps the plan off its pages, so the gate is
 * driven through `ResultDetailsScreen` here. Its `SyncEvidenceState` is the
 * object union derived from `hasShotSyncReceipt` then `getShotOutboxStatus`.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type { ShotAnalysis } from '@pickle/shared-types';

const mockExecute = jest.fn<
  Promise<{ rows: Record<string, unknown>[] }>,
  [string, unknown[]?]
>();
jest.mock('../../src/data/db', () => ({
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

import {
  getShotOutboxStatus,
  hasShotSyncReceipt,
} from '../../src/data/repository';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import { ResultDetailsScreen } from '../../src/screens/ResultDetailsScreen';
import {
  clearTryAgainHandoff,
  peekTryAgainHandoff,
} from '../../src/screens/tryAgainHandoff';

function analysisFixture(): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: null,
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
  // Evidence → receipt → outbox status resolve on successive microtask turns.
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  return renderer;
}

function pressByLabel(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const [node] = renderer.root.findAll(
    n =>
      n.props.accessibilityLabel === label &&
      typeof n.props.onPress === 'function',
  );
  if (!node) throw new Error(`No pressable labeled ${label}`);
  act(() => {
    node.props.onPress();
  });
}

describe('fix-12: getShotOutboxStatus', () => {
  it('reports the durable outbox state for a shot', async () => {
    await expect(getShotOutboxStatus(fakeDb([]), 'shot-1')).resolves.toEqual({
      state: 'absent',
    });
    await expect(
      getShotOutboxStatus(
        fakeDb([{ attempts: 0, last_error: null }]),
        'shot-1',
      ),
    ).resolves.toEqual({ state: 'queued', attempts: 0, lastError: null });
    await expect(
      getShotOutboxStatus(
        fakeDb([{ attempts: 0, last_error: 'ApiError: 503' }]),
        'shot-1',
      ),
    ).resolves.toEqual({
      state: 'queued',
      attempts: 0,
      lastError: 'ApiError: 503',
    });
    await expect(
      getShotOutboxStatus(
        fakeDb([{ attempts: 3, last_error: 'permit_invalid: expired' }]),
        'shot-1',
      ),
    ).resolves.toEqual({
      state: 'rejected',
      attempts: 3,
      lastError: 'permit_invalid: expired',
    });
    await expect(
      getShotOutboxStatus(
        fakeDb([
          { attempts: OUTBOX_MAX_ATTEMPTS, last_error: 'permit_invalid: used' },
        ]),
        'shot-1',
      ),
    ).resolves.toEqual({
      state: 'exhausted',
      attempts: OUTBOX_MAX_ATTEMPTS,
      lastError: 'permit_invalid: used',
    });
  });

  it('scopes the lookup to the shot id inside the payload and to the owner', async () => {
    const db = fakeDb([]);
    await getShotOutboxStatus(db, 'shot-9');
    const [sql, params] = db.execute.mock.calls[0]!;
    expect(sql).toMatch(/kind = 'shot\.sync'/);
    expect(sql).toMatch(/json_extract\(payload, '\$\.id'\)/);
    expect(sql).toMatch(/owner_key = \?/);
    expect(params).toEqual([expect.any(String), 'shot-9']);
    await expect(hasShotSyncReceipt(db, 'shot-9')).resolves.toBe(false);
  });
});

describe('fix-12: Result breakdown sync gate honesty', () => {
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
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  function stubOutbox(rows: Record<string, unknown>[]) {
    mockExecute.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM sync_receipt')) return { rows: [] };
      if (sql.includes('FROM outbox')) return { rows };
      return { rows: [] };
    });
  }

  it('an exhausted shot is not described as pending and offers a new read', async () => {
    stubOutbox([
      { attempts: OUTBOX_MAX_ATTEMPTS, last_error: 'permit_invalid: used' },
    ]);
    const renderer = await renderResult();
    const text = textOf(renderer);

    expect(text).toContain('The server did not accept this read.');
    expect(text).toContain(`Sync was refused ${OUTBOX_MAX_ATTEMPTS} times`);
    expect(text).toContain('permit_invalid: used');
    expect(text).not.toContain('still in the secure outbox');
    // No plan can be built from a read the server will never accept.
    expect(
      renderer.root.findAll(
        n => n.props.accessibilityLabel === 'Build reviewed plan',
      ),
    ).toHaveLength(0);
    // "Capture a new read" is the sheet's own TRY AGAIN: the same-intent
    // handoff is armed (a legacy row with no record re-declares its analyzed
    // shot type) and the guided camera opens.
    expect(peekTryAgainHandoff()).toBeNull();
    pressByLabel(renderer, 'Capture a new read');
    expect(mockNavigate).toHaveBeenCalledWith('Analyze', { source: 'camera' });
    expect(peekTryAgainHandoff()).toEqual({
      source: 'camera',
      declaredStroke: 'forehand_drive',
      declaredCanonical: null,
      auto: false,
      sessionId: null,
    });
    act(() => renderer.unmount());
  });

  it('a rejected shot inside the retry budget states the refusal and the retry', async () => {
    stubOutbox([{ attempts: 2, last_error: 'permit_invalid: expired' }]);
    const renderer = await renderResult();
    const text = textOf(renderer);

    expect(text).toContain(
      `The server refused this read 2 of ${OUTBOX_MAX_ATTEMPTS} times`,
    );
    expect(text).toContain('permit_invalid: expired');
    expect(text).toContain('will be retried');
    expect(text).not.toContain('still in the secure outbox');
    act(() => renderer.unmount());
  });

  it('a queued shot keeps the pending copy', async () => {
    stubOutbox([{ attempts: 0, last_error: null }]);
    const renderer = await renderResult();

    expect(textOf(renderer)).toContain('still in the secure outbox');
    act(() => renderer.unmount());
  });

  it('no receipt and no outbox row is reported as unverifiable, not pending', async () => {
    stubOutbox([]);
    const renderer = await renderResult();
    const text = textOf(renderer);

    expect(text).toContain('could not verify whether this shot reached');
    expect(text).not.toContain('still in the secure outbox');
    act(() => renderer.unmount());
  });
});
