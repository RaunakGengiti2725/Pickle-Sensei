import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PhaseKey, ShotAnalysis } from '@pickle/shared-types';
import { Card, PressableScale, SectionTitle } from '../design/components';
import { Icon } from '../design/icons';
import { bandColor, color, radius, space, type } from '../design/tokens';
import { fixList, strengthList } from './formReviewModel';

/**
 * WHAT TO FIX — the up-to-three worst measured checkpoints of one scored
 * analysis, each with the engine's own number, the measured direction, and
 * the coaching cue that matches that direction (formReviewModel.fixList —
 * the same copy the guided form review speaks).
 *
 * HONESTY CONTRACT: every item traces to a checkpoint the scoring engine
 * scored (applicable, finite score, band below green). A clean stroke
 * renders NOTHING — no fix is invented so the section has something to say.
 * The strengths line names only green checkpoints with their real scores.
 */

const FIX_LIMIT = 3;
const STRENGTH_LIMIT = 2;

/** Applicable checkpoints with a readable score — the denominator of the
 * "n of m checkpoints" header, never the full 11-key catalog. */
function scoredCheckpointCount(analysis: ShotAnalysis): number {
  const raw = Array.isArray(analysis.checkpoints) ? analysis.checkpoints : [];
  return raw.filter(
    cp =>
      cp &&
      cp.applicable !== false &&
      typeof cp.score === 'number' &&
      Number.isFinite(cp.score),
  ).length;
}

export function FixList(props: {
  analysis: ShotAnalysis;
  /** When given, each item offers to open the form review at its phase. */
  onOpenInReview?: (phase: PhaseKey) => void;
}) {
  const items = fixList(props.analysis, FIX_LIMIT);
  if (items.length === 0) return null;
  const strengths = strengthList(props.analysis, STRENGTH_LIMIT);
  const scored = scoredCheckpointCount(props.analysis);
  const onOpen = props.onOpenInReview;

  return (
    <View testID="fix-list">
      <SectionTitle
        title="What to fix"
        right={
          <Text style={[type.caption, { color: color.inkSoft }]}>
            {items.length} of {scored} checkpoints
          </Text>
        }
      />
      <View style={styles.list}>
        {items.map((item, index) => (
          <Card
            key={item.key}
            style={styles.item}
            testID={`fix-item-${item.key}`}
          >
            <View style={styles.itemHeader}>
              <View style={styles.rankBadge}>
                <Text style={[type.micro, { color: color.onVolt }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
              </View>
              <Text style={[type.h3, styles.itemName]} numberOfLines={2}>
                {item.name}
              </Text>
              {item.isPriority ? (
                // The engine's own priorityFix checkpoint — a recorded field,
                // not a UI ranking.
                <View style={styles.priorityTag}>
                  <Text style={[type.micro, { color: color.bad }]}>
                    PRIORITY
                  </Text>
                </View>
              ) : null}
              <View
                style={[
                  styles.scorePill,
                  { backgroundColor: bandColor(item.band) },
                ]}
                accessibilityLabel={`${item.name} scored ${Math.round(
                  item.score,
                )} out of 100`}
              >
                <Text style={[type.micro, { color: color.onDark }]}>
                  {Math.round(item.score)}
                </Text>
              </View>
            </View>
            <Text style={[type.bodyBold, styles.headline]}>
              {item.headline}
            </Text>
            <Text style={[type.micro, styles.cueLabel]}>COACHING CUE</Text>
            <Text style={[type.body, styles.cue]}>{item.cue}</Text>
            {onOpen ? (
              <PressableScale
                accessibilityLabel={`See ${item.name.toLowerCase()} in your form review`}
                onPress={() => onOpen(item.phase)}
                style={styles.reviewRow}
                testID={`fix-item-${item.key}-review`}
              >
                <Text style={[type.caption, { color: color.court }]}>
                  See it in your form review
                </Text>
                <Icon name="chevron" size={16} color={color.court} />
              </PressableScale>
            ) : null}
          </Card>
        ))}
      </View>
      {strengths.length > 0 ? (
        <Card tone="soft" style={styles.keepCard} testID="fix-list-keep">
          <Text style={[type.caption, styles.keepCopy]}>
            Keep doing:{' '}
            {strengths
              .map(cp => `${cp.name} (${Math.round(cp.score)})`)
              .join(', ')}
          </Text>
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  item: { padding: space.lg },
  itemHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  rankBadge: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  itemName: { color: color.ink, flex: 1 },
  scorePill: {
    minWidth: 36,
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignItems: 'center',
  },
  priorityTag: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: color.badSoft,
  },
  headline: { color: color.ink, marginTop: space.md },
  cueLabel: { color: color.court, marginTop: space.md },
  cue: { color: color.inkSoft, marginTop: space.xs },
  reviewRow: {
    minHeight: 44,
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  keepCard: { marginTop: space.sm, padding: space.md },
  keepCopy: { color: color.inkSoft },
});
