/**
 * ADVERSARIAL PASS 3 — RecommendedDrills × session material.
 *
 * S1: getApiSession() returns a WHITESPACE bearer token → the card must be
 *     the quiet sign-in caption and the training API must never be built or
 *     called (a blank bearer is a signed-out device, not a request).
 * S7: the catalog rejects with `training.unauthorized` → quiet caption +
 *     Retry, and Retry re-reads getApiSession() so a ROTATED token is used
 *     on the second request (never the captured, rejected one).
 * Extras: every JS-whitespace flavour of blank token, a session that goes
 *     away between the failure and Retry, rapid Retry hammering, and the
 *     stale-response guard when Retry outruns the first request.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import type { CatalogDrill } from '../src/training/api';
import { TrainingError } from '../src/training/types';

const mockGetApiSession = jest.fn();
jest.mock('../src/account/apiSession', () => ({
  getApiSession: () => mockGetApiSession(),
}));

const mockListCatalogDrills = jest.fn();
const mockCreateTrainingApi = jest.fn();
jest.mock('../src/training/api', () => ({
  createTrainingApi: (config: unknown) => {
    mockCreateTrainingApi(config);
    return { listCatalogDrills: mockListCatalogDrills };
  },
}));

import {
  RECOMMENDED_DRILLS_SIGN_IN_COPY,
  RecommendedDrills,
} from '../src/review/RecommendedDrills';

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
    equipment: [],
    difficultyMin: null,
    difficultyMax: null,
    families,
    validationState: 'UNVALIDATED',
    saved: false,
  };
}

const CATALOG = [drill('drive-and-recover', ['drive'])];

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token-v1',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

const mounted: TestRenderer.ReactTestRenderer[] = [];

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  mounted.push(renderer);
  return renderer;
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function pressable(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const [node] = renderer.root.findAll(
    candidate =>
      candidate.props.testID === testID &&
      typeof candidate.props.onPress === 'function',
  );
  return node;
}

async function pressRetry(renderer: TestRenderer.ReactTestRenderer) {
  const retry = pressable(renderer, 'recommended-drills-retry');
  expect(retry).toBeDefined();
  await act(async () => {
    retry!.props.onPress();
  });
}

let fetchSpy: jest.SpyInstance | undefined;

beforeEach(() => {
  mockGetApiSession.mockReset();
  mockListCatalogDrills.mockReset();
  mockCreateTrainingApi.mockReset();
  // Belt and braces: if anything reached the real network layer it would
  // show up here even though the training api module itself is mocked.
  fetchSpy = jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(new Error('network must not be reached'));
});

afterEach(async () => {
  for (const renderer of mounted.splice(0)) {
    await act(async () => {
      renderer.unmount();
    });
  }
  fetchSpy?.mockRestore();
});

// ─── S1 — whitespace bearer token ───────────────────────────────────────────

describe('S1 — whitespace bearer token', () => {
  const BLANK_TOKENS: Array<[string, string]> = [
    ['spaces', '   '],
    ['tab+newline', '\t\n'],
    ['CRLF', '\r\n'],
    ['NBSP', '\u00a0'],
    ['BOM', '\ufeff'],
    ['ideographic space', '\u3000'],
    ['en/em spaces', '\u2002\u2003'],
    ['line/paragraph separators', '\u2028\u2029'],
  ];

  it.each(BLANK_TOKENS)(
    'bearerToken=%s → sign-in caption, createTrainingApi/fetch never called',
    async (_label, bearerToken) => {
      mockGetApiSession.mockReturnValue({ ...session, bearerToken });
      const renderer = await render(
        <RecommendedDrills
          analysis={analysisFixture()}
          onOpenLibrary={jest.fn()}
        />,
      );
      expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
      expect(textOf(renderer)).not.toContain('Finding drills');
      expect(mockCreateTrainingApi).not.toHaveBeenCalled();
      expect(mockListCatalogDrills).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      // No Retry on the signed-out card: nothing was attempted.
      expect(pressable(renderer, 'recommended-drills-retry')).toBeUndefined();
    },
  );

  it('whitespace base URL with a real token is equally signed-out', async () => {
    mockGetApiSession.mockReturnValue({ ...session, apiBaseUrl: ' \n ' });
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
    expect(mockCreateTrainingApi).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a token with surrounding whitespace is passed TRIMMED, exactly once', async () => {
    mockGetApiSession.mockReturnValue({
      ...session,
      bearerToken: '  access-token-v1\n',
      apiBaseUrl: ' https://api.example.test/ ',
    });
    mockListCatalogDrills.mockResolvedValue(CATALOG);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(mockCreateTrainingApi).toHaveBeenCalledTimes(1);
    expect(mockCreateTrainingApi).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.test/',
      token: 'access-token-v1',
    });
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
  });

  it('a session that is a non-object (corrupt store) is treated as signed-out, never thrown', async () => {
    for (const corrupt of [undefined, 0, '', 'token', [] as unknown]) {
      mockGetApiSession.mockReturnValue(corrupt);
      const renderer = await render(
        <RecommendedDrills
          analysis={analysisFixture()}
          onOpenLibrary={jest.fn()}
        />,
      );
      expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
    }
    expect(mockCreateTrainingApi).not.toHaveBeenCalled();
  });
});

// ─── S7 — training.unauthorized → Retry re-reads the session ────────────────

describe('S7 — catalog rejects with training.unauthorized', () => {
  const unauthorized = () =>
    new TrainingError(
      'training.unauthorized',
      'Your sign-in expired. Sign in again to continue.',
      false,
      401,
    );

  it('renders the quiet caption + Retry, and Retry uses the ROTATED token', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValueOnce(CATALOG);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    const copy = textOf(renderer);
    expect(copy).toContain('Your sign-in expired. Sign in again to continue.');
    expect(copy).not.toContain('Drills for this stroke');
    expect(mockCreateTrainingApi).toHaveBeenCalledTimes(1);
    expect(mockCreateTrainingApi).toHaveBeenLastCalledWith({
      baseUrl: session.apiBaseUrl,
      token: 'access-token-v1',
    });

    // The session keeper rotated the bearer while the card sat in error.
    mockGetApiSession.mockReturnValue({
      ...session,
      bearerToken: 'access-token-v2',
    });
    await pressRetry(renderer);

    expect(mockGetApiSession.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mockCreateTrainingApi).toHaveBeenCalledTimes(2);
    expect(mockCreateTrainingApi).toHaveBeenLastCalledWith({
      baseUrl: session.apiBaseUrl,
      token: 'access-token-v2',
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
    expect(textOf(renderer)).not.toContain('Your sign-in expired');
  });

  it('Retry after the session was cleared shows the sign-in caption and does NOT reuse the rejected token', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockRejectedValue(unauthorized());
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain('Your sign-in expired');

    mockGetApiSession.mockReturnValue(null);
    await pressRetry(renderer);
    expect(mockCreateTrainingApi).toHaveBeenCalledTimes(1);
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
    expect(pressable(renderer, 'recommended-drills-retry')).toBeUndefined();
  });

  it('a blank TrainingError message falls back to the generic quiet line, never an empty card', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockRejectedValue(
      new TrainingError('training.unauthorized', '   ', false, 401),
    );
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain(
      'Drills for this stroke couldn’t be loaded right now.',
    );
  });

  it('rapid Retry ×20: one request per press, the LAST response wins, no stale error resurfaces', async () => {
    mockGetApiSession.mockReturnValue(session);
    const resolvers: Array<{
      resolve: (drills: CatalogDrill[]) => void;
      reject: (error: unknown) => void;
    }> = [];
    mockListCatalogDrills.mockImplementation(
      () =>
        new Promise<CatalogDrill[]>((resolve, reject) => {
          resolvers.push({ resolve, reject });
        }),
    );
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    // First request fails → error card with Retry.
    await act(async () => {
      resolvers[0]!.reject(unauthorized());
    });
    expect(textOf(renderer)).toContain('Your sign-in expired');

    // Hammer the SAME Retry handler 20× in one burst (a finger drumming the
    // button before React re-renders it away). The card must issue at most
    // one new request per render of the error card — not 20 — and the
    // loading card (no Retry) must replace it.
    const retry = pressable(renderer, 'recommended-drills-retry')!;
    await act(async () => {
      for (let i = 0; i < 20; i += 1) retry.props.onPress();
    });
    const issued = mockListCatalogDrills.mock.calls.length;
    expect(issued).toBe(2);
    expect(textOf(renderer)).toContain('Finding drills');
    expect(pressable(renderer, 'recommended-drills-retry')).toBeUndefined();

    await act(async () => {
      resolvers[1]!.resolve(CATALOG);
    });
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
  });

  it('out-of-order settle: the analysis changes while request #1 is pending; #1 settling LAST never overwrites #2', async () => {
    mockGetApiSession.mockReturnValue(session);
    const pending: Array<{
      resolve: (drills: CatalogDrill[]) => void;
      reject: (error: unknown) => void;
    }> = [];
    mockListCatalogDrills.mockImplementation(
      () =>
        new Promise<CatalogDrill[]>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const onOpenLibrary = jest.fn();
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={onOpenLibrary}
      />,
    );
    expect(textOf(renderer)).toContain('Finding drills');
    expect(pending).toHaveLength(1);

    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture({ id: 'analysis-2' })}
          onOpenLibrary={onOpenLibrary}
        />,
      );
    });
    expect(pending).toHaveLength(2);

    // #2 lands first with the real catalog …
    await act(async () => {
      pending[1]!.resolve(CATALOG);
    });
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');

    // … then #1 (the STALE analysis) settles: as an error, and again as a
    // bogus catalog — neither may touch the card.
    await act(async () => {
      pending[0]!.reject(unauthorized());
    });
    expect(textOf(renderer)).not.toContain('Your sign-in expired');
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
  });
});
