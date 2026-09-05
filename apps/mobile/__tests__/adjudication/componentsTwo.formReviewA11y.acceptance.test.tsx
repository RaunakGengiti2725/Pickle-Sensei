/**
 * ADJUDICATION acceptance pins — stress area `components-2`, form review.
 *
 * Plain `it`s stating the INTENDED accessibility contract; RED on the
 * baseline 1fb0efd7 (independently reproduced from the tester's attack
 * branch `devin/stress-cmp-form-review-ui-boundary-i18n-a11y`, seeds
 * 2787387844 and 294218368):
 *
 *   C2-FR-1  the review timeline scrubber is the only way to move the
 *            playhead by touch, yet it is a role-less `View` with a 32pt
 *            responder band. It must expose `accessibilityRole="adjustable"`
 *            with increment/decrement actions and a ≥44pt declared target.
 *   C2-FR-2  the per-drill save/remove toggle in RecommendedDrills is a 34pt
 *            control (`minHeight: 34`, no hitSlop). Its declared target must
 *            reach 44pt.
 *
 * Text extents are not modelled here — only rendered-tree facts (roles,
 * actions, declared style boxes) that hold on every plane.
 */
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));
jest.mock('react-native-svg', () => {
  const ReactModule = require('react');
  const { View } = require('react-native');
  const Mock = (props: { children?: React.ReactNode }) =>
    ReactModule.createElement(View, null, props.children);
  return {
    __esModule: true,
    default: Mock,
    Svg: Mock,
    Circle: Mock,
    Defs: Mock,
    G: Mock,
    Line: Mock,
    Path: Mock,
    Polygon: Mock,
    Polyline: Mock,
    RadialGradient: Mock,
    LinearGradient: Mock,
    Rect: Mock,
    Stop: Mock,
  };
});
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => ({
    apiBaseUrl: 'https://api.example.test',
    bearerToken: 'token',
  }),
}));
const mockListCatalogDrills = jest.fn<Promise<unknown[]>, [unknown]>();
jest.mock('../../src/training/api', () => ({
  createTrainingApi: () => ({ listCatalogDrills: mockListCatalogDrills }),
}));

import React from 'react';
import { StyleSheet, type Insets } from 'react-native';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FormReviewPlayer } from '../../src/review/FormReviewPlayer';
import { RecommendedDrills } from '../../src/review/RecommendedDrills';
import { buildFormReviewScript } from '../../src/review/formReviewModel';
import type { CatalogDrill } from '../../src/training/api';

const MIN_TARGET_PT = 44;

function phase(
  key: PhaseKey,
  startMs: number,
  endMs: number,
  representativeMs = startMs + (endMs - startMs) / 2,
): PhaseSpan {
  return { key, startMs, representativeMs, endMs, confidence: 0.8 };
}
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

const analysis: ShotAnalysis = {
  id: 'analysis-1',
  sessionId: 'set-1',
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-09-01T10:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1900, endMs: 3200 },
  phases: [
    phase('ready', 0, 900),
    phase('prepare', 900, 1500),
    phase('accelerate', 1500, 1900),
    phase('contact', 1880, 1920, 1900),
    phase('follow_through', 1920, 2400),
    phase('recover', 2400, 3200),
  ],
  measurements: [],
  checkpoints: [
    checkpoint('ready_position', 85, 'green', 'none'),
    checkpoint('athletic_base', 72, 'yellow', 'narrow'),
    checkpoint('preparation', 88, 'green', 'none'),
    checkpoint('paddle_set', 90, 'green', 'none'),
    checkpoint('swing_length', null, 'unscored', 'none'),
    checkpoint('sequencing', 82, 'green', 'none'),
    checkpoint('paddle_path', 61, 'red', 'low'),
    checkpoint('contact_position', 48, 'red', 'late'),
    checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
      applicable: false,
    }),
    checkpoint('follow_through', 80, 'green', 'short'),
    checkpoint('recovery', 92, 'green', 'none'),
  ],
  overallScore: 7.1,
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
};

