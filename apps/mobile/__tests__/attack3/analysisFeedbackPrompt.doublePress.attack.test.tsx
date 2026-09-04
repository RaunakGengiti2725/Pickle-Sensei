import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AnalysisFeedbackPrompt } from '../../src/components/AnalysisFeedbackPrompt';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { ApiError, submitAnalysisFeedback } from '../../src/data/api';

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

/**
 * Adversarial pass 3 — AnalysisFeedbackPrompt under a double tap. Two
 * category chips pressed inside ONE React commit (a fat-finger / double
 * dispatch before the `sending` re-render lands) must produce ONE server
 * submission: the prompt is documented as "one submission per analysis".
 * A stale session (401) must land in the `failed` row with a working retry.
 */

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function node(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    node(renderer, testID).props.onPress();
  });
}

function has(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(n => n.props.testID === testID).length > 0;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AnalysisFeedbackPrompt — double press (attack 3)', () => {
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

  it('two category chips pressed in the same act() submit exactly once', async () => {
    const first = deferred<{ reviewEligible: boolean }>();
    submitMock.mockReturnValue(first.promise);
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-dbl" />,
    );
    await press(renderer, 'feedback-not-quite');
    expect(has(renderer, 'feedback-categories')).toBe(true);

    const wrongStroke = node(renderer, 'feedback-category-wrong_stroke');
    const wrongPlayer = node(renderer, 'feedback-category-wrong_player');
    await act(async () => {
      wrongStroke.props.onPress();
      wrongPlayer.props.onPress();
    });

    expect(has(renderer, 'feedback-sending')).toBe(true);
    // "one submission per analysis" — the second tap must be swallowed.
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(submitMock.mock.calls[0]?.slice(1)).toEqual([
      'analysis-dbl',
      'not_quite',
      'wrong_stroke',
    ]);

    await act(async () => {
      first.resolve({ reviewEligible: false });
    });
    expect(has(renderer, 'feedback-thanks')).toBe(true);
    act(() => renderer.unmount());
  });

  it('consequence: when the duplicate request fails after the first succeeded, the row reports failure for feedback the server already recorded', async () => {
    const first = deferred<{ reviewEligible: boolean }>();
    const second = deferred<{ reviewEligible: boolean }>();
    submitMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-race" />,
    );
    await press(renderer, 'feedback-not-quite');
    const a = node(renderer, 'feedback-category-wrong_stroke');
    const b = node(renderer, 'feedback-category-feedback_mismatch');
    await act(async () => {
      a.props.onPress();
      b.props.onPress();
    });
    await act(async () => first.resolve({ reviewEligible: true }));
    expect(has(renderer, 'feedback-thanks')).toBe(true);
    // Duplicate hits the per-user route budget / a transient 5xx.
    await act(async () =>
      second.reject(new ApiError(429, 'rate_limited', 'slow down')),
    );
    // Should still say thanks — the feedback IS stored server-side.
    expect(has(renderer, 'feedback-thanks')).toBe(true);
    expect(has(renderer, 'feedback-failed')).toBe(false);
    act(() => renderer.unmount());
  });

  it('Yes and Not quite pressed in the same act() do not both fire a submission', async () => {
    submitMock.mockResolvedValue({ reviewEligible: false });
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-yn" />,
    );
    const yes = node(renderer, 'feedback-yes');
    const notQuite = node(renderer, 'feedback-not-quite');
    await act(async () => {
      yes.props.onPress();
      notQuite.props.onPress();
    });
    // Yes started a submission; the Not quite tap raced it. Whatever wins the
    // last setState, the network must have been touched at most once and the
    // row must not be stuck.
    expect(submitMock).toHaveBeenCalledTimes(1);
    expect(has(renderer, 'feedback-sending')).toBe(false);
    act(() => renderer.unmount());
  });

  it('the same chip pressed 10 times in one act() submits once', async () => {
    const pending = deferred<{ reviewEligible: boolean }>();
    submitMock.mockReturnValue(pending.promise);
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-x10" />,
    );
    await press(renderer, 'feedback-not-quite');
    const chip = node(renderer, 'feedback-category-other');
    await act(async () => {
      for (let i = 0; i < 10; i += 1) chip.props.onPress();
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ reviewEligible: true }));
    act(() => renderer.unmount());
  });

  it('a 401 (stale session) lands in the failed row and Try again re-offers the prompt without crashing', async () => {
    submitMock.mockRejectedValueOnce(
      new ApiError(401, 'auth.invalid_token', 'Session expired'),
    );
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-401" />,
    );
    await press(renderer, 'feedback-not-quite');
    await press(renderer, 'feedback-category-contact_looks_wrong');
    expect(has(renderer, 'feedback-failed')).toBe(true);
    expect(has(renderer, 'feedback-thanks')).toBe(false);
    const retry = node(renderer, 'feedback-retry');
    expect(retry.props.accessibilityRole).toBe('button');

    // Retry succeeds on a fresh token.
    submitMock.mockResolvedValueOnce({ reviewEligible: false });
    await press(renderer, 'feedback-retry');
    expect(has(renderer, 'feedback-ask')).toBe(true);
    await press(renderer, 'feedback-yes');
    expect(has(renderer, 'feedback-thanks')).toBe(true);
    expect(submitMock).toHaveBeenCalledTimes(2);
    act(() => renderer.unmount());
  });

  it('a 401 followed by 403 then a non-ApiError rejection keeps offering retry (never stuck in sending)', async () => {
    submitMock
      .mockRejectedValueOnce(new ApiError(401, 'auth.invalid_token', 'x'))
      .mockRejectedValueOnce(new ApiError(403, 'auth.forbidden', 'y'))
      .mockRejectedValueOnce(new TypeError('Network request failed'))
      .mockRejectedValueOnce(undefined);
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-loop" />,
    );
    for (let i = 0; i < 4; i += 1) {
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-failed')).toBe(true);
      await press(renderer, 'feedback-retry');
      expect(has(renderer, 'feedback-ask')).toBe(true);
    }
    expect(submitMock).toHaveBeenCalledTimes(4);
    act(() => renderer.unmount());
  });

  it('a late rejection after unmount does not throw', async () => {
    const pending = deferred<{ reviewEligible: boolean }>();
    submitMock.mockReturnValue(pending.promise);
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-unmount" />,
    );
    await press(renderer, 'feedback-yes');
    act(() => renderer.unmount());
    await act(async () => {
      pending.reject(new ApiError(401, 'auth.invalid_token', 'late'));
    });
    expect(submitMock).toHaveBeenCalledTimes(1);
  });
});
