import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
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
  RECOMMENDED_DRILLS_HIDE_STEPS_LABEL,
  RECOMMENDED_DRILLS_SIGN_IN_COPY,
  RECOMMENDED_DRILLS_STEPS_LABEL,
  RecommendedDrills,
} from '../src/review/RecommendedDrills';
import {
  DRILL_MATCH_NOTE,
  drillFocusFromAnalysis,
  pickRecommendedDrills,
} from '../src/review/recommendedDrillsModel';
import {
  equipmentLine,
  parseDrillDescription,
} from '../src/training/drillDescription';

/**
 * RecommendedDrills — catalog drills matched by the stroke family of one
 * scored analysis' worst measured fault, one card each. The catalog is
 * fetched once per analysis id, every state is a quiet card, the match basis
 * is stated, and nothing renders when the analysis carries no scored fault.
 * The catalog description's structure (purpose · numbered steps · dose) is
 * parsed so the dose shows on the card and the steps open on tap — none of
 * it is clamped away.
 */

/** The exact shape the edge function's `describe()` serves. */
const STRUCTURED_DESCRIPTION =
  'Build an early shoulder-hip unit turn on drives through mirror-checked shadow swings, then live feeds.\n\n' +
  '1. Without a ball, rehearse the drive: turn shoulders and hips together as the split-step lands.\n' +
  '2. Check in a mirror or phone video that the chest faces the sideline before the forward swing.\n' +
  "3. Progress to dropped-ball feeds, calling 'turn' at the feeder's release.\n\n" +
  'Dose: 3 × 10 shadow swings + 2 × 10 fed balls.';

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

describe('drillDescription', () => {
  it('splits the catalog description into purpose, numbered steps and the dose', () => {
    expect(parseDrillDescription(STRUCTURED_DESCRIPTION)).toEqual({
      purpose:
        'Build an early shoulder-hip unit turn on drives through mirror-checked shadow swings, then live feeds.',
      steps: [
        'Without a ball, rehearse the drive: turn shoulders and hips together as the split-step lands.',
        'Check in a mirror or phone video that the chest faces the sideline before the forward swing.',
        "Progress to dropped-ball feeds, calling 'turn' at the feeder's release.",
      ],
      dose: '3 × 10 shadow swings + 2 × 10 fed balls',
    });
    // Tolerant of CRLF, "1)" numbering, extra blank lines and a dose with
    // no trailing period.
    expect(
      parseDrillDescription(
        'Why.\r\n\r\n1) First\r\n2) Second\r\n\r\nDose: 4 × 45 s',
      ),
    ).toEqual({
      purpose: 'Why.',
      steps: ['First', 'Second'],
      dose: '4 × 45 s',
    });
  });

  it('an unstructured description is the purpose alone — no steps, no dose invented', () => {
    expect(parseDrillDescription('Description for drive-and-recover.')).toEqual(
      {
        purpose: 'Description for drive-and-recover.',
        steps: [],
        dose: null,
      },
    );
    expect(parseDrillDescription('')).toEqual({
      purpose: '',
      steps: [],
      dose: null,
    });
  });

  it('equipmentLine capitalises and joins; empty lists yield null', () => {
    expect(
      equipmentLine([
        'paddle',
        ' mirror or phone camera',
        'balls (for the fed stage)',
      ]),
    ).toBe('Paddle · Mirror or phone camera · Balls (for the fed stage)');
    expect(equipmentLine([])).toBeNull();
    expect(equipmentLine(['  '])).toBeNull();
  });
});