const drills: CatalogDrill[] = [
  {
    id: 'd-1',
    slug: 'contact-point-wall-drive',
    title: 'Contact point wall drive',
    description: 'Drive into the wall and freeze at contact.',
    coachName: 'Coach',
    equipment: ['paddle', 'ball', 'wall'],
    difficultyMin: null,
    difficultyMax: null,
    families: ['drive'],
    validationState: 'catalog',
    saved: false,
  },
  {
    id: 'd-2',
    slug: 'shadow-swing-ladder',
    title: 'Shadow swing ladder',
    description: 'Shadow the stroke at three speeds.',
    coachName: 'Coach',
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    families: ['global'],
    validationState: 'catalog',
    saved: true,
  },
];

function flattened(node: ReactTestInstance): Record<string, unknown> {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<
    string,
    unknown
  >;
}
function insetSum(hitSlop: unknown, a: keyof Insets, b: keyof Insets): number {
  if (typeof hitSlop === 'number') return hitSlop * 2;
  if (hitSlop && typeof hitSlop === 'object') {
    const insets = hitSlop as Insets;
    return (insets[a] ?? 0) + (insets[b] ?? 0);
  }
  return 0;
}
/** Declared vertical target: explicit height/minHeight plus vertical hitSlop. */
function declaredHeight(node: ReactTestInstance): number {
  const style = flattened(node);
  const height =
    typeof style['height'] === 'number'
      ? (style['height'] as number)
      : typeof style['minHeight'] === 'number'
        ? (style['minHeight'] as number)
        : 0;
  return height + insetSum(node.props.hitSlop, 'top', 'bottom');
}
/** Host (native) nodes carrying `testID` — the props the platform sees. */
function hostsByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  matches: (testID: string) => boolean,
): ReactTestInstance[] {
  return renderer.root.findAll(
    n =>
      typeof n.type === 'string' &&
      typeof n.props.testID === 'string' &&
      matches(n.props.testID as string),
  );
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('components-2 adjudication: form review a11y acceptance (RED on 1fb0efd7)', () => {
  it('C2-FR-1: the review timeline is an adjustable control with increment/decrement actions and a ≥44pt declared target', async () => {
    const script = buildFormReviewScript(analysis, null);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <FormReviewPlayer
          analysis={analysis}
          clip={null}
          review={null}
          sequence={null}
          script={script}
          stageHeight={480}
        />,
      );
    });
    const timelines = hostsByTestId(
      renderer,
      id => id === 'form-review-timeline',
    );
    expect(timelines).toHaveLength(1);
    const timeline = timelines[0]!;
    expect(timeline.props.accessible).toBe(true);
    expect(timeline.props.accessibilityRole).toBe('adjustable');
    const actionNames = (
      (timeline.props.accessibilityActions ?? []) as Array<{ name: string }>
    ).map(a => a.name);
    expect(actionNames).toEqual(
      expect.arrayContaining(['increment', 'decrement']),
    );
    expect(typeof timeline.props.onAccessibilityAction).toBe('function');
    expect(declaredHeight(timeline)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    act(() => renderer.unmount());
  });

  it('C2-FR-2: every RecommendedDrills save/remove toggle declares a ≥44pt vertical target', async () => {
    mockListCatalogDrills.mockResolvedValue(drills);
    const saved = new Set(['shadow-swing-ladder']);
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <RecommendedDrills
          analysis={analysis}
          onOpenLibrary={() => {}}
          onToggleSaved={() => {}}
          isSaved={drill => saved.has(drill.slug)}
        />,
      );
    });
    await flush();
    const toggles = hostsByTestId(renderer, id =>
      /^recommended-drill-.+-save$/.test(id),
    );
    expect(toggles.length).toBe(drills.length);
    for (const toggle of toggles) {
      expect(toggle.props.accessibilityRole).toBe('button');
      expect(declaredHeight(toggle)).toBeGreaterThanOrEqual(MIN_TARGET_PT);
    }
    act(() => renderer.unmount());
  });
});
