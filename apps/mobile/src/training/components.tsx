import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Card, PressableScale } from '../design/components';
import { Icon } from '../design/icons';
import { color, radius, space, type } from '../design/tokens';
import type {
  DrillDetail,
  InstructionalMedia,
  SavedDrill,
  TrainingPlanItem,
} from './types';

export function prescriptionLabel(item: TrainingPlanItem): string | null {
  if (!item.targetSets) return null;
  if (item.targetRepetitionsPerSet !== null) {
    return `${item.targetSets} × ${item.targetRepetitionsPerSet} reps`;
  }
  if (item.targetDurationSeconds !== null) {
    return `${item.targetSets} × ${item.targetDurationSeconds} sec`;
  }
  return null;
}

export function firstPlayableMedia(
  detail: DrillDetail | undefined,
  now = Date.now(),
): InstructionalMedia | null {
  if (!detail) return null;
  return (
    detail.instructionalMedia.find(media =>
      media.kind === 'hosted'
        ? new Date(media.expiresAt).getTime() > now
        : true,
    ) ?? null
  );
}

function MediaAttribution(props: { media: InstructionalMedia }) {
  return (
    <Text style={[type.caption, styles.attribution]}>
      {props.media.creatorName} · {props.media.licenseName}
    </Text>
  );
}

export function SavedDrillCard(props: {
  drill: SavedDrill;
  detail?: DrillDetail;
  busy: boolean;
  onUnsave: () => void;
  onOpenMedia: (media: InstructionalMedia) => void;
}) {
  const media = firstPlayableMedia(props.detail);
  return (
    <Card style={styles.savedCard}>
      <View style={styles.cardTop}>
        <View style={styles.numberBadge}>
          <Icon name="check" size={17} color={color.court} />
        </View>
        <Text style={[type.micro, { color: color.court }]}>SAVED DRILL</Text>
        <View style={styles.flex} />
        <PressableScale
          accessibilityLabel={`Remove ${props.drill.title} from saved drills`}
          disabled={props.busy}
          onPress={props.onUnsave}
          containerStyle={styles.bookmarkContainer}
          style={styles.bookmarkButton}
        >
          <Icon name="bookmark" size={19} color={color.court} />
        </PressableScale>
      </View>
      <Text style={[type.h2, styles.drillTitle]}>{props.drill.title}</Text>
      <Text style={[type.body, styles.description]}>
        {props.drill.description}
      </Text>
      <Text style={[type.caption, styles.coach]}>
        {props.detail?.mappings.length
          ? 'Reviewed prescription'
          : 'Server catalog'}{' '}
        · {props.drill.coachName}
      </Text>
      {media ? (
        <PressableScale
          accessibilityLabel={`Watch reviewed instruction for ${props.drill.title}`}
          accessibilityHint={media.attribution}
          onPress={() => props.onOpenMedia(media)}
          style={styles.mediaRow}
        >
          <View style={styles.playIcon}>
            <Icon name="play" size={18} color={color.onVolt} />
          </View>
          <View style={styles.flex}>
            <Text style={[type.bodyBold, { color: color.ink }]}>
              Watch form
            </Text>
            <MediaAttribution media={media} />
          </View>
          <Icon name="arrow" size={18} color={color.inkSoft} />
        </PressableScale>
      ) : (
        <Text style={[type.caption, styles.noMedia]}>
          {props.detail
            ? 'No rights-cleared coaching video is published for this drill yet.'
            : 'Video availability could not be verified.'}
        </Text>
      )}
    </Card>
  );
}

