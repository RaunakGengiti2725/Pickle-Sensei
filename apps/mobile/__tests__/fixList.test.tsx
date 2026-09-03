import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  ScoreBand,
  ShotAnalysis,
} from '@pickle/shared-types';
import { FixList } from '../src/review/FixList';
import { coachingCue } from '../src/review/formReviewModel';

/**
 * FixList — the up-to-three worst measured checkpoints of a scored analysis,
 * engine priority first, each with its real score, the measured-direction
 * headline and the matching coaching cue. A clean stroke renders nothing.
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

/** Four faults so the limit of three is exercised (athletic_base, 72, is
 * the one left out). Sequencing has the LOWEST score, so the engine's
 * priorityFix (contact_position, 48) leading the list proves the priority
 * promotion rather than plain worst-first ordering. */
const CHECKPOINTS_FIXTURE: CheckpointScore[] = [
  checkpoint('ready_position', 85, 'green', 'none'),
  checkpoint('athletic_base', 72, 'yellow', 'narrow'),
  checkpoint('preparation', 88, 'green', 'none'),
  checkpoint('paddle_set', 90, 'green', 'none'),
  checkpoint('swing_length', null, 'unscored', 'none'),
  checkpoint('sequencing', 40, 'red', 'short'),
  checkpoint('paddle_path', 61, 'red', 'low'),
  checkpoint('contact_position', 48, 'red', 'late'),
  checkpoint('face_wrist_stability', 30, 'red', 'unstable', {
    applicable: false,
  }),
  checkpoint('follow_through', 80, 'green', 'none'),
  checkpoint('recovery', 92, 'green', 'none'),
];

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
    checkpoints: CHECKPOINTS_FIXTURE.map(cp => ({ ...cp })),
    overallScore: 6.8,
    analysisConfidence: 0.84,
    resultKind: 'scored',
    guidance: null,
    priorityFix: {
      checkpoint: 'contact_position',
      reasonKey: 'dependency',
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

function textsWithin(node: TestRenderer.ReactTestInstance): string {
  return node
    .findAllByType(Text)
    .map(text => {
      const children = text.props.children;
      return Array.isArray(children) ? children.join('') : String(children);
    })
    .join(' | ');
}

describe('FixList', () => {
  it('renders the three worst measured checkpoints, engine priority first, with real scores and matching cues', async () => {
    const renderer = await render(<FixList analysis={analysisFixture()} />);
    expect(hostByTestId(renderer, 'fix-list')).toHaveLength(1);

    const items = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        typeof node.props.testID === 'string' &&
        /^fix-item-[a-z_]+$/.test(node.props.testID),
    );
    // Priority first (contact_position, 48), then worst-first: sequencing
    // (40), paddle_path (61). athletic_base (72) falls outside the limit;
    // the inapplicable face_wrist_stability never appears.
    expect(items.map(node => node.props.testID)).toEqual([
      'fix-item-contact_position',
      'fix-item-sequencing',
      'fix-item-paddle_path',
    ]);
    const rendered = textOf(renderer);
    expect(rendered).not.toContain('fix-item-athletic_base');
    expect(rendered).not.toContain('Face / wrist stability');

    // Header: n of the APPLICABLE SCORED count (9 here: 11 keys minus the
    // unscored swing_length and the inapplicable face_wrist_stability).
    expect(rendered).toContain('What to fix');
    expect(rendered).toContain('3');
    expect(rendered).toContain('9');
    expect(rendered).toContain('checkpoints');

    const first = textsWithin(items[0]!);
    expect(first).toContain('01');
    expect(first).toContain('Contact position');
    expect(first).toContain('48');
    expect(first).toContain('PRIORITY');
    expect(first).toContain('Contact position scored 48 — contact came late');
    expect(first).toContain('COACHING CUE');
    expect(first).toContain(
      coachingCue('contact_position', 'late', 'forehand_drive'),
    );

    const second = textsWithin(items[1]!);
    expect(second).toContain('02');
    expect(second).toContain('Sequencing scored 40 — was short');
    expect(second).not.toContain('PRIORITY');
    expect(second).toContain(
      coachingCue('sequencing', 'short', 'forehand_drive'),
    );

    const third = textsWithin(items[2]!);
    expect(third).toContain('03');
    expect(third).toContain('Paddle path scored 61 — sat low');

    // Strengths: the two best green checkpoints with their scores.
    expect(hostByTestId(renderer, 'fix-list-keep')).toHaveLength(1);
    expect(rendered).toContain('Keep doing:');
    expect(rendered).toContain('Recovery (92), Paddle set (90)');

    // Without onOpenInReview there is no review row.
    expect(rendered).not.toContain('See it in your form review');
    await unmount(renderer);
  });

  it('renders nothing for a clean stroke — no fix is invented', async () => {
    const clean = analysisFixture({
      checkpoints: [
        checkpoint('ready_position', 85, 'green', 'none'),
        checkpoint('contact_position', 91, 'green', 'none'),
      ],
      priorityFix: null,
    });
    const renderer = await render(<FixList analysis={clean} />);
    expect(renderer.toJSON()).toBeNull();
    await unmount(renderer);

    const unscored = analysisFixture({ checkpoints: [], priorityFix: null });
    const empty = await render(<FixList analysis={unscored} />);
    expect(empty.toJSON()).toBeNull();
    await unmount(empty);
  });

  it('onOpenInReview receives the phase the checkpoint is measured in', async () => {
    const onOpenInReview = jest.fn();
    const renderer = await render(
      <FixList analysis={analysisFixture()} onOpenInReview={onOpenInReview} />,
    );
    expect(textOf(renderer)).toContain('See it in your form review');
    const [contactRow] = renderer.root.findAll(
      node =>
        node.props.testID === 'fix-item-contact_position-review' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      contactRow!.props.onPress();
    });
    expect(onOpenInReview).toHaveBeenCalledWith('contact');

    const [sequencingRow] = renderer.root.findAll(
      node =>
        node.props.testID === 'fix-item-sequencing-review' &&
        typeof node.props.onPress === 'function',
    );
    await act(async () => {
      sequencingRow!.props.onPress();
    });
    expect(onOpenInReview).toHaveBeenLastCalledWith('accelerate');
    await unmount(renderer);
  });

  it('a single fault shows "1 of n" and no strengths card when nothing is green', async () => {
    const renderer = await render(
      <FixList
        analysis={analysisFixture({
          checkpoints: [
            checkpoint('paddle_path', 55, 'red', 'high'),
            checkpoint('swing_length', null, 'unscored', 'none'),
          ],
          priorityFix: null,
        })}
      />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('fix-item-paddle_path');
    expect(rendered).toContain('"1"');
    expect(rendered).toContain('Paddle path scored 55 — sat high');
    expect(rendered).not.toContain('PRIORITY');
    expect(hostByTestId(renderer, 'fix-list-keep')).toHaveLength(0);
    await unmount(renderer);
  });
});
