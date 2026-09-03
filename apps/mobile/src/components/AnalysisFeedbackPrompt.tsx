import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { AnalysisFeedbackCategory } from '@pickle/shared-types';
import { getApiSession } from '../account/apiSession';
import { ApiError, submitAnalysisFeedback } from '../data/api';
import { color, radius, space, type } from '../design/tokens';

/**
 * "Was this analysis accurate?" — one quiet row at the bottom of the Result
 * screen (Wave I, i08-user-feedback). A tap is a failure-mining signal,
 * never a correction: nothing about the displayed result changes, and the
 * server alone decides review eligibility from the consent ledger. Rendered
 * only for a signed-in account with a synced analysis; one submission per
 * analysis, then the row collapses to a thank-you line.
 */

export const FEEDBACK_CATEGORY_LABELS: Record<
  AnalysisFeedbackCategory,
  string
> = {
  wrong_stroke: 'Wrong stroke',
  wrong_player: 'Wrong player',
  contact_looks_wrong: 'Contact looks wrong',
  feedback_mismatch: 'Feedback mismatch',
  other: 'Other',
};

type PromptState =
  | { step: 'ask' }
  | { step: 'categories' }
  | { step: 'sending' }
  | { step: 'done' }
  | { step: 'failed' };

export function AnalysisFeedbackPrompt({ analysisId }: { analysisId: string }) {
  const [state, setState] = useState<PromptState>({ step: 'ask' });
  const session = getApiSession();
  if (!session) return null;

  const submit = async (
    rating: 'accurate' | 'not_quite',
    category: AnalysisFeedbackCategory | null,
  ) => {
    setState({ step: 'sending' });
    try {
      await submitAnalysisFeedback(
        { baseUrl: session.apiBaseUrl, token: session.bearerToken },
        analysisId,
        rating,
        category,
      );
      setState({ step: 'done' });
    } catch (error) {
      if (
        error instanceof ApiError &&
        error.code === 'analysis.feedback_exists'
      ) {
        setState({ step: 'done' });
        return;
      }
      setState({ step: 'failed' });
    }
  };

  if (state.step === 'done') {
    return (
      <View style={styles.row} testID="feedback-thanks">
        <Text style={[type.caption, styles.muted]}>
          Thanks — your feedback helps us find hard cases to review.
        </Text>
      </View>
    );
  }
  if (state.step === 'failed') {
    return (
      <View style={styles.row} testID="feedback-failed">
        <Text style={[type.caption, styles.muted]}>
          Feedback could not be sent right now.
        </Text>
        <Pressable
          style={styles.chip}
          onPress={() => setState({ step: 'ask' })}
          accessibilityRole="button"
          testID="feedback-retry"
        >
          <Text style={[type.caption, styles.chipLabel]}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  if (state.step === 'sending') {
    return (
      <View style={styles.row} testID="feedback-sending">
        <Text style={[type.caption, styles.muted]}>Sending…</Text>
      </View>
    );
  }
  if (state.step === 'categories') {
    return (
      <View style={styles.block} testID="feedback-categories">
        <Text style={[type.caption, styles.muted]}>What looked off?</Text>
        <View style={styles.chipWrap}>
          {(
            Object.keys(FEEDBACK_CATEGORY_LABELS) as AnalysisFeedbackCategory[]
          ).map(category => (
            <Pressable
              key={category}
              style={styles.chip}
              onPress={() => void submit('not_quite', category)}
              accessibilityRole="button"
              testID={`feedback-category-${category}`}
            >
              <Text style={[type.caption, styles.chipLabel]}>
                {FEEDBACK_CATEGORY_LABELS[category]}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }
  return (
    <View style={styles.row} testID="feedback-ask">
      <Text style={[type.caption, styles.muted]}>
        Was this analysis accurate?
      </Text>
      <Pressable
        style={styles.chip}
        onPress={() => void submit('accurate', null)}
        accessibilityRole="button"
        testID="feedback-yes"
      >
        <Text style={[type.caption, styles.chipLabel]}>Yes</Text>
      </Pressable>
      <Pressable
        style={styles.chip}
        onPress={() => setState({ step: 'categories' })}
        accessibilityRole="button"
        testID="feedback-not-quite"
      >
        <Text style={[type.caption, styles.chipLabel]}>Not quite</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingVertical: space.sm,
  },
  block: {
    gap: space.sm,
    paddingVertical: space.sm,
  },
  chipWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  chip: {
    borderWidth: 1,
    borderColor: color.line,
    borderRadius: radius.pill,
    paddingHorizontal: space.md,
    paddingVertical: space.xs,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipLabel: {
    color: color.ink,
  },
  muted: {
    color: color.inkSoft,
  },
});
