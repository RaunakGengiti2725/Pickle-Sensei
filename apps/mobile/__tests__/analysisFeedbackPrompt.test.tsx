import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AnalysisFeedbackPrompt } from '../src/components/AnalysisFeedbackPrompt';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import { ApiError, submitAnalysisFeedback } from '../src/data/api';

jest.mock('../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../src/data/api')>('../src/data/api');
  return { ...actual, submitAnalysisFeedback: jest.fn() };
});

const submitMock = submitAnalysisFeedback as jest.MockedFunction<
  typeof submitAnalysisFeedback
>;

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

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

describe('AnalysisFeedbackPrompt', () => {
  beforeEach(() => {
    submitMock.mockReset();
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-1',
      refreshToken: 'refresh-token-1',
      bearerExpiresAtMs: Date.now() + 3_600_000,
      canonicalAppUserId: 'user-1',
      provider: 'apple',
    });
  });

  afterEach(() => {
    clearApiSession();
  });

  it('renders nothing without an API session', async () => {
    clearApiSession();
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-1" />,
    );
    expect(renderer.toJSON()).toBeNull();
  });

  it('submits an accurate rating with a null category', async () => {
    submitMock.mockResolvedValue({ reviewEligible: false });
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-1" />,
    );
    await press(renderer, 'feedback-yes');
    expect(submitMock).toHaveBeenCalledWith(
      { baseUrl: 'https://api.test', token: 'token-1' },
      'analysis-1',
      'accurate',
      null,
    );
    expect(textOf(renderer)).toContain('Thanks');
  });

  it('requires a category for a negative rating', async () => {
    submitMock.mockResolvedValue({ reviewEligible: true });
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-2" />,
    );
    await press(renderer, 'feedback-not-quite');
    expect(submitMock).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain('What looked off?');
    await press(renderer, 'feedback-category-contact_looks_wrong');
    expect(submitMock).toHaveBeenCalledWith(
      { baseUrl: 'https://api.test', token: 'token-1' },
      'analysis-2',
      'not_quite',
      'contact_looks_wrong',
    );
    expect(textOf(renderer)).toContain('Thanks');
  });

  it('treats an existing submission as done', async () => {
    submitMock.mockRejectedValue(
      new ApiError(409, 'analysis.feedback_exists', 'exists'),
    );
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-3" />,
    );
    await press(renderer, 'feedback-yes');
    expect(textOf(renderer)).toContain('Thanks');
  });

  it('offers retry after a transport failure', async () => {
    submitMock.mockRejectedValue(new Error('network down'));
    const renderer = await render(
      <AnalysisFeedbackPrompt analysisId="analysis-4" />,
    );
    await press(renderer, 'feedback-yes');
    expect(textOf(renderer)).toContain('could not be sent');
    submitMock.mockResolvedValue({ reviewEligible: false });
    await press(renderer, 'feedback-retry');
    expect(textOf(renderer)).toContain('Was this analysis accurate?');
  });
});
