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
 *
 * Two renderings share the one card: the full list (section header, three
 * items, strengths) on the light breakdown, and the `compact` dark variant
 * on the Result guide's "The problem" page (fewer items, no header, no
 * strengths — the page's title and the replay carry that framing).
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
  /** Items to show (engine priority first, then worst-first). Default 3. */
  limit?: number;
  /** Dark-surface card tones (Result guide). Default light. */
  dark?: boolean;
  /** No section header and no strengths card — items only. */
  compact?: boolean;
}) {
  const items = fixList(props.analysis, props.limit ?? FIX_LIMIT);
  if (items.length === 0) return null;
  const strengths = props.compact
    ? []
    : strengthList(props.analysis, STRENGTH_LIMIT);
  const scored = scoredCheckpointCount(props.analysis);
  const onOpen = props.onOpenInReview;
  const dark = props.dark === true;
  const ink = dark ? color.onDark : color.ink;
  const inkSoft = dark ? color.onDarkMuted : color.inkSoft;
  const accent = dark ? color.volt : color.court;

  return (
    <View testID="fix-list">
      {props.compact ? null : (
        <SectionTitle
          title="What to fix"
          dark={dark}
          right={
            <Text style={[type.caption, { color: inkSoft }]}>
              {items.length} of {scored} checkpoints
            </Text>
          }
        />
      )}
      <View style={styles.list}>
        {items.map((item, index) => (
          <Card
            key={item.key}
            tone={dark ? 'dark' : 'light'}
            style={styles.item}
            testID={`fix-item-${item.key}`}
          >
            <View style={styles.itemHeader}>
              <View style={styles.rankBadge}>
                <Text style={[type.micro, { color: color.onVolt }]}>
                  {String(index + 1).padStart(2, '0')}
                </Text>
              </View>
              <Text
                style={[type.h3, styles.itemName, { color: ink }]}
                numberOfLines={2}
              >
                {item.name}
              </Text>
              {item.isPriority ? (
                // The engine's own priorityFix checkpoint — a recorded field,
                // not a UI ranking.
                <View
                  style={[styles.priorityTag, dark && styles.priorityTagDark]}
                >
                  <Text
                    style={[
                      type.micro,
                      { color: dark ? color.flame : color.bad },
                    ]}
                  >
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
            <Text style={[type.bodyBold, styles.headline, { color: ink }]}>
              {item.headline}
            </Text>
            <Text style={[type.micro, styles.cueLabel, { color: accent }]}>
              COACHING CUE
            </Text>
            <Text style={[type.body, styles.cue, { color: inkSoft }]}>
              {item.cue}
            </Text>
            {onOpen ? (
              <PressableScale
                accessibilityLabel={`See ${item.name.toLowerCase()} in your form review`}
                onPress={() => onOpen(item.phase)}
                style={[styles.reviewRow, dark && styles.reviewRowDark]}
                testID={`fix-item-${item.key}-review`}
              >
                <Text style={[type.caption, { color: accent }]}>
                  See it in your form review
                </Text>
                <Icon name="chevron" size={16} color={accent} />
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
  itemName: { flex: 1 },
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
  priorityTagDark: { backgroundColor: color.onDarkTint },
  headline: { marginTop: space.md },
  cueLabel: { marginTop: space.md },
  cue: { marginTop: space.xs },
  reviewRow: {
    minHeight: 44,
    marginTop: space.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
  },
  reviewRowDark: { borderTopColor: color.lineDark },
  keepCard: { marginTop: space.sm, padding: space.md },
  keepCopy: { color: color.inkSoft },
});
