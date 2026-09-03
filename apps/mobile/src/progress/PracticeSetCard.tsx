import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Card, PressableScale } from '../design/components';
import { color, radius, space, type } from '../design/tokens';
import { DashSectionHeader } from './DashSectionHeader';
import {
  practiceSetHeadline,
  practiceSetInsight,
  type PracticeSetAttempt,
  type PracticeSetSummary,
} from './practiceSetProgress';

/**
 * THIS SET — the WHOOP-style dark card for one practice set (MOBBIN: WHOOP
 * "Key statistics" cards). Rendered on the Progress Technique tab (latest
 * set) and on the Result surface (the set the shown attempt belongs to).
 *
 * Every element traces to the summary's measured facts: the headline is the
 * exact tenths delta between the first and latest comparable attempt (mint
 * when improved, flame when slipped, plain when held); the pill row lists
 * each comparable attempt's score in order with the latest ringed in volt;
 * the insight line is the pure module's one factual sentence. Nothing is
 * interpolated. No emojis.
 */

const TREND_COLOR = {
  improved: color.mint,
  slipped: color.flame,
  held: color.onDark,
} as const;

function strokeLabel(shotType: string): string {
  return shotType.replace(/_/g, ' ').toUpperCase();
}

function attemptLabel(
  attempt: PracticeSetAttempt,
  index: number,
  total: number,
): string {
  const ordinal = `Attempt ${index + 1} of ${total}`;
  const score = `score ${attempt.overallScore.toFixed(1)}`;
  return index === total - 1
    ? `${ordinal}, ${score}, latest`
    : `${ordinal}, ${score}`;
}

export function PracticeSetCard(props: {
  summary: PracticeSetSummary;
  /** When provided, each attempt pill opens that attempt's Result. */
  onOpenAttempt?: (analysisId: string) => void;
  /** Tighter spacing and no stroke label — for the Result surface, which
   * already names the stroke. */
  compact?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const { summary, onOpenAttempt, compact } = props;
  const headline = practiceSetHeadline(summary);
  const insight = practiceSetInsight(summary);
  const total = summary.attempts.length;

  return (
    <Card
      tone="dark"
      style={[styles.card, compact && styles.cardCompact, props.style]}
      testID={props.testID ?? 'practice-set-card'}
    >
      <DashSectionHeader
        title="THIS SET"
        right={compact ? undefined : strokeLabel(summary.shotType)}
        style={styles.header}
      />
      <Text
        accessibilityRole="header"
        accessibilityLabel={`${headline}. ${insight}`}
        style={[
          type.h1,
          styles.headline,
          { color: TREND_COLOR[summary.trend] },
        ]}
        testID="practice-set-headline"
      >
        {headline}
      </Text>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.attemptRow,
          compact && styles.attemptRowCompact,
        ]}
        style={styles.attemptScroll}
      >
        {summary.attempts.map((attempt, index) => {
          const latest = index === total - 1;
          const pill = (
            <View
              style={[styles.pill, latest && styles.pillLatest]}
              testID={latest ? 'practice-set-latest-pill' : undefined}
            >
              <Text style={[type.caption, styles.pillScore]}>
                {attempt.overallScore.toFixed(1)}
              </Text>
            </View>
          );
          return (
            <React.Fragment key={attempt.id}>
              {index > 0 ? <View style={styles.connector} /> : null}
              {onOpenAttempt ? (
                <PressableScale
                  accessibilityLabel={attemptLabel(attempt, index, total)}
                  accessibilityHint="Opens this attempt's result"
                  containerStyle={styles.pillTarget}
                  onPress={() => onOpenAttempt(attempt.id)}
                  style={styles.pillPressable}
                  testID={`practice-set-attempt-${attempt.id}`}
                >
                  {pill}
                </PressableScale>
              ) : (
                <View
                  accessible
                  accessibilityLabel={attemptLabel(attempt, index, total)}
                  style={styles.pillTarget}
                  testID={`practice-set-attempt-${attempt.id}`}
                >
                  {pill}
                </View>
              )}
            </React.Fragment>
          );
        })}
      </ScrollView>

      <Text style={[type.caption, styles.insight]}>{insight}</Text>
    </Card>
  );
}

const PILL_TARGET = 44;

const styles = StyleSheet.create({
  card: { marginTop: space.md },
  cardCompact: { marginTop: 0, padding: space.md },
  header: { marginTop: 0, marginBottom: space.sm },
  headline: { marginTop: 2 },
  attemptScroll: { marginTop: space.md, marginHorizontal: -4 },
  attemptRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  attemptRowCompact: { paddingVertical: 0 },
  // 44pt touch target around a visually smaller pill.
  pillTarget: {
    minWidth: PILL_TARGET,
    minHeight: PILL_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillPressable: {
    minWidth: PILL_TARGET,
    minHeight: PILL_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pill: {
    minWidth: 40,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: color.onDarkTint,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.lineStrongDark,
  },
  pillLatest: {
    borderWidth: 2,
    borderColor: color.volt,
    backgroundColor: 'rgba(215,250,69,0.12)',
  },
  pillScore: {
    color: color.onDark,
    fontVariant: ['tabular-nums'],
  },
  connector: {
    width: 14,
    height: 1,
    backgroundColor: color.lineStrongDark,
  },
  insight: { color: color.onDarkMuted, marginTop: space.sm + 4 },
});
