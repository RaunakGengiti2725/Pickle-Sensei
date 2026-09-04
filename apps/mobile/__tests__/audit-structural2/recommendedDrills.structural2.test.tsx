import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { CatalogDrill } from '../../src/training/api';
import { TrainingError } from '../../src/training/types';

/**
 * Structural audit #2 (mobile-results-review) — RecommendedDrills timing.
 *
 * The component fetches once per (analysis id, family) with a request id and
 * a cancellation flag. These probes race two attempts (same family and a
 * family change), resolve a request after unmount, and rotate the bearer
 * mid-fetch — the exact windows the architecture map lists as untested.
 */

const mockGetApiSession = jest.fn();
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn();
const mockCreateTrainingApi = jest.fn();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: (config: unknown) => {
    mockCreateTrainingApi(config);
    return { listCatalogDrills: mockListCatalogDrills };
  },
}));

import { RecommendedDrills } from '../../src/review/RecommendedDrills';

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
  };
}

function analysisFixture(overrides: Partial<ShotAnalysis> = {}): ShotAnalysis {
  return {
    id: 'analysis-1',
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-09-01T10:00:00.000Z',
    timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
    phases: [],
    measurements: [],
    checkpoints: [
      checkpoint('ready_position', 85, 'green', 'none'),
      checkpoint('paddle_path', 61, 'red', 'low'),
      checkpoint('contact_position', 48, 'red', 'late'),
    ],
    overallScore: 6.8,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'lowest_score',
      severity: 0.52,
      confidence: 0.8,
    },
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-geometry-1',
      scoringModelVersion: 'sm-v1',
      shotConfigVersion: 'forehand_drive@1',
    },
    source: 'real',
    ...overrides,
  };
}

function drill(slug: string, families: string[]): CatalogDrill {
  return {
    id: `id-${slug}`,
    slug,
    title: slug,
    description: `Description for ${slug}.`,
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    families,
    validationState: 'UNVALIDATED',
    saved: false,
  };
}

const DRIVE_DRILLS = [drill('drive-and-recover', ['drive'])];
const DINK_DRILLS = [drill('dink-target-ladder', ['dink'])];

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token-1',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockGetApiSession.mockReset();
  mockListCatalogDrills.mockReset();
  mockCreateTrainingApi.mockReset();
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('RecommendedDrills — request races', () => {
  it('a SLOW response for attempt 1 arriving after attempt 2 (same family) is discarded', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    const second = deferred<CatalogDrill[]>();
    mockListCatalogDrills
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture({ id: 'analysis-2' })}
          onOpenLibrary={jest.fn()}
        />,
      );
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    // Attempt 2 lands first with the real drills…
    await act(async () => {
      second.resolve(DRIVE_DRILLS);
    });
    expect(textOf(renderer)).toContain('drive-and-recover');
    // …then attempt 1's stale response (a different catalog) must not win.
    await act(async () => {
      first.resolve([drill('stale-drill', ['drive'])]);
    });
    expect(textOf(renderer)).toContain('drive-and-recover');
    expect(textOf(renderer)).not.toContain('stale-drill');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a stale REJECTION arriving after a newer success never downgrades the ready card to an error', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    mockListCatalogDrills
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(DRIVE_DRILLS);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture({ id: 'analysis-2' })}
          onOpenLibrary={jest.fn()}
        />,
      );
    });
    expect(textOf(renderer)).toContain('drive-and-recover');
    await act(async () => {
      first.reject(new TrainingError('training.unavailable', 'offline', true));
    });
    expect(textOf(renderer)).toContain('drive-and-recover');
    expect(textOf(renderer)).not.toContain('offline');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('switching to an analysis of ANOTHER family mid-flight shows that family, never the first', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    mockListCatalogDrills
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(DINK_DRILLS);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture({ id: 'analysis-2', shotType: 'dink' })}
          onOpenLibrary={jest.fn()}
        />,
      );
    });
    expect(mockListCatalogDrills.mock.calls[1]?.[0]).toEqual({
      family: 'dink',
    });
    expect(textOf(renderer)).toContain('dink-target-ladder');
    await act(async () => {
      first.resolve(DRIVE_DRILLS);
    });
    expect(textOf(renderer)).not.toContain('drive-and-recover');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('a response that resolves after UNMOUNT triggers no state update warning', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockReturnValueOnce(first.promise);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    await act(async () => {
      renderer.unmount();
    });
    await act(async () => {
      first.resolve(DRIVE_DRILLS);
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('switching to an analysis with NO scored fault mid-flight renders nothing even when the stale request resolves', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockReturnValueOnce(first.promise);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture({
            id: 'analysis-2',
            checkpoints: [checkpoint('ready_position', 85, 'green', 'none')],
            priorityFix: null,
          })}
          onOpenLibrary={jest.fn()}
        />,
      );
    });
    expect(renderer.toJSON()).toBeNull();
    await act(async () => {
      first.resolve(DRIVE_DRILLS);
    });
    expect(renderer.toJSON()).toBeNull();
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    await act(async () => {
      renderer.unmount();
    });
  });
});

describe('RecommendedDrills — bearer rotation', () => {
  // A bearer rotated mid-fetch does not invalidate the in-flight JWT, and
  // `reportApiUnauthorized` (apiSession.ts) already discards a 401 for a
  // bearer that is no longer current. What this component owes the user on
  // any 401 is the TrainingError copy plus a Retry that recovers — pinned
  // here (the original "must not show expired copy" premise was not backed
  // by the auth contract in AGENTS.md and was dropped).
  it('a 401 landing after a rotation renders the TrainingError copy with a Retry (recoverable, never a dead end)', async () => {
    mockGetApiSession.mockReturnValue(session);
    const first = deferred<CatalogDrill[]>();
    mockListCatalogDrills.mockReturnValueOnce(first.promise);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    // sessionKeeper rotates the bearer while the catalog call is in flight.
    mockGetApiSession.mockReturnValue({
      ...session,
      bearerToken: 'access-token-2',
    });
    await act(async () => {
      first.reject(
        new TrainingError(
          'training.session_expired',
          'Your sign-in expired. Sign in again to continue.',
          false,
          401,
        ),
      );
    });
    expect(textOf(renderer)).toContain('Your sign-in expired');
    const [retry] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drills-retry' &&
        typeof node.props.onPress === 'function',
    );
    expect(retry).toBeDefined();
    mockListCatalogDrills.mockResolvedValueOnce(DRIVE_DRILLS);
    await act(async () => {
      retry!.props.onPress();
    });
    expect(mockCreateTrainingApi.mock.calls[1]?.[0]).toMatchObject({
      token: 'access-token-2',
    });
    expect(textOf(renderer)).not.toContain('Your sign-in expired');
    await act(async () => {
      renderer.unmount();
    });
  });

  it('Retry after a rotation builds the client with the FRESH bearer, never the captured one', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills
      .mockRejectedValueOnce(
        new TrainingError('training.unavailable', 'offline', true),
      )
      .mockResolvedValueOnce(DRIVE_DRILLS);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(mockCreateTrainingApi.mock.calls[0]?.[0]).toMatchObject({
      token: 'access-token-1',
    });
    mockGetApiSession.mockReturnValue({
      ...session,
      bearerToken: 'access-token-2',
    });
    const [retry] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drills-retry' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      retry!.props.onPress();
    });
    expect(mockCreateTrainingApi.mock.calls[1]?.[0]).toMatchObject({
      token: 'access-token-2',
    });
    expect(textOf(renderer)).toContain('drive-and-recover');
    await act(async () => {
      renderer.unmount();
    });
  });
});
