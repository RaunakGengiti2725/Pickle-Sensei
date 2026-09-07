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
import { Icon, type IconName } from './icons';
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

interface MascotSharedProps {
  pose: MascotPose;
  dark?: boolean;
  tone?: MascotTone;
  illustrated?: boolean;
  accessibilityLabel?: string;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

/** A text-first editorial note; approved artwork requires explicit placement. */
export function MascotMoment(
  props: MascotSharedProps & {
    eyebrow: string;
    caption: string;
    compact?: boolean;
  },
) {
  const illustrated = props.illustrated === true;
  return (
    <View
      accessible={illustrated && Boolean(props.accessibilityLabel)}
      accessibilityRole={illustrated ? 'image' : undefined}
      accessibilityLabel={illustrated ? props.accessibilityLabel : undefined}
      testID={props.testID}
      style={[
        styles.moment,
        props.compact && styles.momentCompact,
        { borderColor: props.dark ? color.lineDark : color.line },
        props.style,
      ]}
    >
      <View style={styles.momentCopy}>
        <Text
          style={[type.micro, { color: props.dark ? color.onDark : color.ink }]}
        >
          {props.eyebrow}
        </Text>
        <Text
          style={[
            type.caption,
            styles.momentCaption,
            { color: props.dark ? color.onDarkMuted : color.inkSoft },
          ]}
        >
          {props.caption}
        </Text>
      </View>
      {illustrated ? (
        <Image
          accessible={false}
          resizeMode="contain"
          source={MASCOT_SOURCES[props.pose]}
          style={[
            styles.momentImage,
            props.compact && styles.momentImageCompact,
            { tintColor: props.dark ? color.onDark : color.graphite },
          ]}
        />
      ) : null}
    </View>
  );
}

/** A compact state mark, with approved illustration available only by opt-in. */
export function MascotStage(
  props: MascotSharedProps & { compact?: boolean; icon?: IconName },
) {
  const illustrated = props.illustrated === true;
  const accent =
    props.tone === 'danger'
      ? props.dark
        ? color.flame
        : color.bad
      : props.tone === 'warn'
        ? props.dark
          ? color.volt
          : color.warn
        : props.dark
          ? color.volt
          : color.court;
  return (
    <View
      accessible={Boolean(props.accessibilityLabel)}
      accessibilityRole={props.accessibilityLabel ? 'image' : undefined}
      accessibilityLabel={props.accessibilityLabel}
      testID={props.testID}
      style={[
        styles.stage,
        props.compact && styles.stageCompact,
        illustrated && styles.stageIllustrated,
        { backgroundColor: props.dark ? color.inkElevated : color.surfaceAlt },
        props.style,
      ]}
    >
      {illustrated ? (
        <Image
          accessible={false}
          resizeMode="contain"
          source={MASCOT_SOURCES[props.pose]}
          style={[
            styles.stageImage,
            { tintColor: props.dark ? color.onDark : color.graphite },
          ]}
        />
      ) : (
        <Icon
          name={props.icon ?? (props.tone === 'danger' ? 'close' : 'stroke')}
          size={props.compact ? 28 : 36}
          color={accent}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  moment: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: space.md,
    gap: space.md,
  },
  momentCompact: { paddingVertical: space.sm },
  momentCopy: { flex: 1, minWidth: 0 },
  momentCaption: { marginTop: space.xs },
  momentImage: { width: 96, height: 104 },
  momentImageCompact: { width: 72, height: 80 },
  stage: {
    width: 64,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  stageCompact: { width: 48, height: 48, borderRadius: radius.sm },
  stageIllustrated: { width: 132, height: 108 },
  stageImage: { width: 120, height: 104 },
});
