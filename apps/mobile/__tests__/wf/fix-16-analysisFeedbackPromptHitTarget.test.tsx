import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { StyleSheet } from 'react-native';
import { AnalysisFeedbackPrompt } from '../../src/components/AnalysisFeedbackPrompt';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { submitAnalysisFeedback } from '../../src/data/api';

jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, submitAnalysisFeedback: jest.fn() };
});

const submitMock = submitAnalysisFeedback as jest.MockedFunction<
  typeof submitAnalysisFeedback
>;

const MIN_HIT_TARGET = 44;

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  const node = renderer.root.findByProps({ testID });
  await act(async () => {
    node.props.onPress();
  });
}

function pressableTestIds(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        typeof node.props.testID === 'string',
    )
    .map(node => node.props.testID as string);
}

function expectMeetsHitTarget(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const node = renderer.root.findByProps({ testID });
  const style = StyleSheet.flatten(node.props.style) as {
    minHeight?: number;
    height?: number;
    justifyContent?: string;
  };
  const height = style.minHeight ?? style.height ?? 0;
  expect(height).toBeGreaterThanOrEqual(MIN_HIT_TARGET);
  expect(style.justifyContent).toBe('center');
  expect(node.props.accessibilityRole).toBe('button');
}

describe('AnalysisFeedbackPrompt hit targets (fix-16)', () => {
  beforeEach(() => {
    submitMock.mockReset();
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
  });

  afterEach(() => {
    clearApiSession();
  });

  it('Yes / Not quite meet the 44pt minimum', async () => {
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-1" />,
    );
    const ids = pressableTestIds(renderer);
    expect(ids).toEqual(['feedback-yes', 'feedback-not-quite']);
    ids.forEach(id => expectMeetsHitTarget(renderer, id));
  });

  it('every category chip meets the 44pt minimum', async () => {
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-2" />,
    );
    await press(renderer, 'feedback-not-quite');
    const ids = pressableTestIds(renderer);
    expect(ids).toEqual([
      'feedback-category-wrong_stroke',
      'feedback-category-wrong_player',
      'feedback-category-contact_looks_wrong',
      'feedback-category-feedback_mismatch',
      'feedback-category-other',
    ]);
    ids.forEach(id => expectMeetsHitTarget(renderer, id));
  });

  it('Try again after a failed submit meets the 44pt minimum', async () => {
    submitMock.mockRejectedValue(new Error('network down'));
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-3" />,
    );
    await press(renderer, 'feedback-yes');
    expect(pressableTestIds(renderer)).toEqual(['feedback-retry']);
    expectMeetsHitTarget(renderer, 'feedback-retry');
  });
});
