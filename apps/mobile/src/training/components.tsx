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

function MediaAttribution(props: {
  media: InstructionalMedia;
  dark?: boolean;
}) {
  return (
    <Text
      style={[
        type.caption,
        styles.attribution,
        props.dark && { color: color.onDarkMuted },
      ]}
    >
      {props.media.creatorName} · {props.media.licenseName}
    </Text>
  );
}

/** Text/tint roles of a drill card on the light (Library) and dark (Result
 * breakdown) surfaces; layout is shared, only color changes. */
const CARD_PALETTE = {
  light: {
    text: color.ink,
    muted: color.inkSoft,
    accent: color.court,
    badge: color.courtSoft,
    badgeDone: color.court,
    chip: color.surfaceAlt,
    cue: color.voltSoft,
    cueDot: color.court,
    line: color.line,
    button: color.ink,
    buttonDone: color.goodSoft,
    done: color.good,
  },
  dark: {
    text: color.onDark,
    muted: color.onDarkMuted,
    accent: color.volt,
    badge: color.voltTint,
    badgeDone: color.volt,
    chip: color.onDarkTint,
    cue: color.voltTint,
    cueDot: color.volt,
    line: color.lineDark,
    button: color.volt,
    buttonDone: color.mintTint,
    done: color.mint,
  },
} as const;

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
  /** On the dark result breakdown: dark card, light text, volt accents. */
  dark?: boolean;
}) {
  const { item } = props;
  const drill = item.drill;
  if (!drill) return null;
  const media = firstPlayableMedia(props.detail);
  const target = prescriptionLabel(item);
  const complete = item.completion;
  const dark = props.dark === true;
  const palette = dark ? CARD_PALETTE.dark : CARD_PALETTE.light;
  const buttonLabelColor = complete
    ? palette.done
    : dark
      ? color.onVolt
      : color.onDark;
  return (
    <Card tone={dark ? 'dark' : 'light'} style={styles.planCard}>
      <View style={styles.cardTop}>
        <View
          style={[
            styles.numberBadge,
            { backgroundColor: complete ? palette.badgeDone : palette.badge },
          ]}
        >
          {complete ? (
            <Icon name="check" size={17} color={color.onVolt} />
          ) : (
            <Text style={[type.micro, { color: palette.accent }]}>
              0{item.position}
            </Text>
          )}
        </View>
        <Text style={[type.micro, { color: palette.muted }]}>
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
          style={[styles.bookmarkButton, { backgroundColor: palette.chip }]}
        >
          <Icon
            name="bookmark"
            size={19}
            color={drill.saved ? palette.accent : palette.muted}
          />
        </PressableScale>
      </View>
      <Text style={[type.h2, styles.drillTitle, { color: palette.text }]}>
        {drill.title}
      </Text>
      <Text style={[type.body, styles.description, { color: palette.muted }]}>
        {drill.description}
      </Text>
      {item.cueText ? (
        <View style={[styles.cueRow, { backgroundColor: palette.cue }]}>
          <View style={[styles.cueDot, { backgroundColor: palette.cueDot }]} />
          <Text
            style={[type.bodyBold, styles.cueText, { color: palette.text }]}
          >
            {item.cueText}
          </Text>
        </View>
      ) : null}
      <View style={[styles.prescriptionRow, { borderTopColor: palette.line }]}>
        <Text style={[type.micro, { color: palette.muted }]}>PRESCRIPTION</Text>
        <Text style={[type.bodyBold, { color: palette.text }]}>
          {target ?? '—'}
        </Text>
        {item.restSeconds !== null ? (
          <Text style={[type.caption, { color: palette.muted }]}>
            {item.restSeconds}s rest
          </Text>
        ) : null}
      </View>
      {media ? (
        <PressableScale
          accessibilityLabel={`Watch reviewed instruction for ${drill.title}`}
          accessibilityHint={media.attribution}
          onPress={() => props.onOpenMedia(media)}
          style={[styles.mediaRow, { backgroundColor: palette.chip }]}
        >
          <View style={styles.playIcon}>
            <Icon name="play" size={18} color={color.onVolt} />
          </View>
          <View style={styles.flex}>
            <Text style={[type.bodyBold, { color: palette.text }]}>
              Watch form
            </Text>
            <MediaAttribution media={media} dark={dark} />
          </View>
          <Icon name="arrow" size={18} color={palette.muted} />
        </PressableScale>
      ) : null}
      {complete || target !== null ? (
        <>
          <PressableScale
            accessibilityLabel={
              complete
                ? `${drill.title} completion logged`
                : `Confirm completion of ${drill.title}`
            }
            disabled={Boolean(complete) || props.busy}
            onPress={props.onConfirmComplete}
            style={[
              styles.completionButton,
              {
                backgroundColor: complete ? palette.buttonDone : palette.button,
              },
            ]}
          >
            <Icon
              name={complete ? 'check' : 'plus'}
              size={18}
              color={buttonLabelColor}
            />
            <Text style={[type.bodyBold, { color: buttonLabelColor }]}>
              {complete
                ? complete.qualifiesForStreak
                  ? 'Completed · streak credit earned'
                  : 'Completion logged'
                : `I completed ${target}`}
            </Text>
          </PressableScale>
          <Text
            style={[
              type.caption,
              styles.evidenceNote,
              { color: palette.muted },
            ]}
          >
            {complete
              ? `Logged ${new Date(complete.completedAt).toLocaleDateString()}`
              : 'Tap only after doing the prescribed work. The server records your confirmation as practice evidence.'}
          </Text>
        </>
      ) : (
        <Text
          style={[type.caption, styles.evidenceNote, { color: palette.muted }]}
        >
          No sets, reps, or time were prescribed for this drill, so there is
          nothing to log yet. Save it to revisit once a prescription is
          attached.
        </Text>
      )}
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
  evidenceNote: {
    color: color.inkSoft,
    textAlign: 'center',
    marginTop: space.sm,
  },
});
