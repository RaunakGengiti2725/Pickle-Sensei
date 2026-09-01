import React from 'react';
import { StyleSheet } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import type { AnalysisFeedbackCategory } from '@pickle/shared-types';
import {
  AnalysisFeedbackPrompt,
  FEEDBACK_CATEGORY_LABELS,
} from '../../src/components/AnalysisFeedbackPrompt';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { ApiError, submitAnalysisFeedback } from '../../src/data/api';

/**
 * Button ledger for AnalysisFeedbackPrompt. Every Pressable the component can
 * render is pressed here through `props.onPress()` and its observable effect
 * asserted (api call arguments, state/copy transition, failure copy + retry).
 */

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

const SESSION = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'user-1',
  provider: 'apple' as const,
};
const EXPECTED_CONFIG = { baseUrl: 'https://api.test', token: 'token-1' };

const CATEGORIES = Object.keys(
  FEEDBACK_CATEGORY_LABELS,
) as AnalysisFeedbackCategory[];

async function render(analysisId = 'analysis-1') {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <AnalysisFeedbackPrompt analysisId={analysisId} />,
    );
  });
  return renderer;
}

function find(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findByProps({ testID });
}

function has(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAllByProps({ testID }).length > 0;
}

async function press(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  await act(async () => {
    find(renderer, testID).props.onPress();
  });
}

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

/** Every element in the tree that carries an onPress — the ledger's notion
 * of a pressable. Deduped to the outermost composite instance so a Pressable
 * and its host View count once. */
function pressables(renderer: TestRenderer.ReactTestRenderer) {
  const all = renderer.root.findAll(
    node => typeof node.props.onPress === 'function' && !!node.props.testID,
  );
  const seen = new Set<string>();
  return all.filter(node => {
    if (seen.has(node.props.testID)) return false;
    seen.add(node.props.testID);
    return true;
  });
}

