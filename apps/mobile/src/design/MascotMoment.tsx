import React from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type ImageSourcePropType,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { color, radius, space, type } from './tokens';

/**
 * The supplied mascot set, normalized to transparent, mobile-sized PNGs.
 * Keeping the source map here gives every product surface the same crop,
 * tint, and accessibility behavior instead of styling raw images ad hoc.
 */
export const MASCOT_SOURCES = {
  greet: require('../../assets/mascot/greet.png'),
  serve: require('../../assets/mascot/serve.png'),
  smash: require('../../assets/mascot/smash.png'),
  celebrate: require('../../assets/mascot/celebrate.png'),
  question: require('../../assets/mascot/question.png'),
  rest: require('../../assets/mascot/rest.png'),
  reach: require('../../assets/mascot/reach.png'),
  stretch: require('../../assets/mascot/stretch.png'),
  bounce: require('../../assets/mascot/bounce.png'),
  backhand: require('../../assets/mascot/backhand.png'),
  volley: require('../../assets/mascot/volley.png'),
  forehand: require('../../assets/mascot/forehand.png'),
  ready: require('../../assets/mascot/ready.png'),
  sprint: require('../../assets/mascot/sprint.png'),
  lunge: require('../../assets/mascot/lunge.png'),
} satisfies Record<string, ImageSourcePropType>;

export type MascotPose = keyof typeof MASCOT_SOURCES;
export type MascotTone = 'volt' | 'court' | 'warn' | 'danger';

const TONES: Record<
  MascotTone,
  { accent: string; soft: string; label: string }
> = {
  volt: { accent: color.volt, soft: color.voltSoft, label: color.courtDeep },
  court: { accent: color.court, soft: color.courtSoft, label: color.courtDeep },
  warn: { accent: color.warn, soft: color.warnSoft, label: color.warn },
  danger: { accent: color.bad, soft: color.badSoft, label: color.bad },
};

interface MascotSharedProps {
  pose: MascotPose;
  dark?: boolean;
  tone?: MascotTone;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** A compact editorial banner for onboarding and contextual guidance. */
export function MascotMoment(
  props: MascotSharedProps & {
    eyebrow: string;
    caption: string;
    compact?: boolean;
  },
) {
  const tone = TONES[props.tone ?? 'volt'];
  const imageSize = props.compact
    ? styles.momentImageCompact
    : styles.momentImage;

  return (
    <View
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[
        styles.moment,
        props.compact && styles.momentCompact,
        props.dark ? styles.momentDark : styles.momentLight,
        props.style,
      ]}
    >
      <View style={styles.momentCopy}>
        <Text
          style={[type.micro, { color: props.dark ? tone.accent : tone.label }]}
        >
          {props.eyebrow}
        </Text>
        <Text
          style={[
            type.caption,
            styles.momentCaption,
            { color: props.dark ? color.onDark : color.ink },
          ]}
        >
          {props.caption}
        </Text>
      </View>
      <View
        style={[
          styles.momentArt,
          props.compact && styles.momentArtCompact,
          { backgroundColor: props.dark ? color.onDarkTint : tone.soft },
        ]}
      >
        <View style={[styles.accentBall, { backgroundColor: tone.accent }]} />
        <Image
          accessible={false}
          resizeMode="contain"
          source={MASCOT_SOURCES[props.pose]}
          style={[
            imageSize,
            { tintColor: props.dark ? color.onDark : color.graphite },
          ]}
        />
      </View>
    </View>
  );
}

/** A centered mascot vignette for loading, outcome, and recovery states. */
export function MascotStage(props: MascotSharedProps & { compact?: boolean }) {
  const tone = TONES[props.tone ?? 'volt'];
  return (
    <View
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[
        styles.stage,
        props.compact && styles.stageCompact,
        {
          backgroundColor: props.dark ? color.inkElevated : tone.soft,
          borderColor: props.dark ? color.lineDark : tone.accent,
        },
        props.style,
      ]}
    >
      <View style={[styles.stageBall, { backgroundColor: tone.accent }]} />
      <View
        style={[
          styles.stageRing,
          { borderColor: props.dark ? color.lineStrongDark : tone.accent },
        ]}
      />
      <Image
        accessible={false}
        resizeMode="contain"
        source={MASCOT_SOURCES[props.pose]}
        style={[
          styles.stageImage,
          props.compact && styles.stageImageCompact,
          { tintColor: props.dark ? color.onDark : color.graphite },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  moment: {
    minHeight: 132,
    flexDirection: 'row',
    alignItems: 'stretch',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  momentCompact: { minHeight: 104 },
  momentLight: {
    backgroundColor: color.surfaceElevated,
    borderColor: color.line,
  },
  momentDark: {
    backgroundColor: color.inkElevated,
    borderColor: color.lineDark,
  },
  momentCopy: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'center',
    paddingHorizontal: space.md,
    paddingVertical: space.md,
  },
  momentCaption: { marginTop: space.xs },
  momentArt: {
    width: 142,
    alignItems: 'center',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  momentArtCompact: { width: 112 },
  momentImage: { width: 142, height: 124 },
  momentImageCompact: { width: 112, height: 98 },
  accentBall: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderRadius: 30,
    top: -16,
    right: -14,
    opacity: 0.9,
  },
  stage: {
    width: 194,
    height: 154,
    alignItems: 'center',
    justifyContent: 'flex-end',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
    overflow: 'hidden',
  },
  stageCompact: { width: 148, height: 116, borderRadius: radius.lg },
  stageBall: {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: 36,
    top: -18,
    right: -14,
    opacity: 0.92,
  },
  stageRing: {
    position: 'absolute',
    width: 116,
    height: 116,
    borderRadius: 58,
    borderWidth: 1,
    left: -36,
    bottom: -44,
    opacity: 0.38,
  },
  stageImage: { width: 176, height: 144 },
  stageImageCompact: { width: 132, height: 108 },
});
