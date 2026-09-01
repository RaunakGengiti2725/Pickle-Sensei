import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PlanDrillCard } from '../../src/training/components';
import type { TrainingPlanItem } from '../../src/training/types';

/**
 * A plan item without a prescription target has nothing to log: the card
 * must not render a completion button that can never fire, nor copy that
 * tells the user to tap it.
 */

function item(overrides: Partial<TrainingPlanItem> = {}): TrainingPlanItem {
  return {
    id: 'item-1',
    position: 1,
    kind: 'targeted',
    drill: {
      slug: 'shadow-swings',
      title: 'Shadow swings',
      description: 'Swing without a ball.',
      coachName: 'Coach',
      equipment: [],
      saved: false,
    },
    cueText: null,
    targetSets: 3,
    targetRepetitionsPerSet: 10,
    targetDurationSeconds: null,
    restSeconds: null,
    completion: null,
    ...overrides,
  };
}

function render(planItem: TrainingPlanItem) {
  const onConfirmComplete = jest.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PlanDrillCard
        item={planItem}
        busy={false}
        onToggleSaved={jest.fn()}
        onConfirmComplete={onConfirmComplete}
        onOpenMedia={jest.fn()}
      />,
    );
  });
  return { renderer, onConfirmComplete };
}

function completionButtons(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.props.accessibilityLabel === 'string' &&
      node.props.accessibilityLabel.startsWith('Confirm completion of') &&
      typeof node.props.onPress === 'function',
  );
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string => typeof child === 'string')
    .join(' ');
}

describe('PlanDrillCard without a prescription target', () => {
  it('renders no completion control and no tap instruction', () => {
    const { renderer } = render(
      item({
        targetSets: null,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: null,
      }),
    );
    expect(completionButtons(renderer)).toHaveLength(0);
    const copy = allText(renderer);
    expect(copy).not.toContain('Tap only after');
    expect(copy).not.toContain('I completed');
    expect(copy).toContain('nothing to log yet');
    expect(copy).toContain('—');
    act(() => renderer.unmount());
  });

  it('treats sets without reps or duration the same way', () => {
    const { renderer } = render(
      item({
        targetSets: 3,
        targetRepetitionsPerSet: null,
        targetDurationSeconds: null,
      }),
    );
    expect(completionButtons(renderer)).toHaveLength(0);
    expect(allText(renderer)).toContain('nothing to log yet');
    act(() => renderer.unmount());
  });
});

describe('PlanDrillCard with a prescription target', () => {
  it('keeps a live completion button wired to onConfirmComplete', () => {
    const { renderer, onConfirmComplete } = render(item());
    const [button] = completionButtons(renderer);
    expect(button).toBeDefined();
    expect(button!.props.disabled).toBeFalsy();
    act(() => {
      button!.props.onPress();
    });
    expect(onConfirmComplete).toHaveBeenCalledTimes(1);
    const copy = allText(renderer);
    expect(copy).toContain('I completed 3 × 10 reps');
    expect(copy).toContain('Tap only after');
    act(() => renderer.unmount());
  });

  it('shows the logged state once completion exists', () => {
    const { renderer } = render(
      item({
        completion: {
          id: 'completion-1',
          completedAt: '2026-08-30T12:00:00.000Z',
          actualRepetitions: 30,
          actualDurationSeconds: null,
          qualifiesForStreak: true,
        },
      }),
    );
    expect(completionButtons(renderer)).toHaveLength(0);
    const [logged] = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Shadow swings completion logged' &&
        typeof node.props.onPress === 'function',
    );
    expect(logged!.props.disabled).toBe(true);
    expect(allText(renderer)).toContain('Completed · streak credit earned');
    act(() => renderer.unmount());
  });
});
