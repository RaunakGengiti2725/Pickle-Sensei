/**
 * Render pins for the THIS SET card: the headline carries the exact tenths
 * delta in the trend colour (mint / flame / plain), every comparable attempt
 * renders as a pill in order with the latest ringed, pills are 44pt targets
 * that open their attempt only when a handler exists, and compact mode drops
 * the stroke label for the Result surface.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { PracticeSetCard } from '../src/progress/PracticeSetCard';
import { summarizePracticeSet } from '../src/progress/practiceSetProgress';
import type { RealAnalysisFact } from '../src/data/repository';
import { color } from '../src/design/tokens';

const SET = 'aaaaaaaa-0000-4000-8000-000000000001';
const T0 = '2026-09-02T17:00:00.000Z';

function at(minutes: number): string {
  return new Date(Date.parse(T0) + minutes * 60_000).toISOString();
}

function fact(
  id: string,
  minutes: number,
  overallScore: number,
  overrides: Partial<RealAnalysisFact> = {},
): RealAnalysisFact {
  return {
    id,
    shotType: 'forehand_drive',
    capturedAt: at(minutes),
    overallScore,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'sm-v2',
    shotConfigVersion: 'forehand_drive@1',
    sessionId: SET,
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((child): child is string | number => {
      return typeof child === 'string' || typeof child === 'number';
    })
    .map(String);
}

function hostByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  return node ?? null;
}

function flatStyle(style: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.assign(out, value);
  };
  walk(style);
  return out;
}

const improved = summarizePracticeSet(
  [
    fact('a', 1, 6.6, { checkpointScores: { contact_position: 48 } }),
    fact('b', 2, 7.0),
    fact('c', 3, 7.4, {
      priorityCheckpoint: 'recovery',
      checkpointScores: { contact_position: 81 },
    }),
  ],
  SET,
)!;

describe('PracticeSetCard', () => {
  it('renders the label, mint headline, ordered pills with the latest ringed, and the insight', () => {
    const renderer = render(<PracticeSetCard summary={improved} />);
    const rendered = texts(renderer);
    expect(rendered).toEqual([
      'THIS SET',
      'FOREHAND DRIVE',
      '+0.8 in this set',
      '6.6',
      '7.0',
      '7.4',
      '3 attempts · best 7.4 · contact position improved from 48 to 81',
    ]);
    const headline = hostByTestId(renderer, 'practice-set-headline')!;
    expect(flatStyle(headline.props.style).color).toBe(color.mint);
    expect(flatStyle(headline.props.style).fontSize).toBe(32); // type.h1

    const latest = hostByTestId(renderer, 'practice-set-latest-pill')!;
    expect(flatStyle(latest.props.style).borderColor).toBe(color.volt);
    // Only the latest attempt is ringed.
    expect(
      renderer.root.findAll(
        n =>
          typeof n.type === 'string' &&
          n.props.testID === 'practice-set-latest-pill',
      ),
    ).toHaveLength(1);

    // Without a handler the pills are plain, labelled, 44pt targets.
    const first = hostByTestId(renderer, 'practice-set-attempt-a')!;
    expect(first.props.accessibilityLabel).toBe('Attempt 1 of 3, score 6.6');
    expect(first.props.onPress).toBeUndefined();
    expect(flatStyle(first.props.style).minHeight).toBe(44);
    expect(flatStyle(first.props.style).minWidth).toBe(44);
    expect(
      hostByTestId(renderer, 'practice-set-attempt-c')!.props
        .accessibilityLabel,
    ).toBe('Attempt 3 of 3, score 7.4, latest');
    act(() => renderer.unmount());
  });

  it('opens the tapped attempt when a handler is provided', () => {
    const onOpenAttempt = jest.fn();
    const renderer = render(
      <PracticeSetCard summary={improved} onOpenAttempt={onOpenAttempt} />,
    );
    const [pressable] = renderer.root.findAll(
      n =>
        n.props.accessibilityLabel === 'Attempt 2 of 3, score 7.0' &&
        typeof n.props.onPress === 'function',
    );
    expect(pressable).toBeDefined();
    act(() => {
      pressable!.props.onPress();
    });
    expect(onOpenAttempt).toHaveBeenCalledWith('b');
    act(() => renderer.unmount());
  });

  it('colours a slip flame with a real minus sign, and a hold plain', () => {
    const slipped = summarizePracticeSet(
      [fact('a', 1, 7.2), fact('b', 2, 6.9)],
      SET,
    )!;
    const slippedRenderer = render(<PracticeSetCard summary={slipped} />);
    expect(texts(slippedRenderer)).toContain('\u22120.3 in this set');
    expect(
      flatStyle(
        hostByTestId(slippedRenderer, 'practice-set-headline')!.props.style,
      ).color,
    ).toBe(color.flame);
    act(() => slippedRenderer.unmount());

    const held = summarizePracticeSet(
      [fact('a', 1, 7.2), fact('b', 2, 7.4)],
      SET,
    )!;
    const heldRenderer = render(<PracticeSetCard summary={held} />);
    expect(texts(heldRenderer)).toContain('Held steady in this set');
    expect(
      flatStyle(
        hostByTestId(heldRenderer, 'practice-set-headline')!.props.style,
      ).color,
    ).toBe(color.onDark);
    act(() => heldRenderer.unmount());
  });

  it('compact mode drops the stroke label and keeps the h1 headline role', () => {
    const renderer = render(
      <PracticeSetCard summary={improved} compact testID="result-set" />,
    );
    expect(hostByTestId(renderer, 'result-set')).not.toBeNull();
    expect(texts(renderer)).not.toContain('FOREHAND DRIVE');
    expect(texts(renderer)).toContain('THIS SET');
    expect(
      flatStyle(hostByTestId(renderer, 'practice-set-headline')!.props.style)
        .fontSize,
    ).toBe(32);
    act(() => renderer.unmount());
  });

  it('names attempts that were not compared', () => {
    const mixed = summarizePracticeSet(
      [
        fact('old', 1, 5.0, { scoringModelVersion: 'sm-v1' }),
        fact('a', 2, 6.6),
        fact('b', 3, 7.4),
      ],
      SET,
    )!;
    const renderer = render(<PracticeSetCard summary={mixed} />);
    const rendered = texts(renderer);
    expect(rendered).toContain(
      '2 attempts · best 7.4 · 1 attempt on a different scoring model not compared',
    );
    // The excluded read never renders as a pill.
    expect(rendered).not.toContain('5.0');
    expect(hostByTestId(renderer, 'practice-set-attempt-old')).toBeNull();
    act(() => renderer.unmount());
  });
});