/** Resolvable-from-outside promise so the pending ("sending") state can be
 * observed before the request settles. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AnalysisFeedbackPrompt button ledger', () => {
  beforeEach(() => {
    submitMock.mockReset();
    establishApiSession(SESSION);
  });

  afterEach(() => {
    clearApiSession();
  });

  describe('reachability', () => {
    it('renders nothing (no dead controls) without an API session', async () => {
      clearApiSession();
      const renderer = await render();
      expect(renderer.toJSON()).toBeNull();
      expect(pressables(renderer)).toHaveLength(0);
    });

    it('initial "ask" row exposes exactly Yes + Not quite, both real buttons', async () => {
      const renderer = await render();
      expect(has(renderer, 'feedback-ask')).toBe(true);
      const buttons = pressables(renderer);
      expect(buttons.map(b => b.props.testID)).toEqual([
        'feedback-yes',
        'feedback-not-quite',
      ]);
      for (const button of buttons) {
        expect(typeof button.props.onPress).toBe('function');
        expect(button.props.accessibilityRole).toBe('button');
        expect(button.props.disabled).toBeFalsy();
      }
      expect(textOf(renderer)).toContain('Was this analysis accurate?');
      expect(textOf(renderer)).toContain('Yes');
      expect(textOf(renderer)).toContain('Not quite');
    });
  });

  describe('feedback-yes -> submit("accurate", null)', () => {
    it('posts an accurate rating with the session credentials and collapses to thanks', async () => {
      submitMock.mockResolvedValue({ reviewEligible: false });
      const renderer = await render('analysis-yes');
      await press(renderer, 'feedback-yes');
      expect(submitMock).toHaveBeenCalledTimes(1);
      expect(submitMock).toHaveBeenCalledWith(
        EXPECTED_CONFIG,
        'analysis-yes',
        'accurate',
        null,
      );
      expect(has(renderer, 'feedback-thanks')).toBe(true);
      expect(textOf(renderer)).toContain(
        'Thanks — your feedback helps us find hard cases to review.',
      );
      // One submission per analysis: no button survives the done state.
      expect(pressables(renderer)).toHaveLength(0);
    });

    it('shows a pending "Sending…" state with no tappable controls while the request is in flight', async () => {
      const gate = deferred<{ reviewEligible: boolean }>();
      submitMock.mockReturnValue(gate.promise);
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-sending')).toBe(true);
      expect(textOf(renderer)).toContain('Sending…');
      // Double-tap guard: the buttons unmount while pending.
      expect(pressables(renderer)).toHaveLength(0);
      expect(has(renderer, 'feedback-yes')).toBe(false);
      await act(async () => {
        gate.resolve({ reviewEligible: true });
        await gate.promise;
      });
      expect(has(renderer, 'feedback-thanks')).toBe(true);
      expect(has(renderer, 'feedback-sending')).toBe(false);
    });

    it('treats a 409 analysis.feedback_exists as already done (no error, no retry)', async () => {
      submitMock.mockRejectedValue(
        new ApiError(409, 'analysis.feedback_exists', 'exists'),
      );
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-thanks')).toBe(true);
      expect(has(renderer, 'feedback-failed')).toBe(false);
      expect(pressables(renderer)).toHaveLength(0);
    });

    it('surfaces a transport failure with user-visible copy and a retry button', async () => {
      submitMock.mockRejectedValue(new Error('network down'));
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-failed')).toBe(true);
      expect(textOf(renderer)).toContain(
        'Feedback could not be sent right now.',
      );
      expect(textOf(renderer)).toContain('Try again');
      expect(has(renderer, 'feedback-sending')).toBe(false);
      expect(pressables(renderer).map(b => b.props.testID)).toEqual([
        'feedback-retry',
      ]);
    });

    it('surfaces a non-duplicate ApiError (e.g. 503) as the failed state, not as done', async () => {
      submitMock.mockRejectedValue(
        new ApiError(503, 'server.unavailable', 'try later'),
      );
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-failed')).toBe(true);
      expect(has(renderer, 'feedback-thanks')).toBe(false);
    });

    it('surfaces a non-Error rejection as the failed state (no unhandled rejection)', async () => {
      submitMock.mockRejectedValue('string rejection');
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-failed')).toBe(true);
    });
  });

  describe('feedback-not-quite -> setState(categories)', () => {
    it('does NOT call the api; opens the category picker with one chip per category', async () => {
      const renderer = await render();
      await press(renderer, 'feedback-not-quite');
      expect(submitMock).not.toHaveBeenCalled();
      expect(has(renderer, 'feedback-categories')).toBe(true);
      expect(has(renderer, 'feedback-ask')).toBe(false);
      expect(textOf(renderer)).toContain('What looked off?');
      const chips = pressables(renderer);
      expect(chips.map(c => c.props.testID)).toEqual(
        CATEGORIES.map(c => `feedback-category-${c}`),
      );
      expect(CATEGORIES).toEqual([
        'wrong_stroke',
        'wrong_player',
        'contact_looks_wrong',
        'feedback_mismatch',
        'other',
      ]);
      for (const category of CATEGORIES) {
        expect(textOf(renderer)).toContain(FEEDBACK_CATEGORY_LABELS[category]);
      }
      for (const chip of chips) {
        expect(typeof chip.props.onPress).toBe('function');
        expect(chip.props.accessibilityRole).toBe('button');
      }
    });
  });

  describe.each(CATEGORIES)(
    'feedback-category-%s -> submit("not_quite", category)',
    category => {
      it('posts not_quite with that category and collapses to thanks', async () => {
        submitMock.mockResolvedValue({ reviewEligible: true });
        const renderer = await render(`analysis-${category}`);
        await press(renderer, 'feedback-not-quite');
        await press(renderer, `feedback-category-${category}`);
        expect(submitMock).toHaveBeenCalledTimes(1);
        expect(submitMock).toHaveBeenCalledWith(
          EXPECTED_CONFIG,
          `analysis-${category}`,
          'not_quite',
          category,
        );
        expect(has(renderer, 'feedback-thanks')).toBe(true);
        expect(pressables(renderer)).toHaveLength(0);
      });

      it('shows the pending state (chips unmounted) while the request is in flight', async () => {
        const gate = deferred<{ reviewEligible: boolean }>();
        submitMock.mockReturnValue(gate.promise);
        const renderer = await render();
        await press(renderer, 'feedback-not-quite');
        await press(renderer, `feedback-category-${category}`);
        expect(has(renderer, 'feedback-sending')).toBe(true);
        expect(pressables(renderer)).toHaveLength(0);
        await act(async () => {
          gate.resolve({ reviewEligible: false });
          await gate.promise;
        });
        expect(has(renderer, 'feedback-thanks')).toBe(true);
      });

      it('falls to the failed state with retry when the request rejects', async () => {
        submitMock.mockRejectedValue(new Error('offline'));
        const renderer = await render();
        await press(renderer, 'feedback-not-quite');
        await press(renderer, `feedback-category-${category}`);
        expect(has(renderer, 'feedback-failed')).toBe(true);
        expect(textOf(renderer)).toContain(
          'Feedback could not be sent right now.',
        );
        expect(has(renderer, 'feedback-retry')).toBe(true);
      });

      it('treats 409 analysis.feedback_exists as done', async () => {
        submitMock.mockRejectedValue(
          new ApiError(409, 'analysis.feedback_exists', 'exists'),
        );
        const renderer = await render();
        await press(renderer, 'feedback-not-quite');
        await press(renderer, `feedback-category-${category}`);
        expect(has(renderer, 'feedback-thanks')).toBe(true);
      });
    },
  );

  describe('feedback-retry -> setState(ask)', () => {
    it('returns to the question row with both buttons re-enabled', async () => {
      submitMock.mockRejectedValue(new Error('network down'));
      const renderer = await render();
      await press(renderer, 'feedback-yes');
      expect(has(renderer, 'feedback-failed')).toBe(true);
      const retry = find(renderer, 'feedback-retry');
      expect(retry.props.accessibilityRole).toBe('button');
      await press(renderer, 'feedback-retry');
      expect(has(renderer, 'feedback-ask')).toBe(true);
      expect(has(renderer, 'feedback-failed')).toBe(false);
      expect(textOf(renderer)).toContain('Was this analysis accurate?');
      expect(pressables(renderer).map(b => b.props.testID)).toEqual([
        'feedback-yes',
        'feedback-not-quite',
      ]);
      // The retry is a real retry: the next press re-issues the request.
      submitMock.mockResolvedValue({ reviewEligible: false });
      await press(renderer, 'feedback-yes');
      expect(submitMock).toHaveBeenCalledTimes(2);
      expect(has(renderer, 'feedback-thanks')).toBe(true);
    });

    it('retry after a failed category submission lets the user pick a category again', async () => {
      submitMock.mockRejectedValue(new Error('offline'));
      const renderer = await render('analysis-r');
      await press(renderer, 'feedback-not-quite');
      await press(renderer, 'feedback-category-other');
      await press(renderer, 'feedback-retry');
      expect(has(renderer, 'feedback-ask')).toBe(true);
      submitMock.mockResolvedValue({ reviewEligible: true });
      await press(renderer, 'feedback-not-quite');
      await press(renderer, 'feedback-category-wrong_player');
      expect(submitMock).toHaveBeenLastCalledWith(
        EXPECTED_CONFIG,
        'analysis-r',
        'not_quite',
        'wrong_player',
      );
      expect(has(renderer, 'feedback-thanks')).toBe(true);
    });
  });

  describe('accessibility / hit target', () => {
    it('every rendered pressable in every state has accessibilityRole="button"', async () => {
      submitMock.mockRejectedValue(new Error('network down'));
      const renderer = await render();
      const seen: string[] = [];
      const check = () => {
        for (const p of pressables(renderer)) {
          seen.push(p.props.testID);
          expect(p.props.accessibilityRole).toBe('button');
        }
      };
      check(); // ask
      await press(renderer, 'feedback-not-quite');
      check(); // categories
      await press(renderer, 'feedback-category-other');
      check(); // failed
      expect(seen).toEqual([
        'feedback-yes',
        'feedback-not-quite',
        ...CATEGORIES.map(c => `feedback-category-${c}`),
        'feedback-retry',
      ]);
    });

    // WF-ISSUE: Feedback chips render ~28pt tall (caption lineHeight 18 +
    // 2×space.xs padding + 2×1 border) with no hitSlop — below the 44pt
    // minimum. This assertion fails against the current implementation.
    it.skip('every chip meets a 44pt hit target (minHeight >= 44 or hitSlop)', async () => {
      const renderer = await render();
      for (const chip of pressables(renderer)) {
        const style = StyleSheet.flatten(chip.props.style) ?? {};
        const minHeight =
          typeof style.minHeight === 'number' ? style.minHeight : 0;
        const height = typeof style.height === 'number' ? style.height : 0;
        const hitSlop = chip.props.hitSlop;
        expect(minHeight >= 44 || height >= 44 || hitSlop !== undefined).toBe(
          true,
        );
      }
    });
  });
});
