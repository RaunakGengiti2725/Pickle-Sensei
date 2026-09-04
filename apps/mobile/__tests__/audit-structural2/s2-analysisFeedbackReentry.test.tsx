/**
 * Structural audit #2: `AnalysisFeedbackPrompt.submit` moves to 'sending'
 * through React state only. Two activations delivered before that state
 * commits (same batch) both reach the network. On device, discrete touch
 * events flush synchronously so this needs the two presses to land in one
 * batch; the server also answers the second with `feedback_exists`. The
 * probe pins the component-level contract: one activation → one request.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
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

describe('AnalysisFeedbackPrompt re-entrancy', () => {
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

  it('sends exactly one request when the rating control is activated twice in one batch', async () => {
    let resolveSubmit!: (value: { reviewEligible: boolean }) => void;
    submitMock.mockImplementation(
      () =>
        new Promise(resolve => {
          resolveSubmit = resolve;
        }),
    );
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      root = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="analysis-1" />,
      );
    });
    const yes = root.root.findByProps({ testID: 'feedback-yes' });
    await act(async () => {
      yes.props.onPress();
      yes.props.onPress();
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveSubmit({ reviewEligible: false });
    });
    await act(async () => root.unmount());
  });

  it('a second activation after the sending state committed is impossible — control is gone (verified invariant)', async () => {
    submitMock.mockImplementation(() => new Promise(() => {}));
    let root!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      root = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="analysis-1" />,
      );
    });
    await act(async () => {
      root.root.findByProps({ testID: 'feedback-yes' }).props.onPress();
    });
    expect(
      root.root.findAll(n => n.props.testID === 'feedback-yes'),
    ).toHaveLength(0);
    expect(
      root.root.findAll(n => n.props.testID === 'feedback-sending').length,
    ).toBeGreaterThan(0);
    expect(submitMock).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });
});