describe('RecommendedDrills', () => {
  it('keeps saved-drill controls at least 44 points and blocks pending presses', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockResolvedValue(MIXED_DRILLS);
    const onToggleSaved = jest.fn();
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
        onToggleSaved={onToggleSaved}
        pendingSlug="drive-and-recover"
      />,
    );
    const [pending] = hostByTestId(
      renderer,
      'recommended-drill-drive-and-recover-save',
    );
    expect(pending).toBeDefined();
    expect(
      StyleSheet.flatten(pending!.props.style).minHeight,
    ).toBeGreaterThanOrEqual(44);
    expect(pending!.props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      pending!.props.onClick({
        currentTarget: pending,
        target: pending,
        nativeEvent: {},
      });
    });
    expect(onToggleSaved).not.toHaveBeenCalled();
    await unmount(renderer);
  });

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
    expect(rendered).toContain('Drive And Recover');
    expect(rendered).toContain('Description for drive-and-recover.');
    // The page title names the section and the catalog byline is the same
    // on every drill — neither is repeated per card.
    expect(rendered).not.toContain('Drills for this stroke');
    expect(rendered).not.toContain('PICKLE SENSEI TRAINING LIBRARY');
    expect(rendered).not.toContain('Dink Target Ladder');
    expect(rendered).not.toContain('Footwork Split Step');
    expect(rendered).toContain(DRILL_MATCH_NOTE);
    // An unstructured description has no steps to open and no dose to show.
    expect(
      hostByTestId(renderer, 'recommended-drill-drive-and-recover-dose'),
    ).toHaveLength(0);
    expect(
      renderer.root.findAll(
        node =>
          node.props.testID === 'recommended-drill-drive-and-recover-steps',
      ),
    ).toHaveLength(0);

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

  it('a structured description shows its dose on the card and opens its numbered steps + equipment on tap', async () => {
    mockGetApiSession.mockReturnValue(session);
    mockListCatalogDrills.mockResolvedValue([
      drill('shadow-unit-turn', ['drive'], {
        title: 'Shadow swing: unit turn ladder',
        description: STRUCTURED_DESCRIPTION,
        equipment: [
          'paddle',
          'mirror or phone camera',
          'balls (for the fed stage)',
        ],
        difficultyMin: 'beginner',
        difficultyMax: 'beginner',
      }),
    ]);
    const renderer = await render(
      <RecommendedDrills
        analysis={analysisFixture()}
        onOpenLibrary={jest.fn()}
        dark
      />,
    );
    let rendered = textOf(renderer);
    // Collapsed: title, purpose, dose and difficulty — the steps stay closed.
    expect(rendered).toContain('Shadow swing: unit turn ladder');
    expect(rendered).toContain(
      'Build an early shoulder-hip unit turn on drives through mirror-checked shadow swings, then live feeds.',
    );
    expect(rendered).toContain('3 × 10 shadow swings + 2 × 10 fed balls');
    expect(rendered).not.toContain('Dose:');
    expect(rendered).toContain('BEGINNER');
    expect(rendered).not.toContain('Without a ball, rehearse the drive');
    expect(rendered).not.toContain('Mirror or phone camera');
    expect(
      hostByTestId(renderer, 'recommended-drill-shadow-unit-turn-steps-list'),
    ).toHaveLength(0);

    const [toggle] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drill-shadow-unit-turn-steps' &&
        typeof node.props.onPress === 'function',
    );
    expect(toggle).toBeDefined();
    expect(toggle!.props.accessibilityLabel).toBe(
      'Show steps for Shadow swing: unit turn ladder',
    );
    expect(toggle!.props.accessibilityState).toMatchObject({ expanded: false });
    expect(rendered).toContain(RECOMMENDED_DRILLS_STEPS_LABEL);
    expect(
      StyleSheet.flatten(
        hostByTestId(renderer, 'recommended-drill-shadow-unit-turn-steps')[0]!
          .props.style,
      ).minHeight,
    ).toBeGreaterThanOrEqual(44);

    await act(async () => {
      toggle!.props.onPress();
    });
    rendered = textOf(renderer);
    expect(
      hostByTestId(renderer, 'recommended-drill-shadow-unit-turn-steps-list'),
    ).toHaveLength(1);
    expect(rendered).toContain('Without a ball, rehearse the drive');
    expect(rendered).toContain(
      "Progress to dropped-ball feeds, calling 'turn' at the feeder's release.",
    );
    expect(rendered).toContain(
      'Paddle · Mirror or phone camera · Balls (for the fed stage)',
    );
    expect(rendered).toContain(RECOMMENDED_DRILLS_HIDE_STEPS_LABEL);
    const [open] = renderer.root.findAll(
      node =>
        node.props.testID === 'recommended-drill-shadow-unit-turn-steps' &&
        typeof node.props.onPress === 'function',
    );
    expect(open!.props.accessibilityLabel).toBe(
      'Hide steps for Shadow swing: unit turn ladder',
    );
    expect(open!.props.accessibilityState).toMatchObject({ expanded: true });

    await act(async () => {
      open!.props.onPress();
    });
    expect(
      hostByTestId(renderer, 'recommended-drill-shadow-unit-turn-steps-list'),
    ).toHaveLength(0);
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
