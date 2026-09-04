/**
 * AUDIT — AnalysisFeedbackPrompt.submit (AnalysisFeedbackPrompt.tsx:40-44)
 * flips to 'sending' via setState only; there is no synchronous guard. Two
 * activations delivered before React commits the 'sending' render both reach
 * the network. The server's `analysis.feedback_exists` makes the duplicate
 * harmless for the user, so this pins the client-side contract only.
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

describe('AnalysisFeedbackPrompt re-entrancy', () => {
  it('VERIFIED: a second tap AFTER the sending state commits cannot resubmit (control is gone)', async () => {
    let resolve!: (value: { reviewEligible: boolean }) => void;
    submitMock.mockReturnValue(
      new Promise(r => {
        resolve = r;
      }),
    );
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="analysis-1" />,
      );
    });
    await act(async () => {
      renderer.root.findByProps({ testID: 'feedback-yes' }).props.onPress();
    });
    expect(
      renderer.root.findAllByProps({ testID: 'feedback-yes' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'feedback-sending' }),
    ).toBeTruthy();
    expect(submitMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve({ reviewEligible: false });
    });
    expect(
      renderer.root.findByProps({ testID: 'feedback-thanks' }),
    ).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('PROBE: two activations in the same tick (before the sending commit) must produce ONE submission', async () => {
    submitMock.mockResolvedValue({ reviewEligible: false });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AnalysisFeedbackPrompt analysisId="analysis-1" />,
      );
    });
    const yes = renderer.root.findByProps({ testID: 'feedback-yes' });
    await act(async () => {
      yes.props.onPress();
      yes.props.onPress();
    });
    const calls = submitMock.mock.calls.length;
    act(() => renderer.unmount());
    expect(calls).toBe(1);
  });
});