export function PlanDrillCard(props: {
  item: TrainingPlanItem;
  detail?: DrillDetail;
  busy: boolean;
  onToggleSaved: () => void;
  onConfirmComplete: () => void;
  onOpenMedia: (media: InstructionalMedia) => void;
}) {
  const { item } = props;
  const drill = item.drill;
  if (!drill) return null;
  const media = firstPlayableMedia(props.detail);
  const target = prescriptionLabel(item);
  const complete = item.completion;
  return (
    <Card style={styles.planCard}>
      <View style={styles.cardTop}>
        <View style={[styles.numberBadge, complete && styles.numberBadgeDone]}>
          {complete ? (
            <Icon name="check" size={17} color={color.onVolt} />
          ) : (
            <Text style={[type.micro, { color: color.court }]}>
              0{item.position}
            </Text>
          )}
        </View>
        <Text style={[type.micro, { color: color.inkSoft }]}>
          {item.kind === 'warmup' ? 'WARM-UP' : 'TARGETED'}
        </Text>
        <View style={styles.flex} />
        <PressableScale
          accessibilityLabel={`${drill.saved ? 'Remove' : 'Save'} ${
            drill.title
          }`}
          disabled={props.busy}
          onPress={props.onToggleSaved}
          containerStyle={styles.bookmarkContainer}
          style={styles.bookmarkButton}
        >
          <Icon
            name="bookmark"
            size={19}
            color={drill.saved ? color.court : color.inkSoft}
          />
        </PressableScale>
      </View>
      <Text style={[type.h2, styles.drillTitle]}>{drill.title}</Text>
      <Text style={[type.body, styles.description]}>{drill.description}</Text>
      {item.cueText ? (
        <View style={styles.cueRow}>
          <View style={styles.cueDot} />
          <Text style={[type.bodyBold, styles.cueText]}>{item.cueText}</Text>
        </View>
      ) : null}
      <View style={styles.prescriptionRow}>
        <Text style={[type.micro, { color: color.inkSoft }]}>PRESCRIPTION</Text>
        <Text style={[type.bodyBold, { color: color.ink }]}>
          {target ?? '—'}
        </Text>
        {item.restSeconds !== null ? (
          <Text style={[type.caption, { color: color.inkSoft }]}>
            {item.restSeconds}s rest
          </Text>
        ) : null}
      </View>
      {media ? (
        <PressableScale
          accessibilityLabel={`Watch reviewed instruction for ${drill.title}`}
          accessibilityHint={media.attribution}
          onPress={() => props.onOpenMedia(media)}
          style={styles.mediaRow}
        >
          <View style={styles.playIcon}>
            <Icon name="play" size={18} color={color.onVolt} />
          </View>
          <View style={styles.flex}>
            <Text style={[type.bodyBold, { color: color.ink }]}>
              Watch form
            </Text>
            <MediaAttribution media={media} />
          </View>
          <Icon name="arrow" size={18} color={color.inkSoft} />
        </PressableScale>
      ) : null}
      <PressableScale
        accessibilityLabel={
          complete
            ? `${drill.title} completion logged`
            : `Confirm completion of ${drill.title}`
        }
        disabled={Boolean(complete) || props.busy || target === null}
        onPress={props.onConfirmComplete}
        style={[
          styles.completionButton,
          complete && styles.completionButtonDone,
        ]}
      >
        <Icon
          name={complete ? 'check' : 'plus'}
          size={18}
          color={complete ? color.good : color.onDark}
        />
        <Text
          style={[
            type.bodyBold,
            { color: complete ? color.good : color.onDark },
          ]}
        >
          {complete
            ? complete.qualifiesForStreak
              ? 'Completed · streak credit earned'
              : 'Completion logged'
            : `I completed ${target ?? 'this prescription'}`}
        </Text>
      </PressableScale>
      <Text style={[type.caption, styles.evidenceNote]}>
        {complete
          ? `Logged ${new Date(complete.completedAt).toLocaleDateString()}`
          : 'Tap only after doing the prescribed work. The server records your confirmation as practice evidence.'}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  savedCard: { padding: space.lg, marginBottom: 12 },
  planCard: { padding: space.lg, marginBottom: 12 },
  cardTop: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  numberBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: color.courtSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
  },
  numberBadgeDone: { backgroundColor: color.court },
  bookmarkContainer: { borderRadius: 22 },
  bookmarkButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: color.surfaceAlt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drillTitle: { color: color.ink, marginTop: space.md },
  description: { color: color.inkSoft, marginTop: space.sm },
  coach: { color: color.inkSoft, marginTop: space.md },
  cueRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: color.voltSoft,
    borderRadius: radius.md,
    padding: space.md,
    gap: 10,
    marginTop: space.md,
  },
  cueDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: color.court,
    marginTop: 7,
  },
  cueText: { color: color.ink, flex: 1 },
  prescriptionRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.line,
    marginTop: space.md,
    paddingTop: space.md,
    gap: 3,
  },
  mediaRow: {
    minHeight: 66,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: color.surfaceAlt,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    marginTop: space.md,
  },
  playIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: color.volt,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attribution: { color: color.inkSoft, marginTop: 2 },
  noMedia: { color: color.inkSoft, marginTop: space.md },
  completionButton: {
    minHeight: 54,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: radius.md,
    backgroundColor: color.ink,
    marginTop: space.md,
    paddingHorizontal: space.md,
  },
  completionButtonDone: { backgroundColor: color.goodSoft },
  evidenceNote: {
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.sm,
  },
});
