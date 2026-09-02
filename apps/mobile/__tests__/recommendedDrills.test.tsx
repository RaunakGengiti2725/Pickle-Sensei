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
import {
  DRILL_MATCH_NOTE,
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../src/review/recommendedDrillsModel';

/**
 * RecommendedDrills — catalog drills matched by the stroke family of one
 * scored analysis' worst measured fault. The catalog is fetched once per
 * analysis id, every state is a quiet card, the match basis is stated, and
 * nothing renders when the analysis carries no scored fault.
 */

function checkpoint(
  key: CheckpointKey,
  score: number | null,
  band: ScoreBand,
  direction: FaultDirection,
  overrides: Partial<CheckpointScore> = {},
): CheckpointScore {
  return {
    key,
    score,
    confidence: 0.8,
    band,
    direction,
    severity: score === null ? 0 : (100 - score) / 100,
    applicable: true,
    ...overrides,
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
      checkpoint('follow_through', 80, 'green', 'none'),
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

function drill(
  slug: string,
  families: string[],
  overrides: Partial<CatalogDrill> = {},
): CatalogDrill {
  return {
    id: `id-${slug}`,
    slug,
    title: slug
      .split('-')
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' '),
    description: `Description for ${slug}.`,
    coachName: 'Pickle Sensei Training Library',
    equipment: ['paddle', 'balls'],
    difficultyMin: null,
    difficultyMax: null,
    families,
    validationState: 'UNVALIDATED',
    saved: false,
    ...overrides,
  };
}

/** Five drills of mixed families, deliberately interleaved so family-first
 * ordering is visible: drive drills first (catalog order), global as fill. */
const MIXED_DRILLS: CatalogDrill[] = [
  drill('shadow-swing-ladder', ['global']),
  drill('drive-and-recover', ['drive']),
  drill('dink-target-ladder', ['dink']),
  drill('crosscourt-drive-rally', ['drive', 'volley']),
  drill('footwork-split-step', ['global']),
];

const session = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token',
  canonicalAppUserId: '00000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function unmount(renderer: TestRenderer.ReactTestRenderer) {
  await act(async () => {
    renderer.unmount();
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function hostByTestId(renderer: TestRenderer.ReactTestRenderer, id: string) {
  return renderer.root.findAll(
    node => typeof node.type === 'string' && node.props.testID === id,
  );
}

beforeEach(() => {
  mockGetApiSession.mockReset();
  mockListCatalogDrills.mockReset();
  mockCreateTrainingApi.mockReset();
});

describe('recommendedDrillsModel', () => {
  it('drillFocusFromAnalysis is the worst measured fault (engine priority first), one sample, family from the shot type', () => {
    expect(drillFocusFromAnalysis(analysisFixture())).toEqual({
      shotType: 'forehand_drive',
      checkpoint: 'contact_position',
      averageScore: 48,
      sampleCount: 1,
      family: 'drive',
    });
    expect(
      drillFocusFromAnalysis(
        analysisFixture({ shotType: 'third_shot_drop', priorityFix: null }),
      ),
    ).toEqual({
      shotType: 'third_shot_drop',
      checkpoint: 'contact_position',
      averageScore: 48,
      sampleCount: 1,
      family: 'drop_reset',
    });
    expect(
      drillFocusFromAnalysis(analysisFixture({ shotType: 'overhead' }))?.family,
    ).toBe('global');
  });

  it('no scored fault → no focus (nothing is recommended for a clean or unscored read)', () => {
    expect(
      drillFocusFromAnalysis(
        analysisFixture({
          checkpoints: [checkpoint('ready_position', 85, 'green', 'none')],
          priorityFix: null,
        }),
      ),
    ).toBeNull();
    expect(
      drillFocusFromAnalysis(
        analysisFixture({ checkpoints: [], priorityFix: null }),
      ),
    ).toBeNull();
    // A priorityFix pointing at an unscored checkpoint is not a scored fault.
    expect(
      drillFocusFromAnalysis(
        analysisFixture({
          checkpoints: [
            checkpoint('contact_position', null, 'unscored', 'none'),
          ],
        }),
      ),
    ).toBeNull();
  });

  it('the engine’s priorityFix stands in when it is scored but not below green', () => {
    expect(
      drillFocusFromAnalysis(
        analysisFixture({
          checkpoints: [
            checkpoint('contact_position', 81, 'green', 'none'),
            checkpoint('ready_position', 85, 'green', 'none'),
          ],
        }),
      ),
    ).toEqual({
      shotType: 'forehand_drive',
      checkpoint: 'contact_position',
      averageScore: 81,
      sampleCount: 1,
      family: 'drive',
    });
  });

  it('pickRecommendedDrills is family-first with whole-game fill, capped at the limit', () => {
    const focus = drillFocusFromAnalysis(analysisFixture())!;
    expect(
      pickRecommendedDrills(MIXED_DRILLS, focus).map(item => item.slug),
    ).toEqual([
      'drive-and-recover',
      'crosscourt-drive-rally',
      'shadow-swing-ladder',
    ]);
    expect(pickRecommendedDrills(MIXED_DRILLS, focus, 1)).toHaveLength(1);
    expect(DRILL_MATCH_NOTE).toContain('not yet coach-validated');
  });
});

describe('RecommendedDrills', () => {
  it('fetches the focus family once, renders three drills family-first with the match note and library button', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockResolvedValue(MIXED_DRILLS);
    const onOpenLibrary = jest.fn();
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={onOpenLibrary}
      />,
    );

    expect(mockCreateTrainingApi).toHaveBeenCalledTimes(1);
    expect(mockCreateTrainingApi).toHaveBeenCalledWith({
      baseUrl: session.apiBaseUrl,
      token: session.bearerToken,
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    expect(mockListCatalogDrills).toHaveBeenCalledWith({ family: 'drive' });

    expect(hostByTestId(renderer, 'recommended-drills')).toHaveLength(1);
    const rows = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        node.props.testID.startsWith('recommended-drill-'),
    );
    expect(rows.map(node => node.props.testID)).toEqual([
      'recommended-drill-drive-and-recover',
      'recommended-drill-crosscourt-drive-rally',
      'recommended-drill-shadow-swing-ladder',
    ]);
    const rendered = textOf(renderer);
    expect(rendered).toContain('Drills for this stroke');
    expect(rendered).toContain('Drive And Recover');
    expect(rendered).toContain('Description for drive-and-recover.');
    expect(rendered).toContain('PICKLE SENSEI TRAINING LIBRARY');
    expect(rendered).not.toContain('Dink Target Ladder');
    expect(rendered).not.toContain('Footwork Split Step');
    expect(rendered).toContain(DRILL_MATCH_NOTE);

    const [open] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drills-open-library' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      open!.props.onPress();
    });
    expect(onOpenLibrary).toHaveBeenCalledTimes(1);

    // A re-render with a new analysis object of the SAME id never refetches.
    await act(async () => {
      renderer.update(
        <RecommendedDrills
          analysis={analysisFixture()}
          onOpenLibrary={onOpenLibrary}
        />,
      );
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(1);
    await unmount(renderer);
  });

  it('a rejected catalog request renders a quiet caption with Retry, and Retry refetches', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills
      .mockRejectedValueOnce(
        new TrainingError(
          'training.unavailable',
          'Training is temporarily offline. Your existing reads are still safe.',
          true,
        ),
      )
      .mockResolvedValueOnce(MIXED_DRILLS);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain('Training is temporarily offline.');
    expect(textOf(renderer)).not.toContain('recommended-drill-drive');
    const [retry] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drills-retry' &&
        typeof node.props.onPress === 'function',
    );
    expect(retry).toBeDefined();
    await act(async () => {
      retry!.props.onPress();
    });
    expect(mockListCatalogDrills).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).toContain('recommended-drill-drive-and-recover');
    await unmount(renderer);
  });

  it('a non-training failure reads as the generic quiet line — never a thrown error', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockRejectedValue(new Error('boom'));
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain(
      'Drills for this stroke couldn’t be loaded right now.',
    );
    expect(textOf(renderer)).not.toContain('boom');
    await unmount(renderer);
  });

  it('with no session (or no base URL) shows the sign-in caption and never calls the API', async () => {
    mockGetApiSession.mockReturnValue(null);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(renderer)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
    expect(textOf(renderer)).toContain(
      'Sign in to see drills matched to this stroke.',
    );
    expect(mockCreateTrainingApi).not.toHaveBeenCalled();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    await unmount(renderer);

    mockGetApiSession.mockReturnValue({ ...session, apiBaseUrl: '' });
    const noBase = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(textOf(noBase)).toContain(RECOMMENDED_DRILLS_SIGN_IN_COPY);
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    await unmount(noBase);
  });

  it('renders nothing (and fetches nothing) when the analysis carries no scored fault', async () => {
    mockGetApiSession.mockReturnValue(session);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture({
          checkpoints: [checkpoint('ready_position', 85, 'green', 'none')],
          priorityFix: null,
        })}
        onOpenLibrary={jest.fn()}
      />,
    );
    expect(renderer.toJSON()).toBeNull();
    expect(mockListCatalogDrills).not.toHaveBeenCalled();
    await unmount(renderer);
  });
});
